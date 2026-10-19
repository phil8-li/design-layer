/**
 * Figma's on-canvas auto layout handles for a selected flex container.
 *
 * Hovering the container's padding or the space between two children shows
 * that band with a handle and its value; dragging the handle edits the padding
 * or the gap live, and the release writes it to source as one edit.
 *
 * The bands are drawn with `pointer-events: none` and found by hit-testing the
 * pointer position, so click, double-click, drag-to-move, marquee and the
 * context menu still reach the canvas everywhere. Only the handle bar takes
 * the pointer, and it sits under the resize handles in the overlay.
 *
 * Geometry is pure (`spacingZones`, `zoneAt`, `dragValues`) so the rules can be
 * pinned without a browser; the installer owns the DOM reads and drawing.
 */

import { el, isChrome } from "../core/dom"
import { isLocked, selectionOwnsInput, editorStandDownChanged } from "../core/store"
import type { EditorContext } from "../core/context"
import type { Selection } from "../core/types"
import type { StyleWrite, Writer } from "../core/writer"
import { formatDistance, type Box } from "./measure"
import { createNodePool, placeBadge, placeNode } from "./selection"
import { onDragEnd, onDragStart } from "./transform"

export type Side = "top" | "right" | "bottom" | "left"
export type Sides = Record<Side, number>
type Axis = "x" | "y"

export interface SpacingInput {
  /** The container's border box. */
  box: Box
  border: Sides
  padding: Sides
  /** The main axis: "x" for a row, "y" for a column. */
  axis: Axis
  wrap: boolean
  /** The gap along the main axis, as computed. */
  gap: number
  /** In-flow children's border boxes, in document order. */
  children: Box[]
}

export interface SpacingZone {
  kind: "padding" | "gap"
  /** The padding side; unset for a gap. */
  side?: Side
  /** The area drawn as the tinted band. */
  band: Box
  /** The area that answers hover; never thinner than `MIN_HIT`. */
  hit: Box
  /** Center of the handle bar, and the axis a drag reads. */
  handle: { x: number; y: number; axis: Axis }
  value: number
}

/** A band thinner than this still answers hover over this much, so 0 can grow. */
const MIN_HIT = 8
/**
 * How far a padding handle stays inside the outer edge. The edge's midpoint
 * resize handle reaches 6.5px in (`HANDLE_HIT` 13 in `selection.ts`), and the
 * handle bar's hit box is 8px thick, so 11 keeps the two from touching.
 */
const EDGE_CLEAR = 11
/** The handle bar: drawn 2 x 12, grabbed over 8 x 20. */
const BAR_LENGTH = 12
const BAR_THICKNESS = 2
const BAR_HIT_LENGTH = 20
const BAR_HIT_THICKNESS = 8

const SIDES: Side[] = ["top", "right", "bottom", "left"]

/** Grows a band to at least `MIN_HIT` on one axis, from its outer edge or its middle. */
function grow(band: Box, axis: Axis, anchor: "start" | "end" | "center"): Box {
  const [start, end] = axis === "x" ? [band.left, band.right] : [band.top, band.bottom]
  const size = end - start
  if (size >= MIN_HIT) return band
  let from = start
  if (anchor === "end") from = end - MIN_HIT
  else if (anchor === "center") from = (start + end) / 2 - MIN_HIT / 2
  return axis === "x"
    ? { ...band, left: from, right: from + MIN_HIT }
    : { ...band, top: from, bottom: from + MIN_HIT }
}

