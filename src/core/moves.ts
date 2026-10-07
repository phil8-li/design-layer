/**
 * A move, driven here and written by the vendor.
 *
 * Drag and arrow-nudge settle as a `transform`, and `transform` has no utility
 * class for the translator to spell. For a long time that made every move
 * preview-only — except that it was not: the vendor ran its own move drag on
 * the same gesture, kept its own record of the move, and "Apply to code" wrote
 * that record as spacing classes. Two engines moved one element. The element
 * landed 6px past the pointer, and after an Apply the vendor's inline transform
 * sat on top of the class the source now carried, doubling the offset.
 *
 * Now the gesture is the editor's alone (`runtime/vendor-patch.mjs` switches
 * the vendor's drag off) and the vendor keeps doing the part only it can: the
 * writer registers the move in the vendor's store, and its batch builder turns
 * it into `moveSpacing` operations — margin or translate classes, chosen by the
 * parent's layout — exactly as its own drag did. Undo and redo replay through
 * the same write, so the store's delta always matches what is on screen, and a
 * move undone back to where it started has a zero delta, which the batch
 * builder skips.
 *
 * After an Apply the inline preview has to go once the source carries the
 * move, or the two add up. It goes when the element's class list changes —
 * the hot reload landing — and not at the click: removing it at the click
 * would snap the element back for the hundred-odd milliseconds before the
 * reload, and removing it on a timer would guess.
 */
import { isAngularHost } from "./angular"
import type { RewriteBridge } from "./bridge"
import { nthOfType } from "./element-target"
import type { SourceRef } from "./types"

interface Offset {
  x: number
  y: number
}

/** The record the vendor's store keeps, in the shape its own drag built. */
interface VendorMove {
  id: string
  componentRef: Omit<SourceRef, "componentName"> & { componentName: string }
  element: Element
  placeholder: null
  originalRect: DOMRect
  delta: { dx: number; dy: number }
  originalCssText: string
  existingTransform: string
  identity: SourceRef & { tagName: string }
  parentLayout: { display: string; flexDirection: string; elementPosition: string }
  nthOfType: number
}

interface Tracked {
  /** The offset the element had before its first move this session. */
  base: Offset
  /** The inline transform it had then, put back once the source carries the move. */
  inline: string
  delta: { dx: number; dy: number }
  /** Null until the element's source has resolved and the record is in the store. */
  move: VendorMove | null
}

const tracked = new WeakMap<Element, Tracked>()
/** Elements whose move is in the store, for the clean-up after an Apply. */
const registered = new Set<Element>()

/** The two store methods `runtime/vendor-patch.mjs` adds beside the vendor's own. */
type MoveStore = RewriteBridge["store"] & {
  clearCommitted?: () => void
  forgetMove?: (id: string) => void
}

/** The store can take a move, drop one, and be emptied after an Apply — a patched vendor. */
export function canWriteMoves(bridge: RewriteBridge): boolean {
  const store = bridge.store as MoveStore
  return (
    !isAngularHost() &&
    typeof store?.addMove === "function" &&
    typeof store.clearCommitted === "function" &&
    typeof store.forgetMove === "function"
  )
}

/**
 * A translate-only transform as an offset, or null when it also scales,
 * rotates or skews — which the spacing classes a move becomes cannot carry.
 */
export function translationOf(value: string): Offset | null {
  const text = value.trim()
  if (!text || text === "none") return { x: 0, y: 0 }
  const translate = /^translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)$/.exec(text)
  if (translate) return { x: Number(translate[1]), y: Number(translate[2]) }
  const matrix = /^matrix\(([^)]+)\)$/.exec(text)
  if (!matrix) return null
  const [a, b, c, d, e, f] = matrix[1].split(",").map(Number)
  if (a !== 1 || b !== 0 || c !== 0 || d !== 1 || !Number.isFinite(e) || !Number.isFinite(f)) return null
  return { x: e, y: f }
}

