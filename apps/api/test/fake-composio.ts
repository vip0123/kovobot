import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";

/** The project key the fake wants on every request, as Composio does. */
export const FAKE_COMPOSIO_KEY = "ak_fakecomposiokey0001";

interface FakeAccount {
  id: string;
  userId: string;
  toolkit: string;
  status: "INITIATED" | "ACTIVE" | "FAILED";
  label: string | null;
  callbackUrl: string;
}

const TOOLKITS = [
  {
    slug: "gmail",
    name: "Gmail",
    meta: { description: "Google's email." },
    auth_config_details: [{ mode: "OAUTH2" }],
    composio_managed_auth_schemes: ["OAUTH2"],
  },
  {
    slug: "hackernews",
    name: "Hacker News",
    no_auth: true,
    meta: { description: "News for hackers." },
    auth_config_details: [{ mode: "NO_AUTH" }],
    composio_managed_auth_schemes: [],
  },
  {
    // Signed in to with the Customer's own key, which Composio doesn't host a sign-in for.
    slug: "acme_crm",
    name: "Acme CRM",
    meta: { description: "A CRM." },
    auth_config_details: [{ mode: "API_KEY" }],
    composio_managed_auth_schemes: [],
  },
];

const TOOLS = [
  {
    slug: "GMAIL_FETCH_EMAILS",
    name: "Fetch emails",
    description: "Fetches emails from the inbox.",
    toolkit: { slug: "gmail", name: "Gmail" },
    tags: ["email"],
    input_parameters: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    slug: "GMAIL_SEND_EMAIL",
    name: "Send email",
    description: "Sends an email.",
    toolkit: { slug: "gmail", name: "Gmail" },
    tags: ["email"],
    input_parameters: {
      type: "object",
      properties: { recipient_email: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["recipient_email", "body"],
    },
  },
  {
    slug: "HACKERNEWS_GET_FRONTPAGE",
    name: "Front page",
    description: "Gets the front page's stories.",
    toolkit: { slug: "hackernews", name: "Hacker News" },
    tags: ["readOnlyHint"],
    input_parameters: { type: "object", properties: {} },
  },
];

/**
 * A local stand-in for Composio's platform API (v3.1): its catalogue of three apps, managed
 * sign-in through a "hosted" page that agrees at once, connected accounts, and actions that
 * record who ran them. It wants the project key on every request, as Composio does.
 */
export class FakeComposio {
  baseUrl = "";
  readonly accounts = new Map<string, FakeAccount>();
  /** Every action run: which, for whom, with which account and what. */
  readonly executed: Array<{ tool: string; userId: string; accountId: string | null; arguments: unknown }> = [];
  /** Set, the next sign-in fails at the app. */
  failNextSignIn = false;
  /** Set, every request is refused as Composio refuses a bad key: echoing a piece of it. */
  refuseKey = false;
  private readonly authConfigs = new Map<string, string>();
  private server: ServerType | undefined;

  /** The API's base, as the client is given it. */
  get apiUrl(): string {
    return `${this.baseUrl}/api/v3.1`;
  }

  async start(): Promise<void> {
    const app = new Hono();
    const fail = (status: 400 | 401 | 404, message: string) => Response.json({ error: { message } }, { status });

    // The "hosted sign-in": the person agrees, and is sent back where Kovobot asked.
    app.get("/link/:id", (c) => {
      const account = this.accounts.get(c.req.param("id"));
      if (!account) return c.text("No such sign-in.", 404);
      account.status = this.failNextSignIn ? "FAILED" : "ACTIVE";
      this.failNextSignIn = false;
      account.label = account.status === "ACTIVE" ? `${account.toolkit}_${["brave_fox", "calm_owl", "quick_hare"][this.accounts.size % 3]}_${account.id}` : null;
      return c.redirect(account.callbackUrl, 302);
    });

    app.use("/api/v3.1/*", async (c, next) => {
      const key = c.req.header("x-api-key") ?? "";
      if (this.refuseKey || key !== FAKE_COMPOSIO_KEY) return fail(401, `Invalid API key: ${key.slice(0, 3)}**${key.slice(-4)}`);
      await next();
    });

    app.get("/api/v3.1/toolkits", (c) => {
      const search = (c.req.query("search") ?? "").toLowerCase();
      return c.json({ items: TOOLKITS.filter((kit) => `${kit.slug} ${kit.name}`.toLowerCase().includes(search)) });
    });
    app.get("/api/v3.1/toolkits/:slug", (c) => {
      const kit = TOOLKITS.find((each) => each.slug === c.req.param("slug"));
      return kit ? c.json(kit) : fail(404, "No such toolkit");
    });

    app.get("/api/v3.1/auth_configs", (c) => {
      const id = this.authConfigs.get(c.req.query("toolkit_slug") ?? "");
      return c.json({ items: id ? [{ id, status: "ENABLED" }] : [] });
    });
    app.post("/api/v3.1/auth_configs", async (c) => {
      const body = (await c.req.json()) as { toolkit: { slug: string }; auth_config: { type: string } };
      const kit = TOOLKITS.find((each) => each.slug === body.toolkit.slug);
      if (!kit || kit.composio_managed_auth_schemes.length === 0 || body.auth_config.type !== "use_composio_managed_auth") {
        return fail(400, "Composio doesn't manage auth for this toolkit.");
      }
      const id = `ac_${kit.slug}`;
      this.authConfigs.set(kit.slug, id);
      return c.json({ toolkit: { slug: kit.slug }, auth_config: { id, auth_scheme: "OAUTH2", is_composio_managed: true } }, 201);
    });

    app.post("/api/v3.1/connected_accounts/link", async (c) => {
      const body = (await c.req.json()) as { auth_config_id: string; user_id: string; callback_url: string };
      const toolkit = [...this.authConfigs].find(([, id]) => id === body.auth_config_id)?.[0];
      if (!toolkit) return fail(400, "No such auth config");
      const id = `ca_${this.accounts.size + 1}`;
      this.accounts.set(id, { id, userId: body.user_id, toolkit, status: "INITIATED", label: null, callbackUrl: body.callback_url });
      return c.json({ link_token: `lt_${id}`, redirect_url: `${this.baseUrl}/link/${id}`, expires_at: new Date(Date.now() + 600_000).toISOString(), connected_account_id: id }, 201);
    });
    app.get("/api/v3.1/connected_accounts/:id", (c) => {
      const account = this.accounts.get(c.req.param("id"));
      if (!account) return fail(404, "No such connected account");
      return c.json({ id: account.id, status: account.status, toolkit: { slug: account.toolkit }, alias: "", word_id: account.label ?? "" });
    });
    app.delete("/api/v3.1/connected_accounts/:id", (c) => (this.accounts.delete(c.req.param("id")) ? c.json({ success: true }) : fail(404, "No such connected account")));

    app.get("/api/v3.1/tools", (c) => {
      const toolkit = c.req.query("toolkit_slug");
      const words = (c.req.query("query") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const limit = Number(c.req.query("limit") ?? 20);
      const items = TOOLS.filter((tool) => !toolkit || tool.toolkit.slug === toolkit).filter(
        (tool) => words.length === 0 || words.some((word) => `${tool.slug} ${tool.description}`.toLowerCase().includes(word)),
      );
      return c.json({ items: items.slice(0, limit) });
    });
    app.get("/api/v3.1/tools/:slug", (c) => {
      const tool = TOOLS.find((each) => each.slug === c.req.param("slug"));
      return tool ? c.json(tool) : fail(404, "No such tool");
    });
    app.post("/api/v3.1/tools/execute/:slug", async (c) => {
      const tool = TOOLS.find((each) => each.slug === c.req.param("slug"));
      if (!tool) return fail(404, "No such tool");
      const body = (await c.req.json()) as { user_id: string; connected_account_id?: string; arguments: Record<string, unknown> };
      const needsAccount = tool.toolkit.slug !== "hackernews";
      const account = body.connected_account_id ? this.accounts.get(body.connected_account_id) : undefined;
      if (needsAccount && (!account || account.status !== "ACTIVE" || account.userId !== body.user_id)) {
        return c.json({ successful: false, data: {}, error: "No active connected account for this user." });
      }
      this.executed.push({ tool: tool.slug, userId: body.user_id, accountId: body.connected_account_id ?? null, arguments: body.arguments });
      const data =
        tool.slug === "GMAIL_FETCH_EMAILS"
          ? { messages: [{ from: "baker@example.com", subject: "Flour delivery", snippet: "Arriving Tuesday." }] }
          : tool.slug === "GMAIL_SEND_EMAIL"
            ? { id: "msg_1", sent: true }
            : { stories: [{ title: "Show HN: A bread proofer", points: 120 }] };
      return c.json({ successful: true, data, error: null, log_id: "log_1" });
    });

    this.server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => this.server!.once("listening", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }
}
