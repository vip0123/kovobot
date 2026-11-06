import { GoogleGenAI } from "@google/genai";
import { type ModelAdapter, ModelError, type ModelUsage } from "./adapter.ts";

/** Google's Gemini API, through the official SDK (ADR 0005). Gemini caches repeated prefixes by itself. */
export function createGoogleAdapter({ apiKey, baseURL }: { apiKey: string; baseURL?: string }): ModelAdapter {
  // One HTTP attempt per call, never a hidden retry: each attempt gets its own Hold (ADR 0004).
  const client = new GoogleGenAI({ apiKey, httpOptions: { baseUrl: baseURL, retryOptions: { attempts: 1 } } });

  return {
    async *stream({ model, instructions, conversation }) {
      let usage: ModelUsage[] = [];
      let blocked: string | null = null;
      let finished = false;
      try {
        const chunks = await client.models.generateContentStream({
          model,
          contents: conversation.map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }],
          })),
          config: { systemInstruction: instructions },
        });
        for await (const chunk of chunks) {
          if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason;
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) finished = true;
          for (const part of candidate?.content?.parts ?? []) {
            if (part.text && !part.thought) yield { type: "text", text: part.text };
          }
          if (candidate?.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS") {
            blocked = candidate.finishReason;
          }
          const meta = chunk.usageMetadata;
          if (meta) {
            const cached = meta.cachedContentTokenCount ?? 0;
            usage = [
              {
                model,
                inputTokens: (meta.promptTokenCount ?? 0) - cached,
                cacheReadTokens: cached,
                cacheWriteTokens: 0,
                outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
                reportedCostMicros: null,
              },
            ];
          }
        }
      } catch (error) {
        throw new ModelError("Gemini's reply failed.", { cause: error });
      }
      if (blocked) throw new ModelError(`Gemini stopped the reply (${blocked}).`, { usage });
      if (!finished) throw new ModelError("Gemini's reply was cut off.");
      yield { type: "done", usage };
    },
  };
}
