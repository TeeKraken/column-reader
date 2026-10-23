// Turning a block's lines back into running text: paragraphs, with words that
// were split across lines joined up again. Pure, tested in reflow.test.ts.

import type { Block, Line } from "./layout";

const HYPHENS = /[-‐­]$/;
const DASHES = /[–—]$/;

/**
 * Joins two lines of a paragraph. A word broken with a hyphen at the end of a
 * line ("enforce-" + "ment") is joined back up. The hyphen stays when it's part of
 * the word, as far as can be told: after a digit ("90-" + "minute") or before a
 * capital letter ("Anglo-" + "Saxon").
 */
export function joinLines(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  if (a.endsWith("­")) return a.slice(0, -1) + b;
  if (HYPHENS.test(a)) {
    const before = a.slice(-2, -1);
    if (/\p{L}/u.test(before) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
    return a + b;
  }
  if (DASHES.test(a) || /^[–—]/.test(b)) return a + b;
  return a + " " + b;
}

const ENDS_SENTENCE = /[.!?:;"”’)\]]$/;
const STARTS_SENTENCE = /^[\p{Lu}\p{N}"“‘'(•▪■●\-–—*]/u;
const BULLET = /^[•▪■●]/;

/** Paragraphs of a block, as plain text. */
export function paragraphs(block: Pick<Block, "lines">): string[] {
  const lines = [...block.lines].sort((a, b) => a.y - b.y);
  if (!lines.length) return [];
  const size = lines.map((l) => l.size).sort((a, b) => a - b)[lines.length >> 1];
  const left = columnLeft(lines, size);
  const right = Math.max(...lines.map((l) => l.right));
  const steps: number[] = [];
  for (let i = 1; i < lines.length; i++) steps.push(lines[i].y - lines[i - 1].y);
  steps.sort((a, b) => a - b);
  const spacing = steps.length ? steps[steps.length >> 1] : 0;
  const atLeft = lines.filter((l) => l.x - left <= 0.3 * size).length;
  // Indents only mean something when most lines start at the column's edge
  // (a centred headline's lines all start in different places).
  const indentsMatter = atLeft >= 0.6 * lines.length;

  const out: string[] = [];
  let cur = lines[0].text;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const line = lines[i];
    const gap = line.y - prev.y;
    const indented = indentsMatter && !line.dropCap && line.x - left > 0.5 * size && line.x - left < 6 * size;
    const shortEnd =
      prev.right < right - 2.5 * size && ENDS_SENTENCE.test(prev.text) && STARTS_SENTENCE.test(line.text);
    const newPara =
      (spacing > 0 && gap > 1.45 * spacing) || indented || shortEnd || BULLET.test(line.text) || line.dropCap;
    if (newPara) {
      out.push(cur);
      cur = line.text;
    } else {
      cur = joinLines(cur, line.text);
    }
  }
  out.push(cur);
  return out.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** The column's left edge: the leftmost place at least two lines start. */
function columnLeft(lines: Line[], size: number): number {
  const xs = lines.map((l) => l.x).sort((a, b) => a - b);
  const need = Math.min(2, xs.length);
  for (const x of xs) if (xs.filter((o) => Math.abs(o - x) <= 0.3 * size).length >= need) return x;
  return xs[0];
}

/** The first few words of a block, to name it for screen readers. */
export function preview(block: Pick<Block, "lines">, words = 8): string {
  const text = paragraphs(block).join(" ");
  const parts = text.split(" ");
  return parts.length > words ? parts.slice(0, words).join(" ") + "…" : text;
}
