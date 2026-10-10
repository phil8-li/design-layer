/**
 * Binding one CSS property to a design-system token, as a control any section
 * can drop into a group it already owns.
 *
 * ## Why this is a module and not a section any more
 *
 * It was a section: `Design system`, a stack of thirty labelled pickers — fill
 * colour, text colour, text style, corner radius, shadow, gap, padding — sitting
 * between Component and Position. Every row in it named a CSS property that
 * some OTHER section of the inspector already had a control for, so the panel
 * asked the same question twice in two places and answered it in two different
 * shapes. A designer changing the text colour of a heading met `Text color` in
 * one section and `Color` in another, thirty rows apart, both showing
 * `#1b2e5d`, neither mentioning the other. Which one wrote a token and which
 * one wrote a literal was not discoverable from either.
 *
 * That is the whole reason the section is gone. A token is not a category of
 * design decision — it is an ANSWER to the question a control already asks, and
 * Figma treats it exactly so: the paint row shows the style's name where the hex
 * would be, the type block shows the text style above the size and weight, and
 * there is no "design system" panel anywhere, because every panel is one.
 *
 * So the machinery moved here and the rows moved out, each into the section that
 * owns its property:
 *
 *   fill-color, svg-fill                       -> Fill
 *   text-color, text-style                     -> Typography
 *   stroke-color, ring-color, outline-color,
 *   svg-stroke                                 -> Stroke
 *   corner-radius (+ the four corners)         -> Appearance
 *   shadow, motion-duration                    -> Effects
 *   gap, padding, margin (+ sides and axes)    -> Layout
 *   icon-size                                  -> Icon
 *
 * Nothing about WHAT a row does changed in the move. The matching, the
 * uncertainty hint, the inert-token hint, the custom raw value and the
 * `stocked` rule are the same code, called from a different place.
 *
 * ## The two shapes, and when to use which
 *
 * `tokenRow` is the captioned block the old section drew: a title, the field,
 * and the hints under it. A section reaches for it when the axis has no control
 * of its own — `margin`, a ring colour, a motion duration.
 *
 * `tokenControl` is the bare field, for the case that matters more: a section
 * that ALREADY draws this property folds the binding into its own row, so there
 * is one control rather than two. Fill's paint row puts it where the hex text
 * was; Typography's Color group puts it beside the swatch. When a token is
 * bound the field reads its name, and when none is it reads the plain value —
 * which is the string the control it replaced was showing anyway.
 *
 * Both answer `null` when the design system stocks NO token for the axis, and
 * that is what keeps a project with three colours from growing eight empty
 * pickers. A caller must treat null as "draw your own control and nothing
 * else", which is why every call site passes the result through `el()`'s
 * null-skipping children rather than testing it.
 */

import type { DesignSystemToken } from "../../core/config"
import {
  authoredTokenMatches,
  computedTokenMatches,
  landedValue,
  normalizedCssValue,
  plainValue,
  primaryFontFamily,
  textStyleSignature,
  tokenCssProperty,
  tokenDetail,
  tokenDisplayName,
  tokenNameParts,
  tokenPreviewKind,
  tokenStyleWrites,
  tokenSwatchCss,
  tokensForProperty,
  type DesignSystemMatch,
  type DesignTokenProperty,
} from "../../core/design-system"
import { el } from "../../core/dom"
import { toSourceRef } from "../../core/bridge"
import { elementKey } from "../../core/store"
import { activeDesignSystem } from "../../libraries/store"
import type { LayerElement, Selection } from "../../core/types"
import { group } from "./field"
import { tokenField, type TokenChoice, type TokenPreview } from "./token-picker"
import type { SectionContext } from "./index"

export const SIDES = ["top", "right", "bottom", "left"] as const
export const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"] as const

/** Tailwind v4's registered initial for `--tw-ring-shadow`: present, but not a ring. */
const RING_SHADOW_NONE = "0 0 #0000"

