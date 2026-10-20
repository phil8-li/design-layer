/**
 * The files an installed copy of DesignLayer runs from, when it is not a git
 * clone: the Mac download (desktop/mac/package.mjs) copies them out of this
 * checkout, and the updater (runtime/updater.mjs) copies them out of a release
 * archive. One list, so an update never drops a file the download carried or
 * adds one it did not.
 *
 * It lives in runtime/ because the payload carries runtime/ and not tools/.
 */

import fs from "node:fs"
import path from "node:path"

export const PAYLOAD_FILES = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "build.mjs",
  "cli.mjs",
  "config.mjs",
  "designlayer.config.example.mjs",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  // build.mjs imports these two; nothing else under tools/ is read at run time.
  "tools/sonner-plugin.mjs",
  "tools/strip-css-comments.mjs",
]

export const PAYLOAD_DIRS = ["runtime", "server", "src", "desktop/mac"]

export const PAYLOAD_EXCLUDE = new Set(["node_modules", "test", ".DS_Store", ".git", ".local", ".demos", ".check", ".cache", "package.mjs"])

/**
 * Which commit an installed copy was made from. A git clone knows by itself;
 * a copy without .git carries this file at its root, written by whoever made
 * the copy: the package script, or the updater after it replaces the files.
 */
export const SOURCE_STAMP = ".designlayer-source.json"

/** Copies the payload from a source tree to `to`. Throws on a missing file. */
export function copyPayload(from, to) {
  for (const file of PAYLOAD_FILES) {
    const source = path.join(from, file)
    if (!fs.existsSync(source)) throw new Error(`missing ${file}`)
    fs.mkdirSync(path.dirname(path.join(to, file)), { recursive: true })
    fs.copyFileSync(source, path.join(to, file))
    fs.chmodSync(path.join(to, file), fs.statSync(source).mode & 0o777)
  }
  for (const dir of PAYLOAD_DIRS) {
    fs.cpSync(path.join(from, dir), path.join(to, dir), {
      recursive: true,
      filter: (src) => !PAYLOAD_EXCLUDE.has(path.basename(src)) && !src.endsWith(".log"),
    })
  }
}
