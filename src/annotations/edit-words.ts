/**
 * What an edit says, to the designer and to the agent.
 *
 * A direct edit in the Design panel becomes a note the editor writes, and that
 * note has two readers who need different things. The designer reads it in the
 * Changes tab and on its pin, so it is one plain sentence in the panel's own
 * vocabulary: "Change the corner radius to 20px (was 12px)". The agent reads it
 * in the brief, where it has to act on it, so the brief adds the exact
 * declaration, the utility class to write on a Tailwind host, and how to make
 * the change in source rather than in the browser.
 *
 * Both are built here, from the same record, so the sentence and the
 * instructions cannot describe one edit two ways.
 */

import { config } from "../core/config"
import { propertyForClass, toClassUpdate } from "../core/tailwind"
import type { EditRecord } from "./types"

/** A run of copy longer than this is cut in a sentence, never in the brief's code. */
const MAX_QUOTE = 60

/**
 * The panel's names for the properties it writes, lower-case so they sit in
 * a sentence. Figma's words where the Design tab uses them: corner radius,
 * fill, stroke. A property missing here is named as itself.
 */
const NAMES: Record<string, string> = {
  width: "width",
  height: "height",
  "min-width": "minimum width",
  "max-width": "maximum width",
  "min-height": "minimum height",
  "max-height": "maximum height",
  "aspect-ratio": "aspect ratio",
  padding: "padding",
  "padding-top": "top padding",
  "padding-right": "right padding",
  "padding-bottom": "bottom padding",
  "padding-left": "left padding",
  "padding-inline": "horizontal padding",
  "padding-block": "vertical padding",
  margin: "margin",
  "margin-top": "top margin",
  "margin-right": "right margin",
  "margin-bottom": "bottom margin",
  "margin-left": "left margin",
  // Short, so the value survives the row's one line in a 260px panel.
  gap: "gap",
  "row-gap": "row gap",
  "column-gap": "column gap",
  "border-radius": "corner radius",
  "border-top-left-radius": "top-left corner radius",
  "border-top-right-radius": "top-right corner radius",
  "border-bottom-right-radius": "bottom-right corner radius",
  "border-bottom-left-radius": "bottom-left corner radius",
  opacity: "opacity",
  background: "fill",
  "background-color": "fill color",
  "background-image": "fill image",
  color: "text color",
  "font-family": "font",
  "font-size": "font size",
  "font-weight": "font weight",
  "line-height": "line height",
  "letter-spacing": "letter spacing",
  border: "stroke",
  "border-width": "stroke width",
  "border-color": "stroke color",
  "border-style": "stroke style",
  outline: "outline",
  "box-shadow": "shadow",
  filter: "filter",
  "backdrop-filter": "background filter",
  "mix-blend-mode": "blend mode",
  rotate: "rotation",
  "z-index": "stacking order",
  position: "positioning",
  top: "top offset",
  right: "right offset",
  bottom: "bottom offset",
  left: "left offset",
  "flex-grow": "grow factor",
  "flex-shrink": "shrink factor",
  "flex-basis": "base size",
  flex: "flex sizing",
  "align-self": "alignment in its parent",
  "grid-template-columns": "grid columns",
  "grid-template-rows": "grid rows",
  "object-fit": "image fit",
  "transition-duration": "transition duration",
  cursor: "cursor",
}

const FONT_WEIGHTS: Record<string, string> = {
  "100": "Thin",
  "200": "Extra Light",
  "300": "Light",
  "400": "Regular",
  normal: "Regular",
  "500": "Medium",
  "600": "Semi Bold",
  "700": "Bold",
  bold: "Bold",
  "800": "Extra Bold",
  "900": "Black",
}

/**
 * A move among siblings, as `writer.noteReorder` spells it: the note's words
 * and how the source changes. Front is the first child, the top row of the
 * Layers tree; back is the last.
 */
const MOVES: Record<string, { note: string; how: string }> = {
  front: { note: "Bring it to the front of its siblings", how: "so it is the first child of its parent" },
  forward: { note: "Bring it forward one place", how: "one place earlier, before the sibling now above it" },
  backward: { note: "Send it backward one place", how: "one place later, after the sibling now below it" },
  back: { note: "Send it to the back of its siblings", how: "so it is the last child of its parent" },
}

