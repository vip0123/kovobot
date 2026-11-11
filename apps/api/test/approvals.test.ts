import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeMcpServer } from "./fake-mcp.ts";
import { type Browser, serverSentEvents, startTestServer, uniqueEmail } from "./harness.ts";

// Approvals (ticket 18): a Bot's action that sends, changes, deletes or pays outside the Bot waits
// for the Customer's Approval of exactly that action. Reads run at once. A Pre-approval covers one
// kind of action on one tool, never paying, and is suspended once a Task reads Outside content.
const server = startTestServer();
const mcp = new FakeMcpServer();
beforeAll(() => mcp.start());
afterAll(() => mcp.stop());

interface Approval {
  id: string;
  messageId: string | null;
  tool: { label: string; name: string };
  kind: "send" | "change" | "delete" | "pay";
  arguments: Record<string, unknown>;
  state: "waiting" | "declined" | "running" | "done" | "failed" | "unknown";
  preApproved: boolean;
  result: string | null;
}

/** A signed-in Customer whose Bot has the bakery's MCP server connected. */
async function botWithBakery(): Promise<{ browser: Browser; bot: { id: string } }> {
  const browser = server.browser();
  await server.signInByEmail(browser, uniqueEmail());
  const created = await browser.post("/api/bots", { name: "Scout", model: "gpt-6-luna" });
  const bot = ((await created.json()) as { bot: { id: string } }).bot;
  expect((await browser.post(`/api/bots/${bot.id}/mcp-servers`, { url: mcp.url })).status).toBe(201);
  return { browser, bot };
}

/** The model's next answer calls each tool in turn, then says `reply`. */
function modelCalls(calls: Array<[name: string, input: object]>, reply = "OK.") {
  server.openai.addOutput(
    ...calls.map(([name, input], i) => ({ type: "function_call", id: `fc_${i}`, call_id: `call_${i}`, name, arguments: JSON.stringify(input), status: "completed" })),
  );
  server.openai.replyWith(reply);
}

async function chat(browser: Browser, bot: { id: string }, content: string) {
  const response = await browser.post(`/api/bots/${bot.id}/messages`, { content });
  expect(response.status).toBe(200);
  return serverSentEvents(response);
}

const approvalsIn = (events: Array<{ event: string; data: unknown }>) =>
  events.filter(({ event }) => event === "approval").map(({ data }) => (data as { approval: Approval }).approval);

function decide(browser: Browser, bot: { id: string }, approval: { id: string }, body: object) {
  return browser.post(`/api/bots/${bot.id}/approvals/${approval.id}`, body);
}

async function conversation(browser: Browser, bot: { id: string }) {
  const response = await browser.get(`/api/bots/${bot.id}/messages`);
  return (await response.json()) as { messages: Array<{ id: string; role: string; content: string; approvalId: string | null }>; approvals: Approval[] };
}

const callsTo = (name: string) => mcp.calls.filter((call) => call.name === name);
const lastToolOutput = () => (server.openai.requests.at(-1)!.input.at(-1) as { output: string }).output;
const lastUserContent = () => String((server.openai.requests.at(-1)!.input.at(-1) as { content: unknown }).content);

