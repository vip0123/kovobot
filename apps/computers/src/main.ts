// The Computer service (ADR 0001): pnpm --filter @kovobot/computers dev, or its container.
import { serve } from "@hono/node-server";
import { ConfigError, loadComputerServiceConfig } from "@kovobot/config";
import { createComputerService } from "./app.ts";
import { createDockerBackend } from "./docker.ts";

let config;
try {
  config = loadComputerServiceConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const service = createComputerService({ config, backend: createDockerBackend(config.docker), now: () => new Date() });
const server = serve({ fetch: service.app.fetch, port: config.port }, (info) => {
  console.info(`Kovobot Computer service (${config.backend}) listening on http://localhost:${info.port}`);
});
server.on("upgrade", (request, socket, head) => void service.upgrade(request, socket, head));

function shutDown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutDown);
process.on("SIGINT", shutDown);
