import type { ChatMessage, ModelAdapter, ModelEvent } from "./models/adapter.ts";

/**
 * Our own agent loop (ADR 0004), run on the Model provider's API through its
 * adapter, never a hosted agent API. A Task is the work for one incoming
 * message. Bots have no tools yet, so a Task is one model call; tool calls
 * (ticket 17) add steps to the same Task.
 */
export async function* runTask(
  adapter: ModelAdapter,
  task: { botName: string; model: string; conversation: ChatMessage[] },
): AsyncGenerator<ModelEvent> {
  yield* adapter.stream({
    model: task.model,
    instructions: botInstructions(task.botName),
    conversation: task.conversation,
  });
}

function botInstructions(botName: string): string {
  return [
    `You are ${botName}, a Bot on Kovobot that works for the Customer who set you up.`,
    "Answer clearly and briefly, and say so when you don't know something.",
  ].join(" ");
}
