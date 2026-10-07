/**
 * Bottom-toolbar contract: what it draws, what it must never draw again, and
 * what interactive mode does to a click.
 *
 * The removals are asserted rather than merely deleted because a toolbar is
 * where speculative controls accrete: the zoom stepper, the measure reminder
 * and the capability inventory each arrived as one more button. A test that
 * names them by their rendered text is the cheapest thing that notices one
 * coming back.
 *
 * Usage: node designlayer/test/toolbar-cases.mjs
 */

import assert from "node:assert/strict"
import vm from "node:vm"
import { JSDOM } from "jsdom"

import { browserPrelude, resolveConfig } from "../config.mjs"
import { chooserUrlFromEnv } from "../runtime/launcher.mjs"
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
  '<!doctype html><html><body><main id="app"><button id="cta">Go</button></main></body></html>',
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom
// The resolver hit-tests through `elementsFromPoint`, which jsdom does not
// implement, and reads zero-area rects as hidden. Both are declared here.
window.document.elementsFromPoint = () => window.__stack ?? []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
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

/** One bundle, because the store is a module singleton every lane must share. */
const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createContext } from "./src/core/context"
      export { installToolbar } from "./src/shell/toolbar"
      export { installCanvas } from "./src/canvas/index"
      export { installInspector } from "./src/panels/inspector/index"
      export { getState, setState, editorOwnsInput, editorMode } from "./src/core/store"
      export { toolbarCss, TOOLBAR_HEIGHT } from "./src/core/css/toolbar"
      export { tooltipCss } from "./src/core/css/tooltip"
      // The collapse is one motion drawn across two stylesheets, so the cases
      // that check the two halves agree have to be able to read both.
      export { launcherCss } from "./src/core/css/launcher"
      // The bar and the disc are one object with one position, and the only
      // way to assert that is to drive both of them from the same graph.
      export { createLauncher } from "./src/shell/launcher"
      // The gesture on its own, because the RESTING half of it cannot be
      // reached through the real bar: every case that drives that one drags it
      // first, and a surface with a dragged position has left the branch under
      // test for the rest of the file.
      export { installDrag } from "./src/shell/launcher"
      export { icon } from "./src/core/icons"
      export { tokens } from "./src/core/tokens"
      // Copy is a chord rather than a square now, so the only way to ask
      // whether the bar still offers it is to ask the registry the key reads.
      export { hasCommand, runCommand, registerCommand } from "./src/core/commands"
      export { recordPreviewOnly, previewOnlyChanges, clearPreviewOnly } from "./src/core/change-prompt"
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

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  node.className = "de-toolbar"
  window.document.body.append(node)
  return node
}
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
const context = editor.createContext(bridge, {
  overlay: slot(),
  toolbar: slot(),
  left: slot(),
  right: slot(),
})
editor.installToolbar(context)
editor.installCanvas(context)

const toolbar = context.slots.toolbar
const buttons = () => Array.from(toolbar.querySelectorAll("button"))
const byText = (text) => buttons().find((button) => button.textContent.trim() === text) ?? null
const byLabel = (name) => toolbar.querySelector(`[aria-label="${name}"]`)

/*
 * The glyph a control is CURRENTLY SHOWING, which is no longer the only one it
 * has mounted.
 *
 * Every toggle in the bar keeps both drawings in the DOM now and crossfades
 * between them (`core/swap-mark.ts`), because replacing an `<svg>` gives the
 * browser no previous state to animate from. `querySelector("svg")` therefore
 * always finds the resting mark, whatever state the control is in — which is
 * the same answer for both states and so no answer at all.
 *
 * Which one is shown is the `de-swap--done` class, exactly as the stylesheet
 * reads it. Controls that have not been through the swap helper still have one
 * `<svg>` and fall through to it, so the cases below keep asserting what they
 * always asserted: what the user can see.
 */
const shownGlyph = (button) => {
  const swap = button.querySelector(".de-swap")
  if (!swap) return button.querySelector("svg")
  return swap.querySelector(swap.classList.contains("de-swap--done") ? ".de-swap-done" : ".de-swap-rest")
}

/*
 * Named for what pressing DOES, so the name moves with the theme.
 *
 * It was a toggle wearing one stable name plus `aria-pressed`, which asked the
 * reader to decode a sun sitting inside a lit chip — a control reporting the
 * single most visible state on the screen. It is an action now: no pressed
 * state, and the label is the outcome.
 */
const themeToggle = () =>
  byLabel("Switch to light mode") ?? byLabel("Switch to dark mode")
/** The mode switch is the one control whose accessible name changes. */
const mode = () => toolbar.querySelector(".de-button--mode")

// ── The removed clusters ───────────────────────────────────────────────────

console.log("\nRemoved clusters")

check("the tool cluster is gone entirely — Scale, Text, Move and Hand alike", () => {
  for (const gone of ["Scale", "Text", "Move", "Hand (browser scroll)"]) {
    assert.equal(byLabel(gone), null, `${gone} is still in the bar`)
  }
  // The panel toggles are pressable too, so absence of `aria-pressed` is no
  // longer the signal. What must be gone is a pressable that picks a TOOL.
  //
  // `Annotate` is pressable and is not one. A tool changes what a canvas
  // gesture MEANS to the selection lane; annotation mode decides whether the
  // selection lane sees the gesture at all. `Inspecting` is the mode switch,
  // which makes the same distinction about the pointer — it used to be absent
  // from this list only because it was a text pill rather than a `.de-tool`,
  // and the all-icon bar made it one. Both are named here rather than filtered
  // out of the query, so that a genuine tool radio reappearing still fails
  // this, which is the whole job of the case.
  // `Light mode` is pressable and is not a tool either, for the same reason
  // `Notes` is not: a tool changes what a canvas gesture MEANS, and this one
  // changes nothing but how the chrome is inked. It is in the list rather than
  // filtered out of the query so a genuine tool radio reappearing still fails.
  // `Canvas view` is pressable and is not a tool: it changes what is on screen
  // (the page, or a board of every page), not what a click on the page means.
  const pressable = Array.from(toolbar.querySelectorAll(".de-tool[aria-pressed]"))
  assert.deepEqual(
    pressable.map((button) => button.getAttribute("aria-label")).sort(),
    ["Canvas view", "Inspect", "Notes", "Show or hide inspector", "Show or hide left panel"],
    "a tool radio survives"
  )
  // …and the bar is not simply empty, so this is not asserting nothing.
  assert.ok(byLabel("Undo"))
  assert.ok(mode())
})

/*
 * Each panel toggle draws its own SIDE, and the pair is one drawing mirrored.
 *
 * This case has been both ways round, so the reasoning is worth keeping. The
 * ruled frames were dropped once because a frame says "panel" and nothing else,
 * which left colour to carry the state. They are back because the marks that
 * replaced them — a layer stack and a slider rack — were two unrelated drawings
 * that had to be learned as a pair, and named contents that both panels have
 * since outgrown. What changed in between is that the state no longer rides on
 * colour: the filled weight inks the column, so the frame reports itself.
 *
 * The divider's x is the assertion, because it is the only thing that tells the
 * two apart: 9 is a column on the left, 15 the same column on the right.
 */
check("each panel toggle draws its own side of the screen", () => {
  /*
   * WHICH SIDE IS INKED, not which path string is stored.
   *
   * This used to look for Lucide's divider, `M9 3v18` against `M15 3v18` — the
   * only case in this file asserting stored path data, which the note over its
   * sibling explicitly warns against. It broke the moment the two glyphs were
   * redrawn on the native 16-unit lattice, where the same picture is a filled
   * rectangle and there is no `v18` line anywhere in it. The case was pinning
   * the drawing when what it means to protect is the MEANING: the left toggle
   * must ink the left of its box and the right toggle the right.
   *
   * Read off the geometry instead. Every shape in either glyph is a `rect` or a
   * `path` of horizontal and vertical runs on a 24 grid, so the x-extent of the
   * inked column is recoverable without a renderer: take the largest x any
   * shape reaches and the smallest it starts from, and ask which half of the
   * grid the ink sits in. That holds for a stroke set, a filled set, and for
   * whatever the third one is.
   */
  const inkedSide = (button) => {
    assert.ok(button, "both toggles must still be in the bar")
    /*
     * WHICH SIDE IS INKED, read off the geometry — not which path string is
     * stored.
     *
     * This case used to look for Lucide's divider, `M9 3v18` against
     * `M15 3v18`. It was the only assertion in this file pinning stored path
     * data, which the note over its sibling warns against, and it broke the
     * moment the two glyphs were redrawn on the native 16-unit lattice.
     *
     * Both glyphs are a shared outer frame plus one shape that differs — a
     * `rect` for the column in the outline weight, a filled `path` for the
     * whole side in the filled one. So: skip the frame, take the first x the
     * NEXT shape names, and ask which half of the 24 grid it falls in. That
     * survives a redraw, survives the weight swap the toggle does on press,
     * and still fails loudly if the two glyphs are ever handed to the wrong
     * buttons.
     */
    const shapes = Array.from(button.querySelectorAll("rect, path"))
    assert.ok(shapes.length >= 2, `expected a frame and a column, saw ${shapes.length} shapes`)
    const column = shapes[1]
    const x =
      column.tagName.toLowerCase() === "rect"
        ? Number(column.getAttribute("x"))
        : Number((column.getAttribute("d") ?? "").match(/-?\d*\.?\d+/)?.[0])
    assert.ok(Number.isFinite(x), "the column shape names no x at all")
    return x < 12 ? "left" : "right"
  }
  assert.equal(inkedSide(byLabel("Show or hide left panel")), "left", "the left toggle is not left")
  assert.equal(inkedSide(byLabel("Show or hide inspector")), "right", "the right toggle is not right")
})

check("the zoom cluster is gone, readout and steppers alike", () => {
  assert.doesNotMatch(toolbar.textContent, /%/)
  assert.equal(byLabel("Zoom in"), null)
  assert.equal(byLabel("Zoom out"), null)
  assert.equal(byLabel("Reset zoom to 100%"), null)
})

check("the measure affordance is gone", () => {
  assert.doesNotMatch(toolbar.textContent, /Measure/i)
  assert.doesNotMatch(toolbar.textContent, /Alt/)
  assert.equal(byLabel("Measure spacing with Option or Alt"), null)
})

check("the overflow actions menu and its Variables row are gone", () => {
  assert.equal(toolbar.querySelector(".de-actions-menu"), null)
  assert.equal(toolbar.querySelector(".de-action-row"), null)
  assert.equal(toolbar.querySelector(".de-capability-group"), null)
  assert.equal(byText("Actions"), null)
  assert.equal(byText("Variables"), null)
  assert.doesNotMatch(toolbar.textContent, /Requires a code-insertion adapter/)
})

check("no toolbar button opens a menu any more", () => {
  assert.equal(toolbar.querySelector('[aria-haspopup="dialog"]'), null)
})

// ── What survives ──────────────────────────────────────────────────────────

console.log("\nSurviving controls")

/*
 * Nine glyphs, in the order they are read.
 *
 * The order is asserted as well as the membership because it is the only thing
 * holding eight identical squares together: what a click does, then what to do
 * with what you did, then what the editor is showing you. There was a ninth —
 * the one control that reached the file, and later the indicator that replaced
 * it — and both are gone, and now a tenth: Copy, which is a chord rather than a
 * square since the modes bring the panel that holds the same button with them.
 * A button that drifts out of its cluster is not a broken button, which is
 * exactly why nothing else would catch it.
 *
 * Inside the last cluster the theme leads. The two panel toggles are one
 * drawing mirrored, so they have to be adjacent and in the order the screen is
 * in; a sun between the right panel and the way out parted the pair.
 */
check("the nine icons of the bar, in reading order", () => {
  assert.ok(mode())
  // Beside the mode switch, not with the panel toggles: it answers the same
  // question the switch answers — what does a click do — and a bar that filed
  // that answer in two places would make it findable in neither.
  assert.ok(byLabel("Notes"))
  assert.ok(byLabel("Show or hide left panel"))
  assert.ok(byLabel("Show or hide inspector"))
  // The chrome's own paint, with the two panel toggles because that cluster is
  // "what the editor is showing you" — and BEFORE Hide, which is the member
  // that takes the whole cluster off screen.
  assert.ok(themeToggle())
  // The last member of the surfaces cluster, and the only one that takes the
  // bar with it: the same disclosure question asked about the whole chrome at
  // once. It leaves a launcher behind, so it is not a way to lose the editor.
  assert.ok(byLabel("Hide editor"))
  assert.ok(byLabel("Undo"))
  assert.ok(byLabel("Redo"))
  // The commit is GONE from the bar, and so is the indicator that stood in its
  // place. The Changes tab owns finishing work — it can write and it can hand
  // over to an agent, which a square in a toolbar could never express — and the
  // inspector toggle above is the door to it, so the bar neither writes nor
  // keeps a second entrance beside the one it already has.
  assert.equal(byLabel("Apply to code"), null, "the bar can still write to disk")
  assert.equal(byLabel("Changes"), null, "the Changes indicator is back in the bar")
  // Copy left with it, and for a related reason: the toggle two glyphs away now
  // raises the list this copied, so the square was a second door to a panel
  // that is already open. The chord stays — see the copy cases further down.
  assert.equal(byLabel("Copy notes and edits"), null, "the copy square is back in the bar")
  assert.deepEqual(
    buttons().map((button) => button.getAttribute("aria-label")),
    [
      "Inspect",
      "Notes",
      "Canvas view",
      "Undo",
      "Redo",
      "Switch to light mode",
      "Show or hide left panel",
      "Show or hide inspector",
      "Hide editor",
    ],
    "the bar's contents or their order moved"
  )
})

// Nothing in the bar shows a word now, so nothing in it can be found by one.
// The mode switch was the last holdout: one wide pill among eight squares is
// not emphasis, it is the thing that stops the squares reading as clusters.
check("no control in the bar carries a visible label", () => {
  for (const button of buttons()) {
    assert.equal(button.textContent.trim(), "", `${button.getAttribute("aria-label")} shows text`)
  }
  for (const word of ["Inspect", "Interactive", "Changes", "Notes"]) {
    assert.equal(byText(word), null, `"${word}" is drawn in the bar again`)
  }
})

/*
 * The two modes are exclusive, and the bar is where that is enforced.
 *
 * Interactive mode hands every click to the app; annotation mode intercepts
 * every click. Both true at once is not a state the canvas can act on, and a
 * user who reached it would be clicking on a page where nothing happened at
 * all — with no way to tell which of the two pressed controls was lying.
 */
check("the bar offers three modes and can never be in a fourth", () => {
  const press = (name) =>
    byLabel(name).dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  const pressed = (name) => byLabel(name).getAttribute("aria-pressed")

  // Inspect is the mode the editor opens in: a click selects.
  context.setMode("inspecting")
  assert.equal(editor.editorMode(), "inspecting")
  assert.equal(pressed("Inspect"), "true", "the mode that is live must read as pressed")
  assert.equal(pressed("Notes"), "false")

  // Notes takes over from Inspect rather than joining it.
  press("Notes")
  assert.equal(editor.editorMode(), "annotating")
  assert.equal(pressed("Notes"), "true")
  assert.equal(pressed("Inspect"), "false", "two modes were live at once")

  // Leaving a mode lands in interactive — the absence of both — and NOT back
  // in the mode you came from. Leaving is not a request for something else.
  press("Notes")
  assert.equal(editor.editorMode(), "interactive")
  assert.equal(pressed("Notes"), "false")
  assert.equal(pressed("Inspect"), "false")

  // And the same rule from the other control.
  press("Inspect")
  assert.equal(editor.editorMode(), "inspecting")
  press("Inspect")
  assert.equal(editor.editorMode(), "interactive")
})

