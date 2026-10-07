#!/usr/bin/env node
/**
 * Every chrome surface the colour retune touched, drawn four ways: before and
 * after, in both themes, with the measured ratio under each one.
 *
 * ## How "before" is reproduced, and why it is exact rather than approximate
 *
 * Not from an old bundle. Every rule involved reads its ink through a custom
 * property, so the previous rendering is reproduced by REDECLARING those
 * properties on a wrapper — `--de-color-on-semantic: #ffffff` puts back the
 * white that `onAccent` was supplying before the role was split out, and
 * `--de-color-accent-surface-text: <the glyph rung>` puts back the fill the six
 * text surfaces were wearing.
 *
 * That is the whole of the change, expressed as data, which makes the left
 * column exact: it is the shipped stylesheet with the shipped markup, resolved
 * against the old values. An old bundle would have been a second build to keep
 * honest, and a hand-written mock would have been a third thing to believe.
 *
 * The one rule this cannot reach is `.de-button--danger:hover`, which had NO
 * ink declaration at all and inherited `.de-button`'s. There is no property to
 * put back, so the before column restates the rule. It is marked in the output.
 *
 * ## What it measures
 *
 * `getComputedStyle` on the rendered node, both halves of each pair resolved by
 * the browser — so `color-mix()` and `var()` fallbacks are the browser's answer
 * and not this file's arithmetic. The ratio is WCAG 2.x relative luminance.
 *
 *   node tools/color-demo.mjs            # build the page and shoot it
 *   node tools/color-demo.mjs --open
 *
 * Output lands in `.demos/color/`, which is gitignored.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT = path.join(ROOT, ".demos", "color")
const flags = new Set(process.argv.slice(2))

/*
 * The surfaces, each as the markup that produces it plus the pair to measure.
 *
 * `ink` and `fill` are CSS properties read off the named node after render —
 * usually `color` and `background-color` on the same element, but a badge whose
 * fill comes from an ancestor needs them read from two, which is why they are
 * separate selectors rather than one.
 */
const SURFACES = [
  {
    id: "mini-danger",
    title: "Delete button, hovered",
    where: "css/panels.ts — .de-mini--danger:hover",
    html: `<button class="de-mini de-mini--danger" data-demo-hover>✕</button>`,
    note: "The one control in the panel whose whole job is destructive.",
  },
  {
    id: "option-delete",
    title: "Saved-option delete, hovered",
    where: "css/options.ts — .de-option-delete:hover",
    html: `<button class="de-option-delete" data-demo-hover>✕</button>`,
    note: "Its comment already named 2.31:1 as the bug it had fixed.",
  },
  {
    id: "ann-clear-armed",
    title: "Clear all notes, armed",
    where: "css/annotations.ts — .de-ann-clear--armed",
    html: `<button class="de-ann-clear de-ann-clear--armed">Clear all</button>`,
    note: "Armed means the next click destroys. Same comment, same 2.31:1.",
  },
  {
    id: "ann-badge-written",
    title: "Note badge, written",
    where: "css/annotations.ts — .de-ann-badge[data-de-state=written]",
    html: `<span class="de-ann-badge" data-de-state="written">In your files</span>`,
    note: "The worst pair measured anywhere in the chrome: 1.58:1.",
  },
  {
    id: "lint-marker",
    title: "Design-system marker",
    where: "css/lint-markers.ts — .de-lint-marker",
    html: `<button class="de-lint-marker" style="background:var(--de-color-lint-warning)">!</button>`,
    note: "Drawn over the app, on a severity fill that does not flip.",
  },
  {
    id: "opt-chip",
    title: "Controls scope chip, taken",
    where: "css/options.ts — .de-opt-chip[aria-checked=true]",
    html: `<button class="de-opt-chip" aria-checked="true">This element</button>`,
    note: "Carries a word, so it owes 4.5:1 — the glyph rung gives 3.53:1.",
  },
  {
    id: "lint-toggle",
    title: "Markers toggle, on",
    where: "css/lint.ts — .de-lint-toggle[aria-pressed=true]",
    html: `<button class="de-button de-lint-toggle" aria-pressed="true">Markers</button>`,
    note: "Same: a labelled control on the fill reserved for marks.",
  },
  {
    id: "badge",
    title: "Canvas size badge",
    where: "css/canvas.ts — .de-badge",
    html: `<span class="de-badge" style="position:static">360 × 240</span>`,
    note: "Numerals over the app while you drag. Read at a glance or not at all.",
  },
]

