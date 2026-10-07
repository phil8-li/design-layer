/**
 * Putting a component on the page: where it lands, and what gets written.
 *
 * Insertion is the first operation in this editor that ADDS markup, and nothing
 * that came before it is shaped for that. Delete could preview itself, because
 * the element was already on screen and `display: none` is a convincing lie.
 * An insertion has nothing to preview against — a node that is not in the source
 * has no source — so it goes straight to disk and waits for hot reload, which
 * means every mistake it makes is a mistake in the user's repository.
 *
 * Two halves, asserted separately and against the real thing:
 *
 *   Placement — `dropTargetAt` in JSDOM, against synthetic containers whose
 *               `getBoundingClientRect` is stubbed per element, because JSDOM
 *               lays nothing out and a drop index is arithmetic over rects.
 *   The write — `POST /source/insert` over a real `http.createServer` on
 *               127.0.0.1 with a real project directory behind it, the same
 *               harness `library-store-cases.mjs` and `delete-cases.mjs` use.
 *               The loopback guard in `routes.mjs` reads `req.socket` and the
 *               `Host` header, so a hand-rolled request object would be testing
 *               a guard that never runs.
 *
 * What is worth pinning, and why each one is a way "it respects auto-layout"
 * becomes quietly false:
 *
 *  - **placement is six separate branches, not one.** Column, row, reverse,
 *    grid, empty and chrome each take a different path through the resolver, and
 *    five of them produce a plausible-looking answer when they are wrong. The
 *    reverse case is the sharpest: a resolver that forgets to invert returns
 *    index 0 where the answer is 3, and the component appears at the opposite
 *    end of the row from where the pointer was. The fixtures put the reversed
 *    container's children at reversed COORDINATES, which is what a browser does
 *    and what makes the naive answer visibly different from the right one;
 *  - **markup is source code.** `markup` arrives from a page and is written into
 *    a file the user will commit. It is validated by an allowlist rather than an
 *    escape, and the five refusals below are the shapes an escape would let
 *    through: a script tag, a braced expression (a template binding on Angular,
 *    an arbitrary JS expression on React), a second top-level element, an
 *    unquoted attribute value, and something long enough to be a payload rather
 *    than an element. Each must be a 400 — a refusal the panel can explain —
 *    rather than a 500 or, worse, a partial write;
 *  - **the import is not cosmetic.** Markup spliced into a file that does not
 *    import the symbol compiles to an error on React and renders as an unknown
 *    element on Angular, and in both cases the designer sees "nothing happened"
 *    with no way to find out why. Adding it TWICE is the same defect wearing a
 *    different hat, which is why the React case inserts the same component a
 *    second time and counts the import lines;
 *  - **Angular needs two edits, not one.** A standalone component's template can
 *    name `<harbour-button>` all it likes; without the symbol in
 *    `@Component({ imports: [...] })` Angular renders nothing and logs a warning
 *    most people never see. A template-only splice is the single most likely way
 *    to ship this half-working.
 *
 * Every fixture here is invented for this file — two throwaway projects written
 * under `os.tmpdir()` and deleted afterwards. Nothing is copied from any real
 * design system.
 *
 * Usage: node designlayer/test/insert-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { JSDOM } from "jsdom"

import { resolveConfig } from "../config.mjs"
import { createDesignLayerRoutes } from "../server/routes.mjs"

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

/* -------------------------------------------------------------------------
 * Placement
 * ---------------------------------------------------------------------- */

const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom

/**
 * One rect per element, because the whole of placement is arithmetic over them.
 *
 * The shared harness stubs `getBoundingClientRect` to a single constant box,
 * which is exactly right for a file that never measures anything and exactly
 * useless here: every child would share a midpoint and every index would be 0.
 * An element nobody registered measures zero rather than inheriting a neighbour's
 * box, so a resolver that reaches for something the fixture did not place gets
 * an obviously wrong answer instead of a plausible one.
 */
const RECTS = new WeakMap()
const ZERO = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
window.Element.prototype.getBoundingClientRect = function box() {
  return RECTS.get(this) ?? ZERO
}
window.Element.prototype.scrollIntoView = function scroll() {}
for (const name of ["setPointerCapture", "releasePointerCapture"]) {
  window.Element.prototype[name] = function capture() {}
}
window.Element.prototype.hasPointerCapture = function held() {
  return false
}
window.document.elementsFromPoint = () => window.__stack ?? []
globalThis.DOMMatrixReadOnly = class {
  constructor() {
    this.m41 = 0
    this.m42 = 0
  }
}

