import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { AppDeps } from "../app.ts";
import {
  findCustomerByEmail,
  findOrCreateCustomerByEmail,
  findOrCreateCustomerForGoogle,
  normaliseEmail,
} from "../customers.ts";
import { apiError, jsonBody } from "../http.ts";
import { joinWaitlist } from "../leads.ts";
import { newToken } from "../tokens.ts";
import { redeemSignInLink, sendSignInLink } from "./email-links.ts";
import { googleAuthorizationUrl, googleIdentity } from "./google.ts";
import { cookieOptions, endSession, sessionCustomer, startSession } from "./sessions.ts";

// Holds the OAuth state and PKCE verifier between leaving for Google and coming back.
const GOOGLE_COOKIE = "kovobot_google";
const GOOGLE_COOKIE_PATH = "/api/auth/google";

export function authRoutes(deps: AppDeps) {
  const routes = new Hono();

  const { signUpOpen } = deps.config;

  routes.post("/auth/email-link", async (c) => {
    const email = normaliseEmail((await jsonBody(c)).email);
    if (!email) return apiError(c, 400, "invalid_email", "Enter a valid email address.");
    // The answer is the same either way, so it never reveals who is a Customer.
    if (!signUpOpen && !(await findCustomerByEmail(deps.db, email))) await joinWaitlist(deps, email);
    else await sendSignInLink(deps, email);
    return c.json({}, 202);
  });

  routes.post("/auth/email-link/confirm", async (c) => {
    const { token } = await jsonBody(c);
    const email = typeof token === "string" && token ? await redeemSignInLink(deps, token) : null;
    if (!email) {
      return apiError(c, 400, "link_invalid", "This sign-in link has expired or was already used. Ask for a new one.");
    }
    const customer = signUpOpen
      ? await findOrCreateCustomerByEmail(deps.db, email)
      : await findCustomerByEmail(deps.db, email);
    if (!customer) return apiError(c, 403, "sign_up_closed", "Sign-up opens at launch. We'll email you when it does.");
    await startSession(c, deps, customer.id);
    return c.json({ customer });
  });

  routes.get("/auth/options", (c) => c.json({ google: deps.config.googleSignIn !== null, signUpOpen }));

  const googleRedirectUri = `${deps.config.apiUrl}/api/auth/google/callback`;

  routes.get("/auth/google", async (c) => {
    const settings = deps.config.googleSignIn;
    if (!settings) return apiError(c, 404, "google_sign_in_off", "Sign in with Google isn't set up here.");
    const state = newToken();
    const codeVerifier = newToken();
    await setSignedCookie(
      c,
      GOOGLE_COOKIE,
      `${state}:${codeVerifier}`,
      deps.config.sessionSecret,
      cookieOptions(deps, GOOGLE_COOKIE_PATH, 10 * 60),
    );
    return c.redirect(googleAuthorizationUrl(settings, googleRedirectUri, state, codeVerifier));
  });

  routes.get("/auth/google/callback", async (c) => {
    const settings = deps.config.googleSignIn;
    if (!settings) return apiError(c, 404, "google_sign_in_off", "Sign in with Google isn't set up here.");
    const saved = await getSignedCookie(c, deps.config.sessionSecret, GOOGLE_COOKIE);
    deleteCookie(c, GOOGLE_COOKIE, { path: GOOGLE_COOKIE_PATH });
    const failed = () => c.redirect(`${deps.config.appUrl}/sign-in?error=google`);

    // The state must match the one this browser was given, or the callback didn't start here.
    const [state, codeVerifier] = typeof saved === "string" ? saved.split(":") : [];
    const code = c.req.query("code");
    if (!state || !codeVerifier || !code || c.req.query("state") !== state) return failed();

    const identity = await googleIdentity(deps.fetch, settings, googleRedirectUri, code, codeVerifier, deps.now());
    if (!identity) return failed();
    const customer = await findOrCreateCustomerForGoogle(deps.db, identity, { mayCreate: signUpOpen });
    if (!customer) {
      const newcomer = !signUpOpen && identity.ownsEmail && !(await findCustomerByEmail(deps.db, identity.email));
      if (!newcomer) return failed();
      await joinWaitlist(deps, identity.email);
      return c.redirect(`${deps.config.appUrl}/sign-in?error=sign_up_closed`);
    }
    await startSession(c, deps, customer.id);
    return c.redirect(`${deps.config.appUrl}/bots`);
  });

  routes.post("/auth/sign-out", async (c) => {
    await endSession(c, deps);
    return c.body(null, 204);
  });

  routes.get("/me", async (c) => {
    const customer = await sessionCustomer(c, deps);
    if (!customer) return apiError(c, 401, "signed_out", "Sign in to continue.");
    return c.json({ customer });
  });

  return routes;
}
