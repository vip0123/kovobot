import OpenAI from "openai";
import { type ModelAdapter, ModelError } from "./adapter.ts";

/**
 * OpenAI's Responses API, through the official SDK (ADR 0005). xAI documents
 * the same SDK against its own Responses API, so this adapter serves xAI too.
 */
export function createOpenAIAdapter({ apiKey, baseURL }: { apiKey: string; baseURL?: string }): ModelAdapter {
  // One HTTP attempt per call, never a hidden retry: each attempt gets its own Hold (ADR 0004).
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });

  return {
    async *stream({ model, instructions, conversation }) {
      let events;
      try {
        events = await client.responses.create({
          model,
          instructions,
          input: conversation.map((message) => ({ role: message.role, content: message.content })),
          stream: true,
          // Conversations live in our database, not on the Model provider's servers.
          store: false,
        });
      } catch (error) {
        throw new ModelError("The Model provider didn't accept the call.", { cause: error });
      }

      try {
        for await (const event of events) {
          switch (event.type) {
            case "response.output_text.delta":
              yield { type: "text", text: event.delta };
              break;
            case "response.completed": {
              const usage = event.response.usage;
              if (!usage) {
                yield { type: "done", usage: [] };
                return;
              }
              const cached = usage.input_tokens_details?.cached_tokens ?? 0;
              const written =
                (usage.input_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens ?? 0;
              // xAI reports its cost in ticks: 10^10 per US dollar, so 10^4 per micro-dollar.
              const ticks = (usage as { cost_in_usd_ticks?: unknown }).cost_in_usd_ticks;
              yield {
                type: "done",
                usage: [
                  {
                    model,
                    inputTokens: Math.max(0, usage.input_tokens - cached - written),
                    cacheReadTokens: cached,
                    cacheWriteTokens: written,
                    outputTokens: usage.output_tokens,
                    reportedCostMicros: typeof ticks === "number" ? Math.ceil(ticks / 10_000) : null,
                  },
                ],
              };
              return;
            }
            case "response.failed":
            case "response.incomplete":
              throw new ModelError(`The reply ended early (${event.type}).`);
            case "error":
              throw new ModelError(`The Model provider reported an error: ${event.message}`);
          }
        }
      } catch (error) {
        if (error instanceof ModelError) throw error;
        throw new ModelError("The reply broke off.", { cause: error });
      }
      throw new ModelError("The reply ended without finishing.");
    },
  };
}
