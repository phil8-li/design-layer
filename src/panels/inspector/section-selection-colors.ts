/**
 * Selection colors — every colour the selection paints, one row per colour.
 *
 * Figma's section of the same name, after Effects. It answers a question no
 * other section can: Fill and Stroke describe the primary layer, while this
 * reads the whole selection and everything inside it, so a card's white
 * background and its button's white label are one row, and changing that row
 * recolours both.
 *
 * A group is one colour value (hex plus alpha). Each member is an element and
 * the property it paints with, so an edit writes `background-color` where the
 * colour was a background and `color` where it was text, in ONE batch: one
 * undo step and one outbox row for one decision.
 *
 * SVG paints are read off the `<svg>` root, not off its shapes. The root is
 * the layer the editor can select and write (a `<path>` is not a
 * `LayerElement`), and it is where icon sets put `fill`/`stroke`. A root only
 * counts when one of its shapes actually paints that value, because every
 * `<svg>` inherits `fill: black` whether it uses it or not.
 */

import type { DesignSystemToken } from "../../core/config"
import {
  authoredTokenMatches,
  computedTokenMatches,
  landedValue,
  normalizedCssValue,
  tokenDisplayName,
  tokenNameParts,
  tokenStyleWrites,
  tokenSwatchCss,
  tokensForProperty,
  type DesignTokenProperty,
} from "../../core/design-system"
import { el } from "../../core/dom"
import { toSourceRef } from "../../core/bridge"
import { elementKey } from "../../core/store"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { activeDesignSystem } from "../../libraries/store"
import type { LayerElement, Selection } from "../../core/types"
import type { StyleBatchEdit } from "../../core/writer"
import { alphaOf, paintRow, toHex, withAlpha } from "./color"
import { miniButton, section } from "./field"
import { directText, SIDES } from "./token-row"
import { tokenField, type TokenChoice } from "./token-picker"
import type { InspectorSection, SectionContext } from "./index"

const TITLE = "Selection colors"
/** Elements read per render. A page section can hold thousands; the panel rebuilds on every commit. */
const WALK_LIMIT = 300
/** More rows than this and the section arrives folded, showing the summary instead. */
const UNFOLDED_MAX = 4
const SUMMARY_CHITS = 3
const SHAPES = "path, rect, circle, ellipse, line, polyline, polygon, text, use"

export interface ColorMember {
  element: LayerElement
  /** The CSS property this element paints the colour with. */
  property: string
}

export interface ColorGroup {
  /** Hex plus alpha, or the raw string for a colour hex cannot hold. */
  key: string
  /** The colour as computed on the first member. */
  value: string
  members: ColorMember[]
}

