/**
 * The Angular half of "where is this element written".
 *
 * On a React host a fiber walk names the file. Angular has no fibers, so this
 * module names the component and asks the server for the file; every panel,
 * the canvas, the history and the journal stay as they are, because they all
 * talk to `resolveElementSource` rather than to either host.
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
import { describeTarget } from "./element-target"
import type { SourceRef } from "./types"

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
 * permanently-remembered "no" would leave that element without a file for as long
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
