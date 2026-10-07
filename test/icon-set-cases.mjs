/**
 * The host's icon SET: the config seam, the route that serves it, and the
 * variant swap the inspector offers on a selected `<svg>`.
 *
 * Three things are asserted here that nothing else can see. The seam is
 * both-halves-or-neither, so a half-configured host fails at startup rather
 * than offering a picker that cannot match a selection. The 114KB of path data
 * stays OUT of the browser prelude and behind `GET /icons`, because a prelude
 * is paid for on every page load and this panel is not opened on most of them.
 * And a swap is ONE undoable step that restores the exact markup it replaced —
 * the icon is drawn from data, so an approximate revert would silently redraw
 * a glyph the user never touched.
 *
 * The vendored chrome glyphs are icon-cases.mjs. This file is the host's set.
 *
 * Usage: node designlayer/test/icon-set-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import vm from "node:vm"
import { JSDOM } from "jsdom"

import { browserPrelude, loadConfig, resolveConfig } from "../config.mjs"
import { createIconSet, resolveIconSetConfig } from "../server/icon-set.mjs"

import { PACKAGE_DIR, requireHostConfig } from "./host.mjs"

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

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// ── The config seam ────────────────────────────────────────────────────────

console.log("\nThe icon-set seam")

check("no icon set is a valid host, and both halves are required together", () => {
  assert.deepEqual(resolveIconSetConfig(undefined, PACKAGE_DIR), { attribute: "", data: null })
  assert.deepEqual(resolveIconSetConfig(null, PACKAGE_DIR), { attribute: "", data: null })
  assert.deepEqual(resolveIconSetConfig({}, PACKAGE_DIR), { attribute: "", data: null })

  // An attribute with no data names icons the picker cannot draw; data with no
  // attribute cannot be matched to the `<svg>` the user clicked. Either half
  // alone is a config that looks configured and does nothing.
  assert.throws(() => resolveIconSetConfig({ attribute: "data-icon" }, PACKAGE_DIR), /both/)
  assert.throws(() => resolveIconSetConfig({ data: "icons.json" }, PACKAGE_DIR), /both/)
})

check("the attribute is a plain lowercase attribute name", () => {
  for (const attribute of ["Data-Icon", "data icon", "data-icon=x", "1data", "a".repeat(80)]) {
    assert.throws(
      () => resolveIconSetConfig({ attribute, data: "icons.json" }, PACKAGE_DIR),
      /attribute/,
      `"${attribute}" should be refused`
    )
  }
  assert.deepEqual(resolveIconSetConfig({ attribute: "data-icon", data: "a/icons.json" }, PACKAGE_DIR), {
    attribute: "data-icon",
    data: path.join(PACKAGE_DIR, "a/icons.json"),
  })
})

await checkAsync("the catalog is sorted, and anything that is not a drawing is dropped", async () => {
  const dir = path.join(PACKAGE_DIR, "test", ".icon-set-fixture")
  const file = path.join(dir, "icons.json")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify({
      Zeta: { nodes: [["path", { d: "M0 0" }]], rootFill: "none", rootStroke: "currentColor" },
      Alpha: { nodes: [["circle", { cx: "8", cy: "8", r: "4" }]] },
      Empty: { nodes: [] },
      Bogus: { nodes: [["path", "not-attrs"]] },
      NotAnIcon: "string",
    })
  )
  try {
    const set = createIconSet(
      resolveConfig({ projectRoot: PACKAGE_DIR, icons: { attribute: "data-icon", data: file } }, {
        cwd: PACKAGE_DIR,
      })
    )
    const payload = set.read()
    assert.equal(payload.attribute, "data-icon")
    assert.deepEqual(
      payload.icons.map((icon) => icon.name),
      ["Alpha", "Zeta"]
    )
    // A missing `rootFill` is `currentColor`, so a host that omits it still
    // gets a glyph that takes the row's text colour.
    assert.equal(payload.icons[0].rootFill, "currentColor")
    assert.equal(payload.icons[1].rootStroke, "currentColor")
    assert.equal(set.read(), payload, "the file is re-read on every request")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

check("a host with no icon set serves an empty catalog rather than failing", () => {
  const set = createIconSet(resolveConfig({}, { cwd: PACKAGE_DIR }))
  assert.equal(set.configured, false)
  assert.deepEqual(set.read(), { attribute: "", icons: [] })
})

// ── The host, and what the browser is handed ───────────────────────────────

console.log("\nThe host app's set")

const workspace = await loadConfig(requireHostConfig("icon-set-cases"))
const hostIcons = createIconSet(workspace).read()
const prelude = browserPrelude(workspace, { proxyPort: 4567 })

/**
 * The attribute the host stamps its glyphs with, read from the host rather than
 * written down here.
 *
 * Every assertion below is about the attribute travelling intact — config to
 * prelude to route to the DOM the panel reads — and not about which string it
 * happens to be. Pinning one app's attribute name into this file would tie a
 * public suite to a single private checkout, and the contract under test does
 * not depend on the name at all.
 */
