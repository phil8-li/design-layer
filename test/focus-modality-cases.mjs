/**
 * The focus ring belongs to the keyboard, and to nothing else.
 *
 * The editor forces focus on every pointerdown over its own chrome, because the
 * vendor's document guard eats the native default action. That force is script
 * focus, and an engine reading a script focus keeps `:focus-visible` on — which
 * is how every button a designer CLICKED came to wear the 2px accent ring that
 * is supposed to mean "you are navigating by keyboard".
 *
 * These cases pin the two halves of the answer in `core/focus`: the modality
 * handed to each focus call, and the live rule that covers the control which
 * was already focused when the click landed. They also re-read the stylesheets,
 * because the whole design rests on every ring being keyed on `:focus-visible`
 * — one bare `:focus { outline }` anywhere and the modality is moot.
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom

for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "PointerEvent",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
for (const key of ["addEventListener", "removeEventListener"]) {
  Object.defineProperty(globalThis, key, {
    value: window[key].bind(window),
    configurable: true,
    writable: true,
  })
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { focusControl, installFocusModality, usingKeyboard } from "./src/core/focus"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const focusModule = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)
const { focusControl, installFocusModality, usingKeyboard } = focusModule

/**
 * What the last focus call was told.
 *
 * jsdom implements neither `:focus-visible` nor the `focusVisible` option, so
 * the ring itself cannot be observed here — the browser is where that was
 * measured. What a suite CAN hold is the instruction: every script focus this
 * editor performs has to carry the modality, and the bug was that none of them
 * did.
 */
let lastFocusOptions
const nativeFocus = window.HTMLElement.prototype.focus
window.HTMLElement.prototype.focus = function record(options) {
  lastFocusOptions = options
  return nativeFocus.call(this, options)
}

const chromeButton = () => {
  const node = window.document.createElement("button")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}

const modality = () => window.document.documentElement.getAttribute("data-de-modality")
const press = (key) => window.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }))
const point = () => window.dispatchEvent(new window.Event("pointerdown", { bubbles: true }))

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

console.log("\nfocus modality")

const release = installFocusModality()

await check("boots as a pointer, because nobody has typed yet", () => {
  assert.equal(modality(), "pointer")
  assert.equal(usingKeyboard(), false, "a fresh editor claims the keyboard is driving")
})

await check("a click-time focus asks for no ring", () => {
  point()
  focusControl(chromeButton())
  assert.equal(lastFocusOptions.focusVisible, false, "a pointer gesture still asked for the ring")
})

await check("a key-time focus asks for the ring", () => {
  press("Tab")
  assert.equal(modality(), "keyboard")
  focusControl(chromeButton())
  assert.equal(
    lastFocusOptions.focusVisible,
    true,
    "keyboard navigation lost the ring, which is the accessibility half of this"
  )
})

await check("the pointer takes it back on the next press", () => {
  point()
  assert.equal(modality(), "pointer")
  focusControl(chromeButton())
  assert.equal(lastFocusOptions.focusVisible, false)
})

await check("the caller's own options survive", () => {
  focusControl(chromeButton(), { preventScroll: true })
  assert.equal(lastFocusOptions.preventScroll, true, "preventScroll was dropped, so panels will jump")
})

await check("nothing to focus is not an error", () => {
  assert.doesNotThrow(() => focusControl(null))
  assert.doesNotThrow(() => focusControl(undefined))
})

await check("the live rule covers the control that was already focused", () => {
  const style = window.document.getElementById("designlayer-focus-modality")
  assert.notEqual(style, null, "the modality stylesheet never went in")
  // Keyed on the attribute AND on a mark only focused chrome carries: an
  // `!important` outline reset that reached the app under edit would erase ITS
  // focus rings too.
  assert.match(style.textContent, /\[data-de-modality="pointer"\]/)
  assert.match(style.textContent, /\[data-de-focus\]:focus-visible/)
  assert.match(style.textContent, /outline: none !important/)
})

await check("the mark rides on focused chrome only, never on the app", () => {
  const ours = chromeButton()
  ours.focus()
  assert.ok(ours.hasAttribute("data-de-focus"), "focused chrome went unmarked")
  const app = window.document.createElement("button")
  window.document.body.append(app)
  app.focus()
  assert.ok(!app.hasAttribute("data-de-focus"), "the app's own control was marked")
  assert.ok(!ours.hasAttribute("data-de-focus"), "the mark outlived the focus")
})

await check("standing the editor down takes both halves with it", () => {
  release()
  assert.equal(modality(), null, "the modality attribute outlived the editor")
  assert.equal(window.document.getElementById("designlayer-focus-modality"), null)
  press("Tab")
  assert.equal(modality(), null, "a torn-down editor is still listening for keys")
})

/*
 * The stylesheets are the other half of the contract, and the cheaper half to
 * break: `:focus` paints the ring for a click no matter what the focus call
 * asked for, so one bare rule would reopen this bug on one control and nowhere
 * else — the hardest kind to notice.
 */
await check("no ring in the whole codebase is keyed on plain :focus", async () => {
  const dir = path.join(PACKAGE_DIR, "src/core/css")
  const offenders = []
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith(".ts")) continue
    const source = await fs.readFile(path.join(dir, name), "utf8")
    // Selector text only: `:focus-visible` and `:focus-within` are fine, and so
    // is a `:focus` rule that resets `outline: none` rather than drawing one.
    for (const [, selector, body] of source.matchAll(/([^{}\n]*:focus(?!-)[^{}\n]*)\{([^}]*)\}/g)) {
      if (!/outline\s*:/.test(body)) continue
      if (/outline\s*:\s*none/.test(body)) continue
      offenders.push(`${name}: ${selector.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `rings a mouse click will paint:\n       ${offenders.join("\n       ")}`)
})

/*
 * And the call sites. The helper is only worth having if the editor's own
 * forced focus goes through it — `shell.ts` is the one that put a ring on every
 * clicked button, so it is the one asserted by name.
 */
await check("the chrome focus guard forces focus through the helper", async () => {
  const source = await fs.readFile(path.join(PACKAGE_DIR, "src/shell/shell.ts"), "utf8")
  assert.match(source, /focusControl\(focusable, \{ preventScroll: true \}\)/)
  assert.doesNotMatch(source, /focusable\?\.focus\(/, "the guard went back to a bare focus() call")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
