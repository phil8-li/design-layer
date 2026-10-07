/**
 * The tooltip primitive: placement, the warm state machine, and its budget.
 *
 * The card follows the design foundations kit (MICRO-INTERACTIONS § 7), and a
 * motion primitive is exactly the kind of change that regresses in two ways
 * nobody looks at: the timings drift back toward whatever felt right while
 * editing, and the motion quietly starts costing a frame budget. So this file
 * pins both halves.
 *
 *   BEHAVIOUR — a tip opens the instant the pointer arrives, with no entrance.
 *   Leaving is not closing for another 80ms, and closing is a 150ms fade. A tip
 *   opening within 320ms of the last, near it, TRAVELS from the old place over
 *   150ms (translate only); a far one opens in place.
 *
 *   BUDGET — one card in the document however many controls are tipped; no
 *   scroll, resize or visibility listener while nothing is on screen; and no
 *   animation frame or scripted animation at all — every motion is a CSS
 *   transition the compositor runs.
 *
 * Time and frames are both fake here. `Element.animate` is stubbed to record,
 * so a scripted animation sneaking back in is caught.
 *
 * Usage: node test/tooltip-cases.mjs
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

/**
 * The same, for the one case that has to yield.
 *
 * `MutationObserver` delivers on a microtask, and a microtask is the one clock
 * in this file that is real — `setTimeout` is faked from here down, so nothing
 * else in the suite can accidentally depend on wall time.
 */
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

const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom
const { document } = window

/*
 * Rects, from a `__rect` the case sets — jsdom measures nothing.
 *
 * The RULER is the exception and is measured from its own text, because the
 * card's size is the one number the runtime derives rather than reads, and the
 * auto-wrap threshold is a comparison against it. Seven pixels a character is
 * near enough to the 12px UI face to make "long label" mean what it means.
 */
const CHAR = 7
const PAD = 16
window.Element.prototype.getBoundingClientRect = function box() {
  if (this.classList?.contains("de-tip-ruler")) {
    const wrapped = this.hasAttribute("data-de-tip-wrap")
    const text = this.textContent ?? ""
    const line = text.length * CHAR + PAD
    const width = wrapped ? Math.min(260, line) : line
    const height = wrapped && line > 260 ? 2 * 17 + 8 : 17 + 8
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height }
  }
  const r = this.__rect ?? { left: 0, top: 0, width: 28, height: 28 }
  return {
    x: r.left,
    y: r.top,
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
  }
}

/** Reduced motion, switchable, and defined before the module can cache it. */
let reduced = false
window.matchMedia = (query) => ({
  media: query,
  get matches() {
    return reduced && query.includes("reduced-motion")
  },
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})

/** Every `animate()` call, unrun. jsdom has no Web Animations API. */
let animations = []
window.Element.prototype.animate = function record(keyframes, options) {
  const animation = {
    node: this,
    keyframes,
    options,
    cancelled: false,
    cancel() {
      this.cancelled = true
    },
    finish() {},
  }
  animations.push(animation)
  this.__animations = [...(this.__animations ?? []), animation]
  return animation
}
window.Element.prototype.getAnimations = function live() {
  return (this.__animations ?? []).filter((animation) => !animation.cancelled)
}

for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "FocusEvent",
  "MutationObserver",
  "getComputedStyle",
  "matchMedia",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

/** Which listeners the window is carrying, so the idle cost can be asserted. */
const windowListeners = new Map()
const realAdd = window.addEventListener.bind(window)
const realRemove = window.removeEventListener.bind(window)
window.addEventListener = (type, fn, options) => {
  windowListeners.set(`${type}:${fn.name || "anon"}`, fn)
  return realAdd(type, fn, options)
}
window.removeEventListener = (type, fn, options) => {
  windowListeners.delete(`${type}:${fn.name || "anon"}`)
  return realRemove(type, fn, options)
}
const windowTypes = () => [...windowListeners.keys()].map((key) => key.split(":")[0])

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { installTooltips, hideTip, placeTip, tip, tipAttrs } from "./src/core/tooltip"
      export { tooltipCss, TIP_CLOSE_MS, TIP_TRAVEL_MS } from "./src/core/css/tooltip"
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

