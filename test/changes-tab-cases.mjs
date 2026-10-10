/**
 * The Changes tab's one section, and taking a change back.
 *
 * 1. Notes and edits are ONE list under one heading, interleaved in the order
 *    they happened, numbered with the same run the canvas pins and the brief
 *    use. One primary button finishes the session: "Apply to code" when only
 *    writable edits are pending, "Send to agent" when anything needs the agent.
 *    One Copy, shared with the toolbar's `notes.copy` chord. One undo timeline,
 *    so a deleted note comes back from Cmd+Z and from the toast alike.
 *
 * 2. Dropping an edit row WITHDRAWS the change, not just the row.
 *
 * 3. Withdrawal works in ANY ORDER: rows are one (element, property) each and
 *    the journal collapses repeats, so rows are independent by construction.
 *
 * The harness is `stranded-write-cases`': one bundle, because the journal, the
 * ledger and the vendor store are all module state and two builds would each
 * get their own.
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR as PACKAGE } from "./host.mjs"

const dom = new JSDOM(
  '<!doctype html><html><body><main id="app"></main></body></html>',
  { pretendToBeVisual: true, url: "http://localhost/overview" }
)
const { window } = dom
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
  "window", "document", "navigator", "Node", "Element", "HTMLElement", "SVGElement",
  "SVGSVGElement", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
Object.defineProperty(window.navigator, "clipboard", {
  value: { writeText: () => Promise.resolve() },
  configurable: true,
})

// No route behind the panel in this harness, except MCP status. The
// component-usage lookup is written to treat a dead route as "say nothing
// confident", and returning a rejection here is what proves it. MCP status
// answers with `mcpStatus` — an attached agent by default, since the tab only
// offers "Send to agent" once one has connected — or rejects when it is null.
const AGENT_ATTACHED = { url: "http://127.0.0.1:5747/mcp", listening: true, agents: 1, waiting: 1 }
let mcpStatus = AGENT_ATTACHED
globalThis.fetch = async (input) => {
  if (String(input).endsWith("/mcp/status") && mcpStatus) {
    const payload = mcpStatus
    return { ok: true, status: 200, json: async () => payload }
  }
  throw new Error("no server in this harness")
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createWriter } from "./src/core/writer"
      export { createContext } from "./src/core/context"
      export { annotationsTab } from "./src/panels/inspector/tab-annotations"
      export { addAnnotation, resetAnnotationsForTest } from "./src/annotations/store"
      export {
        isEditQueued,
        recordEdit,
        resetJournalForTest,
        markEditsWritten,
      } from "./src/annotations/journal"
      export { previewOnlyChanges, recordPreviewOnly, clearPreviewOnly } from "./src/core/change-prompt"
      export { withdrawEdit } from "./src/core/withdraw"
      export { resetComponentUsageForTest } from "./src/core/component-usage"
      export { elementKey } from "./src/core/store"
      export { undo, resetHistory } from "./src/core/history"
      export { installToolbar } from "./src/shell/toolbar"
      export { runCommand } from "./src/core/commands"
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
const ui = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/**
 * A store that records what is queued AND honours a withdrawal.
 *
 * The real one is the vendor's, reached through a patch that exposes its own
 * `su`. Modelled here rather than stubbed to a no-op, because the claim under
 * test is precisely that a withdrawal reaches the queue — a stub that accepted
 * the call and did nothing would pass while the product stayed broken.
 */
