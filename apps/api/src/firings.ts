import type { AppDeps } from "./app.ts";
import { addMessage, startReplying, stopReplying, webConversation } from "./conversations.ts";
import { describeModel } from "./models/catalog.ts";
import { runReply } from "./replies.ts";
import { nextFiring, type ScheduleRule } from "./schedules.ts";

interface FiringBot {
  id: string;
  name: string;
  instructions: string;
  model: string;
}

interface DueSchedule {
  id: string;
  task: string;
  rule: ScheduleRule;
  timeZone: string;
  bot: FiringBot;
}

/** A firing whose Task stopped with its server: its message has no reply, and nobody renews the claim. */
interface CutOffFiring {
  messageId: string;
  conversationId: string;
  timeZone: string;
  nextRunAt: Date | null;
  bot: FiringBot;
}

/**
 * Runs the schedules that are due, each as one Task in its Bot's web Conversation, side by side,
 * so one long Task doesn't make the others late. A schedule missed while the Bot service was
 * down runs once, now. One whose Bot is still replying is left for a later sweep, and doesn't
 * take the place of anyone else's. A firing a restart cut off is answered again, once. The Bot
 * service calls this every FIRING_SWEEP_MS, or an outside scheduler does (POST /api/sweep).
 */
export async function fireDueSchedules(deps: AppDeps): Promise<void> {
  const [due, cutOff] = await Promise.all([dueSchedules(deps), cutOffFirings(deps)]);
  // One that fails doesn't stop the others.
  await Promise.all([
    ...due.map((schedule) => fire(deps, schedule).catch(logged(`Schedule ${schedule.id}: the firing failed`))),
    ...cutOff.map((firing) => answerAgain(deps, firing).catch(logged(`Message ${firing.messageId}: answering it again failed`))),
  ]);
}

function logged(what: string) {
  return (error: unknown) => console.error(what, error);
}

async function dueSchedules(deps: AppDeps): Promise<DueSchedule[]> {
  const { rows } = await deps.db.query<DueSchedule>(
    `SELECT s.id, s.task, s.rule, s.time_zone AS "timeZone", ${FIRING_BOT} AS bot
     FROM schedules s JOIN bots b ON b.id = s.bot_id
     WHERE s.enabled AND s.next_run_at <= $1
       AND NOT EXISTS (
         SELECT 1 FROM conversations c
         WHERE c.bot_id = s.bot_id AND c.channel = 'web' AND c.replying_since > $1::timestamptz - interval '5 minutes'
       )
     ORDER BY s.next_run_at LIMIT 20`,
    [deps.now()],
  );
  return rows;
}

/**
 * The last day's firings whose Task stopped with its server: the firing's message is still its
 * Conversation's latest, and the claim on the Conversation has lapsed (it renews every minute
 * while a Task runs, so one 5 minutes old belongs to a server that stopped).
 */
async function cutOffFirings(deps: AppDeps): Promise<CutOffFiring[]> {
  const { rows } = await deps.db.query<CutOffFiring>(
    `SELECT m.id::text AS "messageId", c.id AS "conversationId", s.time_zone AS "timeZone",
       s.next_run_at AS "nextRunAt", ${FIRING_BOT} AS bot
     FROM schedules s
     JOIN bots b ON b.id = s.bot_id
     JOIN conversations c ON c.bot_id = s.bot_id AND c.channel = 'web'
     JOIN LATERAL (
       SELECT id, role, schedule_id FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1
     ) m ON m.role = 'user' AND m.schedule_id = s.id
     WHERE s.last_run_at > $1::timestamptz - interval '1 day'
       AND (c.replying_since IS NULL OR c.replying_since < $1::timestamptz - interval '5 minutes')
     LIMIT 20`,
    [deps.now()],
  );
  return rows;
}

const FIRING_BOT = "json_build_object('id', b.id, 'name', b.name, 'instructions', b.instructions, 'model', b.model)";

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
    await answerFiring(deps, { bot: due.bot, conversationId, timeZone: due.timeZone, runsAgain: next !== null });
  } catch (error) {
    await stopReplying(deps.db, conversationId);
    throw error;
  }
}

/**
 * Answers a firing a restart cut off, once: if that's cut off too, it says so rather than
 * starting over for ever. The model is told some of the task may be done already.
 */
async function answerAgain(deps: AppDeps, firing: CutOffFiring): Promise<void> {
  const now = deps.now();
  if (!(await startReplying(deps.db, firing.conversationId, now))) return;
  try {
    // Holding the Conversation, check the firing's message is still unanswered.
    const { rows } = await deps.db.query<{ answeredAgain: boolean }>(
      `SELECT answered_again AS "answeredAgain" FROM messages
       WHERE id = $1 AND id = (SELECT max(id) FROM messages WHERE conversation_id = $2)`,
      [firing.messageId, firing.conversationId],
    );
    const runsAgain = firing.nextRunAt !== null;
    if (!rows[0] || rows[0].answeredAgain) {
      if (rows[0]) {
        const again = runsAgain ? " It runs again at its next time." : "";
        await addMessage(deps.db, firing.conversationId, "assistant", `I couldn't finish this scheduled task: Kovobot restarted while I was doing it, twice.${again}`, now);
      }
      await stopReplying(deps.db, firing.conversationId);
      return;
    }
    await deps.db.query("UPDATE messages SET answered_again = true WHERE id = $1", [firing.messageId]);
    await answerFiring(deps, { bot: firing.bot, conversationId: firing.conversationId, timeZone: firing.timeZone, runsAgain, restarted: true });
  } catch (error) {
    await stopReplying(deps.db, firing.conversationId);
    throw error;
  }
}

/**
 * The firing's Task, in a Conversation it has claimed, which it lets go of when done. Nobody is
 * watching: the reply is saved for the Customer to read, and so is why there isn't one.
 */
async function answerFiring(
  deps: AppDeps,
  firing: { bot: FiringBot; conversationId: string; timeZone: string; runsAgain: boolean; restarted?: boolean },
): Promise<void> {
  const { bot, conversationId } = firing;
  const again = firing.runsAgain ? " It runs again at its next time." : "";
  const model = describeModel(bot.model);
  const adapter = model ? deps.models[model.provider] : null;
  if (!model || !adapter) {
    await addMessage(deps.db, conversationId, "assistant", `I couldn't do this: ${model?.name ?? bot.model} isn't available here right now.`, deps.now());
    await stopReplying(deps.db, conversationId);
    return;
  }
  let wrote = false;
  await runReply(
    deps,
    { bot, model, adapter, conversationId, thinking: "normal", webSearch: false, timeZone: firing.timeZone, restarted: firing.restarted },
    async (event, data) => {
      if (event === "delta") wrote = true;
      // Said before the reply lets go of the Conversation, so no sweep takes it for one cut off.
      if (event === "error" && !wrote) {
        const { code, message } = data as { code: string; message: string };
        const why = code === "model_failed" ? "the model didn't answer" : message.replace(/.$/, "");
        await addMessage(deps.db, conversationId, "assistant", `I couldn't do this scheduled task: ${why}.${again}`, deps.now());
      }
    },
  );
}
