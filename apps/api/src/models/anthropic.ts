import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  type ComputerAction,
  type ComputerStep,
  type ConversationItem,
  MAX_SEARCHES_PER_CALL,
  type ModelAdapter,
  ModelError,
  type ModelEvent,
  type ModelUsage,
  uniquePages,
  type WebSource,
} from "./adapter.ts";
import { xdotoolKeys } from "./computer-keys.ts";

/** Models with a server-side refusal fallback: if one declines, another Claude model answers in the same call. */
const MODELS_WITH_FALLBACK = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);
/** Anthropic's computer-use tool; its actions arrive as tool_use blocks named after each action. */
const COMPUTER_TOOLSET = "computer_toolset_20260801";
const COMPUTER = "computer";
/**
 * Anthropic's web search server tool, the version that cites the pages its reply uses. The newer
 * ones (20260209, 20260318) filter results with code execution and, live, cite nothing.
 */
const WEB_SEARCH_TOOL = "web_search_20250305" as const;
/** The most search results shown when a reply cites none. */
const UNCITED_RESULTS_SHOWN = 5;

/** Anthropic's Messages API, through the official SDK (ADR 0005), with prompt caching on. */
export function createAnthropicAdapter({
  apiKey,
  baseURL,
  workspaceId,
}: {
  apiKey: string;
  baseURL?: string;
  /** For a key that isn't scoped to a workspace: Anthropic refuses its calls unless they name one. */
  workspaceId?: string | null;
}): ModelAdapter {
  // One HTTP attempt per call, never a hidden retry: each attempt gets its own Hold (ADR 0004).
  const client = new Anthropic({
    apiKey,
    baseURL,
    maxRetries: 0,
    ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}),
  });

  return {
    async *stream({ model, instructions, conversation, tools, computer, thinking, webSearch }) {
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
      let content: BetaContentBlock[] = [];
      const toolUnion: BetaToolUnion[] = [
        ...(tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters as { type: "object" },
        })),
        // zoom and hold_key are off: the Computer can't crop a screenshot or hold a key for a time.
        ...(computer
          ? [{ type: COMPUTER_TOOLSET, configs: { zoom: { enabled: false }, hold_key: { enabled: false } } } as BetaToolUnion]
          : []),
        // Anthropic's web search runs on its side; the reply cites what it found.
        ...(webSearch ? [{ type: WEB_SEARCH_TOOL, name: "web_search" as const, max_uses: MAX_SEARCHES_PER_CALL }] : []),
      ];
      try {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: 64_000,
          system: instructions,
          messages: conversation.map(toMessage),
          ...(toolUnion.length > 0 ? { tools: toolUnion } : {}),
          // Caches the conversation so far, so the next message reads it back at the cache rate.
          cache_control: { type: "ephemeral" },
          // The model decides when and how much to think; a summary of it streams back.
          ...(thinking ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
          ...(thinking === "deep" ? { output_config: { effort: "xhigh" as const } } : {}),
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
              if (event.delta.type === "thinking_delta") yield { type: "thinking", text: event.delta.thinking };
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
        if (stopReason !== null) content = (await stream.finalMessage()).content;
      } catch (error) {
        throw new ModelError("Anthropic's reply failed.", { cause: error });
      }
      const usage = attempts ?? [answering];
      // Every model asked declined: still billed, so the error carries what they used.
      if (stopReason === "refusal") throw new ModelError("The model declined to answer.", { usage });
      if (stopReason === null) throw new ModelError("Anthropic's reply was cut off.");
      const sources = webSources(content);
      if (sources.length > 0) yield { type: "sources", sources, found: searchResults(content) };
      yield* calls(content);
      // A long turn with server tools (web search) can pause; the Task sends it back to carry on.
      yield { type: "done", usage, turn: content, ...(stopReason === "pause_turn" ? { paused: true } : {}) };
    },
  };
}

/**
 * The pages a reply draws on: those its text cites, or, when it cites none, those its
 * searches found. Each page once, in the order it first appears.
 */
function webSources(content: BetaContentBlock[]): WebSource[] {
  const cited: WebSource[] = [];
  const found: WebSource[] = [];
  for (const block of content) {
    if (block.type === "text") {
      for (const citation of block.citations ?? []) {
        if (citation.type === "web_search_result_location") cited.push({ url: citation.url, title: citation.title ?? citation.url });
      }
    }
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) found.push({ url: result.url, title: result.title });
    }
  }
  return cited.length > 0 ? uniquePages(cited) : uniquePages(found).slice(0, UNCITED_RESULTS_SHOWN);
}

/** Every page the answer's searches found, each once. */
function searchResults(content: BetaContentBlock[]): WebSource[] {
  return uniquePages(
    content.flatMap((block) =>
      block.type === "web_search_tool_result" && Array.isArray(block.content) ? block.content.map((result) => ({ url: result.url, title: result.title })) : [],
    ),
  );
}

