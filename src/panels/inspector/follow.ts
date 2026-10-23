/**
 * Keeps the Design tab describing the selection as it is now, rather than as
 * it was when the panel last rebuilt.
 *
 * The panel reads geometry once per render, and it renders on a selection, a
 * commit or a refresh. Everything else that moves a box left its numbers
 * behind: a canvas resize of an element with a width transition (the release
 * repainted on the first frame of the tween and read 331 for a box that came
 * to rest at 380), the app resizing its own panel in interactive mode, a
 * window resize, a scroll under the X and Y readouts.
 *
 * The signals: a `ResizeObserver` and a `MutationObserver` (`style`, `class`)
 * on the selected elements, which cover every resize and every inline write
 * the app or a gesture makes; scroll and window resize, for the readouts; and
 * a slow poll as the backstop for a box that moves without changing size, such
 * as a sibling growing above it. A signal only asks for a check on the next
 * frame, so a burst of them costs one. The check compares what the panel would
 * show with what it showed and repaints only when they differ, so a box that
 * did not change is never a rebuild.
 *
 * Held while the person is working in the panel: a field with typed text not
 * yet committed, a scrub, a press, an open popup. A rebuild then would throw
 * the typing away or take the control out from under the pointer. Nothing is
 * marked as owed, because nothing needs to be: `shown` still describes the old
 * box, so the first check after the hold ends repaints.
 */

import { isChrome } from "../../core/dom"

/** A marquee over a page can pick hundreds; the panel shows the set as one "Mixed". */
const MAX_TRACKED = 50
/** The backstop's period: what it catches has no event, so it can be a beat late. */
const POLL_MS = 500
/** A scroll repaints once it settles: a rebuild per scroll frame would cost the app its scroll. */
const SCROLL_SETTLE_MS = 120
/**
 * The closest two follow repaints come. A box that changes every frame — a
 * handle drag, a tween, an animation — rebuilt the whole tab every frame and
 * tripled a drag's main-thread time per pointer move (1.9ms to 5ms, measured);
 * at this spacing the numbers still read as live and the last change still lands.
 */
const MIN_INTERVAL_MS = 50

export interface Follow {
  /** Aims the watch at what a render described, and records what it showed. */
  track(elements: readonly Element[]): void
}

/**
 * What the panel shows that layout or the app can change behind its back: each
 * element's box, rounded as the fields round it, and the two attributes its
 * sizing modes and every computed value are read from.
 */
function describeGeometry(elements: readonly Element[]): string {
  let text = ""
  for (const element of elements) {
    if (!element.isConnected) {
      text += "-;"
      continue
    }
    const box = element.getBoundingClientRect()
    text += `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`
    text += `|${element.getAttribute("style") ?? ""}|${element.getAttribute("class") ?? ""};`
  }
  return text
}

/** A text field holding text the person typed and has not committed. */
function typing(node: Element): boolean {
  if (node instanceof HTMLTextAreaElement) return node.value !== node.defaultValue
  if (node instanceof HTMLInputElement) {
    if (/^(checkbox|radio|button|submit|reset|range|color|file)$/.test(node.type)) return false
    return node.value !== node.defaultValue
  }
  return node instanceof HTMLElement && node.isContentEditable
}

export function followSelection(options: {
  host: HTMLElement
  /** True while a repaint would be seen: the Design tab is the one showing. */
  showing(): boolean
  repaint(): void
}): Follow {
  const { host } = options
  let tracked: Element[] = []
  let shown = ""
  let frame = 0
  let settle = 0
  let poll = 0
  let pressed = false
  let painted = 0
  let trailing = 0
  /**
   * The native menu a press opened, until a pick, a blur or the next press
   * elsewhere. The platform draws the open list and says nothing while it is
   * up, so the press is the only sign; a rebuild then took the `<select>` away
   * and closed the list under the pointer of anyone whose selection animates.
   */
  let menu: HTMLSelectElement | null = null

  const held = (): boolean => {
    if (pressed) return true
    const active = document.activeElement
    if (active && host.contains(active) && typing(active)) return true
    if (menu && menu === active) return true
    return host.querySelector(".de-field--scrubbing, [aria-haspopup][aria-expanded='true']") !== null
  }

  const check = (): void => {
    frame = 0
    if (tracked.length === 0 || document.hidden || !options.showing() || held()) return
    // A primary the app has unmounted has nothing true left to show, so the
    // panel keeps describing it as it was rather than as an empty box.
    if (!tracked[0].isConnected) return
    const next = describeGeometry(tracked)
    if (next === shown) return
    const wait = painted + MIN_INTERVAL_MS - performance.now()
    if (wait > 0) {
      window.clearTimeout(trailing)
      trailing = window.setTimeout(soon, wait)
      return
    }
    shown = next
    painted = performance.now()
    options.repaint()
  }

  const soon = (): void => {
    if (frame || tracked.length === 0) return
    frame = requestAnimationFrame(check)
  }

  // Both absent in the suites' older DOMs; the poll still follows there.
  const resized = typeof ResizeObserver === "function" ? new ResizeObserver(soon) : null
  const mutated = typeof MutationObserver === "function" ? new MutationObserver(soon) : null

  window.addEventListener("resize", soon)
  window.addEventListener(
    "scroll",
    (event) => {
      // The panels' own scrolling moves nothing in the app.
      if (tracked.length === 0 || isChrome(event.target)) return
      window.clearTimeout(settle)
      settle = window.setTimeout(soon, SCROLL_SETTLE_MS)
    },
    { capture: true, passive: true }
  )
  window.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target as Node | null
      const inside = target !== null && host.contains(target)
      // A press on the page closes the list, and pays what it held off.
      if (menu && !inside) soon()
      pressed = inside
      menu = inside && target instanceof HTMLSelectElement ? target : null
    },
    true
  )
  const release = (): void => {
    if (!pressed) return
    pressed = false
    soon()
  }
  window.addEventListener("pointerup", release, true)
  window.addEventListener("pointercancel", release, true)
  host.addEventListener("change", () => (menu = null), true)
  host.addEventListener("focusout", () => {
    menu = null
    soon()
  })

  const same = (next: readonly Element[]): boolean =>
    next.length === tracked.length && next.every((element, index) => element === tracked[index])

  return {
    track(elements) {
      const next = elements.filter((element) => element.isConnected).slice(0, MAX_TRACKED)
      if (!same(next)) {
        resized?.disconnect()
        mutated?.disconnect()
        for (const element of next) {
          resized?.observe(element)
          mutated?.observe(element, { attributes: true, attributeFilter: ["style", "class"] })
        }
        tracked = next
        window.clearInterval(poll)
        poll = next.length ? window.setInterval(soon, POLL_MS) : 0
      }
      shown = describeGeometry(tracked)
    },
  }
}
