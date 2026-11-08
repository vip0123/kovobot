import WebSocket, { type RawData } from "ws";
import type { ComputerServiceSettings } from "@kovobot/config";

export type ComputerState = "running" | "asleep" | "shut_down";

export interface ComputerView {
  id: string;
  state: ComputerState;
}

/** A refusal from the Computer service, with its machine-readable code. */
export class ComputerServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ComputerServiceError";
    this.status = status;
    this.code = code;
  }
}

/** One open live view of a Computer, as the Computer service streams it. */
export interface LiveView {
  /** Starts delivering the Computer's messages, beginning with any that arrived before it was called. */
  onMessage(handle: (data: RawData, isBinary: boolean) => void): void;
  send(data: RawData, isBinary: boolean): void;
  onClose(handle: () => void): void;
  close(): void;
}

/** The Computer service, as its one client, the Bot service, sees it (ADR 0001). */
export interface ComputerService {
  /** Creates a Computer for `owner` and starts it. */
  create(owner: string): Promise<ComputerView>;
  /** Null when the Computer service has no such Computer. */
  find(id: string): Promise<ComputerView | null>;
  start(id: string): Promise<ComputerView>;
  shutDown(id: string): Promise<ComputerView>;
  /** Deletes the Computer and its disk; one that's already gone counts as deleted. */
  remove(id: string): Promise<void>;
  /** A short-lived token that opens this Computer's live view. */
  liveViewToken(id: string): Promise<{ token: string; expiresAt: string }>;
  openLiveView(id: string, token: string): Promise<LiveView>;
}

const NOT_FOUND = () => new ComputerServiceError(404, "computer_not_found", "There is no such Computer.");

export function createComputerServiceClient(settings: ComputerServiceSettings): ComputerService {
  const authorization = `Bearer ${settings.apiKey}`;

  /** The answer's JSON; null for a Computer the service doesn't have. Any other refusal throws. */
  async function call<T>(method: string, path: string, json?: unknown): Promise<T | null> {
    const response = await fetch(`${settings.url}/v1${path}`, {
      method,
      headers: { authorization, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    if (response.status === 404) return null;
    if (response.status === 204) return {} as T;
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (!response.ok) {
      throw new ComputerServiceError(response.status, body.error?.code ?? "unknown", body.error?.message ?? "The Computer service refused.");
    }
    return body as T;
  }

  async function computer(method: string, path: string, json?: unknown): Promise<ComputerView> {
    const answer = await call<{ computer: ComputerView }>(method, path, json);
    if (!answer) throw NOT_FOUND();
    return answer.computer;
  }

  return {
    create: (owner) => computer("POST", "/computers", { owner }),
    find: async (id) => (await call<{ computer: ComputerView }>("GET", `/computers/${id}`))?.computer ?? null,
    start: (id) => computer("POST", `/computers/${id}/start`),
    shutDown: (id) => computer("POST", `/computers/${id}/shut-down`),
    async remove(id) {
      await call("DELETE", `/computers/${id}`);
    },
    async liveViewToken(id) {
      const answer = await call<{ token: string; expiresAt: string }>("POST", `/computers/${id}/live-view`);
      if (!answer) throw NOT_FOUND();
      return answer;
    },
    openLiveView(id, token) {
      const url = `${settings.url.replace(/^http/, "ws")}/v1/computers/${id}/live?token=${encodeURIComponent(token)}`;
      const socket = new WebSocket(url, { headers: { authorization } });
      // The Computer's first message can arrive with the handshake, so it waits here until someone listens.
      const early: Array<[RawData, boolean]> = [];
      const keep = (data: RawData, isBinary: boolean) => void early.push([data, isBinary]);
      socket.on("message", keep);
      return new Promise((resolve, reject) => {
        socket.once("unexpected-response", (_request, response) => {
          response.resume();
          reject(new ComputerServiceError(response.statusCode ?? 502, "live_view_refused", "The Computer service refused the live view."));
        });
        socket.once("error", reject);
        socket.once("open", () =>
          resolve({
            onMessage(handle) {
              socket.off("message", keep);
              for (const [data, isBinary] of early.splice(0)) handle(data, isBinary);
              socket.on("message", handle);
            },
            send: (data, isBinary) => socket.send(data, { binary: isBinary }),
            onClose: (handle) => void socket.on("close", handle),
            close: () => socket.close(),
          }),
        );
      });
    },
  };
}
