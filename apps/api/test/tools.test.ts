import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ConversationItem, FunctionTool, ModelAdapter, ModelEvent, ModelRequest } from "../src/models/adapter.ts";
import { createAnthropicAdapter } from "../src/models/anthropic.ts";
import { createGoogleAdapter } from "../src/models/google.ts";
import { createOpenAIAdapter } from "../src/models/openai.ts";
import { createOpenAICompatibleAdapter } from "../src/models/openai-compatible.ts";
import { FakeAnthropic, FakeChatCompletions, FakeGemini } from "./fake-models.ts";
import { FAKE_OPENAI_KEY, FakeOpenAI } from "./fake-openai.ts";

// Each Model provider's adapter, against its local fake: our own function tools, and the
// Driver models' computer-use tools, whose actions arrive as the Computer agent's actions.

const anthropic = new FakeAnthropic();
const openai = new FakeOpenAI();
const gemini = new FakeGemini();
const chatCompletions = new FakeChatCompletions();
beforeAll(() => Promise.all([anthropic.start(), openai.start(), gemini.start(), chatCompletions.start("/v1")]));
afterAll(() => Promise.all([anthropic.stop(), openai.stop(), gemini.stop(), chatCompletions.stop()]));

const USE_COMPUTER: FunctionTool = {
  name: "use_computer",
  description: "Hands a task to the Bot's Computer.",
  parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
};
const SCREEN = { width: 1280, height: 800 };
/** A 1x1 PNG, as the Computer agent sends screenshots. */
const SCREENSHOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";

async function events(adapter: ModelAdapter, request: Partial<ModelRequest>): Promise<ModelEvent[]> {
  const all: ModelEvent[] = [];
  for await (const event of adapter.stream({ model: "claude-haiku-5-5", instructions: "Be brief.", conversation: [], ...request })) {
    all.push(event);
  }
  return all;
}

function turnOf(all: ModelEvent[]): unknown {
  const done = all.find((event) => event.type === "done");
  expect(done).toBeDefined();
  return (done as { turn: unknown }).turn;
}

