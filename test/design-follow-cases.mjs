/**
 * The Design tab describes the selection as it is now.
 *
 * It used to describe it as it was at the last selection, commit or refresh,
 * so anything else that changed a box left the numbers behind: the app
 * resizing its own panel in interactive mode (W kept reading 260 for a panel
 * the app had dragged to 340), a width transition still running when a canvas
 * resize was released (W read the tween's first frame and stayed there), a
 * window resize under a `flex-1` column. `follow.ts` watches the selected
 * elements and repaints the tab when a number on it would change.
 *
 * The cases drive the real inspector through the real store. What they pin:
 *
 *  - a write the app makes to the selected element reaches the W field;
 *  - a box that changes size with no write at all reaches it by the poll;
 *  - a change that moves no number rebuilds nothing, and a box that changes
 *    every frame rebuilds at a spacing rather than on every frame;
 *  - the person working in the panel holds the repaint off — typed text not
 *    yet committed, a scrub, an open popup — and it lands once they stop;
 *  - a new selection takes the watch with it.
 *
 * Usage: node test/design-follow-cases.mjs
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
  '<!doctype html><html><body><main id="app">' +
    '<aside id="side" style="width: 260px; height: 120px"><p>Panel</p></aside>' +
    '<section id="card" style="width: 200px; height: 80px"><p>Card</p></section>' +
    "</main></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom

/*
 * jsdom lays nothing out. A box here is its inline width and height, or a size
 * a case sets on `grown` to stand for layout the app changed without writing
 * an attribute — the case the poll exists for.
 */
const grown = new Map()
window.Element.prototype.getBoundingClientRect = function box() {
  const extra = grown.get(this) ?? 0
  const width = (Number.parseFloat(this.style?.width) || 100) + extra
  const height = Number.parseFloat(this.style?.height) || 100
  return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height }
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
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "SVGElement",
  "SVGSVGElement",
  "Event",
  "CustomEvent",
  "FocusEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

const serve = async (input) => {
  const path = new URL(String(input), "http://localhost").pathname
  const payload = path.endsWith("/lint/tools") ? { tools: [] } : { libraries: [] }
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
    addPendingPropertyOperation() {},
    onStateChange() {},
    getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
    viewportToPage: (x, y) => ({ x, y }),
    pageToViewport: (x, y) => ({ x, y }),
  },
}
const right = slot()
const context = editor.createContext(bridge, { overlay: slot(), toolbar: slot(), left: slot(), right })
editor.installInspector(context)

const side = window.document.getElementById("side")
const card = window.document.getElementById("card")
const widthField = () => right.querySelector('#de-tabpanel-design [data-de-field="size.width"]')
const W = () => widthField()?.value

/** The mutation, the frame the check waits for, and the microtask the repaint runs in. */
const frames = async (count = 2) => {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 0)))
  }
}

console.log("\nThe Design tab follows the selection")

await check("a width the app writes on the selected element reaches the W field", async () => {
  context.select(side)
  await frames()
  assert.equal(W(), "260")
  // What the app's own splitter does in interactive mode: React writes the
  // inline width it keeps in state. Nothing tells the editor's store.
  context.setMode("interactive")
  side.style.width = "340px"
  await frames()
  assert.equal(W(), "340", "the tab still describes the panel before the app resized it")
  context.setMode("inspecting")
})

await check("a box that changes size with no write is caught by the poll", async () => {
  context.select(card)
  await frames()
  assert.equal(W(), "200")
  grown.set(card, 40)
  await new Promise((resolve) => setTimeout(resolve, 650))
  await frames()
  assert.equal(W(), "240", "a layout change with no mutation never reached the tab")
  grown.delete(card)
  await new Promise((resolve) => setTimeout(resolve, 650))
  await frames()
  assert.equal(W(), "200")
})

await check("a change that moves no number rebuilds nothing", async () => {
  context.select(side)
  await frames()
  const before = widthField()
  // A write that changes the style attribute but leaves the box where it was
  // still differs, so this is the identical attribute written again.
  side.setAttribute("style", side.getAttribute("style"))
  await frames()
  assert.equal(widthField(), before, "an unchanged box rebuilt the panel")
})

