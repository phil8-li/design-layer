/**
 * The Position section: alignment, position, rotation, arrange.
 *
 * Each is easy to get subtly wrong in ways nothing else notices, so this pins
 * the parts a refactor could quietly invert:
 *
 *  - alignment writes on the PARENT, and which property it writes depends on
 *    the parent's flex direction — horizontal is `justify-content` on a row and
 *    `align-items` on a column. Swapping those is invisible until you try it on
 *    a column, which is exactly the case nobody clicks;
 *  - a parent that is not a flex container offers the way in rather than six
 *    controls that would do nothing;
 *  - arrange asks the layers panel's `getSiblings`, refuses the moves that
 *    have nowhere to go, and notes the rest for the agent rather than sending
 *    the engine's `reorder`;
 *  - X and Y stay a readout. The moment X becomes an `<input>` it is
 *    promising a write there is no property to make;
 *  - rotation and flips write `rotate` and `scale` on the element, never
 *    `transform`, and the angle a transform already carries is counted.
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
  "KeyboardEvent",
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
// `rotate`, `scale` and `transform` are read through `getPropertyValue`, so the
// fixture serves them from the same object as the flex longhands.
const withProperties = (layout) => ({
  ...layout,
  getPropertyValue: (property) => layout[property] ?? "",
})
globalThis.getComputedStyle = (node) =>
  withProperties(
    layouts.get(node) ?? {
      display: "block",
      flexDirection: "row",
      justifyContent: "normal",
      alignItems: "normal",
    }
  )

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
  transforms = {},
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
  layouts.set(element, { display: "block", ...transforms })

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
  const moves = []
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
      noteReorder: (selection, move) => moves.push({ target: selection.element, move }),
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
    moves,
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
    row: (id) => node.querySelector(`[data-de-row="${id}"]`),
    rotation: () => node.querySelector('[data-de-field="position.rotation"]'),
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
  assert.equal(view.button("Distribute horizontally"), null)
  // The reason is the button's tooltip and description, not a sentence under it.
  const button = view.button("Make parent auto layout")
  assert.match(button.getAttribute("aria-description"), /<div> is not a flex container/)
  assert.match(button.getAttribute("data-de-tip"), /is not a flex container/)
  assert.equal(view.node().querySelector(".de-hint"), null)
  view.press("Make parent auto layout")
  assert.deepEqual(lastWrite(view).styles, [{ property: "display", value: "flex" }])
  assert.equal(lastWrite(view).target, view.parent)
})

check("the row says it acts on every child in its tooltips, not in a sentence", () => {
  const view = scene()
  assert.doesNotMatch(view.text(), /Aligns all children/)
  assert.equal(view.node().querySelector(".de-hint"), null)
  assert.equal(view.strip("Align").getAttribute("aria-description"), "Aligns all children of <div>.")
  assert.equal(view.button("Align left").getAttribute("data-de-tip"), "Align left. Aligns all children of <div>.")
  // The name stays the name: the description is extra, not a replacement.
  assert.equal(view.button("Align left").getAttribute("aria-label"), "Align left")
})

check("the six marks are one captioned row on the panel grid", () => {
  const row = scene().strip("Align")
  assert.ok(row.classList.contains("de-prow"), "the align toolbar is not a property row")
  assert.equal(row.querySelector(".de-prow-caption").textContent, "Alignment")
  assert.equal(row.querySelectorAll(".de-prow-cell .de-agroup").length, 2)
})

/* ---------- distribute ---------- */

console.log("\nDistribute")

