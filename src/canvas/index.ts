/**
 * Canvas lane entry: hover feedback, click-to-select, keyboard navigation, and
 * the selection frame.
 *
 * Every gesture here answers "what did the user point at?" through
 * `core/resolve`, never on its own. Direct manipulation (drag, resize,
 * snapping, measurement, marquee) is layered on by the modules this installs,
 * so each concern owns one file.
 */

import { isCanvasElement, isChrome } from "../core/dom"
import { canvasAction, isDeepSelect, NUDGE, ownsCanvasKeys } from "../core/keymap"
import { getResolver, isLayerCandidate, toSelectable } from "../core/resolve"
import { isLocked, selectionOwnsInput } from "../core/store"
import { createWriter } from "../core/writer"
import type { EditorContext } from "../core/context"
import type { LayerElement } from "../core/types"
import { dipHoverOutline, installSelectionFrame, releaseHoverDip } from "./selection"
import { installTransform, translateBy } from "./transform"
import { installSnapping } from "./snapping"
import { installMarquee } from "./marquee"
import { installLayerMenu } from "./layer-menu"

export function installCanvas(context: EditorContext): void {
  const writer = createWriter(context.bridge)
  const resolver = getResolver(context.bridge)

  installSelectionFrame(context)
  installTransform(context, writer)
  installSnapping(context)
  installLayerMenu(context)

  // `select()` early-returns when the element is already the whole selection,
  // so a re-click can never refresh a source ref that a code edit has moved.
  // `selectMany` carries no such guard and a one-element set is the same write.
  const selectOne = (element: LayerElement) => context.selectMany([element])

  // The last pointer position, so a modifier press can re-answer the question
  // with the pointer standing still. `pointerHit` is undefined when the last
  // move was not hit-tested (the selection lane was standing down) and null
  // over chrome, where a modifier has nothing to preview.
  let pointerX = 0
  let pointerY = 0
  let pointerHit: Element | null | undefined = undefined

  const hitFor = (event: { target: EventTarget | null; clientX: number; clientY: number }) => {
    if (isCanvasElement(event.target)) return event.target
    return resolver.hitStack(event.clientX, event.clientY)[0] ?? null
  }

  /*
   * The topmost layer under a point, for a modifier pressed before any move
   * was hit-tested. `hitStack` sorts parent first, so its head is the app root
   * — which is what a Cmd press over the toolbar used to outline.
   */
  const topHit = (x: number, y: number): Element | null => {
    for (const raw of document.elementsFromPoint(x, y)) {
      if (isChrome(raw)) return null
      if (isLayerCandidate(raw)) return raw
    }
    return null
  }

  /*
   * The last answer, reused while the pointer stays on the same leaf.
   *
   * `visualLayer` climbs with a rect and a sibling filter per step, and a
   * pointer crossing one word fires a dozen moves that all ask the same
   * question. The answer depends on geometry as well as the arguments, so
   * anything that moves boxes without moving the pointer — a scroll, a resize,
   * a refresh after a write — drops it.
   */
  let memo: { hit: Element; deep: boolean; scope: Element | null; found: LayerElement | null } | null = null
  const forget = () => {
    memo = null
  }
  context.onRefresh(forget)
  window.addEventListener("scroll", forget, { capture: true, passive: true })
  window.addEventListener("resize", forget, { passive: true })

  /** The one answer both the outline and the click use. */
  const targetFor = (hit: Element | null, deep: boolean): LayerElement | null => {
    if (!hit) return null
    const scope = context.getState().scope
    let found: LayerElement | null
    if (memo && memo.hit === hit && memo.deep === deep && memo.scope === scope) found = memo.found
    else {
      found = resolver.resolve(hit, scope, deep)
      memo = { hit, deep, scope, found }
    }
    // A locked layer is invisible to the pointer, hover included. The tree does
    // not ask this question, which is the only way back out of the lock.
    return isLocked(found) ? null : found
  }

  const marquee = installMarquee(context)

  const setHovered = (hovered: Element | null) => {
    if (context.getState().hovered !== hovered) context.setState({ hovered })
  }

  /**
   * Meta/Control changes what a click would select, so the outline follows the
   * key even with the pointer standing still — and because there is no pointer
   * travel to carry the change, it is dipped rather than cut. `dipHoverOutline`
   * argues the mechanism; what belongs here is when it is worth spending.
   *
   * Only a swap between two live boxes is. Arriving from nothing and leaving to
   * nothing are already fades — the outline's own `display` transition carries
   * both — so dipping either of those would only spend `snap` in front of a
   * fade that was about to happen anyway. A press that resolves to the element
   * already outlined, which is most of them on a leaf, moves nothing and gets
   * nothing: a modifier that blinked the outline whether or not it had changed
   * the answer would be worse than the teleport this is fixing.
   */
  const previewDeepSelect = (event: KeyboardEvent) => {
    if (pointerHit === undefined) pointerHit = topHit(pointerX, pointerY)
    // Over the toolbar, a pin or a handle there is nothing to preview.
    if (pointerHit === null) return
    const target = targetFor(pointerHit, isDeepSelect(event))
    const current = context.getState().hovered
    if (target === current) return
    if (target && current) dipHoverOutline()
    setHovered(target)
  }

  const onPointerMove = (event: PointerEvent) => {
    pointerX = event.clientX
    pointerY = event.clientY
    // Gates first: in interactive mode, Notes or canvas view the editor costs
    // the host's own pointer traffic nothing, and over chrome nothing is
    // hit-tested at all — `elementsFromPoint` there forced a layout on every
    // move across a panel that had just rebuilt.
    if (!selectionOwnsInput()) {
      pointerHit = undefined
      return
    }
    if (isChrome(event.target)) {
      pointerHit = null
      return
    }
    pointerHit = hitFor(event)
    // The pointer outranks the keyboard on this question: it has just answered
    // it against a position a dip in flight was frozen before, and the travel
    // is its own transition. A no-op unless a dip is actually running.
    releaseHoverDip()
    setHovered(targetFor(pointerHit, isDeepSelect(event)))
  }

  const onPointerDown = (event: PointerEvent) => {
    if (isChrome(event.target)) return
    if (!selectionOwnsInput()) return
    // Right-click belongs to the layer-stack menu, which selects for itself.
    if (event.button !== 0) return

    const deep = isDeepSelect(event)
    const hit = hitFor(event)
    const target = targetFor(hit, deep)
    if (marquee.begin(event, target)) return
    if (!target) {
      context.select(null)
      context.setState({ scope: null })
      return
    }

    // Shift is a toggle, not an append: clicking a selected element again with
    // shift held takes it back out of the set.
    if (event.shiftKey) context.select(target, { additive: true })
    else selectOne(target)
    // Deep select is a one-shot bypass of the scope rule, so it re-points the
    // scope at the layer it landed in — otherwise the next plain click undoes it.
    if (deep) {
      context.setState({ scope: resolver.layerParent(target) })
    } else {
      const held = context.getState().scope
      if (held && (!held.isConnected || !hit || !held.contains(hit))) {
        context.setState({ scope: resolver.layerParent(target) })
      }
    }
  }

  /** Double-click descends exactly one level and takes the scope with it. */
  const onDoubleClick = (event: MouseEvent) => {
    if (isChrome(event.target)) return
    if (!selectionOwnsInput()) return
    const hit = hitFor(event)
    if (!hit) return

    const state = context.getState()
    const primary = state.selection[0]?.element ?? null
    const base = primary && primary.contains(hit) ? primary : resolver.resolve(hit, state.scope)
    if (!base) return
    const target = resolver.resolve(hit, base)
    // Drilling into the layer you are already on is not a drill: without this
    // the scope would advance on a press that changed nothing.
    if (!target || target === base) return
    context.setState({ scope: base })
    selectOne(target)
    event.preventDefault()
    event.stopPropagation()
  }

  const nudge = (event: KeyboardEvent) => {
    const state = context.getState()
    const delta = NUDGE[event.key]
    if (!delta || state.selection.length === 0) return
    event.preventDefault()
    const step = event.shiftKey ? 10 : 1
    for (const entry of state.selection) {
      const value = translateBy(entry.element, delta[0] * step, delta[1] * step)
      writer.applyStyles(entry, [{ property: "transform", value }], `Nudge ${step}px`)
    }
    scheduleRefresh()
  }

  /*
   * One refresh per frame for a held arrow. Auto-repeat fires about thirty
   * keydowns a second, and every refresh re-flattens the layers tree and
   * rebuilds the inspector for a transform that cannot change either; the
   * panels only need the last one before the next paint.
   */
  let refreshFrame = 0
  const scheduleRefresh = () => {
    if (refreshFrame) return
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0
      context.refresh()
    })
  }

  const selectAt = (element: Element | null, scope: Element | null) => {
    const target = toSelectable(element)
    if (!target) return
    selectOne(target)
    context.setState({ scope })
  }

  /**
   * Delete, and then have nothing selected.
   *
   * Figma leaves the selection empty rather than guessing at a neighbour, and
   * so does this — but the clear is not a UX choice here, it is a correctness
   * one. A `Selection` holds the element, the overlay's frame is drawn from its
   * box, and the layers tree walks it; leaving a detached node in the store
   * would keep every one of those describing something that is no longer on the
   * page. The scope goes with it for the same reason, when it was inside what
   * just went away.
   */
  const deleteSelection = () => {
    const state = context.getState()
    if (!state.selection.length) return
    const scope = state.scope
    writer.applyDelete(state.selection)
    context.select(null)
    if (scope && !scope.isConnected) context.setState({ scope: null })
    context.bridge.refreshGeometry()
    context.refresh()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!selectionOwnsInput()) return
    // A held modifier changes what a click would select, so the outline has to
    // follow it even while the pointer is stationary.
    if (event.key === "Meta" || event.key === "Control") {
      pressedHere.add(event.key)
      previewDeepSelect(event)
      return
    }
    if (!ownsCanvasKeys(event)) return

    const action = canvasAction(event)
    if (!action) return
    if (action === "nudge") {
      nudge(event)
      return
    }
    if (action === "delete") {
      // Unconditionally, even with nothing selected: Backspace is the browser's
      // back-navigation key, and a canvas that let it through on an empty
      // selection would throw away the whole session.
      event.preventDefault()
      deleteSelection()
      return
    }

    const state = context.getState()
    const primary = state.selection[0]?.element ?? null

    // Escape clears. It does not select the parent — that is Shift+Enter.
    if (action === "deselect") {
      if (!primary && !state.scope) return
      // Cancelled even though keydown has no default to cancel, because
      // `defaultPrevented` is how the shell's Escape fallback is told the key
      // was spent: it collapses the editor only on a press nothing else took,
      // and a deselect that stayed silent would deselect and collapse at once.
      event.preventDefault()
      context.select(null)
      context.setState({ scope: null })
      return
    }

    // Tab only belongs to the canvas while something is selected; otherwise it
    // is still the browser's focus traversal and the panels' way in.
    if (!primary) return
    event.preventDefault()

    if (action === "select-child") {
      selectAt(resolver.layerChildren(primary)[0] ?? null, primary)
      return
    }
    if (action === "select-parent") {
      const parent = resolver.layerParent(primary)
      selectAt(parent, parent ? resolver.layerParent(parent) : null)
      return
    }

    const siblings = resolver.layerSiblings(primary)
    const index = siblings.indexOf(primary)
    if (index === -1 || siblings.length < 2) return
    const step = action === "next-sibling" ? 1 : -1
    selectAt(siblings[(index + step + siblings.length) % siblings.length], state.scope)
  }

  /*
   * The modifiers whose press this lane saw, so only those releases preview.
   *
   * A release whose press went elsewhere is not a modifier the designer changed
   * over the canvas: it is the tail of Cmd+. bringing the editor back, or of
   * Cmd+Tab returning to the window. Answering it outlined whatever the stale
   * pointer position resolved to — the very outline `setChromeHidden` clears on
   * the way back, painted again a keystroke later.
   */
  const pressedHere = new Set<string>()
  window.addEventListener("blur", () => pressedHere.clear())

  const onKeyUp = (event: KeyboardEvent) => {
    if (!pressedHere.delete(event.key)) return
    if (!selectionOwnsInput()) return
    previewDeepSelect(event)
  }

  // Swallow app activation while the editor owns the page: clicking a button to
  // select it must not also navigate. Capture on `window` runs before the
  // vendor overlay's own document-level guards, so ours wins the gesture.
  //
  // Interactive mode is exactly the absence of this line, which is why it is
  // the mode's whole point rather than a convenience: nothing else in the
  // editor stops the app from responding to a click.
  const onClick = (event: MouseEvent) => {
    if (!selectionOwnsInput()) return
    if (isChrome(event.target) || !isCanvasElement(event.target)) return
    event.preventDefault()
    event.stopPropagation()
  }

  window.addEventListener("pointermove", onPointerMove, true)
  window.addEventListener("pointerdown", onPointerDown, true)
  window.addEventListener("dblclick", onDoubleClick, true)
  window.addEventListener("click", onClick, true)
  window.addEventListener("keydown", onKeyDown, true)
  window.addEventListener("keyup", onKeyUp, true)
}
