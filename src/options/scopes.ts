/**
 * Saved-style scopes: which part of an element's look each Design-tab section
 * owns.
 *
 * A saved style used to be a whole-element snapshot, so applying a "heading"
 * look also reset the padding and the fill. Scoping it the way Figma does —
 * text styles, color styles, effect styles — needs one answer to "does this
 * class or property belong to Typography?", and this file is that answer. What
 * it cannot classify belongs to no scope, and no scoped apply ever touches it:
 * losing an unknown class is worse than failing to carry it across.
 */

import { baseUtility, propertyForClass } from "../core/tailwind"
import type { StyleEdit, StyleScope } from "../core/types"
import type { OptionSnapshot } from "./store"

export type { StyleScope } from "../core/types"

export const STYLE_SCOPES: readonly StyleScope[] = [
  "typography",
  "fill",
  "stroke",
  "effects",
  "appearance",
  "layout",
]

export const SCOPE_LABELS: Record<StyleScope, string> = {
  typography: "Text style",
  fill: "Color style",
  stroke: "Stroke style",
  effects: "Effect style",
  appearance: "Appearance style",
  layout: "Layout style",
}

/*
 * Margin is deliberately in no scope: it positions an element among its
 * siblings rather than describing the element, and a layout style that moved
 * the thing it was applied to would be a surprise.
 */
const PROPERTIES: Record<StyleScope, RegExp> = {
  typography: new RegExp(
    "^(" +
      [
        "color",
        "font",
        "font-(family|size|weight|style|stretch|kerning|feature-settings|variation-settings|optical-sizing)",
        "font-variant(-[a-z-]+)?",
        "line-height",
        "letter-spacing",
        "word-spacing",
        "text-(align|align-last|indent|transform|overflow|wrap|wrap-mode|wrap-style|rendering)",
        "text-decoration(-(line|color|style|thickness|skip-ink))?",
        "text-underline-offset",
        "white-space(-collapse)?",
        "word-break",
        "overflow-wrap",
        "hyphens",
        "-webkit-font-smoothing",
        "-moz-osx-font-smoothing",
        "-webkit-line-clamp",
      ].join("|") +
      ")$"
  ),
  fill: /^(background|background-(color|image|size|position(-[xy])?|repeat|clip|origin|attachment)|fill)$/,
  stroke: new RegExp(
    "^(" +
      [
        "border(-(top|right|bottom|left|inline|block)(-(start|end))?)?(-(width|color|style))?",
        "outline(-(width|color|style|offset))?",
        "stroke(-(width|dasharray|dashoffset|linecap|linejoin|opacity))?",
        "--tw-ring-(color|width|shadow|inset|offset-width|offset-color)",
      ].join("|") +
      ")$"
  ),
  effects: /^(box-shadow|text-shadow|filter|backdrop-filter|-webkit-backdrop-filter|--tw-shadow(-color)?)$/,
  appearance: /^(opacity|border-radius|border(-[a-z]+)+-radius|mix-blend-mode|visibility)$/,
  layout: new RegExp(
    "^(" +
      [
        "display",
        "flex",
        "flex-(direction|wrap|flow|grow|shrink|basis)",
        "gap",
        "row-gap",
        "column-gap",
        "padding(-(top|right|bottom|left|inline|block)(-(start|end))?)?",
        "(min-|max-)?(width|height|inline-size|block-size)",
        "justify-(content|items|self)",
        "align-(items|self|content)",
        "place-(content|items|self)",
        "grid(-[a-z-]+)?",
      ].join("|") +
      ")$"
  ),
}

export function scopeOwnsProperty(scope: StyleScope, property: string): boolean {
  return PROPERTIES[scope].test(property.trim().toLowerCase())
}

/**
 * Utilities tailwind.ts has no writer for, and so cannot read back either.
 * Each maps to the property it sets, so classification still goes through
 * `scopeOwnsProperty` and there is one list per scope, not two.
 */
