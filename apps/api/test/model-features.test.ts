import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ConversationItem, ModelAdapter, ModelEvent, ModelRequest } from "../src/models/adapter.ts";
import { createAnthropicAdapter } from "../src/models/anthropic.ts";
import { createGoogleAdapter } from "../src/models/google.ts";
import { createOpenAIAdapter } from "../src/models/openai.ts";
import { createOpenAICompatibleAdapter } from "../src/models/openai-compatible.ts";
import { FakeAnthropic, FakeChatCompletions, FakeGemini } from "./fake-models.ts";
import { FAKE_OPENAI_KEY, FakeOpenAI } from "./fake-openai.ts";

// What chat adds to a model call: the model's thinking, shown as it thinks; thinking harder;
// the Model provider's own web search, with its sources; and files the Customer attaches.
// Each Model provider's adapter against its local fake.

const anthropic = new FakeAnthropic();
const openai = new FakeOpenAI();
const gemini = new FakeGemini();
const chatCompletions = new FakeChatCompletions();

beforeAll(() => Promise.all([anthropic.start(), openai.start(), gemini.start(), chatCompletions.start("/v1")]));
afterAll(() => Promise.all([anthropic.stop(), openai.stop(), gemini.stop(), chatCompletions.stop()]));

const ask: ConversationItem = { role: "user", content: "What is seven times six?" };

async function events(adapter: ModelAdapter, request: Partial<ModelRequest> & { model: string }): Promise<ModelEvent[]> {
  const seen: ModelEvent[] = [];
  for await (const event of adapter.stream({ instructions: "You are Scout.", conversation: [ask], ...request })) seen.push(event);
  return seen;
}

const thinkingOf = (seen: ModelEvent[]) => seen.flatMap((event) => (event.type === "thinking" ? [event.text] : []));
const textOf = (seen: ModelEvent[]) => seen.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");

describe("Anthropic", () => {
  const adapter = () => createAnthropicAdapter({ apiKey: "sk-ant-test", baseURL: anthropic.baseUrl });
  const lastBody = () => anthropic.requests.at(-1)!.body;

  test("its thinking streams as it thinks; thinking harder takes more effort; Driver models aren't asked to think", async () => {
    anthropic.thinkFirst("Seven times ", "six…");
    anthropic.replyWith("42.");
    const seen = await events(adapter(), { model: "claude-sonnet-5-5", thinking: "normal" });

    expect(thinkingOf(seen)).toEqual(["Seven times ", "six…"]);
    expect(textOf(seen)).toBe("42.");
    expect(lastBody().thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(lastBody()).not.toHaveProperty("output_config");

    await events(adapter(), { model: "claude-sonnet-5-5", thinking: "deep" });
    expect(lastBody()).toMatchObject({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "xhigh" } });

    await events(adapter(), { model: "claude-sonnet-5-5" });
    expect(lastBody()).not.toHaveProperty("thinking");
  });
});

describe("OpenAI and xAI (Responses API)", () => {
  const adapter = () => createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl });
  const lastBody = () => openai.requests.at(-1)!;

  test("its reasoning summary streams as thinking; thinking harder raises the effort; Driver models aren't asked", async () => {
    openai.thinkFirst("Seven times ", "six…");
    openai.replyWith("42.");
    const seen = await events(adapter(), { model: "gpt-6-luna", thinking: "normal" });

    expect(thinkingOf(seen)).toEqual(["Seven times ", "six…"]);
    expect(textOf(seen)).toBe("42.");
    expect(lastBody().reasoning).toEqual({ summary: "auto" });

    await events(adapter(), { model: "gpt-6-luna", thinking: "deep" });
    expect(lastBody().reasoning).toEqual({ summary: "auto", effort: "high" });

    await events(adapter(), { model: "gpt-6-luna" });
    expect(lastBody()).not.toHaveProperty("reasoning");
  });

  test("xAI isn't sent reasoning options it may not take (unchecked: no xAI key here)", async () => {
    const xai = createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl, reasoningOptions: false });
    await events(xai, { model: "grok-4.7", thinking: "deep" });
    expect(lastBody()).not.toHaveProperty("reasoning");
  });
});

