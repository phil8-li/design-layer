/**
 * The parsing brain behind added libraries: four file formats in, one catalog
 * shape out.
 *
 * `server/library-sources.mjs` is pure — no filesystem, no config, no store —
 * and that is the whole reason it exists as its own module. Everything a
 * library ever contributes to the inspector is decided here, so the things
 * worth pinning are the ones that would silently change what a designer's own
 * stylesheet is understood to MEAN:
 *
 *  - detection is ordered, and the order is load-bearing. A Figma-style
 *    manifest's spacing tokens are `{ name, value }` objects, which is also
 *    exactly what a Style Dictionary leaf looks like. Read the file as DTCG and
 *    every colour keeps its `cssVar` but loses its theme pair, the text styles
 *    vanish, and nothing throws — the library just quietly brings less than it
 *    has. Only the rule ORDER stops that, so it is asserted rather than assumed;
 *  - the CSS classifier is the feature's real surface area. A host who writes
 *    `--border-color` and a host who writes `--color-border` are both right,
 *    `1rem` and `16px` are the same spacing step, and a Tailwind v4 text style
 *    is FOUR declarations that have to collapse into ONE token or the picker
 *    offers a designer four rows for one decision. Each of those is one rule,
 *    and each one is a token that appears or does not appear in a picker;
 *  - what is DROPPED matters as much as what is kept. An `ease-*` curve cannot
 *    be written by a motion axis that spells itself as a duration, and a font
 *    stack is not a token this editor can bind to anything. Offering either
 *    would put a row in the inspector that writes nothing and reports success;
 *  - the manifest path DELEGATES. `server/design-system-manifest.mjs` already
 *    normalizes this exact shape for the host's own design system, and a second
 *    implementation of it is how a library's colours come to differ from the
 *    host's for the same input. The colour assertion here compares against that
 *    function's own output, so a reimplementation fails even if it is correct;
 *  - malformation is not absence. A group a source does not have is `[]`; a
 *    group that is present and the wrong shape throws. Half a catalog installed
 *    silently is worse than a refused file, because the designer has no way to
 *    tell which half is missing.
 *
 * No server and no filesystem writes: the fixtures under `fixtures/libraries/`
 * are read as text and handed straight to the parsers, which is also what makes
 * them readable as the documentation of what each format is allowed to contain.
 *
 * Usage: node designlayer/test/library-source-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { normalizeDesignSystemManifest } from "../server/design-system-manifest.mjs"
import {
  LIBRARY_SOURCE_KINDS,
  describeLibrary,
  detectLibraryKind,
  libraryCounts,
  libraryId,
  parseLibrary,
} from "../server/library-sources.mjs"

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

const FIXTURES = path.join(PACKAGE_DIR, "test/fixtures/libraries")
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8")

const MANIFEST = fixture("manifest.json")
const TOKENS = fixture("tokens.json")
const ICONS = fixture("icons.json")
const THEME = fixture("theme.css")

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
const byName = (group, name) => group.find((token) => token.name === name) ?? null

// ── Detection ──────────────────────────────────────────────────────────────

console.log("\nWhich kind of file this is")

check("the six kinds are the six the rest of the feature names", () => {
  assert.deepEqual(
    [...LIBRARY_SOURCE_KINDS],
    ["manifest", "css", "tokens", "icons", "components", "url"]
  )
})

check("each fixture is recognised as the format it is written in", () => {
  assert.equal(detectLibraryKind("tokens/meridian.json", MANIFEST), "manifest")
  assert.equal(detectLibraryKind("tokens/dtcg.json", TOKENS), "tokens")
  assert.equal(detectLibraryKind("icons/glyphs.json", ICONS), "icons")
  assert.equal(detectLibraryKind("src/styles/theme.css", THEME), "css")
})

/*
 * The one ordering that is not obvious from either file on its own.
 *
 * A manifest's Spacing collection is `[{ name, cssVar, value }]`, and a Style
 * Dictionary leaf is `{ value }` under a name. Both are true of the manifest
 * fixture at the same time, so rule 3 would claim it if rule 1 did not run
 * first — and the DTCG reading of a manifest throws nothing away loudly. It
 * silently produces a library with no text styles, no effects and no theme
 * pairs, which reads in the panel as a design system that simply has fewer
 * tokens than the designer thought.
 */
check("a manifest is a manifest even though its tokens also read as DTCG", () => {
  assert.equal(detectLibraryKind("anything.json", MANIFEST), "manifest")
  const manifest = JSON.parse(MANIFEST)
  assert.ok(
    manifest.collections.some((collection) =>
      collection.tokens.some((token) => "value" in token)
    ),
    "the fixture no longer contains the `value` leaves that make this ambiguous"
  )
})

check("only the five manifest marker keys claim a JSON file", () => {
  for (const key of ["collections", "textStyles", "effectStyles", "iconScale", "motion"]) {
    assert.equal(
      detectLibraryKind("x.json", JSON.stringify({ [key]: [] })),
      "manifest",
      `${key} did not mark the file as a manifest`
    )
  }
})

/*
 * A MARKER KEY IS A SHAPE, NOT A WORD — and reading it as a word lost whole
 * files.
 *
 * `motion` is a manifest's array of motion tokens. It is also the obvious name
 * for a DTCG group of durations, which is a thing people write: the fragment
 * below is an ordinary token file and nothing else. Claimed as a manifest, it
 * reached `normalizeDesignSystemManifest`, which refused it — correctly, it is
 * not a manifest — and the throw surfaced to the designer as "nothing here read
 * as a design system" about a file that was nothing but design tokens. Same for
 * a top-level `textStyles` group, which is how a type ramp gets named.
 *
 * Testing the shape costs the manifest lane nothing, because every marker key
 * is an array in a real manifest — which is what the check above pins.
 */
check("a token group that shares a manifest key's name is still a token file", () => {
  const durations = JSON.stringify({
    motion: { fast: { $value: "120ms", $type: "duration" } },
    color: { brand: { $value: "#ff0000", $type: "color" } },
  })
  assert.equal(detectLibraryKind("tokens.json", durations), "tokens")
  const catalog = parseLibrary("tokens", durations)
  assert.equal(catalog.motion.length, 1, "the duration group was lost")
  assert.equal(catalog.colors.length, 1)

  assert.equal(
    detectLibraryKind(
      "type.json",
      JSON.stringify({ textStyles: { body: { $value: "16px", $type: "fontSize" } } })
    ),
    "tokens"
  )
})

/*
 * Plain nested JSON, which is most of the JSON a designer actually has.
 *
 * A theme object exported from a component library, a Tailwind theme dumped to
 * JSON, a theme generator's JSON export, a palette package's `colors.json` —
 * none of them wrap a leaf in `{ "value": … }`, so every one of them read as
 * zero tokens.
 *
 * The floor is what keeps that from claiming every JSON file in the project.
 * Detection counts the leaves this module would actually turn into tokens, so a
 * theme object passes on its colours and lengths while a `package.json` scores
 * nothing — without a rule that has to know what a `package.json` is.
 */
check("a plain nested theme object is a token file, and a build config is not", () => {
  const theme = JSON.stringify({
    colors: { brand: { 500: "#0066cc", 600: "#0052a3" }, surface: "#ffffff" },
    spacing: { 4: "1rem", 6: "1.5rem" },
    borderRadius: { md: "0.375rem" },
  })
  assert.equal(detectLibraryKind("theme.json", theme), "tokens")
  assert.equal(
    detectLibraryKind("package.json", '{"name":"app","version":"1.0.0","scripts":{"dev":"next"}}'),
    null
  )
  assert.equal(detectLibraryKind("tsconfig.json", '{"compilerOptions":{"target":"ES2022"}}'), null)
})

check("a file that is not a design system is not a library", () => {
  assert.equal(
    detectLibraryKind("README.md", "# Nimbus\n\nA design system for the web.\n"),
    null
  )
  // Three custom properties is a component's local variables, not a system.
  assert.equal(
    detectLibraryKind(
      "src/card.css",
      ".card {\n  --card-pad: 8px;\n  --card-gap: 4px;\n  --card-bg: #fff;\n}\n"
    ),
    null
  )
  assert.equal(
    detectLibraryKind("package.json", '{"name":"app","version":"1.0.0","scripts":{"dev":"next"}}'),
    null
  )
  assert.equal(detectLibraryKind("broken.json", "{ not json"), null)
})

check("the fourth custom property is what turns a stylesheet into a library", () => {
  const three = ":root {\n  --a-color: #fff;\n  --b-color: #000;\n  --c-color: #111;\n}\n"
  assert.equal(detectLibraryKind("t.css", three), null)
  assert.equal(detectLibraryKind("t.css", three.replace("}", "  --d-color: #222;\n}")), "css")
})

// ── Identity ───────────────────────────────────────────────────────────────

console.log("\nThe id a library is known by")

check("a path slugs to lowercase, dash-joined, untrimmed of nothing else", () => {
  assert.equal(libraryId("src/styles/tokens.css"), "src-styles-tokens-css")
  assert.equal(libraryId("Design/Tokens (v2).JSON"), "design-tokens-v2-json")
  assert.equal(libraryId("./packages/ui/theme.css"), "packages-ui-theme-css")
  assert.equal(libraryId("_private/@scope/icons.json"), "private-scope-icons-json")
})

check("a path with nothing sluggable in it is refused rather than given an empty id", () => {
  assert.throws(() => libraryId("///"))
  assert.throws(() => libraryId(""))
})

/*
 * Ids are the keys of the installed list AND the prefix that keeps two
 * libraries' identically-named tokens apart, so a collision is not a cosmetic
 * problem: adding the second library would silently overwrite the first.
 *
 * This asserts the paths a real project produces, not every path that exists.
 * The slug is lossy by construction — `src/a-b.css` and `src/a/b.css` both
 * reduce to `src-a-b-css` — so "never collides" cannot be true of all inputs,
 * only of inputs that differ somewhere the slug can see.
 */
