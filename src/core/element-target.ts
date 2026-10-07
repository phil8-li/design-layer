/**
 * How the browser describes an element to a server that has to find it in a
 * source file.
 *
 * This started inside `core/angular.ts`, where it was the Angular lane's wire
 * shape. It is here because it turned out not to be about Angular at all: the
 * question "which written element produced this DOM node" has the same answer
 * shape in a template and in JSX, and the first thing that needed it on both
 * hosts — deleting an element — would otherwise have had to invent a second
 * descriptor that said the same thing in different words.
 *
 * Deliberately all STATIC facts. Every framework adds classes and attributes at
 * runtime that appear in no source file, so a server matches what it reads as a
 * SUBSET of what is sent — which only works if what is sent is the live truth
 * rather than a guess at what the author wrote.
 */

/** Enough of an element's identity for a server to find the one node that wrote it. */
export interface ElementTarget {
  tagName: string
  classes: string[]
  id: string | null
  nthOfType: number
  parentTagName: string | null
  parentClasses: string[]
  attributes: Record<string, string>
}

/** Index among preceding siblings of the same tag — matches a source-side scan. */
export function nthOfType(element: Element): number {
  let index = 0
  let sibling = element.previousElementSibling
  while (sibling) {
    if (sibling.tagName === element.tagName) index += 1
    sibling = sibling.previousElementSibling
  }
  return index
}

/**
 * Static attributes worth sending, which is to say: the ones that could have
 * been written by hand.
 *
 * `class`, `style` and `id` travel as their own fields. Angular's `_nghost-*` /
 * `_ngcontent-*` markers and `ng-reflect-*`, and this editor's own `data-de-*`,
 * are stamped at runtime and appear in no source file, so matching on them
 * would score every candidate identically — worse than not matching at all,
 * because it turns a clean miss into a tie.
 */
function staticAttributes(element: Element): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name
    if (name === "class" || name === "style" || name === "id") continue
    if (name.startsWith("_ng") || name.startsWith("ng-reflect-")) continue
    if (name.startsWith("data-de-")) continue
    if (attribute.value.length > 120) continue
    attributes[name] = attribute.value
  }
  return attributes
}

export function describeTarget(element: Element): ElementTarget {
  const parent = element.parentElement
  return {
    tagName: element.tagName.toLowerCase(),
    classes: Array.from(element.classList),
    id: element.getAttribute("id"),
    nthOfType: nthOfType(element),
    parentTagName: parent ? parent.tagName.toLowerCase() : null,
    parentClasses: parent ? Array.from(parent.classList) : [],
    attributes: staticAttributes(element),
  }
}
