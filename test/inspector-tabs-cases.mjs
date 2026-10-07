/**
 * The right panel's tab host.
 *
 * The inspector used to be one scroll of sections. It is now three views —
 * Design, Changes, Design system — and the things worth pinning are the ones a
 * refactor of any one tab could quietly break:
 *
 *  - all three tabs exist, exactly once, IN THAT ORDER, and exactly one is
 *    selected. The order is read left to right as a widening scope: this
 *    element, then what you have done to it, then the system both are measured
 *    against. Code used to sit third and has moved to the left rail beside
 *    Layers — `code-tab-cases.mjs` is what pins it there, and the count below
 *    is what notices it coming back. Order is a claim, not an accident of the
 *    array literal, and nothing but this would notice it drifting;
 *  - and there are THREE, not four. A Library tab sat second here for a
 *    release, on the argument that it is what the Design tab reads from. It has
 *    moved to the left panel, beside Layers, because what it grew into is a
 *    catalogue you browse — groups, cards, previews, a component you drag onto
 *    the page — and every other tab in this panel is a view of the element you
 *    have currently selected. A browsing surface in a selection panel is most
 *    useful in exactly the state its neighbours are empty, which is how it came
 *    to be reached by way of a Design tab with nothing in it. The left panel is
 *    already where you go to find something; the count here is what notices it
 *    being put back;
 *  - a hidden pane keeps its DOM (so a half-typed library URL and an open fold
 *    survive a glance at another tab) but is `hidden`, so it cannot be tabbed
 *    into;
 *  - the strip and the store say the same thing in both directions. Which tab
 *    is showing is published as `inspectorTab`, because two surfaces outside
 *    this panel drive it: the toolbar's pending indicator and the keyboard
 *    layer's ⌥8/⌥9/⌥0;
 *  - only the VISIBLE tab is re-read on an invalidation, which is what keeps
 *    the audit and the outbox off the hot path of a number scrub. The
 *    ledger's own out-of-band repaint obeys the same rule and is now bound to
 *    the `annotations` tab — a rename of that id leaves the hook compiling,
 *    subscribed, and firing for a tab that no longer exists;
 *  - the Copy button lives HERE, not on the toolbar, and its clipboard write
 *    still happens synchronously inside the click task. The browser revokes the
 *    transient user activation the Clipboard API needs the moment the handler
 *    awaits, so a refactor that moves the write behind an `await` passes every
 *    test that awaits before asserting and fails on every real click.
 *
 * The outbox cases drive the two real stores — `addAnnotation` for the half the
 * user pins on the canvas, `recordEdit` for the half the editor writes — rather
 * than posting rows into the list themselves, which would pass against a tab
 * wired to nothing.
 *
 * Usage: node designlayer/test/inspector-tabs-cases.mjs
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

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

const dom = new JSDOM(
  '<!doctype html><html><body><main id="app"><button id="cta">Go</button></main></body></html>',
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom
window.document.elementsFromPoint = () => window.__stack ?? []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
}
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

/**
 * The server, as far as this file is concerned: two empty answers.
 *
 * The Design system tab asks for the library list at boot (its `boot` hook —
 * the Design tab's pickers read that list) and for the checker list on its
 * first showing, which a case below does, so both requests happen whether or
 * not a case here is about them. Unstubbed they
 * reach undici, which refuses a relative URL, and the run fills with
 * `TypeError: Failed to parse URL from /__designlayer/libraries` before a
 * single assertion is read.
 *
 * Both payloads are the well-formed EMPTY one — `{ libraries: [] }` and
 * `{ tools: [] }`, the keys `libraries/store.ts` and `lint/store.ts` actually
 * destructure — because a tab with nothing in it is the quietest thing to have
 * behind a suite about the strip above it. `design-system-tab-cases.mjs` owns
 * what the tab does with real payloads.
 */