/*
 * Raising a mode raises the tab that is the rest of it.
 *
 * Each of the two working modes has exactly one tab it has anything to say to:
 * Inspect selects an element and Design is where that element's properties are
 * read and written; Notes pins a comment and Changes is the list those land in.
 * A designer who turns one on and then goes hunting for the matching tab is
 * doing the editor's filing for it.
 *
 * The panel is OPENED and not merely retabbed, on the same terms
 * `panel.inspector.tab1..3` settled: a tab switched behind a closed panel is
 * indistinguishable from a control that did nothing.
 *
 * LEAVING a mode writes neither, which is the half worth pinning. Interactive
 * is the absence of both modes rather than a third thing to look at, so
 * pressing Notes off leaves the Changes list up to read instead of snapping the
 * panel back to Design under the pointer.
 *
 * Driven through `context.setMode` as well as through the buttons, because the
 * rule lives in the context rather than in the two click handlers — that is
 * what stops ⌥ keys bound to the same modes arriving at a different panel.
 */
check("each mode brings the right panel's matching tab with it", () => {
  const press = (name) =>
    byLabel(name).dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  const tab = () => context.getState().inspectorTab

  context.setState({ inspectorOpen: false, inspectorTab: "system" })
  press("Notes")
  assert.equal(tab(), "annotations", "Notes did not raise the Changes tab")
  assert.equal(context.getState().inspectorOpen, true, "Notes switched a tab behind a shut panel")

  context.setState({ inspectorOpen: false, inspectorTab: "system" })
  press("Inspect")
  assert.equal(tab(), "design", "Inspect did not raise the Design tab")
  assert.equal(context.getState().inspectorOpen, true, "Inspect switched a tab behind a shut panel")

  // Off is not a request for a tab: the list you were just reading stays up.
  context.setMode("annotating")
  assert.equal(tab(), "annotations")
  press("Notes")
  assert.equal(editor.editorMode(), "interactive")
  assert.equal(tab(), "annotations", "leaving a mode moved the panel out from under the reader")

  context.setMode("inspecting")
  assert.equal(tab(), "design", "the keymap's path to a mode skips the panel")
})

/*
 * The two mode controls say which mode is live on the GLYPH, not only in the
 * attribute — and the third mode is the one where neither of them is filled.
 *
 * This is the case the whole bar's state signal turns on. Interactive mode is
 * the absence of Inspect and of Notes, so it has no control of its own; the
 * only thing on screen saying the editor has handed the pointer back is that
 * both marks are hollow. A pair that reported itself in stroke weight left that
 * state indistinguishable from either of the other two at a glance, because
 * half a unit is not a difference anybody reads without the other state beside
 * it.
 */
check("the live mode is the filled mark, and interactive fills neither", () => {
  const fill = (name) => shownGlyph(byLabel(name)).getAttribute("fill")
  for (const [mode, inspect, notes] of [
    ["inspecting", "currentColor", "none"],
    ["annotating", "none", "currentColor"],
    ["interactive", "none", "none"],
  ]) {
    context.setMode(mode)
    assert.equal(fill("Inspect"), inspect, `the pointer is wrong in ${mode}`)
    assert.equal(fill("Notes"), notes, `the bubble is wrong in ${mode}`)
  }
})

/*
 * The fourth state is unreachable by construction, not by discipline.
 *
 * Two booleans spell four combinations and only three are modes. The illegal
 * one — the editor has handed the pointer to the app AND is still intercepting
 * clicks to pin notes — is a page where nothing happens, with two lit controls
 * and nothing to say which is lying. `setMode` writes both flags together so no
 * call site can reach it by forgetting to clear the other one.
 */
check("setMode is the only way in, and it cannot produce the fourth state", () => {
  for (const mode of ["inspecting", "annotating", "interactive"]) {
    context.setMode(mode)
    const { interactive, annotating } = context.getState()
    assert.ok(!(interactive && annotating), `${mode} produced the impossible state`)
    assert.equal(editor.editorMode(), mode)
  }
})

// V and H picked between two tools. With one tool left there is nothing for a
// letter to pick, and a letter the bar swallows is a letter the app never gets.
check("no bare letter is claimed by the bar any more", () => {
  for (const key of ["h", "v"]) {
    const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    assert.equal(event.defaultPrevented, false, `"${key}" was swallowed`)
  }
  assert.equal(context.getState().tool, "move")
})

/*
 * The entry point is still the inspector's and still not the bar's — but what
 * it opens changed. It used to mount a floating window over the app; it now
 * writes the left panel's tab into the store, which is how every lane in this
 * editor reaches another one. The assertion follows the write rather than a
 * rendered surface, because the surface belongs to a panel this suite does not
 * mount, and asserting on the store is what proves the two are joined up at all.
 */
check("the app controls are still reached from the inspector, not the toolbar", () => {
  // Stubbed for the rest of the run, never restored: the inspector warms its
  // lint tool list on a 1s timer, and with the real `fetch` back by then the
  // relative URL throws and prints a 6 MB stack, one `data:` frame per bundle.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  editor.setState({ selection: [], leftTab: "layers", layersOpen: false })
  editor.installInspector(context)
  const launcher = Array.from(context.slots.right.querySelectorAll("button")).find(
    (button) => button.textContent.trim() === "Browse design options"
  )
  assert.ok(launcher, "inspector empty state must still offer the controls entry point")
  launcher.click()
  assert.equal(editor.getState().leftTab, "controls")
  assert.equal(editor.getState().layersOpen, true, "it named a tab in a panel it left closed")
  // And the thing it used to open is not in the document at all.
  assert.equal(window.document.querySelector(".de-opt-window"), null)
})

// ── The panel toggles ──────────────────────────────────────────────────────

console.log("\nPanel toggles")

/**
 * A stable fingerprint of what a button is DRAWING, colour excluded.
 *
 * The pressed treatment is a tint, so comparing rendered colour would pass on
 * the very thing these glyphs exist to replace. This reads the geometry.
 *
 * Narrowed to the SHOWN glyph when the subject holds a swap pair, for the
 * reason `shownGlyph` gives: a control with both drawings mounted would
 * otherwise fingerprint as the two concatenated — the same string in both
 * states, and so a comparison that can never fail. A bare `<svg>`, which is
 * what `editor.icon()` hands back, falls through untouched.
 */
const drawing = (subject) =>
  Array.from(
    (subject.querySelector?.(".de-swap") ? shownGlyph(subject) : subject).querySelectorAll(
      "rect, path, circle"
    )
  )
    .map((node) =>
      Array.from(node.attributes)
        .filter((attribute) => attribute.name !== "fill" && attribute.name !== "stroke")
        .map((attribute) => `${attribute.name}=${attribute.value}`)
        .join(",")
    )
    .join("|")

const TOGGLES = [
  ["Show or hide left panel", "layersOpen"],
  ["Show or hide inspector", "inspectorOpen"],
]

/*
 * ON FILLS THE MARK. Off hollows it.
 *
 * The case that stood here asserted the drawing never changed between the two
 * states, because the state lived in stroke weight alone — `css/icons.ts` adds
 * half a unit to anything reporting `aria-pressed`. That rule stays for rows
 * and tabs, where the neighbours are on screen to be compared against. It is
 * the wrong signal for these buttons: a designer asking "are notes armed?" or
 * "is the inspector up?" is looking at ONE square, with nothing beside it to
 * measure half a unit of stroke against.
 *
 * `fill` is read off the root rather than inferred from the mark, because that
 * is the attribute that decides it for the three glyphs whose own silhouette
 * floods. The paint and `aria-pressed` are asserted together on purpose: both
 * come from a single read of the store in `panelToggle`, and the failure worth
 * catching is the two of them disagreeing.
 */
check("each toggle fills its mark while it is on, and hollows it while it is off", () => {
  for (const [label, flag] of TOGGLES) {
    for (const on of [true, false, true]) {
      editor.setState({ [flag]: on })
      const button = byLabel(label)
      const svg = shownGlyph(button)
      assert.ok(svg, `${label} drew nothing`)
      assert.equal(button.getAttribute("aria-pressed"), String(on), `${label} @ ${on}`)
      assert.equal(
        svg.getAttribute("fill"),
        on ? "currentColor" : "none",
        `${label} is ${on ? "on but hollow" : "off but filled"}`
      )
    }
  }
})

/*
 * Filling is a WEIGHT, not a different icon.
 *
 * The subject has to survive the press: a toggle that swapped marks would be
 * two controls sharing a square, which is the thing this bar spent a rewrite
 * getting rid of. The two panel frames are the glyphs here with a second
 * drawing at all — flooding a box with a divider in it paints over the divider,
 * so the set carries an authored counterpart — and even that is the same frame
 * with the column it already draws inked solid. What is checked is that each
 * toggle draws the SET's mark for its own glyph in whichever state it is in,
 * rather than anything else that happens to be filled.
 */
check("a toggle draws the set's own mark for its glyph, in both states", () => {
  for (const [label, flag, name] of [
    ["Show or hide left panel", "layersOpen", "PanelLeft"],
    ["Show or hide inspector", "inspectorOpen", "PanelRight"],
  ]) {
    editor.setState({ [flag]: true })
    assert.equal(
      drawing(byLabel(label)),
      drawing(editor.icon(name, 16, "filled")),
      `${label} fills with the wrong mark`
    )
    editor.setState({ [flag]: false })
    assert.equal(
      drawing(byLabel(label)),
      drawing(editor.icon(name, 16, "outline")),
      `${label} hollows to the wrong mark`
    )
  }
})

check("the two toggles are told apart from each other, in both states", () => {
  for (const open of [true, false]) {
    editor.setState({ layersOpen: open, inspectorOpen: open })
    assert.notEqual(
      drawing(byLabel("Show or hide left panel")),
      drawing(byLabel("Show or hide inspector")),
      `the pair is indistinguishable while ${open ? "open" : "collapsed"}`
    )
  }
})

// The whole strip draws at one size. Two glyphs at different sizes in one bar
// read as two icon sets, and the mode switch used to draw its arrow at 14.
check("every glyph in the bar is drawn at the same size", () => {
  const sizes = new Set()
  for (const button of buttons()) {
    for (const svg of button.querySelectorAll("svg")) {
      sizes.add(`${svg.getAttribute("width")}x${svg.getAttribute("height")}`)
    }
  }
  assert.ok(sizes.size > 0, "the bar drew no glyphs at all")
  assert.deepEqual([...sizes], ["16x16"], `the bar draws at ${[...sizes].join(", ")}`)
})

/*
 * Which mark each control wears, pinned by geometry rather than by name.
 *
 * A glyph swap is the one edit to this bar that no other case here can see: the
 * button is present, named, wired and the right size, and it is drawing
 * something else. Compared against the set rather than against a stored path,
 * so re-generating the icons from Reicon does not fail this for the wrong
 * reason.
 */
check("each control wears the mark it was chosen for", () => {
  const glyph = (name) => drawing(editor.icon(name, 16))
  const worn = (label) => drawing(byLabel(label))
  /*
   * A hook each, not a circular arrow.
   *
   * `RotateCcw` and `RotateCw` stood here and have left the set entirely. They
   * were the two marks in the bar that read a size larger than everything
   * beside them — a closed ring gives the eye no gap to stop at — and a
   * 300-degree arc leaves its tail at an angle nothing else in this family can
   * meet, so the arrowhead had to be slanted and the mark came out soft at
   * every size.
   *
   * The pair is also asserted DIFFERENT from each other, because they are
   * mirror images and every other case here would pass with both buttons
   * wearing the same one.
   */
  assert.equal(worn("Undo"), glyph("ToolUndo"))
  assert.equal(worn("Redo"), glyph("ToolRedo"))
  assert.notEqual(worn("Undo"), worn("Redo"), "both history arrows point the same way")
  assert.equal(worn("Notes"), glyph("MessageSquare"))
  assert.equal(worn("Show or hide left panel"), glyph("PanelLeft"))
  assert.equal(worn("Show or hide inspector"), glyph("PanelRight"))
  /*
   * A cross, where this drew four arrows converging on a centre.
   *
   * The arrows carried the whole story of where the editor went, because
   * collapsing was a jump cut and nothing else told it. The collapse animates
   * now — the bar shrinks toward the corner the disc grows out of — so the
   * glyph was left restating the motion at 16px, and a cross says the plainer
   * thing that is left.
   *
   * `ToolClose` rather than `X`: the same picture, drawn by this family instead
   * of by Lucide. `X` stays Lucide's because seven other surfaces draw it, most
   * of them at 12px, which the native lattice may not land on.
   */
  assert.equal(worn("Hide editor"), glyph("ToolClose"))
  assert.notEqual(worn("Hide editor"), glyph("Minimize"), "the converging arrows are back")
  /*
   * The glyph shows what pressing OFFERS, not the state you are standing in:
   * in the dark it holds out a sun, in the light a moon. That is the convention
   * every OS switch uses and the one that survives a bar with no labels on it.
   *
   * It was a plain `Square` while this set had neither mark in it — a chip that
   * filled and hollowed carried the state without ever saying what the state
   * was about. The set has both now, so the chip is gone.
   *
   * One drawing, not two. The glyph shipped in two weights when the set was a
   * fill family; Lucide strokes, so a pressed control thickens its mark instead
   * and the element holds a single set of shapes. What is checked here is that
   * the mark carries the stroke that rule needs, since a glyph rendered without
   * one is invisible rather than merely unstyled.
   */
  assert.equal(worn("Switch to light mode"), glyph("Sun"), "dark chrome must offer the sun")
  assert.equal(themeToggle().querySelectorAll("svg > g").length, 0, "the glyph is still split into weight groups")
  assert.ok(Number(themeToggle().querySelector("svg").getAttribute("stroke-width")) > 0)
  /*
   * Each panel frame belongs to one button and to nothing else in this bar.
   *
   * A mark was worn twice here once — the layer stack, by the layers toggle and
   * by the Changes indicator that succeeded the commit's tick — and two squares
   * with one drawing in an eight-glyph strip is the failure this whole case
   * exists to catch. The pair is the live risk now, because they ARE the same
   * drawing apart from which column is inked: get the mirror wrong and the bar
   * has two left panels and nothing else says so.
   */
  for (const name of ["PanelLeft", "PanelRight"]) {
    assert.equal(
      buttons().filter((button) => drawing(button) === glyph(name)).length,
      1,
      `two controls in the bar wear ${name}`
    )
  }
})

// The shell writes these flags too, so the button cannot infer its state from
// its own last click. It reads the store on every paint.
check("aria-pressed follows the store, not the click", () => {
  for (const [label, flag] of TOGGLES) {
    for (const open of [true, false, true]) {
      editor.setState({ [flag]: open })
      assert.equal(byLabel(label).getAttribute("aria-pressed"), String(open), `${label} @ ${open}`)
    }
  }
})

