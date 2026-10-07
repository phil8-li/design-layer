/**
 * Undo/redo contract: the timeline, what records into it, and the two keys.
 *
 * The timeline is asserted at the WRITER rather than per section, because that
 * is where it is owned: a section that writes through `applyStyles` gets undo
 * whether or not anyone remembers it exists, and a section that grows its own
 * write path would fail these without a new case being added. The engine we
 * vendor also has an undo stack, and these cases exist partly to say why it is
 * not the one in use — it is pop-only and nothing here ever pushed to it.
 *
 * Usage: node designlayer/test/history-cases.mjs
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

const dom = new JSDOM(
  '<!doctype html><html><body><main id="app"><button id="cta" class="rounded">Go</button></main></body></html>',
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom
// The product runs on a Mac, so the Mac pair is the one worth asserting;
// jsdom otherwise reports a platform with no Cmd key and every ⌘Z reads as a
// bare Z. One case below flips this to check the other branch.
const platform = (value) =>
  Object.defineProperty(window.navigator, "platform", { value, configurable: true })
platform("MacIntel")
window.document.elementsFromPoint = () => []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
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
  "SVGElement",
  "SVGSVGElement",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

/** One bundle: the timeline is module state that every lane has to share. */
const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createContext } from "./src/core/context"
      export { createWriter } from "./src/core/writer"
      export { installToolbar } from "./src/shell/toolbar"
      export { installShortcuts } from "./src/shell/shortcuts"
      export * as history from "./src/core/history"
      export { historyAction } from "./src/core/keymap"
      export * as noteActions from "./src/annotations/actions"
      export * as noteStore from "./src/annotations/store"
      export { edits as journalEdits, resetJournalForTest } from "./src/annotations/journal"
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
const { history } = editor

const queued = []
const sent = []
const bridge = {
  elementInfo: () => null,
  send: (message) => sent.push(message),
  toast() {},
  subscribe: () => () => {},
  store: {
    setActiveTool() {},
    hasChanges: () => false,
    buildBatchOperations: () => [],
    onStateChange() {},
    getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
    viewportToPage: (x, y) => ({ x, y }),
    pageToViewport: (x, y) => ({ x, y }),
    addPendingPropertyOperation: (mergeKey, operation, keys) =>
      queued.push({ mergeKey, operation, keys }),
  },
}

const writer = editor.createWriter(bridge)
const target = window.document.getElementById("cta")
const selection = {
  element: target,
  tagName: "button",
  componentName: "Cta",
  source: { filePath: "src/app/page.tsx", lineNumber: 4, columnNumber: 2, componentName: "Cta" },
  key: "cta",
}

const reset = () => {
  history.resetHistory()
  queued.length = 0
  sent.length = 0
  target.setAttribute("style", "")
  target.setAttribute("class", "rounded")
  target.textContent = "Go"
}

// ── The timeline ───────────────────────────────────────────────────────────

console.log("\nThe timeline")

check("a style write is undoable and then redoable", () => {
  reset()
  target.style.setProperty("background-color", "rgb(255, 0, 0)")
  writer.applyStyles(selection, [{ property: "background-color", value: "rgb(0, 0, 255)" }], "Set fill")

  assert.equal(history.canUndo(), true, "the write did not record a step")
  assert.equal(history.canRedo(), false, "nothing has been undone yet")

  assert.equal(history.undo(), "Set fill")
  assert.equal(target.style.getPropertyValue("background-color"), "rgb(255, 0, 0)")

  assert.equal(history.canRedo(), true)
  assert.equal(history.redo(), "Set fill")
  assert.equal(target.style.getPropertyValue("background-color"), "rgb(0, 0, 255)")
})

check("undoing does not record an undo of its own", () => {
  reset()
  writer.applyStyles(selection, [{ property: "opacity", value: "0.5" }], "Set opacity")
  history.undo()
  // Two stacked writes would leave `past` non-empty here and Cmd+Z would
  // oscillate between the two values forever instead of walking back.
  assert.equal(history.canUndo(), false)
  assert.equal(history.undo(), null)
})