export function spacingZones(input: SpacingInput): SpacingZone[] {
  const { box, border, padding } = input
  // The padding box: the border box less the border.
  const inner: Box = {
    left: box.left + border.left,
    top: box.top + border.top,
    right: box.right - border.right,
    bottom: box.bottom - border.bottom,
  }
  if (inner.right <= inner.left || inner.bottom <= inner.top) return []
  const content: Box = {
    left: inner.left + padding.left,
    top: inner.top + padding.top,
    right: inner.right - padding.right,
    bottom: inner.bottom - padding.bottom,
  }
  const midX = (inner.left + inner.right) / 2
  const midY = (inner.top + inner.bottom) / 2
  const zones: SpacingZone[] = []

  const clampX = (x: number) =>
    Math.min(Math.max(x, box.left + EDGE_CLEAR), box.right - EDGE_CLEAR)
  const clampY = (y: number) =>
    Math.min(Math.max(y, box.top + EDGE_CLEAR), box.bottom - EDGE_CLEAR)

  // Left and right bands run the full inner height, top and bottom the full
  // inner width, as Figma draws them; the corners are settled in `zoneAt`.
  const left: Box = { ...inner, right: content.left }
  const right: Box = { ...inner, left: content.right }
  const top: Box = { ...inner, bottom: content.top }
  const bottom: Box = { ...inner, top: content.bottom }
  zones.push(
    { kind: "padding", side: "left", band: left, hit: grow(left, "x", "start"), handle: { x: clampX(content.left), y: midY, axis: "x" }, value: padding.left },
    { kind: "padding", side: "right", band: right, hit: grow(right, "x", "end"), handle: { x: clampX(content.right), y: midY, axis: "x" }, value: padding.right },
    { kind: "padding", side: "top", band: top, hit: grow(top, "y", "start"), handle: { x: midX, y: clampY(content.top), axis: "y" }, value: padding.top },
    { kind: "padding", side: "bottom", band: bottom, hit: grow(bottom, "y", "end"), handle: { x: midX, y: clampY(content.bottom), axis: "y" }, value: padding.bottom }
  )

  const axis = input.axis
  const startOf = (b: Box) => (axis === "x" ? b.left : b.top)
  const endOf = (b: Box) => (axis === "x" ? b.right : b.bottom)
  const crossStartOf = (b: Box) => (axis === "x" ? b.top : b.left)
  const crossEndOf = (b: Box) => (axis === "x" ? b.bottom : b.right)
  // Neighbours in document order are neighbours on screen, reversed or
  // wrapped; sorting by position would pair the end of one wrapped line with
  // the next line's start.
  const children = input.children
  for (let index = 0; index + 1 < children.length; index += 1) {
    const [a, b] =
      startOf(children[index]) <= startOf(children[index + 1])
        ? [children[index], children[index + 1]]
        : [children[index + 1], children[index]]
    // A pair that does not face each other on the main axis is split across
    // two wrapped lines, or overlapping: there is no gap between them to draw.
    if (startOf(b) < endOf(a)) continue
    if (input.wrap && (crossStartOf(b) >= crossEndOf(a) || crossStartOf(a) >= crossEndOf(b))) continue
    // One line spans the content box across; a wrapped line spans its pair.
    const crossStart = input.wrap ? Math.min(crossStartOf(a), crossStartOf(b)) : crossStartOf(content)
    const crossEnd = input.wrap ? Math.max(crossEndOf(a), crossEndOf(b)) : crossEndOf(content)
    if (crossEnd <= crossStart) continue
    const band: Box =
      axis === "x"
        ? { left: endOf(a), right: startOf(b), top: crossStart, bottom: crossEnd }
        : { top: endOf(a), bottom: startOf(b), left: crossStart, right: crossEnd }
    const middle = (endOf(a) + startOf(b)) / 2
    const crossMiddle = (crossStart + crossEnd) / 2
    zones.push({
      kind: "gap",
      band,
      hit: grow(band, axis, "center"),
      handle: axis === "x" ? { x: middle, y: crossMiddle, axis } : { x: crossMiddle, y: middle, axis },
      value: input.gap,
    })
  }
  return zones
}

const inside = (b: Box, x: number, y: number) => x >= b.left && x < b.right && y >= b.top && y < b.bottom

/**
 * The zone under a point. Gaps win over padding, and where two padding bands
 * meet in a corner the one the point is deeper into, relative to its
 * thickness, loses: the pointer is nearer the other side's edge.
 */
export function zoneAt(zones: SpacingZone[], x: number, y: number): SpacingZone | null {
  const gap = zones.find((zone) => zone.kind === "gap" && inside(zone.hit, x, y))
  if (gap) return gap
  let best: SpacingZone | null = null
  let bestDepth = Number.POSITIVE_INFINITY
  for (const zone of zones) {
    if (zone.kind !== "padding" || !inside(zone.hit, x, y)) continue
    const { hit } = zone
    const depth =
      zone.side === "left" ? (x - hit.left) / (hit.right - hit.left)
      : zone.side === "right" ? (hit.right - x) / (hit.right - hit.left)
      : zone.side === "top" ? (y - hit.top) / (hit.bottom - hit.top)
      : (hit.bottom - y) / (hit.bottom - hit.top)
    if (depth < bestDepth) {
      best = zone
      bestDepth = depth
    }
  }
  return best
}

