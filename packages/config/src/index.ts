import { randomBytes } from "node:crypto";

export type DeploymentMode = "hosted" | "self-hosted";

export type Env = Readonly<Record<string, string | undefined>>;

/** How sign-in links reach people: by SMTP, or written to the server log (self-hosted only). */
export type EmailSettings =
  | { kind: "smtp"; host: string; port: number; user: string | undefined; password: string | undefined; from: string }
  | { kind: "log"; from: string };

export interface GoogleSignInSettings {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  mode: DeploymentMode;
  billingEnabled: boolean;
  planLimitsEnabled: boolean;
  analyticsEnabled: boolean;
  /** Origin of the web app, e.g. https://app.kovobot.com. */
  appUrl: string;
  /** Origin of the API; webhooks and OAuth callbacks are built from it. */
  apiUrl: string;
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  email: EmailSettings;
  /** Null when Sign in with Google is off. */
  googleSignIn: GoogleSignInSettings | null;
  /** The web app's production build, served by the API so both share one origin. Null in development. */
  webDistDir: string | null;
  /**
   * Whether new Customers can sign up. Hosted, it stays closed until launch:
   * the landing page collects leads, and existing Customers can still sign in.
   */
  signUpOpen: boolean;
  /** Origin of the landing page, allowed to post leads to the API. Null when there is none. */
  landingUrl: string | null;
  /** Our key for each Model provider (the Operator's, when self-hosted). Null leaves its models unavailable. */
  modelKeys: ModelKeys;
  /** A local OpenAI-compatible model server (Ollama, vLLM). Self-hosted only; always null when hosted. */
  localModelsUrl: string | null;
  /** The Anthropic workspace to call in, for an Anthropic key that isn't scoped to one. Null for one that is. */
  anthropicWorkspaceId: string | null;
  /** Where the Bot service calls the Computer service. Null leaves Computers off. */
  computerService: ComputerServiceSettings | null;
}

/** How the Bot service reaches the Computer service, its only client (ADR 0001). */
export interface ComputerServiceSettings {
  /** Origin of the Computer service, as the Bot service reaches it. */
  url: string;
  /** The shared secret the Bot service presents on every call. */
  apiKey: string;
}

export interface ModelKeys {
  openai: string | null;
  anthropic: string | null;
  google: string | null;
  xai: string | null;
  openrouter: string | null;
}

/** Every problem found in the environment, so they can all be fixed in one go. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Where the Computer service listens unless COMPUTER_SERVICE_URL says otherwise. */
export const COMPUTER_SERVICE_DEFAULT_URL = "http://localhost:3100";

const SELF_HOSTED_DEFAULTS = {
  DATABASE_URL: "postgres://kovobot:kovobot@localhost:54329/kovobot",
  EMAIL_FROM: "Kovobot <noreply@localhost>",
};

/** The shortest secret accepted for signing or sharing: openssl rand -base64 32 gives 44 characters. */
const MIN_SECRET_LENGTH = 32;

/**
 * Reads the environment into settings. A hosted install must set every secret
 * explicitly; a self-hosted install starts from an empty environment.
 * Throws ConfigError listing every problem.
 */
