/**
 * The canvas as the app's viewport.
 *
 * `shell/app-viewport.ts` rewrites the app's own stylesheet so that `vw` and
 * the width breakpoints mean the strip between the panels rather than the
 * window. Two halves, tested apart and then together:
 *
 *   - `shiftCondition` is a pure string rewrite, so the media half is pinned as
 *     text. Everything that can go wrong with it — a `device-width` caught by a
 *     loose `width`, a height shifted along with a width, a `rem` added to a
 *     pixel count — is a wrong string long before it is a wrong layout.
 *   - The CSSOM half runs against real `<style>` elements in jsdom, which parses
 *     declarations and media rules and accepts a `calc()` written back into
 *     them. It lays nothing out, so what is asserted is the RULE, not a width.
 *
 * The last case mounts the actual shell, because the thing that has to hold in
 * the product is that closing a panel re-asks the question — and that wiring is
 * a subscription this file would otherwise be taking on trust.
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom

/* The shell mounts panels, and they need both of these. See `resize-cases`. */
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.Element.prototype.setPointerCapture = function setPointerCapture() {}
window.Element.prototype.releasePointerCapture = function releasePointerCapture() {}

for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLStyleElement",
  "HTMLLinkElement",
  "SVGElement",
  "SVGSVGElement",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "AbortController",
  "AbortSignal",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

/** The rail spans the window; `motion-panels` measures both. See `resize-cases`. */
const VIEWPORT = 1440
Object.defineProperty(window.Element.prototype, "clientWidth", {
  configurable: true,
  get() {
    return this.classList?.contains("de-rail") ? VIEWPORT : 0
  },
})
const nativeComputedStyle = window.getComputedStyle.bind(window)
const measureAs = (element, pseudo) => {
  if (element?.classList?.contains("de-rail-fill")) {
    const taken = [...element.parentElement.children]
      .filter((node) => node !== element && !node.hidden)
      .reduce((sum, node) => sum + (Number.parseFloat(node.style.width) || 0), 0)
    return { width: `${Math.max(0, VIEWPORT - taken)}px` }
  }
  return nativeComputedStyle(element, pseudo)
}
window.getComputedStyle = measureAs
for (const key of ["addEventListener", "removeEventListener"]) {
  Object.defineProperty(globalThis, key, {
    value: window[key].bind(window),
    configurable: true,
    writable: true,
  })
}
Object.defineProperty(globalThis, "getComputedStyle", {
  value: measureAs,
  configurable: true,
  writable: true,
})

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { installAppViewport, shiftCondition } from "./src/shell/app-viewport"
      export { mountShell } from "./src/shell/shell"
      export { setState } from "./src/core/store"
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

let failures = 0
async function check(name, run) {
  try {
    await run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

const frame = () =>
  new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))

/** Past the catch-up pass, which a mutation schedules as a task. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

/** A stylesheet in the app's document, with an owner this can identify. */
const addSheet = (css, { ours = false } = {}) => {
  const style = window.document.createElement("style")
  if (ours) style.id = "designlayer-shell-style"
  style.textContent = css
  window.document.head.append(style)
  return style
}

const insets = (left, right) => {
  const style = window.document.documentElement.style
  style.setProperty("--de-left", `${left}px`)
  style.setProperty("--de-right", `${right}px`)
}

const reset = () => {
  for (const style of [...window.document.head.querySelectorAll("style")]) style.remove()
  window.document.documentElement.style.removeProperty("--de-left")
  window.document.documentElement.style.removeProperty("--de-right")
}

/** Every rule in the document, whoever owns it. */
const ruleFor = (selector) => {
  for (const sheet of window.document.styleSheets) {
    for (const rule of sheet.cssRules) if (rule.selectorText === selector) return rule
  }
  return null
}

const mediaTexts = () => {
  const found = []
  for (const sheet of window.document.styleSheets) {
    for (const rule of sheet.cssRules) if (rule.media) found.push(rule.media.mediaText)
  }
  return found
}

