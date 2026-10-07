/**
 * Placing a library component on the page.
 *
 * Two gestures reach this file — dragging a card out of the Assets panel, and
 * pressing "Insert instance" in the details popover — and they share one
 * placement engine and one write, because the alternative is two definitions of
 * where a component lands that agree right up until somebody fixes one of them.
 *
 * ---------------------------------------------------------------------------
 * THE ONE DECISION, AND IT IS NOT NEGOTIABLE: WE DO NOT TOUCH THE APP'S DOM
 * ---------------------------------------------------------------------------
 *
 * Everything below resolves a container, an index and a rectangle, draws a line
 * where the component WILL go, and then posts an operation to the loopback
 * server. Nothing here ever calls `append`, `insertBefore` or `prepend` on an
 * element of the page being edited. The component appears when the file on disk
 * changes and the dev server's hot reload re-renders — a few hundred
 * milliseconds after the drop, not on the drop.
 *
 * That gap is the first thing a future reader will want to close, and it is the
 * one change in this file that reliably blanks the page. Read the comment on
 * `DELETED_ATTRIBUTE` in `src/core/dom.ts`: inserting a node into a tree React
 * rendered leaves the next commit reconciling against children it does not
 * know, and the measured result on a live Vite app was a perfect-looking edit
 * followed by an empty document the instant Fast Refresh ran. Deleting an
 * element in this editor is a `display: none` preview for exactly that reason —
 * the node stays where the framework put it and only LOOKS gone.
 *
 * Insertion has no equivalent trick available to it. A deletion can be previewed
 * because the node already exists and only its visibility is in question; an
 * insertion has nothing to hide, because the thing being previewed is not in the
 * tree at all and the only way to show it is to put it there. So the preview an
 * insertion gets is the INDICATOR — a line at the boundary, a pending pulse
 * while the request is in flight, and a toast saying the element arrives on
 * reload. That is less immediate than a DOM node and it is the most this can
 * honestly be.
 *
 * If you are here to make it snappier: the fix is a faster server round trip or
 * a better pending state, never a node.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RESOLUTION IS SHAPED THE WAY IT IS
 * ---------------------------------------------------------------------------
 *
 * "Respects the element grouping and auto-layout, just like in Figma" is a
 * feeling, and the five steps in `dropTargetAt` are what that feeling is made
 * of. Figma can read its own scene graph and simply knows a frame's layout
 * mode; we have a rendered page, so the layout mode has to be recovered from
 * computed style, and the insertion index has to be recovered from where the
 * pointer sits relative to each child's MIDPOINT along the main axis. The
 * midpoint, not the edge: an edge test makes the boundary flip a pixel after
 * the pointer crosses into a child, which reads as the indicator lagging, while
 * a midpoint test flips exactly when the pointer is nearer one neighbour than
 * the other, which reads as the indicator anticipating.
 */

import { isAngularHost } from "../core/angular"
import { resolveElementSource } from "../core/bridge"
import { el, isChrome } from "../core/dom"
import { tokens } from "../core/tokens"
import { prefersReducedMotion } from "../core/motion"
import { describeTarget, type ElementTarget } from "../core/element-target"
import { isLayerCandidate } from "../core/resolve"
import type { EditorContext } from "../core/context"

/* ---------- shapes ---------- */

