// Stands in for the Computer's VNC server: greets as VNC servers do, then echoes.
import { createServer } from "node:net";

createServer((socket) => {
  socket.write("RFB 003.008\n");
  socket.on("data", (data) => socket.write(data));
  socket.on("error", () => socket.destroy());
}).listen(5900, "127.0.0.1");
