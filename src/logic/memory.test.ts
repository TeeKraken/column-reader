import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_SIZE,
  MAX_PAPERS,
  emptyMemory,
  nearestSize,
  paperKey,
  parseMemory,
  rememberPlace,
  stepSize,
  TEXT_SIZES,
} from "./memory";

describe("memory", () => {
  it("starts empty when nothing is saved or the data is damaged", () => {
    expect(parseMemory(null)).toEqual(emptyMemory());
    expect(parseMemory("{not json")).toEqual(emptyMemory());
    expect(parseMemory('"a string"')).toEqual(emptyMemory());
  });

  it("keeps good places and drops bad ones", () => {
    const raw = JSON.stringify({
      textSize: 27,
      papers: {
        good: { page: 3, column: 5, at: 1 },
        noColumn: { page: 1, column: null, at: 2 },
        badPage: { page: 0, column: null, at: 3 },
        badColumn: { page: 2, column: -1, at: 4 },
        notObject: 5,
      },
    });
    const mem = parseMemory(raw);
    expect(mem.textSize).toBe(28);
    expect(Object.keys(mem.papers).sort()).toEqual(["good", "noColumn"]);
  });

  it("remembers a place without changing the old copy", () => {
    const before = emptyMemory();
    const after = rememberPlace(before, paperKey("paper.pdf", 100, 12), 4, 2, 10);
    expect(before.papers).toEqual({});
    expect(after.papers["paper.pdf|100|12"]).toEqual({ page: 4, column: 2, at: 10 });
  });

  it(`forgets the oldest papers beyond ${MAX_PAPERS}`, () => {
    let mem = emptyMemory();
    for (let i = 0; i < MAX_PAPERS + 5; i++) mem = rememberPlace(mem, `p${i}`, 1, null, i);
    expect(Object.keys(mem.papers)).toHaveLength(MAX_PAPERS);
    expect(mem.papers.p0).toBeUndefined();
    expect(mem.papers[`p${MAX_PAPERS + 4}`]).toBeDefined();
  });

  it("steps text sizes within the allowed range", () => {
    expect(stepSize(DEFAULT_TEXT_SIZE, 1)).toBeGreaterThan(DEFAULT_TEXT_SIZE);
    expect(stepSize(TEXT_SIZES[0], -1)).toBe(TEXT_SIZES[0]);
    expect(stepSize(TEXT_SIZES[TEXT_SIZES.length - 1], 1)).toBe(TEXT_SIZES[TEXT_SIZES.length - 1]);
    expect(nearestSize(Number.NaN)).toBe(DEFAULT_TEXT_SIZE);
  });
});
