#!/usr/bin/env node
/**
 * A sticker sheet of the chrome's glyph set, before and after a change to it.
 * Review tooling, not part of the build: nothing under `src/` knows it exists.
 *
 * Both columns are drawn by their own revision's `icon()`, so what the page
 * shows is what each renderer emits — the same `width`, `height`, `viewBox`
 * and stroke attributes a call site gets — not a re-drawing of the path data.
 * The page then rasterises every glyph and measures it:
 *
 *   - BOX, the rendered `<svg>` size at each rung. A call site's icon size is
 *     this number, so it has to be identical in both columns.
 *   - INK, the bounding box of the pixels actually painted, in grid units of
 *     24. What the eye reads as "how big is the mark".
 *
 * "Before" comes from git, never from a copy kept by hand: `--before=<rev>`
 * names any revision, and the default is the newest commit whose
 * `src/core/icons.ts` is not Phosphor — the set this sheet was built to compare
 * against. "After" is the working tree.
 *
 *   node tools/icon-sticker-sheet.mjs                 # write .demos/icons/index.html
 *   node tools/icon-sticker-sheet.mjs --before=<rev>
 *
 * Output lands in `.demos/icons/`, which is gitignored. The page puts its
 * measurements in `window.__stickerSheet` once it has drawn.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT_DIR = path.join(ROOT, ".demos", "icons")
const SOURCE = "src/core/icons.ts"
const RAMP = [12, 14, 16, 18, 20, 24]

const git = (...argv) => execFileSync("git", argv, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

function defaultBefore() {
  for (const rev of ["HEAD", ...git("log", "--format=%H", "--", SOURCE).split("\n").filter(Boolean)]) {
    if (!/phosphor/i.test(git("show", `${rev}:${SOURCE}`).slice(0, 2000))) return rev
  }
  throw new Error(`no revision of ${SOURCE} predates Phosphor; pass --before=<rev>`)
}

const beforeArg = process.argv.find((arg) => arg.startsWith("--before="))
const beforeRev = beforeArg ? beforeArg.slice("--before=".length) : defaultBefore()
const beforeLabel = git("log", "-1", "--format=%h %s", beforeRev).trim()

/** One revision's `icons.ts`, bundled to a script that sets a global. */
async function bundle(file, globalName) {
  const result = await build({
    stdin: { contents: `export { icon, ICON_NAMES } from ${JSON.stringify(file)}`, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    format: "iife",
    globalName,
    write: false,
    logLevel: "silent",
  })
  return result.outputFiles[0].text
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "de-icon-sheet-"))
const beforeFile = path.join(scratch, "icons-before.ts")
fs.writeFileSync(beforeFile, git("show", `${beforeRev}:${SOURCE}`))
const beforeJs = await bundle(beforeFile, "BeforeIcons")
const afterJs = await bundle(path.join(ROOT, SOURCE), "AfterIcons")

