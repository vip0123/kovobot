// The one seam every Model provider plugs into (ADR 0005). The agent loop
// talks only to this interface; each Model provider's adapter speaks its own API.

export type ModelProvider = "openai";

/** A message as Model providers see it: the person's words, or the Bot's. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  model: string;
  /** What the Bot is and how it should behave. */
  instructions: string;
  /** The conversation so far, oldest first, ending with the latest message to answer. */
  conversation: ChatMessage[];
}

export type ModelEvent =
  | { type: "text"; text: string }
  /** Usage is null when the Model provider didn't report it; such a call has no cost evidence. */
  | { type: "done"; usage: { inputTokens: number; outputTokens: number } | null };

export interface ModelAdapter {
  /** One call to the Model provider: a single HTTP attempt, streamed. Throws ModelError if it fails. */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/** Each Model provider's adapter, or null when no key for it is set. */
export type ModelAdapters = Record<ModelProvider, ModelAdapter | null>;

/** A model call that failed, was refused, or ended without finishing its reply. */
export class ModelError extends Error {
  override name = "ModelError";
}
