/**
 * Canvas view: the board of pages, its labels, and the view transition that
 * turns the live page into one frame on it and back.
 *
 * Injected by `board/index.ts` in its own `<style>`, not concatenated into
 * `shellCss`: the board is a separate lane that mounts after the shell, and
 * its rules include `::view-transition-*` pseudo-elements that belong to the
 * document rather than to anything under `.de-root`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BOARD IS A SIBLING OF `.de-root`
 *
 * The opening is a view transition, and the chrome has to be captured as its
 * own group (`dl-chrome`) so it stays exactly where it is while the page shrinks
 * under it. A board inside `.de-root` would be captured with the chrome and sit
 * above the shrinking page instead of being revealed by it. So the board lives
 * on `<body>` at 2147482990: above the app, below the chrome's 2147483000, and
 * part of the root snapshot where it belongs.
 *
 * ---------------------------------------------------------------------------
 * TWO COORDINATE SPACES
 *
 * `.de-board-world` carries the camera transform, so everything in it — frames,
 * their hairlines, radii and placeholders — is in world units and scales. The
 * labels, the Live buttons and the hover outline live in `.de-board-labels`,
 * which is NOT transformed: each is placed with its own `translate3d` from the
 * frame's screen rect. Text drawn at 18% of its size is unreadable, and a
 * button that shrinks with the zoom stops being a target.
 */

import { tokens as t } from "../tokens"
import { FOCUS_OUTLINE } from "./panels"
import { TOOLBAR_HEIGHT } from "./toolbar"

/**
 * Where the zoom control sits while the editor is collapsed.
 *
 * Collapsing leaves one disc in this same corner — `TOOLBAR_HEIGHT` square, 32px
 * in from the edges (`css/launcher.ts`) — and the board stays up under it now,
 * so the control steps left of the disc rather than hiding behind it.
 */
const CLEAR_OF_LAUNCHER = 32 + TOOLBAR_HEIGHT + 12

/** Opening and closing to the current page: the page travels, so it takes longest. */
export const BOARD_ENTER_MS = 560
export const BOARD_EXIT_MS = 460
/** Flying to another page before the live document follows it. */
export const BOARD_FLY_MS = 480
/** Reduced motion swaps every scale animation for this crossfade. */
export const BOARD_FADE_MS = 120
/** The fade that hands a page over to the live document after a route change. */
export const BOARD_HANDOFF_MS = 160
/** The board's curve: fast out, long settle. Matches `boardEase` in `board/camera`. */
export const BOARD_EASE = "cubic-bezier(0.22, 1, 0.36, 1)"

