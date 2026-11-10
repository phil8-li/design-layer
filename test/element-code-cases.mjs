/**
 * The element-code generator, and the left strip the Code tab was removed from.
 *
 * `core/element-code.ts` turns the live element into JSX, HTML or a class list
 * for the layer header's and the layer menu's "copy as code". No route hands
 * back a source file, so everything is derived from the element, and every
 * question about what the code should say is asked of `elementCode`, not of
 * the DOM. The last section installs both panels to pin that neither strip
 * carries a Code tab: the Code tab and its view were retired.
 *
 * Usage: node designlayer/test/element-code-cases.mjs
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
  `<!doctype html><html><body><main id="app">
     <section id="card" class="rounded-xl p-4 hover:bg-slate-800 md:grid-cols-[1fr_2fr]" data-role="card">
       <h2 class="text-lg">Weekly digest</h2>
       <img src="/logo.png" width="24" alt="">
       <p>Three things happened.</p>
     </section>
   </main></body></html>`,
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom
window.document.elementsFromPoint = () => []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
}
// JSDOM ships no `scrollIntoView` at all, and the layer tree — mounted by the
// left panel alongside the code view — calls it unguarded when the selection
// moves, which is every case below. Stubbed the way `layers-cases.mjs` stubs
// it: the panel under test here is not the one doing the scrolling.
window.Element.prototype.scrollIntoView = function scrollIntoView() {}
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

/**
 * A server that answers the requests the inspector's tabs make on their first
 * `update()`.
 *
 * Nothing in this file is about libraries or the audit — but `installInspector`
 * boots every tab once, and an unstubbed `fetch` in Node reaches undici, which
 * refuses a relative URL outright. That lands as a `TypeError: Failed to parse
 * URL` in the middle of the run, which is noise a reader has to rule out before
 * they can read the failures that matter. Every payload is the well-formed
 * empty answer, because "there is nothing installed" is the state that keeps
 * the tab quiet. The saved-options read is the third request: the Design tab
 * makes it on its first repaint with something selected, and handed the
 * library answer it would file `libraries` as an element with no options.
 */
globalThis.fetch = async (input) => {
  const path = new URL(String(input), "http://localhost").pathname
  const payload = path.endsWith("/lint/tools")
    ? { tools: [] }
    : path.endsWith("/options")
      ? {}
      : { libraries: [] }
  return { ok: true, status: 200, json: async () => payload }
}
window.fetch = globalThis.fetch

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createContext } from "./src/core/context"
      export { installLeftPanel } from "./src/panels/left"
      export { installInspector } from "./src/panels/inspector/index"
      export { setState } from "./src/core/store"
      export { CODE_VIEWS, codeText, elementCode } from "./src/core/element-code"
      export { shellCss } from "./src/core/css"
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

const card = window.document.getElementById("card")
card.style.boxShadow = "0 2px 8px rgba(0,0,0,.3)"

/** A Selection built by hand: the generator only ever reads these five fields. */
const selectionFor = (element, source = null) => ({
  element,
  tagName: element.tagName.toLowerCase(),
  componentName: source?.componentName ?? element.tagName.toLowerCase(),
  source,
  key: `${element.tagName}#${element.id}`,
})

const cardSelection = selectionFor(card, {
  filePath: "/Users/someone/app/src/components/digest-card.tsx",
  lineNumber: 42,
  columnNumber: 3,
  componentName: "DigestCard",
})

const generate = (view, selection = cardSelection) => editor.elementCode(selection, view)
const text = (view, selection = cardSelection) => editor.codeText(generate(view, selection))
const kindsOf = (tokens, kind) => tokens.filter((token) => token.kind === kind).map((t) => t.text)

// ── The generator ──────────────────────────────────────────────────────────

console.log("\nJSX view")

