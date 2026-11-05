import { ConfigError, loadConfig } from "@kovobot/config";
import { createDb } from "@kovobot/db";
import type { AppDeps } from "../app.ts";
import { createMailer } from "../mailer.ts";

/**
 * Runs a command with the server's own settings, database and mailer, then
 * closes the database. Commands run with the same environment as the server.
 */
export async function runCommand(work: (deps: Pick<AppDeps, "config" | "db" | "mailer" | "now">) => Promise<void>) {
  let config;
  try {
    ({ config } = loadConfig(process.env));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
  const db = createDb(config.databaseUrl);
  try {
    await work({ config, db, mailer: createMailer(config.email), now: () => new Date() });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
