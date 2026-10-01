// Serves and builds a page as the app's index: the iOS shell and the server both load "/" (and
// index.html once built).
import type { Plugin } from "vite";

export function pageAsIndex(page: string): Plugin {
  return {
    name: "page-as-index",
    // After Vite's own HTML plugin has added the page to the bundle.
    enforce: "post",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === "/" || req.url === "/index.html") req.url = `/${page}`;
        next();
      });
    },
    generateBundle(_options, bundle) {
      const built = bundle[page];
      if (built) built.fileName = "index.html";
    },
  };
}
