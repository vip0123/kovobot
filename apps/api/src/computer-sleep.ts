import type { AppDeps } from "./app.ts";

/** A Computer Asleep this long is Shut down: its disk is kept, its memory dropped. */
export const ASLEEP_DAYS_BEFORE_SHUT_DOWN = 30;
/** How often the Bot service looks for Computers with nothing going on. */
export const SLEEP_SWEEP_MS = 60_000;

interface IdleComputer {
  botId: string;
  computerId: string;
  /** Null until it has been Asleep: then it's due a Shut down, not a sleep. */
  asleepAt: Date | null;
}

/**
 * Puts each Computer that has had no viewer or Bot at work for its Bot's chosen time
 * Asleep, and Shuts down each one Asleep for 30 days. The Bot service decides, because
 * it is the one that sees the activity; the Computer service does as it's told.
 */
export async function sleepIdleComputers(deps: AppDeps): Promise<void> {
  if (!deps.computers) return;
  const now = deps.now();
  const { rows } = await deps.db.query<IdleComputer>(
    `SELECT id AS "botId", computer_id AS "computerId", computer_asleep_at AS "asleepAt"
     FROM bots
     WHERE computer_id IS NOT NULL AND (
       (computer_asleep_at IS NULL
         AND (computer_active_at IS NULL OR computer_active_at <= $1::timestamptz - make_interval(mins => computer_sleep_after_minutes)))
       OR computer_asleep_at <= $1::timestamptz - make_interval(days => $2)
     )`,
    [now, ASLEEP_DAYS_BEFORE_SHUT_DOWN],
  );
  for (const idle of rows) {
    try {
      if (idle.asleepAt) {
        await deps.computers.shutDown(idle.computerId);
        await deps.db.query("UPDATE bots SET computer_asleep_at = NULL WHERE id = $1", [idle.botId]);
        continue;
      }
      const computer = await deps.computers.find(idle.computerId);
      if (computer?.state !== "running") continue;
      await deps.computers.sleep(idle.computerId);
      await deps.db.query("UPDATE bots SET computer_asleep_at = $2 WHERE id = $1", [idle.botId, now]);
    } catch (error) {
      // One Computer the Computer service can't reach doesn't stop the others.
      console.error(error);
    }
  }
}
