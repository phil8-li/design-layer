/**
 * Annotations: the markers drawn over the app, and the tab that lists them.
 *
 * One module for two surfaces, because they are two halves of one object. A
 * note is a numbered pin on the canvas AND a row in the panel, and the number
 * is the only thing joining them — so the disc on the page and the disc in the
 * row have to be cut from the same rule or the mapping stops being readable
 * the moment either one drifts.
 *
 * The marker is the chrome's indigo accent (`accentSurface` under white
 * `onAccent`), the same hue the selection and every primary control wear. It
 * used to be a user-picked colour from a swatch row that no longer exists;
 * every distinction below still carries a non-colour channel, because hue is
 * not a difference every reader can see.
 *
 * Every text run in a panel row is a single line with an ellipsis, for the
 * reason prompts.ts already documents: a 260px panel plus one long value pushes
 * a row to four lines and the list stops being scannable, which is the only
 * thing a list is for. The untruncated text goes in the `title`.
 */

import { tokens as t, nest } from "../tokens"

/**
 * The pin, in px, and the disc that stands for it in a panel row.
 *
 * Two numbers rather than one: the canvas pin has a whole product page to be
 * found on and the row badge has a 260px column, so they are not the same
 * object at two sizes. They are written together here so a change to the pin
 * is made in sight of the thing that has to keep matching it.
 *
 * `MARKER` is exported because `canvas.ts` fans pins that share an anchor out
 * sideways by exactly one pin and a gap, and a spacing restated there would
 * drift the first time the pin is resized here.
 */
export const MARKER = 22
const INDEX = 16

/**
 * How small a glyph gets while it is the one leaving.
 *
 * Agentation's own number, and it is worth keeping rather than rounding to a
 * token: at 0.8 a 12px mark loses 2.4px across its diagonal, which the eye
 * reads as a direction without ever resolving a size. Deeper and the outgoing
 * glyph collapses to a dot; shallower and the two marks look like one mark
 * blurring into another.
 */
const SWAP_SCALE = 0.8

/**
 * The composer card, the textarea filling its top, and the Save button in its
 * bottom corner.
 *
 * Unusually for this chrome the offset here is a real distance rather than a
 * thin rail: `space.sm` between the two curves, because the card is a popover
 * with room in it and not a pill wrapped around a row. What reaches its bottom
 * corner is the shared `.de-button`, which wears the fields' 8px corner
 * (`CONTROL_RADIUS`). So the inset fixes what the OUTER radius has to be:
 * 8 + 8 = 16, `radius["3xl"]` — the kit's popover and card rung. The textarea
 * in the top corners takes the same 8, so the field and the button beside it
 * round alike.
 *
 * Solved from the outside for the reason it always was: `.de-button` is shared
 * furniture, and a button that rounds differently depending on which surface
 * it stands on is worse than a card one rung rounder. No hairline in the
 * arithmetic: the card's edge is the 1px ring inside `shadow.popover`, which
 * takes no room, so the padding is the whole gap.
 */
const COMPOSER = nest({ of: ".de-ann-composer", outer: t.radius["3xl"], inset: t.space.sm })

/*
 * THE OUTBOX HAS NO BOX, and the nest that described one went with it.
 *
 * `BOX` used to declare `.de-ann-box` at `radius.lg` over a 4px inset carried
 * by `.de-ann-list` — the only nest in the chrome whose padding lived on a
 * wrapper rather than on the container itself, and the reason `nest()` grew its
 * `padOn` parameter. What it described was a bordered, rounded, sunken frame
 * around rows that are each already bordered, rounded and raised. Removing the
 * frame removes the only pair of curves there was anything to keep parallel.
 *
 * `padOn` stays on `nest()`. It is still the honest way to describe a container
 * holding a child at a distance it does not declare itself, and the next person
 * to need it should not have to rediscover that it exists.
 */

/**
 * A row, and the two `.de-mini` buttons parked in its top-right corner.
 *
 * The row is a two-column grid — text, then an `auto` column of actions — so
 * the thing in the corner is a button, not the head.
 *
 * The row is a card, so it takes the kit's card rung, `radius["3xl"]` (16), over
 * a `space.sm` inset (a 7px pad inside a 1px hairline). The `.de-mini` in the
 * top-right sits at the nest's inner radius, 16 − 8 = 8, which is `radius.sm` —
 * the rung the kit gives an icon-only mini button. The two numbers are one
 * decision: the card's corner and the button's corner stay parallel.
 */
const ITEM = nest({ of: ".de-ann-item", outer: t.radius["3xl"], inset: t.space.sm, hairline: 1 })

/**
 * How much the pin grows when the panel points at it.
 *
 * Small on purpose. The pin sits over someone else's layout, so a pop big
 * enough to be a gesture would also be big enough to cover the thing the note
 * is about — at ${MARKER}px this is under three pixels of growth, which the eye catches
 * as movement without the disc taking any more of the page.
 */
const ACTIVE_SCALE = 1.12

/**
 * The tab's gutter, and the air between the two stacked sections.
 *
 * The tab is one column now — Notes, then Settings — so the only thing telling
 * a reader where one section ends is the space under it. `space.sm` is the
 * panel's own inset everywhere else; `space.lg` is twice that, which is the
 * smallest step on the kit's scale that still reads as "a different section"
 * rather than "a wider row gap" once the section titles are as quiet as they
 * are below.
 */
const GUTTER = t.space.sm
const SECTION_GAP = t.space.lg
/** Hairline to section title: the header's own 8 plus the section's 4. */
const SECTION_LEAD = t.space.md

/**
 * The floor for anything you have to hit.
 *
 * 24 is the pointer target WCAG 2.5.8 asks for and the height of every field
 * in this shell, so a control that draws smaller earns its hit area back from
 * a transparent pad rather than by growing.
 */
const TARGET = 24

/**
 * The switch's drawing: a 28x16 track and a 12px knob. Sizes, not spacing —
 * the knob's 12px of travel is the track less the knob less its 1px border
 * clearance on each end.
 */
const TRACK_W = 28
const TRACK_H = 16
const KNOB = 12

/**
 * The keyboard focus ring, the kit's recipe (MICRO-INTERACTIONS § 3): the edge
 * takes the accent and a 3px halo of the accent at 30% (`accentHalo`) sits
 * outside it.
 */
const FOCUS_RING = `0 0 0 1px ${t.color.accent}, 0 0 0 4px ${t.color.accentHalo}`

/**
 * The overlay's rung, and the composer's stated one above it.
 *
 * Written relative rather than as two literals so they cannot drift. The
 * composer has to beat the markers it is anchored to whether it is mounted
 * inside the layer or beside it, and a second literal is how that stops being
 * true after someone renumbers one of them.
 *
 * The band is the one `options.ts` uses for a fixed surface that is NOT inside
 * `.de-root`'s stacking context — annotation chrome outlives a chrome-hidden
 * editor, so it cannot borrow the 1/2/3 ordering base.ts gives `.de-root`'s
 * own children.
 */
const LAYER_Z = 2147483100
const COMPOSER_Z = LAYER_Z + 1

