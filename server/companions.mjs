/**
 * Companion scripts: other people's browser tooling, loaded beside the editor.
 *
 * The editor is not the only dev-time surface a designer wants on a page. An
 * annotation toolbar, a feature-flag switcher, a locale picker — each is a
 * self-contained bundle that wants to render on top of the running app, and
 * each hits the same two walls when it tries to do that next to this editor:
 *
 *   1. It has to get onto the page at all. The proxy injects exactly one
 *      script, and a host that adds its own `<script>` to the app's HTML has
 *      put dev-time tooling into a file that ships.
 *   2. Its own UI must not read as canvas. The overlay treats every element it
 *      did not draw as the host's app — clicking a companion's button in select
 *      mode selects the button instead of pressing it. `chrome.trustedSelectors`
 *      is the existing answer, and a companion is precisely a thing that knows
 *      its own selectors and should not have to ask the host to restate them.
 *
 * So a companion declares both together: the bundle, and the selectors that
 * bundle draws under. The launcher concatenates the script onto the overlay
 * response; `resolveConfig` folds the selectors into `chrome.trustedSelectors`
 * before the vendor patch bakes them in.
 *
 * Declared two ways, for two different owners:
 *
 *   - `companions: [...]` in `designlayer.config.mjs`, when the companion
 *     belongs to the project and everyone editing it should get the same one.
 *   - `DESIGNLAYER_COMPANIONS`, a list of manifest paths, when the companion
 *     belongs to the MACHINE — one annotation toolbar wired into every app this
 *     person opens, with nothing added to any of their repositories.
 *
 * A manifest is declarative JSON rather than a module, because the env lane
 * points at files outside the project and this process must not execute those.
 */

import fs from "node:fs"
import path from "node:path"

/** Env var naming machine-wide companion manifests, separated by `:` or `,`. */
export const COMPANIONS_ENV = "DESIGNLAYER_COMPANIONS"

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"])

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readManifest(manifestPath) {
  let source
  try {
    source = fs.readFileSync(manifestPath, "utf8")
  } catch (error) {
    throw new Error(`companion manifest ${manifestPath} could not be read: ${error.message}`)
  }
  try {
    const parsed = JSON.parse(source)
    if (!isPlainObject(parsed)) throw new Error("not a JSON object")
    return parsed
  } catch (error) {
    throw new Error(`companion manifest ${manifestPath} is not valid JSON: ${error.message}`)
  }
}

function selectorsOf(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`${label} trustedSelectors must be an array of CSS selectors`)
  }
  return value
    .map((selector) => (typeof selector === "string" ? selector.trim() : ""))
    .filter((selector) => selector.length > 0)
}

/**
 * One companion, declared inline.
 *
 * `base` is the folder relative paths are read against: the project root for a
 * config entry, the manifest's own folder for a manifest — a manifest sitting
 * next to its bundle should say `"./toolbar.js"` and not care where it is
 * mounted from.
 */
function resolveEntry(entry, base, label) {
  if (!isPlainObject(entry)) {
    throw new Error(`${label} must be a path or an object with a script`)
  }
  if (typeof entry.script !== "string" || entry.script.trim().length === 0) {
    throw new Error(`${label} needs a script path`)
  }

  const script = path.resolve(base, entry.script)
  if (!fs.existsSync(script) || !fs.statSync(script).isFile()) {
    throw new Error(`${label} script not found: ${script}`)
  }

  const name =
    typeof entry.name === "string" && entry.name.trim().length > 0
      ? entry.name.trim()
      : path.basename(script, path.extname(script))

  return Object.freeze({
    name,
    script,
    trustedSelectors: Object.freeze(selectorsOf(entry.trustedSelectors, label)),
  })
}

/** Splits the env var on both separators, because both read naturally here. */
function envPaths(raw) {
  if (typeof raw !== "string") return []
  return raw
    .split(/[:,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * A companion named by path: its manifest, or a bare bundle for a companion
 * with no chrome of its own to declare.
 *
 * Both lanes take this form, and a manifest is the form that travels — it
 * carries the selectors, so the same one line wires the companion into a
 * project config or into every app on the machine.
 */
function resolveReference(rawPath, base, label) {
  const resolved = path.resolve(base, rawPath)
  if (SCRIPT_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    return resolveEntry({ script: resolved }, path.dirname(resolved), label)
  }
  return resolveEntry(readManifest(resolved), path.dirname(resolved), label)
}

/**
 * Both lanes, in one frozen list: config first, machine second.
 *
 * Order is load order, and the machine lane goes last on purpose — a companion
 * the person wired into every app is the outer layer, and should mount on top
 * of anything the project brought with it.
 */
export function resolveCompanions(value, projectRoot, env = process.env) {
  const declared = value === undefined || value === null ? [] : value
  if (!Array.isArray(declared)) {
    throw new Error("companions must be an array of paths or objects")
  }

  const fromConfig = declared.map((entry, index) => {
    const label = `companions[${index}]`
    return typeof entry === "string"
      ? resolveReference(entry, projectRoot, label)
      : resolveEntry(entry, projectRoot, label)
  })
  const fromEnv = envPaths(env?.[COMPANIONS_ENV]).map((rawPath) =>
    resolveReference(rawPath, projectRoot, `${COMPANIONS_ENV} entry ${rawPath}`)
  )

  // A companion named twice — declared by the project AND wired in machine-wide
  // — would mount twice and, for anything that registers a global or a session,
  // fight itself. First declaration wins, which keeps the project's own pinned
  // copy over the ambient one.
  const seen = new Set()
  const unique = []
  for (const companion of [...fromConfig, ...fromEnv]) {
    if (seen.has(companion.name)) continue
    seen.add(companion.name)
    unique.push(companion)
  }

  return Object.freeze(unique)
}

/** Every selector the resolved companions draw under, in declaration order. */
export function companionSelectors(companions) {
  return companions.flatMap((companion) => [...companion.trustedSelectors])
}

/**
 * One companion's source, fenced so it cannot take the editor down with it.
 *
 * These bundles are third-party and arrive concatenated into the overlay
 * response, where a bare `throw` at module scope would stop every statement
 * after it — including the editor's own chrome if a companion is not last. The
 * IIFE also keeps a companion's top-level declarations out of the shared scope.
 */
export function wrapCompanion(name, source) {
  return (
    `;(function(){try{\n${source}\n}catch(error){` +
    `console.error(${JSON.stringify(`[designlayer] companion "${name}" failed to start`)},error)` +
    `}})();\n`
  )
}
