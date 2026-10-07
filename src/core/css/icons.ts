/** How heavily a glyph is drawn, decided by the control that holds it. */

import { tokens as t } from "../tokens"

export const iconsCss = `/* ---------- glyph weight ---------- */
/*
 * On means heavier. Off means the rung's own weight. One rule, not 54 call sites.
 *
 * Every glyph is a Phosphor outline — a filled path whose line weight is drawn
 * into it — and \`drawIcon\` strokes that outline in \`currentColor\` at the
 * rung's \`--de-icon-stroke\`. A stroke on a filled outline thickens every line
 * by its width, so adding half a unit here draws the same mark a step heavier:
 * Phosphor's regular line goes from 1.5 to 2 of 24, between its regular and
 * bold weights. The mark does not change, it thickens.
 *
 * The reasoning that put a rule here at all: the alternative was for each
 * control to redraw its own icon whenever its state changed, which lets a
 * button's mark and its \`aria-pressed\` drift apart. Reading the state off the
 * DOM means the two cannot disagree. A control that already reports itself to
 * assistive tech — and every toggle in this chrome does — gets the right weight
 * for free, and so does the next one somebody adds.
 *
 * \`aria-selected\` as well as \`aria-pressed\`: a tab strip and a token list say
 * "chosen" with the first and a toggle says it with the second, and the glyph
 * does not care which word the control had to use.
 *
 * Half a unit, not a whole one. The bump lands on top of the accent colour and
 * border a pressed control already wears, so it is the third signal rather than
 * the only one — and a full unit at the \`marker\` rung would close a glyph's
 * counters up instead of emphasising it.
 *
 * \`--de-icon-stroke\` is written inline by \`drawIcon\` (see \`STROKE_FOR_SIZE\`
 * in \`tools/build-icons.mjs\`). It is namespaced because a kit-level name would
 * inherit from the HOST page and re-weight the chrome. The \`0\` fallback only
 * applies to a glyph drawn outside \`drawIcon\`.
 *
 * Scoped twice over — under the chrome attribute, and to \`[data-de-glyph]\` — so
 * it reaches neither an \`<svg>\` belonging to the app being edited nor a HOST
 * icon rendered in the inspector's variant list. Those are somebody else's
 * drawings, and the editor does not get to re-weight them because a row is
 * selected.
 */
/*
 * \`hover\` is the kit's \`--duration-hover\` (150ms) and \`ease\` its emphasized
 * curve. This was
 * once the last unargued literal duration in the stylesheet — the same number
 * spelled a second way — so it was the one that would silently stop agreeing
 * the day the rung moved.
 *
 * ## AND THIS SELECTOR OUTRANKS EVERY OTHER GLYPH TRANSITION IN THE CHROME
 *
 * \`[data-designlayer] svg[data-de-glyph]\` is (0,2,1). \`.de-swap > svg\` and
 * \`.de-pad-cell > svg\` are (0,1,1). \`transition\` is a shorthand, so this rule
 * does not add \`stroke-width\` to their lists — it REPLACES them, resetting
 * \`transition-property\` to \`stroke-width\` alone. Both of those surfaces have
 * therefore never animated: the copy glyph jumped to a tick and the padding
 * cell's mark appeared at full size, in a chrome whose stylesheet carefully
 * describes both crossfades.
 *
 * It is not fixable from here. Widening this list would put an opacity and a
 * transform transition on all 54 glyph call sites, which is the blanket the
 * file's own opening argument rejects; narrowing the selector would let it
 * reach the host's own artwork, which is what the attribute is for. So the two
 * surfaces that want their own motion restate this one property inside their
 * own rule and take a specificity that beats this — see \`.de-swap > svg\` in
 * \`css/annotations.ts\`, which is the pattern to copy.
 */
[data-designlayer] svg[data-de-glyph] {
  transition: stroke-width ${t.duration.hover} ${t.ease};
}

[data-designlayer][aria-pressed="true"] svg[data-de-glyph],
[data-designlayer][aria-selected="true"] svg[data-de-glyph],
[data-designlayer] [aria-pressed="true"] svg[data-de-glyph],
[data-designlayer] [aria-selected="true"] svg[data-de-glyph] {
  stroke-width: calc(var(--de-icon-stroke, 0) + 0.5);
}

@media (prefers-reduced-motion: reduce) {
  [data-designlayer] svg[data-de-glyph] { transition: none; }
}

/*
 * NO PER-GLYPH OPTICAL CORRECTION.
 *
 * The previous set's arrow sat 6.3% of its box up and left of centre and was
 * nudged here. Phosphor's cursor is drawn optically centred already — its
 * alpha-weighted centroid is within 1.7% of the middle, rasterised at 120px —
 * so the nudge would now push it off. Everything centres geometrically.
 */

`
