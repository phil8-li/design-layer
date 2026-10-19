/**
 * The Layers pane scrolls sideways, so a deep row keeps its name.
 *
 * Pinned: the pane opts in (`data-de-scroll-x`) while the Controls pane keeps
 * the left panel's clip; the header and the filter stay put; the tree is as
 * wide as its widest row with a floor from its deepest visible row; the row
 * actions hang off a zero-wide sticky anchor and still act without selecting;
 * the sideways reveal moves the pane only when a selected row's name is out of
 * view; and the overlay scrollbar draws, inks and drags a bottom thumb for an
 * opted-in pane only.
 *
 * jsdom has no layout, so the stylesheet answers the cascade questions and the
 * thumb's geometry is stubbed per element. Layout itself is checked in a real
 * browser (see the report for this change).
 *
 * Usage: node test/layers-scroll-cases.mjs
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

// Eight levels of nesting under the app, then a named leaf.
const DEEP = Array.from({ length: 8 }, (_, i) => `<div id="level-${i + 1}">`).join("") +
  `<p id="deep-name">Quarterly revenue</p>` + "</div>".repeat(8)
const MARKUP = `<div id="app"><section id="shallow"><span>Top</span></section>${DEEP}</div>`

const dom = new JSDOM(`<!doctype html><html><body>${MARKUP}</body></html>`, {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom
window.document.elementsFromPoint = () => []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
}
window.Element.prototype.scrollIntoView = function scrollIntoView() {}
window.Element.prototype.setPointerCapture = function setPointerCapture() {}
class Observer { observe() {} disconnect() {} }
for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement", "SVGElement",
  "SVGSVGElement", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "Event",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
globalThis.ResizeObserver = Observer
Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true })

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createContext } from "./src/core/context"
      export { installLayersPanel, layersReach, sidewaysScroll } from "./src/panels/layers"
      export { setState } from "./src/core/store"
      export { layersCss } from "./src/core/css/layers"
      export { leftTabsCss } from "./src/core/css/left-tabs"
      export { panelsCss } from "./src/core/css/panels"
      export { mountOverlayScrollbar } from "./src/shell/overlay-scrollbar"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const lib = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)

function elementInfo(element) {
  if (element?.id !== "app") return null
  const frame = { componentName: "App", filePath: "src/App.tsx", lineNumber: 1, columnNumber: 1 }
  return { tagName: "div", ...frame, stack: [frame] }
}
const bridge = { elementInfo, toast() {}, store: { addPendingPropertyOperation() {} } }
const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const context = lib.createContext(bridge, { overlay: slot(), toolbar: slot(), left: slot(), right: slot() })
lib.installLayersPanel(context)

const left = context.slots.left
const tree = left.querySelector(".de-layers-tree")
const rows = () => Array.from(left.querySelectorAll(".de-layer"))
const row = (name) => rows().find((node) => node.querySelector(".de-layer-name").textContent === name)
const press = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
const reach = () => tree.style.getPropertyValue("--de-layers-reach")
const rule = (css, selector) => {
  const at = css.indexOf(`${selector} {`)
  assert.ok(at !== -1, `no rule for ${selector}`)
  return css.slice(at, css.indexOf("}", at))
}

console.log("\nThe pane")

check("the Layers pane opts into sideways scroll; the Controls pane keeps the clip", () => {
  assert.equal(left.hasAttribute("data-de-scroll-x"), true)
  assert.match(rule(lib.leftTabsCss, ".de-panel--left .de-tabpanel"), /overflow-x: hidden/)
  assert.match(rule(lib.leftTabsCss, ".de-panel--left .de-tabpanel[data-de-scroll-x]"), /overflow-x: auto/)
})

check("the header and the filter stay put while the tree scrolls under them", () => {
  const sticky = rule(lib.layersCss, "[data-de-scroll-x] > :is(.de-layers-header, .de-layer-filter-band, .de-empty)")
  assert.match(sticky, /position: sticky/)
  assert.match(sticky, /inset-inline-start: 0/)
})

check("the tree is as wide as its widest row, and never narrower than the pane", () => {
  const css = rule(lib.layersCss, ".de-layers-tree")
  assert.match(css, /width: max-content/)
  assert.match(css, /min-width: max\(100%, var\(--de-layers-reach, 0px\)\)/)
})

console.log("\nThe width floor")

check("each level adds one indent to the floor", () => {
  assert.equal(lib.layersReach(3) - lib.layersReach(2), 16)
  assert.ok(lib.layersReach(0) > 120, "the floor leaves no room for a name")
})

check("the floor follows the deepest visible row, opened and closed", () => {
  context.select(window.document.getElementById("deep-name"))
  const deepest = Math.max(...rows().map((node) => Number(node.getAttribute("aria-level")) - 1))
  assert.ok(deepest >= 9, `the selection did not open its ancestors (deepest level ${deepest})`)
  assert.equal(reach(), `${lib.layersReach(deepest)}px`)
  press(left.querySelector(".de-layers-fold"))
  assert.equal(reach(), `${lib.layersReach(0)}px`)
  // `select` ignores a selection that did not change, so clear it first.
  context.select(null)
  context.select(window.document.getElementById("deep-name"))
  assert.equal(reach(), `${lib.layersReach(deepest)}px`)
})

console.log("\nThe row actions")

check("the actions hang off a zero-wide anchor that sticks to the pane's end", () => {
  for (const node of rows()) {
    const end = node.lastElementChild
    assert.equal(end.className, "de-layer-end")
    assert.ok(end.querySelector(":scope > .de-layer-actions [data-action='lock']"))
  }
  const css = rule(lib.layersCss, ".de-layer-end")
  assert.match(css, /position: sticky/)
  assert.match(css, /inset-inline-end: 4px/)
  assert.match(css, /width: 0/)
  assert.match(css, /margin-inline: auto -8px/)
})

check("an action in the anchor still acts and never selects its row", () => {
  const declaw = (event) => { event.stopPropagation = () => {} }
  window.addEventListener("click", declaw, true)
  try {
    lib.setState({ selection: [] })
    press(row("shallow").querySelector('[data-action="lock"]'))
    assert.ok(row("shallow").classList.contains("de-layer--locked"))
    assert.equal(row("shallow").getAttribute("aria-selected"), "false")
    press(row("shallow").querySelector('[data-action="lock"]'))
    assert.ok(!row("shallow").classList.contains("de-layer--locked"))
  } finally {
    window.removeEventListener("click", declaw, true)
  }
})

console.log("\nThe sideways reveal")

const view = { left: 0, width: 240 }

check("from the tree, a row whose name shows stays put, tail or chevron cut", () => {
  assert.equal(lib.sidewaysScroll(view, { start: 40, name: 76, end: 400 }, true), null)
  assert.equal(lib.sidewaysScroll({ left: 50, width: 240 }, { start: 40, name: 76, end: 150 }, true), null)
})

check("from the tree, a name past either edge brings its row in, one indent from the edge", () => {
  assert.equal(lib.sidewaysScroll(view, { start: 200, name: 236, end: 300 }, true), 184)
  assert.equal(lib.sidewaysScroll({ left: 300, width: 240 }, { start: 40, name: 76, end: 150 }, true), 24)
  assert.equal(lib.sidewaysScroll({ left: 300, width: 240 }, { start: 8, name: 44, end: 90 }, true), 0)
})

check("from the canvas, the whole name comes into view by the shortest move", () => {
  // Already whole: no move.
  assert.equal(lib.sidewaysScroll(view, { start: 40, name: 76, end: 150 }), null)
  // Its tail past the right edge: move just far enough, with 8px to spare.
  assert.equal(lib.sidewaysScroll(view, { start: 250, name: 286, end: 436 }), 204)
  // Off to the left: one indent before the chevron.
  assert.equal(lib.sidewaysScroll({ left: 300, width: 240 }, { start: 40, name: 76, end: 150 }), 24)
})

check("from the canvas, a name wider than the pane starts one indent in", () => {
  assert.equal(lib.sidewaysScroll(view, { start: 100, name: 136, end: 500 }), 84)
  assert.equal(lib.sidewaysScroll({ left: 84, width: 240 }, { start: 100, name: 136, end: 500 }), null)
})

console.log("\nThe bottom thumb")

/** A stand-in panel with one pane, measured the way a browser would report it. */
function stubPane({ optIn, scrollWidth, scrollHeight = 400 }) {
  const panel = window.document.createElement("aside")
  const pane = window.document.createElement("div")
  pane.className = "de-tabpanel"
  if (optIn) pane.setAttribute("data-de-scroll-x", "")
  panel.append(pane)
  window.document.body.append(panel)
  let scrollLeft = 0
  const define = (node, values) => {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(node, key, { configurable: true, ...value })
  }
  define(pane, {
    offsetParent: { get: () => panel },
    clientWidth: { get: () => 240 }, scrollWidth: { get: () => scrollWidth },
    clientHeight: { get: () => 400 }, scrollHeight: { get: () => scrollHeight },
    scrollTop: { get: () => 0, set() {} },
    scrollLeft: { get: () => scrollLeft, set: (value) => { scrollLeft = Math.max(0, Math.min(value, scrollWidth - 240)) } },
    getBoundingClientRect: { value: () => ({ left: 10, top: 50, right: 250, bottom: 450, width: 240, height: 400 }) },
  })
  define(panel, { getBoundingClientRect: { value: () => ({ left: 0, top: 0, right: 260, bottom: 500, width: 260, height: 500 }) } })
  const release = lib.mountOverlayScrollbar(panel, 50)
  panel.dispatchEvent(new window.Event("pointerenter"))
  return { panel, pane, release, x: panel.querySelector(".de-scroll-thumb--x"), y: panel.querySelector(".de-scroll-thumb:not(.de-scroll-thumb--x)") }
}

