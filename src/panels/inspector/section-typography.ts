/**
 * Type controls, shown only for elements that render text themselves.
 *
 * A wrapper whose text lives in a child gets no type panel: editing it there
 * would set an inherited value the child may quietly override.
 *
 * Rows follow Figma's Typography section: family; weight and size; line height
 * and letter spacing; alignment with a type settings toggle that opens
 * justify, decoration and case under it. The text color is not here: as in
 * Figma, it is the element's Fill.
 *
 * `Text style` sits at the top because it sets the four values below it.
 */

import { el, round } from "../../core/dom"
import { icon, type IconName } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { TIP_ATTR } from "../../core/tooltip"
import {
  iconSegmented,
  isExpanded,
  numberField,
  propRow,
  selectField,
  setExpanded,
  textField,
  trailingToggle,
} from "./field"
import { styledSection } from "../../options/panel"
import { directText, textStyleEvidence, tokenRow } from "./token-row"
import { MIXED, mixedNumber, selectedOf, sharedValue } from "./multi"
import type { InspectorSection } from "./index"

export const TYPE_SETTINGS_EXPANDER = "typography.settings"

// Figma's weight names, so the select reads `Semi Bold` rather than `600`.
const WEIGHTS = [
  ["100", "Thin"],
  ["200", "Extra Light"],
  ["300", "Light"],
  ["400", "Regular"],
  ["500", "Medium"],
  ["600", "Semi Bold"],
  ["700", "Bold"],
  ["800", "Extra Bold"],
  ["900", "Black"],
].map(([value, label]) => ({ value, label }))

interface Choice {
  /** The CSS value written, so read-back and write need no lookup table. */
  value: string
  label: string
  /** A drawn glyph, or a typed mark built per render (no DOM at module load). */
  glyph: IconName | (() => Node)
}

/*
 * Named apart from the object-align glyphs in `section-position.ts`: those move
 * a box inside its parent, these set a paragraph's rag. Justify lives behind
 * the type settings toggle, where Figma keeps it.
 */
const HORIZONTAL: Choice[] = [
  { value: "left", label: "Align text left", glyph: "TextAlignLeft" },
  { value: "center", label: "Align text center", glyph: "TextAlignCenter" },
  { value: "right", label: "Align text right", glyph: "TextAlignRight" },
]

/*
 * Flex/grid placement keywords rather than "top", because the property this
 * rail writes is chosen at render time (see `verticalAxis`) and both
 * candidates take these three words.
 */
const VERTICAL: Choice[] = [
  { value: "flex-start", label: "Align text top", glyph: "TextAlignTop" },
  { value: "center", label: "Align text middle", glyph: "TextAlignMiddle" },
  { value: "flex-end", label: "Align text bottom", glyph: "TextAlignBottom" },
]

/** Hangs a reason on a control as its tooltip and accessible description. */
function explained(node: HTMLElement, reason: string | null): HTMLElement {
  if (!reason) return node
  node.setAttribute(TIP_ATTR, reason)
  node.setAttribute("aria-description", reason)
  return node
}

/** A typed mark for a cell with no drawn glyph, the way Figma draws `AG`/`ag`. */
function mark(text: string): HTMLElement {
  return el("span", { class: "de-type-mark", "aria-hidden": "true" }, [text])
}

const JUSTIFY: Choice[] = [
  { value: "off", label: "Don't justify", glyph: "Minus" },
  { value: "justify", label: "Justify text", glyph: "TextAlignJustify" },
]

const DECORATION: Choice[] = [
  { value: "none", label: "No decoration", glyph: "Minus" },
  { value: "underline", label: "Underline", glyph: "Underline" },
  { value: "line-through", label: "Strikethrough", glyph: "Strikethrough" },
]

const CASE: Choice[] = [
  { value: "none", label: "As typed", glyph: "Minus" },
  { value: "uppercase", label: "Uppercase", glyph: () => mark("AG") },
  { value: "lowercase", label: "Lowercase", glyph: () => mark("ag") },
  { value: "capitalize", label: "Capitalize", glyph: () => mark("Ag") },
]

