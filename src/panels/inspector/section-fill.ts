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
import { leaveRow } from "../../core/leave"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { alphaOf, emptyPaintSection, paintRow, withAlpha } from "./color"
import { miniButton } from "./field"
import { styledSection } from "../../options/panel"
import { directText, svgTarget, tokenControl, tokenHints, tokenRow } from "./token-row"
import { isMulti, mixedPaintSection, selectedOf, sharedValue } from "./multi"
import type { InspectorSection } from "./index"

const DEFAULT_FILL = "#d9d9d9"

/**
 * Colours parked by the eye, keyed by element (and `:text` for the text row).
 * Panel-level, not DOM-level: the inspector is rebuilt on every write, and the
 * point of the eye is that the value survives being switched off.
 */
const parked = new Map<string, string>()

function isPainted(color: string): boolean {
  return color !== "transparent" && alphaOf(color) > 0
}

/** One spelling for "paints nothing", so transparent and a zero-alpha colour agree. */
const paintOf = (color: string): string => (isPainted(color) ? color : "none")

/** Closes the row the `−` sits in before the rebuild that drops it. */
function closeThen(event: Event, write: () => void): void {
  const row = (event.currentTarget as HTMLElement).closest(".de-prow")
  const closing = row instanceof HTMLElement ? leaveRow(row) : null
  if (closing) void closing.then(write)
  else write()
}

export const fillSection: InspectorSection = (context) => {
  const { selection, computed, writer, invalidate } = context
  const element = selection.element

  const write = (property: string, value: string, summary: string) => {
    writer.applyStyles(selection, [{ property, value }], summary)
    invalidate()
  }
  const declined = (value: string) =>
    context.editor.toast(`Opacity needs a plain color. ${value} is kept as written.`, "error")

  const background = computed.backgroundColor
  const painted = isPainted(background)
  const storedFill = parked.get(selection.key)
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
      for (const entry of selectedOf(context)) {
        parked.delete(entry.key)
        if (textMixed) parked.delete(`${entry.key}:text`)
      }
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
          parked.delete(selection.key)
          write("background-color", color, "Set fill")
        },
        alpha: {
          onPreview: (alpha) => {
            const preview = withAlpha(value, alpha)
            if (preview) element.style.setProperty("background-color", preview)
          },
          onCommit: (alpha) => {
            const next = withAlpha(value, alpha)
            if (next) write("background-color", next, "Set fill opacity")
            else declined(value)
          },
        },
        visibility: {
          onToggle: () => {
            if (painted) {
              parked.set(selection.key, value)
              write("background-color", "transparent", "Hide fill")
              return
            }
            parked.delete(selection.key)
            write("background-color", withAlpha(value, alphaOf(value)) ?? value, "Show fill")
          },
        },
        remove: {
          label: "Remove fill",
          onClick: (event) => {
            parked.delete(selection.key)
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
    const textKey = `${selection.key}:text`
    const textColor = computed.color
    const shown = isPainted(textColor)
    const storedText = parked.get(textKey)
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
          parked.delete(textKey)
          write("color", color, "Set text color")
        },
        alpha: {
          onPreview: (alpha) => {
            const preview = withAlpha(value, alpha)
            if (preview) element.style.setProperty("color", preview)
          },
          onCommit: (alpha) => {
            const next = withAlpha(value, alpha)
            if (next) write("color", next, "Set text opacity")
            else declined(value)
          },
        },
        visibility: {
          onToggle: () => {
            if (storedText === undefined) {
              parked.set(textKey, value)
              write("color", "transparent", "Hide text color")
              return
            }
            parked.delete(textKey)
            write("color", withAlpha(value, alphaOf(value)) ?? value, "Show text color")
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