describe("Anthropic", () => {
  const adapter = () => createAnthropicAdapter({ apiKey: "sk-ant-test", baseURL: anthropic.baseUrl });
  const ask: ConversationItem = { role: "user", content: "Book me a table." };

  test("the model calls one of our functions, and the next call carries the result after the model's own turn", async () => {
    anthropic.useTools({ name: "use_computer", input: { task: "Open the booking site." } });
    const first = await events(adapter(), { conversation: [ask], tools: [USE_COMPUTER] });

    expect(anthropic.requests.at(-1)!.body.tools).toEqual([
      { name: "use_computer", description: USE_COMPUTER.description, input_schema: USE_COMPUTER.parameters },
    ]);
    expect(first).toContainEqual({
      type: "tool_call",
      call: { id: "toolu_0", name: "use_computer", input: { task: "Open the booking site." } },
    });

    await events(adapter(), {
      tools: [USE_COMPUTER],
      conversation: [
        ask,
        { role: "turn", raw: turnOf(first) },
        { role: "tool_results", results: [{ toolCallId: "toolu_0", name: "use_computer", output: "Booked for 8pm." }] },
      ],
    });
    const messages = anthropic.requests.at(-1)!.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: expect.arrayContaining([expect.objectContaining({ type: "tool_use", id: "toolu_0", name: "use_computer" })]),
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "Booked for 8pm." }],
    });
  });

  test("a Driver model gets the computer toolset; its actions arrive as the Computer agent's, and screenshots go back as images", async () => {
    anthropic.useTools(
      { name: "left_click", input: { coordinate: [100, 200] }, toolset: "computer" },
      { name: "type", input: { text: "Kovobot" }, toolset: "computer" },
      { name: "key", input: { text: "ctrl+Return" }, toolset: "computer" },
      { name: "scroll", input: { coordinate: [640, 400], scroll_direction: "down", scroll_amount: 5 }, toolset: "computer" },
      { name: "screenshot", input: {}, toolset: "computer" },
      { name: "zoom", input: { region: [0, 0, 10, 10] }, toolset: "computer" },
    );
    const turn = await events(adapter(), { conversation: [ask], computer: SCREEN });

    expect(anthropic.requests.at(-1)!.body.tools).toEqual([
      { type: "computer_toolset_20260801", configs: { zoom: { enabled: false }, hold_key: { enabled: false } } },
    ]);
    const call = turn.find((event) => event.type === "computer_call");
    expect(call).toEqual({
      type: "computer_call",
      call: {
        safetyChecks: [],
        steps: [
          { id: "toolu_0", name: "left_click", screenshot: false, actions: [{ type: "click", x: 100, y: 200, button: "left", count: 1 }] },
          { id: "toolu_1", name: "type", screenshot: false, actions: [{ type: "type", text: "Kovobot" }] },
          { id: "toolu_2", name: "key", screenshot: false, actions: [{ type: "keys", keys: "ctrl+Return" }] },
          { id: "toolu_3", name: "scroll", screenshot: false, actions: [{ type: "scroll", x: 640, y: 400, dx: 0, dy: 5 }] },
          { id: "toolu_4", name: "screenshot", screenshot: true, actions: [] },
          { id: "toolu_5", name: "zoom", screenshot: false, actions: [], unsupported: 'The Computer can\'t do "zoom".' },
        ],
      },
    });

    await events(adapter(), {
      computer: SCREEN,
      conversation: [
        ask,
        { role: "turn", raw: turnOf(turn) },
        {
          role: "computer_results",
          results: [
            { id: "toolu_0", name: "left_click", text: "OK" },
            { id: "toolu_4", name: "screenshot", screenshot: SCREENSHOT },
            { id: "toolu_5", name: "zoom", error: 'The Computer can\'t do "zoom".' },
          ],
        },
      ],
    });
    const results = (anthropic.requests.at(-1)!.body.messages as Array<{ content: unknown }>)[2]!.content;
    expect(results).toEqual([
      { type: "tool_result", tool_use_id: "toolu_0", toolset_name: "computer", content: "OK" },
      {
        type: "tool_result",
        tool_use_id: "toolu_4",
        toolset_name: "computer",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: SCREENSHOT } }],
      },
      { type: "tool_result", tool_use_id: "toolu_5", toolset_name: "computer", is_error: true, content: 'The Computer can\'t do "zoom".' },
    ]);
  });
});

