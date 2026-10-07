/**
 * One marker system: every item in the Changes tab has ONE pin on the canvas.
 *
 * Notes and edits share a list, a numbering and an undo timeline, so the pins
 * have to share them too. Five claims, each one a way the canvas and the panel
 * could quietly disagree:
 *
 * 1. A note, then an edit, then a note are pins 1, 2 and 3 — the same numbers
 *    the rows carry — and the edit's pin is a different SHAPE, not only a
 *    different colour.
 * 2. Undoing the edit takes its pin away and renumbers the note after it, so
 *    "fix 2" never names a pin for a change the designer reversed.
 * 3. Two pins on one element do not sit on the same coordinate, where one of
 *    them could not be seen or clicked.
 * 4. An edit's pin selects its element instead of opening a composer.
 * 5. A note pinned through the composer is a step on the single timeline.
 *
 * The harness is `annotation-cases`' canvas harness, cut down: one bundle, so
 * the store, the journal and the history are one set of module state.
 *
 * Usage: node test/unified-marker-cases.mjs
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

const MARKUP = `<!doctype html><html><body><main id="app">
  <button class="btn" type="button">Save</button>
  <p id="lede" class="lede">Orders and invoices now live in one workspace.</p>
  <span id="tag" class="tag">New</span>
</main></body></html>`

const dom = new JSDOM(MARKUP, { pretendToBeVisual: true, url: "http://localhost/" })
const { window } = dom

/** The hit stack a gesture sees; jsdom has no `elementsFromPoint` of its own. */
window.document.elementsFromPoint = () => window.__stack ?? []

/**
 * Every element at its own corner, so pins on different elements cannot share
 * a coordinate by accident and the collision case measures the fan-out alone.
 */
const CORNERS = new Map()
window.Element.prototype.getBoundingClientRect = function box() {
  const [left, top] = CORNERS.get(this) ?? [0, 0]
  return { x: left, y: top, left, top, right: left + 120, bottom: top + 40, width: 120, height: 40 }
}
globalThis.DOMMatrixReadOnly = class {
  constructor() {
    this.m41 = 0
    this.m42 = 0
  }
}
for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement", "SVGElement",
  "SVGSVGElement", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent",
  "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
// A frame is a macrotask here, so a settle is a known number of ticks.
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
window.requestAnimationFrame = globalThis.requestAnimationFrame
window.cancelAnimationFrame = globalThis.cancelAnimationFrame
globalThis.fetch = async () => {
  throw new Error("no server in this harness")
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { installAnnotations } from "./src/annotations/canvas"
      export { addAnnotation, annotations, resetAnnotationsForTest } from "./src/annotations/store"
      export { edits, resetJournalForTest } from "./src/annotations/journal"
      export { pinNote } from "./src/annotations/actions"
      export { outboxNumbers } from "./src/annotations/output"
      export { undo, resetHistory } from "./src/core/history"
      export { createWriter } from "./src/core/writer"
      export { createContext } from "./src/core/context"
      export { getState, setState, elementKey } from "./src/core/store"
      export { annotationsCss } from "./src/core/css/annotations"
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

/**
 * A frozen clock, installed after the build. The outbox orders notes and edits
 * by `createdAt`, and at millisecond resolution two items made in one task tie
 * — a numbering test that cannot fail. `tick()` is how a case says time passed.
 */
const RealDate = Date
let clock = RealDate.parse("2026-03-01T09:00:00.000Z")
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [clock]))
  }
  static now() {
    return clock
  }
}
const tick = (ms = 1000) => {
  clock += ms
}

const settle = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

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

// ── The editor ─────────────────────────────────────────────────────────────

/** Just enough vendor store for the writer to queue a style and undo it. */
const bridge = {
  store: {
    addPendingPropertyOperation() {},
    removePendingPropertyOperation() {},
    buildBatchOperations: () => [],
    hasChanges: () => false,
    setActiveTool() {},
    onStateChange() {},
    getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
    viewportToPage: (x, y) => ({ x, y }),
    pageToViewport: (x, y) => ({ x, y }),
  },
  elementInfo: () => null,
  async elementSourceAsync() {
    return null
  },
  async discoverFile() {
    return null
  },
  send() {},
  subscribe: () => () => {},
  toast() {},
}

