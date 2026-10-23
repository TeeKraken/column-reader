import { describe, expect, it } from "vitest";
import { column, item, justifiedColumn, widthOf } from "./fixtures";
import { blockAt, buildLines, joinText, layoutPage, readingOrder, type Block } from "./layout";
import { paragraphs } from "./reflow";

const textOf = (b: Pick<Block, "lines">) => paragraphs(b).join(" ");

// Two columns 100pt wide with a gutter of only 9pt (0.9 of the type size). The
// second line of the left column is justified, with a word gap of 8pt.
const left = column(
  ["The council met on", ["Monday", 8, "to talk about"], "the plan for Main", "Street and the speed", "cameras."],
  0,
  20,
);
const right = column(["Residents spoke for", "an hour about the", "crash and asked for", "safer crossings near", "the school."], 109, 20);

describe("columns", () => {
  it("keeps two columns apart across a narrow gutter, but joins a wide word gap", () => {
    const blocks = layoutPage([...right, ...left]);
    expect(blocks.map(textOf)).toEqual([
      "The council met on Monday to talk about the plan for Main Street and the speed cameras.",
      "Residents spoke for an hour about the crash and asked for safer crossings near the school.",
    ]);
  });

  it("reads a headline across both columns first, then each column", () => {
    const headline = item("Council debates Main St.", 0, 0, 16, "head");
    const blocks = layoutPage([...left, ...right, headline].map((i) => ({ ...i, y: i.y + 10 })));
    expect(blocks.map(textOf)).toEqual([
      "Council debates Main St.",
      expect.stringMatching(/^The council met/),
      expect.stringMatching(/^Residents spoke/),
    ]);
  });

  it("reads side-by-side articles of different lengths one after the other", () => {
    const a = column(["Alpha one", "alpha two", "alpha three", "alpha four", "alpha five", "alpha six"], 0, 20);
    const b = column(["Beta one", "beta two"], 70, 20);
    const c = column(["Gamma one", "gamma two"], 70, 60);
    const blocks = layoutPage([...c, ...b, ...a]);
    expect(blocks.map((x) => x.lines[0].text)).toEqual(["Alpha one", "Beta one", "Gamma one"]);
  });

  it("splits a column from a caption in another typeface right below it", () => {
    const body = column(["The new library will", "open next spring."], 0, 20);
    const caption = column(["Plans for the library."], 0, 44, 10, 12, "caption");
    const blocks = layoutPage([...body, ...caption]);
    expect(blocks.map(textOf)).toEqual(["The new library will open next spring.", "Plans for the library."]);
  });

  it("keeps a big headline beside a column, on the same baseline, apart from it", () => {
    const headline = item("Housing", 0, 40, 40, "head");
    const col = column(["the city said on", "Tuesday that work", "will start soon."], headline.w + 8, 28);
    const lines = buildLines([headline, ...col]);
    expect(lines.map((l) => l.text).sort()).toEqual(["Housing", "Tuesday that work", "the city said on", "will start soon."].sort());
  });

  it("keeps a ragged-right column together when later lines are a bit longer", () => {
    const col = column(["Short line here", "A rather longer line of text", "and the rest."], 0, 20);
    expect(layoutPage(col)).toHaveLength(1);
  });

  it("splits a column at a big vertical gap", () => {
    const top = column(["First story ends", "right here."], 0, 20);
    const bottom = column(["Second story", "starts here."], 0, 100);
    expect(layoutPage([...top, ...bottom]).map(textOf)).toEqual(["First story ends right here.", "Second story starts here."]);
  });

  it("joins a drop cap onto the first line beside it", () => {
    const cap = item("T", 0, 32, 30, "cap");
    const col = [...column(["he prospect of", "adding cameras"], cap.w + 2, 20), ...column(["has emerged."], 0, 44)];
    const blocks = layoutPage([cap, ...col]);
    expect(blocks.map(textOf)).toEqual(["The prospect of adding cameras has emerged."]);
  });

  it("drops text drawn twice at the same spot", () => {
    const col = column(["Fort Polk First!"], 0, 20);
    const shadow = { ...col[0], x: col[0].x + 0.5, y: col[0].y + 0.5 };
    expect(layoutPage([...col, shadow]).map(textOf)).toEqual(["Fort Polk First!"]);
  });

  it("works out reading order with the blocks in any order", () => {
    const boxes = [
      { top: 0, bottom: 10, left: 0, right: 100, id: "head" },
      { top: 20, bottom: 80, left: 52, right: 100, id: "right" },
      { top: 20, bottom: 80, left: 0, right: 48, id: "left" },
    ];
    expect(readingOrder(boxes).map((b) => b.id)).toEqual(["head", "left", "right"]);
  });
});

