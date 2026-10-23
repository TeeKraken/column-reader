import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module without type declarations
import { registerWorker, shellAssets } from "./worker.js";

const ORIGIN = "https://reader.test";
const key = (r: Request | string) => new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;

/** The network: what the server has deployed, and whether we're online. */
const net = {
  online: true,
  files: new Map<string, string>(),
  fail: new Set<string>(),
  async fetch(path: string): Promise<Response> {
    if (!this.online || this.fail.has(path)) throw new TypeError("Failed to fetch");
    const body = this.files.get(path);
    if (body === undefined) return new Response("404: NOT_FOUND", { status: 404 });
    if (body === "500") return new Response("server error", { status: 500 });
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  },
};

/** In-memory Cache Storage, shared by every worker version (as in a real browser). */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  return {
    stores,
    keys: async () => [...stores.keys()],
    delete: async (n: string) => stores.delete(n),
    open: async (n: string) => {
      if (!stores.has(n)) stores.set(n, new Map());
      const m = stores.get(n)!;
      return {
        match: async (r: Request | string) => m.get(key(r))?.clone(),
        put: async (r: Request | string, res: Response) => void m.set(key(r), res),
        addAll: async (reqs: (Request | string)[]) => {
          // Like the real addAll: all or nothing.
          const got: [string, Response][] = [];
          for (const r of reqs) {
            const res = await net.fetch(key(r));
            if (!res.ok) throw new TypeError(`bad response for ${key(r)}`);
            got.push([key(r), res]);
          }
          for (const [k, v] of got) m.set(k, v);
        },
      };
    },
  };
}

const page = (version: string) =>
  `<html><head><title>${version} shell</title><script type="module" crossorigin src="/assets/${version}.js"></script>` +
  `<link rel="stylesheet" crossorigin href="/assets/${version}.css"><link rel="manifest" href="/manifest.webmanifest"></head></html>`;

function deploy(version: string) {
  net.files = new Map([
    ["/", page(version)],
    [`/assets/${version}.js`, `${version} script`],
    [`/assets/${version}.css`, `${version} styles`],
  ]);
  return { cacheName: `reader-${version}`, precache: ["/", `/assets/${version}.js`, `/assets/${version}.css`] };
}

/** One worker version, registered against the shared caches. */
function worker(caches: ReturnType<typeof fakeCaches>, config: { cacheName: string; precache: string[] }) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const scope = {
    location: { origin: ORIGIN },
    fetch: (r: Request | string) => net.fetch(key(r)),
    skipWaiting: async () => {
      takeovers.push("skipWaiting");
    },
    clients: {
      claim: async () => {
        takeovers.push("claim");
        for (const c of pages) c.controlled = true;
      },
      matchAll: async (opts: { includeUncontrolled?: boolean } = {}) =>
        pages.filter((c) => opts.includeUncontrolled || c.controlled).map((c) => ({ id: c.id })),
    },
    caches,
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
  };
  registerWorker(scope, config);
  async function dispatch(type: string, request?: unknown, extra: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    listeners[type]({
      ...extra,
      request,
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      respondWith: (p: Promise<Response>) => (response = p),
    });
    await Promise.all(pending);
    return response ? await response : undefined;
  }
  return {
    install: () => dispatch("install"),
    activate: () => dispatch("activate"),
    // Node won't construct a Request with mode "navigate", so use a request-like object.
    navigate: (path: string) =>
      dispatch("fetch", { url: ORIGIN + path, method: "GET", mode: "navigate" }) as Promise<Response>,
    get: (path: string) => dispatch("fetch", new Request(ORIGIN + path)) as Promise<Response>,
    /** A page asks to be covered, listing the files it loaded. */
    ask: (id: string, assets: unknown) =>
      dispatch("message", undefined, { data: { type: "claim-if-same-release", assets }, source: { id } }),
  };
}

/** Calls that would let a new version take over pages of an old one. */
const takeovers: string[] = [];
/** Open pages (window clients) and whether a service worker covers them. */
const pages: { id: string; controlled: boolean }[] = [];