check("a fresh edit after an undo drops the redo branch", () => {
  reset()
  writer.applyStyles(selection, [{ property: "opacity", value: "0.5" }], "Set opacity")
  history.undo()
  assert.equal(history.canRedo(), true)
  writer.applyStyles(selection, [{ property: "opacity", value: "0.25" }], "Set opacity again")
  assert.equal(history.canRedo(), false, "the abandoned branch is still redoable")
})

check("undo restores a value the source writer can still express", () => {
  reset()
  // Nothing is set inline, so the honest "before" is the empty string — which
  // reverts the preview and leaves the pending source operation holding the
  // change the user just took back. The computed value avoids that split.
  writer.applyStyles(selection, [{ property: "opacity", value: "0.5" }], "Set opacity")
  queued.length = 0
  history.undo()
  assert.notEqual(target.style.getPropertyValue("opacity"), "0.5")
  assert.equal(queued.length, 1, "the undo queued nothing for source")
  assert.equal(queued[0].keys[0], "opacity")
  assert.ok(
    !/0\.5/.test(JSON.stringify(queued[0].operation)),
    "source still holds the undone value"
  )
})

check("a class write undoes by swapping its two lists", () => {
  reset()
  writer.applyClasses(selection, { remove: ["rounded"], add: ["rounded-full"] }, "Set radius")
  assert.equal(target.className, "rounded-full")
  history.undo()
  assert.equal(target.className, "rounded")
  history.redo()
  assert.equal(target.className, "rounded-full")
})

check("a text edit undoes to the original string, and tells source both times", () => {
  reset()
  writer.applyText(selection, "Continue")
  assert.equal(target.textContent, "Continue")
  history.undo()
  assert.equal(target.textContent, "Go")
  assert.equal(sent.length, 2, "the revert never reached the source writer")
  assert.equal(sent[1].newText, "Go")
  assert.equal(sent[1].originalText, "Continue")
})

check("one edit is one step, however many times the field commits it", () => {
  reset()
  target.style.setProperty("opacity", "1")
  // A numeric field commits on Enter AND on `change`, so the same value lands
  // here twice. Recording the second made the first Cmd+Z a no-op: measured
  // live as opacity staying at 0.4 through one undo and only reverting on the
  // second. The guard belongs here rather than in the field, because every
  // control that commits on two events would need it otherwise.
  writer.applyStyles(selection, [{ property: "opacity", value: "0.4" }], "Set opacity")
  writer.applyStyles(selection, [{ property: "opacity", value: "0.4" }], "Set opacity")

  assert.equal(history.undo(), "Set opacity")
  assert.equal(target.style.getPropertyValue("opacity"), "1", "the first undo did nothing")
  assert.equal(history.canUndo(), false, "the duplicate commit left a second step behind")
})

check("re-picking the class already applied is not a step", () => {
  reset()
  writer.applyClasses(selection, { remove: ["rounded"], add: ["rounded-full"] }, "Set radius")
  writer.applyClasses(selection, { remove: [], add: ["rounded-full"] }, "Set radius")
  history.undo()
  assert.equal(target.className, "rounded")
  assert.equal(history.canUndo(), false)
})

check("re-committing the same text neither records nor tells source", () => {
  reset()
  writer.applyText(selection, "Continue")
  sent.length = 0
  writer.applyText(selection, "Continue")
  assert.equal(sent.length, 0, "an unchanged commit still queued a source rewrite")
  history.undo()
  assert.equal(target.textContent, "Go")
  assert.equal(history.canUndo(), false)
})

// ── The two keys ───────────────────────────────────────────────────────────

console.log("\nThe shortcuts")

const key = (init) => new window.KeyboardEvent("keydown", { key: "z", bubbles: true, ...init })

check("Cmd+Z undoes and Shift+Cmd+Z redoes", () => {
  assert.equal(editor.historyAction(key({ metaKey: true })), "undo")
  assert.equal(editor.historyAction(key({ metaKey: true, shiftKey: true })), "redo")
})

check("redo is a different combination from undo", () => {
  // The whole of the user's "a different shortcut to redo": the two must not
  // resolve to the same press, which a bare `key === "z"` reading would.
  const undoPress = { metaKey: true }
  const redoPress = { metaKey: true, shiftKey: true }
  assert.notDeepEqual(undoPress, redoPress)
  assert.notEqual(editor.historyAction(key(undoPress)), editor.historyAction(key(redoPress)))
})