check("clicking a toggle moves its own flag and only its own", () => {
  editor.setState({ layersOpen: true, inspectorOpen: true })
  byLabel("Show or hide left panel").click()
  assert.equal(context.getState().layersOpen, false)
  assert.equal(context.getState().inspectorOpen, true, "the inspector moved with the layers panel")
  byLabel("Show or hide inspector").click()
  assert.equal(context.getState().inspectorOpen, false)
  assert.equal(context.getState().layersOpen, false)
  byLabel("Show or hide left panel").click()
  assert.equal(context.getState().layersOpen, true)
  editor.setState({ layersOpen: true, inspectorOpen: true })
})

// ── Light and dark ─────────────────────────────────────────────────────────

console.log("\nThe theme toggle")

const THEME_KEY = "designlayer:theme"
const documentTheme = () => window.document.documentElement.getAttribute("data-de-theme")

/*
 * First, and before anything in this section writes to storage: the editor
 * opens on the appearance it has always had.
 *
 * The bar at the top of this file was installed with nothing saved, which is
 * every user's first run. `prefers-color-scheme` is deliberately not consulted
 * — the chrome is a frame around someone else's product and the OS preference
 * is a fact about the desktop, not about the thing under review — so a first
 * run is dark whatever the machine says.
 */
check("it opens dark, and the document says so before anything is pressed", () => {
  assert.ok(themeToggle(), "the bar has no way to change its own theme")
  assert.equal(documentTheme(), "dark")
  assert.equal(themeToggle().getAttribute("aria-pressed"), null, "an action must not claim a state")
  assert.equal(window.localStorage.getItem(THEME_KEY), null, "boot wrote a preference nobody set")
  assert.equal(themeToggle().getAttribute("aria-label"), "Switch to light mode")
  assert.equal(themeToggle().getAttribute("data-de-tip"), "Switch to light mode")
})

/*
 * The attribute is written in two places and it has to be both.
 *
 * `css/base.ts` declares the palette on `:root`, because the editor mounts four
 * separate roots on `<body>` — the editor root, the options window, the token
 * popover and the design-system probe — and `<html>` is the only ancestor they
 * share. A theme flipped on the editor root alone leaves every popover on the
 * dark palette over a light page, which is where the inline `var()` styles in
 * `inspector/color.ts` are read.
 */
check("pressing it flips the theme on the document and on the editor root", () => {
  const root = window.document.createElement("div")
  root.className = "de-root"
  window.document.body.append(root)

  themeToggle().click()
  assert.equal(documentTheme(), "light")
  assert.equal(root.getAttribute("data-de-theme"), "light", "the editor root stayed dark")
  assert.equal(themeToggle().getAttribute("aria-pressed"), null, "an action must not claim a state")
  assert.equal(themeToggle().getAttribute("aria-label"), "Switch to dark mode", "the name must offer the way back")

  themeToggle().click()
  assert.equal(documentTheme(), "dark")
  assert.equal(root.getAttribute("data-de-theme"), "dark")
  assert.equal(themeToggle().getAttribute("aria-label"), "Switch to light mode")
  root.remove()
})

/*
 * A theme is a preference, unlike the bar's drag position, so it is written
 * down — and read back on the next boot.
 *
 * Asserted on a whole second module graph rather than by calling the reader,
 * because what has to survive is a RELOAD: `installToolbar` running fresh
 * against a `localStorage` somebody else's session left behind.
 */
check("the choice is written down", () => {
  themeToggle().click()
  assert.equal(window.localStorage.getItem(THEME_KEY), "light")
  themeToggle().click()
  assert.equal(window.localStorage.getItem(THEME_KEY), "dark")
})

window.localStorage.setItem(THEME_KEY, "light")
const restored = await toolbarWith(null, "theme-restored")

check("a bar booted after a light session comes back light", () => {
  const button = restored.bar.querySelector('[aria-label="Switch to dark mode"]')
  // Found by the name it wears in the LIGHT theme, which is itself the
  // assertion: a restored light session offers the way back to dark.
  assert.ok(button, "the restored bar came back dark, or has no theme control")
  assert.equal(documentTheme(), "light", "the restored preference never reached the document")
})

/*
 * Storage that throws must not cost the editor.
 *
 * `localStorage` does not return null for a blocked origin — Safari with
 * tracking prevention on, or any browser with site data switched off — it
 * throws on property access, and this overlay is served from a proxy on a
 * different port from the app, which is exactly the shape that gets blocked.
 * The read happens during `installToolbar`, before the bar is appended, so an
 * unguarded one does not lose a theme, it loses the whole toolbar.
 *
 * The write is guarded too, and the second half of this case is the one that
 * catches only that: the toggle still has to WORK, it just will not be
 * remembered.
 */
const realStorage = Object.getOwnPropertyDescriptor(window, "localStorage")
Object.defineProperty(window, "localStorage", {
  configurable: true,
  get() {
    throw new window.DOMException("The operation is insecure.", "SecurityError")
  },
})
const blocked = await toolbarWith(null, "theme-blocked-storage")
if (realStorage) Object.defineProperty(window, "localStorage", realStorage)

check("a browser that blocks storage still gets a whole bar, and a working toggle", () => {
  assert.equal(
    blocked.bar.querySelectorAll("button").length,
    9,
    "the bar did not survive a localStorage that throws"
  )
  const button = blocked.bar.querySelector('[aria-label="Switch to light mode"]')
  // Unreadable storage is not a preference, so it falls back to the default.
  assert.ok(button, "a blocked read took the theme control with it")
  assert.equal(documentTheme(), "dark")

  // And the write is guarded separately from the read: pressing it has to
  // change the chrome even though nothing can be saved.
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new window.DOMException("The operation is insecure.", "SecurityError")
    },
  })
  try {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    assert.equal(documentTheme(), "light", "a blocked write took the toggle down with it")
    assert.equal(
      button.getAttribute("aria-label"),
      "Switch to dark mode",
      "the control did not re-label itself for the theme it landed in"
    )
  } finally {
    if (realStorage) Object.defineProperty(window, "localStorage", realStorage)
  }
})

// Back to the appearance the rest of this file was written against, and with
// nothing left in storage for the lanes below to boot into.
window.localStorage.removeItem(THEME_KEY)
themeToggle().click()
if (documentTheme() !== "dark") themeToggle().click()
window.localStorage.removeItem(THEME_KEY)

// ── The pill it is drawn as ────────────────────────────────────────────────

console.log("\nThe floating pill")

/** The declarations of one rule, by selector, from the stylesheet as shipped. */
const block = (selector) =>
  editor.toolbarCss.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`, "s"))?.[0] ?? ""

/*
 * The bar used to be a 36px box with a 34px row centred in it, so the padding
 * was a leftover rather than a decision and a taller button would have been
 * absorbed by a number declared in another file. It is a pill wrapped around its
 * row now and the height is a consequence of the two numbers that make it. The
 * absence of a `height` is asserted because an absence is exactly what a later
 * edit restores without noticing.
 */
check("the bar takes its height from its contents, not from a fixed number", () => {
  const bar = block("\\.de-toolbar")
  assert.ok(bar, "the container rule must exist")
  assert.doesNotMatch(bar, /(^|[^-])height:/)
  /*
   * 3, and the 3 is the point.
   *
   * This read `padding: 4px` for as long as the pill has existed, and the bar
   * was a pixel out of true the whole time. `border-radius` is measured on the
   * OUTER edge, so the 1px border sits between the pill's curve and the
   * squares' and counts toward the offset exactly as padding does: the real gap
   * was 5, and 16 − 5 is 11, not the 12 the squares were drawing.
   *
   * So the number that belongs on the spacing scale is the GAP, and the padding
   * is whatever leaves that gap once the border has taken its pixel. `nest()`
   * in tokens.ts does the subtraction, which is why this asserts a value the
   * spacing scale does not contain — it is not a spacing decision any more, it
   * is the remainder of one. The border is asserted beside it because the two
   * only add up to `space["2xs"]` together.
   */
  assert.match(bar, /padding: 3px;/)
  assert.match(bar, /border: 1px solid/)
  // A pill hanging over live product pixels needs a wider cast than the panels
  // that are already docked against an edge.
  assert.match(bar, /box-shadow: 0 18px 56px/)
  assert.doesNotMatch(bar, /0 2px 14px/, "the docked panel's shadow is back on the pill")
  // Concentric: the outer curve, the inner curve, and the gap between them.
  assert.match(bar, new RegExp(`border-radius: ${editor.tokens.radius["3xl"]};`))
  const square = block("\\.de-toolbar \\.de-tool")
  assert.match(square, new RegExp(`border-radius: ${editor.tokens.radius.lg};`))
  assert.match(square, /width: 32px; height: 32px;/)
  // `.de-tool` also dresses the inspector's `iconButton`, inside a 240px panel
  // where the smaller square is already as much as a row can hold. The bar's is
  // an override, so growing it must not have grown theirs.
  assert.match(
    block("\\.de-tool"),
    new RegExp(`width: ${editor.tokens.size.toolSize}px;`),
    "the bar's square leaked into the panels"
  )
})

/*
 * Nothing parts the clusters, because the bar stopped having any.
 *
 * Two treatments were spent here and both were withdrawn. A hairline, on the
 * written condition that a break marked a change in stakes — screen on one
 * side, disk on the other — which stopped being true when the last control that
 * wrote to a file left the bar. Then air alone, which parts squares from
 * squares but cannot say which break means more than the others.
 *
 * So the stylesheet carries neither: no `::before` rule, and no `+` rule
 * waiting to space a second group that does not exist. Either one reappearing
 * is a claim somebody has to make out loud — that this bar got long enough to
 * need sorting, or that some break in it started meaning more than the rest.
 */
check("nothing is left in the stylesheet to part one cluster from another", () => {
  assert.equal(
    block("\\.de-toolbar-group \\+ \\.de-toolbar-group"),
    "",
    "the between-groups rule outlived the groups"
  )
  const hairlines = editor.toolbarCss.match(/\.de-toolbar-group[^{]*::before\s*\{/g) ?? []
  assert.equal(hairlines.length, 0, `expected no hairline, saw ${hairlines.length}`)
  // The group itself still has to lay its own run out; one group is still a
  // flex row with a gap, and deleting the wrong rule would leave the bar's
  // eight squares stacked.
  const group = block("\\.de-toolbar-group")
  assert.match(group, /display: flex/)
  assert.match(group, /gap:/)
})

/*
 * The on state was an 18% wash borrowed from the canvas, where a tint has to
 * let the page show THROUGH it. Nothing shows through a 32px button, so the
 * wash was paying for a transparency nobody needed and reading, at a glance, as
 * a hover that had got stuck.
 */
check("an on mode wears the accent as a fill, not as a wash", () => {
  const on = block('\\.de-toolbar \\.de-tool\\[aria-pressed="true"\\]')
  assert.ok(on, "the pressed tool rule must exist")
  // `includes`, not a RegExp built from the token: every colour token is a
  // `var(--de-…)` reference now, and its parentheses are a capture group in a
  // pattern — so a regex assembled from one silently matches nothing.
  assert.ok(on.includes(`background: ${editor.tokens.color.accentSurface};`), on)
  // The fill is a token so the theme can move it, not the canvas's 18% wash —
  // which is a transparency nothing shows through at 32px.
  assert.doesNotMatch(on, /color-mix\(in srgb, #/)
  // The dark theme's accent is a light indigo, so the ink flips with the fill
  // or vanishes; the light theme's flips the other way. One token, both cases.
  assert.ok(on.includes(`color: ${editor.tokens.color.onAccent};`), on)
})

/*
 * The two panel toggles report ON in the MARK, and take no chip.
 *
 * The chip earns its ink on a mode, where the claim is about what the next
 * click will do and there is nothing on screen to check it against. A panel
 * toggle has the panel: press it and a quarter of the screen appears, so the
 * accent is the third report of one fact — and two accent squares in an
 * eight-glyph row stop the eye sorting "what a click does" from "what is on
 * screen". The filled column in the glyph carries it alone.
 *
 * The rule has to come AFTER the blanket pressed rule, because both are one
 * class plus one attribute under `.de-toolbar` and nothing but order parts
 * them. Hover is asserted too: a pressed control that stops answering the
 * pointer reads as disabled rather than as quiet.
 *
 * And the INK does not move with the state. Pressed used to sit at full `text`
 * while rest sat at `textMuted`, which is the same step every other square in
 * the row spends on HOVER — so an open panel left its toggle looking hovered
 * for the whole session. The mark is solid or hollow; colour is reserved for
 * the pointer, here as everywhere else in the bar.
 */
check("a pressed panel toggle takes no chip, and still answers the pointer", () => {
  const quiet = block('\\.de-toolbar \\.de-tool--quiet\\[aria-pressed="true"\\]')
  assert.ok(quiet, "the quiet override must exist")
  assert.ok(quiet.includes("background: transparent;"), quiet)
  // Full ink, pressed or not: an icon-only control wears the body ink in every
  // state (MICRO-INTERACTIONS § 5). Stated as a pair, because the failure is a
  // DIFFERENCE rather than a value: the rest rule is the one that would drift.
  assert.ok(
    quiet.includes(`color: ${editor.tokens.color.text};`),
    `a pressed panel toggle must keep the resting ink: ${quiet}`
  )
  const rest = block("\\.de-tool")
  assert.ok(
    rest.includes(`color: ${editor.tokens.color.text};`),
    `the resting ink is what the pressed toggle keeps: ${rest}`
  )
  assert.ok(
    editor.toolbarCss.indexOf('.de-toolbar .de-tool--quiet[aria-pressed="true"]') >
      editor.toolbarCss.indexOf('.de-toolbar .de-tool[aria-pressed="true"]'),
    "the accent chip is declared after the rule that drops it, so it wins"
  )
  const hover = block('\\.de-toolbar \\.de-tool--quiet\\[aria-pressed="true"\\]:hover')
  assert.ok(hover.includes(`background: ${editor.tokens.color.bgHoverQuiet};`), hover)
  // The ink too. The accent hover rule it overrides sets `onAccent`, and a
  // plate-only override keeps that white on the neutral plate — invisible on
  // paper, and indistinguishable from `text` in dark, which is how it shipped.
  assert.ok(
    hover.includes(`color: ${editor.tokens.color.text};`),
    `the pressed toggle's hover must restate its ink, or it keeps the accent hover's white: ${hover}`
  )
  // And it is the panel toggles wearing it, not the modes: a quiet mode would
  // be a claim about the next click with nothing on screen reporting it.
  const quietLabels = Array.from(toolbar.querySelectorAll(".de-tool--quiet")).map((button) =>
    button.getAttribute("aria-label")
  )
  // Canvas view wears it for the panels' reason: pressing it swaps the page for
  // a board of frames, which is its own report.
  assert.deepEqual(quietLabels.sort(), ["Canvas view", "Show or hide inspector", "Show or hide left panel"])
})

// ── Standing down, as one object ───────────────────────────────────────────

console.log("\nThe collapse")

/** The hidden-state rules, which live in two stylesheets and must agree. */
const barExit =
  editor.toolbarCss.match(/html\.designlayer-chrome-hidden \.de-toolbar \{[^}]*\}/s)?.[0] ?? ""
const discArrive =
  editor.launcherCss.match(/html\.designlayer-chrome-hidden \.de-launcher \{[\s\S]*?\n\}/)?.[0] ?? ""
/*
 * The bar's resting half of the same motion, and a SECOND `.de-toolbar` block
 * rather than four more lines in the geometry rule above it.
 *
 * Read separately because it is the collapse running backwards, and coming back
 * has to be the same object arriving rather than a second animation that
 * happens to end in the same place. Everything the cases below ask of the exit
 * is asked of this too.
 */
/** The resting half of the collapse — the rule that owns the way BACK in. */
const barReturn =
  editor.toolbarCss.match(/\n\.de-toolbar \{\n  transition:[^}]*\}/)?.[0] ?? ""

/**
 * One leg of a transition list — `<property> <duration> <curve> [<delay>]`.
 *
 * A function rather than a `match()` destructured where it is used, because the
 * failure this section exists to catch is a property quietly LEAVING the list,
 * and `null[1]` reports that as a TypeError naming neither the property nor the
 * rule it went missing from. This fails on the absence itself and says which.
 */
const leg = (rule, property, where) => {
  const found = rule.match(
    new RegExp(`[\\s,]${property} (\\d+)ms (cubic-bezier\\([^)]*\\)|linear)(?: (\\d+)ms)?`)
  )
  assert.ok(found, `${where} does not transition ${property} at all`)
  return { duration: Number(found[1]), curve: found[2], delay: Number(found[3] ?? 0) }
}

/*
 * Collapsing has been a jump cut, a crossfade with a hint in it, and a morph.
 *
 * The morph was the elaborate one: the pill contracted to the disc's box,
 * rounded off and carried itself across the screen to wherever the disc was
 * parked, so the continuity was not manufactured out of matched curves — it was
 * the same pixels the whole way. It read well, and it cost too much. For the
 * pill to have somewhere to land, the two surfaces had to SHARE one position,
 * which meant neither could be parked on its own: drag the disc into a corner
 * and the bar came back in that corner too.
 *
 * So it is a fade again, and this time without the apology. The 6% shrink that
 * used to say "it went that way" is gone along with the travel it stood in for
 * — the bar does not go anywhere, the panels leave by their own edges, and the
 * disc shows up in its corner. Three motions at once, not pretending to be one.
 *
 * What survives every one of those versions is the rule about WHICH property
 * may do it. The pill is centred with `translateX(-50%)`, so `transform` is
 * spoken for: animating it would animate the centring offset and slide the bar
 * sideways as the canvas widens under it. Opacity is the only thing that moves.
 */
check("the bar fades out where it stands, and takes nothing with it", () => {
  assert.ok(barExit, "no rule stands the bar down at all")
  assert.match(barExit, /opacity: 0;/)
  assert.match(barExit, /visibility: hidden;/)
  // Inert from the first frame, not the last: `visibility` can only flip at the
  // END of the fade or the transition plays to nobody, so for that long there
  // is a fading pill over the app that would otherwise still hit-test.
  assert.match(barExit, /pointer-events: none;/)
  /*
   * Nothing about the BOX may move. Each of these was in this rule at some
   * point, and each came out for the same reason: the bar has no journey to
   * describe, and a surface that changes shape on its way out is a surface the
   * eye follows instead of ignoring.
   */
  for (const property of ["width", "height", "border-radius", "translate", "scale"]) {
    assert.doesNotMatch(
      barExit,
      new RegExp(`(^|[;\\s])${property}:`),
      `the collapse is moving the bar's ${property} again`
    )
  }
  assert.doesNotMatch(barExit, /transform/, "the centring transform is being animated")
  assert.doesNotMatch(barExit, /translateY/, "the bar drops through the bottom edge again")

  const base = block("\\.de-toolbar")
  assert.match(base, /transform: translateX\(-50%\);/)
  // And the base rule keeps no leftovers of the morph either: no measured width
  // to animate from, and no `transform-origin` to shrink toward.
  assert.doesNotMatch(base, /transform-origin/, "the bar still aims a shrink at a corner")
  assert.doesNotMatch(base, /--de-toolbar-width/, "the morph's measured width outlived it")
})

