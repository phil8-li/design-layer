/**
 * The editor's floating chrome: where it is parked, the gesture that moves it,
 * and the round button the whole thing collapses into.
 *
 * Two things in one file, and the join is the gesture. The toolbar pill and
 * this disc are separate objects that are moved the same way, so the drag
 * belongs to neither of them: `installDrag` is the whole of it, and
 * `shell/toolbar.ts` imports it and adds nothing but its own box, its own
 * bounds and its own idea of what counts as ground.
 *
 * They each remember where they were put, separately. See the note below.
 *
 * The disc's treatment is Agentation's (agentation.com), because it is the
 * pattern a designer arriving at this editor has most likely already used: a
 * small dark disc pinned off the corner, slack before a press becomes a
 * drag, the press that turns into a drag never counting as a click, and the
 * position remembered for next time. The BEHAVIOUR below is that pattern; two
 * of the numbers are not. Their disc is 44px 20px off the edge, and ours is the
 * toolbar's height 32px off it — see `css/launcher.ts` for both arguments.
 *
 * Three places this improves on it rather than copying it. It listens for
 * POINTER events with capture instead of mouse events on `document`, so a pen
 * or a touch drags it too and the gesture cannot be lost to a window that takes
 * focus mid-drag; it ignores every contact after the first, because a second
 * finger landing on a surface already being dragged is the other hand steadying
 * a tablet and not a second gesture; and the move is applied inside an
 * animation frame rather than once per event, so a fast drag costs one layout
 * per frame instead of one per pointermove.
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
 */

import { TOOLBAR_HEIGHT } from "../core/css/toolbar"
import { clamp, el } from "../core/dom"
import { icon } from "../core/icons"
import { tokens } from "../core/tokens"

/**
 * The DISC's saved corner, and the only thing here that outlives the tab.
 *
 * See the note on `anchor` for why the shared position deliberately does not
 * join it in storage.
 */
const STORAGE_KEY = "designlayer:launcher-position"

/**
 * How far the pointer may travel before the disc's press becomes a drag.
 *
 * Without slack, a click delivered by a human hand — which always moves a
 * pixel or two between down and up — would leave the button somewhere new
 * instead of opening the editor. 10px is Agentation's figure and it is a good
 * one: bigger than a hand tremor, smaller than any movement meant as a drag.
 * The bar's ground uses the same ten, and used to use four. They are separate
 * objects, but they are moved by one gesture and a hand does not change size
 * between them — a threshold written twice is a number that drifts. The full
 * reasoning is in `shell/toolbar.ts`.
 */
const DRAG_SLACK = 10

/**
 * Matches the resting inset, so a dragged button lands where one could rest.
 *
 * Kept in agreement with `INSET` in `css/launcher.ts`, which is what puts the
 * disc in the corner before anything has dragged it.
 */
const EDGE = 32

/**
 * The disc's box, which the clamp needs in numbers before the disc is laid out.
 *
 * Imported from the bar's geometry rather than restated, because that is where
 * the disc's size now comes from — `css/launcher.ts` sizes it off the same
 * constant so the collapsed editor is exactly as tall as the expanded one. A
 * literal here would be the same number twice with nothing holding them
 * together, and this one is only ever read mid-drag, where being wrong shows up
 * as a disc that clamps to the wrong edge rather than as anything obvious.
 */
const SIZE = TOOLBAR_HEIGHT

export interface Launcher {
  element: HTMLButtonElement
  destroy(): void
}

export interface Point {
  x: number
  y: number
}

interface Size {
  width: number
  height: number
}

// ───────────────────────────── two surfaces, two positions ────

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

/**
 * One inset edge of the app area, read off `<html>` at the moment it is asked
 * for.
 *
 * The INLINE style rather than `getComputedStyle`, and not cached. Inline is
 * where `shell/shell.ts` writes these — so reading it is exact — and it is the
 * one way to ask that cannot force a style recalculation, which matters when
 * the question is asked on every frame of a drag. Cached, it would be wrong
 * the instant a panel was toggled, which is precisely the case this whole
 * clamp exists for.
 *
 * A missing or unparsable value is 0: a chrome that has not published its
 * insets yet is a chrome with no docked panels, which is the honest reading.
 */
function edge(name: string): number {
  const raw = document.documentElement.style.getPropertyValue(name)
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : 0
}

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
  const left = sides ? edge(sides[0]) : 0
  const right = sides ? edge(sides[1]) : 0
  const top = sides ? edge("--de-top") : 0
  const minX = left + inset
  const minY = top + inset
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

