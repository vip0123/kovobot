import type { Db } from "@kovobot/db";
import type { AudioType } from "./media/speech.ts";
import type { ChatMessage, FileForModel } from "./models/adapter.ts";
import { UUID_PATTERN } from "./http.ts";

// Files a Customer sends a Bot with a message. Images and PDFs reach the model as themselves,
// text files as text. What a file is comes from its own bytes, never from its name or the browser.

export const MAX_ATTACHMENTS = 5;
const MB = 1024 * 1024;
/** A voice note's recording: about ten minutes of speech, as browsers record it. */
export const MAX_VOICE_NOTE_BYTES = 10 * MB;
// Anthropic takes images of up to 5 MB; Gemini takes up to 20 MB in one request, base64 included.
const LIMITS: Record<AttachmentType, number> = {
  "image/png": 5 * MB,
  "image/jpeg": 5 * MB,
  "image/gif": 5 * MB,
  "image/webp": 5 * MB,
  "application/pdf": 10 * MB,
  "text/plain": MB / 2,
  // Voice notes, which come in on their own and are never attached by hand.
  "audio/webm": MAX_VOICE_NOTE_BYTES,
  "audio/ogg": MAX_VOICE_NOTE_BYTES,
  "audio/mp4": MAX_VOICE_NOTE_BYTES,
  "audio/mpeg": MAX_VOICE_NOTE_BYTES,
  "audio/wav": MAX_VOICE_NOTE_BYTES,
};
const MAX_TOTAL_BYTES = 12 * MB;
/** What one model call carries in files, newest first; older files are named instead. */
const MODEL_FILE_BUDGET = 12 * MB;

export type AttachmentType = FileForModel["mediaType"] | "text/plain" | AudioType;

/** A file as it arrives, checked: the Customer's, or one the Bot made. */
export interface IncomingFile {
  name: string;
  mediaType: AttachmentType;
  bytes: Buffer;
  /** For a picture the Bot made: the description it made it from. */
  prompt?: string;
}

/** A file as the Conversation lists it. */
export interface AttachmentInfo {
  id: string;
  name: string;
  mediaType: AttachmentType;
  size: number;
  /** Only on a picture the Bot made: the description it made it from. */
  prompt?: string;
}

/** The files sent with a message, checked, or why they can't be taken. */
export function readAttachments(raw: unknown): IncomingFile[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: "Send attachments as a list of files." };
  if (raw.length > MAX_ATTACHMENTS) return { error: `Attach up to ${MAX_ATTACHMENTS} files at a time.` };
  const files: IncomingFile[] = [];
  let total = 0;
  for (const item of raw as Array<{ name?: unknown; data?: unknown }>) {
    const name = cleanName(item?.name);
    const data = item?.data;
    if (!name || typeof data !== "string" || !data) return { error: "Each file needs a name and its contents." };
    const bytes = Buffer.from(data, "base64");
    const mediaType = sniff(bytes);
    if (!mediaType) {
      return { error: `${name} can't be sent to a Bot: send images (PNG, JPEG, GIF or WebP), PDFs or text files.` };
    }
    if (bytes.length > LIMITS[mediaType]) {
      return { error: `${name} is too big: ${LIMITS[mediaType] / MB} MB at most for ${kindOf(mediaType)}.` };
    }
    total += bytes.length;
    files.push({ name, mediaType, bytes });
  }
  if (total > MAX_TOTAL_BYTES) return { error: `These files come to more than ${MAX_TOTAL_BYTES / MB} MB: send fewer at a time.` };
  return files;
}

/** Keeps a message's Attachments, in the order they were attached, and lists them. */
export async function saveAttachments(
  db: Pick<Db, "query">,
  messageId: string,
  files: IncomingFile[],
  now: Date,
): Promise<AttachmentInfo[]> {
  const saved: AttachmentInfo[] = [];
  for (const [position, file] of files.entries()) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO attachments (message_id, position, name, media_type, size, data, prompt, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [messageId, position, file.name, file.mediaType, file.bytes.length, file.bytes, file.prompt ?? null, now],
    );
    saved.push({
      id: rows[0]!.id,
      name: file.name,
      mediaType: file.mediaType,
      size: file.bytes.length,
      ...(file.prompt === undefined ? {} : { prompt: file.prompt }),
    });
  }
  return saved;
}

/** A message's files as a column of its row: `attachments`, a JSON list of AttachmentInfo. */
export const ATTACHMENTS_COLUMN = `COALESCE((
    SELECT json_agg(json_strip_nulls(json_build_object('id', a.id, 'name', a.name, 'mediaType', a.media_type, 'size', a.size, 'prompt', a.prompt)) ORDER BY a.position)
    FROM attachments a WHERE a.message_id = messages.id
  ), '[]'::json) AS attachments`;

/**
 * The conversation as the model sees it: each message with its Attachments. Newest first, until
 * the first that doesn't fit the budget, images and PDFs go as themselves and text files as text;
 * the rest are named. A model that can't read PDFs here (`pdfs: false`) is told one was attached.
 */
