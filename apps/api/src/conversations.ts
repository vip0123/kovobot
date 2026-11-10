import type { Db } from "@kovobot/db";
import { ATTACHMENTS_COLUMN, type AttachmentInfo } from "./attachments.ts";
import type { WebSource } from "./models/adapter.ts";

/** One message in a Conversation: the Customer's, or the Bot's reply. */
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** What the model thought before this reply, as its Model provider showed it; null for none. */
  thinking: string | null;
  /** The web pages this reply drew on, from its Model provider's web search; null for none. */
  sources: WebSource[] | null;
  /** Google's search suggestions for a reply grounded with Google Search, as Google's HTML. */
  searchSuggestions: string | null;
  /** Files the Customer sent with this message. */
  attachments: AttachmentInfo[];
  createdAt: Date;
}

/** The most of a conversation's latest messages the model sees. */
const MESSAGES_SENT_TO_MODEL = 50;
/**
 * The model's window onto a long conversation moves on in steps of this many
 * messages, not one per message. Between steps the start of what it sees stays
 * the same, so Model providers read it back from their prompt cache.
 */
const WINDOW_STEP = 20;

/**
 * How often a reply in progress renews its claim on the conversation. A claim not renewed for
 * 5 minutes is one whose server stopped mid-reply, and the next message may take it over.
 */
export const RENEW_REPLY_CLAIM_MS = 60_000;

/** The Bot's one conversation on the web Channel, started on first use. */
export async function webConversation(db: Db, botId: string, now: Date): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `WITH created AS (
       INSERT INTO conversations (bot_id, channel, created_at) VALUES ($1, 'web', $2)
       ON CONFLICT (bot_id) WHERE channel = 'web' DO NOTHING
       RETURNING id
     )
     SELECT id FROM created
     UNION ALL
     SELECT id FROM conversations WHERE bot_id = $1 AND channel = 'web'
     LIMIT 1`,
    [botId, now],
  );
  return rows[0]!.id;
}

const MESSAGE_COLUMNS = `id::text, role, content, thinking, sources, search_suggestions AS "searchSuggestions",
  ${ATTACHMENTS_COLUMN}, created_at AS "createdAt"`;

export async function listMessages(db: Db, conversationId: string): Promise<Message[]> {
  const { rows } = await db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY messages.id`,
    [conversationId],
  );
  return rows;
}

/**
 * What the model sees of the conversation, oldest first: no more than the
 * latest MESSAGES_SENT_TO_MODEL, so a long conversation never outgrows it,
 * starting at a WINDOW_STEP and on the Customer's message, as Model providers expect.
 */
export async function recentMessages(db: Db, conversationId: string): Promise<Message[]> {
  const { rows: counted } = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1",
    [conversationId],
  );
  const start = Math.ceil(Math.max(0, counted[0]!.count - MESSAGES_SENT_TO_MODEL) / WINDOW_STEP) * WINDOW_STEP;
  const { rows } = await db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY messages.id OFFSET $2 LIMIT $3`,
    [conversationId, start, MESSAGES_SENT_TO_MODEL],
  );
  while (rows[0]?.role === "assistant") rows.shift();
  return rows;
}

/** Claims the conversation for one reply. False while another reply is under way. */
export async function startReplying(db: Db, conversationId: string, now: Date): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE conversations SET replying_since = $2
     WHERE id = $1 AND (replying_since IS NULL OR replying_since < $2::timestamptz - interval '5 minutes')`,
    [conversationId, now],
  );
  return rowCount === 1;
}

/** Renews a reply's claim, which it holds until it stops. */
export async function renewReplying(db: Db, conversationId: string, now: Date): Promise<void> {
  await db.query("UPDATE conversations SET replying_since = $2 WHERE id = $1 AND replying_since IS NOT NULL", [conversationId, now]);
}

export async function stopReplying(db: Db, conversationId: string): Promise<void> {
  await db.query("UPDATE conversations SET replying_since = NULL WHERE id = $1", [conversationId]);
}

export async function addMessage(
  db: Pick<Db, "query">,
  conversationId: string,
  role: Message["role"],
  content: string,
  now: Date,
  extras: { thinking?: string; cited?: { sources: WebSource[]; searchSuggestions?: string } } = {},
): Promise<Message> {
  const { rows } = await db.query<Message>(
    `INSERT INTO messages (conversation_id, role, content, thinking, sources, search_suggestions, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      conversationId,
      role,
      content,
      extras.thinking || null,
      extras.cited?.sources.length ? JSON.stringify(extras.cited.sources) : null,
      extras.cited?.searchSuggestions ?? null,
      now,
    ],
  );
  return rows[0]!;
}
