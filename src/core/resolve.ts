/**
 * The one definition of "a layer", shared by the canvas and the layers panel.
 *
 * Figma's selection model is a rule over (hit, scope, modifiers), and it only
 * holds together while every surface asks the same question. The moment the
 * canvas and the tree each decide for themselves what a click means, the hover
 * outline starts lying about what a click will do.
 *
 * The DOM is the authored hierarchy for a live web page. React component
 * boundaries enrich rows with source names and drag metadata, but they do not
 * form a second tree: click, keyboard navigation, marquee, the overlap menu and
 * Layers all walk the same filtered HTML graph.
 */

import { DELETED_ATTRIBUTE, isCanvasElement } from "./dom"
import { iconNameOf } from "./icon-set"
import type { LayerElement } from "./types"
import type { RewriteElementInfo } from "./bridge"

/** Only the vendor member the resolver needs, so a stub can stand in for tests. */
export interface LayerBridge {
  elementInfo(el: Element): RewriteElementInfo | null
}

export interface LayerMeta {
  info: RewriteElementInfo | null
  /** Component name at an instance root; a label, its text, or the tag below one. */
  name: string
  /** True at the outermost DOM node of a React component instance. */
  isRoot: boolean
}

const NAME_MAX = 28
const NON_VISUAL = /^(SCRIPT|STYLE|LINK|META|TEMPLATE)$/

/**
 * Chrome is excluded by `isCanvasElement`; non-visual document nodes and
 * deleted ones are excluded here.
 *
 * A deleted element is still in the DOM — `DELETED_ATTRIBUTE` in `core/dom`
 * says why taking it out breaks the framework that rendered it — so "is this
 * gone" has to be answered somewhere, and this is the one place every surface
 * asks. The layers tree, hit-testing, the marquee and the stack menu all run
 * through here, which is what stops a deleted layer from vanishing in one of
 * them and lingering in the other three.
 */
export function isLayerCandidate(node: Node | null): node is Element {
  if (!isCanvasElement(node)) return false
  if (node.hasAttribute(DELETED_ATTRIBUTE)) return false
  return !NON_VISUAL.test(node.tagName)
}

/**
 * Hidden layers are excluded from hit-testing *and* from the stack menu, which
 * is what separates them from locked ones. Zero area covers `display:none`
 * without paying a `getComputedStyle` per candidate per gesture.
 *
 * `aria-hidden` is deliberately NOT part of this test. It says "do not announce
 * this", not "do not paint this", and a decorative glyph is the canonical thing
 * that is correctly both: every one of this app's 70 live icons carries
 * `aria-hidden="true"`, and reading that as hidden dropped all of them out of
 * the stack menu while the layers tree — which does not consult this — went on
 * listing them. Two surfaces, one question, two answers.
 */
export function isHidden(element: Element): boolean {
  if (element.hasAttribute("hidden")) return true
  const rect = element.getBoundingClientRect()
  return rect.width <= 0 || rect.height <= 0
}

/**
 * An `<svg>` is a layer; the geometry inside it is not.
 *
 * A `<path>` has no independent identity in the authored source — it is one
 * clause of the icon's shape — so a click on it resolves UP to the `<svg>`,
 * which is the node the JSX actually names. Everything else climbs to its
 * nearest HTML host as before.
 *
 * This used to stop at the HTML host in every case, which meant an icon could
 * not be selected at all: clicking one landed on whatever `<span>` or `<button>`
 * happened to wrap it, and the inspector described the wrapper. Hover, click,
 * marquee and the stack menu all pass through here, so widening it here is what
 * makes the preview outline and the click agree on an icon.
 */
export function toSelectable(element: Element | null): LayerElement | null {
  let svg: SVGSVGElement | null = null
  for (let node: Element | null = element; node; node = node.parentElement) {
    // Innermost wins: a nested `<svg>` is the layer, not the sheet holding it.
    if (!svg && node instanceof SVGSVGElement && isCanvasElement(node)) svg = node
    if (node instanceof HTMLElement && isCanvasElement(node)) return svg ?? node
  }
  return svg
}

export interface Resolver {
  bridge: LayerBridge
  meta(element: Element): LayerMeta
  isLayerRoot(element: Element): boolean
  /** Outermost container. Clicking here, or Escape, returns the scope to it. */
  scopeRoot(): Element
  /** Candidate DOM children, in document order. */
  children(element: Element): Element[]
  /** The direct selectable children in the one shared layer graph. */
  layerChildren(container: Element): LayerElement[]
  layerParent(element: Element): LayerElement | null
  layerSiblings(element: Element): LayerElement[]
  /** The Figma rule: highest layer under `hit` that lives inside `scope`. */
  resolve(hit: Element, scope: Element | null, deep?: boolean): LayerElement | null
  /** Selectable layers under the point, deduped in Layers-panel order. */
  hitStack(x: number, y: number): LayerElement[]
}

/**
 * Comparing the whole enclosing-component chain, not just the innermost name,
 * is what keeps a component that renders a same-named child from reading as one
 * layer. The line numbers ride along so two call sites of one component are two
 * layers even when the names match.
 */
