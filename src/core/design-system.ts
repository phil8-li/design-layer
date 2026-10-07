/** Shared authored tracing, computed fallback, and writes for host design tokens. */

import {
  config,
  type DesignSystemCatalog,
  type DesignSystemToken,
  type TailwindTokenAlias,
  type TrackingUnit,
} from "./config"
import { activeDesignSystem } from "../libraries/store"
import { splitVariantChain } from "./responsive"

/**
 * Every design-system axis the inspector can bind, as a value rather than a
 * bare union so a test can walk the whole set. That walk is the guard: a
 * property with no catalog category, or one whose writes no Tailwind
 * translation knows, would be a row that silently never reaches source.
 */
export const DESIGN_TOKEN_PROPERTIES = [
  "fill-color", "text-color", "stroke-color", "ring-color", "outline-color",
  "svg-fill", "svg-stroke",
  "corner-radius", "corner-radius-top-left", "corner-radius-top-right",
  "corner-radius-bottom-right", "corner-radius-bottom-left",
  "text-style", "shadow", "icon-size",
  "gap", "row-gap", "column-gap",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "motion-duration",
] as const

export type DesignTokenProperty = (typeof DESIGN_TOKEN_PROPERTIES)[number]

export type DesignSystemMatch = {
  token: DesignSystemToken
  via: "authored" | "computed"
  source: string
  /** True when an alias changes meaning across theme or selector scopes. */
  ambiguous: boolean
}

export type TokenStyleWrite = { property: string; value: string }

const PROPERTY_CATEGORY: Record<DesignTokenProperty, keyof DesignSystemCatalog> = {
  "fill-color": "colors", "text-color": "colors", "stroke-color": "colors",
  "ring-color": "colors", "outline-color": "colors",
  "svg-fill": "colors", "svg-stroke": "colors",
  "corner-radius": "radii", "corner-radius-top-left": "radii",
  "corner-radius-top-right": "radii", "corner-radius-bottom-right": "radii",
  "corner-radius-bottom-left": "radii",
  "text-style": "textStyles",
  shadow: "effects",
  "icon-size": "icons",
  gap: "spacing", "row-gap": "spacing", "column-gap": "spacing",
  padding: "spacing", "padding-top": "spacing", "padding-right": "spacing",
  "padding-bottom": "spacing", "padding-left": "spacing",
  margin: "spacing", "margin-top": "spacing", "margin-right": "spacing",
  "margin-bottom": "spacing", "margin-left": "spacing",
  "motion-duration": "motion",
}

/**
 * The single CSS declaration each property writes. `text-style` and `icon-size`
 * are compound — `tokenStyleWrites` emits four and two writes respectively — so
 * their entry names the one an inspector should probe a resolved value with.
 * A ring in Tailwind v4 is a box-shadow driven by a custom property, so the
 * ring colour is that property rather than a border of its own.
 */
const CSS_PROPERTY: Record<DesignTokenProperty, string> = {
  "fill-color": "background-color", "text-color": "color", "stroke-color": "border-color",
  "ring-color": "--tw-ring-color", "outline-color": "outline-color",
  "svg-fill": "fill", "svg-stroke": "stroke",
  "corner-radius": "border-radius", "corner-radius-top-left": "border-top-left-radius",
  "corner-radius-top-right": "border-top-right-radius",
  "corner-radius-bottom-right": "border-bottom-right-radius",
  "corner-radius-bottom-left": "border-bottom-left-radius",
  "text-style": "font-size",
  shadow: "box-shadow",
  "icon-size": "width",
  gap: "gap", "row-gap": "row-gap", "column-gap": "column-gap",
  padding: "padding", "padding-top": "padding-top", "padding-right": "padding-right",
  "padding-bottom": "padding-bottom", "padding-left": "padding-left",
  margin: "margin", "margin-top": "margin-top", "margin-right": "margin-right",
  "margin-bottom": "margin-bottom", "margin-left": "margin-left",
  "motion-duration": "transition-duration",
}