globalThis.__DESIGNLAYER_CONFIG__ = {
  apiBase: "/__designlayer",
  designSystem: {
    name: "Host",
    trackingUnit: "em",
    colors: [],
    spacing: [],
    radii: [],
    textStyles: [],
    uiTextStyles: [],
    effects: [],
    icons: [],
    motion: [],
    responsiveMeasures: [],
    aliases: { cssVariables: [], tailwind: [] },
  },
  icons: { attribute: "", available: false },
  host: { framework: "react", tailwind: true },
}

for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement",
  "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
  "SVGElement", "SVGSVGElement",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, {
    value: key === "getComputedStyle" ? window.getComputedStyle.bind(window) : window[key],
    configurable: true,
    writable: true,
  })
}

/*
 * The browser half must not reach a network, and the server half must.
 *
 * `insert.ts` posts to `/source/insert` the moment a drop commits, so the
 * gesture cases need a fetch that answers without one. The loopback cases need
 * the real thing — so it is captured here first and used explicitly below,
 * rather than restored later and hoped for.
 */
const realFetch = globalThis.fetch
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ applied: [], failed: [] }),
})
window.fetch = globalThis.fetch

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createContext } from "./src/core/context"
      export { beginAssetDrag, dropTargetAt, showDropIndicator } from "./src/libraries/insert"
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

const setRect = (node, [left, top, width, height]) => {
  RECTS.set(node, {
    x: left, y: top, left, top,
    right: left + width, bottom: top + height,
    width, height,
  })
  return node
}

/**
 * A container with a stubbed box and children with stubbed boxes.
 *
 * The children hold text and nothing else on purpose: step 2 of the resolution
 * walks UP past a node whose only content is text, and a fixture whose children
 * were empty divs would never exercise that walk — the pointer would land on the
 * container directly and the case would pass against a resolver that has no
 * walk at all.
 */
const container = (style, rect, kids = []) => {
  const node = window.document.createElement("div")
  node.setAttribute("style", style)
  setRect(node, rect)
  for (const [text, childRect] of kids) {
    const child = window.document.createElement("div")
    child.textContent = text
    setRect(child, childRect)
    node.append(child)
  }
  window.document.getElementById("app").append(node)
  return node
}

const COLUMN = container("display:flex;flex-direction:column;padding:10px", [0, 0, 200, 300], [
  ["A", [10, 10, 180, 80]],
  ["B", [10, 90, 180, 80]],
  ["C", [10, 170, 180, 80]],
])

const ROW = container("display:flex;flex-direction:row;padding:10px", [0, 400, 300, 100], [
  ["A", [10, 410, 90, 80]],
  ["B", [100, 410, 90, 80]],
  ["C", [190, 410, 90, 80]],
])

/*
 * `row-reverse`, with the children placed where a browser would place them.
 *
 * DOM order is A, B, C; painted order is C, B, A. A resolver that compares the
 * pointer against DOM-ordered midpoints answers 0 at x=30 and 3 at x=290 — the
 * exact reverse of the truth — so these two numbers are the case.
 */
const REVERSE = container("display:flex;flex-direction:row-reverse;padding:10px", [0, 600, 300, 100], [
  ["A", [190, 610, 90, 80]],
  ["B", [100, 610, 90, 80]],
  ["C", [10, 610, 90, 80]],
])

const GRID = container("display:grid;grid-template-columns:1fr 1fr", [0, 800, 200, 200], [
  ["A", [0, 800, 100, 100]],
  ["B", [100, 800, 100, 100]],
  ["C", [0, 900, 100, 100]],
  ["D", [100, 900, 100, 100]],
])

const RAIL = container("display:grid;grid-template-columns:1fr", [400, 800, 100, 200], [
  ["A", [400, 800, 100, 100]],
  ["B", [400, 900, 100, 100]],
])

const EMPTY = container("display:block;padding:8px", [20, 1100, 160, 120], [])

/** The editor's own chrome, which a drop must never resolve into. */
const CHROME = window.document.createElement("div")
CHROME.setAttribute("data-designlayer", "")
setRect(CHROME, [600, 0, 260, 800])
const CHROME_INNER = window.document.createElement("button")
CHROME_INNER.textContent = "Insert instance"
setRect(CHROME_INNER, [620, 40, 200, 32])
CHROME.append(CHROME_INNER)
window.document.body.append(CHROME)

/**
 * What `elementsFromPoint` would return at this point, deepest first.
 *
 * Built from the fixture's own rects rather than hand-written per case, so the
 * stack a case exercises is the stack the geometry implies — and so a case that
 * moves a pointer past the last child stops passing a child that is not there.
 */
const stackAt = (node, x, y) => {
  const kid = Array.from(node.children).find((child) => {
    const rect = child.getBoundingClientRect()
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  })
  return kid ? [kid, node] : [node]
}

const at = (node, x, y) => {
  window.__stack = stackAt(node, x, y)
  return editor.dropTargetAt(x, y)
}

const indexAt = (node, x, y) => at(node, x, y)?.index