/* ---- fake time, installed after the import and before the first show ---- */

let clock = 0
let timerId = 1
let frameId = 1
const timers = new Map()
const frames = new Map()

globalThis.setTimeout = (fn, ms = 0) => {
  const id = timerId++
  timers.set(id, { fn, at: clock + ms })
  return id
}
globalThis.clearTimeout = (id) => timers.delete(id)
globalThis.requestAnimationFrame = (fn) => {
  const id = frameId++
  frames.set(id, fn)
  return id
}
globalThis.cancelAnimationFrame = (id) => frames.delete(id)
globalThis.performance = { now: () => clock }

function advance(ms) {
  const end = clock + ms
  for (;;) {
    let pick = null
    for (const [id, task] of timers) {
      if (task.at <= end && (pick === null || task.at < pick.task.at)) pick = { id, task }
    }
    if (!pick) break
    timers.delete(pick.id)
    clock = pick.task.at
    pick.task.fn()
  }
  clock = end
}

/** One animation frame: `ms` of wall clock, then whatever was due to paint. */
function frame(ms = 16) {
  advance(ms)
  const due = [...frames.values()]
  frames.clear()
  for (const fn of due) fn(clock)
}


/* ---- the page under test ---- */

const app = document.getElementById("app")
function control(label, rect, attrs = {}) {
  const node = document.createElement("button")
  node.setAttribute("data-de-tip", label)
  node.setAttribute("aria-label", label)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  node.__rect = rect
  app.append(node)
  return node
}

const teardown = editor.installTooltips()
const cardOf = () => document.querySelector(".de-tip")
const ruler = () => document.querySelector(".de-tip-ruler")
const isOpen = () => cardOf().hasAttribute("data-de-tip-open")
const popMs = () => cardOf().style.getPropertyValue("--de-tip-pop")
const travelMs = () => cardOf().style.getPropertyValue("--de-tip-travel")
const liveText = () =>
  [...cardOf().querySelectorAll(".de-tip-layer")]
    .filter((layer) => layer.style.opacity !== "0")
    .map((layer) => layer.textContent)
    .join("")
const translate = () => {
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(cardOf().style.transform)
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null
}

const over = (node) =>
  node.dispatchEvent(new window.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }))
/** The pointer on nothing tipped, which is how this primitive hears "left". */
const away = () => over(app)

function reset() {
  editor.hideTip()
  away()
  advance(1000)
  animations = []
  reduced = false
}

const a = control("Undo · ⌘Z", { left: 100, top: 400, width: 28, height: 28 })
const b = control("Redo · ⇧⌘Z", { left: 140, top: 400, width: 28, height: 28 })
const far = control("Inspector", { left: 900, top: 40, width: 28, height: 28 })

// ─────────────────────────────────────────────────────────── placement ─────

console.log("\nPlacement is arithmetic, and is checked without a browser")

check("below by default, centred on the control, 6px off it", () => {
  const placed = editor.placeTip({
    anchor: { left: 100, top: 100, width: 40, height: 20 },
    tip: { width: 80, height: 30 },
    viewport: { width: 1000, height: 800 },
  })
  assert.equal(placed.side, "below")
  assert.equal(placed.flipped, false)
  assert.equal(placed.top, 126) // 100 + 20 + 6
  assert.equal(placed.left, 80) // 120 - 40
})

check("a control with no room under it flips the card above", () => {
  const placed = editor.placeTip({
    anchor: { left: 100, top: 750, width: 40, height: 36 },
    tip: { width: 80, height: 30 },
    viewport: { width: 1000, height: 800 },
  })
  assert.equal(placed.side, "above")
  assert.equal(placed.flipped, true)
  assert.equal(placed.top, 714) // 750 - 6 - 30
})