check("the paths a real project ships do not collide with each other", () => {
  const paths = [
    "src/styles/tokens.css",
    "src/styles/theme.css",
    "packages/ui/tokens.css",
    "design/tokens.json",
    "design/icons.json",
    "tokens.json",
  ]
  const ids = paths.map(libraryId)
  assert.equal(new Set(ids).size, ids.length, `two of ${ids.join(", ")} are the same library`)
})

// ── CSS ────────────────────────────────────────────────────────────────────

console.log("\nA design system written as CSS custom properties")

const nimbus = parseLibrary("css", THEME, { name: "Nimbus" })

check("the given name is the catalog's, and a CSS file brings no components", () => {
  assert.equal(nimbus.name, "Nimbus")
  assert.deepEqual(nimbus.uiTextStyles, [])
  assert.deepEqual(nimbus.components, [])
  assert.deepEqual(nimbus.iconDrawings, [])
  assert.equal(nimbus.iconAttribute, "")
})

check("every property lands in the group its name claims", () => {
  assert.deepEqual(
    nimbus.colors.map((token) => token.cssVar),
    ["--color-brand-500", "--color-surface", "--border-color"]
  )
  assert.deepEqual(
    nimbus.spacing.map((token) => token.cssVar),
    ["--spacing-sm", "--spacing-md", "--space-xs"]
  )
  assert.deepEqual(nimbus.radii.map((token) => token.cssVar), ["--radius-card"])
  assert.deepEqual(nimbus.effects.map((token) => token.cssVar), ["--shadow-card"])
  assert.deepEqual(nimbus.icons.map((token) => token.cssVar), ["--icon-size-action"])
  // `--icon-size-action` must not be read as a `size-` spacing step on its way
  // past the spacing rule, or the icon axis loses its only scale.
  assert.equal(byVar(nimbus.spacing, "--icon-size-action"), null)
})

check("a colour is named by its prefix OR by its suffix, and carries its category", () => {
  const brand = byVar(nimbus.colors, "--color-brand-500")
  assert.equal(brand.name, "brand-500")
  assert.equal(brand.id, "color:brand-500")
  assert.equal(brand.category, "color")
  // The suffix rule is the whole reason this one is a colour at all.
  assert.ok(byVar(nimbus.colors, "--border-color"), "--border-color was not read as a colour")
})

check("a spacing step is pixels, whichever unit it was authored in", () => {
  assert.equal(byVar(nimbus.spacing, "--spacing-sm").values.default, 8)
  assert.equal(byVar(nimbus.spacing, "--spacing-md").values.default, 16)
  assert.equal(byVar(nimbus.spacing, "--space-xs").values.default, 8)
  assert.equal(byVar(nimbus.radii, "--radius-card").values.default, 12)
  assert.equal(byVar(nimbus.icons, "--icon-size-action").values.default, 16)
})

check("a .dark block is a second value for a colour, not a second colour", () => {
  assert.deepEqual(byVar(nimbus.colors, "--color-brand-500").values, {
    light: "#5b8cff",
    dark: "#93b0ff",
  })
  assert.deepEqual(byVar(nimbus.colors, "--color-surface").values, {
    light: "#ffffff",
    dark: "#101319",
  })
  // A colour the dark block never mentions keeps one value rather than
  // inventing a second the designer did not choose.
  assert.deepEqual(Object.keys(byVar(nimbus.colors, "--border-color").values), ["light"])
})

check("four Tailwind declarations are one text style, not four rows", () => {
  assert.equal(nimbus.textStyles.length, 1)
  const [style] = nimbus.textStyles
  assert.equal(style.name, "lg")
  assert.equal(style.id, "typography:lg")
  assert.equal(style.category, "typography")
  assert.equal(style.cssUtility, "text-lg")
  assert.deepEqual(style.values.default, {
    fontSize: 18,
    lineHeight: 24,
    letterSpacing: -0.01,
    fontWeight: 500,
  })
  assert.deepEqual(style.cssVars, {
    fontSize: "--text-lg",
    lineHeight: "--text-lg--line-height",
    letterSpacing: "--text-lg--letter-spacing",
    fontWeight: "--text-lg--font-weight",
  })
})

check("a stem with nothing but a size is still a complete text style", () => {
  const catalog = parseLibrary("css", ":root {\n  --text-sm: 14px;\n  --color-a: #fff;\n  --color-b: #000;\n  --color-c: #111;\n}\n")
  assert.equal(catalog.textStyles.length, 1)
  const [style] = catalog.textStyles
  assert.equal(style.values.default.fontSize, 14)
  assert.equal(style.values.default.lineHeight, 14, "leading fell back to something other than the size")
  assert.equal(style.values.default.letterSpacing, 0)
  assert.deepEqual(Object.keys(style.cssVars), ["fontSize"])
})

check("tracking is read in the unit it was authored in, and never guessed", () => {
  assert.equal(nimbus.trackingUnit, "em")
  const pixels = parseLibrary(
    "css",
    ":root {\n  --text-sm: 14px;\n  --text-sm--letter-spacing: -0.2px;\n  --color-a: #fff;\n  --color-b: #000;\n}\n"
  )
  assert.equal(pixels.trackingUnit, "px")
  assert.equal(pixels.textStyles[0].values.default.letterSpacing, -0.2)
  // No text style at all is not an em system by default.
  assert.equal(parseLibrary("css", ":root { --color-a: #fff; }").trackingUnit, "px")
})

check("a duration becomes a spring the motion axis can write, and a curve is dropped", () => {
  assert.deepEqual(nimbus.motion.map((token) => token.cssVar), ["--duration-quick"])
  assert.deepEqual(byVar(nimbus.motion, "--duration-quick").values.default, {
    visualDuration: 0.2,
    bounce: 0,
  })
  assert.equal(
    byVar(nimbus.motion, "--ease-standard"),
    null,
    "an easing curve reached a picker whose only verb is transition-duration"
  )
  // Seconds and milliseconds are the same declaration spelled two ways.
  const seconds = parseLibrary(
    "css",
    ":root {\n  --duration-slow: 0.4s;\n  --color-a: #fff;\n  --color-b: #000;\n  --color-c: #111;\n}\n"
  )
  assert.equal(seconds.motion[0].values.default.visualDuration, 0.4)
})

check("an effect keeps the whole value it was authored as", () => {
  assert.equal(
    byVar(nimbus.effects, "--shadow-card").values.default,
    "0 2px 8px rgba(12, 16, 20, 0.16)"
  )
  assert.equal(byVar(nimbus.effects, "--shadow-card").category, "shadow")
})

check("a property this editor cannot bind is dropped rather than offered", () => {
  const vars = allTokens(nimbus).map((token) => token.cssVar)
  assert.equal(
    vars.includes("--font-family-body"),
    false,
    "a font stack became a token in a picker that has no font-family axis"
  )
  // And a commented-out declaration is not a declaration at all.
  assert.equal(vars.includes("--color-legacy-teal"), false, "comments were not stripped first")
})

check("the value decides when the name does not", () => {
  const catalog = parseLibrary(
    "css",
    ":root {\n  --brand: oklch(0.62 0.15 264);\n  --inset: 4px;\n  --leading-tight: 1.2;\n  --shadow-x: 0 1px 2px #0002;\n}\n"
  )
  assert.deepEqual(catalog.colors.map((token) => token.cssVar), ["--brand"])
  assert.deepEqual(catalog.spacing.map((token) => token.cssVar), ["--inset"])
  // A unitless ratio is neither a colour nor a length, so nothing claims it.
  assert.equal(
    allTokens(catalog).some((token) => token.cssVar === "--leading-tight"),
    false
  )
})

check("every block a design system is declared in is read, and the last word wins", () => {
  const catalog = parseLibrary(
    "css",
    [
      "@theme {",
      "  --color-brand: #111111;",
      "  --radius-card: 12px;",
      "}",
      '[data-theme="high-contrast"] {',
      "  --color-ink: #000000;",
      "}",
      "html {",
      "  --spacing-md: 16px;",
      "}",
      ":root {",
      "  --radius-card: 16px;",
      "}",
    ].join("\n")
  )
  // Sorted, because which BLOCK a declaration was found in is not an ordering
  // the contract fixes — only that every one of these blocks is looked in.
  assert.deepEqual(catalog.colors.map((token) => token.cssVar).sort(), [
    "--color-brand",
    "--color-ink",
  ])
  assert.deepEqual(catalog.spacing.map((token) => token.cssVar), ["--spacing-md"])
  assert.equal(byVar(catalog.radii, "--radius-card").values.default, 16)
})

/*
 * THE ONE READING THAT WAS WRONG RATHER THAN MISSING.
 *
 * A dark block does not have to be a class. Radix Colors ships one as
 * `@media (prefers-color-scheme: dark)` in its distributed CSS, and so do Open
 * Props, USWDS and every system that follows the OS preference instead of a
 * toggle. The scanner skipped any scope starting with `@` before it tested for
 * dark, so the block resolved by its inner `:root` to the UNCONDITIONAL tier —
 * where the last declaration wins, and where a dark block is written last.
 *
 * So the dark palette became the default palette and no dark values were
 * produced at all. Every other gap in this module hands a designer less than
 * their system has; this one handed them a black swatch labelled as the light
 * default, which they have no way to tell from the truth.
 */
check("a dark block written as a media query is the dark theme, not the default", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root {",
      "  --gray-1: #fcfcfc;",
      "  --gray-12: #202020;",
      "  --accent-9: #3e63dd;",
      "  --radius-3: 8px;",
      "}",
      "@media (prefers-color-scheme: dark) {",
      "  :root {",
      "    --gray-1: #111111;",
      "    --gray-12: #eeeeee;",
      "    --accent-9: #3d63dd;",
      "  }",
      "}",
    ].join("\n")
  )
  assert.deepEqual(byName(catalog.colors, "gray-1").values, { light: "#fcfcfc", dark: "#111111" })
  assert.deepEqual(byName(catalog.colors, "gray-12").values, { light: "#202020", dark: "#eeeeee" })
  assert.deepEqual(byName(catalog.colors, "accent-9").values, { light: "#3e63dd", dark: "#3d63dd" })
  // The block inside the media query is `:root`, so nothing else in the file
  // may be collateral: the radius declared beside the light palette survives.
  assert.equal(catalog.radii.length, 1)
})

