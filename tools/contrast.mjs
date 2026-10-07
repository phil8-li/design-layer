/**
 * Every ink-and-fill pair the chrome actually renders, resolved and measured.
 *
 * This exists because the palette has now shipped the same class of bug twice,
 * and both times a test was watching. `onAccent` was near-black, five rules
 * paired it with a light semantic fill, and the pairing was correct. The accent
 * later moved to a dark blue and `onAccent` correctly became white in both
 * themes — at which point those five rules were putting white on a pale coral
 * at 2.31:1, and nothing failed. Three of them carried a comment naming 2.31:1
 * as the bug they had already fixed.
 *
 * The reason nothing failed is that every guard in the suite named a ROLE. A
 * role-named assertion answers "is `onSemantic` still `#1a1a1a`", which stays
 * true while the thing it is painted on moves out from under it. The only
 * question that catches this is the rendered one: for every rule that sets both
 * an ink and a fill, what is the ratio?
 *
 * So this resolves the compiled stylesheet rather than reading the token
 * module. It is deliberately dumb about CSS and exact about colour.
 *
 * ## What it can and cannot see
 *
 * It measures a rule only when that rule declares BOTH an ink and a fill, which
 * is 56 of the chrome's 419 rules. That is not a shortfall for this bug class —
 * every failure of it has been a rule setting both — but it does mean a rule
 * inheriting its ground is out of scope, and `KNOWN_GROUNDS` below is the
 * hand-maintained exception list for the few that matter most.
 *
 * Unresolvable values are reported rather than skipped silently, because a
 * value this cannot parse is a value nobody is checking.
 */

/* ---------- colour ---------- */

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i
const MIX = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+?)\)$/i
/** `var(--x, <fallback>)` — the fallback is the dark theme's literal. */
const VAR = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/

const clamp = (n) => Math.min(255, Math.max(0, n))

/**
 * A colour, as `{ r, g, b, a }` in 0-255 / 0-1, or null when unresolvable.
 *
 * `theme` supplies the per-role values; a `var()` is looked up there first and
 * falls back to its own literal, which is what the browser does.
 */
export function parseColor(value, theme, depth = 0) {
  if (typeof value !== "string" || depth > 8) return null
  const text = value.trim()
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 }
  if (text === "currentColor" || text === "inherit" || text === "initial") return null

  const hex = HEX.exec(text)
  if (hex) {
    const full = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1]
    const n = Number.parseInt(full, 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }

  const rgb = RGB.exec(text)
  if (rgb) {
    const alpha = rgb[4] === undefined
      ? 1
      : rgb[4].endsWith("%")
        ? Number.parseFloat(rgb[4]) / 100
        : Number.parseFloat(rgb[4])
    return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: alpha }
  }

  const ref = VAR.exec(text)
  if (ref) {
    const declared = theme.get(ref[1])
    if (declared !== undefined) return parseColor(declared, theme, depth + 1)
    return ref[2] ? parseColor(ref[2], theme, depth + 1) : null
  }

  const mix = MIX.exec(text)
  if (mix) {
    // srgb mixing is a straight per-channel lerp once alpha is premultiplied,
    // which is the one space worth resolving by hand. Anything else returns
    // null and is reported as unresolvable rather than guessed at.
    const a = parseColor(mix[1], theme, depth + 1)
    const b = parseColor(mix[3], theme, depth + 1)
    if (!a || !b) return null
    const w = Number.parseFloat(mix[2]) / 100
    const alpha = a.a * w + b.a * (1 - w)
    if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 }
    const ch = (x, y) => clamp((x * a.a * w + y * b.a * (1 - w)) / alpha)
    return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b), a: alpha }
  }
  return null
}

/** Composite a possibly-translucent colour over an opaque one. */
export const over = (top, bottom) =>
  top.a >= 1
    ? top
    : {
        r: top.r * top.a + bottom.r * (1 - top.a),
        g: top.g * top.a + bottom.g * (1 - top.a),
        b: top.b * top.a + bottom.b * (1 - top.a),
        a: 1,
      }

const channel = (v) => {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)