check("a control at the edge slides the card back inside rather than off", () => {
  const placed = editor.placeTip({
    anchor: { left: 0, top: 100, width: 20, height: 20 },
    tip: { width: 200, height: 30 },
    viewport: { width: 1000, height: 800 },
  })
  assert.equal(placed.left, 8)
  assert.equal(placed.shifted, true)
  assert.equal(placed.clamped, false)
})

check("a card wider than the window is parked, not centred off-screen", () => {
  const placed = editor.placeTip({
    anchor: { left: 100, top: 100, width: 20, height: 20 },
    tip: { width: 400, height: 30 },
    viewport: { width: 300, height: 800 },
  })
  assert.equal(placed.left, 8)
  assert.equal(placed.clamped, true)
})

// ────────────────────────────────────────────────────────── the budget ─────

console.log("\nOne card, and nothing running while there is nothing to see")

check("two tipped controls share one card and one ruler", () => {
  reset()
  over(a)
  over(b)
  assert.equal(document.querySelectorAll(".de-tip").length, 1)
  assert.equal(document.querySelectorAll(".de-tip-ruler").length, 1)
  assert.equal(document.querySelectorAll(".de-tip-layer").length, 2)
})

check("the card is decoration, and says so", () => {
  assert.equal(cardOf().getAttribute("aria-hidden"), "true")
  assert.match(editor.tooltipCss, /pointer-events: none/)
})

check("no scroll, resize or visibility listener survives a closed card", () => {
  reset()
  assert.deepEqual(
    windowTypes().filter((type) => type === "scroll" || type === "resize"),
    [],
    "a closed tooltip is still listening to the page"
  )
})

check("those three listeners exist exactly while a card is up", () => {
  reset()
  over(a)
  advance(400)
  assert.ok(windowTypes().includes("scroll"), "an open card is not following its control")
  assert.ok(windowTypes().includes("resize"))
  editor.hideTip()
  assert.equal(windowTypes().filter((type) => type === "scroll").length, 0)
})

check("a hand-off costs no frames and no scripted animation", () => {
  reset()
  over(a)
  over(b)
  assert.equal(frames.size, 0, "the travel queued an animation frame")
  assert.equal(animations.length, 0, "a label swap was scripted")
  assert.equal(travelMs(), `${editor.TIP_TRAVEL_MS}ms`)
})

check("nothing is scheduled once a run is over", () => {
  reset()
  assert.equal(frames.size, 0)
  assert.equal(timers.size, 0)
})

// ───────────────────────────────────────────────────────────── the wait ────

console.log("\nNo wait, no entrance, and leaving is not closing")

check("a tip opens the moment the pointer arrives", () => {
  reset()
  over(a)
  assert.equal(isOpen(), true)
  assert.equal(liveText(), "Undo · ⌘Z")
})

check("it opens with no entrance and in place", () => {
  assert.equal(popMs(), "0ms")
  assert.equal(travelMs(), "0ms")
})

check("leaving does nothing for 80ms, then closes over 150ms", () => {
  reset()
  over(a)
  away()
  advance(79)
  assert.equal(isOpen(), true, "the card left before its grace was up")
  advance(1)
  assert.equal(isOpen(), false)
  assert.equal(popMs(), `${editor.TIP_CLOSE_MS}ms`)
  assert.equal(editor.TIP_CLOSE_MS, 150)
})

check("coming back inside the grace keeps the same card, uninterrupted", () => {
  reset()
  over(a)
  away()
  advance(40)
  over(a)
  assert.equal(isOpen(), true)
  advance(200)
  assert.equal(isOpen(), true, "the card closed on a grace timer that should have been cancelled")
})

check("a neighbour inside the warm window travels from the last tip", () => {
  reset()
  over(a)
  editor.hideTip()
  advance(100) // inside WARM
  over(b)
  assert.equal(isOpen(), true)
  assert.equal(popMs(), "0ms", "a warm tip faded in")
  assert.equal(travelMs(), `${editor.TIP_TRAVEL_MS}ms`, "a warm neighbour did not travel")
  assert.equal(liveText(), "Redo · ⇧⌘Z")
})

