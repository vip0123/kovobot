// The API lives on the same origin under /api, so the session cookie is first-party.

export interface Customer {
  id: string;
  email: string;
}

export interface Bot {
  id: string;
  name: string;
  model: string;
  /** The model the Bot operates its Computer with: OpenAI, Anthropic or Google; null until picked. */
  driverModel: string | null;
  /** What the Customer tells the Bot about how to work for them; empty for none. */
  instructions: string;
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
  /** The Model providers whose models may search the web here. */
  webSearch?: string[];
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** What the model thought before this reply, as its Model provider showed it. */
  thinking?: string | null;
  /** The web pages this reply drew on. */
  sources?: WebSource[] | null;
  /** Google's search suggestions for a reply grounded with Google Search, as Google's HTML. */
  searchSuggestions?: string | null;
  /** Files sent with this message. */
  attachments?: Attachment[];
  createdAt: string;
}

export interface WebSource {
  url: string;
  title: string;
}

/** A file sent with a message. A file just sent, not yet saved, carries a local `preview` URL instead of an id. */
export interface Attachment {
  id?: string;
  name: string;
  mediaType: string;
  size: number;
  preview?: string;
}

/** A file to send with a message: its name and its contents, base64. */
export interface OutgoingFile {
  name: string;
  data: string;
}

/** What a message asks of the Bot besides its words. */
export interface MessageOptions {
  attachments?: OutgoingFile[];
  thinkHarder?: boolean;
  webSearch?: boolean;
}

/** What the Bot does while it replies, as it streams. */
export interface ReplyHandlers {
  /** The Customer's message as saved, with its Attachments' ids. */
  onSent?: (message: Message) => void;
  onText: (text: string) => void;
  onStatus?: (status: string) => void;
  onThinking?: (text: string) => void;
  onSources?: (sources: WebSource[], searchSuggestions?: string) => void;
}

/** Instructions a Customer writes once for one kind of work, and gives to their Bots. */
export interface Skill {
  id: string;
  name: string;
  /** When to use it: what a Bot reads to decide whether the Skill applies. */
  description: string;
  instructions: string;
  /** The Bots that have it. */
  botIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type SkillFields = Pick<Skill, "name" | "description" | "instructions">;

/** Something a Bot keeps in mind across Conversations. */
export interface Note {
  id: string;
  content: string;
  /** Who last wrote it. */
  writtenBy: "bot" | "customer";
  /** The Bot wrote it after reading web pages or using its Computer, so it's worth checking. */
  afterOutsideContent: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A Bot's Computer. Shut down keeps its disk; Asleep keeps its memory too. */
export interface Computer {
  state: "running" | "asleep" | "shut_down";
  size: string;
  /** It goes Asleep after this long with no viewer or Bot at work: 15 minutes to 4 hours. */
  sleepAfterMinutes: number;
  /** Whether the Customer has the mouse and keyboard; the Bot waits meanwhile. */
  customerInControl: boolean;
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

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

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
  setDriverModel: (id: string, driverModel: string | null) =>
    request<{ bot: Bot }>(`/bots/${id}`, { method: "PATCH", json: { driverModel } }),
  setInstructions: (id: string, instructions: string) =>
    request<{ bot: Bot }>(`/bots/${id}`, { method: "PATCH", json: { instructions } }),
  deleteBot: (id: string) => request<unknown>(`/bots/${id}`, { method: "DELETE" }),
  messages: (botId: string) => request<{ messages: Message[] }>(`/bots/${botId}/messages`),

