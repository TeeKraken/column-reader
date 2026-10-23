import "./style.css";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { firstPageWithText } from "./logic/items";
import { blockAt, type Block } from "./logic/layout";
import { paperKey, rememberPlace, stepSize, TEXT_SIZES } from "./logic/memory";
import { paragraphs, preview } from "./logic/reflow";
import { drawPage, openPdf, pageLayout, PdfOpenError, startWorker, type PageLayout } from "./pdf";
import { loadMemory, saveMemory } from "./storage";

const IDEA_URL = "https://somebodybuildthis.dev/ideas/40-a-way-to-tap-one-article-in-a-newspaper-pdf-and-read-just-th";
const REPO_URL = "https://github.com/TeeKraken/column-reader";
const POST_IDEA_URL = "https://somebodybuildthis.dev/ideas/new";
/** Bigger files than this are likely to crash a phone's browser. */
const MAX_BYTES = 250 * 1024 * 1024;

const main = document.getElementById("main")!;
const announcer = document.getElementById("announce")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;

let memory = loadMemory();

type View = "home" | "page" | "read";

interface Paper {
  doc: PDFDocumentProxy;
  name: string;
  key: string;
  pages: number;
  /** The first page with text: undefined while still checking, null if none has any. */
  textFrom?: number | null;
}

let paper: Paper | null = null;
let view: View = "home";
let pageNo = 1;
/** The column being read (its place in the page's reading order). */
let column: number | null = null;
/** 1 = the page fits the screen; 2 = twice as wide (scroll sideways). */
let zoom = 1;
let showOriginal = false;
/** A message for the next screen, e.g. "Welcome back". */
let notice = "";
let error = "";
/** Show a "Reload" button with the error (when part of the app is missing). */
let errorReload = false;
/** Called when the background check for text finishes, to update the page screen. */
let onTextCheckDone: (() => void) | null = null;
/** Put focus back on the page-size button after redrawing the page screen. */
let focusZoom = false;
let busy = false;
/** Cancels drawings that belong to a screen that has been replaced. */
let cancelDrawings: (() => void)[] = [];

// ---------- Small helpers ----------

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;
type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function announce(text: string) {
  announcer.textContent = "";
  window.setTimeout(() => (announcer.textContent = text), 50);
}

/** Set when the next screen should move keyboard and screen-reader focus to its heading. */
let wantFocus = false;

