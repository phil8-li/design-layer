/** DOM contract for the quiet UI3 shell and supported-tool inventory. */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR, vendorOverlayPath } from "./host.mjs"
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom
/*
 * jsdom has no `ResizeObserver`, and the resizable panels need one.
 *
 * `motion-panels` watches each panel's parent so a percentage size can re-fit
 * when the group changes, and it constructs the observer unconditionally in
 * `attach` — so without this, `mountShell` throws before it returns and every
 * case below fails on a feature none of them are about. The same stub already
 * exists in `host-parity-cases.mjs` for the same reason.
 *
 * A no-op is the honest stub, not a shortcut: jsdom lays nothing out, so there
 * is no resize for a real observer to report here anyway.
 */
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
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
  "KeyboardEvent",
  "PointerEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  /*
   * jsdom's `AbortController`, not Node's, and the two are not interchangeable
   * here. The panel separators register their listeners with
   * `addEventListener(type, fn, { signal })`, and jsdom type-checks that signal
   * against its OWN `AbortSignal` — handed Node's it throws "parameter 3
   * dictionary has member 'signal' that is not of type 'AbortSignal'", which
   * reads like a bug in the code under test and is not one.
   */
  "AbortController",
  "AbortSignal",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
/*
 * The three window methods `motion-panels` calls unqualified.
 *
 * `addEventListener` (its shared resize/scroll invalidation) and
 * `getComputedStyle` (measuring how much room a drag has left) are globals in
 * a browser and nothing at all in this harness. Bound rather than copied like
 * the names above: jsdom's implementations read `this`, and called with
 * `globalThis` as the receiver they throw "Illegal invocation".
 */
for (const key of ["addEventListener", "removeEventListener", "getComputedStyle"]) {
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
      export { createContext } from "./src/core/context"
      export { installSelectionFrame } from "./src/canvas/selection"
      export { installToolbar } from "./src/shell/toolbar"
      export { installShortcuts } from "./src/shell/shortcuts"
      export { installWayBack } from "./src/shell/way-back"
      export { controlRow } from "./src/panels/controls"
      export { shellCss } from "./src/core/css"
      export { mountShell } from "./src/shell/shell"
      export { editorOwnsInput, setState } from "./src/core/store"
      export { record, canUndo, canRedo, resetHistory } from "./src/core/history"
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

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
/** Everything the chrome says out loud, so a keyboard case can read it back. */
const toasts = []
const bridge = {
  elementInfo: () => null,
  send() {},
  toast(message) {
    toasts.push(message)
  },
  subscribe: () => () => {},
  // No canvas-transform members: the toolbar's zoom cluster is gone, and a
  // stub for it here would let one grow back unnoticed.
  store: {
    setActiveTool() {},
    hasChanges: () => false,
    onStateChange() {},
  },
}
const context = editorModule.createContext(bridge, {
  overlay: slot(),
  toolbar: slot(),
  left: slot(),
  right: slot(),
})
editorModule.installToolbar(context)
/*
 * The keyboard moved out of the bar, so these cases have to mount the lane that
 * holds it now.
 *
 * ⌘. and ⌘Z were the bar's own window listeners; they are `chrome.toggle` and
 * `history.undo` in the command registry now, and `shell/shortcuts.ts` is the
 * one module in the editor that listens for a key — which is what a Figma-sized
 * keymap needs (see `core/keymap.ts`). Nothing under test changed behaviour;
 * the pair just has to be built the way the product builds it.
 *
 * ⌘. moved once more, to `shell/way-back.ts`, which hears it from text fields
 * and frames the keymap's listener ignores; the product installs both.
 */
editorModule.installShortcuts(context)
editorModule.installWayBack()

/**
 * The pass count is counted, never typed. It used to be a literal at the foot
 * of the file, which meant an edit that removed an assertion could still print
 * a bigger number than the run before it.
 */
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

const label = (name) => context.slots.toolbar.querySelector(`[aria-label="${name}"]`)

await check("the toolbar draws the mode switch, both panel toggles and time travel", () => {
  assert.ok(context.slots.toolbar.querySelector(".de-button--mode"))
  assert.ok(label("Show or hide left panel"))
  assert.ok(label("Show or hide inspector"))
  assert.ok(label("Undo"))
  assert.ok(label("Redo"))
  // The commit left the bar, and so did the indicator that replaced it.
  // Finishing work is the Changes tab's job — it writes what can be written AND
  // hands the rest to an agent, which a square in a toolbar could not express —
  // and the inspector toggle above is the one door to it, so the bar neither
  // writes to disk nor keeps a second way in.
  assert.equal(label("Apply to code"), null, "the bar can still write to disk")
  for (const gone of ["Changes", "Move", "Hand (browser scroll)"]) {
    assert.equal(label(gone), null, `${gone} is still in the bar`)
  }
})

// The toolbar no longer dispatches the options event — the inspector's empty
// state is now its only in-chrome caller besides the browser's own launcher.
// The subsystem must still be reachable, so this asserts the receiver, not the
// removed sender. Full coverage of the four removed clusters is in
// test/toolbar-cases.mjs.
await check("no overflow menu and no capability inventory", () => {
  const toolbarText = context.slots.toolbar.textContent
  assert.doesNotMatch(toolbarText, /Variables/)
  assert.doesNotMatch(toolbarText, /Actions/)
  assert.equal(context.slots.toolbar.querySelector(".de-actions-menu"), null)
})

await check("the shell keeps its quiet, motionless chrome", () => {
  assert.match(editorModule.shellCss, /bottom:/)
  assert.doesNotMatch(editorModule.shellCss, /transition: padding/)
  assert.doesNotMatch(editorModule.shellCss, /de-outline--scope/)
  /*
   * MOTIONLESS means the outline never animates its GEOMETRY, not that it
   * never transitions at all. The frame loop writes `transform` on this node
   * every frame to track the target; a transition on any box property would
   * make the outline chase the element a frame behind it, which is the bug
   * this case was written to catch. A fade on `opacity` is the one transition
   * that cannot cause it, and `css/canvas.ts` deliberately has one so a
   * selection does not blink in and out. So assert the ban, not the absence.
   */
  const outlineRule = /\.de-outline\s*\{([^}]*)\}/s.exec(editorModule.shellCss)
  assert.ok(outlineRule, ".de-outline rule is missing from the shell stylesheet")
  assert.match(outlineRule[1], /animation: none;/)
  const outlineTransition = /transition:([^;]*);/s.exec(outlineRule[1])
  assert.ok(outlineTransition, ".de-outline must declare a transition, even if it is none")
  assert.doesNotMatch(
    outlineTransition[1],
    /\b(all|transform|translate|scale|width|height|top|left|right|bottom|inset|margin|padding|border-width)\b/
  )
  assert.match(editorModule.shellCss, /\.de-outline--hover\s*\{[^}]*opacity: 1;/s)
  assert.doesNotMatch(editorModule.shellCss, /\.de-outline--hover\s*\{[^}]*opacity: 0\.48;/s)
  /*
   * The handle is the other half of the same rule, with one property moved
   * across the line. The frame loop places the 13px HIT BOX, not this node, so
   * `transform` here is the handle's own and safe to transition — it is how the
   * hover grows the mark. Its box properties are still the painter's.
   */
  const handleRule = /\.de-handle\s*\{([^}]*)\}/s.exec(editorModule.shellCss)
  assert.ok(handleRule, ".de-handle rule is missing from the shell stylesheet")
  assert.match(handleRule[1], /border-radius: 0;/)
  assert.match(handleRule[1], /animation: none;/)
  const handleTransition = /transition:([^;]*);/s.exec(handleRule[1])
  assert.ok(handleTransition, ".de-handle must declare a transition, even if it is none")
  assert.doesNotMatch(
    handleTransition[1],
    /\b(all|width|height|top|left|right|bottom|inset|margin|padding)\b/
  )
  /*
   * `.de-layer` is a panel row, not canvas chrome. No frame loop writes it, so
   * the geometry ban does not apply and it fades its tint like every other
   * high-frequency control — see the note on the rule in `css/layers.ts`. What
   * it still may not do is animate its own box inside a scrolling list.
   */
  const layerRule = /\.de-layer\s*\{([^}]*)\}/s.exec(editorModule.shellCss)
  assert.ok(layerRule, ".de-layer rule is missing from the shell stylesheet")
  const layerTransition = /transition:([^;]*);/s.exec(layerRule[1])
  assert.ok(layerTransition, ".de-layer must declare a transition, even if it is none")
  assert.doesNotMatch(layerTransition[1], /\b(all|width|height|margin|padding)\b/)
})