/** The model's calls in its answer: our function tools' calls, and its turn on the Computer. */
function* calls(content: BetaContentBlock[]): Generator<ModelEvent> {
  const steps: ComputerStep[] = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    if ((block as { toolset_name?: string | null }).toolset_name === COMPUTER) steps.push(computerStep(block.id, block.name, input));
    else yield { type: "tool_call", call: { id: block.id, name: block.name, input } };
  }
  if (steps.length > 0) yield { type: "computer_call", call: { steps, safetyChecks: [] } };
}

const coordinate = (value: unknown): { x: number; y: number } | undefined =>
  Array.isArray(value) && value.length === 2 ? { x: Math.round(Number(value[0])), y: Math.round(Number(value[1])) } : undefined;

/** One of the computer toolset's actions, as the Computer agent's actions. */
function computerStep(id: string, name: string, input: Record<string, unknown>): ComputerStep {
  const at = coordinate(input.coordinate);
  const modifiers = typeof input.text === "string" && input.text ? xdotoolKeys(input.text) : undefined;
  const click = (button: "left" | "middle" | "right", count: 1 | 2 | 3): ComputerAction => ({ type: "click", ...at, button, count, modifiers });
  const step = (actions: ComputerAction[], screenshot = false): ComputerStep => ({ id, name, actions, screenshot });
  switch (name) {
    case "screenshot":
      return step([], true);
    case "cursor_position":
      return step([{ type: "cursor_position" }]);
    case "mouse_move":
      return at ? step([{ type: "move", ...at }]) : { ...step([]), unsupported: "mouse_move needs a coordinate." };
    case "left_click":
      return step([click("left", 1)]);
    case "right_click":
      return step([click("right", 1)]);
    case "middle_click":
      return step([click("middle", 1)]);
    case "double_click":
      return step([click("left", 2)]);
    case "triple_click":
      return step([click("left", 3)]);
    case "left_mouse_down":
      return step([{ type: "mouse_down", button: "left" }]);
    case "left_mouse_up":
      return step([{ type: "mouse_up", button: "left" }]);
    case "left_click_drag": {
      const from = coordinate(input.start_coordinate);
      return from && at
        ? step([{ type: "drag", path: [[from.x, from.y], [at.x, at.y]] }])
        : { ...step([]), unsupported: "left_click_drag needs start_coordinate and coordinate." };
    }
    case "scroll": {
      const amount = Math.min(50, Math.max(1, Math.round(Number(input.scroll_amount ?? 3))));
      const direction = String(input.scroll_direction);
      const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
      const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
      return step([{ type: "scroll", ...at, dx, dy, modifiers }]);
    }
    case "type":
      return step([{ type: "type", text: String(input.text ?? "") }]);
    case "key": {
      const repeat = Math.min(20, Math.max(1, Math.round(Number(input.repeat ?? 1))));
      return step(Array.from({ length: repeat }, () => ({ type: "keys" as const, keys: xdotoolKeys(String(input.text ?? "")) })));
    }
    case "wait":
      return step([{ type: "wait", ms: Math.min(10_000, Math.max(0, Math.round(Number(input.duration ?? 1) * 1000))) }]);
    default:
      return { ...step([]), unsupported: `The Computer can't do "${name}".` };
  }
}

/** One conversation item in the Messages API's shape. */
function toMessage(item: ConversationItem): BetaMessageParam {
  switch (item.role) {
    case "user":
    case "assistant":
      if (item.attachments?.length) {
        // Files first, then the words, as Anthropic advises; no empty text block for files alone.
        return {
          role: item.role,
          content: [
            ...item.attachments.map((file): BetaContentBlockParam =>
              file.mediaType === "application/pdf"
                ? { type: "document", source: { type: "base64", media_type: file.mediaType, data: file.data }, title: file.name }
                : { type: "image", source: { type: "base64", media_type: file.mediaType, data: file.data } },
            ),
            ...(item.content ? [{ type: "text" as const, text: item.content }] : []),
          ],
        };
      }
      return {
        role: item.role,
        content: item.screenshot
          ? [
              { type: "text" as const, text: item.content },
              { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: item.screenshot } },
            ]
          : item.content,
      };
    case "turn":
      return { role: "assistant", content: item.raw as BetaContentBlockParam[] };
    case "tool_results":
      return {
        role: "user",
        content: item.results.map((result) => ({ type: "tool_result" as const, tool_use_id: result.toolCallId, content: result.output })),
      };
    case "computer_results":
      return {
        role: "user",
        content: item.results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.id,
          toolset_name: COMPUTER,
          ...(result.error ? { is_error: true } : {}),
          content: result.screenshot
            ? [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: result.screenshot } }]
            : (result.error ?? result.text ?? "OK"),
        })),
      };
  }
}
