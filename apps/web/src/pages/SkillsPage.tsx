import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, type Skill, type SkillFields, errorMessage } from "../api.ts";
import { AppShell, PageHeader, useShell } from "../AppShell.tsx";
import { BotAvatar } from "../BotAvatar.tsx";
import { BookIcon, PlusIcon, UploadIcon } from "../Icons.tsx";

/** The Customer's Skills: each is instructions for one kind of work, given to any of their Bots. */
export function SkillsPage() {
  return (
    <AppShell>
      <SkillLibrary />
    </AppShell>
  );
}

/** One Skill to write or change; "new" for a new one. */
export function SkillPage() {
  const { id = "new" } = useParams();
  return (
    <AppShell>
      <SkillEditorPage key={id} id={id} />
    </AppShell>
  );
}

function SkillLibrary() {
  const { bots } = useShell();
  const navigate = useNavigate();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.skills().then(
      ({ skills }) => setSkills(skills),
      (caught: unknown) => {
        setSkills([]);
        setError(errorMessage(caught));
      },
    );
  }, []);

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const { skill } = await api.importSkill(await file.text());
      navigate(`/skills/${skill.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const botNames = (skill: Skill) =>
    skill.botIds.map((id) => bots.find((bot) => bot.id === id)?.name).filter((name): name is string => Boolean(name));

  return (
    <main className="main-page">
      <PageHeader>
        <h1 className="page-title">Skills</h1>
        <div className="header-actions">
          <button type="button" className="button ghost small" onClick={() => picker.current?.click()}>
            <UploadIcon size={18} />
            <span className="drawer-toggle-label">Import SKILL.md</span>
          </button>
          <Link to="/skills/new" className="button primary small">
            <PlusIcon size={18} />
            New Skill
          </Link>
        </div>
      </PageHeader>
      <input ref={picker} type="file" accept=".md,text/markdown,text/plain" hidden onChange={importFile} />
      <div className="page-body">
        <div className="skills">
          <p className="muted skills-intro">
            A Skill is how you want one kind of work done, written once and given to any of your Bots. A Bot sees each Skill's
            name and when to use it, and reads the whole Skill when it applies.
          </p>
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {skills === null ? (
            <p className="muted">Loading…</p>
          ) : skills.length === 0 ? (
            <div className="skills-empty">
              <BookIcon size={28} />
              <h2>No Skills yet</h2>
              <p className="muted">
                Write one, such as how you like a weekly report laid out, or import a SKILL.md file you already have.
              </p>
            </div>
          ) : (
            <ul className="skill-list">
              {skills.map((skill) => {
                const names = botNames(skill);
                return (
                  <li key={skill.id}>
                    <Link to={`/skills/${skill.id}`} className="skill-card">
                      <span className="skill-card-name">{skill.name}</span>
                      <span className="skill-card-description">{skill.description}</span>
                      <span className="muted small">{names.length > 0 ? `Given to ${names.join(", ")}` : "Not given to a Bot yet"}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}

const LIMITS = { name: 64, description: 1_024, instructions: 30_000 };

function SkillEditorPage({ id }: { id: string }) {
  const navigate = useNavigate();
  const { bots } = useShell();
  const isNew = id === "new";
  const [skill, setSkill] = useState<Skill | null | undefined>(isNew ? null : undefined);
  const [fields, setFields] = useState<SkillFields>({ name: "", description: "", instructions: "" });
  const [botIds, setBotIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    api.skills().then(
      ({ skills }) => {
        const found = skills.find((candidate) => candidate.id === id) ?? null;
        setSkill(found);
        if (found) {
          setFields({ name: found.name, description: found.description, instructions: found.instructions });
          setBotIds(found.botIds);
        }
      },
      (caught: unknown) => {
        setSkill(null);
        setError(errorMessage(caught));
      },
    );
  }, [id, isNew]);

  const set = (field: keyof SkillFields) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFields({ ...fields, [field]: event.target.value });
    setNotice(null);
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = skill ? (await api.updateSkill(skill.id, fields)).skill : (await api.createSkill(fields)).skill;
      // Give it to the Bots ticked, and take it from those unticked.
      for (const bot of bots) {
        const has = saved.botIds.includes(bot.id);
        if (botIds.includes(bot.id) && !has) await api.grantSkill(bot.id, saved.id);
        if (!botIds.includes(bot.id) && has) await api.revokeSkill(bot.id, saved.id);
      }
      setSkill({ ...saved, botIds });
      setNotice("Saved. Your Bots use it from their next message.");
      if (isNew) navigate(`/skills/${saved.id}`, { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!skill) return;
    try {
      await api.deleteSkill(skill.id);
      navigate("/skills", { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  if (skill === undefined) {
    return (
      <main className="main-page">
        <PageHeader>
          <h1 className="page-title">Skill</h1>
        </PageHeader>
        <div className="page-body">
          <p className="muted">Loading…</p>
        </div>
      </main>
    );
  }
  if (skill === null && !isNew) {
    return (
      <main className="main-page">
        <PageHeader>
          <h1 className="page-title">Skill not found</h1>
        </PageHeader>
        <div className="page-body">
          <p className="alert" role="alert">
            {error ?? "There's no such Skill."}
          </p>
          <p>
            <Link to="/skills">Back to your Skills</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="main-page">
      <PageHeader>
        <h1 className="page-title">
          <Link to="/skills" className="crumb">
            Skills
          </Link>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          {skill ? skill.name : "New Skill"}
        </h1>
        {skill && (
          <div className="header-actions">
            <button type="button" className="button ghost small" onClick={() => download(skill)}>
              Download SKILL.md
            </button>
          </div>
        )}
      </PageHeader>
      <div className="page-body">
        <form className="form-card skill-form" onSubmit={save}>
          <div className="field">
            <label htmlFor="skill-name">Name</label>
            <input
              id="skill-name"
              required
              maxLength={LIMITS.name}
              placeholder="Weekly report"
              autoFocus={isNew}
              value={fields.name}
              onChange={set("name")}
            />
          </div>
          <div className="field">
            <label htmlFor="skill-description">When to use it</label>
            <p className="muted small" id="skill-description-hint">
              A Bot reads this to decide whether the Skill applies to what it's asked.
            </p>
            <textarea
              id="skill-description"
              required
              rows={2}
              maxLength={LIMITS.description}
              aria-describedby="skill-description-hint"
              placeholder="Use when I ask for the weekly sales report."
              value={fields.description}
              onChange={set("description")}
            />
          </div>
          <div className="field">
            <label htmlFor="skill-instructions">Instructions</label>
            <textarea
              id="skill-instructions"
              className="instructions-input"
              required
              rows={16}
              maxLength={LIMITS.instructions}
              placeholder={"Start with total sales and how they compare with last week.\nThen the three best sellers, then anything unusual.\nKeep it to five bullet points."}
              value={fields.instructions}
              onChange={set("instructions")}
            />
            <span className="muted small counter">
              {fields.instructions.length.toLocaleString("en-US")} / {LIMITS.instructions.toLocaleString("en-US")}
            </span>
          </div>
          {bots.length > 0 && (
            <fieldset className="field skill-bots">
              <legend>Give it to</legend>
              {bots.map((bot) => (
                <label key={bot.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={botIds.includes(bot.id)}
                    onChange={(event) => {
                      setBotIds(event.target.checked ? [...botIds, bot.id] : botIds.filter((botId) => botId !== bot.id));
                      setNotice(null);
                    }}
                  />
                  <BotAvatar id={bot.id} name={bot.name} size="small" />
                  <span>{bot.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="button primary" disabled={saving}>
              {saving ? "Saving…" : isNew ? "Create Skill" : "Save"}
            </button>
            <Link to="/skills" className="button secondary">
              {isNew ? "Cancel" : "Back"}
            </Link>
            {notice && <span className="muted small">{notice}</span>}
            {skill && !confirmingDelete && (
              <button type="button" className="button ghost danger-text skill-delete" onClick={() => setConfirmingDelete(true)}>
                Delete…
              </button>
            )}
          </div>
          {skill && confirmingDelete && (
            <div className="danger-bar skill-delete-bar">
              <span>Delete {skill.name}? Bots that have it lose it. This can't be undone.</span>
              <button type="button" className="button danger small" onClick={() => void remove()}>
                Delete it
              </button>
              <button type="button" className="button secondary small" onClick={() => setConfirmingDelete(false)}>
                Keep it
              </button>
            </div>
          )}
        </form>
      </div>
    </main>
  );
}

/** Saves a Skill as a SKILL.md file: its name and description as front matter, its instructions below. */
function download(skill: Skill) {
  const name = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "skill";
  const text = `---\nname: ${name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  link.download = "SKILL.md";
  link.click();
  URL.revokeObjectURL(link.href);
}