editorModule.installSelectionFrame(context)

await check("the frame mounts one node pool and nothing else", () => {
  assert.equal(context.slots.overlay.querySelectorAll(".de-outline").length, 2)
  assert.equal(context.slots.overlay.querySelector(".de-badge"), null)
  assert.equal(context.slots.overlay.querySelectorAll("[data-handle]").length, 8)
})

const selectedTarget = window.document.createElement("main")
selectedTarget.getBoundingClientRect = () => new window.DOMRect(20, 30, 100, 60)
window.document.body.append(selectedTarget)
const nextPaint = () =>
  new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
const hoverOutline = context.slots.overlay.querySelector(".de-outline--hover")
const selectionOutline = context.slots.overlay.querySelector(".de-outline:not(.de-outline--hover)")
const selectionHandles = Array.from(context.slots.overlay.querySelectorAll("[data-handle]"))

await check("a hover paints the hover outline and no handles", async () => {
  context.setState({ hovered: selectedTarget, selection: [] })
  await nextPaint()
  assert.equal(hoverOutline.style.display, "block")
  assert.equal(hoverOutline.style.transform, "translate(20px, 30px)")
  assert.equal(selectionOutline.style.display, "none")
  assert.ok(selectionHandles.every((handle) => handle.style.display === "none"))
})

await check("a selection takes the outline over and brings the handles", async () => {
  context.select(selectedTarget)
  await nextPaint()
  assert.equal(hoverOutline.style.display, "none")
  assert.equal(selectionOutline.style.display, "block")
  assert.equal(selectionOutline.style.transform, "translate(20px, 30px)")
  assert.ok(selectionHandles.every((handle) => handle.style.display === "block"))
})

/*
 * TWO HIT BOXES MAY NOT SHARE A PIXEL, and an axis shorter than one box is
 * where that stops being automatic.
 *
 * The handles read as 7px and grab at 13, centred on the edges — so on an
 * element narrower than 13 the left and right corners overlap, and both are
 * live. That is the one clause of the hit-area rule with no user workaround: a
 * target that is too small can be zoomed into or aimed at twice, and two
 * targets on the same pixel can only be resolved by whichever the hit test
 * happens to reach first.
 *
 * Asserted as a GEOMETRY test rather than by counting hidden nodes, because the
 * count is the remedy and the overlap is the defect — a later change that keeps
 * eight handles and separates them another way should pass this.
 */
const HIT = 13
const boxesOf = () =>
  selectionHandles
    .filter((handle) => handle.style.display !== "none")
    .map((handle) => {
      const [x, y] = handle.style.transform.match(/-?[\d.]+/g).map(Number)
      return { id: handle.dataset.handle, left: x - HIT / 2, top: y - HIT / 2 }
    })
const overlaps = (a, b) =>
  Math.abs(a.left - b.left) < HIT && Math.abs(a.top - b.top) < HIT

await check("no two resize handles ever share a pixel, however thin the element", async () => {
  for (const [w, h] of [
    [100, 60],
    [10, 60],
    [100, 9],
    [8, 8],
    [23, 23],
    [13, 13],
  ]) {
    selectedTarget.getBoundingClientRect = () => new window.DOMRect(20, 30, w, h)
    context.select(null)
    await nextPaint()
    context.select(selectedTarget)
    await nextPaint()
    const boxes = boxesOf()
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        assert.ok(
          !overlaps(boxes[i], boxes[j]),
          `at ${w}x${h} the ${boxes[i].id} and ${boxes[j].id} hit boxes overlap`
        )
      }
    }
    // And the sliver is still resizable — suppressing the crowd must not
    // suppress the whole set, which would make a thin element un-resizable.
    assert.ok(boxes.length > 0, `at ${w}x${h} every handle was suppressed`)
  }
})

selectedTarget.getBoundingClientRect = () => new window.DOMRect(20, 30, 100, 60)

/*
 * Leaving Notes or closing the board changes only the stand-down gate, and the
 * painter used to watch only `interactive` and `chromeHidden`: the outline and
 * handles stayed hidden after either until the pointer next crossed the app.
 */
for (const [field, on, off] of [
  ["annotating", true, false],
  ["canvasView", true, false],
]) {
  await check(`the selection comes back when ${field} turns off with the pointer still`, async () => {
    context.select(selectedTarget)
    await nextPaint()
    context.setState({ [field]: on, hovered: null })
    await nextPaint()
    assert.equal(selectionOutline.style.display, "none", "stood down")
    context.setState({ [field]: off })
    await nextPaint()
    assert.equal(selectionOutline.style.display, "block", "painted again without a pointer move")
    assert.ok(selectionHandles.some((handle) => handle.style.display === "block"))
  })
}

context.select(null)
context.setState({ hovered: null })
selectedTarget.remove()

const { resolveConfig } = await import(path.join(PACKAGE_DIR, "config.mjs"))
const { patchOverlay } = await import(path.join(PACKAGE_DIR, "runtime/vendor-patch.mjs"))
const vendorSource = await fs.readFile(
  vendorOverlayPath(),
  "utf8"
)
const patchedVendor = patchOverlay(vendorSource, resolveConfig({}, { cwd: PACKAGE_DIR }))

