/**
 * A CSS value as far as a library file can settle it, and whether this editor
 * can write it.
 *
 * Two jobs that every reader shares. RESOLUTION follows an alias to the
 * literal at the end of it, fills in the references inside a value and works
 * out the `calc()` that is left. VALIDATION decides whether the result is a
 * value of the kind its axis writes: a paintable colour, one length, a
 * duration, a box-shadow. A token this editor offers is a token it will WRITE,
 * so a value it cannot write is dropped here rather than offered (see the
 * header of `library-sources.mjs`).
 *
 * Remote text reaches every function here — a URL library hands this module a
 * stylesheet somebody else wrote — so each pattern is written to run in time
 * linear in its input. A number is `(?:\d+(?:\.\d+)?|\.\d+)` and never
 * `\d*\.?\d+`, whose two digit runs can split a long run of digits in every
 * possible way before failing: forty thousand digits in one value cost half a
 * second per pattern, and a stylesheet runs a value through a dozen of them.
 * And a settled value has a ceiling, because an alias chain can multiply: each
 * level that references the one below several times doubles or triples the
 * text, and eight such levels in one kilobyte of CSS took ten seconds and
 * 2.4 GB to settle before every result was remembered and the length capped.
 */

/**
 * How far an alias chain is followed before this module gives up.
 *
 * Deep enough for the ref/sys/component layering real systems use, shallow
 * enough that a pathological file cannot turn a parse into a hang. The trail
 * set makes a cycle terminate on its own; the depth limit is the second belt.
 */
export const MAX_ALIAS_DEPTH = 8

/** The px a unitless `rem`/`em` is worth. The root default, and not worth guessing at. */
export const ROOT_FONT_SIZE = 16

/**
 * Above this, a unitless line-height is read as pixels; at or below it, as a
 * ratio of the font size. Both spellings are in the wild — `1.5` and `24` mean
 * the same leading on a 16px body — and no line is ever 4px tall, so the
 * magnitude separates them with room to spare.
 */
const LINE_HEIGHT_RATIO_MAX = 4

/**
 * One unsigned CSS number: `4`, `0.5`, `.5`. Spelled so that a run of digits
 * can be matched exactly one way (see the header).
 */
export const NUMBER = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)"

/**
 * The longest value a settled reference may grow to. A real token settles to
 * a few dozen characters and a layered shadow to a few hundred; past this the
 * text is an alias chain multiplying itself, and it is refused rather than
 * built.
 */
const MAX_SETTLED_LENGTH = 4096

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
 *
 * Each reference is settled once per lookup and remembered, and a result past
 * `MAX_SETTLED_LENGTH` is refused. Without both, `--l8: var(--l7) var(--l7) …`
 * over eight such levels re-settled `--l7` for every mention of it, and the
 * mention below that for every mention of that: exponential work and an
 * exponentially long string, from a stylesheet of one kilobyte. The memory is
 * keyed by the reference's text and its depth, which are everything the answer
 * depends on besides the lookup, so a remembered answer is the answer the
 * walk would have computed.
 */
const settled = new WeakMap()

