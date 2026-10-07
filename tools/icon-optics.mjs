#!/usr/bin/env node
/**
 * Optical-size bench for the WHOLE glyph set. NOT part of the build.
 *
 * `tools/icon-lab.mjs` measures the toolbar strip; this measures every glyph
 * the chrome can draw, at the 16px rung most of them are drawn at, because the
 * question "do these read as one size?" is a rendered one: a disc, a square
 * and a diagonal cross with identical boxes look like three sizes. Per glyph:
 *
 *   - INK EXTENT: the painted bounding box, in 24-unit grid units.
 *   - INK MASS: summed alpha as a share of the 24x24 box — how heavy it reads.
 *   - The source (phosphor / native), from the generator's provenance line.
 *
 *   node tools/icon-optics.mjs     # .icon-lab/optics.html + optics.json + two PNGs
 *
 * Needs Playwright (resolved the way tools/before-after.mjs resolves it).
 */

import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const SOURCE = path.join(ROOT, "src", "core", "icons.ts")
const OUT = path.join(ROOT, ".icon-lab")

function readIcons() {
  const text = fs.readFileSync(SOURCE, "utf8")
  const start = text.indexOf("const ICONS = {")
  const end = text.indexOf("} as const satisfies Record<string, IconData>")
  const block = text.slice(start + "const ICONS = ".length, end + 1)
  const sources = {}
  for (const match of block.matchAll(/^ {2}"([A-Za-z0-9]+)": \{\n\s*\/\/ (\S+)/gm)) sources[match[1]] = match[2]
  const icons = new Function(`return ${block.replace(/^\s*\/\/.*$/gm, "")}`)()
  return { icons, sources }
}

const { icons, sources } = readIcons()
const attrs = (record) =>
  Object.entries(record)
    .map(([key, value]) => `${key}="${String(value).replace(/"/g, "&quot;")}"`)
    .join(" ")
const svgFor = (name, size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="0" stroke-linecap="round" stroke-linejoin="round">` +
  icons[name].shapes.map(([tag, a]) => `<${tag} ${attrs(a)}></${tag}>`).join("") +
  `</svg>`

const names = Object.keys(icons).sort((a, b) => a.localeCompare(b))
const group = (name) => (sources[name] ?? "?").split("/")[0].replace(/—.*/, "")

const page = (theme) => `<!doctype html><meta charset="utf-8"><title>icon optics</title>
<style>
  body { margin: 16px; font: 11px/1.3 -apple-system, system-ui, sans-serif;
    background: ${theme === "dark" ? "#171717" : "#ffffff"}; color: ${theme === "dark" ? "#fafafa" : "#0c1014"}; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; opacity: .6; margin: 14px 0 6px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  .cell { width: 86px; display: grid; justify-items: center; gap: 4px; padding: 6px 2px;
    border-radius: 8px; background: ${theme === "dark" ? "#262626" : "#f0f2f5"}; }
  .cell small { opacity: .6; font-size: 9px; text-align: center; }
  .pair { display: flex; gap: 8px; align-items: center; height: 24px; }
</style>
${["phosphor", "native"]
  .map(
    (source) => `<h2>${source}</h2><div class="row">${names
      .filter((name) => group(name) === source)
      .map(
        (name) =>
          `<div class="cell" data-name="${name}"><div class="pair">${svgFor(name, 16)}${svgFor(name, 12)}</div><small>${name}</small></div>`
      )
      .join("")}</div>`
  )
  .join("")}
<script>
window.measureAll = async () => {
  const SCALE = 16, S = 24 * SCALE
  const out = []
  for (const cell of document.querySelectorAll('.cell')) {
    const svg = cell.querySelector('svg').cloneNode(true)
    svg.setAttribute('width', S); svg.setAttribute('height', S); svg.setAttribute('color', '#000')
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }))
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url })
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
    out.push({ name: cell.dataset.name, w: +w.toFixed(1), h: +h.toFixed(1), extent: +Math.max(w, h).toFixed(1),
      mass: +(100 * mass / (S * S)).toFixed(1), cx: +(((minX + maxX + 1) / 2) / SCALE).toFixed(1), cy: +(((minY + maxY + 1) / 2) / SCALE).toFixed(1) })
  }
  return out
}
</script>`

function loadPlaywright() {
  const require = createRequire(import.meta.url)
  try {
    return require("playwright")
  } catch {}
  for (const root of [path.join(process.env.HOME ?? "", ".npm", "_npx"), "/opt/homebrew/lib/node_modules"]) {
    if (!fs.existsSync(root)) continue
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()
      for (const anchor of ["playwright/index.js", "@playwright/mcp/cli.js"]) {
        const file = path.join(dir, "node_modules", anchor)
        if (fs.existsSync(file)) {
          try {
            return createRequire(file)("playwright")
          } catch {}
        }
      }
      if (dir.split(path.sep).length - root.split(path.sep).length < 2) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) stack.push(path.join(dir, entry.name))
      }
    }
  }
  throw new Error("Playwright not found")
}

fs.mkdirSync(OUT, { recursive: true })
const { chromium } = loadPlaywright()
const browser = await chromium.launch()
const page_ = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
let rows = []
for (const theme of ["light", "dark"]) {
  const file = path.join(OUT, `optics-${theme}.html`)
  fs.writeFileSync(file, page(theme))
  await page_.goto(`file://${file}`)
  if (theme === "light") rows = await page_.evaluate(() => window.measureAll())
  await page_.screenshot({ path: path.join(OUT, `optics-${theme}.png`), fullPage: true })
}
await browser.close()
for (const row of rows) row.source = sources[row.name] ?? "?"
fs.writeFileSync(path.join(OUT, "optics.json"), JSON.stringify(rows, null, 2))
const byExtent = [...rows].sort((a, b) => b.extent - a.extent)
console.log("name".padEnd(24), "source".padEnd(26), "w".padStart(5), "h".padStart(5), "mass".padStart(6))
for (const r of byExtent) console.log(r.name.padEnd(24), r.source.slice(0, 26).padEnd(26), String(r.w).padStart(5), String(r.h).padStart(5), String(r.mass).padStart(6))
