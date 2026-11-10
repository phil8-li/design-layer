/**
 * How a finding's selector becomes elements on this page.
 *
 * One implementation, used by the store's index and therefore by everything
 * that reads it: the marker layer's badges, the panel's "on this page" count
 * and the inspector's `findingsFor`. There used to be two — a regex version in
 * the store and this one in the marker layer, joined by a hook so the second
 * could replace the first at boot — and two answers to "which elements does
 * this selector mean" is how a panel comes to claim fourteen markers over a
 * canvas that paints twelve.
 */

import { isCanvasElement } from "../core/dom"
import type { LintFinding } from "./store"

/**
 * How many elements ONE finding may mark. See the caps comment in ./markers:
 * a finding inside `.card` on a page of two hundred cards is one finding and
 * two hundred elements, and twenty is enough to say "this is everywhere".
 */
const MAX_ELEMENTS_PER_FINDING = 20

/**
 * Pseudo-classes that say WHICH element rather than WHICH MOMENT.
 *
 * The split is the whole point of stripping. `:hover`, `:focus`, `:active`,
 * `:checked` and their relatives describe a moment; the element exists without
 * them and is exactly what a marker wants to point at. The ones below describe
 * the element, so removing them would widen the finding to elements the rule
 * never styled — `:not(.is-open)` dropped from `.panel:not(.is-open)` marks the
 * open panel too, and the user goes looking for a violation that is not there.
 *
 * Written as the list of what SURVIVES rather than the list of what goes,
 * because the state pseudo-classes are an open set that grows with every
 * browser release and the structural ones are very nearly closed. A pseudo
 * nobody here has heard of is far more likely to be a new state than a new way
 * of counting children.
 */
const STRUCTURAL_PSEUDOS: ReadonlySet<string> = new Set([
  "not",
  "is",
  "where",
  "has",
  "matches",
  "any",
  "scope",
  "root",
  "empty",
  "first-child",
  "first-of-type",
  "last-child",
  "last-of-type",
  "only-child",
  "only-of-type",
  "nth-child",
  "nth-last-child",
  "nth-of-type",
  "nth-last-of-type",
])

/**
 * Split a selector list on its top-level commas.
 *
 * Not `selector.split(",")`, because a comma is legal inside `:is(a, b)` and
 * inside `[title="a,b"]`, and splitting there produces two fragments that each
 * fail to parse — turning a perfectly good selector list into nothing at all.
 * Depth is tracked across both bracket kinds and quotes are honoured, which is
 * the scan every function below needs, so it is written once here.
 */
