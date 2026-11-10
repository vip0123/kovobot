import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { type Db, transaction } from "@kovobot/db";
import { runTask } from "./agent.ts";
import type { AppDeps } from "./app.ts";
import {
  ATTACHMENTS_COLUMN,
  type AttachmentInfo,
  conversationForModel,
  findAttachment,
  readAttachments,
  saveAttachments,
} from "./attachments.ts";
import { sessionCustomer } from "./auth/sessions.ts";
import { computerRoutes, computerSizes, deleteBotComputer } from "./computer-routes.ts";
import { driveComputer, drivingFor } from "./driver.ts";
import type { Customer } from "./customers.ts";
import { apiError, jsonBody, UUID_PATTERN } from "./http.ts";
import { type ModelAdapters, ModelError, type ModelProvider, uniquePages, type WebSource } from "./models/adapter.ts";
import { describeModel, MODELS, type ModelInfo } from "./models/catalog.ts";

export interface Bot {
  id: string;
  name: string;
  model: string;
  /** The model the Bot operates its Computer with; null until the Customer picks one. */
  driverModel: string | null;
  /** What the Customer tells the Bot about how to work for them; empty for none. */
  instructions: string;
  createdAt: Date;
}

/** Driver models come only from the Model providers with a computer-use tool. */
const DRIVER_PROVIDERS = new Set(["openai", "anthropic", "google"]);

/** The Model providers a PDF isn't sent to (unchecked for xAI, unlikely on a local server): the model is told one came. */
const MODEL_PROVIDERS_WITHOUT_PDFS: ReadonlySet<ModelProvider> = new Set(["xai", "local"]);

/** The Model providers whose own web search a Bot can use; xAI's is unchecked here, local servers have none. */
const SEARCHING_PROVIDERS: readonly ModelProvider[] = ["openai", "anthropic", "google", "openrouter"];

/**
 * The Model providers set up here whose models may search the web. Hosted, none yet: a search
 * costs per call and has no row in the Price table, so it would be an unpriced call (ADR 0009).
 */
function webSearchProviders(deps: Pick<AppDeps, "config" | "models">): ModelProvider[] {
  if (deps.config.mode === "hosted") return [];
  return SEARCHING_PROVIDERS.filter((provider) => deps.models[provider] !== null);
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** What the model thought before this reply, as its Model provider showed it; null for none. */
  thinking: string | null;
  /** The web pages this reply drew on, from its Model provider's web search; null for none. */
  sources: WebSource[] | null;
  /** Google's search suggestions for a reply grounded with Google Search, as Google's HTML. */
  searchSuggestions: string | null;
  /** Files the Customer sent with this message. */
  attachments: AttachmentInfo[];
  createdAt: Date;
}

const MAX_NAME_LENGTH = 80;
const MAX_INSTRUCTIONS_LENGTH = 8_000;
const MAX_MESSAGE_LENGTH = 20_000;
/** The most of a conversation's latest messages the model sees. */
const MESSAGES_SENT_TO_MODEL = 50;
/**
 * The model's window onto a long conversation moves on in steps of this many
 * messages, not one per message. Between steps the start of what it sees stays
 * the same, so Model providers read it back from their prompt cache.
 */
const WINDOW_STEP = 20;

