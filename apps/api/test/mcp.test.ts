import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FAKE_MCP_ACCESS_TOKEN, FakeMcpServer, FakeSessionMcpServer } from "./fake-mcp.ts";
import { type Browser, serverSentEvents, startTestServer, uniqueEmail } from "./harness.ts";

// MCP tools (ticket 17): a Customer connects a remote MCP server to a Bot, signing in to it
// with OAuth when it asks, and the Bot uses its tools. Tools that only read run at once; the
// rest wait for Approvals (ticket 18). What a tool returns is Outside content.
const server = startTestServer();
const mcp = new FakeMcpServer();
const older = new FakeSessionMcpServer();
beforeAll(() => Promise.all([mcp.start(), older.start()]));
afterAll(() => Promise.all([mcp.stop(), older.stop()]));

interface McpServer {
  id: string;
  url: string;
  name: string | null;
  state: "connected" | "needs_sign_in";
  signInUrl?: string;
  tools: Array<{ name: string; description: string; readOnly: boolean }>;
}

async function signedInBot(on = server): Promise<{ browser: Browser; bot: { id: string } }> {
  const browser = on.browser();
  await on.signInByEmail(browser, uniqueEmail());
  const response = await browser.post("/api/bots", { name: "Scout", model: "gpt-6-luna" });
  return { browser, bot: ((await response.json()) as { bot: { id: string } }).bot };
}

async function serversOf(browser: Browser, bot: { id: string }): Promise<McpServer[]> {
  const response = await browser.get(`/api/bots/${bot.id}/mcp-servers`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { servers: McpServer[] }).servers;
}

async function connect(browser: Browser, bot: { id: string }, url = mcp.url) {
  return browser.post(`/api/bots/${bot.id}/mcp-servers`, { url });
}

/** The model's next answer calls `name` with `input`, then says `reply`. */
function modelCalls(name: string, input: object, reply = "OK.") {
  server.openai.addOutput({ type: "function_call", id: `fc_${name}`, call_id: `call_${name}`, name, arguments: JSON.stringify(input), status: "completed" });
  server.openai.replyWith(reply);
}

async function chat(browser: Browser, bot: { id: string }, content: string) {
  const response = await browser.post(`/api/bots/${bot.id}/messages`, { content });
  expect(response.status).toBe(200);
  return serverSentEvents(response);
}

const offeredTools = () => (server.openai.requests.at(-1)!.tools ?? []).map((tool) => (tool as { name?: string }).name);

