/**
 * Stroke — the border, as Figma's paint row plus weight and style.
 *
 * One row, because CSS carries one border colour. The eye parks the stroke by
 * zeroing its width and remembering what it was, which is the affordance the
 * old single "border width" field had no way to offer.
 *
 * ## The token binding is IN the paint row, and three more axes came with it
 *
 * `stroke-color` was a second row in a `Design system` section further down the
 * panel, asking about the same border colour this row already shows and
 * answering in a different shape. It is now the row's middle cell: an inert
 * `<span>` printing the hex became the field that prints the BOUND STYLE'S NAME
 * when there is one and the same hex when there is not. Figma's paint rows read
 * exactly that way, and it is why the section never needed a twin.
 *
 * Three axes arrived that have no control here to fold into, so each keeps a
 * captioned block of its own:
 *
 *   - `ring-color` — in Tailwind v4 a ring is a box-shadow, not a border.
 *   - `outline-color` — `outline` is painted outside the box and takes no space.
 *   - `svg-stroke` — paints the `<svg>` INSIDE the selected button, not the
 *     button, so it writes to a different element entirely.
 *
 * None of the three IS the border, and Figma has a row for none of them. They
 * are here because Stroke is the section about lines drawn around the box, and
 * every other home is worse: Appearance is about the box's own surface, Effects
 * is about what the box casts, and a section of their own would be three rows
 * restating "this is also an edge". A designer who wants to recolour the ring on
 * a focused input looks where the other edge lives.
 *
 * They are also built BEFORE the no-stroke return and drawn in both states. A
 * ring, an outline and an icon's stroke are entirely independent of whether the
 * element has a border — gating them on one would hide the ring picker from
 * every ringed, borderless card in the app.
 */

import { el, round } from "../../core/dom"
import { leaveRow } from "../../core/leave"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { swatch, toHex } from "./color"
import { miniButton, numberField, selectField } from "./field"
import { styledSection } from "../../options/panel"
import { hasBorder, hasOutline, hasRing, svgTarget, tokenControl, tokenHints, tokenRow } from "./token-row"
import type { InspectorSection } from "./index"

const STYLES = ["solid", "dashed", "dotted", "double"] as const
const STYLE_CLASSES = STYLES.map((style) => `border-${style}`)
const DEFAULT_STROKE = "#000000"

/** Widths parked by the eye, keyed by element — see the Fill section's note. */
const parked = new Map<string, number>()

