/**
 * Sonner, wearing the editor's design system.
 *
 * Two stylesheets concatenated, in this order and no other:
 *
 *   1. Sonner's own `styles.css`, verbatim, via the generated `sonner-css.ts`
 *      beside this file. It is the library's layout, stacking, swipe and
 *      enter/exit behaviour, and none of it is ours to re-derive — the moment
 *      it is retyped by hand, a version bump silently stops applying. It is
 *      copied into a `.ts` module rather than imported as a `.css` file
 *      because every jsdom suite in `test/` bundles its lane with esbuild and
 *      no output path, where a CSS import is a hard error; the long version is
 *      in `tools/build-sonner-css.mjs`.
 *   2. The overrides below, which replace every colour, radius, shadow and
 *      type size the library hard-codes with the token that already answers
 *      for it everywhere else in this chrome.
 *
 * ORDER IS THE MECHANISM, not specificity. Sonner declares its palette at
 * `[data-sonner-toaster][data-sonner-theme='light']` — two attribute
 * selectors, (0,2,0). The override block matches the same element at the same
 * weight with `[data-sonner-toaster][data-sonner-theme]`, so nothing here wins
 * by out-specifying the library; it wins by coming second. Every rule below is
 * therefore written to the weight of the rule it replaces, deliberately, and a
 * selector copied from `styles.css` should be left spelled the way that file
 * spells it.
 *
 * Both halves go into the toaster's SHADOW ROOT (see `core/toast.ts`), never
 * into the document. Sonner's selectors are unprefixed and global — a rule
 * like `[data-sonner-toast][data-styled='true'] { padding: 16px }` in the
 * document would restyle the toasts of any host app that also uses Sonner, and
 * this editor is pointed at apps it did not write. A shadow boundary is the
 * only containment that does not depend on rewriting someone else's selectors.
 */

import { tokens as t } from "../tokens"
import { CONTROL_RADIUS } from "./panels"
import { sonnerCss } from "./sonner-css"

/**
 * Above `.de-root`, which sits at 2147483000.
 *
 * Sonner ships `z-index: 999999999`, which loses to the editor's own chrome by
 * three orders of magnitude — a toast reporting a failed write would be painted
 * UNDER the inspector that triggered it. Left below the vendor's own maximum
 * (2147483647) so that nothing here can cover a surface the vendor considers
 * more urgent than ours.
 */
const LAYER = 2147483646

/**
 * The keyboard focus ring, the kit's recipe: the edge takes the accent and a
 * 3px halo of the accent at 30% sits outside it (MICRO-INTERACTIONS § 3).
 *
 * Built from the accent token rather than written as a colour; it resolves to
 * the same colour as \`accentHalo\`.
 */
const HALO = `color-mix(in srgb, ${t.color.accent} 30%, transparent)`
const FOCUS_RING = `inset 0 0 0 1px ${t.color.accent}, 0 0 0 3px ${HALO}`

/**
 * The close button's corner, concentric with the card's.
 *
 * The card is \`radius["3xl"]\` (16) and pads the close button's edge by
 * \`space.sm\` (8) on the top, right and bottom, so the button sits 8px inside a
 * 16px curve and draws 16 − 8 = 8, \`radius.sm\` — which is also the rung every
 * icon-only mini button takes. Written out rather than as a \`nest()\` because
 * this sheet lives in a shadow root, outside \`shellCss\`, where the concentric
 * suite cannot read it back.
 */
const CARD_RADIUS = t.radius["3xl"]
const CLOSE_RADIUS = t.radius.sm

/**
 * How far a \`rowHeight\` button overhangs a one-line title, above and below.
 *
 * The buttons take it back as negative block margins, so the title row is as
 * tall as the TITLE and not as tall as the buttons — which is what lets the
 * glyph centre on the title itself (see the card grid below).
 */
const TITLE_LINE = Math.round(parseFloat(t.type.body) * t.type.leadingRow)
const BUTTON_BLEED = (TITLE_LINE - t.size.rowHeight) / 2

