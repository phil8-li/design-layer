/**
 * Audit markers: the plate on a violating element, and the frame around it.
 *
 * This sheet has one job that matters more than how it looks, and it is stated
 * here because no single rule below can carry it: an audit badge and a note pin
 * must be told apart by a reader who cannot tell amber from red.
 *
 * Both marks are anchored to the TOP-LEFT corner of an element — that is the
 * one corner every box has in the same place at any size — so on a page showing
 * both they would sit on each other rather than beside each other. The layers
 * are therefore exclusive, which `MarkerLayer` in `annotations/store.ts`
 * enforces; but exclusivity only stops them colliding, it does not help the
 * user who switches between them and has to know which one they are looking at.
 *
 * So the distinction is carried by SHAPE, not by hue:
 *
 *   - a note pin is a ROUND disc with a NUMERAL in it, in the user's colour;
 *   - an audit badge is a SQUARE with rounded corners and no glyph.
 *
 * Shape survives greyscale, a monochrome display, and every colour-vision
 * deficiency there is, and it survives the one case a hue rule cannot survive
 * at all: the note colour is the USER's, and nothing here may assume they did
 * not pick amber. Hue is then free to do the job it is actually good at, which
 * is severity at a glance — `lintWarning` for a warning, `danger` for an error.
 *
 * Severity carries a second channel too, for the same reason one level down:
 * amber against red is exactly the pair a deuteranope cannot separate, so the
 * error plate is squarer than the warning plate. A 4px corner and an 8px corner
 * on a 20px square is a difference you can see across the room, and it is the
 * only difference that is still there in a screenshot printed in black ink.
 */

import { tokens as t } from "../tokens"

/**
 * The plate, in px, and the glyph inside it.
 *
 * 20 rather than the note pin's 22, and the two pixels are not decoration: a
 * square of the same size as a disc reads as BIGGER, because a square has more
 * area at equal width. Taking two off puts the two marks on the same apparent
 * size, so switching layers does not look like the page changed scale.
 *
 * 12 is `icon.marker`, the ramp's dense rung, which is the largest glyph that
 * leaves a ring of plate visible around it at 20px. A glyph that touched the
 * corners would erase the corner radius, and the corner radius is the channel
 * doing the severity work.
 */
const BADGE = 20

/**
 * The WCAG 2.5.8 floor, bought back from a transparent pad.
 *
 * Same trade the note pin makes and same number, because it is the same kind of
 * object: a 20px control drawn over somebody else's layout, where growing the
 * plate to 24 would mean covering four more pixels of the thing it is marking.
 */
const TARGET = 24

/**
 * The two corners, and the whole non-hue half of the severity signal.
 *
 * `radius.xs` and `radius.sm` off the kit's own scale rather than two numbers
 * invented here: 4 and 8 are one step apart on a nine-step ramp, which is the
 * smallest gap the ramp offers that still reads as a different shape at 20px.
 */
const ERROR_CORNER = t.radius.xs
const WARNING_CORNER = t.radius.sm

/**
 * How far the second plate of a stacked badge peeks out from under the first.
 *
 * Geometry, so it stays a literal here for the reason `tokens.shadow` gives
 * about offsets and blurs — an offset is not a theme decision. Three pixels on
 * a 20px plate is the smallest offset that still reads as a second card rather
 * than as a badly aligned border, and it is small enough that a stacked badge
 * claims no more of the page than a plain one.
 */
const STACK_OFFSET = 3