describe("OpenAI", () => {
  const adapter = () => createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl });
  const ask: ConversationItem = { role: "user", content: "Book me a table." };

  test("the model calls one of our functions, and the next call carries the result after the model's own output", async () => {
    openai.addOutput({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "use_computer",
      arguments: JSON.stringify({ task: "Open the booking site." }),
      status: "completed",
    });
    const first = await events(adapter(), { model: "gpt-6-luna", conversation: [ask], tools: [USE_COMPUTER] });

    expect(openai.requests.at(-1)!.tools).toEqual([
      { type: "function", name: "use_computer", description: USE_COMPUTER.description, parameters: USE_COMPUTER.parameters, strict: false },
    ]);
    // Conversations aren't stored at OpenAI, so reasoning comes back encrypted to replay in the Task.
    expect(openai.requests.at(-1)!.include).toEqual(["reasoning.encrypted_content"]);
    expect(first).toContainEqual({
      type: "tool_call",
      call: { id: "call_1", name: "use_computer", input: { task: "Open the booking site." } },
    });

    await events(adapter(), {
      model: "gpt-6-luna",
      tools: [USE_COMPUTER],
      conversation: [
        ask,
        { role: "turn", raw: turnOf(first) },
        { role: "tool_results", results: [{ toolCallId: "call_1", name: "use_computer", output: "Booked for 8pm." }] },
      ],
    });
    const input = openai.requests.at(-1)!.input;
    expect(input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_1", name: "use_computer" }));
    expect(input.at(-1)).toEqual({ type: "function_call_output", call_id: "call_1", output: "Booked for 8pm." });
  });

  test("a Driver model gets the computer tool; its batch of actions is one step, answered with a screenshot", async () => {
    openai.addOutput({
      type: "computer_call",
      id: "cu_1",
      call_id: "call_2",
      status: "completed",
      pending_safety_checks: [{ id: "sc_1", code: "malicious_instructions", message: "The page asks for your password." }],
      actions: [
        { type: "click", button: "left", x: 10, y: 20 },
        { type: "double_click", x: 30, y: 40 },
        { type: "keypress", keys: ["CTRL", "L"] },
        { type: "type", text: "kovobot.com" },
        { type: "scroll", x: 5, y: 6, scroll_x: 0, scroll_y: 300 },
        { type: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
        { type: "move", x: 7, y: 8 },
        { type: "wait" },
        { type: "screenshot" },
      ],
    });
    const turn = await events(adapter(), { model: "gpt-6-astra", conversation: [ask], computer: SCREEN });

    expect(openai.requests.at(-1)!.tools).toEqual([{ type: "computer" }]);
    expect(turn.find((event) => event.type === "computer_call")).toEqual({
      type: "computer_call",
      call: {
        safetyChecks: [{ id: "sc_1", message: "The page asks for your password." }],
        steps: [
          {
            id: "call_2",
            name: "computer_call",
            screenshot: true,
            actions: [
              { type: "click", x: 10, y: 20, button: "left", count: 1 },
              { type: "click", x: 30, y: 40, button: "left", count: 2 },
              { type: "keys", keys: "ctrl+l" },
              { type: "type", text: "kovobot.com" },
              { type: "scroll", x: 5, y: 6, dx: 0, dy: 3 },
              { type: "drag", path: [[1, 2], [3, 4]] },
              { type: "move", x: 7, y: 8 },
              { type: "wait", ms: 2000 },
            ],
          },
        ],
      },
    });

    await events(adapter(), {
      model: "gpt-6-astra",
      computer: SCREEN,
      conversation: [
        ask,
        { role: "turn", raw: turnOf(turn) },
        { role: "computer_results", results: [{ id: "call_2", name: "computer_call", screenshot: SCREENSHOT }] },
      ],
    });
    expect(openai.requests.at(-1)!.input.at(-1)).toEqual({
      type: "computer_call_output",
      call_id: "call_2",
      output: { type: "computer_screenshot", image_url: `data:image/png;base64,${SCREENSHOT}` },
    });
  });
});

