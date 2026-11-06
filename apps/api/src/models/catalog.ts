import type { ModelAdapters, ModelProvider } from "./adapter.ts";

export interface ModelInfo {
  /** How Kovobot names the model; OpenRouter and local models carry a route prefix. */
  id: string;
  name: string;
  provider: ModelProvider;
}

/** The models a Bot can use, besides any OpenRouter model and, self-hosted, local ones. */
export const MODELS: readonly ModelInfo[] = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai" },
  { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic" },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", provider: "google" },
  { id: "grok-4.7", name: "Grok 4.7", provider: "xai" },
];

// "openrouter:<vendor>/<model>", as OpenRouter lists it, and "local:<model>", as the local server names it.
const OPENROUTER_ID = /^openrouter:[a-z0-9][\w.-]*\/[\w.:-]+$/i;
const LOCAL_ID = /^local:[\w.:/-]{1,100}$/;

/**
 * The model a Bot may be set to, or undefined. Any OpenRouter model is
 * allowed by its OpenRouter name; local models only where a local model
 * server is set up, which is never in the hosted service.
 */
export function findModel(id: unknown, adapters: ModelAdapters): ModelInfo | undefined {
  if (typeof id !== "string") return undefined;
  if (OPENROUTER_ID.test(id)) return { id, name: id.slice("openrouter:".length), provider: "openrouter" };
  if (LOCAL_ID.test(id)) return adapters.local ? { id, name: `${id.slice("local:".length)} (local)`, provider: "local" } : undefined;
  return MODELS.find((model) => model.id === id);
}
