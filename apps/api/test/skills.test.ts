import { describe, expect, test } from "vitest";
import { type Browser, serverSentEvents, startTestServer, uniqueEmail } from "./harness.ts";

// Skills: named instructions a Customer writes once and grants to their Bots. A Bot sees
// each granted Skill's name and description, and reads the whole Skill when one applies.
const server = startTestServer();

interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  botIds: string[];
}

async function signedInBrowser(): Promise<Browser> {
  const browser = server.browser();
  await server.signInByEmail(browser, uniqueEmail());
  return browser;
}

async function createBot(browser: Browser, name = "Scout"): Promise<{ id: string }> {
  const response = await browser.post("/api/bots", { name, model: "gpt-6-luna" });
  expect(response.status).toBe(201);
  return ((await response.json()) as { bot: { id: string } }).bot;
}

const WEEKLY_REPORT = {
  name: "Weekly report",
  description: "Use when asked for the weekly sales report.",
  instructions: "Start with total sales, then the three best sellers, then anything unusual. Keep it to five bullet points.",
};

async function createSkill(browser: Browser, skill: object = WEEKLY_REPORT): Promise<Skill> {
  const response = await browser.post("/api/skills", skill);
  expect(response.status).toBe(201);
  return ((await response.json()) as { skill: Skill }).skill;
}

async function listSkills(browser: Browser): Promise<Skill[]> {
  const response = await browser.get("/api/skills");
  expect(response.status).toBe(200);
  return ((await response.json()) as { skills: Skill[] }).skills;
}

function write(browser: Browser, method: "PATCH" | "PUT" | "DELETE", path: string, body?: object) {
  return browser.send(path, {
    method,
    headers: { origin: server.config.appUrl, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const grant = (browser: Browser, bot: { id: string }, skill: { id: string }) => write(browser, "PUT", `/api/bots/${bot.id}/skills/${skill.id}`);
const revoke = (browser: Browser, bot: { id: string }, skill: { id: string }) =>
  write(browser, "DELETE", `/api/bots/${bot.id}/skills/${skill.id}`);

async function chat(browser: Browser, bot: { id: string }, content: string) {
  const response = await browser.post(`/api/bots/${bot.id}/messages`, { content });
  expect(response.status).toBe(200);
  return serverSentEvents(response);
}

describe("a Customer's Skills", () => {
  test("a Customer writes Skills, sees them listed, changes one and deletes another", async () => {
    const browser = await signedInBrowser();
    const report = await createSkill(browser);
    const invoices = await createSkill(browser, {
      name: "Invoices",
      description: "Use when asked to draft an invoice.",
      instructions: "Number invoices INV-0001 upwards.",
    });
    expect(report).toMatchObject({ ...WEEKLY_REPORT, botIds: [] });

    const changed = await write(browser, "PATCH", `/api/skills/${report.id}`, { description: "Use for the Monday sales report." });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ skill: { name: "Weekly report", description: "Use for the Monday sales report." } });
    expect((await write(browser, "DELETE", `/api/skills/${invoices.id}`)).status).toBe(204);

    expect(await listSkills(browser)).toMatchObject([{ id: report.id, description: "Use for the Monday sales report." }]);
  });

  test("a Skill needs a name, a description saying when to use it, and instructions, each within its limit", async () => {
    const browser = await signedInBrowser();
    const cases: Array<[object, string]> = [
      [{ ...WEEKLY_REPORT, name: " " }, "Give the Skill a name of up to 64 characters."],
      [{ ...WEEKLY_REPORT, name: "x".repeat(65) }, "Give the Skill a name of up to 64 characters."],
      [{ ...WEEKLY_REPORT, description: "" }, "Say when to use the Skill, in up to 1,024 characters."],
      [{ ...WEEKLY_REPORT, instructions: "" }, "Write the Skill's instructions, in up to 30,000 characters."],
      [{ ...WEEKLY_REPORT, instructions: "x".repeat(30_001) }, "Write the Skill's instructions, in up to 30,000 characters."],
    ];
    for (const [skill, message] of cases) {
      const refused = await browser.post("/api/skills", skill);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: { code: "invalid_skill", message } });
    }
    expect(await listSkills(browser)).toEqual([]);
  });

  test("each Skill's name is the Customer's only one by that name, whatever its case", async () => {
    const browser = await signedInBrowser();
    await createSkill(browser);

    const twin = await browser.post("/api/skills", { ...WEEKLY_REPORT, name: "WEEKLY REPORT" });
    expect(twin.status).toBe(409);
    expect(await twin.json()).toEqual({
      error: { code: "skill_name_taken", message: "You already have a Skill called WEEKLY REPORT. Pick another name." },
    });
    // Another Customer may use the same name.
    await createSkill(await signedInBrowser());
  });

  test("a SKILL.md file becomes a Skill: its name and description from the top, its instructions below", async () => {
    const browser = await signedInBrowser();
    const file = [
      "---",
      "name: release-notes",
      "description: >-",
      "  Use when asked to write release notes",
      "  from a list of changes.",
      "license: Apache-2.0",
      "---",
      "",
      "# Release notes",
      "",
      "Group the changes under Added, Changed and Fixed.",
    ].join("\n");

    const imported = await browser.post("/api/skills", { file });
    expect(imported.status).toBe(201);
    expect(await imported.json()).toMatchObject({
      skill: {
        name: "release-notes",
        description: "Use when asked to write release notes from a list of changes.",
        instructions: "# Release notes\n\nGroup the changes under Added, Changed and Fixed.",
      },
    });

    const notASkill = await browser.post("/api/skills", { file: "# Just a heading\n\nNo name or description here." });
    expect(notASkill.status).toBe(400);
    expect(await notASkill.json()).toEqual({
      error: {
        code: "invalid_skill_file",
        message: "That isn't a SKILL.md file: it needs a name and a description between --- lines at the top.",
      },
    });
  });

  test("a Customer can't see, change, delete or grant another Customer's Skills", async () => {
    const owner = await signedInBrowser();
    const skill = await createSkill(owner);
    const stranger = await signedInBrowser();
    const strangersBot = await createBot(stranger);

    expect(await listSkills(stranger)).toEqual([]);
    expect((await write(stranger, "PATCH", `/api/skills/${skill.id}`, { name: "Mine now" })).status).toBe(404);
    expect((await write(stranger, "DELETE", `/api/skills/${skill.id}`)).status).toBe(404);
    const granted = await grant(stranger, strangersBot, skill);
    expect(granted.status).toBe(404);
    expect(await granted.json()).toEqual({ error: { code: "skill_not_found", message: "There's no such Skill." } });
    expect(await listSkills(owner)).toMatchObject([{ name: "Weekly report", botIds: [] }]);
  });

  test("signed out, there are no Skills", async () => {
    expect((await server.browser().get("/api/skills")).status).toBe(401);
  });
});

