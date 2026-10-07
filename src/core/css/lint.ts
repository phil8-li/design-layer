/**
 * DS Lint: the button group, the summary line, the findings list and the
 * footer.
 *
 * The chip row that used to head this section is gone — the server already
 * routes a run to the checkers that apply, so listing them was showing a
 * decision nobody makes. What is left of it is the section title's hover,
 * which names them.
 *
 * This is a REPORT inside a 260px section, and almost every rule below follows
 * from those two facts together.
 *
 *  - **It is a SECTION, not a panel.** It had a header bar, a pinned footer and
 *    a body that scrolled inside itself, because it used to be a whole tab in
 *    the left rail. It now sits under Libraries on the Design system tab, so
 *    the heading, the fold, the 8px side padding and the 8px gap all come from
 *    `.de-section-header` / `.de-section-body` in `css/panels.ts`, and the
 *    panel body is what scrolls. Three rules are therefore GONE rather than
 *    adjusted: the header bar, `height: 100%`, and the inner scroller. A
 *    section that scrolls inside a column that also scrolls is two scrollbars
 *    for one list, and the inner one traps the wheel over the half of the tab
 *    the reader is least likely to have meant.
 *  - **Nothing may assume 260px.** The seam is draggable down to 200. Every
 *    string here is somebody else's: a checker's rule id, a linter's sentence,
 *    a project-relative path. So the rule name ellipses, the message wraps, and
 *    the actions sit on their own line under the text rather than beside it,
 *    where two buttons and a message would leave about forty pixels for the
 *    message.
 *  - **Severity is hue AND position, never hue alone.** The dot carries
 *    `lintWarning` or `danger`, and it is also the first thing on the row, in a
 *    fixed column — so a reader who cannot separate amber from red still reads
 *    the list as a list of two kinds of thing. The canvas badge makes the same
 *    argument with shape; this is its half of it.
 *  - **Explanatory prose takes the panel's note rank.** The `NO_FIX` sentence
 *    and the four empty states are the same kind of writing as
 *    `.de-variant-note` on the Design tab — a caption explaining a control,
 *    not a control — so they read at `caption`/`textDim` and the kit's reading
 *    leading (`leadingBody`) here rather than
 *    at the weights they wore when this surface owned a whole rail.
 *
 * `de-button` is borrowed rather than restated: Fix, Ignore and Unignore are
 * ordinary panel buttons that happen to be small. Only what is genuinely about
 * THIS surface is declared below.
 */

import { tokens as t, accentFillText, nest } from "../tokens"

/**
 * The restored-finding row, and the button parked in its right-hand corner.
 *
 * This one was backwards, which is the failure the offset rule makes impossible
 * to argue with: the row drew `radius.xs` and the `.de-button` inside it drew
 * `radius.sm`, four pixels from the corner — a CHILD rounder than the container
 * holding it. On a row with a filled ground that reads as the button having
 * escaped the corner rather than as two shapes nested.
 *
 * Fixed from the outside in, because the button is shared furniture and the row
 * is not. The button wears the fields' 8px corner (`CONTROL_RADIUS`), so the
 * row takes `radius.lg`: 12 − 4 = 8 — concentric, and nothing had to reach
 * into `.de-button` from a file that has no business doing it.
 */
const IGNORED = nest({ of: ".de-lint-ignored-row", outer: t.radius.lg, inset: t.space["2xs"] })

/**
 * The severity dot, in CSS pixels, and deliberately not a step on the spacing
 * scale.
 *
 * A spacing step is the gap between two things; this is the size of a mark, and
 * the ramp for those is `tokens.icon`, whose floor is 12 — a disc that size
 * beside 12px text reads as a bullet the row is indented by rather than as a
 * severity. Eight is the largest dot that still sits optically inside the cap
 * height of the first line of the message.
 */
const DOT = 8

/**
 * Keyboard focus, as the kit draws it on an action: the edge takes the accent
 * and a 3px halo of it at 30% sits outside. `outline` carries the edge so the
 * borderless controls in this sheet get one too; every call site is
 * `:focus-visible`, so pointer focus paints nothing.
 */
const FOCUS_RING = `outline: 1px solid ${t.color.accent}; outline-offset: 0; box-shadow: 0 0 0 3px color-mix(in srgb, ${t.color.accent} 30%, transparent);`

