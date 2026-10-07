/**
 * Chrome tokens for the editor UI.
 *
 * SOURCE: the design foundations kit (`css/palette.css`, `css/tokens.css`,
 * `tokens/tokens.ts`). The editor adopts its treatment — the cool neutral
 * family, the near-white ladder, the chrome-wash ladder, the indigo focus and
 * selection hue, the radius ladder and squircle corners, the elevation recipes
 * and the motion vocabulary — while keeping its own DENSITY: 12px UI text and
 * 24px rows, because it is a Figma-style editor packed into two 240px columns,
 * not a product page. Every value below names the kit role it came from.
 *
 * Values are vendored as literals rather than read from a stylesheet. The
 * package contract is that nothing here imports the host app and nothing in
 * the app imports this, so the coupling is the comment naming each source role.
 *
 * ---------------------------------------------------------------------------
 * TWO THEMES, AND WHY THE COLOURS ARE THE ONLY THING THAT MOVES
 *
 * Everything in `color`, `code` and `shadow` below is a REFERENCE —
 * `var(--de-color-bg)` rather than a literal. The values live in `PALETTE`, two
 * per role, and `css/base.ts` emits them as two blocks of custom properties
 * switched by `data-de-theme`. The css modules interpolate these tokens once,
 * at build time, so a reference is the only shape that lets one stylesheet
 * resolve differently per theme.
 *
 * `icon`, `size`, `type`, `radius`, `space`, `duration` and `ease` stay
 * literal: several are read by JavaScript as numbers, and none varies by theme.
 */

// ─────────────────────────────────────────────────── the dark theme ────────

/**
 * The dark ground: the kit's dark `--card` / `--popover`
 * (`--sem-background-elevated` -> `--base-neutral-205`, oklch(0.205 0 0)).
 *
 * The editor floats in front of someone else's product, so every panel is a
 * card-family surface — elevated, not the page (`oklch(0.145)`) and not the
 * graphite `--chrome` rail (`#363c44`), which is theme-invariant and would
 * leave the light theme with a dark frame.
 */
const CHROME = "#171717"
/**
 * The substance every dark step is cut from: paper. The kit builds its dark
 * hairlines (`--base-paper-a08/a10/a15`) and its chrome washes
 * (`--chrome-hover` 10%, `--chrome-selected` 12%, `--chrome-shelf` 6%,
 * `--chrome-border` 32%, `--chrome-muted-foreground` 75%) the same way.
 */
const ON_CHROME = "#ffffff"
/** Dark text: `--sem-text-icon-primary` -> `--base-neutral-985`. */
const TEXT_DARK = "#fafafa"
/**
 * The accent as INK in dark — the kit's dark indigo lifted one rung
 * (`--base-indigo-6817`, the dark `--hue-indigo`). The kit's own dark `--ring`
 * (`--base-indigo-6219`) is tuned for its near-black page and "lifted in dark
 * to clear 5:1"; on this lighter card ground it measures 4.7:1 and falls under
 * 3:1 on a hovered row, so it takes the next rung up the same hue: 6.0:1 on
 * the ground and past 3:1 on every wash a stroke is drawn over.
 */
const RING_DARK = "#798cff"
/**
 * The accent as a FILL in dark: `--hue-indigo` (`--base-indigo-1000`).
 * White on it is 4.97:1, so one rung carries both a glyph and a word.
 */
const INDIGO_FILL_DARK = "#4a5df9"
/** The accent as a WORD in dark: `--base-indigo-7414`, 7.6:1 on the ground. */
const INDIGO_TEXT_DARK = "#90a3ff"

/** A chrome wash: the kit's dark hover/selected/shelf recipe over the ground. */
const lift = (percent: number) => `color-mix(in srgb, ${ON_CHROME} ${percent}%, ${CHROME})`
/** A paper hairline, so it survives on any ground (`--base-paper-a*`). */
const rule = (percent: number) => `color-mix(in srgb, ${ON_CHROME} ${percent}%, transparent)`

// ────────────────────────────────────────────────── the light theme ────────

/** `--sem-background-primary` / `--sem-background-elevated` -> `--base-gray-white`. */
const PAPER = "#ffffff"
/**
 * `--sem-text-icon-primary` -> `--base-gray-1600`. Near-black with the kit's
 * faint cool cast (hue ≈ 254), never pure black.
 */
const INK = "#0c1014"
/**
 * The kit's near-white ladder. Four rungs within 8/255 of each other, each a
 * different decision (ADOPTION-GUIDE § 1); never collapse two together.
 */
const SECONDARY = "#f0f2f5" /* --secondary: control surface, selected pill */
const SECONDARY_HOVER = "#dce0e5" /* --secondary-hover: its hover, selected segment */
const MUTED = "#f8f9f9" /* --muted: ghost hover, chips */
const BORDER = "#e9edf0" /* --border / --input: structural dividers, field fill */
/** `--muted-foreground` -> `--base-slate-5100`. 5.8:1 on paper. */
const SLATE = "#5f6670"
/**
 * The accent in light — the kit's `--ring` (`--base-indigo-4922`). 6.7:1 on
 * paper and 6.7:1 under white, so it is ink, fill and word at once.
 */