const requested = []
const serve = async (input) => {
  const path = new URL(String(input), "http://localhost").pathname
  requested.push(path)
  // An agent is attached, so the Changes tab offers "Send to agent" — it
  // withholds the button until one has connected over MCP.
  const payload = path.endsWith("/lint/tools")
    ? { tools: [] }
    : path.endsWith("/mcp/status")
      ? { url: "http://127.0.0.1:5747/mcp", listening: true, agents: 1, waiting: 1 }
      : { libraries: [] }
  return { ok: true, status: 200, json: async () => payload }
}
globalThis.fetch = serve
window.fetch = serve

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createContext } from "./src/core/context"
      export { installInspector } from "./src/panels/inspector/index"
      export { recordPreviewOnly, clearPreviewOnly } from "./src/core/change-prompt"
      export { addAnnotation, resetAnnotationsForTest } from "./src/annotations/store"
      export { recordEdit, resetJournalForTest } from "./src/annotations/journal"
      export { shellCss } from "./src/core/css"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const editor = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const bridge = {
  elementInfo: () => null,
  send() {},
  toast() {},
  subscribe: () => () => {},
  store: {
    setActiveTool() {},
    hasChanges: () => false,
    buildBatchOperations: () => [],
    onStateChange() {},
    getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
    viewportToPage: (x, y) => ({ x, y }),
    pageToViewport: (x, y) => ({ x, y }),
  },
}
const right = slot()
const context = editor.createContext(bridge, {
  overlay: slot(),
  toolbar: slot(),
  left: slot(),
  right,
})
editor.installInspector(context)

const tabs = () => Array.from(right.querySelectorAll('[role="tab"]'))
const panes = () => Array.from(right.querySelectorAll('[role="tabpanel"]'))
const tabNamed = (label) => tabs().find((node) => node.textContent.trim() === label) ?? null
const paneFor = (label) => {
  const tab = tabNamed(label)
  return tab ? right.querySelector(`#${tab.getAttribute("aria-controls")}`) : null
}
const click = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))

/**
 * One painted frame.
 *
 * `invalidate()` debounces the repaint onto a `requestAnimationFrame`, so a
 * case that read the panel in the same task as the write would be reading it as
 * it was before and would fail on an implementation that works.
 */
const frame = () =>
  new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 0)))

console.log("\nInspector tab host")

await check("three tabs, named for the three things you can be looking at", () => {
  assert.deepEqual(
    tabs().map((node) => node.textContent.trim()),
    ["Design", "Changes", "Design system"]
  )
  // The ids too, because they are not decoration: `onPreviewOnlyChange` only
  // repaints while `annotations` is active, the toolbar's pending indicator
  // writes that same string into the store, and the keyboard layer addresses
  // tabs by slot into this array. A rename leaves all three compiling.
  assert.deepEqual(
    tabs().map((node) => node.getAttribute("aria-controls")),
    ["de-tabpanel-design", "de-tabpanel-annotations", "de-tabpanel-system"]
  )
})

// Stated separately from the order above, because the two fail for different
// reasons and the message matters: a fourth tab reappearing here means a
// browsing surface has been put back inside the selection panel, not that
// somebody shuffled the array.
await check("the library is not one of them — it browses, so it lives on the left", () => {
  assert.equal(tabs().length, 3)
  assert.equal(tabNamed("Library"), null, "the library tab is back in the inspector")
})

await check("exactly one tab is selected, and Design is the one you land on", () => {
  const selected = tabs().filter((node) => node.getAttribute("aria-selected") === "true")
  assert.equal(selected.length, 1)
  assert.equal(selected[0].textContent.trim(), "Design")
})

await check("every tab names the pane it controls, and that pane names it back", () => {
  for (const tab of tabs()) {
    const id = tab.getAttribute("aria-controls")
    assert.ok(id, `${tab.textContent.trim()} controls nothing`)
    const pane = right.querySelector(`#${id}`)
    assert.ok(pane, `${id} is not in the panel`)
    assert.equal(pane.getAttribute("aria-labelledby"), tab.id)
  }
})

/*
 * Asked before any case opens another tab. A hidden tab used to be built at
 * boot along with the visible one — a full list render and the requests behind
 * it on every page load. Now only work another surface depends on runs at boot:
 * the library list, which `activeDesignSystem()` merges into the Design tab's
 * pickers. The checker list waits for the tab to be opened.
 */