// ───────────────────────────────────────── the breakpoint rewrite, as text ───

await check("a pixel width feature is shifted by what the panels are holding", () => {
  assert.equal(editor.shiftCondition("(max-width: 1024px)", 500), "(max-width: 1524px)")
  assert.equal(editor.shiftCondition("(min-width: 768px)", 240), "(min-width: 1008px)")
  assert.equal(
    editor.shiftCondition("screen and (max-width:900px)", 260),
    "screen and (max-width:1160px)"
  )
})

/*
 * The canvas IS the window when nothing is holding any of it, and the rewrite
 * has to say so exactly — an author's condition that came back "the same but
 * with `+ 0px` in it" would be a different string in every diff and a different
 * cache key in every engine.
 */
await check("no inset means the author's own condition, character for character", () => {
  assert.equal(editor.shiftCondition("(max-width: 1024px)", 0), "(max-width: 1024px)")
})

await check("a height, and a device width, are left alone", () => {
  assert.equal(editor.shiftCondition("(max-height: 600px)", 500), "(max-height: 600px)")
  assert.equal(editor.shiftCondition("(max-device-width: 600px)", 500), "(max-device-width: 600px)")
  assert.equal(
    editor.shiftCondition("(max-width: 1024px) and (max-height: 800px)", 500),
    "(max-width: 1524px) and (max-height: 800px)"
  )
})

await check("range syntax shifts on whichever side the length is", () => {
  assert.equal(editor.shiftCondition("(width <= 600px)", 500), "(width <= 1100px)")
  assert.equal(editor.shiftCondition("(600px >= width)", 500), "(1100px >= width)")
  assert.equal(
    editor.shiftCondition("(400px <= width <= 800px)", 100),
    "(500px <= width <= 900px)"
  )
})

/*
 * A `rem` in a media query is not the root element's `rem` — it is the INITIAL
 * font size — so this file is the wrong place to turn one into pixels. Handing
 * the addition to `calc()` keeps the engine's answer.
 */
await check("a length in another unit is added to, not converted", () => {
  assert.equal(editor.shiftCondition("(max-width: 48rem)", 500), "(max-width: calc(48rem + 500px))")
})

/*
 * Anything that is not a plain length is left exactly as written. A query this
 * rewrote into something unparseable does not throw — it becomes `not all`, and
 * silently takes a block of the app's styles with it.
 */
await check("a value that is not a plain length is not touched", () => {
  assert.equal(
    editor.shiftCondition("(max-width: calc(100% - 10px))", 500),
    "(max-width: calc(100% - 10px))"
  )
  assert.equal(editor.shiftCondition("(orientation: landscape)", 500), "(orientation: landscape)")
})

// ──────────────────────────────────────────── the rewrite, against the DOM ───

await check("an app sized in viewport units is re-pointed at the canvas", () => {
  reset()
  addSheet(".app { width: 100vw; max-width: 50dvw; margin-left: -10vi; }")
  insets(240, 260)
  const viewport = editor.installAppViewport()
  const rule = ruleFor(".app")
  assert.equal(rule.style.getPropertyValue("width"), "calc(var(--de-vw, 1vw) * 100)")
  assert.equal(rule.style.getPropertyValue("max-width"), "calc(var(--de-vw, 1vw) * 50)")
  assert.equal(rule.style.getPropertyValue("margin-left"), "calc(var(--de-vw, 1vw) * -10)")
  viewport.destroy()
  assert.equal(rule.style.getPropertyValue("width"), "100vw")
  assert.equal(rule.style.getPropertyValue("margin-left"), "-10vi")
})

await check("a vw inside a calc keeps the rest of the expression", () => {
  reset()
  addSheet(".app { width: calc(100vw - var(--drawer, 0px)); }")
  const viewport = editor.installAppViewport()
  assert.equal(
    ruleFor(".app").style.getPropertyValue("width"),
    "calc(calc(var(--de-vw, 1vw) * 100) - var(--drawer, 0px))"
  )
  viewport.destroy()
})

