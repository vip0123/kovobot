// Brings the database up to date: pnpm db:migrate locally, or the migration
// job before each deploy. It reads the same settings as the server.
import { createDb, migrate } from "@kovobot/db";
import { configOrExit } from "./config-or-exit.ts";

const { config } = configOrExit();
const db = createDb(config.databaseUrl);
try {
  const applied = await migrate(db);
  console.info(applied.length > 0 ? `Applied ${applied.join(", ")}.` : "The database is up to date.");
} finally {
  await db.end();
}
