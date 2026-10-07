/**
 * The "Open in Mac app" banner across the foot of the left panel
 * (`panels/mac-app.ts` argues the placement).
 *
 * Drawn as the app chooser's mirror: the chooser is a full-bleed row under the
 * panel's top edge with a divider below it, and this is a full-bleed row over
 * the bottom edge with a divider above it. Same ground, same hover step, same
 * inset focus ring, for the reason `css/app-chooser.ts` gives — an outward ring
 * on a box flush with the panel edge has one side drawn off the panel.
 *
 * `flex: none` keeps it out of the arithmetic in `css/left-tabs.ts`, where the
 * visible pane is the one `flex: 1` child of the body: the banner takes its own
 * height and the pane scrolls in what is left, so the tree never slides under
 * it.
 */

import { tokens as t } from "../tokens"

export const macAppCss = `/* ---------- open in Mac app ---------- */
.de-mac-banner {
  flex: none;
  display: flex; align-items: center; gap: ${t.space.sm}px;
  width: 100%;
  min-height: ${t.size.panelHeader}px;
  padding: ${t.space.sm}px ${t.space.md}px;
  border: none;
  border-top: 1px solid ${t.color.border};
  border-radius: 0;
  background: transparent;
  color: ${t.color.text};
  font-family: inherit; font-size: ${t.type.body};
  text-align: left;
  cursor: pointer;
  transition: background-color ${t.duration.hover} ${t.ease}, box-shadow ${t.duration.hover} ${t.ease};
}
/* The chooser's quiet step, on a real pointer only, so a tap does not leave
   the band lit. */
@media (hover: hover) and (pointer: fine) {
  .de-mac-banner:hover { background: ${t.color.bgHoverQuiet}; }
}
/* One step further while pressed: the request takes a moment, and the toast is
   the answer, so the press itself has to show that it landed. */
.de-mac-banner:active { background: ${t.color.bgHover}; }
.de-mac-banner:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px ${t.color.accent}, inset 0 0 0 4px ${t.color.accentHalo};
}
.de-mac-banner-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex; flex-direction: column; gap: ${t.space["3xs"]}px;
}
.de-mac-banner-title { font-weight: ${t.type.weightSection}; }
/* Wraps rather than truncating: at the 180px floor it takes two lines, and a
   description cut off mid-phrase explains nothing. */
.de-mac-banner-note { color: ${t.color.textDim}; font-size: ${t.type.caption}; }
.de-mac-banner svg { flex: none; color: ${t.color.textDim}; }
@media (hover: hover) and (pointer: fine) {
  .de-mac-banner:hover svg { color: ${t.color.text}; }
}
.de-mac-banner:focus-visible svg { color: ${t.color.text}; }
`
