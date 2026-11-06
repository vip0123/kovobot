import type { ModelCatalog } from "./api.ts";

const MODEL_PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
};

const OPENROUTER = "openrouter:";
const LOCAL = "local:";

/** Whether a Bot can be set to this model here: its Model provider is set up, and an OpenRouter or local model is named. */
export function canUse(catalog: ModelCatalog, model: string): boolean {
  if (model.startsWith(OPENROUTER)) return catalog.openrouter && model.length > OPENROUTER.length;
  if (model.startsWith(LOCAL)) return catalog.local && model.length > LOCAL.length;
  return catalog.models.some((listed) => listed.id === model && listed.available);
}

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
  const routeOffered = route === OPENROUTER ? catalog.openrouter : route === LOCAL ? catalog.local : false;
  const providers = [...new Set(catalog.models.map((model) => model.provider))];
  // A Bot's current model whose Model provider has since gone: shown, so the choice is never blank.
  const gone =
    route && !routeOffered
      ? `${route === OPENROUTER ? "OpenRouter: " : "Local: "}${value.slice(route.length)}`
      : !route && value && !catalog.models.some((model) => model.id === value)
        ? value
        : null;

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
        {gone && (
          <option value={route ?? value} disabled>
            {gone} (not set up here)
          </option>
        )}
      </select>
      {route && routeOffered && (
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