function focusHeading() {
  wantFocus = false;
  const h1 = main.querySelector("h1");
  if (h1) {
    h1.setAttribute("tabindex", "-1");
    h1.focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
}

function stopDrawings() {
  for (const cancel of cancelDrawings) cancel();
  cancelDrawings = [];
}

function remember() {
  if (!paper) return;
  memory = rememberPlace(memory, paper.key, pageNo, column, Date.now());
  saveMemory(memory);
}

/** Width available for the page, in CSS pixels. */
function contentWidth(): number {
  const style = getComputedStyle(main);
  const inner = main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return Math.max(200, Math.floor(inner));
}

function footer({ wish = false }: { wish?: boolean } = {}) {
  return h(
    "footer",
    { class: "foot" },
    h("p", {}, "Your PDF stays on this device. Column Reader never uploads it, and has no account or tracking."),
    h(
      "p",
      {},
      "Made entirely by an AI (Claude, by Anthropic) from ",
      h("a", { href: IDEA_URL }, "an idea on Somebody Build This"),
      ". ",
      h("a", { href: REPO_URL }, "Open source"),
      ".",
    ),
    wish
      ? h(
          "p",
          {},
          "Made from a wish someone posted on Somebody Build This. Wish something existed? ",
          h("a", { href: POST_IDEA_URL }, "Post it there"),
          ", no tech words needed.",
        )
      : null,
  );
}

function noticeEl() {
  if (!notice) return null;
  const el = h("p", { class: "notice", role: "status" }, notice);
  notice = "";
  return el;
}

// ---------- Navigation ----------

/** Shows a screen. `push` adds it to the browser's history so Back returns here. */
function go(next: View, how: "push" | "replace" | "none" = "push") {
  view = next;
  const url = next === "home" ? location.pathname : `#${next}`;
  if (how === "push") history.pushState({ view: next }, "", url);
  else if (how === "replace") history.replaceState({ view: next }, "", url);
  render();
}

window.addEventListener("popstate", (e) => {
  const wanted = (e.state?.view as View | undefined) ?? "home";
  view = paper ? wanted : "home";
  if (view === "read" && column === null) view = "page";
  showOriginal = false;
  wantFocus = true;
  render();
});

function render() {
  stopDrawings();
  main.replaceChildren();
  document.body.dataset.view = view;
  if (view === "home" || !paper) renderHome();
  else if (view === "page") void renderPage(paper);
  else void renderRead(paper);
}

// ---------- Home ----------

function renderHome() {
  document.title = "Column Reader: read one column of a newspaper PDF at a time";
  const openBtn = h(
    "button",
    { class: "btn btn-go btn-big", type: "button", onclick: () => fileInput.click(), disabled: busy },
    busy ? "Opening…" : paper ? "Open another PDF" : "Open a PDF",
  );
  main.append(
    h(
      "header",
      { class: "masthead" },
      h("h1", {}, "Column Reader"),
      h(
        "p",
        { class: "lead" },
        "Read a newspaper or magazine PDF on your phone, one column at a time. Tap the article you want, and its text is laid out to fit your screen at a size you like.",
      ),
    ),
    noticeEl() ?? "",
    error
      ? h(
          "div",
          { class: "error", role: "alert" },
          h("p", {}, error),
          errorReload
            ? h("button", { class: "btn", type: "button", onclick: () => location.reload() }, "Reload the page")
            : null,
        )
      : "",
    h(
      "div",
      { class: "open-row" },
      paper
        ? h(
            "p",
            { class: "continue" },
            "You have ",
            h("strong", {}, paper.name),
            " open. ",
            h("button", { class: "btn btn-go", type: "button", onclick: () => go("page") }, "Keep reading"),
          )
        : null,
      openBtn,
      h("p", { class: "hint" }, "Your PDF stays on this device. It is never uploaded."),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "how" },
      h("h2", { id: "how" }, "How it works"),
      h(
        "ol",
        {},
        h("li", {}, "Open the PDF of your paper or magazine."),
        h("li", {}, "Tap the column you want to read."),
        h("li", {}, "Read it at a comfortable size. ", h("strong", {}, "Next column"), " keeps you going."),
      ),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "know" },
      h("h2", { id: "know" }, "Good to know"),
      h(
        "ul",
        {},
        h(
          "li",
          {},
          "It works with PDFs that have real text in them, like most papers you download. A scanned or photographed page is only a picture, so there's no text to pick out.",
        ),
        h(
          "li",
          {},
          "Pages with clearly separated columns work best. On busy pages the text can come out in the wrong order. ",
          h("strong", {}, "Show the original"),
          " is always there when it looks wrong.",
        ),
        h(
          "li",
          {},
          "It remembers which page you were on in each paper, so you can pick up where you left off.",
        ),
        h(
          "li",
          {},
          "After the first visit it works without internet. You can add it to your home screen from your browser's menu.",
        ),
      ),
    ),
    footer({ wish: true }),
  );
  if (busy) openBtn.setAttribute("aria-busy", "true");
  if (wantFocus) focusHeading();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) void openFile(file);
});

// Desktop: drop a PDF anywhere on the page.
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  e.preventDefault();
  void openFile(file);
});

const SCANNED =
  "This PDF has no text in it. It looks like scans or photos of pages, so there's no text to lay out. Column Reader only works with PDFs that contain real text.";

