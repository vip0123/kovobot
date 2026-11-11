import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { McpServer as SessionMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";

/** The access token the fake's sign-in gives out, and wants on every MCP request when sign-in is on. */
export const FAKE_MCP_ACCESS_TOKEN = "fake-mcp-access-token";

/**
 * A local stand-in for a remote MCP server: the official MCP server SDK behind a real HTTP
 * server on 127.0.0.1, with a bakery's two tools, one that only reads and one that deletes.
 * With `requireSignIn` it is its own OAuth authorization server, as the MCP spec describes:
 * protected resource metadata, server metadata, registration, authorize and token endpoints.
 */
export class FakeMcpServer {
  baseUrl = "";
  /** The server wants a signed-in client: an OAuth access token on every MCP request. */
  requireSignIn = false;
  /** Every tool call, with the Authorization header it came with. */
  readonly calls: Array<{ name: string; args: unknown; authorization: string | null }> = [];
  private server: ServerType | undefined;
  private authorization: string | null = null;
  /** Each authorization code given out, with the PKCE challenge it was asked for with. */
  private codes = new Map<string, string>();

  get url(): string {
    return `${this.baseUrl}/mcp`;
  }

  async start(): Promise<void> {
    const mcp = createMcpHandler(() => {
      const server = new McpServer({ name: "Bakery orders", version: "1.0.0" });
      server.registerTool(
        "lookup_order",
        {
          description: "Looks up one order by its number.",
          inputSchema: fromJsonSchema({ type: "object", properties: { order: { type: "integer" } }, required: ["order"] }),
          annotations: { readOnlyHint: true },
        },
        async (args) => {
          this.calls.push({ name: "lookup_order", args, authorization: this.authorization });
          return { content: [{ type: "text", text: `Order ${(args as { order: number }).order}: 3 sourdough loaves, paid.` }] };
        },
      );
      server.registerTool(
        "cancel_order",
        {
          description: "Cancels an order and refunds it.",
          inputSchema: fromJsonSchema({ type: "object", properties: { order: { type: "integer" } }, required: ["order"] }),
          annotations: { destructiveHint: true },
        },
        async (args) => {
          this.calls.push({ name: "cancel_order", args, authorization: this.authorization });
          return { content: [{ type: "text", text: "Cancelled." }] };
        },
      );
      // A name that only differs from lookup_order in a character model tool names can't have.
      server.registerTool(
        "lookup.order",
        {
          description: "Looks up an order the old way.",
          inputSchema: fromJsonSchema({ type: "object", properties: { order: { type: "integer" } }, required: ["order"] }),
          annotations: { readOnlyHint: true },
        },
        async (args) => {
          this.calls.push({ name: "lookup.order", args, authorization: this.authorization });
          return { content: [{ type: "text", text: "Found it the old way." }] };
        },
      );
      return server;
    });

    const app = new Hono();
    app.all("/mcp", async (c) => {
      this.authorization = c.req.header("authorization") ?? null;
      if (this.requireSignIn && this.authorization !== `Bearer ${FAKE_MCP_ACCESS_TOKEN}`) {
        return c.json({ error: "invalid_token" }, 401, {
          "www-authenticate": `Bearer resource_metadata="${this.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
        });
      }
      return mcp.fetch(c.req.raw);
    });
    const resource = () => ({ resource: this.url, authorization_servers: [this.baseUrl], bearer_methods_supported: ["header"] });
    app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(resource()));
    app.get("/.well-known/oauth-protected-resource", (c) => c.json(resource()));
    app.get("/.well-known/oauth-authorization-server", (c) =>
      c.json({
        issuer: this.baseUrl,
        authorization_endpoint: `${this.baseUrl}/authorize`,
        token_endpoint: `${this.baseUrl}/token`,
        registration_endpoint: `${this.baseUrl}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      }),
    );
    app.post("/register", async (c) => c.json({ ...(await c.req.json()), client_id: "fake-mcp-client" }, 201));
    // The person signing in agrees at once: straight back to the client with a code.
    app.get("/authorize", (c) => {
      const { redirect_uri, state, code_challenge } = c.req.query();
      if (!redirect_uri || !code_challenge) return c.text("Missing redirect_uri or code_challenge.", 400);
      const code = `code-${this.codes.size + 1}`;
      this.codes.set(code, code_challenge);
      const back = new URL(redirect_uri);
      back.searchParams.set("code", code);
      if (state) back.searchParams.set("state", state);
      back.searchParams.set("iss", this.baseUrl);
      return c.redirect(back.toString(), 302);
    });
    app.post("/token", async (c) => {
      const form = new URLSearchParams(await c.req.text());
      if (form.get("grant_type") === "authorization_code") {
        const challenge = this.codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!challenge || createHash("sha256").update(verifier).digest("base64url") !== challenge) {
          return c.json({ error: "invalid_grant" }, 400);
        }
        this.codes.delete(form.get("code")!);
      }
      return c.json({ access_token: FAKE_MCP_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: "fake-mcp-refresh-token" });
    });

    this.server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => this.server!.once("listening", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

/**
 * A 2025-era MCP server, as many still are: the 1.x SDK over streamable HTTP, keeping a session
 * for each client (Mcp-Session-Id) instead of the stateless 2026-07-28 protocol. One tool that
 * only reads. It answers anything but an initialize without a session as the 1.x SDK does.
 */
export class FakeSessionMcpServer {
  baseUrl = "";
  /** The sessions it started, by id. */
  readonly sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  readonly calls: string[] = [];
  private server: ServerType | undefined;

  get url(): string {
    return `${this.baseUrl}/mcp`;
  }

  async start(): Promise<void> {
    const app = new Hono();
    app.all("/mcp", async (c) => {
      const session = this.sessions.get(c.req.header("mcp-session-id") ?? "");
      if (session) return session.handleRequest(c.req.raw);
      const body: unknown = c.req.method === "POST" ? await c.req.json().catch(() => null) : null;
      if (!isInitializeRequest(body)) {
        return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null }, 400);
      }
      const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void this.sessions.set(id, transport),
      });
      const server = new SessionMcpServer({ name: "Corner shop", version: "1.0.0" });
      server.registerTool("todays_specials", { description: "Lists today's specials.", annotations: { readOnlyHint: true } }, async () => {
        this.calls.push("todays_specials");
        return { content: [{ type: "text", text: "Rye loaf, half price." }] };
      });
      await server.connect(transport);
      return transport.handleRequest(c.req.raw, { parsedBody: body });
    });
    this.server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => this.server!.once("listening", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }
}
