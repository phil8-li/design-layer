/**
 * Appearance — Figma's Layer section: opacity and corner radius.
 *
 * Paint lives in its own Fill / Stroke / Effects sections below, the way Figma
 * splits them, so a row-list affordance never has to share a header with a
 * scalar field.
 *
 * ## The radius token rows moved in, and the second expander went away
 *
 * `corner-radius` and its four per-corner siblings used to be drawn a second
 * time, thirty rows further up, by the `Design system` section — a panel of
 * token pickers for properties other sections already had controls for. That
 * section is gone (see `token-row.ts` for the whole argument), so the radius
 * bindings now sit in the group that already asks the radius question.
 *
 * The merge is not just a move, because the two halves each carried their OWN
 * disclosure. This group's `Grid2x2`/`Square` toggle splits one number into
 * four, and the old section's double chevron unfolded a list that happened to
 * begin with four per-corner token rows. A designer who wanted to set the
 * top-left corner by token therefore had to find and open a DIFFERENT control
 * from the one they had just opened to set it by number, and having opened one
 * there was nothing to say the other existed.
 *
 * So there is one toggle now — `appearance.radius` — and it governs both
 * halves. Folded: the uniform number, and the uniform binding under it.
 * Unfolded: the four numbers, and the four per-corner bindings under them. One
 * decision, asked once, answered in whichever spelling the designer reaches
 * for.
 *
 * The binding is a bare `tokenControl` rather than the captioned `tokenRow`,
 * because the group caption above it already says `Corner radius`; a captioned
 * block here would print that phrase twice in eight vertical pixels. The hints
 * `tokenRow` would have carried come back separately through `tokenHints` —
 * "could be X or Y" is the honesty the picker is built around and is not worth
 * a tidier row.
 */

import { el, round } from "../../core/dom"
import { revealGroup } from "../../core/leave"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import {
  group,
  iconButton,
  isExpanded,
  numberField,
  setExpanded,
  takeJustExpanded,
} from "./field"
import { styledSection } from "../../options/panel"
import { hasUtility, tokenControl, tokenHints, tokenRow } from "./token-row"
import type { InspectorSection } from "./index"

const CORNERS = [
  { key: "top-left", label: "TL" },
  { key: "top-right", label: "TR" },
  { key: "bottom-right", label: "BR" },
  { key: "bottom-left", label: "BL" },
] as const

const RADIUS_EXPANDER = "appearance.radius"

