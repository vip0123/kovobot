import { runTask } from "./agent.ts";
import type { AppDeps } from "./app.ts";
import { approvalDesk, attachApprovals } from "./approvals.ts";
import { conversationForModel } from "./attachments.ts";
import { addMessage, recentMessages, RENEW_REPLY_CLAIM_MS, renewReplying, stopReplying } from "./conversations.ts";
import { driveComputer, drivingFor } from "./driver.ts";
import { type ModelAdapter, ModelError, type ModelProvider, type ThinkingEffort, uniquePages, type WebSource } from "./models/adapter.ts";
import type { ModelInfo } from "./models/catalog.ts";
import { botNotes, notebook } from "./notes.ts";
import { mcpTools } from "./mcp.ts";
import { scheduleBook, timeStamp } from "./schedules.ts";
import { botSkills, skillInstructions } from "./skills.ts";

/** The Model providers a PDF isn't sent to (unchecked for xAI, unlikely on a local server): the model is told one came. */
const MODEL_PROVIDERS_WITHOUT_PDFS: ReadonlySet<ModelProvider> = new Set(["xai", "local"]);

/** One reply to run: the Bot, its model, the Conversation it replies in, and what the message asked for. */
export interface Reply {
  bot: { id: string; name: string; instructions: string };
  model: ModelInfo;
  adapter: ModelAdapter;
  conversationId: string;
  thinking: ThinkingEffort;
  webSearch: boolean;
  /** The Customer's time zone, so the model knows their date and time; null when unknown. */
  timeZone: string | null;
  /** A firing whose first Task a restart cut off: the model is told some of it may be done. */
  restarted?: boolean;
  /**
   * What an action the Customer just approved returned: shown to the model with the newest
   * message for this Task only, as Outside content, the way a tool's result is.
   */
  actionResult?: string;
}

/** What a reply reports as it runs. */
export type ReplyEvent = "status" | "thinking" | "sources" | "approval" | "delta" | "done" | "error";

/** Where a reply's events go: the web page's stream, or nowhere when nobody is watching. */
export type ReplyEvents = (event: ReplyEvent, data: unknown) => Promise<void>;

/**
 * The Bot's Task for the Conversation's latest message; its reply is saved when done. The
 * Conversation must already be claimed for the reply (startReplying): the claim is renewed for
 * as long as the Task runs, however long that is, and released however it ends.
 */