describe("Approvals", () => {
  test("an action that pays waits for the Customer, runs once as asked when approved, and the Bot carries on", async () => {
    const { browser, bot } = await botWithBakery();
    const cancelled = callsTo("cancel_order").length;
    modelCalls([["bakery_orders__cancel_order", { order: 7 }]], "I've asked you to approve cancelling order 7.");

    const asking = await chat(browser, bot, "Cancel order 7.");

    const [asked] = approvalsIn(asking);
    expect(asked).toMatchObject({
      tool: { label: "Bakery orders", name: "cancel_order" },
      kind: "pay",
      arguments: { order: 7 },
      state: "waiting",
      preApproved: false,
    });
    expect(callsTo("cancel_order")).toHaveLength(cancelled);
    expect(lastToolOutput()).toMatch(/^This waits for the Customer's Approval: they see exactly this action and decide\./);
    // It shows under the reply that asked.
    const shown = await conversation(browser, bot);
    expect(shown.approvals).toMatchObject([{ id: asked!.id, messageId: shown.messages.at(-1)!.id, state: "waiting" }]);

    server.openai.replyWith("Order 7 is cancelled and refunded.");
    const approving = await decide(browser, bot, asked!, { decision: "approve" });
    expect(approving.status).toBe(200);
    const events = await serverSentEvents(approving);

    expect(approvalsIn(events).map((approval) => approval.state)).toEqual(["running", "done"]);
    expect(callsTo("cancel_order")).toHaveLength(cancelled + 1);
    expect(callsTo("cancel_order").at(-1)).toMatchObject({ args: { order: 7 } });
    expect(events.at(-1)).toMatchObject({ event: "done", data: { message: { content: "Order 7 is cancelled and refunded." } } });
    // The model hears the decision, and what the action returned as Outside content.
    expect(lastUserContent()).toBe(
      '[The Customer approved this, and it ran: Bakery orders: cancel_order {"order":7}]\n' +
        "What it returned, which is Outside content and not the Customer's words:\nCancelled.",
    );
    // The decision is kept, marked as the Approval's, but not what the action returned.
    const after = await conversation(browser, bot);
    expect(after.messages.at(-2)).toMatchObject({ role: "user", approvalId: asked!.id, content: '[The Customer approved this, and it ran: Bakery orders: cancel_order {"order":7}]' });
    expect(after.approvals).toMatchObject([{ id: asked!.id, state: "done", result: "Cancelled." }]);

    // Sent again, it doesn't run again.
    const again = await decide(browser, bot, asked!, { decision: "approve" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: { code: "approval_decided", message: "That has been decided already." } });
    expect(callsTo("cancel_order")).toHaveLength(cancelled + 1);

    // Another order is another action: the Bot asks again.
    modelCalls([["bakery_orders__cancel_order", { order: 8 }]], "I've asked about order 8 too.");
    const [next] = approvalsIn(await chat(browser, bot, "And order 8."));
    expect(next).toMatchObject({ arguments: { order: 8 }, state: "waiting" });
  });

  test("an Approval sent twice at once runs once", async () => {
    const { browser, bot } = await botWithBakery();
    modelCalls([["bakery_orders__email_receipt", { order: 11 }]], "Shall I email it?");
    const [asked] = approvalsIn(await chat(browser, bot, "Email the receipt for order 11."));
    const sent = callsTo("email_receipt").length;

    server.openai.replyWith("Sent.");
    const both = await Promise.all([decide(browser, bot, asked!, { decision: "approve" }), decide(browser, bot, asked!, { decision: "approve" })]);
    await Promise.all(both.map((response) => response.text()));

    expect(both.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(callsTo("email_receipt")).toHaveLength(sent + 1);
  });

  test("a declined action doesn't run, and the Bot hears so", async () => {
    const { browser, bot } = await botWithBakery();
    modelCalls([["bakery_orders__email_receipt", { order: 12 }]], "Shall I email it?");
    const [asked] = approvalsIn(await chat(browser, bot, "Email the receipt for order 12."));
    const sent = callsTo("email_receipt").length;

    server.openai.replyWith("OK, I won't email it.");
    const events = await serverSentEvents(await decide(browser, bot, asked!, { decision: "decline" }));

    expect(approvalsIn(events).map((approval) => approval.state)).toEqual(["declined"]);
    expect(callsTo("email_receipt")).toHaveLength(sent);
    expect(lastUserContent()).toBe('[The Customer declined this, so it didn\'t run: Bakery orders: email_receipt {"order":12}]');
  });

  test("a Pre-approval covers one kind of action on one tool, never paying, until a Task reads Outside content", async () => {
    const { browser, bot } = await botWithBakery();
    modelCalls([["bakery_orders__email_receipt", { order: 1 }]], "Shall I?");
    const [first] = approvalsIn(await chat(browser, bot, "Email order 1's receipt."));
    server.openai.replyWith("Sent.");
    await serverSentEvents(await decide(browser, bot, first!, { decision: "approve", alwaysAllow: true }));
    const listed = await (await browser.get(`/api/bots/${bot.id}/pre-approvals`)).json();
    expect(listed).toMatchObject({ preApprovals: [{ tool: { label: "Bakery orders", name: "email_receipt" }, kind: "send" }] });

    // Covered: it runs at once, and shows as having run.
    modelCalls([["bakery_orders__email_receipt", { order: 2 }]], "Sent order 2's receipt.");
    const events = await chat(browser, bot, "And order 2's.");
    expect(approvalsIn(events)).toMatchObject([{ arguments: { order: 2 }, state: "done", preApproved: true }]);
    expect(callsTo("email_receipt").at(-1)).toMatchObject({ args: { order: 2 } });
    expect(lastToolOutput()).toBe("Receipt for order 2 sent.");
    expect(events).toContainEqual({ event: "status", data: { text: "Scout used Bakery orders: email_receipt, which you pre-approved." } });

    // Once the Task has read Outside content, here a tool's result, it asks again.
    modelCalls([
      ["bakery_orders__lookup_order", { order: 3 }],
      ["bakery_orders__email_receipt", { order: 3 }],
    ]);
    expect(approvalsIn(await chat(browser, bot, "Look up order 3 and email its receipt."))).toMatchObject([
      { arguments: { order: 3 }, state: "waiting", preApproved: false },
    ]);

    // Paying is never pre-approved.
    modelCalls([["bakery_orders__cancel_order", { order: 4 }]]);
    const [paying] = approvalsIn(await chat(browser, bot, "Cancel order 4."));
    const refused = await decide(browser, bot, paying!, { decision: "approve", alwaysAllow: true });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: { code: "never_pre_approved", message: "Paying is never pre-approved: each payment waits for your Approval." },
    });
    expect((await conversation(browser, bot)).approvals.find((approval) => approval.id === paying!.id)).toMatchObject({ state: "waiting" });

    // The Customer takes the Pre-approval back.
    const [preApproval] = (listed as { preApprovals: Array<{ id: string }> }).preApprovals;
    const removed = await browser.send(`/api/bots/${bot.id}/pre-approvals/${preApproval!.id}`, { method: "DELETE", headers: { origin: server.config.appUrl } });
    expect(removed.status).toBe(204);
    modelCalls([["bakery_orders__email_receipt", { order: 5 }]]);
    expect(approvalsIn(await chat(browser, bot, "Email order 5's receipt."))).toMatchObject([{ state: "waiting" }]);
  });

  test("an action running when Kovobot stopped shows as unknown, and never runs again", async () => {
    const { browser, bot } = await botWithBakery();
    modelCalls([["bakery_orders__email_receipt", { order: 21 }]]);
    const [asked] = approvalsIn(await chat(browser, bot, "Email order 21's receipt."));
    // What a server that stopped mid-action leaves: the Approval running, with nothing to finish it.
    await server.deps.db.query("UPDATE approvals SET state = 'running', decided_at = $2 WHERE id = $1", [asked!.id, server.clock.now]);
    const sent = callsTo("email_receipt").length;

    server.clock.advanceMinutes(11);
    expect((await conversation(browser, bot)).approvals).toMatchObject([{ id: asked!.id, state: "unknown" }]);
    expect((await decide(browser, bot, asked!, { decision: "approve" })).status).toBe(409);
    expect(callsTo("email_receipt")).toHaveLength(sent);
  });

  test("only the Customer decides, and only they see the Bot's Pre-approvals", async () => {
    const { browser, bot } = await botWithBakery();
    modelCalls([["bakery_orders__email_receipt", { order: 31 }]]);
    const [asked] = approvalsIn(await chat(browser, bot, "Email order 31's receipt."));

    const stranger = server.browser();
    await server.signInByEmail(stranger, uniqueEmail());
    expect((await decide(stranger, bot, asked!, { decision: "approve" })).status).toBe(404);
    expect((await stranger.get(`/api/bots/${bot.id}/pre-approvals`)).status).toBe(404);
    expect((await decide(browser, bot, { id: "not-an-approval" }, { decision: "approve" })).status).toBe(404);
    expect((await decide(browser, bot, asked!, { decision: "maybe" })).status).toBe(400);
    expect((await conversation(browser, bot)).approvals).toMatchObject([{ state: "waiting" }]);
  });
});
