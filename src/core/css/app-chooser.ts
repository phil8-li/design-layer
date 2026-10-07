/**
 * The app chooser: the header row at the top of the left panel, and the floating
 * card it opens.
 *
 * Two surfaces in one module because they are one control. The trigger is the
 * only thing on screen that names the app every other panel is a view of, and
 * the menu is the chooser itself — the rows are the running prototypes and
 * clicking one switches the editor to it. Splitting them would put half a
 * control's measurements in a file that never mentions the other half.
 *
 * ## Why the menu is a fixed card with a z-index rather than overlay furniture
 *
 * The other floating surfaces in this chrome divide into two kinds. Canvas
 * chrome — the selection frame, the layer stack, the drop indicator — lives in
 * `.de-overlay-layer`, which `css/base.ts` pins at `z-index: 1`, BELOW the rail
 * holding the panels. That is right for anything drawn over the app and wrong
 * for anything drawn over a panel: the overlay's z-index makes it a stacking
 * context, so a card inside it can never paint above the opaque panel it drops
 * out of, whatever it asks for.
 *
 * The second kind is a popover opened from a panel control — `.de-asset-details`
 * in `css/assets.ts`, `.de-token-popover` in `css/token-picker.ts` — which is
 * `position: fixed` in `document.body` with a z-index above `.de-root`. This
 * menu is the second kind, and wears the kit's menu geometry exactly: `bgRaised`
 * on the `3xl` (16px) corner, 6px of padding, 10px concentric rows, and
 * `shadow.popover` — which already carries the one card-family hairline, so the
 * card draws no border of its own. A designer should not be able to tell from
 * the surface which lane built the card.
 *
 * ## Ordering
 *
 * Registered after `left-tabs.ts` and before the overlay's modules. The trigger
 * is the left panel's first child and sits directly above the tab strip that
 * file lays out, so the two read as a pair; the menu declares its own stacking
 * outright rather than relying on where in the sheet it lands.
 */

import { tokens as t, nest } from "../tokens"

/**
 * Above `.de-root` (2147483000), which is what it takes to clear the panel this
 * card drops out of.
 *
 * A step above `.de-token-popover` as well, and that ordering is deliberate
 * rather than incidental: those popovers are opened from a control INSIDE a
 * panel, and this one is opened from the row that says which app the panel is
 * describing. If the two are ever on screen together the outer question is the
 * one in front.
 */
const MENU_Z = 2147483250

/**
 * The card's corner and the rows' corner, derived from one inset: the kit's
 * menu (MICRO-INTERACTIONS § 6).
 *
 * `radius["3xl"]` (16) outside, a `space.xs` (6) gap in, `radius.md` (10) on the
 * rows. No hairline in the arithmetic: the card's edge is the 1px ring inside
 * `shadow.popover`, which is a shadow layer and takes no room, so the padding is
 * the whole gap. A real border as well would have been a second ring and would
 * have put the rows 7px inside a 16px curve, which lands off the ramp.
 */
const MENU = nest({ of: ".de-app-menu", outer: t.radius["3xl"], inset: t.space.xs })

/**
 * The keyboard focus ring, the kit's recipe: the edge takes the accent and a
 * 3px halo of the accent at 30% sits outside it (MICRO-INTERACTIONS § 3). The
 * mix is stated here from the token; it resolves to the same colour as
 * `accentHalo`.
 */
const HALO = `color-mix(in srgb, ${t.color.accent} 30%, transparent)`

/**
 * The margin the card keeps off the viewport, and the same number twice.
 *
 * `panels/app-chooser.ts` clamps the card's position to `EDGE` — also 8 — so
 * the ceiling below has to be the viewport less that margin at BOTH ends, or
 * the card's measured height and the height it is allowed to occupy disagree
 * and the flip calculation places it against an edge it then overhangs.
 *
 * Written as a token rather than as \`8\` because that is where the number comes
 * from in both files, and a ceiling that silently stopped tracking the spacing
 * scale would show up as a card one step too tall rather than as anything
 * anyone would look for here.
 *
 * \`space.sm\`, and the step it replaces is the reason to name the failure here
 * rather than fix it silently: this read \`space["2xs"]\`, which is 4, so the ceiling
 * came out \`100vh - 8px\` against a card positioned 8px off each edge. The card
 * was allowed to be 8px taller than the room it had, which is not enough to
 * notice and exactly enough to put the last row's lower half under the window
 * edge on the short viewport this ceiling exists for.
 */
