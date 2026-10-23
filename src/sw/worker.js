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

  // No skipWaiting(), and no blanket clients.claim() (only claimIfSameRelease, below):
  // a new version waits until every page of the old one is closed. An open page keeps loading files lazily (the pdf.js
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

  const sameRelease = new Set();
  scope.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "claim-if-same-release" || !event.source) return;
    event.waitUntil(claimIfSameRelease(scope, precache, sameRelease, event.source.id, data.assets));
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
 * The app's page is always answered from this version's own cache, even online,
 * so a page always matches the worker serving its files: a new tab opened while
 * an update waits gets the same version as the tabs already open, never a newer
 * page mixed with older files. The new version takes over once every page of the
 * old one is closed. Other paths go to the network as they are.
 */
export async function handleNavigation(scope, cacheName, req) {
  const path = new URL(req.url).pathname;
  if (path === SHELL || path === "/index.html") {
    const cache = await scope.caches.open(cacheName);
    const hit = await cache.match(SHELL, { ignoreVary: true });
    if (hit) return hit;
  }
  try {
    return await scope.fetch(req);
  } catch {
    const cache = await scope.caches.open(cacheName);
    const hit = await cache.match(SHELL, { ignoreVary: true });
    return hit || Response.error();
  }
}

/**
 * First visit: the page loaded before this worker was installed, so it isn't
 * covered by the offline cache until it's taken over. The page asks, listing the
 * scripts and stylesheets it loaded. The worker takes over only when every open
 * page not yet covered has asked and loads only files of this very version (file
 * names carry a hash of their contents), so it never takes over a page of another
 * version. Returns whether it took over.
 * @param {any} scope
 * @param {string[]} precache
 * @param {Set<string>} sameRelease  ids of pages known to be this version
 * @param {string} clientId
 * @param {unknown} assets
 */
export async function claimIfSameRelease(scope, precache, sameRelease, clientId, assets) {
  const listed = new Set(precache);
  const ok = Array.isArray(assets) && assets.length > 0 && assets.every((a) => typeof a === "string" && listed.has(a));
  if (!ok) return false;
  sameRelease.add(clientId);
  const all = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  const covered = new Set((await scope.clients.matchAll({ type: "window" })).map((c) => c.id));
  if (all.some((c) => !covered.has(c.id) && !sameRelease.has(c.id))) return false;
  await scope.clients.claim();
  return true;
}
