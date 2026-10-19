/**
 * The Layout / Auto layout section, on Figma's rows.
 *
 * Pins what each control WRITES, because the writes are what reach the host's
 * source and a refactor of the rows can quietly change them:
 *
 *  - the title says `Auto layout` only for a box that lays out its children,
 *    and the header toggle and Shift+A add and remove it through one path;
 *  - Flow is Freeform / Vertical / Horizontal / Grid, and Wrap is a separate
 *    toggle that writes `flex-wrap`;
 *  - the gap menu's Auto is `justify-content: space-between`, and the field
 *    then reads Auto;
 *  - padding is written as side longhands, two at a time or one per side;
 *  - Clip content writes `overflow`;
 *  - the aspect lock scales the other axis on commit.
 *
 * Usage: node test/layout-section-cases.mjs
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
  "HTMLSelectElement", "SVGElement", "SVGSVGElement", "Event", "CustomEvent", "KeyboardEvent",
  "MouseEvent", "PointerEvent", "requestAnimationFrame", "cancelAnimationFrame",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

/*
 * JSDOM computes none of the flex or grid longhands, so every element's
 * computed style is served from a fixture map. A property the section asks for
 * and the fixture does not set reads as the empty string, as a browser's
 * unset longhand never would, so a missing fixture shows up as a wrong value.
 */
const styles = new WeakMap()
function computedFor(values) {
  const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  const style = { display: "block", flexDirection: "row", flexWrap: "nowrap", ...values }
  return new Proxy(style, {
    get(target, key) {
      if (key === "getPropertyValue") return (name) => target[camel(name)] ?? ""
      return target[key] ?? ""
    },
  })
}
globalThis.getComputedStyle = (node) => styles.get(node) ?? computedFor({})
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export {
        autoLayoutRows, autoLayoutToggle, clipContentRow, flowRow, layoutTitle,
      } from "./src/panels/inspector/section-autolayout"
      export { sizeControls } from "./src/panels/inspector/section-layout"
      export { unifiedLayoutSection } from "./src/panels/inspector/section-unified-layout"
      export { isExpanded, numberField, setExpanded } from "./src/panels/inspector/field"
      export { matchShortcut } from "./src/core/keymap"
      export { runCommand } from "./src/core/commands"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const layout = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

/* ---------- fixture ---------- */

/**
 * One selected element with `children` kids, its computed style, and a writer
 * that records every write. `parent` is the parent's computed style.
 */
function scene({ style = {}, children = 2, parent = {}, rect = { width: 200, height: 100 } } = {}) {
  window.document.body.replaceChildren()
  const outer = window.document.createElement("div")
  const element = window.document.createElement("div")
  for (let i = 0; i < children; i += 1) element.append(window.document.createElement("span"))
  outer.append(element)
  window.document.body.append(outer)
  styles.set(outer, computedFor(parent))
  const computed = computedFor(style)
  styles.set(element, computed)
  element.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, ...rect })

  const writes = []
  let invalidated = 0
  const selection = { element, tagName: "div", componentName: "Fixture", source: null, key: "k" }
  const context = {
    editor: { getState: () => ({ selection: [selection] }), bridge: { elementInfo: () => null } },
    writer: {
      applyStyles: (_selection, list, summary) => writes.push({ list, summary }),
    },
    selection,
    computed,
    invalidate: () => {
      invalidated += 1
    },
  }
  return { context, element, writes, invalidated: () => invalidated }
}

const flat = (writes) => Object.fromEntries(writes.flatMap((entry) => entry.list.map((w) => [w.property, w.value])))
const byLabel = (root, label) => root.querySelector(`[aria-label="${label}"]`)
const field = (root, id) => root.querySelector(`[data-de-field="${id}"]`)

function commit(input, value) {
  input.value = String(value)
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
}

function pick(select, value) {
  select.value = value
  select.dispatchEvent(new window.Event("change", { bubbles: true }))
}

const FLEX_ROW = { display: "flex", flexDirection: "row", justifyContent: "flex-start", alignItems: "center", columnGap: "16px", rowGap: "16px" }

/* ---------- title and add / remove ---------- */

console.log("\nTitle and the add / remove toggle")

await check("a box that does not lay out its children is titled Layout", () => {
  const { context } = scene()
  assert.equal(layout.layoutTitle(context), "Layout")
})

await check("a flex or grid box with children is titled Auto layout", () => {
  assert.equal(layout.layoutTitle(scene({ style: FLEX_ROW }).context), "Auto layout")
  assert.equal(layout.layoutTitle(scene({ style: { display: "grid" } }).context), "Auto layout")
})

await check("the header toggle adds auto layout as a horizontal flex box", () => {
  const { context, writes } = scene()
  const toggle = layout.autoLayoutToggle(context)
  assert.equal(toggle.getAttribute("aria-label"), "Add auto layout")
  assert.equal(toggle.getAttribute("aria-pressed"), "false")
  toggle.click()
  assert.deepEqual(flat(writes), { display: "flex", "flex-direction": "row" })
})

