/**
 * A glyph that changes into another glyph, without being replaced by it.
 *
 * ## Why this is a module and not four call sites
 *
 * Replacing an `<svg>` — `clear(host)` then append, which is what every glyph
 * state change in this chrome used to do — gives the browser no previous state
 * to interpolate from. The new node enters at its final appearance, so there is
 * no animation, only a jump. A glyph that is momentarily absent also lets the
 * label beside it slide, which on a 24px pill is the one motion nobody asked
 * for.
 *
 * Stacking both drawings in one sized box and crossfading between them fixes
 * both: the row geometry never learns that anything happened, and the change is
 * something the eye can follow.
 *
 * That argument was written once, in `inspector/tab-annotations.ts`, next to a
 * local helper that only that file could reach — while the Code tab's copy
 * button, four files away, did the clear-and-append the comment warns about.
 * Two copy buttons in one product confirming two different ways is exactly the
 * failure the note describes. The helper is here now so there is one answer.
 *
 * ## What varies between call sites
 *
 * Two things, and nothing else. A confirmation swaps to a tick in `success` —
 * on a plain pill the colour is the only channel saying the press LANDED rather
 * than merely registered. A TOGGLE swaps between two weights of its own glyph
 * and must keep `currentColor`, because the surface under it is already saying
 * which state it is in and a green pressed tool would be a second, contrary
 * claim. Hence `tint`.
 *
 * The motion itself is not a parameter: it is `.de-swap` in
 * `css/annotations.ts`, including the reduced-motion variant that drops the
 * scale and keeps the fade.
 */

import { icon, type IconName, type IconSize, type IconWeight } from "./icons"
import { el } from "./dom"
import { tokens } from "./tokens"

export interface SwapMark {
  node: HTMLElement
  /** Show the second glyph (`true`) or the resting one. */
  show(done: boolean): void
}

export interface SwapMarkOptions {
  /** Box and glyph size. Defaults to `icon.marker`, the panel rung. */
  size?: IconSize
  /** The glyph swapped TO. Defaults to `Check`, i.e. a confirmation. */
  done?: IconName
  /** Weight of the resting glyph. */
  restWeight?: IconWeight
  /** Weight of the swapped-to glyph — `filled` is what a toggle wants. */
  doneWeight?: IconWeight
  /**
   * `success` for a confirmation, `inherit` for a toggle. Inherit is expressed
   * as a class rather than an inline style so the stylesheet keeps both the
   * colour and the reduced-motion rule in one place.
   */
  tint?: "success" | "inherit"
}

export function swapMark(resting: IconName, options: SwapMarkOptions = {}): SwapMark {
  const size = options.size ?? tokens.icon.marker
  const rest = icon(resting, size, options.restWeight)
  const done = icon(options.done ?? "Check", size, options.doneWeight)
  rest.classList.add("de-swap-rest")
  done.classList.add("de-swap-done")
  const node = el(
    "span",
    {
      class: options.tint === "inherit" ? "de-swap de-swap--plain" : "de-swap",
      "aria-hidden": "true",
      // The box is `icon.marker` in the stylesheet, which is right for the three
      // panel call sites and wrong for the toolbar's 16px squares. Written
      // inline only when it differs, so the common case stays in CSS.
      ...(size === tokens.icon.marker ? {} : { style: `width:${size}px;height:${size}px` }),
    },
    [rest, done]
  )
  return {
    node,
    show(showDone: boolean): void {
      node.classList.toggle("de-swap--done", showDone)
    },
  }
}
