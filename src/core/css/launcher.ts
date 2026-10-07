/** The floating button the editor collapses into, and how it arrives. */

import { tokens as t } from "../tokens"
import { FOCUS_OUTLINE, PRESS } from "./panels"
import { TOOLBAR_HEIGHT } from "./toolbar"

/**
 * As tall as the toolbar, pinned 32 off the corner.
 *
 * The size WAS Agentation's 44, to the pixel, and that was the wrong thing to
 * copy here. Their disc is the whole of their chrome; ours is one of two states
 * of a bar that is 40 tall, and 44 beside 40 is not a deliberate contrast —
 * it is near enough to read as the same size and far enough to look wrong the
 * moment you collapse the editor while watching the corner. Taking the bar's
 * height outright makes the two states one object: the strip you were using
 * becomes a disc of exactly its height, so the only thing that changed is the
 * width. It is also the smaller of the two numbers, which is what the disc
 * wants — it sits over someone else's product doing nothing until it is needed.
 *
 * It stays a comfortable target: 40px clears the 24px minimum of WCAG 2.2
 * Target Size (Minimum) with room to spare, and is the size Material gives a
 * small FAB, which is the same object under another name.
 *
 * Imported rather than restated, so a change to the bar's padding or its
 * squares carries here instead of leaving a disc that used to match.
 *
 * The inset is not Agentation's — theirs is 20, and this sat at 20 to match
 * until the disc was looked at against a real app. A circle 20px off two edges
 * reads as crowding the corner it is in; 32 gives it the air to read as
 * floating OVER the product rather than stuck to it, and it clears the
 * scrollbars and corner affordances that live in exactly that corner on the
 * pages this editor is pointed at.
 *
 * Kept in agreement with `EDGE` in `shell/launcher.ts`, which is the margin a
 * DRAGGED disc clamps to — a dragged surface has to be able to land exactly
 * where an undragged one sits, or the resting position is somewhere the user
 * cannot choose.
 */
const SIZE = TOOLBAR_HEIGHT
const INSET = 32

/** How far above the page's bottom edge the resting disc's top sits — what a toast in this corner has to clear. */
export const LAUNCHER_CLEARANCE = INSET + SIZE

/**
 * The disc's half of standing down — the other half is in \`css/toolbar.ts\`.
 *
 * ${t.duration.reveal} against the bar's ${t.duration.hover}, and the order is the point: the thing the
 * system takes away goes faster than the thing it hands you back, so the bar is
 * gone before the disc has finished settling rather than the two dissolving
 * through each other in the middle.
 *
 * The ${ARRIVE_DELAY} wait is well inside the bar's ${t.duration.hover} exit. Start at 0 and there are two things
 * at full opacity in two different places, which reads as a swap; wait for the
 * bar to finish and it reads as a slideshow. Halfway is where a handover is —
 * the bar is faint and still going as the disc starts to show up.
 */
const ARRIVE = t.duration.reveal
const ARRIVE_DELAY = "60ms"

/**
 * Where the disc starts, and it is not zero.
 *
 * Nothing in the physical world appears from nothing, so a scale that starts
 * near zero reads as a thing being CREATED rather than as a thing arriving.
 * 0.9 is small enough to be a settle rather than a pop, and it is on the same
 * curve as everything else in the chrome — the bar does not overshoot, and one
 * half of a pair bouncing while the other does not is two motions however well
 * timed.
 */
const ARRIVE_SCALE = 0.9

