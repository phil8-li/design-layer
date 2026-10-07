/**
 * The stamp `build.mjs` leaves in `dist/`, so the launcher can tell a current
 * bundle from a stale one without compiling anything.
 *
 * Freshness used to be proven the only way that is certain: compile `src/` in
 * a child process and compare the bytes with `dist/`. That is still the proof
 * — `build.mjs --check` is unchanged — but it cost every launch and every app
 * switch ~100ms of `spawnSync` on the path before the proxy binds, to learn
 * what is nearly always "nothing moved".
 *
 * So the build records what it compiled from: every input esbuild read (the
 * metafile, `src/` and the `node_modules` files alike), the build script and
 * its plugins, and the outputs it wrote, each as `mtimeMs:size`. When all of
 * them still stat the same, the bundle is the one those inputs compile to and
 * there is nothing to check. Anything that moved — an edit, a new import (which
 * is an edit), an `npm install`, a damaged `dist/` — fails the comparison and
 * falls through to the real check, which writes a new stamp when it passes.
 * The stamp only ever says "skip the proof"; it never says "stale".
 */

import fs from "node:fs"
import path from "node:path"

const STAMP = path.join("dist", ".build-stamp.json")

function signature(file) {
  try {
    const stats = fs.statSync(file)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return null
  }
}

/** Records `inputs` and `outputs` (absolute paths) as the build that just passed. */
export function writeBuildStamp(root, inputs, outputs) {
  const record = (files) =>
    Object.fromEntries([...new Set(files)].map((file) => [path.relative(root, file), signature(file)]))
  fs.writeFileSync(
    path.join(root, STAMP),
    `${JSON.stringify({ inputs: record(inputs), outputs: record(outputs) })}\n`
  )
}

/** True only when every file the last passing build recorded is exactly as it was. */
export function buildStampIsCurrent(root) {
  let stamp
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(root, STAMP), "utf8"))
  } catch {
    return false
  }
  const groups = [stamp?.inputs, stamp?.outputs]
  if (groups.some((group) => !group || typeof group !== "object" || !Object.keys(group).length)) {
    return false
  }
  return groups.every((group) =>
    Object.entries(group).every(([file, recorded]) => recorded !== null && signature(path.join(root, file)) === recorded)
  )
}
