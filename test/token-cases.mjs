/**
 * Deterministic design-system catalog, token-matching, and token-row cases,
 * plus the chrome's own two-theme palette.
 *
 * Breakpoints and responsive classes live in responsive-cases.mjs.
 */

import assert from "node:assert/strict"
import path from "node:path"
import vm from "node:vm"
import { JSDOM } from "jsdom"

import { browserPrelude, loadConfig, resolveConfig } from "../config.mjs"

import { PACKAGE_DIR, requireHostConfig } from "./host.mjs"

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

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

async function loadEditorHelpers() {
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `
        export * from "./src/core/design-system"
        export { toClassUpdate } from "./src/core/tailwind"
        export { createContext } from "./src/core/context"
        export { installInspector } from "./src/panels/inspector"
      `,
      resolveDir: PACKAGE_DIR,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  )
}

/**
 * The chrome's own tokens and the stylesheet that gives the colour half of them
 * a value. Both, because the whole contract between them is that neither may
 * name a custom property the other does not.
 *
 * Its own bundle, ahead of everything else in this file, because the palette is
 * the editor's own and has nothing to do with a host app — and the host gate
 * below exits the process when there is no host on disk. Folded into
 * `loadEditorHelpers` these cases would silently stop running in a bare clone,
 * which is the one place a colour regression would go unnoticed longest.
 */
async function loadChromeTokens() {
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `
        export { tokens, themeProperties, THEMES, accentFill, declaredNests } from "./src/core/tokens"
        export { baseCss, paletteCss } from "./src/core/css/base"
        export { shellCss } from "./src/core/css"
      `,
      resolveDir: PACKAGE_DIR,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  )
}

// ── The chrome's own palette ───────────────────────────────────────────────

console.log("\nChrome palette")

const chrome = await loadChromeTokens()

/**
 * The declarations of one theme's block, as a Map of property to value.
 *
 * Read out of the shipped stylesheet rather than off the token module, because
 * the failure these cases exist to catch lives in the gap between the two: a
 * role the tokens reference and the stylesheet never declares resolves to its
 * fallback and looks fine in dark, then paints a dark surface into the middle
 * of the light theme. Nothing else in the suite would see that.
 */
function themeBlock(selector) {
  const match = chrome.paletteCss.match(
    new RegExp(`(^|\\n)${selector} \\{\\n([\\s\\S]*?)\\n\\}`, "m")
  )
  assert.ok(match, `no palette block for ${selector}`)
  const declarations = new Map()
  for (const line of match[2].split("\n")) {
    const pair = line.match(/^\s*(--[a-z0-9-]+):\s*(.+);$/)
    assert.ok(pair, `unparseable declaration: ${line}`)
    declarations.set(pair[1], pair[2])
  }
  return declarations
}

const DARK_BLOCK = themeBlock('\\[data-designlayer\\]\\[data-de-theme="dark"\\]')
const LIGHT_BLOCK = themeBlock('\\[data-designlayer\\]\\[data-de-theme="light"\\]')

