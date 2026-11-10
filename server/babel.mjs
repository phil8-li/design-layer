/**
 * The one way a server module gets `@babel/parser`, and the plugins it reads
 * with.
 *
 * Babel comes from the host project when it has one, ours otherwise: a project
 * pinned to a newer parser can contain syntax ours cannot read, and the host's
 * own copy is by definition able to parse the host's own files. Three modules
 * (`variants.mjs`, `component-usage.mjs`, `control-defaults.mjs`) each made
 * that two-step themselves, with two different plugin lists, so a file one of
 * them could read the next could refuse.
 *
 * Only ever parsed to read, never to print, so the plugin list is every one a
 * modern React file might need. A leaf: it imports nothing of this package.
 */

import { createRequire } from "node:module"
import path from "node:path"

export const PLUGINS = ["jsx", "typescript", "decorators-legacy", "classProperties", "explicitResourceManagement"]

let ourParse = null

/** This package's own `parse`, loaded on first use. */
export function bundledParse() {
  if (!ourParse) ourParse = createRequire(import.meta.url)("@babel/parser").parse
  return ourParse
}

/** The host project's `parse` when it installs `@babel/parser`, ours otherwise. */
export function hostParse(projectRoot) {
  try {
    return createRequire(path.join(projectRoot, "package.json"))("@babel/parser").parse
  } catch {
    return bundledParse()
  }
}
