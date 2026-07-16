import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  root: "frontend",
  plugins: [react(), cloudflare({ configPath: "../wrangler.jsonc" })],
  build: {
    outDir: "../web",
    emptyOutDir: true,
    assetsDir: "assets",
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:5177",
    },
  },
});