export const appearanceSection: InspectorSection = (context) => {
  // Destructured here rather than in the parameter list: the token helpers take
  // the whole `SectionContext`, and handing them a partial rebuilt from four
  // fields is how one of them ends up reading a stale `selections` or losing
  // the editor it needs to describe another element.
  const { selection, computed, writer, invalidate } = context

  const apply = (property: string, value: string) => {
    writer.applyStyles(selection, [{ property, value }], `Set ${property}`)
  }
  const preview = (property: string, value: string) => {
    selection.element.style.setProperty(property, value)
  }

  const radii = CORNERS.map(
    (corner) => Number.parseFloat(computed.getPropertyValue(`border-${corner.key}-radius`)) || 0
  )
  const perCorner = isExpanded(RADIUS_EXPANDER)
  /*
   * Four cells to split, one box to relink — a drawn glyph at the `control`
   * rung, where this was a typed `⊞`.
   *
   * A Unicode character is not an icon. It was drawn by whatever font resolved
   * it, at the BUTTON's text size rather than at a rung of the icon ramp, in a
   * weight nothing here controlled, and it arrived visibly smaller than every
   * real glyph in the same panel. Nothing caught it, because it was never a
   * size the design system had an opinion about: the size ramp only governs
   * what goes through `icon()`.
   */
  const radiusToggle = iconButton({
    label: perCorner ? "Link all corners" : "Set each corner",
    glyph: icon(perCorner ? "Square" : "Grid2x2", tokens.icon.action),
    pressed: perCorner,
    onClick: () => {
      setExpanded(RADIUS_EXPANDER, !perCorner)
      invalidate()
    },
  })

  const uniformRadius = radii.every((value) => value === radii[0]) ? radii[0] : null
  const radiusField = numberField({
    id: "appearance.radius",
    /*
     * `icon.action`, the rung every glyph label in this column uses.
     *
     * A field label slot holds either a word or a glyph, and in this column the
     * two alternate down the stack: `CornerRadius` here, TL/TR/BR/BL as words
     * underneath. Those words set at 12px/400, whose stems render around
     * 1.0–1.1px. The previous set stroked this rung at 1.5px and read 40%
     * heavier than the words; a Phosphor glyph at 16px draws a 1.1px line
     * (see `STROKE_FOR_SIZE` in `tools/build-icons.mjs`), so the two now
     * match without moving the rung.
     */
    label: icon("CornerRadius", tokens.icon.action),
    title: "Corner radius",
    value: uniformRadius,
    placeholder: uniformRadius === null ? "Mixed" : undefined,
    min: 0,
    onPreview: (value) => preview("border-radius", `${round(value)}px`),
    onCommit: (value) => apply("border-radius", `${round(value)}px`),
  })
  radiusField.style.flex = "1"

  /*
   * A corner only takes a per-corner token when it is a corner: the old section's
   * rule, carried over unchanged. A square box with no `rounded-*` utility on it
   * would otherwise grow four pickers whose every choice is a change of shape
   * nobody asked the group about — and the uniform binding above already offers
   * exactly that in one gesture.
   */
  const cornerTokens = radii.some((value) => value > 0) || hasUtility(selection.element, "rounded")

  const radiusControls: Array<Node | null> = perCorner
    ? [
        el("div", { class: "de-row" }, [
          el(
            "div",
            { class: "de-row--quad", style: "flex:1" },
            CORNERS.map((corner, index) =>
              numberField({
                id: `appearance.radius.${corner.key}`,
                label: corner.label,
                title: `Radius ${corner.key.replace("-", " ")}`,
                value: radii[index],
                min: 0,
                onPreview: (value) => preview(`border-${corner.key}-radius`, `${round(value)}px`),
                onCommit: (value) => apply(`border-${corner.key}-radius`, `${round(value)}px`),
              })
            )
          ),
          radiusToggle,
        ]),
        // Captioned, unlike the uniform binding: four bindings in a column need
        // four names, and `TL` is a two-letter strip on a number field rather
        // than a caption anything else in this stack could borrow.
        //
        // Built only while the toggle is open, which is the other half of what
        // the two expanders used to do separately: each of these probes a
        // resolved value per token on every panel rebuild, and a scrub rebuilds
        // the panel on commit.
        //
        // `cornerTokens` chooses between the four and the ONE, never between
        // the four and nothing. A square box with the fold open used to bind no
        // radius at all: the uniform row had gone with the fold, and the four
        // meant to replace it were gated away — so the one arrangement where a
        // designer has explicitly asked for MORE corner control was the
        // arrangement with less. It could not happen before this section
        // absorbed these rows, because the uniform binding lived behind a fold
        // of its own, which is exactly the kind of hole a merge puts in a seam.
        ...(cornerTokens
          ? CORNERS.map((corner) =>
              tokenRow(
                context,
                `corner-radius-${corner.key}`,
                `Radius ${corner.key.replace("-", " ")}`
              )
            )
          : [
              tokenControl(context, "corner-radius", "Corner radius"),
              tokenHints(context, "corner-radius", "Corner radius"),
            ]),
      ]
    : [
        el("div", { class: "de-row" }, [radiusField, radiusToggle]),
        tokenControl(context, "corner-radius", "Corner radius"),
        tokenHints(context, "corner-radius", "Corner radius"),
      ]

  const radiusGroup = group("Corner radius", ...radiusControls)
  /*
   * Opened only on the render that follows the press — see `takeJustExpanded`.
   * Every other rebuild of this panel, of which there is one per commit, leaves
   * the group exactly as it found it.
   */
  if (takeJustExpanded(RADIUS_EXPANDER)) revealGroup(radiusGroup)

  /*
   * Captions, and the words are Figma's own: `Opacity` and `Corner radius`.
   *
   * This section had neither, and paid for it twice. The opacity field carried
   * the word `Opacity` in its own leading strip — a seven-letter label in a
   * ~20px slot, sitting in a panel where every other field is labelled `W`,
   * `H`, `R` or a drawn mark — and the radius row had no name at all, so `R`
   * was the only clue that a field called `R` set a corner radius.
   *
   * Naming the group and drawing the field is the trade Figma makes everywhere,
   * and it is the right way round: the caption has room for a phrase and is
   * read once, the strip has room for a mark and is read every time.
   */
  const body = el("div", { class: "de-stack" }, [
    group(
      "Opacity",
      numberField({
        id: "appearance.opacity",
        label: icon("Opacity", tokens.icon.action),
        title: "Opacity (%)",
        value: (Number.parseFloat(computed.opacity) || 0) * 100,
        min: 0,
        max: 100,
        suffix: "%",
        onPreview: (value) => preview("opacity", String(round(value / 100, 3))),
        onCommit: (value) => apply("opacity", String(round(value / 100, 3))),
      })
    ),
    radiusGroup,
  ])

  return styledSection(context, "appearance", "Appearance", body)
}
