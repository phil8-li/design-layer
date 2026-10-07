/**
 * Aligning several selected elements to each other.
 *
 * Figma's align acts on the selection; ours only ever acted on the primary
 * one's parent, so five picked boxes wrote `align-items` on the container and
 * moved every sibling too. The fix has two halves and both are easy to get
 * quietly wrong, which is what these cases are for:
 *
 *  - the CROSS axis is per child. "Align top" in a row writes `align-self` on
 *    every selected element, in ONE batched write — so it is one undo, one
 *    toast, and a `self-*` class per element at "Apply to code". A loop over
 *    `applyStyles` would look identical on screen and be four undos wrong;
 *  - the MAIN axis has no per-child property, so "Align left" in a row stays
 *    the single `justify-content` write on the shared parent it always was.
 *    Which axis is which flips with the parent's direction, and getting that
 *    backwards is invisible until someone selects inside a column;
 *  - a selection spanning two parents is refused with a sentence rather than
 *    with six buttons that would write something other than what they draw.
 *
 * The strip itself is asserted against the single-selection one it replaces:
 * same six marks, same order, a different `aria-label` so `position-cases.mjs`
 * keeps finding the strip it is about.
 *
 * Usage: node designlayer/test/multi-align-cases.mjs
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

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" })
const { window } = dom
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
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

/*
 * The same fixture-backed `getComputedStyle` as `position-cases.mjs` — jsdom
 * carries none of the flexbox longhands the section reads — with two
 * additions this suite needs.
 *
 * `alignSelf` is served off the element's own inline style, because that is
 * what the write under test sets and the pressed state reads it straight back.
 * And `getPropertyValue` is delegated to the real jsdom declaration rather
 * than omitted: the undo case drives the REAL writer, which reads every
 * "before" through it, and an object without one throws inside the writer
 * where the assertion should have failed.
 */
const realComputed = window.getComputedStyle.bind(window)
const layouts = new WeakMap()
globalThis.getComputedStyle = (node) => {
  const layout = layouts.get(node) ?? {}
  const real = realComputed(node)
  return {
    display: layout.display ?? "block",
    flexDirection: layout.flexDirection ?? "row",
    justifyContent: layout.justifyContent ?? "normal",
    alignItems: layout.alignItems ?? "normal",
    alignSelf: node.style?.getPropertyValue("align-self") || layout.alignSelf || "normal",
    getPropertyValue: (property) => real.getPropertyValue(property),
  }
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { positionSection } from "./src/panels/inspector/section-position"
      export { forgetSiblings } from "./src/core/arrange"
      export { createWriter } from "./src/core/writer"
      export * as history from "./src/core/history"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const inspector = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)
const { history } = inspector

/* ---------- fixture ---------- */

const PAGE = "/app/page.tsx"
const ROW = { display: "flex", flexDirection: "row" }

/**
 * `count` siblings in one flex parent, all of them selected.
 *
 * `split` moves the last one into a second parent, which is the "these do not
 * share a layout" case. `real` swaps the recording stub for the actual writer,
 * so the undo case exercises the timeline rather than a fake of it.
 */
function scene({ count = 3, parent: parentLayout = ROW, split = false, real = false } = {}) {
  inspector.forgetSiblings()
  history.resetHistory()
  window.document.body.replaceChildren()

  const parent = window.document.createElement("div")
  const other = window.document.createElement("div")
  window.document.body.append(parent, other)
  for (const node of [parent, other]) {
    layouts.set(node, {
      display: "block",
      flexDirection: "row",
      justifyContent: "normal",
      alignItems: "normal",
      ...parentLayout,
    })
  }

  const frame = (componentName, lineNumber) => ({
    componentName,
    filePath: PAGE,
    lineNumber,
    columnNumber: 4,
  })
  const info = new Map([
    [parent, { tagName: "div", ...frame("Page", 5), stack: [frame("Page", 5)] }],
    [other, { tagName: "div", ...frame("Page", 40), stack: [frame("Page", 40)] }],
  ])

  const elements = []
  for (let index = 0; index < count; index += 1) {
    const element = window.document.createElement("button")
    const host = split && index === count - 1 ? other : parent
    host.append(element)
    elements.push(element)
    const line = 12 + index * 2
    info.set(element, {
      tagName: "button",
      ...frame("Card", line),
      stack: [frame("Card", line), frame("Page", host === parent ? 5 : 40)],
    })
  }

  const selections = elements.map((element, index) => ({
    element,
    tagName: "button",
    componentName: "Card",
    source: { filePath: PAGE, lineNumber: 12 + index * 2, columnNumber: 4, componentName: "Card" },
    key: `card-${index}`,
  }))

  const sent = []
  const toasts = []
  const queued = []
  const writes = []
  const batches = []
  let renders = 0

  const bridge = {
    elementInfo: (node) => info.get(node) ?? null,
    send: (message) => sent.push(message),
    subscribe: () => () => {},
    toast: (message, kind) => toasts.push({ message, kind }),
    store: {
      addPendingPropertyOperation: (mergeKey, operation, keys) =>
        queued.push({ mergeKey, operation, keys }),
    },
  }

  const stub = {
    applyStyles: (selection, styles, summary) =>
      writes.push({ target: selection.element, styles, summary }),
    applyStylesBatch: (edits, summary) => batches.push({ edits, summary }),
  }

  const context = {
    editor: { bridge },
    writer: real ? inspector.createWriter(bridge) : stub,
    selection: selections[0],
    selections,
    computed: getComputedStyle(elements[0]),
    invalidate: () => {
      renders += 1
    },
  }

  let node = inspector.positionSection(context)
  const api = {
    parent,
    other,
    elements,
    writes,
    batches,
    toasts,
    sent,
    get renders() {
      return renders
    },
    render() {
      node = inspector.positionSection(context)
      return api
    },
    button: (label) =>
      node.querySelector(`[aria-label="${label}"]`) ??
      Array.from(node.querySelectorAll("button")).find((entry) => entry.textContent === label) ??
      null,
    strip: (label) => node.querySelector(`[role="toolbar"][aria-label="${label}"]`),
    text: () => node.textContent,
    node: () => node,
    press(label) {
      const button = api.button(label)
      assert.ok(button, `no control labelled ${label}`)
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
      return api
    },
  }
  return api
}

