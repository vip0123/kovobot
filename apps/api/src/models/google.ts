import { type Content, Environment, GoogleGenAI, type Part, type Tool } from "@google/genai";
import {
  type ComputerAction,
  type ComputerCall,
  type ComputerStep,
  type ConversationItem,
  type ModelAdapter,
  ModelError,
  type ModelUsage,
} from "./adapter.ts";
import { xdotoolKeys } from "./computer-keys.ts";

/** Ids we give calls that came without one; Gemini isn't sent them back. */
const MADE_UP_ID = "gemini-";

/** Google's Gemini API, through the official SDK (ADR 0005). Gemini caches repeated prefixes by itself. */
export function createGoogleAdapter({ apiKey, baseURL }: { apiKey: string; baseURL?: string }): ModelAdapter {
  // One HTTP attempt per call, never a hidden retry: each attempt gets its own Hold (ADR 0004).
  const client = new GoogleGenAI({ apiKey, httpOptions: { baseUrl: baseURL, retryOptions: { attempts: 1 } } });

  return {
    async *stream({ model, instructions, conversation, tools, computer }) {
      let usage: ModelUsage[] = [];
      let blocked: string | null = null;
      let finished = false;
      // The whole answer, kept as Gemini sent it (thought signatures included) to replay in the Task.
      const parts: Part[] = [];
      const geminiTools: Tool[] = [
        ...((tools ?? []).length > 0
          ? [{ functionDeclarations: tools!.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }]
          : []),
        ...(computer ? [{ computerUse: { environment: Environment.ENVIRONMENT_DESKTOP } }] : []),
      ];
      try {
        const chunks = await client.models.generateContentStream({
          model,
          contents: conversation.map(toContent),
          config: { systemInstruction: instructions, ...(geminiTools.length > 0 ? { tools: geminiTools } : {}) },
        });
        for await (const chunk of chunks) {
          if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason;
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) finished = true;
          for (const part of candidate?.content?.parts ?? []) {
            parts.push(part);
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

      const ours = new Set((tools ?? []).map((tool) => tool.name));
      const computerCall: ComputerCall = { steps: [], safetyChecks: [] };
      let index = 0;
      for (const part of parts) {
        const call = part.functionCall;
        if (!call?.name) continue;
        const id = call.id ?? `${MADE_UP_ID}${index}`;
        index += 1;
        const args = (call.args ?? {}) as Record<string, unknown>;
        if (ours.has(call.name) || !computer) {
          yield { type: "tool_call", call: { id, name: call.name, input: args } };
          continue;
        }
        computerCall.steps.push(computerStep(id, call.name, args, computer));
        const decision = args.safety_decision as { decision?: string; explanation?: string } | undefined;
        if (decision?.decision === "require_confirmation") computerCall.safetyChecks.push({ id, message: decision.explanation ?? "" });
      }
      if (computerCall.steps.length > 0) yield { type: "computer_call", call: computerCall };
      yield { type: "done", usage, turn: { role: "model", parts } satisfies Content };
    },
  };
}

/**
 * One of the computer-use tool's predefined functions, as the Computer agent's actions.
 * Gemini points on a 0-999 grid, scaled here to the screen's pixels. The function names
 * follow Google's computer-use reference; until checked against the live API (no Gemini
 * key here), anything unknown is answered as something the Computer can't do.
 */
function computerStep(id: string, name: string, args: Record<string, unknown>, screen: { width: number; height: number }): ComputerStep {
  const px = (value: unknown, size: number) => Math.min(size - 1, Math.max(0, Math.round((Number(value) / 1000) * size)));
  const x = px(args.x, screen.width);
  const y = px(args.y, screen.height);
  const step = (actions: ComputerAction[]): ComputerStep => ({ id, name, actions, screenshot: true });
  const scroll = (direction: unknown, clicks: number, at?: { x: number; y: number }): ComputerAction => ({
    type: "scroll",
    ...at,
    dx: direction === "left" ? -clicks : direction === "right" ? clicks : 0,
    dy: direction === "up" ? -clicks : direction === "down" ? clicks : 0,
  });
  switch (name) {
    case "click_at":
      return step([{ type: "click", x, y, button: "left", count: 1 }]);
    case "hover_at":
      return step([{ type: "move", x, y }]);
    case "type_text_at": {
      const actions: ComputerAction[] = [{ type: "click", x, y, button: "left", count: 1 }];
      if (args.clear_before_typing !== false) actions.push({ type: "keys", keys: "ctrl+a" }, { type: "keys", keys: "BackSpace" });
      actions.push({ type: "type", text: String(args.text ?? "") });
      if (args.press_enter === true) actions.push({ type: "keys", keys: "Return" });
      return step(actions);
    }
    case "key_combination":
      return step([{ type: "keys", keys: xdotoolKeys(String(args.keys ?? "")) }]);
    case "scroll_at":
      return step([scroll(args.direction, Math.min(50, Math.max(1, Math.round(Number(args.magnitude ?? 600) / 200))), { x, y })]);
    case "scroll_document":
      return step([scroll(args.direction, 5, { x: Math.floor(screen.width / 2), y: Math.floor(screen.height / 2) })]);
    case "drag_and_drop":
      return step([{ type: "drag", path: [[x, y], [px(args.destination_x, screen.width), px(args.destination_y, screen.height)]] }]);
    case "wait_5_seconds":
      return step([{ type: "wait", ms: 5000 }]);
    case "go_back":
      return step([{ type: "keys", keys: "alt+Left" }]);
    case "go_forward":
      return step([{ type: "keys", keys: "alt+Right" }]);
    case "navigate":
      // The browser's address bar, the address, Enter.
      return step([{ type: "keys", keys: "ctrl+l" }, { type: "type", text: String(args.url ?? "") }, { type: "keys", keys: "Return" }]);
    default:
      return { ...step([]), unsupported: `The Computer can't do "${name}"; use the desktop's own menus and windows instead.` };
  }
}

/** One conversation item in the Gemini API's shape. */
function toContent(item: ConversationItem): Content {
  const id = (value: string) => (value.startsWith(MADE_UP_ID) ? {} : { id: value });
  switch (item.role) {
    case "user":
      return {
        role: "user",
        parts: [{ text: item.content }, ...(item.screenshot ? [{ inlineData: { mimeType: "image/png", data: item.screenshot } }] : [])],
      };
    case "assistant":
      return { role: "model", parts: [{ text: item.content }] };
    case "turn":
      return item.raw as Content;
    case "tool_results":
      return {
        role: "user",
        parts: item.results.map((result) => ({
          functionResponse: { ...id(result.toolCallId), name: result.name, response: { output: result.output } },
        })),
      };
    case "computer_results":
      return {
        role: "user",
        parts: item.results.map((result) => ({
          functionResponse: {
            ...id(result.id),
            name: result.name,
            response: result.error ? { error: result.error } : {},
            ...(result.screenshot ? { parts: [{ inlineData: { mimeType: "image/png", data: result.screenshot } }] } : {}),
          },
        })),
      };
  }
}
