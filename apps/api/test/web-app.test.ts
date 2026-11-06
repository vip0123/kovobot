import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { startTestServer } from "./harness.ts";

// A stand-in for the web app's production build.
const dist = mkdtempSync(join(tmpdir(), "kovobot-web-"));
writeFileSync(join(dist, "index.html"), "<!doctype html><title>Kovobot</title>");
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "assets", "app-1a2b3c.js"), "console.log('Kovobot')");

const server = startTestServer({ WEB_DIST_DIR: dist });

describe("serving the web app from the API, so both share one origin", () => {
  test("every page the web app routes itself gets the app", async () => {
    const browser = server.browser();

    for (const page of ["/", "/sign-in", "/bots"]) {
      const response = await browser.get(page);
      expect(response.status, page).toBe(200);
      expect(await response.text(), page).toContain("<title>Kovobot</title>");
    }
  });

  test("built assets are served with a long cache, the page itself is always re-checked", async () => {
    const browser = server.browser();

    const asset = await browser.get("/assets/app-1a2b3c.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await browser.get("/bots")).headers.get("cache-control")).toBe("no-cache");
  });

  test("a missing asset is a 404, not the app cached for a year", async () => {
    const missing = await server.browser().get("/assets/app-gone.js");

    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  test("an unknown API path is a JSON 404, not the web app", async () => {
    const response = await server.browser().get("/api/no-such-thing");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
