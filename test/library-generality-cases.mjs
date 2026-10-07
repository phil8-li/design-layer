/**
 * One parser, any house style — and nothing in the implementation that knows
 * whose house it is.
 *
 * The Libraries feature makes one claim above all the others: point it at ANY
 * React or Angular design system and it reads THAT system, not the one the
 * feature happened to be developed against. Every other suite here checks that
 * a rule produces the right answer for the input in front of it. None of them
 * can see the thing that actually erodes the claim, because the erosion looks
 * like a bug fix at every step.
 *
 * It goes like this. Somebody adds a library and a token is missing. They open
 * the stylesheet, read the vendor's spelling off it, and teach the classifier
 * that spelling. The failing case passes, the diff is three characters, the
 * review is unremarkable — and the feature is now correct for one design
 * system and no more general than it was an hour ago, because the next system
 * spells its corner radius differently and nothing in the suite has an opinion
 * about that. Two or three of those and "reads any design system" is
 * marketing: it is true of the house the fixes came from and false everywhere
 * else, and the only person who finds out is a designer whose inspector is
 * mysteriously empty.
 *
 * So there are two guards here, and they attack the same decay from opposite
 * ends:
 *
 *  - the vocabulary scan reads every source file under `server/` and `src/`
 *    and fails on a design-system-specific token prefix or brand name. A hit
 *    is not a style nit and is not fixed by renaming the variable that carries
 *    it: it is the feature narrowing to one vendor in the one place the
 *    narrowing is invisible, because the rule that special-cases a house still
 *    passes every test written against that house. The plain English a token
 *    vocabulary is built from — `color`, `corner`, `spacing`, `shadow`,
 *    `duration` — belongs to nobody, and is the only thing the rules are
 *    allowed to say. If a vendor's spelling is what makes a case pass, the
 *    rule is wrong and generalising it is the fix;
 *  - four synthetic stylesheets, written in four conventions that disagree
 *    about nearly everything, all have to yield a usable catalog. The type
 *    word leads the name; the type word sits in the middle behind a vendor
 *    namespace; there is no type word anywhere and only the value gives the
 *    token away; every value is an alias into some other layer. Each of those
 *    is somebody's real house style, and a classifier tuned to any one of them
 *    reads less of the other three. The assertion that catches that is
 *    comparative rather than absolute: all four sheets parse LOSSLESSLY, every
 *    declaration becoming a token, so a convention that starts dropping
 *    declarations the others keep shows up as a number here instead of as a
 *    row missing from a picker that somebody has to notice by eye.
 *
 * Every stylesheet below is invented for this file, and that is not
 * incidental. The systems these shapes were learned from are not public; a
 * fixture copied from one would put somebody else's source into an MIT
 * repository, and the shapes — a mid-name type word, an alias chain, a
 * var-with-fallback — are perfectly reproducible from scratch.
 *
 * Usage: node designlayer/test/library-generality-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { parseLibrary } from "../server/library-sources.mjs"

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

/* ------------------------------------------------------------------------- */
/* The vocabulary scan                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Spellings that belong to one design system and to no other.
 *
 * Every entry is either a token namespace a single platform team owns or the
 * name of a product or component library. None of them can appear in a rule
 * that is supposed to hold for a stylesheet nobody here has read. The list is
 * not exhaustive and cannot be — it is a tripwire on the vendors whose systems
 * shaped this feature, on the theory that whoever narrows the classifier will
 * narrow it towards a system that was in front of them.
 *
 * Committed entries name PUBLIC systems only, for the same reason the fixtures
 * below are invented: private namespaces are not ours to write into an MIT
 * repository.
 *
 * Dropping them would cost exactly the coverage that matters, since those are
 * the systems a narrowing would narrow towards — so the private half is supplied
 * from outside the repo instead. Set `DESIGNLAYER_VENDOR_WORDS` to
 * a comma-separated list and the scan runs against both halves:
 *
 *   DESIGNLAYER_VENDOR_WORDS=acme-sys,acme-ref node test/library-generality-cases.mjs
 *
 * Lower-cased and trimmed here, because `vendorHits` matches against a
 * lower-cased line and a stray capital would simply never fire.
 */
