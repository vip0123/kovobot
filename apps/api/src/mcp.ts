import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type Context, Hono } from "hono";
import {
  type CallToolResult,
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { AppDeps } from "./app.ts";
import type { Customer } from "./customers.ts";
import { apiError, jsonBody, UUID_PATTERN } from "./http.ts";
import type { FunctionTool } from "./models/adapter.ts";

/** One of an MCP server's tools, as the server listed it. */
interface McpTool {
  name: string;
  description: string;
  /** The server marks it as only reading: it runs at once. Anything else waits for an Approval. */
  readOnly: boolean;
  inputSchema: FunctionTool["parameters"];
}

/** What the OAuth client keeps for one server: its registration, tokens, and a sign-in in progress. */
interface StoredAuth {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  state?: string;
  discovery?: OAuthDiscoveryState;
}

interface StoredServer {
  id: string;
  botId: string;
  url: string;
  name: string | null;
  state: "connected" | "needs_sign_in";
  auth: StoredAuth;
  tools: McpTool[];
}

/** A server as the Customer sees it. */
export interface McpServerView {
  id: string;
  url: string;
  name: string | null;
  state: StoredServer["state"];
  /** Where the Customer signs in to the server, while it wants that. */
  signInUrl?: string;
  tools: Array<Pick<McpTool, "name" | "description" | "readOnly">>;
}

/** One of the Bot's tools from a connected app or server, for its Task. */
export interface ConnectedTool {
  tool: FunctionTool;
  /** What the Customer sees while it runs. */
  status: string;
  call: (input: Record<string, unknown>) => Promise<string>;
}

/** The most of a tool's result the model sees. */
const MAX_TOOL_OUTPUT = 20_000;
const CLIENT_INFO = { name: "Kovobot", version: "1.0.0" };

type Env = { Variables: { customer: Customer } };

/**
 * A Bot's MCP servers, under /bots/:id/mcp-servers, and the end of a server's sign-in at
 * /mcp/oauth/callback. Mounted inside the Bot routes, so every route has a signed-in Customer.
 */
export function mcpRoutes(deps: AppDeps) {
  const routes = new Hono<Env>();

  const ownBot = async (c: Context<Env>) => {
    const botId = c.req.param("id") ?? "";
    if (!UUID_PATTERN.test(botId)) return null;
    const { rowCount } = await deps.db.query("SELECT 1 FROM bots WHERE id = $1 AND customer_id = $2", [botId, c.get("customer").id]);
    return rowCount === 1 ? botId : null;
  };

  routes.get("/bots/:id/mcp-servers", async (c) => {
    const botId = await ownBot(c);
    if (!botId) return botNotFound(c);
    const { rows } = await deps.db.query<StoredServer>(`SELECT ${SERVER_COLUMNS} FROM mcp_servers WHERE bot_id = $1 ORDER BY created_at, id`, [botId]);
    return c.json({ servers: rows.map((server) => view(server)) });
  });

  // Connects a server: at once if it lets Kovobot in, else it answers with where the Customer signs in.
  routes.post("/bots/:id/mcp-servers", async (c) => {
    const botId = await ownBot(c);
    if (!botId) return botNotFound(c);
    const url = await serverAddress(deps, (await jsonBody(c)).url);
    if ("error" in url) return apiError(c, 400, "invalid_mcp_url", url.error);
    const now = deps.now();
    const { rows } = await deps.db.query<StoredServer>(
      `INSERT INTO mcp_servers (bot_id, url, state, created_at, updated_at) VALUES ($1, $2, 'needs_sign_in', $3, $3)
       ON CONFLICT (bot_id, url) DO NOTHING RETURNING ${SERVER_COLUMNS}`,
      [botId, url.href, now],
    );
    if (!rows[0]) return apiError(c, 409, "mcp_already_connected", "That MCP server is already connected to this Bot.");
    const attempt = await reach(deps, rows[0]);
    if ("error" in attempt) {
      await deps.db.query("DELETE FROM mcp_servers WHERE id = $1", [rows[0].id]);
      return apiError(c, 400, "mcp_unreachable", `Kovobot couldn't connect to an MCP server at that address: ${attempt.error}`);
    }
    return c.json({ server: attempt.server }, 201);
  });

  routes.delete("/bots/:id/mcp-servers/:serverId", async (c) => {
    const botId = await ownBot(c);
    const serverId = c.req.param("serverId");
    if (!botId || !UUID_PATTERN.test(serverId)) return apiError(c, 404, "mcp_server_not_found", "There's no such MCP server.");
    const { rowCount } = await deps.db.query("DELETE FROM mcp_servers WHERE id = $1 AND bot_id = $2", [serverId, botId]);
    return rowCount === 1 ? c.body(null, 204) : apiError(c, 404, "mcp_server_not_found", "There's no such MCP server.");
  });

  // Where a server's sign-in sends the Customer's browser back: finish signing in, then back to the Bot.
  routes.get("/mcp/oauth/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const { rows } = await deps.db.query<StoredServer>(
      `SELECT ${SERVER_COLUMNS} FROM mcp_servers JOIN bots ON bots.id = mcp_servers.bot_id
       WHERE mcp_servers.auth ->> 'state' = $1 AND bots.customer_id = $2`,
      [state, c.get("customer").id],
    );
    const server = rows[0];
    if (!state || !server) return c.redirect(`${deps.config.appUrl}/bots?mcp=failed`, 302);
    const back = (outcome: string) => c.redirect(`${deps.config.appUrl}/bots/${server.botId}?mcp=${outcome}`, 302);
    try {
      const auth = new StoredOAuth(deps, server);
      const transport = new StreamableHTTPClientTransport(new URL(server.url), { authProvider: auth });
      await transport.finishAuth(new URL(c.req.url).searchParams);
      const attempt = await reach(deps, { ...server, auth: auth.stored });
      return back("error" in attempt || attempt.server.state !== "connected" ? "failed" : "connected");
    } catch (error) {
      console.error(`MCP server ${server.id}: signing in failed`, error);
      return back("failed");
    }
  });

  return routes;
}

