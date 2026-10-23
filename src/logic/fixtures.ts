// Helpers for building synthetic pages in tests: text placed the way a PDF places it.
import type { TextItem } from "./items";

/** Width of text in a simple fixed-pitch "font": half the size per character. */
export const widthOf = (str: string, size: number) => str.length * size * 0.5;

export function item(str: string, x: number, y: number, size = 10, font = "body"): TextItem {
  return { str, x, y, w: widthOf(str, size), size, font };
}

/**
 * A column: one item per line, lines `leading` apart, starting at baseline `y`.
 * A line may be given as several pieces with explicit gaps: ["word", 8, "word"].
 */
export function column(lines: (string | (string | number)[])[], x: number, y: number, size = 10, leading = 12, font = "body") {
  const out: TextItem[] = [];
  lines.forEach((line, i) => {
    const base = y + i * leading;
    if (typeof line === "string") {
      out.push(item(line, x, base, size, font));
      return;
    }
    let cx = x;
    let gap = 0;
    for (const part of line) {
      if (typeof part === "number") {
        gap = part;
        continue;
      }
      cx += gap;
      out.push(item(part, cx, base, size, font));
      cx += widthOf(part, size);
      gap = 0;
    }
  });
  return out;
}

/**
 * A justified column set one piece per word, as some PDFs do: every line but the
 * last is stretched to exactly `width`, so word spaces vary (and can be wider
 * than a narrow gutter). Space pieces are left out, as pdf.js gives them no width
 * that the app uses.
 */
export function justifiedColumn(lines: string[], x: number, y: number, width: number, size = 10, leading = 12, font = "body") {
  const out: TextItem[] = [];
  lines.forEach((line, i) => {
    const words = line.split(" ");
    const base = y + i * leading;
    const inked = words.reduce((n, w) => n + widthOf(w, size), 0);
    const last = i === lines.length - 1;
    const space = last || words.length < 2 ? size * 0.25 : (width - inked) / (words.length - 1);
    let cx = x;
    for (const w of words) {
      out.push(item(w, cx, base, size, font));
      cx += widthOf(w, size) + space;
    }
  });
  return out;
}