const PUBLIC_VENDOR_WORDS = ["md-sys", "mat-", "chakra", "mui"]

const PRIVATE_VENDOR_WORDS = (process.env.DESIGNLAYER_VENDOR_WORDS ?? "")
  .split(",")
  .map((word) => word.trim().toLowerCase())
  .filter(Boolean)

const VENDOR_WORDS = [...PUBLIC_VENDOR_WORDS, ...PRIVATE_VENDOR_WORDS]

/** Directories that hold build output or somebody else's code, not this implementation. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"])

/** What counts as a source file. Deliberately wider than what is on disk today. */
const SOURCE_EXTENSIONS = new Set([
  ".mjs",
  ".cjs",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".html",
  ".json",
])

/**
 * Where a vendor word appears in one line — anchored so ordinary English is
 * not an accusation.
 *
 * Two boundaries, and both were written against a real false positive rather
 * than imagined. The match must START a word or a name segment, because
 * `format--active` contains `mat-` and is a class name this editor's own CSS
 * ships; requiring the preceding character not to be alphanumeric rules it out
 * while still catching `--x-mat-…`, `"mat-"` and `@mat-…`. The match must also
 * END at something other than a lowercase letter or digit, which is what keeps
 * `column-gap` away from `lum-` and `muted` away from `mui` — and that test
 * reads the ORIGINAL line rather than the lowercased one, so a capital letter
 * counts as a boundary and `muiTheme` is still caught. An identifier fragment
 * is the whole point; a word that merely contains the letters is not.
 */
function vendorHits(line, words = VENDOR_WORDS) {
  const lowered = line.toLowerCase()
  const hits = []
  for (const word of words) {
    let from = 0
    for (;;) {
      const at = lowered.indexOf(word, from)
      if (at === -1) break
      from = at + 1
      const before = line[at - 1] ?? ""
      const after = line[at + word.length] ?? ""
      if (/[A-Za-z0-9]/.test(before)) continue
      if (!word.endsWith("-") && /[a-z0-9]/.test(after)) continue
      hits.push({ word, column: at + 1 })
    }
  }
  return hits
}

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, found)
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(full)
  }
  return found
}

const SCAN_ROOTS = ["server", "src"]
const scanned = SCAN_ROOTS.flatMap((root) => sourceFiles(path.join(PACKAGE_DIR, root)))

console.log("\nNo design system's vocabulary is written into the implementation")

/*
 * A scan that reads nothing passes. Both halves of this are the guard: the
 * floor catches a walk that lost its recursion, and the per-root count catches
 * one that lost a whole tree — a scan of `server/` alone would report a clean
 * bill of health for every client file in the feature.
 */
check("the scan reads the whole implementation rather than a corner of it", () => {
  assert.ok(scanned.length >= 50, `only ${scanned.length} source files were scanned`)
  for (const root of SCAN_ROOTS) {
    const prefix = path.join(PACKAGE_DIR, root) + path.sep
    const count = scanned.filter((file) => file.startsWith(prefix)).length
    assert.ok(count >= 10, `${root}/ contributed only ${count} files to the scan`)
  }
  // Nested, not just the two top directories — the client half of this feature
  // lives three levels down.
  assert.ok(
    scanned.some((file) => file.includes(`${path.sep}libraries${path.sep}`)),
    "the walk never descended into src/libraries"
  )
})

check("the matcher reads a vendor spelling however it is embedded", () => {
  const words = (line) => vendorHits(line).map((hit) => hit.word)
  assert.deepEqual(words("  --md-sys-color-primary: #ffffff;"), ["md-sys"])
  assert.deepEqual(words("const MD_SYS = /^--md-sys-/"), ["md-sys"])
  assert.deepEqual(words('if (name.startsWith("mat-")) return true'), ["mat-"])
  assert.deepEqual(words("--mat-sys-corner-small: 8px"), ["mat-"])
  assert.deepEqual(words("import { Button } from '@mui/base'"), ["mui"])
  // A camelCase boundary is still a boundary: this is the spelling a narrowing
  // arrives in once it has been tidied into an identifier.
  assert.deepEqual(words("const muiTheme = {}"), ["mui"])
  // A namespace that is not the whole name, and a brand name in plain prose:
  // the two shapes a narrowing actually arrives in.
  assert.deepEqual(words("--mui-action-bar-height: 48px"), ["mui"])
  assert.deepEqual(words("// works around Chakra's palette"), ["chakra"])
  assert.deepEqual(words("chakra-ui"), ["chakra"])
  // Capitals are a boundary and not a disguise, so the brand as a designer
  // writes it is caught alongside the token prefix a stylesheet spells.
  assert.deepEqual(words("MUI"), ["mui"])
})

