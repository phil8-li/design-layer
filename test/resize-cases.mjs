/**
 * Resizable side panels: the rail, the seams, and what the app does about it.
 *
 * The resizing itself belongs to `motion-panels` and is its own project's to
 * test. What is asserted here is everything this package put around it — the
 * group the library needs in order to work at all, the seam as an accessible
 * control, the app's inset following a drag, the widths outliving the tab, and
 * the rule that a panel gives room up when the window shrinks and takes it back
 * when the window grows.
 *
 * jsdom lays nothing out, and the library measures two things: the group's
 * extent and how much room the fill has left. Both are supplied by `measureAs`
 * below rather than worked around, because a bounds check against a made-up
 * viewport is the whole point of most of these cases — a suite that skipped it
 * could not tell a clamp from a no-op.
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom

/* See `selection-shell-cases.mjs`: jsdom has no ResizeObserver and the panels need one. */
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
/* Nor pointer capture, which every seam takes for the length of a drag. */
window.Element.prototype.setPointerCapture = function setPointerCapture() {}
window.Element.prototype.releasePointerCapture = function releasePointerCapture() {}

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
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  // jsdom type-checks an AbortSignal against its own class; Node's is refused.
  "AbortController",
  "AbortSignal",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

/**
 * The viewport the library is told it has, and the only layout in this file.
 *
 * `clientWidth` answers for the rail, because that is the group's extent — what
 * a percentage maximum is a percentage OF. `getComputedStyle` answers for the
 * fill, because that is the room a drag has left, and it is derived from the
 * inline widths the resize lane has actually written rather than hard-coded:
 * that way a case that grows a panel sees the canvas shrink by the same amount,
 * which is the relationship the bounds are built on.
 */
let viewport = 1440

const px = (node) => Number.parseFloat(node.style.width) || 0

Object.defineProperty(window.Element.prototype, "clientWidth", {
  configurable: true,
  get() {
    // The rail is measured off the root element, which a fixed rail at
    // `inset: 0` matches; both answer the viewport here.
    return this.classList?.contains("de-rail") || this === window.document.documentElement ? viewport : 0
  },
})

// Boot fits against the window before the first frame, and the rail after it
// (`ready` in shell/resize.ts); `scrollbar` is a classic one's width.
let scrollbar = 0
Object.defineProperty(window, "innerWidth", {
  configurable: true,
  get: () => viewport + scrollbar,
})

const nativeComputedStyle = window.getComputedStyle.bind(window)
const measureAs = (element, pseudo) => {
  if (element?.classList?.contains("de-rail-fill")) {
    const taken = [...element.parentElement.children]
      .filter((node) => node !== element && !node.hidden)
      .reduce((sum, node) => sum + px(node), 0)
    return { width: `${Math.max(0, viewport - taken)}px` }
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
      export { mountShell } from "./src/shell/shell"
      export { getState, setState } from "./src/core/store"
      export { shellCss } from "./src/core/css"
      export { tokens } from "./src/core/tokens"
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

const { tokens } = editor
const STORAGE_KEY = "designlayer:panel-widths"

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

/** A frame, then another: Motion settles a jumped value on the next tick. */
const frame = () =>
  new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))

/**
 * Long enough for a fold to finish.
 *
 * A width the user did not drag to — a release settling back inside the
 * bounds, a window resize, a panel closing — is ANIMATED, so the inline width
 * is mid-flight for a quarter of a second afterwards. Asserting a frame after
 * the event reads whatever the curve happened to be at, which is how this
 * suite first "found" a panel at 243px on its way to 250.
 */
const FOLD_MS = 240
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, FOLD_MS + 140))
  await frame()
}

/**
 * A fresh editor, with a fresh idea of how wide the window is.
 *
 * Every case mounts its own, because a panel width is deliberately sticky — it
 * is written to storage and read back at mount — so a case that inherited the
 * previous one's chrome would be asserting against the last test's drag.
 */
let shell = null
const mount = ({ stored, width = 1440 } = {}) => {
  shell?.destroy()
  viewport = width
  window.localStorage.clear()
  if (stored) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  editor.setState({ layersOpen: true, inspectorOpen: true, chromeHidden: false })
  shell = editor.mountShell()
  return shell
}

const rail = () => shell.root.querySelector(".de-rail")
const panel = (side) => shell.root.querySelector(`.de-panel--${side}`)
const seam = (side) => shell.root.querySelector(`.de-separator--${side}`)
const inset = (name) => window.document.documentElement.style.getPropertyValue(name)

