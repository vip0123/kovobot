import { serve } from "@hono/node-server";
import { createDb } from "@kovobot/db";
import { type AppDeps, createApp } from "./app.ts";
import { createComputerServiceClient } from "./computers.ts";
import { configOrExit } from "./config-or-exit.ts";
import { createMailer } from "./mailer.ts";
import { liveViewUpgrade } from "./live-view.ts";
import { createModelAdapters } from "./models/adapters.ts";

const { config, warnings } = configOrExit();
for (const warning of warnings) console.warn(`Warning: ${warning}`);

const db = createDb(config.databaseUrl);
const deps: AppDeps = {
  config,
  db,
  mailer: createMailer(config.email),
  fetch: globalThis.fetch,
  models: createModelAdapters(config),
  computers: config.computerService ? createComputerServiceClient(config.computerService) : null,
  now: () => new Date(),
};
const app = createApp(deps);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(`Kovobot API (${config.mode}) listening on http://localhost:${info.port}`);
});
// A Computer's live view arrives as a WebSocket, which Hono's handlers don't take.
server.on("upgrade", liveViewUpgrade(app, deps));

// Cloud Run sends SIGTERM before stopping an instance: finish open requests, then close the pool.
function shutDown() {
  server.close(() => {
    void db.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutDown);
process.on("SIGINT", shutDown);