/*
 * The private half of the vocabulary, exercised with invented stand-ins.
 *
 * Private namespaces are not in this file, so what is checked here is the
 * MECHANISM that carries them: an entry supplied through `DESIGNLAYER_VENDOR_WORDS`
 * matches on exactly the same terms as a committed one. The two shapes below
 * are the ones a private namespace tends to have and no public entry covers —
 * a multi-part hyphenated prefix, and a name that ends in a version digit.
 */
check("a vocabulary entry supplied from outside the repo matches identically", () => {
  const supplied = ["acme-sys", "acme-ref", "acme4"]
  const words = (line) => vendorHits(line, supplied).map((hit) => hit.word)
  assert.deepEqual(words("  --acme-sys-color-primary: #ffffff;"), ["acme-sys"])
  assert.deepEqual(words("  --acme-ref-space-12: 48px;"), ["acme-ref"])
  assert.deepEqual(words("/* acme4 only */"), ["acme4"])
  // The same boundary rules, so a private entry cannot be the one that starts
  // firing on ordinary English.
  assert.deepEqual(words("the acme4x build"), [])
  assert.deepEqual(words("reacme-sys"), [])
})

/*
 * And the wiring that assembles the two halves, which is the part that breaks
 * silently: a typo in the env name leaves a scan that reads the source, reports
 * nothing, and passes — the failure this whole file exists to prevent.
 */
check("the scanned vocabulary is the public list plus whatever was supplied", () => {
  for (const word of PUBLIC_VENDOR_WORDS) {
    assert.ok(VENDOR_WORDS.includes(word), `${word} is not in the scanned vocabulary`)
  }
  for (const word of PRIVATE_VENDOR_WORDS) {
    assert.ok(VENDOR_WORDS.includes(word), `${word} was supplied but is not scanned`)
  }
  assert.equal(VENDOR_WORDS.length, PUBLIC_VENDOR_WORDS.length + PRIVATE_VENDOR_WORDS.length)
  // Every entry is lower case, because the matcher only ever sees a lower-cased
  // line: a capital in the list is an entry that can never fire.
  for (const word of VENDOR_WORDS) assert.equal(word, word.toLowerCase())
})

/*
 * The other half of a tripwire is not firing at the wrong thing. A scan that
 * flags `format--active` gets suppressed within a week, and a suppressed scan
 * guards nothing — so the innocent lines below are drawn from this repo's own
 * source and from the English a comment is written in.
 */
check("ordinary English and ordinary CSS are not vendor vocabulary", () => {
  for (const line of [
    ".de-ann-format--active, .de-ann-format--active:hover {",
    '  node.classList.toggle("de-ann-format--active", active)',
    "const formatted = format(value)",
    "  grid-column-gap: 8px;",
    "// the material this panel is drawn on",
    "const muted = tokens.color.muted",
    "  columns: 3;",
    "const volume = 0.5",
    "  transform: translate(-50%, 0);",
  ]) {
    assert.deepEqual(vendorHits(line), [], `"${line}" was read as vendor vocabulary`)
  }
})

/*
 * The case this file exists for.
 *
 * A hit here is not a naming problem and must not be answered by renaming the
 * offending identifier. It means a rule somewhere below it is keyed on one
 * design system's spelling, so the rule reads that system and quietly reads
 * less of every other one. The fix is to restate the rule in generic token
 * vocabulary and delete the special case; if no generic statement of it exists,
 * the behaviour it was added for does not belong in this editor.
 */
