/**
 * Hidden chrome is inert.
 *
 * Once the editor is hidden (⌘., the bar's hide control, the escape stop) the
 * page is the designer's again, and the one piece of the editor left to touch
 * is the launcher that brings it back. Everything else the editor drew has to
 * stop drawing, stop taking the pointer, and leave the Tab order.
 *
 * Two parts broke that, for the same reason: neither is inside the surface it
 * belongs to, so that surface's hidden state never reached it. The panel seams
 * are the panels' siblings in the rail, and stayed over the app at the panels'
 * old edges — lit on hover, draggable, focusable. The escape stop is a child of
 * the root rather than of anything that hides, and stayed in the Tab order
 * offering to hide an editor that was already hidden.
 *
 * So this suite does not name those two. It boots the chrome the way
 * `src/index.ts` does — shell, bar and both panels, in the shell's own slots —
 * hides it, and sweeps every node the editor built (`el()` stamps
 * `data-designlayer` on all of them). A part added later outside its surface
 * fails here without anyone having to know it exists.
 *
 * jsdom lays nothing out, so "takes the pointer" is read the way the browser
 * decides it before geometry: drawn at all, visible, and not
 * `pointer-events: none`. A box clipped to nothing by `clip-path: inset(50%)`
 * cannot be hit and is left to the Tab-order half.
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

const dom = new JSDOM('<!doctype html><html><head></head><body><main id="app"></main></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom

/* jsdom has no ResizeObserver, pointer capture or layout; the chrome uses all three. */
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.Element.prototype.setPointerCapture = function setPointerCapture() {}
window.Element.prototype.releasePointerCapture = function releasePointerCapture() {}
window.document.elementsFromPoint = () => []
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
  "AbortController",
  "AbortSignal",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
for (const key of ["addEventListener", "removeEventListener"]) {
  Object.defineProperty(globalThis, key, { value: window[key].bind(window), configurable: true, writable: true })
}

// The panels ask the server for apps, libraries and agent status as they mount.
const serve = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ apps: [], libraries: [], tools: [], listening: false, agents: 0 }),
})
globalThis.fetch = serve
window.fetch = serve

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { mountShell } from "./src/shell/shell"
      export { createContext } from "./src/core/context"
      export { installToolbar } from "./src/shell/toolbar"
      export { installLeftPanel } from "./src/panels/left"
      export { installInspector } from "./src/panels/inspector/index"
      export { installShortcuts } from "./src/shell/shortcuts"
      export { setState } from "./src/core/store"
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

const bridge = {
  elementInfo: () => null,
  send() {},
  toast() {},
  subscribe: () => () => {},
  store: {
    setActiveTool() {},
    hasChanges: () => false,
    buildBatchOperations: () => [],
    onStateChange() {},
    getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
    viewportToPage: (x, y) => ({ x, y }),
    pageToViewport: (x, y) => ({ x, y }),
  },
}

editor.setState({ layersOpen: true, inspectorOpen: true, chromeHidden: false, interactive: false })
const shell = editor.mountShell()
const context = editor.createContext(bridge, shell.slots)
editor.installToolbar(context)
editor.installLeftPanel(context)
editor.installInspector(context)
editor.installShortcuts(context)

const frame = () => new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 0)))
// The editor arrives by playing its exit backwards (see shell.ts); wait it out.
for (let frames = 0; shell.root.classList.contains("de-root--arriving") && frames < 30; frames++) {
  await frame()
}

// ─────────────────────────────────────────────────────────── reading ───────

/** The way back, and the one part of the chrome a hidden editor keeps. */
const LAUNCHER = ".de-launcher"

const style = (node) => window.getComputedStyle(node)

/** Out of the box tree, by itself or by an ancestor. */
const undrawn = (node) => {
  for (let at = node; at instanceof window.Element; at = at.parentElement) {
    if (at.hidden || at.hasAttribute("inert") || style(at).display === "none") return true
  }
  return false
}

/** `visibility` and `pointer-events` inherit; the nearest declaration wins. */
const inherited = (node, property, initial) => {
  for (let at = node; at instanceof window.Element; at = at.parentElement) {
    const value = style(at).getPropertyValue(property)
    if (value) return value
  }
  return initial
}

const ours = (node) => node.closest("[data-designlayer]") !== null && !node.closest(LAUNCHER)

const FOCUSABLE =
  'a[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable="true"]'

/** Chrome a Tab press can land on. */
const tabStops = () =>
  [...window.document.querySelectorAll(FOCUSABLE)].filter(
    (node) =>
      ours(node) &&
      node.getAttribute("tabindex") !== "-1" &&
      !node.disabled &&
      !undrawn(node) &&
      inherited(node, "visibility", "visible") !== "hidden"
  )

