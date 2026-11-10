/**
 * The gesture that moves the editor's floating chrome: the toolbar pill and
 * the launcher disc.
 *
 * The two are separate objects moved the same way, so the drag belongs to
 * neither of them. Everything that differs between a 40px disc and a 600px
 * pill is a callback in `DragOptions`; everything that does not — capture, the
 * threshold, one contact at a time, the frame, the clamp, the click a drag must
 * not become — is here, because two surfaces moved by the same hand should not
 * answer any of those differently.
 *
 * The behaviour is Agentation's (agentation.com): slack before a press becomes
 * a drag, the press that turns into a drag never counting as a click. Three
 * places this improves on it rather than copying it. It listens for POINTER
 * events with capture instead of mouse events on `document`, so a pen or a
 * touch drags it too and the gesture cannot be lost to a window that takes
 * focus mid-drag; it ignores every contact after the first, because a second
 * finger landing on a surface already being dragged is the other hand
 * steadying a tablet and not a second gesture; and the move is applied inside
 * an animation frame rather than once per event, so a fast drag costs one
 * layout per frame instead of one per pointermove.
 *
 * What it deliberately does NOT improve on is the edge. The bound used to
 * give: a rubber band followed the hand past it and handed the overhang back on
 * release. It is a hard clamp now, which is Agentation's behaviour and the
 * right one for these two surfaces — the band is borrowed from scrolling, where
 * what the overhang reveals is empty space the user owns. These two hang over
 * somebody else's product, so the overhang is live app pixels covered by chrome
 * that is not allowed to be there, and "momentarily wrong" is a flash of
 * hidden UI rather than a piece of physics.
 *
 * ## Two machines
 *
 * The GESTURE (`Gesture`, written only by `setGesture`) and the POSITION
 * (`Position`, written only by `setPosition`). Plus one flag, `suppressClick`:
 * the click the browser fires at the end of a drag is the tail of that drag
 * and not a press.
 *
 *   idle     --pointerdown (button 0, grabbable)--------> pressed
 *   pressed  --pointermove within DRAG_SLACK------------> pressed
 *   pressed  --pointermove past DRAG_SLACK--------------> dragging   (+suppressClick)
 *   dragging --pointermove------------------------------> dragging   (position: placed)
 *   pressed  --pointerup | pointercancel | lostcapture--> idle
 *   dragging --pointerup--------------------------------> idle       (lands; click suppressed)
 *   dragging --pointercancel | lostpointercapture-------> idle       (lands; suppressClick cleared)
 *   pressed | dragging --pointerdown (another pointer)--> unchanged
 *   any      --pointerdown------------------------------> clears suppressClick first
 *   any      --click, dragEnded()-----------------------> consumes suppressClick
 *
 *   resting  --place, anchor out of bounds-----------------> nudged
 *   nudged   --place, anchor back in bounds----------------> resting
 *   resting | nudged --place with a fallback (saved corner)--> placed
 *   resting | nudged --pointermove past DRAG_SLACK---------> placed
 *   placed   --place | resize | insets change--------------> placed (re-clamped, written back)
 *
 * A cancel ends no click, so it must not leave `suppressClick` standing: the
 * next Enter or Space on the focused disc fires a click with no pointerdown in
 * front of it, and a stale flag would swallow it. A lost capture (the element
 * left the document mid-drag, an OS interruption) is a cancel; without it the
 * gesture stayed `dragging` and every later press was ignored.
 */

import { clamp } from "../core/dom"
import { readInset } from "./insets"

/**
 * How far the pointer may travel before a press becomes a drag. One number for
 * both surfaces.
 *
 * Without slack, a click delivered by a human hand — which always moves a
 * pixel or two between down and up — would leave the surface somewhere new
 * instead of pressing it. 10px is Agentation's figure: bigger than a hand
 * tremor, smaller than any movement meant as a drag. The bar's ground used
 * four, on the argument that it has no press to steal; but the bar and the disc
 * are moved by one hand, and a hand does not steady itself differently for a
 * 600px pill than for a 40px disc. (`canvas/marquee.ts` still uses three, and
 * should: a marquee's press has a selection to protect rather than a position.)
 */
export const DRAG_SLACK = 10

export interface Point {
  x: number
  y: number
}

interface Size {
  width: number
  height: number
}

