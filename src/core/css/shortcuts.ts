/**
 * The keyboard shortcuts sheet.
 *
 * A modal card over everything, so it declares its own stacking outright rather
 * than depending on where in `css.ts` it lands — the same choice `app-chooser`
 * makes, and for the same reason: a surface that must be in front of the panels
 * cannot live inside the overlay layer, which is a stacking context pinned
 * below the rail.
 *
 * It is the kit's modal (MICRO-INTERACTIONS § 8): `radius["5xl"]`, the
 * `shadow.float` elevation, a hairline, 24px side insets, and the shared
 * `.de-arrive` entrance — scale 0.96 to 1 in place, never a slide. What it adds is the `kbd`, which
 * nothing else in this editor prints: a key is a thing you press, so it is
 * drawn as a key rather than as a code span.
 */

import { tokens as t, nest } from "../tokens"
import { FOCUS_OUTLINE, PRESS } from "./panels"

/*
 * THERE IS NO `SHEET_Z` ANY MORE, and the deletion is worth the paragraph.
 *
 * It was 2147483400: one step above the app chooser's menu, the otherwise
 * front-most surface, so that opening the sheet over an open chooser did not
 * put a modal behind the thing it was meant to cover. A real number solving a
 * real collision — and a number somebody has to keep correct every time another
 * overlay is added to this chrome.
 *
 * `showModal()` makes the question go away. A modal dialog is promoted to the
 * TOP LAYER, which paints above every stacking context in the document at any
 * z-index: the chooser's menu, the vendor overlay's 2147483645, or whatever a
 * host app has invented. The ordering is a property of what the element IS
 * rather than of a constant that has to out-bid the field.
 */

/**
 * The card's corner and the close button's, derived from one inset.
 *
 * The content sits the kit's 24px in from every edge, and at 24 an 18px modal
 * corner erodes to nothing: a close button tucked into that corner would be a
 * square in a round card. So the close button does not sit at the content's
 * inset. It sits 8px from the card's edge in its own top-right corner, where
 * 18 − 8 lands it on `radius.md` — the same pairing the kit's menus use for
 * their items — and the header and body pad themselves out to the 24px line.
 *
 * The card's own padding is therefore asymmetric: the nest's 7px (8 less the
 * hairline) on the top and right, which forms the corner the button lives in,
 * and 23px (24 less the hairline) on the bottom and left.
 */
const SHEET = nest({
  of: ".de-shortcuts",
  outer: t.radius["5xl"],
  inset: t.space.sm,
  hairline: 1,
})
/** The rest of the way from the close button's corner to the 24px content line. */
const CONTENT_REST = t.space["2xl"] - t.space.sm
/** Close button plus the gap the title keeps from it, measured from the content line. */
const TITLE_CLEAR = t.space.sm + t.size.toolSize + t.space.sm - t.space["2xl"]