export const annotationsCss = `/* ---------- annotation overlay ---------- */
.de-ann-layer { position: fixed; inset: 0; pointer-events: none; z-index: ${LAYER_Z}; }

/*
 * The pin floats over product pixels of an unknown colour: the chrome's indigo
 * \`accentSurface\` under a white numeral (4.97:1 dark, 6.7:1 light), a tight
 * cast and a hairline of shadow rather than a border.
 *
 * That last part is the bit worth naming, because it is not how the rest of this
 * chrome draws an edge. There is no \`border\` here at all — the disc's boundary
 * is the second layer of \`shadow.marker\`, an INSET hairline, so the edge is
 * painted inside the circle instead of around it. A real border would grow the
 * 22px disc to 24 and put a hard line between the fill and the page; an inset
 * shadow darkens the fill's own rim, which reads as the disc curving away rather
 * than as a ring drawn on top of it. The outer \`0 2px 6px\` cast is what lifts it
 * off the page.
 *
 * The layer is \`pointer-events: none\` so the app underneath stays usable, so
 * the marker has to switch them back on for itself. It is the only thing in
 * here that takes a pointer.
 */
.de-ann-marker {
  position: absolute;
  width: ${MARKER}px; height: ${MARKER}px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  border: none; border-radius: 50%;
  background: ${t.color.accentSurface};
  color: ${t.color.onAccent};
  box-shadow: ${t.shadow.marker};
  /* The caption rung at the strong weight: the pin's numeral is a label read at
     a glance, and it keeps one width as the count grows (tabular figures). */
  font-family: inherit; font-size: ${t.type.caption}; font-weight: ${t.type.weightSection};
  line-height: ${t.type.leadingFlush};
  cursor: pointer;
  user-select: none;
  pointer-events: auto;
  /*
   * The kit's hover tween for all three. This was Agentation's split — colour
   * at 150ms, the grow at a literal 100ms — and the 100 was a number off the
   * ramp. At one rung the hue and the grow finish together, which is what the
   * split was protecting against in the first place: a pin that lags.
   */
  transition: background-color ${t.duration.hover} ${t.ease}, transform ${t.duration.hover} ${t.ease},
    box-shadow ${t.duration.hover} ${t.ease};
}
/*
 * A PIN LANDING ON THE PAGE, which is the one moment here that is an object
 * arriving rather than a value changing.
 *
 * Saving a note revealed a pooled node with \`display: block\` — not something
 * the browser can animate, so the rule above never had anything to do with the
 * arrival even though it transitions all three of the properties involved.
 *
 * So it is a keyframe, on \`easeSpring\`, which \`tokens.ts\` reserves for exactly
 * this sentence. From 0.3 rather than 0.8: the pin is 22px and lands somewhere
 * the user was not looking, so it has to be caught out of the corner of the eye
 * — a small pop at this size is indistinguishable from the node simply being
 * there. \`canvas.ts\` fires it once per NOTE, never per reveal, so scrolling a
 * pin back into view does not pop it again.
 */
@keyframes de-ann-marker-in { from { opacity: 0; transform: scale(0.3); } }
.de-ann-marker--arriving { animation: de-ann-marker-in ${t.duration.reveal} ${t.easeSpring}; }
/* ${MARKER}px drawn, ${TARGET}px hit. A pin is a click target on a page it shares with the
   app's own controls, and ${MARKER} is under the ${TARGET} WCAG 2.5.8 asks for; a transparent
   pad buys the 1px a side back without growing the disc. */
.de-ann-marker::before {
  content: "";
  position: absolute; inset: -${(TARGET - MARKER) / 2}px;
  border-radius: 50%;
}
/*
 * An EDIT's pin: the same fill, number and states, on a rounded square.
 *
 * Notes and edits share one numbering and one colour, so the colour cannot be
 * what tells them apart — and it must not be, because a pin sits over product
 * pixels of any hue and in front of readers who may not see the difference.
 * Shape survives both. The disc is a remark about the page; the square is a
 * change already made to it, and the corner is the kit's tightest so the two
 * still read as one family at ${MARKER}px.
 *
 * \`.de-ann-marker\` is on \`css/base.ts\`'s round opt-out list because the disc
 * is a circle; the square is not, so it takes the chrome's squircle back.
 */
.de-ann-marker--edit { border-radius: ${t.radius.xs}; corner-shape: ${t.cornerShape}; }
.de-ann-marker--edit::before { border-radius: ${t.radius.xs}; corner-shape: ${t.cornerShape}; }
/*
 * Hover grows the pin itself — Agentation's 1.1, not a ring.
 *
 * This used to paint a 3px halo of the marker's own colour, on the reasoning
 * that a ring of itself reads as the same object answering. That reasoning
 * holds, and it is still the wrong move for a 22px disc on someone's page: a
 * halo makes the pin 28px for as long as the pointer is near it, so pins that
 * sit close together start touching on hover and the page looks like it grew
 * something. Scaling changes the pin's size without changing the space it
 * claims from its neighbours.
 *
 * On the hover tween, from the \`transform\` part of the base rule.
 */
/*
 * ## AND IT IS BEHIND \`hover: hover\`, WHICH ALMOST NOTHING IN THIS CHROME IS
 *
 * There are eighty-odd \`:hover\` rules here and this is one of three that get
 * the wrapper. The other seventy-nine change a background, a border or an ink
 * colour: on a touch device the tint sticks after a tap until the next tap
 * moves it, which is invisible as a defect and not worth doubling the nesting
 * of every stylesheet in the chrome to prevent.
 *
 * A TRANSFORM is different in kind, and this one especially. The pin is drawn
 * over the app being reviewed, not over a surface this editor owns — so a pin
 * left frozen at 110% beside its unhovered neighbours does not read as stale
 * editor chrome, it reads as a rendering fault in the app under review. That is
 * the one thing a design tool must never do to the thing it is measuring.
 *
 * Reachable in practice, not in theory: the servers bind loopback so no phone
 * can open this, but a touchscreen laptop can, and so can DevTools device
 * emulation — which reports \`hover: none\` and is exactly what a designer uses
 * to check their own mobile breakpoints, with this chrome on screen.
 */
@media (hover: hover) and (pointer: fine) {
  .de-ann-marker:hover { transform: scale(1.1); }
}
/*
 * Two tones, because this is the one focus ring in the chrome that lands on a
 * page nobody here chose.
 *
 * Every other control is focused against a surface this stylesheet painted, so
 * a single accent ring has a known ratio behind it. A pin sits on the app being
 * edited, over whatever colour happens to be there: the accent clears 3:1 on a
 * white page, and on an indigo or mid-tone one it is visible only in the sense
 * that it is a different hue — not in the sense WCAG 1.4.11 means, which is the
 * sense that survives a monochrome display or a red-green deficiency.
 *
 * A dark ring wrapped in a white one cannot fail both ways at once, and the
 * pair reads as one ring at any size because they are concentric and adjacent.
 * The colours are fixed roles that do not follow the editor's theme — the ring
 * is over the app, so the theme says nothing about what is behind it. As the
 * palette stands, \`focusCore\` is near-black and \`focusHalo\` white.
 *
 * \`box-shadow\` for the outer tone rather than a second outline: an element gets
 * one outline, and the shadow is already on this rule's transition so the ring
 * arrives with the same timing as everything else the pin does.
 */
.de-ann-marker:focus-visible {
  /* \`focusCore\`, not \`onAccent\`: the numeral's ink is white, and this
     ring's inner tone is the dark one. */
  outline: 2px solid ${t.color.focusCore};
  outline-offset: 2px;
  box-shadow: ${t.shadow.marker}, 0 0 0 6px ${t.color.focusHalo};
}

/*
 * The pin whose ROW the pointer is in — the other half of the correspondence.
 *
 * \`canvas.ts\` puts this class on the one marker the panel is pointing at, and
 * until now there was no rule for it at all: the row lit up and the page did
 * nothing, which reads as the mapping being broken rather than as the pin being
 * somewhere off screen.
 *
 * Three channels, because one is not enough over product pixels of an unknown
 * colour. A ${Math.round((ACTIVE_SCALE - 1) * 100)}% grow is the movement the eye catches in peripheral vision while
 * it is still reading the row; \`z-index\` lifts it out from under the pins it
 * overlaps in a dense corner; and the ring is the part that has to survive any
 * background, so it is TWO rings at opposite ends of the scale — 2px of the
 * panel ground, then 2px of the text ink: near-black then white in dark, white
 * then near-black in light. Against a white page the dark ring is the edge,
 * against a dark page the white one is, and against the user's own marker
 * colour both are.
 *
 * Not the editor accent: an indigo ring around an orange pin reads as a second
 * object arriving, and it says nothing at all if indigo is what the user picked.
 */
.de-ann-marker--active {
  z-index: 1;
  transform: scale(${ACTIVE_SCALE});
  box-shadow: ${t.shadow.marker}, 0 0 0 2px ${t.color.bg}, 0 0 0 4px ${t.color.text};
}

/*
 * The composer, anchored to the pin that opened it.
 *
 * Above the markers, and it has to be: it opens next to one and would otherwise
 * be punched through by the disc it belongs to. \`pointer-events: auto\` for the
 * same reason the marker needs it — the layer around it lets everything fall
 * through to the app.
 */
.de-ann-composer {
  position: absolute;
  z-index: ${COMPOSER_Z};
  display: flex; flex-direction: column; gap: ${t.space.sm}px;
  padding: ${COMPOSER.padding};
  border: none; border-radius: ${COMPOSER.outer};
  background: ${t.color.bgRaised};
  box-shadow: ${t.shadow.popover};
  pointer-events: auto;
  /*
   * Aimed at the pin: \`annotations/canvas.ts\`'s \`place\` flips this card above
   * the anchor when dropping below would overrun the viewport, and writes the
   * edge nearest the pin here through \`arriveFrom\`. The card has no entrance
   * any more, so the origin is only read by the exit below.
   */
  transform-origin: var(--de-arrive-origin, center top);
}
/*
 * IT OPENS INSTANTLY AND LEAVES OVER 150MS — the kit's popover grammar.
 *
 * The composer is a popover anchored to a pin, opened on every note, and it
 * takes a keystroke the moment it exists; the kit gives such surfaces no
 * entrance at all (MICRO-INTERACTIONS § 6, § 18). It used to rise 4px and fade
 * in. The dismissal is the kit's bounded fade to 0.99, played on an inert copy
 * (\`playExit\` in core/motion), because the real card must be gone the
 * instant it is saved or cancelled.
 */
/*
 * Wide enough for a sentence before it wraps, and it grows DOWN only — as the
 * note is typed, not as a corner is dragged.
 *
 * The grip is off on BOTH axes, which is a change from the \`resize: vertical\`
 * this shipped with. The card is a popover anchored to a pin: \`place\` in
 * \`annotations/canvas.ts\` measures it once, on open, and clamps it between the
 * docked panels and the foot of the window. A drag on the grip resizes it after
 * that measurement and nothing re-places it, so a note taken on the lower half
 * of a page could be dragged until Save sat under the edge of the window, with
 * the only other way out being Escape. Dragging a field also reads as dragging
 * the card, which this popover does not do.
 *
 * Height is still the axis a note needs, so \`openComposer\` grows the field on
 * input up to this ceiling and the field scrolls past it. The ceiling is what
 * keeps the growth bounded where the grip was not: roughly eight lines, longer
 * than any note in the journal, and short enough that the card still fits
 * beside the pin it belongs to.
 */
.de-ann-composer-text {
  min-width: 180px;
  min-height: 56px;
  max-height: 200px;
  overflow-y: auto;
  resize: none;
  padding: ${t.space.sm}px;
  /* Read off the card's nest: the same 14 as the Save button in the opposite
     corner, so the card's two inner curves agree. See \`COMPOSER\`. */
  border: 1px solid transparent; border-radius: ${COMPOSER.radius};
  background: ${t.color.field};
  color: ${t.color.text};
  font-family: inherit; font-size: ${t.type.body};
  line-height: ${t.type.leadingBody};
  outline: none;
  transition: border-color ${t.duration.hover} ${t.ease}, background-color ${t.duration.hover} ${t.ease};
}
@media (hover: hover) and (pointer: fine) {
  .de-ann-composer-text:hover { background: ${t.color.fieldHover}; }
}
/* The kit's field focus: the border takes the accent. A textarea matches
   \`:focus-visible\` on every focus, pointer included, which is right for a
   field — the caret is about to be used. */
.de-ann-composer-text:focus-visible { background: ${t.color.fieldHover}; border-color: ${t.color.accent}; }
.de-ann-composer-text::placeholder { color: ${t.color.textDim}; }
.de-ann-composer-actions { display: flex; align-items: center; justify-content: flex-end; gap: ${t.space["2xs"]}px; }

/*
 * The drag rectangle, while it is being dragged.
 *
 * Dashed, because the box is not committed until the pointer comes up — the
 * same reading the canvas already gives a dashed outline. The stroke is the
 * accent and the wash its \`selectionSurface\` tint, so the fill and the stroke
 * are obviously one object over a page whose own colours are unknown.
 */
.de-ann-region {
  position: absolute;
  border: 2px dashed ${t.color.accent};
  border-radius: ${t.radius.xs};
  background: ${t.color.selectionSurface};
  pointer-events: none;
  transition: none;
  animation: none;
}

/*
 * The hover outline while annotating — deliberately NOT the selection outline.
 *
 * This is the point of the rule. Annotation mode and inspect mode both draw a
 * frame around whatever is under the pointer, and if the two frames look alike
 * the user cannot tell which one a click is about to do: pin a note, or select
 * an element and start editing it. So this one differs on two channels at once.
 * It is 2px where \`.de-outline\` is a hairline, and it is rounded where the
 * selection frame is square — so it still reads as the other mode even though
 * both now wear the indigo accent and the hue channel says nothing.
 */
.de-ann-target {
  position: absolute;
  border: 2px solid ${t.color.accent};
  border-radius: ${t.radius.xs};
  background: ${t.color.selectionSurface};
  pointer-events: none;
  transition: none;
  animation: none;
}

/* ---------- annotations tab ---------- */
/*
 * One column, one scroll, nothing pinned.
 *
 * The tab used to be three things fighting over the pane's height: a list that
 * scrolled inside its own box, a footer that followed it, and a settings block
 * nailed to the bottom edge by \`margin-top: auto\`. Two scrollbars is the visible
 * symptom — the pane's and the list's, four pixels apart — and the invisible one
 * is worse: a note scrolled out of the inner list could not be reached by
 * scrolling the tab, because the wheel was over the wrong box.
 *
 * So the tab is a plain stack now. Notes, then Settings, top to bottom, and the
 * ONE scroll belongs to \`.de-tabpanel\`, which already has \`overflow-y: auto\`
 * from inspector.ts. Nothing in here may set \`overflow-y\` on itself or the
 * second scrollbar comes back.
 *
 * \`flex: 1 0 auto\`: grow to fill a pane taller than the content, never shrink
 * below it. Shrinking is what would clip the last section instead of scrolling
 * to it.
 */
.de-ann {
  flex: 1 0 auto;
  display: flex; flex-direction: column;
  /* No side gutter: every section runs edge to edge, so each header's hover
     band is the panel's full width. The bodies inset their own content. */
  padding: 0 0 ${t.space.lg}px;
}

/*
 * THE TAB'S RHYTHM: closer to your own content than to the section above.
 *
 *   hairline → ${SECTION_LEAD}px → title → ${t.space.sm}px → content → ${SECTION_GAP}px → hairline
 *
 * The 32px header centres its title, so it already puts ${t.space.sm}px above and
 * below the words. The body drops its top padding, so the title sits ${t.space.sm}px
 * from what it heads, and the section adds ${t.space["2xs"]}px above the header, so the
 * title sits ${SECTION_LEAD}px from the hairline over it. The ${SECTION_GAP}px under the content
 * is the largest step in the tab, so where one section ends reads before
 * anything inside it does.
 */
.de-ann > .de-section { padding-top: ${t.space["2xs"]}px; }
.de-ann .de-section-body { padding: 0 ${GUTTER}px ${SECTION_GAP}px; }

/*
 * A section is a title and its contents, and the space under it is the only
 * thing separating it from the next.
 *
 * No hairline between them on purpose: the notes section already closes with a
 * bordered box, and a rule under that would land parallel to the box's own
 * bottom edge 8px away and read as a mis-drawn double border.
 */
.de-ann-section { display: flex; flex-direction: column; }
.de-ann-section + .de-ann-section { margin-top: ${SECTION_GAP}px; }
/*
 * THIS TAB'S HEADINGS ARE THE SHELL'S, not its own.
 *
 * There was a \`.de-ann-section-title\` here — a whole heading treatment, dim ink
 * at \`weightValue\`, restated for one tab. Every section in the Notes pane is
 * now an ordinary \`.de-section\` wearing the shared \`.de-section-title\` from
 * \`css/panels.ts\`, which is what the Design and Design-system tabs already use,
 * so the ladder below is the shell's and this file no longer has an opinion:
 *
 *   heading   ${t.type.body} / ${t.type.weightSection} / text        17.2:1 / 19.1:1
 *   metadata  ${t.type.body} / ${t.type.weightBody} / textDim     9.2:1 / 5.8:1   quietest
 *   controls  ${t.type.body} / ${t.type.weightValue} / textMuted  10.4:1 / 10.5:1 → text on hover
 *   row body  ${t.type.body} / ${t.type.weightBody} / text        17.2:1 / 19.1:1
 *
 * (Ratios dark / light, on the panel ground.)
 *
 * SIZE carries none of it and cannot: \`type\` tops out at ${t.type.body} and the floor for
 * this surface is ${t.icon.marker}px, so every run in the file is at the same rung and the
 * ladder is INK and WEIGHT alone. That is the better ordering here anyway — a
 * 260px column of one size reads as one list, and the eye sorts it by strength.
 */
/*
 * NO TALLY RULE HERE ANY MORE, and the deletion is the point.
 *
 * \`.de-ann-count\` rode the section heading with "1 note and 1 edit" in it,
 * while each group head under it carried a "1" of its own. Three statements of
 * the same arithmetic over a list you could count by looking. A count earns a
 * slot when what it counts is off screen; the rows ARE the section now, so it
 * never is.
 */
/*
 * THE DETAIL MENU, as a row in Settings: a name on the left, the chosen level
 * and a chevron on the right.
 *
 * This was \`.de-ann-formats\`, a scrolling strip of four segments that did
 * not fit 244px, then a caption-and-menu line above the list. It is a setting
 * now, so it is drawn as one: the shared label, and the menu pushed to the
 * trailing edge where the switches below it sit. A fixed basis rather than
 * \`flex: 1\`, so the menu is as wide as its longest level and the label keeps
 * the rest; it shrinks before the label clips.
 */
.de-ann-detail > .de-select-shell { flex: 0 1 112px; min-width: 0; margin-left: auto; }

/*
 * THE LIST, with nothing around it.
 *
 * There was a \`.de-ann-box\` here: a hairline, a \`radius.lg\` corner and a
 * \`bgSunken\` ground, wrapping the rows so they would "read as cards on a well".
 * They already read as cards — each row draws its own hairline, its own raised
 * ground, a numbered disc and a badge — so the well was a second frame around a
 * set of objects that were not short of definition. Three nested edges (panel,
 * box, row) for one list.
 *
 * Its two supporting details went with it and are worth recording as solved
 * rather than dropped. The box needed \`overflow: visible\` so a row's focus ring
 * would not be shaved at the first and last row; with no box there is nothing
 * to clip against. And the 4px the list padded by existed only to hold those
 * rings off the box's hairline; with no hairline the padding is zero and the
 * rows start on the section's own column, which is where every other row in the
 * inspector starts.
 *
 * Still no scroll: the pane above owns the only scrollbar, and a list that
 * scrolled inside it would be two scrollbars a few pixels apart.
 */
.de-ann-list {
  display: flex; flex-direction: column; gap: ${t.space["2xs"]}px;
}

/*
 * One row, two species.
 *
 * A note is something the designer WROTE; an edit is something the editor DID.
 * Reading them as one list is the whole value of the outbox, and mistaking one
 * for the other is the whole risk — so the kind has to land before the text is
 * read, not from it.
 *
 * The left rule is a pseudo-element rather than a \`border-left\`, for the same
 * reason layers.ts draws its indent guides that way: it lets the mark be a
 * SHAPE. Note is a continuous bar, edit is a broken one, and broken against
 * whole is legible in greyscale and legible when the user has picked the
 * editor accent as their marker colour. Colour here is reinforcement; it is
 * never the distinction.
 */
.de-ann-item {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  /* The head and the body are two lines of one object, so the step between
     them is the tight one; the actions column is a separate thing and takes
     the workhorse step away from the text it must not crowd. */
  column-gap: ${t.space.sm}px; row-gap: ${t.space["2xs"]}px;
  /* One inset on all four sides, one under its spacing step because the
     hairline takes that pixel. The leading edge used to be wider than the
     other three — air the frame outside was not providing — and with the frame
     gone there is no reason for the left to differ from the right. */
  padding: ${ITEM.padding};
  border: ${ITEM.hairline}px solid ${t.color.border};
  border-radius: ${ITEM.outer};
  background: ${t.color.bgRaised};
  font-size: ${t.type.body};
  /* Prose, not a label: the comment is the one place in this panel somebody
     reads a sentence, and 1.45 is what keeps two wrapped lines from setting
     solid. Every other surface here is single-line and inherits nothing. */
  line-height: ${t.type.leadingBody};
  color: ${t.color.text};
  transition: background ${t.duration.hover} ${t.ease}, border-color ${t.duration.hover} ${t.ease};
}
/*
 * THREE ways in, ONE highlight — this rule is the correspondence.
 *
 * A note is one object with two views: a pin on the page and a row in here.
 * The pointer can arrive at either of them, and the keyboard arrives at a third
 * place, the actions inside the row. If hovering the marker lit the row in a
 * different tint from hovering the row itself, the two would stop reading as
 * the same note — the highlight would look like two different facts rather than
 * one thing answering.
 *
 * So all three states are declared once, with one value, and there is
 * deliberately no second value to change. Hover sits in its own block only
 * because hover paint is fine-pointer-only (a tap would leave it stuck):
 *   :hover        the pointer is on the row
 *   :focus-within the keyboard is in the row
 *   --hover       the canvas says the pointer is on this note's MARKER
 */
/* \`bgRaisedHover\`: the item is \`bgRaised\`, and \`bgHover\` is no lift over it —
   equal in dark, a rung below in light — so it would leave the card the pointer
   is on unchanged or darker. */
@media (hover: hover) and (pointer: fine) {
  .de-ann-item:hover {
    background: ${t.color.bgRaisedHover};
    border-color: ${t.color.borderInteractive};
  }
}
.de-ann-item:focus-within,
.de-ann-item--hover {
  background: ${t.color.bgRaisedHover};
  border-color: ${t.color.borderInteractive};
}
/*
 * Inset 2px top and bottom, so the rule stops short of the corner arcs.
 *
 * At \`top: 0; bottom: 0\` the bar ran the full height of a box with a 4px
 * radius, and its square ends poked out through the curve — two 2px nicks on
 * the left corners of every row in the list, which at this size reads as a
 * rendering fault rather than as a mark.
 */
/*
 * No left rule on a row.
 *
 * There was one, in three variants: solid for a note, broken for an unwritten
 * edit, closed-up for a written one. Each said something true, and together
 * they put a coloured bar down the left of every row in a 260px panel to
 * restate what the row's own words already said. The kinds are still told apart
 * — by the note's numbered disc, by the mono face on an edit's body, and by the
 * written state's own words — none of which costs a column of ink.
 */

/* Metadata rung: the row's quietest line, under the body it introduces. */
.de-ann-item-head {
  grid-column: 1;
  display: flex; align-items: center; gap: ${t.space["2xs"]}px; min-width: 0;
  font-size: ${t.type.body};
  font-weight: ${t.type.weightBody};
  color: ${t.color.textDim};
}
/*
 * The number, and only notes carry one.
 *
 * Its presence is the third channel telling the two kinds apart, and the
 * cheapest one to read: an edit has no pin on the canvas, so it has no number,
 * so the column of discs down the list IS the set of things you can go and look
 * at. Same fill as the marker for the same reason, and — since it is the same
 * object — the same fixed white ink and contact shadow, for the reason spelled
 * out up there. This disc does not even get the pin's ring to fall back on.
 */
.de-ann-index {
  flex: none;
  width: ${INDEX}px; height: ${INDEX}px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: ${t.color.accentSurface};
  /* The row's copy of the pin, so it takes the pin's whole treatment: the
     indigo accent under a white numeral. The two have to be recognisably one
     object — the row is how you find the pin. */
  color: ${t.color.onAccent};
  /* \`micro\`, not \`caption\`: this disc is ${INDEX}px against the pin's ${MARKER}, so it
     steps down one rung to keep the same numeral-to-disc proportion. */
  font-size: ${t.type.micro}; font-weight: ${t.type.weightSection};
  line-height: ${t.type.leadingFlush};
}
/* An edit's row number takes the edit pin's square, so row and pin still read
   as one object — and the squircle back, since only the disc is round. */
.de-ann-item--edit .de-ann-index { border-radius: ${t.radius.xs}; corner-shape: ${t.cornerShape}; }
/*
 * Outlined at rest; the filled version below is reserved for "written".
 *
 * \`flex: 0 1 auto\` and not \`none\`: a badge is short today, but a \`none\` chip
 * beside a \`none\` disc in a flex row has nothing left that can give, so one
 * longer word would have pushed the head past the row's right edge and under
 * the actions column instead of ellipsising like everything else here.
 */
.de-ann-badge {
  flex: 0 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis;
  padding: 0 ${t.space["2xs"]}px;
  border: 1px solid ${t.color.borderInteractive}; border-radius: ${t.radius.xs};
  background: transparent;
  color: ${t.color.textDim};
  font-size: ${t.type.body};
  /* The row leading (12/16), where a literal 14px sat off every type role. */
  line-height: ${t.type.leadingRow};
  white-space: nowrap;
}
/*
 * THREE STATES, AND THE COLOUR HAS TO AGREE WITH THE WORD.
 *
 * Keyed on \`data-de-state\`, not on \`.de-ann-item--written\`, because that class
 * is true of two different rows. The writer sets \`written\` the moment it knows
 * it CAN spell a change, so a queued edit and a committed one both carried it —
 * and both came out filled green. Screenshotted, the tab said a change was done
 * when the file had never been touched, in the most reassuring colour the
 * chrome owns. That is the failure this rule exists to prevent, so it reads the
 * same attribute the badge's own text is chosen from and the two cannot drift.
 *
 * Filled green is spent on ONE state — the only one that is finished. Green
 * means "nothing further is owed here" and can mean nothing else in this list.
 */
.de-ann-badge[data-de-state="written"] {
  border-color: transparent;
  background: ${t.color.success};
  color: ${t.color.onSemantic};
}
/*
 * Ready is OUTLINED in the accent, not filled by it.
 *
 * It is the most common state in a live session — every writable edit sits here
 * until Apply — so a filled chip would put a saturated block on nearly every
 * row and leave the list with no quiet ground to read against. Outlined reads
 * as "armed, not done", which is exactly the claim, and it keeps the filled
 * treatment meaning finished.
 */
.de-ann-badge[data-de-state="ready"] {
  /* The BORDER stays \`accent\` — a stroke owes 3:1, and on the resting row it
     is 3.3:1 dark and 6.7:1 light (2.9:1 on a hovered dark row). The WORD takes
     \`accentText\`, the same indigo in light and a lighter rung in dark, where
     plain \`accent\` falls short of the 4.5 a label owes: 5.3:1 against 3.3:1
     on the resting row. */
  border-color: ${t.color.accent};
  background: transparent;
  color: ${t.color.accentText};
}
/*
 * Needs-the-agent is AMBER, and the reason it is not \`danger\` is the same
 * reason the audit's severities are not: nothing is broken. The change is real
 * and simply cannot be written mechanically.
 *
 * It must not inherit the default \`textDim\` either, which is what it did when
 * it was first drawn. Dim ink on a transparent ground is the chrome's disabled
 * treatment, so the one row that needs a decision looked like the one row that
 * could not be acted on — precisely inverted.
 */
.de-ann-badge[data-de-state="agent"] {
  border-color: ${t.color.lintWarning};
  background: transparent;
  color: ${t.color.lintWarning};
}

/*
 * One line, ellipsised, whole value in the \`title\`. A note can be a paragraph
 * and an edit's value can be a four-part box-shadow; either one wrapping in a
 * 260px panel turns a scannable list into a wall.
 *
 * FULL-STRENGTH ink, and it is the only run in the tab that gets it. This is
 * what the user wrote; everything around it — the heading naming the section,
 * the number, the kind chip, the controls — exists to get them to this line. It
 * was \`textMuted\` while the section titles were shouting in caps above it, so
 * the loudest thing in the column was the word "NOTES" and the quietest was the
 * note. 12.1:1 dark and 19.1:1 light on the row's own ground, against
 * \`textMuted\`'s 7.9:1 and 10.5:1.
 */
.de-ann-item-body {
  grid-column: 1;
  min-width: 0;
  color: ${t.color.text};
}
/*
 * The ellipsis has to be on the LINE, not on the box around it.
 *
 * It was on \`.de-ann-item-body\`, whose children are two \`<div>\`s — and
 * \`text-overflow\` only draws on the box whose own inline content overflows.
 * The divs overflowed themselves (visible), the body clipped them, and no
 * ellipsis was ever painted: a long note was cut mid-glyph at the row's edge,
 * which reads as a rendering fault rather than as "there is more". Same
 * declarations, one level down, where they can actually fire.
 */
.de-ann-item-body > * {
  min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/*
 * ONE LINE, FULL INK — there were two, and the second has gone to the tooltip.
 *
 * A row was what the user wrote and then where it is: "add a hover animation",
 * and under it "OverviewComponent · page.tsx:24". Ranking the second line
 * quieter fixed the loudness but not the arithmetic — five rows still cost ten
 * lines of a ${t.size.inspectorWidth}px column, and half of them were filing notes the reader
 * did not write and cannot act on. The pin says where a note is; the brief
 * carries the selector, the component and the file to the agent, which is the
 * copy that was ever going to be read for them.
 *
 * So \`.de-ann-item-where\` is gone rather than restyled, and the string it held
 * is the \`title\` of the line above it.
 */
.de-ann-item-line { color: ${t.color.text}; }
/*
 * THE SHARED-COMPONENT CAUTION, and it is amber rather than red.
 *
 * Nothing is wrong. The edit is valid, it will apply cleanly, and for a design
 * system component changing every instance is very often exactly what the
 * designer means. What they cannot see from the page is the SCOPE, so this
 * reports scope — and a red line reporting a correct operation trains people to
 * ignore red lines.
 *
 * Amber is the same hue the audit spends on "a warning the page still renders",
 * which is precisely this situation, and it is already the badge colour for a
 * row the editor cannot write. One amber vocabulary across the tab: this needs
 * your attention before you press the button.
 *
 * Set back to the body font on purpose. The rest of an edit row is mono because
 * it is a property and two values; this is a sentence, and a sentence in mono
 * inside a 260px column wraps badly and reads as data.
 */
.de-ann-item-shared {
  margin-top: ${t.space["3xs"]}px;
  font-family: ${t.font.ui};
  color: ${t.color.lintWarning};
  /*
   * The one child of an edit row allowed to WRAP.
   *
   * .de-ann-item-body > * sets nowrap and an ellipsis on every child,
   * which is right for a property and two values — one line, whole value in
   * the title attribute. This is a sentence, and a sentence clipped at
   * "…used in 13 other pla…" has lost the number, which is the only part of
   * it anybody needs. It gets two lines instead.
   */
  overflow: visible;
  white-space: normal;
  overflow-wrap: anywhere;
}


/*
 * THE AGENT ADDRESS AND ITS COPY BUTTON, as one field-and-action pair.
 *
 * The address is drawn as the kit's field — the filled \`field\` well, the
 * fields' 8px corner, 4px by 8px of padding around a 16px line — so it is
 * exactly the 24px of the Copy button beside it and reads as the same family,
 * not a 20px code strip over a taller button.
 *
 * One row, and the button wraps under the field only when the panel is too
 * narrow for the whole address: the address is a string somebody has to get
 * into another program, so it keeps its full width rather than an ellipsis.
 * Mono, selectable, and still allowed to break mid-URL at the narrowest.
 */
.de-mcp-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: ${t.space["2xs"]}px; }
.de-mcp-url {
  flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center;
  min-height: ${t.size.rowHeight}px;
  padding: ${t.space["2xs"]}px ${t.space.sm}px;
  /* The fields' corner (\`CONTROL_RADIUS\` in css/panels.ts, which imports this
     sheet, so the value is named rather than imported). */
  border-radius: ${t.radius.sm};
  background: ${t.color.field};
  color: ${t.color.text};
  font-family: ${t.font.mono};
  font-size: ${t.type.caption};
  line-height: ${t.type.leadingRow};
  overflow-wrap: anywhere;
  user-select: all;
}
.de-mcp-row > .de-button { flex: none; }
/*
 * The status mark in the MCP section header, tinted AND shaped by state.
 *
 * Green and filled only for a live agent, an amber ring for "set me up", and a
 * dashed ring in muted ink for a port that never bound — which is not the
 * designer's fault and not something they can fix from this panel, so it gets
 * no alarm colour. The shape carries the state too, so it is never colour
 * alone. The sentence rides in the mark's tooltip and accessible name.
 */
.de-mcp-state {
  display: block;
  box-sizing: border-box;
  width: 8px; height: 8px;
  border-radius: 50%;
  border: 1.5px dashed ${t.color.textDim};
}
.de-mcp-state[data-de-state="on"] { border: none; background: ${t.color.success}; }
.de-mcp-state[data-de-state="idle"] { border-style: solid; border-color: ${t.color.lintWarning}; }
/*
 * There were three orphaned lines here — \`font-family\`, a duplicate \`color\`
 * and a closing brace with no selector above them, left behind when the
 * \`idle\` rule was collapsed onto one line.
 *
 * They were not merely dead. A stray declaration at the top level puts the CSS
 * parser into error recovery, and recovery runs to the end of the NEXT block —
 * so the orphan silently ate the rule that followed it. Confirmed against a
 * browser's CSSOM rather than reasoned about: of \`.a-before\`, the idle rule,
 * \`.a-after\` and \`.a-after-2\`, the parser kept three and dropped
 * \`.a-after\` entirely.
 *
 * What it had been eating since 5d43657 is the mono treatment directly below,
 * so every edit row in the Changes tab has been setting its body in the UI face
 * while the comment beside it explained why that had to be mono. Nothing was
 * lost by deleting the orphan itself: neither declaration had ever applied.
 */
/*
 * An edit's body is a property and two values, so it is set in mono — the
 * fourth channel, and the one that reads before any mark does, because a
 * change of typeface is visible in peripheral vision.
 */
.de-ann-item--edit .de-ann-item-body {
  font-family: ${t.font.mono};
}
/*
 * A trailing column, always in the DOM, faded in on the same three states the
 * row highlights on.
 *
 * Two things make this safe to hide at rest, and both are conditions the old
 * always-visible treatment was written to avoid. The column is laid out and
 * SPACED whether or not it is painted — \`grid-row: 1 / -1\` in a track of its
 * own — so nothing moves when it appears and the text never reflows under the
 * pointer. And the reveal is keyed on \`:focus-within\` as well as hover, on the
 * row AND on the group, so a keyboard tabbing into a button can never land on
 * something at \`opacity: 0\`: the ring and the glyph arrive together.
 *
 * Opacity and nothing else. A \`display\` or \`visibility\` swap would take the
 * buttons out of the tab order (or out of layout) between frames, which is how
 * a Tab press ends up somewhere the eye did not follow.
 *
 * \`space.sm\`, and the rung below it would break the row: each ${t.size.miniSize}px button
 * carries ${(TARGET - t.size.miniSize) / 2}px of invisible hit pad on every side, so any gap under
 * ${TARGET - t.size.miniSize}px leaves a strip down the middle where Resolve and Delete both
 * claim the click. \`2xs\` would overlap them by ${TARGET - t.size.miniSize - t.space["2xs"]}px; \`sm\` clears them with
 * ${t.space.sm - (TARGET - t.size.miniSize)}px to spare.
 *
 * The reveal triggers are the kit's four: row hover on a fine pointer,
 * keyboard focus inside, a menu open inside, and permanently on a coarse
 * pointer, where hover does not exist.
 */
.de-ann-item-actions {
  grid-column: 2; grid-row: 1 / -1;
  align-self: start;
  display: inline-flex; align-items: center; gap: ${t.space.sm}px;
  opacity: 0;
  transition: opacity ${t.duration.hover} ${t.ease};
}
@media (hover: hover) and (pointer: fine) {
  .de-ann-item:hover .de-ann-item-actions { opacity: 1; }
}
.de-ann-item:focus-within .de-ann-item-actions,
.de-ann-item--hover .de-ann-item-actions,
.de-ann-item-actions:focus-within,
.de-ann-item-actions:has([aria-expanded="true"]) { opacity: 1; }
/* No fine pointer, no hover: on touch the reveal would hide the row's only
   actions behind a gesture the device cannot make. */
@media (hover: none), (pointer: coarse) {
  .de-ann-item-actions { opacity: 1; }
}
/*
 * ${t.size.miniSize}px of drawing, ${TARGET}px of target.
 *
 * The glyph is right at this density — a 24px square button in a two-line row
 * would be the biggest thing in it — but 18px is under the 24px pointer target
 * WCAG 2.5.8 asks for, and on a row you delete things from that is the miss
 * that costs the most. A transparent pad gives the button back the 3px a side
 * it is short without changing a pixel of what is painted.
 */
.de-ann-item-actions .de-mini { position: relative; }
.de-ann-item-actions .de-mini::after {
  content: "";
  position: absolute; inset: -${(TARGET - t.size.miniSize) / 2}px;
}
/*
 * A hovered action inside a hovered row needs a ground of its own.
 *
 * \`.de-mini:hover\` paints \`bgHover\`, which sits within 1.15:1 of the
 * \`bgRaisedHover\` the ROW is wearing by the time a pointer can be on one of its
 * buttons — near enough the same colour twice, so the button you are about to
 * press looks like the button beside it.
 *
 * The field-hover well changes the fill a little more (1.23:1 dark, 1.12:1
 * light), and the hairline is the channel that actually reads at
 * ${t.size.miniSize}px — a change of fill that small is not something you find
 * with your eye, an edge appearing where there was none is. Nothing here for
 * \`--danger\`: it takes the danger wash and ink, which were never in doubt.
 */
@media (hover: hover) and (pointer: fine) {
  .de-ann-item-actions .de-mini:hover:not(.de-mini--danger) {
    background: ${t.color.fieldHover};
    border-color: ${t.color.borderInteractive};
  }
}

/* Inside the box now, not instead of it, so it is inset from the hairline
   rather than from the panel: 16/12 are the tab's own steps, where the 20/16 it
   carried were sized for an empty state that owned the whole pane. */
.de-ann-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${t.space.sm}px;
  padding: ${t.space.lg}px ${t.space.md}px;
  color: ${t.color.textDim};
  text-align: center;
  line-height: ${t.type.leadingBody};
}

/*
 * What you do with the WHOLE session, under everything it acts on.
 *
 * Outside the section, so folding the list away cannot hide the button that
 * finishes the session. The last row before Settings rather than a footer
 * pinned to the pane. It insets its own sides by the ${GUTTER}px the section
 * bodies pad to, so the buttons start on the column of the rows they act on.
 *
 * It closes the Notes group: the list's section drops its hairline and its
 * bottom step tightens to ${t.space.md}px, so the buttons read as the list's last row,
 * and the ${SECTION_GAP}px under them, then MCP's hairline, end the group.
 *
 * Four controls on ONE line — two glyphs, then the primary button and Copy as
 * bare labels — in the ${t.size.inspectorWidth - 16}px this row has. It does not wrap:
 * the pills carry no marks so the four fit. The slack \`space-between\` leaves
 * keeps the bin away from Send.
 */
.de-ann-ctas {
  display: flex; flex-wrap: nowrap; align-items: center; justify-content: space-between; gap: ${t.space.sm}px;
  padding: 0 ${GUTTER}px ${SECTION_GAP}px;
}
.de-ann > .de-section:has(> .de-section-fold > .de-section-body > .de-ann-list) { border-bottom: 0; }
.de-ann > .de-section:has(> .de-section-fold > .de-section-body > .de-ann-list) > .de-section-fold > .de-section-body {
  padding-bottom: ${t.space.md}px;
}
/*
 * The two glyph utilities, at the height of the pills they share a row with.
 *
 * \`.de-mini\` is ${t.size.miniSize}px because it was drawn for a trailing slot inside a row. Out
 * here it stands beside two ${TARGET}px buttons, and 18 against 24 on one line reads as
 * two different courses of furniture — the eye finds the mismatch before it
 * finds either label. Growing the BOX to 24 (the glyph inside stays 12) fixes
 * the line and pays for the pointer target in the same move.
 */
.de-ann-tools { display: inline-flex; align-items: center; gap: ${t.space["2xs"]}px; }
.de-ann-tools .de-mini { width: ${TARGET}px; height: ${TARGET}px; }
.de-ann-actions { display: inline-flex; align-items: center; gap: ${t.space["2xs"]}px; margin-left: auto; }
.de-ann-actions button { white-space: nowrap; }
/* No agent yet: Send to agent leaves. An author \`display\` beats [hidden]. */
.de-ann-actions button[hidden] { display: none; }
/*
 * A GLYPH THAT BECOMES A TICK, and the becoming is the whole point.
 *
 * Copy's confirmation used to be a toast alone, which arrives at the bottom of
 * the screen while the pointer is at the right edge of a 260px panel — the one
 * place the eye is not. Agentation's toolbar, which sits on the same page as
 * this panel, answers a copy on the button itself, and two products on one
 * screen confirming the same gesture two different ways reads as two products.
 * So this is its treatment, matched deliberately: both marks in one box,
 * crossfaded, the outgoing one shrinking to ${SWAP_SCALE} and the incoming one arriving at
 * full size. Its numbers are 200ms and 0.8; ours are \`duration.reveal\` and the
 * same 0.8.
 *
 * STACKED, not replaced. Swapping the \`<svg>\` gives the browser no previous
 * state to interpolate from, so the tick would appear rather than arrive — and
 * a glyph momentarily missing from the flow lets the label slide, which on a
 * pill that shares a ${TARGET}px line with three other controls is the one motion
 * nobody asked for. \`position: absolute\` on both children with a sized box
 * means the row geometry never learns that anything happened.
 *
 * The tick is \`success\`, not \`currentColor\`. On the plain pill the colour is
 * the only channel saying the press LANDED rather than merely registered, and
 * the scale is the second — so it survives greyscale, and it survives the
 * reduced-motion rule below that takes the scale away.
 */
.de-swap {
  position: relative;
  flex: none;
  display: inline-block;
  width: ${t.icon.marker}px; height: ${t.icon.marker}px;
}
/*
 * NO BLUR. There was a 4px one here, softening the outgoing mark and resolving
 * the incoming one, and the kit's grammar is that nothing blurs in or out. The
 * scale already separates the two drawings through the overlap — the leaving
 * one is at ${SWAP_SCALE} while the arriving one is near full size — so at every frame
 * one of them is visibly the smaller.
 */
/*
 * The selector carries \`[data-designlayer]\` and \`[data-de-glyph]\` for one
 * reason, and it is the reason this crossfade never ran.
 *
 * \`css/icons.ts\` declares \`transition: stroke-width\` on
 * \`[data-designlayer] svg[data-de-glyph]\`, which is (0,2,1) against the
 * (0,1,1) this rule used to be — and \`transition\` is a shorthand, so that rule
 * did not add a property to this list, it replaced the list. Every glyph in
 * this box was transitioning \`stroke-width\` and nothing else, so the tick
 * appeared at full size and full opacity in one frame: the jump this whole
 * module exists to prevent, described in detail directly above it, and not
 * happening.
 *
 * (0,3,1) settles it outright rather than by import order. \`stroke-width\` is
 * restated because taking the declaration also means taking responsibility for
 * what it was doing — a glyph inside this box still thickens when its control
 * turns on.
 */
[data-designlayer] .de-swap > svg[data-de-glyph] {
  position: absolute; inset: 0;
  transform-origin: center;
  transition: opacity ${t.duration.reveal} ${t.easeReveal}, transform ${t.duration.reveal} ${t.easeReveal},
    stroke-width ${t.duration.hover} ${t.ease};
}
.de-swap > .de-swap-done {
  opacity: 0; transform: scale(${SWAP_SCALE}); color: ${t.color.success};
}
.de-swap--done > .de-swap-rest { opacity: 0; transform: scale(${SWAP_SCALE}); }
.de-swap--done > .de-swap-done { opacity: 1; transform: scale(1); }
/*
 * A TOGGLE KEEPS ITS OWN INK, and that is the entire difference between the two
 * uses of this box.
 *
 * The green above is what makes a confirmation a confirmation: on a plain pill
 * the colour is the only channel saying the press LANDED rather than merely
 * registered. A toolbar tool turning on is not a confirmation — the accent
 * surface underneath has already said which state it is in — and a green glyph
 * on that surface would be a second, contrary claim about what just happened.
 * So the toggle variant inherits, and takes only the crossfade from the rule
 * above.
 *
 * The box is sized here for the panel's \`icon.marker\` glyphs; the toolbar's are
 * \`icon.action\`, and \`core/swap-mark.ts\` writes that one case inline rather
 * than growing a second class for one number.
 */
.de-swap--plain > .de-swap-done { color: inherit; }
/*
 * Clear-all, waiting for its second click.
 *
 * It wears the hover treatment of \`.de-mini--danger\` without the pointer being
 * there, which is the plainest way to say "this is live now" in a vocabulary
 * the panel already has. The ink is \`onSemantic\`, near-black in dark rather
 * than white: \`danger\` is a LIGHT coral there, and white on it measures
 * 2.89:1 — the same pairing trap \`accentFill\` exists to close.
 *
 * The fill is the second channel, never the only one. The glyph itself changes
 * from a bin to a tick, so the armed state survives greyscale and survives a
 * reader who is not looking directly at it.
 */
.de-ann-clear--armed,
.de-ann-clear--armed:hover {
  background: ${t.color.danger};
  color: ${t.color.onSemantic};
}

/* ---------- settings ---------- */
/*
 * The second section, sitting where the first one ends.
 *
 * It used to be pinned to the bottom edge with \`margin-top: auto\` and closed
 * off with a hairline, on the argument that the pane's free space had to go
 * somewhere and above a folded block was the cheapest place. That was true
 * while the list scrolled inside itself; with the whole tab scrolling as one
 * column it produced the opposite — a block floating at the bottom of the
 * viewport with a void between it and the notes it belongs to. The section
 * title above it is the separation now, so the rule goes too.
 */
.de-ann-settings {
  display: flex; flex-direction: column;
}
/*
 * Settings has no hairline under it: it is the last thing in the column, so a
 * rule there divides nothing.
 */
.de-ann > .de-section:has(> .de-section-fold > .de-section-body > .de-ann-settings) {
  border-bottom: 0;
}
/* MCP carries the hairline on BOTH sides: the one above divides it from the
   Notes group (or the empty state), the one below from Settings. */
.de-ann > .de-section:has(> .de-section-fold > .de-section-body > .de-mcp) {
  border-top: 1px solid ${t.color.border};
}
/*
 * The fold is the shared \`section()\` header — toggle, chevron and hover ground
 * all come from \`css/panels.ts\` — and it starts open. This block only needs its
 * own rhythm under that heading.
 */
.de-ann-settings-body { display: flex; flex-direction: column; }
/* An author \`display\` beats the UA [hidden] rule, so restate it. */
.de-ann-settings-body[hidden] { display: none; }
/*
 * NO ENTRANCE. The body used to fade in whenever it was shown, back when it sat
 * under a fold button. The fold is gone and the body is always open, so the
 * fade was replaying on every render of the tab — an entrance for restored
 * state, which the kit rules out: known controls paint on the first frame
 * (MICRO-INTERACTIONS § 10).
 */

/*
 * A run of rows, and space — not a hairline — between two runs.
 *
 * One group today: MCP, the address and its status, moved out into a section of
 * its own. The spacing rule stays for the next group that earns a place here.
 */
/* ${t.space["2xs"]}px between ${t.size.rowHeight}px rows: enough to tell two settings apart, well
   under the ${t.space.sm}px from the title, so the run still reads as one group. */
.de-ann-setting-group { display: flex; flex-direction: column; gap: ${t.space["2xs"]}px; }
.de-ann-setting-group + .de-ann-setting-group { margin-top: ${t.space.sm}px; }

/*
 * One setting, one line. The whole point of the block.
 *
 * Every row used to carry a two- or three-line hint under it, which turned six
 * settings into an essay: on a 900px screen the last row fell below the fold,
 * so the setting most likely to be wrong on a given project was the one to
 * scroll a wall of prose for. The hints moved into the label's hover
 * tooltip, and the row went back to being a row.
 *
 * No \`flex-wrap\` here on purpose: wrapping is how a row silently becomes two
 * again. The label is the only thing that gives, and it gives by clipping
 * rather than by pushing the control off the panel — see the rule on it.
 */
.de-ann-setting {
  position: relative;
  display: flex; align-items: center; gap: ${t.space.sm}px;
  min-height: ${t.size.rowHeight}px;
}
/* An author \`display\` beats the UA [hidden] rule, so restate it. */
.de-ann-setting[hidden] { display: none; }
/*
 * The slack goes in FRONT of the control, not into the label.
 *
 * With the label flexed to fill, the help dot was carried out to the middle of
 * the row and read as a mark on the switch — it explains the setting, so it has
 * to touch the words. The control is pushed right by its own auto margin
 * instead, which leaves label and dot as one object at the left edge.
 */
.de-ann-setting > .de-ann-toggle { margin-left: auto; }

/*
 * A control too wide to sit beside its own name — today, the MCP address and
 * the Copy button that follows it.
 *
 * Wrap is switched back on for this variant only, and it is the CONTROL that
 * claims the whole second line rather than the label claiming the first: label
 * and help dot have to stay together on line one, which they do for free now
 * that the dot is inside the label rather than beside it.
 */
.de-ann-setting--stacked {
  flex-wrap: wrap; row-gap: ${t.space.sm}px;
  padding-top: ${t.space["2xs"]}px; padding-bottom: ${t.space["2xs"]}px;
}
.de-ann-setting--stacked > :not(.de-ann-setting-label) { flex: 1 1 100%; }

/*
 * THE CHECKBOX VARIANT IS GONE, and about ninety lines of drawing with it.
 *
 * \`.de-ann-setting--check\` put a hand-drawn \`<input type="checkbox">\` in
 * FRONT of the words, opposite the switches on the right, and the asymmetry
 * was the whole argument for it: a switch says "this is how the tool behaves
 * from here on", a checkbox says "do this to the handover". Every row in the
 * block persists and takes effect on press, so there was no second kind of
 * choice for the second drawing to mark — two alignments and two controls
 * saying one thing. The rows are \`role="switch"\` now, all of them, and what
 * left with the checkbox is a tick centred to a tenth of a pixel, a 24px hit
 * pad and an \`appearance: none\` reset that existed only to make a native
 * control look like it belonged.
 *
 * Nothing replaced the \`:hover\` tint the variant put on its own label: a
 * switch row's target is the switch, and lighting the words on hover promised
 * a click they never took.
 */

/*
 * Name and help dot, as one flex ROW. Shrinks, never grows.
 *
 * It was a block, and the dot inside it was an inline-flex box on a TEXT LINE,
 * which is the whole of the reported misalignment. Measured against the centre
 * of the cap band — where the eye puts the middle of a word — the dot sat:
 *
 *   inline, no fix                2.12px HIGH
 *   inline, vertical-align:middle 0.98px LOW
 *   flex item, align-items:center 0.12px low
 *
 * An inline-flex box holding nothing but an SVG has no text baseline of its own,
 * so the line hands it the replaced element's bottom edge — that is the 2.12.
 * \`vertical-align: middle\` was the fix for that and overshot: \`middle\` is the
 * baseline plus half the X-HEIGHT, and the cap band's centre is higher than
 * that. A pixel on a 14px dot beside 11px text is the difference between a dot
 * on the word and a dot under it.
 *
 * A flex row has no such approximation and no dependence on what the SVG does
 * about baselines: the dot's centre goes on the line box's centre, which is
 * where the text is centred too, at every size and every zoom step.
 *
 * It also stops the dot being the thing that VANISHES when the row is tight — an
 * atomic inline at the end of an ellipsised line is dropped from paint and from
 * hit testing, so the hint was one longer label away from being unreachable. As
 * a \`flex: none\` item it is the one thing here that cannot be taken away.
 *
 * The cost, stated plainly: \`text-overflow\` does not apply to a flex
 * container's items, and every row here is a bare text node now that the
 * checkbox rows and their \`<label for>\` are gone — so a name too long for the
 * slot shrinks to its longest word and is then clipped rather than
 * ellipsised. Today's longest label measures about 118px in a 210px slot, so
 * nothing is near it; if one ever is, the fix is a \`<span>\` around the words
 * in the markup, not a return to the block.
 *
 * \`overflow: clip\` with a margin rather than \`hidden\`, because the dot is a
 * tabbable \`<button>\` and \`hidden\` shaved its focus ring. The margin is the
 * ring's full reach — a 1px edge plus the 3px halo.
 * A clip margin keeps the ring and still stops a long label painting over the
 * switch. The tip below is unaffected either way — it is absolutely positioned
 * against the ROW, which is outside this box, and a clip only reaches as far
 * down as the containing block.
 */
.de-ann-setting-label {
  flex: 0 1 auto; min-width: 0;
  display: flex; align-items: center; gap: ${t.space["2xs"]}px;
  overflow: clip; overflow-clip-margin: ${t.space["2xs"]}px;
  white-space: nowrap;
  color: ${t.color.textMuted};
  font-size: ${t.type.body};
  transition: color ${t.duration.hover} ${t.ease};
}
/*
 * \`.de-ann-setting-label > label\` STOOD HERE and has nothing left to style.
 *
 * It gave the checkbox rows' \`<label for>\` an ellipsis and the row's cursor.
 * Those rows are switches now and carry a bare text node, so there is no
 * \`<label>\` in the block at all — see the note above about what that costs.
 */

/*
 * The label carries its setting's hint as the tooltip, so it is the hover
 * target. The help dot that used to sit beside it is gone.
 */
@media (hover: hover) and (pointer: fine) {
  .de-ann-setting-label[data-de-tip]:hover { color: ${t.color.text}; }
}

/*
 * NEITHER TIP IS DRAWN HERE ANY MORE.
 *
 * Two lived in this file: one on the settings help dot, anchored to the whole
 * row and wrapped, 400ms in; one on the note-row actions, anchored under the
 * button and instant. Both are now the shared card in \`css/tooltip.ts\`.
 *
 * Each was working around the same missing capability from a different angle.
 * The help dot's was stretched \`left: 0; right: 0\` across its row precisely
 * BECAUSE a bubble hung off a 14px dot in a 260px panel ran off the left edge —
 * a viewport problem solved by making the tip as wide as the column, which is
 * not a solution so much as somewhere the problem does not fit. The row
 * actions' skipped the delay because its buttons only appear once the pointer
 * is already inside the row.
 *
 * The shared one keeps both behaviours and needs neither workaround: it
 * measures, so it can hang off a 14px dot and still stay on screen, and its
 * warm window means a tip shown while another is already up appears instantly —
 * which is the row actions' case, arrived at by a rule rather than by an
 * exception.
 *
 * The help dot keeps its own hover tint above; only the card left.
 *
 * It keeps \`textDim\` at rest where the kit wants icon-only ACTIONS at full
 * ink, and deliberately: it is not an action (a press does nothing), and six
 * full-ink dots down the block would outrank the setting names they annotate.
 */


/*
 * The switch: a track, and a knob that travels its length.
 *
 * \`transform\` on a \`::after\`, never \`left\` — a knob animated on an inset is
 * laid out again on every frame, and this one sits in a block pinned below a
 * scrolling list. The knob is \`text\` on the off well and \`onAccent\` (white) on
 * the indigo fill, where it measures 4.97:1 dark and 6.70:1 light. That gives
 * the on state two channels — where the knob is, and what colour it or its
 * track is — so it survives greyscale.
 *
 * The knob travels on \`reveal\` — for 12px of travel the longer rung is the one
 * that reads as a thing sliding rather than a thing blinking — and every colour
 * change is on the kit's hover tween.
 *
 * THE OFF TRACK NEEDS A BOUNDARY. \`field\` measures 1.17:1 dark and 1.12:1
 * light against the panel, so without one an off switch is a dot floating on
 * nothing. \`borderInteractive\` is the token for exactly this — the boundary of
 * a control you can act on, at 3.23:1 dark and 3.36:1 light on the panel, past
 * the 3:1 WCAG 1.4.11 asks of a component boundary. The ON track does not need
 * one (the accent fill is 3.61:1 and 6.70:1 by itself), but the border stays
 * and only changes colour: dropping it would shrink the padding box by 2px on
 * both axes and the knob would jump a pixel as the switch turned on.
 *
 * The knob's 1px insets follow from that border, since \`box-sizing\` is
 * border-box and an absolute child is laid out in the PADDING box: 26x14 of
 * padding around a 12px knob is 1px of clearance and 12px of travel, which is
 * the same travel the borderless version had.
 */
.de-ann-toggle {
  position: relative;
  flex: none;
  width: ${TRACK_W}px; height: ${TRACK_H}px;
  padding: 0;
  border: 1px solid ${t.color.borderInteractive}; border-radius: ${t.radius["3xl"]};
  background: ${t.color.field};
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, border-color ${t.duration.hover} ${t.ease},
    box-shadow ${t.duration.hover} ${t.ease}, transform ${t.duration.hover} ${t.ease};
}
/* A ${TRACK_W}x${TRACK_H} track is the drawing, not the target: ${(TARGET - TRACK_H) / 2}px a side takes it to ${TARGET}. */
.de-ann-toggle::before {
  content: "";
  position: absolute; inset: -${(TARGET - TRACK_H) / 2}px 0;
}
.de-ann-toggle::after {
  content: "";
  position: absolute; left: 1px; top: 1px;
  width: ${KNOB}px; height: ${KNOB}px;
  border-radius: 50%;
  background: ${t.color.text};
  transform: translateX(0);
  transition: transform ${t.duration.reveal} ${t.ease}, background-color ${t.duration.hover} ${t.ease};
}
@media (hover: hover) and (pointer: fine) {
  .de-ann-toggle:hover { background: ${t.color.fieldHover}; }
}
.de-ann-toggle[aria-checked="true"] {
  background: ${t.color.accentSurface};
  border-color: ${t.color.accentSurface};
}
@media (hover: hover) and (pointer: fine) {
  .de-ann-toggle[aria-checked="true"]:hover {
    background: ${t.color.accentSurfaceHover};
    border-color: ${t.color.accentSurfaceHover};
  }
}
.de-ann-toggle[aria-checked="true"]::after {
  transform: translateX(${TRACK_W - KNOB - 4}px);
  background: ${t.color.onAccent};
}
/* The kit's press, the same 2% dip every button in the chrome takes. */
.de-ann-toggle:active { transform: scale(0.98); }
.de-ann-toggle:focus-visible { outline: none; box-shadow: ${FOCUS_RING}; }

/*
 * THE MARKER-COLOUR SWATCHES ARE GONE.
 *
 * Seven 20px circles under a stacked label, and before them a native
 * \`<input type="color">\`. Both were answers to a question the panel had no
 * business asking: the pin is read by the person who dropped it, in the
 * session they dropped it in, and the shipped blue is legible on a white page
 * and a dark one alike. The setting behind them, \`markerColor\`, is retired
 * too: the pin wears the chrome's indigo accent.
 *
 * \`.de-ann-setting--stacked\` survives for a row whose control is too wide to
 * sit beside its name; MCP no longer uses it, as it is a section of its own.
 */

/*
 * Reduced motion keeps the feedback and gives up the travel.
 *
 * The kit's trade (MICRO-INTERACTIONS § 20): remove spatial travel, springs and
 * zoom; keep colour and opacity. \`!important\` because the blanket rule in
 * base.ts that these answer carries one.
 */
@media (prefers-reduced-motion: reduce) {
  /*
   * The pin keeps its colour change and loses the grow, on hover and while its
   * row is pointed at. Zeroing only the transition left the pin jumping to 1.1
   * instantly, which is the jump reduced motion is asked to remove, delivered
   * faster. The arrival pop is travel too, so it goes.
   */
  .de-ann-marker { transition: background-color ${t.duration.hover} linear, box-shadow ${t.duration.hover} linear !important; }
  .de-ann-marker:hover,
  .de-ann-marker--active { transform: none; }
  .de-ann-marker--arriving { animation: none; }
  /*
   * The switch keeps its fill and gives up the slide: the knob is simply
   * already at the other end, and nothing under a press squeezes.
   */
  .de-ann-toggle::after { transition: background-color ${t.duration.hover} linear !important; }
  /*
   * Copy's tick keeps the crossfade and gives up the squeeze — the same trade
   * the composer makes two rules up. The fade is the frame that says the mark
   * CHANGED rather than that the panel repainted, and cutting it leaves a green
   * tick that was simply always there; the scale is decoration and goes. Both
   * halves are stated, because \`transform: none\` alone would leave the outgoing
   * glyph mid-transition at whatever scale the blanket rule froze it at.
   */
  [data-designlayer] .de-swap > svg[data-de-glyph] {
    transition: opacity ${t.duration.hover} linear !important;
  }
  .de-swap > .de-swap-done,
  .de-swap--done > .de-swap-rest { transform: none; }
  /* \`.de-ann-format:active\` stood beside this one until the four-segment format
     strip became a row and a \`selectField\`. Nothing wears that class now, and a
     reduced-motion exemption for a control that does not exist is one more
     selector every reader of this block has to rule out. */
  .de-ann-toggle:active { transform: none; }
  /*
   * Nothing here for the row actions or the setting tip: the actions' fade is
   * clamped by the blanket rule, and the tip is \`css/tooltip.ts\`'s card, which
   * opens instantly and restates its own reduced-motion rule.
   */
}
}
`
