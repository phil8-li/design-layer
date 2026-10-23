/**
 * A direct edit is a note: one plain sentence for the designer, and detailed
 * instructions for the agent in the brief.
 *
 * 1. `editNoteText` says each kind of edit in the Design panel's words.
 * 2. `editInstructions` gives the agent the exact declaration, the Tailwind
 *    class to write (or the project's own styling on a non-Tailwind host), and
 *    where the change belongs.
 * 3. Text typed on the page through the engine's double-click editor becomes a
 *    note and an undo step, and the writer never sends the engine's
 *    `updateText`, which wrote the file on the spot.
 *
 * Usage: node test/edit-notes-cases.mjs
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR as PACKAGE } from "./host.mjs"

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
for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement", "SVGElement",
  "Event", "CustomEvent", "MouseEvent", "FocusEvent", "MutationObserver",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { editInstructions, editNoteText, utilityFor } from "./src/annotations/edit-words"
      export { edits, resetJournalForTest } from "./src/annotations/journal"
      export { createWriter } from "./src/core/writer"
      export { installTextEditNotes } from "./src/canvas/text-edit"
      export { undo, resetHistory } from "./src/core/history"
    `,
    resolveDir: PACKAGE,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "silent",
})
const source = bundled.outputFiles[0].text

/**
 * The bundle under one host config. `config` is read once at module load, so
 * a second host is a second evaluation; the counter keeps the data URLs apart.
 */
let evaluations = 0
async function load(host) {
  globalThis.__DESIGNLAYER_CONFIG__ = host ? { host } : undefined
  evaluations += 1
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n//${evaluations}`).toString("base64")}`)
}

const ui = await load({ framework: "react", tailwind: true })

/** An edit record as the journal stores one. */
function edit(property, from, to, target = {}) {
  return {
    id: "edit-1",
    createdAt: new Date().toISOString(),
    property,
    from,
    to,
    written: false,
    target: {
      tagName: "div",
      componentName: "PlanCard",
      className: "",
      id: null,
      selector: "div",
      text: "",
      filePath: null,
      lineNumber: null,
      ancestry: [],
      computed: {},
      components: [],
      ...target,
    },
  }
}

console.log("\nThe note: one plain sentence")

await check("each kind of edit reads as a sentence in the Design panel's words", () => {
  const cases = [
    [edit("border-radius", "12px", "20px"), "Change the corner radius to 20px (was 12px)"],
    [edit("width", "", "200px"), "Set the width to 200px"],
    [edit("padding-left", "24px", "32px"), "Change the left padding to 32px (was 24px)"],
    [edit("gap", "16px", "24px"), "Change the gap to 24px (was 16px)"],
    [edit("opacity", "1", "0.5"), "Change the opacity to 50% (was 100%)"],
    [edit("font-weight", "400", "700"), "Change the font weight to Bold (was Regular)"],
    [edit("background-color", "rgb(255, 255, 255)", "rgb(255, 0, 102)"), "Change the fill color to #FF0066 (was #FFFFFF)"],
    [edit("color", "", "rgba(0, 0, 0, 0.3)"), "Set the text color to #000000 at 30%"],
    [edit("rotate", "none", "45deg"), "Change the rotation to 45° (was none)"],
    [edit("display", "block", "flex"), "Add auto layout"],
    [edit("display", "flex", "block"), "Remove auto layout"],
    [edit("display", "block", "none"), "Hide this element"],
    [edit("visibility", "visible", "hidden"), "Hide this element, keeping its space"],
    [edit("flex-direction", "row", "column"), "Stack its items vertically"],
    [edit("overflow", "visible", "hidden"), "Clip its content"],
    [edit("justify-content", "normal", "space-between"), "Space its items apart (auto gap)"],
    [edit("text-align", "start", "center"), "Center the text"],
    [edit("scale", "none", "-1 1"), "Flip it horizontally"],
    [edit("transform", "none", "translate(4px, -2px)"), "Move it 4px right and 2px up"],
    [edit("box-shadow", "none", "0 2px 8px #0003"), "Add a shadow: 0 2px 8px #0003"],
    [edit("filter", "none", "blur(2px)"), "Add a layer blur of 2px"],
    [edit("text", "Pro plan", "Team plan"), "Change the text to “Team plan” (was “Pro plan”)"],
    [edit("icon", "Star", "Heart"), "Swap the icon to Heart (was Star)"],
    [edit("class", "btn btn--outlined", "btn btn--filled"), "Replace the class btn--outlined with btn--filled"],
    [edit("remove", "<div>", ""), "Delete this element"],
    [edit("reorder", "", "front"), "Bring it to the front of its siblings"],
    [edit("reorder", "", 'before:button "Save"'), 'Move it before button "Save"'],
    [edit("attribute:variant", "outline", "solid"), "Change the variant prop to solid (was outline)"],
  ]
  for (const [record, sentence] of cases) assert.equal(ui.editNoteText(record), sentence, record.property)
})

await check("a long text is cut in the sentence, never in the instructions", () => {
  const long = "Plans scale with your team, from a single seat to the whole company, with no surprises"
  const record = edit("text", "Short", long)
  assert.match(ui.editNoteText(record), /^Change the text to “.{59}…” \(was “Short”\)$/)
  assert.ok(ui.editInstructions(record)[0].includes(long), "the agent lost the end of the copy")
})

console.log("\nThe brief: instructions for the agent")

