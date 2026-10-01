// The iPhone app's frontend (src/mobile/), in the Tauri iOS shell.
//   npm run build:mobile  → dist-mobile/index.html (tauri.ios.conf.json's frontendDist)
//   npm run dev:mobile    → http://localhost:1430, with the mock backend in a browser (phone-sized
//                           window) or the Simulator/iPhone via `tauri ios dev`
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

/** The iOS shell loads "/" (dev) and index.html (built): both are mobile.html here. */
function mobileIndex(): Plugin {
  return {
    name: "mobile-index",
    // After Vite's own HTML plugin has added the page to the bundle.
    enforce: "post",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === "/" || req.url === "/index.html") req.url = "/mobile.html";
        next();
      });
    },
    generateBundle(_options, bundle) {
      const page = bundle["mobile.html"];
      if (page) page.fileName = "index.html";
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mobileIndex()],
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