await check("a hidden tab is not built at boot, but the library list still loads", () => {
  assert.ok(
    requested.some((path) => path.endsWith("/libraries")),
    `the library list was not asked for at boot — requests: ${requested.join(", ")}`
  )
  assert.equal(
    requested.some((path) => path.endsWith("/lint/tools")),
    false,
    "the Design system tab's checker list was fetched before the tab was opened"
  )
})

await check("the two tabs you are not on are hidden, not removed", () => {
  assert.equal(panes().length, 3)
  assert.equal(panes().filter((pane) => !pane.hidden).length, 1)
})

await check("switching tabs moves the selection and the hidden flag together", () => {
  click(tabNamed("Design system"))
  assert.equal(tabNamed("Design system").getAttribute("aria-selected"), "true")
  assert.equal(tabNamed("Design").getAttribute("aria-selected"), "false")
  assert.equal(paneFor("Design system").hidden, false)
  assert.equal(paneFor("Design").hidden, true)
})

/*
 * The pane the user is not looking at is still built.
 *
 * This case was written about the code view's scroll offset, which left with
 * the tab. The Design system tab inherits the same stake and a bigger one: its
 * sections hold a half-typed library URL, an open local-file fold and a whole
 * audit report, none of which is re-fetched on the way back. A pane emptied
 * while hidden would throw all of that away and look, from the outside, exactly
 * like a pane that had simply not been visited yet.
 *
 * Asserted on the children rather than on `innerHTML`, because the claim is
 * that the DOM SURVIVES, not that it is frozen: a section is free to repaint
 * itself out of band while hidden, and comparing markup would call that a
 * failure.
 */
await check("a pane that has been visited keeps its DOM while hidden", () => {
  const pane = paneFor("Design system")
  const before = Array.from(pane.querySelectorAll("*"))
  assert.ok(before.length > 0, "the tab was never built, so this proves nothing")

  click(tabNamed("Design"))
  assert.equal(pane.hidden, true)
  assert.equal(paneFor("Design system"), pane, "the pane itself was replaced")
  for (const node of before) {
    assert.ok(node.isConnected, "a hidden pane was torn out of the document")
    assert.ok(pane.contains(node), "a hidden pane's contents were reparented out of it")
  }
})

/*
 * The store is the record of which tab is showing, and it is read from outside.
 *
 * Two live callers depend on this and neither is in this file: the toolbar's
 * pending indicator writes `inspectorTab: "annotations"` to bring the outbox
 * forward, and the keyboard layer's ⌥8/⌥9/⌥0 commands write the same field.
 * Both directions have to work, and the guard between them is what stops them
 * from looping — so both are asked here, in the order they actually run.
 */
await check("the strip and the store agree, in both directions", () => {
  click(tabNamed("Design system"))
  assert.equal(context.getState().inspectorTab, "system", "a click did not reach the store")

  // The other way: an external write moves the strip.
  context.setState({ inspectorTab: "annotations" })
  assert.equal(tabNamed("Changes").getAttribute("aria-selected"), "true")
  assert.equal(paneFor("Changes").hidden, false)
  assert.equal(paneFor("Design system").hidden, true)

  // And a write naming the tab already showing is not a switch at all, which is
  // the case that would spin if either guard were dropped.
  context.setState({ inspectorTab: "annotations" })
  assert.equal(tabNamed("Changes").getAttribute("aria-selected"), "true")

  click(tabNamed("Design"))
  assert.equal(context.getState().inspectorTab, "design")
})

// ── The outbox, and the copy button in its new home ────────────────────────

console.log("\nThe Changes tab")

const notesPane = () => paneFor("Changes")
/**
 * The OUTBOX's Copy, scoped to the button row rather than swept off the pane.
 *
 * There are two controls reading "Copy" in this tab — this one, and the one
 * beside the MCP address in Settings, which copies the agent's URL. They are
 * deliberately the same drawing (a case below asserts exactly that), so a
 * sweep of the pane for the word finds whichever comes first in the document
 * and reports on the wrong control the moment the other leaves. The button row
 * is out of the column entirely over an empty session, so that is not
 * hypothetical: an unscoped sweep silently started measuring the MCP button.
 */
