/**
 * The canvas context menu (`src/canvas/layer-menu.ts`): Figma's right-click
 * menu with the "Select layer" stack as a submenu.
 *
 * The real canvas lane is mounted over a jsdom page and driven with genuine
 * events. Commands are stubbed through the real registry, so a case proves the
 * item reached the command by name, and shortcut labels are compared against
 * the keymap from the same bundle, so a second copy of a chord cannot pass.
 *
 * Usage: node test/context-menu-cases.mjs
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

// ── Fixture ────────────────────────────────────────────────────────────────

const MARKUP = `
<div id="root">
  <section id="cardA" class="card"><h2 id="titleA" class="title">A</h2><button id="buyA" class="btn primary">Buy</button></section>
  <section id="cardB" class="card"><h2 id="titleB" class="title">B</h2><button id="buyB" class="primary btn">Buy</button></section>
  <div id="row" style="display: flex"><span id="leaf">x</span><button id="plain" class="btn">Go</button></div>
</div>`

/** `[componentName, ...stack frames as "Name@line"]`, nearest-first. */
const SOURCE = {
  root: ["Page", "Page@1"],
  cardA: ["Card", "Card@10", "Page@3"],
  titleA: ["Card", "Card@10", "Page@3"],
  buyA: ["Card", "Card@10", "Page@3"],
  cardB: ["Card", "Card@10", "Page@4"],
  titleB: ["Card", "Card@10", "Page@4"],
  buyB: ["Card", "Card@10", "Page@4"],
  row: ["Page", "Page@1"],
  leaf: ["Page", "Page@1"],
  plain: ["Page", "Page@1"],
}

function elementInfo(element) {
  const entry = element?.id ? SOURCE[element.id] : null
  if (!entry) return null
  const [componentName, ...frames] = entry
  const stack = frames.map((frame) => {
    const [name, line] = frame.split("@")
    return { componentName: name, filePath: `src/${name}.tsx`, lineNumber: Number(line), columnNumber: 1 }
  })
  return {
    tagName: element.tagName.toLowerCase(),
    componentName,
    filePath: stack[0].filePath,
    lineNumber: stack[0].lineNumber,
    columnNumber: 1,
    stack,
  }
}

