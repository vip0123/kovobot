import OpenAI from "openai";
import { type ModelAdapter, ModelError } from "./adapter.ts";

/** OpenAI's Responses API, through the official SDK (ADR 0005). */
export function createOpenAIAdapter({ apiKey, baseURL }: { apiKey: string; baseURL?: string }): ModelAdapter {
  // One HTTP attempt per call, never a hidden retry: each attempt gets its own Hold (ADR 0004).
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });

  return {
    async *stream({ model, instructions, conversation, signal }) {
      let events;
      try {
        events = await client.responses.create(
          {
            model,
            instructions,
            input: conversation.map((turn) => ({ role: turn.role, content: turn.content })),
            stream: true,
            // Conversations live in our database, not on OpenAI's servers.
            store: false,
          },
          { signal },
        );
      } catch (error) {
        throw new ModelError("OpenAI didn't accept the call.", { cause: error });
      }

      try {
        for await (const event of events) {
          switch (event.type) {
            case "response.output_text.delta":
              yield { type: "text", text: event.delta };
              break;
            case "response.completed": {
              const usage = event.response.usage;
              yield { type: "done", usage: { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 } };
              return;
            }
            case "response.failed":
            case "response.incomplete":
              throw new ModelError(`OpenAI ended the reply early (${event.type}).`);
            case "error":
              throw new ModelError(`OpenAI reported an error: ${event.message}`);
          }
        }
      } catch (error) {
        if (error instanceof ModelError) throw error;
        throw new ModelError("OpenAI's reply broke off.", { cause: error });
      }
      throw new ModelError("OpenAI's reply ended without finishing.");
    },
  };
}