/** Where a component would land, and what to paint to say so. */
export interface DropTarget {
  container: Element
  /**
   * Index among the container's element children to insert before;
   * `children.length` means append.
   *
   * "Element children" is narrower than `container.children` by exactly the
   * nodes that are not part of the authored page: the editor's own chrome, and
   * an element the user has deleted but the framework has not yet removed. Both
   * are filtered by `isLayerCandidate`, which is the one definition of "is this
   * a layer" every other surface in the editor already asks. Counting a deleted
   * sibling here would offset every index past it against a source file that no
   * longer has it.
   */
  index: number
  /** Which way the container lays its children out, for the indicator. */
  axis: "row" | "column"
  /** The rectangle the indicator should paint. */
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * A component this file can place, which is a library component plus the four
 * facts the source writer needs and the values the popover chose.
 *
 * Declared here rather than added to `LibraryComponent` in `libraries/types.ts`
 * because this lane does not own that file. Every field beyond `id`/`name` is
 * optional, so a `LibraryComponent` is assignable to this as it stands and the
 * two converge without a coordinated edit — and when `types.ts` grows the
 * fields, this interface becomes the subset of them that placement uses, which
 * is the honest thing for it to be either way.
 */
export interface PlaceableComponent {
  id: string
  name: string
  /** The Angular custom-element tag, when the framework it came from has one. */
  selector?: string
  /** What to paste, e.g. `<Button variant="primary">Label</Button>`. */
  snippet?: string
  /** Declaring file, relative to the project root. The import is built from it. */
  file?: string
  /** The identifier to import; empty for a default export. */
  exportName?: string
  defaultExport?: boolean
  /**
   * The property values the details popover was showing when the button was
   * pressed, folded into the markup as attributes.
   *
   * It rides on the component rather than arriving as a fourth argument
   * because the API in the contract has three, and because the two are read at
   * the same instant by the same click — a caller that had one and not the
   * other would be describing a component nobody chose.
   */
  values?: Record<string, string | boolean>
}

type SourcePosition = "before" | "after" | "prepend" | "append"

/** Lane O's wire shape, stated here because this is the only thing that sends it. */
interface InsertOperation {
  op: "insertElement"
  componentName: string
  filePath: string | null
  target: ElementTarget | null
  position: SourcePosition
  markup: string
  import?: { from: string; name: string; defaultImport: boolean }
}

/**
 * The reply, which is deliberately the same shape `/source/remove` returns.
 *
 * Written out rather than imported as `RemovalResult`: the shape is pinned by
 * the contract, but a type named for removals sitting in the insert path would
 * read as a copy-paste every time somebody opened this file, and the bond it
 * would create is between two routes that are only obliged to agree on this
 * shape today.
 */
interface InsertResult {
  applied: Array<{ op: string; filePath: string; lineNumber: number }>
  failed: Array<{ reason: string; operation: { op: string; componentName: string } }>
}

/* ---------- step 1: what is under the pointer ---------- */

/**
 * The deepest element of the PAGE at a point, or nothing when the editor is in
 * the way.
 *
 * The chrome test comes FIRST and it is a hard stop, not a filter. That
 * distinction is the whole correctness of this function and it was got wrong
 * once already: `elementsFromPoint` returns the whole stack, so a pointer
 * resting on the Assets panel answers with the panel AND with whatever page
 * element happens to lie behind it. Skipping the chrome and taking the next
 * survivor therefore resolves a drop target the user cannot see, under a panel
 * they are only hovering — and then paints an indicator for it somewhere else
 * on the screen. A pointer over the editor is over the EDITOR.
 *
 * It is safe to be that strict because `elementsFromPoint` already honours
 * `pointer-events`, and every piece of chrome that floats over the canvas —
 * the overlay layer, this file's own indicator and drag ghost — is
 * `pointer-events: none` and never appears in the stack at all. What remains
 * is chrome that genuinely intercepts the pointer, which is exactly the chrome
 * that should occlude.
 *
 * `isChrome` and `isLayerCandidate` rather than a hand-rolled `closest()` call:
 * the chrome selector, the vendor root and the host's configured
 * `trustedSelectors` are assembled once in `core/dom`, and a second copy here
 * would be a second thing to keep in step. `isLayerCandidate` adds two
 * exclusions this needs on top — `document.body` and the documentElement, so
 * bare page background resolves to nothing rather than to a "container" no
 * framework writes into, and elements carrying `DELETED_ATTRIBUTE`, which are
 * on screen only because removing them would break the reconciler and must not
 * be offered as somewhere to put a new component.
 *
 * Guarded because the API is optional where this runs outside a browser; a host
 * that cannot hit-test yields no target, which is the same answer as a pointer
 * over nothing, and is safe.
 */
function deepestPageElementAt(x: number, y: number): Element | null {
  let stack: Element[] = []
  try {
    stack =
      typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(x, y) : []
  } catch {
    return null
  }
  if (stack.length === 0 || isChrome(stack[0])) return null
  for (const node of stack) {
    if (isLayerCandidate(node)) return node
  }
  return null
}

/* ---------- step 2: walk up to something that can hold children ---------- */

/**
 * Elements that take no children, whatever the DOM will technically let you do
 * to them.
 *
 * The HTML void elements plus the four that have children in name only: a
 * `<select>`'s children are options, a `<textarea>`'s are its value, and a
 * `<video>`/`<iframe>` holds a fallback nobody wants a design system component
 * dropped into. Inserting into any of these produces source that parses and
 * renders nothing.
 */
const NON_CONTAINER = new Set([
  "AREA",
  "BASE",
  "BR",
  "COL",
  "EMBED",
  "HR",
  "IFRAME",
  "IMG",
  "INPUT",
  "LINK",
  "META",
  "PARAM",
  "SOURCE",
  "TRACK",
  "WBR",
  "OPTION",
  "SELECT",
  "TEXTAREA",
])

/**
 * Whether this element can hold a new child.
 *
 * Three rejections, and the first covers more than it looks like. Only an
 * `HTMLElement` passes, which excludes an `<svg>` AND its whole interior in one
 * test — `<path>`, `<g>`, `<use>` are all `SVGElement`, and so is MathML's
 * equivalent. Spelling the SVG interior out as a tag list would have been a
 * list that grows; asking which DOM interface the node implements does not.
 *
 * The third is the one that makes drops feel right. A node whose only content
 * is text — a `<button>Save</button>`, a `<p>` of copy, a `<span>` label — is
 * not a container in the sense a designer means, even though the DOM would
 * happily accept a child. Dropping "into" one produces `<button>Save<Icon/>
 * </button>`, which is almost never the intent; climbing past it puts the
 * component BESIDE the button, which is. An element with no children and no
 * text is a genuinely empty box and does pass — that is the empty-container
 * case, and it gets an outline rather than a line.
 */
function canHoldChildren(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (NON_CONTAINER.has(element.tagName)) return false
  if (element.children.length === 0 && (element.textContent ?? "").trim().length > 0) return false
  return true
}

/** The element children that exist in the source, in document order. */
function elementChildren(container: Element): Element[] {
  return Array.from(container.children).filter((child) => isLayerCandidate(child))
}

/** The nearest ancestor-or-self that can take a child, or null at the top. */
function containerFrom(start: Element | null): Element | null {
  for (let node: Element | null = start; node; node = node.parentElement) {
    if (!isLayerCandidate(node)) continue
    if (canHoldChildren(node)) return node
  }
  return null
}

/* ---------- step 3: which way does this container lay out ---------- */

function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * How many columns a grid has, from its computed template.
 *
 * A browser resolves `grid-template-columns` to used track sizes — `"240px
 * 240px"` — so counting whitespace-separated tokens is the whole job there.
 * Line names are stripped first because `[full-start] 1fr [full-end]` is one
 * track wearing two labels, and a `repeat()` that survived resolution is
 * expanded by multiplying its count by the tracks inside it, so a template
 * written rather than resolved still reads as the number of columns it means.
 */
function countGridColumns(template: string): number {
  const cleaned = template.replace(/\[[^\]]*\]/g, " ").trim()
  if (!cleaned || cleaned === "none") return 1
  let total = 0
  let rest = cleaned
  const repeat = /repeat\(\s*(\d+)\s*,([^()]*)\)/g
  for (const match of cleaned.matchAll(repeat)) {
    const tracks = match[2].trim().split(/\s+/).filter(Boolean).length
    total += Number.parseInt(match[1], 10) * Math.max(1, tracks)
    rest = rest.replace(match[0], " ")
  }
  total += rest.trim().split(/\s+/).filter(Boolean).length
  return Math.max(1, total)
}