check("no file under server/ or src/ names a design system's vocabulary", () => {
  const violations = []
  for (const file of scanned) {
    const relative = path.relative(PACKAGE_DIR, file)
    const lines = fs.readFileSync(file, "utf8").split("\n")
    lines.forEach((line, index) => {
      for (const hit of vendorHits(line)) {
        violations.push(
          `${relative}:${index + 1}:${hit.column}  "${hit.word}" in: ${line.trim().slice(0, 100)}`
        )
      }
    })
  }
  assert.deepEqual(
    violations,
    [],
    `the implementation has narrowed to a specific design system:\n       ${violations.join("\n       ")}`
  )
})

/* ------------------------------------------------------------------------- */
/* Four house styles, one parser                                              */
/* ------------------------------------------------------------------------- */

/**
 * (a) The type word leads. Tailwind v4 spells a system this way, and so does
 * every system written by somebody who read the Tailwind docs first.
 */
const PREFIX_TYPED = `
:root {
  --color-brand-500: #4f7cff;
  --color-surface: #ffffff;
  --spacing-sm: 8px;
  --spacing-md: 1rem;
  --radius-lg: 12px;
  --shadow-panel: 0 2px 6px rgba(10, 12, 18, 0.18);
  --duration-quick: 180ms;
}
`

/**
 * (b) A vendor namespace, then a layer, then the type word — which is how a
 * platform team spells a system that has a reference tier under it. The corner
 * radius is the token that matters: it says `shape` before it says `corner`,
 * and a rule anchored on the start of the name reads it as neither a radius
 * nor anything else.
 */
const MID_NAME_TYPED = `
:root {
  --acme-sys-color-surface: #f7f8fb;
  --acme-sys-color-on-surface: #14161c;
  --acme-sys-spacing-4: 4px;
  --acme-sys-spacing-6: 6px;
  --acme-sys-shape-corner-small: 8px;
  --acme-sys-shape-corner-large: 20px;
  --acme-sys-duration-medium: 0.24s;
}
`

/**
 * (c) No type word at all. A palette named after what the colours LOOK like
 * and a scale named after what it is FOR is an old, entirely reasonable house
 * style, and the only thing that says which axis a declaration belongs to is
 * the value on the right of the colon.
 */
const UNTYPED = `
:root {
  --fog-100: #f2f4f7;
  --ink-900: #101010;
  --slate-700: #2a3140;
  --gutter-2: 8px;
  --gutter-4: 16px;
  --bevel-2: 6px;
}
`

/**
 * (d) A system whose system tier is nothing but aliases into a reference tier,
 * including one that is two hops from a literal and two that point at a
 * variable declared in a stylesheet the editor was never given. What a picker
 * has to offer is the number at the end of the chain; the raw `var(…)` string
 * is unpaintable and unwritable.
 */
const ALIAS_HEAVY = `
:root {
  --ref-blue-40: #2f6bff;
  --ref-space-3: 12px;
  --sys-color-accent: var(--ref-blue-40);
  --sys-color-accent-pressed: var(--sys-color-accent);
  --sys-spacing-tight: var(--ref-space-3);
  --sys-spacing-loose: var(--ref-space-8, 32px);
  --sys-radius-panel: var(--sys-shape-missing, 10px);
  --sys-duration-swift: var(--ref-duration-fast, 150ms);
}
`

const HOUSE_STYLES = [
  { label: "prefix-typed", css: PREFIX_TYPED },
  { label: "mid-name-typed", css: MID_NAME_TYPED },
  { label: "untyped", css: UNTYPED },
  { label: "alias-heavy", css: ALIAS_HEAVY },
]

const prefixTyped = parseLibrary("css", PREFIX_TYPED, { name: "Prefix" })
const midNameTyped = parseLibrary("css", MID_NAME_TYPED, { name: "Midname" })
const untyped = parseLibrary("css", UNTYPED, { name: "Untyped" })
const aliasHeavy = parseLibrary("css", ALIAS_HEAVY, { name: "Aliased" })

/** Every token in a catalog, whichever group it landed in. */
const allTokens = (catalog) => [
  ...catalog.colors,
  ...catalog.spacing,
  ...catalog.radii,
  ...catalog.textStyles,
  ...catalog.uiTextStyles,
  ...catalog.effects,
  ...catalog.icons,
  ...catalog.motion,
]

