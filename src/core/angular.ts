/**
 * The Angular half of "where is this element written, and how do I write to it".
 *
 * On a React host both answers come from the vendored engine: a fiber walk
 * names the file, and a jscodeshift codemod edits the JSX. Angular has neither,
 * so this module supplies the two pieces that are missing and nothing else —
 * every panel, the canvas, the history and the change ledger stay exactly as
 * they are, because they all talk to `resolveElementSource` and `Writer`
 * rather than to the engine.
 *
 * What Angular does give us is `ng`, the dev-mode global its own DevTools use.
 * `ng.getOwningComponent(el)` returns the component instance whose TEMPLATE
 * authored an element, which is precisely React's owner semantics — so the
 * browser can name the component, and the server turns that name into a file.
 *
 * The class name is sent raw. Bundlers rename classes (esbuild's usual result
 * is a `_` prefix) and only the server, holding the project's real source, can
 * say which name is the true one; guessing here would put a normalisation rule
 * in the one place that cannot check it.
 */

import { config } from "./config"
import { describeTarget, type ElementTarget } from "./element-target"
import type { LayerElement, SourceRef } from "./types"

/**
 * Re-exported because this lane's wire types are written in terms of it and
 * every Angular caller already imports from here. The descriptor itself is not
 * Angular's: `core/element-target` owns it, so the React lane can send the same
 * shape rather than a second one that means the same thing.
 */
export { describeTarget }
export type AngularTarget = ElementTarget

/** The subset of Angular's dev-mode global this module relies on. */
interface AngularGlobal {
  getOwningComponent?(element: unknown): object | null
  getComponent?(element: unknown): object | null
}

declare global {
  interface Window {
    ng?: AngularGlobal
  }
}

export type AngularOperation =
  | { op: "setStyles"; componentName: string; target: AngularTarget; declarations: Record<string, string> }
  | { op: "setClasses"; componentName: string; target: AngularTarget; add: string[]; remove: string[] }
  | { op: "setText"; componentName: string; target: AngularTarget; text: string }

export interface AngularApplyResult {
  applied: Array<{ op: string; filePath: string; lineNumber: number }>
  // The WHOLE operation, not just its op and component name. The server echoes
  // it back already; narrowing it here meant a refused write could be counted
  // and named in a toast but never described, so the only thing a caller could
  // do with a refusal was mention it and drop it. Everything needed to file it
  // as a change that still wants making — which element, and what was being set
  // on it — is in the operation.
  failed: Array<{ reason: string; operation: AngularOperation }>
}

export function isAngularHost(): boolean {
  return config.host.framework === "angular"
}

/**
 * The component whose template authored this element, or null.
 *
 * The walk upward exists because `getOwningComponent` answers for the element
 * itself and Angular returns null for a node it does not own — a projected
 * `<ng-content>` child, or an element inside a third-party web component's
 * shadow tree. Climbing finds the nearest ancestor Angular does own, which is
 * the component whose file an edit would have to land in.
 */
export function owningComponentName(element: Element | null): string | null {
  const ng = window.ng
  if (!ng?.getOwningComponent) return null
  for (let node: Element | null = element; node; node = node.parentElement) {
    let instance: object | null = null
    try {
      instance = ng.getOwningComponent(node)
    } catch {
      // Angular throws for a node outside any component tree.
      instance = null
    }
    const name = instance?.constructor?.name
    if (typeof name === "string" && name) return name
  }
  return null
}

/* -------------------------------------------------------------------------
 * Source resolution
 * ---------------------------------------------------------------------- */

const sourceByElement = new WeakMap<Element, Promise<SourceRef | null>>()

async function fetchSource(element: Element): Promise<SourceRef | null> {
  const componentName = owningComponentName(element)
  if (!componentName) return null
  const target = encodeURIComponent(JSON.stringify(describeTarget(element)))
  const url = `${config.apiBase}/angular/source?component=${encodeURIComponent(
    componentName
  )}&target=${target}`
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } })
    if (!response.ok) return null
    const body: { source?: SourceRef | null } = await response.json()
    return body.source?.filePath ? body.source : null
  } catch {
    return null
  }
}

/**
 * Where this element is written, resolved once and remembered.
 *
 * A `null` is not cached, for the same reason the React resolver does not cache
 * one: the first ask can land before Angular has finished bootstrapping, and a
 * permanently-remembered "no" would leave that element unwritable for as long
 * as it stays mounted.
 */
export function resolveAngularSource(element: Element): Promise<SourceRef | null> {
  const cached = sourceByElement.get(element)
  if (cached) return cached
  const pending = fetchSource(element).then((source) => {
    if (!source) sourceByElement.delete(element)
    return source
  })
  sourceByElement.set(element, pending)
  return pending
}

/* -------------------------------------------------------------------------
 * The pending queue
 * ---------------------------------------------------------------------- */

interface PendingEntry {
  element: LayerElement
  componentName: string
  declarations: Map<string, string>
  classAdd: Set<string>
  classRemove: Set<string>
  text: string | null
}

const pending = new Map<LayerElement, PendingEntry>()
const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

/** Fires whenever the queue's size or contents change, so the toolbar repaints. */
export function onAngularQueueChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function angularQueueSize(): number {
  return pending.size
}