function makeBridge() {
  const queued = new Map()
  return {
    queued,
    store: {
      addPendingPropertyOperation(mergeKey, operation, propertyKeys) {
        const entry = queued.get(mergeKey) ?? { keys: new Set() }
        for (const key of propertyKeys) entry.keys.add(key)
        queued.set(mergeKey, entry)
      },
      removePendingPropertyOperation(mergeKey, propertyKeys) {
        const entry = queued.get(mergeKey)
        if (!entry) return
        for (const key of propertyKeys) entry.keys.delete(key)
        if (entry.keys.size === 0) queued.delete(mergeKey)
      },
      buildBatchOperations() {
        return [...queued.values()].map(() => ({ op: "updateClass" }))
      },
      hasChanges() {
        return queued.size > 0
      },
      setActiveTool() {},
      onStateChange() {},
      getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
      viewportToPage: (x, y) => ({ x, y }),
      pageToViewport: (x, y) => ({ x, y }),
    },
    elementInfo() {
      return {
        tagName: "div",
        componentName: "Fixture",
        filePath: "",
        lineNumber: 0,
        columnNumber: 0,
        stack: [],
      }
    },
    async elementSourceAsync() {
      return {
        tagName: "div",
        componentName: "Fixture",
        filePath: "src/Fixture.tsx",
        lineNumber: 4,
        columnNumber: 6,
        stack: [],
      }
    },
    async discoverFile() {
      return null
    },
    send() {},
    subscribe: () => () => {},
    toast(message, kind, action) {
      toasts.push([message, kind, action])
    },
  }
}

const toasts = []

let bridge
let tab

function reset() {
  ui.resetJournalForTest()
  ui.resetAnnotationsForTest()
  ui.clearPreviewOnly()
  ui.resetComponentUsageForTest()
  ui.resetHistory()
  toasts.length = 0
  window.localStorage.clear()
  window.document.getElementById("app").innerHTML = ""
  bridge = makeBridge()
  const context = ui.createContext(bridge, { right: null, left: null, bottom: null })
  tab = ui.annotationsTab(context)
  tab.update()
  return context
}

function mount(html) {
  const host = window.document.getElementById("app")
  const holder = window.document.createElement("div")
  holder.innerHTML = html
  host.append(holder.firstElementChild)
  return host.lastElementChild
}

/**
 * The outbox's sections, in column order, with Settings filtered out: it is a
 * section in the same column but not part of the outbox.
 */
const groups = () =>
  Array.from(tab.node.querySelectorAll(".de-section"))
    .map((node) => ({
      title: node.querySelector(".de-section-title").textContent.trim(),
      rows: Array.from(node.querySelectorAll(".de-ann-item")).map((row) =>
        row.querySelector(".de-ann-item-line")?.textContent.trim() ?? ""
      ),
      kinds: Array.from(node.querySelectorAll(".de-ann-item")).map((row) =>
        row.classList.contains("de-ann-item--note") ? "note" : "edit"
      ),
      numbers: Array.from(node.querySelectorAll(".de-ann-index")).map((n) =>
        Number(n.textContent.trim())
      ),
    }))
    .filter((group) => group.title !== "Settings" && group.title !== "MCP")

const primary = () => tab.node.querySelector(".de-ann-ctas .de-button--primary")
// Only the buttons on screen: without an agent the primary button is `hidden`.
const ctaLabels = () =>
  Array.from(tab.node.querySelectorAll(".de-ann-ctas .de-button"))
    .filter((node) => !node.hidden)
    .map((node) => node.textContent.trim())
const press = (node) =>
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))

function pin(comment) {
  return ui.addAnnotation({
    kind: "element",
    comment,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    target: null,
    selectedText: null,
  })
}

function selectionOf(element) {
  return {
    element,
    tagName: element.tagName.toLowerCase(),
    componentName: "Fixture",
    source: null,
    key: ui.elementKey(element, "Fixture", 0),
  }
}

const rowIds = () =>
  Array.from(tab.node.querySelectorAll(".de-ann-item")).map((row) =>
    row.getAttribute("data-item")
  )

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

console.log("\nOne section, one numbering")

await check("notes and edits are ONE section, interleaved in time order, numbered 1..N", async () => {
  reset()
  const element = mount('<button class="btn">Go</button>')
  const writer = ui.createWriter(bridge)
  const selection = selectionOf(element)

  // Interleaved on purpose: note, edit, note, edit, note.
  pin("First note")
  await settle()
  writer.applyStyles(selection, [{ property: "opacity", value: "0.5" }], "Opacity")
  await settle()
  pin("Second note")
  await settle()
  writer.applyStyles(selection, [{ property: "width", value: "120px" }], "Width")
  await settle()
  pin("Third note")
  tab.update()

  const found = groups()
  assert.deepEqual(found.map((group) => group.title), ["Notes and edits"])
  const [outbox] = found
  assert.deepEqual(outbox.kinds, ["note", "edit", "note", "edit", "note"], "rows are not in time order")
  assert.deepEqual(outbox.numbers, [1, 2, 3, 4, 5], "the rows do not share one run of numbers")
  assert.ok(outbox.rows[1].includes("opacity") && outbox.rows[3].includes("width"))
  // The old shapes, as negatives.
  assert.equal(tab.node.querySelector(".de-ann-none"), null, "the 'No notes yet' line came back")
  assert.equal(tab.node.querySelector(".de-ann-cta"), null, "the per-section button came back")
})

