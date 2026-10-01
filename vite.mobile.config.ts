// The native iPhone app's frontend (src/mobile/ in the Tauri iOS shell; shelved — the phone app is
// the web app now, vite.web.config.ts).
//   npm run build:mobile  → dist-mobile/index.html (tauri.ios.conf.json's frontendDist)
//   npm run dev:mobile    → http://localhost:1430, with the mock backend in a browser (phone-sized
//                           window) or the Simulator/iPhone via `tauri ios dev`
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { pageAsIndex } from "./vite.pages";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss(), pageAsIndex("mobile.html")],
  publicDir: false,
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2022",
    outDir: "dist-mobile",
    emptyOutDir: true,
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: { input: "mobile.html" },
  },
});
