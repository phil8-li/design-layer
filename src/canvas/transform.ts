/**
 * Drag-to-move and handle-resize for the current selection.
 *
 * Both write to inline styles first so the gesture stays at 60fps, then hand
 * the resulting values to the inspector's writer on release. The frames in
 * between are preview and nothing else: they are never recorded, so a drag is
 * one history step, however many elements it carried, and one ledger row per
 * element rather than one per pointermove. Snapping and alignment guides live
 * in `snapping.ts` and hook in through `onDragUpdate`.
 *
 * ## The machine
 *
 * `DragState` is the whole of it, moved only by `transition()`:
 *
 *   idle     --press on a resize handle------------------------> pressed(resize)
 *   idle     --press inside any selected member, no Shift------> pressed(move)
 *   pressed  --travel reaches DRAG_THRESHOLD--------------------> dragging   (transitions held, start hooks)
 *   pressed  --release------------------------------------------> idle       (a click: nothing written)
 *   dragging --move---------------------------------------------> dragging   (inline preview, update hooks)
 *   dragging --release------------------------------------------> idle       (rewind, one batch write, end hooks, refresh)
 *   pressed | dragging --cancel(reason)-------------------------> idle       (preview restored, end hooks)
 *
 * Every way a gesture ends early is one `cancel`, wired by `gesture.ts`:
 * Escape, `pointercancel`, a lost pointer capture, a move with no button down
 * (a release the window never heard), the window losing focus, the editor
 * standing down, and the gesture going invalid — a target that left the page
 * or stopped being selected. A cancelled gesture writes nothing: the agent
 * never receives a note for a drag the designer abandoned, and the page never
 * keeps a move the notes do not have.
 *
 * A move takes the selection as it stands when the drag starts, not when the
 * button went down. The canvas resolves a press into a selection in the same
 * pointerdown, after this lane has seen it (a Cmd press deep-selects a child, a
 * plain press on a deep-selected leaf selects its layer), so what moves is what
 * the outline shows.
 */

import { holdTransitions, isChrome, round, saveInline } from "../core/dom"
import {
  clampInto,
  lengthCompanions,
  lengthLimits,
  lengthWrites,
  mergeWrites,
  ownLength,
  shrinkable,
  type Axis,
} from "../core/sizing"
import { selectionOwnsInput } from "../core/store"
import type { EditorContext } from "../core/context"
import type { LayerElement, Selection } from "../core/types"
import type { StyleBatchEdit, StyleWrite, Writer } from "../core/writer"
import { trackPointer, type PointerTrack } from "./gesture"
import { installModifiers } from "./modifiers"
import type { HandleId } from "./selection"

/** Every inline declaration a gesture's preview can write, `transition` aside. */
const PREVIEWED = ["transform", "width", "height", "flex", "flex-shrink", "display"]

interface DragTarget {
  /** The writer takes a Selection, not an element: it needs the source ref too. */
  selection: Selection
  element: LayerElement
  offsetX: number
  offsetY: number
  /** The rotate, scale and skew the element had at pointerdown; see `linearOf`. */
  linear: Linear
  /**
   * Puts the inline declarations back as the gesture found them. An empty
   * string and `0px` are different states — one leaves the stylesheet in
   * charge — and a normalised reading loses that.
   */
  restore: () => void
  /**
   * Gives the element its own transitions back. A gesture turns them off once
   * it starts moving: a card with `transition-all` or a panel with a width
   * tween trailed the pointer by the length of the tween, and a resize released
   * mid-tween measured the first frame of it.
   */
  releaseTransitions: () => void
}

/** The two drags, each with only the data it carries once it has started. */
interface MoveGesture {
  mode: "move"
  /** `targets[0]` is the primary element the geometry is measured from. */
  targets: DragTarget[]
  startRect: DOMRect
}

