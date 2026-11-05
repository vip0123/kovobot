// The one seam every Model provider plugs into (ADR 0005). The agent loop
// talks only to this interface; each provider's adapter speaks its own API.

export type Provider = "openai";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  model: string;
  /** What the Bot is and how it should behave. */
  instructions: string;
  /** The conversation so far, oldest first, ending with the Customer's latest message. */
  conversation: ChatTurn[];
  signal?: AbortSignal;
}

export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number } };

export interface ModelAdapter {
  /** One call to the provider: a single HTTP attempt, streamed. Throws ModelError if it fails. */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/** Each provider's adapter, or null when no key for it is set. */
export type ModelAdapters = Record<Provider, ModelAdapter | null>;

/** A model call that failed, was refused, or ended without finishing its reply. */
export class ModelError extends Error {
  override name = "ModelError";
}
