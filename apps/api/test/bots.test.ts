import { describe, expect, test } from "vitest";
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

  test("the models a Bot can use are listed", async () => {
    const browser = await signedInBrowser();
    const models = ((await (await browser.get("/api/models")).json()) as { models: Array<{ id: string }> }).models;

    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining(["gpt-6-luna", "gpt-6-astra"]));
  });

  test("signed out, there are no Bots to see", async () => {
    expect((await server.browser().get("/api/bots")).status).toBe(401);
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

  test("only the latest 50 messages go to the model, so a long conversation keeps working", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);

    for (let i = 1; i <= 26; i++) {
      server.openai.replyWith(`Answer ${i}`);
      await chat(browser, bot, `Question ${i}`);
    }

    const input = server.openai.requests.at(-1)!.input;
    expect(input).toHaveLength(50);
    expect(input[0]).toEqual({ role: "assistant", content: "Answer 1" });
    expect(input.at(-1)).toEqual({ role: "user", content: "Question 26" });
  });
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

  test("any OpenRouter model can be picked by the name OpenRouter lists it under", async () => {
    const browser = await signedInBrowser();

    expect((await browser.post("/api/bots", { name: "Scout", model: "openrouter:mistralai/mistral-large" })).status).toBe(201);
    expect((await browser.post("/api/bots", { name: "Scout", model: "openrouter:not a model" })).status).toBe(400);
  });

  test("local models are offered only where a local model server is set up", async () => {
    const browser = await signedInBrowser();

    expect((await browser.post("/api/bots", { name: "Scout", model: "local:llama4" })).status).toBe(400);
  });
});

describe("without an OpenAI key", () => {
  const keyless = startTestServer({}, { openai: false });

  test("chatting says the model isn't available instead of failing silently", async () => {
    const browser = keyless.browser();
    await keyless.signInByEmail(browser, uniqueEmail());
    const bot = ((await (await browser.post("/api/bots", { name: "Scout", model: "gpt-6-luna" })).json()) as { bot: Bot })
      .bot;

    const response = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Hi" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "model_unavailable" } });
  });
});
