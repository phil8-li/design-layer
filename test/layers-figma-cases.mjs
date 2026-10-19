/**
 * The Layers tree reads like Figma's: a type glyph per kind, layers named by
 * component, text or id with the tag kept, the selection drawn as one block,
 * row actions that stay up on a locked or hidden row, chevrons only where
 * there are children, and a header with search and collapse/expand all.
 *
 * Mounted over a jsdom fixture and driven with real events, as
 * `layers-cases.mjs` does. Cascade questions are asserted on the stylesheet.
 *
 * Usage: node test/layers-figma-cases.mjs
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

// One of each kind Figma draws a glyph for.
const MARKUP = `
<div id="app">
  <div id="toolbar" style="display:flex"><span>Save</span><img alt=""></div>
  <ul style="display:flex;flex-direction:column"><li>One</li></ul>
  <div style="display:grid"><div></div></div>
  <section><p>A very long paragraph that the row has to cut short</p></section>
  <div id=":r1:"></div>
  <svg id="logo" width="10" height="10"></svg>
</div>`

function elementInfo(element) {
  if (element?.id !== "app") return null
  const frame = { componentName: "App", filePath: "src/App.tsx", lineNumber: 1, columnNumber: 1 }
  return { tagName: "div", ...frame, stack: [frame] }
}

function installDom() {
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
  for (const key of [
    "window", "document", "navigator", "Node", "Element", "HTMLElement", "SVGElement",
    "SVGSVGElement", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "Event",
    "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
  ]) {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
  }
  return window
}

async function load(contents) {
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: { contents, resolveDir: PACKAGE_DIR, loader: "ts" },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
}

const window = installDom()
Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true })

const { createContext, installLayersPanel, setState, layersCss, layerName, getResolver } = await load(`
  export { createContext } from "./src/core/context"
  export { installLayersPanel } from "./src/panels/layers"
  export { setState } from "./src/core/store"
  export { layersCss } from "./src/core/css/layers"
  export { layerName, getResolver } from "./src/core/resolve"
`)

const bridge = { elementInfo, toast() {}, store: { addPendingPropertyOperation() {} } }
const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const context = createContext(bridge, { overlay: slot(), toolbar: slot(), left: slot(), right: slot() })
installLayersPanel(context)

const $ = (selector) => window.document.querySelector(selector)
const left = context.slots.left
const rows = () => Array.from(left.querySelectorAll(".de-layer"))
const row = (name) => rows().find((node) => node.querySelector(".de-layer-name").textContent === name)
const names = () => rows().map((node) => node.querySelector(".de-layer-name").textContent)
const press = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
const twisty = (name) => row(name).querySelector(".de-layer-twisty")

// Open the app and every branch under it, through the rows' own chevrons.
context.selectMany([$("#toolbar")])
setState({ selection: [] })
for (const name of ["toolbar", "ul", "div", "section"]) {
  const node = rows().find((r) => r.querySelector(".de-layer-name").textContent === name &&
    r.getAttribute("aria-expanded") === "false")
  if (node) press(node.querySelector(".de-layer-twisty"))
}

console.log("\nGlyphs")

check("each kind gets Figma's glyph", () => {
  const kinds = Object.fromEntries(rows().map((node) => [
    node.querySelector(".de-layer-name").textContent,
    node.querySelector(".de-layer-icon").dataset.kind,
  ]))
  assert.equal(kinds.App, "component")
  assert.equal(kinds.toolbar, "stack-horizontal")
  assert.equal(kinds.ul, "stack-vertical")
  assert.equal(kinds.section, "frame")
  assert.equal(kinds.Save, "text")
  assert.equal(kinds.logo, "vector")
  const grid = rows().find((node) => node.querySelector(".de-layer-icon").dataset.kind === "grid")
  assert.ok(grid, "the display:grid box has no grid glyph")
  const image = rows().find((node) => node.querySelector(".de-layer-icon").dataset.kind === "image")
  assert.ok(image, "the img has no image glyph")
  const empty = rows().filter((node) => node.querySelector(".de-layer-icon").dataset.kind === "rectangle")
  assert.equal(empty.length, 2, "the two empty boxes are rectangles")
})

check("glyphs come from the icon set, at the row size", () => {
  const glyphOf = (name) => row(name).querySelector(".de-layer-icon").dataset.glyph
  assert.equal(glyphOf("App"), "Component")
  assert.equal(glyphOf("toolbar"), "FlowHorizontal")
  assert.equal(glyphOf("ul"), "FlowVertical")
  assert.equal(glyphOf("Save"), "Type")
  assert.equal(row("App").querySelector(".de-layer-icon svg").getAttribute("width"), "16")
})

console.log("\nNames")

check("component, text, id and tag, in that order", () => {
  const shown = names()
  assert.equal(shown[0], "App")
  assert.ok(shown.includes("Save"), "a text leaf is named by its text")
  assert.ok(shown.includes("toolbar"), "an element with an id is named by its id")
  assert.ok(shown.includes("ul"), "an element with nothing else keeps its tag")
  assert.ok(shown.includes("One"))
})

check("a long text name is trimmed and ellipsized", () => {
  const long = names().find((name) => name.startsWith("A very long"))
  assert.ok(long, "the paragraph row is missing")
  assert.ok(long.endsWith("…"))
  assert.ok(long.length <= 28)
})

check("a generated React id is not a name", () => {
  assert.equal(layerName($('[id=":r1:"]'), null), "div")
})

check("the tag stays reachable in the tip and the description", () => {
  const save = row("Save")
  assert.equal(save.querySelector(".de-layer-name").title, "Save · span")
  assert.equal(save.getAttribute("aria-description"), "span")
  const plain = row("ul")
  assert.equal(plain.querySelector(".de-layer-name").title, "ul")
  assert.equal(plain.hasAttribute("aria-description"), false)
})

check("the canvas stack menu reads the same name and tag", () => {
  const meta = getResolver(bridge).meta($("#toolbar"))
  assert.equal(meta.name, "toolbar")
  assert.equal(meta.tag, "div")
})

console.log("\nSelection block")

check("the selected row and its open descendants form one block", () => {
  context.selectMany([$("#toolbar")])
  const order = names()
  const at = order.indexOf("toolbar")
  const [selected, first, last, after] = [at, at + 1, at + 2, at + 3].map((index) => rows()[index])
  assert.equal(selected.getAttribute("aria-selected"), "true")
  assert.ok(!selected.classList.contains("de-layer--in-selection"))
  assert.ok(selected.classList.contains("de-layer--join-down"))
  assert.ok(!selected.classList.contains("de-layer--join-up"))
  assert.ok(first.classList.contains("de-layer--in-selection"))
  assert.ok(first.classList.contains("de-layer--join-up") && first.classList.contains("de-layer--join-down"))
  assert.ok(last.classList.contains("de-layer--in-selection"))
  assert.ok(last.classList.contains("de-layer--join-up") && !last.classList.contains("de-layer--join-down"))
  assert.equal(after.className, "de-layer", "the block ends at the last descendant")
  assert.ok(!rows()[at - 1].className.includes("join"), "the row above the block is untouched")
})

check("the stylesheet draws the block and has no guide lines", () => {
  assert.match(layersCss, /\.de-layer--join-up \{ border-start-start-radius: 0; border-start-end-radius: 0; \}/)
  assert.match(layersCss, /\.de-layer--join-down \{ border-end-start-radius: 0; border-end-end-radius: 0; \}/)
  assert.doesNotMatch(layersCss, /\.de-layer::before/)
})

check("clearing the selection clears the block", () => {
  setState({ selection: [] })
  assert.ok(rows().every((node) => !/in-selection|join/.test(node.className)))
})

console.log("\nRow actions")

check("a locked or hidden row keeps that action up; others reveal on hover or focus", () => {
  const lock = row("Save").querySelector('[data-action="lock"]')
  press(lock)
  assert.ok(row("Save").classList.contains("de-layer--locked"))
  // At rest a locked or hidden row shows its strip with only the pressed
  // button in it: the lock on a locked row, the crossed-out eye on a hidden one.
  assert.match(layersCss, /\.de-layer--locked \.de-layer-actions,/)
  assert.match(layersCss, /\.de-layer--hidden \.de-layer-actions \{ opacity: 1; pointer-events: auto; \}/)
  assert.match(layersCss, /:not\(:hover, :focus-visible, :has\(:focus-visible\), \.de-layer--dragging\)\s*\.de-layer-action:not\(\[aria-pressed="true"\]\) \{ visibility: hidden; \}/)
  assert.equal(row("Save").querySelector('[data-action="lock"]').getAttribute("aria-pressed"), "true")
  assert.match(layersCss, /\.de-layer:is\(:focus-visible, :has\(:focus-visible\)\) \.de-layer-actions/)
  press(row("Save").querySelector('[data-action="lock"]'))
  assert.ok(!row("Save").classList.contains("de-layer--locked"))
})

check("the actions are real buttons, so Tab reaches them", () => {
  const actions = Array.from(row("Save").querySelectorAll(".de-layer-action"))
  assert.equal(actions.length, 3)
  assert.ok(actions.every((button) => button.tagName === "BUTTON" && button.getAttribute("tabindex") !== "-1"))
})

check("an action never selects its row, even with stopPropagation neutered", () => {
  // The shell does exactly this to every chrome click (`restoreChromeFocus`).
  const declaw = (event) => { event.stopPropagation = () => {} }
  window.addEventListener("click", declaw, true)
  try {
    setState({ selection: [] })
    press(row("Save").querySelector('[data-action="lock"]'))
    assert.ok(row("Save").classList.contains("de-layer--locked"))
    assert.equal(row("Save").getAttribute("aria-selected"), "false", "pressing the lock selected the row")
    press(row("Save").querySelector('[data-action="lock"]'))
    const eye = row("Save").querySelector('[data-action="eye"]')
    eye.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    assert.equal(row("Save").getAttribute("aria-selected"), "false", "Enter on an action selected the row")
  } finally {
    window.removeEventListener("click", declaw, true)
  }
})

console.log("\nChevrons")

check("a chevron only on rows with children", () => {
  for (const node of rows()) {
    const hasChevron = Boolean(node.querySelector(".de-layer-twisty svg"))
    assert.equal(hasChevron, node.hasAttribute("aria-expanded"), node.textContent)
  }
  assert.ok(!row("Save").querySelector(".de-layer-twisty svg"))
  assert.ok(row("toolbar").querySelector(".de-layer-twisty svg"))
})

check("glyphs line up per level, chevron or not", () => {
  const pad = (name) => row(name).getAttribute("style")
  assert.equal(pad("toolbar"), pad("logo"), "a sibling with and without children start at one x")
})

console.log("\nHeader")

check("the header is a title with Search and Collapse all", () => {
  const header = left.querySelector(".de-layers-header")
  assert.equal(header.querySelector(".de-section-title").textContent, "Layers")
  const buttons = Array.from(header.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))
  assert.deepEqual(buttons, ["Find layer", "Collapse all layers"])
})

check("Search opens the filter, and Escape twice clears then closes it", () => {
  const toggle = left.querySelector(".de-layers-search")
  const band = left.querySelector(".de-layer-filter-band")
  const field = left.querySelector(".de-layer-filter")
  assert.equal(band.hidden, true)
  press(toggle)
  assert.equal(band.hidden, false)
  assert.equal(toggle.getAttribute("aria-expanded"), "true")
  assert.equal(window.document.activeElement, field)
  field.value = "Save"
  field.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.ok(names().includes("Save") && !names().includes("logo"))
  const escape = () => field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  escape()
  assert.equal(field.value, "")
  assert.ok(names().includes("logo"))
  assert.equal(band.hidden, false)
  escape()
  assert.equal(band.hidden, true)
  assert.equal(toggle.getAttribute("aria-expanded"), "false")
})

check("a search by tag still finds a row named by its id", () => {
  const field = left.querySelector(".de-layer-filter")
  press(left.querySelector(".de-layers-search"))
  field.value = "svg"
  field.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.ok(names().includes("logo"), "the svg tag found the row named logo")
  assert.ok(!names().includes("Save"))
  const escape = () => field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  escape()
  escape()
  assert.equal(left.querySelector(".de-layer-filter-band").hidden, true)
})

check("Collapse all closes every branch, and the button turns into Expand all", () => {
  const fold = left.querySelector(".de-layers-fold")
  press(fold)
  assert.deepEqual(names(), ["App"])
  assert.equal(fold.getAttribute("aria-label"), "Expand all layers")
  press(fold)
  assert.ok(names().includes("Save") && names().includes("One"), "Expand all opened the deep rows")
  assert.equal(fold.getAttribute("aria-label"), "Collapse all layers")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
