import { type Context, Hono } from "hono";
import type { Db } from "@kovobot/db";
import type { AppDeps } from "./app.ts";
import { type Customer, ownsBot } from "./customers.ts";
import { apiError, botNotFound, jsonBody, UUID_PATTERN } from "./http.ts";

/** Instructions a Customer writes once for one kind of work, and grants to their Bots. */
export interface Skill {
  id: string;
  name: string;
  /** When to use it: all the Bot sees of it until it reads the instructions. */
  description: string;
  instructions: string;
  /** The Customer's Bots that have it. */
  botIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** What a Bot sees of a Skill until it reads it. */
export interface SkillSummary {
  name: string;
  description: string;
}

type SkillFields = Pick<Skill, "name" | "description" | "instructions">;

/** Each field's limit, and what to say when it's missing or too long. */
const FIELDS: ReadonlyArray<{ field: keyof SkillFields; max: number; message: string }> = [
  { field: "name", max: 64, message: "Give the Skill a name of up to 64 characters." },
  { field: "description", max: 1_024, message: "Say when to use the Skill, in up to 1,024 characters." },
  { field: "instructions", max: 30_000, message: "Write the Skill's instructions, in up to 30,000 characters." },
];

/** A Bot sees every Skill it has in its instructions, so their number is kept small. */
export const MAX_SKILLS_PER_BOT = 20;

type Env = { Variables: { customer: Customer } };

/**
 * A Customer's Skills, and which of their Bots have each. Mounted inside the Bot routes,
 * so every route has a signed-in Customer.
 */
export function skillRoutes(deps: AppDeps) {
  const routes = new Hono<Env>();

  routes.get("/skills", async (c) => c.json({ skills: await listSkills(deps.db, c.get("customer").id) }));

  // A Skill from its fields, or from a SKILL.md file's text.
  routes.post("/skills", async (c) => {
    const body = await jsonBody(c);
    let given: Record<string, unknown> = body;
    if (body.file !== undefined) {
      const parsed = typeof body.file === "string" ? parseSkillFile(body.file) : null;
      if (!parsed) {
        return apiError(c, 400, "invalid_skill_file", "That isn't a SKILL.md file: it needs a name and a description between --- lines at the top.");
      }
      given = parsed;
    }
    const fields = skillFields(given, { partial: false });
    if ("error" in fields) return apiError(c, 400, "invalid_skill", fields.error);
    return saved(c, fields.name, () => createSkill(deps.db, c.get("customer").id, fields as SkillFields, deps.now()), 201);
  });

  routes.patch("/skills/:skillId", async (c) => {
    const fields = skillFields(await jsonBody(c), { partial: true });
    if ("error" in fields) return apiError(c, 400, "invalid_skill", fields.error);
    if (Object.keys(fields).length === 0) return apiError(c, 400, "invalid_skill", "Change the Skill's name, description or instructions.");
    return saved(c, fields.name, () => updateSkill(deps.db, c.get("customer").id, c.req.param("skillId"), fields, deps.now()), 200);
  });

  routes.delete("/skills/:skillId", async (c) => {
    const skillId = c.req.param("skillId");
    if (!UUID_PATTERN.test(skillId)) return skillNotFound(c);
    const { rowCount } = await deps.db.query("DELETE FROM skills WHERE id = $1 AND customer_id = $2", [skillId, c.get("customer").id]);
    return rowCount === 1 ? c.body(null, 204) : skillNotFound(c);
  });

  // Grants a Skill to a Bot; granting one it already has changes nothing.
  routes.put("/bots/:id/skills/:skillId", async (c) => {
    const refused = await refuseUnlessOwned(c, deps.db);
    if (refused) return refused;
    const [botId, skillId] = [c.req.param("id"), c.req.param("skillId")];
    const { rowCount: had } = await deps.db.query("SELECT 1 FROM bot_skills WHERE bot_id = $1 AND skill_id = $2", [botId, skillId]);
    if (had === 1) return c.body(null, 204);
    const { rowCount } = await deps.db.query(
      `INSERT INTO bot_skills (bot_id, skill_id)
       SELECT $1, $2 WHERE (SELECT count(*) FROM bot_skills WHERE bot_id = $1) < $3
       ON CONFLICT DO NOTHING`,
      [botId, skillId, MAX_SKILLS_PER_BOT],
    );
    if (rowCount === 0) {
      return apiError(c, 409, "too_many_skills", `A Bot can have up to ${MAX_SKILLS_PER_BOT} Skills. Take one away first.`);
    }
    return c.body(null, 204);
  });

  routes.delete("/bots/:id/skills/:skillId", async (c) => {
    const refused = await refuseUnlessOwned(c, deps.db);
    if (refused) return refused;
    await deps.db.query("DELETE FROM bot_skills WHERE bot_id = $1 AND skill_id = $2", [c.req.param("id"), c.req.param("skillId")]);
    return c.body(null, 204);
  });

  return routes;
}

/** The Skills a Bot has: what it sees of each until it reads one. */
export async function botSkills(db: Db, botId: string): Promise<SkillSummary[]> {
  const { rows } = await db.query<SkillSummary>(
    `SELECT skills.name, skills.description FROM bot_skills JOIN skills ON skills.id = bot_skills.skill_id
     WHERE bot_skills.bot_id = $1 ORDER BY lower(skills.name)`,
    [botId],
  );
  return rows;
}

/** The instructions of the Bot's Skill called `name`; null when it has none by that name. */
export async function skillInstructions(db: Db, botId: string, name: string): Promise<string | null> {
  const { rows } = await db.query<{ instructions: string }>(
    `SELECT skills.instructions FROM bot_skills JOIN skills ON skills.id = bot_skills.skill_id
     WHERE bot_skills.bot_id = $1 AND lower(skills.name) = lower($2)`,
    [botId, name],
  );
  return rows[0]?.instructions ?? null;
}

/**
 * A SKILL.md file's Skill: its name and description from the YAML front matter between the
 * --- lines at the top, and the rest of the file as its instructions. Null if it has no front
 * matter with both. Other front-matter keys, such as a licence, are left out.
 */
export function parseSkillFile(text: string): SkillFields | null {
  // A byte-order mark at the start, as some editors save one, isn't part of the front matter.
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return null;
  const values = frontMatter(lines.slice(1, end));
  if (!values.name || !values.description) return null;
  return { name: values.name, description: values.description, instructions: lines.slice(end + 1).join("\n").trim() };
}

/** The top-level `key: value` pairs of YAML front matter: plain or quoted values, and | or > blocks. */
function frontMatter(lines: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index]!);
    if (!match) continue;
    const [, key, raw] = match as unknown as [string, string, string];
    const block = /^([|>])[+-]?$/.exec(raw.trim());
    if (!block) {
      values[key] = unquote(raw.trim());
      continue;
    }
    const blockLines: string[] = [];
    while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]!) || lines[index + 1]!.trim() === "")) {
      blockLines.push(lines[(index += 1)]!.trim());
    }
    // A > block folds its lines into one; a | block keeps them.
    values[key] = block[1] === ">" ? blockLines.filter(Boolean).join(" ") : blockLines.join("\n").trim();
  }
  return values;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    // YAML's double-quoted escapes include JSON's, which is how a Skill downloaded from here writes them.
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