/*
 * The chrome's own sheet says `100vw` about the WINDOW on purpose — the toolbar
 * centres on it and clamps itself against the panels by hand. Redefining its
 * `vw` to the canvas would make that a circular definition of where the bar is.
 */
await check("the editor's own stylesheet is not rewritten", () => {
  reset()
  addSheet(".de-toolbar { max-width: calc(100vw - 24px); }", { ours: true })
  const viewport = editor.installAppViewport()
  assert.equal(ruleFor(".de-toolbar").style.getPropertyValue("max-width"), "calc(100vw - 24px)")
  viewport.destroy()
})

await check("a second pass does not nest one rewrite inside the last", () => {
  reset()
  addSheet(".app { width: 100vw; }")
  const viewport = editor.installAppViewport()
  viewport.rescan()
  viewport.rescan()
  assert.equal(ruleFor(".app").style.getPropertyValue("width"), "calc(var(--de-vw, 1vw) * 100)")
  viewport.destroy()
  assert.equal(ruleFor(".app").style.getPropertyValue("width"), "100vw")
})

await check("the app's breakpoints are asked of the canvas", () => {
  reset()
  addSheet("@media (max-width: 1024px) { .app { display: none; } }")
  insets(240, 260)
  const viewport = editor.installAppViewport()
  assert.deepEqual(mediaTexts(), ["(max-width: 1524px)"])
  viewport.destroy()
  assert.deepEqual(mediaTexts(), ["(max-width: 1024px)"])
})

/*
 * A stylesheet arrives late all the time — a route's chunk, an HMR update, a
 * component that injects its own. What it must not do is arrive holding the
 * WINDOW's thresholds and keep them.
 */
await check("a stylesheet that arrives later is caught up with the rest", async () => {
  reset()
  addSheet(".app { width: 100vw; }")
  insets(240, 260)
  const viewport = editor.installAppViewport()
  addSheet("@media (max-width: 800px) { .late { display: none; } } .late { width: 100vw; }")
  await tick()
  assert.deepEqual(mediaTexts(), ["(max-width: 1300px)"])
  assert.equal(ruleFor(".late").style.getPropertyValue("width"), "calc(var(--de-vw, 1vw) * 100)")
  viewport.destroy()
})

/*
 * Filling a `<style>` that is already in the document is how Angular's runtime
 * ships a component's CSS, and how every `textContent =` does it. The mutation
 * it produces adds a TEXT node — not a `<style>` — so a watch that only looked
 * at added elements missed it, and was caught out only by pages where the
 * element happened to be inserted in the same batch as its contents. Measured
 * on a live Angular app: one component's breakpoint left at the window's width
 * while every other breakpoint on the page had moved to the canvas.
 */
await check("a stylesheet filled after it was appended is caught too", async () => {
  reset()
  const empty = window.document.createElement("style")
  window.document.head.append(empty)
  insets(240, 260)
  const viewport = editor.installAppViewport()
  empty.textContent = "@media (max-width: 800px) { .filled { display: none; } }"
  await tick()
  assert.deepEqual(mediaTexts(), ["(max-width: 1300px)"])
  viewport.destroy()
})

/*
 * The panels moving is the whole point, and this is the only case that proves
 * the two halves are connected: the shell publishes its insets, and the
 * breakpoints follow without anyone calling `rescan`.
 */