console.log("\nWhere a pointer would put a component")

await check("a column flex container indexes on each child's vertical midpoint", () => {
  // Children occupy 10..90, 90..170, 170..250; their midpoints are 50, 130, 210.
  assert.equal(indexAt(COLUMN, 100, 30), 0, "above the first midpoint is not index 0")
  assert.equal(indexAt(COLUMN, 100, 150), 2, "between the second and third midpoints is not index 2")
  assert.equal(indexAt(COLUMN, 100, 280), 3, "past the last child is not an append")
  assert.equal(at(COLUMN, 100, 150).axis, "column")
  assert.equal(at(COLUMN, 100, 150).container, COLUMN, "the resolver stopped on the text child")
})

await check("a row flex container does the same thing horizontally", () => {
  // Children occupy 10..100, 100..190, 190..280; their midpoints are 55, 145, 235.
  assert.equal(indexAt(ROW, 30, 450), 0)
  assert.equal(indexAt(ROW, 160, 450), 2)
  assert.equal(indexAt(ROW, 290, 450), 3)
  assert.equal(at(ROW, 160, 450).axis, "row")
})

await check("row-reverse inverts the index it would otherwise give", () => {
  // Painted C, B, A left to right. At the far left the insertion point is AFTER
  // the last DOM child; at the far right it is before the first.
  assert.equal(indexAt(REVERSE, 30, 650), 3, "the reverse direction was not honoured")
  assert.equal(indexAt(REVERSE, 290, 650), 0, "the reverse direction was not honoured")
  assert.equal(indexAt(REVERSE, 160, 650), 1)
  assert.equal(at(REVERSE, 160, 650).axis, "row", "row-reverse is not a row")
})

await check("a grid reads as a row when it has more than one column", () => {
  assert.equal(at(GRID, 25, 825).axis, "row")
  assert.equal(indexAt(GRID, 25, 825), 0)
  // And the other half of the same branch: one column is a column.
  assert.equal(at(RAIL, 450, 825).axis, "column")
})

await check("an empty container is index 0 and an outline of its content box", () => {
  const target = at(EMPTY, 100, 1160)
  assert.ok(target, "an empty container is not a drop target at all")
  assert.equal(target.container, EMPTY)
  assert.equal(target.index, 0)
  // The content box: the container's own box inset by its 8px padding. An
  // outline rather than a 2px line, because there is no boundary to draw.
  assert.deepEqual(
    { x: target.rect.x, y: target.rect.y, width: target.rect.width, height: target.rect.height },
    { x: 28, y: 1108, width: 144, height: 104 }
  )
})

/*
 * The indicator's geometry, which is the half of `DropTarget` the user sees.
 *
 * Only the cross-axis extent and the 2px thickness are pinned: §5 fixes those
 * exactly ("a 2px line … spanning the container's cross-axis content box, inset
 * by its padding") and says nothing precise about where in the gap the line
 * sits, so the main-axis coordinate is checked for being inside the container
 * and no further.
 */
await check("the indicator rect is a 2px line across the container's content box", () => {
  const column = at(COLUMN, 100, 150).rect
  assert.equal(column.height, 2, "the column indicator is not a 2px line")
  assert.equal(column.x, 10, "the column indicator ignores the container's padding")
  assert.equal(column.width, 180, "the column indicator does not span the content box")
  assert.ok(column.y >= 0 && column.y <= 300, `the indicator is outside the container: y=${column.y}`)

  const row = at(ROW, 160, 450).rect
  assert.equal(row.width, 2, "the row indicator is not a 2px line")
  assert.equal(row.y, 410, "the row indicator ignores the container's padding")
  assert.equal(row.height, 80, "the row indicator does not span the content box")
  assert.ok(row.x >= 0 && row.x <= 300, `the indicator is outside the container: x=${row.x}`)
})

/*
 * The editor's own panels are not a drop zone.
 *
 * §5 step 1 says to discard chrome and resolve from the deepest element left,
 * and §6 says a pointer over chrome yields no target at all. Those only agree
 * if `document.body` and `documentElement` are discarded too — which is exactly
 * what `isCanvasElement` in `src/core/dom.ts` already does, and is why §5 says
 * to use it rather than re-derive it. This case asserts §6's version.
 */
await check("a pointer over the editor's own chrome resolves to nothing", () => {
  window.__stack = [CHROME_INNER, CHROME, window.document.body, window.document.documentElement]
  assert.equal(editor.dropTargetAt(700, 50), null, "the editor's own panel accepted a drop")

  window.__stack = []
  assert.equal(editor.dropTargetAt(5000, 5000), null, "empty space resolved to a target")
})

/* -------------------------------------------------------------------------
 * The gesture
 * ---------------------------------------------------------------------- */

console.log("\nDragging a card onto the page")

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
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

