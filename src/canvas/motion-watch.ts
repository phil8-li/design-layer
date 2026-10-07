/**
 * What lets the selection painter stop its frame loop without ever trailing a
 * moving element.
 *
 * The painter reads geometry every frame because the app animates and a cached
 * rect drifts (see `./selection`). But a page at rest has nothing to drift, and
 * a frame loop over a still page was the whole of the editor's idle cost: a
 * rect read, a frame callback and a compositor commit sixty times a second, to
 * write the same numbers back. So the loop rests once the geometry has held
 * still, and this module is the list of everything that can move an element
 * without the store hearing of it, each one wired to wake the loop again on the
 * frame the movement starts:
 *
 * - DOM mutations outside the editor. React commits, inline styles a Motion
 *   frame loop writes, a class that starts a CSS transition, a `<style>` an
 *   edit preview rewrites. These answer `wakeNow`, which paints inside the
 *   mutation callback itself: a mutation made from the app's own frame callback
 *   would otherwise be drawn a frame late, because a frame requested from there
 *   lands in the NEXT frame.
 * - `Element.prototype.animate`, wrapped. A WAAPI animation starts with no
 *   mutation and no event, and Motion hands transform and opacity to WAAPI. Its
 *   first moving frame is the next one, which is where the woken loop runs.
 * - `transitionrun` and `animationstart`, for CSS motion started by `:hover` or
 *   `:focus` rather than by a mutation. They are dispatched before that frame's
 *   callbacks, so the frame they request is the same frame.
 * - Scroll, resize, pointer and key input, focus, image and font loads, and the
 *   tab becoming visible again.
 *
 * And `moving` answers the one case no event announces: an animation already
 * running when the loop wants to rest — in its delay, or holding on a step —
 * keeps it awake for as long as it can still move a box.
 */

/** Properties whose animation cannot move a border box, so cannot move an outline. */
const PAINT_ONLY = new Set([
  "opacity",
  "color",
  "background",
  "backgroundcolor",
  "bordercolor",
  "outlinecolor",
  "boxshadow",
  "textshadow",
  "filter",
  "backdropfilter",
  "clippath",
  "fill",
  "stroke",
  "visibility",
  "caretcolor",
  "accentcolor",
  "textdecorationcolor",
])
/** Transforms move only the element that wears them and what it contains. */
const TRANSFORMS = new Set(["transform", "translate", "rotate", "scale"])
const NOT_PROPERTIES = new Set(["offset", "computedOffset", "easing", "composite"])
/** Events that are news only when they happen in the app, not in the editor. */
const ELSEWHERE = new Set([
  "scroll",
  "wheel",
  "pointermove",
  // A press on the chrome moves nothing in the app by itself: what it causes
  // reaches the loop as a store change or a mutation, which wake it anyway.
  "pointerdown",
  "pointerup",
  "focusin",
  "load",
  "transitionrun",
  "animationstart",
])

/**
 * Attributes the editor writes on `<html>` that style only its own chrome: the
 * theme (its palette is `--de-*` properties nothing in the app reads) and the
 * input modality (focus rings). A theme switch animates the whole chrome, and
 * waking the loop for it drew the outline every frame of that animation for a
 * page that had not moved. The rest of what it writes there — the inset classes
 * above all — does move the app, and still wakes it.
 */
const STYLES_CHROME_ONLY = new Set(["data-de-theme", "data-de-modality"])
const cannotMove = (record: MutationRecord): boolean =>
  record.type === "attributes" &&
  record.target === document.documentElement &&
  STYLES_CHROME_ONLY.has(record.attributeName ?? "")

const ours = (node: Node | null): boolean => {
  const element = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)
  return Boolean(element?.closest("[data-designlayer]"))
}

/**
 * Whether any running animation outside the editor can move one of `tracked`.
 *
 * A spinner's rotation and a pulse's opacity run forever on plenty of pages,
 * and counting them would keep the loop awake on all of those; a transform is
 * only news for the boxes inside the element it moves, and paint-only
 * properties are never news. Anything else — width, margin, a custom property
 * that might feed either — counts, wherever it runs.
 */
