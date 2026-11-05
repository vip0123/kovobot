import type { ModelProvider } from "./adapter.ts";

export interface ModelInfo {
  id: string;
  name: string;
  provider: ModelProvider;
}

/** The models a Bot can use. More providers join as their adapters land (tickets 04 and 05). */
export const MODELS: readonly ModelInfo[] = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai" },
  { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai" },
];

export function findModel(id: unknown): ModelInfo | undefined {
  return MODELS.find((model) => model.id === id);
}
