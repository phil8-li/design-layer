/**
 * Auto layout — Figma's stack panel, expressed as CSS flexbox and grid.
 *
 * Every row sits on `propRow`, Figma's `1fr 1fr 24px` grid, in Figma's order:
 * `Flow` (+ Wrap), then the size row from `section-layout.ts`, then
 * [`Alignment`][`Gap`] (+ nothing yet in column 3), `Padding` (+ Individual
 * padding) and `Clip content`. The rows are returned separately because the
 * size row from another file goes between them.
 *
 * Only shown for elements that actually contain something: auto layout on a
 * leaf node is a control with no observable effect.
 */

import { el, round } from "../../core/dom"
import { revealGroup } from "../../core/leave"
import { icon } from "../../core/icons"
import type { IconName } from "../../core/icons"
import { tokens } from "../../core/tokens"
import {
  alignPad,
  iconSegmented,
  isExpanded,
  miniButton,
  numberField,
  propRow,
  setExpanded,
  takeJustExpanded,
  trailingToggle,
} from "./field"
import { fieldMenu } from "./section-layout"
import { MIXED, isMulti, mixedNumber, selectedOf, sharedValue, computedOf } from "./multi"
import { fieldToken } from "./token-row"
import type { SectionContext } from "./index"

export type Flow = "none" | "vertical" | "horizontal" | "grid"
type Place = "flex-start" | "center" | "flex-end"

const PLACES: Place[] = ["flex-start", "center", "flex-end"]

const PADDING_EXPANDER = "autolayout.padding"

/*
 * Figma's order and Figma's tooltips. The marks are four arrangements of the
 * same boxes, because the control has one subject: where the children end up.
 * Wrap is not a flow: it is the column-3 toggle beside this rail.
 */
const FLOWS: Array<{ value: Flow; label: string; glyph: IconName }> = [
  { value: "none", label: "Freeform", glyph: "FlowNone" },
  { value: "vertical", label: "Vertical", glyph: "FlowVertical" },
  { value: "horizontal", label: "Horizontal", glyph: "FlowHorizontal" },
  { value: "grid", label: "Grid", glyph: "FlowGrid" },
]

/**
 * The mark the chosen pad cell wears, indexed by `PLACES`. The cell's position
 * already says the main axis, so the mark draws the cross axis, and which
 * family applies follows the flow.
 */
const CROSS_GLYPH: Record<"horizontal" | "vertical", IconName[]> = {
  horizontal: ["AlignStartHorizontal", "AlignCenterHorizontal", "AlignEndHorizontal"],
  vertical: ["AlignStartVertical", "AlignCenterVertical", "AlignEndVertical"],
}

const SIDES = ["left", "top", "right", "bottom"] as const
type Side = (typeof SIDES)[number]

const PAD_GLYPH: Record<Side, IconName> = {
  top: "PadTop",
  right: "PadRight",
  bottom: "PadBottom",
  left: "PadLeft",
}

export function flowOf(computed: CSSStyleDeclaration): Flow {
  const display = computed.display
  if (display === "grid" || display === "inline-grid") return "grid"
  if (display !== "flex" && display !== "inline-flex") return "none"
  return computed.flexDirection.startsWith("column") ? "vertical" : "horizontal"
}

function wrapsOf(computed: CSSStyleDeclaration): boolean {
  return computed.flexWrap === "wrap" || computed.flexWrap === "wrap-reverse"
}

function placeOf(value: string): Place {
  if (value === "center") return "center"
  if (value === "flex-end" || value === "end" || value === "right") return "flex-end"
  return "flex-start"
}

/** `Auto layout` when the element lays out its children, `Layout` otherwise. */
export function layoutTitle(context: SectionContext): string {
  return drawsSpacingControls(context) ? "Auto layout" : "Layout"
}

/**
 * The writes for one flow. Shared by the rail, the header toggle and the
 * Shift+A command, so all three reach source through the same declarations.
 */
