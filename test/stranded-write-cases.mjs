/**
 * The writes that reach the screen and nothing else.
 *
 * `apply-source-cases.mjs` pins the happy path: the async resolver finds the
 * file, the operation queues, jscodeshift rewrites the JSX. This suite pins
 * what happens when that path comes up empty — which on a React 19 page is
 * often. The sync walk always answers `filePath: ""`, the owner-stack resolver
 * hands back a bundler chunk roughly half the time, `isProjectSourcePath`
 * rejects it, and the engine itself refuses operations it cannot locate in
 * source.
 *
 * Every one of those used to end in silence. The user picked a colour in the
 * right panel, the element changed, `hasChanges()` stayed false so "Apply to
 * code" could not write it, nothing was recorded anywhere, and the next hot
 * reload ate it. There was no surface in the editor that admitted the change
 * existed.
 *
 * So the claim under test is narrow and total: a write that cannot reach source
 * lands in the ledger instead, exactly once, with a real from and a real to —
 * and a write that CAN reach source still does, leaving the ledger clean. The
 * second half matters as much as the first; an over-eager fix that stranded
 * everything would fill the outbox with changes that were already written.
 *
 * The last section drives the outbox tab, and holds the rendering claims the
 * deleted `prompts-tab-cases.mjs` used to own: an icon swap and a CSS property
 * do not read the same in a row, an empty side is spelled rather than left
 * blank, a row's own remove drops that row alone, no row prints an absolute
 * path, and the bytes Copy writes are the brief for the rows on screen. They
 * live here rather than dying with that suite because they are all claims
 * about how the editor states what it could not write, which is this suite's
 * subject. `annotation-cases.mjs` owns the stores and the brief underneath
 * them; nothing there renders a row.
 *
 * Usage: node designlayer/test/stranded-write-cases.mjs
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

// One bundle, because the ledger and the journal are both module state: a
// writer and an outbox tab imported from two builds would each get their own
// and the end-to-end cases would pass while the product stayed broken.
const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { resetSourceResolutionCache } from "./src/core/bridge"
      export { createWriter, untranslatedProperties } from "./src/core/writer"
      export {
        buildChangePrompt,
        previewOnlyChanges,
        clearPreviewOnly,
        recordPreviewOnly,
      } from "./src/core/change-prompt"
      export { createContext } from "./src/core/context"
      export { annotationsTab } from "./src/panels/inspector/tab-annotations"
      export { addAnnotation, resetAnnotationsForTest } from "./src/annotations/store"
      export {
        clearEdits,
        markEditsWritten,
        recordEdit,
        resetJournalForTest,
      } from "./src/annotations/journal"
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
  untranslatedProperties,
  buildChangePrompt,
  previewOnlyChanges,
  clearPreviewOnly,
  recordPreviewOnly,
  createContext,
  annotationsTab,
  addAnnotation,
  resetAnnotationsForTest,
  clearEdits,
  markEditsWritten,
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
 *
 * `reject` stands in for the engine refusing an operation whose JSX node it
 * cannot find — a throw, which the writer used to swallow.
 */
