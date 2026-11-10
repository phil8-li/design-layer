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
      export { editCount } from "./src/annotations/journal"
      export { tokenField } from "./src/panels/inspector/token-picker"
      export { numberField, textField } from "./src/panels/inspector/field"
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

console.log("\nThe panel is inert while nobody can see it")

/*
 * The editor is hidden or the panel closed: nothing on the tab can be seen, so
 * an app animating the selected box must cost no layout reads. `showing()`
 * answered only "is Design the tab", and the check read every tracked box per
 * frame through both states.
 */
await check("a hidden editor or a closed panel reads no layout of the selection", async () => {
  context.select(side)
  await frames()
  for (const [state, reopen] of [
    [{ chromeHidden: true }, { chromeHidden: false }],
    [{ inspectorOpen: false }, { inspectorOpen: true }],
  ]) {
    context.setState(state)
    await frames()
    let reads = 0
    const box = window.Element.prototype.getBoundingClientRect
    window.Element.prototype.getBoundingClientRect = function counted() {
      if (this === side) reads += 1
      return box.call(this)
    }
    try {
      for (let frame = 0; frame < 10; frame += 1) {
        side.style.width = `${300 + frame}px`
        await frames(1)
      }
    } finally {
      window.Element.prototype.getBoundingClientRect = box
    }
    assert.equal(reads, 0, `${JSON.stringify(state)}: ${reads} layout reads over 10 frames`)
    context.setState(reopen)
    await frames()
    assert.equal(W(), "309", `${JSON.stringify(reopen)}: the change made while away never landed`)
  }
})

console.log("\nA field's gesture always ends")

// jsdom has no pointer capture; stub it the way a browser behaves (a removed
// element loses its capture).
let captured = null
window.Element.prototype.setPointerCapture = function capture() { captured = this }
window.Element.prototype.hasPointerCapture = function has() { return captured === this && this.isConnected }
window.Element.prototype.releasePointerCapture = function release() { captured = null }

/*
 * The census's `scrub-strand` scenario. A rebuild during a label scrub
 * detached the label that listened for the pointerup: the preview stayed on
 * the page, no note was filed, and the preview log's MutationObserver on the
 * whole document was never released.
 */
await check("a rebuild in the middle of a scrub commits it, files its note and lets go", async () => {
  let watching = 0
  const Observer = window.MutationObserver
  class Counted extends Observer {
    observe(target, options) {
      if (target === window.document.documentElement && options?.attributeFilter?.includes("style")) {
        watching += 1
        this.counted = true
      }
      return super.observe(target, options)
    }
    disconnect() {
      if (this.counted) watching -= 1
      this.counted = false
      return super.disconnect()
    }
  }
  globalThis.MutationObserver = window.MutationObserver = Counted
  try {
    side.style.width = "260px"
    context.select(side)
    await frames()
    const label = widthField().closest(".de-field").querySelector(".de-field-label")
    const notes = editor.editCount()
    label.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, clientX: 0, pointerId: 7 }))
    label.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, clientX: 40, pointerId: 7 }))
    await frames()
    assert.equal(side.style.width, "300px", "the scrub drew no preview")
    // Anything that rebuilds the tab mid-gesture: a refresh, option sets, a selection by keyboard.
    context.refresh()
    await frames()
    assert.equal(label.isConnected, false)
    window.document.body.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, clientX: 40, pointerId: 7 }))
    await frames()
    assert.equal(side.style.width, "300px", "the page lost what the scrub showed")
    assert.equal(editor.editCount(), notes + 1, "the scrub left a preview with no note behind it")
    assert.equal(watching, 0, "the preview log still watches the whole document")
    assert.equal(label.classList.contains("de-field-label--scrubbing"), false)
    assert.equal(W(), "300")
  } finally {
    globalThis.MutationObserver = window.MutationObserver = Observer
  }
})

await check("invalid text reverts on Enter and on leaving the field", () => {
  const commits = []
  const field = editor.numberField({ id: "probe", label: "W", value: 120, onCommit: (value) => commits.push(value) })
  right.append(field)
  const input = field.querySelector("input")
  input.focus()
  input.value = "12px +"
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  assert.equal(input.value, "120", "the garbage stayed in the field")
  input.value = "(("
  input.blur()
  assert.equal(input.value, "120")
  input.focus()
  input.value = "(100+40)/2"
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  assert.deepEqual(commits, [70])
  assert.equal(input.value, "70")
  // Escape now goes back to the value just committed, not the one it was built with.
  input.value = "5"
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  assert.equal(input.value, "70")
  field.remove()
})

await check("a text field commits once on Enter, and Escape puts the committed text back", () => {
  const commits = []
  const field = editor.textField({ id: "probe.text", label: "", title: "Font family", value: "Inter", onCommit: (v) => commits.push(v) })
  right.append(field)
  const input = field.querySelector("input")
  input.focus()
  input.value = "Geist"
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  // What a browser fires when Enter's blur leaves a changed value behind.
  input.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.deepEqual(commits, ["Geist"], "Enter and its own blur both committed")
  input.focus()
  input.value = "Comic"
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  assert.equal(input.value, "Geist")
  assert.deepEqual(commits, ["Geist"])
  field.remove()
})

console.log("\nThe token list belongs to the field on screen")

const tokenProbe = (tag, commits) =>
  editor.tokenField({
    id: "probe.token",
    title: "Fill",
    selectedId: "",
    choices: [{ id: "a", group: "G", leaf: "a", name: "G/a", preview: { kind: "none" }, detail: "", disabled: false }],
    fallback: { preview: { kind: "none" }, text: "#fff" },
    onCommit: (id) => commits.push(`${tag}:${id}`),
  })

/* The census's `picker-stale` scenario: the list outlived its field and a row wrote through the old closure. */
await check("a list whose field was replaced writes nothing and closes", async () => {
  const commits = []
  const first = tokenProbe("old", commits)
  right.append(first)
  first.click()
  const row = window.document.querySelector(".de-token-popover .de-token-row")
  assert.ok(row, "the list did not open")
  first.replaceWith(tokenProbe("new", commits))
  row.click()
  assert.deepEqual(commits, [], "a pick reached the field the panel had replaced")
  await Promise.resolve()
  assert.equal(window.document.querySelector(".de-token-popover"), null, "the orphaned list is still open")
  right.querySelector('[data-de-field="probe.token"]')?.remove()
})

await check("a rebuild of the Design tab closes a list opened from it", async () => {
  const commits = []
  context.select(side)
  await frames()
  const field = tokenProbe("design", commits)
  right.querySelector("#de-tabpanel-design > div").append(field)
  field.click()
  assert.ok(window.document.querySelector(".de-token-popover"))
  context.refresh()
  await frames()
  assert.equal(window.document.querySelector(".de-token-popover"), null)
})

await check("a window resize closes the list, as a scroll does", () => {
  const field = tokenProbe("resize", [])
  right.append(field)
  field.click()
  assert.ok(window.document.querySelector(".de-token-popover"))
  window.dispatchEvent(new window.Event("resize"))
  assert.equal(window.document.querySelector(".de-token-popover"), null)
  assert.equal(field.getAttribute("aria-expanded"), "false")
  field.remove()
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