/**
 * The old values, as property declarations.
 *
 * `--de-color-on-semantic` did not exist before the retune; the five rules that
 * now read it read `--de-color-on-accent`, which is `#ffffff` in both themes.
 * Setting it to white therefore reproduces the old rendering exactly.
 *
 * `--de-color-accent-surface-text` did exist, and the six text-bearing surfaces
 * were not using it — they were on `--de-color-accent-surface`, the glyph rung.
 * Aliasing one to the other puts them back.
 */
const BEFORE_VARS = `
  --de-color-on-semantic: #ffffff;
  --de-color-accent-surface-text: var(--de-color-accent-surface);
  --de-color-accent-surface-text-hover: var(--de-color-accent-surface-hover);
`

/** The one rule with no property to put back. See the header. */
const BEFORE_RULES = `
  .before .de-button--danger[data-demo-hover] { color: var(--de-color-text); }
`

async function loadPlaywright() {
  const localRequire = createRequire(path.join(ROOT, "package.json"))
  try {
    return localRequire("playwright")
  } catch {
    /* not a dependency here, which is the expected case — see panel-harness.mjs */
  }
  let globalRoot = null
  try {
    globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim()
  } catch {
    /* npm may not be on PATH in a sandbox */
  }
  for (const root of [globalRoot, "/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"]) {
    if (!root) continue
    for (const anchor of ["@playwright/mcp/cli.js", "playwright/index.js"]) {
      try {
        return createRequire(path.join(root, anchor))("playwright")
      } catch {
        /* try the next one */
      }
    }
  }
  return null
}

/*
 * Hover is forced by an attribute, not by moving a pointer.
 *
 * Four cells per surface and two of them hover states; driving a real pointer
 * into each would be eight moves whose timing has to be right, and a screenshot
 * taken a frame early is a cell that silently shows the rest state. The
 * attribute selector is appended to every `:hover` rule in the sheet instead, so
 * the hovered cells are hovered by the cascade and cannot be mistimed.
 */
function forceHover(css) {
  return css.replace(/([^\s,{}]+):hover\b/g, "$1:hover, $1[data-demo-hover]")
}

