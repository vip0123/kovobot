import { describe, expect, test } from "vitest";
import { type Browser, serverSentEvents, startTestServer, uniqueEmail } from "./harness.ts";

// Deep research: a message may ask the Bot to research. It searches the web and reads pages in
// full, in rounds, within a step and time budget, and its report is the reply, kept as a file too.
const server = startTestServer();

const ARTICLE = `<html><head><title>Sourdough hydration</title><style>p { color: red }</style></head>
<body><nav><a href="/menu">Menu</a></nav>
<article><h1>Hydration</h1><p>Most bakers use 75% water &amp; a long, cold proof.</p>
<p>See <a href="/flour">which flour to use</a>.</p><script>alert("never read")</script></article>
<footer>Copyright</footer></body></html>`;

async function researcher(): Promise<{ browser: Browser; bot: { id: string } }> {
  const browser = server.browser();
  await server.signInByEmail(browser, uniqueEmail());
  const created = await browser.post("/api/bots", { name: "Scout", model: "gpt-6-luna" });
  return { browser, bot: ((await created.json()) as { bot: { id: string } }).bot };
}

function readPageCall(url: string, i = 0) {
  return { type: "function_call", id: `fc_${i}`, call_id: `call_${i}`, name: "read_page", arguments: JSON.stringify({ url }), status: "completed" };
}

async function research(browser: Browser, bot: { id: string }, content: string) {
  const response = await browser.post(`/api/bots/${bot.id}/messages`, { content, research: true });
  expect(response.status).toBe(200);
  return serverSentEvents(response);
}

/** What a request gave the model back for its latest tool call. */
const toolOutput = (request: number) =>
  (server.openai.requests[request]!.input.findLast((item) => item.type === "function_call_output") as { output: string } | undefined)?.output;

const replyText = (events: Array<{ event: string; data: unknown }>) =>
  events
    .filter(({ event }) => event === "delta")
    .map(({ data }) => (data as { text: string }).text)
    .join("");