export function moving(tracked: readonly Element[]): boolean {
  // Absent in the suites' DOM, which has nothing to animate.
  for (const animation of document.getAnimations?.() ?? []) {
    if (animation.playState !== "running") continue
    const effect = animation.effect as KeyframeEffect | null
    const target = effect?.target ?? null
    if (!target || ours(target)) continue
    const properties =
      typeof CSSTransition !== "undefined" && animation instanceof CSSTransition
        ? [animation.transitionProperty]
        : effect!.getKeyframes().flatMap((frame) => Object.keys(frame))
    for (const property of properties) {
      if (NOT_PROPERTIES.has(property)) continue
      const name = property.replace(/-/g, "").toLowerCase()
      if (PAINT_ONLY.has(name)) continue
      if (TRANSFORMS.has(name) && !tracked.some((element) => target.contains(element))) continue
      return true
    }
  }
  return false
}

/** Who hears a WAAPI start: the one installed painter's watch, or nobody. */
let onAnimate: ((element: Element) => void) | null = null

/**
 * Wraps `Element.prototype.animate` once per page, as transparently as a
 * wrapper can be: the same `this`, arguments and return value, and anything
 * thrown is the browser's own. The notification runs after the animation
 * exists and cannot throw into the app's call.
 */
function wrapAnimate(): void {
  const proto = Element.prototype as Element & { animate?: Element["animate"] }
  const animate = proto.animate
  if (!animate || (animate as { designlayer?: true }).designlayer) return
  const wrapped = function (this: Element, ...args: Parameters<Element["animate"]>): Animation {
    const animation = animate.apply(this, args)
    try {
      onAnimate?.(this)
    } catch {
      // A watch that failed must not fail the app's animation.
    }
    return animation
  }
  Object.defineProperty(wrapped, "designlayer", { value: true })
  proto.animate = wrapped
}

export interface MotionWatch {
  /** Start listening for movement; the loop calls this as it rests. */
  arm(): void
  /** Stop; the loop is running and sees movement for itself. */
  disarm(): void
}

/**
 * `wake` requests the next frame; `wakeNow` paints at once and then requests
 * it. Both are called only while armed, so a running loop pays nothing here
 * beyond one flag test per event.
 */
export function watchForMotion(wake: () => void, wakeNow: () => void): MotionWatch {
  let armed = false
  const onEvent = (event: Event): void => {
    if (!armed) return
    // A panel scrolling, the pointer over our own panels and our own fades move
    // nothing in the app. Keys are not filtered: Alt held with
    // focus in a panel still turns the measurement on.
    if (ELSEWHERE.has(event.type) && ours(event.target as Node | null)) return
    armed = false
    observer.disconnect()
    wake()
  }
  // Off `window` because the suites' DOM puts only a handful of globals on
  // `globalThis`, and this one is not among them.
  const observer = new window.MutationObserver((records) => {
    if (!armed) return
    for (const record of records) {
      if (ours(record.target) || cannotMove(record)) continue
      armed = false
      observer.disconnect()
      wakeNow()
      return
    }
  })

  onAnimate = (element) => {
    if (!armed || ours(element)) return
    armed = false
    observer.disconnect()
    wake()
  }
  wrapAnimate()

  const capture = { capture: true, passive: true }
  for (const type of [
    "scroll",
    "pointerdown",
    "pointermove",
    "pointerup",
    "wheel",
    "keydown",
    "keyup",
    "focusin",
    "load",
    "transitionrun",
    "animationstart",
  ]) {
    window.addEventListener(type, onEvent, capture)
  }
  window.addEventListener("resize", onEvent)
  window.addEventListener("blur", onEvent)
  document.addEventListener("visibilitychange", onEvent)
  document.fonts?.addEventListener("loadingdone", onEvent)

  return {
    arm() {
      if (armed) return
      armed = true
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
    },
    disarm() {
      if (!armed) return
      armed = false
      observer.disconnect()
    },
  }
}
