/**
 * Reading a design system out of a file somebody else wrote.
 *
 * The host's own design system arrives as a manifest this package specifies, so
 * `design-system-manifest.mjs` can afford to be strict: a shape it does not
 * recognise is a mistake the host should hear about. A LIBRARY is the opposite
 * situation. It is a file the user already had — a theme stylesheet, a Style
 * Dictionary export, an icon dump — written years before this editor existed
 * and with no intention of being read by it. Nothing about it can be required,
 * and every rule here has to survive a spelling nobody agreed on in advance.
 *
 * That is why the CSS classifier below keys on WORD SEGMENTS rather than on
 * prefixes. A prefix rule assumes the type word leads the name, which is true
 * of Tailwind v4 (`--color-brand-500`) and false of most systems shipped by a
 * platform team, where the name leads with a vendor and a layer and the type
 * word sits in the middle (`--x-sys-spacing-4`) or is absent entirely
 * (`--x-blue-500`, a colour only its value admits to). Measured against four
 * real design systems, a prefix rule read almost nothing. Segment matching plus
 * a value fallback reads nearly all of it.
 *
 * The second half of the job is refusing. A token this editor offers is a token
 * it will WRITE into the user's stylesheet, so a value it cannot write is worse
 * than a value it never saw: the picker reports success and the element does not
 * change. Hence the per-group validation — a colour must be paintable, a radius
 * must be a single length, an easing curve is dropped even though it is plainly
 * a motion token, because the motion axis writes a duration and would quietly
 * ship a different feel. Dropping is the safe direction; a token that is missing
 * is a token the designer types by hand.
 *
 * Everything here is pure. No filesystem, no config, no clock — the store in
 * `libraries.mjs` owns all three. That is what makes the parsing brain testable
 * against a string, which is how the rules below were measured in the first
 * place.
 */

import { normalizeDesignSystemManifest } from "./design-system-manifest.mjs"

/**
 * The six shapes a library can arrive in.
 *
 * Two of them never reach `parseLibrary`, and both are in this list anyway.
 * `components` names a DIRECTORY of React or Angular sources, so it is scanned
 * by `library-components.mjs`. `url` names a page on the internet, so it is
 * fetched by `library-url.mjs` — and what comes back is handed to the parsers
 * here, which is why a remote token file is understood exactly as the same file
 * on disk would be. They belong in this list because the kind vocabulary is
 * shared with the store, the routes and the panel, and a second list that had
 * to be kept in step with this one would drift.
 */
export const LIBRARY_SOURCE_KINDS = Object.freeze([
  "manifest",
  "css",
  "tokens",
  "icons",
  "components",
  "url",
])

/**
 * Which generation of the reading rules below a catalog was produced by.
 *
 * A file library is re-parsed on every list, so it always reflects the rules in
 * this file. A URL library is NOT — its catalog is cached in the pointer file
 * when it is fetched (see `libraries.mjs`) — so a fix to these rules never
 * reached a library that was already installed: the one that reported an icon
 * scale as five text styles kept doing so after the fix, because nothing ever
 * read it again. The store stamps this number on each URL catalog it caches and
 * re-reads any catalog stamped lower.
 *
 * Bump it whenever a change here would read the same source text into a
 * different catalog. A row with no stamp predates the stamp and counts as 1.
 */
export const CATALOG_READER_VERSION = 4

/** Guards on a file nobody in this process wrote, not product limits. */
const MAX_ICON_DRAWINGS = 4000
const MAX_GLYPH_NAMES = 5000
const MAX_TOKEN_LEAVES = 5000

/**
 * How far an alias chain is followed before this module gives up.
 *
 * Deep enough for the ref/sys/component layering real systems use, shallow
 * enough that a pathological file cannot turn a parse into a hang. The trail
 * set makes a cycle terminate on its own; the depth limit is the second belt.
 */
const MAX_ALIAS_DEPTH = 8

/**
 * A leading segment run is only treated as a vendor prefix when this many
 * tokens share it. Below that the "common prefix" is a coincidence of a tiny
 * file, and stripping it would rename tokens for no reason.
 */
const VENDOR_PREFIX_MIN_TOKENS = 4

/** The px a unitless `rem`/`em` is worth. The root default, and not worth guessing at. */
const ROOT_FONT_SIZE = 16

/**
 * Above this, a unitless line-height is read as pixels; at or below it, as a
 * ratio of the font size. Both spellings are in the wild — `1.5` and `24` mean
 * the same leading on a 16px body — and no line is ever 4px tall, so the
 * magnitude separates them with room to spare.
 */
const LINE_HEIGHT_RATIO_MAX = 4

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Exported so that a component discovered over HTTP is named by the same rule
 * as one read out of a manifest. Two slugs would mean the same component
 * carried two ids depending on where it was found.
 */
export function slug(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function tokenId(category, name) {
  return `${category}:${slug(name)}`
}

/**
 * The library's identity, derived from its path rather than stored.
 *
 * Two libraries are the same library when they point at the same file, and the
 * path is the only thing about a source that is guaranteed to exist and to be
 * stable across a restart. Deriving the id from it means the persisted pointer
 * needs no generated key, and an id that appears in a URL is legible to whoever
 * is reading the network tab.
 */
export function libraryId(relativePath) {
  const id = slug(String(relativePath ?? ""))
  if (!id) throw new Error("A library path must contain at least one letter or digit")
  return id
}

/* ------------------------------------------------------------------------- */
/* CSS                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Every custom-property declaration in the text, with the selectors it sits
 * under.
 *
 * A character walk rather than a regular expression, for the same reason
 * `design-system-aliases.mjs` walks: a value can contain a brace inside a
 * string, a semicolon inside `url()`, and a nested block inside `@media`, and
 * every regex that pretends otherwise mangles exactly the files that are worth
 * reading. The two walkers stay separate because they answer different
 * questions — that one traces a variable back to a token it already knows, this
 * one has no catalog yet and needs the selector chain to tell light from dark.
 *
 * `ordinary`, when given, collects every other declaration too, tagged with the
 * block it sits in. Type roles are the reason: a system that ships its text
 * styles as classes (`.x-body-m { font-size: 15px; line-height: 20px }`) puts
 * them in ordinary declarations, and a reader that only collects custom
 * properties never sees a single one of them.
 */
function cssDeclarations(source, ordinary = null) {
  const css = String(source).replace(/\/\*[\s\S]*?\*\//g, "")
  const declarations = []
  const scopes = []
  const blocks = []
  let opened = 0
  let start = 0
  let quote = null
  let escaped = false
  let parens = 0
  const push = (end) => {
    const text = css.slice(start, end).trim()
    const match = /^(--[a-zA-Z0-9_-]+)\s*:\s*([\s\S]+)$/.exec(text)
    if (match) {
      declarations.push({ name: match[1], value: match[2].trim(), scopes: [...scopes] })
      return
    }
    const plain = ordinary ? /^([a-zA-Z-]+)\s*:\s*([\s\S]+)$/.exec(text) : null
    if (plain) {
      ordinary.push({
        property: plain[1].toLowerCase(),
        value: plain[2].trim(),
        scopes: [...scopes],
        block: blocks[blocks.length - 1],
      })
    }
  }

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = null
      continue
    }
    /*
     * A BACKSLASH ESCAPES THE NEXT CHARACTER ANYWHERE, not only inside a string
     * — and missing that silently threw away most of every Tailwind stylesheet
     * this editor was ever pointed at.
     *
     * The escape logic above runs only once `quote` is set, so out here a `\'`
     * was read as an apostrophe OPENING a string. Nothing ever closed it, so
     * from that character to the end of the file every brace and semicolon was
     * treated as string content: no scopes pushed, no declarations pushed, no
     * error — the stylesheet simply appeared to contain no tokens.
     *
     * It takes one class name to trigger, and Tailwind emits them by the dozen.
     * Measured on a real compiled bundle, this selector —
     *
     *   .\[\&\>svg\:not\(\[class\*\=\'size-\'\]\)\]\:size-4
     *
     * appears 6KB before the `:root` block holding the design system, and cost
     * the whole of it: 75 colours with light and dark values, 14 radii and 5
     * text styles read as zero. The same file parsed perfectly from the `:root`
     * block onwards, which is what made it look like a size limit rather than a
     * quote.
     *
     * Skipping the escaped character outright is CSS's own rule and is all this
     * needs: an escaped quote, brace, colon or bracket in a selector stops being
     * punctuation, which is exactly what the backslash was there to say.
     */
    if (char === "\\") {
      index += 1
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "(") parens += 1
    else if (char === ")") parens = Math.max(0, parens - 1)
    else if (parens === 0 && char === "{") {
      scopes.push(css.slice(start, index).trim())
      opened += 1
      blocks.push(opened)
      start = index + 1
    } else if (parens === 0 && char === ";") {
      push(index)
      start = index + 1
    } else if (parens === 0 && char === "}") {
      push(index)
      scopes.pop()
      blocks.pop()
      start = index + 1
    }
  }
  return declarations
}

/**
 * A selector that names the document with no condition attached — the block a
 * stylesheet puts its defaults in.
 *
 * Deliberately bare. `:host` is here because it is where a component library on
 * the other framework keeps its variables, and it is unconditional in the same
 * way `:root` is: it names the element the stylesheet is scoped to, full stop.
 * Everything with a qualifier hanging off it is handled by the rule below,
 * because a qualifier is a condition and a condition is a theme.
 */
const BASE_SELECTOR = /^(:root|html|body|\*|:host)$/

/** A variant selector naming itself the default: `[data-size='medium']`, `[data-scale='100%']`. */
const DEFAULT_VARIANT = /(^|[^a-z0-9])(default|normal|regular|medium|base|100%)([^a-z0-9%]|$)/

/** `dark` as a whole word, so `.dark`, `[data-theme="x-dark"]` and `darkroom` sort correctly. */
const DARK_SELECTOR = /(^|[^a-z0-9])dark([^a-z0-9]|$)/

/**
 * The at-rules that put a CONDITION on the block inside them, as opposed to the
 * ones that merely file it somewhere in the cascade.
 *
 * `@layer` and `@theme` are pointedly not here. A layer name is a bucket and a
 * `@theme` block is where a Tailwind v4 host keeps its scale; neither says
 * anything about WHEN the declarations inside apply, so neither makes the block
 * conditional. `@media`, `@supports` and `@container` all do, and that
 * distinction is the whole of what the tier rules below need from an at-rule.
 */
const CONDITIONAL_AT_RULE = /^@(media|supports|container)\b/

/** One attribute, class or pseudo-class hung off a selector, with no combinator between. */
const SELECTOR_QUALIFIER = "(\\([^()]*\\)|\\[[^\\]]*\\]|\\.[a-zA-Z0-9_-]+|::?[a-zA-Z-]+(\\([^()]*\\))?)"

/**
 * A selector that names the document under a CONDITION: a theme switch,
 * whichever of the three ways it is spelled.
 *
 * Three shapes, and each one is somebody's house style. A qualified document
 * root (`:root[data-theme='x']`, `html.compact`) is the commonest. A bare
 * attribute selector (`[data-theme='x']`) is the same switch written without
 * restating the root. A class that names a theme (`.theme-compact`) is how a
 * system that predates `data-*` attributes spells it.
 *
 * What is pointedly NOT here is an ordinary class. `.card` and `.toolbar`
 * declare variables too, and those variables are that component's private
 * business rather than the system's scale — a picker offering them would offer
 * the designer a component's internals as if they were design tokens. Nor is
 * anything containing a combinator: `:root[data-theme='x'] .card` is a card,
 * not a theme, and the space is the whole difference.
 */
const THEMED_SELECTOR = new RegExp(
  "^(" +
    `(:root|html|body|\\*|:host)${SELECTOR_QUALIFIER}+` +
    `|\\[[^\\]]*\\]${SELECTOR_QUALIFIER}*` +
    `|\\.[a-zA-Z0-9_-]*theme[a-zA-Z0-9_-]*${SELECTOR_QUALIFIER}*` +
    ")$"
)

function isBaseScope(scope) {
  return scope.split(",").some((part) => BASE_SELECTOR.test(part.trim()))
}

function isThemedScope(scope) {
  return scope.split(",").some((part) => THEMED_SELECTOR.test(part.trim()))
}

/**
 * Words a selector spends on naming the document, or on the hook a theme hangs
 * off, rather than on naming the theme itself.
 *
 * `:root[data-theme='x']` and `.theme-x` and `html[data-color-scheme='x']` are
 * the same switch in three house styles, and the only word in any of them that
 * identifies the theme is `x`. Stripping the plumbing is what lets the rule
 * below compare two selectors that were not written by the same person.
 */
const SELECTOR_PLUMBING = new Set([
  "root",
  "html",
  "body",
  "host",
  "data",
  "class",
  "theme",
  "themes",
  "mode",
  "scheme",
  "color",
  "colour",
  "is",
  "where",
  "not",
  // A dark block spelled as a media query spends four words getting to the one
  // that names the theme: `@media (prefers-color-scheme: dark)`. Without these,
  // that block looks like a DISTINGUISHED dark theme next to a plain `.dark`
  // — three words it does not share — and a system that ships both spellings of
  // the same palette (Radix Colors does, and so does anything following the OS
  // preference as well as a class toggle) would demote one of them to
  // additive-only for no reason a designer could see.
  "media",
  "prefers",
  "supports",
  "container",
])

/**
 * The words a dark block uses to name itself, plumbing removed.
 *
 * Read the same way `declarationTheme` reads: outermost scope inwards, first
 * dark one wins. Inside it, a comma list takes the PLAINEST part it matched on
 * — a block that applies under a bare `.dark` applies under bare dark, whatever
 * else is listed beside it.
 *
 * This says nothing on its own about whether the block is the plain dark theme;
 * that is a question about the file, and only `parseCssLibrary` can see the
 * file. Here it is just the vocabulary, ready to be compared.
 */
function darkSelectorTerms(scopes) {
  for (const scope of scopes) {
    const text = scope.trim().toLowerCase()
    if (!text) continue
    // A conditional at-rule is read here for the same reason `declarationTheme`
    // reads it: `@media (prefers-color-scheme: dark)` IS the selector that names
    // the theme, and skipping every `@` scope left such a block with no terms at
    // all, which ranked it as the plainest possible dark theme whatever else it
    // carried. A `@layer` name is still skipped — it is a cascade bucket, not a
    // condition, so the words in it distinguish nothing.
    if (text.startsWith("@") && !CONDITIONAL_AT_RULE.test(text)) continue
    if (!DARK_SELECTOR.test(text)) continue
    let terms = null
    for (const part of text.split(",")) {
      if (!DARK_SELECTOR.test(part.trim())) continue
      const words = new Set(
        part.split(/[^a-z0-9]+/).filter((word) => word && !SELECTOR_PLUMBING.has(word))
      )
      if (!terms || words.size < terms.size) terms = words
    }
    if (terms) return terms
  }
  return new Set()
}

