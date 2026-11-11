import { describe, expect, test, vi } from "vitest";
import { type Browser, serverSentEvents, startTestServer, uniqueEmail } from "./harness.ts";

const server = startTestServer();

interface Bot {
  id: string;
  name: string;
  model: string;
}

async function signedInBrowser(): Promise<Browser> {
  const browser = server.browser();
  await server.signInByEmail(browser, uniqueEmail());
  return browser;
}

async function createBot(browser: Browser, name = "Scout", model = "gpt-6-luna"): Promise<Bot> {
  const response = await browser.post("/api/bots", { name, model });
  expect(response.status).toBe(201);
  return ((await response.json()) as { bot: Bot }).bot;
}

function patchBot(browser: Browser, bot: Bot, change: { name?: string; model?: string; instructions?: unknown }, on = server) {
  return browser.send(`/api/bots/${bot.id}`, {
    method: "PATCH",
    headers: { origin: on.config.appUrl, "content-type": "application/json" },
    body: JSON.stringify(change),
  });
}

async function listBots(browser: Browser): Promise<Bot[]> {
  return ((await (await browser.get("/api/bots")).json()) as { bots: Bot[] }).bots;
}

async function chat(browser: Browser, bot: Bot, content: string) {
  const response = await browser.post(`/api/bots/${bot.id}/messages`, { content });
  expect(response.status).toBe(200);
  return serverSentEvents(response);
}

async function history(browser: Browser, bot: Bot) {
  const response = await browser.get(`/api/bots/${bot.id}/messages`);
  return ((await response.json()) as { messages: Array<{ role: string; content: string }> }).messages;
}

/** Sends a message with options (thinking harder, web search, attachments) and returns the reply's events. */
async function send(browser: Browser, bot: Bot, body: Record<string, unknown>) {
  const response = await browser.post(`/api/bots/${bot.id}/messages`, body);
  expect(response.status).toBe(200);
  return serverSentEvents(response);
}

// A second install, with a local model server: no web search there, and no PDFs sent to it.
// Made here, outside any test, so its fakes start before the tests and stop after them.
const local = startTestServer({}, { local: true });

const dataOf = (events: Array<{ event: string; data: unknown }>, name: string) =>
  events.filter((event) => event.event === name).map((event) => event.data as Record<string, unknown>);

describe("thinking, shown in chat", () => {
  test("the Bot's thinking streams before its reply and stays with it; asked to think harder, it does", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    server.openai.thinkFirst("Let me ", "count.");
    server.openai.replyWith("Three.");

    const events = await chat(browser, bot, "How many r's in strawberry?");

    expect(dataOf(events, "thinking")).toEqual([{ text: "Let me " }, { text: "count." }]);
    expect(server.openai.requests.at(-1)!.reasoning).toEqual({ summary: "auto" });
    expect(dataOf(events, "done")[0]).toMatchObject({ message: { content: "Three.", thinking: "Let me count." } });
    expect(await history(browser, bot)).toMatchObject([
      { role: "user", content: "How many r's in strawberry?", thinking: null },
      { role: "assistant", content: "Three.", thinking: "Let me count." },
    ]);

    await send(browser, bot, { content: "Count again, carefully.", thinkHarder: true });
    expect(server.openai.requests.at(-1)!.reasoning).toEqual({ summary: "auto", effort: "high" });
  });

  test("a reply Anthropic pauses (as a long search can) carries on in the same Task; each call's thinking is its own paragraph", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser, "Scribe", "claude-sonnet-5-5");
    server.anthropic.thinkFirst("Searching.");
    server.anthropic.thinkFirst("Found it.");
    server.anthropic.replyWith("Node 26.");
    server.anthropic.endNextReply({ kind: "stop", reason: "pause_turn" });
    const before = server.anthropic.requests.length;

    const events = await chat(browser, bot, "Which Node.js is current?");

    expect(server.anthropic.requests.length - before).toBe(2);
    // Anthropic carries on from its own paused answer, sent back as the last message.
    const resumed = server.anthropic.requests.at(-1)!.body.messages as Array<{ role: string }>;
    expect(resumed.at(-1)!.role).toBe("assistant");
    expect(dataOf(events, "done")[0]).toMatchObject({ message: { thinking: "Searching.\n\nFound it." } });
  });
});

