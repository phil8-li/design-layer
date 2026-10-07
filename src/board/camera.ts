/**
 * The board's camera: where the world sits under the canvas rect, and how big.
 *
 * Pure math, no DOM, so every rule the board's motion depends on can be pinned
 * by a unit case rather than eyeballed in a browser. Coordinates are
 * board-local: the origin is the board's top-left, which is the canvas rect's
 * top-left, so "the frame fills the canvas" is simply `{ x: -frame.x, y:
 * -frame.y, scale: 1 }` with no panel arithmetic leaking in.
 *
 * A screen point `p` shows the world point `(p - camera) / scale`, and the CSS
 * is `translate(x, y) scale(s)` with `transform-origin: 0 0` — the same mapping
 * written the other way round.
 */

export interface Camera {
  x: number
  y: number
  scale: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** How far a person can zoom by hand. Past 4× an iframe is only its pixels. */
export const MIN_SCALE = 0.05
export const MAX_SCALE = 4
/**
 * Fit never magnifies. A board of one page fitted at 1.4× would show that page
 * larger than it is live, which is a lie about what the page looks like.
 */
export const FIT_MAX_SCALE = 1
/** Air around the fitted content, as a share of the board on each side. */
export const FIT_PADDING = 0.07

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(max, Math.max(min, scale))
}

/** The camera that shows all of `content`, centered, with padding around it. */
export function fit(board: Size, content: Rect, padding = FIT_PADDING): Camera {
  const usableW = Math.max(1, board.width * (1 - 2 * padding))
  const usableH = Math.max(1, board.height * (1 - 2 * padding))
  const scale = clampScale(
    Math.min(usableW / Math.max(1, content.width), usableH / Math.max(1, content.height)),
    MIN_SCALE,
    FIT_MAX_SCALE
  )
  return {
    x: (board.width - content.width * scale) / 2 - content.x * scale,
    y: (board.height - content.height * scale) / 2 - content.y * scale,
    scale,
  }
}

/**
 * The camera under which `frame` exactly covers the canvas rect.
 *
 * Every frame is laid out at the canvas size, so this is scale 1 and a pure
 * translation — which is also why a page shown this way is pixel-for-pixel the
 * page shown live, and a close can hand over between the two without a jump.
 */
export function focus(frame: Rect): Camera {
  return { x: -frame.x, y: -frame.y, scale: 1 }
}

export function screenToWorld(camera: Camera, point: Point): Point {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale }
}

export function worldToScreen(camera: Camera, point: Point): Point {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y }
}

export function rectToScreen(camera: Camera, rect: Rect): Rect {
  return {
    x: rect.x * camera.scale + camera.x,
    y: rect.y * camera.scale + camera.y,
    width: rect.width * camera.scale,
    height: rect.height * camera.scale,
  }
}

/** Zooms by `factor`, keeping the world point under `point` where it is. */
export function zoomAt(camera: Camera, factor: number, point: Point): Camera {
  const scale = clampScale(camera.scale * factor)
  const world = screenToWorld(camera, point)
  return { x: point.x - world.x * scale, y: point.y - world.y * scale, scale }
}

export function pan(camera: Camera, dx: number, dy: number): Camera {
  return { x: camera.x + dx, y: camera.y + dy, scale: camera.scale }
}

export function toCss(camera: Camera): string {
  return `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})`
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * The camera `t` of the way from `a` to `b`.
 *
 * Scale moves in log space: going from 10% to 100% is the same visual step as
 * 100% to 1000%, so a linear scale tween spends most of its time at the large
 * end and feels like it lurches at the start. Position is then derived rather
 * than lerped: the move from `a` to `b` is a zoom about one fixed screen point,
 * and following that zoom keeps every world point on a straight path — lerping
 * x and y beside a log scale makes the content swing sideways mid-flight.
 */
export function interpolate(a: Camera, b: Camera, t: number): Camera {
  const logRatio = Math.log(b.scale / a.scale)
  if (Math.abs(logRatio) < 1e-6) {
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), scale: lerp(a.scale, b.scale, t) }
  }
  const scale = a.scale * Math.exp(logRatio * t)
  // The screen point that shows the same world point under both cameras.
  const px = (a.x * b.scale - b.x * a.scale) / (b.scale - a.scale)
  const py = (a.y * b.scale - b.y * a.scale) / (b.scale - a.scale)
  const k = scale / a.scale
  return { x: px - (px - a.x) * k, y: py - (py - a.y) * k, scale }
}

/**
 * A CSS `cubic-bezier()` as a function of time, so a rAF tween can move on the
 * same curve the view transition's keyframes do. Newton steps with a bisection
 * fallback, the way browsers solve it.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x
      if (Math.abs(error) < 1e-6) return sampleY(t)
      const slope = slopeX(t)
      if (Math.abs(slope) < 1e-6) break
      t -= error / slope
    }
    let lo = 0
    let hi = 1
    t = x
    while (hi - lo > 1e-6) {
      if (sampleX(t) < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return sampleY(t)
  }
}

/** The board's one curve, as CSS and as a function: fast out, long settle. */
export const BOARD_EASE_CSS = "cubic-bezier(0.22, 1, 0.36, 1)"
export const boardEase = cubicBezier(0.22, 1, 0.36, 1)