describe("joinText", () => {
  it("adds spaces at visible gaps only", () => {
    expect(joinText([item("Main", 0, 10), item("Street", widthOf("Main", 10) + 3, 10)])).toBe("Main Street");
    expect(joinText([item("Pos", 0, 10), item("t", widthOf("Pos", 10), 10, 8)])).toBe("Post");
  });

  it("joins fake-bold headlines whose letters overlap", () => {
    // Positions and widths as a real magazine draws "EDITORIAL".
    const pieces: [string, number, number][] = [
      ["E", 112.2, 16.9], ["ED", 110.8, 38.9], ["DI", 127.7, 30.7], ["IT", 148.3, 27.3], ["TO", 157.1, 39.9],
      ["OR", 173.6, 42.1], ["RI", 195.6, 28.8], ["IA", 214.2, 30.3], ["AL", 223.1, 37.3], ["L", 243.2, 15.7],
    ];
    const items = pieces.map(([str, x, w]) => ({ str, x, w, y: 50, size: 31 }));
    expect(joinText(items)).toBe("EDITORIAL");
  });
});

describe("blockAt", () => {
  const blocks = layoutPage([...left, ...right]);
  it("picks the column under the finger", () => {
    expect(blockAt(blocks, 30, 40)?.lines[0].text).toBe("The council met on");
    expect(blockAt(blocks, 150, 40)?.lines[0].text).toBe("Residents spoke for");
  });
  it("picks the nearest column for a tap just outside it, and nothing far away", () => {
    expect(blockAt(blocks, 30, 80)?.lines[0].text).toBe("The council met on");
    expect(blockAt(blocks, 30, 400)).toBeNull();
  });
});

describe("justified text set one piece per word", () => {
  // Columns 160pt wide, 11pt apart (1.1 ems); stretched word spaces reach 1.2-2 ems.
  const leftLines = [
    "The footbridge over Pebble",
    "Creek will stay where it is,",
    "the council decided late on",
    "Tuesday night after a long",
    "debate about its future and",
    "the cost of repairs.",
  ];
  const rightLines = [
    "Engineers said the frame is",
    "sound, but the deck and the",
    "railings need replacing and",
    "the steps at each end will",
    "become a ramp so that all can",
    "cross with ease.",
  ];
  const left = justifiedColumn(leftLines, 0, 40, 160);
  const right = justifiedColumn(rightLines, 171, 40, 160);
  const words = (lines: string[]) => lines.join(" ");

  it("keeps the columns apart even where a word space is wider than the gutter", () => {
    const gaps = left.filter((it, i) => i > 0 && left[i - 1].y === it.y).map((it, i) => it.x - (left[i].x + left[i].w));
    expect(Math.max(...gaps)).toBeGreaterThan(11); // the test really has word spaces wider than the gutter
    const blocks = layoutPage([...right, ...left]);
    expect(blocks.map(textOf)).toEqual([words(leftLines), words(rightLines)]);
  });

  it("isn't fooled by a wider line in another size or typeface running across both columns", () => {
    const deck = item("A standfirst in italics that runs right across both of the columns", 0, 24, 10.5, "italic");
    const caption = item("A caption in its own typeface across both columns, same size", 0, 116, 10, "caption");
    const blocks = layoutPage([deck, ...left, ...right, caption]);
    const texts = blocks.map(textOf);
    expect(texts).toContain(words(leftLines));
    expect(texts).toContain(words(rightLines));
  });

  it("still joins a justified line when every line around it has letters across its word spaces", () => {
    const lines = buildLines(left);
    expect(lines.map((l) => l.text)).toEqual(leftLines);
  });
});