await check("the vendor overlay is patched off its own rAF loop", () => {
  assert.match(
    patchedVendor,
    /function qe\(\)\{for\(let e of \[se,j,\.\.\.G\]\)e&&\(e\.current=\{\.\.\.e\.target\},e\.opacity=e\.targetOpacity\);P&&oe&&P\.clearRect/
  )
  assert.doesNotMatch(
    patchedVendor,
    /function qe\(\)\{Yt===null&&\(Yt=requestAnimationFrame\(bs\)\)\}/
  )
})

const disabledControl = {
  path: "Cards.Layout.gap",
  key: "gap",
  label: "Gap",
  type: "SELECT",
  value: 8,
  valueText: "8",
  variants: ["Compact", "Comfortable"],
  variantValues: [8, 16],
  bounds: null,
  disabled: true,
  visible: true,
  selectors: [],
  relationship: null,
  defaultGroup: null,
  defaultKey: null,
  canPersistDefault: false,
}
await check("a disabled control disables every input it draws", () => {
  const disabledRow = editorModule.controlRow(disabledControl, context)
  assert.ok(
    Array.from(disabledRow.querySelectorAll(".de-opt-chip")).every((button) => button.disabled)
  )
  const disabledNumber = editorModule.controlRow(
    { ...disabledControl, type: "NUMBER", variants: null, variantValues: null },
    context
  )
  assert.equal(disabledNumber.querySelector(".de-opt-input").disabled, true)
})

/*
 * This used to open a floating options window, assert it took focus, and assert
 * Escape gave the focus back. There is no window: the controls it held are a
 * docked pane in the left panel now, reached by a tab, and a pane in a tab
 * strip has no dismissal to return focus from.
 *
 * What survives as a claim about the SHELL is the deletion itself. The window
 * was a `document.body` root with a window-capture Escape listener on it, which
 * is the one thing a surface outside the panels can do to every other surface
 * in the chrome: absorb a key press before the shortcut layer ever sees it. The
 * focus behaviour of the pane belongs to the pane, and `options-cases.mjs`
 * drives it there.
 */
await check("the chrome mounts no options surface over the app to swallow keys", () => {
  assert.equal(window.document.querySelector(".de-opt-window"), null)
  assert.equal(window.document.querySelector(".de-options-root"), null)
  assert.equal(window.document.querySelector('[data-designlayer] [role="dialog"]'), null)
})

/*
 * Interactive mode has two halves, and only one of them was ever ours.
 *
 * The vendor registers a `document`-capture guard that stops every gesture not
 * aimed at its own shadow chrome. Gating the editor's handlers on
 * `editorOwnsInput()` left that guard standing, so with the mode ON an app
 * button received neither pointerdown nor click — measured live before the fix.
 * `restoreChromeFocus` neuters the guard's methods from `window` capture, which
 * runs first; the mode widens that from our chrome to the app.
 */
const shell = editorModule.mountShell()

await check("interactive mode hands the gesture to the app, and only then", () => {
  const appButton = window.document.createElement("button")
  window.document.body.append(appButton)
  let reached = 0
  appButton.addEventListener("pointerdown", () => {
    reached += 1
  })

  // Stands in for the vendor's guard: same node, same phase, same method. It is
  // registered after the shell so the shell's window-capture listener runs first,
  // which is the ordering the real page has.
  window.document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target instanceof window.Element && event.target.closest("[data-designlayer]")) return
      event.stopPropagation()
    },
    true
  )

  const press = () =>
    appButton.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true }))

  editorModule.setState({ interactive: false })
  press()
  assert.equal(reached, 0, "the app answered a click while the editor owned input")

  editorModule.setState({ interactive: true })
  press()
  assert.equal(reached, 1, "interactive mode did not reach the app — the vendor guard is still standing")

  editorModule.setState({ interactive: false })
  press()
  assert.equal(reached, 1, "the app stayed reachable after the mode was switched back off")
})

/*
 * Text typed into the chrome cannot be dragged out of it.
 *
 * The browser makes a selection inside an `input` or a `textarea` draggable,
 * and in a tool floating over somebody else's page that default does two bad
 * things at once. A same-window text drag is a MOVE, so dragging the words out
 * of a half-written note deletes them from the field; and the drop lands on the
 * APP, which for a prototype with a `contenteditable` in it is an edit nobody
 * made, on the page the note was about.
 *
 * Reported against the note composer and fixed for every field in the chrome,
 * since all of them drop onto the same app. The second and third assertions are
 * the ones that keep the fix honest: the Layers panel reorders by dragging whole
 * ROWS, and the app is allowed its own drag-and-drop.
 */
await check("a note cannot be dragged out of the field it was typed into", () => {
  const field = window.document.createElement("textarea")
  field.value = "the helper text loses its last word"
  shell.root.append(field)

  const row = window.document.createElement("div")
  row.draggable = true
  shell.root.append(row)

  const appNode = window.document.createElement("div")
  appNode.draggable = true
  window.document.body.append(appNode)

  const drag = (node) => {
    const event = new window.Event("dragstart", { bubbles: true, cancelable: true })
    node.dispatchEvent(event)
    return event.defaultPrevented
  }

  assert.equal(drag(field), true, "a selection can still be dragged out of a field in the chrome")
  assert.equal(drag(row), false, "the guard took the Layers panel's row drag with it")
  assert.equal(drag(appNode), false, "the guard reached into the app's own drag-and-drop")

  field.remove()
  row.remove()
  appNode.remove()
})

/*
 * The toolbar toggle and the panel it names, joined up.
 *
 * The bar and the shell are two modules that never call each other — they meet
 * at the store — so nothing but a mounted shell proves the button does anything.
 * Asserting the toggle's `aria-pressed` alone would pass with the panel welded
 * open, which is exactly the failure a bar-only test cannot see.
 */
const panel = (side) => shell.root.querySelector(`.de-panel--${side}`)
const toggle = (name) => context.slots.toolbar.querySelector(`[aria-label="${name}"]`)

await check("a toolbar toggle actually shows and hides the panel it names", () => {
  for (const [name, side, inset] of [
    ["Show or hide left panel", "left", "--de-left"],
    ["Show or hide inspector", "right", "--de-right"],
  ]) {
    editorModule.setState({ layersOpen: true, inspectorOpen: true })
    assert.equal(panel(side).hidden, false, `${side} panel did not start open`)
    toggle(name).click()
    assert.equal(panel(side).hidden, true, `${side} panel is still showing after the toggle`)
    assert.equal(document.documentElement.style.getPropertyValue(inset), "0px")
    toggle(name).click()
    assert.equal(panel(side).hidden, false, `${side} panel did not come back`)
    assert.notEqual(document.documentElement.style.getPropertyValue(inset), "0px")
  }
})

await check("the toggle's pressed state and the panel never disagree", () => {
  for (const [name, side, flag] of [
    ["Show or hide left panel", "left", "layersOpen"],
    ["Show or hide inspector", "right", "inspectorOpen"],
  ]) {
    for (const open of [false, true, false]) {
      // Driven from the store rather than the button, because the shell writes
      // these flags too and the button must not be remembering its own clicks.
      editorModule.setState({ [flag]: open })
      assert.equal(toggle(name).getAttribute("aria-pressed"), String(open))
      assert.equal(panel(side).hidden, !open)
    }
    editorModule.setState({ [flag]: true })
  }
})

/*
 * The app is allowed to make its own glyphs unclickable; the editor still has
 * to be able to select them. jsdom does not cascade `pointer-events`, so this
 * holds the two halves the editor owns — the rule and the mode class that arms
 * it — and the live proof is the CFT pass over a real icon.
 */
await check("inspecting mode makes the app's unclickable glyphs hit-testable", () => {
  const rule = editorModule.shellCss.match(/html\.designlayer-inspecting svg \{[^}]*\}/)
  assert.notEqual(rule, null, "no rule re-arms `<svg>` hit-testing while inspecting")
  assert.match(rule[0], /pointer-events:\s*all/)

  editorModule.setState({ interactive: false })
  assert.equal(document.documentElement.classList.contains("designlayer-inspecting"), true)
  editorModule.setState({ interactive: true })
  assert.equal(
    document.documentElement.classList.contains("designlayer-inspecting"),
    false,
    "interactive mode did not hand the app back its own hit behaviour"
  )
  editorModule.setState({ interactive: false })
  assert.equal(document.documentElement.classList.contains("designlayer-inspecting"), true)
})

await check("no control anywhere in the shell draws the hand tool", () => {
  assert.equal(shell.root.querySelector('[aria-label*="Hand"]'), null)
  assert.equal(context.slots.toolbar.querySelector('[aria-label*="Hand"]'), null)
})

/*
 * Standing the editor down, and the one button that brings it back.
 *
 * Three separate claims, and the first is the one a CSS-only test would miss:
 * hiding is not closing both panels. The panels keep their own flags, the
 * canvas lane stops answering, and the app's inset goes with it — so these
 * drive the store and read the DOM, rather than trusting the stylesheet.
 */
const launcher = () => shell.root.querySelector(".de-launcher")
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

