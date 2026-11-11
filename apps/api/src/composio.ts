import { Hono } from "hono";
import { type Db, transaction } from "@kovobot/db";
import { actionKind, type ActionOutcome, type ConnectedTool } from "./actions.ts";
import type { AppDeps } from "./app.ts";
import { type Customer, ownsBot, withBotHeld } from "./customers.ts";
import { apiError, botNotFound, jsonBody, UUID_PATTERN } from "./http.ts";
import type { FunctionTool } from "./models/adapter.ts";

/** Composio's platform API (ADR 0010). Tool calls with no version get each toolkit's latest. */
export const COMPOSIO_API_URL = "https://backend.composio.dev/api/v3.1";

/** One of the apps Composio connects, as its catalogue lists it. */
export interface ComposioToolkit {
  slug: string;
  name: string;
  description: string;
  /** Usable without signing in to anything, such as a public news feed. */
  noAuth: boolean;
}

/** One action of an app, as Composio describes it. */
export interface ComposioTool {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
  tags: string[];
  inputSchema: FunctionTool["parameters"];
}

export interface ComposioAccount {
  id: string;
  status: "INITIALIZING" | "INITIATED" | "ACTIVE" | "FAILED" | "EXPIRED" | "INACTIVE" | "REVOKED";
  /** The name Composio gives the account, to tell several of one app apart. */
  label: string | null;
}

/** What Kovobot asks of Composio: the real service, or a local fake in tests. */
export interface Composio {
  toolkits(search: string): Promise<ComposioToolkit[]>;
  toolkit(slug: string): Promise<ComposioToolkit | null>;
  /** Composio's own sign-in for an app (its managed auth config), set up the first time; null where it has none. */
  managedAuthConfig(toolkit: string): Promise<string | null>;
  /** Starts connecting an account: the account, and where the Customer signs in. */
  link(authConfigId: string, userId: string, callbackUrl: string): Promise<{ accountId: string; signInUrl: string }>;
  account(id: string): Promise<ComposioAccount | null>;
  removeAccount(id: string): Promise<void>;
  tools(toolkit: string, query: string, limit: number): Promise<ComposioTool[]>;
  tool(slug: string): Promise<ComposioTool | null>;
  execute(
    slug: string,
    request: { userId: string; accountId: string | null; arguments: Record<string, unknown> },
  ): Promise<{ successful: boolean; data: unknown; error: string | null }>;
}

/** Composio refused or failed a request; its own message, for the Customer or the model. */
export class ComposioError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ComposioError";
    this.status = status;
  }
}

