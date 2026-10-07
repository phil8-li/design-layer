/**
 * Audit findings, painted onto the page they are about.
 *
 * A finding is a file and a line. A marker is a thing on screen. The whole of
 * this module is the distance between those two sentences, and it is longer
 * than it looks: the linter read a stylesheet, the browser rendered elements,
 * and the only rope between them is the SELECTOR of the rule the finding sits
 * in. Everything below is either spanning that gap or refusing to span it
 * dishonestly.
 *
 * Three refusals are worth naming up front, because each one is a case where
 * painting something would have been easy and wrong:
 *
 *   - A selector that matches nothing is NOT an error. It is a finding in a
 *     stylesheet whose rule this route does not render, which is the ordinary
 *     case: an audit covers the project and a page shows one screen of it. It
 *     gets no marker, and it is the reason the panel's summary has to say how
 *     many findings are on THIS page — a panel claiming twenty while the canvas
 *     shows twelve reads as a broken marker layer rather than as a true
 *     statement about eight other routes. The count and the markers come from
 *     ONE resolution, registered into the store below, so the two cannot
 *     disagree even in principle.
 *
 *   - A selector the browser cannot parse takes itself down and nothing else.
 *     `querySelectorAll` throws a `SyntaxError` on anything it does not
 *     recognise, and one stylesheet using a syntax this browser has not shipped
 *     — or one plugin leaving a placeholder in a selector — would otherwise
 *     throw inside the resolve pass and lose every other finding's marker.
 *
 *   - A rule styling a STATE is marked on the element, not on the state. A
 *     `.btn--tonal:hover` finding is a real finding about a real button, and a
 *     marker that waited for the hover would be waiting for a gesture the user
 *     has no reason to make on the one element they were just told to look at.
 *     The pseudo is stripped and the base compound is marked. Same for
 *     `::after` — there is no node in the tree to mark, so the element that
 *     owns the pseudo-element is the only honest answer.
 *
 * The layer is inert (`pointer-events: none`) and only the badges take the
 * pointer, exactly as the annotation layer is, and for the same reason: this is
 * drawn over an app somebody is still trying to use.
 */

import { el, isCanvasElement } from "../core/dom"
import { editorOwnsInput, editorStandDownChanged } from "../core/store"
import type { EditorContext } from "../core/context"
import type { LayerElement } from "../core/types"
import { markerLayer, onMarkerLayerChange, setMarkerLayer } from "../annotations/store"
import {
  lintResolution,
  markersShown,
  setLintResolver,
  setMarkersShown,
  subscribeToLint,
  type LintFinding,
} from "./store"

/**
 * The seam between the Design system panel and this layer, and it is the SAME
 * seam the notes use.
 *
 * `annotations/canvas.ts` carries the long version of why — two surfaces that
 * are mounted independently, neither owning the other, an import either way
 * making one unusable without the other — and it applies here without a word
 * changed. What differs is only the pair of names, because a lint row and a
 * note row are different objects and one shared event would light a note pin
 * from a finding's id.
 *
 *   `designlayer:lint-hover`         panel -> canvas  `{ id: string | null }`
 *     The pointer is on that finding's row, or has left every row. The badge
 *     carrying that finding takes `MARKER_ACTIVE`.
 *
 *   `designlayer:lint-marker-hover`  canvas -> panel  `{ id, ids }`
 *     The mirror. `id` is the finding the badge speaks for — the worst one on
 *     that element — and `ids` is every finding it covers, because one badge
 *     can stand for several rows and a panel that lit only one of them would be
 *     answering a question nobody asked. A listener written against the
 *     annotation seam's shape still works: `id` alone is the same contract.
 *
 * `null` is a value in the pair rather than a second event, for the reason the
 * annotation seam gives: a listener that only ever hears "now this one" is how
 * a highlight gets stuck on a row nobody is on.
 */
const HOVER_EVENT = "designlayer:lint-hover"
const MARKER_HOVER_EVENT = "designlayer:lint-marker-hover"

/** The badge the panel is pointing at. The look belongs to `css/lint-markers`. */
const MARKER_ACTIVE = "de-lint-marker--active"

/** How far past the viewport a badge may sit before it stops being painted. */
const BLEED = 32

