/**
 * Auto layout spacing handles: the padding and gap bands on a selected flex
 * container, the drag rules, and the one write a drag commits.
 *
 * jsdom lays nothing out, so every box comes from a `data-rect` attribute
 * ("left,top,right,bottom"). The geometry and drag rules are pure and are
 * checked directly; the last group drives the installed handles with pointer
 * events through the real writer.
 *
 * Usage: node test/spacing-handles-cases.mjs
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

const dom = new JSDOM('<!doctype html><html><body><main id="app"></main><div id="overlay"></div></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom

window.Element.prototype.getBoundingClientRect = function box() {
  const [left, top, right, bottom] = (this.getAttribute("data-rect") ?? "0,0,0,0").split(",").map(Number)
  return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top }
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
for (const key of ["addEventListener", "removeEventListener"]) {
  Object.defineProperty(globalThis, key, { value: window[key].bind(window), configurable: true, writable: true })
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export * from "./src/canvas/spacing-handles"
      export { createWriter } from "./src/core/writer"
      export * as history from "./src/core/history"
      export * as store from "./src/core/store"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "silent",
})
const lib = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)
const { spacingZones, zoneAt, dragValues, changedWrites, readSpacing, snap, history } = lib

const sides = (top, right, bottom, left) => ({ top, right, bottom, left })
const zero = sides(0, 0, 0, 0)
const box = (left, top, right, bottom) => ({ left, top, right, bottom })

/** A 300x100 row: 1px border, padding 10 / 20 (y / x), three 40px children 12px apart. */
const row = {
  box: box(0, 0, 300, 100),
  border: sides(1, 1, 1, 1),
  padding: sides(10, 20, 10, 20),
  axis: "x",
  wrap: false,
  gap: 12,
  children: [box(21, 11, 61, 89), box(73, 11, 113, 89), box(125, 30, 165, 70)],
}

const padding = (zones, side) => zones.find((zone) => zone.side === side)
const gaps = (zones) => zones.filter((zone) => zone.kind === "gap")

console.log("\nZones")

await check("SH-01 padding bands sit inside the border, one per side", () => {
  const zones = spacingZones(row)
  assert.deepEqual(padding(zones, "left").band, box(1, 1, 21, 99))
  assert.deepEqual(padding(zones, "right").band, box(279, 1, 299, 99))
  assert.deepEqual(padding(zones, "top").band, box(1, 1, 299, 11))
  assert.deepEqual(padding(zones, "bottom").band, box(1, 89, 299, 99))
  assert.equal(padding(zones, "left").value, 20)
  assert.equal(padding(zones, "top").value, 10)
})

await check("SH-02 the padding handle sits at the middle of the band's inner edge", () => {
  const zones = spacingZones(row)
  assert.deepEqual(padding(zones, "left").handle, { x: 21, y: 50, axis: "x" })
  assert.deepEqual(padding(zones, "right").handle, { x: 279, y: 50, axis: "x" })
  assert.deepEqual(padding(zones, "top").handle, { x: 150, y: 11, axis: "y" })
})

await check("SH-03 a row has a gap band between each pair of children, across the content box", () => {
  const found = gaps(spacingZones(row))
  assert.equal(found.length, 2)
  assert.deepEqual(found[0].band, box(61, 11, 73, 89))
  assert.deepEqual(found[1].band, box(113, 11, 125, 89))
  assert.deepEqual(found[0].handle, { x: 67, y: 50, axis: "x" })
  assert.equal(found[0].value, 12)
})

await check("SH-04 a column's gaps run along y and drag on y", () => {
  const column = {
    ...row,
    box: box(0, 0, 100, 300),
    padding: sides(16, 8, 16, 8),
    axis: "y",
    gap: 6,
    children: [box(9, 17, 91, 57), box(9, 63, 91, 103)],
  }
  const [gap] = gaps(spacingZones(column))
  assert.deepEqual(gap.band, box(9, 57, 91, 63))
  assert.deepEqual(gap.handle, { x: 50, y: 60, axis: "y" })
})

