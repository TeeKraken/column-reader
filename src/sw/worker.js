// Service worker logic. Plain JavaScript with no imports so the build can inline it
// into /sw.js as-is (the `export` keywords are stripped there). Tested in worker.test.ts.

/**
 * The one page this app has. Each version's copy is cached at install, together
 * with the exact files it loads, and never replaced afterwards: the offline copy
 * always matches the cached scripts and styles. A new version gets its own cache,
 * which is used only once that version installed completely.
 */
export const SHELL = "/";

/**
 * The scripts and stylesheets a page loads from this site, as paths ("/assets/index-abc.js").
 * @param {string} html
 * @param {string} origin
 */
export function shellAssets(html, origin) {
  const out = new Set();
  const tags = html.match(/<(script|link)\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const isScript = /^<script/i.test(tag);
    if (!isScript && !/\brel\s*=\s*["']?(stylesheet|modulepreload)\b/i.test(tag)) continue;
    const m = tag.match(isScript ? /\bsrc\s*=\s*["']([^"']+)["']/i : /\bhref\s*=\s*["']([^"']+)["']/i);
    if (!m) continue;
    const url = new URL(m[1], origin + "/");
    if (url.origin === origin) out.add(url.pathname);
  }
  return [...out];
}

/**
 * Caches one release: its page and the exact files that page loads. During a
 * deploy, "/" can come from a different release than this worker's files. So the
 * page is fetched first and checked: if it loads any script or stylesheet that
 * isn't in this worker's own list, the install fails and the previous worker and
 * its cache stay in charge. The page is stored only after all its files are.
 */
export async function installRelease(scope, cacheName, precache) {
  const fresh = (u) => new Request(new URL(u, scope.location.origin).href, { cache: "reload" });
  const res = await scope.fetch(fresh(SHELL));
  if (!res.ok) throw new TypeError(`The page returned ${res.status}`);
  const html = await res.clone().text();
  const listed = new Set(precache);
  const foreign = shellAssets(html, scope.location.origin).filter((p) => !listed.has(p));
  if (foreign.length) throw new TypeError(`The page is from another release (loads ${foreign.join(", ")})`);
  const cache = await scope.caches.open(cacheName);
  await cache.addAll(precache.filter((u) => u !== SHELL).map(fresh));
  await cache.put(SHELL, res);
}

/**
 * @param {any} scope  the service worker global (self), or a fake in tests
 * @param {{ cacheName: string, precache: string[] }} config
 */
export function registerWorker(scope, config) {
  const { cacheName, precache } = config;

  // No skipWaiting() and no clients.claim(): a new version waits until every page
  // of the old one is closed. An open page keeps loading files lazily (the pdf.js
  // worker, its fonts and decoders), and they must come from its own release; the
  // old worker and its cache stay in charge of that page until it goes away.
  scope.addEventListener("install", (event) => {
    event.waitUntil(installRelease(scope, cacheName, precache));
  });

  // Runs only once no page uses an older version, so old caches can go.
  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      scope.caches
        .keys()
        .then((keys) => Promise.all(keys.filter((k) => k !== cacheName).map((k) => scope.caches.delete(k)))),
    );
  });

  scope.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET" || new URL(req.url).origin !== scope.location.origin) return;
    if (req.mode === "navigate") {
      event.respondWith(handleNavigation(scope, cacheName, req));
      return;
    }
    // ignoreVary: a module script asks with an Origin header, the precache didn't.
    event.respondWith(
      scope.caches
        .open(cacheName)
        .then((c) => c.match(req, { ignoreVary: true }))
        .then((hit) => hit || scope.fetch(req)),
    );
  });
}

/**
 * Network first, so people get updates. The network response is passed through
 * as it is and never cached here: the offline copy stays the one installed with
 * this version's files. With no network, that copy is served.
 */
export async function handleNavigation(scope, cacheName, req) {
  try {
    return await scope.fetch(req);
  } catch {
    const cache = await scope.caches.open(cacheName);
    const hit = await cache.match(SHELL, { ignoreVary: true });
    return hit || Response.error();
  }
}
