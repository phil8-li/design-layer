/**
 * The Appearance and Typography sections, laid out the way Figma's Design
 * panel lays them out, and every control writing the property it claims to.
 *
 * Each section is driven on its own over a JSDOM element, with a writer that
 * records what it was asked to write. `invalidate` rebuilds the section, the
 * way the inspector does after every commit, so toggles are tested through the
 * same panel-level memory the real panel uses.
 *
 * Usage: node test/appearance-typography-cases.mjs
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
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom
for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement",
  "HTMLSelectElement", "HTMLOptionElement", "SVGElement", "SVGSVGElement", "Event", "KeyboardEvent",
  "MouseEvent", "PointerEvent", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "CSS",
]) {
  if (!(key in window)) continue
  Object.defineProperty(globalThis, key, {
    value: key === "getComputedStyle" ? window.getComputedStyle.bind(window) : window[key],
    configurable: true,
    writable: true,
  })
}
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { appearanceSection, BLEND_MODES, RADIUS_EXPANDER } from "./src/panels/inspector/section-appearance"
      export { typographySection, TYPE_SETTINGS_EXPANDER } from "./src/panels/inspector/section-typography"
      export { setExpanded, isExpanded } from "./src/panels/inspector/field"
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

/**
 * Mounts one section over a fresh element. `computed` overrides values JSDOM
 * does not compute (blend mode, decoration), read before the real style.
 */