const overlay = slot()
const context = editor.createContext(bridge, {
  overlay,
  toolbar: slot(),
  left: slot(),
  right: slot(),
})

/**
 * What Lane M hands the drag.
 *
 * §5 names the type `PlaceableComponent` and never defines it, so this is a
 * library component entry plus the popover's chosen values — the only shape the
 * two lanes' contracts together imply. If the drag needs more than this, that is
 * a gap in §5 rather than a fixture that is too thin.
 */
const PLACEABLE = {
  id: "component:button",
  name: "Button",
  group: "Buttons",
  file: "src/ui/harbour/buttons/Button.tsx",
  exportName: "Button",
  defaultExport: false,
  snippet: '<Button variant="filled" />',
  props: [{ name: "variant", values: ["filled", "tonal"], default: "filled" }],
  values: { variant: "filled" },
  library: "src-ui-harbour",
  libraryName: "Harbour UI",
}

const CARD = window.document.createElement("button")
CARD.setAttribute("data-designlayer", "")
CARD.setAttribute("data-de-asset", "card")
setRect(CARD, [620, 200, 220, 96])
CHROME.append(CARD)

const pointer = (type, x, y) =>
  new window.PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerId: 1,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    bubbles: true,
    cancelable: true,
  })

/** Presses the card and hands the press to `beginAssetDrag`, as Lane M would. */
function press(x, y) {
  const event = pointer("pointerdown", x, y)
  CARD.addEventListener("pointerdown", (received) => {
    editor.beginAssetDrag(context, PLACEABLE, received)
  }, { once: true })
  CARD.dispatchEvent(event)
}

const move = (node, x, y) => {
  window.__stack = node ? stackAt(node, x, y) : []
  window.dispatchEvent(pointer("pointermove", x, y))
}

const release = (x, y) => window.dispatchEvent(pointer("pointerup", x, y))
const escape = () =>
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))

/** The overlay's resting size, so a case counts what the gesture added. */
const BASE = overlay.children.length

await check("a press that never travels 4px stays a click", () => {
  press(700, 240)
  move(null, 702, 241)
  move(null, 703, 242)
  assert.equal(
    overlay.children.length,
    BASE,
    "a 3px twitch on a card started a drag, so a click can never be a click"
  )
  release(703, 242)
  assert.equal(overlay.children.length, BASE)
})

await check("past the threshold the drag mounts into the overlay, and Escape takes it back", () => {
  press(700, 240)
  move(null, 703, 240)
  assert.equal(overlay.children.length, BASE, "the threshold was crossed at 3px")
  move(COLUMN, 100, 150)
  assert.ok(overlay.children.length > BASE, "a drag past 4px put nothing in the overlay")

  escape()
  assert.equal(overlay.children.length, BASE, "Escape did not cancel the drag")
  release(100, 150)
})

await check("the indicator paints into the overlay and never takes the pointer", () => {
  press(700, 240)
  move(COLUMN, 100, 150)
  const added = Array.from(overlay.children).slice(BASE)
  assert.ok(added.length > 0, "the drag mounted nothing")

  editor.showDropIndicator(at(COLUMN, 100, 150))
  assert.ok(overlay.children.length > BASE, "showDropIndicator mounted nothing in the overlay")

  /*
   * Asserted as CSS text rather than measured. JSDOM parses a stylesheet and
   * lays out nothing, so `getComputedStyle().pointerEvents` here only ever
   * reports an inline value — an assertion on it would pass on an indicator that
   * swallows every pointermove in a real browser, which is the exact failure
   * that makes a drop impossible to complete.
   */
  assert.match(
    editor.shellCss,
    /\.de-insert-[^{}]*\{[^}]*pointer-events:\s*none/s,
    "no .de-insert- rule takes the indicator out of the pointer's way"
  )

  editor.showDropIndicator(null)
  /*
   * `de-insert-indicator`, not `de-insert-`.
   *
   * The drag is deliberately still in flight here — nothing is released until
   * two lines down — so the ghost is still mounted and still called
   * `de-insert-ghost`, which the looser prefix also matched. The assertion was
   * reading "the drag is still running" as "the indicator did not come down",
   * and failing on the one thing this case is not about.
   */
  const indicators = Array.from(overlay.children).filter((node) =>
    /de-insert-indicator/.test(node.className ?? "")
  )
  assert.deepEqual(indicators, [], "showDropIndicator(null) left the indicator painted")

  escape()
  release(100, 150)
})

/* -------------------------------------------------------------------------
 * The write
 * ---------------------------------------------------------------------- */

const NG_TEMPLATE = `<section class="panel">
  <h2 class="panel__title">Overview</h2>
  <p class="panel__body">Body copy</p>
  <app-icon class="panel__icon" name="star" />
  <div class="panel__actions">
    <a class="panel__link">More</a>
  </div>
</section>
`