await check("the header toggle removes auto layout by writing display block", () => {
  const { context, writes } = scene({ style: FLEX_ROW })
  const toggle = layout.autoLayoutToggle(context)
  assert.equal(toggle.getAttribute("aria-label"), "Remove auto layout")
  assert.equal(toggle.getAttribute("aria-pressed"), "true")
  toggle.click()
  assert.deepEqual(flat(writes), { display: "block" })
})

await check("a leaf gets no add toggle", () => {
  assert.equal(layout.autoLayoutToggle(scene({ children: 0 }).context), null)
})

await check("Shift+A and Option+Shift+A are bound to add and remove", () => {
  const press = (init) => layout.matchShortcut(new window.KeyboardEvent("keydown", init))?.command
  assert.equal(press({ key: "A", code: "KeyA", shiftKey: true }), "layout.auto.add")
  assert.equal(press({ key: "Å", code: "KeyA", shiftKey: true, altKey: true }), "layout.auto.remove")
})

await check("the section registers the commands against the current selection", async () => {
  const { context, writes } = scene()
  layout.unifiedLayoutSection(context)
  assert.equal(layout.runCommand("layout.auto.add"), true)
  assert.deepEqual(flat(writes), { display: "flex", "flex-direction": "row" })

  // A selection the panel no longer shows is not written to.
  const stale = scene({ style: FLEX_ROW })
  layout.unifiedLayoutSection(stale.context)
  stale.context.editor.getState = () => ({ selection: [] })
  layout.runCommand("layout.auto.remove")
  assert.equal(stale.writes.length, 0)
})

/* ---------- flow and wrap ---------- */

console.log("\nFlow and Wrap")

await check("Flow offers Figma's four flows in Figma's order", () => {
  const row = layout.flowRow(scene().context)
  const labels = [...row.querySelectorAll(".de-iseg button")].map((b) => b.getAttribute("aria-label"))
  assert.deepEqual(labels, ["Freeform", "Vertical", "Horizontal", "Grid"])
  assert.equal(row.querySelector(".de-prow-caption").textContent, "Flow")
})

await check("Grid writes display grid, Vertical writes a column with no wrap", () => {
  const grid = scene()
  byLabel(layout.flowRow(grid.context), "Grid").click()
  assert.deepEqual(flat(grid.writes), { display: "grid" })

  const vertical = scene({ style: { ...FLEX_ROW, flexWrap: "wrap" } })
  byLabel(layout.flowRow(vertical.context), "Vertical").click()
  assert.deepEqual(flat(vertical.writes), { display: "flex", "flex-direction": "column", "flex-wrap": "nowrap" })
})

await check("Wrap is a column-3 toggle that writes flex-wrap, not a fourth flow", () => {
  const { context, writes } = scene({ style: FLEX_ROW })
  const row = layout.flowRow(context)
  const wrap = row.querySelector(".de-prow-trail [aria-label='Wrap']")
  assert.ok(wrap, "no Wrap toggle in the trailing column")
  assert.equal(wrap.getAttribute("aria-pressed"), "false")
  wrap.click()
  assert.deepEqual(flat(writes), { "flex-wrap": "wrap" })

  const wrapped = scene({ style: { ...FLEX_ROW, flexWrap: "wrap" } })
  const again = layout.flowRow(wrapped.context).querySelector("[aria-label='Wrap']")
  assert.equal(again.getAttribute("aria-pressed"), "true")
  again.click()
  assert.deepEqual(flat(wrapped.writes), { "flex-wrap": "nowrap" })
})

await check("Wrap is disabled on a vertical stack and absent on freeform and grid", () => {
  const vertical = layout.flowRow(scene({ style: { ...FLEX_ROW, flexDirection: "column" } }).context)
  assert.equal(byLabel(vertical, "Wrap").disabled, true)
  assert.equal(byLabel(layout.flowRow(scene().context), "Wrap"), null)
  assert.equal(byLabel(layout.flowRow(scene({ style: { display: "grid" } }).context), "Wrap"), null)
})

/* ---------- alignment and gap ---------- */

console.log("\nAlignment and Gap")

await check("Alignment and Gap share one row with a caption each, and no Packed control", () => {
  const [row] = layout.autoLayoutRows(scene({ style: FLEX_ROW }).context)
  const captions = [...row.querySelectorAll(".de-prow-caption")].map((n) => n.textContent)
  assert.deepEqual(captions, ["Alignment", "Gap"])
  assert.ok(row.querySelector(".de-pad"))
  assert.ok(field(row, "autolayout.gap"))
  const text = row.textContent
  assert.ok(!text.includes("Packed") && !text.includes("Space between"), "the old distribution switch is back")
})