export const shortcutsCss = `/* ---------- keyboard shortcuts sheet ---------- */
/*
 * THE SHEET IS A \`<dialog>\`, SO THE SCRIM IS \`::backdrop\` AND NOT AN ELEMENT.
 *
 * There was a \`.de-shortcuts-scrim\` div here: fixed, \`inset: 0\`, flex-centring
 * the card, carrying the dim and a click handler for "close". Every one of
 * those jobs is something the platform does for a modal dialog, and doing them
 * by hand is what left the sheet claiming a modality it did not enforce — see
 * the note in \`shell/shortcuts.ts\`.
 *
 * \`::backdrop\` is the dim: the kit's static 70% scrim (\`color.scrim\`),
 * never blurred, the same in both appearances.
 *
 * The centring is \`margin: auto\` on the dialog itself, which is what a browser
 * already applies to a modal and what the flex parent was re-implementing. The
 * gutter the scrim used as padding survives as \`max-height\`/\`max-width\`
 * arithmetic on \`space["2xl"]\`, the kit's modal side inset, so the card still
 * never touches the viewport edge.
 *
 * No \`z-index\` either. A modal dialog is in the TOP LAYER, which is above every
 * stacking context in the document — including the 2147483400 this sheet used
 * to claim and the 2147483645 the vendor overlay claims. The constant is kept
 * in the module for the comment that explains the ordering it used to buy.
 */
.de-shortcuts::backdrop {
  background: ${t.color.scrim};
}

.de-shortcuts {
  display: flex; flex-direction: column;
  width: min(760px, 100% - ${t.space["2xl"] * 2}px);
  max-height: calc(100% - ${t.space["2xl"] * 2}px);
  margin: auto;
  padding: ${SHEET.padding} ${SHEET.padding} ${t.space["2xl"] - SHEET.hairline}px ${t.space["2xl"] - SHEET.hairline}px;
  border: ${SHEET.hairline}px solid ${t.color.border};
  border-radius: ${SHEET.outer};
  background: ${t.color.bgRaised};
  box-shadow: ${t.shadow.float};
  color: ${t.color.text};
  font-family: inherit;
  font-size: ${t.type.body};
}
/*
 * A \`<dialog>\` is focused on open — \`showModal\` puts focus on the card itself
 * when nothing inside it is autofocused, which is what this sheet wants, since
 * it is a document to read rather than a form to fill. The ring is suppressed
 * because that focus is a side effect of opening rather than a place the reader
 * navigated to; every control INSIDE the card keeps its own \`:focus-visible\`.
 */
.de-shortcuts:focus { outline: none; }
/* Not shown is not displayed. Without this a closed dialog still lays out. */
.de-shortcuts:not([open]) { display: none; }

/*
 * The header starts in the close button's corner and pads out to the content
 * line: \`CONTENT_REST\` above and to the right, so the title's top and the
 * divider's right end both sit 24px in, like the body's left edge. Its right
 * padding clears the button plus a \`space.sm\` gap. The button hangs back out
 * into the corner with a negative offset the size of that margin.
 */
.de-shortcut-head {
  position: relative;
  flex: none;
  margin-right: ${CONTENT_REST}px;
  padding: ${CONTENT_REST}px ${TITLE_CLEAR}px ${t.space.md}px 0;
  border-bottom: 1px solid ${t.color.border};
}
/* The kit's heading weight and tracking, at the editor's 12px title size. */
.de-shortcut-title {
  margin: 0;
  font-size: ${t.type.body};
  font-weight: ${t.type.weightTitle};
  letter-spacing: ${t.type.trackingTitle};
  color: ${t.color.text};
}
/*
 * The one rule that is not Figma's, printed where the key is about to be
 * pressed. \`textMuted\` rather than \`textDim\`: it is the only sentence in this
 * card that is not restating something the reader can already see, so it has to
 * survive a skim.
 */
.de-shortcut-note {
  margin: ${t.space["2xs"]}px 0 0;
  /* The measure this chrome picked by hand first, now the token everything
     else reads. See \`type.measure\`. */
  max-width: ${t.type.measure};
  font-size: ${t.type.caption};
  line-height: ${t.type.leadingBody};
  color: ${t.color.textMuted};
}
.de-shortcut-close {
  position: absolute; top: 0; right: -${CONTENT_REST}px;
  display: inline-flex; align-items: center; justify-content: center;
  width: ${t.size.toolSize}px; height: ${t.size.toolSize}px;
  padding: 0;
  border: none;
  border-radius: ${SHEET.radius};
  background: transparent;
  /* Icon-only, so full ink in every state (MICRO-INTERACTIONS § 5). */
  color: ${t.color.text};
  cursor: pointer;
  transition:
    background-color ${t.duration.hover} ${t.ease},
    box-shadow ${t.duration.hover} ${t.ease},
    transform ${t.duration.hover} ${t.ease};
}
/* The sheet is \`bgRaised\`, so its close button lifts to \`bgRaisedHover\`;
   \`bgHover\` would do nothing in dark and recede under the pointer in light. */
@media (hover: hover) and (pointer: fine) {
  .de-shortcut-close:hover { background: ${t.color.bgRaisedHover}; }
}
.de-shortcut-close:active { ${PRESS} }
.de-shortcut-close:focus-visible { ${FOCUS_OUTLINE} }

/*
 * Two columns where they fit, one below that.
 *
 * The list runs to about thirty rows; in a single column that is a scroll with
 * no shape to it, and the groups are exactly what makes it skimmable.
 * \`break-inside: avoid\` is the load-bearing line — without it a group's heading
 * lands at the foot of one column and its rows at the head of the next.
 */
.de-shortcut-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  margin-top: ${t.space.md}px;
  /* Out to the same 24px line on the right as the header's divider. */
  margin-right: ${CONTENT_REST}px;
  columns: 2;
  column-gap: ${t.space["2xl"]}px;
}
@media (max-width: 720px) { .de-shortcut-body { columns: 1; } }

.de-shortcut-group {
  break-inside: avoid;
  margin: 0 0 ${t.space.xl}px;
}
.de-shortcut-heading {
  margin: 0 0 ${t.space.sm}px;
  font-size: ${t.type.micro};
  font-weight: ${t.type.weightSection};
  letter-spacing: ${t.type.trackingEyebrow};
  text-transform: uppercase;
  color: ${t.color.textDim};
}

/*
 * Keys first, in a fixed gutter, so the column of keycaps reads as a column. A
 * shortcut sheet is scanned by key at least as often as by name — "what does ⌥2
 * do" — and a ragged key column makes that the slow direction.
 */
.de-shortcut-row {
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: ${t.space.sm}px;
  align-items: baseline;
  padding: ${t.space["2xs"]}px 0;
}
.de-shortcut-keys { display: flex; flex-wrap: wrap; gap: ${t.space["3xs"]}px; }

.de-kbd {
  display: inline-block;
  min-width: ${t.space.lg}px;
  padding: ${t.space["3xs"]}px ${t.space["2xs"]}px;
  border: 1px solid ${t.color.border};
  border-bottom-width: 2px;
  border-radius: ${t.radius.xs};
  background: ${t.color.bgSunken};
  color: ${t.color.text};
  /* The token, not a retyped stack. The literal here was \`font.mono\` with
     \`"SF Mono"\` dropped, so a key cap rendered in a different face from every
     other mono run in the chrome on any Mac without SFMono-Regular installed. */
  font-family: ${t.font.mono};
  font-size: ${t.type.caption};
  line-height: ${t.type.leadingBody};
  text-align: center;
  white-space: nowrap;
}

.de-shortcut-text { display: flex; flex-direction: column; gap: ${t.space["3xs"]}px; min-width: 0; }
.de-shortcut-label { color: ${t.color.text}; line-height: ${t.type.leadingRow}; }
/*
 * The Figma lineage, and it is deliberately quiet.
 *
 * It is there so a designer can check a key against what they already know, and
 * so a divergence from Figma is visible on the surface rather than buried in a
 * source comment. It is not what you read the row for, so it takes \`textDim\`
 * at \`micro\` — present on a second pass, invisible on the first.
 */
.de-shortcut-figma {
  font-size: ${t.type.micro};
  line-height: ${t.type.leadingRow};
  color: ${t.color.textDim};
}
`
