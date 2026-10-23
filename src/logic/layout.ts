// Finding the columns of text on a page.
//
// 1. Pieces of text that sit on the same baseline are joined into lines, but a line
//    never crosses the gap between two columns (a "gutter").
// 2. Lines stacked under each other, in the same column, size of type and font,
//    become a block: a column of one article, a headline, a caption.
// 3. Blocks are put in reading order: column by column, left to right, where
//    clear space runs down the page; otherwise top to bottom (see readingOrder).
//
// Pure functions, tested in layout.test.ts.

import { dropDuplicates, type TextItem } from "./items";

export interface Line {
  x: number;
  right: number;
  /** Baseline, from the top of the page. */
  y: number;
  size: number;
  /** The font most of the line is in, if known. */
  font?: string;
  text: string;
  /** Set when a big first letter (drop cap) was joined onto this line. */
  dropCap?: boolean;
}

export interface Block {
  /** Position in reading order, starting at 0. */
  index: number;
  lines: Line[];
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The usual size of type in this block. */
  size: number;
}

/** Gaps wider than this (in ems) always split a line: it's a gutter or a table. */
const MAX_WORD_GAP = 1.6;
/** Gaps narrower than this (in ems) never split a line: they're between words. */
const WORD_SPACE = 0.25;
/** With no lines around to compare with, gaps wider than this (in ems) split a line. */
const LONE_GUTTER = 0.7;
/**
 * Type this much bigger than its neighbour on the same baseline is something else
 * (a drop cap, or a headline beside a column), never part of the same line.
 */
const SIZE_JUMP = 1.8;

interface Fragment {
  items: TextItem[];
  x: number;
  right: number;
  y: number;
  size: number;
  font?: string;
}

const ascent = (size: number) => 0.78 * size;
const descent = (size: number) => 0.24 * size;
const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.min(a2, b2) - Math.max(a1, b1);
const similarSize = (a: number, b: number, ratio = 1.25) => Math.max(a, b) / Math.min(a, b) <= ratio;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function makeFragment(items: TextItem[]): Fragment {
  // The piece with the most text sets the line's size and baseline (small caps
  // and superscripts don't).
  let main = items[0];
  for (const it of items) if (it.str.trim().length > main.str.trim().length) main = it;
  let right = -Infinity;
  for (const it of items) right = Math.max(right, it.x + it.w);
  return { items, x: Math.min(...items.map((i) => i.x)), right, y: main.y, size: main.size, font: main.font };
}

/** Groups items into rows that share a baseline, each sorted left to right. */
function rowsOf(items: TextItem[]): TextItem[][] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: { y: number; size: number; items: TextItem[] }[] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(it.y - row.y) <= 0.3 * Math.min(it.size, row.size)) row.items.push(it);
    else rows.push({ y: it.y, size: it.size, items: [it] });
  }
  return rows.map((r) => r.items.sort((a, b) => a.x - b.x));
}

/**
 * Splits a row at every gap wider than a word space could be. Pieces that overlap
 * are kept together (fake-bold headlines draw letters over each other).
 */
function fragmentsOf(row: TextItem[]): Fragment[] {
  const out: TextItem[][] = [];
  let cur: TextItem[] = [];
  let end = -Infinity;
  for (const it of row) {
    const size = Math.min(it.size, cur.length ? cur[cur.length - 1].size : Infinity);
    const last = cur[cur.length - 1];
    if (cur.length && (it.x - end > WORD_SPACE * size || !similarSize(it.size, last.size, SIZE_JUMP))) {
      out.push(cur);
      cur = [];
      end = -Infinity;
    }
    cur.push(it);
    end = Math.max(end, it.x + it.w);
  }
  if (cur.length) out.push(cur);
  return out.map(makeFragment);
}

/**
 * Is the gap between two pieces on one line a gutter between columns? A word
 * space in justified text can be nearly as wide as a narrow gutter, and big
 * headlines in neighbouring columns can almost touch. So look at the lines just
 * above and below (up to two each way, in the same size of type): in a column of
 * text, some of them have letters where this line has its gap. A gutter is empty
 * all the way down.
 */
function isGutter(rows: Fragment[][], r: number, a: Fragment, b: Fragment): boolean {
  const size = Math.min(a.size, b.size);
  const gap = b.x - a.right;
  if (gap <= WORD_SPACE * size) return false;
  if (gap > MAX_WORD_GAP * size) return true;
  const mid = (a.right + b.x) / 2;
  const y = rows[r][0].y;
  let seen = 0;
  let covered = 0;
  for (const dir of [-1, 1]) {
    let found = 0;
    for (let k = r + dir; k >= 0 && k < rows.length && found < 2; k += dir) {
      const dy = Math.abs(rows[k][0].y - y);
      if (dy > 3.5 * size) break;
      if (dy < 0.6 * size) continue;
      const near = rows[k].filter((f) => similarSize(f.size, size) && overlap(f.x, f.right, a.x, b.right) > 0);
      if (!near.length) continue;
      found++;
      seen++;
      if (near.some((f) => f.x - 0.05 * size <= mid && mid <= f.right + 0.05 * size)) covered++;
    }
  }
  if (!seen) return gap > LONE_GUTTER * size;
  return covered === 0;
}