/** Bots, and chatting with them on the web Channel. Every route needs a signed-in Customer. */
export function botRoutes(deps: AppDeps) {
  const routes = new Hono<{ Variables: { customer: Customer } }>();

  for (const path of ["/models", "/computer-sizes", "/bots", "/bots/*"]) {
    routes.use(path, async (c, next) => {
      const customer = await sessionCustomer(c, deps);
      if (!customer) return apiError(c, 401, "signed_out", "Sign in to continue.");
      c.set("customer", customer);
      await next();
    });
  }

  routes.get("/models", (c) =>
    c.json({
      models: MODELS.map((model) => ({ ...model, available: deps.models[model.provider] !== null })),
      // Any OpenRouter model, by its OpenRouter name; and, self-hosted, models on a local server.
      openrouter: deps.models.openrouter !== null,
      local: deps.models.local !== null,
      // A Bot on one of these may search the web when a message asks it to.
      webSearch: webSearchProviders(deps),
    }),
  );

  routes.get("/computer-sizes", computerSizes(deps));

  routes.get("/bots", async (c) => c.json({ bots: await listBots(deps.db, c.get("customer").id) }));

  routes.post("/bots", async (c) => {
    const body = await jsonBody(c);
    const name = botName(body.name);
    if (!name) return invalidName(c);
    const model = chooseModel(body.model, deps.models);
    if ("code" in model) return apiError(c, 400, model.code, model.message);
    const bot = await createBot(deps.db, c.get("customer").id, { name, model: model.id }, deps.now());
    return c.json({ bot }, 201);
  });

  // Renames a Bot, switches its model or Driver model, or changes its instructions; its conversation stays as it is.
  routes.patch("/bots/:id", async (c) => {
    const body = await jsonBody(c);
    const name = body.name === undefined ? undefined : botName(body.name);
    if (name === null) return invalidName(c);
    const instructions = body.instructions === undefined ? undefined : botInstructions(body.instructions);
    if (instructions === null) {
      const limit = MAX_INSTRUCTIONS_LENGTH.toLocaleString("en-US");
      return apiError(c, 400, "invalid_instructions", `Write instructions of up to ${limit} characters.`);
    }
    const model = body.model === undefined ? undefined : chooseModel(body.model, deps.models);
    if (model && "code" in model) return apiError(c, 400, model.code, model.message);
    const driver = body.driverModel === undefined || body.driverModel === null ? body.driverModel : chooseDriverModel(body.driverModel, deps.models);
    if (driver && "code" in driver) return apiError(c, 400, driver.code, driver.message);
    if (name === undefined && model === undefined && driver === undefined && instructions === undefined) return invalidName(c);
    const bot = await updateBot(deps.db, c.get("customer").id, c.req.param("id"), {
      name,
      model: model?.id,
      driverModel: driver === undefined ? undefined : (driver?.id ?? null),
      instructions,
    });
    return bot ? c.json({ bot }) : botNotFound(c);
  });

  routes.delete("/bots/:id", async (c) => {
    if (!(await deleteBotComputer(deps, c.get("customer").id, c.req.param("id")))) {
      return apiError(c, 503, "computer_service_unavailable", "The Bot's Computer can't be deleted right now. Try again in a moment.");
    }
    const deleted = await deleteBot(deps.db, c.get("customer").id, c.req.param("id"));
    return deleted ? c.body(null, 204) : botNotFound(c);
  });

  routes.route("/bots/:id/computer", computerRoutes(deps));

  routes.get("/bots/:id/messages", async (c) => {
    const bot = await findBot(deps.db, c.get("customer").id, c.req.param("id"));
    if (!bot) return botNotFound(c);
    const conversationId = await webConversation(deps.db, bot.id, deps.now());
    return c.json({ messages: await listMessages(deps.db, conversationId) });
  });

  // A message may carry files, sent as base64 in its JSON: room for the most a message may attach.
  const messageSize = bodyLimit({
    maxSize: 20 * 1024 * 1024,
    onError: (c) => apiError(c, 413, "message_too_large", "That message is too big to send. Attach smaller files, or fewer at a time."),
  });

  routes.get("/bots/:id/attachments/:attachmentId", async (c) => {
    const file = await findAttachment(deps.db, c.get("customer").id, c.req.param("id"), c.req.param("attachmentId"));
    if (!file) return apiError(c, 404, "attachment_not_found", "There's no such Attachment.");
    // Images show in the page; anything else downloads. Served as data, never as a page.
    const inline = file.mediaType.startsWith("image/");
    return c.body(new Uint8Array(file.data), 200, {
      "content-type": file.mediaType === "text/plain" ? "text/plain; charset=utf-8" : file.mediaType,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      // Not kept in the browser's cache, where it would outlast signing out.
      "cache-control": "private, no-store",
    });
  });

  routes.post("/bots/:id/messages", messageSize, async (c) => {
    const bot = await findBot(deps.db, c.get("customer").id, c.req.param("id"));
    if (!bot) return botNotFound(c);
    const { content, thinkHarder, webSearch, attachments } = await jsonBody(c);
    const text = typeof content === "string" ? content.trim() : "";
    const files = readAttachments(attachments);
    if ("error" in files) return apiError(c, 400, "invalid_attachments", files.error);
    if ((!text && files.length === 0) || text.length > MAX_MESSAGE_LENGTH) {
      return apiError(c, 400, "invalid_message", `Write a message of up to ${MAX_MESSAGE_LENGTH.toLocaleString("en-US")} characters.`);
    }
    // The Bot's model may since have gone: its Model provider's key removed.
    const model = describeModel(bot.model);
    const adapter = model ? deps.models[model.provider] : null;
    if (!model || !adapter) {
      return apiError(c, 503, "model_unavailable", `${model?.name ?? bot.model} isn't available here right now.`);
    }
    const searchesTheWeb = webSearch === true;
    if (searchesTheWeb && !webSearchProviders(deps).includes(model.provider)) {
      return apiError(c, 400, "web_search_unavailable", `${model.name} can't search the web here. Send the message without web search.`);
    }

    const conversationId = await webConversation(deps.db, bot.id, deps.now());
    if (!(await startReplying(deps.db, conversationId, deps.now()))) {
      return apiError(c, 409, "bot_busy", `${bot.name} is still answering the last message.`);
    }
    let conversation;
    let sent: Message;
    try {
      // The message and its Attachments are kept together, or not at all.
      sent = await transaction(deps.db, async (client) => {
        const message = await addMessage(client, conversationId, "user", text, deps.now());
        return { ...message, attachments: await saveAttachments(client, message.id, files, deps.now()) };
      });
      conversation = await conversationForModel(deps.db, await recentMessages(deps.db, conversationId), {
        pdfs: !MODEL_PROVIDERS_WITHOUT_PDFS.has(model.provider),
      });
    } catch (error) {
      await stopReplying(deps.db, conversationId);
      throw error;
    }

    return streamSSE(c, async (stream) => {
      // If the browser leaves mid-reply, the reply still finishes and is saved, so a reload shows it.
      const send = async (event: string, data: unknown) => {
        if (!stream.aborted) await stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      };
      // The Customer's message as saved, so the page can link its Attachments straight away.
      await send("sent", { message: sent });
      let reply = "";
      let thinking = "";
      // A Task may search in more than one model call: every page once.
      const cited: { sources: WebSource[]; searchSuggestions?: string } = { sources: [] };
      // The reply holds the conversation for as long as it runs, however long that is.
      const renewing = setInterval(
        () => void renewReplying(deps.db, conversationId, deps.now()).catch((error: unknown) => console.error(error)),
        RENEW_REPLY_CLAIM_MS,
      );
      try {
        const driving = await drivingFor(deps, bot.id);
        const tools = driving ? { useComputer: (task: string) => driveComputer(deps, driving, task) } : undefined;
        const task = {
          botName: bot.name,
          instructions: bot.instructions,
          model: model.id,
          conversation,
          tools,
          thinking: thinkHarder === true ? ("deep" as const) : ("normal" as const),
          webSearch: searchesTheWeb,
        };
        // A Task may make several model calls; each one's thinking starts a new paragraph.
        let callEnded = false;
        for await (const event of runTask(adapter, task)) {
          if (event.type === "status") await send("status", { text: event.text });
          if (event.type === "done") callEnded = true;
          if (event.type === "thinking") {
            const text = thinking && callEnded ? `\n\n${event.text}` : event.text;
            callEnded = false;
            thinking += text;
            await send("thinking", { text });
          }
          if (event.type === "sources") {
            cited.sources = uniquePages([...cited.sources, ...event.sources]);
            cited.searchSuggestions = event.searchSuggestions ?? cited.searchSuggestions;
            await send("sources", { sources: event.sources, ...(event.searchSuggestions ? { searchSuggestions: event.searchSuggestions } : {}) });
          }
          if (event.type !== "text") continue;
          reply += event.text;
          await send("delta", { text: event.text });
        }
        // An empty reply would break the conversation for Model providers that refuse empty turns.
        if (!reply.trim()) throw new Error("The model's reply was empty.");
        const message = await addMessage(deps.db, conversationId, "assistant", reply, deps.now(), { thinking, cited });
        await send("done", { message });
      } catch (error) {
        console.error(`Bot ${bot.id}: the model call failed`, error);
        // Keep what the Customer already saw, so a reload shows the same conversation.
        if (reply) await addMessage(deps.db, conversationId, "assistant", reply, deps.now(), { thinking, cited });
        await send(
          "error",
          error instanceof ModelError && error.keyRefused
            ? keyRefused(deps, model)
            : { code: "model_failed", message: "The model didn't answer. Try again in a moment." },
        );
      } finally {
        clearInterval(renewing);
        await stopReplying(deps.db, conversationId);
      }
    });
  });

  return routes;
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

function botNotFound(c: Parameters<typeof apiError>[0]) {
  return apiError(c, 404, "bot_not_found", "There's no such Bot.");
}

/** The model a Bot is being set to, or why it can't be: unknown, or its Model provider isn't set up here. */
function chooseModel(id: unknown, adapters: ModelAdapters): ModelInfo | { code: string; message: string } {
  const model = describeModel(id);
  if (!model) return { code: "unknown_model", message: "Pick one of the listed models." };
  if (!adapters[model.provider]) return { code: "model_unavailable", message: `${model.name} isn't set up here. Pick another model.` };
  return model;
}

/** The Driver model a Bot is being set to, or why it can't be. */
function chooseDriverModel(id: unknown, adapters: ModelAdapters): ModelInfo | { code: string; message: string } {
  const listed = describeModel(id);
  if (listed && !DRIVER_PROVIDERS.has(listed.provider)) {
    return { code: "not_a_driver_model", message: "A Driver model comes from OpenAI, Anthropic or Google." };
  }
  return chooseModel(id, adapters);
}

function invalidName(c: Parameters<typeof apiError>[0]) {
  return apiError(c, 400, "invalid_name", `Give the Bot a name of up to ${MAX_NAME_LENGTH} characters.`);
}

function botName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= MAX_NAME_LENGTH ? name : null;
}

