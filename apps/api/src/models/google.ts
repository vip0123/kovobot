import { type Content, Environment, GoogleGenAI, type GroundingMetadata, type Part, ThinkingLevel, type Tool } from "@google/genai";
import {
  type ComputerAction,
  type ComputerCall,
  type ComputerStep,
  type ConversationItem,
  type ModelAdapter,
  ModelError,
  type ModelUsage,
  uniquePages,
} from "./adapter.ts";
import { xdotoolKeys } from "./computer-keys.ts";

/** Ids we give calls that came without one; Gemini isn't sent them back. */
const MADE_UP_ID = "gemini-";

/** Google's Gemini API, through the official SDK (ADR 0005). Gemini caches repeated prefixes by itself. */
export function createGoogleAdapter({ apiKey, baseURL }: { apiKey: string; baseURL?: string }): ModelAdapter {
  // One HTTP attempt per call, never a hidden retry: each attempt gets its own Hold (ADR 0004).
  const client = new GoogleGenAI({ apiKey, httpOptions: { baseUrl: baseURL, retryOptions: { attempts: 1 } } });

  return {
    async *stream({ model, instructions, conversation, tools, computer, thinking, webSearch }) {
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
        // Grounding with Google Search runs on Google's side; the reply's grounding names its sources.
        ...(webSearch ? [{ googleSearch: {} }] : []),
      ];
      // Gemini refuses its own tools beside function calling unless told it may use both.
      const mixesTools = webSearch === true && (tools ?? []).length > 0;
      let grounding: GroundingMetadata | undefined;
      try {
        const chunks = await client.models.generateContentStream({
          model,
          contents: conversation.map(toContent),
          config: {
            systemInstruction: instructions,
            ...(geminiTools.length > 0 ? { tools: geminiTools } : {}),
            ...(mixesTools ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
            // Its thoughts come back as parts marked `thought`; thinking harder raises the level.
            ...(thinking
              ? { thinkingConfig: { includeThoughts: true, ...(thinking === "deep" ? { thinkingLevel: ThinkingLevel.HIGH } : {}) } }
              : {}),
          },
        });
        for await (const chunk of chunks) {
          if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason;
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) finished = true;
          if (candidate?.groundingMetadata) grounding = candidate.groundingMetadata;
          for (const part of candidate?.content?.parts ?? []) {
            parts.push(part);
            if (part.text) yield part.thought ? { type: "thinking", text: part.text } : { type: "text", text: part.text };
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
      // Google's search has no cap to set: its sources are what it grounded the reply on.
      const sources = uniquePages(
        (grounding?.groundingChunks ?? []).flatMap((chunk) =>
          chunk.web?.uri ? [{ url: chunk.web.uri, title: chunk.web.title || chunk.web.domain || chunk.web.uri }] : [],
        ),
      );
      if (sources.length > 0) {
        const searchSuggestions = grounding?.searchEntryPoint?.renderedContent;
        yield { type: "sources", sources, ...(searchSuggestions ? { searchSuggestions } : {}) };
      }

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
 * One of the computer-use tool's predefined functions for the desktop environment, as the
 * Computer agent's actions. The names and arguments are Google's computer-use reference for
 * ENVIRONMENT_DESKTOP, as gemini-4-argon sent them live. Gemini points on a 0-999 grid,
 * scaled here to the screen's pixels. Anything else is answered as something the Computer can't do.
 */
function computerStep(id: string, name: string, args: Record<string, unknown>, screen: { width: number; height: number }): ComputerStep {
  const px = (value: unknown, size: number) => Math.min(size - 1, Math.max(0, Math.round((Number(value) / 1000) * size)));
  const x = px(args.x, screen.width);
  const y = px(args.y, screen.height);
  const step = (actions: ComputerAction[]): ComputerStep => ({ id, name, actions, screenshot: true });
  const click = (button: "left" | "middle" | "right", count: 1 | 2 | 3) => step([{ type: "click", x, y, button, count }]);
  switch (name) {
    case "click":
      return click("left", 1);
    case "double_click":
      return click("left", 2);
    case "triple_click":
      return click("left", 3);
    case "right_click":
      return click("right", 1);
    case "middle_click":
      return click("middle", 1);
    case "type": {
      // Into whatever has the focus; Gemini clicks first when it needs to.
      const actions: ComputerAction[] = [{ type: "type", text: String(args.text ?? "") }];
      if (args.press_enter === true) actions.push({ type: "keys", keys: "Return" });
      return step(actions);
    }
    case "press_key":
      return step([{ type: "keys", keys: xdotoolKeys(String(args.key ?? "")) }]);
    case "hotkey": {
      const keys = Array.isArray(args.keys) ? args.keys.map(String) : [String(args.keys ?? "")];
      return step([{ type: "keys", keys: xdotoolKeys(keys.join("+")) }]);
    }
    case "move":
      return step([{ type: "move", x, y }]);
    case "mouse_down":
    case "mouse_up":
      return step([{ type: "move", x, y }, { type: name, button: "left" }]);
    case "drag_and_drop":
      return step([
        {
          type: "drag",
          path: [
            [px(args.start_x, screen.width), px(args.start_y, screen.height)],
            [px(args.end_x, screen.width), px(args.end_y, screen.height)],
          ],
        },
      ]);
    case "scroll": {
      // magnitude_in_pixels defaults to 300; a wheel click moves about 100 pixels.
      const clicks = Math.min(10, Math.max(1, Math.round(Number(args.magnitude_in_pixels ?? 300) / 100)));
      const direction = args.direction;
      const dx = direction === "left" ? -clicks : direction === "right" ? clicks : 0;
      const dy = direction === "up" ? -clicks : direction === "down" ? clicks : 0;
      return step([{ type: "scroll", x, y, dx, dy }]);
    }
    case "wait":
      return step([{ type: "wait", ms: Math.min(60, Math.max(0, Number(args.seconds ?? 1))) * 1000 }]);
    case "take_screenshot":
      return step([]);
    case "key_down":
    case "key_up":
      return { ...step([]), unsupported: `The Computer can't hold a key down; press keys together with hotkey instead.` };
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
        parts: [
          ...(item.content || !item.attachments?.length ? [{ text: item.content }] : []),
          ...(item.screenshot ? [{ inlineData: { mimeType: "image/png", data: item.screenshot } }] : []),
          ...(item.attachments ?? []).map((file) => ({ inlineData: { mimeType: file.mediaType, data: file.data } })),
        ],
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
