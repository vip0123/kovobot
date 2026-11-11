import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type Bot, errorMessage, type Skill } from "./api.ts";
import { CloseIcon } from "./Icons.tsx";

/** The most a Bot's instructions may hold, as the API allows. */
const MAX_INSTRUCTIONS = 8_000;

/** What a Customer customises about a Bot: its instructions and its Skills. */
export function CustomizePanel({ bot, onBotChange, onClose }: { bot: Bot; onBotChange: (bot: Bot) => void; onClose: () => void }) {
  return (
    <section className="drawer-panel">
      <div className="drawer-head">
        <h2>Customize {bot.name}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <InstructionsEditor bot={bot} onBotChange={onBotChange} />
      <SkillGrants bot={bot} />
    </section>
  );
}

/** Which of the Customer's Skills this Bot has; each switch gives or takes one at once. */
function SkillGrants({ bot }: { bot: Bot }) {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.skills().then(
      ({ skills }) => setSkills(skills),
      (caught: unknown) => {
        setSkills([]);
        setError(errorMessage(caught));
      },
    );
  }, []);

  async function toggle(skill: Skill, give: boolean) {
    setBusy(skill.id);
    setError(null);
    try {
      await (give ? api.grantSkill(bot.id, skill.id) : api.revokeSkill(bot.id, skill.id));
      const botIds = give ? [...skill.botIds, bot.id] : skill.botIds.filter((id) => id !== bot.id);
      setSkills((current) => current?.map((each) => (each.id === skill.id ? { ...each, botIds } : each)) ?? null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <fieldset className="drawer-section skill-grants">
      <legend>Skills</legend>
      <p className="muted small">
        {bot.name} sees each Skill's name and when to use it, and reads the whole Skill when it applies.
      </p>
      {skills === null ? (
        <p className="muted small">Loading…</p>
      ) : skills.length === 0 ? (
        <p className="small">
          You have no Skills yet. <Link to="/skills/new">Write one</Link> or <Link to="/skills">import a SKILL.md file</Link>.
        </p>
      ) : (
        <>
          {skills.map((skill) => (
            <label key={skill.id} className="check-row skill-grant">
              <input
                type="checkbox"
                checked={skill.botIds.includes(bot.id)}
                disabled={busy === skill.id}
                onChange={(event) => void toggle(skill, event.target.checked)}
              />
              <span className="skill-grant-text">
                <span className="skill-grant-name">{skill.name}</span>
                <span className="muted small">{skill.description}</span>
              </span>
            </label>
          ))}
          <Link to="/skills" className="small">
            Manage your Skills
          </Link>
        </>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function InstructionsEditor({ bot, onBotChange }: { bot: Bot; onBotChange: (bot: Bot) => void }) {
  const [draft, setDraft] = useState(bot.instructions);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = draft.trim() !== bot.instructions;

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { bot: updated } = await api.setInstructions(bot.id, draft);
      onBotChange(updated);
      setDraft(updated.instructions);
      setSaved(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="drawer-section" onSubmit={save}>
      <div className="field">
        <label htmlFor="instructions">Instructions</label>
        <p className="muted small" id="instructions-hint">
          {bot.name} follows these in every message: who it works for, how it answers, what to always or never do.
        </p>
        <textarea
          id="instructions"
          className="instructions-input"
          rows={14}
          maxLength={MAX_INSTRUCTIONS}
          aria-describedby="instructions-hint"
          placeholder={"For example:\nI run a small bakery in Leeds. Answer in a friendly, plain tone.\nKeep replies under 150 words unless I ask for more.\nPrices are in pounds."}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
        <span className="muted small counter" aria-live="polite">
          {draft.length.toLocaleString("en-US")} / {MAX_INSTRUCTIONS.toLocaleString("en-US")}
        </span>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button primary small" disabled={saving || !changed}>
          {saving ? "Saving…" : "Save"}
        </button>
        {changed && (
          <button type="button" className="button secondary small" onClick={() => setDraft(bot.instructions)}>
            Undo changes
          </button>
        )}
        {saved && !changed && <span className="muted small">Saved. {bot.name} uses them from the next message.</span>}
      </div>
    </form>
  );
}
