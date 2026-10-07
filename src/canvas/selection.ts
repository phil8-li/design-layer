/**
 * Selection and hover chrome drawn in the overlay layer.
 *
 * Geometry is read every frame while something is selected and anything can be
 * moving: the app animates with Motion, so a cached rect would drift behind the
 * element it outlines. Once every box has held still for a few frames the loop
 * rests, and `./motion-watch` wakes it on the frame anything starts to move.
 * Guides and measurements paint from this same loop — a second rAF loop would
 * double the layout reads every frame costs.
 */

import { el, isCanvasElement } from "../core/dom"
import { prefersReducedMotion } from "../core/motion"
import { formatDistance, measureSpacing, type Box, type Measurement } from "./measure"
import { moving, watchForMotion } from "./motion-watch"
import { isAltDown } from "./transform"
import { editorStandDownChanged, selectionOwnsInput } from "../core/store"
import { tokens } from "../core/tokens"
import type { EditorContext } from "../core/context"

const HANDLES = [
  ["nw", 0, 0, "nwse-resize"],
  ["n", 0.5, 0, "ns-resize"],
  ["ne", 1, 0, "nesw-resize"],
  ["e", 1, 0.5, "ew-resize"],
  ["se", 1, 1, "nwse-resize"],
  ["s", 0.5, 1, "ns-resize"],
  ["sw", 0, 1, "nesw-resize"],
  ["w", 0, 0.5, "ew-resize"],
] as const

export type HandleId = (typeof HANDLES)[number][0]

/** Handles read as 7px but grab at 13px: Fitts' law without the visual bulk. */
const HANDLE_SIZE = 7
const HANDLE_HIT = 13

export interface NodePool {
  /** Returns a visible node; call `flush()` once per pass to hide the rest. */
  take(): HTMLElement
  flush(): void
}

/**
 * Shown and hidden as ONE pair of properties, everywhere in this layer.
 *
 * `display` alone is what every node here used to switch on, and it cannot be
 * transitioned: the browser takes the node out of the box tree on the frame it
 * changes, so an outline appearing and a guide vanishing were cuts with nothing
 * to say they had happened — the most repeated state change in the editor, and
 * the one with the least to show for it.
 *
 * Writing `opacity` beside it hands that decision to the stylesheet. WHICH
 * properties actually move is `css/canvas.ts`'s call and differs per class —
 * the outline fades both ways, a guide fades in and leaves at once — and the
 * two writes here are the same either way, so no painter has to know which.
 *
 * `display` is still written, and still inline, because it is what keeps a
 * hidden node out of hit-testing and out of paint. `allow-discrete` in the
 * stylesheet holds its USED value back for the length of the fade without
 * changing what `style.display` reads back as.
 */
function setShown(node: HTMLElement, shown: boolean): void {
  /*
   * Written only when it changes — a cheap guard on a hot path, and honestly
   * reported: it measured as NEUTRAL in Chrome rather than as a saving.
   *
   * This runs for every overlay node on every animation frame the loop runs, so
   * re-asserting an unchanged `display` looked like the obvious waste to
   * remove. It is not where the time goes; the engine already drops an inline
   * write of an identical value. Kept anyway because it is one inline
   * read against a style mutation, it makes the write self-describing, and not
   * every engine is Chrome — but it is not the optimisation it looks like, and
   * the next person should not go hunting for the saving it does not make.
   *
   * Where the time actually goes is in `css/canvas.ts`, on the transition list
   * itself. The measurement is recorded there.
   */
  const next = shown ? "block" : "none"
  if (node.style.display === next) return
  node.style.display = next
  /*
   * Empty, not `"1"`, and the difference is a bug this used to cause.
   *
   * An inline declaration beats a stylesheet at any specificity, so writing `1`
   * here overruled `.de-outline--related { opacity: 0.82 }` and every related
   * outline painted at full strength — the same weight as the selection it is
   * supposed to sit behind. Clearing the property instead lets each class state
   * its own resting opacity, which is where that decision belongs.
   *
   * Only the zero is pinned: a hidden node has one correct opacity whatever
   * class it wears, and the fade out has to have something to animate to.
   */
  node.style.opacity = shown ? "" : "0"
}

