/**
 * The two docked-panel insets, as the rest of the editor reads them.
 *
 * `shell.ts` is the one WRITER: `syncInsets` sets `--de-left` and `--de-right`
 * as inline custom properties on `<html>` and then calls `notifyInsets()`.
 * Everything else reads through here. A separate module rather than exports
 * on `shell.ts`, because the launcher and the drag need the same reader and
 * `shell.ts` imports them, so they could not import it back.
 */

/**
 * Who wants to know when the app area changes width.
 *
 * The two panel flags are store state and anything can subscribe to them, but
 * the WIDTHS deliberately are not: a seam drag moves them on every frame and
 * routing that through the store would wake every lane in the editor on every
 * pointermove (see the note on the subscription in `mountShell`). So the one
 * fact a floating surface actually needs — "the edges moved, re-check yourself"
 * — is published here instead, already filtered by `resize.ts` down to the
 * frames where the reported inset really changed.
 *
 * Module-level, because the lanes that care install after `mountShell`
 * returns and would otherwise each have to be handed it.
 */
const insetListeners = new Set<() => void>()

export function onInsetsChange(fn: () => void): () => void {
  insetListeners.add(fn)
  return () => insetListeners.delete(fn)
}

/**
 * Called by the writer AFTER the properties are written, so a listener that
 * clamps itself against them reads this frame's edges rather than the last
 * one's.
 */
export function notifyInsets(): void {
  for (const listener of insetListeners) listener()
}

/**
 * One inline custom property on `<html>`, in pixels.
 *
 * Read off the inline style rather than through `getComputedStyle`: a caller
 * woken by `onInsetsChange` runs immediately after the writes, so the inline
 * value is this frame's by construction, while a computed read would force a
 * style recalc of the whole app. A caller that is not woken gets the last
 * settled value, which is the one every surface is currently drawn against.
 *
 * A missing or unparsable value is 0: a chrome that has not published its
 * insets yet is a chrome with no docked panels, which is the honest reading.
 */
export function readInset(name: string): number {
  const value = Number.parseFloat(document.documentElement.style.getPropertyValue(name))
  return Number.isFinite(value) ? value : 0
}

/** What the panels are holding right now, in the app's own pixels. */
export function appInsets(): { left: number; right: number } {
  return { left: readInset("--de-left"), right: readInset("--de-right") }
}

/**
 * How wide the app believes it is: the window, less both panels.
 *
 * This is the width the app's own stylesheet is answering to — `shell/
 * app-viewport.ts` points its `vw` and its breakpoints at exactly this strip —
 * so anything in the chrome that reports "the width the app is laid out at"
 * has to ask this rather than `window.innerWidth`, or it describes a viewport
 * the app stopped using.
 */
export function canvasWidth(): number {
  const { left, right } = appInsets()
  return Math.max(0, window.innerWidth - left - right)
}
