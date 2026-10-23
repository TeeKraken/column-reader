import { describe, expect, it } from "vitest";
import { column, item } from "./fixtures";
import { buildLines } from "./layout";
import { joinLines, paragraphs, preview } from "./reflow";

const blockOf = (items: ReturnType<typeof column>) => ({ lines: buildLines(items) });

describe("joinLines", () => {
  it("joins a word broken with a hyphen at the end of a line", () => {
    expect(joinLines("automated speed enforce-", "ment cameras")).toBe("automated speed enforcement cameras");
    expect(joinLines("Hook and Ladder Com-", "pany.")).toBe("Hook and Ladder Company.");
  });

  it("keeps hyphens that belong to the word", () => {
    expect(joinLines("Following a 90-", "minute discussion")).toBe("Following a 90-minute discussion");
    expect(joinLines("the Anglo-", "Saxon kings")).toBe("the Anglo-Saxon kings");
  });

  it("removes soft hyphens and keeps dashes tight", () => {
    expect(joinLines("news­", "paper")).toBe("newspaper");
    expect(joinLines("he said —", "and left")).toBe("he said —and left");
  });

  it("puts a space between ordinary lines", () => {
    expect(joinLines("The council met on", "Monday night.")).toBe("The council met on Monday night.");
  });
});

describe("paragraphs", () => {
  it("starts a new paragraph at an indented line", () => {
    const items = [
      ...column(["The council met on Monday", "to talk about speed."], 0, 20),
      ...column(["Residents spoke for an", "hour about the crash."], 0, 44).map((it, i) => (i === 0 ? { ...it, x: 9 } : it)),
    ];
    expect(paragraphs(blockOf(items))).toEqual([
      "The council met on Monday to talk about speed.",
      "Residents spoke for an hour about the crash.",
    ]);
  });

  it("starts a new paragraph after a blank line", () => {
    const items = [...column(["First paragraph ends", "here."], 0, 20), ...column(["Second one starts", "here."], 0, 56)];
    expect(paragraphs(blockOf(items))).toEqual(["First paragraph ends here.", "Second one starts here."]);
  });

  it("starts a new paragraph after a short line that ends a sentence", () => {
    const items = column(["This is a long first line of", "text.", "Then a new one begins at", "the left edge."], 0, 20);
    expect(paragraphs(blockOf(items))).toEqual(["This is a long first line of text.", "Then a new one begins at the left edge."]);
  });

  it("joins hyphenated words across lines in a column", () => {
    const items = column(["The prospect of adding", "automated speed enforce-", "ment cameras on Main"], 0, 20);
    expect(paragraphs(blockOf(items))).toEqual(["The prospect of adding automated speed enforcement cameras on Main"]);
  });

  it("keeps a centred headline in one piece", () => {
    const items = [item("Council debates", 10, 20, 20), item("Main St. solutions", 0, 44, 20), item("tonight", 30, 68, 20)];
    expect(paragraphs(blockOf(items))).toEqual(["Council debates Main St. solutions tonight"]);
  });

  it("starts a new paragraph at a bullet", () => {
    const items = column(["• Public notices are", "required by law", "• They keep people", "informed"], 0, 20);
    expect(paragraphs(blockOf(items))).toEqual(["• Public notices are required by law", "• They keep people informed"]);
  });
});

describe("preview", () => {
  it("gives the first few words", () => {
    const items = column(["The prospect of adding automated", "speed enforcement cameras"], 0, 20);
    expect(preview(blockOf(items), 4)).toBe("The prospect of adding…");
  });
});