function moveWords(move: string): { note: string; how: string } {
  const sibling = /^before:(.+)$/.exec(move)?.[1]
  if (sibling) return { note: `Move it before ${sibling}`, how: `so it comes directly before its sibling ${sibling}` }
  return MOVES[move] ?? { note: `Move it: ${move}`, how: move }
}

/** `attribute:href` → `href`: a component prop previewed as a DOM attribute. */
export function attributeName(property: string): string | null {
  return /^attribute:(.+)$/.exec(property)?.[1] ?? null
}

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return `“${flat.length > MAX_QUOTE ? `${flat.slice(0, MAX_QUOTE - 1)}…` : flat}”`
}

function hex(channel: number): string {
  return Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0").toUpperCase()
}

/** `rgb(255, 0, 102)` → `#FF0066`; `rgba(0, 0, 0, 0.3)` → `#000000 at 30%`. Anything else as written. */
function colorWords(value: string): string {
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value.trim())
  if (!rgb) return /^#[\da-f]{3,8}$/i.test(value.trim()) ? value.trim().toUpperCase() : value
  const color = `#${hex(Number(rgb[1]))}${hex(Number(rgb[2]))}${hex(Number(rgb[3]))}`
  if (rgb[4] === undefined) return color
  const alpha = rgb[4].endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4])
  if (alpha >= 1) return color
  return alpha <= 0 ? "transparent" : `${color} at ${Math.round(alpha * 100)}%`
}

/** A value as the Design tab would show it. */
function valueWords(property: string, value: string): string {
  if (/color$/.test(property) || property === "background" || property === "color") return colorWords(value)
  if (property === "opacity") {
    const number = Number(value)
    return Number.isFinite(number) && value.trim() !== "" ? `${Math.round(number * 100)}%` : value
  }
  if (property === "font-weight") return FONT_WEIGHTS[value] ?? value
  if (property === "rotate") return value.replace(/^(-?[\d.]+)deg$/, "$1°")
  return value
}