check("one element selected offers no distribute: Layout's gap Auto owns spacing", () => {
  assert.equal(scene().button("Distribute horizontally"), null)
  assert.equal(scene({ parent: { display: "flex", flexDirection: "column" } }).button("Distribute vertically"), null)
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

check("each arrange button notes its move for the agent and sends no reorder", () => {
  for (const [label, move] of [
    ["Bring to front", "front"],
    ["Bring forward", "forward"],
    ["Send backward", "backward"],
    ["Send to back", "back"],
  ]) {
    const view = scene().reply([8, 10, 12, 14, 16]).render().press(label)
    assert.deepEqual(view.moves, [{ target: view.element, move }], `${label} noted the wrong move`)
    assert.ok(!view.sent.some((message) => message.type === "reorder"), `${label} rewrote the source`)
  }
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

/* ---------- position ---------- */

console.log("\nPosition")

check("X and Y are present and read-only, and W and H have moved to Layout", () => {
  const view = scene()
  const row = view.row("position.xy")
  assert.ok(row, "there is no Position row")
  assert.equal(row.querySelector(".de-prow-caption").textContent, "Position")
  assert.deepEqual(
    Array.from(row.querySelectorAll(".de-field-label"), (node) => node.textContent),
    ["X", "Y"]
  )
  assert.equal(row.querySelectorAll("input").length, 0, "the readout grew a field")
  assert.equal(row.querySelectorAll(".de-field-value").length, 2)
  const letters = Array.from(view.node().querySelectorAll(".de-field-label"), (node) => node.textContent)
  assert.equal(letters.includes("W"), false, "W is still drawn in Position")
  assert.equal(letters.includes("H"), false, "H is still drawn in Position")
  assert.doesNotMatch(view.text(), /Size/)
})

check("the rows come in Figma's order", () => {
  const captions = Array.from(scene().node().querySelectorAll(".de-prow-caption"), (node) => node.textContent)
  assert.deepEqual(captions, ["Alignment", "Position", "Rotation", "Arrange"])
})

/* ---------- rotation ---------- */

console.log("\nRotation")

const type = (view, value, key = "Enter", extra = {}) => {
  const input = view.rotation()
  input.value = value
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, ...extra }))
  return view
}

check("an angle field with the angle mark, then rotate and the two flips", () => {
  const view = scene()
  const row = view.row("position.rotation")
  assert.ok(row, "there is no Rotation row")
  assert.equal(row.querySelector(".de-prow-caption").textContent, "Rotation")
  const field = view.rotation()
  assert.equal(field.value, "0")
  assert.equal(field.getAttribute("aria-label"), "Rotation")
  assert.ok(field.closest(".de-field").querySelector(".de-field-label svg"), "the prefix is not a drawn mark")
  assert.equal(field.closest(".de-field").querySelector(".de-field-suffix").textContent, "°")
  const group = row.querySelector('[aria-label="Rotate and flip"]')
  assert.deepEqual(
    Array.from(group.querySelectorAll("button"), (node) => node.getAttribute("aria-label")),
    ["Rotate 90° right", "Flip horizontal", "Flip vertical"]
  )
})

check("the angle is read off computed rotate, in any unit", () => {
  assert.equal(scene({ transforms: { rotate: "45deg" } }).rotation().value, "45")
  assert.equal(scene({ transforms: { rotate: "0.25turn" } }).rotation().value, "90")
  assert.equal(scene({ transforms: { rotate: "z 30deg" } }).rotation().value, "30")
  assert.equal(scene({ transforms: { rotate: "none" } }).rotation().value, "0")
})

check("a transform's rotation is counted, and a commit writes only rotate's share", () => {
  const view = scene({ transforms: { transform: "matrix(0, 1, -1, 0, 0, 0)" } })
  assert.equal(view.rotation().value, "90")
  type(view, "30")
  assert.deepEqual(lastWrite(view).styles, [{ property: "rotate", value: "-60deg" }])
})

check("Enter writes rotate on the element, never transform", () => {
  const view = type(scene(), "30")
  assert.equal(lastWrite(view).target, view.element)
  assert.deepEqual(lastWrite(view).styles, [{ property: "rotate", value: "30deg" }])
  assert.equal(lastWrite(view).summary, "Rotate")
  assert.ok(view.renders >= 1, "the panel was not asked to re-render")
})

check("the field takes arrows, Shift steps and math", () => {
  assert.deepEqual(lastWrite(type(scene(), "0", "ArrowUp")).styles, [{ property: "rotate", value: "1deg" }])
  assert.deepEqual(
    lastWrite(type(scene(), "0", "ArrowDown", { shiftKey: true })).styles,
    [{ property: "rotate", value: "-10deg" }]
  )
  assert.deepEqual(lastWrite(type(scene(), "10*3")).styles, [{ property: "rotate", value: "30deg" }])
})

check("angles fold into -180..180, the range the field shows", () => {
  assert.deepEqual(lastWrite(type(scene(), "270")).styles, [{ property: "rotate", value: "-90deg" }])
  assert.equal(scene({ transforms: { rotate: "540deg" } }).rotation().value, "180")
})

check("Rotate 90° right adds a quarter turn clockwise", () => {
  const view = scene().press("Rotate 90° right")
  assert.deepEqual(lastWrite(view).styles, [{ property: "rotate", value: "90deg" }])
  assert.equal(lastWrite(view).target, view.element)
  const late = scene({ transforms: { rotate: "135deg" } }).press("Rotate 90° right")
  assert.deepEqual(lastWrite(late).styles, [{ property: "rotate", value: "-135deg" }])
})

check("Flip horizontal mirrors the x scale, and pressing it again mirrors it back", () => {
  const view = scene()
  assert.equal(view.button("Flip horizontal").getAttribute("aria-pressed"), "false")
  view.press("Flip horizontal")
  assert.deepEqual(lastWrite(view).styles, [{ property: "scale", value: "-1 1" }])
  const flipped = scene({ transforms: { scale: "-1 1" } })
  assert.equal(flipped.button("Flip horizontal").getAttribute("aria-pressed"), "true")
  assert.equal(flipped.button("Flip vertical").getAttribute("aria-pressed"), "false")
  flipped.press("Flip horizontal")
  assert.deepEqual(lastWrite(flipped).styles, [{ property: "scale", value: "none" }])
})

check("the two flips combine, and keep a scale the element already had", () => {
  const both = scene({ transforms: { scale: "-1 1" } }).press("Flip vertical")
  assert.deepEqual(lastWrite(both).styles, [{ property: "scale", value: "-1 -1" }])
  const sized = scene({ transforms: { scale: "2" } }).press("Flip vertical")
  assert.deepEqual(lastWrite(sized).styles, [{ property: "scale", value: "2 -2" }])
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
