/**
 * A drag is an edit, and this is where that is held.
 *
 * Direct manipulation used to end at the screen: `onPointerUp` fired the drag
 * hooks, refreshed the panels and stopped, so the one gesture a visual editor
 * exists for left no trace anywhere else. No history step, so Cmd+Z could not
 * take a move back. No ledger row, so the Prompts tab still said there was
 * nothing to hand over. No queued operation for a resize, even though `width`
 * and `height` are perfectly translatable and "Apply to code" could have
 * written them. The keyboard nudge — the same movement, one pixel at a time —
 * had all four, which is what made the gap a bug rather than a design.
 *
 * The subtle half is the rewind, and most of these cases are about it. The
 * writer reads the element to decide what the change was FROM; by pointerup the
 * element already holds the dragged value, so committing naively records a step
 * from a value to itself: green tests, a no-op undo, and a prompt that asks an
 * agent to change `translate(50px, 20px)` into `translate(50px, 20px)`. Every
 * assertion on a "from" below is guarding that.
 *
 * Usage: node designlayer/test/drag-write-cases.mjs
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
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

// jsdom lays nothing out, and the gesture measures the element once at
// pointerdown. A fixed box is enough: a move reads only the deltas off it, and
// a resize reads the two numbers it grows from.
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 }
}

// Enough of a matrix to answer "where is this element already translated to?",
// which is the question `readOffset` asks at pointerdown. A constant-zero stub
// would make every gesture start from the origin and quietly hide the case
// these tests care most about — dragging something that had already moved.
globalThis.DOMMatrixReadOnly = class {
  constructor(source = "") {
    const found = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(source)
    this.m41 = found ? Number(found[1]) : 0
    this.m42 = found ? Number(found[2]) : 0
    // And a 2D `matrix(...)`, so a rotated element can be dragged and nudged.
    const matrix = /^matrix\(([^)]*)\)$/.exec(source.trim())
    if (matrix) {
      const [a, b, c, d, e, f] = matrix[1].split(",").map(Number)
      Object.assign(this, { a, b, c, d, m41: e, m42: f, is2D: true })
    }
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

/** One bundle: the timeline and the ledger are module state to be shared. */
const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { installTransform, translateBy } from "./src/canvas/transform"
      export { createWriter } from "./src/core/writer"
      export * as history from "./src/core/history"
      export { previewOnlyChanges, clearPreviewOnly } from "./src/core/change-prompt"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "silent",
})
const editor = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)
const { history, previewOnlyChanges, clearPreviewOnly } = editor

const queued = []
const toasts = []
const bridge = {
  elementInfo: () => null,
  send() {},
  toast: (message, kind) => toasts.push({ message, kind }),
  subscribe: () => () => {},
  store: {
    hasChanges: () => queued.length > 0,
    buildBatchOperations: () => queued.map((entry) => entry.operation),
    addPendingPropertyOperation: (mergeKey, operation, keys) =>
      queued.push({ mergeKey, operation, keys }),
  },
}

// The state the gesture reads, and the count of repaints it asked for. The
// canvas lane builds one writer and hands it to every gesture; this is that
// same wiring with the rest of the lane left out.
const state = { tool: "move", interactive: false, selection: [] }
const refreshes = []
const context = {
  getState: () => state,
  // Snapshotted rather than counted: the ordering assertion needs to know what
  // the timeline looked like at the moment the panels were told to repaint.
  refresh: () => refreshes.push({ canUndo: history.canUndo(), ledger: previewOnlyChanges().length }),
}

editor.installTransform(context, editor.createWriter(bridge))

const app = window.document.getElementById("app")
// A handle lives in the editor's chrome, not in the app, and the gesture picks
// a resize purely off this attribute.
const handle = window.document.createElement("div")
handle.dataset.handle = "se"
handle.setAttribute("data-designlayer", "")
window.document.body.append(handle)

function mount(html) {
  app.insertAdjacentHTML("beforeend", html)
  return app.lastElementChild
}

let keys = 0
function selectionFor(element) {
  keys += 1
  return {
    element,
    tagName: element.tagName.toLowerCase(),
    componentName: "Fixture",
    // Known up front, so the queue dispatches in the same task the gesture ends
    // in and a case never has to await a resolution it is not testing.
    source: { filePath: "src/Fixture.tsx", lineNumber: 4, columnNumber: 2, componentName: "Fixture" },
    key: `fixture-${keys}`,
  }
}

