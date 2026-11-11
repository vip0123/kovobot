import { describe, expect, test } from "vitest";
import { type Browser, serverSentEvents, startTestServer, uniqueEmail } from "./harness.ts";

// Connected apps (ticket 20, ADR 0010): a Customer connects outside apps through Composio's hosted
// sign-in, several accounts to an app if they like, and gives each to the Bots they choose. Bots
// use them with two tools; reads run at once and are Outside content, and the rest go through
// Approvals. Each action is recorded at $0 until Composio has a price.
const server = startTestServer({}, { composio: true });
const withoutComposio = startTestServer();

interface ConnectedApp {
  id: string;
  toolkit: string;
  name: string;
  label: string | null;
  state: "connecting" | "connected" | "failed";
}

async function signedIn(on = server): Promise<{ browser: Browser; customer: { id: string } }> {
  const browser = on.browser();
  await on.signInByEmail(browser, uniqueEmail());
  const me = (await (await browser.get("/api/me")).json()) as { customer: { id: string } };
  return { browser, customer: me.customer };
}

async function createBot(browser: Browser): Promise<{ id: string }> {
  const response = await browser.post("/api/bots", { name: "Scout", model: "gpt-6-luna" });
  return ((await response.json()) as { bot: { id: string } }).bot;
}

async function appsOf(browser: Browser): Promise<ConnectedApp[]> {
  const response = await browser.get("/api/apps");
  expect(response.status).toBe(200);
  return ((await response.json()) as { apps: ConnectedApp[] }).apps;
}

/** Connects an app, going through its hosted sign-in when it has one, as the browser would. */
async function connect(browser: Browser, toolkit: string): Promise<{ app: ConnectedApp; back: string | null }> {
  const started = await browser.post("/api/apps", { toolkit });
  expect(started.status, await started.clone().text()).toBe(201);
  const { app, signInUrl } = (await started.json()) as { app: ConnectedApp; signInUrl?: string };
  if (!signInUrl) return { app, back: null };
  const signedInThere = await fetch(signInUrl, { redirect: "manual" });
  expect(signedInThere.status).toBe(302);
  const callback = new URL(signedInThere.headers.get("location")!);
  const returned = await browser.get(callback.pathname + callback.search);
  expect(returned.status).toBe(302);
  return { app, back: returned.headers.get("location") };
}

function grant(browser: Browser, bot: { id: string }, app: { id: string }) {
  return browser.send(`/api/bots/${bot.id}/apps/${app.id}`, { method: "PUT", headers: { origin: server.config.appUrl } });
}

/** The model's next answer calls each tool in turn, then says `reply`. */
function modelCalls(calls: Array<[name: string, input: object]>, reply = "OK.") {
  server.openai.addOutput(
    ...calls.map(([name, input], i) => ({ type: "function_call", id: `fc_${i}`, call_id: `call_${i}`, name, arguments: JSON.stringify(input), status: "completed" })),
  );
  server.openai.replyWith(reply);
}

async function chat(browser: Browser, bot: { id: string }, content: string) {
  const response = await browser.post(`/api/bots/${bot.id}/messages`, { content });
  expect(response.status).toBe(200);
  return serverSentEvents(response);
}

const toolOutputs = () =>
  server.openai.requests
    .at(-1)!
    .input.filter((item) => (item as { type?: string }).type === "function_call_output")
    .map((item) => (item as { output: string }).output);
const offered = () => (server.openai.requests.at(-1)!.tools ?? []).map((tool) => (tool as { name?: string }).name);

