/**
 * A budget for the chrome's motion, so a polish pass cannot quietly cost speed.
 *
 * ## What this measures and why these numbers
 *
 * The editor is injected into somebody else's running app. Every byte of CSS is
 * parsed on their page, every animated property competes with their paint, and
 * the canvas overlay re-reads geometry on a rAF loop while anything is
 * selected. So the three things worth watching are SIZE, what gets animated,
 * and whether anything animates a property that forces layout.
 *
 * The ceilings below are not aspirations, they are the measured values at the
 * time this file was written plus a little headroom. The point is not to hit a
 * target; it is that adding motion without noticing is impossible.
 *
 * Run: `node tools/motion-budget.mjs [--json] [--update]`
 */

import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Properties that cannot be animated cheaply, because the compositor cannot do
 * them alone — each frame costs a layout or a full paint of the element.
 *
 * `height` and `width` are on the list and are deliberately allowed in two
 * places (a row leaving a list, a disclosure opening), because there is no
 * compositor-only way to animate an unknown content height and the alternative
 * is no motion at all. The budget records the count rather than banning them,
 * so a third instance is a decision somebody makes on purpose.
 */
const EXPENSIVE = ["width", "max-width", "height", "max-height", "top", "left", "right", "bottom", "margin", "padding", "border-width"]

/** Properties the compositor can animate on its own thread, plus the discrete top-layer pair (`display`, `overlay`) a dialog exit keeps alive. */
const CHEAP = ["opacity", "transform", "scale", "translate", "rotate", "filter", "box-shadow", "color", "background", "background-color", "border-color", "outline", "grid-template-rows", "display", "visibility", "overlay", "stroke-width"]

async function collectCss() {
  const result = await build({
    stdin: {
      contents: `
        import { shellCss, vendorChromeCss } from "./src/core/css"
        export const css = shellCss + vendorChromeCss
      `,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    write: false,
    platform: "neutral",
  })
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  )
  return mod.css
}

/**
 * Comments stripped, because this file's own prose is full of the words it
 * greps for — the stylesheet documents its motion at length, and counting
 * `transition:` inside a paragraph explaining a transition would measure the
 * writing rather than the CSS.
 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "")
}

/** Every `transition:` shorthand, split into the properties it actually names. */
function transitionedProperties(css) {
  const found = new Map()
  for (const match of css.matchAll(/transition:\s*([^;}]+)[;}]/g)) {
    const body = match[1]
    if (/^\s*none\s*$/.test(body)) continue
    // Split on top-level commas only: `cubic-bezier(0.32, 0.72, 0, 1)` has three
    // of its own, and splitting naively counts `0.72` as an animated property.
    const parts = []
    let depth = 0
    let current = ""
    for (const char of body) {
      if (char === "(") depth += 1
      if (char === ")") depth -= 1
      if (char === "," && depth === 0) {
        parts.push(current)
        current = ""
        continue
      }
      current += char
    }
    parts.push(current)
    for (const part of parts) {
      const name = part.trim().split(/\s+/)[0]
      if (!name || name === "all") {
        // `transition: all` is the one value worth failing on outright: it
        // animates properties nobody chose, including expensive ones added later.
        found.set("all", (found.get("all") ?? 0) + 1)
        continue
      }
      found.set(name, (found.get(name) ?? 0) + 1)
    }
  }
  return found
}

const css = stripComments(await collectCss())
const props = transitionedProperties(css)

/*
 * THE GUARD CHECKS ITSELF, because a guard that under-reports is worse than no
 * guard at all.
 *
 * A sibling tool in this repo spent an hour reporting green over half a
 * stylesheet: its regex resumed from the previous match's closing brace, so it
 * examined every other rule and said nothing was wrong. Nothing about the
 * output looked different.
 *
 * `transitionedProperties` walks with `matchAll`, which is vulnerable to the
 * same class of mistake the moment anyone edits the pattern. Counting the
 * occurrences independently and comparing is two lines and removes the whole
 * failure mode: if the walk ever skips a declaration, the tool says so instead
 * of quietly measuring less than it claims.
 */
const occurrences = (css.match(/transition:/g) ?? []).length
const walked = [...css.matchAll(/transition:\s*([^;}]+)[;}]/g)].length
if (occurrences !== walked) {
  console.error(
    `\n  COVERAGE BUG — ${occurrences} \`transition:\` declarations exist but the ` +
      `walk examined ${walked}. The budget below is measuring less than the stylesheet.\n`
  )
  process.exit(1)
}