const reset = (...selections) => {
  history.resetHistory()
  clearPreviewOnly()
  queued.length = 0
  toasts.length = 0
  refreshes.length = 0
  state.selection = selections
}

const fire = (target, type, init) =>
  target.dispatchEvent(
    new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init })
  )

/** A whole gesture: press at the first point, move through the rest, release. */
function drag(target, path) {
  fire(target, "pointerdown", { clientX: path[0][0], clientY: path[0][1] })
  for (const [x, y] of path.slice(1)) fire(target, "pointermove", { clientX: x, clientY: y })
  fire(target, "pointerup", {})
}

// ── A move ─────────────────────────────────────────────────────────────────

console.log("\nA move")

check("DW-01 a drag past the threshold reaches the writer", () => {
  const element = mount('<div class="card" style="transform: translate(10px, 20px)">Card</div>')
  reset(selectionFor(element))
  drag(element, [
    [0, 0],
    [40, 0],
    [60, 0],
  ])

  // The screen still shows the drag: the rewind and the re-write happen in the
  // same task, so the element never paints at its pre-gesture position.
  assert.equal(element.style.transform, "translate(70px, 20px)")
  assert.equal(history.canUndo(), true, "the drag left no history step")
  assert.equal(previewOnlyChanges().length, 1, "the Prompts tab still has nothing to hand over")
  assert.deepEqual(toasts, [{ message: "Move: preview only (transform)", kind: "error" }])
})

check("DW-02 one gesture is one step, however many frames it took", () => {
  const element = mount('<div class="card">Card</div>')
  reset(selectionFor(element))
  drag(element, [
    [0, 0],
    [10, 0],
    [20, 0],
    [30, 0],
    [40, 0],
    [50, 0],
  ])

  assert.equal(history.undo(), "Move")
  // Five pointermoves recording five steps is the failure this guards: Cmd+Z
  // would walk the pointer back frame by frame instead of undoing the move.
  assert.equal(history.canUndo(), false, "the gesture recorded one step per frame")
  assert.equal(previewOnlyChanges().length, 1)
})

check("DW-03 the ledger says where the drag started, not where it ended", () => {
  const element = mount('<div class="card" style="transform: translate(10px, 20px)">Card</div>')
  reset(selectionFor(element))
  drag(element, [
    [0, 0],
    [40, 0],
  ])

  const [change] = previewOnlyChanges()
  assert.equal(change.property, "transform")
  // The whole trap in one line. Committing without rewinding first reads the
  // dragged value as the "before", and this reads `translate(50px, 20px)`.
  assert.equal(change.from, "translate(10px, 20px)")
  assert.equal(change.to, "translate(50px, 20px)")
  assert.equal(change.to, element.style.transform, "the prompt and the screen disagree")
  assert.equal(change.filePath, "src/Fixture.tsx")
})

check("DW-3b the vendor's lift never reaches the committed value", () => {
  const element = mount('<div class="card">Card</div>')
  reset(selectionFor(element))
  fire(element, "pointerdown", { clientX: 0, clientY: 0 })
  fire(element, "pointermove", { clientX: 40, clientY: 24 })
  // What the vendored overlay paints over our preview mid-gesture: its own lift
  // scale, plus the computed transform it read when the press began — which for
  // an untransformed element is the identity matrix. Committing the raw inline
  // string writes both of them into the file, which is what a real drag on a
  // real Angular template was measured doing.
  element.style.transform = "translate(40px, 24px) scale(1.02) matrix(1, 0, 0, 1, 0, 0)"
  fire(element, "pointerup", {})

  const [change] = previewOnlyChanges()
  assert.equal(change.to, "translate(40px, 24px)", "a transient animation reached the write")
})

