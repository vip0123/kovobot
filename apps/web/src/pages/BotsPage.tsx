import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type Bot, errorMessage, type ModelInfo } from "../api.ts";
import { AppShell } from "../AppShell.tsx";

export function BotsPage() {
  return <AppShell>{() => <BotList />}</AppShell>;
}

function BotList() {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.bots(), api.models()]).then(
      ([{ bots }, { models }]) => {
        setBots(bots);
        setModels(models);
      },
      (caught: unknown) => setError(errorMessage(caught)),
    );
  }, []);

  const modelName = (id: string) => models.find((model) => model.id === id)?.name ?? id;

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
        <NewBotForm models={models} first={bots.length === 0} onCancel={() => setCreating(false)} />
      )}
      {bots !== null && bots.length > 0 && (
        <ul className="bot-list">
          {bots.map((bot) => (
            <li key={bot.id}>
              <Link to={`/bots/${bot.id}`} className="bot-card">
                <span className="bot-name">{bot.name}</span>
                <span className="muted small">{modelName(bot.model)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function NewBotForm({ models, first, onCancel }: { models: ModelInfo[]; first: boolean; onCancel: () => void }) {
  const navigate = useNavigate();
  const available = models.filter((model) => model.available);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosenModel = model || available[0]?.id || "";

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
          <select id="bot-model" value={chosenModel} onChange={(event) => setModel(event.target.value)}>
            {models.map((option) => (
              <option key={option.id} value={option.id} disabled={!option.available}>
                {option.name}
                {option.available ? "" : " (not set up here)"}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {available.length === 0 && models.length > 0 && (
          <p className="alert" role="alert">
            No Model provider key is set up here yet, so Bots can't reply.
          </p>
        )}
        <div className="actions">
          <button type="submit" className="button primary" disabled={saving || !chosenModel}>
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