await check("hiding the editor drops the app's inset without closing the panels", () => {
  const html = window.document.documentElement
  editorModule.setState({ layersOpen: true, inspectorOpen: true, chromeHidden: false })
  const openInset = html.style.getPropertyValue("--de-left")

  editorModule.setState({ chromeHidden: true })
  assert.equal(html.classList.contains("designlayer-chrome-hidden"), true)
  assert.equal(html.style.getPropertyValue("--de-left"), "0px")
  assert.equal(html.style.getPropertyValue("--de-right"), "0px")
  // Not closed — parked. The panel a designer had open is the panel they get
  // back, which is the whole difference between this and the two toggles.
  assert.equal(panel("left").hidden, false, "hiding the chrome closed the layers panel")
  assert.equal(panel("right").hidden, false, "hiding the chrome closed the inspector")

  editorModule.setState({ chromeHidden: false })
  assert.equal(html.classList.contains("designlayer-chrome-hidden"), false)
  assert.equal(html.style.getPropertyValue("--de-left"), openInset)
})

await check("hidden chrome hands the pointer back, exactly as interactive mode does", () => {
  editorModule.setState({ interactive: false, chromeHidden: false })
  assert.equal(editorModule.editorOwnsInput(), true)

  editorModule.setState({ chromeHidden: true })
  assert.equal(editorModule.editorOwnsInput(), false, "a hidden editor is still eating clicks")
  assert.equal(
    window.document.documentElement.classList.contains("designlayer-inspecting"),
    false
  )

  editorModule.setState({ chromeHidden: false })
  assert.equal(editorModule.editorOwnsInput(), true)
})

/*
 * The launcher and the mode switch draw ONE pointer.
 *
 * Two modules that never call each other, each asking the icon set for the
 * editor's arrow — so nothing but this holds them to the same drawing. They
 * drifted before: the set used to carry `Cursor` and `CursorOutline` as two
 * hand-authored paths kept in agreement by eye, which is how the two ended up
 * reading as different marks at their two sizes.
 *
 * The filled weight in both, because each is the editor claiming the pointer:
 * the switch fills while it is holding your clicks, and the disc only ever
 * exists in order to take them back.
 *
 * There was a third, and it went with the morph that needed it.
 * `.de-toolbar-mark` was the face the pill wore once it had become the disc: it
 * faded up inside the collapsing bar and landed directly underneath the
 * launcher, which crossfaded onto the same pixels. Two discs occupying one
 * place for the last stretch of a morph is invisible only while they are the
 * same drawing, so that mark needed this agreement harder than either surface
 * left here does. The bar fades where it stands now and no glyph of its own
 * fades up inside it, so there is no third drawing to hold to anything.
 *
 * The size comparison went with it, and had to. It read the mark against the
 * disc rather than against a literal, which was right while the two were the
 * same glyph a frame apart; these two are `tokens.icon.chrome` and
 * `tokens.icon.action` and are SUPPOSED to differ by a rung, because one sits
 * alone on a disc and the other in a row of eight. What is left is the drawing
 * and the weight, which is the whole of what the eye reads as the same mark.
 *
 * Which weight is showing is read off the root `fill`, never off the path data
 * alone. That has now been wrong in both directions. Comparing `d` told the two
 * weights apart while the set drew a separate silhouette for each, and then
 * stopped meaning anything when the family became strokes and every glyph
 * reported itself filled — a test that cannot fail rather than one that passes.
 *
 * `Cursor` is native now, and its two weights are two drawings again, for a
 * reason neither earlier set had: a native outline is an even-odd ANNULUS that
 * states its own fill, so the root flood paints nothing over it. What keeps
 * that from being the old drift is the shape of the pair — the hollow weight is
 * the solid one with a second subpath punched out of it, so the solid `d` is a
 * PREFIX of the hollow `d` and the two share an outer boundary by construction
 * rather than by agreement. That is what is asserted below.
 */
/*
 * The mode switch keeps BOTH weights mounted and crossfades between them
 * (`core/swap-mark.ts`), so `querySelector("svg")` on it always finds the
 * resting outline whatever state it is in. What this case is about is the mark
 * the user can see, so it asks for that one — the same reading the stylesheet
 * makes, off the `de-swap--done` class.
 */
const shownIn = (button) => {
  const swap = button.querySelector(".de-swap")
  if (!swap) return button.querySelector("svg")
  return swap.querySelector(
    swap.classList.contains("de-swap--done") ? ".de-swap-done" : ".de-swap-rest"
  )
}

await check("the launcher and the mode switch wear the same pointer", () => {
  editorModule.setState({ interactive: false, chromeHidden: false })
  const modeGlyph = shownIn(context.slots.toolbar.querySelector(".de-button--mode"))
  const launcherGlyph = launcher().querySelector("svg")
  assert.ok(modeGlyph && launcherGlyph, "one of the two draws no glyph")
  const shapes = (svg) =>
    Array.from(svg.querySelectorAll("path")).map((node) => node.getAttribute("d")).join("|")
  assert.ok(shapes(modeGlyph), "the mode switch draws no path")
  assert.equal(
    shapes(launcherGlyph),
    shapes(modeGlyph),
    "the launcher and the Inspecting switch draw different pointers"
  )
  // Both solid, because each is the editor holding the pointer.
  assert.equal(launcherGlyph.getAttribute("fill"), "currentColor")
  assert.equal(modeGlyph.getAttribute("fill"), "currentColor")

  // Handing the pointer back hollows the switch: Phosphor's regular cursor, the
  // fill weight's outline with a hole in it.
  editorModule.setState({ interactive: true })
  const handedBack = shownIn(context.slots.toolbar.querySelector(".de-button--mode"))
  assert.equal(
    handedBack.getAttribute("fill"),
    "none",
    "handing the pointer to the app left the switch drawing the solid arrow"
  )
  const subpaths = (svg) => (shapes(svg).match(/M/gi) ?? []).length
  assert.notEqual(shapes(handedBack), shapes(launcherGlyph), "both surfaces draw the solid arrow")
  assert.ok(
    subpaths(handedBack) > subpaths(launcherGlyph),
    "hollowing the switch punched nothing out — both surfaces draw the solid arrow"
  )
  editorModule.setState({ interactive: false })
})

await check("the bar's hide control and the launcher are the two halves of one switch", () => {
  const hide = label("Hide editor")
  assert.notEqual(hide, null, "no hide control in the bar")
  hide.click()
  assert.equal(context.getState().chromeHidden, true)

  assert.notEqual(launcher(), null, "no launcher to come back with")
  launcher().click()
  assert.equal(context.getState().chromeHidden, false, "the launcher did not bring the editor back")
})

/*
 * Cmd+. — Figma's key for the same idea, and the one shortcut that has to work
 * while the editor is invisible.
 *
 * Driven from `window` rather than from the button, because half the states it
 * toggles between have no button on screen and the focus is somewhere in the
 * app. It is also the only editor shortcut not gated on `ownsCanvasKeys` for
 * exactly that reason, which is worth a test of its own: a gate added here by
 * a later change would leave a hidden editor with no way back except the mouse.
 */
const press = (init) =>
  window.dispatchEvent(
    new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  )
const accelerator = /Mac|iPhone|iPad/.test(window.navigator.platform || window.navigator.userAgent)
  ? { metaKey: true }
  : { ctrlKey: true }

await check("cmd+. hides the editor and brings it back", () => {
  editorModule.setState({ chromeHidden: false })
  press({ key: ".", ...accelerator })
  assert.equal(context.getState().chromeHidden, true, "cmd+. did not hide the editor")
  press({ key: ".", ...accelerator })
  assert.equal(context.getState().chromeHidden, false, "cmd+. did not bring it back")
})

await check("cmd+. is claimed, not passed to the page", () => {
  const event = new window.KeyboardEvent("keydown", {
    key: ".",
    bubbles: true,
    cancelable: true,
    ...accelerator,
  })
  window.dispatchEvent(event)
  // Safari reads Cmd+. as stop-loading, so the default has to go.
  assert.equal(event.defaultPrevented, true)
  editorModule.setState({ chromeHidden: false })
})

