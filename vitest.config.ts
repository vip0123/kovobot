import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Creates and migrates a fresh Postgres database for the run.
    globalSetup: ["./test/global-setup.ts"],
  },
});
