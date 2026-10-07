/**
 * Spacing-measurement cases for DesignLayer.
 *
 * `canvas/measure` decides what Option/Alt-hover shows between the selection
 * and the hovered element. Its failures are all silent: a line drawn at the
 * wrong height, a gap measured from the wrong edge, or a stray zero-length
 * badge still renders, so nothing but exact geometry catches them. Each case
 * pins one branch of Figma's rule — a gap with and without cross overlap,
 * containment both ways, partial overlap, touching and identical boxes — plus
 * the badge format.
 */

import assert from "node:assert/strict"

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

const { measureSpacing, formatDistance } = await load(
  `export { measureSpacing, formatDistance } from "./src/canvas/measure"`
)

const box = (left, top, right, bottom) => ({ left, top, right, bottom })
const hline = (x, y, length) => ({ axis: "x", x, y, length, value: length })
const vline = (x, y, length) => ({ axis: "y", x, y, length, value: length })
const hext = (x, y, length) => ({ axis: "x", x, y, length })
const vext = (x, y, length) => ({ axis: "y", x, y, length })

const selected = box(0, 0, 100, 100)

console.log("\nmeasureSpacing — gaps")

check("target to the right with y-overlap: one line at the overlap center, no guide", () => {
  assert.deepEqual(measureSpacing(selected, box(150, 20, 250, 80)), {
    lines: [hline(100, 50, 50)],
    extensions: [],
  })
})

check("y-overlap center is the overlap's center, not the selection's", () => {
  assert.deepEqual(measureSpacing(selected, box(130, 60, 200, 160)).lines, [hline(100, 80, 30)])
})

check("target to the left mirrors the right-hand gap", () => {
  assert.deepEqual(measureSpacing(selected, box(-90, 20, -40, 80)), {
    lines: [hline(-40, 50, 40)],
    extensions: [],
  })
})

check("diagonal: both gaps at the selection's centers, a dashed guide to each near edge", () => {
  assert.deepEqual(measureSpacing(selected, box(150, 160, 250, 260)), {
    lines: [hline(100, 50, 50), vline(50, 100, 60)],
    extensions: [vext(150, 50, 110), hext(50, 160, 100)],
  })
})

check("diagonal up-left: guides run to the target's bottom/right edges", () => {
  assert.deepEqual(measureSpacing(selected, box(-100, -80, -20, -30)), {
    lines: [hline(-20, 50, 20), vline(50, -30, 30)],
    extensions: [vext(-20, -30, 80), hext(-20, -30, 70)],
  })
})

check("target above: one vertical line at the x-overlap center, no x lines", () => {
  assert.deepEqual(measureSpacing(selected, box(20, -80, 80, -30)), {
    lines: [vline(50, -30, 30)],
    extensions: [],
  })
})

console.log("\nmeasureSpacing — containment and overlap")

check("target contains selected: four lines crossing the selection's center", () => {
  assert.deepEqual(measureSpacing(box(50, 20, 110, 60), box(0, 0, 200, 100)), {
    lines: [hline(0, 40, 50), hline(110, 40, 90), vline(80, 0, 20), vline(80, 60, 40)],
    extensions: [],
  })
})

check("selected contains target: four lines crossing the target's center", () => {
  assert.deepEqual(measureSpacing(box(0, 0, 200, 100), box(50, 20, 110, 60)), {
    lines: [hline(0, 40, 50), hline(110, 40, 90), vline(80, 0, 20), vline(80, 60, 40)],
    extensions: [],
  })
})

check("containment sharing an edge drops the zero line", () => {
  assert.deepEqual(measureSpacing(box(0, 20, 110, 60), box(0, 0, 200, 100)).lines, [
    hline(110, 40, 90),
    vline(55, 0, 20),
    vline(55, 60, 40),
  ])
})

check("partial overlap: four edge offsets at the intersection's center", () => {
  assert.deepEqual(measureSpacing(selected, box(30, 40, 150, 120)), {
    lines: [hline(0, 70, 30), hline(100, 70, 50), vline(65, 0, 40), vline(65, 100, 20)],
    extensions: [],
  })
})

check("x-overlap but separated on y: no x offsets", () => {
  const { lines } = measureSpacing(selected, box(30, 150, 150, 200))
  assert.deepEqual(lines, [vline(65, 100, 50)])
})

console.log("\nmeasureSpacing — nothing to show")

check("touching edges: gap 0 draws no line", () => {
  assert.deepEqual(measureSpacing(selected, box(100, 20, 200, 80)), { lines: [], extensions: [] })
})

check("sub-half-pixel gap draws no line", () => {
  assert.deepEqual(measureSpacing(selected, box(100.4, 20, 200, 80)), { lines: [], extensions: [] })
})

check("identical boxes: empty measurement", () => {
  assert.deepEqual(measureSpacing(selected, box(0, 0, 100, 100)), { lines: [], extensions: [] })
})

console.log("\nformatDistance")

check("whole numbers drop the decimal", () => assert.equal(formatDistance(12), "12"))
check("rounds to one decimal", () => assert.equal(formatDistance(12.46), "12.5"))
check("a rounded .0 is dropped", () => assert.equal(formatDistance(12.04), "12"))
check("rounds up across the integer", () => assert.equal(formatDistance(0.96), "1"))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