/** The Skill fields given, trimmed and within their limits; with `partial`, only those present. */
function skillFields(body: Record<string, unknown>, { partial }: { partial: boolean }): Partial<SkillFields> | { error: string } {
  const fields: Partial<SkillFields> = {};
  for (const { field, max, message } of FIELDS) {
    if (partial && body[field] === undefined) continue;
    const given = body[field];
    const value = typeof given === "string" ? given.trim() : "";
    if (value.length < 1 || value.length > max) return { error: message };
    fields[field] = value;
  }
  return fields;
}

/** Saves a Skill, answering with it; a name the Customer already uses is refused. */
async function saved(c: Context<Env>, name: string | undefined, save: () => Promise<Skill | null>, status: 200 | 201) {
  try {
    const skill = await save();
    return skill ? c.json({ skill }, status) : skillNotFound(c);
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    return apiError(c, 409, "skill_name_taken", `You already have a Skill called ${name}. Pick another name.`);
  }
}

/** A refusal unless both the Bot and the Skill in the path are the Customer's own. */
async function refuseUnlessOwned(c: Context<Env>, db: Db): Promise<Response | null> {
  const customerId = c.get("customer").id;
  const [botId, skillId] = [c.req.param("id") ?? "", c.req.param("skillId") ?? ""];
  if (!(await ownsBot(db, customerId, botId))) return botNotFound(c);
  const ownsSkill = UUID_PATTERN.test(skillId) && (await db.query("SELECT 1 FROM skills WHERE id = $1 AND customer_id = $2", [skillId, customerId])).rowCount === 1;
  if (!ownsSkill) return skillNotFound(c);
  return null;
}

function skillNotFound(c: Context) {
  return apiError(c, 404, "skill_not_found", "There's no such Skill.");
}

const SKILL_COLUMNS = `skills.id, skills.name, skills.description, skills.instructions,
  coalesce((SELECT json_agg(bot_skills.bot_id ORDER BY bot_skills.bot_id) FROM bot_skills WHERE bot_skills.skill_id = skills.id), '[]') AS "botIds",
  skills.created_at AS "createdAt", skills.updated_at AS "updatedAt"`;

async function listSkills(db: Db, customerId: string): Promise<Skill[]> {
  const { rows } = await db.query<Skill>(
    `SELECT ${SKILL_COLUMNS} FROM skills WHERE customer_id = $1 ORDER BY lower(skills.name), skills.id`,
    [customerId],
  );
  return rows;
}

async function createSkill(db: Db, customerId: string, skill: SkillFields, now: Date): Promise<Skill> {
  const { rows } = await db.query<Skill>(
    `INSERT INTO skills (customer_id, name, description, instructions, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING ${SKILL_COLUMNS}`,
    [customerId, skill.name, skill.description, skill.instructions, now],
  );
  return rows[0]!;
}

async function updateSkill(db: Db, customerId: string, skillId: string, change: Partial<SkillFields>, now: Date): Promise<Skill | null> {
  if (!UUID_PATTERN.test(skillId)) return null;
  const { rows } = await db.query<Skill>(
    `UPDATE skills SET name = COALESCE($3, name), description = COALESCE($4, description),
       instructions = COALESCE($5, instructions), updated_at = $6
     WHERE id = $1 AND customer_id = $2 RETURNING ${SKILL_COLUMNS}`,
    [skillId, customerId, change.name ?? null, change.description ?? null, change.instructions ?? null, now],
  );
  return rows[0] ?? null;
}