describe("web search", () => {
  const SOURCES = [
    { url: "https://nodejs.org/en/blog/release", title: "Node.js releases" },
    { url: "https://github.com/nodejs/node/releases", title: "Releases · nodejs/node" },
  ];

  test("a message can ask the Bot to search the web; the sources come with its reply and stay with it", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    expect(await (await browser.get("/api/models")).json()).toMatchObject({ webSearch: ["openai", "anthropic"] });
    server.openai.citeSources(...SOURCES);
    server.openai.replyWith("Node 26 is current.");

    const events = await send(browser, bot, { content: "Which Node.js is current?", webSearch: true });

    expect(server.openai.requests.at(-1)!.tools).toContainEqual({ type: "web_search" });
    expect(dataOf(events, "sources")).toEqual([{ sources: SOURCES }]);
    expect(await history(browser, bot)).toMatchObject([
      { role: "user", sources: null },
      { role: "assistant", content: "Node 26 is current.", sources: SOURCES, searchSuggestions: null },
    ]);

    await chat(browser, bot, "Thanks.");
    expect(server.openai.requests.at(-1)!.tools ?? []).not.toContainEqual({ type: "web_search" });
  });

  test("a model whose Model provider has no web search here says so, and nothing is sent", async () => {
    const browser = local.browser();
    await local.signInByEmail(browser, uniqueEmail());
    const created = await browser.post("/api/bots", { name: "Scout", model: "local:qwen3" });
    const bot = ((await created.json()) as { bot: Bot }).bot;
    const before = local.chatCompletions.requests.length;

    const response = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Search, please.", webSearch: true });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "web_search_unavailable" } });
    expect(local.chatCompletions.requests.length).toBe(before);
  });
});

describe("web search, hosted", () => {
  // Hosted Bots run on our keys, and a search has no price yet (ADR 0009), so none is offered.
  const hosted = startTestServer({
    KOVOBOT_MODE: "hosted",
    // Required hosted; the harness's mail never leaves the test.
    SMTP_HOST: "smtp.example.com",
    EMAIL_FROM: "Kovobot <hello@example.com>",
    API_URL: "https://app.example.com",
    APP_URL: "https://app.example.com",
    SIGN_UP_OPEN: "true",
  });

  test("is off until it has a price: the models say so, and a message asking for it is refused", async () => {
    const browser = hosted.browser();
    await hosted.signInByEmail(browser, uniqueEmail());
    expect(await (await browser.get("/api/models")).json()).toMatchObject({ webSearch: [] });
    const created = await browser.post("/api/bots", { name: "Scout", model: "gpt-6-luna" });
    const bot = ((await created.json()) as { bot: Bot }).bot;

    const response = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Search, please.", webSearch: true });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "web_search_unavailable" } });
  });
});

