/**
 * CSS declaration -> Tailwind class update.
 *
 * The React Rewrite engine only ever writes Tailwind utilities into JSX; it has
 * no verb for a raw inline style. So every inspector control that thinks in CSS
 * is translated here, once, on the way to the source writer. Inline styles still
 * drive the live preview — this is only what lands in the file.
 */

import { config } from "./config"

export interface ClassUpdate {
  tailwindPrefix: string
  tailwindToken: string | null
  value: string
  relatedPrefixes?: string[]
  classPattern?: string
  standalone?: boolean
}

/**
 * Properties whose class name *is* the value. The engine matches on
 * `classPattern` rather than the prefix because these share no common stem
 * (`flex` and `hidden` are both `display`), and because a prefix match would
 * let `display: flex` clobber an unrelated `flex-col`.
 */
const KEYWORDS: Record<string, Record<string, string>> = {
  display: {
    block: "block",
    "inline-block": "inline-block",
    inline: "inline",
    flex: "flex",
    "inline-flex": "inline-flex",
    grid: "grid",
    "inline-grid": "inline-grid",
    contents: "contents",
    none: "hidden",
  },
  "flex-direction": {
    row: "flex-row",
    "row-reverse": "flex-row-reverse",
    column: "flex-col",
    "column-reverse": "flex-col-reverse",
  },
  "flex-wrap": {
    wrap: "flex-wrap",
    nowrap: "flex-nowrap",
    "wrap-reverse": "flex-wrap-reverse",
  },
  "justify-content": {
    "flex-start": "justify-start",
    center: "justify-center",
    "flex-end": "justify-end",
    "space-between": "justify-between",
    "space-around": "justify-around",
    "space-evenly": "justify-evenly",
  },
  // Per-child override of the parent's `align-items`, so the inspector can
  // align one selected element instead of restyling everything beside it.
  "align-self": {
    auto: "self-auto",
    "flex-start": "self-start",
    center: "self-center",
    "flex-end": "self-end",
    stretch: "self-stretch",
    baseline: "self-baseline",
  },
  // `Fill` in a flex row means "take the remaining space", which is `flex-1`.
  // Without this the only translatable fallback is `width: 100%`, which is
  // wrong the moment the element has a sibling.
  flex: {
    "1 1 0%": "flex-1",
    "1 1 auto": "flex-auto",
    "0 1 auto": "flex-initial",
    none: "flex-none",
  },
  // A fixed length on a full flex line, which would otherwise squeeze it back
  // (`core/sizing.ts`).
  "flex-shrink": {
    "0": "shrink-0",
    "1": "shrink",
  },
  "border-style": {
    solid: "border-solid",
    dashed: "border-dashed",
    dotted: "border-dotted",
    double: "border-double",
    hidden: "border-hidden",
    none: "border-none",
  },
  "align-items": {
    "flex-start": "items-start",
    center: "items-center",
    "flex-end": "items-end",
    stretch: "items-stretch",
    baseline: "items-baseline",
  },
  "text-align": {
    left: "text-left",
    center: "text-center",
    right: "text-right",
    justify: "text-justify",
  },
  "font-weight": {
    "100": "font-thin",
    "200": "font-extralight",
    "300": "font-light",
    "400": "font-normal",
    "500": "font-medium",
    "600": "font-semibold",
    "700": "font-bold",
    "800": "font-extrabold",
    "900": "font-black",
  },
  "font-style": {
    italic: "italic",
    normal: "not-italic",
  },
  // Figma's Clip content, its visibility eye and its blend mode menu.
  overflow: {
    hidden: "overflow-hidden",
    visible: "overflow-visible",
    clip: "overflow-clip",
    auto: "overflow-auto",
    scroll: "overflow-scroll",
  },
  visibility: {
    visible: "visible",
    hidden: "invisible",
    collapse: "collapse",
  },
  "mix-blend-mode": {
    normal: "mix-blend-normal",
    multiply: "mix-blend-multiply",
    screen: "mix-blend-screen",
    overlay: "mix-blend-overlay",
    darken: "mix-blend-darken",
    lighten: "mix-blend-lighten",
    "color-dodge": "mix-blend-color-dodge",
    "color-burn": "mix-blend-color-burn",
    "hard-light": "mix-blend-hard-light",
    "soft-light": "mix-blend-soft-light",
    difference: "mix-blend-difference",
    exclusion: "mix-blend-exclusion",
    hue: "mix-blend-hue",
    saturation: "mix-blend-saturation",
    color: "mix-blend-color",
    luminosity: "mix-blend-luminosity",
    "plus-darker": "mix-blend-plus-darker",
    "plus-lighter": "mix-blend-plus-lighter",
  },
  // Figma's type settings: case and decoration.
  "text-transform": {
    uppercase: "uppercase",
    lowercase: "lowercase",
    capitalize: "capitalize",
    none: "normal-case",
  },
  "text-decoration-line": {
    underline: "underline",
    "line-through": "line-through",
    overline: "overline",
    none: "no-underline",
  },
  "text-decoration": {
    underline: "underline",
    "line-through": "line-through",
    overline: "overline",
    none: "no-underline",
  },
  // A text layer's auto width keeps its words on one line.
  "white-space": {
    normal: "whitespace-normal",
    nowrap: "whitespace-nowrap",
    pre: "whitespace-pre",
    "pre-line": "whitespace-pre-line",
    "pre-wrap": "whitespace-pre-wrap",
  },
  /*
   * Transitions, in Tailwind's names. `all` lands as `transition`, Tailwind's
   * list of the properties a state change animates, which is what Figma's
   * Smart animate means. `transition-all` reads back as the same property
   * (see below).
   */
  "transition-property": {
    all: "transition",
    "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke": "transition-colors",
    opacity: "transition-opacity",
    "transform, translate, scale, rotate": "transition-transform",
    "box-shadow": "transition-shadow",
    none: "transition-none",
  },
  // Tailwind's curves, keyed by the cubic-bezier each one compiles to, so the
  // inline preview moves the way the shipped class will. The CSS keywords map
  // to the same classes for a value typed by hand.
  "transition-timing-function": {
    linear: "ease-linear",
    "cubic-bezier(0.4, 0, 1, 1)": "ease-in",
    "cubic-bezier(0, 0, 0.2, 1)": "ease-out",
    "cubic-bezier(0.4, 0, 0.2, 1)": "ease-in-out",
    "ease-in": "ease-in",
    "ease-out": "ease-out",
    "ease-in-out": "ease-in-out",
  },
}

