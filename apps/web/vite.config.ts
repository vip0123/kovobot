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
      proxy: { "/api": env.API_URL || "http://localhost:3000" },
    },
  };
});