/** Whether a point is on a zone's handle hit box. */
export function overHandle(zone: Pick<SpacingZone, "handle">, x: number, y: number): boolean {
  const across = zone.handle.axis === "x"
  const halfWidth = (across ? BAR_HIT_THICKNESS : BAR_HIT_LENGTH) / 2
  const halfHeight = (across ? BAR_HIT_LENGTH : BAR_HIT_THICKNESS) / 2
  return Math.abs(x - zone.handle.x) <= halfWidth && Math.abs(y - zone.handle.y) <= halfHeight
}

export interface DragStart {
  padding: Sides
  gap: number
}

export interface Modifiers {
  alt: boolean
  shift: boolean
}

/** Whole pixels, never below zero. */
export const snap = (value: number) => Math.max(0, Math.round(value))

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" }

/**
 * The CSS values a drag of `dx`/`dy` from `start` asks for, keyed by property.
 *
 * A handle grows its padding when dragged into the box. Alt sets the opposite
 * side to the same value and Alt+Shift sets all four; letting go of a modifier
 * mid-drag puts the other sides back where they started. A gap grows when
 * dragged along the main axis.
 */
export function dragValues(
  zone: Pick<SpacingZone, "kind" | "side" | "handle">,
  start: DragStart,
  delta: { dx: number; dy: number },
  modifiers: Modifiers
): Record<string, number> {
  if (zone.kind === "gap") {
    const travel = zone.handle.axis === "x" ? delta.dx : delta.dy
    return { gap: snap(start.gap + travel) }
  }
  const side = zone.side as Side
  const travel =
    side === "left" ? delta.dx : side === "right" ? -delta.dx : side === "top" ? delta.dy : -delta.dy
  const value = snap(start.padding[side] + travel)
  const sides: Side[] =
    modifiers.alt && modifiers.shift ? SIDES : modifiers.alt ? [side, OPPOSITE[side]] : [side]
  return Object.fromEntries(sides.map((each) => [`padding-${each}`, value]))
}

/** The writes a finished drag commits: only the properties it changed. */
export function changedWrites(start: DragStart, values: Record<string, number>): StyleWrite[] {
  const writes: StyleWrite[] = []
  for (const [property, value] of Object.entries(values)) {
    const before = property === "gap" ? start.gap : start.padding[property.slice("padding-".length) as Side]
    if (value !== before) writes.push({ property, value: `${value}px` })
  }
  return writes
}

const px = (value: string) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The gap along the main axis; the `gap` shorthand covers engines that leave the longhands blank. */
function gapOf(style: CSSStyleDeclaration, axis: Axis): number {
  const longhand = axis === "x" ? style.columnGap : style.rowGap
  if (longhand && longhand !== "normal") return px(longhand)
  const [row, column = row] = (style.gap ?? "").trim().split(/\s+/)
  return px((axis === "x" ? column : row) ?? "")
}

const boxOf = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })

/**
 * The spacing input for an element, or null when it is not a flex container
 * with at least one in-flow element child. Grid is left for later.
 */
export function readSpacing(element: Element): SpacingInput | null {
  const style = getComputedStyle(element)
  if (style.display !== "flex" && style.display !== "inline-flex") return null
  const children: Box[] = []
  for (const child of Array.from(element.children)) {
    const childStyle = getComputedStyle(child)
    if (childStyle.display === "none" || childStyle.display === "contents") continue
    if (childStyle.position === "absolute" || childStyle.position === "fixed") continue
    children.push(boxOf(child.getBoundingClientRect()))
  }
  if (children.length === 0) return null
  const axis: Axis = style.flexDirection.startsWith("column") ? "y" : "x"
  const sides = (prefix: string, suffix = "") =>
    Object.fromEntries(SIDES.map((side) => [side, px(style.getPropertyValue(`${prefix}-${side}${suffix}`))])) as Sides
  return {
    box: boxOf(element.getBoundingClientRect()),
    border: sides("border", "-width"),
    padding: sides("padding"),
    axis,
    wrap: Boolean(style.flexWrap) && style.flexWrap !== "nowrap",
    gap: gapOf(style, axis),
    children,
  }
}

interface Drag {
  selection: Selection
  zone: SpacingZone
  start: DragStart
  startX: number
  startY: number
  /** The style attribute as the drag found it, restored before the write. */
  inline: string | null
  values: Record<string, number>
  pointerId: number
}

