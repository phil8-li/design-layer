#!/usr/bin/env node
/**
 * A measuring bench for the toolbar's glyphs. NOT part of the build.
 *
 * `tools/build-icons.mjs` guarantees a glyph fits its grid and that a filled
 * counterpart is the same size as its outline. Neither of those is the question
 * an eight-glyph strip asks, which is whether the eight read as ONE SIZE — and
 * that is not a geometry question at all: a square, a disc and a diagonal cross
 * of identical bounding boxes look like three different sizes, so the numbers
 * that matter are rendered ones.
 *
 * So this rasterises each glyph at the rung it is drawn at, 16x, and reports
 * two measurements per mark:
 *
 *   - INK EXTENT, the bounding box of the pixels actually painted. What the eye
 *     reads as "how big is it".
 *   - INK MASS, the summed alpha. What the eye reads as "how heavy is it", and
 *     the number that catches a mark which measures right and looks thin.
 *
 *   node tools/icon-lab.mjs            # write .icon-lab/index.html
 *
 * Open that file in a browser, or point a headless one at it: it measures on
 * load and puts the table in `window.__iconLab`.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const SOURCE = path.join(root, "src", "core", "icons.ts")
const OUT_DIR = path.join(root, ".icon-lab")

/**
 * The generated table, read back out of the TypeScript it was written into.
 *
 * Parsed rather than imported because `icons.ts` is TypeScript and this is a
 * plain Node script — and parsed rather than duplicated because a second copy
 * of the shapes is a second thing to keep in agreement, which is the failure
 * mode the whole generated-file arrangement exists to avoid.
 */
function readIcons() {
  const text = fs.readFileSync(SOURCE, "utf8")
  const start = text.indexOf("const ICONS = {")
  const end = text.indexOf("} as const satisfies Record<string, IconData>")
  if (start < 0 || end < 0) throw new Error("could not find the ICONS table in src/core/icons.ts")
  const literal = text
    .slice(start + "const ICONS = ".length, end + 1)
    // The generator writes a provenance comment above every glyph.
    .replace(/^\s*\/\/.*$/gm, "")
  return new Function(`return ${literal}`)()
}

// Mirrors `STROKE_FOR_SIZE` in src/core/icons.ts: extra stroke over Phosphor's filled outlines.
const STROKE_FOR_SIZE = { 12: 0.5, 14: 0.3, 16: 0.15, 18: 0, 20: 0, 24: 0 }

/** The bar, in the order it is read. */
const BAR = [
  ["Inspect", "Cursor", "filled"],
  ["Inspect (off)", "Cursor", "outline"],
  ["Notes", "MessageSquare", "outline"],
  ["Notes (on)", "MessageSquare", "filled"],
  ["Undo", "ToolUndo", "outline"],
  ["Redo", "ToolRedo", "outline"],
  ["Theme (sun)", "Sun", "outline"],
  ["Theme (moon)", "Moon", "outline"],
  ["Panel left", "PanelLeft", "filled"],
  ["Panel left (off)", "PanelLeft", "outline"],
  ["Hide", "ToolClose", "outline"],
]

const icons = readIcons()

const attrs = (record) =>
  Object.entries(record)
    .map(([key, value]) => `${key}="${String(value).replace(/"/g, "&quot;")}"`)
    .join(" ")

function svgFor(name, weight, size = 16) {
  const data = icons[name]
  if (!data) throw new Error(`no glyph named ${name}`)
  const shapes = weight === "filled" && data.filled ? data.filled : data.shapes
  const stroke = STROKE_FOR_SIZE[size]
  const body = shapes.map(([tag, a]) => `<${tag} ${attrs(a)}></${tag}>`).join("")
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="${weight === "filled" ? "currentColor" : "none"}" stroke="currentColor" ` +
    `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" ` +
    `data-de-glyph aria-hidden="true">${body}</svg>`
  )
}

const cells = BAR.map(
  ([label, name, weight]) => `
    <figure class="cell" data-label="${label}" data-name="${name}" data-weight="${weight}">
      <div class="bar-size">${svgFor(name, weight, 16)}</div>
      <div class="big">${svgFor(name, weight, 32)}</div>
      <figcaption>${label}<br><small>${name}</small></figcaption>
      <div class="readout"></div>
    </figure>`
).join("")

