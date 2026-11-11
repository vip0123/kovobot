import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, expect, inject } from "vitest";
import { loadConfig, type Env } from "@kovobot/config";
import { createDb } from "@kovobot/db";
import { type AppDeps, createApp } from "../src/app.ts";
import { createComposioClient } from "../src/composio.ts";
import { createComputerServiceClient } from "../src/computers.ts";
import { liveViewUpgrade } from "../src/live-view.ts";
import type { Email } from "../src/mailer.ts";
import type { ModelAdapter, ModelAdapters } from "../src/models/adapter.ts";
import { createAnthropicAdapter } from "../src/models/anthropic.ts";
import { createOpenAIAdapter } from "../src/models/openai.ts";
import { createOpenAICompatibleAdapter } from "../src/models/openai-compatible.ts";
import { FakeGoogle, type FakeGoogleAccount } from "./fake-google.ts";
import { FAKE_COMPOSIO_KEY, FakeComposio } from "./fake-composio.ts";
import { FakeComputerService } from "./fake-computer-service.ts";
import { FakeAnthropic, FakeChatCompletions } from "./fake-models.ts";
import { FAKE_OPENAI_KEY, FakeOpenAI } from "./fake-openai.ts";
import { FakeWeb } from "./fake-web.ts";
import { FAKE_GEMINI_KEY, FakeGeminiInteractions } from "./fake-gemini-interactions.ts";
import { createGoogleImageMaker, createOpenAIImageMaker } from "../src/media/images.ts";

/**
 * The API wired to the real, migrated test database. Only the edges are fake:
 * email lands in `outbox` (or fails, with `mail.down`), Google is `google`, and the clock is set by hand.
 * Model providers are local servers the real SDKs talk to: OpenAI is `openai`,
 * Anthropic `anthropic`, and `chatCompletions` serves OpenRouter and a local
 * model server, each only when its option is on.
 */
export function startTestServer(
  env: Env = {},
  options: {
    openai?: boolean;
    openrouter?: boolean;
    local?: boolean;
    computers?: boolean;
    composio?: boolean;
    /** Which Model provider's image model Bots make pictures with, or none: OpenAI's unless set. */
    images?: "openai" | "google" | false;
  } = {},
) {
  const db = createDb(inject("databaseUrl"));
  afterAll(() => db.end());
  // The Computer service, when on, and a real listening API in front of it: the live view is a WebSocket.
  const computerService = new FakeComputerService();
  const listening: { url: string; server?: ServerType } = { url: "" };
  if (options.computers) {
    beforeAll(async () => {
      await computerService.start();
      listening.server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
      // Each open live view checks every 100 ms that its viewer may still watch.
      listening.server.on("upgrade", liveViewUpgrade(app, deps, { recheckMs: 100 }));
      await new Promise((resolve) => listening.server!.once("listening", resolve));
      listening.url = `http://127.0.0.1:${(listening.server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise((resolve) => listening.server?.close(resolve));
      await computerService.stop();
    });
  }
  // Composio, when on: Connected apps go through the real client to a local stand-in.
  const composio = new FakeComposio();
  if (options.composio) {
    beforeAll(() => composio.start());
    afterAll(() => composio.stop());
  }
  const openai = new FakeOpenAI();
  const anthropic = new FakeAnthropic();
  const chatCompletions = new FakeChatCompletions();
  // The web pages a researching Bot reads, and Google's media models.
  const web = new FakeWeb();
  const geminiMedia = new FakeGeminiInteractions();
  beforeAll(() => Promise.all([openai.start(), anthropic.start(), chatCompletions.start("/v1"), web.start(), geminiMedia.start()]));
  afterAll(() => Promise.all([openai.stop(), anthropic.stop(), chatCompletions.stop(), web.stop(), geminiMedia.stop()]));
  const images = options.images ?? "openai";
  // A fake's address is known only once it listens, so each adapter is made on first use.
  const lazy = (make: () => ModelAdapter): ModelAdapter => {
    let adapter: ModelAdapter | undefined;
    return { stream: (request) => (adapter ??= make()).stream(request) };
  };
  const models: ModelAdapters = {
    openai:
      options.openai === false
        ? null
        : lazy(() => createOpenAIAdapter({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl })),
    anthropic: lazy(() => createAnthropicAdapter({ apiKey: "sk-ant-test", baseURL: anthropic.baseUrl })),
    google: null,
    xai: null,
    openrouter: options.openrouter
      ? lazy(() => createOpenAICompatibleAdapter({ apiKey: "sk-or-test", baseURL: chatCompletions.baseUrl }))
      : null,
    local: options.local
      ? lazy(() => createOpenAICompatibleAdapter({ apiKey: "local", baseURL: chatCompletions.baseUrl }))
      : null,
  };

  const { config } = loadConfig({
    DATABASE_URL: inject("databaseUrl"),
    SESSION_SECRET: "test-session-secret-that-is-long-enough",
    ...env,
  });
  const outbox: Email[] = [];
  /** Set `down` and every email fails to send, as when the mail server can't be reached. */
  const mail = { down: false };
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
    mailer: {
      send: async (email) => {
        if (mail.down) throw new Error("getaddrinfo ENOTFOUND mail.example.com");
        outbox.push(email);
      },
    },
    // Google's token endpoint is the fake Google; pages on the fake web are read from it.
    fetch: (input, init) => (web.serves(input instanceof Request ? input.url : input.toString()) ? fetch(input, init) : google.fetch(input, init)),
    models,
    // The fake's address is known only once it listens, so the client is made on first use.
    computers: options.computers
      ? lazily(() => createComputerServiceClient({ url: computerService.baseUrl, apiKey: computerService.apiKey }))
      : null,
    composio: options.composio ? lazily(() => createComposioClient({ apiKey: FAKE_COMPOSIO_KEY, baseUrl: composio.apiUrl })) : null,
    images:
      images === "openai"
        ? lazily(() => createOpenAIImageMaker({ apiKey: FAKE_OPENAI_KEY, baseURL: openai.baseUrl }))
        : images === "google"
          ? lazily(() => createGoogleImageMaker({ apiKey: FAKE_GEMINI_KEY, baseURL: geminiMedia.baseUrl }))
          : null,
    now: () => clock.now,
  };
  const app = createApp(deps);

  return {
    /** What the app runs on, for calling modules the CLI commands use. */
    deps,
    config,
    outbox,
    mail,
    clock,
    google,
    openai,
    anthropic,
    chatCompletions,
    /** The web pages a Bot reads. */
    web,
    /** Google's Interactions API, for its image model when `images` is "google". */
    geminiMedia,
    computerService,
    /** The stand-in for Composio, when `composio` is on. */
    composio,
    /** The API listening on a real port, for WebSockets; set once the tests start, with `computers` on. */
    listening,
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

/** A client made on first call, once its fake's address is known. */
function lazily<Client extends object>(make: () => Client): Client {
  let client: Client | undefined;
  return new Proxy({} as Client, {
    get: (_target, method: string | symbol) => (...args: never[]) =>
      ((client ??= make())[method as keyof Client] as (...args: never[]) => unknown)(...args),
  });
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