const SIX = [
  "Align left",
  "Align horizontal centers",
  "Align right",
  "Align top",
  "Align vertical centers",
  "Align bottom",
]

const selfValues = (view) =>
  view.elements.map((element) => element.style.getPropertyValue("align-self"))

/* ---------- which strip is drawn ---------- */

console.log("\nWhich strip is drawn")

check("one selected element keeps the parent strip and grows no second one", () => {
  const view = scene({ count: 1 })
  assert.ok(view.strip("Align"), "the single-selection strip is gone")
  assert.equal(view.strip("Align selection"), null)
})

check("a second selected element swaps one strip for the other", () => {
  const view = scene({ count: 2 })
  assert.ok(view.strip("Align selection"), "there is no multi-selection strip")
  assert.equal(view.strip("Align"), null, "both strips are on screen at once")
})

check("it is the same six marks, in the same order", () => {
  const strip = scene().strip("Align selection")
  assert.equal(strip.querySelectorAll("button").length, 6)
  assert.deepEqual(
    Array.from(strip.querySelectorAll("button"), (node) => node.getAttribute("aria-label")),
    SIX
  )
})

check("and they are drawn at the same size, with no text mark", () => {
  for (const button of scene().strip("Align selection").querySelectorAll("button")) {
    assert.equal(button.querySelector("svg")?.getAttribute("width"), "16")
    assert.equal(button.textContent, "")
  }
})

check("distribute survives the swap, because spreading a row is a multi verb", () => {
  const view = scene({ count: 3 })
  assert.ok(view.button("Distribute horizontally"), "the multi strip ate the distribute button")
  view.press("Distribute horizontally")
  assert.deepEqual(view.writes[0].styles, [
    { property: "justify-content", value: "space-between" },
  ])
  assert.equal(view.writes[0].target, view.parent)
})

check("the header count is not this section's job, so the frame is untouched", () => {
  const view = scene()
  assert.deepEqual(
    Array.from(view.node().querySelectorAll(".de-field-label"), (node) => node.textContent),
    ["X", "Y", "W", "H"]
  )
})

/* ---------- the cross axis: one write per element ---------- */

console.log("\nThe cross axis, on a row parent")

check("Align top carries align-self for every selected element, in one batch", () => {
  const view = scene({ count: 3 }).press("Align top")
  assert.equal(view.batches.length, 1, "the write did not arrive as a single batch")
  assert.equal(view.writes.length, 0, "something also wrote on the parent")
  const { edits, summary } = view.batches[0]
  assert.equal(edits.length, 3)
  assert.deepEqual(
    edits.map((edit) => edit.selection.element),
    view.elements
  )
  for (const edit of edits) {
    assert.deepEqual(edit.writes, [{ property: "align-self", value: "flex-start" }])
  }
  assert.match(summary, /Align top/)
})

check("the middle and bottom marks write the other two places", () => {
  for (const [label, value] of [
    ["Align vertical centers", "center"],
    ["Align bottom", "flex-end"],
  ]) {
    const view = scene().press(label)
    assert.equal(view.batches.length, 1, label)
    for (const edit of view.batches[0].edits) {
      assert.deepEqual(edit.writes, [{ property: "align-self", value }], label)
    }
  }
})

check("a cross-axis mark is pressed only when they all agree", () => {
  const view = scene()
  for (const element of view.elements) element.style.setProperty("align-self", "center")
  view.render()
  assert.equal(view.button("Align vertical centers").getAttribute("aria-pressed"), "true")
  assert.equal(view.button("Align top").getAttribute("aria-pressed"), "false")

  view.elements[2].style.setProperty("align-self", "flex-end")
  view.render()
  assert.equal(
    view.button("Align vertical centers").getAttribute("aria-pressed"),
    "false",
    "one element out of line still reads as centred"
  )
})