/**
 * The main axis the container's children flow along.
 *
 * Flex states it. Grid does not have one, so the question becomes whether a new
 * child would sit beside its neighbours or below them — with more than one
 * column it is beside, which is a row. Normal block flow stacks, so it is a
 * column, with the one exception that matters on a real page: a box whose every
 * child is inline-level is a LINE of things, and a drop into a row of chips or
 * a sentence of links has to insert horizontally or the indicator points across
 * the flow it is supposed to be describing.
 */
function axisOf(container: Element, style: CSSStyleDeclaration): "row" | "column" {
  const display = style.display
  if (display === "flex" || display === "inline-flex") {
    return style.flexDirection.startsWith("row") ? "row" : "column"
  }
  if (display === "grid" || display === "inline-grid") {
    return countGridColumns(style.gridTemplateColumns) > 1 ? "row" : "column"
  }
  const children = elementChildren(container)
  if (children.length === 0) return "column"
  const allInline = children.every((child) => getComputedStyle(child).display.startsWith("inline"))
  return allInline ? "row" : "column"
}

/** True when the flex container paints its children against document order. */
function isReversed(style: CSSStyleDeclaration): boolean {
  if (style.display !== "flex" && style.display !== "inline-flex") return false
  return style.flexDirection.endsWith("-reverse")
}

/* ---------- steps 4 and 5: the index, and the line to draw ---------- */

/** The indicator is a 2px rule; the constant is shared by the geometry below. */
const INDICATOR_THICKNESS = 2

