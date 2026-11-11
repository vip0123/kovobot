import { describe, expect, test } from "vitest";
import { TINY_WAV } from "./fake-gemini-interactions.ts";
import { TINY_PNG } from "./fake-openai.ts";
import { type Browser, serverSentEvents, startTestServer, uniqueEmail } from "./harness.ts";

// Voice notes: the Customer speaks instead of typing. A speech-to-text model hears the recording,
// what it heard is the message, and the recording is kept with it. Any reply can be read aloud.
const server = startTestServer();

/** A recording as Chrome makes one: WebM, by its first bytes. */
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("opus frames, as recorded")]);

async function botAndBrowser(on = server): Promise<{ browser: Browser; bot: { id: string } }> {
  const browser = on.browser();
  await on.signInByEmail(browser, uniqueEmail());
  const created = await browser.post("/api/bots", { name: "Baker", model: "gpt-6-luna" });
  return { browser, bot: ((await created.json()) as { bot: { id: string } }).bot };
}

function sendVoiceNote(browser: Browser, bot: { id: string }, recording: Buffer) {
  return browser.post(`/api/bots/${bot.id}/messages`, { voiceNote: { data: recording.toString("base64") } });
}

type Saved = { id: string; role: string; content: string; attachments: Array<{ id: string; name: string; mediaType: string }> };

describe("voice notes", () => {
  test("a voice note is heard, kept with its transcript, and answered like a typed message", async () => {
    const { browser, bot } = await botAndBrowser();
    const before = server.openai.requests.length;
    server.openai.nextTranscript = "What's in the oven today?";
    server.openai.replyWith("Rye and two sourdoughs.");

    const response = await sendVoiceNote(browser, bot, WEBM);

    expect(response.status).toBe(200);
    const events = await serverSentEvents(response);
    // Heard by OpenAI's transcription model, as the recording it is.
    const heard = server.openai.transcriptionRequests.at(-1)!;
    expect(heard).toContain('name="model"\r\n\r\ngpt-transcribe');
    expect(heard).toContain('filename="voice-note.webm"');
    expect(heard).toContain("Content-Type: audio/webm");

    const { message: sent } = events.find(({ event }) => event === "sent")!.data as { message: Saved };
    expect(sent).toMatchObject({ role: "user", content: "What's in the oven today?", attachments: [{ name: "Voice note.webm", mediaType: "audio/webm" }] });
    const recording = await browser.get(`/api/bots/${bot.id}/attachments/${sent.attachments[0]!.id}`);
    expect(recording.headers.get("content-type")).toBe("audio/webm");
    expect(Buffer.from(await recording.arrayBuffer())).toEqual(WEBM);

    // The model reads the transcript, marked as spoken; the recording itself isn't sent.
    const asked = server.openai.requests[before]!.input.at(-1) as { content: unknown };
    expect(JSON.stringify(asked.content)).toContain("[A voice note, as transcribed]\\nWhat's in the oven today?");
    expect(JSON.stringify(asked.content)).not.toContain("audio");
    expect(events.at(-1)).toMatchObject({ event: "done", data: { message: { content: "Rye and two sourdoughs." } } });
  });

  test("a voice note with words typed beside it keeps both, typed words first", async () => {
    const { browser, bot } = await botAndBrowser();
    server.openai.nextTranscript = "and two baguettes.";
    server.openai.replyWith("Noted.");

    const response = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Order: one rye", voiceNote: { data: WEBM.toString("base64") } });

    const { message } = (await serverSentEvents(response)).find(({ event }) => event === "sent")!.data as { message: Saved };
    expect(message.content).toBe("Order: one rye\n\nand two baguettes.");
  });

  test("a recording with no words in it, one that isn't a recording, or one too long, isn't sent", async () => {
    const { browser, bot } = await botAndBrowser();
    const before = server.openai.requests.length;

    server.openai.nextTranscript = "";
    const silent = await sendVoiceNote(browser, bot, WEBM);
    expect(silent.status).toBe(422);
    expect(await silent.json()).toMatchObject({ error: { code: "voice_note_silent" } });

    const picture = await sendVoiceNote(browser, bot, Buffer.from(TINY_PNG, "base64"));
    expect(picture.status).toBe(400);
    expect(await picture.json()).toMatchObject({ error: { code: "invalid_voice_note" } });

    const long = await sendVoiceNote(browser, bot, Buffer.concat([WEBM, Buffer.alloc(10 * 1024 * 1024)]));
    expect(long.status).toBe(413);
    expect(await long.json()).toMatchObject({ error: { code: "voice_note_too_long" } });

    server.openai.nextTranscript = { fail: 500 };
    const failed = await sendVoiceNote(browser, bot, WEBM);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { code: "voice_note_unheard", message: "Your voice note couldn't be heard just now. Try again, or type it." } });

    // Nothing reached the model, and nothing was kept.
    expect(server.openai.requests.length).toBe(before);
    const { messages } = (await (await browser.get(`/api/bots/${bot.id}/messages`)).json()) as { messages: Saved[] };
    expect(messages).toEqual([]);
  });

  test("OpenAI's model can't hear Ogg, so an Ogg recording is refused before it's sent there", async () => {
    const { browser, bot } = await botAndBrowser();
    const asked = server.openai.transcriptionRequests.length;

    const response = await sendVoiceNote(browser, bot, Buffer.concat([Buffer.from("OggS"), Buffer.alloc(32)]));

    expect(response.status).toBe(400);
    expect(server.openai.transcriptionRequests.length).toBe(asked);
  });

  test("any of the Bot's replies can be read aloud, its Markdown left out", async () => {
    const { browser, bot } = await botAndBrowser();
    server.openai.replyWith("## Today\n\n**Rye** is ready. See [the menu](https://example.com/menu).\n\n```\ncode\n```");
    const events = await serverSentEvents(await browser.post(`/api/bots/${bot.id}/messages`, { content: "What's ready?" }));
    const { message: reply } = events.at(-1)!.data as { message: Saved };

    const spoken = await browser.post(`/api/bots/${bot.id}/messages/${reply.id}/speech`, {});

    expect(spoken.status).toBe(200);
    expect(spoken.headers.get("content-type")).toBe("audio/wav");
    expect(spoken.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await spoken.arrayBuffer())).toEqual(TINY_WAV);
    expect(server.geminiMedia.requests.at(-1)!.body).toMatchObject({
      model: "gemini-3.8-flash-tts",
      input: "Today\nRye is ready. See the menu.",
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: "Kore" }] },
      store: false,
    });

    // Only the Bot's replies, in its own Conversation.
    const { messages } = (await (await browser.get(`/api/bots/${bot.id}/messages`)).json()) as { messages: Saved[] };
    const own = messages.find((message) => message.role === "user")!;
    expect((await browser.post(`/api/bots/${bot.id}/messages/${own.id}/speech`, {})).status).toBe(404);
    const stranger = await botAndBrowser();
    expect((await stranger.browser.post(`/api/bots/${bot.id}/messages/${reply.id}/speech`, {})).status).toBe(404);
  });

  test("the models list says voice notes and reading aloud are on", async () => {
    const { browser } = await botAndBrowser();
    expect(await (await browser.get("/api/models")).json()).toMatchObject({ voice: { hear: true, speak: true } });
  });
});

