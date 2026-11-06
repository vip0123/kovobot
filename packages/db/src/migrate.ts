import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

// Any constant works; it only has to be the same for every process that migrates.
const MIGRATION_LOCK_KEY = 4_200_101;

/**
 * Applies every migration in packages/db/migrations that hasn't run yet, in
 * file-name order, each in its own transaction. Returns the names it applied.
 *
 * Migrations run before the new release starts, while the previous release is
 * still serving, so each one must work with the previous release's code.
 * A migration that has run must never change; write a new one instead.
 */
export async function migrate(db: pg.Pool): Promise<string[]> {
  const client = await db.connect();
  try {
    // Two releases deploying at once must not migrate at the same time.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const appliedChecksums = new Map(rows.map((row) => [row.name, row.checksum]));

    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const file of files) {
      // Normalise line endings so a Windows checkout gets the same checksum.
      const sql = (await readFile(new URL(file, MIGRATIONS_DIR), "utf8")).replaceAll("\r\n", "\n");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = appliedChecksums.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} changed after it was applied. Write a new migration instead.`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed`, { cause: error });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
