import { describe, expect, test } from "vitest";
import { fireDueSchedules } from "../src/firings.ts";
import { type Browser, serverSentEvents, startTestServer, uniqueEmail } from "./harness.ts";

// Schedules (ticket 22): a Customer, or the Bot when the Customer asks, sets one-off or
// repeating schedules. Each firing is one Task, whose reply lands in the Bot's Conversation.
const server = startTestServer();

interface Schedule {
  id: string;
  task: string;
  when: { repeat: string; time: string; date?: string; days?: number[]; dayOfMonth?: number };
  timeZone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdBy: "customer" | "bot";
}

/** Sets the harness clock, then signs a new Customer in with a Bot. */
async function botAt(now: string): Promise<{ browser: Browser; bot: { id: string } }> {
  server.clock.now = new Date(now);
  const browser = server.browser();
  await server.signInByEmail(browser, uniqueEmail());
  const response = await browser.post("/api/bots", { name: "Scout", model: "gpt-6-luna" });
  return { browser, bot: ((await response.json()) as { bot: { id: string } }).bot };
}

async function schedule(browser: Browser, bot: { id: string }, body: object): Promise<Schedule> {
  const response = await browser.post(`/api/bots/${bot.id}/schedules`, body);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  return ((await response.json()) as { schedule: Schedule }).schedule;
}

async function schedulesOf(browser: Browser, bot: { id: string }): Promise<Schedule[]> {
  const response = await browser.get(`/api/bots/${bot.id}/schedules`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { schedules: Schedule[] }).schedules;
}

async function history(browser: Browser, bot: { id: string }) {
  const response = await browser.get(`/api/bots/${bot.id}/messages`);
  return ((await response.json()) as { messages: Array<{ role: string; content: string; scheduleId: string | null }> }).messages;
}