const ICON_ATTRIBUTE = workspace.icons.attribute

check("the host app is wired to its own 152-glyph set", () => {
  // Non-vacuous about the seam: the host really did configure an attribute, and
  // it really is a plain attribute name rather than an empty string that would
  // make every comparison below trivially true.
  assert.match(ICON_ATTRIBUTE, /^[a-z][a-z0-9-]*$/)
  assert.equal(hostIcons.attribute, ICON_ATTRIBUTE)
  // Non-vacuous: an empty catalog would pass every assertion below it.
  assert.equal(hostIcons.icons.length, 152)
  assert.equal(hostIcons.icons[0].name, "AlertCircle")
  assert.ok(hostIcons.icons.every((icon) => icon.nodes.length > 0))
})

check("the prelude carries the attribute, not the drawings", () => {
  const browserSandbox = { window: {} }
  vm.runInNewContext(prelude, browserSandbox)
  // Spread rather than compared directly: the prelude runs in its own vm
  // realm, so its object literals do not share this realm's prototype.
  assert.deepEqual({ ...browserSandbox.window.__DESIGNLAYER_CONFIG__.icons }, {
    attribute: ICON_ATTRIBUTE,
    available: true,
  })
  // The set is ~100KB of path data. Shipping it ahead of the bundle would
  // charge every page load for a panel most sessions never open.
  assert.equal(prelude.includes(hostIcons.icons[0].nodes[0][1].d ?? "\0"), false)
  assert.equal(prelude.includes(path.basename(workspace.icons.data)), false)
})

await checkAsync("GET /icons serves the set over the loopback route", async () => {
  const { createDesignLayerRoutes } = await import(path.join(PACKAGE_DIR, "server/routes.mjs"))
  const routes = createDesignLayerRoutes(workspace)
  const server = http.createServer((request, response) => {
    if (routes.handle(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const { port } = server.address()
    const response = await fetch(`http://127.0.0.1:${port}${workspace.apiPrefix}/icons`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.attribute, ICON_ATTRIBUTE)
    assert.equal(payload.icons.length, 152)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// ── The browser half ───────────────────────────────────────────────────────

const dom = new JSDOM(
  `<!doctype html><html><body><main id="app">
     <button id="host" class="p-2"><svg id="glyph" ${ICON_ATTRIBUTE}="Compass" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2"></path></svg></button>
     <svg id="plain" viewBox="0 0 24 24"><path d="M1 1"></path></svg>
   </main></body></html>`,
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom
window.document.elementsFromPoint = () => []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 24, bottom: 24, width: 24, height: 24 }
}
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
  "HTMLInputElement",
  "HTMLTextAreaElement",
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
  Object.defineProperty(globalThis, key, {
    value: key === "getComputedStyle" ? window.getComputedStyle.bind(window) : window[key],
    configurable: true,
    writable: true,
  })
}

// The bundle reads the injected config once, at import.
const configSandbox = { window: {} }
vm.runInNewContext(prelude, configSandbox)
globalThis.__DESIGNLAYER_CONFIG__ = configSandbox.window.__DESIGNLAYER_CONFIG__

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createContext } from "./src/core/context"
      export { createWriter } from "./src/core/writer"
      export { getResolver } from "./src/core/resolve"
      export { iconNameOf, loadIconSet, loadedIconSet } from "./src/core/icon-set"
      export { installInspector } from "./src/panels/inspector"
      export * as history from "./src/core/history"
      export { clearPreviewOnly, previewOnlyChanges } from "./src/core/change-prompt"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const editorModule = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)
const { history } = editorModule

const toasts = []
const bridge = {
  elementInfo: () => ({
    tagName: "svg",
    componentName: "CompassIcon",
    filePath: "",
    lineNumber: 0,
    columnNumber: 0,
    stack: [],
  }),
  send() {},
  subscribe: () => () => {},
  toast: (message, kind) => toasts.push({ message, kind }),
  store: {
    addPendingPropertyOperation() {},
    getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
    setCanvasTransform() {},
    onCanvasTransformChange: () => () => {},
    onStateChange: () => () => {},
    hasChanges: () => false,
    setActiveTool() {},
    buildBatchOperations: () => [],
    viewportToPage: (x, y) => ({ x, y }),
    pageToViewport: (x, y) => ({ x, y }),
  },
}

// One fetch stub for the whole browser half: the set is loaded exactly the way
// the panel loads it, over the same route asserted above.
let iconRequests = 0
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/icons")) {
    iconRequests += 1
    return { ok: true, json: async () => hostIcons }
  }
  return { ok: true, json: async () => ({}) }
}