/*
 * The disc shows up. It does not grow out of anything.
 *
 * Nothing in the physical world appears from nothing, so a scale that starts
 * near zero reads as a thing being CREATED rather than as a thing arriving —
 * the wrong claim, because the editor did not come into existence, it stepped
 * aside. 0.9 is small enough to read as a settle rather than a pop, and it is
 * the one piece of the old crossfade worth keeping.
 *
 * The quarter turn that used to ride with it is not: one half of a pair
 * spinning while the other does not is two motions however well timed, and the
 * bar does not spin.
 */
check("the disc shows up in its corner, and not from nothing", () => {
  assert.ok(discArrive, "no rule brings the disc in")
  assert.match(discArrive, /transform: scale\(1\);/)
  assert.match(editor.launcherCss, /transform: scale\(0\.9\);/, "the disc's resting scale moved")
  assert.doesNotMatch(editor.launcherCss, /scale\(0\)/)
  assert.doesNotMatch(editor.launcherCss, /scale\(0\.5\)/)
  assert.doesNotMatch(editor.launcherCss, /rotate\(/)
  /*
   * The corner is the stylesheet's, not something the collapse computes: the
   * disc rests 32px off the bottom-right, and only a drag moves it.
   *
   * 32 rather than Agentation's 20, which this matched until the disc was
   * looked at over a real app: a small circle 20px off two edges reads as
   * crowding the corner, and that corner is where scrollbars and the host's own
   * affordances live. The same 32 is the margin a DRAGGED disc clamps to, so a
   * dragged one can land exactly where an undragged one sits.
   */
  const rest = editor.launcherCss.match(/\.de-launcher \{[^}]*\}/s)?.[0] ?? ""
  assert.match(rest, /position: fixed;/)
  assert.match(rest, /right: 32px;/)
  assert.match(rest, /bottom: 32px;/)
  /*
   * The press still answers, and it is the only `transform` on this element
   * that is not the arrival.
   *
   * The SHAPE is pinned, not the number. This asserted `scale(0.95)` exactly and
   * broke the day someone tuned the press to 0.96 — a legitimate change to a
   * visual-design value, reported as a test failure, which is how a case earns
   * itself a `--force` and then a deletion. What matters here is that a press
   * answers at all, that it answers by shrinking rather than growing, and that
   * it stays subtle; the exact hundredth is the designer's to move.
   */
  const launcherPress = editor.launcherCss.match(/\.de-launcher:active \{\s*transform: scale\(([\d.]+)\);/)
  assert.ok(launcherPress, "the launcher no longer answers a press")
  const launcherScale = Number(launcherPress[1])
  assert.ok(
    launcherScale > 0.9 && launcherScale < 1,
    `a press should shrink the disc and stay subtle, got scale(${launcherScale})`
  )
})

/*
 * The disc is exactly as tall as the bar, and that is the point of its size.
 *
 * It was 44 — Agentation's figure, copied along with the behaviour — against a
 * bar built from the inside out to 40. Two sizes four pixels apart are not a
 * contrast, they are a mistake you only see when the editor collapses while you
 * happen to be looking at the corner. Sized off `TOOLBAR_HEIGHT`, the two
 * states of the chrome are one object: collapse it and the only thing that
 * changed is the width.
 *
 * Asserted against the exported constant rather than against 40, so moving
 * `TOOL` or the pill's padding carries here instead of failing here. What the
 * case actually defends is the AGREEMENT — the moment the disc goes back to a
 * literal, this is the thing that notices.
 */
check("the collapsed disc is the same height as the bar it replaces", () => {
  const rest = editor.launcherCss.match(/\.de-launcher \{[^}]*\}/s)?.[0] ?? ""
  const box = rest.match(/width: (\d+)px; height: (\d+)px;/)
  assert.ok(box, "the disc no longer declares a box")
  assert.equal(Number(box[1]), editor.TOOLBAR_HEIGHT, "the disc is not as wide as the bar is tall")
  assert.equal(Number(box[2]), editor.TOOLBAR_HEIGHT, "the disc is not as tall as the bar")
  /*
   * And the bar really is that tall. It declares no `height` — the sum of its
   * border, padding and one square IS the height — so the constant is checked
   * against the rules that produce it rather than taken on trust. A constant
   * that drifted from the stylesheet would otherwise let both sides of the
   * assertion above move together and stay green.
   */
  const pill = editor.toolbarCss.match(/^\.de-toolbar \{[^}]*\}/ms)?.[0] ?? ""
  assert.doesNotMatch(pill, /\n\s*height:/, "the bar declares a height, so the sum is no longer its height")
  const padding = Number(pill.match(/padding: (\d+)px/)?.[1])
  const border = Number(pill.match(/border: (\d+)px/)?.[1])
  // The BAR's square, not the generic `.de-tool` the panels also wear — that
  // one is `size.toolSize` and is a different, smaller box.
  const square = Number(editor.toolbarCss.match(/\.de-toolbar \.de-tool \{\s*width: (\d+)px; height: \1px;/)?.[1])
  assert.ok(padding && border && square, `could not read the bar's geometry back (${padding}/${border}/${square})`)
  assert.equal(
    2 * border + 2 * padding + square,
    editor.TOOLBAR_HEIGHT,
    "TOOLBAR_HEIGHT no longer matches the rules the bar is actually drawn with"
  )
})

/*
 * The pair's contract, and the only case that can see both halves at once.
 *
 * One curve for everything LEAVING, because three surfaces exiting on three
 * curves is three events rather than one editor standing down. The bar shorter
 * than the disc, because the system answering should be quicker than the person
 * deciding. And overlapping, because two things at full opacity in two
 * different places is the one arrangement that reads as a swap, while waiting
 * for the bar to finish before starting the disc reads as a slideshow.
 *
 * The one exemption is the disc's SCALE, which takes `easeSpring`. The "one
 * curve" argument is about surfaces leaving, and the disc is the only thing
 * arriving — a 44px object landing in an empty corner, which is verbatim the
 * call site `tokens.ts` documents that token for. Its fade stays on `ease`,
 * because an overshooting curve on a value that clamps at 1 buys a flat hold
 * and no bounce, and its exit stays on `ease`, because a disc that sprang on
 * the way out would be bouncing as it stopped existing. See the note on the
 * rule in `css/launcher.ts`.
 */
check("the two halves share a curve, and the bar leaves faster than the disc arrives", () => {
  const ease = editor.tokens.ease
  const spring = editor.tokens.easeSpring
  assert.ok(barExit.includes(ease), `the bar's exit is not on ${ease}`)
  assert.ok(discArrive.includes(ease), `the disc's arrival is not on ${ease}`)
  assert.ok(!barExit.includes(spring), "the bar springs on the way out")
  assert.equal(
    leg(discArrive, "opacity", "the disc's arrival").curve,
    ease,
    "the disc's fade is not on the shared curve"
  )
  assert.equal(
    leg(discArrive, "transform", "the disc's arrival").curve,
    spring,
    "the disc's scale no longer springs — nothing in the chrome takes easeSpring"
  )

  const exit = leg(barExit, "opacity", "the bar's exit")
  const enter = leg(discArrive, "opacity", "the disc's arrival")
  assert.equal(exit.delay, 0, "the bar waits before it starts leaving")
  assert.ok(
    exit.duration < enter.duration,
    "the bar takes longer to leave than the disc takes to arrive"
  )
  assert.ok(enter.delay > 0, "the disc arrives on top of the bar rather than behind it")
  assert.ok(
    enter.delay < exit.duration,
    `the disc waits ${enter.delay}ms for a ${exit.duration}ms exit — no overlap`
  )
  // Both inside the band where a fade is motion rather than a flicker, and
  // below the 300ms where UI starts to feel like it is waiting for you.
  for (const [name, value] of [["exit", exit.duration], ["entrance", enter.duration]]) {
    assert.ok(value >= 70 && value <= 250, `the ${name} is ${value}ms, outside 70-250`)
  }
  // The disc's scale rides with its fade rather than on a clock of its own: a
  // surface that finishes growing before it finishes appearing is two things.
  const grow = leg(discArrive, "transform", "the disc's arrival")
  assert.equal(grow.duration, enter.duration, "the disc's scale runs on its own clock")
  assert.equal(grow.delay, enter.delay, "the disc's scale starts on its own schedule")

  /*
   * Coming back is not the exit played backwards, and the asymmetry is the
   * point: the bar waits for nothing. The disc is already leaving on its own,
   * and a bar that waited would read as having been fetched from somewhere
   * rather than as having been there the whole time.
   */
  assert.ok(barReturn, "no rule brings the bar back")
  const back = leg(barReturn, "opacity", "the bar's return")
  assert.equal(back.delay, 0, "the bar waits before coming back")
  assert.equal(back.duration, exit.duration, "the bar returns on a different clock than it left on")
})

/*
 * Fewer and gentler, not none — and the one line `base.ts` cannot write.
 *
 * That file clamps every duration in the chrome and forces `transform: none` on
 * both surfaces, which is the whole of the reduced-motion story for everything
 * else here. What it cannot reach is a standalone `scale` or `translate`,
 * because neither of those IS `transform`.
 *
 * Nothing in the collapse uses either of them today — the bar fades and holds
 * still. Both have been in it twice, though: a 6% shrink in one version, the
 * whole trip to the disc in the next. Clamped to no duration, neither animates
 * gently, they JUMP. A reduced-motion hole that reopens silently is worse than
 * a line that costs nothing to keep, so they are neutralised by name, and this
 * case is what stops the next person deleting the line as dead.
 */
check("reduced motion has no standalone property left to animate", () => {
  const reduced =
    editor.launcherCss.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? ""
  assert.ok(reduced, "nothing withholds the bar's motion under reduced motion")
  assert.match(reduced, /\.de-toolbar \{ scale: none !important; translate: none !important; \}/)
  // And the block stays the narrow thing it is. The morph's own overrides —
  // handing the box its resting width and radius back, standing the blurred row
  // and the mark back up — went out with the morph, and a rule that undoes
  // something nothing does any more is a rule nobody can safely change.
  assert.doesNotMatch(reduced, /width:/, "a retired morph override is still being undone")
  assert.doesNotMatch(reduced, /de-toolbar-mark/, "the mark outlived the morph it was drawn for")
})

check("only opacity and transform are animated, and never `all`", () => {
  for (const [name, sheet] of [["toolbar", editor.toolbarCss], ["launcher", editor.launcherCss]]) {
    assert.doesNotMatch(sheet, /transition:\s*all/, `${name} transitions everything`)
    /*
     * Layout and paint properties in a transition list are the ones that cost a
     * frame; `background` and `color` are paint-only and cheap at this size.
     *
     * This ban was briefly relaxed for one rule, because a morph from a 600px
     * pill to a 44px disc has no transform-only spelling — a non-uniform `scale`
     * squashes the radius into an ellipse and the shadow with it, and a
     * `clip-path` wipe throws the cast away. The morph is gone and the exemption
     * went with it, so the rule is absolute again, across both sheets.
     */
    for (const property of ["width", "height", "top", "left", "bottom", "margin", "padding"]) {
      assert.doesNotMatch(
        sheet,
        new RegExp(`transition:[^;]*[\\s,]${property} `, "s"),
        `${name} animates ${property}`
      )
    }
  }
})