/** Overlay nodes are pooled so the per-frame painters never allocate DOM. */
export function createNodePool(parent: HTMLElement, className: string): NodePool {
  const nodes: HTMLElement[] = []
  let used = 0
  return {
    take() {
      let node = nodes[used]
      if (!node) {
        node = el("div", { class: className })
        parent.append(node)
        nodes.push(node)
      }
      setShown(node, true)
      used += 1
      return node
    },
    flush() {
      for (let index = used; index < nodes.length; index += 1) setShown(nodes[index], false)
      used = 0
    },
  }
}

/** Positions an overlay node; sizes are omitted for auto-sized nodes. */
export function placeNode(
  node: HTMLElement,
  x: number,
  y: number,
  width?: number,
  height?: number
): void {
  node.style.transform = `translate(${x}px, ${y}px)`
  if (width !== undefined) node.style.width = `${width}px`
  if (height !== undefined) node.style.height = `${height}px`
}

/** Centres an auto-sized badge on a point. */
export function placeBadge(node: HTMLElement, x: number, y: number, text: string): void {
  node.textContent = text
  node.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
}

/**
 * The hover outline, published to the lane that owns the modifier keys.
 *
 * Module-level because the node is built inside `installSelectionFrame` and
 * there is exactly one of it on a page. The alternative was handing it out
 * through the context, which would put a DOM reference into the store so that
 * one keyboard handler could reach it.
 */
let hoverOutlineNode: HTMLElement | null = null
/** Wakes the frame loop from a rest, for the dip's timer below. */
let wakePainter: (() => void) | null = null

/** The class `css/canvas.ts` pins to zero opacity for the length of a dip. */
const DIP_CLASS = "de-outline--dip"
/** Read off the token rather than restated, the way `core/leave.ts` does it. */
const DIP_MS = Number.parseFloat(tokens.duration.exit)
let dipTimer = 0
/** While true the painter leaves the hover outline where it is. See below. */
let dipHeld = false

/**
 * Let the hover outline MOVE while nobody can see it move.
 *
 * A modifier held or released with the pointer completely stationary changes
 * which element a click would land on, so the outline has to re-answer — and
 * with no pointer travel to carry the change, the box teleports from the
 * shallow element to the deep one between two frames, which reads as a glitch
 * rather than as an answer to the key.
 *
 * A fade rather than a crossfade between two nodes, and that is forced rather
 * than chosen: this file rewrites `transform`, `width` and `height` on every
 * overlay node EVERY animation frame, so the outline's GEOMETRY can never be
 * transitioned — an overlay that eased into place would trail the element it
 * outlines by the length of the ease, for the whole of every drag. `opacity` is
 * the one property the frame loop never writes, so it is the only one there is
 * to spend on this.
 *
 * WHAT IS DEFERRED IS THE PAINT, NOT THE STATE. The store's `hovered` still
 * changes on the key, synchronously, because it is the answer to "what would a
 * click take" and every other reader of it — the layers tree, the click path
 * itself — is entitled to that answer now. Only this one node holds still,
 * which is why the hold is a flag the painter reads rather than a delay in
 * front of `setHovered`: the outline is allowed to lag the truth for exactly as
 * long as it is invisible, and not one frame longer.
 */
export function dipHoverOutline(): void {
  const node = hoverOutlineNode
  /*
   * Nothing to hide behind, in either case, so the move just happens. An
   * outline that is not on screen fades in from `@starting-style` when the
   * painter shows it; and a reader who asked for reduced motion has no fade at
   * all, because the blanket in `css/base.ts` clamps this node's transitions to
   * 0.01ms — dipping there would punch a hole in the overlay for the length of
   * the timer and buy nothing for it.
   */
  if (!node || node.style.display === "none" || prefersReducedMotion()) return
  if (dipTimer) window.clearTimeout(dipTimer)
  node.classList.add(DIP_CLASS)
  dipHeld = true
  dipTimer = window.setTimeout(() => {
    dipTimer = 0
    dipHeld = false
    wakePainter?.()
    /*
     * The hold is dropped here and the class one frame later, in that order.
     * The frame loop's own callback is queued ahead of this one — it requeues
     * itself at the end of every draw, and the wake above queues it when the
     * loop was resting — so it places the new geometry first and this clears the dip second, both
     * inside one style recalculation. Clearing the class first would fade the
     * outline back in around the box it is about to leave, which is the
     * teleport again with an extra step in front of it.
     *
     * Guarded, because a second modifier press landing inside that one frame
     * starts a fresh dip — and this callback, queued by the dip before it,
     * would otherwise clear the class while the painter is still holding the
     * outline still, showing the frozen box it exists to hide.
     */
    requestAnimationFrame(() => {
      if (!dipTimer) node.classList.remove(DIP_CLASS)
    })
  }, DIP_MS)
}