export function loadConfig(env: Env): { config: Config; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const read = (name: string): string | undefined => env[name]?.trim() || undefined;

  const rawMode = read("KOVOBOT_MODE") ?? "self-hosted";
  if (rawMode !== "hosted" && rawMode !== "self-hosted") {
    problems.push(`KOVOBOT_MODE must be "hosted" or "self-hosted", not "${rawMode}".`);
  }
  const mode: DeploymentMode = rawMode === "hosted" ? "hosted" : "self-hosted";
  const hosted = mode === "hosted";

  // A setting a hosted install must set itself; self-hosted falls back to a local default.
  const required = (name: keyof typeof SELF_HOSTED_DEFAULTS): string => {
    const value = read(name);
    if (value) return value;
    if (hosted) problems.push(`${name} is required when hosted.`);
    return SELF_HOSTED_DEFAULTS[name];
  };

  const origin = (name: "APP_URL" | "API_URL", selfHostedDefault: string): string => {
    const raw = read(name);
    if (!raw) {
      if (hosted) problems.push(`${name} is required when hosted.`);
      return selfHostedDefault;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`${name} must be a URL, not "${raw}".`);
      return raw;
    }
    if (hosted && url.protocol !== "https:") problems.push(`${name} must use https when hosted.`);
    return url.origin;
  };

  // KOVOBOT_MODE sets these together. A hosted install may switch them off
  // (e.g. staging); a self-hosted install never charges, so it can't switch them on.
  const modeFlag = (name: string): boolean => {
    const raw = read(name);
    if (!raw) return hosted;
    if (raw === "false") return false;
    if (raw !== "true") {
      problems.push(`${name} must be "true" or "false".`);
      return false;
    }
    if (!hosted) {
      problems.push(`${name}=true is not allowed when self-hosted: a self-hosted install never charges.`);
      return false;
    }
    return true;
  };

  const booleanSetting = (name: string, fallback: boolean): boolean => {
    const raw = read(name);
    if (!raw) return fallback;
    if (raw !== "true" && raw !== "false") {
      problems.push(`${name} must be "true" or "false".`);
      return fallback;
    }
    return raw === "true";
  };

  const optionalOrigin = (name: string): string | null => {
    const raw = read(name);
    if (!raw) return null;
    try {
      return new URL(raw).origin;
    } catch {
      problems.push(`${name} must be a URL, not "${raw}".`);
      return null;
    }
  };

  const port = (name: string, fallback: number): number => {
    const raw = read(name);
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
      problems.push(`${name} must be a port number, not "${raw}".`);
      return fallback;
    }
    return value;
  };

  let sessionSecret = read("SESSION_SECRET");
  if (!sessionSecret) {
    if (hosted) problems.push("SESSION_SECRET is required when hosted.");
    else warnings.push("SESSION_SECRET is not set: using a temporary one, so everyone is signed out on restart.");
    sessionSecret = randomBytes(32).toString("base64url");
  } else if (sessionSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -base64 32).`);
  }

  const emailFrom = required("EMAIL_FROM");
  const smtpHost = read("SMTP_HOST");
  let email: EmailSettings;
  if (smtpHost) {
    email = {
      kind: "smtp",
      host: smtpHost,
      port: port("SMTP_PORT", 587),
      user: read("SMTP_USER"),
      password: read("SMTP_PASSWORD"),
      from: emailFrom,
    };
  } else {
    if (hosted) problems.push("SMTP_HOST is required when hosted, so sign-in links can be emailed.");
    else warnings.push("SMTP_HOST is not set: sign-in links are written to the server log instead of emailed.");
    email = { kind: "log", from: emailFrom };
  }

  const googleClientId = read("GOOGLE_OAUTH_CLIENT_ID");
  const googleClientSecret = read("GOOGLE_OAUTH_CLIENT_SECRET");
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    problems.push("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set together.");
  }

  // The session cookie and the same-origin check on writes need the web app and
  // the API on one origin. An API serving the web build is that origin, so
  // APP_URL defaults to API_URL there; only local development (Vite) splits them.
  const listenPort = port("PORT", 3000);
  const webDistDir = read("WEB_DIST_DIR") ?? null;
  const apiUrl = origin("API_URL", `http://localhost:${listenPort}`);
  const appUrl = webDistDir && !read("APP_URL") ? apiUrl : origin("APP_URL", "http://localhost:5173");
  if ((hosted || webDistDir) && read("APP_URL") && appUrl !== apiUrl) {
    problems.push("APP_URL must equal API_URL: the API serves the web app, so both share one origin.");
  }

  const config: Config = {
    mode,
    billingEnabled: modeFlag("BILLING_ENABLED"),
    planLimitsEnabled: modeFlag("PLAN_LIMITS_ENABLED"),
    analyticsEnabled: hosted,
    appUrl,
    apiUrl,
    port: listenPort,
    databaseUrl: required("DATABASE_URL"),
    sessionSecret,
    email,
    googleSignIn:
      googleClientId && googleClientSecret ? { clientId: googleClientId, clientSecret: googleClientSecret } : null,
    webDistDir,
    signUpOpen: booleanSetting("SIGN_UP_OPEN", !hosted),
    landingUrl: optionalOrigin("LANDING_URL"),
    modelKeys: {
      openai: read("OPENAI_API_KEY") ?? null,
      anthropic: read("ANTHROPIC_API_KEY") ?? null,
      google: read("GEMINI_API_KEY") ?? null,
      xai: read("XAI_API_KEY") ?? null,
      openrouter: read("OPENROUTER_API_KEY") ?? null,
    },
    localModelsUrl: null,
    anthropicWorkspaceId: read("ANTHROPIC_WORKSPACE_ID") ?? null,
    computerService: null,
  };
  if (config.anthropicWorkspaceId && !/^wrkspc_\w+$/.test(config.anthropicWorkspaceId)) {
    warnings.push("ANTHROPIC_WORKSPACE_ID doesn't look like a workspace id (wrkspc_...): Anthropic will refuse every call.");
  }
  const localModelsUrl = read("OPENAI_COMPATIBLE_BASE_URL");
  if (localModelsUrl && hosted) {
    problems.push(
      "OPENAI_COMPATIBLE_BASE_URL is for self-hosted installs only: the hosted service never calls a URL it is given.",
    );
  } else if (localModelsUrl) {
    config.localModelsUrl = localModelsUrl.replace(/\/$/, "");
  }
  const computerServiceKey = read("COMPUTER_SERVICE_API_KEY");
  if (computerServiceKey && hosted) {
    problems.push(
      "COMPUTER_SERVICE_API_KEY is for self-hosted installs only: hosted Computers run in the cloud and are billed, which isn't built yet.",
    );
  } else if (computerServiceKey && computerServiceKey.length < MIN_SECRET_LENGTH) {
    problems.push(`COMPUTER_SERVICE_API_KEY must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -base64 32).`);
  } else if (computerServiceKey) {
    const url = optionalOrigin("COMPUTER_SERVICE_URL") ?? COMPUTER_SERVICE_DEFAULT_URL;
    config.computerService = { url, apiKey: computerServiceKey };
  }
  if (Object.values(config.modelKeys).every((key) => key === null) && !config.localModelsUrl) {
    warnings.push(
      "No Model provider key is set (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, XAI_API_KEY or OPENROUTER_API_KEY): Bots can't reply.",
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { config, warnings };
}

export interface ComputerServiceConfig {
  /** The key the Bot service, its only client, presents on every call. */
  apiKey: string;
  port: number;
  /** Signs live-view links; random per start when unset, since each link lasts only a minute. */
  tokenSigningKey: string;
  /** Where Computers run. Docker is the only backend so far, Linux only. */
  backend: "docker";
  /** What each Computer may send out: its bandwidth, and how many new connections it opens a second. */
  outbound: { mbitPerSecond: number; newConnectionsPerSecond: number };
  docker: {
    /** The Docker engine's address, e.g. unix:///var/run/docker.sock. Null uses the local default. */
    host: string | null;
    /** The image each Computer starts from. */
    image: string;
    /**
     * A Docker network the Computer service shares with its Computers, when it runs in a
     * container itself. Null publishes each Computer agent on 127.0.0.1 instead.
     */
    network: string | null;
  };
}

/** Reads the Computer service's environment (ADR 0001). Throws ConfigError listing every problem. */
export function loadComputerServiceConfig(env: Env): ComputerServiceConfig {
  const problems: string[] = [];
  const read = (name: string): string | undefined => env[name]?.trim() || undefined;

  const secret = (name: string, missing: string | null): string | undefined => {
    const value = read(name);
    if (!value) {
      if (missing) problems.push(missing);
    } else if (value.length < MIN_SECRET_LENGTH) {
      problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -base64 32).`);
    }
    return value;
  };
  const apiKey = secret(
    "COMPUTER_SERVICE_API_KEY",
    "COMPUTER_SERVICE_API_KEY is required: the Bot service presents it on every call (openssl rand -base64 32).",
  );
  const tokenSigningKey = secret("COMPUTER_TOKEN_SIGNING_KEY", null) ?? randomBytes(32).toString("base64url");

  let port = 3100;
  const rawUrl = read("COMPUTER_SERVICE_URL") ?? COMPUTER_SERVICE_DEFAULT_URL;
  try {
    const url = new URL(rawUrl);
    port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  } catch {
    problems.push(`COMPUTER_SERVICE_URL must be a URL, not "${rawUrl}".`);
  }

  const wholeNumber = (name: string, fallback: number): number => {
    const raw = read(name);
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 10_000) {
      problems.push(`${name} must be a whole number from 1 to 10000, not "${raw}".`);
      return fallback;
    }
    return value;
  };
  const outbound = {
    mbitPerSecond: wholeNumber("COMPUTER_OUTBOUND_MBIT", 50),
    newConnectionsPerSecond: wholeNumber("COMPUTER_NEW_CONNECTIONS_PER_SECOND", 20),
  };

  const backend = read("COMPUTER_BACKEND") ?? "docker";
  if (backend !== "docker") {
    problems.push(`COMPUTER_BACKEND must be "docker", not "${backend}": other backends aren't built yet.`);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    apiKey: apiKey!,
    port,
    tokenSigningKey,
    backend: "docker",
    outbound,
    docker: {
      host: read("DOCKER_HOST") ?? null,
      image: read("COMPUTER_IMAGE") ?? "kovobot-computer",
      network: read("COMPUTER_DOCKER_NETWORK") ?? null,
    },
  };
}
