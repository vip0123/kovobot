import Anthropic from "@anthropic-ai/sdk";
import { type ModelAdapter, ModelError, type ModelUsage } from "./adapter.ts";

/** Models with a server-side refusal fallback: if one declines, another Claude model answers in the same call. */
const MODELS_WITH_FALLBACK = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);

/** Anthropic's Messages API, through the official SDK (ADR 0005), with prompt caching on. */
export function createAnthropicAdapter({ apiKey, baseURL }: { apiKey: string; baseURL?: string }): ModelAdapter {
  // One HTTP attempt per call, never a hidden retry: each attempt gets its own Hold (ADR 0004).
  const client = new Anthropic({ apiKey, baseURL, maxRetries: 0 });

  return {
    async *stream({ model, instructions, conversation }) {
      // The answering attempt: the model asked for, or the one that stood in when it declined.
      const answering: ModelUsage = {
        model,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reportedCostMicros: null,
      };
      // Every attempt, as Anthropic bills it, when a fallback ran: the declined one included.
      let attempts: ModelUsage[] | null = null;
      let stopReason: string | null = null;
      try {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: 64_000,
          system: instructions,
          messages: conversation.map((message) => ({ role: message.role, content: message.content })),
          // Caches the conversation so far, so the next message reads it back at the cache rate.
          cache_control: { type: "ephemeral" },
          ...(MODELS_WITH_FALLBACK.has(model)
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
        });
        for await (const event of stream) {
          switch (event.type) {
            case "message_start": {
              const start = event.message.usage;
              answering.model = event.message.model;
              answering.inputTokens = start.input_tokens;
              answering.cacheReadTokens = start.cache_read_input_tokens ?? 0;
              answering.cacheWriteTokens = start.cache_creation_input_tokens ?? 0;
              break;
            }
            case "content_block_delta":
              if (event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
              break;
            case "message_delta": {
              answering.outputTokens = event.usage.output_tokens;
              stopReason = event.delta.stop_reason ?? null;
              const iterations = event.usage.iterations ?? [];
              if (iterations.length > 0) {
                attempts = iterations.map((attempt) => ({
                  model: ("model" in attempt && attempt.model) || model,
                  inputTokens: attempt.input_tokens,
                  cacheReadTokens: attempt.cache_read_input_tokens,
                  cacheWriteTokens: attempt.cache_creation_input_tokens,
                  outputTokens: attempt.output_tokens,
                  reportedCostMicros: null,
                }));
              }
              break;
            }
          }
        }
      } catch (error) {
        throw new ModelError("Anthropic's reply failed.", { cause: error });
      }
      const usage = attempts ?? [answering];
      // Every model asked declined: still billed, so the error carries what they used.
      if (stopReason === "refusal") throw new ModelError("The model declined to answer.", { usage });
      if (stopReason === null) throw new ModelError("Anthropic's reply was cut off.");
      yield { type: "done", usage };
    },
  };
}
