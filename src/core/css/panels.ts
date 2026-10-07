/**
 * Panel shells, section chrome, and the shared field/select primitives.
 *
 * ## The rank ladder every surface in the chrome is written against
 *
 * Four ranks, and INK carries them. Weight marks only the top rank and the
 * chosen one. Size marks nothing: the editor keeps its 12px density, so body
 * and caption are both the kit's 12px caption role and `micro` (10) is for
 * marks only.
 *
 *   1 heading    `text` (a sub-heading: `textMuted`)  + `weightSection`
 *   2 value      `text`                               + `weightBody`,
 *                                                       `weightValue` when it
 *                                                       is the chosen one
 *   3 control    `textMuted`                          + `weightBody`
 *   4 secondary  `textDim`                            + `weightBody`
 *
 * GLYPH-ONLY ACTIONS ARE NOT ON THE LADDER. The kit is explicit that an
 * icon-only action wears full ink (`text`) at rest and in every state, because
 * its glyph is its whole label and a muted glyph reads as disabled. Status
 * marks (a chevron, a type glyph) are not actions and keep `textDim`.
 *
 * ## The hover and interaction rules
 *
 * Hover lands on an existing rung: a band on `bg` goes to `bgHoverQuiet`, a
 * row in a popover to `bgRaisedHover`, a field well to `fieldHover`, anything
 * 24px or under to `bgHover`. Hover paint only fires on a fine pointer
 * (`@media (hover: hover) and (pointer: fine)`), an open menu holds its
 * trigger's hover paint, a press is `scale(0.98)` except on menu triggers, and
 * focus rings are `:focus-visible` only (MICRO-INTERACTIONS § 1–3).
 */

import { tokens as t } from "../tokens"

/**
 * The corner every INPUT-SHAPED control in the chrome draws: fields, selects,
 * segmented tracks and the segments riding flush inside them, the align pad,
 * mini buttons.
 *
 * `radius.sm` (8), and that is the kit's ladder adapted to the editor's
 * density. The kit gives fields `radius["3xl"]` (16) on a 36px box; a 16px
 * corner on a 24px field is a pill, so a dense row takes the rung the kit
 * gives its small controls and glyph plates instead. Kit segmented tracks pad
 * 4px around an 8px segment; ours carry no padding (a 16px segment in a 24px
 * row is too small to hit), so the segment shares the rail's curve exactly.
 *
 * Exported so the token field, the layers filter, the Controls filter and the
 * library field all move with it.
 */
export const CONTROL_RADIUS = t.radius.sm

/**
 * The kit's keyboard-focus recipe (MICRO-INTERACTIONS § 3): the edge takes the
 * accent, plus a 3px halo of the accent at 30%. `FOCUS_RING` is for a control
 * with a 1px transparent border to recolour; `FOCUS_OUTLINE` paints the same
 * 1px edge with an inset outline for a control without one; `FOCUS_INSET` keeps
 * edge and halo inside the box, for cells in a clipped rail or full-bleed bands.
 */
const HALO = t.color.accentHalo
export const FOCUS_RING = `outline: none; border-color: ${t.color.accent}; box-shadow: 0 0 0 3px ${HALO};`
export const FOCUS_OUTLINE = `outline: 1px solid ${t.color.accent}; outline-offset: -1px; box-shadow: 0 0 0 3px ${HALO};`
export const FOCUS_INSET = `outline: none; box-shadow: inset 0 0 0 1px ${t.color.accent}, inset 0 0 0 4px ${HALO};`
/** The kit's press (MICRO-INTERACTIONS § 1): a 2% dip, never on a menu trigger. */
export const PRESS = "transform: scale(0.98);"

/**
 * THE CURSOR RULE, stated once because it was being decided per file.
 *
 * Every ENABLED interactive control in this chrome takes `cursor: pointer`.
 * `cursor: default` is for a disabled state and for surfaces that are not
 * controls at all. There is no third category.
 *
 * It needed saying because the split had grown to 40 rules against 15 with no
 * principle between them, and the disagreements were between neighbours rather
 * than between surfaces: `.de-token-field` is a button that opens a popover and
 * said `default` while `.de-select` — the same job, the same row in
 * `.de-paint-row` — said `pointer`. A layer row said `default` while the eye
 * button inside it said `pointer`. A reader cannot learn a vocabulary whose
 * two halves contradict each other an inch apart.
 *
 * Pointer won on the count and on the argument. `better-layout` asks that a
 * control read as a control, and a chrome that withholds the one free
 * affordance the platform offers — on some controls, unpredictably — is paying
 * that cost for nothing. The Figma-style no-pointer chrome is a defensible
 * alternative, but it is a decision about ALL of them, and it was never taken;
 * what existed was an accident with 40 votes on one side.
 */
