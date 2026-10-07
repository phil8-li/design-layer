/**
 * Two surfaces that used to be one, and are styled together because the rows
 * still are.
 *
 * `.de-option*` and `.de-style-*` are the saved styles inside the right
 * panel's Typography, Fill, Stroke, Effects, Appearance and Layout sections —
 * this editor's own per-element snapshots, beside the selection every one of
 * their verbs needs.
 * `.de-opt-*` is the left panel's Controls pane: the app's own tunables, the
 * folders they sit in, and the filter and scope switch over them.
 *
 * They share a stylesheet rather than splitting into two because the second set
 * was, until recently, rendered in three places at three widths, and keeping
 * one copy of the row is what stopped them drifting. That is one place now, but
 * splitting the file today would be a rename with no reader on the other end of
 * it.
 */

import { tokens as t, accentFillText } from "../tokens"
import { CONTROL_RADIUS } from "./panels"

/**
 * The keyboard focus ring, the kit's recipe (MICRO-INTERACTIONS § 3): the edge
 * takes the accent and a 3px halo of the accent at 30% sits outside it. Built
 * from the accent token; it resolves to the same colour as \`accentHalo\`.
 */
const HALO = `color-mix(in srgb, ${t.color.accent} 30%, transparent)`
const FOCUS_RING = `0 0 0 1px ${t.color.accent}, 0 0 0 4px ${HALO}`
/** The same ring drawn inside the box, for a band flush with the panel edge. */
const FOCUS_RING_INSET = `inset 0 0 0 1px ${t.color.accent}, inset 0 0 0 4px ${HALO}`