const INDIGO = "#3849da"
/** `--unseen` (`--base-indigo-9602`): the kit's pale indigo, a tint carried by hue. */
const INDIGO_TINT = "#ebf1ff"

/** An ink hairline (`--base-ink-a*`), so it survives on any ground. */
const wash = (percent: number) => `color-mix(in srgb, ${INK} ${percent}%, transparent)`

/**
 * Every value that depends on which theme is up, as ROLE -> the two it takes.
 *
 * One table rather than two, because the failure this shape prevents is a
 * role defined in one theme and missing from the other — which does not crash,
 * it ships a white label on a white ground. `test/token-cases.mjs` checks the
 * emitted CSS for it anyway.
 */
const PALETTE = {
  color: {
    /** The panel ground: the kit's `--card` / `--popover` in each theme. */
    bg: { dark: CHROME, light: PAPER },
    /**
     * A surface in front of the control layer — a popover, a chosen chip.
     * Dark: `--chrome-selected` (12%). Light: white, told apart by its shadow,
     * which is how the kit separates every floating card.
     */
    bgRaised: { dark: lift(12), light: PAPER },
    /**
     * THE CONTROL SURFACE — every field, track and pad. The name predates the
     * direction: in dark it is a step UP (`--chrome-shelf`, 6%), in light the
     * kit's `--secondary` rung, a step down. The role is "the surface a control
     * is drawn on", which did not change.
     */
    bgSunken: { dark: lift(6), light: SECONDARY },
    /** Ghost hover. Dark `--chrome-selected`; light `--secondary`. */
    bgHover: { dark: lift(12), light: SECONDARY },
    /** The quiet hover — a row under the cursor. Dark `--chrome-hover`; light `--muted`. */
    bgHoverQuiet: { dark: lift(10), light: MUTED },
    bgActive: { dark: RING_DARK, light: INDIGO },
    /** Structural dividers. Dark `--border` (paper 10%); light `--border`. */
    border: { dark: rule(10), light: BORDER },
    /**
     * The panel's outer edge, over a page of unknown colour. Dark `--input`
     * (paper 15%); light `--hairline-strong` (ink 26%) — the card hairline at
     * interactive strength, since the edge has to hold against any product.
     */
    borderStrong: { dark: rule(15), light: wash(26) },
    /**
     * Boundary of a control you can act on, per WCAG 1.4.11. The kit's fields
     * carry no resting border, so this is the one role it has no rung for; it
     * is set where 3:1 lands on the darkest ground a control is drawn on.
     */
    borderInteractive: { dark: rule(35), light: wash(48) },
    text: { dark: TEXT_DARK, light: INK },
    /** Secondary ink. Dark `--chrome-muted-foreground` (75%); light ink at 80%. */
    textMuted: { dark: "rgba(255,255,255,0.75)", light: wash(80) },
    /**
     * The quietest readable ink, tuned to the WORST ground each theme draws it
     * on (a placeholder in a hovered field). Light is the kit's
     * `--muted-foreground`; dark stays a chrome wash so it keeps its step
     * above `textDisabled`.
     */
    textDim: { dark: "rgba(255,255,255,0.70)", light: SLATE },
    /**
     * The ink of a control that cannot be pressed — quieter than `textDim`,
     * and still at 4.5:1 on the worst ground, because a greyed-out control in
     * an editor is information about what the tool wants next. WCAG exempts
     * inactive controls; this chrome does not take the exemption.
     */
    textDisabled: { dark: "rgba(255,255,255,0.62)", light: wash(64) },
    /** Strokes, handles, focus rings: the kit's `--ring`. */
    accent: { dark: RING_DARK, light: INDIGO },
    /** Accent as a FILL under a mark. White on it: 4.97 dark, 6.7 light. */
    accentSurface: { dark: INDIGO_FILL_DARK, light: INDIGO },
    /** The same fill under a WORD. Both rungs already clear 4.5:1. */
    accentSurfaceText: { dark: INDIGO_FILL_DARK, light: INDIGO },
    /** The accent as a word on a panel. */
    accentText: { dark: INDIGO_TEXT_DARK, light: INDIGO },
    /** The fills' hover: the same hue with 14% ink in it. */
    accentSurfaceHover: {
      dark: `color-mix(in srgb, ${INK} 14%, ${INDIGO_FILL_DARK})`,
      light: `color-mix(in srgb, ${INK} 14%, ${INDIGO})`,
    },
    accentSurfaceTextHover: {
      dark: `color-mix(in srgb, ${INK} 14%, ${INDIGO_FILL_DARK})`,
      light: `color-mix(in srgb, ${INK} 14%, ${INDIGO})`,
    },
    /** A raised surface's hover. Dark 16%; light `--muted`. */
    bgRaisedHover: { dark: lift(16), light: MUTED },
    /**
     * The selected segment of a segmented control, and nothing else.
     *
     * A FILL darker than its track in light (`--segmented-selected` =
     * `--secondary-hover` on the `--secondary` track), with no shadow and no
     * hairline: a shadow claims elevation, and the selected segment is not
     * nearer the light than the trough it sits in (MICRO-INTERACTIONS § 9).
     * Dark: the kit's `--secondary-hover` dark rung, `--base-gray-1200`.
     */
    segmentSelected: { dark: "#363c44", light: SECONDARY_HOVER },
    /**
     * The kit's `--secondary-hover`: a secondary (filled) button's hover, and
     * an inset-ghost control's hover on an already-filled surface. The same
     * values as `segmentSelected` and a different decision, which is why the
     * kit — and this table — names both.
     */
    secondaryHover: { dark: "#363c44", light: SECONDARY_HOVER },
    /** The kit's `--tab-pill-selected` (= `--secondary`): the chosen tab's pill. */
    tabSelected: { dark: "#25292e", light: SECONDARY },
    /**
     * The kit's `--hairline`: the one outline every card-family surface shares
     * (ink 7% / paper 8%). Structural dividers stay on `border`.
     */
    hairline: { dark: rule(8), light: wash(7) },
    /**
     * The keyboard focus halo: the ring colour at 30%, three pixels wide, drawn
     * outside a control whose edge has taken `accent` (MICRO-INTERACTIONS § 3).
     * Not `focusHalo`, which is the white half of the canvas ring over product
     * pixels.
     */
    accentHalo: {
      dark: `color-mix(in srgb, ${RING_DARK} 30%, transparent)`,
      light: `color-mix(in srgb, ${INDIGO} 30%, transparent)`,
    },
    /** The kit's `--scrollbar-thumb` / `-hover`: ink 26/45% in light, paper 28/50% in dark. */
    scrollbarThumb: { dark: rule(28), light: wash(26) },
    scrollbarThumbHover: { dark: rule(50), light: wash(45) },
    /**
     * The kit's `--overlay-scrim`: a static 70% near-black veil behind a modal,
     * the same in both appearances and never blurred. Drawn over the app, so it
     * does not follow the editor's theme.
     */
    scrim: { dark: "rgba(12,16,20,0.7)", light: "rgba(12,16,20,0.7)" },
    /** White on a filled accent, in both themes. */
    onAccent: { dark: ON_CHROME, light: ON_CHROME },
    /**
     * Ink on a filled SEMANTIC hue — the kit's `--on-hue`: white in light,
     * near-black in dark, because the dark hues are lifted into bright plates.
     */
    onSemantic: { dark: INK, light: ON_CHROME },
    /**
     * The two halves of the canvas focus ring drawn over product pixels: a
     * near-black core inside a white halo, so one of the two always contrasts
     * with whatever the page is. Fixed in both themes; the ring is over the app.
     */
    focusHalo: { dark: ON_CHROME, light: ON_CHROME },
    focusCore: { dark: INK, light: INK },
    /**
     * The selected container — a chosen icon's plate, a selected row. Hue,
     * never another grey: the neutral ladder can only say "recessed", it cannot
     * say "this one". Light is the kit's `--unseen` indigo tint; dark is the
     * indigo fill at 28% over the ground, since the kit's dark `--unseen`
     * (`#24272e`) is too close to the chrome washes to read as chosen.
     */
    accentSoft: {
      dark: `color-mix(in srgb, ${INDIGO_FILL_DARK} 28%, ${CHROME})`,
      light: INDIGO_TINT,
    },
    /** The canvas overlay's wash: the accent at a share. */
    selectionSurface: {
      dark: `color-mix(in srgb, ${RING_DARK} 18%, transparent)`,
      light: `color-mix(in srgb, ${INDIGO} 12%, transparent)`,
    },
    /**
     * A field's resting well. The kit's fields are filled with no resting
     * border (`.ui-field`): dark the shelf wash, light `--secondary`.
     */
    field: { dark: lift(6), light: SECONDARY },
    /** Its hover. Dark `--chrome-hover`; light `--border`, the next rung down. */
    fieldHover: { dark: lift(10), light: BORDER },
    /** A selected layer row: the same indigo container as `accentSoft`. */
    rowSelected: {
      dark: `color-mix(in srgb, ${INDIGO_FILL_DARK} 28%, ${CHROME})`,
      light: INDIGO_TINT,
    },
    /** Still selected, focus elsewhere: half the tint. */
    rowSelectedMuted: {
      dark: `color-mix(in srgb, ${INDIGO_FILL_DARK} 16%, ${CHROME})`,
      light: `color-mix(in srgb, ${INDIGO_TINT} 55%, ${PAPER})`,
    },
    /**
     * Status as TEXT (≥ 4.5:1), and as a fill under `onSemantic`. Light takes
     * the kit's `--*-text` rungs; dark takes its lifted decorative hues, which
     * the kit uses as dark status text too.
     */
    /** `--positive-text`: `--base-green-4712` / `--base-green-7212`. */
    success: { dark: "#72b875", light: "#0e6c34" },
    /** Component names: `--hue-violet`, taken one step darker in light for words. */
    component: { dark: "#c09aeb", light: "#6e4c96" },
    /** `--destructive`: `--base-crimson-5825` darkened for words / `--base-crimson-7019`. */
    danger: { dark: "#ff6467", light: "#c8000a" },
    /**
     * A destructive ghost's hover: the danger hue at 10% under danger ink
     * (MICRO-INTERACTIONS § 2). A wash rather than a solid block, so an icon
     * about to delete something warns without shouting.
     */
    dangerWash: {
      dark: "color-mix(in srgb, #ff6467 14%, transparent)",
      light: "color-mix(in srgb, #c8000a 10%, transparent)",
    },
    /**
     * A design-system violation, and deliberately NOT `danger`: `--warning-text`
     * (`--base-amber-5213` / `--base-amber-7813`). Shape carries the rest of
     * the distinction, because hue alone is not a difference every reader sees.
     */
    lintWarning: { dark: "#e1af4a", light: "#8d5f00" },
    /** Canvas guides and measurements: `--record` (`--base-vermilion-*`). */
    guide: { dark: "#f14445", light: "#d73337" },
    measure: { dark: "#f14445", light: "#d73337" },
  },
  /**
   * Syntax tints for the Code tab, and only there, tuned against `bgSunken`.
   * Drawn from the kit's decorative hues so the code view belongs to the
   * same family: blue, violet, green and coral.
   */
  code: {
    tag: { dark: "#60c2ff", light: "#005aa8" },
    attribute: { dark: "#c09aeb", light: "#6e4c96" },
    string: { dark: "#72b875", light: "#0e6c34" },
    number: { dark: "#f6835d", light: "#b74a00" },
    punctuation: { dark: "rgba(255,255,255,0.58)", light: wash(66) },
  },
  /**
   * The TINT of the kit's elevation, and only the tint; geometry stays literal
   * in `shadow` below. Light reads elevation from a cast shadow and a 7% ink
   * hairline (`--hairline`); dark from a heavier pure-black ambient plus a top
   * rim highlight (`--rim-light`, paper 10%), where the hairline is paper 8%.
   */
  shadow: {
    cast: { dark: "rgba(0,0,0,0.36)", light: "rgba(0,0,0,0.12)" },
    ring: { dark: rule(8), light: wash(7) },
    castSoft: { dark: "rgba(0,0,0,0.42)", light: "rgba(0,0,0,0.13)" },
    rim: { dark: rule(10), light: "rgba(255,255,255,0)" },
    /** The kit's `--elev-tooltip` tint: an inverse chip needs a firmer cast. */
    castTooltip: { dark: "rgba(0,0,0,0.36)", light: "rgba(0,0,0,0.16)" },
  },
} as const satisfies Record<string, Record<string, { dark: string; light: string }>>

