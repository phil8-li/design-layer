/**
 * How the Changes tab states an edit: the rows, the empty state, and Copy.
 *
 * Every edit is a note for the agent now, whether or not a Tailwind class
 * could spell it, so a translatable change and an untranslatable one read the
 * same. These cases came from `stranded-write-cases.mjs`, which pinned the
 * ledger of writes "Apply to code" could not make; the ledger is gone with
 * Apply, and what was left about rows is here: an icon swap and a CSS property
 * do not read the same, an empty side is spelled rather than left blank, a
 * row's own remove drops that row alone, no row prints an absolute path, and
 * the bytes Copy writes are the brief for the rows on screen.
 * `annotation-cases.mjs` owns the stores and the brief underneath them.
 *
 * Usage: node designlayer/test/outbox-rows-cases.mjs
 */
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR as PACKAGE } from "./host.mjs"

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom
window.document.elementsFromPoint = () => []
globalThis.DOMMatrixReadOnly = class {
  constructor() {
    this.m41 = 0
    this.m42 = 0
  }
}
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "SVGSVGElement",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

// One bundle, because the journal is module state: a writer and an outbox tab
// imported from two builds would each get their own and the end-to-end cases
// would pass while the product stayed broken.
const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { resetSourceResolutionCache } from "./src/core/bridge"
      export { createWriter } from "./src/core/writer"
      export { createContext } from "./src/core/context"
      export { annotationsTab } from "./src/panels/inspector/tab-annotations"
      export { addAnnotation, resetAnnotationsForTest } from "./src/annotations/store"
      export { clearEdits, recordEdit, resetJournalForTest } from "./src/annotations/journal"
      export { buildAnnotationBrief } from "./src/annotations/output"
    `,
    resolveDir: PACKAGE,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "silent",
})
const {
  resetSourceResolutionCache,
  createWriter,
  createContext,
  annotationsTab,
  addAnnotation,
  resetAnnotationsForTest,
  clearEdits,
  recordEdit,
  resetJournalForTest,
  buildAnnotationBrief,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

/** Source resolution is a promise chain; nothing is decided in the same task. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/**
 * The patched vendor's shape, with the two answers the real one gives:
 * `elementInfo` is populated but its `filePath` is empty, exactly as React 19.2
 * leaves it, and everything true comes from the async twin.
 */
function makeBridge({ asyncInfo = null, discovered = null, componentName = "Fixture" } = {}) {
  const toasts = []
  const store = { setActiveTool() {} }
  return {
    toasts,
    store,
    discoverCalls: [],
    elementInfo() {
      return {
        tagName: "div",
        componentName,
        filePath: "",
        lineNumber: 0,
        columnNumber: 0,
        stack: [],
      }
    },
    async elementSourceAsync() {
      return asyncInfo
    },
    async discoverFile(name) {
      this.discoverCalls.push(name)
      return discovered
    },
    send() {},
    subscribe: () => () => {},
    toast(message) {
      toasts.push(message)
    },
  }
}

function mount(html) {
  const host = window.document.getElementById("app")
  host.innerHTML = html
  return host.firstElementChild
}

function selectionFor(element, componentName = "Fixture") {
  return {
    element,
    tagName: element.tagName.toLowerCase(),
    componentName,
    source: null,
    key: `${componentName}:${element.tagName}`,
  }
}

/** A file the resolver can actually place an element in. */
const RESOLVED = {
  tagName: "button",
  componentName: "Fixture",
  filePath: "src/Fixture.tsx",
  lineNumber: 4,
  columnNumber: 6,
  stack: [],
}

/**
 * The stores, all module-scoped, all reset between cases.
 *
 * `localStorage` is emptied as well as the notes: `resetAnnotationsForTest`
 * drops what is in memory and deliberately leaves what is on disk, so the very
 * next `annotations()` reloads the note the previous case persisted and the
 * case after that is reading someone else's outbox.
 */
function begin() {
  resetSourceResolutionCache()
  resetJournalForTest()
  resetAnnotationsForTest()
  window.localStorage.clear()
}

// --- the outbox the user is actually looking at ----------------------------

/*
 * One tab, built once and shared by every case below.
 *
 * It subscribes to the annotation store and the edit journal at construction,
 * and that subscription is itself under test: nothing in the product calls
 * `update()` when a write lands, so a case that repainted by hand would pass
 * on a tab that never redraws. The reset seams in `begin()` do not announce —
 * they are a reset, not an edit — so `reset()` below is the one explicit
 * repaint a case gets, and everything after it has to arrive on its own.
 */
const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const right = slot()
const panel = createContext(makeBridge(), {
  overlay: slot(),
  toolbar: slot(),
  left: slot(),
  right,
})
const tab = annotationsTab(panel)
right.append(tab.node)

/** The last thing written to the clipboard, or null since it was reset. */
let copied = null
Object.defineProperty(window.navigator, "clipboard", {
  value: { writeText: (text) => ((copied = text), Promise.resolve()) },
  configurable: true,
})

const click = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
const rows = () => Array.from(tab.node.querySelectorAll(".de-ann-item"))
/** A row's first body line: what the edit did, or what the note says. */
const said = (row) => row.querySelector(".de-ann-item-body").firstElementChild.textContent.trim()
/**
 * Where it happened — read off the row's TOOLTIP, because the row is one line.
 *
 * It was a second line under the first, printed on every row of a 260px column
 * and saying something the reader did not write and cannot act on. The string
 * stayed, on the `title` of the line, which is also where these cases still
 * have to look: a path leaking into a tooltip on a shared screen leaks just as
 * hard as one leaking into the text.
 */
const where = (row) =>
  (row.querySelector(".de-ann-item-line").getAttribute("title") ?? "").split("\n").pop().trim()
const badges = (row) => Array.from(row.querySelectorAll(".de-ann-badge")).map((b) => b.textContent.trim())
const rowSaying = (prefix) => rows().find((row) => said(row).startsWith(prefix)) ?? null
const button = (label) =>
  Array.from(tab.node.querySelectorAll("button")).find((node) => node.textContent.trim() === label) ??
  null

function reset() {
  begin()
  copied = null
  tab.update()
}

/** An edit the journal can hold, without a writer to produce it. */
function journal(property, from, to, element = mount('<button class="rounded px-3">Go</button>')) {
  return recordEdit({ property, from, to, element })
}

await check("SW-08 a write no utility class can spell is a row that says so, unasked", async () => {
  reset()
  assert.ok(tab.node.textContent.includes("Pin a note or make an edit."), "the tab did not start empty")

  const element = mount('<button class="rounded px-3">Go</button>')
  // `transform` is what a drag and an arrow-nudge both write, and it has no
  // utility class: the brief can name no class swap for it, and it is a note
  // all the same.
  createWriter(makeBridge({ asyncInfo: RESOLVED })).applyStyles(
    selectionFor(element),
    [{ property: "transform", value: "translate(4px, 0px)" }],
    "Move"
  )
  await settle()

  // No second `tab.update()`. The journal announces, the tab is subscribed, and
  // in the product there is nobody to ask for the repaint by hand.
  assert.equal(rows().length, 1, "the change is on screen and the outbox denies it")
  assert.ok(
    !tab.node.textContent.includes("Pin a note or make an edit."),
    "the empty state outlived the change it was denying"
  )
  const row = rows()[0]
  // A note the editor wrote, in words, with no state badge: every edit goes
  // to the agent, so there is no state left to report.
  assert.equal(said(row), "Move it 4px right")
  assert.deepEqual(badges(row), [])
})

await check("SW-09 a writable edit and an unwritable one read the same: both are notes", async () => {
  reset()
  const element = mount('<button class="rounded px-3">Go</button>')
  const writer = createWriter(makeBridge({ asyncInfo: RESOLVED }))
  writer.applyStyles(selectionFor(element), [{ property: "opacity", value: "0.5" }], "Opacity")
  writer.applyStyles(selectionFor(element), [{ property: "filter", value: "blur(2px)" }], "Blur")
  await settle()

  /*
   * `opacity` has a utility class and `filter` has none. That split used to
   * decide whether the row read Ready or Needs the agent. The editor writes
   * neither now, so both rows are the same kind of note.
   */
  for (const prefix of ["Change the opacity", "Add a layer blur"]) {
    const row = rowSaying(prefix)
    assert.ok(row, `no row for ${prefix}`)
    assert.deepEqual(badges(row), [])
    assert.ok(!row.classList.contains("de-ann-item--written"))
  }
  assert.ok(!tab.node.textContent.includes("Ready"), "a row still claims the editor will write it")
  assert.ok(!tab.node.textContent.includes("In your files"))
})

await check("SW-10 a sentinel reads as what it is, not as a CSS declaration", () => {
  reset()
  // `icon`, `class`, `text` and `remove` are `EditRecord`'s sentinels. Printed
  // raw they send the reader to the stylesheet looking for a property nobody
  // ever wrote there.
  journal("icon", "Star", "Heart", mount("<svg></svg>"))
  journal("class", "btn btn--outlined", "btn btn--filled")
  journal("text", "Save", "Save changes")
  journal("remove", "<div>", "")

  assert.equal(said(rowSaying("Swap the icon")), "Swap the icon to Heart (was Star)")
  assert.equal(rowSaying("icon"), null, "the glyph swap is still labelled as a property")
  assert.equal(said(rowSaying("Replace the class")), "Replace the class btn--outlined with btn--filled")
  assert.equal(said(rowSaying("Change the text")), "Change the text to “Save changes” (was “Save”)")
  assert.equal(said(rowSaying("Delete")), "Delete this element")
})

await check("SW-11 a row's remove drops that row and leaves the rest standing", () => {
  reset()
  journal("icon", "Star", "Heart", mount("<svg></svg>"))
  journal("opacity", "1", "0.5")
  assert.equal(rows().length, 2)

  // The X on one row discards that edit and nothing else.
  click(rowSaying("Swap the icon").querySelector(".de-mini--danger"))

  // Again no `update()`: the row's own handler mutates the journal and leaves
  // the repaint to it, so a broken subscription shows up here as a row the
  // user deleted and is still looking at.
  assert.equal(rows().length, 1)
  assert.equal(rowSaying("Swap the icon"), null)
  assert.ok(rowSaying("Change the opacity"), "removing one row took the other with it")
})

await check("SW-12 emptying the outbox lands on the empty state, not on nothing", () => {
  reset()
  journal("opacity", "1", "0.5")
  assert.equal(rows().length, 1)

  clearEdits()

  assert.deepEqual(rows(), [])
  assert.ok(tab.node.querySelector(".de-ann-empty"), "an emptied list left the panel blank")
  // ONE LINE, and it is the way in rather than the fact of the emptiness. The
  // headline that used to sit above this ("Nothing to hand over yet.") said
  // only what a visibly empty box has already said, and the sentence that used
  // to sit below it spent three wrapped lines of a 260px panel restating the
  // two gestures the toolbar offers. Asserted as an absence too, so the cut
  // cannot be quietly undone.
  assert.match(tab.node.textContent, /Pin a note or make an edit\./)
  assert.ok(
    !tab.node.textContent.includes("Nothing to hand over yet."),
    "the empty state grew its headline back"
  )
  assert.equal(tab.node.querySelectorAll(".de-ann-empty > div").length, 1, "more than one line of copy")
  // And NOTHING heads it. Both outbox sections leave the document while they
  // hold nothing, so an empty session is that sentence rather than two headings
  // over two blank bodies — and no tally is left anywhere to announce a zero.
  assert.deepEqual(
    Array.from(tab.node.querySelectorAll(".de-section-title")).map((node) => node.textContent.trim()),
    ["MCP", "Settings"]
  )
  assert.equal(tab.node.querySelector(".de-ann-count"), null, "the tally came back")
  /*
   * EVERY BUTTON LEAVES WITH THE THING IT ACTS ON, and there is no exception
   * any more.
   *
   * Send and Copy used to be the exception, present and greyed out on
   * the grounds that a control which vanishes leaves the designer wondering
   * where the handover went. Over an EMPTY session there is no handover to
   * wonder about — the one line asserted above says exactly that — and three
   * refusing controls under it were three things to read past to reach it.
   *
   * Copy is checked by its row rather than by its name, because the MCP
   * address has a Copy of its own and the MCP section does not leave. A
   * sweep for the word would find that one and report the outbox's as present.
   */
  assert.equal(tab.node.querySelector(".de-ann-ctas"), null, "the handover row survived")
  assert.equal(button("Send to agent"), null, "an empty outbox can still be sent")
})

await check("SW-13 no row carries an absolute path, in its text or in its title", () => {
  reset()
  // A note, because an edit's target is described inside the write and never
  // carries a path at all — see `describeEditTarget`. This is the only row
  // that can leak one, and the panel may well be on a shared screen.
  addAnnotation({
    kind: "element",
    comment: "This card is too tight",
    url: "http://localhost/",
    rect: { x: 0, y: 0, width: 100, height: 40 },
    selectedText: null,
    target: {
      tagName: "div",
      componentName: "Card",
      className: "rounded-xl",
      id: null,
      selector: "div.rounded-xl",
      text: "Card",
      filePath: "/Users/someone/app/src/components/card.tsx",
      lineNumber: 12,
      ancestry: [],
      computed: {},
      components: [],
    },
  })

  assert.equal(rows().length, 1)
  assert.equal(where(rows()[0]), "Card · card.tsx:12")
  assert.ok(!tab.node.textContent.includes("/Users/someone"), "an absolute path reached the panel")
  for (const node of tab.node.querySelectorAll("[title]")) {
    assert.ok(
      !(node.getAttribute("title") ?? "").includes("/Users/someone"),
      "an absolute path reached a tooltip"
    )
  }
})

await check("SW-14 Copy writes the brief for the rows on screen, and writes it synchronously", async () => {
  reset()
  const element = mount('<button class="rounded px-3">Go</button>')
  createWriter(makeBridge()).applyStyles(
    selectionFor(element),
    [{ property: "transform", value: "translate(4px, 0px)" }],
    "Move"
  )
  await settle()
  assert.equal(rows().length, 1)

  click(button("Copy"))

  // Synchronously, before anything awaits: the Clipboard API only works under
  // the transient activation the click carries, and the browser revokes it the
  // moment the handler yields.
  assert.ok(copied, "nothing was written to the clipboard in the click task")
  // Byte-for-byte the brief the outbox would build for itself. The panel and
  // the clipboard describing the same session differently is the failure that
  // makes reading either of them worthless.
  assert.equal(copied, buildAnnotationBrief())
  assert.match(copied, /transform/, "the row is on screen and the brief does not mention it")
  assert.match(copied, /None of them is in the source yet/, "an edit is the work, and must read as it")
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
