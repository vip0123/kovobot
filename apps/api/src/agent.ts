import type { TaskEvent } from "./driver.ts";
import type { ChatMessage, ConversationItem, FunctionTool, ModelAdapter, ThinkingEffort, ToolCall } from "./models/adapter.ts";
import type { SkillSummary } from "./skills.ts";

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

/** The Bot's way to one of its Skills: it sees each Skill's name and description, and reads one in full here. */
function readSkillTool(names: string[]): FunctionTool {
  return {
    name: "read_skill",
    description:
      "Reads one of your Skills in full: the Customer's instructions for one kind of work. Read it before doing that work, then follow it.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The Skill's name, as your instructions list it.", enum: names } },
      required: ["name"],
    },
  };
}

export interface TaskTools {
  /** Present when the Bot can drive its Computer: carries out a task there and returns the Driver model's report. */
  useComputer?: (task: string) => AsyncGenerator<TaskEvent, string>;
  /** Present when the Bot has Skills: what it sees of each, and a way to read one's instructions. */
  skills?: { list: SkillSummary[]; read: (name: string) => Promise<string | null> };
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
  const skills = task.tools?.skills?.list ?? [];
  const offered = [
    ...(task.tools?.useComputer ? [USE_COMPUTER] : []),
    ...(skills.length > 0 ? [readSkillTool(skills.map((skill) => skill.name))] : []),
  ];
  const tools = offered.length > 0 ? offered : undefined;
  const conversation: ConversationItem[] = [...task.conversation];
  for (let step = 0; step < MAX_TASK_STEPS; step += 1) {
    const calls: ToolCall[] = [];
    let turn: unknown = null;
    let paused = false;
    for await (const event of adapter.stream({
      model: task.model,
      instructions: botInstructions(task, task.tools?.useComputer !== undefined, skills),
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

/** Runs one tool call. */
async function* runTool(call: ToolCall, task: { botName: string; tools?: TaskTools }): AsyncGenerator<TaskEvent, string> {
  const { useComputer, skills } = task.tools ?? {};
  if (call.name === USE_COMPUTER.name && useComputer) return yield* driveComputer(call, task.botName, useComputer);
  if (call.name === "read_skill" && skills) return yield* readSkill(call, task.botName, skills);
  return `There is no tool called ${call.name}.`;
}

/** One of the Bot's Skills in full, by the name it asked for. */
async function* readSkill(call: ToolCall, botName: string, skills: NonNullable<TaskTools["skills"]>): AsyncGenerator<TaskEvent, string> {
  const asked = typeof call.input.name === "string" ? call.input.name.trim() : "";
  const skill = skills.list.find((candidate) => candidate.name.toLowerCase() === asked.toLowerCase());
  if (!skill) return `You have no Skill called ${asked || "that"}. Your Skills: ${skills.list.map(({ name }) => name).join(", ")}.`;
  yield { type: "status", text: `${botName} is reading its Skill: ${skill.name}.` };
  return (await skills.read(skill.name)) ?? `The Customer has just taken the Skill ${skill.name} away.`;
}

/** A task on the Computer; what the Driver model says along the way stays out of the reply. */
async function* driveComputer(
  call: ToolCall,
  botName: string,
  useComputer: NonNullable<TaskTools["useComputer"]>,
): AsyncGenerator<TaskEvent, string> {
  const what = typeof call.input.task === "string" ? call.input.task.trim() : "";
  if (!what) return "Say what to do on the Computer.";
  yield { type: "status", text: `${botName} is using its Computer.` };
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

/** Ours first, then the Bot's Skills, then the Customer's own instructions, which win where they differ. */
function botInstructions(task: { botName: string; instructions?: string }, hasComputer: boolean, skills: SkillSummary[]): string {
  const sections = [
    [
      `You are ${task.botName}, a Bot on Kovobot that works for the Customer who set you up.`,
      "Answer clearly and briefly, and say so when you don't know something.",
      ...(hasComputer
        ? ["You have a Computer, a Linux desktop with Firefox: use use_computer for anything that needs a browser or desktop apps."]
        : []),
    ].join(" "),
  ];
  if (skills.length > 0) {
    sections.push(
      [
        "Your Skills are the Customer's instructions for particular kinds of work. When one fits what you're asked, read it with read_skill before you start, then follow it.",
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join("\n"),
    );
  }
  const theirs = task.instructions?.trim();
  if (theirs) sections.push(`The Customer gave you these instructions. Follow them, and where they differ from the above, they win.\n\n${theirs}`);
  return sections.join("\n\n");
}
