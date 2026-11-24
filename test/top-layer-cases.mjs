/**
 * The chrome stays in front of the app's top layer.
 *
 * Phil, 2026-11-23: a modal the app opened covered the toolbar and both
 * panels, and they could not be clicked. The app's `<dialog>` was shown with
 * `showModal()`, which puts it in the browser's top layer, above every z-index,
 * and makes everything outside it inert. `core/top-layer.ts` answers by moving
 * the chrome's roots into a box that is itself in the top layer, shown after
 * the app's element and, while a modal is open, inside that modal.
 *
 * jsdom has no top layer, so this suite gives it one, the way Chrome keeps it:
 * a list of elements in the order they went in, `showModal`/`close` and
 * `showPopover`/`hidePopover` that keep the list and fire `beforetoggle` and
 * `toggle`, `:modal` and `:popover-open` answered from it, and a `moveBefore`
 * that keeps focus and refuses a node that is not in the document. "On top" is
 * the list's last entry still in the document.
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
  `<!doctype html><html><head></head><body>
    <main id="app">
      <dialog id="details"><p>Film</p><button id="play">Play</button><div id="menu" popover>Speed</div></dialog>
      <div id="note" popover>Saved</div>
    </main>
  </body></html>`,
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom
const { document } = window

/* jsdom has no ResizeObserver, pointer capture or layout; the shell uses all three. */
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.Element.prototype.setPointerCapture = function setPointerCapture() {}
window.Element.prototype.releasePointerCapture = function releasePointerCapture() {}
document.elementsFromPoint = () => []

for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLDialogElement",
  "SVGElement",
  "SVGSVGElement",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "MutationObserver",
  "DOMException",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "AbortController",
  "AbortSignal",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
for (const key of ["addEventListener", "removeEventListener"]) {
  Object.defineProperty(globalThis, key, { value: window[key].bind(window), configurable: true, writable: true })
}

// ─────────────────────────────────────────────────────── the top layer ─────

/** Bottom first, as Chrome keeps it. */
const topLayer = []
const modal = new WeakSet()
const shown = new WeakSet()
/** Whether dialogs fire toggle events, as Chrome's do and an older engine's do not. */
let dialogEvents = true

const fire = (node, type, newState) => {
  const event = new window.Event(type)
  event.newState = newState
  node.dispatchEvent(event)
}
const leave = (node) => {
  if (topLayer.includes(node)) topLayer.splice(topLayer.indexOf(node), 1)
}
const enter = (node) => {
  leave(node)
  topLayer.push(node)
}

window.HTMLDialogElement.prototype.showModal = function showModal() {
  if (dialogEvents) fire(this, "beforetoggle", "open")
  this.setAttribute("open", "")
  modal.add(this)
  enter(this)
  if (dialogEvents) setTimeout(() => fire(this, "toggle", "open"))
}
window.HTMLDialogElement.prototype.close = function close() {
  if (!this.hasAttribute("open")) return
  this.removeAttribute("open")
  modal.delete(this)
  leave(this)
  if (dialogEvents) setTimeout(() => fire(this, "toggle", "closed"))
}
window.HTMLElement.prototype.showPopover = function showPopover() {
  fire(this, "beforetoggle", "open")
  shown.add(this)
  enter(this)
  setTimeout(() => fire(this, "toggle", "open"))
}
window.HTMLElement.prototype.hidePopover = function hidePopover() {
  fire(this, "beforetoggle", "closed")
  shown.delete(this)
  leave(this)
  setTimeout(() => fire(this, "toggle", "closed"))
}
const nativeMatches = window.Element.prototype.matches
window.Element.prototype.matches = function matches(selector) {
  if (selector === ":modal") return this.isConnected && modal.has(this)
  if (selector === ":popover-open") return this.isConnected && shown.has(this)
  return nativeMatches.call(this, selector)
}
let moves = 0
function moveBefore(node, child) {
  if (!node.isConnected || !this.isConnected) throw new window.DOMException("not in the document", "HierarchyRequestError")
  const focused = document.activeElement
  moves += 1
  this.insertBefore(node, child)
  if (focused && node.contains(focused) && document.activeElement !== focused) focused.focus()
}
window.Element.prototype.moveBefore = moveBefore

const onTop = () => topLayer.filter((node) => node.isConnected && (modal.has(node) || shown.has(node))).at(-1)

// ─────────────────────────────────────────────────────────── the editor ────

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { mountShell } from "./src/shell/shell"
      export { mountChrome } from "./src/core/top-layer"
      export { el } from "./src/core/dom"
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

const settle = () => new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 0))
const box = () => document.querySelector(".de-top-layer")
const byId = (id) => document.getElementById(id)
/** Chrome roots straight on `<body>`, in order. */
const onBody = () => [...document.body.children].filter((node) => node.hasAttribute("data-designlayer"))

let shell = editor.mountShell()
// Two more roots mounted on <body> at install, as the board and the app
// chooser's menu are, and the editor's own modal sheet.
const chooser = editor.el("div", { class: "de-app-menu" })
const sheet = editor.el("dialog", { class: "de-shortcuts" })
document.body.append(chooser, sheet)

console.log("\nChrome over the app's top layer")

await check("with nothing in the top layer, the chrome stays on <body>", async () => {
  await settle()
  assert.equal(box(), null)
  assert.deepEqual(onBody(), [shell.root, chooser, sheet])
})