const isCustom = (name) => name.startsWith("--")
const expensive = [...props].filter(([name]) => EXPENSIVE.includes(name))
const unknown = [...props].filter(
  ([name]) => !EXPENSIVE.includes(name) && !CHEAP.includes(name) && !isCustom(name)
)
/*
 * The palette roles are counted apart from everything else. There are 45 of
 * them in one declaration on `:root` and they are all colours, so they are
 * cheap — but a single number is the wrong way to see them: if that count ever
 * drifts from the number of roles in `PALETTE`, a role has silently dropped out
 * of the theme crossfade.
 */
const customProperties = [...props].filter(([name]) => isCustom(name)).length

const report = {
  cssBytes: css.length,
  bundleBytes: fs.existsSync(path.join(ROOT, "dist/designlayer.js"))
    ? fs.statSync(path.join(ROOT, "dist/designlayer.js")).size
    : 0,
  rules: (css.match(/\{/g) ?? []).length,
  transitionDeclarations: (css.match(/transition:/g) ?? []).length,
  animationDeclarations: (css.match(/animation:/g) ?? []).length,
  keyframes: (css.match(/@keyframes/g) ?? []).length,
  infiniteAnimations: (css.match(/\binfinite\b/g) ?? []).length,
  transitionAll: props.get("all") ?? 0,
  paletteRolesInCrossfade: customProperties,
  expensiveProperties: Object.fromEntries(expensive),
  unknownProperties: Object.fromEntries(unknown),
}

const BUDGET_PATH = path.join(ROOT, "tools/motion-budget.json")
if (process.argv.includes("--update")) {
  fs.writeFileSync(BUDGET_PATH, `${JSON.stringify(report, null, 2)}\n`)
  console.log("budget written to tools/motion-budget.json")
  process.exit(0)
}
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const budget = fs.existsSync(BUDGET_PATH) ? JSON.parse(fs.readFileSync(BUDGET_PATH, "utf8")) : null

console.log("\nMotion budget")
console.log(`  CSS                    ${report.cssBytes.toLocaleString()} bytes`)
console.log(`  rules                  ${report.rules}`)
console.log(`  transition:            ${report.transitionDeclarations}`)
console.log(`  animation:             ${report.animationDeclarations}  (${report.infiniteAnimations} infinite)`)
console.log(`  @keyframes             ${report.keyframes}`)
console.log(`  transition: all        ${report.transitionAll}`)
console.log(`  palette roles faded    ${report.paletteRolesInCrossfade}`)
console.log(`  layout-costing props   ${Object.entries(report.expensiveProperties).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`)
if (Object.keys(report.unknownProperties).length) {
  console.log(`  unclassified           ${Object.keys(report.unknownProperties).join(", ")}`)
}

let failed = 0
const check = (name, ok, detail) => {
  if (ok) return
  failed += 1
  console.log(`  FAIL ${name} — ${detail}`)
}

check(
  "no transition: all",
  report.transitionAll === 0,
  `${report.transitionAll} found; it animates properties nobody chose`
)

if (budget) {
  const grew = (key, slack) => report[key] > budget[key] + slack
  check("CSS size", !grew("cssBytes", 4096), `${report.cssBytes} vs budget ${budget.cssBytes} (+4096 allowed)`)
  check(
    "layout-costing animations",
    Object.values(report.expensiveProperties).reduce((a, b) => a + b, 0) <=
      Object.values(budget.expensiveProperties).reduce((a, b) => a + b, 0),
    `${JSON.stringify(report.expensiveProperties)} vs budget ${JSON.stringify(budget.expensiveProperties)}`
  )
  check(
    "infinite animations",
    report.infiniteAnimations <= budget.infiniteAnimations,
    `${report.infiniteAnimations} vs budget ${budget.infiniteAnimations} — each one runs forever on someone else's page`
  )
  console.log(
    `\n  against budget: CSS ${report.cssBytes - budget.cssBytes >= 0 ? "+" : ""}${report.cssBytes - budget.cssBytes} bytes, ` +
      `transitions ${report.transitionDeclarations - budget.transitionDeclarations >= 0 ? "+" : ""}${report.transitionDeclarations - budget.transitionDeclarations}`
  )
} else {
  console.log("\n  no budget recorded yet — run with --update to set one")
}

console.log(failed ? `\n${failed} over budget\n` : "\nwithin budget\n")
if (failed) process.exitCode = 1
