/**
 * Facts about a host project that several modules read: its manifest, its
 * package name, its dependencies, and the file names that say which framework
 * it uses.
 *
 * They used to be read in each place that needed them — `config.mjs` and the
 * launcher each parsed `package.json` and each kept a list of Next and Vite
 * config names — and `config.mjs` could not share the start screen's list of
 * dev-script names because the module that holds it shells out to `lsof`. This
 * module is a leaf (it imports nothing of this package and runs nothing), so
 * every one of them can import it.
 *
 * Every reader answers null or false rather than throwing: a project without a
 * readable manifest is a project these facts are absent for.
 */

import fs from "node:fs"
import path from "node:path"

/** The config files `react-rewrite-cli@0.1.1`'s `detect()` accepts as Next. */
export const NEXT_CONFIG_FILES = Object.freeze(["next.config.js", "next.config.ts", "next.config.mjs"])

/** The config files that `detect()` accepts as Vite. */
export const VITE_CONFIG_FILES = Object.freeze(["vite.config.js", "vite.config.ts"])

/** A Tailwind config at the project root, for a host whose dependency lives in a workspace root. */
export const TAILWIND_CONFIG_FILES = Object.freeze([
  "tailwind.config.js",
  "tailwind.config.ts",
  "tailwind.config.mjs",
  "tailwind.config.cjs",
])

/**
 * The `dev` and `start` families of npm scripts, best first. The start screen
 * offers them in this order and `--dev` resolves to the first one a project
 * has, so the script the CLI runs is the one the screen would have preselected.
 */
export const DEV_SCRIPT_PREFERENCE = Object.freeze(["dev", "develop", "start", "serve"])

/** The parsed `package.json` at the project root, or null. */
export function readManifest(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"))
  } catch {
    return null
  }
}

/** `dependencies` and `devDependencies` together; empty for no manifest. */
export function manifestDependencies(manifest) {
  return { ...manifest?.dependencies, ...manifest?.devDependencies }
}

/** What the project calls itself in `package.json`, or null. */
export function packageNameOf(projectRoot) {
  const name = readManifest(projectRoot)?.name
  return typeof name === "string" && name.length > 0 ? name : null
}

/** Whether any of `names` exists at the project root. */
export function hasRootFile(projectRoot, names) {
  return names.some((name) => fs.existsSync(path.join(projectRoot, name)))
}