async function openFile(file: File) {
  if (busy) return;
  error = "";
  errorReload = false;
  if (file.size > MAX_BYTES) {
    error = "That file is too big to open on most phones (over 250 MB). Try a smaller edition or a single section.";
    go("home", view === "home" ? "replace" : "push");
    return;
  }
  busy = true;
  const fromHome = view === "home";
  if (!fromHome) go("home");
  else render();
  announce("Opening your PDF…");
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await openPdf(data);
    if (paper) void paper.doc.loadingTask.destroy();
    const key = paperKey(file.name, file.size, doc.numPages);
    const opened: Paper = { doc, name: file.name.replace(/\.pdf$/i, "") || "Your PDF", key, pages: doc.numPages };
    paper = opened;
    // In the background, find where the text starts (usually page 1, so this is
    // cheap); pages before it, or a PDF with no text at all, get a plain message.
    void firstPageWithText(doc.numPages, async (n) => paper === opened && (await pageLayout(doc, n)).hasText).then(
      (first) => {
        if (paper !== opened) return;
        opened.textFrom = first;
        onTextCheckDone?.();
      },
    );
    const place = memory.papers[key];
    pageNo = place ? Math.min(place.page, doc.numPages) : 1;
    column = null;
    zoom = 1;
    notice = place && pageNo > 1 ? `Welcome back. You were on page ${pageNo}.` : "";
    busy = false;
    remember();
    wantFocus = true;
    go("page", fromHome ? "push" : "replace");
  } catch (err) {
    console.error(err);
    busy = false;
    const kind = err instanceof PdfOpenError ? err.kind : (err as Error)?.message;
    errorReload = kind === "app-broken";
    error =
      kind === "app-broken"
        ? "Part of Column Reader didn't load, maybe because it was updated while this page was open. Reload the page to fix it."
        : kind === "password"
          ? "This PDF is locked with a password, and Column Reader can't open locked PDFs. If you can, download a copy without a password."
          : kind === "not-pdf"
            ? "That file couldn't be opened as a PDF. It may be damaged or not a PDF. Try downloading it again."
            : "Something went wrong opening that PDF. Try again, or try downloading it again.";
    render();
    announce(error);
  }
}

// ---------- Page ----------

function pager(p: Paper) {
  const select = h(
    "select",
    {
      "aria-label": "Go to page",
      onchange: (e: Event) => setPage(p, Number((e.target as HTMLSelectElement).value)),
    },
    ...Array.from({ length: p.pages }, (_, i) =>
      h("option", { value: i + 1, selected: i + 1 === pageNo }, `Page ${i + 1} of ${p.pages}`),
    ),
  );
  return h(
    "nav",
    { class: "pager", "aria-label": "Pages" },
    h(
      "button",
      {
        class: "btn",
        type: "button",
        "aria-label": "Previous page",
        disabled: pageNo <= 1,
        onclick: () => setPage(p, pageNo - 1),
      },
      h("span", { "aria-hidden": "true" }, "← "),
      "Previous",
    ),
    select,
    h(
      "button",
      {
        class: "btn",
        type: "button",
        "aria-label": "Next page",
        disabled: pageNo >= p.pages,
        onclick: () => setPage(p, pageNo + 1),
      },
      "Next",
      h("span", { "aria-hidden": "true" }, " →"),
    ),
  );
}

function setPage(p: Paper, n: number) {
  if (n < 1 || n > p.pages) return;
  pageNo = n;
  column = null;
  remember();
  wantFocus = true;
  announce(`Page ${n} of ${p.pages}`);
  // From a column, go back to the page screen rather than stacking a new one.
  if (view === "read") history.back();
  else go("page", "replace");
}

/** Positions an element over a block, in % of the page so it scales with zoom. */
function placeOver(el: HTMLElement, b: Block, layout: PageLayout) {
  const pad = 0.2 * b.size;
  const left = Math.max(0, b.left - pad);
  const top = Math.max(0, b.top - pad);
  const right = Math.min(layout.width, b.right + pad);
  const bottom = Math.min(layout.height, b.bottom + pad);
  el.style.left = `${(left / layout.width) * 100}%`;
  el.style.top = `${(top / layout.height) * 100}%`;
  el.style.width = `${((right - left) / layout.width) * 100}%`;
  el.style.height = `${((bottom - top) / layout.height) * 100}%`;
}