/** One HTTP attempt per call, like every outside service here (ADR 0004). */
export function createComposioClient(options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }): Composio {
  const { apiKey, baseUrl = COMPOSIO_API_URL, fetch = globalThis.fetch } = options;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "x-api-key": apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (response.status === 404) return null;
    // A refused key: Composio's own words would echo a piece of the key, so they're dropped.
    if (response.status === 401 || response.status === 403) throw new ComposioError(response.status, "Composio refused the key.");
    if (!response.ok) {
      let message = `Composio answered ${response.status}.`;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // Not JSON: keep the status.
      }
      throw new ComposioError(response.status, message);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  const toolkitOf = (item: RawToolkit): ComposioToolkit => {
    const modes = (item.auth_config_details ?? []).map((detail) => detail.mode);
    return {
      slug: item.slug,
      name: item.name,
      description: (item.meta?.description ?? "").slice(0, 300),
      noAuth: item.no_auth === true || (modes.length > 0 && modes.every((mode) => mode === "NO_AUTH")),
    };
  };
  const toolOf = (item: RawTool): ComposioTool => ({
    slug: item.slug,
    name: item.name,
    description: item.description ?? "",
    toolkit: item.toolkit.slug,
    tags: item.tags ?? [],
    inputSchema: (item.input_parameters ?? { type: "object", properties: {} }) as FunctionTool["parameters"],
  });
  const query = (fields: Record<string, string | number>) =>
    new URLSearchParams(Object.entries(fields).map(([key, value]): [string, string] => [key, String(value)]));

  return {
    async toolkits(search) {
      const found = await call<{ items: RawToolkit[] }>("GET", `/toolkits?${query({ search, limit: 20, sort_by: "usage" })}`);
      return (found?.items ?? []).map(toolkitOf);
    },
    async toolkit(slug) {
      const found = await call<RawToolkit>("GET", `/toolkits/${encodeURIComponent(slug)}`);
      return found ? toolkitOf(found) : null;
    },
    async managedAuthConfig(toolkit) {
      const listed = await call<{ items: Array<{ id: string; status: string }> }>(
        "GET",
        `/auth_configs?${query({ toolkit_slug: toolkit, is_composio_managed: "true" })}`,
      );
      const enabled = listed?.items.find((config) => config.status === "ENABLED");
      if (enabled) return enabled.id;
      try {
        const made = await call<{ auth_config: { id: string } }>("POST", "/auth_configs", {
          toolkit: { slug: toolkit },
          auth_config: { type: "use_composio_managed_auth" },
        });
        return made?.auth_config.id ?? null;
      } catch (error) {
        // An app Composio hosts no sign-in for: a bad request, not an outage.
        if (error instanceof ComposioError && error.status === 400) return null;
        throw error;
      }
    },
    async link(authConfigId, userId, callbackUrl) {
      const linked = await call<{ connected_account_id: string; redirect_url: string }>("POST", "/connected_accounts/link", {
        auth_config_id: authConfigId,
        user_id: userId,
        callback_url: callbackUrl,
      });
      if (!linked) throw new ComposioError(404, "Composio doesn't know that app's sign-in.");
      return { accountId: linked.connected_account_id, signInUrl: linked.redirect_url };
    },
    async account(id) {
      const found = await call<{ id: string; status: ComposioAccount["status"]; alias?: string | null; word_id?: string | null }>(
        "GET",
        `/connected_accounts/${encodeURIComponent(id)}`,
      );
      return found ? { id: found.id, status: found.status, label: found.alias || found.word_id || null } : null;
    },
    async removeAccount(id) {
      await call("DELETE", `/connected_accounts/${encodeURIComponent(id)}`);
    },
    async tools(toolkit, search, limit) {
      const found = await call<{ items: RawTool[] }>("GET", `/tools?${query({ toolkit_slug: toolkit, query: search, limit })}`);
      return (found?.items ?? []).slice(0, limit).map(toolOf);
    },
    async tool(slug) {
      const found = await call<RawTool>("GET", `/tools/${encodeURIComponent(slug)}`);
      return found ? toolOf(found) : null;
    },
    async execute(slug, request) {
      const ran = await call<{ successful: boolean; data: unknown; error: string | null }>("POST", `/tools/execute/${encodeURIComponent(slug)}`, {
        user_id: request.userId,
        ...(request.accountId ? { connected_account_id: request.accountId } : {}),
        arguments: request.arguments,
      });
      if (!ran) throw new ComposioError(404, `Composio has no action called ${slug}.`);
      return ran;
    },
  };
}

interface RawToolkit {
  slug: string;
  name: string;
  no_auth?: boolean;
  auth_config_details?: Array<{ mode: string }>;
  meta?: { description?: string };
}

interface RawTool {
  slug: string;
  name: string;
  description?: string;
  toolkit: { slug: string };
  tags?: string[];
  input_parameters?: unknown;
}

/** A Customer's account on one app, as they see it. */
export interface ConnectedApp {
  id: string;
  toolkit: string;
  name: string;
  /** Which account, when there are several for one app. */
  label: string | null;
  state: "connecting" | "connected" | "failed";
  createdAt: Date;
}

interface StoredApp extends ConnectedApp {
  customerId: string;
  composioAccountId: string | null;
}

/** A Connected app's columns, read from `from`: the table, or its alias in a join. */
const appColumns = (from: string) =>
  `${from}.id, ${from}.customer_id AS "customerId", ${from}.toolkit, ${from}.app_name AS name, ${from}.label, ${from}.state,
   ${from}.composio_account_id AS "composioAccountId", ${from}.created_at AS "createdAt"`;
const APP_COLUMNS = appColumns("connected_apps");

/** The most Connected apps a Customer keeps, and the most a Bot is given. */
export const MAX_CONNECTED_APPS = 50;
export const MAX_APPS_PER_BOT = 20;
/** How many of an app's actions one search shows the model. */
const ACTIONS_PER_SEARCH = 8;
/** The most of an action's result the model sees. */
const MAX_RESULT = 20_000;

const view = ({ id, toolkit, name, label, state, createdAt }: StoredApp): ConnectedApp => ({ id, toolkit, name, label, state, createdAt });

type Env = { Variables: { customer: Customer } };

/**
 * Connected apps: under /apps, a Customer connects their accounts through Composio's hosted
 * sign-in, several to an app if they like, and removes them; under /bots/:id/apps, they give each
 * to the Bots they choose. Mounted inside the signed-in routes. Off without a Composio key.
 */