/**
 * Registers, or re-aims, the vendor's record of a move the editor just wrote.
 *
 * `before` is the transform the element showed before this write and `value`
 * the one it shows now. True when the move will reach source through the
 * store; false leaves the caller's preview-only path to record it, which is
 * what happens on an unpatched vendor, on Angular, and for a transform that
 * also rotates or scales. `resolve` is the writer's own source lookup, and
 * `stranded` its account of a move whose source never resolved.
 */
export function writeMove(
  bridge: RewriteBridge,
  element: Element,
  before: string,
  value: string,
  resolve: () => Promise<SourceRef | null>,
  stranded: () => void
): boolean {
  if (!canWriteMoves(bridge)) return false
  const to = translationOf(value)
  if (!to) return false
  let entry = tracked.get(element)
  if (!entry) {
    const from = translationOf(before)
    if (!from) return false
    entry = { base: from, inline: (element as HTMLElement).style?.transform ?? "", delta: { dx: 0, dy: 0 }, move: null }
    tracked.set(element, entry)
  }
  const current = entry
  current.delta = { dx: to.x - current.base.x, dy: to.y - current.base.y }
  const still = !current.delta.dx && !current.delta.dy
  if (current.move) {
    if (still) {
      // Undone back to where it started: out of the store, or the store goes on
      // reporting a change and Apply lights up to write nothing.
      ;(bridge.store as MoveStore).forgetMove?.(current.move.id)
      registered.delete(element)
      current.move = null
    } else {
      current.move.delta = current.delta
    }
    return true
  }
  if (still) return true
  void resolve().then((source) => {
    if (current.move || (!current.delta.dx && !current.delta.dy)) return
    if (!source?.filePath) {
      stranded()
      return
    }
    current.move = buildMove(element, source, current)
    try {
      bridge.store.addMove(current.move)
      registered.add(element)
    } catch {
      current.move = null
      stranded()
    }
  })
  return true
}

function buildMove(element: Element, source: SourceRef, entry: Tracked): VendorMove {
  const parent = element.parentElement
  const parentStyle = parent ? getComputedStyle(parent) : null
  return {
    id: crypto.randomUUID(),
    componentRef: { ...source },
    element,
    placeholder: null,
    originalRect: element.getBoundingClientRect(),
    // The same object the entry keeps, so a later write re-aims the record
    // without a second call into the store.
    delta: entry.delta,
    originalCssText: (element as HTMLElement).style?.cssText ?? "",
    existingTransform: entry.base.x || entry.base.y ? `translate(${entry.base.x}px, ${entry.base.y}px)` : "",
    identity: { ...source, tagName: element.tagName.toLowerCase() },
    parentLayout: {
      display: parentStyle?.display ?? "block",
      flexDirection: parentStyle?.flexDirection ?? "row",
      elementPosition: getComputedStyle(element).position,
    },
    nthOfType: nthOfType(element),
  }
}

/**
 * After an Apply has sent the store's operations: empty the store, and take
 * each moved element's preview down once its new classes arrive.
 *
 * Emptied at the send, as the journal is marked written at the send — this
 * lane has no reply to wait for. Left full, the store kept every operation an
 * Apply had already sent, the button stayed lit, and a second Apply wrote the
 * same changes again.
 */
export function settleAfterApply(bridge: RewriteBridge): void {
  const store = bridge.store as MoveStore
  try {
    store.clearCommitted?.()
  } catch {
    // An unpatched store has nothing of ours to empty.
  }
  for (const element of registered) {
    const entry = tracked.get(element)
    tracked.delete(element)
    if (!entry?.move || (!entry.delta.dx && !entry.delta.dy) || !element.isConnected) continue
    const html = element as HTMLElement
    const watch = new MutationObserver(() => {
      watch.disconnect()
      clearTimeout(giveUp)
      if (entry.inline) html.style.transform = entry.inline
      else html.style.removeProperty("transform")
    })
    watch.observe(element, { attributes: true, attributeFilter: ["class"] })
    // A write that never lands (refused, or the reload replaced the node)
    // leaves the preview where every other unwritten edit leaves it: on screen.
    const giveUp = setTimeout(() => watch.disconnect(), 10_000)
  }
  registered.clear()
}