const copyButton = () =>
  Array.from(notesPane().querySelectorAll(".de-ann-ctas button")).find(
    (node) => node.textContent.trim() === "Copy"
  ) ?? null
const rowKinds = () =>
  Array.from(notesPane().querySelectorAll(".de-ann-item")).map((node) =>
    node.classList.contains("de-ann-item--note") ? "note" : "edit"
  )

/** The element an edit is recorded against — a real node, so the journal can describe it. */
const CTA = window.document.getElementById("cta")

/** A note's target, captured the way `describeElement` would have captured it. */
const CARD = {
  tagName: "div",
  componentName: "Card",
  className: "rounded-xl",
  id: null,
  selector: "main#app > div.rounded-xl",
  text: "Weekly digest",
  filePath: "/Users/someone/app/src/components/card.tsx",
  lineNumber: 42,
  ancestry: [],
  computed: {},
  components: ["Card"],
}

const STRANDED = {
  filePath: null,
  componentName: "Card",
  tagName: "div",
  className: "rounded-xl",
  property: "box-shadow",
  from: "none",
  to: "0 2px 8px rgba(0,0,0,.3)",
}

/**
 * Both stores back to empty, and the page's storage with them.
 *
 * The journal dies with the session, but notes are persisted to `localStorage`
 * under `window.location.pathname` — and jsdom provides one, so the writes are
 * real. `resetAnnotationsForTest` only drops the in-memory copy, by design, so
 * without clearing the key the next read rehydrates the previous case's notes
 * and every count from here on is off by whatever ran before it.
 *
 * `clearPreviewOnly` announces, and the announcement schedules a repaint on the
 * next frame; that frame is drained here so a pending one cannot land in the
 * middle of a case and be mistaken for the repaint the case is watching for.
 */
async function reset() {
  editor.resetAnnotationsForTest()
  editor.resetJournalForTest()
  editor.clearPreviewOnly()
  window.localStorage.clear()
  await frame()
}

await check("the copy button lives in the panel, and the toolbar holds no copy at all", async () => {
  await reset()
  // Something in the session, because the button row only exists once there
  // is something for it to hand over.
  editor.recordEdit({
    property: "box-shadow",
    from: "none",
    to: "0 2px 8px rgba(0,0,0,.3)",
    element: CTA,
    written: false,
  })
  click(tabNamed("Changes"))
  assert.ok(copyButton(), "the Notes tab has no copy button")
  const strays = Array.from(context.slots.toolbar.querySelectorAll("button")).filter((node) =>
    node.textContent.trim().startsWith("Copy")
  )
  assert.deepEqual(strays, [], "the toolbar still carries a copy button")
})

await check("an empty outbox takes the buttons away and says what would ever be in it", async () => {
  await reset()
  click(tabNamed("Changes"))
  /*
   * The button used to be here and disabled. The whole row leaves now, which
   * is the same statement made once instead of four times: a disabled Copy, a
   * disabled Send, an eye over no markers and a bin over no notes is four
   * controls saying "not yet" above a sentence that already says it.
   */
  assert.equal(copyButton(), null, "the button row sat over an empty session")
  assert.equal(notesPane().querySelector(".de-ann-ctas"), null)
  assert.match(notesPane().textContent, /Pin a note or make an edit/)
})

await check("a pinned note and a recorded edit are one list, and arm the button", async () => {
  await reset()
  editor.addAnnotation({
    kind: "element",
    comment: "This gap is too tight",
    url: window.location.href,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    target: CARD,
    selectedText: null,
  })
  editor.recordEdit({
    property: "box-shadow",
    from: "none",
    to: "0 2px 8px rgba(0,0,0,.3)",
    element: CTA,
    written: false,
  })
  click(tabNamed("Changes"))

  assert.equal(copyButton().disabled, false)
  /*
   * Both halves on screen, in ONE section — a tab that listed only its own
   * store would still read as working right up to the point an agent got half
   * a story. No tally: the rows are never off screen.
   */
  assert.deepEqual(
    Array.from(notesPane().querySelectorAll(".de-section-title")).map((node) =>
      node.textContent.trim()
    ),
    ["Notes and edits", "MCP", "Settings"]
  )
  assert.match(notesPane().textContent, /This gap is too tight/)
  assert.match(notesPane().textContent, /box-shadow/)
  /*
   * In the order they happened, with one run of numbers — the same numbers the
   * pins on the canvas and the brief use.
   */
  assert.deepEqual(rowKinds(), ["note", "edit"])
  assert.deepEqual(
    Array.from(notesPane().querySelectorAll(".de-ann-index")).map((n) => n.textContent.trim()),
    ["1", "2"]
  )
  // A note needs the agent, so the one primary button sends.
  const primary = notesPane().querySelector(".de-ann-ctas .de-button--primary")
  assert.equal(primary.textContent.trim(), "Send to agent")
  assert.equal(primary.disabled, false)
})

