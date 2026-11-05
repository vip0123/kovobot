import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, inject } from "vitest";
import { loadConfig, type Env } from "@kovobot/config";
import { createDb } from "@kovobot/db";
import { type AppDeps, createApp } from "../src/app.ts";
import type { Email } from "../src/mailer.ts";
import type { ModelAdapter, ModelAdapters } from "../src/models/adapter.ts";
import { createOpenAIAdapter } from "../src/models/openai.ts";
import { FakeGoogle, type FakeGoogleAccount } from "./fake-google.ts";
import { FAKE_OPENAI_KEY, FakeOpenAI } from "./fake-openai.ts";

/**
 * The API wired to the real, migrated test database. Only the edges are fake:
 * email lands in `outbox`, Google is `google`, OpenAI is `openai` (a local
 * server the real SDK talks to), and the clock is set by hand.
 */
export function startTestServer(env: Env = {}, options: { openai?: boolean } = {}) {
  const db = createDb(inject("databaseUrl"));
  afterAll(() => db.end());
  const openai = new FakeOpenAI();
  beforeAll(() => openai.start());
  afterAll(() => openai.stop());
  // The fake's address is known only once it listens, so the adapter is made on first use.
  let openaiAdapter: ModelAdapter | undefined;
  const models: ModelAdapters = {
    openai:
      options.openai === false
        ? null
        : {
            stream: (request) =>
              (openaiAdapter ??= createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl })).stream(
                request,
              ),
          },
  };

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
  const deps: AppDeps = {
    config,
    db,
    mailer: { send: async (email) => void outbox.push(email) },
    fetch: google.fetch,
    models,
    now: () => clock.now,
  };
  const app = createApp(deps);

  return {
    /** What the app runs on, for calling modules the CLI commands use. */
    deps,
    config,
    outbox,
    clock,
    google,
    openai,
    /** A fresh browser: its own cookies, and the web app's Origin on every request. */
    browser: () => new Browser(app, config.appUrl),
    lastEmailTo,
    /** Goes to Google, picks `account` there, and comes back. Returns the API's last answer. */
    async signInWithGoogle(browser: Browser, account: FakeGoogleAccount): Promise<Response> {
      const start = await browser.get("/api/auth/google");
      expect(start.status).toBe(302);
      const callback = new URL(google.approve(start.headers.get("location")!, account));
      return browser.get(callback.pathname + callback.search);
    },
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

/** The server-sent events in a streamed response, in order. */
export async function serverSentEvents(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await response.text();
  return text
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      return { event, data: data ? JSON.parse(data) : null };
    });
}

/** A Google Workspace account on example.com: Google vouches that its owner owns the address. */
export function googleAccount(email = uniqueEmail()): FakeGoogleAccount {
  return { sub: `google-${email}`, email, email_verified: true, hd: "example.com" };
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

  get(path: string): Promise<Response> {
    return this.send(path, { method: "GET", headers: {} });
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

  async send(path: string, init: { method: string; headers: Record<string, string>; body?: string }) {
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