describe("Google (Gemini API)", () => {
  const adapter = () => createGoogleAdapter({ apiKey: "gemini-test", baseURL: gemini.baseUrl });
  const lastBody = () => gemini.requests.at(-1)!.body as { generationConfig?: Record<string, unknown>; tools?: unknown[] };

  test("its thoughts stream as thinking, never as the reply; thinking harder raises the level; Driver models aren't asked", async () => {
    gemini.thinkFirst("Seven times ", "six…");
    gemini.replyWith("42.");
    const seen = await events(adapter(), { model: "gemini-4-argon", thinking: "normal" });

    expect(thinkingOf(seen)).toEqual(["Seven times ", "six…"]);
    expect(textOf(seen)).toBe("42.");
    expect(lastBody().generationConfig?.thinkingConfig).toEqual({ includeThoughts: true });

    await events(adapter(), { model: "gemini-4-argon", thinking: "deep" });
    expect(lastBody().generationConfig?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });

    await events(adapter(), { model: "gemini-4-argon" });
    expect(lastBody().generationConfig ?? {}).not.toHaveProperty("thinkingConfig");
  });
});
describe("OpenRouter and local model servers (Chat Completions)", () => {
  const adapter = () => createOpenAICompatibleAdapter({ apiKey: "sk-or-test", baseURL: chatCompletions.baseUrl });
  const lastBody = () => chatCompletions.requests.at(-1)!.body;

  test("reasoning streams as thinking, from OpenRouter's field or a local server's; thinking harder asks each its own way", async () => {
    chatCompletions.thinkFirst("Seven times ", "six…");
    chatCompletions.replyWith("42.");
    const seen = await events(adapter(), { model: "openrouter:deepseek/deepseek-v4.1-flash", thinking: "normal" });
    expect(thinkingOf(seen)).toEqual(["Seven times ", "six…"]);
    expect(textOf(seen)).toBe("42.");
    expect(lastBody()).not.toHaveProperty("reasoning");

    await events(adapter(), { model: "openrouter:deepseek/deepseek-v4.1-flash", thinking: "deep" });
    expect(lastBody().reasoning).toEqual({ effort: "high" });

    chatCompletions.reasoningField = "reasoning_content";
    try {
      chatCompletions.thinkFirst("Hmm.");
      const local = await events(adapter(), { model: "local:qwen3", thinking: "deep" });
      expect(thinkingOf(local)).toEqual(["Hmm."]);
      expect(lastBody()).toMatchObject({ reasoning_effort: "high" });
      expect(lastBody()).not.toHaveProperty("reasoning");
    } finally {
      chatCompletions.reasoningField = "reasoning";
    }
  });
});

const SOURCES = [
  { url: "https://nodejs.org/en/blog/release", title: "Node.js releases" },
  { url: "https://github.com/nodejs/node/releases", title: "Releases · nodejs/node" },
];
const sourcesOf = (seen: ModelEvent[]) => seen.find((event) => event.type === "sources");

describe("web search", () => {
  test("Anthropic: its web search tool, capped per reply, and the pages its reply cites", async () => {
    const adapter = createAnthropicAdapter({ apiKey: "sk-ant-test", baseURL: anthropic.baseUrl });
    anthropic.citeSources(...SOURCES, SOURCES[0]!);
    anthropic.replyWith("Node 26 is current.");
    const seen = await events(adapter, { model: "claude-sonnet-5-5", webSearch: true });

    expect(anthropic.requests.at(-1)!.body.tools).toEqual([{ type: "web_search_20260318", name: "web_search", max_uses: 5 }]);
    expect(textOf(seen)).toBe("Node 26 is current.");
    expect(sourcesOf(seen)).toEqual({ type: "sources", sources: SOURCES });

    await events(adapter, { model: "claude-sonnet-5-5" });
    expect(anthropic.requests.at(-1)!.body).not.toHaveProperty("tools");
  });

  test("OpenAI: its web_search tool, built-in calls capped, and the pages its reply cites", async () => {
    const adapter = createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl });
    openai.citeSources(...SOURCES);
    openai.replyWith("Node 26 is current.");
    const seen = await events(adapter, { model: "gpt-6-luna", webSearch: true });

    expect(openai.requests.at(-1)).toMatchObject({ tools: [{ type: "web_search" }], max_tool_calls: 5 });
    expect(sourcesOf(seen)).toEqual({ type: "sources", sources: SOURCES });
  });

  test("Google: grounding with Google Search, beside our own functions, with its sources and search suggestions", async () => {
    const adapter = createGoogleAdapter({ apiKey: "gemini-test", baseURL: gemini.baseUrl });
    const lastBody = () => gemini.requests.at(-1)!.body as { tools?: unknown[]; toolConfig?: unknown };
    gemini.citeSources(...SOURCES);
    gemini.replyWith("Node 26 is current.");
    const seen = await events(adapter, { model: "gemini-4-argon", webSearch: true });

    expect(lastBody().tools).toEqual([{ googleSearch: {} }]);
    expect(lastBody()).not.toHaveProperty("toolConfig");
    expect(sourcesOf(seen)).toEqual({
      type: "sources",
      sources: SOURCES,
      searchSuggestions: '<div class="fake-suggestions">fake query</div>',
    });

    // Gemini takes its own tools beside function calling only when told it may.
    const useComputer = { name: "use_computer", description: "Does a task on your Computer.", parameters: { type: "object" } };
    await events(adapter, { model: "gemini-4-argon", webSearch: true, tools: [useComputer] });
    expect(lastBody().tools).toEqual([
      { functionDeclarations: [{ name: "use_computer", description: "Does a task on your Computer.", parametersJsonSchema: { type: "object" } }] },
      { googleSearch: {} },
    ]);
    expect(lastBody().toolConfig).toEqual({ includeServerSideToolInvocations: true });
  });

  test("OpenRouter: its web plugin, a few results at most, and the pages its reply cites; local servers have none", async () => {
    const adapter = createOpenAICompatibleAdapter({ apiKey: "sk-or-test", baseURL: chatCompletions.baseUrl });
    chatCompletions.citeSources(...SOURCES);
    chatCompletions.replyWith("Node 26 is current.");
    const seen = await events(adapter, { model: "openrouter:deepseek/deepseek-v4.1-flash", webSearch: true });

    expect(chatCompletions.requests.at(-1)!.body.plugins).toEqual([{ id: "web", max_results: 5 }]);
    expect(sourcesOf(seen)).toEqual({ type: "sources", sources: SOURCES });

    await events(adapter, { model: "local:qwen3", webSearch: true });
    expect(chatCompletions.requests.at(-1)!.body).not.toHaveProperty("plugins");
  });
});

