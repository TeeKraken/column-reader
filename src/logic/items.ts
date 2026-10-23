// Turning pdf.js text content into simple, page-oriented text pieces.
// Pure functions, tested in items.test.ts.

/** One run of text on a page, in page units with the origin at the top left. */
export interface TextItem {
  /** The text as the PDF has it (may start or end with spaces). */
  str: string;
  /** Left edge. */
  x: number;
  /** Baseline, measured down from the top of the page. */
  y: number;
  /** Width along the line. */
  w: number;
  /** Font size (the height of the text). */
  size: number;
  /** The PDF's name for the font, if known (headlines, captions and body text differ). */
  font?: string;
}

/** The parts of a pdf.js text item this app uses. */
export interface RawItem {
  str: string;
  transform: number[];
  width: number;
  fontName?: string;
}

type Matrix = [number, number, number, number, number, number];

function multiply(a: number[], b: number[]): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/**
 * Converts pdf.js text items to page-oriented pieces, using the page's viewport
 * transform (scale 1), so positions match what is drawn on screen.
 * Only left-to-right horizontal text is kept: sideways photo credits and the
 * like can't be part of a column of reading text.
 */
export function toTextItems(raw: readonly RawItem[], viewportTransform: readonly number[]): TextItem[] {
  const scale = Math.sqrt(Math.abs(viewportTransform[0] * viewportTransform[3] - viewportTransform[1] * viewportTransform[2]));
  const out: TextItem[] = [];
  for (const item of raw) {
    if (!item.str || !item.str.trim()) continue;
    const m = multiply(viewportTransform as number[], item.transform);
    // Direction of the text on screen: keep only left-to-right, near horizontal.
    if (!(m[0] > 0) || Math.abs(m[1]) > 0.05 * Math.abs(m[0])) continue;
    const size = Math.hypot(m[2], m[3]);
    const w = item.width * scale;
    if (!(size > 0.5) || !Number.isFinite(w) || !Number.isFinite(m[4]) || !Number.isFinite(m[5])) continue;
    out.push({ str: item.str, x: m[4], y: m[5], w: Math.max(0, w), size, font: item.fontName });
  }
  return out;
}

/** How many letters and digits a page's text has. */
export function countTextChars(items: readonly { str: string }[]): number {
  let n = 0;
  for (const item of items) {
    const m = item.str.match(/[\p{L}\p{N}]/gu);
    if (m) n += m.length;
  }
  return n;
}

/**
 * A page with (almost) no text is most likely a scan or photo of a page: there
 * is nothing to pick out. A few stray characters (a page number stamp) don't count.
 */
export const MIN_TEXT_CHARS = 20;

export function pageHasText(items: readonly { str: string }[]): boolean {
  return countTextChars(items) >= MIN_TEXT_CHARS;
}

/**
 * Some PDFs draw the same text twice, slightly offset (a shadow, or fake bold).
 * Keep the first copy of any text that repeats at almost the same spot.
 */
export function dropDuplicates(items: readonly TextItem[]): TextItem[] {
  const seen = new Map<string, TextItem[]>();
  const out: TextItem[] = [];
  for (const item of items) {
    const key = item.str.trim();
    const tol = 0.2 * item.size;
    const same = seen.get(key);
    if (same?.some((o) => Math.abs(o.x - item.x) <= tol && Math.abs(o.y - item.y) <= tol)) continue;
    if (same) same.push(item);
    else seen.set(key, [item]);
    out.push(item);
  }
  return out;
}

/**
 * The first page with text, checking pages one at a time from page 1 and
 * stopping at the first hit (so a normal paper costs one page). Null when no
 * page has text: then the whole PDF is pictures of pages. A page that can't be
 * read counts as having no text.
 */
export async function firstPageWithText(
  pages: number,
  hasText: (page: number) => Promise<boolean>,
): Promise<number | null> {
  for (let p = 1; p <= pages; p++) {
    try {
      if (await hasText(p)) return p;
    } catch {
      /* unreadable page: keep looking */
    }
  }
  return null;
}
