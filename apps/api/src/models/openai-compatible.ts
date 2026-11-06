import OpenAI from "openai";
import { type ModelAdapter, ModelError, type ModelUsage } from "./adapter.ts";

/**
 * Any OpenAI-compatible Chat Completions API, through the OpenAI SDK: OpenRouter
 * and, in self-hosted installs, local model servers (ADR 0005). Model ids carry
 * a prefix naming the route ("openrouter:", "local:"), which is dropped here.
 */
export function createOpenAICompatibleAdapter({ apiKey, baseURL }: { apiKey: string; baseURL: string }): ModelAdapter {
  // One HTTP attempt per call, never a hidden retry: each attempt gets its own Hold (ADR 0004).
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });

  return {
    async *stream({ model, instructions, conversation }) {
      let usage: ModelUsage[] = [];
      let finishReason: string | null = null;
      try {
        const body = {
          model: model.replace(/^(openrouter|local):/, ""),
          messages: [{ role: "system" as const, content: instructions }, ...conversation],
          stream: true as const,
          stream_options: { include_usage: true },
          // OpenRouter adds its cost to the usage when asked; other servers ignore this.
          usage: { include: true },
        };
        const chunks = await client.chat.completions.create(body as OpenAI.ChatCompletionCreateParamsStreaming);
        for await (const chunk of chunks) {
          const text = chunk.choices[0]?.delta?.content;
          if (text) yield { type: "text", text };
          finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
          if (chunk.usage) {
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
            const written =
              (chunk.usage.prompt_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens ?? 0;
            const cost = (chunk.usage as { cost?: unknown }).cost;
            usage = [
              {
                model,
                inputTokens: chunk.usage.prompt_tokens - cached - written,
                cacheReadTokens: cached,
                cacheWriteTokens: written,
                outputTokens: chunk.usage.completion_tokens,
                // Rounded first, so float error never adds a micro-dollar.
                reportedCostMicros: typeof cost === "number" ? Math.ceil(Number((cost * 1_000_000).toFixed(3))) : null,
              },
            ];
          }
        }
      } catch (error) {
        throw new ModelError("The model server's reply failed.", { cause: error });
      }
      if (finishReason === null) throw new ModelError("The model server's reply was cut off.");
      if (finishReason === "content_filter") throw new ModelError("The model server stopped the reply (content_filter).");
      yield { type: "done", usage };
    },
  };
}