async function renderPage(p: Paper) {
  document.title = `Page ${pageNo}: ${p.name} · Column Reader`;
  const heading = h("h1", { class: "page-title" }, `Page ${pageNo} of ${p.pages}`);
  const status = h("p", { class: "hint", role: "status" }, "Loading the page…");
  const frame = h("div", { class: "page-frame" });
  const scroller = h("div", { class: zoom > 1 ? "page-scroll zoomed" : "page-scroll" }, frame);
  main.append(
    h(
      "div",
      { class: "topbar" },
      h("button", { class: "btn btn-quiet", type: "button", onclick: () => go("home") }, "Open another PDF"),
      h("p", { class: "paper-name" }, p.name),
    ),
    heading,
    noticeEl() ?? "",
    status,
    pager(p),
    scroller,
    h(
      "div",
      { class: "page-tools" },
      h(
        "button",
        {
          class: "btn btn-quiet",
          id: "zoom",
          type: "button",
          "aria-pressed": zoom > 1 ? "true" : "false",
          onclick: () => {
            zoom = zoom > 1 ? 1 : 2;
            focusZoom = true;
            render();
          },
        },
        zoom > 1 ? "Make the page smaller" : "Make the page bigger",
      ),
    ),
    pager(p),
    footer(),
  );
  // Coming back from a column: focus that column's button once it exists.
  const focusColumn = wantFocus && column !== null;
  if (wantFocus) focusHeading();
  if (focusZoom) {
    focusZoom = false;
    document.getElementById("zoom")?.focus({ preventScroll: true });
  }
  const noTextBox = h("div", { class: "warn", role: "status", hidden: true });
  status.after(noTextBox);

  const thisPage = pageNo;
  let layout: PageLayout;
  let pdfPage;
  try {
    [layout, pdfPage] = await Promise.all([pageLayout(p.doc, thisPage), p.doc.getPage(thisPage)]);
  } catch {
    status.textContent = "This page couldn't be read. It may be damaged. Try another page.";
    return;
  }
  if (view !== "page" || pageNo !== thisPage || paper !== p) return;

  const cssWidth = Math.min(contentWidth(), 1000) * zoom;
  frame.style.width = `${cssWidth}px`;
  frame.style.aspectRatio = `${layout.width} / ${layout.height}`;
  const canvas = h("canvas", { "aria-hidden": "true" });
  frame.append(canvas);
  const drawing = drawPage(pdfPage, canvas, cssWidth);
  cancelDrawings.push(drawing.cancel);

  if (!layout.hasText) {
    status.hidden = true;
    const showNoText = () => {
      noTextBox.hidden = false;
      if (p.textFrom === null) {
        noTextBox.replaceChildren(h("p", {}, SCANNED));
        return;
      }
      const msg =
        "This page has no text to pick out. It looks like a picture or a scan of a page, so Column Reader can't lay it out.";
      const first = p.textFrom;
      noTextBox.replaceChildren(
        h("p", {}, first ? `${msg} The first page with text is page ${first}.` : `${msg} Try another page.`),
        first && first !== thisPage
          ? h("button", { class: "btn", type: "button", onclick: () => setPage(p, first) }, `Go to page ${first}`)
          : "",
      );
    };
    showNoText();
    onTextCheckDone = () => {
      if (view === "page" && pageNo === thisPage && paper === p && noTextBox.isConnected) showNoText();
    };
  } else {
    status.textContent = "Tap the column you want to read.";
    const overlay = h("div", { class: "blocks", role: "list", "aria-label": "Columns on this page, in reading order" });
    const byArea = [...layout.blocks].sort(
      (a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top),
    );
    for (const b of layout.blocks) {
      const btn = h(
        "button",
        {
          type: "button",
          class: b.index === column ? "block last-read" : "block",
          "aria-label": `Column ${b.index + 1} of ${layout.blocks.length}: ${preview(b)}`,
          onclick: () => openColumn(b.index),
        },
      );
      placeOver(btn, b, layout);
      btn.style.zIndex = String(1 + byArea.indexOf(b));
      overlay.append(h("div", { role: "listitem" }, btn));
    }
    frame.append(overlay);
    if (focusColumn) overlay.querySelector<HTMLButtonElement>(".last-read")?.focus();
    // A tap between columns picks the nearest one, if it's close.
    frame.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      const rect = frame.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * layout.width;
      const y = ((e.clientY - rect.top) / rect.height) * layout.height;
      const b = blockAt(layout.blocks, x, y);
      if (b) openColumn(b.index);
      else announce("There's no text right there. Tap on the words you want to read.");
    });
  }
  try {
    await drawing.done;
  } catch {
    if (layout.hasText) status.textContent = "The picture of this page couldn't be drawn, but you can still tap its columns.";
  }
}