const MENU_EDGE = t.space.sm

export const appChooserCss = `/* ---------- app chooser ---------- */
/*
 * A heading you can press, which is the whole brief.
 *
 * It takes rank 1 off the ladder in panels.ts — \`text\` on \`weightSection\` — so
 * at rest it reads as the panel's title rather than as a control competing with
 * the tabs under it. No fill, no border, no corner: everything that would make
 * it look like a button is spent on hover and focus instead, where it costs
 * nothing until somebody is actually reaching for it.
 *
 * Full bleed rather than inset, because it is the panel's header and a header
 * with a margin reads as the first item in a list. The horizontal padding is
 * the \`md\` step, the same inset \`.de-tabs\` gives its first pill, so the
 * app's name and the selected tab's edge share one left line. At the
 * workhorse 8 the header read as cramped against the panel edge.
 *
 * \`panelHeader\` tall: taller than a section header, because this band heads
 * the whole panel rather than one section of it.
 */
.de-app-chooser {
  flex: none;
  display: flex; align-items: center; gap: ${t.space["2xs"]}px;
  width: 100%;
  height: ${t.size.panelHeader}px;
  padding: 0 ${t.space.md}px;
  border: none;
  border-bottom: 1px solid ${t.color.border};
  border-radius: 0;
  background: transparent;
  color: ${t.color.text};
  font-family: inherit; font-size: ${t.type.body}; font-weight: ${t.type.weightSection};
  text-align: left;
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, box-shadow ${t.duration.hover} ${t.ease};
}
/* 44px is over the 24px line in the hover rule, so it takes the quiet step its
   own ground asks for rather than the louder one small controls get. Hover
   paint only on a real pointer, so a tap does not leave the band lit. */
@media (hover: hover) and (pointer: fine) {
  .de-app-chooser:hover { background: ${t.color.bgHoverQuiet}; }
}
/* The kit's focus ring, drawn INSIDE because the row is full-bleed: an outward
   ring on a box flush with the panel edge is a ring with one side drawn off the
   panel. The 1px edge and the 3px halo are both inset shadows for that reason. */
.de-app-chooser:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px ${t.color.accent}, inset 0 0 0 4px ${HALO};
}
/* The open menu HOLDS its trigger's hover paint, so the trigger reads as "this
   one" for as long as its card is up. No press dip: this is a menu trigger, and
   the menu opening is its feedback. */
.de-app-chooser[aria-expanded="true"] { background: ${t.color.bgHoverQuiet}; }
/*
 * The name gives up its width before the chevron does.
 *
 * \`min-width: 0\` is the half that is not optional: a flex item's default
 * \`min-width: auto\` refuses to shrink below its content, so without it a long
 * package name pushes the glyph out of the panel instead of truncating — and
 * the glyph is the only thing on the row saying it opens.
 */
.de-app-chooser-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
/*
 * No app name known, so the row is holding instruction text rather than a value
 * — rank 4 on the ladder, and the weight comes off it too. The BOX does not
 * move: same height, same padding, same chevron. A control that changes shape
 * when it has nothing to show is a control the reader has to learn twice.
 */
.de-app-chooser--empty .de-app-chooser-name {
  color: ${t.color.textDim};
  font-weight: ${t.type.weightBody};
}
/*
 * The glyph is the affordance and never shrinks. \`base.ts\` already gives every
 * svg in the chrome \`flex: none\`; it is restated here because this is the one
 * row where a long name is actively pushing against it, and losing the chevron
 * would leave a heading that gives no sign it opens anything.
 *
 * Rank 4 at rest and the row's own ink when the row is reached for — the
 * glyph-only carve-out on the ladder, applied to the one mark on this row.
 */
.de-app-chooser svg { flex: none; color: ${t.color.textDim}; }
@media (hover: hover) and (pointer: fine) {
  .de-app-chooser:hover svg { color: ${t.color.text}; }
}
.de-app-chooser:focus-visible svg,
.de-app-chooser[aria-expanded="true"] svg { color: ${t.color.text}; }

/* ---------- the menu, which is the chooser ---------- */
/*
 * \`position: fixed\` in \`document.body\`, not \`absolute\` in the overlay. See the
 * note at the top of this file: the overlay is a stacking context under the
 * rail, so a card mounted there is unclipped and invisible at the same time.
 *
 * The width floor is the column the card drops out of — a card narrower than
 * the 240px panel above it reads as belonging to something else — and the
 * ceiling keeps it from spanning a wide window just because one package has a
 * long scoped name. Between them the card sizes to its content, and above the
 * viewport it stops and scrolls.
 *
 * That ceiling is new and it was a hole rather than an omission. A row is 24px,
 * more when a name wraps and double that at 200% zoom; the registry's own notes record five editors
 * running on the machine this was written on, so five rows plus the trailing
 * note is taller than a short window — and the card simply hung off the bottom
 * edge with no scrollbar, which put the rows NEAREST the trigger out of reach.
 *
 * \`overscroll-behavior: contain\` is the other half. The window-capture
 * \`scroll\` listener in \`panels/app-chooser.ts\` closes this menu, and it now
 * ignores events inside the card — but without this the wheel gesture that
 * reaches the end of the list carries on into the page behind it, which scrolls
 * the app under an open menu anchored to a control that has just moved.
 */
.de-app-menu {
  position: fixed;
  z-index: ${MENU_Z};
  min-width: 232px; max-width: 340px;
  max-height: calc(100vh - ${MENU_EDGE * 2}px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: ${MENU.padding};
  background: ${t.color.bgRaised};
  border: none;
  border-radius: ${MENU.outer};
  box-shadow: ${t.shadow.popover};
  pointer-events: auto;
}
/*
 * IT OPENS INSTANTLY AND LEAVES OVER 150MS — the kit's menu grammar. No
 * entrance: a menu is opened dozens of times an hour. The dismissal is the
 * kit's fade to 0.99, played on an inert copy by \`playExit\` in core/motion,
 * because the real card must be gone the instant it is dismissed.
 */
/*
 * ONE LINE: a name, and a figure trailing it.
 *
 * This was a column of two lines, and the argument for the column was that a
 * row carries two facts of different kinds — what the app is called, and where
 * it is running — and that one line holding both would make the reader parse a
 * separator to find the name. That is a good argument against cramming a
 * SENTENCE in beside a name, and the second line duly filled with one: a full
 * url, a middle dot, and a clause. Three facts on two lines, per row, in a
 * control whose whole question is which of these am I on and which could I be.
 *
 * What is left beside the name is four digits, and four digits need no
 * separator to be told from a name. The name takes the row and the figure
 * trails it, which is the ordering rule for a row — identifying content leads,
 * metadata trails — and it puts every port in the card on one trailing edge,
 * where two of them can be compared by eye instead of by reading.
 *
 * \`baseline\` rather than \`center\`: the name can wrap to two lines, and a
 * baseline keeps the port on the name's first line rather than floating it to
 * the middle of the pair.
 *
 * The row is the kit's menu item at the editor's density: 24px tall (4px above
 * and below a 16px line) where the kit's is 36, on the \`radius.md\` corner the
 * card's nest hands it.
 */
.de-app-menu-row {
  display: flex; align-items: baseline; gap: ${t.space.sm}px;
  width: 100%;
  padding: ${t.space["2xs"]}px ${t.space.sm}px;
  /* Read off the card's nest, not matched to it by hand — see \`MENU\`. */
  border: none; border-radius: ${MENU.radius};
  background: transparent;
  color: ${t.color.text};
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, color ${t.duration.hover} ${t.ease},
    box-shadow ${t.duration.hover} ${t.ease};
}
/*
 * A row on a raised surface lifts to \`bgRaisedHover\`, and the comment this
 * replaces had the right rule and the wrong token.
 *
 * It said "a row on a raised surface lifts to \`bgHover\`", which on this card
 * is not a lift at all: the menu is \`bgRaised\`, and \`bgHover\` is the same
 * \`lift(12)\` in dark and a rung below the white card in light. Pointing at a
 * row would change nothing, or read as a press.
 *
 * \`bgRaisedHover\` exists for exactly this: one rung off the surface it sits
 * on — \`lift(16)\` in dark, the kit's \`--muted\` on the white card in light,
 * which is darker and correct: a light theme recesses.
 *
 * Focus takes the same ground for the same reason, plus the kit's ring: the
 * row's edge in the accent and a 3px halo outside it. The halo fits inside the
 * card's 6px padding, so the scroller does not shave it.
 */
@media (hover: hover) and (pointer: fine) {
  .de-app-menu-row:hover:not([aria-disabled="true"]) { background: ${t.color.bgRaisedHover}; }
}
.de-app-menu-row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px ${t.color.accent}, 0 0 0 3px ${HALO};
  background: ${t.color.bgRaisedHover};
}
/*
 * Unpressable, and there are two ways to be.
 *
 * A switch in flight kills every row for as long as the request is out; an app
 * the scanner could not place on disk is dead from the moment it is drawn. Both
 * wear the same ink, because both answer the same question.
 *
 * \`textDisabled\` rather than \`opacity\`, for the reason that role exists: a
 * fade takes the ink and the fill toward whatever is behind them together and
 * lands a disabled label under the contrast floor. This keeps the row readable
 * — the reader still needs to see which app they picked.
 *
 * \`aria-disabled\`, and NOT the native attribute this selector used to read.
 * \`disabled\` takes the row out of the accessibility tree, and out with it goes
 * the \`aria-label\` that is the only place the "no project folder" reason is
 * written — so the users who cannot see the greyed second line were the exact
 * users the explanation was hidden from. It also makes the row the reader just
 * pressed unfocusable in the same frame, and the browser answers that by
 * dropping them to the top of the document.
 */
.de-app-menu-row[aria-disabled="true"] { color: ${t.color.textDisabled}; cursor: default; }
/*
 * Pointer-dead only while a switch is in flight.
 *
 * \`pointer-events: none\` on the unplaced row would take its hover and its
 * cursor with it, and that row is the one the reader most needs to point at and
 * read. The in-flight row has nothing to say that it was not saying a second
 * ago, so nothing is lost by making it inert.
 */
.de-app-menu-row--busy { pointer-events: none; }
/*
 * Armed: the next click on this row ends the session and takes unapplied edits
 * with it.
 *
 * The same pair \`.de-ann-clear--armed\` uses, because it is the same control in
 * a different shape — a destructive action that has asked once and is waiting
 * to be asked again — and a second spelling of "armed" in this chrome is how
 * the two drift apart.
 *
 * Hover does not lift off it. The row is already carrying the warning, so color
 * is not the channel the state travels on; it is the channel that makes a
 * reader moving fast enough to need the warning stop for it. A hover step on
 * top would read as the row coming back to normal under the cursor.
 *
 * Nor does focus, and the selectors are spelled to make both true. This was
 * \`.de-app-menu-row--danger:hover\` at (0,2,0), and the generic hover above is
 * (0,3,0) with its \`:not()\`, so the lift won the plate while this rule kept
 * the ink: \`onSemantic\` on the neutral hover — white on near-white in light
 * (1.05:1), near-black on the dark lift (1.73:1). A row is armed by clicking
 * it, so the pointer is on it the moment it arms, and the warning was
 * unreadable for exactly as long as anyone could act on it. Focus had the same
 * problem at (0,2,0) against the old bare class. Both halves now outrank both.
 */
.de-app-menu-row.de-app-menu-row--danger,
.de-app-menu-row.de-app-menu-row--danger:is(:hover, :focus-visible) {
  background: ${t.color.danger};
  color: ${t.color.onSemantic};
}
/*
 * The name takes the row, and gives up nothing.
 *
 * It used to truncate here exactly as it does on the trigger, and it should
 * not: the trigger is a 32px band with a chevron to fit and no choice, while
 * this card is up to 340px wide with no height at all to run out of. The
 * question the list answers is which of two checkouts is which, and the two
 * differ in the TAIL of the name — the part an ellipsis eats. So the name wraps
 * instead, which costs a second line on the rare name that needs one and hides
 * nothing on any of them. \`break-word\` is for the scoped package with no space
 * in it, which would otherwise push past the card's edge rather than wrap.
 */
.de-app-menu-name {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: ${t.type.weightValue};
  overflow-wrap: break-word;
}
/*
 * The trailing figure: a port, or the three words that stand in for one.
 *
 * \`flex: none\` and \`nowrap\` together are the whole of the guarantee that a row
 * does not change height while it is being handed over. The slot holds four
 * digits at rest and a one-word progress phrase mid-switch, and neither can
 * wrap or be clipped; \`panels/app-chooser.ts\` used to measure the row and pin
 * the height in an inline style to buy the same thing, back when this was a
 * wrapping url.
 *
 * The quiet ink is conditional, and the condition is the one state where this
 * slot has no ink of its own to choose. An armed row is a danger fill with
 * exactly one legible ink on it, and the figure takes that ink by inheriting
 * the row's — rather than by a second rule naming \`onSemantic\`, which is a
 * copy of the row's decision that has to be kept in step with it by hand, and
 * which reads as a pair with the card behind it rather than with the fill it is
 * actually on. The unplaced row needs no rule of its own either: it is not a
 * danger row, so its three words stay at \`textDim\` and legible while the rest
 * of the row goes to \`textDisabled\` — which is the point, since those words are
 * the only thing saying why the row is dead.
 */
.de-app-menu-where {
  flex: none;
  font-size: ${t.type.caption};
  white-space: nowrap;
}
.de-app-menu-row:not(.de-app-menu-row--danger) .de-app-menu-where {
  color: ${t.color.textDim};
}
/*
 * The mark on a row that is a navigation rather than a process swap.
 *
 * A row backed by an editor that is already serving moves the page; a row
 * without one asks a supervisor to SIGTERM this editor. The reader has to be
 * able to tell those apart before pressing either, and the clause that used to
 * say so — \`editor already running\` — spent four words per row on it. An arrow
 * says the same thing in the width of a glyph, and \`base.ts\` already gives
 * every svg in the chrome \`flex: none\`, so it cannot be squeezed out by a long
 * name the way the words could.
 *
 * Rank 4, like the figure it follows: it is a mark about the row, not a second
 * control inside it. \`align-self\` because the row aligns on the baseline and a
 * glyph has none to speak of — it would hang off the bottom of the text.
 */
.de-app-menu-row svg {
  align-self: center;
  color: ${t.color.textDim};
}
/*
 * THE ROW REPORTING ITS OWN HANDOVER.
 *
 * Switching apps asks a supervisor to stop one process and start another, and
 * it takes seconds. What the reader used to get was a toast that expires after
 * four of them and a menu whose rows went grey — so by the time anything
 * changed, the only thing that had explained it was gone, and the page behind
 * stopped answering because the server was gone too. The longest wait in the
 * product, furnished with the least.
 *
 * The SWEEP says the wait is progressing rather than merely happening, which is
 * the distinction a greyed row cannot draw. It is the same indeterminate mark
 * the audit button uses, at the same rung, because they are the same statement.
 *
 * The ink comes up to \`text\` because the slot has stopped holding metadata and
 * started holding the only account of what is happening to the page. Nothing
 * here holds the phrase to one line any more: the slot does that at rest and in
 * every other state, so the rule that used to is gone rather than restated.
 *
 * Reduced motion keeps the statement and drops the travel: a still wash still
 * distinguishes the row being handed over from the rows that are merely
 * disabled beside it.
 */
.de-app-menu-row[data-de-switching] {
  position: relative;
  overflow: hidden;
}
.de-app-menu-row[data-de-switching]::after {
  content: "";
  position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, ${t.color.borderStrong}, transparent);
  animation: de-app-switching calc(${t.duration.reveal} * 6) linear infinite;
  pointer-events: none;
}
@keyframes de-app-switching {
  from { transform: translateX(-100%); }
  to { transform: translateX(100%); }
}
.de-app-menu-row[data-de-switching] .de-app-menu-where { color: ${t.color.text}; }
@media (prefers-reduced-motion: reduce) {
  .de-app-menu-row[data-de-switching]::after {
    animation: none;
    background: ${t.color.bgRaisedHover};
  }
}
/*
 * The app you are already editing: the SELECTED row, so it is a fill.
 *
 * This was a 2px accent rule down the left edge. The kit's rule is that
 * selection is a fill carried by hue — never a hairline, never another grey —
 * so the row wears \`rowSelected\`, the same indigo container a selected layer
 * row wears. It still says "you are here" under the pointer, because hover is
 * held off it: the fill is the state, and a hover step over it would read as
 * the selection going away.
 */
.de-app-menu-row--current,
.de-app-menu-row.de-app-menu-row--current:hover {
  background: ${t.color.rowSelected};
  color: ${t.color.text};
}
/* The current app's name is a WORD in the accent, so it takes the ink rung
   rather than the stroke rung. */
.de-app-menu-row--current .de-app-menu-name { color: ${t.color.accentText}; }
/*
 * Looking, empty, no chooser, failed — every answer the menu can give that is
 * not a list of apps.
 *
 * One class for all four rather than a state each, because they are one thing
 * as far as the reader is concerned: a sentence where the rows would be. It is
 * deliberately NOT centred or italic. A centred sentence in a small card reads
 * as an illustration of emptiness; left on the rows' own column it reads as the
 * answer to the question that was asked.
 */
.de-app-menu-note {
  padding: ${t.space["2xs"]}px ${t.space.sm}px;
  color: ${t.color.textDim};
  font-size: ${t.type.caption};
  line-height: ${t.type.leadingBody};
  word-break: break-word;
}

`
