import { describe, expect, test } from "vitest";
import WebSocket from "ws";
import { type Browser, startTestServer, uniqueEmail } from "./harness.ts";

const server = startTestServer({}, { computers: true });
const withoutComputers = startTestServer();

interface Bot {
  id: string;
}

async function signedInBrowser(on = server): Promise<Browser> {
  const browser = on.browser();
  await on.signInByEmail(browser, uniqueEmail());
  return browser;
}

async function createBot(browser: Browser): Promise<Bot> {
  const response = await browser.post("/api/bots", { name: "Scout", model: "gpt-6-luna" });
  expect(response.status).toBe(201);
  return ((await response.json()) as { bot: Bot }).bot;
}

function deleteRequest(browser: Browser, path: string, on = server) {
  return browser.send(path, { method: "DELETE", headers: { origin: on.config.appUrl } });
}

async function computerOf(browser: Browser, bot: Bot): Promise<unknown> {
  const response = await browser.get(`/api/bots/${bot.id}/computer`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { computer: unknown }).computer;
}

describe("a Bot's Computer", () => {
  test("is created running, shut down, started again and deleted", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    expect(await computerOf(browser, bot)).toBeNull();

    const created = await browser.post(`/api/bots/${bot.id}/computer`);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ computer: { state: "running" } });
    expect([...server.computerService.computers.values()]).toContainEqual(expect.objectContaining({ owner: bot.id }));

    expect(await (await browser.post(`/api/bots/${bot.id}/computer/shut-down`)).json()).toEqual({
      computer: { state: "shut_down" },
    });
    expect(await computerOf(browser, bot)).toEqual({ state: "shut_down" });
    expect(await (await browser.post(`/api/bots/${bot.id}/computer/start`)).json()).toEqual({
      computer: { state: "running" },
    });

    expect((await deleteRequest(browser, `/api/bots/${bot.id}/computer`)).status).toBe(204);
    expect(await computerOf(browser, bot)).toBeNull();
    expect([...server.computerService.computers.values()]).not.toContainEqual(expect.objectContaining({ owner: bot.id }));
  });

  test("is one per Bot", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    expect((await browser.post(`/api/bots/${bot.id}/computer`)).status).toBe(201);

    const again = await browser.post(`/api/bots/${bot.id}/computer`);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "computer_exists" } });
  });

  test("belongs to its Bot's Customer only", async () => {
    const owner = await signedInBrowser();
    const bot = await createBot(owner);
    await owner.post(`/api/bots/${bot.id}/computer`);

    const stranger = await signedInBrowser();
    for (const response of [
      await stranger.get(`/api/bots/${bot.id}/computer`),
      await stranger.post(`/api/bots/${bot.id}/computer/shut-down`),
      await stranger.post(`/api/bots/${bot.id}/computer/live-view`),
      await deleteRequest(stranger, `/api/bots/${bot.id}/computer`),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "bot_not_found" } });
    }
    expect(await computerOf(owner, bot)).toEqual({ state: "running" });
  });

  test("is deleted with its Bot", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    await browser.post(`/api/bots/${bot.id}/computer`);

    expect((await deleteRequest(browser, `/api/bots/${bot.id}`)).status).toBe(204);
    expect([...server.computerService.computers.values()]).not.toContainEqual(expect.objectContaining({ owner: bot.id }));
  });

  test("that the Computer service no longer has reads as none, and a new one can be created", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    await browser.post(`/api/bots/${bot.id}/computer`);
    const lost = [...server.computerService.computers.values()].find((computer) => computer.owner === bot.id)!;
    server.computerService.forget(lost.id);

    expect(await computerOf(browser, bot)).toBeNull();
    expect((await browser.post(`/api/bots/${bot.id}/computer`)).status).toBe(201);
  });

  test("isn't forgotten when the Computer service answers from the wrong address", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    await browser.post(`/api/bots/${bot.id}/computer`);

    server.computerService.misrouted = true;
    try {
      const response = await browser.get(`/api/bots/${bot.id}/computer`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "computer_service_unavailable" } });
    } finally {
      server.computerService.misrouted = false;
    }
    expect(await computerOf(browser, bot)).toEqual({ state: "running" });
  });

  test("is unavailable where no Computer service is set up", async () => {
    const browser = await signedInBrowser(withoutComputers);
    const bot = await createBot(browser);

    for (const response of [await browser.get(`/api/bots/${bot.id}/computer`), await browser.post(`/api/bots/${bot.id}/computer`)]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "computers_off" } });
    }
    expect((await deleteRequest(browser, `/api/bots/${bot.id}`, withoutComputers)).status).toBe(204);
  });
});

