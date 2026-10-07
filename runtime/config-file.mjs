/**
 * Where a host's `designlayer.config.mjs` is, without loading anything else.
 *
 * Its own module, apart from config.mjs, because the start screen asks this one
 * question and nothing more: a bare `designlayer` has to know whether a config
 * names the app's port before it can tell whether to show the chooser at all,
 * and config.mjs brings the design-system, icon and companion resolvers with
 * it — a third of the time the screen takes to answer its first page, for a
 * process that never resolves a config when there is none to find.
 */

import fs from "node:fs"
import path from "node:path"

export const CONFIG_FILE_NAMES = [
  "designlayer.config.mjs",
  "designlayer.config.js",
]

/** First config file at or above `startDir`; null when the host has none. */
export function findConfigFile(startDir = process.cwd()) {
  let dir = path.resolve(startDir)
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
