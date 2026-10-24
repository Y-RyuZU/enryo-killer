import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api は wrangler dev (8787) にプロキシ。スマホから LAN IP で開いても同一オリジンで動く
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true, changeOrigin: true } },
  },
});