/*
 * A system that ships both spellings of the same palette — the class for an
 * explicit toggle, the media query for the OS preference — must not have one of
 * them demoted.
 *
 * Plainness is decided by comparing dark selectors against each other, and a
 * media query spends four words getting to the one that names the theme. Left
 * unaccounted for, `@media (prefers-color-scheme: dark)` looked like a
 * DISTINGUISHED dark theme standing next to a plain `.dark` — three words it
 * does not share — which makes it additive-only, so whichever of the two the
 * author wrote second would silently stop being able to restate a colour.
 */
check("both spellings of dark rank as the same plain dark theme", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root { --color-bg: #ffffff; --color-fg: #111111; --spacing-md: 16px; --radius-sm: 4px; }",
      ".dark, .dark-theme { --color-bg: #101319; }",
      "@media (prefers-color-scheme: dark) { :root { --color-bg: #0b0d12; } }",
      "@media (prefers-color-scheme: dark) and (prefers-contrast: more) {",
      "  :root { --color-bg: #000000; }",
      "}",
      ".dark { --color-fg: #e6e8ee; }",
    ].join("\n")
  )
  // Two plain dark blocks, so the later one wins — the same last-word rule the
  // light tier follows. The media query only gets that standing if the words it
  // spends reaching `dark` are read as plumbing rather than as a distinction.
  assert.deepEqual(byName(catalog.colors, "bg").values, { light: "#ffffff", dark: "#0b0d12" })
  // And a dark block that really IS distinguished — dark AND high contrast —
  // still may only add, so an accessibility variant never becomes the theme.
  assert.deepEqual(byName(catalog.colors, "fg").values, { light: "#111111", dark: "#e6e8ee" })
})

/*
 * The same root cause, with a quieter symptom and a wider blast radius.
 *
 * Every other `@media` condition was flattened into the unconditional tier too,
 * so a wide-viewport override became THE spacing step and a print colour became
 * THE background. They belong in the additive tier instead: a conditional block
 * is a real declaration site and may contribute a name nothing else declares,
 * but it may never restate what the file says plainly.
 */
check("a conditional media query may add, but may not restate the default", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root { --space-lg: 24px; --color-bg: #ffffff; --color-fg: #111111; --radius-sm: 4px; }",
      "@media (min-width: 900px) { :root { --space-lg: 32px; } }",
      "@media print { :root { --color-bg: #cccccc; } }",
      "@supports (color: oklch(0 0 0)) { :root { --color-vivid: oklch(0.62 0.15 264); } }",
    ].join("\n")
  )
  assert.equal(byName(catalog.spacing, "lg").values.default, 24, "a breakpoint override became the step")
  assert.deepEqual(byName(catalog.colors, "bg").values, { light: "#ffffff" }, "print became the default")
  // Additive, not ignored: a name only the conditional block declares is a
  // token that exists nowhere else, so taking it beats losing it.
  assert.ok(byName(catalog.colors, "vivid"), "a token declared only under @supports was dropped")
})

/*
 * The most-copied token layout in existence, and it read as zero colours.
 *
 * Pre-Tailwind-v4 shadcn/ui writes its whole palette as bare channel triples
 * and consumes them as `hsl(var(--background))`, so a `globals.css` a designer
 * would describe as "my colours" produced a catalog of one radius. The refusal
 * that caused it is right in general — a `-rgb` triple spliced into
 * `rgba(var(--x), .5)` genuinely paints nothing on its own — so the way out
 * RECOVERS the function rather than assuming one: two percentages after a hue
 * is `hsl()`'s own argument shape and a 0-255 triple cannot be mistaken for it.
 */
check("a palette stored as bare channel triples is read as colours", () => {
  const catalog = parseLibrary(
    "css",
    [
      "@layer base {",
      "  :root {",
      "    --background: 0 0% 100%;",
      "    --foreground: 222.2 84% 4.9%;",
      "    --primary: 221.2 83.2% 53.3%;",
      "    --radius: 0.5rem;",
      "  }",
      "  .dark {",
      "    --background: 222.2 84% 4.9%;",
      "    --foreground: 210 40% 98%;",
      "    --primary: 217.2 91.2% 59.8%;",
      "  }",
      "}",
    ].join("\n")
  )
  assert.deepEqual(byName(catalog.colors, "background").values, {
    light: "hsl(0 0% 100%)",
    dark: "hsl(222.2 84% 4.9%)",
  })
  assert.deepEqual(catalog.colors.map((token) => token.name), [
    "background",
    "foreground",
    "primary",
  ])
  // The value stored is the one a browser would paint, so the picker writes a
  // colour rather than three numbers.
  assert.equal(byName(catalog.colors, "primary").values.light, "hsl(221.2 83.2% 53.3%)")
  assert.equal(byName(catalog.radii, "radius").values.default, 8)
})

/*
 * The other half of the same rule: the wrapper is LEARNED, never guessed.
 *
 * A file that splices a variable into `rgb(var(--x))` has told this module what
 * the numbers are, and one that does not has told it nothing — so the refusal
 * the audit was right about stays exactly where it was.
 */
check("a channel triple is recovered only when the file says what it is", () => {
  const declared = parseLibrary(
    "css",
    [
      ":root { --brand-rgb: 59 130 246; --ink: #111111; --paper: #ffffff; --gap: 8px; }",
      ".button { background: rgb(var(--brand-rgb)); }",
    ].join("\n")
  )
  assert.equal(byName(declared.colors, "brand-rgb").values.light, "rgb(59 130 246)")

  const bare = parseLibrary(
    "css",
    ":root { --brand-rgb: 59, 130, 246; --ink: #111111; --paper: #ffffff; --gap: 8px; }"
  )
  assert.deepEqual(
    bare.colors.map((token) => token.name),
    ["ink", "paper"],
    "an unpaintable channel triple was offered as a colour"
  )
})

check("a file with no blocks at all is still read", () => {
  const catalog = parseLibrary(
    "css",
    "--color-a: #fff;\n--color-b: #000;\n--spacing-sm: 8px;\n--radius-sm: 4px;\n"
  )
  assert.equal(catalog.colors.length, 2)
  assert.equal(catalog.spacing.length, 1)
  assert.equal(catalog.radii.length, 1)
})

/*
 * THE ONE CHARACTER THAT USED TO EAT A WHOLE STYLESHEET.
 *
 * The scanner honoured a backslash only once it was already inside a string, so
 * an escaped quote in a SELECTOR opened one that nothing ever closed: from that
 * character to the end of the file, every brace and semicolon was read as
 * string content. No error and no partial answer — the file simply appeared to
 * declare no tokens at all.
 *
 * It is not an exotic input. A utility framework emits selectors like this by
 * the dozen for arbitrary variants, and one of them sat six kilobytes before
 * the `:root` block of a real design system, costing all of it: 75 colours with
 * light and dark values, 14 radii and 5 text styles, read as zero. It reached a
 * designer as "I added the library and no styles showed up".
 *
 * The other escapes are here because the fix is "skip the character after a
 * backslash, always", and an escaped brace or semicolon in a selector would
 * break the walk the same way if the rule were written for quotes alone.
 */
check("an escaped character in a selector does not swallow the rest of the file", () => {
  const tokens = ":root{--color-a:#fff;--color-b:#000;--spacing-sm:8px;--radius-sm:4px}"
  const hostile = [
    // An arbitrary variant carrying an escaped apostrophe — the measured case.
    String.raw`.\[\&\>svg\:not\(\[class\*\=\'size-\'\]\)\]\:size-4>svg{display:none}`,
    // An escaped double quote: the same trap with the other delimiter.
    String.raw`.content-\"x\"{color:red}`,
    // Escaped punctuation that would otherwise be read as structure.
    String.raw`.w-1\/2{width:50%}`,
    String.raw`.brace-\{\}{color:blue}`,
    String.raw`.semi-\;{color:green}`,
  ]
  for (const selector of hostile) {
    const catalog = parseLibrary("css", `${selector}${tokens}`, { name: "T" })
    assert.equal(catalog.colors.length, 2, `lost the colours after ${selector}`)
    assert.equal(catalog.spacing.length, 1, `lost the spacing after ${selector}`)
    assert.equal(catalog.radii.length, 1, `lost the radii after ${selector}`)
  }
  // And a genuine string still ends where it ends: the brace and semicolon
  // inside these quotes are content, and the tokens after them are still found.
  const quoted = parseLibrary("css", `.a::after{content:"}{;"}${tokens}`, { name: "T" })
  assert.equal(quoted.colors.length, 2, "a brace inside a real string was read as structure")
})

/*
 * A framework's working memory is not a design token.
 *
 * `--tw-*` is a reserved implementation namespace — the variables a utility
 * framework writes at run time to hold the current gradient stop or to compose
 * a shadow out of its parts. They are declared on `*` with placeholder values,
 * so nothing downstream can tell them from tokens, and a compiled stylesheet
 * duly offered `tw-gradient-from` and `tw-ring-offset-color` in the colour
 * picker beside the real ones.
 */
check("a framework's reserved internals are not offered as tokens", () => {
  const catalog = parseLibrary(
    "css",
    "*{--tw-gradient-from:#0000;--tw-ring-offset-color:#fff;--tw-shadow:0 0 #0000}" +
      ":root{--color-brand:#123456;--color-ink:#000;--spacing-m:8px}",
    { name: "T" }
  )
  assert.deepEqual(
    catalog.colors.map((color) => color.name).sort(),
    ["brand", "ink"],
    "a reserved framework variable was offered as a design token"
  )
  assert.equal(catalog.spacing.length, 1)
})

/*
 * AN ICON FONT'S SCALE IS AN ICON SIZE, and it reached the text-style picker.
 *
 * A system whose icons are a variable font sizes them the way it sizes text: a
 * glyph is a character, so its size is a `font-size` and its box a
 * `line-height`, and the scale is spelled with exactly the trailing roles a
 * text-style family is collected by. Five such families listed as five text
 * styles named `icon-scale-s` to `icon-scale-xxl`, each reading 16/16 to 32/32,
 * while the icon-size picker stayed empty. The axis settings the font ships
 * beside each size (`-opsz`, `-fill`, `-grad`) are numbers, not lengths, and
 * must not turn up as more icon sizes on the way past.
 */