await check("the listed path is the file's tail, never the user's home", () => {
  /*
   * In the TOOLTIP now, not in a second line under the row.
   *
   * The line went — one row, one sentence, and the filing note is the tool's
   * bookkeeping rather than something the designer wrote. Where it is printed
   * changed; what may be printed did not, and a home directory on a shared
   * screen leaks out of a tooltip exactly as hard.
   */
  const titles = Array.from(notesPane().querySelectorAll(".de-ann-item-line")).map((node) =>
    node.getAttribute("title") ?? ""
  )
  assert.ok(
    titles.some((title) => /card\.tsx:42/.test(title)),
    "the row no longer says which file it came from, anywhere"
  )
  assert.ok(
    !notesPane().textContent.includes("/Users/someone"),
    "an absolute path reached the panel"
  )
  assert.ok(
    !titles.some((title) => title.includes("/Users/someone")),
    "an absolute path reached a tooltip"
  )
})

await check("the clipboard write happens in the click task, before any await", () => {
  let written = null
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: (text) => ((written = text), Promise.resolve()) },
    configurable: true,
  })
  click(copyButton())
  assert.ok(written, "nothing was written synchronously")
  assert.match(written, /This gap is too tight/)
  assert.match(written, /box-shadow/)
  assert.ok(!written.includes("/Users/someone"), "the brief carried an absolute path")
  // The brief is in Agentation's format, so its source line is `**Source:**`,
  // cut to the file's `src/` tail.
  assert.match(written, /^\*\*Source:\*\* src\/components\/card\.tsx:42$/m, "the note lost its source line")
})

await check("Copy and Send to agent are bare labels, so the four controls share one line", () => {
  /*
   * Two glyph utilities sit on the same 244px line; marks on the pills too made
   * four icons in a row and the row folded. The label does not grow to "Copied"
   * either, or it would shove Send left and back again.
   */
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
  })
  assert.equal(copyButton().querySelector("svg"), null, "Copy still carries a mark")
  click(copyButton())
  assert.equal(copyButton().textContent.trim(), "Copy")
  const send = Array.from(notesPane().querySelectorAll("button")).find((node) =>
    node.textContent.trim().startsWith("Send to agent")
  )
  assert.ok(send, "the Send button is gone")
  assert.equal(send.querySelector("svg"), null, "Send still carries a mark")
})

await check("dropping the last row empties the list and takes the buttons with it", async () => {
  await reset()
  editor.recordEdit({
    property: "box-shadow",
    from: "none",
    to: "0 2px 8px rgba(0,0,0,.3)",
    element: CTA,
    written: false,
  })
  click(tabNamed("Changes"))
  assert.equal(copyButton().disabled, false)

  const drop = notesPane().querySelector('[aria-label^="Discard change"]')
  assert.ok(drop, "an edit cannot be retracted from the handover")
  click(drop)
  assert.deepEqual(rowKinds(), [])
  // The session is empty again, so the column goes back to what it looks like
  // before anything happens: the empty state and Settings, nothing to press.
  assert.equal(copyButton(), null, "the buttons outlived the last row")
})

