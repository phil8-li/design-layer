/** Canvas chrome: outlines, handles, guides, badges, marquee. */

import { tokens as t, accentFillText } from "../tokens"

/**
 * The head start the panels take before they begin leaving, transcribed rather
 * than imported because there is no token for it.
 *
 * `css/panels.ts` writes the same 60ms as a literal on its own stand-down rule,
 * and the two numbers are one decision rather than two: the canvas chrome is
 * supposed to leave WITH the panels, so if that delay moves and this one does
 * not, the selection frame is early again in exactly the way the rule below
 * exists to fix. Named here so the relationship is findable from this end too.
 *
 * Not added to `tokens.duration`, which is a table of how long a change TAKES;
 * this is how long one surface waits for another, which is a fact about two
 * specific rules and belongs beside one of them.
 */
const STAND_DOWN_DELAY = "60ms"

export const canvasCss = `/* ---------- canvas chrome ---------- */
/*
 * No z-index here. This layer is a child of .de-root, which is the stacking
 * context, so base.ts orders it against the toolbar and panels (1 vs 2). This
 * module is concatenated last, so re-declaring z-index would win on cascade
 * order and silently undo that — putting resize handles, which are
 * pointer-events:auto, on top of every button in the chrome.
 */
.de-overlay-layer { position: fixed; inset: 0; pointer-events: none; }
/*
 * WHY GEOMETRY IS INSTANT HERE AND OPACITY IS NOT.
 *
 * This was a flat \`transition: none\`, undocumented, and half of it is
 * load-bearing: \`selection.ts\` re-reads every rect and rewrites \`transform\`,
 * \`width\` and \`height\` on this node EVERY FRAME, because the app underneath
 * animates with Motion (see that file's header). A transition on any of those
 * would make the outline trail the element it is outlining by its own duration,
 * and trail the pointer for the whole of a drag. Those four properties must
 * never enter the list below.
 *
 * \`opacity\` is the one property the frame loop never writes, so it is the one
 * that can carry the appear/disappear the flat rule was also suppressing — the
 * editor's single most repeated state change, previously a cut between two
 * frames with nothing to say it had happened.
 *
 * WHAT THIS COSTS, measured rather than assumed.
 *
 * A transition list on a node whose style is rewritten every frame is not free:
 * the engine must consider, on every mutation, whether a transition should
 * start. On a 16-node overlay at 350 paint cycles per sample, in Chrome:
 *
 *     no transition                      0.0246ms / frame
 *     opacity only                       0.0431ms  (+75%)
 *     opacity + display allow-discrete   0.0394ms  (+60%)
 *
 * So the cost is having a list AT ALL, not \`display\` or \`allow-discrete\`
 * specifically — which is exactly what the flat \`transition: none\` this
 * replaced was protecting.
 *
 * It is kept because of the other half of the measurement: the whole painter
 * frame — eight \`getBoundingClientRect\` reads plus all sixteen writes — costs
 * 0.089ms, which is 0.5% of a 60fps budget. The fade is 0.3% of a frame, spent
 * on the state change this editor makes more than any other. That is a good
 * trade at this size and it stops being one if the overlay grows by an order of
 * magnitude, so the numbers are here rather than in a commit message.
 *
 * \`display\` rides along with \`allow-discrete\` so the fade plays in both
 * directions. Without it the browser tears the node out of the box tree on the
 * first frame of the exit and the fade plays to nobody; with it the used value
 * is held back until the transition finishes, while \`style.display\` still reads
 * as the value the painter wrote. \`exit\` is the rung: fast enough that a
 * selection still feels like it lands on the click, slow enough not to be a
 * flicker.
 */
.de-outline {
  position: absolute;
  border: ${t.size.hairline}px solid ${t.color.accent};
  pointer-events: none;
  /*
   * THE SHOWN OPACITY IS DECLARED HERE, NOT WRITTEN BY THE PAINTER.
   *
   * It used to be \`0\` with \`setShown\` writing \`1\` inline when the node was
   * revealed — and an inline declaration beats a stylesheet, so
   * \`.de-outline--related\`'s \`0.82\` below was DEAD. Every related outline
   * painted at full strength, which is the one thing that variant exists not to
   * do: it is secondary chrome answering a hover somewhere else, and at the same
   * weight as the selection it reads as a second selection.
   *
   * So the resting value lives on the class, each variant may differ, and
   * \`setShown\` pins only the zero. \`@starting-style\` supplies the value to
   * animate FROM on first paint, since a node that has never been displayed has
   * no previous state.
   */
  opacity: 1;
  transition: opacity ${t.duration.exit} ${t.ease}, display ${t.duration.exit} ${t.ease} allow-discrete;
  animation: none;
}
@starting-style { .de-outline { opacity: 0; } }
.de-outline--hover { border-style: solid; opacity: 1; }
/*
 * THE MODIFIER PREVIEW'S DIP, AND WHY IT IS A CLASS AND NOT AN INLINE WRITE.
 *
 * Holding or releasing Meta/Control with the pointer completely still changes
 * what a click would select, so \`canvas/index.ts\` re-answers the hover — and
 * with no pointer movement to carry the change, the outline jumped from the
 * shallow element's box to the deep one's between two frames. A jump nobody
 * asked for reads as a glitch rather than as an answer to the key.
 *
 * What can be done about it is bounded by the constraint this whole file is
 * built around: \`canvas/selection.ts\` rewrites this node's \`transform\`,
 * \`width\` and \`height\` EVERY animation frame, so the geometry cannot be
 * transitioned at any price — only \`opacity\` can. So the outline dips to zero,
 * is moved while there is nothing on screen to see it move, and comes back:
 * two \`exit\` fades around a reposition that is still instantaneous.
 *
 * A CLASS rather than an inline \`opacity: 0\`, because the frame loop clears
 * this node's inline opacity on every frame it paints — \`setShown\` writes the
 * empty string precisely so each variant can state its own resting value — so
 * an inline dip would be wiped about one frame after it was written. Both
 * classes are named in the selector so it outranks \`.de-outline--hover\`'s
 * \`opacity: 1\` whichever order the two rules end up in.
 */
.de-outline.de-outline--dip { opacity: 0; }
.de-outline--related {
  border-color: ${t.color.measure};
  border-style: dashed;
  opacity: 0.82;
}
/*
 * 7px is the DRAWING. The target is not here and cannot be fixed here.
 *
 * \`selection.ts\` wraps each of these in a 13px hit box (\`HANDLE_HIT\`) and pins
 * the visual inside it with an inline \`pointer-events: none\`, which beats the
 * \`auto\` below — so that declaration is inert and the grab area is 13x13, well
 * under the 24px a pointer is owed. Widening it is a call for whoever owns
 * \`selection.ts\`, and not a free one: corner handles 24px apart cannot both be
 * reachable on an element narrower than 48px, which is most icons on a page.
 * Figma's answer is about 10px plus an edge band, and that is the shape of the
 * fix — a bigger \`HANDLE_HIT\` alone would make small elements unselectable.
 */
/*
 * The 13px hit box is what the painter shows and places, so it is what fades.
 *
 * Same split as \`.de-outline\`: \`transform\` is written on THIS node every frame
 * and so stays out of the transition list; only \`opacity\` and the discrete
 * \`display\` are in it.
 */
.de-handle-hit {
  opacity: 1;
  transition: opacity ${t.duration.exit} ${t.ease}, display ${t.duration.exit} ${t.ease} allow-discrete;
}
@starting-style { .de-handle-hit { opacity: 0; } }
/*
 * STANDING DOWN IS A DIFFERENT DEPARTURE FROM BEING DESELECTED, AND THE TIMING
 * IS THE ONLY THING THAT SAYS SO.
 *
 * \`exit\` above is right for the reason it is argued there: a frame that is
 * gone because the thing it outlined is no longer selected should be gone on
 * the click. Hiding the whole editor is not that gesture. The panels leave over
 * \`resize\` after waiting ${STAND_DOWN_DELAY} (see \`css/panels.ts\`) and the toolbar fades
 * over \`hover\`, so a selection frame leaving at \`exit\` had vanished before the
 * panels had even started moving — two halves of one gesture disagreeing about
 * whether anything was happening at all.
 *
 * Scoped to the hidden class rather than carried on a class the painter writes,
 * because the painter does not know WHY it is standing down and should not have
 * to: \`hideAll()\` in \`canvas/selection.ts\` is the same call for both reasons.
 * The stylesheet already knows, because \`html.designlayer-chrome-hidden\` is
 * the one state in which a surface is going somewhere.
 *
 * INTERACTIVE MODE IS DELIBERATELY NOT IN THIS SELECTOR. Nothing slides then —
 * the panels and the bar stay exactly where they are — and the mode's whole
 * claim is that the editor is not standing between the pointer and the app,
 * which an outline lingering over a page the user is already clicking through
 * is the one thing that would disprove. That exit keeps \`exit\`.
 *
 * \`opacity\` and \`display\` only, and that is not relaxed by the longer duration
 * — it is made stricter by it. \`canvas/selection.ts\` rewrites \`transform\`,
 * \`width\` and \`height\` on every one of these nodes EVERY animation frame, so
 * any of those in a transition makes the overlay trail the element it outlines
 * by the whole length of the transition, which here would be the delay plus
 * \`resize\`. \`display\` carries the same delay so the node is held in the box
 * tree for the entire fade rather than being torn out while it is still
 * running, and the sum matches the \`visibility\` flip the panels wait for.
 *
 * Guides, badges and the marquee are left out on purpose. Each belongs to a
 * live gesture — a drag, an alt-hover — and no gesture survives the editor
 * being hidden, so a slower exit there would only leave a measurement hanging
 * over an app that no longer has an editor on it.
 */
html.designlayer-chrome-hidden .de-outline,
html.designlayer-chrome-hidden .de-handle-hit {
  transition:
    opacity ${t.duration.resize} ${t.ease} ${STAND_DOWN_DELAY},
    display ${t.duration.resize} ${t.ease} ${STAND_DOWN_DELAY} allow-discrete;
}
.de-handle {
  position: absolute;
  width: 7px; height: 7px;
  margin: -4px 0 0 -4px;
  border: ${t.size.hairline}px solid ${t.color.accent};
  border-radius: 0;
  /* White in both themes: a handle is drawn over the PRODUCT, where the chrome's
     theme says nothing about what is behind it. \`text\` turned it near-black
     in the light theme — a dark square on the accent frame. */
  background: ${t.color.onAccent};
  pointer-events: auto;
  /* Nothing writes this node's transform — the frame loop places the hit box
     around it — so \`transform\` is free here, and it is the only way to grow the
     mark without moving the box its \`-4px\` margin centres. */
  transition: transform ${t.duration.exit} ${t.ease}, background ${t.duration.exit} ${t.ease};
  animation: none;
}
/*
 * THE 7px SQUARE ANSWERS THE POINTER, WHICH IT NEVER DID.
 *
 * The note above about the hit box is the other half of this: the drawing is
 * 7px inside a 13px target, so you aim at something whose edges you cannot see,
 * and finding it produced no acknowledgement at all — this was the only
 * interactive element in the chrome with no hover state whatsoever.
 *
 * Growing the mark is the part of the Fitts' complaint that CAN be fixed here.
 * It does not widen the target, which is the call that note says is not free;
 * it makes the target findable, which is the half that is.
 *
 * The rule hangs off the hit box because the drawing is \`pointer-events: none\`
 * — a \`.de-handle:hover\` would never have matched. Scaled rather than resized,
 * so the 7x7 box and its centring margin stay exactly where the painter put
 * them, and filled with the accent because at 11px a white square with a thin
 * accent border reads as the same object slightly larger rather than as a
 * different state.
 */
/*
 * Behind the kit's fine-pointer hover query, and this is the strongest of the three cases for it.
 *
 * A stuck tint is invisible; a handle stuck at 160% AND filled with the accent
 * is a resize grip that claims to be under the pointer when the pointer is
 * somewhere else entirely — on a control whose whole job is to say precisely
 * where it will act. 1.6 is also the largest of the three scales, so it is the
 * one a tap leaves most visibly wrong.
 */
@media (hover: hover) and (pointer: fine) {
  .de-handle-hit:hover > .de-handle { transform: scale(1.6); background: ${t.color.accent}; }
}
/*
 * A guide FADES IN AND LEAVES AT ONCE, and the asymmetry is the whole fix.
 *
 * A guide is drawn the instant an edge falls inside the 5px band in
 * \`snapping.ts\` and erased the instant it leaves, so dragging along that
 * boundary used to strobe. Arriving is news and is worth a frame or two;
 * leaving is not, and a guide that lingers is a guide that lies about where the
 * element is now. So \`display\` takes 0s — the exit is immediate — while opacity
 * still has \`exit\` to come up in.
 */
.de-guide {
  position: absolute;
  background: ${t.color.guide};
  pointer-events: none;
  opacity: 1;
  transition: opacity ${t.duration.exit} ${t.ease}, display 0s allow-discrete;
}
@starting-style { .de-guide { opacity: 0; } }
/*
 * Alt's extension lines: the dashed run from a measurement to the edge it is
 * measured to, when the two boxes do not share a row or column. Dashed so it
 * reads as "continued from" rather than as a second distance. A gradient, not
 * a border, so the node keeps the 1px box \`placeNode\` sizes every guide to.
 */
.de-guide--dashed-x { background: repeating-linear-gradient(to right, ${t.color.guide} 0 4px, transparent 4px 7px); }
.de-guide--dashed-y { background: repeating-linear-gradient(to bottom, ${t.color.guide} 0 4px, transparent 4px 7px); }
/*
 * White on the indigo, and \`onSemantic\` on the red — and the split is the
 * point, because \`onAccent\` is white in both themes and the measurement red is
 * a light fill in dark, where white on it is 3.71:1, on the one mark in the
 * chrome carrying a number a designer reads mid-drag.
 *
 * So the default keeps \`accentFillText\` (white on indigo, 4.97:1 dark and
 * 6.70:1 light) and the measure variant takes \`onSemantic\` — near-black in
 * dark, white in light: 5.14:1 and 4.75:1.
 *
 * The lesson is the one the retune already learned elsewhere: an ink token and
 * a fill token that are only correct together must move together, or one of
 * them changes and the other is left asserting a ratio it no longer has.
 *
 * And the numerals are on \`body\`, where they were on \`micro\`.
 *
 * 9px was the smallest type anywhere in the editor, carrying the one content
 * the chrome produces that a designer reads as DATA — the width, the height,
 * the gap being snapped to. Fixing the contrast and leaving the size was the
 * half-measure: the ratio was never why "128 x 44" was hard to read at arm's
 * length mid-drag, three-quarters of the 12px floor was. \`body\` is the nearest
 * rung that exists, and the argument this comment used to make for moving that
 * rung off 11 has since been taken: it is 12px now.
 *
 * The line box is the shell's own \`leadingRow\` rather than the flat \`16px\` it
 * used to restate. Same intent — the badge sits in the same box as every other
 * line of text in the editor — said by naming the role instead of by copying
 * whatever number the root happened to hold.
 *
 * And no \`font-variant-numeric\` here any more. Tabular figures are declared
 * once on the chrome root, where \`css/base.ts\` argues them; this badge was one
 * of the nine surfaces that used to ask for them a span at a time.
 */
/*
 * The badge fades like everything else in this layer, which it did not.
 *
 * When the overlay was taught to fade, the outline, the handles and the guides
 * were given the treatment and these two were missed — so the measurement badge
 * and the marquee were the only nodes left blinking. The marquee's arrival is
 * covered by the drag that summons it; the badge's is not, and it is the one
 * piece of chrome here carrying a NUMBER the designer is trying to read.
 *
 * Same split as its neighbours: \`opacity\` only, because the painter rewrites
 * this node's \`transform\` every frame to keep it centred on a moving point.
 */
.de-badge {
  position: absolute;
  opacity: 1;
  transition: opacity ${t.duration.exit} ${t.ease}, display ${t.duration.exit} ${t.ease} allow-discrete;
  padding: 0 ${t.space["2xs"]}px;
  border-radius: ${t.radius.xs};
  ${accentFillText}
  font-family: ${t.font.ui};
  font-size: ${t.type.body};
  line-height: ${t.type.leadingRow};
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
@starting-style { .de-badge { opacity: 0; } }
/*
 * A measure badge leaves at once, like the guide it labels. Moving between
 * targets with Alt held swaps which numbers are live; a fading leftover sits at
 * its old spot beside the new readout and reads as a second distance.
 */
.de-badge--measure {
  background: ${t.color.measure};
  color: ${t.color.onSemantic};
  transition: opacity ${t.duration.exit} ${t.ease}, display 0s allow-discrete;
}
/*
 * The marquee, on the same terms. Its exit is instant on purpose — the rect
 * stops meaning anything the moment the pointer is up, and one that lingered
 * would be describing a selection that has already been made.
 *
 * THE FILL IS \`selectionSurface\`, NOT \`accentSoft\`, AND THE SWAP IS A FIX.
 *
 * \`accentSoft\` was deliberately made OPAQUE, and \`tokens.ts\` argues it at
 * length: it is the kit's indigo container, the band under a selected layer row, and
 * "a tint that composites against whatever is behind it is a different colour
 * on the panel than it is on a hovered row". That is exactly right for a row
 * inside a panel, and exactly inverted here. This rect is drawn over the
 * PRODUCT, and what is behind it is the thing you are dragging a box around in
 * order to select. An opaque fill hides it — the overlay covers its own subject
 * for the whole duration of the gesture that picks it.
 *
 * \`selectionSurface\` is the token that already exists for this, and its own
 * comment names the job: "the canvas overlay's wash", an 18% mix of the accent
 * in dark and 12% on paper.
 * It had no canvas call site at all — the one surface it was split out for was
 * still pointing at the row token it was split FROM.
 */
.de-marquee {
  position: absolute;
  border: ${t.size.hairline}px solid ${t.color.accent};
  background: ${t.color.selectionSurface};
  pointer-events: none;
  opacity: 1;
  transition: opacity ${t.duration.exit} ${t.ease}, display 0s allow-discrete;
}
@starting-style { .de-marquee { opacity: 0; } }
`
