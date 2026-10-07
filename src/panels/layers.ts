/**
 * Layers panel: the shared layer graph projected as a Figma-style tree. React
 * component boundaries still supply source-aware names and drag metadata, but
 * never replace the hierarchy used by canvas selection.
 *
 * Two rules keep it cheap on an app that renders 28 areas / 137 projects: a
 * branch is walked only while expanded, and rows are diffed in place.
 */

import { toSourceRef } from "../core/bridge"
import { LAYER_INDENT } from "../core/css/layers"
import { el } from "../core/dom"
import { focusControl } from "../core/focus"
import { icon, type IconName } from "../core/icons"
import { isDeepSelect } from "../core/keymap"
import { getResolver } from "../core/resolve"
import { scrollerFor } from "../core/scroll"
import { elementKey } from "../core/store"
// The tree shows a count of saved styles per row — see `savedKeys`. This is the
// only thing the layers panel takes from the options subsystem, and it takes a
// reader rather than a verb: acting on a saved style is the right panel's job.
import { visibleOptions } from "../options/store"
import { createWriter } from "../core/writer"
import type { EditorContext } from "../core/context"
import type { LayerElement, Selection } from "../core/types"
import { tokens } from "../core/tokens"
import { plural } from "../core/format"

const INDENT = LAYER_INDENT, MAX_DEPTH = 40
/** Filtering is the only full-tree walk; bound it so typing can never lock up. */
const FILTER_BUDGET = 6000

/** Everything the vendor server needs to move a node among its JSX siblings. */
interface DragRef { filePath: string; fromLine: number; parentPath: string; parentLine: number }
interface Meta { name: string; promoted: boolean; drag: DragRef | null }
interface Row { element: LayerElement; parent: LayerElement | null; depth: number; meta: Meta
  open: boolean; hasChildren: boolean; posinset: number; setsize: number }

function setAttr(node: Element, name: string, value: string | null): void {
  if (value === null) node.removeAttribute(name)
  else if (node.getAttribute(name) !== value) node.setAttribute(name, value)
}

/**
 * The row's type mark, decided from what the DOM can actually tell apart.
 *
 * A component wins over whatever it happens to be rendered as, and is the only
 * one of the four that also takes a colour. Below it the test is deliberately
 * shallow — media, then a leaf that is nothing but words, then the box that
 * everything else is. Guessing harder (list, button, link) would put a dozen
 * near-identical outlines in one column, which is texture, not information.
 */
function glyphFor(element: LayerElement, promoted: boolean): IconName {
  if (promoted) return "Component"
  const tag = element.tagName.toLowerCase()
  if (tag === "img" || tag === "svg" || tag === "picture") return "Image"
  if (!element.firstElementChild && (element.textContent ?? "").trim()) return "Type"
  return "Square"
}

/**
 * A row's marks, drawn once each and cloned after that.
 *
 * A filter can bring 1,500 rows in at once and each new row carries five marks,
 * so building every `<svg>` from its path data was a measurable share of the
 * keystroke. A marker glyph is decorative and `currentColor` throughout, so a
 * deep clone is indistinguishable from a fresh draw.
 */
const glyphs = new Map<IconName, SVGSVGElement>()
function glyph(name: IconName): Node {
  let drawn = glyphs.get(name)
  if (!drawn) glyphs.set(name, (drawn = icon(name, tokens.icon.marker)))
  return drawn.cloneNode(true)
}

/** One row action, restated in place. The glyph is redrawn only when it flips. */
function setAction(button: HTMLElement, on: boolean, mark: IconName, label: string): void {
  if (button.dataset.glyph !== mark) {
    button.dataset.glyph = mark
    button.replaceChildren(glyph(mark))
  }
  setAttr(button, "aria-pressed", String(on))
  // The label names the OUTCOME, not the state: a button that says "Locked"
  // leaves a screen-reader user to guess what pressing it does.
  setAttr(button, "aria-label", label)
  setAttr(button, "title", label)
}