check("an icon font's scale is read as icon sizes, not as text styles", () => {
  const sizes = [["s", 16, 330], ["m", 20, 320], ["l", 24, 300]]
  const catalog = parseLibrary(
    "css",
    `:root {\n${sizes
      .map(
        ([step, px, weight]) =>
          `  --acme-sys-icon-scale-${step}: ${weight} ${px}px/${px}px "Acme Symbols";\n` +
          `  --acme-sys-icon-scale-${step}-font-size: ${px}px;\n` +
          `  --acme-sys-icon-scale-${step}-line-height: ${px}px;\n` +
          `  --acme-sys-icon-scale-${step}-font-weight: ${weight};\n` +
          `  --acme-sys-icon-scale-${step}-opsz: ${px};\n` +
          `  --acme-sys-icon-scale-${step}-fill: 0;\n` +
          `  --acme-sys-icon-scale-${step}-grad: 0;\n`
      )
      .join("")}  --acme-sys-color-ink: #101319;\n  --acme-sys-spacing-m: 12px;\n}\n`,
    { name: "Acme" }
  )
  assert.deepEqual(catalog.textStyles, [], "an icon size was offered as a text style")
  assert.deepEqual(
    catalog.icons.map((token) => [token.name, token.values.default, token.cssVar]),
    [
      ["s", 16, "--acme-sys-icon-scale-s-font-size"],
      ["m", 20, "--acme-sys-icon-scale-m-font-size"],
      ["l", 24, "--acme-sys-icon-scale-l-font-size"],
    ]
  )
  assert.equal(catalog.icons.every((token) => token.category === "icon-size"), true)
  // The line heights stay with their family rather than reaching spacing on
  // their `height` word.
  assert.deepEqual(catalog.spacing.map((token) => token.cssVar), ["--acme-sys-spacing-m"])
})

/*
 * A TYPE RAMP WRITTEN AS CLASSES, which is how most systems outside Tailwind
 * ship one, and which declares no custom property at all.
 *
 * Read as custom properties only, a stylesheet like this has no text styles,
 * and the text-style picker is left with whatever else has a font size. The
 * negatives are each a reason a rule with a font size is not a type role: it
 * also paints (a component), it only applies under a condition (a variant), it
 * leaves the leading to inheritance, it is about an icon, or it is not one
 * plain class.
 */
check("a type ramp written as classes is read as text styles", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root { --acme-font: 'Acme Sans', sans-serif; --acme-color-ink: #101319; --acme-color-page: #fff; --acme-spacing-m: 12px; }",
      "@layer components {",
      "  .acme-display-l { font-family: var(--acme-font); letter-spacing: 0px; font-variation-settings: 'wdth' 100; font-size: 42px; font-weight: 280; line-height: 48px; }",
      "  .acme-body-m { font-family: var(--acme-font); font-size: 15px; font-weight: 400; line-height: 20px; }",
      "  .acme-label-s { font-size: 0.8125rem; font-weight: 500; line-height: 1.5; letter-spacing: 0.01em; }",
      "  .acme-caption { font-size: 12px; line-height: 16px; font-style: italic; }",
      "  .acme-card-title { font-size: 18px; line-height: 24px; color: var(--acme-color-ink); }",
      "  .acme-icon-m { font-size: 20px; line-height: 20px; }",
      "  .acme-lead { font-size: 20px; font-weight: 300; }",
      "  .acme-body-m:hover { font-weight: 600; }",
      "  .acme-prose p { font-size: 16px; line-height: 24px; }",
      "}",
      "@media (min-width: 900px) { .acme-display-xl { font-size: 64px; line-height: 72px; } }",
    ].join("\n"),
    { name: "Acme" }
  )
  // Named after what is left once the namespace all four share is cut, the same
  // cut a custom property gets.
  assert.deepEqual(
    catalog.textStyles.map((token) => token.name),
    ["display-l", "body-m", "label-s", "caption"],
    "a rule that is not a type role was read as one, or a role was missed"
  )
  const [display, body, label, caption] = catalog.textStyles
  assert.equal(display.cssUtility, "acme-display-l")
  assert.equal(display.cssVars, undefined, "a class style claimed a variable it does not have")
  // The family, the style and the variation settings are part of the role,
  // settled to literals because the page a pick lands in may not declare the
  // variable the role was written with.
  assert.deepEqual(display.values.default, {
    fontSize: 42,
    lineHeight: 48,
    letterSpacing: 0,
    fontWeight: 280,
    fontFamily: "'Acme Sans', sans-serif",
    fontVariationSettings: "'wdth' 100",
  })
  assert.deepEqual(body.values.default, {
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0,
    fontWeight: 400,
    fontFamily: "'Acme Sans', sans-serif",
  })
  assert.deepEqual(caption.values.default, { fontSize: 12, lineHeight: 16, letterSpacing: 0, fontStyle: "italic" })
  // rem resolved, a unitless leading read as a ratio, and em tracking restated
  // in the catalog's unit through the style's own size.
  assert.equal(catalog.trackingUnit, "px")
  assert.deepEqual(label.values.default, { fontSize: 13, lineHeight: 19.5, letterSpacing: 0.13, fontWeight: 500 })
  assert.deepEqual(catalog.icons, [], "a class that sizes an icon became an icon token")
})

/*
 * A compiled Tailwind v4 sheet carries BOTH spellings of one style: the
 * `--text-lg` family in the theme, and the `.text-lg` utility that reads it.
 * They are one decision, so they must be one row.
 */
check("a utility class that reads a text-style family is that family, not a second style", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root { --text-lg: 1.125rem; --text-lg--line-height: 1.75rem; --color-a: #fff; --color-b: #000; }",
      "@layer utilities { .text-lg { font-size: var(--text-lg); line-height: var(--tw-leading, var(--text-lg--line-height)); } }",
    ].join("\n")
  )
  assert.deepEqual(catalog.textStyles.map((token) => token.cssUtility), ["text-lg"])
  assert.deepEqual(catalog.textStyles[0].cssVars, { fontSize: "--text-lg", lineHeight: "--text-lg--line-height" })
})

/*
 * Lengths that are not spacing. Every one of these reached the spacing picker,
 * by a `spacing` or `height` word in its name or by the value sniffer, and
 * measured on one real stylesheet they were eleven of its twenty-seven spacing
 * rows. The three that stay are the boundary: a spacing word still wins over
 * `leading` and `container` when the name has both.
 */
check("lengths that are not spacing never reach the spacing picker", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root {",
      "  --tracking-tight: -0.025em;",
      "  --letter-spacing-wide: 0.05em;",
      "  --line-height-6: 1.5rem;",
      "  --leading-6: 1.5rem;",
      "  --blur-sm: 8px;",
      "  --scrim-blur: 4px;",
      "  --container-md: 28rem;",
      "  --breakpoint-md: 48rem;",
      "  --padding-leading: 8px;",
      "  --container-gap: 24px;",
      "  --spacing-4: 16px;",
      "}",
    ].join("\n")
  )
  assert.deepEqual(
    catalog.spacing.map((token) => token.cssVar),
    ["--padding-leading", "--container-gap", "--spacing-4"]
  )
  assert.deepEqual(allTokens(catalog).length, 3, "a non-spacing length landed on another axis instead")
})

/*
 * A SCALE DERIVED FROM ONE BASE. shadcn writes its whole corner scale as
 * `calc(var(--radius) ± n)`, and Tailwind writes its default leading as
 * `calc(1 / 0.75)`; with the reference in the middle of the value, neither was
 * followed, and the corner scale read as a lone `--radius`. What depends on a
 * box — a viewport unit, a percentage — still cannot be settled, and is still
 * dropped.
 */
check("a scale derived with calc() is read through to its numbers", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root {",
      "  --radius: 0.625rem;",
      "  --radius-sm: calc(var(--radius) - 4px);",
      "  --radius-md: calc(var(--radius) - 2px);",
      "  --radius-lg: var(--radius);",
      "  --radius-xl: calc(var(--radius) + 4px);",
      "  --radius-2xl: calc(var(--radius) * 1.4);",
      "  --radius-fluid: calc(1vw + 2px);",
      "  --radius-half: calc(50% - 1px);",
      "  --text-xs: 0.75rem;",
      "  --text-xs--line-height: calc(1 / 0.75);",
      "}",
    ].join("\n")
  )
  assert.deepEqual(
    catalog.radii.map((token) => [token.cssVar, token.values.default]),
    [
      ["--radius", 10],
      ["--radius-sm", 6],
      ["--radius-md", 8],
      ["--radius-lg", 10],
      ["--radius-xl", 14],
      ["--radius-2xl", 14],
    ]
  )
  assert.equal(catalog.textStyles[0].values.default.lineHeight, 16)
})

/*
 * `inherits: false` is the opposite of a token. A theme token reaches the page
 * by inheriting from the root; a property registered as non-inheriting holds a
 * separate value on every element — a utility's working state. Utility plugins
 * restate those initials on `*`, which is unconditional, so they listed as
 * tokens: four scroll-fade insets at 0px, offered by the margin row as what a
 * 0px margin "could be". A registered property that DOES inherit is still a
 * token.
 */
check("a property registered as non-inheriting is a channel, not a token", () => {
  const catalog = parseLibrary(
    "css",
    [
      '@property --fade-top { syntax: "<length-percentage>"; inherits: false; initial-value: 0; }',
      '@property --fade-bottom { syntax: "<length-percentage>"; inherits: false; initial-value: 0; }',
      '@property --brand { syntax: "<color>"; inherits: true; initial-value: #000; }',
      "@layer properties { *, ::before, ::after { --fade-top: 0px; --fade-bottom: 0px; } }",
      ":root { --brand: #3366ff; --spacing-m: 12px; --color-ink: #000; --color-page: #fff; }",
    ].join("\n")
  )
  assert.deepEqual(catalog.spacing.map((token) => token.cssVar), ["--spacing-m"])
  assert.ok(byVar(catalog.colors, "--brand"), "a registered property that inherits was dropped")
})

