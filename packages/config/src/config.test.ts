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
      expect.stringMatching(/^No Model provider key is set/),
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

describe("one origin for the web app and the API", () => {
  test("serving the web build, the web app's URL is the API's, on the API's port", () => {
    const { config } = loadConfig({ PORT: "8080", WEB_DIST_DIR: "/app/apps/web/dist" });

    expect(config.apiUrl).toBe("http://localhost:8080");
    expect(config.appUrl).toBe("http://localhost:8080");
  });

  test("hosted refuses a web app on a different origin from the API", () => {
    const problems = configProblems({
      ...hostedEnv,
      APP_URL: "https://app.kovobot.example",
      API_URL: "https://api.kovobot.example",
    });

    expect(problems).toEqual([expect.stringMatching(/^APP_URL must equal API_URL/)]);
  });

  test("a port that isn't a number is refused", () => {
    expect(configProblems({ PORT: "eighty" })).toEqual([expect.stringMatching(/^PORT must be a port number/)]);
  });
});

describe("sign-up and the landing page", () => {
  test("self-hosted sign-up is open; hosted stays closed until launch unless SIGN_UP_OPEN says otherwise", () => {
    expect(loadConfig({}).config.signUpOpen).toBe(true);
    expect(loadConfig(hostedEnv).config.signUpOpen).toBe(false);
    expect(loadConfig({ ...hostedEnv, SIGN_UP_OPEN: "true" }).config.signUpOpen).toBe(true);
  });

  test("the landing page's origin is read from LANDING_URL, and is optional", () => {
    expect(loadConfig({}).config.landingUrl).toBeNull();
    expect(loadConfig({ LANDING_URL: "https://kovobot.com/" }).config.landingUrl).toBe("https://kovobot.com");
  });
});