/** The container's content box in client coordinates — border and padding off. */
function contentBox(
  container: Element,
  style: CSSStyleDeclaration
): { x: number; y: number; width: number; height: number } {
  const rect = container.getBoundingClientRect()
  const left = px(style.borderLeftWidth) + px(style.paddingLeft)
  const right = px(style.borderRightWidth) + px(style.paddingRight)
  const top = px(style.borderTopWidth) + px(style.paddingTop)
  const bottom = px(style.borderBottomWidth) + px(style.paddingBottom)
  return {
    x: rect.left + left,
    y: rect.top + top,
    width: Math.max(0, rect.width - left - right),
    height: Math.max(0, rect.height - top - bottom),
  }
}

/**
 * The rule to paint at a boundary, spanning the container's cross axis.
 *
 * Placed in the GAP between the two neighbours rather than flush against the
 * next child's edge. Both satisfy "a line at that boundary", and the gap is the
 * one a designer reads as "between these two": a rule sitting on a child's
 * leading edge looks like it belongs to that child, which in a container with
 * generous spacing makes an insertion before the third item look like an
 * insertion into it. At either end of the list there is only one neighbour, so
 * the line lands on its outer edge.
 */
function lineAt(
  rects: DOMRect[],
  visual: number,
  axis: "row" | "column",
  box: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const leading = (rect: DOMRect) => (axis === "row" ? rect.left : rect.top)
  const trailing = (rect: DOMRect) => (axis === "row" ? rect.right : rect.bottom)
  const before = visual > 0 ? rects[visual - 1] : null
  const after = visual < rects.length ? rects[visual] : null

  let at = 0
  if (before && after) at = (trailing(before) + leading(after)) / 2
  else if (after) at = leading(after)
  else if (before) at = trailing(before)

  const half = INDICATOR_THICKNESS / 2
  return axis === "row"
    ? { x: at - half, y: box.y, width: INDICATOR_THICKNESS, height: box.height }
    : { x: box.x, y: at - half, width: box.width, height: INDICATOR_THICKNESS }
}

/**
 * Steps 3 to 5 for a container that is already known.
 *
 * Split out from `dropTargetAt` because the click path needs the same answer
 * without a pointer to hit-test with, and "where does a component land in this
 * box" must have one implementation or the two gestures will drift apart.
 *
 * Reverse directions are handled by scanning in VISUAL order and converting the
 * result back, rather than by flipping the comparison. The scan assumes the
 * midpoints it walks increase along the axis, which is true on screen and false
 * in document order the moment a container is `row-reverse`; sorting the
 * problem into the space where the assumption holds is what keeps the
 * comparison itself a single `<`. The conversion is the mirror: a slot `v`
 * positions from the visual start, and the same slot counted from the document
 * start is `children.length - v`.
 */
function resolveInto(container: Element, x: number, y: number): DropTarget {
  const style = getComputedStyle(container)
  const axis = axisOf(container, style)
  const box = contentBox(container, style)
  const children = elementChildren(container)

  // No children, no boundary: the whole content box is the mark, and the index
  // is the only one there is.
  if (children.length === 0) return { container, index: 0, axis, rect: box }

  const reversed = isReversed(style)
  const ordered = reversed ? [...children].reverse() : children
  const rects = ordered.map((child) => child.getBoundingClientRect())
  const pointer = axis === "row" ? x : y

  let visual = ordered.length
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i]
    const midpoint = axis === "row" ? rect.left + rect.width / 2 : rect.top + rect.height / 2
    if (pointer < midpoint) {
      visual = i
      break
    }
  }

  return {
    container,
    index: reversed ? children.length - visual : visual,
    axis,
    rect: lineAt(rects, visual, axis, box),
  }
}

/** Resolve where a pointer position would place a component. */
export function dropTargetAt(x: number, y: number): DropTarget | null {
  const container = containerFrom(deepestPageElementAt(x, y))
  if (!container) return null
  return resolveInto(container, x, y)
}

/* ---------- the indicator ---------- */

/**
 * The overlay the indicator draws into.
 *
 * `showDropIndicator` takes only a target, so the layer has to be remembered
 * from the two entry points that do carry an `EditorContext`. The query is the
 * fallback for a caller that shows an indicator before either of them has run;
 * it looks for the shell's own layer and nothing else, because mounting into
 * `document.body` would put editor chrome inside the app's tree — the very
 * thing the header of this file exists to forbid.
 */
let overlayHost: HTMLElement | null = null
let indicator: HTMLElement | null = null

function rememberOverlay(editor: EditorContext): void {
  overlayHost = editor.slots.overlay
}