/** The Bot's tools from its connected MCP servers, for one Task. Only tools that only read, until Approvals. */
export async function mcpTools(deps: AppDeps, botId: string, botName: string): Promise<ConnectedTool[]> {
  const { rows } = await deps.db.query<StoredServer>(
    `SELECT ${SERVER_COLUMNS} FROM mcp_servers WHERE bot_id = $1 AND state = 'connected' ORDER BY created_at, id`,
    [botId],
  );
  const tools: ConnectedTool[] = [];
  const taken = new Set<string>();
  for (const server of rows) {
    const label = server.name ?? new URL(server.url).hostname;
    let prefix = slug(label);
    for (let n = 2; taken.has(prefix); n += 1) prefix = `${slug(label)}_${n}`;
    taken.add(prefix);
    for (const tool of server.tools.filter((each) => each.readOnly)) {
      const name = `${prefix}__${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
      tools.push({
        tool: { name, description: `${tool.description} (A tool of ${label}, an MCP server.)`.trim(), parameters: tool.inputSchema },
        status: `${botName} is using ${label}: ${tool.name}.`,
        call: (input) => callTool(deps, server, tool.name, input),
      });
    }
  }
  return tools;
}

/** Calls one tool on its server; whatever goes wrong is said in words, for the model. */
async function callTool(deps: AppDeps, server: StoredServer, name: string, input: Record<string, unknown>): Promise<string> {
  const auth = new StoredOAuth(deps, server);
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { authProvider: auth }));
    return toolOutput((await client.callTool({ name, arguments: input })) as CallToolResult);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      await deps.db.query("UPDATE mcp_servers SET state = 'needs_sign_in', updated_at = $2 WHERE id = $1", [server.id, deps.now()]);
      return "That MCP server wants the Customer to sign in to it again, on your page. Tell them.";
    }
    return `That MCP server didn't answer: ${(error as Error).message}`;
  } finally {
    await client.close().catch(() => {});
  }
}

function toolOutput(result: CallToolResult): string {
  const parts = (result.content ?? []).map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource" && "text" in block.resource) return block.resource.text;
    return `[${block.type}]`;
  });
  if (parts.length === 0 && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join("\n\n").slice(0, MAX_TOOL_OUTPUT);
  return result.isError ? `The tool failed: ${text}` : text;
}

/**
 * Connects to a server and lists its tools, keeping what it learns. A server that wants signing
 * in answers with where to; one that can't be reached, with why.
 */