export type ThemeName = "dark" | "light"

/** Both of them, in the order `css/base.ts` emits them and tests iterate them. */
export const THEMES = ["dark", "light"] as const satisfies readonly ThemeName[]

/**
 * The custom property a role is carried by: `bgRaised` -> `--de-color-bg-raised`.
 *
 * Derived rather than written out beside each role, so the reference and the
 * declaration cannot drift into naming two different properties — which is the
 * one typo in this file that produces no error anywhere, just an unresolved
 * `var()` and a transparent surface.
 */
const customProperty = (group: string, role: string) =>
  `--de-${group}-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`

/**
 * The whole group as references — each one carrying the dark value as a
 * FALLBACK, which is not belt and braces.
 *
 * A bare `var(--de-color-bg)` resolves to nothing on any page that does not
 * carry the palette, and "invalid at computed-value time" is not a missing
 * background, it is an inherited or initial one: transparent surfaces, black
 * text, an unreadable screen. One such page exists in this package and it is
 * not hypothetical — `runtime/start-screen-style.mjs` imports this module
 * directly and aliases every role into its own `:root` block for the chooser,
 * which is a separate document with no editor root and no `css/base.ts` in it.
 * Without the fallback that screen loses its entire palette the moment these
 * tokens stop being literals.
 *
 * Dark is the right fallback for the same reason it is the default theme: it is
 * what the editor has always looked like, and the chooser is hard-coded to it.
 * This does not become a second source of truth — the fallback is generated
 * from the same `PALETTE` row as the declaration it stands in for, so there is
 * still exactly one place to edit a colour.
 */
