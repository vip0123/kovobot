import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Db } from "@kovobot/db";
import { runTask } from "./agent.ts";
import type { AppDeps } from "./app.ts";
import { sessionCustomer } from "./auth/sessions.ts";
import { computerRoutes, computerSizes, deleteBotComputer } from "./computer-routes.ts";
import type { Customer } from "./customers.ts";
import { apiError, jsonBody, UUID_PATTERN } from "./http.ts";
import type { ModelAdapters } from "./models/adapter.ts";
import { describeModel, MODELS, type ModelInfo } from "./models/catalog.ts";

export interface Bot {
  id: string;
  name: string;
  model: string;
  /** The model the Bot operates its Computer with; null until the Customer picks one. */
  driverModel: string | null;
  createdAt: Date;
}

/** Driver models come only from the Model providers with a computer-use tool. */
const DRIVER_PROVIDERS = new Set(["openai", "anthropic", "google"]);

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

const MAX_NAME_LENGTH = 80;
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

  // Renames a Bot, switches its model or its Driver model; its conversation stays as it is.
  routes.patch("/bots/:id", async (c) => {
    const body = await jsonBody(c);
    const name = body.name === undefined ? undefined : botName(body.name);
    if (name === null) return invalidName(c);
    const model = body.model === undefined ? undefined : chooseModel(body.model, deps.models);
    if (model && "code" in model) return apiError(c, 400, model.code, model.message);
    const driver = body.driverModel === undefined || body.driverModel === null ? body.driverModel : chooseDriverModel(body.driverModel, deps.models);
    if (driver && "code" in driver) return apiError(c, 400, driver.code, driver.message);
    if (name === undefined && model === undefined && driver === undefined) return invalidName(c);
    const bot = await updateBot(deps.db, c.get("customer").id, c.req.param("id"), {
      name,
      model: model?.id,
      driverModel: driver === undefined ? undefined : (driver?.id ?? null),
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

  routes.post("/bots/:id/messages", async (c) => {
    const bot = await findBot(deps.db, c.get("customer").id, c.req.param("id"));
    if (!bot) return botNotFound(c);
    const { content } = await jsonBody(c);
    const text = typeof content === "string" ? content.trim() : "";
    if (!text || text.length > MAX_MESSAGE_LENGTH) {
      return apiError(c, 400, "invalid_message", `Write a message of up to ${MAX_MESSAGE_LENGTH.toLocaleString("en-US")} characters.`);
    }
    // The Bot's model may since have gone: its Model provider's key removed.
    const model = describeModel(bot.model);
    const adapter = model ? deps.models[model.provider] : null;
    if (!model || !adapter) {
      return apiError(c, 503, "model_unavailable", `${model?.name ?? bot.model} isn't available here right now.`);
    }

    const conversationId = await webConversation(deps.db, bot.id, deps.now());
    if (!(await startReplying(deps.db, conversationId, deps.now()))) {
      return apiError(c, 409, "bot_busy", `${bot.name} is still answering the last message.`);
    }
    let conversation;
    try {
      await addMessage(deps.db, conversationId, "user", text, deps.now());
      conversation = (await recentMessages(deps.db, conversationId)).map(({ role, content }) => ({ role, content }));
    } catch (error) {
      await stopReplying(deps.db, conversationId);
      throw error;
    }

    return streamSSE(c, async (stream) => {
      // If the browser leaves mid-reply, the reply still finishes and is saved, so a reload shows it.
      const send = async (event: string, data: unknown) => {
        if (!stream.aborted) await stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      };
      let reply = "";
      try {
        for await (const event of runTask(adapter, { botName: bot.name, model: model.id, conversation })) {
          if (event.type !== "text") continue;
          reply += event.text;
          await send("delta", { text: event.text });
        }
        // An empty reply would break the conversation for Model providers that refuse empty turns.
        if (!reply.trim()) throw new Error("The model's reply was empty.");
        const message = await addMessage(deps.db, conversationId, "assistant", reply, deps.now());
        await send("done", { message });
      } catch (error) {
        console.error(`Bot ${bot.id}: the model call failed`, error);
        // Keep what the Customer already saw, so a reload shows the same conversation.
        if (reply) await addMessage(deps.db, conversationId, "assistant", reply, deps.now());
        await send("error", { code: "model_failed", message: "The model didn't answer. Try again in a moment." });
      } finally {
        await stopReplying(deps.db, conversationId);
      }
    });
  });

  return routes;
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

const BOT_COLUMNS = `id, name, model, driver_model AS "driverModel", created_at AS "createdAt"`;

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
  change: { name: string | undefined; model: string | undefined; driverModel?: string | null },
): Promise<Bot | null> {
  if (!UUID_PATTERN.test(botId)) return null;
  const { rows } = await db.query<Bot>(
    `UPDATE bots SET name = COALESCE($3, name), model = COALESCE($4, model),
       driver_model = CASE WHEN $5 THEN $6 ELSE driver_model END
     WHERE id = $1 AND customer_id = $2 RETURNING ${BOT_COLUMNS}`,
    [botId, customerId, change.name ?? null, change.model ?? null, change.driverModel !== undefined, change.driverModel ?? null],
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

const MESSAGE_COLUMNS = `id::text, role, content, created_at AS "createdAt"`;

async function listMessages(db: Db, conversationId: string): Promise<Message[]> {
  const { rows } = await db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY id`,
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
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY id OFFSET $2 LIMIT $3`,
    [conversationId, start, MESSAGES_SENT_TO_MODEL],
  );
  while (rows[0]?.role === "assistant") rows.shift();
  return rows;
}

/** Claims the conversation for one reply. False while another reply is under way. */
async function startReplying(db: Db, conversationId: string, now: Date): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE conversations SET replying_since = $2
     WHERE id = $1 AND (replying_since IS NULL OR replying_since < $2::timestamptz - interval '5 minutes')`,
    [conversationId, now],
  );
  return rowCount === 1;
}

async function stopReplying(db: Db, conversationId: string): Promise<void> {
  await db.query("UPDATE conversations SET replying_since = NULL WHERE id = $1", [conversationId]);
}

async function addMessage(
  db: Db,
  conversationId: string,
  role: Message["role"],
  content: string,
  now: Date,
): Promise<Message> {
  const { rows } = await db.query<Message>(
    `INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4)
     RETURNING ${MESSAGE_COLUMNS}`,
    [conversationId, role, content, now],
  );
  return rows[0]!;
}
