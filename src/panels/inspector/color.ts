/**
 * Colour parsing and the swatch+hex pair every paint row is built from.
 *
 * Its own module because four sections need it and none of them should own it:
 * computed colours arrive as `rgb()` and a designer thinks in hex, so the
 * conversion has to happen in exactly one place or the rows disagree.
 */

import { clamp, el, round } from "../../core/dom"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { optionsStore } from "../../options/store"
import { styledSection } from "../../options/panel"
import type { StyleScope } from "../../options/scopes"
import { emptySection, miniButton, numberField, propRow } from "./field"
import type { SectionContext } from "./index"

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
const swatchStyle = (size: number) => [`width:${size}px`, `height:${size}px`, "flex:none", "padding:0"].join(";")

/**
 * Standalone colour well, for a row that composes its own layout. `size` is
 * 20 standalone; a paint well passes the 16px icon rung so the swatch sits
 * inside the 24px well with 4px around it, as Figma's does.
 */
export function swatch(
  value: string,
  label: string,
  onCommit: (hex: string) => void,
  size = 20
): HTMLInputElement {
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
    style: swatchStyle(size),
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

/* ---------- paint rows: Fill, Stroke and Effects share these ---------- */

/**
 * The same colour at a different alpha, as the shortest string that round-trips,
 * or `null` when it cannot be produced without inventing a colour.
 *
 * sRGB colours go through hex, which round-trips exactly. Anything else is
 * re-stated in its own space by `restated`. The old fallback was
 * `toHex(color) ?? "#000000"`, which wrote black into the source of any element
 * authored in `oklch()` or `color(display-p3 …)`; a caller that gets `null`
 * declines the write instead.
 */
export function withAlpha(color: string, alpha: number): string | null {
  const hex = toHex(color)
  if (hex) {
    if (alpha >= 1) return hex
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
    return `rgba(${r},${g},${b},${round(alpha, 3)})`
  }
  return restated(color, round(alpha, 3))
}

/** `FFF`, `ffffff` or `#abc` typed into a hex cell, as a CSS colour; else the text as typed. */
function typedColor(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  const bare = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)
  if (bare) return `#${bare[1].toLowerCase()}`
  // A named colour or a function is kept as written, if the browser accepts it.
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return text
  return CSS.supports("color", text) ? text : null
}

export interface PaintRowOptions {
  /** Field-id stem: `fill`, `stroke`, `type.color`'s row uses `text`. */
  id: string
  /** Accessible name of the swatch and the value: "Fill color". */
  label: string
  /** The colour the row shows, which may be a parked one. */
  value: string
  /** Whether the paint is on the element now; a parked one dims and disables opacity. */
  live: boolean
  /** The token field for this paint; the row prints an editable hex when it is null. */
  binding: HTMLElement | null
  /** `data-de-field` for the hex input, when a test or focus memory names it. */
  hexId?: string
  onColor(value: string): void
  /** The opacity half of the well. Omitted for a paint whose alpha has no honest write. */
  alpha?: { onPreview?(alpha: number): void; onCommit(alpha: number): void }
  /** The eye. */
  visibility?: { onToggle(): void }
  /** The `−`, in column 3. `null` leaves column 3 empty (text has no "no colour"). */
  remove?: { label: string; onClick(event: Event): void } | null
}

/**
 * One paint, laid out as Figma's: a joined well `[swatch + hex | opacity %]`
 * and the eye across columns 1-2, the `−` in column 3, so the remove lines up
 * with every other row's trailing action and with the header's `+`.
 *
 * `.de-paint-row` stays on the cluster the binding sits in, because the token
 * tests find a paint by that class.
 */
export function paintRow(options: PaintRowOptions): HTMLElement {
  const alpha = alphaOf(options.value)
  const shown = toHex(options.value)?.slice(1).toUpperCase() ?? options.value
  const well = swatch(options.value, options.label, (hex) => options.onColor(hex), tokens.icon.action)

  /*
   * Editable, as Figma's hex is. It used to be an inert span, so with no token
   * stocked there was no way to type a colour at all. The class stays
   * `.de-paint-value`, which the sparse-catalog test looks for.
   */
  const hex = el("input", {
    type: "text",
    class: "de-paint-value",
    "aria-label": options.label,
    title: options.value,
    value: shown,
    spellcheck: "false",
    "data-de-field": options.hexId ?? `${options.id}.hex`,
  }) as HTMLInputElement
  const commitHex = () => {
    const next = typedColor(hex.value)
    if (!next || next === `#${shown.toLowerCase()}`) {
      hex.value = shown
      return
    }
    options.onColor(next)
  }
  hex.addEventListener("change", commitHex)
  hex.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      commitHex()
    } else if (event.key === "Escape") {
      event.preventDefault()
      hex.value = shown
      hex.blur()
    }
  })

  const opacity = options.alpha
    ? numberField({
        id: `${options.id}.alpha`,
        // An empty strip, not a letter: Figma prints `100 %` with nothing in
        // front, and the strip still scrubs, so the drag survives the letter.
        label: "",
        title: `${options.label} opacity (%)`,
        value: alpha * 100,
        min: 0,
        max: 100,
        suffix: "%",
        disabled: !options.live,
        onPreview: options.alpha.onPreview ? (next) => options.alpha?.onPreview?.(next / 100) : undefined,
        onCommit: (next) => options.alpha?.onCommit(next / 100),
      })
    : null
  opacity?.classList.add("de-paint-alpha")

  const eye = options.visibility
    ? miniButton({
        label: options.live ? `Hide ${options.label.toLowerCase()}` : `Show ${options.label.toLowerCase()}`,
        glyph: icon(options.live ? "Eye" : "EyeOff", tokens.icon.action),
        onClick: () => options.visibility?.onToggle(),
      })
    : null

  const remove = options.remove
    ? miniButton({
        label: options.remove.label,
        glyph: icon("Minus", tokens.icon.action),
        danger: true,
        onClick: (event) => options.remove?.onClick(event),
      })
    : null

  const joined = el("div", { class: "de-paint-well" }, [well, options.binding ?? hex, opacity])
  const cluster = el(
    "div",
    { class: options.live ? "de-paint-row" : "de-paint-row de-paint-row--hidden" },
    [joined, eye]
  )
  return propRow({ id: `${options.id}.paint`, cells: [cluster], trailing: remove })
}

/**
 * A paint section with nothing to show: Figma's dimmed header and `+`.
 *
 * Two things keep the body. `extras` are rows that are not the paint but live
 * here (a ring, an outline, an icon's SVG fill, a shadow or motion token), and
 * those stay reachable. Saved styles for the scope keep the styles toggle,
 * because the empty header has nowhere else to open them from.
 */
export function emptyPaintSection(
  context: SectionContext,
  scope: StyleScope,
  title: string,
  add: HTMLElement,
  extras: Array<Node | null> = []
): HTMLElement {
  const present = extras.filter((node): node is Node => node !== null)
  const saved = optionsStore(context.editor).stylesFor(context.selection.key, scope).length > 0
  if (!present.length && !saved) return emptySection(title, add)
  return styledSection(context, scope, title, el("div", { class: "de-stack" }, present), add)
}