/*
 * Each surface remembers where IT was put. There is no shared position.
 *
 * There was one, and it was the wrong model. The bar and the disc were treated
 * as one object with two appearances, so dragging either moved both and the bar
 * came back wherever the disc had been parked. That follows from a collapse
 * that MORPHS one into the other — which this no longer does. The editor stands
 * down by fading the bar out where it is, sliding the panels off their own
 * edges, and showing the disc in the corner; nothing travels, so nothing has to
 * agree about where it travelled to.
 *
 * With them uncoupled, "remember the position" means the obvious thing and each
 * surface answers it for itself: the drag holds the box it last resolved, which
 * outlives every collapse and expand of the session because the element and its
 * gesture both do. `fallback` is only the seed for a surface that has a
 * position from somewhere else before it has one of its own — the disc's saved
 * corner, and nothing else uses it.
 *
 * A dragged bar is deliberately NOT written to storage. It survives every
 * collapse, which is what was asked for; it does not survive a reload, because
 * a 600px pill that reappears in the middle of a freshly loaded page reads as a
 * layout that has broken rather than as a preference being honoured, and there
 * is nothing on screen at that moment to explain it. The disc does persist: it
 * is 40px, it rests in a corner by design, and that memory is Agentation's
 * contract with the user.
 */

interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/**
 * Where a surface of this size is allowed to sit: the app area, inset by the
 * margin the surface rests at, never the viewport.
 *
 * The viewport is the wrong box and always was. A bar dragged to x = 0 with the
 * layers panel open is a bar underneath the layers panel, which is not a place
 * the user chose — it is a place they lost the bar to.
 *
 * The insets are read off `<html>`'s inline style on every call and never
 * cached: cached, they would be wrong the instant a panel was toggled, which is
 * precisely the case this whole clamp exists for. The top edge is 0: no panel
 * docks there.
 *
 * `Math.max(minX, …)` for the far edge: when the area is narrower than the
 * surface there is no legal range at all, and pinning it to the near edge keeps
 * the surface visible instead of letting the clamp invert and throw it off the
 * other side.
 */
function boundsFor(size: Size, inset: number, sides?: readonly [string, string]): Bounds {
  /*
   * No `sides` means the VIEWPORT, and that is a different claim rather than a
   * missing one. See `DragOptions.sides`.
   */
  const left = sides ? readInset(sides[0]) : 0
  const right = sides ? readInset(sides[1]) : 0
  const minX = left + inset
  const minY = inset
  return {
    minX,
    maxX: Math.max(minX, window.innerWidth - right - size.width - inset),
    minY,
    maxY: Math.max(minY, window.innerHeight - size.height - inset),
  }
}

/**
 * Where the surface lands, and also where it is while the hand still holds it.
 *
 * One function for both, which is the whole of the edge behaviour: the bound
 * is hard, so there is never an overhang to hand back. See the note at the top
 * of this file for why the rubber band that used to live here went.
 */
function settle(box: Point, bounds: Bounds): Point {
  return {
    x: clamp(box.x, bounds.minX, bounds.maxX),
    y: clamp(box.y, bounds.minY, bounds.maxY),
  }
}

