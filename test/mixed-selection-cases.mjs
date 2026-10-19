/**
 * Figma's mixed editing for a multi-selection.
 *
 * With several layers picked, a section still builds its controls around the
 * primary, and two helpers in `src/panels/inspector/multi.ts` make it act on
 * the set:
 *
 *  - `fanOutWriter` turns a write for the primary into ONE `applyStylesBatch`
 *    over every selected layer: one undo step, one outbox entry per element.
 *    Writes aimed elsewhere and batches a section already makes pass through;
 *  - `sharedValue` reads the value every layer agrees on, and a field whose
 *    layers disagree is empty with the placeholder "Mixed". Typing into it
 *    writes the value to all.
 *
 * Paint sections whose layers paint differently show Figma's "Click + to
 * replace mixed content", and `+` gives every layer one paint. A single
 * selection is checked to read and write exactly as before.
 *
 * Usage: node test/mixed-selection-cases.mjs
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
  "HTMLSelectElement", "HTMLOptionElement", "SVGElement", "SVGSVGElement", "Event", "CustomEvent",
  "KeyboardEvent", "MouseEvent", "PointerEvent", "requestAnimationFrame", "cancelAnimationFrame", "CSS",
]) {
  if (!(key in window)) continue
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

/*
 * JSDOM computes none of the flex, grid or type longhands, so each element's
 * computed style is a fixture. The element's own inline style wins over it,
 * which is what lets the real writer read back what it wrote.
 */
const fixtures = new WeakMap()
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const BASE = {
  display: "block",
  flexDirection: "row",
  flexWrap: "nowrap",
  opacity: "1",
  backgroundColor: "rgba(0, 0, 0, 0)",
  color: "rgb(0, 0, 0)",
  borderTopStyle: "none",
  borderTopColor: "rgb(0, 0, 0)",
  boxShadow: "none",
  fontFamily: "Inter",
  fontSize: "16px",
  fontWeight: "400",
  lineHeight: "24px",
  letterSpacing: "0px",
  textAlign: "left",
  textTransform: "none",
  textDecorationLine: "none",
  visibility: "visible",
  mixBlendMode: "normal",
}
globalThis.getComputedStyle = (node) => {
  const values = { ...BASE, ...(fixtures.get(node) ?? {}) }
  const inline = (name) => node.style?.getPropertyValue(name) || ""
  return new Proxy(values, {
    get(target, key) {
      if (key === "getPropertyValue") return (name) => inline(name) || target[camel(name)] || ""
      if (typeof key !== "string") return undefined
      return inline(kebab(key)) || target[key] || ""
    },
  })
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { fanOutWriter, sharedValue, MIXED } from "./src/panels/inspector/multi"
      export { appearanceSection, RADIUS_EXPANDER } from "./src/panels/inspector/section-appearance"
      export { typographySection } from "./src/panels/inspector/section-typography"
      export { fillSection } from "./src/panels/inspector/section-fill"
      export { strokeSection } from "./src/panels/inspector/section-stroke"
      export { effectsSection } from "./src/panels/inspector/section-effects"
      export { classesSection } from "./src/panels/inspector/section-classes"
      export { unifiedLayoutSection } from "./src/panels/inspector/section-unified-layout"
      export { setExpanded } from "./src/panels/inspector/field"
      export { createWriter } from "./src/core/writer"
      export * as history from "./src/core/history"
      export { getState, setState } from "./src/core/store"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const surface = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

/* ---------- fixture ---------- */

/**
 * One layer per entry in `layers`, all selected, the first primary. Each
 * entry is `{ style, text, children, rect }`. `real` swaps the recording
 * writer for the actual one, so undo is exercised against the timeline.
 */
function scene(layers, { real = false } = {}) {
  window.document.body.replaceChildren()
  surface.history.resetHistory()
  const elements = layers.map((layer, index) => {
    const element = window.document.createElement("div")
    if (layer.text) element.textContent = layer.text
    for (let i = 0; i < (layer.children ?? 0); i += 1) element.append(window.document.createElement("span"))
    fixtures.set(element, layer.style ?? {})
    const rect = { width: 100, height: 50, ...(layer.rect ?? {}) }
    element.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: rect.width, bottom: rect.height, ...rect })
    window.document.body.append(element)
    element.dataset.index = String(index)
    return element
  })
  const selections = elements.map((element, index) => ({
    element,
    tagName: "div",
    componentName: index === 0 ? "Card" : "",
    source: null,
    key: `mixed-${Math.random()}-${index}`,
  }))

  const calls = []
  const stub = {
    applyStyles: (selection, writes, summary) => calls.push({ kind: "styles", selection, writes, summary }),
    applyStylesBatch: (edits, summary) => calls.push({ kind: "batch", edits, summary }),
    applyClasses: (selection, write, summary) => calls.push({ kind: "classes", selection, write, summary }),
  }
  const bridge = {
    elementInfo: () => null,
    send: () => {},
    subscribe: () => () => {},
    toast: () => {},
    store: { addPendingPropertyOperation: () => {} },
  }
  const base = real ? surface.createWriter(bridge) : stub
  const host = window.document.createElement("div")
  window.document.body.append(host)

  let current = null
  const context = {
    editor: {
      apiBase: "http://127.0.0.1:0/api",
      bridge,
      toast() {},
      getState: () => ({ ...surface.getState(), selection: selections }),
      setState: surface.setState,
    },
    writer: surface.fanOutWriter(base, selections),
    selection: selections[0],
    selections,
    computed: getComputedStyle(elements[0]),
    invalidate: () => {},
  }
  const api = {
    elements,
    selections,
    calls,
    context,
    host,
    mount(section) {
      current = section
      host.replaceChildren()
      const node = section(context)
      if (node) host.append(node)
      return api
    },
    rebuild() {
      return api.mount(current)
    },
    field: (id) => host.querySelector(`[data-de-field="${id}"]`),
    label: (name) => host.querySelector(`[aria-label="${name}"]`),
    batches: () => calls.filter((call) => call.kind === "batch"),
  }
  return api
}