async function reach(deps: AppDeps, server: StoredServer): Promise<{ server: McpServerView } | { error: string }> {
  const auth = new StoredOAuth(deps, server);
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { authProvider: auth }));
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          description: (tool.description ?? tool.title ?? "").slice(0, 1_000),
          readOnly: tool.annotations?.readOnlyHint === true,
          inputSchema: tool.inputSchema as FunctionTool["parameters"],
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 200);
    tools.sort((a, b) => a.name.localeCompare(b.name));
    const name = client.getServerVersion()?.name ?? null;
    const saved = { ...server, state: "connected" as const, name, tools, auth: auth.stored };
    await deps.db.query("UPDATE mcp_servers SET state = 'connected', name = $2, tools = $3, auth = $4, updated_at = $5 WHERE id = $1", [
      server.id,
      name,
      JSON.stringify(tools),
      JSON.stringify(auth.stored),
      deps.now(),
    ]);
    return { server: view(saved) };
  } catch (error) {
    if (error instanceof UnauthorizedError && auth.signInUrl) {
      await auth.save();
      return { server: { ...view({ ...server, state: "needs_sign_in", tools: [] }), signInUrl: auth.signInUrl } };
    }
    return { error: (error as Error).message };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * The OAuth client the MCP SDK signs in with, kept in the server's row: its registration, the
 * Customer's tokens, and a sign-in in progress. Kovobot's callback is where sign-in comes back.
 */
class StoredOAuth implements OAuthClientProvider {
  readonly stored: StoredAuth;
  signInUrl: string | undefined;
  private readonly deps: AppDeps;
  private readonly serverId: string;

  constructor(deps: AppDeps, server: StoredServer) {
    this.deps = deps;
    this.serverId = server.id;
    this.stored = { ...server.auth };
  }

  get redirectUrl(): string {
    return `${this.deps.config.apiUrl}/api/mcp/oauth/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Kovobot",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async state(): Promise<string> {
    this.stored.state = randomBytes(24).toString("base64url");
    await this.save();
    return this.stored.state;
  }

  clientInformation() {
    return this.stored.client;
  }

  async saveClientInformation(client: StoredOAuthClientInformation) {
    this.stored.client = client;
    await this.save();
  }

  tokens() {
    return this.stored.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens) {
    this.stored.tokens = tokens;
    await this.save();
  }

  redirectToAuthorization(url: URL) {
    this.signInUrl = url.href;
  }

  async saveCodeVerifier(codeVerifier: string) {
    this.stored.codeVerifier = codeVerifier;
    await this.save();
  }

  codeVerifier(): string {
    if (!this.stored.codeVerifier) throw new Error("No sign-in to this MCP server is under way.");
    return this.stored.codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState) {
    this.stored.discovery = state;
    await this.save();
  }

  discoveryState() {
    return this.stored.discovery;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") delete this.stored.client;
    if (scope === "all" || scope === "tokens") delete this.stored.tokens;
    if (scope === "all" || scope === "verifier") delete this.stored.codeVerifier;
    if (scope === "all" || scope === "discovery") delete this.stored.discovery;
    await this.save();
  }

  async save() {
    await this.deps.db.query("UPDATE mcp_servers SET auth = $2, updated_at = $3 WHERE id = $1", [
      this.serverId,
      JSON.stringify(this.stored),
      this.deps.now(),
    ]);
  }
}

/**
 * The server's address, checked. Self-hosted, any http or https address, as the Operator's own
 * install may reach its own network. Hosted, a public https address only: Kovobot's servers
 * never call into a private network on a Customer's say-so.
 */
async function serverAddress(deps: AppDeps, value: unknown): Promise<URL | { error: string }> {
  let url: URL;
  try {
    url = new URL(typeof value === "string" ? value.trim() : "");
  } catch {
    return { error: "Give the MCP server's address, starting https://." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "Give the MCP server's address, starting https://." };
  if (deps.config.mode !== "hosted") return url;
  const refused = { error: "Connect an MCP server at a public https address." };
  if (url.protocol !== "https:") return refused;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then((found) => found.map((each) => each.address), () => []);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) return refused;
  return url;
}

/** Whether an IP address is on the public internet: not loopback, private, link-local, shared or reserved. */
export function isPublicAddress(address: string): boolean {
  const mapped = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(mapped) === 4) {
    const [a, b] = mapped.split(".").map(Number) as [number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  return !(mapped === "::" || mapped === "::1" || /^f[cd]/.test(mapped) || /^fe[89ab]/.test(mapped));
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "server"
  );
}

function view(server: Pick<StoredServer, "id" | "url" | "name" | "state" | "tools">): McpServerView {
  return {
    id: server.id,
    url: server.url,
    name: server.name,
    state: server.state,
    tools: server.tools.map(({ name, description, readOnly }) => ({ name, description, readOnly })),
  };
}

const SERVER_COLUMNS = `mcp_servers.id, mcp_servers.bot_id AS "botId", mcp_servers.url, mcp_servers.name, mcp_servers.state,
  mcp_servers.auth, mcp_servers.tools`;

function botNotFound(c: Context) {
  return apiError(c, 404, "bot_not_found", "There's no such Bot.");
}