function write(browser: Browser, method: "PATCH" | "DELETE", path: string, body?: object) {
  return browser.send(path, {
    method,
    headers: { origin: server.config.appUrl, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function advanceTo(when: string) {
  server.clock.now = new Date(when);
}

/** The model's next answer calls `name` with `input`, then says `reply`. */
function modelCalls(name: string, input: object, reply = "OK.") {
  server.openai.addOutput({ type: "function_call", id: `fc_${name}`, call_id: `call_${name}`, name, arguments: JSON.stringify(input), status: "completed" });
  server.openai.replyWith(reply);
}

const lastToolOutput = () => (server.openai.requests.at(-1)!.input.at(-1) as { output: string }).output;

describe("schedules a Customer sets", () => {
  test("a one-off schedule runs once at its time, and its reply lands in the Conversation", async () => {
    const { browser, bot } = await botAt("2026-11-05T12:00:00Z");
    const set = await schedule(browser, bot, {
      task: "Remind me to order flour.",
      when: { repeat: "once", date: "2026-11-06", time: "09:00" },
      timeZone: "Europe/London",
    });
    expect(set).toMatchObject({ enabled: true, nextRunAt: "2026-11-06T09:00:00.000Z", lastRunAt: null, createdBy: "customer" });

    await fireDueSchedules(server.deps);
    expect(await history(browser, bot)).toEqual([]);

    advanceTo("2026-11-06T09:00:30Z");
    server.openai.replyWith("Time to order the flour.");
    await fireDueSchedules(server.deps);

    expect(await history(browser, bot)).toMatchObject([
      { role: "user", content: "Remind me to order flour.", scheduleId: set.id },
      { role: "assistant", content: "Time to order the flour.", scheduleId: null },
    ]);
    // The model knows nobody typed it just now.
    expect(String(server.openai.requests.at(-1)!.input.at(-1)!.content)).toMatch(/^\[A schedule the Customer set runs this now/);
    expect(await schedulesOf(browser, bot)).toMatchObject([{ enabled: false, nextRunAt: null, lastRunAt: "2026-11-06T09:00:30.000Z" }]);

    await fireDueSchedules(server.deps);
    expect(await history(browser, bot)).toHaveLength(2);
  });

  test("a repeating schedule keeps to the Customer's time zone, across a clock change", async () => {
    // New York moves its clocks on Sunday 14 March 2027: 09:00 is 14:00 UTC before, 13:00 after.
    const { browser, bot } = await botAt("2027-03-12T15:00:00Z");
    const daily = await schedule(browser, bot, { task: "Morning summary.", when: { repeat: "daily", time: "09:00" }, timeZone: "America/New_York" });
    expect(daily.nextRunAt).toBe("2027-03-13T14:00:00.000Z");

    advanceTo("2027-03-13T14:00:00Z");
    server.openai.replyWith("Summary.");
    await fireDueSchedules(server.deps);
    expect(await schedulesOf(browser, bot)).toMatchObject([{ nextRunAt: "2027-03-14T13:00:00.000Z" }]);
  });

  test("weekly, weekday and monthly schedules each come round on the right day", async () => {
    // Thursday 5 November 2026.
    const { browser, bot } = await botAt("2026-11-05T12:00:00Z");
    const set = (when: object) => schedule(browser, bot, { task: "Check in.", when, timeZone: "UTC" });

    expect((await set({ repeat: "weekly", days: [1, 3], time: "08:30" })).nextRunAt).toBe("2026-11-09T08:30:00.000Z");
    expect((await set({ repeat: "weekdays", time: "11:00" })).nextRunAt).toBe("2026-11-06T11:00:00.000Z");
    expect((await set({ repeat: "daily", time: "13:00" })).nextRunAt).toBe("2026-11-05T13:00:00.000Z");
    // A month without the day runs on its last day.
    expect((await set({ repeat: "monthly", dayOfMonth: 31, time: "09:00" })).nextRunAt).toBe("2026-11-30T09:00:00.000Z");
  });

  test("firings missed while Kovobot was down run once, not once each", async () => {
    const { browser, bot } = await botAt("2026-11-05T12:00:00Z");
    await schedule(browser, bot, { task: "Daily check.", when: { repeat: "daily", time: "09:00" }, timeZone: "UTC" });

    advanceTo("2026-11-08T10:00:00Z");
    server.openai.replyWith("Checked.");
    await fireDueSchedules(server.deps);

    expect((await history(browser, bot)).map((message) => message.content)).toEqual(["Daily check.", "Checked."]);
    expect(await schedulesOf(browser, bot)).toMatchObject([{ nextRunAt: "2026-11-09T09:00:00.000Z" }]);
  });

  test("a firing while the Bot is still replying waits for the reply to finish", async () => {
    const { browser, bot } = await botAt("2026-11-05T12:00:00Z");
    // Three minutes on: within the 5 minutes a reply holds its claim without renewing it.
    await schedule(browser, bot, { task: "Ping.", when: { repeat: "daily", time: "12:03" }, timeZone: "UTC" });
    server.openai.replyWith("Busy reply.");
    const release = server.openai.holdNextReply();
    const asked = server.openai.requests.length;
    const replying = browser.post(`/api/bots/${bot.id}/messages`, { content: "Long question" });
    await server.openai.waitForRequests(asked + 1);

    advanceTo("2026-11-05T12:03:00Z");
    await fireDueSchedules(server.deps);
    expect((await history(browser, bot)).map((message) => message.content)).toEqual(["Long question"]);
    release();
    await serverSentEvents(await replying);

    await fireDueSchedules(server.deps);
    expect((await history(browser, bot)).map((message) => message.content)).toEqual(["Long question", "Busy reply.", "Ping.", "Busy reply."]);
  });

  test("a Customer changes a schedule, switches it off and on, and deletes it", async () => {
    const { browser, bot } = await botAt("2026-11-05T12:00:00Z");
    const set = await schedule(browser, bot, { task: "Report.", when: { repeat: "daily", time: "09:00" }, timeZone: "UTC" });
    const path = `/api/bots/${bot.id}/schedules/${set.id}`;

    const changed = await write(browser, "PATCH", path, { task: "Sales report.", when: { repeat: "daily", time: "17:00" } });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ schedule: { task: "Sales report.", nextRunAt: "2026-11-05T17:00:00.000Z" } });

    expect(await (await write(browser, "PATCH", path, { enabled: false })).json()).toMatchObject({ schedule: { enabled: false, nextRunAt: null } });
    advanceTo("2026-11-05T17:00:00Z");
    await fireDueSchedules(server.deps);
    expect(await history(browser, bot)).toEqual([]);
    // Switched back on, it runs next time round, not for the time it missed.
    expect(await (await write(browser, "PATCH", path, { enabled: true })).json()).toMatchObject({
      schedule: { enabled: true, nextRunAt: "2026-11-06T17:00:00.000Z" },
    });

    expect((await write(browser, "DELETE", path)).status).toBe(204);
    expect(await schedulesOf(browser, bot)).toEqual([]);
  });

  test("a schedule needs a task, a time that comes round, and a real time zone", async () => {
    const { browser, bot } = await botAt("2026-11-05T12:00:00Z");
    const cases: Array<[object, string]> = [
      [{ task: "", when: { repeat: "daily", time: "09:00" }, timeZone: "UTC" }, "Say what the Bot should do, in up to 2,000 characters."],
      [{ task: "Go", when: { repeat: "hourly", time: "09:00" }, timeZone: "UTC" }, "Pick when it runs: once, every day, on weekdays, weekly or monthly."],
      [{ task: "Go", when: { repeat: "daily", time: "25:00" }, timeZone: "UTC" }, "Give a time of day, such as 09:30."],
      [{ task: "Go", when: { repeat: "once", date: "2026-11-04", time: "09:00" }, timeZone: "UTC" }, "That time has already passed."],
      [{ task: "Go", when: { repeat: "once", time: "09:00" }, timeZone: "UTC" }, "Give the date it runs on."],
      [{ task: "Go", when: { repeat: "weekly", days: [], time: "09:00" }, timeZone: "UTC" }, "Pick the days of the week it runs on."],
      [{ task: "Go", when: { repeat: "monthly", dayOfMonth: 32, time: "09:00" }, timeZone: "UTC" }, "Pick a day of the month from 1 to 31."],
      [{ task: "Go", when: { repeat: "daily", time: "09:00" }, timeZone: "Mars/Olympus" }, "That isn't a time zone we know."],
    ];
    for (const [body, message] of cases) {
      const refused = await browser.post(`/api/bots/${bot.id}/schedules`, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: { code: "invalid_schedule", message } });
    }
  });

  test("a Bot has up to 20 schedules, and only its Customer sees or changes them", async () => {
    const { browser, bot } = await botAt("2026-11-05T12:00:00Z");
    for (let i = 0; i < 20; i++) await schedule(browser, bot, { task: `Task ${i}`, when: { repeat: "daily", time: "09:00" }, timeZone: "UTC" });
    const full = await browser.post(`/api/bots/${bot.id}/schedules`, { task: "One more", when: { repeat: "daily", time: "09:00" }, timeZone: "UTC" });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: { code: "too_many_schedules", message: "A Bot can have up to 20 schedules. Delete one first." } });

    const [first] = await schedulesOf(browser, bot);
    const stranger = server.browser();
    await server.signInByEmail(stranger, uniqueEmail());
    expect((await stranger.get(`/api/bots/${bot.id}/schedules`)).status).toBe(404);
    expect((await write(stranger, "PATCH", `/api/bots/${bot.id}/schedules/${first!.id}`, { enabled: false })).status).toBe(404);
    expect((await write(stranger, "DELETE", `/api/bots/${bot.id}/schedules/${first!.id}`)).status).toBe(404);
  });
});

