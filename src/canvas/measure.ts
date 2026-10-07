/**
 * Spacing measurement between the selection and a hovered element, as Figma
 * shows it while Option/Alt is held.
 *
 * Pure geometry: two boxes in, lines out. The canvas lane owns the DOM reads
 * and the drawing, so the rules — which gaps count, where a line sits, when a
 * dashed guide is needed to connect it to the target — can be pinned by unit
 * cases without a browser. Every line comes back normalized (start at the
 * smaller coordinate, positive length) so the renderer never branches on
 * direction.
 */

export interface Box { left: number; top: number; right: number; bottom: number }
/** A solid measurement line. axis "x" = horizontal line from (x, y) to (x + length, y); axis "y" = vertical line from (x, y) to (x, y + length). `value` is the distance it reports, equal to length. */
export interface MeasureLine { axis: "x" | "y"; x: number; y: number; length: number; value: number }
/** A dashed extension guide, same geometry convention as MeasureLine, no value. */
export interface ExtensionLine { axis: "x" | "y"; x: number; y: number; length: number }
export interface Measurement { lines: MeasureLine[]; extensions: ExtensionLine[] }

/**
 * Below half a pixel a line would render as a speck and its badge as "0", so
 * Figma shows nothing; touching edges read as "no gap", not "gap of 0".
 */
const MIN_LENGTH = 0.5

type Axis = "x" | "y"

/** One axis of a box: its near and far edges along that axis. */
interface Span { start: number; end: number }

function span(box: Box, axis: Axis): Span {
  return axis === "x" ? { start: box.left, end: box.right } : { start: box.top, end: box.bottom }
}

function center(s: Span): number {
  return (s.start + s.end) / 2
}

function contains(outer: Box, inner: Box): boolean {
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom
  )
}

function same(a: Box, b: Box): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom
}

/**
 * Builds a segment along `axis` between two coordinates at a fixed cross
 * position, in either order. Returns null when it is too short to show.
 */
function segment(axis: Axis, from: number, to: number, cross: number): ExtensionLine | null {
  const start = Math.min(from, to)
  const length = Math.abs(to - from)
  if (length < MIN_LENGTH) return null
  return axis === "x" ? { axis, x: start, y: cross, length } : { axis, x: cross, y: start, length }
}

function line(axis: Axis, from: number, to: number, cross: number): MeasureLine | null {
  const s = segment(axis, from, to, cross)
  return s && { ...s, value: s.length }
}

const other = (axis: Axis): Axis => (axis === "x" ? "y" : "x")

/**
 * Containment: every edge of `inner` measures out to the matching edge of
 * `outer`, with all four lines crossing `inner`'s center so they read as one
 * cross rather than four unrelated gaps.
 */
function containment(outer: Box, inner: Box): Measurement {
  const lines: MeasureLine[] = []
  for (const axis of ["x", "y"] as const) {
    const o = span(outer, axis)
    const i = span(inner, axis)
    const cross = center(span(inner, other(axis)))
    for (const l of [line(axis, o.start, i.start, cross), line(axis, i.end, o.end, cross)]) {
      if (l) lines.push(l)
    }
  }
  return { lines, extensions: [] }
}

/**
 * One axis of the general case. A gap along `axis` gets a single line; when
 * the boxes do not share any cross range the line runs at the selection's
 * center and would float free of the target, so a dashed guide extends the
 * target's near edge to meet it. Overlap along `axis` instead reports how far
 * the matching edges are offset — but only when the boxes actually intersect,
 * since edge offsets between boxes far apart on the other axis say nothing
 * about spacing.
 */
function measureAxis(axis: Axis, selected: Box, target: Box, out: Measurement): void {
  const s = span(selected, axis)
  const t = span(target, axis)
  const crossAxis = other(axis)
  const sc = span(selected, crossAxis)
  const tc = span(target, crossAxis)
  const overlapStart = Math.max(sc.start, tc.start)
  const overlapEnd = Math.min(sc.end, tc.end)
  const crossOverlaps = overlapStart < overlapEnd
  const overlapCenter = (overlapStart + overlapEnd) / 2

  const gap = (from: number, to: number, edge: number): void => {
    const cross = crossOverlaps ? overlapCenter : center(sc)
    const l = line(axis, from, to, cross)
    if (l) out.lines.push(l)
    if (crossOverlaps) return
    const nearest = cross < tc.start ? tc.start : tc.end
    const ext = segment(crossAxis, cross, nearest, edge)
    if (ext) out.extensions.push(ext)
  }

  if (t.start >= s.end) {
    gap(s.end, t.start, t.start)
  } else if (t.end <= s.start) {
    gap(t.end, s.start, t.end)
  } else if (crossOverlaps) {
    const offsets = [
      line(axis, s.start, t.start, overlapCenter),
      line(axis, s.end, t.end, overlapCenter),
    ].filter((l): l is MeasureLine => l !== null)
    offsets.sort((a, b) => (axis === "x" ? a.x - b.x : a.y - b.y))
    out.lines.push(...offsets)
  }
}

export function measureSpacing(selected: Box, target: Box): Measurement {
  if (same(selected, target)) return { lines: [], extensions: [] }
  if (contains(target, selected)) return containment(target, selected)
  if (contains(selected, target)) return containment(selected, target)
  const out: Measurement = { lines: [], extensions: [] }
  measureAxis("x", selected, target, out)
  measureAxis("y", selected, target, out)
  return out
}

/** Formats a distance for the badge: rounded to 1 decimal, trailing ".0" dropped ("12", "12.5"). */
export function formatDistance(value: number): string {
  return String(Math.round(value * 10) / 10)
}
