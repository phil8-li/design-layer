/**
 * Taking a row out of a list so that the list is seen to close.
 *
 * ## The moment this is for
 *
 * Resolve a note, delete one, remove a library: the row ceases to exist and the
 * list snaps shut around the hole. These are terminal acts — slightly
 * destructive ones — and their only confirmation was that something the user
 * was looking at is no longer there, which is indistinguishable from a render
 * that failed. Everything around them already animates; the endings did not.
 *
 * ## Why the height is measured here and not left to CSS
 *
 * A row's height is its content's, so there is no value for `max-height` to
 * animate FROM. Pinning the measured height for one frame and then collapsing
 * from it is the only version of this that works for a row of unknown size, and
 * it is two frames of work rather than a layout mode change — `grid-template-
 * rows: 0fr` would do it declaratively but requires an extra wrapper element
 * inside every row, and these rows are rebuilt wholesale by their panels.
 *
 * ## What the caller keeps
 *
 * The removal itself. This resolves once the row has finished leaving and the
 * caller does the delete — usually by writing to a store whose subscription
 * rebuilds the list anyway, which is why nothing here removes the node: doing
 * both would race a rebuild that is already on its way.
 *
 * Reduced motion is handled twice over, and it takes both halves. The blanket
 * in `css/base.ts` clamps the transition to 0.01ms, and `settleMs` drops the
 * timer that waits for it — without the second, a reader who asked for less
 * motion would get no animation and still wait out its full duration, which is
 * the delay without the effect.
 */

import { tokens } from "./tokens"
import { prefersReducedMotion } from "./motion"

/** Parsed once: the ramp's own value, not a number to keep in agreement. */
const LEAVE_MS = Number.parseFloat(tokens.duration.reveal)

/**
 * How long to wait for a transition that may have been clamped to nothing.
 *
 * The blanket in `css/base.ts` takes every duration in the chrome to 0.01ms
 * under `prefers-reduced-motion`, so the CSS here finishes instantly — but the
 * timer that waits for it was a parsed token and did not, so a reader who asked
 * for less motion got no animation AND the full 180ms of wall clock before the
 * row was actually removed. The delay was the only thing left of the effect.
 *
 * Read per call rather than captured, for the reason `motion.ts` gives: the
 * preference can change mid-session.
 */
const settleMs = (): number => (prefersReducedMotion() ? 0 : LEAVE_MS)

/**
 * Opens a freshly-built group from nothing to its own height.
 *
 * ## Why this is a function and not `grid-template-rows: 0fr → 1fr`
 *
 * Pressing the per-corner radius, per-side padding or precision toggle makes
 * the inspector grow by one to four rows in a single frame, and everything
 * below jumps. That is a disclosure — the canonical case for a height
 * transition — and the declarative version needs a wrapper element that
 * PERSISTS across the change. The Design tab has no such thing: it clears and
 * rebuilds all thirteen sections on every commit, so the group handed to this
 * function is always a new node with no previous state.
 *
 * So the collapsed state is written inline at BUILD time, before the node is
 * ever in the document, and released on the next frame. Doing it the other way
 * round — mount, measure, collapse, expand — shows one painted frame at full
 * height, which is the jump this exists to remove, followed by an apology for
 * it.
 *
 * ## It must be asked for, not inferred
 *
 * The caller checks `takeJustExpanded`, so this runs on the render that follows
 * the user pressing the toggle and on no other. Without that the group would
 * re-open on every rebuild — that is, on every scrub commit and every keystroke
 * in a field — which is the same animation firing as punctuation for edits that
 * have nothing to do with it.
 */
export function revealGroup(node: HTMLElement): void {
  node.style.height = "0px"
  node.style.overflow = "hidden"
  node.style.opacity = "0"
  requestAnimationFrame(() => {
    const target = node.scrollHeight
    const done = (): void => {
      node.classList.remove("de-entering")
      node.style.height = ""
      node.style.overflow = ""
      node.style.opacity = ""
    }
    // No layout means no height to open to — JSDOM, or a panel that has never
    // painted. Release the inline styles and let the group simply be there.
    if (target === 0) return done()
    node.classList.add("de-entering")
    node.style.height = `${target}px`
    node.style.opacity = "1"
    setTimeout(done, settleMs())
  })
}

/**
 * Collapses `row` to nothing, then resolves. `null` when there is nothing to
 * play, so the caller can finish the job in the SAME TASK.
 *
 * The null is the important half of this signature. A delete that always
 * returned a promise would push the store write into a microtask even where no
 * animation was possible, which turns a synchronous action asynchronous for
 * every caller, every test and every keyboard user — a behaviour change smuggled
 * in by a fade that is not running. Where the row can close, the caller waits;
 * where it cannot, nothing about the delete changes.
 *
 * Safe to call on a row that is already leaving — the class guard makes a
 * double-click on Delete one departure rather than two overlapping ones.
 */
export function leaveRow(row: HTMLElement): Promise<void> | null {
  if (row.classList.contains("de-leaving")) return null
  /*
   * `offsetHeight` is zero wherever there is no layout — JSDOM, and a row in a
   * panel that has never been painted. There is no height to collapse from, so
   * there is nothing to wait for.
   */
  const height = row.offsetHeight
  if (height === 0) return null

  /*
   * One gap disappears with the row, and the row cannot zero it — a flex `gap`
   * belongs to the container. `.de-leaving` cancels it with a negative bottom
   * margin, and this is the only place that knows how big it is.
   *
   * Zero when the row is the list's only child: N items have N-1 gaps, so the
   * last one out takes none with it, and cancelling a gap that was never there
   * would pull the list's floor up by four pixels.
   */
  const list = row.parentElement
  const gap = list && list.children.length > 1 ? getComputedStyle(list).rowGap : "0px"
  row.style.setProperty("--de-leave-gap", gap === "normal" ? "0px" : gap)
  row.style.height = `${height}px`
  row.classList.add("de-leaving")
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      row.style.height = "0px"
      /*
       * A timer rather than `transitionend`, because `transitionend` does not
       * fire for a transition that never starts — a reduced-motion clamp, a row
       * already at zero, a panel hidden mid-gesture — and a list that silently
       * stops removing rows is a worse failure than one that removes them a
       * frame early.
       */
      setTimeout(resolve, settleMs())
    })
  })
}