function references<T extends Record<string, { dark: string }>>(
  group: string,
  roles: T
): { [K in keyof T]: string } {
  const out = {} as { [K in keyof T]: string }
  for (const role of Object.keys(roles) as Array<keyof T & string>) {
    out[role] = `var(${customProperty(group, role)}, ${roles[role].dark})`
  }
  return out
}

/**
 * One theme's declarations, for `css/base.ts` to wrap in a selector.
 *
 * The values live here, beside the role they name and its reasoning, and the
 * SELECTOR lives in the stylesheet that owns the document — which is the same
 * split every other token in this file already has. A designer changing the
 * palette opens this file and only this file.
 */
export function themeDeclarations(theme: ThemeName, indent = "  "): string {
  return Object.entries(PALETTE)
    .flatMap(([group, roles]) =>
      Object.entries(roles).map(
        ([role, value]) => `${indent}${customProperty(group, role)}: ${value[theme]};`
      )
    )
    .join("\n")
}

/**
 * `@property` registrations for every palette role, so the theme can CROSSFADE.
 *
 * A plain custom property is an untyped token as far as the cascade is
 * concerned: the browser has no idea `--de-color-bg` holds a colour, so it
 * cannot interpolate one value into another and a `transition` naming it is a
 * no-op. That is why flipping the theme repainted the entire chrome between two
 * frames — not an oversight in the stylesheet, but a thing the stylesheet could
 * not express.
 *
 * Registering each role with `syntax: "<color>"` is what makes them animatable.
 * Nothing else changes: the values, the fallbacks and the two-selector split in
 * `css/base.ts` are all exactly as they were, and `css/base.ts` is still the
 * only place that decides WHICH theme is up.
 *
 * `inherits: true` because that is what these already do and what every
 * `var()` call site depends on — a popover mounted on `<body>` resolves the
 * palette by inheriting it from `:root`.
 *
 * The initial value is the DARK one, matching the `references()` fallback above
 * and for the same reason: dark is what the editor is when nothing has said
 * otherwise. Generated from the same `PALETTE` row rather than restated, so a
 * registration cannot drift from the declaration it types.
 *
 * Shadows and code tints are registered too — they are colours, they are in
 * `PALETTE`, and a crossfade that took the surfaces but left the casts behind
 * would be a worse artefact than no crossfade at all.
 *
 * A malformed registration is dropped by the parser rather than throwing, and
 * an unregistered property still works exactly as it does today; so a browser
 * that does not support `@property` loses the crossfade and keeps the theme.
 */
