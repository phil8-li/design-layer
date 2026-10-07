/**
 * Drag-to-move and handle-resize for the current selection.
 *
 * Both write to inline styles first so the gesture stays at 60fps, then hand
 * the resulting values to the inspector's writer on release. The frames in
 * between are preview and nothing else: they are never recorded, so a drag is
 * one history step and one ledger row rather than one per pointermove.
 * Snapping and alignment guides live in `snapping.ts` and hook in through
 * `onDragUpdate`.
 */

import { isChrome, round } from "../core/dom"
import { selectionOwnsInput } from "../core/store"
import type { EditorContext } from "../core/context"
import type { LayerElement, Selection } from "../core/types"
import type { StyleWrite, Writer } from "../core/writer"
import type { HandleId } from "./selection"

interface DragTarget {
  /** The writer takes a Selection, not an element: it needs the source ref too. */
  selection: Selection
  element: LayerElement
  offsetX: number
  offsetY: number
  /** The rotate, scale and skew the element had at pointerdown; see `linearOf`. */
  linear: Linear
  /**
   * The inline declarations as the gesture found them, so the release can put
   * them back exactly. An empty string and `0px` are different states — one
   * leaves the stylesheet in charge — and a normalised reading loses that.
   */
  inline: { transform: string; width: string; height: string }
}

interface Gesture {
  /** `targets[0]` is the primary element the geometry is measured from. */
  targets: DragTarget[]
  mode: "move" | "resize"
  handle: HandleId | null
  startX: number
  startY: number
  startRect: DOMRect
  /**
   * The primary's `width`/`height` as its own box-sizing counts them. A
   * resize adds the handle's travel to these rather than writing the border
   * box: on a `content-box` element with padding, writing the rect made the
   * first 1px move grow it by the padding and border as well.
   */
  startSize: { width: number; height: number }
  moved: boolean
}

export interface DragGeometry {
  left: number
  top: number
  width: number
  height: number
}

