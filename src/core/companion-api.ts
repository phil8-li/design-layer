/**
 * The window surface a companion script is allowed to drive.
 *
 * A companion (`server/companions.mjs`) is somebody else's dev-time tooling,
 * loaded onto the page beside this editor. Marking its chrome trusted is enough
 * for it to be CLICKABLE — the canvas stops mistaking its buttons for the app's
 * — but it is not enough for it to WORK, because the interesting companions are
 * the ones that want the page itself: an annotation toolbar's whole gesture is
 * clicking the app, and in `inspecting` mode this editor swallows exactly that.
 *
 * Both tools arming at once is not a state either of them can resolve. One
 * click cannot both select a paragraph and pin a note to it, and whichever
 * listener ran first would decide it by registration order — a coin toss the
 * user cannot see, cannot predict, and would experience as the other tool being
 * broken.
 *
 * So the pointer is claimed, explicitly. `interactive` already means "the app
 * gets the click, not the editor"; a claim is that mode held for as long as
 * somebody needs it and handed back afterwards, which is a thing the user could
 * do by hand and should not have to remember to.
 *
 * The user still outranks the claim. Pressing Inspect while a companion holds
 * the pointer puts the editor back into inspecting — the release then leaves it
 * alone rather than yanking the mode out from under the person who just chose
 * it. A companion that finds itself ignored re-claims the next time it arms,
 * which is the same gesture that claimed it the first time.
 */

import type { EditorContext } from "./context"
import { editorMode, type EditorMode } from "./store"

export interface CompanionApi {
  /** Bumped when an existing member changes shape. Companions may check it. */
  version: 1
  mode(): EditorMode
  setMode(mode: EditorMode): void
  /**
   * Holds the editor in `interactive` for as long as the claim is held, so the
   * caller's own click handling reaches the page. Returns the release, which is
   * safe to call more than once.
   */
  claimPointer(name: string): () => void
  /**
   * Called whenever the mode changes, with the new one. Returns an unsubscribe.
   *
   * The half of the bargain a claim cannot cover. A claim says "I am taking the
   * pointer"; this says "you have just taken it back" — the user pressing
   * Inspect while a companion is armed. Without it the companion is still armed
   * and both tools answer the same click, which is the one state this API
   * exists to make unreachable. The listener is where a companion disarms.
   */
  onModeChange(listener: (mode: EditorMode) => void): () => void
}

declare global {
  interface Window {
    __DESIGNLAYER__?: CompanionApi
  }
}

export function installCompanionApi(context: EditorContext): void {
  const claims = new Set<string>()
  // The mode in force when the FIRST claim was taken. Null whenever nothing is
  // claimed, and null after a restore, so a second claim cannot restore twice.
  let restoreTo: EditorMode | null = null

  const release = (name: string): void => {
    if (!claims.delete(name)) return
    if (claims.size > 0) return
    const previous = restoreTo
    restoreTo = null
    // Still interactive means nobody overrode the claim while it was held, so
    // the mode on screen is this editor's own doing and putting it back is a
    // correction rather than a surprise.
    if (previous && previous !== "interactive" && editorMode() === "interactive") {
      context.setMode(previous)
    }
  }

  window.__DESIGNLAYER__ = {
    version: 1,
    mode: () => editorMode(),
    setMode: (mode) => context.setMode(mode),
    claimPointer(name) {
      if (!claims.has(name)) {
        if (claims.size === 0) restoreTo = editorMode()
        claims.add(name)
        if (editorMode() !== "interactive") context.setMode("interactive")
      }
      return () => release(name)
    },
    onModeChange(listener) {
      // Derived from the store rather than exposed as raw state: `interactive`
      // and `annotating` are two booleans and a companion has no business
      // learning that. It is also debounced on the mode itself — the store
      // publishes on every selection and every hover, and a companion woken by
      // a hover would be a companion polling.
      let last = editorMode()
      return context.subscribe(() => {
        const next = editorMode()
        if (next === last) return
        last = next
        listener(next)
      })
    },
  }
}
