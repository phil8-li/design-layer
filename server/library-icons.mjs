/**
 * An icon file read as glyphs: a name-to-drawing object in the host icon set's
 * own shape, or the list of ligature names an icon font ships instead of path
 * data.
 */

import { isPlainObject } from "./library-common.mjs"
import { emptyCatalog } from "./library-catalog.mjs"

/** Guards on a file nobody in this process wrote, not product limits. */
const MAX_ICON_DRAWINGS = 4000
const MAX_GLYPH_NAMES = 5000

/**
 * One drawing, by the rules `server/icon-set.mjs` already applies to the host's
 * own set — a non-empty `nodes` array of `[tag, attrs]` pairs, `currentColor`
 * when no root fill was declared. Kept identical on purpose: the picker has one
 * renderer, and a library glyph that normalized differently would render
 * differently from a host glyph for no reason the user could see.
 */
function normalizeDrawing(name, raw) {
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

/** A glyph named but not drawn. Keys on `name` so the two dialects list alike. */
function glyphName(entry) {
  if (typeof entry === "string") return entry.trim() || null
  if (isPlainObject(entry) && typeof entry.name === "string") return entry.name.trim() || null
  return null
}

/**
 * The name list an icon FONT ships instead of path data.
 *
 * Half the icon libraries in the world are a font plus a manifest of ligature
 * names, and refusing them would mean the editor could only offer icons to
 * projects that had already inlined their SVGs. A glyph carries no `nodes`, so
 * it is flagged rather than faked: the picker lists it by name and lets the
 * page's own font draw it, which is what the host does with it anyway.
 */
export function glyphList(parsed) {
  const source = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed.icons)
      ? parsed.icons
      : isPlainObject(parsed) && Array.isArray(parsed.names)
        ? parsed.names
        : null
  if (!source || source.length === 0) return null
  const names = source.map(glyphName)
  return names.every((name) => name !== null) ? names : null
}

export function parseIconLibrary(parsed, name) {
  if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
    throw new Error("An icon file must be a name-to-drawing object, or a list of glyph names")
  }

  const catalog = emptyCatalog(name)
  const glyphs = glyphList(parsed)
  if (glyphs) {
    catalog.iconDrawings = glyphs
      .slice(0, MAX_GLYPH_NAMES)
      .map((glyph) => ({ name: glyph, nodes: [], rootFill: "currentColor", glyph: true }))
  } else {
    const drawings = []
    for (const [key, raw] of Object.entries(parsed)) {
      if (key.startsWith("$")) continue
      if (drawings.length >= MAX_ICON_DRAWINGS) break
      const drawing = normalizeDrawing(key, raw)
      if (drawing) drawings.push(drawing)
    }
    catalog.iconDrawings = drawings
  }

  /*
   * An icon library that yields no glyph is the same mistake as a stylesheet
   * with no custom properties in it, and it gets the same answer: the user
   * pointed at the wrong file.
   *
   * Dropping a malformed ENTRY is right — one broken drawing in a dump of four
   * hundred is not worth refusing the other three hundred and ninety-nine, and
   * that is what `normalizeDrawing` returning null is for. Dropping every entry
   * and installing the result is not the same thing. It puts a card in the
   * Libraries panel that brings nothing, explains nothing, and leaves the user
   * to work out on their own that the JSON they chose was a build config, an
   * empty array, or a sprite sheet in some other dialect. An error naming both
   * shapes this parser accepts tells them what to point at instead.
   */
  if (catalog.iconDrawings.length === 0) {
    throw new Error(
      "No icons found. An icon file is either a name-to-drawing object " +
        '(`{ "check": { "nodes": [["path", { "d": "…" }]] } }`) ' +
        'or a list of glyph names (`["check", "close"]`, or `{ "icons": [...] }`)'
    )
  }

  catalog.iconDrawings.sort((a, b) => a.name.localeCompare(b.name))
  // The attribute the host's markup names a glyph with. Defaulted rather than
  // required, because a library that does not declare one is still usable —
  // `data-icon` is the convention, and the store can be told otherwise.
  catalog.iconAttribute =
    isPlainObject(parsed) && typeof parsed.$attribute === "string" && parsed.$attribute.trim()
      ? parsed.$attribute.trim()
      : "data-icon"
  return catalog
}

export function looksLikeDrawings(parsed) {
  if (!isPlainObject(parsed)) return false
  // `$attribute` and `$schema` are the file talking about itself. Judging them
  // as drawings made a perfectly good icon set undetectable.
  const entries = Object.entries(parsed).filter(([key]) => !key.startsWith("$"))
  if (entries.length === 0) return false
  return entries.every(([, value]) => isPlainObject(value) && Array.isArray(value.nodes))
}