/**
 * How many elements ONE finding may mark, and how many badges the page may
 * carry in total.
 *
 * Both caps exist because a CSS finding's scope is a selector, and a selector
 * is free to be `button` or `.card`. A hardcoded colour inside `.card` on a
 * dashboard of two hundred cards is one finding and two hundred elements, and
 * painting it faithfully is not a marker layer, it is a fog: the page is
 * covered, nothing is readable, and the one thing the user wanted — to see
 * WHERE the problem is — is the thing they can no longer do. Twenty is enough
 * to say "this is everywhere" and few enough to still see the page under it.
 *
 * The second cap is about cost rather than legibility. Every badge on screen
 * costs one `getBoundingClientRect` per frame, and the layer tracks
 * continuously because a sticky header or an opening accordion moves an element
 * without firing anything worth waking on. Two hundred reads a frame is a
 * budget; five thousand findings resolved to five thousand elements is not.
 *
 * Neither cap changes the COUNT. A finding that matched two hundred elements is
 * on this page whether it drew twenty badges or two hundred, and the summary
 * counts findings, not marks.
 */
const MAX_ELEMENTS_PER_FINDING = 20
const MAX_BADGES = 200

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

/** One element, and every finding that resolved to it. */
interface Mark {
  element: Element
  /** Worst first, so the badge's severity and the finding it names agree. */
  findings: LintFinding[]
  severity: "error" | "warning"
  /** The badge's title and accessible name, built once per regroup rather than per frame. */
  label: string
}

/** Where a mark goes this frame. */
interface Placement {
  left: number
  top: number
  width: number
  height: number
}

/* ---------- selector surgery ---------- */

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
 * Registered into the lint store as THE resolver, so the badges below, the
 * panel's "on this page" figure and the inspector's `findingsFor` are three
 * readings of one answer. Counting separately is the failure this replaces: two
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

/** The element a badge's click may select, or `null` for one the editor cannot. */
function asLayerElement(element: Element): LayerElement | null {
  if (element instanceof HTMLElement) return element
  if (element instanceof SVGSVGElement) return element
  return null
}

const worst = (finding: LintFinding): number => (finding.severity === "error" ? 1 : 0)