check("the warm window is 320ms, and after it a tip opens in place", () => {
  reset()
  over(a)
  editor.hideTip()
  advance(321)
  over(b)
  assert.equal(isOpen(), true)
  assert.equal(travelMs(), "0ms", "the warm window outlived its 320ms")
})

check("a far control inside the warm window opens in place, not travelling", () => {
  reset()
  over(a)
  over(far)
  assert.equal(liveText(), "Inspector")
  assert.equal(travelMs(), "0ms", "the card flew across the screen to an unrelated control")
})

console.log("\nA card already up travels; it does not close and reopen")

check("arriving at a second control never drops the open card", () => {
  reset()
  over(a)
  const card = cardOf()
  let dropped = false
  const watch = new window.MutationObserver(() => {
    if (!card.hasAttribute("data-de-tip-open")) dropped = true
  })
  watch.observe(card, { attributes: true, attributeFilter: ["data-de-tip-open"] })
  over(b)
  watch.takeRecords()
  watch.disconnect()
  assert.equal(dropped, false, "the card blinked instead of travelling")
  assert.equal(liveText(), "Redo · ⇧⌘Z")
})

check("the card lands on the new control, and only its translate travels", () => {
  reset()
  over(a)
  const from = translate()
  const width = cardOf().style.width
  over(b)
  const to = translate()
  assert.ok(to.x > from.x, "the card did not move to the new control")
  assert.equal(to.x, Math.round(to.x))
  assert.equal(travelMs(), `${editor.TIP_TRAVEL_MS}ms`)
  // The size is written plainly — the new label's, at once.
  assert.notEqual(cardOf().style.width, width, "the card kept the old label's width")
  assert.doesNotMatch(editor.tooltipCss, /transition:[^;]*\bwidth\b/, "the size is transitioned")
})

