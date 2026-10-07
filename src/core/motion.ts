/**
 * The motion decisions JavaScript has to make, because CSS cannot.
 *
 * Nearly all of this chrome's motion is a stylesheet declaration, which means
 * the reduced-motion blanket in `css/base.ts` clamps it and no module has to
 * think about it. Three things fall outside that: `scrollIntoView`'s `behavior`
 * is an argument rather than a property, `shell/resize.ts` animates a width
 * from JS a frame at a time, and both need the same question answered.
 *
 * Asking it in one place is the point. Written inline it was three copies of
 * the same guarded `matchMedia` call, and a fourth would have been written
 * without the guard.
 */

import { tokens } from "./tokens"

/**
 * Whether the reader has asked for less motion, right now.
 *
 * Read per call rather than cached at boot: the preference can change mid
 * session — a system setting, a devtools emulation — and a value captured once
 * would be wrong for the rest of the tab. The query is cheap.
 *
 * `matchMedia` is guarded because JSDOM does not implement it, and a missing
 * media query must never take the caller's real work down with it. Absent, the
 * answer is "no" — the same default a browser with no preference set gives.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
}

/**
 * The `behavior` for a `scrollIntoView` that brings something into view.
 *
 * `auto` rather than declining to scroll: someone who asked for less motion
 * asked for less TRAVEL, not for a control that silently stops working. The
 * element still arrives; it just arrives without the journey.
 */
export function smoothScroll(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth"
}

/**
 * How far a `.de-arrive` surface travels as it opens. The keyframe's own
 * default, restated here because the sign is decided in this file.
 */
const ARRIVE_RISE = 3

/** Which side of its trigger a surface was actually placed on. */
export type ArriveSide = "below" | "above"

/**
 * Which way it sits horizontally, for the one surface where that is a decision.
 *
 * `center` for anything anchored to a control, because a popover under a field
 * spans the field: there is no left or right corner nearer the trigger than the
 * middle of the edge. A CONTEXT menu is different — it hangs off a single point
 * — so its nearest corner is a real corner, and the layer menu is the only
 * caller that passes anything but the default.
 */
export type ArriveEdge = "left" | "right" | "center"

/**
 * Point a popover's entrance at the control that opened it.
 *
 * ## Why this is JavaScript and not CSS
 *
 * `.de-arrive` (`css/base.ts`) grows a card from `center top` and settles it
 * downward, which is right for a card under its trigger and backwards for one
 * above it. Which of the two happened is not knowable from a selector: it is
 * the outcome of a viewport-overflow test that each placer runs at open time
 * with a measured height. Only the placer knows, so only the placer can say.
 *
 * ## What it writes
 *
 * The two custom properties the keyframe reads, as a pair, because they are one
 * decision seen twice. `origin` is the edge the card grows out of and it is
 * always the edge NEAREST the trigger; `rise` starts the card a few pixels on
 * the far side of its final position so it settles TOWARD the trigger rather
 * than away from it. Get one and not the other and the card grows from the
 * right edge while drifting the wrong way, which reads worse than the bug this
 * replaces.
 *
 * Reduced motion needs no branch here. The blanket in `css/base.ts` clamps the
 * animation to nothing, and two custom properties nobody interpolates cost
 * nothing to have written.
 *
 * `core/tooltip.ts`'s `applySide` is the same function for the tooltip's own
 * pair of properties. They are not merged because the tooltip is a port of an
 * upstream component with its own constants and its own third property, and
 * folding them together would mean either this one grows a translate-x it never
 * uses or that one loses fidelity it is deliberately keeping.
 */
export function arriveFrom(
  surface: HTMLElement,
  side: ArriveSide,
  edge: ArriveEdge = "center"
): void {
  surface.style.setProperty(
    "--de-arrive-origin",
    `${edge} ${side === "above" ? "bottom" : "top"}`
  )
  surface.style.setProperty(
    "--de-arrive-rise",
    `${side === "above" ? ARRIVE_RISE : -ARRIVE_RISE}px`
  )
}