const overrides = `
/*
 * The host is an anchor, not a box. Everything Sonner renders is
 * \`position: fixed\`, so the element holding the shadow root should occupy no
 * space and start no stacking context of its own — \`display: contents\` is the
 * only value that promises both.
 */
:host { display: contents; }

/*
 * The squircle every other corner in this chrome is cut with.
 *
 * \`corner-shape\` does not inherit, and a shadow boundary blocks the document's
 * copy of this rule, so it is restated rather than borrowed. Same \`:where()\`
 * for the same reason as in \`css/base.ts\`: a rule that reaches every element
 * must be the thing everything else beats.
 */
:where([data-sonner-toaster], [data-sonner-toaster] *) {
  corner-shape: ${t.cornerShape};
}

/*
 * \`--width\` and \`--gap\` are deliberately NOT here. Sonner writes both inline on
 * the section from its own props, and an inline declaration beats a stylesheet
 * at any specificity — so the width lives with the other Toaster props in
 * \`core/toast.ts\`, where it is actually obeyed. Setting it here as well would
 * be a value that looks authoritative and does nothing.
 */
/*
 * The toast's action button, and the figures it does not inherit.
 *
 * The rest of the card gets the chrome's typographic root for free: the shadow
 * host carries \`CHROME_ATTR\`, \`baseCss\` matches it in the outer document, and
 * inherited properties cross a shadow boundary — so \`font-variant-numeric\`,
 * \`text-wrap\` and the smoothing pair all reach in. What does not reach in is
 * the companion rule beside them, \`[data-designlayer] :where(input, …)\`,
 * because a descendant combinator stops at the boundary. Sonner's action
 * button is inside it and carries the UA's \`font\` shorthand, which resets
 * \`font-variant\` — so \`Undo 12\` would be the one string on the card with
 * proportional digits. Restated here rather than made to pierce, because a
 * shadow root's stylesheet is where a shadow root's exceptions belong.
 */
:where(button, input, select, textarea) { font-variant-numeric: tabular-nums; }

[data-sonner-toaster] {
  z-index: ${LAYER};
  font-family: ${t.font.ui};
  /* A toast is a floating card, so it takes the card rung (kit § 12). */
  --border-radius: ${CARD_RADIUS};
  /* The stack's own reflow, when a second card pushes the first back. Sonner
     runs this at 400ms on a bare \`ease\`; it is a surface settling, so it takes
     the reveal tween. */
  transition: transform ${t.duration.reveal} ${t.easeReveal};
}

/*
 * THE TOAST ON THE KIT'S CLOCK: it settles in, and it leaves quickly.
 *
 * Sonner enters over 400ms on a bare \`ease\` and exits over the same 400ms.
 * The kit's grammar is asymmetric on purpose — a surface arrives on the reveal
 * tween (250ms, \`easeReveal\`) and a bounded receipt is dismissed in 150ms on
 * the same curve, because dismissal hands control back (ADOPTION-GUIDE § 8).
 *
 * Restated as the full shorthand rather than a \`transition-duration\`, because
 * the vendor's declaration names four properties with three timings and a
 * partial override would leave the rest on the old clock. \`height\` is in the
 * list because Sonner animates the card's measured height when the stack
 * expands; \`box-shadow\` is the focus ring arriving, so it takes the hover rung.
 */
[data-sonner-toast] {
  transition:
    transform ${t.duration.reveal} ${t.easeReveal},
    opacity ${t.duration.reveal} ${t.easeReveal},
    height ${t.duration.reveal} ${t.easeReveal},
    box-shadow ${t.duration.hover} ${t.ease};
}
/* Sonner fades the card's contents in as the stack expands, on its own 400ms.
   Same argument, same rung. The title and body are listed too: the content
   column is \`display: contents\` (see the card grid), which has no box for an
   opacity to act on, so Sonner's \`> *\` rule no longer reaches them. */
[data-sonner-toast] > *,
[data-sonner-toast] [data-content] > * { transition: opacity ${t.duration.reveal} ${t.easeReveal}; }
[data-sonner-toast][data-expanded='false'][data-front='false'][data-styled='true'] [data-content] > * {
  opacity: 0;
}

/*
 * THE ENTRANCE SCALES IN PLACE; IT DOES NOT SLIDE UP FROM THE EDGE.
 *
 * Sonner parks an unmounted card at \`translateY(100%)\` — a full card-height
 * below its slot — and slides it up. The kit says nothing slides in: a slide
 * implies a place the surface came from, and a toast came from nowhere. So the
 * card starts in its own slot at 0.96 and transparent, and settles to 1 on the
 * reveal tween, the same entrance the kit gives a dialog.
 *
 * (0,3,0) against the vendor's (0,2,0) \`[data-y-position]\` rule, and scoped to
 * \`data-mounted='false'\` so the stacked and expanded positions Sonner computes
 * for a mounted card are untouched.
 */
[data-sonner-toast][data-mounted='false'][data-y-position] {
  --y: scale(0.96);
}

/*
 * THE EXIT FADES TO 0.99 OVER 150MS, the kit's \`surface-exit\`, where Sonner
 * lifts the card a full height away over 400ms.
 *
 * Three rules because the vendor has three removal states — the front card, a
 * card behind it in an expanded stack, and one behind it in a collapsed stack —
 * and each is restated at the vendor's own specificity so this one wins by
 * coming second. Each keeps the position the card already had and only fades
 * it: a dismissed card leaves where it is, it does not travel. Sonner unmounts
 * 200ms after removal, so the 150ms fade finishes first.
 */
[data-sonner-toast][data-removed='true'][data-front='true'][data-swipe-out='false'] {
  --y: scale(0.99);
  opacity: 0;
  transition: transform ${t.duration.exit} ${t.easeReveal}, opacity ${t.duration.exit} ${t.easeReveal};
}
[data-sonner-toast][data-removed='true'][data-front='false'][data-swipe-out='false'][data-expanded='true'] {
  --y: translateY(calc(var(--lift) * var(--offset))) scale(0.99);
  opacity: 0;
  transition: transform ${t.duration.exit} ${t.easeReveal}, opacity ${t.duration.exit} ${t.easeReveal};
}
[data-sonner-toast][data-removed='true'][data-front='false'][data-swipe-out='false'][data-expanded='false'] {
  --y: translateY(calc(var(--lift-amount) * var(--toasts-before))) scale(calc(-1 * var(--scale)));
  opacity: 0;
  transition: transform ${t.duration.exit} ${t.easeReveal}, opacity ${t.duration.exit} ${t.easeReveal};
}
/* A swipe is the reader's own gesture, so its follow-through keeps the
   vendor's direction and only takes the exit rung (the vendor runs 200ms). */
[data-sonner-toast][data-swipe-out='true'][data-y-position='bottom'],
[data-sonner-toast][data-swipe-out='true'][data-y-position='top'] {
  animation-duration: ${t.duration.exit};
  animation-timing-function: ${t.easeReveal};
}

/*
 * The palette, in place of both of Sonner's built-in themes.
 *
 * \`[data-sonner-theme]\` with no value matches whichever one the library picked,
 * so the editor's two themes are handled by the tokens themselves — every value
 * here is a \`var(--de-*)\` that \`css/base.ts\` re-declares on \`:root\` when
 * \`data-de-theme\` flips, and custom properties inherit THROUGH a shadow
 * boundary. Nothing in this file has to know which theme is up.
 */
[data-sonner-toaster][data-sonner-theme] {
  --normal-bg: ${t.color.bgRaised};
  --normal-bg-hover: ${t.color.bgHover};
  --normal-border: ${t.color.border};
  --normal-border-hover: ${t.color.borderStrong};
  --normal-text: ${t.color.text};
}

/*
 * The card itself. Sonner's own numbers are a product surface's — 16px of
 * padding, 13px type, a 10% black cast — and this is chrome: it has to match
 * the inspector rows it appears beside, not the marketing site it was designed
 * on.
 *
 * NO BORDER AND NO TINT. Every kind is the same plain card, and it wears the
 * kit's floating-card elevation whole: \`shadow.popover\` is the overlay cast,
 * the one card-family hairline (drawn as a shadow layer, so it costs no
 * layout) and, in dark, the top rim light. The glyph alone says what kind a
 * card is. The padding is set with the grid below, which it depends on.
 *
 * THE LEADING IS A ROLE NOW, AND THE DESCRIPTION'S WAS UNDER THE FLOOR.
 *
 * These three rules carried \`16px\`, \`16px\` and \`15px\` — numbers picked to
 * match a root that was also a flat \`16px\`, which is how a leading gets copied
 * rather than chosen. On the description the copy was the damaging one: 15px on
 * the 11px \`caption\` rung is 1.36, and a toast description is the one run of
 * prose in this component. \`better-typography\` puts the floor at 1.4 for
 * anything wrapping to three lines "even in a height-constrained row", and a
 * toast is exactly that row — \`Wrote 3 changes, skipped 1 — the file moved.
 * Queued in Changes.\` is three lines at this width, set at 1.36.
 *
 * So the card and its title take \`leadingRow\` (the chrome's own) and the
 * description takes \`leadingBody\`, because it is the only part of a toast a
 * reader reads as a sentence rather than as a label.
 */
[data-sonner-toast][data-styled='true'] {
  padding: ${t.space.md}px ${t.space.sm}px ${t.space.md}px ${t.space.md}px;
  border: none;
  font-size: ${t.type.body};
  line-height: ${t.type.leadingRow};
  box-shadow: ${t.shadow.popover};
}

/*
 * THE CARD IS A GRID, SO THE GLYPH CAN CENTRE ON THE TITLE.
 *
 * Sonner lays the card out as a flex row: glyph, then a content column holding
 * title and body, then the buttons. In that row the glyph is a sibling of the
 * COLUMN, so it can centre on the whole column (between title and body) or sit
 * at its top — never on the title alone. A title that wraps, which a server's
 * own error text does ("The agent route returned an error (500)"), left the
 * glyph on its first line, 8px above the title's middle.
 *
 * So the content column is \`display: contents\` and the title and body become
 * grid items of the card: row 1 is the title with the glyph, the action and the
 * close button beside it; row 2 is the body under the title. Every item in
 * row 1 centres on that row, and the row is exactly as tall as the title,
 * because the 24px buttons give back their overhang (\`BUTTON_BLEED\`).
 *
 * No grid gaps: the glyph's column is empty on a news card, and a column gap
 * would still indent the text past it. The spacing lives on the items instead.
 *
 * THE PADDING IS \`space.md\` TOP AND BOTTOM, \`space.sm\` ON THE RIGHT. With a
 * 16px title row that puts a 24px close button 8px from the top and the right
 * edge, concentric in the card's corner (see \`CLOSE_RADIUS\`), and makes a
 * one-line card 40px — the height it had before.
 */
[data-sonner-toast][data-styled='true'] {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0;
}
[data-sonner-toast][data-styled='true'] [data-content] { display: contents; }

/*
 * Title and body. The title is a short label in full ink; the body is the
 * sentence under it, in muted ink at body weight. Same size, per the kit's
 * rule that hierarchy is carried by weight and colour, not a pixel of size.
 */
[data-sonner-toast][data-styled='true'] [data-title] {
  grid-area: 1 / 2;
  font-weight: ${t.type.weightSection};
  line-height: ${t.type.leadingRow};
  /* A title is a phrase that must not be left with one word alone on line two.
     \`pretty\` is the declaration for that and costs nothing where it does not
     apply — a one-line title is unaffected. */
  text-wrap: pretty;
}

/*
 * Sonner hard-codes \`#3f3f3f\` here — a light-theme grey that is unreadable on
 * the dark chrome and wrong on the light one. It is spelled at (0,3,0) there,
 * so it is spelled at (0,3,0) here.
 */
[data-sonner-toast][data-styled='true'] [data-description] {
  grid-area: 2 / 2;
  margin-top: ${t.space["3xs"]}px;
  color: ${t.color.textMuted};
  font-size: ${t.type.caption};
  font-weight: ${t.type.weightBody};
  line-height: ${t.type.leadingBody};
  text-wrap: pretty;
}

/*
 * Only an error has a glyph (news is raised untyped, see \`emit\` in
 * \`core/toast.ts\`), so the danger ink below is the only colour in the toaster.
 *
 * THE GAP AFTER THE GLYPH EQUALS THE GAP BEFORE IT. The card's leading padding
 * is \`space.md\`, and so is the glyph's trailing margin. Sonner's own nudges
 * (\`--toast-icon-margin-*\`, \`--toast-svg-margin-*\`, a -3px pull toward the
 * edge and 4px push away) are zeroed, since they are what made the two sides
 * differ. The glyph's own inset in its box is the same on both sides, so equal
 * boxes read as equal gaps.
 *
 * It sits in the title's row and centres on it — on both lines when the title
 * wraps (see the card grid above).
 */
[data-sonner-toast][data-styled='true'] [data-icon] {
  grid-area: 1 / 1;
  height: ${t.icon.inline}px;
  width: ${t.icon.inline}px;
  margin: 0 ${t.space.md}px 0 0;
}
[data-sonner-toast][data-type='error'] [data-icon] { color: ${t.color.danger}; }
[data-sonner-toast][data-styled='true'] [data-icon] > svg {
  height: ${t.icon.inline}px;
  width: ${t.icon.inline}px;
  margin: 0;
}

/*
 * The action ("Undo"): a text button in the accent ink, no fill. A filled button
 * on a card this small outweighs the sentence it belongs to. \`accentText\` is
 * the accent rung measured for text on a panel ground.
 *
 * \`CONTROL_RADIUS\`, the one corner every text button in the chrome shares, and
 * the ghost hover lands on \`bgRaisedHover\` because the card is \`bgRaised\` —
 * \`bgHover\` is the same rung as the card in dark and would paint nothing.
 * Hover paint only on a real pointer; press is the kit's 2% dip.
 */
[data-sonner-toast][data-styled='true'] [data-button] {
  grid-area: 1 / 3;
  height: ${t.size.rowHeight}px;
  padding: 0 ${t.space.sm}px;
  margin: ${BUTTON_BLEED}px 0 ${BUTTON_BLEED}px ${t.space.sm}px;
  border-radius: ${CONTROL_RADIUS};
  font-size: ${t.type.body};
  font-weight: ${t.type.weightValue};
  background: transparent;
  color: ${t.color.accentText};
  transition: background-color ${t.duration.hover} ${t.ease}, box-shadow ${t.duration.hover} ${t.ease},
    transform ${t.duration.hover} ${t.ease};
}
[data-sonner-toast][data-styled='true'] [data-cancel] {
  background: ${t.color.field};
  color: ${t.color.text};
}
@media (hover: hover) and (pointer: fine) {
  [data-sonner-toast][data-styled='true'] [data-button]:hover {
    background: ${t.color.bgRaisedHover};
  }
  [data-sonner-toast][data-styled='true'] [data-cancel]:hover {
    background: ${t.color.fieldHover};
  }
}
[data-sonner-toast][data-styled='true'] [data-button]:active { transform: scale(0.98); }

/*
 * The close button, moved from Sonner's floating corner badge into the card as
 * its trailing control: after the action, a ✕ that only takes a plate on
 * hover. It is an icon-only action, so its glyph is its whole label and it
 * wears full ink in every state — a muted ✕ reads as disabled (kit § 5).
 *
 * Sonner renders it FIRST in the card's DOM; its grid column is what puts it
 * last. It keeps to the TOP of the title row rather than its middle, so a
 * title that wraps leaves it in the corner it is concentric with — on a
 * one-line title the two are the same place. Spelled at (0,5,0) to beat both
 * of the vendor's themed rules for it — the dark one is (0,4,0), and both
 * \`:hover\` rules are (0,5,0) and lose on order.
 */
[data-sonner-toaster][data-sonner-theme] [data-sonner-toast][data-styled='true'] [data-close-button] {
  grid-area: 1 / 4;
  align-self: start;
  margin: ${BUTTON_BLEED}px 0 ${BUTTON_BLEED}px ${t.space.sm}px;
  position: static;
  transform: none;
  height: ${t.size.rowHeight}px;
  width: ${t.size.rowHeight}px;
  border: none;
  border-radius: ${CLOSE_RADIUS};
  background: transparent;
  color: ${t.color.text};
  transition: background-color ${t.duration.hover} ${t.ease}, box-shadow ${t.duration.hover} ${t.ease},
    transform ${t.duration.hover} ${t.ease};
}
@media (hover: hover) and (pointer: fine) {
  [data-sonner-toaster][data-sonner-theme] [data-sonner-toast][data-styled='true'] [data-close-button]:hover {
    background: ${t.color.bgRaisedHover};
    color: ${t.color.text};
  }
}
[data-sonner-toaster][data-sonner-theme] [data-sonner-toast][data-styled='true'] [data-close-button]:active {
  transform: scale(0.98);
}

/*
 * The focus ring the rest of the chrome wears, in place of Sonner's
 * \`rgba(0,0,0,0.2)\` halo — which is invisible on a dark ground, and this is the
 * ring a keyboard user lands on when they reach a toast with alt+T.
 *
 * \`accent\`, not \`focusHalo\`, and the difference matters on paper. \`focusHalo\`
 * is the LIGHT HALF of the note pin's two-tone ring — fixed white in both
 * themes on a stated argument (\`tokens.ts\`: the pin is drawn over the app, so
 * the editor's theme says nothing about what is behind it). A toast is not
 * drawn over the app; it is chrome on \`bgRaised\`, which on paper is \`#ffffff\`.
 * A white ring on a white card is 1:1 — the indicator was invisible in exactly
 * one of the two themes, and it was invisible for the same reason the vendor's
 * black one is invisible in the other. \`accent\` is the ring every other
 * focusable thing in this chrome wears, and it is legible on both grounds.
 *
 * The shape is the kit's: the card's edge takes the accent (a 1px layer over
 * the hairline) and a 3px halo of the accent at 30% sits outside it.
 */
[data-sonner-toast]:focus-visible {
  box-shadow: 0 0 0 1px ${t.color.accent}, 0 0 0 4px ${HALO}, ${t.shadow.popover};
}

/*
 * THE THREE INTERACTION STATES THIS FILE USED TO STOP SHORT OF.
 *
 * Everything above re-inks the toast at REST: the card, the glyphs, the
 * buttons, the card's own focus ring. Sonner also styles what happens when you
 * tab onto either button, and those rules were left wearing the vendor's own primitives —
 * a light-theme palette hardcoded in the bundled sheet, which is the one thing
 * overriding \`--normal-*\` cannot reach.
 *
 * \`rgba(0,0,0,0.2)\` and \`rgba(0,0,0,0.4)\` are black halos, and the card under
 * them is \`bgRaised\` — \`#333333\` in dark, \`#ffffff\` on paper. Composited
 * against the card they come to well under the 3:1 WCAG 1.4.11 asks of a focus
 * indicator, and unlike a colour that is merely off-brand a focus ring nobody
 * can see is the difference between a keyboard user knowing where they are and
 * not. \`accent\` is the ring every other focusable thing in this chrome wears,
 * including — three rules up — the toast card itself, so a keyboard user now
 * meets ONE focus design whether they are on the card, its action, or its
 * dismiss.
 */
[data-sonner-toast][data-styled='true'] [data-close-button]:focus-visible,
[data-sonner-toast][data-styled='true'] [data-button]:focus-visible {
  box-shadow: ${FOCUS_RING};
}
`