function installDom() {
  const { window } = new JSDOM(`<!doctype html><html><body>${MARKUP}</body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
  })
  // jsdom performs no layout and has no hit-testing: one 100px box for every
  // element, and the stack each case declares.
  window.document.elementsFromPoint = () => window.__stack ?? []
  window.Element.prototype.getBoundingClientRect = function rect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
  }
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
    "MouseEvent",
    "PointerEvent",
    "KeyboardEvent",
    "Event",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "getComputedStyle",
  ]) {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
  }
  return window
}

/** One bundle, so the store, the command registry and the keymap are shared. */
async function load(contents) {
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: { contents, resolveDir: PACKAGE_DIR, loader: "ts" },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  )
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── Cases ──────────────────────────────────────────────────────────────────

const window = installDom()
Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true })
const copied = []
Object.defineProperty(window.navigator, "clipboard", {
  value: { writeText: async (text) => void copied.push(text) },
  configurable: true,
})

const lib = await load(`
  export { createContext } from "./src/core/context"
  export { installCanvas } from "./src/canvas/index"
  export { getState, setState } from "./src/core/store"
  export { registerCommand } from "./src/core/commands"
  export { SHORTCUTS, chordLabel } from "./src/core/keymap"
  export { codeText, elementCode } from "./src/core/element-code"
  export { forgetSiblings } from "./src/core/arrange"
  export { getResolver } from "./src/core/resolve"
`)
const { getState, setState, registerCommand, SHORTCUTS, chordLabel } = lib

const toasts = []
const listeners = new Set()
let siblings = [10, 99]
const bridge = {
  elementInfo,
  toast: (message, kind = "info") => toasts.push([message, kind]),
  store: {
    getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
    viewportToPage: (x, y) => ({ x, y }),
    pageToViewport: (x, y) => ({ x, y }),
  },
  refreshGeometry() {},
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  // The server answers on a later task, as the real socket does.
  send(message) {
    if (message.type !== "getSiblings") return
    setTimeout(() => {
      for (const fn of [...listeners]) {
        fn({ type: "siblingsList", siblings: siblings.map((lineNumber) => ({ lineNumber })) })
      }
    }, 0)
  },
}
const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const context = lib.createContext(bridge, { overlay: slot(), toolbar: slot(), left: slot(), right: slot() })
lib.installCanvas(context)
context.setTool("move")
const resolver = lib.getResolver(bridge)

// Stubs through the real registry, registered after the canvas so they win.
const ran = []
const COMMANDS = [
  "arrange.front",
  "arrange.forward",
  "arrange.backward",
  "arrange.back",
  "layout.auto.add",
  "layout.auto.remove",
  "select.hide",
  "select.lock",
  "element.delete",
]
for (const command of COMMANDS) registerCommand(command, () => ran.push(command))

const $ = (name) => window.document.getElementById(name)
const names = () => getState().selection.map((entry) => entry.element.id)
const menu = () => window.document.querySelector(".de-ctx-menu")
const submenu = () => window.document.querySelector(".de-ctx-submenu")
const items = () => Array.from(menu().querySelectorAll(":scope > .de-ctx-item"))
const itemNamed = (label) => items().find((node) => node.querySelector(".de-ctx-label").textContent === label)
const labels = () => items().map((node) => node.querySelector(".de-ctx-label").textContent)
const key = (k) => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }))
const active = () => window.document.activeElement

function rightClick(element, init = {}) {
  const stack = []
  for (let node = element; node && node !== window.document.body; node = node.parentElement) stack.push(node)
  window.__stack = stack
  element.dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, ...init })
  )
}

function reset() {
  if (menu().style.display === "block") key("Escape")
  setState({ selection: [], scope: null, hovered: null, locked: new Set() })
  ran.length = 0
  copied.length = 0
  toasts.length = 0
  lib.forgetSiblings()
}

console.log("\nContext menu — structure")

await check("groups appear in Figma's order, separated by hairlines", () => {
  reset()
  rightClick($("buyA"))
  assert.equal(menu().style.display, "block")
  assert.equal(menu().getAttribute("role"), "menu")
  assert.deepEqual(labels(), [
    "Select layer",
    "Copy as code",
    "Copy classes",
    "Bring to front",
    "Bring forward",
    "Send backward",
    "Send to back",
    "Add auto layout",
    "Select matching layers",
    "Hide",
    "Lock",
    "Delete",
  ])
  assert.equal(menu().querySelectorAll(':scope > [role="separator"]').length, 5)
  for (const node of items()) assert.equal(node.getAttribute("role"), "menuitem")
  const trigger = itemNamed("Select layer")
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu")
  assert.equal(trigger.getAttribute("aria-expanded"), "false")
})

await check("shortcuts are read from the keymap, and only commands with a key show one", () => {
  reset()
  rightClick($("buyA"))
  const expected = {
    "Bring to front": "arrange.front",
    "Bring forward": "arrange.forward",
    "Send backward": "arrange.backward",
    "Send to back": "arrange.back",
    "Add auto layout": "layout.auto.add",
    Hide: "select.hide",
    Lock: "select.lock",
    Delete: "element.delete",
  }
  for (const node of items()) {
    const label = node.querySelector(".de-ctx-label").textContent
    const shown = node.querySelector(".de-ctx-shortcut")?.textContent ?? ""
    const command = expected[label]
    const chord = command ? SHORTCUTS.find((entry) => entry.command === command).chord : null
    assert.equal(shown, chord ? chordLabel(chord) : "", `${label} shows "${shown}"`)
  }
  assert.equal(itemNamed("Bring forward").querySelector(".de-ctx-shortcut").textContent, "⌘]")
})

console.log("\nContext menu — selection")

await check("right-click selects what a plain click would, when it is not selected", () => {
  reset()
  rightClick($("titleA"))
  const expected = resolver.resolve($("titleA"), null)
  assert.ok(expected)
  assert.deepEqual(names(), [expected.id])
})

await check("right-click inside a multi-selection keeps the whole set", () => {
  reset()
  context.selectMany([$("buyA"), $("buyB")])
  rightClick($("buyB"))
  assert.deepEqual(names(), ["buyA", "buyB"])
})

await check("the stack is a submenu whose rows still select their layer and scope", () => {
  reset()
  rightClick($("buyA"))
  itemNamed("Select layer").dispatchEvent(new window.PointerEvent("pointerenter"))
  assert.equal(submenu().style.display, "block")
  assert.equal(itemNamed("Select layer").getAttribute("aria-expanded"), "true")
  const rows = Array.from(submenu().querySelectorAll(".de-layer-menu-row"))
  assert.deepEqual(
    rows.map((row) => row.textContent),
    window.__stack.slice().reverse().map((node) => resolver.meta(node).name)
  )
  const deepest = rows.at(-1)
  deepest.dispatchEvent(new window.PointerEvent("pointerenter"))
  assert.equal(getState().hovered, $("buyA"))
  deepest.click()
  assert.equal(menu().style.display, "none")
  assert.deepEqual(names(), ["buyA"])
  assert.equal(getState().scope, resolver.layerParent($("buyA")))
  assert.equal(getState().hovered, null)
})

await check("Select matching layers selects instances of the same component", () => {
  reset()
  context.selectMany([$("cardA")])
  rightClick($("cardA"))
  itemNamed("Select matching layers").click()
  assert.deepEqual(names(), ["cardA", "cardB"])
})

await check("Select matching layers matches tag and class list, order ignored", () => {
  reset()
  // `buyA` sits inside Card but is not its root, so it matches on classes.
  context.selectMany([$("buyA")])
  rightClick($("buyA"))
  itemNamed("Select matching layers").click()
  assert.deepEqual(names(), ["buyA", "buyB"])
})

await check("Select matching layers is off when nothing else matches", () => {
  reset()
  context.selectMany([$("plain")])
  rightClick($("plain"))
  assert.equal(itemNamed("Select matching layers").getAttribute("aria-disabled"), "true")
})

console.log("\nContext menu — actions")

await check("each command item runs its command by name", () => {
  const cases = [
    ["Bring to front", "arrange.front", "cardB"],
    ["Send to back", "arrange.back", "cardA"],
    ["Send backward", "arrange.backward", "cardA"],
    ["Bring forward", "arrange.forward", "cardB"],
    ["Add auto layout", "layout.auto.add", "cardA"],
    ["Remove auto layout", "layout.auto.remove", "row"],
    ["Hide", "select.hide", "cardA"],
    ["Lock", "select.lock", "cardA"],
    ["Delete", "element.delete", "cardA"],
  ]
  for (const [label, command, target] of cases) {
    reset()
    siblings = [10, 99]
    if (target === "cardB") siblings = [5, 10]
    context.selectMany([$(target)])
    rightClick($(target))
    const node = itemNamed(label)
    assert.ok(node, `${label} is in the menu for #${target}`)
    node.click()
    assert.deepEqual(ran, [command], `${label} ran ${ran.join(", ") || "nothing"}`)
    assert.equal(menu().style.display, "none")
  }
  siblings = [10, 99]
})