/** `translate(4px, -2px)` → "4px right and 2px up", or null for anything else. */
function translateWords(value: string): string | null {
  const match = /^translate\(\s*(-?[\d.]+)px\s*(?:,\s*(-?[\d.]+)px\s*)?\)$/.exec(value.trim())
  if (!match) return null
  const x = Number(match[1])
  const y = Number(match[2] ?? 0)
  const parts = [
    x ? `${Math.abs(x)}px ${x > 0 ? "right" : "left"}` : null,
    y ? `${Math.abs(y)}px ${y > 0 ? "down" : "up"}` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(" and ") : null
}

function classList(value: string): string[] {
  return value.split(/\s+/).filter(Boolean)
}

function classDiff(edit: EditRecord): { added: string[]; removed: string[] } {
  const before = new Set(classList(edit.from))
  const after = new Set(classList(edit.to))
  return {
    added: [...after].filter((name) => !before.has(name)),
    removed: [...before].filter((name) => !after.has(name)),
  }
}

const NOT_SET = new Set(["", "none", "normal", "auto", "initial", "unset"])

/** One sentence for a CSS property change, in the panel's vocabulary. */
function styleSentence(property: string, from: string, to: string): string {
  if (property === "display") {
    if (to === "none") return "Hide this element"
    if (from === "none") return "Show this element"
    const flex = (value: string) => value === "flex" || value === "inline-flex"
    if (flex(to) && !flex(from)) return "Add auto layout"
    if (flex(from) && !flex(to) && to !== "grid") return "Remove auto layout"
    if (to === "grid" || to === "inline-grid") return "Lay out its children in a grid"
  }
  if (property === "visibility") return to === "hidden" ? "Hide this element, keeping its space" : "Show this element"
  if (property === "flex-direction") {
    if (to === "column") return "Stack its items vertically"
    if (to === "row") return "Lay out its items in a row"
    if (to === "column-reverse") return "Stack its items vertically, last first"
    if (to === "row-reverse") return "Lay out its items in a row, last first"
  }
  if (property === "flex-wrap") return to === "nowrap" ? "Keep its items on one line" : "Wrap its items onto new lines"
  if (property === "overflow") {
    if (to === "hidden" || to === "clip") return "Clip its content"
    if (to === "visible") return "Stop clipping its content"
    if (to === "auto" || to === "scroll") return "Let its content scroll"
  }
  if (property === "justify-content") {
    if (to === "space-between") return "Space its items apart (auto gap)"
    if (to === "center") return "Center its items along the layout"
    if (to === "flex-start" || to === "start") return "Pack its items at the start"
    if (to === "flex-end" || to === "end") return "Pack its items at the end"
  }
  if (property === "align-items") {
    if (to === "center") return "Center its items across the layout"
    if (to === "flex-start" || to === "start") return "Align its items to the start"
    if (to === "flex-end" || to === "end") return "Align its items to the end"
    if (to === "stretch") return "Stretch its items across the layout"
    if (to === "baseline") return "Align its items on the text baseline"
  }
  if (property === "text-align") {
    if (to === "center") return "Center the text"
    if (to === "left" || to === "start") return "Align the text left"
    if (to === "right" || to === "end") return "Align the text right"
    if (to === "justify") return "Justify the text"
  }
  if (property === "text-transform") {
    if (to === "uppercase") return "Make the text uppercase"
    if (to === "lowercase") return "Make the text lowercase"
    if (to === "capitalize") return "Capitalize each word"
    if (to === "none") return "Show the text as typed, with no case change"
  }
  if (property === "font-style") return to === "italic" ? "Make the text italic" : "Make the text upright, not italic"
  if (property === "text-decoration-line" || property === "text-decoration") {
    if (to.includes("underline")) return "Underline the text"
    if (to.includes("line-through")) return "Strike through the text"
    if (to === "none") return "Remove the text decoration"
  }
  if (property === "scale") {
    if (to === "-1 1") return "Flip it horizontally"
    if (to === "1 -1") return "Flip it vertically"
    if (to === "-1 -1") return "Flip it horizontally and vertically"
  }
  if (property === "transform") {
    const moved = translateWords(to)
    if (moved && NOT_SET.has(from)) return `Move it ${moved}`
    if (to === "none" || !to) return "Remove its transform"
  }
  if (property === "filter" || property === "backdrop-filter") {
    // A lone blur is what the Effects section writes: say it in its words.
    const blur = (value: string) => (NOT_SET.has(value) ? "" : /^blur\(([^()]+)\)$/.exec(value.trim())?.[1] ?? null)
    const before = blur(from)
    const after = blur(to)
    if (before !== null && after !== null) {
      const name = property === "filter" ? "layer blur" : "background blur"
      if (!after) return `Remove the ${name}`
      return before ? `Change the ${name} to ${after} (was ${before})` : `Add a ${name} of ${after}`
    }
  }
  if (property === "box-shadow") {
    if (NOT_SET.has(to)) return "Remove the shadow"
    if (NOT_SET.has(from)) return `Add a shadow: ${to}`
  }

  const name = NAMES[property] ?? property
  if (!to) return `Remove the ${name}${from ? ` (was ${valueWords(property, from)})` : ""}`
  if (!from) return `Set the ${name} to ${valueWords(property, to)}`
  return `Change the ${name} to ${valueWords(property, to)} (was ${valueWords(property, from)})`
}

/**
 * The note the editor writes for an edit: one plain sentence for the designer.
 *
 * Shown on the row in the Changes tab, on the pin, and as the `**Change:**`
 * line of the brief.
 */
export function editNoteText(edit: EditRecord): string {
  if (edit.property === "remove") return "Delete this element"
  if (edit.property === "reorder") return moveWords(edit.to).note
  if (edit.property === "text") {
    return edit.from ? `Change the text to ${quote(edit.to)} (was ${quote(edit.from)})` : `Set the text to ${quote(edit.to)}`
  }
  if (edit.property === "icon") {
    return edit.from ? `Swap the icon to ${edit.to} (was ${edit.from})` : `Swap the icon to ${edit.to}`
  }
  if (edit.property === "class") {
    const { added, removed } = classDiff(edit)
    if (added.length === 1 && removed.length === 1) return `Replace the class ${removed[0]} with ${added[0]}`
    const parts = [
      added.length ? `add ${added.join(" ")}` : null,
      removed.length ? `remove ${removed.join(" ")}` : null,
    ].filter(Boolean)
    if (!parts.length) return "Reorder its classes"
    return `Change its classes: ${parts.join(", ")}`
  }
  const attribute = attributeName(edit.property)
  if (attribute) {
    if (!edit.to) return `Remove the ${attribute} prop`
    return edit.from
      ? `Change the ${attribute} prop to ${edit.to} (was ${edit.from})`
      : `Set the ${attribute} prop to ${edit.to}`
  }
  return styleSentence(edit.property, edit.from, edit.to)
}

/**
 * The utility class Tailwind would write for a declaration, or null.
 *
 * The same translator the old Apply used, so the class named in the brief is
 * the one that compiles to the previewed value.
 */
export function utilityFor(property: string, value: string): string | null {
  if (!value) return null
  let update: ReturnType<typeof toClassUpdate>
  try {
    update = toClassUpdate(property, value)
  } catch {
    return null
  }
  if (!update) return null
  if (update.standalone) return update.tailwindToken ?? update.tailwindPrefix
  if (update.tailwindToken) return `${update.tailwindPrefix}-${update.tailwindToken}`
  return `${update.tailwindPrefix}-[${update.value}]`
}

/** The classes on the element, as it was before the edit, that set this property. */
function classesSetting(edit: EditRecord, property: string): string[] {
  return classList(edit.target?.className ?? "").filter((name) => {
    try {
      return propertyForClass(name) === property
    } catch {
      return false
    }
  })
}

function where(edit: EditRecord): string {
  const component = edit.target?.componentName
  return component ? `the JSX or template of <${component}> that renders this element` : "the source that renders this element"
}

/** How to write a CSS change in this project's styling, as bullet lines. */
function styleInstructions(edit: EditRecord): string[] {
  const { property, from, to } = edit
  const lines: string[] = []
  if (!to) lines.push(`Remove \`${property}\` from this element. It is \`${from}\` now.`)
  else if (!from) lines.push(`Set \`${property}: ${to}\` on this element. It is not set now.`)
  else lines.push(`Set \`${property}: ${to}\` on this element. It is \`${from}\` now.`)

  if (property === "transform" && translateWords(to)) {
    lines.push(
      `The designer dragged it ${translateWords(to)}. Get it there through the layout: margin, gap, padding, alignment or position. Do not leave a transform behind.`
    )
    return lines
  }

  if (config.host.tailwind) {
    const next = utilityFor(property, to)
    const current = classesSetting(edit, property)
    if (next && current.length) {
      lines.push(`Tailwind: replace ${current.map((name) => `\`${name}\``).join(" ")} with \`${next}\`.`)
    } else if (next) {
      lines.push(`Tailwind: add \`${next}\`.`)
    } else if (!to && current.length) {
      lines.push(`Tailwind: remove ${current.map((name) => `\`${name}\``).join(" ")}.`)
    }
    if (next?.includes("[")) {
      lines.push("If the theme has a token with this value, use the token in place of the arbitrary value.")
    }
  } else {
    lines.push("Write it the way this project already styles the element (its stylesheet, class or token), not as an inline style.")
  }
  return lines
}

/**
 * What the agent has to do for one edit, as markdown bullet lines.
 *
 * Exact where the sentence is friendly: the property and both values in code,
 * the class to write on a Tailwind host, and where the change belongs.
 */
export function editInstructions(edit: EditRecord): string[] {
  const place = `Edit ${where(edit)}.`
  if (edit.property === "remove") {
    return [`Delete this element from ${where(edit)}.`, "Remove any import, handler or state its removal leaves unused."]
  }
  if (edit.property === "reorder") {
    return [
      `Move this element in the source ${moveWords(edit.to).how}.`,
      "Change the order of the elements, not z-index or the CSS order property.",
      place,
    ]
  }
  if (edit.property === "text") {
    return [
      `Replace the text “${edit.from}” with “${edit.to}”.`,
      "If the copy comes from a prop, a variable, a translation file or a CMS, change it there. Keep the markup around it.",
    ]
  }
  if (edit.property === "icon") {
    return [`Swap the icon \`${edit.from || "unknown"}\` for \`${edit.to}\`, from the icon set the project already uses.`, place]
  }
  if (edit.property === "class") {
    const { added, removed } = classDiff(edit)
    return [
      `Make this element's class attribute \`${edit.to}\`. It is \`${edit.from || "empty"}\` now.`,
      ...(added.length ? [`Add: ${added.map((name) => `\`${name}\``).join(" ")}.`] : []),
      ...(removed.length ? [`Remove: ${removed.map((name) => `\`${name}\``).join(" ")}.`] : []),
      place,
    ]
  }
  const attribute = attributeName(edit.property)
  if (attribute) {
    return [
      edit.to
        ? `Pass \`${attribute}="${edit.to}"\` where this component is used${edit.from ? ` (it is \`${edit.from}\` now)` : ""}.`
        : `Stop passing \`${attribute}\` where this component is used.`,
      place,
    ]
  }
  return [...styleInstructions(edit), place]
}