check("the selected element is the root, with React's spelling of class", () => {
  const jsx = text("jsx")
  assert.match(jsx, /^<section /)
  assert.match(jsx, /className="rounded-xl p-4 hover:bg-slate-800 md:grid-cols-\[1fr_2fr\]"/)
  assert.ok(!jsx.includes(' class="'), "the HTML attribute name leaked into JSX")
})

check("children come with it, indented, down to their text", () => {
  const jsx = text("jsx")
  assert.match(jsx, /\n {2}<h2 className="text-lg">Weekly digest<\/h2>\n/)
  assert.match(jsx, /\n {2}<p>Three things happened\.<\/p>\n/)
  assert.match(jsx, /<\/section>$/)
})

check("a numeric prop is braced, and an empty non-boolean attribute keeps its quotes", () => {
  const jsx = text("jsx")
  assert.match(jsx, /width=\{24\}/)
  assert.match(jsx, /alt=""/)
  assert.match(jsx, /<img [^\n]*\/>/, "an empty element did not self-close")
})

check("the inline styles the editor wrote show up as a style object", () => {
  assert.match(text("jsx"), /style=\{\{ boxShadow: "0 2px 8px rgba\(0, ?0, ?0, ?0?\.3\)" \}\}/)
})

console.log("\nHTML view")

