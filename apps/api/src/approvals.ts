import { Hono } from "hono";
import type { Db } from "@kovobot/db";
import type { AppDeps } from "./app.ts";
import { type Customer, ownBotOnly } from "./customers.ts";
import { apiError, UUID_PATTERN } from "./http.ts";
import type { ActionKind, ActionOutcome, ActionRef, ActionTool } from "./actions.ts";
import { runComposioAction } from "./composio.ts";
import { runMcpAction } from "./mcp.ts";

/** One action a Bot asked to take, as the Customer sees it. */
export interface Approval {
  id: string;
  /** The reply whose Task asked; null while that Task runs. */
  messageId: string | null;
  tool: { label: string; name: string };
  kind: Exclude<ActionKind, "read">;
  /** Exactly what runs. */
  arguments: Record<string, unknown>;
  /** Unknown: it was running when Kovobot restarted, so whether it happened can't be said. It never runs again. */
  state: "waiting" | "declined" | "running" | "done" | "failed" | "unknown";
  /** It ran at once under a Pre-approval. */
  preApproved: boolean;
  result: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

/** A standing OK for one kind of action on one tool of the Bot. */
export interface PreApproval {
  id: string;
  tool: { label: string; name: string };
  kind: Exclude<ActionKind, "read" | "pay">;
  createdAt: Date;
}

/** How a Task asks for Approvals. */
export interface ApprovalDesk {
  /**
   * An action that isn't a read. Under a Pre-approval, and while the Task hasn't read Outside
   * content, it runs at once; otherwise it waits for the Customer. Says what to tell the model.
   */
  ask(
    action: ActionTool,
    kind: Approval["kind"],
    input: Record<string, unknown>,
    options: { preApprovalsSuspended: boolean },
  ): Promise<{ approval: Approval; output: string }>;
}

/** A tool's action running longer than this when Kovobot restarted: whether it happened can't be said. */
const RUNNING_AT_MOST_MS = 10 * 60_000;
/** The most of an action's result kept and shown. */
const MAX_RESULT = 20_000;

/** What the model is told when an action waits. */
const WAITING =
  "This waits for the Customer's Approval: they see exactly this action and decide. It hasn't run, so don't ask " +
  "for it again; you'll hear what they decide. Tell them what you've asked to do and why.";

interface StoredApproval {
  id: string;
  botId: string;
  messageId: string | null;
  tool: { label: string; name: string; ref: ActionRef };
  kind: Approval["kind"];
  arguments: Record<string, unknown>;
  state: "waiting" | "declined" | "running" | "done" | "failed";
  preApproved: boolean;
  result: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

const APPROVAL_COLUMNS = `id, bot_id AS "botId", message_id::text AS "messageId", tool, kind, arguments, state,
  pre_approved AS "preApproved", result, created_at AS "createdAt", decided_at AS "decidedAt"`;

/** An Approval as the Customer sees it: one still running long after it started is unknown. */
export function approvalView(stored: StoredApproval, now: Date): Approval {
  const started = (stored.decidedAt ?? stored.createdAt).getTime();
  const state = stored.state === "running" && now.getTime() - started > RUNNING_AT_MOST_MS ? "unknown" : stored.state;
  return {
    id: stored.id,
    messageId: stored.messageId,
    tool: { label: stored.tool.label, name: stored.tool.name },
    kind: stored.kind,
    arguments: stored.arguments,
    state,
    preApproved: stored.preApproved,
    result: stored.result,
    createdAt: stored.createdAt,
    decidedAt: stored.decidedAt,
  };
}

/** The Bot's Approvals desk for one Task in one Conversation. */
export function approvalDesk(deps: AppDeps, botId: string, conversationId: string): ApprovalDesk {
  return {
    async ask(action, kind, input, { preApprovalsSuspended }) {
      const now = deps.now();
      const preApproved = kind !== "pay" && !preApprovalsSuspended && (await isPreApproved(deps.db, botId, action.key, kind));
      const { rows } = await deps.db.query<StoredApproval>(
        `INSERT INTO approvals (bot_id, conversation_id, tool_key, tool, kind, arguments, state, pre_approved, created_at, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${APPROVAL_COLUMNS}`,
        [
          botId,
          conversationId,
          action.key,
          JSON.stringify({ label: action.label, name: action.name, ref: action.ref }),
          kind,
          JSON.stringify(input),
          preApproved ? "running" : "waiting",
          preApproved,
          now,
          preApproved ? now : null,
        ],
      );
      if (!preApproved) return { approval: approvalView(rows[0]!, now), output: WAITING };
      const ran = await carryOut(deps, rows[0]!);
      return { approval: ran, output: ran.result ?? "" };
    },
  };
}

async function isPreApproved(db: Db, botId: string, toolKey: string, kind: Approval["kind"]): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM pre_approvals WHERE bot_id = $1 AND tool_key = $2 AND kind = $3", [botId, toolKey, kind]);
  return rowCount === 1;
}

/**
 * The Customer's decision on an Approval that waits, taken once: a second decision, or one sent
 * twice, finds it decided. Approving starts it running; carryOut runs it.
 */
export async function decideApproval(
  deps: AppDeps,
  botId: string,
  approvalId: string,
  decision: { approve: boolean; alwaysAllow: boolean },
): Promise<{ approval: StoredApproval } | { error: "not_found" | "decided" | "never_pre_approved" }> {
  if (!UUID_PATTERN.test(approvalId)) return { error: "not_found" };
  const { rows: found } = await deps.db.query<StoredApproval & { toolKey: string }>(
    `SELECT ${APPROVAL_COLUMNS}, tool_key AS "toolKey" FROM approvals WHERE id = $1 AND bot_id = $2`,
    [approvalId, botId],
  );
  const asked = found[0];
  if (!asked) return { error: "not_found" };
  if (asked.state !== "waiting") return { error: "decided" };
  if (decision.approve && decision.alwaysAllow && asked.kind === "pay") return { error: "never_pre_approved" };
  const now = deps.now();
  const { rows } = await deps.db.query<StoredApproval>(
    `UPDATE approvals SET state = $3, decided_at = $4 WHERE id = $1 AND bot_id = $2 AND state = 'waiting'
     RETURNING ${APPROVAL_COLUMNS}`,
    [approvalId, botId, decision.approve ? "running" : "declined", now],
  );
  if (!rows[0]) return { error: "decided" };
  if (decision.approve && decision.alwaysAllow) {
    await deps.db.query(
      `INSERT INTO pre_approvals (bot_id, tool_key, tool, kind, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (bot_id, tool_key, kind) DO NOTHING`,
      [botId, asked.toolKey, JSON.stringify({ label: asked.tool.label, name: asked.tool.name }), asked.kind, now],
    );
  }
  return { approval: rows[0] };
}

/** Runs an action that has just started running, exactly as it was asked, and keeps what came of it. */
export async function carryOut(deps: AppDeps, approval: StoredApproval): Promise<Approval> {
  let outcome: ActionOutcome;
  try {
    outcome = await runAction(deps, approval.botId, approval.tool.ref, approval.arguments);
  } catch (error) {
    outcome = { output: `It failed: ${(error as Error).message}`, failed: true };
  }
  const now = deps.now();
  const { rows } = await deps.db.query<StoredApproval>(
    `UPDATE approvals SET state = $2, result = $3, finished_at = $4 WHERE id = $1 RETURNING ${APPROVAL_COLUMNS}`,
    [approval.id, outcome.failed ? "failed" : "done", outcome.output.slice(0, MAX_RESULT), now],
  );
  return approvalView(rows[0]!, now);
}

/** Runs one tool on whatever it belongs to. */
function runAction(deps: AppDeps, botId: string, ref: ActionRef, input: Record<string, unknown>): Promise<ActionOutcome> {
  switch (ref.source) {
    case "mcp":
      return runMcpAction(deps, botId, ref, input);
    case "composio":
      return runComposioAction(deps, botId, ref, input);
  }
}

/** The action in a line, for the model: the tool and exactly what it was given. */
export function describeAction(approval: Pick<Approval, "tool" | "arguments">): string {
  return `${approval.tool.label}: ${approval.tool.name} ${JSON.stringify(approval.arguments)}`.slice(0, 2_000);
}

/** What the Customer decided, as the message that tells the model; what the action returned comes separately. */
export function decisionMessage(approval: Approval): string {
  const action = describeAction(approval);
  if (approval.state === "declined") return `[The Customer declined this, so it didn't run: ${action}]`;
  if (approval.state === "failed") return `[The Customer approved this, but it failed: ${action}]`;
  return `[The Customer approved this, and it ran: ${action}]`;
}

/** The Conversation's Approvals, oldest first. */
export async function listApprovals(deps: AppDeps, conversationId: string): Promise<Approval[]> {
  const { rows } = await deps.db.query<StoredApproval>(
    `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE conversation_id = $1 ORDER BY created_at, id`,
    [conversationId],
  );
  const now = deps.now();
  return rows.map((row) => approvalView(row, now));
}

/**
 * What each earlier reply's Task did outside the Bot, for the model: a reply's words alone don't
 * say whether an action ran, and a Bot that can't tell may do it again. Only what doesn't change
 * once the reply is saved, so earlier messages stay as they were for the prompt cache: what it
 * asked the Customer to approve (what they decided comes in its own message), and what ran under
 * a Pre-approval.
 */
export async function actionNotes(db: Db, conversationId: string): Promise<Map<string, string>> {
  const { rows } = await db.query<Pick<StoredApproval, "messageId" | "tool" | "arguments" | "preApproved" | "state">>(
    `SELECT message_id::text AS "messageId", tool, arguments, pre_approved AS "preApproved", state
     FROM approvals WHERE conversation_id = $1 AND message_id IS NOT NULL ORDER BY created_at, id`,
    [conversationId],
  );
  const notes = new Map<string, string[]>();
  for (const row of rows) {
    const action = describeAction(row);
    const note = !row.preApproved
      ? `Kovobot's record of this reply: you asked the Customer to approve ${action}`
      : row.state === "failed"
        ? `Kovobot's record of this reply: under the Customer's Pre-approval, this ran and failed: ${action}`
        : `Kovobot's record of this reply: under the Customer's Pre-approval, this ran and worked: ${action}`;
    notes.set(row.messageId!, [...(notes.get(row.messageId!) ?? []), `[${note}]`]);
  }
  return new Map([...notes].map(([messageId, lines]) => [messageId, lines.join("\n")]));
}

/** Ties the Approvals a Task asked for to the reply it saved, so each shows under its reply. */
export async function attachApprovals(db: Db, conversationId: string, messageId: string, since: Date): Promise<void> {
  await db.query("UPDATE approvals SET message_id = $3 WHERE conversation_id = $1 AND message_id IS NULL AND created_at >= $2", [
    conversationId,
    since,
    messageId,
  ]);
}

type Env = { Variables: { customer: Customer; botId: string } };

/** A Bot's Pre-approvals, under /bots/:id/pre-approvals: the Customer sees and removes them. */
export function preApprovalRoutes(deps: AppDeps) {
  const routes = new Hono<Env>();
  routes.use("*", ownBotOnly(deps.db));

  routes.get("/", async (c) => {
    const { rows } = await deps.db.query<PreApproval>(
      `SELECT id, tool, kind, created_at AS "createdAt" FROM pre_approvals WHERE bot_id = $1 ORDER BY created_at, id`,
      [c.get("botId")],
    );
    return c.json({ preApprovals: rows });
  });

  routes.delete("/:preApprovalId", async (c) => {
    const id = c.req.param("preApprovalId");
    const { rowCount } = UUID_PATTERN.test(id)
      ? await deps.db.query("DELETE FROM pre_approvals WHERE id = $1 AND bot_id = $2", [id, c.get("botId")])
      : { rowCount: 0 };
    return rowCount === 1 ? c.body(null, 204) : apiError(c, 404, "pre_approval_not_found", "There's no such Pre-approval.");
  });

  return routes;
}
