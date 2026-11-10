/**
 * The gesture modifiers the canvas shares: Alt and Shift, held in one place.
 *
 * Alt suppresses snapping while a move drags, reveals measurements while the
 * pointer hovers, and mirrors a padding drag onto the opposite side; Shift with
 * it moves all four sides. Those are three modules asking one question, and
 * they used to keep two answers: the move gesture tracked Alt in a module
 * global, the spacing handles tracked both keys in a field of their own, and
 * the selection painter imported the whole move gesture only to ask about a
 * key. One tracker, read by all three, means the painter depends on a key and
 * nothing more, and the two trackers can no longer disagree for a frame.
 *
 * Pointer events carry the keys as well as key events do, and they are kept
 * honest from both: a document that never received the keydown (focus was in
 * a frame, or the key went down before the window had focus) still learns it
 * on the next pointer move. A lost window resets both, because a key released
 * while another window had focus sends no keyup here.
 */

export interface Modifiers {
  alt: boolean
  shift: boolean
}

let current: Modifiers = { alt: false, shift: false }
let installed = false
const listeners = new Set<(next: Modifiers) => void>()

function read(next: Modifiers): void {
  if (next.alt === current.alt && next.shift === current.shift) return
  current = next
  for (const listener of listeners) listener(current)
}

const fromEvent = (event: { altKey: boolean; shiftKey: boolean }) => read({ alt: event.altKey, shift: event.shiftKey })

/** Whether Alt (Option on a Mac) is held. */
export function isAltDown(): boolean {
  return current.alt
}

/** Both keys, as one value: what a padding drag reads to pick its sides. */
export function heldModifiers(): Modifiers {
  return current
}

/** Called when either key changes, for a gesture that re-answers with the pointer still. */
export function onModifiersChange(listener: (next: Modifiers) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Starts tracking. Idempotent, so every installer that reads a modifier can
 * call it and the first one wins: on `window` capture, ahead of any gesture
 * listener added later, so a gesture reading a modifier inside its own
 * `pointermove` always sees this event's keys.
 */
export function installModifiers(): void {
  if (installed) return
  installed = true
  window.addEventListener("pointermove", fromEvent, true)
  window.addEventListener("pointerdown", fromEvent, true)
  window.addEventListener("keydown", fromEvent, true)
  window.addEventListener("keyup", fromEvent, true)
  window.addEventListener("blur", () => read({ alt: false, shift: false }))
}
