import pg from "pg";

export type Db = pg.Pool;

/** A connection pool. It connects lazily, so creating one never fails. */
export function createDb(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export { migrate } from "./migrate.ts";