await check("closing a panel re-asks every breakpoint", async () => {
  reset()
  addSheet("@media (max-width: 1024px) { .app { display: none; } }")
  editor.setState({ layersOpen: true, inspectorOpen: true, chromeHidden: false })
  const shell = editor.mountShell()
  const viewport = editor.installAppViewport()
  const held = mediaTexts()[0]
  assert.notEqual(held, "(max-width: 1024px)", "the panels are open and nothing shifted")

  editor.setState({ inspectorOpen: false })
  await frame()
  const narrower = mediaTexts()[0]
  assert.notEqual(narrower, held, "the inspector closed and the breakpoint did not move")

  editor.setState({ chromeHidden: true })
  await frame()
  assert.equal(
    mediaTexts()[0],
    "(max-width: 1024px)",
    "the editor stood down and the app kept the editor's thresholds"
  )
  viewport.destroy()
  shell.destroy()
})

/*
 * A rescan only walks sheets that are new or changed size, so a rule a library
 * inserts through the CSSOM has to move the count enough to be seen.
 */
await check("a rule inserted into a scanned sheet is caught on the next pass", () => {
  reset()
  const style = addSheet(".app { width: 100vw; }")
  const viewport = editor.installAppViewport()
  style.sheet.insertRule(".inserted { width: 50vw; }", 1)
  viewport.rescan()
  assert.equal(ruleFor(".inserted").style.getPropertyValue("width"), "calc(var(--de-vw, 1vw) * 50)")
  viewport.destroy()
  assert.equal(ruleFor(".inserted").style.getPropertyValue("width"), "50vw")
})

/*
 * An HMR update replaces a sheet wholesale. The old sheet's media lists are
 * garbage, and holding them meant every inset change wrote into dead objects
 * and every hot update added another set that was never let go.
 */
await check("a replaced stylesheet's breakpoints are let go", async () => {
  reset()
  const style = addSheet("@media (max-width: 1024px) { .old { display: none; } }")
  insets(240, 260)
  const viewport = editor.installAppViewport()
  const stale = style.sheet.cssRules[0].media
  assert.equal(stale.mediaText, "(max-width: 1524px)")
  style.remove()
  addSheet("@media (max-width: 800px) { .new { display: none; } }")
  await tick()
  insets(0, 0)
  viewport.rescan()
  assert.equal(stale.mediaText, "(max-width: 1524px)", "a detached sheet was still being written")
  assert.deepEqual(mediaTexts(), ["(max-width: 800px)"])
  viewport.destroy()
})

/*
 * The editor's own `<style>` writes — the board's view-transition sheet on
 * every open and close, panel rebuilds — must not wake a pass over the app.
 */
await check("the editor's own style insertions do not schedule a pass", async () => {
  reset()
  insets(240, 260)
  const viewport = editor.installAppViewport()
  // An app rule edited through the CSSOM, which no mutation reports: only a
  // pass would rewrite it, so a pass that ran is visible here.
  const app = addSheet(".app { width: 10px; }")
  await tick()
  app.sheet.insertRule(".probe { width: 100vw; }", 1)
  const ours = window.document.createElement("style")
  ours.setAttribute("data-designlayer", "")
  ours.id = "designlayer-board-vt-style"
  ours.textContent = ".x { color: red; }"
  window.document.head.append(ours)
  ours.textContent = ".x { color: blue; }"
  await tick()
  assert.equal(ruleFor(".probe").style.getPropertyValue("width"), "100vw")
  viewport.rescan()
  assert.equal(ruleFor(".probe").style.getPropertyValue("width"), "calc(var(--de-vw, 1vw) * 100)")
  viewport.destroy()
})

await check("the canvas unit is declared, and reads the insets the shell writes", () => {
  const rule = /--de-vw:\s*([^;]+);/.exec(editor.shellCss)
  assert.ok(rule, "--de-vw is never declared, so every rewrite falls back to 1vw")
  assert.match(rule[1], /100vw/)
  assert.match(rule[1], /var\(--de-left\)/)
  assert.match(rule[1], /var\(--de-right\)/)
})

reset()

if (failures > 0) {
  console.error(`\n${failures} app viewport case(s) failed`)
  process.exit(1)
}
console.log("\napp viewport cases passed")
