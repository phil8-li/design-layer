/**
 * Deleting an element: the key, the command, and the note it leaves.
 *
 * Delete is the one edit that takes markup AWAY. On the page it hides and
 * marks the element rather than detaching it (the framework still owns the
 * node), so undo can bring it back between the same two siblings. In source it
 * is a note for the agent, like every other edit: one per element, naming the
 * element well enough to find.
 *
 *   The key      — Delete and Backspace, and nothing wearing a modifier.
 *   The command  — the writer, in jsdom, including undo putting the element
 *                  back between the same two siblings it came from.
 *
 * Usage: node designlayer/test/delete-cases.mjs
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

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

/* -------------------------------------------------------------------------
 * The browser half
 * ---------------------------------------------------------------------- */

const PAGE = `<!doctype html><html><body><main id="app">
<section class="card" id="card">
  <h2 class="card__title">Title</h2>
  <p class="card__body">One</p>
  <p class="card__body">Two</p>
</section>
</main></body></html>`

const dom = new JSDOM(PAGE, { pretendToBeVisual: true, url: "http://localhost/" })
const { window } = dom
Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true })
window.document.elementsFromPoint = () => []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
}
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
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

/** One bundle: the journal and the timeline are module state every lane shares. */
const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createWriter } from "./src/core/writer"
      export { canvasAction } from "./src/core/keymap"
      export * as history from "./src/core/history"
      export { edits, resetJournalForTest } from "./src/annotations/journal"
      export * as store from "./src/core/store"
      export { isLayerCandidate } from "./src/core/resolve"
      export { DELETED_ATTRIBUTE } from "./src/core/dom"
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
const { history, store, isLayerCandidate, DELETED_ATTRIBUTE } = editor

/** The deletions the agent is told to make, one note per element. */
const removals = () => editor.edits().filter((edit) => edit.property === "remove")

/** What every surface means by "gone": not a layer, and not painted. */
const isGone = (element) =>
  !isLayerCandidate(element) &&
  element.hasAttribute(DELETED_ATTRIBUTE) &&
  element.style.getPropertyValue("display") === "none"

const toasts = []
const bridge = {
  elementInfo: () => null,
  send() {},
  toast: (message, kind) => toasts.push({ message, kind }),
  subscribe: () => () => {},
  refreshGeometry() {},
  store: {},
}
const writer = editor.createWriter(bridge)

const document = window.document
const describe = (element) => ({
  element,
  tagName: element.tagName.toLowerCase(),
  componentName: "CardComponent",
  source: { filePath: "src/app/card.tsx", lineNumber: 0, columnNumber: 0, componentName: "Card" },
  key: element.id || element.className,
})

const card = () => document.getElementById("card")
const reset = () => {
  history.resetHistory()
  editor.resetJournalForTest()
  toasts.length = 0
  document.getElementById("app").innerHTML =
    '\n<section class="card" id="card">\n' +
    '  <h2 class="card__title">Title</h2>\n' +
    '  <p class="card__body">One</p>\n' +
    '  <p class="card__body">Two</p>\n' +
    "</section>\n"
}

/* ---------------------------------------------------------------------- */
console.log("\nThe key")

const keyEvent = (init) => new window.KeyboardEvent("keydown", init)

check("Delete and Backspace are both the delete action", () => {
  assert.equal(editor.canvasAction(keyEvent({ key: "Delete" })), "delete")
  assert.equal(editor.canvasAction(keyEvent({ key: "Backspace" })), "delete")
})

check("a modifier takes the key back — that chord belongs to a text field", () => {
  assert.equal(editor.canvasAction(keyEvent({ key: "Backspace", metaKey: true })), null)
  assert.equal(editor.canvasAction(keyEvent({ key: "Delete", altKey: true })), null)
})

check("the keys that were already spoken for still answer as themselves", () => {
  assert.equal(editor.canvasAction(keyEvent({ key: "Escape" })), "deselect")
  assert.equal(editor.canvasAction(keyEvent({ key: "Enter" })), "select-child")
})

/* ---------------------------------------------------------------------- */
console.log("\nThe command")

check("the element goes, and one deletion is a note for the agent", () => {
  reset()
  const title = document.querySelector(".card__title")
  writer.applyDelete([describe(title)])

  assert.ok(isGone(title), "the element is still a visible layer")
  assert.equal(removals().length, 1)
  const [note] = removals()
  assert.equal(note.target.tagName, "h2")
  assert.equal(note.target.className, "card__title")
  assert.equal(note.target.selector, "#card > h2.card__title")
})