function indicatorHost(): HTMLElement | null {
  if (overlayHost?.isConnected) return overlayHost
  const found = document.querySelector(".de-overlay-layer")
  return found instanceof HTMLElement ? found : null
}

/**
 * Paint the boundary, or take it down with `null`.
 *
 * Whether the mark is a line or an outline is re-derived from the container
 * rather than carried as a fifth field on `DropTarget`: the interface is fixed
 * by the contract, and the fact is already in the target — a container with no
 * element children has no boundary between children to point at.
 */
export function showDropIndicator(target: DropTarget | null): void {
  if (!target) {
    indicator?.remove()
    indicator = null
    return
  }
  const host = indicatorHost()
  if (!host) return
  if (!indicator) indicator = el("div", { class: "de-insert-indicator", "aria-hidden": "true" })
  if (indicator.parentElement !== host) host.append(indicator)

  const outline = elementChildren(target.container).length === 0
  indicator.className = `de-insert-indicator${outline ? " de-insert-indicator--outline" : ""}`
  indicator.style.transform = `translate(${Math.round(target.rect.x)}px, ${Math.round(target.rect.y)}px)`
  indicator.style.width = `${Math.max(1, Math.round(target.rect.width))}px`
  indicator.style.height = `${Math.max(1, Math.round(target.rect.height))}px`
}

/** The in-flight state: the mark stays where it is and breathes. */
function setIndicatorPending(pending: boolean): void {
  if (!indicator) return
  indicator.classList.toggle("de-insert-indicator--pending", pending)
}

/**
 * Which mark is on screen, for the settle in `commitInsert` to hold on to.
 *
 * The identity matters rather than the presence: a drag begun during the beat
 * after a commit reuses this same node, and the settle must not then remove a
 * mark that now belongs to a gesture in progress.
 */
function currentIndicator(): HTMLElement | null {
  return indicator
}

/** How long a finished mark holds still before it goes. One rung, read off the ramp. */
const SETTLE_MS = (): number =>
  prefersReducedMotion() ? 0 : Number.parseFloat(tokens.duration.reveal)

/* ---------- the drag ---------- */

/**
 * Four pixels, against the canvas gestures' three.
 *
 * The threshold exists for one reason: a press on a card is a click that opens
 * the details popover, and it must stay one even when the hand moves a little
 * while pressing. A card is a bigger, softer target than a resize handle and it
 * is pressed with less precision, so it wants a slightly wider dead zone than
 * `marquee.ts` and `transform.ts` use — but the same shape of rule, the same
 * `Math.hypot` against the press origin, and the same "nothing at all happens
 * until it is crossed".
 */
const DRAG_THRESHOLD = 4

/** One gesture at a time; a second pointer down mid-drag is not a second drag. */
let dragging = false

const CARD_SELECTOR = `[data-de-asset="card"]`

/**
 * What follows the pointer: the card's own preview, cloned.
 *
 * Cloned out of the pressed card rather than re-rendered from the component,
 * so the drag never introduces a second depiction of the thing being dragged —
 * and so this file needs nothing from the preview module, which another lane
 * owns. The clone is scrubbed of `id` and `data-de-asset*` before it is
 * mounted: a duplicated `id` is invalid in the document it is dropped into, and
 * a duplicated test hook would make a query for "the card for component X"
 * return the ghost as readily as the card.
 */
function buildGhost(pressed: Element | null, component: PlaceableComponent): HTMLElement {
  const ghost = el("div", { class: "de-insert-ghost", "aria-hidden": "true" })
  const card = pressed?.closest(CARD_SELECTOR) ?? null
  if (card) {
    const clone = card.cloneNode(true) as Element
    for (const node of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
      node.removeAttribute("id")
      for (const attribute of Array.from(node.attributes)) {
        if (attribute.name.startsWith("data-de-asset")) node.removeAttribute(attribute.name)
      }
    }
    ghost.append(clone)
    return ghost
  }
  ghost.append(el("span", { class: "de-insert-ghost-name" }, [component.name]))
  return ghost
}

/**
 * Start a drag from a card's `pointerdown`.
 *
 * The listener set is `marquee.ts`'s: window-level, capture phase, torn down
 * together. Capture phase because a card lives inside a panel that stops
 * propagation of its own pointer events, and a drag that only hears about moves
 * the panel chose to let through is a drag that freezes the moment the pointer
 * leaves the panel — which is every drag this gesture exists for.
 */
