// pnpm leads:list > leads.csv
// The waitlist as CSV, oldest first.
import { listLeads } from "../leads.ts";
import { runCommand } from "./deps.ts";

await runCommand(async ({ db }) => {
  console.info("email,first_use,joined_at");
  for (const lead of await listLeads(db)) {
    console.info([lead.email, lead.firstUse ?? "", lead.joinedAt.toISOString()].map(csvField).join(","));
  }
});

/**
 * A CSV field anyone can type safely into the landing form: quoted, with
 * quotes doubled, and with a leading = + - or @ defused so a spreadsheet
 * never runs it as a formula.
 */
function csvField(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
