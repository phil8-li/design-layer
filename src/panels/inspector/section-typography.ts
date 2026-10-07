/**
 * Type controls, shown only for elements that render text themselves.
 *
 * A wrapper whose text lives in a child gets no type panel: editing it there
 * would set an inherited value the child may quietly override.
 *
 * ## The two type rows that moved in from `Design system`
 *
 * `Text style` and `Text color` were pickers in a section of their own, thirty
 * rows below this one. A designer recolouring a heading met `Text color`
 * reading `#1b2e5d` there and `Color` reading `#1b2e5d` here, with nothing in
 * either row saying they were the same declaration — and only one of the two
 * could write a token. Two controls for one property are not two ways to do
 * the job; they are a question about which one wins that the panel never
 * answers.
 *
 * So the colour one is not a row at all any more, it is half of the row that
 * was already here. A token and a hex are the SAME answer at two levels of
 * precision, which makes them one control: the field reads the bound style's
 * name when there is one and the plain value when there is not, and the plain
 * value is the string the hex input was showing anyway. The colour well stays
 * beside it, because a well is direct manipulation and a list of names is not.
 * Swatch, then either a style name or a hex, is Figma's paint row.
 *
 * `Text style` keeps a captioned block of its own — it binds four declarations
 * at once and has no single control here to fold into — and it sits at the TOP
 * of the section, above family, size, weight and spacing, because it is the
 * thing that SETS all four. Under them it would be the summary printed after
 * the detail it summarises.
 */

import { el, round } from "../../core/dom"
import { icon, type IconName } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { colorField, swatch } from "./color"
import { group, iconSegmented, numberField, selectField, textField } from "./field"
import { styledSection } from "../../options/panel"
import { directText, textStyleEvidence, tokenControl, tokenHints, tokenRow } from "./token-row"
import type { InspectorSection } from "./index"

const WEIGHTS = ["100", "200", "300", "400", "500", "600", "700", "800", "900"].map((value) => ({
  value,
  label: value,
}))

interface Choice {
  /** The CSS value written, so read-back and write need no lookup table. */
  value: string
  label: string
  glyph: IconName
}

/*
 * The rag, as four drawings rather than four typed characters.
 *
 * These were `◧ ▣ ◨ ▤` — Geometric Shapes block, chosen because a half-filled
 * square is the nearest thing in Unicode to a left-aligned paragraph. It was
 * never close: the mark said "a box, part of which is dark", where the control
 * sets where a line of text starts. The four drawn marks are literally ragged
 * lines, which is the thing itself.
 *
 * Named apart from the six object-align glyphs in `section-position.ts`: those
 * move a BOX inside its parent, these set a paragraph's rag, and the two
 * families would otherwise be one keystroke apart at every call site.
 *
 * The vertical triple below is named on the same rule and needs it harder,
 * because unlike the rag marks it does not get its own drawings. `TextAlignTop`
 * and `TextAlignBottom` are `ArrowUpToLine` and `ArrowDownToLine` — the very
 * two arrows `section-position.ts` already draws for "bring to front" and "send
 * to back". One drawing, three jobs: an arrow to a line means "move this box to
 * the end of the stack" there and "sit the text against the top of its box"
 * here. Calling them by what they DO at this call site is the only thing
 * stopping a later reader from assuming the two strips share a purpose because
 * they share a `d` attribute.
 *
 * Four cells here where Figma draws three. Figma keeps justify in the popover
 * behind the type-settings button (measured: section 7 of the spec), and we
 * have no popover to keep it in — so matching the screenshot would mean
 * deleting `text-align: justify` from the editor outright. Losing a function to
 * gain a resemblance is the wrong trade; the rail carries a fourth cell until
 * there is a popover to move it into.
 */
const HORIZONTAL: Choice[] = [
  { value: "left", label: "Align text left", glyph: "TextAlignLeft" },
  { value: "center", label: "Align text center", glyph: "TextAlignCenter" },
  { value: "right", label: "Align text right", glyph: "TextAlignRight" },
  { value: "justify", label: "Justify text", glyph: "TextAlignJustify" },
]

