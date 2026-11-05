import { randomUUID } from "node:crypto";
import { afterAll, expect, inject } from "vitest";
import { loadConfig, type Env } from "@kovobot/config";
import { createDb } from "@kovobot/db";
import { createApp } from "../src/app.ts";
import type { Email } from "../src/mailer.ts";
import { FakeGoogle } from "./fake-google.ts";

/**
 * The API wired to the real, migrated test database. Only the edges are fake:
 * email lands in `outbox`, Google is `google`, and the clock is set by hand.
 */
export function startTestServer(env: Env = {}) {
  const db = createDb(inject("databaseUrl"));
  afterAll(() => db.end());

  const { config } = loadConfig({
    DATABASE_URL: inject("databaseUrl"),
    SESSION_SECRET: "test-session-secret-that-is-long-enough",
    ...env,
  });
  const outbox: Email[] = [];
  const clock = {
    now: new Date("2026-11-05T12:00:00Z"),
    advanceMinutes(minutes: number) {
      this.now = new Date(this.now.getTime() + minutes * 60_000);
    },
  };
  const google = new FakeGoogle(
    config.googleSignIn?.clientId ?? "google-sign-in-off",
    config.googleSignIn?.clientSecret ?? "google-sign-in-off",
    () => clock.now,
  );
  const app = createApp({
    config,
    db,
    mailer: { send: async (email) => void outbox.push(email) },
    fetch: google.fetch,
    now: () => clock.now,
  });

  return {
    config,
    outbox,
    clock,
    google,
    /** A fresh browser: its own cookies, and the web app's Origin on every request. */
    browser: () => new Browser(app, config.appUrl),
    lastEmailTo,
    /** Signs `browser` in with an email link sent to `email`. */
    async signInByEmail(browser: Browser, email: string): Promise<void> {
      await browser.post("/api/auth/email-link", { email });
      const confirmed = await browser.post("/api/auth/email-link/confirm", {
        token: signInToken(lastEmailTo(email.trim().toLowerCase())),
      });
      expect(confirmed.status).toBe(200);
    },
  };

  /** The last email sent to `to`. */
  function lastEmailTo(to: string): Email {
    const email = outbox.findLast((sent) => sent.to === to);
    expect(email, `an email to ${to}`).toBeDefined();
    return email!;
  }
}

/** The signed-in Customer, as the Bots page sees it. */
export async function currentCustomer(browser: Browser): Promise<{ id: string; email: string } | null> {
  const response = await browser.get("/api/me");
  if (response.status === 401) return null;
  expect(response.status).toBe(200);
  return ((await response.json()) as { customer: { id: string; email: string } }).customer;
}

export function uniqueEmail(): string {
  return `ada.${randomUUID().slice(0, 8)}@example.com`;
}

/** The token from the sign-in link in an email. */
export function signInToken(email: Email): string {
  const match = /#token=([\w-]+)/.exec(email.text);
  expect(match, "a sign-in link in the email").not.toBeNull();
  return match![1]!;
}

type App = ReturnType<typeof createApp>;

export class Browser {
  private readonly cookies = new Map<string, string>();
  private readonly app: App;
  private readonly origin: string;

  constructor(app: App, origin: string) {
    this.app = app;
    this.origin = origin;
  }

  get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.send(path, { method: "GET", headers });
  }

  post(path: string, json?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.send(path, {
      method: "POST",
      headers: { origin: this.origin, ...(json === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  private async send(path: string, init: { method: string; headers: Record<string, string>; body?: string }) {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await this.app.request(path, {
      ...init,
      headers: { ...init.headers, ...(cookie ? { cookie } : {}) },
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";");
      const [name = "", value = ""] = pair.split("=", 2).map((part) => part.trim());
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
}