/** Classes that set a keyword property without being one of its written values. */
const KEYWORD_ALIASES: Record<string, string[]> = {
  "transition-property": ["transition-all"],
  // Tailwind 2's spelling, still compiled by v3: replaced rather than doubled.
  "flex-shrink": ["flex-shrink-0", "flex-shrink"],
}

/**
 * Durations Tailwind v3's default scale names; v4 compiles any integer. Inside
 * this set `duration-200` works under both, so it is written by name.
 */
const DURATION_STEPS = new Set([0, 75, 100, 150, 200, 300, 500, 700, 1000])

/**
 * Properties Tailwind has no utility for, written as an arbitrary-property
 * class (`[font-variation-settings:'wdth'_92]`). A text style read from a
 * stylesheet carries its variable-font axes, and without this every pick of
 * one reported its axes as preview only.
 */
const ARBITRARY_PROPERTIES = new Set([
  "font-variation-settings",
  "font-feature-settings",
  // Figma's flips. Tailwind's `-scale-x-100` drives `--tw-scale-*` variables
  // that differ between v3 and v4; the raw property reads the same under both.
  "scale",
])

const GRID_TRACKS: Record<string, string> = {
  "grid-template-columns": "grid-cols",
  "grid-template-rows": "grid-rows",
}

const FONT_WEIGHT_PATTERN =
  "^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\\[(?:[1-9]\\d{0,2}|1000|number:var\\(--[\\w-]+\\))\\])$"

/** Prefix stems that need a stem-plus-value class, e.g. `gap` -> `gap-2`. */
const SCALARS: Record<
  string,
  { prefix: string; related?: string[]; pattern?: string }
