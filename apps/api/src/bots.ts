import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { type Db, transaction } from "@kovobot/db";
import type { AppDeps } from "./app.ts";
import { findAttachment, readAttachments, saveAttachments } from "./attachments.ts";
import { sessionCustomer } from "./auth/sessions.ts";
import { computerRoutes, computerSizes, deleteBotComputer } from "./computer-routes.ts";
import { addMessage, listMessages, type Message, startReplying, stopReplying, webConversation } from "./conversations.ts";
import type { Customer } from "./customers.ts";
import { apiError, botNotFound, jsonBody, UUID_PATTERN } from "./http.ts";
import type { ModelAdapters, ModelProvider } from "./models/adapter.ts";
import { describeModel, MODELS, type ModelInfo } from "./models/catalog.ts";
import { mcpRoutes } from "./mcp.ts";
import { noteRoutes } from "./notes.ts";
import { runReply } from "./replies.ts";
import { isTimeZone, scheduleRoutes } from "./schedules.ts";
import { skillRoutes } from "./skills.ts";

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

const MAX_NAME_LENGTH = 80;
const MAX_INSTRUCTIONS_LENGTH = 8_000;
const MAX_MESSAGE_LENGTH = 20_000;

/** Bots, and chatting with them on the web Channel. Every route needs a signed-in Customer. */
export function botRoutes(deps: AppDeps) {
  const routes = new Hono<{ Variables: { customer: Customer } }>();

  for (const path of ["/models", "/computer-sizes", "/bots", "/bots/*", "/skills", "/skills/*", "/mcp/*"]) {
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
    const instructions = body.instructions === undefined ? undefined : readInstructions(body.instructions);
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
  routes.route("/", skillRoutes(deps));
  routes.route("/bots/:id/notes", noteRoutes(deps));
  routes.route("/bots/:id/schedules", scheduleRoutes(deps));
  routes.route("/", mcpRoutes(deps));

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
    const { content, thinkHarder, webSearch, attachments, timeZone } = await jsonBody(c);
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
    let sent: Message;
    try {
      // The message and its Attachments are kept together, or not at all.
      sent = await transaction(deps.db, async (client) => {
        const message = await addMessage(client, conversationId, "user", text, deps.now());
        return { ...message, attachments: await saveAttachments(client, message.id, files, deps.now()) };
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
      const thinking = thinkHarder === true ? ("deep" as const) : ("normal" as const);
      const customerTimeZone = await customerClock(deps.db, c.get("customer").id, timeZone);
      await runReply(deps, { bot, model, adapter, conversationId, thinking, webSearch: searchesTheWeb, timeZone: customerTimeZone }, send);
    });
  });

  return routes;
}

/**
 * The Customer's time zone: the one their browser sent with this message, kept for the Bot's
 * schedules; else the last one kept; null when there has never been one.
 */
async function customerClock(db: Db, customerId: string, given: unknown): Promise<string | null> {
  if (isTimeZone(given)) {
    await db.query("UPDATE customers SET time_zone = $2 WHERE id = $1 AND time_zone IS DISTINCT FROM $2", [customerId, given]);
    return given;
  }
  const { rows } = await db.query<{ timeZone: string | null }>(`SELECT time_zone AS "timeZone" FROM customers WHERE id = $1`, [customerId]);
  return rows[0]?.timeZone ?? null;
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
function readInstructions(value: unknown): string | null {
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