check("the descriptor names the element's real place among its siblings", () => {
  reset()
  // The selector is how the agent finds the node, so a sibling index read off
  // the wrong element points it at the wrong line.
  const second = document.querySelectorAll(".card__body")[1]
  writer.applyDelete([describe(second)])
  const [note] = removals()
  assert.equal(note.target.selector, "#card > p.card__body:nth-of-type(2)", "the sibling index was read too late")
})

check("the node itself never moves — the framework still owns it", () => {
  reset()
  const middle = document.querySelectorAll(".card__body")[0]
  const parent = middle.parentElement
  const next = middle.nextSibling
  writer.applyDelete([describe(middle)])

  // Detaching it is what killed the page on a live React host: the fibre kept
  // pointing at a parent that no longer held the node, and the next commit
  // threw `NotFoundError` in `removeChild` and unmounted everything.
  assert.equal(middle.parentElement, parent, "the element was detached")
  assert.equal(middle.nextSibling, next, "the element moved")
  assert.equal(card().children.length, 3, "a child left the DOM")
  assert.ok(isGone(middle))
})

check("undo brings it back as a layer, and takes the note back with it", () => {
  reset()
  const middle = document.querySelectorAll(".card__body")[0]
  writer.applyDelete([describe(middle)])

  history.undo()
  assert.ok(isLayerCandidate(middle), "the element is still not a layer")
  assert.equal(middle.style.getPropertyValue("display"), "", "an inline display was left behind")
  assert.deepEqual(removals(), [], "undo left the deletion in the notes")
})

check("redo takes it away again, and notes it again", () => {
  reset()
  const middle = document.querySelectorAll(".card__body")[0]
  writer.applyDelete([describe(middle)])
  history.undo()
  assert.equal(history.redo(), "Delete p.card__body")
  assert.ok(isGone(middle))
  assert.equal(removals().length, 1)
})

check("an element hidden by the eye comes back hidden, not shown", () => {
  reset()
  const title = document.querySelector(".card__title")
  title.style.setProperty("display", "none")
  writer.applyDelete([describe(title)])
  history.undo()
  // Delete must not quietly undo the other edit standing on this element.
  assert.equal(title.style.getPropertyValue("display"), "none")
  assert.equal(title.style.getPropertyPriority("display"), "")
})

check("deleting a parent and its child is one removal, not two", () => {
  reset()
  const parent = card()
  const child = document.querySelector(".card__title")
  writer.applyDelete([describe(child), describe(parent)])

  assert.ok(isGone(parent))
  assert.equal(removals().length, 1, "the child got a note inside a deletion already noted")
  assert.equal(removals()[0].target.tagName, "section")
})

check("two siblings both go, and both come back", () => {
  reset()
  const [first, second] = document.querySelectorAll(".card__body")
  writer.applyDelete([describe(first), describe(second)])
  assert.ok(isGone(first) && isGone(second))
  assert.equal(removals().length, 2)

  history.undo()
  assert.ok(isLayerCandidate(first) && isLayerCandidate(second))
  assert.deepEqual(removals(), [])
})

check("a multi-element delete is one step, and says nothing", () => {
  reset()
  const [first, second] = document.querySelectorAll(".card__body")
  writer.applyDelete([describe(first), describe(second)])
  // Direct manipulation: the layers leaving the canvas is the report.
  assert.deepEqual(toasts, [], "a canvas delete raised a toast")
  assert.equal(history.canUndo(), true)
  history.undo()
  assert.equal(history.canUndo(), false, "the two deletions recorded two steps")
})

check("deleting nothing is not a step", () => {
  reset()
  writer.applyDelete([])
  assert.equal(history.canUndo(), false)
  assert.deepEqual(removals(), [])
})

check("an element the app has already dropped is not deleted again", () => {
  reset()
  const title = document.querySelector(".card__title")
  const selection = describe(title)
  title.remove()
  // A row in the layers tree can outlive the element it describes by one frame.
  writer.applyDelete([selection])
  assert.equal(history.canUndo(), false)
  assert.deepEqual(removals(), [])
})

check("a locked layer survives Delete, from the tree as well as the canvas", () => {
  reset()
  const title = document.querySelector(".card__title")
  store.setState({ locked: new Set([title]) })
  writer.applyDelete([describe(title)])
  store.setState({ locked: new Set() })

  assert.ok(document.querySelector(".card__title"), "the lock did not hold")
  assert.deepEqual(removals(), [])
  assert.equal(history.canUndo(), false, "a refused delete recorded a step")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
