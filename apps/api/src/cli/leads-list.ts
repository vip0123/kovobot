// pnpm leads:list > leads.csv
// The waitlist as CSV, oldest first.
import { listLeads } from "../leads.ts";
import { runCommand } from "./deps.ts";

await runCommand(async ({ db }) => {
  console.info("email,first_use,joined_at");
  for (const lead of await listLeads(db)) {
    console.info([lead.email, lead.firstUse ?? "", lead.joinedAt.toISOString()].join(","));
  }
});