> = {
  opacity: { prefix: "opacity" },
  gap: { prefix: "gap" },
  "column-gap": { prefix: "gap-x", related: ["gap"] },
  "row-gap": { prefix: "gap-y", related: ["gap"] },
  padding: { prefix: "p" },
  "padding-top": { prefix: "pt", related: ["p", "py"] },
  "padding-right": { prefix: "pr", related: ["p", "px"] },
  "padding-bottom": { prefix: "pb", related: ["p", "py"] },
  "padding-left": { prefix: "pl", related: ["p", "px"] },
  margin: { prefix: "m" },
  "margin-top": { prefix: "mt", related: ["m", "my"] },
  "margin-right": { prefix: "mr", related: ["m", "mx"] },
  "margin-bottom": { prefix: "mb", related: ["m", "my"] },
  "margin-left": { prefix: "ml", related: ["m", "mx"] },
  width: { prefix: "w" },
  height: { prefix: "h" },
  "min-width": { prefix: "min-w" },
  "min-height": { prefix: "min-h" },
  "max-width": { prefix: "max-w" },
  "max-height": { prefix: "max-h" },
  "border-radius": { prefix: "rounded" },
  "border-top-left-radius": { prefix: "rounded-tl", related: ["rounded", "rounded-t"] },
  "border-top-right-radius": { prefix: "rounded-tr", related: ["rounded", "rounded-t"] },
  "border-bottom-right-radius": { prefix: "rounded-br", related: ["rounded", "rounded-b"] },
  "border-bottom-left-radius": { prefix: "rounded-bl", related: ["rounded", "rounded-b"] },
  // `bg` is not only a colour stem: `bg-cover`, `bg-center` and `bg-no-repeat`
  // all sit on it, and a prefix match would take a repeat rule off the element
  // as the price of recolouring it. Same reason `text` and `border` carry one.
  "background-color": { prefix: "bg", pattern: colorClass("bg") },
  "line-height": { prefix: "leading" },
  "letter-spacing": { prefix: "tracking" },
  "box-shadow": { prefix: "shadow" },
  // A step on Tailwind v3's default scale lands by name (`duration-200`, see
  // `DURATION_STEPS`); anything else is an arbitrary `duration-[240ms]`, which
  // compiles under any theme.
  "transition-duration": { prefix: "duration" },

  /*
   * `text`, `border`, and `font` each serve two properties, and `ring`,
   * `outline` and `stroke` each carry a width beside their colour. Prefix
   * matching cannot tell `text-lg` from `text-red-500`, so these carry an
   * explicit pattern and only replace a class of their own kind.
   */
  color: { prefix: "text", pattern: colorClass("text") },
  "font-size": { prefix: "text", pattern: `^text-(\\[(?:[^\\]]*(?:px|rem|em|ch|%)|length:var\\(--[\\w-]+\\))\\]|${config.tailwind.fontSizes.join("|")})$` },
  "border-width": { prefix: "border", pattern: "^border(-\\[[^\\]]*px\\]|-\\d+)?$" },
  // Figma's individual strokes. Width-only patterns, so `border-t-red-500` survives.
  "border-top-width": { prefix: "border-t", pattern: "^border-t(-\\[[^\\]]*px\\]|-\\d+)?$" },
  "border-right-width": { prefix: "border-r", pattern: "^border-r(-\\[[^\\]]*px\\]|-\\d+)?$" },
  "border-bottom-width": { prefix: "border-b", pattern: "^border-b(-\\[[^\\]]*px\\]|-\\d+)?$" },
  "border-left-width": { prefix: "border-l", pattern: "^border-l(-\\[[^\\]]*px\\]|-\\d+)?$" },
  // Figma's Rotation field. Tailwind v4's `rotate-[45deg]` sets `rotate` itself.
  rotate: { prefix: "rotate", pattern: "^rotate-(\\d+|\\[[^\\]]+\\])$" },
  "border-color": { prefix: "border", pattern: colorClass("border") },
  // A ring in Tailwind v4 is a box-shadow driven by this custom property, so
  // recolouring one writes the variable rather than a border it does not have.
  "--tw-ring-color": { prefix: "ring", pattern: colorClass("ring") },
  "outline-color": { prefix: "outline", pattern: colorClass("outline") },
  fill: { prefix: "fill", pattern: colorClass("fill") },
  stroke: { prefix: "stroke", pattern: colorClass("stroke") },
  "font-family": {
    prefix: "font",
    pattern: `^font-(${config.tailwind.fontFamilies.join("|")}|\\[(?!(?:(?:[1-9]\\d{0,2}|1000)\\]|number:))[^\\]]+\\])$`,
  },
}

