import { describe, expect, test } from "vitest";
import { TINY_PNG } from "./fake-openai.ts";
import { type Browser, serverSentEvents, startTestServer, uniqueEmail } from "./harness.ts";

// Image generation: a Bot makes pictures with a Model provider's image model, whatever its chat
// model. Each shows as it's made and is kept with the reply, with the description it came from.
const server = startTestServer();

const LOAF = "A golden sourdough loaf on a wooden board, morning light, photo";

async function botAndBrowser(on = server): Promise<{ browser: Browser; bot: { id: string } }> {
  const browser = on.browser();
  await on.signInByEmail(browser, uniqueEmail());
  const created = await browser.post("/api/bots", { name: "Painter", model: "gpt-6-luna" });
  return { browser, bot: ((await created.json()) as { bot: { id: string } }).bot };
}

/** The model's next answer asks for each picture in turn, then says `reply`. */
function modelDraws(pictures: Array<Record<string, unknown>>, reply = "Here's your loaf.", on = server) {
  on.openai.queueTurns(
    {
      output: pictures.map((input, i) => ({
        type: "function_call",
        id: `fc_${i}`,
        call_id: `call_${i}`,
        name: "generate_image",
        arguments: JSON.stringify(input),
        status: "completed",
      })),
    },
    { text: reply },
  );
}

async function chat(browser: Browser, bot: { id: string }, content: string) {
  const response = await browser.post(`/api/bots/${bot.id}/messages`, { content });
  expect(response.status).toBe(200);
  return serverSentEvents(response);
}

type Saved = { content: string; attachments: Array<{ id: string; name: string; mediaType: string; prompt?: string }> };
const savedReply = (events: Array<{ event: string; data: unknown }>) => (events.find(({ event }) => event === "done")!.data as { message: Saved }).message;
const toolOutputs = (on = server) =>
  on.openai.requests
    .at(-1)!
    .input.filter((item) => item.type === "function_call_output")
    .map((item) => (item as { output: string }).output);

describe("image generation", () => {
  test("the Bot makes a picture with its image model; it shows as it's made, and is kept with the reply", async () => {
    const { browser, bot } = await botAndBrowser();
    const before = server.openai.requests.length;
    modelDraws([{ prompt: LOAF, shape: "landscape" }]);

    const events = await chat(browser, bot, "Draw me a loaf.");

    const functions = (server.openai.requests[before]!.tools ?? []).map((tool) => (tool as { name?: string }).name);
    expect(functions).toContain("generate_image");
    expect(server.openai.imageRequests.at(-1)).toEqual({ model: "gpt-image-2.6-flare", prompt: LOAF, size: "1536x1024", n: 1, output_format: "png" });
    expect(toolOutputs()).toEqual(["Made. The Customer sees the picture with your reply."]);

    const shown = events.filter(({ event }) => event === "image").map(({ data }) => (data as { image: unknown }).image);
    expect(shown).toEqual([{ name: "A golden sourdough loaf on a.png", mediaType: "image/png", prompt: LOAF, data: TINY_PNG }]);
    const reply = savedReply(events);
    expect(reply.content).toBe("Here's your loaf.");
    expect(reply.attachments).toMatchObject([{ name: "A golden sourdough loaf on a.png", mediaType: "image/png", prompt: LOAF }]);
    const file = await browser.get(`/api/bots/${bot.id}/attachments/${reply.attachments[0]!.id}`);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(TINY_PNG);

    // A reload shows it with the reply; later Tasks know it by its description.
    const { messages } = (await (await browser.get(`/api/bots/${bot.id}/messages`)).json()) as { messages: Saved[] };
    expect(messages.at(-1)!.attachments).toMatchObject([{ prompt: LOAF }]);
    server.openai.replyWith("Sure.");
    await chat(browser, bot, "Make it darker.");
    const earlier = server.openai.requests.at(-1)!.input.find((item) => item.role === "assistant") as { content: unknown };
    expect(JSON.stringify(earlier.content)).toContain(
      `you made a picture with generate_image, and the Customer saw it with this reply. Made from: \\"${LOAF}\\"`,
    );
  });

  test("a picture the image model refuses isn't kept, and the model hears why", async () => {
    const { browser, bot } = await botAndBrowser();
    server.openai.nextImage = "refuse";
    modelDraws([{ prompt: "Something not allowed" }], "I can't draw that.");

    const events = await chat(browser, bot, "Draw something not allowed.");

    expect(toolOutputs()).toEqual(["The image model wouldn't make that picture under its Model provider's usage policy."]);
    expect(events.some(({ event }) => event === "image")).toBe(false);
    expect(savedReply(events).attachments).toEqual([]);
  });

  test("one message makes four pictures at most, since each costs", async () => {
    const { browser, bot } = await botAndBrowser();
    const before = server.openai.imageRequests.length;
    modelDraws([1, 2, 3, 4, 5].map((n) => ({ prompt: `Loaf number ${n}` })), "Five loaves, nearly.");

    const events = await chat(browser, bot, "Draw five loaves.");

    expect(server.openai.imageRequests.length).toBe(before + 4);
    expect(toolOutputs().at(-1)).toBe("You've made 4 pictures for this message, the most one can have.");
    expect(savedReply(events).attachments).toHaveLength(4);
  });

  test("what the Bot says before and after making the picture are separate paragraphs", async () => {
    const { browser, bot } = await botAndBrowser();
    server.openai.queueTurns(
      {
        text: "Drawing it now.",
        output: [{ type: "function_call", id: "fc_0", call_id: "call_0", name: "generate_image", arguments: JSON.stringify({ prompt: LOAF }), status: "completed" }],
      },
      { text: "Here it is." },
    );

    const events = await chat(browser, bot, "Draw a loaf.");

    expect(savedReply(events).content).toBe("Drawing it now.\n\nHere it is.");
  });

  test("a reply that is a picture alone still says something", async () => {
    const { browser, bot } = await botAndBrowser();
    modelDraws([{ prompt: LOAF }], "");

    const events = await chat(browser, bot, "Just the picture.");

    expect(savedReply(events)).toMatchObject({ content: "Here's the picture.", attachments: [{ prompt: LOAF }] });
  });
});