/**
 * Which tier a declaration belongs to — `"light"` for the unconditional base,
 * `"dark"`, `"theme"` for a themed block that is neither — or null when it
 * belongs to none of them.
 *
 * Read outermost scope inwards, because a `@layer` wrapper says nothing about
 * the theme and the selector inside it says everything, and because CSS nesting
 * means the innermost recognised selector is the one that actually applies.
 * `@theme` is treated as a base block in its own right: it is where a Tailwind
 * v4 host keeps its scale, and it is not a selector at all, so the selector
 * tests below would otherwise throw the whole file away.
 *
 * A CONDITIONAL at-rule is the exception, and it is the reason this function
 * was rewritten. Skipping every `@` scope meant a block wrapped in
 * `@media (prefers-color-scheme: dark)` resolved by its inner `:root` to the
 * unconditional base tier — where last-declaration-wins, and where a dark block
 * is written LAST. So the dark palette quietly became the default palette and
 * no dark values were produced at all: the inspector showed a designer a black
 * swatch labelled as the light default, which is worse than showing nothing.
 * Radix Colors, Open Props and USWDS all ship that spelling, as does every
 * system that follows the OS preference instead of a class toggle.
 *
 * The other conditions are the same defect with a quieter symptom — a
 * `@media print` or `@media (min-width: 900px)` override was also flattened
 * into the base tier, so a real system's spacing scale came back as its
 * wide-viewport variant. They resolve to the additive `"theme"` tier instead:
 * present, offered, but never allowed to restate what the file says plainly.
 *
 * The condition is applied AFTER the selector inside it is understood, rather
 * than short-circuiting on the at-rule. `@media (prefers-color-scheme: dark)`
 * wrapping `.card` is still a component's private variables and still yields
 * null — the condition changes which tier a recognised block belongs to, it
 * does not make an unrecognised block worth reading.
 */
function declarationTheme(scopes, zones = new Set()) {
  let theme = null
  let condition = null
  for (const scope of scopes) {
    const text = scope.trim().toLowerCase()
    if (!text) continue
    if (text.startsWith("@")) {
      if (/^@theme\b/.test(text)) theme = theme ?? "light"
      else if (CONDITIONAL_AT_RULE.test(text)) {
        if (DARK_SELECTOR.test(text)) condition = "dark"
        else if (condition === null) condition = "theme"
      }
      continue
    }
    if (DARK_SELECTOR.test(text)) return "dark"
    if (isBaseScope(text)) {
      theme = "light"
      continue
    }
    if (isThemedScope(text)) {
      theme = "theme"
      continue
    }
    if (zones.has(scope.trim())) {
      theme = "zone"
      continue
    }
    return null
  }
  if (theme === null) return null
  if (condition === "dark") return "dark"
  return condition === "theme" && theme === "light" ? "theme" : theme
}

/**
 * Classes that restate one token vocabulary: themes switched by class name.
 *
 * `THEMED_SELECTOR` recognises a theme by how it is spelled — a `theme` word,
 * an attribute, a qualified root. Some systems name their themes after
 * nothing of the sort (`.x--white`, `.x--g90`), and their whole palette lives
 * in those blocks, so it read as absent. What gives such a class away is that
 * it redeclares the same long list of names another class declares: a
 * component's private variables are its own, while a theme is one vocabulary
 * stated several times over. Both tests are needed — a button's variants also
 * repeat their names, but a dozen of them, not the dozens a palette runs to.
 */
const THEME_ZONE_MIN_NAMES = 40
const THEME_ZONE_OVERLAP = 0.75

function themeZones(declarations) {
  const byClass = new Map()
  for (const declaration of declarations) {
    const scope = (declaration.scopes[declaration.scopes.length - 1] ?? "").trim()
    if (!SINGLE_CLASS.test(scope)) continue
    if (!declaration.scopes.slice(0, -1).every((outer) => /^@layer\b/i.test(outer.trim()))) continue
    const names = byClass.get(scope) ?? new Set()
    names.add(declaration.name)
    byClass.set(scope, names)
  }
  const large = [...byClass].filter(([, names]) => names.size >= THEME_ZONE_MIN_NAMES)
  const zones = new Set()
  for (const [scope, names] of large) {
    const sibling = large.some(([other, otherNames]) => {
      if (other === scope) return false
      let shared = 0
      for (const name of names) if (otherNames.has(name)) shared += 1
      return shared / Math.max(names.size, otherNames.size) >= THEME_ZONE_OVERLAP
    })
    if (sibling) zones.add(scope)
  }
  return zones
}

/** `var(--x)` / `var(--x, fallback)` as a whole value, with the fallback kept intact. */
function varReference(value) {
  const match = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*([\s\S]*)\)$/.exec(String(value).trim())
  if (!match) return null
  const tail = match[2].trim()
  if (tail && !tail.startsWith(",")) return null
  return { name: match[1], fallback: tail ? tail.slice(1).trim() : null }
}

/**
 * Follow an alias to the literal at the end of it.
 *
 * Three ways this ends, and all three are ordinary rather than exceptional. It
 * lands on a literal, which is the answer. It dead-ends — the chain names a
 * variable this file does not declare, because it lives in a stylesheet the
 * user did not add — and the fallback, if the author wrote one, is what the
 * browser would use, so it is what this uses too. Or it dead-ends with no
 * fallback, and the raw `var(…)` string is returned unchanged so that the
 * per-group validation can drop it: guessing what a variable defined somewhere
 * else resolves to is exactly the guess that puts a broken value in a picker.
 *
 * A cycle is handled as a dead end rather than as an error, because a cycle in
 * somebody's theme file is their problem and not a reason to refuse the other
 * four hundred tokens in it.
 */
function resolveValue(raw, lookup, depth = 0, trail = new Set()) {
  const reference = varReference(raw)
  if (!reference) return raw
  const fallback = () =>
    reference.fallback === null ? raw : resolveValue(reference.fallback, lookup, depth + 1, trail)
  if (depth >= MAX_ALIAS_DEPTH || trail.has(reference.name)) return fallback()
  const next = lookup(reference.name)
  if (next === undefined) return fallback()
  const resolved = resolveValue(next, lookup, depth + 1, new Set([...trail, reference.name]))
  // The chain resolved to another unresolved reference, so this link's own
  // fallback is still the browser's answer — `var(--a, 12px)` paints 12px when
  // `--a` is defined but itself invalid, not just when `--a` is missing.
  return varReference(resolved) ? fallback() : resolved
}

/**
 * Every `var()` INSIDE a value replaced by what it resolves to, or null when
 * one of them cannot be resolved.
 *
 * `resolveValue` only follows a value that is a reference from end to end. A
 * scale derived from one base — `--radius-sm: calc(var(--radius) - 4px)`, the
 * spelling every shadcn stylesheet uses for its whole corner scale — has its
 * reference in the middle, so until this existed the scale read as a lone
 * `--radius` and nothing else.
 */
function substituteVariables(raw, lookup, depth = 0) {
  const text = String(raw)
  if (depth >= MAX_ALIAS_DEPTH) return null
  let out = ""
  let index = 0
  for (;;) {
    const at = text.indexOf("var(", index)
    if (at === -1) return out + text.slice(index)
    let end = at + 3
    let open = 0
    for (; end < text.length; end += 1) {
      if (text[end] === "(") open += 1
      else if (text[end] === ")" && --open === 0) break
    }
    if (end >= text.length) return null
    const resolved = resolveValue(text.slice(at, end + 1), lookup)
    if (varReference(resolved)) return null
    const inner = substituteVariables(resolved, lookup, depth + 1)
    if (inner === null) return null
    out += text.slice(index, at) + inner
    index = end + 1
  }
}

/**
 * `calc()` arithmetic on lengths and plain numbers, as a CSS value, or null.
 *
 * Only what can be settled without a layout: px, rem and em (at the root size
 * `singleLength` already assumes) and unitless numbers, under `+ - * /` and
 * parentheses. A percentage or a viewport unit depends on the box it lands in,
 * so it is refused rather than guessed — the token is dropped exactly as an
 * unresolved `calc()` always was. A unitless result stays unitless, because
 * that is what a line-height ratio such as `calc(1 / 0.75)` is.
 */
