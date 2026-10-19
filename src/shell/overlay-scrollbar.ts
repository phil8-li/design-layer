/**
 * A panel scrollbar that takes no width.
 *
 * A styled `::-webkit-scrollbar` is always a classic bar in Chromium, and a
 * classic bar reserves its 12px track inside the scroller. Every full-bleed
 * band in a panel — a section header's hover, a selected layer row — then
 * stopped 12px short of the panel's outer edge, with the empty track showing
 * beside it. The panels' tab panes hide their native bar (`css/panels.ts`) and
 * draw this thumb over the content instead, the way an overlay scrollbar does.
 *
 * The thumb looks and behaves like the chrome-wide bar in `css/base.ts`: clear
 * at rest, inked while its pane scrolls, darker under the pointer, and it can
 * be dragged. Wheel, trackpad and keyboard scrolling are the pane's own.
 *
 * A pane that scrolls sideways — the Layers pane, which opts in with
 * `data-de-scroll-x` (`css/left-tabs.ts`) — gets the same thumb along its
 * bottom edge. Only a pane that opts in: every other pane is built to the
 * panel's width, and a thumb there would only advertise a stray pixel.
 */

import { el } from "../core/dom"

const MIN_THUMB = 24
/** The thumb's box across its bar: a 6px bar inside a 3px clear border. */
const THUMB_BOX = 12

type Axis = "x" | "y"

/**
 * The pane that scrolls on `axis`. Vertically, the visible tab panel, else
 * the panel body; sideways, only a visible pane that opted in.
 */
function scrollerIn(panel: HTMLElement, axis: Axis): HTMLElement | null {
  const panes = axis === "y"
    ? [...panel.querySelectorAll<HTMLElement>(".de-tabpanel:not([hidden])"), ...panel.querySelectorAll<HTMLElement>(".de-panel-body")]
    : [...panel.querySelectorAll<HTMLElement>("[data-de-scroll-x]:not([hidden])")]
  return panes.find((pane) => pane.offsetParent !== null && (axis === "y"
    ? pane.scrollHeight > pane.clientHeight + 1
    : pane.scrollWidth > pane.clientWidth + 1)) ?? null
}