export function beginAssetDrag(
  editor: EditorContext,
  component: PlaceableComponent,
  event: PointerEvent
): void {
  if (event.button !== 0 || dragging) return
  rememberOverlay(editor)

  const originX = event.clientX
  const originY = event.clientY
  const pressed = event.target instanceof Element ? event.target : null
  const pointerId = event.pointerId
  let started = false
  let target: DropTarget | null = null
  let ghost: HTMLElement | null = null
  dragging = true

  // Capture on the pressed card, exactly as the canvas gestures capture on the
  // element under the press: it guarantees the `pointerup` arrives here even if
  // the pointer is released over the app, an iframe, or off the window.
  let capture: Element | null = pressed
  if (capture && "setPointerCapture" in capture) {
    try {
      ;(capture as Element & { setPointerCapture(id: number): void }).setPointerCapture(pointerId)
    } catch {
      capture = null
    }
  } else {
    capture = null
  }

  const stop = (): void => {
    window.removeEventListener("pointermove", onPointerMove, true)
    window.removeEventListener("pointerup", onPointerUp, true)
    window.removeEventListener("pointercancel", onCancel, true)
    window.removeEventListener("keydown", onKeyDown, true)
    if (capture && "releasePointerCapture" in capture) {
      try {
        ;(capture as Element & { releasePointerCapture(id: number): void }).releasePointerCapture(
          pointerId
        )
      } catch {
        // A card removed mid-drag has already released it.
      }
    }
    capture = null
    ghost?.remove()
    ghost = null
    // Always taken down here. A commit puts its own pending mark back up in the
    // same task, so nothing paints in between.
    showDropIndicator(null)
    started = false
    dragging = false
  }

  function onPointerMove(move: PointerEvent): void {
    if (!started) {
      if (Math.hypot(move.clientX - originX, move.clientY - originY) < DRAG_THRESHOLD) return
      started = true
      ghost = buildGhost(pressed, component)
      indicatorHost()?.append(ghost)
    }
    // Only once the drag is real: a press that is still deciding must not
    // suppress the click it may yet turn out to be.
    move.preventDefault()
    if (ghost) {
      ghost.style.transform = `translate(${move.clientX + 12}px, ${move.clientY + 12}px)`
    }
    target = dropTargetAt(move.clientX, move.clientY)
    showDropIndicator(target)
  }

  function onPointerUp(): void {
    const committed = started ? target : null
    stop()
    // A press that never crossed the threshold is a click, and it belongs to
    // whoever wired the card's click handler. Releasing over nothing cancels in
    // silence: the user aimed at a place that cannot take a component and has
    // already seen the indicator refuse to appear there.
    if (committed) void insertComponent(editor, component, committed)
  }

  function onCancel(): void {
    stop()
  }

  function onKeyDown(key: KeyboardEvent): void {
    if (key.key !== "Escape") return
    key.preventDefault()
    key.stopPropagation()
    stop()
  }

  window.addEventListener("pointermove", onPointerMove, true)
  window.addEventListener("pointerup", onPointerUp, true)
  window.addEventListener("pointercancel", onCancel, true)
  window.addEventListener("keydown", onKeyDown, true)
}

/* ---------- the write ---------- */

/**
 * A value the server's markup allowlist would refuse.
 *
 * §2 of the contract accepts quoted attribute values with no `<`, `>` or
 * backtick, and refuses braces outright. Screening here rather than letting the
 * request 400 is not about trusting the server less — it is that the only thing
 * a designer can do with "400: markup rejected" is guess which control caused
 * it, while dropping the one offending attribute still inserts the component.
 */