/**
 * px -> Tailwind step, from the host config. A miss is not an error: the value
 * falls through to an arbitrary `[13px]`, which is correct but unnamed, so a
 * host on a custom scale only loses class names it never had.
 */
const SPACING_SCALE: Record<string, string> = config.tailwind.spacingScale

const SPACED_STEMS = new RegExp(
  config.tailwind.spacedStems ??
    "^(p|pt|pr|pb|pl|px|py|m|mt|mr|mb|ml|mx|my|gap|gap-x|gap-y|w|h|min-w|min-h|max-w|max-h)$"
)

function colorWords(): string {
  // Tailwind palette stems plus the host's semantic tokens, so a themed class
  // like `text-muted-foreground` is replaced rather than duplicated.
  return `(${config.tailwind.colorWords.join("|")})([-/].*)?`
}

/**
 * Colour-valued classes on a stem that also carries a width or a size:
 * `ring-2`, `outline-none`, `stroke-2` and `border` must survive a recolour.
 */
function colorClass(stem: string): string {
  return `^${stem}-(\\[(#|rgb|hsl|oklch|var).*\\]|${colorWords()})$`
}

/**
 * Tailwind arbitrary values may not contain spaces; underscores stand in. Nor
 * may they carry a double quote, which would end the `className="…"` it is
 * written into: CSS reads a single-quoted family name or axis tag the same.
 */
function toArbitrary(value: string): string {
  return value.trim().replace(/\s+/g, "_").replace(/"/g, "'")
}

/** Resolves a px length onto the spacing scale when it lands exactly on a step. */
function spacingToken(prefix: string, value: string): string | null {
  if (!SPACED_STEMS.test(prefix)) return null
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim())
  if (!match) return null
  const px = Number(match[1])
  const token = SPACING_SCALE[Math.abs(px)]
  return token == null ? null : `${px < 0 ? "-" : ""}${token}`
}

/** `200ms` or `0.2s` -> `200` when Tailwind's scale names it. */
function durationToken(value: string): string | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value.trim())
  if (!match) return null
  const ms = Math.round(Number(match[1]) * (match[2] === "s" ? 1000 : 1))
  return DURATION_STEPS.has(ms) ? String(ms) : null
}

/**
 * Stable per-property key. The engine uses it to replace an earlier pending
 * edit to the same property instead of stacking a second class onto the node.
 */
export function propertyKey(property: string): string {
  return property
}

