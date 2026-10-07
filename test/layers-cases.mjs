/**
 * Layers-panel cases for DesignLayer.
 *
 * The panel was reworked to read and behave like open-pencil's layer tree, and
 * three of those things are only testable through the real DOM: which modifier
 * reaches which selection write, which glyph a row resolves to, and how a row
 * carries its depth. So the panel is mounted over a jsdom fixture and driven
 * with genuine clicks, exactly as `selection-cases.mjs` drives the canvas.
 *
 * The fourth — the selected band and its unfocused twin — is a cascade
 * question, and jsdom has no cascade. It is asserted against the stylesheet
 * text instead, which is where the two variants actually differ.
 *
 * Usage: node designlayer/test/layers-cases.mjs
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

// ── Fixture ────────────────────────────────────────────────────────────────

/**
 * One component boundary, and under it the four things a row can be: a text
 * leaf, an image, a container, and the component itself.
 */
const MARKUP = `
<div id="root">
  <div id="wrap">
    <section id="card">
      <span id="title">Homecoming</span>
      <img id="photo" alt="">
      <div id="box"><span id="inner">Deep</span></div>
    </section>
  </div>
</div>`

/** `[componentName, ...stack frames as "Name@line"]`, nearest-first. */
const SOURCE = {
  root: ["Page", "Page@1"],
  wrap: ["Page", "Page@1"],
  card: ["Card", "Card@10", "Page@2"],
  title: ["Card", "Card@10", "Page@2"],
  photo: ["Card", "Card@10", "Page@2"],
  box: ["Card", "Card@10", "Page@2"],
  inner: ["Card", "Card@10", "Page@2"],
}

function elementInfo(element) {
  const entry = element?.id ? SOURCE[element.id] : null
  if (!entry) return null
  const [componentName, ...frames] = entry
  return {
    tagName: element.tagName.toLowerCase(),
    componentName,
    filePath: `src/${componentName}.tsx`,
    lineNumber: Number(frames[0].split("@")[1]),
    columnNumber: 1,
    stack: frames.map((frame) => {
      const [name, line] = frame.split("@")
      return {
        componentName: name,
        filePath: `src/${name}.tsx`,
        lineNumber: Number(line),
        columnNumber: 1,
      }
    }),
  }
}