export interface DragOptions {
  element: HTMLElement
  /** Worn for the length of the gesture, so CSS can change the cursor. */
  dragging: string
  /** Travel before a press becomes a drag. */
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
  /** Draws the surface at a resolved top-left, inside an animation frame. */
  paint(box: Point): void
  /** Hands it back to the anchor the stylesheet gives it. */
  rest(): void
  /**
   * Where the stylesheet puts this surface when nothing has dragged it —
   * computed, so the clamp can check it, and RECOMPUTED rather than remembered.
   *
   * This is what lets a resting surface be bounded without being pinned. The
   * clamp needs a box and a resting surface has none; without one, `place`
   * could only hand the position back to CSS and hope, which is fine while the
   * stylesheet's own anchor tracks the panels and wrong the moment it stops.
   *
   * It is deliberately NOT a position that gets stored. If the clamp changes
   * nothing, the surface is handed back to the stylesheet and stays anchored
   * there — so a bottom-anchored pill is still bottom-anchored after a taller
   * window, which a frozen top-left would not be. Only when the resting place
   * is out of bounds does a box get painted, and that box lasts exactly as long
   * as the panel that displaced it.
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

export interface Drag {
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
 * The gesture, once, for both surfaces.
 *
 * Everything that differs between a 40px disc and a 600px pill is a callback:
 * how big it is, how it is drawn, what counts as its ground, where it is
 * remembered. Everything that does not — capture, the threshold, one contact at
 * a time, the frame, the clamp, the click a drag must not become — is here,
 * because two surfaces moved by the same hand should not answer any of those
 * differently.
 *
 * The position a drag resolves is the drag\'s own and stays there. This used to
 * publish to a position shared with the other surface; see the note at the top
 * of the file for why that went.
 */
export function installDrag(options: DragOptions): Drag {
  const { element } = options

  /**
   * Where this surface is, as a top-left. Null while it is resting on the
   * anchor the stylesheet gives it.
   *
   * This IS the remembered position. It is a closure variable rather than
   * anything more ceremonious because the gesture outlives every collapse and
   * expand of the session, exactly as the element does — so a bar that was
   * dragged is still dragged when the editor comes back, with nothing to
   * restore and nothing to keep in sync.
   */
  let box: Point | null = null
  /**
   * What is actually on screen, which is not always what was chosen.
   *
   * `box` is the surface's own position and only a drag (or a restored corner)
   * writes it. `shown` is wherever it was last painted, which includes the case
   * `box` cannot express: a RESTING surface that had to be nudged off its
   * stylesheet anchor because a panel opened over it. That nudge must not
   * become a dragged position — it would outlive the panel that caused it — so
   * it lives here and is thrown away the moment the clamp stops biting.
   *
   * Null means the stylesheet is in charge and nothing inline is set.
   */
  let shown: Point | null = null
  let frame = 0
  let placing = false

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

  const draw = (next: Point) => {
    shown = next
    if (frame) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      if (shown) options.paint(shown)
    })
  }

  /**
   * The same move, drawn NOW.
   *
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
   */
  const drawNow = (next: Point) => {
    shown = next
    if (frame) {
      window.cancelAnimationFrame(frame)
      frame = 0
    }
    options.paint(next)
  }

  /** Back to the stylesheet's anchor, with nothing inline left behind. */
  const stand = () => {
    shown = null
    if (frame) {
      window.cancelAnimationFrame(frame)
      frame = 0
    }
    options.rest()
  }

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
      const wanted = box ?? options.fallback?.() ?? null
      if (wanted) {
        /*
         * The clamp is WRITTEN BACK, and that is the "does not move back out"
         * rule in one line: a bar shoved aside by a panel keeps the shoved
         * position as its own, so shutting the panel re-clamps 602 against
         * wider bounds and leaves it at 602 rather than springing to the 862
         * the drag originally chose.
         *
         * Only a chosen position behaves this way. The resting branch below
         * deliberately does not write anything back — see `anchor`.
         */
        box = settle(wanted, bounds())
        drawNow(box)
        return
      }
      /*
       * Resting. `anchor` is asked where CSS would put it, and the answer is
       * only PAINTED if the bounds disagree with CSS — otherwise the stylesheet
       * keeps the surface, inline styles and all, exactly as before this
       * existed. A surface with no `anchor` has no second opinion to offer, so
       * it rests unconditionally, which is what the disc does.
       */
      const anchored = options.anchor?.() ?? null
      if (!anchored) {
        stand()
        return
      }
      const settled = settle(anchored, bounds())
      if (settled.x === anchored.x && settled.y === anchored.y) {
        stand()
        return
      }
      drawNow(settled)
    } finally {
      placing = false
    }
  }

  /*
   * A press, until it travels far enough to be a drag.
   *
   * `origin` is where the pointer went down and `from` where the surface was at
   * that moment, so it tracks the pointer's DELTA rather than jumping its
   * centre under the cursor — grabbing an object by its edge and having it
   * recentre itself is the small wrongness that makes a drag feel like a
   * teleport.
   */
  let pointer: number | null = null
  let origin: Point | null = null
  let from: Point | null = null
  let dragging = false
  /**
   * A drag that ends on a control must not also press it.
   *
   * The pointer went down and up inside the same element, so the browser fires
   * a click whatever happened in between; without this, parking the disc in a
   * new corner would also re-open the editor, and letting go of the bar over
   * the Apply button would write to source.
   */
  let dragged = false

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
    dragged = false
    // One contact. A second finger landing on a surface already being dragged
    // is not a second drag; it is the other hand steadying a tablet, and
    // letting it through makes the surface jump between two contact points.
    if (pointer !== null) return
    if (options.grabbable && !options.grabbable(event)) return
    pointer = event.pointerId
    origin = { x: event.clientX, y: event.clientY }
    /*
     * The measured rect only until the surface has been PAINTED once.
     *
     * After that the last drawn box IS where it is, and asking the browser
     * again would force a layout at the start of every gesture to learn
     * something we wrote ourselves. `shown` rather than `box`, because a
     * resting surface nudged clear of a panel has been painted somewhere its
     * own position does not know about — starting the drag from `box` there
     * would jump it back under the panel on the first pixel of travel.
     */
    from = shown ?? box ?? pickUp()
    dragging = false
    capture(event.pointerId)
  }

  const pickUp = (): Point => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left, y: rect.top }
  }

  const onPointerMove = (event: PointerEvent) => {
    if (pointer !== event.pointerId || !origin || !from) return
    const dx = event.clientX - origin.x
    const dy = event.clientY - origin.y
    if (!dragging) {
      if (Math.hypot(dx, dy) <= options.slack) return
      dragging = true
      dragged = true
      element.classList.add(options.dragging)
    }
    // The gesture writes `box` as well as painting: from the first pixel of
    // travel this surface has a position of its own, and `place` must stop
    // re-deriving it from the stylesheet's anchor mid-drag.
    box = settle({ x: from.x + dx, y: from.y + dy }, bounds())
    draw(box)
  }

  const endGesture = (event: PointerEvent) => {
    if (pointer !== event.pointerId) return
    release(event.pointerId)
    pointer = null
    origin = null
    from = null
    if (!dragging) return
    dragging = false
    element.classList.remove(options.dragging)
    // Clamped again rather than trusted: every frame of the drag already
    // settled, but a gesture that never moved after `pickUp` never went
    // through one, and the bounds can have moved under a drag that did.
    const landed = settle(box ?? shown ?? pickUp(), bounds())
    box = landed
    draw(landed)
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

  element.addEventListener("pointerdown", onPointerDown)
  element.addEventListener("pointermove", onPointerMove)
  element.addEventListener("pointerup", endGesture)
  element.addEventListener("pointercancel", endGesture)
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
   * at once, as before.
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
      if (!dragged) return false
      dragged = false
      return true
    },
    destroy() {
      firstLayout?.disconnect()
      window.removeEventListener("resize", onResize)
      element.removeEventListener("pointerdown", onPointerDown)
      element.removeEventListener("pointermove", onPointerMove)
      element.removeEventListener("pointerup", endGesture)
      element.removeEventListener("pointercancel", endGesture)
      if (frame) window.cancelAnimationFrame(frame)
    },
  }
}

// ──────────────────────────────────────── the disc itself ──────────────────

/** The saved corner, or null when there is none and the CSS anchor should win. */
function readSaved(): Point | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const { x, y } = parsed as Partial<Point>
    if (typeof x !== "number" || typeof y !== "number") return null
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  } catch {
    // Unreadable storage is not a reason to lose the button — it just starts
    // in the corner. Browsers throw here for blocked storage, not only for
    // malformed JSON.
    return null
  }
}

function writeSaved(point: Point): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(point))
  } catch {
    // Same bargain as reading: the drag still worked, it just will not persist.
  }
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
     * is the exact pairing Material gives a small FAB. 24 in 44 left 10, which
     * is not a step on the scale at all.
     */
    [icon("Cursor", tokens.icon.feature, "filled")]
  ) as HTMLButtonElement

  let saved = readSaved()

  const drag = installDrag({
    element,
    dragging: "de-launcher--dragging",
    slack: DRAG_SLACK,
    inset: EDGE,
    // No `sides`: the viewport, not the app area. The disc is only ever on
    // screen with the panels gone, so they are not its business — and reading
    // them parked it against an inspector that was not there. See `DragOptions`.
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
      writeSaved(box)
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
