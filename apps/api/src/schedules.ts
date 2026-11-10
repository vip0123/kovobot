import { type Context, Hono } from "hono";
import type { Db } from "@kovobot/db";
import type { AppDeps } from "./app.ts";
import type { Customer } from "./customers.ts";
import { apiError, jsonBody, UUID_PATTERN } from "./http.ts";

/** When a schedule runs, on the wall clock of its time zone. */
export interface ScheduleRule {
  repeat: "once" | "daily" | "weekdays" | "weekly" | "monthly";
  /** The time of day, "HH:MM". */
  time: string;
  /** A one-off's date, "YYYY-MM-DD". */
  date?: string;
  /** A weekly schedule's days: 0 is Sunday, 6 Saturday. */
  days?: number[];
  /** A monthly schedule's day: in a month without it, the last day. */
  dayOfMonth?: number;
}

/** A task a Bot does on its own, once or repeating. Each firing is one Task. */
export interface Schedule {
  id: string;
  task: string;
  when: ScheduleRule;
  timeZone: string;
  enabled: boolean;
  /** Null when it won't run again: switched off, or a one-off that has run. */
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  createdBy: "customer" | "bot";
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_SCHEDULES_PER_BOT = 20;
const MAX_TASK_LENGTH = 2_000;
/** How often the Bot service looks for schedules that are due. */
export const FIRING_SWEEP_MS = 30_000;

const REPEATS: ReadonlyArray<ScheduleRule["repeat"]> = ["once", "daily", "weekdays", "weekly", "monthly"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_MS = 24 * 60 * 60 * 1000;

type Env = { Variables: { customer: Customer } };

/**
 * A Bot's schedules, under /bots/:id/schedules, for the Customer to see, set, change, switch
 * off and delete. Mounted inside the Bot routes, so every route has a signed-in Customer.
 */
export function scheduleRoutes(deps: AppDeps) {
  const routes = new Hono<Env>();

  const ownBot = async (c: Context<Env>) => {
    const botId = c.req.param("id") ?? "";
    if (!UUID_PATTERN.test(botId)) return null;
    const { rowCount } = await deps.db.query("SELECT 1 FROM bots WHERE id = $1 AND customer_id = $2", [botId, c.get("customer").id]);
    return rowCount === 1 ? botId : null;
  };

  routes.get("/", async (c) => {
    const botId = await ownBot(c);
    return botId ? c.json({ schedules: await listSchedules(deps.db, botId) }) : botNotFound(c);
  });

  routes.post("/", async (c) => {
    const botId = await ownBot(c);
    if (!botId) return botNotFound(c);
    const body = await jsonBody(c);
    const made = await addSchedule(deps, botId, { task: body.task, when: body.when, timeZone: body.timeZone }, "customer");
    if ("error" in made) return made.full ? apiError(c, 409, "too_many_schedules", made.error) : invalidSchedule(c, made.error);
    return c.json({ schedule: made.schedule }, 201);
  });

  // Changes what it does or when, or switches it off or on. Switched on, it runs next time round.
  routes.patch("/:scheduleId", async (c) => {
    const botId = await ownBot(c);
    if (!botId) return botNotFound(c);
    const current = await findSchedule(deps.db, botId, c.req.param("scheduleId"));
    if (!current) return scheduleNotFound(c);
    const body = await jsonBody(c);
    const task = body.task === undefined ? current.task : readTask(body.task);
    if (task === null) return invalidSchedule(c, taskMessage());
    const when = body.when === undefined ? current.when : readRule(body.when);
    if ("error" in when) return invalidSchedule(c, when.error);
    const timeZone = body.timeZone === undefined ? current.timeZone : body.timeZone;
    if (!isTimeZone(timeZone)) return invalidSchedule(c, "That isn't a time zone we know.");
    const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
    const next = enabled ? nextFiring(when, timeZone, deps.now()) : null;
    if (enabled && next === null) return invalidSchedule(c, "That time has already passed.");
    const { rows } = await deps.db.query<Schedule>(
      `UPDATE schedules SET task = $3, rule = $4, time_zone = $5, enabled = $6, next_run_at = $7, updated_at = $8
       WHERE id = $2 AND bot_id = $1 RETURNING ${SCHEDULE_COLUMNS}`,
      [botId, current.id, task, JSON.stringify(when), timeZone, enabled, next, deps.now()],
    );
    return rows[0] ? c.json({ schedule: rows[0] }) : scheduleNotFound(c);
  });

  routes.delete("/:scheduleId", async (c) => {
    const botId = await ownBot(c);
    if (!botId) return botNotFound(c);
    const scheduleId = c.req.param("scheduleId");
    if (!UUID_PATTERN.test(scheduleId)) return scheduleNotFound(c);
    const { rowCount } = await deps.db.query("DELETE FROM schedules WHERE id = $2 AND bot_id = $1", [botId, scheduleId]);
    return rowCount === 1 ? c.body(null, 204) : scheduleNotFound(c);
  });

  return routes;
}

/** What a Task can do with its Bot's schedules. Each answers in words, for the model. */
export interface ScheduleBook {
  set(input: Record<string, unknown>): Promise<{ done: boolean; answer: string }>;
  list(): Promise<string>;
  cancel(id: string): Promise<{ done: boolean; answer: string }>;
}

/** The Bot's hand on its schedules, for one Task, in the Customer's time zone. */
export function scheduleBook(deps: AppDeps, botId: string, timeZone: string): ScheduleBook {
  return {
    async set(input) {
      const when = {
        repeat: input.repeat,
        time: input.time,
        date: input.date,
        days: input.days,
        dayOfMonth: input.day_of_month,
      };
      const made = await addSchedule(deps, botId, { task: input.task, when, timeZone }, "bot");
      if ("error" in made) return { done: false, answer: made.error };
      const { schedule } = made;
      return {
        done: true,
        answer: `Scheduled (${schedule.id}): ${describeRule(schedule.when, schedule.timeZone)}. It next runs on ${spokenTime(schedule.nextRunAt!, schedule.timeZone)}.`,
      };
    },
    async list() {
      const schedules = await listSchedules(deps.db, botId);
      if (schedules.length === 0) return "You have no schedules.";
      return schedules
        .map((schedule) => {
          const next = schedule.nextRunAt ? `next on ${spokenTime(schedule.nextRunAt, schedule.timeZone)}` : "switched off";
          return `${schedule.id}: ${JSON.stringify(schedule.task)} ${describeRule(schedule.when, schedule.timeZone)}; ${next}.`;
        })
        .join("\n");
    },
    async cancel(id) {
      const gone = UUID_PATTERN.test(id) && (await deps.db.query("DELETE FROM schedules WHERE id = $2 AND bot_id = $1", [botId, id])).rowCount === 1;
      return gone ? { done: true, answer: `Cancelled ${id}.` } : { done: false, answer: `You have no schedule ${id}.` };
    },
  };
}

/** Sets a schedule, or says why it can't be set. */
async function addSchedule(
  deps: AppDeps,
  botId: string,
  given: { task: unknown; when: unknown; timeZone: unknown },
  createdBy: Schedule["createdBy"],
): Promise<{ schedule: Schedule } | { error: string; full?: boolean }> {
  const task = readTask(given.task);
  if (task === null) return { error: taskMessage() };
  const when = readRule(given.when);
  if ("error" in when) return when;
  if (!isTimeZone(given.timeZone)) return { error: "That isn't a time zone we know." };
  const now = deps.now();
  const next = nextFiring(when, given.timeZone, now);
  if (next === null) return { error: "That time has already passed." };
  const { rows } = await deps.db.query<Schedule>(
    `INSERT INTO schedules (bot_id, task, rule, time_zone, next_run_at, created_by, created_at, updated_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $7 WHERE (SELECT count(*) FROM schedules WHERE bot_id = $1) < $8
     RETURNING ${SCHEDULE_COLUMNS}`,
    [botId, task, JSON.stringify(when), given.timeZone, next, createdBy, now, MAX_SCHEDULES_PER_BOT],
  );
  if (!rows[0]) return { error: `A Bot can have up to ${MAX_SCHEDULES_PER_BOT} schedules. Delete one first.`, full: true };
  return { schedule: rows[0] };
}

function taskMessage() {
  return `Say what the Bot should do, in up to ${MAX_TASK_LENGTH.toLocaleString("en-US")} characters.`;
}

function readTask(value: unknown): string | null {
  const task = typeof value === "string" ? value.trim() : "";
  return task.length >= 1 && task.length <= MAX_TASK_LENGTH ? task : null;
}

/** A schedule's rule as given, checked; or what's wrong with it. */
export function readRule(value: unknown): ScheduleRule | { error: string } {
  const given = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const repeat = REPEATS.find((each) => each === given.repeat);
  if (!repeat) return { error: "Pick when it runs: once, every day, on weekdays, weekly or monthly." };
  const time = typeof given.time === "string" ? given.time.trim() : "";
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!clock) return { error: "Give a time of day, such as 09:30." };
  const rule: ScheduleRule = { repeat, time: `${clock[1]!.padStart(2, "0")}:${clock[2]}` };
  if (repeat === "once") {
    const date = typeof given.date === "string" ? given.date.trim() : "";
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const [year, month, day] = parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : [0, 0, 0];
    const real = parts && new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day && month >= 1 && month <= 12;
    if (!real) return { error: "Give the date it runs on." };
    rule.date = date;
  }
  if (repeat === "weekly") {
    const days = Array.isArray(given.days) ? [...new Set(given.days)] : [];
    if (days.length === 0 || !days.every((day) => Number.isInteger(day) && (day as number) >= 0 && (day as number) <= 6)) {
      return { error: "Pick the days of the week it runs on." };
    }
    rule.days = (days as number[]).sort((a, b) => a - b);
  }
  if (repeat === "monthly") {
    const day = given.dayOfMonth;
    if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 31) return { error: "Pick a day of the month from 1 to 31." };
    rule.dayOfMonth = day as number;
  }
  return rule;
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first time after `after` the schedule runs, on the wall clock of `timeZone`; null if it
 * never will again. Missed times are skipped, so a schedule late by days runs once.
 */
export function nextFiring(rule: ScheduleRule, timeZone: string, after: Date): Date | null {
  const [hour, minute] = rule.time.split(":").map(Number) as [number, number];
  if (rule.repeat === "once") {
    const [year, month, day] = rule.date!.split("-").map(Number) as [number, number, number];
    const at = instantAt(timeZone, year, month, day, hour, minute);
    return at > after ? at : null;
  }
  const today = wallClock(after, timeZone);
  // Over a year's days, from today on the schedule's own wall clock.
  for (let cursor = Date.UTC(today.year, today.month - 1, today.day), checked = 0; checked < 400; cursor += DAY_MS, checked += 1) {
    const date = new Date(cursor);
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (!runsOn(rule, year, month, day, date.getUTCDay())) continue;
    const at = instantAt(timeZone, year, month, day, hour, minute);
    if (at > after) return at;
  }
  return null;
}

function runsOn(rule: ScheduleRule, year: number, month: number, day: number, weekday: number): boolean {
  switch (rule.repeat) {
    case "daily":
      return true;
    case "weekdays":
      return weekday >= 1 && weekday <= 5;
    case "weekly":
      return rule.days!.includes(weekday);
    case "monthly":
      return day === Math.min(rule.dayOfMonth!, new Date(Date.UTC(year, month, 0)).getUTCDate());
    default:
      return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The date and time a clock in `timeZone` shows at `instant`. */
function wallClock(instant: Date, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

/** How far ahead of UTC `timeZone`'s clock is at `instant`, in milliseconds. */
function offsetAt(timeZone: string, instant: number): number {
  const clock = wallClock(new Date(instant), timeZone);
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - Math.floor(instant / 1000) * 1000;
}

/** The instant a clock in `timeZone` shows this date and time. A time a clock change skips comes out an hour later. */
function instantAt(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const guess = asUtc - offsetAt(timeZone, asUtc);
  return new Date(asUtc - offsetAt(timeZone, guess));
}

/** "Friday 6 November 2026 at 08:00", on `timeZone`'s clock. */
export function spokenTime(instant: Date, timeZone: string): string {
  const clock = wallClock(instant, timeZone);
  return `${spokenDate(clock.year, clock.month, clock.day)} at ${pad(clock.hour)}:${pad(clock.minute)}`;
}

/** "Thursday 5 November 2026, 12:00, Europe/London": when a message reaches the model, as the Customer's clock shows it. */
export function timeStamp(instant: Date, timeZone: string): string {
  const clock = wallClock(instant, timeZone);
  return `${spokenDate(clock.year, clock.month, clock.day)}, ${pad(clock.hour)}:${pad(clock.minute)}, ${timeZone}`;
}

function spokenDate(year: number, month: number, day: number): string {
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${day} ${MONTHS[month - 1]} ${year}`;
}

/** "every day at 08:00, Europe/London time" */
export function describeRule(rule: ScheduleRule, timeZone: string): string {
  const at = `at ${rule.time}, ${timeZone} time`;
  switch (rule.repeat) {
    case "once": {
      const [year, month, day] = rule.date!.split("-").map(Number) as [number, number, number];
      return `once, on ${spokenDate(year, month, day)} ${at}`;
    }
    case "daily":
      return `every day ${at}`;
    case "weekdays":
      return `on weekdays ${at}`;
    case "weekly": {
      const names = rule.days!.map((day) => WEEKDAYS[day]!);
      return `every ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]} ${at}`;
    }
    case "monthly":
      return `on day ${rule.dayOfMonth} of every month ${at}`;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

const SCHEDULE_COLUMNS = `id, task, rule AS "when", time_zone AS "timeZone", enabled, next_run_at AS "nextRunAt",
  last_run_at AS "lastRunAt", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;

async function listSchedules(db: Db, botId: string): Promise<Schedule[]> {
  const { rows } = await db.query<Schedule>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE bot_id = $1 ORDER BY created_at, id`, [botId]);
  return rows;
}

async function findSchedule(db: Db, botId: string, scheduleId: string): Promise<Schedule | null> {
  if (!UUID_PATTERN.test(scheduleId)) return null;
  const { rows } = await db.query<Schedule>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = $2 AND bot_id = $1`, [botId, scheduleId]);
  return rows[0] ?? null;
}

function botNotFound(c: Context) {
  return apiError(c, 404, "bot_not_found", "There's no such Bot.");
}

function scheduleNotFound(c: Context) {
  return apiError(c, 404, "schedule_not_found", "There's no such schedule.");
}

function invalidSchedule(c: Context, message: string) {
  return apiError(c, 400, "invalid_schedule", message);
}
