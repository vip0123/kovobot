import type { ChatTurn, ModelAdapter, ModelEvent } from "./models/adapter.ts";

/**
 * Our own agent loop (ADR 0004), run on the Model provider's API through its
 * adapter, never a hosted agent API. Bots have no tools yet, so a turn is one
 * model call; tool calls (ticket 17) add steps to the same turn.
 */
export async function* runTurn(
  adapter: ModelAdapter,
  turn: { botName: string; model: string; conversation: ChatTurn[] },
): AsyncGenerator<ModelEvent> {
  yield* adapter.stream({
    model: turn.model,
    instructions: botInstructions(turn.botName),
    conversation: turn.conversation,
  });
}

function botInstructions(botName: string): string {
  return [
    `You are ${botName}, a Bot on Kovobot that works for the Customer who set you up.`,
    "Answer clearly and briefly, and say so when you don't know something.",
  ].join(" ");
}