interface ResizeGesture {
  mode: "resize"
  handle: HandleId
  /** A resize only ever sizes the primary. */
  targets: [DragTarget]
  startRect: DOMRect
  /**
   * The primary's `width`/`height` as its own box-sizing counts them. A
   * resize adds the handle's travel to these rather than writing the border
   * box: on a `content-box` element with padding, writing the rect made the
   * first 1px move grow it by the padding and border as well.
   */
  startSize: { width: number; height: number }
  /** The `min-*`/`max-*` a resized axis is held inside, read when the drag starts. */
  limits: Partial<Record<Axis, { min: number; max: number }>>
  /** The lengths the last frame drew, which are what the release writes. */
  lengths: Partial<Record<Axis, number>>
}

/** A press under the threshold: what it will drag if it travels far enough. */
type Press =
  | { mode: "move"; at: Element }
  | { mode: "resize"; handle: HandleId; element: LayerElement }

type DragState =
  | { kind: "idle" }
  | { kind: "pressed"; press: Press; track: PointerTrack }
  | { kind: "dragging"; gesture: MoveGesture | ResizeGesture; track: PointerTrack }

/** The axes a handle drags: a side handle one, a corner both. */
function axesOf(handle: HandleId): Axis[] {
  const axes: Axis[] = []
  if (/[ew]/.test(handle)) axes.push("width")
  if (/[ns]/.test(handle)) axes.push("height")
  return axes
}

interface DragGeometry {
  left: number
  top: number
  width: number
  height: number
}

interface DragInfo {
  element: LayerElement
  mode: "move" | "resize"
  rect: DOMRect
}

type DragHook = (gesture: {
  element: LayerElement
  rect: DOMRect
  proposed: DragGeometry
}) => DragGeometry

const hooks: DragHook[] = []
const startHooks: Array<(info: DragInfo) => void> = []
const endHooks: Array<() => void> = []

function register<T>(list: T[], entry: T): () => void {
  list.push(entry)
  return () => {
    const index = list.indexOf(entry)
    if (index !== -1) list.splice(index, 1)
  }
}

/** Snapping registers here so it can adjust the proposed geometry each frame. */
export function onDragUpdate(hook: DragHook): () => void {
  return register(hooks, hook)
}

/** Fires once the drag threshold is crossed, so hooks measure a settled layout. */
export function onDragStart(hook: (info: DragInfo) => void): () => void {
  return register(startHooks, hook)
}

export function onDragEnd(hook: () => void): () => void {
  return register(endHooks, hook)
}

function readMatrix(element: LayerElement): DOMMatrixReadOnly {
  const style = getComputedStyle(element)
  return new DOMMatrixReadOnly(style.transform === "none" ? "" : style.transform)
}

function readOffset(element: LayerElement): { x: number; y: number } {
  const matrix = readMatrix(element)
  return { x: matrix.m41, y: matrix.m42 }
}

/**
 * A transform's rotate, scale and skew with the translation left open, or
 * null when it has none.
 *
 * Moving an element only changes the translation, which is `m41`/`m42` of its
 * matrix whatever else was multiplied in. Writing a bare `translate(...)` back
 * erased a `rotate(10deg)` on the first arrow press and committed the loss to
 * source. An element with nothing else in its transform still gets the plain
 * `translate(...)` every writer knows how to spell.
 */
type Linear = ((x: number, y: number) => string) | null

function linearOf(matrix: DOMMatrixReadOnly): Linear {
  const at = (value: number | undefined, fallback: number) => (typeof value === "number" ? value : fallback)
  const exact = (value: number) => round(value, 6)
  if (matrix.is2D !== false) {
    const a = at(matrix.a, 1)
    const b = at(matrix.b, 0)
    const c = at(matrix.c, 0)
    const d = at(matrix.d, 1)
    if (a === 1 && b === 0 && c === 0 && d === 1) return null
    return (x, y) => `matrix(${exact(a)}, ${exact(b)}, ${exact(c)}, ${exact(d)}, ${round(x)}, ${round(y)})`
  }
  const m = matrix
  const values = [m.m11, m.m12, m.m13, m.m14, m.m21, m.m22, m.m23, m.m24, m.m31, m.m32, m.m33, m.m34, m.m41, m.m42, m.m43, m.m44]
  return (x, y) => {
    const next = values.slice()
    next[12] = x
    next[13] = y
    return `matrix3d(${next.map(exact).join(", ")})`
  }
}

