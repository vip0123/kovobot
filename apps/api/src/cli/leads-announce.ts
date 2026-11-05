// pnpm leads:announce
// At launch, once SIGN_UP_OPEN=true is live: emails every lead once that sign-up is open.
// Safe to run again; it only emails leads it hasn't told yet.
import { announceSignUpOpen } from "../leads.ts";
import { runCommand } from "./deps.ts";

await runCommand(async (deps) => {
  const sent = await announceSignUpOpen(deps);
  console.info(`Told ${sent} lead${sent === 1 ? "" : "s"} that sign-up is open.`);
});
