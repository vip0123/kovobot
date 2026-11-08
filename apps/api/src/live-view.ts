import { type IncomingMessage, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { AppDeps } from "./app.ts";
import { handBack } from "./computer-routes.ts";
import { ComputerServiceError } from "./computers.ts";

const LIVE_VIEW_PATH = /^\/api\/bots\/[^/?]+\/computer\/live(?:\?|$)/;

interface App {
  fetch(request: Request): Response | Promise<Response>;
}

/**
 * Takes the browser's WebSocket for a Computer's live view (GET /api/bots/:id/computer/live)
 * and relays it to the Computer service. The app's own route decides first, with the same
 * session and ownership checks as every other route, so the Customer's cookie stays
 * first-party and the Computer service never faces a browser. While the view is open the
 * route is asked again every `recheckMs`: once the Customer signs out, or the Bot or its
 * Computer goes, the view closes.
 */
export function liveViewUpgrade(app: App, deps: AppDeps, options: { recheckMs?: number } = {}) {
  const recheckMs = options.recheckMs ?? 30_000;
  const webSockets = new WebSocketServer({ noServer: true });

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = request.url ?? "/";
    if (!LIVE_VIEW_PATH.test(path) || !deps.computers) return refuse(socket, 404, "There is no such API route.");

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const botId = /^\/api\/bots\/([^/?]+)\//.exec(path)?.[1] ?? "";
    const decide = () => app.fetch(new Request(new URL(path, deps.config.apiUrl), { headers }));
    const decision = await decide();
    if (decision.status !== 200) return refuse(socket, decision.status, await decision.text());
    const { computerId, token } = (await decision.json()) as { computerId: string; token: string };
    const stillAllowed = async () => {
      const again = await decide();
      return again.status === 200 && ((await again.json()) as { computerId: string }).computerId === computerId;
    };

    let computer;
    try {
      computer = await deps.computers.openLiveView(computerId, token);
    } catch (error) {
      const expired = error instanceof ComputerServiceError && error.status === 403;
      return refuse(
        socket,
        expired ? 403 : 503,
        JSON.stringify({
          error: expired
            ? { code: "live_view_link_invalid", message: "This live-view link has expired. Open the live view again." }
            : { code: "computer_unreachable", message: "The Computer isn't answering. Try again in a moment." },
        }),
      );
    }

    webSockets.handleUpgrade(request, socket, head, (browser) => {
      computer.onMessage((data, isBinary) => browser.send(data, { binary: isBinary }));
      browser.on("message", (data, isBinary) => computer.send(data, isBinary));
      const recheck = setInterval(() => {
        stillAllowed().then(
          (allowed) => allowed || browser.close(1008, "The live view ended."),
          () => browser.close(1011, "The live view ended."),
        );
      }, recheckMs);
      computer.onClose(() => browser.close());
      browser.on("close", () => {
        clearInterval(recheck);
        computer.close();
        // Whoever had control let go when the view closed: the Bot may carry on.
        void handBack(deps, botId).catch((error: unknown) => console.error(error));
      });
      browser.on("error", () => computer.close());
    });
  }

  return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrade(request, socket, head).catch((error: unknown) => {
      console.error(error);
      socket.destroy();
    });
  };
}

/** Answers a refused upgrade over the raw socket; `body` is the API's JSON error. */
function refuse(socket: Duplex, status: number, body: string): void {
  const json = body.startsWith("{") ? body : JSON.stringify({ error: { code: "not_found", message: body } });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`,
  );
}