/*
 * Nothing is published, and this case is here to keep it that way.
 *
 * The morph needed three numbers CSS could not work out for itself — the pill's
 * measured width, and the two halves of the trip to the disc — so the bar's
 * lane wrote `--de-toolbar-width`, `--de-collapse-dx` and `--de-collapse-dy`
 * onto `<html>`, and re-published all three on every change that could move
 * either surface. `--de-collapse-origin-x` was older still: the corner the 6%
 * shrink aimed at, back when the collapse was a crossfade with a hint in it.
 *
 * All four are retired. Asserting their ABSENCE, rather than just deleting the
 * cases that used to read them, is worth a case of its own because they were
 * written onto a shared node. A publisher left behind after its reader has gone
 * is invisible — nothing looks wrong — and it goes on forcing a style
 * recalculation of the whole app every time a panel opens.
 */
check("the collapse publishes nothing onto the document", () => {
  const root = window.document.documentElement
  const retired = [
    "--de-toolbar-width",
    "--de-collapse-dx",
    "--de-collapse-dy",
    "--de-collapse-origin-x",
  ]
  const resting = editor.getState().inspectorOpen
  try {
    // Both flags, both ways. These were published from exactly this path — the
    // bar's own store subscriber — so anything still writing them writes here.
    for (const hidden of [true, false]) {
      editor.setState({ chromeHidden: hidden })
      editor.setState({ inspectorOpen: !editor.getState().inspectorOpen })
      for (const name of retired) {
        assert.equal(root.style.getPropertyValue(name), "", `${name} is still being published`)
      }
    }
  } finally {
    editor.setState({ chromeHidden: false, inspectorOpen: resting })
  }
  // And no rule is left reading one, which is the other half of the same leak.
  for (const name of retired) {
    assert.ok(
      !editor.toolbarCss.includes(name) && !editor.launcherCss.includes(name),
      `a rule still reads ${name}`
    )
  }
})

/*
 * A press has to be answered by the control, not by the state arriving.
 *
 * Nine glyphs in a row answer hover with a tint, and a pressed toggle wears a
 * tint too — so on the toggles the only feedback for the press itself was the
 * state landing a frame or two later, which is indistinguishable from a click
 * that missed.
 */
check("everything pressable in the bar answers the press", () => {
  /*
   * The shape, not the number — see the launcher's press for the argument. This
   * pinned `scale(0.94)` exactly and broke on a deliberate tune to 0.96.
   *
   * `:not([disabled])` is the part that is genuinely load-bearing and stays
   * asserted verbatim: a control that cannot act must not answer as though it
   * did, and that is a correctness claim rather than a taste one.
   */
  // On every square now, not the bar's alone, and never on a menu trigger.
  const toolPress = editor.toolbarCss.match(
    /\.de-tool:active:not\(\[disabled\]\):not\(\[aria-haspopup\]\) \{ transform: scale\(([\d.]+)\); \}/
  )
  assert.ok(toolPress, "a tool in the bar no longer answers a press, or stopped excluding disabled ones")
  const toolScale = Number(toolPress[1])
  assert.ok(
    toolScale > 0.9 && toolScale < 1,
    `a press should shrink the square and stay subtle, got scale(${toolScale})`
  )
  /*
   * The square is the only shape the press is written for, so "everything
   * pressable" holds only for as long as every control here is one. There used
   * to be a second rule at 2% travel for the text pill — the same 2px across
   * something three times as wide reads as a wobble rather than as a press —
   * and it went out with the chooser anchor, the one control in this bar that
   * ever wore `.de-button`. Nothing replaced it, so a word put back in this
   * strip would arrive with no answer to a press at all; that is what the walk
   * below catches, rather than a rule quietly gone missing.
   */
  for (const button of buttons()) {
    assert.ok(button.classList.contains("de-tool"), `pressable but not a square: ${button.outerHTML}`)
  }
  assert.equal(toolbar.querySelector(".de-button"), null, "a text pill is back and no rule answers its press")
  // A control that cannot act must not answer as though it did.
  assert.match(editor.toolbarCss, /:active:not\(\[disabled\]\)/)
  assert.match(editor.launcherCss, /\.de-launcher:active/)
})

// ── Hover text and accessible names ────────────────────────────────────────

console.log("\nTooltips")

check("every icon-only toolbar button has both a tip and an aria-label", () => {
  const iconOnly = buttons().filter((button) => button.textContent.trim() === "")
  assert.equal(iconOnly.length, 9, "the whole bar is icon-only now, the mode switch included")
  for (const button of iconOnly) {
    const tip = button.getAttribute("data-de-tip")
    const label = button.getAttribute("aria-label")
    assert.ok(tip && tip.length > 0, `missing data-de-tip: ${button.outerHTML}`)
    assert.ok(label && label.length > 0, `missing aria-label: ${button.outerHTML}`)
  }
})

// The tip is a ::after, and CSS generated content joins name-from-content. On a
// button that shows no text that is harmless ONLY because the aria-label pins
// the name — an icon-only control with a tip and no label is announced as its
// own hover text, hint and all. Every control in this bar is now in that
// position, so the label is not belt-and-braces here, it is the name. jsdom
// computes no accessible name, so this asserts the thing that makes the name
// correct rather than the name itself.
check("a tip never becomes a button's accessible name", () => {
  const tipped = buttons().filter((button) => button.hasAttribute("data-de-tip"))
  assert.equal(tipped.length, buttons().length, "every control in the bar carries a tip")
  for (const button of tipped) {
    const label = button.getAttribute("aria-label")
    assert.ok(label, `tip without a label: ${button.outerHTML}`)
    // The tip may say MORE than the name — the shortcut, or what pressing
    // does — but it has to start with it, or the hover text and the spoken
    // name are two different controls.
    assert.ok(
      button.getAttribute("data-de-tip").startsWith(label),
      `"${button.getAttribute("data-de-tip")}" does not lead with "${label}"`
    )
  }
})

check("a tip names the shortcut where the control has one", () => {
  assert.match(byLabel("Undo").getAttribute("data-de-tip"), /^Undo · \S/)
  assert.match(byLabel("Redo").getAttribute("data-de-tip"), /^Redo · \S/)
})

check("no toolbar control falls back to the native title attribute", () => {
  for (const button of buttons()) assert.equal(button.getAttribute("title"), null)
})

/*
 * The bar no longer draws its own tip, and this case now guards the handover.
 *
 * It used to read `.de-toolbar [data-de-tip]::after` out of this sheet and pin
 * its geometry: `bottom: calc(100% + 8px)`, no `top`, `pointer-events: none`,
 * a 400ms delay. All of that has moved to `css/tooltip.ts`, because a
 * pseudo-element cannot measure the viewport — the old card was centred on the
 * control with `translateX(-50%)` and ran off the screen on the bar's outermost
 * tool, which no CSS expression can notice.
 *
 * So what is asserted here is the two halves of the replacement: that this
 * sheet has stopped drawing one, and that the shared sheet draws a card that is
 * positioned from script rather than anchored to its trigger. The placement
 * maths itself is covered where it lives.
 */