describe("Google", () => {
  const adapter = () => createGoogleAdapter({ apiKey: "gemini-test", baseURL: gemini.baseUrl });
  const ask: ConversationItem = { role: "user", content: "Book me a table." };
  const lastBody = () => gemini.requests.at(-1)!.body as {
    tools?: unknown[];
    contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  };

  test("the model calls one of our functions, and the next call carries the result after the model's own turn", async () => {
    gemini.callFunctions({ id: "fn_1", name: "use_computer", args: { task: "Open the booking site." } });
    const first = await events(adapter(), { model: "gemini-4-argon", conversation: [ask], tools: [USE_COMPUTER] });

    expect(lastBody().tools).toEqual([
      { functionDeclarations: [{ name: "use_computer", description: USE_COMPUTER.description, parametersJsonSchema: USE_COMPUTER.parameters }] },
    ]);
    expect(first).toContainEqual({
      type: "tool_call",
      call: { id: "fn_1", name: "use_computer", input: { task: "Open the booking site." } },
    });

    await events(adapter(), {
      model: "gemini-4-argon",
      tools: [USE_COMPUTER],
      conversation: [
        ask,
        { role: "turn", raw: turnOf(first) },
        { role: "tool_results", results: [{ toolCallId: "fn_1", name: "use_computer", output: "Booked for 8pm." }] },
      ],
    });
    const contents = lastBody().contents;
    expect(contents[1]).toMatchObject({ role: "model", parts: expect.arrayContaining([{ functionCall: expect.objectContaining({ name: "use_computer" }) }]) });
    expect(contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { id: "fn_1", name: "use_computer", response: { output: "Booked for 8pm." } } }],
    });
  });

  // The desktop environment's actions are named as Google documents them and gemini-4-argon sent them live.
  test("a Driver model gets the computer-use tool; its 0-999 grid becomes the screen's pixels, and each call is answered with a screenshot", async () => {
    gemini.callFunctions(
      { name: "click", args: { x: 500, y: 250, intent: "Open the terminal" } },
      { name: "double_click", args: { x: 100, y: 100 } },
      { name: "triple_click", args: { x: 100, y: 100 } },
      { name: "right_click", args: { x: 100, y: 100 } },
      { name: "middle_click", args: { x: 100, y: 100 } },
      {
        name: "click",
        args: { x: 999, y: 0, safety_decision: { decision: "require_confirmation", explanation: "This buys something." } },
      },
      { name: "open_web_browser", args: {} },
    );
    const turn = await events(adapter(), { model: "gemini-4-argon", conversation: [ask], computer: SCREEN });

    expect(lastBody().tools).toEqual([{ computerUse: { environment: "ENVIRONMENT_DESKTOP" } }]);
    const click = (button: string, count: number, x = 128, y = 80) => [{ type: "click", x, y, button, count }];
    expect(turn.find((event) => event.type === "computer_call")).toEqual({
      type: "computer_call",
      call: {
        safetyChecks: [{ id: "gemini-5", message: "This buys something." }],
        steps: [
          { id: "gemini-0", name: "click", screenshot: true, actions: click("left", 1, 640, 200) },
          { id: "gemini-1", name: "double_click", screenshot: true, actions: click("left", 2) },
          { id: "gemini-2", name: "triple_click", screenshot: true, actions: click("left", 3) },
          { id: "gemini-3", name: "right_click", screenshot: true, actions: click("right", 1) },
          { id: "gemini-4", name: "middle_click", screenshot: true, actions: click("middle", 1) },
          { id: "gemini-5", name: "click", screenshot: true, actions: click("left", 1, 1279, 0) },
          expect.objectContaining({ id: "gemini-6", name: "open_web_browser", actions: [], unsupported: expect.any(String) }),
        ],
      },
    });

    await events(adapter(), {
      model: "gemini-4-argon",
      computer: SCREEN,
      conversation: [
        ask,
        { role: "turn", raw: turnOf(turn) },
        { role: "computer_results", results: [{ id: "gemini-0", name: "click", screenshot: SCREENSHOT }] },
      ],
    });
    expect(lastBody().contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "click", response: {}, parts: [{ inlineData: { mimeType: "image/png", data: SCREENSHOT } }] } }],
    });
  });

  test("Gemini types where the focus is, and presses keys and key combinations by its own names", async () => {
    gemini.callFunctions(
      { name: "type", args: { text: "uname -sr", press_enter: true } },
      { name: "type", args: { text: "kovobot" } },
      { name: "press_key", args: { key: "enter" } },
      { name: "hotkey", args: { keys: ["control", "shift", "t"] } },
    );
    const turn = await events(adapter(), { model: "gemini-4-argon", conversation: [ask], computer: SCREEN });

    expect(turn.find((event) => event.type === "computer_call")).toMatchObject({
      call: {
        steps: [
          { name: "type", actions: [{ type: "type", text: "uname -sr" }, { type: "keys", keys: "Return" }] },
          { name: "type", actions: [{ type: "type", text: "kovobot" }] },
          { name: "press_key", actions: [{ type: "keys", keys: "Return" }] },
          { name: "hotkey", actions: [{ type: "keys", keys: "ctrl+shift+t" }] },
        ],
      },
    });
  });

  test("Gemini moves, presses, drags, scrolls and waits on the same grid; holding keys down isn't possible", async () => {
    gemini.callFunctions(
      { name: "move", args: { x: 500, y: 250 } },
      { name: "mouse_down", args: { x: 100, y: 100 } },
      { name: "mouse_up", args: { x: 500, y: 250 } },
      { name: "drag_and_drop", args: { start_x: 100, start_y: 100, end_x: 500, end_y: 250 } },
      { name: "scroll", args: { x: 500, y: 500, direction: "down", magnitude_in_pixels: 500 } },
      { name: "scroll", args: { x: 500, y: 500, direction: "left" } },
      { name: "wait", args: { seconds: 2 } },
      { name: "wait", args: {} },
      { name: "take_screenshot", args: {} },
      { name: "key_down", args: { key: "shift" } },
    );
    const turn = await events(adapter(), { model: "gemini-4-argon", conversation: [ask], computer: SCREEN });

    expect(turn.find((event) => event.type === "computer_call")).toMatchObject({
      call: {
        steps: [
          { name: "move", actions: [{ type: "move", x: 640, y: 200 }] },
          { name: "mouse_down", actions: [{ type: "move", x: 128, y: 80 }, { type: "mouse_down", button: "left" }] },
          { name: "mouse_up", actions: [{ type: "move", x: 640, y: 200 }, { type: "mouse_up", button: "left" }] },
          { name: "drag_and_drop", actions: [{ type: "drag", path: [[128, 80], [640, 200]] }] },
          { name: "scroll", actions: [{ type: "scroll", x: 640, y: 400, dx: 0, dy: 5 }] },
          { name: "scroll", actions: [{ type: "scroll", x: 640, y: 400, dx: -3, dy: 0 }] },
          { name: "wait", actions: [{ type: "wait", ms: 2000 }] },
          { name: "wait", actions: [{ type: "wait", ms: 1000 }] },
          { name: "take_screenshot", actions: [], screenshot: true },
          { name: "key_down", actions: [], unsupported: expect.stringContaining("hotkey") },
        ],
      },
    });
  });
});

