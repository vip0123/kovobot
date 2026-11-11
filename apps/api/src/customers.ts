import type { MiddlewareHandler } from "hono";
import { type Db, transaction } from "@kovobot/db";
import { botNotFound, UUID_PATTERN } from "./http.ts";

export interface Customer {
  id: string;
  email: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An email address in the one form Customers are stored by, or null if it isn't one. */
export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

export async function findCustomerByEmail(db: Db, email: string): Promise<Customer | null> {
  const { rows } = await db.query<Customer>("SELECT id, email FROM customers WHERE email = $1", [email]);
  return rows[0] ?? null;
}

/** The Customer with this email; the first sign-in creates them. */
export async function findOrCreateCustomerByEmail(db: Db, email: string): Promise<Customer> {
  const { rows } = await db.query<Customer>(
    `INSERT INTO customers (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email`,
    [email],
  );
  return rows[0]!;
}

/**
 * The Customer for a Google account: the one already linked to it; else, when
 * Google vouches that the person owns the email, the Customer with that email
 * (now linked) or, if `mayCreate`, a new one. Null when Google can't vouch for
 * the email, when that Customer is linked to a different Google account, or
 * when there is no such Customer and none may be created.
 */
export async function findOrCreateCustomerForGoogle(
  db: Db,
  google: { subject: string; email: string; ownsEmail: boolean },
  { mayCreate }: { mayCreate: boolean },
): Promise<Customer | null> {
  const linked = await db.query<Customer>("SELECT id, email FROM customers WHERE google_subject = $1", [
    google.subject,
  ]);
  if (linked.rows[0]) return linked.rows[0];
  if (!google.ownsEmail) return null;
  const { rows } = await db.query<Customer>(
    mayCreate
      ? `INSERT INTO customers (email, google_subject) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET google_subject = EXCLUDED.google_subject
           WHERE customers.google_subject IS NULL
         RETURNING id, email`
      : `UPDATE customers SET google_subject = $2
         WHERE email = $1 AND google_subject IS NULL
         RETURNING id, email`,
    [google.email, google.subject],
  );
  return rows[0] ?? null;
}

/**
 * Runs `work` in a transaction that holds the Bot's row, so writes that must stay within one of
 * its limits (notes, schedules, Skills) take turns: the second waits for the first, then counts
 * its row. It doesn't hold up writes that only point at the Bot, such as a new message.
 */
export function withBotHeld<T>(db: Db, botId: string, work: (client: Pick<Db, "query">) => Promise<T>): Promise<T> {
  return transaction(db, async (client) => {
    await client.query("SELECT 1 FROM bots WHERE id = $1 FOR NO KEY UPDATE", [botId]);
    return work(client);
  });
}

/** Whether the Bot with this id is the Customer's own. */
export async function ownsBot(db: Db, customerId: string, botId: string): Promise<boolean> {
  if (!UUID_PATTERN.test(botId)) return false;
  const { rowCount } = await db.query("SELECT 1 FROM bots WHERE id = $1 AND customer_id = $2", [botId, customerId]);
  return rowCount === 1;
}

/**
 * For routes under /bots/:id: answers 404 unless that Bot is the signed-in Customer's own,
 * and otherwise passes its id on as `botId`.
 */
export function ownBotOnly(db: Db): MiddlewareHandler<{ Variables: { customer: Customer; botId: string } }> {
  return async (c, next) => {
    const botId = c.req.param("id") ?? "";
    if (!(await ownsBot(db, c.get("customer").id, botId))) return botNotFound(c);
    c.set("botId", botId);
    await next();
  };
}