const strip = BAR.map(
  ([, name, weight]) => `<button class="tool">${svgFor(name, weight, 16)}</button>`
).join("")

const page = `<!doctype html>
<meta charset="utf-8">
<title>icon lab</title>
<style>
  :root { color-scheme: dark; }
  body { background: #1e1f22; color: #e6e6e6; font: 12px/1.5 ui-monospace, monospace; margin: 24px; }
  h2 { font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #9aa0a6; margin: 28px 0 10px; }
  .strip { display: inline-flex; gap: 2px; padding: 4px; border-radius: 10px; background: #2b2d31; }
  .tool { width: 32px; height: 32px; display: grid; place-items: center; background: none; border: 0; color: #e6e6e6; padding: 0; border-radius: 6px; }
  .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
  .cell { margin: 0; padding: 10px; border: 1px solid #35373b; border-radius: 8px; text-align: center; }
  .bar-size, .big { display: grid; place-items: center; height: 40px; }
  .big { height: 56px; }
  figcaption { color: #9aa0a6; margin-top: 4px; }
  small { color: #6f757c; }
  .readout { margin-top: 6px; font-size: 11px; color: #8ab4f8; white-space: pre; }
  table { border-collapse: collapse; margin-top: 12px; }
  td, th { padding: 2px 10px; text-align: right; border-bottom: 1px solid #2b2d31; }
  th:first-child, td:first-child { text-align: left; }
</style>
<h2>the bar, at 16</h2>
<div class="strip">${strip}</div>
<h2>each mark, measured</h2>
<div class="grid">${cells}</div>
<h2>table</h2>
<div id="table"></div>
<script>
const SCALE = 16 // rasterise the 16px rung at 16x, so one lattice unit is 16px
async function measure(svg) {
  const clone = svg.cloneNode(true)
  clone.setAttribute('width', 16 * SCALE)
  clone.setAttribute('height', 16 * SCALE)
  clone.setAttribute('color', '#fff')
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }))
  const img = new Image()
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url })
  const S = 16 * SCALE
  const c = document.createElement('canvas'); c.width = S; c.height = S
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, S, S)
  const d = ctx.getImageData(0, 0, S, S).data
  let minX = S, minY = S, maxX = -1, maxY = -1, mass = 0
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const a = d[(y * S + x) * 4 + 3]
    if (a > 8) { mass += a / 255; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
  URL.revokeObjectURL(url)
  const w = (maxX - minX + 1) / SCALE, h = (maxY - minY + 1) / SCALE
  return {
    w: +w.toFixed(2), h: +h.toFixed(2),
    extent: +Math.max(w, h).toFixed(2),
    diag: +Math.hypot(w, h).toFixed(2),
    mass: +(mass / (SCALE * SCALE)).toFixed(1),
    cx: +(((minX + maxX + 1) / 2) / SCALE).toFixed(2),
    cy: +(((minY + maxY + 1) / 2) / SCALE).toFixed(2),
  }
}
;(async () => {
  const rows = []
  for (const cell of document.querySelectorAll('.cell')) {
    const m = await measure(cell.querySelector('.bar-size svg'))
    cell.querySelector('.readout').textContent =
      m.w + '\\u00d7' + m.h + '\\nmass ' + m.mass + '\\nc ' + m.cx + ',' + m.cy
    rows.push({ label: cell.dataset.label, name: cell.dataset.name, weight: cell.dataset.weight, ...m })
  }
  window.__iconLab = rows
  document.getElementById('table').innerHTML =
    '<table><tr><th>mark</th><th>w</th><th>h</th><th>extent</th><th>diag</th><th>mass</th><th>cx</th><th>cy</th></tr>' +
    rows.map(r => '<tr><td>' + r.label + '</td><td>' + r.w + '</td><td>' + r.h + '</td><td>' + r.extent +
      '</td><td>' + r.diag + '</td><td>' + r.mass + '</td><td>' + r.cx + '</td><td>' + r.cy + '</td></tr>').join('') +
    '</table>'
  document.title = 'icon lab \\u2713'
})()
</script>
`

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, "index.html"), page)
console.log(`Wrote ${path.relative(root, path.join(OUT_DIR, "index.html"))} — ${BAR.length} marks`)
