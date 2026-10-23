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

let worker: Worker | null = null;
function startWorker() {
  if (worker) return;
  worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), { type: "module" });
  GlobalWorkerOptions.workerPort = worker;
}

export type OpenError = "password" | "not-pdf" | "unknown";

export class PdfOpenError extends Error {
  constructor(readonly kind: OpenError) {
    super(kind);
  }
}

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  startWorker();
  const task = getDocument({
    data,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
    enableXfa: false,
    verbosity: 0,
  });
  // Locked PDFs: say so plainly instead of asking for a password we can't explain.
  task.onPassword = () => {
    void task.destroy();
  };
  try {
    return await task.promise;
  } catch (err) {
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