export function setFlow(context: SectionContext, next: Flow): void {
  const writes =
    next === "none"
      ? [{ property: "display", value: "block" }]
      : next === "grid"
        ? [{ property: "display", value: "grid" }]
        : [
            { property: "display", value: "flex" },
            { property: "flex-direction", value: next === "vertical" ? "column" : "row" },
            // Wrap only means something on a row, so a column drops it.
            ...(next === "vertical" ? [{ property: "flex-wrap", value: "nowrap" }] : []),
          ]
  context.writer.applyStyles(context.selection, writes, next === "none" ? "Remove auto layout" : "Set auto layout")
  context.invalidate()
}

/**
 * The section header's `Add auto layout` / `Remove auto layout` toggle.
 * Null for a leaf, which has nothing to lay out.
 */
export function autoLayoutToggle(context: SectionContext): HTMLElement | null {
  if (context.selection.element.childElementCount === 0) return null
  const on = flowOf(context.computed) !== "none"
  return miniButton({
    label: on ? "Remove auto layout" : "Add auto layout",
    glyph: icon("AutoLayout", tokens.icon.action),
    pressed: on,
    onClick: () => setFlow(context, on ? "none" : "horizontal"),
  })
}

/** The `Flow` row: the four-way rail across columns 1-2 and Wrap in column 3. */
export function flowRow(context: SectionContext): HTMLElement | null {
  const { selection, computed, writer, invalidate } = context
  if (selection.element.childElementCount === 0) return null
  const flow = flowOf(computed)
  const wraps = wrapsOf(computed)
  const sharedFlow = sharedValue(context, flowOf)
  const sharedWraps = sharedValue(context, wrapsOf)

  // Figma draws Wrap beside either stack and leaves column 3 empty for freeform
  // and grid. CSS can wrap a column, but the result is rarely wanted, so the
  // toggle there only stays live to turn an existing wrap off.
  let wrap: HTMLElement | null = null
  if (flow === "horizontal" || flow === "vertical") {
    wrap = trailingToggle({
      label: "Wrap",
      glyph: icon("WrapText", tokens.icon.action),
      pressed: sharedWraps === true,
      onClick: () => {
        writer.applyStyles(selection, [{ property: "flex-wrap", value: wraps ? "nowrap" : "wrap" }], "Set wrap")
        invalidate()
      },
    })
    if (flow === "vertical" && !wraps) (wrap as HTMLButtonElement).disabled = true
  }

  return propRow({
    id: "autolayout.flow",
    caption: "Flow",
    cells: [
      iconSegmented({
        label: "Flow",
        value: sharedFlow ?? "",
        options: FLOWS.map((entry) => ({
          value: entry.value,
          label: entry.label,
          glyph: icon(entry.glyph, tokens.icon.action),
        })),
        onCommit: (next) => {
          // Looked up rather than cast, so a renamed flow cannot reach a write.
          const entry = FLOWS.find((candidate) => candidate.value === next)
          if (entry) setFlow(context, entry.value)
        },
      }),
    ],
    trailing: wrap,
  })
}

/**
 * Figma's 3x3 alignment pad, mapped onto justify-content + align-items. A
 * cell's row is where the children sit vertically and its column where they
 * sit horizontally; which of those is `justify-content` flips with the flow.
 */
function alignmentPad(options: {
  vertical: boolean
  justify: Place
  align: Place
  mixed?: boolean
  onPick(justify: Place, align: Place): void
}): HTMLElement {
  const glyphs = CROSS_GLYPH[options.vertical ? "vertical" : "horizontal"]
  const cells: Array<{ label: string; pressed: boolean; glyph: Node; onClick(): void }> = []
  for (const row of PLACES) {
    for (const column of PLACES) {
      const justify = options.vertical ? row : column
      const align = options.vertical ? column : row
      cells.push({
        label: `${justify.replace("flex-", "")} / ${align.replace("flex-", "")}`,
        pressed: !options.mixed && justify === options.justify && align === options.align,
        glyph: icon(glyphs[PLACES.indexOf(align)], tokens.icon.action),
        onClick: () => options.onPick(justify, align),
      })
    }
  }
  return alignPad({ label: "Alignment", cells })
}

