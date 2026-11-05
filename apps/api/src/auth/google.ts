import { createHash } from "node:crypto";
import type { GoogleSignInSettings } from "@kovobot/config";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface GoogleIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
}

/** Where to send the browser to sign in with Google (authorization code flow with PKCE). */
export function googleAuthorizationUrl(
  settings: GoogleSignInSettings,
  redirectUri: string,
  state: string,
  codeVerifier: string,
): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

/**
 * Trades the code from Google's redirect for the person's identity, or null if
 * Google refuses. The ID token comes straight from Google's token endpoint over
 * TLS, so (OpenID Connect Core 3.1.3.7) its issuer is trusted without checking
 * the signature; its audience and expiry are still checked.
 */
export async function googleIdentity(
  fetchFn: typeof fetch,
  settings: GoogleSignInSettings,
  redirectUri: string,
  code: string,
  codeVerifier: string,
  now: Date,
): Promise<GoogleIdentity | null> {
  const response = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!response.ok) return null;
  const { id_token: idToken } = (await response.json()) as { id_token?: unknown };
  const claims = typeof idToken === "string" ? jwtClaims(idToken) : null;
  if (
    !claims ||
    !ISSUERS.has(String(claims.iss)) ||
    claims.aud !== settings.clientId ||
    typeof claims.exp !== "number" ||
    claims.exp * 1000 <= now.getTime() ||
    typeof claims.sub !== "string" ||
    typeof claims.email !== "string"
  ) {
    return null;
  }
  return {
    subject: claims.sub,
    email: claims.email.toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
  };
}

function jwtClaims(jwt: string): Record<string, unknown> | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
