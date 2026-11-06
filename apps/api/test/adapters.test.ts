import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ModelAdapter, ModelUsage } from "../src/models/adapter.ts";
import { createAnthropicAdapter } from "../src/models/anthropic.ts";
import { createGoogleAdapter } from "../src/models/google.ts";
import { createOpenAIAdapter } from "../src/models/openai.ts";
import { createOpenAICompatibleAdapter } from "../src/models/openai-compatible.ts";
import { FakeAnthropic, FakeChatCompletions, FakeGemini } from "./fake-models.ts";
import { FAKE_OPENAI_KEY, FakeOpenAI } from "./fake-openai.ts";

// The ModelAdapter seam: each Model provider's official SDK, talking to a local fake of its API.
const openai = new FakeOpenAI();
const anthropic = new FakeAnthropic();
const gemini = new FakeGemini();
const chatCompletions = new FakeChatCompletions();
beforeAll(() => Promise.all([openai.start(), anthropic.start(), gemini.start(), chatCompletions.start("/v1")]));
afterAll(() => Promise.all([openai.stop(), anthropic.stop(), gemini.stop(), chatCompletions.stop()]));

const conversation = [
  { role: "user" as const, content: "Hi" },
  { role: "assistant" as const, content: "Hello." },
  { role: "user" as const, content: "How are you?" },
];

/** Runs one call; returns the streamed pieces and the usage reported at the end. */
async function call(adapter: ModelAdapter, model: string): Promise<{ pieces: string[]; usage: ModelUsage | null }> {
  const pieces: string[] = [];
  let usage: ModelUsage | null | undefined;
  for await (const event of adapter.stream({ model, instructions: "You are Scout.", conversation })) {
    if (event.type === "text") pieces.push(event.text);
    else usage = event.usage;
  }
  expect(usage, "a done event").not.toBeUndefined();
  return { pieces, usage: usage! };
}

describe("every Model provider streams through one seam and reports usage in one shape", () => {
  test("OpenAI, on the Responses API", async () => {
    openai.replyWith("Fine, ", "thanks.");
    const adapter = createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl });

    expect(await call(adapter, "gpt-6-luna")).toEqual({
      pieces: ["Fine, ", "thanks."],
      usage: { inputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reportedCostMicros: null },
    });
  });

  test("xAI, through the OpenAI adapter, keeps xAI's reported cost as a cross-check", async () => {
    openai.replyWith("Grok here.");
    openai.costTicks = 4_200_000; // 10^10 ticks per US dollar
    const adapter = createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl });

    const { usage } = await call(adapter, "grok-4.7");
    openai.costTicks = null;

    expect(usage?.reportedCostMicros).toBe(420);
  });

  test("Anthropic, on the Messages API, with the Bot's instructions as the system prompt and prompt caching on", async () => {
    anthropic.replyWith("Doing ", "well.");
    const adapter = createAnthropicAdapter({ apiKey: "sk-ant-test", baseURL: anthropic.baseUrl });

    expect(await call(adapter, "claude-opus-5-5")).toEqual({
      pieces: ["Doing ", "well."],
      usage: { inputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 100, outputTokens: 7, reportedCostMicros: null },
    });
    const { body, headers } = anthropic.requests.at(-1)!;
    expect(headers.authorization).toBe("Bearer sk-ant-test");
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      system: "You are Scout.",
      cache_control: { type: "ephemeral" },
      messages: conversation,
      fallbacks: "default",
    });
  });

  test("Claude Haiku 5.5 has no server-side fallback, so none is asked for", async () => {
    const adapter = createAnthropicAdapter({ apiKey: "sk-ant-test", baseURL: anthropic.baseUrl });

    await call(adapter, "claude-haiku-5-5");

    expect(anthropic.requests.at(-1)!.body.fallbacks).toBeUndefined();
  });

  test("Google, on the Gemini API, with the instructions as the system instruction; thinking counts as output", async () => {
    gemini.replyWith("Very ", "well.");
    const adapter = createGoogleAdapter({ apiKey: "gemini-test", baseURL: gemini.baseUrl });

    expect(await call(adapter, "gemini-4-argon")).toEqual({
      pieces: ["Very ", "well."],
      usage: { inputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 10, reportedCostMicros: null },
    });
    const { body, path } = gemini.requests.at(-1)!;
    expect(path).toContain("gemini-4-argon");
    expect(body).toMatchObject({
      contents: [
        { role: "user", parts: [{ text: "Hi" }] },
        { role: "model", parts: [{ text: "Hello." }] },
        { role: "user", parts: [{ text: "How are you?" }] },
      ],
      systemInstruction: { parts: [{ text: "You are Scout." }] },
    });
  });

  test("OpenRouter, through the OpenAI-compatible adapter, carries OpenRouter's reported cost", async () => {
    chatCompletions.replyWith("Routed ", "reply.");
    chatCompletions.costUsd = 0.00042;
    const adapter = createOpenAICompatibleAdapter({ apiKey: "sk-or-test", baseURL: chatCompletions.baseUrl });

    const result = await call(adapter, "openrouter:mistralai/mistral-large");
    chatCompletions.costUsd = null;

    expect(result).toEqual({
      pieces: ["Routed ", "reply."],
      usage: { inputTokens: 24, cacheReadTokens: 16, cacheWriteTokens: 0, outputTokens: 9, reportedCostMicros: 420 },
    });
    expect(chatCompletions.requests.at(-1)!.body).toMatchObject({
      model: "mistralai/mistral-large",
      messages: [{ role: "system", content: "You are Scout." }, ...conversation],
    });
  });

  test("a local model server shares the OpenAI-compatible adapter and reports no cost", async () => {
    chatCompletions.replyWith("Local ", "reply.");
    const adapter = createOpenAICompatibleAdapter({ apiKey: "local", baseURL: chatCompletions.baseUrl });

    const result = await call(adapter, "local:llama4");

    expect(result.pieces).toEqual(["Local ", "reply."]);
    expect(result.usage?.reportedCostMicros).toBeNull();
    expect(chatCompletions.requests.at(-1)!.body.model).toBe("llama4");
  });
});
