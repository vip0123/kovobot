import { type Context, Hono } from "hono";
import type { Db } from "@kovobot/db";
import { ASLEEP_AFTER_MINUTES, COMPUTER_SIZES, type ComputerSize } from "@kovobot/plans";
import type { AppDeps } from "./app.ts";
import { type ComputerService, ComputerServiceError, type ComputerView } from "./computers.ts";
import type { Customer } from "./customers.ts";
import { CONTROL_LEASE_SECONDS } from "./driver.ts";
import { apiError, jsonBody, UUID_PATTERN } from "./http.ts";

interface BotComputer {
  botId: string;
  botName: string;
  /** The Computer service's id for the Bot's Computer; null until one is created. */
  computerId: string | null;
  /** How long the Computer may sit with nothing going on before it goes Asleep. */
  sleepAfterMinutes: number;
  /** When the Customer last took or renewed control of the mouse and keyboard; null when they handed back. */
  controlledAt: Date | null;
}

/** The Customer picks how long a Computer may sit idle: 15 minutes to 4 hours. */
const SLEEP_AFTER_MINUTES = { min: ASLEEP_AFTER_MINUTES, max: 4 * 60 };

type Env = { Variables: { customer: Customer } };
type Handler = (c: Context<Env>, bot: BotComputer, computers: ComputerService) => Promise<Response>;

/**
 * A Bot's one Computer, under /bots/:id/computer, which the Computer service runs.
 * Mounted inside the Bot routes, so every route has a signed-in Customer.
 */
export function computerRoutes(deps: AppDeps) {
  const routes = new Hono<Env>();

  /** The Customer's own Bot, Computers switched on, and the Computer service's refusals in the API's shape. */
  const forBot = (handle: Handler) => async (c: Context<Env>) => {
    const bot = await botComputer(deps.db, c.get("customer").id, c.req.param("id") ?? "");
    if (!bot) return apiError(c, 404, "bot_not_found", "There's no such Bot.");
    if (!deps.computers) return apiError(c, 503, "computers_off", "Computers aren't switched on here.");
    try {
      return await handle(c, bot, deps.computers);
    } catch (error) {
      if (error instanceof ComputerServiceError && (error.status === 400 || error.status === 409)) {
        return apiError(c, error.status, error.code, error.message);
      }
      console.error(error);
      return apiError(c, 503, "computer_service_unavailable", "Computers can't be reached right now. Try again in a moment.");
    }
  };

  /** The Bot's Computer as the Computer service has it; a Computer it no longer has is forgotten. */
  async function current(bot: BotComputer, computers: ComputerService): Promise<ComputerView | null> {
    if (!bot.computerId) return null;
    const computer = await computers.find(bot.computerId);
    if (!computer) await setComputer(deps.db, bot.botId, bot.computerId, null);
    return computer;
  }

  /** As `forBot`, for a Bot that has a Computer. */
  const forComputer = (handle: (c: Context<Env>, computer: ComputerView, computers: ComputerService, bot: BotComputer) => Promise<Response>) =>
    forBot(async (c, bot, computers) => {
      const computer = await current(bot, computers);
      if (!computer) return apiError(c, 404, "computer_not_found", `${bot.botName} has no Computer.`);
      return handle(c, computer, computers, bot);
    });

  /** A viewer or the Bot is using the Computer: it stays awake for the Bot's chosen time from now. */
  const touch = (bot: BotComputer, woken = false) =>
    deps.db.query(
      `UPDATE bots SET computer_active_at = $2${woken ? ", computer_asleep_at = NULL" : ""} WHERE id = $1`,
      [bot.botId, deps.now()],
    );

  /** What the browser sees of a Computer, as of now. */
  const view = (computer: ComputerView, bot: BotComputer) => ({
    state: computer.state,
    size: computer.size,
    sleepAfterMinutes: bot.sleepAfterMinutes,
    customerInControl: bot.controlledAt !== null && deps.now().getTime() - bot.controlledAt.getTime() < CONTROL_LEASE_SECONDS * 1000,
  });

  routes.get("/", forBot(async (c, bot, computers) => {
    const computer = await current(bot, computers);
    return c.json({ computer: computer && view(computer, bot) });
  }));

  routes.post("/", forBot(async (c, bot, computers) => {
    const size = sizeOf((await jsonBody(c)).size ?? "small");
    if (!size) return invalidSize(c);
    if (await current(bot, computers)) return apiError(c, 409, "computer_exists", `${bot.botName} already has a Computer.`);
    const computer = await computers.create(bot.botId, size);
    // Two requests at once could each create one: the first to record its Computer keeps it.
    if (!(await setComputer(deps.db, bot.botId, null, computer.id))) {
      await computers.remove(computer.id);
      return apiError(c, 409, "computer_exists", `${bot.botName} already has a Computer.`);
    }
    await touch(bot, true);
    return c.json({ computer: view(computer, bot) }, 201);
  }));

  // Resizes the Computer, or changes how long it may sit idle, or both.
  routes.patch("/", forComputer(async (c, computer, computers, bot) => {
    const body = await jsonBody(c);
    const size = body.size === undefined ? undefined : sizeOf(body.size);
    if (size === null) return invalidSize(c);
    const sleepAfter = body.sleepAfterMinutes;
    if (
      sleepAfter !== undefined &&
      !(Number.isInteger(sleepAfter) && (sleepAfter as number) >= SLEEP_AFTER_MINUTES.min && (sleepAfter as number) <= SLEEP_AFTER_MINUTES.max)
    ) {
      return apiError(
        c,
        400,
        "invalid_sleep_after",
        `Pick from ${SLEEP_AFTER_MINUTES.min} minutes to ${SLEEP_AFTER_MINUTES.max / 60} hours.`,
      );
    }
    if (size === undefined && sleepAfter === undefined) return invalidSize(c);
    const resized = size ? await computers.resize(computer.id, size) : computer;
    if (sleepAfter !== undefined) {
      await deps.db.query("UPDATE bots SET computer_sleep_after_minutes = $2 WHERE id = $1", [bot.botId, sleepAfter]);
    }
    return c.json({ computer: view(resized, { ...bot, sleepAfterMinutes: (sleepAfter as number | undefined) ?? bot.sleepAfterMinutes }) });
  }));

  routes.post("/start", forComputer(async (c, computer, computers, bot) => {
    const started = await computers.start(computer.id);
    await touch(bot, true);
    return c.json({ computer: view(started, bot) });
  }));

  routes.post("/shut-down", forComputer(async (c, computer, computers, bot) => {
    const shutDown = await computers.shutDown(computer.id);
    await deps.db.query("UPDATE bots SET computer_asleep_at = NULL WHERE id = $1", [bot.botId]);
    return c.json({ computer: view(shutDown, bot) });
  }));

  routes.delete("/", forComputer(async (c, computer, computers, bot) => {
    await computers.remove(computer.id);
    await setComputer(deps.db, bot.botId, computer.id, null);
    return c.body(null, 204);
  }));

  // The Customer takes the mouse and keyboard, or hands them back; a Bot at work waits meanwhile.
  // Taking control is a lease the page renews while it holds it, so a closed tab lets the Bot carry on.
  routes.post("/control", forComputer(async (c, computer, _computers, bot) => {
    const inControl = (await jsonBody(c)).inControl;
    if (typeof inControl !== "boolean") return apiError(c, 400, "invalid_control", "Say whether you take control: true or false.");
    const controlledAt = inControl ? deps.now() : null;
    await deps.db.query("UPDATE bots SET computer_controlled_at = $2 WHERE id = $1", [bot.botId, controlledAt]);
    await touch(bot);
    return c.json({ computer: view(computer, { ...bot, controlledAt }) });
  }));

  // A link to watch the Computer live, good for a minute; the browser opens it as a WebSocket.
  routes.post("/live-view", forComputer(async (c, computer, computers, bot) => {
    const { token, expiresAt } = await computers.liveViewToken(computer.id);
    await touch(bot);
    return c.json({ url: `/api/bots/${bot.botId}/computer/live?token=${encodeURIComponent(token)}`, expiresAt });
  }));

  // Only `liveViewUpgrade` reaches this, for a browser's WebSocket: it checks the Customer, and
  // that the page is ours, before the live view is relayed. The Computer service checks the token.
  // It is asked again while the view stays open, which keeps the Computer awake.
  routes.get("/live", forComputer(async (c, computer, _computers, bot) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return apiError(c, 426, "upgrade_required", "Open the live view as a WebSocket.");
    }
    if (c.req.header("origin") !== deps.config.appUrl) return apiError(c, 403, "cross_site", "This request came from another website.");
    await touch(bot);
    return c.json({ computerId: computer.id, token: c.req.query("token") ?? "" });
  }));

  return routes;
}