/** Tailwind utility stem per property, for reading an authored class back. */
const UTILITY_STEM: Partial<Record<DesignTokenProperty, string>> = {
  "fill-color": "bg", "text-color": "text", "stroke-color": "border", "ring-color": "ring",
  "outline-color": "outline", "svg-fill": "fill", "svg-stroke": "stroke",
  "corner-radius": "rounded", "corner-radius-top-left": "rounded-tl",
  "corner-radius-top-right": "rounded-tr", "corner-radius-bottom-right": "rounded-br",
  "corner-radius-bottom-left": "rounded-bl",
  gap: "gap", "row-gap": "gap-y", "column-gap": "gap-x",
  padding: "p", "padding-top": "pt", "padding-right": "pr", "padding-bottom": "pb",
  "padding-left": "pl",
  margin: "m", "margin-top": "mt", "margin-right": "mr", "margin-bottom": "mb",
  "margin-left": "ml",
  "icon-size": "size",
}

export function tokenCssProperty(property: DesignTokenProperty): string {
  return CSS_PROPERTY[property]
}

/** Human group names for the categories whose tokens carry no path of their own. */
const CATEGORY_GROUP: Record<string, string> = {
  color: "Color",
  spacing: "Spacing",
  radius: "Radius",
  typography: "Text",
  shadow: "Effect",
  "icon-size": "Icon",
  motion: "Motion",
}

/**
 * One register for the headers.
 *
 * The catalog's own paths are mixed: `Background/…` and `Text and Icon/…` are
 * written for people, while `radius/…`, `spacing/…` and `workspace/…` are
 * written for a stylesheet. Left alone the fill list opens with a `workspace`
 * header over a `Page` row, three lines above `Background` — which reads as two
 * different systems rather than one.
 */
function humanGroup(prefix: string): string {
  return prefix.charAt(0).toUpperCase() + prefix.slice(1)
}

/**
 * The motion collection stores its leaves as identifiers — `fullScreen`,
 * `sinkInRecede` — so the camel humps become spaces. Case is otherwise left
 * exactly as authored: `2xl` and `sm` are the design system's own spellings,
 * and title-casing them into `2xl`/`Sm` would be an invention, not a fix.
 */
function humanLeaf(leaf: string): string {
  return leaf.replace(/([a-z\d])([A-Z])/g, (_, before: string, upper: string) => `${before} ${upper.toLowerCase()}`)
}

/**
 * A token name split into the group it lists under and the leaf a row shows.
 *
 * This split is why the old picker read long: every line repeated the path, so
 * forty colours were forty spellings of `Background/…` and `Text and Icon/…`.
 * Saying the group once, in a header, is the same information in a third of the
 * ink — and it is a fact about the token, so it lives with the token.
 */
export function tokenNameParts(token: DesignSystemToken): { group: string; leaf: string } {
  const cut = token.name.lastIndexOf("/")
  if (cut < 0) return { group: CATEGORY_GROUP[token.category] ?? "Tokens", leaf: humanLeaf(token.name) }
  return { group: humanGroup(token.name.slice(0, cut)), leaf: humanLeaf(token.name.slice(cut + 1)) }
}

/**
 * What the closed field calls a token: the same two parts the list shows, back
 * together, so the row a designer picked and the field it lands in read alike.
 * A token with no path of its own keeps its bare leaf — the group in that case
 * is a category label this module invented, and printing `Icon/action` would
 * put a path on a token the design system never gave one.
 */
export function tokenDisplayName(token: DesignSystemToken): string {
  const { group, leaf } = tokenNameParts(token)
  return token.name.includes("/") ? `${group}/${leaf}` : leaf
}

/**
 * What a swatch paints for this token, or null when it has no paint.
 *
 * The custom property rather than the literal value: the editor draws inside
 * the host document, so the variable resolves to whatever the live theme says,
 * where a hard-coded light value would lie in dark mode. This is a CSS value
 * for a `style` attribute, never a string anyone reads.
 */
