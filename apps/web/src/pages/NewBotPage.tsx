import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, errorMessage } from "../api.ts";
import { AppShell, PageHeader, useShell } from "../AppShell.tsx";
import { canUse, firstAvailableModel, ModelPicker } from "../ModelPicker.tsx";

export function NewBotPage() {
  return (
    <AppShell>
      <main className="main-page">
        <PageHeader>
          <h1 className="page-title">New Bot</h1>
        </PageHeader>
        <div className="page-body">
          <section className="form-card">
            <h2>Make a Bot</h2>
            <p className="muted">Give it a name and pick the model it thinks with. You can change both later.</p>
            <NewBotForm />
          </section>
        </div>
      </main>
    </AppShell>
  );
}

/** A name and a model: all a new Bot needs. Once made, its page opens. */
export function NewBotForm() {
  const navigate = useNavigate();
  const { bots, catalog, saveBot } = useShell();
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
      saveBot(bot);
      navigate(`/bots/${bot.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
      setSaving(false);
    }
  }

  return (
    <form className="new-bot" onSubmit={create}>
      <div className="field">
        <label htmlFor="bot-name">Name</label>
        <input
          id="bot-name"
          required
          maxLength={80}
          placeholder="Market watch"
          autoFocus
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
        {bots.length > 0 && (
          <Link to="/bots" className="button secondary">
            Cancel
          </Link>
        )}
      </div>
    </form>
  );
}
