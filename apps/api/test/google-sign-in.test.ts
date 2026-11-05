import { describe, expect, test } from "vitest";
import type { FakeGoogleAccount } from "./fake-google.ts";
import { type Browser, currentCustomer, startTestServer, uniqueEmail } from "./harness.ts";

const server = startTestServer({
  GOOGLE_OAUTH_CLIENT_ID: "kovobot-test.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
});

/** Goes to Google, picks `account` there, and comes back. Returns the API's last answer. */
async function signInWithGoogle(browser: Browser, account: FakeGoogleAccount): Promise<Response> {
  const start = await browser.get("/api/auth/google");
  expect(start.status).toBe(302);
  const callback = new URL(server.google.approve(start.headers.get("location")!, account));
  return browser.get(callback.pathname + callback.search);
}

/** A Google Workspace account on example.com: Google vouches that its owner owns the address. */
function googleAccount(email = uniqueEmail()): FakeGoogleAccount {
  return { sub: `google-${email}`, email, email_verified: true, hd: "example.com" };
}

describe("Sign in with Google", () => {
  test("a new Customer signs up with Google and lands on the Bots page", async () => {
    const browser = server.browser();
    const account = googleAccount();

    const landed = await signInWithGoogle(browser, account);

    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe(`${server.config.appUrl}/bots`);
    expect(await currentCustomer(browser)).toMatchObject({ email: account.email });
  });

  test("it reaches the Customer who signed up by email link with the same address", async () => {
    const email = uniqueEmail();
    const byLink = server.browser();
    await server.signInByEmail(byLink, email);
    const byGoogle = server.browser();

    await signInWithGoogle(byGoogle, googleAccount(email));

    expect((await currentCustomer(byGoogle))?.id).toBe((await currentCustomer(byLink))?.id);
  });

  test("an address Google hasn't verified is refused", async () => {
    const browser = server.browser();

    const landed = await signInWithGoogle(browser, { ...googleAccount(), email_verified: false });

    expect(landed.headers.get("location")).toBe(`${server.config.appUrl}/sign-in?error=google`);
    expect(await currentCustomer(browser)).toBeNull();
  });

  test("an address Google can't vouch for, outside Gmail and Google Workspace, is refused", async () => {
    // Google only vouches for an address it hosts: elsewhere, a verified email
    // may belong to someone who has since lost it.
    const browser = server.browser();
    const email = uniqueEmail();
    const personalAccount = { sub: `google-${email}`, email, email_verified: true };

    const landed = await signInWithGoogle(browser, personalAccount);

    expect(landed.headers.get("location")).toBe(`${server.config.appUrl}/sign-in?error=google`);
    expect(await currentCustomer(browser)).toBeNull();
  });

  test("a Customer linked to one Google account can't be reached by another with the same address", async () => {
    const email = uniqueEmail();
    await signInWithGoogle(server.browser(), { ...googleAccount(email), sub: "google-first" });
    const second = server.browser();

    const landed = await signInWithGoogle(second, { ...googleAccount(email), sub: "google-second" });

    expect(landed.headers.get("location")).toBe(`${server.config.appUrl}/sign-in?error=google`);
    expect(await currentCustomer(second)).toBeNull();
  });

  test("a callback that didn't start in this browser is refused", async () => {
    // An attacker approves their own Google account, then lures the victim,
    // who is midway through signing in, to the attacker's callback link.
    const attackerStart = await server.browser().get("/api/auth/google");
    const callback = new URL(server.google.approve(attackerStart.headers.get("location")!, googleAccount()));
    const victim = server.browser();
    await victim.get("/api/auth/google");

    const landed = await victim.get(callback.pathname + callback.search);

    expect(landed.headers.get("location")).toBe(`${server.config.appUrl}/sign-in?error=google`);
    expect(await currentCustomer(victim)).toBeNull();
  });
});

describe("without Google set up", () => {
  const plain = startTestServer();

  test("the sign-in page offers only the email link, and the Google route is off", async () => {
    const browser = plain.browser();

    expect(await (await browser.get("/api/auth/options")).json()).toEqual({ google: false });
    expect((await browser.get("/api/auth/google")).status).toBe(404);
  });
});
