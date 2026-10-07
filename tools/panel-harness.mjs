#!/usr/bin/env node
/**
 * Renders the inspector's Design tab into a real browser and measures it.
 *
 * This is comparison tooling, not part of the editor: nothing under `src/`,
 * `server/` or `runtime/` knows it exists, and it only ever reads them. What it
 * produces is a page you can open, two screenshots at 2x, and a JSON file of
 * every control's box and computed style — the three things you need to hold
 * the panel up against a Figma frame and say which numbers disagree.
 *
 * The panel itself is stood up by `tools/panel-harness-scene.js`, which is
 * bundled by esbuild here and inlined into the page. See the note at the top of
 * that file for why the whole thing runs in Chromium rather than in JSDOM.
 *
 *   node tools/panel-harness.mjs                      # build, shoot, measure
 *   node tools/panel-harness.mjs --no-shots           # page + nothing else
 *   node tools/panel-harness.mjs --collapse=Responsive,Classes
 *   node tools/panel-harness.mjs --open               # and open the page after
 *
 * Output lands in `.harness/` at the repo root, which is gitignored.
 */

import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT = path.join(ROOT, ".harness")
const THEMES = ["dark", "light"]

const args = process.argv.slice(2)
const flags = new Set(args)
const wantShots = !flags.has("--no-shots")
/** Section titles to fold before shooting, so a tall section can be got out of the frame. */
const collapseTitles = (args.find((arg) => arg.startsWith("--collapse=")) ?? "")
  .slice("--collapse=".length)
  .split(",")
  .map((title) => title.trim())
  .filter(Boolean)
/**
 * Which tab to shoot. Defaults to Design, the historical subject.
 *
 * The outbox and the code view are the other two things this panel is, and
 * neither could be measured before: they are mounted but hidden, so every node
 * in them reports a 0x0 box. Switching first is the only way their rows,
 * badges and switches arrive with real geometry.
 */
const tab = (args.find((arg) => arg.startsWith("--tab=")) ?? "").slice("--tab=".length).trim()

/* ---------- scratch dir, and keeping it out of git ---------- */

function prepareOutputDir() {
  fs.mkdirSync(OUT, { recursive: true })

  const gitignore = path.join(ROOT, ".gitignore")
  if (!fs.existsSync(gitignore)) return
  const current = fs.readFileSync(gitignore, "utf8")
  if (/^\.harness\/?$/m.test(current)) return
  const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n"
  const addition =
    "# Scratch output of tools/panel-harness.mjs: a rendered panel, its\n" +
    "# screenshots, and its measurements. Regenerate, never commit.\n.harness/\n"
  fs.writeFileSync(gitignore, current + separator + addition)
  console.log("Added .harness/ to .gitignore")
}

/* ---------- the page ---------- */

/**
 * Bundles the scene as one IIFE so the page can be a single file.
 *
 * IIFE rather than ESM because the page has to work from `file://`, where a
 * module script is blocked by CORS — the whole point of the HTML being
 * self-contained is that a human can double-click it.
 */
async function bundleScene() {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, "tools", "panel-harness-scene.js")],
    bundle: true,
    format: "iife",
    globalName: "DesignLayerHarness",
    platform: "browser",
    target: ["chrome110"],
    tsconfig: path.join(ROOT, "tsconfig.json"),
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    write: false,
  })
  return result.outputFiles[0].text
}

/** `</script>` inside a bundled string literal would close the tag early. */
const escapeForScript = (code) => code.replace(/<\/script/gi, "<\\/script")

function pageHtml(sceneCode) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>designlayer — inspector Design tab</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body { background: #f6f7f9; }
</style>
</head>
<body>
<script>${escapeForScript(sceneCode)}</script>
<script>
  // ?theme=light opens the light variant directly, so the page is useful on its
  // own and not only under Playwright.
  var requested = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
  var harness = DesignLayerHarness.mount({ theme: requested });
  window.__panelHarness = {
    handle: harness,
    measure: function () { return DesignLayerHarness.measure(harness.panel); },
  };
  // The inspector renders on a rAF after the selection lands, so the flag the
  // driver waits on is set a frame later — not when mount() returns.
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      document.documentElement.setAttribute("data-harness-ready", "");
    });
  });