check("off the Mac the accelerator is Ctrl, and Cmd stops counting", () => {
  platform("Win32")
  try {
    assert.equal(editor.historyAction(key({ ctrlKey: true })), "undo")
    assert.equal(editor.historyAction(key({ ctrlKey: true, shiftKey: true })), "redo")
    assert.equal(editor.historyAction(key({ metaKey: true })), null)
  } finally {
    platform("MacIntel")
  }
})

check("a bare Z, an Alt press and Ctrl+Cmd+Z are all left alone", () => {
  assert.equal(editor.historyAction(key({})), null)
  assert.equal(editor.historyAction(key({ metaKey: true, altKey: true })), null)
  assert.equal(editor.historyAction(key({ metaKey: true, ctrlKey: true })), null)
  assert.equal(
    editor.historyAction(new window.KeyboardEvent("keydown", { key: "y", ctrlKey: true })),
    null,
    "Ctrl+Y belongs to the browser, not to us"
  )
})

// ── The toolbar drives the same owner ──────────────────────────────────────

console.log("\nThe toolbar")

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const toolbarSlot = slot()
const context = editor.createContext(bridge, {
  overlay: slot(),
  toolbar: toolbarSlot,
  left: slot(),
  right: slot(),
})
editor.installToolbar(context)
/*
 * The keyboard is a separate lane now, and these cases need it mounted.
 *
 * The bar used to carry its own ⌘Z listener; it registers a `history.undo`
 * command instead, and `shell/shortcuts.ts` is the one module in the editor
 * that listens for a key (see `core/keymap.ts` for why there is only one). The
 * behaviour under test has not moved — `travel` is still the bar's, and still
 * the same call the buttons make — but the composition has, so these cases
 * build the pair the product builds rather than half of it.
 */
editor.installShortcuts(context)
const byLabel = (name) => toolbarSlot.querySelector(`[aria-label="${name}"]`)

check("both buttons exist, icon-only, with the shortcut in the hover text", () => {
  assert.ok(byLabel("Undo"))
  assert.ok(byLabel("Redo"))
  assert.equal(byLabel("Undo").textContent.trim(), "")
  assert.match(byLabel("Undo").getAttribute("data-de-tip"), /Z$/)
  assert.match(byLabel("Redo").getAttribute("data-de-tip"), /Z$/)
  assert.notEqual(
    byLabel("Undo").getAttribute("data-de-tip"),
    byLabel("Redo").getAttribute("data-de-tip")
  )
})

check("both are disabled until there is something to travel to", () => {
  reset()
  assert.equal(byLabel("Undo").hasAttribute("disabled"), true)
  assert.equal(byLabel("Redo").hasAttribute("disabled"), true)
  writer.applyStyles(selection, [{ property: "opacity", value: "0.5" }], "Set opacity")
  assert.equal(byLabel("Undo").hasAttribute("disabled"), false, "a write must light Undo up")
  assert.equal(byLabel("Redo").hasAttribute("disabled"), true)
  byLabel("Undo").click()
  assert.equal(byLabel("Redo").hasAttribute("disabled"), false)
})

check("Cmd+Z on the page runs the same travel the button runs", () => {
  reset()
  target.style.setProperty("opacity", "1")
  writer.applyStyles(selection, [{ property: "opacity", value: "0.5" }], "Set opacity")
  window.dispatchEvent(key({ metaKey: true }))
  assert.equal(target.style.getPropertyValue("opacity"), "1")
  window.dispatchEvent(key({ metaKey: true, shiftKey: true }))
  assert.equal(target.style.getPropertyValue("opacity"), "0.5")
})

check("a field keeps its own Cmd+Z", () => {
  reset()
  writer.applyStyles(selection, [{ property: "opacity", value: "0.5" }], "Set opacity")
  const field = window.document.createElement("input")
  window.document.body.append(field)
  field.dispatchEvent(key({ metaKey: true }))
  field.remove()
  // Untouched: undoing the designer's typing is the field's job, and taking
  // the key would revert a style edit instead of the word just typed.
  assert.equal(history.canUndo(), true)
  assert.equal(target.style.getPropertyValue("opacity"), "0.5")
})

