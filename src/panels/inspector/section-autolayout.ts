/**
 * Auto layout — Figma's stack panel, expressed as CSS flexbox.
 *
 * Only shown for elements that actually contain something: auto layout on a
 * leaf node is a control with no observable effect.
 *
 * Every control here sits under the caption Figma gives it — `Flow`,
 * `Alignment`, `Gap`, `Padding` (measured spec §6). The captions are not
 * decoration: this block asks five unrelated questions in a 240px column, and
 * the section header can only name the block, so without them a number in the
 * middle of the stack has nothing to say what it measures.
 */

import { el, round } from "../../core/dom"
import { revealGroup } from "../../core/leave"
import { icon } from "../../core/icons"
import type { IconName } from "../../core/icons"
import { tokens } from "../../core/tokens"
import {
  alignPad,
  group,
  iconButton,
  iconSegmented,
  isExpanded,
  numberField,
  segmented,
  setExpanded,
  takeJustExpanded,
} from "./field"
import type { SectionContext } from "./index"

type Direction = "none" | "horizontal" | "vertical" | "wrap"
type Place = "flex-start" | "center" | "flex-end"

const PLACES: Place[] = ["flex-start", "center", "flex-end"]

const PADDING_EXPANDER = "autolayout.padding"

/*
 * Four mutually exclusive states on one rail.
 *
 * These were `⊘ → ↓ ⤶` in four bare buttons, and the strip is where a typed
 * glyph fails most visibly: four characters from four different Unicode blocks,
 * resolved by whatever font covered each, arriving at four different weights and
 * two different sizes in a row of buttons that are all the same button. `⤶` is
 * outside the coverage of several system fonts entirely and rendered as a
 * missing-glyph box.
 *
 * The rail is the other half of the fix. A row of separate buttons says nothing
 * about how the four relate; a continuous track with one raised chip says the
 * answer is exactly one of these, which is what `display`/`flex-direction`/
 * `flex-wrap` collapse to here.
 *
 * AND THE MARKS ARE NOW FOUR ARRANGEMENTS OF THE SAME TWO BOXES.
 *
 * Replacing the typed characters with drawn ones fixed the weights and left the
 * subject wrong: `Ban`, `ArrowRight`, `ArrowDown` and `WrapText` are a
 * prohibition sign, two arrows and a picture of text, borrowed from four
 * unrelated corners of a general-purpose set. Read as a strip they describe
 * four different things, when this control has exactly one subject — where the
 * children of this element end up. The native glyphs draw that subject: the
 * same pair of rounded boxes, moved.
 *
 * `FlowNone` is three boxes scattered rather than a crossed-out anything. "Not
 * laid out" is a real arrangement, not the absence of one, and a `Ban` sign
 * says the control is unavailable rather than that this state is a choice.
 */
const FLOWS: Array<{ value: Direction; label: string; glyph: IconName }> = [
  { value: "none", label: "No auto layout", glyph: "FlowNone" },
  { value: "horizontal", label: "Horizontal", glyph: "FlowHorizontal" },
  { value: "vertical", label: "Vertical", glyph: "FlowVertical" },
  { value: "wrap", label: "Wrap", glyph: "FlowWrap" },
]

/**
 * The mark the chosen pad cell wears, indexed by `PLACES`.
 *
 * One glyph cannot state both axes, and the cross axis is the one worth
 * drawing. A cell's position in the pad already says where the children sit
 * along the main axis — that is what the three columns of a row differ by — so
 * the mark spends itself on the claim the stack makes about its children:
 * bars side by side under a top rule for a row aligned to the top, stacked bars
 * against a left rule for a column aligned left. Which family applies therefore
 * follows the flow, not the cell.
 */
const CROSS_GLYPH: Record<"horizontal" | "vertical", IconName[]> = {
  horizontal: ["AlignStartHorizontal", "AlignCenterHorizontal", "AlignEndHorizontal"],
  vertical: ["AlignStartVertical", "AlignCenterVertical", "AlignEndVertical"],
}

const PAD_GLYPH: Record<"top" | "right" | "bottom" | "left", IconName> = {
  top: "PadTop",
  right: "PadRight",
  bottom: "PadBottom",
  left: "PadLeft",
}