await check("SH-05 a reversed row still pairs neighbours", () => {
  const reversed = { ...row, children: row.children.slice().reverse() }
  assert.deepEqual(gaps(spacingZones(reversed)).map((zone) => zone.band.left).sort(), [113, 61].sort())
})

await check("SH-06 wrapped children on two lines have no gap between the lines' ends", () => {
  const wrapped = {
    ...row,
    wrap: true,
    children: [box(21, 11, 141, 41), box(153, 11, 273, 41), box(21, 50, 141, 80), box(153, 50, 200, 80)],
  }
  const found = gaps(spacingZones(wrapped))
  assert.equal(found.length, 2)
  // A wrapped line's band spans its pair, not the whole content box.
  assert.deepEqual(found[0].band, box(141, 11, 153, 41))
  assert.deepEqual(found[1].band, box(141, 50, 153, 80))
})

await check("SH-07 a zero padding still answers hover over 8px, and its handle clears the resize handle", () => {
  const flush = { ...row, border: zero, padding: zero, children: [box(0, 0, 100, 100), box(110, 0, 200, 100)] }
  const left = padding(spacingZones(flush), "left")
  assert.deepEqual(left.band, box(0, 0, 0, 100))
  assert.deepEqual(left.hit, box(0, 0, 8, 100))
  assert.equal(left.handle.x, 11, "the handle overlaps the edge's resize handle")
})

await check("SH-08 a zero gap still answers hover over 8px around the seam", () => {
  const touching = { ...row, gap: 0, children: [box(21, 11, 61, 89), box(61, 11, 101, 89)] }
  const [gap] = gaps(spacingZones(touching))
  assert.deepEqual(gap.hit, box(57, 11, 65, 89))
})

await check("SH-09 zoneAt finds padding, gaps, and nothing over a child", () => {
  const zones = spacingZones(row)
  assert.equal(zoneAt(zones, 10, 50).side, "left")
  assert.equal(zoneAt(zones, 290, 50).side, "right")
  assert.equal(zoneAt(zones, 150, 5).side, "top")
  assert.equal(zoneAt(zones, 67, 50).kind, "gap")
  assert.equal(zoneAt(zones, 40, 50), null)
  assert.equal(zoneAt(zones, 400, 50), null)
})

await check("SH-10 in a corner the side whose edge is nearer wins", () => {
  const zones = spacingZones(row)
  // 2px from the left edge of a 20px band, 8px into a 10px top band.
  assert.equal(zoneAt(zones, 3, 9).side, "left")
  // 18px into the left band, 1px into the top band.
  assert.equal(zoneAt(zones, 19, 2).side, "top")
})

console.log("\nReading the element")

const app = window.document.getElementById("app")
function mount(html) {
  app.innerHTML = html
  return app.firstElementChild
}

await check("SH-11 readSpacing reads a flex row and skips absolute and hidden children", () => {
  const element = mount(`
    <div data-rect="0,0,300,100" style="display:flex; gap:12px; padding:10px 20px; border:1px solid">
      <span data-rect="21,11,61,89"></span>
      <span data-rect="5,5,15,15" style="position:absolute"></span>
      <span data-rect="0,0,0,0" style="display:none"></span>
      <span data-rect="73,11,113,89"></span>
    </div>`)
  const input = readSpacing(element)
  assert.equal(input.axis, "x")
  assert.equal(input.gap, 12)
  assert.deepEqual(input.padding, sides(10, 20, 10, 20))
  assert.deepEqual(input.border, sides(1, 1, 1, 1))
  assert.equal(input.children.length, 2)
})

await check("SH-12 readSpacing reads a column's row-gap", () => {
  const element = mount(`
    <div data-rect="0,0,100,300" style="display:flex; flex-direction:column; row-gap:6px; column-gap:40px">
      <span data-rect="0,0,100,40"></span><span data-rect="0,46,100,86"></span>
    </div>`)
  const input = readSpacing(element)
  assert.equal(input.axis, "y")
  assert.equal(input.gap, 6)
})