function reset() {
  takeovers.length = 0;
  pages.length = 0;
  net.online = true;
  net.fail.clear();
}

describe("shellAssets", () => {
  it("lists this site's scripts and stylesheets, not other links or other sites", () => {
    const html =
      page("v9") +
      '<link rel="icon" href="/icon.svg"><script src="https://cdn.example/x.js"></script><link rel=modulepreload href="/assets/chunk.js">';
    expect(shellAssets(html, ORIGIN)).toEqual(["/assets/v9.js", "/assets/v9.css", "/assets/chunk.js"]);
  });
});

describe("service worker", () => {
  it("serves the installed shell and its files offline", async () => {
    reset();
    const caches = fakeCaches();
    const v1 = worker(caches, deploy("v1"));
    await v1.install();
    await v1.activate();
    net.online = false;
    expect(await (await v1.navigate("/")).text()).toContain("v1 shell");
    expect(await (await v1.get("/assets/v1.js")).text()).toBe("v1 script");
  });

  it("passes 404 and 500 pages through without touching the offline shell", async () => {
    reset();
    const caches = fakeCaches();
    const v1 = worker(caches, deploy("v1"));
    await v1.install();
    expect((await v1.navigate("/missing")).status).toBe(404);
    // The app's page itself always comes from the installed copy, even if the server errors.
    net.files.set("/", "500");
    expect(await (await v1.navigate("/")).text()).toContain("v1 shell");
    net.online = false;
    const offline = await v1.navigate("/");
    expect(offline.status).toBe(200);
    expect(await offline.text()).toContain("v1 shell");
  });

  it("keeps the old version working offline when a new version's install is interrupted", async () => {
    reset();
    const caches = fakeCaches();
    const v1 = worker(caches, deploy("v1"));
    await v1.install();
    await v1.activate();

    // A new release goes live. v1 keeps serving its own page (never v2's page with v1's files).
    const v2config = deploy("v2");
    expect(await (await v1.navigate("/")).text()).toContain("v1 shell");

    // v2's install fails part-way (the connection drops while fetching its script).
    net.fail.add("/assets/v2.js");
    const v2 = worker(caches, v2config);
    await expect(v2.install()).rejects.toThrow();

    // Offline, v1 still serves its own shell, which loads a script it has.
    net.online = false;
    expect(await (await v1.navigate("/")).text()).toContain("v1 shell");
    expect(await (await v1.get("/assets/v1.js")).text()).toBe("v1 script");
  });

  it("switches to the new version only after it installed completely", async () => {
    reset();
    const caches = fakeCaches();
    const v1 = worker(caches, deploy("v1"));
    await v1.install();
    await v1.activate();
    const v2 = worker(caches, deploy("v2"));
    await v2.install();
    await v2.activate();
    expect([...caches.stores.keys()]).toEqual(["reader-v2"]);
    net.online = false;
    expect(await (await v2.navigate("/")).text()).toContain("v2 shell");
    expect(await (await v2.get("/assets/v2.js")).text()).toBe("v2 script");
  });

  it("refuses to install when the page comes from another release, even if every file loads", async () => {
    reset();
    const caches = fakeCaches();
    const v1 = worker(caches, deploy("v1"));
    await v1.install();
    await v1.activate();

    // Mid-deploy: v2's worker and files are live, but "/" already serves v3's page (all 200s).
    const v2config = deploy("v2");
    net.files.set("/", page("v3"));
    const v2 = worker(caches, v2config);
    await expect(v2.install()).rejects.toThrow(/another release/);
    expect([...caches.stores.get("reader-v2")?.keys() ?? []]).not.toContain("/");

    // The old worker and its cache stay in charge, and still work offline.
    net.online = false;
    expect(await (await v1.navigate("/")).text()).toContain("v1 shell");
    expect(await (await v1.get("/assets/v1.js")).text()).toBe("v1 script");
  });

  it("refuses an older page too (a new worker fetching the previous release's page)", async () => {
    reset();
    const caches = fakeCaches();
    const v2config = deploy("v2");
    net.files.set("/", page("v1"));
    net.files.set("/assets/v1.js", "v1 script");
    await expect(worker(caches, v2config).install()).rejects.toThrow(/another release/);
  });

  it("never takes over open pages: an old page still gets its own lazily loaded files", async () => {
    reset();
    const caches = fakeCaches();
    // v1 lists a file its page only loads later (the pdf.js worker).
    const v1config = deploy("v1");
    net.files.set("/assets/v1-worker.js", "v1 pdf worker");
    v1config.precache.push("/assets/v1-worker.js");
    const v1 = worker(caches, v1config);
    await v1.install();
    await v1.activate();

    // v2 is deployed (v1's files are gone from the server) and installs while a
    // v1 page is still open. It must wait: no skipWaiting, no claim.
    const v2 = worker(caches, deploy("v2"));
    await v2.install();
    expect(takeovers).toEqual([]);
    expect([...caches.stores.keys()].sort()).toEqual(["reader-v1", "reader-v2"]);

    // The open v1 page now starts its PDF worker: still served, from v1's cache.
    const res = await v1.get("/assets/v1-worker.js");
    expect(await res.text()).toBe("v1 pdf worker");

    // Once v1's pages are closed the browser activates v2, which then cleans up.
    await v2.activate();
    expect(takeovers).toEqual([]);
    expect([...caches.stores.keys()]).toEqual(["reader-v2"]);
  });

  it("gives a new tab the open version's page and files while an update waits", async () => {
    reset();
    const caches = fakeCaches();
    const v1config = deploy("v1");
    // A data file whose path doesn't change between versions (a pdf.js decoder).
    net.files.set("/pdfjs/wasm/decoder.wasm", "v1 decoder");
    v1config.precache.push("/pdfjs/wasm/decoder.wasm");
    const v1 = worker(caches, v1config);
    await v1.install();
    await v1.activate();

    const v2config = deploy("v2");
    net.files.set("/pdfjs/wasm/decoder.wasm", "v2 decoder");
    v2config.precache.push("/pdfjs/wasm/decoder.wasm");
    await worker(caches, v2config).install(); // waiting: an old tab is still open

    // A new tab (or a reload) under v1: v1's page, so the files it then asks for
    // (from v1's cache) all belong to the same version.
    const shell = await (await v1.navigate("/")).text();
    expect(shell).toContain("v1 shell");
    expect(shell).not.toContain("v2");
    expect(await (await v1.get("/assets/v1.js")).text()).toBe("v1 script");
    expect(await (await v1.get("/pdfjs/wasm/decoder.wasm")).text()).toBe("v1 decoder");
  });

  it("covers a first-visit page right after installing, only if it is the same version", async () => {
    reset();
    const caches = fakeCaches();
    const v1 = worker(caches, deploy("v1"));
    pages.push({ id: "tab-a", controlled: false });
    await v1.install();
    await v1.activate();
    expect(takeovers).toEqual([]);

    // A page of another version asks: refused.
    await v1.ask("tab-a", ["/assets/v0.js", "/assets/v0.css"]);
    expect(takeovers).toEqual([]);
    // Nonsense is refused too.
    await v1.ask("tab-a", "not a list");
    await v1.ask("tab-a", []);
    expect(takeovers).toEqual([]);

    // The same version: taken over, so it now works offline without a reload.
    await v1.ask("tab-a", ["/assets/v1.js", "/assets/v1.css"]);
    expect(takeovers).toEqual(["claim"]);
  });

  it("doesn't take over while another uncovered page hasn't shown it's the same version", async () => {
    reset();
    const caches = fakeCaches();
    const v1 = worker(caches, deploy("v1"));
    pages.push({ id: "tab-a", controlled: false }, { id: "tab-b", controlled: false });
    await v1.install();
    await v1.activate();
    await v1.ask("tab-a", ["/assets/v1.js"]);
    expect(takeovers).toEqual([]); // tab-b might be another version
    await v1.ask("tab-b", ["/assets/v1.js", "/assets/v1.css"]);
    expect(takeovers).toEqual(["claim"]);
  });
});