function directionOf(computed: CSSStyleDeclaration): Direction {
  const display = computed.display
  if (display !== "flex" && display !== "inline-flex") return "none"
  if (computed.flexWrap === "wrap" || computed.flexWrap === "wrap-reverse") return "wrap"
  return computed.flexDirection.startsWith("column") ? "vertical" : "horizontal"
}

function placeOf(value: string): Place {
  if (value === "center") return "center"
  if (value === "flex-end" || value === "end" || value === "right") return "flex-end"
  return "flex-start"
}

/**
 * Figma's 3x3 alignment pad, mapped onto justify-content + align-items.
 *
 * Nine cells row-major, and a cell's place in the grid IS its value: the row is
 * where the children sit vertically and the column where they sit horizontally,
 * whichever axis the stack runs along. Which of the two is `justify-content` and
 * which is `align-items` flips with the flow, and that flip is the only thing
 * this function computes.
 *
 * It used to build nine `iconButton`s at `width:100%;height:18px` in an
 * inline-styled grid, each drawing a `Circle`. The pad is one control with nine
 * positions, not nine buttons that happen to be adjacent, and `alignPad` is what
 * says so — it owns the block, and draws the rest in every unchosen cell itself,
 * which is why only the pressed cell is handed a real mark here.
 */
function alignmentPad(options: {
  vertical: boolean
  justify: Place
  align: Place
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
        pressed: justify === options.justify && align === options.align,
        glyph: icon(glyphs[PLACES.indexOf(align)], tokens.icon.action),
        onClick: () => options.onPick(justify, align),
      })
    }
  }
  return alignPad({ label: "Alignment", cells })
}

function paddingControls(
  context: SectionContext,
  apply: (property: string, value: string) => void,
  preview: (property: string, value: string) => void,
  /**
   * The `padding` token field, drawn under whichever number row is showing.
   *
   * Unlike the gap binding it goes INSIDE the group, because this group is full
   * width — there is room for a token's whole name here and none in the 88px
   * column `Gap` sits in. It stays put across the per-side toggle on purpose:
   * the four sides are a way of writing the same padding, and a binding that
   * vanished when a designer split the corners would look like splitting them
   * had unbound it.
   */
  binding?: HTMLElement | null
): HTMLElement {
  const { computed, invalidate } = context
  const sides = ["top", "right", "bottom", "left"] as const
  const values = sides.map((side) => Number.parseFloat(computed.getPropertyValue(`padding-${side}`)) || 0)
  const perSide = isExpanded(PADDING_EXPANDER)
  const toggle = iconButton({
    label: perSide ? "Link all sides" : "Set each side",
    // Four cells to split, one box to relink. Drawn at the `control` rung,
    // where this was a typed `⊞` at whatever size the button's text happened
    // to be — see the same toggle in `section-appearance.ts`.
    glyph: icon(perSide ? "Square" : "Grid2x2", tokens.icon.action),
    pressed: perSide,
    onClick: () => {
      setExpanded(PADDING_EXPANDER, !perSide)
      invalidate()
    },
  })

  if (!perSide) {
    const uniform = values.every((value) => value === values[0]) ? values[0] : null
    const field = numberField({
      id: "autolayout.padding",
      label: "P",
      title: "Padding",
      value: uniform,
      placeholder: uniform === null ? "Mixed" : undefined,
      min: 0,
      onPreview: (value) => preview("padding", `${round(value)}px`),
      onCommit: (value) => apply("padding", `${round(value)}px`),
    })
    // One field beside a 24px toggle, so the field takes what is left. There is
    // no grow utility in the stylesheet and this file may not add one.
    field.style.flex = "1"
    return group("Padding", el("div", { class: "de-row" }, [field, toggle]), binding ?? null)
  }

  const grid = el(
    "div",
    { class: "de-row--quad", style: "flex:1" },
    sides.map((side, index) =>
      numberField({
        id: `autolayout.padding.${side}`,
        // The drawn side, not its initial. `T R B L` is four letters that work
        // only once you already know the order they come in; the box with one
        // edge weighted says which side without being learned. `title` carries
        // the words, so the tooltip and the accessible name still read
        // "Padding top".
        label: icon(PAD_GLYPH[side], tokens.icon.action),
        title: `Padding ${side}`,
        value: values[index],
        min: 0,
        onPreview: (value) => preview(`padding-${side}`, `${round(value)}px`),
        onCommit: (value) => apply(`padding-${side}`, `${round(value)}px`),
      })
    )
  )
  const perSideGroup = group("Padding", el("div", { class: "de-row" }, [grid, toggle]), binding ?? null)
  // Opened only on the render that follows the press — see `takeJustExpanded`.
  // Every other rebuild of this panel leaves the group exactly as it found it.
  if (takeJustExpanded(PADDING_EXPANDER)) revealGroup(perSideGroup)
  return perSideGroup
}

