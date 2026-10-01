// The phone app: the src/mobile/ UI as a Home Screen web app, served by the Consuls server
// (crates/chm-daemon), which builds dist-web/ into its binary.
//   npm run build:web  → dist-web/index.html (+ web-public/: manifest, icons, service worker)
//   npm run dev:web    → http://localhost:5174, with /api (the WebSocket too) proxied to a server
//                        on 127.0.0.1:8787 (or $CONSULS_DEV_SERVER): give it web.listen, ownerLogins
//                        ["dev"], allowOrigins ["http://localhost:5174"] and tailscaleServe false
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { pageAsIndex } from "./vite.pages";

export default defineConfig({
  plugins: [react(), tailwindcss(), pageAsIndex("web.html")],
  publicDir: "web-public",
  clearScreen: false,
  define: { "import.meta.env.VITE_CONSULS_WEB": JSON.stringify("1") },
  build: {
    target: "es2022",
    outDir: "dist-web",
    emptyOutDir: true,
    rollupOptions: { input: "web.html" },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": { target: process.env.CONSULS_DEV_SERVER ?? "http://127.0.0.1:8787", ws: true, headers: { "Tailscale-User-Login": "dev" } },
    },
  },
});
