/**
 * The host's icon set in the browser: what a selected `<svg>` is called, and
 * which other drawings it can be swapped for.
 *
 * Fetched rather than injected. The set this package was built against is 114KB
 * of path data, and a page load that never opens the inspector should not pay
 * for it. One in-flight promise is shared, so ten icon selections in a row make
 * one request.
 *
 * Nothing here knows the host's attribute name — `config.icons.attribute` does.
 * A host with no icon set configured gets an empty list and the icon section
 * never renders.
 *
 * An added icon LIBRARY lands in the same two functions, behind the host's own
 * drawings and deduplicated by name with the host winning. That order is the
 * whole policy and it is the conservative one: the host's set is what the
 * app on the page actually renders, so a library shipping its own `Check` must
 * not be able to change what `Check` means to an element that is already
 * drawing one. Everything the library adds beyond the clash is new and is
 * offered. The short-circuit survives the addition — a host with no icons and
 * no library that ships glyphs still makes no request at all — and so does the
 * request count, because the library's drawings are a separate endpoint that is
 * only asked when a library that has some is enabled. The attribute follows the
 * same precedence for the same reason: the host names its icons if it names
 * them at all, and a library's convention is only consulted when it does not.
 */

import { config } from "./config"
import { libraryIconAttribute, loadLibraryIcons, loadedLibraryIcons } from "../libraries/store"
import type { HostIconData } from "./icons"

export interface IconVariant extends HostIconData {
  name: string
  /**
   * True for a glyph named by an icon font rather than drawn: `nodes` is empty
   * and the name is the whole of what the library knows. Carried through the
   * merge so a surface listing it can say so instead of painting an empty box.
   */
  glyph?: boolean
}

let cache: IconVariant[] | null = null
let inFlight: Promise<IconVariant[]> | null = null

/** The attribute an icon names itself with, or "" when nothing declared one. */
export function iconAttribute(): string {
  return config.icons.attribute || libraryIconAttribute()
}

/**
 * The icon this element IS, not the icon it contains.
 *
 * Only an `<svg>` answers: a button wrapping an icon is a button, and letting
 * the wrapper answer would offer a variant swap that rewrote a child the user
 * did not select.
 */
export function iconNameOf(element: Element | null): string {
  const attribute = iconAttribute()
  if (!attribute || !(element instanceof SVGSVGElement)) return ""
  return element.getAttribute(attribute)?.trim() ?? ""
}

/** Host first, then whatever a library adds that the host has not already named. */
function withLibraries(host: IconVariant[], library: IconVariant[]): IconVariant[] {
  if (!library.length) return host
  const named = new Set(host.map((icon) => icon.name))
  return [...host, ...library.filter((icon) => !named.has(icon.name))]
}

/** The host's own set, loaded once. Empty when it configured none, or on failure. */
function hostIconSet(apiBase: string): Promise<IconVariant[]> {
  if (cache) return Promise.resolve(cache)
  if (!config.icons.available) return Promise.resolve([])
  inFlight ??= fetch(`${apiBase}/icons`, { headers: { accept: "application/json" } })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as { icons?: IconVariant[] }
      cache = Array.isArray(payload.icons) ? payload.icons : []
      return cache
    })
    .catch((error) => {
      console.warn("[designlayer] could not load the icon set", error)
      // Not cached: a dev server that was still starting should be asked again.
      inFlight = null
      return []
    })
  return inFlight
}

/** The set a picker offers: the host's, plus every enabled library's. */
export function loadIconSet(apiBase: string): Promise<IconVariant[]> {
  return Promise.all([hostIconSet(apiBase), loadLibraryIcons(apiBase)]).then(([host, library]) =>
    withLibraries(host, library)
  )
}

/** What is already loaded, for a synchronous render that must not wait. */
export function loadedIconSet(): IconVariant[] {
  return withLibraries(cache ?? [], loadedLibraryIcons())
}