/*
 * ⌘. in a field used to be left to the field, and the field never wanted it:
 * ⌘. types nothing. Every prototype has a field that holds focus, so the way
 * back went dead whenever one did. An inspector field caught mid-edit commits
 * on blur, so hiding the chrome lands the edit rather than losing it.
 */
await check("a bare period is left alone, and cmd+. in a field is still the way back", () => {
  editorModule.setState({ chromeHidden: false })
  press({ key: "." })
  assert.equal(context.getState().chromeHidden, false, "an unmodified period hid the editor")

  const field = window.document.createElement("input")
  window.document.body.append(field)
  try {
    field.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: ".", bubbles: true, cancelable: true, ...accelerator })
    )
    assert.equal(context.getState().chromeHidden, true, "cmd+. typed in a field was read as typing")
  } finally {
    editorModule.setState({ chromeHidden: false })
    field.remove()
  }
})

/*
 * ⌘Z and ⇧⌘Z, wired up rather than merely implemented.
 *
 * `history-cases.mjs` proves `historyAction` reads the two presses correctly;
 * this proves the toolbar's listener actually calls it and travels history. The
 * two halves are in different files and neither implies the other — the key
 * could resolve perfectly and reach nothing, which is exactly what an early
 * `return` added ahead of it in that handler would cause. One was added: the
 * ⌘. branch now runs first.
 */
await check("cmd+z and shift+cmd+z reach history, not just the keymap", () => {
  // One real step on the timeline, so each press has something to move — the
  // step's own callbacks are the proof the handler reached history.
  editorModule.resetHistory()
  const moved = []
  editorModule.record({
    label: "Probe",
    undo: () => moved.push("undo"),
    redo: () => moved.push("redo"),
  })
  toasts.length = 0
  press({ key: "z", ...accelerator })
  assert.equal(editorModule.canRedo(), true, "cmd+z did not reach history")
  press({ key: "z", shiftKey: true, ...accelerator })
  assert.equal(editorModule.canUndo(), true, "shift+cmd+z did not reach history")
  assert.deepEqual(moved, ["undo", "redo"])
  // Undo and redo are direct manipulation: the canvas is the report.
  assert.deepEqual(toasts, [], "undo or redo raised a toast")
  editorModule.resetHistory()
})

await check("cmd+z is claimed from the page and the vendor's guard", () => {
  const event = new window.KeyboardEvent("keydown", {
    key: "z",
    bubbles: true,
    cancelable: true,
    ...accelerator,
  })
  window.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true, "the browser's own undo was left to fire too")
})

/*
 * The rule the icon set exists to serve: on is HEAVIER, off is the rung's own
 * weight.
 *
 * It used to be "on is filled", carried by shipping every glyph twice and
 * letting CSS show one group and hide the other. Lucide is a stroke family with
 * no filled counterparts, and flooding an outline with `currentColor` is
 * legible only for a closed silhouette — so the state moved onto the stroke,
 * which every glyph has.
 *
 * What is unchanged, and what this actually guards, is that the state is
 * carried by CSS off `aria-pressed`/`aria-selected` rather than by each control
 * repainting its own glyph. jsdom does not cascade, so the rule is asserted as
 * text, and the DOM half — the glyph carries the per-rung stroke the rule
 * builds on, and the marker that scopes it — is asserted on a live element.
 */
await check("a pressed control draws its glyph heavier than an unpressed one", () => {
  const toggle = context.slots.toolbar.querySelector('[aria-label="Show or hide left panel"]')
  const glyph = toggle.querySelector("svg")
  assert.ok(glyph.hasAttribute("data-de-glyph"), "the toggle's glyph is unmarked, so the rule misses it")
  assert.ok(
    Number(glyph.getAttribute("stroke-width")) > 0,
    "the toggle's glyph has no stroke for the pressed rule to build on"
  )
  assert.ok(
    glyph.style.getPropertyValue("--de-icon-stroke"),
    "the glyph does not publish its rung's stroke, so one CSS rule cannot serve six sizes"
  )

  const css = editorModule.shellCss
  assert.match(
    css,
    /\[aria-pressed="true"\][^{}]*svg\[data-de-glyph\][^{}]*\{[^}]*stroke-width:\s*calc\(var\(--de-icon-stroke/s
  )
  assert.match(css, /\[aria-selected="true"\][^{}]*svg\[data-de-glyph\]/s)
})

await check("a drag moves the launcher, remembers where, and is not a click", async () => {
  editorModule.setState({ chromeHidden: true })
  const fab = launcher()
  const point = (type, x, y) =>
    fab.dispatchEvent(
      new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y })
    )

  point("pointerdown", 100, 100)
  // Inside the slack: a hand that shakes two pixels between down and up is
  // still pressing the button, not moving it.
  point("pointermove", 105, 102)
  await settle()
  assert.equal(fab.style.left, "", "a 5px tremor moved the launcher")

  point("pointermove", 260, 300)
  point("pointerup", 260, 300)
  await settle()
  // jsdom lays nothing out, so the button starts at 0,0 and the delta IS the
  // position. The arithmetic under test is the delta, not the origin.
  assert.equal(fab.style.left, "160px")
  assert.equal(fab.style.top, "200px")
  assert.equal(fab.style.right, "auto", "the corner anchor is still in force")
  assert.equal(
    window.localStorage.getItem("designlayer:launcher-position"),
    JSON.stringify({ x: 160, y: 200 })
  )

  // The browser fires this at the end of every drag that began and ended on
  // the same element. It must not count.
  fab.click()
  assert.equal(context.getState().chromeHidden, true, "the drag also opened the editor")
  fab.click()
  assert.equal(context.getState().chromeHidden, false, "the click after the drag was swallowed too")
})

/*
 * The edge is HARD, and it is hard under the hand rather than on release.
 *
 * There used to be a rubber band here: the disc followed the pointer past the
 * bound with diminishing give, and the overhang was handed back when the
 * gesture ended. That is gone, and this case is no longer about a disc being
 * pulled back — there is nothing to pull back. The band is borrowed from
 * scrolling, where the overhang reveals empty space the user owns; this disc
 * hangs over somebody else's product, so an overhang is live app pixels
 * covered by chrome that is not allowed to be there. "Momentarily wrong" is a
 * flash of misplaced UI, not a piece of physics.
 *
 * The mid-gesture assertion is the one the old design could not make, and it
 * is the whole of what changed: the position is read while the pointer is
 * still down, and the disc is already sitting on the bound. Reading it after
 * `pointerup` — which is all this case used to do — passes under either
 * design, because the release clamp was always there.
 */
await check("a launcher dragged past the edge stops dead at it, under the hand", async () => {
  editorModule.setState({ chromeHidden: true })
  const fab = launcher()
  const point = (type, x, y) =>
    fab.dispatchEvent(
      new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 2, clientX: x, clientY: y })
    )
  // The VIEWPORT's corner, 32px off each edge, and the panels are not in it.
  // The disc used to clamp against `--de-left`/`--de-right` like the bar does,
  // which put its right-hand bound on the inspector's inner edge — see the case
  // below, where that cost a saved corner 282px.
  // 40 is the disc's size, which is the toolbar's height — see `css/launcher.ts`.
  const corner = { x: window.innerWidth - 40 - 32, y: window.innerHeight - 40 - 32 }
  point("pointerdown", 0, 0)
  point("pointermove", 9000, 9000)
  // The paint is batched into an animation frame, so the drag is read one
  // frame later — not one gesture later.
  await settle()
  assert.equal(Number.parseInt(fab.style.left, 10), corner.x, "the disc followed the hand off the right edge")
  assert.equal(Number.parseInt(fab.style.top, 10), corner.y, "the disc followed the hand off the bottom edge")

  point("pointerup", 9000, 9000)
  await settle()
  // Unmoved by the release, which is the other half of "hard": a bound that
  // corrected anything here would be a bound the drag had not been keeping.
  assert.equal(Number.parseInt(fab.style.left, 10), corner.x)
  assert.equal(Number.parseInt(fab.style.top, 10), corner.y)
  editorModule.setState({ chromeHidden: false })
})