function installDom() {
  const dom = new JSDOM(`<!doctype html><html><body>${MARKUP}</body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
  })
  const { window } = dom
  window.document.elementsFromPoint = () => []
  // No layout in jsdom, and the resolver reads a zero-area box as hidden —
  // which would empty the layer graph before a single row was built.
  window.Element.prototype.getBoundingClientRect = function box() {
    return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
  }
  window.Element.prototype.scrollIntoView = function scrollIntoView() {}
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
    // `navigator` is a getter-only global on Node 24, so plain assignment fails.
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
  }
  return window
}

/** One bundle per call; the store is a module singleton, so ask once. */
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

// ── Cases ──────────────────────────────────────────────────────────────────

const window = installDom()
Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true })

const {
  createContext,
  installLayersPanel,
  getState,
  setState,
  isLocked,
  layersCss,
  LAYER_INDENT,
  tokens,
} = await load(`
    export { createContext } from "./src/core/context"
    export { installLayersPanel } from "./src/panels/layers"
    export { getState, setState, isLocked } from "./src/core/store"
    export { layersCss, LAYER_INDENT } from "./src/core/css/layers"
    export { tokens } from "./src/core/tokens"
  `)

/**
 * Everything the writer queued for source, newest last.
 *
 * This is the only honest way to tell an edit that will reach the user's JSX
 * from one that merely painted the preview: both leave an inline style behind,
 * and only the first arrives here.
 */
const queued = []
const bridge = {
  elementInfo,
  toast() {},
  store: {
    addPendingPropertyOperation(key, operation, propertyKeys) {
      queued.push({ key, operation, propertyKeys })
    },
  },
}

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const context = createContext(bridge, {
  overlay: slot(),
  toolbar: slot(),
  left: slot(),
  right: slot(),
})
installLayersPanel(context)

const $ = (name) => window.document.getElementById(name)
const rows = () => Array.from(context.slots.left.querySelectorAll(".de-layer"))
const names = () => rows().map((row) => row.querySelector(".de-layer-name").textContent)
const selection = () => getState().selection.map((entry) => entry.element.id)
const click = (index, init = {}) =>
  rows()[index].dispatchEvent(new window.MouseEvent("click", { bubbles: true, ...init }))

// Selecting a deep row is what opens its ancestors, so this is also how the
// tree gets into the expanded state every case below reads from.
context.selectMany([$("title")])
setState({ selection: [] })

console.log("\nLayers panel")

check("the tree flattens to the rows the fixture should show", () => {
  assert.deepEqual(names(), ["Page", "div", "Card", "Homecoming", "img", "div"])
})

check("a plain click replaces the selection and re-points the scope", () => {
  click(2)
  assert.deepEqual(selection(), ["card"])
  assert.equal(getState().scope, $("wrap"))
})

check("Cmd+click adds a row, and a second one takes it back out", () => {
  click(2)
  click(3, { metaKey: true })
  assert.deepEqual(selection(), ["card", "title"])
  click(3, { metaKey: true })
  assert.deepEqual(selection(), ["card"])
})

check("Ctrl+click is not the accelerator on a Mac — it just selects", () => {
  click(2)
  click(3, { ctrlKey: true })
  assert.deepEqual(selection(), ["title"])
})

check("Shift+click ranges over the flattened rows, in either direction", () => {
  click(2)
  click(4, { shiftKey: true })
  assert.deepEqual(selection(), ["card", "title", "photo"])
  click(4)
  click(2, { shiftKey: true })
  assert.deepEqual(selection(), ["card", "title", "photo"])
})

check("a range with no anchor yet falls back to selecting the one row", () => {
  setState({ selection: [] })
  // The anchor survives a cleared selection, so this case has to reach past
  // the click path and drop it the only way a real session can: a new panel.
  const fresh = createContext(bridge, {
    overlay: slot(),
    toolbar: slot(),
    left: slot(),
    right: slot(),
  })
  installLayersPanel(fresh)
  const first = fresh.slots.left.querySelector(".de-layer")
  first.dispatchEvent(new window.MouseEvent("click", { bubbles: true, shiftKey: true }))
  assert.deepEqual(selection(), ["root"])
  fresh.slots.left.remove()
})

check("every row carries a type glyph, drawn at 12", () => {
  assert.deepEqual(
    rows().map((row) => row.querySelector(".de-layer-icon").dataset.glyph),
    ["Component", "Square", "Component", "Type", "Image", "Square"]
  )
  const svg = rows()[0].querySelector(".de-layer-icon svg")
  assert.equal(svg.getAttribute("width"), "12")
})

check("only a component row takes the component tint", () => {
  assert.deepEqual(
    rows().map((row) => row.classList.contains("de-layer--component")),
    [true, false, true, false, false, false]
  )
  // The mark keeps the component tint through selection, the way open-pencil
  // does: what a row IS does not change when it is picked.
  assert.ok(
    layersCss.includes(`.de-layer--component .de-layer-icon { color: ${tokens.color.component}; }`)
  )
})

check("the indent step is 16, and each row states its own guide width", () => {
  assert.equal(LAYER_INDENT, 16)
  const style = (index) => rows()[index].getAttribute("style")
  assert.equal(style(0), "padding-left:8px;--de-indent:0px")
  assert.equal(style(2), "padding-left:40px;--de-indent:32px")
  assert.match(layersCss, /\.de-layer::before \{[^}]*width: var\(--de-indent, 0px\);/s)
  assert.match(layersCss, /repeating-linear-gradient\([^)]*\s+to right,/s)
})

check("the selected band is solid, and dims when focus leaves the tree", () => {
  const muted = `.de-layer[aria-selected="true"] { background-color: ${tokens.color.rowSelectedMuted};`
  const focused = `.de-layers-tree:focus-within .de-layer[aria-selected="true"] { background-color: ${tokens.color.rowSelected};`
  assert.ok(layersCss.includes(muted), "resting selected row is the muted band")
  assert.ok(layersCss.includes(focused), "focus inside the tree lifts it to the full band")
  assert.ok(layersCss.indexOf(muted) < layersCss.indexOf(focused), "the focused variant must win")
  assert.notEqual(tokens.color.rowSelected, tokens.color.rowSelectedMuted)
})

check("selection paints aria-selected on exactly the selected rows", () => {
  click(2)
  click(4, { shiftKey: true })
  assert.deepEqual(
    rows().map((row) => row.getAttribute("aria-selected")),
    ["false", "false", "true", "true", "true", "false"]
  )
})

check("the row keeps its motionless chrome and its rounded band", () => {
  /*
   * MOTIONLESS is about the row's BOX, not its tint. The blanket
   * `transition: none` this used to assert was borrowed from canvas chrome,
   * where `selection.ts` rewrites geometry every frame and a transition makes
   * the outline trail the element. A row in a scrolling list has no frame loop,
   * and the blanket was silencing four unrelated state changes — hover, select,
   * tree focus, hidden — on an argument that applied somewhere else. It fades
   * its tint on `snap` now; see the note on the rule in `css/layers.ts`.
   */
  const rowRule = /\.de-layer \{([^}]*)\}/s.exec(layersCss)
  assert.ok(rowRule, ".de-layer rule is missing from the layers stylesheet")
  const rowTransition = /transition:([^;]*);/s.exec(rowRule[1])
  assert.ok(rowTransition, ".de-layer must declare a transition, even if it is none")
  assert.doesNotMatch(
    rowTransition[1],
    /\b(all|transform|translate|scale|width|height|top|left|right|bottom|inset|margin|padding)\b/,
    "the row animates its own box inside a scrolling list"
  )
  // Through the token, not a literal: the kit's radius scale moved from 2/4/6/10
  // to 4/8/12/16 and a hardcoded 4 here would have gone on passing while the
  // row it describes had visibly changed shape.
  assert.ok(
    layersCss.includes(`border-radius: ${tokens.radius.sm};`),
    "the row no longer takes its corner from the control radius"
  )
  assert.match(layersCss, /\.de-layer \{[^}]*gap: 4px;/s)
})

check("the drop rule is a 2px accent line the panel can place", () => {
  const indicator = context.slots.left.querySelector(".de-layer-drop")
  assert.equal(indicator.style.display, "none")
  assert.match(layersCss, /\.de-layer-drop \{[^}]*height: 2px;/s)
  // Substring, not a RegExp built from the token. A themed token is now a
  // `var(--de-color-accent, #a1bbff)` reference, and its parentheses compile
  // into a capture group that matches nothing — a test that silently stops
  // checking the thing it names is worse than one that fails.
  const rule = layersCss.slice(layersCss.indexOf(".de-layer-drop {"))
  assert.ok(
    rule.slice(0, rule.indexOf("}")).includes(`background: ${tokens.color.accent};`),
    "the drop line is no longer painted in the accent"
  )
})

check("the filter still narrows the tree, and clearing it restores the rows", () => {
  const search = context.slots.left.querySelector("input")
  search.value = "Homecoming"
  search.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.deepEqual(names(), ["Page", "div", "Card", "Homecoming"])
  search.value = ""
  search.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.deepEqual(names(), ["Page", "div", "Card", "Homecoming", "img", "div"])
})

check("the twisty still expands and collapses a branch", () => {
  const twisty = rows()[5].querySelector(".de-layer-twisty")
  twisty.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  assert.deepEqual(names(), ["Page", "div", "Card", "Homecoming", "img", "div", "Deep"])
  rows()[5]
    .querySelector(".de-layer-twisty")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  assert.deepEqual(names(), ["Page", "div", "Card", "Homecoming", "img", "div"])
})

check("arrow keys still rove without changing the selection", () => {
  click(2)
  const before = selection()
  rows()[2].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
  assert.deepEqual(selection(), before)
  assert.equal(rows()[3].getAttribute("tabindex"), "0")
})

// ── Row actions ────────────────────────────────────────────────────────────

const action = (index, kind) =>
  rows()[index].querySelector(`.de-layer-action[data-action="${kind}"]`)
const press = (button, type = "click") =>
  button.dispatchEvent(new window.MouseEvent(type, { bubbles: true }))

console.log("\nRow actions")

check("both actions say which way they will go, and start unpressed", () => {
  const lock = action(3, "lock")
  const eye = action(3, "eye")
  assert.equal(lock.getAttribute("aria-pressed"), "false")
  assert.equal(lock.getAttribute("aria-label"), "Lock Homecoming")
  assert.equal(lock.dataset.glyph, "LockOpen")
  assert.equal(eye.getAttribute("aria-pressed"), "false")
  assert.equal(eye.getAttribute("aria-label"), "Hide Homecoming")
  // The stroked twin, not the host's filled `Eye`: that one is drawn for 24px
  // and collapses into an arc with a blob beside it at the row's 12px.
  assert.equal(eye.dataset.glyph, "EyeOpen")
})

check("the strip is reserved, not mounted on hover — only opacity moves", () => {
  assert.match(layersCss, /\.de-layer-actions \{[^}]*opacity: 0;[^}]*\}/s)
  // Nothing in the reveal may change the box: `display` or `width` here is the
  // difference between a row that holds still and one that jumps under the
  // cursor at the moment it is being aimed at.
  assert.ok(!/\.de-layer-actions \{[^}]*display: none/s.test(layersCss))
  // The kit's reveal (MICRO-INTERACTIONS § 4): hover only under a fine pointer,
  // keyboard focus and a drag always, a coarse pointer permanently, and the
  // hidden cluster inert so it cannot take a click.
  assert.match(layersCss, /\.de-layer-actions \{[^}]*pointer-events: none;[^}]*\}/s)
  assert.match(
    layersCss,
    /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.de-layer:hover \.de-layer-actions \{ opacity: 1; pointer-events: auto; \}/
  )
  assert.match(layersCss, /\.de-layer:is\(:focus-visible, :has\(:focus-visible\)\) \.de-layer-actions,/)
  assert.match(layersCss, /\.de-layer\[aria-selected="true"\] \.de-layer-actions,/)
  assert.match(layersCss, /\.de-layer--hidden \.de-layer-actions \{ opacity: 1; pointer-events: auto; \}/)
  assert.match(layersCss, /@media \(pointer: coarse\) \{\s*\.de-layer-actions \{ opacity: 1; pointer-events: auto; \}/)
})

