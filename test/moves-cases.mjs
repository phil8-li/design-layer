/**
 * Move cases: a drag or nudge reaching source through the vendor's move record.
 *
 * `core/moves.ts` is the bridge between the editor's own gesture and the
 * vendor's batch builder, and every failure it guards against was a real one:
 * two engines moving one element (it landed past the pointer), a move undone
 * on screen but still queued (Apply lit up to write nothing), an Apply that
 * left the store full (the button stayed lit and a second click wrote the same
 * change again), and a preview left on top of the class the source now carried
 * (the offset doubled). The store here is a stand-in with the patched vendor's
 * shape, and its batch builder follows the vendor's rule: a move becomes an
 * operation only while its delta is at least a pixel.
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

const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 }
}
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createWriter } from "./src/core/writer"
      export { translationOf, settleAfterApply } from "./src/core/moves"
      export * as history from "./src/core/history"
      export { previewOnlyChanges, clearPreviewOnly } from "./src/core/change-prompt"
      export { edits, clearEdits } from "./src/annotations/journal"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "silent",
})
const editor = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)
const { history, previewOnlyChanges, clearPreviewOnly, edits, clearEdits } = editor

/** The patched vendor's store, reduced to what a move touches. */
function patchedStore() {
  const moves = new Map()
  const calls = { added: 0, forgotten: 0, cleared: 0 }
  return {
    moves,
    calls,
    hasChanges: () => moves.size > 0,
    buildBatchOperations: () =>
      [...moves.values()].flatMap((move) =>
        ["dx", "dy"]
          .filter((axis) => Math.abs(move.delta[axis]) >= 1)
          .map((axis) => ({ op: "moveSpacing", axis: axis === "dx" ? "x" : "y", file: move.identity.filePath }))
      ),
    addPendingPropertyOperation() {},
    addMove(move) {
      calls.added += 1
      moves.set(move.id, move)
    },
    forgetMove(id) {
      calls.forgotten += 1
      moves.delete(id)
    },
    clearCommitted() {
      calls.cleared += 1
      moves.clear()
    },
  }
}

const toasts = []
const bridgeFor = (store) => ({
  elementInfo: () => null,
  send() {},
  toast: (message, kind) => toasts.push({ message, kind }),
  subscribe: () => () => {},
  store,
})