const byVar = (group, cssVar) => group.find((token) => token.cssVar === cssVar) ?? null
const declarationCount = (css) => css.match(/--[a-zA-Z0-9_-]+\s*:/g).length

console.log("\nFour house styles, none of them privileged")

check("(a) the type word leads, and every axis is found", () => {
  assert.deepEqual(
    prefixTyped.colors.map((token) => token.cssVar),
    ["--color-brand-500", "--color-surface"]
  )
  assert.deepEqual(
    prefixTyped.spacing.map((token) => token.cssVar),
    ["--spacing-sm", "--spacing-md"]
  )
  assert.deepEqual(prefixTyped.radii.map((token) => token.cssVar), ["--radius-lg"])
  assert.deepEqual(prefixTyped.effects.map((token) => token.cssVar), ["--shadow-panel"])
  assert.deepEqual(prefixTyped.motion.map((token) => token.cssVar), ["--duration-quick"])
  // The unit is the author's business and the number is the editor's.
  assert.equal(byVar(prefixTyped.spacing, "--spacing-md").values.default, 16)
})

check("(a) a token names itself by what is left after the type word", () => {
  const brand = byVar(prefixTyped.colors, "--color-brand-500")
  assert.equal(brand.id, "color:brand-500")
  assert.equal(brand.name, "brand-500")
  assert.equal(brand.cssVar, "--color-brand-500")
  assert.deepEqual(brand.values, { light: "#4f7cff" })
})

/*
 * The case v1's prefix-anchored rules got wrong, and the reason the classifier
 * was rewritten to match word segments. Both of these tokens begin with three
 * segments that say nothing about what they are, and the word that decides is
 * the third or the fourth.
 */
check("(b) a type word in the middle of the name still decides the group", () => {
  const corner = byVar(midNameTyped.radii, "--acme-sys-shape-corner-small")
  assert.ok(corner, "a corner radius behind a vendor namespace was not read as a radius")
  assert.equal(corner.values.default, 8)
  const gap = byVar(midNameTyped.spacing, "--acme-sys-spacing-4")
  assert.ok(gap, "a spacing step behind a vendor namespace was not read as spacing")
  assert.equal(gap.values.default, 4)
  // And neither leaked into the other's picker on the way past.
  assert.equal(byVar(midNameTyped.spacing, "--acme-sys-shape-corner-small"), null)
  assert.equal(byVar(midNameTyped.radii, "--acme-sys-spacing-4"), null)
  assert.deepEqual(midNameTyped.radii.map((token) => token.name).sort(), ["large", "small"])
  assert.deepEqual(midNameTyped.motion.map((token) => token.cssVar), ["--acme-sys-duration-medium"])
})

check("(b) the shared namespace is dropped from the name and kept in the variable", () => {
  const surface = byVar(midNameTyped.colors, "--acme-sys-color-surface")
  assert.equal(surface.id, "color:surface")
  assert.equal(surface.name, "surface", "the designer is reading four words of namespace")
  assert.equal(surface.cssVar, "--acme-sys-color-surface", "the variable that gets written changed")
  assert.deepEqual(surface.values, { light: "#f7f8fb" })
})

check("(c) with no type word anywhere, the value decides", () => {
  assert.deepEqual(
    untyped.colors.map((token) => token.cssVar),
    ["--fog-100", "--ink-900", "--slate-700"]
  )
  assert.deepEqual(
    untyped.spacing.map((token) => token.cssVar),
    ["--gutter-2", "--gutter-4", "--bevel-2"]
  )
  assert.equal(byVar(untyped.colors, "--ink-900").values.light, "#101010")
  assert.equal(byVar(untyped.spacing, "--gutter-2").values.default, 8)
  /*
   * `--bevel-2` is a corner radius in its author's head and a spacing step
   * here, because a length is a length and the name gave nothing away. That is
   * the honest reading rather than a bug: the alternative is guessing a group
   * from a word this editor has never seen, and a wrong guess puts the token
   * in a picker that writes it to the wrong property.
   */
  assert.ok(byVar(untyped.spacing, "--bevel-2"), "a bare length was not read as a length")
  assert.deepEqual(untyped.radii, [])
})

