import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { serve } from "@hono/node-server";
import { createDb } from "@kovobot/db";
import { type AppDeps, createApp } from "./app.ts";
import { createComputerServiceClient } from "./computers.ts";
import { configOrExit } from "./config-or-exit.ts";
import { createMailer } from "./mailer.ts";
import { SLEEP_SWEEP_MS, sleepIdleComputers } from "./computer-sleep.ts";
import { liveViewUpgrade } from "./live-view.ts";
import { createModelAdapters } from "./models/adapters.ts";

// Node gives each of a host's addresses 250 ms to connect before abandoning it for the next.
// On a slow link without IPv6 that failed one new connection to a Model provider in five, and
// Model calls aren't retried (ADR 0004). Two seconds lets a slow connection finish.
setDefaultAutoSelectFamilyAttemptTimeout(2_000);

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
// Computers with nothing going on go Asleep, and are Shut down after 30 days Asleep.
if (deps.computers) {
  setInterval(() => void sleepIdleComputers(deps).catch((error: unknown) => console.error(error)), SLEEP_SWEEP_MS).unref();
}

// Cloud Run sends SIGTERM before stopping an instance: finish open requests, then close the pool.
function shutDown() {
  server.close(() => {
    void db.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutDown);
process.on("SIGINT", shutDown);