const app = window.document.getElementById("app")
function mount(html) {
  app.insertAdjacentHTML("beforeend", html)
  return app.lastElementChild
}
let keys = 0
const SOURCE = { filePath: "src/Card.tsx", lineNumber: 4, columnNumber: 2, componentName: "Card" }
function selectionFor(element, source = SOURCE) {
  keys += 1
  return { element, tagName: element.tagName.toLowerCase(), componentName: "Card", source, key: `move-${keys}` }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const reset = () => {
  history.resetHistory()
  clearPreviewOnly()
  clearEdits()
  toasts.length = 0
}

console.log("\nReading a transform as a move")

await check("MV-01 an absent, translated or translate-only matrix transform is an offset", () => {
  assert.deepEqual(editor.translationOf(""), { x: 0, y: 0 })
  assert.deepEqual(editor.translationOf("none"), { x: 0, y: 0 })
  assert.deepEqual(editor.translationOf("translate(12px, -4.5px)"), { x: 12, y: -4.5 })
  assert.deepEqual(editor.translationOf("matrix(1, 0, 0, 1, 7, 9)"), { x: 7, y: 9 })
})

await check("MV-02 a transform that also scales or rotates is not a move", () => {
  assert.equal(editor.translationOf("matrix(0.9, 0, 0, 0.9, 7, 9)"), null)
  assert.equal(editor.translationOf("translate(4px, 0px) rotate(10deg)"), null)
})

console.log("\nA move through the store")

await check("MV-03 a drag registers one record, writable and silent", async () => {
  reset()
  const store = patchedStore()
  const writer = editor.createWriter(bridgeFor(store))
  const element = mount('<div class="card">A</div>')
  writer.applyStyles(selectionFor(element), [{ property: "transform", value: "translate(60px, 0px)" }], "Move")
  await settle()
  assert.equal(store.calls.added, 1)
  const [move] = store.moves.values()
  assert.deepEqual(move.delta, { dx: 60, dy: 0 })
  assert.equal(move.identity.filePath, "src/Card.tsx")
  assert.deepEqual(store.buildBatchOperations(), [{ op: "moveSpacing", axis: "x", file: "src/Card.tsx" }])
  assert.equal(element.style.transform, "translate(60px, 0px)", "the preview is the editor's")
  assert.deepEqual(toasts, [], "a writable move announced itself as preview only")
  assert.deepEqual(previewOnlyChanges(), [])
  assert.equal(edits()[0].written, true, "the Changes row does not say Apply will write it")
})

await check("MV-04 a nudge after the drag re-aims the same record", async () => {
  reset()
  const store = patchedStore()
  const writer = editor.createWriter(bridgeFor(store))
  const element = mount('<div class="card">B</div>')
  const selection = selectionFor(element)
  writer.applyStyles(selection, [{ property: "transform", value: "translate(60px, 0px)" }], "Move")
  await settle()
  writer.applyStyles(selection, [{ property: "transform", value: "translate(61px, 0px)" }], "Nudge")
  await settle()
  assert.equal(store.calls.added, 1, "a second record for one element")
  assert.deepEqual([...store.moves.values()][0].delta, { dx: 61, dy: 0 })
})

await check("MV-05 undoing back to the start takes the record out of the store", async () => {
  reset()
  const store = patchedStore()
  const writer = editor.createWriter(bridgeFor(store))
  const element = mount('<div class="card">C</div>')
  writer.applyStyles(selectionFor(element), [{ property: "transform", value: "translate(30px, 10px)" }], "Move")
  await settle()
  history.undo()
  await settle()
  assert.equal(store.calls.forgotten, 1)
  assert.equal(store.hasChanges(), false, "Apply would light up to write nothing")
  history.redo()
  await settle()
  assert.deepEqual([...store.moves.values()][0]?.delta, { dx: 30, dy: 10 }, "redo did not put the move back")
})

await check("MV-06 a move whose source never resolves is stranded, not queued", async () => {
  reset()
  const store = patchedStore()
  const writer = editor.createWriter({ ...bridgeFor(store), elementSourceAsync: async () => null })
  const element = mount('<div class="card">D</div>')
  writer.applyStyles(selectionFor(element, null), [{ property: "transform", value: "translate(5px, 5px)" }], "Move")
  await settle()
  await settle()
  assert.equal(store.calls.added, 0)
  assert.equal(previewOnlyChanges().length, 1, "the move vanished instead of reaching the ledger")
})

await check("MV-07 an unpatched store keeps the preview-only path", async () => {
  reset()
  const { forgetMove: _forget, clearCommitted: _clear, ...store } = patchedStore()
  const writer = editor.createWriter(bridgeFor(store))
  const element = mount('<div class="card">E</div>')
  writer.applyStyles(selectionFor(element), [{ property: "transform", value: "translate(8px, 0px)" }], "Move")
  await settle()
  assert.deepEqual(toasts, [{ message: "Move: preview only (transform)", kind: "error" }])
})

await check("MV-08 a rotated element's move stays preview only", async () => {
  reset()
  const store = patchedStore()
  const writer = editor.createWriter(bridgeFor(store))
  const element = mount('<div class="card">F</div>')
  writer.applyStyles(
    selectionFor(element),
    [{ property: "transform", value: "matrix(0.98, 0.17, -0.17, 0.98, 12, 0)" }],
    "Move"
  )
  await settle()
  assert.equal(store.calls.added, 0)
  assert.equal(toasts.length, 1)
})

console.log("\nAfter an Apply")

await check("MV-09 the store is emptied and the preview leaves when the new classes land", async () => {
  reset()
  const store = patchedStore()
  const bridge = bridgeFor(store)
  const writer = editor.createWriter(bridge)
  const element = mount('<div class="card">G</div>')
  writer.applyStyles(selectionFor(element), [{ property: "transform", value: "translate(48px, 0px)" }], "Move")
  await settle()
  editor.settleAfterApply(bridge)
  assert.equal(store.calls.cleared, 1)
  assert.equal(store.hasChanges(), false, "a second Apply would write the move again")
  assert.equal(element.style.transform, "translate(48px, 0px)", "the preview left before the source carried it")
  element.classList.add("translate-x-12")
  await settle()
  assert.equal(element.style.transform, "", "the preview stayed on top of the class and doubled the offset")
})

await check("MV-10 an element that had an inline transform gets it back, not nothing", async () => {
  reset()
  const store = patchedStore()
  const bridge = bridgeFor(store)
  const writer = editor.createWriter(bridge)
  const element = mount('<div class="card" style="transform: translate(4px, 0px)">H</div>')
  writer.applyStyles(selectionFor(element), [{ property: "transform", value: "translate(24px, 0px)" }], "Move")
  await settle()
  assert.deepEqual([...store.moves.values()][0].delta, { dx: 20, dy: 0 }, "the delta counted the starting offset")
  editor.settleAfterApply(bridge)
  element.classList.add("translate-x-5")
  await settle()
  assert.equal(element.style.transform, "translate(4px, 0px)")
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