const commit = (input, value) => {
  input.value = String(value)
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
}
const click = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
const isMixed = (input) => {
  assert.ok(input, "field not drawn")
  assert.equal(input.value, "", `${input.getAttribute("data-de-field")} shows a value`)
  assert.equal(input.placeholder, "Mixed", `${input.getAttribute("data-de-field")} is not Mixed`)
}
const pressed = (group) => [...group.querySelectorAll('[aria-pressed="true"]')].map((n) => n.getAttribute("aria-label"))
const targets = (batch) => batch.edits.map((edit) => edit.selection.element.dataset.index)

/* ---------- fan-out ---------- */

console.log("\nFan-out")

await check("a write for the primary becomes one batch over every selected layer", () => {
  const view = scene([{}, {}, {}])
  view.context.writer.applyStyles(view.selections[0], [{ property: "opacity", value: "0.5" }], "Set opacity")
  assert.equal(view.calls.length, 1)
  const [call] = view.calls
  assert.equal(call.kind, "batch")
  assert.deepEqual(targets(call), ["0", "1", "2"])
  assert.deepEqual(call.edits[2].writes, [{ property: "opacity", value: "0.5" }])
  assert.equal(call.summary, "Set opacity")
})

await check("a write aimed elsewhere and a section's own batch pass through once", () => {
  const view = scene([{}, {}])
  const parent = { element: window.document.body, tagName: "body", componentName: "", source: null, key: "p" }
  view.context.writer.applyStyles(parent, [{ property: "display", value: "flex" }], "Auto layout on parent")
  view.context.writer.applyStylesBatch([{ selection: view.selections[1], writes: [] }], "Align")
  assert.deepEqual(view.calls.map((call) => call.kind), ["styles", "batch"])
  assert.equal(view.calls[0].selection, parent)
  assert.equal(view.calls[1].edits.length, 1, "a section's own batch was fanned out again")
})