check("an opted-in pane that overflows sideways gets a bottom thumb, sized to the view", () => {
  const { x, release } = stubPane({ optIn: true, scrollWidth: 480 })
  try {
    assert.equal(x.hidden, false)
    assert.equal(x.style.width, "120px")
    // At the left edge of the pane, 12px up from its bottom.
    assert.equal(x.style.transform, "translate(10px, 438px)")
  } finally {
    release()
  }
})

check("the thumb leaves the corner to the vertical thumb when both show", () => {
  const { x, release } = stubPane({ optIn: true, scrollWidth: 480, scrollHeight: 900 })
  try {
    assert.equal(x.style.width, "114px")
  } finally {
    release()
  }
})

check("a pane that did not opt in gets no bottom thumb, however far it overflows", () => {
  const { x, release } = stubPane({ optIn: false, scrollWidth: 900 })
  try {
    assert.equal(x.hidden, true)
  } finally {
    release()
  }
})

check("a sideways scroll inks the bottom thumb, not the vertical one, and moves it", () => {
  const { pane, x, y, release } = stubPane({ optIn: true, scrollWidth: 480, scrollHeight: 900 })
  try {
    pane.scrollLeft = 240
    pane.dispatchEvent(new window.Event("scroll"))
    assert.equal(x.hasAttribute("data-scrolling"), true)
    assert.equal(y.hasAttribute("data-scrolling"), false)
    // The far end of a 228px track: 10 + (228 - 114).
    assert.equal(x.style.transform, "translate(124px, 438px)")
  } finally {
    release()
  }
})

check("dragging the bottom thumb scrolls the pane sideways", () => {
  const { pane, x, release } = stubPane({ optIn: true, scrollWidth: 480 })
  try {
    x.dispatchEvent(new window.PointerEvent("pointerdown", { button: 0, clientX: 20, pointerId: 1, bubbles: true }))
    x.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 80, pointerId: 1, bubbles: true }))
    // 60px of a 120px free track is half of the 240px range.
    assert.equal(pane.scrollLeft, 120)
    x.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1, bubbles: true }))
    assert.equal(x.hasAttribute("data-dragging"), false)
  } finally {
    release()
  }
})

check("the bottom thumb has its own shape in the stylesheet", () => {
  const css = rule(lib.panelsCss, ".de-scroll-thumb--x")
  assert.match(css, /left: 0/)
  assert.match(css, /height: 12px/)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
