import { serve } from "@hono/node-server";
import { ConfigError, loadConfig } from "@kovobot/config";
import { createDb } from "@kovobot/db";
import { createApp } from "./app.ts";
import { createMailer } from "./mailer.ts";

function configOrExit() {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

const { config, warnings } = configOrExit();
for (const warning of warnings) console.warn(`Warning: ${warning}`);

const db = createDb(config.databaseUrl);
const app = createApp({
  config,
  db,
  mailer: createMailer(config.email),
  fetch: globalThis.fetch,
  now: () => new Date(),
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(`Kovobot API (${config.mode}) listening on http://localhost:${info.port}`);
});

// Cloud Run sends SIGTERM before stopping an instance: finish open requests, then close the pool.
function shutDown() {
  server.close(() => {
    void db.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutDown);
process.on("SIGINT", shutDown);
