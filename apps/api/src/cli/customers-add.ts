// pnpm customers:add someone@example.com
// Lets someone in while sign-up is closed, such as a tester on staging.
import { findOrCreateCustomerByEmail, normaliseEmail } from "../customers.ts";
import { runCommand } from "./deps.ts";

const email = normaliseEmail(process.argv[2]);
if (!email) {
  console.error("Usage: pnpm customers:add someone@example.com");
  process.exit(2);
}

await runCommand(async ({ db }) => {
  await findOrCreateCustomerByEmail(db, email);
  console.info(`${email} can now sign in.`);
});