/**
 * Whether this block draws its own `Gap` and `Padding` groups for this element.
 *
 * Exported for `section-unified-layout.ts`, which owns the spacing token
 * bindings and has to know which of them this block is about to give a home to.
 * Without it the two files each answer "does a gap control belong here?" from
 * different evidence and both say yes, which is the duplicate-control problem
 * this whole refactor exists to end — one property, two controls, a few rows
 * apart.
 *
 * It is deliberately the same two tests `autoLayoutControls` makes, in the same
 * order, rather than a restatement of them: a leaf node gets no block at all,
 * and a block whose direction is `none` draws only its flow strip. The second
 * is the one that catches people out — `directionOf` answers `none` for a grid,
 * so a grid container has a gap that this block does not draw a field for.
 */
export function drawsSpacingControls(context: SectionContext): boolean {
  if (context.selection.element.childElementCount === 0) return false
  return directionOf(context.computed) !== "none"
}

/**
 * The auto-layout block: flow, alignment, gap and padding.
 *
 * Returns the controls and nothing around them — Layout is one section made of
 * two blocks and this is the second, see `section-unified-layout.ts`. Null for a
 * leaf node, which is the caller's cue to leave the block out entirely.
 *
 * `bindings` are the design-system token fields for the two distances this
 * block draws numbers for. They arrive from the caller rather than being built
 * here because the catalogue they come from is the Layout section's business
 * and not auto layout's — but they are DRAWN here, under the number field each
 * one answers, because that is the only place a designer would look for them.
 * The alternative, which this replaced, was a second spacing block further down
 * the same section: the same property, twice, in two shapes, which is exactly
 * what dissolving the old `Design system` section was for. Absent when the
 * project stocks no spacing tokens, and the groups then look as they always did.
 */