/*
 * A custom property cannot carry a unitless length: `gap: var(--x)` with
 * `--x: 16` is thrown away by the browser, so offering it writes nothing.
 * Zero is the one bare number CSS accepts as a length — and a size is the one
 * length zero is never a step of.
 */
check("a stylesheet length needs a unit, and a size needs to be more than zero", () => {
  const catalog = parseLibrary(
    "css",
    ":root { --spacing-4: 16; --spacing-0: 0; --radius-none: 0; --icon-size-sm: 0; --icon-size-md: 20px; --color-ink: #000; }"
  )
  assert.deepEqual(catalog.spacing.map((token) => token.cssVar), ["--spacing-0"])
  assert.deepEqual(catalog.radii.map((token) => token.cssVar), ["--radius-none"])
  assert.deepEqual(catalog.icons.map((token) => token.cssVar), ["--icon-size-md"])
})

/*
 * THE MIDDLE SPELLING OF A TEXT STYLE: role name, then the role, then a
 * variant — `--text-body-size-large`, `--text-body-lineHeight-large` — with
 * what every variant shares declared once (`--text-body-weight`). None of the
 * three patterns that came before read it, so such a system listed each size
 * as a style with no leading, beside its weights listed as 400px font sizes.
 */
check("a role, its variants and what they share collapse into one style per variant", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root {",
      "  --text-body-size-large: 1rem;",
      "  --text-body-lineHeight-large: 1.5;",
      "  --text-body-size-small: 0.75rem;",
      "  --text-body-lineHeight-small: 1.6666;",
      "  --text-body-weight: 400;",
      "  --text-title-size-medium: 1.25rem;",
      "  --text-title-lineHeight-medium: 1.6;",
      "  --text-title-weight-medium: 600;",
      "  --text-caption-size: 0.75rem;",
      "  --text-caption-lineHeight: 1.3333;",
      "  --text-caption-weight: 400;",
      "}",
    ].join("\n")
  )
  assert.deepEqual(
    catalog.textStyles.map((token) => [token.name, token.values.default]),
    [
      ["body-large", { fontSize: 16, lineHeight: 24, letterSpacing: 0, fontWeight: 400 }],
      ["body-small", { fontSize: 12, lineHeight: 20, letterSpacing: 0, fontWeight: 400 }],
      ["title-medium", { fontSize: 20, lineHeight: 32, letterSpacing: 0, fontWeight: 600 }],
      ["caption", { fontSize: 12, lineHeight: 16, letterSpacing: 0, fontWeight: 400 }],
    ]
  )
  // The shared weight is the variant's own variable, so a pick follows it.
  assert.equal(catalog.textStyles[0].cssVars.fontWeight, "--text-body-weight")
  assert.deepEqual(catalog.spacing, [], "a line height reached the spacing picker")
})

/*
 * A ROLE INSIDE A CAMEL-CASED RUN. A system can spell each name as one run,
 * `--fontSizeBase300` beside `--lineHeightBase300`. A role read only across
 * hyphens found none there, so every size listed as a style whose leading was
 * its own size: 14/14 where the system says 14/20.
 */
check("a role glued to its stem or variant by a camel hump pairs like a hyphenated one", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root {",
      "  --fontSizeBase200: 12px;",
      "  --fontSizeBase300: 14px;",
      "  --lineHeightBase200: 16px;",
      "  --lineHeightBase300: 20px;",
      "  --fontWeightRegular: 400;",
      "  --typographyBodyFontSize: 16px;",
      "  --typographyBodyLineHeight: 24px;",
      "}",
    ].join("\n")
  )
  assert.deepEqual(
    catalog.textStyles.map((token) => [token.name, token.values.default.fontSize, token.values.default.lineHeight]),
    [
      ["base200", 12, 16],
      ["base300", 14, 20],
      ["body", 16, 24],
    ]
  )
  assert.equal(catalog.textStyles[1].cssVars.lineHeight, "--lineHeightBase300")
  assert.deepEqual(catalog.spacing, [], "a line height reached the spacing picker")
})

/*
 * A NUMBERED STEP PAIRS ONLY WITH THE SAME NUMBERING. One system numbers its
 * sizes, leadings and trackings 1–9 alike, and step 3 is one style. Another
 * numbers its weights 1–9 for 100–900 beside sizes numbered 00–8, and pairing
 * `--font-weight-3` with `--font-size-3` invented a style in weight 300.
 */
check("numbered steps pair across roles only when the roles share their numbering", () => {
  const steps = [1, 2, 3, 4]
  const shared = parseLibrary(
    "css",
    `:root {\n${steps
      .map((step) => `  --font-size-${step}: ${10 + step * 2}px;\n  --line-height-${step}: ${16 + step * 4}px;`)
      .join("\n")}\n}`
  )
  assert.deepEqual(
    shared.textStyles.map((token) => [token.name, token.values.default.lineHeight]),
    [["1", 20], ["2", 24], ["3", 28], ["4", 32]]
  )
  const independent = parseLibrary(
    "css",
    [
      ":root {",
      "  --font-size-00: 0.5rem;",
      "  --font-size-0: 0.75rem;",
      "  --font-size-1: 1rem;",
      "  --font-size-2: 1.1rem;",
      "  --font-weight-1: 100;",
      "  --font-weight-2: 200;",
      "  --font-weight-3: 300;",
      "}",
    ].join("\n")
  )
  assert.deepEqual(
    independent.textStyles.map((token) => [token.name, token.values.default.fontWeight ?? null]),
    [["00", null], ["0", null], ["1", null], ["2", null]],
    "a weight ramp was paired with a size ramp by step number"
  )
})

/*
 * Two families can shorten onto one name — a system's base `small` and its
 * button's `small` — and the picker selects by id. Each keeps the part of its
 * stem that tells it apart, and the namespace they all share is cut.
 */
check("text styles keep what tells them apart, and every id is unique", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root {",
      "  --kit-font-size-small: 0.875rem;",
      "  --kit-font-size-medium: 1rem;",
      "  --kit-button-font-size-small: 0.75rem;",
      "  --kit-button-font-size-medium: 0.875rem;",
      "  --kit-input-font-size-small: 0.875rem;",
      "  --kit-color-primary: #0066cc;",
      "}",
    ].join("\n")
  )
  assert.deepEqual(catalog.textStyles.map((token) => token.name), [
    "small",
    "medium",
    "button-small",
    "button-medium",
    "input-small",
  ])
  const ids = catalog.textStyles.map((token) => token.id)
  assert.equal(new Set(ids).size, ids.length, "two text styles share an id")
})

/*
 * Lengths that are strokes and sizes, not spacing — and the colours that share
 * their words. A border width, an outline offset, a divider thickness, a
 * component height and a perspective all reached the spacing picker; a border
 * COLOUR must not be thrown out on the way, which an earlier draft of this rule
 * did to a system's whole set of subtle border colours.
 */
check("stroke widths, sizes and perspectives are not spacing, and border colours stay colours", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root {",
      "  --kit-border-width: 1px;",
      "  --kit-borderWidth-thick: 2px;",
      "  --kit-outline-focus-offset: -2px;",
      "  --kit-focus-ring-width: 0.25rem;",
      "  --kit-divider-thickness-small: 1px;",
      "  --kit-input-height-medium: 40px;",
      "  --kit-sidebar-width: 280px;",
      "  --kit-perspective-near: 300px;",
      "  --kit-border: 1px;",
      "  --kit-gap-sm: 8px;",
      "  --kit-primary-border-subtle: #9ec5fe;",
      "  --ring: #9dd2ff;",
      "}",
    ].join("\n")
  )
  assert.deepEqual(catalog.spacing.map((token) => token.cssVar), ["--kit-gap-sm"])
  assert.deepEqual(
    catalog.colors.map((token) => token.cssVar),
    ["--kit-primary-border-subtle", "--ring"],
    "a colour was refused for sharing a word with a stroke width"
  )
})

/*
 * The parts of a shadow are not shadows, and a delay is not a duration. Both
 * used to be offered: `--x-shadow-blur-md: 8px` written as a box-shadow is an
 * invalid declaration, and a 50ms delay written as `transition-duration` sets
 * how long the change takes rather than when it starts. A duration with no
 * telling word in its name is still recognised by its value.
 */
check("only whole shadows are shadows, a delay is not a duration, and a duration speaks for itself", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root {",
      "  --kit-shadow-blur-md: 8px;",
      "  --kit-shadow-x: 0px;",
      "  --kit-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.1);",
      "  --kit-shadow-ring: inset 0 0 0 0.125rem;",
      "  --kit-shadow-scaled: 0 calc(0.0625rem * 2) calc(0.1875rem * 2) rgba(0, 0, 0, 0.05);",
      "  --kit-shadow-none: none;",
      "  --kit-delay-short: 50ms;",
      "  --kit-transition-fast: 150ms;",
      "  --kit-color-ink: #000;",
      "}",
    ].join("\n")
  )
  assert.deepEqual(catalog.effects.map((token) => token.cssVar), [
    "--kit-shadow-sm",
    "--kit-shadow-ring",
    "--kit-shadow-scaled",
    "--kit-shadow-none",
  ])
  assert.deepEqual(catalog.motion.map((token) => token.cssVar), ["--kit-transition-fast"])
})

/*
 * A corner scale named `corner-radius` lists by its step. The cut used to land
 * after the first matching word, so every row read `radius-100`.
 */
check("a token is named after the whole run of words that classified it", () => {
  const catalog = parseLibrary(
    "css",
    ":root { --kit-corner-radius-100: 8px; --kit-corner-radius-200: 10px; --kit-border-radius-pill: 999px; --kit-color-ink: #000; }"
  )
  assert.deepEqual(catalog.radii.map((token) => token.name), ["100", "200", "pill"])
})

/*
 * A colour stored as bare channels paints nothing written as a bare variable:
 * `background-color: var(--background)` with `--background: 0 0% 100%` is
 * invalid. The function the file wraps it in travels with the token, so the
 * write can wrap it the same way.
 */
