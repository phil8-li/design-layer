/**
 * Figma's Layout section: `Layout` for a box that does not lay out its
 * children, `Auto layout` for one that does.
 *
 * The rows come from two files and interleave in Figma's order — Flow (+ Wrap)
 * from `section-autolayout.ts`, Dimensions / Resizing (+ aspect lock) from
 * `section-layout.ts`, then Alignment + Gap, Padding and Clip content. Every one
 * is a `propRow`, so the column-3 toggles stand on one vertical line.
 *
 * ## The spacing bindings, and why they hang off the SECTION
 *
 * Where the auto-layout rows draw gap and padding fields, each field carries
 * its own token binding (Figma's "Apply variable"), so nothing for gap or
 * padding is drawn here. `drawsSpacingControls` is that file's own answer to
 * "did I draw them"; asking it rather than re-deriving the condition is what
 * keeps one property from getting two controls.
 *
 * Where they do not, the token rows below are the only way to bind those
 * axes, on the gates they have always had — padding on any element with
 * children, gap on any flex or grid box even when it has none — so a plain
 * `<div>` with children still has its padding binding. `margin` has no field
 * anywhere in the inspector, so its rows stay in every case: `Uniform margin`
 * in the open half, its four sides behind the expander.
 */

import { el } from "../../core/dom"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { registerCommand } from "../../core/commands"
import { isExpanded, propRow, setExpanded, takeJustExpanded, trailingToggle } from "./field"
import { styledSection } from "../../options/panel"
import { revealGroup } from "../../core/leave"
import { laysOutChildren, SIDES, tokenRow } from "./token-row"
import { sizeControls } from "./section-layout"
import {
  autoLayoutRows,
  autoLayoutToggle,
  clipContentRow,
  drawsSpacingControls,
  flowOf,
  flowRow,
  layoutTitle,
  setFlow,
} from "./section-autolayout"
import type { InspectorSection, SectionContext } from "./index"

/** Panel-level, so opening the per-side rows survives the rebuild each write causes. */
const PRECISION_EXPANDER = "layout.spacing-precision"

/**
 * Gap, padding and margin as design-system bindings, on the gates each row
 * arrived with. Each sits in a `propRow` cell so its field spans the same two
 * columns as the fields above it.
 *
 * Null when the design system stocks no spacing token: margin is ungated, so a
 * null uniform-margin row means there is nothing to offer on any other axis.
 */
function spacingBindings(context: SectionContext, housed: boolean): HTMLElement | null {
  const { selection, computed } = context
  const laysOut = laysOutChildren(computed)
  const hasChildren = selection.element.childElementCount > 0

  // `housed` says the auto-layout fields bind gap and padding themselves.
  // Drawing rows for them here would be a duplicate; skipping them when there
  // are no fields would delete the only control a non-flex element has.
  const uniform = [
    laysOut && !housed ? tokenRow(context, "gap", "Container gap") : null,
    hasChildren && !housed ? tokenRow(context, "padding", "Uniform padding") : null,
    tokenRow(context, "margin", "Uniform margin"),
  ].filter((row): row is HTMLElement => row !== null)
  if (!uniform.length) return null

  const open = isExpanded(PRECISION_EXPANDER)
  const toggle = trailingToggle({
    label: open ? "Hide per-side tokens" : "Show per-side tokens",
    // A double chevron: this toggle lengthens a list, where the padding and
    // corner toggles split one value into four.
    glyph: icon(open ? "ChevronsDownUp" : "ChevronsUpDown", tokens.icon.action),
    pressed: open,
    onClick: () => {
      setExpanded(PRECISION_EXPANDER, !open)
      context.invalidate()
    },
  })

  // Built only when open: each row probes a resolved value per token on every
  // rebuild, and a rebuild follows every write.
  const perSide = open
    ? [
        ...(laysOut && !housed
          ? [tokenRow(context, "row-gap", "Row gap"), tokenRow(context, "column-gap", "Column gap")]
          : []),
        ...(hasChildren && !housed
          ? SIDES.map((side) => tokenRow(context, `padding-${side}`, `Padding ${side}`))
          : []),
        ...SIDES.map((side) => tokenRow(context, `margin-${side}`, `Margin ${side}`)),
      ]
    : []

  const cell = (row: HTMLElement | null) => (row ? propRow({ cells: [row] }) : null)
  // Only the rows open, not the header that discloses them: the toggle was on
  // screen before the press and should not animate in again.
  const precisionRows = el("div", { class: "de-stack" }, perSide.map(cell))
  if (perSide.length > 0 && takeJustExpanded(PRECISION_EXPANDER)) revealGroup(precisionRows)

  return el("div", { class: "de-layout-group" }, [
    // The title names the family; the toggle takes column 3 like every other
    // disclosure in the section.
    propRow({
      id: "layout.spacing",
      cells: [el("div", { class: "de-layout-group-title" }, ["Spacing"])],
      trailing: toggle,
    }),
    ...uniform.map(cell),
    precisionRows,
  ])
}

/**
 * Shift+A and Option+Shift+A, Figma's add and remove auto layout.
 *
 * Registered on every render so the command acts on the panel's current
 * context, and guarded so a key pressed after the selection moved on does not
 * write to an element the panel no longer shows.
 */
function registerAutoLayoutCommands(context: SectionContext): void {
  const current = () => {
    const head = context.editor.getState().selection[0]
    return head?.element === context.selection.element && context.selection.element.isConnected
  }
  registerCommand("layout.auto.add", () => {
    if (!current() || context.selection.element.childElementCount === 0) return
    if (flowOf(context.computed) === "none") setFlow(context, "horizontal")
  })
  registerCommand("layout.auto.remove", () => {
    if (!current()) return
    if (flowOf(context.computed) !== "none") setFlow(context, "none")
  })
}

export const unifiedLayoutSection: InspectorSection = (context: SectionContext) => {
  registerAutoLayoutCommands(context)

  const housed = drawsSpacingControls(context)
  const rows = autoLayoutRows(context)

  return styledSection(
    context,
    "layout",
    layoutTitle(context),
    el("div", { class: "de-stack" }, [
      el("div", { class: "de-layout-group" }, [
        flowRow(context),
        sizeControls(context),
        ...rows,
        clipContentRow(context),
      ]),
      spacingBindings(context, housed),
    ]),
    autoLayoutToggle(context) ?? undefined
  )
}