/** Joins the pieces of one line into text, adding spaces where there's a visible gap. */
export function joinText(items: readonly TextItem[]): string {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let text = "";
  let end = -Infinity;
  for (const it of sorted) {
    let s = it.str;
    if (text) {
      const gap = it.x - end;
      // Fake bold: overlapping pieces repeat the letter where they overlap ("ED" + "DI").
      const trimmed = text.trimEnd();
      if (gap < -0.25 * it.size) {
        // A piece drawn entirely over text already placed is a repeat: skip it.
        if (it.x + it.w <= end + 0.1 * it.size) continue;
        if (trimmed.endsWith(s[0])) s = s.slice(1);
      }
      const space = gap > 0.12 * it.size && !/\s$/.test(text) && !/^\s/.test(s);
      text += (space ? " " : "") + s;
    } else {
      text = s;
    }
    end = Math.max(end, it.x + it.w);
  }
  return text.replace(/\s+/g, " ").trim();
}

/** Builds the lines of a page from its text pieces. */
export function buildLines(input: readonly TextItem[]): Line[] {
  const items = dropDuplicates(input);
  const rows = rowsOf(items).map(fragmentsOf);
  const lines: Line[] = [];
  rows.forEach((frags, r) => {
    let cur: Fragment | null = null;
    for (const f of frags) {
      if (cur && similarSize(cur.size, f.size, SIZE_JUMP) && !isGutter(rows, r, cur, f)) {
        cur = makeFragment([...cur.items, ...f.items]);
      } else {
        if (cur) lines.push(toLine(cur));
        cur = f;
      }
    }
    if (cur) lines.push(toLine(cur));
  });
  return joinDropCaps(lines);
}

function toLine(f: Fragment): Line {
  return { x: f.x, right: f.right, y: f.y, size: f.size, font: f.font, text: joinText(f.items) };
}

/**
 * A drop cap is one big letter at the start of a paragraph, beside the first few
 * lines. Joins it onto the first line it sits beside, and lines the text beside it
 * up with the column's left edge.
 */
