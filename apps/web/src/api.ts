// The API lives on the same origin under /api, so the session cookie is first-party.

export interface Customer {
  id: string;
  email: string;
}

export interface Bot {
  id: string;
  name: string;
  model: string;
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  /** False when no key for its Model provider is set up here. */
  available: boolean;
}

/** The models a Bot can use here: listed ones, plus any OpenRouter or local model where those are set up. */
export interface ModelCatalog {
  models: ModelInfo[];
  openrouter: boolean;
  local: boolean;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

/** A Bot's Computer. Shut down keeps its disk; Asleep keeps its memory too. */
export interface Computer {
  state: "running" | "asleep" | "shut_down";
  size: string;
}

/** A Computer size this install can give: its CPUs and memory. */
export interface ComputerSize {
  size: string;
  name: string;
  vcpus: number;
  memoryGb: number;
}

/** An error answer from the API: its machine-readable code and a sentence to show. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function send(path: string, init: { method?: Method; json?: unknown } = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: init.method ?? "GET",
      headers: init.json === undefined ? {} : { "content-type": "application/json" },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
  } catch {
    throw new ApiError(0, "offline", "Can't reach Kovobot. Check your connection and try again.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? "unknown",
      body?.error?.message ?? "Something went wrong. Try again.",
    );
  }
  return response;
}

async function request<T>(path: string, init: { method?: Method; json?: unknown } = {}): Promise<T> {
  const response = await send(path, init);
  return (response.headers.get("content-type")?.includes("application/json") ? await response.json() : undefined) as T;
}

/** The sentence to show for anything thrown by an API call. */
export function errorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "Something went wrong. Try again.";
}

export const api = {
  signInOptions: () => request<{ google: boolean; signUpOpen: boolean }>("/auth/options"),
  sendSignInLink: (email: string) => request<unknown>("/auth/email-link", { method: "POST", json: { email } }),
  confirmSignInLink: (token: string) =>
    request<{ customer: Customer }>("/auth/email-link/confirm", { method: "POST", json: { token } }),
  me: () => request<{ customer: Customer }>("/me"),
  signOut: () => request<unknown>("/auth/sign-out", { method: "POST" }),

  models: () => request<ModelCatalog>("/models"),
  bots: () => request<{ bots: Bot[] }>("/bots"),
  createBot: (name: string, model: string) => request<{ bot: Bot }>("/bots", { method: "POST", json: { name, model } }),
  renameBot: (id: string, name: string) => request<{ bot: Bot }>(`/bots/${id}`, { method: "PATCH", json: { name } }),
  switchModel: (id: string, model: string) => request<{ bot: Bot }>(`/bots/${id}`, { method: "PATCH", json: { model } }),
  deleteBot: (id: string) => request<unknown>(`/bots/${id}`, { method: "DELETE" }),
  messages: (botId: string) => request<{ messages: Message[] }>(`/bots/${botId}/messages`),

  computer: (botId: string) => request<{ computer: Computer | null }>(`/bots/${botId}/computer`),
  computerSizes: () => request<{ sizes: ComputerSize[] }>("/computer-sizes"),
  createComputer: (botId: string, size: string) =>
    request<{ computer: Computer }>(`/bots/${botId}/computer`, { method: "POST", json: { size } }),
  resizeComputer: (botId: string, size: string) =>
    request<{ computer: Computer }>(`/bots/${botId}/computer`, { method: "PATCH", json: { size } }),
  startComputer: (botId: string) => request<{ computer: Computer }>(`/bots/${botId}/computer/start`, { method: "POST" }),
  shutDownComputer: (botId: string) =>
    request<{ computer: Computer }>(`/bots/${botId}/computer/shut-down`, { method: "POST" }),
  deleteComputer: (botId: string) => request<unknown>(`/bots/${botId}/computer`, { method: "DELETE" }),
  /** A link to the Computer's live view, to open as a WebSocket within a minute. */
  liveView: (botId: string) => request<{ url: string; expiresAt: string }>(`/bots/${botId}/computer/live-view`, { method: "POST" }),

  /**
   * Sends a message on the web Channel and streams the Bot's reply: `onText`
   * gets each piece as the model writes it. Resolves with the saved reply.
   */
  async sendMessage(botId: string, content: string, onText: (text: string) => void): Promise<Message> {
    const response = await send(`/bots/${botId}/messages`, { method: "POST", json: { content } });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value.replaceAll("\r\n", "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const event = parseServerSentEvent(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event.name === "delta") onText((event.data as { text: string }).text);
        if (event.name === "done") return (event.data as { message: Message }).message;
        if (event.name === "error") {
          const error = event.data as { code: string; message: string };
          throw new ApiError(200, error.code, error.message);
        }
      }
    }
    throw new ApiError(0, "interrupted", "The reply was cut off. Reload the page to see whether it finished.");
  },
};

function parseServerSentEvent(block: string): { name: string; data: unknown } {
  let name = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { name, data: data.length > 0 ? JSON.parse(data.join("\n")) : null };
}

/** Where "Sign in with Google" starts: a full-page visit, since Google takes over the page. */
export const GOOGLE_SIGN_IN_URL = "/api/auth/google";