export function installLayersPanel(context: EditorContext): void {
  const resolver = getResolver(context.bridge)
  const writer = createWriter(context.bridge)
  /*
   * Children asked for during one render are asked for once.
   *
   * A filtered render walks the whole tree for matches and then walks the
   * revealed part again to lay out rows, and each `layerChildren` call runs two
   * chrome tests per child. The memo lives for one render only, because the
   * app can re-render between two of ours without telling us.
   */
  let kidsMemo: Map<Element, LayerElement[]> | null = null
  const childrenOf = (element: Element): LayerElement[] => {
    if (!kidsMemo) return resolver.layerChildren(element)
    let kids = kidsMemo.get(element)
    if (!kids) kidsMemo.set(element, (kids = resolver.layerChildren(element)))
    return kids
  }
  let rowTemplate: HTMLElement | undefined
  const search = el("input", {
    class: "de-layer-filter", type: "search", placeholder: "Filter layers",
    "aria-label": "Filter layers",
  }) as HTMLInputElement
  const tree = el("div", { class: "de-layers-tree", role: "tree", "aria-label": "Layers" })
  const indicator = el("div", { class: "de-layer-drop", "aria-hidden": "true", style: "display:none" })
  const header = el("div", { class: "de-section-header" }, ["Layers"])

  /**
   * The way out of a filter that matched nothing, offered where the miss is.
   *
   * The sentence used to name no control at all, which on the one screen where
   * the panel is empty left the reader to find the box they had just typed into
   * and delete what they typed. `type="search"` does draw a native clear glyph
   * in WebKit and Blink, but it is mouse-only and Firefox does not draw it, so
   * it cannot be the thing a sentence points at. Focus is pushed back onto the
   * filter afterwards because pressing this button is what removes it from the
   * document — a keyboard user who activated it would otherwise be left on the
   * body with the tree they just restored nowhere near them.
   */
  const clearFilter = el(
    "button",
    {
      class: "de-button",
      type: "button",
      onclick: () => {
        search.value = ""
        request()
        focusControl(search)
      },
    },
    ["Clear filter"]
  )

  /**
   * What the panel says when it has no rows, as a live region OUTSIDE the tree.
   *
   * Two things are wrong with appending a sentence into the tree on each paint,
   * which is what this used to do. A `role="tree"` may own treeitems and groups
   * and nothing else, so a bare div in there is a child a screen reader has no
   * rule for; and a node rebuilt on every render can never be a live region,
   * because every repaint would re-announce a sentence that has not changed.
   *
   * So it is a sibling, built once, and `role="status"` — the same announcement
   * the libraries sign-in problem line makes for the same reason. Typing into
   * the filter until nothing matches moves no focus and swaps no control; a
   * sighted user watches the rows go and a blind user gets silence unless the
   * sentence announces itself. Polite rather than assertive: it is the result of
   * the reader's own keystroke, not an interruption.
   */
  const emptyNote = el("div", { class: "de-empty", role: "status", hidden: true })
  /** The sentence currently announced, so an unchanged repaint stays silent. */
  let emptyShowing = ""

  tree.append(indicator)
  context.slots.left.append(
    header,
    /*
     * The filter's band, on the scale and symmetric, where it was a raw literal
     * with no top padding at all.
     *
     * "0 8px 8px" put the field flush against the tab strip's bottom hairline
     * while the Controls pane's filter — the other half of the same strip —
     * carried 8px of air on every side. Two panes of one tab strip inset
     * differently is the kind of thing nobody reports and everybody feels when
     * they switch between them.
     *
     * The inline side is `space["2xs"]` rather than `md`, so the field's edge lands
     * on the same 4px column the tree rows below it already indent from.
     */
    el(
      "div",
      { style: `padding:${tokens.space.sm}px ${tokens.space["2xs"]}px ${tokens.space.sm}px` },
      [search]
    ),
    tree,
    emptyNote
  )

  /**
   * User expand/collapse only. A filter reveals rows without touching it.
   *
   * Weak because every selection writes its ancestors in here, and a route
   * change unmounts them: a strong map would keep every page this session ever
   * visited alive, detached subtrees and all.
   */
  const overrides = new WeakMap<LayerElement, boolean>()
  const rowByElement = new Map<LayerElement, HTMLElement>()
  const rowInfo = new WeakMap<HTMLElement, Row>()
  const metaCache = new WeakMap<LayerElement, Meta>()
  /** What `display` to put back when the eye is un-hidden; see `toggleVisible`. */
  const restoreDisplay = new WeakMap<LayerElement, string>()
  let filter: { query: string; reveal: Set<LayerElement>; matched: Set<LayerElement> } | null = null
  let visible: Row[] = [], focused: LayerElement | null = null, anchor: LayerElement | null = null
  /**
   * Element key -> how many saved styles it has, rebuilt at the top of every
   * render and empty whenever nothing is saved anywhere.
   *
   * Keyed rather than a `Set` so the row can print the count; built once rather
   * than read per row so `buildRow` can skip `describe()` — a bridge call —
   * entirely in the common case. See the note at its use.
   */
  let savedKeys = new Map<string, number>()

  /**
   * The tree and the canvas must agree on what a layer is, so the instance-root
   * test and the display name come from `core/resolve`. Only the drag reference
   * is the panel's own: a row is reorderable where the engine gave it a JSX
   * line to move, and its host component a line to move it within.
   */
  function metaOf(element: LayerElement): Meta {
    const { info, name, isRoot } = resolver.meta(element)
    // The name is read fresh every time, the way the resolver reads it: its
    // text part is live (a counter, a label), and a cached copy kept the first
    // text the row ever showed. What is cached is only what the fiber decides,
    // which the resolver has already memoized and cannot change for the node.
    const cached = metaCache.get(element)
    if (cached) return cached.name === name ? cached : { ...cached, name }
    const host = info?.stack[1]
    const drag =
      isRoot && info?.filePath && info.lineNumber && host?.filePath && host.lineNumber
        ? { filePath: info.filePath, fromLine: info.lineNumber, parentPath: host.filePath, parentLine: host.lineNumber }
        : null
    const meta = { name, promoted: isRoot, drag }
    metaCache.set(element, meta)
    return meta
  }

  function filterFor(query: string) {
    const reveal = new Set<LayerElement>()
    const matched = new Set<LayerElement>()
    let budget = FILTER_BUDGET
    const visit = (element: LayerElement, depth: number): boolean => {
      if (budget-- <= 0 || depth > MAX_DEPTH) return false
      let hit = metaOf(element).name.toLowerCase().includes(query)
      if (hit) matched.add(element)
      for (const child of childrenOf(element)) if (visit(child, depth + 1)) hit = true
      if (hit) reveal.add(element)
      return hit
    }
    for (const root of childrenOf(document.body)) visit(root, 0)
    return { query, reveal, matched }
  }

  /** The rows that should be on screen. Collapsed branches are never walked. */
  function flatten(): Row[] {
    const query = search.value.trim().toLowerCase()
    const found = query ? (filter?.query === query ? filter : (filter = filterFor(query))) : null
    const rows: Row[] = []
    const walk = (element: LayerElement, parent: LayerElement | null, depth: number, posinset: number, setsize: number) => {
      const kids = childrenOf(element).filter((k) => !found || found.matched.has(element) || found.reveal.has(k))
      const open = overrides.get(element) ?? Boolean(found && kids.some((k) => found.reveal.has(k)))
      rows.push({ element, parent, depth, meta: metaOf(element), open, hasChildren: kids.length > 0, posinset, setsize })
      if (!open || depth >= MAX_DEPTH) return
      kids.forEach((kid, index) => walk(kid, element, depth + 1, index + 1, kids.length))
    }
    const roots = childrenOf(document.body).filter((root) => !found || found.reveal.has(root))
    roots.forEach((root, index) => walk(root, null, 0, index + 1, roots.length))
    return rows
  }

  function buildRow(row: Row, selected: Set<LayerElement>, focusTarget: LayerElement | null, isHidden: boolean) {
    let node = rowByElement.get(row.element)
    if (!node) {
      // Built once and cloned: a filter can bring in a thousand rows in one
      // keystroke, and a deep clone is several times cheaper than `el()` per node.
      const fresh = (rowTemplate ??= el("div", { class: "de-layer", role: "treeitem" }, [
        el("span", { class: "de-layer-twisty", "aria-hidden": "true" }),
        el("span", { class: "de-layer-icon", "aria-hidden": "true" }),
        el("span", { class: "de-layer-name" }),
        /*
         * How many saved styles this element has, if any.
         *
         * This restores the one capability the design-options split dropped.
         * The floating browser carried a "Saved variants" tab listing every
         * element in the app with a saved style — the only cross-element view
         * of them there has ever been — and it went with the window.
         *
         * It is better here than it was there. That tab could not act on a row
         * without `findElement()`, forty lines that re-derived a selection by
         * tag-scanning the document and failed outright for any element not on
         * the current screen. This tree already HAS the element, so pressing a
         * row selects it and its saved styles appear in the right panel, where
         * every verb that acts on them already lives.
         *
         * A count rather than a dot, because "this one has styles saved against
         * it" and "this one has four" are different facts and the second is the
         * one that makes a reader open it. Empty unless there is something to
         * say, so the overwhelmingly common row costs one empty span.
         */
        el("span", { class: "de-layer-saved" }),
        el("span", { class: "de-layer-actions" }, [
          el("button", { class: "de-layer-action", type: "button", "data-action": "lock" }),
          el("button", { class: "de-layer-action", type: "button", "data-action": "eye" }),
          el("button", { class: "de-layer-action de-layer-action--danger", type: "button",
            "data-action": "delete" }),
        ]),
      ])).cloneNode(true) as HTMLElement
      // open-pencil stops the press on the action itself rather than filtering
      // it out of the row handler. Same here, and on both events: pointerdown
      // is what would otherwise begin a row drag, click is what would select.
      const strip = fresh.lastElementChild as HTMLElement
      strip.addEventListener("pointerdown", (event) => event.stopPropagation())
      strip.addEventListener("click", (event) => {
        event.stopPropagation()
        const action = (event.target as Element).closest<HTMLElement>(".de-layer-action")
        const current = rowInfo.get(fresh)
        if (!action || !current) return
        if (action.dataset.action === "lock") toggleLock(current)
        else if (action.dataset.action === "delete") deleteRow(current)
        else toggleVisible(current)
      })
      node = fresh
      rowByElement.set(row.element, node)
    }
    rowInfo.set(node, row)
    const [twisty, typeMark, label, saved, strip] = Array.from(node.children) as HTMLElement[]
    const [lock, eye, remove] = Array.from(strip.children) as HTMLElement[]
    const openState = row.hasChildren ? String(row.open) : null
    // Rows are recycled across renders, so the twisty is toggled by presence
    // rather than rebuilt — a fresh <svg> per frame would churn the whole tree.
    if (row.hasChildren && twisty.childElementCount === 0) twisty.append(glyph("ChevronRight"))
    else if (!row.hasChildren && twisty.childElementCount > 0) twisty.replaceChildren()
    // Same reason the mark is remembered on the node: it can only change when
    // the element does, and redrawing it is another whole <svg>.
    const mark = glyphFor(row.element, row.meta.promoted)
    if (typeMark.dataset.glyph !== mark) {
      typeMark.dataset.glyph = mark
      typeMark.replaceChildren(glyph(mark))
    }
    /*
     * The name, and a way to read the half of it the panel cut off.
     *
     * A row is 240px wide less an indent that grows with depth, a twisty, a
     * type glyph and an action strip, so `.de-layer-name` ellipsises early and
     * does it on the TAIL — which for the names this tree prints is the
     * identifying part. `ProjectCardGrid`, `ProjectCardGridItem` and
     * `ProjectCardGridItemMedia` are one string at this width, and three levels
     * deep they are one string with room to spare. Truncation with no way to
     * the full value is the escalation this fixes; the app chooser's trigger is
     * the precedent.
     *
     * `title` rather than the chrome's `tip()`, and the loop forces the choice:
     * rows are RECYCLED across renders, so a `tip()` bound to a node would have
     * to be rebound every time that node is handed to a different element.
     * `tip` writes an attribute anyway and the tooltip reads `title` and
     * borrows it (`core/tooltip.ts`), so the plain attribute gets the same card
     * with nothing to keep in sync.
     *
     * Guarded like the text above it, because this runs once per visible row
     * per repaint and an attribute write that changes nothing still dirties
     * style.
     */
    if (label.textContent !== row.meta.name) label.textContent = row.meta.name
    if (label.title !== row.meta.name) label.title = row.meta.name
    /*
     * Read off the store rather than remembered, for the same reason the hidden
     * state below is: this changes from a surface that is not this tree —
     * saving a style happens in the right panel — so a row that cached it would
     * go stale the moment it did.
     *
     * `savedKeys` is built once per render and is EMPTY for any session that
     * has never saved a style, which is almost all of them. That is what keeps
     * this free: `describe()` costs a bridge call per row, and asking for one
     * on every row of every repaint to answer a question whose answer is
     * usually "none" would be the expensive way to draw nothing. When the set
     * is empty no row is described at all.
     */
    const savedCount = savedKeys.size === 0 ? 0 : savedKeys.get(describe(row.element).key) ?? 0
    const savedText = savedCount > 0 ? String(savedCount) : ""
    if (saved.textContent !== savedText) saved.textContent = savedText
    setAttr(
      saved,
      "aria-label",
      savedCount > 0
        ? `${plural(savedCount, "saved style")} on ${row.meta.name}`
        : null
    )
    setAttr(saved, "title", savedCount > 0 ? "Saved styles. Select this layer to use them." : null)
    // The stylesheet rotates the twisty off its own aria-expanded; the row
    // carries the state a screen reader actually reads.
    setAttr(twisty, "aria-expanded", openState)
    const isLocked = context.getState().locked.has(row.element)
    setAction(lock, isLocked, isLocked ? "Lock" : "LockOpen", `${isLocked ? "Unlock" : "Lock"} ${row.meta.name}`)
    setAction(eye, isHidden, isHidden ? "EyeOff" : "EyeOpen", `${isHidden ? "Show" : "Hide"} ${row.meta.name}`)
    // Not through `setAction`: that one writes `aria-pressed`, which would
    // announce delete as a toggle that is currently off.
    if (remove.dataset.glyph !== "Trash") {
      remove.dataset.glyph = "Trash"
      remove.replaceChildren(glyph("Trash"))
    }
    setAttr(remove, "aria-label", `Delete ${row.meta.name}`)
    setAttr(remove, "title", `Delete ${row.meta.name}`)
    // The drag state is restated here rather than left where `dragstart` put
    // it, because this line rewrites the whole attribute and a render can
    // happen mid-drag for reasons that have nothing to do with the drag — the
    // saved-style counts repaint the tree whenever the right panel writes one.
    // A lift held only on the node would come off under the next repaint and
    // never come back.
    setAttr(node, "class", `de-layer${row.meta.promoted ? " de-layer--component" : ""}` +
      `${isLocked ? " de-layer--locked" : ""}${isHidden ? " de-layer--hidden" : ""}` +
      `${drag?.element === row.element ? " de-layer--dragging" : ""}`)
    setAttr(node, "style", `padding-left:${8 + row.depth * INDENT}px;--de-indent:${row.depth * INDENT}px`)
    setAttr(node, "aria-expanded", openState)
    setAttr(node, "aria-selected", String(selected.has(row.element)))
    setAttr(node, "aria-level", String(row.depth + 1))
    setAttr(node, "aria-posinset", String(row.posinset))
    setAttr(node, "aria-setsize", String(row.setsize))
    setAttr(node, "tabindex", row.element === focusTarget ? "0" : "-1")
    node.draggable = Boolean(row.meta.drag)
    return node
  }

  function render(): void {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    behind = false
    kidsMemo = new Map()
    try {
      visible = flatten()
    } finally {
      kidsMemo = null
    }
    const state = context.getState()
    /*
     * One pass over the saved sets, not one lookup per row.
     *
     * Built from the store rather than from the rows because the store is the
     * smaller side by orders of magnitude: a tree is hundreds of rows and the
     * sets are however many elements somebody has actually saved a style on,
     * which is usually none. An empty map here is what lets `buildRow` skip its
     * bridge call entirely.
     */
    savedKeys = new Map()
    for (const [key, set] of Object.entries(state.optionSets)) {
      const count = visibleOptions(set).length
      if (count > 0) savedKeys.set(key, count)
    }
    paintRows(state)
  }

  /*
   * Only the rows near the view are in the document.
   *
   * A selection deep in a big page opens every ancestor and a filter can match a
   * thousand rows. Each row in the document cost a style read and a diff on
   * every paint, and — however little `content-visibility` let it draw — a
   * share of every frame the page painted afterwards: scrolling the app with an
   * outline up re-layerized the chrome, every row included, at 60fps. Rows are
   * a fixed height, so the slice is arithmetic: what the scroller shows plus a
   * margin either side, with the rest of the list held open by padding, so the
   * scrollbar and every offset read as they would with all of them present.
   *
   * A scroller with no height — JSDOM, a panel not yet laid out — gets every
   * row, which is the old behavior exactly.
   */
  const ROW = tokens.size.rowHeight
  const MARGIN_ROWS = 20
  let pane: HTMLElement | null = null
  /** Where row 0 sits in the scroller's content, from the last paint. */
  let origin = 0
  let sliceStart = 0, sliceEnd = 0

  /** The tree's scroller, found once the tree is in the document, and followed. */
  function scroller(): HTMLElement | null {
    if (pane || !tree.isConnected) return pane
    pane = scrollerFor(tree)
    pane?.addEventListener("scroll", followView, { passive: true })
    if (pane && typeof ResizeObserver !== "undefined") new ResizeObserver(followView).observe(pane)
    return pane
  }

  function paintRows(state = context.getState()): void {
    const total = visible.length
    // A list no longer than the margins is painted whole, without measuring:
    // reading the scroller forces a layout, which on a short tree — the one
    // every page boots with — buys nothing.
    const pane = total > MARGIN_ROWS * 2 ? scroller() : null
    const view = pane?.clientHeight ?? 0
    let start = 0, end = total, scrollTo: number | null = null
    if (pane && view > 0) {
      origin = tree.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop
      let top = pane.scrollTop
      const at = reveal ? visible.findIndex((row) => row.element === reveal) : -1
      if (at !== -1) {
        // `scrollIntoView({ block: "nearest" })`, worked out rather than asked:
        // the row may not be in the document until this paint puts it there.
        const rowTop = origin + at * ROW
        if (rowTop < top) top = rowTop
        else if (rowTop + ROW > top + view) top = rowTop + ROW - view
        if (top !== pane.scrollTop) scrollTo = top
      }
      start = Math.max(0, Math.floor((top - origin) / ROW) - MARGIN_ROWS)
      end = Math.min(total, Math.ceil((top - origin + view) / ROW) + MARGIN_ROWS)
    }
    sliceStart = start
    sliceEnd = end
    const rows = start === 0 && end === total ? visible : visible.slice(start, end)
    const selected = new Set(state.selection.map((entry) => entry.element))
    const focusTarget = rows.some((r) => r.element === focused) ? focused : rows[0]?.element ?? null
    // Hidden is read back off the cascade rather than remembered, so a row is
    // right about an element the app itself hid. Every row is read here, before
    // any row is written, so the reads cost one style flush between them rather
    // than one per row after the first write. Until the page's first frame the
    // inline answer stands in (see `settled`).
    const hidden = rows.map((row) =>
      settled
        ? getComputedStyle(row.element).display === "none"
        : (row.element as HTMLElement).hidden === true || (row.element as HTMLElement).style?.display === "none"
    )
    tree.style.paddingTop = start > 0 ? `${start * ROW}px` : ""
    tree.style.paddingBottom = end < total ? `${(total - end) * ROW + tokens.space.sm}px` : ""
    let cursor = indicator.nextSibling
    rows.forEach((row, index) => {
      const node = buildRow(row, selected, focusTarget, hidden[index])
      if (node === cursor) cursor = cursor.nextSibling
      else tree.insertBefore(node, cursor)
    })
    while (cursor) {
      const next: ChildNode | null = cursor.nextSibling
      const stale = rowInfo.get(cursor as HTMLElement)
      if (stale) rowByElement.delete(stale.element)
      tree.removeChild(cursor)
      cursor = next
    }
    paintEmpty()
    // Never smooth: selection can change faster than a smooth scroll settles.
    if (pane && scrollTo !== null) pane.scrollTop = scrollTo
    else if (reveal && !(pane && view > 0)) rowByElement.get(reveal)?.scrollIntoView({ block: "nearest" })
    reveal = null
  }

  /** Repaints the slice when the view has run past the rows painted for it. */
  let sliceFrame = 0
  function followView(): void {
    if (sliceFrame) return
    sliceFrame = requestAnimationFrame(() => {
      sliceFrame = 0
      const view = pane?.clientHeight ?? 0
      if (!pane || view === 0 || !showing()) return
      const first = Math.floor((pane.scrollTop - origin) / ROW)
      const last = Math.ceil((pane.scrollTop - origin + view) / ROW)
      if ((first < sliceStart && sliceStart > 0) || (last > sliceEnd && sliceEnd < visible.length)) paintRows()
    })
  }

  /*
   * When the tree repaints, and when it does not.
   *
   * A row click used to paint the whole tree three times (the selection write,
   * `activate`, the scope write) and a delete three more; every nudge painted
   * it once per auto-repeat; and all of it ran with the panel closed or on the
   * other tab. Three rules now:
   *
   * - Work done on the tree's own behalf runs inside `batch`, which owes one
   *   paint and pays it, synchronously, when the work is done — so `activate`
   *   can still move focus onto a row that exists.
   * - A refresh (a nudge, a drag end, an undo) paints on the next frame, once,
   *   however many arrive before it.
   * - Nothing paints while the tree cannot be seen. It is marked `behind` and
   *   painted the moment it is shown again.
   *
   * A store change that IS visible still paints synchronously, because the
   * canvas and the tests read the rows straight after selecting.
   */
  let batching = 0, owed = false, behind = false, frame = 0
  /** Whether the page has had its first frame since the tree was installed. */
  let settled = false
  /** The row to bring into view on the next paint; set by a selection change. */
  let reveal: LayerElement | null = null
  const showing = (state = context.getState()) =>
    state.layersOpen && state.leftTab === "layers" && !state.chromeHidden

  function request(): void {
    if (batching) owed = true
    else if (!showing()) behind = true
    else render()
  }

  function batch(work: () => void): void {
    batching += 1
    try {
      work()
    } finally {
      batching -= 1
      if (!batching && owed) {
        owed = false
        request()
      }
    }
  }

  /**
   * The two empty states, and neither of them is "wait".
   *
   * The no-filter branch used to read `Waiting for the app.`, which is a promise
   * the panel cannot keep: a route that renders nothing the layer resolver
   * accepts leaves that sentence on screen forever, and a left rail claiming to
   * be waiting is indistinguishable from a left rail that is broken. It is also
   * the panel's only chance to say what a layer IS, and it spent it on a verb.
   *
   * The filter branch names the query rather than "that filter", because the
   * reader has typed several by now, and hands over the control that undoes it.
   */
  function paintEmpty(): void {
    const query = search.value.trim()
    const sentence = visible.length
      ? ""
      : query
        ? `No layers match “${query}”. Try another name.`
        : "No layers yet. Use the page, or select an element on it."
    if (sentence === emptyShowing) return
    emptyShowing = sentence
    emptyNote.hidden = !sentence
    if (!sentence) emptyNote.replaceChildren()
    else if (query) emptyNote.replaceChildren(`${sentence} `, clearFilter)
    else emptyNote.replaceChildren(sentence)
  }

  /**
   * The row as a writable target. `context.describe` is private to the context
   * module, so this rebuilds the same shape from the two core helpers it uses —
   * the same thing `section-align` does to write to a selection's parent.
   */
  function describe(element: LayerElement): Selection {
    const info = context.bridge.elementInfo(element)
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
   * The eye is a real edit, so it goes through the writer every other panel
   * writes through: `display: none` previews now and lands as `hidden` at
   * "Apply to code", and Cmd+Z undoes it like any other change.
   *
   * Showing has to name a value — `applyStyles` sets, it cannot unset — so the
   * display the element had when it was hidden is kept for the trip back.
   * Without that a hidden flex row would come back as a block and quietly
   * restack its children. `block` is only the fallback for something this
   * session never hid itself.
   */
  function toggleVisible(row: Row): void {
    const shown = getComputedStyle(row.element).display
    const hidden = shown === "none"
    if (!hidden) restoreDisplay.set(row.element, shown)
    const value = hidden ? restoreDisplay.get(row.element) ?? "block" : "none"
    const summary = `${hidden ? "Show" : "Hide"} ${row.meta.name}`
    // Through `refresh`, not just this tree's own paint: the writer notifies no
    // panel, and the Design tab would go on showing the display it had before.
    batch(() => {
      writer.applyStyles(describe(row.element), [{ property: "display", value }], summary)
      context.refresh()
    })
  }

  /**
   * Delete from the tree, keeping the keyboard where it was.
   *
   * A row acts on the whole selection when it is part of it — pressing Delete
   * after shift-picking six rows deletes six, which is the only reading of that
   * gesture — and on itself alone otherwise, because the trash icon on a row
   * points at that row whatever else happens to be selected.
   *
   * Where focus lands is decided BEFORE the write. Afterwards the rows are gone
   * and `visible` has been rebuilt, so there is nothing left to compute it
   * from; a tree that drops focus to the body on Delete cannot be driven from
   * the keyboard at all.
   */
  function deleteRow(row: Row): void {
    const selection = context.getState().selection
    const inSelection = selection.some((entry) => entry.element === row.element)
    const targets = inSelection ? selection : [describe(row.element)]
    const gone = (element: LayerElement) =>
      targets.some((entry) => entry.element === element || entry.element.contains(element))

    const index = visible.indexOf(row)
    let next: LayerElement | null = null
    for (let at = index + 1; at < visible.length && !next; at += 1) {
      if (!gone(visible[at].element)) next = visible[at].element
    }
    for (let at = index - 1; at >= 0 && !next; at -= 1) {
      if (!gone(visible[at].element)) next = visible[at].element
    }

    // One paint for the deselect, the refresh and the focus move together.
    batch(() => {
      writer.applyDelete(targets)
      context.select(null)
      const scope = context.getState().scope
      if (scope && !scope.isConnected) context.setState({ scope: null })
      context.bridge.refreshGeometry()
      // Every other panel repaints from this.
      context.refresh()
      if (next) focused = next
    })
    if (next) focusControl(rowByElement.get(next))
  }

  /** A new Set per toggle: `setState` compares by identity. */
  function toggleLock(row: Row): void {
    const locked = new Set(context.getState().locked)
    if (!locked.delete(row.element)) locked.add(row.element)
    context.setState({ locked })
    request()
  }

  function rowAt(target: EventTarget | null): Row | null {
    const node = target instanceof Element ? target.closest(".de-layer") : null
    return node ? rowInfo.get(node as HTMLElement) ?? null : null
  }

  function toggle(row: Row, open: boolean): void {
    overrides.set(row.element, open)
    request()
  }

  /**
   * Roving focus, and optionally selection, moves to `element`.
   *
   * `write` is a selection change the caller makes first (a range, a toggle),
   * folded into the same single paint. Focus is set after it because the
   * selection subscription points focus at the FIRST selected row, and a range
   * keeps focus on the row that was pressed.
   */
  function activate(element: LayerElement | null, select: boolean, write?: () => void): void {
    if (!element) return
    batch(() => {
      write?.()
      if (select) {
        anchor = element
        // A row selects at its own depth, so the canvas scope follows it. Without
        // that, the next click on the canvas jumps straight back out to the top.
        context.selectMany([element])
        context.setState({ scope: resolver.layerParent(element) })
      }
      // Revealed as well as focused: with only the rows near the view in the
      // document, Home, End or a far ArrowUp must bring the row in before focus
      // can land on it — which is the scroll focusing it would have caused.
      focused = reveal = element
      owed = true
    })
    focusControl(rowByElement.get(element))
  }

  /**
   * The three ways a row can be clicked.
   *
   * The accelerator comes from `keymap.isDeepSelect`, so this lane and the
   * canvas cannot drift apart on the platform question. They spend it
   * differently on purpose: the canvas has no flattened row order, so Shift is
   * its additive toggle; the tree has one, so Shift is the range and the
   * accelerator is the toggle — which is also how open-pencil reads it.
   *
   * A range walks the FLATTENED visible rows from the last row a click or an
   * Enter landed on. That is the order the eye is dragging down, and the only
   * one in which "the rows between these two" has an answer when the two sit
   * under different parents.
   *
   * Only a plain click re-points the scope: a multi-row selection has no single
   * parent to scope to, and guessing one would silently change what the next
   * click on the canvas resolves to.
   */
  function selectRow(row: Row, event: MouseEvent): void {
    const to = visible.indexOf(row)
    const from = event.shiftKey ? visible.findIndex((r) => r.element === anchor) : -1
    if (from !== -1) {
      const span = visible.slice(Math.min(from, to), Math.max(from, to) + 1)
      activate(row.element, false, () => context.selectMany(span.map((r) => r.element)))
    } else if (isDeepSelect(event)) {
      activate(row.element, false, () => {
        anchor = row.element
        context.select(row.element, { additive: true })
      })
    } else activate(row.element, true)
  }

  // Drop lines come from the vendor's `getSiblings`, the only thing that knows
  // the real JSX sibling list. `reorder` always inserts *before* `toLine`, so
  // dropping below a row targets the next sibling instead.
  // The dragged ELEMENT is carried alongside the reference the server needs,
  // because the lift is drawn on the row and a row is found by its element.
  // Keeping it on `drag` rather than in a second variable is what makes "a drag
  // is running" and "this is the row it is running on" one fact: `buildRow`
  // restates the class off it, so the two cannot disagree across a repaint.
  let drag: { ref: DragRef; element: LayerElement; parent: LayerElement | null
    lines: Set<number>; to: number } | null = null
  let stopSiblings: (() => void) | null = null

  function endDrag(): void {
    stopSiblings?.()
    stopSiblings = null
    // Read before `drag` is dropped, and taken off the node directly: the row
    // may not be rebuilt after this — a drag abandoned outside the tree ends
    // here and nowhere else — so waiting for the next render would leave the
    // tree with a faded row and no drag.
    const lifted = drag && rowByElement.get(drag.element)
    drag = null
    lifted?.classList.remove("de-layer--dragging")
    indicator.style.display = "none"
  }

  function dropLine(event: DragEvent): number {
    const row = rowAt(event.target)
    const node = row && rowByElement.get(row.element)
    if (!drag || !row || !node || row.parent !== drag.parent) return 0
    const rect = node.getBoundingClientRect()
    const above = event.clientY <= rect.top + rect.height / 2
    const next = visible[visible.indexOf(row) + 1]
    const target = above ? row : next?.parent === row.parent ? next : null
    const line = target?.meta.drag?.fromLine ?? 0
    if (!line || line === drag.ref.fromLine || !drag.lines.has(line)) return 0
    /*
     * Drawn on the HOVERED row's own edge, not the target's top, so above and
     * below read as two gestures — `reorder` is handed one line either way.
     *
     * Moved with a transform rather than the `top` this used to write, which is
     * what lets the stylesheet follow it between gaps instead of teleporting
     * it. `top` is a layout property and this runs on every dragover; the note
     * on the rule in `css/layers.ts` has the rest of the reasoning.
     *
     * The horizontal inset stays a real offset because it never moves during a
     * drag: every candidate gap is a sibling of the dragged row, so every one
     * of them is at this depth.
     */
    indicator.style.transform = `translateY(${node.offsetTop + (above ? 0 : node.offsetHeight) - 1}px)`
    indicator.style.left = `${4 + row.depth * INDENT}px`
    return line
  }

  tree.addEventListener("click", (event) => {
    const row = rowAt(event.target)
    if (!row) return
    if (row.hasChildren && (event.target as Element).closest(".de-layer-twisty")) toggle(row, !row.open)
    else selectRow(row, event as MouseEvent)
  })
  tree.addEventListener("pointerover", (event) => {
    const row = rowAt(event.target)
    if (row) context.setState({ hovered: row.element })
  })
  tree.addEventListener("pointerleave", () => context.setState({ hovered: null }))

  tree.addEventListener("keydown", (event) => {
    const row = rowAt(event.target)
    if (!row) return
    const index = visible.indexOf(row)
    const step = (to: number) => activate(visible[to]?.element ?? null, false)
    const key = (event as KeyboardEvent).key
    /*
     * MULTI-SELECT FROM THE KEYBOARD, which did not exist.
     *
     * Every batch verb in this editor — align, distribute, delete, the multi
     * edit — is gated behind a selection of more than one row, and the only way
     * to assemble one was Shift-click or Cmd-click. So a keyboard user could
     * reach every one of those controls and operate none of them: a whole
     * capability behind a gesture with no key.
     *
     * The chords are the two the pointer already uses, which is the point —
     * Shift extends a range from the anchor, the platform's modifier toggles
     * one row into the set — so there is one model to learn rather than two.
     * `isDeepSelect` is the same helper the click path calls, so Cmd and Ctrl
     * stay whatever they are on this platform.
     *
     * Both branches mirror `selectRow` exactly, including the rule that only a
     * PLAIN move re-points the scope: a multi-row selection has no single
     * parent, and guessing one changes what the next canvas click resolves to.
     */
    const extend = (to: number) => {
      const target = visible[to]
      if (!target) return
      const from = visible.findIndex((r) => r.element === anchor)
      const span = visible.slice(Math.min(from === -1 ? to : from, to), Math.max(from === -1 ? to : from, to) + 1)
      activate(target.element, false, () => context.selectMany(span.map((r) => r.element)))
    }
    if ((key === "ArrowDown" || key === "ArrowUp") && (event as KeyboardEvent).shiftKey) {
      extend(index + (key === "ArrowDown" ? 1 : -1))
      event.preventDefault()
      return
    }
    if (key === "Enter" && isDeepSelect(event as unknown as MouseEvent)) {
      activate(row.element, false, () => {
        anchor = row.element
        context.select(row.element, { additive: true })
      })
      event.preventDefault()
      return
    }
    if (key === "ArrowDown") step(index + 1)
    else if (key === "ArrowUp") step(index - 1)
    else if (key === "Home") step(0)
    else if (key === "End") step(visible.length - 1)
    else if (key === "ArrowRight") {
      if (row.hasChildren && !row.open) toggle(row, true)
      else if (visible[index + 1]?.parent === row.element) step(index + 1)
    } else if (key === "ArrowLeft") {
      if (row.hasChildren && row.open) toggle(row, false)
      else activate(row.parent, false)
    } else if (key === "Enter" || key === " ") activate(row.element, true)
    else if (key === "Delete" || key === "Backspace") deleteRow(row)
    else return
    event.preventDefault()
  })

  tree.addEventListener("dragstart", (event) => {
    const row = rowAt(event.target)
    const ref = row?.meta.drag
    if (!row || !ref) return event.preventDefault()
    ;(event as DragEvent).dataTransfer?.setData("text/plain", row.meta.name)
    drag = { ref, element: row.element, parent: row.parent, lines: new Set(), to: 0 }
    /*
     * The lift goes on a frame late, and the delay is the point rather than a
     * hedge. The browser snapshots this row for the drag image once the handler
     * returns, so fading it here would fade the copy under the cursor too — and
     * that copy is the only full-strength reading of the name while the drag
     * runs, which is the whole argument the rule in `css/layers.ts` rests on.
     *
     * Re-checked inside the frame because a drag can be over before it: the
     * class is applied only if this row is still the one being carried, so an
     * abandoned drag cannot leave a faded row behind `endDrag`.
     */
    requestAnimationFrame(() => {
      if (drag?.element === row.element) rowByElement.get(row.element)?.classList.add("de-layer--dragging")
    })
    stopSiblings = context.bridge.subscribe((message) => {
      if (message.type !== "siblingsList") return
      stopSiblings?.()
      stopSiblings = null
      for (const s of (message.siblings ?? []) as Array<{ lineNumber: number }>) drag?.lines.add(s.lineNumber)
    })
    context.bridge.send({ type: "getSiblings", filePath: ref.parentPath, parentLine: ref.parentLine })
  })
  tree.addEventListener("dragover", (event) => {
    if (!drag) return
    drag.to = dropLine(event as DragEvent)
    indicator.style.display = drag.to ? "block" : "none"
    if (!drag.to) return
    event.preventDefault()
    const transfer = (event as DragEvent).dataTransfer
    if (transfer) transfer.dropEffect = "move"
  })
  tree.addEventListener("drop", (event) => {
    event.preventDefault()
    const pending = drag
    endDrag()
    if (!pending?.to) return
    // The vendor's own socket listener already toasts `reorderComplete` errors.
    const { filePath, fromLine } = pending.ref
    context.bridge.send({ type: "reorder", filePath, fromLine, toLine: pending.to })
  })
  tree.addEventListener("dragend", endDrag)
  search.addEventListener("input", request)

  context.subscribe((state, previous) => {
    /*
     * The saved-style counts are the second thing this tree reads out of the
     * store, and they change from a surface that is not this one: saving,
     * renaming or deleting a style all happen in the right panel. A repaint
     * gated on the selection alone left every badge showing the count from
     * whenever the selection last moved — right on the row you just saved
     * against, because saving selects it, and stale on every other row until
     * something unrelated happened to redraw the tree.
     *
     * Identity, not a deep compare: `optionSets` is replaced wholesale by the
     * store on every write, so this is one pointer test per state change and it
     * cannot miss one.
     */
    let changed = state.optionSets !== previous.optionSets
    /*
     * A selection whose elements did not change is not a selection change. The
     * owner-stack source landing after a click re-publishes the same elements,
     * and repainting a few thousand rows to say nothing new was half the cost
     * of every click.
     */
    if (
      state.selection !== previous.selection &&
      (state.selection.length !== previous.selection.length ||
        state.selection.some((entry, index) => entry.element !== previous.selection[index].element))
    ) {
      const element = state.selection[0]?.element ?? null
      for (let n = element && resolver.layerParent(element); n; n = resolver.layerParent(n)) {
        overrides.set(n, true)
      }
      if (element) focused = reveal = element
      changed = true
    }
    // Shown again after missing a paint: catch up, and bring the selected row
    // into view now that there is a view to bring it into.
    if (behind && showing(state) && !showing(previous)) changed = true
    if (changed) request()
  })

  context.onRefresh(() => {
    // `filter` memoises a DOM walk, so a refresh must drop it. `metaCache` is
    // keyed on the element itself and holds the fiber-resolved drag reference,
    // which a nudge or a drag cannot change; names are re-read per render.
    filter = null
    if (batching) owed = true
    else if (!frame) frame = requestAnimationFrame(() => {
      frame = 0
      request()
    })
  })

  request()
  /*
   * The tree first paints in the task that committed the app, before the page
   * has been styled even once, so a computed `display` there is a restyle of
   * the whole document — and the frame restyles it again after the rest of the
   * editor has mounted. Those first rows take the inline answer (`hidden`, or
   * an inline `display: none`, which is how this editor hides things) and are
   * repainted off the cascade after that frame, before the chrome is first
   * drawn (`shell.ts` keeps it out of that frame).
   */
  requestAnimationFrame(() => setTimeout(() => {
    settled = true
    request()
  }))
}
