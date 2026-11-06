// The one seam every Model provider plugs into (ADR 0005). The agent loop
// talks only to this interface; each Model provider's adapter speaks its own API.

export type ModelProvider = "openai" | "anthropic" | "google" | "xai" | "openrouter" | "local";

/** A message as Model providers see it: the person's words, or the Bot's. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  /** The model as its Model provider names it. */
  model: string;
  /** What the Bot is and how it should behave. */
  instructions: string;
  /** The conversation so far, oldest first, ending with the latest message to answer. */
  conversation: ChatMessage[];
}

/**
 * One billed attempt's usage, in one shape for every Model provider, which
 * metering prices from the Price table (ticket 07). Thinking tokens count as
 * output, as every Model provider bills them.
 */
export interface ModelUsage {
  /**
   * The model these tokens were used on, priced at its own rates: the one asked
   * for, or the Claude model that answered when it declined.
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
  /**
   * One entry per billed attempt: two when a Claude model declined and another
   * answered. Empty when the Model provider reported none; such a call has no
   * cost evidence.
   */
  | { type: "done"; usage: ModelUsage[] };

export interface ModelAdapter {
  /** One call to the Model provider: a single HTTP attempt, streamed. Throws ModelError if it fails. */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/** Each Model provider's adapter, or null when it isn't set up. */
export type ModelAdapters = Record<ModelProvider, ModelAdapter | null>;

/** A model call that failed, was refused, or ended without finishing its reply. */
export class ModelError extends Error {
  override name = "ModelError";
}