interface DragOptions {
  element: HTMLElement
  /** Worn for the length of the gesture, so CSS can change the cursor. */
  dragging: string
  /** Travel before a press becomes a drag. Both surfaces pass `DRAG_SLACK`. */
  slack: number
  /** The margin this surface keeps from every edge of the app area. */
  inset: number
  /**
   * The pair of custom properties that bound it horizontally, or NOTHING to
   * bound it by the viewport.
   *
   * The pair is for a surface that shares the screen with the docked panels and
   * must not end up underneath one. `--de-bar-left`/`--de-bar-right` are the
   * ones to read: they hold their value while the chrome is hidden, where
   * `--de-left`/`--de-right` collapse to zero. See `shell/toolbar.ts`.
   *
   * Omitting it is the disc's answer, and it is a claim rather than an
   * oversight. The disc is only ever on screen while the editor is stood down,
   * and a stood-down editor has no panels — so the app area IS the viewport,
   * and bounding it by the panels invents a boundary that is not there at the
   * only moment it can be seen. It also broke the thing it was meant to
   * protect: the disc was resolved at mount, with the panels open, so one saved
   * in the bottom-right corner was clamped to the inspector's inner edge and
   * stayed there — parked against a panel that was not on screen with it,
   * 282px from the corner it had been left in, and closing the panel did not
   * give it back.
   */
  sides?: readonly [string, string]
  size(): Size
  /** Draws the surface at a resolved top-left. */
  paint(box: Point): void
  /** Hands it back to the anchor the stylesheet gives it. */
  rest(): void
  /**
   * Where the stylesheet puts this surface when nothing has dragged it —
   * computed, so the clamp can check it, and RECOMPUTED rather than remembered.
   *
   * This is what lets a resting surface be bounded without being pinned. If
   * the clamp changes nothing, the surface is handed back to the stylesheet
   * and stays anchored there — so a bottom-anchored pill is still
   * bottom-anchored after a taller window, which a frozen top-left would not
   * be. Only when the resting place is out of bounds is a box painted
   * (`nudged`), and that box lasts exactly as long as the panel that displaced
   * it.
   *
   * That is the difference between this and a DRAG, and it is the whole reason
   * they are separate. A dragged surface does not move back out, because the
   * user chose where it went; a displaced one does, because nobody chose the
   * edge of a panel.
   *
   * Must agree with the stylesheet. Two answers for "where does it rest" is a
   * surface that jumps the first time anything re-places it.
   */
  anchor?(): Point | null
  /**
   * A position from BEFORE this drag existed — a corner restored from storage,
   * and nothing else. Consulted only until the surface has a box of its own.
   */
  fallback?(): Point | null
  /** False for a press that belongs to a control rather than to the ground. */
  grabbable?(event: PointerEvent): boolean
  /** The gesture's final box, for a surface that records where it landed. */
  landed?(box: Point): void
}

interface Drag {
  /** Re-reads the bounds and redraws. For a resize, or a panel toggle. */
  place(): void
  /**
   * True exactly once after a drag: the click the browser is about to fire is
   * the tail of that drag and not a press.
   */
  dragEnded(): boolean
  destroy(): void
}

/**
 * A press, until it travels far enough to be a drag.
 *
 * `origin` is where the pointer went down and `from` where the surface was at
 * that moment, so it tracks the pointer's DELTA rather than jumping its centre
 * under the cursor — grabbing an object by its edge and having it recentre
 * itself is the small wrongness that makes a drag feel like a teleport.
 */
type Gesture =
  | { kind: "idle" }
  | { kind: "pressed" | "dragging"; pointer: number; origin: Point; from: Point }

/**
 * Where the surface is.
 *
 * `placed` is the surface's OWN position: a drag wrote it, or a restored
 * corner seeded it. It is a closure value rather than anything more
 * ceremonious because the gesture outlives every collapse and expand of the
 * session, exactly as the element does — so a bar that was dragged is still
 * dragged when the editor comes back, with nothing to restore.
 *
 * `nudged` is the case `placed` cannot express: a RESTING surface that had to
 * be painted off its stylesheet anchor because a panel opened over it. That
 * nudge must not become a dragged position — it would outlive the panel that
 * caused it — so it is thrown away the moment the clamp stops biting.
 *
 * `resting` means the stylesheet is in charge and nothing inline is set.
 */
type Position = { kind: "resting" } | { kind: "nudged"; shown: Point } | { kind: "placed"; box: Point }

