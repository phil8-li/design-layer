/**
 * Thumbnails for the Assets panel, cloned out of the page we are already
 * standing in.
 *
 * WHY A CLONE IS THE HONEST PREVIEW. Figma renders a real thumbnail of every
 * component because the picture is the index: a designer scanning a library
 * recognises the button they want long before they read its name. This editor
 * cannot render one the way Figma does — it does not own a renderer, it has no
 * build of the library, and it holds nothing of a component but a name, a
 * selector and a snippet of text. What it does have is unique to living inside
 * the app under edit: if the page is using the component, the component is ON
 * SCREEN, already built by the framework that owns it and already styled by the
 * stylesheet that ships with it. A clone of that node is therefore not an
 * approximation of the component, it IS the component, one paint behind. Every
 * alternative is a lie of some size — an icon standing in for a drawing, a
 * screenshot that goes stale, a re-render by a renderer that is not the app's.
 *
 * WHY ITS ABSENCE IS NORMAL AND NOT AN ERROR. A library documents everything it
 * ships; a page uses a handful of it. The common case for any given card is
 * that the current route has no instance of that component, and that says
 * nothing at all about the component, the library or the editor — a Banner is
 * not broken because you are looking at the settings screen. So a miss falls
 * back to a monogram plate and is never reported, never retried against the
 * server, and never logged. The one thing it must not do is look like a
 * failure, because a designer who reads an empty thumbnail as "this component
 * is broken" has been told something false by a panel that simply has not been
 * anywhere it could see one.
 *
 * WHAT THE CLONE IS NOT ALLOWED TO DO. It is a picture, so it may not be
 * interactive, may not be reachable by the keyboard, may not duplicate an `id`
 * into a document that already has one, and may not carry this editor's own
 * marks — a cloned `data-de-deleted` would make the layer tree describe a
 * thumbnail as a deleted element. All four are stripped on the way in.
 */

import { DELETED_ATTRIBUTE, el, isChrome } from "../core/dom"
import type { EditorContext } from "../core/context"
import type { LibraryComponent } from "./types"

/**
 * The ceiling on one walk of the document, and it is a real page's worth.
 *
 * Finding a React component's instance means asking the bridge what each
 * element IS, which reads a fibre per node — cheap individually, not free four
 * thousand times. The cap is what keeps a pathological page (a virtualised
 * table, a documentation site rendering every example at once) from turning the
 * first paint of the Assets tab into a stall. A page bigger than this loses
 * previews for whatever is past the cap, which is the correct thing to lose.
 */
const MAX_SCAN = 4000

/**
 * One clone per component, kept for the life of the session.
 *
 * The expensive half of a preview is finding the instance, not copying it, so
 * the cache is consulted before any walk and a hit costs one `cloneNode`. What
 * is cached is the SOURCE clone rather than a mounted node: a node can only be
 * in one place at a time, and the same component appears in a group row, in a
 * card and in the details popover at three different sizes.
 */
const clones = new Map<string, HTMLElement>()

/**
 * The component-name index, and the cheap test that says when to rebuild it.
 *
 * Rebuilt when the number of elements in the page changes, which is what a hot
 * reload, a route change or an expanded list all do — and is one
 * `querySelectorAll` to check, against a bridge call per node to rebuild. A
 * page that changes its content without changing its node count keeps a stale
 * index, and the cost of that is a preview of the component that used to be
 * there, which is a picture of the right component in the wrong state.
 */
let nameIndex: Map<string, Element> | null = null
let indexedCount = -1

/**
 * The elements a preview may be taken from: the app's, not ours, not gone.
 *
 * Chrome is excluded because this panel is full of clones and a clone of a
 * clone is a thumbnail of a thumbnail. A deleted element is excluded because
 * the editor draws a delete as `display: none` plus a mark (see
 * `DELETED_ATTRIBUTE`), so it is still in the DOM and would preview as nothing.
 */
function candidates(): HTMLElement[] {
  const all = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
  const usable: HTMLElement[] = []
  for (const node of all) {
    if (usable.length >= MAX_SCAN) break
    if (isChrome(node) || node.hasAttribute(DELETED_ATTRIBUTE)) continue
    usable.push(node)
  }
  return usable
}

