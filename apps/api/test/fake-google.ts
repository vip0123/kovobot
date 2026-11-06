import { createHash, randomUUID } from "node:crypto";

export interface FakeGoogleAccount {
  sub: string;
  email: string;
  email_verified: boolean;
  /** The Google Workspace domain, for Workspace accounts. */
  hd?: string;
}

/**
 * Stands in for Google's OAuth 2.0 endpoints. `approve` plays the consent
 * screen; `fetch` answers the API's call to the token endpoint, checking the
 * client credentials, redirect URI and PKCE verifier the way Google does.
 */
export class FakeGoogle {
  private readonly codes = new Map<string, { account: FakeGoogleAccount; challenge: string; redirectUri: string }>();
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly now: () => Date;

  constructor(clientId: string, clientSecret: string, now: () => Date) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.now = now;
  }

  /** The person picks `account` on Google's consent screen. Returns where Google sends the browser back. */
  approve(authorizationUrl: string, account: FakeGoogleAccount): string {
    const url = new URL(authorizationUrl);
    if (url.origin + url.pathname !== "https://accounts.google.com/o/oauth2/v2/auth") {
      throw new Error(`not Google's authorization endpoint: ${authorizationUrl}`);
    }
    const params = url.searchParams;
    if (params.get("client_id") !== this.clientId) throw new Error("wrong client_id");
    if (params.get("response_type") !== "code") throw new Error("response_type must be code");
    if (params.get("code_challenge_method") !== "S256") throw new Error("PKCE must use S256");
    if (!params.get("scope")?.split(" ").includes("email")) throw new Error("the email scope is missing");

    const code = randomUUID();
    const redirectUri = params.get("redirect_uri")!;
    this.codes.set(code, { account, challenge: params.get("code_challenge")!, redirectUri });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", params.get("state")!);
    return back.toString();
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url !== "https://oauth2.googleapis.com/token" || init?.method !== "POST") {
      throw new Error(`unexpected outside call: ${init?.method ?? "GET"} ${url}`);
    }
    const form = new URLSearchParams(String(init.body));
    const grant = this.codes.get(form.get("code") ?? "");
    this.codes.delete(form.get("code") ?? "");
    const verifierMatches =
      grant && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === grant.challenge;
    if (
      !grant ||
      !verifierMatches ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("client_id") !== this.clientId ||
      form.get("client_secret") !== this.clientSecret ||
      form.get("redirect_uri") !== grant.redirectUri
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const now = Math.floor(this.now().getTime() / 1000);
    const idToken = [
      base64url({ alg: "RS256", typ: "JWT" }),
      base64url({ iss: "https://accounts.google.com", aud: this.clientId, iat: now, exp: now + 3600, ...grant.account }),
      "signature",
    ].join(".");
    return Response.json({ access_token: "ya29.fake", id_token: idToken, expires_in: 3599, token_type: "Bearer" });
  };
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
