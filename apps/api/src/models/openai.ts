import OpenAI from "openai";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import {
  type ComputerAction,
  type ConversationItem,
  MAX_SEARCHES_PER_CALL,
  type ModelAdapter,
  ModelError,
  type ModelEvent,
  uniquePages,
  type WebSource,
} from "./adapter.ts";
import { xdotoolKeys } from "./computer-keys.ts";

/** Pixels per wheel click when a scroll comes in pixels. */
const PIXELS_PER_WHEEL_CLICK = 100;

/**
 * OpenAI's Responses API, through the official SDK (ADR 0005). xAI documents
 * the same SDK against its own Responses API, so this adapter serves xAI too.
 */
export function createOpenAIAdapter({
  apiKey,
  baseURL,
  reasoningOptions = true,
}: {
  apiKey: string;
  baseURL?: string;
  /** Whether to send reasoning options (a summary, an effort): OpenAI's; off for xAI, unchecked there. */
  reasoningOptions?: boolean;
}): ModelAdapter {
  // One HTTP attempt per call, never a hidden retry: each attempt gets its own Hold (ADR 0004).
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });

  return {
    async *stream({ model, instructions, conversation, tools, computer, thinking, webSearch }) {
      const usesTools = (tools?.length ?? 0) > 0 || computer !== undefined || webSearch === true;
      let events;
      try {
        events = await client.responses.create({
          model,
          instructions,
          input: conversation.flatMap(toInput),
          stream: true,
          // Conversations live in our database, not on the Model provider's servers.
          store: false,
          // A summary of the model's reasoning streams back; thinking harder raises the effort.
          ...(thinking && reasoningOptions
            ? { reasoning: { summary: "auto" as const, ...(thinking === "deep" ? { effort: "high" as const } : {}) } }
            : {}),
          ...(usesTools
            ? {
                tools: [
                  ...(tools ?? []).map((tool) => ({
                    type: "function" as const,
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                    strict: false,
                  })),
                  ...(computer ? [{ type: "computer" as const }] : []),
                  // OpenAI's web search runs on its side; the reply's text cites what it found.
                  ...(webSearch ? [{ type: "web_search" as const }] : []),
                ],
                ...(webSearch ? { max_tool_calls: MAX_SEARCHES_PER_CALL } : {}),
                // Not stored at OpenAI, so reasoning comes back encrypted for the Task to replay; and
                // every page a search found, which a researching model may read.
                include: ["reasoning.encrypted_content" as const, ...(webSearch ? ["web_search_call.action.sources" as const] : [])],
              }
            : {}),
        } as OpenAI.Responses.ResponseCreateParamsStreaming);
      } catch (error) {
        throw new ModelError("The Model provider didn't accept the call.", { cause: error });
      }

      try {
        for await (const event of events) {
          switch (event.type) {
            case "response.output_text.delta":
              yield { type: "text", text: event.delta };
              break;
            case "response.reasoning_summary_part.added":
              // Each part of the summary is its own paragraph.
              if (event.summary_index > 0) yield { type: "thinking", text: "\n\n" };
              break;
            case "response.reasoning_summary_text.delta":
              yield { type: "thinking", text: event.delta };
              break;
            case "response.completed": {
              const output = event.response.output;
              const sources = webSources(output);
              const found = searchResults(output);
              if (sources.length > 0 || found.length > 0) yield { type: "sources", sources, ...(found.length > 0 ? { found } : {}) };
              yield* calls(output);
              const usage = event.response.usage;
              if (!usage) {
                yield { type: "done", usage: [], turn: output };
                return;
              }
              const cached = usage.input_tokens_details?.cached_tokens ?? 0;
              const written =
                (usage.input_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens ?? 0;
              // xAI reports its cost in ticks: 10^10 per US dollar, so 10^4 per micro-dollar.
              const ticks = (usage as { cost_in_usd_ticks?: unknown }).cost_in_usd_ticks;
              yield {
                type: "done",
                turn: output,
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

/** The model's calls in its output: our function tools' calls, and its turn on the Computer. */
function* calls(output: ResponseOutputItem[]): Generator<ModelEvent> {
  for (const item of output) {
    if (item.type === "function_call") {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(item.arguments) as Record<string, unknown>;
      } catch {
        // A call whose arguments aren't JSON gets an empty input; the tool says what's missing.
      }
      yield { type: "tool_call", call: { id: item.call_id, name: item.name, input } };
    }
    if (item.type === "computer_call") {
      const raw = item as unknown as {
        call_id: string;
        action?: Record<string, unknown>;
        actions?: Array<Record<string, unknown>>;
        pending_safety_checks?: Array<{ id: string; message?: string | null }>;
      };
      const actions = (raw.actions ?? (raw.action ? [raw.action] : [])).flatMap(computerActions);
      yield {
        type: "computer_call",
        call: {
          // One output answers the whole batch, with the screen after its last action.
          steps: [{ id: raw.call_id, name: "computer_call", actions, screenshot: true }],
          safetyChecks: (raw.pending_safety_checks ?? []).map((check) => ({ id: check.id, message: check.message ?? "" })),
        },
      };
    }
  }
}

/** One of the computer tool's actions, as the Computer agent's actions. */
function computerActions(action: Record<string, unknown>): ComputerAction[] {
  const x = Math.round(Number(action.x));
  const y = Math.round(Number(action.y));
  const modifiers = Array.isArray(action.keys) && action.keys.length > 0 ? xdotoolKeys(action.keys as string[]) : undefined;
  const wheel = (pixels: unknown) => {
    const value = Number(pixels ?? 0);
    if (!value) return 0;
    return Math.sign(value) * Math.min(50, Math.max(1, Math.round(Math.abs(value) / PIXELS_PER_WHEEL_CLICK)));
  };
  switch (action.type) {
    case "click":
      if (action.button === "back") return [{ type: "keys", keys: "alt+Left" }];
      if (action.button === "forward") return [{ type: "keys", keys: "alt+Right" }];
      return [{ type: "click", x, y, button: action.button === "right" ? "right" : action.button === "wheel" ? "middle" : "left", count: 1, ...(modifiers ? { modifiers } : {}) }];
    case "double_click":
      return [{ type: "click", x, y, button: "left", count: 2, ...(modifiers ? { modifiers } : {}) }];
    case "keypress":
      return [{ type: "keys", keys: xdotoolKeys(action.keys as string[]) }];
    case "type":
      return [{ type: "type", text: String(action.text ?? "") }];
    case "scroll":
      return [{ type: "scroll", x, y, dx: wheel(action.scroll_x), dy: wheel(action.scroll_y), ...(modifiers ? { modifiers } : {}) }];
    case "drag": {
      const path = Array.isArray(action.path) ? (action.path as Array<{ x: number; y: number }>) : [];
      return [{ type: "drag", path: path.map((point) => [Math.round(point.x), Math.round(point.y)] as [number, number]) }];
    }
    case "move":
      return [{ type: "move", x, y }];
    case "wait":
      return [{ type: "wait", ms: 2000 }];
    default:
      // A screenshot comes with every result anyway.
      return [];
  }
}

/** The pages the reply's text cites, each once, in the order it first appears. */
function webSources(output: ResponseOutputItem[]): WebSource[] {
  const pages: WebSource[] = [];
  for (const item of output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type !== "output_text") continue;
      for (const annotation of part.annotations) {
        if (annotation.type === "url_citation") pages.push({ url: annotation.url, title: annotation.title || annotation.url });
      }
    }
  }
  return uniquePages(pages);
}

/** Every page the answer's searches found, each once: OpenAI lists them only by address. */
function searchResults(output: ResponseOutputItem[]): WebSource[] {
  const pages: WebSource[] = [];
  for (const item of output) {
    if (item.type !== "web_search_call") continue;
    const action = (item as { action?: { sources?: Array<{ type?: string; url?: string }> } }).action;
    for (const source of action?.sources ?? []) if (source.url) pages.push({ url: source.url, title: source.url });
  }
  return uniquePages(pages);
}

/** One conversation item as Responses API input items. */
function toInput(item: ConversationItem): ResponseInputItem[] {
  switch (item.role) {
    case "user":
    case "assistant":
      if (item.attachments?.length) {
        return [
          {
            role: item.role,
            content: [
              ...(item.content ? [{ type: "input_text", text: item.content }] : []),
              ...item.attachments.map((file) =>
                file.mediaType === "application/pdf"
                  ? { type: "input_file", filename: file.name, file_data: `data:${file.mediaType};base64,${file.data}` }
                  : { type: "input_image", image_url: `data:${file.mediaType};base64,${file.data}`, detail: "auto" },
              ),
            ],
          } as ResponseInputItem,
        ];
      }
      return [
        item.screenshot
          ? ({
              role: item.role,
              content: [
                { type: "input_text", text: item.content },
                { type: "input_image", image_url: `data:image/png;base64,${item.screenshot}`, detail: "auto" },
              ],
            } as ResponseInputItem)
          : { role: item.role, content: item.content },
      ];
    case "turn":
      return item.raw as ResponseInputItem[];
    case "tool_results":
      return item.results.map((result) => ({ type: "function_call_output" as const, call_id: result.toolCallId, output: result.output }));
    case "computer_results":
      return item.results.map(
        (result) =>
          ({
            type: "computer_call_output",
            call_id: result.id,
            output: { type: "computer_screenshot", image_url: `data:image/png;base64,${result.screenshot ?? ""}` },
          }) as ResponseInputItem,
      );
  }
}