check("(c) a name with nothing to strip keeps all of itself", () => {
  const slate = byVar(untyped.colors, "--slate-700")
  assert.equal(slate.id, "color:slate-700")
  assert.equal(slate.name, "slate-700")
  assert.equal(slate.cssVar, "--slate-700")
  assert.deepEqual(slate.values, { light: "#2a3140" })
})

check("(d) an alias is followed to the value at the end of it", () => {
  assert.equal(byVar(aliasHeavy.colors, "--sys-color-accent").values.light, "#2f6bff")
  // Two hops: the system tier points at the system tier, which points at the
  // reference tier, which is the only place a literal is written down.
  assert.equal(
    byVar(aliasHeavy.colors, "--sys-color-accent-pressed").values.light,
    "#2f6bff",
    "a two-hop chain stopped at the reference rather than the literal"
  )
  assert.equal(byVar(aliasHeavy.spacing, "--sys-spacing-tight").values.default, 12)
  // Dead ends, where the fallback is what the browser would paint.
  assert.equal(byVar(aliasHeavy.spacing, "--sys-spacing-loose").values.default, 32)
  assert.equal(byVar(aliasHeavy.radii, "--sys-radius-panel").values.default, 10)
  assert.equal(byVar(aliasHeavy.motion, "--sys-duration-swift").values.default.visualDuration, 0.15)
  // Nothing anywhere in the catalog is still a raw reference.
  for (const token of allTokens(aliasHeavy)) {
    assert.doesNotMatch(
      JSON.stringify(token.values),
      /var\(/,
      `${token.cssVar} was offered as an unresolved ${JSON.stringify(token.values)}`
    )
  }
})

check("(d) an aliased token is named and identified like any other", () => {
  const accent = byVar(aliasHeavy.colors, "--sys-color-accent")
  assert.equal(accent.id, "color:accent")
  assert.equal(accent.name, "accent")
  assert.equal(accent.cssVar, "--sys-color-accent")
  assert.deepEqual(accent.values, { light: "#2f6bff" })
})

/*
 * The comparative claim, which is the whole point of the group.
 *
 * Each case above asserts that one convention works. Only together do they say
 * the thing the feature promises, and only as a comparison: every one of these
 * four sheets is read LOSSLESSLY, so no convention is being read better than
 * the others. A rule narrowed towards any single house style shows up here as
 * a count that no longer matches, in whichever sheet lost tokens — which is a
 * failing number rather than a picker somebody has to open and squint at.
 */
check("all four conventions are read, and none of them loses tokens the others keep", () => {
  const read = HOUSE_STYLES.map(({ label, css }) => {
    const catalog = parseLibrary("css", css, { name: label })
    return { label, declared: declarationCount(css), found: allTokens(catalog).length }
  })
  for (const { label, declared, found } of read) {
    assert.ok(declared >= 6, `the ${label} sheet is too small to prove anything`)
    assert.equal(found, declared, `the ${label} sheet lost ${declared - found} of its ${declared} declarations`)
  }
  // Not vacuous: the four sheets really are different sizes and shapes, so
  // this is four separate readings rather than one repeated four times.
  assert.equal(new Set(read.map((entry) => entry.declared)).size >= 2, true)
})

check("every convention fills more than one axis, so no picker is empty", () => {
  for (const [label, catalog] of [
    ["prefix-typed", prefixTyped],
    ["mid-name-typed", midNameTyped],
    ["untyped", untyped],
    ["alias-heavy", aliasHeavy],
  ]) {
    const populated = ["colors", "spacing", "radii", "effects", "motion"].filter(
      (group) => catalog[group].length > 0
    )
    assert.ok(
      populated.length >= 2,
      `the ${label} sheet filled only ${populated.join(", ") || "nothing"}`
    )
    assert.ok(catalog.colors.length >= 2, `the ${label} sheet brought no palette`)
    assert.ok(catalog.spacing.length >= 2, `the ${label} sheet brought no spacing scale`)
    // A library a designer can actually use, not a shape that happens to parse.
    assert.equal(catalog.trackingUnit, "px")
    assert.deepEqual(catalog.components, [])
    assert.deepEqual(catalog.iconDrawings, [])
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