check("the bar hands its tooltip to the shared, viewport-aware one", () => {
  // A RULE, not a mention: the note left in place of the old block names the
  // selector it replaced, and that note ships inside the CSS string.
  assert.doesNotMatch(
    editor.toolbarCss,
    /\[data-de-tip\]::after\s*\{/,
    "the toolbar is drawing its own tooltip again"
  )
  // `fixed`, because a card that has to escape the bar cannot be positioned
  // against it; and non-interactive, so it never eats the hover that spawned it.
  assert.match(editor.tooltipCss, /position: fixed/)
  assert.match(editor.tooltipCss, /pointer-events: none/)
})

// `transition: none` under the reduced-motion query zeroes transition-property,
// which takes the delay with it and flashes a label at every button the pointer
// crosses. base.ts clamps the duration for the whole chrome already, so this
// file must not restate it.
check("reduced motion drops the fade without dropping the delay", () => {
  assert.doesNotMatch(editor.toolbarCss, /@media[^{]*prefers-reduced-motion/)
})

// ── Interactive mode ───────────────────────────────────────────────────────

console.log("\nInteractive mode")

const interactive = () => mode()

/*
 * The editor OPENS inspecting, and the control says so by being pressed.
 *
 * This assertion is inverted from what it used to be, deliberately. The button
 * tracked `interactive`, so the arrow lit at the exact moment the editor handed
 * the pointer away — a pressed control announcing that its own feature was off.
 * Pressed now means "a click selects", which is what pressed means everywhere
 * else in this bar.
 */
check("it defaults to ON, because inspecting is the mode the editor opens in", () => {
  context.setMode("inspecting")
  assert.equal(editor.editorMode(), "inspecting")
  assert.equal(interactive().getAttribute("aria-pressed"), "true")
  // The word used to be on the button. It is in the name and the tip now, and
  // that is the whole of the change: what must not happen is the state going
  // unsaid because the pill that said it was deleted.
  assert.equal(interactive().textContent.trim(), "")
  assert.equal(interactive().getAttribute("aria-label"), "Inspect")
  assert.match(interactive().getAttribute("data-de-tip"), /^Inspect · /)
  assert.equal(editor.editorOwnsInput(), true)
})

check("clicking it hands the pointer to the app, and clicking again takes it back", () => {
  interactive().click()
  assert.equal(editor.editorMode(), "interactive")
  assert.equal(interactive().getAttribute("aria-pressed"), "false")
  assert.equal(editor.editorOwnsInput(), false, "the app never actually got the pointer")
  interactive().click()
  assert.equal(editor.editorMode(), "inspecting")
  assert.equal(interactive().getAttribute("aria-pressed"), "true")
})

/*
 * The switch used to read "Interactive" in both of its states and be told apart
 * only by a pressed ring, so the word was a promise in one state and a lie in
 * the other. Then it named the state you were standing in, in a pill. The pill
 * is gone and the word is not: it moved into the accessible name and the tip,
 * which is where every other control in this bar keeps its label.
 *
 * What did NOT change is the half that carries the state on screen, and this
 * case is mostly about that half. A glyph read at 16px in the corner of the eye
 * has to differ in SHAPE, because a pair told apart by colour alone is not told
 * apart — and with the word off the button, the shape is now the only thing a
 * sighted user has.
 *
 * Solid versus hollow is that difference. It is the one place in the chrome
 * that still swaps a fill rather than thickening a stroke, because this switch
 * has to read at a glance from across the bar and because the pointer is the
 * one glyph in the set whose silhouette is a single closed path — the only kind
 * that survives being flooded.
 */
check("each state is named to assistive tech and drawn in a different shape", () => {
  const read = () => {
    const svg = shownGlyph(interactive())
    return {
      label: interactive().textContent.trim(),
      name: interactive().getAttribute("aria-label"),
      tip: interactive().getAttribute("data-de-tip"),
      d: svg.querySelector("path").getAttribute("d"),
      fill: svg.getAttribute("fill"),
    }
  }

  context.setMode("inspecting")
  const inspecting = read()
  context.setMode("interactive")
  const handedOver = read()

  // Nothing on the button, in either state.
  assert.equal(inspecting.label, "")
  assert.equal(handedOver.label, "")
  // The name is the state you are STANDING IN, and it moves when the state
  // does. A name pinned to a stable "Interactive mode" would be the thing WCAG
  // 2.5.3 exists to prevent, one step worse now that nothing is on screen to
  // contradict it.
  // Both states share ONE name now, because the control is one thing that is on
  // or off rather than two modes sharing a button. The state rides
  // `aria-pressed` — which is what a toggle is for — and the tip carries the
  // consequence. A name that changed under a toggle would announce two
  // different controls in the same place.
  assert.equal(inspecting.name, "Inspect")
  assert.equal(handedOver.name, "Inspect")
  // The tip leads with that name and then says what pressing DOES, which is the
  // other sentence entirely — and the one the deleted pill never had room for.
  assert.ok(inspecting.tip.startsWith("Inspect · "))
  assert.ok(handedOver.tip.startsWith("Inspect · "))
  assert.notEqual(inspecting.tip, inspecting.name)
  assert.notEqual(inspecting.tip, handedOver.tip)
  /*
   * Weight, not hue: one arrow solid, the same arrow hollow.
   *
   * The claim that matters has never moved — a solid arrow and a hollow one are
   * two marks at 16px in the corner of the eye, where two colours of the same
   * mark are one. How it is checked has moved twice, with the icon family.
   *
   * The first set drew each weight as its own even-odd path, so both states
   * said `fill="none"` and the whole difference lived in `d`; the two were
   * authored apart and drifted, and the pointer jumped a few per cent on press.
   * Lucide strokes, so the weight became a paint over ONE drawing and `d` was
   * the thing that had to hold still. Phosphor ships its fill and regular
   * weights as two drawings, so `d` differs by design again. What has to hold
   * is that the hollow one has a hole: more subpaths than the solid one. Their
   * sizes are held equal by the generator and by `icon-cases.mjs`.
   */
  const subpaths = (d) => (d.match(/M/gi) ?? []).length
  assert.notEqual(handedOver.d, inspecting.d, "both states draw the same mark")
  assert.ok(
    subpaths(handedOver.d) > subpaths(inspecting.d),
    "the hollow pointer punches nothing out, so both states draw the same mark"
  )
  assert.equal(inspecting.fill, "currentColor", "the editor holding the pointer must draw it solid")
  assert.equal(handedOver.fill, "none", "handing the pointer back must hollow it")
  context.setInteractive(false)
})

/*
 * The same claim the old pill made, now that everything is a square.
 *
 * It used to read: a pressed MODE must not wear the primary ACTION's filled
 * indigo pill, because two identical pills a few pixels apart are two things to
 * press rather than one state you are standing in. Both of those controls are
 * 32px squares now, so the collision is closer and the claim is the same one:
 * a toggle that is ON and the commit that is ARMED must not be told apart by
 * hue alone.
 *
 * They are not. ON is the accent as a FILL, armed is the accent as INK on the
 * bar's own ground — two different properties, so the two are distinguishable
 * without holding them side by side.
 */
check("an on toggle and the armed commit do not wear the same treatment", () => {
  const rule = (selector) =>
    editor.toolbarCss.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`, "s"))?.[0] ?? ""
  const pressed = rule('\\.de-toolbar \\.de-tool\\[aria-pressed="true"\\]')
  const commit = rule("\\.de-toolbar \\.de-tool--commit:not\\(\\[disabled\\]\\)")
  assert.ok(pressed, "the pressed tool rule must exist")
  assert.ok(commit, "the armed commit rule must exist")
  assert.ok(pressed.includes(`background: ${editor.tokens.color.accentSurface};`), pressed)
  assert.doesNotMatch(commit, /background:/, "the commit borrowed the toggle's fill")
  assert.ok(commit.includes(`color: ${editor.tokens.color.accent};`), commit)
  // And the retired pill vocabulary did not survive its only user. A pressed
  // `.de-button` treatment kept for nobody is a treatment the next text button
  // in the chrome inherits by accident.
  assert.equal(rule('\\.de-button\\[aria-pressed="true"\\]'), "")
})

/*
 * One group, and the order is the whole of what it used to say in three.
 *
 * The clusters were real — what a click does, what to do with what you did,
 * what the editor is showing you — and they were drawn in air between squares
 * that look identical, which marks that a break exists without saying which
 * question it is about. Eight glyphs is read straight through, so the run below
 * is the contract now: every adjacency that was load-bearing is still in it,
 * and the two stray gaps are not.
 *
 * Mode leads outright. Every other control's answer depends on which mode you
 * are in, and the group that used to sit ahead of it was the way back to the
 * chooser, which names the app and went to the top of the left panel.
 *
 * Hide is last: nothing is read after the control that takes the bar off
 * screen. And the two panel toggles are one drawing mirrored, so they stay
 * adjacent and in the order the screen is in — a control parting them makes the
 * mirror unreadable, which is what the theme used to do from between the right
 * panel and the way out. It leads them instead.
 */
check("the strip is one group, and the mode leads it", () => {
  const groups = Array.from(toolbar.querySelectorAll(".de-toolbar-group"))
  assert.equal(groups.length, 1, "the clusters came back")
  assert.equal(toolbar.firstElementChild, groups[0])
  assert.equal(interactive().closest(".de-toolbar-group"), groups[0])
  const run = Array.from(groups[0].children).map((node) => node.getAttribute("aria-label"))
  assert.deepEqual(run, [
    "Inspect",
    "Notes",
    "Canvas view",
    "Undo",
    "Redo",
    "Switch to light mode",
    "Show or hide left panel",
    "Show or hide inspector",
    "Hide editor",
  ])
  // Every control is in it. A square that renders outside the one group is a
  // second cluster whether or not it is wrapped in one.
  assert.equal(toolbar.querySelectorAll(".de-tool").length, run.length)
})

/*
 * The bar does not report the queue, and it does not carry a second door to the
 * Changes tab.
 *
 * Both of those were one square. It was a fair control while it was the commit,
 * and a redundant one once it stopped writing: what it did on a press — open
 * the inspector — is what the inspector toggle three glyphs to its left already
 * does, and the number it carried is the number the tab's own badge carries.
 * Two readers of one count is how a bar comes to disagree with the panel it
 * points at, and this is the case that stops the second reader coming back.
 *
 * `data-de-count` is asserted across the whole bar rather than on the square
 * that used to wear it: the failure worth catching is a count reappearing on
 * ANY control here, not on that one.
 */
check("no control in the bar counts the outbox or reopens the Changes tab", () => {
  assert.equal(byLabel("Changes"), null, "the Changes indicator is back in the bar")
  assert.equal(toolbar.querySelector(".de-tool--pending"), null)
  assert.equal(toolbar.querySelector("[data-de-count]"), null, "the bar is counting again")
  assert.doesNotMatch(editor.toolbarCss, /de-tool--pending/)
})

// The mode used to grey the tool cluster out, which was the honest thing to do
// with controls that could not take effect. There is no such cluster now, so
// flipping it must change nothing about what is inert — anything it still
// dimmed would be a control that had quietly stopped meaning anything.
check("flipping the mode no longer stands anything down", () => {
  const inert = () => buttons().filter((button) => button.disabled).length
  context.setInteractive(false)
  const off = inert()
  context.setInteractive(true)
  assert.equal(inert(), off)
  assert.equal(interactive().disabled, false)
  context.setInteractive(false)
})

/** Returns whether the canvas swallowed the app's click. */
const clickApp = () => {
  const target = window.document.getElementById("cta")
  window.__stack = [target, window.document.getElementById("app")]
  const event = new window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 10,
  })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

check("with interactive off a canvas click IS swallowed", () => {
  context.setInteractive(false)
  assert.equal(clickApp(), true)
})

check("with interactive on a canvas click is NOT swallowed", () => {
  context.setInteractive(true)
  assert.equal(clickApp(), false)
})

check("pointer, key and double-click handlers all stand down together", () => {
  const target = window.document.getElementById("cta")
  context.setInteractive(false)
  context.select(null)
  context.setState({ scope: null, hovered: null })
  context.setInteractive(true)

  window.__stack = [target, window.document.getElementById("app")]
  const pointer = (type, init = {}) =>
    target.dispatchEvent(
      new window.PointerEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: 10, ...init })
    )
  pointer("pointermove")
  assert.equal(context.getState().hovered, null, "hover highlight must stay down")
  pointer("pointerdown")
  pointer("pointerup")
  assert.deepEqual(context.getState().selection, [], "a press must not select")
  target.dispatchEvent(
    new window.MouseEvent("dblclick", { bubbles: true, clientX: 10, clientY: 10 })
  )
  assert.deepEqual(context.getState().selection, [], "a double-click must not drill")
  assert.equal(context.getState().scope, null)
})

check("a bare letter reaches the app in interactive mode too", () => {
  context.setInteractive(true)
  const event = new window.KeyboardEvent("keydown", { key: "h", bubbles: true, cancelable: true })
  window.dispatchEvent(event)
  assert.equal(event.defaultPrevented, false)
  assert.equal(context.getState().tool, "move")
})

check("leaving the mode hands the canvas back", () => {
  context.setInteractive(false)
  assert.equal(editor.editorOwnsInput(), true)
  assert.equal(clickApp(), true)
  window.__stack = [window.document.getElementById("cta"), window.document.getElementById("app")]
  window.document
    .getElementById("cta")
    .dispatchEvent(
      new window.PointerEvent("pointermove", { bubbles: true, clientX: 10, clientY: 10 })
    )
  assert.notEqual(context.getState().hovered, null, "hover must come back")
})

// ── The commit path's other half moved out ─────────────────────────────────

console.log("\nCopying the brief")

/**
 * ONE button and one chord, and the button is the panel's.
 *
 * This case has argued both sides. The copy moved out of the bar first, to sit
 * under the queue it copies, because a toolbar has room for a button and never
 * for a list — then came back as a square, because that reasoning holds for the
 * LIST and not for the action, and the bar exists to survive the panel being
 * shut. Copying from the only place it was drawn meant reopening 260px you had
 * closed on purpose.
 *
 * What retires the square is the pairing above it: Notes and Inspect now raise
 * the right panel on the tab that answers them, so by the time the outbox has
 * anything in it, the panel holding the same Copy is up. The bar's square was a
 * door into a room you are standing in.
 *
 * The CHORD stays, and it is not a lesser copy — `notes.copy` calls the same
 * `buildAnnotationBrief`, inside the keydown's own user activation, which is
 * all the clipboard ever needed from the click. `inspector-tabs-cases.mjs`
 * still holds the panel footer's behaviour.
 */
check("the copy is the panel's button and the bar's chord, not a square", () => {
  assert.equal(byLabel("Copy notes and edits"), null, "the bar's copy square is back")
  const inPanel = Array.from(context.slots.right.querySelectorAll("button")).some(
    (button) => button.textContent.trim() === "Copy"
  )
  assert.ok(inPanel, "the panel footer lost the copy it is drawn under")
  assert.ok(editor.hasCommand("notes.copy"), "the chord went with the square")
  // The retired spelling must not creep back into either place. It shortened
  // when Prompts became Notes: the brief carries notes AND edits, and naming
  // one of the two would be the wrong half.
  assert.equal(byText("Copy change prompts"), null)
})

/*
 * With nothing pinned and nothing edited there is nothing to copy, and the bar
 * says so rather than putting an empty brief on the clipboard.
 *
 * Driven on its own module graph because the annotation store is a singleton
 * and this asserts that it is EMPTY — a note left behind by a case above would
 * make this pass for the wrong reason, or fail for one.
 *
 * jsdom ships no `navigator.clipboard`, so a non-empty outbox would take the
 * refusal branch here rather than the success one. That is the branch a browser
 * with the API disabled takes too, and it is the one that must not toast a
 * success it did not get.
 */
const copyLane = await toolbarWith(null, "copy-empty-outbox")

/*
 * The chord, run the way the key runs it.
 *
 * There is no square to click any more, and reaching into the module for
 * `copyBrief` would not be the same test: what a designer presses is a name in
 * the registry, and a copy that works only when called directly is a copy with
 * no way in.
 */
const pressCopy = () => copyLane.module.runCommand("notes.copy")

check("copying an empty outbox reports it instead of copying nothing", () => {
  assert.ok(pressCopy(), "no copy command in the bar")
  assert.match(copyLane.toasts.at(-1).message, /Nothing to copy/)
  assert.notEqual(copyLane.toasts.at(-1).kind, "error", "an empty outbox is not a failure")
})

/*
 * DELETING a note is the only way to take it off the handover.
 *
 * This case used to be about resolving one. A tick beside the bin marked a note
 * dealt-with, the brief dropped it, and the bar's count had to drop it too or
 * the toast described a different pile of work from the clipboard. The tick is
 * gone and so is the status behind it — both took a note off the list, 2px
 * apart under identical buttons, and the difference only mattered if you went
 * looking for a resolved note later, which the panel gave you no way to do.
 *
 * What is pinned now is the consequence: with one way off the list, the count
 * and the brief cannot disagree. A note that is in the store is work; a note
 * that is deleted is gone. There is no third state for the two to read
 * differently.
 */
const note = copyLane.module.addAnnotation({
  kind: "region",
  comment: "tighten this",
  url: "http://localhost/",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  target: null,
  selectedText: null,
  ancestry: [],
  computed: {},
  components: [],
})
/*
 * A real pile of work first, so this case can tell the two outcomes apart.
 * jsdom ships neither `navigator.clipboard` nor the copy command, so a
 * non-empty outbox is refused on every route — and the answer arrives a few
 * microtasks after the press, which is the wait below.
 */
pressCopy()
for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()

check("a copy refused on every route says so, and never claims success first", () => {
  assert.equal(copyLane.toasts.at(-1).message, "Could not copy to the clipboard. Try again")
  assert.equal(copyLane.toasts.at(-1).kind, "error")
  assert.ok(
    !copyLane.toasts.some((toast) => /^Copied/.test(toast.message)),
    "a refused copy toasted Copied before the refusal"
  )
})

check("deleting a note is what takes it off the handover", () => {
  copyLane.module.removeAnnotation(note.id)
  pressCopy()
  assert.match(copyLane.toasts.at(-1).message, /Nothing to copy/)
  copyLane.module.clearAnnotations()
})

/*
 * Canvas view is a toggle the BOARD answers, not the bar.
 *
 * The button runs the board's command by name, so it cannot drift from ⇧1, and
 * a bar mounted before the board has installed is a no-op rather than a crash.
 * Hovering it asks the board to start loading the current page's frame, and
 * the pressed state is read from the store, which only the board writes.
 */
check("the canvas toggle runs the board's commands and reports canvasView", () => {
  const button = toolbar.querySelector('[data-de-control="canvas"]')
  assert.ok(button, "no canvas toggle in the bar")
  assert.equal(button.getAttribute("aria-label"), "Canvas view")
  assert.match(button.getAttribute("data-de-tip") ?? "", /1/, "the tip should carry ⇧1")
  const calls = []
  const offToggle = editor.registerCommand("view.canvas.toggle", () => calls.push("toggle"))
  const offPrewarm = editor.registerCommand("view.canvas.prewarm", () => calls.push("prewarm"))
  try {
    button.dispatchEvent(new window.Event("pointerenter"))
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    assert.deepEqual(calls, ["prewarm", "toggle"])
    editor.setState({ canvasView: true })
    assert.equal(button.getAttribute("aria-pressed"), "true")
    editor.setState({ canvasView: false })
    assert.equal(button.getAttribute("aria-pressed"), "false")
  } finally {
    offToggle()
    offPrewarm()
  }
})

// The page is behind the board in canvas view, so every canvas-lane gate has to
// read "not ours" for as long as it is up — an outline painted over the page
// would float over frames it does not belong to.
check("canvas view stands the canvas lane down, and leaving it hands it back", () => {
  editor.setState({ interactive: false, annotating: false, chromeHidden: false, canvasView: false })
  assert.equal(editor.editorOwnsInput(), true)
  editor.setState({ canvasView: true })
  assert.equal(editor.editorOwnsInput(), false)
  editor.setState({ canvasView: false })
  assert.equal(editor.editorOwnsInput(), true)
})

// ── The chooser, and the bar that does not offer it ────────────────────────

console.log("\nThe chooser")

/**
 * A whole second toolbar, built against a prologue of our choosing.
 *
 * `core/config.ts` reads `__DESIGNLAYER_CONFIG__` ONCE at module load. That
 * is right for a page whose prologue cannot change its mind mid-session and
 * useless to a test that needs the bar built both ways, so each answer gets its
 * own module graph: the registry is keyed by the data: URL, so the bundles have
 * to differ in their TEXT. `marker` is exported rather than written as a
 * comment because esbuild drops the comment, and four byte-identical bundles
 * are one cached module wearing the first lane's config — which passes three of
 * these cases for entirely the wrong reason. Everything downstream — the store,
 * the ledger, the toolbar — is that graph's own.
 *
 * `globalThis`, not `window`: jsdom's global object and this process's are two
 * objects, and `config.ts` reads the one the bundle actually runs on.
 */
async function toolbarWith(chooserUrl, marker) {
  globalThis.__DESIGNLAYER_CONFIG__ = chooserUrl === null ? undefined : { chooserUrl }
  const lane = await build({
    stdin: {
      contents: `
        export const marker = ${JSON.stringify(marker)}
        export { createContext } from "./src/core/context"
        export { installToolbar } from "./src/shell/toolbar"
        export { addAnnotation, removeAnnotation, clearAnnotations } from "./src/annotations/store"
        // This graph's OWN registry, which is the only one its toolbar wrote
        // its commands into — the copy lane presses the chord through it.
        export { runCommand } from "./src/core/commands"
      `,
      resolveDir: PACKAGE_DIR,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(lane.outputFiles[0].text).toString("base64")}`
  )
  globalThis.__DESIGNLAYER_CONFIG__ = undefined

  const toasts = []
  const bar = slot()
  const laneBridge = { ...bridge, toast: (message, kind) => toasts.push({ message, kind }) }
  module.installToolbar(
    module.createContext(laneBridge, {
      overlay: slot(),
      toolbar: bar,
      left: slot(),
      right: slot(),
    })
  )
  // `link` is reported rather than looked up per case because "there is no
  // anchor in this bar" is the thing several of these lanes exist to say, and a
  // null read once at build time says it for whatever the lane was handed.
  return { bar, module, toasts, link: bar.querySelector("a") }
}

// The editor takes over the URL the chooser was on, so the way back has to be
// drawn INSIDE the editor — at the top of the left panel now, where it can name
// the app it is pointed at. None of it belongs in this strip, and least of all
// in a session that has no chooser behind it: a plain `node cli.mjs 3000` has
// nothing to go back to, and an offer to leave for a screen that is not running
// is worse than no offer, because it costs the page to find out.
check("a session with no chooser behind it carries no way out at all", () => {
  assert.equal(toolbar.querySelector("a"), null, "the strip grew a link nobody asked for")
  assert.doesNotMatch(toolbar.textContent, /Choose app/)
  assert.doesNotMatch(toolbar.textContent, /Leave/)
})

const chooser = await toolbarWith("http://127.0.0.1:3455", "chooser-loopback")

/*
 * Leaving is not a step in the commit path, and trailing the strip is exactly
 * where it would read as one. It used to lead the bar instead, ahead of
 * everything, because it was the only control here that was one level up from
 * the page — and being one level up from the page is why it is no longer here
 * at all. It names the app, so it went to the top of the left panel.
 *
 * One cluster is left. There were three — what a click does, what to do with
 * what you did, what the editor is showing you — and a fourth before that, what
 * reaches the file, which went with the Changes square. The last three went for
 * a different reason: they were drawn in air between identical squares, which
 * says a break exists without saying what it is about, and eight glyphs is
 * short enough to read without one.
 *
 * The mode leads the bar outright, because every other control's answer depends
 * on which mode you are in, and nothing sits in front of it. Anything that wants
 * to has to argue its way past this case first — the one argument that ever won
 * here left with the link. A prologue is exactly the kind of thing that tries:
 * the bar is built the same way whether or not a chooser is behind it, so this
 * checks the composition survives one.
 */
check("a chooser behind the bar changes neither the group count nor the order", () => {
  const groups = Array.from(chooser.bar.querySelectorAll(".de-toolbar-group"))
  assert.equal(groups.length, 1, "a prologue split the bar back into clusters")
  assert.equal(chooser.bar.firstElementChild, groups[0])
  const run = Array.from(groups[0].children).map((node) => node.getAttribute("aria-label"))
  assert.deepEqual(run, [
    "Inspect",
    "Notes",
    "Canvas view",
    "Undo",
    "Redo",
    "Switch to light mode",
    "Show or hide left panel",
    "Show or hide inspector",
    "Hide editor",
  ])
  assert.ok(
    chooser.bar.querySelector(".de-button--mode").closest(".de-toolbar-group") === groups[0],
    "something got in front of the mode"
  )
})

/*
 * No hairline, wherever the groups come and go.
 *
 * The rule was positional once — "the third group and any after it" — which a
 * fourth group at the FRONT would have answered by drawing a second rule
 * mid-bar, so it became a class asked for by name. Then the thing it named went
 * away: the seam fronted the one control that wrote to disk, and no control in
 * this bar writes. Nothing left to mark, so nothing is drawn, in the DOM or in
 * the stylesheet.
 *
 * This case is still worth its lines because the failure it catches is the one
 * that keeps recurring in different clothes: a hairline arriving because the
 * group count changed, rather than because some break in the bar started
 * meaning more than the others. The count is one now, which is the count that
 * makes the mistake cheapest to make — a second group added without argument
 * reads as needing a mark between it and the first.
 */
check("adding or losing a group never conjures a hairline", () => {
  const seams = Array.from(chooser.bar.querySelectorAll(".de-toolbar-group--seam"))
  assert.equal(seams.length, 0, `expected no seam, saw ${seams.length}`)
  assert.doesNotMatch(editor.toolbarCss, /\.de-toolbar-group--seam/)
  const hairlines = editor.toolbarCss.match(/\.de-toolbar-group[^{]*::before\s*\{/g) ?? []
  assert.equal(hairlines.length, 0)
  /*
   * The last GROUP, not the last child. The bar's last child is the collapse
   * mark — the pointer glyph the pill wears once it has become the disc — and
   * that is not something read after the surfaces: it is absolutely positioned,
   * `aria-hidden`, and invisible for as long as the bar is on screen at all.
   * Counting it here would make this case fail for a reason that has nothing to
   * do with the groups.
   */
  const groups = Array.from(chooser.bar.querySelectorAll(".de-toolbar-group"))
  assert.ok(
    groups.at(-1).contains(chooser.bar.querySelector('[aria-label="Hide editor"]')),
    "the surfaces no longer close the bar"
  )
})

/*
 * A live chooser is the one prologue that could plausibly put a word back here,
 * so it is the one worth naming.
 *
 * `chooserUrl` did not go away when the anchor did — it is still in the config,
 * still gated by the launcher, and still read, by the control at the top of the
 * left panel that lists the running apps. So this bar now receives a URL it is
 * expected to ignore, which is exactly the shape of thing that comes back: a
 * stale `dist/` built before the move, a merge that restores the anchor, a
 * well-meant "the toolbar knows the chooser URL, why not link it". Any of those
 * fails here rather than shipping two ways out of the editor, one of which
 * navigates the page away and loses whatever was not applied.
 *
 * No anchor at all, not merely no visible one: an `<a>` in this strip is a
 * navigation a drag or a stray Enter can reach.
 */
check("a live chooser behind the session still buys the bar no way out", () => {
  assert.equal(chooser.bar.querySelectorAll("a").length, 0, "the strip linked its way out again")
  assert.doesNotMatch(chooser.bar.textContent, /Choose app|Leave/)
  // Not a button wearing the words either. Every control in this bar is a
  // square with an icon in it, and a word here would be the only one.
  assert.equal(chooser.bar.textContent.trim(), "", "the bar grew text where it draws glyphs")
})

// The launcher is the gate: `DESIGNLAYER_CHOOSER_URL` comes from a supervisor
// on this machine, and what it says ends up as an href in a page that can write
// source. Loopback and http, or nothing at all.
check("only a loopback http chooser survives the launcher", () => {
  assert.equal(
    chooserUrlFromEnv({ DESIGNLAYER_CHOOSER_URL: "http://127.0.0.1:3455" }),
    "http://127.0.0.1:3455/"
  )
  assert.equal(
    chooserUrlFromEnv({ DESIGNLAYER_CHOOSER_URL: "http://localhost:3455/" }),
    "http://localhost:3455/"
  )
  for (const refused of [
    "https://example.com/",
    "http://example.com/",
    "http://127.0.0.1.evil.test/",
    "https://127.0.0.1:3455/",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "not a url",
    "",
  ]) {
    assert.equal(chooserUrlFromEnv({ DESIGNLAYER_CHOOSER_URL: refused }), null, refused)
  }
  // Started any other way — `node cli.mjs 3000`, or `--dev` — there is no
  // chooser in existence and no default worth inventing.
  assert.equal(chooserUrlFromEnv({}), null)
})

check("the prelude carries the chooser through, and null when there is none", () => {
  const host = resolveConfig({}, { cwd: PACKAGE_DIR })
  const payload = (runtime) => {
    const sandbox = { window: {} }
    vm.runInNewContext(browserPrelude(host, runtime), sandbox)
    return sandbox.window.__DESIGNLAYER_CONFIG__
  }
  assert.equal(payload({ proxyPort: 4567 }).chooserUrl, null)
  assert.equal(
    payload({ proxyPort: 4567, chooserUrl: "http://127.0.0.1:3455/" }).chooserUrl,
    "http://127.0.0.1:3455/"
  )
  // The prelude has never named a host source path and must not start now: the
  // chooser knowing which folder it launched is not a reason for the browser to.
  assert.doesNotMatch(JSON.stringify(payload({ proxyPort: 4567 })), /projectRoot|\.tsx|\/Users\//)
})

/*
 * The same guard, run against the two prologues a bar would most regret
 * trusting. The case above proves a GOOD chooser URL buys no anchor; these
 * prove a bad one buys none either, which is the version that still matters
 * after a merge puts the anchor back — whoever restores it restores it with the
 * loopback check or without, and the bar is the last place that finds out.
 *
 * A prologue is not written only by this launcher: a stale `dist/`, or a page
 * served by something else entirely, can carry any string it likes here.
 */
for (const [name, url] of [
  ["an off-machine origin", "https://example.com/chooser"],
  ["a javascript: URL", "javascript:alert(1)"],
]) {
  const refused = await toolbarWith(url, `chooser-refused-${name}`)
  check(`${name} in the prologue draws no link at all`, () => {
    assert.equal(refused.link, null, `the bar linked ${url}`)
    assert.doesNotMatch(refused.bar.textContent, /Choose app|Leave/)
    assert.equal(refused.bar.querySelectorAll(".de-toolbar-group").length, 1)
  })
}

// ── Moving the bar ─────────────────────────────────────────────────────────

console.log("\nDragging the chrome")

/**
 * The same reporter, awaited.
 *
 * Every assertion about a dragged position has to wait out an animation frame:
 * the gesture writes the position inside `requestAnimationFrame` so that a fast
 * drag costs one layout per frame rather than one per `pointermove`. jsdom runs
 * those on a timer, which makes these the only cases in this file that cannot
 * be synchronous.
 */
async function moves(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const frame = () => new Promise((resolve) => setTimeout(resolve, 20))
const html = window.document.documentElement

/*
 * jsdom lays nothing out, so every number below is one this file supplied.
 *
 * That is the point rather than a limitation: what is under test is the
 * ARITHMETIC — the delta the gesture applies, and the bounds it clamps to —
 * and both are computed from the element's rect and the inset variables. Stub
 * both and the expected position is a sum this file can do itself, which is a
 * far stronger assertion than whatever a headless browser would have laid out.
 * The rect is stubbed per element, over the blanket 100x100 at the top of the
 * file, because a 600px pill and a 44px disc clamp to different places and the
 * difference between them is half of what these cases are about.
 */
const rectOf = (left, top, width, height) => () => ({
  x: left,
  y: top,
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
})

const bar = context.slots.toolbar
let barWidth = 600
bar.getBoundingClientRect = () => rectOf(212, 716, barWidth, 40)()

/** The app area, as the shell publishes it. */
const area = (left, right) => {
  html.style.setProperty("--de-bar-left", `${left}px`)
  html.style.setProperty("--de-bar-right", `${right}px`)
  html.style.setProperty("--de-left", `${left}px`)
  html.style.setProperty("--de-right", `${right}px`)
  html.style.setProperty("--de-top", "0px")
}

const point = (target, type, x, y, pointerId = 7) =>
  target.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId,
      clientX: x,
      clientY: y,
    })
  )

/** The pill's own left edge, which is what a panel would cover. */
const barLeftEdge = () => Number.parseFloat(bar.style.left) - barWidth / 2

/*
 * The pill is a floating surface over someone else's product, and the product
 * does not know it is coming: parked at the bottom centre it covers a tab bar
 * on one app and a cookie banner on the next. So it moves — and the slack is
 * the number that decides when a hand that has landed on it means to.
 *
 * Ten pixels, which is the DISC's figure and Agentation's, where the bar used
 * to pick four. The old four had an argument: this ground has no press to
 * steal, so the threshold only had to beat a tremor, and every pixel above that
 * is slop between the pointer and an object meant to be stuck to it. What it
 * missed is that the bar and the disc are one object — one position, one
 * gesture, two states of one morph — and a hand that must travel ten pixels to
 * shift the disc and four to shift the bar is being told the two are unalike.
 * They ARE two objects with two positions — but one hand moves both, and a hand
 * does not steady itself differently for a 600px pill than for a 44px disc.
 *
 * Bracketed rather than merely exercised, because the constant is the whole
 * decision and nothing else in this suite would notice it moving: a 3px tremor
 * and a 100px drag sit either side of four and of ten alike.
 */
await moves("a drag on the pill's ground moves it, a tremor does not, and ten is the line", async () => {
  area(0, 0)
  await frame()
  assert.equal(bar.style.left, "", "the bar did not start on its CSS anchor")

  point(bar, "pointerdown", 500, 730)
  point(bar, "pointermove", 503, 731)
  await frame()
  assert.equal(bar.style.left, "", "a 3px tremor moved the bar")
  assert.equal(bar.classList.contains("de-toolbar--dragging"), false)

  // Nine across: under the line, so still a press the ground is holding still
  // for. This is the half that fails if the bar ever goes back to four.
  point(bar, "pointermove", 509, 730)
  await frame()
  assert.equal(bar.classList.contains("de-toolbar--dragging"), false, "nine pixels armed the drag")
  assert.equal(bar.style.left, "", "nine pixels moved the bar")

  // Eleven: over it. The gesture measures from where the pointer went DOWN, so
  // arming here costs the landing below nothing — `from` was taken at 500,730.
  point(bar, "pointermove", 511, 730)
  assert.equal(
    bar.classList.contains("de-toolbar--dragging"),
    true,
    "eleven pixels did not arm the drag"
  )

  point(bar, "pointermove", 600, 700)
  assert.equal(bar.classList.contains("de-toolbar--dragging"), true, "no grabbing cursor")
  point(bar, "pointerup", 600, 700)
  await frame()
  // Down at 500,730 and up at 600,700 is a delta of +100,-30 on a pill whose
  // rect starts at 212,716 — so the box lands at 312,686 and `left` carries
  // its CENTRE, because the centring translate is still in force.
  assert.equal(bar.style.left, "612px")
  assert.equal(bar.style.top, "686px")
  assert.equal(bar.style.bottom, "auto", "the pill is still anchored to the bottom too")
  assert.equal(bar.classList.contains("de-toolbar--dragging"), false)
})

/*
 * Two claims in one case, because they are the same claim from both sides: the
 * gesture and the controls must not be able to steal each other's press.
 *
 * The second half also pins a bug this arrangement invites. The flag that
 * stops a drag ending in a click is cleared on the next pointerdown rather
 * than only when a click arrives — leave it standing through a press that
 * lands on a control and the drag before it swallows THAT control's click, one
 * gesture later and for no reason anybody could see.
 */
await moves("a press on a control neither drags the bar nor loses its click", async () => {
  const before = [bar.style.left, bar.style.top]
  editor.setState({ layersOpen: true })
  const toggle = byLabel("Show or hide left panel")

  point(toggle, "pointerdown", 500, 730)
  point(toggle, "pointermove", 560, 700)
  point(toggle, "pointerup", 560, 700)
  await frame()
  assert.deepEqual([bar.style.left, bar.style.top], before, "a press on a button moved the bar")
  assert.equal(bar.classList.contains("de-toolbar--dragging"), false)

  toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  assert.equal(context.getState().layersOpen, false, "the control the press landed on went dead")
  editor.setState({ layersOpen: true })
})

/*
 * One contact, and every one after it ignored until the first lets go.
 *
 * A second finger landing on a surface that is already being dragged is not a
 * second drag — it is the other hand steadying a tablet, or a palm. Track both
 * and the bar teleports between two contact points, then jumps back when one
 * of them lifts.
 */
await moves("a second touch does not take the bar off the first", async () => {
  point(bar, "pointerdown", 500, 700, 1)
  point(bar, "pointermove", 540, 660, 1)
  await frame()
  const held = [bar.style.left, bar.style.top]

  point(bar, "pointerdown", 100, 100, 2)
  point(bar, "pointermove", 900, 300, 2)
  await frame()
  assert.deepEqual([bar.style.left, bar.style.top], held, "a second contact moved the bar")

  // …and the first finger still owns the gesture it started.
  point(bar, "pointerup", 100, 100, 2)
  point(bar, "pointermove", 560, 640, 1)
  point(bar, "pointerup", 560, 640, 1)
  await frame()
  assert.notDeepEqual([bar.style.left, bar.style.top], held, "the first finger lost the bar")
})

/*
 * The bounds are the APP AREA, never the viewport — and they STOP rather than
 * give.
 *
 * The first half of that is unchanged and is the valuable half: a bar dragged
 * to x = 0 with the layers panel open is not a bar the user put on the left, it
 * is a bar they lost under a panel.
 *
 * The second half is repealed. There used to be a rubber band here — the bar
 * followed the hand up to 48px past the bound and was handed the overhang back
 * on release — on the argument that an edge stopping dead reads as the drag
 * having broken. What that argument borrowed without checking is where the band
 * comes from: scrolling, where the overhang reveals empty space the user owns
 * and the only thing it costs is a glimpse of nothing. This surface hangs over
 * somebody else's product, so the overhang is live app pixels covered by chrome
 * that is not allowed to be there, and a bar 40px into the layers panel is not
 * physics, it is a flash of the failure the clamp exists to prevent.
 *
 * So the clamp is the same function during the gesture as after it, and the
 * assertion this design can make that the old one could not is that there is
 * never anything to hand back: the surface is already exactly on the bound
 * while the pointer is still down and still moving away from it.
 */
await moves("the bar stops at the edge of the app area and never hangs over it", async () => {
  barWidth = 300
  area(240, 260)

  point(bar, "pointerdown", 500, 700)
  point(bar, "pointermove", -5000, 700)
  await frame()
  // Pulled 5,000px past the bound, with the hand still down: already on it.
  // 240 of panel plus the 12px inset the pill rests at.
  assert.equal(barLeftEdge(), 252, "the edge gave while the hand was still holding it")

  point(bar, "pointerup", -5000, 700)
  await frame()
  // …and release changes nothing, because there was no overhang to return.
  assert.equal(barLeftEdge(), 252, "the bar settled under the layers panel")
  assert.equal(bar.style.left, "402px")

  point(bar, "pointerdown", 0, 700)
  point(bar, "pointermove", 5000, 700)
  point(bar, "pointerup", 5000, 700)
  await frame()
  // 1024 wide, 260 of inspector, 12 of inset: the pill's right edge stops at
  // 752 and the inspector starts at 764.
  assert.equal(barLeftEdge() + barWidth, 752, "the bar settled under the inspector")
  assert.equal(bar.style.left, "602px")
})

/*
 * A panel can be toggled mid-session, and a bar parked against the edge it
 * arrives at has to walk back inward rather than disappear beneath it.
 *
 * The variable is written before the state, because that is the order the real
 * chrome runs in: the shell subscribes when it mounts and every lane installs
 * afterwards, so `--de-bar-right` already holds its new value by the time the
 * toolbar re-clamps against it.
 *
 * And it does NOT walk back out. Re-clamping writes the shared position rather
 * than only the paint, so a surface that moved because a panel opened does not
 * move a second time because the panel shut — one correction, not a bar that
 * springs about every time a disclosure is pressed.
 */
await moves("opening a panel walks a covered bar back in, and closing it leaves it", async () => {
  area(0, 0)
  editor.setState({ inspectorOpen: false })
  point(bar, "pointerdown", 0, 700)
  point(bar, "pointermove", 5000, 700)
  point(bar, "pointerup", 5000, 700)
  await frame()
  assert.equal(bar.style.left, "862px", "the bar is not parked at the right edge")

  html.style.setProperty("--de-bar-right", "260px")
  editor.setState({ inspectorOpen: true })
  await frame()
  assert.equal(bar.style.left, "602px", "the inspector opened on top of the bar")
  assert.equal(barLeftEdge() + barWidth, 752)

  html.style.setProperty("--de-bar-right", "0px")
  editor.setState({ inspectorOpen: false })
  await frame()
  assert.equal(bar.style.left, "602px", "the bar sprang back out when the panel shut")
})

await moves("a window that shrank pulls the bar back onto it", async () => {
  Object.defineProperty(window, "innerWidth", { value: 600, configurable: true })
  window.dispatchEvent(new window.Event("resize"))
  await frame()
  // 600 wide, no panels, 12 of inset, a 300px pill: the box stops at 288.
  assert.equal(barLeftEdge(), 288)
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true })
  window.dispatchEvent(new window.Event("resize"))
  await frame()
  // Re-clamped, not re-proportioned: the widened window does not hand back a
  // position the clamp already took, because the clamp wrote it down.
  assert.equal(barLeftEdge(), 288)
})

/*
 * A bar NOBODY HAS MOVED does not move when a panel is toggled, and that is a
 * different promise from the two cases above.
 *
 * Those are about a DRAGGED bar, where the rule is "one correction, and it
 * stays" — the user chose a spot, a panel took it, and springing back the
 * moment the panel shuts would make a disclosure button move the toolbar twice
 * per press.
 *
 * This is the resting bar, and the old behaviour was the bug. It was centred on
 * the CANVAS, so its middle was a function of which panels were open: pressing
 * the layers toggle slid the whole row ~120px sideways and pressing the
 * inspector toggle slid it ~130px the other way, which meant the button you had
 * just pressed travelled out from under your pointer. It is centred on the
 * WINDOW now, and the window does not move when a panel does.
 *
 * What the canvas-centring was protecting still has to hold: on a narrow
 * viewport a window-centred bar really can reach under a panel. So the clamp
 * covers the resting bar too — and, unlike the dragged one, it hands the bar
 * BACK to the stylesheet the moment the panel that displaced it shuts. Nobody
 * chose the edge of a panel, so nothing is owed to it.
 *
 * `installDrag` directly rather than the real bar, for the reason given where
 * it is exported: the shared `bar` above has been dragged by every case in this
 * section, and a surface with a position of its own never reaches this branch.
 */
await moves("a resting bar ignores a panel toggle, and yields only when covered", async () => {
  const width = 300
  const height = 40
  const surface = window.document.createElement("div")
  window.document.body.append(surface)
  surface.getBoundingClientRect = rectOf(362, 776, width, height)

  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true })
  Object.defineProperty(window, "innerHeight", { value: 828, configurable: true })

  const painted = []
  let rested = 0
  area(0, 0)

  const drag = editor.installDrag({
    element: surface,
    dragging: "de-toolbar--dragging",
    slack: 10,
    inset: 12,
    sides: ["--de-bar-left", "--de-bar-right"],
    size: () => ({ width, height }),
    // The same two numbers `css/toolbar.ts` writes, which is the agreement the
    // whole arrangement rests on.
    anchor: () => ({
      x: (window.innerWidth - width) / 2,
      y: window.innerHeight - height - 12,
    }),
    paint: (box) => painted.push(box),
    rest: () => {
      rested += 1
    },
  })

  // Mounted with no panels: the window's middle is inside the bounds, so the
  // stylesheet keeps it and nothing is written inline at all.
  assert.equal(rested, 1, "a resting bar was painted instead of left to CSS")
  assert.deepEqual(painted, [], "an uncovered resting bar wrote an inline position")

  // Both panels out. 1024 wide, 240 + 260 of panel, a 300px pill: the canvas
  // runs 240..764, and the pill centred on the window runs 362..662 — clear of
  // both. The bar must not move, which is the whole point of the change.
  area(240, 260)
  drag.place()
  await frame()
  assert.equal(rested, 2, "toggling a panel took the resting bar off its anchor")
  assert.deepEqual(painted, [], "toggling a panel moved a bar nobody had moved")

  /*
   * Now genuinely covered: the inspector dragged out to its share of a narrow
   * window. 700 wide with 300 of inspector leaves a canvas of 0..400, and the
   * pill centred on the window would run 200..500 — 100px of it underneath the
   * panel. The clamp walks it back to the last legal box, 88..388.
   */
  Object.defineProperty(window, "innerWidth", { value: 700, configurable: true })
  area(0, 300)
  drag.place()
  await frame()
  assert.equal(painted.length, 1, "a covered resting bar was left under the panel")
  assert.equal(painted.at(-1).x, 88, "the covered bar did not stop at the panel's edge")
  assert.equal(rested, 2)

  // …and the panel shuts. A DRAGGED bar would keep the 88 (see the two cases
  // above); this one never chose it, so it goes straight back to the anchor and
  // to being the stylesheet's problem again.
  area(0, 0)
  drag.place()
  await frame()
  assert.equal(rested, 3, "the displaced bar stayed put after the panel shut")
  assert.equal(painted.length, 1, "the bar was repainted instead of handed back")

  drag.destroy()
  surface.remove()
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true })
})