export function themeRegistrations(): string {
  return Object.entries(PALETTE)
    .flatMap(([group, roles]) =>
      Object.entries(roles).map(
        ([role, value]) =>
          `@property ${customProperty(group, role)} {\n` +
          `  syntax: "<color>";\n` +
          `  inherits: true;\n` +
          `  initial-value: ${value.dark};\n` +
          `}`
      )
    )
    .join("\n")
}

/** Every custom property the palette defines, for the suite that pins them. */
export const themeProperties = (): string[] =>
  Object.entries(PALETTE).flatMap(([group, roles]) =>
    Object.keys(roles).map((role) => customProperty(group, role))
  )

const { cast, castSoft, castTooltip, ring, rim } = references("shadow", PALETTE.shadow)

export const tokens = {
  color: references("color", PALETTE.color),
  code: references("code", PALETTE.code),
  /*
   * The kit's radius ladder (ADOPTION-GUIDE § 4), under the kit's own names.
   *
   *   xs 4    protected micro floor: swatches, tiny chips, arrow tips
   *   sm 8    small controls, glyph plates, mini buttons
   *   md 10   menu items (concentric in a 16px menu with 6px padding)
   *   lg 12   the default: segmented tracks, row highlights, tooltips
   *   2xl 14  ACTION BUTTONS — every text button is one family
   *   3xl 16  cards, menus, popovers, fields, floating panels
   *   5xl 18  modals, dialogs, overlay windows
   *   6xl 22 / 7xl 26  large cards, the composer
   *
   * Nested corners are concentric — inner = outer − inset — and `nest()` below
   * refuses an inset whose inner corner is not a rung. A circle or a pill is
   * not a rung: it is written `50%` / `999px` at the call site and carries the
   * round-corner opt-out (see `cornerShape`).
   */
  radius: {
    xs: "4px",
    sm: "8px",
    md: "10px",
    lg: "12px",
    "2xl": "14px",
    "3xl": "16px",
    "5xl": "18px",
    "6xl": "22px",
    "7xl": "26px",
  },
  /*
   * Every corner in the chrome is a squircle, and this is the only place the
   * curve is chosen — the kit's `corner-shape: squircle`, spelled as the
   * number it stands for so the next person has something to turn.
   *
   * A squircle at a 999px or 50% radius renders as a rounded SQUARE, so every
   * true circle and pill (dots, discs, pill tags, round buttons) must opt out
   * with `corner-shape: round`. That is the most common porting miss the kit
   * names, and `test/concentric-cases.mjs` sweeps for it.
   */
  cornerShape: "superellipse(2)",
  /*
   * Two shadows, and both are for surfaces that genuinely float.
   *
   * There is no panel shadow here on purpose. The side panels are docked —
   * flush to the viewport, nothing overlapping — so they are beside the app
   * rather than in front of it, and a hairline is the whole boundary they
   * need. Every cast tried on them (a ring-plus-halo, then a directional
   * one) only fogged a strip of the product with a gradient it had not asked
   * for. If a docked surface is ever added, it does not want one of these.
   *
   * The geometry is literal and the tint is a variable, so a theme can change
   * how dark a cast is without any theme being able to change how far a surface
   * floats. Those are two different decisions and only one of them is a colour.
   */
  shadow: {
    /**
     * The kit's `--elev-overlay`: menus, popovers, floating cards. A wide soft
     * cast, the 1px card-family hairline (`--hairline`) as a layer that costs
     * no layout, and in dark the top rim highlight that the kit uses instead
     * of a cast to say "nearer the light".
     */
    popover: `0 14px 44px ${cast}, 0 0 0 1px ${ring}, inset 0 1px 0 ${rim}`,
    /**
     * The kit's `--elev-modal` geometry, for surfaces that hang over the
     * product in mid-screen — the toolbar pill, the launcher, the drag ghost —
     * where a tight cast reads as a rectangle pasted on. Same hairline and rim
     * as `popover`: the same decision, "where does this surface end", made for
     * a longer distance.
     */
    float: `0 18px 56px ${castSoft}, 0 0 0 1px ${ring}, inset 0 1px 0 ${rim}`,
    /** The kit's `--elev-tooltip`, for the inverse tooltip chip. No hairline: the chip is solid ink. */
    tooltip: `0 10px 30px ${castTooltip}`,
    /**
     * The note pin's lift and its edge. Deliberately NOT theme-referenced: a
     * pin hangs over the app being edited, where the editor's theme says
     * nothing about what is behind it, so fixed black at low alpha is the only
     * cast that behaves the same on a white page and a dark one. The inset
     * hairline is the pin's border, drawn without growing the disc.
     */
    marker: "0 2px 6px rgba(0, 0, 0, 0.2), inset 0 0 0 1px rgba(0, 0, 0, 0.04)",
  },
  font: {
    /** `--font-sans`. The face the product ships, not next/font Inter. */
    ui: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "SF Pro", ui-sans-serif, system-ui, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
  },
  /**
   * The kit's type roles (ADOPTION-GUIDE § 5), at the editor's density.
   *
   * The kit's UI workhorse is body-sm (14/22). The editor keeps its 12px
   * density on purpose — two 240px columns of fields — so its workhorse is the
   * kit's CAPTION role (12/16) and its floor is the kit's BADGE role (10).
   * There is no 11px step: the kit has none, and a one-pixel step reads as a
   * blurrier label rather than a smaller one. To make something stand out,
   * change its colour or weight, not its size by a pixel.
   */
  type: {
    /** Panel rows, field labels, tool labels: the kit's caption size. */
    body: "12px",
    /**
     * Group headers, hints, metadata: also the caption size. It was 11px; the
     * hierarchy is now carried by `textDim` ink and weight, as the kit does.
     */
    caption: "12px",
    /** The kit's badge role. Counts, type tags, eyebrows — a mark, never prose. */
    micro: "10px",
    weightBody: 400,
    /** The kit's caption weight: values, labels you read at a glance. */
    weightValue: 500,
    /** The kit's strong weight (body-sm / caption strong). */
    weightSection: 600,
    /** The kit's heading weight, between semibold and bold. Panel and dialog titles. */
    weightTitle: 650,
    /** Heading tracking at the editor's title size (the kit tightens with size). */
    trackingTitle: "-0.01em",
    /** The kit's eyebrow: caption strong, uppercase, 0.08em. */
    trackingEyebrow: "0.08em",
    /** A single line centred in a box of its own: a numeral in a disc, a chip. */
    leadingFlush: 1,
    /** The kit's caption leading, 12/16. The default for text in a row. */
    leadingRow: 1.333,
    /** The kit's relaxed reading leading (body 16/26): hints, empty states, notes. */
    leadingBody: 1.625,
    /** Code, which wants more air than prose: monospace sets denser. */
    leadingCode: 1.55,
    /**
     * The measure for anything read as a SENTENCE. The panels are resizable,
     * so without a cap the reader with the biggest display gets the longest
     * lines. `ch`, because the cap is a statement about characters per line.
     */
    measure: "62ch",
  },
  /**
   * The kit's spacing scale (ADOPTION-GUIDE § 3), under the kit's own names.
   * Layout moves in whole 4px steps; the 2px step is for micro gaps only, and
   * there is no 10px (it always rounded up), 14px or 18px step.
   *
   * Numbers, not strings, so arithmetic at a call site stays honest. The `px`
   * is added where it is written.
   */
  space: {
    /** Micro gaps only: a tight icon cluster, a hairline offset. */
    "3xs": 2,
    /** Gap in an icon-button cluster, between stacked rows. */
    "2xs": 4,
    /** Icon-to-label inside a chip, menu padding. */
    xs: 6,
    /** The workhorse: group padding, small gaps, row-to-row. */
    sm: 8,
    /** Row inner padding, gap between blocks, pill padding. */
    md: 12,
    /** Panel and card inner padding. */
    lg: 16,
    /** Panel body padding, section gap. */
    xl: 20,
    /** Card content padding, modal side insets. */
    "2xl": 24,
    "3xl": 28,
    "4xl": 32,
    "5xl": 40,
  },
  /**
   * The kit's six icon roles (ADOPTION-GUIDE § 6). Every glyph in the chrome
   * is one of them; `IconSize` in `core/icons` makes anything off it a type
   * error. No 10, 13, 15 or 17px one-offs.
   */
  icon: {
    /** Status markers, dense pills, twisties. */
    marker: 12,
    /** Inline chrome, breadcrumbs, small tags. */
    inline: 14,
    /** The default: rows, toolbars, menus, close. */
    action: 16,
    /** Primary floating chrome — the launcher, search fields. */
    chrome: 18,
    /** Detail-view header controls. */
    header: 20,
    /** Empty states, success confirmation. */
    feature: 24,
  },
  size: {
    toolbarHeight: 36,
    panelInset: 12,
    /*
     * The width a panel STARTS at, not the width it stays at.
     *
     * Both panels are draggable (see `shell/resize.ts`), so these are two
     * things at once: the default the chrome mounts with, and the width a
     * double-click on the seam resets to. They are still the only widths baked
     * into the stylesheet, which is what makes a failed boot look like the
     * editor always did rather than like a layout with no numbers in it.
     */
    panelWidth: 240,
    inspectorWidth: 260,
    /*
     * How far either panel may be dragged, and the floor the canvas keeps.
     *
     * The minimums are where the panel's own content stops being a form. The
     * layers tree needs room for a chevron, a type glyph and enough of a name
     * to tell two siblings apart; the inspector is the tighter of the two
     * because its rows are 1fr-1fr grids, and under about 200px a pair of
     * number fields stops being two fields and becomes two boxes.
     *
     * The maximums are SHARES rather than pixels, because the thing they are
     * protecting is a share: the canvas. A 480px cap is generous on a 27-inch
     * display and swallows the whole page on a laptop, which is the case where
     * a cap matters at all. `canvasMin` is the same protection from the other
     * end, for the window narrow enough that the two shares still leave nothing
     * worth looking at between them.
     */
    panelMinWidth: 180,
    panelMaxShare: 0.34,
    inspectorMinWidth: 200,
    inspectorMaxShare: 0.38,
    canvasMinWidth: 320,
    /**
     * The grab strip on a panel seam, centred on the hairline.
     *
     * Half of it lies over the panel and half over the app, so the target is
     * the same size whichever side you approach from. 8 is what `motion-panels`
     * uses for a fine pointer and it is also the smallest strip that can be
     * hit without aiming; a coarse pointer gets the library's own wider margin
     * on top, from its hit test rather than from this box.
     */
    separatorHit: 8,
    /** Panel rows and fields. */
    rowHeight: 24,
    /** Section headers: taller than a row so the fold target is unmissable. */
    sectionHeader: 32,
    /** Trailing row affordances (eye, remove) and header adds. */
    miniSize: 18,
    /** Toolbar hit targets: larger on purpose, they are pointer-first. */
    toolSize: 28,
    /**
     * Both panels' tab strips. Tall enough to be a landmark, not a row: 8px of
     * air above and below a 24px pill, where 34 left the pills pressed against
     * the app chooser over them and the first section under them.
     */
    tabBar: 40,
    /**
     * The left panel's app chooser, the band above everything else in the
     * chrome. Taller than a section header because it heads the whole panel,
     * not one section of it.
     */
    panelHeader: 44,
    /** Handles, guides, and the marquee all share one hairline. */
    hairline: 1,
  },
  /** The kit's `emphasized` curve: lateral panel slides, occasional controls. */
  ease: "cubic-bezier(0.32, 0.72, 0, 1)",
  /** The kit's `reveal`: anything settling in — a surface, a toast, a fold. */
  easeReveal: "cubic-bezier(0.22, 1, 0.36, 1)",
  /** The kit's `exit`: anything leaving accelerates out. */
  easeExit: "cubic-bezier(0.4, 0, 1, 1)",
  /**
   * A small overshoot for a direct-manipulation PAYOFF only — a drop, a
   * reorder, the launcher landing. The kit reserves its lively spring
   * (bounce 0.2) for these moments and nothing else.
   */
  easeSpring: "cubic-bezier(0.34, 1.2, 0.64, 1)",
  /**
   * The kit's bounded tweens (ADOPTION-GUIDE § 8). The asymmetry is the point:
   * dismissal (150) hands control back sooner than a reveal (250) arrives.
   * Menus and tooltips OPEN instantly and only use `exit`.
   */
  duration: {
    /** Hover washes, press, colour changes. */
    hover: "150ms",
    /** Dismissal: a menu closing, a toast leaving. */
    exit: "150ms",
    /** A surface or fold settling in. */
    reveal: "250ms",
    /** A panel or width changing: the kit's resize tween. */
    resize: "320ms",
  },
} as const

