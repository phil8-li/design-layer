/**
 * Reading a design system out of a file somebody else wrote.
 *
 * The host's own design system arrives as a manifest this package specifies, so
 * `design-system-manifest.mjs` can afford to be strict: a shape it does not
 * recognise is a mistake the host should hear about. A LIBRARY is the opposite
 * situation. It is a file the user already had — a theme stylesheet, a Style
 * Dictionary export, an icon dump — written years before this editor existed
 * and with no intention of being read by it. Nothing about it can be required,
 * and every rule here has to survive a spelling nobody agreed on in advance.
 *
 * That is why the CSS classifier below keys on WORD SEGMENTS rather than on
 * prefixes. A prefix rule assumes the type word leads the name, which is true
 * of Tailwind v4 (`--color-brand-500`) and false of most systems shipped by a
 * platform team, where the name leads with a vendor and a layer and the type
 * word sits in the middle (`--x-sys-spacing-4`) or is absent entirely
 * (`--x-blue-500`, a colour only its value admits to). Measured against four
 * real design systems, a prefix rule read almost nothing. Segment matching plus
 * a value fallback reads nearly all of it.
 *
 * The second half of the job is refusing. A token this editor offers is a token
 * it will WRITE into the user's stylesheet, so a value it cannot write is worse
 * than a value it never saw: the picker reports success and the element does not
 * change. Hence the per-group validation — a colour must be paintable, a radius
 * must be a single length, an easing curve is dropped even though it is plainly
 * a motion token, because the motion axis writes a duration and would quietly
 * ship a different feel. Dropping is the safe direction; a token that is missing
 * is a token the designer types by hand.
 *
 * Everything here is pure. No filesystem, no config, no clock — the store in
 * `libraries.mjs` owns all three. That is what makes the parsing brain testable
 * against a string, which is how the rules below were measured in the first
 * place.
 *
 * This file is the FACADE: every importer reads the library parsers through it,
 * and the readers themselves live beside it, one module per job.
 *
 *   library-common.mjs     ids and the plain-object test every reader shares
 *   library-catalog.mjs    the catalog shape, its counts, and the offer/adopt bars
 *   library-values.mjs     settling a value and deciding whether it is writable
 *   library-classify.mjs   which axis a name belongs to, and its display name
 *   library-css.mjs        a stylesheet's custom properties and type roles
 *   library-tokens.mjs     DTCG, Style Dictionary, Figma variables, plain JSON
 *   library-icons.mjs      drawings and glyph-name lists
 *
 * What stays here is what decides between them: the kind vocabulary, the
 * reader version, detection, and the small manifest reader.
 */

import { isPlainObject, slug, componentId } from "./library-common.mjs"
import { normalizeDesignSystemManifest } from "./design-system-manifest.mjs"
import { parseCssLibrary } from "./library-css.mjs"
import { glyphList, looksLikeDrawings, parseIconLibrary } from "./library-icons.mjs"
import { figmaVariableLeaves, hasTokenLeaf, parseTokenLibrary, readableTokenCount } from "./library-tokens.mjs"
import { describeCatalog } from "./library-catalog.mjs"

export { slug, componentId } from "./library-common.mjs"
export {
  MIN_SINGLE_AXIS_TOKENS,
  MIN_SYSTEM_TOKENS,
  describeCatalog,
  emptyCatalog,
  filledGroups,
  isEmptyCatalog,
  libraryCounts,
  totalTokens,
  worthAdopting,
  worthOffering,
} from "./library-catalog.mjs"

/**
 * The six shapes a library can arrive in.
 *
 * Two of them never reach `parseLibrary`, and both are in this list anyway.
 * `components` names a DIRECTORY of React or Angular sources, so it is scanned
 * by `library-components.mjs`. `url` names a page on the internet, so it is
 * fetched by `library-url.mjs` — and what comes back is handed to the parsers
 * here, which is why a remote token file is understood exactly as the same file
 * on disk would be. They belong in this list because the kind vocabulary is
 * shared with the store, the routes and the panel, and a second list that had
 * to be kept in step with this one would drift.
 */
export const LIBRARY_SOURCE_KINDS = Object.freeze([
  "manifest",
  "css",
  "tokens",
  "icons",
  "components",
  "url",
])

