/**
 * DESIGN.md and landing/DESIGN.md copy their token values from code, and a
 * copy drifts. These cases hold every frontmatter value to its source:
 *
 *   DESIGN.md          -> src/core/tokens.ts (`themeDeclarations(theme)` for
 *                         colors, `tokens` for type, radius and space)
 *   landing/DESIGN.md  -> landing/styles.css (`:root` custom properties and
 *                         the rules the Colors/Typography/Shapes sections name)
 *
 * The mapping tables below are the contract, one row per frontmatter token.
 * A token with no row fails, a row whose source is gone fails, a row with no
 * token fails, and a value that differs fails. Values compare after
 * whitespace normalization, so `color-mix(in srgb, a 10%, b)` and its
 * reflowed twin are equal and nothing else is.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

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

// ───────────────────────────────────────────────────────── frontmatter ────

/**
 * The YAML subset both files use: nested maps by two-space indentation,
 * `#` comments, plain scalars, and single- or double-quoted strings. Scalars
 * stay strings ("400", "1.333"), because the comparison is textual.
 */
export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) throw new Error("no YAML frontmatter at the top of the file")
  const root = {}
  const stack = [{ indent: -1, node: root }]
  for (const [index, raw] of match[1].split("\n").entries()) {
    if (/^\s*(#.*)?$/.test(raw)) continue
    const line = /^( *)([^\s:#][^:]*?):(?:\s+(.*))?$/.exec(raw)
    if (!line) throw new Error(`frontmatter line ${index + 2} is outside the parsed subset: ${raw}`)
    const [, spaces, key, rest = ""] = line
    const indent = spaces.length
    while (stack.at(-1).indent >= indent) stack.pop()
    const parent = stack.at(-1).node
    if (rest === "") {
      parent[key] = {}
      stack.push({ indent, node: parent[key] })
    } else {
      parent[key] = scalar(rest, index + 2)
    }
  }
  return root
}

function scalar(text, lineNumber) {
  if (text.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(text)
    if (!m) throw new Error(`unterminated double-quoted string on frontmatter line ${lineNumber}`)
    return m[1].replace(/\\(.)/g, "$1")
  }
  if (text.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(text)
    if (!m) throw new Error(`unterminated single-quoted string on frontmatter line ${lineNumber}`)
    return m[1].replace(/''/g, "'")
  }
  return text.replace(/\s+#.*$/, "").trim()
}

/** `colors.primary`, `typography.body.fontSize`, ... for the four checked groups. */
function flattenTokens(frontmatter) {
  const out = new Map()
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const name = prefix ? `${prefix}.${key}` : key
      if (typeof value === "object") walk(value, name)
      else out.set(name, value)
    }
  }
  for (const group of ["colors", "typography", "rounded", "spacing"]) {
    if (frontmatter[group]) walk(frontmatter[group], group)
  }
  return out
}

/** Whitespace is not a difference; everything else is. */
export const normalize = (value) =>
  String(value)
    .replace(/\s+/g, " ")
    .replace(/\s*([(),/])\s*/g, "$1")
    .trim()

/**
 * The one comparison both files go through. `table` maps a token name to a
 * function that returns the source value (or throws when the source is gone),
 * optionally `{ value, compare }` when the stored form is a conversion.
 */
export function compareTokens(designMd, table) {
  const problems = []
  const tokens = flattenTokens(parseFrontmatter(designMd))
  for (const [name, stored] of tokens) {
    const row = table[name]
    if (!row) {
      problems.push(`${name}: no mapping row; add one to test/design-md-cases.mjs`)
      continue
    }
    let source
    try {
      source = row()
    } catch (error) {
      problems.push(`${name}: source is gone (${error.message})`)
      continue
    }
    if (source === undefined || source === null) {
      problems.push(`${name}: source is gone (resolved to ${source})`)
      continue
    }
    if (typeof source === "object") {
      const verdict = source.compare(stored)
      if (verdict) problems.push(`${name}: DESIGN.md has ${JSON.stringify(stored)}, ${verdict}`)
    } else if (normalize(stored) !== normalize(source)) {
      problems.push(
        `${name}: DESIGN.md has ${JSON.stringify(stored)}, source has ${JSON.stringify(String(source))}`
      )
    }
  }
  for (const name of Object.keys(table)) {
    if (!tokens.has(name)) problems.push(`${name}: mapping row has no frontmatter token; remove the row`)
  }
  return problems
}

// ─────────────────────────────────────────────────────────── the editor ────

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `export { tokens, themeDeclarations } from "./src/core/tokens"`,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const { tokens, themeDeclarations } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

/** `--de-color-accent` -> its value, per theme, from the declarations the editor emits. */
const declared = {}
for (const theme of ["dark", "light"]) {
  declared[theme] = new Map(
    themeDeclarations(theme, "")
      .split("\n")
      .map((line) => /^(--[\w-]+):\s*(.*);$/.exec(line))
      .filter(Boolean)
      .map(([, property, value]) => [property, value])
  )
}

/** A palette role in one theme, by the custom property `tokens.ts` derives for it. */
function role(theme, name) {
  const property = `--de-color-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
  return () => {
    if (!declared[theme].has(property)) throw new Error(`no ${property} in themeDeclarations("${theme}")`)
    return declared[theme].get(property)
  }
}

/** A literal from `tokens`, by path: `at("type.weightBody")`. */
function at(dotted, suffix = "") {
  return () => {
    let node = tokens
    for (const key of dotted.split(".")) {
      if (node === undefined || !(key in node)) throw new Error(`no tokens.${dotted} in src/core/tokens.ts`)
      node = node[key]
    }
    return `${node}${suffix}`
  }
}

/** DESIGN.md token -> source expression in src/core/tokens.ts. */
const EDITOR = {
  // Dark theme (the default): PALETTE.color, dark column.
  "colors.primary": role("dark", "accent"),
  "colors.primary-fill": role("dark", "accentSurface"),
  "colors.primary-fill-hover": role("dark", "accentSurfaceHover"),
  "colors.primary-text": role("dark", "accentText"),
  "colors.on-primary": role("dark", "onAccent"),
  "colors.primary-soft": role("dark", "accentSoft"),
  "colors.primary-soft-muted": role("dark", "rowSelectedMuted"),
  "colors.primary-halo": role("dark", "accentHalo"),
  "colors.selection": role("dark", "selectionSurface"),
  "colors.surface": role("dark", "bg"),
  "colors.surface-raised": role("dark", "bgRaised"),
  "colors.surface-raised-hover": role("dark", "bgRaisedHover"),
  "colors.surface-sunken": role("dark", "bgSunken"),
  "colors.surface-hover-quiet": role("dark", "bgHoverQuiet"),
  "colors.segment-selected": role("dark", "segmentSelected"),
  "colors.tab-selected": role("dark", "tabSelected"),
  "colors.ink": role("dark", "text"),
  "colors.ink-muted": role("dark", "textMuted"),
  "colors.ink-dim": role("dark", "textDim"),
  "colors.ink-disabled": role("dark", "textDisabled"),
  "colors.border": role("dark", "border"),
  "colors.border-strong": role("dark", "borderStrong"),
  "colors.border-interactive": role("dark", "borderInteractive"),
  "colors.hairline": role("dark", "hairline"),
  "colors.success": role("dark", "success"),
  "colors.danger": role("dark", "danger"),
  "colors.danger-wash": role("dark", "dangerWash"),
  "colors.lint-warning": role("dark", "lintWarning"),
  "colors.component": role("dark", "component"),
  "colors.guide": role("dark", "guide"),
  "colors.focus-core": role("dark", "focusCore"),
  "colors.focus-halo": role("dark", "focusHalo"),
  "colors.scrim": role("dark", "scrim"),
  // Light theme: the same PALETTE rows, light column, under `light-`.
  "colors.light-primary": role("light", "accent"),
  "colors.light-primary-hover": role("light", "accentSurfaceHover"),
  "colors.light-primary-soft": role("light", "accentSoft"),
  "colors.light-surface": role("light", "bg"),
  "colors.light-secondary": role("light", "bgSunken"),
  "colors.light-secondary-hover": role("light", "segmentSelected"),
  "colors.light-muted": role("light", "bgHoverQuiet"),
  "colors.light-border": role("light", "border"),
  "colors.light-ink": role("light", "text"),
  "colors.light-ink-dim": role("light", "textDim"),
  "colors.light-success": role("light", "success"),
  "colors.light-danger": role("light", "danger"),
  "colors.light-lint-warning": role("light", "lintWarning"),
  "colors.light-component": role("light", "component"),
  "colors.light-guide": role("light", "guide"),
  // Type roles: tokens.font and tokens.type.
  "typography.body.fontFamily": at("font.ui"),
  "typography.body.fontSize": at("type.body"),
  "typography.body.fontWeight": at("type.weightBody"),
  "typography.body.lineHeight": at("type.leadingRow"),
  "typography.value.fontFamily": at("font.ui"),
  "typography.value.fontSize": at("type.body"),
  "typography.value.fontWeight": at("type.weightValue"),
  "typography.value.lineHeight": at("type.leadingRow"),
  "typography.section.fontFamily": at("font.ui"),
  "typography.section.fontSize": at("type.body"),
  "typography.section.fontWeight": at("type.weightSection"),
  "typography.section.lineHeight": at("type.leadingRow"),
  "typography.title.fontFamily": at("font.ui"),
  "typography.title.fontSize": at("type.body"),
  "typography.title.fontWeight": at("type.weightTitle"),
  "typography.title.lineHeight": at("type.leadingRow"),
  "typography.title.letterSpacing": at("type.trackingTitle"),
  "typography.body-relaxed.fontFamily": at("font.ui"),
  "typography.body-relaxed.fontSize": at("type.body"),
  "typography.body-relaxed.fontWeight": at("type.weightBody"),
  "typography.body-relaxed.lineHeight": at("type.leadingBody"),
  "typography.eyebrow.fontFamily": at("font.ui"),
  "typography.eyebrow.fontSize": at("type.micro"),
  "typography.eyebrow.fontWeight": at("type.weightSection"),
  "typography.eyebrow.letterSpacing": at("type.trackingEyebrow"),
  "typography.micro.fontFamily": at("font.ui"),
  "typography.micro.fontSize": at("type.micro"),
  "typography.code.fontFamily": at("font.mono"),
  "typography.code.fontSize": at("type.body"),
  "typography.code.lineHeight": at("type.leadingCode"),
  // tokens.radius, under the kit's own names.
  ...Object.fromEntries(
    ["xs", "sm", "md", "lg", "2xl", "3xl", "5xl", "6xl", "7xl"].map((k) => [`rounded.${k}`, at(`radius.${k}`)])
  ),
  // tokens.space: numbers in code, `px` where written.
  ...Object.fromEntries(
    ["3xs", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl"].map((k) => [
      `spacing.${k}`,
      at(`space.${k}`, "px"),
    ])
  ),
}

// ──────────────────────────────────────────────────────────── the landing ────

/**
 * Enough CSS for this lookup: rules with their @media context and their
 * declarations, comments stripped, strings and parentheses respected.
 */
export function parseCss(text) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "")
  const rules = []
  let i = 0
  function block(media) {
    const declarations = []
    let buffer = ""
    let parens = 0
    while (i < css.length) {
      const c = css[i++]
      if (c === '"' || c === "'") {
        const end = css.indexOf(c, i)
        buffer += c + css.slice(i, end + 1)
        i = end + 1
      } else if (c === "(") {
        parens += 1
        buffer += c
      } else if (c === ")") {
        parens -= 1
        buffer += c
      } else if (c === "{" && parens === 0) {
        const prelude = buffer.trim().replace(/\s+/g, " ")
        buffer = ""
        const inner = /^@(media|supports|container)\b/.test(prelude) ? [...media, prelude] : media
        const nested = block(inner)
        rules.push({ selector: prelude, media: inner, declarations: nested })
      } else if (c === ";" && parens === 0) {
        if (buffer.trim()) declarations.push(buffer.trim())
        buffer = ""
      } else if (c === "}" && parens === 0) {
        if (buffer.trim()) declarations.push(buffer.trim())
        return declarations.map((d) => {
          const colon = d.indexOf(":")
          return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()]
        })
      } else {
        buffer += c
      }
    }
    return []
  }
  block([])
  return rules
}

const landingCss = fs.readFileSync(path.join(PACKAGE_DIR, "landing/styles.css"), "utf8")

/**
 * The cascade-last value of `property` across the rules whose selector is
 * exactly `selector` (one selector per rule, not a list) in `media`.
 */
function cssValue(rules, selector, property, media = "") {
  let value
  for (const rule of rules) {
    if (rule.selector !== selector || rule.media.join(" ") !== media) continue
    for (const [name, v] of rule.declarations) if (name === property) value = v
  }
  if (value === undefined) {
    throw new Error(`no ${property} in \`${selector}\`${media ? ` inside ${media}` : ""} in landing/styles.css`)
  }
  return value
}

