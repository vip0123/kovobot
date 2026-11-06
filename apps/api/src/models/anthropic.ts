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
      const usage: ModelUsage = {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reportedCostMicros: null,
      };
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
              usage.inputTokens = start.input_tokens;
              usage.cacheReadTokens = start.cache_read_input_tokens ?? 0;
              usage.cacheWriteTokens = start.cache_creation_input_tokens ?? 0;
              break;
            }
            case "content_block_delta":
              if (event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
              break;
            case "message_delta":
              usage.outputTokens = event.usage.output_tokens;
              stopReason = event.delta.stop_reason ?? null;
              break;
          }
        }
      } catch (error) {
        throw new ModelError("Anthropic's reply failed.", { cause: error });
      }
      if (stopReason === "refusal") throw new ModelError("The model declined to answer.");
      if (stopReason === null) throw new ModelError("Anthropic's reply was cut off.");
      yield { type: "done", usage };
    },
  };
}
