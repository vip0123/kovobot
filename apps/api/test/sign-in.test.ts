import { describe, expect, test } from "vitest";
import { currentCustomer, signInToken, startTestServer, uniqueEmail } from "./harness.ts";

const server = startTestServer();

describe("sign-in by email link", () => {
  test("a new Customer signs up with an email link and is signed in", async () => {
    const browser = server.browser();
    const email = uniqueEmail();

    expect((await browser.post("/api/auth/email-link", { email })).status).toBe(202);
    const confirmed = await browser.post("/api/auth/email-link/confirm", {
      token: signInToken(server.lastEmailTo(email)),
    });
    expect(confirmed.status).toBe(200);

    const me = await browser.get("/api/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ customer: { email } });
  });

  test("signing in again with the same email, in any case, reaches the same Customer", async () => {
    const email = uniqueEmail();
    const first = await signedInCustomer(email);
    const second = await signedInCustomer(`  ${email.toUpperCase()} `);

    expect(second.id).toBe(first.id);
  });

  test("a sign-in link works only once", async () => {
    const email = uniqueEmail();
    await server.browser().post("/api/auth/email-link", { email });
    const token = signInToken(server.lastEmailTo(email));

    expect((await server.browser().post("/api/auth/email-link/confirm", { token })).status).toBe(200);
    const again = await server.browser().post("/api/auth/email-link/confirm", { token });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: "link_invalid" } });
  });

  test("a sign-in link stops working after 15 minutes", async () => {
    const email = uniqueEmail();
    await server.browser().post("/api/auth/email-link", { email });
    const token = signInToken(server.lastEmailTo(email));

    server.clock.advanceMinutes(16);
    const late = await server.browser().post("/api/auth/email-link/confirm", { token });
    expect(late.status).toBe(400);
  });

  test("at most 5 links go to one address per hour, so nobody can flood an inbox", async () => {
    const email = uniqueEmail();
    const sentTo = () => server.outbox.filter((sent) => sent.to === email).length;

    for (let i = 0; i < 6; i++) {
      expect((await server.browser().post("/api/auth/email-link", { email })).status).toBe(202);
    }
    expect(sentTo()).toBe(5);

    server.clock.advanceMinutes(61);
    await server.browser().post("/api/auth/email-link", { email });
    expect(sentTo()).toBe(6);
  });

  test("the hourly limit holds when the requests arrive all at once", async () => {
    const email = uniqueEmail();

    await Promise.all(Array.from({ length: 10 }, () => server.browser().post("/api/auth/email-link", { email })));

    expect(server.outbox.filter((sent) => sent.to === email).length).toBe(5);
  });

  test("something that isn't an email address is refused and nothing is sent", async () => {
    const sentBefore = server.outbox.length;
    const response = await server.browser().post("/api/auth/email-link", { email: "not-an-address" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_email" } });
    expect(server.outbox.length).toBe(sentBefore);
  });

  test("when the sign-in email can't be sent, the page hears so and asking again works", async () => {
    const email = uniqueEmail();
    server.mail.down = true;
    try {
      const failed = await server.browser().post("/api/auth/email-link", { email });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ error: { code: "email_failed" } });
    } finally {
      server.mail.down = false;
    }

    expect((await server.browser().post("/api/auth/email-link", { email })).status).toBe(202);
    expect(server.lastEmailTo(email)).toBeDefined();
  });
});

describe("sessions", () => {
  test("without a session the API answers 401", async () => {
    const response = await server.browser().get("/api/me");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "signed_out" } });
  });

  test("a session ends after 30 days", async () => {
    const browser = server.browser();
    await signIn(browser, uniqueEmail());

    server.clock.advanceMinutes(30 * 24 * 60 + 1);
    expect((await browser.get("/api/me")).status).toBe(401);
  });

  test("signing out ends the session, even for a copy of the cookie", async () => {
    const browser = server.browser();
    await signIn(browser, uniqueEmail());
    const copied = server.browser();
    copied.setCookie("kovobot_session", browser.cookie("kovobot_session")!);

    expect((await browser.post("/api/auth/sign-out")).status).toBe(204);
    expect((await browser.get("/api/me")).status).toBe(401);
    expect((await copied.get("/api/me")).status).toBe(401);
  });

  test("a write sent from another website is refused, even with a session", async () => {
    const browser = server.browser();
    await signIn(browser, uniqueEmail());

    const forged = await browser.post("/api/auth/sign-out", undefined, { origin: "https://evil.example" });
    expect(forged.status).toBe(403);
    expect((await browser.get("/api/me")).status).toBe(200);
  });

  test("a forged session cookie is not accepted", async () => {
    const browser = server.browser();
    browser.setCookie("kovobot_session", "made-up-token.c2lnbmF0dXJl");

    expect((await browser.get("/api/me")).status).toBe(401);
  });
});

const signIn = server.signInByEmail;

async function signedInCustomer(email: string) {
  const browser = server.browser();
  await signIn(browser, email);
  return (await currentCustomer(browser))!;
}