export const strokeSection: InspectorSection = (context) => {
  const { selection, computed, writer, invalidate } = context
  const element = selection.element
  const width = Number.parseFloat(computed.borderTopWidth) || 0
  const style = computed.borderTopStyle
  const visible = width > 0 && style !== "none"
  const stored = parked.get(selection.key)

  const applyStyles = (writes: Array<{ property: string; value: string }>, summary: string) => {
    writer.applyStyles(selection, writes, summary)
    invalidate()
  }

  const add = miniButton({
    label: visible || stored ? "Stroke already set" : "Add stroke",
    glyph: icon("Plus", tokens.icon.marker),
    onClick: () => {
      parked.delete(selection.key)
      applyStyles(
        [
          { property: "border-width", value: "1px" },
          { property: "border-color", value: toHex(computed.borderTopColor) ?? DEFAULT_STROKE },
        ],
        "Add stroke"
      )
    },
  })
  if (visible || stored) add.setAttribute("disabled", "")

  const svg = svgTarget(context)
  /*
   * The three edges that are not the border. Each is drawn only when the
   * element can actually carry it, which for a ring is a question about a
   * custom property rather than about any border — `hasRing` carries the
   * measurement that makes a non-empty `--tw-ring-shadow` insufficient proof.
   */
  const edges = [
    hasRing(element, computed) ? tokenRow(context, "ring-color", "Ring color") : null,
    hasOutline(element, computed) ? tokenRow(context, "outline-color", "Outline color") : null,
    svg
      ? tokenRow(context, "svg-stroke", "SVG stroke", {
          target: svg,
          computed: getComputedStyle(svg.element),
        })
      : null,
  ]

  if (!visible && !stored) {
    /*
     * No stroke to paint — but "no stroke" and "no border" are not the same
     * claim, and the binding follows the second.
     *
     * `visible` reads the COMPUTED width, which is the right test for the paint
     * row: a stroke colour on a zero-wide border writes source and paints
     * nothing, the outcome the picker's inert-token machinery exists to
     * prevent, arrived at from the other side. The `+` is the affordance for
     * "there is no stroke, give it one", and a picker that quietly created one
     * would be that button in a costume.
     *
     * `hasBorder` is the wider question the dissolved section asked, and the
     * one the BINDING has to keep asking: it also counts a `border*` utility,
     * so an element whose border comes from a class this page has not resolved
     * still offers the token that would name its colour. Gating the binding on
     * `visible` instead dropped that half of the old rule, and dropped it
     * invisibly — in a browser `class="border"` computes to 1px, so `visible`
     * is true anyway and the loss only shows up somewhere without the
     * stylesheet.
     *
     * Captioned, unlike the folded-in version below: with no paint row to sit
     * in, the axis has to name itself.
     *
     * The three edges above stay, because none of them is the border.
     */
    return styledSection(
      context,
      "stroke",
      "Stroke",
      el("div", { class: "de-stack" }, [
        el("div", { class: "de-hint" }, ["No stroke"]),
        hasBorder(selection.element, computed)
          ? tokenRow(context, "stroke-color", "Stroke color")
          : null,
        ...edges,
      ]),
      add
    )
  }

  const shown = visible ? width : (stored as number)

  /*
   * `border-color` is a shorthand, and computed style is not obliged to
   * serialize one — the row it replaces read `borderTopColor` for that reason,
   * and so does this. The inline half needs no help: `border-color` is what
   * every write here sets, so the element's own declaration is already the
   * shape the authored matcher wants.
   *
   * Nothing is handed over for the parked case, unlike Fill's. The eye zeroes
   * the WIDTH and leaves the colour on the element, so the swatch and the field
   * are reading the same live value whether the stroke is shown or not.
   */
  const evidence = { computedValue: computed.borderTopColor }
  /*
   * Drawn wherever the paint row is, which is a shade wider than the table's
   * `hasBorder`: a parked stroke has no width and its swatch is still live, so
   * gating the binding more tightly than the swatch beside it would leave a row
   * whose colour you can change by hand and not by token. That is the two-shapes
   * problem in miniature, at one row instead of thirty.
   */
  const binding = tokenControl(context, "stroke-color", "Stroke color", { ...evidence, hidePreview: true })
  // Sized by `.de-paint-row .de-token-field` in `css/panels.ts`, for the reason
  // spelled out at the same point in `section-fill.ts`: the field is a button
  // carrying `width: 100%`, so without a rule of its own it claims the row and
  // starves the width field beside it.

  /*
   * `border-style` has no entry in `core/tailwind.ts` (another lane owns that
   * file), so a style write there would be dropped on "Apply to code". The
   * class write reaches source; the inline style is only the live preview.
   */
  const setStyle = (next: string) => {
    selection.element.style.setProperty("border-style", next)
    writer.applyClasses(
      selection,
      { remove: STYLE_CLASSES, add: [`border-${next}`] },
      `Set border style ${next}`
    )
    invalidate()
  }

  const row = el("div", { class: "de-paint-row" }, [
    swatch(computed.borderTopColor, "Stroke color", (hex) =>
      applyStyles([{ property: "border-color", value: hex }], "Set stroke color")
    ),
    // The same reachability argument `section-fill.ts` spells out on its own
    // paint value: `toHex` returns null for a wide-gamut or function-valued
    // colour, and the raw text ellipsises in this cell with nothing behind it.
    binding ??
      el(
        "span",
        {
          class: "de-paint-value",
          title: toHex(computed.borderTopColor) ?? computed.borderTopColor,
        },
        [toHex(computed.borderTopColor) ?? computed.borderTopColor]
      ),
    numberField({
      id: "stroke.width",
      label: "W",
      title: "Stroke width",
      value: shown,
      min: 0,
      disabled: !visible,
      onPreview: (value) => selection.element.style.setProperty("border-width", `${round(value)}px`),
      onCommit: (value) => applyStyles([{ property: "border-width", value: `${round(value)}px` }], "Set stroke width"),
    }),
    miniButton({
      label: visible ? "Hide stroke" : "Show stroke",
      glyph: visible ? "◉" : "◎",
      pressed: !visible,
      onClick: () => {
        if (visible) {
          parked.set(selection.key, width)
          applyStyles([{ property: "border-width", value: "0px" }], "Hide stroke")
          return
        }
        parked.delete(selection.key)
        applyStyles([{ property: "border-width", value: `${round(shown)}px` }], "Show stroke")
      },
    }),
    miniButton({
      label: "Remove stroke",
      glyph: icon("Minus", tokens.icon.marker),
      danger: true,
      onClick: (event: Event) => {
        parked.delete(selection.key)
        // The row closes before the rebuild arrives without it — the same order
        // the fill row and the notes list use. `leaveRow` returns null where
        // there is no layout to collapse, and the write stays synchronous.
        const row = (event.currentTarget as HTMLElement).closest(".de-paint-row")
        const write = () => applyStyles([{ property: "border-width", value: "0px" }], "Remove stroke")
        const closing = row instanceof HTMLElement ? leaveRow(row) : null
        if (closing) void closing.then(write)
        else write()
      },
    }),
  ])

  // The hints belong under the row and above the style select: they explain the
  // field two cells to the left, and a sentence cannot live inside a paint row.
  const body = el("div", { class: "de-stack" }, [
    row,
    tokenHints(context, "stroke-color", "Stroke color", evidence),
    selectField({
      id: "stroke.style",
      label: "Stroke style",
      value: STYLES.includes(style as (typeof STYLES)[number]) ? style : "solid",
      options: STYLES.map((value) => ({ value, label: value })),
      onCommit: setStyle,
    }),
    ...edges,
  ])

  return styledSection(context, "stroke", "Stroke", body, add)
}