/* ---------- the main axis: still the parent ---------- */

console.log("\nThe main axis, on a row parent")

check("Align left writes justify-content once, on the shared parent", () => {
  const view = scene({ count: 3 }).press("Align left")
  assert.equal(view.batches.length, 0, "the main axis was written per element")
  assert.equal(view.writes.length, 1)
  assert.deepEqual(view.writes[0].styles, [{ property: "justify-content", value: "flex-start" }])
  assert.equal(view.writes[0].target, view.parent)
})

check("the parent's own justify-content is what lights the main triple", () => {
  const view = scene({ parent: { ...ROW, justifyContent: "center" } })
  assert.equal(view.button("Align horizontal centers").getAttribute("aria-pressed"), "true")
  assert.equal(view.button("Align left").getAttribute("aria-pressed"), "false")
})

console.log("\nThe axes swap on a column parent")

check("left and right become the per-element write", () => {
  const view = scene({ parent: { display: "flex", flexDirection: "column" } }).press("Align right")
  assert.equal(view.writes.length, 0)
  assert.equal(view.batches.length, 1)
  for (const edit of view.batches[0].edits) {
    assert.deepEqual(edit.writes, [{ property: "align-self", value: "flex-end" }])
  }
})

check("top and bottom become the single parent write", () => {
  const view = scene({ parent: { display: "flex", flexDirection: "column" } }).press("Align bottom")
  assert.equal(view.batches.length, 0)
  assert.deepEqual(view.writes[0].styles, [{ property: "justify-content", value: "flex-end" }])
  assert.equal(view.writes[0].target, view.parent)
})

/* ---------- refusals ---------- */

console.log("\nWhen there is nothing to align in")

check("a selection spanning two parents draws a sentence and no strip", () => {
  const view = scene({ count: 3, split: true })
  assert.equal(view.strip("Align selection"), null)
  assert.equal(view.strip("Align"), null, "it fell through to the single-selection strip")
  assert.match(view.text(), /same parent/)
})

check("a shared parent that is not flex offers the way in", () => {
  const view = scene({ parent: { display: "block" } })
  assert.equal(view.strip("Align selection"), null)
  assert.match(view.text(), /is not a flex container/)
  view.press("Make parent auto layout")
  assert.deepEqual(view.writes[0].styles, [{ property: "display", value: "flex" }])
  assert.equal(view.writes[0].target, view.parent)
})

check("a scattered selection offers no distribute either", () => {
  // The primary's parent is still a flex container, so the button is one
  // `parentAlignment` call away from being drawn — and pressing it would
  // spread a container two of the three picked elements are not in.
  assert.equal(scene({ count: 3, split: true }).button("Distribute horizontally"), null)
})

check("the hint says which three marks place the elements one by one", () => {
  assert.match(scene().text(), /Top, middle and bottom align each element/)
  const column = scene({ parent: { display: "flex", flexDirection: "column" } })
  assert.match(column.text(), /Left, center and right align each element/)
})

/* ---------- the timeline ---------- */

console.log("\nOne press, one undo")

/*
 * Undo puts `auto` back rather than an empty string, and that is the writer's
 * deliberate choice, not slack in the assertion: `currentValue` records the
 * COMPUTED value as the "before" so the revert is a declaration the translator
 * can still spell — `self-auto` is in the keyword table, an empty value is
 * nothing. What matters here is that all three elements move back together.
 */
check("aligning three elements records exactly one step", () => {
  const view = scene({ count: 3, real: true }).press("Align top")
  assert.deepEqual(selfValues(view), ["flex-start", "flex-start", "flex-start"])
  assert.equal(history.canUndo(), true)
  assert.equal(history.undo(), "Align top (3 selected)")
  assert.deepEqual(selfValues(view), ["auto", "auto", "auto"], "one undo left elements aligned")
  assert.equal(history.canUndo(), false, "the batch landed as more than one step")
})

check("redo puts all three back together", () => {
  const view = scene({ count: 3, real: true }).press("Align bottom")
  history.undo()
  history.redo()
  assert.deepEqual(selfValues(view), ["flex-end", "flex-end", "flex-end"])
  assert.equal(history.canRedo(), false)
})

check("aligning three elements says nothing", () => {
  const view = scene({ count: 3, real: true }).press("Align top")
  // align-self is expressible, so nothing was lost — and a successful direct
  // edit raises no toast, however many elements it moved.
  assert.equal(view.toasts.length, 0, view.toasts.map((entry) => entry.message).join(" | "))
})

check("an element already in place is left out of the step", () => {
  const view = scene({ count: 3, real: true })
  view.elements[0].style.setProperty("align-self", "flex-start")
  view.render().press("Align top")
  assert.deepEqual(selfValues(view), ["flex-start", "flex-start", "flex-start"])
  history.undo()
  assert.deepEqual(
    selfValues(view),
    ["flex-start", "auto", "auto"],
    "undo reverted an element the press never moved"
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