check("a channel colour carries the function that makes it a colour", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root { --background: 0 0% 100%; --kit-primary-rgb: 13, 110, 253; --kit-color-ink: #101010; --kit-color-page: #fff; }",
      ".bg { background-color: hsl(var(--background)); }",
      ".primary { background-color: rgba(var(--kit-primary-rgb), 0.5); }",
    ].join("\n")
  )
  assert.equal(byVar(catalog.colors, "--background").cssFunction, "hsl")
  assert.equal(byVar(catalog.colors, "--kit-primary-rgb").cssFunction, "rgba")
  assert.equal(byVar(catalog.colors, "--kit-color-ink").cssFunction, undefined)
})

/*
 * THEMES SWITCHED BY CLASS NAME. A system that names its themes after nothing
 * in particular (`.kit--white`, `.kit--g90`) keeps its whole palette in those
 * blocks, which read as a component's private variables and were dropped. What
 * gives a theme away is repeating the same long vocabulary as another class;
 * the first such class is the default, and a component's own variables are
 * still not tokens.
 */
check("classes that restate one vocabulary are themes, and the first is the default", () => {
  const names = Array.from({ length: 42 }, (_, index) => `--kit-layer-${index}`)
  const block = (selector, shade) =>
    `${selector} {\n${names.map((name, index) => `  ${name}: #${shade}${String(index % 10).repeat(2)};`).join("\n")}\n}`
  const catalog = parseLibrary(
    "css",
    [
      ":root { --kit-color-brand: #0f62fe; }",
      block(".kit--white", "ffff"),
      block(".kit--g90", "2626"),
      ".kit--button { --kit-button-padding: 12px; --kit-button-color-hover: #0050e6; }",
    ].join("\n")
  )
  assert.equal(catalog.colors.length, 1 + names.length)
  assert.equal(byVar(catalog.colors, "--kit-layer-1").values.light, "#ffff11", "a later theme overrode the first")
  assert.equal(byVar(catalog.colors, "--kit-button-color-hover"), null, "a component's variable became a token")
})

/*
 * A scale shipped only as variants chosen at run time declares no default
 * outside them. First-wins read its corners as the `none` variant — every
 * radius 0 — and its spacing at 90%. The variant that calls itself the default
 * is the one a page gets when nobody chose.
 */
check("among variant blocks, the one that names itself the default wins", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root { --kit-radius-2: calc(4px * var(--kit-radius-factor)); --kit-space-2: calc(8px * var(--kit-scaling)); --kit-color-ink: #000; --kit-color-page: #fff; }",
      ".kit-theme[data-radius='none'] { --kit-radius-factor: 0; }",
      ".kit-theme[data-radius='medium'] { --kit-radius-factor: 1; }",
      ".kit-theme[data-scaling='90%'] { --kit-scaling: 0.9; }",
      ".kit-theme[data-scaling='100%'] { --kit-scaling: 1; }",
    ].join("\n")
  )
  assert.equal(byVar(catalog.radii, "--kit-radius-2").values.default, 4)
  assert.equal(byVar(catalog.spacing, "--kit-space-2").values.default, 8)
})

/*
 * A component's parts set type too — `accordion__title`, `breadcrumb--sm` —
 * and read as roles they filled the text-style picker with one component's
 * internals. A doubled hyphen right after the namespace (`kit--type-body-01`)
 * is the one a role may carry. A leading of zero is not a style anyone sets.
 */
check("a component's parts and modifiers are not type roles", () => {
  const catalog = parseLibrary(
    "css",
    [
      ":root { --kit-color-ink: #000; }",
      ".kit--accordion__title { font-size: 14px; line-height: 20px; font-weight: 400; }",
      ".kit--breadcrumb--sm { font-size: 12px; line-height: 16px; }",
      ".kit--pagination-nav { font-size: 14px; line-height: 0; }",
      ".kit--type-body-01 { font-size: 14px; line-height: 20px; letter-spacing: 0.16px; }",
    ].join("\n")
  )
  assert.deepEqual(catalog.textStyles.map((token) => token.cssUtility), ["kit--type-body-01"])
})

check("a spacing value past any screen is a stand-in for no limit, not a step", () => {
  const catalog = parseLibrary(
    "css",
    ":root { --kit-padding-inline-max: 999999999px; --kit-padding-inline-normal: 16px; --kit-color-ink: #000; }"
  )
  assert.deepEqual(catalog.spacing.map((token) => token.cssVar), ["--kit-padding-inline-normal"])
})

// ── Manifest ───────────────────────────────────────────────────────────────

console.log("\nA design system written as a Figma-style manifest")

const meridian = parseLibrary("manifest", MANIFEST)

/*
 * The delegation, asserted against the real normaliser rather than a copy of
 * its output.
 *
 * `normalizeDesignSystemManifest` is what the HOST's own design system goes
 * through, and the entire promise of a library is that the merged catalog
 * cannot tell the two apart. A second implementation here would pass a test
 * written as a literal — and would then disagree with the host on the next
 * manifest feature only one of the two learned about.
 */
check("a manifest library is normalized by the module the host's own system uses", () => {
  const direct = normalizeDesignSystemManifest(JSON.parse(MANIFEST))
  assert.deepEqual(meridian.colors, direct.colors)
  assert.deepEqual(meridian.spacing, direct.spacing)
  assert.deepEqual(meridian.radii, direct.radii)
  assert.deepEqual(meridian.textStyles, direct.textStyles)
  assert.deepEqual(meridian.uiTextStyles, direct.uiTextStyles)
  assert.deepEqual(meridian.effects, direct.effects)
  assert.deepEqual(meridian.icons, direct.icons)
  assert.deepEqual(meridian.motion, direct.motion)
  assert.equal(meridian.name, direct.name)
  assert.equal(meridian.trackingUnit, direct.trackingUnit)
  // Not vacuous: the fixture really does carry every group.
  assert.equal(direct.colors.length, 2)
  assert.equal(direct.motion.length, 1)
})

check("an explicit name overrides the one the manifest gave itself", () => {
  assert.equal(meridian.name, "Meridian")
  assert.equal(parseLibrary("manifest", MANIFEST, { name: "Vendored" }).name, "Vendored")
})

check("components come across with an id of their own", () => {
  assert.equal(meridian.components.length, 1)
  const [button] = meridian.components
  assert.equal(button.id, "component:button")
  assert.equal(button.name, "Button")
  assert.equal(button.description, "The primary action control.")
  assert.equal(button.snippet, '<Button variant="primary">Label</Button>')
  assert.deepEqual(button.props, [
    { name: "variant", type: "enum", values: ["primary", "ghost"] },
    { name: "disabled", type: "boolean" },
  ])
})

check("a manifest with no components brings none, and it is not an error", () => {
  const catalog = parseLibrary("manifest", JSON.stringify({ name: "Bare", collections: [] }))
  assert.deepEqual(catalog.components, [])
  assert.deepEqual(catalog.colors, [])
})

/*
 * Breakpoints are a compile-time fact of the HOST's Tailwind build. A library
 * that claimed one would put a `md:` prefix in the inspector that compiles to
 * nothing in the app the designer is looking at.
 */
check("a library contributes no breakpoints, measures or aliases", () => {
  for (const key of ["breakpoints", "containerBreakpoints", "responsiveMeasures", "aliases"]) {
    assert.equal(key in meridian, false, `a library catalog carries ${key}`)
  }
  assert.ok(JSON.parse(MANIFEST).breakpoints, "the fixture no longer has a breakpoint to drop")
})

check("a manifest carries no drawings and names no icon attribute", () => {
  assert.deepEqual(meridian.iconDrawings, [])
  assert.equal(meridian.iconAttribute, "")
})

// ── DTCG / Style Dictionary ────────────────────────────────────────────────

console.log("\nA design system written as DTCG tokens")

const dtcg = parseLibrary("tokens", TOKENS, { name: "Nimbus Tokens" })

check("a token is named for the path it sits at", () => {
  assert.ok(byName(dtcg.colors, "color/brand/500"), "the dotted path was not joined with /")
  assert.ok(byName(dtcg.colors, "color/brand/600"))
  assert.ok(byName(dtcg.spacing, "space/md"))
  assert.ok(byName(dtcg.radii, "radius/card"))
})

check("$type decides the group", () => {
  assert.deepEqual(dtcg.effects.map((token) => token.name), ["elevation/card"])
  assert.deepEqual(dtcg.motion.map((token) => token.name), ["quickness/fast"])
  assert.deepEqual(dtcg.textStyles.map((token) => token.name), ["text/body"])
  assert.deepEqual(dtcg.textStyles[0].values.default, {
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: -0.01,
    fontWeight: 400,
  })
})

check("an untyped leaf is grouped by the shape of its value", () => {
  assert.ok(byName(dtcg.colors, "untyped/ink"), "a hex value was not read as a colour")
  assert.ok(byName(dtcg.spacing, "untyped/inset"), "a px value was not read as a spacing step")
  assert.equal(
    allTokens(dtcg).some((token) => token.name === "untyped/family"),
    false,
    "a font stack became a token"
  )
})

/*
 * These tokens have no live custom property behind them — a Style Dictionary
 * file is an input to a build, not something the browser resolves. A `cssVar`
 * here would make `authoredTokenMatches` claim an element was bound to a
 * variable that does not exist in the page.
 */
check("a DTCG token has no cssVar, because there is no variable to point at", () => {
  for (const token of allTokens(dtcg)) {
    assert.equal(token.cssVar, undefined, `${token.name} claims ${token.cssVar}`)
  }
})

check("values arrive in the shape the editor reads them in", () => {
  assert.deepEqual(byName(dtcg.colors, "color/brand/500").values, { light: "#5b8cff" })
  assert.equal(byName(dtcg.spacing, "space/md").values.default, 16)
  assert.equal(byName(dtcg.radii, "radius/card").values.default, 12)
})

check("a DTCG file brings no components, drawings or attribute", () => {
  assert.deepEqual(dtcg.components, [])
  assert.deepEqual(dtcg.iconDrawings, [])
  assert.equal(dtcg.iconAttribute, "")
  assert.equal(dtcg.name, "Nimbus Tokens")
})