check("the same element in the other dialect: class, closing tags, no braces", () => {
  const html = text("html")
  assert.match(html, /^<section /)
  assert.match(html, / class="rounded-xl p-4/)
  assert.ok(!html.includes("className"), "a JSX prop name leaked into HTML")
  assert.match(html, /width="24"/)
  assert.match(html, /style="box-shadow: 0 2px 8px/)
})

check("a void tag closes the way HTML closes it, not the way JSX does", () => {
  const html = text("html")
  assert.match(html, /<img src="\/logo\.png" width="24" alt="">/)
  assert.ok(!html.includes("/>"), "JSX self-closing syntax reached the HTML view")
})

console.log("\nTailwind classes view")

check("one class per line, in source order", () => {
  assert.equal(
    text("classes"),
    "rounded-xl\np-4\nhover:bg-slate-800\nmd:grid-cols-[1fr_2fr]"
  )
})

check("an element with no classes says so instead of rendering a blank pane", () => {
  const bare = selectionFor(window.document.querySelector("#card p"))
  assert.match(text("classes", bare), /no classes/)
})

console.log("\nTinting")

check("the generator names every token; the panel never re-parses a string", () => {
  const tokens = generate("jsx")
  assert.ok(tokens.length > 0)
  for (const token of tokens) {
    assert.ok(
      ["tag", "attribute", "string", "number", "punctuation", "plain"].includes(token.kind),
      `unknown token kind ${token.kind}`
    )
    assert.equal(typeof token.text, "string")
  }
})

check("tag names, attribute names, strings and numbers land on the right kind", () => {
  const tokens = generate("jsx")
  assert.ok(kindsOf(tokens, "tag").includes("section"))
  assert.ok(kindsOf(tokens, "tag").includes("h2"))
  assert.ok(kindsOf(tokens, "attribute").includes("className"))
  assert.ok(kindsOf(tokens, "attribute").includes("data-role"))
  assert.ok(kindsOf(tokens, "string").includes('"card"'))
  assert.ok(kindsOf(tokens, "number").includes("24"))
  assert.ok(kindsOf(tokens, "punctuation").includes("<"))
})

check("a utility splits into its variants, its stem and its value", () => {
  const tokens = generate("classes")
  assert.ok(kindsOf(tokens, "attribute").includes("hover"), "the variant is not tinted apart")
  assert.ok(kindsOf(tokens, "attribute").includes("md"))
  assert.ok(kindsOf(tokens, "tag").includes("bg-slate"))
  assert.ok(kindsOf(tokens, "number").includes("800"), "a numeric scale step is not a number")
  assert.ok(kindsOf(tokens, "string").includes("xl"))
  assert.ok(kindsOf(tokens, "string").includes("1fr_2fr"), "an arbitrary value is not a string")
})

// ── The panel ──────────────────────────────────────────────────────────────

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const bridge = {
  elementInfo: () => null,
  send() {},
  toast() {},
  subscribe: () => () => {},
  store: { setActiveTool() {} },
}
/* Both panels, so "no Code tab" is asked of real strips rather than empty divs. */
const left = slot()
const right = slot()
const context = editor.createContext(bridge, {
  overlay: slot(),
  toolbar: slot(),
  left,
  right,
})
editor.installLeftPanel(context)
editor.installInspector(context)

const tabsIn = (panel) => Array.from(panel.querySelectorAll('[role="tab"]'))

console.log("\nNo Code tab")

check("neither the left rail nor the inspector carries a Code tab", () => {
  assert.ok(left.querySelector(".de-tabs"), "the left panel has no tab strip")
  for (const [name, panel] of [["left strip", left], ["inspector", right]]) {
    assert.equal(
      tabsIn(panel).find((node) => node.textContent.trim() === "Code"),
      undefined,
      `the ${name} grew a Code tab back`
    )
  }
  assert.equal(window.document.getElementById("de-left-tabpanel-code"), null)
  assert.equal(left.querySelector(".de-code"), null, "a code view is mounted in the left panel")
})

/*
 * The left strip, asked about Controls.
 *
 * Controls arrived from a floating `role="dialog"` that mounted itself on
 * `document.body`, and the one thing that move could quietly undo is its own
 * position. A pane appended to the left slot with no tab pointing at it would
 * be unreachable and would still satisfy `.de-controls`, so the strip is what
 * gets asked.
 */
console.log("\nThe left strip")

check("the left strip is Layers then Design options, and the inspector did not grow one", () => {
  const labels = tabsIn(left).map((node) => node.textContent.trim())
  assert.deepEqual(labels, ["Layers", "Design options"], `the left strip is ${JSON.stringify(labels)}`)
  const button = tabsIn(left)[1]
  assert.equal(button.getAttribute("aria-controls"), "de-left-tabpanel-controls")
  assert.equal(
    tabsIn(right).find((node) => /controls|design options/i.test(node.textContent)),
    undefined,
    "the inspector grew a Design options tab, so the app's options are in two places"
  )
  assert.ok(
    window.document.getElementById("de-left-tabpanel-controls")?.querySelector(".de-controls"),
    "the tab names a pane the controls view is not in"
  )
})

/*
 * The requirement the deleted dialog's own header gave as the reason it mounted
 * its own root: a list of everything the app exposes must not require picking
 * something first. The left panel has always behaved this way — it does not
 * unmount on deselection — which is what made the
 * dialog redundant. Asserted from the empty selection, because that is the
 * state the dialog was built to survive.
 */
check("the Design options pane is still there with nothing selected", () => {
  editor.setState({ selection: [] })
  tabsIn(left)[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  const pane = window.document.getElementById("de-left-tabpanel-controls")
  assert.equal(pane.hidden, false)
  assert.ok(pane.querySelector(".de-opt-filter"), "the pane lost its filter when nothing was selected")
  // And it did not arrive as a popover. `de-arrive` is the shared entrance for
  // surfaces that appear OVER something; a docked pane must not pop.
  assert.equal(pane.querySelector(".de-arrive"), null)
  assert.equal(pane.firstElementChild?.classList.contains("de-arrive"), false)
})

check("switching away and back leaves exactly one pane showing", () => {
  const panes = ["layers", "controls"].map((id) =>
    window.document.getElementById(`de-left-tabpanel-${id}`)
  )
  for (const [index, button] of tabsIn(left).entries()) {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    assert.deepEqual(
      panes.map((node) => !node.hidden),
      panes.map((_, slot) => slot === index),
      `tab ${index} left the wrong panes showing`
    )
    assert.deepEqual(
      tabsIn(left).map((node) => node.getAttribute("aria-selected")),
      panes.map((_, slot) => String(slot === index))
    )
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