check("every colour role is a reference, so one stylesheet can carry two themes", () => {
  const roles = Object.entries(chrome.tokens.color)
  assert.ok(roles.length >= 25, `only ${roles.length} colour roles — the group shrank`)
  for (const [role, value] of roles) {
    assert.match(
      value,
      /^var\(--de-color-[a-z0-9-]+, .+\)$/,
      `color.${role} is "${value}", which a run-time theme cannot move`
    )
  }
  // The syntax tints are themed for the same reason: their only ground is
  // `bgSunken`, and `bgSunken` moves.
  for (const [role, value] of Object.entries(chrome.tokens.code)) {
    assert.match(value, /^var\(--de-code-[a-z0-9-]+, .+\)$/, `code.${role} is "${value}"`)
  }
  // The shadows keep their geometry and theme only the tint: an offset and a
  // blur are not a colour, and a theme must not be able to move them.
  assert.match(chrome.tokens.shadow.float, /^0 18px 56px var\(--de-shadow-cast-soft, /)
  assert.match(chrome.tokens.shadow.popover, /^0 14px 44px var\(--de-shadow-cast, /)
  // The pairing export has to go through the tokens too, or every accent-filled
  // surface in the chrome stays on the dark theme's light indigo.
  assert.equal(
    chrome.accentFill,
    `background: ${chrome.tokens.color.accentSurface}; color: ${chrome.tokens.color.onAccent};`
  )
})

/*
 * The failure mode that ships a white label on a white ground.
 *
 * A role defined in one theme and missing from the other does not throw, does
 * not warn and does not show up in the theme that was being looked at while it
 * was written. It resolves to the dark fallback baked into the reference, so it
 * paints a dark-theme colour into the middle of the light chrome — a dark
 * surface under dark ink, or the reverse. Both directions are asserted because
 * an extra declaration is the same bug seen from the other end: a property
 * nothing references is a role that was renamed in one place only.
 */
check("both themes define exactly the properties the tokens reference", () => {
  const referenced = new Set(chrome.themeProperties())
  assert.ok(referenced.size > 30, `only ${referenced.size} themed properties`)

  // Every reference in the tokens really is one of them — the derivation from
  // camelCase to `--de-group-kebab` is the one typo here that produces no error.
  for (const group of ["color", "code"]) {
    for (const [role, value] of Object.entries(chrome.tokens[group])) {
      const property = value.slice(4, value.indexOf(","))
      assert.ok(referenced.has(property), `${group}.${role} references unknown ${property}`)
    }
  }

  assert.deepEqual([...chrome.THEMES], ["dark", "light"])
  for (const [name, block] of [["dark", DARK_BLOCK], ["light", LIGHT_BLOCK]]) {
    const declared = new Set(block.keys())
    const missing = [...referenced].filter((property) => !declared.has(property))
    const extra = [...declared].filter((property) => !referenced.has(property))
    assert.deepEqual(missing, [], `${name} never defines: ${missing.join(", ")}`)
    assert.deepEqual(extra, [], `${name} defines unreferenced: ${extra.join(", ")}`)
  }

  // Host pages own `<html>` too, so nothing here may claim an unprefixed name.
  for (const property of referenced) assert.match(property, /^--de-/)
})

check("the light theme is a recomputation, not the dark one copied across", () => {
  /*
   * Two roles are the same in both themes on purpose, and they are the two that
   * are not drawn on the chrome.
   *
   * Everything else here pairs an ink with a surface this stylesheet painted,
   * so a value that did not change between the blocks is a value somebody
   * forgot to recompute. These three are painted over the APP: the note pin's
   * numeral sits on a colour the user picked, and the two tones of the pin's
   * focus ring sit on whatever the page has there. The editor's theme is not
   * evidence about any of them, so flipping them with it is how the numeral
   * came to measure 3.4:1 in light — see `onUserColor` in `tokens.ts`.
   *
   * Listed by name rather than skipped by rule, so adding a fourth is a
   * decision somebody writes down instead of a test quietly covering less
   * ground.
   */
  const OVER_THE_APP = new Set([
    "--de-color-focus-halo",
    "--de-color-focus-core",
    // The modal veil: the kit's static 70% scrim, the same in both appearances.
    "--de-color-scrim",
    /*
     * `onAccent` joined this list when the palette moved to Figma's blues, and
     * for a related reason rather than the same one.
     *
     * It used to flip: near-black on the dark theme's light indigo, white on
     * the light theme's dark one. Both accent fills are now a saturated blue
     * — Figma's `bg-brand`, `#0c8ce9` in dark and `#007be5` in light — and
     * white is the ink that carries on each. So the value is identical across
     * the blocks BECAUSE the two fills are the same kind of colour, not
     * because anybody forgot to recompute it.
     */
    "--de-color-on-accent",
  ])
  const shared = [...DARK_BLOCK.keys()].filter(
    (property) =>
      !OVER_THE_APP.has(property) && DARK_BLOCK.get(property) === LIGHT_BLOCK.get(property)
  )
  assert.deepEqual(shared, [], `these roles never left the dark theme: ${shared.join(", ")}`)
  for (const property of OVER_THE_APP) {
    assert.equal(
      DARK_BLOCK.get(property),
      LIGHT_BLOCK.get(property),
      `${property} is drawn over the app, so it must not differ between themes`
    )
  }
  /*
   * And the DIRECTION is the point. Dark cuts its quiet steps out of the ground
   * with paper — the design foundations kit's chrome-wash recipe — while light
   * takes the kit's near-white ladder, which are literal cool rungs rather
   * than a mix: `#f0f2f5`, `#e9edf0` and friends carry the kit's faint blue
   * cast, which no percentage of near-black over white can reproduce.
   */
  const LADDER = new Set(["#f0f2f5", "#dce0e5", "#f8f9f9", "#e9edf0"])
  for (const property of ["--de-color-bg-hover", "--de-color-field", "--de-color-field-hover"]) {
    assert.match(DARK_BLOCK.get(property), /#ffffff \d+%/, `dark ${property} stopped lifting`)
    assert.ok(LADDER.has(LIGHT_BLOCK.get(property)), `light ${property} left the kit's near-white ladder`)
  }
})

/*
 * The dark theme is the appearance the editor shipped with, and this pins it.
 *
 * The conversion to custom properties is supposed to be invisible in dark: same
 * pixels, resolved a layer later. Spot values rather than the whole block,
 * because the block is generated and re-asserting all of it here would just be
 * the same table written twice.
 */
check("the dark block still carries the contrast-tuned values it shipped with", () => {
  assert.deepEqual(
    Object.fromEntries(
      [
        "--de-color-bg",
        "--de-color-bg-sunken",
        "--de-color-text",
        "--de-color-text-muted",
        "--de-color-text-dim",
        "--de-color-accent",
        "--de-color-on-accent",
        "--de-color-border-interactive",
      ].map((property) => [property, DARK_BLOCK.get(property)])
    ),
    {
      /*
       * The palette these pin is the design foundations kit's, at the
       * editor's density. `bg` is the kit's dark `--card` (oklch 0.205), the
       * control surface is its `--chrome-shelf` wash (paper 6%) over that
       * ground, the accent is its dark `--ring` indigo. This case pins the
       * ground and the mix TOGETHER on purpose — `bg-sunken` interpolates from
       * `bg`, so a ground changed in one place and not the other is exactly
       * the drift the assertion exists to catch.
       *
       * The inks stay white washes (75% is the kit's
       * `--chrome-muted-foreground`), tuned so `text-dim` keeps 4.5:1 on a
       * hovered control and a clear step above `text-disabled`.
       */
      "--de-color-bg": "#171717",
      "--de-color-bg-sunken": "color-mix(in srgb, #ffffff 6%, #171717)",
      "--de-color-text": "#fafafa",
      "--de-color-text-muted": "rgba(255,255,255,0.75)",
      "--de-color-text-dim": "rgba(255,255,255,0.70)",
      "--de-color-accent": "#798cff",
      "--de-color-on-accent": "#ffffff",
      "--de-color-border-interactive": "color-mix(in srgb, #ffffff 35%, transparent)",
    }
  )
  /*
   * The light ground is the kit's white page with its controls a step down on
   * `--secondary`; a popover is told apart by its shadow. Ink is the kit's
   * near-black `#0c1014`, never pure black, and the accent is its `--ring`
   * indigo, which carries white at 6.7:1 — so `onAccent` is white in both
   * themes, a deliberate cross-theme match listed above.
   */
  assert.equal(LIGHT_BLOCK.get("--de-color-bg"), "#ffffff")
  assert.equal(LIGHT_BLOCK.get("--de-color-bg-raised"), "#ffffff")
  assert.equal(LIGHT_BLOCK.get("--de-color-bg-sunken"), "#f0f2f5")
  assert.equal(LIGHT_BLOCK.get("--de-color-text"), "#0c1014")
  assert.equal(LIGHT_BLOCK.get("--de-color-accent"), "#3849da")
  assert.equal(LIGHT_BLOCK.get("--de-color-on-accent"), "#ffffff")
})

/*
 * Where the palette is declared, which is the half of this that a selector
 * typo silently breaks.
 *
 * `:root` and not `[data-designlayer]`: that attribute is on every element
 * the chrome builds, so declaring the palette on it re-declares it on every
 * descendant and a theme flipped on the root would reach nothing inside it.
 * `:root` is also the only ancestor shared by the four roots this package
 * mounts on `<body>` — the editor root, the options window, the token popover
 * and the design-system probe — which is what makes an inline `var()` in a
 * popover resolve at all.
 */
check("the palette is declared where every chrome root can inherit it", () => {
  // The declaration block no longer leads the sheet: the `@property`
  // registrations that make these roles animatable come first, and a
  // registration has to be parsed before the property it types is used. What
  // this case is about is the SELECTOR the values are declared on, so it looks
  // for the block rather than for the first line of the file.
  assert.match(chrome.paletteCss, /^\/\* -+ palette -+ \*\//)
  assert.match(chrome.paletteCss, /\n:root,\n\[data-designlayer\]\[data-de-theme="dark"\]/)
  assert.match(chrome.paletteCss, /\n:root\[data-de-theme="light"\],\n/)
  // Dark first and unconditional, so a document that never gets the attribute
  // written — storage blocked, boot threw — is still the editor as it shipped.
  assert.ok(
    chrome.paletteCss.indexOf(":root,") < chrome.paletteCss.indexOf(':root[data-de-theme="light"]'),
    "the light block no longer wins on order"
  )
  /*
   * Every role is registered, and registered as a colour.
   *
   * This is what makes the theme crossfade possible at all — an unregistered
   * custom property cannot be interpolated, so the transition below would be a
   * no-op. Checked against `themeProperties()` rather than a count, so a role
   * added to `PALETTE` without a registration fails here rather than silently
   * dropping out of the fade.
   */
  for (const property of chrome.themeProperties()) {
    assert.ok(
      chrome.paletteCss.includes(`@property ${property} {`),
      `${property} is declared but never registered, so it cannot animate`
    )
    assert.ok(
      chrome.paletteCss.includes(`transition:`) &&
        new RegExp(`${property} \\d+ms`).test(chrome.paletteCss.replace(/\s+/g, " ")),
      `${property} is registered but left out of the theme transition`
    )
  }
  // And it leads the sheet: every module after it reads these properties.
  assert.ok(chrome.baseCss.startsWith(chrome.paletteCss), "the palette is not first in base.ts")
})

/*
 * What must NOT have become a variable.
 *
 * Two of these scales are read by JavaScript as numbers — `tokens.icon.action`
 * is handed to `icon()` and `tokens.size.panelInset` to the drag clamp — so a
 * `var()` there is not a slower colour, it is `NaN` pixels. The rest simply do
 * not vary by theme, and a token that cannot answer "which value in which
 * theme" has no business in the palette.
 */
/*
 * Every gap in the chrome is on the kit's spacing scale.
 *
 * There was no scale at all before this: a survey of the stylesheets found 1,
 * 2, 3, 4, 5, 6, 7, 8, 10, 12, 16 and 24 in use, which is not a system but
 * twelve decisions that happened to land near each other. Six of those were off
 * the kit entirely, and 6px alone accounted for 61 declarations.
 *
 * Asserted against the EMITTED stylesheet rather than the source, because the
 * point is what ships: a token interpolated into a string is only worth
 * anything if the number that comes out the other end is on the scale. That
 * also catches the arithmetic call sites, which the source text cannot.
 */
check("every spacing value in the shipped stylesheet is on the kit's scale", () => {
  const scale = new Set(Object.values(chrome.tokens.space))
  // Rhythm only. `border-radius` has its own scale, `overflow-clip-margin` is
  // focus-ring reach, and a `-2px` inset is a hit target being grown past its
  // control rather than a gap between two things.
  const RHYTHM = /(?:^|[;{\s])(padding|margin|gap|row-gap|column-gap)(-top|-right|-bottom|-left)?:\s*([^;}]+)/g
  /*
   * Derived geometry, exempt by name rather than by silence.
   *
   * A value computed to make two things line up is not a designer choosing a
   * gap, and rounding it onto the scale would break the alignment it exists to
   * create. Listing the exact declaration keeps the exemption a reviewed act: an
   * off-scale value cannot hide behind a blanket allowance for arithmetic.
   *
   * Empty today, and the entry it used to hold is worth recording. The seam's
   * hairline has to measure what a plain break between two clusters measures, so
   * it is the cluster margin minus the bar's own flex gap. That was `space.sm`
   * minus 2, which is 6 and off the scale; the toolbar's two gaps have since
   * moved up a rung each, and `space.md` minus `space["2xs"]` lands on `space.sm`.
   * The subtraction is unchanged — it stopped needing an exemption because both
   * of its operands moved, which is the outcome this set exists to wait for.
   */
  const DERIVED = new Set()
  /*
   * A concentric container's padding, which is the same exemption arrived at a
   * second way and is therefore COMPUTED rather than listed.
   *
   * `nest()` declares the gap between a container's curve and its children's —
   * always a step on the scale — and then hands back the padding that leaves
   * that gap once the container's own border has taken its pixel. So a pill
   * with a hairline pads by 3 to hold a gap of 4. The 3 is not a rhythm
   * decision anybody made and putting it back on the scale would knock the
   * radii out of true, which is exactly the bug `nest()` exists to prevent.
   *
   * Generated from the register instead of spelled out, because the listed form
   * of this exemption would be a set of odd numbers with no way to tell a
   * derived one from a typo. Only the nests that actually HAVE a hairline are
   * exempt: an off-scale padding on a borderless container is still a mistake.
   */
  /*
   * A hairline-adjusted step is still a step, and every SIDE is checked rather
   * than the shorthand being waved through whole. `.de-ann-item` writes
   * `3px 3px 3px 7px` — a `space["2xs"]` gap on three sides and a `space.sm` one on
   * the leading edge, each a pixel under because the row's own border sits in
   * the gap. Matching the declaration as a literal string would have meant
   * regenerating this exemption every time a side moved, and would have let a
   * genuine typo ride along inside an otherwise-derived shorthand.
   */
  const adjusted = new Set()
  for (const n of chrome.declaredNests()) {
    if (n.hairline > 0) for (const step of scale) adjusted.add(step - n.hairline)
  }
  const derivedPadding = (property, value) =>
    property === "padding" &&
    adjusted.size > 0 &&
    value
      .trim()
      .split(/\s+/)
      .every((side) => {
        const px = Number.parseFloat(side)
        return Number.isFinite(px) && (px === 0 || scale.has(px) || adjusted.has(px))
      })

  const offenders = new Map()
  for (const match of chrome.shellCss.matchAll(RHYTHM)) {
    for (const value of match[3].matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
      const px = Math.abs(Number.parseFloat(value[1]))
      if (px === 0 || scale.has(px)) continue
      const decl = `${match[1]}${match[2] ?? ""}: ${match[3].trim()}`
      if (DERIVED.has(decl)) continue
      if (derivedPadding(`${match[1]}${match[2] ?? ""}`, match[3])) continue
      offenders.set(decl, px)
    }
  }
  assert.deepEqual(
    [...offenders.keys()],
    [],
    `off the spacing scale (${[...new Set(offenders.values())].sort((a, b) => a - b).join(", ")})`
  )
})

/*
 * A rule's selector, with the comment block that precedes it removed.
 *
 * The rule regex these sweeps share starts a match at the last `}` or newline,
 * so anything between one rule and the next — which in this stylesheet is
 * usually thirty lines of argument — arrives glued to the front of the
 * selector. Harmless while a case only greps the declarations; not harmless the
 * moment one compares a selector to the string it should be.
 */
const selectorOf = (rule) =>
  rule[2]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
    .replace(/\s+/g, " ")

/*
 * The same sweep, one property over: every leading in the sheet is a ROLE.
 *
 * The spacing case above exists because a survey found twelve numbers where a
 * scale should have been. Leading was in exactly that state and nobody had
 * looked: `1`, `1.4`, `1.45`, `1.5`, `1.55`, `14px`, `15px` and `16px` across
 * forty declarations, with no rule anywhere saying which of 1.4 and 1.45 a
 * wrapping sentence was supposed to take — they differ by 0.6px at the body
 * rung, which is why nobody could tell and why it kept happening.
 *
 * Read off the emitted sheet for the reason the spacing sweep is: the point is
 * the number that ships. A `${t.type.leadingBody}` in the source proves only
 * that somebody typed a token name.
 *
 * The px exemptions are the two places where the line box IS the box — a badge
 * with no height of its own, centred by its own leading — and they are listed
 * rather than pattern-matched so that a third one is a decision somebody makes
 * on purpose.
 */
check("every line-height in the shipped stylesheet is one of the type scale's leading roles", () => {
  const roles = new Map(
    Object.entries(chrome.tokens.type)
      .filter(([role]) => role.startsWith("leading"))
      .map(([role, value]) => [String(value), role])
  )
  assert.ok(roles.size >= 4, `only ${roles.size} leading roles — the scale shrank`)

  /*
   * A leading that is really a box height, named with its reason.
   *
   * `.de-layer-saved` is an 18px tally chip with no `height`; `.de-ann-badge` is
   * a 14px-tall outlined chip. Both centre their single line by being exactly
   * one line tall, which is a geometry decision and not a reading one — routing
   * either through a unitless role would resize the chip.
   */
  const BOX_HEIGHT = new Set(["18px", "14px"])

  const offenders = new Map()
  for (const match of chrome.shellCss.matchAll(/(?:^|[;{\s])line-height:\s*([^;}]+)/g)) {
    const value = match[1].trim()
    if (roles.has(value) || BOX_HEIGHT.has(value)) continue
    offenders.set(value, (offenders.get(value) ?? 0) + 1)
  }
  assert.deepEqual(
    [...offenders.keys()],
    [],
    "a leading off the scale — use tokens.type.leadingFlush / leadingRow / leadingBody / leadingCode"
  )

  // And the roles themselves clear the kit's tightest wrapping leading: its
  // caption role, 12/16. `leadingFlush` is the deliberate exception and is
  // only ever set on a single line that cannot wrap.
  for (const [value, role] of roles) {
    if (role === "leadingFlush") continue
    assert.ok(
      Number.parseFloat(value) >= 16 / 12 - 0.001,
      `type.${role} is ${value}, under the kit's caption leading (12/16)`
    )
  }
  // Unitless, all of them, or a line box stops tracking the size it sits on:
  // the flat `16px` this replaced landed as 1.6 on the `micro` rung and 1.33 on
  // `body`, which is the ratio inverted across the scale it was meant to serve.
  for (const [value, role] of roles) {
    assert.match(String(value), /^[\d.]+$/, `type.${role} is "${value}" — leading must be unitless`)
  }
})

/*
 * A value that changes in place does not shift the row it sits in.
 *
 * This chrome is an instrument panel: the canvas badge counts up through a
 * drag, the tab's change badge crosses 9, the lint summary rewrites its own
 * total, an inspector field is scrubbed a digit at a time. Proportional figures
 * move the layout under every one of them.
 *
 * The guarantee is asserted at the root rather than per surface, because the
 * per-surface version is what failed: nine rules across eight files had it and
 * the ones that did not — the lint group count, the summary line, an options
 * folder's tally — are the same kind of thing, just noticed later. A sweep for
 * "did somebody remember this one" can only ever be as complete as the list
 * somebody wrote; a root declaration has nothing to forget.
 *
 * So both halves are checked: the root declares it, AND nothing re-declares it,
 * because a second declaration is the beginning of the list coming back.
 */
check("a value that changes in place does not shift the row it sits in", () => {
  const rules = [...chrome.shellCss.matchAll(/(^|\n)([^{}@\n][^{}]*)\{([^{}]*)\}/g)]
  const declaring = rules
    .filter((rule) => /font-variant-numeric:\s*tabular-nums/.test(rule[3]))
    .map(selectorOf)

  assert.deepEqual(
    declaring,
    ["[data-designlayer]"],
    "tabular figures belong once on the chrome root — see the argument in css/base.ts"
  )

  /*
   * And the form controls, which do not inherit it.
   *
   * Every UA ships the `font` shorthand on an `<input>`, and the shorthand
   * resets `font-variant` — so the inspector's number fields compute `normal`
   * however the root is set. The stylesheet already restates `font-family` and
   * `font-size` on every control for the same reason; this is the third
   * property in that set and the one that was missing.
   */
  const inherits = rules.find((rule) => /font-variant-numeric:\s*inherit/.test(rule[3]))
  assert.ok(inherits, "no rule hands the figures to form controls, which reset font-variant")
  for (const element of ["input", "textarea", "select", "button"]) {
    assert.match(inherits[2], new RegExp(`\\b${element}\\b`), `${element} misses out on the figures`)
  }
})

/*
 * macOS smoothing is a PAIR, and half of it is worse than none.
 *
 * `-webkit-font-smoothing` was here on its own, which is the half Chromium and
 * WebKit read. Firefox reads the other one, so on macOS it kept subpixel
 * antialiasing and drew the whole chrome a visible notch heavier than the same
 * build in Safari — one frame around the product, two weights, depending on
 * which browser the app under review happened to be open in.
 *
 * Once, on the root, is the rest of the rule: these are inherited properties
 * and a component that restates them is a component that can disagree.
 */
check("macOS font smoothing is declared as a pair, once, at the root", () => {
  const rules = [...chrome.shellCss.matchAll(/(^|\n)([^{}@\n][^{}]*)\{([^{}]*)\}/g)]
  const webkit = rules.filter((rule) => /-webkit-font-smoothing:/.test(rule[3]))
  const moz = rules.filter((rule) => /-moz-osx-font-smoothing:/.test(rule[3]))
  assert.equal(webkit.length, 1, `${webkit.length} rules set -webkit-font-smoothing; one may`)
  assert.equal(moz.length, 1, "-moz-osx-font-smoothing is missing, so Firefox on macOS renders heavier")
  assert.match(webkit[0][3], /-webkit-font-smoothing:\s*antialiased/)
  assert.match(moz[0][3], /-moz-osx-font-smoothing:\s*grayscale/)
  assert.equal(selectorOf(webkit[0]), selectorOf(moz[0]), "the pair is split across two selectors")
  assert.equal(selectorOf(webkit[0]), "[data-designlayer]", "smoothing belongs on the chrome root")
})

/*
 * "Disabled" is said with ink, never with `opacity`, and this is what stops it
 * coming back.
 *
 * Three separate controls had shipped an unreadable disabled state and all
 * three were the same mistake: `opacity` fades a control's ink and its fill by
 * the same factor toward whatever is behind them, so the pair drifts together
 * and the resulting ratio depends on a surface the rule cannot see. On the
 * primary pill it ended at 1.06:1 — near-black text on a near-black plate,
 * which is the disabled "Send to agent" that started this.
 *
 * A grep is the right shape of test. The defect is not that one measured number
 * came out wrong, it is that a TECHNIQUE is wrong, and the technique is visible
 * in the source in a way its consequences are not.
 */
check("no control says it is disabled by fading itself", () => {
  const offenders = []
  for (const rule of chrome.shellCss.matchAll(/(^|\n)([^{}@\n][^{}]*)\{([^{}]*)\}/g)) {
    const selector = rule[2].trim().replace(/\s+/g, " ")
    if (!/\[disabled\]|:disabled|aria-disabled="true"/.test(selector)) continue
    const faded = rule[3].match(/(?:^|[;\s])opacity:\s*([^;]+);/)
    if (faded) offenders.push(`${selector} { opacity: ${faded[1].trim()} }`)
  }
  assert.deepEqual(
    offenders,
    [],
    "a disabled state is fading itself instead of naming its ink — use `tokens.color.textDisabled`"
  )
})

/*
 * No surface paints a colour the palette does not own.
 *
 * The note pins used to take a user-picked hex through `--de-ann-color`, the
 * one fill in the chrome outside both theme blocks. They wear the indigo
 * accent now, so any custom property that is not a palette role, painted as a
 * colour, is a regression to a private palette.
 */
check("every painted colour comes from the palette, not a private property", () => {
  // A local pass-through (`--de-lint-bg: var(--de-color-accent-soft, …)`) is
  // fine: every value it is ever given is a palette role or transparent.
  const passThrough = (property) => {
    const values = [...chrome.shellCss.matchAll(new RegExp(`${property}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim())
    return values.length > 0 && values.every((value) => value === "transparent" || /^var\(--de-color-[a-z-]+,/.test(value))
  }
  // A property read with a length or percentage fallback is a position, not a
  // colour — the slider's `var(--de-fill, 0%)` is where its gradient stops.
  const position = (fallback) => /^-?[\d.]+(%|px)?$/.test(fallback ?? "")
  const strays = new Set()
  for (const match of chrome.shellCss.matchAll(/(?:background|color|border(?:-color)?|fill|stroke):[^;]*?var\((--de-[a-z-]+)(?:,\s*([^)]*))?\)/g)) {
    if (position(match[2]?.trim())) continue
    if (!DARK_BLOCK.has(match[1]) && !passThrough(match[1])) strays.add(match[1])
  }
  assert.deepEqual([...strays], [], "a colour is read from a property the theme blocks do not declare")
})

/*
 * The disabled ink clears the STRICTER of its two floors on every ground.
 *
 * Computed rather than pinned, because pinning the string is exactly what let
 * the last value through: 40% white looked like a considered number and put the
 * disabled Copy pill's label at 3.2:1. A glyph owes 3:1 and text owes 4.5:1,
 * one role serves both, so 4.5 is the bar.
 *
 * Dark only. Its values are plain `rgba()` over hex grounds and resolve with
 * arithmetic; the light theme's are `color-mix()`, which needs a browser, and
 * is checked in the live sweep instead.
 */
check("disabled ink is readable on every ground the dark chrome draws", () => {
  const channel = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const hex = (value) => {
    const m = /^#([0-9a-f]{6})$/i.exec(value.trim())
    assert.ok(m, `not a plain hex ground: ${value}`)
    const n = Number.parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  // The raised and sunken grounds are `lift()`/`press()` output, so they arrive
  // as `color-mix(in srgb, <hex> N%, <hex>)` rather than as a plain colour. srgb
  // mixing is a straight per-channel lerp, which is the one case worth resolving
  // here — anything else should fail loudly in `hex` rather than be guessed at.
  const ground = (value) => {
    const mix = /^color-mix\(in srgb,\s*(#[0-9a-f]{6})\s+([\d.]+)%,\s*(#[0-9a-f]{6})\)$/i.exec(
      value.trim()
    )
    if (!mix) return hex(value)
    const [a, weight, b] = [hex(mix[1]), Number.parseFloat(mix[2]) / 100, hex(mix[3])]
    return { r: a.r * weight + b.r * (1 - weight), g: a.g * weight + b.g * (1 - weight), b: a.b * weight + b.b * (1 - weight) }
  }
  const over = (fg, bg, alpha) => ({
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  })
  const alphaOf = (role) =>
    Number.parseFloat(/rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/.exec(DARK_BLOCK.get(role))[1])

  const alpha = alphaOf("--de-color-text-disabled")
  const white = { r: 255, g: 255, b: 255 }
  const measured = ["--de-color-bg", "--de-color-bg-raised", "--de-color-bg-sunken"].map((role) => {
    const behind = ground(DARK_BLOCK.get(role))
    return { role, ratio: contrast(over(white, behind, alpha), behind) }
  })
  const worst = measured.reduce((a, b) => (a.ratio < b.ratio ? a : b))
  assert.ok(
    worst.ratio >= 4.5,
    `disabled ink is ${worst.ratio.toFixed(2)}:1 on ${worst.role}, under the 4.5:1 a label needs`
  )
  // And still visibly OFF. A disabled control that reads as brightly as a live
  // one is a different defect arriving from the other direction.
  const live = alphaOf("--de-color-text-dim")
  assert.ok(alpha < live, `disabled ink (${alpha}) is not quieter than textDim (${live})`)
})

/*
 * A selected control's glyph is WHITE, and the fill under it is dark enough to
 * let it be read as white.
 *
 * Both halves, because either one alone is how this broke. The ink was already
 * `onAccent` and `onAccent` was already `#ffffff`, so by the stylesheet the
 * pressed Notes and Inspect squares were drawing a white mark — and on screen
 * they were not: the dark theme's fill was the accent as INK (a light blue
 * meant for strokes on near-black), and white on it measured 1.9:1. A glyph at
 * that ratio does not read as white, it reads as a pale smudge the colour of
 * the chip, which is what the designer reported.
 *
 * So asserting the ink token is white proves nothing on its own, and neither
 * does any single hex. What has to hold is the RELATION between the two halves
 * of the pair, in both themes: the fill is chosen so that white survives on it.
 *
 * 3:1 on the chip, which is the floor a MARK is owed — WCAG 1.4.11, the rule
 * for a control's non-text parts, and the ratio Figma's own selected tool sits
 * at. A word needs 4.5:1 and cannot take this fill, which is why the palette
 * carries a second, darker one: `accentSurfaceText`, checked below at the
 * stricter floor. Two roles rather than one compromise, because a fill dark
 * enough for a label is a fill too dark to read as the same accent the strokes
 * and focus rings are drawn in.
 *
 * Arithmetic, not a browser: every role here resolves to plain hex in both
 * themes. A theme that moves one to a `color-mix()` fails loudly in `hex` below
 * rather than quietly skipping the measurement.
 */
check("a selected control's white glyph is readable on the fill it sits on", () => {
  const channel = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  const hex = (value, what) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(value).trim())
    assert.ok(m, `${what} is "${value}", which this check cannot measure — resolve it to a hex`)
    const n = Number.parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  for (const [theme, block] of [
    ["dark", DARK_BLOCK],
    ["light", LIGHT_BLOCK],
  ]) {
    const ink = block.get("--de-color-on-accent")
    assert.equal(
      ink.trim().toLowerCase(),
      "#ffffff",
      `the ${theme} theme's selected glyph is "${ink}" — a selected control draws its mark in white`
    )
    const white = hex(ink, "the ink")
    const chip = ratio(white, hex(block.get("--de-color-accent-surface"), `the ${theme} chip`))
    assert.ok(
      chip >= 3,
      `white on the ${theme} accent chip is ${chip.toFixed(2)}:1 — the glyph will read as the chip, not as white`
    )
    // The same accent under a WORD, which is a different fill and a stricter
    // floor. Asserted here rather than wherever the pill is styled, because the
    // failure is in the palette: a single accent fill serving both is how a
    // selected glyph and a primary label end up sharing one wrong ratio.
    const worded = block.get("--de-color-accent-surface-text")
    if (worded) {
      const label = ratio(white, hex(worded, `the ${theme} worded fill`))
      assert.ok(
        label >= 4.5,
        `white on the ${theme} worded accent fill is ${label.toFixed(2)}:1, under the 4.5:1 a label needs`
      )
    }
  }
})

/*
 * THE SEMANTIC FILLS CARRY AN INK THAT FLIPS, AND THE ACCENT'S DOES NOT.
 *
 * These were one role until the accent moved to Figma's published blues. That
 * move was right and it broke everything else sharing the ink, silently and in
 * one direction: the blues are dark fills in BOTH themes, so `onAccent`
 * correctly became `#ffffff` in both — and the six semantic hues, which are
 * pale in dark and deep in light precisely so they can be read as ink on their
 * own ground, were left with white on the pale ones.
 *
 * The regression is the reason this case is measured rather than pinned. Three
 * of the five call sites carried a comment naming "white on it measures about
 * 2.3:1" as a bug they had already fixed, and all three had gone back to
 * exactly 2.31:1 without anybody editing them. A test asserting the token
 * NAMES would have passed throughout; only the ratio catches a role changing
 * under its callers.
 *
 * Both floors, because the two roles fail in opposite directions and a single
 * assertion would let one of them through: a semantic fill has to carry
 * `onSemantic` at 4.5:1 — these are labels and glyphs both, so the stricter
 * floor — and `onAccent` must stay white, which the case above already pins.
 *
 * Arithmetic, not a browser: every hue here is plain hex in both themes, and a
 * theme that moves one to a `color-mix()` fails loudly in `hex` rather than
 * quietly skipping the measurement.
 */
check("a semantic fill carries ink that flips with the theme, and clears the floor", () => {
  const channel = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  const hex = (value, what) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(value).trim())
    assert.ok(m, `${what} is "${value}", which this check cannot measure — resolve it to a hex`)
    const n = Number.parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  // Every role in the palette that is used as a FILL with text or a glyph on
  // it. Named rather than discovered, because `guide` and `measure` are the
  // same hue and only one of them is ever filled — a sweep would report a pass
  // for a pair nothing renders.
  const FILLS = [
    "--de-color-success",
    "--de-color-danger",
    "--de-color-lint-warning",
    "--de-color-component",
    "--de-color-guide",
  ]

  for (const [theme, block] of [
    ["dark", DARK_BLOCK],
    ["light", LIGHT_BLOCK],
  ]) {
    const ink = hex(block.get("--de-color-on-semantic"), `the ${theme} semantic ink`)
    for (const role of FILLS) {
      const declared = block.get(role)
      assert.ok(declared, `${role} is missing from the ${theme} theme`)
      const measured = ratio(ink, hex(declared, `the ${theme} ${role}`))
      assert.ok(
        measured >= 4.5,
        `${role} in ${theme} carries its ink at ${measured.toFixed(2)}:1, under the 4.5:1 a label needs`
      )
    }
  }

  /*
   * And the two inks really are different, in the theme where it matters.
   *
   * The floors above would all still pass if `onSemantic` were quietly pointed
   * back at `onAccent` in a future retune AND the hues were darkened to suit —
   * which is a defensible change, but not one that should happen by accident
   * while six comments still explain why the ink flips. In dark the accent fill
   * is a deep blue wanting white and the semantic hues are pale wanting black,
   * so the two inks disagreeing is the invariant, not an implementation detail.
   */
  assert.notEqual(
    DARK_BLOCK.get("--de-color-on-semantic").trim().toLowerCase(),
    DARK_BLOCK.get("--de-color-on-accent").trim().toLowerCase(),
    "the semantic ink and the accent ink are the same in dark — one of the two fills is unreadable"
  )
})

/*
 * Every corner is a squircle, and the circles are not.
 *
 * Both halves matter. Without the first, \`corner-shape\` reaches only the rules
 * somebody remembered, and one arc-cornered surface among smooth ones is the
 * kind of wrongness that gets noticed without being identified. Without the
 * second, `border-radius: 50%` stops meaning a circle: at that radius the
 * corner box is the whole side, so a superellipse does not smooth the launcher
 * disc, it reshapes it into a rounded square.
 */
check("the chrome's corners are squircles, and its circles are left alone", () => {
  assert.match(
    chrome.shellCss,
    /:where\(\[data-designlayer\], \[data-designlayer\] \*\)[\s\S]{0,160}?corner-shape:\s*superellipse\(2\)/,
    "no chrome-wide `corner-shape` — every corner falls back to a circular arc"
  )
  const optOut = chrome.shellCss.match(/([^{}]*)\{\s*corner-shape:\s*round;\s*\}/)
  assert.ok(optOut, "nothing opts out, so the chrome's round things are no longer round")
  for (const circle of [".de-launcher", ".de-ann-marker", ".de-ann-index"]) {
    assert.ok(optOut[1].includes(circle), `${circle} is a circle and is not opting out`)
  }
})

check("the literal scales are still literal", () => {
  const { icon, size, type, radius, duration, ease, easeSpring, font } = chrome.tokens
  for (const [group, values] of [["icon", icon], ["size", size]]) {
    for (const [role, value] of Object.entries(values)) {
      assert.equal(typeof value, "number", `${group}.${role} is no longer a number`)
    }
  }
  assert.deepEqual(
    { ...icon },
    { marker: 12, inline: 14, action: 16, chrome: 18, header: 20, feature: 24 }
  )
  /*
   * The design foundations kit's own ladders, asserted as sets rather than as
   * a floor: radius 4/8/10/12/14/16/18/22/26 and spacing
   * 2/4/6/8/12/16/20/24/28/32/40, so a value that is merely "big enough" is
   * still wrong here.
   * Type is the exception and is checked as a floor above, because its three
   * steps are ours to place and only the bottom of the ramp was specified.
   */
  assert.deepEqual(Object.values(radius), [
    "4px", "8px", "10px", "12px", "14px", "16px", "18px", "22px", "26px",
  ])
  assert.deepEqual(Object.values(chrome.tokens.space), [2, 4, 6, 8, 12, 16, 20, 24, 28, 32, 40])
  for (const [role, value] of Object.entries(chrome.tokens.space)) {
    assert.equal(typeof value, "number", `space.${role} must stay a number for arithmetic`)
  }
  /*
   * The type floor, pinned as a floor rather than as three values.
   *
   * It has moved twice: 11/10/9 was density tuned on a large display, 13/12/12
   * was a hard 12px brief that spent a rung to buy legibility, and 12/11/10 is
   * the kit's own floor with all three steps real again. Asserting the MINIMUM
   * keeps the hierarchy free to move and the one number that was specified
   * fixed — which is what stopped the 11px body from surviving a third time.
   */
  for (const [role, value] of Object.entries(type)) {
    if (typeof value !== "string" || !value.endsWith("px")) continue
    assert.ok(
      Number.parseFloat(value) >= 10,
      `type.${role} is ${value} — nothing in the chrome may be set below 10px`
    )
  }
  assert.equal(type.body, "12px")
  assert.equal(type.weightSection, 600)
  assert.equal(duration.reveal, "250ms")
  assert.equal(duration.exit, "150ms")
  assert.match(ease, /^cubic-bezier\(/)
  assert.match(easeSpring, /^cubic-bezier\(/)

  const flat = [
    ...Object.values(radius),
    ...Object.values(duration),
    ...Object.values(type),
    ...Object.values(font),
    ease,
    easeSpring,
  ].map(String)
  for (const value of flat) {
    assert.doesNotMatch(value, /var\(/, `a theme-invariant scale went through a variable: ${value}`)
  }
})

console.log("\nDesign-system catalog")

/**
 * A REAL host app's config, and its numbers are deliberately pinned below.
 *
 * That makes this suite one of the four places the editor is coupled to a real
 * app rather than a fixture, which is the point: it is the regression net that
 * catches a change to the tool silently changing what a real app sees, and the
 * numbers below are the pinned host app's. The host-AGNOSTIC contract — that
 * the same code reads a design system it has never met, with differently spelled
 * `@theme` namespaces, absent token groups, a Tailwind v3 scale, or no manifest
 * at all — is proved without this file, on the fixture hosts in
 * host-agnostic-cases.mjs.
 */
const { root: HOST_ROOT, configPath: HOST_CONFIG } = requireHostConfig("token-cases")
const workspace = await loadConfig({ configPath: HOST_CONFIG })
const catalog = workspace.designSystem.catalog
const prelude = browserPrelude(workspace, { proxyPort: 4567 })
const browserSandbox = { window: {} }
vm.runInNewContext(prelude, browserSandbox)

check("the host app's catalog is the non-vacuous 115-asset export", () => {
  const counts = {
    colors: catalog.colors.length,
    spacing: catalog.spacing.length,
    radii: catalog.radii.length,
    text: catalog.textStyles.length + catalog.uiTextStyles.length,
    effects: catalog.effects.length,
    icons: catalog.icons.length,
    motion: catalog.motion.length,
  }
  assert.deepEqual(counts, {
    colors: 63,
    spacing: 11,
    radii: 8,
    text: 12,
    effects: 6,
    icons: 6,
    motion: 9,
  })
  assert.equal(catalog.textStyles.length, 11)
  assert.equal(catalog.uiTextStyles.length, 1)
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 115)

  const ids = [
    ...catalog.colors,
    ...catalog.spacing,
    ...catalog.radii,
    ...catalog.textStyles,
    ...catalog.uiTextStyles,
    ...catalog.effects,
    ...catalog.icons,
    ...catalog.motion,
  ].map((token) => token.id)
  assert.equal(new Set(ids).size, ids.length, "catalog token ids must be unique")
})

check("a generic host gets no borrowed product tokens", () => {
  const generic = resolveConfig({}, { cwd: PACKAGE_DIR }).designSystem.catalog
  for (const group of [
    "colors",
    "spacing",
    "radii",
    "textStyles",
    "uiTextStyles",
    "effects",
    "icons",
    "motion",
  ]) {
    assert.deepEqual(generic[group], [], `${group} should be empty`)
  }
  assert.equal(generic.name, null)
  assert.deepEqual(generic.containerBreakpoints, [])
  assert.deepEqual(generic.responsiveMeasures, [])
  assert.deepEqual(generic.aliases, { cssVariables: [], tailwind: [] })
  assert.deepEqual(
    generic.breakpoints.map(({ name, prefix, values }) => [name, prefix, values.default]),
    [
      ["sm", "sm:", 640],
      ["md", "md:", 768],
      ["lg", "lg:", 1024],
      ["xl", "xl:", 1280],
      ["2xl", "2xl:", 1536],
    ]
  )
})

check("the browser prelude carries the catalog but no server filesystem paths", () => {
  assert.equal(prelude.includes(HOST_ROOT), false)
  assert.equal(prelude.includes(path.basename(workspace.designSystem.manifest)), false)
  assert.equal(prelude.includes("src/app/globals.css"), false)

  const browserConfig = browserSandbox.window.__DESIGNLAYER_CONFIG__
  assert.equal(browserConfig.designSystem.colors.length, 63)
  assert.equal(browserConfig.designSystem.breakpoints.length, 5)
  assert.equal("manifest" in browserConfig.designSystem, false)
  assert.equal("cssSources" in browserConfig.designSystem, false)
})

check("CSS and Tailwind aliases resolve to the canonical token", () => {
  const cssAlias = catalog.aliases.cssVariables.find(
    (alias) => alias.name === "--color-background"
  )
  assert.deepEqual(cssAlias, {
    name: "--color-background",
    tokenIds: ["color:background-primary"],
    ambiguous: false,
  })

  const tailwindAlias = catalog.aliases.tailwind.find(
    (alias) => alias.cssVar === "--color-background"
  )
  assert.deepEqual(tailwindAlias, {
    namespace: "color",
    name: "background",
    cssVar: "--color-background",
    tokenIds: ["color:background-primary"],
    ambiguous: false,
  })
})

globalThis.__DESIGNLAYER_CONFIG__ = browserSandbox.window.__DESIGNLAYER_CONFIG__
const helpers = await loadEditorHelpers()

console.log("\nAuthored and computed token matching")

check("authored CSS-variable identity wins over a computed-value collision", () => {
  const authored = helpers.authoredTokenMatches(
    "fill-color",
    "var(--color-background)",
    [],
    catalog
  )
  assert.equal(authored[0]?.token.id, "color:background-primary")
  assert.equal(authored[0]?.via, "authored")
  assert.match(authored[0]?.source ?? "", /--color-background/)

  const authoredClass = helpers.authoredTokenMatches(
    "fill-color",
    "",
    ["bg-background"],
    catalog
  )
  assert.equal(authoredClass[0]?.token.id, "color:background-primary")
  assert.equal(authoredClass[0]?.via, "authored")

  const computed = helpers.computedTokenMatches("fill-color", "#ffffff", catalog)
  assert.ok(computed.length > 1, "equal resolved colors must remain multiple candidates")
  assert.ok(computed.some((match) => match.token.id === "color:background-primary"))
  assert.ok(computed.some((match) => match.token.id === "color:background-elevated"))
})

check("CSS variable extraction keeps authored order and removes duplicates", () => {
  assert.deepEqual(
    helpers.extractCssVarNames(
      "linear-gradient(var(--sem-background-primary), var(--sem-border-primary), var(--sem-background-primary))"
    ),
    ["--sem-background-primary", "--sem-border-primary"]
  )
})

check("scoped aliases stay uncertain while exact evidence wins", () => {
  const one = helpers.authoredTokenMatches("fill-color", "", ["bg-sidebar"], catalog)
  assert.deepEqual(one.map((match) => [match.token.id, match.ambiguous]), [
    ["color:background-chrome", true],
  ])

  const inline = helpers.authoredTokenMatches(
    "fill-color",
    "var(--workspace-theme-chrome)",
    [],
    catalog
  )
  assert.deepEqual(inline.map((match) => [match.token.id, match.ambiguous]), [
    ["color:background-chrome", true],
  ])

  const many = helpers.authoredTokenMatches("fill-color", "", ["bg-sidebar-accent"], catalog)
  assert.deepEqual(many.map((match) => [match.token.id, match.ambiguous]), [
    ["color:background-canvas", true],
    ["color:background-primary-hover", true],
  ])

  const exact = helpers.authoredTokenMatches("fill-color", "", ["bg-background"], catalog)
  assert.deepEqual(exact.map((match) => [match.token.id, match.ambiguous]), [
    ["color:background-primary", false],
  ])

  const exactOverAlias = helpers.authoredTokenMatches(
    "fill-color",
    "var(--sem-background-primary)",
    ["bg-sidebar"],
    catalog
  )
  assert.deepEqual(exactOverAlias.map((match) => [match.token.id, match.ambiguous]), [
    ["color:background-primary", false],
  ])
})

check("a hand-typed value outranks the class the element still carries", () => {
  // Breaking out of the system, in the shape the picker's own-value field
  // produces it: the inline declaration lands, the utility class stays on the
  // element, and the cascade already decided which of the two is painting.
  const custom = helpers.authoredTokenMatches("fill-color", "#ff0066", ["bg-background"], catalog)
  assert.deepEqual(custom, [], "the overridden class was still read as the binding")
  assert.deepEqual(
    helpers.computedTokenMatches("fill-color", "#ff0066", catalog),
    [],
    "no token claims this colour either, so the field shows the value itself"
  )

  // And the two things this must not cost: a token picked from the list writes
  // its own variable inline and still reads back, and an element with no inline
  // declaration is still described by its class.
  assert.deepEqual(
    helpers
      .authoredTokenMatches("fill-color", "var(--sem-background-primary)", ["bg-background"], catalog)
      .map((match) => match.token.id),
    ["color:background-primary"]
  )
  assert.deepEqual(
    helpers.authoredTokenMatches("fill-color", "", ["bg-background"], catalog).map((match) => match.token.id),
    ["color:background-primary"]
  )
})

check("radius, text, spacing, effect, and icon tokens match their authored forms", () => {
  const cases = [
    ["corner-radius", "", ["rounded-[var(--radius-xl)]"], "radius:radius-xl"],
    ["text-style", "", ["text-body-sm"], "typography:body-small"],
    ["gap", "", ["gap-4"], "spacing:spacing-lg"],
    ["shadow", "", ["shadow-[var(--elev-2)]"], "shadow:elevation-2"],
    ["icon-size", "", ["size-4"], "icon-size:action"],
    ["corner-radius-bottom-left", "", ["rounded-bl-[var(--radius-xl)]"], "radius:radius-xl"],
    ["row-gap", "", ["gap-y-4"], "spacing:spacing-lg"],
    ["column-gap", "", ["gap-x-4"], "spacing:spacing-lg"],
    ["padding-top", "", ["pt-4"], "spacing:spacing-lg"],
    ["margin-left", "", ["ml-4"], "spacing:spacing-lg"],
    ["ring-color", "", ["ring-background"], "color:background-primary"],
    ["outline-color", "", ["outline-background"], "color:background-primary"],
    ["svg-fill", "", ["fill-background"], "color:background-primary"],
    ["svg-stroke", "", ["stroke-background"], "color:background-primary"],
  ]
  for (const [property, inlineValue, classNames, tokenId] of cases) {
    const matches = helpers.authoredTokenMatches(property, inlineValue, classNames, catalog)
    assert.equal(matches[0]?.token.id, tokenId, `${property} did not resolve ${classNames[0]}`)
  }

  // The honesty rule reaches matching too: a 0.3s transition is not `lively`,
  // because no CSS duration can be. Only the flat springs are ever offered.
  assert.deepEqual(
    helpers.computedTokenMatches("motion-duration", "0.15s", catalog).map((match) => match.token.id),
    ["motion:crossfade"]
  )
  assert.deepEqual(helpers.computedTokenMatches("motion-duration", "0.3s", catalog), [])
})

console.log("\nToken source-write shapes")

function find(group, name) {
  const token = catalog[group].find((entry) => entry.name === name)
  assert.ok(token, `${group}/${name} is missing`)
  return token
}

/** The class the write would land in source as, or a failure if it lands nowhere. */
function classShape({ property, value }) {
  const update = helpers.toClassUpdate(property, value)
  assert.ok(update, `${property}:${value} did not translate`)
  return update.tailwindToken
    ? `${update.tailwindPrefix}-${update.tailwindToken}`
    : `${update.tailwindPrefix}-[${update.value}]`
}

check("semantic tokens translate to durable Tailwind arbitrary-value shapes", () => {
  const writes = [
    ...helpers.tokenStyleWrites("fill-color", find("colors", "Background/Primary")),
    ...helpers.tokenStyleWrites("corner-radius", find("radii", "radius/xl")),
    ...helpers.tokenStyleWrites("text-style", find("textStyles", "Heading/H1")),
    ...helpers.tokenStyleWrites("gap", find("spacing", "spacing/lg")),
    ...helpers.tokenStyleWrites("shadow", find("effects", "Elevation/2")),
    ...helpers.tokenStyleWrites("icon-size", find("icons", "action")),
  ]
  assert.deepEqual(writes, [
    { property: "background-color", value: "var(--sem-background-primary)" },
    { property: "border-radius", value: "var(--radius-xl)" },
    { property: "font-size", value: "var(--type-h1-size)" },
    { property: "line-height", value: "var(--type-h1-leading)" },
    { property: "font-weight", value: "var(--type-h1-weight)" },
    { property: "letter-spacing", value: "var(--type-h1-tracking)" },
    { property: "gap", value: "16px" },
    { property: "box-shadow", value: "var(--elev-2)" },
    { property: "width", value: "16px" },
    { property: "height", value: "16px" },
  ])
  assert.deepEqual(writes.map(classShape), [
    "bg-[var(--sem-background-primary)]",
    "rounded-[var(--radius-xl)]",
    "text-[length:var(--type-h1-size)]",
    "leading-[var(--type-h1-leading)]",
    "font-[number:var(--type-h1-weight)]",
    "tracking-[var(--type-h1-tracking)]",
    "gap-4",
    "shadow-[var(--elev-2)]",
    "w-4",
    "h-4",
  ])

  const weight = helpers.toClassUpdate("font-weight", "650")
  assert.equal(weight?.tailwindPrefix, "font")
  assert.equal(weight?.tailwindToken, null)
  assert.equal(weight?.value, "650")
  assert.equal(`${weight.tailwindPrefix}-[${weight.value}]`, "font-[650]")
  assert.equal(new RegExp(weight.classPattern).test("font-[650]"), true)
  assert.equal(new RegExp(weight.classPattern).test("font-sans"), false)
})

check("the axes beyond the first nine write a real CSS property and a real class", () => {
  const cases = [
    ["ring-color", find("colors", "Background/Primary")],
    ["outline-color", find("colors", "Background/Primary")],
    ["svg-fill", find("colors", "Background/Primary")],
    ["svg-stroke", find("colors", "Background/Primary")],
    ["corner-radius-top-left", find("radii", "radius/xl")],
    ["corner-radius-top-right", find("radii", "radius/xl")],
    ["corner-radius-bottom-right", find("radii", "radius/xl")],
    ["corner-radius-bottom-left", find("radii", "radius/xl")],
    ["row-gap", find("spacing", "spacing/lg")],
    ["column-gap", find("spacing", "spacing/lg")],
    ["padding-top", find("spacing", "spacing/lg")],
    ["padding-right", find("spacing", "spacing/lg")],
    ["padding-bottom", find("spacing", "spacing/lg")],
    ["padding-left", find("spacing", "spacing/lg")],
    ["margin", find("spacing", "spacing/lg")],
    ["margin-top", find("spacing", "spacing/lg")],
    ["margin-right", find("spacing", "spacing/lg")],
    ["margin-bottom", find("spacing", "spacing/lg")],
    ["margin-left", find("spacing", "spacing/lg")],
    ["motion-duration", find("motion", "crossfade")],
  ]
  const rows = cases.flatMap(([property, token]) =>
    helpers
      .tokenStyleWrites(property, token)
      .map((write) => [property, write.property, classShape(write)])
  )
  assert.deepEqual(rows, [
    // A ring is a box-shadow in Tailwind v4, so its colour is the custom
    // property that shadow reads — not a border-color the element never has.
    ["ring-color", "--tw-ring-color", "ring-[var(--sem-background-primary)]"],
    ["outline-color", "outline-color", "outline-[var(--sem-background-primary)]"],
    ["svg-fill", "fill", "fill-[var(--sem-background-primary)]"],
    ["svg-stroke", "stroke", "stroke-[var(--sem-background-primary)]"],
    ["corner-radius-top-left", "border-top-left-radius", "rounded-tl-[var(--radius-xl)]"],
    ["corner-radius-top-right", "border-top-right-radius", "rounded-tr-[var(--radius-xl)]"],
    ["corner-radius-bottom-right", "border-bottom-right-radius", "rounded-br-[var(--radius-xl)]"],
    ["corner-radius-bottom-left", "border-bottom-left-radius", "rounded-bl-[var(--radius-xl)]"],
    ["row-gap", "row-gap", "gap-y-4"],
    ["column-gap", "column-gap", "gap-x-4"],
    ["padding-top", "padding-top", "pt-4"],
    ["padding-right", "padding-right", "pr-4"],
    ["padding-bottom", "padding-bottom", "pb-4"],
    ["padding-left", "padding-left", "pl-4"],
    ["margin", "margin", "m-4"],
    ["margin-top", "margin-top", "mt-4"],
    ["margin-right", "margin-right", "mr-4"],
    ["margin-bottom", "margin-bottom", "mb-4"],
    ["margin-left", "margin-left", "ml-4"],
    ["motion-duration", "transition-duration", "duration-[150ms]"],
  ])

  // `ring`, `outline` and `stroke` each carry a width as well as a colour, so a
  // recolour that matched on the stem alone would delete the width with it.
  const replaces = (property, className) =>
    new RegExp(helpers.toClassUpdate(property, "var(--sem-background-primary)").classPattern).test(className)
  assert.equal(replaces("--tw-ring-color", "ring-2"), false)
  assert.equal(replaces("outline-color", "outline-dashed"), false)
  assert.equal(replaces("stroke", "stroke-2"), false)
  assert.equal(replaces("fill", "fill-current"), true)
})

check("font family and weight patterns cannot replace each other", () => {
  const family = helpers.toClassUpdate("font-family", "Inter")
  const weight = helpers.toClassUpdate("font-weight", "650")
  assert.ok(family?.classPattern)
  assert.ok(weight?.classPattern)

  const familyPattern = new RegExp(family.classPattern)
  assert.equal(familyPattern.test("font-[650]"), false)
  assert.equal(familyPattern.test("font-[number:var(--type-h1-weight)]"), false)

  const weightPattern = new RegExp(weight.classPattern)
  assert.equal(weightPattern.test("font-sans"), false)
  assert.equal(weightPattern.test("font-[Inter]"), false)
  assert.equal(weightPattern.test("font-[family-name:var(--font-family)]"), false)
})

check("font size and text color variables cannot replace each other", () => {
  const size = helpers.toClassUpdate("font-size", "var(--type-h1-size)")
  const color = helpers.toClassUpdate("color", "var(--sem-text-icon-primary)")
  assert.equal(`${size.tailwindPrefix}-[${size.value}]`, "text-[length:var(--type-h1-size)]")

  const sizePattern = new RegExp(size.classPattern)
  const colorPattern = new RegExp(color.classPattern)
  assert.equal(sizePattern.test("text-[length:var(--type-h1-size)]"), true)
  assert.equal(sizePattern.test("text-[var(--sem-text-icon-primary)]"), false)
  assert.equal(colorPattern.test("text-[var(--sem-text-icon-primary)]"), true)
  assert.equal(colorPattern.test("text-[length:var(--type-h1-size)]"), false)
})

check("a bouncing spring writes nothing rather than a duration that lies", () => {
  const flat = catalog.motion.filter((token) => token.values.default.bounce === 0)
  assert.deepEqual(flat.map((token) => token.name), ["crossfade", "calm"])
  assert.deepEqual(
    flat.map((token) => helpers.tokenStyleWrites("motion-duration", token)),
    [
      [{ property: "transition-duration", value: "150ms" }],
      [{ property: "transition-duration", value: "240ms" }],
    ]
  )

  // The other seven are the point of the rule: transition-duration has no way
  // to carry bounce, so applying one would change the feel while the toast said
  // it worked. No writes is how this module says "not expressible here".
  const bouncing = catalog.motion.filter((token) => token.values.default.bounce !== 0)
  assert.equal(bouncing.length, 7)
  for (const token of bouncing) {
    assert.deepEqual(
      helpers.tokenStyleWrites("motion-duration", token),
      [],
      `${token.name} bounces and must not be written as a plain duration`
    )
  }
})

console.log("\nHuman spellings")

check("a token name splits into the group it lists under and the leaf a row shows", () => {
  const parts = (group, name) => helpers.tokenNameParts(find(group, name))
  assert.deepEqual(parts("colors", "Background/Primary"), { group: "Background", leaf: "Primary" })
  assert.deepEqual(parts("colors", "Text and Icon/Primary (weak)"), {
    group: "Text and Icon",
    leaf: "Primary (weak)",
  })
  // One register for the headers: the catalog writes some prefixes for people
  // and some for a stylesheet, and a `workspace` header three rows above
  // `Background` reads as two systems rather than one.
  assert.deepEqual(parts("radii", "radius/xl"), { group: "Radius", leaf: "xl" })
  assert.deepEqual(parts("spacing", "spacing/lg"), { group: "Spacing", leaf: "lg" })
  assert.deepEqual(parts("colors", "workspace/page"), { group: "Workspace", leaf: "page" })
  // A token with no path of its own still needs a header to sit under, or the
  // list opens with a run of ungrouped rows and the grouping reads like a bug.
  assert.deepEqual(parts("icons", "action"), { group: "Icon", leaf: "action" })
  assert.deepEqual(parts("motion", "crossfade"), { group: "Motion", leaf: "crossfade" })
  assert.deepEqual(parts("textStyles", "Display"), { group: "Text", leaf: "Display" })
  // Identifiers, not names: the motion collection is the one place the catalog
  // hands over source spellings, and the camel humps are the giveaway.
  assert.deepEqual(parts("motion", "fullScreen"), { group: "Motion", leaf: "full screen" })
  assert.deepEqual(parts("motion", "sinkInRecede"), { group: "Motion", leaf: "sink in recede" })
  // Case is otherwise left as authored: `2xl` is the design system's spelling.
  assert.equal(helpers.tokenDisplayName(find("radii", "radius/2xl")), "Radius/2xl")
  assert.equal(helpers.tokenDisplayName(find("motion", "navigationZoom")), "navigation zoom")
})

check("a token row carries the number that IS the decision", () => {
  const detail = (property, group, name) => helpers.tokenDetail(property, find(group, name))
  // Eight radii called sm…pill, previewed as eight chips, are eight rows of no
  // information without this: the px is the design fact being chosen.
  assert.equal(detail("corner-radius", "radii", "radius/sm"), "8px")
  assert.equal(detail("corner-radius", "radii", "radius/pill"), "999px")
  assert.equal(detail("gap", "spacing", "spacing/lg"), "16px")
  assert.equal(detail("icon-size", "icons", "action"), "16px")
  assert.equal(detail("text-style", "textStyles", "Heading/H1"), "36/40")
  // Including the springs that cannot be written: how long one takes is still
  // what a designer is choosing between.
  assert.equal(detail("motion-duration", "motion", "crossfade"), "150ms")
  assert.equal(detail("motion-duration", "motion", "lively"), "300ms")
  // The swatch already carries a colour whole; a hex on 64 rows is noise.
  assert.equal(detail("fill-color", "colors", "Background/Primary"), "")
  assert.equal(detail("shadow", "effects", "Elevation/1"), "")
})

check("a text style is spelled as its size and leading, and a swatch paints from the theme", () => {
  assert.equal(helpers.tokenTextPair(find("textStyles", "Heading/H1")), "36/40")
  assert.equal(helpers.tokenTextPair(find("textStyles", "Body/Default")), "16/26")
  assert.equal(helpers.tokenTextPair(find("radii", "radius/xl")), "")

  // The variable, not the literal: the swatch draws in the host document, so it
  // follows the live theme instead of freezing one theme's value.
  assert.equal(helpers.tokenSwatchCss(find("colors", "Background/Primary")), "var(--sem-background-primary)")
  assert.equal(helpers.tokenSwatchCss(find("spacing", "spacing/lg")), null)
})

check("a rendered value is spelled plainly or not at all", () => {
  assert.equal(helpers.plainValue("fill-color", "rgb(240, 242, 245)"), "#f0f2f5")
  assert.equal(helpers.plainValue("fill-color", "#FFF"), "#ffffff")

  // Alpha is not decoration. An element with no background computes to
  // `rgba(0, 0, 0, 0)`, and the Fill color row is unconditional — so dropping
  // the fourth channel put `#000000` beside an empty swatch on nearly every
  // selection, which is a design fact, and a false one. Same for every scrim
  // and hover wash, all of which used to read as their opaque base.
  assert.equal(helpers.plainValue("fill-color", "rgba(0, 0, 0, 0)"), "")
  assert.equal(helpers.plainValue("fill-color", "rgba(12, 16, 20, 0.5)"), "#0c1014 50%")
  assert.equal(helpers.plainValue("fill-color", "rgb(12 16 20 / 25%)"), "#0c1014 25%")
  assert.equal(helpers.plainValue("fill-color", "#0c101480"), "#0c1014 50%")
  assert.equal(helpers.plainValue("fill-color", "#0c1014ff"), "#0c1014")
  assert.equal(helpers.plainValue("text-style", "16|26|400|-0.32"), "16/26")
  assert.equal(helpers.plainValue("corner-radius", "20px"), "20px")
  assert.equal(helpers.plainValue("motion-duration", "0.15s"), "150ms")

  // The half that matters: a computed value can still be an unresolved variable
  // or a colour space no designer reads, and this surface prints neither.
  for (const value of [
    "var(--sem-background-primary)",
    "oklch(0.62 0.15 39)",
    "color-mix(in srgb, #fff 6%, #363c44)",
  ]) {
    assert.equal(helpers.plainValue("fill-color", value), "", `${value} reached the screen`)
  }
  assert.equal(helpers.plainValue("shadow", "0 1px 2px #0002"), "")
})

check("every design-system property has a category and a way into source", () => {
  assert.deepEqual(helpers.DESIGN_TOKEN_PROPERTIES, [
    "fill-color", "text-color", "stroke-color", "ring-color", "outline-color",
    "svg-fill", "svg-stroke",
    "corner-radius", "corner-radius-top-left", "corner-radius-top-right",
    "corner-radius-bottom-right", "corner-radius-bottom-left",
    "text-style", "shadow", "icon-size",
    "gap", "row-gap", "column-gap",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "motion-duration",
  ])
  for (const property of helpers.DESIGN_TOKEN_PROPERTIES) {
    const tokens = helpers.tokensForProperty(property, catalog)
    assert.ok(tokens.length, `${property} maps to no populated catalog category`)

    let writable = 0
    for (const token of tokens) {
      const writes = helpers.tokenStyleWrites(property, token)
      if (writes.length) writable += 1
      for (const write of writes) {
        assert.ok(
          helpers.toClassUpdate(write.property, write.value),
          `${property}/${token.name} writes ${write.property}, which stays preview-only`
        )
      }
    }
    assert.ok(writable, `${property} can write no token in its category`)
  }
})

console.log("\nInspector controls")

/**
 * Mounts the real inspector over a fixture and hands back the panel.
 *
 * The sections read `getComputedStyle`, `SVGElement` and `Node` off the global
 * scope the way they do in the browser, so the JSDOM's own have to be installed
 * there before the panel is built rather than passed in.
 */
async function withInspector(markup, run) {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
  })
  const { window } = dom
  for (const key of [
    "window", "document", "navigator", "Node", "Element", "HTMLElement",
    "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement", "SVGSVGElement",
    "Event", "CustomEvent", "KeyboardEvent", "PointerEvent", "requestAnimationFrame",
    "cancelAnimationFrame", "getComputedStyle",
  ]) {
    Object.defineProperty(globalThis, key, {
      value: key === "getComputedStyle" ? window.getComputedStyle.bind(window) : window[key],
      configurable: true,
      writable: true,
    })
  }

  const right = window.document.createElement("aside")
  right.setAttribute("data-designlayer", "")
  window.document.body.append(right)
  const slot = () => {
    const node = window.document.createElement("div")
    node.setAttribute("data-designlayer", "")
    window.document.body.append(node)
    return node
  }
  const pending = []
  const bridge = {
    elementInfo: () => ({
      tagName: "div", componentName: "Fixture", filePath: "/tmp/fixture.tsx",
      lineNumber: 1, columnNumber: 0, stack: [],
    }),
    send() {}, subscribe: () => () => {}, toast() {},
    store: {
      addPendingPropertyOperation: (...args) => pending.push(args),
      getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
      setCanvasTransform() {}, onCanvasTransformChange: () => () => {},
      onStateChange: () => () => {}, hasChanges: () => false,    },
  }
  const editor = helpers.createContext(bridge, {
    overlay: slot(), toolbar: slot(), left: slot(), right,
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  const paint = () => new Promise((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
  )
  try {
    helpers.installInspector(editor)
    const target = window.document.getElementById("target")
    editor.select(target)
    await paint()
    // The precision expander is panel-level memory that outlives a fixture, so
    // each case starts collapsed rather than wherever its predecessor left it.
    const open = right.querySelector('[aria-label="Hide per-side tokens"]')
    if (open) {
      open.click()
      await paint()
    }
    await run({ window, right, target, pending, paint })
  } finally {
    globalThis.fetch = originalFetch
    dom.window.close()
  }
}

const rowLabels = (right) =>
  [...right.querySelectorAll('[data-de-field^="design-system."]')].map((node) =>
    node.getAttribute("aria-label")
  )

function expectRows(right, { present = [], absent = [] }) {
  const labels = rowLabels(right)
  for (const label of present) assert.ok(labels.includes(label), `${label} is missing`)
  for (const label of absent) assert.equal(labels.includes(label), false, `${label} should not be here`)
}

/** Opens a row's picker and returns the popover the click mounted. */
function open({ window, right }, property) {
  const field = right.querySelector(`[data-de-field="design-system.${property}"]`)
  assert.ok(field, `${property} has no row to pick in`)
  field.click()
  const popover = window.document.querySelector(".de-token-popover")
  assert.ok(popover, `${property} opened no picker`)
  return { field, popover }
}

/** Picks a token in a row the way a pointer does, and lets the panel rebuild. */
async function pick(harness, property, tokenId) {
  const { field, popover } = open(harness, property)
  const row = popover.querySelector(`[data-de-choice="${tokenId}"]`)
  assert.ok(row, `${tokenId} is not offered on the ${property} row`)
  row.click()
  await harness.paint()
  return field
}

/** What the closed field reads — a token name, or the element's own value. */
const fieldText = (right, property) =>
  right.querySelector(`[data-de-field="design-system.${property}"]`)?.textContent ?? ""

const GRID_FIXTURE = `<div id="target" class="grid grid-cols-1 border bg-background gap-4 p-4 md:grid-cols-2 dark:md:hover:gap-6 xl:grid-cols-4" style="display:grid;gap:16px;padding:16px;background-color:var(--color-background);border:1px solid var(--sem-border-primary);border-radius:var(--radius-xl);box-shadow:var(--elev-2)">Hello<span></span></div>`

await checkAsync("token controls are named and keep focus across their write", async () => {
  await withInspector(GRID_FIXTURE, async (harness) => {
    const { window, right, target, pending } = harness
    for (const label of [
      "Fill color token", "Text color token", "Text style token", "Stroke color token",
      "Corner radius token", "Shadow / effect token", "Container gap token",
      "Uniform padding token",
    ]) {
      assert.ok(right.querySelector(`[aria-label="${label}"]`), `${label} is missing`)
    }
    // Picking a token is one gesture, so it must not cost the row you were on:
    // every commit rebuilds the whole panel, and a field that loses focus makes
    // walking a column of token rows by keyboard impossible.
    const before = right.querySelector('[data-de-field="design-system.corner-radius"]')
    await pick(harness, "corner-radius", "radius:radius-sm")

    const after = right.querySelector('[data-de-field="design-system.corner-radius"]')
    assert.notEqual(after, before, "the inspector did not rebuild")
    assert.equal(window.document.activeElement, after)
    assert.equal(after.textContent, "Radius/sm", "the row does not read back as bound")
    assert.match(target.style.borderRadius, /var\(--radius-sm\)/)
    assert.ok(pending.length > 0, "token pick did not queue a source operation")
  })
})

// Every axis this box can actually carry, and nothing it cannot: a ring, an
// outline and a transition are all present, an SVG paint and an icon are not.
const PAINTED_FIXTURE = `<div id="target" class="flex border p-4" style="display:flex;gap:16px;padding:16px;margin:8px;border:1px solid #000;border-top-left-radius:8px;border-top-right-radius:8px;border-bottom-right-radius:8px;border-bottom-left-radius:8px;box-shadow:0 1px 2px #0002;outline-width:2px;outline-style:solid;transition-duration:0.15s;--tw-ring-shadow:0 0 0 2px #00f">Hello<span></span></div>`

const COMMON_LABELS = [
  "Fill color token", "Text color token", "Text style token", "Stroke color token",
  "Ring color token", "Outline color token", "Corner radius token", "Shadow / effect token",
  "Container gap token", "Uniform padding token", "Motion duration token",
]
const PRECISION_LABELS = [
  "Radius top left token", "Radius top right token", "Radius bottom right token",
  "Radius bottom left token", "Row gap token", "Column gap token",
  "Padding top token", "Padding right token", "Padding bottom token", "Padding left token",
  "Uniform margin token", "Margin top token", "Margin right token", "Margin bottom token",
  "Margin left token",
]

await checkAsync("precision axes stay folded until asked for, then write like any other row", async () => {
  await withInspector(PAINTED_FIXTURE, async (harness) => {
    const { right, target, pending } = harness
    expectRows(right, {
      present: COMMON_LABELS,
      // Twenty always-visible selects is a worse inspector than nine, so the
      // per-side half is absent from the DOM rather than merely styled away.
      absent: [...PRECISION_LABELS, "SVG fill token", "SVG stroke token", "Icon size token"],
    })

    right.querySelector('[aria-label="Show per-side tokens"]').click()
    await harness.paint()
    expectRows(right, { present: [...COMMON_LABELS, ...PRECISION_LABELS] })

    const queued = pending.length
    await pick(harness, "margin-top", "spacing:spacing-lg")
    assert.equal(target.style.marginTop, "16px", "the precision row did not paint the preview")
    assert.ok(pending.length > queued, "the precision row did not queue a source operation")

    await pick(harness, "ring-color", "color:background-primary")
    assert.equal(
      target.style.getPropertyValue("--tw-ring-color"),
      "var(--sem-background-primary)",
      "a Tailwind v4 ring recolours through its custom property"
    )
    assert.ok(pending.length > queued + 1, "the ring row did not queue a source operation")
  })
})

await checkAsync("an icon host reaches its own SVG's paint", async () => {
  await withInspector(
    `<button id="target" class="p-2" style="padding:8px"><svg style="fill:#ff0000;stroke:#0000ff"></svg></button>`,
    async ({ right }) => {
      expectRows(right, {
        present: ["SVG fill token", "SVG stroke token", "Icon size token"],
        // No text node of its own, so the two type rows would edit nothing.
        absent: ["Text color token", "Text style token"],
      })
    }
  )
})

await checkAsync("Tailwind's registered ring initial is not mistaken for a ring", async () => {
  // v4 registers --tw-ring-shadow with an initial value, so it resolves on
  // EVERY element: 1958 of 1958 on /ds when this was measured in the browser.
  // A row keyed on "the property is non-empty" is therefore a row on the whole
  // document — inert, and the disclosure logic doing nothing at all.
  await withInspector(
    `<div id="target" class="p-4" style="padding:16px;--tw-ring-shadow:0 0 #0000">Hello<span></span></div>`,
    async ({ right }) => {
      expectRows(right, { present: ["Uniform padding token"], absent: ["Ring color token"] })
    }
  )
  // ...and the row is still there when the element really carries one.
  await withInspector(PAINTED_FIXTURE, async ({ right }) => {
    expectRows(right, { present: ["Ring color token"] })
  })
})

await checkAsync("a spring that cannot arrive intact says so before the click", async () => {
  await withInspector(PAINTED_FIXTURE, async (harness) => {
    const { right } = harness
    const { popover } = open(harness, "motion-duration")
    const disabled = (id) =>
      popover.querySelector(`[data-de-choice="${id}"]`)?.getAttribute("aria-disabled") ?? "false"
    assert.equal(disabled("motion:crossfade"), "false")
    assert.equal(disabled("motion:lively"), "true", "a bouncing spring reads as pickable")

    // The toast fires after the click, which is one spring too late: the row
    // itself has to name the seven that cannot land and why.
    const field = right.querySelector('[data-de-field="design-system.motion-duration"]')
    const hints = [...field.parentElement.querySelectorAll(".de-hint")].map((node) => node.textContent)
    assert.equal(hints.length, 1, "the motion row lost its unavailable-token hint")
    assert.match(hints[0], /bounce/)
    assert.match(hints[0], /lively/)
  })
})

await checkAsync("a scoped alias reads as the element's own value, not as a binding", async () => {
  const markups = [
    `<div id="target" class="bg-sidebar"></div>`,
    `<div id="target" style="background-color:var(--workspace-theme-chrome)"></div>`,
    `<div id="target" class="bg-sidebar-accent"></div>`,
  ]
  for (const markup of markups) {
    await withInspector(markup, async ({ right }) => {
      // An alias whose meaning moves with the theme is not a binding. The field
      // says so by not claiming a token — but silence alone would make a
      // theme-driven alias and a hand-typed colour look identical, so the
      // candidates stay, said as a design fact instead of an evidence trail.
      const text = fieldText(right, "fill-color")
      assert.ok(!text.includes("Background/"), `an ambiguous alias was named as bound: ${text}`)
      assert.ok(!text.includes("var("), "the field printed a custom property")

      const field = right.querySelector('[data-de-field="design-system.fill-color"]')
      const hint = [...field.parentElement.querySelectorAll(".de-hint")].find((node) =>
        node.textContent.startsWith("Could be ")
      )
      assert.ok(hint, `the uncertainty went silent for ${markup}`)
      assert.match(hint.textContent, /the theme decides$/)
      assert.match(hint.textContent, /Background\//)
    })
  }

  await withInspector(`<div id="target" class="bg-background"></div>`, async ({ right }) => {
    assert.equal(fieldText(right, "fill-color"), "Background/Primary")
    // A certain binding has nothing to be uncertain about.
    const field = right.querySelector('[data-de-field="design-system.fill-color"]')
    assert.equal(
      [...field.parentElement.querySelectorAll(".de-hint")].filter((node) =>
        node.textContent.startsWith("Could be ")
      ).length,
      0
    )
  })
})

await checkAsync("a value typed in the picker is the value the field reads back", async () => {
  // Breaking out of the system, end to end and through the real gesture: the
  // element keeps the class that used to bind it, so both halves of the bug are
  // in the fixture at once.
  await withInspector(`<div id="target" class="bg-background"></div>`, async (harness) => {
    const { window, right, target, paint } = harness
    assert.equal(fieldText(right, "fill-color"), "Background/Primary")

    const { popover } = open(harness, "fill-color")
    const input = popover.querySelector(".de-token-custom-input")
    assert.ok(input, "the fill row offers no way out of the system")
    input.value = "#ff0066"

    // The other half, and the one no class explains: a colour axis is almost
    // always transitioned, so the render that follows the write still computes
    // the colour the element is LEAVING. Frozen here rather than animated,
    // because a frozen readback is the same lie a transition tells for 150ms
    // and it is the lie the field used to believe — measured in the browser as
    // `rgb(37, 41, 46)` on a button whose inline style already said `#ff0066`.
    const STALE = "rgb(255, 255, 255)"
    const real = globalThis.getComputedStyle
    globalThis.getComputedStyle = (element, pseudo) => {
      const style = real(element, pseudo)
      if (element !== target) return style
      return new Proxy(style, {
        get(base, key) {
          if (key === "backgroundColor") return STALE
          if (key === "getPropertyValue") {
            return (name) => (name === "background-color" ? STALE : base.getPropertyValue(name))
          }
          const value = base[key]
          return typeof value === "function" ? value.bind(base) : value
        },
      })
    }
    try {
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      await paint()

      assert.equal(target.style.backgroundColor, "rgb(255, 0, 102)", "the value never painted")
      assert.equal(
        fieldText(right, "fill-color"),
        "#ff0066",
        "the field read back a token the element no longer obeys"
      )
    } finally {
      globalThis.getComputedStyle = real
    }
  })
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