/*
 * Style Dictionary v3 spells a reference with the leaf key on the end.
 *
 * `{color.core.blue.500.value}` is the syntax its own documentation gives, and
 * v4 drops the suffix. Looked up verbatim, the v3 spelling never matched, the
 * raw `{…}` string fell through to the value sniffer, and every alias in the
 * file disappeared — which in a real system means the SEMANTIC layer, the only
 * layer a designer picks a colour from, leaving the primitive ramp nobody names
 * a token by.
 */
check("a v3 reference resolves, trailing .value and all", () => {
  const catalog = parseLibrary(
    "tokens",
    JSON.stringify({
      color: {
        core: { blue: { 500: { value: "#0b5fff" } } },
        semantic: { action: { value: "{color.core.blue.500.value}" } },
      },
    })
  )
  assert.equal(catalog.colors.length, 2, "the alias was dropped")
  assert.equal(byName(catalog.colors, "color/semantic/action").values.light, "#0b5fff")
  // v4's spelling of the same reference keeps working.
  const v4 = parseLibrary(
    "tokens",
    JSON.stringify({
      color: {
        core: { blue: { 500: { $value: "#0b5fff", $type: "color" } } },
        semantic: { action: { $value: "{color.core.blue.500}", $type: "color" } },
      },
    })
  )
  assert.equal(byName(v4.colors, "color/semantic/action").values.light, "#0b5fff")
})

/*
 * A group's `$type` reaches the tokens under it.
 *
 * The spec is explicit (Design Tokens Format Module §5.2.2): a token's type
 * comes from the closest ancestor group that declares one, and a tool "MUST NOT
 * attempt to guess the type of a token by inspecting the contents of its
 * value". Reading the leaf alone did exactly that guess, and the guess fails in
 * the same direction every time — a duration and a shadow composite are neither
 * a colour nor a bare length, so both were dropped outright.
 *
 * The group names below are deliberately ones the name classifier has no
 * opinion about, so the only thing that can sort them is the inherited type.
 */
check("a group's $type reaches the leaves under it", () => {
  const catalog = parseLibrary(
    "tokens",
    JSON.stringify({
      pace: { $type: "duration", swift: { $value: "120ms" }, steady: { $value: "240ms" } },
      lift: { $type: "shadow", card: { $value: "0 2px 8px rgba(12, 16, 20, 0.16)" } },
    })
  )
  assert.deepEqual(catalog.motion.map((token) => token.name), ["pace/swift", "pace/steady"])
  assert.equal(catalog.motion[0].values.default.visualDuration, 0.12)
  assert.deepEqual(catalog.effects.map((token) => token.name), ["lift/card"])
})

/*
 * The object forms the current spec made normative.
 *
 * A non-string value collapsed to `""`, which dropped all three of these: the
 * 2024-onwards object dimension, the object colour, and the shadow composite —
 * and a shadow composite is a system's whole elevation scale, since nobody
 * writes a box-shadow as one string once their tool offers it as parts.
 *
 * The `legacy` entry is the older `{ "value": 4, "unit": "px" }` spelling, which
 * is the one that could be read as a Style Dictionary leaf whose value happens
 * to be 4. The sibling `unit` is the only thing that tells them apart.
 */
check("the object forms of a token value are read, not collapsed", () => {
  const catalog = parseLibrary(
    "tokens",
    JSON.stringify({
      size: { gap: { $type: "dimension", $value: { value: 8, unit: "px" } } },
      legacy: { pad: { value: 4, unit: "px", type: "dimension" } },
      palette: {
        red: { $type: "color", $value: { colorSpace: "srgb", components: [1, 0, 0], hex: "#ff0000" } },
        blue: { $type: "color", $value: { colorSpace: "srgb", components: [0, 0.4, 1], alpha: 0.5 } },
      },
      lift: {
        card: {
          $type: "shadow",
          $value: { color: "#00000029", offsetX: "0", offsetY: "2px", blur: "8px", spread: "0" },
        },
      },
    })
  )
  assert.equal(byName(catalog.spacing, "size/gap").values.default, 8)
  assert.equal(byName(catalog.spacing, "legacy/pad").values.default, 4, "the unit was read off the wrong key")
  assert.equal(byName(catalog.colors, "palette/red").values.light, "#ff0000")
  assert.equal(byName(catalog.colors, "palette/blue").values.light, "color(srgb 0 0.4 1 / 0.5)")
  assert.match(byName(catalog.effects, "lift/card").values.default, /2px 8px/)
})

/*
 * The JSON lane sorts by NAME before it sorts by value, exactly as the CSS lane
 * always has.
 *
 * Skipping the name step meant that in any file without usable types — which is
 * most of them — every radius, icon size and font size landed in the SPACING
 * picker, because by the time the value is all you have, all three are a number
 * with `px` on the end. The token's path is the name and it was already in
 * hand.
 *
 * A camel hump counts as a word boundary here, because a JSON key is written
 * `borderRadius` where a custom property is written `--border-radius`, and a
 * classifier that only knows the second spelling files a whole corner scale
 * under spacing.
 */
check("an untyped token sorts by its path before its value", () => {
  const catalog = parseLibrary(
    "tokens",
    JSON.stringify({
      borderRadius: { md: { value: "6px" }, lg: { value: "12px" } },
      iconSize: { sm: { value: "16px" } },
      space: { 4: { value: "16px" } },
    })
  )
  assert.deepEqual(catalog.radii.map((token) => token.name), ["borderRadius/md", "borderRadius/lg"])
  assert.deepEqual(catalog.icons.map((token) => token.name), ["iconSize/sm"])
  assert.deepEqual(catalog.spacing.map((token) => token.name), ["space/4"])
})

/*
 * A token manager's multi-set export: one file, two coordinate systems.
 *
 * Tokens Studio writes its sets as top-level groups, so a leaf's real path is
 * `global.colors.primary` — but a reference inside the file is written against
 * the RESOLVED set stack and says `{colors.primary}`. Indexed by full path
 * alone, every cross-set alias missed and the themed half of the file came back
 * empty. `$metadata.tokenSetOrder` is the stack, and it is in the file.
 *
 * The type vocabulary is the other half. `fontSizes` and `lineHeights` were
 * unmapped, so a font size fell through to the value sniffer and landed in
 * spacing, and a line height — a bare `1.25` — went looking for an axis it has
 * no business being on.
 */
check("a token manager's sets resolve against the stack they are written for", () => {
  const source = JSON.stringify({
    $metadata: { tokenSetOrder: ["global", "light"] },
    $themes: [
      { id: "1", name: "Light", selectedTokenSets: { global: "source", light: "enabled" } },
    ],
    global: { colors: { primary: { value: "#0b5fff", type: "color" } } },
    light: {
      bg: { value: "{colors.primary}", type: "color" },
      heading: { value: "24px", type: "fontSizes" },
      card: { value: "12px", type: "borderRadius" },
      leadingTight: { value: "1.25", type: "lineHeights" },
    },
  })
  assert.equal(detectLibraryKind("tokens.json", source), "tokens")
  const catalog = parseLibrary("tokens", source)
  assert.equal(byName(catalog.colors, "light/bg").values.light, "#0b5fff", "a set-relative alias missed")
  assert.deepEqual(catalog.textStyles.map((token) => token.name), ["light/heading"])
  assert.equal(catalog.textStyles[0].values.default.fontSize, 24)
  assert.deepEqual(catalog.radii.map((token) => token.name), ["light/card"])
  // A line height is not an axis this editor writes, and naming it is what
  // stops it being sniffed into the spacing picker as a plausible-looking step.
  assert.deepEqual(catalog.spacing, [])
})

/*
 * The typography composite, field by field.
 *
 * Each field is a token value in its own right: a reference into the file, an
 * object dimension, a weight by name. Read raw, all three came out as nothing —
 * and the format defines a unitless line height as a RATIO, which was read as
 * that many pixels: a body style with `lineHeight: 1.5` had 1.5px leading.
 */
check("a typography composite reads its references, its ratio and its named weight", () => {
  const catalog = parseLibrary(
    "tokens",
    JSON.stringify({
      size: { body: { $type: "dimension", $value: { value: 16, unit: "px" } } },
      type: {
        body: {
          $type: "typography",
          $value: {
            fontFamily: "Inter",
            fontSize: "{size.body}",
            lineHeight: 1.5,
            fontWeight: "Semi Bold",
            letterSpacing: { value: 0.5, unit: "px" },
          },
        },
        caption: { $type: "typography", $value: { fontSize: "12px", lineHeight: "150%", fontWeight: "bold" } },
      },
    })
  )
  assert.deepEqual(byName(catalog.textStyles, "type/body").values.default, {
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: 0.5,
    fontWeight: 600,
  })
  assert.deepEqual(byName(catalog.textStyles, "type/caption").values.default, {
    fontSize: 12,
    lineHeight: 18,
    letterSpacing: 0,
    fontWeight: 700,
  })
  assert.equal(catalog.trackingUnit, "px")
})

/*
 * One catalog states one tracking unit. A file mixing em and px used to be
 * declared an em file and read its px tracking as ems — thirty-two times too
 * wide on a 16px style. Each style's own size converts it instead.
 */
check("tracking in mixed units is restated in the one unit the catalog states", () => {
  const catalog = parseLibrary(
    "tokens",
    JSON.stringify({
      type: {
        title: { $type: "typography", $value: { fontSize: "20px", lineHeight: "28px", letterSpacing: "-0.01em" } },
        body: { $type: "typography", $value: { fontSize: "16px", lineHeight: "24px", letterSpacing: "0.5px" } },
      },
    })
  )
  assert.equal(catalog.trackingUnit, "em")
  assert.equal(byName(catalog.textStyles, "type/title").values.default.letterSpacing, -0.01)
  assert.equal(byName(catalog.textStyles, "type/body").values.default.letterSpacing, 0.0313)
})

/*
 * `dimension` says "a length" and nothing about which one. The format has no
 * radius, icon-size or font-size type, so a corner scale and an icon scale are
 * both `dimension` — and taking the type as the whole answer filed both under
 * spacing, along with every line height. The path decides between the LENGTH
 * axes only: a `stroke` width is still a width, not a colour.
 */