await check("SH-13 a block, a grid, or a childless flex box gets no handles", () => {
  assert.equal(readSpacing(mount('<div style="display:block"><span></span></div>')), null)
  assert.equal(readSpacing(mount('<div style="display:grid"><span></span></div>')), null)
  assert.equal(readSpacing(mount('<div style="display:flex">text only</div>')), null)
})

console.log("\nDrag rules")

const start = { padding: sides(10, 20, 10, 20), gap: 12 }
const leftZone = { kind: "padding", side: "left", handle: { axis: "x" } }
const none = { alt: false, shift: false }

await check("SH-14 dragging a handle into the box grows its padding", () => {
  assert.deepEqual(dragValues(leftZone, start, { dx: 16, dy: 0 }, none), { "padding-left": 36 })
  assert.deepEqual(dragValues({ kind: "padding", side: "right", handle: { axis: "x" } }, start, { dx: -5, dy: 0 }, none), { "padding-right": 25 })
  assert.deepEqual(dragValues({ kind: "padding", side: "top", handle: { axis: "y" } }, start, { dx: 0, dy: 4 }, none), { "padding-top": 14 })
  assert.deepEqual(dragValues({ kind: "padding", side: "bottom", handle: { axis: "y" } }, start, { dx: 0, dy: 4 }, none), { "padding-bottom": 6 })
})

await check("SH-15 Alt sets both sides on the axis, Alt+Shift all four", () => {
  assert.deepEqual(dragValues(leftZone, start, { dx: 4, dy: 0 }, { alt: true, shift: false }), { "padding-left": 24, "padding-right": 24 })
  assert.deepEqual(dragValues(leftZone, start, { dx: 4, dy: 0 }, { alt: true, shift: true }), {
    "padding-top": 24,
    "padding-right": 24,
    "padding-bottom": 24,
    "padding-left": 24,
  })
  // Shift alone changes nothing about which sides move.
  assert.deepEqual(dragValues(leftZone, start, { dx: 4, dy: 0 }, { alt: false, shift: true }), { "padding-left": 24 })
})

await check("SH-16 values snap to whole pixels and never go below 0", () => {
  assert.deepEqual(dragValues(leftZone, start, { dx: 3.6, dy: 0 }, none), { "padding-left": 24 })
  assert.deepEqual(dragValues(leftZone, { ...start, padding: sides(0, 0, 0, 7.5) }, { dx: 0.2, dy: 0 }, none), { "padding-left": 8 })
  assert.deepEqual(dragValues(leftZone, start, { dx: -50, dy: 0 }, none), { "padding-left": 0 })
  assert.equal(snap(-3), 0)
})

await check("SH-17 a gap grows along the main axis and clamps at 0", () => {
  const gapX = { kind: "gap", handle: { axis: "x" } }
  const gapY = { kind: "gap", handle: { axis: "y" } }
  assert.deepEqual(dragValues(gapX, start, { dx: 8, dy: 30 }, none), { gap: 20 })
  assert.deepEqual(dragValues(gapY, start, { dx: 30, dy: -20 }, none), { gap: 0 })
})

await check("SH-18 only changed properties are written, as px", () => {
  assert.deepEqual(changedWrites(start, { "padding-left": 20, "padding-right": 24 }), [{ property: "padding-right", value: "24px" }])
  assert.deepEqual(changedWrites(start, { gap: 12 }), [])
})

console.log("\nThe installed handles")

const queued = []
const bridge = {
  elementInfo: () => null,
  send() {},
  toast() {},
  subscribe: () => () => {},
  store: {
    hasChanges: () => queued.length > 0,
    buildBatchOperations: () => queued.map((entry) => entry.operation),
    addPendingPropertyOperation: (mergeKey, operation, keys) => queued.push({ mergeKey, operation, keys }),
  },
}
const overlay = window.document.getElementById("overlay")
overlay.setAttribute("data-designlayer", "")
let refreshes = 0
const context = {
  slots: { overlay },
  getState: lib.store.getState,
  subscribe: lib.store.subscribe,
  refresh: () => {
    refreshes += 1
  },
  onRefresh: () => () => {},
}
lib.installSpacingHandles(context, lib.createWriter(bridge))

const frame = () => new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 0)))
const fire = (target, type, init = {}) =>
  target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init }))