describe("Bots", () => {
  test("a Customer creates as many Bots as they like, renames one and deletes another", async () => {
    const browser = await signedInBrowser();
    const bots = [];
    for (let i = 1; i <= 12; i++) bots.push(await createBot(browser, `Bot ${i}`));

    const renamed = await browser.send(`/api/bots/${bots[0]!.id}`, {
      method: "PATCH",
      headers: { origin: server.config.appUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "Market watch" }),
    });
    expect(renamed.status).toBe(200);
    const deleted = await browser.send(`/api/bots/${bots[1]!.id}`, {
      method: "DELETE",
      headers: { origin: server.config.appUrl },
    });
    expect(deleted.status).toBe(204);

    const names = (await listBots(browser)).map((bot) => bot.name);
    expect(names).toHaveLength(11);
    expect(names).toContain("Market watch");
    expect(names).not.toContain("Bot 2");
  });

  test("a Customer can't see or change another Customer's Bot", async () => {
    const owner = await signedInBrowser();
    const bot = await createBot(owner);
    const stranger = await signedInBrowser();

    expect(await listBots(stranger)).toEqual([]);
    expect((await stranger.get(`/api/bots/${bot.id}/messages`)).status).toBe(404);
    const deleted = await stranger.send(`/api/bots/${bot.id}`, {
      method: "DELETE",
      headers: { origin: server.config.appUrl },
    });
    expect(deleted.status).toBe(404);
    expect(await listBots(owner)).toHaveLength(1);
  });

  test("a Bot needs a name and one of our models", async () => {
    const browser = await signedInBrowser();

    const nameless = await browser.post("/api/bots", { name: "  ", model: "gpt-6-luna" });
    expect(nameless.status).toBe(400);
    expect(await nameless.json()).toMatchObject({ error: { code: "invalid_name" } });
    const unknownModel = await browser.post("/api/bots", { name: "Scout", model: "gpt-0-imaginary" });
    expect(unknownModel.status).toBe(400);
    expect(await unknownModel.json()).toMatchObject({ error: { code: "unknown_model" } });
  });

  test("a Bot can't be set to a model whose Model provider isn't set up here", async () => {
    const browser = await signedInBrowser();

    const created = await browser.post("/api/bots", { name: "Scout", model: "gemini-4-argon" });
    expect(created.status).toBe(400);
    expect(await created.json()).toMatchObject({
      error: { code: "model_unavailable", message: "Gemini 4 Argon isn't set up here. Pick another model." },
    });
    const bot = await createBot(browser);
    const switched = await patchBot(browser, bot, { model: "grok-4.7" });
    expect(switched.status).toBe(400);
    expect(await switched.json()).toMatchObject({ error: { code: "model_unavailable" } });
    expect((await listBots(browser)).find(({ id }) => id === bot.id)).toMatchObject({ model: "gpt-6-luna" });
  });

  test("the models a Bot can use are listed", async () => {
    const browser = await signedInBrowser();
    const models = ((await (await browser.get("/api/models")).json()) as { models: Array<{ id: string }> }).models;

    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining(["gpt-6-luna", "gpt-6-astra"]));
  });

  test("signed out, there are no Bots to see", async () => {
    expect((await server.browser().get("/api/bots")).status).toBe(401);
  });
});

describe("Bot instructions", () => {
  test("a Customer gives a Bot instructions, which it gets with every message, and can change or clear them", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);

    const given = await patchBot(browser, bot, { instructions: "  Answer in French.\nSign off as Scout.  " });
    expect(given.status).toBe(200);
    expect(await given.json()).toMatchObject({ bot: { instructions: "Answer in French.\nSign off as Scout." } });
    expect((await listBots(browser)).find(({ id }) => id === bot.id)).toMatchObject({ instructions: "Answer in French.\nSign off as Scout." });
    server.openai.replyWith("Bonjour.");
    await chat(browser, bot, "Hello");
    expect(server.openai.requests.at(-1)!.instructions).toContain("Answer in French.\nSign off as Scout.");

    expect((await patchBot(browser, bot, { instructions: "" })).status).toBe(200);
    server.openai.replyWith("Hello.");
    await chat(browser, bot, "Hello again");
    expect(server.openai.requests.at(-1)!.instructions).not.toContain("French");
  });

  test("instructions are text of up to 8,000 characters", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);

    for (const instructions of ["x".repeat(8_001), 42]) {
      const refused = await patchBot(browser, bot, { instructions });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: { code: "invalid_instructions", message: "Write instructions of up to 8,000 characters." },
      });
    }
    expect((await patchBot(browser, bot, { instructions: "x".repeat(8_000) })).status).toBe(200);
  });

  test("a new Bot has none, and renaming it keeps them", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    expect(bot).toMatchObject({ instructions: "" });

    await patchBot(browser, bot, { instructions: "Be brief." });
    const renamed = await patchBot(browser, bot, { name: "Brief Scout" });
    expect(await renamed.json()).toMatchObject({ bot: { name: "Brief Scout", instructions: "Be brief." } });
  });
});

