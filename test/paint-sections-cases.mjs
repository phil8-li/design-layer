/**
 * Fill, Stroke and Effects, laid out as Figma's Design panel.
 *
 * Each section is driven on its own with a hand-built context and a recording
 * writer, so a case checks both what the section draws and what it writes.
 * Covers: empty sections as a bare header and `+`, the text colour as a fill
 * row, the joined colour + opacity well, individual strokes, and an effect's
 * settings opening under its row.
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

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true })
const { window } = dom
for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement",
  "HTMLSelectElement", "SVGElement", "SVGSVGElement", "Event", "MouseEvent", "KeyboardEvent",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
]) {
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
      export { fillSection } from "./src/panels/inspector/section-fill"
      export { strokeSection } from "./src/panels/inspector/section-stroke"
      export { effectsSection } from "./src/panels/inspector/section-effects"
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

let serial = 0

/**
 * Renders one section over a fresh element. `invalidate` re-renders, as the
 * real inspector does after every write, so a toggle's next state is visible.
 */
function mount(section, markup) {
  const host = window.document.createElement("div")
  host.innerHTML = markup
  window.document.body.append(host)
  const element = host.firstElementChild
  serial += 1
  const writes = []
  const state = { node: null }
  const context = {
    editor: {
      apiBase: "http://127.0.0.1:0/api",
      toast() {},
      getState: surface.getState,
      setState: surface.setState,
    },
    writer: {
      applyStyles: (_, list, summary) => {
        writes.push({ list, summary })
        for (const { property, value } of list) element.style.setProperty(property, value)
      },
      applyClasses: (_, change, summary) => writes.push({ change, summary }),
    },
    selection: { key: `paint:${serial}`, element, componentName: "Card", tagName: element.tagName.toLowerCase(), source: null },
    get computed() {
      return window.getComputedStyle(element)
    },
    invalidate() {
      const next = surface[section](context)
      state.node?.replaceWith(next)
      state.node = next
    },
  }
  state.node = surface[section](context)
  host.append(state.node)
  return { get node() { return state.node }, writes, element }
}

const byLabel = (node, label) => node.querySelector(`[aria-label="${label}"]`)
const click = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
const enter = (input, value) => {
  input.value = value
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
}

console.log("\nEmpty paint sections are a header and a +")

check("a bare box draws Fill, Stroke and Effects as header-only sections", () => {
  for (const [section, title, add] of [
    ["fillSection", "Fill", "Add fill"],
    ["strokeSection", "Stroke", "Add stroke"],
    ["effectsSection", "Effects", "Add effect"],
  ]) {
    const { node } = mount(section, "<div></div>")
    assert.equal(node.getAttribute("data-de-empty"), "true", `${title} is not drawn empty`)
    assert.equal(node.querySelector(".de-section-title").textContent, title)
    assert.equal(node.querySelector(".de-section-body"), null, `${title} kept a body`)
    assert.ok(byLabel(node, add), `${title} has no ${add}`)
    assert.doesNotMatch(node.textContent, /No (fill|stroke|effects)/, `${title} still prints a "No …" sentence`)
  }
})

check("the + on an empty Fill writes a background and the next render shows its row", () => {
  const view = mount("fillSection", "<div></div>")
  click(byLabel(view.node, "Add fill"))
  assert.equal(view.writes[0].list[0].property, "background-color")
  assert.ok(byLabel(view.node, "Fill color opacity (%)"), "no paint row after Add fill")
})

console.log("\nText colour is the text layer's fill")

check("a text element with no background shows its colour as the Fill row", () => {
  const view = mount("fillSection", '<p style="color:#101418">Hello</p>')
  assert.notEqual(view.node.getAttribute("data-de-empty"), "true", "a text layer read as an empty Fill")
  const hex = view.node.querySelector('[data-de-field="type.color"]')
  assert.equal(hex.getAttribute("aria-label"), "Text color")
  assert.equal(hex.value, "101418")
  assert.ok(byLabel(view.node, "Text color").matches('input[type="color"], input[type="text"]'))
  enter(hex, "ff0000")
  assert.deepEqual(view.writes.at(-1).list, [{ property: "color", value: "#ff0000" }])
})

check("background first, text colour under it, when the element paints both", () => {
  const { node } = mount("fillSection", '<div style="background-color:#ffffff;color:#101418">Hi</div>')
  const rows = [...node.querySelectorAll(".de-paint-row")]
  assert.equal(rows.length, 2)
  assert.ok(rows[0].querySelector('[aria-label="Fill color"]'), "the background is not first")
  assert.ok(rows[1].querySelector('[aria-label="Text color"]'), "the text colour is not second")
})

