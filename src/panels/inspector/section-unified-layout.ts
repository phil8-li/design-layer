/**
 * Current Figma UI3 groups sizing and auto layout into one Layout section.
 *
 * The two halves arrive as CONTENT, not as sections: `sizeControls` and
 * `autoLayoutControls` each return their block of controls and nothing around
 * it. This file used to call them as inspector sections and then throw away the
 * header and body it did not want by walking two levels of someone else's DOM —
 * `node.lastElementChild.firstElementChild`. That held only for as long as
 * `section()` kept the exact shape it had the day it was written, and it failed
 * silently by construction: a miss returned null, a null block was filtered out,
 * and the whole of Auto layout would have disappeared with no error anywhere.
 * A section is a header plus a body; asking one for its body means asking the
 * function that builds it, not unwrapping the result.
 *
 * Only the auto-layout half is titled. The captions inside — `Dimensions`,
 * `Flow`, `Alignment`, `Gap`, `Padding` — are Figma's own and name every control
 * group already, so `Size` stacked above a `Dimensions` caption would be the
 * same word twice. `Auto layout` stays because it names a FEATURE, which is the
 * one thing none of the captions under it say.
 *
 * ## The spacing bindings moved in, and why they hang off the SECTION
 *
 * `gap`, `padding` and `margin` — uniform, per side and per axis — were rows in
 * a `Design system` section that asked which named step a distance comes from
 * thirty rows away from the fields that set the distance. That section is gone
 * (`token-row.ts` explains the whole move), and spacing is a Layout question, so
 * its bindings land here, below both halves: size is what the box IS, auto
 * layout is how it arranges its children, and these name the step the distances
 * between and around them come from.
 *
 * They belong to the section rather than to the auto-layout block inside it, and
 * that is not a filing preference. `autoLayoutControls` returns null outright for
 * a leaf node, and shrinks to the flow rail alone for anything whose display is
 * not flex — including a grid container, which `directionOf` also reads as
 * "none". So its `Gap` and `Padding` groups do not exist on a plain `<div>` with
 * children. The rows being carried over are drawn on far wider gates: padding on
 * any element with children, margin on EVERY element, gap on any flex or grid box
 * even when it has none. Folding them into those groups would have silently
 * deleted a row from every non-flex element in the document, which is the one
 * regression this merge had to avoid, so each binding keeps the gate it arrived
 * with and the block is drawn whenever those gates pass.
 *
 * Where the auto-layout block DOES draw a field, the binding goes to it rather
 * than being drawn again here. `drawsSpacingControls` is that block's own answer
 * to "did I draw a `Gap` and a `Padding` group for this element", and this file
 * hands those two bindings over when it says yes — so a flex container gets one
 * gap control with its token field under it, and a plain `<div>` with children
 * still gets the padding binding down here where its only home is. Asking the
 * block instead of re-deriving the condition is the point: two files reasoning
 * separately about whether a gap field exists is how both of them draw one.
 *
 * `margin` is the one that would have been a real loss rather than a duplicate.
 * Nothing else in the inspector writes it — not this section, not Position — so
 * this block is the only way to set a margin at all. That is also why
 * `Uniform margin` sits in the open half while its four sides sit behind the
 * expander: the axis with no other control is not the one to hide.
 */

import { el } from "../../core/dom"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { isExpanded, miniButton, setExpanded, takeJustExpanded } from "./field"
import { styledSection } from "../../options/panel"
import { revealGroup } from "../../core/leave"
import { laysOutChildren, SIDES, tokenControl, tokenRow } from "./token-row"
import { sizeControls } from "./section-layout"
import { autoLayoutControls, drawsSpacingControls } from "./section-autolayout"
import type { InspectorSection, SectionContext } from "./index"

/** Panel-level, so opening the per-side rows survives the rebuild each write causes. */
const PRECISION_EXPANDER = "layout.spacing-precision"

/**
 * Gap, padding and margin as design-system bindings — the spacing half of the
 * vocabulary, on the gates each row arrived with.
 *
 * Null when the design system stocks no spacing token: every axis here reads the
 * one `spacing` catalog, and `margin` is ungated, so a null uniform-margin row is
 * proof there is nothing to offer on any of the other twelve either.
 */