export function tokenSwatchCss(token: DesignSystemToken): string | null {
  if (token.cssVar) return `var(${token.cssVar})`
  const literal = Object.values(token.values).find((entry): entry is string => typeof entry === "string")
  return literal ?? null
}

/** `16/20` — the size and leading pair a text style is recognised by. */
export function tokenTextPair(token: DesignSystemToken): string {
  const value = token.values.default
  if (!value || typeof value !== "object") return ""
  const shape = value as Record<string, unknown>
  const fontSize = scalar(shape.fontSize)
  const lineHeight = scalar(shape.lineHeight)
  return fontSize === null || lineHeight === null ? "" : `${fontSize}/${lineHeight}`
}

/**
 * The compact design fact a row carries beside its name, or "" when it has none.
 *
 * A picker of eight radii called sm…pill, all previewed as the same chip, tells
 * a designer nothing the old option labels did not — the number IS the design
 * decision on every axis that is a measurement, and it is short enough to sit
 * in a right-aligned column without crowding the name. Colours and effects say
 * nothing here on purpose: the swatch already carries the whole fact, and a hex
 * on seventy-one rows is noise rather than information.
 */
export function tokenDetail(property: DesignTokenProperty, token: DesignSystemToken): string {
  if (property === "text-style") return tokenTextPair(token)
  const category = PROPERTY_CATEGORY[property]
  if (category === "radii" || category === "spacing" || category === "icons") {
    const px = scalar(token.values.default)
    return px === null ? "" : `${px}px`
  }
  if (category === "motion") {
    // The spring's own visual duration, including the seven that bounce: they
    // cannot be written as a `transition-duration`, but how long they take is
    // still what a designer is choosing between.
    const curve = spring(token)
    return curve ? `${Math.round(curve.visualDuration * 1000)}ms` : ""
  }
  return ""
}

/** Which of the picker's three previews an axis can draw. */
export function tokenPreviewKind(
  property: DesignTokenProperty
): "color" | "text" | "radius" | "none" {
  const category = PROPERTY_CATEGORY[property]
  if (category === "colors") return "color"
  if (category === "textStyles") return "text"
  if (category === "radii") return "radius"
  return "none"
}

const HEX = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/i
const DURATION = /^([\d.]+)(ms|s)$/

function hexChannel(channel: string): string {
  return Math.max(0, Math.min(255, Math.round(Number(channel)))).toString(16).padStart(2, "0")
}

function alphaValue(raw: string): number {
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed)) return 1
  return raw.trim().endsWith("%") ? parsed / 100 : parsed
}

/**
 * A colour and, when it is not solid, how much of it there is.
 *
 * Dropping the fourth channel is a lie a swatch cannot correct: an element with
 * no background computes to `rgba(0, 0, 0, 0)`, and printing `#000000` beside
 * an empty chip states a design fact — this box is black — that is false. Every
 * scrim, wash and hover overlay had the same problem, reading as its opaque
 * base. Nothing at all is the honest answer for transparent; a percentage is
 * the honest answer for the rest, and it is how a designer says it out loud.
 */
function withOpacity(hex: string, alpha: number): string {
  if (alpha <= 0) return ""
  return alpha >= 1 ? hex : `${hex} ${Math.round(alpha * 100)}%`
}

/**
 * The plain human spelling of a rendered value, or "" when it has none.
 *
 * The empty string is the important half. A computed value can still be a
 * custom property, an `oklch()` or a `color-mix()`, and printing any of those
 * on a design surface is exactly what this picker exists to stop. Showing
 * nothing costs little, because the swatch beside it already carries the
 * colour; showing the machine's spelling costs the whole point.
 */