await check("arrange items turn off at the end of the list once the server answers", async () => {
  reset()
  context.selectMany([$("cardA")])
  rightClick($("cardA"))
  // Unknown list: on, since the command is a no-op where it cannot go.
  assert.equal(itemNamed("Bring to front").getAttribute("aria-disabled"), null)
  await tick()
  await tick()
  assert.equal(itemNamed("Bring to front").getAttribute("aria-disabled"), "true")
  assert.equal(itemNamed("Bring forward").getAttribute("aria-disabled"), "true")
  assert.equal(itemNamed("Send backward").getAttribute("aria-disabled"), null)
  assert.equal(itemNamed("Send to back").getAttribute("aria-disabled"), null)
  itemNamed("Bring to front").click()
  assert.deepEqual(ran, [])
  assert.equal(menu().style.display, "block")
})

await check("arrange is off for a layer the engine cannot move", () => {
  reset()
  context.selectMany([$("leaf")])
  rightClick($("leaf"))
  for (const label of ["Bring to front", "Bring forward", "Send backward", "Send to back"]) {
    assert.equal(itemNamed(label).getAttribute("aria-disabled"), "true", label)
  }
})

await check("auto layout shows the one that applies, off for an element with no children", () => {
  reset()
  context.selectMany([$("row")])
  rightClick($("row"))
  assert.ok(itemNamed("Remove auto layout"))
  assert.equal(itemNamed("Add auto layout"), undefined)
  reset()
  context.selectMany([$("leaf")])
  rightClick($("leaf"))
  assert.equal(itemNamed("Add auto layout").getAttribute("aria-disabled"), "true")
})

await check("Lock reads Unlock when the whole selection is locked", () => {
  reset()
  context.selectMany([$("buyA")])
  setState({ locked: new Set([$("buyA")]) })
  rightClick($("buyA"))
  assert.ok(itemNamed("Unlock"))
})