check("pressing an action never reaches the row, so the selection holds", () => {
  click(2)
  const before = selection()
  let leaked = 0
  const spy = () => (leaked += 1)
  const tree = context.slots.left.querySelector(".de-layers-tree")
  tree.addEventListener("pointerdown", spy)
  press(action(4, "eye"), "pointerdown")
  press(action(4, "eye"))
  press(action(4, "lock"))
  tree.removeEventListener("pointerdown", spy)
  assert.equal(leaked, 0, "the press that would start a row drag was stopped")
  assert.deepEqual(selection(), before)
  // Put the fixture back: both toggles are their own inverse.
  press(action(4, "eye"))
  press(action(4, "lock"))
  assert.deepEqual(selection(), before)
})

check("the eye goes through the writer, not straight onto the element", () => {
  queued.length = 0
  press(action(4, "eye"))
  assert.equal(queued.length, 1, "hiding queued exactly one source operation")
  const [hide] = queued
  assert.equal(hide.operation.op, "updateClass")
  assert.equal(hide.operation.file, "src/Card.tsx")
  assert.deepEqual(hide.propertyKeys, ["display"])
  // `display: none` is a utility the source writer can express, so it must
  // arrive as `hidden` rather than as a preview-only style the Apply drops.
  assert.deepEqual(
    hide.operation.updates.map((update) => update.tailwindToken),
    ["hidden"]
  )
  assert.equal(window.getComputedStyle($("photo")).display, "none")
  const eye = action(4, "eye")
  assert.equal(eye.getAttribute("aria-pressed"), "true")
  assert.equal(eye.getAttribute("aria-label"), "Show img")
  assert.ok(rows()[4].classList.contains("de-layer--hidden"))

  press(action(4, "eye"))
  assert.equal(queued.length, 2, "showing is a second write, not an unset")
  // Showing has to name a display, and it names the one the element had —
  // never a blanket `block`, which would restack a flex row's children.
  assert.notEqual(queued[1].operation.updates[0].tailwindToken, "hidden")
  assert.notEqual(window.getComputedStyle($("photo")).display, "none")
  assert.equal(action(4, "eye").getAttribute("aria-label"), "Hide img")
})

