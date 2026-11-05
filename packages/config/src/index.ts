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
}

/** Every problem found in the environment, so an operator can fix them in one go. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const SELF_HOSTED_DEFAULTS = {
  APP_URL: "http://localhost:5173",
  API_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://kovobot:kovobot@localhost:54329/kovobot",
  EMAIL_FROM: "Kovobot <noreply@localhost>",
};

const MIN_SESSION_SECRET_LENGTH = 32;

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

  const origin = (name: "APP_URL" | "API_URL"): string => {
    const given = read(name);
    const raw = required(name);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`${name} must be a URL, not "${raw}".`);
      return raw;
    }
    // A missing hosted URL is already reported as required; don't also complain about the default.
    if (hosted && given && url.protocol !== "https:") problems.push(`${name} must use https when hosted.`);
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
  } else if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters (openssl rand -base64 32).`);
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

  const config: Config = {
    mode,
    billingEnabled: modeFlag("BILLING_ENABLED"),
    planLimitsEnabled: modeFlag("PLAN_LIMITS_ENABLED"),
    analyticsEnabled: hosted,
    appUrl: origin("APP_URL"),
    apiUrl: origin("API_URL"),
    port: port("PORT", 3000),
    databaseUrl: required("DATABASE_URL"),
    sessionSecret,
    email,
    googleSignIn:
      googleClientId && googleClientSecret ? { clientId: googleClientId, clientSecret: googleClientSecret } : null,
    webDistDir: read("WEB_DIST_DIR") ?? null,
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return { config, warnings };
}