</script>
</body>
</html>
`
}

/* ---------- Playwright, wherever it happens to live ---------- */

/**
 * This repo does not depend on Playwright and should not start: the harness is
 * one person's comparison tool, not something `npm test` runs. So the driver
 * looks for an installation rather than requiring one — the local
 * `node_modules` first, then the global roots, where the `@playwright/mcp`
 * server keeps a copy with browsers already downloaded.
 */
async function loadPlaywright() {
  const anchors = []
  const localRequire = createRequire(path.join(ROOT, "package.json"))
  try {
    return { pw: localRequire("playwright"), from: localRequire.resolve("playwright") }
  } catch {
    /* not a dependency here, which is the expected case */
  }

  let globalRoot = null
  try {
    globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim()
  } catch {
    /* npm may not be on PATH in a sandbox */
  }
  for (const root of [globalRoot, "/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"]) {
    if (!root) continue
    anchors.push(path.join(root, "@playwright", "mcp", "cli.js"))
    anchors.push(path.join(root, "playwright", "index.js"))
    anchors.push(path.join(root, "_harness-anchor.js"))
  }

  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      return { pw: req("playwright"), from: req.resolve("playwright") }
    } catch {
      /* try the next one */
    }
  }
  return null
}

/* ---------- the summary the report is written from ---------- */

const only = (rows, className) => rows.filter((row) => row.classes.includes(className))

/**
 * The digest describes what is ON SCREEN, so the hidden Changes and Code panes
 * are dropped before anything is counted: their controls measure 0x0, and a
 * zero mixed into a set of heights reads as a broken control rather than as one
 * parked behind another tab. `measurements.json` keeps every row either way.
 */
function digest(allRows) {
  const rows = allRows.filter((row) => row.visible !== false && !row.within?.hiddenPane)
  const pick = (row) => ({
    text: row.text || row.attrs.ariaLabel || row.attrs.title || "",
    box: `${row.box.width}x${row.box.height}`,
    radius: row.style.borderRadius,
    background: row.style.backgroundColor,
    color: row.style.color,
    fontSize: row.style.fontSize,
    fontWeight: row.style.fontWeight,
    padding: row.style.padding,
    gap: row.style.gap,
    // The pressed states in this chrome are drawn with a ring rather than a
    // fill, so a digest without these two reports "pressed" and "rest" as
    // identical — which is how a real difference gets missed.
    boxShadow: row.style.boxShadow,
    border: `${row.style.borderWidth} ${row.style.borderStyle} ${row.style.borderColor}`,
  })

  const group = (className, extra = () => ({})) => {
    const matched = only(rows, className)
    const heights = [...new Set(matched.map((row) => row.box.height))].sort((a, b) => a - b)
    return {
      count: matched.length,
      heights,
      first: matched[0] ? { ...pick(matched[0]), ...extra(matched[0]) } : null,
    }
  }

  const tally = (subset) => {
    const out = {}
    for (const row of subset) {
      const key = `${row.attrs.svgWidth ?? "?"}x${row.attrs.svgHeight ?? "?"} attr -> ${row.box.width}x${row.box.height} px, stroke ${row.attrs.strokeWidth ?? "?"}`
      out[key] = (out[key] ?? 0) + 1
    }
    return out
  }
  const svgs = rows.filter((row) => row.tag === "svg")
  const svgSizes = tally(svgs)
  const svgSizesInTool = tally(svgs.filter((row) => row.within?.tool))
  const svgSizesInSectionHeader = tally(svgs.filter((row) => row.within?.sectionHeader))

  const pressedSegment = only(rows, "de-segment").find((row) => row.attrs.ariaPressed === "true")
  const restSegment = only(rows, "de-segment").find((row) => row.attrs.ariaPressed === "false")
  const pressedTool = only(rows, "de-tool").find((row) => row.attrs.ariaPressed === "true")
  const restTool = only(rows, "de-tool").find((row) => row.attrs.ariaPressed !== "true")
  const selectedTab = only(rows, "de-tab").find((row) => row.attrs.ariaSelected === "true")

  return {
    panel: rows[0] ? { box: `${rows[0].box.width}x${rows[0].box.height}`, background: rows[0].style.backgroundColor } : null,
    field: group("de-field"),
    fieldLabel: group("de-field-label"),
    fieldInput: (() => {
      const inputs = rows.filter((row) => row.tag === "input")
      return { count: inputs.length, first: inputs[0] ? pick(inputs[0]) : null }
    })(),
    segmented: group("de-segmented"),
    segment: {
      ...group("de-segment"),
      pressed: pressedSegment ? pick(pressedSegment) : null,
      rest: restSegment ? pick(restSegment) : null,
    },
    tool: {
      ...group("de-tool"),
      pressed: pressedTool ? pick(pressedTool) : null,
      rest: restTool ? pick(restTool) : null,
    },
    mini: group("de-mini"),
    tab: { ...group("de-tab"), selected: selectedTab ? pick(selectedTab) : null },
    tabs: group("de-tabs"),
    sectionHeader: group("de-section-header"),
    sectionToggle: group("de-section-toggle"),
    // Where the heading's own box now lives: the toggle is an empty layer over
    // the whole bar, so its metrics describe the bar, not the text.
    sectionTitle: group("de-section-title"),
    sectionBody: group("de-section-body"),
    stack: group("de-stack"),
    row: group("de-row"),
    layoutGroup: group("de-layout-group"),
    layoutGroupTitle: group("de-layout-group-title"),
    rowSplit: group("de-row--split"),
    rowQuad: group("de-row--quad"),
    fieldValue: group("de-field-value"),
    hint: group("de-hint"),
    select: (() => {
      const nodes = rows.filter((row) => row.tag === "select")
      return { count: nodes.length, first: nodes[0] ? pick(nodes[0]) : null }
    })(),
    svgSizes,
    svgSizesInTool,
    svgSizesInSectionHeader,
    // Everything else the panel drew, so a class this digest never thought to
    // name is still one lookup away rather than a re-run of the harness.
    byClass: Object.fromEntries(
      [...new Set(rows.flatMap((row) => row.classes))].sort().map((className) => {
        const matched = only(rows, className)
        return [
          className,
          {
            count: matched.length,
            sizes: [...new Set(matched.map((row) => `${row.box.width}x${row.box.height}`))],
            radius: [...new Set(matched.map((row) => row.style.borderRadius))],
            background: [...new Set(matched.map((row) => row.style.backgroundColor))],
            color: [...new Set(matched.map((row) => row.style.color))],
            fontSize: [...new Set(matched.map((row) => row.style.fontSize))],
            fontWeight: [...new Set(matched.map((row) => row.style.fontWeight))],
            lineHeight: [...new Set(matched.map((row) => row.style.lineHeight))],
            padding: [...new Set(matched.map((row) => row.style.padding))],
            gap: [...new Set(matched.map((row) => row.style.gap))],
            border: [
              ...new Set(
                matched.map((row) => `${row.style.borderWidth} ${row.style.borderStyle} ${row.style.borderColor}`)
              ),
            ],
          },
        ]
      })
    ),
  }
}

/* ---------- run ---------- */

async function main() {
  prepareOutputDir()

  const sceneCode = await bundleScene()
  const htmlPath = path.join(OUT, "panel.html")
  fs.writeFileSync(htmlPath, pageHtml(sceneCode))
  console.log(`Page      ${htmlPath}`)

  if (!wantShots) {
    console.log("Skipped screenshots and measurements (--no-shots).")
    return
  }

  const loaded = await loadPlaywright()
  if (!loaded) {
    console.log("")
    console.log("Playwright is NOT importable from this repo or from any global root.")
    console.log("The page above is self-contained — open it in a browser to see the panel:")
    console.log(`  open "${htmlPath}"            # dark`)
    console.log(`  open "${htmlPath}?theme=light" # light`)
    console.log("No screenshots and no measurements.json were written: both need a real")
    console.log("engine to lay the panel out. Install Playwright (npm i -D playwright) and")
    console.log("re-run to get them.")
    process.exitCode = 0
    return
  }
  console.log(`Playwright ${loaded.from}`)

  const browser = await loaded.pw.chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleErrors.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`))

  await page.goto(pathToFileURL(htmlPath).href)
  await page.waitForSelector("html[data-harness-ready]", { timeout: 15000 })

  if (tab) {
    const shown = await page.evaluate(
      (label) => window.__panelHarness.handle.showTab(label),
      tab
    )
    if (!shown) throw new Error(`no tab named ${tab} — the strip has Design, Changes and Code`)
    // The pane repaints on the frame after the click, and the outbox subscribes
    // to two stores that announce separately.
    await page.waitForTimeout(150)
    console.log(`Tab       ${tab}`)
  }

  if (flags.has("--expand")) {
    const opened = await page.evaluate(() => window.__panelHarness.handle.expandAll())
    await page.waitForTimeout(120)
    console.log(`Expanded  ${opened.length ? opened.join(", ") : "nothing was folded"}`)
  }

  if (collapseTitles.length) {
    const folded = await page.evaluate(
      (titles) => window.__panelHarness.handle.collapse(titles),
      collapseTitles
    )
    console.log(`Collapsed ${folded.length ? folded.join(", ") : "nothing matched"}`)
  }

  // Grow the window until the whole panel is on screen: the tab pane is a
  // scroller, and a clipped screenshot is not something you can measure against
  // a Figma frame.
  const needed = await page.evaluate(() => window.__panelHarness.handle.contentHeight())
  const height = Math.max(900, Math.min(needed, 6000))
  await page.setViewportSize({ width: 1100, height })
  await page.waitForTimeout(120)

  const sections = await page.evaluate(() => window.__panelHarness.handle.sectionTitles())
  const written = []
  const measurements = {
    generatedAt: new Date().toISOString(),
    page: htmlPath,
    deviceScaleFactor: 2,
    viewport: { width: 1100, height },
    inspectorWidth: await page.evaluate(() => window.__panelHarness.handle.inspectorWidth),
    sections,
    themes: {},
  }

  for (const theme of THEMES) {
    await page.evaluate((next) => window.__panelHarness.handle.applyTheme(next), theme)
    await page.waitForTimeout(80)

    const shot = path.join(OUT, `panel-${theme}.png`)
    await page.locator("#harness-panel").screenshot({ path: shot })
    written.push(shot)

    measurements.themes[theme] = await page.evaluate(() => window.__panelHarness.measure())
  }

  const jsonPath = path.join(OUT, "measurements.json")
  fs.writeFileSync(jsonPath, JSON.stringify(measurements, null, 1))

  const summary = {
    generatedAt: measurements.generatedAt,
    sections,
    dark: digest(measurements.themes.dark.rows),
    light: digest(measurements.themes.light.rows),
  }
  const summaryPath = path.join(OUT, "summary.json")
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 1))

  await browser.close()

  for (const file of written) console.log(`Shot      ${file}`)
  console.log(`Measured  ${jsonPath} (${measurements.themes.dark.rows.length} elements per theme)`)
  console.log(`Summary   ${summaryPath}`)
  console.log(`Sections  ${sections.join(", ")}`)
  if (consoleErrors.length) {
    console.log("Console:")
    for (const line of [...new Set(consoleErrors)].slice(0, 10)) console.log(`  ${line}`)
  }

  if (flags.has("--open")) execFileSync("open", [htmlPath])
}

await main()