function joinDropCaps(lines: Line[]): Line[] {
  const out = [...lines];
  for (const cap of lines) {
    const letter = cap.text.trim();
    if (!/^[\p{Lu}\p{N}"“'‘]$/u.test(letter)) continue;
    const top = cap.y - ascent(cap.size);
    const beside = out
      .filter(
        (l) =>
          l !== cap &&
          l.size * 1.8 <= cap.size &&
          l.x >= cap.right - 0.5 * l.size &&
          l.x <= cap.right + 1.5 * l.size &&
          l.y >= top &&
          l.y <= cap.y + descent(l.size) + 0.3 * l.size,
      )
      .sort((a, b) => a.y - b.y);
    if (!beside.length) continue;
    const first = beside[0];
    first.text = letter + first.text;
    first.dropCap = true;
    for (const l of beside) l.x = Math.min(l.x, cap.x);
    out.splice(out.indexOf(cap), 1);
  }
  return out;
}

/** Groups lines into blocks: lines stacked in one column with the same size of type. */
export function buildBlocks(lines: readonly Line[]): Block[] {
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  type Draft = { lines: Line[]; left: number; right: number };
  const blockOf = new Map<Line, Draft>();
  const hasBelow = new Set<Line>();
  const drafts: Draft[] = [];

  for (const line of sorted) {
    const width = line.right - line.x;
    let nearest: Line | null = null;
    for (const m of sorted) {
      if (m === line) break;
      if (m.y > line.y - 0.3 * line.size) continue;
      const ov = overlap(m.x, m.right, line.x, line.right);
      if (ov <= 0.3 * Math.min(width, m.right - m.x)) continue;
      if (!nearest || m.y > nearest.y) nearest = m;
    }
    const draft = nearest ? blockOf.get(nearest) : undefined;
    let joined = false;
    if (nearest && draft && !hasBelow.has(nearest)) {
      const size = median(draft.lines.map((l) => l.size));
      const slop = 1.2 * Math.max(size, line.size);
      const inside = line.x >= draft.left - slop && line.right <= draft.right + slop;
      // Ragged-right columns: same left edge, a little longer than the lines so far.
      const ragged =
        Math.abs(line.x - draft.left) <= slop &&
        line.right <= draft.right + Math.max(slop, 0.35 * (draft.right - draft.left));
      // A block that so far is a short line or two may widen to the column.
      const widens = draft.lines.length <= 2 && draft.left >= line.x - slop && draft.right <= line.right + slop;
      if (
        similarSize(size, line.size, 1.2) &&
        // A caption or byline in its own typeface, right above or below a column, is separate.
        (!line.font || !nearest.font || line.font === nearest.font) &&
        line.y - nearest.y <= lineGapLimit(draft.lines, Math.max(size, line.size), Math.abs(line.x - draft.left)) &&
        (inside || ragged || widens)
      ) {
        draft.lines.push(line);
        draft.left = Math.min(draft.left, line.x);
        draft.right = Math.max(draft.right, line.right);
        blockOf.set(line, draft);
        hasBelow.add(nearest);
        joined = true;
      }
    }
    if (!joined) {
      const d: Draft = { lines: [line], left: line.x, right: line.right };
      drafts.push(d);
      blockOf.set(line, d);
    }
  }

  const blocks = drafts.map((d) => {
    const size = median(d.lines.map((l) => l.size));
    return {
      index: 0,
      lines: d.lines,
      left: d.left,
      right: d.right,
      top: Math.min(...d.lines.map((l) => l.y - ascent(l.size))),
      bottom: Math.max(...d.lines.map((l) => l.y + descent(l.size))),
      size,
    };
  });
  const ordered = readingOrder(blocks);
  ordered.forEach((b, i) => (b.index = i));
  return ordered;
}

/**
 * How far below a block's last line the next line may start and still belong to
 * it: two lines' height. Where the block itself is spaced out (some magazines leave
 * a blank line between paragraphs) a bit more, for a line starting at or near
 * (indented from) the column's left edge.
 */
function lineGapLimit(lines: Line[], size: number, offsetFromLeft: number): number {
  const base = 2.0 * size;
  if (offsetFromLeft > 2 * size) return base;
  const steps: number[] = [];
  for (let i = 1; i < lines.length; i++) steps.push(lines[i].y - lines[i - 1].y);
  return Math.min(3 * size, Math.max(base, 2.3 * median(steps)));
}

type Box = { top: number; bottom: number; left: number; right: number; size?: number };

/**
 * Splits boxes into groups separated by clear space along one direction, in order.
 * Returns a single group when there is no clean split.
 */
function cut<T extends Box>(boxes: T[], start: (b: T) => number, end: (b: T) => number): T[][] {
  const sorted = [...boxes].sort((a, b) => start(a) - start(b));
  const groups: T[][] = [];
  let reach = -Infinity;
  for (const b of sorted) {
    // Text boxes are estimates (from font sizes), so allow them to touch a little.
    const slack = 0.3 * (b.size ?? 4);
    if (!groups.length || start(b) >= reach - slack) groups.push([b]);
    else groups[groups.length - 1].push(b);
    reach = Math.max(reach, end(b));
  }
  return groups;
}

/**
 * Reading order ("XY cut"): split the page into columns wherever a clear
 * vertical line of space runs all the way down it, and read them left to right;
 * where that isn't possible (a headline across several columns), split it into
 * bands at clear horizontal space and read them top to bottom; repeat inside each.
 */
export function readingOrder<T extends Box>(boxes: T[]): T[] {
  if (boxes.length <= 1) return [...boxes];
  const cols = cut(
    boxes,
    (b) => b.left,
    (b) => b.right,
  );
  if (cols.length > 1) return cols.flatMap((g) => readingOrder(g));
  const bands = cut(
    boxes,
    (b) => b.top,
    (b) => b.bottom,
  );
  if (bands.length > 1) return bands.flatMap((g) => readingOrder(g));
  // No clean split (boxes overlap): read rows of boxes that start at about the
  // same height left to right, top to bottom.
  const byTop = [...boxes].sort((a, b) => a.top - b.top);
  const rows: T[][] = [];
  for (const b of byTop) {
    const row = rows[rows.length - 1];
    if (row && b.top - row[0].top < 1.5 * (b.size ?? 4)) row.push(b);
    else rows.push([b]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.left - b.left));
}

/** Lines and blocks for one page's text. */
export function layoutPage(items: readonly TextItem[]): Block[] {
  return buildBlocks(buildLines(items));
}

/**
 * The block under a tap. Taps on the gap between blocks pick the nearest one,
 * if it's close (within two lines' height); otherwise nothing.
 */
export function blockAt(blocks: readonly Block[], x: number, y: number): Block | null {
  let best: Block | null = null;
  let bestScore = Infinity;
  for (const b of blocks) {
    const dx = Math.max(b.left - x, 0, x - b.right);
    const dy = Math.max(b.top - y, 0, y - b.bottom);
    const dist = Math.hypot(dx, dy);
    if (dist > 2 * b.size) continue;
    // Inside: prefer the smallest block (a caption inside a big box). Outside: the nearest.
    const score = dist === 0 ? -1e12 + (b.right - b.left) * (b.bottom - b.top) : dist;
    if (score < bestScore) {
      best = b;
      bestScore = score;
    }
  }
  return best;
}