await check("an edits-only session still gets the section, with no placeholder line", async () => {
  reset()
  const element = mount('<button class="btn">Go</button>')
  // `filter` has no Tailwind spelling, so no commit will ever write it. It is
  // still a row in the one list; its BADGE says who finishes it.
  ui.createWriter(bridge).applyStyles(selectionOf(element), [{ property: "filter", value: "blur(2px)" }], "Blur")
  await settle()
  tab.update()

  const [outbox] = groups()
  assert.equal(outbox.title, "Notes and edits")
  assert.ok(outbox.rows.some((line) => line.includes("filter")))
  assert.ok(!tab.node.textContent.includes("No notes yet"))
})

await check("ONE primary button: 'Apply to code' for writable edits, 'Send to agent' once anything needs the agent", async () => {
  reset()
  const element = mount('<button class="btn">Go</button>')
  const writer = ui.createWriter(bridge)
  writer.applyStyles(selectionOf(element), [{ property: "opacity", value: "0.5" }], "Opacity")
  await settle()
  tab.update()

  // Exactly two labelled buttons: the primary and Copy.
  assert.deepEqual(ctaLabels(), ["Apply to code", "Copy"])
  assert.equal(primary().disabled, false, "a queued writable edit left the button disabled")
  assert.equal(primary().querySelector("svg"), null, "Apply to code carries the Send mark")

  // A note needs the agent, so the SAME button now sends — and writes first.
  pin("Tighten this")
  tab.update()
  assert.deepEqual(ctaLabels(), ["Send to agent", "Copy"])
  assert.equal(primary().querySelector("svg"), null, "Send to agent carries a mark")
  assert.match(primary().title, /write/i, "the title does not say the writable edits are written first")
  assert.equal(tab.node.querySelectorAll(".de-ann-ctas .de-button--primary").length, 1)
})

await check("an unwritable edit alone makes the button send", async () => {
  reset()
  const element = mount('<span class="icon">x</span>')
  ui.recordEdit({ property: "icon", from: "Star", to: "Heart", element, written: false })
  // The MCP status answer lands on a later task; the button waits for it.
  await settle()
  tab.update()
  assert.equal(primary().textContent.trim(), "Send to agent")
  assert.equal(primary().disabled, false)
})

console.log("\nMCP")

await check("MCP is its own section, with the status as a mark in its header", async () => {
  reset()
  await settle()
  const mcp = Array.from(tab.node.querySelectorAll(".de-section")).find(
    (node) => node.querySelector(".de-section-title").textContent.trim() === "MCP"
  )
  assert.ok(mcp, "there is no MCP section")
  assert.ok(mcp.querySelector(".de-mcp-url"), "the address is not in the MCP section")
  assert.equal(
    tab.node.querySelector(".de-ann-settings .de-mcp-url"),
    null,
    "the address is still inside Settings"
  )
  const mark = mcp.querySelector(".de-section-header .de-mcp-state")
  assert.ok(mark, "the status is not a mark in the MCP header")
  assert.equal(mark.dataset.deState, "on")
  assert.match(mark.getAttribute("aria-label"), /Connected/)
  assert.equal(mark.textContent, "", "the status is still a sentence, not a mark")
})

