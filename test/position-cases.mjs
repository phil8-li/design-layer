/**
 * The Position section: align, distribute, arrange, frame.
 *
 * All four are easy to get subtly wrong in ways nothing else notices, so this
 * pins the parts a refactor could quietly invert:
 *
 *  - alignment writes on the PARENT, and which property it writes depends on
 *    the parent's flex direction — horizontal is `justify-content` on a row and
 *    `align-items` on a column. Swapping those is invisible until you try it on
 *    a column, which is exactly the case nobody clicks;
 *  - a parent that is not a flex container offers the way in rather than six
 *    controls that would do nothing;
 *  - arrange speaks the layers panel's protocol — `getSiblings` then `reorder`
 *    — and refuses the moves that have nowhere to go;
 *  - the frame stays a readout. The moment X becomes an `<input>` it is
 *    promising a write there is no property to make.
 *
 * Usage: node designlayer/test/position-cases.mjs
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
 * JSDOM's own `getComputedStyle` does not carry the flexbox longhands this
 * section reads, so the four values the parent is judged by are served straight
 * off the fixture. The section only ever asks for these; anything else it
 * touched would show up here as `undefined` rather than as a silent pass.
 */
const layouts = new WeakMap()
globalThis.getComputedStyle = (node) =>
  layouts.get(node) ?? {
    display: "block",
    flexDirection: "row",
    justifyContent: "normal",
    alignItems: "normal",
  }

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { positionSection } from "./src/panels/inspector/section-position"
      export { forgetSiblings } from "./src/core/arrange"
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

/* ---------- fixture ---------- */

const PAGE = "/app/page.tsx"

/**
 * One selected element inside one parent, plus the stubs the section reads it
 * through. `source` describes the JSX line the engine resolved the element to;
 * passing `source: null` is the "the engine could not place this node" case.
 */