export const optionsCss = `/* ---------- options / variants ---------- */
/* \`space.sm\` between the name and the two action plates, so their four-sided
   24px pads do not overlap. At \`space["3xs"]\` the rename and delete targets were
   20px apart and 24px wide, so the gap between them armed one of the two. */
.de-option-row { display: flex; align-items: center; gap: ${t.space.sm}px; }
/*
 * Two jobs, two rungs. The gap is the run between the mark and the name, so it
 * takes the workhorse step; the side padding sits inside a 24px row in a 260px
 * panel, where the same step would spend on air the width the name needs to
 * finish before its ellipsis. It was 6 leading and 4 trailing, an asymmetry
 * nothing in the row justified.
 */
.de-option {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: ${t.space.sm}px;
  height: ${t.size.rowHeight}px; padding: 0 ${t.space["2xs"]}px;
  border-radius: ${t.radius.sm};
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, box-shadow ${t.duration.hover} ${t.ease};
}
/*
 * Hover is the quiet rung, and it has to be: checked is \`accentSoft\` at
 * 1.33:1 off the dark panel, and \`bgHover\` is 1.42:1. Pointing at an unchosen
 * option would light it brighter than the chosen one — the control telling you
 * the wrong answer for exactly as long as your hand was on it. \`bgHoverQuiet\`
 * (1.32:1 dark, 1.05:1 light) leaves selection on top, and the indigo hue
 * carries the rest.
 *
 * Checked is the fill alone. It also drew a 1px accent hairline, and the kit's
 * rule is that selection is a fill — no hairline, no shadow — because the hue
 * already says "this one" and an edge only makes it read as focused.
 */
@media (hover: hover) and (pointer: fine) {
  .de-option:hover { background: ${t.color.bgHoverQuiet}; }
}
.de-option[aria-checked="true"] { background: ${t.color.accentSoft}; }
/* It is \`tabindex="0"\` and a \`role="radio"\`, and it had no focus state at all —
   arrowing through saved options moved a cursor nothing on screen drew. The
   kit's ring: accent edge, 3px halo. */
.de-option:focus-visible { outline: none; box-shadow: ${FOCUS_RING}; }
.de-option-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
/*
 * Rename, drawn like Delete because it is the other half of the same strip.
 *
 * It had no control at all until now: renaming was \`dblclick\` on the name span,
 * which no key can reach, so the verb was pointer-only. The button the deleted
 * options dialog carried is what this restores.
 *
 * Every declaration is shared with \`.de-option-delete\` below except the hover,
 * which is the quiet plate rather than the destructive wash — a rename is not a
 * thing to warn anybody about.
 *
 * Both are icon-only actions, so both wear FULL ink at rest and in every state:
 * the glyph is the whole label, and a dim glyph reads as disabled (kit § 5).
 * \`radius.sm\` is the rung for an icon-only mini button.
 */
.de-option-rename,
.de-option-delete {
  position: relative;
  width: ${t.size.miniSize}px; height: ${t.size.miniSize}px; flex: none;
  border: none; border-radius: ${t.radius.sm};
  background: transparent; color: ${t.color.text}; cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, color ${t.duration.hover} ${t.ease},
    box-shadow ${t.duration.hover} ${t.ease}, transform ${t.duration.hover} ${t.ease};
}
/*
 * The pad grows on all FOUR sides, and it grew on two.
 *
 * \`inset: -3px 0\` took the 18px plate to 24px tall and left it 18px wide, so
 * these cleared the pointer floor in one axis only. The layers strip already
 * pads four-sided and the two are the same control; the horizontal half is
 * affordable now that the strip's own gap is \`space.sm\` rather than \`xs\`,
 * which is what used to make a four-sided pad overlap its neighbour.
 */
.de-option-rename::after,
.de-option-delete::after {
  content: ""; position: absolute;
  inset: -${(t.size.rowHeight - t.size.miniSize) / 2}px;
}
@media (hover: hover) and (pointer: fine) {
  .de-option-rename:hover { background: ${t.color.bgHover}; color: ${t.color.text}; }
}
.de-option-rename:focus-visible,
.de-option-delete:focus-visible { outline: none; box-shadow: ${FOCUS_RING}; }
.de-option-rename:active:not([aria-disabled="true"]),
.de-option-delete:active { transform: scale(0.98); }
/*
 * Visible at rest. It used to be \`opacity: 0\` until hover, which meant the one
 * verb this panel actually supports was invisible to anyone reading the screen.
 *
 * The hit pad is the four-sided one the shared rule above gives both buttons:
 * an 18px plate in a 24px row. A second \`.de-option-delete\` block used to sit
 * here restating every declaration and then cutting the pad back to vertical
 * only, which quietly undid the four-sided pad the note above describes for
 * one of the two buttons. It is gone; the bleed is still derived from the two
 * sizes rather than rounded onto the spacing scale, because it is half of what
 * the row has over the plate, not rhythm.
 */
/*
 * A WASH OF THE DANGER HUE, where it was a filled coral plate.
 *
 * The kit's destructive ghost: transparent at rest, the destructive hue at 10%
 * under the pointer, and the glyph taking the destructive ink. A filled plate
 * on an 18px button was the loudest thing in the row for as long as the pointer
 * crossed it; a wash says "this one removes" without shouting it. The note
 * below records why the ink on the old fill had to be \`onSemantic\`, which is
 * still the rule for anything that does sit on a filled danger plate.
 *
 * Dark ink on the coral, never white — and focus is a ring, not the fill.
 *
 * This was the live case of the pairing trap \`accentFill\` exists to close:
 * \`danger\` is a LIGHT coral in dark, so a white X on it was an empty coral
 * square for the whole of the hover. \`onAccent\` is white in both themes, so it
 * cannot be the ink here.
 *
 * \`onSemantic\` is the flipping ink — the kit's \`--on-hue\` — in a role of its
 * own so no accent decision can reach it. 6.61:1 on the dark coral, 6.07:1
 * (white) on the light theme's red.
 *
 * Focus taking the destructive fill was its own defect: tabbing THROUGH a list
 * of saved options armed each delete in turn, which is a promise the key press
 * does not keep. An accent ring says "focused" and leaves "about to destroy
 * this" to the pointer that is actually on it.
 */
@media (hover: hover) and (pointer: fine) {
  .de-option-delete:hover { background: ${t.color.dangerWash}; color: ${t.color.danger}; }
}

/* ---------- scoped styles, inside a design section ---------- */
/* The header strip when a section carries both the styles toggle and a \`+\`:
   \`section()\` takes one actions element, so the pair shares this wrapper. Same
   gap as \`.de-section-actions\` so the two 24px hit pads do not overlap. */
.de-style-actions { display: inline-flex; align-items: center; gap: ${t.space.sm}px; }
/* The toggle is accent-inked while the element matches a style, so a closed
   section still says a style is in play from its header. */
.de-style-toggle--applied { color: ${t.color.accent}; }
/* The open panel HOLDS the toggle's hover paint, so it reads as "this one". */
.de-style-toggle[aria-expanded="true"] { background: ${t.color.bgHover}; color: ${t.color.text}; }
.de-style-block { display: flex; flex-direction: column; gap: ${t.space["2xs"]}px; }
.de-style-block[hidden],
.de-style-panel[hidden],
.de-style-applied[hidden] { display: none; }
/* The applied style, always visible while the panel is shut: the glyph and the
   name, with the kind trailing in the secondary ink. */
.de-style-applied {
  display: flex; align-items: center; gap: ${t.space.sm}px;
  height: ${t.size.rowHeight}px; padding: 0 ${t.space["2xs"]}px;
  border-radius: ${t.radius.sm};
  background: ${t.color.bgSunken}; color: ${t.color.text};
}
.de-style-applied > svg,
.de-option > svg { flex: none; color: ${t.color.textDim}; }
.de-style-applied-kind { flex: none; color: ${t.color.textDim}; font-size: ${t.type.body}; }
.de-style-panel {
  display: flex; flex-direction: column; gap: ${t.space["2xs"]}px;
  padding-bottom: ${t.space.sm}px;
  border-bottom: 1px solid ${t.color.border};
}
.de-style-list { display: flex; flex-direction: column; }
.de-style-empty {
  margin: 0; color: ${t.color.textDim};
  font-size: ${t.type.body}; line-height: ${t.type.leadingRow};
}
/* Update is \`aria-disabled\` while the style already matches: reachable and
   announced, drawn as unavailable, with no hover promising a press. */
.de-option-rename[aria-disabled="true"],
.de-option-rename[aria-disabled="true"]:hover {
  background: transparent; color: ${t.color.textDisabled}; cursor: default;
}

/* ---------- the left panel's Controls pane ---------- */
/*
 * What used to be here was a 460px \`position: fixed\` window — a root, a
 * shell, a header, a title, a close button and a two-button pseudo-tab strip,
 * some seventy lines — pinned to the bottom-left of the canvas with a
 * \`z-index\` in the two-billions. All of it is gone, and none of it was
 * replaced: a pane inside \`.de-tabpanel\` is docked, so it has no position to
 * compute, no shadow to lift it off a page it should never have been over, no
 * corner to be dismissed from, and no strip of its own because the panel it
 * lives in already has one.
 *
 * The pane fills the tabpanel and scrolls as a whole, like the Layers tree
 * beside it. It carried \`.de-opt-scroll\` — flex, min-height, its own
 * \`overflow-y\` and its own scrollbar skin — which was the window's way of
 * keeping a fixed header over a scrolling list. \`.de-tabpanel\` already does
 * every part of that, so the rule was a second answer to a solved question and
 * a second scrollbar to keep looking like the first.
 */
.de-controls { display: flex; flex-direction: column; }

/*
 * The scope switch, under the filter and above the tree.
 *
 * It reuses \`.de-opt-chips\` and \`.de-opt-chip\` rather than growing a
 * treatment of its own: the choice chips inside a select control's row are the
 * same gesture — pick exactly one of these — and two drawings for one gesture
 * inside one pane is two things for the reader to learn. The side padding
 * matches \`.de-opt-filter\`'s margin so the chips start on the column the
 * field above them starts on.
 */
.de-opt-scope {
  flex: none;
  display: flex; flex-direction: column; gap: ${t.space["2xs"]}px;
  padding: 0 ${t.space.sm}px ${t.space.sm}px;
}
/* Both are hidden whenever they could do nothing (\`controlsTab\`), and the
   \`display\` above would otherwise beat the attribute's UA \`display: none\`. */
.de-opt-scope[hidden], .de-opt-filter[hidden] { display: none; }
/*
 * The unavailable chip is \`aria-disabled\`, never \`disabled\`, so it keeps its
 * place in the tab order and its reason stays reachable — see the comment in
 * \`panels/controls.ts\`. It therefore has to LOOK unavailable without the UA
 * styling that comes free with the attribute nobody may use here.
 *
 * \`textDisabled\` is the rung the token set ships for exactly this, and the
 * cursor is the default arrow rather than \`not-allowed\`: the chip is still
 * focusable and still announced, so a slashed circle would overstate how dead
 * it is. Hover does nothing, because nothing is going to happen.
 */
.de-opt-chip[aria-disabled="true"] {
  color: ${t.color.textDisabled};
  border-color: ${t.color.border};
  cursor: default;
}
.de-opt-chip[aria-disabled="true"]:hover {
  background: ${t.color.bgRaised};
  color: ${t.color.textDisabled};
}
/* The reason a control is unavailable, in visible text beside it rather than in
   a tooltip that control can never open. Shared by the scope chip here and by
   the Saved styles verbs in the right panel, because it is one answer to one
   problem: \`aria-disabled\` keeps a button reachable and says nothing about
   why. \`textDim\` is the secondary rung — it is an explanation
   of a control, not a control. */
.de-opt-reason {
  margin: 0;
  color: ${t.color.textDim};
  font-size: ${t.type.body}; line-height: ${t.type.leadingRow};
}
.de-opt-reason[hidden] { display: none; }

/* The headline of an empty state, above its sentence. \`.de-empty\` is centred
   dim prose; this is the one line in it that has to read as a statement of what
   is going on, so it takes the text rung and the section weight. */
.de-empty-title {
  margin-bottom: ${t.space["2xs"]}px;
  color: ${t.color.text};
  font-weight: ${t.type.weightSection};
}

/*
 * \`borderInteractive\`, which is the rung tokens.ts ships for the boundary of a
 * control you can act on, and not \`border\`, which is the rung it ships for a
 * divider between two things you cannot.
 *
 * \`border\` measures 1.32:1 dark and 1.18:1 light against the panel — under
 * the 3:1 WCAG 1.4.11 asks of a control's own boundary, and visibly so: the
 * filter, the number input and the token field would read as text floating on
 * the surface rather than as places to type. \`borderInteractive\` is 3.23:1
 * dark and 3.36:1 light on the panel, and still clears 3:1 on the field well.
 */
.de-opt-filter {
  margin: ${t.space.sm}px; padding: 0 ${t.space.sm}px;
  height: ${t.size.rowHeight}px;
  border: 1px solid ${t.color.borderInteractive}; border-radius: ${CONTROL_RADIUS};
  background: ${t.color.field}; color: ${t.color.text};
  font-family: inherit; font-size: ${t.type.body};
  outline: none;
  transition: background-color ${t.duration.hover} ${t.ease}, border-color ${t.duration.hover} ${t.ease};
}
/* The kit's field: the well lifts one rung under the pointer, and keyboard
   focus is the border taking the accent. \`CONTROL_RADIUS\` is \`radius.sm\`, the
   dense-row adaptation — a 16px card corner on a 24px field would be a pill. */
@media (hover: hover) and (pointer: fine) {
  .de-opt-filter:hover { background: ${t.color.fieldHover}; }
}
.de-opt-filter:focus-visible { border-color: ${t.color.accent}; }
/*
 * The clear button is the user agent's drawing, and it is now TOLD which theme
 * it is in rather than being inverted after the fact.
 *
 * \`filter: invert(1)\` was unconditional: it turned Chrome's dark ✕ white, which
 * is right on the dark chrome and wrong on paper, where it produced a white
 * glyph on a white field. \`css/base.ts\` declares \`color-scheme\` per theme on
 * \`[data-designlayer]\` now, so the agent draws the correct ✕ for the theme
 * that is actually up and this correction has nothing left to correct. Only the
 * opacity stays — that is a decision about prominence, not about colour.
 */
.de-opt-filter::-webkit-search-cancel-button { opacity: 0.5; }

/* The trailing gutter is a rung above the sides on purpose — it was 10 against
   8 — so rounding it down to match them would close the only air under the last
   row of a scroller. */
.de-opt-body { display: flex; flex-direction: column; padding: 0 ${t.space.sm}px ${t.space.md}px; }

/* The folder's rule is drawn by its summary, so it bleeds with the band below. */
/* \`sectionHeader\`: a fold target, and the token exists because a fold target
   wants to be taller than the rows it folds. 28 was neither that nor a row. */
/*
 * FULL BLEED, like \`.de-section-header\`. The summary sits inside \`.de-opt-body\`'s
 * side padding and, nested, inside each folder body's leading indent, so its
 * hover band stopped short of both panel edges. The margins pull the box back
 * out by exactly that inset and the padding puts the text back where it was.
 */
.de-opt-summary {
  --de-opt-inset: calc(${t.space.sm}px + var(--de-opt-depth, 0) * ${t.space.lg}px);
  display: flex; align-items: center; gap: ${t.space.sm}px;
  /* content-box so the rule sits on top of the 32px band rather than inside it. */
  box-sizing: content-box;
  height: ${t.size.sectionHeader}px;
  border-top: 1px solid ${t.color.border};
  margin: 0 -${t.space.sm}px 0 calc(-1 * var(--de-opt-inset));
  padding: 0 ${t.space.sm + t.space["2xs"]}px 0 calc(var(--de-opt-inset) + ${t.space["2xs"]}px);
  cursor: pointer; list-style: none;
  font-size: ${t.type.body}; font-weight: ${t.type.weightSection};
  transition: background-color ${t.duration.hover} ${t.ease}, box-shadow ${t.duration.hover} ${t.ease};
}
/* Inside the band, because the band is full-bleed and an outward halo would be
   drawn off the panel. */
.de-opt-summary:focus-visible { outline: none; box-shadow: ${FOCUS_RING_INSET}; }
.de-opt-summary::-webkit-details-marker { display: none; }
/* A real glyph from the vendored set rather than a \`content\` character, so the
   disclosure marks in this panel, the inspector and the layer tree are one
   drawing at one weight instead of three fonts' idea of a triangle. */
.de-opt-twisty {
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  color: ${t.color.textDim};
  transition: transform ${t.duration.hover} ${t.ease};
}
.de-opt-folder[open] > .de-opt-summary > .de-opt-twisty { transform: rotate(90deg); }
/* A full-bleed band, so the quiet rung — see the hover rule in panels.ts. */
@media (hover: hover) and (pointer: fine) {
  .de-opt-summary:hover { background: ${t.color.bgHoverQuiet}; }
}
/* Shrinkable, with an ellipsis, and it takes the free width so a "default"
   tag, where there is one, sits at the end of the header. */
.de-opt-folder-name {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 16 rather than 14: one indent step, the same one the layer tree uses, and on
   the step set. 14 was a number that happened to look about right. */
/*
 * THE FOLDER OPENS, where its caret used to open alone.
 *
 * The fourth of four disclosures in this chrome built the same way: a mark that
 * animates over a body that does not. A native \`<details>\` is the hardest of
 * the four because the element does its own showing — the body is simply not
 * rendered while the parent is shut, so there is nothing to transition from.
 *
 * WHAT THIS ACHIEVES AND WHAT IT DOES NOT — measured, because the honest answer
 * is "most of the way".
 *
 * The same \`0fr -> 1fr\` the other three folds use, read off the native
 * attribute rather than tracked in parallel. Shut, the body measures 0. Opened,
 * Chrome renders it and resolves the new row in ONE recalculation, so there is
 * no clean starting value for the \`fr\` to interpolate from: the first frame
 * lands at 77.6 of an eventual 110.4px and only the remaining 30% eases in.
 *
 * That is a real improvement on the hard cut it replaces and it is not the full
 * fold the other three get. Closing it properly means driving the height from
 * JS on a frame boundary, the way \`core/leave.ts\`'s \`revealGroup\` does — which
 * needs a hand in the TypeScript that owns this element, and that file is not
 * this sheet's to edit. Left here deliberately, with the number, so the next
 * person can see the gap rather than assume it was never looked at.
 *
 * \`minmax(0, Xfr)\` for the reason the "Why?" fold gives: a bare \`0fr\` is
 * \`minmax(auto, 0fr)\`, whose automatic minimum is the padded box, so a shut
 * folder would keep a band of itself and animate from that band.
 */
.de-opt-folder > /*
 * The gap BETWEEN rows stays twice the gap inside one: rows sit edge to edge
 * and each brings 4px of padding, so two rows are 8px apart where a row's own
 * label and control are 4px apart. See \`.de-opt-row\`.
 */
.de-opt-folder-body {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  transition: grid-template-rows ${t.duration.reveal} ${t.easeReveal};
}
.de-opt-folder[open] > .de-opt-folder-body {
  grid-template-rows: minmax(0, 1fr);
}
/* No gap: the rows carry their own padding, which is what keeps the pitch even
   (see \`.de-opt-row\`). The bottom padding is the air before the next heading. */
.de-opt-folder-body {
  padding: 0 0 ${t.space.sm}px ${t.space.lg}px;
  display: flex; flex-direction: column; gap: 0;
}
/* The inner track is what actually clips while the row closes. */
.de-opt-folder > .de-opt-folder-body > * { min-height: 0; }
/*
 * ONE COLUMN, AS WIDE AS THE PANEL AND NO WIDER.
 *
 * The body is the grid above (the selector with the \`>\` outranks the plain
 * \`display: flex\` rule), and a grid with no column template sizes its implicit
 * \`auto\` column to its widest item's min-content. A long option label, which
 * never wraps, then widened the column past the panel and pushed every
 * switch, field and swatch off the right edge. \`minmax(0, 1fr)\` pins the
 * column to the body's width, so the label truncates instead.
 */
.de-opt-folder > .de-opt-folder-body { grid-template-columns: minmax(0, 1fr); }
/*
 * There is no inline copy of this tree any more, so there is no cap on one.
 *
 * \`.de-opt-folder--inline\` capped a folder body at 260px with its own
 * scrollbar, and it existed for one reason: the inspector used to render this
 * same row inline, and relevance counts a control whose selector matches
 * anything INSIDE the selected element — so picking a container bound most of
 * the app's inventory and pushed Appearance thousands of pixels down a panel
 * scoped to one element. The cap treated the symptom. Moving the app-scoped
 * tree to a pane of its own removed the cause, and a nested scroller inside a
 * scrolling pane was never a thing anyone wanted to operate.
 */

/*
 * ONE ROW IS A LABEL AND THE CONTROL THAT SETS IT, the way a leva panel reads,
 * and the rows are a LIST: one pitch, full-width bands, one text axis.
 *
 * Measured before this: 32px rows 8px apart (a 40px pitch), the first row flush
 * under its heading while the rest floated, and every label 4px left of the
 * heading text above it. Now a one-line row is \`rowHeight\` inside the tight
 * step of padding — 32px, no gap — so the options read as one list at one
 * rhythm. A row that takes a second line (chips, a slider, free text) keeps
 * 4px between its two lines and 8px to its neighbours, twice the inner gap,
 * so the control still reads as belonging to the label above it.
 *
 * The band bleeds to both panel edges, as the folder heading's does, and the
 * padding puts the label on the heading's text axis (the heading's inset, its
 * caret and the gap after it) and the control's right edge on the heading's
 * right inset. \`--de-opt-depth\` is inherited from the folder (\`folderNode\`),
 * so the same arithmetic holds at every nesting level.
 */
.de-opt-row {
  display: flex; flex-direction: column; gap: ${t.space["2xs"]}px;
  margin: 0 -${t.space.sm}px 0 calc(-${t.space.sm + t.space.lg}px - var(--de-opt-depth, 0) * ${t.space.lg}px);
  padding: ${t.space["2xs"]}px ${t.space.sm + t.space["2xs"]}px ${t.space["2xs"]}px
    calc(${t.space.sm + t.space["2xs"] + t.icon.marker + t.space.sm}px + var(--de-opt-depth, 0) * ${t.space.lg}px);
  transition: background-color ${t.duration.hover} ${t.ease};
}
/* A full-bleed band, so the quiet rung, the same one the folder heading takes. */
@media (hover: hover) and (pointer: fine) {
  .de-opt-row:hover { background: ${t.color.bgHoverQuiet}; }
}
/*
 * A hidden row says so with INK, not opacity: a fade compounds with ink that is
 * already quiet, while \`textDisabled\` holds 4.5:1 on every ground.
 */
.de-opt-row[data-hidden] :is(.de-opt-label, .de-opt-value) {
  color: ${t.color.textDisabled};
}
.de-opt-line {
  display: flex; align-items: center; gap: ${t.space.sm}px;
  min-height: ${t.size.rowHeight}px;
}
/* A switch row is one target end to end — see \`controlRow\`. */
.de-opt-row[data-kind="switch"] > .de-opt-line { cursor: pointer; }
.de-opt-label {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: ${t.color.text}; font-size: ${t.type.body};
}
/* A read-only value: the row's output, so the secondary ink, and selectable. */
.de-opt-value {
  flex: 0 1 auto; min-width: 0; max-width: 60%;
  display: inline-flex; align-items: center; gap: ${t.space["2xs"]}px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: ${t.color.textMuted}; font-family: ${t.font.mono}; font-size: ${t.type.body};
}
/*
 * A painted color — beside a chip's name, a read-only value or a color field.
 * The inset ring is what tells a white swatch on a white panel from no swatch
 * at all; the same ring and rung the DS lint swatch uses at this size.
 */
.de-opt-swatch {
  flex: none;
  width: ${t.icon.marker}px; height: ${t.icon.marker}px;
  border-radius: ${t.radius.xs};
  box-shadow: inset 0 0 0 1px ${t.color.borderStrong};
}
/* Row height and the interactive boundary, so it lines up with the filter above
   it instead of sitting 4px shorter in the same column of controls. */
.de-opt-input {
  height: ${t.size.rowHeight}px; padding: 0 ${t.space["2xs"]}px;
  border: 1px solid ${t.color.borderInteractive}; border-radius: ${CONTROL_RADIUS};
  background: ${t.color.field}; color: ${t.color.text};
  font-family: ${t.font.mono}; font-size: ${t.type.body};
  outline: none;
  transition: background-color ${t.duration.hover} ${t.ease}, border-color ${t.duration.hover} ${t.ease};
}
/* Same field as the filter: its corner, its hover well and its focus border. */
@media (hover: hover) and (pointer: fine) {
  .de-opt-input:hover { background: ${t.color.fieldHover}; }
}
.de-opt-input:focus-visible { border-color: ${t.color.accent}; }
/* A number is short and right-aligned, so its digits sit in a column down the
   list. 56px holds six digits and a point at body size; it is a drawing size,
   not a step on the spacing scale. */
.de-opt-input--number { flex: none; width: 56px; text-align: right; }
.de-opt-input--color { flex: 0 1 auto; min-width: 0; width: 84px; }
.de-opt-input--text { width: 100%; font-family: inherit; }
.de-opt-row > .de-select-shell { width: 100%; }
.de-opt-color-field {
  flex: 0 1 auto; min-width: 0;
  display: inline-flex; align-items: center; gap: ${t.space["2xs"]}px;
}

/*
 * The native color input, drawn as the swatch it opens. The UA's own button
 * frame and inner padding are stripped so what is left is the color, with the
 * same ring as \`.de-opt-swatch\` and the chrome's focus ring.
 */
.de-opt-color {
  flex: none;
  width: ${t.space.lg + t.space["2xs"]}px; height: ${t.space.lg + t.space["2xs"]}px;
  padding: 0; border: none; border-radius: ${t.radius.xs};
  background: transparent; cursor: pointer;
}
.de-opt-color::-webkit-color-swatch-wrapper { padding: 0; }
.de-opt-color::-webkit-color-swatch {
  border: none; border-radius: ${t.radius.xs};
  box-shadow: inset 0 0 0 1px ${t.color.borderStrong};
}
.de-opt-color::-moz-color-swatch { border: none; border-radius: ${t.radius.xs}; }
.de-opt-color:focus-visible { outline: none; box-shadow: ${FOCUS_RING}; }
.de-opt-color:disabled { cursor: default; }

/*
 * THE SLIDER, for a number the host gave both bounds.
 *
 * The UA's range is restyled rather than replaced: it keeps the keyboard, the
 * pointer capture and the accessibility role for free. The track is the
 * \`borderInteractive\` rung — the boundary a control owes 3:1 — and the part
 * up to the value is the accent, painted from \`--de-fill\`, which
 * \`numberControl\` writes on every input. The thumb is a 12px knob in the
 * text ink, the same knob the switch draws.
 */
.de-opt-slider {
  -webkit-appearance: none; appearance: none;
  display: block; width: 100%; height: ${t.space.lg}px; margin: 0;
  background: transparent; cursor: pointer;
}
.de-opt-slider::-webkit-slider-runnable-track {
  height: ${t.space["2xs"]}px;
  background: linear-gradient(to right, ${t.color.accent} var(--de-fill, 0%), ${t.color.borderInteractive} var(--de-fill, 0%));
}
.de-opt-slider::-moz-range-track { height: ${t.space["2xs"]}px; background: ${t.color.borderInteractive}; }
.de-opt-slider::-moz-range-progress { height: ${t.space["2xs"]}px; background: ${t.color.accent}; }
/*
 * The knob opts out of the squircle on its own rule rather than in
 * \`css/base.ts\`'s list: a \`-webkit-\` and a \`-moz-\` pseudo in one selector
 * list would make each engine drop the whole list, every other circle with it.
 */
.de-opt-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: ${t.icon.marker}px; height: ${t.icon.marker}px;
  margin-top: -${(t.icon.marker - t.space["2xs"]) / 2}px;
  border: none; border-radius: 50%; corner-shape: round;
  background: ${t.color.text};
  transition: box-shadow ${t.duration.hover} ${t.ease};
}
.de-opt-slider::-moz-range-thumb {
  width: ${t.icon.marker}px; height: ${t.icon.marker}px;
  border: none; border-radius: 50%; corner-shape: round;
  background: ${t.color.text};
}
.de-opt-slider:focus-visible { outline: none; }
.de-opt-slider:focus-visible::-webkit-slider-thumb { box-shadow: ${FOCUS_RING}; }
.de-opt-slider:focus-visible::-moz-range-thumb { box-shadow: ${FOCUS_RING}; }
.de-opt-slider:disabled { cursor: default; }
.de-opt-slider:disabled::-webkit-slider-thumb { background: ${t.color.textDisabled}; }
.de-opt-slider:disabled::-moz-range-thumb { background: ${t.color.textDisabled}; }

/* The variant list is the answer to "what options do we have?" — always shown. */
.de-opt-chips { display: flex; flex-wrap: wrap; gap: ${t.space["2xs"]}px; }
/*
 * \`borderInteractive\`, for the reason \`.de-opt-filter\` gives, and here it is
 * the whole edge: the chip's \`bgRaised\` fill is 1.42:1 off the dark panel and
 * white on white in light, so the hairline is the only thing saying where the
 * button stops. Padding is \`3xs\`/\`sm\` rather than the 1/7 it was, the two
 * nearest steps on the set.
 */
.de-opt-chip {
  display: inline-flex; align-items: center; gap: ${t.space["2xs"]}px;
  padding: ${t.space["3xs"]}px ${t.space.sm}px;
  border: 1px solid ${t.color.borderInteractive}; border-radius: ${t.radius["3xl"]};
  background: ${t.color.bgRaised}; color: ${t.color.textMuted};
  font-family: inherit; font-size: ${t.type.body}; cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, color ${t.duration.hover} ${t.ease},
    border-color ${t.duration.hover} ${t.ease}, box-shadow ${t.duration.hover} ${t.ease},
    transform ${t.duration.hover} ${t.ease};
}
/* The chip rests on \`bgRaised\`, so it lifts to \`bgRaisedHover\`. \`bgHover\` is
   no lift over the card — equal to it in dark, a rung below it in light — so
   pointing at a chip would do nothing or darken it. */
@media (hover: hover) and (pointer: fine) {
  .de-opt-chip:hover { background: ${t.color.bgRaisedHover}; color: ${t.color.text}; }
}
.de-opt-chip:active:not([aria-disabled="true"]) { transform: scale(0.98); }
/*
 * Two attributes, one treatment, and they are not interchangeable upstream.
 *
 * A choice chip inside a control row is \`aria-pressed\` — it is a toggle that
 * writes a value. The scope chips are \`role="radio"\` with \`aria-checked\`,
 * because picking one of two mutually exclusive views is the radio pattern and
 * a pair of independent toggles would let a reader press both. The DRAWING is
 * the same on purpose: both answer "which one of these is taken", and a reader
 * should not have to learn that this product tints a chosen chip two ways.
 */
.de-opt-chip[aria-pressed="true"],
.de-opt-chip[aria-checked="true"] {
  ${accentFillText} border-color: ${t.color.accent};
}
.de-opt-chip:focus-visible { outline: none; box-shadow: ${FOCUS_RING}; }

.de-opt-actions { display: flex; flex-wrap: wrap; gap: ${t.space["2xs"]}px; padding-top: ${t.space["3xs"]}px; }
/*
 * A verb that cannot run, drawn as one, without the attribute that would hide
 * its own explanation.
 *
 * \`aria-disabled\` says it to the accessibility tree and nothing at all to the
 * eye, so a sighted reader would see three identical live buttons and press one
 * that silently declined. This is \`.de-button[disabled]\`'s treatment, restated
 * for the attribute that leaves the control reachable: ink to \`textDisabled\`,
 * fill unchanged, no \`opacity\` — for the reason \`toolbar.ts\` gives, that
 * fading both together is what let the pair drift under the floor to begin
 * with, and it would fade the focus ring off a control that can still be
 * focused. Hover is cancelled too, because a lift is a promise of a press.
 */
.de-opt-actions .de-button[aria-disabled="true"],
.de-opt-actions .de-button[aria-disabled="true"]:hover {
  cursor: default;
  background: ${t.color.bgRaised};
  color: ${t.color.textDisabled};
}
/* \`.de-opt-row--variant\` was here: a bordered card around one saved style in
   the deleted window's second tab. Saved styles are \`.de-option-row\` in the
   right panel and have been for as long as the two lists disagreed about which
   verbs they offered; the modifier only ever dressed the duplicate. */


`
