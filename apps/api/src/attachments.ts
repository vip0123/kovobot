import type { Db } from "@kovobot/db";
import type { ChatMessage, FileForModel } from "./models/adapter.ts";
import { UUID_PATTERN } from "./http.ts";

// Files a Customer sends a Bot with a message. Images and PDFs reach the model as themselves,
// text files as text. What a file is comes from its own bytes, never from its name or the browser.

export const MAX_ATTACHMENTS = 5;
const MB = 1024 * 1024;
// Anthropic takes images of up to 5 MB; Gemini takes up to 20 MB in one request, base64 included.
const LIMITS: Record<AttachmentType, number> = {
  "image/png": 5 * MB,
  "image/jpeg": 5 * MB,
  "image/gif": 5 * MB,
  "image/webp": 5 * MB,
  "application/pdf": 10 * MB,
  "text/plain": MB / 2,
};
const MAX_TOTAL_BYTES = 12 * MB;
/** What one model call carries in files, newest first; older files are named instead. */
const MODEL_FILE_BUDGET = 12 * MB;

export type AttachmentType = FileForModel["mediaType"] | "text/plain";

/** A file as it arrives, checked. */
export interface IncomingFile {
  name: string;
  mediaType: AttachmentType;
  bytes: Buffer;
}

/** A file as the Conversation lists it. */
export interface AttachmentInfo {
  id: string;
  name: string;
  mediaType: AttachmentType;
  size: number;
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

/** Keeps a message's files, in the order they were attached. */
export async function saveAttachments(db: Db, messageId: string, files: IncomingFile[], now: Date): Promise<void> {
  for (const [position, file] of files.entries()) {
    await db.query(
      `INSERT INTO attachments (message_id, position, name, media_type, size, data, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [messageId, position, file.name, file.mediaType, file.bytes.length, file.bytes, now],
    );
  }
}

/** A message's files as a column of its row: `attachments`, a JSON list of AttachmentInfo. */
export const ATTACHMENTS_COLUMN = `COALESCE((
    SELECT json_agg(json_build_object('id', a.id, 'name', a.name, 'mediaType', a.media_type, 'size', a.size) ORDER BY a.position)
    FROM attachments a WHERE a.message_id = messages.id
  ), '[]'::json) AS attachments`;

/**
 * The conversation as the model sees it: each message with its files. Within the file budget,
 * newest first, images and PDFs go as themselves and text files as text; older files are named.
 */
export async function conversationForModel(
  db: Db,
  messages: Array<{ role: "user" | "assistant"; content: string; attachments: AttachmentInfo[] }>,
): Promise<ChatMessage[]> {
  const ids = messages.flatMap((message) => (message.role === "user" ? message.attachments.map((file) => file.id) : []));
  if (ids.length === 0) return messages.map(({ role, content }) => ({ role, content }));

  // Newest first, until the budget is spent.
  const shown = new Set<string>();
  let used = 0;
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    for (const file of message.attachments) {
      if (used + file.size > MODEL_FILE_BUDGET) continue;
      used += file.size;
      shown.add(file.id);
    }
  }
  const { rows } = await db.query<{ id: string; data: Buffer }>("SELECT id, data FROM attachments WHERE id = ANY($1::uuid[])", [
    [...shown],
  ]);
  const data = new Map(rows.map((row) => [row.id, row.data]));

  return messages.map(({ role, content, attachments }) => {
    if (role !== "user" || attachments.length === 0) return { role, content };
    const texts: string[] = [];
    const files: FileForModel[] = [];
    for (const file of attachments) {
      const bytes = data.get(file.id);
      if (!bytes) texts.push(`[${file.name} was attached here; it isn't shown any more.]`);
      else if (file.mediaType === "text/plain") texts.push(`<file name="${file.name.replaceAll('"', "'")}">\n${bytes.toString("utf8")}\n</file>`);
      else files.push({ name: file.name, mediaType: file.mediaType, data: bytes.toString("base64") });
    }
    return { role, content: [content, ...texts].filter(Boolean).join("\n\n"), ...(files.length > 0 ? { attachments: files } : {}) };
  });
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