const handle = () => overlay.querySelector(".de-space-handle")
const badge = () => overlay.querySelector(".de-space-badge")
const shownBands = () => [...overlay.querySelectorAll(".de-space-band")].filter((node) => node.style.display !== "none")

let keys = 0
function selectCard() {
  const element = mount(`
    <div class="flex gap-3 px-5 py-2.5" data-rect="0,0,300,100" style="display:flex; gap:12px; padding:10px 20px">
      <span data-rect="20,10,60,90"></span><span data-rect="72,10,112,90"></span>
    </div>`)
  keys += 1
  const selection = {
    element,
    tagName: "div",
    componentName: "Card",
    source: { filePath: "src/Card.tsx", lineNumber: 4, columnNumber: 2, componentName: "Card" },
    key: `card-${keys}`,
  }
  history.resetHistory()
  queued.length = 0
  refreshes = 0
  lib.store.setState({ selection: [selection], tool: "move", hovered: null })
  return element
}

await check("SH-19 hovering the left padding shows its band, the handle and the value", async () => {
  selectCard()
  fire(app, "pointermove", { clientX: 8, clientY: 50, buttons: 0 })
  await frame()
  assert.equal(shownBands().length, 1)
  assert.equal(handle().style.display, "flex")
  assert.equal(handle().style.cursor, "ew-resize")
  assert.equal(badge().textContent, "20")
})

await check("SH-19b the handle's outer half, past the band, keeps the zone", async () => {
  selectCard()
  fire(app, "pointermove", { clientX: 8, clientY: 50, buttons: 0 })
  await frame()
  // The left band ends at x 20; the handle's 8px hit box runs 16 to 24.
  fire(handle(), "pointermove", { clientX: 23, clientY: 50, buttons: 0 })
  await frame()
  assert.equal(handle().style.display, "flex")
  assert.equal(handle().dataset.zone, "left")
})

await check("SH-20 hovering the gap shows the gap band with ew-resize in a row", async () => {
  selectCard()
  fire(app, "pointermove", { clientX: 66, clientY: 50, buttons: 0 })
  await frame()
  assert.equal(handle().dataset.zone, "gap")
  assert.equal(handle().style.cursor, "ew-resize")
  assert.equal(badge().textContent, "12")
})

await check("SH-21 over a child, or with two elements selected, nothing shows", async () => {
  const element = selectCard()
  fire(app, "pointermove", { clientX: 40, clientY: 50, buttons: 0 })
  await frame()
  assert.equal(handle().style.display, "none")
  const other = { ...lib.store.getState().selection[0], key: "other", element: element.firstElementChild }
  lib.store.setState({ selection: [lib.store.getState().selection[0], other] })
  fire(app, "pointermove", { clientX: 8, clientY: 50, buttons: 0 })
  await frame()
  assert.equal(handle().style.display, "none")
  assert.equal(shownBands().length, 0)
})

await check("SH-22 a drag previews live and commits one write on release", async () => {
  const element = selectCard()
  fire(app, "pointermove", { clientX: 8, clientY: 50, buttons: 0 })
  await frame()
  fire(handle(), "pointerdown", { clientX: 20, clientY: 50 })
  fire(handle(), "pointermove", { clientX: 28, clientY: 50, buttons: 1 })
  assert.equal(element.style.paddingLeft, "28px", "the drag did not preview")
  fire(handle(), "pointermove", { clientX: 36, clientY: 50, buttons: 1 })
  assert.equal(element.style.paddingLeft, "36px")
  assert.equal(queued.length, 0, "a preview frame reached source")
  fire(handle(), "pointerup", { clientX: 36, clientY: 50 })

  assert.equal(queued.length, 1)
  assert.deepEqual(queued[0].keys, ["padding-left"])
  assert.match(JSON.stringify(queued[0].operation), /"tailwindPrefix":"pl","tailwindToken":"9"/)
  assert.equal(element.style.paddingLeft, "36px")
  assert.equal(refreshes, 1)
  assert.equal(history.undo(), "Padding")
  assert.equal(history.canUndo(), false, "one drag recorded more than one step")
  assert.equal(element.style.paddingLeft, "20px", "undo did not put the padding back")
})