  skills: () => request<{ skills: Skill[] }>("/skills"),
  createSkill: (fields: SkillFields) => request<{ skill: Skill }>("/skills", { method: "POST", json: fields }),
  /** A Skill from a SKILL.md file's text: its name and description from the front matter, the rest as instructions. */
  importSkill: (file: string) => request<{ skill: Skill }>("/skills", { method: "POST", json: { file } }),
  updateSkill: (id: string, change: Partial<SkillFields>) =>
    request<{ skill: Skill }>(`/skills/${id}`, { method: "PATCH", json: change }),
  deleteSkill: (id: string) => request<unknown>(`/skills/${id}`, { method: "DELETE" }),
  notes: (botId: string) => request<{ notes: Note[] }>(`/bots/${botId}/notes`),
  addNote: (botId: string, content: string) => request<{ note: Note }>(`/bots/${botId}/notes`, { method: "POST", json: { content } }),
  editNote: (botId: string, id: string, content: string) =>
    request<{ note: Note }>(`/bots/${botId}/notes/${id}`, { method: "PATCH", json: { content } }),
  deleteNote: (botId: string, id: string) => request<unknown>(`/bots/${botId}/notes/${id}`, { method: "DELETE" }),

  grantSkill: (botId: string, skillId: string) => request<unknown>(`/bots/${botId}/skills/${skillId}`, { method: "PUT" }),
  revokeSkill: (botId: string, skillId: string) => request<unknown>(`/bots/${botId}/skills/${skillId}`, { method: "DELETE" }),

  computer: (botId: string) => request<{ computer: Computer | null }>(`/bots/${botId}/computer`),
  computerSizes: () => request<{ sizes: ComputerSize[] }>("/computer-sizes"),
  createComputer: (botId: string, size: string) =>
    request<{ computer: Computer }>(`/bots/${botId}/computer`, { method: "POST", json: { size } }),
  resizeComputer: (botId: string, size: string) =>
    request<{ computer: Computer }>(`/bots/${botId}/computer`, { method: "PATCH", json: { size } }),
  /** The Customer takes the mouse and keyboard (true) or hands them back; the Bot waits meanwhile. */
  setComputerControl: (botId: string, inControl: boolean) =>
    request<{ computer: Computer }>(`/bots/${botId}/computer/control`, { method: "POST", json: { inControl } }),
  setComputerSleep: (botId: string, sleepAfterMinutes: number) =>
    request<{ computer: Computer }>(`/bots/${botId}/computer`, { method: "PATCH", json: { sleepAfterMinutes } }),
  startComputer: (botId: string) => request<{ computer: Computer }>(`/bots/${botId}/computer/start`, { method: "POST" }),
  shutDownComputer: (botId: string) =>
    request<{ computer: Computer }>(`/bots/${botId}/computer/shut-down`, { method: "POST" }),
  deleteComputer: (botId: string) => request<unknown>(`/bots/${botId}/computer`, { method: "DELETE" }),
  /** A link to the Computer's live view, to open as a WebSocket within a minute. */
  liveView: (botId: string) => request<{ url: string; expiresAt: string }>(`/bots/${botId}/computer/live-view`, { method: "POST" }),

  /** Where a message's file can be fetched, for its Customer only. */
  attachmentUrl: (botId: string, attachmentId: string) => `/api/bots/${botId}/attachments/${attachmentId}`,

  /**
   * Sends a message on the web Channel and streams the Bot's reply: `onText` gets
   * each piece as the model writes it, `onThinking` what it thinks first, `onStatus`
   * what the Bot is doing (such as using its Computer) and `onSources` the pages a
   * web search found. Resolves with the saved reply.
   */
  async sendMessage(botId: string, content: string, options: MessageOptions, handlers: ReplyHandlers): Promise<Message> {
    const { onSent = () => {}, onText, onStatus = () => {}, onThinking = () => {}, onSources = () => {} } = handlers;
    const response = await send(`/bots/${botId}/messages`, { method: "POST", json: { content, ...options } });
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
        if (event.name === "sent") onSent((event.data as { message: Message }).message);
        if (event.name === "status") onStatus((event.data as { text: string }).text);
        if (event.name === "thinking") onThinking((event.data as { text: string }).text);
        if (event.name === "sources") {
          const found = event.data as { sources: WebSource[]; searchSuggestions?: string };
          onSources(found.sources, found.searchSuggestions);
        }
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