/** `var(--x)` -> its `:root` value, recursively, for font stacks and calc(). */
function resolveVars(rules, value, local = {}) {
  return value.replace(/var\((--[\w-]+)\)/g, (_, name) =>
    resolveVars(rules, local[name] ?? cssValue(rules, ":root", name), local)
  )
}

/** A px-only calc() of sums and differences, for the two derived radii. */
function evalPxCalc(value) {
  const body = /^calc\((.*)\)$/.exec(value)?.[1]
  if (!body) return value
  const terms = body.match(/[+-]?\s*\d*\.?\d+px/g) ?? []
  const leftover = body.replace(/[+-]?\s*\d*\.?\d+px/g, "").trim()
  if (leftover) throw new Error(`calc() is not a px sum: ${value}`)
  return `${terms.reduce((sum, t) => sum + Number(t.replace(/\s|px/g, "")), 0)}px`
}

/** The third argument of clamp(min, preferred, max). */
function clampMax(value) {
  const m = /^clamp\(.*,\s*([^,]+)\)$/.exec(value)
  if (!m) throw new Error(`not a clamp(): ${value}`)
  return m[1].trim()
}

/** One part of a `font` shorthand written `weight size/line-height family`. */
function fontPart(value, part) {
  const m = /^(\d+)\s+([\d.]+px)\/([\d.]+)\s+(.+)$/.exec(value)
  if (!m) throw new Error(`font shorthand outside the weight size/leading family form: ${value}`)
  return { weight: m[1], size: m[2], leading: m[3], family: m[4] }[part]
}