/** Chrome the pointer can land on: drawn, visible, and not handing the pointer through. */
const pointerTargets = () =>
  [...window.document.querySelectorAll("*")].filter(
    (node) =>
      ours(node) &&
      !undrawn(node) &&
      inherited(node, "visibility", "visible") !== "hidden" &&
      inherited(node, "pointer-events", "auto") !== "none" &&
      !/inset\(50%\)/.test(style(node).clipPath ?? style(node).getPropertyValue("clip-path"))
  )

const name = (node) => {
  const label = node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent.trim().slice(0, 24)
  return `${node.tagName.toLowerCase()}${[...node.classList].map((c) => `.${c}`).join("")}${label ? ` "${label}"` : ""}`
}
const list = (nodes) => nodes.slice(0, 8).map(name).join("\n         ")

// ─────────────────────────────────────────────────────────── cases ─────────

console.log("\nHidden chrome")

/*
 * The population first. A sweep that finds nothing to check passes whatever
 * the stylesheet says, so the shown editor has to offer plenty of both — and
 * the two parts that broke this before have to be among them.
 */
await check("the shown editor offers Tab stops and pointer targets to sweep", () => {
  editor.setState({ chromeHidden: false })
  const stops = tabStops()
  assert.ok(stops.length >= 10, `only ${stops.length} Tab stops in the shown chrome — the sweep has nothing to check`)
  assert.ok(pointerTargets().length >= 10, "the shown chrome takes the pointer almost nowhere")
  for (const selector of [".de-separator--left", ".de-separator--right", ".de-escape"]) {
    assert.ok(
      stops.some((node) => node.matches(selector)),
      `${selector} is not a Tab stop in the shown chrome, so the hidden case cannot see it`
    )
  }
})

await check("hidden, nothing but the launcher is a Tab stop", () => {
  editor.setState({ chromeHidden: true })
  const stops = tabStops()
  editor.setState({ chromeHidden: false })
  assert.equal(stops.length, 0, `Tab still reaches hidden chrome:\n         ${list(stops)}`)
})

await check("hidden, nothing but the launcher takes the pointer", () => {
  editor.setState({ chromeHidden: true })
  const targets = pointerTargets()
  editor.setState({ chromeHidden: false })
  assert.equal(targets.length, 0, `the pointer still lands on hidden chrome:\n         ${list(targets)}`)
})

/*
 * What was open when the editor went away goes with it.
 *
 * Menus and sheets hang off `document.body` or the overlay layer, outside
 * anything that hides, and ⌘. is not a key any of them closes on — so each one
 * stayed over the page, still clickable, until it was told. The two that live
 * in the chrome this suite boots are opened here; the layer menu and the token
 * list have the same case in `context-menu-cases.mjs` and
 * `apply-token-cases.mjs`.
 */
await check("hidden, a menu or sheet left open goes with the editor", () => {
  editor.setState({ chromeHidden: false })
  const chooser = window.document.querySelector("button.de-app-chooser")
  assert.ok(chooser, "no app chooser in the left panel to open")
  chooser.click()
  const chooserMenu = window.document.getElementById(chooser.getAttribute("aria-controls"))
  assert.equal(chooserMenu?.style.display, "block", "the app chooser did not open")
  window.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "?", code: "Slash", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
  )
  assert.ok(window.document.querySelector("dialog.de-shortcuts"), "the shortcuts sheet did not open")

  editor.setState({ chromeHidden: true })
  const menuShown = chooserMenu.style.display
  const sheet = window.document.querySelector("dialog.de-shortcuts")
  const stops = tabStops()
  const targets = pointerTargets()
  editor.setState({ chromeHidden: false })
  assert.equal(menuShown, "none", "the app chooser stayed open over the page")
  assert.equal(sheet, null, "the shortcuts sheet stayed open over the page")
  assert.equal(stops.length, 0, `Tab still reaches hidden chrome:\n         ${list(stops)}`)
  assert.equal(targets.length, 0, `the pointer still lands on hidden chrome:\n         ${list(targets)}`)
})

await check("hidden, the launcher is still there to bring it back", () => {
  editor.setState({ chromeHidden: true })
  const launcher = shell.root.querySelector(LAUNCHER)
  const reachable = launcher && !undrawn(launcher) && inherited(launcher, "visibility", "visible") !== "hidden"
  editor.setState({ chromeHidden: false })
  assert.ok(reachable, "a hidden editor has no way back")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
