/**
 * The Design tab's layer header, Figma's first row.
 *
 * Pins what a refactor could quietly change:
 *
 *  - the type name per kind of element: Text, Image, Vector, Frame, Rectangle,
 *    a component instance's name (drawn in the component color), and
 *    "N selected" for a multi-selection;
 *  - Copy as code puts the element's code on the clipboard and toasts;
 *  - Create component files a note in the Changes outbox, and an instance
 *    offers its main component's path instead;
 *  - More actions is a keyboard menu whose rows run the editor's commands, and
 *    Escape closes it with focus back on the trigger;
 *  - the header is the first thing in the Design tab and does not fold.
 *
 * Usage: node test/layer-header-cases.mjs
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

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
})
const { window } = dom
for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement",
  "SVGElement", "SVGSVGElement", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent",
  "PointerEvent", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const clipboard = []
Object.defineProperty(window.navigator, "clipboard", {
  value: { writeText: async (text) => void clipboard.push(text) },
  configurable: true,
})

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { layerHeaderSection, layerKind } from "./src/panels/inspector/section-layer-header"
      export { registerCommand } from "./src/core/commands"
      export { annotations, clearAnnotations } from "./src/annotations/store"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const lib = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

/* ---------- fixture ---------- */

const SVG_NS = "http://www.w3.org/2000/svg"

/**
 * Mounts `html` (its first element is the selection) and builds a section
 * context. `info` maps a selector to the engine's element info, so a case can
 * make the selection a component root the way the layers panel decides it.
 */
function scene(html, { info = {}, extra = 0 } = {}) {
  window.document.body.innerHTML = `<main id="app">${html}</main>`
  const element = window.document.querySelector("#app").firstElementChild
  const infoFor = new Map(
    Object.entries(info).map(([selector, value]) => [window.document.querySelector(selector), value])
  )
  const selection = {
    element,
    tagName: element.tagName.toLowerCase(),
    componentName: "Fixture",
    source: { filePath: "src/Chip.tsx", lineNumber: 12, columnNumber: 4 },
    key: `k-${Math.random()}`,
  }
  const others = Array.from({ length: extra }, (_, i) => ({ ...selection, key: `other-${i}` }))
  const toasts = []
  const writes = []
  const state = { selection: [selection, ...others], locked: new Set() }
  const editor = {
    bridge: { elementInfo: (node) => infoFor.get(node) ?? null },
    getState: () => state,
    setState: (patch) => writes.push(patch),
    toast: (message, kind = "info") => toasts.push({ message, kind }),
  }
  const context = {
    editor,
    writer: {},
    selection,
    selections: state.selection,
    computed: getComputedStyle(element),
    invalidate() {},
  }
  return { element, selection, context, toasts, writes }
}

const header = (context) => {
  const node = lib.layerHeaderSection(context)
  window.document.body.append(node)
  return node
}
const label = (node) => node.querySelector(".de-layerhead-name").textContent
const button = (node, name) => node.querySelector(`button[aria-label="${name}"]`)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const key = (target, name) =>
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))

const frame = (name, line) => ({ componentName: name, filePath: "src/Chip.tsx", lineNumber: line, columnNumber: 4 })

/* ---------- type names ---------- */

await check("a leaf with direct text is Text", () => {
  assert.equal(label(header(scene("<p>Plans scale with your team.</p>").context)), "Text")
})

await check("text with element children is a Frame, not Text", () => {
  assert.equal(label(header(scene("<p>Hello <b>there</b></p>").context)), "Frame")
})

await check("img, picture, video and canvas are Image", () => {
  for (const tag of ["img", "picture", "video", "canvas"]) {
    const html = tag === "img" ? "<img alt=''>" : `<${tag}></${tag}>`
    assert.equal(label(header(scene(html).context)), "Image", tag)
  }
})

await check("an svg is Vector", () => {
  const { context, element } = scene("<div></div>")
  const svg = window.document.createElementNS(SVG_NS, "svg")
  element.replaceWith(svg)
  context.selection.element = svg
  assert.equal(label(header(context)), "Vector")
})

await check("a box with element children is a Frame", () => {
  assert.equal(label(header(scene("<section><div></div><div></div></section>").context)), "Frame")
})

await check("an empty box is a Rectangle", () => {
  assert.equal(label(header(scene("<div></div>").context)), "Rectangle")
})

await check("a component root shows its component name in the component color", () => {
  const { context } = scene("<div><span>Chip</span></div>", {
    info: {
      "#app": { tagName: "main", ...frame("App", 3), stack: [frame("App", 3)] },
      "#app > div": { tagName: "div", ...frame("Chip", 12), stack: [frame("Chip", 12), frame("App", 3)] },
    },
  })
  const node = header(context)
  assert.equal(label(node), "Chip")
  assert.ok(node.classList.contains("de-layerhead--component"))
  assert.ok(node.querySelector(".de-layerhead-title svg"), "the component glyph leads the name")
})

await check("a multi-selection reads N selected and keeps only the menu", () => {
  const node = header(scene("<div></div>", { extra: 2 }).context)
  assert.equal(label(node), "3 selected")
  assert.equal(button(node, "Copy as code"), null)
  assert.equal(button(node, "Create component"), null)
  assert.ok(button(node, "More actions"))
})

await check("the header has no fold and is not a section header", () => {
  const node = header(scene("<div></div>").context)
  assert.equal(node.querySelector(".de-section-toggle, .de-chevron"), null)
  assert.equal(node.classList.contains("de-section"), false)
})

/* ---------- actions ---------- */