describe("deep research", () => {
  test("searches, reads the pages it found, and writes a cited report that is also kept as a file", async () => {
    const { browser, bot } = await researcher();
    const page = server.web.page("/hydration", ARTICLE);
    const before = server.openai.requests.length;
    server.openai.queueTurns(
      { text: "Looking for how wet bakers keep their dough.", sources: [{ url: page, title: "Sourdough hydration" }], output: [readPageCall(page)] },
      { text: `# Sourdough hydration\n\nMost bakers use 75% water ([guide](${page})).` },
    );

    const events = await research(browser, bot, "Research how wet sourdough should be.");

    const first = server.openai.requests[before]!;
    expect(first.instructions).toContain("deep research");
    expect(first.tools).toContainEqual({ type: "web_search" });
    const functions = (first.tools ?? []).filter((tool) => (tool as { type: string }).type === "function").map((tool) => (tool as { name: string }).name);
    // Read-only: the page reader alone, no notes, schedules or connected tools.
    expect(functions).toEqual(["read_page"]);

    // The page as the model reads it: its text and links, without its scripts, styles, menus or footer.
    const read = toolOutput(before + 1)!;
    expect(read).toContain("Sourdough hydration");
    expect(read).toContain("Most bakers use 75% water & a long, cold proof.");
    expect(read).toContain(`which flour to use: ${server.web.url("/flour")}`);
    expect(read).not.toMatch(/alert|color: red|Menu|Copyright/);

    // Only the report is the reply; the working between searches shows as progress.
    const statuses = events.filter(({ event }) => event === "status").map(({ data }) => (data as { text: string }).text);
    expect(statuses).toContain("Scout is researching: Looking for how wet bakers keep their dough.");
    expect(statuses).toContain("Scout is reading 127.0.0.1.");
    const text = replyText(events);
    expect(text).toBe(`# Sourdough hydration\n\nMost bakers use 75% water ([guide](${page})).`);

    const { message } = events.find(({ event }) => event === "done")!.data as {
      message: { content: string; sources: Array<{ url: string }>; attachments: Array<{ id: string; name: string; mediaType: string }> };
    };
    expect(message.content).toBe(text);
    expect(message.sources.map(({ url }) => url)).toEqual([page]);
    expect(message.attachments).toMatchObject([{ name: "Sourdough hydration.md", mediaType: "text/plain" }]);
    const file = await browser.get(`/api/bots/${bot.id}/attachments/${message.attachments[0]!.id}`);
    expect(await file.text()).toBe(`${text}\n\n## Sources\n\n1. [Sourdough hydration](${page})\n`);
  });

  test("what the model says before its report's title, as it searches within its last call, is progress, not report", async () => {
    const { browser, bot } = await researcher();
    server.openai.queueTurns({ text: "I will search for rye prices.I will check one more.# Rye prices\n\nRye costs more." });

    const events = await research(browser, bot, "Research rye prices.");

    expect(replyText(events)).toBe("# Rye prices\n\nRye costs more.");
    const statuses = events.filter(({ event }) => event === "status").map(({ data }) => (data as { text: string }).text);
    expect(statuses).toContain("Scout is researching: I will search for rye prices.I will check one more.");
    const { message } = events.find(({ event }) => event === "done")!.data as { message: { attachments: Array<{ name: string }> } };
    expect(message.attachments).toMatchObject([{ name: "Rye prices.md" }]);
  });

  test("reads only pages it saw an address for, never one it made up", async () => {
    const { browser, bot } = await researcher();
    const secret = server.web.page("/secret", "<p>Not for the Bot.</p>");
    const before = server.openai.requests.length;
    server.openai.queueTurns({ output: [readPageCall(`${secret}?the-conversation=goes-here`)] }, { text: "# Nothing found" });

    await research(browser, bot, "Research the bakery.");

    expect(toolOutput(before + 1)).toContain("You can read only pages your searches found");
    expect(server.web.requested).not.toContain("/secret?the-conversation=goes-here");
  });

  test("reads a page its search found but didn't cite, as the Model provider listed it", async () => {
    const { browser, bot } = await researcher();
    const uncited = server.web.page("/uncited", "<p>Rye takes more water than wheat.</p>");
    const before = server.openai.requests.length;
    server.openai.queueTurns({ found: [uncited], output: [readPageCall(uncited)] }, { text: "# Rye" });

    await research(browser, bot, "Research rye hydration.");

    expect(server.openai.requests[before]!.include).toContain("web_search_call.action.sources");
    expect(toolOutput(before + 1)).toContain("Rye takes more water than wheat.");
  });

  test("reads an address the Customer gave, and links on the pages it read", async () => {
    const { browser, bot } = await researcher();
    const given = server.web.page("/given", ARTICLE);
    const flour = server.web.page("/flour", "<p>Bread flour, 12% protein.</p>");
    const before = server.openai.requests.length;
    server.openai.queueTurns({ output: [readPageCall(given)] }, { output: [readPageCall(flour, 1)] }, { text: "# Flour" });

    await research(browser, bot, `Research the flour this page uses: ${given}.`);

    expect(toolOutput(before + 1)).toContain("Most bakers use 75% water");
    expect(toolOutput(before + 2)).toContain("Bread flour, 12% protein.");
  });

  test("once the time budget is spent, the model is told to write up, and its research stops", async () => {
    const { browser, bot } = await researcher();
    const page = server.web.page("/slow", ARTICLE);
    const before = server.openai.requests.length;
    // Loading the page takes the rest of the research's 20 minutes.
    server.web.onRequest = () => server.clock.advanceMinutes(21);
    server.openai.queueTurns({ sources: [{ url: page, title: "Slow" }], output: [readPageCall(page)] }, { output: [readPageCall(page, 1)] });

    const events = await research(browser, bot, "Research slowly.");
    server.web.onRequest = null;

    expect(toolOutput(before + 1)).toContain("the research budget is spent. Write the report now");
    // It asked once more, and was told again; then the research stopped.
    expect(server.openai.requests.length).toBe(before + 2);
    expect(replyText(events)).toBe("I used up the research budget before I could write the report. Ask me to write up what I found.");
  });
});

describe("deep research, hosted", () => {
  // It searches the web, which has no price yet (ADR 0009), so hosted it's off too.
  const hosted = startTestServer({
    KOVOBOT_MODE: "hosted",
    SMTP_HOST: "smtp.example.com",
    EMAIL_FROM: "Kovobot <hello@example.com>",
    API_URL: "https://app.example.com",
    APP_URL: "https://app.example.com",
    SIGN_UP_OPEN: "true",
  });

  test("is refused, and nothing is sent", async () => {
    const browser = hosted.browser();
    await hosted.signInByEmail(browser, uniqueEmail());
    const created = await browser.post("/api/bots", { name: "Scout", model: "gpt-6-luna" });
    const bot = ((await created.json()) as { bot: { id: string } }).bot;
    const before = hosted.openai.requests.length;

    const response = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Research bread.", research: true });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "research_unavailable" } });
    expect(hosted.openai.requests.length).toBe(before);
  });
});