check("DW-3c a gesture that ends where it started writes nothing", () => {
  const element = mount('<div class="card">Card</div>')
  reset(selectionFor(element))
  fire(element, "pointerdown", { clientX: 0, clientY: 0 })
  fire(element, "pointermove", { clientX: 40, clientY: 0 })
  // Dragged out and dropped back: the identity matrix the vendor leaves behind
  // must not read as an edit just because the string differs from "".
  element.style.transform = "matrix(1, 0, 0, 1, 0, 0)"
  fire(element, "pointerup", {})

  assert.deepEqual(previewOnlyChanges(), [], "an identity transform read as a move")
  assert.equal(history.canUndo(), false)
})

check("DW-04 a press that never crosses the threshold writes nothing", () => {
  const element = mount('<div class="card" style="transform: translate(10px, 20px)">Card</div>')
  reset(selectionFor(element))
  drag(element, [
    [0, 0],
    [2, 1],
  ])

  assert.equal(element.style.transform, "translate(10px, 20px)", "a click nudged the element")
  assert.equal(history.canUndo(), false)
  assert.deepEqual(previewOnlyChanges(), [])
  assert.deepEqual(toasts, [], "a click that moved nothing announced a move")
  assert.deepEqual(refreshes, [], "a click that moved nothing repainted the panels")
})

check("DW-05 undo puts the element back where the gesture found it", () => {
  const element = mount('<div class="card" style="transform: translate(10px, 20px)">Card</div>')
  reset(selectionFor(element))
  drag(element, [
    [0, 0],
    [40, 30],
  ])
  assert.equal(element.style.transform, "translate(50px, 50px)")

  assert.equal(history.undo(), "Move")
  assert.equal(element.style.transform, "translate(10px, 20px)", "Cmd+Z did not move it back")
  assert.equal(history.redo(), "Move")
  assert.equal(element.style.transform, "translate(50px, 50px)")
})

check("DW-06 a multi-selection drag moves and records every member", () => {
  const first = mount('<div class="a" style="transform: translate(4px, 0px)">A</div>')
  const second = mount('<div class="b">B</div>')
  reset(selectionFor(first), selectionFor(second))
  // Pressed on one member; the whole set travels with it.
  drag(first, [
    [0, 0],
    [30, 0],
  ])

  assert.equal(first.style.transform, "translate(34px, 0px)")
  assert.equal(second.style.transform, "translate(30px, 0px)")

  const ledger = previewOnlyChanges()
  assert.equal(ledger.length, 2, "only part of the selection reached the writer")
  assert.deepEqual(
    ledger.map((change) => change.className).sort(),
    ["a", "b"]
  )
  // Once per element, so undo walks the set back rather than stranding half of
  // it at the dragged position.
  history.undo()
  history.undo()
  assert.equal(history.canUndo(), false)
  assert.equal(first.style.transform, "translate(4px, 0px)")
  // `none` rather than an empty string: the member that had no inline transform
  // is reverted to its computed one, which is what keeps the undone move out of
  // the pending source operation. Visually identical, and expressible.
  assert.equal(second.style.transform, "none", "the second member never had its move recorded")
})

// ── A resize ───────────────────────────────────────────────────────────────

console.log("\nA resize")

check("DW-07 a resize queues width and height for source", () => {
  const element = mount('<div class="panel" style="width: 100px; height: 50px">Panel</div>')
  reset(selectionFor(element))
  // The gesture grows the element's own width and height by the handle's
  // travel; here they match the 100×50 box, as on a border-box element.
  drag(handle, [
    [0, 0],
    [40, 20],
  ])

  assert.equal(element.style.width, "140px")
  assert.equal(element.style.height, "70px")
  assert.equal(queued.length, 1, '"Apply to code" is still disabled on a change it can write')
  assert.deepEqual(queued[0].keys, ["width", "height"])
  const values = JSON.stringify(queued[0].operation.updates)
  assert.ok(values.includes("140px"), values)
  assert.ok(values.includes("70px"), values)
  // Both properties translate, so nothing was lost and nothing is said: a
  // successful direct edit does not raise a toast.
  assert.deepEqual(previewOnlyChanges(), [])
  assert.deepEqual(toasts, [])
})

check("DW-08 a resize undoes to the inline strings it started from", () => {
  const element = mount('<div class="panel" style="width: 80px; height: 40px">Panel</div>')
  reset(selectionFor(element))
  drag(handle, [
    [0, 0],
    [40, 20],
  ])

  assert.equal(history.undo(), "Resize")
  // `80px`, not `140px`. Without the rewind the writer reads the dragged size
  // as the "before" and undo is a no-op that still looks like a step.
  assert.equal(element.style.width, "80px")
  assert.equal(element.style.height, "40px")
  assert.equal(history.canUndo(), false, "one resize left more than one step")
})

