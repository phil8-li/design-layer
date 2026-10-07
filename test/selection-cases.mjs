/**
 * Selection-model cases for DesignLayer.
 *
 * The model is one rule over (hit, scope, modifiers) and every surface has to
 * ask it the same question, so the ways it breaks are quiet ones: nothing
 * throws, the editor just selects the wrong thing forever. Four claims are
 * pinned here, each for a failure that is invisible from the outside.
 *
 * 1. With nothing drilled into, a plain click answers with the object that was
 *    VISUALLY clicked, and a deep click (Cmd on a Mac, Ctrl elsewhere) with the
 *    exact leaf. The old rule took the direct layer child of the scope root.
 *    That is Figma's rule and it is right on a Figma canvas, where a page's
 *    children are frames — but a document's child is the one element wrapping
 *    the entire app, so measured live before the change EVERY plain click,
 *    anywhere on the page, selected `app-root`. The modifier was the only way
 *    to reach anything, which is exactly backwards. `visualLayer` in
 *    `core/resolve` replaces it, and the "visual layer" cases below are the
 *    only place its geometry is pinned: coincidence, the sole-child wrapper
 *    climb, the area cap, the component-instance stop, the zero-area floor.
 * 2. Once the user HAS drilled in, the direct-child-of-scope rule governs
 *    again, unchanged. Inside a frame the Figma rule is the correct one, and it
 *    is what keeps Enter, Tab, the layers tree and a click agreeing about which
 *    node a gesture can reach. When they disagree the hover outline promises a
 *    selection the click does not make, and no assertion below the rule itself
 *    would notice.
 * 3. The gestures AROUND the rule — double-click drilling, Enter/Shift+Enter,
 *    Tab, shift-toggle, marquee, Escape, the overlap menu — read a resolved
 *    value but must not depend on which one. They are asserted from their new
 *    starting points so that a later change to the resolver cannot quietly take
 *    one of them with it.
 * 4. Ctrl is not deep select on a Mac, and `aria-hidden` is not hidden. Both
 *    are one-line mistakes that leave every other case green.
 *
 * Level 1 exercises the resolver and the keymap as units. Level 2 mounts the
 * real canvas lane over a jsdom fixture and drives it with genuine events, so
 * the assertions cover the wiring — which modifier reaches which branch, what
 * the scope becomes — and not just the pure functions underneath.
 *
 * jsdom is the sanctioned DOM-test path here: the selection model is a rule
 * over hit/scope/modifiers, and none of that needs a compositor. It performs no
 * layout, though, and the new rule is a rule about geometry, so the geometry is
 * declared per element — see `BOXES`.
 *
 * Usage: node designlayer/test/selection-cases.mjs
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
 * A component tree with wrapper DOM, repeated component call sites, and SVG
 * geometry that must normalize to its selectable HTML host.
 */
const MARKUP = `
<div id="root">
  <div id="wrap">
    <section id="card">
      <div id="head">
        <span id="title">Homecoming</span>
        <button id="more"><svg id="icon" aria-hidden="true"><rect id="bar"></rect></svg></button>
      </div>
      <div id="body"><p id="text">Body copy</p></div>
    </section>
    <section id="card2">
      <div id="head2"><span id="title2">Second</span></div>
    </section>
  </div>
</div>`

/** `[componentName, ...stack frames as "Name@line"]`, nearest-first. */
const SOURCE = {
  root: ["Page", "Page@1"],
  wrap: ["Page", "Page@1"],
  card: ["Card", "Card@10", "Page@2"],
  head: ["Card", "Card@10", "Page@2"],
  title: ["Card", "Card@10", "Page@2"],
  more: ["IconButton", "IconButton@5", "Card@12", "Page@2"],
  icon: ["IconButton", "IconButton@5", "Card@12", "Page@2"],
  bar: ["IconButton", "IconButton@5", "Card@12", "Page@2"],
  body: ["Card", "Card@10", "Page@2"],
  text: ["Card", "Card@10", "Page@2"],
  card2: ["Card", "Card@20", "Page@2"],
  head2: ["Card", "Card@20", "Page@2"],
  title2: ["Card", "Card@20", "Page@2"],
}

/**
 * A second fixture, used only by the visual-layer cases, with a real layout.
 *
 * The shared fixture above deliberately keeps one box for every element (see
 * `BOXES`), which makes every parent read as coincident — good for pinning the
 * component-boundary stop, useless for pinning anything about extent. So the
 * geometry rules get markup shaped like the page they were written for:
 *
 * - `app` is the `app-root` analogue, and `view` > `hero` > `tagline` is a
 *   component instance inside a wrapper, all four drawing the same pixels.
 * - `bare` > `plain` is that same chain with the component boundary removed,
 *   which is the pre-change failure in miniature.
 * - `panel` is a card: real extent of its own, and two children, so it is a
 *   grouping decision rather than plumbing.
 * - `cta` is a padded button around its label, the case coincidence cannot
 *   carry.
 * - `collapsed` > `pin` is an empty wrapper: zero area, and zero-coincident
 *   with everything else that is zero.
 * - `stage` > `mark` is a sole-child wrapper far bigger than its child, the
 *   case the area cap exists to refuse.
 * - `sheet` > `fill` is a parent a fraction of a pixel off its child, which is
 *   what `SLOP` exists for, with `badge` alongside so sole-childhood cannot
 *   carry the case instead.
 */
