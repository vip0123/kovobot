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
      let usage: ModelUsage | null = null;
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
          if (chunk.usage) {
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
            const cost = (chunk.usage as { cost?: unknown }).cost;
            usage = {
              inputTokens: chunk.usage.prompt_tokens - cached,
              cacheReadTokens: cached,
              cacheWriteTokens: 0,
              outputTokens: chunk.usage.completion_tokens,
              reportedCostMicros: typeof cost === "number" ? Math.ceil(cost * 1_000_000) : null,
            };
          }
        }
      } catch (error) {
        throw new ModelError("The model server's reply failed.", { cause: error });
      }
      yield { type: "done", usage };
    },
  };
}