const UNSAFE_VALUE = /[<>"`{}]/
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g

/**
 * The snippet split into the three parts the markup is rebuilt from.
 *
 * Deliberately not a parser. A library snippet is one element written by the
 * component's own author, and the server re-validates whatever it is sent
 * against a much stricter allowlist than this, so the job here is to recover
 * the tag, the attributes and any text so the chosen property values can be
 * folded in — not to be right about arbitrary markup. Anything it cannot read
 * falls through to a synthesized element, which is a worse snippet and still a
 * valid one.
 */
function parseSnippet(snippet: string): { tag: string; attributes: string; inner: string } | null {
  const text = snippet.trim()
  const open = /^<([A-Za-z][A-Za-z0-9._-]*)([^<>]*?)(\/?)>/.exec(text)
  if (!open) return null
  const tag = open[1]
  const attributes = open[2].trim()
  if (open[3] === "/") return { tag, attributes, inner: "" }
  const close = text.lastIndexOf(`</${tag}`)
  const inner = close > open[0].length ? text.slice(open[0].length, close) : ""
  return { tag, attributes, inner }
}

/**
 * The tag to write when the component shipped no readable snippet.
 *
 * The two hosts name a component differently and neither name works on the
 * other: an Angular template instantiates a component by its SELECTOR, and JSX
 * instantiates one by the identifier it was imported as. A selector may be a
 * compound (`app-button[icon]`), so only its element-name head is usable as a
 * tag.
 */
function defaultTag(component: PlaceableComponent): string {
  if (isAngularHost() && component.selector) {
    const head = /^[A-Za-z][A-Za-z0-9._-]*/.exec(component.selector.trim())
    if (head) return head[0]
  }
  return (component.exportName || component.name).replace(/[^A-Za-z0-9._]/g, "")
}

/**
 * The element to write into source, with the popover's choices applied.
 *
 * Booleans are the compromise in here and it is worth naming. A true boolean is
 * written `name="true"` rather than as an expression, because the allowlist
 * refuses `{` and there is no other way to spell a JSX boolean; a false one is
 * dropped, because `name="false"` is the truthy STRING "false" in JSX and would
 * turn the control's meaning inside out. The cost is real and bounded: a
 * property whose declared default is true cannot be switched off through this
 * path, and has to be edited in the file afterwards.
 */
function markupFor(component: PlaceableComponent): string {
  const parsed = component.snippet ? parseSnippet(component.snippet) : null
  const tag = parsed?.tag ?? defaultTag(component)
  if (!tag) return ""

  const attributes = new Map<string, string>()
  if (parsed) {
    // Anything that is not a quoted attribute — a spread, a bare flag, an
    // expression — is left behind, because it is exactly what the server
    // refuses and what this cannot rewrite honestly.
    for (const match of parsed.attributes.matchAll(ATTRIBUTE)) {
      if (!UNSAFE_VALUE.test(match[2])) attributes.set(match[1], match[2])
    }
  }
  for (const [name, chosen] of Object.entries(component.values ?? {})) {
    const value = chosen === true ? "true" : chosen === false ? "" : String(chosen)
    if (!value || UNSAFE_VALUE.test(value)) {
      attributes.delete(name)
      continue
    }
    attributes.set(name, value)
  }

  const written = [...attributes].map(([name, value]) => ` ${name}="${value}"`).join("")
  // Nested markup in the snippet is dropped: §2 accepts simple text content
  // only, and half of an author's example element is not a component.
  const inner = parsed && !parsed.inner.includes("<") ? parsed.inner.trim() : ""
  return `<${tag}${written}>${inner}</${tag}>`
}

/**
 * What the receiving file has to import for the markup to compile.
 *
 * `from` is the declaring file as Lane P records it — project-relative, POSIX —
 * and it stays that way on the wire. The specifier a React file actually needs
 * is relative to the RECEIVING file, which the browser does not reliably know
 * (`filePath` is legitimately null on Angular, where the server resolves the
 * component itself), so the relativizing belongs to the side that always knows
 * both ends.
 */
function importFor(component: PlaceableComponent): InsertOperation["import"] {
  if (!component.file) return undefined
  const name = component.exportName || component.name
  if (!name) return undefined
  return { from: component.file, name, defaultImport: component.defaultExport === true }
}

/**
 * The element the server should find, and where to splice relative to it.
 *
 * A CHILD is the reference wherever there is one, never the container with an
 * index, and the reason is indentation: §2 has the server match the reference
 * node's own line, so pointing at a sibling puts the new element at the depth
 * of the things it is joining. It is also why `prepend` never gets used —
 * `before` the first child says the same thing about position and a better
 * thing about indentation. `append` is left for the empty container, where
 * there is no sibling to point at and the container's own line is the only
 * reference there is.
 */
function referenceFor(target: DropTarget): { element: Element; position: SourcePosition } {
  const children = elementChildren(target.container)
  if (children.length === 0) return { element: target.container, position: "append" }
  if (target.index >= children.length) {
    return { element: children[children.length - 1], position: "after" }
  }
  return { element: children[Math.max(0, target.index)], position: "before" }
}

/**
 * Where a click places, when no drag chose a spot.
 *
 * A selected container is aimed at its own far content corner rather than at
 * its centre, which runs the identical engine and lands on an append — the
 * behaviour a designer expects from "add this to that frame", and reached
 * without a second rule about indices that could disagree with the drag's.
 * With nothing usable selected it is the viewport centre, hit-tested exactly as
 * a drop would be.
 */
function clickTarget(editor: EditorContext): DropTarget | null {
  const selected = editor.primarySelection()?.element ?? null
  if (selected?.isConnected && canHoldChildren(selected)) {
    const box = contentBox(selected, getComputedStyle(selected))
    return resolveInto(selected, box.x + box.width, box.y + box.height)
  }
  return dropTargetAt(window.innerWidth / 2, window.innerHeight / 2)
}

/** The component whose file holds an element, without waiting for resolution. */
function knownComponentName(editor: EditorContext, element: Element): string {
  try {
    return editor.bridge.elementInfo(element)?.componentName ?? ""
  } catch {
    // The fiber lookup throws on a node the framework never rendered.
    return ""
  }
}

async function postInsert(apiBase: string, operation: InsertOperation): Promise<InsertResult> {
  const response = await fetch(`${apiBase}/source/insert`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ operations: [operation] }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null
    const stated = typeof body?.message === "string" ? body.message.trim() : ""
    throw new Error(stated || `Insert failed (${response.status})`)
  }
  return (await response.json()) as InsertResult
}