function mount(section, { tag = "div", style = "", text = "", computed = {} } = {}) {
  const element = window.document.createElement(tag)
  element.setAttribute("style", style)
  element.textContent = text
  window.document.body.append(element)
  const writes = []
  const host = window.document.createElement("div")
  window.document.body.append(host)
  const real = window.getComputedStyle(element)
  const view = new Proxy(real, {
    get(target, property) {
      if (property in computed) return computed[property]
      const value = target[property]
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const context = {
    editor: {
      apiBase: "http://127.0.0.1:0/api",
      toast() {},
      getState: surface.getState,
      setState: surface.setState,
    },
    writer: {
      applyStyles: (_selection, list) => writes.push(...list.map((w) => [w.property, w.value])),
    },
    selection: { key: `cases:${Math.random()}`, element, componentName: "Fixture", tagName: tag, source: null },
    computed: view,
    invalidate: () => render(),
  }
  const render = () => {
    host.replaceChildren()
    const node = section(context)
    if (node) host.append(node)
  }
  render()
  return { host, writes, element }
}

const click = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
const commitField = (input, value) => {
  input.value = value
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
}
const captions = (row) => [...row.querySelectorAll(".de-prow-caption")].map((n) => n.textContent)
const fieldIds = (row) => [...row.querySelectorAll("[data-de-field]")].map((n) => n.getAttribute("data-de-field"))
const label = (host, name) => host.querySelector(`[aria-label="${name}"]`)

console.log("\nAppearance")

await check("header carries the styles toggle, the eye and the blend menu", () => {
  const { host } = mount(surface.appearanceSection)
  const actions = host.querySelector(".de-section-actions")
  assert.ok(actions.querySelector(".de-style-toggle"), "the styles toggle went missing")
  assert.ok(actions.querySelector('[aria-label="Hide"]'), "no Hide eye")
  assert.ok(actions.querySelector('select[aria-label="Blend mode"]'), "no blend mode menu")
})

await check("opacity and corner radius share one row, with Individual corners in column 3", () => {
  surface.setExpanded(surface.RADIUS_EXPANDER, false)
  const { host } = mount(surface.appearanceSection, {
    style: "opacity:0.5;border-top-left-radius:4px;border-top-right-radius:12px;" +
      "border-bottom-right-radius:20px;border-bottom-left-radius:0px",
  })
  const row = host.querySelector('[data-de-row="appearance.main"]')
  assert.deepEqual(captions(row), ["Opacity", "Corner radius"])
  assert.deepEqual(fieldIds(row).slice(0, 2), ["appearance.opacity", "appearance.radius"])
  assert.equal(row.querySelector('[data-de-field="appearance.opacity"]').value, "50")
  const radius = row.querySelector('[data-de-field="appearance.radius"]')
  assert.equal(radius.value, "")
  assert.equal(radius.placeholder, "Mixed")
  const toggle = row.querySelector('.de-prow-trail [aria-label="Individual corners"]')
  assert.ok(toggle, "Individual corners is not in the trailing column")
  assert.equal(toggle.getAttribute("aria-pressed"), "false")
  assert.equal(host.querySelector('[data-de-field="appearance.radius.top-left"]'), null)
})

await check("individual corners opens TL TR / BL BR rows that write their own corner", () => {
  surface.setExpanded(surface.RADIUS_EXPANDER, false)
  const { host, writes } = mount(surface.appearanceSection, { style: "border-radius:8px" })
  click(label(host, "Individual corners"))
  assert.equal(surface.isExpanded(surface.RADIUS_EXPANDER), true)
  assert.equal(label(host, "Individual corners").getAttribute("aria-pressed"), "true")
  const top = host.querySelector('[data-de-row="appearance.corners-top"]')
  const bottom = host.querySelector('[data-de-row="appearance.corners-bottom"]')
  assert.deepEqual(fieldIds(top), ["appearance.radius.top-left", "appearance.radius.top-right"])
  assert.deepEqual(fieldIds(bottom), ["appearance.radius.bottom-left", "appearance.radius.bottom-right"])
  assert.equal(captions(top).length, 0, "a follow-up row grew a caption")
  commitField(top.querySelector('[data-de-field="appearance.radius.top-right"]'), "6")
  assert.deepEqual(writes.at(-1), ["border-top-right-radius", "6px"])
  surface.setExpanded(surface.RADIUS_EXPANDER, false)
})

await check("the uniform radius writes border-radius", () => {
  surface.setExpanded(surface.RADIUS_EXPANDER, false)
  const { host, writes } = mount(surface.appearanceSection)
  commitField(host.querySelector('[data-de-field="appearance.radius"]'), "12")
  assert.deepEqual(writes.at(-1), ["border-radius", "12px"])
})

await check("the eye writes visibility, never display", () => {
  const shown = mount(surface.appearanceSection)
  click(label(shown.host, "Hide"))
  assert.deepEqual(shown.writes.at(-1), ["visibility", "hidden"])
  const hidden = mount(surface.appearanceSection, { style: "visibility:hidden" })
  click(label(hidden.host, "Show"))
  assert.deepEqual(hidden.writes.at(-1), ["visibility", "visible"])
  assert.equal([...shown.writes, ...hidden.writes].some(([p]) => p === "display"), false)
})

await check("the blend menu lists CSS blend modes and writes mix-blend-mode", () => {
  const { host, writes } = mount(surface.appearanceSection, { computed: { mixBlendMode: "screen" } })
  const select = host.querySelector('select[aria-label="Blend mode"]')
  const names = [...select.options].map((o) => o.textContent)
  assert.equal(names[0], "Normal")
  assert.equal(names.includes("Pass through"), false, "Pass through has no CSS twin")
  assert.equal(names.length, 18)
  assert.equal(select.value, "screen")
  select.value = "multiply"
  select.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.deepEqual(writes.at(-1), ["mix-blend-mode", "multiply"])
})

console.log("\nTypography")

await check("rows run family, weight then size, line height and letter spacing, alignment", () => {
  const { host } = mount(surface.typographySection, { tag: "p", text: "Hello", style: "font-size:18px" })
  const rows = [...host.querySelectorAll(".de-prow[data-de-row]")].map((r) => r.getAttribute("data-de-row"))
  assert.deepEqual(rows.slice(0, 4), ["type.family", "type.weight-size", "type.spacing", "type.alignment"])
  const pair = host.querySelector('[data-de-row="type.weight-size"]')
  assert.deepEqual(fieldIds(pair), ["type.weight", "type.size"], "weight must come first, as in Figma")
  assert.deepEqual(captions(pair), [], "Figma captions no weight/size row")
  const spacing = host.querySelector('[data-de-row="type.spacing"]')
  assert.deepEqual(captions(spacing), ["Line height", "Letter spacing"])
  assert.equal(host.querySelector('[data-de-field="type.lineheight"]').placeholder, "Auto")
})

await check("text color is not in Typography", () => {
  const { host } = mount(surface.typographySection, { tag: "p", text: "Hello", style: "color:#123456" })
  assert.equal(host.querySelector('[data-de-field="type.color"]'), null)
  assert.equal(host.querySelector('input[type="color"]'), null)
  assert.equal([...host.querySelectorAll(".de-group-caption, .de-prow-caption")].some((n) => n.textContent === "Color"), false)
})

await check("the alignment triple has three cells and the type settings toggle sits in column 3", () => {
  surface.setExpanded(surface.TYPE_SETTINGS_EXPANDER, false)
  const { host } = mount(surface.typographySection, { tag: "p", text: "Hello" })
  const row = host.querySelector('[data-de-row="type.alignment"]')
  assert.deepEqual(captions(row), ["Alignment"])
  assert.equal(row.querySelectorAll('[aria-label="Text alignment"] button').length, 3)
  assert.equal(label(host, "Justify text"), null, "justify belongs behind type settings")
  const toggle = row.querySelector('.de-prow-trail [aria-label="Type settings"]')
  assert.ok(toggle)
  assert.equal(toggle.getAttribute("aria-pressed"), "false")
})

await check("type settings opens justify, decoration and case, each writing its property", () => {
  surface.setExpanded(surface.TYPE_SETTINGS_EXPANDER, false)
  const { host, writes } = mount(surface.typographySection, { tag: "p", text: "Hello" })
  click(label(host, "Type settings"))
  assert.equal(surface.isExpanded(surface.TYPE_SETTINGS_EXPANDER), true)
  assert.equal(label(host, "Type settings").getAttribute("aria-pressed"), "true")
  for (const id of ["type.justify", "type.decoration", "type.case"]) {
    assert.ok(host.querySelector(`[data-de-row="${id}"]`), `${id} is missing`)
  }
  click(label(host, "Justify text"))
  assert.deepEqual(writes.at(-1), ["text-align", "justify"])
  click(label(host, "Underline"))
  assert.deepEqual(writes.at(-1), ["text-decoration-line", "underline"])
  click(label(host, "Strikethrough"))
  assert.deepEqual(writes.at(-1), ["text-decoration-line", "line-through"])
  click(label(host, "Uppercase"))
  assert.deepEqual(writes.at(-1), ["text-transform", "uppercase"])
  surface.setExpanded(surface.TYPE_SETTINGS_EXPANDER, false)
})

await check("type settings reads the current decoration and case back", () => {
  surface.setExpanded(surface.TYPE_SETTINGS_EXPANDER, true)
  const { host } = mount(surface.typographySection, {
    tag: "p",
    text: "Hello",
    computed: { textDecorationLine: "underline", textTransform: "capitalize" },
  })
  assert.equal(label(host, "Underline").getAttribute("aria-pressed"), "true")
  assert.equal(label(host, "Capitalize").getAttribute("aria-pressed"), "true")
  surface.setExpanded(surface.TYPE_SETTINGS_EXPANDER, false)
})

await check("weight and size write font-weight and font-size", () => {
  const { host, writes } = mount(surface.typographySection, { tag: "p", text: "Hello" })
  const weight = host.querySelector('[data-de-field="type.weight"]')
  assert.equal([...weight.options].find((o) => o.value === "600").textContent, "Semi Bold")
  weight.value = "700"
  weight.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.deepEqual(writes.at(-1), ["font-weight", "700"])
  commitField(host.querySelector('[data-de-field="type.size"]'), "20")
  assert.deepEqual(writes.at(-1), ["font-size", "20px"])
})

await check("a wrapper whose text lives in a child gets no Typography", () => {
  const element = mount(surface.typographySection, { tag: "div" })
  assert.equal(element.host.children.length, 0)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