describe("chatting on the web Channel", () => {
  test("the reply streams in as the model writes it", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    server.openai.replyWith("Hel", "lo ", "there!");

    const events = await chat(browser, bot, "Hi");

    expect(events.filter((e) => e.event === "delta").map((e) => e.data)).toEqual([
      { text: "Hel" },
      { text: "lo " },
      { text: "there!" },
    ]);
    expect(events.at(-1)).toMatchObject({ event: "done", data: { message: { role: "assistant", content: "Hello there!" } } });
  });

  test("the conversation survives a reload", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    server.openai.replyWith("Noted.");

    await chat(browser, bot, "Remember the blue folder.");

    expect(await history(browser, bot)).toMatchObject([
      { role: "user", content: "Remember the blue folder." },
      { role: "assistant", content: "Noted." },
    ]);
  });

  test("the model gets the Bot's own instructions and the whole conversation so far, on the chosen model", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser, "Scout", "gpt-6-astra");
    server.openai.replyWith("First answer.");
    await chat(browser, bot, "First question?");
    server.openai.replyWith("Second answer.");

    await chat(browser, bot, "Second question?");

    const request = server.openai.requests.at(-1)!;
    expect(request.model).toBe("gpt-6-astra");
    expect(request.instructions).toContain("Scout");
    expect(request.input).toEqual([
      { role: "user", content: "First question?" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "Second question?" },
    ]);
  });

  test("a failed model call is tried once, not retried behind our back, and the Customer is told", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    server.openai.failWith(500);
    const before = server.openai.requests.length;

    const events = await chat(browser, bot, "Hello?");

    expect(server.openai.requests.length - before).toBe(1);
    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "model_failed" } });
    expect(await history(browser, bot)).toMatchObject([{ role: "user", content: "Hello?" }]);
  });

  test("a key the Model provider refuses is named, since trying again won't help", async () => {
    const browser = await signedInBrowser();
    const gpt = await createBot(browser);
    const claude = await createBot(browser, "Scribe", "claude-sonnet-5-5");
    server.openai.failWith(401);
    server.anthropic.endNextReply({ kind: "fail", status: 403 });

    const fromOpenAI = await chat(browser, gpt, "Hello?");
    const fromAnthropic = await chat(browser, claude, "Hello?");

    expect(fromOpenAI.at(-1)).toMatchObject({
      event: "error",
      data: { code: "model_key_refused", message: expect.stringMatching(/^OpenAI refused .*OPENAI_API_KEY/) },
    });
    expect(fromAnthropic.at(-1)).toMatchObject({
      event: "error",
      data: { code: "model_key_refused", message: expect.stringMatching(/^Anthropic refused .*ANTHROPIC_API_KEY/) },
    });
  });
});

describe("keeping a conversation sound", () => {
  test("if the model fails part-way, what it already wrote is kept for the reload", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    server.openai.failMidStream("Half an ", "answer");

    const events = await chat(browser, bot, "Question?");

    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "model_failed" } });
    expect(await history(browser, bot)).toMatchObject([
      { role: "user", content: "Question?" },
      { role: "assistant", content: "Half an answer" },
    ]);
  });

  test("a Bot answers one message at a time in a conversation", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    server.openai.replyWith("First answer.");
    const release = server.openai.holdNextReply();
    const before = server.openai.requests.length;

    const first = browser.post(`/api/bots/${bot.id}/messages`, { content: "First?" });
    await server.openai.waitForRequests(before + 1);
    const second = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Second?" });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "bot_busy" } });

    release();
    expect((await serverSentEvents(await first)).at(-1)).toMatchObject({ event: "done" });
    expect((await history(browser, bot)).map((message) => message.content)).not.toContain("Second?");
  });

  test("a reply that runs past five minutes, as one waiting on the Customer at its Computer can, still holds the conversation", async () => {
    // Only the reply's renewal timer is faked; the clock is the harness's own.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const browser = await signedInBrowser();
      const bot = await createBot(browser);
      server.openai.replyWith("First answer.");
      const release = server.openai.holdNextReply();
      const before = server.openai.requests.length;

      const first = browser.post(`/api/bots/${bot.id}/messages`, { content: "First?" });
      await server.openai.waitForRequests(before + 1);
      // Each renewal is a write to the database: wait for it to land, however busy the machine is.
      const renewed = async () => {
        const { rows } = await server.deps.db.query<{ since: Date | null }>(
          "SELECT replying_since AS since FROM conversations WHERE bot_id = $1 AND channel = 'web'",
          [bot.id],
        );
        return rows[0]?.since?.getTime() === server.clock.now.getTime();
      };
      for (let minute = 1; minute <= 12; minute++) {
        server.clock.advanceMinutes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        while (!(await renewed())) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const second = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Second?" });
      expect(second.status).toBe(409);

      release();
      expect((await serverSentEvents(await first)).at(-1)).toMatchObject({ event: "done" });
      expect((await history(browser, bot)).map((message) => message.content)).toEqual(["First?", "First answer."]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a long conversation's window moves on in steps, so the model keeps reading its start from cache", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    // The first reply fails, so from here on the Customer's and the Bot's messages fall at odd and even places.
    server.openai.failWith(500);
    await chat(browser, bot, "Question 1");
    for (let i = 2; i <= 28; i++) {
      server.openai.replyWith(`Answer ${i}`);
      await chat(browser, bot, `Question ${i}`);
    }

    // 52 messages when Question 27 went out: the window starts at the 21st, a Bot message, so on the
    // Customer's next one. Question 28 still sees the same start, and the same messages after it.
    const [atQuestion27, atQuestion28] = server.openai.requests.slice(-2).map((request) => request.input);
    expect(atQuestion27).toHaveLength(31);
    expect(atQuestion27![0]).toEqual({ role: "user", content: "Question 12" });
    expect(atQuestion27!.at(-1)).toEqual({ role: "user", content: "Question 27" });
    expect(atQuestion28).toHaveLength(33);
    expect(atQuestion28!.slice(0, atQuestion27!.length)).toEqual(atQuestion27);
  }, 30_000);
});

