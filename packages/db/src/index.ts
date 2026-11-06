import pg from "pg";

export type Db = pg.Pool;

/** A connection pool. It connects lazily, so creating one never fails. */
export function createDb(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/** Runs `work` on one connection in one transaction: committed if it resolves, rolled back if it throws. */
export async function transaction<T>(db: Db, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export { migrate } from "./migrate.ts";
