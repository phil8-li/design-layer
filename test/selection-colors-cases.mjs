/**
 * Selection colors: every colour the selection and its children paint, as
 * Figma's section after Effects.
 *
 * Driven on its own with a hand-built context and a recording writer. Covers:
 * grouping by colour and property, the show/hide thresholds, one batch per
 * edit across every element and property, the select-layers action, the fold
 * default and the folded header's chits, and the token swap.
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

const COLORS = {
  name: "Fixture System",
  trackingUnit: "em",
  colors: [
    { id: "color:surface", name: "Surface/Base", category: "color", values: { default: "#ffffff" }, cssVar: "--fx-surface-base" },
    { id: "color:ink", name: "Text/Primary", category: "color", values: { default: "#101418" }, cssVar: "--fx-text-primary" },
  ],
  spacing: [], radii: [], textStyles: [], uiTextStyles: [], effects: [], icons: [], motion: [],
  breakpoints: [], containerBreakpoints: [], responsiveMeasures: [],
  aliases: { cssVariables: [], tailwind: [] },
}

/** One module instance per catalog: `core/config.ts` reads the config once at load. */
async function load(fixture, designSystem) {
  globalThis.__DESIGNLAYER_CONFIG__ = designSystem ? { apiBase: "/__designlayer", designSystem } : undefined
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `
        export const __fixture = ${JSON.stringify(fixture)}
        export { selectionColorsSection, collectSelectionColors } from "./src/panels/inspector/section-selection-colors"
        export { forgetSectionFold } from "./src/panels/inspector/field"
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

const plain = await load("plain", null)
const stocked = await load("stocked", COLORS)

let serial = 0

/**
 * Renders the section over fresh markup. `select` names the ids to select,
 * primary first; the default is the first element. `invalidate` re-renders.
 */
function mount(surface, markup, select) {
  // Ids repeat across cases, and JSDOM's `#id` lookups find the first in the document.
  window.document.body.replaceChildren()
  const host = window.document.createElement("div")
  host.innerHTML = markup
  window.document.body.append(host)
  const pick = select ? select.map((id) => window.document.getElementById(id)) : [host.firstElementChild]
  const describe = (element) => {
    serial += 1
    return { key: `sel:${serial}`, element, componentName: "Card", tagName: element.tagName.toLowerCase(), source: null }
  }
  const selections = pick.map(describe)
  const batches = []
  const singles = []
  const picked = { many: null, single: [] }
  const state = { node: null }
  const context = {
    editor: {
      apiBase: "http://127.0.0.1:0/api",
      bridge: { elementInfo: () => null },
      toast() {},
      getState: surface.getState,
      setState: surface.setState,
      selectMany: (elements) => { picked.many = elements },
      select: (element, options) => picked.single.push({ element, options }),
    },
    writer: {
      applyStyles: (selection, list, summary) => singles.push({ selection, list, summary }),
      applyStylesBatch: (edits, summary) => {
        batches.push({ edits, summary })
        for (const edit of edits) {
          for (const { property, value } of edit.writes) edit.selection.element.style.setProperty(property, value)
        }
      },
      applyClasses() {},
    },
    selection: selections[0],
    selections,
    get computed() {
      return window.getComputedStyle(selections[0].element)
    },
    invalidate() {
      const next = surface.selectionColorsSection(context)
      if (next) state.node?.replaceWith(next)
      state.node = next
    },
  }
  state.node = surface.selectionColorsSection(context)
  if (state.node) host.append(state.node)
  return { get node() { return state.node }, batches, singles, picked, host }
}

const click = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
const enter = (input, value) => {
  input.value = value
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
}
const rows = (node) => [...node.querySelectorAll(".de-selcolor-row")]
const hexOf = (row) => row.querySelector(".de-paint-value")?.value
const isFolded = (node) => node.querySelector(".de-section-body").hidden

const CARD = `
  <section id="card" style="background-color:#ffffff;border:1px solid #e5ebf0">
    <h2 id="title" style="color:#101418">Pro plan</h2>
    <button id="cta" style="background-color:#4a5df9;color:#ffffff">Upgrade</button>
    <div id="chrome" data-designlayer="" style="background-color:#ff0000"></div>
  </section>`

console.log("\nGrouping")

check("a card's colours group by value, primary first, across background, text and border", () => {
  plain.forgetSectionFold("Selection colors")
  const { node } = mount(plain, CARD)
  assert.ok(node, "no section for a card with four colours")
  assert.equal(node.querySelector(".de-section-title").textContent, "Selection colors")
  assert.deepEqual(rows(node).map(hexOf), ["FFFFFF", "E5EBF0", "101418", "4A5DF9"])
})

