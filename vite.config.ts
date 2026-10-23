import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * pdf.js needs a few data files at runtime: fonts for PDFs that don't include
 * their own, character maps for Chinese, Japanese and Korean text, and image
 * decoders. They are served from the app itself under /pdfjs/, so nothing is ever
 * fetched from another site. (Its script-in-PDF engine is left out on purpose.)
 */
const PDFJS = here("node_modules/pdfjs-dist");
const PDFJS_DIRS = ["standard_fonts", "cmaps", "wasm", "iccs"];
const PDFJS_SKIP = /^quickjs/;

function pdfjsFiles(): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const dir of PDFJS_DIRS) {
    for (const file of readdirSync(join(PDFJS, dir)).sort()) {
      if (PDFJS_SKIP.test(file)) continue;
      const path = join(PDFJS, dir, file);
      if (statSync(path).isFile()) out.push({ name: `pdfjs/${dir}/${file}`, path });
    }
  }
  // pdf.js's own license (Apache 2.0), served beside its files.
  out.push({ name: "pdfjs/LICENSE", path: join(PDFJS, "LICENSE") });
  return out;
}

const TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
};

function pdfjsData(): Plugin {
  return {
    name: "column-reader-pdfjs-data",
    configureServer(server) {
      const files = new Map(pdfjsFiles().map((f) => [`/${f.name}`, f.path]));
      server.middlewares.use((req, res, next) => {
        const path = files.get((req.url ?? "").split("?")[0]);
        if (!path) return next();
        res.setHeader("Content-Type", TYPES[extname(path)] ?? "application/octet-stream");
        res.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const f of pdfjsFiles()) this.emitFile({ type: "asset", fileName: f.name, source: readFileSync(f.path) });
    },
  };
}

/**
 * Writes dist/sw.js: the worker logic from src/sw/worker.js plus the exact list of
 * built files, so the whole app is cached on first visit and keeps working offline.
 * The cache name is a hash of every cached file's contents, so changing anything
 * (even an icon) ships a new cache. Hand-rolled to avoid a plugin dependency.
 */
function serviceWorker(): Plugin {
  const publicFiles = ["manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];
  return {
    name: "column-reader-sw",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const hash = createHash("sha256");
      const built = Object.keys(bundle)
        .filter((f) => !f.endsWith(".map"))
        .sort();
      for (const name of built) {
        const item = bundle[name];
        hash.update(name);
        hash.update(item.type === "chunk" ? item.code : item.source);
      }
      for (const name of publicFiles) {
        hash.update(name);
        hash.update(readFileSync(here(`public/${name}`)));
      }
      const workerSource = readFileSync(here("src/sw/worker.js"), "utf8").replace(/^export /gm, "");
      hash.update(workerSource);

      const precache = [
        "/",
        ...built.filter((f) => f !== "index.html").map((f) => `/${f}`),
        ...publicFiles.map((f) => `/${f}`),
      ];
      const config = { cacheName: `column-reader-${hash.digest("hex").slice(0, 12)}`, precache };
      const source = `// Generated at build time from src/sw/worker.js.\n${workerSource}\nregisterWorker(self, ${JSON.stringify(config)});\n`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [pdfjsData(), serviceWorker()],
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  worker: { format: "es" },
});
