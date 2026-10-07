/**
 * Colour parsing and the swatch+hex pair every paint row is built from.
 *
 * Its own module because four sections need it and none of them should own it:
 * computed colours arrive as `rgb()` and a designer thinks in hex, so the
 * conversion has to happen in exactly one place or the rows disagree.
 */

import { clamp, el } from "../../core/dom"

/** `#abc`, `#aabbcc` and `rgb()/rgba()` in; six-digit hex or null out. */
export function toHex(color: string): string | null {
  const value = color.trim()
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value.slice(1).split("").map((digit) => digit + digit).join("").toLowerCase()}`
  }
  const match = value.match(/^rgba?\(([^)]+)\)$/i)
  if (!match) return null
  const parts = match[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number.parseFloat)
  if (parts.length < 3 || parts.some(Number.isNaN)) return null
  return `#${parts.map((n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0")).join("")}`
}

/**
 * Alpha channel of any colour string, 0–1. Opaque when absent.
 *
 * Two forms, because CSS has two. The legacy one puts alpha fourth in a
 * comma list (`rgba(12, 140, 233, 0.5)`); every modern colour function puts it
 * after a slash instead (`oklch(0.7 0.15 250 / 0.5)`, `color(display-p3 … / 50%)`),
 * and that form is what Chrome hands back for anything authored in a wide-gamut
 * space — it does NOT convert those to `rgb()`.
 *
 * Reading only the legacy form meant an element authored at half opacity
 * reported as fully opaque, so the opacity field printed 100 over a value of
 * 50. That is the quieter half of the same defect `withAlpha` in
 * `section-fill.ts` carries: this one misreads the colour, that one overwrites
 * it.
 */
export function alphaOf(color: string): number {
  const value = color.trim()
  const legacy = value.match(/^(?:rgba|hsla)\(([^)]+)\)$/i)
  if (legacy) {
    const parts = legacy[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 4) return 1
    const alpha = Number.parseFloat(parts[3])
    return Number.isNaN(alpha) ? 1 : clamp(alpha, 0, 1)
  }
  // The modern slash form, in whatever function: `… / <number>)` or `… / <pct>)`.
  const slash = value.match(/\/\s*([0-9.]+)(%?)\s*\)\s*$/)
  if (!slash) return 1
  const raw = Number.parseFloat(slash[1])
  if (Number.isNaN(raw)) return 1
  return clamp(slash[2] === "%" ? raw / 100 : raw, 0, 1)
}

/**
 * The channel letters of each colour function, for relative colour syntax.
 *
 * `rgb(from <c> r g b / 50%)` re-states a colour in terms of itself and changes
 * one component. Doing it in the colour's OWN function keeps it in its own
 * space — `oklch(from <c> l c h / .5)` stays oklch and stays wide-gamut, where
 * routing it through `rgb` would flatten a display-p3 blue to the nearest sRGB
 * one on the way past.
 */
const CHANNELS: Record<string, string> = {
  rgb: "r g b",
  rgba: "r g b",
  hsl: "h s l",
  hsla: "h s l",
  hwb: "h w b",
  lab: "l a b",
  lch: "l c h",
  oklab: "l a b",
  oklch: "l c h",
}

/**
 * The same colour at a different alpha, with everything else left alone.
 *
 * Returns `null` when the colour cannot be re-stated safely, and the caller is
 * expected to decline the write rather than substitute something. That is the
 * whole point of this function existing: the code it replaces fell back to
 * `#000000` for anything it could not parse, so dragging the opacity field on
 * an element authored in `oklch()`, `lab()` or `color(display-p3 …)` wrote
 * **black** into the user's source file — at every alpha, including 100%.
 *
 * `color()` carries its space as the first argument, so it is re-stated as
 * `color(from <c> <space> r g b / a)`; every other function names its own
 * space and takes the channels from the table above.
 */
