import type { AppDeps } from "../app.ts";
import type { Email } from "../mailer.ts";
import { hashToken, newToken } from "../tokens.ts";

const LINK_LIFETIME_MINUTES = 15;
const LINKS_PER_HOUR = 5;

/**
 * Emails a one-time sign-in link. The same link signs a new Customer up.
 * Past the hourly limit for the address it quietly sends nothing, so the
 * caller's answer never reveals whether an inbox is being flooded.
 */
export async function sendSignInLink(deps: AppDeps, email: string): Promise<void> {
  const token = newToken();
  const now = deps.now();
  const { rowCount } = await deps.db.query(
    `INSERT INTO sign_in_links (token_hash, email, created_at, expires_at)
     SELECT $1, $2::text, $3::timestamptz, $4
     WHERE (SELECT count(*) FROM sign_in_links
            WHERE email = $2::text AND created_at > $3::timestamptz - interval '1 hour') < $5`,
    [hashToken(token), email, now, new Date(now.getTime() + LINK_LIFETIME_MINUTES * 60_000), LINKS_PER_HOUR],
  );
  if (rowCount === 0) return;
  // The token rides in the fragment, so it never reaches a server log or a Referer header.
  const link = `${deps.config.appUrl}/sign-in/confirm#token=${token}`;
  await deps.mailer.send(signInEmail(email, link));
}

/** Uses up a sign-in link. Returns its email, or null if it's unknown, used or expired. */
export async function redeemSignInLink(deps: AppDeps, token: string): Promise<string | null> {
  const now = deps.now();
  const { rows } = await deps.db.query<{ email: string }>(
    `UPDATE sign_in_links SET used_at = $2
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
     RETURNING email`,
    [hashToken(token), now],
  );
  return rows[0]?.email ?? null;
}

function signInEmail(to: string, link: string): Email {
  return {
    to,
    subject: "Your Kovobot sign-in link",
    text: [
      "Use this link to sign in to Kovobot:",
      "",
      link,
      "",
      `It works once and expires in ${LINK_LIFETIME_MINUTES} minutes.`,
      "If you didn't ask for it, ignore this email. Nobody can sign in without the link.",
    ].join("\n"),
    html: [
      "<p>Use this link to sign in to Kovobot:</p>",
      `<p><a href="${escapeHtml(link)}">Sign in to Kovobot</a></p>`,
      `<p>It works once and expires in ${LINK_LIFETIME_MINUTES} minutes.</p>`,
      "<p>If you didn't ask for it, ignore this email. Nobody can sign in without the link.</p>",
    ].join("\n"),
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