function makeBridge({
  asyncInfo = null,
  discovered = null,
  componentName = "Fixture",
  reject = false,
} = {}) {
  const queued = []
  const toasts = []
  const store = {
    addPendingPropertyOperation(mergeKey, operation, propertyKeys) {
      if (reject) throw new Error("no matching element in source")
      queued.push({ mergeKey, operation, propertyKeys })
    },
    buildBatchOperations() {
      return queued.map((entry) => entry.operation)
    },
    hasChanges() {
      return queued.length > 0
    },
    setActiveTool() {},
    onStateChange() {},
    getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
    viewportToPage: (x, y) => ({ x, y }),
    pageToViewport: (x, y) => ({ x, y }),
  }
  return {
    queued,
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
 * Three stores, all module-scoped, all reset between cases.
 *
 * `localStorage` is emptied as well as the notes: `resetAnnotationsForTest`
 * drops what is in memory and deliberately leaves what is on disk, so the very
 * next `annotations()` reloads the note the previous case persisted and the
 * case after that is reading someone else's outbox.
 */
function begin() {
  clearPreviewOnly()
  resetSourceResolutionCache()
  resetJournalForTest()
  resetAnnotationsForTest()
  window.localStorage.clear()
}

// --- a style write with nowhere to land ------------------------------------

await check("SW-01 an unresolvable style write queues nothing and lands in the ledger", async () => {
  begin()
  const element = mount('<button class="rounded px-3">Go</button>')
  // Nothing answers: no async frame, and the component grep finds no file.
  const bridge = makeBridge()
  createWriter(bridge).applyStyles(
    selectionFor(element),
    [{ property: "background-color", value: "#ff0000" }],
    "Background"
  )
  await settle()

  assert.equal(bridge.queued.length, 0, "an unresolved file cannot carry an operation")
  assert.equal(bridge.store.hasChanges(), false)
  const changes = previewOnlyChanges()
  assert.equal(changes.length, 1, "the change is on screen and in no list")
  assert.equal(changes[0].property, "background-color")
  // Read before the preview overwrote it, or the prompt states a from that is
  // already the to.
  assert.equal(changes[0].from, "rgba(0, 0, 0, 0)")
  assert.equal(changes[0].to, "#ff0000")
  assert.equal(changes[0].componentName, "Fixture")
  assert.equal(changes[0].filePath, null)
  assert.equal(element.style.getPropertyValue("background-color"), "rgb(255, 0, 0)")
})

await check("SW-02 the same write with a resolved file queues, and the ledger stays empty", async () => {
  begin()
  const element = mount('<button class="rounded px-3">Go</button>')
  const bridge = makeBridge({ asyncInfo: RESOLVED })
  createWriter(bridge).applyStyles(
    selectionFor(element),
    [{ property: "background-color", value: "#ff0000" }],
    "Background"
  )
  await settle()

  assert.equal(bridge.queued.length, 1)
  assert.equal(bridge.queued[0].operation.file, "src/Fixture.tsx")
  // The assertion that catches an over-eager fix: a change Apply to code will
  // write must never also be queued as something to hand to an agent.
  assert.deepEqual(previewOnlyChanges(), [])
  assert.deepEqual(untranslatedProperties(), [])
})

await check("SW-03 a bundler chunk strands rather than dispatching against a name the server cannot open", async () => {
  begin()
  const element = mount('<span class="chip">Chip</span>')
  const bridge = makeBridge({
    asyncInfo: {
      tagName: "span",
      componentName: "FolderChip",
      filePath: "src_components_workspace_space_0w_i7fl._.js",
      lineNumber: 953,
      columnNumber: 12,
      stack: [],
    },
    componentName: "FolderChip",
  })
  createWriter(bridge).applyStyles(
    selectionFor(element, "FolderChip"),
    [{ property: "background-color", value: "#00ff00" }],
    "Background"
  )
  await settle()

  assert.equal(bridge.queued.length, 0, "a chunk is not a file the writer may target")
  // The grep fallback was asked and had no answer, which is what makes this
  // element unresolvable rather than merely slow.
  assert.deepEqual(bridge.discoverCalls, ["FolderChip"])
  const changes = previewOnlyChanges()
  assert.equal(changes.length, 1)
  assert.equal(changes[0].property, "background-color")
  assert.equal(changes[0].to, "#00ff00")
})

await check("SW-04 an engine that rejects the operation strands it instead of swallowing it", async () => {
  begin()
  const element = mount('<button class="rounded px-3">Go</button>')
  // The file resolves; the AST walker simply cannot find the node in it.
  const bridge = makeBridge({ asyncInfo: RESOLVED, reject: true })
  createWriter(bridge).applyStyles(
    selectionFor(element),
    [{ property: "background-color", value: "#0000ff" }],
    "Background"
  )
  await settle()

  assert.equal(bridge.store.hasChanges(), false)
  const changes = previewOnlyChanges()
  assert.equal(changes.length, 1, "a refused operation used to end in an empty catch")
  assert.equal(changes[0].property, "background-color")
  assert.equal(changes[0].to, "#0000ff")
  // The path is known here, so the brief can name the file to fix by hand.
  assert.equal(changes[0].filePath, "src/Fixture.tsx")
})

// --- the class writes: variants, responsive, the design system -------------

await check("SW-05 an unresolvable class write is one class-attribute entry", async () => {
  begin()
  const element = mount('<button class="rounded bg-blue-500 px-3">Go</button>')
  const bridge = makeBridge()
  createWriter(bridge).applyClasses(
    selectionFor(element),
    { remove: ["bg-blue-500"], add: ["bg-red-500"] },
    "Background"
  )
  await settle()

  assert.equal(bridge.queued.length, 0)
  const changes = previewOnlyChanges()
  assert.equal(changes.length, 1, "one entry for the write, not one per token")
  assert.equal(changes[0].property, "class")
  assert.equal(changes[0].from, "rounded bg-blue-500 px-3")
  assert.equal(changes[0].to, "rounded px-3 bg-red-500")
  // Described by the list still standing in the JSX, which is the one an agent
  // will be searching for — the new list only exists in the browser.
  assert.equal(changes[0].className, "rounded bg-blue-500 px-3")

  const prompt = buildChangePrompt()
  assert.ok(prompt.includes("File not resolved"), prompt)
  assert.ok(prompt.includes("Search for `Fixture`"), prompt)
  assert.ok(prompt.includes("the class attribute becomes"), prompt)
  assert.ok(prompt.includes("rounded px-3 bg-red-500"), prompt)
  assert.ok(!prompt.includes("set `class` to"), prompt)
})

await check("SW-06 the Apply toast lists a stranded property but never class or icon", async () => {
  begin()
  const element = mount('<button class="rounded px-3">Go</button>')
  const bridge = makeBridge()
  const writer = createWriter(bridge)
  writer.applyStyles(
    selectionFor(element),
    [{ property: "background-color", value: "#ff0000" }],
    "Background"
  )
  writer.applyClasses(selectionFor(element), { remove: [], add: ["shadow-lg"] }, "Shadow")
  recordPreviewOnly({
    filePath: null,
    componentName: "Fixture",
    tagName: "svg",
    className: "size-4",
    property: "icon",
    from: "Star",
    to: "Heart",
  })
  await settle()

  assert.equal(previewOnlyChanges().length, 3)
  // The stranded CSS property belongs in the toast: it genuinely will not be
  // written. `class` and `icon` are not declarations and would read as ones.
  assert.deepEqual(untranslatedProperties(), ["background-color"])
})

await check("SW-07 re-editing a stranded property is one row, first from and latest to", async () => {
  begin()
  const element = mount('<button class="rounded px-3">Go</button>')
  const bridge = makeBridge()
  const writer = createWriter(bridge)
  const selection = selectionFor(element)
  // A colour field commits on every keystroke of a hex, and a slider on every
  // pointermove. Three rows for one decision is an outbox nobody reads.
  writer.applyStyles(selection, [{ property: "background-color", value: "#ff0000" }], "Background")
  await settle()
  writer.applyStyles(selection, [{ property: "background-color", value: "#00ff00" }], "Background")
  await settle()

  const changes = previewOnlyChanges()
  assert.equal(changes.length, 1, "the collapse is by element and property, not by write")
  // The first from, not the second: what the agent has to reproduce is the
  // distance from what is in the JSX to what is on screen now.
  assert.equal(changes[0].from, "rgba(0, 0, 0, 0)")
  assert.equal(changes[0].to, "#00ff00")
})

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
  return recordEdit({ property, from, to, element, written: false })
}

await check("SW-08 a write the translator cannot spell is a row that says so, unasked", async () => {
  reset()
  assert.ok(tab.node.textContent.includes("Pin a note or make an edit."), "the tab did not start empty")

  const element = mount('<button class="rounded px-3">Go</button>')
  // `transform` is what a drag and an arrow-nudge both write, and it has no
  // utility class — so it strands with the file perfectly resolvable, which is
  // the case that reads most like a bug: Apply to code is armed and this change
  // is not in it.
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
  assert.equal(said(row), "transform: none → translate(4px, 0px)")
  /*
   * One chip, not two. The "Edit" chip was removed: the row sits in a list
   * whose other kind is a typed sentence, and its own body reads
   * `transform: none → translate(4px, 0px)` in mono — it had no work left to
   * do in a 260px column. What must survive is the STATE, which is the one fact
   * here an agent acts on differently and which nothing else on the row says.
   */
  // "Needs the agent", not the old "Preview only". Both are true of this row,
  // but only one of them tells the designer what happens next: a `transform`
  // has no Tailwind spelling, so no amount of pressing Apply will ever write
  // it, and the row that says so is the only warning they get.
  assert.deepEqual(badges(row), ["Needs the agent"])
  assert.equal(previewOnlyChanges().length, 1, "the ledger is the other half of the same fact")
})

await check("SW-09 a row says which of THREE things is true of it, not two", async () => {
  reset()
  const element = mount('<button class="rounded px-3">Go</button>')
  const writer = createWriter(makeBridge({ asyncInfo: RESOLVED }))
  writer.applyStyles(selectionFor(element), [{ property: "opacity", value: "0.5" }], "Opacity")
  writer.applyStyles(selectionFor(element), [{ property: "filter", value: "blur(2px)" }], "Blur")
  await settle()

  /*
   * The two-state badge told a lie here for a version, and this case is what
   * catches it coming back.
   *
   * `opacity` becomes a utility class, so the writer marks it written THE
   * MOMENT THE EDIT IS MADE — before anything has been applied. Read straight
   * off `written`, the row announced "In source" for a change that was in no
   * file at all, and a designer who believed it had no reason to press Apply.
   * So the queued half is asked first: writable-and-still-owed is Ready, and
   * only a commit turns it into In your files.
   *
   * `filter` has no entry in `core/tailwind.ts`, so no commit will ever write
   * it. "Not yet" and "not ever" are different answers to the same question,
   * and collapsing them into one word is what the third state exists to stop.
   */
  assert.equal(badges(rowSaying("opacity")).at(-1), "Ready")
  assert.equal(badges(rowSaying("filter")).at(-1), "Needs the agent")

  // The commit landing is what moves the first one — and it must leave the
  // second alone. A row promoted here is a change the agent is then told to
  // skip, which is the one way this feature can lose work outright.
  markEditsWritten()
  await settle()
  assert.equal(badges(rowSaying("opacity")).at(-1), "In your files")
  assert.equal(
    badges(rowSaying("filter")).at(-1),
    "Needs the agent",
    "Apply promoted a change it never wrote"
  )

  // Said twice on purpose — in words and in a class the stylesheet tints —
  // because a tint alone is a fact nobody can read out loud.
  assert.ok(rowSaying("opacity").classList.contains("de-ann-item--written"))
  assert.ok(!rowSaying("filter").classList.contains("de-ann-item--written"))
})

await check("SW-10 a sentinel reads as what it is, not as a CSS declaration", () => {
  reset()
  // `icon`, `class`, `text` and `remove` are `change-prompt.ts`'s sentinels,
  // which `EditRecord` reuses on purpose. Printed raw they send the reader to
  // the stylesheet looking for a property nobody ever wrote there.
  journal("icon", "Star", "Heart", mount("<svg></svg>"))
  journal("class", "btn btn--outlined", "btn btn--filled")
  journal("text", "Save", "Save changes")
  journal("remove", "<div>", "")

  assert.equal(said(rowSaying("swap icon")), "swap icon: Star → Heart")
  assert.equal(rowSaying("icon:"), null, "the glyph swap is still labelled as a property")
  assert.ok(rowSaying("class attribute"), "the class write is still labelled as a property")
  assert.ok(rowSaying("text content"), "the text write is still labelled as a property")
  // The empty side is spelled rather than dropped: a row with a gap where a
  // value goes reads as a rendering bug, and "unset" is the actual claim.
  assert.equal(said(rowSaying("delete element")), "delete element: <div> → unset")
})

await check("SW-11 a row's remove drops that row and leaves the rest standing", () => {
  reset()
  journal("icon", "Star", "Heart", mount("<svg></svg>"))
  journal("opacity", "1", "0.5")
  assert.equal(rows().length, 2)

  // The X on one row. Dropping an edit from the outbox does not undo it, which
  // is why the button says so at length rather than saying "Remove".
  click(rowSaying("swap icon").querySelector(".de-mini--danger"))

  // Again no `update()`: the row's own handler mutates the journal and leaves
  // the repaint to it, so a broken subscription shows up here as a row the
  // user deleted and is still looking at.
  assert.equal(rows().length, 1)
  assert.equal(rowSaying("swap icon"), null)
  assert.ok(rowSaying("opacity"), "removing one row took the other with it")
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
   * "Apply to code" always did: it belongs to the edits section and is drawn
   * with it. Send and Copy used to be the exception, present and greyed out on
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
  assert.equal(button("Apply to code"), null, "an empty list still offers a write")
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
  assert.match(copied, /still needs writing/, "a preview-only change is the work, and must read as it")
})

// --- the ledger across a reload, and across an app switch ------------------

/*
 * A second bundle, for the cases that have to watch this module start up.
 *
 * Everything above shares ONE instance on purpose. These cases need the
 * opposite: a change-prompt module that has never read storage, evaluated
 * against a config that names a particular app, because what is under test is
 * what the ledger does when the page it was living on goes away. `config` is
 * read once at module load — see the note at the bottom of `core/config.ts` —
 * so an app switch can only be spelled here as a fresh evaluation.
 *
 * The suites above are the reason this matters beyond the chooser. Every one of
 * them proves a change reaches the ledger; not one of them could prove it was
 * still there a second later, because the ledger only ever lived in memory and
 * a reload is not something a module-scoped array can survive.
 */
const ledgerBundle = await build({
  stdin: {
    contents: `export * from "./src/core/change-prompt"`,
    resolveDir: PACKAGE,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "silent",
})

/** Two apps on one machine, which is the whole situation the chooser creates. */
const SHOP = "http://127.0.0.1:3000"
const DOCS = "http://127.0.0.1:4000"

let evaluations = 0

/**
 * The editor coming up on `appUrl`: a module that has read nothing yet, looking
 * at the same `localStorage` the last one wrote to.
 *
 * That is exactly what a switch is from the browser's side — the supervisor
 * binds the next editor to the proxy port the last one had, so the document,
 * the origin and the path are unchanged and only the app behind them moved.
 *
 * The counter is what makes each call a new module rather than the previous
 * one: a data URL is its own cache key, so two imports of identical bytes are
 * one module instance, and the second app would have inherited the first app's
 * ledger from memory without ever consulting storage.
 */
async function startEditor(appUrl) {
  globalThis.__DESIGNLAYER_CONFIG__ = { app: { url: appUrl, name: null } }
  evaluations += 1
  const source = `${ledgerBundle.outputFiles[0].text}\n//${evaluations}`
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
}

/** An icon swap: the plainest change that can never reach source on its own. */
const SWAP = {
  filePath: null,
  componentName: "Fixture",
  tagName: "svg",
  className: "size-4",
  property: "icon",
  from: "Star",
  to: "Heart",
}

await check("SW-15 a change recorded before a reload is still in the ledger after it", async () => {
  begin()
  const before = await startEditor(SHOP)
  before.recordPreviewOnly({ ...SWAP })

  // No second write, no flush, nothing the product would not have done: the
  // page simply goes away and comes back.
  const after = await startEditor(SHOP)
  const changes = after.previewOnlyChanges()
  assert.equal(changes.length, 1, "the only copy of this change was the page that just reloaded")
  // Field for field, not merely present. Every one of them is a string or a
  // null and a round trip through JSON must not quietly turn one into the
  // other — a `from` that came back as `undefined` prints as an empty side in
  // the prompt and reads as an element that started with nothing.
  assert.deepEqual(changes[0], SWAP)

  // The key the work is filed under, spelled out once: the prefix this module
  // owns, then the app, then the page.
  const stored = window.localStorage.getItem("designlayer.preview-only.http-127-0-0-1-3000:/")
  assert.ok(stored, "the ledger was persisted under a key nothing will ask for")
  assert.deepEqual(JSON.parse(stored), [SWAP])
})

await check("SW-16 work done in one app is not in the next app's outbox, and is waiting on the way back", async () => {
  begin()
  const shop = await startEditor(SHOP)
  shop.recordPreviewOnly({ ...SWAP, property: "background-color", from: "white", to: "#ff0000" })
  assert.equal(shop.previewOnlyChanges().length, 1)

  // The switch. One click in the chooser, no confirmation, same document.
  const docs = await startEditor(DOCS)
  assert.deepEqual(
    docs.previewOnlyChanges(),
    [],
    "the shop's outbox followed the designer to the docs site, describing elements that are not there"
  )
  docs.recordPreviewOnly({ ...SWAP, componentName: "Sidebar", to: "Book" })

  const back = await startEditor(SHOP)
  const changes = back.previewOnlyChanges()
  assert.equal(changes.length, 1, "switching away was indistinguishable from throwing the work out")
  assert.equal(changes[0].to, "#ff0000", "the docs site's change came back as the shop's")
  assert.equal(changes[0].componentName, "Fixture")
})

await check("SW-17 a file path the resolver supplies after the fact is written down too", async () => {
  begin()
  const before = await startEditor(SHOP)
  const entry = before.recordPreviewOnly({ ...SWAP })
  // What `writer.ts` does from `ensureSource(...).then(...)`: the record was
  // made the moment the icon changed, and the file it belongs to is known a few
  // hundred milliseconds later. It patches the object it was handed back.
  entry.filePath = "src/Fixture.tsx"
  assert.equal(before.previewOnlyChanges()[0].filePath, "src/Fixture.tsx")

  const after = await startEditor(SHOP)
  const changes = after.previewOnlyChanges()
  assert.equal(
    changes[0].filePath,
    "src/Fixture.tsx",
    "the ledger was written when the change was recorded and never again, so the path arrived too late to be kept"
  )
  // Which is the difference the user reads: a prompt grouped under the file an
  // agent can open, rather than one asking it to go looking for a component.
  const prompt = after.buildChangePrompt()
  assert.ok(prompt.includes("## src/Fixture.tsx"), prompt)
  assert.ok(!prompt.includes("File not resolved"), prompt)
})

await check("SW-18 an outbox the user emptied stays empty through the next reload", async () => {
  begin()
  const before = await startEditor(SHOP)
  before.recordPreviewOnly({ ...SWAP })
  before.clearPreviewOnly()
  assert.deepEqual(before.previewOnlyChanges(), [])

  const after = await startEditor(SHOP)
  assert.deepEqual(
    after.previewOnlyChanges(),
    [],
    "the rows the user dismissed were rehydrated from a copy the clear never reached"
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