/** One pointer gesture on a seam, in the shape `motion-panels` listens for. */
const dragSeam = async (side, by) => {
  const grip = seam(side)
  const send = (type, x) =>
    grip.dispatchEvent(
      new window.PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientX: x,
        clientY: 100,
      })
    )
  send("pointerdown", 0)
  // Past the library's 3px pan threshold first, so the drag is live, then the
  // real distance. One jump straight to the target would also work; two makes
  // the threshold itself part of what is covered.
  send("pointermove", Math.sign(by) * 4)
  send("pointermove", by)
  return {
    release: async () => {
      send("pointerup", by)
      await settle()
    },
  }
}

// ───────────────────────────────────────────────────── the group ───────────

await check("the rail lays the panels either side of a fill the app shows through", () => {
  mount()
  const order = [...rail().children].map((node) => node.className)
  assert.deepEqual(order, [
    "de-panel de-panel--left",
    "de-separator de-separator--left",
    "de-rail-fill",
    "de-separator de-separator--right",
    "de-panel de-panel--right",
  ])
  const fill = rail().querySelector(".de-rail-fill")
  // The library finds the edge a panel owns by looking for this attribute on a
  // sibling. Without it every drag resizes nothing and reports no bounds.
  assert.equal(fill.hasAttribute("data-motion-panels-fill"), true, "the fill is not marked")
  assert.match(
    editor.shellCss,
    /\.de-rail-fill \{[^}]*pointer-events: none/,
    "the fill would swallow clicks meant for the app"
  )
  assert.match(
    editor.shellCss,
    /\.de-rail \{[^}]*pointer-events: none/,
    "the rail would swallow clicks meant for the app"
  )
})

await check("the panels mount at the two widths the stylesheet has always had", () => {
  mount()
  assert.equal(px(panel("left")), tokens.size.panelWidth)
  assert.equal(px(panel("right")), tokens.size.inspectorWidth)
  assert.equal(inset("--de-left"), `${tokens.size.panelWidth}px`)
  assert.equal(inset("--de-right"), `${tokens.size.inspectorWidth}px`)
})

// ────────────────────────────────────────────────────── the seam ───────────

await check("each seam is a focusable separator that names the panel it resizes", () => {
  mount()
  for (const [side, label, now] of [
    ["left", "Resize left panel", tokens.size.panelWidth],
    ["right", "Resize inspector", tokens.size.inspectorWidth],
  ]) {
    const grip = seam(side)
    assert.equal(grip.getAttribute("role"), "separator")
    assert.equal(grip.getAttribute("tabindex"), "0")
    assert.equal(grip.getAttribute("aria-orientation"), "vertical")
    assert.equal(grip.getAttribute("aria-label"), label)
    assert.equal(grip.getAttribute("aria-valuenow"), String(now))
    // NaN here is the signature of bounds taken before the rail was on screen,
    // which is what `PanelResize.ready` exists to prevent.
    for (const attribute of ["aria-valuemin", "aria-valuemax"]) {
      assert.notEqual(grip.getAttribute(attribute), "NaN", `${side} ${attribute} was never measured`)
    }
    assert.equal(grip.getAttribute("aria-valuemin"), String(side === "left" ? 180 : 200))
  }
})

await check("the seam paints nothing at rest and the accent only once it is touched", () => {
  // The whole claim of this feature is that the resting design did not move.
  // The seam takes no space in the flow and has no colour until hover, focus or
  // a live drag; all it ever paints is the hairline the panel already drew.
  // A real box for the pointer, pulled back by half its width on each side so
  // its net contribution to the flex line is zero and the panel edge does not
  // move. Asserted as the pair: either half on its own is a different design.
  assert.match(
    editor.shellCss,
    new RegExp(
      `\\.de-separator \\{[^}]*width: ${tokens.size.separatorHit}px;\\s*margin-inline: -${
        tokens.size.separatorHit / 2
      }px;`
    ),
    "the seam either has no box to grab or takes space the panels used to have"
  )
  assert.match(editor.shellCss, /\.de-separator::before \{[^}]*background: transparent;/)
  assert.match(
    editor.shellCss,
    /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.de-separator:hover::before \{ background: [^;]+; \}\s*\}\s*\.de-separator:focus-visible::before,\n\.de-separator\[data-resizing\]::before \{ background: [^;]+; \}/,
    "the accent is not bound to hover, focus and drag alike"
  )
  assert.match(
    editor.shellCss,
    /\.de-separator \{[^}]*user-select: none;/,
    "a press on the seam would start a text selection across the panel"
  )
})

// ───────────────────────────────────────────────────── the gesture ─────────

