/**
 * One pointer gesture, from press to release, and every way it can end early.
 *
 * Three gestures on the canvas hold the pointer: the move/resize drag
 * (`transform.ts`), the marquee sweep (`marquee.ts`) and the spacing-handle
 * drag (`spacing-handles.ts`). Each used to capture and release the pointer on
 * its own, two kept their own copy of the drag threshold, and each had its own
 * idea of what ends a gesture: blur ended only the spacing drag, a selection
 * change only the spacing drag, and Escape, a lost pointer capture, a lost
 * release, the editor standing down and a target leaving the page ended none of
 * them. A move whose release the browser never delivered kept following the
 * pointer with the button up, and the next press orphaned its preview: an
 * element left moved on the page with no note and no undo step.
 *
 * So the mechanics live here once. A gesture module keeps its own small state
 * union (what it is doing) and hands this the press; this owns the pointer
 * capture and the listeners for as long as the gesture lives, and calls back
 * exactly one of `release` or `cancel`, after which it has already let go of
 * everything.
 *
 * A track ends, in order of the checks below:
 *
 *   track --pointerup-----------------------------------> release (unless a guard fails first)
 *   track --pointercancel-------------------------------> cancel("pointercancel")
 *   track --lostpointercapture--------------------------> cancel("lost-capture")
 *   track --pointermove with no button down-------------> cancel("lost-release")
 *   track --Escape (or `cancelGestures`)----------------> cancel("escape")
 *   track --window blur---------------------------------> cancel("blur")
 *   track --`selectionOwnsInput()` turns false----------> cancel("stand-down")
 *   track --`valid()` turns false (target gone, deselected) --> cancel("invalid")
 *
 * The guards are asked on every pointer event and on every store change, so a
 * gesture notices the editor standing down or its target being deselected at
 * once, and a release can never commit what a guard would have refused.
 */

import { selectionOwnsInput, subscribe } from "../core/store"

/**
 * How far a press travels before it is a drag. Below it a press is a click, so
 * a hand that trembles on a click does not move the element or start a sweep.
 */
export const DRAG_THRESHOLD = 3

export type CancelReason =
  | "escape"
  | "pointercancel"
  | "lost-capture"
  | "lost-release"
  | "blur"
  | "stand-down"
  | "invalid"

export interface TrackHandlers {
  /** Each pointer move while the track lives, after the guards passed. */
  move(event: PointerEvent): void
  /** The release, after the guards passed. The track has already ended. */
  release(event: PointerEvent): void
  /** Every other way the gesture ends. The track has already ended. */
  cancel(reason: CancelReason): void
  /** Asked with the guards; false cancels with "invalid". */
  valid?(): boolean
}

export interface PointerTrack {
  readonly startX: number
  readonly startY: number
  /** Whether `event` is at least `DRAG_THRESHOLD` from the press. */
  crossed(event: { clientX: number; clientY: number }): boolean
  /** Lets go without a callback: listeners off, capture released. Idempotent. */
  end(): void
}

const live = new Set<{ cancel(reason: CancelReason): void }>()

/**
 * Cancels every live gesture, and says whether there was one.
 *
 * Escape's first meaning while a button is held. The canvas asks this before
 * it deselects, so Escape mid-drag puts the element back and keeps it
 * selected, as in Figma, instead of deselecting it and committing the move on
 * release.
 */
export function cancelGestures(reason: CancelReason): boolean {
  if (!live.size) return false
  for (const gesture of [...live]) gesture.cancel(reason)
  return true
}

/**
 * Takes the pointer for one gesture.
 *
 * `capture` is the element to hold pointer capture on, so the moves and the
 * release still arrive when the pointer leaves it or the window; null holds
 * none (a synthetic pointer, or an element that refuses).
 */
export function trackPointer(press: PointerEvent, capture: Element | null, handlers: TrackHandlers): PointerTrack {
  const pointerId = press.pointerId
  let ended = false
  let captured: Element | null = null

  if (capture && "setPointerCapture" in capture) {
    try {
      ;(capture as Element & { setPointerCapture(id: number): void }).setPointerCapture(pointerId)
      captured = capture
    } catch {
      // A synthetic pointer has nothing to capture; the window listeners still see it.
    }
  }

  const end = () => {
    if (ended) return
    ended = true
    live.delete(entry)
    window.removeEventListener("pointermove", onMove, true)
    window.removeEventListener("pointerup", onUp, true)
    window.removeEventListener("pointercancel", onPointerCancel, true)
    window.removeEventListener("lostpointercapture", onLostCapture, true)
    window.removeEventListener("keydown", onKey, true)
    window.removeEventListener("blur", onBlur)
    unsubscribe()
    if (captured && "releasePointerCapture" in captured) {
      try {
        ;(captured as Element & { releasePointerCapture(id: number): void }).releasePointerCapture(pointerId)
      } catch {
        // A removed element has already released capture.
      }
    }
    captured = null
  }

  const cancel = (reason: CancelReason) => {
    if (ended) return
    end()
    handlers.cancel(reason)
  }

  /** The guards every event passes first; true when the gesture was cancelled. */
  const refused = (): boolean => {
    if (!selectionOwnsInput()) cancel("stand-down")
    else if (handlers.valid && !handlers.valid()) cancel("invalid")
    return ended
  }

  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return
    // The button is up, so the release went somewhere this window never heard:
    // outside it, or after capture was lost to an element the app re-rendered.
    if (event.buttons === 0) return cancel("lost-release")
    if (refused()) return
    handlers.move(event)
  }

  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return
    if (refused()) return
    end()
    handlers.release(event)
  }

  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId === pointerId) cancel("pointercancel")
  }

  const onLostCapture = (event: PointerEvent) => {
    if (event.pointerId === pointerId) cancel("lost-capture")
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return
    // Spent, so the shell's Escape fallback does not also collapse the editor.
    event.preventDefault()
    cancel("escape")
  }

  const onBlur = () => cancel("blur")

  const unsubscribe = subscribe(() => {
    refused()
  })

  const entry = { cancel }
  live.add(entry)
  window.addEventListener("pointermove", onMove, true)
  window.addEventListener("pointerup", onUp, true)
  window.addEventListener("pointercancel", onPointerCancel, true)
  window.addEventListener("lostpointercapture", onLostCapture, true)
  window.addEventListener("keydown", onKey, true)
  window.addEventListener("blur", onBlur)

  return {
    startX: press.clientX,
    startY: press.clientY,
    crossed: (event) => Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) >= DRAG_THRESHOLD,
    end,
  }
}