const VISUAL_MARKUP = `
<div id="app">
  <div id="view"><section id="hero"><p id="tagline">Ship it</p></section></div>
  <div id="bare"><p id="plain">Same shape, no component</p></div>
  <section id="panel">
    <button id="cta"><span id="cta-label">Set up</span></button>
    <p id="note">Takes a minute</p>
  </section>
  <div id="collapsed"><span id="pin"></span></div>
  <div id="stage"><span id="mark">x</span></div>
  <div id="sheet"><div id="fill">Filled</div><span id="badge">3</span></div>
</div>`

/**
 * One component boundary in the whole second fixture, on purpose: every other
 * stop in those cases has to be earned by geometry, not handed over by
 * `isLayerRoot`. Kept out of `SOURCE` so the reachability case, which walks
 * `Object.keys(SOURCE)`, still means "the shared fixture".
 */
const VISUAL_SOURCE = {
  hero: ["Hero", "Hero@3", "App@1"],
  tagline: ["Hero", "Hero@3", "App@1"],
}

/** `[left, top, width, height]`, in the same coordinates a real page would report. */
const VISUAL_BOXES = {
  app: [0, 0, 1000, 800],
  view: [0, 0, 1000, 800],
  hero: [0, 0, 1000, 800],
  tagline: [0, 0, 1000, 800],
  bare: [0, 0, 1000, 800],
  plain: [0, 0, 1000, 800],
  panel: [40, 600, 600, 160],
  cta: [60, 620, 120, 40],
  // Inset from the button by its padding, which is the entire point: a label
  // and the button around it are never coincident in real markup.
  "cta-label": [70, 630, 100, 20],
  note: [60, 680, 400, 24],
  collapsed: [0, 0, 0, 0],
  pin: [0, 0, 0, 0],
  stage: [0, 0, 800, 400],
  mark: [10, 10, 40, 20],
  sheet: [100, 100, 300, 200],
  // 0.4px off the top of its parent, the sub-pixel drift a flex row produces.
  fill: [100, 100.4, 300, 199.6],
  badge: [380, 104, 16, 16],
}

