import { describe, expect, it } from "vitest";
import { dataFactoryFor } from "./datafiles";

const urls = { cMapUrl: "/pdfjs/abc123/cmaps/", standardFontDataUrl: "/pdfjs/abc123/standard_fonts/", wasmUrl: null };

describe("pdf.js data files", () => {
  it("loads a file from this version's folder", async () => {
    const asked: string[] = [];
    const state = { failed: false };
    const Factory = dataFactoryFor(state, async (u) => {
      asked.push(String(u));
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const data = await new Factory(urls).fetch({ kind: "cMapUrl", filename: "UniJIS-UTF16-H.bcmap" });
    expect([...data]).toEqual([1, 2, 3]);
    expect(asked).toEqual(["/pdfjs/abc123/cmaps/UniJIS-UTF16-H.bcmap"]);
    expect(state.failed).toBe(false);
  });

  it("notes a failed load (offline or missing) for that document only", async () => {
    const broken = { failed: false };
    const healthy = { failed: false };
    const Offline = dataFactoryFor(broken, async () => {
      throw new TypeError("Failed to fetch");
    });
    const Missing = dataFactoryFor(broken, async () => new Response("gone", { status: 404 }));
    const Fine = dataFactoryFor(healthy, async () => new Response(new Uint8Array([9])));
    await expect(new Offline(urls).fetch({ kind: "cMapUrl", filename: "a.bcmap" })).rejects.toThrow(/Unable to load/);
    await expect(new Missing(urls).fetch({ kind: "standardFontDataUrl", filename: "b.pfb" })).rejects.toThrow();
    expect(broken.failed).toBe(true);
    // A different PDF opened afterwards is unaffected, even by a late failure of the first.
    await new Fine(urls).fetch({ kind: "cMapUrl", filename: "a.bcmap" });
    await expect(new Offline(urls).fetch({ kind: "cMapUrl", filename: "late.bcmap" })).rejects.toThrow();
    expect(healthy.failed).toBe(false);
  });

  it("refuses a kind of file it wasn't given a folder for", async () => {
    const state = { failed: false };
    await expect(new (dataFactoryFor(state, fetch))(urls).fetch({ kind: "wasmUrl", filename: "x.wasm" })).rejects.toThrow();
  });
});