describe("Model provider keys", () => {
  test("each Model provider's key switches it on; with none set, Bots can't reply and the server says so", () => {
    const { config } = loadConfig({
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-ant",
      GEMINI_API_KEY: "gemini-key",
      XAI_API_KEY: "xai-key",
      OPENROUTER_API_KEY: "sk-or",
    });
    expect(config.modelKeys).toEqual({
      openai: "sk-openai",
      anthropic: "sk-ant",
      google: "gemini-key",
      xai: "xai-key",
      openrouter: "sk-or",
    });

    const empty = loadConfig({});
    expect(empty.config.modelKeys).toEqual({ openai: null, anthropic: null, google: null, xai: null, openrouter: null });
    expect(empty.warnings).toContainEqual(expect.stringMatching(/^No Model provider key is set/));
  });

  test("an Anthropic key that isn't scoped to a workspace is used in the workspace named alongside it", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_WORKSPACE_ID: "wrkspc_01" }).config.anthropicWorkspaceId).toBe("wrkspc_01");
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-ant" }).config.anthropicWorkspaceId).toBeNull();
    expect(loadConfig({ ANTHROPIC_WORKSPACE_ID: "  " }).config.anthropicWorkspaceId).toBeNull();
    expect(loadConfig({ ANTHROPIC_WORKSPACE_ID: "my workspace" }).warnings).toContainEqual(
      expect.stringMatching(/^ANTHROPIC_WORKSPACE_ID doesn't look like a workspace id/),
    );
  });

  test("a local model server is for self-hosted installs only: the hosted service never calls a URL it is given", () => {
    expect(loadConfig({ OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1" }).config.localModelsUrl).toBe(
      "http://localhost:11434/v1",
    );
    expect(configProblems({ ...hostedEnv, OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1" })).toEqual([
      expect.stringMatching(/^OPENAI_COMPATIBLE_BASE_URL is for self-hosted installs only/),
    ]);
  });
});

describe("Computers", () => {
  const key = "k".repeat(32);

  test("are off until the Computer service's key is set; then the Bot service calls it at COMPUTER_SERVICE_URL", () => {
    expect(loadConfig({}).config.computerService).toBeNull();
    expect(loadConfig({ COMPUTER_SERVICE_API_KEY: key }).config.computerService).toEqual({
      url: "http://localhost:3100",
      apiKey: key,
    });
    expect(
      loadConfig({ COMPUTER_SERVICE_API_KEY: key, COMPUTER_SERVICE_URL: "http://computers:3100/" }).config.computerService,
    ).toEqual({ url: "http://computers:3100", apiKey: key });
  });

  test("are for self-hosted installs only, until hosted Computers run in the cloud and are billed", () => {
    expect(configProblems({ ...hostedEnv, COMPUTER_SERVICE_API_KEY: key })).toEqual([
      expect.stringMatching(/^COMPUTER_SERVICE_API_KEY is for self-hosted installs only/),
    ]);
  });

  test("a short Computer service key or a malformed address is refused", () => {
    expect(configProblems({ COMPUTER_SERVICE_API_KEY: "short" })).toEqual([
      expect.stringMatching(/^COMPUTER_SERVICE_API_KEY must be at least 32 characters/),
    ]);
    expect(configProblems({ COMPUTER_SERVICE_API_KEY: key, COMPUTER_SERVICE_URL: "computers" })).toEqual([
      'COMPUTER_SERVICE_URL must be a URL, not "computers".',
    ]);
  });
});

describe("the sweeps", () => {
  const key = "s".repeat(32);

  test("run on the Bot service's own clock, unless SWEEP_KEY hands them to an outside scheduler", () => {
    expect(loadConfig({}).config.sweepKey).toBeNull();
    expect(loadConfig({ ...hostedEnv, SWEEP_KEY: key }).config.sweepKey).toBe(key);
  });

  test("a short sweep key is refused", () => {
    expect(configProblems({ SWEEP_KEY: "short" })).toEqual([expect.stringMatching(/^SWEEP_KEY must be at least 32 characters/)]);
  });
});

describe("Connected apps", () => {
  const projectKey = "ak_" + "a".repeat(20);

  test("are off until a Composio key is set, hosted or self-hosted: then Bots use apps through Composio", () => {
    expect(loadConfig({}).config.composio).toBeNull();
    expect(loadConfig({ COMPOSIO_API_KEY: projectKey }).config.composio).toEqual({ apiKey: projectKey });
    expect(loadConfig({ ...hostedEnv, COMPOSIO_API_KEY: projectKey }).config.composio).toEqual({ apiKey: projectKey });
  });

  test("a Composio Connect consumer key, which Composio's platform API refuses, is warned about", () => {
    const { warnings } = loadConfig({ COMPOSIO_API_KEY: "ck_" + "b".repeat(20) });
    expect(warnings).toContainEqual(expect.stringMatching(/^COMPOSIO_API_KEY looks like a Composio Connect consumer key \(ck_/));
  });
});

describe("local MCP servers", () => {
  const servers = { pantry: { command: "node", args: ["pantry.js"], env: { PANTRY: "corner" } } };

  test("are the Operator's list, self-hosted only, in Claude Desktop's mcpServers form or as a plain map", () => {
    expect(loadConfig({}).config.localMcpServers).toEqual({});
    const expected = { pantry: { command: "node", args: ["pantry.js"], env: { PANTRY: "corner" } } };
    expect(loadConfig({ MCP_LOCAL_SERVERS: JSON.stringify(servers) }).config.localMcpServers).toEqual(expected);
    expect(loadConfig({ MCP_LOCAL_SERVERS: JSON.stringify({ mcpServers: { pantry: { command: "node" } } }) }).config.localMcpServers).toEqual({
      pantry: { command: "node", args: [], env: {} },
    });
  });

  test("the hosted service never runs a program it is given, and a list that isn't one is refused", () => {
    expect(configProblems({ ...hostedEnv, MCP_LOCAL_SERVERS: JSON.stringify(servers) })).toEqual([
      expect.stringMatching(/^MCP_LOCAL_SERVERS is for self-hosted installs only/),
    ]);
    expect(configProblems({ MCP_LOCAL_SERVERS: "{not json" })).toEqual([expect.stringMatching(/^MCP_LOCAL_SERVERS must be JSON/)]);
    expect(configProblems({ MCP_LOCAL_SERVERS: JSON.stringify({ "bad name!": { command: "node" } }) })).toEqual([
      expect.stringMatching(/^MCP_LOCAL_SERVERS: "bad name!" isn't a name/),
    ]);
    expect(configProblems({ MCP_LOCAL_SERVERS: JSON.stringify({ pantry: { args: ["x"] } }) })).toEqual([
      expect.stringMatching(/^MCP_LOCAL_SERVERS: pantry needs a command/),
    ]);
  });
});