/**
 * Which generation of the reading rules below a catalog was produced by.
 *
 * A file library is re-parsed on every list, so it always reflects the rules in
 * this file. A URL library is NOT — its catalog is cached in the pointer file
 * when it is fetched (see `libraries.mjs`) — so a fix to these rules never
 * reached a library that was already installed: the one that reported an icon
 * scale as five text styles kept doing so after the fix, because nothing ever
 * read it again. The store stamps this number on each URL catalog it caches and
 * re-reads any catalog stamped lower.
 *
 * Bump it whenever a change would read the same source text into a different
 * catalog. A row with no stamp predates the stamp and counts as 1.
 *
 * The rules live in more files than this one. Everything the facade reads
 * through (the modules listed in the header) is one source, and the URL reader
 * is the other: `library-url.mjs` decides which documents are read, in which
 * order, and how several stylesheets merge, and a change there changes a cached
 * catalog just as surely. `test/library-source-cases.mjs` hashes the catalogs
 * both produce from fixed inputs and fails when that hash moves while this
 * number stands still.
 *
 * 5: a walled guessed path no longer hides a public page's tokens; a keyword
 *    font weight is read on a custom-property text style; a token file stops
 *    at its leaf ceiling; overlong values and selectors are not read.
 */
export const CATALOG_READER_VERSION = 5

/**
 * The library's identity, derived from its path rather than stored.
 *
 * Two libraries are the same library when they point at the same file, and the
 * path is the only thing about a source that is guaranteed to exist and to be
 * stable across a restart. Deriving the id from it means the persisted pointer
 * needs no generated key, and an id that appears in a URL is legible to whoever
 * is reading the network tab.
 */
export function libraryId(relativePath) {
  const id = slug(String(relativePath ?? ""))
  if (!id) throw new Error("A library path must contain at least one letter or digit")
  return id
}

/* ------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* ------------------------------------------------------------------------- */

function manifestComponents(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error("Invalid design-system manifest: components must be an array")
  return raw.map((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(`Invalid design-system manifest: components[${index}] needs a name`)
    }
    const props = entry.props === undefined || entry.props === null ? [] : entry.props
    if (!Array.isArray(props)) {
      throw new Error(`Invalid design-system manifest: components[${index}].props must be an array`)
    }
    return {
      id: componentId(entry.name),
      name: entry.name.trim(),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(typeof entry.snippet === "string" ? { snippet: entry.snippet } : {}),
      props: props.filter(isPlainObject).map((prop) => ({
        name: String(prop.name ?? ""),
        ...(typeof prop.type === "string" ? { type: prop.type } : {}),
        ...(Array.isArray(prop.values) ? { values: prop.values.map((value) => String(value)) } : {}),
      })),
    }
  })
}

function parseManifestLibrary(parsed, name) {
  const normalized = normalizeDesignSystemManifest(parsed)
  return {
    name: name || normalized.name || "Design system",
    trackingUnit: normalized.trackingUnit,
    colors: normalized.colors,
    spacing: normalized.spacing,
    radii: normalized.radii,
    textStyles: normalized.textStyles,
    uiTextStyles: normalized.uiTextStyles,
    effects: normalized.effects,
    icons: normalized.icons,
    motion: normalized.motion,
    components: manifestComponents(parsed.components),
    // Breakpoints are deliberately absent. They are a compile-time fact of the
    // HOST's build — a `md:` prefix only exists because the host's Tailwind
    // config emitted it — so a library offering one would put a prefix in the
    // inspector that compiles to nothing in the project being edited.
    iconDrawings: [],
    iconAttribute: "",
  }
}