function splitSelectorList(selector: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ""
  let start = 0
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "(" || char === "[") depth += 1
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1)
    else if (char === "," && depth === 0) {
      parts.push(selector.slice(start, index))
      start = index + 1
    }
  }
  parts.push(selector.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/**
 * One complex selector, taken apart into its compounds and the combinators
 * between them.
 *
 * Splitting into compounds first is what lets a gutted compound be REPLACED
 * rather than deleted. `.card > :hover` with the pseudo simply removed is
 * `.card > `, a dangling combinator that does not parse; with the compound
 * replaced by `*` it is `.card > *`, which is the true statement — the rule
 * styles a child of `.card`, and nothing survives to say which child.
 */
function splitCompounds(part: string): { compounds: string[]; combinators: string[] } {
  const compounds: string[] = []
  const combinators: string[] = []
  let depth = 0
  let quote = ""
  let current = ""
  let pending = ""

  for (let index = 0; index < part.length; index += 1) {
    const char = part[index]
    if (quote) {
      current += char
      if (char === "\\") {
        current += part[index + 1] ?? ""
        index += 1
      } else if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === "(" || char === "[") depth += 1
    if (char === ")" || char === "]") depth = Math.max(0, depth - 1)
    if (depth === 0 && (char === " " || char === "\t" || char === "\n")) {
      // Whitespace is the descendant combinator only when it is not merely the
      // air around an explicit one: `.a > .b` must yield ONE combinator, not
      // three. So it is remembered and committed only if no explicit
      // combinator and no further compound overrides it first.
      if (current.length > 0 && !pending) pending = " "
      continue
    }
    if (depth === 0 && (char === ">" || char === "+" || char === "~")) {
      pending = char
      continue
    }
    if (pending) {
      if (current.length > 0) {
        compounds.push(current)
        combinators.push(pending)
        current = ""
      }
      pending = ""
    }
    current += char
  }
  compounds.push(current)
  return { compounds, combinators }
}

/** The index of the bracket closing the one at `from`, or the end of the text. */
function closingIndex(text: string, from: number, open: string, close: string): number {
  let depth = 0
  let quote = ""
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return text.length - 1
}

/**
 * One compound with its state pseudos and its framework scoping attributes
 * removed, and a note of whether either was there.
 *
 * The scoping attributes are the half that is easy to forget and fatal to leave
 * in. A component framework with emulated style encapsulation rewrites every
 * rule it compiles to carry a per-build attribute — `[_ngcontent-abc-c31]` and
 * its relatives — and the compiler invents that attribute at build time. The
 * browser will happily match it, right up until the next build renames it, so a
 * marker layer keyed on a build id is a marker layer that works this afternoon.
 * Dropping it widens the selector back to what the author wrote, which is what
 * the finding is about.
 *
 * Recognised by the leading underscore rather than by name, which is HARD RULE
 * 1's reasoning one level out: a generated attribute is a SHAPE, and every
 * framework that generates one has landed on the same shape to keep it out of
 * the author's namespace.
 */
function stripCompound(compound: string): { text: string; dropped: boolean } {
  let out = ""
  let dropped = false
  let index = 0
  while (index < compound.length) {
    const char = compound[index]

    if (char === "[") {
      const end = closingIndex(compound, index, "[", "]")
      const attribute = compound.slice(index, end + 1)
      if (/^\[\s*_/.test(attribute)) dropped = true
      else out += attribute
      index = end + 1
      continue
    }

    if (char === ":") {
      const isElement = compound[index + 1] === ":"
      let cursor = index + (isElement ? 2 : 1)
      let name = ""
      while (cursor < compound.length && /[A-Za-z0-9-]/.test(compound[cursor])) {
        name += compound[cursor]
        cursor += 1
      }
      let argument = ""
      if (compound[cursor] === "(") {
        const end = closingIndex(compound, cursor, "(", ")")
        argument = compound.slice(cursor, end + 1)
        cursor = end + 1
      }
      // A pseudo-ELEMENT never survives: there is no node in the tree to mark,
      // and the element that owns it is already what the rest of the compound
      // names. A pseudo-class survives only if it says which element.
      if (!isElement && STRUCTURAL_PSEUDOS.has(name.toLowerCase())) out += `:${name}${argument}`
      else dropped = true
      index = cursor
      continue
    }

    out += char
    index += 1
  }
  return { text: out, dropped }
}

/** Whether the browser will accept this selector at all. */
function parses(selector: string): boolean {
  try {
    document.createDocumentFragment().querySelector(selector)
    return true
  } catch {
    return false
  }
}

/** One complex selector, cleaned. `null` when nothing queryable is left of it. */
function cleanPart(
  part: string,
  keepStructural: boolean
): { text: string; dropped: boolean } | null {
  const { compounds, combinators } = splitCompounds(part)
  let out = ""
  let dropped = false
  for (let index = 0; index < compounds.length; index += 1) {
    const stripped = stripCompound(compounds[index])
    // The second pass throws the structural pseudos away too. Anything left
    // after `:` on a compound goes, which is blunt on purpose — this only runs
    // when the careful version failed to parse, and the alternative is nothing.
    const text = keepStructural ? stripped.text : stripped.text.replace(/:.*$/, "")
    if (stripped.dropped || text !== stripped.text) dropped = true
    // An emptied compound becomes the universal selector rather than vanishing:
    // see `splitCompounds` for why deleting it is what breaks the combinator.
    const compound = text.trim().length > 0 ? text.trim() : "*"
    if (index > 0) {
      const combinator = combinators[index - 1]
      out += combinator === " " ? " " : ` ${combinator} `
    }
    out += compound
  }
  const text = out.trim()
  // A part that reduced to nothing but `*` is not a finding about anything — it
  // would mark every element on the page, which is the same as marking none.
  if (!text || text === "*") return null
  return parses(text) ? { text, dropped } : null
}

/**
 * A selector from a stylesheet, turned into one the page can be queried with.
 *
 * `relaxed` is that selector, or `""` when nothing usable survived. `dropped`
 * says whether anything was actually taken out, which is what lets the caller
 * decide whether the ORIGINAL is still worth trying first.
 *
 * Two passes, deliberately, and the second earns its keep. The first keeps the
 * structural pseudos, because they are what makes a finding point at one
 * element rather than at forty. If the result does not parse — a nesting
 * selector the stylesheet resolved differently, a `:has()` on a browser that
 * has none, a plugin's placeholder — the second pass throws every pseudo away
 * and asks again. A wider marker on the right element beats no marker at all;
 * no marker beats a thrown exception, which is the third pass and is `""`.
 */
export function relaxSelector(selector: string): { relaxed: string; dropped: boolean } {
  const survivors: string[] = []
  let dropped = false
  for (const part of splitSelectorList(selector)) {
    const cleaned = cleanPart(part, true) ?? cleanPart(part, false)
    if (!cleaned) {
      // A part that could not be rescued is itself a drop: the remaining parts
      // no longer cover everything the original selector did, so the original
      // must not be trusted as the exact form either.
      dropped = true
      continue
    }
    survivors.push(cleaned.text)
    if (cleaned.dropped) dropped = true
  }
  if (survivors.length === 0) return { relaxed: "", dropped: true }
  const relaxed = survivors.join(", ")
  return parses(relaxed) ? { relaxed, dropped } : { relaxed: "", dropped: true }
}

/** Never throws: a selector the browser refuses resolves to nothing. */
function query(selector: string): Element[] {
  if (!selector) return []
  try {
    return Array.from(document.querySelectorAll(selector))
  } catch {
    return []
  }
}

/**
 * The elements one finding is about, on this page, right now.
 *
 * The lint store's one resolver, so the badges, the panel's "on this page"
 * figure and the inspector's `findingsFor` are three readings of one answer. Counting separately is the failure this replaces: two
 * implementations of "which elements does this selector mean" agree until the
 * day one of them learns about `:hover` and the other does not, and then the
 * user sees twelve badges under a heading that says fourteen with no way to
 * find the missing two.
 *
 * The exact selector is tried first, but only when nothing had to be removed to
 * make it queryable. That order matters both ways round. A structural qualifier
 * — `:nth-child(2)`, `:not(.open)` — genuinely narrows the match and must be
 * honoured, so it is not relaxed away for nothing. But a STATE selector must
 * never be tried as written: `.btn:hover` resolved while the pointer happens to
 * be over that button answers the hovered ancestor chain, so which elements a
 * finding covers would depend on where the mouse was when the audit finished.
 *
 * `isCanvasElement` is not a nicety. A finding on `button` or on `.icon` will
 * match the editor's own chrome — every panel, every toolbar control — and a
 * badge pinned to the inspector would follow the inspector around, marking the
 * marker. The annotation layer records the same hazard for the same reason;
 * both layers ask one function so neither can drift into annotating the
 * annotator.
 */
export function resolveFinding(finding: LintFinding): Element[] {
  if (!finding.selector) return []
  const { relaxed, dropped } = relaxSelector(finding.selector)
  const found = dropped ? query(relaxed) : query(finding.selector)
  const fallback = found.length === 0 && !dropped ? query(relaxed) : found
  const elements: Element[] = []
  for (const node of fallback) {
    if (!isCanvasElement(node)) continue
    elements.push(node)
    if (elements.length >= MAX_ELEMENTS_PER_FINDING) break
  }
  return elements
}