const NG_CLASS = `import { Component } from '@angular/core';
import { PanelHeaderComponent } from '../panel-header/panel-header.component';

@Component({
  selector: 'app-panel',
  standalone: true,
  imports: [PanelHeaderComponent],
  templateUrl: './panel.component.html',
})
export class PanelComponent {}
`

const NG_LIBRARY = `import { Component } from '@angular/core';

@Component({ selector: 'harbour-button', standalone: true, template: '<button></button>' })
export class HarbourButtonComponent {}
`

function angularProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-insert-ng-"))
  const write = (relative, contents) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents, "utf8")
    return file
  }
  write("package.json", JSON.stringify({ name: "host", dependencies: { "@angular/core": "^22.0.0" } }))
  write("src/app/panel/panel.component.ts", NG_CLASS)
  write("src/app/panel/panel.component.html", NG_TEMPLATE)
  write("src/ui/harbour-button.component.ts", NG_LIBRARY)
  return { root, write }
}

const PAGE_TSX = `import { Panel } from "../ui/panel"

export default function Page() {
  return (
    <main className="page">
      <h1 className="page__title">Overview</h1>
      <section className="panel">
        <p className="panel__body">Body</p>
      </section>
    </main>
  )
}
`

/**
 * A component's own file, which is where the two refusals below happen.
 *
 * Its root `<span>` is the element a component returns — nothing may sit
 * beside it — and it DECLARES `Badge`, so an insert of `<Badge/>` into it must
 * not be given `import { Badge } from "./badge"`.
 */
const BADGE_TSX = `export const Badge = ({ label = "" }) => (
  <span className="badge">
    <em className="badge__text">{label}</em>
  </span>
)
`

/** A file that declares a `Card` of its own, unrelated to `src/app/Card.tsx`. */
const TILE_TSX = `function Card() {
  return <b />
}

export function Tile() {
  return (
    <div className="tile">
      <p className="tile__body">Body</p>
    </div>
  )
}
`

function reactProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-insert-react-"))
  const write = (relative, contents) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents, "utf8")
    return file
  }
  write("package.json", JSON.stringify({ name: "host", dependencies: { next: "^15.0.0", react: "^19.0.0" } }))
  write("src/app/page.tsx", PAGE_TSX)
  write("src/app/Card.tsx", "export function Card() {\n  return <div />\n}\n")
  write("src/ui/panel.tsx", "export function Panel() {\n  return <div />\n}\n")
  write("src/ui/harbour/Button.tsx", "export function HarbourButton() {\n  return <button />\n}\n")
  write("src/ui/badge.tsx", BADGE_TSX)
  write("src/app/tile.tsx", TILE_TSX)
  return { root, write }
}

async function serve(config) {
  const routes = createDesignLayerRoutes(config)
  const server = http.createServer((request, response) => {
    if (routes.handle(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}${config.apiPrefix}`
  return {
    base,
    insert: async (operations) => {
      const response = await realFetch(`${base}/source/insert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operations }),
      })
      const body = await response.json().catch(() => null)
      return { status: response.status, body: body ?? {} }
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * The `{ applied, failed }` a successful request owes, or a failure that names
 * what came back instead.
 *
 * Spelled once because the alternative reads badly when the route is missing:
 * `body.applied.length` on a 404 throws "cannot read properties of undefined",
 * which is true and tells nobody that the endpoint is not there.
 */
function wrote(result, expected = 1) {
  assert.equal(
    result.status,
    200,
    `the route answered ${result.status}: ${result.body?.message ?? JSON.stringify(result.body)}`
  )
  assert.ok(
    Array.isArray(result.body?.applied) && Array.isArray(result.body?.failed),
    `the reply is not { applied, failed }: ${JSON.stringify(result.body)}`
  )
  assert.equal(
    result.body.applied.length,
    expected,
    result.body.failed[0]?.reason ?? `${result.body.applied.length} operations applied`
  )
  return result.body
}

const target = (tagName, classes, extra = {}) => ({
  tagName,
  classes,
  id: null,
  nthOfType: 0,
  parentTagName: "section",
  parentClasses: ["panel"],
  attributes: {},
  ...extra,
})

/** The line holding `needle`, and the line after it, with indentation intact. */
const linesAround = (text, needle) => {
  const lines = text.split("\n")
  const index = lines.findIndex((line) => line.includes(needle))
  assert.ok(index >= 0, `no line contains ${needle}`)
  return { index, lines }
}

// ── Angular ────────────────────────────────────────────────────────────────

console.log("\nSplicing into an Angular template")