function ownerPath(info: RewriteElementInfo | null): string {
  if (!info) return ""
  if (!info.stack.length) return info.componentName
  return info.stack.map((frame) => `${frame.componentName}@${frame.lineNumber}`).join(">")
}

function createResolver(bridge: LayerBridge): Resolver {
  /*
   * Only the fiber answers are memoized. They cost a walk through the bridge
   * and cannot change for the life of a node; the name's text part can — a
   * counter, a live label — and a cached name kept the first text it saw in
   * the stack menu for as long as the node lived. Re-reading it is an
   * attribute and, on a leaf, a short `textContent`.
   */
  const fiberCache = new WeakMap<Element, Pick<LayerMeta, "info" | "isRoot">>()

  const fiber = (element: Element): Pick<LayerMeta, "info" | "isRoot"> => {
    const cached = fiberCache.get(element)
    if (cached) return cached
    const info = bridge.elementInfo(element)
    const parent = element.parentElement
    const outer = parent && isLayerCandidate(parent) ? fiber(parent).info : null
    const isRoot = Boolean(info?.componentName && ownerPath(info) !== ownerPath(outer))
    const value = { info, isRoot }
    fiberCache.set(element, value)
    return value
  }

  const meta = (element: Element): LayerMeta => {
    const { info, isRoot } = fiber(element)
    const label = element.getAttribute("aria-label")?.trim()
    const text = element.children.length ? "" : element.textContent?.trim().slice(0, NAME_MAX)
    // An icon names itself, and that name beats every other candidate: the row
    // for a glyph should read "Compass", not "svg" and not the name of whatever
    // component happened to render it.
    const icon = iconNameOf(element)
    const name =
      icon || (isRoot && info ? info.componentName : label || text || element.tagName.toLowerCase())
    return { info, name, isRoot }
  }

  const isLayerRoot = (element: Element) => fiber(element).isRoot

  const scopeRoot = () => document.body

  const children = (element: Element): Element[] =>
    Array.from(element.children).filter((child): child is Element => isLayerCandidate(child))

  const layerParent = (element: Element): LayerElement | null => {
    let node = element.parentElement
    while (node) {
      const parent = node.parentElement
      if (isLayerCandidate(node)) return node
      node = parent
    }
    return null
  }

  // Every row here is a node a click can land on, because both go through
  // `toSelectable`: the tree lists an `<svg>` icon exactly when clicking one
  // selects it, and never lists the geometry inside it.
  //
  // A child that resolves to something OTHER than itself resolves upward — that
  // is what `<rect>` inside an icon does — so it is not a layer of its own. The
  // identity test is what keeps that case out: mapping instead of filtering made
  // `layerChildren(svg)` answer `[svg]`, and the tree walk recursed until the
  // stack blew.
  const layerChildren = (container: Element): LayerElement[] =>
    children(container).filter((child): child is LayerElement => toSelectable(child) === child)

  const layerSiblings = (element: Element): LayerElement[] => {
    const siblings = layerChildren(layerParent(element) ?? scopeRoot())
    return siblings.includes(element as LayerElement) ? siblings : []
  }

  /**
   * The outermost ancestor that still occupies the same pixels as the hit.
   *
   * This is the web's answer to "which thing did I just click", and it is a
   * question about the RENDERING rather than the markup. A `<button>` wrapping
   * a `<span>` wrapping the word "Set up" is three nodes drawing one object,
   * and a designer who clicks the word means the button. The card around it is
   * a different object, and they mean that only when they click the card.
   *
   * So: climb while the parent adds no visual extent, stop the moment it does.
   * That is the same judgement a person makes by eye, which is why it needs no
   * heuristic about tag names, class names or component boundaries — all three
   * of which vary per project and none of which say what was drawn where.
   *
   * `SLOP` absorbs sub-pixel layout: a flex parent is routinely a few
   * hundredths taller than its only child, and an exact comparison would stop
   * the climb at the first such wrapper and hand back the `<span>` again.
   *
   * Cmd-click never reaches here \u2014 `deep` returns the leaf before this runs \u2014
   * which is exactly the Figma pairing the user asked for: plain click for the
   * object, modifier to pinpoint inside it.
   */
  const visualLayer = (target: LayerElement, limit: Element): LayerElement => {
    const SLOP = 1
    const area = (rect: DOMRect) => rect.width * rect.height
    let node: LayerElement = target
    let box = node.getBoundingClientRect()
    // A zero-area hit has no extent to compare against, so the climb would
    // swallow every ancestor up to the app root. The node itself is the answer.
    if (area(box) <= 0) return node

    for (;;) {
      const parent = layerParent(node)
      if (!parent || parent === limit || !limit.contains(parent)) return node
      /*
       * Never climb out of the component instance that was clicked.
       *
       * A ceiling, not a stop. The first attempt stopped the moment `node`
       * reported itself a layer root, which reads correctly and is wrong on a
       * host that answers the question differently: on the Angular app under
       * test the label `<span>` claims to be a `ButtonComponent` root, so the
       * climb ended on the span and the modifier made no difference at all —
       * the exact complaint this whole change exists to fix.
       *
       * Comparing the instance PATH either side of the step is framework
       * neutral. It says "the parent belongs to something else, so the thing I
       * clicked ends here", which is true whoever answered. And where the host
       * resolves no components at all — every path the empty string — it
       * quietly costs nothing and the geometry below governs alone.
       */
      if (ownerPath(fiber(parent).info) !== ownerPath(fiber(node).info)) return node
      const next = parent.getBoundingClientRect()
      const coincident =
        Math.abs(next.left - box.left) <= SLOP &&
        Math.abs(next.top - box.top) <= SLOP &&
        Math.abs(next.right - box.right) <= SLOP &&
        Math.abs(next.bottom - box.bottom) <= SLOP
      /*
       * A parent with one child is plumbing, not a grouping decision.
       *
       * Coincidence alone was not enough, and a button is why: `<button>` wraps
       * its label `<span>` with padding, so the two are never coincident, and a
       * plain click on "Set up" selected the span — the one node a designer
       * never means. Nobody drew a span; they drew a button with a word in it.
       *
       * Sole-childhood is the signal that the wrapper is structural. It is
       * bounded by the same containment test as the coincidence climb, so it
       * still cannot escape the scope, and by the area cap below so a chain of
       * single-child wrappers cannot walk from a word to the whole page.
       */
      const onlyChild = layerChildren(parent).length === 1
      // Four times the ink is not the same object any more. This is the one
      // arbitrary number here, and it earns its place by stopping the
      // sole-child climb at the point where a wrapper stops being a wrapper —
      // a button around a word passes it, a page section around a card does not.
      const modest = area(next) <= area(box) * 4
      if (!coincident && !(onlyChild && modest)) return node
      node = parent
      box = next
    }
  }

  const resolve = (hit: Element, scope: Element | null, deep = false): LayerElement | null => {
    if (!isLayerCandidate(hit)) return null
    const target = toSelectable(hit)
    if (!target) return null
    if (deep) return target

    // A click outside the scope leaves it: the alternative is a click that
    // selects nothing, with no visible reason why.
    // `scope` is whatever the last drill landed on, and that can now be an
    // `<svg>`. Testing it for `HTMLElement` here sent every click inside a
    // drilled icon back to the scope root, which read as the whole page
    // selecting itself: containment is the question, not which DOM class.
    const inScope = Boolean(scope && scope.isConnected && scope.contains(target))
    const container = inScope && scope ? scope : scopeRoot()
    if (container === target) return target

    // Nothing drilled into: answer with the thing that was VISUALLY clicked.
    //
    // Figma's "direct child of the scope" rule is right inside a frame and
    // useless at the top of a web page, because the two hierarchies are not the
    // same shape. A Figma page's children are frames; a document's child is the
    // one element wrapping the entire app — `app-root` here, `#__next` in Next.
    // So the rule that selects a frame on a Figma canvas selected the whole
    // product on this one: every plain click, anywhere, reported `app-root`,
    // and the only way to reach a button was to hold a modifier for it.
    //
    // See `visualLayer` for what replaces it while the scope is the root. Once
    // the user HAS drilled in, the original rule takes over again unchanged —
    // inside a scope the Figma rule is the correct one, and it is what makes
    // Enter, Tab and the layers tree agree about what a click can reach.
    if (container === scopeRoot()) return visualLayer(target, container)

    // Climb the shared graph until `node` is a direct child of the active
    // scope. This is the exact node Enter/Tab/Layers can reach later.
    let node: LayerElement | null = target
    while (node) {
      const parent = layerParent(node)
      if (parent === container || (!parent && node.parentElement === container)) return node
      node = parent
    }
    return null
  }

  const hitStack = (x: number, y: number): LayerElement[] => {
    const seen = new Set<LayerElement>()
    const stack: LayerElement[] = []
    for (const raw of document.elementsFromPoint(x, y)) {
      if (!isLayerCandidate(raw) || isHidden(raw)) continue
      const node = toSelectable(raw)
      if (!node || seen.has(node) || isHidden(node)) continue
      seen.add(node)
      stack.push(node)
    }
    // The Select layer menu follows Layers order. Within a nested stack that
    // means parent before child; disjoint overlaps retain document order too.
    stack.sort((a, b) => {
      const relation = a.compareDocumentPosition(b)
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1
      return 0
    })
    return stack
  }

  return {
    bridge,
    meta,
    isLayerRoot,
    scopeRoot,
    children,
    layerChildren,
    layerParent,
    layerSiblings,
    resolve,
    hitStack,
  }
}

let active: Resolver | null = null

/**
 * One resolver per bridge. The canvas and the layers panel must share the memo
 * as well as the definition: a second cache re-walks the fiber tree for every
 * node the other one already resolved.
 */
export function getResolver(bridge: LayerBridge): Resolver {
  if (!active || active.bridge !== bridge) active = createResolver(bridge)
  return active
}