describe("schedules the Bot sets", () => {
  test("the Bot knows the Customer's date and time, and sets a schedule when asked, in their time zone", async () => {
    const { browser, bot } = await botAt("2026-11-05T12:00:00Z");
    modelCalls("schedule_task", { task: "Send me the day's orders.", repeat: "daily", time: "08:00" }, "Done.");

    const response = await browser.post(`/api/bots/${bot.id}/messages`, { content: "Every morning at 8, send me the day's orders.", timeZone: "Europe/London" });
    const events = await serverSentEvents(response);

    expect(String(server.openai.requests.at(-2)!.input.at(-1)!.content)).toBe(
      "[Thursday 5 November 2026, 12:00, Europe/London]\nEvery morning at 8, send me the day's orders.",
    );
    expect(events).toContainEqual({ event: "status", data: { text: "Scout set a schedule." } });
    const [set] = await schedulesOf(browser, bot);
    expect(set).toMatchObject({ task: "Send me the day's orders.", when: { repeat: "daily", time: "08:00" }, timeZone: "Europe/London", createdBy: "bot" });
    expect(lastToolOutput()).toBe(`Scheduled (${set!.id}): every day at 08:00, Europe/London time. It next runs on Friday 6 November 2026 at 08:00.`);

    modelCalls("list_schedules", {});
    await browser.post(`/api/bots/${bot.id}/messages`, { content: "What have you got scheduled?" }).then(serverSentEvents);
    expect(lastToolOutput()).toBe(`${set!.id}: "Send me the day's orders." every day at 08:00, Europe/London time; next on Friday 6 November 2026 at 08:00.`);

    modelCalls("cancel_schedule", { id: set!.id });
    await browser.post(`/api/bots/${bot.id}/messages`, { content: "Stop the morning orders." }).then(serverSentEvents);
    expect(lastToolOutput()).toBe(`Cancelled ${set!.id}.`);
    expect(await schedulesOf(browser, bot)).toEqual([]);
  });

  test("after reading Outside content, the Bot can't set a schedule in the same Task", async () => {
    const { browser, bot } = await botAt("2026-11-05T12:00:00Z");
    server.openai.citeSources({ url: "https://example.com", title: "A page" });
    modelCalls("schedule_task", { task: "Email everyone hourly.", repeat: "daily", time: "08:00" });

    await browser.post(`/api/bots/${bot.id}/messages`, { content: "Read this page.", webSearch: true }).then(serverSentEvents);

    expect(lastToolOutput()).toBe(
      "You can't set a schedule after reading web pages or using your Computer in the same Task. Ask the Customer to set it in a new message, or on your page.",
    );
    expect(await schedulesOf(browser, bot)).toEqual([]);
  });
});