{
  const { root } = angularProject()
  const template = path.join(root, "src/app/panel/panel.component.html")
  const klass = path.join(root, "src/app/panel/panel.component.ts")
  const config = resolveConfig({ projectRoot: root }, { cwd: root })
  const server = await serve(config)

  const restore = () => {
    fs.writeFileSync(template, NG_TEMPLATE, "utf8")
    fs.writeFileSync(klass, NG_CLASS, "utf8")
  }
  const html = () => fs.readFileSync(template, "utf8")
  const ts = () => fs.readFileSync(klass, "utf8")

  const insert = (position, reference, extra = {}) =>
    server.insert([
      {
        op: "insertElement",
        componentName: "PanelComponent",
        filePath: null,
        target: reference,
        position,
        markup: '<harbour-button variant="filled">Save</harbour-button>',
        import: {
          from: "src/ui/harbour-button.component.ts",
          name: "HarbourButtonComponent",
          defaultImport: false,
        },
        ...extra,
      },
    ])

  await check("an insert after a node lands on the next line, at the node's indentation", async () => {
    restore()
    const result = wrote(await insert("after", target("p", ["panel__body"])))
    assert.deepEqual(result.failed, [])

    const { index, lines } = linesAround(html(), 'class="panel__body"')
    assert.equal(
      lines[index + 1],
      '  <harbour-button variant="filled">Save</harbour-button>',
      `the splice is not indented to the reference node: ${JSON.stringify(lines[index + 1])}`
    )
    // Everything else stands exactly as it was.
    assert.match(html(), /<h2 class="panel__title">Overview<\/h2>/)
    assert.match(html(), /<a class="panel__link">More<\/a>/)
  })

  await check("an insert before a node lands on the line above it", async () => {
    restore()
    wrote(await insert("before", target("p", ["panel__body"])))
    const { index, lines } = linesAround(html(), 'class="panel__body"')
    assert.equal(lines[index - 1], '  <harbour-button variant="filled">Save</harbour-button>')
  })

  await check("prepend and append go inside the reference node's content", async () => {
    restore()
    const actions = target("div", ["panel__actions"])
    wrote(await insert("prepend", actions))
    let { index, lines } = linesAround(html(), 'class="panel__actions"')
    assert.equal(
      lines[index + 1],
      '    <harbour-button variant="filled">Save</harbour-button>',
      `prepend did not land as the first child: ${JSON.stringify(lines[index + 1])}`
    )
    assert.match(lines[index + 2], /panel__link/, "prepend displaced the existing child")

    restore()
    wrote(await insert("append", actions))
    ;({ index, lines } = linesAround(html(), 'class="panel__link"'))
    assert.equal(
      lines[index + 1],
      '    <harbour-button variant="filled">Save</harbour-button>',
      `append did not land as the last child: ${JSON.stringify(lines[index + 1])}`
    )
    assert.match(lines[index + 2], /<\/div>/, "append landed outside the reference node")
  })

  await check("a self-closing reference node refuses to hold children", async () => {
    restore()
    const icon = target("app-icon", ["panel__icon"], { attributes: { name: "star" } })
    for (const position of ["prepend", "append"]) {
      const refusal = wrote(await insert(position, icon), 0)
      assert.equal(refusal.failed.length, 1, `${position} into a self-closing node was applied`)
      assert.ok(
        typeof refusal.failed[0].reason === "string" && refusal.failed[0].reason.length > 0,
        "the refusal carries no reason"
      )
    }
    assert.equal(html(), NG_TEMPLATE, "a refused insert still rewrote the template")
  })

  /*
   * The edit that a template-only splice forgets.
   *
   * Angular resolves `<harbour-button>` against the standalone component's own
   * `imports` array, so a template naming a symbol the class does not import
   * renders nothing — and the only signal is a console warning during dev.
   */
  await check("a standalone component gains the symbol in its imports array", async () => {
    restore()
    wrote(await insert("after", target("p", ["panel__body"])))

    assert.match(
      ts(),
      /import\s*\{[^}]*\bHarbourButtonComponent\b[^}]*\}\s*from\s*['"][^'"]+['"]/,
      "the class file never imported the symbol"
    )
    const array = /imports:\s*\[([^\]]*)\]/.exec(ts())
    assert.ok(array, "the @Component imports array is gone")
    assert.match(array[1], /\bHarbourButtonComponent\b/, "the symbol is not in imports: [...]")
    assert.match(array[1], /\bPanelHeaderComponent\b/, "the existing import was replaced, not joined")
  })

  // ── Markup safety ────────────────────────────────────────────────────────

  console.log("\nWhat may become source code")

  /*
   * An allowlist, not an escape, and these are the five shapes that prove it.
   *
   * Every one of them is a 400 rather than a `failed` entry, because a refusal
   * the server made BEFORE touching a file is a different fact from a splice it
   * tried and could not place — the panel says "that markup is not allowed"
   * instead of "something went wrong".
   */
  const REFUSED = [
    ["a script tag", '<script>fetch("/steal")</script>'],
    ["a braced expression", '<harbour-button label="{{ user.token }}"></harbour-button>'],
    ["two top-level elements", "<harbour-button></harbour-button><harbour-input></harbour-input>"],
    ["an unquoted attribute value", "<harbour-button variant=filled></harbour-button>"],
    ["a string longer than the cap", `<harbour-button label="${"x".repeat(2100)}"></harbour-button>`],
  ]

  for (const [what, markup] of REFUSED) {
    await check(`${what} is refused with a 400, before any file is opened`, async () => {
      restore()
      const { status } = await server.insert([
        {
          op: "insertElement",
          componentName: "PanelComponent",
          filePath: null,
          target: target("p", ["panel__body"]),
          position: "after",
          markup,
        },
      ])
      assert.equal(status, 400, `${what} answered ${status}`)
      assert.equal(html(), NG_TEMPLATE, `${what} still reached the template`)
    })
  }

  await check("an ordinary element with a quoted attribute and text is accepted", async () => {
    restore()
    wrote(
      await server.insert([
        {
          op: "insertElement",
          componentName: "PanelComponent",
          filePath: null,
          target: target("p", ["panel__body"]),
          position: "after",
          markup: '<app-button variant="filled">Label</app-button>',
        },
      ])
    )
    assert.match(html(), /<app-button variant="filled">Label<\/app-button>/)
  })

  await check("more than fifty operations in one request is refused", async () => {
    restore()
    const one = {
      op: "insertElement",
      componentName: "PanelComponent",
      filePath: null,
      target: target("p", ["panel__body"]),
      position: "after",
      markup: "<harbour-button></harbour-button>",
    }
    assert.equal((await server.insert(Array.from({ length: 51 }, () => ({ ...one })))).status, 400)
    assert.equal(html(), NG_TEMPLATE, "a refused batch still reached the template")
  })

  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