/**
 * End a dip now, wherever it had got to.
 *
 * For the pointer, which outranks the keyboard on this question: a move is a
 * fresh answer to "what is under the pointer", it carries its own change, and
 * the travel is the transition. Leaving the dip running would hold the outline
 * frozen and invisible while the pointer was visibly somewhere else.
 */
export function releaseHoverDip(): void {
  if (!dipTimer) return
  window.clearTimeout(dipTimer)
  dipTimer = 0
  dipHeld = false
  hoverOutlineNode?.classList.remove(DIP_CLASS)
}

/**
 * What Alt measures the selection against, or null when there is nothing to
 * measure. Figma's rule: the hovered layer, and when the pointer is over the
 * selection itself, the layer that holds it — the distance a designer is
 * usually checking there is the inset inside the parent.
 */
function measureTarget(selected: readonly Element[], hovered: Element | null): Element | null {
  if (!hovered || !hovered.isConnected) return null
  if (!selected.includes(hovered)) return hovered
  for (let node = selected[0]?.parentElement ?? null; node; node = node.parentElement) {
    // Widened to a plain boolean: the guard's false branch would narrow an
    // Element to `never` and take the loop's step with it.
    const canvas: boolean = isCanvasElement(node)
    if (canvas) return node
  }
  return null
}

const boxOf = (rect: DOMRect): Box => ({
  left: rect.left,
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
})

