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