function painted(color: string): boolean {
  const value = color.trim()
  if (!value || value === "transparent" || value === "none") return false
  // `url(#gradient)` and keywords are not a colour this row can show or write.
  if (/^url\(/i.test(value)) return false
  return alphaOf(value) > 0
}

function groupKey(color: string): string {
  const hex = toHex(color)
  return hex ? `${hex}/${Math.round(alphaOf(color) * 100)}` : color.trim()
}

function widthOf(computed: CSSStyleDeclaration, side: string): number {
  const parsed = Number.parseFloat(computed.getPropertyValue(`border-${side}-width`))
  return Number.isFinite(parsed) ? parsed : 0
}

/** The colours one element paints, as `[property, value]` pairs. */
function paintsOf(element: LayerElement): Array<[string, string]> {
  const computed = getComputedStyle(element)
  const out: Array<[string, string]> = []
  if (element instanceof SVGSVGElement) {
    const shapes = Array.from(element.querySelectorAll(SHAPES))
    for (const property of ["fill", "stroke"]) {
      const value = computed.getPropertyValue(property).trim()
      if (!painted(value)) continue
      if (shapes.some((shape) => getComputedStyle(shape).getPropertyValue(property).trim() === value)) {
        out.push([property, value])
      }
    }
    return out
  }
  const background = computed.backgroundColor
  if (painted(background)) out.push(["background-color", background])
  if (directText(element) && painted(computed.color)) out.push(["color", computed.color])
  /*
   * Four sides of one colour are one `border-color`, so the source gains one
   * class rather than four. Sides that differ keep their own longhand, or a
   * recolour of the top would repaint the other three.
   */
  const sides = SIDES.filter((side) => widthOf(computed, side) > 0).map(
    (side) => [side, computed.getPropertyValue(`border-${side}-color`).trim()] as const
  )
  const visible = sides.filter(([, value]) => painted(value))
  if (visible.length === 4 && visible.every(([, value]) => value === visible[0][1])) {
    out.push(["border-color", visible[0][1]])
  } else {
    for (const [side, value] of visible) out.push([`border-${side}-color`, value])
  }
  return out
}

function isChrome(element: Element): boolean {
  return element.hasAttribute("data-designlayer")
}

/**
 * Every colour painted by the selection and its descendants, primary first,
 * then document order. Exported for the suite.
 */
export function collectSelectionColors(roots: LayerElement[]): ColorGroup[] {
  const groups = new Map<string, ColorGroup>()
  const seen = new Set<Element>()
  let budget = WALK_LIMIT
  const visit = (element: LayerElement) => {
    if (budget <= 0 || seen.has(element) || isChrome(element)) return
    seen.add(element)
    budget -= 1
    for (const [property, value] of paintsOf(element)) {
      const key = groupKey(value)
      const group = groups.get(key) ?? { key, value, members: [] }
      group.members.push({ element, property })
      groups.set(key, group)
    }
    // An `<svg>` was read whole above; its shapes are not layers.
    if (element instanceof SVGSVGElement) return
    for (const child of Array.from(element.children)) {
      if (child instanceof HTMLElement || child instanceof SVGSVGElement) visit(child)
    }
  }
  for (const root of roots) visit(root)
  return [...groups.values()]
}

/** The token axis a member's property belongs to, for the token write and the match. */
function axisOf(property: string): DesignTokenProperty {
  if (property === "background-color") return "fill-color"
  if (property === "color") return "text-color"
  if (property === "fill") return "svg-fill"
  if (property === "stroke") return "svg-stroke"
  return "stroke-color"
}

function describe(context: SectionContext, element: LayerElement): Selection {
  const picked = (context.selections ?? [context.selection]).find((entry) => entry.element === element)
  if (picked) return picked
  const info = context.editor.bridge?.elementInfo(element) ?? null
  const componentName = info?.componentName || element.tagName.toLowerCase()
  return {
    element,
    tagName: element.tagName.toLowerCase(),
    componentName,
    source: toSourceRef(info),
    key: elementKey(element, componentName, info?.lineNumber ?? 0),
  }
}

/** One batch, one element per entry, each with every property it paints in this group. */
function batchFor(
  context: SectionContext,
  group: ColorGroup,
  valueFor: (member: ColorMember) => string
): StyleBatchEdit[] {
  const byElement = new Map<LayerElement, StyleBatchEdit>()
  for (const member of group.members) {
    const edit = byElement.get(member.element) ?? { selection: describe(context, member.element), writes: [] }
    edit.writes.push({ property: member.property, value: valueFor(member) })
    byElement.set(member.element, edit)
  }
  return [...byElement.values()]
}

/** The token every member is bound to, or "" when they disagree or none is certain. */
function boundToken(group: ColorGroup): string {
  let bound: string | null = null
  for (const member of group.members) {
    const axis = axisOf(member.property)
    const style = getComputedStyle(member.element)
    const inline = member.element.style.getPropertyValue(member.property)
    let matches = authoredTokenMatches(axis, inline, Array.from(member.element.classList))
    if (!matches.length) {
      matches = computedTokenMatches(
        axis,
        inline.trim() || style.getPropertyValue(member.property).trim(),
        activeDesignSystem(),
        (variable) => {
          const raw = style.getPropertyValue(variable).trim()
          return raw ? normalizedCssValue(axis, raw) : ""
        },
        (literal) => normalizedCssValue(axis, literal)
      )
    }
    const id = matches.length === 1 && !matches[0].ambiguous ? matches[0].token.id : ""
    if (!id || (bound !== null && bound !== id)) return ""
    bound = id
  }
  return bound ?? ""
}

/**
 * The token field for one group, or null when the project stocks no colours.
 *
 * Each member gets the write its own axis would make — the Fill, Stroke and
 * Typography bindings call the same `tokenStyleWrites` and `landedValue` — with
 * the property kept as the member's, so a per-side border stays per side.
 */
function tokenBinding(
  group: ColorGroup,
  index: number,
  commit: (summary: string, valueFor: (member: ColorMember) => string) => void,
  commitRaw: (raw: string) => void
): HTMLElement | null {
  const stocked = tokensForProperty("fill-color")
  if (!stocked.length) return null
  const writeOf = (token: DesignSystemToken, member: ColorMember) => {
    const [write] = tokenStyleWrites(axisOf(member.property), token)
    return write ? landedValue(write, getComputedStyle(member.element)) : null
  }
  const writable = (token: DesignSystemToken) => tokenStyleWrites("fill-color", token).length > 0
  const choices: TokenChoice[] = stocked.map((token) => {
    const { group: path, leaf } = tokenNameParts(token)
    const css = tokenSwatchCss(token)
    return {
      id: token.id,
      group: path,
      leaf,
      name: tokenDisplayName(token),
      preview: css ? { kind: "color", css } : { kind: "none" },
      detail: "",
      disabled: !writable(token),
    }
  })
  return tokenField({
    id: `selcolor.${index}.token`,
    title: "Selection color",
    hidePreview: true,
    selectedId: boundToken(group),
    choices,
    fallback: {
      preview: { kind: "color", css: group.value },
      text: toHex(group.value)?.slice(1).toUpperCase() ?? group.value,
    },
    onCommit: (id) => {
      const token = stocked.find((entry) => entry.id === id)
      if (!token || !writable(token)) return
      commit(`Apply ${tokenDisplayName(token)}`, (member) => writeOf(token, member) ?? group.value)
    },
    custom: { placeholder: "#0a0a0a", onCommit: commitRaw },
  })
}

function colorRow(context: SectionContext, group: ColorGroup, index: number): HTMLElement {
  const alpha = alphaOf(group.value)
  const commit = (summary: string, valueFor: (member: ColorMember) => string) => {
    context.writer.applyStylesBatch(batchFor(context, group, valueFor), summary)
    context.invalidate()
  }
  const recolor = (next: string) => {
    // The well hands back an opaque hex; keep the alpha the group already had.
    const color = withAlpha(next, alpha) ?? next
    commit("Set selection color", () => color)
  }
  const elements = [...new Set(group.members.map((member) => member.element))]

  const select = miniButton({
    label: "Select layers with this color",
    glyph: icon("Target", tokens.icon.action),
    onClick: () => {
      const { editor } = context
      if (typeof editor.selectMany === "function") {
        editor.selectMany(elements)
        return
      }
      editor.select(elements[0])
      for (const element of elements.slice(1)) editor.select(element, { additive: true })
    },
  })

  const row = paintRow({
    id: `selcolor.${index}`,
    label: "Selection color",
    value: group.value,
    live: true,
    binding: tokenBinding(group, index, commit, (raw) => commit("Set selection color", () => raw)),
    hexId: `selcolor.${index}.hex`,
    onColor: recolor,
    alpha: {
      onPreview: (next) => {
        const preview = withAlpha(group.value, next)
        if (!preview) return
        for (const member of group.members) member.element.style.setProperty(member.property, preview)
      },
      onCommit: (next) => {
        const color = withAlpha(group.value, next)
        if (color) commit("Set selection color opacity", () => color)
        else context.editor.toast(`Opacity needs a plain color. ${group.value} is kept as written.`, "error")
      },
    },
    remove: null,
  })
  row.classList.add("de-selcolor-row")
  // `paintRow` keeps column 3 for a remove; this row's trailing action is the select.
  row.append(el("div", { class: "de-prow-trail" }, [select]))
  return row
}

/** Up to three chits and `+N`, for the folded header. */
function summary(groups: ColorGroup[]): HTMLElement {
  const chits = groups.slice(0, SUMMARY_CHITS).map((group) =>
    el("span", { class: "de-selcolor-chit", style: `background:${group.value}` })
  )
  const more = groups.length - SUMMARY_CHITS
  return el("span", { class: "de-selcolor-summary", "aria-hidden": "true" }, [
    ...chits,
    more > 0 ? el("span", { class: "de-selcolor-more" }, [`+${more}`]) : null,
  ])
}

export const selectionColorsSection: InspectorSection = (context) => {
  const picked = context.selections?.length ? context.selections : [context.selection]
  const groups = collectSelectionColors(picked.map((entry) => entry.element))
  // Figma adds nothing for one plain rectangle: its single colour is the Fill row.
  if (!groups.length || (groups.length < 2 && picked.length < 2)) return null

  const body = el("div", { class: "de-stack" }, groups.map((group, index) => colorRow(context, group, index)))
  // Folded above four colours until the user presses the header; `section()`
  // keeps that a default, so their choice wins once they make one.
  const node = section(TITLE, body, summary(groups), groups.length > UNFOLDED_MAX)
  node.classList.add("de-selcolor-section")
  return node
}
