import { setTimeout as sleep } from "node:timers/promises";
import type { AppDeps } from "./app.ts";
import type { ComputerService } from "./computers.ts";
import type { ComputerCall, ComputerStepResult, ConversationItem, ModelEvent } from "./models/adapter.ts";
import { describeModel } from "./models/catalog.ts";

/** The Computer's screen, as the Computer image's virtual display has it (apps/computers/image). */
export const SCREEN = { width: 1280, height: 800 };
/** The most turns a Driver model gets for one task before it stops and reports. */
const MAX_DRIVER_TURNS = 50;
/** How often a waiting Bot checks whether the Customer has handed the Computer back. */
const CONTROL_POLL_MS = 250;
/** How long a Bot waits for the Customer to hand back before it stops. */
const MAX_WAIT_MS = 30 * 60_000;

/** What a Task reports beyond the model's own events: what the Bot is doing now. */
export type TaskEvent = ModelEvent | { type: "status"; text: string };

interface Driving {
  botId: string;
  botName: string;
  driverModel: string;
  computerId: string;
}

/** What a Bot needs to drive its Computer, or null when it can't: no Computer, no Driver model, or Computers off. */
export async function drivingFor(deps: AppDeps, botId: string): Promise<Driving | null> {
  if (!deps.computers) return null;
  const { rows } = await deps.db.query<{ botName: string; driverModel: string | null; computerId: string | null }>(
    `SELECT name AS "botName", driver_model AS "driverModel", computer_id AS "computerId" FROM bots WHERE id = $1`,
    [botId],
  );
  const bot = rows[0];
  if (!bot?.driverModel || !bot.computerId) return null;
  const model = describeModel(bot.driverModel);
  if (!model || !deps.models[model.provider]) return null;
  return { botId, botName: bot.botName, driverModel: bot.driverModel, computerId: bot.computerId };
}

/**
 * Has the Bot's Driver model carry out `task` on its Computer, through its Model provider's
 * computer-use tool, and returns what it reports. It waits while the Customer has control,
 * and stops to ask when the Model provider wants the Customer to confirm something.
 */
export async function* driveComputer(deps: AppDeps, driving: Driving, task: string): AsyncGenerator<TaskEvent, string> {
  const computers = deps.computers!;
  const adapter = deps.models[describeModel(driving.driverModel)!.provider]!;
  const computer = await computers.find(driving.computerId);
  if (!computer) return "The Computer is gone. Ask the Customer to create a new one.";
  if (computer.state !== "running") await computers.start(driving.computerId);

  const conversation: ConversationItem[] = [{ role: "user", content: task }];
  for (let turn = 0; turn < MAX_DRIVER_TURNS; turn += 1) {
    await stillActive(deps, driving.botId);
    let text = "";
    let call: ComputerCall | null = null;
    let raw: unknown = null;
    for await (const event of adapter.stream({
      model: driving.driverModel,
      instructions: driverInstructions(driving.botName),
      conversation,
      computer: SCREEN,
    })) {
      if (event.type === "text") text += event.text;
      if (event.type === "computer_call") call = event.call;
      if (event.type === "done") raw = event.turn;
      // Usage and every other event go up, so the Task's metering sees the Driver model's calls too.
      yield event;
    }
    if (!call) return text.trim() || "Done.";
    if (call.safetyChecks.length > 0) {
      const checks = call.safetyChecks.map((check) => check.message).join(" ");
      return `I stopped before going on, because this needs your confirmation: ${checks} Tell me if I should go ahead.`;
    }

    conversation.push({ role: "turn", raw });
    const results: ComputerStepResult[] = [];
    for (const step of call.steps) {
      yield* waitForControl(deps, driving);
      if (step.unsupported) {
        results.push({ id: step.id, name: step.name, error: step.unsupported });
        continue;
      }
      results.push(await carryOut(computers, driving.computerId, step));
    }
    await stillActive(deps, driving.botId);
    conversation.push({ role: "computer_results", results });
  }
  return `I stopped after ${MAX_DRIVER_TURNS} steps on the Computer without finishing.`;
}

/** One step's actions, then the screen if the Model provider wants it. */
async function carryOut(
  computers: ComputerService,
  computerId: string,
  step: ComputerCall["steps"][number],
): Promise<ComputerStepResult> {
  try {
    let text: string | undefined;
    for (const action of step.actions) {
      const answer = await computers.act(computerId, action);
      const cursor = answer.cursor as { x: number; y: number } | undefined;
      if (cursor) text = `The mouse is at ${cursor.x}, ${cursor.y}.`;
    }
    return step.screenshot ? { id: step.id, name: step.name, screenshot: await computers.screenshot(computerId) } : { id: step.id, name: step.name, text: text ?? "OK" };
  } catch (error) {
    const result: ComputerStepResult = { id: step.id, name: step.name, error: `That didn't work: ${(error as Error).message}` };
    // Some Model providers always need to see the screen, even after a failure.
    if (step.screenshot) result.screenshot = await computers.screenshot(computerId).catch(() => undefined);
    return result;
  }
}

/** Waits, saying so once, while the Customer has the mouse and keyboard. */
async function* waitForControl(deps: AppDeps, driving: Driving): AsyncGenerator<TaskEvent> {
  const started = Date.now();
  let said = false;
  while (await customerInControl(deps, driving.botId)) {
    if (!said) {
      yield { type: "status", text: `${driving.botName} is waiting while you have control of its Computer.` };
      said = true;
    }
    if (Date.now() - started > MAX_WAIT_MS) throw new Error("The Customer kept control of the Computer for too long.");
    await sleep(CONTROL_POLL_MS);
  }
  if (said) yield { type: "status", text: `${driving.botName} is using its Computer again.` };
}

async function customerInControl(deps: AppDeps, botId: string): Promise<boolean> {
  const { rows } = await deps.db.query<{ controlled: boolean }>(
    `SELECT computer_controlled_at IS NOT NULL AS controlled FROM bots WHERE id = $1`,
    [botId],
  );
  return rows[0]?.controlled ?? false;
}

/** The Bot at work keeps its Computer awake, as a viewer does. */
async function stillActive(deps: AppDeps, botId: string): Promise<void> {
  await deps.db.query("UPDATE bots SET computer_active_at = $2, computer_asleep_at = NULL WHERE id = $1", [botId, deps.now()]);
}

function driverInstructions(botName: string): string {
  return [
    `You are operating the Computer of ${botName}, a Bot on Kovobot, for the Customer who set it up.`,
    `The Computer is a Linux desktop (Xfce) with Firefox, ${SCREEN.width}x${SCREEN.height} pixels.`,
    "Do the task you are given, then reply briefly with what you did and what you found.",
    "Stop and ask before paying, sending messages, emails or posts, or deleting anything:",
    "describe what you were about to do and end your turn instead of doing it.",
    "The Customer can take over the mouse and keyboard at any time; if the screen changed, look again before acting.",
  ].join(" ");
}
