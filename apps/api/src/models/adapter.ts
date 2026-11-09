// The one seam every Model provider plugs into (ADR 0005). The agent loop
// talks only to this interface; each Model provider's adapter speaks its own API.

export type ModelProvider = "openai" | "anthropic" | "google" | "xai" | "openrouter" | "local";

/** A message as Model providers see it: the person's words, or the Bot's. */
export interface ChatMessage {
  role: "user" | "assistant";
  /** May be empty when the message is files alone. */
  content: string;
  /** A Driver model's task comes with the screen as it is, as base64 PNG. */
  screenshot?: string;
  /** Files the Customer sent with the message, for the model to see as themselves. Text files arrive as text in `content`. */
  attachments?: FileForModel[];
}

/** A file a model sees natively: an image, or a PDF. */
export interface FileForModel {
  name: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf";
  /** The file, base64. */
  data: string;
}

/** A function our own code runs when the model calls it, such as handing work to the Bot's Computer. */
export interface FunctionTool {
  name: string;
  description: string;
  /** JSON Schema of the call's input. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /** The Model provider's id for the call, which its result answers. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** One action on a Computer, from the set the Computer agent carries out (apps/computers/agent). */
export type ComputerAction =
  | { type: "screenshot" }
  | { type: "cursor_position" }
  | { type: "move"; x: number; y: number }
  /** Without x and y it clicks where the mouse is. */
  | { type: "click"; x?: number; y?: number; button: "left" | "middle" | "right"; count: 1 | 2 | 3; modifiers?: string }
  | { type: "mouse_down" | "mouse_up"; button: "left" }
  | { type: "drag"; path: Array<[number, number]> }
  | { type: "type"; text: string }
  | { type: "keys"; keys: string }
  /** In wheel clicks; without x and y it scrolls where the mouse is. */
  | { type: "scroll"; x?: number; y?: number; dx: number; dy: number; modifiers?: string }
  | { type: "wait"; ms: number };

/** One step of a Driver model's turn on the Computer; one result answers it. */
export interface ComputerStep {
  /** The Model provider's id for the step. */
  id: string;
  /** The Model provider's name for the action, which some of them need in the result. */
  name: string;
  /** Set when the Computer can't do what was asked: the step's result says so instead. */
  unsupported?: string;
  /** Carried out in order. */
  actions: ComputerAction[];
  /** Whether its result shows the screen as it is afterwards. */
  screenshot: boolean;
}

/** A Driver model's turn on the Computer. */
export interface ComputerCall {
  steps: ComputerStep[];
  /** What the Model provider wants the Customer's Approval for before it carries on (OpenAI, Google). */
  safetyChecks: Array<{ id: string; message: string }>;
}

/** What came of one step: the screen afterwards, a note, or why it failed. */
export interface ComputerStepResult {
  id: string;
  name: string;
  /** The screen afterwards, as base64 PNG. */
  screenshot?: string;
  text?: string;
  error?: string;
}

/** One item of the conversation a model call sees, as the agent loop builds it within a Task. */
export type ConversationItem =
  | ChatMessage
  /** An earlier answer in this Task, in the Model provider's own shape, replayed exactly as it came. */
  | { role: "turn"; raw: unknown }
  | { role: "tool_results"; results: Array<{ toolCallId: string; name: string; output: string }> }
  | { role: "computer_results"; results: ComputerStepResult[] };

export interface ModelRequest {
  /** The model as its Model provider names it. */
  model: string;
  /** What the Bot is and how it should behave. */
  instructions: string;
  /** The conversation so far, oldest first, ending with the latest message or results to answer. */
  conversation: ConversationItem[];
  /** Functions the model may call; it then answers with the calls, and the next call gets their results. */
  tools?: FunctionTool[];
  /** Gives a Driver model its Model provider's computer-use tool, for a screen this size. */
  computer?: { width: number; height: number };
  /**
   * Asks the model to think where it can, and to stream what it thinks as "thinking"
   * events; "deep" asks it to think harder. Unset for Driver models, which work unseen.
   */
  thinking?: "normal" | "deep";
  /**
   * Gives the model its Model provider's own web search, a few searches per call at most;
   * the pages its reply draws on come back as a "sources" event.
   */
  webSearch?: boolean;
}

/** A web page a reply draws on. */
export interface WebSource {
  url: string;
  title: string;
}

/** The most web searches one model call may make: a ceiling on what a call can cost. */
export const MAX_SEARCHES_PER_CALL = 5;

/**
 * One billed attempt's usage, in one shape for every Model provider, which
 * metering prices from the Price table (ticket 07). Thinking tokens count as
 * output, as every Model provider bills them.
 */
export interface ModelUsage {
  /**
   * The model these tokens were used on, priced at its own rates: the one asked
   * for, or the one a server-side fallback answered with when it declined.
   */
  model: string;
  /** Input at the full rate: neither read from nor written to the cache. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /**
   * What the Model provider says the call cost, in micro-dollars, where it
   * reports one: OpenRouter's cost (its price) and xAI's (a cross-check).
   */
  reportedCostMicros: number | null;
}

export type ModelEvent =
  | { type: "text"; text: string }
  /** A piece of what the model thinks before and between its answers, as its Model provider shows it. */
  | { type: "thinking"; text: string }
  /**
   * The web pages the reply draws on, once, after it. Google asks apps to show its search
   * suggestions with grounded replies: `searchSuggestions` is that HTML, as Google sent it.
   */
  | { type: "sources"; sources: WebSource[]; searchSuggestions?: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "computer_call"; call: ComputerCall }
  /**
   * One entry per billed attempt: more than one when a server-side fallback
   * ran. Empty when the Model provider reported none; such a call has no cost
   * evidence. `turn` is the whole answer in the Model provider's own shape, for
   * the next call in the same Task to replay.
   */
  | { type: "done"; usage: ModelUsage[]; turn: unknown };

export interface ModelAdapter {
  /** One call to the Model provider: a single HTTP attempt, streamed. Throws ModelError if it fails. */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/** Each Model provider's adapter, or null when it isn't set up. */
export type ModelAdapters = Record<ModelProvider, ModelAdapter | null>;

/** A model call that failed, was refused, or ended without finishing its reply. */
export class ModelError extends Error {
  override name = "ModelError";
  /** What the attempts billed before it failed used, where the Model provider reported it: a refusal is billed too. */
  readonly usage: ModelUsage[];

  constructor(message: string, options: { cause?: unknown; usage?: ModelUsage[] } = {}) {
    super(message, { cause: options.cause });
    this.usage = options.usage ?? [];
  }

  /** Whether the Model provider refused the key itself (HTTP 401 or 403), which trying again won't fix. */
  get keyRefused(): boolean {
    // Each Model provider's SDK puts the HTTP status on the error it throws.
    const status = (this.cause as { status?: unknown } | undefined)?.status;
    return status === 401 || status === 403;
  }
}
