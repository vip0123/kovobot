import type { Config } from "@kovobot/config";
import type { ModelAdapters } from "./adapter.ts";
import { createAnthropicAdapter } from "./anthropic.ts";
import { createGoogleAdapter } from "./google.ts";
import { createOpenAIAdapter } from "./openai.ts";
import { createOpenAICompatibleAdapter } from "./openai-compatible.ts";

/** One adapter for each Model provider whose key is set; null for the rest. */
export function createModelAdapters({
  modelKeys,
  localModelsUrl,
  anthropicWorkspaceId,
}: Pick<Config, "modelKeys" | "localModelsUrl" | "anthropicWorkspaceId">): ModelAdapters {
  const { openai, anthropic, google, xai, openrouter } = modelKeys;
  return {
    openai: openai ? createOpenAIAdapter({ apiKey: openai }) : null,
    anthropic: anthropic ? createAnthropicAdapter({ apiKey: anthropic, workspaceId: anthropicWorkspaceId }) : null,
    google: google ? createGoogleAdapter({ apiKey: google }) : null,
    // xAI documents the OpenAI SDK against its own Responses API.
    xai: xai ? createOpenAIAdapter({ apiKey: xai, baseURL: "https://api.x.ai/v1" }) : null,
    openrouter: openrouter
      ? createOpenAICompatibleAdapter({ apiKey: openrouter, baseURL: "https://openrouter.ai/api/v1" })
      : null,
    local: localModelsUrl ? createOpenAICompatibleAdapter({ apiKey: "local", baseURL: localModelsUrl }) : null,
  };
}