export function plainValue(property: DesignTokenProperty, value: string): string {
  const raw = value.trim()
  if (!raw) return ""
  if (property === "text-style") {
    const [fontSize, lineHeight] = raw.split("|")
    return fontSize && lineHeight ? `${fontSize}/${lineHeight}` : ""
  }
  const category = PROPERTY_CATEGORY[property]
  if (category === "colors") {
    if (HEX.test(raw)) {
      // One casing, so the same colour never reads as two different values on
      // two rows just because two authors typed it differently.
      const digits = raw.slice(1).toLowerCase()
      const expanded = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits
      const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1
      return withOpacity(`#${expanded.slice(0, 6)}`, alpha)
    }
    const channels = RGB.exec(raw)
    if (!channels) return ""
    return withOpacity(
      `#${channels.slice(1, 4).map(hexChannel).join("")}`,
      channels[4] === undefined ? 1 : alphaValue(channels[4])
    )
  }
  if (category === "radii" || category === "spacing" || category === "icons") {
    const px = scalar(raw)
    return px === null ? "" : `${px}px`
  }
  if (category === "motion") {
    const duration = DURATION.exec(raw)
    return duration ? `${Math.round(Number(duration[1]) * (duration[2] === "s" ? 1000 : 1))}ms` : ""
  }
  return ""
}

function unique<T>(values: readonly T[]): T[] { return [...new Set(values)] }

/**
 * The catalog tokens a property may be bound to. One owner: panels list these.
 *
 * The default registry is the MERGED catalog rather than `config.designSystem`,
 * and that one substitution is the whole of what libraries cost this module: a
 * library's tokens arrive in the same arrays, already named for their library,
 * and nothing below can tell one from a host token. With nothing enabled —
 * nearly every session — `activeDesignSystem()` hands back the host's own
 * object, so the default is unchanged in both value and identity.
 */
export function tokensForProperty(
  property: DesignTokenProperty,
  registry: DesignSystemCatalog = activeDesignSystem()
): DesignSystemToken[] {
  if (property === "text-style") return [...registry.textStyles, ...registry.uiTextStyles]
  return registry[PROPERTY_CATEGORY[property]] as DesignSystemToken[]
}

/**
 * The lookups `authoredTokenMatches` makes, built once per catalog.
 *
 * Every token row on the Design tab asks — about twenty per render, on every
 * selection, commit and nudge — and each used to rebuild a map of the whole
 * catalog and rescan it per variable. A catalog is never edited in place
 * (`activeDesignSystem()` hands back a new merged object when the enabled
 * libraries change, and the host's own is fixed at load), so its identity is
 * the cache key and a WeakMap lets a retired one go.
 *
 * `byVar` lists tokens in catalog order, which within one property's category
 * is that property's own order — so the evidence below is gathered in exactly
 * the sequence the old per-property scan produced, and the matches come back
 * in the same order.
 */
interface CatalogIndex {
  byId: Map<string, DesignSystemToken>
  byVar: Map<string, DesignSystemToken[]>
  /** First alias per variable name, as `Array.find` answered it. */
  aliasByVar: Map<string, DesignSystemCatalog["aliases"]["cssVariables"][number]>
  byProperty: Map<DesignTokenProperty, { tokens: Set<DesignSystemToken>; ids: Set<string> }>
}

const catalogIndexes = new WeakMap<DesignSystemCatalog, CatalogIndex>()

function catalogIndex(registry: DesignSystemCatalog): CatalogIndex {
  const cached = catalogIndexes.get(registry)
  if (cached) return cached
  const all = [
    ...registry.colors,
    ...registry.spacing,
    ...registry.radii,
    ...registry.textStyles,
    ...registry.uiTextStyles,
    ...registry.effects,
    ...registry.icons,
    ...registry.motion,
    ...registry.breakpoints,
  ]
  const byVar = new Map<string, DesignSystemToken[]>()
  for (const token of all) {
    for (const variable of tokenVariables(token)) {
      const list = byVar.get(variable)
      if (list) list.push(token)
      else byVar.set(variable, [token])
    }
  }
  const aliasByVar: CatalogIndex["aliasByVar"] = new Map()
  for (const alias of registry.aliases.cssVariables) {
    if (!aliasByVar.has(alias.name)) aliasByVar.set(alias.name, alias)
  }
  const index: CatalogIndex = {
    byId: new Map(all.map((token) => [token.id, token])),
    byVar,
    aliasByVar,
    byProperty: new Map(),
  }
  catalogIndexes.set(registry, index)
  return index
}

