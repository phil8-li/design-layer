/**
 * DESIGN.md copies its token values from code, and a copy drifts. These cases
 * hold every frontmatter value to its source: src/core/tokens.ts
 * (`themeDeclarations(theme)` for colors, `tokens` for type, radius and space).
 * The landing page's DESIGN.md is held to its stylesheet the same way in
 * phil8-li/design-layer-landing-page.
 *
 * The mapping table below is the contract, one row per frontmatter token.
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
 * The YAML subset DESIGN.md uses: nested maps by two-space indentation,
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
 * The one comparison every token goes through. `table` maps a token name to a
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

// ────────────────────────────────────────────────────────────── cases ────

const editorMd = fs.readFileSync(path.join(PACKAGE_DIR, "DESIGN.md"), "utf8")

/** Problems a drifted copy adds over the real file, so each case names only its own. */
const added = (problems, baseline) => problems.filter((p) => !baseline.includes(p))
const editorBaseline = compareTokens(editorMd, EDITOR)

const report = (problems) => `${problems.length} drifted:\n       ${problems.join("\n       ")}`

check(`DESIGN.md frontmatter equals src/core/tokens.ts (${Object.keys(EDITOR).length} mapped tokens)`, () => {
  const problems = editorBaseline
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

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