function scene({
  parent: parentLayout = { display: "flex", flexDirection: "row" },
  line = 12,
  parentLine = 5,
  source = true,
} = {}) {
  inspector.forgetSiblings()
  window.document.body.replaceChildren()

  const parent = window.document.createElement("div")
  const element = window.document.createElement("button")
  parent.append(element)
  window.document.body.append(parent)
  layouts.set(parent, {
    display: "block",
    flexDirection: "row",
    justifyContent: "normal",
    alignItems: "normal",
    ...parentLayout,
  })

  const frame = (componentName, filePath, lineNumber) => ({
    componentName,
    filePath,
    lineNumber,
    columnNumber: 4,
  })
  const info = new Map([
    [
      element,
      {
        tagName: "button",
        ...frame("Card", PAGE, line),
        stack: [frame("Card", PAGE, line), frame("Page", PAGE, parentLine)],
      },
    ],
    [
      parent,
      {
        tagName: "div",
        ...frame("Page", PAGE, parentLine),
        stack: [frame("Page", PAGE, parentLine)],
      },
    ],
  ])

  const sent = []
  const listeners = new Set()
  const writes = []
  let renders = 0

  const bridge = {
    elementInfo: (node) => (source ? info.get(node) ?? null : null),
    send: (message) => sent.push(message),
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  const context = {
    editor: { bridge },
    writer: {
      applyStyles: (selection, styles, summary) =>
        writes.push({ target: selection.element, styles, summary }),
    },
    selection: {
      element,
      tagName: "button",
      componentName: "Card",
      source: source ? { filePath: PAGE, lineNumber: line, columnNumber: 4, componentName: "Card" } : null,
      key: "card",
    },
    computed: getComputedStyle(element),
    invalidate: () => {
      renders += 1
    },
  }

  let node = inspector.positionSection(context)
  const api = {
    parent,
    element,
    sent,
    writes,
    get renders() {
      return renders
    },
    render() {
      node = inspector.positionSection(context)
      return api
    },
    // By its accessible name: the icon strips label themselves, the plain
    // buttons name themselves in their own text.
    button: (label) =>
      node.querySelector(`[aria-label="${label}"]`) ??
      Array.from(node.querySelectorAll("button")).find((button) => button.textContent === label) ??
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
    reply(lines) {
      for (const fn of [...listeners]) {
        fn({ type: "siblingsList", siblings: lines.map((lineNumber) => ({ lineNumber })) })
      }
      return api
    },
  }
  return api
}

const lastWrite = (view) => view.writes[view.writes.length - 1]
const lastSent = (view) => view.sent[view.sent.length - 1]

/* ---------- align ---------- */

console.log("\nAlign, on a row parent")

check("the six marks sit in one toolbar, as two groups of three", () => {
  const view = scene()
  const strip = view.strip("Align")
  assert.ok(strip, "there is no align toolbar")
  assert.equal(strip.querySelectorAll("button").length, 6)
  assert.deepEqual(
    Array.from(strip.querySelectorAll("button"), (node) => node.getAttribute("aria-label")),
    [
      "Align left",
      "Align horizontal centers",
      "Align right",
      "Align top",
      "Align vertical centers",
      "Align bottom",
    ]
  )
})

check("every mark is drawn, not typed, and all six are one size", () => {
  const view = scene()
  const buttons = Array.from(view.strip("Align").querySelectorAll("button"))
  assert.ok(buttons.length > 0, "the align strip drew no buttons")
  for (const button of buttons) {
    // 16, the ramp's `control` rung — these sit in 24px tool buttons beside the
    // toolbar's own marks. It used to be 14, which is not on the ramp at all.
    assert.equal(button.querySelector("svg")?.getAttribute("width"), "16")
    assert.equal(button.textContent, "", `${button.getAttribute("aria-label")} carries a text mark`)
  }
  // Read off each other as well as off the number: the point of the strip is
  // that the six marks are the same size, whatever that size is.
  const sizes = new Set(buttons.map((b) => b.querySelector("svg")?.getAttribute("width")))
  assert.equal(sizes.size, 1, `the align strip draws ${sizes.size} different sizes`)
})

check("horizontal is justify-content and vertical is align-items", () => {
  for (const [label, property, value] of [
    ["Align left", "justify-content", "flex-start"],
    ["Align horizontal centers", "justify-content", "center"],
    ["Align right", "justify-content", "flex-end"],
    ["Align top", "align-items", "flex-start"],
    ["Align vertical centers", "align-items", "center"],
    ["Align bottom", "align-items", "flex-end"],
  ]) {
    const view = scene().press(label)
    assert.deepEqual(lastWrite(view).styles, [{ property, value }], label)
  }
})

check("the write lands on the parent, never on the selection", () => {
  const view = scene().press("Align right")
  assert.equal(lastWrite(view).target, view.parent)
})

check("the pressed mark is read back off the parent's computed style", () => {
  const view = scene({ parent: { display: "flex", flexDirection: "row", justifyContent: "center" } })
  assert.equal(view.button("Align horizontal centers").getAttribute("aria-pressed"), "true")
  assert.equal(view.button("Align left").getAttribute("aria-pressed"), "false")
  assert.equal(view.button("Align right").getAttribute("aria-pressed"), "false")
  // `normal` is what an untouched flex container computes to, and it lays out
  // at the start — so the vertical triple is not blank, it reads "top".
  assert.equal(view.button("Align top").getAttribute("aria-pressed"), "true")
  assert.equal(view.button("Align bottom").getAttribute("aria-pressed"), "false")
})

console.log("\nAlign, on a column parent")

check("the axes swap properties, because the main axis has", () => {
  for (const [label, property, value] of [
    ["Align left", "align-items", "flex-start"],
    ["Align right", "align-items", "flex-end"],
    ["Align top", "justify-content", "flex-start"],
    ["Align bottom", "justify-content", "flex-end"],
  ]) {
    const view = scene({ parent: { display: "flex", flexDirection: "column" } }).press(label)
    assert.deepEqual(lastWrite(view).styles, [{ property, value }], label)
  }
})

check("a column parent reads its pressed state off align-items for horizontal", () => {
  const view = scene({ parent: { display: "flex", flexDirection: "column", alignItems: "center" } })
  assert.equal(view.button("Align horizontal centers").getAttribute("aria-pressed"), "true")
})

console.log("\nAlign, with nothing to align in")

check("a parent that is not flex offers the way in instead of six dead marks", () => {
  const view = scene({ parent: { display: "block" } })
  assert.equal(view.strip("Align"), null)
  assert.equal(view.strip("Distribute"), null)
  assert.match(view.text(), /is not a flex container/)
  view.press("Make parent auto layout")
  assert.deepEqual(lastWrite(view).styles, [{ property: "display", value: "flex" }])
  assert.equal(lastWrite(view).target, view.parent)
})

check("the hint says out loud that alignment acts on every child", () => {
  assert.match(scene().text(), /Aligns all children of <div>/)
})

/* ---------- distribute ---------- */

console.log("\nDistribute")

check("one button, wearing the mark for the parent's main axis", () => {
  assert.ok(scene().button("Distribute horizontally"), "a row parent has no horizontal spread")
  const column = scene({ parent: { display: "flex", flexDirection: "column" } })
  assert.ok(column.button("Distribute vertically"), "a column parent has no vertical spread")
  assert.equal(column.button("Distribute horizontally"), null)
})

check("it spreads the main axis, which is always justify-content", () => {
  const row = scene().press("Distribute horizontally")
  assert.deepEqual(lastWrite(row).styles, [{ property: "justify-content", value: "space-between" }])
  const column = scene({ parent: { display: "flex", flexDirection: "column" } }).press(
    "Distribute vertically"
  )
  assert.deepEqual(lastWrite(column).styles, [
    { property: "justify-content", value: "space-between" },
  ])
})

check("a parent that is already spread shows it", () => {
  const view = scene({
    parent: { display: "flex", flexDirection: "row", justifyContent: "space-between" },
  })
  assert.equal(view.button("Distribute horizontally").getAttribute("aria-pressed"), "true")
  assert.equal(scene().button("Distribute horizontally").getAttribute("aria-pressed"), "false")
})

/* ---------- arrange ---------- */

console.log("\nArrange")

const ARRANGE = ["Bring to front", "Bring forward", "Send backward", "Send to back"]
const disabled = (view) => ARRANGE.filter((label) => view.button(label).disabled)

check("the four moves are drawn in front-to-back order", () => {
  const strip = scene().strip("Arrange")
  assert.ok(strip, "there is no arrange toolbar")
  assert.deepEqual(
    Array.from(strip.querySelectorAll("button"), (node) => node.getAttribute("aria-label")),
    ARRANGE
  )
})

check("the section asks the engine for the parent's JSX children", () => {
  const view = scene()
  assert.deepEqual(view.sent, [{ type: "getSiblings", filePath: PAGE, parentLine: 5 }])
})

check("until the list arrives there is nothing safe to offer", () => {
  assert.deepEqual(disabled(scene()), ARRANGE)
})

check("the answer re-renders the section rather than mutating it", () => {
  const view = scene()
  assert.equal(view.renders, 0)
  view.reply([8, 10, 12, 14, 16])
  assert.equal(view.renders, 1)
})

check("a middle child can go all four ways, and asks only once", () => {
  const view = scene().reply([8, 10, 12, 14, 16]).render()
  assert.deepEqual(disabled(view), [])
  assert.equal(view.sent.filter((message) => message.type === "getSiblings").length, 1)
})

check("to front and forward reorder this node before an earlier sibling", () => {
  const front = scene().reply([8, 10, 12, 14, 16]).render().press("Bring to front")
  assert.deepEqual(lastSent(front), { type: "reorder", filePath: PAGE, fromLine: 12, toLine: 8 })
  const forward = scene().reply([8, 10, 12, 14, 16]).render().press("Bring forward")
  assert.deepEqual(lastSent(forward), { type: "reorder", filePath: PAGE, fromLine: 12, toLine: 10 })
})

check("one step back moves the sibling below us, because there is no insert-after", () => {
  const view = scene().reply([8, 10, 12, 14, 16]).render().press("Send backward")
  assert.deepEqual(lastSent(view), { type: "reorder", filePath: PAGE, fromLine: 14, toLine: 12 })
})

check("to back names our own line, the only way to say last", () => {
  const view = scene().reply([8, 10, 12, 14, 16]).render().press("Send to back")
  assert.deepEqual(lastSent(view), { type: "reorder", filePath: PAGE, fromLine: 12, toLine: 12 })
})

check("the first child cannot go further forward", () => {
  const view = scene({ line: 8 }).reply([8, 10, 12]).render()
  assert.deepEqual(disabled(view), ["Bring to front", "Bring forward"])
})

check("the last child cannot go further back", () => {
  const view = scene({ line: 12 }).reply([8, 10, 12]).render()
  assert.deepEqual(disabled(view), ["Send backward", "Send to back"])
})

check("an only child has nowhere to go at all", () => {
  const view = scene().reply([12]).render()
  assert.deepEqual(disabled(view), ARRANGE)
})

check("no source reference means no question and no moves", () => {
  const view = scene({ source: false })
  assert.deepEqual(view.sent, [])
  assert.deepEqual(disabled(view), ARRANGE)
})

check("a disabled move sends nothing when it is clicked anyway", () => {
  const view = scene({ line: 8 }).reply([8, 10, 12]).render()
  const before = view.sent.length
  view.press("Bring to front")
  assert.equal(view.sent.length, before)
})

/* ---------- frame ---------- */

console.log("\nFrame")

check("X, Y, W and H are all present, and all read-only", () => {
  const view = scene()
  const labels = Array.from(
    view.node().querySelectorAll(".de-field-label"),
    (node) => node.textContent
  )
  assert.deepEqual(labels, ["X", "Y", "W", "H"])
  assert.equal(view.node().querySelectorAll("input").length, 0, "the frame grew a field")
  assert.equal(view.node().querySelectorAll(".de-field-value").length, 4)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
