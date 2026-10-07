/**
 * The design-system token picker: field, popover, search, and grouped rows.
 *
 * Its own module so the picker's surface is owned in one place, the way every
 * other lane owns the stylesheet for the surface it draws.
 */

import { tokens as t, accentFillText } from "../tokens"
import { CONTROL_RADIUS, FOCUS_RING } from "./panels"

export const tokenPickerCss = `/* ---------- token field ---------- */
/*
 * The whole row is the target. The old control was a native select whose option
 * text had to spell the token, its source and its value on one line; a button
 * that opens a real list owes the closed state nothing but the name.
 */
/*
 * The kit's field: filled with \`field\`, borderless at rest, \`fieldHover\` one
 * rung on. It was the one outlined control in a paint row whose select and
 * number field beside it are both filled wells, so the row read as two
 * species. It is a menu trigger (\`aria-haspopup\`), so it takes no press, and
 * while its picker is open it holds the hover paint.
 *
 * The gap is the run from the chip to the name and takes the workhorse step;
 * the side padding takes the tight one, because a 24px field in a 260px panel
 * pays for both sides out of the token name, and the name is the only thing the
 * closed state has to say.
 */
.de-token-field {
  display: flex; align-items: center; gap: ${t.space.sm}px;
  width: 100%; height: ${t.size.rowHeight}px;
  padding: 0 ${t.space["2xs"]}px;
  border: 1px solid transparent; border-radius: ${CONTROL_RADIUS};
  background: ${t.color.field}; color: ${t.color.text};
  font: inherit; font-size: ${t.type.body}; text-align: left;
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, border-color ${t.duration.hover} ${t.ease},
    box-shadow ${t.duration.hover} ${t.ease};
}
@media (hover: hover) and (pointer: fine) {
  .de-token-field:hover { background: ${t.color.fieldHover}; }
}
.de-token-field[aria-expanded="true"] { background: ${t.color.fieldHover}; }
.de-token-field:focus-visible { ${FOCUS_RING} }
.de-token-field-name {
  flex: 1; min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-weight: ${t.type.weightBody};
}
/* Nothing is bound, so this is the element's own value rather than a name. */
.de-token-field-name--plain { color: ${t.color.textMuted}; }

/* ---------- the leading glyph slot ---------- */
/* \`icon.action\`, which is the 16 it already was — written as the ramp rung so
   the chip tracks the glyph it shares a row with if the ramp ever moves. */
.de-token-swatch {
  flex: none;
  display: flex; align-items: center; justify-content: center;
  width: ${t.icon.action}px; height: ${t.icon.action}px;
  border-radius: ${t.radius.xs};
}
/*
 * Inset rather than a border: a border would grow the chip and shift the name,
 * and the ring exists so a near-white token still reads as a chip on the dark
 * chrome instead of dissolving into the surface behind it.
 */
.de-token-swatch--color { box-shadow: inset 0 0 0 1px ${t.color.border}; }
.de-token-swatch--radius { box-shadow: inset 0 0 0 1px ${t.color.borderInteractive}; }
.de-token-swatch--text { font-weight: ${t.type.weightValue}; line-height: ${t.type.leadingFlush}; }
/* The mark carries its own weight; the slot only has to not crop it. */
.de-token-swatch--glyph { color: ${t.color.text}; }
.de-token-swatch--glyph svg { display: block; }

/* ---------- picker popover ---------- */
/*
 * The kit's menu geometry: a 16px corner, \`shadow.popover\` (which carries the
 * card hairline, so there is no border to double it), and a list inset 6px
 * whose rows take the concentric 10px corner. It opens instantly in its final
 * geometry — \`inspector/token-picker.ts\` no longer gives it the shared
 * entrance — because a picker is opened dozens of times an hour.
 */
.de-token-popover {
  position: fixed;
  z-index: 2147483200;
  width: 264px;
  display: flex; flex-direction: column;
  background: ${t.color.bgRaised};
  border-radius: ${t.radius["3xl"]};
  box-shadow: ${t.shadow.popover};
  overflow: hidden;
}
/* Every text edge in the popover — header, search, group label, row, footer,
   empty state — sits 12px in, so the title, the group names and the row names
   all start on one line. The list's rows get there as 6px of list inset plus
   6px of their own, which is what leaves room for their rounded highlight. */
.de-token-popover-header {
  display: flex; align-items: center; gap: ${t.space.sm}px;
  height: ${t.size.sectionHeader}px; padding: 0 ${t.space.md}px;
  border-bottom: 1px solid ${t.color.border};
}
.de-token-popover-title {
  flex: 1; min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-size: ${t.type.body}; font-weight: ${t.type.weightSection};
}
.de-token-search {
  display: flex; align-items: center; gap: ${t.space.sm}px;
  padding: 0 ${t.space.md}px; height: ${t.size.sectionHeader}px;
  border-bottom: 1px solid ${t.color.border};
  color: ${t.color.textDim};
}
.de-token-search-input {
  flex: 1; min-width: 0;
  border: none; background: transparent;
  color: ${t.color.text};
  font: inherit; font-size: ${t.type.body};
}
/*
 * The kit's field focus: the field's border takes the accent. The row IS the
 * field here and its one edge is the hairline under it, so that hairline
 * turns accent while the caret is in the box. Focus arrives by script when
 * the picker opens, so this is also what tells a keyboard user where they
 * landed. The custom footer below does the same with its top rule.
 */
.de-token-search-input:focus,
.de-token-custom-input:focus { outline: none; }
.de-token-search:has(:focus-visible) { border-bottom-color: ${t.color.accent}; }
.de-token-custom:has(:focus-visible) { border-top-color: ${t.color.accent}; }
.de-token-search-input::placeholder { color: ${t.color.textDim}; }

/* No top inset: the sticky group label pins to the top of the padding box, and
   rows would show through a strip above it. */
.de-token-list { max-height: 320px; overflow-y: auto; padding: 0 ${t.space.xs}px ${t.space.xs}px; }
/*
 * Sticky because the leaf names only make sense under their group: scroll the
 * header away and \`Primary\` stops saying which family it belongs to.
 */
/*
 * A heading outranks the rows under it. This one did not.
 *
 * \`textDim\` would put the group label at 7.1:1 dark and 5.8:1 light while
 * every leaf below it sits at 12.1:1 and 19.1:1 — the label naming a family
 * the faintest thing in the list it names, which is the hierarchy collapse in
 * its purest form. \`textMuted\`, at 7.9:1 and 10.5:1, is a step under the rows
 * and over anything dim, which is where a sub-heading belongs.
 *
 * The 28px box is 8 + 16 + 4: the 12px body on the 12/16 leading base.ts
 * sets. It has to hold — \`.de-token-row\`
 * clears exactly this number with \`scroll-margin-top\`, and picker-cases.mjs
 * asserts the two agree.
 */
.de-token-group {
  position: sticky; top: 0; z-index: 1;
  height: 28px;
  padding: ${t.space.sm}px ${t.space.xs}px ${t.space["2xs"]}px;
  background: ${t.color.bgRaised};
  color: ${t.color.textMuted};
  font-size: ${t.type.body}; font-weight: ${t.type.weightSection};
}
/*
 * scroll-margin-top clears the sticky header. Opening the picker scrolls the
 * current token into view, and \`block: "nearest"\` parks the row flush with the
 * list's top edge — which is UNDERNEATH the header, so the first row of a group
 * was sliced in half by the label naming it.
 *
 * It clears a box rather than setting a rhythm, so it stays a literal pinned to
 * that header's height. On the spacing scale it would round to 30 and overshoot
 * the header by two pixels every time the picker opens.
 */
.de-token-row {
  display: flex; align-items: center; gap: ${t.space.sm}px;
  width: 100%; height: 28px; padding: 0 ${t.space.xs}px;
  scroll-margin-top: 28px;
  border: none; border-radius: ${t.radius.md};
  background: transparent;
  color: ${t.color.text};
  font: inherit; font-size: ${t.type.body}; text-align: left;
  cursor: pointer;
}
.de-token-row-name {
  flex: 1; min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.de-token-row-detail { flex: none; color: ${t.color.textDim}; }
.de-token-row-check { flex: none; display: flex; align-items: center; }
/* \`bgRaisedHover\`, not \`bgHover\`: this popover is \`bgRaised\`, and \`bgHover\` is
   the same value in dark and a rung BELOW it in light — pointing at a row
   would do nothing or darken it. */
@media (hover: hover) and (pointer: fine) {
  .de-token-row:hover { background: ${t.color.bgRaisedHover}; }
}
/*
 * The keyboard cursor is not the pointer cursor. Given the same wash, the two
 * are indistinguishable the moment a hand is on each — so the active row keeps
 * the wash and adds a rule to say which row Enter would actually take.
 */
.de-token-row[data-active="true"] {
  background: ${t.color.bgRaisedHover};
  box-shadow: inset 0 0 0 1px ${t.color.accent};
}
/*
 * The binding is the accent fill with its paired ink (\`accentFillText\`), so the
 * fill and the word cannot be written apart: selection is a hue, never a grey.
 */
.de-token-row[aria-selected="true"] { ${accentFillText} }
/*
 * Every part of the row that names its own ink has to name it again here, or it
 * keeps the resting one on the indigo. The glyph preview is the part that did:
 * \`.de-token-swatch--glyph\` states \`text\` so the mark wears full ink at rest,
 * and that declaration beats the row's inherited \`onAccent\` — so the chosen
 * icon in the icon picker was near-black on indigo in light (2.85:1, under the
 * 3:1 a mark is owed) while the dark theme's near-white passed and hid it.
 */
.de-token-row[aria-selected="true"] .de-token-row-detail,
.de-token-row[aria-selected="true"] .de-token-swatch--glyph { color: ${t.color.onAccent}; }
/* The radius chip IS its outline, and \`borderInteractive\` on the indigo is
   1.85:1 dark and 1.8:1 light — the preview disappeared on the one row whose
   value the reader is checking. */
.de-token-row[aria-selected="true"] .de-token-swatch--radius { box-shadow: inset 0 0 0 1px ${t.color.onAccent}; }
/* An accent rule on the accent is no rule at all, so the ink draws it instead. */
.de-token-row[aria-selected="true"][data-active="true"] {
  box-shadow: inset 0 0 0 1px ${t.color.onAccent};
}
/*
 * A token that does not apply is unavailable, not erased.
 *
 * \`opacity: 0.4\` puts the name at 3.3:1 dark / 2.6:1 light and its value at
 * 2.4:1 / 1.8:1 — you can see that a row is there and not read which token it
 * is, so "why can I not pick this one?" has no answer on screen. WCAG exempts a
 * disabled control from contrast, which is how every disabled state in this
 * chrome drifted to the same place.
 *
 * \`opacity: 0.7\` fixes the name (6.8:1 / 7.2:1) without fixing the value
 * (4.3:1 / 3.1:1, against the 4.5:1 text owes). That is the flaw in
 * dimming a ROW: the row has two inks at different weights, one fraction moves
 * both, and there is no single fraction that lands them both — tune it for the
 * quiet one and the loud one stops reading as disabled at all.
 *
 * So both inks are named instead, and they converge. A disabled row is the one
 * place the name/value hierarchy is worth giving up: the row is not offering a
 * choice any more, it is explaining why it cannot.
 */
.de-token-row[aria-disabled="true"] .de-token-row-name,
.de-token-row[aria-disabled="true"] .de-token-row-detail { color: ${t.color.textDisabled}; }
.de-token-empty { padding: ${t.space.sm}px ${t.space.xs}px; color: ${t.color.textDim}; font-size: ${t.type.body}; }

/* ---------- the way out of the list ---------- */
/*
 * A footer rather than a row in the list: what a designer types here is not one
 * more choice among the system's, it is the decision to leave it. The rule above
 * says so — the same hairline the header uses, so the list reads as closed
 * before this field starts.
 *
 * Its geometry copies the search row on purpose. The two are the picker's only
 * text fields, they sit at its two ends, and giving the escape hatch a heavier
 * treatment would advertise it over the seventy-one rows it is the exception to.
 */
.de-token-custom {
  display: flex; align-items: center; gap: ${t.space.sm}px;
  padding: 0 ${t.space.md}px; height: ${t.size.sectionHeader}px;
  border-top: 1px solid ${t.color.border};
  color: ${t.color.textDim};
}
.de-token-custom-label { flex: none; font-size: ${t.type.body}; }
.de-token-custom-input {
  flex: 1; min-width: 0;
  border: none; background: transparent;
  color: ${t.color.text};
  font: inherit; font-size: ${t.type.body};
  text-align: right;
}
.de-token-custom-input::placeholder { color: ${t.color.textDim}; }

`
