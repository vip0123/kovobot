import type { TestProject } from "vitest/node";
import { createDb, migrate } from "../packages/db/src/index.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** A freshly created and migrated database, dropped after the run. */
    databaseUrl: string;
  }
}

// The local Postgres from docker-compose.yml (pnpm db:up). Override with TEST_DATABASE_URL.
const DEFAULT_TEST_SERVER = "postgres://kovobot:kovobot@localhost:54329/kovobot";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const serverUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_SERVER;
  const admin = createDb(serverUrl);
  const name = `kovobot_test_${process.pid}_${Date.now()}`;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (error) {
    await admin.end();
    throw new Error(`Tests need Postgres at ${serverUrl}. Start it with: pnpm db:up`, { cause: error });
  }

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const db = createDb(url.toString());
  try {
    await migrate(db);
  } finally {
    await db.end();
  }
  project.provide("databaseUrl", url.toString());

  return async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  };
}