/**
 * Deletes a Bot's Computer before the Bot goes. Where Computers are switched off, any
 * Computer is left to the Operator. False when the Computer service can't be reached.
 */
export async function deleteBotComputer(deps: AppDeps, customerId: string, botId: string): Promise<boolean> {
  const bot = await botComputer(deps.db, customerId, botId);
  if (!bot?.computerId || !deps.computers) return true;
  try {
    await deps.computers.remove(bot.computerId);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

/** The sizes this install's Computer service can give, for the size picker. */
export function computerSizes(deps: AppDeps) {
  return async (c: Context) => {
    if (!deps.computers) return apiError(c, 503, "computers_off", "Computers aren't switched on here.");
    try {
      return c.json({ sizes: await deps.computers.sizes() });
    } catch (error) {
      console.error(error);
      return apiError(c, 503, "computer_service_unavailable", "Computers can't be reached right now. Try again in a moment.");
    }
  };
}



function sizeOf(raw: unknown): ComputerSize | null {
  return COMPUTER_SIZES.find((size) => size.size === raw)?.size ?? null;
}

function invalidSize(c: Context) {
  return apiError(c, 400, "invalid_size", `Pick a size: ${COMPUTER_SIZES.map((size) => size.name).join(", ")}.`);
}

async function botComputer(db: Db, customerId: string, botId: string): Promise<BotComputer | null> {
  if (!UUID_PATTERN.test(botId)) return null;
  const { rows } = await db.query<BotComputer>(
    `SELECT id AS "botId", name AS "botName", computer_id AS "computerId", computer_sleep_after_minutes AS "sleepAfterMinutes",
       computer_controlled_at AS "controlledAt"
     FROM bots WHERE id = $1 AND customer_id = $2`,
    [botId, customerId],
  );
  return rows[0] ?? null;
}

/** Records the Bot's Computer, only if it is still `expected`; false when another change came first. */
async function setComputer(db: Db, botId: string, expected: string | null, computerId: string | null): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE bots SET computer_id = $3 WHERE id = $1 AND computer_id IS NOT DISTINCT FROM $2",
    [botId, expected, computerId],
  );
  return rowCount === 1;
}
