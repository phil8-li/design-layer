/**
 * Figma's "Select matching layers", over a DOM.
 *
 * Figma matches instances of one main component, and otherwise layers of the
 * same kind with the same properties. Here an instance root matches every other
 * root of the same component, and any other element matches the elements with
 * its tag and its exact class list, order ignored. The class list stands in for
 * "same properties" because it is what the editor writes and what the author
 * wrote; computed styles would match two buttons that only look alike today.
 */

import { isLayerCandidate, isHidden, toSelectable, type Resolver } from "../core/resolve"
import { isLocked } from "../core/store"
import type { LayerElement } from "../core/types"

/** What two elements must share to match, or null for one that matches nothing. */
export function matchKey(resolver: Resolver, element: Element): string | null {
  const meta = resolver.meta(element)
  if (meta.isRoot && meta.info?.componentName) return `component:${meta.info.componentName}`
  const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).sort()
  return `tag:${element.tagName.toLowerCase()}|${classes.join(" ")}`
}

/**
 * Every selectable element on the page that matches one of `elements`, in
 * document order, with `elements` themselves first so the primary selection
 * stays primary. Hidden and locked layers are left out: the canvas cannot grab
 * them either, and a selection that includes them would act on things the
 * designer cannot see or has fenced off.
 */
export function matchingLayers(resolver: Resolver, elements: readonly LayerElement[]): LayerElement[] {
  const keys = new Set<string>()
  for (const element of elements) {
    const key = matchKey(resolver, element)
    if (key) keys.add(key)
  }
  const result: LayerElement[] = [...elements]
  if (!keys.size) return result
  const seen = new Set<Element>(elements)
  for (const candidate of Array.from(document.body.querySelectorAll("*"))) {
    if (seen.has(candidate)) continue
    if (!isLayerCandidate(candidate) || toSelectable(candidate) !== candidate) continue
    const key = matchKey(resolver, candidate)
    if (!key || !keys.has(key)) continue
    if (isLocked(candidate) || isHidden(candidate)) continue
    seen.add(candidate)
    result.push(candidate as LayerElement)
  }
  return result
}
