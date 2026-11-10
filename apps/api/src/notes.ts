import { type Context, Hono } from "hono";
import type { Db } from "@kovobot/db";
import type { AppDeps } from "./app.ts";
import type { Customer } from "./customers.ts";
import { apiError, jsonBody, UUID_PATTERN } from "./http.ts";

/** Something a Bot keeps in mind across Conversations. The Bot writes it; the Customer can change it. */
export interface Note {
  id: string;
  content: string;
  /** Who last wrote it. */
  writtenBy: "bot" | "customer";
  /** The Bot wrote it after reading Outside content in the same Task, so the Customer should check it. */
  afterOutsideContent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_NOTE_LENGTH = 500;
/** Every note goes into every Task's instructions, so a Bot keeps a handful, not a diary. */
export const MAX_NOTES_PER_BOT = 50;

/** What a Task can do with its Bot's notes. Each answers in words, for the model. */
export interface Notebook {
  remember(content: string, afterOutsideContent: boolean): Promise<{ done: boolean; answer: string }>;
  change(id: number, content: string, afterOutsideContent: boolean): Promise<{ done: boolean; answer: string }>;
  forget(id: number): Promise<{ done: boolean; answer: string }>;
}

type Env = { Variables: { customer: Customer } };

/**
 * A Bot's notes, under /bots/:id/notes, for the Customer to see, add, edit and delete.
 * Mounted inside the Bot routes, so every route has a signed-in Customer.
 */
export function noteRoutes(deps: AppDeps) {
  const routes = new Hono<Env>();

  /** The Customer's own Bot's id, or null. */
  const ownBot = async (c: Context<Env>) => {
    const botId = c.req.param("id") ?? "";
    if (!UUID_PATTERN.test(botId)) return null;
    const { rowCount } = await deps.db.query("SELECT 1 FROM bots WHERE id = $1 AND customer_id = $2", [botId, c.get("customer").id]);
    return rowCount === 1 ? botId : null;
  };

  routes.get("/", async (c) => {
    const botId = await ownBot(c);
    return botId ? c.json({ notes: await botNotes(deps.db, botId) }) : botNotFound(c);
  });

  routes.post("/", async (c) => {
    const botId = await ownBot(c);
    if (!botId) return botNotFound(c);
    const content = noteContent((await jsonBody(c)).content);
    if (content === null) return invalidNote(c);
    const note = await addNote(deps.db, botId, content, { writtenBy: "customer", afterOutsideContent: false }, deps.now());
    if (!note) return apiError(c, 409, "too_many_notes", `A Bot can keep up to ${MAX_NOTES_PER_BOT} notes. Delete one first.`);
    return c.json({ note }, 201);
  });

  // The Customer's edit makes the note theirs, checked.
  routes.patch("/:noteId", async (c) => {
    const botId = await ownBot(c);
    if (!botId) return botNotFound(c);
    const content = noteContent((await jsonBody(c)).content);
    if (content === null) return invalidNote(c);
    const author = { writtenBy: "customer", afterOutsideContent: false } as const;
    const note = await rewriteNote(deps.db, botId, noteNumber(c.req.param("noteId")), content, author, deps.now());
    return note ? c.json({ note }) : noteNotFound(c);
  });

  routes.delete("/:noteId", async (c) => {
    const botId = await ownBot(c);
    if (!botId) return botNotFound(c);
    return (await deleteNote(deps.db, botId, noteNumber(c.req.param("noteId")))) ? c.body(null, 204) : noteNotFound(c);
  });

  return routes;
}

/** A Bot's notes, oldest first. */
export async function botNotes(db: Db, botId: string): Promise<Note[]> {
  const { rows } = await db.query<Note>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE bot_id = $1 ORDER BY id`, [botId]);
  return rows;
}

/** The Bot's own hand on its notes, for one Task. */
export function notebook(db: Db, botId: string, now: () => Date): Notebook {
  const refusal = (content: string) =>
    !content.trim()
      ? { done: false, answer: "Write what the note says." }
      : content.trim().length > MAX_NOTE_LENGTH
        ? { done: false, answer: `A note can be up to ${MAX_NOTE_LENGTH} characters. Write it shorter.` }
        : null;
  const missing = (id: number) => ({ done: false, answer: `You have no note ${id}.` });
  return {
    async remember(content, afterOutsideContent) {
      const refused = refusal(content);
      if (refused) return refused;
      const note = await addNote(db, botId, content.trim(), { writtenBy: "bot", afterOutsideContent }, now());
      if (!note) return { done: false, answer: `Your notes are full: you keep up to ${MAX_NOTES_PER_BOT}. Change or forget one first.` };
      return { done: true, answer: `Noted, as note ${note.id}.` };
    },
    async change(id, content, afterOutsideContent) {
      const refused = refusal(content);
      if (refused) return refused;
      const note = await rewriteNote(db, botId, id, content.trim(), { writtenBy: "bot", afterOutsideContent }, now());
      return note ? { done: true, answer: `Note ${id} now says that.` } : missing(id);
    },
    async forget(id) {
      return (await deleteNote(db, botId, id)) ? { done: true, answer: `Note ${id} is gone.` } : missing(id);
    },
  };
}

const NOTE_COLUMNS = `id::text, content, written_by AS "writtenBy", after_outside_content AS "afterOutsideContent",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

/** A note's number from the path; 0, which no note has, when it isn't one. */
function noteNumber(value: string | undefined): number {
  return /^\d{1,15}$/.test(value ?? "") ? Number(value) : 0;
}

function noteContent(value: unknown): string | null {
  const content = typeof value === "string" ? value.trim() : "";
  return content.length >= 1 && content.length <= MAX_NOTE_LENGTH ? content : null;
}

type Author = { writtenBy: Note["writtenBy"]; afterOutsideContent: boolean };

/** Adds a note, unless the Bot already keeps as many as it may: then null. */
async function addNote(db: Db, botId: string, content: string, author: Author, now: Date): Promise<Note | null> {
  const { rows } = await db.query<Note>(
    `INSERT INTO notes (bot_id, content, written_by, after_outside_content, created_at, updated_at)
     SELECT $1, $2, $3, $4, $5, $5 WHERE (SELECT count(*) FROM notes WHERE bot_id = $1) < $6
     RETURNING ${NOTE_COLUMNS}`,
    [botId, content, author.writtenBy, author.afterOutsideContent, now, MAX_NOTES_PER_BOT],
  );
  return rows[0] ?? null;
}

async function rewriteNote(db: Db, botId: string, id: number, content: string, author: Author, now: Date): Promise<Note | null> {
  const { rows } = await db.query<Note>(
    `UPDATE notes SET content = $3, written_by = $4, after_outside_content = $5, updated_at = $6
     WHERE id = $2 AND bot_id = $1 RETURNING ${NOTE_COLUMNS}`,
    [botId, id, content, author.writtenBy, author.afterOutsideContent, now],
  );
  return rows[0] ?? null;
}

async function deleteNote(db: Db, botId: string, id: number): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM notes WHERE id = $2 AND bot_id = $1", [botId, id]);
  return rowCount === 1;
}

function botNotFound(c: Context) {
  return apiError(c, 404, "bot_not_found", "There's no such Bot.");
}

function noteNotFound(c: Context) {
  return apiError(c, 404, "note_not_found", "There's no such note.");
}

function invalidNote(c: Context) {
  return apiError(c, 400, "invalid_note", `Write a note of up to ${MAX_NOTE_LENGTH} characters.`);
}