export function autoLayoutControls(
  context: SectionContext,
  bindings: { gap?: HTMLElement | null; padding?: HTMLElement | null } = {}
): HTMLElement | null {
  const { selection, computed, writer, invalidate } = context
  if (selection.element.childElementCount === 0) return null

  const direction = directionOf(computed)
  const vertical = direction === "vertical"
  const justify = placeOf(computed.justifyContent)
  const align = placeOf(computed.alignItems)
  const spaceBetween = computed.justifyContent === "space-between"

  // Numeric commits deliberately skip `invalidate`: the inspector rebuilds on
  // the next frame, which would tear the field out from under a drag-scrub.
  const apply = (property: string, value: string) => {
    writer.applyStyles(selection, [{ property, value }], `Set ${property}`)
  }
  const preview = (property: string, value: string) => {
    selection.element.style.setProperty(property, value)
  }

  const setDirection = (next: Direction) => {
    const writes =
      next === "none"
        ? [{ property: "display", value: "block" }]
        : [
            { property: "display", value: "flex" },
            { property: "flex-direction", value: next === "vertical" ? "column" : "row" },
            { property: "flex-wrap", value: next === "wrap" ? "wrap" : "nowrap" },
          ]
    writer.applyStyles(selection, writes, "Set auto layout")
    invalidate()
  }

  const flow = group(
    "Flow",
    iconSegmented({
      label: "Flow",
      value: direction,
      options: FLOWS.map((entry) => ({
        value: entry.value,
        label: entry.label,
        glyph: icon(entry.glyph, tokens.icon.action),
      })),
      onCommit: (next) => {
        // Looked up rather than cast: `iconSegmented` speaks in strings, and a
        // cast would let a renamed flow through the compiler into a bad write.
        const entry = FLOWS.find((candidate) => candidate.value === next)
        if (entry) setDirection(entry.value)
      },
    })
  )

  if (direction === "none") return flow

  const gapField = numberField({
    id: "autolayout.gap",
    /*
     * The mark, not the word — the caption above this field already says "Gap",
     * and printing it again inside the control is the panel telling you the
     * same thing twice in 24px. It is also the pair that makes the wrap case
     * readable: two fields labelled "Gap" and "Row" do not look like one
     * question asked about two axes, and two glyphs of the same two bars turned
     * ninety degrees do.
     */
    label: icon("GapColumn", tokens.icon.action),
    title: "Gap between children",
    value: Number.parseFloat(computed.columnGap) || 0,
    min: 0,
    disabled: spaceBetween,
    onPreview: (value) => preview("gap", `${round(value)}px`),
    onCommit: (value) => apply("gap", `${round(value)}px`),
  })

  // Wrapping splits the gap in two: the cross-axis gap is its own declaration,
  // and without it a wrapped stack has rows touching. It stacks under the same
  // `Gap` caption, because it is the same question asked about the other axis.
  const rowGapField =
    direction === "wrap"
      ? numberField({
          id: "autolayout.rowgap",
          label: icon("GapRow", tokens.icon.action),
          title: "Gap between wrapped rows",
          value: Number.parseFloat(computed.rowGap) || 0,
          min: 0,
          onPreview: (value) => preview("row-gap", `${round(value)}px`),
          onCommit: (value) => apply("row-gap", `${round(value)}px`),
        })
      : null

  const pad = alignmentPad({
    vertical,
    justify,
    align,
    onPick: (nextJustify, nextAlign) => {
      writer.applyStyles(
        selection,
        [
          // Space-between owns the main axis; the pad only moves the cross axis
          // while it is on, so picking a cell cannot silently repack the stack.
          { property: "justify-content", value: spaceBetween ? "space-between" : nextJustify },
          { property: "align-items", value: nextAlign },
        ],
        "Set alignment"
      )
      invalidate()
    },
  })

  /*
   * Packed or spread, as a two-way switch.
   *
   * Figma does not spell it this way: distribution lives in the auto-layout
   * settings modal as Between / Evenly / Around, three named distributions
   * rather than one toggle. We keep the toggle because it is what our write path
   * can express in both directions. `placeOf` reads `justify-content` back into
   * one of three places, so a `space-evenly` we wrote here would come back as
   * `start` on the next rebuild — a third option you could set and never see set
   * is worse than two that round-trip.
   *
   * Uncaptioned, alone among the controls in this block: `Packed` and `Space
   * between` are already the words a caption would have used.
   */
  const spacingMode = segmented({
    label: "Spacing mode",
    value: spaceBetween ? "between" : "packed",
    options: [
      { value: "packed", label: "Packed", title: "Children keep the set gap" },
      { value: "between", label: "Space between", title: "Children spread to fill the space" },
    ],
    onCommit: (next) => {
      writer.applyStyles(
        selection,
        [{ property: "justify-content", value: next === "between" ? "space-between" : justify }],
        "Set distribution"
      )
      invalidate()
    },
  })

  return el("div", { class: "de-stack" }, [
    flow,
    // The pad and the gap share a row, each in one of the two 88px columns the
    // panel splits into — which is Figma's own arrangement, and the reason the
    // pad is 56px tall rather than as wide as the panel: the alignment of a
    // stack and the distance between its children are one question asked twice,
    // and reading them side by side is cheaper than scrolling between them.
    el("div", { class: "de-row--split" }, [
      group("Alignment", pad),
      /*
       * The binding goes IN the Gap column, under the number it answers, and
       * the column is the narrow one.
       *
       * It sat full width beneath this row first, to give a token name like
       * `Spacing/Comfortable` room to be read rather than ellipsed to eight
       * characters. Rendered, that was the wrong trade: the alignment pad is
       * three rows tall and the gap field is one, so a full-width field lands
       * directly under the PAD and reads as belonging to it — or to both — and
       * a control whose subject is ambiguous is worse than one whose value is
       * abbreviated. The column also has the vertical room going spare, which
       * is what made the wide version look deliberate when it was not.
       *
       * Truncation is recoverable and mis-attribution is not: the field carries
       * its full name in `aria-label`, and opening it shows every name in full.
       */
      group("Gap", gapField, rowGapField, bindings.gap ?? null),
    ]),
    spacingMode,
    paddingControls(context, apply, preview, bindings.padding),
  ])
}
