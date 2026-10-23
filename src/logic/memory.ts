// What the app remembers on this device: the text size, and where you were in
// each paper. Pure helpers, tested in memory.test.ts. Nothing here ever leaves
// the device.

export const TEXT_SIZES = [16, 18, 20, 22, 25, 28, 32, 36, 42] as const;
export const DEFAULT_TEXT_SIZE = 22;
/** Papers remembered at most; the oldest are forgotten first. */
export const MAX_PAPERS = 30;

export interface Place {
  /** Page number, from 1. */
  page: number;
  /** The column last read on that page (its place in reading order), if any. */
  column: number | null;
  /** When, in ms since 1970; used to forget the oldest. */
  at: number;
}

export interface Memory {
  textSize: number;
  papers: Record<string, Place>;
}

export function emptyMemory(): Memory {
  return { textSize: DEFAULT_TEXT_SIZE, papers: {} };
}

/**
 * Names a paper without keeping its contents: its file name, size in bytes and
 * page count. Opening the same file again finds the same place.
 */
export function paperKey(name: string, bytes: number, pages: number): string {
  return `${name}|${bytes}|${pages}`;
}

const isInt = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;

/** Reads saved data, keeping only what makes sense. Never throws. */
export function parseMemory(raw: string | null): Memory {
  const mem = emptyMemory();
  if (!raw) return mem;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return mem;
  }
  if (!data || typeof data !== "object") return mem;
  const d = data as Record<string, unknown>;
  if (typeof d.textSize === "number") mem.textSize = nearestSize(d.textSize);
  if (d.papers && typeof d.papers === "object") {
    for (const [key, v] of Object.entries(d.papers as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || key.length > 600) continue;
      const p = v as Record<string, unknown>;
      if (!isInt(p.page, 1) || !(p.column === null || isInt(p.column, 0)) || typeof p.at !== "number") continue;
      mem.papers[key] = { page: p.page, column: p.column as number | null, at: p.at };
    }
  }
  return trim(mem);
}

/** The allowed text size closest to a number. */
export function nearestSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TEXT_SIZE;
  let best: number = TEXT_SIZES[0];
  for (const s of TEXT_SIZES) if (Math.abs(s - size) < Math.abs(best - size)) best = s;
  return best;
}

/** One step bigger (+1) or smaller (-1), staying within the allowed sizes. */
export function stepSize(size: number, dir: 1 | -1): number {
  const i = TEXT_SIZES.indexOf(nearestSize(size) as (typeof TEXT_SIZES)[number]);
  return TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, i + dir))];
}

/** A copy of the memory with this paper's place updated. */
export function rememberPlace(mem: Memory, key: string, page: number, column: number | null, now: number): Memory {
  return trim({ ...mem, papers: { ...mem.papers, [key]: { page, column, at: now } } });
}

function trim(mem: Memory): Memory {
  const entries = Object.entries(mem.papers);
  if (entries.length <= MAX_PAPERS) return mem;
  entries.sort((a, b) => b[1].at - a[1].at);
  return { ...mem, papers: Object.fromEntries(entries.slice(0, MAX_PAPERS)) };
}