export function installLintMarkers(context: EditorContext): void {
  const layer = el("div", { class: "de-lint-marker-layer" })
  context.slots.overlay.append(layer)

  /** Badges and outlines are pooled: a scroll must not allocate DOM per frame. */
  const badges: HTMLButtonElement[] = []
  const outlines: HTMLElement[] = []

  /**
   * The resolved page, grouped by element, rebuilt when the STORE says so and
   * never per frame.
   *
   * The expensive half — a `querySelectorAll` per finding — lives in the store's
   * index and is invalidated by the store, which knows when the findings changed
   * and when the route did. What this layer keeps is only the grouping, because
   * the grouping is a drawing decision: one element carrying three findings is
   * ONE badge, and the store has no reason to know that.
   */
  let marks: Mark[] = []

  /** The finding the PANEL says its pointer is on, held as an id, not a node. */
  let activeFinding: string | null = null

  /** The badge we last told the panel about, so the mirror only fires on change. */
  let reportedHover: string | null = null

  const reportMarkerHover = (mark: Mark | null): void => {
    const id = mark ? mark.findings[0].id : null
    if (reportedHover === id) return
    reportedHover = id
    window.dispatchEvent(
      new CustomEvent(MARKER_HOVER_EVENT, {
        detail: { id, ids: mark ? mark.findings.map((finding) => finding.id) : [] },
      })
    )
  }

  /**
   * Whether this layer is the one drawing right now.
   *
   * Two facts and no third: the single `MarkerLayer` value says the audit owns
   * the canvas rather than the notes, and `editorOwnsInput` says the chrome has
   * not stood down — the same guard the annotation layer applies, because an
   * editor that has handed the page back must not leave its own marks over it.
   */
  const shown = (): boolean => markerLayer() === "audit" && editorOwnsInput()

  /**
   * One element, one badge, worst severity wins.
   *
   * Two findings on the same element is the normal case rather than the edge
   * one — a card with a hardcoded colour and an undeclared elevation token is
   * one rule block and two violations — and drawing two badges there would put
   * them on the same corner, which is precisely the collision the two LAYERS
   * are kept apart to avoid. So they collapse: one plate, the worse of the two
   * severities, every message in the tooltip, and the stacked treatment so the
   * page says there is more than one without needing to be hovered.
   */
  const regroup = (): void => {
    const byElement = new Map<Element, Mark>()
    for (const { finding, elements } of lintResolution()) {
      for (const element of elements) {
        const existing = byElement.get(element)
        if (existing) {
          existing.findings.push(finding)
          if (finding.severity === "error") existing.severity = "error"
          continue
        }
        if (byElement.size >= MAX_BADGES) continue
        byElement.set(element, {
          element,
          findings: [finding],
          severity: finding.severity === "error" ? "error" : "warning",
          label: "",
        })
      }
    }
    for (const mark of byElement.values()) {
      mark.findings.sort((left, right) => worst(right) - worst(left))
      mark.label = describe(mark)
    }
    marks = [...byElement.values()]
  }

  /* ---------- the badges ---------- */

  const markFor = (id: string | undefined): Mark | null =>
    marks.find((mark) => mark.findings[0].id === id) ?? null

  const badgeAt = (index: number): HTMLButtonElement => {
    const pooled = badges[index]
    if (pooled) return pooled
    const badge = el("button", {
      class: "de-lint-marker",
      type: "button",
      "data-de-lint-marker": "badge",
      // The layer is inert so it cannot swallow the app's clicks; each thing
      // that has to be pressed opts back in for itself, the same shape the
      // annotation pins and the resize handles use.
      style: "pointer-events:auto",
    })
    /*
     * No glyph: the plate's severity colour and corner are the mark, and its
     * `title` (written in the repaint below) shows what was found on hover.
     */

    badge.addEventListener("click", (event) => {
      // The badge belongs to the editor, not to the page beneath it: a click
      // that fell through would navigate the app out from under the finding.
      event.preventDefault()
      event.stopPropagation()
      const mark = markFor(badge.dataset.finding)
      if (!mark) return
      const target = asLayerElement(mark.element)
      if (target) context.select(target)
    })
    /*
     * The mirror of the panel's own hover, with the mark captured on the way IN
     * rather than re-read on the way out.
     *
     * The badges are pooled, so the button under the pointer this frame may
     * carry a different element the next. A leave handler that looked the mark
     * up again could clear a highlight for a finding the pointer never touched,
     * or — worse — decline to clear the one it did. The annotation layer hit
     * exactly this, and the guard below is its guard.
     */
    let entered: string | null = null
    badge.addEventListener("pointerenter", () => {
      const mark = markFor(badge.dataset.finding)
      entered = mark ? mark.findings[0].id : null
      reportMarkerHover(mark)
    })
    badge.addEventListener("pointerleave", () => {
      if (reportedHover === entered) reportMarkerHover(null)
      entered = null
    })
    badges.push(badge)
    layer.append(badge)
    return badge
  }

  const outlineAt = (index: number): HTMLElement => {
    const pooled = outlines[index]
    if (pooled) return pooled
    const outline = el("div", { class: "de-lint-marker-box" })
    outlines.push(outline)
    // Before every badge in the DOM, so a 1px frame can never be painted over
    // the plate that names it. Neither carries a z-index, for the reason
    // `css/canvas.ts` records about this overlay.
    layer.insertBefore(outline, badges[0] ?? null)
    return outline
  }

  /**
   * Where a mark goes this frame, or `null` when it is off screen.
   *
   * Off-screen marks are hidden rather than parked past the edge, because a
   * button positioned out of view is still in the tab order and Tab would walk
   * findings nobody can see. The bleed is the annotation layer's 32px, so a
   * badge half over the top edge still draws the half that is visible instead
   * of blinking out at exactly the wrong moment of a scroll.
   *
   * There is no stored-rect fallback here, and that is the difference from a
   * note. A note outlives its element — it is written down, it survives a
   * reload, and a page rect is the last thing it has left. A finding does not:
   * it is re-resolved from the document every time the audit runs, so an
   * element that is gone means the marker is gone, and drawing a badge at the
   * coordinate one used to occupy would be marking a violation that may well
   * have been the thing that was just deleted.
   */
  const placement = (mark: Mark): Placement | null => {
    if (!mark.element.isConnected) return null
    const rect = mark.element.getBoundingClientRect()
    if (rect.left < -BLEED || rect.top < -BLEED) return null
    if (rect.left > window.innerWidth + BLEED || rect.top > window.innerHeight + BLEED) return null
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }

  const describe = (mark: Mark): string => {
    const first = mark.findings[0]
    if (mark.findings.length === 1) return `${first.rule}: ${first.message}`
    return `${mark.findings.length} issues · ${mark.findings
      .map((finding) => finding.message)
      .join(" · ")}`
  }

  /**
   * One badge and one outline per marked element.
   *
   * Every rect is read before anything is written, for the reason
   * `canvas/selection` spells out: a style write between two reads invalidates
   * layout, so an interleaved pass costs one synchronous reflow per mark on
   * every frame of a scroll. With two hundred badges allowed, that is the
   * difference between a scroll and a slideshow.
   */
  /** The mark each pooled badge last drew, so its title and classes are written only on change. */
  const drawn: Array<Mark | null> = []
  /** Last frame's geometry, so a still page can stop polling every frame. */
  let geometry: Array<Placement | null> = []

  const paint = (): boolean => {
    const points = shown() ? marks.map(placement) : []
    const same = (a: Placement | null, b: Placement | null) =>
      a === b || (a !== null && b !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height)
    const moved = points.length !== geometry.length || points.some((point, index) => !same(point, geometry[index]))
    geometry = points

    /** Which findings ended up on screen, so the mirror can be reconciled. */
    const onScreen = new Set<string>()

    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]
      const badge = badgeAt(index)
      const outline = outlineAt(index)
      if (!point) {
        badge.style.display = "none"
        // `toggle(…, false)`, not `remove`: `remove` rewrites the attribute even
        // when the class is absent, a write every pass over a still page.
        badge.classList.toggle(MARKER_ACTIVE, false)
        outline.style.display = "none"
        continue
      }
      const mark = marks[index]
      const primary = mark.findings[0]
      onScreen.add(primary.id)

      outline.style.display = "block"
      outline.style.left = `${point.left}px`
      outline.style.top = `${point.top}px`
      outline.style.width = `${point.width}px`
      outline.style.height = `${point.height}px`

      badge.style.display = "inline-flex"
      badge.style.left = `${point.left}px`
      badge.style.top = `${point.top}px`
      // Written only on change. These are what would otherwise be re-set on
      // every frame of every scroll, and `title` in particular closes the
      // tooltip the user is reading the moment it is re-set.
      if (badge.dataset.finding !== primary.id) {
        badge.dataset.finding = primary.id
        // The same hook the panel stamps on its rows, so a test — and the
        // panel's scroll-into-view — can pair a row with its badge by id.
        badge.setAttribute("data-de-lint-id", primary.id)
      }
      // Re-stated whenever this pooled badge takes a different mark: a badge
      // that last drew an error would keep reading as one under whichever mark
      // reuses it next. A regroup builds new marks, so it re-states them all.
      if (drawn[index] !== mark) {
        drawn[index] = mark
        if (badge.title !== mark.label) {
          badge.title = mark.label
          badge.setAttribute("aria-label", mark.label)
        }
        const error = mark.severity === "error"
        badge.classList.toggle("de-lint-marker--error", error)
        badge.classList.toggle("de-lint-marker--warning", !error)
        outline.classList.toggle("de-lint-marker-box--error", error)
        outline.classList.toggle("de-lint-marker-box--warning", !error)
        badge.classList.toggle("de-lint-marker--stacked", mark.findings.length > 1)
      }
      // Derived from the id every frame rather than latched when the event
      // arrived, so the emphasis follows the FINDING through a repool instead of
      // staying on the button it first landed on.
      badge.classList.toggle(
        MARKER_ACTIVE,
        activeFinding !== null && mark.findings.some((finding) => finding.id === activeFinding)
      )
    }
    for (let index = points.length; index < badges.length; index += 1) {
      badges[index].style.display = "none"
      badges[index].classList.toggle(MARKER_ACTIVE, false)
      if (outlines[index]) outlines[index].style.display = "none"
    }

    // Gone, not merely off screen. A badge scrolled out of view under a row the
    // pointer is still on must light up again when it scrolls back, so the id
    // survives; what it must never survive is the finding itself going away.
    if (activeFinding && !marks.some((mark) => mark.findings.some((f) => f.id === activeFinding))) {
      activeFinding = null
    }
    // The mirror is the opposite case and answers to the pointer: a badge that
    // is no longer painted is a badge the pointer is no longer on, whatever the
    // browser did or did not send us on the way out.
    if (reportedHover && !onScreen.has(reportedHover)) reportMarkerHover(null)
    return moved
  }

  let frame = 0
  let destroyed = false
  /** The slow poll a still page drops to, and how many still frames earned it. */
  let idleTimer = 0
  let stillFrames = 0
  const STILL_FRAMES = 30
  const IDLE_POLL_MS = 250

  const schedule = (): void => {
    if (destroyed || frame !== 0) return
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = 0
    }
    frame = requestAnimationFrame(draw)
  }
  /** Every event that may move something wakes the loop at once and resets the count. */
  const wake = (): void => {
    stillFrames = 0
    schedule()
  }
  const paintNow = (): void => {
    if (destroyed || !layer.isConnected) return
    paint()
    wake()
  }

  /**
   * Whether anything on screen can move without telling us.
   *
   * Every audit mark is pinned to a LIVE element by construction — a finding
   * with no element on this page has no mark — so the answer is simply whether
   * there are any. A sticky header, an accordion or a layout animation moves an
   * element without firing an event worth waking on, which is why this is a
   * frame loop and not a scroll listener. With the layer hidden, or with
   * nothing resolved, it costs no frames at all.
   *
   * Per frame while anything moves, four times a second once every mark has
   * held still for half a second — the same backoff the note pins use. An
   * animation that starts with no input is followed within one poll and per
   * frame from then on; scroll, resize, pointer and key events and every lint
   * or layer change wake the loop at once.
   */
  const tracking = (): boolean => shown() && marks.length > 0

  function draw(): void {
    frame = 0
    if (!layer.isConnected) {
      destroyed = true
      teardown()
      return
    }
    stillFrames = paint() ? 0 : stillFrames + 1
    if (!tracking()) return
    if (stillFrames < STILL_FRAMES) schedule()
    else poll()
  }

  /*
   * The poll paints from its own timer rather than requesting a frame for it:
   * a pass over a still page writes nothing, and a frame requested only to
   * find that out cost a frame callback and a compositor commit each time.
   */
  function poll(): void {
    idleTimer = setTimeout(() => {
      idleTimer = 0
      if (destroyed) return
      if (paint()) wake()
      else if (tracking()) poll()
    }, IDLE_POLL_MS) as unknown as number
  }

  /* ---------- wiring ---------- */

  const onPanelHover = (event: Event): void => {
    const detail = (event as CustomEvent<{ id?: string | null }>).detail
    const next = typeof detail?.id === "string" ? detail.id : null
    if (next === activeFinding) return
    activeFinding = next
    wake()
  }

  /*
   * The two ends of the one exclusive value, tied together HERE.
   *
   * `MarkerLayer` in `annotations/store` is the state — see its comment for why
   * the exclusion cannot be two booleans — and the lint store exposes it to the
   * panel as `markersShown` / `setMarkersShown`, which is the vocabulary a
   * checkbox in the Design system tab wants. This module owns the relationship
   * between the two layers, so this is where the two spellings are kept saying
   * the same thing: whichever side moved, the other is told, and both setters
   * return early on no change so the pair settles in one hop instead of looping.
   *
   * `false` maps back to `"notes"` rather than to a third "nothing" state,
   * because Hide markers is a statement about the AUDIT: the canvas goes back to
   * the layer it had before the audit claimed it. Hiding the notes as well is
   * `hideUntilRestart`, which is the setting that already means that.
   *
   * This adapter should not survive. It exists because the lint store keeps its
   * own boolean; the moment `markersShown` there is `markerLayer() === "audit"`,
   * both functions below become dead and should be deleted with it.
   */
  const adoptPanelToggle = (): void => setMarkerLayer(markersShown() ? "audit" : "notes")
  const publishLayer = (): void => setMarkersShown(markerLayer() === "audit")

  const onLintChange = (): void => {
    adoptPanelToggle()
    regroup()
    wake()
  }

  const onLayerChange = (): void => {
    publishLayer()
    wake()
  }

  window.addEventListener(HOVER_EVENT, onPanelHover)
  // Capture, because `scroll` does not bubble: a finding inside a scrolling
  // panel would otherwise only be repositioned when the window itself moved.
  window.addEventListener("scroll", wake, { capture: true, passive: true })
  window.addEventListener("resize", wake)
  window.addEventListener("pointerdown", wake, { capture: true, passive: true })
  window.addEventListener("keydown", wake, { capture: true, passive: true })

  // Registered before the first read, so the panel's very first summary counts
  // the same elements the canvas is about to draw.
  setLintResolver(resolveFinding)
  const stopLint = subscribeToLint(onLintChange)
  const stopLayer = onMarkerLayerChange(onLayerChange)
  // Every input of the stand-down gate, `canvasView` included: badges hidden
  // for the board used to stay hidden after it closed, until something scrolled.
  // Painted in this task, not the next frame: see the note pins' twin of this.
  const unsubscribe = context.subscribe((next, previous) => {
    if (editorStandDownChanged(next, previous)) queueMicrotask(paintNow)
  })

  function teardown(): void {
    unsubscribe()
    stopLint()
    stopLayer()
    setLintResolver(null)
    window.removeEventListener(HOVER_EVENT, onPanelHover)
    window.removeEventListener("scroll", wake, true)
    window.removeEventListener("resize", wake)
    window.removeEventListener("pointerdown", wake, true)
    window.removeEventListener("keydown", wake, true)
    if (idleTimer) clearTimeout(idleTimer)
    // A layer torn down mid-hover would otherwise leave the panel lighting a
    // row whose badge no longer exists to un-light it.
    reportMarkerHover(null)
  }

  regroup()
  schedule()
  window.addEventListener("beforeunload", () => {
    destroyed = true
    teardown()
    if (frame) cancelAnimationFrame(frame)
  })
}
