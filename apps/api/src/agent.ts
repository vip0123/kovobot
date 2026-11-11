import type { TaskEvent } from "./driver.ts";
import type { ChatMessage, ConversationItem, FunctionTool, ModelAdapter, ThinkingEffort, ToolCall } from "./models/adapter.ts";

/** The most model calls one Task makes before it stops. */
const MAX_TASK_STEPS = 10;

/** The Bot's way to its Computer: the task goes to its Driver model, which reports back. */
export const USE_COMPUTER: FunctionTool = {
  name: "use_computer",
  description:
    "Does a task on your Computer, a Linux desktop with Firefox: browsing websites, reading pages, filling in forms, using desktop apps. " +
    "Describe the whole task in plain words; you get back what was done and found.",
  parameters: {
    type: "object",
    properties: { task: { type: "string", description: "What to do on the Computer, in plain words." } },
    required: ["task"],
  },
};

export interface TaskTools {
  /** Present when the Bot can drive its Computer: carries out a task there and returns the Driver model's report. */
  useComputer?: (task: string) => AsyncGenerator<TaskEvent, string>;
}

/**
 * Our own agent loop (ADR 0004), run on the Model provider's API through its
 * adapter, never a hosted agent API. A Task is the work for one incoming
 * message: the model answers, and whenever it calls a tool the result goes back
 * to it, until it answers without one.
 */
export async function* runTask(
  adapter: ModelAdapter,
  task: {
    botName: string;
    /** What the Customer told the Bot about how to work for them; empty for none. */
    instructions?: string;
    model: string;
    conversation: ChatMessage[];
    tools?: TaskTools;
    /** How hard the model thinks; what it thinks streams as "thinking" events. */
    thinking?: ThinkingEffort;
    /** Whether the model may search the web; its sources come back as a "sources" event. */
    webSearch?: boolean;
  },
): AsyncGenerator<TaskEvent> {
  const tools = task.tools?.useComputer ? [USE_COMPUTER] : undefined;
  const conversation: ConversationItem[] = [...task.conversation];
  for (let step = 0; step < MAX_TASK_STEPS; step += 1) {
    const calls: ToolCall[] = [];
    let turn: unknown = null;
    let paused = false;
    for await (const event of adapter.stream({
      model: task.model,
      instructions: botInstructions(task, tools !== undefined),
      conversation,
      tools,
      thinking: task.thinking,
      webSearch: task.webSearch,
    })) {
      if (event.type === "tool_call") calls.push(event.call);
      if (event.type === "done") {
        turn = event.turn;
        paused = event.paused === true;
      }
      yield event;
    }
    // A paused answer goes back as it is, and the model carries on from it.
    if (paused && calls.length === 0) {
      conversation.push({ role: "turn", raw: turn });
      continue;
    }
    if (calls.length === 0) return;
    conversation.push({ role: "turn", raw: turn });
    const results: Array<{ toolCallId: string; name: string; output: string }> = [];
    for (const call of calls) results.push({ toolCallId: call.id, name: call.name, output: yield* runTool(call, task) });
    conversation.push({ role: "tool_results", results });
  }
  yield { type: "text", text: "I stopped there: that took more steps than one message allows." };
}

/** Runs one tool call; what the Driver model says along the way stays out of the reply. */
async function* runTool(call: ToolCall, task: { botName: string; tools?: TaskTools }): AsyncGenerator<TaskEvent, string> {
  const useComputer = task.tools?.useComputer;
  if (call.name !== USE_COMPUTER.name || !useComputer) return `There is no tool called ${call.name}.`;
  const what = typeof call.input.task === "string" ? call.input.task.trim() : "";
  if (!what) return "Say what to do on the Computer.";
  yield { type: "status", text: `${task.botName} is using its Computer.` };
  try {
    const driving = useComputer(what);
    for (let next = await driving.next(); ; next = await driving.next()) {
      if (next.done) return next.value;
      // Status for the Customer, usage for metering; the Driver model's own words aren't the reply.
      if (next.value.type === "status" || next.value.type === "done") yield next.value;
    }
  } catch (error) {
    return `The Computer couldn't finish that: ${(error as Error).message}`;
  }
}

/** Ours first, then the Customer's own, which win where the two differ. */
function botInstructions(task: { botName: string; instructions?: string }, hasComputer: boolean): string {
  const ours = [
    `You are ${task.botName}, a Bot on Kovobot that works for the Customer who set you up.`,
    "Answer clearly and briefly, and say so when you don't know something.",
    ...(hasComputer
      ? ["You have a Computer, a Linux desktop with Firefox: use use_computer for anything that needs a browser or desktop apps."]
      : []),
  ].join(" ");
  const theirs = task.instructions?.trim();
  if (!theirs) return ours;
  return `${ours}\n\nThe Customer gave you these instructions. Follow them, and where they differ from the above, they win.\n\n${theirs}`;
}
