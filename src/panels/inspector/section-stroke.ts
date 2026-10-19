/**
 * Stroke — the border, as Figma's paint row plus a Style / Weight row.
 *
 * Row 1 is the colour, built exactly like a fill. Row 2 is [style] [weight]
 * with the "Individual strokes" toggle in column 3, which opens per-side
 * widths underneath. Figma's first column is Position (inside / center /
 * outside); a CSS border has no position, so the column holds the honest
 * `border-style` select instead.
 *
 * The eye parks the stroke by zeroing its widths and remembering all four.
 *
 * Three more edges live here because Stroke is the section about lines drawn
 * around the box, and none of them is the border:
 *
 *   - `ring-color` — in Tailwind v4 a ring is a box-shadow, not a border.
 *   - `outline-color` — `outline` is painted outside the box and takes no space.
 *   - `svg-stroke` — paints the `<svg>` INSIDE the selected button.
 *
 * They are drawn in every state, because a ring, an outline and an icon's
 * stroke do not depend on whether the element has a border.
 */

import { el, round } from "../../core/dom"
import { leaveRow, revealGroup } from "../../core/leave"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { alphaOf, emptyPaintSection, paintRow, toHex, withAlpha } from "./color"
import {
  isExpanded,
  miniButton,
  numberField,
  propRow,
  selectField,
  setExpanded,
  takeJustExpanded,
  trailingToggle,
} from "./field"
import { styledSection } from "../../options/panel"
import { hasBorder, hasOutline, hasRing, SIDES, svgTarget, tokenControl, tokenHints, tokenRow } from "./token-row"
import { MIXED, isMulti, mixedNumber, mixedPaintSection, sharedValue } from "./multi"
import type { InspectorSection } from "./index"

const STYLES = ["solid", "dashed", "dotted", "double"] as const
const DEFAULT_STROKE = "#000000"
const SIDES_EXPANDER = "stroke.sides"
const SIDE_GLYPHS = { top: "PadTop", right: "PadRight", bottom: "PadBottom", left: "PadLeft" } as const

/** Widths parked by the eye, per side, keyed by element — see the Fill section's note. */
const parked = new Map<string, number[]>()

const widthsOf = (style: CSSStyleDeclaration) =>
  SIDES.map((side) => Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0)

/** What a layer's stroke paints: its colour while a border shows, else nothing. */
const paintOf = (style: CSSStyleDeclaration): string =>
  Math.max(...widthsOf(style)) > 0 && style.borderTopStyle !== "none" ? style.borderTopColor : "none"