// ── Notes share the timeline ───────────────────────────────────────────────

console.log("\nNotes share the timeline")

const { noteActions, noteStore } = editor
const noteInput = (comment) => ({
  kind: "region",
  comment,
  url: window.location.href,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  target: null,
  selectedText: null,
})
const resetNotes = () => {
  reset()
  // The store rehydrates from storage on its next read, so both go.
  window.localStorage.clear()
  editor.resetJournalForTest()
  noteStore.resetAnnotationsForTest()
}
const comments = () => noteStore.annotations().map((note) => note.comment)

check("pinning a note is one Cmd+Z, and redo brings back the same note", () => {
  resetNotes()
  const note = noteActions.pinNote(noteInput("too tight"))
  assert.equal(history.undo(), "Pin note")
  assert.deepEqual(comments(), [])
  history.redo()
  assert.equal(noteStore.annotations()[0].id, note.id)
})

check("an edit and a note undo in the order they happened", () => {
  resetNotes()
  target.style.setProperty("opacity", "1")
  writer.applyStyles(selection, [{ property: "opacity", value: "0.5" }], "Set opacity")
  noteActions.pinNote(noteInput("still wrong"))
  history.undo()
  assert.deepEqual(comments(), [], "the newest step is the note")
  assert.equal(target.style.getPropertyValue("opacity"), "0.5", "the edit is still standing")
  history.undo()
  assert.equal(target.style.getPropertyValue("opacity"), "1")
  assert.equal(editor.journalEdits().length, 0, "the undone edit left the outbox too")
})

check("rewriting a note undoes to the old words, and a no-op rewrite is not a step", () => {
  resetNotes()
  const note = noteActions.pinNote(noteInput("first"))
  noteActions.rewriteNote(note.id, "first")
  noteActions.rewriteNote(note.id, "second")
  assert.equal(history.undo(), "Edit note")
  assert.deepEqual(comments(), ["first"])
  assert.equal(history.undo(), "Pin note")
})

check("deleting a note restores it in place, from Cmd+Z or from the toast", () => {
  resetNotes()
  noteActions.pinNote(noteInput("a"))
  const middle = noteActions.pinNote(noteInput("b"))
  noteActions.pinNote(noteInput("c"))
  const removed = noteActions.deleteNote(middle.id)
  assert.deepEqual(comments(), ["a", "c"])
  history.undo()
  assert.deepEqual(comments(), ["a", "b", "c"])
  history.redo()
  noteActions.undoNoteStep(removed.step)
  assert.deepEqual(comments(), ["a", "b", "c"], "the toast's Undo is the same act")
  assert.equal(history.canRedo(), true, "and it went through the timeline, so redo is offered")
})

check("clearing every note is one step", () => {
  resetNotes()
  noteActions.pinNote(noteInput("a"))
  noteActions.pinNote(noteInput("b"))
  assert.equal(noteActions.clearNotes(), 2)
  assert.deepEqual(comments(), [])
  history.undo()
  assert.deepEqual(comments(), ["a", "b"])
})

check("a step whose note was cleared by a handover undoes to nothing, not an error", () => {
  resetNotes()
  noteActions.pinNote(noteInput("a"))
  noteStore.clearAnnotations()
  assert.equal(history.undo(), "Pin note")
  history.redo()
  assert.deepEqual(comments(), ["a"])
})

check("the timeline keeps the newest HISTORY_LIMIT steps and drops the oldest", () => {
  history.resetHistory()
  const undone = []
  const total = history.HISTORY_LIMIT + 5
  for (let index = 0; index < total; index += 1) {
    history.record({ label: `step ${index}`, undo: () => undone.push(index), redo() {} })
  }
  while (history.canUndo()) history.undo()
  assert.equal(undone.length, history.HISTORY_LIMIT)
  assert.equal(undone[0], total - 1, "the newest step is not first back")
  assert.equal(undone.at(-1), 5, "the oldest steps were kept instead of dropped")
  history.resetHistory()
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