await check("typed text not yet committed holds the repaint, and it lands when focus leaves", async () => {
  context.select(side)
  await frames()
  const input = widthField()
  input.focus()
  input.value = "999"
  side.style.width = "300px"
  await frames()
  assert.equal(widthField(), input, "the panel was rebuilt under a half-typed value")
  assert.equal(input.value, "999", "the typing was thrown away")
  // Escape is how a person leaves a field without committing it.
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await frames()
  assert.equal(W(), "300", "the owed repaint never landed")
})

await check("a scrub holds the repaint until the press ends", async () => {
  context.select(side)
  await frames()
  const field = widthField().closest(".de-field")
  // A press in the panel and the class a scrub wears, without the scrub itself:
  // jsdom has no pointer capture for the label's handler to take.
  field.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }))
  field.classList.add("de-field--scrubbing")
  side.style.width = "320px"
  await frames()
  assert.equal(widthField().closest(".de-field"), field, "the panel was rebuilt under a scrub")
  field.classList.remove("de-field--scrubbing")
  window.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true }))
  await frames()
  assert.equal(W(), "320")
})

await check("an open popup anchored in the panel holds the repaint", async () => {
  context.select(side)
  await frames()
  const trigger = right.querySelector("#de-tabpanel-design button")
  trigger.setAttribute("aria-haspopup", "menu")
  trigger.setAttribute("aria-expanded", "true")
  const before = widthField()
  side.style.width = "310px"
  await frames()
  assert.equal(widthField(), before, "the panel was rebuilt under an open menu")
  trigger.setAttribute("aria-expanded", "false")
  await new Promise((resolve) => setTimeout(resolve, 650))
  await frames()
  assert.equal(W(), "310", "the poll did not pay the repaint once the menu closed")
})

await check("a native menu opened from the panel holds the repaint until a press elsewhere", async () => {
  context.select(side)
  await frames()
  const menu = widthField().closest(".de-field").querySelector("select")
  menu.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }))
  window.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true }))
  menu.focus()
  side.style.width = "330px"
  await frames()
  await new Promise((resolve) => setTimeout(resolve, 80))
  await frames()
  assert.ok(menu.isConnected, "a rebuild took the open menu away")
  // The list closes with a press on the page, which the platform delivers.
  window.document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }))
  window.document.body.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true }))
  await frames()
  assert.equal(W(), "330")
})

await check("a new selection takes the watch with it", async () => {
  context.select(side)
  await frames()
  context.select(card)
  await frames()
  const before = widthField()
  side.style.width = "280px"
  await frames()
  assert.equal(widthField(), before, "a change to the previous selection rebuilt the panel")
  card.style.width = "220px"
  await frames()
  assert.equal(W(), "220")
})

await check("a box changing every frame repaints at a spacing, and its last value lands", async () => {
  context.select(card)
  await frames()
  let rebuilds = 0
  let seen = widthField()
  for (let step = 1; step <= 12; step += 1) {
    card.style.width = `${200 + step * 5}px`
    await frames(1)
    if (widthField() !== seen) {
      rebuilds += 1
      seen = widthField()
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 120))
  await frames()
  assert.equal(W(), "260", "the last change of a run never reached the tab")
  assert.ok(rebuilds < 12, `${rebuilds} rebuilds for 12 frames: the tab rebuilt on every one`)
})

await check("a change while another tab shows is there when Design comes back", async () => {
  context.select(card)
  await frames()
  context.setState({ inspectorTab: "annotations" })
  card.style.width = "260px"
  await frames()
  context.setState({ inspectorTab: "design" })
  await frames()
  assert.equal(W(), "260")
})

await check("a change while the panel is closed is there when it opens", async () => {
  context.select(card)
  await frames()
  context.setState({ inspectorOpen: false })
  card.style.width = "180px"
  await frames()
  context.setState({ inspectorOpen: true })
  await frames()
  assert.equal(W(), "180")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
