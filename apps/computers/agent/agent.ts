// The Computer agent: our own software inside each Computer. It streams the live view
// from the Computer's VNC server, which listens only inside the Computer; carrying out
// the Driver model's actions comes with ticket 24. Only the Computer service calls it,
// presenting the token it gave this one Computer. No dependencies: the image copies
// this one file and Node runs it as it is.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";

const token = process.env.KOVOBOT_AGENT_TOKEN ?? "";
const port = Number(process.env.KOVOBOT_AGENT_PORT ?? 4000);
const vncPort = Number(process.env.KOVOBOT_VNC_PORT ?? 5900);
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

const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.end("ok");
    return;
  }
  response.writeHead(404).end();
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
