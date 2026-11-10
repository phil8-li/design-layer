/**
 * Fill — every paint on the layer, as Figma's paint rows.
 *
 * A box has at most two paints CSS will name: `background-color` and, when the
 * element holds text of its own, `color`. Figma calls a text layer's colour its
 * fill, so both live here, background first: the section lists what the layer
 * paints, and Typography no longer carries a Color group.
 *
 * Each row's value cell is the token field when the design system stocks the
 * axis, so the binding is the answer this row asks for rather than a second
 * row further down. With nothing stocked it is an editable hex.
 *
 * `svg-fill` cannot join a row. It paints the `<svg>` INSIDE the selected
 * button, so it writes to a different element; it stays a captioned row under
 * the paints, in every state, because an icon button almost never has a
 * background of its own.
 */

import { el } from "../../core/dom"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { alphaOf, closeThen, declineOpacity, emptyPaintSection, paintRow, withAlpha } from "./color"
import { miniButton } from "./field"
import { styledSection } from "../../options/panel"
import { directText, svgTarget, tokenControl, tokenHints, tokenRow } from "./token-row"
import { computedOf, isMulti, mixedPaintSection, sectionWriters, selectedOf, sharedValue, writeEach } from "./multi"
import { parkedPaints } from "./parked-paint"
import type { InspectorSection } from "./index"

const DEFAULT_FILL = "#d9d9d9"

/** Colours the eye parked, per layer: the background and the text colour apart. */
const parkedFill = parkedPaints<string>("fill")
const parkedText = parkedPaints<string>("text")

function isPainted(color: string): boolean {
  return color !== "transparent" && alphaOf(color) > 0
}

/** One spelling for "paints nothing", so transparent and a zero-alpha colour agree. */
const paintOf = (color: string): string => (isPainted(color) ? color : "none")