/** Track count from a computed or authored track list: `100px 100px`, `repeat(3, 1fr)`. */
function trackCount(value: string): number | null {
  const list = value.trim()
  if (!list || list === "none") return null
  const repeat = /^repeat\(\s*(\d+)\s*,/.exec(list)
  if (repeat) return Number(repeat[1])
  let depth = 0
  let count = 0
  let inToken = false
  for (const char of list) {
    if (char === "(") depth += 1
    else if (char === ")") depth -= 1
    if (depth === 0 && /\s/.test(char)) {
      inToken = false
      continue
    }
    if (!inToken && char !== "[") {
      count += 1
      inToken = true
    }
  }
  return count || null
}

/**
 * Whether this block draws its own gap and padding fields for this element.
 *
 * Exported for `section-unified-layout.ts`, which owns the spacing token
 * bindings and hands the gap and padding ones to these fields when this says
 * yes — so one property never gets two controls a few rows apart.
 */
export function drawsSpacingControls(context: SectionContext): boolean {
  // Every selected layer, so a gap typed into a multi-selection never lands on
  // a box that does not lay anything out.
  return selectedOf(context).every(
    (entry) => entry.element.childElementCount > 0 && flowOf(computedOf(context, entry)) !== "none"
  )
}

/** The number one property reads on every selected layer, or null for Mixed. */
function sharedPx(context: SectionContext, read: (style: CSSStyleDeclaration) => string): number | null {
  return sharedValue(context, (style) => round(Number.parseFloat(read(style)) || 0))
}

/**
 * The rows under the size row: [Alignment][Gap] (or [Grid][Gap] for a grid)
 * and Padding. Empty for a leaf or a freeform box.
 *
 * Every gap and padding field carries its own token binding (`fieldToken`),
 * so these rows need no separate token control.
 */
export function autoLayoutRows(context: SectionContext): HTMLElement[] {
  if (!drawsSpacingControls(context)) return []
  return [
    flowOf(context.computed) === "grid" ? gridRow(context) : alignmentGapRow(context),
    paddingRows(context),
  ]
}

// Numeric commits deliberately skip `invalidate`: the inspector rebuilds on the
// next frame, which would tear the field out from under a drag-scrub.
function writers(context: SectionContext) {
  const { selection, writer } = context
  return {
    apply: (writes: Array<{ property: string; value: string }>, summary: string) =>
      writer.applyStyles(selection, writes, summary),
    preview: (writes: Array<{ property: string; value: string }>) => {
      for (const entry of writes) selection.element.style.setProperty(entry.property, entry.value)
    },
  }
}

/** A column cell holding a stack of fields, like Figma's two gap fields for a grid. */
function column(...children: Array<Node | null>): HTMLElement {
  return el("div", { class: "de-lay-column" }, children)
}

function alignmentGapRow(context: SectionContext): HTMLElement {
  const { selection, computed, writer, invalidate } = context
  const { apply, preview } = writers(context)
  const flow = flowOf(computed)
  const vertical = flow === "vertical"
  const wraps = wrapsOf(computed)
  const justify = placeOf(computed.justifyContent)
  const align = placeOf(computed.alignItems)
  const auto = computed.justifyContent === "space-between"
  // The pad marks a cell only when every layer sits there.
  const placed = sharedValue(
    context,
    (style) => `${style.justifyContent === "space-between" ? "auto" : placeOf(style.justifyContent)} ${placeOf(style.alignItems)}`
  )

  const pad = alignmentPad({
    vertical,
    justify,
    align,
    mixed: placed === null,
    onPick: (nextJustify, nextAlign) => {
      writer.applyStyles(
        selection,
        [
          // Auto spacing owns the main axis; the pad only moves the cross axis
          // while it is on, so picking a cell cannot silently repack the stack.
          { property: "justify-content", value: auto ? "space-between" : nextJustify },
          { property: "align-items", value: nextAlign },
        ],
        "Set alignment"
      )
      invalidate()
    },
  })

  const gapValue = Number.parseFloat(vertical ? computed.rowGap : computed.columnGap) || 0
  const sharedAuto = sharedValue(context, (style) => style.justifyContent === "space-between")
  const sharedGap = sharedPx(context, (style) => (vertical ? style.rowGap : style.columnGap))
  const setGap = (value: number) => {
    const writes = [{ property: "gap", value: `${round(value)}px` }]
    if (!auto) return apply(writes, "Set gap")
    // Typing a number while the gap reads Auto is Figma's way back to a fixed
    // gap, so the spread goes with it.
    apply([...writes, { property: "justify-content", value: justify }], "Set gap")
    invalidate()
  }

  // An Auto gap has no number to bind, so it offers no token until it is fixed.
  const gapToken = auto ? undefined : fieldToken(context, ["gap"], "Gap")
  const gapField: HTMLElement = numberField({
    id: "autolayout.gap",
    label: icon(vertical ? "GapRow" : "GapColumn", tokens.icon.action),
    title: vertical ? "Vertical gap between objects" : "Horizontal gap between objects",
    ...(sharedAuto === null ? mixedNumber(null) : auto ? { value: null, placeholder: "Auto" } : mixedNumber(sharedGap)),
    min: 0,
    token: gapToken,
    onPreview: (value) => preview([{ property: "gap", value: `${round(value)}px` }]),
    onCommit: setGap,
    trailing: fieldMenu({
      label: "Gap options",
      face: icon("ChevronDown", tokens.icon.marker),
      value: auto ? "auto" : "fixed",
      items: [
        { value: "fixed", label: String(round(gapValue)) },
        { value: "auto", label: "Auto" },
        // Figma's gap menu ends with "Apply variable…"; this is the same entry.
        ...(gapToken ? [{ value: "token", label: "Apply token…", action: true }] : []),
      ],
      onPick: (next) => {
        if (next === "token") {
          gapField.querySelector<HTMLElement>(".de-tokenbind-apply")?.click()
          return
        }
        writer.applyStyles(
          selection,
          [{ property: "justify-content", value: next === "auto" ? "space-between" : justify }],
          next === "auto" ? "Set gap to auto" : "Set gap"
        )
        invalidate()
      },
    }),
  })

  // A wrapped row has a second gap between its lines, under the same caption.
  const rowGapField = wraps
    ? numberField({
        id: "autolayout.rowgap",
        label: icon("GapRow", tokens.icon.action),
        title: "Vertical gap between rows",
        ...mixedNumber(sharedPx(context, (style) => style.rowGap)),
        min: 0,
        token: fieldToken(context, ["row-gap"], "Row gap"),
        onPreview: (value) => preview([{ property: "row-gap", value: `${round(value)}px` }]),
        onCommit: (value) => apply([{ property: "row-gap", value: `${round(value)}px` }], "Set row gap"),
      })
    : null

  return propRow({
    id: "autolayout.alignment",
    caption: ["Alignment", "Gap"],
    cells: [pad, column(gapField, rowGapField)],
  })
}

/** Grid flow: [columns × rows] and [column gap / row gap], as Figma draws it. */
function gridRow(context: SectionContext): HTMLElement {
  const { apply, preview } = writers(context)
  const tracks = (property: "grid-template-columns" | "grid-template-rows", label: string, title: string) => {
    const value = sharedValue(context, (style) => trackCount(style.getPropertyValue(property)))
    const mixed = isMulti(context) && value === null && sharedValue(context, (style) => style.getPropertyValue(property)) === null
    const writes = (count: number) => [{ property, value: `repeat(${Math.max(1, round(count))}, minmax(0, 1fr))` }]
    return numberField({
      id: `autolayout.${property}`,
      label,
      title,
      value,
      placeholder: mixed ? MIXED : value === null ? "Auto" : undefined,
      min: 1,
      onPreview: (count) => preview(writes(count)),
      onCommit: (count) => apply(writes(count), `Set ${title.toLowerCase()}`),
    })
  }
  const gap = (property: "column-gap" | "row-gap", glyph: IconName, title: string) =>
    numberField({
      id: `autolayout.${property}`,
      label: icon(glyph, tokens.icon.action),
      title,
      ...mixedNumber(sharedPx(context, (style) => style.getPropertyValue(property))),
      min: 0,
      token: fieldToken(context, [property], property === "column-gap" ? "Column gap" : "Row gap"),
      onPreview: (value) => preview([{ property, value: `${round(value)}px` }]),
      onCommit: (value) => apply([{ property, value: `${round(value)}px` }], `Set ${property}`),
    })

  return propRow({
    id: "autolayout.grid",
    caption: ["Grid", "Gap"],
    cells: [
      column(tracks("grid-template-columns", "C", "Columns"), tracks("grid-template-rows", "R", "Rows")),
      column(
        gap("column-gap", "GapColumn", "Horizontal gap between columns"),
        gap("row-gap", "GapRow", "Vertical gap between rows")
      ),
    ],
  })
}

/**
 * `Padding`: [horizontal][vertical] + Individual padding, or with the toggle
 * pressed [left][top] over [right][bottom]. Each field binds a token for the
 * sides it writes.
 */
function paddingRows(context: SectionContext): HTMLElement {
  const { invalidate } = context
  const { apply, preview } = writers(context)
  const value = (style: CSSStyleDeclaration, side: Side) =>
    Number.parseFloat(style.getPropertyValue(`padding-${side}`)) || 0
  const individual = isExpanded(PADDING_EXPANDER)
  const toggle = trailingToggle({
    label: "Individual padding",
    glyph: icon("IndividualSides", tokens.icon.action),
    pressed: individual,
    onClick: () => {
      setExpanded(PADDING_EXPANDER, !individual)
      invalidate()
    },
  })

  // Sides are written as longhands: the source writer maps `padding-left` and
  // friends, and splits an existing `p-*` shorthand when one side changes.
  const field = (id: string, label: Node, title: string, sides: Side[], tokenId: string) => {
    // NaN when one layer's own sides differ, so that layer alone reads Mixed too.
    const shared = sharedValue(context, (style) => {
      const values = sides.map((entry) => value(style, entry))
      return values.every((entry) => entry === values[0]) ? round(values[0]) : NaN
    })
    const same = shared !== null && !Number.isNaN(shared)
    const writes = (next: number) => sides.map((side) => ({ property: `padding-${side}`, value: `${round(next)}px` }))
    return numberField({
      id,
      label,
      title,
      value: same ? shared : null,
      placeholder: same ? undefined : MIXED,
      min: 0,
      token: fieldToken(context, sides.map((entry) => `padding-${entry}` as const), title, tokenId),
      onPreview: (next) => preview(writes(next)),
      onCommit: (next) => apply(writes(next), `Set ${title.toLowerCase()}`),
    })
  }
  const side = (name: Side) =>
    field(`autolayout.padding.${name}`, icon(PAD_GLYPH[name], tokens.icon.action), `Padding ${name}`, [name], `padding-${name}`)

  const rows = individual
    ? [
        propRow({ id: "autolayout.padding", caption: "Padding", cells: [side("left"), side("top")], trailing: toggle }),
        propRow({ id: "autolayout.padding-more", cells: [side("right"), side("bottom")] }),
      ]
    : [
        propRow({
          id: "autolayout.padding",
          caption: "Padding",
          cells: [
            field("autolayout.padding-x", icon("PadHorizontal", tokens.icon.action), "Horizontal padding", [
              "left",
              "right",
            ], "padding-x"),
            field("autolayout.padding-y", icon("PadVertical", tokens.icon.action), "Vertical padding", [
              "top",
              "bottom",
            ], "padding-y"),
          ],
          trailing: toggle,
        }),
      ]
  const block = el("div", { class: "de-stack de-lay-padding" }, rows)
  // Opened only on the render that follows the press — see `takeJustExpanded`.
  if (individual && takeJustExpanded(PADDING_EXPANDER)) revealGroup(rows[1])
  return block
}

/** `Clip content`: Figma's last row, for any element with children. */
export function clipContentRow(context: SectionContext): HTMLElement | null {
  const { selection, computed, writer, invalidate } = context
  if (selection.element.childElementCount === 0) return null
  const overflow = computed.overflowX || computed.overflow
  const clipped = overflow === "hidden" || overflow === "clip"
  const input = el("input", {
    type: "checkbox",
    class: "de-lay-check-input",
    "data-de-field": "autolayout.clip",
  }) as HTMLInputElement
  input.checked = clipped
  input.addEventListener("change", () => {
    writer.applyStyles(
      selection,
      [{ property: "overflow", value: input.checked ? "hidden" : "visible" }],
      input.checked ? "Clip content" : "Show overflow"
    )
    invalidate()
  })
  return propRow({
    id: "autolayout.clip",
    cells: [el("label", { class: "de-lay-check" }, [input, el("span", {}, ["Clip content"])])],
  })
}