function propertyTokens(
  index: CatalogIndex,
  property: DesignTokenProperty,
  registry: DesignSystemCatalog
): { tokens: Set<DesignSystemToken>; ids: Set<string> } {
  let entry = index.byProperty.get(property)
  if (!entry) {
    const tokens = tokensForProperty(property, registry)
    entry = { tokens: new Set(tokens), ids: new Set(tokens.map((token) => token.id)) }
    index.byProperty.set(property, entry)
  }
  return entry
}

export function extractCssVarNames(value: string): string[] {
  const names: string[] = []
  const pattern = /var\(\s*(--[\w-]+)/g
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) names.push(match[1])
  return unique(names)
}

function directUtilities(classNames: readonly string[]): string[] {
  return classNames.filter((name) => splitVariantChain(name).length === 1)
}

/**
 * The utility a theme alias is written as, or null when this axis has no use
 * for that namespace.
 *
 * `alias.name` arrives already stripped of its namespace — the server splits
 * `--color-background` into `{ namespace: "color", name: "background" }`, and a
 * v3 host's alias never had a custom property to strip in the first place. This
 * function therefore reads the namespace off the alias rather than re-deriving
 * it from a hardcoded spelling of one host's variables. The four mappings below
 * are Tailwind's own utility grammar, not a host's vocabulary: a namespace the
 * editor has no role for simply yields no utility.
 */
function aliasUtility(property: DesignTokenProperty, alias: TailwindTokenAlias): string | null {
  const name = alias.name
  const stem = UTILITY_STEM[property]
  const category = PROPERTY_CATEGORY[property]
  if (alias.namespace === "color" && category === "colors" && stem) return `${stem}-${name}`
  if (alias.namespace === "radius" && category === "radii" && stem) {
    return name === "DEFAULT" ? stem : `${stem}-${name}`
  }
  if (alias.namespace === "text" && property === "text-style") return `text-${name}`
  if (alias.namespace === "shadow" && property === "shadow") {
    return name === "DEFAULT" ? "shadow" : `shadow-${name}`
  }
  return null
}

function scalarFromClass(stem: string, className: string, spacingScale: Record<string, string>): number | null {
  const match = new RegExp(`^${stem}-(-?[\\w.]+)$`).exec(className)
  if (!match) return null
  const token = match[1]
  const entry = Object.entries(spacingScale).find(([, value]) => value === token)
  return entry ? Number(entry[0]) : null
}

function tokenVariables(token: DesignSystemToken): string[] {
  return unique([...(token.cssVar ? [token.cssVar] : []), ...Object.values(token.cssVars ?? {})])
}