check("one group holds every element and property that paints it", () => {
  window.document.body.replaceChildren()
  const card = window.document.createElement("div")
  card.innerHTML = CARD
  window.document.body.append(card)
  const groups = plain.collectSelectionColors([card.firstElementChild])
  const white = groups.find((group) => group.key === "#ffffff/100")
  assert.deepEqual(
    white.members.map((member) => `${member.element.id}:${member.property}`),
    ["card:background-color", "cta:color"]
  )
  assert.deepEqual(groups.find((group) => group.key === "#e5ebf0/100").members.map((m) => m.property), ["border-color"])
})

check("the editor's own chrome nodes are skipped", () => {
  const { node } = mount(plain, CARD)
  assert.ok(!rows(node).some((row) => hexOf(row) === "FF0000"), "a data-designlayer node's colour was listed")
})

check("a colour at another alpha is its own group", () => {
  const groups = plain.collectSelectionColors([(() => {
    const host = window.document.createElement("div")
    host.innerHTML = `<div style="background-color:rgba(0,0,0,0.5)"><span style="background-color:#000000">x</span></div>`
    window.document.body.append(host)
    return host.firstElementChild
  })()])
  assert.deepEqual(groups.map((group) => group.key), ["#000000/50", "#000000/100"])
})

check("text colour counts only on elements with text of their own; one side of a border keeps its longhand", () => {
  const host = window.document.createElement("div")
  host.innerHTML = `<div style="color:#123456;border-top:2px solid #00ff00"><span style="color:#123456">hi</span></div>`
  window.document.body.append(host)
  const groups = plain.collectSelectionColors([host.firstElementChild])
  const text = groups.find((group) => group.key === "#123456/100")
  assert.equal(text.members.length, 1, "the wrapper with no text was counted")
  assert.equal(text.members[0].element.tagName, "SPAN")
  assert.deepEqual(groups.find((group) => group.key === "#00ff00/100").members.map((m) => m.property), ["border-top-color"])
})

console.log("\nThresholds")

check("one plain rectangle shows no section", () => {
  const { node } = mount(plain, `<div style="width:10px;height:10px;background-color:#d9d9d9"></div>`)
  assert.equal(node, null)
})

check("an element with no colour shows no section, even with two selected", () => {
  const { node } = mount(plain, `<div><div id="a"></div><div id="b"></div></div>`, ["a", "b"])
  assert.equal(node, null)
})

check("two selected layers sharing one colour show one row", () => {
  const { node } = mount(
    plain,
    `<div><div id="a" style="background-color:#d9d9d9"></div><div id="b" style="background-color:#d9d9d9"></div></div>`,
    ["a", "b"]
  )
  assert.ok(node, "no section for a two-layer selection")
  assert.deepEqual(rows(node).map(hexOf), ["D9D9D9"])
})

check("two selected layers with two colours list both, Figma's multi state", () => {
  const { node } = mount(
    plain,
    `<div><div id="a" style="background-color:#4a5cfa"></div><div id="b" style="background-color:#d9d9d9"></div></div>`,
    ["a", "b"]
  )
  assert.deepEqual(rows(node).map(hexOf), ["4A5CFA", "D9D9D9"])
  assert.equal(rows(node)[0].querySelector("input[data-de-field='selcolor.0.alpha']").value, "100")
})

console.log("\nEdits are one batch")

check("typing a hex writes every element and property in the group as ONE batch", () => {
  const view = mount(plain, CARD)
  const white = rows(view.node).find((row) => hexOf(row) === "FFFFFF")
  enter(white.querySelector(".de-paint-value"), "ff0066")
  assert.equal(view.batches.length, 1, "not one batch")
  assert.equal(view.singles.length, 0, "a single-element write slipped through")
  const flat = view.batches[0].edits.flatMap((edit) =>
    edit.writes.map((write) => `${edit.selection.element.id}:${write.property}=${write.value}`)
  )
  assert.deepEqual(flat, ["card:background-color=#ff0066", "cta:color=#ff0066"])
  assert.equal(view.batches[0].summary, "Set selection color")
  assert.ok(rows(view.node).some((row) => hexOf(row) === "FF0066"), "the next render did not show the new colour")
})

check("the selected element's own Selection is reused; descendants get a described one", () => {
  const view = mount(plain, CARD)
  enter(rows(view.node).find((row) => hexOf(row) === "FFFFFF").querySelector(".de-paint-value"), "#00aa00")
  const [cardEdit, ctaEdit] = view.batches[0].edits
  assert.match(cardEdit.selection.key, /^sel:/)
  assert.equal(ctaEdit.selection.element.id, "cta")
  assert.equal(ctaEdit.selection.tagName, "button")
})