function openColumn(index: number) {
  column = index;
  showOriginal = false;
  remember();
  wantFocus = true;
  go("read", view === "read" ? "replace" : "push");
}

// ---------- Reading ----------

function setTextSize(dir: 1 | -1) {
  memory = { ...memory, textSize: stepSize(memory.textSize, dir) };
  saveMemory(memory);
  const text = main.querySelector<HTMLElement>(".reflow");
  if (text) text.style.fontSize = `${memory.textSize}px`;
  updateSizeButtons();
  announce(`Text size ${TEXT_SIZES.indexOf(memory.textSize as (typeof TEXT_SIZES)[number]) + 1} of ${TEXT_SIZES.length}`);
}

function updateSizeButtons() {
  const smaller = document.getElementById("smaller") as HTMLButtonElement | null;
  const bigger = document.getElementById("bigger") as HTMLButtonElement | null;
  if (smaller) smaller.disabled = memory.textSize <= TEXT_SIZES[0];
  if (bigger) bigger.disabled = memory.textSize >= TEXT_SIZES[TEXT_SIZES.length - 1];
}

async function renderRead(p: Paper) {
  const thisPage = pageNo;
  let layout: PageLayout;
  try {
    layout = await pageLayout(p.doc, thisPage);
  } catch {
    go("page", "replace");
    return;
  }
  if (view !== "read" || pageNo !== thisPage || paper !== p) return;
  const block = layout.blocks[column ?? -1];
  if (!block) {
    go("page", "replace");
    return;
  }
  const total = layout.blocks.length;
  document.title = `Page ${thisPage}, column ${block.index + 1}: ${p.name} · Column Reader`;

  const bar = h(
    "div",
    { class: "readbar" },
    h(
      "button",
      { class: "btn", type: "button", onclick: () => history.back() },
      h("span", { "aria-hidden": "true" }, "← "),
      "Back to the page",
    ),
    h(
      "div",
      { class: "sizes", role: "group", "aria-label": "Text size" },
      h(
        "button",
        { class: "btn size-btn", id: "smaller", type: "button", "aria-label": "Smaller text", onclick: () => setTextSize(-1) },
        h("span", { "aria-hidden": "true", class: "small-a" }, "A"),
        h("span", { "aria-hidden": "true" }, "−"),
      ),
      h(
        "button",
        { class: "btn size-btn", id: "bigger", type: "button", "aria-label": "Bigger text", onclick: () => setTextSize(1) },
        h("span", { "aria-hidden": "true", class: "big-a" }, "A"),
        h("span", { "aria-hidden": "true" }, "+"),
      ),
    ),
  );

  // A small picture of the page with the picked column marked.
  const thumbFrame = h("div", { class: "thumb-frame" });
  const thumb = h(
    "button",
    {
      class: "thumb",
      type: "button",
      "aria-label": "Where this column is on the page. Go back to the page.",
      onclick: () => history.back(),
    },
    thumbFrame,
  );

  const original = h("figure", { class: "original", hidden: !showOriginal });
  const toggle = h(
    "button",
    {
      class: "btn btn-quiet",
      type: "button",
      "aria-expanded": showOriginal ? "true" : "false",
      onclick: () => {
        showOriginal = !showOriginal;
        original.hidden = !showOriginal;
        toggle.setAttribute("aria-expanded", String(showOriginal));
        toggle.textContent = showOriginal ? "Hide the original" : "Show the original";
        if (showOriginal) void drawOriginal();
      },
    },
    showOriginal ? "Hide the original" : "Show the original",
  );

  const paras = paragraphs(block);
  const text = h(
    "article",
    { class: "reflow", "aria-labelledby": "col-title" },
    ...paras.map((t) => h("p", {}, t)),
  );
  text.style.fontSize = `${memory.textSize}px`;

  const isLast = block.index >= total - 1;
  const isFirst = block.index <= 0;
  const nav = h(
    "nav",
    { class: "colnav", "aria-label": "Columns" },
    isFirst
      ? thisPage > 1
        ? h("button", { class: "btn", type: "button", onclick: () => setPage(p, thisPage - 1) }, "← Previous page")
        : h("span")
      : h(
          "button",
          { class: "btn", type: "button", onclick: () => openColumn(block.index - 1) },
          h("span", { "aria-hidden": "true" }, "← "),
          "Previous column",
        ),
    isLast
      ? thisPage < p.pages
        ? h("button", { class: "btn btn-go", type: "button", onclick: () => setPage(p, thisPage + 1) }, "Next page →")
        : h("span", { class: "hint" }, "End of the paper")
      : h(
          "button",
          { class: "btn btn-go", type: "button", onclick: () => openColumn(block.index + 1) },
          "Next column",
          h("span", { "aria-hidden": "true" }, " →"),
        ),
  );

  main.append(
    bar,
    h(
      "div",
      { class: "read-head" },
      h(
        "div",
        {},
        h(
          "h1",
          { id: "col-title", class: "read-title" },
          `Page ${thisPage}`,
          h("span", { class: "visually-hidden" }, `, column ${block.index + 1} of ${total}`),
        ),
        h("p", { class: "paper-name" }, p.name),
        toggle,
      ),
      thumb,
    ),
    original,
    text,
    nav,
    h(
      "aside",
      { class: "card wrong" },
      h("h2", {}, "Does the text look mixed up?"),
      h(
        "p",
        {},
        "Busy pages can trip it up: lines may come out in the wrong order or mixed with the next column. Use ",
        h("strong", {}, "Show the original"),
        " to see this part as it was printed, or go back to the page and tap a different spot.",
      ),
    ),
    footer(),
  );
  updateSizeButtons();
  if (wantFocus) focusHeading();

  const pdfPage = await p.doc.getPage(thisPage);
  if (view !== "read" || paper !== p) return;
  // Thumbnail with the column marked.
  const thumbWidth = 96;
  thumbFrame.style.width = `${thumbWidth}px`;
  thumbFrame.style.aspectRatio = `${layout.width} / ${layout.height}`;
  const thumbCanvas = h("canvas", { "aria-hidden": "true" });
  const mark = h("span", { class: "mark", "aria-hidden": "true" });
  placeOver(mark, block, layout);
  thumbFrame.append(thumbCanvas, mark);
  const t = drawPage(pdfPage, thumbCanvas, thumbWidth);
  cancelDrawings.push(t.cancel);

  async function drawOriginal() {
    if (original.querySelector("canvas")) return;
    const pad = 0.4 * block.size;
    const region = {
      left: Math.max(0, block.left - pad),
      top: Math.max(0, block.top - pad),
      width: Math.min(layout.width, block.right + pad) - Math.max(0, block.left - pad),
      height: Math.min(layout.height, block.bottom + pad) - Math.max(0, block.top - pad),
    };
    const c = h("canvas", { role: "img", "aria-label": "This column as it was printed" });
    original.replaceChildren(c, h("figcaption", {}, "This column as it was printed on the page."));
    const width = Math.min(contentWidth(), 760);
    const d = drawPage(pdfPage, c, width, region);
    cancelDrawings.push(d.cancel);
    await d.done.catch(() => {
      original.replaceChildren(h("p", { class: "error" }, "The original couldn't be drawn. Go back to the page to see it."));
    });
  }
  if (showOriginal) void drawOriginal();
  await t.done.catch(() => {});
}

// Arrow keys move between columns while reading.
document.addEventListener("keydown", (e) => {
  if (view !== "read" || !paper || column === null || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const target = e.target as HTMLElement;
  if (target.closest("input, select, textarea")) return;
  if (e.key === "ArrowRight") main.querySelector<HTMLButtonElement>(".colnav .btn-go")?.click();
  if (e.key === "ArrowLeft") main.querySelector<HTMLButtonElement>(".colnav .btn:not(.btn-go)")?.click();
});

// Redraw the page when the screen turns or the window is resized.
let lastWidth = window.innerWidth;
let resizeTimer = 0;
window.addEventListener("resize", () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (view === "page") render();
  }, 250);
});

history.replaceState({ view: "home" }, "", location.pathname);
render();
// Load the PDF reader's worker now, with the rest of this version of the app.
startWorker();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline support is a bonus; the app works without it */
    });
  });
}
