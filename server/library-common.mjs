/**
 * The handful of helpers every library reader and the host manifest share;
 * `isPlainObject` also serves the companion, icon-set and app-switch readers.
 *
 * Each of these used to be written again in every module that needed it, and
 * the copies were the kind that drift: a component found over HTTP, one read
 * out of a manifest and one scanned out of a directory must carry the same id
 * for the same name, and three private slug functions are three chances for
 * them not to. A leaf module with no imports, so anything may depend on it
 * without a cycle.
 */

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * A name as the lower-case, hyphenated id segment every catalog entry is keyed
 * by. Two slugs would mean the same component carried two ids depending on
 * where it was found.
 */
export function slug(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

/** `color:brand-500`: a token's id, from its category and its name. */
export function tokenId(category, name) {
  return `${category}:${slug(name)}`
}

/** `component:split-button`: a component's id, whichever reader found it. */
export function componentId(name) {
  return `component:${slug(name)}`
}
