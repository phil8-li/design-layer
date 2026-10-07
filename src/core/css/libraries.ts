/**
 * The Libraries section: the installed rows, the add-by-URL CTA and the switch.
 *
 * One sheet for a surface that is almost entirely LISTS OF PLACES in a 260px
 * column, which is what every rule below is really solving for. A library is
 * named by a path or a URL, and neither string has a natural width — so the
 * name shrinks with an ellipsis, the source line truncates and carries itself
 * in a `title`, and the controls beside them are `flex: none` so that a deeply
 * nested token file can never push a remove button off the panel.
 *
 * NOTHING HERE DRAWS A PANEL ANY MORE. This was a tab with a header bar of its
 * own, then a dialog; it is a `section()` on the Design system tab now, so the
 * heading, the fold, the 8px side padding and the gap between rows all come
 * from `.de-section-header` / `.de-section-body` in `css/panels.ts`. Every rule
 * that restated one of those is gone rather than adjusted — a second opinion
 * about a section's padding is how two sections in one column end up a pixel
 * apart.
 *
 * The depth grammar is three rungs and it carries meaning rather than
 * decoration: the local-file fold is a WELL (`bgSunken`) because it is a drawer
 * that opened inside the section, an enabled library is a RAISED card because
 * it is contributing to every picker on the Design tab right now, and a
 * disabled one drops back to the panel ground. That last step is the second
 * channel on the switch — where the knob is, and whether the card it sits on is
 * still there — so the on state survives greyscale and a glance.
 */

import { tokens as t, nest } from "../tokens"

/**
 * The local-file drawer, and the one container in this sheet that holds a
 * rounded child in a rounded corner.
 *
 * Everything else here is a card in a flat list — the section body spaces them
 * and nothing sits inside anything. The drawer is different: it is a well with
 * bordered candidate rows stacked in it and a path field across its foot, so
 * its top corners hold a `.de-lib-candidate` and its bottom corners hold a
 * `.de-lib-field` and a `.de-button`. Three rounded things in four corners, and
 * `nest()` is what stops them being three separate guesses.
 *
 * `radius.lg` over `space["2xs"]` rather than the `radius.sm` over `space.sm` this
 * started as, and the inset is what was actually wrong. Two of those three
 * children are SHARED furniture drawn at `radius.sm` by rules this sheet does
 * not own, so the only inset that leaves them concentric is one that computes
 * back to `sm` — 12 − 4 = 8. An 8px inset would have demanded they all square
 * off, which is a stack of hard-cornered cards in a soft-cornered well, and the
 * `.de-lint-ignored-row` note in `test/concentric-cases.mjs` records the same
 * call being made the same way: move the container, not the shared child.
 *
 * It also lands the drawer on exactly the geometry `.de-app-menu` and
 * `.de-layer-menu` already use, which is the right company — all three are a
 * soft container holding a short list of rows.
 */
const DRAWER = nest({ of: ".de-lib-panel", outer: t.radius.lg, inset: t.space["2xs"] })

/*
 * The sign-in dialog is NOT a nest any more, and that is the kit's geometry
 * rather than an omission.
 *
 * It is drawn as the kit's dialog: the modal rung (`radius['5xl']`, 18) and the
 * modal side inset (`space['2xl']`, 24). An inset past the radius erodes the
 * corner entirely — 18 − 24 clamps to 0 — so no child shares a centre with it
 * and there is no inner radius to compute. The action buttons in its foot keep
 * the one action-button corner every text button wears, exactly as the kit's
 * own dialog does. Declaring a nest here would assert that those buttons must
 * be square, which is the opposite of the kit's rule that buttons are one
 * family.
 */

/**
 * A signed-in origin, drawn as a card like the library cards above it: the kit
 * card rung (`radius['3xl']`). Its right corner holds the Forget `.de-mini`,
 * an icon-only mini button at `radius.sm`, so 16 − 8 = 8 is the inset that
 * keeps the two curves parallel; the border is counted in.
 */
const SIGNED = nest({
  of: ".de-lib-signed-row",
  outer: t.radius["3xl"],
  inset: t.space.sm,
  hairline: 1,
})

/**
 * Keyboard focus, as the kit draws it on an action: the edge takes the accent
 * and a 3px halo of it at 30% sits outside. Drawn with `outline` for the edge
 * so a borderless text control still gets one, and pointer focus paints
 * nothing because every call site is `:focus-visible`.
 */
const FOCUS_RING = `outline: 1px solid ${t.color.accent}; outline-offset: 0; box-shadow: 0 0 0 3px color-mix(in srgb, ${t.color.accent} 30%, transparent);`

/** Hover paint only on a real pointer (kit interaction rule 1). */
const HOVER = "@media (hover: hover) and (pointer: fine)"

