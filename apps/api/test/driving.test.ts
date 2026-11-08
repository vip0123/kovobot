import { describe, expect, test } from "vitest";
import { SCREENSHOT_PNG } from "./fake-computer-service.ts";
import { type Browser, serverSentEvents, startTestServer, uniqueEmail } from "./harness.ts";

// A Bot drives its Computer (ticket 24): its chat model hands a task to its Driver model,
// which operates the Computer through its Model provider's computer-use tool.
const server = startTestServer({}, { computers: true });

interface Bot {
  id: string;
}

async function botWithComputer(driverModel: string | null, model = "gpt-6-luna"): Promise<{ browser: Browser; bot: Bot }> {
  const browser = server.browser();
  await server.signInByEmail(browser, uniqueEmail());
  const bot = ((await (await browser.post("/api/bots", { name: "Scout", model })).json()) as { bot: Bot }).bot;
  expect((await browser.post(`/api/bots/${bot.id}/computer`)).status).toBe(201);
  if (driverModel) {
    const patched = await browser.send(`/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { origin: server.config.appUrl, "content-type": "application/json" },
      body: JSON.stringify({ driverModel }),
    });
    expect(patched.status).toBe(200);
  }
  return { browser, bot };
}

function chat(browser: Browser, bot: Bot, content: string) {
  return browser.post(`/api/bots/${bot.id}/messages`, { content });
}

const actionsOn = (bot: Bot) => {
  const computer = [...server.computerService.computers.values()].find((candidate) => candidate.owner === bot.id)!;
  return server.computerService.actions.filter((done) => done.computerId === computer.id).map((done) => done.action);
};

describe("a Bot with a Computer and a Driver model", () => {
  test("hands a task to its Driver model, which operates the Computer and reports back", async () => {
    const { browser, bot } = await botWithComputer("claude-haiku-5-5");
    server.openai.addOutput({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "use_computer",
      arguments: JSON.stringify({ task: "Find the opening hours on kovobot.com." }),
      status: "completed",
    });
    server.openai.replyWith("Here's what I found.");
    server.anthropic.useTools(
      { name: "left_click", input: { coordinate: [10, 20] }, toolset: "computer" },
      { name: "type", input: { text: "kovobot.com" }, toolset: "computer" },
      { name: "screenshot", input: {}, toolset: "computer" },
    );
    server.anthropic.replyWith("Open 9 to 5.");

    const events = await serverSentEvents(await chat(browser, bot, "When is Kovobot open?"));

    // The Driver model's actions reached the Computer, and it was shown the screen.
    expect(actionsOn(bot)).toEqual([
      { type: "click", x: 10, y: 20, button: "left", count: 1 },
      { type: "type", text: "kovobot.com" },
      { type: "screenshot" },
    ]);
    const driverResults = (server.anthropic.requests.at(-1)!.body.messages as Array<{ content: unknown }>).at(-1)!.content;
    expect(driverResults).toContainEqual(
      expect.objectContaining({ content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: SCREENSHOT_PNG } }] }),
    );
    // The Driver model was told to stop and ask before paying, sending or deleting.
    expect(String(server.anthropic.requests.at(-1)!.body.system)).toMatch(/stop and ask before paying, sending .* or deleting/i);
    // Its report went back to the chat model as the tool's result.
    expect(server.openai.requests.at(-1)!.input.at(-1)).toEqual({ type: "function_call_output", call_id: "call_1", output: "Open 9 to 5." });
    expect(events).toContainEqual({ event: "status", data: { text: "Scout is using its Computer." } });
    expect(events.at(-1)).toMatchObject({ event: "done", data: { message: { role: "assistant" } } });
  });

  test("waits while the Customer has control of the Computer, and carries on once they hand back", async () => {
    const { browser, bot } = await botWithComputer("claude-haiku-5-5");
    const control = (inControl: boolean) => browser.post(`/api/bots/${bot.id}/computer/control`, { inControl });
    expect(await (await control(true)).json()).toMatchObject({ computer: { customerInControl: true } });

    server.openai.addOutput({
      type: "function_call",
      id: "fc_2",
      call_id: "call_2",
      name: "use_computer",
      arguments: JSON.stringify({ task: "Close the window." }),
      status: "completed",
    });
    server.anthropic.useTools({ name: "key", input: { text: "alt+F4" }, toolset: "computer" });
    server.anthropic.replyWith("Closed it.");
    const asked = server.anthropic.requests.length;
    // Read as it streams: a reply nobody reads stops at its first event.
    const replying = chat(browser, bot, "Close that window.").then(serverSentEvents);

    while (server.anthropic.requests.length === asked) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(actionsOn(bot)).toEqual([]);

    expect(await (await control(false)).json()).toMatchObject({ computer: { customerInControl: false } });
    const events = await replying;
    expect(actionsOn(bot)).toEqual([{ type: "keys", keys: "alt+F4" }]);
    expect(events).toContainEqual({ event: "status", data: { text: "Scout is waiting while you have control of its Computer." } });
  });

  test("stops and asks when the Model provider wants the Customer to confirm something first", async () => {
    const { browser, bot } = await botWithComputer("gpt-6-astra", "claude-haiku-5-5");
    server.anthropic.useTools({ name: "use_computer", input: { task: "Pay the invoice." } });
    server.anthropic.replyWith("I need your go-ahead.");
    server.openai.addOutput({
      type: "computer_call",
      id: "cu_1",
      call_id: "call_3",
      status: "completed",
      pending_safety_checks: [{ id: "sc_1", code: "sensitive_domain", message: "This page takes payments." }],
      actions: [{ type: "click", button: "left", x: 5, y: 5 }],
    });

    await serverSentEvents(await chat(browser, bot, "Pay the invoice."));

    expect(actionsOn(bot)).toEqual([]);
    const result = (server.anthropic.requests.at(-1)!.body.messages as Array<{ content: unknown }>).at(-1)!.content as Array<{ content: string }>;
    expect(result[0]!.content).toMatch(/This page takes payments\./);
  });

  test("wakes the Computer from Asleep before driving it", async () => {
    const { browser, bot } = await botWithComputer("claude-haiku-5-5");
    const computer = [...server.computerService.computers.values()].find((candidate) => candidate.owner === bot.id)!;
    computer.state = "asleep";
    server.openai.addOutput({
      type: "function_call",
      id: "fc_4",
      call_id: "call_4",
      name: "use_computer",
      arguments: JSON.stringify({ task: "Look at the screen." }),
      status: "completed",
    });
    server.anthropic.useTools({ name: "screenshot", input: {}, toolset: "computer" });

    await serverSentEvents(await chat(browser, bot, "What's on the screen?"));
    expect(computer.state).toBe("running");
    expect(actionsOn(bot)).toEqual([{ type: "screenshot" }]);
  });
});

describe("a Bot that can't drive a Computer", () => {
  test("isn't offered the Computer without a Driver model", async () => {
    const { browser, bot } = await botWithComputer(null);
    await serverSentEvents(await chat(browser, bot, "Hello"));
    expect(server.openai.requests.at(-1)!.tools).toBeUndefined();
  });
});