check("the eye tells every panel, not just the tree, that the page changed", () => {
  let refreshed = 0
  const stop = context.onRefresh(() => (refreshed += 1))
  press(action(4, "eye"))
  assert.equal(refreshed, 1, "hiding left the inspector showing the old display")
  assert.equal(action(4, "eye").getAttribute("aria-pressed"), "true")
  press(action(4, "eye"))
  stop()
})

check("a hidden tree paints nothing, and catches up when it is shown", () => {
  click(2)
  setState({ leftTab: "controls" })
  context.selectMany([$("title")])
  assert.equal(
    rows()[3].getAttribute("aria-selected"),
    "false",
    "the tree repainted while it was on the other tab"
  )
  setState({ leftTab: "layers" })
  assert.equal(rows()[3].getAttribute("aria-selected"), "true", "showing the tree did not repaint it")
})

check("re-publishing the same elements is not a repaint", () => {
  click(2)
  rows()[2].setAttribute("aria-selected", "probe")
  // What the owner-stack source landing used to do: a new array, same element.
  setState({ selection: getState().selection.map((entry) => ({ ...entry })) })
  assert.equal(rows()[2].getAttribute("aria-selected"), "probe", "the tree repainted for nothing")
  click(2)
})

check("the lock is session state: no source write, still selectable", () => {
  setState({ selection: [] })
  queued.length = 0
  press(action(5, "lock"))
  assert.ok(isLocked($("box")), "the canvas can now ask the store to skip it")
  assert.deepEqual(queued, [], "a lock is not a fact about the user's app")
  assert.equal(action(5, "lock").getAttribute("aria-pressed"), "true")
  assert.equal(action(5, "lock").getAttribute("aria-label"), "Unlock div")
  assert.equal(action(5, "lock").dataset.glyph, "Lock")
  assert.ok(rows()[5].classList.contains("de-layer--locked"))

  // The tree is the way back out of a lock, so it must never honour one.
  click(5)
  assert.deepEqual(selection(), ["box"])

  press(action(5, "lock"))
  assert.ok(!isLocked($("box")))
  assert.equal(action(5, "lock").getAttribute("aria-label"), "Lock div")
})