export const librariesCss = `/* ---------- libraries section ---------- */
.de-lib { display: flex; flex-direction: column; gap: ${t.space.md}px; }

/* The count rides in the section header's actions track, beside the chevron, so
   it lands on the same column as Fill's and Effects' \`+\`. Dim, because it is a
   quantity beside a word and not a second half of the title; tabular too, but
   from the chrome root now rather than from here — see \`css/base.ts\`. It is
   empty at zero — see the render comment — and the track simply collapses. */
.de-lib-count { color: ${t.color.textDim}; }

/* ---------- the installed list ---------- */
.de-lib-list { display: flex; flex-direction: column; gap: ${t.space.sm}px; }
.de-lib-list:empty { display: none; }
/*
 * An enabled library is a raised card; a disabled one is the panel ground with
 * an outline.
 *
 * Not \`opacity\`, which is what a dimmed row usually gets here. The off state
 * has to leave the switch and the remove button at full contrast — they are the
 * two controls a reader is most likely to want on exactly the card that is off
 * — and a fade over the whole card takes the ink of the control down with the
 * card's own. Dropping the SURFACE says the same thing and touches nothing a
 * pointer is aimed at.
 *
 * The kit's card: the card rung (\`radius['3xl']\`), one hairline edge and NO
 * shadow — it is docked in a panel, not floating over anything. The 8px pad
 * leaves 16 − 8 = 8 at the corner, which is the corner the remove \`.de-mini\`
 * in the top-right wears.
 */
.de-lib-card {
  display: flex; flex-direction: column; gap: ${t.space["2xs"]}px;
  padding: ${t.space.sm}px;
  border: 1px solid ${t.color.hairline}; border-radius: ${t.radius["3xl"]};
  background: ${t.color.bgRaised};
  transition: background-color ${t.duration.hover} ${t.ease};
}
.de-lib-card--off { background: transparent; }

/* Name, badge and controls on one line — the only line of a row that has a
   fixed shape, which is why the variable-width part of it is the one that
   shrinks. */
.de-lib-line { display: flex; align-items: center; gap: ${t.space["2xs"]}px; }
.de-lib-name {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: ${t.color.text}; font-size: ${t.type.body}; font-weight: ${t.type.weightValue};
}
/*
 * The kind, as a plate rather than an eyebrow.
 *
 * On \`body\` and not \`micro\` for the reason \`css/options.ts\` gives about its
 * own tags: 10px is three quarters of the readable floor and the size at which
 * a word stops being read and starts being recognised by shape. The plate is
 * what gives it rank; the size does not have to.
 */
.de-lib-kind {
  flex: none;
  padding: 0 ${t.space["2xs"]}px;
  border-radius: ${t.radius.xs};
  /* \`bgRaisedHover\`, not \`bgHover\`: this badge sits ON \`.de-lib-card\`, which
     is \`bgRaised\`, and \`bgHover\` is no step up from that — the same value in
     dark, a rung below in light — so the plate would read as nothing, or as a
     hole punched in the card, rather than a label laid on it. */
  background: ${t.color.bgRaisedHover}; color: ${t.color.textMuted};
  font-size: ${t.type.body}; font-weight: ${t.type.weightValue};
}
/* What the library brings, in the server's words or in counted groups. It is
   the one line on the row that is allowed to wrap: it is a sentence, and three
   clauses of it at 180px is two lines however it is cut. */
.de-lib-detail { color: ${t.color.textMuted}; font-size: ${t.type.body}; line-height: ${t.type.leadingRow}; }
/*
 * Where it came from, on ONE line with an ellipsis.
 *
 * This used to \`break-all\` and wrap, which was right when every library was a
 * project-relative path of three or four segments. A URL is not that: a
 * Storybook address with a query on it wraps to four lines of monospace and
 * makes the source the tallest thing on a row whose subject is the library's
 * name. The whole string is in \`title\` either way, so nothing is lost by
 * cutting it.
 */
.de-lib-path {
  min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ${t.font.mono}; font-size: ${t.type.body};
  color: ${t.color.textDim};
}
.de-lib-actions { display: inline-flex; align-items: center; gap: ${t.space["2xs"]}px; flex: none; }
/* Sentences, not row labels, so they take the kit's reading leading. */
.de-lib-hint { margin: 0; color: ${t.color.textDim}; font-size: ${t.type.body}; line-height: ${t.type.leadingBody}; }
/* After \`.de-lib-hint\` on purpose: a failed scan wears both classes, and at
   equal specificity the later rule is what makes the tint win. \`danger\` is the
   status TEXT rung (4.5:1), not a decorative hue. */
.de-lib-error { color: ${t.color.danger}; font-size: ${t.type.body}; line-height: ${t.type.leadingBody}; }

/* ---------- the add-by-URL CTA ---------- */
/* No \`.de-lib-cta-label\` any more. The box had a caption over it reading "Link
   to a design system or Storybook", which is what the placeholder and the
   aria-label already say — and the two lists in this section each lost their
   heading in the same pass, so a caption left on this one would be the only
   label in the block. The rule went with the span; a guard in
   \`design-system-tab-cases.mjs\` keeps it from growing back. */
.de-lib-cta { display: flex; flex-direction: column; gap: ${t.space["2xs"]}px; }
.de-lib-cta-row { display: flex; align-items: center; gap: ${t.space["2xs"]}px; }
/*
 * \`field\` rather than the \`bgSunken\` the options browser's inputs take: that
 * one is a well on the panel ground, and the path box below sits INSIDE a well,
 * where the same value would make the box and its drawer the same surface. One
 * rule for both boxes, so the primary and the secondary way in are the same
 * control. The boundary is \`borderInteractive\` for the reason spelled out in
 * \`css/options.ts\` — it is the rung this token set ships for the edge of a
 * control you can act on, and the divider rung measures 1.32:1 dark and 1.18:1
 * light on the panel, which is a field that reads as text.
 */
.de-lib-field {
  flex: 1; min-width: 0;
  height: ${t.size.rowHeight}px; padding: 0 ${t.space["2xs"]}px;
  border: 1px solid ${t.color.borderInteractive};
  /*
   * NOT \`CONTROL_RADIUS\`, and this is the one input-shaped control in the
   * chrome that may not take it — even though the two are both 8px today.
   *
   * The other three filters are loose in a panel body and are free to wear the
   * control rung. This one sits 4px inside \`.de-lib-panel\`'s 12px card, so its
   * corner is COMPUTED — outer minus inset — and 8px is the only value that
   * nests. Forcing the control rung here put a 4px corner inside a 12px one
   * with 4px of padding between them, which is the exact mismatch \`nest()\`
   * exists to prevent, and \`test/concentric-cases.mjs\` caught it immediately.
   *
   * Concentricity outranks the control rung wherever the two disagree: a
   * reader sees the pair of corners, not the token behind either.
   *
   * \`radius.sm\` is also the kit's field corner adapted to editor density: the
   * kit draws fields at 16px on a 36px box, and a 16px corner on a 24px field
   * is a pill.
   */
  border-radius: ${t.radius.sm};
  background: ${t.color.field}; color: ${t.color.text};
  font-family: ${t.font.mono}; font-size: ${t.type.body};
  outline: none;
  transition: background-color ${t.duration.hover} ${t.ease}, border-color ${t.duration.hover} ${t.ease};
}
${HOVER} { .de-lib-field:hover { background: ${t.color.fieldHover}; } }
/* The kit's field focus: the edge takes the accent, and nothing else. */
.de-lib-field:focus-visible { border-color: ${t.color.accent}; }
.de-lib-field::placeholder { color: ${t.color.textDim}; }

/* ---------- the sign-in dialog ---------- */
/*
 * THE WALL IS A MODAL NOW, AND IT USED TO BE A WELL IN THE COLUMN.
 *
 * It was \`bgSunken\` under the URL row, on the local-file drawer's grammar:
 * a thing that opened inside the section in answer to something above it. What
 * that grammar could not say is that the add STOPS here — a well is a disclosure
 * and a disclosure is optional. The panel behind it also stayed live, so the
 * question could be left open indefinitely with libraries being toggled over the
 * top of it. \`showModal()\` says the true thing in one call, and takes the focus
 * trap, the inertness and the top layer with it; \`libraries-section.ts\` carries
 * the argument at length.
 *
 * So the surface changes rung with the shape, and it is the kit's dialog: the
 * popover ground (\`bg\`, the kit's \`--popover\`), the modal corner
 * (\`radius['5xl']\`), the modal side inset (\`space['2xl']\`) and the modal
 * elevation (\`shadow.float\`, which carries the card hairline and, in dark, the
 * top rim light). No border of its own: the hairline is already a layer of that
 * shadow, and a second edge would be a ring beside the rim. A sunken card over
 * a backdrop would be a hole in front of a dimmed page.
 *
 * ## The width is the other half of the change
 *
 * 420px, against the ~200px of usable column the well had. That is not comfort:
 * the two strings this surface exists to move are an OAuth client id of about
 * seventy characters and a bearer token of several hundred, and at the old width
 * the id wrapped five times and the field showed a couple of dozen characters of
 * the paste. \`min()\` keeps it off the edge of a narrow viewport, and the
 * gutter is the same modal inset.
 *
 * ## Motion is the kit's modal grammar
 *
 * It scales in place from 0.96 over \`reveal\` on \`easeReveal\` and fades in,
 * and leaves to 0.98 over \`exit\` on \`easeExit\`. Nothing slides and nothing
 * blurs. \`@starting-style\` supplies the entrance's first frame. The exit plays
 * on an inert copy (\`playExit\` in core/motion), so the real dialog and its
 * backdrop leave the top layer the instant it is dismissed.
 */
.de-lib-signin::backdrop {
  /* The kit's static scrim, the same veil the shortcuts sheet dims with: one
     editor has one strength of "not now". It never animates a blur. */
  background: ${t.color.scrim};
}
.de-lib-signin {
  display: flex; flex-direction: column; gap: ${t.space.sm}px;
  width: min(420px, 100% - ${t.space["2xl"] * 2}px);
  max-height: calc(100% - ${t.space["2xl"] * 2}px);
  margin: auto;
  overflow-y: auto;
  padding: ${t.space["2xl"]}px;
  border: none;
  border-radius: ${t.radius["5xl"]};
  background: ${t.color.bg};
  box-shadow: ${t.shadow.float};
  color: ${t.color.text};
  font-family: inherit; font-size: ${t.type.body};
  transform-origin: center;
  transition: transform ${t.duration.reveal} ${t.easeReveal}, opacity ${t.duration.hover} linear;
}
@starting-style { .de-lib-signin[open] { opacity: 0; transform: scale(0.96); } }
/* Not shown is not displayed. Without this a closed dialog still lays out — and
   this one is parked on \`document.body\`, so it would lay out across the app. */
.de-lib-signin:not([open]) { display: none; }
/* The credential box is autofocused on open, so the card itself only takes
   focus on the engines that ignore that — a ring there is a side effect of
   opening rather than a place anybody navigated to. Every control INSIDE keeps
   its own \`:focus-visible\`. */
.de-lib-signin:focus { outline: none; }
/* Which wall, and whose origin: the dialog's accessible name, and the first
   thing read out when it opens. It wraps — an origin has no natural width, and
   truncating the subject of the dialog would hide the answer to "which site is
   this about". The kit's title weight and tracking, at the editor's size: it
   is a real heading and the only one on the surface. */
.de-lib-signin-title {
  margin: 0;
  color: ${t.color.text};
  font-size: ${t.type.body};
  font-weight: ${t.type.weightTitle};
  letter-spacing: ${t.type.trackingTitle};
  line-height: ${t.type.leadingRow};
}
/*
 * A fact the refusal named: what it is called, then the value beside its copy
 * button.
 *
 * The label is its own line rather than a prefix on the plate, because the
 * value is a single unbroken string that wraps to three lines — a label sharing
 * those lines would be read as part of it. Stacked, the plate keeps the whole
 * width of the block, which is the difference between a 70-character id
 * wrapping three times and wrapping five.
 *
 * The \`[hidden]\` rule is not decoration: an author \`display\` beats the UA
 * hidden rule, so a row shown only when the wall carried that field needs this
 * to be hideable at all — the same correction \`.de-lib-signin\` makes above.
 */
.de-lib-fact { display: flex; flex-direction: column; gap: ${t.space["3xs"]}px; }
.de-lib-fact[hidden] { display: none; }
.de-lib-fact-label { color: ${t.color.textDim}; font-size: ${t.type.caption}; }
.de-lib-fact-row { display: flex; align-items: flex-start; gap: ${t.space["2xs"]}px; }
/*
 * The value, on a plate, WRAPPED rather than scrolled.
 *
 * An OAuth client id is one unbroken string of about seventy characters, and a
 * monospace line that long in a 240px column can only wrap, clip or scroll.
 * Clipping hides the part that differs between two services; a horizontal
 * scroller inside a vertical panel is a second axis nobody goes looking for.
 * \`anywhere\` because the id has no spaces and few hyphens, so any break
 * opportunity the text offers on its own is at the wrong end of it.
 *
 * \`field\` for the ground, the same rung the boxes above take: this is the one
 * thing in the block a designer ACTS on without typing, and a plate is what
 * says the copy button beside it applies to this and not to the hint above.
 */
.de-lib-fact-value {
  flex: 1; min-width: 0;
  padding: ${t.space["2xs"]}px ${t.space.sm}px;
  /* A read-only field, so the dense field corner rather than the chip floor. */
  border-radius: ${t.radius.sm};
  background: ${t.color.field}; color: ${t.color.textMuted};
  font-family: ${t.font.mono}; font-size: ${t.type.body}; line-height: ${t.type.leadingRow};
  overflow-wrap: anywhere;
}
.de-lib-signin-row { display: flex; align-items: center; gap: ${t.space["2xs"]}px; }
/*
 * Both actions to the trailing edge, decline then commit.
 *
 * \`space-between\` before, which reads correctly with two buttons and badly
 * with one: when the credential fold is shut the commit is \`hidden\`, and a lone
 * Close pinned to the left edge of a 420px card looks like the other half went
 * missing. Right-aligning both makes the one-button state the same shape as the
 * two-button one, with the pair reading in the order they are decided in.
 *
 * \`margin-top\` on top of the dialog's own gap, because this row is the end of
 * the card rather than the next thing in it — the same half-step every actions
 * row in the chrome puts between a form and what commits it.
 */
.de-lib-signin-actions {
  display: flex; align-items: center; justify-content: flex-end;
  gap: ${t.space.sm}px;
  margin-top: ${t.space["2xs"]}px;
}
/*
 * CLOSE IS PINNED TO THE CONTROL SURFACE.
 *
 * It used to inherit a \`bgRaised\` fill, and in light that rung IS paper — the
 * kit's \`--popover\` this card is drawn on — so the button was the exact colour
 * of the surface under it and only its label was left. \`.de-button\` fills
 * with \`bgHover\` now, which in light is already the value this sets.
 * The primary beside it is unaffected, since an accent fill owes nothing to the
 * ground.
 *
 * \`bgSunken\` is the answer rather than a border, and it is the role's own
 * definition — "the surface a control is drawn on" — applied one level up. It
 * moves AWAY from the ground in whichever direction that theme leaves free — up
 * off the card in dark, down into it in light, where it is the kit's
 * \`--secondary\` button — without this rule knowing which is which. The hover
 * follows it to the next rung along for the
 * same reason \`bgRaisedHover\` exists: a hover that recedes is a hover that
 * looks like a press.
 *
 * A class of its own, rather than \`.de-lib-signin-actions > .de-button:not(
 * .de-button--primary)\`: naming the control is shorter and plainer than
 * describing it by exclusion, and it cannot reach the copy buttons or anything
 * else the fold holds.
 */
/* \`fieldHover\` for the hover, the kit's secondary-to-secondary-hover step: in
   light \`bgHover\` is the same rung as \`bgSunken\`, so the old hover did not
   move at all. The token path's own submit is the same button on the same
   ground, so it takes the same drop. */
.de-lib-signin-close,
.de-lib-signin-panel-actions > .de-button:not(.de-button--primary, .de-button--danger) { background: ${t.color.bgSunken}; }
${HOVER} {
  .de-lib-signin-close:hover,
  .de-lib-signin-panel-actions > .de-button:not(.de-button--primary, .de-button--danger):hover { background: ${t.color.fieldHover}; }
}
/*
 * The token path's own submit, under the box it sends.
 *
 * It sits inside the fold rather than in the actions row above, because it
 * commits the field two lines up rather than the dialog — and because the
 * dialog's one real offer is now the window that opens the site's own sign-in.
 * Trailing edge to agree with every other actions row in the chrome.
 */
.de-lib-signin-panel-actions {
  display: flex; justify-content: flex-end; margin-top: ${t.space["2xs"]}px;
}

/*
 * ---------- the credential fold, inside the modal ----------
 *
 * Everything a designer has to know a protocol to use is behind one disclosure,
 * and this is the box it opens into. See \`libraries-section.ts\` for the reason;
 * the drawing decisions are these two.
 *
 * NO WELL, where the local-file fold in the panel has one. That drawer is a
 * surface opening INSIDE a list of other things and \`bgSunken\` is what
 * separates it from them. This one opens inside a modal that holds nothing else
 * — the two lines above it are its own subject — so a second ground would be
 * drawing a container around the only content there is. It is simply the rest
 * of the dialog, revealed.
 *
 * Which also keeps it out of the concentric checker's way: no ground means no
 * corner, and the plates and fields inside it are parallel to the card's own
 * curve rather than to a box drawn around them.
 */
.de-lib-signin-more { display: flex; flex-direction: column; }
.de-lib-signin-panel {
  display: flex; flex-direction: column; gap: ${t.space.sm}px;
  min-width: 0;
  /*
   * A HAIRLINE, because the two halves of this dialog are written for two
   * different readers and nothing else says where one ends.
   *
   * Opened, the card runs: a plain sentence, a disclosure, then the server's
   * protocol hint, a client id on a plate, a credential rail and a password
   * box — all on one ground, at one rhythm, reading as a single long form. It
   * is not one: everything below the line is addressed to somebody who already
   * has a token, and the reader who does not should be able to see at a glance
   * where the part that concerns them stopped.
   *
   * A rule and not a well. \`bgSunken\` would make this a container, which would
   * put the plate and the field in its corners and owe them a nest; a border is
   * structure rather than depth, which is exactly the distinction being drawn —
   * the fold is the same surface continued, with a seam.
   *
   * The margin becomes padding so the line sits at the top of the box the fold
   * clips, and disappears with it rather than hanging under the toggle.
   */
  padding-top: ${t.space.sm}px;
  margin-top: ${t.space.sm}px;
  border-top: 1px solid ${t.color.border};
  /* Load-bearing: see \`.de-lib-drawer\`. Without it the \`0fr\` row keeps this
     panel's content as its minimum and the fold never shuts. */
  min-height: 0;
}
/* Clipped is not gone: a shut fold still holds a text field, a rail and a copy
   button, all of them focusable and all of them read out. \`visibility\` is the
   property that takes a subtree out of the tab order without taking it out of
   the layout the drawer is animating. Delayed out, immediate back — the same
   shape \`.de-lib-panel[hidden]\` uses one block down. */
.de-lib-signin-panel[hidden] {
  visibility: hidden;
  transition: visibility 0s linear ${t.duration.exit};
}

/* ---------- what this editor is signed in to ---------- */
/*
 * A flat list of origins, with no surface of its own.
 *
 * Deliberately not cards: an installed library is a thing the whole editor is
 * USING and earns a raised card, while a sign-in is a fact about the network —
 * it contributes no token to any picker, and drawing it at the same rank would
 * put two kinds of object on one ground and invite a reader to compare them.
 * Text, a plate for the kind, and the forget control in the actions column
 * every row in this sheet already uses.
 */
.de-lib-signed { display: flex; flex-direction: column; gap: ${t.space["2xs"]}px; }
.de-lib-signed[hidden] { display: none; }
/* Each sign-in is a card, drawn with the library card's surface so the two
   lists in this section read as the same kind of object. */
.de-lib-signed-rows { display: flex; flex-direction: column; gap: ${t.space["2xs"]}px; }
.de-lib-signed-row {
  display: flex; align-items: center; gap: ${t.space["2xs"]}px;
  padding: ${SIGNED.padding};
  border: 1px solid ${t.color.hairline}; border-radius: ${SIGNED.outer};
  background: ${t.color.bgRaised};
}

/* ---------- the fold: a file in this project ---------- */
/* No \`gap\`: the space under the toggle belongs to the drawer, which carries it
   as a margin so that it is inside the box the fold clips — a gap lives between
   the tracks of the container and would survive the close as four pixels of
   hole. See \`.de-lib-drawer\`. */
.de-lib-local { display: flex; flex-direction: column; }
/*
 * The fold, as a quiet text control rather than a second CTA.
 *
 * What it opens is the rarer half of a rare act, and it must not compete with
 * the URL box directly above it. Same grammar as \`.de-opt-link\` in the options
 * browser, plus the twisty, because the twisty is the part that says the words
 * are a fold and not a link out.
 */
/* This used to be shared with \`.de-lib-dismiss\`, the sign-in modal's "Not now",
   on the grounds that both were a quiet word declining the loud thing beside
   them. It is not shared any more, and the class is gone: with the credential
   controls folded away, a quiet dismiss sat directly under the quiet fold
   toggle at the same weight and colour, and the two read as a pair of links
   rather than as a disclosure and the dialog's only action. That button is a
   real \`.de-button\` now, so this grammar is the fold's alone again. */
.de-lib-expand {
  align-self: flex-start;
  display: inline-flex; align-items: center; gap: ${t.space["2xs"]}px;
  padding: 0; border: none; background: transparent;
  color: ${t.color.textDim};
  font-family: inherit; font-size: ${t.type.caption};
  cursor: pointer;
}
.de-lib-expand { border-radius: ${t.radius.xs}; transition: color ${t.duration.hover} ${t.ease}; }
${HOVER} { .de-lib-expand:hover { color: ${t.color.text}; } }
.de-lib-expand[aria-expanded="true"] { color: ${t.color.text}; }
.de-lib-expand:focus-visible { ${FOCUS_RING} }
/* A real glyph from the vendored set rather than a \`content\` character, so this
   disclosure mark is the same drawing as the options browser's and the
   inspector's instead of three fonts' idea of a triangle. */
.de-lib-twisty {
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  color: ${t.color.textDim};
  transition: transform ${t.duration.hover} ${t.ease};
}
.de-lib-expand[aria-expanded="true"] .de-lib-twisty { transform: rotate(90deg); }

/*
 * THE FOLD ITSELF, AND IT USED TO BE HALF AN ANIMATION.
 *
 * The twisty above turns over \`hover\` and the thing it discloses arrived between
 * two frames, which is the worst of both: the mark says a drawer is opening and
 * the drawer says it was always there. The words under the twisty promise a
 * movement the body never made.
 *
 * ## Why a grid row and not \`revealGroup\`
 *
 * \`core/leave.ts\` has the helper, and the inspector's disclosure groups use it.
 * Its own header says what it is for: a group that is REBUILT on every render,
 * where the collapsed state has to be written inline at build time because the
 * node is new. This drawer is the opposite — it is built once at mount and
 * lives for the session, which is exactly the case that comment names as the
 * declarative one's. Three things follow from taking it:
 *
 *  - it closes as well as it opens. \`revealGroup\` animates one direction, so
 *    the fold would still snap shut under a twisty turning smoothly back;
 *  - the drawer's contents CHANGE while it is open — a scan lands, rows are
 *    added, a candidate flips to Added — and \`1fr\` re-resolves to whatever the
 *    panel is now. A measured pixel height would have to be measured again;
 *  - no JavaScript runs on the fold at all, so there is no second timer to keep
 *    in step with the reduced-motion clamp.
 *
 * The clip is on this element and not on the panel because the panel is padded,
 * and a border-box squeezed to zero still paints its padding.
 *
 * ## \`minmax(0, 0fr)\`, and it is not a flourish
 *
 * A bare \`0fr\` track means \`minmax(auto, 0fr)\`, and that automatic minimum is
 * the item's own minimum contribution — which for a padded box is its padding
 * plus its margin however small you make its content. Measured in Chrome: the
 * shut fold kept a twelve-pixel band of sunken background under the toggle, the
 * four pixels of margin and the eight of padding, and the drawer animated
 * between 12px and its full height rather than between nothing and it. Naming
 * a floor of zero is what makes the track free to actually close; the panel's
 * own \`min-height: 0\` is the other half and is just as load-bearing.
 *
 * The column takes the same floor for the width, as \`.de-section-fold\` does.
 * An implicit \`auto\` column grows to the panel's min-content — a candidate's
 * nowrap file path — so the drawer ran past the right edge and clipped the
 * candidate's own actions; \`minmax(0, 1fr)\` holds it to the section.
 */
.de-lib-drawer {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  /* Closing is a dismissal: the kit's \`exit\` on \`easeExit\`. The open rule
     below carries the reveal, so each direction takes its own tween. */
  transition: grid-template-rows ${t.duration.exit} ${t.easeExit};
}
/*
 * Driven by the panel's own \`hidden\`, not by the toggle's \`aria-expanded\`.
 *
 * Both attributes are written in the same statement, so either would work
 * today. This one keeps the disclosure's drawing tied to the disclosure's
 * STATE: \`hidden\` is what the panel is, \`aria-expanded\` is what the button
 * claims about it, and if those two ever drift the box should follow the thing
 * that decides whether the controls inside can be reached.
 *
 * \`reveal\` rather than \`resize\`, in spite of the name: \`resize\` is the tween
 * a whole panel takes to change width, and this is a disclosure settling in
 * inside a section — a surface reveal, 250ms on \`easeReveal\`, and it closes
 * over the kit's shorter \`exit\`.
 */
/* Two panels ride this drawer now — the local-file fold in the section, and the
   credential fold inside the sign-in modal — and they are named separately
   rather than given a shared class. The rule is about the DISCLOSURE's state
   and each panel decides its own; a common class would also hand the sunken
   well and the nest below to a panel that wants neither. */
.de-lib-drawer:has(> .de-lib-panel:not([hidden])),
.de-lib-drawer:has(> .de-lib-signin-panel:not([hidden])) {
  grid-template-rows: minmax(0, 1fr);
  transition: grid-template-rows ${t.duration.reveal} ${t.easeReveal};
}

/*
 * A well, not a card.
 *
 * This block is revealed by the control directly above it and closes again, so
 * it has to read as a drawer that opened INSIDE the section rather than as the
 * first item of the list above. \`bgSunken\` is the only rung that says that in
 * both themes — everything else in this file goes up from the ground, and a
 * second thing going up would put the transient surface at the same depth as
 * the permanent ones.
 */
.de-lib-panel {
  display: flex; flex-direction: column; gap: ${t.space.sm}px;
  /* The gap \`.de-lib-local\` gave up, carried here so the fold closes over it
     as well. */
  margin-top: ${t.space["2xs"]}px;
  /* Load-bearing: see \`.de-lib-drawer\`. Without it the \`0fr\` row keeps the
     panel's content as its minimum and the drawer never shuts. */
  min-height: 0;
  min-width: 0;
  padding: ${DRAWER.padding};
  border-radius: ${DRAWER.outer};
  background: ${t.color.bgSunken};
}
/*
 * NOT \`display: none\`, which is what this rule used to be, and the swap is the
 * whole reason the fold can animate.
 *
 * An author \`display\` beats the UA's \`[hidden]\` rule, so the panel is painted
 * whatever the attribute says and the drawer above clips it to nothing. That
 * leaves the half \`display: none\` was also doing for free, and it is the half
 * that matters: a shut fold holds a text field and two buttons, and a clipped
 * element is still focusable and still read out. \`visibility\` is the property
 * that takes a subtree out of the tab order and the accessibility tree without
 * taking it out of the layout, so it is the one that stands in.
 *
 * Delayed out and immediate back, the same shape \`css/base.ts\` uses for the
 * panels: hidden the moment the fold is asked to open, and not hidden until the
 * close has finished playing — without the delay the contents would vanish on
 * the first frame and the drawer would close over an empty box.
 */
.de-lib-panel[hidden] {
  visibility: hidden;
  transition: visibility 0s linear ${t.duration.exit};
}
.de-lib-status:empty { display: none; }
.de-lib-status { color: ${t.color.textDim}; font-size: ${t.type.body}; }
/*
 * A SCAN IN FLIGHT, SAID IN MOTION RATHER THAN IN A WORD.
 *
 * The walk behind this line reads up to four thousand files and takes seconds,
 * and for all of them the drawer said "Scanning the project…" in static text
 * over an empty box — which is also exactly what a request that died looks
 * like. The sentence cannot be the whole answer: it is identical on the first
 * frame and the last, so it reports that a scan is HAPPENING and never that it
 * is getting anywhere.
 *
 * A sweep rather than a count, and that is a limit rather than a preference.
 * \`discoverLibraries\` is a single GET that resolves with the finished list, so
 * there is no file tally on this side of the wire to print; a number invented
 * here would be a progress bar that knows nothing about the progress.
 *
 * The drawing is the lint panel's, down to the six reveal rungs and the ink: an
 * indeterminate loop has no duration to be correct about, so it takes
 * \`reveal\` multiplied rather than a literal, and it is the surface's
 * own border colour rather than a hue of its own — a progress mark that
 * introduces a new colour reads as a state change, which is the one thing this
 * is not.
 */
/*
 * THE SIGN-IN DIALOG'S WAIT RIDES THE SAME RULE, by name rather than in a rule
 * of its own, and there are two reasons for that.
 *
 * The first is that they are the same idea. Both are an indeterminate wait with
 * a sentence over it and no number available to either — the scan is one GET
 * that answers with a finished list, and the sign-in is one POST that answers
 * once a person has finished typing their password somewhere else. Two sweeps
 * drawn by two rules would drift, and the editor would grow two dialects of
 * "working on it".
 *
 * The second is the motion budget. \`tools/motion-budget.mjs\` counts infinite
 * animations, and it counts them because each one runs forever on somebody
 * else's page: five is the ceiling and five is what this chrome spends. Adding
 * a selector to the existing declaration costs none — the same animation on one
 * more element — where a second rule would have spent the sixth.
 *
 * The sign-in's mark is on the SENTENCE rather than on its button, unlike the
 * scan's, because during a wait that button is not on screen: the offer is
 * withdrawn and a cancel stands in its place. The line that is reporting is the
 * line that should be moving.
 */
.de-lib-status[data-de-busy],
.de-lib-signin-hint[data-de-busy] {
  position: relative;
  padding-bottom: ${t.space["2xs"]}px;
  overflow: hidden;
}
.de-lib-status[data-de-busy]::after,
.de-lib-signin-hint[data-de-busy]::after {
  content: "";
  position: absolute; left: 0; right: 0; bottom: 0;
  height: ${t.size.hairline * 2}px;
  /*
   * NO \`border-radius\`, and its absence is the decision.
   *
   * There was a \`radius.xs\` here, which on a two-pixel bar clamps to a pair of
   * semicircular caps — and those caps are drawn at the two points where this
   * gradient has already faded to \`transparent\`. It rounded nothing anybody
   * could see, and it cost real complexity: a radius past half the height is a
   * circle by the squircle audit's arithmetic, so the rule had to be listed in
   * the \`corner-shape: round\` opt-out in \`css/base.ts\` — and that list is
   * matched selector-for-selector, which a grouped rule like this one cannot
   * satisfy. Dropping a declaration that was never visible is a better answer
   * than either splitting the rule (a second infinite animation, against a
   * budget that allows five) or loosening the audit.
   */
  background: linear-gradient(90deg, transparent, ${t.color.borderStrong}, transparent);
  animation: de-lib-scan calc(${t.duration.reveal} * 6) linear infinite;
}
@keyframes de-lib-scan { from { transform: translateX(-100%); } to { transform: translateX(100%); } }

/* Rests where the candidates will land, each one a candidate's exact box: its
   8px pads and hairlines, three 12/16 lines and a row-high button, 2px apart —
   the kit's rule that a skeleton stands in the loaded geometry. Flat on purpose: the sweep above is already the moving part, and a
   drawer with two things breathing at different rates in it reads as two
   things going wrong rather than one thing working. */
.de-lib-scan { display: flex; flex-direction: column; gap: ${t.space["2xs"]}px; }
.de-lib-scan-row {
  height: ${2 * t.space.sm + 2 * t.size.hairline + 3 * Math.round(Number.parseFloat(t.type.body) * t.type.leadingRow) + t.size.rowHeight + 3 * t.space["3xs"]}px;
  border-radius: ${t.radius.sm};
  background: ${t.color.bgHoverQuiet};
}

.de-lib-candidates { display: flex; flex-direction: column; gap: ${t.space["2xs"]}px; }
/* Up off the well, so a row you can act on is a surface and the drawer it sits
   in is not. \`bg\` rather than \`bgRaised\`: these are candidates, not installed
   libraries, and the cards above have to stay the lightest thing in the
   section. */
.de-lib-candidate {
  display: flex; flex-direction: column; gap: ${t.space["3xs"]}px;
  padding: ${t.space.sm}px ${t.space.md}px;
  border: 1px solid ${t.color.hairline}; border-radius: ${DRAWER.radius};
  background: ${t.color.bg};
}
/*
 * The rows arriving, once, on the paint that follows the walk answering.
 *
 * A scan that spends four seconds saying nothing and then replaces itself with
 * four finished rows in a single frame reads as a jump cut — the drawer was
 * waiting, and then it had always had this in it. Dealing them out says the
 * list is being filled, which is what just happened.
 *
 * Half an \`exit\` per row is the shortest step the eye reads as an order rather
 * than as one event, and the index is capped by the section that writes it —
 * see \`ARRIVAL_STEPS\` in \`libraries/libraries-section.ts\`. The step lives here
 * because this is the file that knows what a short delay is; the cap lives
 * there because that is the file that knows how many rows there are.
 *
 * \`both\` is not decoration. Without backwards fill a row with a delay paints at
 * full opacity, waits its turn and then blinks out to start — the flash the
 * stagger exists to remove, once per row.
 */
.de-lib-candidate--arriving {
  animation: de-lib-candidate-in ${t.duration.hover} ${t.easeReveal} both;
  animation-delay: calc(${t.duration.exit} / 2 * var(--de-lib-arrive, 0));
}
/* A fade and nothing else: the kit's rule is that nothing slides in, and a 4px
   drop from above was a slide. */
@keyframes de-lib-candidate-in {
  from { opacity: 0; }
}

/* The path box is the way past a scan that missed something, so it is separated
   from the scan's own results by a rule rather than by a gap. */
.de-lib-manual {
  display: flex; flex-direction: column; gap: ${t.space["2xs"]}px;
  padding-top: ${t.space.sm}px;
  border-top: 1px solid ${t.color.border};
}
.de-lib-manual-label { color: ${t.color.textDim}; font-size: ${t.type.caption}; }
.de-lib-manual-row { display: flex; align-items: center; gap: ${t.space["2xs"]}px; }
/* A button laid in a well: the shared button's fill is the well's own rung in
   light (both are the kit's \`--secondary\`), so it takes the panel ground
   instead and lifts off the well in both themes. */
/* Secondary buttons only, at rest and on hover. A danger button's hover is its
   own fill-and-ink pair at (0,2,0), and either plate here out-ranks that fill
   while its \`onSemantic\` ink stays — about 1:1 on paper. */
.de-lib-manual-row > .de-button:not(.de-button--primary, .de-button--danger) { background: ${t.color.bg}; }
${HOVER} { .de-lib-manual-row > .de-button:not(.de-button--primary, .de-button--danger):hover { background: ${t.color.bgRaisedHover}; } }

/* ---------- the switch ---------- */
/*
 * A track, and a knob that travels its length.
 *
 * Deliberately the same drawing as the Changes tab's \`.de-ann-toggle\`, down to
 * the geometry, because two switches in one piece of chrome that are the same
 * control at two sizes is how a shell stops looking designed. It is a separate
 * class rather than a shared one because the two carry their state on different
 * attributes — that one is a \`role="switch"\` reporting \`aria-checked\`, this one
 * a toggle button reporting \`aria-pressed\`, for the naming reason set out in
 * \`libraries/libraries-section.ts\` — and a selector list spanning both would be
 * one rule that neither surface owns.
 *
 * The numbers are the DRAWING and not rhythm, which is why they stay literal
 * while every gap in this file is on the scale: 28x14 of padding box around a
 * 12px knob is 1px of clearance and 12px of travel, and the 1px insets follow
 * from the border under \`box-sizing: border-box\`. Moving any of them to a
 * spacing step would move the knob off centre.
 *
 * \`transform\`, never \`left\`: a knob animated on an inset is laid out again on
 * every frame, and these sit in a list that scrolls.
 */
.de-lib-switch {
  position: relative;
  flex: none;
  width: 28px; height: 16px;
  padding: 0;
  border: 1px solid ${t.color.borderInteractive}; border-radius: ${t.radius["3xl"]};
  background: ${t.color.field};
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, border-color ${t.duration.hover} ${t.ease},
    transform ${t.duration.hover} ${t.ease};
}
/* A 28x16 track is the drawing, not the target: 4px a side takes it to 24. */
.de-lib-switch::before {
  content: "";
  position: absolute; inset: -4px 0;
}
.de-lib-switch::after {
  content: "";
  position: absolute; left: 1px; top: 1px;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: ${t.color.text};
  transform: translateX(0);
  /* The knob's travel is a lateral move, so it takes the emphasized curve over a
     reveal; its ink flip is a colour change and takes the hover tween. */
  transition: transform ${t.duration.reveal} ${t.ease}, background-color ${t.duration.hover} ${t.ease};
}
${HOVER} { .de-lib-switch:hover { background: ${t.color.fieldHover}; } }
.de-lib-switch[aria-pressed="true"] {
  background: ${t.color.accentSurface};
  border-color: ${t.color.accentSurface};
}
${HOVER} {
  .de-lib-switch[aria-pressed="true"]:hover {
    background: ${t.color.accentSurfaceHover};
    border-color: ${t.color.accentSurfaceHover};
  }
}
/* The knob takes \`onAccent\` as it arrives: white on the indigo, 4.97:1 dark
   and 6.70:1 light. In light that flips it from ink to white, a second channel
   besides where the knob is; in dark it stays near-white and the track's fill
   carries the change. */
.de-lib-switch[aria-pressed="true"]::after {
  transform: translateX(12px);
  background: ${t.color.onAccent};
}
.de-lib-switch:active:not([disabled]) { transform: scale(0.98); }
/* A switch has no text to dim, so "disabled" has to land on the two things it
   does draw: the knob and the track's edge. Fading the whole control took the
   knob's contrast down with it, which blurs the one distinction a switch exists
   to make — OFF and DISABLED stopped being tellable apart. */
.de-lib-switch[disabled] { cursor: default; border-color: ${t.color.border}; }
.de-lib-switch[disabled]::after { background: ${t.color.textDisabled}; }
.de-lib-switch:focus-visible { ${FOCUS_RING} }

/*
 * NO LIBRARY-COMPONENT SECTION HERE ANY MORE.
 *
 * Seven rules — \`.de-lib-owner\`, \`.de-lib-desc\`, \`.de-lib-props\` and a
 * \`.de-lib-prop\` name/type/values trio — dressed a Design-tab section rendered
 * by \`panels/inspector/section-library-component.ts\`. That file does not exist:
 * what a selected component's own docs say is answered by the Code tab and by
 * the Assets details popover, both of which draw their own rows. The rules
 * outlived the section by a rewrite and shipped in every editor's stylesheet
 * with nothing on the page able to wear them.
 */

/*
 * Reduced motion keeps the fill and gives up the travel, the same bargain
 * \`css/annotations.ts\` strikes for its switch: the knob is simply already at
 * the other end, and nothing under a press squeezes. \`!important\` because the
 * blanket rule in base.ts that clamps every duration carries one.
 */
@media (prefers-reduced-motion: reduce) {
  .de-lib-switch::after { transition: background-color ${t.duration.hover} linear !important; }
  .de-lib-switch:active:not([disabled]) { transform: none; }
  /* The dialog keeps its fade and gives up the scale: travel goes, feedback stays. */
  .de-lib-signin { transform: none; }
  @starting-style { .de-lib-signin[open] { transform: none; } }
  /*
   * The blanket in \`css/base.ts\` clamps every duration to 0.01ms, which stops a
   * finite animation dead but leaves an INFINITE one looping thousands of times
   * a second. So the sweep has to be switched off by name and replaced with a
   * still wash: the scan still looks unlike a scan that has finished — a filled
   * track under the sentence, two rests where the rows will be — and nothing
   * travels.
   */
  .de-lib-status[data-de-busy]::after,
  .de-lib-signin-hint[data-de-busy]::after { animation: none; background: ${t.color.bgHoverQuiet}; }
  /*
   * The stagger goes whole rather than being clamped, because the blanket
   * reaches durations and not DELAYS: clamped alone, a reader who asked for
   * less motion would get no animation and still wait out the queue, which is
   * the delay without the effect. \`core/leave.ts\` makes the same call about its
   * settle timer.
   */
  .de-lib-candidate--arriving { animation: none; }
  /*
   * Same blind spot, the other way round: the blanket clamps the drawer's
   * transition but not the delay that hides its contents afterwards, so the
   * fold would report itself shut while a screen reader could still walk into
   * the path box inside it. There is no close left to wait for.
   */
  .de-lib-panel[hidden] { transition-delay: 0s; }
}
`