describe("MCP servers", () => {
  test("a Customer connects an MCP server; the Bot uses its tools that only read, and what they return is Outside content", async () => {
    mcp.requireSignIn = false;
    const { browser, bot } = await signedInBot();

    const connected = await connect(browser, bot);
    expect(connected.status).toBe(201);
    expect(await connected.json()).toMatchObject({
      server: {
        url: mcp.url,
        name: "Bakery orders",
        state: "connected",
        tools: [
          { name: "cancel_order", description: "Cancels an order and refunds it.", readOnly: false },
          { name: "lookup.order", description: "Looks up an order the old way.", readOnly: true },
          { name: "lookup_order", description: "Looks up one order by its number.", readOnly: true },
        ],
      },
    });

    modelCalls("bakery_orders__lookup_order", { order: 42 }, "Order 42 is paid.");
    const events = await chat(browser, bot, "Is order 42 paid?");

    const asked = server.openai.requests.at(-2)!;
    const offered = (asked.tools ?? []).map((tool) => (tool as { name?: string }).name);
    expect(offered).toContain("bakery_orders__lookup_order");
    // Two tools whose names come out the same for the model each get a name of their own.
    expect(offered).toContain("bakery_orders__lookup_order_2");
    // Anything that changes things waits for Approvals, which aren't here yet.
    expect(offered).not.toContain("bakery_orders__cancel_order");
    expect(mcp.calls.at(-1)).toMatchObject({ name: "lookup_order", args: { order: 42 } });
    expect(server.openai.requests.at(-1)!.input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call_bakery_orders__lookup_order",
      output: "Order 42: 3 sourdough loaves, paid.",
    });
    expect(events).toContainEqual({ event: "status", data: { text: "Scout is using Bakery orders: lookup_order." } });

    // Outside content: a note written after it is marked for the Customer to check.
    server.openai.addOutput(
      { type: "function_call", id: "fc_a", call_id: "call_a", name: "bakery_orders__lookup_order", arguments: '{"order":7}', status: "completed" },
      { type: "function_call", id: "fc_b", call_id: "call_b", name: "note", arguments: '{"action":"add","note":"Order 7 is paid."}', status: "completed" },
    );
    await chat(browser, bot, "Look up order 7 and remember it.");
    const notes = ((await (await browser.get(`/api/bots/${bot.id}/notes`)).json()) as { notes: Array<{ afterOutsideContent: boolean }> }).notes;
    expect(notes).toMatchObject([{ afterOutsideContent: true }]);
  });

  test("a server that wants sign-in sends the Customer through its OAuth, then the Bot uses it with the token", async () => {
    mcp.requireSignIn = true;
    const { browser, bot } = await signedInBot();

    const connected = await connect(browser, bot);
    expect(connected.status).toBe(201);
    const pending = ((await connected.json()) as { server: McpServer }).server;
    expect(pending).toMatchObject({ state: "needs_sign_in", tools: [] });
    // Connecting it again, as after a sign-in that didn't finish, starts signing in again.
    const again = await connect(browser, bot);
    expect(again.status).toBe(201);
    const restarted = ((await again.json()) as { server: McpServer }).server;
    expect(restarted).toMatchObject({ id: pending.id, state: "needs_sign_in", signInUrl: expect.stringContaining("/authorize?") });
    expect(pending.signInUrl).toMatch(new RegExp(`^${mcp.baseUrl}/authorize\\?`));

    // The Customer's browser goes to the server's sign-in page, which sends it back to Kovobot.
    // The newer sign-in is the one that counts.
    const signIn = await fetch(restarted.signInUrl!, { redirect: "manual" });
    const back = new URL(signIn.headers.get("location")!);
    expect(back.pathname).toBe("/api/mcp/oauth/callback");
    const landed = await browser.get(back.pathname + back.search);
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe(`${server.config.appUrl}/bots/${bot.id}?mcp=connected`);
    expect(await serversOf(browser, bot)).toMatchObject([{ state: "connected", name: "Bakery orders", tools: [{}, {}, { name: "lookup_order" }] }]);

    modelCalls("bakery_orders__lookup_order", { order: 9 });
    await chat(browser, bot, "Look up order 9.");
    expect(mcp.calls.at(-1)).toMatchObject({ name: "lookup_order", args: { order: 9 }, authorization: `Bearer ${FAKE_MCP_ACCESS_TOKEN}` });
    mcp.requireSignIn = false;
  });

  test("a Customer removes a server, and the Bot no longer has its tools", async () => {
    mcp.requireSignIn = false;
    const { browser, bot } = await signedInBot();
    const { server: connected } = (await (await connect(browser, bot)).json()) as { server: McpServer };

    const removed = await browser.send(`/api/bots/${bot.id}/mcp-servers/${connected.id}`, {
      method: "DELETE",
      headers: { origin: server.config.appUrl },
    });
    expect(removed.status).toBe(204);
    expect(await serversOf(browser, bot)).toEqual([]);

    server.openai.replyWith("Hello.");
    await chat(browser, bot, "Hi");
    expect(offeredTools()).not.toContain("bakery_orders__lookup_order");
  });

  test("an older server, which keeps a session, works too", async () => {
    const { browser, bot } = await signedInBot();
    const connected = await connect(browser, bot, older.url);
    expect(connected.status).toBe(201);
    expect(await connected.json()).toMatchObject({
      server: { name: "Corner shop", state: "connected", tools: [{ name: "todays_specials", readOnly: true }] },
    });
    expect(older.sessions.size).toBeGreaterThan(0);

    modelCalls("corner_shop__todays_specials", {}, "Rye is half price today.");
    await chat(browser, bot, "Any specials?");
    expect(older.calls).toEqual(["todays_specials"]);
    expect(server.openai.requests.at(-1)!.input.at(-1)).toMatchObject({ output: "Rye loaf, half price." });
  });

  test("an address that isn't an MCP server, or can't be reached, is refused, saying so", async () => {
    const { browser, bot } = await signedInBot();
    for (const url of ["not a url", "ftp://example.com/mcp"]) {
      const refused = await connect(browser, bot, url);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: { code: "invalid_mcp_url", message: "Give the MCP server's address, starting https://." } });
    }
    const unreachable = await connect(browser, bot, `${mcp.baseUrl}/no-such-endpoint`);
    expect(unreachable.status).toBe(400);
    expect(await unreachable.json()).toMatchObject({ error: { code: "mcp_unreachable" } });
    expect(await serversOf(browser, bot)).toEqual([]);
  });

  test("a Customer can't see or remove another Customer's servers", async () => {
    mcp.requireSignIn = false;
    const { browser, bot } = await signedInBot();
    const { server: connected } = (await (await connect(browser, bot)).json()) as { server: McpServer };
    const { browser: stranger } = await signedInBot();

    expect((await stranger.get(`/api/bots/${bot.id}/mcp-servers`)).status).toBe(404);
    const removed = await stranger.send(`/api/bots/${bot.id}/mcp-servers/${connected.id}`, {
      method: "DELETE",
      headers: { origin: server.config.appUrl },
    });
    expect(removed.status).toBe(404);
    expect(await serversOf(browser, bot)).toHaveLength(1);
  });
});

describe("MCP servers, hosted", () => {
  const hosted = startTestServer({
    KOVOBOT_MODE: "hosted",
    SMTP_HOST: "smtp.example.com",
    EMAIL_FROM: "Kovobot <hello@example.com>",
    API_URL: "https://app.example.com",
    APP_URL: "https://app.example.com",
    SIGN_UP_OPEN: "true",
  });

  test("only a public https address is connected: hosted, Kovobot never calls into a private network", async () => {
    const { browser, bot } = await signedInBot(hosted);
    for (const url of [
      mcp.url,
      "https://127.0.0.1/mcp",
      "https://10.0.0.8/mcp",
      "https://localhost/mcp",
      // The same private addresses written as IPv6: mapped, mapped in hex, NAT64, link-local.
      "https://[::ffff:10.0.0.8]/mcp",
      "https://[::ffff:a9fe:a9fe]/mcp",
      "https://[64:ff9b::a00:1]/mcp",
      "https://[fe80::1]/mcp",
    ]) {
      const refused = await browser.post(`/api/bots/${bot.id}/mcp-servers`, { url });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: { code: "invalid_mcp_url", message: "Connect an MCP server at a public https address." },
      });
    }
  });
});
