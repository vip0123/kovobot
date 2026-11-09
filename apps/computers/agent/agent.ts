// The Computer agent: our own software inside each Computer. It carries out the Driver
// model's actions with xdotool, takes screenshots with scrot, and streams the live view
// from the Computer's VNC server, which listens only inside the Computer. Only the
// Computer service calls it, presenting the token it gave this one Computer. No
// dependencies: the image copies this one file and Node runs it as it is.
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const token = process.env.KOVOBOT_AGENT_TOKEN ?? "";
/** Where the Computer service reaches the agent (AGENT_PORT in src/backend.ts). */
const port = 4000;
/** Where start.sh starts the VNC server, inside the Computer only. */
const vncPort = 5900;
/** The virtual display start.sh starts (Xvfb :1 -screen 0 1280x800x24). */
const SCREEN = { width: 1280, height: 800 };
// Screenshots go to a folder only root can enter, made fresh at start: /tmp is shared with
// the desktop, where a planted file or link could forge a screenshot or redirect root's write.
const SCREENSHOT_PATH = join(mkdtempSync(join(tmpdir(), "kovobot-agent-")), "screen.png");
/** Text is typed this many characters at a time, so no one xdotool run outlasts its time limit. */
const TYPE_CHUNK = 200;
if (token.length < 32) {
  console.error("KOVOBOT_AGENT_TOKEN must be set by the Computer service (at least 32 characters).");
  process.exit(1);
}

const digest = (value: string) => createHash("sha256").update(value).digest();
const expected = digest(token);

function authorised(header: string | undefined): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(digest(presented), expected);
}