export function appRoutes(deps: AppDeps) {
  const routes = new Hono<Env>();
  const off = (c: Parameters<typeof apiError>[0]) =>
    apiError(
      c,
      404,
      "apps_off",
      deps.config.mode === "hosted"
        ? "Connected apps aren't available yet."
        : "Connected apps need a Composio key: whoever runs this Kovobot sets COMPOSIO_API_KEY. Bots can still use MCP servers.",
    );
  const failed = (c: Parameters<typeof apiError>[0], error: unknown) => {
    if (!(error instanceof ComposioError)) throw error;
    // Hosted, the key is ours, so the Customer just hears it's unavailable; self-hosted, it's the Operator's to fix.
    if (error.status === 401 || error.status === 403) {
      return deps.config.mode === "hosted"
        ? apiError(c, 503, "composio_refused_key", "Connected apps aren't available right now. Try again later.")
        : apiError(c, 503, "composio_refused_key", "Composio refused this Kovobot's key: whoever runs it needs to fix COMPOSIO_API_KEY.");
    }
    return apiError(c, 503, "composio_failed", `Composio didn't manage that: ${error.message}`);
  };

  routes.get("/apps", async (c) => {
    if (!deps.composio) return off(c);
    const apps = await customerApps(deps.db, c.get("customer").id);
    // A sign-in left before it came back: ask Composio how it went.
    for (const app of apps.filter((each) => each.state === "connecting").slice(0, 10)) Object.assign(app, await refresh(deps, app));
    return c.json({ apps: apps.map(view) });
  });

  routes.get("/apps/catalog", async (c) => {
    if (!deps.composio) return off(c);
    const search = (c.req.query("search") ?? "").trim().slice(0, 100);
    try {
      return c.json({ toolkits: await deps.composio.toolkits(search) });
    } catch (error) {
      return failed(c, error);
    }
  });

  routes.post("/apps", async (c) => {
    const composio = deps.composio;
    if (!composio) return off(c);
    const slug = (await jsonBody(c)).toolkit;
    if (typeof slug !== "string" || !/^[a-z0-9_-]{1,100}$/i.test(slug)) return apiError(c, 400, "invalid_app", "Pick an app to connect.");
    const customer = c.get("customer");
    let toolkit: ComposioToolkit | null;
    let authConfigId: string | null = null;
    try {
      toolkit = await composio.toolkit(slug);
      if (toolkit && !toolkit.noAuth) authConfigId = await composio.managedAuthConfig(toolkit.slug);
    } catch (error) {
      return failed(c, error);
    }
    if (!toolkit) return apiError(c, 404, "app_not_found", "Composio has no such app.");
    if (!toolkit.noAuth && !authConfigId) {
      return apiError(c, 400, "app_sign_in_unavailable", `Composio doesn't host sign-in for ${toolkit.name}, so it can't be connected here yet.`);
    }
    const added = await addApp(deps, customer.id, toolkit);
    if (!added) return apiError(c, 409, "too_many_apps", `You can connect up to ${MAX_CONNECTED_APPS} apps. Remove one first.`);
    if (toolkit.noAuth) return c.json({ app: view(added) }, 201);
    try {
      const callback = `${deps.config.apiUrl}/api/apps/callback?app=${added.id}`;
      const { accountId, signInUrl } = await composio.link(authConfigId!, customer.id, callback);
      await deps.db.query("UPDATE connected_apps SET composio_account_id = $2 WHERE id = $1", [added.id, accountId]);
      return c.json({ app: view(added), signInUrl }, 201);
    } catch (error) {
      await deps.db.query("DELETE FROM connected_apps WHERE id = $1", [added.id]);
      return failed(c, error);
    }
  });

  // Composio's hosted sign-in sends the Customer back here. What it says on the way back isn't
  // trusted: the account's state comes from Composio itself.
  routes.get("/apps/callback", async (c) => {
    const back = (outcome: string, name: string) => c.redirect(`${deps.config.appUrl}/apps?${outcome}=${encodeURIComponent(name)}`, 302);
    const id = c.req.query("app") ?? "";
    const app = deps.composio && UUID_PATTERN.test(id) ? await findApp(deps.db, c.get("customer").id, id) : null;
    if (!app) return back("failed", "that app");
    const now = await refresh(deps, app);
    return back(now.state === "connected" ? "connected" : "failed", app.name);
  });

  routes.delete("/apps/:appId", async (c) => {
    const id = c.req.param("appId");
    const app = UUID_PATTERN.test(id) ? await findApp(deps.db, c.get("customer").id, id) : null;
    if (!app) return apiError(c, 404, "app_not_found", "There's no such Connected app.");
    if (app.composioAccountId && deps.composio) {
      try {
        await deps.composio.removeAccount(app.composioAccountId);
      } catch (error) {
        return failed(c, error);
      }
    }
    await deps.db.query("DELETE FROM connected_apps WHERE id = $1", [app.id]);
    return c.body(null, 204);
  });

  routes.get("/bots/:id/apps", async (c) => {
    if (!(await ownsBot(deps.db, c.get("customer").id, c.req.param("id")))) return botNotFound(c);
    return c.json({ apps: (await botApps(deps.db, c.req.param("id"))).map(view) });
  });

  // Gives a Connected app to a Bot; giving one it already has changes nothing.
  routes.put("/bots/:id/apps/:appId", async (c) => {
    const [botId, appId] = [c.req.param("id"), c.req.param("appId")];
    const customerId = c.get("customer").id;
    if (!(await ownsBot(deps.db, customerId, botId))) return botNotFound(c);
    const app = UUID_PATTERN.test(appId) ? await findApp(deps.db, customerId, appId) : null;
    if (!app) return apiError(c, 404, "app_not_found", "There's no such Connected app.");
    const { rowCount } = await withBotHeld(deps.db, botId, (client) =>
      client.query(
        `INSERT INTO bot_connected_apps (bot_id, connected_app_id)
         SELECT $1, $2 WHERE (SELECT count(*) FROM bot_connected_apps WHERE bot_id = $1) < $3
         ON CONFLICT DO NOTHING`,
        [botId, appId, MAX_APPS_PER_BOT],
      ),
    );
    if (rowCount === 0) {
      const { rowCount: had } = await deps.db.query("SELECT 1 FROM bot_connected_apps WHERE bot_id = $1 AND connected_app_id = $2", [botId, appId]);
      if (had === 0) return apiError(c, 409, "too_many_apps", `A Bot can have up to ${MAX_APPS_PER_BOT} Connected apps. Take one away first.`);
    }
    return c.body(null, 204);
  });

  routes.delete("/bots/:id/apps/:appId", async (c) => {
    const [botId, appId] = [c.req.param("id"), c.req.param("appId")];
    if (!(await ownsBot(deps.db, c.get("customer").id, botId))) return botNotFound(c);
    if (UUID_PATTERN.test(appId)) await deps.db.query("DELETE FROM bot_connected_apps WHERE bot_id = $1 AND connected_app_id = $2", [botId, appId]);
    return c.body(null, 204);
  });

  return routes;
}

