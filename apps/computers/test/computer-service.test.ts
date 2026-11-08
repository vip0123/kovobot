import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { loadComputerServiceConfig } from "@kovobot/config";
import { createComputerService } from "../src/app.ts";
import { createDockerBackend } from "../src/docker.ts";

// The real Computer agent, in a small image whose VNC server is a stand-in: it greets
// like a VNC server and echoes what it gets. The real desktop image is checked by hand.
const STAND_IN_IMAGE = "kovobot-computer-stand-in";
const KEY = "computer-service-test-key-0123456789";

let baseUrl = "";
let server: ServerType;
const clock = { now: new Date("2026-11-08T12:00:00Z") };
const created: string[] = [];

beforeAll(async () => {
  await promisify(execFile)(
    "docker",
    ["build", "-q", "-t", STAND_IN_IMAGE, "-f", "test/stand-in-computer/Dockerfile", "."],
    { cwd: new URL("..", import.meta.url) },
  );
  const config = loadComputerServiceConfig({ COMPUTER_SERVICE_API_KEY: KEY, COMPUTER_IMAGE: STAND_IN_IMAGE });
  const service = createComputerService({ config, backend: createDockerBackend(config.docker), now: () => clock.now });
  server = serve({ fetch: service.app.fetch, port: 0, hostname: "127.0.0.1" });
  server.on("upgrade", service.upgrade);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 300_000);

afterAll(async () => {
  await Promise.all(created.map((id) => call(`/v1/computers/${id}`, { method: "DELETE" })));
  await new Promise((resolve) => server.close(resolve));
}, 60_000);

function call(path: string, init: { method?: string; json?: unknown; key?: string | null } = {}) {
  const key = init.key === undefined ? KEY : init.key;
  return fetch(baseUrl + path, {
    method: init.method ?? "GET",
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
}

interface Computer {
  id: string;
  owner: string;
  state: string;
  size: string;
}

async function createComputer(owner = "bot-test", size?: string): Promise<Computer> {
  const response = await call("/v1/computers", { method: "POST", json: { owner, size } });
  expect(response.status).toBe(201);
  const { computer } = (await response.json()) as { computer: Computer };
  created.push(computer.id);
  return computer;
}

async function liveViewToken(computer: Computer): Promise<string> {
  const response = await call(`/v1/computers/${computer.id}/live-view`, { method: "POST" });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

/** Opens the live view; resolves with its first message, or rejects with the refusal's HTTP status. */
function openLiveView(computerId: string, token: string, key: string | null = KEY): Promise<{ socket: WebSocket; first: string }> {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl.replace("http", "ws")}/v1/computers/${computerId}/live?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url, { headers: key ? { authorization: `Bearer ${key}` } : {} });
    socket.once("unexpected-response", (_request, response) => reject(new Error(`refused ${response.statusCode}`)));
    socket.once("error", reject);
    socket.once("message", (data) => resolve({ socket, first: String(data) }));
  });
}

describe("the Computer service", { timeout: 60_000 }, () => {
  test("every call needs the Bot service's key", async () => {
    expect((await call("/healthz", { key: null })).status).toBe(200);
    for (const key of [null, "someone-elses-key-0123456789abcdefgh"]) {
      const response = await call("/v1/computers", { method: "POST", json: { owner: "bot-test" }, key });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  });

  test("a Computer is created running, can be shut down and started again, and is deleted", async () => {
    const computer = await createComputer("bot-lifecycle");
    expect(computer).toMatchObject({ owner: "bot-lifecycle", state: "running" });

    const shutDown = await call(`/v1/computers/${computer.id}/shut-down`, { method: "POST" });
    expect(await shutDown.json()).toMatchObject({ computer: { id: computer.id, state: "shut_down" } });
    expect(await (await call(`/v1/computers/${computer.id}`)).json()).toMatchObject({ computer: { state: "shut_down" } });

    const started = await call(`/v1/computers/${computer.id}/start`, { method: "POST" });
    expect(await started.json()).toMatchObject({ computer: { state: "running" } });

    expect((await call(`/v1/computers/${computer.id}`, { method: "DELETE" })).status).toBe(204);
    const gone = await call(`/v1/computers/${computer.id}`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: "computer_not_found" } });
  });

  test("a Computer that is Asleep starts again", async () => {
    const computer = await createComputer();
    await promisify(execFile)("docker", ["pause", `kovobot-computer-${computer.id}`]);
    expect(await (await call(`/v1/computers/${computer.id}`)).json()).toMatchObject({ computer: { state: "asleep" } });

    const started = await call(`/v1/computers/${computer.id}/start`, { method: "POST" });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ computer: { state: "running" } });
  });

  test("a Computer is Small unless asked for a size this machine can give, and can be resized while it runs", async () => {
    const sizes = ((await (await call("/v1/sizes")).json()) as { sizes: Array<{ size: string; vcpus: number; memoryGb: number }> }).sizes;
    expect(sizes.map((size) => size.size)).toContain("small");
    expect(sizes).toContainEqual({ size: "small", name: "Small", vcpus: 2, memoryGb: 4 });

    expect(await createComputer()).toMatchObject({ size: "small" });
    const listed = sizes.at(-1)!.size;
    const computer = await createComputer("bot-sized", listed);
    expect(computer).toMatchObject({ size: listed, state: "running" });

    const resized = await call(`/v1/computers/${computer.id}`, { method: "PATCH", json: { size: "small" } });
    expect(await resized.json()).toMatchObject({ computer: { size: "small", state: "running" } });
    expect(await (await call(`/v1/computers/${computer.id}`)).json()).toMatchObject({ computer: { size: "small" } });
  });

  test("a size that doesn't exist, or that this machine can't give, is refused", async () => {
    const unknown = await call("/v1/computers", { method: "POST", json: { owner: "bot-test", size: "huge" } });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "invalid_size" } });

    const listed = ((await (await call("/v1/sizes")).json()) as { sizes: Array<{ size: string }> }).sizes.map((s) => s.size);
    const tooBig = ["small", "medium", "large", "xl"].find((size) => !listed.includes(size));
    if (tooBig) {
      const refused = await call("/v1/computers", { method: "POST", json: { owner: "bot-test", size: tooBig } });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: { code: "size_unavailable" } });
    }
  });

  test("a Computer needs an owner", async () => {
    const response = await call("/v1/computers", { method: "POST", json: {} });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_owner" } });
  });

  test("the live view streams the Computer's screen, both ways, over a WebSocket", async () => {
    const computer = await createComputer();

    const { socket, first } = await openLiveView(computer.id, await liveViewToken(computer));
    expect(first).toBe("RFB 003.008\n");
    const echoed = new Promise((resolve) => socket.once("message", (data) => resolve(String(data))));
    socket.send(Buffer.from("a click"));
    expect(await echoed).toBe("a click");
    socket.close();
  });

  test("a live-view link opens only its own Computer, only for a minute, and only with the Bot service's key", async () => {
    const [mine, other] = await Promise.all([createComputer(), createComputer()]);
    const token = await liveViewToken(mine);

    await expect(openLiveView(other.id, token)).rejects.toThrow("refused 403");
    await expect(openLiveView(mine.id, token, null)).rejects.toThrow("refused 401");
    await expect(openLiveView(mine.id, "made-up")).rejects.toThrow("refused 403");

    clock.now = new Date(clock.now.getTime() + 61_000);
    await expect(openLiveView(mine.id, token)).rejects.toThrow("refused 403");
  });
});
