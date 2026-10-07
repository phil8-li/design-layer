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
 */

import { el } from "../core/dom"

const MIN_THUMB = 24

/** The pane that scrolls: the visible tab panel, else the panel body. */
function scrollerIn(panel: HTMLElement): HTMLElement | null {
  const panes = [...panel.querySelectorAll<HTMLElement>(".de-tabpanel:not([hidden])"), ...panel.querySelectorAll<HTMLElement>(".de-panel-body")]
  return panes.find((pane) => pane.offsetParent !== null && pane.scrollHeight > pane.clientHeight + 1) ?? null
}

export function mountOverlayScrollbar(panel: HTMLElement, idleMs: number): () => void {
  const thumb = el("div", { class: "de-scroll-thumb", "aria-hidden": "true", hidden: true })
  panel.append(thumb)

  let pane: HTMLElement | null = null
  let height = 0
  let idle: ReturnType<typeof setTimeout> | undefined

  const place = () => {
    pane = scrollerIn(panel)
    if (!pane) {
      thumb.hidden = true
      return
    }
    const track = pane.getBoundingClientRect()
    const top = track.top - panel.getBoundingClientRect().top
    const range = pane.scrollHeight - pane.clientHeight
    height = Math.max(MIN_THUMB, (track.height * pane.clientHeight) / pane.scrollHeight)
    const offset = range > 0 ? (pane.scrollTop / range) * (track.height - height) : 0
    thumb.hidden = false
    thumb.style.height = `${height}px`
    thumb.style.transform = `translateY(${top + offset}px)`
  }

  const onScroll = (event: Event) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches(".de-tabpanel, .de-panel-body")) return
    place()
    thumb.setAttribute("data-scrolling", "")
    clearTimeout(idle)
    idle = setTimeout(() => thumb.removeAttribute("data-scrolling"), idleMs)
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !pane) return
    event.preventDefault()
    const target = pane
    const startY = event.clientY
    const startScroll = target.scrollTop
    const ratio = (target.scrollHeight - target.clientHeight) / Math.max(1, target.clientHeight - height)
    thumb.setPointerCapture(event.pointerId)
    thumb.setAttribute("data-dragging", "")
    const onMove = (move: PointerEvent) => {
      target.scrollTop = startScroll + (move.clientY - startY) * ratio
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
  thumb.addEventListener("pointerdown", onPointerDown)

  return () => {
    clearTimeout(idle)
    resized.disconnect()
    panel.removeEventListener("scroll", onScroll, true)
    panel.removeEventListener("pointerenter", place)
    thumb.remove()
  }
}
