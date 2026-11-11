import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Creates and migrates a fresh Postgres database for the run.
    globalSetup: ["./test/global-setup.ts"],
    // Tests go through real HTTP and Postgres in parallel files; on a busy machine 5 seconds is too tight.
    testTimeout: 15_000,
  },
});