describe("Model providers", () => {
  test("switching a Bot to another Model provider's model keeps its conversation", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    server.openai.replyWith("Noted.");
    await chat(browser, bot, "Remember the blue folder.");

    const switched = await browser.send(`/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { origin: server.config.appUrl, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5" }),
    });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({ bot: { name: "Scout", model: "claude-sonnet-5-5" } });
    server.anthropic.replyWith("The blue one.");
    const events = await chat(browser, bot, "Which folder?");

    expect(events.at(-1)).toMatchObject({ event: "done", data: { message: { content: "The blue one." } } });
    expect(server.anthropic.requests.at(-1)!.body.messages).toEqual([
      { role: "user", content: "Remember the blue folder." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "Which folder?" },
    ]);
  });

  test("the model list shows which Model providers are set up here", async () => {
    const browser = await signedInBrowser();
    const body = (await (await browser.get("/api/models")).json()) as {
      models: Array<{ id: string; available: boolean }>;
      openrouter: boolean;
      local: boolean;
    };
    const available = (id: string) => body.models.find((model) => model.id === id)?.available;

    expect(available("claude-opus-5-5")).toBe(true);
    expect(available("gemini-4-argon")).toBe(false);
    expect(body).toMatchObject({ openrouter: false, local: false });
  });

  test("OpenRouter and local models are refused where neither is set up", async () => {
    const browser = await signedInBrowser();

    for (const model of ["openrouter:mistralai/mistral-large", "local:llama4"]) {
      const response = await browser.post("/api/bots", { name: "Scout", model });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "model_unavailable" } });
    }
  });
});

describe("with OpenRouter and a local model server set up", () => {
  const openRouterAndLocal = startTestServer({}, { openrouter: true, local: true });

  async function openRouterAndLocalBrowser(): Promise<Browser> {
    const browser = openRouterAndLocal.browser();
    await openRouterAndLocal.signInByEmail(browser, uniqueEmail());
    return browser;
  }

  test("the model list offers any OpenRouter model and the local server's models", async () => {
    const browser = await openRouterAndLocalBrowser();

    expect(await (await browser.get("/api/models")).json()).toMatchObject({ openrouter: true, local: true });
  });

  test("a Bot chats on any OpenRouter model, picked by the name OpenRouter lists it under", async () => {
    const browser = await openRouterAndLocalBrowser();
    expect((await browser.post("/api/bots", { name: "Scout", model: "openrouter:not a model" })).status).toBe(400);
    const created = await browser.post("/api/bots", { name: "Scout", model: "openrouter:mistralai/mistral-large" });
    expect(created.status).toBe(201);
    const { bot } = (await created.json()) as { bot: Bot };
    openRouterAndLocal.chatCompletions.replyWith("Routed ", "hello.");

    const response = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Hi" });
    const events = await serverSentEvents(response);

    expect(events.at(-1)).toMatchObject({ event: "done", data: { message: { content: "Routed hello." } } });
    expect(openRouterAndLocal.chatCompletions.requests.at(-1)!.body.model).toBe("mistralai/mistral-large");
  });

  test("a self-hosted Bot chats on a model from the local model server", async () => {
    const browser = await openRouterAndLocalBrowser();
    const created = await browser.post("/api/bots", { name: "Scout", model: "local:llama4" });
    expect(created.status).toBe(201);
    const { bot } = (await created.json()) as { bot: Bot };
    openRouterAndLocal.chatCompletions.replyWith("Local ", "hello.");

    const response = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Hi" });
    const events = await serverSentEvents(response);

    expect(events.at(-1)).toMatchObject({ event: "done", data: { message: { content: "Local hello." } } });
    expect(openRouterAndLocal.chatCompletions.requests.at(-1)!.body).toMatchObject({
      model: "llama4",
      messages: [{ role: "system" }, { role: "user", content: "Hi" }],
    });
  });

  test("a cut-off reply is reported as a failure, and nothing empty is saved", async () => {
    const browser = await openRouterAndLocalBrowser();
    const { bot } = (await (await browser.post("/api/bots", { name: "Scout", model: "local:llama4" })).json()) as { bot: Bot };
    openRouterAndLocal.chatCompletions.replyWith("");
    openRouterAndLocal.chatCompletions.endNextReply({ kind: "cut-off" });

    const events = await serverSentEvents(await browser.post(`/api/bots/${bot.id}/messages`, { content: "Hi" }));

    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "model_failed" } });
    const { messages } = (await (await browser.get(`/api/bots/${bot.id}/messages`)).json()) as { messages: unknown[] };
    expect(messages).toEqual([expect.objectContaining({ role: "user", content: "Hi" })]);
  });
});

describe("a Bot whose Model provider's key was removed after it was set up", () => {
  const keyless = startTestServer({}, { openai: false });

  async function botOn(model: string): Promise<{ browser: Browser; bot: Bot }> {
    const browser = keyless.browser();
    await keyless.signInByEmail(browser, uniqueEmail());
    const { bot } = (await (await browser.post("/api/bots", { name: "Scout", model: "claude-haiku-5-5" })).json()) as { bot: Bot };
    // As if the Bot had been set to this model while its Model provider's key was set.
    await keyless.deps.db.query("UPDATE bots SET model = $1 WHERE id = $2", [model, bot.id]);
    return { browser, bot: { ...bot, model } };
  }

  test.each([
    ["gpt-6-luna", "GPT-6 Luna"],
    ["openrouter:mistralai/mistral-large", "mistralai/mistral-large"],
  ])("chatting on %s says, by the model's name, that it isn't available", async (model, name) => {
    const { browser, bot } = await botOn(model);

    const response = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Hi" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "model_unavailable", message: `${name} isn't available here right now.` },
    });
  });

  test("it can still be renamed, and switched to a model that is set up", async () => {
    const { browser, bot } = await botOn("openrouter:mistralai/mistral-large");

    expect(await (await patchBot(browser, bot, { name: "Scout II" }, keyless)).json()).toMatchObject({
      bot: { name: "Scout II", model: bot.model },
    });
    expect(await (await patchBot(browser, bot, { model: "claude-haiku-5-5" }, keyless)).json()).toMatchObject({
      bot: { model: "claude-haiku-5-5" },
    });
  });
});

