import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { AppDeps } from "../app.ts";
import type { Customer } from "../customers.ts";
import { hashToken, newToken } from "../tokens.ts";

const SESSION_COOKIE = "kovobot_session";
const SESSION_DAYS = 30;

/** Signs the browser in as `customerId`: a new session row and its cookie. */
export async function startSession(c: Context, deps: AppDeps, customerId: string): Promise<void> {
  const token = newToken();
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await deps.db.query(
    "INSERT INTO sessions (token_hash, customer_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
    [hashToken(token), customerId, now, expiresAt],
  );
  await setSignedCookie(
    c,
    SESSION_COOKIE,
    token,
    deps.config.sessionSecret,
    cookieOptions(deps, "/", SESSION_DAYS * 24 * 60 * 60),
  );
}

/** HttpOnly, SameSite=Lax, and Secure whenever the API is served over https. */
export function cookieOptions(deps: AppDeps, path: string, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: deps.config.apiUrl.startsWith("https:"),
    sameSite: "Lax",
    path,
    maxAge: maxAgeSeconds,
  } as const;
}

/** The signed-in Customer, or null when the browser has no live session. */
export async function sessionCustomer(c: Context, deps: AppDeps): Promise<Customer | null> {
  const token = await getSignedCookie(c, deps.config.sessionSecret, SESSION_COOKIE);
  if (!token) return null;
  const { rows } = await deps.db.query<Customer>(
    `SELECT customers.id, customers.email
     FROM sessions JOIN customers ON customers.id = sessions.customer_id
     WHERE sessions.token_hash = $1 AND sessions.expires_at > $2`,
    [hashToken(token), deps.now()],
  );
  return rows[0] ?? null;
}

/** Signs the browser out: deletes its session and clears the cookie. */
export async function endSession(c: Context, deps: AppDeps): Promise<void> {
  const token = await getSignedCookie(c, deps.config.sessionSecret, SESSION_COOKIE);
  if (token) await deps.db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
