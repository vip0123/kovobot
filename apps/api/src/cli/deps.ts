import { createDb } from "@kovobot/db";
import type { AppDeps } from "../app.ts";
import { configOrExit } from "../config-or-exit.ts";
import { createMailer } from "../mailer.ts";

/**
 * Runs a command with the server's own settings, database and mailer, then
 * closes the database. Commands run with the same environment as the server.
 */
export async function runCommand(work: (deps: Pick<AppDeps, "config" | "db" | "mailer" | "now">) => Promise<void>) {
  const { config } = configOrExit();
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
