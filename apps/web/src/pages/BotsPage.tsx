import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type Bot, errorMessage, type ModelCatalog } from "../api.ts";
import { canUse, firstAvailableModel, ModelPicker, modelLabel } from "../ModelPicker.tsx";
import { AppShell } from "../AppShell.tsx";

export function BotsPage() {
  return <AppShell>{() => <BotList />}</AppShell>;
}

function BotList() {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog>({ models: [], openrouter: false, local: false });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.bots(), api.models()]).then(
      ([{ bots }, catalog]) => {
        setBots(bots);
        setCatalog(catalog);
      },
      (caught: unknown) => setError(errorMessage(caught)),
    );
  }, []);


  return (
    <main className="page">
      <div className="page-head">
        <h1>Bots</h1>
        {bots && bots.length > 0 && !creating && (
          <button type="button" className="button primary" onClick={() => setCreating(true)}>
            New Bot
          </button>
        )}
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {bots === null && !error && <p className="muted">Loading…</p>}
      {bots !== null && (bots.length === 0 || creating) && (
        <NewBotForm catalog={catalog} first={bots.length === 0} onCancel={() => setCreating(false)} />
      )}
      {bots !== null && bots.length > 0 && (
        <ul className="bot-list">
          {bots.map((bot) => (
            <li key={bot.id}>
              <Link to={`/bots/${bot.id}`} className="bot-card">
                <span className="bot-name">{bot.name}</span>
                <span className="muted small">{modelLabel(catalog, bot.model)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function NewBotForm({ catalog, first, onCancel }: { catalog: ModelCatalog; first: boolean; onCancel: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosenModel = model || firstAvailableModel(catalog);

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { bot } = await api.createBot(name, chosenModel);
      navigate(`/bots/${bot.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
      setSaving(false);
    }
  }

  return (
    <section className={first ? "empty" : "panel"}>
      {first && (
        <>
          <h2>No Bots yet</h2>
          <p className="muted">Name your first Bot and pick the model it thinks with.</p>
        </>
      )}
      <form className="new-bot" onSubmit={create}>
        <div className="field">
          <label htmlFor="bot-name">Name</label>
          <input
            id="bot-name"
            required
            maxLength={80}
            placeholder="Market watch"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="bot-model">Model</label>
          <ModelPicker id="bot-model" catalog={catalog} value={chosenModel} onChange={setModel} />
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {!firstAvailableModel(catalog) && catalog.models.length > 0 && (
          <p className="alert" role="alert">
            No Model provider key is set up here yet, so Bots can't reply.
          </p>
        )}
        <div className="actions">
          <button type="submit" className="button primary" disabled={saving || !canUse(catalog, chosenModel)}>
            {saving ? "Creating…" : "Create Bot"}
          </button>
          {!first && (
            <button type="button" className="button secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
