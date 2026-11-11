import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("the server boots with an empty environment", async () => {
  // Nothing set but PORT=0, so the test picks a free port. Windows needs SystemRoot to open sockets.
  const env: Record<string, string> = { PORT: "0" };
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const server = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "pipe", "pipe"] });

  try {
    const port = await new Promise<string>((resolve, reject) => {
      let output = "";
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        const listening = /listening on http:\/\/localhost:(\d+)/.exec(output);
        if (listening) resolve(listening[1]!);
      };
      server.stdout.on("data", collect);
      server.stderr.on("data", collect);
      server.on("exit", (code) => reject(new Error(`server exited with ${code}:\n${output}`)));
    });

    const health = await fetch(`http://localhost:${port}/api/healthz`);
    expect(health.status).toBe(200);
  } finally {
    server.kill();
  }
  // About 5 seconds alone; with every other test file running beside it, a cold start can take 20.
}, 45_000);
