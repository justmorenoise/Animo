import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  // Served from a subdirectory when it is embedded in a site (morenoise.it
  // puts it under /apps/animo/app/); "/" everywhere else, including `npm run
  // dev`. An absolute base and not "./": a relative one resolves against the
  // document URL, and a host that strips the trailing slash would then look
  // for the assets one directory up.
  base: process.env.ANIMO_BASE ?? "/",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // The About dialog is the only reader. Injected rather than imported so the
  // bundle does not carry package.json, and so `vitest` (which does not run
  // this config's define) can fall back — see `core/about.ts`.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5180, open: false },
  // ES workers can share chunks with the page (the resampler, ag-psd) and
  // load their own imports on demand; the IIFE default cannot split.
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // The preview is a separate document so the vendored runtime keeps
        // the global PIXI it expects, entirely out of the editor bundle.
        preview: fileURLToPath(new URL("./preview.html", import.meta.url)),
      },
    },
  },
});