/**
 * Why a token this row lists is offered but inert. The engine only knows "no
 * writes"; the sentence belongs here, before the click, because a toast
 * afterwards is how a designer ends up trying all nine springs one at a time.
 * Worded as a design fact — a bounce that cannot arrive — rather than as the
 * mechanism, which is the machine's business and not the designer's.
 */
const UNWRITABLE_REASON: Partial<Record<DesignTokenProperty, string>> = {
  "motion-duration": "only a spring with no bounce arrives intact",
}

/**
 * The three axes with no honest raw form, so their picker offers none.
 *
 * `text-style` is four declarations and `icon-size` is two: one typed string
 * cannot say which of them it is, and a field that quietly wrote only the first
 * would ship half a style while reporting success. `motion-duration` is the
 * sharper case — it deliberately refuses seven of its nine tokens, because a
 * spring that bounces cannot survive the trip into `transition-duration`, and a
 * typed number there is exactly the bypass that honesty exists to prevent.
 * Everything else is a single declaration, which is what a typed value is.
 */
const NO_RAW_FORM = new Set<DesignTokenProperty>(["text-style", "icon-size", "motion-duration"])

/** Computed style reports no value for a shorthand, so these read back from their parts. */
const LONGHANDS: Partial<Record<DesignTokenProperty, readonly string[]>> = {
  "corner-radius": CORNERS.map((corner) => `border-${corner}-radius`),
  padding: SIDES.map((side) => `padding-${side}`),
  margin: SIDES.map((side) => `margin-${side}`),
}

interface RowSpec {
  property: DesignTokenProperty
  label: string
  target: Selection
  inlineValue: string
  computedValue: string
}

/**
 * The shape a hand-typed value takes on this axis.
 *
 * Shown in the empty field rather than said in prose: the picker's own rule is
 * that nothing code-shaped reaches the screen as text, and an example a
 * designer overwrites the moment they type is not text they have to read.
 */
function customPlaceholder(property: DesignTokenProperty): string {
  if (tokenPreviewKind(property) === "color") return "#0a0a0a"
  if (property === "shadow") return "0 1px 2px #00000033"
  return "12px"
}

export function directText(element: Element): boolean {
  return Array.from(element.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
  )
}

function uniform(values: string[]): string | null {
  return values.every((value) => value === values[0]) ? values[0] : null
}