const slots = {
  overlay: window.document.createElement("div"),
  toolbar: window.document.createElement("div"),
  left: window.document.createElement("div"),
  right: window.document.createElement("div"),
}
for (const slot of Object.values(slots)) {
  slot.setAttribute("data-designlayer", "")
  window.document.body.append(slot)
}
const context = editor.createContext(bridge, slots)
editor.installAnnotations(context)
const writer = editor.createWriter(bridge)
const layer = slots.overlay.querySelector(".de-ann-layer")

const $ = (selector) => window.document.querySelector(selector)
const button = $(".btn")
const lede = $("#lede")
const tag = $("#tag")
CORNERS.set(button, [10, 10])
CORNERS.set(lede, [10, 100])
CORNERS.set(tag, [10, 200])

function reset() {
  editor.resetAnnotationsForTest()
  editor.resetJournalForTest()
  editor.resetHistory()
  editor.setState({ selection: [], annotating: false })
  window.localStorage.clear()
  // The writer paints inline styles and a reset journal does not take them
  // back: a second "opacity: 0.5" on an element still at 0.5 is no edit at all.
  for (const element of [button, lede, tag]) element.removeAttribute("style")
}

/** The painted pins, in the order the pool drew them. */
const pins = () =>
  Array.from(layer.querySelectorAll(".de-ann-marker")).filter((pin) => pin.style.display !== "none")

/** A note through the real gesture: annotate mode, click, type, Save. */
function noteOn(element, comment) {
  editor.setState({ annotating: true })
  window.__stack = [element]
  const fire = (type) =>
    element.dispatchEvent(
      new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: 30, clientY: 30 })
    )
  fire("pointerdown")
  fire("pointerup")
  const box = layer.querySelector(".de-ann-composer")
  assert.ok(box, "no composer opened for the note")
  box.querySelector("textarea").value = comment
  Array.from(box.querySelectorAll("button"))
    .find((b) => b.textContent === "Save note")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
  editor.setState({ annotating: false })
}

/** An edit through the writer, so it is on the timeline exactly as a control's is. */
function editOn(element, property, value) {
  writer.applyStyles(
    {
      element,
      tagName: element.tagName.toLowerCase(),
      componentName: "Fixture",
      source: null,
      key: editor.elementKey(element, "Fixture", 0),
    },
    [{ property, value }],
    `Set ${property}`
  )
}

console.log("\nOne pin per item, one number per item")

await check("a note, an edit and a note are pins 1, 2, 3, and the edit is a square", async () => {
  reset()
  noteOn(button, "First")
  tick()
  editOn(lede, "opacity", "0.5")
  tick()
  noteOn(tag, "Third")
  await settle()

  const painted = pins()
  assert.deepEqual(painted.map((pin) => pin.textContent), ["1", "2", "3"])
  assert.deepEqual(
    painted.map((pin) => pin.classList.contains("de-ann-marker--edit")),
    [false, true, false],
    "only the edit's pin should carry the edit shape"
  )
  // The pin's number IS the row's number: both come from `outboxNumbers`.
  const numbers = editor.outboxNumbers()
  for (const pin of painted) assert.equal(pin.textContent, String(numbers.get(pin.dataset.item)))

  const [, edit] = painted
  assert.equal(edit.dataset.item, editor.edits()[0].id)
  assert.equal(edit.dataset.note, undefined, "an edit's pin claims to be a note")
  assert.match(edit.getAttribute("aria-label"), /^Edit 2: opacity: .* → 0\.5$/)
  assert.equal(edit.title, edit.getAttribute("aria-label"))
  assert.equal(painted[2].getAttribute("aria-label"), "Note 3: Third")
  // Anchored at the element's top-left, like a note.
  assert.equal(edit.style.left, "10px")
  assert.equal(edit.style.top, "100px")
})

await check("the edit shape is a shape, not a colour", async () => {
  const rule = /\.de-ann-marker--edit \{([^}]*)\}/.exec(editor.annotationsCss)?.[1] ?? ""
  assert.match(rule, /border-radius:\s*4px/, "the edit pin has no shape of its own")
  assert.doesNotMatch(rule, /background/, "the edit pin left the one colour system")
})