function elementInfo(element) {
  const entry = element?.id ? (SOURCE[element.id] ?? VISUAL_SOURCE[element.id]) : null
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

/**
 * Declared geometry, because jsdom performs no layout at all.
 *
 * Every rect is 0x0 here unless something says otherwise, and the resolver
 * reads zero area as "hidden" — which would empty the hit stack before any rule
 * ran. So an element with nothing declared gets one uniform 100x100 box, the
 * value the shared fixture and every Level 2 case are written against: with one
 * box for everything, every parent is coincident with every child, so the
 * visual climb there is decided purely by the component boundary.
 *
 * `layout()` overrides that per element. A case that means to test coincidence
 * or area MUST use it — against the uniform box those branches are vacuously
 * true and would pass with the comparison deleted.
 */
const BOXES = new WeakMap()

const box = (left, top, width, height) => ({
  x: left,
  y: top,
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
})

const DEFAULT_BOX = box(0, 0, 100, 100)

const layout = (window, spec) => {
  for (const [name, [left, top, width, height]] of Object.entries(spec)) {
    BOXES.set(window.document.getElementById(name), box(left, top, width, height))
  }
}

function installDom() {
  const dom = new JSDOM(`<!doctype html><html><body>${MARKUP}</body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
  })
  const { window } = dom
  // The resolver hit-tests through `elementsFromPoint`, which jsdom does not
  // implement. Cases hand it the stack they mean directly.
  window.document.elementsFromPoint = () => window.__stack ?? []
  // jsdom has no geometry interfaces either; the drag lane reads the current
  // translate off one, and with no layout every fixture sits at the origin.
  // A fresh object per call, as a real browser returns: callers are entitled to
  // hold one, and handing back the shared default would let one of them edit
  // the geometry every other case reads.
  window.Element.prototype.getBoundingClientRect = function rect() {
    return { ...(BOXES.get(this) ?? DEFAULT_BOX) }
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
    // `navigator` is a getter-only global on Node 24, so plain assignment fails.
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
  }
  return window
}

/**
 * One bundle per call, so anything that must share module state — the store is
 * a module singleton — has to be requested in a single `load`.
 */
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

const id = (window, name) => window.document.getElementById(name)
const nameOf = (element) => element?.id ?? (element === null ? "null" : element.tagName)

// ── Level 1: resolver and keymap ───────────────────────────────────────────

async function resolverCases(window) {
  console.log("\nLevel 1 — resolver")
  const { getResolver, isHidden, isLayerCandidate, toSelectable } = await load(
    `export { getResolver, isHidden, isLayerCandidate, toSelectable } from "./src/core/resolve"`
  )
  const resolver = getResolver({ elementInfo })
  const $ = (name) => id(window, name)

  check("a component instance root is a layer, a bare wrapper is not", () => {
    assert.equal(resolver.isLayerRoot($("card")), true)
    assert.equal(resolver.isLayerRoot($("more")), true)
    assert.equal(resolver.isLayerRoot($("wrap")), false)
    assert.equal(resolver.isLayerRoot($("head")), false)
  })

  check("a layer's name follows its live text, not the text it first had", () => {
    const counter = window.document.createElement("span")
    counter.textContent = "3 items"
    window.document.body.append(counter)
    assert.equal(resolver.meta(counter).name, "3 items")
    counter.textContent = "4 items"
    assert.equal(resolver.meta(counter).name, "4 items", "the stack menu kept the first count")
    counter.remove()
  })

  check("two call sites of one component are two layers", () => {
    assert.equal(resolver.isLayerRoot($("card2")), true)
    assert.notEqual($("card"), $("card2"))
  })

  check("plain click takes the object that was clicked, not the page and not the leaf", () => {
    // This case used to demand `root`, the direct layer child of the scope
    // root. That is Figma's rule, and on this page it meant every plain click
    // anywhere selected the one element wrapping the whole app — `app-root`
    // live, `root` here. Clicking inside a card now selects the card.
    //
    // Every box in this fixture is the same 100x100 stub, so every parent here
    // reads as coincident and the climb would run to `root` on geometry alone.
    // What stops it at the card is the component boundary: `card` is an
    // instance root, `head` and `wrap` are not. The geometry half of the rule
    // is pinned under "visual layer" below, where the boxes are real.
    assert.equal(nameOf(resolver.resolve($("title"), null)), "card")
    assert.notEqual(nameOf(resolver.resolve($("title"), null)), "title")
  })

  check("deep click takes the deepest layer, and an icon is one", () => {
    assert.equal(nameOf(resolver.resolve($("title"), null, true)), "title")
    // Not "more": the `<svg>` is the node the JSX names, so it is where a deep
    // click lands. Only the geometry inside it still resolves up.
    assert.equal(nameOf(resolver.resolve($("bar"), null, true)), "icon")
  })

  check("drilling the scope moves the click one level at a time", () => {
    assert.equal(nameOf(resolver.resolve($("title"), $("root"))), "wrap")
    assert.equal(nameOf(resolver.resolve($("title"), $("wrap"))), "card")
    assert.equal(nameOf(resolver.resolve($("title"), $("card"))), "head")
    assert.equal(nameOf(resolver.resolve($("title"), $("head"))), "title")
  })

  check("a click outside the scope leaves the scope", () => {
    // The claim is unchanged: a hit the scope does not contain falls back to
    // the scope root rather than resolving to nothing, because a click that
    // selects nothing for no visible reason is the worst of the three answers.
    // What the fallback then answers with has changed — the visual rule, so the
    // second card, not the page wrapper above it.
    const found = resolver.resolve($("title2"), $("card"))
    assert.equal(nameOf(found), "card2")
    // The point of the case is that the old scope no longer holds the result.
    assert.equal($("card").contains(found), false)
  })

  check("layer children are the direct selectable HTML graph", () => {
    assert.deepEqual(resolver.layerChildren($("root")).map(nameOf), ["wrap"])
    assert.deepEqual(resolver.layerChildren($("wrap")).map(nameOf), ["card", "card2"])
    assert.deepEqual(resolver.layerChildren($("card")).map(nameOf), ["head", "body"])
    assert.deepEqual(resolver.layerChildren($("more")).map(nameOf), ["icon"])
    // The icon is a leaf: its geometry resolves up to it, so it lists nothing.
    assert.deepEqual(resolver.layerChildren($("icon")).map(nameOf), [])
  })

  check("Enter descends to the first layer child", () => {
    assert.equal(nameOf(resolver.layerChildren($("root"))[0]), "wrap")
  })

  check("Shift+Enter climbs to the enclosing layer", () => {
    assert.equal(nameOf(resolver.layerParent($("card"))), "wrap")
    assert.equal(nameOf(resolver.layerParent($("more"))), "head")
    assert.equal(nameOf(resolver.layerParent($("root"))), "null")
  })

  check("Tab walks siblings at one depth and wraps", () => {
    const siblings = resolver.layerSiblings($("card"))
    assert.deepEqual(siblings.map(nameOf), ["card", "card2"])
    const next = (element, step) => {
      const list = resolver.layerSiblings(element)
      const index = list.indexOf(element)
      return nameOf(list[(index + step + list.length) % list.length])
    }
    assert.equal(next($("card"), 1), "card2")
    assert.equal(next($("card2"), 1), "card")
    assert.equal(next($("card"), -1), "card2")
  })

  check("the `<svg>` is the layer; the geometry inside it is not", () => {
    assert.equal(isLayerCandidate($("icon")), true)
    assert.equal(resolver.resolve($("bar"), null, true), $("icon"))
    assert.equal(toSelectable($("bar")), $("icon"))
    assert.equal(toSelectable($("icon")), $("icon"))
    // The host is still reachable — one level up, exactly as for any parent.
    assert.equal(resolver.layerParent($("icon")), $("more"))
  })

  check("every plain and deep click result is reachable in the layer graph", () => {
    const graph = new Set()
    const visit = (container) => {
      for (const child of resolver.layerChildren(container)) {
        graph.add(child)
        visit(child)
      }
    }
    visit(window.document.body)
    for (const name of Object.keys(SOURCE)) {
      const hit = $(name)
      const plain = resolver.resolve(hit, null)
      const deep = resolver.resolve(hit, null, true)
      if (plain) assert.equal(graph.has(plain), true, `plain ${name}`)
      if (deep) assert.equal(graph.has(deep), true, `deep ${name}`)
    }
  })

  check("a decorative glyph is painted, so `aria-hidden` does not hide it", () => {
    // Every icon this app ships is `aria-hidden="true"` — correct a11y for a
    // glyph a label already names. Reading that as hidden dropped all of them
    // out of the stack menu while the layers tree went on listing them.
    assert.equal($("icon").getAttribute("aria-hidden"), "true")
    assert.equal(isHidden($("icon")), false)
    assert.equal(isHidden($("more")), false)
    $("more").setAttribute("hidden", "")
    assert.equal(isHidden($("more")), true, "the `hidden` attribute still hides")
    $("more").removeAttribute("hidden")
  })

  check("overlap stack dedupes SVG hosts and follows Layers order", () => {
    window.__stack = [$("bar"), $("icon"), $("more"), $("head"), $("card"), $("wrap"), $("root")]
    // `bar` dedupes into the icon above it; the icon itself is its own row.
    assert.deepEqual(
      resolver.hitStack(10, 10).map(nameOf),
      ["root", "wrap", "card", "head", "more", "icon"]
    )
  })

  console.log("\nLevel 1 — visual layer")

  // A fixture of its own, with declared boxes, removed again at the end of the
  // section so the Level 2 canvas lane still mounts over the shared one.
  const holder = window.document.createElement("div")
  holder.innerHTML = VISUAL_MARKUP
  const app = holder.firstElementChild
  window.document.body.append(app)
  layout(window, VISUAL_BOXES)

  check("a plain click inside a component instance selects the instance", () => {
    // `tagline`, `hero`, `view` and `app` all draw exactly the same pixels, so
    // no measurement can separate them. `isLayerRoot` can: the component
    // boundary is the one edge on this walk that the person who wrote the page
    // declared, so it beats every box comparison and the climb stops there.
    assert.equal(nameOf(resolver.resolve($("tagline"), null)), "hero")
  })

  check("with no boundary to stop it the same climb reaches the app root", () => {
    // The pre-change failure, reproduced deliberately: `bare` > `plain` is the
    // chain above with the component taken out, and the answer is `app` — the
    // `app-root` result that made every plain click on the live page select the
    // whole product. It is the honest answer HERE, because nobody declared an
    // object between the word and the page and all of them draw one rectangle.
    // The fix was never "climb less"; it was to stop at a declared boundary.
    assert.equal(nameOf(resolver.resolve($("plain"), null)), "app")
  })

  check("Cmd+click pinpoints the leaf the plain click climbed past", () => {
    const plain = resolver.resolve($("tagline"), null)
    const deep = resolver.resolve($("tagline"), null, true)
    assert.equal(nameOf(deep), "tagline")
    // The pairing the user asked for only exists while these two differ. A deep
    // branch that agreed with the plain one would leave no way into an instance
    // at all, and every other assertion here would still pass.
    assert.notEqual(deep, plain)
    assert.equal(nameOf(plain), "hero")
  })

  check("a padded wrapper around a single child is climbed, not selected", () => {
    const label = $("cta-label")
    const button = $("cta")
    // Padding is the whole case. A `<button>` insets its label, so the two are
    // never coincident, and before the sole-child branch existed a click on
    // "Set up" selected the `<span>` — the one node a designer never means.
    // Asserted, because if these boxes ever became coincident the case would
    // pass through the other branch and prove nothing.
    assert.notEqual(label.getBoundingClientRect().left, button.getBoundingClientRect().left)
    assert.notEqual(label.getBoundingClientRect().right, button.getBoundingClientRect().right)
    assert.equal(nameOf(resolver.resolve(label, null)), "cta")
  })

  check("the climb stops at a parent that groups several children", () => {
    // `panel` is a card holding a button and a note: real extent of its own and
    // more than one child, so it is a grouping decision, not plumbing. Neither
    // child may swallow it — that is the bound on the sole-child climb, and
    // without it a click on a word walks to the whole section.
    assert.equal(nameOf(resolver.resolve($("note"), null)), "note")
    assert.equal(nameOf(resolver.resolve($("cta-label"), null)), "cta")
    // And the card stays reachable by clicking the card, where no child is.
    assert.equal(nameOf(resolver.resolve($("panel"), null)), "panel")
  })

  check("a sole-child wrapper far bigger than its child is not climbed", () => {
    // Sole-childhood alone would swallow this: `mark` is the only child of
    // `stage`, so without the area cap a click on one word would hand back a
    // wrapper 400 times its size, and a chain of such wrappers would walk to
    // the page. Four times the ink is where a wrapper stops being a wrapper.
    const mark = $("mark")
    assert.deepEqual(resolver.layerChildren($("stage")).map(nameOf), ["mark"])
    assert.equal(nameOf(resolver.resolve(mark, null)), "mark")
  })

  check("a parent a fraction of a pixel off its child is still the same object", () => {
    // `sheet` is 0.4px taller than the `fill` inside it, which is what a flex
    // row routinely produces. An exact comparison would stop the climb at the
    // first such wrapper and hand back the inner div — the same class of answer
    // the whole change was made to stop giving.
    const sheet = $("sheet")
    const fill = $("fill")
    assert.notEqual(fill.getBoundingClientRect().top, sheet.getBoundingClientRect().top)
    // Two children, so the sole-child branch cannot be what carries this: the
    // case is coincidence-within-slop or nothing.
    assert.deepEqual(resolver.layerChildren(sheet).map(nameOf), ["fill", "badge"])
    assert.equal(nameOf(resolver.resolve(fill, null)), "sheet")
  })

  check("a zero-area hit answers with itself rather than climbing", () => {
    const pin = $("pin")
    const collapsed = $("collapsed")
    // An empty wrapper and the empty child inside it are coincident by
    // arithmetic — every edge is zero — so the coincidence branch would take
    // the wrapper, and on a page where nothing under the pointer has measured
    // extent that runs all the way up. A hit with no extent has nothing to
    // compare against, so it is its own answer.
    assert.deepEqual(pin.getBoundingClientRect(), collapsed.getBoundingClientRect())
    assert.equal(nameOf(resolver.resolve(pin, null)), "pin")
  })

  check("with a scope active the direct-child-of-scope rule still governs", () => {
    // Drilled in, the original Figma rule takes over unchanged: one click
    // reaches exactly the direct children of the scope, which is the set Enter,
    // Tab and the layers tree can reach from there. If a click could land
    // somewhere the tree cannot, the two surfaces stop describing one model.
    assert.equal(nameOf(resolver.resolve($("tagline"), $("app"))), "view")
    assert.equal(nameOf(resolver.resolve($("cta-label"), $("app"))), "panel")
    // Two rules rather than one rule asserted twice: the same hits resolve
    // elsewhere with no scope held.
    assert.equal(nameOf(resolver.resolve($("tagline"), null)), "hero")
    assert.equal(nameOf(resolver.resolve($("cta-label"), null)), "cta")
  })

  app.remove()

console.log("\nLevel 1 — keymap")
  const keymap = await load(`export * from "./src/core/keymap"`)

  const platform = (value) =>
    Object.defineProperty(window.navigator, "platform", { value, configurable: true })

  check("deep select is Cmd on Mac and never Ctrl", () => {
    platform("MacIntel")
    assert.equal(keymap.isDeepSelect({ metaKey: true, ctrlKey: false }), true)
    assert.equal(keymap.isDeepSelect({ metaKey: false, ctrlKey: true }), false)
  })

  check("deep select is Ctrl elsewhere and never Meta", () => {
    platform("Win32")
    assert.equal(keymap.isDeepSelect({ metaKey: false, ctrlKey: true }), true)
    assert.equal(keymap.isDeepSelect({ metaKey: true, ctrlKey: false }), false)
    platform("MacIntel")
  })

  const key = (init) => new window.KeyboardEvent("keydown", init)

  check("keys map to the documented actions", () => {
    assert.equal(keymap.canvasAction(key({ key: "Escape" })), "deselect")
    assert.equal(keymap.canvasAction(key({ key: "Enter" })), "select-child")
    assert.equal(keymap.canvasAction(key({ key: "Enter", shiftKey: true })), "select-parent")
    assert.equal(keymap.canvasAction(key({ key: "Tab" })), "next-sibling")
    assert.equal(keymap.canvasAction(key({ key: "Tab", shiftKey: true })), "prev-sibling")
    assert.equal(keymap.canvasAction(key({ key: "ArrowLeft" })), "nudge")
    assert.equal(keymap.canvasAction(key({ key: "k" })), null)
  })

  check("Escape never means select-parent", () => {
    assert.notEqual(keymap.canvasAction(key({ key: "Escape", shiftKey: true })), "select-parent")
  })

  check("text entry and chrome keep their own keys", () => {
    const input = window.document.createElement("input")
    const chrome = window.document.createElement("div")
    chrome.setAttribute("data-designlayer", "")
    window.document.body.append(input, chrome)

    const dispatched = (target, init) => {
      let seen = null
      const listen = (event) => {
        seen = keymap.ownsCanvasKeys(event)
      }
      window.addEventListener("keydown", listen, true)
      target.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, ...init }))
      window.removeEventListener("keydown", listen, true)
      return seen
    }
    assert.equal(dispatched(window.document.body, { key: "Enter" }), true)
    assert.equal(dispatched(input, { key: "Enter" }), false)
    assert.equal(dispatched(chrome, { key: "Enter" }), false)

    input.remove()
    chrome.remove()
  })
}

// ── Level 2: the real canvas lane ──────────────────────────────────────────

async function canvasCases(window) {
  console.log("\nLevel 2 — canvas lane")
  const { createContext, installCanvas, installLayersPanel, getState, setState } = await load(`
    export { createContext } from "./src/core/context"
    export { installCanvas } from "./src/canvas/index"
    export { installLayersPanel } from "./src/panels/layers"
    export { getState, setState } from "./src/core/store"
  `)
  const store = { getState, setState }

  const slot = () => {
    const node = window.document.createElement("div")
    node.setAttribute("data-designlayer", "")
    window.document.body.append(node)
    return node
  }
  const bridge = {
    elementInfo,
    toast() {},
    store: {
      getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
      viewportToPage: (x, y) => ({ x, y }),
      pageToViewport: (x, y) => ({ x, y }),
    },
  }
  const context = createContext(bridge, {
    overlay: slot(),
    toolbar: slot(),
    left: slot(),
    right: slot(),
  })
  installCanvas(context)
  installLayersPanel(context)
  context.setTool("move")

  const $ = (name) => id(window, name)
  const selection = () => store.getState().selection.map((entry) => nameOf(entry.element))
  const scope = () => nameOf(store.getState().scope)
  const reset = () => store.setState({ selection: [], scope: null, hovered: null })

  /** jsdom has no layout, so the hit stack is declared rather than measured. */
  const at = (element) => {
    const stack = []
    for (let node = element; node && node !== window.document.body; node = node.parentElement) {
      stack.push(node)
    }
    window.__stack = stack
  }

  const pointer = (element, init = {}) => {
    at(element)
    const options = {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        ...init,
      }
    element.dispatchEvent(new window.PointerEvent("pointerdown", options))
    element.dispatchEvent(new window.PointerEvent("pointerup", options))
  }
  const press = (init) =>
    window.document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, ...init })
    )

  check("a plain click selects the clicked object, not the leaf and not the page", () => {
    reset()
    pointer($("title"))
    // Through the real lane, not just the resolver: `hitFor` -> `targetFor` ->
    // `selectOne`. This asserted `root` while the old rule stood, which is the
    // live `app-root` failure written down as if it were the goal — one click
    // anywhere, the whole app selected, and no modifier-free way to anything.
    assert.deepEqual(selection(), ["card"])
    // Untouched by the change: the click still does not take the leaf.
    assert.notDeepEqual(selection(), ["title"])
  })

  check("Cmd+click selects the exact leaf and re-points the scope", () => {
    reset()
    pointer($("title"), { metaKey: true })
    assert.deepEqual(selection(), ["title"])
    assert.equal(scope(), "head")
  })

  check("Ctrl+click is not deep select on a Mac", () => {
    reset()
    pointer($("title"), { ctrlKey: true })
    // Ctrl is a plain click here, so it answers with the object — the same
    // `card` an unmodified press gives, and pointedly not the `title` that Cmd
    // gives above. Treating Ctrl as deep on a Mac breaks nothing loudly; it
    // just makes Control-click (which is a right-click here) select a leaf.
    assert.deepEqual(selection(), ["card"])
    assert.notDeepEqual(selection(), ["title"])
  })

  check("double-click drills exactly one level", () => {
    reset()
    pointer($("title"))
    at($("title"))
    $("title").dispatchEvent(
      new window.MouseEvent("dblclick", { bubbles: true, clientX: 10, clientY: 10 })
    )
    // One level, counted from wherever the click landed. The click now lands on
    // the card, so one level in is its head — the count is the claim, not the
    // names, and a drill that moved two levels would still be a bug.
    assert.equal(scope(), "card")
    assert.deepEqual(selection(), ["head"])
  })

  check("double-clicking SVG geometry drills to the icon, then stops", () => {
    reset()
    pointer($("bar"), { metaKey: true })
    // Deep click takes the icon itself, and the scope follows its parent.
    assert.deepEqual(selection(), ["icon"])
    assert.equal(scope(), "more")
    at($("bar"))
    $("bar").dispatchEvent(
      new window.MouseEvent("dblclick", { bubbles: true, clientX: 10, clientY: 10 })
    )
    // The icon is the floor: there is no layer below it to drill into.
    assert.deepEqual(selection(), ["icon"])
    assert.equal(scope(), "more")
  })

  check("shift+click toggles rather than only appending", () => {
    reset()
    pointer($("title"))
    // The two cards are separate objects at the top scope now, where the old
    // rule collapsed both clicks onto the page wrapper. So the toggle has to be
    // shown the other way round: add the second card, then take it back out by
    // clicking it again. Append-only would leave two selected.
    pointer($("title2"), { shiftKey: true })
    assert.deepEqual(selection(), ["card", "card2"])
    pointer($("title2"), { shiftKey: true })
    assert.deepEqual(selection(), ["card"])
    store.setState({ selection: [], scope: id(window, "wrap") })
    pointer($("title"), { shiftKey: true })
    pointer($("title2"), { shiftKey: true })
    assert.deepEqual(selection(), ["card", "card2"])
    pointer($("title"), { shiftKey: true })
    assert.deepEqual(selection(), ["card2"])
  })

  check("Enter selects the first child and takes the scope with it", () => {
    reset()
    pointer($("title"))
    press({ key: "Enter" })
    // Enter descends from whatever is selected, so the new starting point moves
    // the answer one level down with it: card -> its head. The scope must
    // follow, or the next plain click would climb back out of the descent.
    assert.deepEqual(selection(), ["head"])
    assert.equal(scope(), "card")
  })

  check("Shift+Enter selects the parent", () => {
    reset()
    pointer($("title"))
    press({ key: "Enter" })
    press({ key: "Enter", shiftKey: true })
    // Back up to the card, and the scope up to the card's parent. The old case
    // happened to end at the top of the tree, where the scope is null; this one
    // ends in the middle, which is the case that can actually go wrong — a
    // scope left pointing at the layer you just left traps the next click.
    assert.deepEqual(selection(), ["card"])
    assert.equal(scope(), "wrap")
  })

  check("Tab and Shift+Tab walk siblings", () => {
    reset()
    pointer($("title"))
    press({ key: "Enter" })
    press({ key: "Enter" })
    // Two Enters from the card reach the title, whose siblings inside the head
    // are [title, more]. A shallower start would have walked the two cards; the
    // claim is the walk at one depth, not which depth.
    press({ key: "Tab" })
    assert.deepEqual(selection(), ["more"])
    press({ key: "Tab", shiftKey: true })
    assert.deepEqual(selection(), ["title"])
  })

  check("a click outside a drilled scope leaves it", () => {
    reset()
    pointer($("title"))
    // One Enter reaches the state the old case needed three for: scope on the
    // card, selection inside it. The click then lands in the OTHER card, which
    // the scope does not contain.
    press({ key: "Enter" })
    assert.equal(scope(), "card")
    pointer($("title2"))
    // It used to land on the page wrapper, because that was all a click outside
    // the scope could reach. It lands on the card that was clicked now, and the
    // scope re-points to that card's parent — what matters either way is that
    // the scope did not stay on the card the user just clicked out of, which
    // would leave the next click resolving against a container it is not in.
    assert.deepEqual(selection(), ["card2"])
    assert.equal(scope(), "wrap")
    assert.notEqual(scope(), "card")
  })

  check("Shift+drag is reachable over full-bleed content and toggles swept layers", () => {
    reset()
    pointer($("title"))
    // Same drilled state as before the change — scope on the card, head
    // selected — reached in one Enter rather than three, because the click
    // starts a level deeper.
    press({ key: "Enter" })
    assert.deepEqual(selection(), ["head"])
    assert.equal(scope(), "card")
    at($("title"))
    $("title").dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true, button: 0, clientX: 10, clientY: 10, shiftKey: true,
      })
    )
    $("title").dispatchEvent(
      new window.PointerEvent("pointermove", {
        bubbles: true, button: 0, clientX: 30, clientY: 30, shiftKey: true,
      })
    )
    $("title").dispatchEvent(
      new window.PointerEvent("pointerup", {
        bubbles: true, button: 0, clientX: 30, clientY: 30, shiftKey: true,
      })
    )
    assert.deepEqual(selection(), ["body"])
  })

  check("Escape deselects and exits the scope, it does not select the parent", () => {
    reset()
    pointer($("title"), { metaKey: true })
    assert.equal(scope(), "head")
    press({ key: "Escape" })
    assert.deepEqual(selection(), [])
    assert.equal(scope(), "null")
  })

  check("hover answers with the same target a click would", () => {
    reset()
    at($("title"))
    $("title").dispatchEvent(
      new window.PointerEvent("pointermove", { bubbles: true, clientX: 10, clientY: 10 })
    )
    // Hover and click go through one `targetFor`, so the outline traces the
    // card the click would take — and follows a held modifier down to the leaf
    // and back up on release. An outline that answered the old rule while the
    // click answered the new one is the exact failure this guards: nothing
    // throws, the highlight simply promises the wrong element.
    assert.equal(nameOf(store.getState().hovered), "card")
    press({ key: "Meta", metaKey: true })
    assert.equal(nameOf(store.getState().hovered), "title")
    window.document.body.dispatchEvent(
      new window.KeyboardEvent("keyup", { bubbles: true, key: "Meta", metaKey: false })
    )
    assert.equal(nameOf(store.getState().hovered), "card")
  })

  check("Cmd over chrome previews nothing, never the app root", () => {
    reset()
    // The toolbar floats over the app, so the app's whole ancestry is under it
    // too — and `hitStack` sorts parent first, which outlined the root.
    const bar = window.document.createElement("div")
    bar.setAttribute("data-designlayer", "")
    window.document.body.append(bar)
    at($("title"))
    window.__stack = [bar, ...window.__stack]
    bar.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, clientX: 10, clientY: 10 }))
    press({ key: "Meta", metaKey: true })
    assert.equal(store.getState().hovered, null)
    window.document.body.dispatchEvent(
      new window.KeyboardEvent("keyup", { bubbles: true, key: "Meta", metaKey: false })
    )
    assert.equal(store.getState().hovered, null)
    bar.remove()
  })

  check("clicking empty background clears both selection and scope", () => {
    reset()
    pointer($("title"), { metaKey: true })
    window.__stack = []
    window.document.body.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 999,
        clientY: 999,
      })
    )
    window.document.body.dispatchEvent(
      new window.PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 999,
        clientY: 999,
      })
    )
    assert.deepEqual(selection(), [])
    assert.equal(scope(), "null")
  })

  check("right-click is left to the layer-stack menu", () => {
    reset()
    pointer($("title"), { button: 2 })
    assert.deepEqual(selection(), [])
  })

  check("overlap menu follows Layers order and Escape closes only the menu", () => {
    reset()
    pointer($("title"))
    const invoker = window.document.createElement("button")
    window.document.body.append(invoker)
    invoker.focus()
    window.document.documentElement.style.setProperty("--de-left", "240px")
    window.document.documentElement.style.setProperty("--de-right", "260px")
    at($("bar"))
    $("bar").dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })
    )
    const menu = window.document.querySelector(".de-layer-menu")
    const rows = Array.from(menu.querySelectorAll(".de-layer-menu-row"))
    assert.equal(menu.style.display, "block")
    assert.equal(menu.style.left, "248px")
    assert.equal(rows[0].textContent, "Page")
    // The icon is the deepest row now. It has no component boundary of its own
    // in this fixture, so it reads by tag, the same as any unnamed layer.
    assert.equal(rows.at(-2).textContent, "IconButton")
    assert.equal(rows.at(-1).textContent, "svg")
    assert.equal(window.document.activeElement, rows[0])
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }))
    assert.equal(window.document.activeElement, rows.at(-1))
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    assert.equal(menu.style.display, "none")
    assert.equal(window.document.activeElement, invoker)
    // Closing the menu returns focus and nothing else: the selection is still
    // whatever the click before it made, which is now the card.
    assert.deepEqual(selection(), ["card"])
    window.document.documentElement.style.removeProperty("--de-left")
    window.document.documentElement.style.removeProperty("--de-right")
    invoker.remove()
  })

  check("keyboard layer-menu activation restores invocation focus", () => {
    reset()
    const invoker = window.document.createElement("button")
    window.document.body.append(invoker)
    invoker.focus()
    at($("bar"))
    $("bar").dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })
    )
    const menu = window.document.querySelector(".de-layer-menu")
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }))
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    assert.equal(menu.style.display, "none")
    assert.equal(window.document.activeElement, invoker)
    invoker.remove()
  })

  check("Layers highlights every selected row", () => {
    context.selectMany([$("card"), $("title")])
    const selectedRows = Array.from(
      context.slots.left.querySelectorAll('.de-layer[aria-selected="true"]')
    )
    assert.equal(selectedRows.length, 2)
    assert.deepEqual(
      selectedRows.map((row) => row.querySelector(".de-layer-name").textContent),
      ["Card", "Homecoming"]
    )
  })
}

// ── Run ────────────────────────────────────────────────────────────────────

const window = installDom()
Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true })

await resolverCases(window)
await canvasCases(window)

console.log(`\n${passed} passed, ${failed} failed`)
// Installed DOM listeners intentionally live for the editor session.
process.exit(failed > 0 ? 1 : 0)