await check("dragging a seam resizes the panel and the app's inset with it", async () => {
  mount()
  const drag = await dragSeam("left", 90)
  assert.equal(px(panel("left")), 330, "the panel did not follow the pointer")
  assert.equal(
    inset("--de-left"),
    "330px",
    "the app did not reflow during the drag — a resize it only follows on release is a preview"
  )
  assert.equal(seam("left").hasAttribute("data-resizing"), true)
  await drag.release()
  assert.equal(px(panel("left")), 330)
  assert.equal(seam("left").hasAttribute("data-resizing"), false)
})

await check("the seam stops at the panel's minimum and at its share of the window", async () => {
  mount()
  // Short of half the minimum, which is a different gesture — see the collapse
  // case below. This one only asks to be narrower than the panel is allowed.
  await (await dragSeam("left", -(tokens.size.panelWidth - 120))).release()
  assert.equal(px(panel("left")), tokens.size.panelMinWidth, "the panel went under its minimum")

  mount()
  await (await dragSeam("left", 900)).release()
  assert.equal(
    px(panel("left")),
    Math.round(1440 * tokens.size.panelMaxShare),
    "the panel took more than its share of the window"
  )
})

await check("the right seam grows the inspector by moving the other way", async () => {
  mount()
  await (await dragSeam("right", -80)).release()
  assert.equal(px(panel("right")), 340)
  assert.equal(inset("--de-right"), "340px")
})

await check("a drag past half the minimum closes the panel, but not until the pointer is up", async () => {
  mount()
  const drag = await dragSeam("left", -(tokens.size.panelWidth - 40))
  assert.equal(
    panel("left").hidden,
    false,
    "the panel was hidden mid-gesture, while the seam still holds the pointer capture"
  )
  assert.equal(editor.getState().layersOpen, true, "the close landed before the drag ended")
  await drag.release()
  assert.equal(editor.getState().layersOpen, false, "dragging the panel shut did not close it")
  assert.equal(panel("left").hidden, true)
  assert.equal(seam("left").hidden, true, "a closed panel left its seam behind")
  assert.equal(inset("--de-left"), "0px")
})

await check("re-opening a panel dragged shut brings back the width it had", async () => {
  mount()
  await (await dragSeam("left", 60)).release()
  assert.equal(px(panel("left")), 300)
  await (await dragSeam("left", -280)).release()
  assert.equal(editor.getState().layersOpen, false)
  editor.setState({ layersOpen: true })
  await settle()
  assert.equal(px(panel("left")), 300, "the panel came back at the wrong width")
})

// ─────────────────────────────────────────────────── the keyboard ──────────

await check("the arrow keys resize the seam they are pressed on", async () => {
  mount()
  const press = async (key, shiftKey = false) => {
    seam("left").dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, shiftKey })
    )
    await settle()
  }
  await press("ArrowRight")
  assert.equal(px(panel("left")), tokens.size.panelWidth + 10)
  await press("ArrowRight", true)
  assert.equal(px(panel("left")), tokens.size.panelWidth + 60)
  await press("ArrowLeft")
  assert.equal(px(panel("left")), tokens.size.panelWidth + 50)
  await press("Home")
  assert.equal(px(panel("left")), tokens.size.panelMinWidth)
  await press("End")
  assert.equal(px(panel("left")), Math.round(1440 * tokens.size.panelMaxShare))
  assert.equal(inset("--de-left"), `${px(panel("left"))}px`)
})

// ───────────────────────────────────────────────── outliving the tab ───────

await check("a width outlives the tab", async () => {
  mount()
  await (await dragSeam("left", 70)).release()
  assert.equal(
    window.localStorage.getItem(STORAGE_KEY),
    JSON.stringify({ left: 310, right: tokens.size.inspectorWidth })
  )
  // Remount against what the last session wrote, the way a reload would.
  shell.destroy()
  shell = editor.mountShell()
  assert.equal(px(panel("left")), 310)
  assert.equal(inset("--de-left"), "310px")
})

await check("a stored width narrower than the minimum is clamped on the way in", () => {
  mount({ stored: { left: 12, right: 9999 } })
  assert.equal(px(panel("left")), tokens.size.panelMinWidth)
  // 9999 is past the share as well as past the pixel, so the share is the wall.
  assert.equal(px(panel("right")), Math.round(1440 * tokens.size.inspectorMaxShare))
})

/*
 * Boot fits the panels before the page has ever been laid out, so it cannot
 * ask the rail how wide it is without laying out the whole app on the spot. It
 * asks the window, which a classic scrollbar makes wider than the rail, and
 * fits again against the rail once the first frame has passed.
 */
