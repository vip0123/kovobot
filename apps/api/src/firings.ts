import type { AppDeps } from "./app.ts";
import { addMessage, startReplying, stopReplying, webConversation } from "./conversations.ts";
import { describeModel } from "./models/catalog.ts";
import { runReply } from "./replies.ts";
import { nextFiring, type ScheduleRule } from "./schedules.ts";

interface DueSchedule {
  id: string;
  task: string;
  rule: ScheduleRule;
  timeZone: string;
  bot: { id: string; name: string; instructions: string; model: string };
}

/**
 * Runs the schedules that are due, each as one Task in its Bot's web Conversation, side by side,
 * so one long Task doesn't make the others late. A schedule missed while the Bot service was
 * down runs once, now. One whose Bot is still replying is left for a later sweep, and doesn't
 * take the place of anyone else's. The Bot service calls this every FIRING_SWEEP_MS.
 */
export async function fireDueSchedules(deps: AppDeps): Promise<void> {
  const { rows } = await deps.db.query<DueSchedule>(
    `SELECT s.id, s.task, s.rule, s.time_zone AS "timeZone",
       json_build_object('id', b.id, 'name', b.name, 'instructions', b.instructions, 'model', b.model) AS bot
     FROM schedules s JOIN bots b ON b.id = s.bot_id
     WHERE s.enabled AND s.next_run_at <= $1
       AND NOT EXISTS (
         SELECT 1 FROM conversations c
         WHERE c.bot_id = s.bot_id AND c.channel = 'web' AND c.replying_since > $1::timestamptz - interval '5 minutes'
       )
     ORDER BY s.next_run_at LIMIT 20`,
    [deps.now()],
  );
  await Promise.all(
    rows.map((due) =>
      fire(deps, due).catch((error: unknown) => {
        // One schedule that fails doesn't stop the others.
        console.error(`Schedule ${due.id}: the firing failed`, error);
      }),
    ),
  );
}

async function fire(deps: AppDeps, due: DueSchedule): Promise<void> {
  const now = deps.now();
  const conversationId = await webConversation(deps.db, due.bot.id, now);
  if (!(await startReplying(deps.db, conversationId, now))) return;
  try {
    // Moves the schedule on before it runs, so it runs once even if the Task fails, and only
    // here: another server that also found it due finds it moved on.
    const next = nextFiring(due.rule, due.timeZone, now);
    const { rowCount } = await deps.db.query(
      `UPDATE schedules SET next_run_at = $2, enabled = $3, last_run_at = $4
       WHERE id = $1 AND enabled AND next_run_at <= $4`,
      [due.id, next, next !== null, now],
    );
    if (rowCount !== 1) {
      await stopReplying(deps.db, conversationId);
      return;
    }
    await addMessage(deps.db, conversationId, "user", due.task, now, { scheduleId: due.id });
    const model = describeModel(due.bot.model);
    const adapter = model ? deps.models[model.provider] : null;
    if (!model || !adapter) {
      const name = model?.name ?? due.bot.model;
      await addMessage(deps.db, conversationId, "assistant", `I couldn't do this: ${name} isn't available here right now.`, now);
      await stopReplying(deps.db, conversationId);
      return;
    }
    // Nobody is watching: the reply is saved in the Conversation for the Customer to read. A
    // firing that fails before the model writes anything says so there too.
    let wrote = false;
    let failure: { code: string; message: string } | null = null;
    await runReply(
      deps,
      { bot: due.bot, model, adapter, conversationId, thinking: "normal", webSearch: false, timeZone: due.timeZone },
      async (event, data) => {
        if (event === "delta") wrote = true;
        if (event === "error") failure = data as { code: string; message: string };
      },
    );
    if (failure && !wrote) {
      const { code, message } = failure as { code: string; message: string };
      const why = code === "model_failed" ? "the model didn't answer" : message.replace(/.$/, "");
      const again = next ? " It runs again at its next time." : "";
      await addMessage(deps.db, conversationId, "assistant", `I couldn't do this scheduled task: ${why}.${again}`, deps.now());
    }
  } catch (error) {
    await stopReplying(deps.db, conversationId);
    throw error;
  }
}
