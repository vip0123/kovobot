import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

type State = "running" | "asleep" | "shut_down";

interface FakeComputer {
  id: string;
  owner: string;
  state: State;
  size: string;
}

/** The sizes this stand-in machine can give: Small and Medium; Large and XL don't fit. */
const SIZES_HERE = [
  { size: "small", name: "Small", vcpus: 2, memoryGb: 4 },
  { size: "medium", name: "Medium", vcpus: 2, memoryGb: 8 },
];
const ALL_SIZES = ["small", "medium", "large", "xl"];
/** A 1x1 PNG: every screenshot the fake takes. */
export const SCREENSHOT_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";

/**
 * A local stand-in for the Computer service: a real HTTP server on 127.0.0.1 that the
 * Bot service's client talks to. Computers live in memory. Its live view greets as a
 * VNC server does and echoes what it gets, and only opens with a token it issued.
 */
export class FakeComputerService {
  readonly apiKey = "fake-computer-service-key-0123456789";
  baseUrl = "";
  readonly computers = new Map<string, FakeComputer>();
  /** Every live-view token issued, and the Computer each one is for. */
  readonly liveViewTokens = new Map<string, string>();
  /** Every action carried out, and screenshots taken, in order. */
  readonly actions: Array<{ computerId: string; action: Record<string, unknown> }> = [];
  private server: Server | undefined;
  private readonly webSockets = new WebSocketServer({ noServer: true });

  /** While true, every request answers a plain 404, as a wrong address or a proxy in the way would. */
  misrouted = false;

  /** The Computer service loses this Computer, as if it had been deleted behind the Bot service's back. */
  forget(id: string): void {
    this.computers.delete(id);
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://fake");
      const id = /^\/v1\/computers\/([^/]+)\/live$/.exec(url.pathname)?.[1];
      const token = url.searchParams.get("token") ?? "";
      const ok = request.headers.authorization === `Bearer ${this.apiKey}` && id && this.liveViewTokens.get(token) === id;
      if (!ok) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.send(Buffer.from("RFB 003.008\n"));
        webSocket.on("message", (data) => webSocket.send(data as Buffer));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    const send = (status: number, json?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(json === undefined ? undefined : JSON.stringify(json));
    };
    if (this.misrouted) return send(404, { error: { code: "not_found", message: "There is no such route." } });
    if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
      return send(401, { error: { code: "unauthorized", message: "Present the Computer service's key." } });
    }

    const path = request.url ?? "";
    const sizeRefusal = (size: unknown) =>
      !ALL_SIZES.includes(String(size))
        ? { error: { code: "invalid_size", message: "Pick a size." } }
        : !SIZES_HERE.some((here) => here.size === size)
          ? { error: { code: "size_unavailable", message: "This machine can't give a Computer that much." } }
          : null;
    if (request.method === "GET" && path === "/v1/sizes") return send(200, { sizes: SIZES_HERE });
    if (request.method === "POST" && path === "/v1/computers") {
      const size = body.size ?? "small";
      const refusal = sizeRefusal(size);
      if (refusal) return send(400, refusal);
      const computer: FakeComputer = { id: randomUUID(), owner: String(body.owner), state: "running", size: String(size) };
      this.computers.set(computer.id, computer);
      return send(201, { computer });
    }
    const [, id, action] = /^\/v1\/computers\/([^/]+)(?:\/([\w-]+))?$/.exec(path) ?? [];
    const computer = id ? this.computers.get(id) : undefined;
    if (!computer) return send(404, { error: { code: "computer_not_found", message: "There is no such Computer." } });

    if (request.method === "GET" && !action) return send(200, { computer });
    if (request.method === "PATCH" && !action) {
      const refusal = sizeRefusal(body.size);
      if (refusal) return send(400, refusal);
      computer.size = String(body.size);
      return send(200, { computer });
    }
    if (request.method === "DELETE" && !action) {
      this.computers.delete(computer.id);
      return send(204);
    }
    if (request.method === "POST" && action === "start") {
      computer.state = "running";
      return send(200, { computer });
    }
    if (request.method === "POST" && action === "sleep") {
      if (computer.state === "running") computer.state = "asleep";
      return send(200, { computer });
    }
    if (request.method === "POST" && action === "shut-down") {
      computer.state = "shut_down";
      return send(200, { computer });
    }
    if (request.method === "POST" && action === "actions") {
      if (computer.state !== "running") return send(409, { error: { code: "computer_not_running", message: "Start the Computer first." } });
      this.actions.push({ computerId: computer.id, action: body });
      return send(200, body.type === "cursor_position" ? { cursor: { x: 1, y: 2 } } : {});
    }
    if (request.method === "GET" && action === "screenshot") {
      if (computer.state !== "running") return send(409, { error: { code: "computer_not_running", message: "Start the Computer first." } });
      this.actions.push({ computerId: computer.id, action: { type: "screenshot" } });
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from(SCREENSHOT_PNG, "base64"));
      return;
    }
    if (request.method === "POST" && action === "live-view") {
      if (computer.state !== "running") {
        return send(409, { error: { code: "computer_not_running", message: "Start the Computer to watch it." } });
      }
      const token = `token-${randomUUID()}`;
      this.liveViewTokens.set(token, computer.id);
      return send(200, { token, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    send(404, { error: { code: "not_found", message: "There is no such route." } });
  }
}