/** A transform at offset (x, y), keeping `linear`. */
function placed(linear: Linear, x: number, y: number): string {
  return linear ? linear(x, y) : `translate(${round(x)}px, ${round(y)}px)`
}

/**
 * The element's translate offset shifted by a delta. One definition, so drag
 * and keyboard nudge can never disagree about what "move by 1px" means.
 */
export function translateBy(element: LayerElement, dx: number, dy: number): string {
  const matrix = readMatrix(element)
  return placed(linearOf(matrix), matrix.m41 + dx, matrix.m42 + dy)
}

/**
 * The transform a finished gesture MEANS, rather than the string left sitting
 * inline when it ends.
 *
 * Two writers used to touch this one property during a drag. Ours writes a pure
 * `translate(...)`; the vendored overlay painted its own preview over the top —
 * `translate(x, y) scale(1.02)`, plus whatever the computed transform was when
 * the press began, which for an untransformed element is the identity matrix.
 * Read raw at commit, the settled value was whichever of the two wrote last,
 * decorated with a lift nobody asked for. `runtime/vendor-patch.mjs` now
 * switches the vendor's drag off, and the value is still recomposed here, so a
 * stray inline transform can never be what a gesture commits.
 *
 * On Angular the writer puts the value in the template, and `transform:
 * translate(40px, 24px) scale(1.02) matrix(1, 0, 0, 1, 0, 0)` was a permanent
 * record of a transient animation — measured, in a real app's own overview
 * template.
 *
 * So the offset is recomposed from the matrix, which carries the translation in
 * `m41`/`m42` whatever else was multiplied into it, and the rest is the
 * rotate/scale/skew captured at pointerdown — before the lift existed. An
 * element left at no offset and no other transform gets the empty string,
 * which REMOVES the declaration instead of pinning an identity onto it.
 */
function settledTransform(x: number, y: number, linear: Linear): string {
  if (!linear && x === 0 && y === 0) return ""
  return placed(linear, x, y)
}

