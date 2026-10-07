/**
 * THE tooltip. One element, one geometry, one set of colours.
 *
 * This replaces three hand-rolled CSS-only tips that agreed on nothing:
 *
 *   `.de-toolbar [data-de-tip]::after`        always above, nowrap, 400ms in
 *   `.de-ann-help[data-de-tip]::after`        always above, stretched across
 *                                             the whole row, wrapped, 400ms in
 *   `.de-ann-item-actions [data-de-tip]::after`  always below, right-aligned,
 *                                             wrapped to 180px, no delay
 *
 * Each of those was right about its own surface and wrong as a rule, and each
 * one paid the same price for being a pseudo-element: `content: attr()` cannot
 * measure anything, so a tip that would run off the screen runs off the screen.
 * The two that tried to dodge that did it with geometry — pin the card to the
 * ROW so it cannot reach the panel edge, hang it off the RIGHT so it cannot
 * reach the left one — which works until the surface moves and is invisible as
 * a constraint to whoever moves it.
 *
 * So the card is drawn here and placed by `core/tooltip.ts` from real numbers.
 * This file owns everything that does not depend on where the pointer is; that
 * module owns everything that does.
 *
 * ---------------------------------------------------------------------------
 * THE KIT'S TOOLTIP (MICRO-INTERACTIONS § 7)
 *
 * Zero open delay, no entrance, a 150ms exit fading to 0.99. The surface is
 * INVERSE — the text colour as the fill, the ground colour as the ink — at 12px
 * with 6x12 padding on a `radius.lg` corner, 6px off its control. Warm hover:
 * a tip opening within 320ms of the last one closing, near enough to it, travels
 * from where the old one was over 150ms on `easeReveal`, translate only —
 * animating the size would rewrap the label mid-flight, so the size jumps.
 *
 *   .de-tip        THE BOX ON SCREEN. Placed with a `translate()` and given an
 *                  explicit `width`/`height` by `core/tooltip.ts`. The travel
 *                  is a CSS transition on that transform, so an interrupted
 *                  run restarts from where the card visibly is.
 *   .de-tip-box    THE SURFACE, and the exit fade.
 *   .de-tip-layer  The label's slot. Two exist from the port this replaced;
 *                  only one is ever shown now, and nothing crossfades.
 *   .de-tip-face   THE TEXT. Padding and typography, and the only thing whose
 *                  natural size is ever measured.
 *
 * What went, from the React Bits `WarmTooltip` port this was: the 400ms cold
 * wait, the 160ms pop (scale 0.94, 4px blur, 4px rise), the blurred sliding
 * label swap and the 320ms spring on position AND size. Each is a kit rule
 * broken: tooltips open instantly, nothing blurs or slides in, and only
 * translate travels.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ELEMENT LIVES ON `<body>` AND NOT IN `.de-root`
 *
 * `.de-root` is a stacking context at 2147483000, and four surfaces in this
 * chrome deliberately sit ABOVE it on `<body>`: the annotation layer and the
 * options window at 2147483100, the app chooser's menu at 2147483250, the
 * shortcuts sheet at 2147483400. A tooltip parented into the root could not
 * reach any of them — the one element whose entire job is to be on top would be
 * the one element that is not. `Z` clears all four.
 *
 * The cost is one rule, at the bottom of this file. `css/base.ts` clamps the
 * chrome's durations under `prefers-reduced-motion` with a selector that reads
 * `[data-designlayer] *` — DESCENDANTS of a chrome element. The card carries
 * the chrome attribute itself but its parent is `<body>`, so it is a chrome
 * ROOT and the blanket rule does not reach it. Its children DO match it, which
 * is why the restatement below only has to name `.de-tip`.
 */

import { tokens as t } from "../tokens"

/**
 * Above the shortcuts sheet (2147483400), which is the highest surface this
 * chrome draws. Nothing is allowed over a tooltip: an occluded tip is a tip the
 * person hovering has no way to know they asked for.
 */
const Z = 2147483500

/**
 * How wide a wrapped tip gets before it takes another line.
 *
 * The three sheets this replaces said 180px (row actions), the panel's own
 * width (the help dot) and "as long as it likes" (the toolbar). 260 is the
 * inspector's width — the widest surface a tip is likely to be explaining —
 * and it holds roughly eight words of the 12px body, which is the length past
 * which a hint has stopped being a label and should be somewhere a reader can
 * keep it on screen.
 *
 * Exported because `core/tooltip.ts` decides WHEN to wrap and this file decides
 * HOW WIDE, and those are the same number: a cap the runtime does not know
 * about is a line it never switches, and a line it switches at some other width
 * is a card that wraps early or overflows. One constant, two readers.
 */
export const TIP_WRAP_WIDTH = 260

/** The kit's exit: dismissal is bounded and quiet. */
export const TIP_CLOSE_MS = Number.parseFloat(t.duration.exit)
/** Warm-hover travel, the kit's `--duration-exit` on `easeReveal`. */
export const TIP_TRAVEL_MS = Number.parseFloat(t.duration.exit)
/** What the card shrinks to as it fades out (the kit's `surface-exit`). */
const EXIT_SCALE = 0.99