for (const events of [false, true]) {
  await check(
    `the app's modal takes the chrome inside it, in a box above it (${events ? "with" : "without"} dialog toggle events)`,
    async () => {
      dialogEvents = events
      moves = 0
      byId("details").showModal()
      await settle()
      const layer = box()
      assert.ok(layer, "no box was made")
      assert.equal(layer.parentElement, byId("details"), "the box is not inside the modal, so the modal makes it inert")
      assert.equal(onTop(), layer, "the box is not above the modal")
      assert.deepEqual([...layer.children], [shell.root, chooser], "the roots did not all move, or not in order")
      assert.equal(sheet.parentElement, document.body, "the editor's own dialog was moved")
      assert.equal(moves, 2, "the roots were not moved with moveBefore")
      byId("details").close()
      await settle()
      assert.equal(box(), null, "the box outlived the modal")
      assert.deepEqual(onBody(), [sheet, shell.root, chooser])
    }
  )
}

await check("a surface mounted while the modal is open lands in the box, and one put on <body> is moved there", async () => {
  byId("details").showModal()
  await settle()
  const tip = editor.el("div", { class: "de-tip" })
  editor.mountChrome(tip)
  assert.equal(tip.parentElement, box(), "mountChrome put the surface outside the box, where the modal makes it inert")
  const stray = editor.el("div", { class: "de-stray" })
  document.body.append(stray)
  await settle()
  assert.equal(stray.parentElement, box())
  tip.remove()
  stray.remove()
  byId("details").close()
  await settle()
})

await check("a popover the app opens over its modal puts a new box on top, with the roots and focus as they were", async () => {
  byId("details").showModal()
  await settle()
  const first = box()
  const escape = shell.root.querySelector(".de-escape")
  escape.focus()
  byId("menu").showPopover()
  await settle()
  const second = box()
  assert.notEqual(second, first, "the box was not built again, so it stays under the popover")
  assert.equal(first.isConnected, false, "the old box was left behind")
  assert.equal(second.parentElement, byId("details"))
  assert.equal(onTop(), second)
  assert.deepEqual([...second.children], [shell.root, chooser])
  assert.equal(document.activeElement, escape, "the move took focus away")
  byId("menu").hidePopover()
  await settle()
  assert.equal(box(), second, "the popover closing moved the box")
  assert.equal(onTop(), second)
  byId("details").close()
  await settle()
  assert.equal(box(), null)
})

await check("a popover with no modal open lifts the box on <body>, and its closing puts the roots back", async () => {
  byId("note").showPopover()
  await settle()
  assert.equal(box()?.parentElement, document.body)
  assert.equal(onTop(), box())
  byId("note").hidePopover()
  await settle()
  assert.equal(box(), null)
  assert.ok(onBody().includes(shell.root) && onBody().includes(chooser))
})

await check("a modal that animates out keeps the chrome above it until its transition ends", async () => {
  const details = byId("details")
  let end
  const transition = {
    effect: { target: details, getComputedTiming: () => ({ endTime: 150 }) },
    playState: "running",
    finished: new Promise((resolve) => (end = resolve)),
  }
  details.getAnimations = () => (transition.playState === "running" ? [transition] : [])
  try {
    details.showModal()
    await settle()
    details.close()
    await settle()
    assert.equal(box()?.parentElement, document.body, "the chrome dropped under the modal while it was still drawn")
    transition.playState = "finished"
    end()
    await settle()
    assert.equal(box(), null, "the box outlived the transition")
    assert.ok(onBody().includes(shell.root))
  } finally {
    delete details.getAnimations
  }
})

await check("the editor's own modal keeps the box under it, and the box goes back on top when it closes", async () => {
  byId("details").showModal()
  await settle()
  const first = box()
  sheet.showModal()
  // The app opens a popover on a timer while the sheet is up.
  byId("menu").showPopover()
  await settle()
  assert.equal(box(), first, "the box was lifted over the editor's own modal")
  assert.ok(topLayer.indexOf(sheet) > topLayer.indexOf(first), "the sheet is not above the box")
  sheet.close()
  await settle()
  assert.notEqual(box(), first, "the box stayed under the app's popover after the sheet closed")
  assert.equal(onTop(), box())
  byId("menu").hidePopover()
  byId("details").close()
  await settle()
  assert.equal(box(), null)
})

await check("the app removing its open modal puts the roots back on <body>", async () => {
  const details = byId("details")
  details.showModal()
  await settle()
  details.remove()
  await settle()
  assert.equal(box(), null)
  assert.ok(shell.root.isConnected, "the editor went with the app's dialog")
  assert.ok(onBody().includes(shell.root) && onBody().includes(chooser))
  modal.delete(details)
  details.removeAttribute("open")
  byId("app").prepend(details)
})

await check("a modal already open when the editor arrives is joined at once, and leaving puts everything back", async () => {
  shell.destroy()
  byId("details").showModal()
  await settle()
  shell = editor.mountShell()
  assert.equal(shell.root.parentElement, box())
  assert.equal(box()?.parentElement, byId("details"))
  shell.destroy()
  assert.equal(box(), null, "destroy left the box behind")
  assert.equal(chooser.parentElement, document.body)
  byId("details").close()
  shell = editor.mountShell()
  await settle()
})

await check("without moveBefore, a moved root keeps its focused control focused", async () => {
  delete window.Element.prototype.moveBefore
  try {
    const escape = shell.root.querySelector(".de-escape")
    escape.focus()
    byId("note").showPopover()
    await settle()
    assert.equal(shell.root.parentElement, box())
    assert.equal(document.activeElement, escape, "the reinsert took focus away")
    byId("note").hidePopover()
    await settle()
    assert.equal(shell.root.parentElement, document.body)
    assert.equal(document.activeElement, escape)
  } finally {
    window.Element.prototype.moveBefore = moveBefore
  }
})

shell.destroy()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