function page(shellCss) {
  const cells = SURFACES.map(
    (s) => `
  <section class="row" id="${s.id}">
    <div class="meta">
      <h2>${s.title}</h2>
      <p class="where">${s.where}</p>
      <p class="note">${s.note}</p>
    </div>
    ${["dark", "light"]
      .flatMap((theme) =>
        ["before", "after"].map(
          (side) => `
    <figure class="cell ${side}" data-theme="${theme}" data-side="${side}" data-surface="${s.id}">
      <figcaption>${theme} · ${side}</figcaption>
      <div class="stage ${side}" data-designlayer data-de-theme="${theme}">${s.html}</div>
      <p class="ratio">–</p>
    </figure>`
        )
      )
      .join("")}
  </section>`
  ).join("")

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>designlayer — the colour retune, before and after</title>
<style>
${forceHover(shellCss)}
/* The before column, resolved against the values that shipped. */
.stage.before { ${BEFORE_VARS} }
${BEFORE_RULES}

  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    background: #1b1b1b; color: #f2f2f2;
    font: 400 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .lede { margin: 0 0 28px; color: rgba(255,255,255,0.62); max-width: 90ch; }
  .row {
    display: grid; grid-template-columns: 300px repeat(4, 1fr); gap: 16px;
    align-items: start;
    padding: 20px 0; border-top: 1px solid rgba(255,255,255,0.14);
  }
  .meta h2 { margin: 0 0 4px; font-size: 15px; }
  .where { margin: 0 0 6px; font: 400 12px ui-monospace, monospace; color: rgba(255,255,255,0.5); }
  .note { margin: 0; font-size: 12px; color: rgba(255,255,255,0.62); }
  figure { margin: 0; }
  figcaption { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(255,255,255,0.5); }
  .stage {
    display: flex; align-items: center; justify-content: center;
    min-height: 68px; padding: 14px; border-radius: 10px;
  }
  .stage[data-de-theme="dark"] { background: #1a1a1a; }
  .stage[data-de-theme="light"] { background: #ffffff; }
  .ratio { margin: 6px 0 0; font: 600 12px ui-monospace, monospace; }
  .ratio[data-pass="false"] { color: #ff8a65; }
  .ratio[data-pass="true"] { color: #7ee2a8; }
</style>
</head>
<body>
  <h1>The colour retune, before and after</h1>
  <p class="lede">Each surface drawn four ways. The before column is the shipped stylesheet resolved
  against the values that shipped — the properties are redeclared, nothing is mocked. Ratios are
  measured from <code>getComputedStyle</code> in the browser, against the 4.5:1 a label owes.</p>
  ${cells}
</body>
</html>`
}

/** WCAG 2.x relative luminance, run in the page against resolved values. */
const MEASURE = `(() => {
  const parse = (value) => {
    const m = value.match(/[\\d.]+/g)
    return m ? m.slice(0, 3).map(Number) : null
  }
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  const lum = (p) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2])
  const out = []
  for (const cell of document.querySelectorAll(".cell")) {
    const node = cell.querySelector(".stage > *")
    const style = getComputedStyle(node)
    const ink = parse(style.color)
    // The fill may be transparent on the node itself when the rule paints an
    // ancestor, so walk up until something opaque is found — the same thing the
    // eye does, and the only honest ground to measure against.
    let fill = parse(style.backgroundColor)
    let walk = node
    while (walk && (!fill || /rgba\\(.*,\\s*0\\)/.test(getComputedStyle(walk).backgroundColor))) {
      walk = walk.parentElement
      if (!walk) break
      fill = parse(getComputedStyle(walk).backgroundColor)
    }
    if (!ink || !fill) { out.push({ ...cell.dataset, ratio: null }); continue }
    const [hi, lo] = [lum(ink), lum(fill)].sort((a, b) => b - a)
    const ratio = (hi + 0.05) / (lo + 0.05)
    const el = cell.querySelector(".ratio")
    el.textContent = ratio.toFixed(2) + ":1"
    el.dataset.pass = String(ratio >= 4.5)
    out.push({ ...cell.dataset, ratio: Number(ratio.toFixed(2)) })
  }
  return out
})()`

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  /*
   * The stylesheet is compiled here rather than read out of `dist/`.
   *
   * `dist/designlayer.js` is an IIFE that mounts the editor, so it exports
   * nothing an importer can reach, and it is a build artifact that may be a
   * minute stale — which for a page whose entire subject is which colour a rule
   * resolves to is the difference between a demo and a lie. Every suite in this
   * repo does the same thing for the same reason; see `test/toolbar-cases.mjs`.
   */
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `export { shellCss } from "./src/core/css"`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  const { shellCss } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  )

  const html = page(shellCss)
  const file = path.join(OUT, "index.html")
  fs.writeFileSync(file, html)

  const pw = await loadPlaywright()
  if (!pw) {
    console.log(`wrote ${path.relative(ROOT, file)} (no Playwright, so no measurements)`)
    return
  }
  const browser = await pw.chromium.launch()
  const tab = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 })
  await tab.setContent(html, { waitUntil: "load" })
  await tab.waitForTimeout(200)
  const measured = await tab.evaluate(MEASURE)

  // Write the measured page back out, so the file on disk carries the numbers.
  const withRatios = await tab.content()
  fs.writeFileSync(file, withRatios)
  await tab.screenshot({ path: path.join(OUT, "retune.png"), fullPage: true })
  await browser.close()

  const by = (side, theme) => measured.filter((m) => m.side === side && m.theme === theme)
  let fixed = 0
  console.log("surface            dark before  dark after   light before  light after")
  console.log("-".repeat(76))
  for (const s of SURFACES) {
    const get = (side, theme) =>
      measured.find((m) => m.surface === s.id && m.side === side && m.theme === theme)?.ratio ?? NaN
    const row = ["dark", "light"].flatMap((t) => [get("before", t), get("after", t)])
    if (row[0] < 4.5 && row[1] >= 4.5) fixed++
    console.log(
      s.id.padEnd(18) +
        row.map((n) => String(n).padStart(11)).join("  ")
    )
  }
  void by
  console.log(`\n${fixed} of ${SURFACES.length} dark-theme surfaces moved from failing to passing.`)
  console.log(`wrote ${path.relative(ROOT, file)} and retune.png`)
  if (flags.has("--open")) execFileSync("open", [file])
}

await main()