await check("the ledger repaints the outbox, and only while the outbox is showing", async () => {
  await reset()
  /*
   * One edit first, so there is a list to plant a sentinel in.
   *
   * Each half of the outbox is its own section now, and a section holding
   * nothing is taken out of the document entirely — so a fresh session has no
   * `.de-ann-list` anywhere. This is the seed, not the subject: what is under
   * test is still whether a LEDGER write repaints a tab nothing else told to
   * look again.
   */
  editor.recordEdit({
    property: "box-shadow",
    from: "none",
    to: "0 2px 8px rgba(0,0,0,.3)",
    element: CTA,
    written: false,
  })
  click(tabNamed("Changes"))

  /*
   * A write with no file to land in reaches the ledger from a promise inside the
   * writer, long after the store settled — no selection change and no refresh,
   * so nothing else would ever tell the tab to look again. A sentinel planted in
   * the list is how the repaint is seen: `render()` empties the list before it
   * refills it, so a rebuild takes the sentinel with it.
   */
  const plant = () => {
    const node = window.document.createElement("span")
    node.setAttribute("data-sentinel", "")
    notesPane().querySelector(".de-ann-list").append(node)
  }
  const sentinel = () => notesPane().querySelector("[data-sentinel]")

  plant()
  editor.recordPreviewOnly({ ...STRANDED })
  await frame()
  assert.equal(sentinel(), null, "an open outbox was left stale by a ledger write")

  // The same write with Design in front must not touch it. Repainting a pane
  // nobody is looking at is the hot-path cost the tab host exists to avoid, and
  // the hidden pane is re-read the moment it is switched to anyway.
  click(tabNamed("Design"))
  plant()
  editor.recordPreviewOnly({ ...STRANDED, to: "0 4px 16px rgba(0,0,0,.4)" })
  await frame()
  assert.ok(sentinel(), "a hidden pane was repainted on a ledger write")
})

await check("a closed inspector owes its repaint and pays it on reopening", async () => {
  await reset()
  click(tabNamed("Design"))
  context.select(CTA)
  await frame()
  const design = paneFor("Design")
  const plant = () => {
    const node = window.document.createElement("span")
    node.setAttribute("data-sentinel", "")
    design.firstElementChild.append(node)
  }
  const sentinel = () => design.querySelector("[data-sentinel]")

  // Closed: a selection change rebuilds nothing nobody can see.
  plant()
  context.setState({ inspectorOpen: false })
  context.select(window.document.getElementById("app"))
  await frame()
  assert.ok(sentinel(), "a closed inspector was rebuilt on a selection change")

  // Opened: the owed rebuild lands in the frame it opens.
  context.setState({ inspectorOpen: true })
  await frame()
  assert.equal(sentinel(), null, "the reopened inspector still shows the old element")

  // The same through hidden chrome.
  plant()
  context.setState({ chromeHidden: true })
  context.select(CTA)
  await frame()
  assert.ok(sentinel(), "hidden chrome still rebuilt the inspector")
  context.setState({ chromeHidden: false })
  await frame()
  assert.equal(sentinel(), null, "showing the chrome again left the inspector stale")
  context.select(null)
  await frame()
})

// ── The stylesheet the panes rely on ───────────────────────────────────────

console.log("\nTab stylesheet")

await check("a hidden pane is display:none, beating the UA [hidden] rule", () => {
  assert.match(editor.shellCss, /\.de-tabpanel\[hidden\]\s*\{[^}]*display:\s*none/)
})

await check("the right panel's body stops scrolling — its pane does that now", () => {
  assert.match(
    editor.shellCss,
    /\.de-panel--right \.de-panel-body\s*\{[^}]*overflow:\s*hidden/s
  )
})

/*
 * The strip kept its scroller when it lost a tab, and that is not an oversight.
 *
 * It was added because four icon-and-label tabs measured 3px inside a 260px
 * panel. Three of them fit that width easily — but the panel is draggable now,
 * down to a 200px minimum, which is well short of what the strip measures. So
 * the overflow the scroller answers went from a backstop nobody would hit to
 * an everyday state, and deleting it along with the fourth tab would leave a
 * narrowed inspector with a tab hanging past the edge and no way to reach it.
 */
await check("a narrowed panel can still reach every tab — the strip scrolls", () => {
  assert.match(editor.shellCss, /\.de-tabs\s*\{[^}]*overflow-x:\s*auto/s)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