const EXTRAS: Array<[RegExp, string]> = [
  // typography
  [/^(uppercase|lowercase|capitalize|normal-case)$/, "text-transform"],
  [/^(italic|not-italic)$/, "font-style"],
  [/^(underline|overline|line-through|no-underline)$/, "text-decoration-line"],
  [/^decoration-(solid|double|dotted|dashed|wavy)$/, "text-decoration-style"],
  [/^decoration-(auto|from-font|\d+|\[.*px\])$/, "text-decoration-thickness"],
  [/^decoration-/, "text-decoration-color"],
  [/^underline-offset-/, "text-underline-offset"],
  [/^(truncate|text-ellipsis|text-clip)$/, "text-overflow"],
  [/^(text-wrap|text-nowrap|text-balance|text-pretty)$/, "text-wrap"],
  [/^whitespace-/, "white-space"],
  [/^break-(normal|words|all|keep)$/, "word-break"],
  [/^(antialiased|subpixel-antialiased)$/, "-webkit-font-smoothing"],
  [/^line-clamp-/, "-webkit-line-clamp"],
  [/^(normal-nums|ordinal|slashed-zero|lining-nums|oldstyle-nums|proportional-nums|tabular-nums|diagonal-fractions|stacked-fractions)$/, "font-variant-numeric"],
  [/^indent-/, "text-indent"],
  // fill
  [/^bg-(linear|gradient|radial|conic)(-|$)/, "background-image"],
  [/^bg-(none|\[url\(.*)/, "background-image"],
  [/^(from|via|to)-/, "background-image"],
  [/^bg-(auto|cover|contain)$/, "background-size"],
  [/^bg-(center|top|bottom|left|right|left-top|left-bottom|right-top|right-bottom)$/, "background-position"],
  [/^bg-(no-)?repeat(-[a-z]+)?$/, "background-repeat"],
  [/^bg-clip-/, "background-clip"],
  // stroke
  [/^border-(t|r|b|l|x|y|s|e)(-\d+|-\[[^\]]*px\])?$/, "border-top-width"],
  [/^border-(t|r|b|l|x|y|s|e)-/, "border-top-color"],
  [/^ring-offset-(\d+|\[[^\]]*px\])$/, "--tw-ring-offset-width"],
  [/^ring-offset-/, "--tw-ring-offset-color"],
  [/^ring-inset$/, "--tw-ring-inset"],
  [/^ring(-\d+|-\[[^\]]*px\])?$/, "--tw-ring-width"],
  [/^outline-(solid|dashed|dotted|double|hidden|none)$/, "outline-style"],
  [/^outline-offset-/, "outline-offset"],
  [/^outline(-\d+|-\[[^\]]*px\])?$/, "outline-width"],
  [/^stroke-(\d+|\[[^\]]*px\])$/, "stroke-width"],
  // effects
  [/^(blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|saturate|sepia)(-|$)/, "filter"],
  [/^backdrop-/, "backdrop-filter"],
  [/^text-shadow(-|$)/, "text-shadow"],
  // appearance
  [/^mix-blend-/, "mix-blend-mode"],
  [/^(visible|invisible|collapse)$/, "visibility"],
  // layout
  [/^px-/, "padding-inline"],
  [/^py-/, "padding-block"],
  [/^p(s|e)-/, "padding-inline-start"],
  [/^size-/, "width"],
  [/^(grow|shrink)(-|$)/, "flex-grow"],
  [/^basis-/, "flex-basis"],
  [/^(grid-cols|grid-rows|col-span|col-start|col-end|row-span|row-start|row-end|grid-flow|auto-cols|auto-rows)(-|$)/, "grid-template-columns"],
  [/^(items|justify|justify-items|justify-self|self|content|place-content|place-items|place-self)-/, "align-items"],
  [/^space-(x|y)-/, "column-gap"],
  [/^(flex|inline-flex|grid|inline-grid|block|inline-block|table|hidden|contents)$/, "display"],
]

/** The CSS property a class sets, or null when this file cannot tell. */
export function propertyOfClass(className: string): string | null {
  const known = propertyForClass(className)
  if (known) return known
  const base = baseUtility(className)
  for (const [pattern, property] of EXTRAS) {
    if (pattern.test(base)) return property
  }
  return null
}

export function scopeOwnsClass(scope: StyleScope, className: string): boolean {
  const property = propertyOfClass(className)
  return property !== null && scopeOwnsProperty(scope, property)
}

/** The part of a snapshot a scope owns. Text is never part of a style. */
export function sliceSnapshot(snapshot: OptionSnapshot, scope: StyleScope): OptionSnapshot {
  const className = snapshot.className
    .split(/\s+/)
    .filter((name) => name && scopeOwnsClass(scope, name))
    .join(" ")
  const style: StyleEdit = {}
  for (const [property, value] of Object.entries(snapshot.style)) {
    if (scopeOwnsProperty(scope, property)) style[property] = value
  }
  return { className, style }
}

/** Two slices are the same style when their class sets and declarations match. */
export function slicesEqual(a: OptionSnapshot, b: OptionSnapshot): boolean {
  const classesA = new Set(a.className.split(/\s+/).filter(Boolean))
  const classesB = new Set(b.className.split(/\s+/).filter(Boolean))
  if (classesA.size !== classesB.size) return false
  for (const name of classesA) if (!classesB.has(name)) return false
  const entriesA = Object.entries(a.style)
  if (entriesA.length !== Object.keys(b.style).length) return false
  return entriesA.every(([property, value]) => b.style[property] === value)
}