console.log("\nNaming the selection")

check("only the `<svg>` itself answers to an icon name", () => {
  const glyph = window.document.getElementById("glyph")
  assert.equal(editorModule.iconNameOf(glyph), "Compass")
  // The button around a glyph is a button. Letting the wrapper answer would
  // offer a swap that rewrote a child the user did not select.
  assert.equal(editorModule.iconNameOf(window.document.getElementById("host")), "")
  assert.equal(editorModule.iconNameOf(window.document.getElementById("plain")), "")
  assert.equal(editorModule.iconNameOf(null), "")
})

check("the layer row reads the icon's name, not `svg` and not its component", () => {
  const resolver = editorModule.getResolver(bridge)
  assert.equal(resolver.meta(window.document.getElementById("glyph")).name, "Compass")
  assert.equal(resolver.meta(window.document.getElementById("plain")).name, "svg")
})

await checkAsync("the set loads once, however many icons are selected", async () => {
  iconRequests = 0
  const [first, second] = await Promise.all([
    editorModule.loadIconSet("/__designlayer"),
    editorModule.loadIconSet("/__designlayer"),
  ])
  assert.equal(iconRequests, 1, "each selection re-fetched 100KB of path data")
  assert.equal(first.length, 152)
  assert.equal(second, first)
  assert.equal(editorModule.loadedIconSet().length, 152)
})

console.log("\nSwapping a variant")

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const right = window.document.createElement("aside")
right.setAttribute("data-designlayer", "")
window.document.body.append(right)
const editor = editorModule.createContext(bridge, {
  overlay: slot(),
  toolbar: slot(),
  left: slot(),
  right,
})
const writer = editorModule.createWriter(bridge)
const glyph = window.document.getElementById("glyph")
const selection = {
  element: glyph,
  tagName: "svg",
  componentName: "CompassIcon",
  source: { filePath: "", lineNumber: 0, columnNumber: 0, componentName: "CompassIcon" },
  key: "glyph",
}
const variant = (name) => hostIcons.icons.find((icon) => icon.name === name)

const resetGlyph = () => {
  history.resetHistory()
  toasts.length = 0
  glyph.setAttribute(ICON_ATTRIBUTE, "Compass")
  glyph.setAttribute("fill", "none")
  glyph.setAttribute("stroke", "currentColor")
  glyph.innerHTML = '<path d="M12 2"></path>'
}