function evaluateCalc(text) {
  const body = /^calc\(([\s\S]*)\)$/i.exec(String(text).trim())
  if (!body) return null
  const tokens = body[1].replace(/calc\(/gi, "(").match(/\d*\.?\d+(?:e-?\d+)?(?:px|rem|em|%|[a-z]+)?|[-+*/()]/gi)
  if (!tokens || tokens.join("").length !== body[1].replace(/calc\(/gi, "(").replace(/\s+/g, "").length) return null
  let at = 0
  const quantity = (raw) => {
    const match = /^(\d*\.?\d+(?:e-?\d+)?)([a-z%]*)$/i.exec(raw)
    if (!match) return null
    const number = Number.parseFloat(match[1])
    const unit = match[2].toLowerCase()
    if (unit === "") return { value: number, length: false }
    if (unit === "px") return { value: number, length: true }
    if (unit === "rem" || unit === "em") return { value: number * ROOT_FONT_SIZE, length: true }
    return null
  }
  const factor = () => {
    const token = tokens[at++]
    if (token === "-" || token === "+") {
      const inner = factor()
      return inner && token === "-" ? { ...inner, value: -inner.value } : inner
    }
    if (token === "(") {
      const inner = sum()
      return tokens[at++] === ")" ? inner : null
    }
    return token === undefined ? null : quantity(token)
  }
  const product = () => {
    let left = factor()
    while (left && (tokens[at] === "*" || tokens[at] === "/")) {
      const operator = tokens[at++]
      const right = factor()
      if (!right) return null
      if (operator === "*") {
        if (left.length && right.length) return null
        left = { value: left.value * right.value, length: left.length || right.length }
      } else {
        if (right.length || right.value === 0) return null
        left = { value: left.value / right.value, length: left.length }
      }
    }
    return left
  }
  const sum = () => {
    let left = product()
    while (left && (tokens[at] === "+" || tokens[at] === "-")) {
      const operator = tokens[at++]
      const right = product()
      if (!right || right.length !== left.length) return null
      left = { value: operator === "+" ? left.value + right.value : left.value - right.value, length: left.length }
    }
    return left
  }
  const result = sum()
  if (!result || at !== tokens.length || !Number.isFinite(result.value)) return null
  const rounded = Math.round(result.value * 10000) / 10000
  return result.length ? `${rounded}px` : String(rounded)
}

/**
 * A declaration's value as far as this file can settle it: the alias chain
 * followed, the references inside it filled in, then any `calc()` left worked
 * out. What cannot be settled comes back as it was, for the per-group
 * validation to refuse.
 *
 * The inner references matter beyond `calc()`. A shadow assembled from its
 * parts (`var(--x) var(--y) var(--blur) var(--shadow-color)`) and a colour
 * built around a channel variable read as nothing until the parts were in.
 */
function settleValue(raw, lookup) {
  let resolved = resolveValue(raw, lookup)
  if (/\bvar\(/i.test(String(resolved))) resolved = substituteVariables(resolved, lookup) ?? resolved
  if (!/^calc\(/i.test(String(resolved).trim())) return resolved
  return evaluateCalc(resolved) || resolved
}

/** `text` split on `separator` wherever it is not inside parentheses. */
function splitTopLevel(text, separator) {
  const parts = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === "(") depth += 1
    else if (char === ")") depth = Math.max(0, depth - 1)
    else if (depth === 0 && separator.test(char)) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** One length a shadow can be built from: a measure, a zero, or arithmetic over them. */
const SHADOW_LENGTH = /^(-?\d*\.?\d+(px|rem|em|vw|vh)|-?0*\.?0+|(calc|min|max|clamp|var)\(.*\))$/i

/**
 * Whether a value can be written as a `box-shadow`: `none`, or layers that each
 * hold two to four lengths once the colour and `inset` are set aside.
 *
 * Any length used to pass, so the PARTS of a shadow — a system that publishes
 * its offset, blur and spread scales as tokens of their own — listed in the
 * shadow picker as shadows: `--x-shadow-blur-md: 8px` written as a box-shadow
 * is an invalid declaration, and the browser drops it.
 */
function shadowShaped(text) {
  const value = String(text).trim()
  if (value.toLowerCase() === "none") return true
  const layers = splitTopLevel(value, /,/)
  return (
    layers.length > 0 &&
    layers.every((layer) => {
      const lengths = splitTopLevel(layer, /\s/).filter(
        (part) => part.toLowerCase() !== "inset" && !paintableColor(part) && !/^color-mix\(/i.test(part)
      )
      return lengths.length >= 2 && lengths.length <= 4 && lengths.every((part) => SHADOW_LENGTH.test(part))
    })
  )
}

/**
 * The CSS colour keywords, so a system that spells a token `white` or
 * `transparent` is not told its palette is unpaintable. The list is finite and
 * frozen by the spec, which is the only reason hard-coding it is honest.
 */
const NAMED_COLORS = new Set(
  `transparent currentcolor aliceblue antiquewhite aqua aquamarine azure beige bisque black
   blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral
   cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen
   darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
   darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
   deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro
   ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory
   khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
   lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
   lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
   magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
   mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
   mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
   palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
   powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen
   seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan
   teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`
    .trim()
    .split(/\s+/)
)

const HEX_COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const COLOR_FUNCTION = /^(rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i
const SINGLE_LENGTH = /^(-?\d*\.?\d+)(px|rem|em)?$/i
const DURATION = /^(-?\d*\.?\d+)(ms|s)$/i
const LENGTH_SOMEWHERE = /(^|[\s(,])-?\d*\.?\d+(px|rem|em)\b/i

/** Two to four numbers, optionally percentages, optionally with a slashed alpha. */
const BARE_CHANNELS = /^-?\d*\.?\d+%?([\s,]+-?\d*\.?\d+%?){1,3}(\s*\/\s*-?\d*\.?\d+%?)?$/

/**
 * A hue followed by two PERCENTAGES: `hsl()`'s argument list and nothing else's.
 *
 * The percentages are what make this safe to recognise without being told. A
 * saturation and a lightness are percentages by definition, while the channel
 * triple this module deliberately refuses — `31, 31, 31` under a `-rgb` name —
 * is three bare 0-255 integers. So the shape identifies the function even when
 * the file never names it, which is the only reason guessing is allowed here.
 */
const HSL_TRIPLE = /^-?\d*\.?\d+(deg)?[\s,]+\d*\.?\d+%[\s,]+\d*\.?\d+%(\s*\/\s*-?\d*\.?\d+%?)?$/

/**
 * Which colour function a variable is spliced into, learned from the file that
 * declares it: `hsl(var(--background))` says `--background` is an `hsl`
 * argument list.
 *
 * Read out of the source rather than guessed, because the guess is what makes
 * the difference between reading a palette and inventing one. A file that never
 * writes the wrapper gets no entry and its bare triples are dropped exactly as
 * before.
 */
const COLOR_WRAPPER = /\b(rgba?|hsla?|oklch|oklab|lab|lch)\(\s*(?:from\s+)?var\(\s*(--[a-zA-Z0-9_-]+)/gi

function colorWrappers(source) {
  const wrappers = new Map()
  for (const match of String(source).matchAll(COLOR_WRAPPER)) {
    if (!wrappers.has(match[2])) wrappers.set(match[2], match[1].toLowerCase())
  }
  return wrappers
}

/**
 * Can this string be painted?
 *
 * The case this exists for is a channel triple — a value like `31, 31, 31`,
 * declared under a name ending in `-rgb` so that a consumer can splice it into
 * `rgba(var(--x), .5)`. It is named like a colour, it lives beside colours, and
 * written into `background-color` it paints nothing at all. Every other
 * unpaintable value the rule catches is a bonus; this is the one that motivated
 * it.
 *
 * Which was right in general and wrong about the single most-copied token
 * layout in existence. Pre-Tailwind-v4 shadcn/ui writes its entire palette as
 * bare triples — `--background: 0 0% 100%` — and consumes them as
 * `hsl(var(--background))`, so a stylesheet a designer would describe as "my
 * colours" read as zero colours and a lone radius. The refusal has therefore
 * grown two ways out, and both RECOVER the function rather than assuming one:
 * `wrapper` is the function the same file was seen splicing this variable into,
 * and the fallback recognises `hsl()`'s own argument shape, which a 0-255
 * triple cannot be mistaken for. A value that answers to neither is still
 * dropped, so nothing this function accepted before has changed.
 */
function paintableColor(value, wrapper = null) {
  const text = String(value).trim()
  if (!text) return null
  if (HEX_COLOR.test(text)) return text
  if (COLOR_FUNCTION.test(text) && text.endsWith(")")) return text
  if (NAMED_COLORS.has(text.toLowerCase())) return text
  if (wrapper && BARE_CHANNELS.test(text)) return `${wrapper}(${text})`
  return HSL_TRIPLE.test(text) ? `hsl(${text})` : null
}

/**
 * `{ cssFunction }` for a colour whose variable is an argument list rather
 * than a colour, or nothing.
 *
 * `paintableColor` recovers `--background: 0 0% 100%` as `hsl(0 0% 100%)` so
 * the swatch is right — but a pick writes the VARIABLE, and
 * `background-color: var(--background)` is `0 0% 100%`, which paints nothing.
 * The element lost its background on every pick from such a palette. The
 * function travels with the token so the write can wrap the variable in it.
 */
function channelFunction(value, wrapper) {
  const text = String(value).trim()
  if (BARE_CHANNELS.test(text) && wrapper) return { cssFunction: wrapper }
  if (HSL_TRIPLE.test(text)) return { cssFunction: wrapper ?? "hsl" }
  return {}
}

/** A single length in px, or null. A multi-value shorthand is not a scalar and says so. */
function singleLength(value) {
  const match = SINGLE_LENGTH.exec(String(value).trim())
  if (!match) return null
  const number = Number.parseFloat(match[1])
  if (!Number.isFinite(number)) return null
  const unit = (match[2] ?? "").toLowerCase()
  return unit === "rem" || unit === "em" ? number * ROOT_FONT_SIZE : number
}

/**
 * A single length as a STYLESHEET states one: unitless only when it is zero.
 *
 * `singleLength` accepts a bare number because a token file and a variables
 * export write lengths that way. A custom property cannot: `gap: var(--x)` with
 * `--x: 16` is an invalid declaration, so a picker that offered it would write
 * a value the browser throws away. It is also how an icon font's other settings
 * look — `--x-icon-scale-m-opsz: 20`, `-wght: 320`, `-grad: 0` sit beside its
 * size under the same `icon-scale` name, and read with `singleLength` they
 * listed as twenty-five more icon sizes.
 */
function cssLength(value) {
  const text = String(value).trim()
  if (/^-?\d*\.?\d+$/.test(text) && Number.parseFloat(text) !== 0) return null
  return singleLength(text)
}

/** Past this a spacing value is a sentinel for "no limit" rather than a step. */
const MAX_SPACING_PX = 2000

/** The axes whose tokens are one length, which a stylesheet has to state with a unit. */
const LENGTH_GROUPS = new Set(["spacing", "radii", "icons", "textStyles"])

/** Seconds, from either spelling of a duration. */
function durationSeconds(value) {
  const match = DURATION.exec(String(value).trim())
  if (!match) return null
  const number = Number.parseFloat(match[1])
  if (!Number.isFinite(number)) return null
  return match[2].toLowerCase() === "ms" ? number / 1000 : number
}

/**
 * The classification table, in the order it must be tested.
 *
 * Order is load-bearing three times over. `icon` before `size`, or every icon
 * scale lands in spacing. Colour before everything, because `--shadow-color` is
 * a colour and `--outline-color` is a colour and neither is the thing its other
 * word suggests. Easing before duration, because a system that writes
 * `--motion-ease-standard` has both words in the name and only one of them is
 * what the value is.
 *
 * The vocabulary is deliberately plain English. Anything vendor-specific here
 * would be a rule that works for one design system and silently reads nothing
 * from the next one, which is the failure this table was rewritten to fix.
 *
 * The null rows around the spacing rule are lengths that are not spacing. Each
 * one used to reach the spacing picker, by its `height` or `spacing` word or by
 * the value sniffer: letter-spacing and leading are type metrics, a blur is a
 * filter radius, a container or breakpoint width is a layout measure no gap or
 * padding is ever set to, and a border, outline or ring width is a stroke.
 * Measured across a dozen public design systems, they were up to half of what
 * the spacing axis listed. Their order is the load: `letter` + `spacing` has
 * to be read before `spacing` alone, while `leading`, `border` and `container`
 * come after the spacing words, so a `--padding-leading`, a `--border-spacing`
 * or a `--container-gap` is still a spacing step. A width or height on its own
 * is a size, and the editor has no size axis to offer it on; `size` alone stays
 * a spacing step, because that is the word a base scale is most often named by.
 */
const CLASSIFIER_RULES = [
  { words: ["size", "dimension", "scale"], requires: ["icon"], group: "icons", category: "icon-size" },
  { words: ["color", "colour", "palette", "ink", "fill", "stroke", "tint"], group: "colors", category: "color" },
  { words: ["shadow", "elevation"], group: "effects", category: "shadow" },
  { words: ["corner", "border", "radius", "radii", "rounded"], requires: ["radius", "radii", "rounded", "corner"], group: "radii", category: "radius" },
  // Not a group. See `motionDurationWrites` in src/core/design-system.ts: the
  // motion axis writes `transition-duration`, so an easing curve offered here
  // would be written as a duration, report success, and ship a different feel.
  // A delay is the same mistake: it is a duration, written as one it would set
  // how long the change takes rather than when it starts.
  { words: ["easing", "ease", "curve", "bezier", "spring", "delay"], group: null, category: null },
  { words: ["duration"], group: "motion", category: "motion" },
  { words: ["size"], requires: ["font"], group: "textStyles", category: "typography" },
  { words: ["spacing"], requires: ["letter"], group: null, category: null },
  { words: ["spacing"], requires: ["word"], group: null, category: null },
  { words: ["height"], requires: ["line"], group: null, category: null },
  { words: ["spacing", "space", "spacer", "spacers", "gap", "inset", "margin", "padding"], group: "spacing", category: "spacing" },
  {
    words: ["tracking", "leading", "kerning", "letterspacing", "lineheight", "wordspacing", "blur", "perspective"],
    group: null,
    category: null,
  },
  { words: ["border", "borders", "outline", "ring", "divider", "thickness", "scrollbar"], group: null, category: null },
  {
    words: ["container", "containers", "breakpoint", "breakpoints", "screen", "screens", "viewport"],
    group: null,
    category: null,
  },
  { words: ["width", "height"], group: null, category: null },
  { words: ["size", "track"], group: "spacing", category: "spacing" },
]

/**
 * Which rule the name answers to, and which word earned it.
 *
 * The word index comes back with the verdict because the display name is built
 * by cutting the name off after it — the designer reading the picker wants
 * `small`, not the four layers of namespace in front of it. It is the LAST word
 * of the run the rule matched, so `corner-radius-100` lists as `100` rather
 * than `radius-100`.
 *
 * `requires` is any one of several words, and the radius row uses it to say
 * that `border` and `corner` only make a radius beside a radius word: a lone
 * `border` is a stroke width, two rows down.
 */
function classifyName(words) {
  for (const rule of CLASSIFIER_RULES) {
    const wordIndex = words.findIndex((word) => rule.words.includes(word))
    if (wordIndex === -1) continue
    // The run never takes the last word: in `--color-ink` the leaf is itself a
    // colour word, and the name is what is left after the run.
    let end = wordIndex
    while (end + 2 < words.length && rule.words.includes(words[end + 1])) end += 1
    if (rule.requires) {
      const requiredIndex = words.findIndex((word) => rule.requires.includes(word))
      if (requiredIndex === -1) continue
      return { group: rule.group, category: rule.category, matchIndex: Math.max(end, requiredIndex) }
    }
    return { group: rule.group, category: rule.category, matchIndex: end }
  }
  return null
}

/**
 * A name verdict, with its word mapped back to a segment — unless the name only
 * REFUSED the token and the value is a colour.
 *
 * The refusing rows name lengths that are not spacing: a border width, a ring
 * width, a tracking. The same words name paints just as often —
 * `--x-primary-border-subtle: #9ec5fe`, a bare `--ring: #9dd2ff` — and a
 * refusal there threw a system's border colours away. The words were never
 * about colours, so a colour value overrules them, and is named in full.
 */
function colorOverRefusal(named, owner, value, wrapper) {
  if (!named) return null
  if (named.group === null && paintableColor(value, wrapper)) {
    return { group: "colors", category: "color", matchIndex: -1 }
  }
  return { ...named, matchIndex: named.matchIndex < 0 ? -1 : owner[named.matchIndex] }
}

/** The value has the last word when the name had nothing to say. */
function classifyValue(value, wrapper = null) {
  if (paintableColor(value, wrapper)) return { group: "colors", category: "color", matchIndex: -1 }
  if (/^-?\d*\.?\d+(px|rem|em)$/i.test(String(value).trim())) {
    return { group: "spacing", category: "spacing", matchIndex: -1 }
  }
  // A transition's length is recognisable on sight: `--x-fast: 150ms` is a
  // duration whatever its name says, and a name that said `delay` or `ease`
  // was already answered above.
  const seconds = durationSeconds(value)
  if (seconds !== null && seconds >= 0) return { group: "motion", category: "motion", matchIndex: -1 }
  return null
}

/**
 * A custom property's name as the words a classifier reads, and the hyphen
 * segment each word came from.
 *
 * Hyphens are not the only boundary a design system spells. A camel hump is one
 * (`--borderRadius-small`, `--text-body-lineHeight-large`), a digit glued to a
 * word is one (`--shadow4`), and a doubled hyphen is a separator rather than an
 * empty word (`--x-t--global--spacer--md`). Read on hyphens alone, the first
 * filed a whole corner scale under spacing and the last made a system read as
 * no tokens at all. The owner index maps a word back to the segment it came
 * from, because the label is cut out of the name as it was written.
 */
function nameWords(name) {
  const segments = String(name).replace(/^--/, "").split("-")
  const words = []
  const owner = []
  const spans = []
  segments.forEach((segment, index) => {
    for (const piece of segmentPieces(segment)) {
      words.push(piece.word)
      owner.push(index)
      spans.push(piece)
    }
  })
  return { segments, words, owner, spans }
}

/**
 * A segment's words and where each one sits in it. A camel hump and a letter
 * running into a digit are boundaries; anything but a letter or a digit
 * separates. The offsets let a name be cut at a hump with the spelling on
 * either side kept as written.
 */
function segmentPieces(segment) {
  const pieces = []
  let start = -1
  for (let index = 0; index <= segment.length; index += 1) {
    const char = segment[index] ?? ""
    const previous = segment[index - 1] ?? ""
    const alphanumeric = /[A-Za-z0-9]/.test(char)
    const hump = (/[a-z]/.test(previous) && /[A-Z]/.test(char)) || (/[A-Za-z]/.test(previous) && /[0-9]/.test(char))
    if (start !== -1 && (!alphanumeric || hump)) {
      pieces.push({ start, end: index, word: segment.slice(start, index).toLowerCase() })
      start = -1
    }
    if (alphanumeric && start === -1) start = index
  }
  return pieces
}

/** What follows word `index` inside its own segment: `Medium` in `borderRadiusMedium`. */
function segmentRest({ segments, owner, spans }, index) {
  return segments[owner[index]].slice(spans[index].end).replace(/^[^A-Za-z0-9]+/, "")
}

/** `Medium` as `medium` once a camel hump no longer starts it. `XLarge` and `M` stay as written. */
function uncapitalize(text) {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text
}

/**
 * The leading segments every token shares — the vendor namespace.
 *
 * Worth stripping because it is pure noise in a picker: every row would begin
 * with the same three words, spending the column width that the part telling
 * them apart needs. Worth stripping CAREFULLY, hence the floor: in a file with
 * two tokens a shared first segment is a coincidence, and the run is never
 * allowed to eat a whole name.
 */
function vendorPrefix(names) {
  if (names.length < VENDOR_PREFIX_MIN_TOKENS) return 0
  const lists = names.map((name) => name.slice(2).toLowerCase().split("-"))
  const shortest = Math.min(...lists.map((list) => list.length))
  let run = 0
  while (run < shortest - 1 && lists.every((list) => list[run] === lists[0][run])) run += 1
  return run
}

/**
 * The name a designer reads, from the name a platform team wrote.
 *
 * Two cuts, in this order: the shared vendor namespace, then everything up to
 * and including the word that classified the token. What is left is the part
 * that distinguishes this token from its neighbours, which is the only part a
 * picker has room for. Either cut can leave nothing — a token called exactly
 * `--x-spacing` after its prefix goes — so each step falls back to the longer
 * name rather than to an empty string.
 *
 * `rest` is what follows the classifying word inside its own segment. A name
 * spelled in one camel-cased run has nothing after that segment, so without it
 * `--borderRadiusMedium` listed under its whole name instead of as `medium`.
 */
function displayName(fullName, matchIndex, prefixRun, rest = "") {
  const segments = fullName.slice(2).split("-")
  const withoutVendor = segments.slice(prefixRun)
  if (matchIndex >= prefixRun) {
    const cut = [rest, ...withoutVendor.slice(matchIndex - prefixRun + 1)].filter(Boolean)
    if (cut.length) return cut.join("-")
  }
  const vendorOnly = withoutVendor.filter(Boolean)
  if (vendorOnly.length) return vendorOnly.join("-")
  return fullName.slice(2)
}

/** The four properties a text style is spelled with, whatever the house style. */
const TEXT_STYLE_ROLES = ["font-size", "line-height", "letter-spacing", "font-weight"]
const TEXT_STYLE_KEYS = {
  "font-size": "fontSize",
  "line-height": "lineHeight",
  "letter-spacing": "letterSpacing",
  "font-weight": "fontWeight",
}

/**
 * The words a type role is spelled with, longest first at any position, so
 * `font-line-height` is one role rather than a stray `font` and a line height.
 *
 * The bare words (`size`, `weight`, `line`, …) are only a role in two places: at
 * the END of a name, where the family guard below asks for a sibling, or after
 * a word that says the name is about type (`text`, `type`, `font`, …). Anywhere
 * else a bare `size` is a spacing step — `--size-4`, `--base-size-8` — and
 * reading it as a font size would empty a system's spacing scale into its text
 * styles. `line` alone only ever trails.
 */
const ROLE_SPELLINGS = [
  [["font", "letter", "spacing"], "letter-spacing", false],
  [["font", "line", "height"], "line-height", false],
  [["letter", "spacing"], "letter-spacing", false],
  [["line", "height"], "line-height", false],
  [["font", "size"], "font-size", false],
  [["font", "weight"], "font-weight", false],
  [["tracking"], "letter-spacing", true],
  [["leading"], "line-height", true],
  [["weight"], "font-weight", true],
  [["size"], "font-size", true],
  [["line"], "line-height", true],
]
const TYPE_WORDS = new Set(["text", "type", "typescale", "typography", "font"])

/**
 * The type role a custom property names, with what comes before and after it,
 * or null.
 *
 * One reading for every spelling, because the spellings differ only in where
 * the role sits. It leads (`--font-size-body`), it trails
 * (`--display-large-font-size`), or it sits in the middle between a role name
 * and a variant (`--text-body-size-large`, `--text-body-lineHeight-large`). The
 * last was read by none of the three patterns this replaced, so a system
 * spelled that way listed every size as a style with no leading and no weight.
 *
 * A camel hump is a boundary like a hyphen, so the role can also start or end
 * inside a segment, and the rest of that segment stays with the stem or the
 * variant. A system that spells each name as one camel-cased run
 * (`--fontSizeBase300`, `--lineHeightBase300`) otherwise had no role at all,
 * and listed every size as a style whose leading was its own size.
 */
function typeRole(name) {
  const parsed = nameWords(name)
  const { segments, words, owner, spans } = parsed
  for (let index = 0; index < words.length; index += 1) {
    for (const [spelling, role, bare] of ROLE_SPELLINGS) {
      if (!spelling.every((word, offset) => words[index + offset] === word)) continue
      const last = index + spelling.length - 1
      const head = segments[owner[index]].slice(0, spans[index].start).replace(/[^A-Za-z0-9]+$/, "")
      const tail = uncapitalize(segmentRest(parsed, last))
      const before = [...segments.slice(0, owner[index]).filter(Boolean), head].filter(Boolean)
      const after = [tail, ...segments.slice(owner[last] + 1).filter(Boolean)].filter(Boolean)
      const trailing = after.length === 0
      if (spelling.length === 1 && spelling[0] === "line" && !trailing) continue
      if (bare && !trailing && !words.slice(0, index).some((word) => TYPE_WORDS.has(word))) continue
      return { role, before, after, trailing, words }
    }
  }
  return null
}

/**
 * Collect the text-style families before anything else is classified.
 *
 * A text style is the one token that is not one declaration. Tailwind v4 puts
 * its role in a double-dashed suffix (`--text-lg`, `--text-lg--line-height`);
 * every other spelling is read by `typeRole`, and the family is everything that
 * shares the part before the role and the part after it.
 *
 * All of a family must collapse to ONE token, because what the inspector
 * applies is a text style rather than four unrelated numbers. Left uncollected
 * they do something worse than nothing: a line height is a length under a name
 * containing `height`, and a designer opening the gap picker is offered thirty
 * font metrics.
 *
 * Three rules keep families honest:
 *
 * - A family needs a size, and a trailing spelling needs a second role, so a
 *   lone `--icon-size` stays an icon size. Anything released goes back for
 *   ordinary classification rather than being dropped.
 * - A numbered step pairs across roles only when the roles share their
 *   numbering. `--font-size-3` and `--line-height-3` are one style in a system
 *   whose sizes and leadings are numbered 1–9 alike; in a system whose weights
 *   run 1–9 for 100–900 beside sizes numbered 00–8, `--font-weight-3` has
 *   nothing to do with `--font-size-3`, and pairing them invented a 20px style
 *   in weight 300.
 * - A variant inherits what its role shares: `--text-body-weight` is the weight
 *   of `--text-body-size-large` and of `--text-body-size-small`.
 *
 * A family whose name says `icon` is not a text style at all, and it comes back
 * separately as `icons`. An icon font is sized the way text is — a glyph is a
 * character, so its size is a font size and its box a line height — and a
 * system that ships one spells its icon scale with exactly these roles. Read as
 * text styles they filled the text-style picker with `icon-scale-s` through
 * `icon-scale-xxl` and left the icon-size picker empty. Its members stay
 * claimed, so the line height does not fall through to spacing either.
 */
function textStyleFamilies(values) {
  const families = new Map()
  const claimed = new Set()

  const family = (key, fields) => {
    const existing = families.get(key)
    if (existing) return existing
    const created = { key, members: {}, vars: {}, order: families.size, ...fields }
    families.set(key, created)
    return created
  }

  for (const [name, value] of values) {
    const found = typeRole(name)
    // Tailwind v4: the head carries the size, the relatives carry the rest. A
    // head is only a head when nothing else in the name is a role — the middle
    // spelling (`--text-body-size-large`) starts with `--text-` too.
    const tailwind = /^--text-(.+?)(?:--(line-height|letter-spacing|font-weight))?$/.exec(name)
    if (tailwind && !tailwind[1].includes("--") && (tailwind[2] || !found)) {
      const role = tailwind[2] ?? "font-size"
      // A head whose value is not a length is not a text style at all —
      // `--text-muted: #6b7280` is a colour that happens to share the namespace,
      // and `--text-opacity: 0.8` is a number that happens to.
      if (role === "font-size" && cssLength(value) === null) continue
      const entry = family(`tailwind|${tailwind[1]}`, {
        words: tailwind[1].toLowerCase().split("-"),
        before: [],
        after: [tailwind[1]],
        utility: `text-${tailwind[1]}`,
        label: tailwind[1],
      })
      entry.members[role] = value
      entry.vars[role] = name
      claimed.add(name)
      continue
    }
    if (!found) continue
    const key = `${found.before.join("-")}|${found.after.join("-")}`.toLowerCase()
    const entry = family(key, {
      words: found.words,
      before: found.before,
      after: found.after,
      trailing: found.trailing,
      numbered: found.after.length === 1 && /^\d+$/.test(found.after[0]),
    })
    // Two members can claim one role — `-size` and `-font-size` on the same
    // stem — and the first one wins rather than the last, so the reading does
    // not depend on declaration order.
    if (entry.members[found.role] === undefined) {
      entry.members[found.role] = value
      entry.vars[found.role] = name
    }
    claimed.add(name)
  }

  const release = (entry, role) => {
    claimed.delete(entry.vars[role])
    delete entry.members[role]
    delete entry.vars[role]
  }

  // Shared numbering: per stem, a role pairs by number only if it numbers the
  // same steps the sizes do.
  const numbered = [...families.values()].filter((entry) => entry.numbered)
  for (const stem of new Set(numbered.map((entry) => entry.before.join("-").toLowerCase()))) {
    const steps = numbered.filter((entry) => entry.before.join("-").toLowerCase() === stem)
    const numbersOf = (role) =>
      steps.filter((entry) => entry.members[role] !== undefined).map((entry) => entry.after[0]).sort().join(",")
    const sizes = numbersOf("font-size")
    for (const role of TEXT_STYLE_ROLES.filter((each) => each !== "font-size")) {
      if (numbersOf(role) === sizes) continue
      for (const entry of steps) if (entry.members[role] !== undefined) release(entry, role)
    }
  }

  // Inherited roles: a variant takes what its stem declares once for all of them.
  for (const entry of families.values()) {
    if (entry.trailing || entry.utility) continue
    const shared = families.get(`${entry.before.join("-")}|`.toLowerCase())
    if (!shared) continue
    for (const role of TEXT_STYLE_ROLES) {
      if (entry.members[role] !== undefined || shared.members[role] === undefined) continue
      entry.members[role] = shared.members[role]
      entry.vars[role] = shared.vars[role]
    }
  }

  const icons = []
  for (const entry of [...families.values()]) {
    const sized = entry.members["font-size"] !== undefined && cssLength(entry.members["font-size"]) !== null
    const enough = !entry.trailing || Object.keys(entry.members).length >= 2
    if (sized && enough && entry.words.includes("icon")) {
      families.delete(entry.key)
      icons.push(entry)
      continue
    }
    if (sized && enough) continue
    families.delete(entry.key)
    for (const name of Object.values(entry.vars)) {
      // A role a variant inherited is still that variant's; only release what
      // no surviving family points at.
      if (![...families.values()].some((other) => Object.values(other.vars).includes(name))) {
        claimed.delete(name)
      }
    }
  }
  const ordered = (list) => list.sort((a, b) => a.order - b.order)
  return { families: ordered([...families.values()]), icons: ordered(icons), claimed }
}

/**
 * How many non-empty segments of `name` the shared vendor namespace covers.
 *
 * `vendorPrefix` counts the segments a hyphen split makes, empties included,
 * because `displayName` cuts the name exactly as written. A family keeps its
 * segments without the empties a doubled hyphen leaves, so its cut has to be
 * counted the same way or it would eat the role name along with the vendor.
 */
function vendorWords(name, prefixRun) {
  return String(name).slice(2).split("-").slice(0, prefixRun).filter(Boolean).length
}

/**
 * The stem most of the text-style families in the file share, as lower-cased
 * words.
 *
 * The vendor prefix is measured over every token in the file, and one name
 * with another prefix stops it short: a system whose type tokens all read
 * `--x-t--global--font--size--*` listed them as `t-global-100`, because a
 * handful of component variables beside them start `--x-v6-…`. The namespace
 * the type ramp lives in is the stem more than half of its families share. A
 * minority stem is somebody's role name (`button`, `input`), and stays in the
 * label.
 */
function sharedFamilyStem(entries) {
  const stems = entries.filter((entry) => !entry.utility).map((entry) => entry.before.map((word) => word.toLowerCase()))
  if (stems.length < 2) return []
  const counts = new Map()
  for (const stem of stems) {
    for (let length = 1; length <= stem.length; length += 1) {
      const key = stem.slice(0, length).join("-")
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let best = ""
  for (const [key, count] of counts) {
    if (count * 2 > stems.length && key.split("-").length > best.split("-").filter(Boolean).length) best = key
  }
  return best ? best.split("-") : []
}

/** A family's name: its stem without the shared namespace or a leading type word, then its variant. */
function familyLabel(entry, prefixRun, sharedStem = []) {
  if (entry.label) return entry.label
  const head = Object.values(entry.vars)[0] ?? ""
  const lowered = entry.before.map((word) => word.toLowerCase())
  const shares = sharedStem.length > 0 && sharedStem.every((word, index) => lowered[index] === word)
  let cut = Math.max(shares ? sharedStem.length : 0, vendorWords(head, prefixRun))
  // A trailing family's stem IS its name, so at least one word of it stays.
  if (entry.trailing) cut = Math.min(cut, entry.before.length - 1)
  const stem = entry.before.slice(Math.max(0, cut))
  while (stem.length > (entry.trailing ? 1 : 0) && TYPE_WORDS.has(stem[0].toLowerCase())) stem.shift()
  if (stem.length) stem[0] = shedTypeWord(stem[0])
  return [...stem, ...entry.after].join("-") || "base"
}

/** A segment without the type word a camel hump glued to its front: `typographyBody` reads `body`. */
function shedTypeWord(segment) {
  const pieces = segmentPieces(segment)
  if (pieces.length < 2 || !TYPE_WORDS.has(pieces[0].word)) return segment
  return uncapitalize(segment.slice(pieces[1].start))
}

/** The words an icon scale is spelled with, which say nothing about which step this is. */
const ICON_SCALE_WORDS = new Set(["icon", "icons", "size", "sizes", "scale", "dimension"])

/**
 * An icon-font family as the icon size it is: its font size, under the name of
 * the step it is.
 *
 * Named by what follows the last scale word, the way `displayName` cuts a
 * classified token after the word that classified it — so
 * `--x-icon-scale-m-font-size` lists as `m` beside `--x-icon-size-action`
 * listing as `action`. The font size is the variable it points at, because it
 * is the one member that IS the size.
 */
function iconFamilyToken(entry, prefixRun = 0) {
  const size = singleLength(entry.members["font-size"])
  if (size === null) return null
  const words = [...entry.before.slice(vendorWords(entry.vars["font-size"], prefixRun)), ...entry.after]
  const lowered = words.map((word) => word.toLowerCase())
  const cut = Math.max(...lowered.map((word, index) => (ICON_SCALE_WORDS.has(word) ? index : -1)))
  const label = words.slice(cut + 1).join("-") || words.join("-") || entry.vars["font-size"].slice(2)
  return {
    id: tokenId("icon-size", label),
    name: label,
    category: "icon-size",
    cssVar: entry.vars["font-size"],
    values: { default: size },
  }
}

/**
 * A line height in px, from any of its spellings: a length, a unitless ratio, a
 * percentage of the size. Null when there is nothing readable to go on.
 *
 * A ratio and a pixel count are both bare numbers — `1.5` and `24` are the same
 * leading on a 16px body — and `LINE_HEIGHT_RATIO_MAX` is what tells them
 * apart. The token-file lane needed this as much as the stylesheet lane did:
 * the format's own definition of a typography line height is a ratio, and it
 * was read as that many pixels.
 */
function leadingPx(raw, fontSize) {
  const text = raw === undefined || raw === null ? "" : String(raw).trim()
  if (!text) return null
  const percent = /^(-?\d*\.?\d+)%$/.exec(text)
  const measured = percent ? null : singleLength(text)
  let px = null
  if (percent) px = (Number.parseFloat(percent[1]) / 100) * fontSize
  else if (measured !== null) {
    const unitless = /^-?\d*\.?\d+$/.test(text)
    px = unitless && measured <= LINE_HEIGHT_RATIO_MAX ? measured * fontSize : measured
  }
  return px === null ? null : Math.round(px * 100) / 100
}

/**
 * A font weight as the number CSS computes it to, or null.
 *
 * The names are the Design Tokens Format Module's own table (§8.4), and the
 * keywords `normal` and `bold` are CSS's. Exporters write the names in every
 * casing and spacing — `SemiBold`, `semi-bold`, `Semi Bold` — so they are
 * compared with all of that removed.
 */
const FONT_WEIGHT_NAMES = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300,
  normal: 400, regular: 400, book: 400, medium: 500, semibold: 600, demibold: 600,
  bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
  extrablack: 950, ultrablack: 950,
}

function weightNumber(raw) {
  const text = raw === undefined || raw === null ? "" : String(raw).trim()
  if (!text) return null
  if (/^\d*\.?\d+$/.test(text)) return Number.parseFloat(text)
  return FONT_WEIGHT_NAMES[text.toLowerCase().replace(/[^a-z]/g, "")] ?? null
}

function textStyleToken(entry, prefixRun = 0, sharedStem = []) {
  const fontSize = singleLength(entry.members["font-size"])
  if (fontSize === null) return null

  const lineHeight = leadingPx(entry.members["line-height"], fontSize) ?? fontSize

  // Tracking keeps the authored number rather than being converted. `-0.01em`
  // and `-0.16px` are both ordinary spellings of the same tracking and the
  // catalog says which one this system meant, in `trackingUnit`.
  const rawTracking = entry.members["letter-spacing"]
  const tracking = rawTracking === undefined ? 0 : Number.parseFloat(String(rawTracking))
  const rawWeight = entry.members["font-weight"]
  const weight = rawWeight === undefined ? null : Number.parseFloat(String(rawWeight))

  const cssVars = {}
  for (const role of TEXT_STYLE_ROLES) {
    if (entry.vars[role]) cssVars[TEXT_STYLE_KEYS[role]] = entry.vars[role]
  }
  const label = familyLabel(entry, prefixRun, sharedStem)

  return {
    id: tokenId("typography", label),
    name: label,
    category: "typography",
    cssVars,
    ...(entry.utility ? { cssUtility: entry.utility } : {}),
    values: {
      default: {
        fontSize,
        lineHeight,
        letterSpacing: Number.isFinite(tracking) ? tracking : 0,
        ...(weight !== null && Number.isFinite(weight) ? { fontWeight: weight } : {}),
      },
    },
  }
}

/**
 * Turn a classified declaration into a token, or refuse it.
 *
 * This is the gate described in the header: everything above decided WHERE a
 * declaration belongs, and this decides whether it can be written at all. A
 * refusal here is not a failure — an unresolved alias, a shorthand, a channel
 * triple and a gradient all arrive as perfectly well-formed declarations that
 * this editor has no honest way to apply.
 */
function tokenValues(group, value, wrapper = null) {
  if (group === "colors") {
    const color = paintableColor(value, wrapper)
    return color === null ? null : { light: color }
  }
  if (group === "spacing" || group === "radii" || group === "icons") {
    const length = singleLength(value)
    // A gap wider than a screen is a stand-in for "unbounded" (`999999999px`),
    // not a step a designer picks. A radius that size is the usual "full".
    if (group === "spacing" && length !== null && Math.abs(length) > MAX_SPACING_PX) return null
    return length === null ? null : { default: length }
  }
  if (group === "motion") {
    const seconds = durationSeconds(value)
    return seconds === null || seconds < 0 ? null : { default: { visualDuration: seconds, bounce: 0 } }
  }
  if (group === "effects") {
    const text = String(value).trim()
    return shadowShaped(text) ? { default: text } : null
  }
  return null
}

/**
 * Custom properties that are a framework's working memory rather than anybody's
 * design token.
 *
 * `--tw-*` is a reserved implementation namespace: the variables a utility
 * framework writes at run time to compose a shadow out of its parts, or to hold
 * the current gradient stop. They are declared on `*` with placeholder values,
 * which makes them indistinguishable from tokens to everything downstream — so
 * a compiled stylesheet contributed `tw-gradient-from`, `tw-ring-offset-color`
 * and `tw-scrollbar-thumb` to the colour picker, sitting among the real ones
 * with nothing to mark them as scaffolding.
 *
 * Dropped by prefix rather than by guessing at their shape, because the prefix
 * is the contract: it is reserved precisely so that nothing else may use it,
 * which makes this the one exclusion that cannot take a real token with it.
 */
const FRAMEWORK_INTERNAL = /^--tw-/

/**
 * The custom properties a stylesheet registers with `inherits: false`.
 *
 * A theme token works by inheritance: it is declared once on the root and every
 * descendant reads it. Registering a property as non-inheriting says the
 * opposite — each element holds its own value, starting from the registered
 * initial — which is what a utility's working state is (a scroll fade's current
 * inset, a shimmer's position) and what a token can never be. Utility plugins
 * also restate those initials on `*` for browsers without `@property`, and that
 * block is unconditional, so four `--scroll-fade-*: 0px` channels arrived in the
 * spacing picker as tokens and the margin row offered them as what a 0px margin
 * "could be".
 */
function uninheritedProperties(text) {
  const names = new Set()
  const css = String(text).replace(/\/\*[\s\S]*?\*\//g, "")
  for (const match of css.matchAll(/@property\s+(--[a-zA-Z0-9_-]+)\s*\{([^}]*)\}/g)) {
    if (/\binherits\s*:\s*false\b/i.test(match[2])) names.add(match[1])
  }
  return names
}

/**
 * Properties a type role may set besides the four a text style carries.
 *
 * A rule is only read as a text style when EVERY declaration in it is about the
 * type: the moment it also sets a colour, a margin or a display it is a
 * component that happens to have a font size, and offering it as a text style
 * would apply that component's typography under a name nobody chose for it.
 */
const TYPE_ROLE_PROPERTIES = new Set([
  "font-size", "line-height", "font-weight", "letter-spacing", "font-family", "font-style",
  "font-stretch", "font-variation-settings", "font-feature-settings", "font-optical-sizing",
  "font-kerning", "font-synthesis", "font-variant", "font-variant-numeric", "font-variant-caps",
  "font-variant-ligatures", "text-transform", "text-rendering", "word-spacing",
  "-webkit-font-smoothing", "-moz-osx-font-smoothing",
])

/** A selector that is one class and nothing else. */
const SINGLE_CLASS = /^\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)$/

/** Where a text style's size has to be stated: a fixed length, never relative to its parent. */
const FIXED_SIZE = /^(\d*\.?\d+)(px|rem)$/i

/**
 * Text styles a stylesheet ships as CLASSES, which is how most systems outside
 * Tailwind ship them.
 *
 * `.x-body-m { font-size: 15px; line-height: 20px; font-weight: 400 }` is a
 * type role with a name, and a system that spells its whole type ramp that way
 * declares no custom property for any of it — so a reader of custom properties
 * found no text styles in it at all, and the picker was left with whatever
 * else happened to have a font size. Four tests decide which rules qualify,
 * each a reason the rule could be something else: it is one plain class, at
 * the top level or inside a cascade layer (a media query makes it a variant,
 * not a role); it states a fixed size AND a line height; every declaration in
 * it is about type; and its name does not say `icon`, for the reason
 * `textStyleFamilies` gives.
 *
 * A class whose name a custom-property family already answers to — a compiled
 * Tailwind `.text-lg` beside `--text-lg` — is that family, and is left to it.
 */
function typeRoleClasses(ordinary, lookup, takenUtilities) {
  const blocks = new Map()
  for (const declaration of ordinary) {
    let block = blocks.get(declaration.block)
    if (!block) {
      block = { scopes: declaration.scopes, properties: new Map() }
      blocks.set(declaration.block, block)
    }
    block.properties.set(declaration.property, declaration.value.replace(/\s*!important\s*$/i, ""))
  }

  const roles = new Map()
  for (const block of blocks.values()) {
    const selector = block.scopes[block.scopes.length - 1] ?? ""
    const className = SINGLE_CLASS.exec(selector.trim())?.[1]
    if (!className || takenUtilities.has(className) || componentPart(className)) continue
    if (!block.scopes.slice(0, -1).every((scope) => /^@layer\b/i.test(scope.trim()))) continue
    if (className.toLowerCase().split(/[^a-z0-9]+/).includes("icon")) continue
    if (![...block.properties.keys()].every((property) => TYPE_ROLE_PROPERTIES.has(property))) continue
    const role = roles.get(className) ?? new Map()
    for (const [property, value] of block.properties) role.set(property, value)
    roles.set(className, role)
  }

  const read = []
  for (const [className, properties] of roles) {
    const size = FIXED_SIZE.exec(String(settleValue(properties.get("font-size") ?? "", lookup)).trim())
    if (!size) continue
    const fontSize = singleLength(size[0])
    const lineHeight = leadingPx(settleValue(properties.get("line-height") ?? "", lookup), fontSize)
    if (lineHeight === null || lineHeight <= 0) continue
    const tracking = String(settleValue(properties.get("letter-spacing") ?? "", lookup)).trim()
    const trackingMatch = /^(-?\d*\.?\d+)(px|em|rem)?$/i.exec(tracking)
    // Settled to literals, because they are written into a page that may not
    // declare the variables they were authored with. One that cannot be settled
    // is left out rather than written as a reference to nothing.
    const literal = (property) => {
      const raw = properties.get(property)
      if (raw === undefined) return null
      const text = substituteVariables(raw, lookup)
      return text === null || /\bvar\(/i.test(text) || !text.trim() ? null : text.trim()
    }
    read.push({
      className,
      fontSize,
      lineHeight,
      fontWeight: weightNumber(settleValue(properties.get("font-weight") ?? "", lookup)),
      tracking: trackingMatch
        ? { value: Number.parseFloat(trackingMatch[1]), unit: (trackingMatch[2] ?? "px").toLowerCase() }
        : { value: 0, unit: "px" },
      fontFamily: literal("font-family"),
      fontStyle: literal("font-style"),
      fontVariationSettings: literal("font-variation-settings"),
    })
    if (read.length >= MAX_TYPE_ROLES) break
  }
  return read
}

/**
 * Whether a class is a part of a component rather than a role of its own: a
 * BEM element (`__title`) or a modifier (`--sm`). A namespace written with a
 * doubled hyphen (`x--type-body-01`) is the one doubled hyphen a role may
 * carry. A component stylesheet sets type on its parts all the time —
 * `accordion__title` sets nothing but a font size, a leading and a weight — and
 * read as text styles they filled the picker with one component's internals.
 */
function componentPart(className) {
  if (className.includes("__")) return true
  const doubled = className.split("--").length - 1
  return doubled > 1 || (doubled === 1 && !/^[a-zA-Z0-9]+--/.test(className))
}

/** A ceiling on the classes read as type roles: a type ramp, not a utility sheet. */
const MAX_TYPE_ROLES = 200

/** Tracking in the unit the catalog states, converted through the style's own size. */
function trackingIn(unit, tracking, fontSize) {
  const px =
    tracking.unit === "em"
      ? tracking.value * fontSize
      : tracking.unit === "rem"
        ? tracking.value * ROOT_FONT_SIZE
        : tracking.value
  const value = unit === "em" ? (tracking.unit === "em" ? tracking.value : px / fontSize) : px
  return Math.round(value * 10000) / 10000
}

function parseCssLibrary(text, name) {
  const uninherited = uninheritedProperties(text)
  const ordinary = []
  const declarations = cssDeclarations(text, ordinary).filter(
    (declaration) => !FRAMEWORK_INTERNAL.test(declaration.name) && !uninherited.has(declaration.name)
  )
  if (declarations.length === 0) {
    throw new Error("This stylesheet declares no CSS custom properties, so it carries no tokens")
  }
  // Read off the whole file, including the utility rules below the token block,
  // because that is where a system that stores bare channels states what they
  // are channels OF.
  const wrappers = colorWrappers(text)
  const zones = themeZones(declarations)

  const themed = declarations.map((declaration) => {
    const theme = declarationTheme(declaration.scopes, zones)
    return {
      ...declaration,
      theme,
      darkTerms: theme === "dark" ? darkSelectorTerms(declaration.scopes) : null,
    }
  })
  // A fragment with no `:root` and no theme block at all is still somebody's
  // token file — an `@import`ed partial, a snippet pasted out of a doc. Reading
  // nothing from it would be pedantry, so when no block was recognised the
  // whole file is the base theme.
  const recognised = themed.some((declaration) => declaration.theme !== null)
  const anyBase = themed.some((declaration) => declaration.theme === "light")

  /*
   * A theme block is a real declaration site, but it is not an authority over
   * the default. Both halves of that sentence are load-bearing, and dropping
   * either one breaks a real design system.
   *
   * Drop the first half — refuse anything that is not `:root` or a dark block —
   * and a system that declares a token ONLY inside, say, a high-contrast theme
   * loses it entirely. The designer looks at the inspector, sees no row for a
   * colour they can point at in their own stylesheet, and concludes the editor
   * cannot read their design system. It declared the token; the editor simply
   * refused to look in the block it was declared in.
   *
   * Drop the second half — flatten every block into one map and let the last
   * declaration win — and the answer is worse than missing, because it is
   * confidently wrong. A mature system ships four of these blocks, and the last
   * one in the file is usually the least ordinary: a high-contrast palette, or
   * a print theme. Flattened, its values become THE values, and every picker in
   * the editor hands the designer an accessibility variant as if it were the
   * default they were looking at on screen.
   *
   * So the tiers rank by how conditional they are. The base tier is what the
   * stylesheet says unconditionally, and inside it the browser's own rule
   * applies: last declaration wins. A themed block may only ADD — a name no
   * base block mentions is a token that exists nowhere else, so taking it is
   * strictly better than losing it — and among themselves the first block to
   * mention a name wins, so the reading does not swing on which accessibility
   * variant somebody appended most recently.
   *
   * The promotion below is the case that stops this from being too clever. A
   * stylesheet is allowed to have no unconditional block at all: a system whose
   * every token lives under `:root[data-theme^='…']` never writes a bare
   * `:root`, and demoting all of it to "may only add" would make the FIRST
   * theme block the default and contradict what the browser actually paints.
   * When there is no base tier, the themed tier IS the base tier, last-wins and
   * all — the file has no more unconditional statement to prefer.
   *
   * Dark is the same rule, one rung down. Everything above is about ranking
   * blocks by how conditional they are, and "is dark" is only the FIRST of the
   * conditions a block can carry: a system that ships a dark theme and a
   * high-contrast dark theme has two dark blocks, and the second one is the
   * conditional one exactly as a high-contrast light block is. Read them
   * flatly and the picker's dark swatch is the accessibility variant, which is
   * the same wrong answer as before, just behind a toggle where it takes a
   * designer longer to notice.
   *
   * So the dark blocks split the same way: the plain one — dark and nothing
   * else — is the authority, last-wins, and a dark block carrying a further
   * distinction may only ADD a name no plain dark block declares, first-wins.
   * Plainness is decided by comparing the blocks against each other rather than
   * by knowing any system's theme names: strip the plumbing words out of each
   * dark selector, and whatever vocabulary ALL of them share is the system's
   * own namespace, not a distinction. A block that spends a word none of its
   * siblings spends is the one being distinguished.
   *
   * And the promotion is mirrored, for the same reason it exists above: a file
   * whose only dark blocks are distinguished ones has no plainer statement to
   * prefer, so they become the dark authority, last-wins.
   */
  const darkTerms = themed.map((declaration) => declaration.darkTerms).filter(Boolean)
  const sharedDarkTerms = darkTerms.reduce(
    (shared, terms) => new Set([...shared].filter((word) => terms.has(word))),
    darkTerms[0] ?? new Set()
  )
  const isPlainDark = (declaration) =>
    declaration.darkTerms !== null &&
    [...declaration.darkTerms].every((word) => sharedDarkTerms.has(word))
  const anyPlainDark = themed.some(isPlainDark)

  const base = new Map()
  const darkBase = new Map()
  const contributed = new Map()
  const darkContributed = new Map()
  const tierOf = (declaration) => {
    if (!recognised) return "light"
    // A theme recognised only by repeating another's vocabulary says nothing
    // about which one is the default, so it is never promoted to last-wins:
    // the first one the file declares stands, and the rest may only add.
    if (declaration.theme === "zone") return "theme"
    if (declaration.theme === "theme") return anyBase ? "theme" : "light"
    if (declaration.theme === "dark") {
      return !anyPlainDark || isPlainDark(declaration) ? "dark" : "dark-theme"
    }
    return declaration.theme
  }
  /*
   * Among themed blocks the first to declare a name wins — unless a later one
   * says it is the default. A system that ships its scales only as variants
   * (`[data-radius='none']`, `[data-radius='medium']`, …, chosen at run time)
   * declares no default outside them, and first-wins read its corners as the
   * `none` variant: every radius 0. A variant that names itself `medium`,
   * `default`, `normal`, `regular`, `base` or `100%` is the one a page gets
   * when nobody chose.
   */
  const contributedRank = new Map()
  for (const declaration of themed) {
    const tier = tierOf(declaration)
    if (tier === "light") base.set(declaration.name, declaration.value)
    else if (tier === "dark") darkBase.set(declaration.name, declaration.value)
    else if (tier === "theme") {
      const rank = declaration.scopes.some((scope) => DEFAULT_VARIANT.test(scope.toLowerCase())) ? 1 : 0
      if (!contributed.has(declaration.name) || rank > contributedRank.get(declaration.name)) {
        contributed.set(declaration.name, declaration.value)
        contributedRank.set(declaration.name, rank)
      }
    } else if (tier === "dark-theme" && !darkContributed.has(declaration.name)) {
      darkContributed.set(declaration.name, declaration.value)
    }
  }
  for (const name of base.keys()) contributed.delete(name)
  for (const name of darkBase.keys()) darkContributed.delete(name)
  const light = new Map([...base, ...contributed])
  const dark = new Map([...darkBase, ...darkContributed])

  // Dark falls through to light on a miss: a dark theme normally redeclares the
  // handful of names that change and leaves the ramp it points into alone.
  const lightLookup = (variable) => light.get(variable)
  const darkLookup = (variable) => (dark.has(variable) ? dark.get(variable) : light.get(variable))
  const lightValues = new Map(
    [...light].map(([variable, value]) => [variable, settleValue(value, lightLookup)])
  )
  const darkValues = new Map(
    [...dark].map(([variable, value]) => [variable, settleValue(value, darkLookup)])
  )

  const { families, icons: iconFamilies, claimed } = textStyleFamilies(lightValues)

  const classified = []
  for (const [variable, value] of lightValues) {
    if (claimed.has(variable)) continue
    // A Tailwind relative whose head is missing is a fragment of a style, not a
    // token. Any OTHER doubled hyphen is a separator: a system can spell every
    // name that way, and skipping them all read such a system as empty.
    if (/^--text-.+--(line-height|letter-spacing|font-weight)$/.test(variable)) continue
    const parsed = nameWords(variable)
    const wrapper = wrappers.get(variable) ?? null
    const named = classifyName(parsed.words)
    const verdict = colorOverRefusal(named, parsed.owner, value, wrapper) ?? classifyValue(value, wrapper)
    if (!verdict || !verdict.group) continue
    const length = LENGTH_GROUPS.has(verdict.group) ? cssLength(value) : null
    if (LENGTH_GROUPS.has(verdict.group) && length === null) continue
    // Zero is a real spacing step and a real corner, and never a size: an icon
    // or a font drawn at 0px is not there. It is what an icon font's axis
    // settings (`-fill: 0`, `-grad: 0`) look like when they share the scale's
    // name.
    if ((verdict.group === "icons" || verdict.group === "textStyles") && !(length > 0)) continue
    // A text style is built from the family pass, not from one value, so the
    // only thing a lone declaration can contribute is a size. It still becomes
    // a style rather than nothing: a system that ships sizes and no leading is
    // a system whose leading is whatever the element inherits.
    const values = verdict.group === "textStyles" ? null : tokenValues(verdict.group, value, wrapper)
    if (verdict.group !== "textStyles" && !values) continue
    if (verdict.group === "textStyles" && singleLength(value) === null) continue
    if (verdict.group === "colors") {
      const darkValue = darkValues.has(variable)
        ? paintableColor(darkValues.get(variable), wrapper)
        : null
      if (darkValue) values.dark = darkValue
    }
    const rest = verdict.matchIndex >= 0 ? uncapitalize(segmentRest(parsed, named.matchIndex)) : ""
    classified.push({ variable, value, verdict, values, rest })
  }

  // Every name the file spends on a token, families included, so the shared
  // namespace is measured against the whole vocabulary rather than the half of
  // it that happens not to be typography.
  const prefixRun = vendorPrefix([
    ...[...families, ...iconFamilies].flatMap((entry) => Object.values(entry.vars)),
    ...classified.map((entry) => entry.variable),
  ])
  const catalog = emptyCatalog(name)
  const seen = new Set()
  /*
   * Unique, because the picker selects and binds by id. Two families can
   * shorten onto one name — a system's base `small` and its button's `small`
   * once the vendor is cut — and two tokens under one id made the picker bind
   * whichever came first, whichever was picked. The longer spelling is bought
   * back on a collision, as it is for every other token below.
   */
  const distinct = (token, longer) => {
    if (!token) return null
    for (const name of [token.name, ...longer]) {
      const id = tokenId(token.category, name)
      if (seen.has(id)) continue
      seen.add(id)
      return { ...token, id, name }
    }
    return null
  }
  const spelled = (entry) => {
    const head = Object.values(entry.vars)[0] ?? ""
    return [[...entry.before, ...entry.after].join("-"), head.slice(2)]
  }
  const sharedStem = sharedFamilyStem(families)
  catalog.textStyles = families
    .map((entry) => distinct(textStyleToken(entry, prefixRun, sharedStem), spelled(entry)))
    .filter(Boolean)
  catalog.icons = iconFamilies
    .map((entry) => distinct(iconFamilyToken(entry, prefixRun), spelled(entry)))
    .filter(Boolean)
  for (const entry of classified) {
    // Two namespaces can shorten onto the same word — a ref scale and a system
    // scale both ending `-4`. Rather than drop the loser or let one silently
    // overwrite the other in `tokenIndex`, the collision buys back the length
    // it just gave away.
    const candidates = [
      displayName(entry.variable, entry.verdict.matchIndex, prefixRun, entry.rest),
      displayName(entry.variable, -1, prefixRun),
      entry.variable.slice(2),
    ]
    const label = candidates.find((candidate) => !seen.has(tokenId(entry.verdict.category, candidate)))
    if (!label) continue
    const id = tokenId(entry.verdict.category, label)
    seen.add(id)
    if (entry.verdict.group === "textStyles") {
      const fontSize = singleLength(entry.value)
      catalog.textStyles.push({
        id,
        name: label,
        category: "typography",
        cssVars: { fontSize: entry.variable },
        values: { default: { fontSize, lineHeight: fontSize, letterSpacing: 0 } },
      })
      continue
    }
    catalog[entry.verdict.group].push({
      id,
      name: label,
      category: entry.verdict.category,
      cssVar: entry.variable,
      ...(entry.verdict.group === "colors" ? channelFunction(entry.value, wrappers.get(entry.variable)) : {}),
      values: entry.values,
    })
  }

  const tracking = families.some((entry) => /em$/i.test(String(entry.members["letter-spacing"] ?? "")))
  catalog.trackingUnit = tracking ? "em" : "px"

  // Named after what is left once the namespace every role class shares is cut,
  // the same cut the custom properties get: `x-body-m` lists as `body-m`.
  const roles = typeRoleClasses(
    ordinary,
    lightLookup,
    new Set(families.map((entry) => entry.utility).filter(Boolean))
  )
  const rolePrefix = vendorPrefix(roles.map((role) => `--${role.className}`))
  for (const role of roles) {
    const short = role.className.split("-").slice(rolePrefix).join("-")
    const label = [short, role.className].find((candidate) => !seen.has(tokenId("typography", candidate)))
    if (!label) continue
    const id = tokenId("typography", label)
    seen.add(id)
    catalog.textStyles.push({
      id,
      name: label,
      category: "typography",
      // No `cssVars`, so a pick writes the values themselves: the class only
      // exists where this stylesheet is loaded, and the page being edited may
      // not load it. The class is still how an element already wearing the
      // style is recognised as bound to it.
      cssUtility: role.className,
      values: {
        default: {
          fontSize: role.fontSize,
          lineHeight: role.lineHeight,
          letterSpacing: trackingIn(catalog.trackingUnit, role.tracking, role.fontSize),
          ...(role.fontWeight !== null ? { fontWeight: role.fontWeight } : {}),
          // A role is more than its four numbers. A system's body and code
          // styles can share 15/20/400 and differ only in family; its caption
          // is the italic one. Without these, picking `code` set body text.
          ...(role.fontFamily ? { fontFamily: role.fontFamily } : {}),
          ...(role.fontStyle ? { fontStyle: role.fontStyle } : {}),
          ...(role.fontVariationSettings ? { fontVariationSettings: role.fontVariationSettings } : {}),
        },
      },
    })
  }
  return catalog
}

/* ------------------------------------------------------------------------- */
/* Design tokens (DTCG / Style Dictionary)                                    */
/* ------------------------------------------------------------------------- */

/**
 * `$type` as the exporting tool spelled it, mapped onto this editor's axes.
 *
 * The keys are already normalized — lower-cased, letters only — so one entry
 * covers `borderRadius`, `border-radius` and `BORDERRADIUS`, which is three
 * house styles for one idea.
 *
 * The entries mapping to a null group are the load-bearing half. A type this
 * editor has no axis for is not the same as a type it has never heard of: a
 * line height is `1.5`, a letter spacing is `-0.01em` and an opacity is `0.6`,
 * and left unlisted every one of them falls through to the value sniffer and
 * lands in the SPACING picker as a plausible-looking step. Naming them here
 * spends one line each to say "recognised, and deliberately not offered" —
 * the same bargain the easing rule strikes in the CSS classifier.
 */
const TOKEN_TYPE_GROUPS = {
  color: { group: "colors", category: "color" },
  dimension: { group: "spacing", category: "spacing" },
  spacing: { group: "spacing", category: "spacing" },
  size: { group: "spacing", category: "spacing" },
  // A tool that keeps a separate sizing scale (Tokens Studio does) means the
  // same axis by it: a length a designer picks a width or a gap from.
  sizing: { group: "spacing", category: "spacing" },
  borderwidth: { group: "spacing", category: "spacing" },
  borderradius: { group: "radii", category: "radius" },
  radius: { group: "radii", category: "radius" },
  shadow: { group: "effects", category: "shadow" },
  boxshadow: { group: "effects", category: "shadow" },
  duration: { group: "motion", category: "motion" },
  typography: { group: "textStyles", category: "typography" },
  fontsize: { group: "textStyles", category: "typography" },
  fontsizes: { group: "textStyles", category: "typography" },
  lineheight: { group: null, category: null },
  lineheights: { group: null, category: null },
  letterspacing: { group: null, category: null },
  paragraphspacing: { group: null, category: null },
  fontweight: { group: null, category: null },
  fontweights: { group: null, category: null },
  fontfamily: { group: null, category: null },
  fontfamilies: { group: null, category: null },
  opacity: { group: null, category: null },
  cubicbezier: { group: null, category: null },
  textcase: { group: null, category: null },
  textdecoration: { group: null, category: null },
}

/**
 * The type a leaf inherits when it declares none of its own.
 *
 * The Design Tokens Format Module is explicit about this (§5.2.2): a token's
 * type comes from the closest ancestor group that declares one, and a tool
 * "MUST NOT attempt to guess the type of a token by inspecting the contents of
 * its value". Reading the leaf alone did exactly that guess, and the guess is
 * wrong in the same direction every time — a `borderRadius` group's `"4px"`
 * sniffed as spacing, a `duration` group's `"120ms"` and a `shadow` group's
 * composite sniffed as nothing at all and dropped. Group-level `$type` is how
 * every hand-written DTCG file avoids repeating itself, so this is not an
 * exotic spelling; it is the ordinary one.
 *
 * Only `$type` is inherited, never the bare `type` key. `type` at a GROUP level
 * is as likely to be somebody's token named `type` as it is a declaration, and
 * the older exporters that spell it without the dollar never inherited it
 * anyway.
 */
function tokenLeaves(node, path, leaves, inherited = "") {
  if (leaves.length >= MAX_TOKEN_LEAVES || !isPlainObject(node)) return
  const groupType = typeof node.$type === "string" ? node.$type : inherited
  for (const [key, value] of Object.entries(node)) {
    if (!isPlainObject(value)) continue
    const next = [...path, key]
    if (value.$value !== undefined || value.value !== undefined) {
      const raw = value.$value !== undefined ? value.$value : value.value
      leaves.push({
        path: next,
        // `{ "value": 4, "unit": "px" }` is the spec's object dimension, not a
        // Style Dictionary leaf whose value happens to be 4. The sibling `unit`
        // is the only thing that tells them apart, and reading `value` alone
        // turned a 4px step into a bare 4 with no complaint.
        value: typeof value.unit === "string" ? { value: raw, unit: value.unit } : raw,
        type:
          typeof value.$type === "string"
            ? value.$type
            : typeof value.type === "string"
              ? value.type
              : groupType,
      })
      continue
    }
    tokenLeaves(value, next, leaves, groupType)
  }
}

/**
 * Every string or number leaf in the tree, named by the path that reaches it.
 *
 * The lane above requires a `$value` or a `value` key, which is the DTCG and
 * Style Dictionary contract and is not how most JSON a designer has to hand is
 * written. A theme object exported from a component library, a theme
 * generator's JSON export, a Tailwind theme dumped to JSON, a palette
 * package's `colors.json` — all of them are plain nested objects whose leaves
 * are bare strings, and all of them read as zero tokens because every one of
 * those leaves was skipped outright.
 *
 * Reading them costs nothing in accuracy, because the classifier downstream is
 * the same one the CSS lane relies on and it refuses anything it cannot write.
 * A leaf that is not a colour, a length or a duration simply produces no token,
 * which is the same outcome as never having looked at it.
 *
 * `$`-prefixed keys are skipped because they are the file talking about itself —
 * `$schema`, and the `$themes`/`$metadata` blocks a token manager writes beside
 * its sets.
 */
function plainLeaves(node, path, leaves) {
  if (leaves.length >= MAX_TOKEN_LEAVES || !isPlainObject(node)) return
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue
    const next = [...path, key]
    if (typeof value === "string" || typeof value === "number") {
      leaves.push({ path: next, value, type: "" })
      continue
    }
    plainLeaves(value, next, leaves)
  }
}

/** 0–1 float RGBA, the only colour shape the Figma REST API emits, as hex. */
function figmaColorHex(value) {
  if (!isPlainObject(value)) return null
  const channel = (raw) => {
    const number = Number(raw)
    if (!Number.isFinite(number)) return null
    return Math.max(0, Math.min(255, Math.round(number * 255)))
  }
  const parts = [channel(value.r), channel(value.g), channel(value.b)]
  if (parts.some((part) => part === null)) return null
  const alpha = value.a === undefined ? 1 : Number(value.a)
  if (Number.isFinite(alpha) && alpha < 1) parts.push(channel(alpha))
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`
}

/**
 * `GET /v1/files/:key/variables/local`, read as tokens.
 *
 * This is the canonical machine-readable export of a design system held in
 * Figma — the file a designer gets when they ask for their variables rather
 * than for somebody's build output — and nothing else in this module could see
 * it, because a variable carries neither a `$value` nor a nested value: its
 * values live in `valuesByMode`, keyed by opaque mode ids, and its colours are
 * 0–1 floats rather than anything CSS would accept.
 *
 * The modes are what make this worth a branch of its own rather than a plain
 * walk. A collection's modes ARE the light and dark themes, named by whoever
 * built the file, so the pair a colour picker wants is already in the export
 * and only needs the default mode and the dark-named one picked out of it. With
 * no collection metadata to read, the first mode is taken and no dark value is
 * claimed — a guess about which of two unnamed modes is the dark one is exactly
 * the guess that puts a black swatch under a light label.
 */
function figmaVariableLeaves(parsed) {
  const meta = isPlainObject(parsed) ? parsed.meta : null
  const variables = isPlainObject(meta) && isPlainObject(meta.variables) ? meta.variables : null
  if (!variables) return null

  const tiers = new Map()
  const collections = isPlainObject(meta.variableCollections) ? meta.variableCollections : {}
  for (const [id, collection] of Object.entries(collections)) {
    if (!isPlainObject(collection)) continue
    const modes = Array.isArray(collection.modes) ? collection.modes.filter(isPlainObject) : []
    const dark = modes.find((mode) => DARK_SELECTOR.test(String(mode.name ?? "").toLowerCase()))
    tiers.set(id, {
      light:
        typeof collection.defaultModeId === "string" ? collection.defaultModeId : modes[0]?.modeId,
      dark: dark ? dark.modeId : null,
    })
  }

  // An alias points at another variable and is read in the SAME mode, which is
  // what makes a semantic layer resolve to its own dark value rather than to
  // the primitive's default.
  const read = (variable, modeId, depth = 0) => {
    if (!isPlainObject(variable) || depth >= MAX_ALIAS_DEPTH) return undefined
    const byMode = isPlainObject(variable.valuesByMode) ? variable.valuesByMode : {}
    const chosen = modeId != null && modeId in byMode ? modeId : Object.keys(byMode)[0]
    if (chosen === undefined) return undefined
    const value = byMode[chosen]
    if (isPlainObject(value) && value.type === "VARIABLE_ALIAS") {
      return read(variables[value.id], modeId, depth + 1)
    }
    return value
  }

  const leaves = []
  for (const variable of Object.values(variables)) {
    if (leaves.length >= MAX_TOKEN_LEAVES) break
    if (!isPlainObject(variable) || typeof variable.name !== "string") continue
    const path = variable.name.split("/").map((part) => part.trim()).filter(Boolean)
    if (path.length === 0) continue
    const tier = tiers.get(variable.variableCollectionId) ?? {}
    const raw = read(variable, tier.light)
    const isColor = variable.resolvedType === "COLOR"
    const value = isColor ? figmaColorHex(raw) : raw
    if (value === null || value === undefined || typeof value === "boolean") continue
    if (isPlainObject(value)) continue
    const leaf = { path, value, type: isColor ? "color" : "" }
    if (isColor && tier.dark) {
      const dark = figmaColorHex(read(variable, tier.dark))
      if (dark && dark !== value) leaf.dark = dark
    }
    leaves.push(leaf)
  }
  return leaves.length ? leaves : null
}

/**
 * The object forms the current spec made normative, flattened back to the CSS
 * string every validator in this module reads.
 *
 * Every one of these is the 2024-onwards Design Tokens Format Module spelling
 * of something this editor already understood as a string, and collapsing a
 * non-string value to `""` dropped all of them: an object dimension, an object
 * colour, and the shadow composite — which is the whole of a system's elevation
 * scale, since nobody writes a box-shadow as one string once their tool offers
 * the parts.
 */
function tokenText(value) {
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    // A layered shadow is a list of shadows and joins the way CSS joins them.
    // A list whose parts are not all readable is not a value at all, and says
    // so rather than contributing half of itself.
    const parts = value.map(tokenText)
    return parts.every(Boolean) ? parts.join(", ") : ""
  }
  if (!isPlainObject(value)) return ""
  if (value.value !== undefined && typeof value.unit === "string") {
    return `${tokenText(value.value)}${value.unit}`
  }
  if (typeof value.hex === "string") return value.hex
  if (typeof value.colorSpace === "string" && Array.isArray(value.components)) {
    const alpha = typeof value.alpha === "number" && value.alpha < 1 ? ` / ${value.alpha}` : ""
    return `color(${value.colorSpace} ${value.components.join(" ")}${alpha})`
  }
  if (value.offsetX !== undefined || value.offsetY !== undefined || value.blur !== undefined) {
    return [
      value.inset ? "inset" : "",
      tokenText(value.offsetX ?? "0"),
      tokenText(value.offsetY ?? "0"),
      tokenText(value.blur ?? "0"),
      tokenText(value.spread ?? ""),
      tokenText(value.color ?? ""),
    ]
      .filter(Boolean)
      .join(" ")
  }
  return ""
}

/**
 * A token path as the word segments `classifyName` compares against.
 *
 * A camel hump is a word boundary here, which a hyphen is in the CSS lane. JSON
 * keys are written `borderRadius` and `fontSize` where a custom property is
 * written `--border-radius` and `--font-size`, and a classifier that only knows
 * the second spelling reads `borderRadius` as one unrecognised word and files
 * the system's whole corner scale under spacing.
 */
function leafSegments(path) {
  return path
    .flatMap((part) =>
      String(part)
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
    )
    .filter(Boolean)
}

/**
 * Which axis a leaf belongs to: its declared type, then its name, then its
 * value.
 *
 * The middle step is the one that was missing. The CSS lane has always read the
 * name before the value, and skipping that step here meant every radius, icon
 * size and font size in an untyped file landed in the SPACING picker, because
 * by then all three are just a number with `px` on the end. The token's path is
 * the name — it is right there in `leaf.path` and it is exactly the segment
 * list the classifier wants — so the two lanes now sort a file the same way.
 */
function leafVerdict(leaf, text) {
  const type = String(leaf.type).toLowerCase().replace(/[^a-z]/g, "")
  const typed = TOKEN_TYPE_GROUPS[type]
  if (typed && GENERIC_LENGTH_TYPES.has(type)) {
    const named = classifyName(leafSegments(leaf.path))
    if (named && LENGTH_VERDICTS.has(named.group)) return named
  }
  if (typed) return typed
  const segments = leafSegments(leaf.path)
  return colorOverRefusal(classifyName(segments), segments.map((_, index) => index), text, null) ?? classifyValue(text)
}

/**
 * The declared types that say "a length" and nothing about which one.
 *
 * The format has no radius, icon-size or font-size type: a corner scale, an
 * icon scale and a type ramp are all `dimension`, and so are a line height and
 * a letter spacing. Taking that type as the whole answer filed every one of
 * them under spacing. The path still says which length it is, so for these
 * types the name decides between the length axes — and only between those: a
 * `dimension` under a `stroke` group is a stroke WIDTH, not a colour, so a
 * name verdict for any other axis is ignored and the type stands.
 */
const GENERIC_LENGTH_TYPES = new Set(["dimension", "size", "sizing"])
const LENGTH_VERDICTS = new Set(["spacing", "radii", "icons", "textStyles", null])

/**
 * `{color.brand.500}` — the reference syntax every exporter in this family
 * shares, resolved here for the same reason CSS aliases are: a token file that
 * has been through a theming layer is mostly references, and reading only the
 * literals reads only the primitive ramp the designer never picks from.
 *
 * Two dialects, and the difference is one suffix. Style Dictionary v3 documents
 * a reference as `{color.core.blue.500.value}` — the path all the way down to
 * the leaf KEY — and v4 stops at the token. Looking the v3 spelling up verbatim
 * never hits, so the raw `{…}` string fell through to the value sniffer, which
 * refused it, and every alias in the file vanished. That is not a tail case: in
 * a real system the semantic layer is nearly all aliases, so what was dropped
 * was precisely the layer a designer picks from, leaving behind the primitive
 * ramp nobody names a colour by.
 *
 * The literal path is tried first so that a system whose token really is called
 * `value` still resolves; the suffix is only stripped when nothing answers.
 */
function resolveTokenReference(value, byPath, depth = 0, trail = new Set()) {
  if (typeof value !== "string") return value
  const match = /^\{([^{}]+)\}$/.exec(value.trim())
  if (!match) return value
  const raw = match[1].trim()
  const key = byPath.has(raw) ? raw : raw.replace(/\.\$?value$/, "")
  if (depth >= MAX_ALIAS_DEPTH || trail.has(key) || !byPath.has(key)) return value
  return resolveTokenReference(byPath.get(key), byPath, depth + 1, new Set([...trail, key]))
}

/**
 * Every path a reference in this file might be written against.
 *
 * One file, two coordinate systems, which is what a token manager's multi-set
 * export looks like from here. The sets are top-level groups — `global`,
 * `light`, `dark` — so a leaf's real path is `global.colors.primary`, but a
 * reference inside the file is written against the RESOLVED set stack and says
 * `{colors.primary}`. Indexed by full path alone, every cross-set alias missed
 * and the themed half of the file came back empty.
 *
 * So each set contributes its paths a second time with the set name stripped,
 * walked in the order `$metadata.tokenSetOrder` declares, which is the order the
 * exporting tool resolves them in: a later set in the stack overrides an
 * earlier one, exactly as it would in the tool. A stripped path never displaces
 * a real full path, so a file whose sets happen to be named after its groups
 * still resolves the way it reads.
 */
function tokenPathIndex(parsed, leaves) {
  const byPath = new Map(leaves.map((leaf) => [leaf.path.join("."), leaf.value]))
  const metadata = isPlainObject(parsed) ? parsed.$metadata : null
  const order =
    isPlainObject(metadata) && Array.isArray(metadata.tokenSetOrder)
      ? metadata.tokenSetOrder.filter((entry) => typeof entry === "string")
      : []
  if (order.length === 0) return byPath
  const full = new Set(byPath.keys())
  for (const set of order) {
    for (const leaf of leaves) {
      if (leaf.path.length < 2 || leaf.path[0] !== set) continue
      const key = leaf.path.slice(1).join(".")
      if (!full.has(key)) byPath.set(key, leaf.value)
    }
  }
  return byPath
}

/**
 * The leaves of a token file, whichever of the three shapes it arrived in.
 *
 * Ordered rather than merged, because the shapes overlap and the first one that
 * answers is the one the file was written in. A DTCG or Style Dictionary tree
 * is unambiguous and goes first. A Figma variables response is next, keyed on a
 * structure nothing else has. The plain walk is last and would claim any of
 * them, which is exactly why it only runs when the other two found nothing.
 *
 * `plain` comes back with the leaves because it changes what an empty result
 * MEANS. A DTCG file that yielded no usable token is still a token file and
 * installs as one; a plain object that yielded none was never a token file at
 * all, and saying so beats installing a card that brings nothing.
 */
function tokenFileLeaves(parsed) {
  const leaves = []
  tokenLeaves(parsed, [], leaves)
  if (leaves.length) return { leaves, plain: false }
  const figma = figmaVariableLeaves(parsed)
  if (figma) return { leaves: figma, plain: false }
  plainLeaves(parsed, [], leaves)
  return { leaves, plain: true }
}

const NO_TOKENS =
  "No tokens found. A token file is a tree of `$value` leaves (DTCG or Style Dictionary), " +
  "a Figma variables export, or plain nested JSON whose leaves are colours, lengths or durations"

function parseTokenLibrary(parsed, name) {
  if (!isPlainObject(parsed)) throw new Error("A token file must be an object of named tokens")
  const { leaves, plain } = tokenFileLeaves(parsed)
  if (leaves.length === 0) throw new Error(NO_TOKENS)

  const byPath = tokenPathIndex(parsed, leaves)
  const catalog = emptyCatalog(name)
  const seen = new Set()
  /** Each style's tracking as authored, converted once the file's unit is known. */
  const trackings = []

  for (const leaf of leaves) {
    const label = leaf.path.join("/")
    const value = resolveTokenReference(leaf.value, byPath)
    const text = tokenText(value)
    const verdict = leafVerdict(leaf, text)
    if (!verdict || !verdict.group) continue

    if (verdict.group === "textStyles") {
      // A scalar font size is a text style with nothing but a size, the same
      // reading the CSS lane gives a lone `--text-sm`. A tool that ships a
      // `fontSizes` scale and no composite is shipping a type ramp, and
      // refusing it because it lacks a leading would drop the whole ramp.
      const composite = isPlainObject(value) ? value : { fontSize: text }
      // Each field of a composite is a token value in its own right: it can be
      // a reference into the file (`"{font.size.lg}"`) or an object dimension
      // (`{ "value": 16, "unit": "px" }`), and read raw both came out as
      // nothing.
      const field = (key) => tokenText(resolveTokenReference(composite[key], byPath))
      const fontSize = singleLength(field("fontSize"))
      if (fontSize === null || fontSize <= 0) continue
      const lineHeight = leadingPx(field("lineHeight"), fontSize)
      const trackingText = field("letterSpacing").trim()
      const trackingMatch = /^(-?\d*\.?\d+)(px|em|rem)?$/i.exec(trackingText)
      const fontWeight = weightNumber(field("fontWeight"))
      const id = tokenId("typography", label)
      if (seen.has(id)) continue
      seen.add(id)
      const style = {
        id,
        name: label,
        category: "typography",
        values: {
          default: {
            fontSize,
            lineHeight: lineHeight === null ? fontSize : lineHeight,
            letterSpacing: 0,
            ...(fontWeight !== null ? { fontWeight } : {}),
          },
        },
      }
      if (trackingMatch) {
        trackings.push({
          style,
          tracking: { value: Number.parseFloat(trackingMatch[1]), unit: (trackingMatch[2] ?? "").toLowerCase() },
        })
      }
      catalog.textStyles.push(style)
      continue
    }

    const values = tokenValues(verdict.group, text)
    if (!values) continue
    // A source that carries its own themes — a variables export whose collection
    // has a dark mode — pairs them here, exactly as a `.dark` block does in the
    // CSS lane, so a colour is one row with two swatches rather than two rows.
    if (verdict.group === "colors" && leaf.dark !== undefined) {
      const dark = paintableColor(tokenText(resolveTokenReference(leaf.dark, byPath)))
      if (dark) values.dark = dark
    }
    const id = tokenId(verdict.category, label)
    if (seen.has(id)) continue
    seen.add(id)
    // No `cssVar`: these tokens are a build input, not a live custom property,
    // so there is no variable for the inspector to trace an authored value to.
    catalog[verdict.group].push({ id, name: label, category: verdict.category, values })
  }

  // A tree of `$value` leaves said what it was before anything was read out of
  // it, so an empty catalog from one is a token file this editor could not use.
  // A plain object said nothing — it is only a token file if tokens came out —
  // so an empty one was the wrong file, and it is told so rather than installed
  // as a card that brings nothing and explains nothing.
  if (plain && Object.values(libraryCounts(catalog)).every((count) => count === 0)) {
    throw new Error(NO_TOKENS)
  }

  // One unit for the whole catalog, because the catalog can only state one. A
  // file that mixes `-0.01em` and `0.5px` used to be declared an em file and
  // read its pixel tracking as that many ems — thirty-two times too wide on a
  // 16px body. Each style's own size converts it instead. A bare number keeps
  // the file's unit, whichever that turns out to be; it states none of its own.
  catalog.trackingUnit = trackings.some(({ tracking }) => tracking.unit === "em") ? "em" : "px"
  for (const { style, tracking } of trackings) {
    const authored = tracking.unit ? tracking : { value: tracking.value, unit: catalog.trackingUnit }
    style.values.default.letterSpacing = trackingIn(catalog.trackingUnit, authored, style.values.default.fontSize)
  }
  return catalog
}

/* ------------------------------------------------------------------------- */
/* Icons                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * One drawing, by the rules `server/icon-set.mjs` already applies to the host's
 * own set — a non-empty `nodes` array of `[tag, attrs]` pairs, `currentColor`
 * when no root fill was declared. Kept identical on purpose: the picker has one
 * renderer, and a library glyph that normalized differently would render
 * differently from a host glyph for no reason the user could see.
 */
function normalizeDrawing(name, raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.nodes) || raw.nodes.length === 0) return null
  const nodes = raw.nodes.filter(
    (node) => Array.isArray(node) && typeof node[0] === "string" && isPlainObject(node[1])
  )
  if (nodes.length === 0) return null
  return {
    name,
    nodes,
    rootFill: typeof raw.rootFill === "string" ? raw.rootFill : "currentColor",
    ...(typeof raw.rootStroke === "string" ? { rootStroke: raw.rootStroke } : {}),
  }
}

/** A glyph named but not drawn. Keys on `name` so the two dialects list alike. */
function glyphName(entry) {
  if (typeof entry === "string") return entry.trim() || null
  if (isPlainObject(entry) && typeof entry.name === "string") return entry.name.trim() || null
  return null
}

/**
 * The name list an icon FONT ships instead of path data.
 *
 * Half the icon libraries in the world are a font plus a manifest of ligature
 * names, and refusing them would mean the editor could only offer icons to
 * projects that had already inlined their SVGs. A glyph carries no `nodes`, so
 * it is flagged rather than faked: the picker lists it by name and lets the
 * page's own font draw it, which is what the host does with it anyway.
 */
function glyphList(parsed) {
  const source = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed.icons)
      ? parsed.icons
      : isPlainObject(parsed) && Array.isArray(parsed.names)
        ? parsed.names
        : null
  if (!source || source.length === 0) return null
  const names = source.map(glyphName)
  return names.every((name) => name !== null) ? names : null
}

function parseIconLibrary(parsed, name) {
  if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
    throw new Error("An icon file must be a name-to-drawing object, or a list of glyph names")
  }

  const catalog = emptyCatalog(name)
  const glyphs = glyphList(parsed)
  if (glyphs) {
    catalog.iconDrawings = glyphs
      .slice(0, MAX_GLYPH_NAMES)
      .map((glyph) => ({ name: glyph, nodes: [], rootFill: "currentColor", glyph: true }))
  } else {
    const drawings = []
    for (const [key, raw] of Object.entries(parsed)) {
      if (key.startsWith("$")) continue
      if (drawings.length >= MAX_ICON_DRAWINGS) break
      const drawing = normalizeDrawing(key, raw)
      if (drawing) drawings.push(drawing)
    }
    catalog.iconDrawings = drawings
  }

  /*
   * An icon library that yields no glyph is the same mistake as a stylesheet
   * with no custom properties in it, and it gets the same answer: the user
   * pointed at the wrong file.
   *
   * Dropping a malformed ENTRY is right — one broken drawing in a dump of four
   * hundred is not worth refusing the other three hundred and ninety-nine, and
   * that is what `normalizeDrawing` returning null is for. Dropping every entry
   * and installing the result is not the same thing. It puts a card in the
   * Libraries panel that brings nothing, explains nothing, and leaves the user
   * to work out on their own that the JSON they chose was a build config, an
   * empty array, or a sprite sheet in some other dialect. An error naming both
   * shapes this parser accepts tells them what to point at instead.
   */
  if (catalog.iconDrawings.length === 0) {
    throw new Error(
      "No icons found. An icon file is either a name-to-drawing object " +
        '(`{ "check": { "nodes": [["path", { "d": "…" }]] } }`) ' +
        'or a list of glyph names (`["check", "close"]`, or `{ "icons": [...] }`)'
    )
  }

  catalog.iconDrawings.sort((a, b) => a.name.localeCompare(b.name))
  // The attribute the host's markup names a glyph with. Defaulted rather than
  // required, because a library that does not declare one is still usable —
  // `data-icon` is the convention, and the store can be told otherwise.
  catalog.iconAttribute =
    isPlainObject(parsed) && typeof parsed.$attribute === "string" && parsed.$attribute.trim()
      ? parsed.$attribute.trim()
      : "data-icon"
  return catalog
}

/* ------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* ------------------------------------------------------------------------- */

function manifestComponents(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error("Invalid design-system manifest: components must be an array")
  return raw.map((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(`Invalid design-system manifest: components[${index}] needs a name`)
    }
    const props = entry.props === undefined || entry.props === null ? [] : entry.props
    if (!Array.isArray(props)) {
      throw new Error(`Invalid design-system manifest: components[${index}].props must be an array`)
    }
    return {
      id: `component:${slug(entry.name)}`,
      name: entry.name.trim(),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(typeof entry.snippet === "string" ? { snippet: entry.snippet } : {}),
      props: props.filter(isPlainObject).map((prop) => ({
        name: String(prop.name ?? ""),
        ...(typeof prop.type === "string" ? { type: prop.type } : {}),
        ...(Array.isArray(prop.values) ? { values: prop.values.map((value) => String(value)) } : {}),
      })),
    }
  })
}

function parseManifestLibrary(parsed, name) {
  const normalized = normalizeDesignSystemManifest(parsed)
  return {
    name: name || normalized.name || "Design system",
    trackingUnit: normalized.trackingUnit,
    colors: normalized.colors,
    spacing: normalized.spacing,
    radii: normalized.radii,
    textStyles: normalized.textStyles,
    uiTextStyles: normalized.uiTextStyles,
    effects: normalized.effects,
    icons: normalized.icons,
    motion: normalized.motion,
    components: manifestComponents(parsed.components),
    // Breakpoints are deliberately absent. They are a compile-time fact of the
    // HOST's build — a `md:` prefix only exists because the host's Tailwind
    // config emitted it — so a library offering one would put a prefix in the
    // inspector that compiles to nothing in the project being edited.
    iconDrawings: [],
    iconAttribute: "",
  }
}

/* ------------------------------------------------------------------------- */
/* Entry points                                                               */
/* ------------------------------------------------------------------------- */

/**
 * The absence rule, inherited from the manifest normalizer: a group the source
 * does not have is an empty axis, never an error. The inspector drops a row
 * whose category is empty, so a stylesheet with no motion scale simply has no
 * motion row.
 *
 * Exported for the sources that build a catalog without going through a parser
 * — a component list scanned off a story index, a source that could not be read
 * at all — so that the thirteen keys are declared in exactly one place.
 */
export function emptyCatalog(name) {
  return {
    name: name || "",
    trackingUnit: "px",
    colors: [],
    spacing: [],
    radii: [],
    textStyles: [],
    uiTextStyles: [],
    effects: [],
    icons: [],
    motion: [],
    components: [],
    iconDrawings: [],
    iconAttribute: "",
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Could not read this ${label}: ${error.message}`)
  }
}

/**
 * Parse a library's text into a catalog, or throw.
 *
 * Throwing is right here and dropping is right inside the parsers, and the line
 * between them is whether the user is being told something they can act on. A
 * file that is not the kind it claims to be is a mistake to surface. A single
 * token inside an otherwise good file that this editor cannot write is not —
 * refusing four hundred tokens over one gradient would make the feature useless
 * on exactly the mature design systems it exists for.
 */
export function parseLibrary(kind, text, { name } = {}) {
  const label = typeof name === "string" && name.trim() ? name.trim() : ""
  if (kind === "components") {
    throw new Error(
      "A component library is read from a directory by the library store, not parsed from text"
    )
  }
  if (kind === "url") {
    throw new Error(
      "A URL library is fetched by `library-url.mjs`, which hands whatever it finds " +
        "back to this function under the kind that text actually is"
    )
  }
  if (kind === "manifest") return parseManifestLibrary(parseJson(text, "manifest"), label)
  if (kind === "tokens") return parseTokenLibrary(parseJson(text, "token file"), label)
  if (kind === "icons") return parseIconLibrary(parseJson(text, "icon file"), label)
  if (kind === "css") return parseCssLibrary(text, label)
  throw new Error(`Unknown library kind "${kind}". Expected one of ${LIBRARY_SOURCE_KINDS.join(", ")}`)
}

/** Does any leaf of this object look like a design token rather than data? */
function hasTokenLeaf(node, depth = 0) {
  if (!isPlainObject(node) || depth > 8) return false
  for (const value of Object.values(node)) {
    if (!isPlainObject(value)) continue
    if (value.$value !== undefined || value.value !== undefined) return true
    if (hasTokenLeaf(value, depth + 1)) return true
  }
  return false
}

function looksLikeDrawings(parsed) {
  if (!isPlainObject(parsed)) return false
  // `$attribute` and `$schema` are the file talking about itself. Judging them
  // as drawings made a perfectly good icon set undetectable.
  const entries = Object.entries(parsed).filter(([key]) => !key.startsWith("$"))
  if (entries.length === 0) return false
  return entries.every(([, value]) => isPlainObject(value) && Array.isArray(value.nodes))
}

const MANIFEST_KEYS = ["collections", "textStyles", "effectStyles", "iconScale", "motion"]
const CSS_CUSTOM_PROPERTY = /--[a-zA-Z0-9_-]+\s*:/g
const MIN_CSS_PROPERTIES = 4

/**
 * How many readable tokens a file with no marker of its own has to yield before
 * it counts as a token file.
 *
 * The same floor, and the same argument, as the CSS one above: below it, what
 * was found is a coincidence rather than a design system. Discovery walks every
 * JSON file in a project through this function, so the cost of being generous
 * is offering somebody a library built out of their build config.
 */
const MIN_PLAIN_TOKENS = 4

/**
 * How much of a plain nested file this module would actually read.
 *
 * Counted by running the real classifier rather than by pattern-matching the
 * shape, which is what keeps the answer honest in both directions. A theme
 * object is full of hex strings and rem lengths and passes easily; a
 * `package.json` has a name, a version and a scripts block, none of which is a
 * colour or a length, and scores zero without needing a rule that knows what a
 * `package.json` is.
 */
function readableTokenCount(parsed) {
  const leaves = []
  plainLeaves(parsed, [], leaves)
  let count = 0
  for (const leaf of leaves) {
    const text = tokenText(leaf.value)
    const verdict = leafVerdict(leaf, text)
    if (!verdict || !verdict.group) continue
    if (verdict.group === "textStyles" ? singleLength(text) !== null : tokenValues(verdict.group, text)) {
      count += 1
    }
  }
  return count
}

/**
 * Which kind of design-system file this is, from its name and its text.
 *
 * Deterministic and ordered, because a file can honestly answer to two of these
 * — a manifest has a `motion` array and a token file can have a `motion` group
 * — and an order written down is an order a test can pin. Returns null rather
 * than guessing when nothing matches: discovery walks a whole project through
 * this function, and a false positive there offers the user a library that will
 * fail the moment they add it.
 *
 * The manifest test is on the SHAPE and not on the mere presence of the key,
 * which is the difference between reading that file and losing it. A manifest's
 * `motion` is an array of motion tokens; a token file's `motion` is a group of
 * duration tokens, and it is an entirely ordinary thing to write. Keyed on
 * presence, the second was handed to the manifest normalizer, which refused it
 * — correctly, it is not a manifest — and the throw reached the user as
 * "nothing here read as a design system" about a file that was nothing but
 * design tokens. Every marker key is an array in a real manifest, so requiring
 * one costs the manifest lane nothing and hands the token lane its file back.
 */
export function detectLibraryKind(relativePath, text) {
  const source = typeof text === "string" ? text : ""
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    parsed = undefined
  }

  if (parsed !== undefined) {
    if (isPlainObject(parsed) && MANIFEST_KEYS.some((key) => Array.isArray(parsed[key]))) {
      return "manifest"
    }
    if (looksLikeDrawings(parsed) || glyphList(parsed)) return "icons"
    if (hasTokenLeaf(parsed)) return "tokens"
    // A variables export announces itself structurally — a `meta.variables` map
    // of `resolvedType`/`valuesByMode` records is a shape nothing else has — so
    // it is recognised outright rather than by the count below, which a small
    // library would fall short of.
    if (figmaVariableLeaves(parsed)) return "tokens"
    // Last, because it is the only test here that reads a file's CONTENTS
    // rather than a marker it put there on purpose, and anything it claimed
    // early it would claim wrongly.
    if (isPlainObject(parsed) && readableTokenCount(parsed) >= MIN_PLAIN_TOKENS) return "tokens"
    return null
  }

  const properties = source.match(CSS_CUSTOM_PROPERTY)
  if (properties && properties.length >= MIN_CSS_PROPERTIES) return "css"
  return null
}

/**
 * What a library brings, as numbers.
 *
 * `icons` and `iconDrawings` are two different axes that share a word: the
 * first is the icon SIZE scale a token picker offers, the second is the glyphs
 * the icon picker offers. Keeping both in one shape is what lets the panel say
 * "12 icon sizes" and "213 icons" about the same library without the caller
 * having to know which group is which.
 */
export function libraryCounts(catalog) {
  const group = (key) => (Array.isArray(catalog?.[key]) ? catalog[key].length : 0)
  return {
    colors: group("colors"),
    spacing: group("spacing"),
    radii: group("radii"),
    // UI text styles fold in here. They are text styles the library brings, and
    // the counts shape has no separate slot for them — reporting them nowhere
    // would make a manifest look smaller than it is.
    textStyles: group("textStyles") + group("uiTextStyles"),
    effects: group("effects"),
    icons: group("icons"),
    motion: group("motion"),
    components: group("components"),
    iconDrawings: group("iconDrawings"),
  }
}

/** Singular and plural written out, because "1 radiuses" reads like a bug. */
const GROUP_LABELS = [
  ["colors", "color", "colors"],
  ["spacing", "spacing step", "spacing steps"],
  ["radii", "radius", "radii"],
  ["textStyles", "text style", "text styles"],
  ["effects", "effect", "effects"],
  ["icons", "icon size", "icon sizes"],
  ["motion", "motion token", "motion tokens"],
  ["components", "component", "components"],
  ["iconDrawings", "icon", "icons"],
]

const MAX_DESCRIBED_GROUPS = 3

/**
 * One line the user reads before deciding to add this file.
 *
 * Three groups at most, because this sits in a 260px column and a row that
 * wraps to four lines is a row nobody reads. The three that survive are the
 * biggest contributors in group order, which is close enough to "what this
 * library is mostly for" to be worth the truncation.
 */
export function describeLibrary(kind, catalog) {
  const counts = libraryCounts(catalog)
  const parts = GROUP_LABELS.filter(([key]) => counts[key] > 0)
    .slice(0, MAX_DESCRIBED_GROUPS)
    .map(([key, singular, plural]) => `${counts[key]} ${counts[key] === 1 ? singular : plural}`)
  if (parts.length) return parts.join(" · ")
  if (kind === "components") return "no components"
  if (kind === "icons") return "no icons"
  return "no tokens"
}