/** A Bot's instructions as given, trimmed; empty clears them. Null if they aren't text that fits. */
function botInstructions(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const instructions = value.trim();
  return instructions.length <= MAX_INSTRUCTIONS_LENGTH ? instructions : null;
}

const BOT_COLUMNS = `id, name, model, driver_model AS "driverModel", instructions, created_at AS "createdAt"`;

async function listBots(db: Db, customerId: string): Promise<Bot[]> {
  const { rows } = await db.query<Bot>(
    `SELECT ${BOT_COLUMNS} FROM bots WHERE customer_id = $1 ORDER BY created_at, id`,
    [customerId],
  );
  return rows;
}

async function createBot(db: Db, customerId: string, bot: { name: string; model: string }, now: Date): Promise<Bot> {
  const { rows } = await db.query<Bot>(
    `INSERT INTO bots (customer_id, name, model, created_at) VALUES ($1, $2, $3, $4) RETURNING ${BOT_COLUMNS}`,
    [customerId, bot.name, bot.model, now],
  );
  return rows[0]!;
}

async function findBot(db: Db, customerId: string, botId: string): Promise<Bot | null> {
  if (!UUID_PATTERN.test(botId)) return null;
  const { rows } = await db.query<Bot>(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = $1 AND customer_id = $2`, [
    botId,
    customerId,
  ]);
  return rows[0] ?? null;
}

async function updateBot(
  db: Db,
  customerId: string,
  botId: string,
  change: { name: string | undefined; model: string | undefined; driverModel?: string | null; instructions?: string },
): Promise<Bot | null> {
  if (!UUID_PATTERN.test(botId)) return null;
  const { rows } = await db.query<Bot>(
    `UPDATE bots SET name = COALESCE($3, name), model = COALESCE($4, model),
       driver_model = CASE WHEN $5 THEN $6 ELSE driver_model END,
       instructions = COALESCE($7, instructions)
     WHERE id = $1 AND customer_id = $2 RETURNING ${BOT_COLUMNS}`,
    [
      botId,
      customerId,
      change.name ?? null,
      change.model ?? null,
      change.driverModel !== undefined,
      change.driverModel ?? null,
      change.instructions ?? null,
    ],
  );
  return rows[0] ?? null;
}

async function deleteBot(db: Db, customerId: string, botId: string): Promise<boolean> {
  if (!UUID_PATTERN.test(botId)) return false;
  const { rowCount } = await db.query("DELETE FROM bots WHERE id = $1 AND customer_id = $2", [botId, customerId]);
  return rowCount === 1;
}

/** The Bot's one conversation on the web Channel, started on first use. */
async function webConversation(db: Db, botId: string, now: Date): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `WITH created AS (
       INSERT INTO conversations (bot_id, channel, created_at) VALUES ($1, 'web', $2)
       ON CONFLICT (bot_id) WHERE channel = 'web' DO NOTHING
       RETURNING id
     )
     SELECT id FROM created
     UNION ALL
     SELECT id FROM conversations WHERE bot_id = $1 AND channel = 'web'
     LIMIT 1`,
    [botId, now],
  );
  return rows[0]!.id;
}

const MESSAGE_COLUMNS = `id::text, role, content, thinking, sources, search_suggestions AS "searchSuggestions",
  ${ATTACHMENTS_COLUMN}, created_at AS "createdAt"`;

async function listMessages(db: Db, conversationId: string): Promise<Message[]> {
  const { rows } = await db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY messages.id`,
    [conversationId],
  );
  return rows;
}