export function installSpacingHandles(context: EditorContext, writer: Writer): void {
  const layer = el("div", { class: "de-space-layer" })
  // First in the overlay, so the resize handles and outlines paint and
  // hit-test above everything here.
  context.slots.overlay.prepend(layer)
  const bands = createNodePool(layer, "de-space-band")
  const handle = el("div", { class: "de-space-handle" }, [el("div", { class: "de-space-bar" })])
  const badge = el("div", { class: "de-badge de-badge--measure de-space-badge" })
  layer.append(handle, badge)
  handle.style.display = "none"
  badge.style.display = "none"

  let pointerX = Number.NaN
  let pointerY = Number.NaN
  let modifiers: Modifiers = { alt: false, shift: false }
  let suspended = false
  let drag: Drag | null = null
  let frame = 0
  /** The zone the handle is drawn for, which is what a press on it drags. */
  let shownZone: SpacingZone | null = null

  /** The one selected element, when the handles apply to it. */
  const target = (): Selection | null => {
    if (!selectionOwnsInput()) return null
    const state = context.getState()
    if (state.tool !== "move" || state.selection.length !== 1) return null
    const selection = state.selection[0]
    if (!selection.element.isConnected || isLocked(selection.element)) return null
    return selection
  }

  const hideAll = () => {
    bands.flush()
    handle.style.display = "none"
    badge.style.display = "none"
  }

  const show = (node: HTMLElement, display = "block") => {
    if (node.style.display !== display) node.style.display = display
  }

  const placeHandle = (zone: SpacingZone) => {
    // The bar runs across the drag axis: upright for a horizontal drag.
    const across = zone.handle.axis === "x"
    const width = across ? BAR_HIT_THICKNESS : BAR_HIT_LENGTH
    const height = across ? BAR_HIT_LENGTH : BAR_HIT_THICKNESS
    // Flex, so the bar centers in its hit box.
    show(handle, "flex")
    handle.dataset.zone = zone.side ?? "gap"
    handle.style.cursor = across ? "ew-resize" : "ns-resize"
    handle.style.setProperty("--de-space-bar-w", `${across ? BAR_THICKNESS : BAR_LENGTH}px`)
    handle.style.setProperty("--de-space-bar-h", `${across ? BAR_LENGTH : BAR_THICKNESS}px`)
    placeNode(handle, zone.handle.x - width / 2, zone.handle.y - height / 2, width, height)
    show(badge)
    // Below an upright bar, beside a flat one.
    if (across) placeBadge(badge, zone.handle.x, zone.handle.y + BAR_LENGTH / 2 + 14, formatDistance(zone.value))
    else placeBadge(badge, zone.handle.x + BAR_LENGTH / 2 + 18, zone.handle.y, formatDistance(zone.value))
  }

  const paintBand = (zone: SpacingZone) => {
    const { band } = zone
    const width = band.right - band.left
    const height = band.bottom - band.top
    if (width <= 0 || height <= 0) return
    placeNode(bands.take(), band.left, band.top, width, height)
  }

  const paint = () => {
    frame = 0
    const selection = target()
    const input = selection && !suspended ? readSpacing(selection.element) : null
    if (!selection || !input) {
      shownZone = null
      hideAll()
      return
    }
    const zones = spacingZones(input)
    if (drag) {
      const current = drag
      for (const zone of zones) {
        const moving = zone.kind === "gap" ? "gap" in current.values : `padding-${zone.side}` in current.values
        if (moving) paintBand(zone)
      }
      bands.flush()
      const live = relocate(zones, current.zone)
      const value = current.values[current.zone.kind === "gap" ? "gap" : `padding-${current.zone.side}`]
      if (live) placeHandle({ ...live, value })
      return
    }
    // The handle straddles the band's inner edge, so its outer half keeps the
    // zone it belongs to.
    const kept = shownZone && relocate(zones, shownZone)
    const hovered = Number.isNaN(pointerX)
      ? null
      : kept && overHandle(kept, pointerX, pointerY)
        ? kept
        : zoneAt(zones, pointerX, pointerY)
    shownZone = hovered
    if (!hovered) {
      hideAll()
      return
    }
    paintBand(hovered)
    bands.flush()
    placeHandle(hovered)
  }

  /** The gap whose handle is nearest a point: a gap's handle moves as it grows. */
  const nearestGap = (zones: SpacingZone[], x: number, y: number): SpacingZone | null => {
    let best: SpacingZone | null = null
    let distance = Number.POSITIVE_INFINITY
    for (const zone of zones) {
      if (zone.kind !== "gap") continue
      const d = Math.hypot(zone.handle.x - x, zone.handle.y - y)
      if (d < distance) {
        best = zone
        distance = d
      }
    }
    return best
  }

  /** A zone found again in a fresh layout. */
  const relocate = (zones: SpacingZone[], zone: SpacingZone): SpacingZone | null =>
    zone.kind === "gap"
      ? nearestGap(zones, zone.handle.x, zone.handle.y)
      : zones.find((each) => each.side === zone.side) ?? null

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint)
  }

  const preview = (current: Drag) => {
    const style = (current.selection.element as HTMLElement).style
    for (const [property, value] of Object.entries(current.values)) style.setProperty(property, `${value}px`)
  }

  /** Back to the drag's starting style, then the values the pointer asks for now. */
  const update = (current: Drag) => {
    current.values = dragValues(current.zone, current.start, { dx: pointerX - current.startX, dy: pointerY - current.startY }, modifiers)
    restore(current)
    preview(current)
    schedule()
  }

  const restore = (current: Drag) => {
    const element = current.selection.element
    if (current.inline === null) element.removeAttribute("style")
    else element.setAttribute("style", current.inline)
  }

  const releaseCapture = (current: Drag) => {
    try {
      handle.releasePointerCapture?.(current.pointerId)
    } catch {
      // Capture is already gone when the node was hidden.
    }
  }

  const onHandleDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const selection = target()
    const input = selection ? readSpacing(selection.element) : null
    if (!selection || !input) return
    // The zone the handle was drawn for, found again in the current layout.
    const shown = shownZone && relocate(spacingZones(input), shownZone)
    if (!shown) return
    event.preventDefault()
    event.stopPropagation()
    pointerX = event.clientX
    pointerY = event.clientY
    modifiers = { alt: event.altKey, shift: event.shiftKey }
    const start: DragStart = { padding: input.padding, gap: input.gap }
    drag = {
      selection,
      zone: shown,
      start,
      startX: event.clientX,
      startY: event.clientY,
      inline: selection.element.getAttribute("style"),
      values: {},
      pointerId: event.pointerId,
    }
    try {
      handle.setPointerCapture?.(event.pointerId)
    } catch {
      // A synthetic pointer has nothing to capture; the window listeners still see it.
    }
    schedule()
  }

  const onPointerMove = (event: PointerEvent) => {
    pointerX = event.clientX
    pointerY = event.clientY
    modifiers = { alt: event.altKey, shift: event.shiftKey }
    if (drag) {
      event.preventDefault()
      update(drag)
      return
    }
    // Over a panel or a resize handle, those own the pointer; a press held
    // down is someone else's gesture (move, marquee).
    if ((isChrome(event.target) && !layer.contains(event.target as Node)) || event.buttons !== 0) {
      pointerX = Number.NaN
      pointerY = Number.NaN
    }
    schedule()
  }

  const finish = (commit: boolean) => {
    const finished = drag
    if (!finished) return
    drag = null
    releaseCapture(finished)
    const writes = changedWrites(finished.start, finished.values)
    restore(finished)
    if (commit && writes.length > 0) {
      const summary = finished.zone.kind === "gap" ? "Gap" : "Padding"
      // One call, so one drag is one undo step however many sides it moved.
      writer.applyStyles(finished.selection, writes, summary)
      context.refresh()
    }
    schedule()
  }

  const onKey = (event: KeyboardEvent) => {
    const next = { alt: event.altKey, shift: event.shiftKey }
    if (next.alt === modifiers.alt && next.shift === modifiers.shift) return
    modifiers = next
    // A modifier pressed with the pointer still re-answers which sides move.
    if (drag) update(drag)
  }

  handle.addEventListener("pointerdown", onHandleDown)
  window.addEventListener("pointermove", onPointerMove, true)
  window.addEventListener("pointerup", () => finish(true), true)
  window.addEventListener("pointercancel", () => finish(false), true)
  window.addEventListener("keydown", onKey, true)
  window.addEventListener("keyup", onKey, true)
  window.addEventListener("blur", () => finish(false))
  // The pointer left the page: nothing is hovered any more.
  document.addEventListener("pointerout", (event) => {
    if (event.relatedTarget || drag) return
    pointerX = Number.NaN
    pointerY = Number.NaN
    schedule()
  })
  window.addEventListener("scroll", schedule, { capture: true, passive: true })
  window.addEventListener("resize", schedule, { passive: true })
  context.onRefresh(schedule)
  onDragStart(() => {
    suspended = true
    schedule()
  })
  onDragEnd(() => {
    suspended = false
    schedule()
  })
  context.subscribe((next, previous) => {
    if (next.selection !== previous.selection && drag) finish(false)
    if (next.selection !== previous.selection || next.tool !== previous.tool || editorStandDownChanged(next, previous)) schedule()
  })
}