await check("class writes reach every layer, through a class batch when the writer has one", () => {
  const view = scene([{}, {}])
  view.context.writer.applyClasses(view.selections[0], { remove: [], add: ["rounded-lg"] }, "Apply")
  assert.deepEqual(
    view.calls.map((call) => call.selection.element.dataset.index),
    ["0", "1"]
  )
  const batches = []
  const writer = surface.fanOutWriter(
    { applyStyles() {}, applyStylesBatch() {}, applyClasses() {}, applyClassesBatch: (edits) => batches.push(edits) },
    view.selections
  )
  writer.applyClasses(view.selections[0], { remove: [], add: ["p-2"] }, "Apply")
  assert.equal(batches.length, 1)
  assert.equal(batches[0].length, 2)
})

await check("one selected layer keeps the writer it was given", () => {
  const writer = { applyStyles() {}, applyStylesBatch() {}, applyClasses() {} }
  const view = scene([{}])
  assert.equal(surface.fanOutWriter(writer, view.selections), writer)
})

await check("a fanned-out commit is one undo step that restores every layer", () => {
  surface.setExpanded(surface.RADIUS_EXPANDER, false)
  const view = scene([{}, {}], { real: true }).mount(surface.appearanceSection)
  commit(view.field("appearance.radius"), "12")
  assert.deepEqual(
    view.elements.map((element) => element.style.getPropertyValue("border-radius")),
    ["12px", "12px"]
  )
  assert.equal(surface.history.canUndo(), true)
  surface.history.undo()
  assert.equal(surface.history.canUndo(), false, "the commit took more than one step")
  assert.deepEqual(
    view.elements.map((element) => element.style.getPropertyValue("border-radius")),
    ["", ""]
  )
})

/* ---------- Mixed ---------- */

console.log("\nMixed values")

await check("W and H read Mixed when the layers differ, and a shared size when they agree", () => {
  const view = scene([{ rect: { width: 120, height: 80 } }, { rect: { width: 200, height: 80 } }])
  view.mount(surface.unifiedLayoutSection)
  isMixed(view.field("size.width"))
  assert.equal(view.field("size.height").value, "80")
  commit(view.field("size.width"), "150")
  const [batch] = view.batches()
  assert.deepEqual(targets(batch), ["0", "1"])
  assert.deepEqual(batch.edits[1].writes, [{ property: "width", value: "150px" }])
})

await check("opacity, corner radius and each corner read Mixed, and typing writes all", () => {
  surface.setExpanded(surface.RADIUS_EXPANDER, false)
  const corners = (value) => ({
    borderTopLeftRadius: value,
    borderTopRightRadius: value,
    borderBottomLeftRadius: value,
    borderBottomRightRadius: value,
  })
  const view = scene([
    { style: { opacity: "1", ...corners("4px") } },
    { style: { opacity: "0.5", ...corners("8px") } },
  ]).mount(surface.appearanceSection)
  isMixed(view.field("appearance.opacity"))
  isMixed(view.field("appearance.radius"))
  commit(view.field("appearance.radius"), "6")
  const [batch] = view.batches()
  assert.deepEqual(targets(batch), ["0", "1"])
  assert.deepEqual(batch.edits[0].writes, [{ property: "border-radius", value: "6px" }])

  surface.setExpanded(surface.RADIUS_EXPANDER, true)
  view.rebuild()
  for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    isMixed(view.field(`appearance.radius.${corner}`))
  }
  surface.setExpanded(surface.RADIUS_EXPANDER, false)
})