/** Finds explicit CSS-variable, utility, alias, and scalar source bindings. */
export function authoredTokenMatches(
  property: DesignTokenProperty,
  inlineValue: string,
  classNames: readonly string[],
  registry: DesignSystemCatalog = activeDesignSystem()
): DesignSystemMatch[] {
  const tokens = tokensForProperty(property, registry)
  const index = catalogIndex(registry)
  const { byId } = index
  const own = propertyTokens(index, property, registry)
  const evidence = new Map<string, { sources: string[]; exact: boolean }>()
  const add = (found: readonly string[], source: string, exact = true) => {
    for (const id of found) {
      if (!byId.has(id) || !own.ids.has(id)) continue
      const current = evidence.get(id) ?? { sources: [], exact: false }
      if (!current.sources.includes(source)) current.sources.push(source)
      current.exact ||= exact
      evidence.set(id, current)
    }
  }
  // This property's own tokens that declare the variable, as the old scan of
  // `tokens` found them.
  const byVariable = (variable: string): string[] =>
    (index.byVar.get(variable) ?? []).filter((token) => own.tokens.has(token)).map((token) => token.id)

  const inlineVars = extractCssVarNames(inlineValue)
  for (const variable of inlineVars) {
    add(byVariable(variable), `var(${variable})`)
    const alias = index.aliasByVar.get(variable)
    if (alias) add(alias.tokenIds, `var(${variable})`, !alias.ambiguous)
  }

  // An inline declaration beats every utility class in the cascade, so the
  // moment the element carries one, no class can still be the authority for
  // what this axis paints. That is what lets a designer break out of the system
  // the way Figma does: type `#ff0066` into the picker's own-value field and the
  // closed field has to read `#ff0066`, not the `bg-secondary` the element still
  // carries and no longer obeys — which is exactly what it read before, because
  // the class scan ran regardless and its evidence was the only evidence.
  //
  // Nothing is lost for tokens: a token picked from the list writes
  // `var(--sem-…)` inline, so it is matched above by its own variable, and the
  // handful of tokens with no custom property write a literal that
  // `computedTokenMatches` recognises by value.
  const utilities = inlineValue.trim() ? [] : directUtilities(classNames)
  for (const utility of utilities) {
    for (const variable of extractCssVarNames(utility)) {
      add(byVariable(variable), `.${utility}`)
      const alias = index.aliasByVar.get(variable)
      if (alias) add(alias.tokenIds, `.${utility}`, !alias.ambiguous)
    }
    for (const alias of registry.aliases.tailwind) {
      if (aliasUtility(property, alias) === utility) {
        add(alias.tokenIds, `.${utility}`, !alias.ambiguous)
      }
    }
    if (property === "text-style") {
      for (const token of tokens) if (token.cssUtility === utility) add([token.id], `.${utility}`)
    }
    const scalarStem = UTILITY_STEM[property]
    const scalarCategory = PROPERTY_CATEGORY[property]
    if (scalarStem && (scalarCategory === "spacing" || scalarCategory === "icons")) {
      const px = scalarFromClass(scalarStem, utility, config.tailwind.spacingScale)
      if (px !== null) {
        add(
          tokens.filter((token) => Number(token.values.default) === px).map((token) => token.id),
          `.${utility}`
        )
      }
    }
  }

  const matches = [...evidence]
  const exact = matches.filter(([, found]) => found.exact)
  return (exact.length ? exact : matches).map(([id, found]) => ({
    token: byId.get(id) as DesignSystemToken,
    via: "authored",
    source: found.sources.join(", "),
    ambiguous: !found.exact,
  }))
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*,\s*/g, ",")
}

function scalar(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return null
  const match = /^(-?\d+(?:\.\d+)?)(?:px)?$/.exec(value.trim())
  return match ? Number(match[1]) : null
}

export function textStyleSignature(value: {
  fontSize: number
  lineHeight: number
  fontWeight?: number | null
  letterSpacing: number
}): string {
  return [value.fontSize, value.lineHeight, value.fontWeight ?? "", value.letterSpacing]
    .map(String)
    .join("|")
}

/**
 * A text token as the px signature a computed style can be compared against.
 *
 * The unit is DECLARED by the host, never inferred. This used to read the unit
 * off the magnitude — under 1 was treated as em, 1 or more as px — which is
 * true of this app's manifest and of nothing in particular. A system with
 * `letter-spacing: -0.5px` on a 14px body style would have had that half-pixel
 * multiplied into -7px and matched nothing, and a system tracking headlines at
 * `1.2em` would have been read as 1.2px. `designSystem.trackingUnit` (or the
 * manifest's own `trackingUnit`) says which one it is.
 */
function textTokenSignature(token: DesignSystemToken, trackingUnit: TrackingUnit): string | null {
  const value = token.values.default
  if (!value || typeof value !== "object") return null
  const shape = value as Record<string, unknown>
  const fontSize = scalar(shape.fontSize)
  const lineHeight = scalar(shape.lineHeight)
  const fontWeight = scalar(shape.fontWeight)
  const tracking = scalar(shape.letterSpacing)
  if (fontSize === null || lineHeight === null || tracking === null) return null
  const letterSpacing = trackingUnit === "em" ? tracking * fontSize : tracking
  return textStyleSignature({ fontSize, lineHeight, fontWeight, letterSpacing })
}