/** The nth color stop of a linear-gradient(a, b) with no angle. */
function gradientStop(value, n) {
  const m = /^linear-gradient\((.*)\)$/.exec(value)
  if (!m) throw new Error(`not a linear-gradient(): ${value}`)
  return m[1].split(",")[n].trim()
}

// OKLab, for `color-mix(in oklab, ...)` — Björn Ottosson's reference matrices.
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
function hexToOklab(hex) {
  const n = hex.replace("#", "")
  const full = n.length === 3 ? [...n].map((d) => d + d).join("") : n
  const [r, g, b] = [0, 2, 4].map((o) => toLinear(parseInt(full.slice(o, o + 2), 16) / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.round(Math.min(1, Math.max(0, toGamma(c))) * 255))
}

/**
 * Known Gap: the design.md linter takes `color-mix()` only in srgb, so the
 * landing pills store the sRGB result of the stylesheet's oklab mix. The row
 * recomputes that mix from styles.css and allows ±1 per channel for rounding;
 * a changed `--accent-fill` or percentage still fails.
 */
function oklabMixAsHex(rules, selector, property, media = "") {
  return () => {
    const mix = resolveVars(rules, cssValue(rules, selector, property, media))
    const m = /^color-mix\(in oklab,\s*(#[0-9a-f]{3,6})\s+([\d.]+)%,\s*(#[0-9a-f]{3,6})\)$/i.exec(mix)
    if (!m) throw new Error(`\`${selector}\` ${property} is no longer color-mix(in oklab, #hex N%, #hex): ${mix}`)
    const [a, p, b] = [hexToOklab(m[1]), Number(m[2]) / 100, hexToOklab(m[3])]
    const rgb = oklabToRgb(a.map((v, k) => v * p + b[k] * (1 - p)))
    const hex = `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`
    return {
      compare(stored) {
        const want = /^#([0-9a-f]{6})$/i.exec(stored)
        if (!want) return `expected a 6-digit hex for ${mix} (${hex})`
        const got = [0, 2, 4].map((o) => parseInt(want[1].slice(o, o + 2), 16))
        const off = got.some((c, k) => Math.abs(c - rgb[k]) > 1)
        return off ? `styles.css ${mix} converts to ${hex}` : null
      },
    }
  }
}

/** DESIGN.md token -> source expression in landing/styles.css. */
function landingTable(rules) {
  const root = (name) => () => cssValue(rules, ":root", name)
  const rule = (selector, property, media) => () => cssValue(rules, selector, property, media)
  const family = (selector) => () => resolveVars(rules, cssValue(rules, selector, "font-family"))
  const clamped = (selector) => () => clampMax(cssValue(rules, selector, "font-size"))
  const btnFont = (part) => () => {
    const v = fontPart(cssValue(rules, ".btn", "font"), part)
    return part === "family" ? resolveVars(rules, v) : v
  }
  return {
    // :root (styles.css:31-45).
    "colors.primary": root("--accent"),
    "colors.primary-text": root("--accent-text"),
    "colors.primary-fill": root("--accent-fill"),
    "colors.primary-glow": root("--accent-glow"),
    "colors.canvas": root("--bg"),
    "colors.line": root("--line"),
    "colors.line-strong": root("--line-strong"),
    "colors.ink": root("--text"),
    "colors.ink-2": root("--text-2"),
    "colors.ink-3": root("--text-3"),
    "colors.add": root("--add"),
    // Rules named by the Colors section.
    "colors.white": rule(".btn-primary:hover", "background"),
    "colors.on-white": rule(".btn-primary", "color"),
    "colors.pill": oklabMixAsHex(rules, ".token", "--pill"),
    "colors.pill-hover": oklabMixAsHex(rules, "button.token:hover", "--pill", "@media (hover: hover) and (pointer: fine)"),
    "colors.pill-active": oklabMixAsHex(rules, "button.token:active", "--pill"),
    "colors.sticker-ground-top": () => gradientStop(cssValue(rules, "span.token-art", "background"), 0),
    "colors.sticker-ground": () => gradientStop(cssValue(rules, "span.token-art", "background"), 1),
    "colors.sticker-glyph": rule("span.token-art", "color"),
    "colors.nav-frost": rule(".nav::before", "background"),
    // Typography: display sizes hold the clamp's maximum (Known Gaps).
    "typography.display.fontFamily": family("h1"),
    "typography.display.fontSize": clamped("h1"),
    "typography.display.fontWeight": rule("h1", "font-weight"),
    "typography.display.lineHeight": rule("h1", "line-height"),
    "typography.display.letterSpacing": rule("h1", "letter-spacing"),
    "typography.headline.fontFamily": family("h2"),
    "typography.headline.fontSize": clamped("h2"),
    "typography.headline.fontWeight": rule("h2", "font-weight"),
    "typography.headline.lineHeight": rule("h2", "line-height"),
    "typography.headline.letterSpacing": rule("h2", "letter-spacing"),
    "typography.stat.fontFamily": family(".facts dt"),
    "typography.stat.fontSize": clamped(".facts dt"),
    "typography.stat.fontWeight": rule(".facts dt", "font-weight"),
    "typography.stat.lineHeight": rule(".facts dt", "line-height"),
    "typography.stat.letterSpacing": rule(".facts dt", "letter-spacing"),
    "typography.card-title.fontFamily": family(".path h3"),
    "typography.card-title.fontSize": rule(".path h3", "font-size"),
    "typography.card-title.fontWeight": rule(".path h3", "font-weight"),
    "typography.card-title.letterSpacing": rule(".path h3", "letter-spacing"),
    "typography.body.fontFamily": family("body"),
    "typography.body.fontSize": rule("body", "font-size"),
    "typography.body.lineHeight": rule("body", "line-height"),
    "typography.body.fontFeature": rule("body", "font-feature-settings"),
    // `.facts dd` inherits the body's family, which is `--font`.
    "typography.body-sm.fontFamily": () => resolveVars(rules, "var(--font)"),
    "typography.body-sm.fontSize": rule(".facts dd", "font-size"),
    "typography.body-sm.lineHeight": rule(".facts dd", "line-height"),
    "typography.button.fontFamily": btnFont("family"),
    "typography.button.fontSize": btnFont("size"),
    "typography.button.fontWeight": btnFont("weight"),
    "typography.button.lineHeight": btnFont("leading"),
    "typography.button.letterSpacing": rule(".btn", "letter-spacing"),
    // Shapes.
    "rounded.control": root("--radius-control"),
    "rounded.shot": root("--radius-shot"),
    "rounded.frame": () => evalPxCalc(resolveVars(rules, cssValue(rules, ":root", "--radius-frame"))),
    "rounded.tweak": rule(".tweak-track", "border-radius"),
    "rounded.wheel-frame": rule(".wheel-frame", "border-radius"),
    // The slider thumb's `calc(8px - var(--inset))` takes `--inset` from `.tweak-track`.
    "rounded.thumb": () =>
      evalPxCalc(
        resolveVars(rules, cssValue(rules, ".tweak-thumb", "border-radius"), {
          "--inset": cssValue(rules, ".tweak-track", "--inset"),
        })
      ),
    "rounded.sticker": rule(".token", "--art-radius"),
    // Layout (styles.css:51-58) and insets.
    "spacing.wrap": root("--wrap"),
    "spacing.wrap-wide": root("--wrap-wide"),
    "spacing.gutter": root("--gutter"),
    "spacing.section": root("--section"),
    "spacing.frame-inset": root("--frame-inset"),
    "spacing.tweak-inset": rule(".tweak-track", "--inset"),
  }
}

// ────────────────────────────────────────────────────────────── cases ────

const editorMd = fs.readFileSync(path.join(PACKAGE_DIR, "DESIGN.md"), "utf8")
const landingMd = fs.readFileSync(path.join(PACKAGE_DIR, "landing/DESIGN.md"), "utf8")
const landingRules = parseCss(landingCss)
const LANDING = landingTable(landingRules)

/** Problems a drifted copy adds over the real file, so each case names only its own. */
const added = (problems, baseline) => problems.filter((p) => !baseline.includes(p))
const editorBaseline = compareTokens(editorMd, EDITOR)
const landingBaseline = compareTokens(landingMd, LANDING)

const report = (problems) => `${problems.length} drifted:\n       ${problems.join("\n       ")}`

check(`DESIGN.md frontmatter equals src/core/tokens.ts (${Object.keys(EDITOR).length} mapped tokens)`, () => {
  const problems = editorBaseline
  assert.equal(problems.length, 0, report(problems))
})

check(`landing/DESIGN.md frontmatter equals landing/styles.css (${Object.keys(LANDING).length} mapped tokens)`, () => {
  const problems = landingBaseline
  assert.equal(problems.length, 0, report(problems))
})

// The check itself can fail. Each case drifts an in-memory copy, never the file.

check("a changed editor value fails with both values named", () => {
  const drifted = editorMd.replace('  primary: "#798cff"', '  primary: "#798cfe"')
  assert.notEqual(drifted, editorMd, "the fixture line moved; update this case")
  assert.deepEqual(added(compareTokens(drifted, EDITOR), editorBaseline), [
    'colors.primary: DESIGN.md has "#798cfe", source has "#798cff"',
  ])
})

check("a reflowed color-mix() is not a difference", () => {
  const reflowed = editorMd.replace(
    '"color-mix(in srgb, #ffffff 12%, #171717)"',
    '"color-mix( in srgb,  #ffffff 12% , #171717 )"'
  )
  assert.notEqual(reflowed, editorMd, "the fixture line moved; update this case")
  assert.deepEqual(added(compareTokens(reflowed, EDITOR), editorBaseline), [])
})

check("an unmapped token, a stale row, and a missing source each fail", () => {
  const extra = editorMd.replace("colors:\n", 'colors:\n  brand-new: "#000000"\n')
  assert.deepEqual(added(compareTokens(extra, EDITOR), editorBaseline), [
    "colors.brand-new: no mapping row; add one to test/design-md-cases.mjs",
  ])
  const stale = { ...EDITOR, "colors.retired": role("dark", "accent") }
  assert.deepEqual(added(compareTokens(editorMd, stale), editorBaseline), [
    "colors.retired: mapping row has no frontmatter token; remove the row",
  ])
  const gone = { ...EDITOR, "colors.primary": role("dark", "accentRetired") }
  assert.deepEqual(added(compareTokens(editorMd, gone), editorBaseline), [
    'colors.primary: source is gone (no --de-color-accent-retired in themeDeclarations("dark"))',
  ])
})

check("a changed landing value and a moved accent-fill both fail", () => {
  const drifted = landingMd.replace('  ink-2: "#a1a1aa"', '  ink-2: "#a1a1ab"')
  assert.deepEqual(added(compareTokens(drifted, LANDING), landingBaseline), [
    'colors.ink-2: DESIGN.md has "#a1a1ab", source has "#a1a1aa"',
  ])
  const rules = parseCss(landingCss.replace("--accent-fill: #4a5df9;", "--accent-fill: #5a5df9;"))
  const problems = compareTokens(landingMd, landingTable(rules))
  assert.ok(problems.some((p) => p.startsWith("colors.pill: ")), report(problems))
  assert.ok(problems.some((p) => p.startsWith("colors.primary-fill: ")), report(problems))
})

check("a landing rule that loses its declaration reports the source as gone", () => {
  const rules = parseCss(landingCss.replace("  --art-radius: 0.175em;\n", ""))
  assert.deepEqual(added(compareTokens(landingMd, landingTable(rules)), landingBaseline), [
    "rounded.sticker: source is gone (no --art-radius in `.token` in landing/styles.css)",
  ])
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