/*
 * A side handle drags one axis. It used to write both, which pinned a text
 * card's content-driven height into source on a width-only drag.
 */
check("DW-10 an east handle writes width and leaves height alone", () => {
  const element = mount('<div class="panel">Panel</div>')
  reset(selectionFor(element))
  handle.dataset.handle = "e"
  try {
    drag(handle, [
      [0, 0],
      [20, 30],
    ])
  } finally {
    handle.dataset.handle = "se"
  }
  assert.equal(element.style.width, "120px")
  assert.equal(element.style.height, "", "the height was pinned by a width-only drag")
  assert.deepEqual(queued[0].keys, ["width"])
})

/*
 * `content-box` with padding: the rect is 100 wide, the element's own width is
 * 80. Writing the rect grew it by the padding on the first 1px of travel.
 */
check("DW-11 a content-box resize grows the element's own width, not its border box", () => {
  const element = mount('<div class="panel" style="width: 80px; height: 30px; box-sizing: content-box; padding: 10px">Panel</div>')
  reset(selectionFor(element))
  drag(handle, [
    [0, 0],
    [40, 20],
  ])
  assert.equal(element.style.width, "120px")
  assert.equal(element.style.height, "50px")
})

/*
 * Moving changes only the translation. A rotated element dragged or nudged
 * used to come back as a bare `translate(...)`, its rotation gone from source.
 */
check("DW-12 a drag keeps the element's rotation", () => {
  const element = mount('<div class="card" style="transform: matrix(0.98, 0.17, -0.17, 0.98, 10, 20)">Card</div>')
  reset(selectionFor(element))
  drag(element, [
    [0, 0],
    [40, 0],
  ])
  assert.equal(element.style.transform, "matrix(0.98, 0.17, -0.17, 0.98, 50, 20)")
  const [change] = previewOnlyChanges()
  assert.equal(change.to, "matrix(0.98, 0.17, -0.17, 0.98, 50, 20)", "the rotation was dropped from the write")
})

check("DW-13 translateBy (the arrow-key nudge) keeps rotation too", () => {
  const element = mount('<div class="card" style="transform: matrix(0.98, 0.17, -0.17, 0.98, 10, 20)">Card</div>')
  assert.equal(editor.translateBy(element, 1, 0), "matrix(0.98, 0.17, -0.17, 0.98, 11, 20)")
  const plain = mount('<div class="card" style="transform: translate(10px, 20px)">Card</div>')
  assert.equal(editor.translateBy(plain, 1, 0), "translate(11px, 20px)")
})

/*
 * The browser took the pointer back mid-drag. Nobody released anything, so
 * the preview goes back and nothing reaches source or the timeline.
 */
check("DW-14 pointercancel reverts the preview instead of committing it", () => {
  const element = mount('<div class="card" style="transform: translate(10px, 20px)">Card</div>')
  reset(selectionFor(element))
  fire(element, "pointerdown", { clientX: 0, clientY: 0 })
  fire(element, "pointermove", { clientX: 40, clientY: 0 })
  assert.equal(element.style.transform, "translate(50px, 20px)", "no preview to revert")
  fire(element, "pointercancel", {})
  assert.equal(element.style.transform, "translate(10px, 20px)")
  assert.equal(queued.length, 0)
  assert.equal(history.canUndo(), false)
})

// ── The order of the release ───────────────────────────────────────────────

console.log("\nThe release")

check("DW-09 the panels repaint after the write, not before it", () => {
  const element = mount('<div class="card">Card</div>')
  reset(selectionFor(element))
  drag(element, [
    [0, 0],
    [40, 0],
  ])

  assert.equal(refreshes.length, 1, "one gesture is one repaint")
  // The Prompts tab and the Undo button are drawn from this refresh, so a
  // refresh that runs before the write draws the state the drag replaced.
  assert.equal(refreshes[0].canUndo, true)
  assert.equal(refreshes[0].ledger, 1)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
