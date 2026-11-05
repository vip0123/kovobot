import { describe, expect, test } from "vitest";
import { announceSignUpOpen, listLeads } from "../src/leads.ts";
import { startTestServer, uniqueEmail } from "./harness.ts";

const LANDING = "https://kovobot.example";
const server = startTestServer({ LANDING_URL: LANDING });

function joinList(email: string, firstUse?: string) {
  return server.browser().post("/api/leads", { email, firstUse }, { origin: LANDING });
}

function toldSignUpIsOpen(email: string) {
  return server.outbox.filter((sent) => sent.to === email && /sign-up is open/i.test(sent.subject));
}

describe("the waitlist", () => {
  test("a visitor leaves an email and a first use, and both are kept with the time", async () => {
    const email = uniqueEmail();

    expect((await joinList(email, "market-watch")).status).toBe(201);

    const lead = (await listLeads(server.deps.db)).find((saved) => saved.email === email);
    expect(lead).toEqual({ email, firstUse: "market-watch", joinedAt: server.clock.now });
  });

  test("the same email joining twice is one lead", async () => {
    const email = uniqueEmail();
    await joinList(email, "inbox");
    await joinList(email.toUpperCase(), "reports");

    const leads = (await listLeads(server.deps.db)).filter((saved) => saved.email === email);
    expect(leads).toEqual([expect.objectContaining({ firstUse: "reports" })]);
  });

  test("something that isn't an email address is refused", async () => {
    const response = await joinList("not-an-address");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_email" } });
  });

  test("the landing page may post from its own origin", async () => {
    const preflight = await server.browser().send("/api/leads", {
      method: "OPTIONS",
      headers: { origin: LANDING, "access-control-request-method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe(LANDING);

    const other = await server.browser().send("/api/leads", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("announcing that sign-up is open", () => {
  test("every lead is emailed exactly once, however often it runs", async () => {
    const first = uniqueEmail();
    const second = uniqueEmail();
    await joinList(first);
    await joinList(second);

    await announceSignUpOpen(server.deps);
    await announceSignUpOpen(server.deps);

    expect(toldSignUpIsOpen(first)).toHaveLength(1);
    expect(toldSignUpIsOpen(second)).toHaveLength(1);
    expect(toldSignUpIsOpen(first)[0]!.text).toContain(`${server.config.appUrl}/sign-in`);
  });

  const closed = startTestServer({ SIGN_UP_OPEN: "false" });

  test("it refuses while sign-up is still closed", async () => {
    await expect(announceSignUpOpen(closed.deps)).rejects.toThrow(/SIGN_UP_OPEN/);
  });
});
