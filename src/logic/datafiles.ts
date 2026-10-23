// Loading pdf.js's data files (character maps, fonts, decoders) for one
// document, noting any failure. Tested in datafiles.test.ts.

type DataKind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl";
type DataUrls = { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null };

/**
 * A pdf.js data-file loader for one document, recording failures in `state`.
 * Files are loaded on the page itself (not inside the pdf.js worker), so they
 * go through the page's service worker.
 */
export function dataFactoryFor(state: { failed: boolean }, fetchFn: typeof fetch = (...a) => fetch(...a)) {
  return class AppDataFactory {
    private readonly urls: Record<DataKind, string | null>;
    constructor(opts: DataUrls) {
      this.urls = {
        cMapUrl: opts.cMapUrl ?? null,
        standardFontDataUrl: opts.standardFontDataUrl ?? null,
        wasmUrl: opts.wasmUrl ?? null,
      };
    }
    async fetch({ kind, filename }: { kind: DataKind; filename: string }): Promise<Uint8Array> {
      const base = this.urls[kind];
      if (!base) throw new Error(`No ${kind}`);
      try {
        const res = await fetchFn(base + filename);
        if (!res.ok) throw new Error(`${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        state.failed = true;
        throw new Error(`Unable to load ${base}${filename}: ${(err as Error)?.message}`);
      }
    }
  };
}
