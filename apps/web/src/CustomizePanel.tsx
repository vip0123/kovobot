import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, BROWSER_TIME_ZONE, type Bot, errorMessage, type Note, type Schedule, type ScheduleRule, type Skill } from "./api.ts";
import { CloseIcon } from "./Icons.tsx";

/** The most a Bot's instructions may hold, as the API allows. */
const MAX_INSTRUCTIONS = 8_000;

const TABS = [
  { id: "instructions", label: "Instructions" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" },
  { id: "schedules", label: "Schedules" },
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
        {tab === "schedules" && <Schedules bot={bot} conversationLength={conversationLength} />}
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

const REPEAT_LABELS: Record<ScheduleRule["repeat"], string> = {
  once: "Once",
  daily: "Every day",
  weekdays: "On weekdays",
  weekly: "Every week",
  monthly: "Every month",
};
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Every Mon, Wed at 08:30" */
function describeWhen(when: ScheduleRule): string {
  switch (when.repeat) {
    case "once": {
      const day = new Date(`${when.date}T00:00:00Z`).toLocaleDateString(undefined, {
        timeZone: "UTC",
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      return `Once, on ${day} at ${when.time}`;
    }
    case "daily":
      return `Every day at ${when.time}`;
    case "weekdays":
      return `On weekdays at ${when.time}`;
    case "weekly":
      return `Every ${(when.days ?? []).map((day) => DAY_NAMES[day]).join(", ")} at ${when.time}`;
    case "monthly":
      return `Every month on day ${when.dayOfMonth} at ${when.time}`;
  }
}

/** When it next runs, on its own time zone's clock. */
function nextRun(schedule: Schedule): string {
  if (!schedule.nextRunAt) return schedule.lastRunAt ? "Done" : "Off";
  const at = new Date(schedule.nextRunAt).toLocaleString(undefined, {
    timeZone: schedule.timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Next: ${at}`;
}

/** The Bot's schedules: tasks it does on its own, once or repeating. The Customer sets, changes, pauses and deletes them. */
function Schedules({ bot, conversationLength }: { bot: Bot; conversationLength: number }) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.schedules(bot.id).then(
      ({ schedules }) => setSchedules(schedules),
      (caught: unknown) => {
        setSchedules([]);
        setError(errorMessage(caught));
      },
    );
  }, [bot.id, conversationLength]);

  const replace = (schedule: Schedule) =>
    setSchedules((current) =>
      current?.some((each) => each.id === schedule.id)
        ? current.map((each) => (each.id === schedule.id ? schedule : each))
        : [...(current ?? []), schedule],
    );

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  if (editing) {
    return (
      <ScheduleForm
        bot={bot}
        initial={editing === "new" ? null : editing}
        onSaved={(schedule) => {
          replace(schedule);
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="drawer-section">
      <p className="muted small">
        {bot.name} does these on its own at their times, and its replies land in your Conversation. You can also ask it in a
        message, such as: every weekday at 8, send me the day&apos;s orders.
      </p>
      {schedules === null ? (
        <p className="muted small">Loading…</p>
      ) : schedules.length === 0 ? (
        <p className="memory-empty small">No schedules yet.</p>
      ) : (
        <ul className="notes">
          {schedules.map((schedule) => (
            <li key={schedule.id} className={`note schedule${schedule.enabled ? "" : " off"}`}>
              <div className="schedule-head">
                <p className="note-text schedule-task">{schedule.task}</p>
                <label className="switch" title={schedule.enabled ? "On" : "Off"}>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={schedule.enabled}
                    aria-label={`${schedule.enabled ? "Switch off" : "Switch on"}: ${schedule.task}`}
                    onChange={(event) =>
                      void run(async () => replace((await api.changeSchedule(bot.id, schedule.id, { enabled: event.target.checked })).schedule))
                    }
                  />
                  <span aria-hidden="true" />
                </label>
              </div>
              <p className="muted small schedule-when">
                {describeWhen(schedule.when)} · {schedule.timeZone}
              </p>
              <div className="note-foot">
                <span className="muted small">
                  {nextRun(schedule)}
                  {schedule.createdBy === "bot" ? ` · set by ${bot.name}` : ""}
                </span>
                <button type="button" className="button ghost small" onClick={() => setEditing(schedule)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="button ghost small danger-text"
                  onClick={() =>
                    void run(async () => {
                      await api.deleteSchedule(bot.id, schedule.id);
                      setSchedules((current) => current?.filter((each) => each.id !== schedule.id) ?? null);
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="button secondary small" onClick={() => setEditing("new")}>
          New schedule
        </button>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Setting a schedule, or changing one. */
function ScheduleForm({
  bot,
  initial,
  onSaved,
  onCancel,
}: {
  bot: Bot;
  initial: Schedule | null;
  onSaved: (schedule: Schedule) => void;
  onCancel: () => void;
}) {
  const [task, setTask] = useState(initial?.task ?? "");
  const [repeat, setRepeat] = useState<ScheduleRule["repeat"]>(initial?.when.repeat ?? "daily");
  const [time, setTime] = useState(initial?.when.time ?? "09:00");
  const [date, setDate] = useState(initial?.when.date ?? new Date().toISOString().slice(0, 10));
  const [days, setDays] = useState<number[]>(initial?.when.days ?? [1]);
  const [dayOfMonth, setDayOfMonth] = useState(initial?.when.dayOfMonth ?? 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeZone = initial?.timeZone ?? BROWSER_TIME_ZONE;

  async function save(event: FormEvent) {
    event.preventDefault();
    const when: ScheduleRule = {
      repeat,
      time,
      ...(repeat === "once" ? { date } : {}),
      ...(repeat === "weekly" ? { days } : {}),
      ...(repeat === "monthly" ? { dayOfMonth } : {}),
    };
    setSaving(true);
    setError(null);
    try {
      const { schedule } = initial
        ? await api.changeSchedule(bot.id, initial.id, { task, when })
        : await api.addSchedule(bot.id, { task, when, timeZone });
      onSaved(schedule);
    } catch (caught) {
      setError(errorMessage(caught));
      setSaving(false);
    }
  }

  return (
    <form className="drawer-section schedule-form" onSubmit={save}>
      <div className="field">
        <label htmlFor="schedule-task">What should {bot.name} do?</label>
        <textarea
          id="schedule-task"
          rows={3}
          required
          maxLength={2_000}
          autoFocus
          placeholder="Send me a summary of yesterday's orders."
          value={task}
          onChange={(event) => setTask(event.target.value)}
        />
      </div>
      <div className="schedule-when-fields">
        <div className="field">
          <label htmlFor="schedule-repeat">When</label>
          <select id="schedule-repeat" value={repeat} onChange={(event) => setRepeat(event.target.value as ScheduleRule["repeat"])}>
            {Object.entries(REPEAT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="schedule-time">At</label>
          <input id="schedule-time" type="time" required value={time} onChange={(event) => setTime(event.target.value)} />
        </div>
      </div>
      {repeat === "once" && (
        <div className="field">
          <label htmlFor="schedule-date">On</label>
          <input id="schedule-date" type="date" required value={date} onChange={(event) => setDate(event.target.value)} />
        </div>
      )}
      {repeat === "weekly" && (
        <fieldset className="field day-picker">
          <legend>On</legend>
          <div className="day-chips">
            {DAY_NAMES.map((name, day) => (
              <label key={name} className={`day-chip${days.includes(day) ? " on" : ""}`}>
                <input
                  type="checkbox"
                  checked={days.includes(day)}
                  onChange={(event) =>
                    setDays(event.target.checked ? [...days, day].sort((a, b) => a - b) : days.filter((each) => each !== day))
                  }
                />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {repeat === "monthly" && (
        <div className="field">
          <label htmlFor="schedule-day">On day</label>
          <input
            id="schedule-day"
            type="number"
            min={1}
            max={31}
            required
            value={dayOfMonth}
            onChange={(event) => setDayOfMonth(Number(event.target.value))}
          />
        </div>
      )}
      <p className="muted small">Times are on {timeZone} time.</p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button primary small" disabled={saving || !task.trim()}>
          {saving ? "Saving…" : initial ? "Save" : "Set schedule"}
        </button>
        <button type="button" className="button secondary small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
