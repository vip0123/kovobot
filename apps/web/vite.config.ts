import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The web app always calls the API on its own origin under /api. In
// development Vite forwards /api to API_URL; deployed, the API serves this build.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  return {
    plugins: [react()],
    envDir: "../..",
    server: {
      port: 5173,
      strictPort: true,
      // ws: a Computer's live view comes in as a WebSocket under /api.
      proxy: { "/api": { target: env.API_URL || "http://localhost:3000", ws: true } },
    },
  };
});