/*
 * Where the text block sits in its box, top to bottom.
 *
 * The values are flex/grid placement keywords rather than anything that reads
 * like "top", because the property this rail writes is chosen at render time
 * and both candidates take the same three words. See `verticalAxis` below for
 * which property, and why it is not the one you would reach for first.
 */
const VERTICAL: Choice[] = [
  { value: "flex-start", label: "Align text top", glyph: "TextAlignTop" },
  { value: "center", label: "Align text middle", glyph: "TextAlignMiddle" },
  { value: "flex-end", label: "Align text bottom", glyph: "TextAlignBottom" },
]

/** Computed placement collapsed onto the three values the rail can show. */
function placeOf(value: string): string | null {
  if (value === "center") return "center"
  if (value === "flex-end" || value === "end") return "flex-end"
  // `normal` and `stretch` are the untouched defaults, and both leave the text
  // block's first line against the top edge — so the rail says top rather than
  // showing nothing chosen for the state every element starts in.
  if (value === "flex-start" || value === "start" || value === "normal" || value === "stretch") {
    return "flex-start"
  }
  return null
}

/**
 * The property that actually moves this element's text up and down, or null
 * when there isn't one.
 *
 * Three candidates, and the first two are traps.
 *
 * `vertical-align` is the reflex and it is inert here: it positions an inline
 * box against its line box, or a cell against its row, and does nothing
 * whatsoever on the block container a text element usually is. It is also
 * absent from `core/tailwind.ts`, so it would be dropped on the way to source
 * as well as doing nothing on screen — wrong twice, the same way the `transform`
 * nudges described in `section-layout.ts` were.
 *
 * `align-content` is the genuinely modern answer — since Chrome 123 it aligns
 * the content of a plain block container, which is exactly this control's job,
 * and Tailwind spells it `content-start`/`content-center`/`content-end`. It is
 * still wrong for us, for the one reason that outranks correctness in CSS here:
 * `core/tailwind.ts` has no `align-content` entry, in `KEYWORDS` or `SCALARS`.
 * `toClassUpdate` returns null for it, and `writeStyles` files a null update as
 * preview-only — the inline style lands, the canvas moves, and "Apply to code"
 * writes nothing. A control that appears to work and reaches no file is worse
 * than a control that is honestly unavailable, which is the lesson
 * `section-align.ts` and `section-layout.ts` were each written to record.
 *
 * So: `justify-content` on a flex column and `align-items` on a flex row or a
 * grid. Both are in `KEYWORDS` with `flex-start`/`center`/`flex-end` mapped to
 * real utilities, which is also why `VERTICAL` spells its values that way —
 * `start` and `end` are valid CSS and are NOT in the table, so writing the
 * shorter word would silently take the same preview-only path we are avoiding.
 * A bare text node inside a flex or grid container is wrapped in an anonymous
 * item, so these move the text itself and not merely a child element.
 *
 * Everything else — block, inline, table — has no writable answer, and gets the
 * rail disabled with a hint rather than a button that lies.
 */
function verticalAxis(
  computed: CSSStyleDeclaration
): { property: "justify-content" | "align-items"; current: string | null } | null {
  const display = computed.display
  const flex = display === "flex" || display === "inline-flex"
  const grid = display === "grid" || display === "inline-grid"
  if (!flex && !grid) return null

  // Grid's block axis is `align-items` whatever the auto-flow; only flex swaps
  // the two axes, and only when its direction is a column.
  const column = flex && computed.flexDirection.startsWith("column")
  return column
    ? { property: "justify-content", current: placeOf(computed.justifyContent) }
    : { property: "align-items", current: placeOf(computed.alignItems) }
}

/** First family in the stack — what the user typed, not the fallback chain. */
function primaryFamily(fontFamily: string): string {
  return fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "")
}

/*
 * The whole context, not the four fields this section reads.
 *
 * `tokenControl` and `tokenRow` take a `SectionContext` — they need the editor
 * bridge to describe a target, and the writer and `invalidate` to commit. Handing
 * them an object rebuilt from the four properties destructured here would be a
 * second, quietly divergent context: the day one of them starts reading
 * `selections`, this section is the one call site that does not have it.
 */
