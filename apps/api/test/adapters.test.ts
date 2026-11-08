import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { type ModelAdapter, ModelError, type ModelUsage } from "../src/models/adapter.ts";
import { createModelAdapters } from "../src/models/adapters.ts";
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
async function call(adapter: ModelAdapter, model: string): Promise<{ pieces: string[]; usage: ModelUsage[] }> {
  const pieces: string[] = [];
  let usage: ModelUsage[] | undefined;
  for await (const event of adapter.stream({ model, instructions: "You are Scout.", conversation })) {
    if (event.type === "text") pieces.push(event.text);
    else usage = event.usage;
  }
  expect(usage, "a done event").not.toBeUndefined();
  return { pieces, usage: usage! };
}

const anthropicAdapter = () => createAnthropicAdapter({ apiKey: "sk-ant-test", baseURL: anthropic.baseUrl });
const geminiAdapter = () => createGoogleAdapter({ apiKey: "gemini-test", baseURL: gemini.baseUrl });
const chatAdapter = () => createOpenAICompatibleAdapter({ apiKey: "sk-or-test", baseURL: chatCompletions.baseUrl });

describe("every Model provider streams through one seam and reports usage in one shape", () => {
  test("OpenAI, on the Responses API", async () => {
    openai.replyWith("Fine, ", "thanks.");
    const adapter = createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl });

    expect(await call(adapter, "gpt-6-luna")).toEqual({
      pieces: ["Fine, ", "thanks."],
      usage: [
        { model: "gpt-6-luna", inputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reportedCostMicros: null },
      ],
    });
  });

  test("xAI, through the OpenAI adapter, keeps xAI's reported cost as a cross-check", async () => {
    openai.replyWith("Grok here.");
    openai.costTicks = 4_200_000; // 10^10 ticks per US dollar
    const adapter = createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl });

    const { usage } = await call(adapter, "grok-4.7");
    openai.costTicks = null;

    expect(usage).toMatchObject([{ model: "grok-4.7", reportedCostMicros: 420 }]);
  });

  test("Anthropic, on the Messages API, with the Bot's instructions as the system prompt and prompt caching on", async () => {
    anthropic.replyWith("Doing ", "well.");

    expect(await call(anthropicAdapter(), "claude-opus-5-5")).toEqual({
      pieces: ["Doing ", "well."],
      usage: [
        { model: "claude-opus-5-5", inputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 100, outputTokens: 7, reportedCostMicros: null },
      ],
    });
    const { body, headers } = anthropic.requests.at(-1)!;
    expect(headers.authorization).toBe("Bearer sk-ant-test");
    expect(headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      system: "You are Scout.",
      cache_control: { type: "ephemeral" },
      messages: conversation,
      fallbacks: "default",
    });
  });

  test("an Anthropic key that isn't scoped to a workspace names its workspace on every call", async () => {
    const adapter = createAnthropicAdapter({ apiKey: "sk-ant-test", baseURL: anthropic.baseUrl, workspaceId: "wrkspc_01" });

    await call(adapter, "claude-haiku-5-5");

    expect(anthropic.requests.at(-1)!.headers["anthropic-workspace-id"]).toBe("wrkspc_01");
  });

  test("Claude Haiku 5.5 has no server-side fallback, so none is asked for", async () => {
    await call(anthropicAdapter(), "claude-haiku-5-5");

    const { body, headers } = anthropic.requests.at(-1)!;
    expect(body.fallbacks).toBeUndefined();
    expect(headers["anthropic-beta"] ?? "").not.toContain("server-side-fallback");
  });

  test("Google, on the Gemini API, with the instructions as the system instruction; thinking counts as output", async () => {
    gemini.replyWith("Very ", "well.");

    expect(await call(geminiAdapter(), "gemini-4-argon")).toEqual({
      pieces: ["Very ", "well."],
      usage: [
        { model: "gemini-4-argon", inputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 10, reportedCostMicros: null },
      ],
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

  test("OpenRouter, through the OpenAI-compatible adapter, carries OpenRouter's reported cost and cache writes", async () => {
    chatCompletions.replyWith("Routed ", "reply.");
    chatCompletions.costUsd = 0.00042;

    const result = await call(chatAdapter(), "openrouter:mistralai/mistral-large");
    chatCompletions.costUsd = null;

    expect(result).toEqual({
      pieces: ["Routed ", "reply."],
      usage: [
        {
          model: "openrouter:mistralai/mistral-large",
          inputTokens: 16,
          cacheReadTokens: 16,
          cacheWriteTokens: 8,
          outputTokens: 9,
          reportedCostMicros: 420,
        },
      ],
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
    expect(result.usage).toMatchObject([{ model: "local:llama4", reportedCostMicros: null }]);
    expect(chatCompletions.requests.at(-1)!.body.model).toBe("llama4");
  });
});

describe("when a Claude model declines, another answers in the same call", () => {
  test("each attempt's usage is reported against the model that ran it", async () => {
    anthropic.replyWith("Here is ", "the answer.");
    anthropic.endNextReply({ kind: "fall-back", to: "claude-opus-4-8" });

    expect(await call(anthropicAdapter(), "claude-opus-5-5")).toEqual({
      pieces: ["Here is ", "the answer."],
      usage: [
        { model: "claude-opus-5-5", inputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 400, outputTokens: 0, reportedCostMicros: null },
        { model: "claude-opus-4-8", inputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 100, outputTokens: 7, reportedCostMicros: null },
      ],
    });
  });
});

describe("a reply that doesn't finish is an error, never a finished reply", () => {
  /** The error a call ends with; it fails the test if the call finishes instead. */
  const failure = (adapter: ModelAdapter, model: string) =>
    call(adapter, model).then(
      () => expect.unreachable("the call finished"),
      (error: unknown) => error,
    );
  const openaiAdapter = () => createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl });

  test("OpenAI: a failed request", async () => {
    openai.failWith(500);
    expect(await failure(openaiAdapter(), "gpt-6-luna")).toMatchObject({ name: "ModelError" });
    openai.replyWith("Hello!");
  });

  test("OpenAI: a stream that breaks before the reply ends", async () => {
    openai.failMidStream("Part ");
    expect(await failure(openaiAdapter(), "gpt-6-luna")).toMatchObject({ name: "ModelError" });
    openai.replyWith("Hello!");
  });

  test("Anthropic: a refusal the whole fallback chain shares, carrying what the declined attempt used", async () => {
    anthropic.endNextReply({ kind: "stop", reason: "refusal" });
    expect(await failure(anthropicAdapter(), "claude-opus-5-5")).toMatchObject({
      name: "ModelError",
      message: expect.stringMatching(/declined/),
      usage: [{ model: "claude-opus-5-5", inputTokens: 20, outputTokens: 7 }],
    });
  });

  test("Anthropic: a stream that stops before the reply ends", async () => {
    anthropic.endNextReply({ kind: "cut-off" });
    expect(await failure(anthropicAdapter(), "claude-haiku-5-5")).toMatchObject({ name: "ModelError" });
  });

  test("Anthropic: a failed request", async () => {
    anthropic.endNextReply({ kind: "fail", status: 500 });
    expect(await failure(anthropicAdapter(), "claude-haiku-5-5")).toMatchObject({ name: "ModelError", message: expect.stringMatching(/failed/) });
  });

  test("Gemini: a blocked prompt, with no reply at all, carrying what the prompt used", async () => {
    gemini.endNextReply({ kind: "block-prompt", reason: "PROHIBITED_CONTENT" });
    expect(await failure(geminiAdapter(), "gemini-4-argon")).toMatchObject({
      name: "ModelError",
      message: expect.stringMatching(/PROHIBITED_CONTENT/),
      usage: [{ model: "gemini-4-argon", inputTokens: 20 }],
    });
  });

  test("Gemini: a reply stopped for safety", async () => {
    gemini.endNextReply({ kind: "stop", reason: "SAFETY" });
    expect(await failure(geminiAdapter(), "gemini-4-argon")).toMatchObject({
      message: expect.stringMatching(/SAFETY/),
      usage: [{ model: "gemini-4-argon" }],
    });
  });

  test("Gemini: a stream that stops before the reply ends", async () => {
    gemini.endNextReply({ kind: "cut-off" });
    expect(await failure(geminiAdapter(), "gemini-4-argon")).toMatchObject({ message: expect.stringMatching(/cut off/) });
  });

  test("Gemini: a failed request", async () => {
    gemini.endNextReply({ kind: "fail", status: 503 });
    expect(await failure(geminiAdapter(), "gemini-4-argon")).toMatchObject({ message: expect.stringMatching(/failed/) });
  });

  test("OpenRouter: a reply its content filter stopped, carrying what it used", async () => {
    chatCompletions.endNextReply({ kind: "stop", reason: "content_filter" });
    expect(await failure(chatAdapter(), "openrouter:mistralai/mistral-large")).toMatchObject({
      message: expect.stringMatching(/content_filter/),
      usage: [{ model: "openrouter:mistralai/mistral-large", outputTokens: 9 }],
    });
  });

  test("OpenRouter: a stream that stops before the reply ends", async () => {
    chatCompletions.endNextReply({ kind: "cut-off" });
    expect(await failure(chatAdapter(), "openrouter:mistralai/mistral-large")).toMatchObject({ message: expect.stringMatching(/cut off/) });
  });

  test("OpenRouter: a failed request", async () => {
    chatCompletions.endNextReply({ kind: "fail", status: 502 });
    expect(await failure(chatAdapter(), "openrouter:mistralai/mistral-large")).toMatchObject({ message: expect.stringMatching(/failed/) });
  });
});

describe("adapters built from the config", () => {
  test("each key switches on its Model provider, called at that Model provider's own address with that key", async () => {
    const seen: Array<{ url: string; headers: string }> = [];
    // The network is the edge here: record where each SDK would call, and answer with an error.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      seen.push({ url: `${url.origin}${url.pathname}`, headers: [...request.headers.values()].join(" ") });
      return Response.json({ error: { type: "invalid_request_error", message: "Not really called." } }, { status: 400 });
    });
    try {
      const adapters = createModelAdapters({
        modelKeys: {
          openai: "key-openai",
          anthropic: "key-anthropic",
          google: "key-google",
          xai: "key-xai",
          openrouter: "key-openrouter",
        },
        localModelsUrl: null,
        anthropicWorkspaceId: "wrkspc_01",
      });
      expect(adapters.local).toBeNull();
      const calls = [
        ["openai", "gpt-6-luna"],
        ["anthropic", "claude-haiku-5-5"],
        ["google", "gemini-4-argon"],
        ["xai", "grok-4.7"],
        ["openrouter", "openrouter:mistralai/mistral-large"],
      ] as const;
      for (const [modelProvider, model] of calls) {
        await expect(call(adapters[modelProvider]!, model)).rejects.toThrow(ModelError);
      }
    } finally {
      vi.unstubAllGlobals();
    }

    expect(seen.map(({ url }) => url)).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.anthropic.com/v1/messages",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:streamGenerateContent",
      "https://api.x.ai/v1/responses",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
    ["openai", "anthropic", "google", "xai", "openrouter"].forEach((name, index) => {
      expect(seen[index]!.headers).toContain(`key-${name}`);
    });
    expect(seen[1]!.headers).toContain("wrkspc_01");
  });

  test("no keys, no Model providers; a local model server only where one is set up", () => {
    const none = { openai: null, anthropic: null, google: null, xai: null, openrouter: null };

    expect(Object.values(createModelAdapters({ modelKeys: none, localModelsUrl: null, anthropicWorkspaceId: null }))).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    const local = createModelAdapters({ modelKeys: none, localModelsUrl: "http://127.0.0.1:11434/v1", anthropicWorkspaceId: null });
    expect(local.local).not.toBeNull();
  });
});
