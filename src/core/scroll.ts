/**
 * Keeping a panel where the reader left it across a rebuild.
 *
 * Several surfaces in this chrome are redrawn wholesale on every write: the
 * inspector's Design tab empties its host and re-runs eleven sections after any
 * committed property, the outbox rebuilds both of its lists whenever a note or
 * an edit lands. That is a deliberate trade — one render path, no diffing — and
 * it costs exactly two things. Focus is the first, and
 * `panels/inspector/index.ts` has restored that since the beginning. Scroll
 * position is the second, and it was not restored at all.
 *
 * ## Why an emptied panel loses its scroll, and why that is not obvious
 *
 * Removing the children does not itself move the scroll position; the browser
 * does, the next time anything forces layout while the container is empty. A
 * scroller whose content is gone has a maximum scroll offset of zero, so the
 * engine clamps `scrollTop` to zero, and refilling it a microsecond later does
 * not undo the clamp — the number is already lost. Something always forces that
 * layout mid-rebuild: the inspector's sections read computed geometry off the
 * selected element while they build their rows, which is a flush.
 *
 * Measured against a live app before the fix: scroll the Design tab down to
 * Typography (666px), change the weight, and the panel is back at the top with
 * the control you just used off screen. Tweaking one property is the single
 * most repeated gesture in the editor, so this fired constantly.
 *
 * ## Two mechanisms, and the pin is the one that matters
 *
 * `hold()` pins the CONTENT's height before the caller empties it, so the
 * scroller never sees a container it has to clamp and the position is never
 * lost in the first place. Nothing to restore means no scroll event, which
 * matters more than it sounds: `inspector/token-picker.ts` closes an open
 * popover on any capture-phase scroll, so a chrome that fixed this by scrolling
 * back would dismiss the picker every time the panel repainted under it.
 *
 * `release()` then drops the pin and writes the remembered offset back, which
 * is a no-op whenever the pin did its job. It is kept as the backstop for the
 * cases the pin cannot cover — a host that measured zero because its panel was
 * hidden, and JSDOM, which has no layout and so has no height to pin — and it
 * costs one assignment that the engine skips when the value already matches.
 *
 * Both halves clamp themselves: a rebuild that produces a SHORTER panel than
 * the one before it settles at the new bottom rather than at a remembered
 * offset that no longer exists, because that is what assigning a too-large
 * `scrollTop` does.
 */

/** What a caller holds between emptying a container and refilling it. */
export interface ScrollHold {
  /** Restores the scroller, and drops the height pin. Safe to call once. */
  release(): void
}

const RELEASED: ScrollHold = { release: () => {} }

const SCROLLS = new Set(["auto", "scroll", "overlay"])

/**
 * The pane `content` actually scrolls inside.
 *
 * Found by its own `overflow-y` rather than by a class, because the four
 * surfaces that rebuild wholesale sit at three different depths: the Design
 * tab's host IS the pane's only child, and the two Design-system sections are
 * grandchildren of theirs, sharing a wrapper with each other.
 *
 * The immediate parent is the fallback, and it is the right one twice over.
 * Every pane in this chrome wraps its body directly, so it is the correct
 * answer for two of the three call sites without any lookup at all — and it is
 * the answer JSDOM gets, where a suite that never injects the stylesheet would
 * otherwise find no scroller anywhere and quietly assert nothing.
 */
export function scrollerFor(content: HTMLElement): HTMLElement | null {
  for (let node = content.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (SCROLLS.has(overflow)) return node
  }
  return content.parentElement
}

/**
 * Remembers where the scroller is, and stops `content` collapsing under it.
 *
 * `content` is the element about to be emptied and refilled. `scroller` is the
 * ancestor that actually scrolls, and a caller that already knows which one
 * that is should say so rather than pay for the walk above.
 *
 * Returns an inert hold when there is nothing to scroll, so a caller never has
 * to branch: the inspector's Design tab is emptied in the same code path
 * whether or not it has ever been mounted.
 *
 * An EMPTY `content` is one of those cases, and it is checked before anything
 * is measured. A first render has no offset to lose — a container with nothing
 * in it already sits at zero — and the walk, the `scrollTop` read and the
 * `offsetHeight` read are each a forced layout, landing in the middle of every
 * panel's boot paint for nothing.
 */
export function holdScroll(
  content: HTMLElement | null | undefined,
  scroller?: HTMLElement | null
): ScrollHold {
  if (!content || !content.firstChild) return RELEASED
  const pane = scroller === undefined ? scrollerFor(content) : scroller
  if (!pane) return RELEASED

  const top = pane.scrollTop
  const left = pane.scrollLeft
  /*
   * `offsetHeight` rather than `getBoundingClientRect().height`: the pin is
   * written straight back out as a pixel `min-height`, and the border-box
   * integer is the value that round-trips. A fractional rect height would leave
   * the panel a sub-pixel taller or shorter for the length of the rebuild,
   * which is a sub-pixel the scroller could still clamp against.
   */
  // A pane at its origin has nothing to lose: a clamp cannot take it below
  // zero, and scroll anchoring stands down at the origin, so the rebuild leaves
  // it where it is with no pin. Skipping the pin skips its `offsetHeight` read
  // and the release's `scrollTop` read, a forced layout each, on every repaint
  // of a panel nobody has scrolled — which is most repaints.
  if (top === 0 && left === 0) return RELEASED
  const height = content.offsetHeight
  const pinned = height > 0
  const previousMinHeight = content.style.minHeight
  if (pinned) content.style.minHeight = `${height}px`

  let done = false
  return {
    release() {
      if (done) return
      done = true
      // The pin comes off FIRST, so the restore below is measured against the
      // rebuilt panel's real height and clamps to it rather than to the height
      // of the panel that was there before.
      if (pinned) content.style.minHeight = previousMinHeight
      if (pane.scrollTop !== top) pane.scrollTop = top
      if (pane.scrollLeft !== left) pane.scrollLeft = left
    },
  }
}