export type Tokens = typeof tokens

/**
 * A filled accent surface and the ink that rides on it, as ONE declaration.
 *
 * The fill and its foreground are not two decisions. A call site that writes
 * `background: accentSurface` alone inherits whatever ink surrounds it — in
 * light that is near-black `text` on `#3849da`, 2.85:1, and the label
 * disappears. Emitting both properties together means the wrong pairing
 * cannot be written — the same reason `glyph-plate.ts` owns a fill and a
 * radius rather than exporting a colour. White on the fill: 4.97:1 dark,
 * 6.70:1 light.
 *
 * Written through the TOKENS rather than through literals, so every
 * accent-filled surface in the chrome follows whichever theme is up.
 */
export const accentFill = `background: ${tokens.color.accentSurface}; color: ${tokens.color.onAccent};`
export const accentFillHover = `background: ${tokens.color.accentSurfaceHover}; color: ${tokens.color.onAccent};`

/**
 * The accent fill for a surface with a WORD on it.
 *
 * A separate role because the floor is different: a glyph fill owes 3:1, a
 * 12px label owes 4.5:1. Today both resolve to the same indigo rungs, which
 * already clear 4.5:1 under white (4.97:1 dark, 6.70:1 light). The call sites
 * that need it are the ones carrying a word — the primary button, the tab's
 * count badge, and the other filled labels.
 *
 * Emitted as a pair for the same reason `accentFill` is: a call site that set
 * only the background would inherit whatever ink the surface around it had, and
 * the whole point of these two constants is that the wrong pairing cannot be
 * written.
 */