/** WCAG 2.x contrast, to two decimals. */
export function ratio(ink, fill) {
  const [hi, lo] = [luminance(ink), luminance(fill)].sort((a, b) => b - a)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

/* ---------- the stylesheet ---------- */

/** `--de-color-x: value` declarations from one theme block of the palette. */
export function themeBlock(css, selector) {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`no ${selector} block in the stylesheet`)
  const open = css.indexOf("{", start)
  const body = css.slice(open + 1, css.indexOf("}", open))
  const map = new Map()
  for (const line of body.split(";")) {
    const at = line.indexOf(":")
    if (at === -1) continue
    const name = line.slice(0, at).trim()
    if (name.startsWith("--")) map.set(name, line.slice(at + 1).trim())
  }
  return map
}

const lastDeclaration = (body, property) => {
  const found = [...body.matchAll(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+)`, "g"))]
  return found.length ? found[found.length - 1][1].trim() : null
}

/**
 * The first top-level token of a value, with parentheses balanced.
 *
 * `background` is a shorthand, so the colour may be followed by a position or a
 * repeat keyword and only the first token is the ground. Splitting on
 * whitespace is the obvious way to take it and it is wrong here: a token in
 * this stylesheet is routinely `var(--x, color-mix(in srgb, #fff 14%, #1a1a1a))`,
 * which contains four spaces and two levels of nesting.
 *
 * Counting depth was worth the ten lines. The regex that preceded it split
 * inside the `color-mix` and handed back `var(--de-color-bg-raised,` — a string
 * that parses as nothing, so twenty-five of the chrome's rules reported as
 * unresolvable and went unchecked, which is the exact failure this whole file
 * exists to prevent.
 */
function firstToken(value) {
  let depth = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === "(") depth += 1
    else if (ch === ")") depth -= 1
    else if (depth === 0 && /\s/.test(ch)) return value.slice(0, i)
  }
  return value
}

/**
 * Grounds for rules that set an ink and inherit their fill.
 *
 * Hand-maintained and deliberately short. A selector listed here is measured
 * against the named role as well; anything not listed and not self-grounded is
 * simply not checked, and `sweep` reports how many those are so the number
 * cannot quietly grow.
 */
export const KNOWN_GROUNDS = [
  [/^\.de-panel\b|^\.de-panel-body\b|^\.de-section\b/, "--de-color-bg"],
  [/^\.de-toolbar\b/, "--de-color-bg"],
  [/^\.de-app-menu\b/, "--de-color-bg-raised"],
]

/**
 * Every measurable pair in one theme.
 *
 * `floor` is 4.5 by default — the ratio a label owes — and a selector matching
 * `glyphOnly` is measured at 3.0 instead, which is what WCAG 1.4.11 asks of a
 * mark. That list is the only judgement in this file and every entry needs a
 * reason, because calling something a glyph is how a label gets exempted.
 */
export function sweep(shellCss, { theme, palette, glyphOnly = [], ignore = [] }) {
  const results = []
  const unresolvable = []
  /*
   * Comments out first, and this is not tidying.
   *
   * The comments in this codebase are long, they sit directly above the rule
   * they explain, and they contain braces and colons — so a rule matcher run
   * over the raw sheet takes the comment as part of the next selector, and the
   * finding it reports names a paragraph of prose instead of a control. Worse,
   * the prose often QUOTES a declaration, which is how one comment came back
   * measured as four separate failures.
   */
  const css = shellCss.replace(/\/\*[\s\S]*?\*\//g, "")
  /*
   * NO LEADING ANCHOR, and this was a real bug rather than a tidy-up.
   *
   * The matcher was `(?:^|\})\s*([^{}@][^{}]*?)\{([^{}]*)\}`. A global regex
   * resumes from the end of the previous match, so once rule A had been matched
   * — closing brace consumed — the next match had to begin on a literal `}`,
   * which is rule B's. B was swallowed as leading context and never inspected,
   * and C was reported as the next selector. Against adjacent rules, which is
   * every rule in these files, the sweep saw about HALF the stylesheet, and
   * which half depended on how many rules happened to precede them.
   *
   * A contrast guard that silently skips every other rule is worse than none:
   * it reports green over an unmeasured set and nobody looks again. Matching
   * the body alone and trimming the selector off the front has no anchor to get
   * wrong, and the pair count in the suite is what proves it sees the sheet.
   */
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]

  for (const [, rawSelector, body] of rules) {
    const selector = rawSelector.replace(/\s+/g, " ").trim()
    if (!selector || selector.startsWith("@")) continue
    if (ignore.some((probe) => probe.test(selector))) continue

    const inkText = lastDeclaration(body, "color")
    if (!inkText) continue
    let fillText = lastDeclaration(body, "background-color") ?? lastDeclaration(body, "background")
    // `background: <color>` only; a gradient or an image has no single ground.
    if (fillText && /(gradient|url\(|image-set)/i.test(fillText)) continue
    if (fillText) fillText = firstToken(fillText)

    let groundedBy = null
    if (!fillText) {
      const known = KNOWN_GROUNDS.find(([probe]) => probe.test(selector))
      if (!known) continue
      fillText = `var(${known[1]})`
      groundedBy = known[1]
    }

    const ink = parseColor(inkText, palette)
    const fillRaw = parseColor(fillText, palette)
    if (!ink || !fillRaw) {
      // Reported, never skipped silently: a value this cannot parse is a value
      // nobody is checking, and the count is what stops that set growing.
      unresolvable.push({ selector, ink: inkText, fill: fillText })
      continue
    }
    // A translucent ground is composited over the panel, which is what is
    // behind every surface in this chrome that is not the canvas.
    const page = parseColor("var(--de-color-bg)", palette) ?? { r: 0, g: 0, b: 0, a: 1 }
    const fill = over(fillRaw, page)
    if (fill.a === 0) continue
    const inkOver = over(ink, fill)

    const glyph = glyphOnly.some((probe) => probe.test(selector))
    results.push({
      theme,
      selector,
      ink: inkText,
      fill: fillText,
      groundedBy,
      floor: glyph ? 3 : 4.5,
      measured: ratio(inkOver, fill),
    })
  }
  return { results, unresolvable }
}

/* ---------- the pairs no single rule writes ---------- */

/** Top-level commas only: `:is(a, b)` is one selector, not two. */
function splitList(selector) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i]
    if (ch === "(" || ch === "[") depth += 1
    else if (ch === ")" || ch === "]") depth -= 1
    else if (ch === "," && depth === 0) {
      out.push(selector.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(selector.slice(start).trim())
  return out.filter(Boolean)
}

/**
 * A complex selector as its key compound's conditions and its ancestors'.
 *
 * Conditions are kept as the literal text of each simple selector, so two
 * spellings of one attribute test are two conditions — deliberately dumb, like
 * the rest of this file. A BEM modifier implies its block (`.de-tool--quiet`
 * is only ever written beside `.de-tool`), which is the one piece of this
 * codebase's grammar the comparison has to know to see a modifier's rule as a
 * refinement of the block's.
 */
function parseComplex(selector) {
  const parts = []
  let depth = 0
  let current = ""
  for (const ch of selector) {
    if (ch === "(" || ch === "[") depth += 1
    if (ch === ")" || ch === "]") depth -= 1
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      if (current) parts.push(current)
      current = ""
      continue
    }
    current += ch
  }
  if (current) parts.push(current)
  const simples = (compound) => {
    const found = compound.match(/::?[\w-]+(\((?:[^()]|\([^()]*\))*\))?|\.[\w-]+|#[\w-]+|\[[^\]]+\]|^[a-z][\w-]*|^\*/gi) ?? []
    const set = new Set(found.map((s) => s.replace(/\s+/g, " ")))
    for (const s of [...set]) {
      const block = /^(\.[\w-]+?)--[\w-]+$/.exec(s)
      if (block) set.add(block[1])
    }
    return set
  }
  const key = simples(parts.pop() ?? "")
  const ancestors = new Set(parts.flatMap((part) => [...simples(part)]))
  return { key, ancestors }
}

/** `(a, b, c)` specificity, enough for the selectors this chrome writes. */
function specificity(selector) {
  let a = 0
  let b = 0
  let c = 0
  const body = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "")
  for (const inner of body.matchAll(/:(?:is|not|has)\(((?:[^()]|\([^()]*\))*)\)/g)) {
    const best = splitList(inner[1])
      .map(specificity)
      .sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0] ?? [0, 0, 0]
    a += best[0]
    b += best[1]
    c += best[2]
  }
  const rest = body.replace(/:(?:is|not|has)\((?:[^()]|\([^()]*\))*\)/g, "")
  a += (rest.match(/#[\w-]+/g) ?? []).length
  b += (rest.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):(?!:)[\w-]+/g) ?? []).length
  c += (rest.match(/::[\w-]+|(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length
  return [a, b, c]
}

const beats = (x, y) => x.spec[0] - y.spec[0] || x.spec[1] - y.spec[1] || x.spec[2] - y.spec[2] || x.order - y.order

/**
 * Whether an element in the state `specific` describes matches `general`.
 *
 * A plain condition has to be stated. `:is()` needs one of its alternatives
 * stated, and `:not()` needs none of them — which is a closed-world reading:
 * a state that does not say a row is disabled is taken to be a row that is
 * not, the same thing the browser concludes about an element without the
 * attribute.
 */
function implies(specific, general) {
  const stated = (compound) => {
    const simples = compound.match(/::?[\w-]+(\((?:[^()]|\([^()]*\))*\))?|\.[\w-]+|#[\w-]+|\[[^\]]+\]|^[a-z][\w-]*/gi) ?? []
    return simples.length > 0 && simples.every((simple) => specific.key.has(simple))
  }
  for (const simple of general.key) {
    if (specific.key.has(simple)) continue
    const logical = /^:(is|where|not)\((.*)\)$/.exec(simple)
    if (!logical) {
      if (!specific.key.has(simple)) return false
      continue
    }
    const any = splitList(logical[2]).some(stated)
    if (logical[1] === "not" ? any : !any) return false
  }
  for (const s of general.ancestors) if (!specific.ancestors.has(s) && !specific.key.has(s)) return false
  return true
}

/** Attribute tests in a compound, as name → required value (`*` for presence). */
function attributeTests(set) {
  const out = new Map()
  for (const simple of set) {
    const test = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(simple)
    if (test) out.set(test[1], test[2] ?? "*")
  }
  return out
}

/**
 * Whether one element can be in both states at once.
 *
 * Refused only on evidence in the selectors themselves: one attribute required
 * at two values, a `:not()` naming something the other requires, two element
 * types, or two modifiers of one block — `.de-button--primary` and
 * `--danger` are alternatives by construction in this codebase, and treating
 * them as combinable would report pairs no builder can produce.
 */
function compatible(a, b) {
  const aa = attributeTests(a.key)
  const bb = attributeTests(b.key)
  for (const [name, value] of aa) {
    const other = bb.get(name)
    if (other !== undefined && other !== value && other !== "*" && value !== "*") return false
  }
  const negates = (x, y) =>
    [...x.key].some((simple) => {
      const inner = /^:not\((.*)\)$/.exec(simple)
      return inner && splitList(inner[1]).some((negated) => y.key.has(negated))
    })
  if (negates(a, b) || negates(b, a)) return false
  const modifiers = (set) => [...set].map((simple) => /^(\.[\w-]+?)--[\w-]+$/.exec(simple)).filter(Boolean)
  for (const [modA, blockA] of modifiers(a.key)) {
    for (const [modB, blockB] of modifiers(b.key)) if (blockA === blockB && modA !== modB) return false
  }
  const tag = (set) => [...set].find((simple) => /^[a-z]/i.test(simple))
  if (tag(a.key) && tag(b.key) && tag(a.key) !== tag(b.key)) return false
  return true
}

/**
 * Pairs the CASCADE writes: the fill one rule wins, measured against the ink
 * another rule wins, for one element in one state.
 *
 * `sweep` above sees a rule only when it declares both halves, and says so. The
 * bug that exposed the gap was a state override — the toolbar's pressed panel
 * toggle, on hover — that set the plate back to the neutral hover and said
 * nothing about the ink, so the ink stayed where the ACCENT hover rule had put
 * it: `onAccent`, white, on a near-white plate. Each rule was right on its own.
 * The pair was only ever written by the cascade, and white on `#fafafa` is
 * indistinguishable from `text` on it in the dark theme, so it survived every
 * review done in the default one.
 *
 * The same audit found the mirror image in the app menu: the armed row's
 * danger rule set BOTH halves, but the generic row hover out-specified it for
 * the plate alone, so an armed row under the pointer was `onSemantic` on the
 * neutral lift. No single rule there is wrong, and no rule implies the other —
 * the element is simply in both states at once.
 *
 * So the states resolved are: every rule's own conditions, and every
 * combination of two rules that share a class on the element and do not
 * exclude each other (see `compatible`). For each, the rules whose every
 * condition that state satisfies are ordered by specificity and then source
 * order, as the browser orders them. Where the winning fill and the winning
 * ink come from different rules, that pair is on screen, and it is measured.
 *
 * It does not know which classes a builder actually puts together, so a
 * combination that cannot occur can still be reported; `compatible` refuses
 * the ones the selectors themselves rule out, and the suite names the rest.
 * A state whose ink no rule sets is inherited from an ancestor, which is out
 * of reach here, and is skipped rather than guessed at.
 */
export function cascadeSweep(shellCss, { theme, palette, glyphOnly = [], ignore = [] }) {
  const css = shellCss.replace(/\/\*[\s\S]*?\*\//g, "")
  const entries = []
  let order = 0
  for (const [, rawSelector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = rawSelector.replace(/\s+/g, " ").trim()
    if (!list || list.startsWith("@")) continue
    order += 1
    const ink = lastDeclaration(body, "color")
    let fill = lastDeclaration(body, "background-color") ?? lastDeclaration(body, "background")
    if (fill && /(gradient|url\(|image-set)/i.test(fill)) fill = null
    if (fill) fill = firstToken(fill)
    if (!ink && !fill) continue
    for (const selector of splitList(list)) {
      // A pseudo-element is a different box from its originating element; the
      // two never share a cascade.
      if (/::/.test(selector)) continue
      entries.push({ selector, ink, fill, order, spec: specificity(selector), parsed: parseComplex(selector) })
    }
  }

  const page = parseColor("var(--de-color-bg)", palette) ?? { r: 0, g: 0, b: 0, a: 1 }
  const results = []
  const unresolvable = []
  const seen = new Set()
  const resolve = (state) => {
    const cascade = entries.filter((entry) => implies(state, entry.parsed))
    const fillWinner = cascade.filter((entry) => entry.fill).sort(beats).pop()
    const inkWinner = cascade.filter((entry) => entry.ink).sort(beats).pop()
    if (!fillWinner || !inkWinner || fillWinner === inkWinner) return
    if (ignore.some((probe) => probe.test(fillWinner.selector))) return
    const id = `${fillWinner.selector}\n${inkWinner.selector}`
    if (seen.has(id)) return
    seen.add(id)
    const inkColor = parseColor(inkWinner.ink, palette)
    const fillColor = parseColor(fillWinner.fill, palette)
    if (!inkColor || !fillColor) {
      unresolvable.push({ selector: fillWinner.selector, ink: inkWinner.ink, fill: fillWinner.fill })
      return
    }
    if (fillColor.a === 0) return
    const ground = over(fillColor, page)
    const glyph = glyphOnly.some((probe) => probe.test(fillWinner.selector) || probe.test(inkWinner.selector))
    results.push({
      theme,
      selector: fillWinner.selector,
      inkFrom: inkWinner.selector,
      ink: inkWinner.ink,
      fill: fillWinner.fill,
      floor: glyph ? 3 : 4.5,
      measured: ratio(over(inkColor, ground), ground),
    })
  }

  for (const entry of entries) resolve(entry.parsed)
  const classesOf = (entry) => [...entry.parsed.key].filter((simple) => simple.startsWith("."))
  for (const withFill of entries.filter((entry) => entry.fill)) {
    const shared = new Set(classesOf(withFill))
    for (const withInk of entries.filter((entry) => entry.ink && entry !== withFill)) {
      if (!classesOf(withInk).some((name) => shared.has(name))) continue
      if (!compatible(withFill.parsed, withInk.parsed)) continue
      resolve({
        key: new Set([...withFill.parsed.key, ...withInk.parsed.key]),
        ancestors: new Set([...withFill.parsed.ancestors, ...withInk.parsed.ancestors]),
      })
    }
  }
  return { results, unresolvable }
}