describe("image generation with Google's image model", () => {
  const google = startTestServer({}, { images: "google" });

  test("asks for the picture's shape as an aspect ratio, kept nowhere at Google, in one attempt", async () => {
    const { browser, bot } = await botAndBrowser(google);
    modelDraws([{ prompt: LOAF, shape: "portrait" }], "Here.", google);

    const events = await chat(browser, bot, "Draw me a tall loaf.");

    expect(google.geminiMedia.requests.at(-1)).toMatchObject({
      body: {
        model: "gemini-nano-banana-2.1",
        input: LOAF,
        response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: "2:3", image_size: "1K" },
        store: false,
      },
    });
    expect(savedReply(events).attachments).toMatchObject([{ mediaType: "image/png", prompt: LOAF }]);

    // Overloaded: one attempt, no retries, and the model hears it failed.
    const asked = google.geminiMedia.requests.length;
    google.geminiMedia.answerNext({ kind: "fail", status: 503 });
    modelDraws([{ prompt: LOAF }], "It failed.", google);
    await chat(browser, bot, "Again.");
    expect(google.geminiMedia.requests.length).toBe(asked + 1);
    expect(toolOutputs(google)).toEqual(["The image model couldn't make that picture. Try again, or describe it differently."]);
  });

  test("a model that answers in words instead of a picture has refused it", async () => {
    const { browser, bot } = await botAndBrowser(google);
    google.geminiMedia.answerNext({ kind: "words", text: "I can't make images of that." });
    modelDraws([{ prompt: "Something not allowed" }], "No.", google);

    const events = await chat(browser, bot, "Draw something not allowed.");

    expect(toolOutputs(google)).toEqual(["The image model wouldn't make that picture under its Model provider's usage policy."]);
    expect(savedReply(events).attachments).toEqual([]);
  });
});

describe("image generation, hosted", () => {
  // A picture has no price yet (ADR 0009), so hosted Bots aren't offered the tool.
  const hosted = startTestServer({
    KOVOBOT_MODE: "hosted",
    SMTP_HOST: "smtp.example.com",
    EMAIL_FROM: "Kovobot <hello@example.com>",
    API_URL: "https://app.example.com",
    APP_URL: "https://app.example.com",
    SIGN_UP_OPEN: "true",
  });

  test("is off until it has a price", async () => {
    const { browser, bot } = await botAndBrowser(hosted);
    hosted.openai.replyWith("Hello.");

    await chat(browser, bot, "Draw me a loaf.");

    const functions = (hosted.openai.requests.at(-1)!.tools ?? []).map((tool) => (tool as { name?: string }).name);
    expect(functions).not.toContain("generate_image");
  });
});