/** Computed placement collapsed onto the three values the rail can show. */
function placeOf(value: string): string | null {
  if (value === "center") return "center"
  if (value === "flex-end" || value === "end") return "flex-end"
  // `normal` and `stretch` are the untouched defaults, and both leave the first
  // line against the top edge, so the rail says top.
  if (value === "flex-start" || value === "start" || value === "normal" || value === "stretch") {
    return "flex-start"
  }
  return null
}

/**
 * The property that moves this element's text up and down, or null when there
 * is none.
 *
 * Not `vertical-align`: it does nothing on a block container. Not
 * `align-content`: `core/tailwind.ts` has no entry for it, so the edit would be
 * preview-only and never reach source. `justify-content` on a flex column and
 * `align-items` on a flex row or grid are both in the table, with
 * `flex-start`/`center`/`flex-end` mapped to utilities. Block, inline and table
 * have no writable answer, and get the rail disabled.
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

/** `underline line-through` shows as underline: the rail holds one value. */
function decorationOf(value: string): string {
  if (value.includes("underline")) return "underline"
  if (value.includes("line-through")) return "line-through"
  return "none"
}

export const typographySection: InspectorSection = (context) => {
  const { selection, computed, writer, invalidate } = context
  // The same predicate the `Text style` token row is gated on, so the section
  // and its row cannot disagree about whether this element has text.
  if (!directText(selection.element)) return null
  // Figma shows Typography for a multi-selection only when every layer is
  // text; a font write fanned out to a frame would land on its children.
  if (!selectedOf(context).every((entry) => directText(entry.element))) return null

  const apply = (property: string, value: string) => {
    writer.applyStyles(selection, [{ property, value }], `Set ${property}`)
  }
  const preview = (property: string, value: string) => {
    selection.element.style.setProperty(property, value)
  }
  const commit = (property: string) => (value: string) => {
    apply(property, value)
    invalidate()
  }

  // Each read is the value every selected layer agrees on, or null for Mixed.
  const shared = <T>(read: (style: CSSStyleDeclaration) => T) => sharedValue(context, read)
  const fontSize = shared((style) => round(Number.parseFloat(style.fontSize) || 0))
  const lineHeight = shared((style) => round(Number.parseFloat(style.lineHeight)))
  const letterSpacing = shared((style) => round(Number.parseFloat(style.letterSpacing)))
  const weight = shared((style) => String(Number.parseInt(style.fontWeight, 10) || 400))
  const family = shared((style) => primaryFamily(style.fontFamily))
  const textAlign = shared((style) => (style.textAlign === "start" ? "left" : style.textAlign))
  const decoration = shared((style) => decorationOf(style.textDecorationLine || style.textDecoration || "none"))
  const textCase = shared((style) => style.textTransform || "none")
  const vertical = verticalAxis(computed)
  const verticalPlace = vertical ? shared((style) => verticalAxis(style)?.current ?? null) : null
  const settingsOpen = isExpanded(TYPE_SETTINGS_EXPANDER)

  /**
   * One rail, built from a `Choice[]`. `enabled` blanks the value as well as
   * disabling the cells: a chip on a dead rail would claim a state.
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
        glyph: typeof choice.glyph === "string" ? icon(choice.glyph, tokens.icon.action) : choice.glyph(),
        disabled: !enabled,
      })),
      onCommit,
    })

  // A weight the ramp does not name (a token's 650, say) still reads back.
  const weights =
    weight === null || WEIGHTS.some((option) => option.value === weight)
      ? WEIGHTS
      : [...WEIGHTS, { value: weight, label: weight }]

  const familyField = textField({
    id: "type.family",
    label: "",
    title: "Font family",
    value: family ?? "",
    placeholder: family === null ? MIXED : "Inter",
    onCommit: (value) => {
      // Leaving a Mixed field empty is not a request to blank every family.
      if (family === null && !value.trim()) return
      apply("font-family", value.trim())
    },
  })
  // No mark: Figma's family field carries none, so its text starts where the
  // weight select's does.
  familyField.classList.add("de-type-family")

  const textStyle = tokenRow(context, "text-style", "Text style", textStyleEvidence(selection.element, computed))

  const settings = settingsOpen
    ? [
        propRow({
          id: "type.justify",
          caption: "Justify",
          cells: [
            rail("Justify", textAlign === null ? null : textAlign === "justify" ? "justify" : "off", JUSTIFY, (value) =>
              commit("text-align")(value === "justify" ? "justify" : "left")
            ),
          ],
        }),
        propRow({
          id: "type.decoration",
          caption: "Decoration",
          cells: [
            rail(
              "Decoration",
              decoration,
              DECORATION,
              commit("text-decoration-line")
            ),
          ],
        }),
        propRow({
          id: "type.case",
          caption: "Case",
          cells: [rail("Case", textCase, CASE, commit("text-transform"))],
        }),
      ]
    : []

  const body = el("div", { class: "de-stack" }, [
    textStyle ? propRow({ cells: [textStyle] }) : null,
    propRow({ id: "type.family", cells: [familyField] }),
    propRow({
      id: "type.weight-size",
      cells: [
        selectField({
          id: "type.weight",
          label: "Font weight",
          value: weight ?? "",
          options: weights,
          placeholder: MIXED,
          onCommit: commit("font-weight"),
        }),
        numberField({
          id: "type.size",
          // The `Type` mark gives the size a scrub handle; the field has no
          // caption to name it.
          label: icon("Type", tokens.icon.action),
          title: "Font size",
          ...mixedNumber(fontSize),
          min: 1,
          onPreview: (value) => preview("font-size", `${round(value)}px`),
          onCommit: (value) => apply("font-size", `${round(value)}px`),
        }),
      ],
    }),
    propRow({
      id: "type.spacing",
      caption: ["Line height", "Letter spacing"],
      cells: [
        numberField({
          id: "type.lineheight",
          label: icon("LineHeight", tokens.icon.action),
          title: "Line height",
          // `normal` has no number; Figma calls it Auto.
          value: lineHeight === null || Number.isNaN(lineHeight) ? null : lineHeight,
          placeholder: lineHeight === null ? MIXED : Number.isNaN(lineHeight) ? "Auto" : undefined,
          min: 0,
          onPreview: (value) => preview("line-height", `${round(value)}px`),
          onCommit: (value) => apply("line-height", `${round(value)}px`),
        }),
        numberField({
          id: "type.letterspacing",
          label: icon("LetterSpacing", tokens.icon.action),
          title: "Letter spacing",
          ...mixedNumber(letterSpacing === null ? null : Number.isNaN(letterSpacing) ? 0 : letterSpacing),
          step: 0.1,
          onPreview: (value) => preview("letter-spacing", `${round(value)}px`),
          onCommit: (value) => apply("letter-spacing", `${round(value)}px`),
        }),
      ],
    }),
    propRow({
      id: "type.alignment",
      caption: "Alignment",
      cells: [
        rail("Text alignment", textAlign, HORIZONTAL, commit("text-align")),
        explained(
          rail(
            "Vertical text alignment",
            verticalPlace,
            VERTICAL,
            (value) => {
              if (!vertical) return
              commit(vertical.property)(value)
            },
            vertical !== null
          ),
          // Figma has no sentence here; a dead rail says why on hover instead.
          vertical ? null : "Vertical alignment needs a flex or grid container. Add auto layout first."
        ),
      ],
      trailing: trailingToggle({
        label: "Type settings",
        glyph: icon("Settings", tokens.icon.action),
        pressed: settingsOpen,
        onClick: () => {
          setExpanded(TYPE_SETTINGS_EXPANDER, !settingsOpen)
          invalidate()
        },
      }),
    }),
    ...settings,
  ])

  return styledSection(context, "typography", "Typography", body)
}