describe("Connected apps", () => {
  test("a Customer connects an app through Composio's hosted sign-in, and several accounts of one app", async () => {
    const { browser, customer } = await signedIn();
    expect(await appsOf(browser)).toEqual([]);
    const catalog = (await (await browser.get("/api/apps/catalog?search=mail")).json()) as { toolkits: Array<{ slug: string; name: string }> };
    expect(catalog.toolkits).toMatchObject([{ slug: "gmail", name: "Gmail" }]);

    const first = await connect(browser, "gmail");
    expect(first.app).toMatchObject({ toolkit: "gmail", name: "Gmail", state: "connecting" });
    expect(first.back).toBe(`${server.config.appUrl}/apps?connected=Gmail`);
    const second = await connect(browser, "gmail");

    // Both made on the test's stopped clock, so in either order.
    const apps = await appsOf(browser);
    expect(apps.map((app) => app.id).sort()).toEqual([first.app.id, second.app.id].sort());
    expect(apps.map((app) => app.state)).toEqual(["connected", "connected"]);
    expect(apps[0]!.label).not.toBe(apps[1]!.label);
    // Composio keeps each account under the Customer it belongs to.
    expect([...server.composio.accounts.values()].filter((account) => account.userId === customer.id)).toHaveLength(2);
  });

  test("a sign-in that fails, or an app Composio hosts no sign-in for, says so", async () => {
    const { browser } = await signedIn();
    server.composio.failNextSignIn = true;
    const { app, back } = await connect(browser, "gmail");
    expect(back).toBe(`${server.config.appUrl}/apps?failed=Gmail`);
    expect(await appsOf(browser)).toMatchObject([{ id: app.id, state: "failed" }]);

    const refused = await browser.post("/api/apps", { toolkit: "acme_crm" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: { code: "app_sign_in_unavailable", message: "Composio doesn't host sign-in for Acme CRM, so it can't be connected here yet." },
    });
    expect((await browser.post("/api/apps", { toolkit: "no_such_app" })).status).toBe(404);
  });

  test("a Bot gets only the apps it's given; reads run at once, sending waits for an Approval, and each is recorded at $0", async () => {
    const { browser, customer } = await signedIn();
    const bot = await createBot(browser);
    const gmail = (await connect(browser, "gmail")).app;
    const hackerNews = (await connect(browser, "hackernews")).app;
    expect(hackerNews).toMatchObject({ toolkit: "hackernews", state: "connected" });

    server.openai.replyWith("Hello.");
    await chat(browser, bot, "Hi");
    expect(offered()).not.toContain("use_app");

    expect((await grant(browser, bot, gmail)).status).toBe(204);
    modelCalls([
      ["find_app_actions", { app: "gmail", query: "email" }],
      ["use_app", { action: "GMAIL_FETCH_EMAILS", arguments: { query: "flour" } }],
      ["use_app", { action: "HACKERNEWS_GET_FRONTPAGE", arguments: {} }],
    ]);
    const events = await chat(browser, bot, "Any news about the flour?");

    expect(offered()).toEqual(expect.arrayContaining(["find_app_actions", "use_app"]));
    const [found, fetched, notGiven] = toolOutputs();
    expect(found).toContain("GMAIL_FETCH_EMAILS (reads, runs at once): Fetches emails from the inbox.");
    expect(found).toContain("GMAIL_SEND_EMAIL (may ask the Customer first): Sends an email.");
    expect(JSON.parse(fetched!)).toMatchObject({ messages: [{ subject: "Flour delivery" }] });
    expect(server.composio.executed.at(-1)).toMatchObject({ tool: "GMAIL_FETCH_EMAILS", userId: customer.id, arguments: { query: "flour" } });
    // Hacker News is the Customer's, but not this Bot's.
    expect(notGiven).toBe("hackernews isn't one of your Connected apps. Yours: gmail (Gmail).");
    expect(events).toContainEqual({ event: "status", data: { text: expect.stringMatching(/^Scout is using Gmail \(gmail_\w+\): Fetch emails\.$/) } });

    // Sending waits for the Customer, and runs once, as asked, when they approve.
    const sent = server.composio.executed.length;
    modelCalls([["use_app", { action: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "baker@example.com", body: "Tuesday is fine." } }]]);
    const asking = await chat(browser, bot, "Tell the baker Tuesday is fine.");
    const approval = asking.find(({ event }) => event === "approval")!.data as { approval: { id: string; kind: string; state: string; tool: { name: string } } };
    expect(approval.approval).toMatchObject({ kind: "send", state: "waiting", tool: { name: "GMAIL_SEND_EMAIL" } });
    expect(server.composio.executed).toHaveLength(sent);
    server.openai.replyWith("Sent.");
    await serverSentEvents(await browser.post(`/api/bots/${bot.id}/approvals/${approval.approval.id}`, { decision: "approve" }));
    expect(server.composio.executed).toHaveLength(sent + 1);
    expect(server.composio.executed.at(-1)).toMatchObject({ tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "baker@example.com", body: "Tuesday is fine." } });

    const { rows } = await server.deps.db.query<{ calls: number; cost: string }>(
      "SELECT count(*)::int AS calls, sum(cost_usd)::text AS cost FROM composio_calls WHERE customer_id = $1",
      [customer.id],
    );
    expect(rows[0]).toEqual({ calls: 2, cost: "0.000000" });
  });

  test("with two accounts of one app, the Bot says which, and uses only accounts it was given", async () => {
    const { browser } = await signedIn();
    const bot = await createBot(browser);
    const first = (await connect(browser, "gmail")).app;
    const second = (await connect(browser, "gmail")).app;
    const [one, two] = await appsOf(browser);
    await grant(browser, bot, first);
    await grant(browser, bot, second);

    modelCalls([
      ["use_app", { action: "GMAIL_FETCH_EMAILS", arguments: {} }],
      ["use_app", { action: "GMAIL_FETCH_EMAILS", account: two!.label, arguments: {} }],
    ]);
    await chat(browser, bot, "Check my second inbox.");
    const [unsaid, said] = toolOutputs();
    expect(unsaid).toBe(`There's more than one Gmail account: say which, as account, one of ${one!.label}, ${two!.label}.`);
    expect(JSON.parse(said!)).toMatchObject({ messages: [{}] });
    const usedAccount = [...server.composio.accounts.values()].find((account) => account.label === two!.label)!;
    expect(server.composio.executed.at(-1)).toMatchObject({ accountId: usedAccount.id });

    // Taken away from the Bot, it's gone from its tools.
    await browser.send(`/api/bots/${bot.id}/apps/${first.id}`, { method: "DELETE", headers: { origin: server.config.appUrl } });
    const left = (await (await browser.get(`/api/bots/${bot.id}/apps`)).json()) as { apps: ConnectedApp[] };
    expect(left.apps.map((app) => app.id)).toEqual([second.id]);
  });

  test("removing an app takes it from Composio and from every Bot; nobody else sees or uses it", async () => {
    const { browser } = await signedIn();
    const bot = await createBot(browser);
    const { app } = await connect(browser, "gmail");
    await grant(browser, bot, app);
    const account = [...server.composio.accounts.values()].at(-1)!;

    const { browser: stranger } = await signedIn();
    const theirs = await createBot(stranger);
    expect((await stranger.send(`/api/bots/${theirs.id}/apps/${app.id}`, { method: "PUT", headers: { origin: server.config.appUrl } })).status).toBe(404);
    expect((await stranger.get(`/api/bots/${bot.id}/apps`)).status).toBe(404);
    expect((await stranger.send(`/api/apps/${app.id}`, { method: "DELETE", headers: { origin: server.config.appUrl } })).status).toBe(404);

    const removed = await browser.send(`/api/apps/${app.id}`, { method: "DELETE", headers: { origin: server.config.appUrl } });
    expect(removed.status).toBe(204);
    expect(server.composio.accounts.has(account.id)).toBe(false);
    expect(await appsOf(browser)).toEqual([]);
    expect(((await (await browser.get(`/api/bots/${bot.id}/apps`)).json()) as { apps: unknown[] }).apps).toEqual([]);
  });

  test("without a Composio key, Connected apps are off, saying who can switch them on", async () => {
    const { browser } = await signedIn(withoutComposio);
    const response = await browser.get("/api/apps");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "apps_off",
        message: "Connected apps need a Composio key: whoever runs this Kovobot sets COMPOSIO_API_KEY. Bots can still use MCP servers.",
      },
    });
  });
});
