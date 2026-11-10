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
 *
 * `ensureCurrentChromeBundle` is the launcher's use of it, kept here beside the
 * stamp it reads: skip, check, rebuild, or serve the stale bundle with a
 * warning.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const STAMP = path.join("dist", ".build-stamp.json")

/**
 * `mtimeMs:size` of a file, or null for one that is not there. The one
 * definition of "this file has not moved": the build stamp records it, and the
 * overlay responder keys its cache on it.
 */
export function statSignature(file) {
  try {
    const stats = fs.statSync(file)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return null
  }
}

const signature = statSignature

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

const BUILD_SCRIPT = fileURLToPath(new URL("../build.mjs", import.meta.url))

/**
 * `dist/` is gitignored, built by `build.mjs`, and read straight off disk by
 * the overlay responder (runtime/overlay-responder.mjs) — so the browser gets
 * whatever happens to be sitting there. A MISSING bundle was loud. One that was
 * merely BEHIND said nothing, and that is the worse of the two: the editor ran
 * two commits older than its own source while `tsc` passed, every suite
 * passed, and every source review was correct about a feature that simply was
 * not in the browser. `build.mjs --check`
 * already knew how to catch it; nothing on the path that actually serves the
 * bundle ever asked it.
 *
 * So the serving path asks, once, before the vendor boots. It asks by running
 * `build.mjs` in a child process rather than by calling esbuild inline, because
 * there must be exactly one description of how this package compiles: a second
 * copy of the target list here would drift from the real one and then either
 * miss a stale bundle or cry stale over a fresh one. The child costs ~100ms, so
 * it only runs when the stamp the last passing build left behind no longer
 * matches the files it was made from (`buildStampIsCurrent` above): a launch on
 * an untouched tree pays a few hundred `stat`s instead.
 *
 * Behind is rebuilt, not refused. The repair is one command, so refusing to
 * start would only make the user type it; and a rebuild that said nothing would
 * hide that the source had moved underneath them, which is precisely how this
 * went unnoticed. Rebuild, then say so in a line that cannot be mistaken for
 * routine output. When the rebuild is impossible — `esbuild` pruned from a
 * published install, a source tree that does not compile — the editor still
 * starts, because a prebuilt `dist/` with no rebuild wanted is a supported way
 * to consume this package; it just starts behind a warning that the thing in
 * the browser is not the source in this tree.
 */
export function ensureCurrentChromeBundle() {
  // The last passing build left a stamp of everything it compiled from; when
  // none of it has moved, the bundle is current and there is nothing to prove.
  if (buildStampIsCurrent(path.dirname(BUILD_SCRIPT))) return

  const runBuild = (...args) =>
    spawnSync(process.execPath, [BUILD_SCRIPT, ...args], {
      cwd: path.dirname(BUILD_SCRIPT),
      encoding: "utf8",
    })

  if (runBuild("--check").status === 0) return

  const rebuilt = runBuild()
  if (rebuilt.status === 0) {
    console.warn("[designlayer] dist/ was behind src/ — rebuilt it before serving")
    return
  }

  // Why it failed goes ABOVE the verdict, not below it. The reason is a compile
  // error or a module resolution stack — tens of lines either way — and a
  // warning printed on top of one is a warning nobody reads.
  const reason = (rebuilt.stderr || rebuilt.error?.message || "").trim()
  console.warn(
    (reason ? `${reason}\n\n` : "") +
      "[designlayer] dist/ does not match src/ and could not be rebuilt. The editor\n" +
      "  in the browser is NOT the source in this tree — it is whatever was built last.\n" +
      "  Run `npm run build` in the package to see your own changes."
  )
}
