/**
 * Placement chrome: the drop indicator and the drag ghost.
 *
 * Two marks, and they are drawn for two different moments of one gesture. The
 * indicator answers "where will this land" and is the only thing on screen that
 * can answer it, because the element itself does not appear until the source
 * write lands and the dev server re-renders — see the header of
 * `src/libraries/insert.ts` for why that delay is deliberate and not a bug. The
 * ghost answers "what is in my hand", which the cursor alone cannot.
 *
 * Both sit in `.de-overlay-layer`, which `css/canvas.ts` already declares as
 * `pointer-events: none`, and both re-declare it anyway. That is not belt and
 * braces for its own sake: the indicator is painted UNDER THE POINTER during a
 * drag, and the very next thing the drag does is hit-test that same point. An
 * indicator that took the pointer would make `elementsFromPoint` return the
 * indicator, the resolver would discard it as chrome, and the drop target would
 * flicker between the real container and nothing as the pointer moved across
 * its own mark. Losing the overlay's declaration would be silent everywhere
 * else in the chrome and immediately visible here, so the guarantee is restated
 * where it is load-bearing.
 *
 * No z-index, for the reason `css/canvas.ts` records: `css/base.ts` orders the
 * overlay layer against the toolbar and the panels, and a z-index declared in a
 * module concatenated after it would win on cascade order and quietly lift a
 * drop indicator over the panels it must never cover.
 */

import { tokens as t } from "../tokens"

export const insertCss = `/* ---------- component placement ---------- */
/*
 * The boundary line. Geometry is written inline by the placement engine — it is
 * measured from the container's content box every pointermove — so everything
 * here is the part that does not move: what colour it is, and that it cannot be
 * touched.
 *
 * Accent rather than the guide pink that snapping uses. Both are transient
 * marks over the app, but they say opposite things: a guide reports an
 * alignment the page ALREADY has, while this reports a change the editor is
 * about to make. The accent is what every other "the editor will act here" mark
 * in the chrome is drawn in, and a designer who has learned that pink means
 * "measured" should not have to unlearn it mid-drag.
 */
.de-insert-indicator {
  position: absolute;
  background: ${t.color.accent};
  border-radius: ${t.radius.xs};
  pointer-events: none;
  transition: none;
  animation: none;
}
/*
 * A container with no element children has no boundary to draw, so the mark
 * becomes the container itself.
 *
 * This is the one case where a line would be a lie: there is no gap between two
 * things to point at, and a 2px rule floating in the middle of an empty box
 * reads as "between these children" when there are none. An outline says the
 * true thing — the component is going INSIDE this — and it is the same shape
 * the selection chrome uses for "this element", so it needs no explaining.
 *
 * The fill is \`selectionSurface\` for the reason \`css/canvas.ts\` gives on the
 * marquee: \`accentSoft\` is an opaque row band, and this mark is painted over
 * the product. An empty container is empty of ELEMENTS, not of pixels — it
 * still has the app's own background, its padding, whatever a pseudo-element
 * put there — and an opaque slab over it is the editor deciding you do not need
 * to see where the thing is going to land.
 */
.de-insert-indicator--outline {
  background: ${t.color.selectionSurface};
  box-shadow: inset 0 0 0 ${t.size.hairline}px ${t.color.accent};
  border-radius: ${t.radius.sm};
}
/*
 * The write is in flight, and the element will not appear when it lands.
 *
 * Every other edit this editor makes shows up on the page the moment it is
 * made; an insertion cannot (again: see the module header). That leaves a
 * window of a few hundred milliseconds where the user has dropped something and
 * nothing whatsoever has changed, which is indistinguishable from a drop that
 * missed. The mark stays put and breathes so that window reads as "working"
 * rather than as "nothing happened", and the toast carries the words.
 *
 * Four reveals to a cycle (one second) rather than something faster: this is a
 * progress hint, not feedback on an action, and a quick pulse over someone's
 * live page is agitation. Read off the duration ramp rather than written as a
 * literal, so it keeps its proportion to everything else that moves. \`prefers-reduced-motion\` drops to a flat mid-opacity, which still
 * distinguishes pending from resolved without animating anything.
 */
.de-insert-indicator--pending {
  animation: de-insert-pending calc(${t.duration.reveal} * 4) ${t.ease} infinite;
}
@keyframes de-insert-pending {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .de-insert-indicator--pending { animation: none; opacity: 0.6; }
}
/*
 * What is in the hand.
 *
 * A clone of the card's own thumbnail, so the thing following the pointer is
 * the thing the panel showed — the drag never introduces a second, simpler
 * depiction of the component that the user then has to match up with the card
 * they pressed.
 *
 * \`position: fixed\`, not absolute: the ghost is positioned from raw
 * \`clientX\`/\`clientY\` with no rect subtraction anywhere, and fixed is the
 * coordinate space those numbers are already in. Capped in both directions
 * because a component's preview can be a full-width banner, and a ghost wider
 * than the canvas hides the page it is being dropped onto.
 *
 * Reduced opacity is the whole convention here: a drag ghost that is fully
 * opaque reads as an element that has already been placed.
 *
 * Drawn as the kit's floating card: the card rung (\`radius['3xl']\`) and the
 * modal elevation, which is the cast \`shadow.float\` is for — a surface held in
 * mid-screen over the product.
 */
.de-insert-ghost {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1;
  max-width: 220px;
  max-height: 180px;
  padding: ${t.space.sm}px;
  border-radius: ${t.radius["3xl"]};
  corner-shape: ${t.cornerShape};
  background: ${t.color.bgRaised};
  box-shadow: ${t.shadow.float};
  color: ${t.color.text};
  font-family: ${t.font.ui};
  font-size: ${t.type.body};
  opacity: 0.7;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
}
/*
 * The fallback ghost, for a press that did not come from a card with a rendered
 * thumbnail in it — a component whose preview fell back to a monogram, or a
 * drag started from somewhere that has no thumbnail at all. The name is the
 * least the ghost can be and still be honest about what is in the hand.
 */
.de-insert-ghost-name {
  display: block;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: ${t.type.weightValue};
}
`