function rawTokenValues(
  property: DesignTokenProperty,
  token: DesignSystemToken,
  trackingUnit: TrackingUnit
): string[] {
  if (property === "text-style") {
    const signature = textTokenSignature(token, trackingUnit)
    return signature ? [signature] : []
  }
  const value = token.values.default
  const category = PROPERTY_CATEGORY[property]
  if (category === "radii" || category === "spacing" || category === "icons") {
    const number = scalar(value)
    return number === null ? [] : [`${number}px`, String(number)]
  }
  if (category === "motion") {
    // A computed duration may only match a spring CSS can actually express, so
    // the candidates are exactly what `tokenStyleWrites` would write, in both
    // the ms spelling it writes and the seconds spelling authors tend to use.
    const write = motionDurationWrites(token)[0]
    return write ? [write.value, `${Number.parseFloat(write.value) / 1000}s`] : []
  }
  if (property === "shadow" && Array.isArray(value)) return [JSON.stringify(value)]
  return Object.values(token.values).filter((entry): entry is string => typeof entry === "string")
}

/**
 * `raw` as the browser computes it for `property` — the probe that lets a
 * token's custom property be compared with an element's computed value
 * (`#fff` against `rgb(255, 255, 255)`).
 *
 * The computed fallback asks this for every token variable on an axis, on
 * every row, on every render: hundreds of calls per Design tab. It used to
 * insert a probe into `<body>`, read it and remove it each time — a forced
 * style recalc and two body mutations per token, which every MutationObserver
 * on the page (ours in `shell/app-viewport.ts` among them) also had to hear.
 *
 * So the answer is memoized, keyed by property and raw value: normalizing a
 * value that is already substituted is pure. The misses share one probe,
 * attached on the first and detached in a microtask, so a whole render's worth
 * of misses costs one insert and one removal — and the probe is still gone
 * before anything paints, as it always was: a node left in `<body>` would
 * shift the app's own `:last-child` matches. A short non-negative px on a
 * spacing or radius axis skips the probe entirely, because that is already its
 * computed spelling. What the probe resolves against body — `currentColor`,
 * em, rem — can move with the app's stylesheets, which is why
 * `forgetNormalizedCssValues` exists: the inspector calls it on every refresh,
 * and a stylesheet rescan should too.
 */
const normalizedCache = new Map<string, string>()
let probe: HTMLElement | null = null
const PLAIN_PX = /^(?:0|[1-9]\d{0,3})(?:\.\d?[1-9])?px$/

export function forgetNormalizedCssValues(): void {
  normalizedCache.clear()
}

export function normalizedCssValue(property: DesignTokenProperty, raw: string): string {
  const css = tokenCssProperty(property)
  const category = PROPERTY_CATEGORY[property]
  if ((category === "spacing" || category === "radii") && PLAIN_PX.test(raw)) return raw
  const key = `${css}|${raw}`
  const cached = normalizedCache.get(key)
  if (cached !== undefined) return cached
  if (!probe) {
    probe = document.createElement("span")
    probe.setAttribute("data-designlayer", "")
    probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none"
  }
  if (!probe.isConnected) {
    const attached = probe
    document.body.append(attached)
    queueMicrotask(() => attached.remove())
  }
  probe.style.setProperty(css, raw)
  const resolved = getComputedStyle(probe).getPropertyValue(css).trim() || raw
  probe.style.removeProperty(css)
  normalizedCache.set(key, resolved)
  return resolved
}

