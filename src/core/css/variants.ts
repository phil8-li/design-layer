/**
 * The instance block: the component header, and one labelled row per property
 * the component declares.
 *
 * It used to be only the axes, which is why the grid below is still called
 * `.de-variant-axis` — that name is right for what the rule does (a two-column
 * row whose left edge every property shares) and wrong for what only axes used
 * to be, so the rule stayed and the sheet's subject widened. Everything the
 * header, the thumbnail, the library byline and the boolean switch need is
 * below it under `.de-instance-`.
 *
 * A grid rather than a flex row, so `variant` and `size` put their controls on
 * the same left edge however long their names are — the names come from the
 * host's source and from a library's manifest, and nothing here can predict
 * their width.
 */

import { tokens as t } from "../tokens"
import { FOCUS_RING, PRESS } from "./panels"

export const variantsCss = `/* ---------- variant axes ---------- */
/* 64 and not 62: the name column is a spacing decision like any other, and 64
   is eight of the kit's workhorse step where 62 is nothing at all. Two pixels
   wider costs the control nothing and stops the next person deriving a third
   odd number. It stays a literal because it is a column width — the scale tops
   out at 36 and has no rung to say this with. */
.de-variant-axis {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: ${t.space.sm}px;
}
.de-variant-axis-name {
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: ${t.color.textMuted};
  font-size: ${t.type.body};
}
/*
 * Said once per selection, not once per session: neither rewrite lane has an
 * operation that edits a component's prop, so choosing an option here writes
 * the classes the option contributes and leaves \`variant="…"\` in the source
 * alone — and a documented prop sets the live attribute and files the change
 * for an agent.
 */
.de-variant-note { color: ${t.color.textDim}; font-size: ${t.type.body}; line-height: ${t.type.leadingRow}; }

/* ---------- the instance header ---------- */
/*
 * Glyph, optional picture, then the name and its owner — Figma's own order, and
 * the order the questions are asked in: what kind of thing is this, what does
 * it look like, what is it called.
 *
 * The two marks are \`flex: none\` and the identity column is the one that
 * shrinks, because a component's name is the part that can be forty characters
 * long in a 260px panel and the part with an ellipsis to fall back on.
 */
.de-instance-head {
  display: flex; align-items: center; gap: ${t.space.sm}px;
  min-width: 0;
}
/*
 * The four-diamond mark, in neither the accent nor a borrowed purple: this
 * chrome has exactly one colour that means "the tool is telling you
 * something", and a second one would be a hue nobody can look up.
 */
.de-instance-glyph {
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  /* \`textDim\`, not the accent. On this tab the accent means "this one is
     chosen" — the selected row, the pressed tool, the active token. A permanent
     accent mark at the head of the Component section claimed a state it never
     leaves, and spent the one colour that has a job. \`.de-layer-icon\` is the
     same "what kind of thing is this" mark one panel over, and it is dim. */
  color: ${t.color.textDim};
}
/*
 * The live thumbnail's box, and the two rules that used to belong to the assets
 * sheet.
 *
 * \`componentPreview\` returns a node wearing \`.de-asset-clone\` or
 * \`.de-asset-monogram\`, and \`css/assets.ts\` — the sheet that drew both — goes
 * away with the assets browser. They are restated here SCOPED to this box
 * rather than copied out at the top level: they are positioning for a picture
 * inside a thumbnail, they only make sense inside one, and a loose
 * \`.de-asset-clone\` in a sheet about the inspector would outlive the last
 * thing that uses it exactly the way the original did.
 */
.de-instance-thumb {
  position: relative; flex: none; overflow: hidden;
  width: ${t.size.rowHeight}px; height: ${t.size.rowHeight}px;
  border-radius: ${t.radius.xs};
  background: ${t.color.bgSunken};
}
.de-instance-thumb .de-asset-clone {
  position: absolute; top: 50%; left: 50%;
  transform-origin: center;
  pointer-events: none; user-select: none;
}
.de-instance-thumb .de-asset-monogram {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: ${t.color.bgSunken}; color: ${t.color.textDim};
  /* The kit's badge role: 10px at 500, no tracking. */
  font-size: ${t.type.micro}; font-weight: ${t.type.weightValue};
}
/* Name over owner, because the name is what was selected and the owner is why
   this block is on screen at all. */
.de-instance-id { display: flex; flex-direction: column; min-width: 0; }
.de-instance-name {
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: ${t.color.text};
  font-size: ${t.type.body}; font-weight: ${t.type.weightValue};
}
/* Quietly, beside the name: the fact that explains why the panel is showing
   this at all, and the one a reader needs when two libraries are on and the
   documentation looks wrong. */
.de-instance-owner {
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: ${t.color.textDim};
  font-size: ${t.type.caption};
}
/* The declaring file, in the face a path is written in. Clipped at the END
   rather than reversed with \`direction: rtl\`: that trick moves a leading
   slash to the other side of the string, so the one path it mangles is the
   absolute one. */
.de-instance-file {
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: ${t.color.textDim};
  font-family: ${t.font.mono}; font-size: ${t.type.caption};
}
/* Prose, so it takes the measure cap for the reason \`type.measure\` gives. */
.de-instance-desc {
  max-width: ${t.type.measure};
  color: ${t.color.textMuted}; font-size: ${t.type.body}; line-height: ${t.type.leadingBody};
}
/*
 * A property the library documents and nothing here can set.
 *
 * Deliberately not styled as a disabled control. A greyed-out select says "you
 * cannot press this yet"; this is not a control that is unavailable, it is a
 * fact with no control behind it, and drawing it as text is the only honest
 * difference between the two.
 */
.de-instance-stated {
  overflow: hidden; text-overflow: ellipsis;
  color: ${t.color.textMuted};
  font-size: ${t.type.body}; line-height: ${t.type.leadingRow};
}

/* ---------- the boolean switch ---------- */
/*
 * The third drawing of one control, and the comment is the debt.
 *
 * \`.de-ann-toggle\` is the same \`role="switch"\` at the same geometry and
 * \`.de-lib-switch\` is the same drawing reporting \`aria-pressed\`; both live in
 * sheets that draw other surfaces — the notes tab and the Design system tab —
 * which this block has no business reaching into for a control. A FOURTH means
 * the three belong in \`css/panels.ts\` as one rule.
 *
 * The numbers are the DRAWING and not rhythm, which is why they stay literal
 * while every gap in this file is on the scale: 28x16 of border box around a
 * 12px knob is 1px of clearance and 12px of travel, and the 1px insets follow
 * from the border under \`box-sizing: border-box\`. Moving any of them to a
 * spacing step would move the knob off centre.
 *
 * \`transform\`, never \`left\`: a knob animated on an inset is laid out again on
 * every frame. Colour and travel both take the kit's 150ms tween: a switch is
 * a repeated change, not a surface arriving. The track is a true pill, so it
 * is written as one and opts out of the squircle in \`css/base.ts\`.
 */
.de-instance-switch {
  position: relative;
  flex: none; justify-self: start;
  width: 28px; height: 16px;
  padding: 0;
  border: 1px solid ${t.color.borderInteractive}; border-radius: 999px;
  background: ${t.color.field};
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, border-color ${t.duration.hover} ${t.ease},
    box-shadow ${t.duration.hover} ${t.ease}, transform ${t.duration.hover} ${t.ease};
}
.de-instance-switch::after {
  content: "";
  position: absolute; left: 1px; top: 1px;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: ${t.color.text};
  transform: translateX(0);
  transition: transform ${t.duration.hover} ${t.ease}, background-color ${t.duration.hover} ${t.ease};
}
.de-instance-switch[aria-checked="true"] {
  background: ${t.color.accentSurface};
  border-color: ${t.color.accentSurface};
}
@media (hover: hover) and (pointer: fine) {
  .de-instance-switch:hover { background: ${t.color.fieldHover}; }
  .de-instance-switch[aria-checked="true"]:hover {
    background: ${t.color.accentSurfaceHover};
    border-color: ${t.color.accentSurfaceHover};
  }
}
/* The knob takes \`onAccent\` as it arrives: white on the indigo, 4.97:1 dark
   and 6.70:1 light. In light that flips it from ink to white, a second channel
   besides where the knob is; in dark it stays near-white and the track's fill
   carries the change. */
.de-instance-switch[aria-checked="true"]::after {
  transform: translateX(12px);
  background: ${t.color.onAccent};
}
.de-instance-switch:active { ${PRESS} }
/*
 * The press squeeze goes with the motion, the way its two siblings' already do.
 *
 * \`.de-lib-switch\` and the annotation toggle are the same control and both are
 * stood down in their own files' reduced-motion blocks; this one was the third
 * copy and had never got one, so a reader who asks for less motion got a squeeze
 * on exactly one of the chrome's three switches.
 */
@media (prefers-reduced-motion: reduce) {
  .de-instance-switch:active { transform: none; }
}
/* No disabled state, unlike its two siblings, and that is a decision rather
   than an omission: a switch is drawn in a POSITION, and a boolean this panel
   cannot read has no position to draw it in. The section states those as text
   instead — see \`section-instance.ts\`. */
.de-instance-switch:focus-visible { ${FOCUS_RING} }
`