await check("Copy as code copies the Code tab's JSX and says so", async () => {
  reset()
  context.selectMany([$("buyA")])
  rightClick($("buyA"))
  itemNamed("Copy as code").click()
  await tick()
  const expected = lib.codeText(lib.elementCode(getState().selection[0], "jsx"))
  assert.deepEqual(copied, [expected])
  assert.match(expected, /<button/)
  assert.deepEqual(toasts, [["Copied JSX", "info"]])
})

await check("Copy classes copies the class list, and is off without one", async () => {
  reset()
  context.selectMany([$("buyA")])
  rightClick($("buyA"))
  itemNamed("Copy classes").click()
  await tick()
  assert.deepEqual(copied, ["btn\nprimary"])
  assert.deepEqual(toasts, [["Copied classes", "info"]])
  reset()
  context.selectMany([$("leaf")])
  rightClick($("leaf"))
  assert.equal(itemNamed("Copy classes").getAttribute("aria-disabled"), "true")
})

console.log("\nContext menu — keyboard and dismissal")

await check("arrows move through enabled items, Enter runs, Escape restores focus", () => {
  reset()
  const invoker = window.document.createElement("button")
  window.document.body.append(invoker)
  invoker.focus()
  context.selectMany([$("leaf")])
  rightClick($("leaf"))
  assert.equal(active(), itemNamed("Select layer"))
  key("ArrowDown")
  // Copy classes is off for `leaf`, so the arrow skips it.
  assert.equal(active(), itemNamed("Copy as code"))
  key("ArrowDown")
  assert.notEqual(active(), itemNamed("Copy classes"))
  key("End")
  assert.equal(active(), itemNamed("Delete"))
  key("Home")
  assert.equal(active(), itemNamed("Select layer"))
  key("ArrowUp")
  assert.equal(active(), itemNamed("Delete"))
  key("Enter")
  assert.deepEqual(ran, ["element.delete"])
  assert.equal(menu().style.display, "none")
  assert.equal(active(), invoker)
  invoker.remove()
})

await check("ArrowRight opens the stack, ArrowLeft and Escape step back out", () => {
  reset()
  const invoker = window.document.createElement("button")
  window.document.body.append(invoker)
  invoker.focus()
  rightClick($("buyA"))
  key("ArrowRight")
  const rows = Array.from(submenu().querySelectorAll(".de-layer-menu-row"))
  assert.equal(submenu().style.display, "block")
  assert.equal(active(), rows[0])
  key("End")
  assert.equal(active(), rows.at(-1))
  key("ArrowLeft")
  assert.equal(submenu().style.display, "none")
  assert.equal(active(), itemNamed("Select layer"))
  key("Enter")
  assert.equal(submenu().style.display, "block")
  key("Escape")
  assert.equal(submenu().style.display, "none")
  assert.equal(menu().style.display, "block")
  key("Escape")
  assert.equal(menu().style.display, "none")
  assert.equal(active(), invoker)
  invoker.remove()
})

await check("keyboard pick from the stack selects the row", () => {
  reset()
  rightClick($("buyA"))
  key("ArrowRight")
  key("End")
  key("Enter")
  assert.equal(menu().style.display, "none")
  assert.deepEqual(names(), ["buyA"])
})

await check("hovering another item closes the stack", () => {
  reset()
  rightClick($("buyA"))
  itemNamed("Select layer").dispatchEvent(new window.PointerEvent("pointerenter"))
  assert.equal(submenu().style.display, "block")
  itemNamed("Copy as code").dispatchEvent(new window.PointerEvent("pointerenter"))
  assert.equal(submenu().style.display, "none")
})

await check("a press outside closes the menu; one inside does not", () => {
  reset()
  rightClick($("buyA"))
  itemNamed("Copy as code").dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }))
  assert.equal(menu().style.display, "block")
  window.document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }))
  assert.equal(menu().style.display, "none")
})

await check("the menu flips to stay inside the viewport", () => {
  reset()
  rightClick($("buyA"), { clientX: window.innerWidth - 20, clientY: window.innerHeight - 20 })
  // Each card measures 100px here; flipped, it ends at the pointer.
  assert.equal(menu().style.left, `${window.innerWidth - 120}px`)
  assert.equal(menu().style.top, `${window.innerHeight - 120}px`)
})

await check("right-click in interactive mode leaves the menu shut", () => {
  reset()
  setState({ interactive: true })
  rightClick($("buyA"))
  assert.equal(menu().style.display, "none")
  setState({ interactive: false })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