/** Computed-value fallback. Every equal candidate is returned; no arbitrary winner. */
export function computedTokenMatches(
  property: DesignTokenProperty,
  computedValue: string,
  registry: DesignSystemCatalog = activeDesignSystem(),
  resolveCssVar: (name: string) => string = (name) => `var(${name})`
): DesignSystemMatch[] {
  const targetNumber = scalar(computedValue)
  const trackingUnit = registry.trackingUnit ?? "em"
  return tokensForProperty(property, registry).flatMap((token) => {
    const candidates = [
      ...tokenVariables(token).map((name) => resolveCssVar(name)),
      ...rawTokenValues(property, token, trackingUnit),
    ].filter(Boolean)
    const equal = candidates.some((candidate) => {
      const candidateNumber = scalar(candidate)
      if (targetNumber !== null && candidateNumber !== null) {
        return Math.abs(targetNumber - candidateNumber) < 0.01
      }
      return normalized(candidate) === normalized(computedValue)
    })
    return equal
      ? [{ token, via: "computed" as const, source: unique(candidates).join(" · "), ambiguous: false }]
      : []
  })
}

function spring(token: DesignSystemToken): { visualDuration: number; bounce: number } | null {
  const value = token.values.default
  if (!value || typeof value !== "object") return null
  const shape = value as Record<string, unknown>
  const visualDuration = scalar(shape.visualDuration)
  const bounce = scalar(shape.bounce)
  return visualDuration === null || bounce === null ? null : { visualDuration, bounce }
}

function shadowValue(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const layers = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const layer = entry as Record<string, unknown>
    if (![layer.x, layer.y, layer.blur, layer.spread].every((part) => typeof part === "number")) return []
    return [`${layer.x}px ${layer.y}px ${layer.blur}px ${layer.spread}px ${String(layer.color ?? "#000")}`]
  })
  return layers.length ? layers.join(", ") : null
}

/**
 * `transition-duration` carries a duration and nothing else, so only a spring
 * with no bounce survives the trip into CSS. Seven of the system's nine bounce;
 * writing their visualDuration as a duration would ship a different feel while
 * reporting success, so they write nothing instead — an empty array is already
 * how this module says "this token cannot be written here", and the inspector
 * surfaces it rather than silently applying half the token.
 */
function motionDurationWrites(token: DesignSystemToken): TokenStyleWrite[] {
  const curve = spring(token)
  if (!curve || curve.bounce !== 0) return []
  return [{ property: "transition-duration", value: `${Math.round(curve.visualDuration * 1000)}ms` }]
}

export function tokenStyleWrites(property: DesignTokenProperty, token: DesignSystemToken): TokenStyleWrite[] {
  const variable = token.cssVar ? `var(${token.cssVar})` : null
  const value = token.values.default
  if (property === "text-style") {
    const shape = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
    const css = token.cssVars ?? {}
    const write = (name: string, key: string, fallback: string | null) =>
      css[key] ? { property: name, value: `var(${css[key]})` } : fallback ? { property: name, value: fallback } : null
    return [
      write("font-size", "fontSize", scalar(shape.fontSize) === null ? null : `${scalar(shape.fontSize)}px`),
      write("line-height", "lineHeight", scalar(shape.lineHeight) === null ? null : `${scalar(shape.lineHeight)}px`),
      write("font-weight", "fontWeight", scalar(shape.fontWeight) === null ? null : String(scalar(shape.fontWeight))),
      write("letter-spacing", "letterSpacing", scalar(shape.letterSpacing) === null ? null : `${scalar(shape.letterSpacing)}em`),
    ].filter((entry): entry is TokenStyleWrite => entry !== null)
  }
  if (property === "icon-size") {
    const px = scalar(value)
    return px === null ? [] : [{ property: "width", value: `${px}px` }, { property: "height", value: `${px}px` }]
  }
  if (property === "motion-duration") return motionDurationWrites(token)
  const category = PROPERTY_CATEGORY[property]
  let next = variable
  if (!next && (category === "radii" || category === "spacing")) {
    const px = scalar(value)
    next = px === null ? null : `${px}px`
  }
  if (!next && property === "shadow") next = shadowValue(value)
  if (!next) next = Object.values(token.values).find((entry): entry is string => typeof entry === "string") ?? null
  return next ? [{ property: CSS_PROPERTY[property], value: next }] : []
}
