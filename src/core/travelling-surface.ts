/**
 * The selected thing in a strip of things, as ONE object that moves.
 *
 * ## The pattern
 *
 * A tab strip and a segmented control state selection the same way: the chosen
 * item wears a filled surface. Painting that surface on the item itself makes
 * the selection two boxes taking turns — the old one vanishes, the new one
 * appears, and nothing crosses the gap for the eye to follow. A single node
 * that travels says the same thing as one object, which is what the control is
 * actually about.
 *
 * ## Why this file exists
 *
 * It was written twice before it was written once. The tab pill got a module
 * with a `ResizeObserver`; the segmented thumb got an inline copy in
 * `inspector/field.ts` with no observer and a different rung. Same idea, two
 * implementations, free to drift — which is the thing this codebase keeps
 * closing elsewhere and had just re-opened.
 *
 * The DURATIONS stay different and that is deliberate: a tab pill crosses a
 * label's width and a segment thumb crosses a whole segment, so the tab takes
 * `snap` and the segment `fast`. That is a parameter, not a reason for two
 * files. Everything else — the measurement, the refusal to publish one it does
 * not have, the first-placement jump, the re-measure on resize — is identical
 * and is here.
 *
 * ## What it refuses to do
 *
 * Publish a measurement of zero. `offsetWidth` is zero in JSDOM and in any
 * panel that has not painted, and a surface parked at the origin with no width
 * is worse than no surface at all. The `[data-de-<flag>]` attribute is set only
 * once a real measurement exists, and each stylesheet uses that flag to decide
 * between the travelling surface and the per-item background it replaces. So an
 * unmeasured strip keeps exactly the appearance it had before this existed.
 */

import { el } from "./dom"

export interface TravellingSurface {
  /** Put the surface under `selected`, or hide it when there is nothing to mark. */
  track(selected: HTMLElement | null | undefined): void
}

export interface TravellingSurfaceOptions {
  /** Class for the moving node — `de-tab-pill`, `de-segment-thumb`. */
  className: string
  /** Attribute the stylesheet reads to know a measurement exists. */
  flag: string
  /** Custom property names the CSS positions from. */
  xProperty: string
  widthProperty: string
  /** Selector for the items it travels between, for the resize observer. */
  itemSelector: string
}

/**
 * Prepends the surface to `container` and returns its controller.
 *
 * `container` must be the element the items are laid out in, and must be its
 * own containing block — the surface is absolutely positioned against it.
 * Because an absolutely positioned child of a scroll container scrolls with
 * that container's content, the offsets stay correct in a strip that has
 * scrolled sideways.
 */
export function installTravellingSurface(
  container: HTMLElement,
  options: TravellingSurfaceOptions
): TravellingSurface {
  const surface = el("span", { class: options.className, "aria-hidden": "true" })
  container.prepend(surface)

  /*
   * The first placement is a jump and every one after it is a move.
   *
   * Without this the surface sits at `translateX(0)` on mount and its first
   * placement flies in from the container's left edge — an animation that says
   * something was just chosen when in fact the panel merely opened. The
   * transition is suppressed for that one write and restored on the next frame,
   * which is the earliest point at which the browser has taken the starting
   * position as read.
   */
  let placed = false
  let tracked: HTMLElement | null = null
  // What was last published, so a re-measure that finds the same box writes
  // nothing. The resize observer re-delivers on every `observe`, and each
  // redundant write re-serialized the style attribute a frame after the render.
  let x = ""
  let w = ""

  /** Reads the tracked box, and returns the writes that publish it — or none. */
  const read = (): (() => void) | null => {
    if (!tracked) return () => container.removeAttribute(options.flag)
    const width = tracked.offsetWidth
    // Zero means the strip is not laid out — a closed panel, JSDOM — so there
    // is nothing true to publish. What is already published stays: the strip
    // is not on screen to show it, and taking the flag down only to put the
    // same measurement back on show was two writes per hide.
    if (width === 0) return null
    const left = `${tracked.offsetLeft}px`
    const size = `${width}px`
    return () => {
      if (!placed) {
        surface.style.transition = "none"
        requestAnimationFrame(() => {
          surface.style.transition = ""
        })
        placed = true
      }
      if (left !== x) surface.style.setProperty(options.xProperty, (x = left))
      if (size !== w) surface.style.setProperty(options.widthProperty, (w = size))
      if (!container.hasAttribute(options.flag)) container.setAttribute(options.flag, "")
    }
  }
  const measure = (): void => read()?.()

  /*
   * A measurement has to be re-taken when the thing it measured changes shape,
   * and the items change shape without anyone selecting them: the Changes tab
   * grows a count badge the first time an edit lands, a seam drag changes the
   * strip's width and can start or stop its scrolling, a late font re-measures
   * every label.
   *
   * Observing the items beats listening for those three separately, because it
   * cannot miss a fourth. Absent in JSDOM, where there is no layout to observe
   * and `measure` would refuse the result anyway.
   */
  const observer =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure())
  observer?.observe(container)
  // Each item once. Re-observing the whole strip on every `track` made the
  // observer re-deliver for all of it, so every tab switch measured twice.
  const observed = new WeakSet<Element>()

  return {
    track(selected) {
      tracked = selected ?? null
      if (observer) {
        for (const item of container.querySelectorAll(options.itemSelector)) {
          if (observed.has(item)) continue
          observed.add(item)
          observer.observe(item)
        }
      }
      placeSoon(read)
    },
  }
}

/*
 * Every surface placed in one turn reads before any of them writes.
 *
 * A Design-tab render builds several segmented controls and places each chip as
 * it goes. Measuring one and writing it before measuring the next made every
 * placement after the first force a fresh layout of the panel being built —
 * the commonest selection paid for one layout per control. Queued to a single
 * microtask, still ahead of the frame that paints them, the whole render costs
 * one. A surface queued twice in a turn is placed once, at its last target.
 */
const queuedReads = new Set<() => (() => void) | null>()

function placeSoon(read: () => (() => void) | null): void {
  if (queuedReads.size === 0) queueMicrotask(placeQueued)
  queuedReads.add(read)
}

function placeQueued(): void {
  const reads = [...queuedReads]
  queuedReads.clear()
  for (const write of reads.map((read) => read())) write?.()
}

/** The tab strip's pill. `snap`, because it crosses a label's width. */
export function installTabPill(strip: HTMLElement): TravellingSurface {
  return installTravellingSurface(strip, {
    className: "de-tab-pill",
    flag: "data-de-pill",
    xProperty: "--de-pill-x",
    widthProperty: "--de-pill-w",
    itemSelector: ".de-tab",
  })
}

/**
 * The icon segmented control's chip.
 *
 * Its own installer rather than a parameter on the one below, because the two
 * differ in the class they move and the items they measure — and `field.ts`
 * should be able to say which control it is building without also restating
 * four selectors.
 */
export function installIconSegmentThumb(track: HTMLElement): TravellingSurface {
  return installTravellingSurface(track, {
    className: "de-iseg-thumb",
    flag: "data-de-thumb",
    xProperty: "--de-thumb-x",
    widthProperty: "--de-thumb-w",
    itemSelector: ".de-tool",
  })
}

/** The segmented control's chip. `fast`, because it crosses a whole segment. */
export function installSegmentThumb(track: HTMLElement): TravellingSurface {
  return installTravellingSurface(track, {
    className: "de-segment-thumb",
    flag: "data-de-thumb",
    xProperty: "--de-thumb-x",
    widthProperty: "--de-thumb-w",
    itemSelector: ".de-segment",
  })
}