export const fillSection: InspectorSection = (context) => {
  const { selection, computed, writer, invalidate } = context
  const element = selection.element
  const layers = selectedOf(context)
  const { commit, preview } = sectionWriters(context)
  const write = (property: string, value: string, summary: string) => commit([{ property, value }], summary)

  const background = computed.backgroundColor
  const painted = isPainted(background)
  const storedFill = parkedFill.get(selection)
  const hasFill = painted || storedFill !== undefined

  /*
   * Figma's mixed fill: when the selected layers paint differently, the body
   * is one hint and `+` gives every layer the one default fill. The text row
   * counts only when every layer has text of its own, the same gate that
   * decides whether the row is drawn.
   */
  const allText = selectedOf(context).every((entry) => directText(entry.element))
  const backgroundMixed = isMulti(context) && sharedValue(context, (style) => paintOf(style.backgroundColor)) === null
  const textMixed = isMulti(context) && allText && sharedValue(context, (style) => style.color) === null
  const mixed = backgroundMixed || textMixed

  const add = miniButton({
    label: hasFill && !mixed ? "Fill already set" : "Add fill",
    glyph: icon("Plus", tokens.icon.marker),
    onClick: () => {
      parkedFill.drop(layers)
      if (textMixed) parkedText.drop(layers)
      // A text colour cannot be removed, so replacing mixed ones settles on the
      // primary's rather than inventing one.
      const writes = [
        ...(backgroundMixed || !mixed ? [{ property: "background-color", value: DEFAULT_FILL }] : []),
        ...(textMixed ? [{ property: "color", value: computed.color }] : []),
      ]
      writer.applyStyles(selection, writes, "Add fill")
      invalidate()
    },
  })
  if (hasFill && !mixed) add.setAttribute("disabled", "")

  if (mixed) return mixedPaintSection(context, "fill", "Fill", add)

  const svg = svgTarget(context)
  const svgFill = svg
    ? tokenRow(context, "svg-fill", "SVG fill", { target: svg, computed: getComputedStyle(svg.element) })
    : null

  const rows: Array<Node | null> = []

  if (hasFill) {
    const value = painted ? background : (storedFill as string)
    /*
     * While parked, the element's background is the `transparent` the eye
     * wrote, so the binding is handed the parked colour as its evidence and
     * the row describes one paint in every cell.
     */
    const evidence = painted ? {} : { inlineValue: "", computedValue: value }
    rows.push(
      paintRow({
        id: "fill",
        label: "Fill color",
        value,
        live: painted,
        binding: tokenControl(context, "fill-color", "Fill color", { ...evidence, hidePreview: true }),
        onColor: (next) => {
          // The well hands back an opaque hex; keep the alpha the row already had.
          const color = withAlpha(next, alphaOf(value)) ?? next
          parkedFill.drop(layers)
          write("background-color", color, "Set fill")
        },
        alpha: {
          onPreview: (alpha) => {
            const next = withAlpha(value, alpha)
            if (next) preview([{ property: "background-color", value: next }])
          },
          onCommit: (alpha) => {
            const next = withAlpha(value, alpha)
            if (next) write("background-color", next, "Set fill opacity")
            else declineOpacity(context.editor, value)
          },
        },
        visibility: {
          onToggle: () => {
            if (painted) {
              // Each layer parks its own colour, so Show gives each its own back.
              for (const layer of layers) parkedFill.set(layer, computedOf(context, layer).backgroundColor)
              write("background-color", "transparent", "Hide fill")
              return
            }
            const own = (layer: typeof selection) => parkedFill.get(layer) ?? value
            writeEach(context, "Show fill", (layer) => [
              { property: "background-color", value: withAlpha(own(layer), alphaOf(own(layer))) ?? own(layer) },
            ])
            parkedFill.drop(layers)
            invalidate()
          },
        },
        remove: {
          label: "Remove fill",
          onClick: (event) => {
            parkedFill.drop(layers)
            closeThen(event, () => write("background-color", "transparent", "Remove fill"))
          },
        },
      }),
      tokenHints(context, "fill-color", "Fill color", evidence)
    )
  }

  /*
   * The text colour, under the background, for any element with text of its
   * own. A text layer with no background is not an empty Fill: this row is
   * its fill, as in Figma.
   *
   * No `−`: CSS text always has a colour, so "remove" would have to invent
   * one. The eye parks it as `transparent`, which is what Figma's eye does.
   */
  if (directText(element) && allText) {
    const textColor = computed.color
    const shown = isPainted(textColor)
    const storedText = parkedText.get(selection)
    const value = shown || storedText === undefined ? textColor : storedText
    const evidence = shown || storedText === undefined ? {} : { inlineValue: "", computedValue: value }
    rows.push(
      paintRow({
        id: "text",
        label: "Text color",
        value,
        live: shown || storedText === undefined,
        binding: tokenControl(context, "text-color", "Text color", { ...evidence, hidePreview: true }),
        // The id Typography's colour field carried, so focus and tests find it.
        hexId: "type.color",
        onColor: (next) => {
          const color = withAlpha(next, alphaOf(value)) ?? next
          parkedText.drop(layers)
          write("color", color, "Set text color")
        },
        alpha: {
          onPreview: (alpha) => {
            const next = withAlpha(value, alpha)
            if (next) preview([{ property: "color", value: next }])
          },
          onCommit: (alpha) => {
            const next = withAlpha(value, alpha)
            if (next) write("color", next, "Set text opacity")
            else declineOpacity(context.editor, value)
          },
        },
        visibility: {
          onToggle: () => {
            if (storedText === undefined) {
              for (const layer of layers) parkedText.set(layer, computedOf(context, layer).color)
              write("color", "transparent", "Hide text color")
              return
            }
            const own = (layer: typeof selection) => parkedText.get(layer) ?? value
            writeEach(context, "Show text color", (layer) => [
              { property: "color", value: withAlpha(own(layer), alphaOf(own(layer))) ?? own(layer) },
            ])
            parkedText.drop(layers)
            invalidate()
          },
        },
        remove: null,
      }),
      tokenHints(context, "text-color", "Text color", evidence)
    )
  }

  if (!rows.length) return emptyPaintSection(context, "fill", "Fill", add, [svgFill])

  return styledSection(context, "fill", "Fill", el("div", { class: "de-stack" }, [...rows, svgFill]), add)
}
