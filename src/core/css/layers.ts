/** Layers tree rows. */

import { tokens as t, nest } from "../tokens"
import { CONTROL_RADIUS, FOCUS_INSET } from "./panels"

/**
 * One indent step, in px, shared with the panel that builds the rows.
 *
 * It lives here because the stylesheet is the other half of the measurement:
 * the row sets its own `padding-left` from this, and the indent guides are a
 * gradient that has to repeat on exactly the same pitch or the rule drifts off
 * the level it marks. Two numbers that must agree is one number.
 */
export const LAYER_INDENT = 16

/**
 * The context menu's corner and its rows' corner, from one inset: the kit's
 * menu geometry (MICRO-INTERACTIONS § 6) — a 16px card, 6px of padding, and
 * 16 − 6 = 10px item corners. The 6 counts the hairline, so the rule pads 5.
 */
const MENU = nest({ of: ".de-layer-menu", outer: t.radius["3xl"], inset: t.space.xs, hairline: 1 })

export const layersCss = `/* ---------- layers ---------- */
/*
 * The filter box above the tree: the kit's field (\`.ui-field\`) at editor
 * density. Filled and borderless at rest — the border appears only to say
 * "focused" — on \`field\`, the kit's control well, with \`fieldHover\` under a
 * fine pointer. A 24px field takes \`CONTROL_RADIUS\` (\`radius.sm\`) rather than
 * the kit's 16px field corner, which on a box this short is a pill; see the
 * note on that constant in \`css/panels.ts\`.
 */
.de-layer-filter {
  /* The row rung, named rather than a literal that happens to equal it. */
  width: 100%; height: ${t.size.rowHeight}px;
  /* Horizontal only. \`space.sm\` on all four sides left a 24px border-box with
     a 6px content box for an 18px line, so the text was clipped top and bottom
     by its own padding; the box already centres the line. */
  padding: 0 ${t.space.sm}px;
  border: 1px solid transparent; border-radius: ${CONTROL_RADIUS};
  background: ${t.color.field}; color: ${t.color.text};
  font-family: inherit; font-size: ${t.type.body}; line-height: ${t.type.leadingRow};
  outline: none;
  transition:
    background-color ${t.duration.hover} ${t.ease},
    border-color ${t.duration.hover} ${t.ease};
}
.de-layer-filter::placeholder { color: ${t.color.textDim}; }
@media (hover: hover) and (pointer: fine) {
  .de-layer-filter:hover { background: ${t.color.fieldHover}; }
}
.de-layer-filter:focus-visible { border-color: ${t.color.accent}; }
/*
 * The tree is the focus root for the selected band below, so it — and not the
 * whole left slot — is what :focus-within is asked about. The horizontal inset
 * is what lets a rounded row read as a band with edges, not a full-bleed stripe.
 */
.de-layers-tree { position: relative; padding: 0 ${t.space["2xs"]}px ${t.space.sm}px; }
.de-layer {
  position: relative;
  display: flex; align-items: center; gap: ${t.space["2xs"]}px;
  height: ${t.size.rowHeight}px;
  padding-right: ${t.space.sm}px;
  /* \`radius.sm\`: the kit's 12px row highlight is a pill on a 24px row. */
  border-radius: ${t.radius.sm};
  /* Rows read in the body ink, as the kit's list rows do; hierarchy comes from
     the type marks and the component hue, not from greying every name. */
  color: ${t.color.text};
  cursor: pointer;
  white-space: nowrap;
  /*
   * This was \`transition: none; animation: none\` with no comment — the one
   * suppression in the chrome that never said why, and the reason it did not is
   * that it was borrowed from a surface it belongs to. Canvas chrome is instant
   * because \`selection.ts\` rewrites its geometry every frame and a transition
   * would make the outline trail the element (see \`css/canvas.ts\`). A row in a
   * scrolling panel has no frame loop and no geometry to trail. The blanket was
   * silencing four unrelated changes — hover, select, tree focus, hidden — on
   * an argument that only ever applied somewhere else.
   *
   * \`hover\` is the kit's tween for precisely this: a tint on a high-frequency
   * control, registered without being watched. \`animation: none\`
   * goes with it; there was never an animation here to suppress.
   */
  transition: background-color ${t.duration.hover} ${t.ease}, color ${t.duration.hover} ${t.ease};
}
/*
 * Indent guides: one hairline per level the row sits under, drawn as a single
 * repeating gradient clipped to the row's own indent width. A rule per level
 * as real elements would triple the node count of a deep tree for decoration
 * that never takes a pointer — and this tree is diffed on every selection.
 *
 * \`border\` and not \`borderStrong\`: 1.32:1 on the dark ground and 1.18:1 on
 * paper. It is decoration, so no floor applies, and five of these down a deep
 * row is exactly the place where a louder rule becomes noise.
 */
.de-layer::before {
  content: ""; position: absolute; left: 8px; top: 0; bottom: 0;
  width: var(--de-indent, 0px);
  background-image: repeating-linear-gradient(
    to right,
    ${t.color.border} 0 ${t.size.hairline}px,
    transparent ${t.size.hairline}px ${LAYER_INDENT}px
  );
  pointer-events: none;
}
/*
 * The row ladder. Hover is the kit's row hover — \`bgHoverQuiet\`, a percentage
 * lift in dark so it keeps its step whenever the ground moves, \`--muted\` in
 * light — and not the louder \`bgHover\`, which is the inset-ghost rung. Off the
 * panel ground, dark / light:
 *
 *   hover              \`bgHoverQuiet\`      1.32:1   1.05:1
 *   resting selection  \`rowSelectedMuted\`  1.16:1   1.07:1
 *   focused selection  \`rowSelected\`       1.33:1   1.13:1
 *
 * A row you are merely pointing at must not read as the row that is actually
 * selected. In value alone it can, in dark — hover sits above the resting
 * selection — so the separation is HUE: both selection rungs are indigo and
 * hover is neutral, which is the kit's rule that a grey can only say
 * "recessed" and never "this one". \`bgHover\` (1.42:1 dark) would push the most
 * transient state past both.
 */
@media (hover: hover) and (pointer: fine) {
  .de-layer:hover { background-color: ${t.color.bgHoverQuiet}; }
}
/*
 * A selected row is a SOLID band, not the canvas's 18% wash: the panel is the
 * one place a selection has to stay findable while the pointer is elsewhere.
 * Muted is that band with focus outside the tree — still the row you left, no
 * longer competing with whatever now has the caret.
 *
 * The band is the same value as the container behind a chosen icon button:
 * \`rowSelected\` equals \`accentSoft\` — the kit's \`--unseen\` indigo tint
 * \`#ebf1ff\` in light, the indigo fill at 28% over the ground in dark. One hue
 * for "this is the thing" everywhere in the chrome. The muted band is the same
 * tint at roughly half strength.
 *
 * The band is separated from the ground by hue far more than by value, so the
 * ink on top is what has to be unambiguous, and it is: \`text\` on the focused
 * band is 12.9:1 dark and 16.9:1 light, and more on the muted one. The focus
 * ring stays legible on both, at 3.5:1 dark and 5.9:1 light at worst — a ring
 * is a non-text component, so 3:1 is its floor.
 */
.de-layer[aria-selected="true"] { background-color: ${t.color.rowSelectedMuted}; color: ${t.color.text}; }
.de-layers-tree:focus-within .de-layer[aria-selected="true"] { background-color: ${t.color.rowSelected}; }
.de-layer:focus-visible { ${FOCUS_INSET} }
.de-layer-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; }
.de-layer--component .de-layer-name { color: ${t.color.component}; font-weight: ${t.type.weightValue}; }
.de-layer[aria-selected="true"] .de-layer-name { color: ${t.color.text}; }
/*
 * 16 wide and the full height of the row, where it was a 14px square.
 *
 * 14 is not a step on the kit's spacing scale, and it made the one control
 * that opens a subtree a 14x14 target, the smallest hit area in the chrome. The glyph inside is still \`icon.marker\`; only the box grows. Stretching
 * to the row rather than setting a height is what gets the target to 24px tall:
 * the row IS 24, so there is nothing else to take.
 *
 * 16x24 and not 24x24 because the horizontal budget belongs to the name. This
 * tree indents 16px a level and shows five levels in a 240px panel; three more
 * pixels per row of twisty is three fewer characters of the thing you are
 * looking for.
 */
.de-layer-twisty {
  width: ${t.icon.action}px; align-self: stretch; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; background: transparent; color: inherit; cursor: pointer;
}
/* The same quarter turn the inspector's chevron takes, and now at the same
   duration. \`.de-lib-twisty\` and \`.de-opt-twisty\` already had it; this was the
   third copy of one idea and the only one that snapped. */
.de-layer-twisty { transition: transform ${t.duration.hover} ${t.ease}; }
.de-layer-twisty[aria-expanded="true"] { transform: rotate(90deg); }
/*
 * The type mark. Dim by default so a column of them reads as texture; only the
 * component diamond takes a colour, and it keeps it through selection — the
 * distinction it draws is what the row is, which selection does not change.
 */
.de-layer-icon {
  width: ${t.icon.marker}px; height: ${t.icon.marker}px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  color: ${t.color.textDim};
}
.de-layer--component .de-layer-icon { color: ${t.color.component}; }
/*
 * A hidden element still has a row; it just stops competing for the eye.
 *
 * It must not stop competing too well: the name still owes 4.5:1, on rows
 * whose whole point is that you can still find the thing you hid and put it
 * back.
 *
 * 0.85, because the binding case is not the plain row. \`opacity\` multiplies
 * whatever ink the cascade gave the name, and a hidden COMPONENT row is already
 * carrying the tightest ink in the tree, so it is the combination that sets the
 * floor. Worst ground for each, at 0.85:
 *
 *   plain name, hovered row      dark 9.8:1   light 12.1:1
 *   component name, hovered row  dark 4.7:1   light 4.5:1
 *
 * 0.8 is the near miss: fine for a plain name, and 4.31:1 dark / 4.06:1 light
 * for a component one.
 *
 * The dim that leaves is shallow — a plain name goes from 17.2:1 to 12.6:1 on
 * the panel — and that is the honest trade. A deeper fade is available only by waiving the floor for
 * the one row the user most needs to read back. The crossed-out eye in the
 * strip, which a hidden row pins open, carries the rest of the message.
 */
.de-layer--hidden .de-layer-name { opacity: 0.85; }
/*
 * The lock and the eye.
 *
 * The strip is always laid out and only ever changes OPACITY — revealing it by
 * mounting it would reflow the name mid-hover, which is exactly the jitter that
 * makes a row feel unclickable. It stays up on a row whose state is not the
 * default, because a lock nobody can see is a lock nobody can undo.
 */
/*
 * How many saved styles a row has, when it has any.
 *
 * The one cross-element view of saved styles there is, and it is the only thing
 * this tree takes from the options subsystem. The floating browser used to
 * carry that view; it went with the window, and this is where it came back —
 * better placed, because a row here already IS the element, so pressing it
 * selects the thing whose styles the right panel then offers to apply.
 *
 * \`:empty\` rather than a modifier class, so the row that has nothing to say
 * costs one empty span and no attribute writes.
 *
 * It is NOT held in layout when empty, and that is the opposite of what the
 * action strip below does. The strip is always laid out and only fades, because
 * it appears on HOVER — reserving its width is what stops the name jumping
 * under a pointer that is merely passing over. This badge appears when a style
 * is saved, which is a deliberate action on this row and nowhere near the
 * pointer, and it is absent on almost every row of a normal tree. Reserving
 * 18px plus a gap on hundreds of rows to spare one row a shift it earned is the
 * wrong trade in a 240px panel, so the badge takes the space only when it has
 * something to say.
 *
 * Not the accent. The accent in this tree means SELECTED — it is the row fill,
 * the outline on the canvas and the ink on the current app in the chooser — and
 * a second accent-coloured thing on the same row would be two meanings on one
 * colour. \`bgSunken\` under \`textMuted\` reads as a quiet tally, which is what it
 * is: a fact about the row, not a state of it.
 */
.de-layer-saved {
  flex: none;
  min-width: ${t.size.miniSize}px;
  padding: 0 ${t.space["3xs"]}px;
  border-radius: ${t.radius.xs};
  background: ${t.color.bgSunken};
  color: ${t.color.textMuted};
  /* The kit's badge role: a count is a mark, 10px medium. */
  font-size: ${t.type.micro};
  font-weight: ${t.type.weightValue};
  line-height: ${t.size.miniSize}px;
  text-align: center;
}
.de-layer-saved:empty { display: none; }
/*
 * REVEAL-ON-HOVER ROW ACTIONS (MICRO-INTERACTIONS § 4).
 *
 * The cluster keeps its space while hidden, so revealing it moves nothing, and
 * it is inert while hidden so an invisible bin cannot take a click. It reveals
 * on row hover under a fine pointer, on keyboard focus in the row or the
 * cluster, while the row is being dragged, and permanently on a coarse
 * pointer, where there is no hover to find it with.
 *
 * Two states hold it lit, the kit's \`data-persistent\` case: a locked or hidden
 * row, because the lock and the crossed-out eye ARE the state and hiding them
 * would hide it. The selected row is held lit too, a density call: in a
 * 240px tree the selected row is the one whose actions are wanted next.
 */
.de-layer-actions {
  /* \`space.sm\`, not \`space["3xs"]\`: the gap is what keeps the three 24px hit pads
     below from overlapping. See the pad's own note. */
  display: flex; flex: none; align-items: center; gap: ${t.space.sm}px;
  margin-left: ${t.space["2xs"]}px;
  opacity: 0;
  pointer-events: none;
  transition: opacity ${t.duration.hover} ${t.ease};
}
.de-layer:is(:focus-visible, :has(:focus-visible)) .de-layer-actions,
.de-layer--dragging .de-layer-actions,
.de-layer[aria-selected="true"] .de-layer-actions,
.de-layer--locked .de-layer-actions,
.de-layer--hidden .de-layer-actions { opacity: 1; pointer-events: auto; }
@media (hover: hover) and (pointer: fine) {
  .de-layer:hover .de-layer-actions { opacity: 1; pointer-events: auto; }
}
@media (pointer: coarse) {
  .de-layer-actions { opacity: 1; pointer-events: auto; }
}
/*
 * Icon-only, so FULL ink in every state (MICRO-INTERACTIONS § 5) — a dim glyph
 * reads as disabled. \`radius.sm\`, the kit's corner for a small control.
 */
.de-layer-action {
  position: relative;
  width: ${t.size.miniSize}px; height: ${t.size.miniSize}px;
  flex: none; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: ${t.radius.sm};
  background: transparent;
  color: ${t.color.text};
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, color ${t.duration.hover} ${t.ease};
}
/* Same bargain as \`.de-mini\`: the plate stays 18px so three of them in a 24px
   row do not read as a toolbar, and a transparent pad buys the rest of the
   target. The 3 is not rhythm, it is (24 - 18) / 2 — the room left over once
   the plate is taken out of the 24 WCAG 2.5.8 asks for.

   The pad used to be vertical only (\`-3px 0\`), because these sit 2px apart and
   delete is one of them, so reaching sideways would let a miss on the eye land
   on the bin. That reasoning was right about the danger and wrong about the
   remedy: it left the target 18 wide, and 2.5.8 is not a floor on height, it is
   a floor on both. Worse, the 2px gap put the three centres 20px apart, which
   fails the spec's spacing exception too — the fallback that would have excused
   an undersized target needs 24 between centres.

   So the pad reaches all four sides and the GAP above pays for it: \`space.sm\`
   puts the centres 26px apart, so each 24px target clears its neighbours with
   2px to spare and the bin still cannot be hit by a miss on the eye. The row
   grows 12px, which the layers panel has. */
.de-layer-action::after {
  content: ""; position: absolute; inset: -3px;
}
/* The plate lands on a row that has already lifted (the strip only shows on a
   hovered, focused or selected row), so it takes the kit's inset-ghost step:
   one rung above the row hover. \`bgHover\` is that rung: \`--secondary\` over
   the row's \`--muted\` in light, the 12% wash over the 10% one in dark. */
@media (hover: hover) and (pointer: fine) {
  .de-layer-action:hover { background: ${t.color.bgHover}; }
}
.de-layer-action:focus-visible { ${FOCUS_INSET} }
/* Delete is the one row action that cannot be pressed again to take it back —
   Cmd+Z can, but the row it lived on is gone by then. It says so on approach
   rather than after the fact, which is the same bargain the mini danger button
   and the toolbar's destructive button already make: quiet until you are on it.

   \`danger\` is a LIGHT coral in dark (\`#ff6467\`) and a deep red in light
   (\`#c8000a\`), so the ink has to go dark on one theme and white on the other.
   \`onAccent\` is white in BOTH themes, which would put a white bin on the coral
   under the 3:1 a glyph owes, on the one action that most needs to be read
   before it fires.

   \`onSemantic\` is that ink — the kit's \`--on-hue\`, near-black in dark and
   white in light. 6.61:1 on the coral and 6.07:1 on the red. */
.de-layer-action--danger:focus-visible { background: ${t.color.danger}; color: ${t.color.onSemantic}; }
@media (hover: hover) and (pointer: fine) {
  .de-layer-action--danger:hover { background: ${t.color.dangerWash}; color: ${t.color.danger}; }
}
/*
 * The row a drag has picked up, and it RECEDES rather than lifts.
 *
 * Nothing marked it at all before this, so a drag in progress and a pointer
 * resting on a list drew the same picture: the line below said where the thing
 * would land while nothing said which thing was going. The lifted copy already
 * exists — the browser carries a snapshot of the row under the cursor — so what
 * stays in the list is the hole that copy came out of, and a hole fades and
 * shrinks. A row that grew here would be a second thing claiming to be the one
 * in your hand.
 *
 * A modifier class, and deliberately not a state on \`.de-layer\`. Anything
 * written on the row rule is written on every row of a tree that runs to
 * hundreds, and \`opacity\` and \`transform\` there would hand the compositor a
 * transition to be ready for on all of them. Exactly one row is ever dragged.
 *
 * The transition lives here too, which animates the entrance and snaps the
 * exit: adding the class brings a \`transition\` in with it, removing the class
 * takes the transition away in the same style change, so the row returns
 * instantly. That asymmetry is accepted rather than fixed, because the only fix
 * is moving the declaration up to \`.de-layer\` — the one place it must not go —
 * and the exit is the moment of the drop, when the tree is rebuilt around the
 * row anyway.
 *
 * 0.6 and 2%, measured, because the fade lands on a NAME and this file argues
 * about names four rules above. The hidden row holds 4.5:1 there because hiding
 * is a state a row sits in unattended and finding what you hid is the whole
 * job. A drag lasts exactly as long as a button is held, by the hand holding
 * it, and a full-strength copy of the same name is under the cursor the entire
 * time — which is why \`layers.ts\` waits a frame before adding this class, so
 * the snapshot is taken before the fade. What the row left behind costs, at
 * 0.6: a plain name is 6.79:1 dark and 5.00:1 light, a component name 3.58:1
 * and 2.75:1, and a hidden component row — the compound this file already calls
 * its binding case — 2.93:1 and 2.31:1. The conventional drag-ghost 0.5 takes
 * the plain name to 5.09:1 and 3.58:1, for a step the 2% shrink is already
 * carrying half of.
 */
.de-layer--dragging {
  opacity: 0.6;
  transform: scale(0.98);
  transition: opacity ${t.duration.exit} ${t.ease}, transform ${t.duration.exit} ${t.ease};
}
/*
 * The drop line rides the boundary between two rows, so it is placed by the
 * panel and only coloured here. Accent, never the pink canvas guide: this is a
 * commit target in the tree, not a measurement on the page.
 *
 * It travels on \`transform\` and sits at \`top: 0\` for good, where the panel
 * used to write an absolute \`top\` per gap. Two reasons, and the second is the
 * one that decides it: \`top\` is a layout property, so every gap the pointer
 * crossed re-laid out a box inside a list that can be hundreds of rows deep;
 * and a property that lays out cannot be followed with a transition without
 * paying that cost every frame of it, so the line could only ever teleport
 * between candidate gaps. A composited move can be followed, and \`exit\` is what
 * follows it — the next gap is one row away, so the eye needs to be told which
 * way the line went, not shown a journey.
 *
 * The APPEARANCE stays instant, and it stays instant for free: the panel hides
 * the line with \`display: none\`, and an element that was not being rendered has
 * no before-change style to transition from, so the first placement of a drag
 * lands where it was put instead of sliding in from wherever the last drag
 * finished. The same rule is why a line that blanks over an invalid gap and
 * returns three rows away arrives rather than travels, which is the honest
 * reading — that is a new answer, not the old one moving.
 *
 * Only the vertical is animated, and the horizontal does not need it: every gap
 * a drag can offer belongs to the same parent as the row being dragged, so all
 * of them are at one depth and the inset the panel writes never changes inside
 * a drag.
 */
.de-layer-drop {
  position: absolute; top: 0; right: 4px; height: 2px;
  background: ${t.color.accent};
  border-radius: ${t.radius.xs};
  pointer-events: none;
  transition: transform ${t.duration.exit} ${t.ease};
}

/*
 * The right-click layer stack. Same rows, same order, over the canvas.
 *
 * A hairline as well as the cast, because this is the only surface in this
 * file that floats over the PRODUCT rather than inside a panel. \`shadow.popover\`
 * ends in a half-pixel DARK ring, which draws the menu's edge beautifully on a
 * white page and draws nothing at all on a dark one. \`bgRaised\` is a 12%
 * paper lift in dark and white in light, and either can be the lighter or the
 * darker of the two depending on the app, so there is no cast that separates it
 * from both. The composer in \`annotations.ts\` floats over the same unknown
 * pixels and already carries this pair; the menu was the one that did not.
 *
 * Against the dark chrome it separates by value, 1.42:1 above the panel
 * ground; in light it is white on white and the hairline and cast are the whole
 * edge. The card's own ink is 12.1:1 dark and 19.1:1 light.
 */
.de-layer-menu {
  position: absolute;
  min-width: 176px; max-width: 260px;
  padding: ${MENU.padding};
  background: ${t.color.bgRaised};
  border: ${MENU.hairline}px solid ${t.color.border};
  border-radius: ${MENU.outer};
  box-shadow: ${t.shadow.popover};
  pointer-events: auto;
}
/*
 * The kit's menu item at editor density: a 24px row (the kit's is 36) with its
 * 12px sides, 500 weight, the popover's full ink, and the corner off the
 * card's nest. The highlight is the kit's \`--accent\`, a neutral wash one rung
 * up from the card (\`bgRaisedHover\`), NOT a hue: in this system indigo means
 * "selected", and a row under the pointer is not selected. Keyboard focus
 * paints the same highlight and no ring, as the kit's menus do. It opens
 * instantly (see \`canvas/layer-menu.ts\`) and has no exit, because a dismissed
 * menu on the Escape stack must be gone at once.
 */
.de-layer-menu-row {
  display: block; width: 100%;
  height: ${t.size.rowHeight}px;
  padding: 0 ${t.space.md}px;
  border: none; border-radius: ${MENU.radius};
  background: transparent;
  color: ${t.color.text};
  font: inherit; font-weight: ${t.type.weightValue}; text-align: left;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  cursor: pointer;
  outline: none;
}
@media (hover: hover) and (pointer: fine) {
  .de-layer-menu-row:hover { background: ${t.color.bgRaisedHover}; }
}
.de-layer-menu-row:focus-visible { background: ${t.color.bgRaisedHover}; }
.de-layer-menu-row--component { color: ${t.color.component}; font-weight: ${t.type.weightValue}; }


`