/** Hover paint only on a real pointer (kit interaction rule 1). */
const HOVER = "@media (hover: hover) and (pointer: fine)"

/**
 * One line of row text: the body size at the row leading (12/16), rounded to
 * the device pixel the dot has to centre on.
 */
const LINE = Math.round(Number.parseFloat(t.type.body) * t.type.leadingRow)

export const lintCss = `/* ---------- design system audit ---------- */
/*
 * A plain column at the section body's own gap.
 *
 * Matching \`.de-section-body\`'s 8 rather than picking a rhythm of its own is
 * the whole point of the re-housing: the distance from the buttons to the
 * summary and from the summary to the list is then the same distance the Design
 * tab puts between two fields, and the two sections on this tab read as one
 * panel instead of as two surfaces that were built apart.
 */
.de-lint { display: flex; flex-direction: column; gap: ${t.space.sm}px; }

/*
 * ONE BUTTON GROUP, WITH TWO SHAPES.
 *
 * Audit alone before a run; Audit, Fix all and Hide markers once there is a
 * report for the other two to act on. It is one wrapping flex row rather than a
 * segmented control for the reason everything else in this file wraps: the
 * three labels come to roughly 270px and the seam drags down to 200, so a
 * segmented control here is a control that would have to clip one of its own
 * members. Wrapping to a second line costs a row of height and loses nothing.
 *
 * Both primaries take the slack and the toggle does not, so the pair that DOES
 * something shares line one at equal width and the mode switch tucks under it —
 * rather than the reverse, which put a 110px "Hide markers" beside a squeezed
 * "Fix all (12)" and read as the toggle being the important one.
 */
.de-lint-controls { display: flex; flex-wrap: wrap; gap: ${t.space["2xs"]}px; }
.de-lint-run { flex: 1 1 auto; justify-content: center; }

/* The line the whole feature is judged by. \`text\` rather than \`textDim\`: it is
   a count, not a caption, and the reader checks it against the canvas. */
.de-lint-summary { color: ${t.color.text}; font-size: ${t.type.body}; line-height: ${t.type.leadingRow}; }
.de-lint-summary:empty { display: none; }

/* No scroller and no padding of its own: the panel body scrolls, and the
   section body has already inset this by 8. */
.de-lint-body { display: flex; flex-direction: column; }
.de-lint-body:empty { display: none; }

/* A rule is a heading over its findings, and the count is what makes the list
   skimmable — "this rule fired eleven times" is the shape of the problem. */
.de-lint-group { border-top: 1px solid ${t.color.border}; }
.de-lint-group-head {
  display: flex; align-items: center; gap: ${t.space.sm}px;
  height: ${t.size.rowHeight}px; padding: 0 ${t.space["2xs"]}px;
  color: ${t.color.textDim}; font-size: ${t.type.body}; font-weight: ${t.type.weightSection};
}
/*
 * Shrinkable with an ellipsis, and no longer monospaced.
 *
 * The heading is now "Hardcoded colours" rather than
 * \`design-tokens/no-raw-colours\` — see \`lint/plain.ts\` — and mono is the
 * typeface for text the reader has to match against a file. English in mono
 * reads as a fragment of code, which is exactly the impression this whole
 * change exists to remove. The ellipsis stays: a rule this editor has no
 * wording for keeps its id verbatim, and the count must not be pushed off the
 * end of the row by one.
 */
.de-lint-group-rule {
  flex: 0 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.de-lint-group-count { flex: none; font-weight: ${t.type.weightBody}; }

/*
 * The row is a grid of two columns, and the actions are not in it.
 *
 * It was three stacked bands — tick, text, then Fix and Ignore on a line of
 * their own — plus a two-line paragraph on every row that had no Fix. That is
 * about ten lines per finding, and a list of forty findings is then four
 * hundred lines of a 260px rail. The report was complete and nobody could read
 * it, which is the failure this arrangement is a reply to.
 *
 * What is left is the two lines that answer the reader's actual question —
 * WHICH value, and what does it become — with the checker's paragraph on hover
 * and the two buttons floated over the right-hand end on hover. Same
 * information, a third of the height, and the part a skim needs is the part
 * that is always painted.
 *
 * \`position: relative\` is load-bearing rather than incidental: it is what the
 * actions are positioned against, and taking them out of flow is the whole
 * reason the row is two lines instead of three.
 *
 * The side padding is one step rather than two: the section body already insets
 * this by 8, and doubling that would leave a 200px panel about 150px of text.
 * It is not zero, because the hover fill has to read as a band the row sits in
 * rather than as a rectangle cut around the text.
 */
.de-lint-row {
  position: relative;
  display: grid;
  grid-template-columns: ${t.size.miniSize}px 1fr;
  gap: ${t.space["2xs"]}px ${t.space["2xs"]}px;
  padding: ${t.space.sm}px ${t.space["2xs"]}px;
  /*
   * \`5xl\`, and the extra pixels are load-bearing.
   *
   * Floating the actions put a \`.de-button\` — the kit's action-button corner,
   * \`2xl\`, 14 — into this row's bottom-right corner at an inset of 4 on both
   * sides. Concentric then fixes the container: 14 + 4 = 18. At the row
   * highlight's \`lg\` the row drew a 12px corner around a 14px button sitting
   * 4px inside it, which is a child ROUNDER than the curve holding it, and on a
   * filled row that reads as the button having escaped the corner rather than
   * as two shapes nested. \`tools/concentric-audit.mjs\` reported the same
   * collision at the old sizes as \`.de-lint-row > .de-button.de-lint-action br
   * outer 8 inset 4 got 8 want 4\`.
   *
   * Fixed from the outside in, which is the call \`IGNORED\` above makes for the
   * same collision and the same reason: \`.de-button\` is shared furniture and
   * this row is not, so the row moves. Note that the static guard in
   * \`test/concentric-cases.mjs\` cannot see this one — it reads padding, and this
   * corner is made by \`position: absolute\`, not by the 8px/4px padding. The
   * browser audit is the only thing that catches it, which is exactly the half
   * of the check that tool exists for.
   */
  border-radius: ${t.radius["5xl"]};
  cursor: pointer;
  /*
   * The row's own ground, as a variable, because something else has to paint
   * with it.
   *
   * The actions float over the end of the text, so the strip behind them has to
   * be whatever the row is currently filled with — quiet on hover, accent when
   * ticked — or the buttons sit on a rectangle of the wrong colour on exactly
   * the rows a user is most likely to be looking at. Naming the fill once and
   * having both read it is the only version of this that cannot drift.
   */
  --de-lint-bg: transparent;
  background: var(--de-lint-bg);
  /*
   * BOTH ENDS OF THE CORRESPONDENCE MOVE, AND AT THE SAME SPEED.
   *
   * Hovering this row grows its badge on the page over \`hover\`
   * (\`css/lint-markers.ts\`); hovering the badge used to light this row between
   * two frames. That is one statement — "these two are the same finding" — said
   * in two motion languages depending on which end you touch, and the instant
   * end reads as a glitch beside the eased one.
   *
   * The kit's \`hover\` tween on both ends — 150ms, the one duration every hover
   * wash and colour change in the chrome takes — so the pair agrees on a rung
   * instead of on a number.
   *
   * \`background-color\` rides along so the quiet-hover and ticked fills the row
   * already switches between stop being the last untweened thing on it.
   */
  transition: box-shadow ${t.duration.hover} ${t.ease}, background-color ${t.duration.hover} ${t.ease};
}
/*
 * The ROW owns its severity tone and the dot spends it.
 *
 * One declaration per severity rather than one per mark, so a second severity
 * treatment — and there will be one, the first time this list grows a filter or
 * a left edge — cannot drift from the first. The fallback is the warning tone
 * because a row with no severity class at all is a row this section did not
 * build, and the quieter of the two is the safer thing to say about it.
 */
.de-lint-row--error { --de-lint-tone: ${t.color.danger}; }
.de-lint-row--warning { --de-lint-tone: ${t.color.lintWarning}; }
/* The quiet rung. The row is a click target, and the loud hover is spoken for
   by selection below — see the ordering argument in \`css/options.ts\`. */
${HOVER} { .de-lint-row:hover { --de-lint-bg: ${t.color.bgHoverQuiet}; } }
/* Ticked outranks hovered, because a tick is a decision and a hover is a
   pointer resting. */
.de-lint-row--checked { --de-lint-bg: ${t.color.accentSoft}; }
/*
 * The canvas is pointing at this row.
 *
 * A ring rather than a fill, and it has to be a ring: the badge on the page and
 * this row are one finding seen twice, so the row has to answer a pointer that
 * is nowhere near it — and it may already be wearing the ticked fill, which it
 * must not lose to say so.
 */
.de-lint-row--active { box-shadow: inset 0 0 0 1px ${t.color.accent}; }

.de-lint-check {
  grid-column: 1; grid-row: 1;
  display: inline-flex; align-items: center; justify-content: center;
  width: ${t.size.miniSize}px; height: ${t.size.miniSize}px;
  cursor: pointer;
}
/* \`accent-color\` rather than a hand-drawn box: a native checkbox already has
   the right hit behaviour, the right keyboard handling and the platform's own
   tick, and all it wants from the chrome is the chrome's colour. */
.de-lint-check-input { margin: 0; accent-color: ${t.color.accent}; cursor: pointer; }
.de-lint-check-input:focus-visible { ${FOCUS_RING} }

/*
 * The text is a button, and it has to stop looking like one.
 *
 * It is the row's primary action — selecting the element the finding is about —
 * so it has to be reachable by keyboard and named for a screen reader, which
 * makes it a \`button\`. Everything a user agent gives a button then has to be
 * taken back off, because a plate and a border around the message would turn a
 * list of sentences into a list of chips.
 *
 * \`min-width: 0\` because a grid item's floor is its content, and the content
 * here is a token name with no spaces in it. Without this one declaration a
 * single \`--ds-sys-color-state-primary-on-surface-focus\` sets the width of the
 * whole rail and the panel grows a horizontal scrollbar.
 */
.de-lint-select {
  grid-column: 2; grid-row: 1;
  display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start;
  column-gap: ${t.space.sm}px; row-gap: ${t.space["3xs"]}px;
  min-width: 0;
  padding: 0; border: none; background: transparent;
  color: inherit; font-family: inherit; font-size: ${t.type.body};
  text-align: left; cursor: pointer;
}
.de-lint-select { border-radius: ${t.radius.xs}; }
.de-lint-select:focus-visible { ${FOCUS_RING} }
/*
 * Severity as a mark in a fixed column — the first thing on the row, always the
 * same size, always in the same place.
 *
 * \`margin-top\` is optical, not rhythm: the dot has to centre on the first LINE
 * of a message that may wrap to four, and a grid that aligned it to the box
 * would drop it to the middle of the paragraph.
 *
 * ## AND THE SHAPE, WHICH IS THE HALF THAT WAS MISSING
 *
 * This mark used to be a circle at both severities, separated only by
 * \`--de-lint-tone\` — red against amber. That is meaning carried by hue alone,
 * and this product has already ruled on it: \`css/lint-markers.ts\` draws the
 * badge for the SAME finding on the canvas and its comment is explicit that
 * severity is said with "hue AND corner, never hue alone", with
 * \`ERROR_CORNER\`/\`WARNING_CORNER\` one ramp step apart. The panel was breaking
 * its own sibling's rule about its own data.
 *
 * The corners cannot be borrowed literally, and the reason is arithmetic rather
 * than taste: the badge is 20px, where \`radius.xs\` (4) and \`radius.sm\` (8) are
 * visibly different corners — but this mark is 8px, where \`radius.xs\` IS 50%.
 * Every step on the ramp collapses to the same disc at this size.
 *
 * So the pair is the two ENDPOINTS instead: a square for the error, a disc for
 * the warning. Neither is a ramp step pretending to be one — \`0\` is the absence
 * of a corner and \`50%\` is the absence of a straight edge — and they are the
 * two shapes that survive an 8px box, a greyscale print and a deuteranopia
 * simulation. The severer thing gets the harder corner, which is the same
 * direction the canvas badge runs in, so the two surfaces agree.
 *
 * The default stays a disc, matching \`--de-lint-tone\`'s own fallback and for
 * the same stated reason: a row with no severity class is a row this section
 * did not build, and the quieter shape is the safer thing to say about it.
 */
.de-lint-dot {
  grid-column: 1; grid-row: 1;
  width: ${DOT}px; height: ${DOT}px; margin-top: ${(LINE - DOT) / 2}px;
  border-radius: 50%;
  background: var(--de-lint-tone, ${t.color.lintWarning});
}
.de-lint-row--error .de-lint-dot { border-radius: 0; }
/*
 * The line the row is FOR: the offending value, and what it becomes.
 *
 * It used to be the checker's whole sentence here, wrapped to four lines and
 * never truncated, defended on the grounds that the useful half is at the end.
 * That is true of the sentence and false of the row: the useful half is the
 * literal and the replacement, which are structured fields the server already
 * sends, and reading them out of a paragraph was work the reader was doing on
 * the panel's behalf forty times over. The sentence is intact, one hover away.
 *
 * Wrapping rather than scrolling, because on a 200px rail \`#1a73e8 →
 * var(--ds-sys-color-state-primary-on-surface-focus)\` genuinely does not fit on
 * one line, and a second line is cheaper than either half being hidden.
 */
.de-lint-headline {
  grid-column: 2; grid-row: 1;
  display: flex; flex-wrap: wrap; align-items: center; gap: ${t.space["2xs"]}px;
  /* Row leading, not reading leading: this is the line the dot centres on, and
     the dot's offset is computed from the same 12/16 box. */
  min-width: 0; line-height: ${t.type.leadingRow};
}
/*
 * A value, with the colour it actually is.
 *
 * No plate, no border, no padding — deliberately. A chip around every literal
 * in a forty-row list is forty more rectangles, and the swatch has already done
 * the job a plate would be doing: making the value findable at a glance. This
 * is the same argument the row above makes about its own height, one level
 * down.
 *
 * \`min-width: 0\` for the ellipsis below to have anything to shorten.
 */
.de-lint-literal {
  display: inline-flex; align-items: center; gap: ${t.space["2xs"]}px;
  min-width: 0; max-width: 100%;
  font-family: ${t.font.mono}; font-size: ${t.type.caption};
}
/* The destination reads as the answer: same size, more weight, full-strength
   ink. The value it replaces stays at body ink — the row is not shouting at
   anyone about a colour they chose. */
.de-lint-literal--fix { font-weight: ${t.type.weightValue}; }
.de-lint-literal-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/*
 * The colour, painted.
 *
 * The inset hairline is not decoration: half the values in a token set are
 * near-white or fully transparent, and a 10px square of \`#fff\` on a light panel
 * with no edge is a 10px square of nothing. The ring is what makes "this one is
 * white" different from "there is no swatch here".
 */
.de-lint-swatch {
  flex: none;
  width: ${t.icon.marker}px; height: ${t.icon.marker}px;
  border-radius: ${t.radius.xs};
  box-shadow: inset 0 0 0 1px ${t.color.borderStrong};
}
/* Dim, and \`flex: none\` so it is never the thing that wraps to its own line —
   an arrow alone on a line points at nothing. */
.de-lint-arrow { flex: none; color: ${t.color.textDim}; }
/*
 * Four words, and only on a row that still has a decision in it.
 *
 * A row with a Fix says what it will do with an arrow and two swatches, so it
 * gets no hint at all. A row without one is the row where the reader has to
 * choose something, and the only thing worth telling them is which kind of
 * choosing it is: pick from near matches, or declare a new token. See
 * \`hintFor\` — the sentence that used to say this took two lines and a plate.
 */
.de-lint-hint {
  grid-column: 2;
  color: ${t.color.textDim}; font-size: ${t.type.caption}; line-height: ${t.type.leadingRow};
}
/*
 * Where it is, on exactly one line.
 *
 * It wrapped, and measured on a real audit that was the wrong call: a finding
 * in a stylesheet almost never resolves to a live element, so nearly every row
 * carries the off-page badge, and \`filename.css:120\` plus that badge does not
 * fit a 200px rail. The result was a second line on most rows, spent saying the
 * thing the summary has already counted — about a quarter of the height of the
 * whole list, given to the least important fact in it.
 *
 * The filename is what gives way, because a filename is the part that survives
 * being cut: see \`.de-lint-where-file\`. The badge never shrinks, since half of
 * a four-word badge says nothing.
 */
/* No \`gap\`: the name and the line number are ONE identifier and a space
   between them reads as two facts. The badge buys its own separation below. */
.de-lint-where {
  grid-column: 2;
  display: flex; align-items: center;
  min-width: 0;
  color: ${t.color.textDim}; font-family: ${t.font.mono}; font-size: ${t.type.caption};
  /* Pinned rather than left to the mono face's own line box, so a finding row
     has one known height and the loading skeleton below can stand in it. */
  line-height: ${t.type.leadingRow};
}
/*
 * The name gives way; the line number never does.
 *
 * A plain ellipsis on \`design-system-overrides.css:214\` eats the ":214", which
 * is the half the reader actually needs — several findings in one file differ
 * by nothing else, and a list of five rows all reading
 * \`design-system-overri…\` has told them nothing at all. So they are two spans:
 * the name shrinks, the number is \`flex: none\`, and a cut row reads
 * \`design-system-ove…:214\`.
 *
 * The obvious alternative was a LEADING ellipsis via \`direction: rtl\`, which
 * keeps the whole tail. It was tried and reverted: \`unicode-bidi: plaintext\`
 * takes the paragraph direction from the first strong character, which in a
 * filename is Latin, so the box goes back to LTR and the ellipsis returns to
 * the end — and dropping \`plaintext\` to fix that lets the bidi algorithm
 * reorder the neutral \`:\` between the name and the digits. Two spans have no
 * bidi behaviour to get wrong.
 */
.de-lint-where-file {
  min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.de-lint-where-line { flex: none; }
/*
 * Said on the row, not only in the summary's count — and now as two words.
 *
 * The summary explains why the two numbers differ; this explains which rows are
 * the difference. Without it, clicking a row and getting a toast instead of a
 * selection is the first the reader hears of it.
 *
 * It read "not on this page", which is a sentence, and it is on most rows of a
 * typical audit — so it was four words of identical text repeated down the
 * list, competing with the finding for the same 200px. "Off page" is the same
 * fact at a fifth of the width, and the row's own \`title\` carries the full
 * message for anyone who wants more.
 */
.de-lint-offpage {
  flex: none;
  margin-left: ${t.space.sm}px;
  padding: 0 ${t.space["2xs"]}px;
  border-radius: ${t.radius.xs};
  background: ${t.color.bgHover}; color: ${t.color.textMuted};
  font-family: ${t.font.ui};
}

/*
 * Fix and Ignore, floated over the end of the row and shown on approach.
 *
 * They had a band of their own under the text, which cost every row a third
 * line and every list eighty buttons — on a surface whose bulk path is the
 * single "Fix all" in the footer. Two buttons per row, permanently lit, forty
 * times down a rail, is most of what "too much information" was made of.
 *
 * Out of flow, so they cost no height; revealed on \`:hover\` for the pointer and
 * on \`:focus-within\` for the keyboard, which is not a nicety — an action only a
 * mouse can find is an action half the users do not have. They stay lit while a
 * row is TICKED, because a ticked row is one the reader is mid-decision on and
 * its controls disappearing when the pointer leaves is the panel taking the
 * decision back.
 *
 * The gradient is the mask: it fades from nothing to the row's own current
 * fill, so text passing under the buttons dissolves instead of colliding with
 * them. \`--de-lint-bg\` is transparent on a row at rest, which is exactly right,
 * because a row at rest is not showing these at all.
 *
 * Anchored to the BOTTOM, which is where the row keeps the line it can most
 * afford to lose. The top line is the finding — the value and what it becomes —
 * and floating two buttons over the end of it would hide the token name at
 * exactly the moment the reader is hovering the row to decide about it. The
 * last line is \`file:line\` and the off-page badge, which are the row's least
 * load-bearing facts and are both repeated in its \`title\`. Bottom-anchoring
 * also lands the strip in the same place on a two-line row and a three-line
 * one, where centring would put it against the value on one and the filename
 * on the other.
 */
.de-lint-actions {
  position: absolute;
  bottom: ${t.space["2xs"]}px; right: ${t.space["2xs"]}px;
  display: flex; gap: ${t.space["2xs"]}px;
  padding-left: ${t.space.md}px;
  background: linear-gradient(to right, transparent, var(--de-lint-bg) ${t.space.md}px);
  opacity: 0; pointer-events: none;
  transition: opacity ${t.duration.hover} ${t.ease};
}
${HOVER} { .de-lint-row:hover .de-lint-actions { opacity: 1; pointer-events: auto; } }
.de-lint-row:focus-within .de-lint-actions,
.de-lint-row--checked .de-lint-actions { opacity: 1; pointer-events: auto; }
/* A touch has no hover to reveal them with, so they are simply always there. */
@media (pointer: coarse) { .de-lint-actions { opacity: 1; pointer-events: auto; } }
/* No fade for anyone who asked not to see one. The reveal is a state change the
   reader triggered, so it must still HAPPEN — instantly, not never. */
@media (prefers-reduced-motion: reduce) {
  .de-lint-actions { transition: none; }
}
/* A panel button at panel scale: the row is already padded, so the button inside
   it gives back the side padding a standalone one needs. */
.de-lint-action { height: ${t.size.rowHeight}px; padding: 0 ${t.space.sm}px; }

/*
 * The four empty states, scoped rather than restyled.
 *
 * They are \`.de-empty\`, which is shared furniture: centred text with 24px of
 * air above and below, sized for a PANE that has nothing in it. Inside a
 * section with another section directly underneath, that box pushes the footer
 * down by two rows to say one line — so the rank is overridden here, where the
 * scope is this surface, instead of in \`css/panels.ts\`, where it would move
 * the empty state of every other panel in the editor.
 */
.de-lint .de-empty {
  padding: ${t.space["2xs"]}px 0;
  text-align: left;
  color: ${t.color.textDim};
  font-size: ${t.type.caption}; line-height: ${t.type.leadingBody};
}

/* A run that failed is a sentence from the server, in the danger tone, where
   the list would have been. Not a toast: a toast is gone in four seconds and
   this is the state the section is now in. */
.de-lint-error {
  margin: 0; padding: ${t.space["2xs"]}px 0;
  color: ${t.color.danger}; font-size: ${t.type.body}; line-height: ${t.type.leadingBody};
}

/*
 * The footer is the dismissed list and nothing else, so it is usually not there.
 *
 * It held Fix all and Hide markers until those joined Audit in one group at the
 * top; what is left is the ignored disclosure, which exists only once something
 * has been ignored. Hence \`:empty\` — the hairline is still right when there IS
 * something under it, and a hairline with nothing under it is a rule drawn
 * across the bottom of the section for no reason.
 */
.de-lint-footer {
  display: flex; flex-direction: column; gap: ${t.space.sm}px;
  padding-top: ${t.space.sm}px;
  border-top: 1px solid ${t.color.border};
}
.de-lint-footer:empty { display: none; }
.de-lint-fix-all { flex: 1 1 auto; justify-content: center; }
.de-lint-toggle { flex: none; }
/* The toggle reports a state, so it takes the pressed fill the chips in
   \`css/options.ts\` take — markers hidden is a mode the panel is in, not an
   action it just performed. */
.de-lint-toggle[aria-pressed="true"] { ${accentFillText} }

.de-lint-ignored { display: flex; flex-direction: column; gap: ${t.space["2xs"]}px; }
/*
 * A quiet disclosure, deliberately not a button-looking button.
 *
 * Unignoring is a rare, reversible correction, and a third pill beside Fix all
 * and Hide markers would give it the same weight as the two controls the footer
 * is actually for. Same treatment as the Libraries section's own fold and as
 * \`.de-opt-link\` in the options browser.
 */
.de-lint-ignored-summary {
  display: inline-flex; align-items: center; gap: ${t.space["2xs"]}px;
  align-self: flex-start;
  padding: 0; border: none; background: transparent;
  color: ${t.color.textDim};
  font-family: inherit; font-size: ${t.type.caption}; cursor: pointer;
}
.de-lint-ignored-summary { border-radius: ${t.radius.xs}; transition: color ${t.duration.hover} ${t.ease}; }
${HOVER} { .de-lint-ignored-summary:hover { color: ${t.color.text}; } }
.de-lint-ignored-summary[aria-expanded="true"] { color: ${t.color.text}; }
.de-lint-ignored-summary:focus-visible { ${FOCUS_RING} }
/* A real glyph rather than a \`content\` character, so this twisty, the options
   browser's and the layer tree's are one drawing at one weight. */
.de-lint-twisty {
  display: inline-flex; align-items: center; justify-content: center;
  transition: transform ${t.duration.hover} ${t.ease};
}
.de-lint-ignored-summary[aria-expanded="true"] .de-lint-twisty { transform: rotate(90deg); }
.de-lint-ignored-body { display: flex; flex-direction: column; gap: ${t.space["2xs"]}px; }
.de-lint-ignored-body[hidden] { display: none; }
.de-lint-ignored-row {
  display: flex; align-items: center; gap: ${t.space.sm}px;
  padding: ${IGNORED.padding};
  border-radius: ${IGNORED.outer};
  background: ${t.color.bgSunken};
}
/* One line and an ellipsis. A dismissed finding is being listed so it can be
   restored, not read — the full sentence is in the title and comes back to the
   list in full the moment it is unignored. */
.de-lint-ignored-text {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: ${t.color.textDim}; font-size: ${t.type.body};
}
/* A button laid in a well: the shared button's fill is the well's own rung in
   light (both are the kit's \`--secondary\`), so it takes the panel ground
   instead and lifts off the well in both themes. */
/* Secondary buttons only — see the same pair on \`.de-lib-manual-row\`. */
.de-lint-ignored-row > .de-button:not(.de-button--primary, .de-button--danger) { background: ${t.color.bg}; }
${HOVER} { .de-lint-ignored-row > .de-button:not(.de-button--primary, .de-button--danger):hover { background: ${t.color.bgRaisedHover}; } }


/*
 * AN AUDIT IN FLIGHT, SAID IN MOTION RATHER THAN IN A WORD.
 *
 * This is the only genuinely long-running operation in the editor — a round
 * trip to a checker over the whole page — and it used to announce itself as the
 * static string "Auditing…" in two places beside a \`ListChecks\` glyph that did
 * not move. A disabled button wearing a word is also exactly what a button
 * looks like when something has gone wrong.
 *
 * Two halves, one flag. The button gets a sweep, which is the standard
 * indeterminate signal and the only one that says "still going" rather than
 * "still like this"; the list gets rows where the findings will land, because
 * the useful thing to say about a gap is its shape and not a sentence in the
 * middle of it.
 *
 * The sweep rides a pseudo-element with \`overflow: hidden\` on the button, so it
 * cannot disturb the label or the glyph, and it is the button's own ink at low
 * alpha rather than a colour of its own — a progress indicator that introduces
 * a new hue reads as a state change, which is the one thing this is not.
 *
 * SIX REVEAL RUNGS, not a number of its own: an indeterminate loop has no
 * duration to be correct about, so it takes \`reveal\` multiplied rather than a
 * literal, and stays in agreement with everything else if the ramp ever
 * moves. Fast enough to read as activity, slow enough not to nag.
 *
 * Reduced motion keeps both statements and drops the movement — the sweep
 * becomes a still wash and the rows a flat tint, so the surface still says "not
 * yet" without anything travelling.
 */
.de-button[data-de-busy] { position: relative; overflow: hidden; }
.de-button[data-de-busy]::after {
  content: "";
  position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, ${t.color.borderStrong}, transparent);
  animation: de-lint-sweep calc(${t.duration.reveal} * 6) linear infinite;
  pointer-events: none;
}
@keyframes de-lint-sweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }

/* Each rest is a finding row's exact box — 8px pad, the value line, the 4px
   row gap, the \`file:line\` line, 8px pad — so the list lands where the rests
   were and nothing moves (kit: skeletons in the loaded geometry).

   \`space["2xs"]\`, matching \`.de-lib-scan\`. Two loading skeletons in adjacent
   sections of one panel were running at two rhythms — 2px here against 4px
   there — so the same "we are fetching" idea read as two different treatments
   depending on which section you were looking at. Row HEIGHT can legitimately
   differ (a lint row is one line, a library candidate is four); the pulse
   cadence and the gap are the vocabulary and should not. */
.de-lint-skeleton { display: flex; flex-direction: column; gap: ${t.space["2xs"]}px; padding: ${t.space["2xs"]}px 0; }
.de-lint-skeleton-row {
  height: ${2 * t.space.sm + 2 * LINE + t.space["2xs"]}px;
  /* The row's own corner: a loader takes the radius of what it stands in for. */
  border-radius: ${t.radius["5xl"]};
  background: ${t.color.bgHoverQuiet};
  animation: de-lint-breathe calc(${t.duration.reveal} * 6) ${t.ease} infinite;
}
/* Staggered by a third of the loop each, so the three read as one group
   waiting rather than three rows blinking in time. */
.de-lint-skeleton-row:nth-child(2) { animation-delay: calc(${t.duration.reveal} * -2); }
.de-lint-skeleton-row:nth-child(3) { animation-delay: calc(${t.duration.reveal} * -4); }
@keyframes de-lint-breathe { 0%, 100% { opacity: 0.85; } 50% { opacity: 0.35; } }

@media (prefers-reduced-motion: reduce) {
  .de-button[data-de-busy]::after {
    animation: none;
    background: ${t.color.bgHoverQuiet};
  }
  .de-lint-skeleton-row { animation: none; opacity: 0.6; }
}
`