export function mountOverlayScrollbar(panel: HTMLElement, idleMs: number): () => void {
  const thumbs: Record<Axis, HTMLElement> = {
    y: el("div", { class: "de-scroll-thumb", "aria-hidden": "true", hidden: true }),
    x: el("div", { class: "de-scroll-thumb de-scroll-thumb--x", "aria-hidden": "true", hidden: true }),
  }
  panel.append(thumbs.y, thumbs.x)

  const panes: Record<Axis, HTMLElement | null> = { x: null, y: null }
  /** Each thumb's length along its bar, and the length of the track it runs in. */
  const sizes: Record<Axis, number> = { x: 0, y: 0 }
  const tracks: Record<Axis, number> = { x: 0, y: 0 }
  const idle: Record<Axis, ReturnType<typeof setTimeout> | undefined> = { x: undefined, y: undefined }
  /** Each pane's offsets at its last scroll, to tell which axis an event moved. */
  const seen = new WeakMap<HTMLElement, { top: number; left: number }>()

  const placeY = () => {
    const pane = (panes.y = scrollerIn(panel, "y"))
    if (!pane) {
      thumbs.y.hidden = true
      return
    }
    const track = pane.getBoundingClientRect()
    const top = track.top - panel.getBoundingClientRect().top
    const range = pane.scrollHeight - pane.clientHeight
    const height = (sizes.y = Math.max(MIN_THUMB, (track.height * pane.clientHeight) / pane.scrollHeight))
    tracks.y = track.height
    const offset = range > 0 ? (pane.scrollTop / range) * (track.height - height) : 0
    thumbs.y.hidden = false
    thumbs.y.style.height = `${height}px`
    thumbs.y.style.transform = `translateY(${top + offset}px)`
  }

  const placeX = () => {
    const pane = (panes.x = scrollerIn(panel, "x"))
    if (!pane) {
      thumbs.x.hidden = true
      return
    }
    const box = panel.getBoundingClientRect()
    const track = pane.getBoundingClientRect()
    // When the pane also scrolls vertically, the corner is the vertical thumb's.
    const length = (tracks.x = track.width - (pane.scrollHeight > pane.clientHeight + 1 ? THUMB_BOX : 0))
    const range = pane.scrollWidth - pane.clientWidth
    const width = (sizes.x = Math.max(MIN_THUMB, (length * pane.clientWidth) / pane.scrollWidth))
    const offset = range > 0 ? (pane.scrollLeft / range) * (length - width) : 0
    thumbs.x.hidden = false
    thumbs.x.style.width = `${width}px`
    thumbs.x.style.transform = `translate(${track.left - box.left + offset}px, ${track.bottom - box.top - THUMB_BOX}px)`
  }

  const place = () => {
    placeY()
    placeX()
  }

  const ink = (axis: Axis) => {
    thumbs[axis].setAttribute("data-scrolling", "")
    clearTimeout(idle[axis])
    idle[axis] = setTimeout(() => thumbs[axis].removeAttribute("data-scrolling"), idleMs)
  }

  const onScroll = (event: Event) => {
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.matches(".de-tabpanel, .de-panel-body")) return
    const before = seen.get(target)
    seen.set(target, { top: target.scrollTop, left: target.scrollLeft })
    place()
    // Only the thumb of the axis that moved inks: a sideways scroll is not a
    // reason to light the vertical bar.
    const movedX = before ? before.left !== target.scrollLeft : target.scrollLeft !== 0
    const movedY = before ? before.top !== target.scrollTop : !movedX
    if (movedY) ink("y")
    if (movedX && panes.x === target) ink("x")
  }

  const startDrag = (axis: Axis) => (event: PointerEvent) => {
    const target = panes[axis]
    if (event.button !== 0 || !target) return
    event.preventDefault()
    const thumb = thumbs[axis]
    const across = axis === "x"
    const from = across ? event.clientX : event.clientY
    const startScroll = across ? target.scrollLeft : target.scrollTop
    const range = across ? target.scrollWidth - target.clientWidth : target.scrollHeight - target.clientHeight
    const ratio = range / Math.max(1, tracks[axis] - sizes[axis])
    thumb.setPointerCapture(event.pointerId)
    thumb.setAttribute("data-dragging", "")
    const onMove = (move: PointerEvent) => {
      const next = startScroll + ((across ? move.clientX : move.clientY) - from) * ratio
      if (across) target.scrollLeft = next
      else target.scrollTop = next
    }
    const onUp = () => {
      thumb.removeAttribute("data-dragging")
      thumb.removeEventListener("pointermove", onMove)
      thumb.removeEventListener("pointerup", onUp)
      thumb.removeEventListener("pointercancel", onUp)
    }
    thumb.addEventListener("pointermove", onMove)
    thumb.addEventListener("pointerup", onUp)
    thumb.addEventListener("pointercancel", onUp)
  }

  // The content can grow, shrink or switch tabs without a scroll; re-measure
  // when the pointer comes into the panel and when the panel changes size, so
  // a clear thumb is never left to catch the pointer where the bar is not.
  const resized = new ResizeObserver(place)
  resized.observe(panel)
  panel.addEventListener("scroll", onScroll, { capture: true, passive: true })
  panel.addEventListener("pointerenter", place)
  thumbs.y.addEventListener("pointerdown", startDrag("y"))
  thumbs.x.addEventListener("pointerdown", startDrag("x"))

  return () => {
    clearTimeout(idle.x)
    clearTimeout(idle.y)
    resized.disconnect()
    panel.removeEventListener("scroll", onScroll, true)
    panel.removeEventListener("pointerenter", place)
    thumbs.y.remove()
    thumbs.x.remove()
  }
}
