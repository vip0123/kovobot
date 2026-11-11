// What a Bot's tools do outside it, which decides whether an action waits for an Approval (ticket 18).
import type { FunctionTool } from "./models/adapter.ts";

/** What a tool does outside the Bot. Reads run at once; the other kinds wait for an Approval. */
export type ActionKind = "read" | "send" | "change" | "delete" | "pay";

/** How to run a tool again later, once the Customer approves. */
export type ActionRef = { source: "mcp"; serverId: string; tool: string } | { source: "composio"; appId: string; tool: string };

/** One of the Bot's tools from a connected server or app, for its Task. What it returns is Outside content. */
export interface ConnectedTool {
  tool: FunctionTool;
  /**
   * Makes one call ready: what kind of action it is, exactly what would run, and how to run it
   * now; or why it can't, in words for the model.
   */
  prepare(input: Record<string, unknown>): Promise<PreparedAction | string>;
}

/** One call to a connected tool, ready: a read runs at once; anything else goes through Approvals. */
export interface PreparedAction {
  kind: ActionKind;
  action: ActionTool;
  input: Record<string, unknown>;
  /** What the Customer sees while it runs. */
  status: string;
  run(): Promise<string>;
}

/** One tool, as Approvals and Pre-approvals know it. */
export interface ActionTool {
  /** What Pre-approvals match: one tool of one server or app. */
  key: string;
  /** The server or app, as the Customer knows it. */
  label: string;
  /** The tool's own name there. */
  name: string;
  ref: ActionRef;
}

/** What came of running an action: what it returned, and whether it failed. */
export interface ActionOutcome {
  output: string;
  failed: boolean;
}

const PAYING = /^(pay|pays|paid|payment|payments|payout|payouts|charge|charges|purchase|purchases|buy|buys|checkout|refund|refunds|transfer|transfers|withdraw|withdrawal|deposit|invoice|invoices|subscribe|tip|donate|money|wire)$/;
const DELETING = /^(delete|deletes|remove|removes|destroy|trash|archive|purge|cancel|cancels|revoke|unsubscribe|uninstall|drop|erase|wipe|clear)$/;
const SENDING = /^(send|sends|post|posts|reply|replies|publish|tweet|message|messages|email|emails|mail|comment|share|invite|notify|forward|dm|sms|call|text)$/;

/**
 * Which kind of action a tool takes. A tool its server marks read-only only reads. Paying is the
 * one kind never pre-approved, so a word for it in the name or description makes it one.
 */
export function actionKind(tool: { name: string; description: string; readOnly: boolean; destructive?: boolean }): ActionKind {
  if (tool.readOnly) return "read";
  const words = (text: string) => text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  const name = words(tool.name);
  if ([...name, ...words(tool.description)].some((word) => PAYING.test(word))) return "pay";
  if (tool.destructive || name.some((word) => DELETING.test(word))) return "delete";
  if (name.some((word) => SENDING.test(word))) return "send";
  return "change";
}