export function clearAngularQueue(): void {
  if (!pending.size) return
  pending.clear()
  announce()
}

/**
 * Take one property back out, leaving the rest of the element's entry standing.
 *
 * The Changes tab lets a designer drop any single row, in any order, and a row
 * is one (element, property). This queue merges by ELEMENT, so dropping a row
 * cannot mean dropping the entry: an element with a colour change and a padding
 * change is one entry and two rows, and retracting the padding has to leave the
 * colour queued behind it.
 *
 * `property` speaks the vocabulary the journal and the ledger already use — CSS
 * property names plus the sentinels `class` and `text`. That is deliberate. A
 * row carries a property string and nothing else identifying, so keying a
 * withdrawal on anything richer would force the caller to know which of these
 * three maps its row landed in, which is precisely the knowledge this module
 * exists to keep to itself.
 *
 * The entry is deleted outright once nothing is left in it, so an element whose
 * every row was dropped stops counting toward `angularQueueSize()` and the bar
 * goes quiet. Returns whether anything was actually withdrawn, because a caller
 * has to be able to tell a real retraction from a no-op.
 */
export function unqueueAngularProperty(element: LayerElement, property: string): boolean {
  const entry = pending.get(element)
  if (!entry) return false

  let removed = false
  if (property === "class") {
    removed = entry.classAdd.size > 0 || entry.classRemove.size > 0
    entry.classAdd.clear()
    entry.classRemove.clear()
  } else if (property === "text") {
    removed = entry.text !== null
    entry.text = null
  } else {
    removed = entry.declarations.delete(property)
  }
  if (!removed) return false

  const empty =
    entry.declarations.size === 0 &&
    entry.classAdd.size === 0 &&
    entry.classRemove.size === 0 &&
    entry.text === null
  if (empty) pending.delete(element)
  announce()
  return true
}

/**
 * One entry per element, merged.
 *
 * The same merge rule the vendor store applies to its own pending operations,
 * and for the same reason: a slider dragged across twenty frames is one edit to
 * one property, not twenty operations racing each other into one file.
 */
function entryFor(element: LayerElement): PendingEntry | null {
  const existing = pending.get(element)
  if (existing) return existing
  const componentName = owningComponentName(element)
  if (!componentName) return null
  const entry: PendingEntry = {
    element,
    componentName,
    declarations: new Map(),
    classAdd: new Set(),
    classRemove: new Set(),
    text: null,
  }
  pending.set(element, entry)
  return entry
}

/** Queues CSS declarations for the element's template tag. Returns false when unowned. */
export function queueAngularStyles(
  element: LayerElement,
  declarations: Array<{ property: string; value: string }>
): boolean {
  const entry = entryFor(element)
  if (!entry) return false
  for (const { property, value } of declarations) entry.declarations.set(property, value)
  announce()
  return true
}

export function queueAngularClasses(
  element: LayerElement,
  write: { add: string[]; remove: string[] }
): boolean {
  const entry = entryFor(element)
  if (!entry) return false
  for (const name of write.remove) {
    entry.classAdd.delete(name)
    entry.classRemove.add(name)
  }
  for (const name of write.add) {
    entry.classRemove.delete(name)
    entry.classAdd.add(name)
  }
  announce()
  return true
}

export function queueAngularText(element: LayerElement, text: string): boolean {
  const entry = entryFor(element)
  if (!entry) return false
  entry.text = text
  announce()
  return true
}

/**
 * The queue as wire operations.
 *
 * The target descriptor is read HERE rather than when the edit was queued,
 * which is the one ordering that works: a class write has already mutated
 * `classList` by the time it reaches the queue, and the server matches a
 * template's static classes as a subset of the live ones. Describing the
 * element as it stands now — after the preview — is what keeps that subset test
 * true for the element the user is looking at.
 */
export function buildAngularOperations(): AngularOperation[] {
  const operations: AngularOperation[] = []
  for (const entry of pending.values()) {
    if (!entry.element.isConnected) continue
    const target = describeTarget(entry.element)
    if (entry.classRemove.size || entry.classAdd.size) {
      // Before the style write, because a class can carry the same property and
      // the more specific inline declaration should be the one that survives.
      operations.push({
        op: "setClasses",
        componentName: entry.componentName,
        target: {
          ...target,
          // The template still holds the classes this write removes, so the
          // descriptor has to describe the element as the template knows it.
          classes: [...new Set([...target.classes, ...entry.classRemove])],
        },
        add: [...entry.classAdd],
        remove: [...entry.classRemove],
      })
    }
    if (entry.declarations.size) {
      operations.push({
        op: "setStyles",
        componentName: entry.componentName,
        target,
        declarations: Object.fromEntries(entry.declarations),
      })
    }
    if (entry.text !== null) {
      operations.push({
        op: "setText",
        componentName: entry.componentName,
        target,
        text: entry.text,
      })
    }
  }
  return operations
}

export async function applyAngularOperations(
  operations: AngularOperation[]
): Promise<AngularApplyResult> {
  const response = await fetch(`${config.apiBase}/angular/apply`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ operations }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.message ?? `Angular apply failed (${response.status})`)
  }
  return response.json()
}