export const boardCss = `
/* The box is pinned, not merely set: to every other tool on the page the board
   is one more element on <body> that can be dragged, offset or transformed, and
   a board moved off the canvas rect shows the live page round its edges. The
   insets arrive as custom properties because left and right are pinned too;
   board/index.ts takes back any inline style it did not write. */
.de-board {
  position: fixed !important;
  top: 0 !important;
  bottom: 0 !important;
  left: var(--de-board-left, 0px) !important;
  right: var(--de-board-right, 0px) !important;
  margin: 0 !important;
  transform: none !important;
  translate: none !important;
  rotate: none !important;
  scale: none !important;
  z-index: 2147482990 !important;
  overflow: hidden;
  contain: strict;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  overscroll-behavior: contain;
  outline: none;
  background-color: ${t.color.bgSunken};
  /* A dot grid whose pitch and offset follow the camera, so panning reads as
     the ground moving rather than the frames sliding over a painted wall. */
  background-image: radial-gradient(circle at center, ${t.color.borderStrong} 1px, transparent 1.5px);
  background-size: 24px 24px;
  color: ${t.color.text};
}
.de-board[data-state="closed"] { display: none; }
.de-board[data-space] { cursor: grab; }
.de-board[data-panning] { cursor: grabbing; }

.de-board-world {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transform-origin: 0 0;
}

.de-board-frame {
  position: absolute;
  overflow: hidden;
  background: #fff;
  border-radius: 4px;
  corner-shape: round;
  box-shadow:
    0 0 0 1px ${t.color.hairline},
    0 1px 3px rgba(0, 0, 0, 0.06),
    0 12px 40px rgba(0, 0, 0, 0.08);
  transform-origin: 50% 50%;
}
/* Frames never take the pointer: the board hit-tests them by geometry, and an
   iframe that could be clicked would be a second live app nobody asked for. */
.de-board-frame,
.de-board-frame iframe { pointer-events: none; }
.de-board-frame iframe {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: #fff;
  opacity: 0;
  transition: opacity 180ms ${t.easeReveal};
}
.de-board-frame[data-loaded="true"] iframe { opacity: 1; }

/* The placeholder is in world space, so its type is scaled back up by the
   inverse of the zoom (written on settle) to stay readable at a glance. */
.de-board-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: calc(4px * var(--de-board-inv, 1));
  font-size: calc(${t.type.body} * var(--de-board-inv, 1));
  color: #5b6570;
  background: #f6f7f8;
  text-align: center;
  padding: calc(8px * var(--de-board-inv, 1));
}
.de-board-placeholder-path { font-weight: ${t.type.weightValue}; color: #2a3036; }
.de-board-frame[data-loaded="true"] .de-board-placeholder { visibility: hidden; }

.de-board[data-entering] .de-board-frame:not([data-current="true"]) {
  animation: de-board-frame-in 420ms ${BOARD_EASE} both;
  animation-delay: var(--de-delay, 0ms);
}
@keyframes de-board-frame-in {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: none; }
}

.de-board-labels {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.de-board-label,
.de-board-live,
.de-board-hover {
  position: absolute;
  left: 0;
  top: 0;
}
.de-board-label {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding-bottom: 6px;
  white-space: nowrap;
  color: ${t.color.textDim};
  transition: color ${t.duration.hover} ${t.ease};
}
.de-board-label[data-hover="true"] { color: ${t.color.text}; }
.de-board-label-row {
  display: flex;
  align-items: center;
  gap: ${t.space.xs}px;
  min-width: 0;
}
.de-board-label-path {
  font-weight: ${t.type.weightValue};
  overflow: hidden;
  text-overflow: ellipsis;
}
.de-board-label-meta {
  font-size: ${t.type.micro};
  color: ${t.color.textDim};
  overflow: hidden;
  text-overflow: ellipsis;
}
.de-board-label-meta:empty { display: none; }
/* Too little room between rows for two lines: the path alone, clear of the frame above. */
.de-board[data-compact-labels] .de-board-label-meta { display: none; }
.de-board-tag {
  flex: none;
  font-size: ${t.type.micro};
  line-height: 14px;
  padding: 0 5px;
  border-radius: 999px;
  corner-shape: round;
  background: ${t.color.accentSoft};
  color: ${t.color.accentText};
}

/* The way back to the page, and deliberately quiet: invisible until the frame
   under it is hovered or the button itself has keyboard focus.

   Quiet means hidden, not faint. The scrim is what the white glyph and label
   are measured against, and it sits over the app's own page — white, in most
   apps. At 30% it came to 2.1:1 there, so the pill was unreadable in both
   themes exactly when it appeared. 60% is 4.9:1 over pure white, which clears
   the 4.5:1 its label owes; any darker page only raises it. Hover steps to 78%
   (9.5:1) so the pointer still visibly lands. */
.de-board-live {
  pointer-events: auto;
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px 0 7px;
  border: 0;
  border-radius: 12px;
  corner-shape: round;
  background: rgba(18, 22, 26, 0.6);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: #fff;
  font: inherit;
  font-size: ${t.type.body};
  font-weight: ${t.type.weightValue};
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ${t.ease}, background-color ${t.duration.hover} ${t.ease};
}
.de-board-live[data-hover="true"],
.de-board-live:focus-visible { opacity: 1; }
.de-board-live:hover { background: rgba(18, 22, 26, 0.78); }
.de-board-live:focus-visible { ${FOCUS_OUTLINE} }
.de-board[data-navigating] .de-board-live { opacity: 0; pointer-events: none; }

.de-board-hover {
  display: none;
  box-shadow: 0 0 0 1px ${t.color.accent};
  border-radius: 4px;
  corner-shape: round;
}
.de-board-hover[data-on="true"] { display: block; }
.de-board[data-navigating] .de-board-hover { display: none; }

.de-board-zoom {
  position: absolute;
  right: ${t.space.md}px;
  bottom: ${t.space.md}px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: ${t.radius.lg};
  background: ${t.color.bg};
  box-shadow: ${t.shadow.popover};
}
:root.designlayer-chrome-hidden .de-board-zoom { right: ${CLEAR_OF_LAUNCHER}px; }
.de-board-zoom button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  border: 0;
  border-radius: ${t.radius.sm};
  background: transparent;
  color: ${t.color.textMuted};
  font: inherit;
  font-size: ${t.type.body};
  cursor: pointer;
}
.de-board-zoom button:hover { background: ${t.color.bgHover}; color: ${t.color.text}; }
.de-board-zoom button:focus-visible { ${FOCUS_OUTLINE} }
.de-board-zoom-value {
  min-width: 42px;
  text-align: center;
  color: ${t.color.text};
  font-variant-numeric: tabular-nums;
}

/*
 * The view transition's static half. The chrome is lifted into its own group
 * for the duration, its old image dropped and its new one shown as-is, so the
 * panels and the toolbar do not so much as flicker while the page travels.
 */
html.de-vt .de-root { view-transition-name: dl-chrome; }
html.de-vt::view-transition-old(dl-chrome) { display: none; }
html.de-vt::view-transition-new(dl-chrome) { animation: none; }
html.de-vt::view-transition-group(dl-chrome) { animation: none; }

/*
 * The rest of the editor's surfaces get the same treatment, because they are
 * NOT under \`.de-root\`: the toaster, the tooltip card and the shortcuts sheet
 * mount straight onto <body>. Left in the root snapshot, a tooltip still
 * showing "Canvas view" from the click would shrink into the frame with the
 * page — editor UI inside a picture of the page. \`match-element\` gives each one
 * a name of its own, and the class lets one rule keep them all still.
 * Companions and the host's dev chrome join them through the per-transition
 * style (see \`boardTrustedVtCss\`), since their selectors come from config.
 */
html.de-vt body > [data-designlayer]:not(.de-root):not(.de-board) {
  view-transition-name: match-element;
  view-transition-class: dl-ui;
}
html.de-vt::view-transition-group(*.dl-ui) { animation: none; }
html.de-vt::view-transition-old(*.dl-ui) { display: none; }
html.de-vt::view-transition-new(*.dl-ui) { animation: none; }
html.de-vt-fade::view-transition-old(root),
html.de-vt-fade::view-transition-new(root) { animation-duration: ${BOARD_FADE_MS}ms; }

/*
 * The exit's keyframes live here, not in the per-transition style, and read
 * where to land from \`--de-vt-to\`, which \`boardExitCss\` sets on the old image.
 * A style that brings an @keyframes rule restyles every animated element in
 * the document — the chrome's buttons, glyphs and every board frame — and the
 * exit's style went in on the keypress, so that restyle sat inside the frame
 * that captures the old image. A custom property on one pseudo-element is a
 * restyle of that pseudo-element.
 */
@keyframes de-board-exit {
  from { transform: none; opacity: 1; }
  80% { opacity: 1; }
  to { transform: var(--de-vt-to); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .de-board[data-entering] .de-board-frame:not([data-current="true"]) { animation: none; }
  .de-board-frame iframe { transition: none; }
}
`