/** Which source each glyph came from, read off the generator's provenance comments. */
function provenance(text) {
  const out = {}
  for (const match of text.matchAll(/^ {2}"(\w+)": \{\n {4}\/\/ (.*?) — inks/gm)) out[match[1]] = match[2]
  return out
}
const origins = {
  before: provenance(fs.readFileSync(beforeFile, "utf8")),
  after: provenance(fs.readFileSync(path.join(ROOT, SOURCE), "utf8")),
}

/*
 * The surfaces a reader recognises, so the sheet is not only an alphabet. Each
 * row is drawn at the rung its call site uses.
 */
const GROUPS = [
  { title: "Toolbar", size: 16, names: ["Cursor", "MessageSquare", "PanelLeft", "PanelRight", "Grid2x2", "ToolUndo", "ToolRedo", "Sun", "Moon", "ToolClose"] },
  { title: "Align and arrange", size: 16, names: ["AlignStartVertical", "AlignCenterVertical", "AlignEndVertical", "AlignStartHorizontal", "AlignCenterHorizontal", "AlignEndHorizontal", "SpaceBetweenHorizontal", "SpaceBetweenVertical", "ArrangeFront", "ArrangeForward", "ArrangeBackward", "ArrangeBack"] },
  { title: "Auto layout and box", size: 16, names: ["FlowNone", "FlowHorizontal", "FlowVertical", "FlowWrap", "GapColumn", "GapRow", "PadTop", "PadRight", "PadBottom", "PadLeft", "CornerRadius", "Opacity"] },
  { title: "Typography", size: 16, names: ["Type", "TextAlignLeft", "TextAlignCenter", "TextAlignRight", "TextAlignJustify", "TextAlignTop", "TextAlignMiddle", "TextAlignBottom"] },
  { title: "Rows and disclosure", size: 12, names: ["ChevronDown", "ChevronRight", "ChevronsUpDown", "ChevronsDownUp", "Plus", "Minus", "XSmall", "Eye", "EyeOff", "Lock", "LockOpen"] },
]

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DesignLayer icons — before and after</title>
<style>
  :root {
    color-scheme: dark;
    --ground: #111113; --card: #1b1b1e; --raised: #242428; --ink: #f5f5f7; --ink-2: rgba(245,245,247,.62);
    --ink-3: rgba(245,245,247,.38); --hair: rgba(255,255,255,.08); --accent: #0a84ff; --good: #30d158; --warn: #ffd60a; --bad: #ff453a;
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --ground: #f5f5f7; --card: #fff; --raised: #f0f0f3; --ink: #1d1d1f; --ink-2: rgba(29,29,31,.62);
    --ink-3: rgba(29,29,31,.38); --hair: rgba(0,0,0,.08);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--ink); font: 13px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 1240px; margin: 0 auto; padding: 48px 32px 96px; }
  header { display: flex; gap: 24px; align-items: flex-end; justify-content: space-between; margin-bottom: 32px; }
  h1 { font: 600 28px/1.15 -apple-system, "SF Pro Display", system-ui; letter-spacing: -0.02em; margin: 0 0 6px; }
  h2 { font: 600 17px/1.3 -apple-system, "SF Pro Display", system-ui; letter-spacing: -0.01em; margin: 40px 0 12px; }
  .sub { color: var(--ink-2); margin: 0; max-width: 64ch; }
  .controls { display: flex; gap: 8px; }
  button.seg { appearance: none; border: 1px solid var(--hair); background: var(--card); color: var(--ink); border-radius: 8px; padding: 6px 12px; font: inherit; cursor: pointer; }
  button.seg[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 8px; }
  .stat { background: var(--card); border: 1px solid var(--hair); border-radius: 12px; padding: 14px 16px; }
  .stat b { display: block; font: 600 22px/1.2 -apple-system, "SF Pro Display", system-ui; font-variant-numeric: tabular-nums; }
  .stat span { color: var(--ink-2); }
  .strip { background: var(--card); border: 1px solid var(--hair); border-radius: 12px; padding: 12px 16px; display: grid; grid-template-columns: 64px 1fr; gap: 8px 16px; align-items: center; }
  .strip .label { color: var(--ink-3); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .row { display: flex; gap: 4px; flex-wrap: wrap; }
  .tool { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; color: var(--ink); }
  .tool:hover { background: var(--raised); }
  .tool.on { color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .sticker { background: var(--card); border: 1px solid var(--hair); border-radius: 12px; padding: 12px 14px 10px; }
  .sticker h3 { margin: 0 0 2px; font: 600 13px/1.3 ui-monospace, "SF Mono", Menlo, monospace; }
  .sticker .src { color: var(--ink-3); font-size: 11px; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pair { display: grid; grid-template-columns: 48px repeat(${RAMP.length}, 1fr); align-items: center; gap: 4px; padding: 6px 0; border-top: 1px solid var(--hair); }
  .pair .side { color: var(--ink-3); font-size: 11px; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .cell .well { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; }
  .cell .well svg { outline: 1px dashed transparent; }
  body.boxes .cell .well svg { outline-color: rgba(10,132,255,.55); }
  .rung { color: var(--ink-3); font-size: 10px; font-variant-numeric: tabular-nums; }
  .ink { font-size: 10px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .delta { font-size: 11px; font-variant-numeric: tabular-nums; margin-top: 6px; color: var(--ink-2); display: flex; justify-content: space-between; }
  .delta .ok { color: var(--good); } .delta .warn { color: var(--warn); } .delta .bad { color: var(--bad); }
  .filledrow .side { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--hair); border-radius: 12px; overflow: hidden; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 12px; border-top: 1px solid var(--hair); }
  th { color: var(--ink-2); font-weight: 500; border-top: 0; }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Icons: before and after</h1>
      <p class="sub">Before is <code>${beforeLabel.replace(/</g, "&lt;")}</code>; after is Phosphor (regular, with its fill weight on the toolbar toggles). Each glyph is drawn by its own revision's <code>icon()</code> at every rung, 12 to 24.</p>
    </div>
    <div class="controls">
      <button class="seg" id="boxes" aria-pressed="false">Show boxes</button>
      <button class="seg" id="theme" aria-pressed="false">Light</button>
    </div>
  </header>
  <section class="stats" id="stats"></section>
  <h2>In context</h2>
  <div id="context"></div>
  <h2>Every glyph</h2>
  <div class="grid" id="grid"></div>
  <h2>Measurements</h2>
  <table id="table"><thead><tr><th>Glyph</th><th>Box at each rung, before → after</th><th>Ink before</th><th>Ink after</th><th>Change</th></tr></thead><tbody></tbody></table>
</main>
<script>${beforeJs}</script>
<script>${afterJs}</script>
<script>
const RAMP = ${JSON.stringify(RAMP)}
const GROUPS = ${JSON.stringify(GROUPS)}
const ORIGINS = ${JSON.stringify(origins)}
const sets = { before: BeforeIcons, after: AfterIcons }
const names = AfterIcons.ICON_NAMES.slice().sort()
const el = (tag, attrs = {}, kids = []) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) k === "text" ? (node.textContent = v) : node.setAttribute(k, v)
  for (const kid of kids) node.append(kid)
  return node
}
const has = (side, name) => sets[side].ICON_NAMES.includes(name)

/*
 * Ink extent by rasterising: the svg is drawn at 24px into a canvas at 8x, so
 * one grid unit is 8 pixels, and the painted alpha's bounding box is read back.
 */
async function measure(svg) {
  const clone = svg.cloneNode(true)
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
  clone.setAttribute("color", "#000")
  clone.setAttribute("style", "color:#000")
  const scale = 8
  const px = 24 * scale
  clone.setAttribute("width", px)
  clone.setAttribute("height", px)
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone))
  const img = new Image()
  img.src = url
  await img.decode()
  const canvas = new OffscreenCanvas(px, px)
  const ctx = canvas.getContext("2d")
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, px, px)
  let minX = px, minY = px, maxX = -1, maxY = -1, mass = 0
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const a = data[(y * px + x) * 4 + 3]
    if (a > 24) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    mass += a / 255
  }
  if (maxX < 0) return { w: 0, h: 0, mass: 0 }
  return { w: (maxX - minX + 1) / scale, h: (maxY - minY + 1) / scale, mass: mass / scale / scale }
}