await check("with no agent connected, Send to agent is never offered", async () => {
  mcpStatus = { ...AGENT_ATTACHED, agents: 0, waiting: 0 }
  try {
    reset()
    await settle()
    const mark = tab.node.querySelector(".de-section-header .de-mcp-state")
    assert.equal(mark.dataset.deState, "idle")
    assert.match(mark.title, /No agent connected/)

    // A note alone: nothing the button could do, so it is not there at all.
    pin("Tighten this")
    tab.update()
    assert.deepEqual(ctaLabels(), ["Copy"])
    assert.equal(primary().hidden, true)

    // A writable edit beside the note: the button writes, and says so.
    const element = mount('<button class="btn">Go</button>')
    ui.createWriter(bridge).applyStyles(selectionOf(element), [{ property: "opacity", value: "0.5" }], "Opacity")
    await settle()
    tab.update()
    assert.deepEqual(ctaLabels(), ["Apply to code", "Copy"])
  } finally {
    mcpStatus = AGENT_ATTACHED
  }
})

await check("with nothing pending, the primary button is disabled", async () => {
  reset()
  const element = mount('<button class="btn">Go</button>')
  ui.createWriter(bridge).applyStyles(selectionOf(element), [{ property: "opacity", value: "0.5" }], "Opacity")
  await settle()
  // Committed: the row stays, "In your files", and nothing is owed.
  ui.markEditsWritten()
  bridge.queued.clear()
  tab.update()
  assert.equal(primary().textContent.trim(), "Apply to code")
  assert.equal(primary().disabled, true, "the button is live over a session with nothing to do")
})

console.log("\nOne copy")

await check("the toolbar's notes.copy and the tab's Copy put identical text on the clipboard", async () => {
  const context = reset()
  const toolbar = window.document.createElement("div")
  window.document.body.append(toolbar)
  ui.installToolbar({ ...context, slots: { ...context.slots, toolbar } })
  const element = mount('<button class="btn">Go</button>')
  ui.createWriter(bridge).applyStyles(selectionOf(element), [{ property: "opacity", value: "0.5" }], "Opacity")
  await settle()
  pin("Too loud")
  tab.update()

  const written = []
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: (text) => (written.push(text), Promise.resolve()) },
    configurable: true,
  })
  const copy = Array.from(tab.node.querySelectorAll(".de-ann-ctas button")).find(
    (node) => node.textContent.trim() === "Copy"
  )
  const before = toasts.length
  press(copy)
  assert.equal(ui.runCommand("notes.copy"), true, "notes.copy is not registered")
  assert.equal(written.length, 2, "one of the copies wrote nothing inside its own gesture")
  // Each toast waits for its copy to land, so both are read once they have.
  await settle()
  assert.equal(toasts.length, before + 2, "each copy owes exactly one toast")
  const [tabToast, chordToast] = toasts.slice(-2).map((entry) => entry[0])

  assert.equal(written.length, 2, "one of the two copies wrote nothing")
  assert.equal(written[0], written[1], "the chord and the button copied different text")
  assert.equal(tabToast, chordToast, "the chord and the button said different things")
  assert.match(tabToast, /^Copied 1 note and 1 edit$/)
})

console.log("\nOne undo timeline")

await check("deleting a note from its row, then history undo(), brings it back", async () => {
  reset()
  pin("First")
  await settle()
  pin("Second")
  tab.update()
  const rows = () => Array.from(tab.node.querySelectorAll(".de-ann-item--note"))
  press(rows()[0].querySelector(".de-mini--danger"))
  await settle()
  assert.deepEqual(groups()[0].rows, ["Second"], "the delete did not delete")
  assert.doesNotMatch(toasts.at(-1)[0], /cannot be undone/i)

  assert.equal(ui.undo(), "Delete note", "the delete is not on the history timeline")
  tab.update()
  assert.deepEqual(groups()[0].rows, ["First", "Second"], "Cmd+Z did not restore the note in place")
})

await check("the delete toast's Undo brings the note back too", async () => {
  reset()
  pin("Only note")
  tab.update()
  press(tab.node.querySelector(".de-ann-item--note .de-mini--danger"))
  await settle()
  assert.equal(tab.node.querySelectorAll(".de-ann-item--note").length, 0)

  const [message, , action] = toasts.at(-1)
  assert.match(message, /^Deleted the note/)
  assert.equal(action?.label, "Undo")
  action.onClick()
  tab.update()
  assert.deepEqual(groups()[0].rows, ["Only note"], "the toast's Undo did not restore the note")
  // Undone through the timeline, so Cmd+Z has nothing left to take back.
  assert.equal(ui.undo(), null, "the toast's Undo left the delete on the timeline")
})

