import type { Db } from "@kovobot/db";

export interface Customer {
  id: string;
  email: string;
}

/** The Customer with this email, created on first sign-in. */
export async function customerWithEmail(db: Db, email: string): Promise<Customer> {
  const { rows } = await db.query<Customer>(
    `INSERT INTO customers (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email`,
    [email],
  );
  return rows[0]!;
}

/**
 * The Customer for a Google identity: the one already linked to it; else the
 * one with the same email, which Google has verified, now linked; else a new one.
 */
export async function customerForGoogle(db: Db, identity: { subject: string; email: string }): Promise<Customer> {
  const linked = await db.query<Customer>("SELECT id, email FROM customers WHERE google_subject = $1", [
    identity.subject,
  ]);
  if (linked.rows[0]) return linked.rows[0];
  const { rows } = await db.query<Customer>(
    `INSERT INTO customers (email, google_subject) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET google_subject = EXCLUDED.google_subject
     RETURNING id, email`,
    [identity.email, identity.subject],
  );
  return rows[0]!;
}
