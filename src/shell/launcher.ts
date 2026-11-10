/**
 * The round button the editor collapses into.
 *
 * The treatment is Agentation's (agentation.com), because it is the pattern a
 * designer arriving at this editor has most likely already used: a small dark
 * disc pinned off the corner, slack before a press becomes a drag, the press
 * that turns into a drag never counting as a click, and the position
 * remembered for next time. The BEHAVIOUR is that pattern; two of the numbers
 * are not. Their disc is 44px 20px off the edge, and ours is the toolbar's
 * height 32px off it — see `css/launcher.ts` for both arguments.
 *
 * The gesture that moves it is `shell/drag.ts`, shared with the toolbar pill.
 * The two remember where they were put separately; the note on that is there
 * too.
 */

import { LAUNCHER_INSET } from "../core/css/launcher"
import { TOOLBAR_HEIGHT } from "../core/css/toolbar"
import { el } from "../core/dom"
import { icon } from "../core/icons"
import { readJsonPref, writeJsonPref } from "../core/prefs"
import { tokens } from "../core/tokens"
import { DRAG_SLACK, installDrag, type Point } from "./drag"

/**
 * The disc's saved corner, and the only position here that outlives the tab.
 *
 * Stored as an absolute top-left in viewport pixels, per editor origin, so a
 * corner chosen on a small window can land mid-screen on a larger one. A
 * known limit, not yet a decision to change.
 */
const STORAGE_KEY = "designlayer:launcher-position"

/**
 * The disc's box, which the clamp needs in numbers before the disc is laid out.
 *
 * Imported from the bar's geometry rather than restated, because that is where
 * the disc's size comes from — `css/launcher.ts` sizes it off the same
 * constant so the collapsed editor is exactly as tall as the expanded one. A
 * literal here would be the same number twice with nothing holding them
 * together, and this one is only ever read mid-drag, where being wrong shows up
 * as a disc that clamps to the wrong edge rather than as anything obvious.
 */
const SIZE = TOOLBAR_HEIGHT

interface Launcher {
  element: HTMLButtonElement
  destroy(): void
}

/**
 * The saved corner, or null when there is none and the CSS anchor should win.
 * A hand-edited or stale entry that is not two finite numbers is no corner.
 */
function parseCorner(value: unknown): Point | null {
  if (typeof value !== "object" || value === null) return null
  const { x, y } = value as Partial<Point>
  if (typeof x !== "number" || typeof y !== "number") return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

export function createLauncher(onActivate: () => void): Launcher {
  const element = el(
    "button",
    {
      class: "de-launcher",
      type: "button",
      // Named for what pressing it does, not for what it is. "Launcher" is our
      // word for it; "Show DesignLayer" is the user's.
      "aria-label": "Show DesignLayer",
    },
    /*
     * The filled pointer, named rather than left to the cascade: this button is
     * never "pressed", but the mark it wears is the editor's claim on the
     * pointer, which is the same claim the mode switch draws solid. Asking for
     * the weight here is what keeps the two in agreement.
     *
     * At `display` (24) rather than at `launcher` (20), and the rung moved
     * because the glyph did. `Cursor` is authored on the native 16 lattice now
     * — which is what lets its hollow and solid weights be rounded as two
     * separate boundaries, something a stroked outline cannot do — and a native
     * glyph lands on whole device pixels only at a multiple of 8. Drawn at 20
     * it would be the one soft mark in the chrome, on the one surface where it
     * is the only thing on screen. 20 was picked when this mark was Lucide's and
     * every rung was equally soft.
     *
     * It stayed at 24 when the disc came down to the toolbar's 40, and the
     * proportion is better for it: 24 in 40 leaves 8 of ground on every side —
     * the same `space.sm` the chrome uses between controls everywhere else — and
     * is the usual pairing in a small floating action button. 24 in 44 left 10,
     * which is not a step on the scale at all.
     */
    [icon("Cursor", tokens.icon.feature, "filled")]
  ) as HTMLButtonElement

  let saved = readJsonPref(STORAGE_KEY, parseCorner)

  const drag = installDrag({
    element,
    dragging: "de-launcher--dragging",
    slack: DRAG_SLACK,
    // The resting inset, so a dragged disc lands where an undragged one sits.
    inset: LAUNCHER_INSET,
    // No `sides`: the viewport, not the app area. The disc is only ever on
    // screen with the panels gone, so they are not its business — and reading
    // them parked it against an inspector that was not there. See `DragOptions`
    // in `shell/drag.ts`.
    size: () => ({ width: SIZE, height: SIZE }),
    fallback: () => saved,
    paint(box) {
      element.style.left = `${box.x}px`
      element.style.top = `${box.y}px`
      // The stylesheet anchors bottom-right; a dragged button is anchored
      // top-left, and both pairs cannot be in force at once.
      element.style.right = "auto"
      element.style.bottom = "auto"
    },
    rest() {
      element.style.removeProperty("left")
      element.style.removeProperty("top")
      element.style.removeProperty("right")
      element.style.removeProperty("bottom")
    },
    landed(box) {
      saved = box
      writeJsonPref(STORAGE_KEY, box)
    },
  })

  element.addEventListener("click", () => {
    if (drag.dragEnded()) return
    onActivate()
  })

  return {
    element,
    destroy() {
      drag.destroy()
      element.remove()
    },
  }
}
