import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Db } from "@kovobot/db";
import { runTurn } from "./agent.ts";
import type { AppDeps } from "./app.ts";
import { sessionCustomer } from "./auth/sessions.ts";
import type { Customer } from "./customers.ts";
import { apiError, jsonBody } from "./http.ts";
import { findModel, MODELS } from "./models/catalog.ts";

export interface Bot {
  id: string;
  name: string;
  model: string;
  createdAt: Date;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

const MAX_NAME_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 20_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bots, and chatting with them on the web Channel. Every route needs a signed-in Customer. */
export function botRoutes(deps: AppDeps) {
  const routes = new Hono<{ Variables: { customer: Customer } }>();

  for (const path of ["/models", "/bots", "/bots/*"]) {
    routes.use(path, async (c, next) => {
      const customer = await sessionCustomer(c, deps);
      if (!customer) return apiError(c, 401, "signed_out", "Sign in to continue.");
      c.set("customer", customer);
      await next();
    });
  }

  routes.get("/models", (c) =>
    c.json({ models: MODELS.map((model) => ({ ...model, available: deps.models[model.provider] !== null })) }),
  );

  routes.get("/bots", async (c) => c.json({ bots: await listBots(deps.db, c.get("customer").id) }));

  routes.post("/bots", async (c) => {
    const body = await jsonBody(c);
    const name = botName(body.name);
    if (!name) return apiError(c, 400, "invalid_name", `Give the Bot a name of up to ${MAX_NAME_LENGTH} characters.`);
    const model = findModel(body.model);
    if (!model) return apiError(c, 400, "unknown_model", "Pick one of the listed models.");
    const bot = await createBot(deps.db, c.get("customer").id, { name, model: model.id }, deps.now());
    return c.json({ bot }, 201);
  });

  routes.patch("/bots/:id", async (c) => {
    const name = botName((await jsonBody(c)).name);
    if (!name) return apiError(c, 400, "invalid_name", `Give the Bot a name of up to ${MAX_NAME_LENGTH} characters.`);
    const bot = await renameBot(deps.db, c.get("customer").id, c.req.param("id"), name);
    return bot ? c.json({ bot }) : botNotFound(c);
  });

  routes.delete("/bots/:id", async (c) => {
    const deleted = await deleteBot(deps.db, c.get("customer").id, c.req.param("id"));
    return deleted ? c.body(null, 204) : botNotFound(c);
  });

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
    const model = findModel(bot.model);
    const adapter = model ? deps.models[model.provider] : null;
    if (!model || !adapter) {
      return apiError(c, 503, "model_unavailable", `${model?.name ?? bot.model} isn't available here right now.`);
    }

    const conversationId = await webConversation(deps.db, bot.id, deps.now());
    await addMessage(deps.db, conversationId, "user", text, deps.now());
    const conversation = (await listMessages(deps.db, conversationId)).map(({ role, content }) => ({ role, content }));

    return streamSSE(c, async (stream) => {
      // If the browser leaves mid-reply, the reply still finishes and is saved, so a reload shows it.
      const send = async (event: string, data: unknown) => {
        if (!stream.aborted) await stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      };
      let reply = "";
      try {
        for await (const event of runTurn(adapter, { botName: bot.name, model: model.id, conversation })) {
          if (event.type !== "text") continue;
          reply += event.text;
          await send("delta", { text: event.text });
        }
        const message = await addMessage(deps.db, conversationId, "assistant", reply, deps.now());
        await send("done", { message });
      } catch (error) {
        console.error(`Bot ${bot.id}: the model call failed`, error);
        await send("error", { code: "model_failed", message: "The model didn't answer. Try again in a moment." });
      }
    });
  });

  return routes;
}

function botNotFound(c: Parameters<typeof apiError>[0]) {
  return apiError(c, 404, "bot_not_found", "There's no such Bot.");
}

function botName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= MAX_NAME_LENGTH ? name : null;
}

const BOT_COLUMNS = `id, name, model, created_at AS "createdAt"`;

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

async function renameBot(db: Db, customerId: string, botId: string, name: string): Promise<Bot | null> {
  if (!UUID_PATTERN.test(botId)) return null;
  const { rows } = await db.query<Bot>(
    `UPDATE bots SET name = $3 WHERE id = $1 AND customer_id = $2 RETURNING ${BOT_COLUMNS}`,
    [botId, customerId, name],
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

async function listMessages(db: Db, conversationId: string): Promise<Message[]> {
  const { rows } = await db.query<Message>(
    `SELECT id::text, role, content, created_at AS "createdAt" FROM messages
     WHERE conversation_id = $1 ORDER BY id`,
    [conversationId],
  );
  return rows;
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
     RETURNING id::text, role, content, created_at AS "createdAt"`,
    [conversationId, role, content, now],
  );
  return rows[0]!;
}