export const accentFillText = `background: ${tokens.color.accentSurfaceText}; color: ${tokens.color.onAccent};`
export const accentFillTextHover = `background: ${tokens.color.accentSurfaceTextHover}; color: ${tokens.color.onAccent};`

/* ---------- concentric corners ---------- */

/**
 * A container's padding and its children's radius, derived together.
 *
 * Two rounded rectangles, one inside the other, look WRONG unless their corners
 * share a centre. The rule is the offset-curve one: move a curve of radius R
 * inward by p and you get a curve of radius R − p, clamped at zero because a
 * corner cannot bend backwards. So the inner radius is not a taste decision and
 * it is not a step to be picked off the scale — it FALLS OUT of the outer
 * radius and the distance between the two shapes.
 *
 * The clamp is the whole edge case: once the inset reaches the radius, the
 * corner has been eroded away and the child is square. Past that point the
 * naive subtraction goes negative and, if you take its absolute value, starts
 * growing again — a child that rounds back off as you pad it further.
 *
 * `hairline` is the part nobody gets right, and it is why this is a function
 * instead of a comment. `border-radius` is measured on the element's OUTER
 * edge, so a 1px border sits between the two curves and counts toward the
 * offset exactly as padding does. The toolbar had `border: 1px` + `padding: 4px`
 * around 12px children under a 16px pill and read as concentric in the source —
 * it was off by one on screen for as long as it existed, because the true gap
 * was 5. Declaring the INSET and letting this subtract the border is what stops
 * that arithmetic being done by eye at each call site.
 *
 * It throws rather than returning a wrong-looking number, and that is
 * deliberate. These calls run when the stylesheet module is EVALUATED, so an
 * inset that does not land back on the radius ramp takes down every test that
 * imports the sheet — `npm test` names the container and the arithmetic. Not
 * `npm run build`: esbuild bundles this file without running it, so a bad nest
 * compiles perfectly and then throws the first time anything loads it.
 *
 * The ramp is 4/8/10/12/14/16/18/22/26 and a hairline is 1, so the mistake it
 * catches is nearly always one of two — an inset that forgot the border, or an
 * odd padding that lands the child between two steps of a scale the rest of
 * the chrome is drawn on.
 */