/* ------------------------------------------------------------------------- */
/* Entry points                                                               */
/* ------------------------------------------------------------------------- */

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Could not read this ${label}: ${error.message}`)
  }
}

/**
 * Parse a library's text into a catalog, or throw.
 *
 * Throwing is right here and dropping is right inside the parsers, and the line
 * between them is whether the user is being told something they can act on. A
 * file that is not the kind it claims to be is a mistake to surface. A single
 * token inside an otherwise good file that this editor cannot write is not —
 * refusing four hundred tokens over one gradient would make the feature useless
 * on exactly the mature design systems it exists for.
 */
export function parseLibrary(kind, text, { name } = {}) {
  return parseText(kind, text, undefined, name)
}

/**
 * The kinds that are text this module parses. `components` (a directory) and
 * `url` (a page) are in the vocabulary but never reach a parser: the store
 * scans the first and `library-url.mjs` hands back whatever text the second
 * served, under the kind that text actually is.
 */
const PARSED_KINDS = ["manifest", "tokens", "icons", "css"]

/** `parseLibrary` with the JSON already parsed, when the caller has it in hand. */
function parseText(kind, text, parsed, name) {
  const label = typeof name === "string" && name.trim() ? name.trim() : ""
  const json = (what) => (parsed === undefined ? parseJson(text, what) : parsed)
  if (kind === "manifest") return parseManifestLibrary(json("manifest"), label)
  if (kind === "tokens") return parseTokenLibrary(json("token file"), label)
  if (kind === "icons") return parseIconLibrary(json("icon file"), label)
  if (kind === "css") return parseCssLibrary(text, label)
  throw new Error(`Unknown library kind "${kind}". Expected one of ${PARSED_KINDS.join(", ")}`)
}

/**
 * Detect and parse in one go: `{ kind, catalog }`, or null when the text is
 * not a design system or does not parse as the kind it looks like.
 *
 * JSON is parsed once and handed to both halves — or not at all, when the
 * caller already parsed it and passes `parsed`. A remote body runs to eight
 * megabytes, and detection followed by `parseLibrary` read it two or three
 * times over.
 */
export function readLibraryText(relativePath, text, { name, parsed: given } = {}) {
  const parsed = given === undefined ? parseMaybeJson(text) : given
  const kind = kindOf(relativePath, text, parsed)
  if (!kind) return null
  try {
    return { kind, catalog: parseText(kind, text, parsed, name) }
  } catch {
    return null
  }
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(typeof text === "string" ? text : "")
  } catch {
    return undefined
  }
}

const MANIFEST_KEYS = ["collections", "textStyles", "effectStyles", "iconScale", "motion"]
// Only at the start of a name run: without the look-behind, a run of a
// hundred thousand hyphens was tried from every one of them.
const CSS_CUSTOM_PROPERTY = /(?<![a-zA-Z0-9_-])--[a-zA-Z0-9_-]+\s*:/g
const MIN_CSS_PROPERTIES = 4

/**
 * How many readable tokens a file with no marker of its own has to yield before
 * it counts as a token file.
 *
 * The same floor, and the same argument, as the CSS one above: below it, what
 * was found is a coincidence rather than a design system. Discovery walks every
 * JSON file in a project through this function, so the cost of being generous
 * is offering somebody a library built out of their build config.
 */
const MIN_PLAIN_TOKENS = 4

/**
 * Which kind of design-system file this is, from its name and its text.
 *
 * Deterministic and ordered, because a file can honestly answer to two of these
 * — a manifest has a `motion` array and a token file can have a `motion` group
 * — and an order written down is an order a test can pin. Returns null rather
 * than guessing when nothing matches: discovery walks a whole project through
 * this function, and a false positive there offers the user a library that will
 * fail the moment they add it.
 *
 * The manifest test is on the SHAPE and not on the mere presence of the key,
 * which is the difference between reading that file and losing it. A manifest's
 * `motion` is an array of motion tokens; a token file's `motion` is a group of
 * duration tokens, and it is an entirely ordinary thing to write. Keyed on
 * presence, the second was handed to the manifest normalizer, which refused it
 * — correctly, it is not a manifest — and the throw reached the user as
 * "nothing here read as a design system" about a file that was nothing but
 * design tokens. Every marker key is an array in a real manifest, so requiring
 * one costs the manifest lane nothing and hands the token lane its file back.
 */
export function detectLibraryKind(relativePath, text) {
  return kindOf(relativePath, text, parseMaybeJson(text))
}

function kindOf(relativePath, text, parsed) {
  const source = typeof text === "string" ? text : ""
  if (parsed !== undefined) {
    if (isPlainObject(parsed) && MANIFEST_KEYS.some((key) => Array.isArray(parsed[key]))) {
      return "manifest"
    }
    if (looksLikeDrawings(parsed) || glyphList(parsed)) return "icons"
    if (hasTokenLeaf(parsed)) return "tokens"
    // A variables export announces itself structurally — a `meta.variables` map
    // of `resolvedType`/`valuesByMode` records is a shape nothing else has — so
    // it is recognised outright rather than by the count below, which a small
    // library would fall short of.
    if (figmaVariableLeaves(parsed)) return "tokens"
    // Last, because it is the only test here that reads a file's CONTENTS
    // rather than a marker it put there on purpose, and anything it claimed
    // early it would claim wrongly.
    if (isPlainObject(parsed) && readableTokenCount(parsed) >= MIN_PLAIN_TOKENS) return "tokens"
    return null
  }

  const properties = source.match(CSS_CUSTOM_PROPERTY)
  if (properties && properties.length >= MIN_CSS_PROPERTIES) return "css"
  return null
}

/**
 * Transitional: the store still calls this with a kind first. The description
 * no longer depends on the kind (see `describeCatalog`), so once the store's
 * call becomes `describeCatalog(catalog)` this alias goes.
 */
export function describeLibrary(_kind, catalog) {
  return describeCatalog(catalog)
}