export async function conversationForModel(
  db: Db,
  messages: Array<{ role: "user" | "assistant"; content: string; attachments: AttachmentInfo[] }>,
  { pdfs }: { pdfs: boolean },
): Promise<ChatMessage[]> {
  // A voice note's recording isn't sent: its transcript is the message.
  const filesOf = (attachments: AttachmentInfo[]) => attachments.filter((file) => !isRecording(file));
  const ids = messages.flatMap((message) => (message.role === "user" ? filesOf(message.attachments).map((file) => file.id) : []));
  if (ids.length === 0) return messages.map(({ role, content, attachments }) => ({ role, content: asSaid(role, content, attachments) }));

  // Newest first (the latest message's last Attachment first), stopping at the first that doesn't fit.
  const newestFirst = messages.flatMap((message) => (message.role === "user" ? filesOf(message.attachments) : [])).reverse();
  const shown = new Set<string>();
  let used = 0;
  for (const file of newestFirst) {
    if (file.mediaType === "application/pdf" && !pdfs) continue;
    if (used + file.size > MODEL_FILE_BUDGET) break;
    used += file.size;
    shown.add(file.id);
  }
  const { rows } = await db.query<{ id: string; data: Buffer }>("SELECT id, data FROM attachments WHERE id = ANY($1::uuid[])", [
    [...shown],
  ]);
  const data = new Map(rows.map((row) => [row.id, row.data]));

  return messages.map(({ role, content, attachments }) => {
    if (role !== "user" || filesOf(attachments).length === 0) return { role, content: asSaid(role, content, attachments) };
    const texts: string[] = [];
    const files: FileForModel[] = [];
    content = asSaid(role, content, attachments);
    for (const file of filesOf(attachments)) {
      const bytes = data.get(file.id);
      if (file.mediaType === "application/pdf" && !pdfs) texts.push(`[${file.name} is a PDF, which this model can't read here.]`);
      else if (!bytes) texts.push(`[${file.name} was attached here; it isn't shown any more.]`);
      else if (file.mediaType === "text/plain") texts.push(`<file name="${file.name.replaceAll('"', "'")}">\n${bytes.toString("utf8")}\n</file>`);
      else files.push({ name: file.name, mediaType: file.mediaType as FileForModel["mediaType"], data: bytes.toString("base64") });
    }
    return { role, content: [content, ...texts].filter(Boolean).join("\n\n"), ...(files.length > 0 ? { attachments: files } : {}) };
  });
}

/** A voice note's recording, kept for the Customer to play back. */
function isRecording(file: AttachmentInfo): boolean {
  return file.mediaType.startsWith("audio/");
}

/**
 * A message as the model sees it: a voice note is marked as spoken, since a transcript may mishear,
 * and a reply carries the pictures it made.
 */
function asSaid(role: "user" | "assistant", content: string, attachments: AttachmentInfo[]): string {
  if (role === "user") return attachments.some(isRecording) ? `[A voice note, as transcribed]\n${content}` : content;
  return withPictures(role, content, attachments);
}

/**
 * A reply as the model sees it later: what it wrote, and the pictures it made, by the descriptions
 * it made them from. The pictures themselves aren't sent back; the model knows them by their words.
 */
function withPictures(role: "user" | "assistant", content: string, attachments: AttachmentInfo[]): string {
  const prompts = role === "assistant" ? attachments.flatMap((file) => (file.prompt === undefined ? [] : [file.prompt])) : [];
  if (prompts.length === 0) return content;
  const made = prompts.length === 1 ? "a picture" : `${prompts.length} pictures`;
  const shown = prompts.length === 1 ? "it" : "them";
  return (
    `${content}\n\n[Kovobot's record of this reply: you made ${made} with generate_image, and the Customer saw ${shown} ` +
    `with this reply. Made from: ${prompts.map((prompt) => JSON.stringify(prompt)).join("; ")}.]`
  );
}

/** One of the Customer's Bot's files, or null when it isn't theirs or doesn't exist. */
export async function findAttachment(
  db: Db,
  customerId: string,
  botId: string,
  attachmentId: string,
): Promise<{ name: string; mediaType: AttachmentType; data: Buffer } | null> {
  if (!UUID_PATTERN.test(botId) || !UUID_PATTERN.test(attachmentId)) return null;
  const { rows } = await db.query<{ name: string; mediaType: AttachmentType; data: Buffer }>(
    `SELECT a.name, a.media_type AS "mediaType", a.data
     FROM attachments a
     JOIN messages m ON m.id = a.message_id
     JOIN conversations c ON c.id = m.conversation_id
     JOIN bots b ON b.id = c.bot_id
     WHERE a.id = $1 AND b.id = $2 AND b.customer_id = $3`,
    [attachmentId, botId, customerId],
  );
  return rows[0] ?? null;
}

/** A file's own name: no folders, no control characters, not too long. */
function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  const base = value.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
}

/** What a file is, from its first bytes: an image, a PDF, or text (UTF-8 with no NULs); null for anything else. */
function sniff(bytes: Buffer): AttachmentType | null {
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString("latin1");
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (bytes.length > 0 && !bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return "text/plain";
    } catch {
      return null;
    }
  }
  return null;
}

function kindOf(mediaType: AttachmentType): string {
  return mediaType === "application/pdf" ? "a PDF" : mediaType === "text/plain" ? "a text file" : "an image";
}