await check("the gap menu's Auto writes space-between", () => {
  const { context, writes } = scene({ style: FLEX_ROW })
  const [row] = layout.autoLayoutRows(context)
  const menu = byLabel(row, "Gap options")
  assert.deepEqual([...menu.options].map((o) => o.textContent), ["16", "Auto"])
  pick(menu, "auto")
  assert.deepEqual(flat(writes), { "justify-content": "space-between" })
})

await check("with Auto on the gap field reads Auto, and a typed gap turns it off", () => {
  const { context, writes } = scene({ style: { ...FLEX_ROW, justifyContent: "space-between" } })
  const [row] = layout.autoLayoutRows(context)
  const input = field(row, "autolayout.gap")
  assert.equal(input.value, "")
  assert.equal(input.placeholder, "Auto")
  assert.equal(byLabel(row, "Gap options").value, "auto")
  commit(input, 12)
  assert.deepEqual(flat(writes), { gap: "12px", "justify-content": "flex-start" })
})

await check("a pad cell keeps space-between on the main axis while Auto is on", () => {
  const { context, writes } = scene({ style: { ...FLEX_ROW, justifyContent: "space-between" } })
  const [row] = layout.autoLayoutRows(context)
  row.querySelectorAll(".de-pad-cell")[8].click()
  assert.deepEqual(flat(writes), { "justify-content": "space-between", "align-items": "flex-end" })
})

await check("a grid shows columns, rows, column gap and row gap", () => {
  const { context, writes } = scene({
    style: { display: "grid", gridTemplateColumns: "100px 100px", gridTemplateRows: "40px 40px", columnGap: "8px", rowGap: "4px" },
  })
  const [row] = layout.autoLayoutRows(context)
  assert.deepEqual([...row.querySelectorAll(".de-prow-caption")].map((n) => n.textContent), ["Grid", "Gap"])
  assert.equal(field(row, "autolayout.grid-template-columns").value, "2")
  assert.equal(field(row, "autolayout.row-gap").value, "4")
  commit(field(row, "autolayout.column-gap"), 12)
  commit(field(row, "autolayout.grid-template-columns"), 3)
  assert.deepEqual(flat(writes), { "column-gap": "12px", "grid-template-columns": "repeat(3, minmax(0, 1fr))" })
})

/* ---------- padding ---------- */

console.log("\nPadding")

const PADDED = { ...FLEX_ROW, paddingTop: "20px", paddingBottom: "20px", paddingLeft: "24px", paddingRight: "24px" }

await check("padding reads as horizontal and vertical and writes side longhands in pairs", () => {
  layout.setExpanded("autolayout.padding", false)
  const { context, writes } = scene({ style: PADDED })
  const block = layout.autoLayoutRows(context)[1]
  assert.equal(field(block, "autolayout.padding-x").value, "24")
  assert.equal(field(block, "autolayout.padding-y").value, "20")
  commit(field(block, "autolayout.padding-x"), 8)
  assert.deepEqual(flat(writes), { "padding-left": "8px", "padding-right": "8px" })
})

await check("unequal sides read Mixed", () => {
  layout.setExpanded("autolayout.padding", false)
  const block = layout.autoLayoutRows(scene({ style: { ...PADDED, paddingRight: "4px" } }).context)[1]
  assert.equal(field(block, "autolayout.padding-x").placeholder, "Mixed")
})

await check("Individual padding splits the row into left/top over right/bottom", () => {
  layout.setExpanded("autolayout.padding", false)
  const first = scene({ style: PADDED })
  const toggle = byLabel(layout.autoLayoutRows(first.context)[1], "Individual padding")
  assert.equal(toggle.getAttribute("aria-pressed"), "false")
  toggle.click()
  assert.equal(layout.isExpanded("autolayout.padding"), true)

  const { context, writes } = scene({ style: PADDED })
  const block = layout.autoLayoutRows(context)[1]
  const rows = block.querySelectorAll(".de-prow")
  assert.equal(rows.length, 2)
  const ids = (node) => [...node.querySelectorAll("[data-de-field]")].map((n) => n.getAttribute("data-de-field"))
  assert.deepEqual(ids(rows[0]), ["autolayout.padding.left", "autolayout.padding.top"])
  assert.deepEqual(ids(rows[1]), ["autolayout.padding.right", "autolayout.padding.bottom"])
  assert.equal(byLabel(block, "Individual padding").getAttribute("aria-pressed"), "true")
  commit(field(block, "autolayout.padding.bottom"), 6)
  assert.deepEqual(flat(writes), { "padding-bottom": "6px" })
  layout.setExpanded("autolayout.padding", false)
})

/* ---------- clip content ---------- */

console.log("\nClip content")