await check("SH-23 Alt+drag writes both sides in one step; Alt+Shift writes all four", async () => {
  const element = selectCard()
  fire(app, "pointermove", { clientX: 8, clientY: 50, buttons: 0 })
  await frame()
  fire(handle(), "pointerdown", { clientX: 20, clientY: 50, altKey: true })
  fire(handle(), "pointermove", { clientX: 24, clientY: 50, buttons: 1, altKey: true })
  fire(handle(), "pointerup", { clientX: 24, clientY: 50 })
  assert.equal(queued.length, 1)
  assert.deepEqual(queued[0].keys.sort(), ["padding-left", "padding-right"])
  assert.equal(element.style.paddingRight, "24px")
  assert.equal(history.undo(), "Padding")
  assert.equal(history.canUndo(), false)

  selectCard()
  fire(app, "pointermove", { clientX: 8, clientY: 50, buttons: 0 })
  await frame()
  fire(handle(), "pointerdown", { clientX: 20, clientY: 50, altKey: true, shiftKey: true })
  fire(handle(), "pointermove", { clientX: 24, clientY: 50, buttons: 1, altKey: true, shiftKey: true })
  fire(handle(), "pointerup", { clientX: 24, clientY: 50 })
  assert.deepEqual(queued[0].keys.sort(), ["padding-bottom", "padding-left", "padding-right", "padding-top"])
})

await check("SH-24 letting go of Alt mid-drag puts the other side back", async () => {
  const element = selectCard()
  fire(app, "pointermove", { clientX: 8, clientY: 50, buttons: 0 })
  await frame()
  fire(handle(), "pointerdown", { clientX: 20, clientY: 50, altKey: true })
  fire(handle(), "pointermove", { clientX: 26, clientY: 50, buttons: 1, altKey: true })
  assert.equal(element.style.paddingRight, "26px")
  fire(handle(), "pointermove", { clientX: 26, clientY: 50, buttons: 1, altKey: false })
  assert.equal(element.style.paddingRight, "20px")
  fire(handle(), "pointerup", { clientX: 26, clientY: 50 })
  assert.deepEqual(queued[0].keys, ["padding-left"])
})

await check("SH-25 a gap drag writes `gap`", async () => {
  const element = selectCard()
  fire(app, "pointermove", { clientX: 66, clientY: 50, buttons: 0 })
  await frame()
  fire(handle(), "pointerdown", { clientX: 66, clientY: 50 })
  fire(handle(), "pointermove", { clientX: 70, clientY: 50, buttons: 1 })
  fire(handle(), "pointerup", { clientX: 70, clientY: 50 })
  assert.equal(element.style.gap, "16px")
  assert.equal(queued.length, 1)
  assert.match(JSON.stringify(queued[0].operation), /"tailwindPrefix":"gap","tailwindToken":"4"/)
})

await check("SH-26 a press without travel, or a cancelled drag, writes nothing", async () => {
  const element = selectCard()
  fire(app, "pointermove", { clientX: 8, clientY: 50, buttons: 0 })
  await frame()
  fire(handle(), "pointerdown", { clientX: 20, clientY: 50 })
  fire(handle(), "pointerup", { clientX: 20, clientY: 50 })
  assert.equal(queued.length, 0)
  assert.equal(history.canUndo(), false)

  fire(handle(), "pointerdown", { clientX: 20, clientY: 50 })
  fire(handle(), "pointermove", { clientX: 40, clientY: 50, buttons: 1 })
  fire(handle(), "pointercancel", {})
  assert.equal(queued.length, 0)
  assert.equal(element.getAttribute("style"), "display:flex; gap:12px; padding:10px 20px", "the cancel left a preview behind")
})

await check("SH-27 interactive mode hides the handles", async () => {
  selectCard()
  lib.store.setState({ interactive: true })
  fire(app, "pointermove", { clientX: 8, clientY: 50, buttons: 0 })
  await frame()
  assert.equal(handle().style.display, "none")
  lib.store.setState({ interactive: false })
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