/*
 * The motion, as a contract rather than as a feeling.
 *
 * What can be asserted from here is the part that has a right answer: the
 * panels leave on `transform`, nothing in the hidden state transitions a
 * property the APP is laid out by, and reduced motion keeps a fade instead of
 * keeping nothing. How it FEELS is a question for the browser.
 *
 * Two bans, and they are held for different reasons. The insets — the padding
 * the chrome pushes into the page — are what the app is actually laid out by,
 * and transitioning one relayouts somebody else's product on every frame of
 * ours. A surface's own `width` or `height` costs the app nothing, since every
 * one of these is `position: fixed` and out of its flow; it is banned because
 * animating a box is a layout per frame to draw something `transform` and
 * `opacity` hand to the compositor, and because nothing here needs it.
 *
 * The second ban was repealed for exactly one rule, and is reinstated with the
 * morph it was granted to. That morph — the pill contracting to a 44px disc —
 * genuinely could not be written any other way: a non-uniform `scale` squashes
 * the radius into an ellipse and drags the shadow out of round with it, and a
 * `clip-path` wipe throws the cast away entirely, so both animate a picture of
 * the disc rather than the disc. The bar fades where it stands now, which costs
 * no box at all, so the exemption has nothing left to buy and the loop below is
 * absolute again: every hidden-state rule, the bar's included. An exemption
 * kept past the thing that needed it is how a panel comes to animate its own
 * width on the strength of an argument about a pill.
 */
await check("standing down animates the chrome's own box — never the app's layout", () => {
  const css = editorModule.shellCss
  const rules = css.match(/html\.designlayer-chrome-hidden[^{]*\{[^}]*\}/g) ?? []
  assert.ok(rules.length >= 4, `only ${rules.length} rules drive the hidden state`)
  /** The properties the page is laid out by. Transitioned by nothing, ever. */
  const appLayout = /transition:[^;]*\b(padding|margin|inset|left|top|right|bottom)\b/
  /** A surface's own box. Transitioned by nothing either, now the morph is gone. */
  const ownBox = /transition:[^;]*\b(width|height)\b/
  for (const rule of rules) {
    assert.doesNotMatch(
      rule,
      appLayout,
      `a hidden-state rule transitions a property the app is laid out by:\n${rule}`
    )
    assert.doesNotMatch(rule, ownBox, `a hidden-state rule animates its own box:\n${rule}`)
  }
  assert.match(css, /html\.designlayer-chrome-hidden \.de-panel--left \{[^}]*translateX/)
  assert.match(css, /html\.designlayer-chrome-hidden \.de-panel--right \{[^}]*translateX/)
  // The parked panel has to be inert, not merely off-screen: a fixed element at
  // -100% is still tabbable, and Tab would walk into a panel nobody can see.
  assert.match(css, /html\.designlayer-chrome-hidden \.de-panel \{[^}]*visibility: hidden/)
})

/*
 * The bar leaves on opacity, and on nothing else.
 *
 * This case has said three things about one rule. It began as "it does not
 * move, at all, in either axis". The morph repealed exactly that much — a pill
 * that BECOMES the disc has to carry itself to wherever the disc is parked, in
 * both axes, because an object turning into another object has to go where it
 * is going. The morph has been reverted, so the original claim is back, and it
 * is now the whole claim: the bar fades where it stands, and each way it could
 * move is banned rather than merely unused.
 *
 * Three failure modes, and every one of them has happened:
 *
 *  - a `translateY` through the bottom edge, alongside the panels sliding out
 *    to theirs. Three surfaces leaving by three different edges is one motion
 *    too many for a toggle pressed this often, and the bar is the one with no
 *    edge of its own to leave by — it is centred over the app, not docked to
 *    anything;
 *  - `transform` in its transition list, which would animate the centring
 *    offset itself — `translateX(-50%)` lives on that property, so the bar
 *    would slide sideways as the canvas widened under it. That is why the
 *    morph's trip was written as the standalone `translate` property, and it is
 *    why `translate` is banned here now that there is no trip: the two
 *    properties are the two doors the same wrongness comes back through;
 *  - the centring inset changing underneath it, which is the subtle one. The
 *    bar is centred on the CANVAS, the canvas widens the instant the chrome
 *    hides, and sharing `--de-left`/`--de-right` with the app's padding made
 *    the bar jump sideways at full opacity before the fade had even started.
 *    The drop used to cover that up; a fade does not, which is what the second
 *    half of this case, at the bottom, is for.
 *
 * `width`, `height` and `border-radius` are banned one layer down from the case
 * above: that one forbids TRANSITIONING a box, this one forbids the hidden
 * state declaring a different box at all. A 44px `width` left here with nothing
 * animating it is not half a morph, it is a pill that snaps to a disc in one
 * frame and then fades — worse than either design, and exactly the wreckage a
 * partial revert leaves.
 *
 * Two assertions on the base rule went with the morph as well. One pinned
 * `width: var(--de-toolbar-width, auto)`, a variable that existed solely so the
 * collapse had a number to interpolate away from, since `auto` does not
 * animate. The other pinned `justify-content: center`, so the row of controls
 * stayed under the mark while the box contracted around it; no box contracts,
 * and neither declaration is in the stylesheet any more. What the base rule is
 * still held to is the one thing the third failure mode turns on.
 *
 * Both rules are matched at the START of a line, and that is not cosmetics.
 * `html.designlayer-chrome-hidden .de-toolbar {` also occurs indented inside
 * the reduced-motion block in `css/base.ts`, and an unanchored match found that
 * one instead — a two-declaration fade that satisfies every ban below while
 * saying nothing about the rule that actually hides the bar. The base rule was
 * anchored the other way, on `position: fixed` being its first declaration,
 * which held only for as long as nobody added a declaration above it; it names
 * the property it is looking for now and lets the rule grow.
 */