await check("gap and padding read Mixed when every layer lays out its children", () => {
  const flex = (gap, padding) => ({
    display: "flex",
    flexDirection: "row",
    columnGap: gap,
    rowGap: gap,
    justifyContent: "flex-start",
    alignItems: "flex-start",
    paddingLeft: padding,
    paddingRight: padding,
    paddingTop: "4px",
    paddingBottom: "4px",
  })
  const view = scene([
    { children: 2, style: flex("8px", "10px") },
    { children: 2, style: flex("16px", "12px") },
  ]).mount(surface.unifiedLayoutSection)
  isMixed(view.field("autolayout.gap"))
  isMixed(view.field("autolayout.padding-x"))
  assert.equal(view.field("autolayout.padding-y").value, "4")
  commit(view.field("autolayout.gap"), "20")
  const [batch] = view.batches()
  assert.deepEqual(targets(batch), ["0", "1"])
  assert.deepEqual(batch.edits[1].writes, [{ property: "gap", value: "20px" }])
})

await check("auto layout rows hide when one selected layer does not lay out children", () => {
  const view = scene([
    { children: 2, style: { display: "flex", columnGap: "8px" } },
    { children: 0 },
  ]).mount(surface.unifiedLayoutSection)
  assert.equal(view.field("autolayout.gap"), null)
})

await check("font family, weight, size, line height, letter spacing and alignment read Mixed", () => {
  const view = scene([
    {
      text: "Heading",
      style: { fontFamily: "Inter", fontWeight: "700", fontSize: "24px", lineHeight: "32px", letterSpacing: "0px", textAlign: "left" },
    },
    {
      text: "Body",
      style: { fontFamily: "Roboto", fontWeight: "400", fontSize: "14px", lineHeight: "20px", letterSpacing: "0.5px", textAlign: "center" },
    },
  ]).mount(surface.typographySection)
  isMixed(view.field("type.family"))
  isMixed(view.field("type.size"))
  isMixed(view.field("type.lineheight"))
  isMixed(view.field("type.letterspacing"))
  const weight = view.field("type.weight")
  assert.equal(weight.selectedOptions[0].textContent, "Mixed")
  assert.equal(weight.value, "")
  assert.deepEqual(pressed(view.host.querySelector('[aria-label="Text alignment"]')), [])

  commit(view.field("type.size"), "18")
  const [batch] = view.batches()
  assert.deepEqual(targets(batch), ["0", "1"])
  assert.deepEqual(batch.edits[0].writes, [{ property: "font-size", value: "18px" }])
})

await check("Typography stays away when one selected layer has no text of its own", () => {
  const view = scene([{ text: "Heading" }, { children: 1 }]).mount(surface.typographySection)
  assert.equal(view.host.childElementCount, 0)
})

await check("stroke weight and style read Mixed when the strokes share a colour", () => {
  const border = (width, style) => ({
    borderTopWidth: width,
    borderRightWidth: width,
    borderBottomWidth: width,
    borderLeftWidth: width,
    borderTopStyle: style,
    borderTopColor: "rgb(0, 0, 0)",
  })
  const view = scene([{ style: border("1px", "solid") }, { style: border("3px", "dashed") }])
  view.mount(surface.strokeSection)
  isMixed(view.field("stroke.width"))
  const style = view.field("stroke.style")
  assert.equal(style.selectedOptions[0].textContent, "Mixed")
  commit(view.field("stroke.width"), "2")
  const [batch] = view.batches()
  assert.deepEqual(targets(batch), ["0", "1"])
  assert.deepEqual(batch.edits[1].writes, [{ property: "border-width", value: "2px" }])
})

/* ---------- paints ---------- */

console.log("\nMixed paints")

await check("different fills show Figma's hint, and + writes one fill to every layer", () => {
  const view = scene([
    { style: { backgroundColor: "rgb(74, 92, 250)" } },
    { style: { backgroundColor: "rgb(217, 217, 217)" } },
  ]).mount(surface.fillSection)
  assert.equal(view.host.querySelector("[data-de-mixed]")?.textContent, "Click + to replace mixed content")
  assert.equal(view.label("Fill color"), null, "a paint row was drawn for mixed fills")
  const add = view.label("Add fill")
  assert.ok(add && !add.hasAttribute("disabled"), "+ is not live")
  click(add)
  const [batch] = view.batches()
  assert.deepEqual(targets(batch), ["0", "1"])
  assert.deepEqual(batch.edits[0].writes, [{ property: "background-color", value: "#d9d9d9" }])
})

