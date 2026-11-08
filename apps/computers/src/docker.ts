import Docker from "dockerode";
import type { ComputerServiceConfig } from "@kovobot/config";
import { COMPUTER_SIZES, type ComputerSize } from "@kovobot/plans";
import { AGENT_PORT, type BackendComputer, type ComputerBackend, type ComputerState } from "./backend.ts";

const AGENT_PORT_KEY = `${AGENT_PORT}/tcp`;
const GIB = 1024 ** 3;

/** A size's CPUs and memory as Docker limits them; no swap, so memory is what the size says. */
function limits(size: ComputerSize) {
  const spec = COMPUTER_SIZES.find((candidate) => candidate.size === size)!;
  return { NanoCpus: spec.vcpus * 1e9, Memory: spec.memoryGb * GIB, MemorySwap: spec.memoryGb * GIB };
}

/** The size whose limits a container has; Docker is the record. */
function sizeOf(hostConfig: Docker.HostConfig): ComputerSize {
  const match = COMPUTER_SIZES.find((spec) => spec.vcpus * 1e9 === hostConfig.NanoCpus && spec.memoryGb * GIB === hostConfig.Memory);
  return match?.size ?? "small";
}

/**
 * Computers as local Docker containers, one each, with a volume for the home directory.
 * Docker is the only record: labels name each Computer and its owner.
 */
export function createDockerBackend(settings: ComputerServiceConfig["docker"]): ComputerBackend {
  const docker = new Docker(connection(settings.host));
  const container = (id: string) => docker.getContainer(containerName(id));

  async function find(id: string): Promise<BackendComputer | null> {
    const info = await container(id).inspect().catch(notFoundAs(null));
    if (!info) return null;
    const agentToken = info.Config.Env.find((entry) => entry.startsWith("KOVOBOT_AGENT_TOKEN="))?.split("=")[1] ?? "";
    return {
      id,
      owner: info.Config.Labels["kovobot.owner"] ?? "",
      state: stateOf(info.State),
      size: sizeOf(info.HostConfig),
      agentToken,
    };
  }

  return {
    async create({ id, owner, agentToken, size }) {
      const created = await docker.createContainer({
        name: containerName(id),
        Image: settings.image,
        Env: [`KOVOBOT_AGENT_TOKEN=${agentToken}`],
        Labels: { "kovobot.computer": id, "kovobot.owner": owner },
        ExposedPorts: { [AGENT_PORT_KEY]: {} },
        HostConfig: {
          Mounts: [{ Type: "volume", Source: containerName(id), Target: "/home/kovobot" }],
          // Inside a shared network the Computer service reaches the agent by name;
          // otherwise only this machine can reach it, on a port Docker picks.
          ...(settings.network
            ? { NetworkMode: settings.network }
            : { PortBindings: { [AGENT_PORT_KEY]: [{ HostIp: "127.0.0.1", HostPort: "" }] } }),
          ...limits(size),
          ShmSize: GIB / 2,
          SecurityOpt: ["no-new-privileges"],
          // For the Computer's own firewall, which its start-up sets as root before the desktop runs.
          CapAdd: ["NET_ADMIN"],
        },
      });
      await created.start();
      return (await find(id))!;
    },

    find,

    async start(id) {
      const info = await container(id).inspect();
      if (info.State.Paused) await container(id).unpause();
      else await container(id).start().catch(ignoreStatus(304));
    },

    async sleep(id) {
      const info = await container(id).inspect();
      if (info.State.Running && !info.State.Paused) await container(id).pause();
    },

    async shutDown(id) {
      const info = await container(id).inspect();
      if (info.State.Paused) await container(id).unpause();
      await container(id).stop({ t: 10 }).catch(ignoreStatus(304));
    },

    async remove(id) {
      await container(id).remove({ force: true }).catch(ignoreStatus(404));
      await docker.getVolume(containerName(id)).remove().catch(ignoreStatus(404));
    },

    async resize(id, size) {
      await container(id).update(limits(size));
    },

    async capacity() {
      const info = await docker.info();
      return { vcpus: info.NCPU, memoryGb: info.MemTotal / GIB };
    },

    async agentAddress(id) {
      const info = await container(id).inspect().catch(notFoundAs(null));
      if (!info || stateOf(info.State) !== "running") return null;
      if (settings.network) return { host: containerName(id), port: AGENT_PORT };
      const published = info.NetworkSettings.Ports[AGENT_PORT_KEY]?.[0];
      return published ? { host: "127.0.0.1", port: Number(published.HostPort) } : null;
    },
  };
}

function containerName(id: string): string {
  return `kovobot-computer-${id}`;
}

function stateOf(state: Docker.ContainerInspectInfo["State"]): ComputerState {
  if (state.Paused) return "asleep";
  return state.Running || state.Restarting ? "running" : "shut_down";
}

/** Docker's address from DOCKER_HOST (unix://, npipe:// or tcp://), or the local default. */
function connection(host: string | null): Docker.DockerOptions {
  if (!host) return { socketPath: process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock" };
  const url = new URL(host);
  if (url.protocol === "unix:") return { socketPath: url.pathname };
  // npipe:////./pipe/docker_engine names the pipe //./pipe/docker_engine.
  if (url.protocol === "npipe:") return { socketPath: host.slice("npipe://".length) };
  if (url.protocol === "tcp:") return { host: url.hostname, port: Number(url.port || 2375), protocol: "http" };
  throw new Error(`DOCKER_HOST must start with unix://, npipe:// or tcp://, not "${host}".`);
}

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

/** Docker answers 304 to starting a running container or stopping a stopped one, and 404 for one that's gone. */
function ignoreStatus(status: number) {
  return (error: unknown) => {
    if (statusOf(error) !== status) throw error;
  };
}

function notFoundAs<T>(value: T) {
  return (error: unknown): T => {
    if (statusOf(error) !== 404) throw error;
    return value;
  };
}