await check("the bar fades where it stands — never to an edge, never on transform", () => {
  const css = editorModule.shellCss
  const hidden = css.match(/\nhtml\.designlayer-chrome-hidden \.de-toolbar \{[^}]*\}/)?.[0] ?? ""
  assert.ok(hidden, "no rule hides the toolbar at all")
  assert.match(hidden, /opacity: 0/, "the bar never hands its pixels over")
  // The fade is a transition, not a disappearance. Without this the bans below
  // are all satisfied by a rule that cuts the bar out between two frames.
  assert.match(
    hidden,
    /transition:[^;]*\bopacity\b/,
    "the bar is cut rather than faded, so the ban above is on a jump cut"
  )
  assert.doesNotMatch(hidden, /translateY/, "the bar still drops through the bottom")
  assert.doesNotMatch(hidden, /transform/, "the bar still animates a transform")
  for (const property of ["translate", "width", "height", "border-radius"]) {
    assert.doesNotMatch(
      hidden,
      new RegExp(property),
      `the hidden bar still declares \`${property}\` — a piece of the morph outlived it`
    )
  }

  const base = css.match(/\n\.de-toolbar \{[^}]*position: fixed;[^}]*\}/)?.[0] ?? ""
  assert.ok(base, "the toolbar's base rule moved")
  /*
   * The bar's resting place does not read the insets AT ALL, which settles the
   * third failure mode outright rather than working around it.
   *
   * This used to require the opposite — `left: calc(var(--de-bar-left) + …)` —
   * because the bar was centred on the canvas, and the only thing standing
   * between that and a sideways jump at the start of every hide was the
   * `--de-bar-*` pair holding its value through the fade. A bar centred on the
   * WINDOW has nothing to re-centre onto: the insets can collapse, hold, or
   * change by any amount, and 50vw is 50vw. The jump this case was written to
   * catch is now unreachable from the stylesheet.
   *
   * The pair is still asserted to hold below, and still should — `max-width`
   * reads it, so a bar whose width popped as the fade began would be the same
   * bug wearing a different property.
   */
  assert.match(base, /left: 50vw;/, "the bar rests somewhere other than the window's middle")
  assert.doesNotMatch(
    base,
    /left: calc\(var\(--de-bar-/,
    "the bar centres on insets again, so hiding the chrome re-centres it mid-fade"
  )

  // And the variables really do hold their value through a hide.
  editorModule.setState({ layersOpen: true, inspectorOpen: true, chromeHidden: false })
  const html = window.document.documentElement
  const open = [
    html.style.getPropertyValue("--de-bar-left"),
    html.style.getPropertyValue("--de-bar-right"),
  ]
  assert.deepEqual(open, ["240px", "260px"])
  editorModule.setState({ chromeHidden: true })
  assert.deepEqual(
    [html.style.getPropertyValue("--de-bar-left"), html.style.getPropertyValue("--de-bar-right")],
    open,
    "the bar re-centred while it was fading out"
  )
  // The app's own inset still collapses — that is a different pair, and it must.
  assert.equal(html.style.getPropertyValue("--de-left"), "0px")
  editorModule.setState({ chromeHidden: false })
})

/*
 * The collapse hands the stylesheet nothing, and no rule is left asking.
 *
 * There used to be numbers CSS could draw with and could not compute: the
 * pill's natural width, which is whatever nine controls happen to measure, and
 * the two halves of its trip, which depend on where the disc was last dragged.
 * `shell/toolbar.ts` measured them at the moment of the collapse and wrote them
 * onto `<html>` as inline custom properties for the rules to read back. All
 * four were the morph's and the morph is gone, so publishing is a thing this
 * editor no longer does — and the case that guarded the publisher is inverted
 * here rather than deleted, because a publisher is not something you can tell
 * has stopped by looking.
 *
 * That is the whole argument for spending a case on an absence. Every one of
 * those properties was declared with a fallback, so a lane still writing one
 * would throw nothing, break no layout and fail nothing else in this file: it
 * would force a style recalculation of the whole app on every hide in order to
 * hand the stylesheet four numbers nobody reads. Dead code with a per-collapse
 * cost and no symptom is the kind a revert leaves behind, and the only way to
 * find it is to come looking.
 *
 * Both directions, because the publish never was symmetric — it ran on the way
 * down and left its properties standing on `<html>` afterwards. So the show is
 * checked too, and a variable written by a hide and never cleaned up fails here
 * rather than in whatever reads it next.
 *
 * And the other end of the wire, because the two halves fail separately: a
 * property nobody publishes but a rule still reads is a declaration running on
 * its fallback for ever, which is a bar sized `auto` and a trip of `0px` — the
 * new design arrived at by accident rather than on purpose, and indistinguishable
 * from it until somebody starts publishing again.
 */
await check("the collapse publishes nothing, and no rule is left reading it", () => {
  const html = window.document.documentElement
  /** The morph's four, retired with it. */
  const RETIRED = [
    "--de-toolbar-width",
    "--de-collapse-dx",
    "--de-collapse-dy",
    "--de-collapse-origin-x",
  ]
  editorModule.setState({ chromeHidden: false })
  editorModule.setState({ chromeHidden: true })
  for (const name of RETIRED) {
    assert.equal(
      html.style.getPropertyValue(name),
      "",
      `hiding the editor published ${name} onto <html>`
    )
  }
  editorModule.setState({ chromeHidden: false })
  for (const name of RETIRED) {
    assert.equal(
      html.style.getPropertyValue(name),
      "",
      `showing the editor published ${name} onto <html>`
    )
  }
  for (const name of RETIRED) {
    assert.doesNotMatch(
      editorModule.shellCss,
      new RegExp(`var\\(\\s*${name}\\b`),
      `a rule still reads ${name}, so it is running on its fallback`
    )
  }
})

/*
 * The disc is bounded by the VIEWPORT, and the panels are none of its business.
 *
 * It used to read `--de-left`/`--de-right` the way the bar does, on the
 * reasoning that a floating surface should not end up underneath a docked
 * panel. Sound for the bar, which shares the screen with them. Wrong for the
 * disc, which is only ever ON screen while the editor is stood down — and a
 * stood-down editor has no panels, so those bounds describe a layout that
 * cannot be seen at the same time as the thing they are bounding.
 *
 * It was not a theoretical wrong, either. The disc resolves its saved corner at
 * MOUNT, with the panels open, so a disc left in the bottom-right corner came
 * back clamped to the inspector's inner edge — measured at 282px from the
 * corner it had been put in, against the 32 it was saved at. Closing the
 * inspector did not give it back, because the clamp deliberately only moves a
 * surface as far as it has to and then leaves it alone.
 *
 * So the case is the negative, and it is driven through a RESIZE rather than a
 * panel toggle. Nothing re-places the disc when a panel opens any more — the
 * shell hook that used to is gone, which is half the fix — and a test that only
 * toggled panels would pass on that removal alone while the bounds stayed
 * wrong. Forcing the re-place with the panels at their widest is what actually
 * asks the question.
 */
await check("the disc is parked against the viewport, whatever the panels are doing", async () => {
  editorModule.setState({ chromeHidden: true, layersOpen: true, inspectorOpen: true })
  const html = window.document.documentElement
  const fab = launcher()
  const EDGE = 32
  const SIZE = 40

  // Park it in the far corner, past the edge so the clamp is what puts it there.
  const point = (type, x, y) =>
    fab.dispatchEvent(
      new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 5, clientX: x, clientY: y })
    )
  point("pointerdown", 0, 0)
  point("pointermove", 9000, 9000)
  point("pointerup", 9000, 9000)
  await settle()
  const corner = window.innerWidth - SIZE - EDGE
  assert.equal(Number.parseInt(fab.style.left, 10), corner, "the disc did not reach the corner")

  /*
   * Now publish a fat inspector and make the disc resolve itself again. Reading
   * it would pull the disc 260px in; the viewport does not know the panel is
   * there. Written straight onto `<html>` because that is where `syncInsets`
   * puts them, and the point is to lie to the clamp as loudly as possible.
   */
  html.style.setProperty("--de-left", "240px")
  html.style.setProperty("--de-right", "260px")
  try {
    window.dispatchEvent(new window.Event("resize"))
    await settle()
    assert.equal(
      Number.parseInt(fab.style.left, 10),
      corner,
      "an open inspector moved the disc off the corner it was parked in"
    )
  } finally {
    html.style.setProperty("--de-left", "0px")
    html.style.setProperty("--de-right", "0px")
  }

  // And a plain panel toggle does not move it either, which is the shape the
  // user sees: open a panel, close it, and find the disc where it was left.
  editorModule.setState({ chromeHidden: false })
  editorModule.setState({ inspectorOpen: false })
  editorModule.setState({ inspectorOpen: true })
  editorModule.setState({ chromeHidden: true })
  await settle()
  assert.equal(
    Number.parseInt(fab.style.left, 10),
    corner,
    "opening and closing a panel walked the disc"
  )
  editorModule.setState({ chromeHidden: false })
})

