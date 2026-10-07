/**
 * The shell stylesheet.
 *
 * Scoped under `[data-designlayer]` so it can never leak into the app being
 * edited, and the app's own cascade can never reach in.
 */

import { baseCss, vendorChromeCss } from "./css/base"
import { toolbarCss } from "./css/toolbar"
import { panelsCss } from "./css/panels"
import { inspectorCss } from "./css/inspector"
import { leftTabsCss } from "./css/left-tabs"
import { appChooserCss } from "./css/app-chooser"
import { macAppCss } from "./css/mac-app"
import { codeCss } from "./css/code"
import { annotationsCss } from "./css/annotations"
import { layersCss } from "./css/layers"
import { optionsCss } from "./css/options"
import { librariesCss } from "./css/libraries"
import { lintCss } from "./css/lint"
import { canvasCss } from "./css/canvas"
import { insertCss } from "./css/insert"
import { lintMarkersCss } from "./css/lint-markers"
import { iconsCss } from "./css/icons"
import { launcherCss } from "./css/launcher"
import { tokenPickerCss } from "./css/token-picker"
import { variantsCss } from "./css/variants"
import { shortcutsCss } from "./css/shortcuts"
import { tooltipCss } from "./css/tooltip"

/**
 * Concatenated in source order so the cascade is unchanged. Each module is
 * owned by the lane that owns the surface it styles; joining here keeps the
 * single `shellCss` export the shell already imports.
 */
export const shellCss =
  baseCss +
  // Early, and never later: every surface below draws glyphs, and this only
  // ever toggles `display` on a `<g>` nothing else in the sheet selects.
  iconsCss +
  toolbarCss +
  panelsCss +
  // After `panels`, because the tab host re-lays out `.de-panel-body` for the
  // right panel only and has to win on equal specificity.
  inspectorCss +
  // Directly after it, and for the same reason on the other side: the left
  // panel grew a tab host too, so its body is a strip over a pane rather than
  // one scroll. It also borrows `.de-tabs`/`.de-tab`/`.de-tabpanel` from the
  // module above rather than restating them, so it can never be lifted ahead
  // of it — the two strips are one control and this is where that is enforced.
  leftTabsCss +
  // Straight after the strip it sits on top of, because it is the other half of
  // that panel's head: the chooser is `slots.left`'s first child and the tabs
  // are its second, and a rule about the top of the left panel belongs beside
  // the only other rule about the top of the left panel. It is not registered
  // with the popovers further down despite drawing one, because the floating
  // card declares its own stacking outright — it cannot be reordered into or
  // out of correctness, so the trigger is what decides where this entry lands.
  appChooserCss +
  // The foot of the same panel, drawn as the chooser's mirror, so the two read
  // side by side here the way they do on screen.
  macAppCss +
  codeCss +
  annotationsCss +
  layersCss +
  optionsCss +
  // After `options`, because the libraries tab borrows that sheet's vocabulary
  // — the tag plate, the mono path, the quiet fold link — and a later position
  // is what lets it differ where it has to without raising specificity.
  librariesCss +
  // Directly after it, because the two are the Design system tab's two sections
  // in the order they are stacked. The audit list is the same
  // rows-with-actions vocabulary the sheet above establishes, and it borrows
  // the severity tones from nothing up there — those are its own.
  //
  // `assetsCss` used to sit between them, for the browsing rail the libraries
  // section replaced: a thumbnail grid, a breadcrumb, a card, none of which
  // survives. The two rules of it still needed — the preview clone's transform
  // and the monogram it falls back to — were restated inside `.de-instance-thumb`
  // in `css/variants.ts`, which is the only surface left that draws one.
  lintCss +
  canvasCss +
  // Immediately after the canvas chrome it belongs to. The drop indicator is
  // canvas furniture that happens to be owned by the assets feature — it draws
  // into the same overlay as the selection frame, and the one rule it cannot
  // afford to lose is `pointer-events: none`, which is only load-bearing while
  // it sits alongside the rest of the overlay's chrome.
  insertCss +
  // Last of the overlay's three, and deliberately after `annotations`: the two
  // marker layers are mutually exclusive, so they never paint together, but
  // they do share the overlay's positioning vocabulary. Sitting later means an
  // audit badge can differ from a note pin — square rather than round — without
  // having to out-specify it.
  lintMarkersCss +
  launcherCss +
  tokenPickerCss +
  variantsCss +
  // Last, because it is the only surface in the chrome that covers all of the
  // others. Its stacking is declared outright rather than inherited from this
  // position — but a modal registered in the middle of the sheet would still
  // read as one more panel, and the order here is how a reader learns what sits
  // in front of what.
  shortcutsCss +
  /*
   * Truly last, and outside the panel stack entirely.
   *
   * The tooltip card is the one surface in the chrome parented to `<body>`
   * rather than into `.de-root`, because it has to out-stack the shortcuts
   * sheet and the app-chooser menu — both of which already declare their own
   * z-index above the panels — and a tip occluded by the thing it is explaining
   * is worse than no tip. Being last here matches that: nothing in the sheet
   * may reorder in front of it.
   *
   * It also restates the reduced-motion clamp that `base.ts` applies to
   * `[data-designlayer] *`, deliberately, because the card is not inside that
   * subtree.
   */
  tooltipCss

export { vendorChromeCss }