async function customerApps(db: Db, customerId: string): Promise<StoredApp[]> {
  const { rows } = await db.query<StoredApp>(`SELECT ${APP_COLUMNS} FROM connected_apps WHERE customer_id = $1 ORDER BY created_at, id`, [customerId]);
  return rows;
}

async function findApp(db: Db, customerId: string, id: string): Promise<StoredApp | null> {
  const { rows } = await db.query<StoredApp>(`SELECT ${APP_COLUMNS} FROM connected_apps WHERE id = $1 AND customer_id = $2`, [id, customerId]);
  return rows[0] ?? null;
}

/** The Connected apps a Bot was given that are ready to use. */
async function botApps(db: Db, botId: string): Promise<StoredApp[]> {
  const { rows } = await db.query<StoredApp>(
    `SELECT ${appColumns("a")} FROM connected_apps a
     JOIN bot_connected_apps g ON g.connected_app_id = a.id
     WHERE g.bot_id = $1 AND a.state = 'connected' ORDER BY a.created_at, a.id`,
    [botId],
  );
  return rows;
}

/**
 * Adds an app, within the Customer's limit, holding the Customer's row while it counts. An app
 * that needs no sign-in is connected at once, and once.
 */
async function addApp(deps: AppDeps, customerId: string, toolkit: ComposioToolkit): Promise<StoredApp | null> {
  return transaction(deps.db, async (client) => {
    await client.query("SELECT 1 FROM customers WHERE id = $1 FOR NO KEY UPDATE", [customerId]);
    if (toolkit.noAuth) {
      const { rows } = await client.query<StoredApp>(`SELECT ${APP_COLUMNS} FROM connected_apps WHERE customer_id = $1 AND toolkit = $2`, [
        customerId,
        toolkit.slug,
      ]);
      if (rows[0]) return rows[0];
    }
    const now = deps.now();
    const { rows } = await client.query<StoredApp>(
      `INSERT INTO connected_apps (customer_id, toolkit, app_name, state, created_at, updated_at)
       SELECT $1, $2, $3, $4, $5, $5 WHERE (SELECT count(*) FROM connected_apps WHERE customer_id = $1) < $6
       RETURNING ${APP_COLUMNS}`,
      [customerId, toolkit.slug, toolkit.name, toolkit.noAuth ? "connected" : "connecting", now, MAX_CONNECTED_APPS],
    );
    return rows[0] ?? null;
  });
}