export function toClassUpdate(property: string, rawValue: string): ClassUpdate | null {
  const value = rawValue.trim()
  if (!value) return null

  if (ARBITRARY_PROPERTIES.has(property)) {
    const className = `[${property}:${toArbitrary(value)}]`
    return {
      tailwindPrefix: className,
      tailwindToken: className,
      value: className,
      standalone: true,
      classPattern: `^\\[${property}:.+\\]$`,
    }
  }

  /*
   * Figma's grid flow writes track counts. `repeat(n, minmax(0, 1fr))` is
   * exactly what Tailwind's `grid-cols-n` compiles to, so it lands as the named
   * class; any other track list stays an arbitrary value on the same stem.
   */
  const tracks = GRID_TRACKS[property]
  if (tracks) {
    const count = /^repeat\(\s*(\d+)\s*,\s*minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s*\)$/.exec(value)
    const className = count ? `${tracks}-${count[1]}` : `${tracks}-[${toArbitrary(value)}]`
    return {
      tailwindPrefix: className,
      tailwindToken: className,
      value,
      standalone: true,
      classPattern: `^${tracks}-(\\d+|none|subgrid|\\[.+\\])$`,
    }
  }

  const keywords = KEYWORDS[property]
  if (keywords) {
    const token = keywords[value]
    // The design-system type ramp uses 650, and its CSS-variable spelling is
    // also a valid Tailwind arbitrary font-weight. Keep this branch narrower
    // than `font-family`: both share the `font-` stem, so the replacement
    // pattern must describe weights only or selecting H1 can erase `font-sans`.
    if (!token && property === "font-weight") {
      const number = /^(?:[1-9]\d{0,2}|1000)$/.test(value)
      const variable = /^var\(--[\w-]+\)$/.test(value)
      if (!number && !variable) return null
      return {
        tailwindPrefix: "font",
        tailwindToken: null,
        value: variable ? `number:${toArbitrary(value)}` : toArbitrary(value),
        classPattern: FONT_WEIGHT_PATTERN,
      }
    }
    if (!token) return null
    const alternatives = [...new Set([...Object.values(keywords), ...(KEYWORD_ALIASES[property] ?? [])])]
      .map((cls) => cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")
    return {
      tailwindPrefix: token,
      tailwindToken: token,
      value,
      standalone: true,
      classPattern: `^(${alternatives})$`,
    }
  }

  const scalar = SCALARS[property]
  if (!scalar) return null

  // `w-auto` rather than `w-[auto]`: Fill on a flex line lets a fixed length go.
  const auto = value === "auto" && (property === "width" || property === "height") ? "auto" : null
  const token = auto ?? (property === "transition-duration" ? durationToken(value) : spacingToken(scalar.prefix, value))
  const typedValue = property === "font-size" && /^var\(--[\w-]+\)$/.test(value)
    ? `length:${toArbitrary(value)}`
    : toArbitrary(value)
  return {
    tailwindPrefix: scalar.prefix,
    tailwindToken: token,
    value: token ? value : typedValue,
    ...(scalar.related ? { relatedPrefixes: scalar.related } : {}),
    ...(scalar.pattern ? { classPattern: scalar.pattern } : {}),
  }
}

/**
 * Strips what does not change which property a class sets: variant prefixes
 * (`hover:`, `md:`, `[&>svg]:`), the `!` important marker and a leading `-`.
 * Colons inside brackets belong to arbitrary values, so the split tracks depth.
 */
export function baseUtility(className: string): string {
  let depth = 0
  let start = 0
  for (let index = 0; index < className.length; index += 1) {
    const char = className[index]
    if (char === "[" || char === "(") depth += 1
    else if ((char === "]" || char === ")") && depth > 0) depth -= 1
    else if (char === ":" && depth === 0) start = index + 1
  }
  let base = className.slice(start)
  if (base.startsWith("!")) base = base.slice(1)
  if (base.endsWith("!")) base = base.slice(0, -1)
  if (base.startsWith("-")) base = base.slice(1)
  return base
}

let keywordIndex: Map<string, string> | null = null
let patterned: Array<[string, RegExp]> | null = null
let prefixed: Array<[string, string]> | null = null

/**
 * The CSS property a Tailwind class sets, read back off the same KEYWORDS and
 * SCALARS tables `toClassUpdate` writes from — so the two directions cannot
 * disagree about which property `text-lg` or `border-red-500` belongs to.
 * Returns null for anything those tables do not describe; callers that need a
 * wider net (saved-style scopes) layer their own extras on top.
 */
export function propertyForClass(className: string): string | null {
  const cls = baseUtility(className)
  if (!cls) return null

  // `[mask-type:luminance]`: the arbitrary-property form names its property.
  const arbitrary = /^\[(-{0,2}[a-z][\w-]*):.+\]$/.exec(cls)
  if (arbitrary) return arbitrary[1]

  if (!keywordIndex) {
    keywordIndex = new Map()
    for (const [property, values] of Object.entries(KEYWORDS)) {
      for (const token of Object.values(values)) keywordIndex.set(token, property)
    }
    for (const [property, aliases] of Object.entries(KEYWORD_ALIASES)) {
      for (const token of aliases) keywordIndex.set(token, property)
    }
    patterned = Object.entries(SCALARS)
      .filter(([, scalar]) => scalar.pattern)
      .map(([property, scalar]) => [property, new RegExp(scalar.pattern as string)])
    // Longest stem first, so `gap-x-2` is `column-gap` and not `gap`.
    prefixed = Object.entries(SCALARS)
      .filter(([, scalar]) => !scalar.pattern)
      .map(([property, scalar]) => [property, scalar.prefix] as [string, string])
      .sort((a, b) => b[1].length - a[1].length)
  }

  for (const [property, stem] of Object.entries(GRID_TRACKS)) {
    if (cls.startsWith(`${stem}-`)) return property
  }
  const keyword = keywordIndex.get(cls)
  if (keyword) return keyword
  if (new RegExp(FONT_WEIGHT_PATTERN).test(cls)) return "font-weight"
  for (const [property, pattern] of patterned ?? []) {
    if (pattern.test(cls)) return property
  }
  for (const [property, prefix] of prefixed ?? []) {
    if (cls === prefix || cls.startsWith(`${prefix}-`)) return property
  }
  return null
}