await check("Clip content writes overflow hidden and visible", () => {
  const off = scene({ style: { overflow: "visible", overflowX: "visible" } })
  const box = field(layout.clipContentRow(off.context), "autolayout.clip")
  assert.equal(box.checked, false)
  box.checked = true
  box.dispatchEvent(new window.Event("change"))
  assert.deepEqual(flat(off.writes), { overflow: "hidden" })

  const on = scene({ style: { overflow: "hidden", overflowX: "hidden" } })
  const checked = field(layout.clipContentRow(on.context), "autolayout.clip")
  assert.equal(checked.checked, true)
  checked.checked = false
  checked.dispatchEvent(new window.Event("change"))
  assert.deepEqual(flat(on.writes), { overflow: "visible" })
})

await check("a leaf has no Clip content row", () => {
  assert.equal(layout.clipContentRow(scene({ children: 0 }).context), null)
})

/* ---------- resizing ---------- */

console.log("\nDimensions, Resizing and the aspect lock")

await check("the size row is Dimensions outside auto layout and Resizing inside it", () => {
  const caption = (row) => row.querySelector(".de-prow-caption").textContent
  assert.equal(caption(layout.sizeControls(scene({ children: 0 }).context)), "Dimensions")
  assert.equal(caption(layout.sizeControls(scene({ style: FLEX_ROW }).context)), "Resizing")
  assert.equal(caption(layout.sizeControls(scene({ children: 0, parent: FLEX_ROW }).context)), "Resizing")
})

await check("each axis shows its mode word and picks Fixed, Hug or Fill from a menu", () => {
  const { context, element, writes } = scene({ children: 0 })
  element.style.width = "100%"
  const row = layout.sizeControls(context)
  const menu = byLabel(row, "Horizontal resizing: Fill container")
  assert.ok(menu, "the width menu does not name its mode")
  assert.equal(menu.closest(".de-lay-menu").textContent.startsWith("Fill"), true)
  assert.deepEqual([...menu.options].map((o) => o.textContent), ["Fixed width", "Hug contents", "Fill container"])
  pick(menu, "hug")
  assert.deepEqual(flat(writes), { width: "fit-content" })
})

await check("a row stretched across a vertical list reads Fill", () => {
  const { context } = scene({ children: 0, parent: { display: "flex", flexDirection: "column", alignItems: "normal" } })
  styles.get(context.selection.element).alignSelf = "stretch"
  const row = layout.sizeControls(context)
  assert.ok(byLabel(row, "Horizontal resizing: Fill container"))
})

await check("typing a width while the axis hugs writes a fixed length", () => {
  const { context, element, writes } = scene({ children: 0 })
  element.style.width = "fit-content"
  commit(field(layout.sizeControls(context), "size.width"), 150)
  assert.deepEqual(flat(writes), { width: "150px" })
})

await check("Lock aspect ratio scales the other axis on commit", () => {
  layout.setExpanded("layout.aspect-lock", false)
  const first = scene({ children: 0 })
  const lock = byLabel(layout.sizeControls(first.context), "Lock aspect ratio")
  assert.equal(lock.getAttribute("aria-pressed"), "false")
  lock.click()
  assert.equal(layout.isExpanded("layout.aspect-lock"), true)

  const { context, writes } = scene({ children: 0, rect: { width: 200, height: 100 } })
  const row = layout.sizeControls(context)
  commit(field(row, "size.width"), 300)
  assert.deepEqual(flat(writes), { width: "300px", height: "150px" })
  writes.length = 0
  commit(field(row, "size.height"), 50)
  assert.deepEqual(flat(writes), { height: "50px", width: "100px" })
  layout.setExpanded("layout.aspect-lock", false)
})

await check("the column-3 controls all land in the trailing column", () => {
  const { context } = scene({ style: PADDED })
  const section = layout.unifiedLayoutSection(context)
  for (const label of ["Wrap", "Lock aspect ratio", "Individual padding"]) {
    assert.ok(byLabel(section, label)?.closest(".de-prow-trail"), `${label} is not in column 3`)
  }
})

await check("a number field commits on blur only when its text changed and it is still on the page", () => {
  // Chrome blurs a focused input as a rebuild removes it; committing then looped
  // any section whose commit rebuilds the panel (Rotation froze the page).
  const commits = []
  const field = layout.numberField({ title: "Gap", label: "G", value: 8, onCommit: (value) => commits.push(value) })
  window.document.body.replaceChildren(field)
  const input = field.querySelector("input")
  input.dispatchEvent(new window.Event("blur"))
  assert.deepEqual(commits, [], "an unedited blur committed")
  input.value = "12"
  field.remove()
  input.dispatchEvent(new window.Event("blur"))
  assert.deepEqual(commits, [], "a removed field committed on blur")
  window.document.body.append(field)
  input.dispatchEvent(new window.Event("blur"))
  assert.deepEqual(commits, [12])
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