/**
 * The two dismissals the kit defines (MICRO-INTERACTIONS § 6 and § 8).
 *
 * A menu or popover fades to 0.99 over `exit` on `easeReveal`; a dialog fades
 * to 0.98 over `exit` on `easeExit`. Both are shorter than any entrance,
 * because dismissal hands control back.
 */
export type ExitKind = "menu" | "modal"

const EXIT_SCALE: Record<ExitKind, number> = { menu: 0.99, modal: 0.98 }
const EXIT_EASE: Record<ExitKind, string> = { menu: tokens.easeReveal, modal: tokens.easeExit }
const EXIT_MS = Number.parseFloat(tokens.duration.exit)
/** Above every surface the chrome stacks, and below nothing it has to paint over. */
const GHOST_Z = "2147483646"

/**
 * Plays a surface's exit on an inert COPY, so the surface itself can be gone
 * at the instant it is dismissed. Call it BEFORE hiding or removing the real
 * surface: the copy is frozen at the surface's current box.
 *
 * Every dismissible surface in this chrome has a contract that says "gone
 * now": a menu or dialog still in the document absorbs the next Escape, keeps
 * its rows in the tab order, and — for a modal — leaves a backdrop taking
 * clicks. So closing and painting are split. The real surface closes
 * synchronously; a clone that is `inert`, `aria-hidden`, id-less, role-less
 * and pointer-dead is pinned `position: fixed` over the box it occupied and
 * fades out. A modal's copy is a plain open `<dialog>` outside the top layer,
 * so it carries no backdrop and no modality.
 *
 * Web Animations rather than a stylesheet keyframe, for two reasons. The copy
 * is the only thing that ever animates out, so the keyframe has one owner here
 * rather than one per surface sheet. And an engine without `animate` — jsdom,
 * which every suite runs in — gets no copy at all, so "the menu is gone" stays
 * true of the whole document in a test the same way it is true to a reader.
 *
 * Reduced motion keeps the fade and drops the shrink: opacity is feedback, the
 * scale is travel.
 */
export function playExit(surface: HTMLElement, kind: ExitKind = "menu"): void {
  if (!surface.isConnected || typeof surface.animate !== "function") return
  const box = surface.getBoundingClientRect()
  if (!box.width || !box.height) return
  const origin = getComputedStyle(surface).transformOrigin

  const ghost = surface.cloneNode(true) as HTMLElement
  for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>("[id]")]) node.removeAttribute("id")
  for (const name of ["role", "aria-label", "aria-labelledby", "aria-describedby", "aria-modal"]) {
    ghost.removeAttribute(name)
  }
  // A typed draft is a property, not an attribute, so a clone would lose it.
  const typed = surface.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input")
  ghost.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input").forEach((field, index) => {
    if (typed[index]) field.value = typed[index].value
  })
  ghost.setAttribute("aria-hidden", "true")
  ghost.setAttribute("data-de-leaving", kind)
  ghost.inert = true
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    right: "auto",
    bottom: "auto",
    width: `${box.width}px`,
    height: `${box.height}px`,
    maxWidth: "none",
    maxHeight: "none",
    margin: "0",
    transform: "none",
    transformOrigin: origin,
    pointerEvents: "none",
    zIndex: GHOST_Z,
  })
  surface.after(ghost)

  const scale = prefersReducedMotion() ? 1 : EXIT_SCALE[kind]
  let gone = false
  const remove = (): void => {
    if (gone) return
    gone = true
    ghost.remove()
  }
  const animation = ghost.animate(
    [
      { opacity: 1, transform: "scale(1)" },
      { opacity: 0, transform: `scale(${scale})` },
    ],
    { duration: EXIT_MS, easing: EXIT_EASE[kind], fill: "forwards" }
  )
  animation.finished.then(remove, remove)
  // The backstop for a `finished` that never settles (a background tab).
  window.setTimeout(remove, EXIT_MS + 100)
}
