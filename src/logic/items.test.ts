import { describe, expect, it } from "vitest";
import { countTextChars, dropDuplicates, firstPageWithText, pageHasText, toTextItems, type RawItem } from "./items";

// What pdf.js gives for an upright US Letter page at scale 1: flip y.
const LETTER = [1, 0, 0, -1, 0, 792];

const raw = (str: string, transform: number[], width = str.length * 5): RawItem => ({ str, transform, width, fontName: "f1" });

describe("toTextItems", () => {
  it("measures from the top left of the page, with the font size", () => {
    const [it] = toTextItems([raw("Hello", [10, 0, 0, 10, 72, 700])], LETTER);
    expect(it).toMatchObject({ str: "Hello", x: 72, y: 92, w: 25, size: 10, font: "f1" });
  });

  it("scales with the viewport", () => {
    const [it] = toTextItems([raw("Hello", [10, 0, 0, 10, 72, 700])], [2, 0, 0, -2, 0, 1584]);
    expect(it).toMatchObject({ x: 144, y: 184, w: 50, size: 20 });
  });

  it("skips blank pieces and sideways text", () => {
    const items = toTextItems(
      [raw("  ", [10, 0, 0, 10, 0, 0]), raw("Photo by Ana", [0, 10, -10, 0, 500, 300]), raw("Kept", [10, 0, 0, 10, 0, 0])],
      LETTER,
    );
    expect(items.map((i) => i.str)).toEqual(["Kept"]);
  });

  it("handles a page rotated a quarter turn", () => {
    // Viewport for /Rotate 90 on a 612x792 page; text that is upright on screen.
    const rotated = [0, 1, 1, 0, 0, 0];
    const [it] = toTextItems([raw("Upright", [0, 10, -10, 0, 300, 100])], rotated);
    expect(it).toMatchObject({ str: "Upright", size: 10 });
  });
});

describe("scanned pages", () => {
  it("has no text when a page is only a picture", () => {
    expect(pageHasText([])).toBe(false);
  });

  it("ignores a stray page number or stamp", () => {
    expect(pageHasText([{ str: "Page 12" }, { str: "A-3" }])).toBe(false);
  });

  it("finds real text", () => {
    expect(pageHasText([{ str: "The council met on Monday night to talk about speed." }])).toBe(true);
  });

  it("counts letters and digits in any script, not spaces or punctuation", () => {
    expect(countTextChars([{ str: "Ça va? 東京 12 — !" }])).toBe(8);
  });
});

describe("dropDuplicates", () => {
  it("keeps one copy of text drawn twice at almost the same spot", () => {
    const a = { str: "Fort Polk", x: 10, y: 20, w: 40, size: 10 };
    const b = { ...a, x: 10.5, y: 20.5 };
    const c = { ...a, x: 300 };
    expect(dropDuplicates([a, b, c])).toEqual([a, c]);
  });
});

describe("firstPageWithText", () => {
  it("finds text that only starts on a later page (a picture cover and adverts first)", async () => {
    const checked: number[] = [];
    const first = await firstPageWithText(10, async (p) => {
      checked.push(p);
      return p >= 4;
    });
    expect(first).toBe(4);
    expect(checked).toEqual([1, 2, 3, 4]);
  });

  it("stops at page 1 for a normal paper", async () => {
    const checked: number[] = [];
    expect(await firstPageWithText(48, async (p) => (checked.push(p), true))).toBe(1);
    expect(checked).toEqual([1]);
  });

  it("is null only when no page at all has text, and skips unreadable pages", async () => {
    expect(await firstPageWithText(3, async () => false)).toBeNull();
    expect(
      await firstPageWithText(3, async (p) => {
        if (p === 1) throw new Error("bad page");
        return p === 3;
      }),
    ).toBe(3);
  });
});