/*
 * THE ONE CROSS-ELEMENT VIEW OF SAVED STYLES, AND WHY IT IS HERE.
 *
 * The floating design-options window carried a "Saved variants" tab listing
 * every element in the app with a saved style. It was the only place that view
 * has ever existed, and it went when the window was deleted — so this is the
 * replacement, and these cases exist to stop it quietly going a second time.
 *
 * Better placed than it was. That tab could not act on a row without
 * `findElement()`, forty lines that re-derived a selection by tag-scanning the
 * document and failed outright for any element not on the current screen. A row
 * here already IS the element: pressing it selects the thing whose saved styles
 * the right panel then offers the verbs for.
 *
 * The cases below assert the CONTRACT — a count appears, it is announced, a row
 * with nothing saved shows nothing — and never the badge's wording or its ink,
 * so the treatment can improve without anybody coming back here.
 */
console.log("\nSaved styles, counted on the row")

const savedBadge = (index) => rows()[index].querySelector(".de-layer-saved")

/**
 * The store key for a row, taken from the store rather than recomputed.
 *
 * `optionSets` is keyed by the same string `describe()` builds, and rebuilding
 * it here would be a second derivation that could agree with the panel today
 * and drift tomorrow. Selecting the row makes the real one observable.
 */
const keyOfRow = (index) => {
  click(index)
  return getState().selection[0].key
}

const savedSet = (key, names) => ({
  key,
  activeOptionId: null,
  baseline: null,
  options: names.map((name, i) => ({
    id: `opt-${i}`,
    name,
    className: "",
    style: {},
    text: null,
  })),
})

check("a row with nothing saved against it says nothing", () => {
  setState({ optionSets: {} })
  const badge = savedBadge(1)
  assert.ok(badge, "the row has nowhere to report a saved style at all")
  assert.equal(badge.textContent, "")
  assert.equal(badge.getAttribute("aria-label"), null, "an empty badge is still announced")
})

check("an element with saved styles carries the count, and says what it counts", () => {
  const key = keyOfRow(1)
  setState({ optionSets: { [key]: savedSet(key, ["Compact", "Roomy"]) } })
  const badge = savedBadge(1)
  assert.equal(badge.textContent, "2")
  // A bare numeral beside a layer name says nothing to a screen reader.
  assert.match(badge.getAttribute("aria-label"), /2 saved styles/)
  // A report, not a control. The row is the thing you press.
  assert.equal(badge.tagName, "SPAN")
  assert.equal(badge.getAttribute("role"), null)
})

