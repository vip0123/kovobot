import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Config } from "@kovobot/config";
import type { Db } from "@kovobot/db";
import { authRoutes } from "./auth/routes.ts";
import { botRoutes } from "./bots.ts";
import type { Composio } from "./composio.ts";
import type { ComputerService } from "./computers.ts";
import { apiError, sameOriginWrites } from "./http.ts";
import { leadRoutes } from "./leads.ts";
import type { Mailer } from "./mailer.ts";
import type { ImageMaker } from "./media/images.ts";
import type { ModelAdapters } from "./models/adapter.ts";
import { sweepRoutes } from "./sweeps.ts";

/** Everything the API talks to outside its own code. Tests swap the edges. */
export interface AppDeps {
  config: Config;
  db: Db;
  mailer: Mailer;
  /** Outgoing HTTP, such as Google's token endpoint. */
  fetch: typeof fetch;
  /** One adapter per Model provider; null where no key is set. */
  models: ModelAdapters;
  /** The Computer service; null leaves Computers off. */
  computers: ComputerService | null;
  /** Composio, for Connected apps; null leaves them off. */
  composio: Composio | null;
  /** The image model Bots make pictures with; null where no Model provider with one is set up. */
  images: ImageMaker | null;
  now: () => Date;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.get("/api/healthz", (c) => c.text("ok"));
  // Leads come from the landing page's own origin, so they come before the same-origin check.
  app.route("/api", leadRoutes(deps));
  // So does an outside scheduler's tick, which comes from no website at all.
  app.route("/api", sweepRoutes(deps));
  app.use("/api/*", sameOriginWrites(deps.config.appUrl));
  app.route("/api", authRoutes(deps));
  app.route("/api", botRoutes(deps));
  app.all("/api/*", (c) => apiError(c, 404, "not_found", "There is no such API route."));
  if (deps.config.webDistDir) serveWebApp(app, deps.config.webDistDir);
  return app;
}

/**
 * Serves the web app's build. Hashed files under assets/ never change, so they
 * are cached for a year, and a missing one is a plain 404. Every other path is
 * a top-level file or a page the web app routes itself, which gets index.html;
 * both are re-checked on each visit.
 */
function serveWebApp(app: Hono, root: string) {
  const cacheControl = (value: string) => createMiddleware(async (c, next) => {
    c.header("Cache-Control", value);
    await next();
  });

  app.use("/assets/*", cacheControl("public, max-age=31536000, immutable"), serveStatic({ root }));
  app.get("/assets/*", (c) => {
    c.header("Cache-Control", "no-store");
    return c.text("Not found", 404);
  });
  app.use("*", cacheControl("no-cache"), serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}
