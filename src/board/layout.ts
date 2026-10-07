/**
 * Where each page sits on the board.
 *
 * Every frame is the size of the canvas rect at the moment the board opened,
 * because that is the viewport the page is laid out at live: a frame at any
 * other size would be a different page — other breakpoints, other wrapping —
 * and the zoom back into it would land on something the user has never seen.
 *
 * The grid's column count is chosen so the whole board has roughly the canvas's
 * aspect. Fit then uses the space in both directions instead of leaving a tall
 * strip or a wide ribbon floating in the middle of the board.
 *
 * Pure: frames in, rects out. Order is preserved, so the caller decides that
 * the current page comes first and it lands top-left.
 */

import type { Rect, Size } from "./camera"

export interface BoardLayout {
  frames: Rect[]
  columns: number
  rows: number
  gapX: number
  gapY: number
  /** The bounding box of every frame, in world coordinates. */
  bounds: Rect
}

/** Column gap as a share of the frame's width. */
export const GAP_X_SHARE = 0.08
/**
 * Row gap. The label above each frame is drawn at screen size, so at the small
 * zooms where the whole board is visible it needs world room that grows as the
 * zoom shrinks; the pixel floor covers a short, wide canvas.
 */
export const GAP_Y_SHARE = 0.12
export const GAP_Y_MIN = 140

export function layoutFrames(count: number, frame: Size, target: Size = frame): BoardLayout {
  const gapX = Math.round(frame.width * GAP_X_SHARE)
  const gapY = Math.round(Math.max(frame.height * GAP_Y_SHARE, GAP_Y_MIN))
  const n = Math.max(0, Math.floor(count))
  const targetAspect = Math.max(1e-3, target.width) / Math.max(1e-3, target.height)

  let columns = 1
  let best = Infinity
  for (let c = 1; c <= Math.max(1, n); c += 1) {
    const r = Math.ceil(Math.max(1, n) / c)
    const width = c * frame.width + (c - 1) * gapX
    const height = r * frame.height + (r - 1) * gapY
    const score = Math.abs(Math.log(width / height / targetAspect))
    // Strictly better only: on a tie the narrower grid wins, which keeps a
    // board of two pages side by side instead of stacked.
    if (score < best - 1e-9) {
      best = score
      columns = c
    }
  }
  const rows = n === 0 ? 0 : Math.ceil(n / columns)

  const frames: Rect[] = []
  for (let i = 0; i < n; i += 1) {
    const col = i % columns
    const row = Math.floor(i / columns)
    frames.push({
      x: col * (frame.width + gapX),
      y: row * (frame.height + gapY),
      width: frame.width,
      height: frame.height,
    })
  }
  const usedColumns = Math.min(columns, Math.max(1, n))
  return {
    frames,
    columns,
    rows,
    gapX,
    gapY,
    bounds: {
      x: 0,
      y: 0,
      width: n === 0 ? frame.width : usedColumns * frame.width + (usedColumns - 1) * gapX,
      height: n === 0 ? frame.height : rows * frame.height + (rows - 1) * gapY,
    },
  }
}

/** Which frame, if any, contains the world point. */
export function hitFrame(frames: readonly Rect[], x: number, y: number): number {
  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i]
    if (x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height) return i
  }
  return -1
}

/** Distance from a point to a rect's nearest edge; zero inside. */
export function distanceToRect(rect: Rect, x: number, y: number): number {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width))
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height))
  return Math.hypot(dx, dy)
}
