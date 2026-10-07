/**
 * Cases for scoped saved styles: which classes and properties each Design-tab
 * section owns, and the store verbs that apply a style to its slice only.
 *
 * The classification table is the part most likely to regress silently —
 * `text-lg` and `text-red-500` share a stem, as do `border-2` and
 * `border-red-500` — and a misfiled class means applying a text style strips
 * someone's fill. The server half is checked against the real normaliser,
 * because it used to drop every option field it did not list.
 *
 * Usage: node test/style-scope-cases.mjs
 */

import assert from "node:assert/strict"
import path from "node:path"
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

const dom = new JSDOM("<!doctype html><html><body></body></html>")
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Element = dom.window.Element
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.CustomEvent = dom.window.CustomEvent
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

/** One bundle, so the store the verbs write is the store these cases read. */
async function load() {
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `
        export * from "./src/options/scopes"
        export { optionsStore, BASELINE_OPTION_ID } from "./src/options/store"
        export { propertyForClass } from "./src/core/tailwind"
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
  return import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  )
}

const m = await load()

/** Records every call and applies it, so later reads see the new look. */
function fakeWriter() {
  const calls = []
  return {
    calls,
    applyClasses(selection, { remove, add }, summary) {
      calls.push({ kind: "classes", remove, add, summary })
      selection.element.classList.remove(...remove)
      selection.element.classList.add(...add)
    },
    applyStyles(selection, writes, summary) {
      calls.push({ kind: "styles", writes, summary })
      for (const { property, value } of writes) {
        if (value) selection.element.style.setProperty(property, value)
        else selection.element.style.removeProperty(property)
      }
    },
    applyText(selection, text) {
      calls.push({ kind: "text", text })
      selection.element.textContent = text
    },
  }
}

let serial = 0
function selectionFor(className, style = "") {
  const element = document.createElement("div")
  element.className = className
  if (style) element.setAttribute("style", style)
  element.textContent = "Label"
  document.body.append(element)
  serial += 1
  return { element, key: `scope-cases:${serial}`, componentName: "Card", tagName: "div", source: null }
}

const store = m.optionsStore({ apiBase: "http://127.0.0.1:0/api", toast() {} })

console.log("\nClass classification")

const TABLE = [
  ["text-lg", "typography"],
  ["text-red-500", "typography"],
  ["text-[14px]", "typography"],
  ["text-center", "typography"],
  ["font-bold", "typography"],
  ["font-sans", "typography"],
  ["font-[650]", "typography"],
  ["leading-6", "typography"],
  ["tracking-wide", "typography"],
  ["uppercase", "typography"],
  ["underline", "typography"],
  ["italic", "typography"],
  ["truncate", "typography"],
  ["hover:text-blue-600", "typography"],
  ["md:text-xl", "typography"],
  ["bg-red-500", "fill"],
  ["dark:bg-background", "fill"],
  ["bg-gradient-to-r", "fill"],
  ["from-sky-500", "fill"],
  ["fill-current", "fill"],
  ["border", "stroke"],
  ["border-2", "stroke"],
  ["border-red-500", "stroke"],
  ["border-t-2", "stroke"],
  ["border-dashed", "stroke"],
  ["ring-2", "stroke"],
  ["ring-blue-500", "stroke"],
  ["outline-none", "stroke"],
  ["focus-visible:outline-2", "stroke"],
  ["shadow-md", "effects"],
  ["shadow", "effects"],
  ["blur-sm", "effects"],
  ["drop-shadow-lg", "effects"],
  ["backdrop-blur", "effects"],
  ["rounded-md", "appearance"],
  ["rounded-t-lg", "appearance"],
  ["opacity-50", "appearance"],
  ["!opacity-0", "appearance"],
  ["mix-blend-multiply", "appearance"],
  ["invisible", "appearance"],
  ["p-4", "layout"],
  ["px-2", "layout"],
  ["pt-1", "layout"],
  ["gap-2", "layout"],
  ["gap-x-4", "layout"],
  ["flex", "layout"],
  ["flex-col", "layout"],
  ["hidden", "layout"],
  ["w-full", "layout"],
  ["max-w-prose", "layout"],
  ["items-center", "layout"],
  ["justify-between", "layout"],
  ["grid-cols-3", "layout"],
  ["sm:flex-row", "layout"],
  ["[&>svg]:size-4", "layout"],
  ["[padding-inline:2px]", "layout"],
]

for (const [cls, scope] of TABLE) {
  check(`${cls} -> ${scope} and nothing else`, () => {
    for (const other of m.STYLE_SCOPES) {
      assert.equal(m.scopeOwnsClass(other, cls), other === scope, `${cls} in ${other}`)
    }
  })
}

for (const cls of ["mt-4", "-mx-2", "transition", "duration-150", "cursor-pointer", "relative", "z-10", "group", "my-custom-thing"]) {
  check(`${cls} belongs to no scope, so it is always preserved`, () => {
    assert.equal(m.STYLE_SCOPES.some((scope) => m.scopeOwnsClass(scope, cls)), false)
  })
}

check("propertyForClass reads the tailwind tables back", () => {
  assert.equal(m.propertyForClass("text-lg"), "font-size")
  assert.equal(m.propertyForClass("text-red-500"), "color")
  assert.equal(m.propertyForClass("border-2"), "border-width")
  assert.equal(m.propertyForClass("border-red-500"), "border-color")
  assert.equal(m.propertyForClass("gap-x-2"), "column-gap")
  assert.equal(m.propertyForClass("-mt-2"), "margin-top")
  assert.equal(m.propertyForClass("lg:hover:font-semibold"), "font-weight")
  assert.equal(m.propertyForClass("uppercase"), null)
})

console.log("\nProperty classification")

const PROPERTIES = [
  ["font-size", "typography"],
  ["color", "typography"],
  ["text-decoration-line", "typography"],
  ["white-space", "typography"],
  ["background-color", "fill"],
  ["background-image", "fill"],
  ["border-top-width", "stroke"],
  ["border-left-color", "stroke"],
  ["outline-offset", "stroke"],
  ["--tw-ring-color", "stroke"],
  ["box-shadow", "effects"],
  ["backdrop-filter", "effects"],
  ["opacity", "appearance"],
  ["border-radius", "appearance"],
  ["border-top-left-radius", "appearance"],
  ["display", "layout"],
  ["padding-left", "layout"],
  ["min-width", "layout"],
  ["grid-template-columns", "layout"],
]
for (const [property, scope] of PROPERTIES) {
  check(`${property} -> ${scope} and nothing else`, () => {
    for (const other of m.STYLE_SCOPES) {
      assert.equal(m.scopeOwnsProperty(other, property), other === scope, `${property} in ${other}`)
    }
  })
}
check("margin, position and transition properties are in no scope", () => {
  for (const property of ["margin-top", "position", "transition-duration", "cursor"]) {
    assert.equal(m.STYLE_SCOPES.some((scope) => m.scopeOwnsProperty(scope, property)), false, property)
  }
})

console.log("\nSlices")

check("sliceSnapshot keeps the scope's classes and declarations and drops text", () => {
  const snapshot = {
    className: "p-4 text-lg font-bold bg-red-500 rounded-md mt-2",
    style: { color: "red", padding: "4px", opacity: "0.5" },
    text: "Hello",
  }
  assert.deepEqual(m.sliceSnapshot(snapshot, "typography"), {
    className: "text-lg font-bold",
    style: { color: "red" },
  })
  assert.deepEqual(m.sliceSnapshot(snapshot, "layout"), { className: "p-4", style: { padding: "4px" } })
  assert.deepEqual(m.sliceSnapshot(snapshot, "fill"), { className: "bg-red-500", style: {} })
})

check("SCOPE_LABELS names every scope", () => {
  assert.deepEqual(Object.keys(m.SCOPE_LABELS).sort(), [...m.STYLE_SCOPES].sort())
  assert.equal(m.SCOPE_LABELS.typography, "Text style")
  assert.equal(m.SCOPE_LABELS.fill, "Color style")
})

console.log("\nStore verbs")

check("saveScoped captures only the slice and names it by scope", () => {
  const selection = selectionFor("p-4 text-lg font-bold bg-red-500", "color: blue; padding: 2px")
  const writer = fakeWriter()
  const first = store.saveScoped(selection, writer, "typography")
  assert.equal(first.name, "Text style 1")
  assert.equal(first.scope, "typography")
  assert.equal(first.className, "text-lg font-bold")
  assert.deepEqual(first.style, { color: "blue" })
  assert.equal(first.text, undefined)
  assert.equal(store.saveScoped(selection, writer, "typography").name, "Text style 2")
  assert.equal(store.saveScoped(selection, writer, "fill").name, "Color style 1")
  assert.equal(writer.calls.length, 0, "saving restyled the element")
  assert.ok(store.hasBaseline(selection.key))
})

check("applyScoped swaps the scope's classes and leaves every other class alone", () => {
  const selection = selectionFor("p-4 text-sm font-normal bg-red-500 rounded-md mt-2 hover:text-gray-500 cursor-pointer")
  const writer = fakeWriter()
  const option = { id: "t1", name: "Heading", className: "text-2xl font-bold p-8 bg-blue-500", style: {}, createdAt: 1, scope: "typography" }
  store.applyScoped(selection, writer, option, "typography")
  const classes = writer.calls.find((call) => call.kind === "classes")
  assert.deepEqual(classes.remove.sort(), ["font-normal", "hover:text-gray-500", "text-sm"])
  assert.deepEqual(classes.add.sort(), ["font-bold", "text-2xl"])
  assert.equal(classes.summary, 'Apply text style "Heading"')
  for (const kept of ["p-4", "bg-red-500", "rounded-md", "mt-2", "cursor-pointer"]) {
    assert.ok(selection.element.classList.contains(kept), `${kept} was removed`)
  }
  assert.ok(!selection.element.classList.contains("p-8"), "another scope's class leaked in")
  assert.equal(writer.calls.some((call) => call.kind === "text"), false)
})

check("applyScoped clears and sets only the scope's inline declarations", () => {
  const selection = selectionFor("", "color: red; letter-spacing: 1px; padding: 3px; opacity: 0.5")
  const writer = fakeWriter()
  const option = { id: "t2", name: "Blue", className: "", style: { color: "blue", "background-color": "black" }, createdAt: 1, scope: "typography" }
  store.applyScoped(selection, writer, option, "typography")
  const writes = writer.calls.find((call) => call.kind === "styles").writes
  assert.deepEqual(
    writes.map((write) => `${write.property}=${write.value}`).sort(),
    ["color=blue", "letter-spacing="]
  )
  assert.equal(selection.element.style.padding, "3px")
  assert.equal(selection.element.style.opacity, "0.5")
})

check("activeStyleId finds the matching style, order-insensitively, and loses it on an edit", () => {
  const selection = selectionFor("font-bold p-4 text-lg")
  const writer = fakeWriter()
  const style = store.saveScoped(selection, writer, "typography")
  selection.element.className = "text-lg bg-white font-bold p-2"
  assert.equal(store.activeStyleId(selection, "typography"), style.id)
  assert.equal(store.activeStyleId(selection, "fill"), null)
  selection.element.classList.replace("text-lg", "text-xl")
  assert.equal(store.activeStyleId(selection, "typography"), null)
})

check("a legacy unscoped option is offered in every scope it has a slice in", () => {
  const selection = selectionFor("text-sm p-2")
  m.setState({
    optionSets: {
      ...m.getState().optionSets,
      [selection.key]: {
        key: selection.key,
        label: "Card",
        activeOptionId: null,
        options: [
          { id: m.BASELINE_OPTION_ID, name: "Before options", className: "text-sm p-2", style: {}, createdAt: 0 },
          { id: "legacy", name: "Option 1", className: "text-lg bg-red-500 p-6", style: {}, text: "Hi", createdAt: 1 },
          { id: "fill-1", name: "Color style 1", className: "bg-blue-500", style: {}, createdAt: 2, scope: "fill" },
        ],
      },
    },
  })
  for (const scope of m.STYLE_SCOPES) {
    const offered = store.stylesFor(selection.key, scope).some((option) => option.id === "legacy")
    assert.equal(offered, ["typography", "fill", "layout"].includes(scope), scope)
    assert.ok(!store.stylesFor(selection.key, scope).some((option) => option.id === m.BASELINE_OPTION_ID))
  }
  assert.equal(store.activeStyleId(selection, "stroke"), null, "an empty legacy slice read as applied")
  assert.deepEqual(store.stylesFor(selection.key, "fill").map((option) => option.id), ["legacy", "fill-1"])
  assert.deepEqual(store.stylesFor(selection.key, "typography").map((option) => option.id), ["legacy"])

  const writer = fakeWriter()
  store.applyScoped(selection, writer, store.stylesFor(selection.key, "fill")[0], "fill")
  assert.equal(selection.element.className, "text-sm p-2 bg-red-500")
  assert.equal(selection.element.textContent, "Label", "a scoped apply changed the copy")
  assert.equal(store.activeStyleId(selection, "fill"), "legacy")

  assert.equal(store.revertScoped(selection, writer, "fill"), true)
  assert.equal(selection.element.className, "text-sm p-2")
})

check("updateScoped overwrites the style with the current slice and scopes it", () => {
  const selection = selectionFor("text-lg p-4")
  const writer = fakeWriter()
  const style = store.saveScoped(selection, writer, "typography")
  selection.element.className = "text-xl font-bold p-8"
  store.updateScoped(selection, style.id, "typography")
  const updated = store.get(selection.key).options.find((option) => option.id === style.id)
  assert.equal(updated.className, "text-xl font-bold")
  assert.equal(updated.scope, "typography")
  store.updateScoped(selection, m.BASELINE_OPTION_ID, "typography")
  const baseline = store.get(selection.key).options.find((option) => option.id === m.BASELINE_OPTION_ID)
  assert.equal(baseline.className, "text-lg p-4")
})

check("revertScoped is false with no baseline", () => {
  const selection = selectionFor("text-lg")
  assert.equal(store.revertScoped(selection, fakeWriter(), "typography"), false)
})

check("removeStyle deletes without restyling, and drops the set when it empties", () => {
  const selection = selectionFor("text-lg bg-red-500")
  const writer = fakeWriter()
  const a = store.saveScoped(selection, writer, "typography")
  const b = store.saveScoped(selection, writer, "fill")
  selection.element.className = "text-sm"
  store.removeStyle(selection, a.id)
  assert.deepEqual(store.stylesFor(selection.key, "typography").map((option) => option.id), [])
  assert.ok(store.get(selection.key))
  store.removeStyle(selection, b.id)
  assert.equal(store.get(selection.key), null)
  assert.equal(writer.calls.length, 0)
  assert.equal(selection.element.className, "text-sm")
})

console.log("\nServer normaliser")

const { normalizeOptionSet } = await import(path.join(PACKAGE_DIR, "server/options-store.mjs"))

check("a known scope survives the round-trip and an unknown one is dropped", () => {
  const stored = normalizeOptionSet(
    {
      label: "Card",
      activeOptionId: null,
      options: [
        { id: "a", name: "Text style 1", className: "text-lg", style: {}, createdAt: 1, scope: "typography" },
        { id: "b", name: "Odd", className: "", style: {}, createdAt: 2, scope: "sparkle" },
        { id: "c", name: "Legacy", className: "p-2", style: {}, createdAt: 3 },
      ],
    },
    "k"
  )
  assert.equal(stored.options[0].scope, "typography")
  assert.equal("scope" in stored.options[1], false)
  assert.equal("scope" in stored.options[2], false)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