export function installSelectionFrame(context: EditorContext): void {
  const layer = context.slots.overlay
  const hoverOutline = el("div", { class: "de-outline de-outline--hover" })
  hoverOutlineNode = hoverOutline
  const boundsOutline = el("div", { class: "de-outline" })
  layer.append(hoverOutline, boundsOutline)

  // Per-element outlines for a multi-selection; `boundsOutline` wraps the set.
  const members = createNodePool(layer, "de-outline")
  const related = createNodePool(layer, "de-outline de-outline--related")
  let highlighted: Element[] = []

  // Alt's spacing readout. Its own pools rather than snapping's: both can be
  // live in one frame (Alt held through a drag), and each painter flushes its
  // pool every pass, so a shared pool would hide the other's nodes.
  const measureLines = createNodePool(layer, "de-guide")
  const measureDashesX = createNodePool(layer, "de-guide de-guide--dashed-x")
  const measureDashesY = createNodePool(layer, "de-guide de-guide--dashed-y")
  const measureBadges = createNodePool(layer, "de-badge de-badge--measure")

  const flushMeasurements = () => {
    measureLines.flush()
    measureDashesX.flush()
    measureDashesY.flush()
    measureBadges.flush()
  }

  /** Lines and dashes are 1px nodes; badges sit below a row and right of a column. */
  const paintMeasurement = (measurement: Measurement | null) => {
    for (const line of measurement?.lines ?? []) {
      if (line.axis === "x") {
        placeNode(measureLines.take(), line.x, line.y, line.length, 1)
        placeBadge(measureBadges.take(), line.x + line.length / 2, line.y + 12, formatDistance(line.value))
      } else {
        placeNode(measureLines.take(), line.x, line.y, 1, line.length)
        placeBadge(measureBadges.take(), line.x + 14, line.y + line.length / 2, formatDistance(line.value))
      }
    }
    for (const dash of measurement?.extensions ?? []) {
      if (dash.axis === "x") placeNode(measureDashesX.take(), dash.x, dash.y, dash.length, 1)
      else placeNode(measureDashesY.take(), dash.x, dash.y, 1, dash.length)
    }
    flushMeasurements()
  }

  const handles = new Map<HandleId, HTMLElement>()
  const inset = (HANDLE_HIT - HANDLE_SIZE) / 2
  for (const [id, , , cursor] of HANDLES) {
    const visual = el("div", {
      class: "de-handle",
      style: `margin:0;left:${inset}px;top:${inset}px;pointer-events:none`,
    })
    handles.set(
      id,
      el(
        "div",
        {
          // The hit box is the node the painter shows, places and hit-tests, so
          // it is also the node that carries the fade and the one `:hover` can
          // reach — the 7px drawing inside it is `pointer-events: none`, which
          // is why a `.de-handle:hover` rule could never have fired.
          class: "de-handle-hit",
          "data-handle": id,
          style: `position:absolute;width:${HANDLE_HIT}px;height:${HANDLE_HIT}px;margin:${-HANDLE_HIT / 2}px 0 0 ${-HANDLE_HIT / 2}px;pointer-events:auto;cursor:${cursor}`,
        },
        [visual]
      )
    )
  }
  layer.append(...handles.values())

  const hide = (node: HTMLElement) => {
    setShown(node, false)
  }

  const hideAll = () => {
    hide(hoverOutline)
    hide(boundsOutline)
    members.flush()
    related.flush()
    flushMeasurements()
    for (const handle of handles.values()) hide(handle)
  }

  /** Last pass's geometry, so a still page can let the frame loop rest. */
  let geometry: number[] = []
  /** The non-geometric inputs the last pass drew with; see the skip below. */
  let drawnWith = ""

  /** Paints, and answers whether any box moved since the last pass. */
  const paintSelection = (): boolean => {
    const state = context.getState()
    const selection = state.selection

    // Interactive mode is a claim that the editor is not there, and hidden
    // chrome is the same claim made louder. An outline left standing over an
    // app the user is now clicking through is the one thing that would
    // disprove either, so the chrome goes before the handlers do. Asked
    // through the store's gate rather than off `state.interactive`, so a
    // second reason to stand down cannot forget to reach the painter.
    if (!selectionOwnsInput()) {
      hideAll()
      geometry = []
      return false
    }

    // Every rect this frame needs is read before anything is written. Writing a
    // style between two reads invalidates layout, so an interleaved loop forces
    // one synchronous reflow per selected element — on every animation frame.
    // Any selected element already draws its own stroke; a hover outline on top
    // of one would read as a second, thicker border rather than as feedback.
    const rects: DOMRect[] = []
    for (const entry of selection) {
      if (!entry.element.isConnected) continue
      rects.push(entry.element.getBoundingClientRect())
    }
    // Alt with something selected measures from the selection's bounds to the
    // target, and the target wears the hover outline — including the parent,
    // which is otherwise never outlined while the pointer sits on its child.
    const target =
      isAltDown() && rects.length > 0
        ? measureTarget(
            selection.map((entry) => entry.element),
            state.hovered
          )
        : null
    const targetRect = target ? target.getBoundingClientRect() : null
    const hoverRect =
      targetRect ??
      (state.hovered && !selection.some((entry) => entry.element === state.hovered)
        ? state.hovered.getBoundingClientRect()
        : null)
    const relatedRects = highlighted
      .filter(
        (element) =>
          element.isConnected && !selection.some((entry) => entry.element === element)
      )
      .map((element) => element.getBoundingClientRect())

    const next: number[] = [rects.length, relatedRects.length]
    for (const rect of rects) next.push(rect.left, rect.top, rect.width, rect.height)
    for (const rect of relatedRects) next.push(rect.left, rect.top, rect.width, rect.height)
    if (hoverRect) next.push(hoverRect.left, hoverRect.top, hoverRect.width, hoverRect.height)
    if (targetRect) next.push(targetRect.left, targetRect.top, targetRect.width, targetRect.height)
    const moved = next.length !== geometry.length || next.some((value, index) => value !== geometry[index])
    geometry = next

    // Everything below is a pure function of `next` and these two, so a pass
    // that matches the last one would rewrite every node with the values it
    // already holds. The loop runs a few such passes before it
    // rests, after every selection and every drag, and each would re-parse a
    // couple of dozen identical style strings.
    const inputs = `${state.tool} ${dipHeld}`
    if (!moved && inputs === drawnWith) return false
    drawnWith = inputs

    if (hoverRect) {
      setShown(hoverOutline, true)
      // Frozen rather than tracked for the length of a dip, which is the whole
      // mechanism: `hovered` has already moved to the element the modifier
      // picked, and this node is at zero opacity, so holding its last box is
      // how the jump between the two ends up happening off screen.
      if (!dipHeld) {
        placeNode(hoverOutline, hoverRect.left, hoverRect.top, hoverRect.width, hoverRect.height)
      }
    } else {
      hide(hoverOutline)
    }

    for (const rect of relatedRects) {
      placeNode(related.take(), rect.left, rect.top, rect.width, rect.height)
    }
    related.flush()

    if (targetRect) {
      const bounds: Box = boxOf(rects[0])
      for (const rect of rects) {
        bounds.left = Math.min(bounds.left, rect.left)
        bounds.top = Math.min(bounds.top, rect.top)
        bounds.right = Math.max(bounds.right, rect.right)
        bounds.bottom = Math.max(bounds.bottom, rect.bottom)
      }
      paintMeasurement(measureSpacing(bounds, boxOf(targetRect)))
    } else {
      paintMeasurement(null)
    }

    let left = Number.POSITIVE_INFINITY
    let top = Number.POSITIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    const count = rects.length

    for (const rect of rects) {
      if (rect.left < left) left = rect.left
      if (rect.top < top) top = rect.top
      if (rect.right > right) right = rect.right
      if (rect.bottom > bottom) bottom = rect.bottom
      if (count > 1) {
        placeNode(members.take(), rect.left, rect.top, rect.width, rect.height)
      }
    }
    members.flush()

    if (count === 0) {
      hide(boundsOutline)
      for (const handle of handles.values()) hide(handle)
      return moved
    }

    const width = right - left
    const height = bottom - top
    setShown(boundsOutline, true)
    boundsOutline.style.borderStyle = "solid"
    placeNode(boundsOutline, left, top, width, height)

    const showHandles = count === 1 && state.tool === "move"
    /*
     * AN AXIS TOO SHORT TO CARRY THREE TARGETS, AND THEN TOO SHORT TO CARRY TWO.
     *
     * The first rule was already here: a middle handle is dropped when its axis
     * is under 24px, because three 13px hit boxes cannot share less than that
     * without the middle one sitting on top of both its neighbours.
     *
     * The second was not, and it is the case with no way out. Below
     * `HANDLE_HIT` the axis cannot carry TWO either — the corners are centred
     * on the edges, so on a 10px-wide element `nw` and `ne` are 10px apart with
     * 13px boxes and overlap by three. Both are live, both are drawn, and the
     * pixels where they cross belong to whichever the hit test reaches first.
     * "Never overlapping" is the half of the hit-area rule a user cannot aim
     * their way out of: with a target too small you can zoom or try again, and
     * with two targets on one pixel there is nothing to try.
     *
     * The collapsed axis keeps ONE side and drops the other. Keeping the near
     * corners — `fx === 0` when too narrow, `fy === 0` when too short — rather
     * than the far ones is arbitrary between the two and consistent across all
     * four handles, which is what matters: the survivors are `nw`/`sw` on a
     * narrow element and `nw`/`ne` on a short one, so the top-left corner is
     * always present and a sliver of any shape still resizes.
     *
     * Growing `HANDLE_HIT` to the 24px floor is the fix that is NOT taken, and
     * `css/canvas.ts` already argues why: at 24 every element under 48px would
     * be completely covered by its own handles, so the target would clear the
     * floor by making the thing it points at unclickable.
     */
    const narrow = width < HANDLE_HIT
    const short = height < HANDLE_HIT
    for (const [id, fx, fy] of HANDLES) {
      const handle = handles.get(id)
      if (!handle) continue
      const horizontalMiddle = fx === 0.5 && width < 24
      const verticalMiddle = fy === 0.5 && height < 24
      // A corner on the far side of an axis that cannot separate two boxes.
      const crowdedCorner = (narrow && fx === 1) || (short && fy === 1)
      if (!showHandles || horizontalMiddle || verticalMiddle || crowdedCorner) {
        hide(handle)
        continue
      }
      setShown(handle, true)
      placeNode(handle, left + width * fx, top + height * fy)
    }
    return moved
  }

  let frame = 0
  let destroyed = false
  /** Consecutive frames in which no box moved, and the safety poll a rest runs. */
  let stillFrames = 0
  let restTimer = 0
  // A handful of frames, not half a second: `watch` wakes the loop on the frame
  // anything starts to move, and `moving` holds it awake through an animation
  // in its delay, so the still frames only have to cover a change that lands
  // a frame or two after the one that woke the loop. Half a second of them was
  // thirty layout reads and compositor commits after every click and every
  // hover change, for boxes that had stopped.
  const STILL_FRAMES = 6
  const REST_POLL_MS = 250

  /** What the loop follows. With none of it, it stops outright. */
  const tracked = (): Element[] => {
    const state = context.getState()
    const elements: Element[] = state.selection.map((entry) => entry.element)
    if (state.hovered) elements.push(state.hovered)
    return elements.concat(highlighted)
  }

  const schedule = () => {
    if (destroyed || frame !== 0) return
    if (restTimer) {
      clearTimeout(restTimer)
      restTimer = 0
    }
    watch.disarm()
    frame = requestAnimationFrame(draw)
  }
  /** Something may have moved: back to a frame per frame, from the next one. */
  const wake = () => {
    stillFrames = 0
    schedule()
  }
  /** A same-task paint is queued (see `paintSoon`). */
  let paintQueued = false
  /** The same, painting at once first — for a change the next frame would draw a frame late. */
  const wakeNow = () => {
    if (destroyed || !layer.isConnected) return
    // A paint already queued for this task (`paintSoon`) draws later in the
    // same task, after whatever else the task writes; painting here as well
    // only bought a second forced layout between the two.
    if (!paintQueued) paintSelection()
    wake()
  }
  const watch = watchForMotion(wake, wakeNow)
  wakePainter = wake

  /*
   * Per frame while anything moves; at rest once every box has held still for
   * a few frames, until `watch` sees something that can move one.
   *
   * A rest still polls four times a second, with a paint that writes nothing
   * unless a box did move, for whatever moves an element with no mutation, no
   * event and no new animation — a paused animation resumed from a timer, a
   * layout change no listener reaches. It is the backstop, not the mechanism:
   * everything `watch` lists is followed from the frame it starts.
   */
  const rest = () => {
    watch.arm()
    restTimer = setTimeout(() => {
      restTimer = 0
      if (destroyed) return
      if (paintSelection() || moving(tracked())) wake()
      else rest()
    }, REST_POLL_MS) as unknown as number
  }

  const draw = () => {
    frame = 0
    if (!layer.isConnected) {
      destroyed = true
      unsubscribe()
      return
    }
    stillFrames = paintSelection() ? 0 : stillFrames + 1
    // Selected or hovered app content may move under Motion, so track it. Once
    // both are empty, stop entirely until the store wakes the painter again.
    // Standing down stops it too — either reason: a selection survives the mode
    // switch so the user gets it back on the way out, but tracking geometry
    // nobody is drawing would cost a layout read per frame for a blank overlay.
    if (!selectionOwnsInput()) return
    const elements = tracked()
    if (elements.length === 0) return
    if (stillFrames < STILL_FRAMES || moving(elements)) schedule()
    else rest()
  }

  /*
   * A new selection, a tool switch or a stand-down is drawn in the task that
   * made it, not in the next frame: a Tab walking the selection, a click
   * selecting and Cmd+. hiding the chrome were each a frame of outline behind
   * the rest of the editor. A microtask rather than a call, so the paint
   * measures once, after every other subscriber and the rest of the handler
   * have written what they are going to write in this task. Hover stays on the
   * frame: a pointer reports several moves a frame, and the frame is where they
   * collapse into one read.
   */
  const paintSoon = () => {
    if (paintQueued) return
    paintQueued = true
    queueMicrotask(() => {
      paintQueued = false
      wakeNow()
    })
  }

  const unsubscribe = context.subscribe((next, previous) => {
    if (next.selection !== previous.selection) highlighted = []
    // The gate as well as the data: leaving Notes or closing the board changes
    // only the gate, and a painter that missed it stayed dark — outline and
    // handles gone — until the pointer next crossed the app.
    if (
      next.selection !== previous.selection ||
      next.tool !== previous.tool ||
      editorStandDownChanged(next, previous)
    ) {
      paintSoon()
    } else if (next.hovered !== previous.hovered) {
      wake()
    }
  })
  const onHighlight = (event: Event) => {
    const detail = (event as CustomEvent<{ elements?: Element[] }>).detail
    highlighted = Array.isArray(detail?.elements)
      ? detail.elements.filter((element): element is Element => element instanceof Element)
      : []
    wake()
  }
  window.addEventListener("designlayer:highlight-elements", onHighlight)
  schedule()
  window.addEventListener("beforeunload", () => {
    destroyed = true
    unsubscribe()
    watch.disarm()
    window.removeEventListener("designlayer:highlight-elements", onHighlight)
    if (frame) cancelAnimationFrame(frame)
    if (restTimer) clearTimeout(restTimer)
  })
}