/** Zero-sized in a real browser means hidden; in jsdom it means unlaid-out. */
function painted(node: Element): boolean {
  const rect = node.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/**
 * Component name -> the best instance of it on the page.
 *
 * "Best" is the first one with a painted box, falling back to the first one at
 * all: a component rendered inside a collapsed accordion is a legitimate
 * instance and a better preview than nothing, but a visible sibling is a better
 * preview than it.
 */
function liveIndex(editor: EditorContext): Map<string, Element> {
  const nodes = candidates()
  if (nameIndex && indexedCount === nodes.length) return nameIndex

  const index = new Map<string, Element>()
  for (const node of nodes) {
    const name = editor.bridge.elementInfo(node)?.componentName?.trim().toLowerCase()
    if (!name) continue
    const known = index.get(name)
    if (!known) index.set(name, node)
    else if (!painted(known) && painted(node)) index.set(name, node)
  }
  nameIndex = index
  indexedCount = nodes.length
  return index
}

/**
 * The tags an Angular component answers to, which is the strong join.
 *
 * Same shape as `selectorsOf` in `store.ts` and for the same reason: a selector
 * is a comma-separated list, and only the element-name part of each entry is
 * something `querySelectorAll` can be trusted with — an attribute selector
 * (`[appButton]`) or a class one would match nodes that merely USE the
 * directive rather than nodes that are the component.
 */
function selectorTags(component: LibraryComponent): string[] {
  return (component.selector ?? "")
    .split(",")
    .map((part) => /^\s*([a-z][\w-]*)\s*$/i.exec(part)?.[1] ?? "")
    .filter(Boolean)
}

/** The live node this component is rendered as, or null — normally null. */
function findInstance(editor: EditorContext, component: LibraryComponent): Element | null {
  let fallback: Element | null = null
  for (const tag of selectorTags(component)) {
    for (const node of Array.from(document.querySelectorAll(tag))) {
      if (isChrome(node) || node.hasAttribute(DELETED_ATTRIBUTE)) continue
      if (painted(node)) return node
      fallback ??= node
    }
  }
  if (fallback) return fallback

  // Only now is the index worth building. An Angular library answers on its
  // selectors and never reaches this, and a page with no React components in it
  // pays one walk rather than one per card.
  const named = liveIndex(editor).get(component.name.trim().toLowerCase())
  return named ?? null
}

/**
 * The clone, stripped of everything that would make it more than a picture.
 *
 * `id` goes because duplicating one breaks `getElementById` and every `for`/
 * `aria-labelledby` pointing at the original. `data-de-*` goes because those
 * are this editor's own marks and a second element wearing them is a second
 * answer to "which element is this". Focusability goes because a thumbnail in
 * a list of twelve would otherwise contribute twelve tab stops of somebody
 * else's form.
 */
function sanitize(root: HTMLElement): void {
  for (const node of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
    node.removeAttribute("id")
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.name.startsWith("data-de-")) node.removeAttribute(attribute.name)
    }
    node.setAttribute("tabindex", "-1")
  }
  root.setAttribute("aria-hidden", "true")
  // `inert` as an attribute rather than the property: the property is newer
  // than some of the browsers this chrome runs in, and the attribute is what
  // both of them read.
  root.setAttribute("inert", "")
}

/** The cached source clone for a component, built on first sight. */
function cloneFor(editor: EditorContext, component: LibraryComponent): HTMLElement | null {
  const cached = clones.get(component.id)
  if (cached) return cached

  const instance = findInstance(editor, component)
  if (!(instance instanceof HTMLElement)) return null

  const clone = instance.cloneNode(true) as HTMLElement
  sanitize(clone)
  // The measured size travels with the clone, because the clone is about to be
  // taken out of the layout that gave it one. A flex child pulled out of its
  // row has no width of its own, and a preview of a button that has collapsed
  // to its text is a preview of a different button.
  const rect = instance.getBoundingClientRect()
  clone.dataset.width = String(Math.max(0, Math.round(rect.width)))
  clone.dataset.height = String(Math.max(0, Math.round(rect.height)))
  clones.set(component.id, clone)
  return clone
}

/** Up to two letters standing in for a name: "Action Bar" and "Avatar" both work. */
function initials(name: string): string {
  const words = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  const word = words[0] ?? "?"
  return word.slice(0, 2).toUpperCase()
}

function monogram(name: string): HTMLElement {
  return el("div", { class: "de-asset-monogram", "aria-hidden": "true" }, [initials(name)])
}

/**
 * The clone at its measured size, wrapped in a box scaled to fit `box`.
 *
 * The scale is `min(fit, 1)` rather than `fit`: a 16px chip blown up to fill a
 * 76px square is a picture of a blurry chip, and a library's smallest
 * components would come out looking like its largest. Down is a faithful
 * reduction, up is a claim about resolution the source does not have.
 *
 * The transform goes on the WRAPPER rather than on the clone, and the pairing
 * with `css/assets.ts` is the reason: the wrapper is pinned to the centre of
 * the thumbnail and shrink-wraps the clone, so `translate(-50%, -50%)` resolves
 * against the clone's own size and lands its centre on the box's centre for any
 * box, square or not. Scaling the clone directly would leave the wrapper at the
 * unscaled size and the picture off to one side. `box` is therefore the SHORTER
 * side of the thumbnail rather than its width — fit to the tight axis, centre
 * on the loose one.
 */
function fitted(clone: HTMLElement, box: number): HTMLElement {
  const width = Number(clone.dataset.width) || 0
  const height = Number(clone.dataset.height) || 0
  const scale = width > 0 && height > 0 ? Math.min(box / width, box / height, 1) : 1
  if (width > 0) clone.style.width = `${width}px`
  if (height > 0) clone.style.height = `${height}px`
  const wrapper = el("div", { class: "de-asset-clone", "aria-hidden": "true" }, [clone])
  wrapper.style.transform = `translate(-50%, -50%) scale(${scale})`
  return wrapper
}

/**
 * What goes inside a thumbnail box of side `box`: a scaled live clone, or a
 * monogram plate when the page holds no instance.
 *
 * Always returns a node. There is no error path and no empty state — see the
 * header on why a miss is a normal answer rather than a failure.
 */
export function componentPreview(
  editor: EditorContext,
  component: LibraryComponent,
  box: number
): HTMLElement {
  const source = cloneFor(editor, component)
  if (!source) return monogram(component.name)
  return fitted(source.cloneNode(true) as HTMLElement, box)
}
