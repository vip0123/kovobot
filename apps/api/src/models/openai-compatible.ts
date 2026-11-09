import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  type ConversationItem,
  MAX_SEARCHES_PER_CALL,
  type ModelAdapter,
  ModelError,
  type ModelUsage,
  type WebSource,
} from "./adapter.ts";

/**
 * Any OpenAI-compatible Chat Completions API, through the OpenAI SDK: OpenRouter
 * and, in self-hosted installs, local model servers (ADR 0005). Model ids carry
 * a prefix naming the route ("openrouter:", "local:"), which is dropped here.
 * Neither can be a Driver model, so there is no computer-use tool here.
 */
export function createOpenAICompatibleAdapter({ apiKey, baseURL }: { apiKey: string; baseURL: string }): ModelAdapter {
  // One HTTP attempt per call, never a hidden retry: each attempt gets its own Hold (ADR 0004).
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });

  return {
    async *stream({ model, instructions, conversation, tools, thinking, webSearch }) {
      const viaOpenRouter = model.startsWith("openrouter:");
      // The pages the reply cites, as OpenRouter's web plugin sends them; local servers have no web search.
      const sources: WebSource[] = [];
      let usage: ModelUsage[] = [];
      let finishReason: string | null = null;
      let text = "";
      // Each call's id, name and arguments arrive in pieces, keyed by its index.
      const calls: Array<{ id: string; name: string; arguments: string }> = [];
      try {
        const body = {
          model: model.replace(/^(openrouter|local):/, ""),
          messages: [{ role: "system" as const, content: instructions }, ...conversation.flatMap(toMessages)],
          stream: true as const,
          stream_options: { include_usage: true },
          // OpenRouter adds its cost to the usage when asked; other servers ignore this.
          usage: { include: true },
          // Reasoning models think anyway, and the reasoning streams back; thinking harder asks for more,
          // OpenRouter in its own field, local servers in the field OpenAI-compatible servers take.
          ...(thinking === "deep" ? (viaOpenRouter ? { reasoning: { effort: "high" } } : { reasoning_effort: "high" }) : {}),
          ...(webSearch && viaOpenRouter ? { plugins: [{ id: "web", max_results: MAX_SEARCHES_PER_CALL }] } : {}),
          ...((tools ?? []).length > 0
            ? {
                tools: tools!.map((tool) => ({
                  type: "function" as const,
                  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
                })),
              }
            : {}),
        };
        const chunks = await client.chat.completions.create(body as OpenAI.ChatCompletionCreateParamsStreaming);
        for await (const chunk of chunks) {
          const delta = chunk.choices[0]?.delta;
          // OpenRouter streams reasoning as `reasoning`; some local servers as `reasoning_content`.
          const extra = delta as
            | { reasoning?: unknown; reasoning_content?: unknown; annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string } }> }
            | undefined;
          const reasoning = extra?.reasoning ?? extra?.reasoning_content;
          if (typeof reasoning === "string" && reasoning) yield { type: "thinking", text: reasoning };
          for (const annotation of extra?.annotations ?? []) {
            const page = annotation.type === "url_citation" ? annotation.url_citation : undefined;
            if (page?.url && !sources.some((source) => source.url === page.url)) sources.push({ url: page.url, title: page.title || page.url });
          }
          if (delta?.content) {
            text += delta.content;
            yield { type: "text", text: delta.content };
          }
          for (const piece of delta?.tool_calls ?? []) {
            const call = (calls[piece.index] ??= { id: "", name: "", arguments: "" });
            if (piece.id) call.id = piece.id;
            if (piece.function?.name) call.name += piece.function.name;
            if (piece.function?.arguments) call.arguments += piece.function.arguments;
          }
          finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
          if (chunk.usage) {
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
            const written =
              (chunk.usage.prompt_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens ?? 0;
            const cost = (chunk.usage as { cost?: unknown }).cost;
            usage = [
              {
                model,
                inputTokens: Math.max(0, chunk.usage.prompt_tokens - cached - written),
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
      if (finishReason === "content_filter") {
        throw new ModelError("The model server stopped the reply (content_filter).", { usage });
      }
      if (sources.length > 0) yield { type: "sources", sources };
      for (const call of calls.filter(Boolean)) {
        let input: Record<string, unknown> = {};
        try {
          input = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
        } catch {
          // Arguments that aren't JSON give an empty input; the tool says what's missing.
        }
        yield { type: "tool_call", call: { id: call.id, name: call.name, input } };
      }
      const turn: ChatCompletionMessageParam = {
        role: "assistant",
        content: text,
        ...(calls.length > 0
          ? { tool_calls: calls.filter(Boolean).map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) }
          : {}),
      };
      yield { type: "done", usage, turn };
    },
  };
}

/** One conversation item as Chat Completions messages. */
function toMessages(item: ConversationItem): ChatCompletionMessageParam[] {
  switch (item.role) {
    case "user":
      if (item.attachments?.length) {
        return [
          {
            role: "user",
            content: [
              ...(item.content ? [{ type: "text" as const, text: item.content }] : []),
              ...item.attachments.map((file) =>
                file.mediaType === "application/pdf"
                  ? { type: "file" as const, file: { filename: file.name, file_data: `data:${file.mediaType};base64,${file.data}` } }
                  : { type: "image_url" as const, image_url: { url: `data:${file.mediaType};base64,${file.data}` } },
              ),
            ],
          },
        ];
      }
      return [{ role: "user", content: item.content }];
    case "assistant":
      return [{ role: "assistant", content: item.content }];
    case "turn":
      return [item.raw as ChatCompletionMessageParam];
    case "tool_results":
      return item.results.map((result) => ({ role: "tool" as const, tool_call_id: result.toolCallId, content: result.output }));
    case "computer_results":
      // Never sent: these servers aren't Driver models.
      return [];
  }
}
