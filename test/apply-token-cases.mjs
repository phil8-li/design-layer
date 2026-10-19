/**
 * "Apply token" inside numeric fields — Figma's "Apply variable".
 *
 * A number field with a token axis carries a hexagon button at its end. It
 * opens the token picker's list under the field; a pick writes what the old
 * separate token row wrote; a bound field shows the token's name as a chip with
 * a detach action that writes the plain number back. The separate token rows
 * those fields replaced are gone, and the rows for axes with no field stay.
 *
 * Usage: node test/apply-token-cases.mjs
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

/* JSDOM computes no layout longhands, so each element's computed style is a fixture; inline wins. */
const fixtures = new WeakMap()
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const BASE = {
  display: "block", flexDirection: "row", flexWrap: "nowrap", opacity: "1",
  backgroundColor: "rgba(0, 0, 0, 0)", color: "rgb(0, 0, 0)", borderTopStyle: "none",
  boxShadow: "none", fontFamily: "Inter", fontSize: "16px", fontWeight: "400",
  lineHeight: "24px", letterSpacing: "0px", textAlign: "left", visibility: "visible",
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

const STOCKED = {
  name: "Fixture System",
  trackingUnit: "em",
  colors: [],
  spacing: [
    { id: "spacing:sm", name: "spacing/sm", category: "spacing", values: { default: 8 }, cssVar: "--fx-space-sm" },
    { id: "spacing:md", name: "spacing/md", category: "spacing", values: { default: 16 }, cssVar: "--fx-space-md" },
  ],
  radii: [
    { id: "radius:sm", name: "radius/sm", category: "radius", values: { default: 8 }, cssVar: "--fx-radius-sm" },
    { id: "radius:md", name: "radius/md", category: "radius", values: { default: 12 }, cssVar: "--fx-radius-md" },
  ],
  textStyles: [
    {
      id: "typography:body",
      name: "Body/Default",
      category: "typography",
      values: { default: { fontSize: 16, lineHeight: 24, fontWeight: 400, letterSpacing: 0 } },
      cssVars: { fontSize: "--fx-body-size", lineHeight: "--fx-body-leading" },
    },
  ],
  uiTextStyles: [],
  effects: [],
  icons: [],
  motion: [],
  breakpoints: [],
  containerBreakpoints: [],
  responsiveMeasures: [],
  aliases: { cssVariables: [], tailwind: [] },
}

/** One bundle per catalog: `config.ts` reads the global once at module load. */
async function load(fixture, designSystem) {
  globalThis.__DESIGNLAYER_CONFIG__ = { apiBase: "/__designlayer", designSystem, host: { framework: "react", tailwind: true } }
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `
        export const __fixture = ${JSON.stringify(fixture)}
        export { fanOutWriter } from "./src/panels/inspector/multi"
        export { appearanceSection, RADIUS_EXPANDER } from "./src/panels/inspector/section-appearance"
        export { typographySection } from "./src/panels/inspector/section-typography"
        export { unifiedLayoutSection } from "./src/panels/inspector/section-unified-layout"
        export { tokenRow } from "./src/panels/inspector/token-row"
        export { setExpanded } from "./src/panels/inspector/field"
        export { tokenPickerCss } from "./src/core/css/token-picker"
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
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
}

const surface = await load("stocked", STOCKED)

/** One layer per entry, all selected, the first primary, with a recording writer. */
function scene(lib, layers) {
  window.document.body.replaceChildren()
  const elements = layers.map((layer, index) => {
    const element = window.document.createElement(layer.tag ?? "div")
    if (layer.text) element.textContent = layer.text
    for (let i = 0; i < (layer.children ?? 0); i += 1) element.append(window.document.createElement("span"))
    if (layer.inline) element.setAttribute("style", layer.inline)
    fixtures.set(element, layer.style ?? {})
    element.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 50, width: 100, height: 50 })
    element.dataset.index = String(index)
    window.document.body.append(element)
    return element
  })
  const selections = elements.map((element, index) => ({
    element, tagName: element.tagName.toLowerCase(), componentName: index === 0 ? "Card" : "", source: null, key: `apply-${index}-${Math.random()}`,
  }))
  const calls = []
  const stub = {
    applyStyles: (selection, writes, summary) => calls.push({ kind: "styles", selection, writes, summary }),
    applyStylesBatch: (edits, summary) => calls.push({ kind: "batch", edits, summary }),
    applyClasses: (selection, write, summary) => calls.push({ kind: "classes", selection, write, summary }),
  }
  const bridge = { elementInfo: () => null, send: () => {}, subscribe: () => () => {}, toast: () => {}, store: { addPendingPropertyOperation: () => {} } }
  const host = window.document.createElement("div")
  window.document.body.append(host)
  const context = {
    editor: { apiBase: "http://127.0.0.1:0/api", bridge, toast() {}, getState: () => ({ ...lib.getState(), selection: selections }), setState: lib.setState },
    writer: lib.fanOutWriter(stub, selections),
    selection: selections[0],
    selections,
    computed: getComputedStyle(elements[0]),
    invalidate: () => {},
  }
  return {
    elements, selections, calls, context, host,
    mount(section) {
      host.replaceChildren()
      const node = section(context)
      if (node) host.append(node)
      return this
    },
    apply: (id) => host.querySelector(`[data-de-field="design-system.${id}"]`),
  }
}

const click = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
const key = (name) => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true }))
const popover = () => window.document.querySelector(".de-token-popover")
const pick = (id) => click(popover().querySelector(`[data-de-choice="${id}"]`))
const closePicker = () => { if (popover()) key("Escape") }

const ROUNDED = { borderTopLeftRadius: "12px", borderTopRightRadius: "12px", borderBottomRightRadius: "12px", borderBottomLeftRadius: "12px" }
const FLEX = { display: "flex", columnGap: "16px", rowGap: "16px", paddingTop: "16px", paddingRight: "16px", paddingBottom: "16px", paddingLeft: "16px", justifyContent: "flex-start", alignItems: "flex-start" }

/* ---------- the affordance ---------- */

console.log("\nThe hexagon")

await check("a radius field ends in an Apply token button that names the property", () => {
  const view = scene(surface, [{ style: ROUNDED }]).mount(surface.appearanceSection)
  const field = view.host.querySelector('[data-de-field="appearance.radius"]').closest(".de-field")
  const button = view.apply("corner-radius")
  assert.ok(button, "no token button")
  assert.equal(button.closest(".de-field"), field, "the button is not inside the radius field")
  assert.equal(field.lastElementChild, button, "the button is not at the field's end")
  assert.equal(button.getAttribute("aria-label"), "Apply token")
  assert.equal(button.getAttribute("title"), "Apply token to corner radius")
  assert.equal(button.getAttribute("aria-haspopup"), "listbox")
  assert.notEqual(button.getAttribute("tabindex"), "-1", "the button must stay in the tab order")
  assert.ok(button.querySelector("svg"), "the button draws no glyph")
})

await check("it shows on hover and keyboard focus, and always when bound", () => {
  const css = surface.tokenPickerCss.replace(/\s+/g, " ")
  assert.match(css, /\.de-tokenbind-apply \{[^}]*opacity: 0;/, "the button is not hidden at rest")
  for (const selector of [
    ".de-tokenbind:hover .de-tokenbind-apply",
    ".de-tokenbind:focus-within .de-tokenbind-apply",
    ".de-tokenbind--bound .de-tokenbind-apply",
  ]) {
    const at = css.indexOf(selector)
    assert.ok(at >= 0, `no rule for ${selector}`)
    assert.match(css.slice(at, css.indexOf("}", at)), /opacity: 1/, `${selector} does not show the button`)
  }
})

await check("a field with no token axis draws no token button", () => {
  const view = scene(surface, [{ style: { opacity: "1" } }]).mount(surface.appearanceSection)
  assert.equal(view.host.querySelector('[data-de-field="appearance.opacity"]').closest(".de-field").querySelector(".de-tokenbind-apply"), null)
})

/* ---------- picking ---------- */

console.log("\nPicking a token")

await check("the button opens the list of radius tokens, aligned to the field", () => {
  const view = scene(surface, [{ style: ROUNDED }]).mount(surface.appearanceSection)
  const button = view.apply("corner-radius")
  const field = button.closest(".de-field")
  field.getBoundingClientRect = () => ({ left: 100, right: 200, top: 40, bottom: 64, width: 100, height: 24 })
  click(button)
  assert.ok(popover(), "no picker opened")
  assert.equal(button.getAttribute("aria-expanded"), "true")
  assert.deepEqual([...popover().querySelectorAll('[role="option"]')].map((row) => row.getAttribute("data-de-choice")), ["radius:sm", "radius:md"])
  assert.equal(popover().style.left, "100px", "the list does not start at the field's left edge")
  assert.equal(popover().style.top, "68px", "the list is not under the field")
  closePicker()
  // A field near the window's right edge ends the list flush with its right edge.
  field.getBoundingClientRect = () => ({ left: 900, right: 1000, top: 40, bottom: 64, width: 100, height: 24 })
  click(button)
  assert.equal(popover().style.left, `${1000 - 264}px`)
  click(button)
  assert.equal(popover(), null, "pressing the button again does not close the list")
})

await check("a pick writes the same declarations the old token row wrote", () => {
  const view = scene(surface, [{ style: ROUNDED }]).mount(surface.appearanceSection)
  click(view.apply("corner-radius"))
  pick("radius:md")
  assert.equal(popover(), null, "the picker stayed open after the pick")
  const fromField = view.calls.at(-1)

  // The old separate control, mounted on its own against the same element.
  view.host.replaceChildren(surface.tokenRow(view.context, "corner-radius", "Corner radius"))
  click(view.host.querySelector(".de-token-field"))
  pick("radius:md")
  const fromRow = view.calls.at(-1)
  assert.deepEqual(fromField.writes, fromRow.writes)
  assert.equal(fromField.summary, fromRow.summary)
  assert.deepEqual(fromField.writes, [{ property: "border-radius", value: "var(--fx-radius-md, 12px)" }])
})

await check("the keyboard walks and commits the list, and Escape returns focus to the button", () => {
  const view = scene(surface, [{ style: ROUNDED }]).mount(surface.appearanceSection)
  const button = view.apply("corner-radius")
  click(button)
  key("Escape")
  assert.equal(popover(), null)
  assert.equal(window.document.activeElement, button, "focus did not come back to the token button")
  click(button)
  key("ArrowDown")
  key("Enter")
  assert.deepEqual(view.calls.at(-1).writes, [{ property: "border-radius", value: "var(--fx-radius-md, 12px)" }])
})

await check("a corner field binds its own corner", () => {
  surface.setExpanded(surface.RADIUS_EXPANDER, true)
  try {
    const view = scene(surface, [{ style: ROUNDED }]).mount(surface.appearanceSection)
    const button = view.apply("corner-radius-top-left")
    assert.ok(button.closest(".de-field").querySelector('[data-de-field="appearance.radius.top-left"]'))
    assert.equal(button.getAttribute("title"), "Apply token to top left radius")
    click(button)
    pick("radius:sm")
    assert.deepEqual(view.calls.at(-1).writes, [{ property: "border-top-left-radius", value: "var(--fx-radius-sm, 8px)" }])
  } finally {
    surface.setExpanded(surface.RADIUS_EXPANDER, false)
  }
})

await check("horizontal padding binds both of its sides at once", () => {
  const view = scene(surface, [{ children: 2, style: FLEX }]).mount(surface.unifiedLayoutSection)
  const button = view.apply("padding-x")
  assert.ok(button.closest(".de-field").querySelector('[data-de-field="autolayout.padding-x"]'))
  click(button)
  pick("spacing:md")
  assert.deepEqual(view.calls.at(-1).writes, [
    { property: "padding-left", value: "var(--fx-space-md, 16px)" },
    { property: "padding-right", value: "var(--fx-space-md, 16px)" },
  ])
})

await check("the gap menu offers Apply token…, which opens the same list", () => {
  const view = scene(surface, [{ children: 2, style: FLEX }]).mount(surface.unifiedLayoutSection)
  const select = view.host.querySelector('select[aria-label="Gap options"]')
  const item = [...select.options].find((option) => option.value === "token")
  assert.ok(item, "the gap menu has no token entry")
  assert.equal(item.textContent, "Apply token…")
  select.value = "token"
  select.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.equal(select.value, "fixed", "the menu kept showing the action after it ran")
  assert.ok(popover(), "the menu entry opened no list")
  pick("spacing:sm")
  assert.deepEqual(view.calls.at(-1).writes, [{ property: "gap", value: "var(--fx-space-sm, 8px)" }])
})

/* ---------- bound ---------- */

console.log("\nA bound field")

const BOUND = "border-radius:var(--fx-radius-md)"

await check("shows the token's name as a chip in place of the number", () => {
  const view = scene(surface, [{ inline: BOUND, style: ROUNDED }]).mount(surface.appearanceSection)
  const button = view.apply("corner-radius")
  const field = button.closest(".de-field")
  assert.ok(field.classList.contains("de-tokenbind--bound"))
  assert.equal(field.querySelector("input"), null, "the number is still drawn")
  assert.equal(field.querySelector(".de-tokenbind-name").textContent, "Radius/md")
  assert.equal(field.querySelector(".de-tokenbind-chip").getAttribute("title"), "Corner radius: Radius/md")
  assert.equal(button.getAttribute("aria-pressed"), "true")
  assert.equal(button.getAttribute("title"), "Change corner radius token")
  click(button)
  assert.equal(popover().querySelector('[aria-selected="true"]').getAttribute("data-de-choice"), "radius:md")
  closePicker()
})

await check("Detach token writes the plain number back", () => {
  const view = scene(surface, [{ inline: BOUND, style: ROUNDED }]).mount(surface.appearanceSection)
  const detach = view.host.querySelector('[aria-label="Detach token"]')
  assert.ok(detach, "no detach action")
  assert.equal(detach.getAttribute("title"), "Detach token from corner radius")
  click(detach)
  assert.deepEqual(view.calls.at(-1).writes, [{ property: "border-radius", value: "12px" }])
})

await check("a value that only equals a token is not drawn as bound", () => {
  const view = scene(surface, [{ style: ROUNDED }]).mount(surface.appearanceSection)
  assert.equal(view.host.querySelector(".de-tokenbind--bound"), null)
  assert.equal(view.host.querySelector('[data-de-field="appearance.radius"]').value, "12")
})

/* ---------- rows ---------- */

console.log("\nThe separate token rows")

await check("Appearance draws no separate radius token row", () => {
  const view = scene(surface, [{ style: ROUNDED }]).mount(surface.appearanceSection)
  assert.equal(view.host.querySelector(".de-token-field"), null)
  surface.setExpanded(surface.RADIUS_EXPANDER, true)
  try {
    view.mount(surface.appearanceSection)
    assert.equal(view.host.querySelector(".de-token-field"), null, "the per-corner rows came back")
  } finally {
    surface.setExpanded(surface.RADIUS_EXPANDER, false)
  }
})

await check("an auto-layout box draws no gap or padding token row, and keeps margin", () => {
  const view = scene(surface, [{ children: 2, style: FLEX }]).mount(surface.unifiedLayoutSection)
  const rows = [...view.host.querySelectorAll(".de-token-field")].map((node) => node.getAttribute("data-de-field"))
  assert.deepEqual(rows, ["design-system.margin"])
  for (const id of ["gap", "padding-x", "padding-y"]) assert.ok(view.apply(id), `${id} has no field binding`)
})

await check("a box with no padding fields keeps its padding token row", () => {
  const view = scene(surface, [{ children: 1, style: { paddingTop: "8px" } }]).mount(surface.unifiedLayoutSection)
  const row = view.apply("padding")
  assert.ok(row, "the padding row went missing")
  assert.ok(row.classList.contains("de-token-field"))
})

await check("Typography keeps the text style token row", () => {
  const view = scene(surface, [{ tag: "p", text: "Hello" }]).mount(surface.typographySection)
  assert.ok(view.host.querySelector('.de-token-field[data-de-field="design-system.text-style"]'))
})

/* ---------- multi-selection ---------- */

console.log("\nMulti-selection")

await check("a pick reaches every selected layer as one batch", () => {
  const view = scene(surface, [{ style: ROUNDED }, { style: ROUNDED }, { style: ROUNDED }]).mount(surface.appearanceSection)
  click(view.apply("corner-radius"))
  pick("radius:sm")
  const call = view.calls.at(-1)
  assert.equal(call.kind, "batch")
  assert.deepEqual(call.edits.map((edit) => edit.selection.element.dataset.index), ["0", "1", "2"])
  for (const edit of call.edits) assert.deepEqual(edit.writes, [{ property: "border-radius", value: "var(--fx-radius-sm, 8px)" }])
})

await check("the chip shows only when every selected layer is bound to the same token", () => {
  const same = scene(surface, [{ inline: BOUND, style: ROUNDED }, { inline: BOUND, style: ROUNDED }]).mount(surface.appearanceSection)
  assert.ok(same.host.querySelector(".de-tokenbind--bound"))
  const mixed = scene(surface, [{ inline: BOUND, style: ROUNDED }, { style: ROUNDED }]).mount(surface.appearanceSection)
  assert.equal(mixed.host.querySelector(".de-tokenbind--bound"), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
