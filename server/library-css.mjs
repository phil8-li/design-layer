/**
 * A stylesheet read as a design system: its custom properties sorted into
 * tiers (the unconditional base, dark, and the additive themes), classified
 * into axes, collapsed into text styles where four declarations are one
 * decision, and the type roles it ships as classes read beside them.
 *
 * The stages, in the order `parseCssLibrary` runs them:
 *
 *   lexer         `cssDeclarations` walks the text into declarations with the
 *                 selector chain each sits under.
 *   tiers         `declarationTheme` says which theme a declaration belongs
 *                 to; the tier rules in `parseCssLibrary` decide which block
 *                 is the authority for a name.
 *   settle        `library-values.mjs` follows each value's aliases.
 *   type ramps    `textStyleFamilies` collects the families that are one text
 *                 style, before anything else is classified.
 *   classify      `library-classify.mjs` sorts what is left into axes.
 *   type roles    `typeRoleClasses` reads text styles shipped as classes.
 *
 * Remote text reaches this module, so the lexer refuses a value or a selector
 * past a length no token or theme needs (see `MAX_VALUE_LENGTH`), and nothing
 * here runs a pattern whose work grows faster than its input.
 */

import { tokenId } from "./library-common.mjs"
import { emptyCatalog } from "./library-catalog.mjs"
import {
  DARK_SELECTOR,
  classifyName,
  classifyValue,
  colorOverRefusal,
  displayName,
  nameWords,
  segmentPieces,
  segmentRest,
  uncapitalize,
  vendorPrefix,
} from "./library-classify.mjs"
import {
  LENGTH_GROUPS,
  NUMBER,
  channelFunction,
  colorWrappers,
  cssLength,
  leadingPx,
  paintableColor,
  readTracking,
  settleValue,
  singleLength,
  substituteVariables,
  tokenValues,
  trackingIn,
  weightNumber,
} from "./library-values.mjs"

/**
 * The longest declaration (`name: value`) and the longest selector the lexer
 * reads. No token value runs to two thousand characters — a layered shadow is a
 * few hundred, a font stack fewer — and no theme selector to four thousand, so
 * past these the text is an inlined image, a generated blob or an attack, and
 * reading it costs every later pattern its length. An overlong selector still
 * opens a block, so the braces stay balanced, but it is recognised as nothing,
 * and the declarations inside it belong to no tier.
 */
const MAX_DECLARATION_LENGTH = 2048
const MAX_SELECTOR_LENGTH = 4096
const OVERLONG_SELECTOR = "{overlong selector}"

/**
 * The text with its `/* … *\/` comments removed, in one pass.
 *
 * A lazy regex did this, and an opening `/*` with no close made it scan to the
 * end of the file for every one of them: a hundred thousand unclosed openers
 * was ten billion steps. An unclosed comment is left in place, as the regex
 * left it — nothing after it can close it either, so the walk stops there.
 */