export interface BoardTransitionGeometry {
  /** Panel insets: the canvas rect is the viewport less these. */
  left: number
  right: number
  tx: number
  ty: number
  scale: number
}

const px = (value: number) => `${Math.round(value * 100) / 100}px`

/**
 * Companions and the host's dev chrome, kept out of the page's snapshot the way
 * the editor's own surfaces are (see the \`dl-ui\` class above). Their selectors
 * come from \`chrome.trustedSelectors\`, so this rule is built per transition.
 */
export function boardTrustedVtCss(trustedSelector: string): string {
  const selector = trustedSelector.trim()
  if (!selector) return ""
  return `html.de-vt :is(${selector}) { view-transition-name: match-element; view-transition-class: dl-ui; }\n`
}

/**
 * Opening: the live page's old image shrinks into its frame's slot on the
 * board. Clipped to the canvas rect first, so the strips under the panels do
 * not travel with it.
 */
export function boardEnterCss(g: BoardTransitionGeometry, duration = BOARD_ENTER_MS): string {
  return `
html.de-vt-enter::view-transition-group(root) { animation: none; }
html.de-vt-enter::view-transition-old(root) {
  z-index: 2;
  transform-origin: 0 0;
  clip-path: inset(0 ${px(g.right)} 0 ${px(g.left)});
  animation: de-board-enter ${duration}ms ${BOARD_EASE} both;
}
html.de-vt-enter::view-transition-new(root) { z-index: 1; animation: none; }
@keyframes de-board-enter {
  from { transform: none; }
  to { transform: translate(${px(g.tx)}, ${px(g.ty)}) scale(${g.scale}); }
}
`
}

/** The canvas rect the closing board's old image is clipped to. */
export function boardExitClip(g: BoardTransitionGeometry): string {
  return `inset(0 ${px(g.right)} 0 ${px(g.left)})`
}

/** Where the closing board's old image lands: its frame covering the canvas. */
export function boardExitTo(g: BoardTransitionGeometry): string {
  return `translate(${px(g.tx)}, ${px(g.ty)}) scale(${g.scale})`
}

/**
 * Closing to the current page: the board's old image grows until the frame
 * covers the canvas rect, over the live page that never left. It stays opaque
 * until the last fifth so the hand-over lands on matching pixels, not a fade.
 */
export function boardExitCss(g: BoardTransitionGeometry, duration = BOARD_EXIT_MS): string {
  return `
html.de-vt-exit::view-transition-group(root) { animation: none; }
html.de-vt-exit::view-transition-old(root) {
  z-index: 2;
  transform-origin: 0 0;
  clip-path: ${boardExitClip(g)};
  --de-vt-to: ${boardExitTo(g)};
  animation: de-board-exit ${duration}ms ${BOARD_EASE} both;
}
html.de-vt-exit::view-transition-new(root) { z-index: 1; animation: none; }
`
}