export function substituteVariables(raw, lookup, depth = 0) {
  const text = String(raw)
  if (depth >= MAX_ALIAS_DEPTH) return null
  let memory = settled.get(lookup)
  if (!memory) {
    memory = new Map()
    settled.set(lookup, memory)
  }
  let out = ""
  let index = 0
  for (;;) {
    const at = text.indexOf("var(", index)
    if (at === -1) {
      out += text.slice(index)
      return out.length > MAX_SETTLED_LENGTH ? null : out
    }
    let end = at + 3
    let open = 0
    for (; end < text.length; end += 1) {
      if (text[end] === "(") open += 1
      else if (text[end] === ")" && --open === 0) break
    }
    if (end >= text.length) return null
    const reference = text.slice(at, end + 1)
    const key = `${depth}\u0000${reference}`
    let inner = memory.get(key)
    if (inner === undefined) {
      const resolved = resolveValue(reference, lookup)
      inner = varReference(resolved) ? null : substituteVariables(resolved, lookup, depth + 1)
      memory.set(key, inner)
    }
    if (inner === null) return null
    out += text.slice(index, at) + inner
    if (out.length > MAX_SETTLED_LENGTH) return null
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
const CALC_TOKEN = new RegExp(`${NUMBER}(?:e-?\\d+)?(?:px|rem|em|%|[a-z]+)?|[-+*/()]`, "gi")
const CALC_QUANTITY = new RegExp(`^(${NUMBER}(?:e-?\\d+)?)([a-z%]*)$`, "i")

function evaluateCalc(text) {
  const body = /^calc\(([\s\S]*)\)$/i.exec(String(text).trim())
  if (!body) return null
  const tokens = body[1].replace(/calc\(/gi, "(").match(CALC_TOKEN)
  if (!tokens || tokens.join("").length !== body[1].replace(/calc\(/gi, "(").replace(/\s+/g, "").length) return null
  let at = 0
  const quantity = (raw) => {
    const match = CALC_QUANTITY.exec(raw)
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
export function settleValue(raw, lookup) {
  let resolved = resolveValue(raw, lookup)
  if (/\bvar\(/i.test(String(resolved))) resolved = substituteVariables(resolved, lookup) ?? resolved
  if (!/^calc\(/i.test(String(resolved).trim())) return resolved
  return evaluateCalc(resolved) || resolved
}

/**
 * `text` split on `separator` wherever it is not inside parentheses. Named for
 * what it ignores: the component scanner has its own top-level splitter, which
 * also respects brackets and quotes.
 */
function splitOutsideParens(text, separator) {
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
const SHADOW_LENGTH = new RegExp(`^(-?${NUMBER}(px|rem|em|vw|vh)|-?(?:0+(?:\\.0+)?|\\.0+)|(calc|min|max|clamp|var)\\(.*\\))$`, "i")

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
  const layers = splitOutsideParens(value, /,/)
  return (
    layers.length > 0 &&
    layers.every((layer) => {
      const lengths = splitOutsideParens(layer, /\s/).filter(
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
const SINGLE_LENGTH = new RegExp(`^(-?${NUMBER})(px|rem|em)?$`, "i")
const DURATION = new RegExp(`^(-?${NUMBER})(ms|s)$`, "i")
/** A bare number, signed or not: a stylesheet's unitless value. */
const BARE_NUMBER = new RegExp(`^-?${NUMBER}$`)

/** Two to four numbers, optionally percentages, optionally with a slashed alpha. */
const BARE_CHANNELS = new RegExp(`^-?${NUMBER}%?([\\s,]+-?${NUMBER}%?){1,3}(\\s*\\/\\s*-?${NUMBER}%?)?$`)

/**
 * A hue followed by two PERCENTAGES: `hsl()`'s argument list and nothing else's.
 *
 * The percentages are what make this safe to recognise without being told. A
 * saturation and a lightness are percentages by definition, while the channel
 * triple this module deliberately refuses — `31, 31, 31` under a `-rgb` name —
 * is three bare 0-255 integers. So the shape identifies the function even when
 * the file never names it, which is the only reason guessing is allowed here.
 */
const HSL_TRIPLE = new RegExp(
  `^-?${NUMBER}(deg)?[\\s,]+${NUMBER}%[\\s,]+${NUMBER}%(\\s*\\/\\s*-?${NUMBER}%?)?$`
)

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

export function colorWrappers(source) {
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
export function paintableColor(value, wrapper = null) {
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
export function channelFunction(value, wrapper) {
  const text = String(value).trim()
  if (BARE_CHANNELS.test(text) && wrapper) return { cssFunction: wrapper }
  if (HSL_TRIPLE.test(text)) return { cssFunction: wrapper ?? "hsl" }
  return {}
}

/** A single length in px, or null. A multi-value shorthand is not a scalar and says so. */
export function singleLength(value) {
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
export function cssLength(value) {
  const text = String(value).trim()
  if (BARE_NUMBER.test(text) && Number.parseFloat(text) !== 0) return null
  return singleLength(text)
}

/** Past this a spacing value is a sentinel for "no limit" rather than a step. */
const MAX_SPACING_PX = 2000

/** The axes whose tokens are one length, which a stylesheet has to state with a unit. */
export const LENGTH_GROUPS = new Set(["spacing", "radii", "icons", "textStyles"])

/** Seconds, from either spelling of a duration. */
export function durationSeconds(value) {
  const match = DURATION.exec(String(value).trim())
  if (!match) return null
  const number = Number.parseFloat(match[1])
  if (!Number.isFinite(number)) return null
  return match[2].toLowerCase() === "ms" ? number / 1000 : number
}

/** A percentage, and an unsigned number: a line height's and a weight's spellings. */
const PERCENT = new RegExp(`^(-?${NUMBER})%$`)
const UNSIGNED_NUMBER = new RegExp(`^${NUMBER}$`)

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
export function leadingPx(raw, fontSize) {
  const text = raw === undefined || raw === null ? "" : String(raw).trim()
  if (!text) return null
  const percent = PERCENT.exec(text)
  const measured = percent ? null : singleLength(text)
  let px = null
  if (percent) px = (Number.parseFloat(percent[1]) / 100) * fontSize
  else if (measured !== null) {
    const unitless = BARE_NUMBER.test(text)
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

export function weightNumber(raw) {
  const text = raw === undefined || raw === null ? "" : String(raw).trim()
  if (!text) return null
  if (UNSIGNED_NUMBER.test(text)) return Number.parseFloat(text)
  return FONT_WEIGHT_NAMES[text.toLowerCase().replace(/[^a-z]/g, "")] ?? null
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
export function tokenValues(group, value, wrapper = null) {
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

/** Tracking in the unit the catalog states, converted through the style's own size. */
export function trackingIn(unit, tracking, fontSize) {
  const px =
    tracking.unit === "em"
      ? tracking.value * fontSize
      : tracking.unit === "rem"
        ? tracking.value * ROOT_FONT_SIZE
        : tracking.value
  const value = unit === "em" ? (tracking.unit === "em" ? tracking.value : px / fontSize) : px
  return Math.round(value * 10000) / 10000
}

/**
 * A letter-spacing as authored — its number and its unit, `""` when it states
 * none — or null when it is not one number. Both lanes read tracking this way;
 * the unit is converted later, once the catalog's own unit is known.
 */
const TRACKING = new RegExp(`^(-?${NUMBER})(px|em|rem)?$`, "i")

export function readTracking(text) {
  const match = TRACKING.exec(String(text ?? "").trim())
  if (!match) return null
  return { value: Number.parseFloat(match[1]), unit: (match[2] ?? "").toLowerCase() }
}