check("an opacity commit keeps the colour and writes the new alpha to every member", () => {
  const view = mount(plain, CARD)
  const white = rows(view.node).find((row) => hexOf(row) === "FFFFFF")
  const alpha = white.querySelector("input[data-de-field='selcolor.0.alpha']")
  assert.ok(alpha, "no opacity field")
  enter(alpha, "50")
  assert.equal(view.batches.length, 1)
  assert.deepEqual(
    view.batches[0].edits.flatMap((edit) => edit.writes.map((write) => write.value)),
    ["rgba(255,255,255,0.5)", "rgba(255,255,255,0.5)"]
  )
})

check("a four-sided border of one colour is written as one border-color", () => {
  const view = mount(plain, CARD)
  enter(rows(view.node).find((row) => hexOf(row) === "E5EBF0").querySelector(".de-paint-value"), "000000")
  assert.deepEqual(view.batches[0].edits[0].writes, [{ property: "border-color", value: "#000000" }])
})

console.log("\nSelect layers with this color")

check("each row's column-3 action selects every element using that colour", () => {
  const view = mount(plain, CARD)
  const white = rows(view.node).find((row) => hexOf(row) === "FFFFFF")
  const action = white.querySelector(".de-prow-trail [aria-label='Select layers with this color']")
  assert.ok(action, "no select action in column 3")
  click(action)
  assert.deepEqual(view.picked.many.map((element) => element.id), ["card", "cta"])
})

console.log("\nFold")

check("four colours or fewer arrive unfolded and hide the header summary", () => {
  plain.forgetSectionFold("Selection colors")
  const { node } = mount(plain, CARD)
  assert.equal(isFolded(node), false)
  assert.ok(!node.querySelector(".de-section-header--collapsed"))
})

const MANY = `<div style="background-color:#111111">
  <div style="background-color:#222222"></div><div style="background-color:#333333"></div>
  <div style="background-color:#444444"></div><div style="background-color:#555555"></div>
</div>`

check("five colours arrive folded with three chits and +2 in the header", () => {
  plain.forgetSectionFold("Selection colors")
  const { node } = mount(plain, MANY)
  assert.equal(isFolded(node), true)
  const header = node.querySelector(".de-section-header")
  assert.ok(header.classList.contains("de-section-header--collapsed"))
  const chits = [...header.querySelectorAll(".de-selcolor-chit")]
  assert.equal(chits.length, 3)
  assert.equal(chits[0].style.background.replace(/\s/g, ""), "rgb(17,17,17)")
  assert.equal(header.querySelector(".de-selcolor-more").textContent, "+2")
  assert.equal(rows(node).length, 5, "the folded body should still hold every row")
})

check("the fold follows the count until the user presses the header, then theirs wins", () => {
  plain.forgetSectionFold("Selection colors")
  assert.equal(isFolded(mount(plain, MANY).node), true)
  assert.equal(isFolded(mount(plain, CARD).node), false, "a later four-colour selection stayed folded")
  const many = mount(plain, MANY).node
  click(many.querySelector(".de-section-toggle"))
  assert.equal(isFolded(many), false)
  assert.equal(isFolded(mount(plain, MANY).node), false, "the user's unfold was overridden")
  plain.forgetSectionFold("Selection colors")
})

console.log("\nTokens")

check("with no colour tokens the value cell is an editable hex", () => {
  const { node } = mount(plain, CARD)
  assert.equal(node.querySelector(".de-token-field"), null)
  assert.ok(node.querySelector(".de-paint-value"))
})

check("with colour tokens each row offers them, and a pick writes each member's own property", () => {
  const view = mount(stocked, CARD)
  const white = view.node.querySelector(".de-selcolor-row")
  const field = white.querySelector(".de-token-field")
  assert.ok(field, "no token field on a stocked project")
  click(field)
  const option = window.document.querySelector("[data-de-choice='color:ink']")
  assert.ok(option, "the picker did not list the colour tokens")
  click(option)
  assert.equal(view.batches.length, 1)
  assert.equal(view.batches[0].summary, "Apply Text/Primary")
  const flat = view.batches[0].edits.flatMap((edit) =>
    edit.writes.map((write) => `${edit.selection.element.id}:${write.property}`)
  )
  assert.deepEqual(flat, ["card:background-color", "cta:color"])
  for (const edit of view.batches[0].edits) {
    assert.match(edit.writes[0].value, /^var\(--fx-text-primary/, "not the token write the bindings make")
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