export interface DragInfo {
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

let altDown = false

/**
 * Alt is the one gesture modifier the canvas shares: it suppresses snapping
 * while dragging and reveals measurements while hovering. Pointer events keep
 * it honest when the document never received the keydown.
 */
export function isAltDown(): boolean {
  return altDown
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

const DRAG_THRESHOLD = 3

/**
 * Restores one inline declaration, where "no declaration" is a value too.
 * Blanking a property the element never set inline is not the same as removing
 * it: the blank keeps the declaration and shuts the stylesheet out.
 */
function setInline(element: LayerElement, property: string, value: string): void {
  if (value) element.style.setProperty(property, value)
  else element.style.removeProperty(property)
}

export function installTransform(context: EditorContext, writer: Writer): void {
  let gesture: Gesture | null = null
  let capture: Element | null = null
  let pointerId = -1

  const targetsFor = (selections: Selection[]): DragTarget[] =>
    selections.map((selection) => {
      const element = selection.element
      const matrix = readMatrix(element)
      return {
        selection,
        element,
        offsetX: matrix.m41,
        offsetY: matrix.m42,
        linear: linearOf(matrix),
        inline: {
          transform: element.style.transform,
          width: element.style.width,
          height: element.style.height,
        },
      }
    })

  const onPointerDown = (event: PointerEvent) => {
    if (!selectionOwnsInput()) return
    const state = context.getState()
    if (state.tool !== "move") return
    if (event.button !== 0) return

    const target = event.target as HTMLElement | null
    const handleId = target?.dataset?.handle as HandleId | undefined
    const primary = state.selection[0] ?? null
    const selected = primary?.element ?? null

    const capturePointer = () => {
      capture = event.target instanceof Element ? event.target : null
      pointerId = event.pointerId
      if (!capture || !("setPointerCapture" in capture)) return
      try {
        ;(capture as Element & { setPointerCapture(id: number): void }).setPointerCapture(pointerId)
      } catch {
        capture = null
      }
    }

    if (handleId && primary) {
      const startRect = primary.element.getBoundingClientRect()
      const computed = getComputedStyle(primary.element)
      const own = (value: string, fallback: number) => {
        const parsed = Number.parseFloat(value)
        return Number.isFinite(parsed) ? parsed : fallback
      }
      gesture = {
        targets: targetsFor([primary]),
        mode: "resize",
        handle: handleId,
        startX: event.clientX,
        startY: event.clientY,
        startRect,
        startSize: { width: own(computed.width, startRect.width), height: own(computed.height, startRect.height) },
        moved: false,
      }
      capturePointer()
      event.preventDefault()
      event.stopPropagation()
      return
    }

    // Shift+drag is the full-bleed marquee escape hatch. Reserve it before a
    // selected descendant can turn the same press into a move gesture.
    if (event.shiftKey) return
    if (isChrome(target) || !selected) return
    if (!selected.contains(target)) return

    // Dragging one member of a multi-selection carries the whole set.
    const startRect = selected.getBoundingClientRect()
    gesture = {
      targets: targetsFor(state.selection),
      mode: "move",
      handle: null,
      startX: event.clientX,
      startY: event.clientY,
      startRect,
      startSize: { width: startRect.width, height: startRect.height },
      moved: false,
    }
    capturePointer()
  }

  const onPointerMove = (event: PointerEvent) => {
    altDown = event.altKey
    if (!gesture) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    if (!gesture.moved) {
      gesture.moved = true
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
      const info: DragInfo = {
        element: gesture.targets[0].element,
        mode: gesture.mode,
        rect: gesture.startRect,
      }
      for (const hook of startHooks) hook(info)
    }
    event.preventDefault()

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
      const handle = gesture.handle ?? "se"
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

    const shiftX = proposed.left - startRect.left
    const shiftY = proposed.top - startRect.top

    if (gesture.mode === "move") {
      for (const target of gesture.targets) {
        target.element.style.transform = placed(target.linear, target.offsetX + shiftX, target.offsetY + shiftY)
      }
      return
    }

    // Only the axes the handle drags. A side handle that wrote both pinned the
    // other axis's content-driven size into source on release.
    const primary = gesture.targets[0]
    const handle = gesture.handle ?? "se"
    const { startSize } = gesture
    if (/[ew]/.test(handle)) {
      primary.element.style.width = `${Math.max(1, Math.round(startSize.width + proposed.width - startRect.width))}px`
    }
    if (/[ns]/.test(handle)) {
      primary.element.style.height = `${Math.max(1, Math.round(startSize.height + proposed.height - startRect.height))}px`
    }
    if (shiftX !== 0 || shiftY !== 0) {
      primary.element.style.transform = placed(primary.linear, primary.offsetX + shiftX, primary.offsetY + shiftY)
    }
  }

  /**
   * The gesture's own preview, rewound and then replayed through the writer.
   *
   * `writer.applyStyles` reads the "before" value off the element to decide
   * whether anything changed and what the ledger's "from" should be, so with
   * the dragged value still sitting inline the write reads as a no-op: no
   * history step, and a change prompt that reports `from` equal to `to`.
   * Restoring first is what makes a drag an edit like any other. Both halves
   * run in the same task, so nothing paints in between and the rewind is
   * invisible.
   */
  const commit = (finished: Gesture) => {
    const summary = finished.mode === "resize" ? "Resize" : "Move"
    const handle = finished.handle ?? "se"
    for (const target of finished.targets) {
      const style = target.element.style
      const writes: StyleWrite[] = []
      if (finished.mode === "resize") {
        if (/[ew]/.test(handle)) writes.push({ property: "width", value: style.width })
        if (/[ns]/.test(handle)) writes.push({ property: "height", value: style.height })
      }
      // A resize only moves the origin when a west or north handle dragged it,
      // and a move that snapped back where it started moved nothing. The
      // element is the honest record of which of those happened, compared as
      // an offset so a transform spelled differently inline is not a change.
      const { x, y } = readOffset(target.element)
      if (round(x) !== round(target.offsetX) || round(y) !== round(target.offsetY)) {
        writes.push({ property: "transform", value: settledTransform(x, y, target.linear) })
      }
      if (writes.length === 0) continue

      setInline(target.element, "transform", target.inline.transform)
      if (finished.mode === "resize") {
        setInline(target.element, "width", target.inline.width)
        setInline(target.element, "height", target.inline.height)
      }
      // One call carrying every property the gesture settled, so a resize that
      // also shifted the origin is one step on the timeline rather than three.
      writer.applyStyles(target.selection, writes, summary)
    }
  }

  const release = () => {
    if (capture && pointerId >= 0 && "releasePointerCapture" in capture) {
      try {
        ;(capture as Element & { releasePointerCapture(id: number): void }).releasePointerCapture(pointerId)
      } catch {
        // A removed target has already released capture.
      }
    }
    capture = null
    pointerId = -1
  }

  /*
   * The browser took the pointer back — a pen or touch drag turned into a
   * scroll, an OS gesture, lost capture. Nobody released anything, so the half
   * finished preview is put back rather than written to source.
   */
  const onPointerCancel = () => {
    release()
    if (!gesture) return
    const cancelled = gesture
    gesture = null
    if (!cancelled.moved) return
    for (const target of cancelled.targets) {
      setInline(target.element, "transform", target.inline.transform)
      setInline(target.element, "width", target.inline.width)
      setInline(target.element, "height", target.inline.height)
    }
    for (const hook of endHooks) hook()
  }

  const onPointerUp = () => {
    release()
    if (!gesture) return
    const finished = gesture
    gesture = null
    if (!finished.moved) return
    // Before the hooks and the refresh: both read state the write produces —
    // the guides come down around a settled element, and the panels repaint
    // from the history and ledger entries this leaves behind.
    commit(finished)
    for (const hook of endHooks) hook()
    context.refresh()
  }

  const onAltKey = (event: KeyboardEvent) => {
    altDown = event.altKey
  }

  window.addEventListener("pointerdown", onPointerDown, true)
  window.addEventListener("pointermove", onPointerMove, true)
  window.addEventListener("pointerup", onPointerUp, true)
  window.addEventListener("pointercancel", onPointerCancel, true)
  window.addEventListener("keydown", onAltKey, true)
  window.addEventListener("keyup", onAltKey, true)
  window.addEventListener("blur", () => {
    altDown = false
  })
}