export const tooltipCss = `/* ---------- tooltip ---------- */
/*
 * The outer box: position AND size, both written inline by \`core/tooltip.ts\`.
 *
 * Positioned with a \`translate()\` so the warm-hover travel is a composited
 * transform rather than a layout per frame. \`--de-tip-travel\` is its duration:
 * 0 for every placement except a warm hand-off between neighbours, where the
 * runtime sets the kit's 150ms. The size is real pixels and is never
 * transitioned.
 *
 * \`width: max-content\` is the resting default, for the frame before the first
 * measurement lands and for anything that reads the card before it is shown.
 */
.de-tip {
  position: fixed;
  left: 0;
  top: 0;
  z-index: ${Z};
  width: max-content;
  /*
   * Never hit-testable, in either state. A tooltip that takes the pointer takes
   * it away from the control underneath, and the card sits 6px off that
   * control — close enough that a diagonal mouse path crosses it.
   */
  pointer-events: none;
  /*
   * Hidden between shows, and hidden LATE: \`visibility\` flips after the exit
   * fade (\`--de-tip-pop\`), so the card stays paintable for exactly as long as
   * it is fading. \`visibility\` rather than \`display: none\` because the card
   * has to keep its box for the fade to have something to run on.
   */
  visibility: hidden;
  transition:
    visibility 0s linear var(--de-tip-pop, ${TIP_CLOSE_MS}ms),
    transform var(--de-tip-travel, 0ms) ${t.easeReveal};
}
.de-tip[data-de-tip-open] {
  visibility: visible;
  transition-delay: 0s;
}

/*
 * The surface: the PANEL GROUND, and it opens in its final state.
 *
 * The tip is drawn in the panel's own colour with the panel's body ink, so it
 * reads as part of the chrome rather than a white chip punched into it. Over a
 * panel of the same colour its edge is the popover hairline inside
 * \`shadow.popover\`, plus that shadow's cast.
 *
 * Open is instant (\`--de-tip-pop\` is 0 whenever the attribute is added); the
 * close is the kit's \`surface-exit\` — a 150ms fade to scale 0.99 on
 * \`easeReveal\` — so a label does not vanish in the same frame the pointer left.
 * No blur and no rise: nothing in this system blurs or slides in.
 */
.de-tip-box {
  position: absolute;
  inset: 0;
  border-radius: ${t.radius.lg};
  background: ${t.color.bg};
  color: ${t.color.text};
  box-shadow: ${t.shadow.popover};
  transform-origin: var(--de-tip-origin, center top);
  opacity: 0;
  transform: scale(${EXIT_SCALE});
  transition:
    opacity var(--de-tip-pop, ${TIP_CLOSE_MS}ms) ${t.easeReveal},
    transform var(--de-tip-pop, ${TIP_CLOSE_MS}ms) ${t.easeReveal};
}
.de-tip[data-de-tip-open] .de-tip-box {
  opacity: 1;
  transform: scale(1);
}

/*
 * A label, centred in the box. Two of these exist and only the live one is
 * shown; centred with a grid so a face that is momentarily wider than the box
 * (the frame between a relabel and the size write) overhangs evenly.
 */
.de-tip-layer {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 1;
}

/*
 * The one element with a natural size: the kit's 6x12 padding and 12/16 type.
 *
 * \`width: max-content\` because it is centred in a grid area it does not size,
 * so without it the face would take the track's width and the text would wrap
 * at whatever the PREVIOUS label happened to measure.
 */
.de-tip-face {
  padding: ${t.space.xs}px ${t.space.md}px;
  width: max-content;
  font-family: ${t.font.ui};
  font-size: ${t.type.caption};
  font-weight: ${t.type.weightBody};
  line-height: ${t.type.leadingRow};
  text-align: left;
  white-space: nowrap;
}
/*
 * Wrapped, for a tip that is a sentence rather than a label.
 *
 * Set from the call site (\`data-de-tip-wrap\`) for the hints that are always
 * prose, and set automatically by the runtime for any tip whose single line
 * would be wider than \`TIP_WRAP_WIDTH\` or than the window. The cap lives HERE
 * and not on the card, because a \`max-width\` under \`white-space: nowrap\`
 * wraps nothing: it pins the box and lets the text run out of it.
 */
.de-tip-face[data-de-tip-wrap] { white-space: normal; max-width: ${TIP_WRAP_WIDTH}px; }

/*
 * The ruler: a face nobody ever sees, which is how the card learns its size.
 *
 * The card carries an explicit \`width\`/\`height\` at all times, so it cannot
 * be measured by looking at it. A second face with the same class — the same
 * padding and type — is measured instead, one \`getBoundingClientRect\` per show.
 * Out of flow and \`visibility: hidden\`, so it never paints or takes the pointer.
 */
.de-tip-ruler {
  position: fixed;
  left: 0;
  top: 0;
  visibility: hidden;
  pointer-events: none;
  z-index: -1;
}

@media (prefers-reduced-motion: reduce) {
  /*
   * The blanket backstop in \`css/base.ts\`, restated for a chrome root: the card
   * is parented to \`<body>\`, so \`[data-designlayer] *\` does not reach it,
   * while its children are descendants and already covered. The runtime also
   * reads the query and never starts a travel or an exit fade.
   */
  .de-tip { transition-duration: 0s !important; transition-delay: 0s !important; }
}
`
