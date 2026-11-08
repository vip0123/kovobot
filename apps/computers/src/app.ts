import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, request as httpRequest, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { type Context, Hono } from "hono";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import type { ComputerServiceConfig } from "@kovobot/config";
import { COMPUTER_SIZES, type ComputerSize, type ComputerSizeSpec } from "@kovobot/plans";
import type { BackendComputer, ComputerBackend } from "./backend.ts";

export interface ComputerServiceDeps {
  config: ComputerServiceConfig;
  backend: ComputerBackend;
  now: () => Date;
}

/** How long a live-view link can be opened for. An open live view stays open. */
const LIVE_VIEW_SECONDS = 60;
/** How long opening a live view waits for a just-started Computer agent to answer. */
const AGENT_WAIT_MS = 15_000;
const MAX_OWNER_LENGTH = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 503;

/**
 * The Computer service's API (ADR 0001). Its only client is the Bot service, which
 * presents COMPUTER_SERVICE_API_KEY on every call. `app` answers HTTP; `upgrade`
 * takes the live view's WebSocket and relays it to the Computer agent.
 */
export function createComputerService(deps: ComputerServiceDeps) {
  const { backend, config } = deps;
  const expectedKey = digest(config.apiKey);
  const authorised = (header: string | undefined) =>
    timingSafeEqual(digest(header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""), expectedKey);

  const app = new Hono();
  app.get("/healthz", (c) => c.text("ok"));
  app.use("/v1/*", async (c, next) => {
    if (!authorised(c.req.header("authorization"))) return apiError(c, 401, "unauthorized", "Present the Computer service's key.");
    await next();
  });

  /** The sizes this machine can give one Computer. */
  async function sizesHere(): Promise<ComputerSizeSpec[]> {
    const capacity = await backend.capacity();
    return COMPUTER_SIZES.filter((size) => size.vcpus <= capacity.vcpus && size.memoryGb <= capacity.memoryGb);
  }

  /** The size asked for, if it exists and fits here; otherwise the refusal to send. */
  async function chooseSize(c: Context, raw: unknown): Promise<ComputerSize | Response> {
    const spec = COMPUTER_SIZES.find((size) => size.size === raw);
    if (!spec) return apiError(c, 400, "invalid_size", `Pick a size: ${COMPUTER_SIZES.map((size) => size.size).join(", ")}.`);
    if (!(await sizesHere()).includes(spec)) {
      return apiError(c, 400, "size_unavailable", `This machine can't give a Computer ${spec.vcpus} CPUs and ${spec.memoryGb} GB.`);
    }
    return spec.size;
  }

  app.get("/v1/sizes", async (c) => c.json({ sizes: await sizesHere() }));

  app.post("/v1/computers", async (c) => {
    const body = await jsonObject(c);
    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
    if (!owner || owner.length > MAX_OWNER_LENGTH) {
      return apiError(c, 400, "invalid_owner", `Name the Computer's owner, in up to ${MAX_OWNER_LENGTH} characters.`);
    }
    const size = await chooseSize(c, body.size ?? "small");
    if (size instanceof Response) return size;
    const computer = await backend.create({ id: randomUUID(), owner, agentToken: randomBytes(32).toString("base64url"), size });
    return c.json({ computer: view(computer) }, 201);
  });

  const withComputer = (handle: (c: Context, computer: BackendComputer) => Promise<Response>) => async (c: Context) => {
    const id = c.req.param("id") ?? "";
    const computer = UUID_PATTERN.test(id) ? await backend.find(id) : null;
    return computer ? handle(c, computer) : apiError(c, 404, "computer_not_found", "There is no such Computer.");
  };

  app.get("/v1/computers/:id", withComputer(async (c, computer) => c.json({ computer: view(computer) })));

  app.post("/v1/computers/:id/start", withComputer(async (c, computer) => {
    await backend.start(computer.id);
    return c.json({ computer: view((await backend.find(computer.id))!) });
  }));

  app.post("/v1/computers/:id/sleep", withComputer(async (c, computer) => {
    await backend.sleep(computer.id);
    return c.json({ computer: view((await backend.find(computer.id))!) });
  }));

  app.post("/v1/computers/:id/shut-down", withComputer(async (c, computer) => {
    await backend.shutDown(computer.id);
    return c.json({ computer: view((await backend.find(computer.id))!) });
  }));

  app.patch("/v1/computers/:id", withComputer(async (c, computer) => {
    const size = await chooseSize(c, (await jsonObject(c)).size);
    if (size instanceof Response) return size;
    await backend.resize(computer.id, size);
    return c.json({ computer: view((await backend.find(computer.id))!) });
  }));

  app.delete("/v1/computers/:id", withComputer(async (c, computer) => {
    await backend.remove(computer.id);
    return c.body(null, 204);
  }));

  // A link the Bot service hands to the Customer's browser, good for one Computer and one minute.
  app.post("/v1/computers/:id/live-view", withComputer(async (c, computer) => {
    if (computer.state !== "running") return apiError(c, 409, "computer_not_running", "Start the Computer to watch it.");
    const expiresAt = new Date(deps.now().getTime() + LIVE_VIEW_SECONDS * 1000);
    return c.json({ token: liveViewToken(computer.id, expiresAt.getTime()), expiresAt });
  }));

  app.all("*", (c) => apiError(c, 404, "not_found", "There is no such route."));
  app.onError((error, c) => {
    console.error(error);
    return apiError(c, 503, "backend_unavailable", "Computers can't be reached right now. Try again in a moment.");
  });

  function liveViewToken(computerId: string, expiresAtMs: number): string {
    const signature = createHmac("sha256", config.tokenSigningKey).update(`${computerId}.${expiresAtMs}`).digest("base64url");
    return `${expiresAtMs}.${signature}`;
  }

  function liveViewTokenValid(token: string, computerId: string): boolean {
    const expiresAtMs = Number(token.split(".")[0]);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= deps.now().getTime()) return false;
    return timingSafeEqual(digest(token), digest(liveViewToken(computerId, expiresAtMs)));
  }

  const webSockets = new WebSocketServer({ noServer: true });

  /** GET /v1/computers/:id/live?token=…, upgraded to a WebSocket that carries the Computer's VNC stream. */
  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? "/", "http://computer-service");
    const id = /^\/v1\/computers\/([^/]+)\/live$/.exec(url.pathname)?.[1];
    if (!id) return refuse(socket, 404, "not_found", "There is no such route.");
    if (!authorised(request.headers.authorization)) return refuse(socket, 401, "unauthorized", "Present the Computer service's key.");
    if (!liveViewTokenValid(url.searchParams.get("token") ?? "", id)) {
      return refuse(socket, 403, "live_view_link_invalid", "This live-view link has expired or is for another Computer.");
    }
    try {
      const computer = UUID_PATTERN.test(id) ? await backend.find(id) : null;
      if (!computer) return refuse(socket, 404, "computer_not_found", "There is no such Computer.");
      const agent = await openAgentTunnel(computer);
      if (!agent) return refuse(socket, 503, "computer_unreachable", "The Computer isn't answering. Try again in a moment.");
      webSockets.handleUpgrade(request, socket, head, (webSocket) => relay(webSocket, agent.socket, agent.head));
    } catch (error) {
      console.error(error);
      refuse(socket, 503, "backend_unavailable", "Computers can't be reached right now. Try again in a moment.");
    }
  }

  /** A byte tunnel to the Computer agent's live view, waiting a little for an agent that is still starting. */
  async function openAgentTunnel(computer: BackendComputer): Promise<{ socket: Duplex; head: Buffer } | null> {
    const deadline = Date.now() + AGENT_WAIT_MS;
    while (Date.now() < deadline) {
      const address = await backend.agentAddress(computer.id);
      if (!address) return null;
      const tunnel = await new Promise<{ socket: Duplex; head: Buffer } | null>((resolve) => {
        const opening = httpRequest({
          host: address.host,
          port: address.port,
          path: "/live",
          headers: { connection: "Upgrade", upgrade: "vnc", authorization: `Bearer ${computer.agentToken}` },
        });
        opening.once("upgrade", (_response, agentSocket, agentHead) => resolve({ socket: agentSocket, head: agentHead }));
        opening.once("response", (response) => {
          response.resume();
          resolve(null);
        });
        opening.once("error", () => resolve(null));
        opening.end();
      });
      if (tunnel) return tunnel;
      await sleep(250);
    }
    return null;
  }

  return { app, upgrade };
}

/** What the Bot service sees of a Computer; never its agent's token. */
function view(computer: BackendComputer) {
  return { id: computer.id, owner: computer.owner, state: computer.state, size: computer.size };
}

/** The request's JSON object body, or {} when there is none. */
async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/** Carries the live view both ways: WebSocket messages to the agent's bytes, and back. */
function relay(webSocket: WebSocket, agent: Duplex, head: Buffer): void {
  if (head.length > 0) webSocket.send(head);
  agent.on("data", (chunk: Buffer) => webSocket.send(chunk));
  webSocket.on("message", (data: RawData) => agent.write(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)));
  agent.on("close", () => webSocket.close());
  agent.on("error", () => webSocket.terminate());
  webSocket.on("close", () => agent.destroy());
  webSocket.on("error", () => agent.destroy());
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function apiError(c: Context, status: ErrorStatus, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/** Refuses a WebSocket upgrade with an HTTP answer in the API's error shape. */
function refuse(socket: Duplex, status: ErrorStatus, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}