/** Asks Composio how an app's sign-in went, and keeps the answer. */
async function refresh(deps: AppDeps, app: StoredApp): Promise<StoredApp> {
  if (!deps.composio || !app.composioAccountId || app.state === "connected") return app;
  let account: ComposioAccount | null;
  try {
    account = await deps.composio.account(app.composioAccountId);
  } catch {
    return app;
  }
  const state = account?.status === "ACTIVE" ? "connected" : !account || ["FAILED", "EXPIRED", "REVOKED"].includes(account.status) ? "failed" : app.state;
  if (state === app.state && (account?.label ?? null) === app.label) return app;
  const { rows } = await deps.db.query<StoredApp>(
    `UPDATE connected_apps SET state = $2, label = $3, updated_at = $4 WHERE id = $1 RETURNING ${APP_COLUMNS}`,
    [app.id, state, account?.label ?? app.label, deps.now()],
  );
  return rows[0] ?? app;
}

/** Leading words of an action's name that only read. */
const READING = /^(get|list|fetch|search|find|read|retrieve|lookup|query|count|describe|check|view|show|download)$/;

/**
 * Whether one of an app's actions only reads: Composio's read-only tag where it gives one, else
 * the action's leading verb, such as GMAIL_FETCH_EMAILS. Anything else asks the Customer first.
 */
export function composioReadOnly(tool: Pick<ComposioTool, "slug" | "toolkit" | "tags">): boolean {
  if (tool.tags.includes("destructiveHint")) return false;
  if (tool.tags.includes("readOnlyHint")) return true;
  const prefix = `${tool.toolkit.toUpperCase()}_`;
  const verb = (tool.slug.startsWith(prefix) ? tool.slug.slice(prefix.length) : tool.slug).split("_")[0]!.toLowerCase();
  return READING.test(verb);
}

/**
 * The Bot's tools for its Connected apps, for one Task: find_app_actions, which searches
 * Composio's list of what an app can do, and use_app, which takes one action. Two tools however
 * many apps, rather than one per action: an app can have hundreds.
 */