await check("matching fills show the normal row, and its edits reach every layer", () => {
  const view = scene([
    { style: { backgroundColor: "rgb(74, 92, 250)" } },
    { style: { backgroundColor: "rgb(74, 92, 250)" } },
  ]).mount(surface.fillSection)
  assert.equal(view.host.querySelector("[data-de-mixed]"), null)
  const hex = view.field("fill.hex")
  assert.ok(hex, "no fill row")
  hex.value = "FF0000"
  hex.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  hex.dispatchEvent(new window.Event("change", { bubbles: true }))
  const [batch] = view.batches()
  assert.ok(batch, "the hex edit wrote nothing")
  assert.deepEqual(targets(batch), ["0", "1"])
  assert.equal(batch.edits[1].writes[0].property, "background-color")
})

await check("different strokes show the hint, and + strokes every layer", () => {
  const view = scene([
    {
      style: {
        borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
        borderTopStyle: "solid", borderTopColor: "rgb(255, 0, 0)",
      },
    },
    {},
  ]).mount(surface.strokeSection)
  assert.equal(view.host.querySelector("[data-de-mixed]")?.textContent, "Click + to replace mixed content")
  click(view.label("Add stroke"))
  const [batch] = view.batches()
  assert.deepEqual(targets(batch), ["0", "1"])
  const written = Object.fromEntries(batch.edits[1].writes.map((w) => [w.property, w.value]))
  assert.equal(written["border-width"], "1px")
  assert.equal(written["border-style"], "solid", "a layer with no stroke style would stay invisible")
})

await check("different effects show the hint, and + gives every layer one shadow", () => {
  const view = scene([{ style: { boxShadow: "rgba(0, 0, 0, 0.2) 0px 2px 4px 0px" } }, {}])
  view.mount(surface.effectsSection)
  assert.ok(view.host.querySelector("[data-de-mixed]"))
  click(view.label("Add effect"))
  const [batch] = view.batches()
  assert.deepEqual(targets(batch), ["0", "1"])
  assert.equal(batch.edits[0].writes[0].property, "box-shadow")
})

/* ---------- primary-only and single selection ---------- */

console.log("\nPrimary only, and one layer")

await check("Classes names the primary layer it shows", () => {
  const view = scene([{}, {}])
  view.elements[0].className = "p-2"
  view.mount(surface.classesSection)
  assert.equal(view.host.querySelector("[data-de-primary]")?.textContent, "First of 2 selected: div in Card")
})

await check("one selected layer reads its own values and writes through applyStyles", () => {
  surface.setExpanded(surface.RADIUS_EXPANDER, false)
  const view = scene([
    { style: { opacity: "0.5", borderTopLeftRadius: "4px", borderTopRightRadius: "4px", borderBottomLeftRadius: "4px", borderBottomRightRadius: "4px" } },
  ])
  view.context.selections = undefined
  view.mount(surface.appearanceSection)
  assert.equal(view.field("appearance.opacity").value, "50")
  assert.equal(view.field("appearance.radius").value, "4")
  commit(view.field("appearance.radius"), "9")
  assert.deepEqual(view.calls.map((call) => call.kind), ["styles"])
  assert.equal(view.label("Text alignment"), null)
  assert.equal(view.host.querySelector("[data-de-primary]"), null)

  const fill = scene([{ style: { backgroundColor: "rgb(1, 2, 3)" } }])
  fill.context.selections = undefined
  fill.mount(surface.fillSection)
  assert.equal(fill.host.querySelector("[data-de-mixed]"), null)
  assert.ok(fill.field("fill.hex"))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