await check("clear-all is one undoable step, offered back on its toast", async () => {
  reset()
  pin("One")
  await settle()
  pin("Two")
  tab.update()
  const bin = tab.node.querySelectorAll(".de-ann-tools button")[1]
  press(bin)
  assert.doesNotMatch(toasts.at(-1)[0], /cannot be undone/i)
  press(bin)
  assert.equal(tab.node.querySelectorAll(".de-ann-item--note").length, 0)
  assert.equal(toasts.at(-1)[2]?.label, "Undo", "clearing offered no Undo")
  assert.equal(ui.undo(), "Delete 2 notes", "clear-all is not one step on the timeline")
  tab.update()
  assert.deepEqual(groups()[0].rows, ["One", "Two"])
})

console.log("\nTaking a change back")

await check("dropping a row withdraws the queued write, not just the row", async () => {
  reset()
  const element = mount('<button class="btn">Go</button>')
  const writer = ui.createWriter(bridge)
  writer.applyStyles(
    { element, tagName: "button", componentName: "Fixture", source: null, key: ui.elementKey(element, "Fixture", 0) },
    [{ property: "opacity", value: "0.5" }],
    "Opacity"
  )
  await settle()
  assert.equal(bridge.store.hasChanges(), true, "the edit never reached the queue")

  const [id] = rowIds()
  ui.withdrawEdit(bridge, id)

  // The whole point. Before this existed the row went and the operation stayed,
  // so the next Apply wrote a change the designer had thrown away.
  assert.equal(bridge.store.hasChanges(), false, "the queued write survived the withdrawal")
  assert.deepEqual(rowIds(), [], "the row survived the withdrawal")
})

await check("the preview goes back to what it was", async () => {
  reset()
  const element = mount('<button class="btn" style="opacity: 1">Go</button>')
  const writer = ui.createWriter(bridge)
  writer.applyStyles(
    { element, tagName: "button", componentName: "Fixture", source: null, key: ui.elementKey(element, "Fixture", 0) },
    [{ property: "opacity", value: "0.5" }],
    "Opacity"
  )
  await settle()
  assert.equal(element.style.opacity, "0.5")

  ui.withdrawEdit(bridge, rowIds()[0])
  // Safe only because rows collapse: no later row can have written `opacity` on
  // this element, so restoring the "from" cannot clobber somebody else's value.
  assert.equal(element.style.opacity, "1", "the page kept a change that was taken back")
})

await check("ANY row, in ANY order — the middle one goes first", async () => {
  reset()
  const element = mount('<button class="btn">Go</button>')
  const writer = ui.createWriter(bridge)
  const selection = {
    element,
    tagName: "button",
    componentName: "Fixture",
    source: null,
    key: ui.elementKey(element, "Fixture", 0),
  }
  for (const [property, value] of [
    ["opacity", "0.5"],
    ["width", "120px"],
    ["height", "40px"],
  ]) {
    writer.applyStyles(selection, [{ property, value }], property)
  }
  await settle()
  tab.update()
  const ids = rowIds()
  assert.equal(ids.length, 3)

  /*
   * The middle one, then the last, then the first — deliberately not the order
   * they were made in and not the reverse of it either. Undo could not do this;
   * it is a timeline and has to unwind. This is a set of independent rows.
   */
  ui.withdrawEdit(bridge, ids[1])
  tab.update()
  assert.deepEqual(rowIds(), [ids[0], ids[2]], "withdrawing the middle row disturbed its neighbours")

  ui.withdrawEdit(bridge, ids[2])
  tab.update()
  assert.deepEqual(rowIds(), [ids[0]], "withdrawing the last row disturbed the first")

  ui.withdrawEdit(bridge, ids[0])
  tab.update()
  assert.deepEqual(rowIds(), [], "the last withdrawal left something behind")
  assert.equal(bridge.store.hasChanges(), false, "three withdrawals left a queued write")
})