check("a swap redraws the glyph, renames it, and is one undoable step", () => {
  resetGlyph()
  const before = glyph.innerHTML
  const heart = variant("Heart")
  assert.ok(heart, "the host set should contain Heart")

  writer.applyIcon(selection, heart)
  assert.equal(glyph.getAttribute(ICON_ATTRIBUTE), "Heart")
  assert.notEqual(glyph.innerHTML, before)
  assert.ok(glyph.innerHTML.length > 0, "the swap emptied the glyph")

  const after = glyph.innerHTML
  const afterFill = glyph.getAttribute("fill")
  assert.equal(history.undo(), "Swap icon to Heart")
  assert.equal(glyph.getAttribute(ICON_ATTRIBUTE), "Compass")
  assert.equal(glyph.innerHTML, before, "undo did not restore the exact markup")
  assert.equal(glyph.getAttribute("fill"), "none", "undo left the swapped paint behind")
  assert.equal(history.canUndo(), false, "one swap recorded more than one step")

  assert.equal(history.redo(), "Swap icon to Heart")
  assert.equal(glyph.innerHTML, after)
  assert.equal(glyph.getAttribute("fill"), afterFill)
})

check("the swap is silent, and lands in the ledger for the agent", () => {
  editorModule.clearPreviewOnly()
  resetGlyph()
  // Preview-only is the icon lane's normal outcome, not a loss: the swap goes
  // to the Changes tab for the agent. A toast per swap narrated direct
  // manipulation the canvas already shows.
  writer.applyIcon(selection, variant("Heart"))
  writer.applyIcon(selection, variant("Compass"))
  assert.equal(toasts.length, 0, toasts.map((toast) => toast.message).join(" | "))
  assert.ok(editorModule.previewOnlyChanges().length > 0, "the swap never reached the ledger")
  editorModule.clearPreviewOnly()
})

check("the swap is in the change ledger BEFORE the history event fires", () => {
  // The toolbar repaints on the history event and decides there whether "Copy
  // change prompts" is live, by reading this ledger. Recorded after `record`,
  // an icon swap — the one change that can ONLY reach source through an agent —
  // left that button disabled: the swap painted, Undo lit up, and the button
  // holding the prompt for it stayed grey until some later, unrelated repaint.
  editorModule.clearPreviewOnly()
  resetGlyph()
  let atEvent = null
  const stop = history.onHistoryChange(() => {
    atEvent = editorModule.previewOnlyChanges()
  })
  writer.applyIcon(selection, variant("Heart"))
  stop()

  assert.notEqual(atEvent, null, "the swap pushed no history step at all")
  assert.equal(atEvent.length, 1, "the ledger was empty when the toolbar read it")
  assert.equal(atEvent[0].property, "icon")
  assert.equal(atEvent[0].from, "Compass")
  assert.equal(atEvent[0].to, "Heart")
  editorModule.clearPreviewOnly()
})

check("re-picking the icon already drawn is not a step", () => {
  resetGlyph()
  writer.applyIcon(selection, variant("Compass"))
  assert.equal(history.canUndo(), false)
  assert.equal(toasts.length, 0)
})

check("an element that is not an icon cannot be swapped", () => {
  resetGlyph()
  const host = window.document.getElementById("host")
  const markup = host.innerHTML
  writer.applyIcon({ ...selection, element: host }, variant("Heart"))
  assert.equal(host.innerHTML, markup)
  assert.equal(history.canUndo(), false)
})

console.log("\nThe inspector row")

const paint = () =>
  new Promise((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
  )
const iconField = () => right.querySelector('[data-de-field="icon.name"]')

await checkAsync("selecting an icon offers the variant field, named by the icon", async () => {
  resetGlyph()
  editorModule.installInspector(editor)
  editor.select(glyph)
  await paint()

  const field = iconField()
  assert.ok(field, "no icon field for a selected icon")
  // Figma puts an instance's variant properties first, under the layer name:
  // the first question about a placed symbol is which symbol it is.
  const sections = Array.from(right.querySelectorAll("[data-de-field]")).map((node) =>
    node.getAttribute("data-de-field")
  )
  assert.equal(sections[0], "icon.name")
  assert.match(field.textContent, /Compass/)
  assert.equal(/[.]json|<svg|currentColor/.test(field.textContent), false, "code leaked into the row")
})

await checkAsync("a plain element has no icon field at all", async () => {
  editor.select(window.document.getElementById("host"))
  await paint()
  assert.equal(iconField(), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
dom.window.close()
process.exit(failed === 0 ? 0 : 1)