export const launcherCss = `/* ---------- launcher ---------- */
/*
 * The editor, collapsed to one object.
 *
 * A disc rather than a rounded square, and dark rather than accented: it sits
 * over someone else's product for as long as they want the editor out of the
 * way, so it has to read as a returning affordance and not as a badge the app
 * has grown. The lift is \`shadow.float\` — the token for a surface hanging over
 * the product rather than docked to an edge, which is exactly what this is and
 * what the panels no longer are.
 *
 * \`left\`/\`top\` are left unset on purpose. Until it is dragged, the corner
 * anchor below IS the position, so a resized window keeps it in the corner
 * with no script running; the drag writes the other pair and switches these
 * two off (see \`launcher.ts\`).
 */
.de-launcher {
  position: fixed;
  right: ${INSET}px;
  bottom: ${INSET}px;
  width: ${SIZE}px; height: ${SIZE}px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  /*
   * No \`border\`. \`shadow.float\` carries its own hairline now — a
   * \`0 0 0 1px\` ring, the same one \`popover\` uses — and a real border on top
   * of it is two edges drawn a half pixel apart on a ${SIZE}px circle, which is the
   * shape that shows that worst: a \`border-radius: 50%\` border has to be
   * rasterised around the whole circumference and picks up a stair-step the
   * shadow's ring does not. The ring also does not take part in layout, so the
   * disc is ${SIZE}px rather than ${SIZE + 2} and \`INSET\` means what it says.
   */
  border: none;
  border-radius: 50%;
  background: ${t.color.bg};
  color: ${t.color.text};
  box-shadow: ${t.shadow.float};
  cursor: pointer;
  user-select: none;
  /* The drag is pointer-driven; without this, a touch drag scrolls the app. */
  touch-action: none;
}
@media (hover: hover) and (pointer: fine) {
  .de-launcher:hover { background: ${t.color.bgHover}; }
}
/* The kit's ring, drawn beside the float rather than instead of it: the ring
   is an outline, so the cast and the halo shadow are listed together. */
.de-launcher:focus-visible { ${FOCUS_OUTLINE} box-shadow: ${t.shadow.float}, 0 0 0 3px color-mix(in srgb, ${t.color.accent} 30%, transparent); }
/*
 * \`pointer\` at rest, not \`grab\`, and this is the one place the two floating
 * surfaces deliberately disagree.
 *
 * The bar's ground wears \`grab\` because pressing it does nothing else — moving
 * the bar is the only thing that ground is for, and without the cursor nobody
 * would ever find out. Press this disc and the editor comes back. That is its
 * job, the drag is the secondary gesture (which is why it holds ten pixels of
 * slack before it believes one), and a cursor that advertised the secondary
 * gesture would be pointing at the wrong one of the two.
 *
 * Closed while it moves, though: by then the hand really is holding the object,
 * and the same hand closes on the bar for the same reason.
 */
.de-launcher--dragging { cursor: grabbing; }

/*
 * It is not in the DOM only while the editor is up — it is in the DOM the whole
 * time, parked at the end of its own exit.
 *
 * \`display: none\` cannot be transitioned, and \`opacity\` alone would leave a
 * ${SIZE}px hole in the corner swallowing clicks meant for the app. \`visibility\`
 * does both: it is inert and untabbable while hidden, and it is one of the few
 * properties that transitions DISCRETELY — it flips at the end of the delay,
 * which is what lets the disc finish shrinking before it stops existing.
 */
.de-launcher {
  visibility: hidden;
  opacity: 0;
  transform: scale(${ARRIVE_SCALE});
  transition:
    opacity ${t.duration.hover} ${t.ease},
    transform ${t.duration.hover} ${t.ease},
    background-color ${t.duration.hover} ${t.ease},
    visibility 0s linear ${t.duration.hover};
}
/*
 * Showing up, in the corner, as the bar finishes leaving.
 *
 * ON \`easeSpring\`, WHICH THE KIT RESERVES FOR A PAYOFF LIKE THIS ONE.
 *
 * This used to be \`tokens.ease\`, argued as "three surfaces moving at once on
 * three curves is three events". That argument is about the surfaces LEAVING,
 * and for those two it still holds — the bar fades and the panels slide, both
 * on \`ease\`, and neither has anything to overshoot. The disc is not one of
 * them. It is the only thing on screen ARRIVING, it starts after the other two
 * are already going (\`${ARRIVE_DELAY}\`), and it is a ${SIZE}px object landing in an
 * empty corner rather than a value settling into place.
 *
 * Which is what \`tokens.ts\` says \`easeSpring\` is for: "a direct-manipulation
 * PAYOFF only — a drop, a reorder, the launcher landing".
 *
 * The SCALE takes the spring and nothing else does. \`opacity\` stays on \`ease\`
 * because an overshooting curve on a value that clamps at 1 buys a flat hold
 * and no bounce; \`background\` stays because a hover tint has nothing to
 * overshoot; and the exit above stays because a disc that sprang on the way OUT
 * would be bouncing as it stopped existing.
 */
html.designlayer-chrome-hidden .de-launcher {
  visibility: visible;
  opacity: 1;
  transform: scale(1);
  /*
   * The visibility flip waits out the same ${ARRIVE_DELAY} as the fade.
   *
   * Flipping it at 0s would leave a fully transparent ${SIZE}px disc over the corner
   * of the app for the whole of the morph, swallowing any click that landed
   * there. Nothing that cannot be seen should be clickable.
   */
  transition:
    opacity ${ARRIVE} ${t.ease} ${ARRIVE_DELAY},
    transform ${ARRIVE} ${t.easeSpring} ${ARRIVE_DELAY},
    background-color ${t.duration.hover} ${t.ease},
    visibility 0s linear ${ARRIVE_DELAY};
}
/* The kit's 0.98 press, which has to beat the state rule that owns
   \`transform\` above. */
html.designlayer-chrome-hidden .de-launcher:active {
  ${PRESS}
  transition: transform ${t.duration.hover} ${t.ease};
}
/*
 * Nothing eases while you are dragging it.
 *
 * The position is written from the pointer every frame; a transition on top of
 * that would make the disc lag the cursor by its own duration, which reads as
 * the drag being broken rather than as smoothing. Scoped through the state
 * class because that is the only rule it has to beat — it is the one that owns
 * \`transition\` whenever the button is on screen at all.
 */
html.designlayer-chrome-hidden .de-launcher--dragging { transition: none; }

/*
 * Reduced motion, and the one thing \`base.ts\` cannot reach.
 *
 * That file does nearly all of it: every duration in the chrome is clamped, the
 * panels and the disc are forced to \`transform: none\`, and all three surfaces
 * are left with a plain opacity fade — fewer and gentler, which is what the
 * preference asks for rather than nothing at all.
 *
 * What it cannot reach is a standalone \`scale\` or \`translate\`, because neither
 * is \`transform\`. Nothing in the collapse uses either of them today — the bar
 * fades and holds still — but both have been in it twice, and a reduced-motion
 * hole that reopens silently is worse than a line that costs nothing. So they
 * are neutralised by name.
 *
 * It lives beside the disc so every reduced-motion rule for the two floating
 * surfaces is in one place; \`css/toolbar.ts\` carries none.
 */
@media (prefers-reduced-motion: reduce) {
  .de-toolbar { scale: none !important; translate: none !important; }
}

`