function stickerRow(side, name, weight) {
  const row = el("div", { class: "pair" + (weight === "filled" ? " filledrow" : "") }, [el("span", { class: "side", text: weight === "filled" ? side + " on" : side })])
  for (const size of RAMP) {
    const svg = has(side, name) ? sets[side].icon(name, size, weight) : null
    const cell = el("div", { class: "cell" }, [el("div", { class: "well" }, svg ? [svg] : [document.createTextNode("—")]), el("span", { class: "rung", text: svg ? svg.getAttribute("width") : "" })])
    row.append(cell)
  }
  return row
}

const results = {}
async function main() {
  // In context: each surface drawn at the rung its call site uses.
  const context = document.getElementById("context")
  for (const group of GROUPS) {
    context.append(el("h2", { text: group.title + " · " + group.size + "px", style: "font-size:13px;margin:16px 0 8px;color:var(--ink-2)" }))
    const strip = el("div", { class: "strip" })
    for (const side of ["before", "after"]) {
      const row = el("div", { class: "row" })
      for (const name of group.names) {
        const tool = el("span", { class: "tool", title: name })
        if (has(side, name)) tool.append(sets[side].icon(name, group.size))
        row.append(tool)
      }
      strip.append(el("span", { class: "label", text: side }), row)
    }
    if (group.title === "Toolbar") {
      for (const side of ["before", "after"]) {
        const row = el("div", { class: "row" })
        for (const name of ["Cursor", "MessageSquare", "PanelLeft", "PanelRight", "Grid2x2"]) {
          const tool = el("span", { class: "tool on", title: name + " (on)" })
          tool.append(sets[side].icon(name, group.size, "filled"))
          row.append(tool)
        }
        strip.append(el("span", { class: "label", text: side + " on" }), row)
      }
    }
    context.append(strip)
  }

  const grid = document.getElementById("grid")
  const tbody = document.querySelector("#table tbody")
  const toggles = new Set(["Cursor", "MessageSquare", "PanelLeft", "PanelRight", "Grid2x2"])
  let boxMismatches = 0
  const deltas = []
  for (const name of names) {
    const card = el("div", { class: "sticker" }, [
      el("h3", { text: name }),
      el("div", { class: "src", text: (ORIGINS.before[name] ?? "new") + "  →  " + (ORIGINS.after[name] ?? "") }),
      stickerRow("before", name, "outline"),
      stickerRow("after", name, "outline"),
    ])
    if (toggles.has(name)) card.append(stickerRow("before", name, "filled"), stickerRow("after", name, "filled"))
    const boxes = RAMP.map((size) => {
      const a = has("before", name) ? sets.before.icon(name, size).getAttribute("width") : "—"
      const b = sets.after.icon(name, size).getAttribute("width")
      if (a !== b) boxMismatches += 1
      return a === b ? b : a + "→" + b
    })
    const inkBefore = has("before", name) ? await measure(sets.before.icon(name, 24)) : null
    const inkAfter = await measure(sets.after.icon(name, 24))
    const side = (ink) => Math.max(ink.w, ink.h)
    const change = inkBefore ? side(inkAfter) / side(inkBefore) - 1 : 0
    deltas.push(Math.abs(change))
    const tone = Math.abs(change) <= 0.08 ? "ok" : Math.abs(change) <= 0.15 ? "warn" : "bad"
    const fmt = (ink) => ink ? ink.w.toFixed(1) + "×" + ink.h.toFixed(1) : "—"
    card.append(el("div", { class: "delta" }, [
      el("span", { text: "ink " + fmt(inkBefore) + " → " + fmt(inkAfter) + " of 24" }),
      el("span", { class: tone, text: (change >= 0 ? "+" : "") + (change * 100).toFixed(0) + "%" }),
    ]))
    grid.append(card)
    tbody.append(el("tr", {}, [
      el("td", { text: name }),
      el("td", { text: boxes.join(" · ") }),
      el("td", { text: fmt(inkBefore) }),
      el("td", { text: fmt(inkAfter) }),
      el("td", { class: tone, text: (change >= 0 ? "+" : "") + (change * 100).toFixed(0) + "%" }),
    ]))
    results[name] = { boxes, inkBefore, inkAfter, change }
  }
  const median = deltas.slice().sort((a, b) => a - b)[Math.floor(deltas.length / 2)]
  const stats = [
    [names.length, "glyphs swapped"],
    [boxMismatches === 0 ? "0" : String(boxMismatches), "box sizes changed, of " + names.length * RAMP.length],
    [(median * 100).toFixed(0) + "%", "median ink change"],
    [Object.values(results).filter((r) => Math.abs(r.change) > 0.08).length, "glyphs off by more than 8%"],
  ]
  document.getElementById("stats").append(...stats.map(([value, label]) => el("div", { class: "stat" }, [el("b", { text: String(value) }), el("span", { text: label })])))
  window.__stickerSheet = { boxMismatches, results }
}

document.getElementById("theme").onclick = (event) => {
  const light = document.documentElement.dataset.theme !== "light"
  document.documentElement.dataset.theme = light ? "light" : "dark"
  event.currentTarget.setAttribute("aria-pressed", String(light))
}
document.getElementById("boxes").onclick = (event) => {
  const on = document.body.classList.toggle("boxes")
  event.currentTarget.setAttribute("aria-pressed", String(on))
}
main()
</script>
</body>
</html>
`

fs.mkdirSync(OUT_DIR, { recursive: true })
const out = path.join(OUT_DIR, "index.html")
fs.writeFileSync(out, page)
fs.rmSync(scratch, { recursive: true, force: true })
console.log(`Wrote ${path.relative(ROOT, out)} — before: ${beforeLabel}`)