export async function appTools(
  deps: AppDeps,
  bot: { id: string; name: string },
): Promise<{ appCatalog?: { tool: FunctionTool; find: (input: Record<string, unknown>) => Promise<string> }; connected: ConnectedTool[] }> {
  const composio = deps.composio;
  if (!composio) return { connected: [] };
  const apps = await botApps(deps.db, bot.id);
  if (apps.length === 0) return { connected: [] };
  const toolkits = [...new Set(apps.map((app) => app.toolkit))];
  const named = (app: StoredApp) => (app.label ? `${app.name} (${app.label})` : app.name);
  const listed = toolkits
    .map((toolkit) => {
      const accounts = apps.filter((app) => app.toolkit === toolkit);
      const labels = accounts.map((app) => app.label).filter(Boolean);
      return `${toolkit} (${accounts[0]!.name}${labels.length > 1 ? `; accounts: ${labels.join(", ")}` : ""})`;
    })
    .join(", ");

  const catalog: FunctionTool = {
    name: "find_app_actions",
    description:
      `Finds what one of your Connected apps can do: its actions, each with what it does and its inputs. ` +
      `Then take one with use_app. Your Connected apps: ${listed}.`,
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", enum: toolkits },
        query: { type: "string", description: "What you want to do, in a few words." },
      },
      required: ["app", "query"],
    },
  };

  const useApp: ConnectedTool = {
    tool: {
      name: "use_app",
      description:
        "Takes one action in one of your Connected apps, found with find_app_actions. Actions that only read run at once; " +
        "anything that sends, changes, deletes or pays may wait for the Customer's Approval.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "The action's name, as find_app_actions gave it." },
          account: { type: "string", description: "Which account, when the app has several." },
          arguments: { type: "object", description: "The action's inputs." },
        },
        required: ["action", "arguments"],
      },
    },
    async prepare(input) {
      const slug = typeof input.action === "string" ? input.action.trim().toUpperCase() : "";
      if (!slug) return "Say which action, by the name find_app_actions gave.";
      const tool = await composio.tool(slug);
      if (!tool) return `There's no action called ${slug}. Find one with find_app_actions.`;
      const accounts = apps.filter((app) => app.toolkit === tool.toolkit);
      if (accounts.length === 0) return `${tool.toolkit} isn't one of your Connected apps. Yours: ${listed}.`;
      const chosen = typeof input.account === "string" ? accounts.find((app) => app.label === input.account || app.id === input.account) : undefined;
      const app = chosen ?? (accounts.length === 1 ? accounts[0]! : null);
      if (!app) return `There's more than one ${accounts[0]!.name} account: say which, as account, one of ${accounts.map((each) => each.label).join(", ")}.`;
      const args = input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments) ? (input.arguments as Record<string, unknown>) : {};
      const label = named(app);
      return {
        kind: actionKind({ name: tool.slug, description: tool.description, readOnly: composioReadOnly(tool), destructive: tool.tags.includes("destructiveHint") }),
        action: { key: `composio:${app.id}:${tool.slug}`, label, name: tool.slug, ref: { source: "composio", appId: app.id, tool: tool.slug } },
        input: args,
        status: `${bot.name} is using ${label}: ${tool.name}.`,
        run: async () => (await runComposioAction(deps, bot.id, { appId: app.id, tool: tool.slug }, args)).output,
      };
    },
  };

  return {
    appCatalog: {
      tool: catalog,
      async find(input) {
        const toolkit = typeof input.app === "string" ? input.app : "";
        if (!toolkits.includes(toolkit)) return `Pick one of your Connected apps: ${listed}.`;
        const search = typeof input.query === "string" ? input.query.slice(0, 200) : "";
        let found: ComposioTool[];
        try {
          found = await composio.tools(toolkit, search, ACTIONS_PER_SEARCH);
        } catch (error) {
          return `Composio didn't answer: ${(error as Error).message}`;
        }
        if (found.length === 0) return `${toolkit} has no action for that. Try other words.`;
        return found
          .map((tool) => {
            const asks = composioReadOnly(tool) ? "reads, runs at once" : "may ask the Customer first";
            return `${tool.slug} (${asks}): ${tool.description.slice(0, 300)}\n  inputs: ${JSON.stringify(tool.inputSchema).slice(0, 1_500)}`;
          })
          .join("\n");
      },
    },
    connected: [useApp],
  };
}

/**
 * Takes one action in a Connected app the Bot has, exactly as given, through Composio. An app the
 * Customer has since removed or taken away from the Bot says so instead. Each is recorded, at $0
 * until Composio has a price.
 */
export async function runComposioAction(
  deps: AppDeps,
  botId: string,
  ref: { appId: string; tool: string },
  input: Record<string, unknown>,
): Promise<ActionOutcome> {
  const { rows } = await deps.db.query<StoredApp>(
    `SELECT ${appColumns("a")} FROM connected_apps a
     JOIN bot_connected_apps g ON g.connected_app_id = a.id
     WHERE a.id = $1 AND g.bot_id = $2 AND a.state = 'connected'`,
    [ref.appId, botId],
  );
  const app = rows[0];
  if (!app) return { output: "That Connected app isn't the Bot's any more.", failed: true };
  if (!deps.composio) return { output: "Connected apps are off here now.", failed: true };
  let outcome: ActionOutcome;
  try {
    const ran = await deps.composio.execute(ref.tool, { userId: app.customerId, accountId: app.composioAccountId, arguments: input });
    outcome = ran.successful
      ? { output: JSON.stringify(ran.data ?? null).slice(0, MAX_RESULT), failed: false }
      : { output: `It failed: ${ran.error ?? "Composio didn't say why."}`, failed: true };
  } catch (error) {
    outcome = { output: `Composio didn't answer: ${(error as Error).message}`, failed: true };
  }
  await deps.db.query(
    "INSERT INTO composio_calls (customer_id, bot_id, connected_app_id, tool, successful, cost_usd, created_at) VALUES ($1, $2, $3, $4, $5, 0, $6)",
    [app.customerId, botId, app.id, ref.tool, !outcome.failed, deps.now()],
  );
  return outcome;
}