check("one saved style is not announced as though it were several", () => {
  const key = keyOfRow(1)
  setState({ optionSets: { [key]: savedSet(key, ["Compact"]) } })
  assert.equal(savedBadge(1).textContent, "1")
  assert.match(savedBadge(1).getAttribute("aria-label"), /1 saved style\b/)
})

check("emptying a set takes the count away with it", () => {
  const key = keyOfRow(1)
  setState({ optionSets: { [key]: savedSet(key, []) } })
  assert.equal(savedBadge(1).textContent, "", "a set with no options still claims a count")
  setState({ optionSets: {} })
})

check("a row with no saved styles spends no width on saying so", () => {
  /*
   * The badge takes space only when it has something in it, which is the
   * opposite of what the action strip does one rule below — and the difference
   * is what each one is triggered by. The strip appears on HOVER, so reserving
   * its width is what stops the name jumping under a pointer merely passing
   * over. This appears when a style is SAVED: a deliberate action on this row,
   * nowhere near the pointer, and absent on almost every row of a real tree.
   * Reserving 18px and a gap on hundreds of rows to spare one row a shift it
   * earned is the wrong trade in a 240px panel.
   *
   * The name of this case used to claim the reverse while asserting this, which
   * is worse than either choice: a reader checking the layout would have taken
   * the sentence for the answer.
   */
  assert.match(layersCss, /\.de-layer-saved:empty\s*\{[^}]*display: none;/s)
  // And it is not the accent. In this tree the accent means SELECTED — the row
  // fill, the canvas outline, the current app in the chooser — and two meanings
  // on one colour in one row is what makes neither of them readable.
  const rule = /\.de-layer-saved\s*\{([^}]*)\}/s.exec(layersCss)
  assert.ok(rule, ".de-layer-saved is missing from the layers stylesheet")
  assert.doesNotMatch(rule[1], /accent/)
})

/*
 * A MULTI-SELECTION CAN BE ASSEMBLED WITHOUT A POINTER, and it could not.
 *
 * Align, distribute, the multi-edit and the batch delete are all gated behind
 * a selection of more than one row, and the only way to build one was
 * Shift-click or Cmd-click. A keyboard user could reach every one of those
 * controls and operate none of them.
 *
 * The chords deliberately mirror the pointer's, so there is one model to learn.
 */
console.log("\nAssembling a selection from the keyboard")

const arrow = (index, key, init = {}) =>
  rows()[index].dispatchEvent(
    new window.KeyboardEvent("keydown", { key, bubbles: true, ...init })
  )

check("shift and an arrow extend the selection the way shift-click does", () => {
  click(1)
  assert.equal(selection().length, 1)
  arrow(1, "ArrowDown", { shiftKey: true })
  assert.equal(selection().length, 2, "shift+arrow did not extend the selection")
  arrow(2, "ArrowDown", { shiftKey: true })
  assert.equal(selection().length, 3)
  // And it extends from the ANCHOR, so coming back shrinks rather than grows.
  arrow(3, "ArrowUp", { shiftKey: true })
  assert.equal(selection().length, 2)
})

/*
 * A plain arrow moves FOCUS and leaves the selection alone, which is the model
 * this tree has always had and the one APG describes for a multi-select tree:
 * focus and selection are separate, Shift+Arrow moves both, Enter commits.
 *
 * Worth a case of its own because it is the half that makes Shift+Arrow
 * meaningful — if a plain arrow also selected, there would be no way to travel
 * to the far end of a range without dragging the selection along behind you.
 */
check("a plain arrow travels without disturbing what is selected", () => {
  click(1)
  arrow(1, "ArrowDown", { shiftKey: true })
  assert.equal(selection().length, 2)
  arrow(2, "ArrowDown")
  assert.equal(selection().length, 2, "a plain move changed the selection instead of just focus")
  // And Enter is what commits the row focus has travelled to.
  arrow(3, "Enter")
  assert.equal(selection().length, 1, "Enter did not replace the range with the focused row")
})

check("the platform's modifier adds one row without taking the rest", () => {
  click(1)
  const first = selection()[0]
  arrow(3, "Enter", { metaKey: true })
  const after = selection()
  assert.equal(after.length, 2, "cmd+Enter did not add the focused row to the selection")
  assert.ok(after.includes(first), "adding a row dropped the one already selected")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