function number(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function hasUtility(element: Element, stem: string): boolean {
  return Array.from(element.classList).some((name) => new RegExp(`^${stem}(?:-|$)`).test(name))
}

/** Only a flex or grid box has a gap to bind; on anything else the row would be inert. */
export function laysOutChildren(computed: CSSStyleDeclaration): boolean {
  return /^(inline-)?(flex|grid)$/.test(computed.display)
}

function describeElement(context: SectionContext, element: LayerElement): Selection {
  const info = context.editor.bridge.elementInfo(element)
  const componentName = info?.componentName || element.tagName.toLowerCase()
  return {
    element,
    tagName: element.tagName.toLowerCase(),
    componentName,
    source: toSourceRef(info),
    key: elementKey(element, componentName, info?.lineNumber ?? 0),
  }
}

/**
 * An icon-only host edits its `<svg>`: `fill` and `stroke` paint nothing on the
 * `<button>` around a glyph. Selecting the icon directly is the other way in,
 * and both arrive at the same target because both are a `LayerElement`.
 */
export function iconTarget(context: SectionContext): Selection | null {
  const { selection } = context
  const element = selection.element
  if (element.tagName === "IMG" || element.getAttribute("role") === "img") return selection
  const children = Array.from(element.children)
  const svg = children.length === 1 && children[0] instanceof SVGSVGElement ? children[0] : null
  return svg && !directText(element) ? describeElement(context, svg) : null
}

/** `fill`/`stroke` paint nothing on an HTML box, so those rows need a real SVG. */
export function svgTarget(context: SectionContext): Selection | null {
  if (context.selection.element.closest("svg")) return context.selection
  const icon = iconTarget(context)
  return icon && icon.element instanceof SVGElement ? icon : null
}

function specFor(
  property: DesignTokenProperty,
  label: string,
  target: Selection,
  style: CSSStyleDeclaration
): RowSpec {
  const css = tokenCssProperty(property)
  const parts = LONGHANDS[property]
  const value = parts
    ? uniform(parts.map((name) => style.getPropertyValue(name).trim()))
    : style.getPropertyValue(css).trim()
  return {
    property,
    label,
    target,
    inlineValue: target.element.style.getPropertyValue(css),
    computedValue: value ?? "mixed",
  }
}

/**
 * The value this row reports the element to have.
 *
 * The element's own inline declaration first; the computed value only when
 * there is none. Computed is a race this row loses. `transition-colors` sits on
 * nearly every interactive component in a Tailwind app, so the render that
 * follows a write still computes the colour the element is transitioning FROM —
 * measured `rgb(37, 41, 46)` in the very render whose inline style already read
 * `rgb(255, 0, 102)` — and a value one step stale matches the token that was
 * bound before the edit. That is how a hand-typed colour went on reading back as
 * `Background/Secondary` while the button in front of it was already pink.
 *
 * An inline declaration is also the truer answer once it exists: it is not
 * interpolated, and it is what the cascade settles on.
 *
 * `text-style` is exempt. Its `inlineValue` is four declarations joined for the
 * authored matcher, not a value, and its computed form is a signature built on
 * purpose.
 */
function reportedValue(spec: RowSpec): string {
  if (spec.property === "text-style") return spec.computedValue
  return spec.inlineValue.trim() || spec.computedValue
}

function matchFor(spec: RowSpec): DesignSystemMatch[] {
  const classes = Array.from(spec.target.element.classList)
  const authored = authoredTokenMatches(spec.property, spec.inlineValue, classes)
  if (authored.length) return authored
  // One style read for the row, not one per token variable: the declaration is
  // live, and every variable on the axis is read off the same element.
  //
  // Against the MERGED catalog, like the authored match above and the picker
  // below it. Matching the host's catalog alone left an enabled library's
  // token listed as an option while the closed field, sitting on exactly its
  // value through a plain class or Angular CSS, read back as a raw colour.
  const style = getComputedStyle(spec.target.element)
  return computedTokenMatches(
    spec.property,
    reportedValue(spec),
    activeDesignSystem(),
    (variable) => {
      const raw = style.getPropertyValue(variable).trim()
      return raw ? normalizedCssValue(spec.property, raw) : ""
    },
    // A token's own literal, spelled the way the browser computes it: a
    // library's `#9dd2ff` against a computed `rgb(157, 210, 255)` never matched,
    // so an element painted with a library colour in a page that does not
    // declare the library's variables read back as a bare hex.
    (literal) => normalizedCssValue(spec.property, literal)
  )
}

/** A token's own preview, in the one shape the picker knows how to draw. */
function tokenPreview(spec: RowSpec, token: DesignSystemToken): TokenPreview {
  const kind = tokenPreviewKind(spec.property)
  if (kind === "text") {
    const shape = (token.values.default ?? {}) as Record<string, unknown>
    return { kind: "text", fontSize: typeof shape.fontSize === "number" ? shape.fontSize : 12 }
  }
  if (kind === "radius") {
    return { kind: "radius", px: typeof token.values.default === "number" ? token.values.default : 0 }
  }
  const css = kind === "color" ? tokenSwatchCss(token) : null
  return css ? { kind: "color", css } : { kind: "none" }
}

/** The element's own value in the same shape, for a field with nothing bound. */
function valuePreview(spec: RowSpec): TokenPreview {
  const kind = tokenPreviewKind(spec.property)
  const value = reportedValue(spec)
  if (kind === "color") {
    // The reported value, not a resolved literal: a `var()` here still paints,
    // because the swatch lives in the same document the app is themed in.
    return value === "mixed" ? { kind: "none" } : { kind: "color", css: value }
  }
  if (kind === "text") return { kind: "text", fontSize: number(value.split("|")[0]) || 12 }
  if (kind === "radius") return { kind: "radius", px: number(value) }
  return { kind: "none" }
}

function tokenChoice(spec: RowSpec, token: DesignSystemToken, writable: boolean): TokenChoice {
  const { group, leaf } = tokenNameParts(token)
  return {
    id: token.id,
    group,
    leaf,
    name: tokenDisplayName(token),
    preview: tokenPreview(spec, token),
    detail: tokenDetail(spec.property, token),
    disabled: !writable,
  }
}

/**
 * What the field says when it will not name a token.
 *
 * Silence here loses the useful half. A theme-scoped alias and a hand-typed
 * colour look identical once the field falls back to the element's own value,
 * and the candidates are exactly what a designer needs to decide which one they
 * are looking at. Said as a design fact — who decides, or that two tokens agree
 * — rather than as the evidence trail the old row printed.
 */
function uncertaintyHint(matches: DesignSystemMatch[]): string {
  if (matches.length < 2 && !matches.some((match) => match.ambiguous)) return ""
  const names = matches.map((match) => tokenDisplayName(match.token)).join(" or ")
  return matches.some((match) => match.ambiguous)
    ? `Could be ${names}. The theme decides`
    : `Could be ${names}. They share this value`
}

/** The field, plus the two hints that explain what it will and will not do. */
interface BuiltRow {
  field: HTMLElement
  /** Two candidates, or a theme-scoped alias — said under the field. */
  uncertain: string
  /** Tokens this element cannot carry, named rather than silently missing. */
  inert: string
}

function build(context: SectionContext, spec: RowSpec, hidePreview = false): BuiltRow {
  const tokens = tokensForProperty(spec.property)
  // One derivation of "can this token be written here": the row that offers it,
  // the hint that explains it and the commit that performs it all read this map,
  // so a token can never be pickable and unwritable at the same time.
  const writes = new Map(tokens.map((token) => [token.id, tokenStyleWrites(spec.property, token)]))
  const matches = matchFor(spec)
  // One exact match is a binding. An alias that changes meaning across theme or
  // scope is not, and neither are two candidates, so the field falls back to the
  // element's own value rather than naming a token it cannot vouch for.
  const bound = matches.length === 1 && !matches[0].ambiguous ? matches[0].token.id : ""
  const field = tokenField({
    id: `design-system.${spec.property}`,
    title: spec.label,
    hidePreview,
    selectedId: bound,
    choices: tokens.map((token) => tokenChoice(spec, token, (writes.get(token.id) ?? []).length > 0)),
    fallback: {
      preview: valuePreview(spec),
      text:
        reportedValue(spec) === "mixed"
          ? "Mixed"
          : plainValue(spec.property, reportedValue(spec)) || "—",
    },
    onCommit: (id) => {
      const token = tokens.find((entry) => entry.id === id)
      const styles = writes.get(id)
      if (!token || !styles?.length) return
      // A reset the element already satisfies is left out, so picking a role
      // on plain text does not write `font-style: normal` into its source.
      const computed = getComputedStyle(spec.target.element)
      const needed = styles
        .filter((write) => !write.reset || computed.getPropertyValue(write.property).trim() !== write.value)
        .map((write) => ({ property: write.property, value: landedValue(write, computed) }))
      context.writer.applyStyles(spec.target, needed, `Apply ${tokenDisplayName(token)}`)
      context.invalidate()
    },
    // The one declaration this axis owns, written straight. The Tailwind layer
    // already carries an off-scale value through as an arbitrary class, so this
    // reaches source the same way a token does rather than staying a preview.
    custom: NO_RAW_FORM.has(spec.property)
      ? undefined
      : {
          placeholder: customPlaceholder(spec.property),
          onCommit: (raw) => {
            context.writer.applyStyles(
              spec.target,
              [{ property: tokenCssProperty(spec.property), value: raw }],
              `Set ${spec.label.toLowerCase()} to ${raw}`
            )
            context.invalidate()
          },
        },
  })

  const unwritable = tokens.filter((token) => !(writes.get(token.id) ?? []).length)
  return {
    field,
    uncertain: bound ? "" : uncertaintyHint(matches),
    inert: unwritable.length
      ? `Unavailable because ${UNWRITABLE_REASON[spec.property] ?? "this element has nothing to carry them"}: ${unwritable
          .map((token) => tokenDisplayName(token))
          .join(", ")}`
      : "",
  }
}

export interface TokenBindingOptions {
  /**
   * The element to write to, when it is not the selected one.
   *
   * `svg-fill` and `icon-size` are the cases: both are about the `<svg>` inside
   * the button you selected, not about the button. Resolve one with
   * `svgTarget` / `iconTarget` and pass it here.
   */
  target?: Selection
  /**
   * That target's computed style. Required with `target` and ignored without
   * it — reading the selection's style for another element's property is how a
   * row ends up reporting the wrong value confidently.
   */
  computed?: CSSStyleDeclaration
  /**
   * A text style's four declarations, joined, for the authored matcher.
   *
   * Only `text-style` needs it: the axis has no single CSS property, so there
   * is nothing for `specFor` to read and the caller assembles the evidence.
   */
  inlineValue?: string
  /** Same exception, for the computed half — a signature, not a value. */
  computedValue?: string
  /**
   * Drop the field's leading swatch, for a caller that already drew one.
   *
   * Only the paint rows pass it, and `token-picker.ts` carries the reasoning:
   * a fill row is `[well] [value]`, so a field that draws its own chip puts two
   * swatches of the same colour side by side and makes the dead one look as
   * clickable as the live one.
   */
  hidePreview?: boolean
}

function resolveSpec(
  context: SectionContext,
  property: DesignTokenProperty,
  label: string,
  options: TokenBindingOptions
): RowSpec {
  const target = options.target ?? context.selection
  const computed = options.target ? options.computed ?? getComputedStyle(target.element) : context.computed
  const spec = specFor(property, label, target, computed)
  return {
    ...spec,
    inlineValue: options.inlineValue ?? spec.inlineValue,
    computedValue: options.computedValue ?? spec.computedValue,
  }
}

/**
 * The bare field, for a section folding the binding into a row it already draws.
 *
 * `null` when the design system stocks nothing on this axis, which is the
 * signal to draw the plain control alone. The hints `tokenRow` prints are NOT
 * returned here on purpose: a caller composing its own row has nowhere
 * predictable to put two sentences, and the uncertainty hint in particular
 * belongs under the field rather than beside it. A section that needs them
 * should use `tokenRow`.
 */
export function tokenControl(
  context: SectionContext,
  property: DesignTokenProperty,
  label: string,
  options: TokenBindingOptions = {}
): HTMLElement | null {
  if (!tokensForProperty(property).length) return null
  return build(context, resolveSpec(context, property, label, options), options.hidePreview).field
}

/**
 * The captioned block: a title, the field, and the hints.
 *
 * What the old `Design system` section drew for every axis, and now what a
 * section draws for an axis it has no control of its own for. `null` when the
 * design system stocks nothing here.
 */
export function tokenRow(
  context: SectionContext,
  property: DesignTokenProperty,
  label: string,
  options: TokenBindingOptions = {}
): HTMLElement | null {
  if (!tokensForProperty(property).length) return null
  const built = build(context, resolveSpec(context, property, label, options))
  /*
   * `group()`, and the caption RANK is the whole reason it is worth saying.
   *
   * These rows drew their own `.de-layout-group-title` while they lived in a
   * section of their own, which was right there: everything around them was
   * another token row, so the titles were peers of each other. Out here every
   * neighbour is a `group()` caption — `Font`, `Color`, `Opacity`, `Corner
   * radius` — drawn at `.de-group-caption`: caption size, body weight, dim ink.
   * `.de-layout-group-title` is body size, section weight, full-strength ink,
   * the rank `Auto layout` uses for a whole feature. Keeping it would make
   * `Ring color` shout over `Font` in the same column, and a reader would
   * reasonably conclude the loud one was a heading and the quiet ones its
   * contents.
   *
   * So the caption is not a style this module chooses any more; it is the one
   * the host section already uses, which is what makes a token row read as one
   * more control rather than as an insert from somewhere else.
   */
  return group(
    label,
    built.field,
    built.uncertain ? el("div", { class: "de-hint" }, [built.uncertain]) : null,
    built.inert ? el("div", { class: "de-hint" }, [built.inert]) : null
  )
}

/**
 * The hints alone, for a caller that put the field somewhere of its own.
 *
 * Fill and Typography fold the field into an existing row and would otherwise
 * drop the two sentences that say the binding is uncertain, or that some of the
 * tokens on offer cannot be written here. Losing those is exactly the honesty
 * the picker was built around, so they are available separately rather than
 * being the price of a tidier row.
 */
export function tokenHints(
  context: SectionContext,
  property: DesignTokenProperty,
  label: string,
  options: TokenBindingOptions = {}
): HTMLElement | null {
  if (!tokensForProperty(property).length) return null
  const built = build(context, resolveSpec(context, property, label, options))
  if (!built.uncertain && !built.inert) return null
  return el("div", { class: "de-stack" }, [
    built.uncertain ? el("div", { class: "de-hint" }, [built.uncertain]) : null,
    built.inert ? el("div", { class: "de-hint" }, [built.inert]) : null,
  ])
}

/**
 * The evidence a `text-style` binding is matched on.
 *
 * Exported because Typography is the only caller and the shape is not obvious:
 * the axis binds four declarations at once, so its "inline value" is those four
 * joined for the authored matcher and its "computed value" is a signature built
 * by `textStyleSignature`. A caller assembling either by hand would get a row
 * that silently never matches.
 */
export function textStyleEvidence(
  element: Element,
  computed: CSSStyleDeclaration
): { inlineValue: string; computedValue: string } {
  const letterSpacing = Number.parseFloat(computed.letterSpacing)
  return {
    inlineValue: ["font-size", "line-height", "font-weight", "letter-spacing"]
      .map((property) => (element as HTMLElement).style.getPropertyValue(property))
      .join(" "),
    // The family and style ride after the signature: they are what separate
    // two styles sharing all four numbers, such as a body and a code style.
    computedValue: [
      textStyleSignature({
        fontSize: number(computed.fontSize),
        lineHeight: number(computed.lineHeight),
        fontWeight: number(computed.fontWeight),
        letterSpacing: Number.isFinite(letterSpacing) ? letterSpacing : 0,
      }),
      primaryFontFamily(computed.fontFamily ?? ""),
      (computed.fontStyle ?? "").trim().toLowerCase(),
    ].join("|"),
  }
}

/** The two declarations an icon-size token writes, as the matcher reads them. */
export function iconSizeEvidence(
  element: Element,
  computed: CSSStyleDeclaration
): { inlineValue: string; computedValue: string } {
  const style = (element as HTMLElement).style
  return {
    inlineValue: `${style.width} ${style.height}`,
    computedValue: computed.width,
  }
}

/**
 * Whether this element has a ring, which is not the question it looks like.
 *
 * A Tailwind v4 ring is a box-shadow, so the rendered proof it exists is the
 * custom property that shadow reads rather than any border on the box. But v4
 * REGISTERS that property with an initial value, so it resolves on every
 * element in the document — measured 1958 of 1958 on /ds. Only a value other
 * than the transparent initial is a ring; a non-empty string is just Tailwind.
 */
export function hasRing(element: Element, computed: CSSStyleDeclaration): boolean {
  const ringShadow = computed.getPropertyValue("--tw-ring-shadow").trim()
  return (Boolean(ringShadow) && ringShadow !== RING_SHADOW_NONE) || hasUtility(element, "ring")
}

/** An outline wide enough to paint, or a utility that will give it one. */
export function hasOutline(element: Element, computed: CSSStyleDeclaration): boolean {
  return (
    (number(computed.outlineWidth) > 0 && computed.outlineStyle !== "none") ||
    hasUtility(element, "outline")
  )
}

/** A border wide enough to paint, or a utility that will give it one. */
export function hasBorder(element: Element, computed: CSSStyleDeclaration): boolean {
  const width = Math.max(
    ...SIDES.map((side) => number(computed.getPropertyValue(`border-${side}-width`)))
  )
  return width > 0 || hasUtility(element, "border")
}