/*
 * Two objects, two positions, and moving one does not move the other.
 *
 * This replaces "the collapse lands the bar exactly on the disc, wherever it
 * was dragged", which asserted an identity — the bar's collapsed centre plus
 * the published delta IS the disc's centre. That was the right assertion while
 * one surface turned into the other and the two therefore had to share a
 * position. Sharing is the part the user threw out, and the identity it
 * guaranteed is now the bug: a bar that follows the disc is a bar that cannot
 * be parked, which is the whole reason the morph went. So the claim is
 * inverted, and at more than the strength it had: that one pinned one number
 * against another, this pins that the two positions never meet at all.
 *
 * Each drag is followed by a read of the OTHER surface, because a re-coupling
 * announces itself no other way. A shared anchor put back, or one drag's
 * `landed` publishing somewhere the other can hear it, moves the second surface
 * with no error and no visible symptom — until a designer drags the bar out of
 * the way of a cookie banner and finds the disc has left the corner with it.
 *
 * Then the round trip, which is the other half of "it remembers". Nothing is
 * stored and nothing is restored: the position is the box the gesture last
 * resolved, and it outlives the collapse for the plain reason that the element
 * and its listeners do. So a surface that came back on its CSS anchor would
 * mean the gesture had been torn down and rebuilt with the chrome, which is
 * what a re-mount on show looks like from out here.
 *
 * Every number below is an inline style one of these two drags WROTE, never a
 * measured rect, because jsdom lays nothing out — the same reason the drag
 * cases above read positions rather than geometry. `left` on the bar is its
 * centre and on the disc its left edge (see each `paint`), and with a bar
 * measuring zero wide in this harness the two coincide. The targets are chosen
 * inside both surfaces' bounds — the bar's, which are the app area, and the
 * disc's, which are the viewport — so anything that moves between two reads was
 * moved, not clamped.
 *
 * The trip is taken through `setChromeHidden` rather than by writing the flag,
 * because that is the door Cmd+. and the bar's own hide control go through and
 * it does more than set the flag. A test that writes the state directly proves
 * the flag round-trips; this proves the command does.
 */
await check("the bar and the disc each remember their own position, and only their own", async () => {
  editorModule.setState({ layersOpen: true, inspectorOpen: true, chromeHidden: false })
  const bar = context.slots.toolbar
  const fab = launcher()
  const inline = (element) => [element.style.left, element.style.top]
  /** A surface resting on its CSS anchor has no inline position, and starts at 0,0 here. */
  const at = (element) => ({
    x: Number.parseFloat(element.style.left) || 0,
    y: Number.parseFloat(element.style.top) || 0,
  })
  let contact = 10
  /*
   * A gesture that puts the surface at a coordinate, rather than one that ends
   * at one. The drag tracks the pointer's DELTA from where the surface already
   * was, so the move is written as the difference and the down is at the origin.
   */
  const dragTo = async (element, target) => {
    const from = at(element)
    const id = (contact += 1)
    const point = (type, x, y) =>
      element.dispatchEvent(
        new window.PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: id,
          clientX: x,
          clientY: y,
        })
      )
    point("pointerdown", 0, 0)
    point("pointermove", target.x - from.x, target.y - from.y)
    point("pointerup", target.x - from.x, target.y - from.y)
    await settle()
  }

  // The bar first, and with the chrome up, because that is the only state it
  // can be dragged in — the disc is the surface that exists in the other one.
  const discParked = inline(fab)
  await dragTo(bar, { x: 500, y: 300 })
  assert.deepEqual(inline(bar), ["500px", "300px"], "the bar did not take the drag at all")
  assert.deepEqual(inline(fab), discParked, "dragging the bar took the disc along with it")

  context.setChromeHidden(true)
  const barParked = inline(bar)
  await dragTo(fab, { x: 400, y: 260 })
  assert.deepEqual(inline(fab), ["400px", "260px"], "the disc did not take the drag at all")
  assert.deepEqual(inline(bar), barParked, "dragging the disc took the bar along with it")

  context.setChromeHidden(false)
  assert.deepEqual(inline(bar), ["500px", "300px"], "the bar came back somewhere it was not left")
  assert.deepEqual(inline(fab), ["400px", "260px"], "the disc forgot the corner it was parked in")
})

/*
 * The bar comes back wearing what it went away in.
 *
 * Hiding the editor is not closing it, and the case further up says so about
 * the panels — the panel a designer had open is the panel they get back. The
 * same claim about the bar's own controls had nothing holding it, and it is
 * half of what was asked for alongside the two positions: park the bar, set it
 * up the way you want it, stand the editor down to look at the app, bring it
 * back and find it as you left it.
 *
 * The way this breaks is not a button forgetting. Every control in the strip
 * reads its state from the store rather than counting its own clicks, so the
 * failures worth pinning are a hide that tidies up on its way out, and a show
 * that rebuilds the row from the defaults `installToolbar` starts at. Either
 * hands back an editor in Inspect with both panels open — which is exactly what
 * a fresh mount looks like, and therefore reads as deliberate rather than as a
 * loss.
 *
 * Which is why the combination below is one nothing defaults to: notes on, the
 * inspector shut. A reset is invisible to a case that checks the defaults.
 *
 * The mode is driven through `setMode` rather than by writing the two flags,
 * because "annotating and interactive at once" is a state the store exists to
 * make unreachable and a test should not be the one place it is reachable from.
 * The trip itself goes through `setChromeHidden` for the same kind of reason:
 * that is the one function Cmd+. and the bar's hide control both call, so a
 * hide that tidies the mode up on its way out fails here. Writing `chromeHidden`
 * straight into the store steps over the very code most likely to do the
 * tidying, which is how this case would come to pass while the product did not.
 */
await check("the bar's controls come back in the state they went away in", () => {
  editorModule.setState({ layersOpen: true, inspectorOpen: true, chromeHidden: false })
  context.setMode("annotating")
  editorModule.setState({ inspectorOpen: false })

  const pressed = () =>
    ["Inspect", "Notes", "Show or hide left panel", "Show or hide inspector"].map(
      (name) => `${name}=${label(name)?.getAttribute("aria-pressed")}`
    )
  const flags = () => {
    const { interactive, annotating, layersOpen, inspectorOpen } = context.getState()
    return { interactive, annotating, layersOpen, inspectorOpen }
  }
  // Read once before the trip rather than written out as a literal twice: the
  // claim is that the two readings agree, not that either is a particular row.
  const before = { pressed: pressed(), flags: flags() }
  assert.deepEqual(
    before.pressed,
    ["Inspect=false", "Notes=true", "Show or hide left panel=true", "Show or hide inspector=false"],
    "the bar does not report the state it was just put into, so the trip below proves nothing"
  )

  context.setChromeHidden(true)
  context.setChromeHidden(false)

  assert.deepEqual(flags(), before.flags, "standing the editor down rewrote what it was doing")
  assert.deepEqual(pressed(), before.pressed, "the bar came back reporting a state it is not in")
  // The mode switch's weight is the one piece of this the cascade does not
  // carry — `paintMode` names it, because the arrow has to hollow in two of the
  // three modes and `aria-pressed` only tells one of them apart.
  assert.equal(
    context.slots.toolbar.querySelector(".de-button--mode svg").getAttribute("fill"),
    "none",
    "the switch came back drawing the solid arrow, so a hidden editor was put back into Inspect"
  )

  context.setMode("inspecting")
  editorModule.setState({ inspectorOpen: true })
})

await check("reduced motion keeps the crossfade and drops the travel", () => {
  const block = editorModule.shellCss.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)
  assert.notEqual(block, null, "the shell has no reduced-motion block at all")
  assert.match(block[0], /\.de-panel, \.de-toolbar, \.de-launcher \{[^}]*opacity/)
  assert.match(block[0], /transform: none !important/)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