/** Runs a display program with arguments, never through a shell. */
function run(program: "xdotool" | "scrot", args: Array<string | number>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(program, args.map(String), { env: { PATH: process.env.PATH, DISPLAY: ":1" }, timeout: 15_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

type Point = [number, number];
const BUTTONS = { left: 1, middle: 2, right: 3 } as const;
/** xdotool key combinations: key names joined by "+", such as ctrl+shift+t or Return. */
const KEYS = /^[A-Za-z0-9_]{1,30}(\+[A-Za-z0-9_]{1,30}){0,4}$/;

class InvalidAction extends Error {}

const isPoint = (x: unknown, y: unknown) =>
  Number.isInteger(x) && Number.isInteger(y) && (x as number) >= 0 && (y as number) >= 0 && (x as number) < SCREEN.width && (y as number) < SCREEN.height;
function point(x: unknown, y: unknown): Point {
  if (!isPoint(x, y)) throw new InvalidAction(`Points are whole pixels on the ${SCREEN.width}x${SCREEN.height} screen.`);
  return [x as number, y as number];
}
function button(name: unknown): number {
  const number = BUTTONS[name as keyof typeof BUTTONS];
  if (!number) throw new InvalidAction("The button is left, middle or right.");
  return number;
}
function whole(value: unknown, min: number, max: number, what: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new InvalidAction(`${what} is a whole number from ${min} to ${max}.`);
  }
  return value as number;
}

/** Runs `work` with modifier keys (such as "shift" or "ctrl+shift") held down. */
async function holding(modifiers: unknown, work: () => Promise<unknown>): Promise<void> {
  if (modifiers === undefined || modifiers === "") {
    await work();
    return;
  }
  if (typeof modifiers !== "string" || !KEYS.test(modifiers)) throw new InvalidAction("Modifiers are key names joined by +, such as shift.");
  await run("xdotool", ["keydown", "--", modifiers]);
  try {
    await work();
  } finally {
    await run("xdotool", ["keyup", "--", modifiers]);
  }
}

/** Carries out one action from the common set every Driver model's actions map onto. */
async function act(action: Record<string, unknown>): Promise<object> {
  switch (action.type) {
    case "move":
      await run("xdotool", ["mousemove", ...point(action.x, action.y)]);
      return {};
    case "click": {
      const count = whole(action.count ?? 1, 1, 3, "The click count");
      const at = action.x === undefined && action.y === undefined ? [] : ["mousemove", ...point(action.x, action.y)];
      await holding(action.modifiers, () => run("xdotool", [...at, "click", "--repeat", count, "--delay", 80, button(action.button ?? "left")]));
      return {};
    }
    case "mouse_down":
    case "mouse_up":
      await run("xdotool", [action.type === "mouse_down" ? "mousedown" : "mouseup", button(action.button ?? "left")]);
      return {};
    case "drag": {
      const path = Array.isArray(action.path) ? action.path : [];
      if (path.length < 2 || path.length > 100) throw new InvalidAction("A drag goes along 2 to 100 points.");
      const points = path.map((step) => (Array.isArray(step) ? point(step[0], step[1]) : point(null, null)));
      await run("xdotool", ["mousemove", ...points[0]!]);
      await run("xdotool", ["mousedown", 1]);
      for (const next of points.slice(1)) await run("xdotool", ["mousemove", ...next]);
      await run("xdotool", ["mouseup", 1]);
      return {};
    }
    case "type": {
      if (typeof action.text !== "string" || action.text.length < 1 || action.text.length > 10_000) {
        throw new InvalidAction("Typing takes 1 to 10,000 characters of text.");
      }
      for (let at = 0; at < action.text.length; at += TYPE_CHUNK) {
        await run("xdotool", ["type", "--delay", 12, "--", action.text.slice(at, at + TYPE_CHUNK)]);
      }
      return {};
    }
    case "keys": {
      if (typeof action.keys !== "string" || !KEYS.test(action.keys)) throw new InvalidAction("Keys are names joined by +, such as ctrl+c.");
      await run("xdotool", ["key", "--clearmodifiers", "--", action.keys]);
      return {};
    }
    case "scroll": {
      const dx = whole(action.dx ?? 0, -50, 50, "dx");
      const dy = whole(action.dy ?? 0, -50, 50, "dy");
      if (action.x !== undefined || action.y !== undefined) await run("xdotool", ["mousemove", ...point(action.x, action.y)]);
      // Wheel buttons: 4 up, 5 down, 6 left, 7 right; one click per step.
      await holding(action.modifiers, async () => {
        if (dy !== 0) await run("xdotool", ["click", "--repeat", Math.abs(dy), "--delay", 30, dy < 0 ? 4 : 5]);
        if (dx !== 0) await run("xdotool", ["click", "--repeat", Math.abs(dx), "--delay", 30, dx < 0 ? 6 : 7]);
      });
      return {};
    }
    case "wait":
      await sleep(whole(action.ms, 0, 10_000, "The wait in milliseconds"));
      return {};
    case "cursor_position": {
      const shell = await run("xdotool", ["getmouselocation", "--shell"]);
      const value = (name: string) => Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(shell)?.[1] ?? 0);
      return { cursor: { x: value("X"), y: value("Y") } };
    }
    default:
      throw new InvalidAction("Actions are move, click, mouse_down, mouse_up, drag, type, keys, scroll, wait and cursor_position.");
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new InvalidAction("An action is at most 64 KB.");
    chunks.push(chunk as Buffer);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function json(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.url === "/healthz") {
    response.end("ok");
    return;
  }
  if (!authorised(request.headers.authorization)) return json(response, 401, { error: { code: "unauthorized", message: "Present this Computer's token." } });
  if (request.method === "GET" && request.url === "/screenshot") {
    await run("scrot", ["--overwrite", SCREENSHOT_PATH]);
    response.writeHead(200, { "content-type": "image/png" }).end(await readFile(SCREENSHOT_PATH));
    return;
  }
  if (request.method === "POST" && request.url === "/actions") {
    try {
      return json(response, 200, await act(await readJson(request)));
    } catch (error) {
      if (error instanceof InvalidAction || error instanceof SyntaxError) {
        return json(response, 400, { error: { code: "invalid_action", message: error.message } });
      }
      throw error;
    }
  }
  response.writeHead(404).end();
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: { code: "action_failed", message: "The Computer couldn't do that." } });
  });
});

// GET /live with "Upgrade: vnc" becomes a byte-for-byte tunnel to the VNC server.
server.on("upgrade", (request, socket, head) => {
  const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  if (request.url !== "/live" || request.headers.upgrade?.toLowerCase() !== "vnc") return refuse("404 Not Found");
  if (!authorised(request.headers.authorization)) return refuse("401 Unauthorized");

  const vnc = connect(vncPort, "127.0.0.1");
  let connected = false;
  vnc.once("connect", () => {
    connected = true;
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: vnc\r\nConnection: Upgrade\r\n\r\n");
    if (head.length > 0) vnc.write(head);
    vnc.pipe(socket);
    socket.pipe(vnc);
  });
  vnc.on("error", () => (connected ? socket.destroy() : refuse("503 Service Unavailable")));
  vnc.on("close", () => socket.destroy());
  socket.on("error", () => vnc.destroy());
  socket.on("close", () => vnc.destroy());
});

server.listen(port, "0.0.0.0", () => console.info(`Computer agent listening on ${port}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
