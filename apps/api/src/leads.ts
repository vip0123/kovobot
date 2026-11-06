import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Db } from "@kovobot/db";
import type { AppDeps } from "./app.ts";
import { normaliseEmail } from "./customers.ts";
import { apiError, jsonBody } from "./http.ts";
import type { Email } from "./mailer.ts";

export interface Lead {
  email: string;
  /** What they'd hand a Bot first, as the landing page names it, e.g. "market-watch". */
  firstUse: string | null;
  joinedAt: Date;
}

const FIRST_USE_PATTERN = /^[a-z][a-z-]{0,39}$/;

/** POST /leads, which the landing page calls from its own origin (LANDING_URL). */
export function leadRoutes(deps: AppDeps) {
  const routes = new Hono();
  if (deps.config.landingUrl) {
    routes.use("/leads", cors({ origin: deps.config.landingUrl, allowMethods: ["POST"], allowHeaders: ["content-type"] }));
  }
  routes.post("/leads", async (c) => {
    const body = await jsonBody(c);
    const email = normaliseEmail(body.email);
    if (!email) return apiError(c, 400, "invalid_email", "Enter an email address so we can tell you when sign-up opens.");
    const firstUse = typeof body.firstUse === "string" && FIRST_USE_PATTERN.test(body.firstUse) ? body.firstUse : null;
    await saveLead(deps.db, { email, firstUse }, deps.now());
    return c.json({}, 201);
  });
  return routes;
}

/**
 * Adds a lead, or updates an existing one's first use; joining again keeps the
 * first join time. Returns true when the lead is new.
 */
export async function saveLead(db: Db, lead: { email: string; firstUse: string | null }, now: Date): Promise<boolean> {
  const { rows } = await db.query<{ isNew: boolean }>(
    `INSERT INTO leads (email, first_use, created_at) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET first_use = COALESCE(EXCLUDED.first_use, leads.first_use)
     RETURNING (xmax = 0) AS "isNew"`,
    [lead.email, lead.firstUse, now],
  );
  return rows[0]!.isNew;
}

/**
 * While sign-up is closed, someone new who tries to sign in joins the waitlist.
 * Like every lead, they hear from us once: when sign-up opens.
 */
export async function joinWaitlist(deps: Pick<AppDeps, "db" | "now">, email: string): Promise<void> {
  await saveLead(deps.db, { email, firstUse: null }, deps.now());
}

/** Every lead, oldest first: what pnpm leads:list prints. */
export async function listLeads(db: Db): Promise<Lead[]> {
  const { rows } = await db.query<Lead>(
    `SELECT email, first_use AS "firstUse", created_at AS "joinedAt" FROM leads ORDER BY created_at, email`,
  );
  return rows;
}

/**
 * Emails every lead not yet told that sign-up is open, one at a time, and marks
 * each so a second run sends nothing more. Refuses while sign-up is closed.
 * Returns how many it emailed.
 */
export async function announceSignUpOpen(deps: Pick<AppDeps, "config" | "db" | "mailer" | "now">): Promise<number> {
  if (!deps.config.signUpOpen) {
    throw new Error("Sign-up is still closed. Set SIGN_UP_OPEN=true and deploy first, then announce.");
  }
  let sent = 0;
  for (;;) {
    // Claim one lead at a time, so two runs at once never email the same person.
    const { rows } = await deps.db.query<{ email: string }>(
      `UPDATE leads SET told_sign_up_open_at = $1
       WHERE email = (SELECT email FROM leads WHERE told_sign_up_open_at IS NULL
                      ORDER BY created_at, email LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING email`,
      [deps.now()],
    );
    const email = rows[0]?.email;
    if (!email) return sent;
    try {
      await deps.mailer.send(signUpOpenEmail(email, deps.config.appUrl));
      sent += 1;
    } catch (error) {
      // Not sent, so not told: a later run tries again.
      await deps.db.query("UPDATE leads SET told_sign_up_open_at = NULL WHERE email = $1", [email]);
      throw error;
    }
  }
}

function signUpOpenEmail(to: string, appUrl: string): Email {
  const signIn = `${appUrl}/sign-in`;
  return {
    to,
    subject: "Kovobot sign-up is open",
    text: [
      "You asked us to tell you when Kovobot opens. Sign-up is open now:",
      "",
      signIn,
      "",
      "This is the only email we send about it.",
    ].join("\n"),
    html: [
      "<p>You asked us to tell you when Kovobot opens. Sign-up is open now:</p>",
      `<p><a href="${signIn}">Sign up for Kovobot</a></p>`,
      "<p>This is the only email we send about it.</p>",
    ].join("\n"),
  };
}