export function restated(color: string, alpha: number): string | null {
  const value = color.trim()
  const fn = value.match(/^([a-z]+)\(/i)?.[1].toLowerCase()
  if (!fn) return null
  const a = clamp(alpha, 0, 1)
  if (fn === "color") {
    const space = value.match(/^color\(\s*(?:from\s+\S+\s+)?([a-z0-9-]+)/i)?.[1]
    return space ? `color(from ${value} ${space} r g b / ${a})` : null
  }
  const channels = CHANNELS[fn]
  return channels ? `${fn}(from ${value} ${channels} / ${a})` : null
}

/*
 * THE WELL IS A CLASS NOW, NOT EIGHT INLINE DECLARATIONS.
 *
 * It was the only control in the inspector with no state feedback whatever: no
 * hover, no press, no focus beyond the UA's own ring — and, because every
 * declaration was inline, a pseudo-class rule was not merely missing but
 * impossible to write. An inline style has nowhere to hang a `:hover`.
 *
 * The geometry stays here because `swatch()` is used standalone by three
 * sections that compose their own layout, and a size is the one thing those
 * call sites reason about. Everything that has a STATE moved to
 * `.de-color-well` in `css/panels.ts`, where the rest of the panel's controls
 * keep theirs.
 */
const SWATCH_STYLE = ["width:20px", "height:20px", "flex:none", "padding:0"].join(";")

/** Standalone colour well, for a row that composes its own layout. */
export function swatch(value: string, label: string, onCommit: (hex: string) => void): HTMLInputElement {
  const node = el("input", {
    type: "color",
    class: "de-color-well",
    "aria-label": label,
    /*
     * `<input type=color>` can hold nothing but a six-digit hex, so a colour
     * this module cannot convert has no honest value to show and falls back to
     * black. That is a display compromise and not the data-loss one `withAlpha`
     * used to make: the well only ever COMMITS on `input`, which fires when the
     * user picks a colour, so a fallback shown here can never be written unless
     * the user chooses it. `data-de-unparsed` marks the case for the stylesheet.
     */
    value: toHex(value) ?? "#000000",
    ...(toHex(value) ? {} : { "data-de-unparsed": "" }),
    style: SWATCH_STYLE,
  }) as HTMLInputElement
  node.addEventListener("input", () => onCommit(node.value))
  return node
}

export interface ColorFieldOptions {
  id?: string
  label: string
  /** Computed colour string; anything unparseable still shows as raw text. */
  value: string
  onCommit(value: string): void
}

export function colorField(options: ColorFieldOptions): HTMLElement {
  const hex = toHex(options.value)
  const text = el("input", {
    type: "text",
    "aria-label": options.label,
    value: hex ?? options.value,
    "data-de-field": options.id,
  }) as HTMLInputElement

  const well = swatch(options.value, `${options.label} swatch`, (next) => {
    text.value = next
    options.onCommit(next)
  })

  const commitText = () => {
    const next = text.value.trim()
    if (!next) return
    const parsed = toHex(next)
    if (parsed) well.value = parsed
    options.onCommit(next)
  }
  text.addEventListener("change", commitText)
  text.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    commitText()
    text.blur()
  })

  /*
   * NO LEADING LABEL, because the swatch already is one.
   *
   * The row read `[swatch] Color #ffffff`, which names the thing twice before
   * it gets to the value: a filled well is the universal mark for "this is a
   * colour", and printing the word beside it spent a fifth of the field on
   * saying so again. Figma's paint rows are a swatch and a value with nothing
   * between them, and the caption above the group carries the noun.
   *
   * Only the DRAWING is dropped, not the name — the swatch and the text input
   * both keep their `aria-label`, so the pair is still announced as "Color" and
   * "Color swatch". `options.label` is therefore still required, and is now
   * exactly what it says: the accessible name.
   */
  const field = el("div", { class: "de-field", style: "flex:1" }, [text])
  return el("div", { class: "de-row" }, [well, field])
}
