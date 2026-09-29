// The phone web app, served by the push daemon (crates/chm-daemon) over the tailnet.
//   npm run build:phone   → dist-phone/, built into the daemon binary
//   npm run dev:phone     → http://localhost:5174, with /api proxied to a daemon on 127.0.0.1:8787
//                           (give it "ownerLogins": ["dev"] and "allowOrigins": ["http://localhost:5174"])
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: "phone-public",
  clearScreen: false,
  build: {
    target: "es2022",
    outDir: "dist-phone",
    emptyOutDir: true,
    rollupOptions: { input: "phone.html" },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", headers: { "Tailscale-User-Login": "dev" } },
    },
  },
});
