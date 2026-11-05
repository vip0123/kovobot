import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig, type Env } from "./index.ts";

function configProblems(env: Env): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected loadConfig to refuse this environment");
}

const hostedEnv = {
  KOVOBOT_MODE: "hosted",
  NODE_ENV: "production",
  APP_URL: "https://staging.kovobot.example",
  API_URL: "https://staging.kovobot.example",
  DATABASE_URL: "postgres://kovobot:secret@10.0.0.5:5432/kovobot",
  SESSION_SECRET: "x".repeat(44),
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "apikey",
  SMTP_PASSWORD: "secret",
  EMAIL_FROM: "Kovobot <noreply@kovobot.example>",
};

describe("deployment mode", () => {
  test("hosted turns billing, Plan limits and analytics on", () => {
    const { config } = loadConfig(hostedEnv);

    expect(config.mode).toBe("hosted");
    expect(config.billingEnabled).toBe(true);
    expect(config.planLimitsEnabled).toBe(true);
    expect(config.analyticsEnabled).toBe(true);
  });

  test("a hosted staging install can switch billing and Plan limits off", () => {
    const { config } = loadConfig({
      ...hostedEnv,
      BILLING_ENABLED: "false",
      PLAN_LIMITS_ENABLED: "false",
    });

    expect(config.billingEnabled).toBe(false);
    expect(config.planLimitsEnabled).toBe(false);
  });

  test("an unknown deployment mode is refused instead of guessed", () => {
    expect(() => loadConfig({ KOVOBOT_MODE: "hostd" })).toThrow(/KOVOBOT_MODE/);
  });

  test("a self-hosted install refuses to switch billing on, so it never charges", () => {
    expect(() => loadConfig({ BILLING_ENABLED: "true" })).toThrow(/BILLING_ENABLED/);
  });

  test("hosted refuses to start without its database, session secret and email, or on plain http", () => {
    const problems = configProblems({
      KOVOBOT_MODE: "hosted",
      APP_URL: "http://staging.kovobot.example",
      API_URL: "http://staging.kovobot.example",
    });

    expect(problems.map((p) => p.split(" ")[0]).sort()).toEqual([
      "API_URL",
      "APP_URL",
      "DATABASE_URL",
      "EMAIL_FROM",
      "SESSION_SECRET",
      "SMTP_HOST",
    ]);
  });

  test("an empty environment starts self-hosted with billing, Plan limits and analytics off", () => {
    const { config } = loadConfig({});

    expect(config.mode).toBe("self-hosted");
    expect(config.billingEnabled).toBe(false);
    expect(config.planLimitsEnabled).toBe(false);
    expect(config.analyticsEnabled).toBe(false);
  });
});

describe("self-hosted defaults", () => {
  test("without a session secret or SMTP it still starts, and warns about both", () => {
    const { config, warnings } = loadConfig({});

    expect(config.email.kind).toBe("log");
    expect(warnings).toEqual([
      expect.stringMatching(/^SESSION_SECRET is not set/),
      expect.stringMatching(/^SMTP_HOST is not set/),
    ]);
  });

  test("an explicit session secret shorter than 32 characters is refused", () => {
    expect(configProblems({ SESSION_SECRET: "short" })).toEqual([expect.stringMatching(/^SESSION_SECRET/)]);
  });
});

describe("Sign in with Google", () => {
  test("is off unless both the client ID and secret are set", () => {
    expect(loadConfig({}).config.googleSignIn).toBeNull();
    expect(
      loadConfig({ GOOGLE_OAUTH_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: "s" }).config
        .googleSignIn,
    ).toEqual({ clientId: "id.apps.googleusercontent.com", clientSecret: "s" });
  });

  test("is refused when only half set up", () => {
    expect(configProblems({ GOOGLE_OAUTH_CLIENT_ID: "id.apps.googleusercontent.com" })).toEqual([
      expect.stringMatching(/^GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET/),
    ]);
  });
});

describe("hosted problems", () => {
  test("each missing hosted setting is reported once", () => {
    const problems = configProblems({ KOVOBOT_MODE: "hosted" });

    expect(problems.filter((p) => p.startsWith("APP_URL"))).toEqual(["APP_URL is required when hosted."]);
  });
});