export const typographySection: InspectorSection = (context) => {
  const { selection, computed, writer, invalidate } = context
  /*
   * The gate is `directText`, which is the predicate this file used to spell
   * for itself as `rendersText`: the same walk over the child nodes, the same
   * "a text node with something in it" test, the same answer on every input.
   * They are one question — can this element's own text be styled — asked by
   * the section and by the applicability rule for its two token rows, and two
   * copies of it is how the section comes up while the `Text style` row inside
   * it silently does not.
   */
  if (!directText(selection.element)) return null

  const apply = (property: string, value: string) => {
    writer.applyStyles(selection, [{ property, value }], `Set ${property}`)
  }
  const preview = (property: string, value: string) => {
    selection.element.style.setProperty(property, value)
  }

  const fontSize = Number.parseFloat(computed.fontSize) || 0
  const lineHeight = Number.parseFloat(computed.lineHeight)
  const letterSpacing = Number.parseFloat(computed.letterSpacing)
  const weight = String(Number.parseInt(computed.fontWeight, 10) || 400)
  const textAlign = computed.textAlign === "start" ? "left" : computed.textAlign
  const vertical = verticalAxis(computed)

  /**
   * One rail, built from a `Choice[]`.
   *
   * `enabled` blanks the value as well as disabling the cells: with no writable
   * property there is no state to report, and a chip sitting on a dead rail
   * would be claiming one.
   */
  const rail = (
    label: string,
    value: string | null,
    choices: Choice[],
    onCommit: (next: string) => void,
    enabled = true
  ) =>
    iconSegmented({
      label,
      value: enabled ? value ?? "" : "",
      options: choices.map((choice) => ({
        value: choice.value,
        label: choice.label,
        glyph: icon(choice.glyph, tokens.icon.action),
        disabled: !enabled,
      })),
      onCommit,
    })

  /*
   * The binding that takes the hex input's place, and what it costs.
   *
   * Nothing, on the typing path — checked rather than assumed. `NO_RAW_FORM`
   * in `token-row.ts` is `text-style`, `icon-size` and `motion-duration`, and
   * `text-color` is not among them, so the picker builds its `custom` footer
   * for this axis: a typed `#1b2e5d` is written straight to `color`, which is
   * `tokenCssProperty("text-color")` and exactly the declaration the hex input
   * wrote. What the merge removes is the second place to ask, not the ability
   * to answer in hex.
   *
   * Null when the project stocks no text colour, and then the row is today's
   * `colorField`, unchanged and still carrying `type.color`. That id only goes
   * away on the merged path, where the input it named is the thing being
   * replaced; focus lands on the field's own `design-system.text-color` there,
   * and nothing outside this file ever read the old one.
   */
  const boundColor = tokenControl(context, "text-color", "Text color", { hidePreview: true })

  const body = el("div", { class: "de-stack" }, [
    /*
     * The style that sets the four controls below it, so it is above them.
     *
     * `textStyleEvidence` rather than a hand-built pair: this axis has no
     * single CSS property, so the matcher is fed four joined declarations and a
     * signature, and a caller that assembles either by eye gets a row that
     * never matches anything and reports a hand-styled heading as unbound.
     */
    tokenRow(context, "text-style", "Text style", textStyleEvidence(selection.element, computed)),
    /*
     * Figma captions every control group in the panel and we captioned none of
     * them, so a reader had to infer "Inter" was a family and "LH" was leading
     * from the values themselves. The words are short nouns on purpose: the
     * caption names the group, the field labels inside it still say which is
     * which, and a caption long enough to restate them would just be noise at
     * the top of every row.
     */
    group(
      "Font",
      textField({
        id: "type.family",
        /*
         * The mark, not the word. `Font` printed in the strip under a caption
         * reading `Font` is the panel saying it twice inside 24px — the same
         * duplication the gap field carried. `Type` is the one glyph in the set
         * that means "this is text", and dropping the word gives the whole
         * field to the family name, which is the longest value in the section.
         */
        label: icon("Type", tokens.icon.action),
        title: "Font family",
        value: primaryFamily(computed.fontFamily),
        placeholder: "Inter",
        onCommit: (value) => apply("font-family", value.trim()),
      })
    ),
    group(
      "Size and weight",
      el("div", { class: "de-row--split" }, [
        numberField({
          id: "type.size",
          label: "Size",
          title: "Font size",
          value: fontSize,
          min: 1,
          onPreview: (value) => preview("font-size", `${round(value)}px`),
          onCommit: (value) => apply("font-size", `${round(value)}px`),
        }),
        selectField({
          id: "type.weight",
          label: "Font weight",
          value: weight,
          options: WEIGHTS,
          onCommit: (value) => {
            apply("font-weight", value)
            invalidate()
          },
        }),
      ])
    ),
    group(
      "Spacing",
      el("div", { class: "de-row--split" }, [
        numberField({
          id: "type.lineheight",
          label: "LH",
          title: "Line height",
          // `normal` has no number to show; leave the field empty rather than lie.
          value: Number.isNaN(lineHeight) ? null : lineHeight,
          placeholder: Number.isNaN(lineHeight) ? "normal" : undefined,
          min: 0,
          onPreview: (value) => preview("line-height", `${round(value)}px`),
          onCommit: (value) => apply("line-height", `${round(value)}px`),
        }),
        numberField({
          id: "type.letterspacing",
          label: "LS",
          title: "Letter spacing",
          value: Number.isNaN(letterSpacing) ? 0 : letterSpacing,
          step: 0.1,
          onPreview: (value) => preview("letter-spacing", `${round(value)}px`),
          onCommit: (value) => apply("letter-spacing", `${round(value)}px`),
        }),
      ])
    ),
    // Captioned like every other group in the section. It was the one row with
    // no caption, because it carried its noun inside the field instead — and
    // that is the half of the pair `colorField` just gave up.
    group(
      "Color",
      boundColor
        ? el("div", { class: "de-row" }, [
            /*
             * The well, kept, and the halves of `colorField` taken apart to
             * keep it. Picking a colour out of a wheel is the one thing the
             * token picker cannot be asked to do — a list of names has no
             * gesture for "slightly warmer" — so direct manipulation stays and
             * the naming half of the row is what the binding replaces.
             *
             * It commits and rebuilds, the way Fill's paint row does. The field
             * beside it is a read-out assembled at render time, and no write
             * from here reaches inside it; without the rebuild the row would go
             * on printing the colour the text used to be.
             */
            swatch(computed.color, "Text color swatch", (hex) => {
              apply("color", hex)
              invalidate()
            }),
            boundColor,
          ])
        : colorField({
            id: "type.color",
            label: "Color",
            value: computed.color,
            onCommit: (value) => apply("color", value),
          }),
      /*
       * The two sentences the folded field has nowhere to put.
       *
       * "Could be X or Y — the theme decides" and "Unavailable here" are the
       * honesty the picker was built around, and they are the one thing a
       * section loses by taking the bare field instead of the captioned block.
       * Under the row, where `tokenRow` puts them, rather than beside it.
       */
      tokenHints(context, "text-color", "Text color")
    ),
    /*
     * Two rails side by side under one caption, which is Figma's layout: the
     * rag and the vertical placement are two answers to "where does the text
     * sit", and splitting them under separate captions would read as two
     * unrelated settings that happen to be adjacent.
     *
     * They were four bare `.de-tool` buttons in a flex row with an inline
     * `gap:2px` — a strip that looked exactly like the momentary align actions
     * in Position while behaving like a value. `.de-iseg` says the difference
     * in geometry (one continuous rail, one chip) and `.de-row--split` carries
     * the 8px column gap from the token scale, so nothing here hard-codes a px.
     */
    group(
      "Alignment",
      el("div", { class: "de-row--split" }, [
        rail("Text alignment", textAlign, HORIZONTAL, (value) => {
          apply("text-align", value)
          invalidate()
        }),
        rail(
          "Vertical text alignment",
          vertical?.current ?? null,
          VERTICAL,
          (value) => {
            if (!vertical) return
            apply(vertical.property, value)
            invalidate()
          },
          vertical !== null
        ),
      ]),
      vertical
        ? null
        : el("div", { class: "de-hint" }, [
            `Vertical alignment needs a flex or grid container. Add auto layout first.`,
          ])
    ),
  ])

  return styledSection(context, "typography", "Typography", body)
}