/**
 * What the model sees of the conversation, oldest first: no more than the
 * latest MESSAGES_SENT_TO_MODEL, so a long conversation never outgrows it,
 * starting at a WINDOW_STEP and on the Customer's message, as Model providers expect.
 */
async function recentMessages(db: Db, conversationId: string): Promise<Message[]> {
  const { rows: counted } = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1",
    [conversationId],
  );
  const start = Math.ceil(Math.max(0, counted[0]!.count - MESSAGES_SENT_TO_MODEL) / WINDOW_STEP) * WINDOW_STEP;
  const { rows } = await db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY messages.id OFFSET $2 LIMIT $3`,
    [conversationId, start, MESSAGES_SENT_TO_MODEL],
  );
  while (rows[0]?.role === "assistant") rows.shift();
  return rows;
}

/**
 * How often a reply in progress renews its claim on the conversation. A claim not renewed for
 * 5 minutes is one whose server stopped mid-reply, and the next message may take it over.
 */
const RENEW_REPLY_CLAIM_MS = 60_000;

/** Claims the conversation for one reply. False while another reply is under way. */
async function startReplying(db: Db, conversationId: string, now: Date): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE conversations SET replying_since = $2
     WHERE id = $1 AND (replying_since IS NULL OR replying_since < $2::timestamptz - interval '5 minutes')`,
    [conversationId, now],
  );
  return rowCount === 1;
}

/** Renews a reply's claim, which it holds until it stops. */
async function renewReplying(db: Db, conversationId: string, now: Date): Promise<void> {
  await db.query("UPDATE conversations SET replying_since = $2 WHERE id = $1 AND replying_since IS NOT NULL", [conversationId, now]);
}

async function stopReplying(db: Db, conversationId: string): Promise<void> {
  await db.query("UPDATE conversations SET replying_since = NULL WHERE id = $1", [conversationId]);
}

async function addMessage(
  db: Pick<Db, "query">,
  conversationId: string,
  role: Message["role"],
  content: string,
  now: Date,
  extras: { thinking?: string; cited?: { sources: WebSource[]; searchSuggestions?: string } } = {},
): Promise<Message> {
  const { rows } = await db.query<Message>(
    `INSERT INTO messages (conversation_id, role, content, thinking, sources, search_suggestions, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      conversationId,
      role,
      content,
      extras.thinking || null,
      extras.cited?.sources.length ? JSON.stringify(extras.cited.sources) : null,
      extras.cited?.searchSuggestions ?? null,
      now,
    ],
  );
  return rows[0]!;
}
