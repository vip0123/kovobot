import type { Db } from "@kovobot/db";

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
 * (now linked) or a new one. Null when Google can't vouch for the email, or
 * when that Customer is already linked to a different Google account.
 */
export async function findOrCreateCustomerForGoogle(
  db: Db,
  google: { subject: string; email: string; ownsEmail: boolean },
): Promise<Customer | null> {
  const linked = await db.query<Customer>("SELECT id, email FROM customers WHERE google_subject = $1", [
    google.subject,
  ]);
  if (linked.rows[0]) return linked.rows[0];
  if (!google.ownsEmail) return null;
  const { rows } = await db.query<Customer>(
    `INSERT INTO customers (email, google_subject) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET google_subject = EXCLUDED.google_subject
       WHERE customers.google_subject IS NULL
     RETURNING id, email`,
    [google.email, google.subject],
  );
  return rows[0] ?? null;
}