describe("OpenRouter and local model servers (Chat Completions)", () => {
  const adapter = () => createOpenAICompatibleAdapter({ apiKey: "sk-or-test", baseURL: chatCompletions.baseUrl });
  const ask: ConversationItem = { role: "user", content: "Book me a table." };

  test("the model calls one of our functions, its arguments streamed in pieces, and the next call carries the result", async () => {
    chatCompletions.callTools({ id: "call_9", name: "use_computer", args: { task: "Open the booking site." } });
    const first = await events(adapter(), { model: "openrouter:mistralai/mistral-large", conversation: [ask], tools: [USE_COMPUTER] });

    expect(chatCompletions.requests.at(-1)!.body.tools).toEqual([
      { type: "function", function: { name: "use_computer", description: USE_COMPUTER.description, parameters: USE_COMPUTER.parameters } },
    ]);
    expect(first).toContainEqual({
      type: "tool_call",
      call: { id: "call_9", name: "use_computer", input: { task: "Open the booking site." } },
    });

    await events(adapter(), {
      model: "openrouter:mistralai/mistral-large",
      tools: [USE_COMPUTER],
      conversation: [
        ask,
        { role: "turn", raw: turnOf(first) },
        { role: "tool_results", results: [{ toolCallId: "call_9", name: "use_computer", output: "Booked for 8pm." }] },
      ],
    });
    const messages = chatCompletions.requests.at(-1)!.body.messages as Array<Record<string, unknown>>;
    expect(messages[2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_9", type: "function", function: { name: "use_computer", arguments: JSON.stringify({ task: "Open the booking site." }) } }],
    });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_9", content: "Booked for 8pm." });
  });
});
