import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type Bot, errorMessage, type Note, type Skill } from "./api.ts";
import { CloseIcon } from "./Icons.tsx";

/** The most a Bot's instructions may hold, as the API allows. */
const MAX_INSTRUCTIONS = 8_000;

const TABS = [
  { id: "instructions", label: "Instructions" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" },
] as const;

type Tab = (typeof TABS)[number]["id"];

/**
 * What a Customer customises about a Bot: its instructions, its Skills and its memory.
 * `conversationLength` changes as the Bot replies, so its notes are read again.
 */
export function CustomizePanel({
  bot,
  conversationLength,
  onBotChange,
  onClose,
}: {
  bot: Bot;
  conversationLength: number;
  onBotChange: (bot: Bot) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("instructions");
  return (
    <section className="drawer-panel">
      <div className="drawer-head">
        <h2>Customize {bot.name}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="tabs" role="tablist" aria-label={`Customize ${bot.name}`}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`customize-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`customize-panel-${id}`}
            className={`tab${tab === id ? " active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`customize-panel-${tab}`} aria-labelledby={`customize-tab-${tab}`}>
        {tab === "instructions" && <InstructionsEditor bot={bot} onBotChange={onBotChange} />}
        {tab === "skills" && <SkillGrants bot={bot} />}
        {tab === "memory" && <Memory bot={bot} conversationLength={conversationLength} />}
      </div>
    </section>
  );
}

const MAX_NOTE = 500;
const MAX_NOTES = 50;

/** The Bot's notes: what it keeps in mind across Conversations. The Customer reads, adds, edits and deletes them. */
function Memory({ bot, conversationLength }: { bot: Bot; conversationLength: number }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.notes(bot.id).then(
      ({ notes }) => setNotes(notes),
      (caught: unknown) => {
        setNotes([]);
        setError(errorMessage(caught));
      },
    );
  }, [bot.id, conversationLength]);

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const add = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { note } = await api.addNote(bot.id, draft);
      setNotes((current) => [...(current ?? []), note]);
      setDraft("");
    });
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    void run(async () => {
      const { note } = await api.editNote(bot.id, editing.id, editing.content);
      setNotes((current) => current?.map((each) => (each.id === note.id ? note : each)) ?? null);
      setEditing(null);
    });
  };
  const remove = (id: string) =>
    run(async () => {
      await api.deleteNote(bot.id, id);
      setNotes((current) => current?.filter((each) => each.id !== id) ?? null);
    });

  return (
    <div className="drawer-section memory">
      <p className="muted small">
        {bot.name} keeps notes of what's worth knowing next time, and reads them in every Conversation. They're yours to change.
      </p>
      {notes === null ? (
        <p className="muted small">Loading…</p>
      ) : (
        <>
          {notes.length === 0 && <p className="memory-empty small">No notes yet. Tell {bot.name} something worth remembering, or add one here.</p>}
          <ul className="notes">
            {notes.map((note) =>
              editing?.id === note.id ? (
                <li key={note.id} className="note editing">
                  <form onSubmit={save} className="stack">
                    <label htmlFor={`note-${note.id}`} className="visually-hidden">
                      Note
                    </label>
                    <textarea
                      id={`note-${note.id}`}
                      rows={3}
                      required
                      maxLength={MAX_NOTE}
                      autoFocus
                      value={editing.content}
                      onChange={(event) => setEditing({ id: note.id, content: event.target.value })}
                    />
                    <div className="actions">
                      <button type="submit" className="button primary small">
                        Save
                      </button>
                      <button type="button" className="button secondary small" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                </li>
              ) : (
                <li key={note.id} className={`note${note.afterOutsideContent ? " flagged" : ""}`}>
                  <p className="note-text">{note.content}</p>
                  {note.afterOutsideContent && (
                    <p className="note-flag small">
                      {bot.name} wrote this after reading web pages or using its Computer. Check it says what you want.
                    </p>
                  )}
                  <div className="note-foot">
                    <span className="muted small">{note.writtenBy === "bot" ? `By ${bot.name}` : "By you"}</span>
                    <button type="button" className="button ghost small" onClick={() => setEditing({ id: note.id, content: note.content })}>
                      Edit
                    </button>
                    <button type="button" className="button ghost small danger-text" onClick={() => void remove(note.id)}>
                      Delete
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
          {notes.length < MAX_NOTES ? (
            <form className="note-add" onSubmit={add}>
              <label htmlFor="new-note" className="visually-hidden">
                A new note
              </label>
              <input
                id="new-note"
                maxLength={MAX_NOTE}
                placeholder="Add a note, such as: I'm vegetarian."
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" className="button secondary small" disabled={!draft.trim()}>
                Add
              </button>
            </form>
          ) : (
            <p className="muted small">{bot.name} keeps up to {MAX_NOTES} notes. Delete one to add another.</p>
          )}
          <p className="muted small counter">
            {notes.length} of {MAX_NOTES} notes
          </p>
        </>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </div>
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
      <legend className="visually-hidden">Skills</legend>
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