describe("attachments", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
  const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n").toString("base64");
  const NOTES = Buffer.from("# Notes\nBuy milk.").toString("base64");
  type Sent = { id: string; role: string; attachments: Array<{ id: string; name: string; mediaType: string; size: number }> };

  test("images and PDFs reach the model as themselves and text files as text; the Conversation keeps them", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);

    const events = await send(browser, bot, {
      content: "Summarise these.",
      attachments: [
        { name: "photo.png", data: PNG },
        { name: "report.pdf", data: PDF },
        { name: "notes.md", data: NOTES },
      ],
    });

    expect(events.at(-1)!.event).toBe("done");
    expect(server.openai.requests.at(-1)!.input.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: 'Summarise these.\n\n<file name="notes.md">\n# Notes\nBuy milk.\n</file>' },
        { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" },
        { type: "input_file", filename: "report.pdf", file_data: `data:application/pdf;base64,${PDF}` },
      ],
    });
    const [sent] = (await history(browser, bot)) as unknown as Sent[];
    expect(sent).toMatchObject({
      role: "user",
      content: "Summarise these.",
      attachments: [
        { name: "photo.png", mediaType: "image/png", size: Buffer.from(PNG, "base64").length },
        { name: "report.pdf", mediaType: "application/pdf" },
        { name: "notes.md", mediaType: "text/plain" },
      ],
    });

    const photo = await browser.get(`/api/bots/${bot.id}/attachments/${sent!.attachments[0]!.id}`);
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(photo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await photo.arrayBuffer()).toString("base64")).toBe(PNG);

    // Later messages still show the model the files.
    await chat(browser, bot, "And the report?");
    expect(JSON.stringify(server.openai.requests.at(-1)!.input)).toContain("report.pdf");

    // The page hears the saved message first, so its files link straight away.
    expect(dataOf(events, "sent")[0]).toMatchObject({
      message: { id: sent!.id, attachments: [{ id: sent!.attachments[0]!.id }, {}, {}] },
    });
  });
  // It sends three 4.5 MB images, each of them on to the model again, so it gets more time than most.
  // It sends some 20 MB of files in all, so it gets more time than most.
  test("the model sees files newest first within the budget; anything older than the first that doesn't fit is named", { timeout: 15_000 }, async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    const image = (megabytes: number) =>
      Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(megabytes * 1024 * 1024)]).toString("base64");

    await send(browser, bot, { content: "Notes.", attachments: [{ name: "notes.md", data: NOTES }] });
    await send(browser, bot, {
      content: "Two photos.",
      attachments: [
        { name: "first.png", data: image(4.5) },
        { name: "second.png", data: image(4.5) },
      ],
    });
    await send(browser, bot, { content: "One more.", attachments: [{ name: "third.png", data: image(4.5) }] });

    const input = JSON.stringify(server.openai.requests.at(-1)!.input);
    expect(input.match(/input_image/g)?.length).toBe(2);
    expect(input).toContain("[first.png was attached here; it isn't shown any more.]");
    expect(input).toContain("[notes.md was attached here; it isn't shown any more.]");
  });

  test("a model server that can't read PDFs here is told a PDF was attached instead of being sent it", async () => {
    const browser = local.browser();
    await local.signInByEmail(browser, uniqueEmail());
    const created = await browser.post("/api/bots", { name: "Scout", model: "local:qwen3" });
    const bot = ((await created.json()) as { bot: Bot }).bot;

    await send(browser, bot, { content: "Read this.", attachments: [{ name: "report.pdf", data: PDF }] });

    const sent = JSON.stringify(local.chatCompletions.requests.at(-1)!.body.messages);
    expect(sent).not.toContain("file_data");
    expect(sent).toContain("[report.pdf is a PDF, which this model can't read here.]");
  });

  test("a message of files alone is fine", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    const events = await send(browser, bot, { content: "", attachments: [{ name: "photo.png", data: PNG }] });
    expect(events.at(-1)!.event).toBe("done");
  });

  test("files it can't take are refused, saying why, before any model call", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    const before = server.openai.requests.length;
    const refused = async (attachments: unknown) => {
      const response = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Look.", attachments });
      expect(response.status).toBe(400);
      return ((await response.json()) as { error: { code: string; message: string } }).error;
    };

    expect(await refused(Array.from({ length: 6 }, (_, n) => ({ name: `${n}.png`, data: PNG })))).toMatchObject({
      code: "invalid_attachments",
      message: expect.stringMatching(/5 files/),
    });
    const binary = Buffer.from([0, 1, 2, 3, 255, 254, 0, 9]).toString("base64");
    expect(await refused([{ name: "program.exe", data: binary }])).toMatchObject({
      code: "invalid_attachments",
      message: expect.stringMatching(/program\.exe/),
    });
    const hugeImage = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(5 * 1024 * 1024)]).toString("base64");
    expect(await refused([{ name: "big.png", data: hugeImage }])).toMatchObject({ message: expect.stringMatching(/big\.png/) });
    expect(await refused([{ name: "", data: "" }])).toMatchObject({ code: "invalid_attachments" });
    expect(server.openai.requests.length).toBe(before);
  });

  test("a Bot's files are its Customer's alone", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    await send(browser, bot, { content: "Mine.", attachments: [{ name: "photo.png", data: PNG }] });
    const [sent] = (await history(browser, bot)) as unknown as Sent[];

    const stranger = await signedInBrowser();
    const response = await stranger.get(`/api/bots/${bot.id}/attachments/${sent!.attachments[0]!.id}`);
    expect(response.status).toBe(404);
  });
});
