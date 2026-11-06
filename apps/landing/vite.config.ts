import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The landing page is a static site on GitHub Pages (kovobot.com). Its waitlist
// form posts to the API at VITE_APP_URL, set at build time. In development,
// /api is forwarded to the local API instead.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  return {
    plugins: [react()],
    envDir: "../..",
    server: {
      port: 5174,
      strictPort: true,
      proxy: { "/api": env.API_URL || "http://localhost:3000" },
    },
  };
});