export const lintMarkersCss = `/* ---------- audit markers ---------- */
/*
 * Inert, like every other overlay layer, so the app underneath stays usable.
 * No z-index: \`css/base.ts\` orders this overlay against the toolbar and the
 * panels, and a rung declared in a module concatenated after it would win on
 * cascade order and lift an audit badge over the panel that listed it.
 */
.de-lint-marker-layer { position: fixed; inset: 0; pointer-events: none; }

/*
 * The plate.
 *
 * A border rather than an inset shadow, which is the opposite of what the note
 * pin does, and the reason is the shape again. The pin's edge is an inset
 * hairline so the disc's boundary curves away rather than being a ring drawn on
 * top of it; a square has no curve to preserve, and a real border is what makes
 * the corner radius crisp at 4px. \`bg\` for the border colour, not a tint of the
 * severity: the plate sits on product pixels of an unknown colour, and a band
 * of the chrome's own ground is what separates it from them whatever they are.
 *
 * The glyph is \`onSemantic\`, the ink for a fill that carries a MEANING rather
 * than the accent. It flips with the theme, and so must it: the severity hues
 * are pale in dark and deep in light, precisely so each reads as ink on its own
 * ground, so an ink that stayed put would be wrong on one of the two.
 *
 * This said \`onAccent\` and argued the opposite — "the plate's fill is a
 * severity and does not flip with the theme, so neither may its ink." The
 * premise was already false when it was written, and the conclusion put a white
 * glyph on the dark theme's amber plate, at 2.01:1. \`onSemantic\` is 9.49:1
 * there, and 5.57:1 (white) on the light theme's amber.
 */
.de-lint-marker {
  position: absolute;
  width: ${BADGE}px; height: ${BADGE}px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  border: 1px solid ${t.color.bg};
  color: ${t.color.onSemantic};
  box-shadow: ${t.shadow.marker};
  cursor: pointer;
  user-select: none;
  pointer-events: auto;
  /* The kit's one rung for hover, press and colour changes: \`duration.hover\`.
     The old split (colour slower than geometry) put the recolour on the reveal
     rung, which the kit keeps for surfaces settling in, not for a hover. */
  transition: background-color ${t.duration.hover} ${t.ease}, transform ${t.duration.hover} ${t.ease},
    box-shadow ${t.duration.hover} ${t.ease};
}
/* ${BADGE}px drawn, ${TARGET}px hit: the pad the note pin uses, squared off. */
.de-lint-marker::before {
  content: "";
  position: absolute; inset: -${(TARGET - BADGE) / 2}px;
}

/*
 * Severity: hue AND corner, never hue alone.
 *
 * An error is the squarer plate and \`danger\`; a warning is the rounder plate
 * and \`lintWarning\`. Read the header for why both channels are required — the
 * short version is that amber against red is the one pair a colour-blind reader
 * is most likely to lose, and these two are the only marks in the chrome whose
 * whole purpose is to be triaged at a glance.
 */
.de-lint-marker--error {
  background: ${t.color.danger};
  border-radius: ${ERROR_CORNER};
}
.de-lint-marker--warning {
  background: ${t.color.lintWarning};
  border-radius: ${WARNING_CORNER};
}

/*
 * More than one finding on one element, said without a number.
 *
 * Two violations in one rule block is the ordinary case, not the edge one, and
 * two plates on one corner is exactly the collision the two LAYERS are kept
 * apart to avoid — so they collapse into one plate and this says there is more
 * behind it. A second plate peeking out from under the first, the way a stack
 * of cards does, which is shape again and needs no legend. The count and every
 * message are in the tooltip; the panel is where they are read.
 *
 * Under the plate rather than beside it, so a stacked badge claims no more of
 * the page than a plain one — the reason the pin's hover scales instead of
 * drawing a halo.
 */
.de-lint-marker--stacked::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translate(${STACK_OFFSET}px, ${STACK_OFFSET}px);
  z-index: -1;
  border-radius: inherit;
  background: inherit;
  opacity: 0.55;
}

/* Behind \`hover: hover\` for the reason its twin in \`css/annotations.ts\` sets
   out at length: this badge is painted over the app being reviewed, and a badge
   stuck at 110% after a tap reads as a fault in that app rather than in the
   editor. The tint rules around it are deliberately not wrapped. */
@media (hover: hover) and (pointer: fine) {
  .de-lint-marker:hover { transform: scale(1.1); }
}
/*
 * The two-tone ring, copied deliberately from \`.de-ann-marker:focus-visible\`.
 *
 * Same problem, same answer: this is a control focused against the app being
 * edited rather than against a surface this stylesheet painted, so a single
 * accent ring has no known ratio behind it. A dark ring wrapped in a light one
 * cannot fail both ways at once. Copied rather than shared because the two
 * sheets are owned by different surfaces and a shared rule would make the audit
 * layer unloadable without the annotation one.
 */
.de-lint-marker:focus-visible {
  outline: 2px solid ${t.color.focusCore};
  outline-offset: 2px;
  box-shadow: ${t.shadow.marker}, 0 0 0 6px ${t.color.focusHalo};
}

/*
 * The badge whose ROW the pointer is in — the other half of the correspondence.
 *
 * Three channels, because one is not enough over product pixels of an unknown
 * colour: a grow the eye catches in peripheral vision while it is still reading
 * the row, a lift out from under the badges it overlaps in a dense corner, and
 * two rings at opposite ends of the scale so one of them is visible against any
 * background. The same vocabulary \`.de-ann-marker--active\` uses, because it is
 * the same statement — "this is the one the panel means".
 */
.de-lint-marker--active {
  z-index: 1;
  transform: scale(1.12);
  box-shadow: ${t.shadow.marker}, 0 0 0 2px ${t.color.bg}, 0 0 0 4px ${t.color.text};
}

/*
 * The frame on the offending element's own box.
 *
 * One pixel, and that is a deliberate half of the annotation hover outline's
 * two. These are not transient — every marked element on the page wears one for
 * as long as the layer is up — so the weight has to be the weight of a
 * statement about the page rather than of a gesture about to happen. At 2px a
 * dozen of them turn a dashboard into a wireframe.
 *
 * No fill tint either, for the same reason and a second one: the findings are
 * about COLOUR, and washing the element in 8% of the severity hue would be
 * tinting the very thing the user is being asked to look at.
 */
.de-lint-marker-box {
  position: absolute;
  border: 1px solid ${t.color.lintWarning};
  border-radius: ${t.radius.xs};
  pointer-events: none;
  transition: none;
  animation: none;
}
.de-lint-marker-box--error { border-color: ${t.color.danger}; }
.de-lint-marker-box--warning { border-color: ${t.color.lintWarning}; }

@media (prefers-reduced-motion: reduce) {
  /* The plate has nothing to say by moving — it is already where the finding
     is — so it gives up the grow entirely rather than shortening it. */
  .de-lint-marker { transition: none !important; }
  .de-lint-marker:hover { transform: none; }
}
`