export function installTransform(context: EditorContext, writer: Writer): void {
  installModifiers()
  let state: DragState = { kind: "idle" }

  /** The one place the machine moves; see the table in the header. */
  const transition = (next: DragState) => {
    state = next
  }

  const targetsFor = (selections: readonly Selection[]): DragTarget[] =>
    selections.map((selection) => {
      const element = selection.element
      const matrix = readMatrix(element)
      return {
        selection,
        element,
        offsetX: matrix.m41,
        offsetY: matrix.m42,
        linear: linearOf(matrix),
        restore: saveInline(element, PREVIEWED),
        releaseTransitions: holdTransitions(element),
      }
    })

  const selected = (element: Element) => context.getState().selection.some((entry) => entry.element === element)

  /**
   * Whether the gesture can still go on. A press is good while it still lands
   * in the selection; a drag while every element it carries is on the page and
   * still selected. Asked by `gesture.ts` on every event and store change.
   */
  const valid = (): boolean => {
    if (state.kind === "pressed") {
      const { press } = state
      if (press.mode === "resize") return press.element.isConnected && context.getState().selection[0]?.element === press.element
      return press.at.isConnected && context.getState().selection.some((entry) => entry.element.contains(press.at))
    }
    if (state.kind === "dragging") {
      return state.gesture.targets.every((target) => target.element.isConnected && selected(target.element))
    }
    return true
  }

  /**
   * What a resize previews beside the length, set once as the drag starts: the
   * companions `core/sizing.ts` says the length needs (`flex: none` on a
   * growing item, `inline-block` on an inline box), and `flex-shrink: 0` on an
   * item a full line could squeeze, so the preview is never smaller than the
   * pointer. Whether the release still needs that last one is measured then.
   */
  const startResize = (active: ResizeGesture): void => {
    const element = active.targets[0].element
    const axes = axesOf(active.handle)
    const companions = mergeWrites(...axes.map((axis) => lengthCompanions(element, axis)))
    const squeezable = axes.some((axis) => shrinkable(element, axis, companions))
    for (const axis of axes) active.limits[axis] = lengthLimits(element, axis)
    // Pinned at the size it already has first, so taking the item off its
    // `flex-1` moves nothing before the pointer does — the start hooks measure
    // the siblings next, and snapping would aim at a layout that never painted.
    for (const axis of axes) element.style.setProperty(axis, `${Math.round(active.startSize[axis])}px`)
    for (const write of companions) element.style.setProperty(write.property, write.value)
    if (squeezable) element.style.setProperty("flex-shrink", "0")
  }

  /** `pressed --travel reaches DRAG_THRESHOLD--> dragging`, with what the drag carries. */
  const begin = (press: Press): MoveGesture | ResizeGesture => {
    const selection = context.getState().selection
    if (press.mode === "resize") {
      const primary = selection[0]
      const startRect = primary.element.getBoundingClientRect()
      const gesture: ResizeGesture = {
        mode: "resize",
        handle: press.handle,
        targets: [targetsFor([primary])[0]],
        startRect,
        startSize: {
          width: ownLength(primary.element, "width", startRect.width),
          height: ownLength(primary.element, "height", startRect.height),
        },
        limits: {},
        lengths: {},
      }
      startResize(gesture)
      return gesture
    }
    // Dragging one member of a multi-selection carries the whole set, and the
    // primary stays the element the geometry and the guides are measured from.
    return { mode: "move", targets: targetsFor(selection), startRect: selection[0].element.getBoundingClientRect() }
  }

  const onPointerDown = (event: PointerEvent) => {
    if (!selectionOwnsInput()) return
    const current = context.getState()
    if (current.tool !== "move") return
    if (event.button !== 0) return
    // A press while another is held (a second button, a lost release) is not
    // a new gesture; the old one ends first, and writes nothing.
    if (state.kind !== "idle") cancel()

    const target = event.target as HTMLElement | null
    const handleId = target?.dataset?.handle as HandleId | undefined
    const primary = current.selection[0] ?? null
    const capture = event.target instanceof Element ? event.target : null

    if (handleId && primary) {
      const press: Press = { mode: "resize", handle: handleId, element: primary.element }
      transition({ kind: "pressed", press, track: trackPointer(event, capture, handlers) })
      event.preventDefault()
      event.stopPropagation()
      return
    }

    // Shift+drag is the full-bleed marquee escape hatch. Reserve it before a
    // selected descendant can turn the same press into a move gesture.
    if (event.shiftKey) return
    if (!target || isChrome(target)) return
    /*
     * The selected layer, not the node under the pointer, is what the press
     * holds and captures on. The target is often a child (a label <span>, an
     * <svg>) that an app replaces on press (an :active icon, a pointerdown
     * re-render); holding it lost the capture and failed `valid()` for a
     * layer that never left the page.
     */
    const layer = current.selection.find((entry) => entry.element.contains(target))?.element
    if (!layer) return
    transition({ kind: "pressed", press: { mode: "move", at: layer }, track: trackPointer(event, layer, handlers) })
  }

  const onMove = (event: PointerEvent) => {
    if (state.kind === "idle") return
    const { track } = state
    if (state.kind === "pressed") {
      if (!track.crossed(event)) return
      /*
       * THE THRESHOLD'S OWN TRAVEL IS APPLIED, AND THAT IS THE RIGHT TRADE.
       *
       * A drag does nothing until the pointer has moved `DRAG_THRESHOLD`, then
       * applies the whole distance — so a slow drag begins with the element
       * jumping three pixels to catch a pointer that has already moved on. It
       * looks like the element was stuck and then slipped, and it is the obvious
       * thing to want to fix.
       *
       * Both fixes were built and both were reverted, and the second one is the
       * interesting failure.
       *
       * Re-basing the origin to `event.clientX` is simply wrong: a pointer that
       * crosses the threshold in one large event — a flick, a trackpad, a coarse
       * pointer — has its entire first move discarded rather than three pixels
       * of it. `test/drag-write-cases.mjs` failed seven ways.
       *
       * Shifting the origin along the travel vector by `DRAG_THRESHOLD` is the
       * textbook form, and it is correct about the jump: it spends the threshold
       * once instead of twice, and a flick keeps all but three pixels. It also
       * means the element trails the pointer by those three pixels FOR THE REST
       * OF THE DRAG — the point you grabbed is no longer the point under the
       * cursor. DW-01 caught it as 67px where the gesture travelled 70.
       *
       * In a tool whose output is coordinates in somebody's source, grab-point
       * fidelity outranks the smoothness of the first frame. A three-pixel jump
       * at the start is visible once; a three-pixel offset between the cursor
       * and the thing it is holding is wrong for the whole gesture, and it is
       * wrong in the direction the designer is trying to be precise about.
       *
       * So the jump stays, and it is the cost of having a threshold at all. The
       * only fix that does not trade it for something worse is a smaller
       * threshold, which is a question about tremor tolerance rather than about
       * motion.
       */
      const gesture = begin(state.press)
      transition({ kind: "dragging", gesture, track })
      const info: DragInfo = { element: gesture.targets[0].element, mode: gesture.mode, rect: gesture.startRect }
      for (const hook of startHooks) hook(info)
    }
    if (state.kind !== "dragging") return
    event.preventDefault()
    preview(state.gesture, event.clientX - track.startX, event.clientY - track.startY)
  }

  const preview = (gesture: MoveGesture | ResizeGesture, dx: number, dy: number) => {
    const { startRect } = gesture
    let proposed: DragGeometry = {
      left: startRect.left,
      top: startRect.top,
      width: startRect.width,
      height: startRect.height,
    }

    if (gesture.mode === "move") {
      proposed.left += dx
      proposed.top += dy
    } else {
      const { handle } = gesture
      if (handle.includes("e")) proposed.width = Math.max(1, startRect.width + dx)
      if (handle.includes("s")) proposed.height = Math.max(1, startRect.height + dy)
      if (handle.includes("w")) {
        proposed.width = Math.max(1, startRect.width - dx)
        proposed.left = startRect.left + dx
      }
      if (handle.includes("n")) {
        proposed.height = Math.max(1, startRect.height - dy)
        proposed.top = startRect.top + dy
      }
    }

    for (const hook of hooks) {
      proposed = hook({ element: gesture.targets[0].element, rect: startRect, proposed })
    }

    if (gesture.mode === "move") {
      const shiftX = proposed.left - startRect.left
      const shiftY = proposed.top - startRect.top
      for (const target of gesture.targets) {
        target.element.style.transform = placed(target.linear, target.offsetX + shiftX, target.offsetY + shiftY)
      }
      return
    }

    // Only the axes the handle drags. A side handle that wrote both pinned the
    // other axis's content-driven size into source on release.
    const primary = gesture.targets[0]
    const { handle, startSize, limits, lengths } = gesture
    const fit = (axis: Axis, raw: number) =>
      Math.max(1, Math.round(clampInto(limits[axis] ?? { min: 0, max: Number.POSITIVE_INFINITY }, raw)))
    let shiftX = 0
    let shiftY = 0
    if (/[ew]/.test(handle)) {
      lengths.width = fit("width", startSize.width + proposed.width - startRect.width)
      primary.element.style.width = `${lengths.width}px`
      // A west handle holds the east edge still, so the origin moves by what
      // the width actually grew; at a `max-width` both stop together.
      if (handle.includes("w")) shiftX = startSize.width - lengths.width
    }
    if (/[ns]/.test(handle)) {
      lengths.height = fit("height", startSize.height + proposed.height - startRect.height)
      primary.element.style.height = `${lengths.height}px`
      if (handle.includes("n")) shiftY = startSize.height - lengths.height
    }
    if (/[wn]/.test(handle)) {
      primary.element.style.transform = placed(primary.linear, primary.offsetX + shiftX, primary.offsetY + shiftY)
    }
  }

  /**
   * The gesture's own preview, rewound and then replayed through the writer.
   *
   * The writer reads the "before" value off the element to decide whether
   * anything changed and what the note's "from" should be, so with the
   * dragged value still sitting inline the write reads as a no-op: no history
   * step, and no note at all. Restoring
   * first is what makes a drag an edit like any other. Both halves run in the
   * same task, so nothing paints in between and the rewind is invisible.
   *
   * Every element rewinds before any is written, and the whole set goes to
   * `applyStylesBatch`: one drag of five cards is one undo step, as a
   * multi-delete is, and still one ledger row per card for the agent.
   */
  const commit = (finished: MoveGesture | ResizeGesture) => {
    const summary = finished.mode === "resize" ? "Resize" : "Move"
    const edits: StyleBatchEdit[] = []
    for (const target of finished.targets) {
      const element = target.element
      // A resize only moves the origin when a west or north handle dragged it,
      // and a move that snapped back where it started moved nothing. The
      // element is the honest record of which of those happened, compared as
      // an offset so a transform spelled differently inline is not a change.
      const { x, y } = readOffset(element)
      const shifted = round(x) !== round(target.offsetX) || round(y) !== round(target.offsetY)
      target.restore()

      const writes: StyleWrite[] = []
      if (finished.mode === "resize") {
        // Measured against the element as it was, so `lengthWrites` can tell
        // whether the line would squeeze the new length without `shrink-0`.
        // An axis dragged back to where it began wrote nothing.
        const axes = (Object.keys(finished.lengths) as Axis[]).filter(
          (axis) => finished.lengths[axis] !== Math.round(finished.startSize[axis])
        )
        writes.push(...mergeWrites(...axes.map((axis) => lengthWrites(element, axis, finished.lengths[axis] ?? 0))))
      }
      if (shifted) writes.push({ property: "transform", value: settledTransform(x, y, target.linear) })
      // Every property the gesture settled in one edit, so a resize that also
      // shifted the origin is one step on the timeline rather than three.
      if (writes.length) edits.push({ selection: target.selection, writes })
    }
    writer.applyStylesBatch(edits, summary)
    for (const target of finished.targets) target.releaseTransitions()
  }

  /** `* --cancel--> idle`: the one way a gesture ends without writing. */
  const cancel = () => {
    const ending = state
    if (ending.kind === "idle") return
    transition({ kind: "idle" })
    ending.track.end()
    if (ending.kind !== "dragging") return
    for (const target of ending.gesture.targets) {
      target.restore()
      target.releaseTransitions()
    }
    for (const hook of endHooks) hook()
  }

  const release = () => {
    const ending = state
    if (ending.kind === "idle") return
    transition({ kind: "idle" })
    if (ending.kind !== "dragging") return
    // Before the hooks and the refresh: both read state the write produces —
    // the guides come down around a settled element, and the panels repaint
    // from the history and ledger entries this leaves behind.
    commit(ending.gesture)
    for (const hook of endHooks) hook()
    context.refresh()
  }

  const handlers = { move: onMove, release, cancel, valid }

  window.addEventListener("pointerdown", onPointerDown, true)
}