check("the text colour's opacity writes the colour's alpha", () => {
  const view = mount("fillSection", '<p style="color:#101418">Hello</p>')
  enter(byLabel(view.node, "Text color opacity (%)"), "50")
  assert.deepEqual(view.writes.at(-1).list, [{ property: "color", value: "rgba(16,20,24,0.5)" }])
})

console.log("\nThe paint row is Figma's")

check("the fill well is swatch, hex and opacity with no letter, then the eye, then −", () => {
  const { node } = mount("fillSection", '<div style="background-color:#ffffff"></div>')
  const row = node.querySelector(".de-prow")
  const opacity = byLabel(row, "Fill color opacity (%)").closest(".de-field")
  assert.equal(opacity.querySelector(".de-field-label").textContent, "", "the opacity field still prints a letter")
  assert.equal(opacity.querySelector(".de-field-suffix").textContent, "%")
  assert.ok(row.querySelector(".de-paint-row > [aria-label='Hide fill color']"), "the eye is not beside the well")
  assert.ok(row.querySelector(".de-prow-trail > [aria-label='Remove fill']"), "the − is not in column 3")
})

check("the eye parks the fill and brings it back", () => {
  const view = mount("fillSection", '<div style="background-color:#336699"></div>')
  click(byLabel(view.node, "Hide fill color"))
  assert.deepEqual(view.writes.at(-1).list, [{ property: "background-color", value: "transparent" }])
  click(byLabel(view.node, "Show fill color"))
  assert.deepEqual(view.writes.at(-1).list, [{ property: "background-color", value: "#336699" }])
})

console.log("\nStroke: colour row, Style / Weight, individual strokes")

check("Style and Weight share one captioned row with Individual strokes in column 3", () => {
  const { node } = mount("strokeSection", '<div style="border:2px solid #123456"></div>')
  const row = node.querySelector('[data-de-row="stroke.style-weight"]')
  assert.deepEqual([...row.querySelectorAll(".de-prow-caption")].map((c) => c.textContent), ["Style", "Weight"])
  assert.equal(byLabel(row, "Stroke weight").value, "2")
  assert.ok(row.querySelector(".de-prow-trail [aria-label='Individual strokes']"))
  assert.ok(byLabel(node, "Stroke color opacity (%)"), "the stroke colour row has no opacity")
})

check("Individual strokes opens four side widths that write border-*-width", () => {
  const view = mount("strokeSection", '<div style="border:1px solid #123456"></div>')
  assert.equal(byLabel(view.node, "Stroke top"), null, "sides are open before the toggle")
  click(byLabel(view.node, "Individual strokes"))
  assert.equal(byLabel(view.node, "Individual strokes").getAttribute("aria-pressed"), "true")
  for (const side of ["top", "right", "bottom", "left"]) assert.ok(byLabel(view.node, `Stroke ${side}`), `${side} is missing`)
  enter(byLabel(view.node, "Stroke top"), "4")
  assert.deepEqual(view.writes.at(-1).list, [{ property: "border-top-width", value: "4px" }])
  assert.equal(byLabel(view.node, "Stroke weight").value, "", "differing sides should read Mixed")
  click(byLabel(view.node, "Individual strokes"))
})

check("the style select writes border-style", () => {
  const view = mount("strokeSection", '<div style="border:1px solid #123456"></div>')
  const select = byLabel(view.node, "Stroke style")
  select.value = "dashed"
  select.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.deepEqual(view.writes.at(-1).list, [{ property: "border-style", value: "dashed" }])
})

console.log("\nEffects: one row each, settings under it")

check("an effect is one row; its settings open under it and stay open", () => {
  const view = mount("effectsSection", '<div style="box-shadow:0px 2px 8px 0px rgba(0,0,0,0.15)"></div>')
  const row = view.node.querySelector('[data-de-row="effects.0"]')
  assert.ok(byLabel(row, "Effect type"), "no type select in the row")
  assert.ok(row.querySelector(".de-prow-trail [aria-label='Remove effect']"), "the − is not in column 3")
  assert.equal(byLabel(view.node, "Offset X"), null, "the settings are open before they are asked for")
  const settings = byLabel(view.node, "Effect settings")
  assert.equal(settings.getAttribute("aria-expanded"), "false")
  click(settings)
  assert.equal(byLabel(view.node, "Effect settings").getAttribute("aria-expanded"), "true")
  enter(byLabel(view.node, "Blur"), "12")
  assert.match(view.writes.at(-1).list[0].value, /0px 2px 12px 0px/)
  assert.ok(byLabel(view.node, "Offset X"), "the settings closed after a commit")
  click(byLabel(view.node, "Effect settings"))
  assert.equal(byLabel(view.node, "Offset X"), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
dom.window.close()
if (failed) process.exitCode = 1