check("a dimension's path decides which length axis it belongs to", () => {
  const catalog = parseLibrary(
    "tokens",
    JSON.stringify({
      $type: "dimension",
      radius: { sm: { $value: "4px" } },
      icon: { size: { md: { $value: "20px" } } },
      space: { md: { $value: "16px" } },
      lineHeight: { body: { $value: "24px" } },
      border: { stroke: { width: { $value: "1px" } } },
    })
  )
  assert.deepEqual(catalog.radii.map((token) => token.name), ["radius/sm"])
  assert.deepEqual(catalog.icons.map((token) => token.name), ["icon/size/md"])
  assert.deepEqual(catalog.spacing.map((token) => token.name), ["space/md", "border/stroke/width"])
  assert.equal(allTokens(catalog).length, 4, "a line height reached an axis")
})

/*
 * Plain nested JSON — the shape most of the JSON a designer has is written in.
 *
 * A theme object exported from a component library, a Tailwind theme dumped to
 * JSON, a theme generator's JSON export: none of them wraps a leaf in
 * `{ "value": … }`, and a leaf that was not a plain object was skipped
 * outright, so all of them read as zero tokens.
 */
check("a plain nested theme object yields tokens named by their path", () => {
  const catalog = parseLibrary(
    "tokens",
    JSON.stringify({
      colors: { brand: { 500: "#0066cc", 600: "#0052a3" }, surface: "#ffffff" },
      spacing: { 4: "1rem", 6: "1.5rem" },
      borderRadius: { md: "0.375rem" },
      fontFamily: { sans: "Inter, sans-serif" },
    }),
    { name: "Theme" }
  )
  assert.deepEqual(catalog.colors.map((token) => token.name), [
    "colors/brand/500",
    "colors/brand/600",
    "colors/surface",
  ])
  assert.equal(byName(catalog.spacing, "spacing/4").values.default, 16)
  assert.equal(byName(catalog.radii, "borderRadius/md").values.default, 6)
  // Still nothing this editor can bind a font stack to.
  assert.equal(allTokens(catalog).some((token) => token.name === "fontFamily/sans"), false)
  // And a plain object that yielded nothing was never a token file: it is
  // refused rather than installed as a card that brings nothing.
  assert.throws(() => parseLibrary("tokens", '{"name":"app","scripts":{"dev":"next"}}'))
})

/*
 * The canonical machine-readable export of a design system held in Figma —
 * `GET /v1/files/:key/variables/local`.
 *
 * Nothing else in this module could see it. A variable carries no `$value` and
 * no nested value: its values live in `valuesByMode` under opaque mode ids, its
 * colours are 0-1 floats rather than anything CSS accepts, and its semantic
 * layer is aliases by variable id.
 *
 * The modes are the part worth having. A collection's modes ARE the light and
 * dark themes, named by whoever built the file, so the pair a colour picker
 * wants is already in the export — and an alias is read in the SAME mode, which
 * is what makes a semantic colour resolve to its own dark value rather than to
 * the primitive's default.
 */
check("a Figma variables export is read, modes and aliases included", () => {
  const source = JSON.stringify({
    status: 200,
    error: false,
    meta: {
      variableCollections: {
        "VariableCollectionId:1:1": {
          id: "VariableCollectionId:1:1",
          name: "Core",
          modes: [
            { modeId: "1:0", name: "Light" },
            { modeId: "1:1", name: "Dark" },
          ],
          defaultModeId: "1:0",
        },
      },
      variables: {
        "VariableID:1:2": {
          id: "VariableID:1:2",
          name: "color/surface",
          variableCollectionId: "VariableCollectionId:1:1",
          resolvedType: "COLOR",
          valuesByMode: {
            "1:0": { r: 1, g: 1, b: 1, a: 1 },
            "1:1": { r: 0.0627, g: 0.0745, b: 0.098, a: 1 },
          },
        },
        "VariableID:1:3": {
          id: "VariableID:1:3",
          name: "space/4",
          variableCollectionId: "VariableCollectionId:1:1",
          resolvedType: "FLOAT",
          valuesByMode: { "1:0": 16 },
        },
        "VariableID:1:4": {
          id: "VariableID:1:4",
          name: "color/page/background",
          variableCollectionId: "VariableCollectionId:1:1",
          resolvedType: "COLOR",
          valuesByMode: {
            "1:0": { type: "VARIABLE_ALIAS", id: "VariableID:1:2" },
            "1:1": { type: "VARIABLE_ALIAS", id: "VariableID:1:2" },
          },
        },
        "VariableID:1:5": {
          id: "VariableID:1:5",
          name: "flags/beta",
          variableCollectionId: "VariableCollectionId:1:1",
          resolvedType: "BOOLEAN",
          valuesByMode: { "1:0": true },
        },
      },
    },
  })
  assert.equal(detectLibraryKind("variables.json", source), "tokens")
  const catalog = parseLibrary("tokens", source)
  assert.deepEqual(byName(catalog.colors, "color/surface").values, {
    light: "#ffffff",
    dark: "#101319",
  })
  assert.deepEqual(byName(catalog.colors, "color/page/background").values, {
    light: "#ffffff",
    dark: "#101319",
  })
  assert.equal(byName(catalog.spacing, "space/4").values.default, 16)
  // A boolean is not a design token in any axis this editor offers.
  assert.equal(allTokens(catalog).some((token) => token.name === "flags/beta"), false)
})

// ── Icons ──────────────────────────────────────────────────────────────────

console.log("\nA library of icon drawings")

const glyphs = parseLibrary("icons", ICONS, { name: "Nimbus Icons" })

check("drawings are normalized, sorted, and the broken ones are dropped not thrown", () => {
  assert.deepEqual(glyphs.iconDrawings.map((icon) => icon.name), ["arrow-right", "circle"])
  const [arrow, circle] = glyphs.iconDrawings
  assert.equal(arrow.nodes.length, 2)
  assert.equal(arrow.rootFill, "none")
  assert.equal(arrow.rootStroke, "currentColor")
  // No `rootFill` in the source: an icon drawn in the current text colour is
  // the normal case, so it is the default rather than a required field.
  assert.equal(circle.rootFill, "currentColor")
  assert.equal("rootStroke" in circle, false)
})

check("an icon library contributes drawings and nothing else", () => {
  for (const group of [
    "colors", "spacing", "radii", "textStyles", "uiTextStyles", "effects", "icons", "motion",
    "components",
  ]) {
    assert.deepEqual(glyphs[group], [], `${group} is not empty`)
  }
})

check("the attribute glyphs name themselves with is declared, or defaulted", () => {
  assert.equal(glyphs.iconAttribute, "data-icon")
  const declared = parseLibrary(
    "icons",
    JSON.stringify({ $attribute: "data-lucide", box: { nodes: [["rect", { x: "3", y: "3" }]] } })
  )
  assert.equal(declared.iconAttribute, "data-lucide")
  assert.deepEqual(declared.iconDrawings.map((icon) => icon.name), ["box"])
})

// ── Counts and the one line that describes them ────────────────────────────

console.log("\nWhat a library says it brings")

check("counts are derived from the catalog, including the drawings", () => {
  assert.deepEqual(libraryCounts(nimbus), {
    colors: 3,
    spacing: 3,
    radii: 1,
    textStyles: 1,
    effects: 1,
    icons: 1,
    motion: 1,
    components: 0,
    iconDrawings: 0,
  })
  assert.deepEqual(libraryCounts(glyphs), {
    colors: 0,
    spacing: 0,
    radii: 0,
    textStyles: 0,
    effects: 0,
    icons: 0,
    motion: 0,
    components: 0,
    iconDrawings: 2,
  })
  assert.equal(libraryCounts(meridian).components, 1)
  assert.equal(libraryCounts(meridian).colors, 2)
})

check("the description names the biggest groups, at most three of them", () => {
  const line = describeLibrary("css", nimbus)
  assert.equal(typeof line, "string")
  assert.ok(line.length > 0, "a library with seven populated groups described itself as nothing")
  assert.ok(
    line.split("·").length <= 3,
    `"${line}" names more than three groups, which does not fit a 260px card`
  )
  assert.match(line, /3 colou?rs/)
  assert.equal(describeLibrary("icons", glyphs), "2 icons")
})

check("one of something is not one somethings", () => {
  const one = parseLibrary(
    "icons",
    JSON.stringify({ dot: { nodes: [["circle", { cx: "12", cy: "12", r: "2" }]] } })
  )
  assert.equal(describeLibrary("icons", one), "1 icon")
  const colour = parseLibrary("css", ":root { --color-only: #fff; }")
  assert.match(describeLibrary("css", colour), /^1 colou?r$/)
})

// ── Refusal ────────────────────────────────────────────────────────────────

console.log("\nMalformed input is refused, not half-read")

check("a manifest that is not JSON, or not a manifest, throws", () => {
  assert.throws(() => parseLibrary("manifest", "{ not json"))
  assert.throws(() => parseLibrary("manifest", "[]"))
  // Present and the wrong shape. Absence would be `[]`; this is a host mistake.
  assert.throws(() => parseLibrary("manifest", '{"collections": 5}'))
  assert.throws(() => parseLibrary("manifest", '{"textStyles": [{"name": "X"}]}'))
})

check("a token file that is not JSON, or has no tokens in it, throws", () => {
  assert.throws(() => parseLibrary("tokens", "not json at all"))
  assert.throws(() => parseLibrary("tokens", "[]"))
})

check("an icon file that is not a name-to-drawing object throws", () => {
  assert.throws(() => parseLibrary("icons", "{"))
  assert.throws(() => parseLibrary("icons", "[]"))
  assert.throws(() => parseLibrary("icons", '"a string"'))
})

/*
 * A stylesheet with no custom properties in it is the CSS equivalent of a
 * manifest with no collections: the file was pointed at by mistake. Installing
 * it as an empty library would put a card in the panel that brings nothing and
 * explains nothing.
 */
check("a stylesheet with no custom properties throws", () => {
  assert.throws(() => parseLibrary("css", ".card { padding: 8px; }"))
  assert.throws(() => parseLibrary("css", ""))
})

check("a kind nobody defined throws instead of guessing one", () => {
  assert.throws(() => parseLibrary("sketch", THEME))
  assert.throws(() => parseLibrary(null, THEME))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