await check("withdrawing an unwritable change clears the ledger too", async () => {
  reset()
  const element = mount('<span class="icon">x</span>')
  ui.recordEdit({
    property: "icon",
    from: "Star",
    to: "Heart",
    element,
    written: false,
  })
  ui.recordPreviewOnly({
    filePath: "src/Fixture.tsx",
    componentName: "Fixture",
    tagName: "span",
    className: "icon",
    property: "icon",
    from: "Star",
    to: "Heart",
  })
  assert.equal(ui.previewOnlyChanges().length, 1)

  tab.update()
  ui.withdrawEdit(bridge, rowIds()[0])

  // The ledger is what builds the brief. A withdrawn change left in it would
  // reach the agent through the one document the designer never re-reads.
  assert.equal(
    ui.previewOnlyChanges().length,
    0,
    "a withdrawn change is still queued for the agent"
  )
})

await check("a row that was already written is not queued, and says so", async () => {
  reset()
  const element = mount('<button class="btn">Go</button>')
  const writer = ui.createWriter(bridge)
  writer.applyStyles(
    { element, tagName: "button", componentName: "Fixture", source: null, key: ui.elementKey(element, "Fixture", 0) },
    [{ property: "opacity", value: "0.5" }],
    "Opacity"
  )
  await settle()
  const [id] = rowIds()
  assert.equal(ui.isEditQueued(id), true, "a fresh writable edit is not owed")

  ui.markEditsWritten()
  assert.equal(ui.isEditQueued(id), false, "a committed edit is still owed")
})

/** The Stay on between apps row in the MCP section, or null. */
const stayRow = () =>
  [...tab.node.querySelectorAll(".de-mcp .de-ann-setting")].find((row) =>
    row.textContent.includes("Stay on between apps")
  ) ?? null

await check("Stay on between apps is offered only when a start screen is behind the editor", async () => {
  try {
    mcpStatus = { ...AGENT_ATTACHED, canStay: false, stay: false }
    reset()
    await settle()
    assert.equal(stayRow()?.hidden, true, "the switch showed for an editor it can do nothing for")

    mcpStatus = { ...AGENT_ATTACHED, canStay: true, stay: false }
    reset()
    await settle()
    assert.equal(stayRow().hidden, false)
    const toggle = stayRow().querySelector('[role="switch"]')
    assert.equal(toggle.getAttribute("aria-checked"), "false", "it is optional, so it starts off")
    assert.equal(toggle.getAttribute("aria-label"), "Stay on between apps")
    assert.equal(
      toggle.getAttribute("aria-description"),
      "Your agent stays connected when you switch or restart apps."
    )
  } finally {
    mcpStatus = AGENT_ATTACHED
  }
})

await check("pressing it moves MCP, and a refusal puts the switch back with the reason", async () => {
  const real = globalThis.fetch
  const posts = []
  let refuse = null
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/mcp/stay")) {
      const body = JSON.parse(init.body)
      posts.push(body)
      if (refuse) return { ok: false, status: 409, json: async () => ({ ok: false, message: refuse }) }
      mcpStatus = { ...mcpStatus, stay: body.on }
      return { ok: true, status: 200, json: async () => mcpStatus }
    }
    return real(input, init)
  }
  try {
    mcpStatus = { ...AGENT_ATTACHED, canStay: true, stay: false }
    reset()
    await settle()
    const toggle = stayRow().querySelector('[role="switch"]')
    toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    await settle()
    assert.deepEqual(posts, [{ on: true }])
    assert.equal(toggle.getAttribute("aria-checked"), "true")

    refuse = "Another program is using port 5747."
    toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    await settle()
    assert.deepEqual(posts.at(-1), { on: false })
    assert.equal(toggle.getAttribute("aria-checked"), "true", "the switch showed a state the server refused")
    const [message, kind] = toasts.at(-1)
    assert.equal(kind, "error")
    assert.equal(message.title, "MCP is still on between apps")
    assert.equal(message.description, "Another program is using port 5747.")
  } finally {
    globalThis.fetch = real
    mcpStatus = AGENT_ATTACHED
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
