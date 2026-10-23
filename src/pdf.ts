// Loading PDFs with pdf.js, entirely on this device. The worker, fonts and
// decoders are bundled with the app (see vite.config.ts); nothing is fetched
// from anywhere else.

import "./polyfills";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { pageHasText, toTextItems, type RawItem } from "./logic/items";
import { layoutPage, type Block } from "./logic/layout";

export type OpenError = "password" | "not-pdf" | "app-broken" | "unknown";

export class PdfOpenError extends Error {
  constructor(readonly kind: OpenError) {
    super(kind);
  }
}

/**
 * Counts failed loads of pdf.js's data files (character maps, fonts, decoders).
 * pdf.js carries on without them, so a page that needs one can look empty;
 * that must be reported as a loading problem, never as "this PDF has no text".
 */
let dataFailures = 0;

/** True if any of the app's own data files failed to load (e.g. offline, or the app changed). */
export function appDataFailed(): boolean {
  return dataFailures > 0;
}

type DataKind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl";

/**
 * Loads pdf.js data files on the page itself (not inside the pdf.js worker), so
 * they go through the page's service worker and come from the same release as
 * the page, and so a failure is noticed.
 */
class AppDataFactory {
  private readonly urls: Record<DataKind, string | null>;
  constructor(opts: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {
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
      const res = await fetch(base + filename);
      if (!res.ok) throw new Error(`${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      dataFailures++;
      throw new Error(`Unable to load ${base}${filename}: ${(err as Error)?.message}`);
    }
  }
}

let worker: Worker | null = null;
/** Set once this page has been taken over by its service worker after starting the pdf.js worker. */
let workerStale = false;
let openDocs = 0;

/**
 * On a first visit the page starts before its service worker is installed. Once
 * the worker has taken over the page (see sw/worker.js), restart the pdf.js
 * worker the next time nothing is open, so it is covered by the offline cache too.
 */
export function markWorkerStale() {
  workerStale = true;
}

function restartWorkerIfStale() {
  if (!workerStale || openDocs > 0 || !worker || workerFailed) return;
  workerStale = false;
  worker.terminate();
  worker = null;
  startWorker();
}
/** Settles (rejects) only if the pdf.js worker fails to start or crashes. */
let workerBroken: Promise<never> = new Promise(() => {});
let workerFailed = false;

/**
 * Starts the pdf.js worker. Called as soon as the app loads, not when the first
 * PDF is opened: the worker's file belongs to this release of the app, so it is
 * fetched together with the page, while this release is certainly still online
 * (or in its offline cache). If it can't load anyway (say the app was updated in
 * between), opening a PDF says so and offers a reload instead of waiting forever.
 */
export function startWorker() {
  if (worker) return;
  const w = new Worker(new URL("./pdf-worker.ts", import.meta.url), { type: "module" });
  worker = w;
  workerBroken = new Promise<never>((_, reject) => {
    w.addEventListener(
      "error",
      () => {
        workerFailed = true;
        reject(new PdfOpenError("app-broken"));
      },
      { once: true },
    );
  });
  workerBroken.catch(() => {});
  GlobalWorkerOptions.workerPort = w;
}

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  restartWorkerIfStale();
  startWorker();
  if (workerFailed) throw new PdfOpenError("app-broken");
  const task = getDocument({
    data,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
    BinaryDataFactory: AppDataFactory,
    useWorkerFetch: false,
    enableXfa: false,
    verbosity: 0,
  });
  // Locked PDFs: say so plainly instead of asking for a password we can't explain.
  task.onPassword = () => {
    void task.destroy();
  };
  try {
    const doc = await Promise.race([task.promise, workerBroken]);
    openDocs++;
    return doc;
  } catch (err) {
    if (err instanceof PdfOpenError) {
      void task.destroy();
      throw err;
    }
    console.error(err);
    const name = (err as { name?: string })?.name ?? "";
    if (name === "PasswordException" || (err as Error)?.message?.includes("destroyed")) {
      throw new PdfOpenError("password");
    }
    if (name === "InvalidPDFException") throw new PdfOpenError("not-pdf");
    throw new PdfOpenError("unknown");
  }
}

export interface PageLayout {
  width: number;
  height: number;
  hasText: boolean;
  blocks: Block[];
}

const layouts = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageLayout>>>();

/** The columns of one page (worked out once per page, then remembered). */
export function pageLayout(doc: PDFDocumentProxy, pageNo: number): Promise<PageLayout> {
  let cache = layouts.get(doc);
  if (!cache) layouts.set(doc, (cache = new Map()));
  let found = cache.get(pageNo);
  if (!found) {
    found = (async () => {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const raw = content.items.filter((i): i is RawItem & typeof i => "str" in i);
      const items = toTextItems(raw, viewport.transform);
      return {
        width: viewport.width,
        height: viewport.height,
        hasText: pageHasText(items),
        blocks: layoutPage(items),
      };
    })();
    cache.set(pageNo, found);
    found.catch(() => cache!.delete(pageNo));
  }
  return found;
}

/** Biggest canvas we draw, in pixels: phones refuse much larger ones. */
const MAX_PIXELS = 12_000_000;

export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Draws a page (or one region of it) into a canvas, `cssWidth` pixels wide on
 * screen, sharp on high-density screens.
 */
export function drawPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  region?: Region,
): { done: Promise<void>; cancel: () => void } {
  const base = page.getViewport({ scale: 1 });
  const area = region ?? { left: 0, top: 0, width: base.width, height: base.height };
  const cssScale = cssWidth / area.width;
  let ratio = Math.min(window.devicePixelRatio || 1, 3);
  const pixels = () => area.width * cssScale * ratio * area.height * cssScale * ratio;
  while (ratio > 0.5 && pixels() > MAX_PIXELS) ratio *= 0.8;
  const scale = cssScale * ratio;
  const viewport = page.getViewport({ scale, offsetX: -area.left * scale, offsetY: -area.top * scale });
  canvas.width = Math.max(1, Math.floor(area.width * scale));
  canvas.height = Math.max(1, Math.floor(area.height * scale));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${area.height * cssScale}px`;
  const task = page.render({ canvas, viewport });
  return {
    done: task.promise.catch((err: unknown) => {
      // A newer drawing replaced this one: not an error.
      if ((err as { name?: string })?.name !== "RenderingCancelledException") throw err;
    }),
    cancel: () => task.cancel(),
  };
}

/** Closes a PDF and frees its memory. */
export async function closePdf(doc: PDFDocumentProxy): Promise<void> {
  openDocs = Math.max(0, openDocs - 1);
  await doc.loadingTask.destroy();
}