/** Opens a live-view link as the browser would; resolves with its first message, or rejects with the refusal's status. */
function watch(path: string, browser: Browser | null, origin = server.config.appUrl): Promise<{ socket: WebSocket; first: string }> {
  return new Promise((resolve, reject) => {
    const session = browser?.cookie("kovobot_session");
    const socket = new WebSocket(server.listening.url.replace("http", "ws") + path, {
      headers: { origin, ...(session ? { cookie: `kovobot_session=${session}` } : {}) },
    });
    socket.once("unexpected-response", (_request, response) => reject(new Error(`refused ${response.statusCode}`)));
    socket.once("error", reject);
    socket.once("message", (data) => resolve({ socket, first: String(data) }));
  });
}

async function liveViewLink(browser: Browser, bot: Bot): Promise<string> {
  const response = await browser.post(`/api/bots/${bot.id}/computer/live-view`);
  expect(response.status).toBe(200);
  const { url, expiresAt } = (await response.json()) as { url: string; expiresAt: string };
  expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  return url;
}

describe("watching a Computer live", () => {
  test("the Customer watches it through a short-lived link, and what they do reaches the Computer", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    await browser.post(`/api/bots/${bot.id}/computer`);

    const { socket, first } = await watch(await liveViewLink(browser, bot), browser);
    expect(first).toBe("RFB 003.008\n");
    const echoed = new Promise((resolve) => socket.once("message", (data) => resolve(String(data))));
    socket.send(Buffer.from("a key press"));
    expect(await echoed).toBe("a key press");
    socket.close();
  });

  test("closes when the Customer signs out, or the Computer goes", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    await browser.post(`/api/bots/${bot.id}/computer`);

    const signedOut = await watch(await liveViewLink(browser, bot), browser);
    const closed = new Promise((resolve) => signedOut.socket.once("close", resolve));
    await browser.post("/api/auth/sign-out");
    await closed;

    const other = await signedInBrowser();
    const otherBot = await createBot(other);
    await other.post(`/api/bots/${otherBot.id}/computer`);
    const deleted = await watch(await liveViewLink(other, otherBot), other);
    const deletedClosed = new Promise((resolve) => deleted.socket.once("close", resolve));
    await deleteRequest(other, `/api/bots/${otherBot.id}/computer`);
    await deletedClosed;
  });

  test("a Computer that is shut down can't be watched", async () => {
    const browser = await signedInBrowser();
    const bot = await createBot(browser);
    await browser.post(`/api/bots/${bot.id}/computer`);
    await browser.post(`/api/bots/${bot.id}/computer/shut-down`);

    const response = await browser.post(`/api/bots/${bot.id}/computer/live-view`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "computer_not_running" } });
  });

  test("a live-view link opens only with its Customer's session, on our own page, and as the Computer service issued it", async () => {
    const owner = await signedInBrowser();
    const bot = await createBot(owner);
    await owner.post(`/api/bots/${bot.id}/computer`);
    const link = await liveViewLink(owner, bot);

    await expect(watch(link, null)).rejects.toThrow("refused 401");
    await expect(watch(link, owner, "https://evil.example")).rejects.toThrow("refused 403");
    await expect(watch(link, await signedInBrowser())).rejects.toThrow("refused 404");
    await expect(watch(link.replace(/token=[^&]+/, "token=made-up"), owner)).rejects.toThrow("refused 403");
  });
});