/**
 * Place the component, by writing it into the file that will render it.
 *
 * A `null` target means "you decide", which is the click path; the drag always
 * passes the target its indicator was drawing. Either way this is the only
 * function that sends the operation, so there is exactly one answer to "where
 * did that component go" and one place it is toasted from.
 *
 * The pending mark goes up before the first `await` and comes down in a
 * `finally`, so a failed resolution, a refused write and a dead server all
 * leave the page as they found it rather than with a line stuck on it.
 */
export async function insertComponent(
  editor: EditorContext,
  component: PlaceableComponent,
  target: DropTarget | null
): Promise<void> {
  rememberOverlay(editor)
  const placement = target ?? clickTarget(editor)
  if (!placement) {
    editor.toast(`Nowhere to place ${component.name}. Select a container first`, "error")
    return
  }

  const markup = markupFor(component)
  if (!markup) {
    editor.toast(`Cannot insert ${component.name} in this app`, "error")
    return
  }

  const reference = referenceFor(placement)
  showDropIndicator(placement)
  setIndicatorPending(true)
  editor.toast(`Inserting ${component.name}…`)

  try {
    // Resolved against the REFERENCE element, not the container: the server has
    // to find that node in the file it is editing, and a container written in
    // one file can hold children projected in from another.
    const source = await resolveElementSource(editor.bridge, reference.element)
    const componentName = source?.componentName || knownComponentName(editor, reference.element)
    if (!componentName) {
      throw new Error("Could not find the component that renders that element")
    }

    const result = await postInsert(editor.apiBase, {
      op: "insertElement",
      componentName,
      filePath: source?.filePath ?? null,
      target: describeTarget(reference.element),
      position: reference.position,
      markup,
      import: importFor(component),
    })

    if (result.applied.length && !result.failed.length) {
      // The wording is load-bearing. Nothing visible changes at this moment —
      // see the header — and a bare "Inserted" over an unchanged page reads as
      // a lie until the reload lands a second later.
      editor.toast(`Inserted ${component.name}. It appears when the page reloads`)
      return
    }
    const reason = result.failed[0]?.reason ?? "the server wrote nothing"
    editor.toast({ title: `Could not insert ${component.name}`, description: `${reason[0].toUpperCase()}${reason.slice(1)}.` }, "error")
  } catch (error) {
    editor.toast(error instanceof Error ? error.message : `Could not insert ${component.name}`, "error")
  } finally {
    /*
     * THE PULSE RESOLVES BEFORE IT LEAVES.
     *
     * The mark used to breathe for the length of the request and then be
     * deleted in the same task the request resolved in — the pulse stopped
     * mid-breath, at whatever opacity it happened to be on, and the bar
     * vanished. For a gesture whose result is invisible until the page reloads,
     * that flash was the ONLY closure it had.
     *
     * So the pending class comes off, the mark holds still and settled for a
     * beat, and then it goes. Not a tick and not a colour change: the indicator
     * is a 2px line on somebody else's page, and the toast is already carrying
     * the words. All this says is "that finished" rather than "that stopped".
     *
     * Guarded on the indicator still being the one this insert armed, so a
     * second drag begun during the beat takes the mark over rather than having
     * it pulled out from under it.
     */
    setIndicatorPending(false)
    const settling = currentIndicator()
    setTimeout(() => {
      if (currentIndicator() === settling) showDropIndicator(null)
    }, SETTLE_MS())
  }
}