await check("a style edit names the declaration, the Tailwind swap and where to make it", () => {
  const lines = ui.editInstructions(edit("border-radius", "12px", "20px", { className: "box rounded-xl bg-blue" }))
  assert.deepEqual(lines, [
    "Set `border-radius: 20px` on this element. It is `12px` now.",
    "Tailwind: replace `rounded-xl` with `rounded-[20px]`.",
    "If the theme has a token with this value, use the token in place of the arbitrary value.",
    "Edit the JSX or template of <PlanCard> that renders this element.",
  ])
})

await check("a value on the theme scale gets its named class and no token hint", () => {
  const lines = ui.editInstructions(edit("padding", "16px", "24px", { className: "p-4" }))
  assert.ok(lines.includes("Tailwind: replace `p-4` with `p-6`."), lines.join("\n"))
  assert.ok(!lines.some((line) => line.includes("token")), "a scale value was sent to look for a token")
})

await check("a drag says to move it through the layout, not a transform", () => {
  const lines = ui.editInstructions(edit("transform", "none", "translate(24px, 0px)"))
  assert.match(lines[1], /^The designer dragged it 24px right\. Get it there through the layout/)
  assert.ok(!lines.some((line) => line.startsWith("Tailwind")), "a drag was turned into a transform class")
})

await check("text, delete, icon and reorder each say how to change the source", () => {
  assert.match(ui.editInstructions(edit("text", "Pro plan", "Team plan"))[1], /prop, a variable, a translation file or a CMS/)
  assert.match(ui.editInstructions(edit("remove", "<div>", ""))[1], /import, handler or state/)
  assert.match(ui.editInstructions(edit("icon", "Star", "Heart"))[0], /from the icon set the project already uses/)
  const move = ui.editInstructions(edit("reorder", "", "back"))
  assert.equal(move[0], "Move this element in the source so it is the last child of its parent.")
  assert.match(move[1], /not z-index/)
})

await check("a host without Tailwind is told to use its own styling, not a class", async () => {
  const plain = await load({ framework: "angular", tailwind: false })
  const lines = plain.editInstructions(edit("border-radius", "12px", "20px", { className: "card" }))
  assert.ok(!lines.some((line) => line.startsWith("Tailwind")), lines.join("\n"))
  assert.match(lines[1], /the way this project already styles the element/)
})

console.log("\nText typed on the page")

/** A selection the writer and the listener both accept. */
function selectionFor(element) {
  return { element, tagName: element.tagName.toLowerCase(), componentName: "PlanCard", source: null, key: "plan" }
}

function makeBridge() {
  const sent = []
  return { sent, send: (message) => sent.push(message), store: {}, elementInfo: () => null }
}

/** The engine's editor, as the DOM sees it: editable, focused, typed in, closed. */
function typeOnPage(element, html) {
  element.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }))
  element.setAttribute("contenteditable", "true")
  element.tabIndex = -1
  element.focus()
  element.innerHTML = html
  element.removeAttribute("contenteditable")
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

await check("a text edit in the engine's editor becomes a note and one undo step", async () => {
  ui.resetJournalForTest()
  ui.resetHistory()
  window.document.body.innerHTML = '<h2 id="title">Pro <b>plan</b></h2>'
  const title = window.document.getElementById("title")
  let selection = [selectionFor(title)]
  let refreshed = 0
  const context = {
    getState: () => ({ selection }),
    selectMany: (elements) => {
      selection = elements.map(selectionFor)
    },
    refresh: () => {
      refreshed += 1
    },
  }
  const bridge = makeBridge()
  ui.installTextEditNotes(context, ui.createWriter(bridge))

  typeOnPage(title, "Team <b>plan</b>")
  await settle()

  const [note] = ui.edits()
  assert.ok(note, "the text edit left no note")
  assert.equal(note.property, "text")
  assert.equal(note.from, "Pro plan")
  assert.equal(note.to, "Team plan")
  assert.equal(ui.editNoteText(note), "Change the text to “Team plan” (was “Pro plan”)")
  assert.deepEqual(bridge.sent, [], "the text edit went to the source")
  assert.equal(refreshed, 1, "the panels were not told the layer's words changed")

  // Undo puts the markup back, inline children and all, and takes the note.
  assert.equal(ui.undo(), "Edit text")
  assert.equal(title.innerHTML, "Pro <b>plan</b>")
  assert.equal(ui.edits().length, 0)
})

await check("typing in the app's own editable field is using the app, not an edit", async () => {
  ui.resetJournalForTest()
  window.document.body.innerHTML = '<div id="field" contenteditable="true">Draft</div>'
  const field = window.document.getElementById("field")
  const context = { getState: () => ({ selection: [selectionFor(field)] }), selectMany: () => {}, refresh: () => {} }
  ui.installTextEditNotes(context, ui.createWriter(makeBridge()))
  field.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }))
  field.focus()
  field.textContent = "Draft two"
  field.blur()
  await settle()
  assert.equal(ui.edits().length, 0)
})

await check("applyText previews the copy and never sends the engine's updateText", () => {
  ui.resetJournalForTest()
  window.document.body.innerHTML = '<p id="copy">Plans scale with your team.</p>'
  const copy = window.document.getElementById("copy")
  const bridge = makeBridge()
  const selection = { ...selectionFor(copy), source: { filePath: "src/App.jsx", lineNumber: 4, columnNumber: 6, componentName: "App" } }
  ui.createWriter(bridge).applyText(selection, "Plans grow with you.")
  assert.equal(copy.textContent, "Plans grow with you.")
  assert.deepEqual(bridge.sent, [], "the writer still writes text to the file")
  assert.equal(ui.edits()[0]?.to, "Plans grow with you.")
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
