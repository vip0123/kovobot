import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { AppDeps } from "./app.ts";
import { sleepIdleComputers } from "./computer-sleep.ts";
import { fireDueSchedules } from "./firings.ts";
import { apiError } from "./http.ts";

/** The Bot service's sweeps, once each: due schedules, then idle Computers when they're on. */
export async function sweep(deps: AppDeps): Promise<void> {
  await Promise.all([fireDueSchedules(deps), sleepIdleComputers(deps)]);
}

/**
 * POST /api/sweep, an outside scheduler's tick (Cloud Scheduler, once a minute), when SWEEP_KEY
 * hands it the Bot service's clock. It answers once the sweep is done, firings' Tasks and all:
 * on Cloud Run an instance has CPU only while a request is open. Ticks that overlap are safe,
 * since each firing claims its Conversation first.
 */
export function sweepRoutes(deps: AppDeps) {
  const routes = new Hono();
  routes.post("/sweep", async (c) => {
    const key = deps.config.sweepKey;
    if (!key) return apiError(c, 404, "not_found", "There is no such API route.");
    if (!sameKey(c.req.header("x-sweep-key") ?? "", key)) {
      return apiError(c, 401, "wrong_sweep_key", "That isn't this Kovobot's sweep key.");
    }
    await sweep(deps);
    return c.body(null, 204);
  });
  return routes;
}

/** Compares in constant time, whatever the lengths. */
function sameKey(given: string, key: string): boolean {
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(key).digest());
}