function withoutComments(source) {
  const text = String(source)
  let out = ""
  let index = 0
  for (;;) {
    const open = text.indexOf("/*", index)
    if (open === -1) return out + text.slice(index)
    const close = text.indexOf("*/", open + 2)
    if (close === -1) return out + text.slice(index)
    out += text.slice(index, open)
    index = close + 2
  }
}

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
  const css = withoutComments(source)
  const declarations = []
  const scopes = []
  const blocks = []
  let opened = 0
  let start = 0
  let quote = null
  let escaped = false
  let parens = 0
  const push = (end) => {
    if (end - start > MAX_DECLARATION_LENGTH) return
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
      scopes.push(index - start > MAX_SELECTOR_LENGTH ? OVERLONG_SELECTOR : css.slice(start, index).trim())
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

/** The run of characters a class name or an attribute's name is made of. */
const NAME_CHAR = /[a-zA-Z0-9_-]/
const PSEUDO_CHAR = /[a-zA-Z-]/

/** Where the bracketed group opened at `at` closes, or -1 when `inner` refuses what is inside. */
function closingOf(text, at, close, inner) {
  for (let index = at + 1; index < text.length; index += 1) {
    if (text[index] === close) return index
    if (!inner(text[index])) return -1
  }
  return -1
}

/**
 * Whether `text` is nothing but qualifiers hung off a selector with no
 * combinator between them: `(…)`, `[…]`, `.name`, `:pseudo` or `::pseudo`,
 * a pseudo optionally followed by `(…)`.
 *
 * A walk rather than the regular expression it replaces. That pattern could
 * read `:not(x)` two ways — a pseudo with its argument, or a pseudo then a
 * bare group — so a selector that failed after thirty of them was tried
 * 2^30 ways before it was refused: `:root:a(b)` repeated thirty times hung
 * the server for twenty seconds. Reading the argument greedily accepts
 * exactly what the pattern accepted, one way.
 */
function onlyQualifiers(text, from = 0) {
  let index = from
  while (index < text.length) {
    const char = text[index]
    if (char === "(") {
      const close = closingOf(text, index, ")", (inside) => inside !== "(")
      if (close === -1) return false
      index = close + 1
    } else if (char === "[") {
      const close = closingOf(text, index, "]", () => true)
      if (close === -1) return false
      index = close + 1
    } else if (char === ".") {
      let end = index + 1
      while (end < text.length && NAME_CHAR.test(text[end])) end += 1
      if (end === index + 1) return false
      index = end
    } else if (char === ":") {
      let end = index + (text[index + 1] === ":" ? 2 : 1)
      const word = end
      while (end < text.length && PSEUDO_CHAR.test(text[end])) end += 1
      if (end === word) return false
      if (text[end] === "(") {
        const close = closingOf(text, end, ")", (inside) => inside !== "(")
        if (close !== -1) end = close + 1
      }
      index = end
    } else {
      return false
    }
  }
  return true
}

/** The document, named with no condition: the head a qualified root is built on. */
const DOCUMENT_HEADS = [":root", "html", "body", "*", ":host"]

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
function isThemedSelector(part) {
  for (const head of DOCUMENT_HEADS) {
    if (part.startsWith(head) && part.length > head.length && onlyQualifiers(part, head.length)) return true
  }
  if (part.startsWith("[")) {
    const close = part.indexOf("]")
    return close !== -1 && onlyQualifiers(part, close + 1)
  }
  if (part.startsWith(".")) {
    let end = 1
    while (end < part.length && NAME_CHAR.test(part[end])) end += 1
    return part.slice(1, end).includes("theme") && onlyQualifiers(part, end)
  }
  return false
}

function isBaseScope(scope) {
  return scope.split(",").some((part) => BASE_SELECTOR.test(part.trim()))
}

function isThemedScope(scope) {
  return scope.split(",").some((part) => isThemedSelector(part.trim()))
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
 * `isThemedSelector` recognises a theme by how it is spelled — a `theme` word,
 * an attribute, a qualified root. Some systems name their themes after
 * nothing of the sort (`.x--white`, `.x--g90`), and their whole palette lives
 * in those blocks, so it read as absent. What gives such a class away is that
 * it redeclares the same long list of names another class declares: a
 * component's private variables are its own, while a theme is one vocabulary
 * stated several times over. Both tests are needed — a button's variants also
 * repeat their names, but a dozen of them, not the dozens a palette runs to.
 */
const THEME_ZONE_MIN_NAMES = 40
/** A selector that is one class and nothing else. */
const SINGLE_CLASS = /^\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)$/
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

  // How many families still in the map point at each name, kept as they
  // leave it, so releasing a name does not rescan every family: twenty
  // thousand leading-only families took nine seconds that way.
  const pointers = new Map()
  for (const entry of families.values()) {
    for (const name of Object.values(entry.vars)) pointers.set(name, (pointers.get(name) ?? 0) + 1)
  }
  const remove = (entry) => {
    families.delete(entry.key)
    for (const name of Object.values(entry.vars)) pointers.set(name, pointers.get(name) - 1)
  }

  const icons = []
  for (const entry of [...families.values()]) {
    const sized = entry.members["font-size"] !== undefined && cssLength(entry.members["font-size"]) !== null
    const enough = !entry.trailing || Object.keys(entry.members).length >= 2
    if (sized && enough && entry.words.includes("icon")) {
      remove(entry)
      icons.push(entry)
      continue
    }
    if (sized && enough) continue
    remove(entry)
    for (const name of Object.values(entry.vars)) {
      // A role a variant inherited is still that variant's; only release what
      // no surviving family points at.
      if (!(pointers.get(name) > 0)) claimed.delete(name)
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


function textStyleToken(entry, prefixRun = 0, sharedStem = []) {
  const fontSize = singleLength(entry.members["font-size"])
  if (fontSize === null) return null

  const lineHeight = leadingPx(entry.members["line-height"], fontSize) ?? fontSize

  // Tracking keeps the authored number rather than being converted. `-0.01em`
  // and `-0.16px` are both ordinary spellings of the same tracking and the
  // catalog says which one this system meant, in `trackingUnit`.
  const rawTracking = entry.members["letter-spacing"]
  const tracking = rawTracking === undefined ? 0 : Number.parseFloat(String(rawTracking))
  // A keyword weight (`bold`, `semibold`) is read the way a class role and a
  // token file read it; `parseFloat` made `--font-weight-body: bold` no weight.
  const rawWeight = entry.members["font-weight"]
  const weight = rawWeight === undefined ? null : weightNumber(rawWeight)

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
  // The body is bounded so that an `@property` with no closing brace costs a
  // bounded look ahead rather than a scan to the end of the file.
  for (const match of withoutComments(text).matchAll(/@property\s+(--[a-zA-Z0-9_-]+)\s*\{([^}]{0,2048})\}/g)) {
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

/** Where a text style's size has to be stated: a fixed length, never relative to its parent. */
const FIXED_SIZE = new RegExp(`^(${NUMBER})(px|rem)$`, "i")

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
    const tracking = readTracking(settleValue(properties.get("letter-spacing") ?? "", lookup))
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
      tracking: tracking ? { value: tracking.value, unit: tracking.unit || "px" } : { value: 0, unit: "px" },
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


export function parseCssLibrary(text, name) {
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