check("the label is replaced in place: nothing slides, blurs or crossfades", () => {
  reset()
  over(a)
  animations = []
  over(b)
  assert.equal(animations.length, 0)
  assert.doesNotMatch(editor.tooltipCss, /blur\(/)
})

check("a card caught mid-close is pulled back at once", () => {
  reset()
  over(a)
  away()
  advance(100) // past GRACE: the close has started
  assert.equal(isOpen(), false)
  over(b)
  assert.equal(isOpen(), true, "the closing card was not recovered")
  assert.equal(popMs(), "0ms")
})

check("the surface is the panel's ground, 12px, 6x12, radius.lg", () => {
  const box = /\.de-tip-box \{([^}]*)\}/s.exec(editor.tooltipCss)[1]
  assert.match(box, /border-radius: 12px/)
  assert.match(box, /background: var\(--de-color-bg,/)
  assert.match(box, /color: var\(--de-color-text/)
  const faceRule = /\.de-tip-face \{([^}]*)\}/s.exec(editor.tooltipCss)[1]
  assert.match(faceRule, /padding: 6px 12px/)
  assert.match(faceRule, /font-size: 12px/)
})

// ───────────────────────────────────────────────────────── the label ───────

console.log("\nThe label decides its own shape")

check("a label too long for one line is wrapped, and measured wrapped", () => {
  reset()
  const wordy = control(
    "This hint is a whole sentence and has no business being one line long",
    { left: 400, top: 300, width: 20, height: 20 }
  )
  over(wordy)
  const faces = [...cardOf().querySelectorAll(".de-tip-face")]
  assert.ok(
    faces.some((node) => node.hasAttribute("data-de-tip-wrap")),
    "a 70-character label was left on one line"
  )
  assert.ok(Number.parseFloat(cardOf().style.width) <= 260)
  wordy.remove()
})

check("a short label is not wrapped", () => {
  reset()
  over(a)
  advance(400)
  const live = [...cardOf().querySelectorAll(".de-tip-layer")].find(
    (layer) => layer.style.opacity !== "0"
  )
  assert.equal(live.querySelector(".de-tip-face").hasAttribute("data-de-tip-wrap"), false)
})

check("the ruler is what gets measured, and it is never on screen", () => {
  assert.ok(ruler())
  assert.match(editor.tooltipCss, /\.de-tip-ruler \{[^}]*visibility: hidden/s)
})

// ───────────────────────────────────────────────────────── the residue ─────

console.log("\nTitle, Escape, presses, teardown")

check("a title is borrowed while the card is up and handed back after", () => {
  reset()
  const native = document.createElement("button")
  native.setAttribute("title", "Native")
  native.__rect = { left: 500, top: 300, width: 20, height: 20 }
  app.append(native)

  over(native)
  advance(400)
  assert.equal(native.hasAttribute("title"), false, "the OS tooltip would paint over ours")
  assert.equal(liveText(), "Native")
  editor.hideTip()
  assert.equal(native.getAttribute("title"), "Native", "the DOM was left modified")
  native.remove()
})

/*
 * The card follows a scroll now instead of hiding on one, and that is what
 * makes this a case rather than a footnote. `annotations/canvas.ts` and
 * `lint/markers.ts` both reposition pooled markers on every scroll frame and
 * both write `title` back when it does not match what they expect — which it
 * never does while the borrow has taken it away. Hiding on scroll used to end
 * the borrow before the next frame could notice; nothing does now except the
 * borrow watching its own attribute.
 */
await checkAsync("a title written back under an open card is taken away again", async () => {
  reset()
  const pin = document.createElement("button")
  pin.setAttribute("title", "Note one")
  pin.__rect = { left: 600, top: 300, width: 20, height: 20 }
  app.append(pin)

  over(pin)
  advance(400)
  assert.equal(pin.hasAttribute("title"), false)

  // The marker loop, re-running on a scroll frame with newer text.
  pin.title = "Note one, edited"
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(pin.hasAttribute("title"), false, "the OS tooltip is back on top of ours")

  editor.hideTip()
  assert.equal(pin.getAttribute("title"), "Note one, edited", "the borrow handed back stale text")
  pin.remove()
})

check("Escape and a press both take the card down at once", () => {
  for (const fire of [
    () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    () => a.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })),
  ]) {
    reset()
    over(a)
    advance(400)
    assert.equal(isOpen(), true)
    fire()
    assert.equal(isOpen(), false, "the card survived an answer")
  }
})

check("a press leaves the run warm, so the next control is instant", () => {
  reset()
  over(a)
  advance(400)
  a.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }))
  advance(50)
  over(b)
  assert.equal(isOpen(), true)
})

// ──────────────────────────────────────────────────── reduced motion ───────

console.log("\nReduced motion paints every step in place")

check("the sheet clamps the card, which the blanket rule cannot reach", () => {
  // `.de-tip` is parented to <body>, so `[data-designlayer] *` misses it.
  assert.match(
    editor.tooltipCss,
    /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.de-tip \{ transition-duration: 0s/s
  )
})

check("no travel and no fade under reduced motion", () => {
  reset()
  reduced = true
  over(a)
  assert.equal(isOpen(), true)
  assert.equal(popMs(), "0ms")
  const before = translate()
  over(b)
  assert.equal(travelMs(), "0ms", "the card travelled under reduced motion")
  assert.notDeepEqual(translate(), before)
  assert.equal(frames.size, 0)
  away()
  advance(80)
  assert.equal(isOpen(), false)
  assert.equal(popMs(), "0ms", "the exit faded under reduced motion")
  reduced = false
})

// ─────────────────────────────────────────────────────────── teardown ──────

check("teardown removes the card, the ruler and every listener", () => {
  reset()
  over(a)
  advance(400)
  teardown()
  assert.equal(cardOf(), null)
  assert.equal(ruler(), null)
  assert.deepEqual(
    windowTypes().filter((type) => type === "scroll" || type === "resize" || type === "blur"),
    []
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