function spacingBindings(context: SectionContext, housed: boolean): HTMLElement | null {
  const { selection, computed } = context
  const laysOut = laysOutChildren(computed)
  const hasChildren = selection.element.childElementCount > 0

  // `housed` says the auto-layout block above took the gap and padding bindings
  // and drew them under its own number fields. Drawing them again here is the
  // duplicate this refactor exists to remove — and skipping them when the block
  // did NOT take them would silently delete the only control a non-flex element
  // has for either, which is the opposite mistake and the worse one.
  const uniform = [
    laysOut && !housed ? tokenRow(context, "gap", "Container gap") : null,
    hasChildren && !housed ? tokenRow(context, "padding", "Uniform padding") : null,
    tokenRow(context, "margin", "Uniform margin"),
  ].filter((row): row is HTMLElement => row !== null)
  if (!uniform.length) return null

  const open = isExpanded(PRECISION_EXPANDER)
  const toggle = miniButton({
    label: open ? "Hide per-side tokens" : "Show per-side tokens",
    /*
     * A double chevron, drawn at the `row` rung. Not the `Grid2x2`/`Square` pair
     * the corner and padding toggles use: those SPLIT one value into four, and
     * this one lengthens a LIST. A double chevron says "there is more of this
     * below", which is what the control does, and it cannot be confused with the
     * single chevron already spent on section disclosure and the layer twisty.
     */
    glyph: icon(open ? "ChevronsDownUp" : "ChevronsUpDown", tokens.icon.marker),
    pressed: open,
    onClick: () => {
      setExpanded(PRECISION_EXPANDER, !open)
      context.invalidate()
    },
  })

  // Built only when open, and the saving is not cosmetic: each row probes a
  // resolved value per token on every panel rebuild, and a rebuild follows every
  // write. Ten selects nobody is looking at is ten probes per keystroke.
  const perSide = open
    ? [
        ...(laysOut
          ? [tokenRow(context, "row-gap", "Row gap"), tokenRow(context, "column-gap", "Column gap")]
          : []),
        ...(hasChildren ? SIDES.map((side) => tokenRow(context, `padding-${side}`, `Padding ${side}`)) : []),
        ...SIDES.map((side) => tokenRow(context, `margin-${side}`, `Margin ${side}`)),
      ]
    : []

  /*
   * Only the ROWS open, not the header that discloses them.
   *
   * The toggle and its caption live in this block too and were on screen before
   * the press, so opening the whole thing from zero would animate the control
   * the user just clicked out of existence and back in. Wrapping the rows is
   * what makes them addressable separately — they used to be spread straight
   * into the group beside the header.
   */
  const precisionRows = el("div", { class: "de-layout-group" }, perSide)
  const precision = el("div", { class: "de-layout-group" }, [
    el("div", { class: "de-row" }, [
      el("div", { class: "de-layout-group-title", style: "flex:1" }, ["Per side and axis"]),
      toggle,
    ]),
    precisionRows,
  ])
  if (perSide.length > 0 && takeJustExpanded(PRECISION_EXPANDER)) revealGroup(precisionRows)

  return el("div", { class: "de-layout-group" }, [
    // The rows name their own axis — `Container gap`, `Uniform margin` — so the
    // block caption names the family they belong to, the way `Auto layout` names
    // the block above rather than any control in it.
    el("div", { class: "de-layout-group-title" }, ["Spacing"]),
    ...uniform,
    precision,
  ])
}

export const unifiedLayoutSection: InspectorSection = (context: SectionContext) => {
  /*
   * The two bindings the auto-layout block can house, built here and handed to
   * it.
   *
   * Built here because the catalogue is this section's business — the block
   * below knows about flex, not about tokens — and drawn there because the only
   * place a designer looks for "which step is this gap" is under the field
   * showing the gap. `tokenControl` rather than `tokenRow`: the group's own
   * caption already names the axis, and a second caption inside it would print
   * `Gap` twice.
   */
  const housed = drawsSpacingControls(context)
  const auto = autoLayoutControls(
    context,
    housed
      ? {
          gap: tokenControl(context, "gap", "Container gap"),
          padding: tokenControl(context, "padding", "Uniform padding"),
        }
      : {}
  )

  return styledSection(
    context,
    "layout",
    "Layout",
    el("div", { class: "de-stack" }, [
      el("div", { class: "de-layout-group" }, [sizeControls(context)]),
      auto
        ? el("div", { class: "de-layout-group" }, [
            el("div", { class: "de-layout-group-title" }, ["Auto layout"]),
            auto,
          ])
        : null,
      spacingBindings(context, housed),
    ])
  )
}
