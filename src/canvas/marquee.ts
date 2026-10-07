/**
 * Marquee multi-select.
 *
 * The gesture starts only on genuinely empty canvas — the page background,
 * never an element — because a drag that begins on an element already means
 * "move that element", and one gesture may only mean one thing.
 */

import { el, isCanvasElement, isChrome } from "../core/dom"
import { isDeepSelect } from "../core/keymap"
import { getResolver } from "../core/resolve"
import type { EditorContext } from "../core/context"
import type { LayerElement } from "../core/types"

const DRAG_THRESHOLD = 3

export interface MarqueeController {
  /** Claims empty-canvas presses and Shift presses reserved for marquee/toggle. */
  begin(event: PointerEvent, target: LayerElement | null): boolean
}

export function installMarquee(context: EditorContext): MarqueeController {
  const resolver = getResolver(context.bridge)
  const box = el("div", { class: "de-marquee", style: "display:none" })
  context.slots.overlay.append(box)

  let originX = 0
  let originY = 0
  let pending = false
  let active = false
  let additive = false
  let pointerId = -1
  let capture: Element | null = null
  let toggleTarget: LayerElement | null = null
  let baseline: LayerElement[] = []

  /**
   * Touching an object selects it. Full enclosure is the intuitive rule and the
   * wrong one: on a full-bleed layout nothing is ever entirely inside the drag,
   * so an enclose-only marquee returns almost nothing.
   */
  const touched = (element: Element, l: number, t: number, r: number, b: number): boolean => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    return !(rect.right < l || rect.left > r || rect.bottom < t || rect.top > b)
  }

  /**
   * Candidates come from the one shared layer graph. A normal marquee takes
   * the active scope's direct children; deep marquee recursively takes leaves.
   */
  const swept = (l: number, t: number, r: number, b: number, deep: boolean): LayerElement[] => {
    // `isConnected`, as in `resolve()`: React replaces DOM nodes constantly, and
    // a drilled scope that has since been unmounted makes `querySelectorAll`
    // and `layerChildren` both return nothing — a marquee that selects zero
    // elements for no reason the user can see. Fall back to the live root.
    const held = context.getState().scope
    const scope = held?.isConnected ? held : resolver.scopeRoot()

    if (!deep) return resolver.layerChildren(scope).filter((node) => touched(node, l, t, r, b))

    const found: LayerElement[] = []
    // Each node's children are listed once and handed down, not listed again
    // by the visit they decide on.
    const visit = (children: LayerElement[]) => {
      for (const node of children) {
        const grandchildren = resolver.layerChildren(node)
        if (grandchildren.length) visit(grandchildren)
        else if (touched(node, l, t, r, b)) found.push(node)
      }
    }
    visit(resolver.layerChildren(scope))
    return found
  }

  const begin = (event: PointerEvent, target: LayerElement | null): boolean => {
    const { tool } = context.getState()
    if (event.button !== 0 || tool !== "move") return false
    if (isChrome(event.target)) return false

    // A live app often fills every canvas pixel, leaving no literal body area.
    // Shift reserves a press for marquee/toggle even over full-bleed content;
    // an unmodified press still starts only on real empty canvas.
    if (isCanvasElement(event.target) && !event.shiftKey) return false
    originX = event.clientX
    originY = event.clientY
    additive = event.shiftKey
    pointerId = event.pointerId
    toggleTarget = target
    baseline = context.getState().selection.map((entry) => entry.element)
    pending = true
    active = false
    capture = event.target instanceof Element ? event.target : null
    if (capture && "setPointerCapture" in capture) {
      try {
        ;(capture as Element & { setPointerCapture(id: number): void }).setPointerCapture(pointerId)
      } catch {
        capture = null
      }
    }
    return true
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!pending) return
    const dx = event.clientX - originX
    const dy = event.clientY - originY
    if (!active && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    active = true
    event.preventDefault()
    box.style.display = "block"
    box.style.transform = `translate(${Math.min(originX, event.clientX)}px, ${Math.min(originY, event.clientY)}px)`
    box.style.width = `${Math.abs(dx)}px`
    box.style.height = `${Math.abs(dy)}px`
  }

  const releaseCapture = () => {
    if (capture && pointerId >= 0 && "releasePointerCapture" in capture) {
      try {
        ;(capture as Element & { releasePointerCapture(id: number): void }).releasePointerCapture(pointerId)
      } catch {
        // The browser releases capture itself when the target is removed.
      }
    }
    capture = null
    pointerId = -1
  }

  const onPointerUp = (event: PointerEvent) => {
    if (!pending) return
    pending = false
    box.style.display = "none"
    releaseCapture()
    if (!active) {
      if (additive && toggleTarget) context.select(toggleTarget, { additive: true })
      else if (!toggleTarget) {
        context.select(null)
        context.setState({ scope: null })
      }
      return
    }
    active = false

    const left = Math.min(originX, event.clientX)
    const right = Math.max(originX, event.clientX)
    const top = Math.min(originY, event.clientY)
    const bottom = Math.max(originY, event.clientY)

    // Shift is a true toggle against the selection at pointerdown. Appending
    // would make dragging the same marquee twice unable to remove anything.
    const hits = swept(left, top, right, bottom, isDeepSelect(event))
    if (!additive) {
      context.selectMany(hits)
      return
    }
    const toggled = new Set(baseline)
    for (const hit of hits) {
      if (toggled.has(hit)) toggled.delete(hit)
      else toggled.add(hit)
    }
    context.selectMany([...toggled])
  }

  window.addEventListener("pointermove", onPointerMove, true)
  window.addEventListener("pointerup", onPointerUp, true)
  window.addEventListener("pointercancel", () => {
    pending = false
    active = false
    box.style.display = "none"
    releaseCapture()
  }, true)

  return { begin }
}