/** Sonner's stylesheet, then ours. The order is the mechanism — see above. */
export const toasterCss = `${sonnerCss}\n${overrides}
/*
 * REDUCED MOTION: THE TRAVEL GOES, THE FADE STAYS.
 *
 * The vendor ships a reduced-motion block that takes every transition and
 * animation off \`[data-sonner-toast]\` — so a card simply appears and vanishes
 * — and it misses \`[data-sonner-toaster]\`, the list, whose reflow transition
 * this file sets. The kit asks for the opposite trade on both counts: remove
 * spatial travel, keep state feedback (MICRO-INTERACTIONS § 20). So the stack's
 * reflow and every transform stop, and the card keeps a short opacity fade in
 * and out, which is feedback rather than movement.
 *
 * Restated inside the shadow root because a document stylesheet does not cross
 * that boundary. \`!important\` because the vendor's block it answers carries one.
 */
@media (prefers-reduced-motion: reduce) {
  [data-sonner-toaster] { transition: none !important; }
  [data-sonner-toast],
  [data-sonner-toast] > *,
  [data-sonner-toast] [data-content] > * {
    transition: opacity ${t.duration.exit} linear !important;
    animation: none !important;
  }
  [data-sonner-toast][data-mounted='false'][data-y-position],
  [data-sonner-toast][data-removed='true'][data-front='true'][data-swipe-out='false'] {
    --y: none;
  }
  [data-sonner-toast] [data-button]:active,
  [data-sonner-toaster] [data-sonner-toast] [data-close-button]:active { transform: none !important; }
}
`