describe("a Bot's Skills", () => {
  test("a Bot granted a Skill knows when to use it, and reads the whole of it when it applies", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    const skill = await createSkill(browser);
    expect((await grant(browser, bot, skill)).status).toBe(204);
    expect(await listSkills(browser)).toMatchObject([{ id: skill.id, botIds: [bot.id] }]);

    server.openai.addOutput({
      type: "function_call",
      id: "fc_skill",
      call_id: "call_skill",
      name: "read_skill",
      arguments: JSON.stringify({ name: "Weekly report" }),
      status: "completed",
    });
    server.openai.replyWith("Here's this week's report.");
    const before = server.openai.requests.length;
    const events = await chat(browser, bot, "Can I have the weekly report?");

    const [first, second] = server.openai.requests.slice(before);
    // Only the name and when to use it, until the Bot reads it.
    expect(first!.instructions).toContain("Weekly report: Use when asked for the weekly sales report.");
    expect(first!.instructions).not.toContain("three best sellers");
    expect(first!.tools).toContainEqual(expect.objectContaining({ type: "function", name: "read_skill" }));
    expect(second!.input.at(-1)).toEqual({ type: "function_call_output", call_id: "call_skill", output: WEEKLY_REPORT.instructions });
    expect(events).toContainEqual({ event: "status", data: { text: "Scout is reading its Skill: Weekly report." } });
    expect(events.at(-1)).toMatchObject({ event: "done" });
  });

  test("a Bot knows only the Skills granted to it, and forgets one once it's taken back or deleted", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    const other = await createBot(browser, "Other");
    const skill = await createSkill(browser);
    await grant(browser, other, skill);

    server.openai.replyWith("Hello.");
    await chat(browser, bot, "Hi");
    expect(server.openai.requests.at(-1)!.instructions).not.toContain("Weekly report");
    expect(server.openai.requests.at(-1)!.tools ?? []).not.toContainEqual(expect.objectContaining({ name: "read_skill" }));

    await grant(browser, bot, skill);
    expect((await grant(browser, bot, skill)).status).toBe(204);
    await chat(browser, bot, "Hi again");
    expect(server.openai.requests.at(-1)!.instructions).toContain("Weekly report");

    expect((await revoke(browser, bot, skill)).status).toBe(204);
    await chat(browser, bot, "And again");
    expect(server.openai.requests.at(-1)!.instructions).not.toContain("Weekly report");

    await write(browser, "DELETE", `/api/skills/${skill.id}`);
    await chat(browser, other, "Hi");
    expect(server.openai.requests.at(-1)!.instructions).not.toContain("Weekly report");
  });

  test("a Skill the Bot asks for by a name it doesn't have is refused, and the Bot is told which it has", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    await grant(browser, bot, await createSkill(browser));

    server.openai.addOutput({
      type: "function_call",
      id: "fc_none",
      call_id: "call_none",
      name: "read_skill",
      arguments: JSON.stringify({ name: "Payroll" }),
      status: "completed",
    });
    server.openai.replyWith("OK.");
    await chat(browser, bot, "Run payroll");

    expect(server.openai.requests.at(-1)!.input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call_none",
      output: "You have no Skill called Payroll. Your Skills: Weekly report.",
    });
  });

  test("a Bot can have up to 20 Skills, even granted at once", { timeout: 20_000 }, async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    for (let i = 1; i <= 17; i++) {
      const skill = await createSkill(browser, { ...WEEKLY_REPORT, name: `Skill ${i}` });
      expect((await grant(browser, bot, skill)).status).toBe(204);
    }
    // Five at once, with room for three: each waits for the one before, so exactly three fit.
    const more = [];
    for (let i = 1; i <= 5; i++) more.push(await createSkill(browser, { ...WEEKLY_REPORT, name: `Burst ${i}` }));
    const burst = await Promise.all(more.map((skill) => grant(browser, bot, skill)));
    expect(burst.map((response) => response.status).sort()).toEqual([204, 204, 204, 409, 409]);
    const one = await createSkill(browser, { ...WEEKLY_REPORT, name: "One too many" });

    const refused = await grant(browser, bot, one);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: { code: "too_many_skills", message: "A Bot can have up to 20 Skills. Take one away first." },
    });
  });
});
