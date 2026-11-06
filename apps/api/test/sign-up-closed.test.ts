import { describe, expect, test } from "vitest";
import { findOrCreateCustomerByEmail } from "../src/customers.ts";
import { listLeads } from "../src/leads.ts";
import { currentCustomer, googleAccount, startTestServer, uniqueEmail } from "./harness.ts";

// Before launch: sign-up is closed, and the landing page collects a waitlist.
const server = startTestServer({
  SIGN_UP_OPEN: "false",
  GOOGLE_OAUTH_CLIENT_ID: "kovobot-test.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
});

async function onWaitlist(email: string): Promise<boolean> {
  return (await listLeads(server.deps.db)).some((lead) => lead.email === email);
}

describe("while sign-up is closed", () => {
  test("the sign-in page is told, so it can say so", async () => {
    expect(await (await server.browser().get("/api/auth/options")).json()).toEqual({
      google: true,
      signUpOpen: false,
    });
  });

  test("a new address joins the waitlist instead of getting a sign-in link, and hears nothing until launch", async () => {
    const email = uniqueEmail();

    expect((await server.browser().post("/api/auth/email-link", { email })).status).toBe(202);

    expect(server.outbox.filter((mail) => mail.to === email)).toEqual([]);
    expect(await onWaitlist(email)).toBe(true);
  });

  test("an existing Customer still signs in by email link", async () => {
    const email = uniqueEmail();
    await findOrCreateCustomerByEmail(server.deps.db, email);
    const browser = server.browser();

    await server.signInByEmail(browser, email);

    expect(await currentCustomer(browser)).toMatchObject({ email });
  });

  test("Google can't create a Customer; the visitor joins the waitlist instead", async () => {
    const browser = server.browser();
    const account = googleAccount();

    const landed = await server.signInWithGoogle(browser, account);

    expect(landed.headers.get("location")).toBe(`${server.config.appUrl}/sign-in?error=sign_up_closed`);
    expect(await currentCustomer(browser)).toBeNull();
    expect(await onWaitlist(account.email)).toBe(true);
  });

  test("an existing Customer can still sign in with Google", async () => {
    const account = googleAccount();
    await findOrCreateCustomerByEmail(server.deps.db, account.email);
    const browser = server.browser();

    await server.signInWithGoogle(browser, account);

    expect(await currentCustomer(browser)).toMatchObject({ email: account.email });
  });
});