/*
 * The stylesheet and the clamp have to agree about where the bar rests, and
 * this is the case that catches the day one of them is edited alone.
 *
 * Two answers to "where does it rest" is not a cosmetic drift: `place` compares
 * the anchor against the bounds to decide whether to paint at all, so an anchor
 * that disagrees with the CSS either pins the bar inline when it did not need
 * to be, or clears the inline position while CSS puts it somewhere the clamp
 * had rejected. The failure is a bar that jumps on the first panel toggle,
 * which is exactly what this change removed.
 */
check("the pill rests on the window's middle, not the canvas's", () => {
  assert.match(editor.toolbarCss, /\.de-toolbar \{[^}]*left: 50vw;/)
  assert.doesNotMatch(
    editor.toolbarCss,
    /left: calc\(var\(--de-bar-left\)/,
    "the bar is centred on the canvas again, so a panel toggle moves it"
  )
  // The width still reads the panels, and still should: a pill wider than the
  // canvas cannot be clamped anywhere good, so it gives up width first.
  assert.match(editor.toolbarCss, /max-width: calc\(100vw - var\(--de-bar-left\)/)
})

/*
 * The disc and the pill are TWO objects, and this is the case that says so.
 *
 * They were briefly one. A collapse that morphed the pill into the disc needed
 * somewhere for the pill to land, so the position could not belong to either
 * surface — drag the disc and expanding brought the bar back there; drag the
 * bar and collapsing left the disc where the bar had been. Coherent, and wrong
 * for the thing people actually do with these: park the bar clear of whatever
 * the app has at the bottom of the page, and park the disc somewhere it is not
 * in the way. One position cannot satisfy both, and the morph is gone.
 *
 * So each remembers its own, and the test is the negative: moving one must not
 * move the other, in either direction. That is the whole of the coupling that
 * was removed, and it is the kind that comes back by accident the moment
 * somebody reintroduces a module-level "where is the floating chrome" value.
 */
await moves("the bar and the disc each remember their own position, and only their own", async () => {
  area(0, 0)
  const launcher = editor.createLauncher(() => {})
  const disc = launcher.element
  window.document.body.append(disc)
  disc.getBoundingClientRect = rectOf(0, 0, 40, 40)
  await frame()

  // Park the bar. The disc is on its CSS corner and must stay there.
  point(bar, "pointerdown", 500, 700)
  point(bar, "pointermove", 400, 600)
  point(bar, "pointerup", 400, 600)
  await frame()
  const parked = bar.style.left
  assert.notEqual(parked, "", "the bar did not move at all")
  assert.equal(disc.style.left, "", "dragging the bar took the disc off its corner")
  assert.equal(disc.style.top, "", "dragging the bar took the disc off its corner")

  // Park the disc. The bar must not follow it.
  editor.setState({ chromeHidden: true })
  point(disc, "pointerdown", 0, 0, 9)
  point(disc, "pointermove", 120, 130, 9)
  point(disc, "pointerup", 120, 130, 9)
  await frame()
  assert.equal(disc.style.left, "120px", "the disc did not take the drag")
  assert.equal(bar.style.left, parked, "the disc's drag moved the bar as well")

  /*
   * And both survive the round trip, which is the half a user would notice.
   * Hiding re-clamps the bar against an app area that has just lost its panels
   * and re-clamps the disc against one that has just gained the whole viewport;
   * neither re-clamp may be an excuse to forget where the thing was put.
   */
  const held = [bar.style.left, bar.style.top, disc.style.left, disc.style.top]
  editor.setState({ chromeHidden: false })
  await frame()
  editor.setState({ chromeHidden: true })
  await frame()
  editor.setState({ chromeHidden: false })
  await frame()
  assert.deepEqual(
    [bar.style.left, bar.style.top, disc.style.left, disc.style.top],
    held,
    "a hide and a show lost one of the two positions"
  )
  launcher.destroy()
})

/*
 * A corner saved by a PREVIOUS session seeds the disc, and only the disc.
 *
 * That is the persistence decision, and it is deliberately asymmetric. The disc
 * is 44px, it rests in a corner by design, and remembering where somebody put
 * it is a preference being honoured — it is also Agentation's contract, which
 * is the pattern a designer arriving here has most likely already used. The bar
 * is 600px of chrome across the bottom of somebody else's product: one that
 * reappeared mid-page on a freshly loaded page would read as a layout that had
 * broken, with nothing on screen to explain it, because the user has not
 * touched the editor yet.
 *
 * So the bar remembers its position for as long as the session lasts — which is
 * what a collapse and an expand need — and starts every load where it was
 * designed to live. Both halves are asserted, because the cheap way to satisfy
 * the first is to write the bar's position to storage too.
 */
await moves("a saved corner restores the disc and never the bar", async () => {
  area(0, 0)
  const before = [bar.style.left, bar.style.top]
  // Well inside the bounds on purpose. A corner saved outside them is pulled
  // back in, which is right and is covered elsewhere — it would just mask what
  // this case is actually asking, which is whether the corner was read at all.
  window.localStorage.setItem("designlayer:launcher-position", JSON.stringify({ x: 120, y: 300 }))
  const restored = editor.createLauncher(() => {})
  window.document.body.append(restored.element)
  restored.element.getBoundingClientRect = rectOf(0, 0, 44, 44)
  await frame()

  assert.equal(restored.element.style.left, "120px", "the disc did not take its saved corner")
  assert.equal(restored.element.style.top, "300px")
  // Unchanged rather than unset: a case above this one parks the bar, and where
  // it happens to be sitting is not the claim. The claim is that a corner
  // restored from storage is not an instruction to the bar about anything.
  assert.deepEqual([bar.style.left, bar.style.top], before, "a saved corner moved the bar as well")

  restored.destroy()
  window.localStorage.removeItem("designlayer:launcher-position")
  await frame()
})

check("the pill's ground says it can be moved, and nothing selects while it is", () => {
  const pill = block("\\.de-toolbar")
  // `grab` is the only part of a drag affordance that exists before the drag.
  assert.match(pill, /cursor: grab;/)
  // A drag that crossed a word in the bar would otherwise select it and drag a
  // text selection along with the bar: two gestures from one press. No control
  // here shows text today, but the tips do, and the next one might.
  assert.match(pill, /user-select: none;/)
  // Without this a touch drag scrolls the app instead of moving the bar.
  assert.match(pill, /touch-action: none;/)
  assert.match(editor.toolbarCss, /\.de-toolbar--dragging \{ cursor: grabbing; \}/)
  // Dragging across nine buttons must not light each one's hover tint and arm
  // each one's tooltip in turn — the hand is holding the bar, not them.
  assert.match(editor.toolbarCss, /\.de-toolbar--dragging > \* \{ pointer-events: none; \}/)
  // The squares keep their own cursor, so the pointer draws the same line the
  // gesture does: over a control it is a control, over the ground it is the bar.
  assert.match(block("\\.de-tool"), /cursor: pointer;/)
  // And nothing about the drag is transitioned: the position is written from
  // the pointer every frame, so a transition would make the bar lag the hand.
  assert.doesNotMatch(editor.toolbarCss, /transition:[^;]*\bcursor\b/)
})

console.log(`\n${passed} passed, ${failed} failed`)
// Installed DOM listeners intentionally live for the editor session.
process.exit(failed > 0 ? 1 : 0)