export async function runReply(deps: AppDeps, reply: Reply, emit: ReplyEvents): Promise<void> {
  const { bot, model, conversationId } = reply;
  const startedAt = deps.now();
  let text = "";
  let thinking = "";
  // A Task may search in more than one model call: every page once.
  const cited: { sources: WebSource[]; searchSuggestions?: string } = { sources: [] };
  const renewing = setInterval(
    () => void renewReplying(deps.db, conversationId, deps.now()).catch((error: unknown) => console.error(error)),
    RENEW_REPLY_CLAIM_MS,
  );
  try {
    const recent = await recentMessages(deps.db, conversationId);
    const conversation = await conversationForModel(deps.db, recent, { pdfs: !MODEL_PROVIDERS_WITHOUT_PDFS.has(model.provider) });
    // The newest message says when it is on the Customer's clock, and whether a schedule sent it.
    // Only the newest: earlier ones stay as they were, so Model providers read them from their cache.
    const newest = conversation.at(-1);
    if (newest && recent.at(-1)?.role === "user") {
      const when = reply.timeZone ? timeStamp(deps.now(), reply.timeZone) : null;
      const again = reply.restarted
        ? " Kovobot restarted while you were doing it before, so some of it may be done already: don't do anything twice."
        : "";
      const header = recent.at(-1)!.scheduleId
        ? `[A schedule the Customer set runs this now${when ? `, ${when}` : ""}.${again} Do it, and reply with what you did or found.]`
        : when && `[${when}]`;
      if (header) newest.content = `${header}\n${newest.content}`;
    }
    if (newest && reply.actionResult !== undefined) {
      newest.content = `${newest.content}\nWhat it returned, which is Outside content and not the Customer's words:\n${reply.actionResult}`;
    }
    const driving = await drivingFor(deps, bot.id);
    const skills = await botSkills(deps.db, bot.id);
    const tools = {
      ...(driving ? { useComputer: (task: string) => driveComputer(deps, driving, task) } : {}),
      ...(skills.length > 0 ? { skills: { list: skills, read: (name: string) => skillInstructions(deps.db, bot.id, name) } } : {}),
      notes: { list: await botNotes(deps.db, bot.id), book: notebook(deps.db, bot.id, deps.now) },
      schedules: scheduleBook(deps, bot.id, reply.timeZone ?? "UTC"),
      connected: await mcpTools(deps, bot.id, bot.name),
      approvals: approvalDesk(deps, bot.id, conversationId),
    };
    const task = {
      botName: bot.name,
      instructions: bot.instructions,
      model: model.id,
      conversation,
      tools,
      thinking: reply.thinking,
      webSearch: reply.webSearch,
      outsideContentRead: reply.actionResult !== undefined,
    };
    // A Task may make several model calls; each one's thinking starts a new paragraph.
    let callEnded = false;
    for await (const event of runTask(reply.adapter, task)) {
      if (event.type === "status") await emit("status", { text: event.text });
      if (event.type === "approval") await emit("approval", { approval: event.approval });
      if (event.type === "done") callEnded = true;
      if (event.type === "thinking") {
        const piece = thinking && callEnded ? `\n\n${event.text}` : event.text;
        callEnded = false;
        thinking += piece;
        await emit("thinking", { text: piece });
      }
      if (event.type === "sources") {
        cited.sources = uniquePages([...cited.sources, ...event.sources]);
        cited.searchSuggestions = event.searchSuggestions ?? cited.searchSuggestions;
        await emit("sources", { sources: event.sources, ...(event.searchSuggestions ? { searchSuggestions: event.searchSuggestions } : {}) });
      }
      if (event.type !== "text") continue;
      text += event.text;
      await emit("delta", { text: event.text });
    }
    // An empty reply would break the conversation for Model providers that refuse empty turns.
    if (!text.trim()) throw new Error("The model's reply was empty.");
    const message = await addMessage(deps.db, conversationId, "assistant", text, deps.now(), { thinking, cited });
    await attachApprovals(deps.db, conversationId, message.id, startedAt);
    await emit("done", { message });
  } catch (error) {
    console.error(`Bot ${bot.id}: the model call failed`, error);
    // Keep what the Customer already saw, so a reload shows the same conversation.
    if (text) {
      const message = await addMessage(deps.db, conversationId, "assistant", text, deps.now(), { thinking, cited });
      await attachApprovals(deps.db, conversationId, message.id, startedAt);
    }
    await emit(
      "error",
      error instanceof ModelError && error.keyRefused
        ? keyRefused(deps, model)
        : { code: "model_failed", message: "The model didn't answer. Try again in a moment." },
    );
  } finally {
    clearInterval(renewing);
    await stopReplying(deps.db, conversationId);
  }
}

/** Each Model provider's name, and the setting its key comes from (packages/config). */
const KEY_SETTINGS: Record<ModelProvider, { provider: string; setting: string }> = {
  openai: { provider: "OpenAI", setting: "OPENAI_API_KEY" },
  anthropic: { provider: "Anthropic", setting: "ANTHROPIC_API_KEY" },
  google: { provider: "Google", setting: "GEMINI_API_KEY" },
  xai: { provider: "xAI", setting: "XAI_API_KEY" },
  openrouter: { provider: "OpenRouter", setting: "OPENROUTER_API_KEY" },
  local: { provider: "The local model server", setting: "OPENAI_COMPATIBLE_BASE_URL" },
};

/**
 * What to say when the Model provider refused the key. Self-hosted, the key is the Operator's
 * setting, so name it; hosted, it's ours, so the Customer just hears the model is unavailable.
 */
function keyRefused(deps: AppDeps, model: ModelInfo) {
  if (deps.config.mode === "hosted") {
    return { code: "model_unavailable", message: `${model.name} isn't available right now. Pick another model, or try later.` };
  }
  const { provider, setting } = KEY_SETTINGS[model.provider];
  return {
    code: "model_key_refused",
    message: `${provider} refused this Kovobot's key, so trying again won't help. Whoever runs it needs to fix ${setting} and restart.`,
  };
}