export const strokeSection: InspectorSection = (context) => {
  const { selection, computed, writer, invalidate } = context
  const element = selection.element
  const widths = widthsOf(computed)
  const width = Math.max(...widths)
  const style = computed.borderTopStyle
  const visible = width > 0 && style !== "none"
  const stored = parked.get(selection.key)
  // Layers that paint different strokes get Figma's hint and a `+` that gives
  // them all one; matching strokes get the normal rows, written to all.
  const mixed = isMulti(context) && sharedValue(context, paintOf) === null

  const applyStyles = (writes: Array<{ property: string; value: string }>, summary: string) => {
    writer.applyStyles(selection, writes, summary)
    invalidate()
  }

  const add = miniButton({
    label: mixed ? "Add stroke" : visible || stored ? "Stroke already set" : "Add stroke",
    glyph: icon("Plus", tokens.icon.marker),
    onClick: () => {
      parked.delete(selection.key)
      applyStyles(
        [
          { property: "border-width", value: "1px" },
          { property: "border-color", value: toHex(computed.borderTopColor) ?? DEFAULT_STROKE },
          // Without Tailwind's preflight a border's style is `none`, and a width
          // alone paints nothing.
          // Replacing mixed strokes writes it always: another layer may have none.
          ...(style === "none" || mixed ? [{ property: "border-style", value: "solid" }] : []),
        ],
        "Add stroke"
      )
    },
  })
  if ((visible || stored) && !mixed) add.setAttribute("disabled", "")

  const svg = svgTarget(context)
  const edges = [
    hasRing(element, computed) ? tokenRow(context, "ring-color", "Ring color") : null,
    hasOutline(element, computed) ? tokenRow(context, "outline-color", "Outline color") : null,
    svg
      ? tokenRow(context, "svg-stroke", "SVG stroke", { target: svg, computed: getComputedStyle(svg.element) })
      : null,
  ]

  if (mixed) return mixedPaintSection(context, "stroke", "Stroke", add)

  if (!visible && !stored) {
    /*
     * `hasBorder` also counts a `border*` utility, so an element whose border
     * comes from a class this page has not resolved still offers the token
     * that would name its colour.
     */
    return emptyPaintSection(context, "stroke", "Stroke", add, [
      hasBorder(element, computed) ? tokenRow(context, "stroke-color", "Stroke color") : null,
      ...edges,
    ])
  }

  const shown = visible ? widths : (stored as number[])
  const color = computed.borderTopColor
  // The eye zeroes the widths and leaves the colour, so the binding reads the
  // live value whether the stroke is shown or not.
  const evidence = { computedValue: color }

  const paint = paintRow({
    id: "stroke",
    label: "Stroke color",
    value: color,
    live: visible,
    binding: tokenControl(context, "stroke-color", "Stroke color", { ...evidence, hidePreview: true }),
    onColor: (next) =>
      applyStyles([{ property: "border-color", value: withAlpha(next, alphaOf(color)) ?? next }], "Set stroke color"),
    alpha: {
      onPreview: (alpha) => {
        const preview = withAlpha(color, alpha)
        if (preview) element.style.setProperty("border-color", preview)
      },
      onCommit: (alpha) => {
        const next = withAlpha(color, alpha)
        if (next) applyStyles([{ property: "border-color", value: next }], "Set stroke opacity")
        else context.editor.toast(`Opacity needs a plain color. ${color} is kept as written.`, "error")
      },
    },
    visibility: {
      onToggle: () => {
        if (visible) {
          parked.set(selection.key, widths)
          applyStyles([{ property: "border-width", value: "0px" }], "Hide stroke")
          return
        }
        parked.delete(selection.key)
        applyStyles(
          SIDES.map((side, at) => ({ property: `border-${side}-width`, value: `${round(shown[at])}px` })),
          "Show stroke"
        )
      },
    },
    remove: {
      label: "Remove stroke",
      onClick: (event) => {
        parked.delete(selection.key)
        const row = (event.currentTarget as HTMLElement).closest(".de-prow")
        const write = () => applyStyles([{ property: "border-width", value: "0px" }], "Remove stroke")
        const closing = row instanceof HTMLElement ? leaveRow(row) : null
        if (closing) void closing.then(write)
        else write()
      },
    },
  })

  const perSide = isExpanded(SIDES_EXPANDER)
  const uniformOf = (values: number[]) => (values.every((value) => value === values[0]) ? round(values[0]) : NaN)
  const sharedWeight = isMulti(context) ? sharedValue(context, (entry) => uniformOf(widthsOf(entry))) : null
  const uniform = isMulti(context)
    ? sharedWeight === null || Number.isNaN(sharedWeight)
      ? null
      : sharedWeight
    : shown.every((value) => value === shown[0])
      ? shown[0]
      : null
  const sharedStyle = sharedValue(context, (entry) => entry.borderTopStyle)
  const sideValues = SIDES.map((_, at) =>
    isMulti(context) ? sharedValue(context, (entry) => round(widthsOf(entry)[at])) : shown[at]
  )

  const weight = numberField({
    id: "stroke.width",
    label: "W",
    title: "Stroke weight",
    value: uniform,
    placeholder: uniform === null ? "Mixed" : undefined,
    min: 0,
    disabled: !visible,
    onPreview: (value) => element.style.setProperty("border-width", `${round(value)}px`),
    onCommit: (value) => applyStyles([{ property: "border-width", value: `${round(value)}px` }], "Set stroke weight"),
  })

  const styleRow = propRow({
    id: "stroke.style-weight",
    caption: ["Style", "Weight"],
    cells: [
      selectField({
        id: "stroke.style",
        label: "Stroke style",
        value: sharedStyle === null ? "" : STYLES.includes(style as (typeof STYLES)[number]) ? style : "solid",
        placeholder: MIXED,
        options: STYLES.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
        onCommit: (next) => applyStyles([{ property: "border-style", value: next }], `Set border style ${next}`),
      }),
      weight,
    ],
    trailing: trailingToggle({
      label: "Individual strokes",
      glyph: icon("IndividualSides", tokens.icon.action),
      pressed: perSide,
      onClick: () => {
        setExpanded(SIDES_EXPANDER, !perSide)
        invalidate()
      },
    }),
  })

  const sideField = (at: number) => {
    const side = SIDES[at]
    return numberField({
      id: `stroke.width.${side}`,
      label: icon(SIDE_GLYPHS[side], tokens.icon.action),
      title: `Stroke ${side}`,
      ...mixedNumber(sideValues[at]),
      min: 0,
      disabled: !visible,
      onPreview: (value) => element.style.setProperty(`border-${side}-width`, `${round(value)}px`),
      onCommit: (value) =>
        applyStyles([{ property: `border-${side}-width`, value: `${round(value)}px` }], `Set stroke ${side}`),
    })
  }
  // Figma's reading order: Top, Right on the first row; Bottom, Left under it.
  const sides = perSide
    ? el("div", { class: "de-stroke-sides" }, [
        propRow({ id: "stroke.sides.1", cells: [sideField(0), sideField(1)] }),
        propRow({ id: "stroke.sides.2", cells: [sideField(2), sideField(3)] }),
      ])
    : null
  if (sides && takeJustExpanded(SIDES_EXPANDER)) revealGroup(sides)

  const body = el("div", { class: "de-stack" }, [
    paint,
    tokenHints(context, "stroke-color", "Stroke color", evidence),
    el("div", { class: "de-stroke-geometry" }, [styleRow, sides]),
    ...edges,
  ])

  return styledSection(context, "stroke", "Stroke", body, add)
}