await check("undoing the edit takes its pin away and renumbers the note after it", async () => {
  reset()
  noteOn(button, "First")
  tick()
  editOn(lede, "opacity", "0.5")
  tick()
  /*
   * The third item goes straight into the store, so it is on the list but NOT
   * on the timeline: the next undo is then the edit's, taken out of the middle
   * of the list, which is the case where a pin after it has to renumber.
   */
  editor.addAnnotation({
    kind: "element",
    comment: "Third",
    url: window.location.href,
    rect: { x: 10, y: 200, width: 120, height: 40 },
    target: null,
    selectedText: null,
    element: tag,
  })
  await settle()
  assert.deepEqual(pins().map((pin) => pin.textContent), ["1", "2", "3"])

  assert.equal(editor.undo(), "Set opacity")
  await settle()
  assert.deepEqual(editor.edits(), [], "the undo never reached the journal")
  const painted = pins()
  assert.deepEqual(painted.map((pin) => pin.textContent), ["1", "2"])
  assert.ok(!painted.some((pin) => pin.classList.contains("de-ann-marker--edit")), "the undone edit kept its pin")
  // Renumbered in place, words unchanged — the accessible name has to follow.
  assert.equal(painted[1].getAttribute("aria-label"), "Note 2: Third")
})

console.log("\nPins that share an anchor")

await check("two pins on one element do not share a coordinate", async () => {
  reset()
  noteOn(lede, "Too faint")
  tick()
  editOn(lede, "opacity", "0.9")
  tick()
  editOn(lede, "margin-top", "8px")
  await settle()

  const painted = pins()
  assert.equal(painted.length, 3)
  const spots = painted.map((pin) => `${pin.style.left},${pin.style.top}`)
  assert.equal(new Set(spots).size, 3, `pins stacked on one another: ${spots.join(" | ")}`)
  // Fanned sideways by one pin and a 2px gap, in outbox order.
  assert.deepEqual(
    painted.map((pin) => pin.style.left),
    ["10px", "34px", "58px"]
  )
  assert.ok(painted.every((pin) => pin.style.top === "100px"))
})

console.log("\nWhat a pin does")

await check("clicking an edit pin selects its element and opens no composer", async () => {
  reset()
  editOn(lede, "opacity", "0.5")
  await settle()
  const [pin] = pins()
  assert.ok(pin?.classList.contains("de-ann-marker--edit"), "no edit pin was painted")

  let reached = false
  const hear = () => {
    reached = true
  }
  window.document.body.addEventListener("click", hear)
  pin.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
  window.document.body.removeEventListener("click", hear)

  const selection = editor.getState().selection
  assert.equal(selection.length, 1, "the click selected nothing")
  assert.equal(selection[0].element, lede, "the click selected the wrong element")
  assert.equal(layer.querySelector(".de-ann-composer"), null, "an edit pin opened a composer")
  assert.equal(reached, false, "the click went through the pin to the page")
})

await check("clicking a note pin still reopens its composer", async () => {
  reset()
  noteOn(button, "Reopen me")
  await settle()
  const [pin] = pins()
  pin.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
  const box = layer.querySelector(".de-ann-composer")
  assert.ok(box, "a note pin no longer reopens its composer")
  assert.equal(box.querySelector("textarea").value, "Reopen me")
  box.querySelector("textarea").value = "Rewritten"
  Array.from(box.querySelectorAll("button"))
    .find((b) => b.textContent === "Save note")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
  assert.equal(editor.annotations()[0].comment, "Rewritten")
  // The rewrite is a step too.
  editor.undo()
  assert.equal(editor.annotations()[0].comment, "Reopen me", "the rewrite is not on the timeline")
  assert.deepEqual(editor.getState().selection, [], "a note pin selected its element")
})

console.log("\nOne timeline")

await check("a note pinned through the composer is undone by Cmd+Z", async () => {
  reset()
  noteOn(button, "Undo me")
  await settle()
  assert.equal(pins().length, 1)
  assert.equal(editor.undo(), "Pin note")
  await settle()
  assert.deepEqual(editor.annotations(), [], "the note survived an undo")
  assert.equal(pins().length, 0, "the pin survived its note")
})

await check("hover mirroring names an edit pin by the edit's id", async () => {
  reset()
  editOn(lede, "opacity", "0.5")
  await settle()
  const [pin] = pins()
  const heard = []
  const listen = (event) => heard.push(event.detail.id)
  window.addEventListener("designlayer:marker-hover", listen)
  pin.dispatchEvent(new window.PointerEvent("pointerenter"))
  pin.dispatchEvent(new window.PointerEvent("pointerleave"))
  window.removeEventListener("designlayer:marker-hover", listen)
  assert.deepEqual(heard, [editor.edits()[0].id, null])

  // And the panel's hover lights it.
  window.dispatchEvent(
    new window.CustomEvent("designlayer:annotation-hover", { detail: { id: editor.edits()[0].id } })
  )
  await settle()
  assert.ok(pins()[0].classList.contains("de-ann-marker--active"), "the row's hover did not light the edit pin")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