export function installDrag(options: DragOptions): Drag {
  const { element } = options

  let gesture: Gesture = { kind: "idle" }
  let position: Position = { kind: "resting" }
  /**
   * A drag that ends on a control must not also press it.
   *
   * The pointer went down and up inside the same element, so the browser fires
   * a click whatever happened in between; without this, parking the disc in a
   * new corner would also re-open the editor.
   */
  let suppressClick = false
  let frame = 0
  let placing = false

  /** The one writer of the gesture. The dragging class follows `dragging`. */
  const setGesture = (next: Gesture) => {
    const was = gesture.kind === "dragging"
    const is = next.kind === "dragging"
    gesture = next
    if (was !== is) element.classList.toggle(options.dragging, is)
  }

  /** What is on screen as a top-left, or null while the stylesheet has it. */
  const shown = (): Point | null =>
    position.kind === "placed" ? position.box : position.kind === "nudged" ? position.shown : null

  /**
   * The one writer of the position, and of what is painted.
   *
   * `now` paints in this task; otherwise the paint waits for the next frame.
   * The frame exists for the drag: a fast pointer fires several moves between
   * paints, and batching them costs one layout per frame instead of one per
   * event. Nothing about a re-place is like that — it happens once, when a
   * panel opens or the window changes or the object is put somewhere — and
   * deferring it is actively wrong in one case that matters.
   *
   * That case is the collapse. The pill's trip to the disc is a delta between
   * two resolved boxes, computed in the same task that flips the state class so
   * that the browser reads both in one style recalculation. A re-place whose
   * paint is still a frame away would have the bar animating from the position
   * it held BEFORE the re-place toward a target computed for the one after —
   * one frame in the wrong place at the start of the motion, and `left`/`top`
   * are not transitioned, so it lands as a jump rather than as a slide.
   *
   * `resting` hands the surface back to the stylesheet, with nothing inline
   * left behind.
   */
  const setPosition = (next: Position, now: boolean) => {
    position = next
    if (next.kind === "resting" || now) {
      if (frame) {
        window.cancelAnimationFrame(frame)
        frame = 0
      }
      if (next.kind === "resting") options.rest()
      else options.paint(next.kind === "placed" ? next.box : next.shown)
      return
    }
    if (frame) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      const box = shown()
      if (box) options.paint(box)
    })
  }

  /**
   * Pointer capture, where there is such a thing.
   *
   * Every browser has it, and without it a drag would stop tracking the moment
   * the pointer outran the surface — which it does immediately on the disc, and
   * on any bar drag that crosses the page. jsdom does not implement it and two
   * suites drive this file there, so it is asked for rather than assumed, and
   * the drag still works either way as long as the pointer stays over the
   * element.
   */
  const capture = (pointerId: number) => {
    if (typeof element.setPointerCapture !== "function") return
    element.setPointerCapture(pointerId)
  }
  const release = (pointerId: number) => {
    if (typeof element.hasPointerCapture !== "function") return
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
  }

  const bounds = () => boundsFor(options.size(), options.inset, options.sides)

  /**
   * Re-resolve where this surface sits and redraw it there.
   *
   * The position is its own — the box it last landed on, or the one `fallback`
   * seeded it with before it had landed anywhere. What this re-runs is the
   * CLAMP, because the bounds move even when the surface does not: a panel
   * opens over the bar, the window narrows, the chrome stands down and takes
   * the insets with it.
   *
   * Re-clamped rather than re-proportioned, and A CHOSEN POSITION does not
   * move back out. A surface the user dragged and a panel then shoved must not
   * shift a second time because that panel shut — they put it somewhere, it
   * moves only as far as it has to, and then it stays.
   *
   * A RESTING surface is the other case, and the two are not the same promise.
   * Nobody chose the stylesheet's anchor, so nothing is owed to the place a
   * panel pushed it to: it is re-derived from `anchor` every time, clamped, and
   * handed straight back to CSS whenever the clamp turns out not to bite. That
   * is what keeps a bottom-anchored pill anchored to the bottom — the common
   * case writes no inline position at all — while still guaranteeing it never
   * ends up underneath a panel.
   */
  const place = () => {
    if (placing) return
    placing = true
    try {
      const wanted = position.kind === "placed" ? position.box : (options.fallback?.() ?? null)
      if (wanted) {
        /*
         * The clamp is WRITTEN BACK, and that is the "does not move back out"
         * rule in one line: a bar shoved aside by a panel keeps the shoved
         * position as its own, so shutting the panel re-clamps 602 against
         * wider bounds and leaves it at 602 rather than springing to the 862
         * the drag originally chose.
         */
        setPosition({ kind: "placed", box: settle(wanted, bounds()) }, true)
        return
      }
      /*
       * Resting. `anchor` is asked where CSS would put it, and the answer is
       * only PAINTED if the bounds disagree with CSS. A surface with no
       * `anchor` has no second opinion to offer, so it rests unconditionally,
       * which is what the disc does.
       */
      const anchored = options.anchor?.() ?? null
      const settled = anchored ? settle(anchored, bounds()) : null
      if (!anchored || !settled || (settled.x === anchored.x && settled.y === anchored.y)) {
        setPosition({ kind: "resting" }, true)
      } else {
        setPosition({ kind: "nudged", shown: settled }, true)
      }
    } finally {
      placing = false
    }
  }

  const pickUp = (): Point => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left, y: rect.top }
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    /*
     * Cleared before the ground check, not after.
     *
     * The flag exists only to kill the click a drag is about to produce, and a
     * new press means that click is never coming. Left standing through a press
     * that lands on a control — which returns below without arming anything —
     * it would swallow that control's click instead, one gesture later and for
     * no reason the user could see.
     */
    suppressClick = false
    // One contact: see the header.
    if (gesture.kind !== "idle") return
    if (options.grabbable && !options.grabbable(event)) return
    setGesture({
      kind: "pressed",
      pointer: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      /*
       * The measured rect only until the surface has been PAINTED once.
       *
       * After that the last drawn box IS where it is, and asking the browser
       * again would force a layout at the start of every gesture to learn
       * something we wrote ourselves. A `nudged` surface counts: starting the
       * drag from anywhere else would jump it back under the panel that
       * nudged it on the first pixel of travel.
       */
      from: shown() ?? pickUp(),
    })
    capture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (gesture.kind === "idle" || gesture.pointer !== event.pointerId) return
    const { origin, from } = gesture
    const dx = event.clientX - origin.x
    const dy = event.clientY - origin.y
    if (gesture.kind === "pressed") {
      if (Math.hypot(dx, dy) <= options.slack) return
      suppressClick = true
      setGesture({ ...gesture, kind: "dragging" })
    }
    // The gesture writes a `placed` position as well as painting: from the
    // first pixel of travel this surface has a position of its own, and
    // `place` must stop re-deriving it from the stylesheet's anchor mid-drag.
    setPosition({ kind: "placed", box: settle({ x: from.x + dx, y: from.y + dy }, bounds()) }, false)
  }

  /** pointerup, pointercancel and lostpointercapture: every way a gesture ends. */
  const endGesture = (event: PointerEvent) => {
    if (gesture.kind === "idle" || gesture.pointer !== event.pointerId) return
    const wasDragging = gesture.kind === "dragging"
    // Idle BEFORE the release, so the `lostpointercapture` the release fires
    // finds no gesture to end a second time.
    setGesture({ kind: "idle" })
    release(event.pointerId)
    if (!wasDragging) return
    // No click follows a cancel, so nothing will consume the flag; left up, it
    // would swallow the next keyboard press of the disc.
    if (event.type !== "pointerup") suppressClick = false
    // Clamped again rather than trusted: every frame of the drag already
    // settled, but the bounds can have moved under it.
    const landed = settle(shown() ?? pickUp(), bounds())
    setPosition({ kind: "placed", box: landed }, false)
    options.landed?.(landed)
  }

  /**
   * A window that shrank must not leave the surface off the edge of it.
   *
   * Re-clamped rather than re-proportioned: the user put it somewhere, and a
   * surface that drifted to the middle because the window got narrower would
   * have moved itself somewhere nobody asked for.
   */
  const onResize = () => place()

  const ends = ["pointerup", "pointercancel", "lostpointercapture"] as const
  element.addEventListener("pointerdown", onPointerDown)
  element.addEventListener("pointermove", onPointerMove)
  for (const type of ends) element.addEventListener(type, endGesture)
  window.addEventListener("resize", onResize)
  /*
   * The first placement of a RESTING surface waits for the first layout.
   *
   * Checking the anchor means measuring the surface, and at install that is a
   * forced layout of the whole document in the middle of boot — the shell has
   * just inset the app, and the panels that follow dirty it all again, so the
   * browser lays the page out twice before the first paint. A ResizeObserver's
   * first delivery comes after the frame's own layout and before its paint, so
   * the measurement is free there and a clamp that bites still lands before
   * anything is drawn. A surface with no anchor (the disc, which can start out
   * with no box for an observer to report) and a DOM without observers place
   * at once.
   */
  let firstLayout: ResizeObserver | null = null
  if (options.anchor && typeof ResizeObserver === "function") {
    firstLayout = new ResizeObserver(() => {
      firstLayout?.disconnect()
      firstLayout = null
      place()
    })
    firstLayout.observe(element)
  } else {
    place()
  }

  return {
    place,
    dragEnded() {
      if (!suppressClick) return false
      suppressClick = false
      return true
    },
    destroy() {
      firstLayout?.disconnect()
      window.removeEventListener("resize", onResize)
      element.removeEventListener("pointerdown", onPointerDown)
      element.removeEventListener("pointermove", onPointerMove)
      for (const type of ends) element.removeEventListener(type, endGesture)
      if (frame) window.cancelAnimationFrame(frame)
    },
  }
}