export interface Nest {
  /** The container this describes, quoted back in errors and by the guard. */
  readonly of: string
  /** The container's own radius. Always a step on the ramp. */
  readonly outer: string
  /** The gap between the two curves: the container's border plus its padding. */
  readonly inset: number
  /** How much of that gap the container's own border eats. */
  readonly hairline: number
  /**
   * Which rule writes the `padding` — the container itself, unless a bare
   * wrapper between it and the children is what actually holds them off.
   *
   * `.de-ann-box` is the case this exists for: it has no padding at all, and
   * the 4px separating its curve from its rows belongs to `.de-ann-list` in
   * between. The gap is just as real and the arithmetic is unchanged; what
   * changes is where the resulting number has to be written, and a guard that
   * assumed the container always wrote it went looking for a declaration that
   * was never going to be there.
   */
  readonly padOn: string
  /** What `padOn` writes for `padding`, so the gap measures `inset`. */
  readonly padding: string
  /** What a child tucked into one of the container's corners writes. */
  readonly radius: string
}

const RAMP = Object.values(tokens.radius).map((step) => Number.parseFloat(step))

const declared: Nest[] = []

export const nest = (spec: {
  of: string
  outer: string
  inset: number
  /** Default 0. Pass the container's border-width when it has one. */
  hairline?: number
  /** Defaults to `of`. Name the wrapper when the padding lives on one. */
  padOn?: string
}): Nest => {
  const { of, outer, inset, hairline = 0, padOn = spec.of } = spec
  /*
   * Pixels, spelled out, and nothing else.
   *
   * `parseFloat("50%")` is 50, so a percentage waved straight through here and
   * came out the other side as a fifty-pixel corner. A percentage radius is not
   * a length at all — it resolves against the box, which is why `50%` is how
   * this chrome draws a circle — and a circle has no corner for anything to be
   * concentric with. Same for a pill: a radius at or past half the height is
   * the ABSENCE of a step on the ramp, so subtracting from it means nothing.
   */
  if (!/^-?\d+(\.\d+)?px$/.test(outer)) {
    throw new Error(
      `nest(${of}): outer radius ${outer} is not a length in px — a circle or a pill has no corner to nest inside`
    )
  }
  const R = Number.parseFloat(outer)
  if (inset < hairline) {
    throw new Error(`nest(${of}): inset ${inset} is smaller than its own ${hairline}px border`)
  }
  const inner = Math.max(R - inset, 0)
  if (inner !== 0 && !RAMP.includes(inner)) {
    throw new Error(
      `nest(${of}): ${R} − ${inset} = ${inner}, which is not on the radius ramp ` +
        `(${RAMP.join(", ")}). Move the inset to a multiple of 4 counting the ` +
        `${hairline}px border, or square the corner off.`
    )
  }
  const built: Nest = {
    of,
    outer,
    inset,
    hairline,
    padOn,
    padding: `${inset - hairline}px`,
    radius: `${inner}px`,
  }
  declared.push(built)
  return built
}

/**
 * Every nest built this run, in declaration order.
 *
 * The stylesheet is assembled by importing every module in `css/`, so by the
 * time `shellCss` exists this holds the chrome's complete set of nested
 * corners. `test/concentric-cases.mjs` reads it and checks each one against the
 * CSS that was actually emitted — which is what catches the other half of the
 * problem this file cannot see on its own: a `nest()` declared correctly and
 * then not used, or used by a child that quietly overrides it later in the
 * cascade.
 */
export const declaredNests = (): readonly Nest[] => declared