export const panelsCss = `/* ---------- panels ---------- */
/*
 * The row the two panels and the canvas between them are laid out in.
 *
 * The panels used to be two independently \`position: fixed\` slabs pinned to
 * opposite edges, which is the simplest thing that draws the right picture and
 * the one thing a resize cannot be built on: neither slab had a parent in
 * common with the other, so there was no seam between them for a drag to be
 * ABOUT. \`motion-panels\` decides which edge a panel owns by looking at its
 * siblings for the one marked as filling, so the panels are now flex children
 * of this rail — left panel, seam, fill, seam, right panel — and the rail is
 * \`inset: 0\`, which makes a stretched flex child the exact rectangle the fixed
 * positioning produced. Nothing about either panel moved.
 *
 * \`overflow: clip\` is for the hidden state only: a parked panel translates its
 * own width past the viewport edge, and clipping what is already off-screen
 * costs nothing while keeping the rail from ever growing a scroll range.
 */
.de-rail {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: row;
  overflow: clip;
  pointer-events: none;
}
.de-rail > * { pointer-events: auto; }
/*
 * The canvas, as far as the resizing is concerned: an empty box the width of
 * whatever the panels have left.
 *
 * It paints nothing and it must never take a click — the app is underneath it,
 * and the editor's own canvas chrome is a separate layer in front. It exists
 * because it is what the library MEASURES: how far a drag can go is how much
 * room is in here, so the bound a panel stops at is the real gap on screen
 * rather than a number somebody guessed.
 */
.de-rail-fill { flex: 1 1 auto; min-width: 0; pointer-events: none; }

/*
 * Docked to the viewport edge, not floating in front of it.
 *
 * These used to be inset cards: 12px of app showing down the outside of each
 * one, rounded, with a shadow all the way round. That reads as a window lying
 * on top of the page — which is what it was, and the strip of live product
 * running down the far edge was the tell. It is dead space you cannot click
 * through to, it puts a second vertical edge beside the one the panel already
 * draws, and at the top and bottom it cuts the list short of the screen for no
 * gain in legibility.
 *
 * Docking spends that space on the panel instead, and ONE hairline on the inner
 * edge is the whole separation. No shadow in either direction.
 *
 * A directional cast across the canvas was the first thing tried here, on the
 * reasoning that a panel in front of the app should say so. It should not: the
 * panel is not in front of the app, it is beside it. Nothing overlaps, nothing
 * is occluded, and the two surfaces are already told apart by a hard value step
 * — dark chrome against a light product — which is a louder boundary than any
 * gradient. What the cast actually did was fog the first 20px of the app with a
 * dark gradient nobody asked for, so the edge of the canvas read as dirty
 * rather than as adjacent. The other three sides never had one; they meet the
 * viewport, where a shadow has nothing to fall on.
 */
.de-panel {
  /*
   * \`flex: none\` because the width is not the layout's to decide. It is a
   * MotionValue the resize lane writes as an inline style on every frame of a
   * drag; letting flex grow or shrink the panel as well would put two authors
   * on one number, and the loser is whichever ran last.
   */
  flex: none;
  align-self: stretch;
  position: relative;
  display: flex;
  flex-direction: column;
  background: ${t.color.bg};
  border: none;
  border-radius: 0;
  box-shadow: none;
  overflow: hidden;
}
/*
 * The inner edge is the one hairline in the chrome drawn against a colour we
 * do not control, so it is the STRONG rung and not the divider one.
 *
 * Every other rule in this file separates two surfaces we painted. This one
 * separates the editor from the product, and it cannot lean on a value step to
 * do that: an app in the same appearance as the chrome sits within a point or
 * two of \`bg\` — \`#171717\` is squarely in the range other people's dark themes
 * pick from, and \`#ffffff\` is most light ones — and at \`border\` the boundary
 * would be the faintest line on the screen, no heavier than the divider between
 * two rows of the same panel, for the one edge that has to say where the tool
 * stops. Against an app in the other appearance the step is enormous either
 * way, so the heavier rung costs nothing there.
 */
/*
 * The widths here are the ones the panel MOUNTS with, and after that the resize
 * lane overwrites them inline from the panel's own MotionValue. They are left
 * in the stylesheet rather than moved into script because they are also the
 * fallback: if \`shell/resize.ts\` ever fails to mount, the chrome still lays out
 * at the two widths it has always had instead of collapsing to nothing.
 */
.de-panel--left {
  width: ${t.size.panelWidth}px;
  border-right: 1px solid ${t.color.borderStrong};
}
.de-panel--right {
  width: ${t.size.inspectorWidth}px;
  border-left: 1px solid ${t.color.borderStrong};
}
/* An author \`display\` beats the UA [hidden] rule, so restate it. */
.de-panel[hidden] { display: none; }

/*
 * The seam: a real target, and nothing to look at.
 *
 * A resizable panel usually announces itself with a rail — a visible gutter, a
 * grip, a dotted handle. This one must not: the hairline between the chrome and
 * the product is the single most deliberate line in the editor (see the note on
 * \`borderStrong\` above), and putting a second edge beside it to drag would undo
 * the docking argument the panels are built on.
 *
 * So the separator is ${t.size.separatorHit}px wide and pulled back by half of that on each
 * side. It contributes exactly zero to the flex line — the panel's edge does not
 * move by a pixel — while still being a genuine box straddling the hairline,
 * half over the panel and half over the app, so the target is the same size
 * whichever side you reach from.
 *
 * Negative margins rather than a zero-width element with an overflowing
 * \`::after\`, which is the other way to get a target out of nothing and is worse
 * in two places that matter: an element with no box is reported as invisible by
 * anything measuring one, and a focus state has nothing to sit on.
 *
 * \`z-index\` puts it over both neighbours. The right seam comes BEFORE its panel
 * in the DOM, so without it the panel would paint over the half that overlaps
 * it and only the canvas side would be grabbable.
 */
.de-separator {
  flex: none;
  width: ${t.size.separatorHit}px;
  margin-inline: -${t.size.separatorHit / 2}px;
  align-self: stretch;
  position: relative;
  z-index: 1;
  cursor: col-resize;
  /* The library drives the drag from pointer events, so the browser must not
     also read the gesture as a scroll or a pinch on a touch screen. */
  touch-action: none;
  /*
   * Here rather than only in the library's own body lock, and the difference is
   * visible.
   *
   * \`motion-panels\` sets \`user-select: none\` on the body when a drag starts —
   * but a drag starts three pixels after the press, and by then the browser has
   * already begun a native text selection from wherever the pointer went down.
   * Turning selection off mid-gesture does not cancel one that is already
   * running, so it kept extending across the panel: a thin highlight band
   * tracking the pointer the whole width of the drag. Declaring it on the seam
   * means the press never starts a selection in the first place.
   */
  user-select: none; -webkit-user-select: none;
}
.de-separator[hidden] { display: none; }
/*
 * The tell: the panel's own hairline, repainted in the accent.
 *
 * Not a line BESIDE the border and not a wider line over it — the same pixel,
 * recoloured, so the edge lights up where it already is instead of thickening.
 * That is the whole hover state, and it is why the resting design is unchanged:
 * there is no new geometry on screen at any point, only a colour on one pixel
 * that was already being drawn.
 *
 * Which pixel depends on the side, because each panel draws its hairline as the
 * border on its own inner edge: the left panel's is the pixel immediately
 * before this item, the right panel's the pixel immediately after.
 *
 * \`data-resizing\` is set by the library for the length of a drag, so the line
 * stays lit once the pointer has left the strip — which it does immediately,
 * since the seam is travelling with it.
 */
.de-separator::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  width: ${t.size.hairline}px;
  background: transparent;
  transition: background-color ${t.duration.hover} ${t.ease};
}
.de-separator--left::before { right: ${t.size.separatorHit / 2}px; }
.de-separator--right::before { left: ${t.size.separatorHit / 2}px; }
@media (hover: hover) and (pointer: fine) {
  .de-separator:hover::before { background: ${t.color.accent}; }
}
.de-separator:focus-visible::before,
.de-separator[data-resizing]::before { background: ${t.color.accent}; }
/*
 * The seam is focusable — it is a real \`role="separator"\` and the arrow keys
 * resize it — so it needs a focus state, and the lit hairline above IS that
 * state. A ring cannot be: the element is zero-width, so an outline would draw
 * a 2px box around a line and be the one piece of geometry this whole surface
 * exists to avoid.
 */
.de-separator:focus-visible { outline: none; }

/*
 * Standing down: each panel leaves by the edge it is docked to.
 *
 * Purpose is spatial, not decorative — the panel does not dissolve, it goes
 * somewhere, and the same path in reverse is what makes the launcher read as
 * where it went. \`transform\` and \`visibility\` only: a width or an inset here
 * would relayout the app on every frame of the slide, and the app is the thing
 * the user is hiding the editor to look at.
 *
 * Exactly 100%, with nothing added. The panels used to park 24px further out
 * to get their shadow off the screen too; with no shadow to clear, the panel's
 * own width is the whole distance, and the extra travel would only be time
 * spent moving something already out of sight.
 *
 * \`visibility\` is what makes the parked panel inert — untabbable, unclickable
 * — and it is delayed by the full duration so it flips only once the panel has
 * finished leaving. Coming back it flips at 0s, so the panel is real for the
 * whole of its entrance.
 */
.de-panel {
  transition:
    transform ${t.duration.resize} ${t.ease},
    visibility 0s;
}
html.designlayer-chrome-hidden .de-panel {
  visibility: hidden;
  /*
   * 60ms behind the toolbar on the way out, level with it on the way back —
   * the delay lives on this rule, so it applies to the exit only. The
   * visibility flip is the sum: 60 of waiting plus the slide itself, computed
   * so it cannot fall out of step with the resize rung again (it said 300
   * against a 320 slide, and flipped the panel hidden 20ms early).
   */
  transition:
    transform ${t.duration.resize} ${t.ease} 60ms,
    visibility 0s linear ${60 + Number.parseFloat(t.duration.resize)}ms;
}
html.designlayer-chrome-hidden .de-panel--left { transform: translateX(-100%); }
html.designlayer-chrome-hidden .de-panel--right { transform: translateX(100%); }

.de-panel-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
/*
 * NO TRACK. A classic bar reserves 12px inside the pane, and every full-bleed
 * band (a section header's hover, a selected row) stopped that far short of the
 * panel's outer edge. The native bar is hidden and \`shell/overlay-scrollbar.ts\`
 * draws the thumb over the content instead, in the skin of the kit's
 * auto-hiding bar in css/base.ts: clear at rest, inked while scrolling.
 */
.de-panel-body, .de-panel .de-tabpanel { scrollbar-width: none; }
.de-scroll-thumb {
  position: absolute; top: 0; right: 0; z-index: 2;
  width: 12px;
  border: 3px solid transparent; background-clip: padding-box;
  border-radius: ${t.radius.sm}; corner-shape: round;
  background-color: transparent;
}
.de-scroll-thumb[hidden] { display: none; }
.de-scroll-thumb[data-scrolling] { background-color: ${t.color.scrollbarThumb}; }
.de-scroll-thumb:hover, .de-scroll-thumb[data-dragging] { background-color: ${t.color.scrollbarThumbHover}; }

.de-section { border-bottom: 1px solid ${t.color.border}; }
/*
 * A grid, and the actions column is reserved whether or not the header has an
 * action in it.
 *
 * With \`space-between\` the title of a section that owns a \`+\` sat at the same
 * left edge as one that does not — but the \`+\` itself was the only thing
 * holding the right edge, so Fill's add button and Effects' add button landed
 * wherever their titles left room, and scrolling the panel walked them left
 * and right. A fixed trailing track means every add sits on one line down the
 * panel, and a header without one leaves that line empty rather than closing
 * it up. \`auto\` as the max so a header that grows a second action still fits.
 */
.de-section-header {
  height: ${t.size.sectionHeader}px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(${t.size.miniSize}px, auto);
  align-items: center;
  /* The collapsible variant hangs its fold layer off this. */
  position: relative;
  /* Was \`0 8px 0 10px\`. The 10 was the only thing in the panel that started a
     column of its own: the body below pads to 8, so every section title sat two
     pixels right of the rows it heads and the left edge of the panel read as
     bent. One step, both sides. */
  padding: 0 ${t.space.sm}px;
  color: ${t.color.text};
  font-size: ${t.type.body}; font-weight: ${t.type.weightSection};
}
/* The bottom step is the heavier one on purpose: the header carries the air
   above the first row, and the 12 below the last one is the whole rest between
   this section's rows and the next section's hairline. */
.de-section-body {
  padding: ${t.space["2xs"]}px ${t.space.sm}px ${t.space.md}px;
  display: flex; flex-direction: column; gap: ${t.space.sm}px;
}
/* An author \`display\` beats the UA [hidden] rule, so restate it. This is the
   fold for a body that has NO \`.de-section-fold\` around it, and the wrapped
   case overrides it below. */
.de-section-body[hidden] { display: none; }

/*
 * THE FOLD, AND IT USED TO BE A \`display\` SWAP.
 *
 * Pressing a section header turned the chevron over and replaced the
 * body between two frames. The mark said a section was closing and the section
 * said it had always been shut; everything below it jumped by the height of
 * whatever had just ceased to exist, and the eye had nothing to follow to work
 * out what moved where. A disclosure is the canonical case for a height
 * transition and this was half of one.
 *
 * ## Why a grid row and not \`revealGroup\`
 *
 * \`core/leave.ts\` measures a height in JavaScript, and its own header says
 * what that is for: a group REBUILT on every render, where the collapsed state
 * has to be written inline at build time because the node is new. A section is
 * rebuilt too — but the fold is not pressed during a rebuild, it is pressed
 * against a node that has been sitting on screen, and the three things
 * \`.de-lib-drawer\` lists apply here word for word:
 *
 *  - it shuts as well as it opens, where \`revealGroup\` only opens;
 *  - a section body CHANGES while it is open (a scrub commit rewrites rows, a
 *    \`+\` adds one), and \`1fr\` re-resolves to whatever the section is now,
 *    where a measured pixel height would have to be measured again;
 *  - no JavaScript runs on the fold, so there is no timer to keep in step with
 *    the reduced-motion clamp in \`css/base.ts\`.
 *
 * A rebuild does not animate, and that matters as much as the press does: a
 * transition does not run on a node's FIRST style, so a section rebuilt shut
 * is simply shut and one rebuilt open is simply open. Only the attribute flip
 * on a node already in the document plays.
 *
 * ## Why this is a wrapper and not the body itself
 *
 * The body is padded, and a border box squeezed to zero still paints its
 * padding — 20px of section left behind after the fold has finished closing.
 * The clip layer has to be a box with no padding of its own, which is this
 * one. Same arrangement as \`.de-lib-drawer\` around \`.de-lib-panel\`.
 *
 * \`minmax(0, 0fr)\` rather than \`0fr\`: a bare \`0fr\` is \`minmax(auto, 0fr)\`,
 * and that automatic minimum is the item's own minimum contribution, which for
 * a padded flex column is its padding plus the tallest thing it holds. Naming
 * a floor of zero is what lets the track actually close; the body's
 * \`min-height: 0\` below is the other half and is just as load-bearing.
 *
 * \`reveal\` and not \`resize\`: 320ms is a whole panel changing width, and
 * this is a disclosure settling in inside one — the kit's surface-reveal tween
 * on its reveal curve.
 *
 * The column needs the same floor. With no \`grid-template-columns\` the one
 * implicit track is \`auto\`, which grows to the body's min-content width — and
 * a body holding a nowrap URL or code path has a min-content of 500px or more.
 * The track then ran past the panel edge, \`overflow: hidden\` cut it off, and
 * every row inside laid out against the wide track: ellipses never fired and
 * the right-hand controls sat outside the visible column. \`minmax(0, 1fr)\`
 * pins the track to the panel, and the body's \`min-width: 0\` below lets it
 * shrink into it.
 */
.de-section-fold {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
  /* A disclosure settling in: the kit's surface-reveal tween, 250ms reveal curve. */
  transition: grid-template-rows ${t.duration.reveal} ${t.easeReveal};
}
/*
 * Driven by the body's own \`hidden\`, not by the toggle's \`aria-expanded\`.
 *
 * Both are written in the same statement so either would work today. This one
 * ties the drawing to the fold's STATE: \`hidden\` is what the body IS, while
 * \`aria-expanded\` is what the button CLAIMS about it, and if the two ever
 * drift the box should follow the one that decides whether the controls inside
 * can be reached.
 */
.de-section-fold:has(> .de-section-body[hidden]) { grid-template-rows: minmax(0, 0fr); }
/*
 * THE BODY IS CLIPPED, NOT SQUASHED, and \`align-self\` is the whole of it.
 *
 * A grid item stretches to its row by default, so at \`0.4fr\` the body was 40%
 * of its own height — and a body is a flex COLUMN, whose children shrink along
 * the main axis, which here is the vertical one. Every row inside it therefore
 * re-laid-out on every frame of the fold: labels closed up on their fields,
 * the swatch grid lost its rows, and what the eye saw was the section being
 * crushed rather than rolled away. Measured at 90ms into a close, the fields
 * had already collapsed into each other while the box still had 45px to go.
 *
 * \`start\` takes the item out of the stretch, so it keeps its natural height
 * throughout and the shrinking row simply reveals less of it. Nothing inside
 * moves relative to anything else inside — the only thing that changes is how
 * much of the body there is to see, which is what a disclosure IS.
 *
 * And no fade rides along. One was tried: content dimming ahead of the box
 * left an empty dark band closing on its own for the back half of the gesture,
 * which is a worse artefact than the hard edge it was meant to soften. A clip
 * that travels this far over 250ms does not need help reading as a clip.
 *
 * \`min-height: 0\`: see \`.de-section-fold\`. A grid item's automatic minimum is
 * its content, and without a floor of zero on the item as well as on the track
 * the fold never shuts.
 */
.de-section-fold > .de-section-body {
  align-self: start;
  min-height: 0;
  min-width: 0;
}
/*
 * Inside the fold the body is never \`display: none\` — a box that is not laid
 * out has no height for the row above it to animate away from.
 *
 * \`visibility\` does the part of \`hidden\`'s job that still has to be done: it
 * takes a shut section's fields out of the tab order and off the accessibility
 * tree. Delayed by the length of the close, so the content is still there to
 * be seen going; immediate on the way back, or the section would open onto
 * nothing for the length of the fold.
 */
.de-section-fold > .de-section-body[hidden] {
  display: flex;
  visibility: hidden;
  transition: visibility 0s linear ${t.duration.reveal};
}

/*
 * Hover is one rung up from the element's OWN resting ground, and a full-bleed
 * band takes the quiet rung.
 *
 * This said \`bgRaised\`, which is the wrong name for it: \`bgRaised\` is the
 * surface a popover is BUILT from, not a state a panel row enters. Naming the
 * state means the two are cut separately — they already differ in both themes
 * — without a header silently following a popover.
 */
@media (hover: hover) and (pointer: fine) {
  .de-section-header--collapsible:hover { background: ${t.color.bgHoverQuiet}; }
}
/*
 * Three tracks: the title, then the add button, then the chevron on the
 * trailing edge.
 *
 * The add button no longer needs a reserved track to sit still in. It used to,
 * because it was the last thing in the bar and so the only thing holding the
 * right edge; now the chevron holds that edge on EVERY section, the adds are
 * measured off it, and the three that have one line up whatever their titles
 * do. A section without one leaves an empty track that costs nothing.
 */
.de-section-header--collapsible {
  grid-template-columns: minmax(0, 1fr) auto auto;
  column-gap: ${t.space.sm}px;
  /* On the bar rather than on the button: the whole bar folds, and the hand has
     to follow the pointer over the chevron and the empty middle too, neither of
     which is the button. */
  cursor: pointer;
}
/*
 * The fold target is a layer under the bar, not a box around its contents.
 *
 * With the title and the chevron on opposite ends of the header, one button
 * wrapping both would also have to wrap the add button between them, and a
 * button inside a button is invalid — so this one holds nothing and covers
 * everything. Being absolutely positioned it also paints above its in-flow
 * siblings, which is what makes a click anywhere along the bar fold the
 * section; the title and chevron underneath show through because it has no
 * background of its own.
 */
.de-section-toggle {
  position: absolute; inset: 0;
  padding: 0;
  border: none; background: transparent;
  cursor: pointer;
}
/* A full-bleed band, so the ring stays inside it rather than clipping at the
   panel edge. */
.de-section-toggle:focus-visible { ${FOCUS_INSET} }
/* A title longer than the panel wrapped to a second line inside a 32px header
   and got sliced through the x-height. Now that the title is a span of its own
   it can end in an ellipsis rather than a hard cut. */
.de-section-title {
  grid-column: 1;
  min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/*
 * A title that carries the section's hint as its tooltip. Lifted above the
 * fold layer so the pointer reaches it; a click still bubbles to the header,
 * so pressing the title folds the section as before. \`justify-self: start\`
 * keeps the hover area to the words rather than the whole track.
 */
.de-section-title--hint {
  position: relative; z-index: 1;
  justify-self: start;
  max-width: 100%;
  cursor: pointer;
}
.de-section-actions {
  grid-column: 2;
  /*
   * \`space.sm\`, matching the layers row's action strip, and it was
   * \`space["3xs"]\`. These are 18px \`miniSize\` plates whose \`::after\` pads them
   * out to a 24px target; at a 2px gap two adjacent targets are 20px apart and
   * their pads overlap, so the pointer lands on whichever the cascade happens
   * to put on top. The chrome has four of these strips and had solved the
   * spacing on two of them.
   */
  display: inline-flex; align-items: center; justify-content: flex-end; gap: ${t.space.sm}px;
  /* The one thing in the bar that takes its clicks back off the fold layer: a
     press on \`+\` must add a fill, not collapse the section it would land in. */
  position: relative; z-index: 1;
}
/*
 * The chevron is drawn, not pressed — and it does not sit on the fold layer
 * either way.
 *
 * The rotation below makes it a stacking context, so it paints in the same pass
 * as the absolutely positioned button and, being later in the DOM, lands on top
 * of it; \`pointer-events\` hands those clicks back down. That is belt and
 * braces rather than the mechanism: inspecting mode forces \`pointer-events: all\`
 * onto every \`<svg>\` in the document, which wins inside here, so what actually
 * makes a press on the glyph fold the section is the listener one level up on
 * the header (see \`section()\`).
 */
.de-section-header--collapsible > .de-chevron { grid-column: 3; pointer-events: none; }
.de-chevron {
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  color: ${t.color.textDim};
  transform: rotate(90deg);
  /*
   * The quarter turn, on the same clock as the thing it describes.
   *
   * The body animates (\`.de-section-fold\` above), so the two are one gesture
   * and take one duration and curve; a chevron that finishes its turn early
   * reads as a separate little control that happens to sit in the bar.
   *
   * The chevron is a status mark, not an action (the whole bar is the
   * action), so it keeps \`textDim\` rather than the full ink of icon-only
   * buttons.
   *
   * One rule reaches every collapsible section in the chrome, and the blanket in
   * \`css/base.ts\` already clamps it for reduced motion.
   */
  transition: transform ${t.duration.reveal} ${t.easeReveal};
}
/* The fold state lives on the header now, not on the button: the chevron is no
   longer a child of the button that turns it. */
.de-section-header--collapsed .de-chevron { transform: rotate(0deg); }

/* Vertical rhythm inside a section body — one rule instead of an inline style. */
.de-stack { display: flex; flex-direction: column; gap: ${t.space.sm}px; }
.de-layout-group { display: flex; flex-direction: column; gap: ${t.space.sm}px; }
/* The step above the rule is the tight one and the step below it the group one:
   this is a boundary between two runs of controls, so it has to out-measure the
   gap inside either run or the rule is doing the separating on its own. */
/*
 * The space does it, so the line came out.
 *
 * This drew 4px of margin AND 12px of padding AND a hairline — 16px of air
 * between two runs whose internal gap is 8, which is already the 2x the rule
 * above asks for. The comment two lines up says exactly that ("it has to
 * out-measure the gap inside either run"), and then the rule hedged by adding a
 * border on top of a separation that had already worked.
 *
 * Space first, lines last and only where space alone cannot carry it: with 16
 * against 8 it plainly can. \`.de-section\`'s own \`border-bottom\` stays, because
 * a twelve-section settings column IS the dense case the exemption is for; two
 * runs of controls inside one section is not.
 */
.de-layout-group + .de-layout-group {
  margin-top: ${t.space["2xs"]}px;
  padding-top: ${t.space.md}px;
}
/*
 * ─────────────────────────────────────────────────────────────────────────
 * THE FOUR LABEL RANKS, and every label in the panel is exactly one of them.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Four and only four:
 *
 *   rank      here                                  example
 *   section   body / weightSection / text           "Position"
 *   caption   caption / weightValue / textDim       "Alignment"
 *   label     body / weightBody / textMuted         the "W" in a field
 *   value     body / weightBody / text              the "708" beside it
 *
 * All four are the kit's 12px caption role (the editor keeps its density), so
 * the ranks are carried by ink and weight: a section header carries the
 * strong weight, the caption the kit caption weight in the quietest ink, and
 * the label/value pair is separated by ink alone. \`micro\` (10px) is the
 * floor for a MARK rather than for words you read.
 *
 * The audit that produced this block found three collisions, all invisible in
 * review and all obvious in a table:
 *
 *   - \`.de-layout-group-title\` was 12/600/textMuted while \`.de-section-title\`
 *     was 12/600/text. Same size, same weight, two different inks, for two
 *     things that look like the same rank because they ARE: "Auto layout" is a
 *     section header in Figma, sitting at the same weight as "Position". A
 *     reader cannot learn a hierarchy whose third rung differs from its first
 *     only by a shade of grey.
 *   - \`.de-hint\` and \`.de-group-caption\` were both textDim, at two sizes. They
 *     are different things — one names the control below it, the other explains
 *     what a write will do — so the caption takes the caption weight and the
 *     hint takes the reading leading, where a sentence belongs.
 *   - \`.de-field-suffix\` sat at textDim beside a textMuted label, so a unit
 *     printed on a field outranked nothing and read as disabled. It is the same
 *     rank as the label it shares a box with.
 *
 * Nothing here sets a size or weight that is not one of the four rows above. A
 * fifth rung is how the first three stop meaning anything.
 */
/*
 * A heading BINDS DOWN to the block it names, and it did not.
 *
 * \`.de-group-caption\` a few hundred lines below already argues this exact
 * asymmetry one rung lower: a caption sits \`space["2xs"]\` above the control it
 * names and \`space.sm\` from the next group, so it reads as belonging to what
 * follows rather than floating between two things. The rule was never applied
 * to the rung above it.
 *
 * So a sub-heading was the bare first child of a \`space.sm\` stack — 8px above,
 * 8px below, a ratio of 1.0 where the grouping rule wants at least 2. On the
 * Responsive section that put a title, three lines of prose and a field all at
 * the same 8px, and the NEXT block's title at 8px too: five things in one
 * column with nothing in the spacing saying which of them belong together.
 *
 * A negative bottom margin rather than restructuring the sections, because the
 * stack that owns the gap is shared by six call sites and three of them have no
 * heading at all. This closes the gap under the heading to \`space["2xs"]\` and
 * leaves the \`space.sm\` between blocks standing, which is the 2x the rule
 * asks for, without any of those call sites changing.
 */
.de-layout-group-title {
  color: ${t.color.text};
  font-size: ${t.type.body};
  font-weight: ${t.type.weightSection};
  margin-bottom: -${t.space["2xs"]}px;
}
/* A sentence, not a name — so it keeps the body size a caption gives up, and
   the quietest ink, because it is the one thing in a section you can finish
   reading and never look at again. */
.de-hint { color: ${t.color.textDim}; font-size: ${t.type.body}; line-height: ${t.type.leadingBody}; }

/* Where something lives in the source — a file:line under a responsive measure,
   and the owner of a breakpoint. \`.de-tagname\` sat beside this and drew the
   tag name in the inspector's identity header; that header is gone, because the
   layer row, the canvas label and the Code tab each already said one part of
   what it repeated. Nothing wears the class now. */
.de-source { font-size: ${t.type.body}; color: ${t.color.textDim}; word-break: break-all; }

.de-row { display: flex; align-items: center; gap: ${t.space.sm}px; }
/*
 * TWO GAPS, NOT ONE, and the shorthand was quietly saying the wrong thing.
 *
 * \`gap: \${t.space.sm}px\` sets the row gap AND the column gap to 8. Eight is
 * also what \`.de-section-body\` and \`.de-stack\` put BETWEEN groups. So in the
 * Position section the gutter between the X and Y fields — two items inside one
 * captioned group — was 8px, and the distance from the whole Position group to
 * the whole Size group was also 8px. Nothing in the rhythm said which pair
 * belonged together; the grouping rule wants twice as much between groups as
 * within one, and this measured 1.0.
 *
 * The column gap drops to \`space["2xs"]\`, which makes it 8/4 = 2.0 and is not a new
 * number: 4px between two adjacent wells is what \`.de-paint-row\` already uses a
 * few rules down. It also hands 4px of width back to a 260px column, where
 * every pixel is spoken for.
 *
 * The ROW gap stays at 8. These grids wrap to a second line in the Size and
 * Position sections, and a wrapped row is a new pair of items rather than a
 * tighter version of the one above — halving it there would merge two rows into
 * one block.
 *
 * Honest caveat, recorded because the audit that found this made it: the
 * comparison is cross-axis — horizontal within a row against vertical between
 * groups — and the rule is usually read as same-axis. Every same-axis ratio in
 * this panel already clears 2.0. The change is made anyway because the reader's
 * eye does not know which axis it is crossing; it only sees which things are
 * nearer each other.
 */
.de-row--split {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: ${t.space.sm}px ${t.space["2xs"]}px;
}
.de-row--quad {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: ${t.space.sm}px ${t.space["2xs"]}px;
}

/*
 * Every field rests in a well.
 *
 * These were transparent until hovered, on the theory that a quiet panel is a
 * calm one. It is not: a section of eight numbers with nothing behind them
 * reads as eight pieces of loose text, and you have to sweep the pointer along
 * the column to find out which of them you are allowed to touch. Giving each
 * one a resting surface is what turns the column into a form — the affordance
 * is visible before the pointer arrives, and the row edges align the values
 * for free. Hover lifts the same well rather than drawing a border, so nothing
 * shifts by a pixel on the way in; the border is spent on focus instead, where
 * it is the one state worth an accent.
 *
 * Horizontal padding lives on the *parts*, not here, so the leading label can
 * be a full-height strip you can grab anywhere rather than a word with dead
 * space above and below it.
 *
 * The well is the kit's field (\`.ui-field\`): filled, borderless at rest, the
 * \`field\` role with \`fieldHover\` one rung on. The border is spent only on
 * keyboard focus, where it takes the accent.
 */
.de-field {
  display: flex; align-items: center;
  height: ${t.size.rowHeight}px;
  border-radius: ${CONTROL_RADIUS};
  background: ${t.color.field};
  border: 1px solid transparent;
  overflow: hidden;
  transition: border-color ${t.duration.hover} ${t.ease}, background-color ${t.duration.hover} ${t.ease};
}
@media (hover: hover) and (pointer: fine) {
  .de-field:hover { background: ${t.color.fieldHover}; }
}
.de-field:has(:focus-visible) { border-color: ${t.color.accent}; }
/*
 * The label is a CONTROL, not metadata, so it takes the label ink and not the
 * secondary one.
 *
 * It was \`textDim\` — the same ink as the unit suffix two boxes to its right —
 * and the two are not the same kind of thing: you can grab this one and scrub
 * the value with it, and \`px\` is a word printed on the field. In a row of
 * eight fields the only ranked things are the label, the number and the unit,
 * and two of the three were identical. \`textMuted\` on the well measures 9.2:1
 * dark and 9.7:1 light, against \`textDim\`'s 8.2:1 and 5.2:1.
 */
.de-field-label {
  flex: none; align-self: stretch;
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 12px;
  /* The tight step, where the gaps AROUND the field take the workhorse one.
     Two fields share a 240px panel on a split row, leaving about 108px each for
     a label strip, a number and a unit; at ${t.space.sm} a side the strip alone
     eats 28 of them and a four-digit value starts clipping. Inside a control
     this dense, the difference between 4 and 8 is a digit. */
  padding: 0 ${t.space["2xs"]}px;
  color: ${t.color.textMuted};
  font-size: ${t.type.body};
  user-select: none;
  cursor: ew-resize;
  transition: background-color ${t.duration.hover} ${t.ease}, color ${t.duration.hover} ${t.ease};
}
/*
 * THE SCRUB SAYS SO WHILE IT IS HAPPENING.
 *
 * \`cursor: ew-resize\` is the only thing that ever admitted this label is a
 * control, and a cursor is an offer, not an acknowledgement: press and drag and
 * the number counts, but nothing on the control confirms that the gesture — not
 * the pointer drifting over a panel — is what is driving it. On a 24px row with
 * eight neighbours that ambiguity is the whole reason the most powerful
 * interaction in the inspector is also the least discovered.
 *
 * The lit state is the same pair a pressed \`.de-mini\` takes, so "this control
 * is engaged" is one appearance in the panel rather than two, on the kit's
 * 150ms hover tween.
 *
 * The class is written by \`field.ts\` on pointerdown and cleared on pointerup,
 * so it also survives the pointer leaving the label mid-drag, which capture
 * makes common and \`:active\` alone would not cover.
 */
/*
 * The ink is \`text\`, not \`accent\`, and the tint alone carries the accent.
 *
 * Accent-on-\`accentSoft\` is 3.53:1 in dark (5.92:1 in light). A tinted plate
 * under a MARK owes 3:1 and would be fine; this plate is under a WORD — the
 * field's label, "W" or "Opacity" — and a word owes 4.5:1. The one thing the
 * reader needs while dragging is which field is moving, and it would be the
 * least legible text in the panel for exactly as long as the drag lasted.
 *
 * Found by the contrast sweep in \`tools/contrast.ts\`, not by eye, and it is
 * the kind of pair that is hard to see: accent-on-accent-wash looks deliberate,
 * reads as a system, and is a ratio nobody checks because both halves came out
 * of the palette. \`text\` is 12.9:1 dark and 16.9:1 light; the wash still says
 * "accent", so nothing about the treatment's meaning moved.
 */
.de-field-label--scrubbing {
  background: ${t.color.accentSoft};
  color: ${t.color.text};
}
.de-field--scrubbing { border-color: ${t.color.accent}; }
.de-field input {
  flex: 1; min-width: 0; width: 100%;
  padding: 0 ${t.space["2xs"]}px 0 0;
  border: none; background: transparent; outline: none;
  color: ${t.color.text}; font-family: inherit; font-size: ${t.type.body};
}
.de-field input::-webkit-outer-spin-button,
.de-field input::-webkit-inner-spin-button { appearance: none; margin: 0; }
.de-field input[disabled] { color: ${t.color.textDim}; cursor: default; }
.de-field input::placeholder { color: ${t.color.textDim}; }
/*
 * Pushed to the far edge by the flexed input.
 *
 * The LABEL rank, not the dim one. A unit and the letter at the other end of
 * the same box are the same kind of thing — printed on the field, naming what
 * the number means — and they were two ranks apart, which put \`%\` at the ink
 * this panel uses for a disabled control. See the ranks table above.
 */
.de-field-suffix {
  flex: none;
  padding-right: ${t.space["2xs"]}px;
  color: ${t.color.textMuted}; font-size: ${t.type.body};
}
/*
 * A measured value in a field's clothes — read-only, so it never takes a caret.
 *
 * SELECTABLE, which it was not, and neither was the \`px\` above it.
 *
 * Both carried \`user-select: none\`, copied down the row from \`.de-field-label\`,
 * where it is correct: that label is a scrub handle, a press on it starts a
 * drag, and a drag that highlights text as it travels is a drag fighting the
 * browser. Neither of these two is draggable. They are the row's OUTPUT — the
 * computed width, the resolved gap, the unit it is in — which is the content a
 * designer is most likely to want out of this panel and into a message, and the
 * suppression meant a selection swept across the row came back as a number with
 * no unit on it, or as nothing at all.
 *
 * \`better-typography\` is direct about the shape: suppression "belongs on a
 * draggable or gesture-driven surface where accidental selection interferes.
 * Never across the interface". The handle keeps it; the readout does not.
 */
.de-field-value {
  flex: 1; min-width: 0;
  padding-right: ${t.space["2xs"]}px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: ${t.color.text}; font-size: ${t.type.body};
}

/* ---------- paint rows (fill / stroke / effects) ---------- */
/*
 * THE COLOUR WELL, WHICH USED TO ANSWER NOTHING.
 *
 * Every other control in this panel tells you the pointer has found it. This
 * one had eight inline declarations, no class, and therefore no state at all —
 * the single most clickable-looking thing in the inspector, and the only one
 * that stayed completely still under the cursor.
 *
 * The hover mark is a RING rather than a tint, and that is forced rather than
 * chosen: the well's whole surface is the colour it holds, so tinting it would
 * misreport the value. A ring sits outside the paint and cannot. It is drawn as
 * two stacked shadows — a \`bg\` spacer then the ring proper — so it reads
 * against both a light fill and a dark one without knowing which it is on.
 *
 * The press is the kit's 2% dip and the focus ring its accent edge plus halo,
 * so a keyboard reaches it the same way it reaches everything else.
 *
 * \`data-de-unparsed\` is the honest case: a colour this editor cannot convert
 * shows as black because \`<input type=color>\` can hold nothing else, so the
 * well says so with a dashed edge instead of asserting a black the element does
 * not have. See the note in \`inspector/color.ts\`.
 */
.de-color-well {
  cursor: pointer;
  background: transparent;
  border: 1px solid ${t.color.border};
  border-radius: ${t.radius.xs};
  transition: box-shadow ${t.duration.hover} ${t.ease}, border-color ${t.duration.hover} ${t.ease},
    transform ${t.duration.hover} ${t.ease};
}
@media (hover: hover) and (pointer: fine) {
  .de-color-well:hover {
    box-shadow: 0 0 0 2px ${t.color.bg}, 0 0 0 3px ${t.color.borderInteractive};
  }
}
.de-color-well:active { ${PRESS} }
.de-color-well:focus-visible { ${FOCUS_RING} }
.de-color-well[data-de-unparsed] { border-style: dashed; border-color: ${t.color.borderInteractive}; }

/*
 * A CLASS CHIP LEAVES SIDEWAYS.
 *
 * Chips wrap inside one row, so what closes over a removed chip is the gap
 * beside it rather than the space under it — which is why this is not
 * \`.de-leaving\`, whose whole job is collapsing a height. Everything that takes
 * horizontal space goes with it, or the row keeps a few pixels of nothing where
 * the chip was.
 *
 * \`inspector/section-classes.ts\` pins the measured width first, for the reason
 * \`core/leave.ts\` pins a height: a chip's width is its content's, so there is
 * no value for CSS to animate from. The global blanket in \`css/base.ts\` clamps
 * the duration under reduced motion and the module drops its timer to match.
 */
.de-class-chip {
  overflow: hidden;
  transition:
    max-width ${t.duration.reveal} ${t.ease},
    opacity ${t.duration.hover} ${t.ease},
    padding ${t.duration.reveal} ${t.ease},
    margin ${t.duration.reveal} ${t.ease};
}
.de-chip--leaving {
  max-width: 0 !important;
  opacity: 0;
  padding-left: 0 !important;
  padding-right: 0 !important;
  margin-right: calc(-1 * ${t.space["2xs"]}px) !important;
  pointer-events: none;
}

.de-paint-row { display: flex; align-items: center; gap: ${t.space["2xs"]}px; }
.de-paint-row .de-field { flex: 1; min-width: 0; }
.de-paint-row .de-select { flex: 1; min-width: 0; }
/* The third cell that can hold the row's value, and the newest. A paint row now
   shows its token binding where the plain hex used to sit \u2014 the swatch, then
   either \`Ink/Primary\` or \`#1b2e5d\` \u2014 so the field has to size like the two
   above it. It does not inherit their rule: \`.de-token-field\` is a button and
   carries \`width: 100%\`, which as a flex basis claims the whole row and pushes
   the opacity field and the eye off the end. */
.de-paint-row .de-token-field { flex: 1; min-width: 0; }
/* The row's payload, so it takes the value ink the way \`.de-field-value\` does.
   Two read-only values in the same panel at two different ranks is not a
   hierarchy, it is an accident of which file each was written in. */
.de-paint-value {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: ${t.color.text};
  font-family: ${t.font.mono}; font-size: ${t.type.body};
}
/* Not a nest, and the guard in \`test/concentric-cases.mjs\` records why: the
   card's first child is a ROW, and the 20px swatch at its left end is centred
   in a 24px band, so it sits 4px in horizontally and 6px down. Nothing here
   reaches a corner, so there is no curve for anything to be parallel to. */
/* The kit's card surface (\`.card-surface\`): the panel ground inside one
   structural hairline, no shadow because it is docked. It was filled with
   \`bgSunken\`, which is the same rung as the fields it holds, so the wells
   inside it disappeared. \`radius.lg\` with a 4px inset puts the fields' 8px
   corner concentric with the card's, as the kit's segmented track does. */
.de-paint-card {
  display: flex; flex-direction: column; gap: ${t.space["2xs"]}px;
  padding: ${t.space["2xs"]}px;
  background: ${t.color.bg};
  border: 1px solid ${t.color.border}; border-radius: ${t.radius.lg};
}

/*
 * Ghost buttons: no surface of their own, a surface on hover, an accent
 * OUTLINE when they are holding a state on.
 *
 * The border is transparent at rest rather than absent, so turning one on adds
 * a colour and never a box — a pressed \`+\` used to grow a ring the same frame
 * it changed meaning, and the row under it stepped down a pixel. Outline
 * rather than fill for the on state because these sit inside a section header
 * or a row that already carries a well behind it; a second filled surface at
 * this size reads as a badge, not a toggle.
 */
.de-mini {
  position: relative;
  width: ${t.size.miniSize}px; height: ${t.size.miniSize}px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: ${CONTROL_RADIUS};
  /* Icon-only, so full ink at rest and in every state (kit § 6). */
  background: transparent; color: ${t.color.text};
  font-family: inherit; font-size: ${t.type.body}; line-height: ${t.type.leadingFlush};
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, color ${t.duration.hover} ${t.ease},
    border-color ${t.duration.hover} ${t.ease}, box-shadow ${t.duration.hover} ${t.ease},
    transform ${t.duration.hover} ${t.ease};
}
/*
 * The kit's press. These are the smallest pressable things in the chrome and
 * several of them are destructive — the row bin, the swatch clear — so the
 * press landing is precisely the frame that matters. Not on a menu trigger,
 * whose opening menu is the feedback.
 */
.de-mini:active:not([disabled], [aria-haspopup]) { ${PRESS} }
/*
 * The drawing is 18px; the target is the full row height.
 *
 * \`miniSize\` is the size the button LOOKS, and it is three pixels short of the
 * 24px a pointer is entitled to — but growing the box would grow the plate a
 * hover paints, and a row of 24px plates in a 32px section header reads as a
 * toolbar. A hit pad is the way to have both. Vertical only: these sit two and
 * three to a row on gaps as tight as 4px, so three pixels of horizontal reach each would
 * overlap, and a click landing on the neighbour of a destructive button is a
 * worse defect than the one being fixed. 18x24 until \`miniSize\` itself moves.
 *
 * 4 and not 3, unlike the identical pads on \`.de-layer-action\` and
 * \`.de-option-delete\`: an absolutely positioned child is laid out against its
 * ancestor's PADDING box, and this button carries a 1px transparent border for
 * its pressed state. Insetting by 3 off a 16px padding box gives a 22px target,
 * two short, and it measured that way before it was measured.
 *
 * So this stays a literal while every other inset in this file moved onto
 * \`space\`. The number is not rhythm, it is what is left of the row once the
 * plate and its border are taken out — write \`space["2xs"]\` here and the next edit
 * to \`miniSize\` or to the scale silently resizes a hit target instead of
 * respacing a gap.
 */
.de-mini::after {
  content: ""; position: absolute; inset: -4px 0;
}
@media (hover: hover) and (pointer: fine) {
  .de-mini:hover { background: ${t.color.bgHover}; }
  .de-mini--danger:hover { background: ${t.color.dangerWash}; color: ${t.color.danger}; }
}
/* An open menu holds its trigger's hover paint. */
.de-mini:is([aria-expanded="true"], [data-state="open"]) { background: ${t.color.bgHover}; }
/* The same tinted plate a standalone \`.de-tool\` takes: selection is a hue
   fill, and the glyph keeps full ink like every other state of an icon-only
   action. */
.de-mini[aria-pressed="true"] { background: ${t.color.accentSoft}; }
/*
 * Dark ink on a danger fill, never white. \`danger\` is a LIGHT coral in dark
 * and white on it measures 2.89:1, so the glyph disappears at exactly the
 * moment the button becomes destructive.
 *
 * \`onSemantic\` is the flipping ink for that, not \`onAccent\`, which is white in
 * both themes. 6.61:1 on the dark coral; see its note in \`tokens.ts\`.
 */
/*
 * Disabled is quieter, not gone.
 *
 * At \`opacity: 0.35\` the glyph was \`textDim\` faded to a fraction of itself —
 * the section header's second \`+\` was not a dim button, it was an empty
 * square, and this is the state the "labels the same colour as the button"
 * report was pointing at. WCAG exempts disabled controls from contrast, which
 * is exactly how it got here; a control you cannot see is still a control you
 * cannot find, and the user has to know the affordance exists before "it is off
 * right now" means anything.
 *
 * It is the \`textDisabled\` role, 7.44:1 dark and 5.77:1 light on the panel,
 * stated as a colour rather than as a fraction of one. The fraction was the
 * fragile part: it is computed against whatever the button is sitting on, so
 * the ratio moved when the row under it did.
 */
.de-mini[disabled] { color: ${t.color.textDisabled}; cursor: default; background: transparent; }
.de-mini:focus-visible { ${FOCUS_RING} }

/*
 * The toolbar's icon button, borrowed by inspector sections (align, direction).
 *
 * It is sized for the toolbar, where it is the pointer's first target; in a
 * panel row it has to line up with the 24px fields beside it. Scoped to
 * \`.de-panel\` so the toolbar keeps its own.
 *
 * THE PRESSED STATE IS A TINT NOW, NOT AN OUTLINE, and the reason is that the
 * outline was the third dialect of one sentence.
 *
 * A panel tool said "on" with an accent ring and accent ink; a segment said it
 * with a neutral fill; a mini said it with an accent ring at a different size
 * and radius. All three sit inside the same section, within 8px of one another,
 * and all three mean exactly "this one is chosen". There are two treatments,
 * assigned by what KIND of choice it is: one-of-several takes the
 * \`segmentSelected\` fill (\`.de-segment\`, \`.de-iseg\`, \`.de-agroup\` below), and
 * a standalone on/off takes a tinted plate.
 *
 * This rule is that second one, and it is the right one for a bare \`.de-tool\`
 * precisely because a bare tool is the case with no rail around it: there is no
 * group for a chip to be one-of, so the button has to carry the whole signal
 * itself. The kit's selection is a HUE (\`accentSoft\`), and the glyph keeps
 * full ink, because an icon-only action wears full ink in every state.
 *
 * A tool INSIDE \`.de-agroup\` or \`.de-iseg\` is overridden back to the chip by
 * those rules, which are more specific. That is the whole taxonomy: tinted when
 * alone, chipped when in a group.
 */
.de-panel .de-tool {
  width: ${t.size.rowHeight}px; height: ${t.size.rowHeight}px;
  border: 1px solid transparent;
  border-radius: ${CONTROL_RADIUS};
  color: ${t.color.text};
  transition: background-color ${t.duration.hover} ${t.ease}, color ${t.duration.hover} ${t.ease},
    border-color ${t.duration.hover} ${t.ease}, box-shadow ${t.duration.hover} ${t.ease},
    transform ${t.duration.hover} ${t.ease};
}
@media (hover: hover) and (pointer: fine) {
  .de-panel .de-tool:hover { background: ${t.color.bgHover}; color: ${t.color.text}; }
}
.de-panel .de-tool:active:not([disabled], [aria-haspopup]) { ${PRESS} }
.de-panel .de-tool:focus-visible { ${FOCUS_RING} }
.de-panel .de-tool[aria-pressed="true"] {
  background: ${t.color.accentSoft};
  border-color: transparent;
  color: ${t.color.text};
}
/* Disabled outranks pressed: an arrange arrow at the end of its list is still
   drawn in whatever state it was holding, and a tinted plate under dead ink
   reads as a control that is both on and unavailable. */
.de-panel .de-tool[disabled] {
  background: transparent;
  border-color: transparent;
  color: ${t.color.textDisabled};
  cursor: default;
}

/* ---------- segmented control ---------- */
/*
 * An inset track carrying one lifted pill.
 *
 * The rail is a field well, because that is what the control is: one field
 * whose value happens to be a word from a short list, and it has to sit in a
 * row beside real fields without looking like a different species. The
 * selection was a filled accent, which at this size — three of them stacked in
 * Auto layout — turned the section into a wall of indigo and shouted about
 * defaults nobody chose. A neutral step off the rail says "this one" quietly,
 * and the ink going from muted to full carries the rest of the message.
 */
/*
 * THE RAIL LOST ITS PADDING, and that is the whole shape change.
 *
 * The kit's track pads 4px around its segments; at editor density that leaves
 * a 16px segment inside a 24px box, too small to hit. So the chosen chip IS the
 * cell, edge to edge, the two curves coincide rather than nest, and a segment is
 * the full \`rowHeight\` like every other control in the panel.
 *
 * WHAT MARKS THE CHOSEN ONE: the kit's \`segmentSelected\` FILL, darker than
 * its track in light, with no shadow and no hairline (MICRO-INTERACTIONS § 9).
 * It used to be a white raised chip with an edge, which claimed an elevation
 * the chosen segment does not have. Hover changes the ink only, so the fill
 * means one thing.
 *
 * Still neutral rather than accent-filled, for the reason the previous note
 * gives and this one keeps: three of these stack in Auto layout, and an indigo
 * slab on each would shout about defaults nobody chose.
 */
.de-segmented {
  display: flex; align-items: stretch;
  height: ${t.size.rowHeight}px;
  border-radius: ${CONTROL_RADIUS};
  background: ${t.color.field};
  /* The containing block for the chip below. */
  position: relative;
}
/*
 * THE CHOSEN CHIP IS ONE OBJECT THAT MOVES.
 *
 * It used to be the segment's own background, which makes the selection two
 * boxes taking turns: the old chip vanishes and a new one appears, and the eye
 * is given nothing to follow between two words 60px apart. A segmented
 * control's whole affordance is that the choice is a thing you can watch move
 * along the rail.
 *
 * Exactly the fill the segment draws, so the control is identical at rest and
 * differs only in transit, on the kit's 150ms tween.
 *
 * Behind the words — \`.de-segment\` takes an index below — and
 * \`pointer-events: none\`, so the chip can never take a click meant for the
 * segment it is sitting on.
 *
 * Guarded on \`[data-de-thumb]\`, which \`inspector/field.ts\` sets only once it
 * holds a real measurement. Unmeasured — JSDOM, or a panel that has not painted
 * — the segment keeps the tint it always drew and nothing is lost.
 */
.de-segment-thumb {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: var(--de-thumb-w, 0px);
  transform: translateX(var(--de-thumb-x, 0px));
  border-radius: ${CONTROL_RADIUS};
  background: ${t.color.segmentSelected};
  opacity: 0;
  pointer-events: none;
  transition:
    transform ${t.duration.hover} ${t.ease},
    width ${t.duration.hover} ${t.ease},
    opacity ${t.duration.hover} ${t.ease};
}
.de-segmented[data-de-thumb] .de-segment-thumb { opacity: 1; }
/* Once the chip is real it owns the surface and the segment stops drawing one:
   two grounds at the same value, one of them travelling, reads as a smear. */
.de-segmented[data-de-thumb] .de-segment[aria-pressed="true"] {
  background: transparent;
  border-color: transparent;
}
.de-segment {
  flex: 1; min-width: 0;
  /* Above the chip, which is an earlier sibling and would otherwise paint over
     the word it is meant to sit behind. */
  position: relative;
  z-index: 1;
  /* A transparent hairline at rest, so taking the state adds a COLOUR and never
     a box — the same rule \`.de-mini\` follows. Without it the chosen segment
     grows 2px and shoves its neighbours along the rail. */
  border: 1px solid transparent; border-radius: ${CONTROL_RADIUS};
  background: transparent; color: ${t.color.textMuted};
  /* One weight for every segment, as the kit's segmented control has: a weight
     that changes with selection reflows the label it marks. */
  font-family: inherit; font-size: ${t.type.body}; font-weight: ${t.type.weightValue};
  line-height: ${t.type.leadingFlush};
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, color ${t.duration.hover} ${t.ease};
}
@media (hover: hover) and (pointer: fine) {
  .de-segment:hover { color: ${t.color.text}; }
}
.de-segment[aria-pressed="true"] {
  background: ${t.color.segmentSelected};
  color: ${t.color.text};
}
.de-segment:focus-visible { ${FOCUS_INSET} }

/* ---------- captioned control groups ---------- */
/*
 * The label above a control, which this panel did not have and Figma's has
 * everywhere: \`Alignment\`, \`Position\`, \`Rotation\`, \`Flow\`, \`Dimensions\`,
 * \`Gap\`, \`Padding\`. Seven captions in two sections.
 *
 * Without them a section is a stack of controls you identify by recognising the
 * glyphs in it, which works for the six align marks and fails for everything
 * that is a number in a box: a 24px field holding \`0\` says nothing about
 * whether it is a gap, a rotation or a padding. The section header cannot carry
 * that — it names the whole group, and the whole group is the thing that has
 * five different answers in it.
 *
 * \`caption\` rather than \`micro\`: Figma's measures about 10px and ours would be
 * legible at that rung, but \`micro\` is documented as the floor for a MARK — an
 * eyebrow, a numeral in a chip — and these are words you read. One rung up costs
 * a pixel of density and keeps the scale's own rule intact.
 *
 * The gap under a caption is \`space["2xs"]\` against \`space.sm\` between groups, so a
 * caption binds DOWN to the control it names rather than floating between two.
 * That asymmetry is the whole job: at an equal gap the caption reads as
 * belonging to the control above it, which is the one it is not about.
 */
.de-group { display: flex; flex-direction: column; gap: ${t.space["2xs"]}px; }
/* Selectable, like every other word in the chrome. It carried
   \`user-select: none\` and nothing here drags: the caption sits ABOVE the row of
   fields, and the only gesture surface in the group is \`.de-field-label\` two
   elements down, which keeps its suppression for the reason written there. */
/* The kit's caption role, 12/16 at weight 500 — "every 12px label". */
.de-group-caption {
  color: ${t.color.textDim};
  font-size: ${t.type.caption};
  font-weight: ${t.type.weightValue};
  line-height: ${t.type.leadingRow};
}

/* ---------- joined action group ---------- */
/*
 * Three or four momentary buttons drawn as one block — Figma's align triples,
 * and its flip triple under Rotation.
 *
 * The distinction this class exists to draw is between a group of ACTIONS and a
 * group of STATES, and the chrome had no way to say it: both were bare
 * \`.de-tool\` buttons in a flex row with a 2px gap, so a strip of six align
 * marks looked exactly like a strip of four direction toggles, and the only
 * thing separating the horizontal triple from the vertical one was an empty
 * div with \`flex: 1\` on it.
 *
 * Here the cells share one surface and are cut apart by a hairline GAP rather
 * than a rule — \`space["3xs"]\`, the kit's micro gap for a tight icon cluster,
 * of panel ground showing through. A gap rather than a border because a border would need a
 * colour, and any colour is a third value competing with the cell and the
 * ground; the ground itself is free.
 *
 * Only the OUTER corners round. \`:first-child\`/\`:last-child\` square off the
 * inside edges so the triple reads as one object with three pressable thirds,
 * which is the read a row of six equally-rounded pills cannot produce.
 */
.de-agroup {
  display: flex; align-items: stretch;
  gap: ${t.space["3xs"]}px;
  min-width: 0;
}
.de-agroup > .de-tool {
  flex: 1; min-width: 0;
  width: auto;
  background: ${t.color.field};
  border-radius: 0;
}
.de-agroup > .de-tool:first-child {
  border-top-left-radius: ${CONTROL_RADIUS};
  border-bottom-left-radius: ${CONTROL_RADIUS};
}
.de-agroup > .de-tool:last-child {
  border-top-right-radius: ${CONTROL_RADIUS};
  border-bottom-right-radius: ${CONTROL_RADIUS};
}
@media (hover: hover) and (pointer: fine) {
  .de-agroup > .de-tool:hover { background: ${t.color.fieldHover}; }
}
/*
 * A cell that is HOLDING a state takes the segmented control's fill, not the
 * toolbar's tint.
 *
 * Figma's align buttons carry no state at all — they are one-shot geometry, so
 * there is nothing to show. Ours are not: they write \`justify-content\` and
 * \`align-items\` on the parent, which is a setting that stays set, and a control
 * that silently holds a value it will not show is worse than either. So the
 * state is kept and only its VOICE changes, to the one \`.de-segment\` uses for
 * every other chosen-one-of-several in the panel.
 *
 * That collapse is the point. The panel had three pressed languages within
 * 8px of each other — an accent outline on \`.de-tool\`, a neutral fill on
 * \`.de-segment\`, an accent outline at a different size on \`.de-mini\` — for
 * what is, every time, the same claim.
 */
.de-agroup > .de-tool[aria-pressed="true"] {
  background: ${t.color.segmentSelected};
  border-color: transparent;
  color: ${t.color.text};
}
.de-agroup > .de-tool[disabled] { background: ${t.color.field}; }

/* ---------- icon segmented control ---------- */
/*
 * The same rail as \`.de-segmented\`, carrying glyphs instead of words: Auto
 * layout's flow strip, the text block's two alignment triples, the sizing modes
 * on a text node.
 *
 * A separate class from \`.de-agroup\` above even though they are a pixel apart,
 * because they mean opposite things and the difference has to survive someone
 * reading only the call site. This one is a VALUE — exactly one cell is always
 * chosen, and the rail behind them says the choice is among these. The action
 * group has no such invariant: none of its cells need be on, and pressing one
 * does something rather than selecting something.
 *
 * No gaps between cells, unlike the action group, and that is the same
 * distinction drawn in geometry: a continuous rail is one control, three
 * separated pills are three buttons that happen to be adjacent.
 */
.de-iseg {
  display: flex; align-items: stretch;
  min-width: 0;
  height: ${t.size.rowHeight}px;
  border-radius: ${CONTROL_RADIUS};
  background: ${t.color.field};
  /* Containing block for the chip below. */
  position: relative;
}
/*
 * THE ICON TWIN GETS THE TRAVELLING CHIP TOO.
 *
 * \`field.ts\` calls this "the icon twin of \`segmented\`", and for a while that
 * stopped being true: the word version was given a chip that slides between
 * choices and the glyph version was left teleporting its tint. The two sit
 * inches apart in the same panel — Distribution above, flow direction below —
 * so the product was answering one gesture two ways on one screen.
 *
 * Identical mechanism, identical rung, same helper in
 * \`core/travelling-surface.ts\`: one node measured against the pressed cell,
 * behind the glyphs, \`pointer-events: none\` so it cannot take a click, and
 * hidden until a real measurement exists so an unmeasured group keeps exactly
 * the per-cell tint it always had.
 */
.de-iseg-thumb {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: var(--de-thumb-w, 0px);
  transform: translateX(var(--de-thumb-x, 0px));
  border-radius: ${CONTROL_RADIUS};
  background: ${t.color.segmentSelected};
  opacity: 0;
  pointer-events: none;
  transition:
    transform ${t.duration.hover} ${t.ease},
    width ${t.duration.hover} ${t.ease},
    opacity ${t.duration.hover} ${t.ease};
}
.de-iseg[data-de-thumb] .de-iseg-thumb { opacity: 1; }
.de-iseg > .de-tool {
  flex: 1; min-width: 0;
  width: auto;
  border-radius: ${CONTROL_RADIUS};
  background: transparent;
  /* Above the chip, which is an earlier sibling. */
  position: relative;
  z-index: 1;
}
/* Hover is ink only, as on \`.de-segment\`: the fill means "chosen". */
@media (hover: hover) and (pointer: fine) {
  .de-iseg > .de-tool:hover { background: transparent; }
}
.de-iseg > .de-tool:focus-visible { ${FOCUS_INSET} }
.de-iseg > .de-tool[aria-pressed="true"] {
  background: ${t.color.segmentSelected};
  border-color: transparent;
  color: ${t.color.text};
}
/* Once the chip is real it owns the plate, for the reason \`.de-segment\` gives:
   two grounds at one value, one of them moving, reads as a smear. */
.de-iseg[data-de-thumb] > .de-tool[aria-pressed="true"] {
  background: transparent;
  border-color: transparent;
}

/* ---------- alignment pad ---------- */
/*
 * Nine cells in one filled block — where the parent's children sit inside it.
 *
 * It was nine bare 20x18 buttons each drawing a 10px \`Circle\` outline, on a
 * 2px grid gap with no surface behind them. Three things were wrong with that
 * and only one was cosmetic: the cells were off the 24px rhythm every other
 * control in the panel keeps, the mark was a ring where a rest wants a dot,
 * and — the one that actually cost the user something —
 * with no container the nine buttons did not read as ONE control with nine
 * positions, they read as nine small buttons.
 *
 * So the block takes the field's own well and the cells go transparent inside
 * it. It is the column width by \`space["2xl"] * 2 + space.sm\` (56px) tall,
 * so it spans whatever width the panel is dragged to.
 *
 * The chosen cell is the ACCENT, and this is the one place in the panel that
 * gets it. Everywhere else "chosen" is the neutral chip, because everywhere
 * else the control is a row of alternatives you read left to right. This is a
 * two-dimensional field where the answer is a POSITION, and a neutral chip in a
 * 3x3 grid of neutral dots is a chip you have to look for.
 */
.de-pad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  height: ${t.space["2xl"] * 2 + t.space.sm}px;
  border-radius: ${CONTROL_RADIUS};
  background: ${t.color.field};
}
.de-pad-cell {
  display: flex; align-items: center; justify-content: center;
  /* Containing block for the mark, which is stacked over the dot rather than
     replacing it — see the crossfade below. */
  position: relative;
  padding: 0;
  border: none; border-radius: ${CONTROL_RADIUS};
  background: transparent;
  color: ${t.color.textDim};
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, color ${t.duration.hover} ${t.ease};
}
/* The dot is drawn here rather than asked of the icon set, because it is not an
   icon: it is the absence of a mark, sized so nine of them read as a grid of
   rests. 2px, the kit's micro step, and below the icon ramp's floor. */
.de-pad-cell::before {
  content: "";
  width: ${t.space["3xs"]}px; height: ${t.space["3xs"]}px;
  border-radius: 50%;
  background: currentColor;
}
@media (hover: hover) and (pointer: fine) {
  .de-pad-cell:hover { background: ${t.color.fieldHover}; color: ${t.color.textMuted}; }
}
.de-pad-cell[aria-pressed="true"] { color: ${t.color.accent}; }
/*
 * Chosen, the dot gives way to a drawn mark — the reason the cell can carry a
 * glyph child at all.
 *
 * THE SWAP IS A CROSSFADE NOW, and it took a markup change to become one. It
 * was \`display: none\` on the dot and a glyph that was only appended to the
 * cell WHILE pressed, so there were never two states for the browser to
 * interpolate between — the mark did not appear quickly, it appeared with no
 * intermediate state to have.
 *
 * \`field.ts\` mounts the glyph on every cell now and lets this rule decide
 * which of the two is showing. The dot shrinks into the mark's place rather
 * than vanishing from under it, which is what makes the nine cells read as one
 * control choosing rather than nine independently blinking.
 *
 * Both are \`scale\` and \`opacity\` only, on a 24px box that never reflows.
 */
/*
 * The \`svg\` half needs \`[data-designlayer]\` and \`[data-de-glyph]\` on it, for
 * the reason \`css/annotations.ts\` spells out on \`.de-swap > svg\`: the
 * stroke-weight rule in \`css/icons.ts\` is (0,2,1) and \`transition\` is a
 * shorthand, so at (0,1,1) this list was being replaced rather than extended
 * and the mark appeared at full size instead of arriving. The \`::before\` half
 * is untouched by that rule and keeps the plain selector.
 */
.de-pad-cell::before {
  transition: opacity ${t.duration.hover} ${t.ease}, transform ${t.duration.hover} ${t.ease};
}
[data-designlayer] .de-pad-cell > svg[data-de-glyph] {
  transition: opacity ${t.duration.hover} ${t.ease}, transform ${t.duration.hover} ${t.ease},
    stroke-width ${t.duration.hover} ${t.ease};
}
.de-pad-cell > svg { position: absolute; opacity: 0; transform: scale(0.6); }
.de-pad-cell[aria-pressed="true"]::before { opacity: 0; transform: scale(0.4); }
.de-pad-cell[aria-pressed="true"] > svg { opacity: 1; transform: scale(1); }
.de-pad-cell:focus-visible { ${FOCUS_INSET} }

/* ---------- field trailing slot ---------- */
/*
 * The dropdown that lives INSIDE a number field, which is how Figma spells
 * Fixed/Hug/Fill: \`W 708 ⌄\`, not a segmented control stacked underneath.
 *
 * Ours was the stacked one, and the cost was structural rather than visual —
 * two rows of controls for one property, so the Size group was four controls
 * tall for two numbers, and the mode was 24px away from the value it governs
 * with a second field's worth of panel between them.
 *
 * The slot is a button rather than a \`<select>\` so it can show a WORD when the
 * mode is interesting (\`Fill\`, \`Hug\`) and a chevron when it is not — which is
 * again what Figma does, and what a native select cannot be made to do without
 * drawing it twice.
 */
.de-field-trailing {
  flex: none; align-self: stretch;
  display: inline-flex; align-items: center; justify-content: center; gap: ${t.space["3xs"]}px;
  padding: 0 ${t.space["2xs"]}px;
  border: none; background: transparent;
  color: ${t.color.textDim};
  font-family: inherit; font-size: ${t.type.body}; line-height: ${t.type.leadingFlush};
  white-space: nowrap;
  cursor: pointer;
  transition: color ${t.duration.hover} ${t.ease}, background-color ${t.duration.hover} ${t.ease};
}
@media (hover: hover) and (pointer: fine) {
  .de-field-trailing:hover { color: ${t.color.text}; background: ${t.color.fieldHover}; }
}
.de-field-trailing:focus-visible { ${FOCUS_INSET} }
/* The field owns the caret's colour so a disabled axis reads as one dead
   control rather than a dead number beside a live menu. */
.de-field input[disabled] ~ .de-field-trailing { color: ${t.color.textDisabled}; }

/* The same well as \`.de-field\`, since a select is a field you pick from — and
   the same rungs and focus, for the reason spelled out there. */
.de-select {
  height: ${t.size.rowHeight}px;
  width: 100%;
  padding: 0 ${t.space["2xs"]}px;
  border: 1px solid transparent; border-radius: ${CONTROL_RADIUS};
  background: ${t.color.field}; color: ${t.color.text};
  font-family: inherit; font-size: ${t.type.body};
  appearance: none; cursor: pointer;
  transition: border-color ${t.duration.hover} ${t.ease}, background-color ${t.duration.hover} ${t.ease};
}
@media (hover: hover) and (pointer: fine) {
  .de-select:hover { background: ${t.color.fieldHover}; }
  .de-select-shell:hover > .de-select-caret { color: ${t.color.textMuted}; }
}
/*
 * The kit's field focus (MICRO-INTERACTIONS § 3): on \`:focus-visible\` the
 * border takes the accent, plus the button halo, because \`appearance: none\`
 * has stripped this control of every other native affordance. Pointer focus
 * paints nothing: the open menu is the feedback.
 */
.de-select:focus { outline: none; }
.de-select:focus-visible { ${FOCUS_RING} }
.de-select option { background: ${t.color.bgRaised}; color: ${t.color.text}; }

/*
 * THE DISCLOSURE MARK, and the specificity note that makes it clickable.
 *
 * \`.de-select\` sets \`appearance: none\` so it can wear this panel's well rather
 * than the operating system's, which also removes the platform's own chevron.
 * Nothing replaced it, so every dropdown in the inspector was drawn as a text
 * field that happens to open a menu — indistinguishable from the read-only
 * readouts beside it until pressed.
 *
 * The caret is laid OVER the control because a \`<select>\` is a replaced element
 * and does not reliably draw its own pseudo-elements. That puts a glyph on top
 * of the thing it decorates, and in inspecting mode \`css/base.ts\` forces
 * \`pointer-events: all\` onto every \`<svg>\` in the document — so a plain
 * \`pointer-events: none\` on the wrapper is not enough, the glyph itself becomes
 * the hit target and eats the click that would open the menu. The second rule
 * names \`.de-select-caret svg\` so it outranks \`html.designlayer-inspecting
 * svg\` on specificity (0,2,1 against 0,1,1) instead of relying on which
 * stylesheet happens to be concatenated last.
 */
.de-select-shell { position: relative; display: block; min-width: 0; }
/* Room for the mark, so a long option never runs under it. */
.de-select-shell > .de-select { padding-right: ${t.space.xl}px; }
.de-select-caret {
  position: absolute; top: 50%; right: ${t.space["2xs"]}px;
  transform: translateY(-50%);
  display: inline-flex;
  color: ${t.color.textDim};
  pointer-events: none;
}
[data-designlayer] .de-select-caret svg { pointer-events: none; }

/*
 * \`.de-inspector-footer\` was here: a padded column at the foot of the Design
 * tab holding Save as option / Update / Revert.
 *
 * The reason it existed was real. The saved list is absent until something is
 * saved, and Save is the only way anything ever gets saved — so the verbs could
 * not live inside a box that might not be there. The answer was to put them
 * outside it, at the bottom of the panel.
 *
 * The box is unconditional now (\`options/panel.ts\`) and the verbs are its first
 * row, so the panel has no last-row concept left to style.
 *
 * If a future section wants a footer, note what this one got wrong as well as
 * what it got right. No border of its own was correct: every section above
 * closes with a bottom hairline, and a border-top here would have landed
 * against it and read as a 2px rule. Parking the verbs nine sections below the
 * list they act on was not — that is not one group with space around it, it is
 * two groups, and a reader who found the list had no reason to look that far
 * down for the things to do with it.
 */

/*
 * \`balance\` and not the root's \`pretty\`, and centring is the whole reason.
 *
 * \`pretty\` fixes the last line and leaves the ones above it wherever they fell,
 * which is invisible in a left-aligned column and glaring in a centred one: a
 * 40/40/8-character stack reads as a shape rather than as a sentence, because
 * the eye is following two ragged edges instead of one. \`balance\` evens every
 * line, which is what a centred block of two or three lines wants and what the
 * skill reserves it for.
 *
 * Safe here for the reason it is not safe generally: browsers stop balancing
 * past a handful of lines, and an empty state that ran longer than that would
 * already be the wrong copy for an empty state.
 */
.de-empty {
  padding: ${t.space["2xl"]}px ${t.space.lg}px;
  /* Centred, so the cap needs \`margin-inline: auto\` to stay centred with it.
     An empty state is the longest prose in the panel and the one a wide window
     stretches furthest. */
  max-width: ${t.type.measure}; margin-inline: auto;
  color: ${t.color.textDim};
  text-align: center;
  font-size: ${t.type.body};
  line-height: ${t.type.leadingBody};
  text-wrap: balance;
}

`
