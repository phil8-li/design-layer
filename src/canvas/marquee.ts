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
import { activeScope, clearSelection } from "../core/store"
import type { EditorContext } from "../core/context"
import type { LayerElement } from "../core/types"
import { trackPointer, type PointerTrack } from "./gesture"

interface MarqueeController {
  /** Claims empty-canvas presses and Shift presses reserved for marquee/toggle. */
  begin(event: PointerEvent, target: LayerElement | null): boolean
}

/** What a press carries from pointerdown to release. */
interface Sweep {
  originX: number
  originY: number
  /** Shift: toggle against `baseline` rather than replace the selection. */
  additive: boolean
  /** What a Shift click with no travel toggles; null over empty canvas. */
  toggleTarget: LayerElement | null
  /** The selection at pointerdown, which a Shift sweep toggles against. */
  baseline: LayerElement[]
  track: PointerTrack
}

/*
 * The machine, moved only by `transition()`; the box is drawn exactly while
 * the state is `sweeping`:
 *
 *   idle     --press on empty canvas, or with Shift----> pressed
 *   pressed  --travel reaches DRAG_THRESHOLD-----------> sweeping   (box shown)
 *   pressed  --release---------------------------------> idle       (Shift toggles the target; else clears)
 *   sweeping --release---------------------------------> idle       (selects what the box touched)
 *   pressed | sweeping --cancel(reason)----------------> idle       (selection untouched)
 *
 * Cancel is every early end `gesture.ts` knows: Escape, blur, a lost capture
 * or release, `pointercancel`, the editor standing down.
 */
type MarqueeState = { kind: "idle" } | { kind: "pressed"; sweep: Sweep } | { kind: "sweeping"; sweep: Sweep }

export function installMarquee(context: EditorContext): MarqueeController {
  const resolver = getResolver(context.bridge)
  const box = el("div", { class: "de-marquee", style: "display:none" })
  context.slots.overlay.append(box)

  let state: MarqueeState = { kind: "idle" }

  const transition = (next: MarqueeState) => {
    state = next
    const display = next.kind === "sweeping" ? "block" : "none"
    if (box.style.display !== display) box.style.display = display
  }

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
    // React replaces DOM nodes constantly, and a drilled scope that has since
    // been unmounted makes `layerChildren` return nothing — a marquee that
    // selects zero elements for no reason the user can see. `activeScope`
    // reads such a scope as none, so the sweep falls back to the live root.
    const within = activeScope() ?? resolver.scopeRoot()

    if (!deep) return resolver.layerChildren(within).filter((node) => touched(node, l, t, r, b))

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
    visit(resolver.layerChildren(within))
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
    if (state.kind !== "idle") state.sweep.track.end()
    const capture = event.target instanceof Element ? event.target : null
    transition({
      kind: "pressed",
      sweep: {
        originX: event.clientX,
        originY: event.clientY,
        additive: event.shiftKey,
        toggleTarget: target,
        baseline: context.getState().selection.map((entry) => entry.element),
        track: trackPointer(event, capture, { move, release, cancel: () => transition({ kind: "idle" }) }),
      },
    })
    return true
  }

  function move(event: PointerEvent): void {
    if (state.kind === "idle") return
    const { sweep } = state
    if (state.kind === "pressed") {
      if (!sweep.track.crossed(event)) return
      transition({ kind: "sweeping", sweep })
    }
    event.preventDefault()
    const dx = event.clientX - sweep.originX
    const dy = event.clientY - sweep.originY
    box.style.transform = `translate(${Math.min(sweep.originX, event.clientX)}px, ${Math.min(sweep.originY, event.clientY)}px)`
    box.style.width = `${Math.abs(dx)}px`
    box.style.height = `${Math.abs(dy)}px`
  }

  function release(event: PointerEvent): void {
    const ending = state
    if (ending.kind === "idle") return
    transition({ kind: "idle" })
    const { sweep } = ending
    if (ending.kind === "pressed") {
      if (sweep.additive && sweep.toggleTarget) context.select(sweep.toggleTarget, { additive: true })
      else if (!sweep.toggleTarget) clearSelection()
      return
    }

    const left = Math.min(sweep.originX, event.clientX)
    const right = Math.max(sweep.originX, event.clientX)
    const top = Math.min(sweep.originY, event.clientY)
    const bottom = Math.max(sweep.originY, event.clientY)

    // Shift is a true toggle against the selection at pointerdown. Appending
    // would make dragging the same marquee twice unable to remove anything.
    const hits = swept(left, top, right, bottom, isDeepSelect(event))
    if (!sweep.additive) {
      context.selectMany(hits)
      return
    }
    const toggled = new Set(sweep.baseline)
    for (const hit of hits) {
      if (toggled.has(hit)) toggled.delete(hit)
      else toggled.add(hit)
    }
    context.selectMany([...toggled])
  }

  return { begin }
}