describe("voice notes heard by Google's model", () => {
  const google = startTestServer({}, { voice: { hear: "google" } });

  test("it hears the recording, an Ogg one too, told to write down exactly what was said", async () => {
    const { browser, bot } = await botAndBrowser(google);
    google.geminiMedia.transcript = "Two loaves of rye, please.";
    google.openai.replyWith("Two rye, coming up.");
    const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(32)]);

    const events = await serverSentEvents(await sendVoiceNote(browser, bot, ogg));

    const { message } = events.find(({ event }) => event === "sent")!.data as { message: Saved };
    expect(message).toMatchObject({ content: "Two loaves of rye, please.", attachments: [{ name: "Voice note.ogg", mediaType: "audio/ogg" }] });
    const asked = google.geminiMedia.requests.at(-1)!.body as { model: string; input: Array<{ type: string; text?: string; data?: string; mime_type?: string }> };
    expect(asked.model).toBe("gemini-3.5-transcribe");
    expect(asked.input[0]!.text).toContain("Transcribe this recording word for word");
    expect(asked.input[1]).toEqual({ type: "audio", data: ogg.toString("base64"), mime_type: "audio/ogg" });
  });
});

describe("voice notes, hosted", () => {
  // Speech has no price yet (ADR 0009), so hosted it's off.
  const hosted = startTestServer({
    KOVOBOT_MODE: "hosted",
    SMTP_HOST: "smtp.example.com",
    EMAIL_FROM: "Kovobot <hello@example.com>",
    API_URL: "https://app.example.com",
    APP_URL: "https://app.example.com",
    SIGN_UP_OPEN: "true",
  });

  test("are off until speech has a price, and so is reading aloud", async () => {
    const { browser, bot } = await botAndBrowser(hosted);
    expect(await (await browser.get("/api/models")).json()).toMatchObject({ voice: { hear: false, speak: false } });

    const response = await sendVoiceNote(browser, bot, WEBM);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "voice_unavailable" } });
    expect((await browser.post(`/api/bots/${bot.id}/messages/1/speech`, {})).status).toBe(404);
  });
});