await check("Copy as code copies the element's code and toasts", async () => {
  clipboard.length = 0
  const { context, toasts } = scene('<button class="px-4">Start</button>')
  button(header(context), "Copy as code").click()
  await flush()
  assert.equal(clipboard.length, 1)
  assert.match(clipboard[0], /<button/)
  assert.match(clipboard[0], /Start/)
  assert.deepEqual(toasts, [{ message: "Copied JSX", kind: "info" }])
})

await check("Create component files a note in the Changes outbox", () => {
  lib.clearAnnotations()
  const { context, toasts, element } = scene("<section><h2>Pro</h2></section>")
  button(header(context), "Create component").click()
  const notes = lib.annotations()
  assert.equal(notes.length, 1)
  assert.equal(notes[0].kind, "element")
  assert.match(notes[0].comment, /^Create a reusable component from this <section>/)
  assert.equal(notes[0].target.tagName, "section")
  assert.equal(notes[0].element, element)
  assert.match(toasts[0].message, /Changes/)
})

await check("an instance offers its main component's path instead of Create component", async () => {
  clipboard.length = 0
  const { context, toasts } = scene("<div></div>", {
    info: {
      "#app": { tagName: "main", ...frame("App", 3), stack: [frame("App", 3)] },
      "#app > div": { tagName: "div", ...frame("Chip", 12), stack: [frame("Chip", 12), frame("App", 3)] },
    },
  })
  const node = header(context)
  assert.equal(button(node, "Create component"), null)
  button(node, "Copy path to main component").click()
  await flush()
  assert.deepEqual(clipboard, ["src/Chip.tsx:12"])
  assert.equal(toasts[0].message, "Copied path to Chip")
})

/* ---------- More actions ---------- */

const ran = []
for (const id of ["select.parent", "select.reveal", "select.hide", "select.lock"]) {
  lib.registerCommand(id, () => ran.push(id))
}
const menuOf = () => window.document.querySelector('.de-layerhead-menu[role="menu"]')
const rowNamed = (name) =>
  [...menuOf().querySelectorAll('[role="menuitem"]')].find(
    (row) => row.querySelector(".de-layerhead-menu-label").textContent === name
  )

await check("More actions lists the layer commands with their shortcuts", () => {
  const node = header(scene('<div class="card"></div>').context)
  const trigger = button(node, "More actions")
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu")
  trigger.click()
  assert.equal(trigger.getAttribute("aria-expanded"), "true")
  const names = [...menuOf().querySelectorAll(".de-layerhead-menu-label")].map((row) => row.textContent)
  assert.deepEqual(names, ["Select parent", "Show in layers", "Scroll into view", "Hide", "Lock", "Copy classes"])
  assert.ok(rowNamed("Select parent").querySelector(".de-layerhead-menu-key").textContent)
})

await check("menu rows run their commands and close the menu", () => {
  ran.length = 0
  for (const name of ["Select parent", "Scroll into view", "Hide", "Lock"]) {
    const node = header(scene("<div></div>").context)
    button(node, "More actions").click()
    rowNamed(name).click()
    assert.equal(menuOf(), null, `${name} closes the menu`)
  }
  assert.deepEqual(ran, ["select.parent", "select.reveal", "select.hide", "select.lock"])
})

await check("Show in layers opens the Layers tab", () => {
  const { context, writes } = scene("<div></div>")
  button(header(context), "More actions").click()
  rowNamed("Show in layers").click()
  assert.deepEqual(writes, [{ layersOpen: true, leftTab: "layers" }])
})

await check("Hide and Lock name the state the element is in", () => {
  const { context, element } = scene("<div></div>")
  context.editor.getState().locked = new Set([element])
  element.style.display = "none"
  button(header(context), "More actions").click()
  assert.ok(rowNamed("Show"))
  assert.ok(rowNamed("Unlock"))
})

await check("Copy classes copies the class attribute, and is disabled without one", async () => {
  clipboard.length = 0
  const { context } = scene('<div class="flex gap-2"></div>')
  button(header(context), "More actions").click()
  rowNamed("Copy classes").click()
  await flush()
  assert.deepEqual(clipboard, ["flex gap-2"])

  const bare = scene("<div></div>")
  button(header(bare.context), "More actions").click()
  assert.equal(rowNamed("Copy classes").getAttribute("aria-disabled"), "true")
})

await check("arrows move through the rows, Escape closes and focus returns to the trigger", () => {
  ran.length = 0
  const node = header(scene("<div></div>").context)
  const trigger = button(node, "More actions")
  trigger.focus()
  key(trigger, "ArrowDown")
  assert.equal(window.document.activeElement, rowNamed("Select parent"), "ArrowDown opens on the first row")
  key(window.document.activeElement, "ArrowDown")
  assert.equal(window.document.activeElement, rowNamed("Show in layers"))
  key(window.document.activeElement, "ArrowUp")
  key(window.document.activeElement, "ArrowUp")
  // No class attribute, so Copy classes is disabled and the wrap skips it.
  assert.equal(window.document.activeElement, rowNamed("Lock"), "ArrowUp wraps past the disabled last row")
  const escape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  window.document.activeElement.dispatchEvent(escape)
  assert.equal(escape.defaultPrevented, true, "Escape is spent, so the canvas does not also deselect")
  assert.equal(menuOf(), null)
  assert.equal(window.document.activeElement, trigger)
  assert.equal(trigger.getAttribute("aria-expanded"), "false")
})

await check("a pointer press outside closes the menu", () => {
  const node = header(scene("<div></div>").context)
  button(node, "More actions").click()
  window.document.body.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }))
  assert.equal(menuOf(), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
