/**
 * The host's icon SET — the variants one `<svg>` layer can be swapped between.
 *
 * Not `designSystem.icons`, which is the icon SIZE scale. This is drawing data,
 * and it is served on request rather than shipped in the browser prelude
 * because the set this package was built against is 114KB of path data: a cost
 * every page load would pay for a panel most sessions never open.
 *
 * The shape is the one a React icon factory already stores — name to
 * `{ nodes: [[tag, attrs, children?]], rootFill, rootStroke? }` — so a host
 * points at the file it ships and writes no adapter. `src/core/icons.ts` draws
 * the editor's own chrome from that same shape, so there is one renderer.
 */

import fs from "node:fs"
import path from "node:path"

import { isPlainObject } from "./library-common.mjs"

/** A guard on a hand-edited config, not a product limit. */
const MAX_ICONS = 4000
const ATTRIBUTE_PATTERN = /^[a-z][a-z0-9-]{1,60}$/

/**
 * Both halves or neither: an attribute with no data names icons the picker
 * cannot offer, and data with no attribute cannot be matched to a selection.
 */
export function resolveIconSetConfig(value, projectRoot) {
  if (value === undefined || value === null) return Object.freeze({ attribute: "", data: null })
  if (!isPlainObject(value)) throw new Error("icons must be an object with attribute and data")

  const attribute = typeof value.attribute === "string" ? value.attribute.trim() : ""
  const data = typeof value.data === "string" ? value.data.trim() : ""
  if (!attribute && !data) return Object.freeze({ attribute: "", data: null })
  if (!attribute || !data) {
    throw new Error("icons needs both an attribute and a data path, or neither")
  }
  if (!ATTRIBUTE_PATTERN.test(attribute)) {
    throw new Error(`icons.attribute must be a plain lowercase attribute name, got "${attribute}"`)
  }
  return Object.freeze({ attribute, data: path.resolve(projectRoot, data) })
}

/** One drawing. Anything that is not this shape is dropped rather than served. */
function normalizeIcon(name, raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.nodes) || raw.nodes.length === 0) return null
  const nodes = raw.nodes.filter(
    (node) => Array.isArray(node) && typeof node[0] === "string" && isPlainObject(node[1])
  )
  if (nodes.length === 0) return null
  return {
    name,
    nodes,
    rootFill: typeof raw.rootFill === "string" ? raw.rootFill : "currentColor",
    ...(typeof raw.rootStroke === "string" ? { rootStroke: raw.rootStroke } : {}),
  }
}

export function createIconSet(config) {
  const { attribute, data } = config.icons ?? { attribute: "", data: null }
  /** The parsed set, kept while the data file's `mtimeMs:size` holds. */
  let cache = null
  let cachedStat = null

  return {
    attribute,
    configured: Boolean(data),

    /**
     * Read again only when the file changed, by the stat rule the other
     * server readers use (`createFileCache` in `file-io.mjs`). It used to be
     * read once on the claim that a change to it restarts this process; the
     * dev server restarts, and this process (which supervises it) does not,
     * so an edited set was served stale until the editor restarted.
     */
    read() {
      if (!data) {
        cache ??= { attribute: "", icons: [] }
        return cache
      }
      let stats = null
      try {
        stats = fs.statSync(data)
      } catch {
        // Unreadable now: the read below says why.
      }
      if (cache && stats && cachedStat && cachedStat.mtimeMs === stats.mtimeMs && cachedStat.size === stats.size) {
        return cache
      }
      let parsed
      try {
        parsed = JSON.parse(fs.readFileSync(data, "utf8"))
      } catch (error) {
        throw new Error(`Could not read icon set ${data}: ${error.message}`)
      }
      if (!isPlainObject(parsed)) throw new Error(`Icon set ${data} is not a name-to-icon object`)

      const icons = []
      for (const [name, raw] of Object.entries(parsed)) {
        if (icons.length >= MAX_ICONS) break
        const icon = normalizeIcon(name, raw)
        if (icon) icons.push(icon)
      }
      icons.sort((a, b) => a.name.localeCompare(b.name))
      cache = { attribute, icons }
      cachedStat = stats
      return cache
    },
  }
}