// A one-pixel PNG and a tiny PDF, as base64.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n").toString("base64");
const withFiles: ConversationItem = {
  role: "user",
  content: "What's in these?",
  attachments: [
    { name: "photo.png", mediaType: "image/png", data: PNG },
    { name: "report.pdf", mediaType: "application/pdf", data: PDF },
  ],
};

describe("attachments", () => {
  test("Anthropic: images and PDFs as image and document blocks, before the words", async () => {
    const adapter = createAnthropicAdapter({ apiKey: "sk-ant-test", baseURL: anthropic.baseUrl });
    await events(adapter, { model: "claude-sonnet-5-5", conversation: [withFiles] });
    expect((anthropic.requests.at(-1)!.body.messages as unknown[])[0]).toEqual({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF }, title: "report.pdf" },
        { type: "text", text: "What's in these?" },
      ],
    });
  });

  test("OpenAI: images and PDFs as input_image and input_file", async () => {
    const adapter = createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl });
    await events(adapter, { model: "gpt-6-luna", conversation: [withFiles] });
    expect(openai.requests.at(-1)!.input[0]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "What's in these?" },
        { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" },
        { type: "input_file", filename: "report.pdf", file_data: `data:application/pdf;base64,${PDF}` },
      ],
    });
  });

  test("Google: images and PDFs as inline data", async () => {
    const adapter = createGoogleAdapter({ apiKey: "gemini-test", baseURL: gemini.baseUrl });
    await events(adapter, { model: "gemini-4-argon", conversation: [withFiles] });
    expect((gemini.requests.at(-1)!.body.contents as unknown[])[0]).toEqual({
      role: "user",
      parts: [
        { text: "What's in these?" },
        { inlineData: { mimeType: "image/png", data: PNG } },
        { inlineData: { mimeType: "application/pdf", data: PDF } },
      ],
    });
  });

  test("OpenRouter and local servers: images as image_url, PDFs as file parts", async () => {
    const adapter = createOpenAICompatibleAdapter({ apiKey: "sk-or-test", baseURL: chatCompletions.baseUrl });
    await events(adapter, { model: "openrouter:deepseek/deepseek-v4.1-flash", conversation: [withFiles] });
    expect((chatCompletions.requests.at(-1)!.body.messages as unknown[])[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What's in these?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
        { type: "file", file: { filename: "report.pdf", file_data: `data:application/pdf;base64,${PDF}` } },
      ],
    });
  });

  test("a message of files alone sends no empty text", async () => {
    const adapter = createAnthropicAdapter({ apiKey: "sk-ant-test", baseURL: anthropic.baseUrl });
    await events(adapter, { model: "claude-sonnet-5-5", conversation: [{ ...withFiles, content: "" }] });
    const sent = (anthropic.requests.at(-1)!.body.messages as Array<{ content: Array<{ type: string }> }>)[0]!.content;
    expect(sent.map((block) => block.type)).toEqual(["image", "document"]);
  });
});
