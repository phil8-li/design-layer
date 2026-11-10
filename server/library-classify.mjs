/**
 * Which axis a token belongs to, read off its name — and the name a designer
 * reads, cut out of the one a platform team wrote.
 *
 * Shared by the stylesheet reader and the token-file reader, so the two lanes
 * sort a file the same way: a radius named `--x-radius-sm` in a stylesheet and
 * `x.radius.sm` in a token file land in the same picker. Word segments rather
 * than prefixes, for the reason the header of `library-sources.mjs` gives.
 */

import { paintableColor, durationSeconds } from "./library-values.mjs"

/**
 * `dark` as a whole word, so `.dark`, `[data-theme="x-dark"]` and `darkroom`
 * sort correctly. A stylesheet's dark block and a variables export's dark mode
 * are both found by it.
 */
export const DARK_SELECTOR = /(^|[^a-z0-9])dark([^a-z0-9]|$)/

/**
 * A leading segment run is only treated as a vendor prefix when this many
 * tokens share it. Below that the "common prefix" is a coincidence of a tiny
 * file, and stripping it would rename tokens for no reason.
 */
const VENDOR_PREFIX_MIN_TOKENS = 4

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
export function classifyName(words) {
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
export function colorOverRefusal(named, owner, value, wrapper) {
  if (!named) return null
  if (named.group === null && paintableColor(value, wrapper)) {
    return { group: "colors", category: "color", matchIndex: -1 }
  }
  return { ...named, matchIndex: named.matchIndex < 0 ? -1 : owner[named.matchIndex] }
}

/** The value has the last word when the name had nothing to say. */
export function classifyValue(value, wrapper = null) {
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
export function nameWords(name) {
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
export function segmentPieces(segment) {
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
export function segmentRest({ segments, owner, spans }, index) {
  return segments[owner[index]].slice(spans[index].end).replace(/^[^A-Za-z0-9]+/, "")
}

/** `Medium` as `medium` once a camel hump no longer starts it. `XLarge` and `M` stay as written. */
export function uncapitalize(text) {
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
export function vendorPrefix(names) {
  if (names.length < VENDOR_PREFIX_MIN_TOKENS) return 0
  const lists = names.map((name) => name.slice(2).toLowerCase().split("-"))
  // A loop rather than `Math.min(...)`, which throws past the engine's
  // argument limit on a stylesheet with a hundred thousand names.
  const shortest = lists.reduce((least, list) => Math.min(least, list.length), Infinity)
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
export function displayName(fullName, matchIndex, prefixRun, rest = "") {
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
