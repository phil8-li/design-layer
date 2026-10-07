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
  // `duration` consults no spacing scale, so a token duration lands as an
  // arbitrary `duration-[150ms]`. That class compiles under any theme, where
  // the bare-number form depends on what the host's scale happens to name.
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

/** Tailwind arbitrary values may not contain spaces; underscores stand in. */
function toArbitrary(value: string): string {
  return value.trim().replace(/\s+/g, "_")
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
    const alternatives = Object.values(keywords)
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

  const token = spacingToken(scalar.prefix, value)
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
    patterned = Object.entries(SCALARS)
      .filter(([, scalar]) => scalar.pattern)
      .map(([property, scalar]) => [property, new RegExp(scalar.pattern as string)])
    // Longest stem first, so `gap-x-2` is `column-gap` and not `gap`.
    prefixed = Object.entries(SCALARS)
      .filter(([, scalar]) => !scalar.pattern)
      .map(([property, scalar]) => [property, scalar.prefix] as [string, string])
      .sort((a, b) => b[1].length - a[1].length)
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
