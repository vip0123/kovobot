import type { ModelCatalog } from "./api.ts";

const MODEL_PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
};

const OPENROUTER = "openrouter:";
const LOCAL = "local:";

/** The first model a new Bot can use here, or "" when none can. */
export function firstAvailableModel(catalog: ModelCatalog): string {
  return catalog.models.find((model) => model.available)?.id ?? (catalog.openrouter ? OPENROUTER : "");
}

/** Every model a Bot can use here, grouped by Model provider, plus any OpenRouter or local model by name. */
export function ModelPicker({
  id,
  catalog,
  value,
  onChange,
}: {
  id: string;
  catalog: ModelCatalog;
  value: string;
  onChange: (model: string) => void;
}) {
  const route = value.startsWith(OPENROUTER) ? OPENROUTER : value.startsWith(LOCAL) ? LOCAL : null;
  const providers = [...new Set(catalog.models.map((model) => model.provider))];

  return (
    <>
      <select id={id} value={route ?? value} onChange={(event) => onChange(event.target.value)}>
        {providers.map((provider) => (
          <optgroup key={provider} label={MODEL_PROVIDER_NAMES[provider] ?? provider}>
            {catalog.models
              .filter((model) => model.provider === provider)
              .map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available}>
                  {model.name}
                  {model.available ? "" : " (not set up here)"}
                </option>
              ))}
          </optgroup>
        ))}
        {catalog.openrouter && <option value={OPENROUTER}>OpenRouter: any model…</option>}
        {catalog.local && <option value={LOCAL}>A model on the local server…</option>}
      </select>
      {route && (
        <input
          aria-label={route === OPENROUTER ? "OpenRouter model" : "Local model"}
          required
          placeholder={route === OPENROUTER ? "the model's name on OpenRouter, e.g. mistralai/mistral-large" : "the model's name on the local server"}
          value={value.slice(route.length)}
          onChange={(event) => onChange(route + event.target.value.trim())}
        />
      )}
    </>
  );
}