// ── React ──────────────────────────────────────────────────────────────────

console.log("\nSplicing into a React file")

{
  const { root } = reactProject()
  const page = path.join(root, "src/app/page.tsx")
  const config = resolveConfig({ projectRoot: root }, { cwd: root })
  const server = await serve(config)

  const restore = () => fs.writeFileSync(page, PAGE_TSX, "utf8")
  const tsx = () => fs.readFileSync(page, "utf8")
  const occurrences = (pattern) => (tsx().match(pattern) ?? []).length

  const body = target("p", ["panel__body"])

  const insertButton = (position = "after") =>
    server.insert([
      {
        op: "insertElement",
        componentName: "Page",
        filePath: "src/app/page.tsx",
        target: body,
        position,
        markup: '<HarbourButton variant="filled">Save</HarbourButton>',
        import: { from: "src/ui/harbour/Button.tsx", name: "HarbourButton", defaultImport: false },
      },
    ])

  await check("the JSX lands at the reference node's indentation", async () => {
    restore()
    wrote(await insertButton("after"))

    const { index, lines } = linesAround(tsx(), 'className="panel__body"')
    assert.equal(
      lines[index + 1],
      '        <HarbourButton variant="filled">Save</HarbourButton>',
      `the splice is not indented to the reference node: ${JSON.stringify(lines[index + 1])}`
    )
    assert.match(lines[index + 2], /<\/section>/, "the splice left the section")
  })

  /*
   * The specifier rule, spelled out in §2 and easy to get almost right:
   * relative to the RECEIVING file, POSIX separators, no extension. `from`
   * arrives as Lane P's project-relative `file`, extension and all.
   */
  await check("the ES import is added once, relative to the receiving file", async () => {
    restore()
    wrote(await insertButton())
    assert.match(
      tsx(),
      /import\s*\{\s*HarbourButton\s*\}\s*from\s*["']\.\.\/ui\/harbour\/Button["']/,
      `the import is missing or not relative to src/app: ${tsx().split("\n")[0]}`
    )
    assert.equal(occurrences(/HarbourButton/g) >= 2, true)

    wrote(await insertButton())
    assert.equal(
      occurrences(/^import .*HarbourButton.*$/gm),
      1,
      "the second insert added the import a second time"
    )
    assert.equal(occurrences(/<HarbourButton /g), 2, "the second insert did not splice")
  })

  await check("a sibling file's specifier is prefixed ./ and a default import has no braces", async () => {
    restore()
    wrote(
      await server.insert([
        {
          op: "insertElement",
          componentName: "Page",
          filePath: "src/app/page.tsx",
          target: body,
          position: "before",
          markup: "<Card />",
          import: { from: "src/app/Card.tsx", name: "Card", defaultImport: true },
        },
      ])
    )
    assert.match(
      tsx(),
      /import\s+Card\s+from\s*["']\.\/Card["']/,
      "a same-directory default import is not `import Card from \"./Card\"`"
    )
    const { index, lines } = linesAround(tsx(), 'className="panel__body"')
    assert.equal(lines[index - 1], "        <Card />")
  })

  await check("prepend and append reach inside the reference node", async () => {
    restore()
    const section = target("section", ["panel"], {
      parentTagName: "main",
      parentClasses: ["page"],
    })
    const place = (position) =>
      server.insert([
        {
          op: "insertElement",
          componentName: "Page",
          filePath: "src/app/page.tsx",
          target: section,
          position,
          markup: "<HarbourButton />",
          import: { from: "src/ui/harbour/Button.tsx", name: "HarbourButton", defaultImport: false },
        },
      ])

    wrote(await place("prepend"))
    let { index, lines } = linesAround(tsx(), '<section className="panel">')
    assert.equal(lines[index + 1], "        <HarbourButton />")

    restore()
    wrote(await place("append"))
    ;({ index, lines } = linesAround(tsx(), 'className="panel__body"'))
    assert.equal(lines[index + 1], "        <HarbourButton />")
    assert.match(lines[index + 2], /<\/section>/)
  })

  /*
   * Partial success is a real outcome. One operation naming an element nobody
   * can place must not take the one beside it down with it, because the whole
   * batch then reads as "insertion is broken".
   */
  await check("an element nobody can place fails on its own, not as a 400", async () => {
    restore()
    const result = wrote(
      await server.insert([
        {
          op: "insertElement",
          componentName: "Page",
          filePath: "src/app/page.tsx",
          target: target("footer", ["nope"]),
          position: "after",
          markup: "<HarbourButton />",
        },
        {
          op: "insertElement",
          componentName: "Page",
          filePath: "src/app/page.tsx",
          target: body,
          position: "after",
          markup: "<HarbourButton />",
        },
      ])
    )
    assert.equal(result.failed.length, 1, "one unplaceable element did not fail on its own")
    assert.match(tsx(), /<HarbourButton \/>/)
  })

  /*
   * The two ways an insertion has been seen to write a file that no longer
   * compiles. Both were one drop of a library component onto a page, and both
   * took the whole module down — the dev server answers 500, every page that
   * imports it goes blank, and the editor the designer was using is inside one
   * of them. So each is a refusal with a reason, not a write to undo later.
   */
  const badge = path.join(root, "src/ui/badge.tsx")
  const badgeTsx = () => fs.readFileSync(badge, "utf8")
  const insertBadge = (position, reference) =>
    server.insert([
      {
        op: "insertElement",
        componentName: "Badge",
        filePath: "src/ui/badge.tsx",
        target: reference,
        position,
        markup: "<Badge />",
        import: { from: "src/ui/badge.tsx", name: "Badge", defaultImport: false },
      },
    ])

  await check("a component dropped into its own file is not imported from itself", async () => {
    fs.writeFileSync(badge, BADGE_TSX, "utf8")
    wrote(
      await insertBadge(
        "after",
        target("em", ["badge__text"], { parentTagName: "span", parentClasses: ["badge"] })
      )
    )
    assert.doesNotMatch(
      badgeTsx(),
      /^import\b/m,
      `the file was given an import of itself:\n${badgeTsx()}`
    )
    assert.match(badgeTsx(), /^\s+<Badge \/>$/m, "the markup was not spliced in")
  })

  await check("nothing is placed beside an element with no parent element", async () => {
    fs.writeFileSync(badge, BADGE_TSX, "utf8")
    const result = wrote(
      await insertBadge("before", target("span", ["badge"], { parentTagName: null, parentClasses: [] })),
      0
    )
    assert.equal(result.failed.length, 1, "inserting beside a root element was not refused")
    assert.match(result.failed[0].reason, /nothing can sit beside it/)
    assert.equal(badgeTsx(), BADGE_TSX, "a refused insert still wrote the file")
  })

  await check("a name the file already declares is not imported from another module", async () => {
    const tile = path.join(root, "src/app/tile.tsx")
    fs.writeFileSync(tile, TILE_TSX, "utf8")
    const result = wrote(
      await server.insert([
        {
          op: "insertElement",
          componentName: "Tile",
          filePath: "src/app/tile.tsx",
          target: target("p", ["tile__body"], { parentTagName: "div", parentClasses: ["tile"] }),
          position: "after",
          markup: "<Card />",
          import: { from: "src/app/Card.tsx", name: "Card", defaultImport: false },
        },
      ]),
      0
    )
    assert.equal(result.failed.length, 1, "a duplicate declaration was written rather than refused")
    assert.match(result.failed[0].reason, /already declared in tile\.tsx/)
    assert.equal(fs.readFileSync(tile, "utf8"), TILE_TSX, "a refused insert still wrote the file")
  })

  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