await check("a classic scrollbar is taken back off the fit once the first frame has passed", async () => {
  scrollbar = 15
  try {
    mount({ stored: { left: 9999, right: 9999 }, width: 900 })
    await frame()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const taken = px(panel("left")) + px(panel("right"))
    assert.ok(
      taken <= 900 - tokens.size.canvasMinWidth,
      `the panels left the canvas ${900 - taken}px of the rail, under its ${tokens.size.canvasMinWidth}px floor`
    )
  } finally {
    scrollbar = 0
  }
})

await check("unreadable storage costs the width, not the editor", () => {
  window.localStorage.setItem(STORAGE_KEY, "{not json")
  shell?.destroy()
  viewport = 1440
  shell = editor.mountShell()
  assert.equal(px(panel("left")), tokens.size.panelWidth)
})

// ────────────────────────────────────────────────── the window moves ───────

await check("the canvas keeps its floor when the window shrinks, and the panels take it back", async () => {
  mount({ stored: { left: 420, right: 400 }, width: 1440 })
  assert.equal(px(panel("left")), 420)
  assert.equal(px(panel("right")), 400)

  viewport = 760
  window.dispatchEvent(new window.Event("resize"))
  await settle()
  const squeezed = px(panel("left")) + px(panel("right"))
  assert.ok(
    squeezed <= 760 - tokens.size.canvasMinWidth,
    `the panels left the canvas ${760 - squeezed}px, under its ${tokens.size.canvasMinWidth}px floor`
  )
  assert.ok(px(panel("left")) >= tokens.size.panelMinWidth, "the left panel went under its minimum")
  assert.ok(px(panel("right")) >= tokens.size.inspectorMinWidth, "the inspector went under its minimum")

  viewport = 1440
  window.dispatchEvent(new window.Event("resize"))
  await settle()
  assert.equal(px(panel("left")), 420, "the width the user chose did not come back")
  assert.equal(px(panel("right")), 400, "the width the user chose did not come back")
})

await check("a closed panel hands its room to the one still open", async () => {
  mount({ stored: { left: 420, right: 400 }, width: 900 })
  const squeezed = px(panel("right"))
  editor.setState({ layersOpen: false })
  await settle()
  assert.ok(
    px(panel("right")) > squeezed,
    "the inspector did not grow into the room the layers panel gave up"
  )
})

// ──────────────────────────────────────────── the rest of the chrome ───────

await check("hiding the chrome still zeroes the inset and holds the toolbar's own pair", () => {
  mount({ stored: { left: 320, right: 300 } })
  editor.setState({ chromeHidden: true })
  assert.equal(inset("--de-left"), "0px")
  assert.equal(inset("--de-right"), "0px")
  // The bar does not re-centre while it fades; see `syncInsets` in shell.ts.
  assert.equal(inset("--de-bar-left"), "320px")
  assert.equal(inset("--de-bar-right"), "300px")
  editor.setState({ chromeHidden: false })
  assert.equal(inset("--de-left"), "320px")
})

await check("destroying the shell takes the rail and its listeners with it", () => {
  mount()
  const grip = seam("left")
  shell.destroy()
  shell = null
  assert.equal(window.document.querySelector(".de-rail"), null)
  assert.equal(grip.isConnected, false)
  assert.equal(inset("--de-left"), "")
})

/*
 * The chrome says what is selected, and it used to say nothing at all.
 *
 * Selecting is the commonest act in this editor: the outline moves and the
 * inspector repaints with an element's whole property stack. There was no live
 * region anywhere in the shell, so none of that reached a screen reader.
 *
 * Asserted on the region's CONTRACT rather than on a sentence, because the
 * wording should stay free to improve. What has to hold is that it exists, that
 * it is polite — a selection can change several times a second while somebody
 * walks the tree, and an assertive region interrupts itself on every one — and
 * that it is hidden in a way that is still announced. `display: none` would
 * make it decorative.
 */
await check("the shell carries a live region for what it selects", () => {
  const mounted = mount({})
  const node = mounted.announcer
  assert.ok(node, "the shell has nowhere to announce a selection from")
  assert.equal(node.getAttribute("aria-live"), "polite")
  assert.equal(node.getAttribute("aria-atomic"), "true")
  assert.ok(mounted.root.contains(node), "the region is built but never mounted")
  const rule = /\.de-announcer\s*\{([^}]*)\}/s.exec(editor.shellCss)
  assert.ok(rule, ".de-announcer has no rule in the shell stylesheet")
  assert.doesNotMatch(rule[1], /display:\s*none/)
  assert.doesNotMatch(rule[1], /visibility:\s*hidden/)
  assert.match(rule[1], /clip-path|clip:/)
})

if (failures > 0) {
  console.error(`\n${failures} resize case(s) failed`)
  process.exit(1)
}
console.log("\nresize cases passed")
