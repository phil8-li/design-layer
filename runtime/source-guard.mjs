/**
 * Which files the server may read and write for the browser: the source-path
 * guard every route that takes a path goes through (`resolveEditableSource`)
 * and the test it ends in (`isEditableSourcePath`).
 *
 * Its own module, apart from config resolution in config.mjs, because it is a
 * security boundary and should be findable as one. config.mjs re-exports both
 * names, which is where the server's writers import them from.
 *
 * The guard, in order: a lexical deny list nobody can override (env files,
 * config files, node_modules, .git), the host's extension allowlist, the real
 * path inside the canonical project root, and inside one of the source roots.
 */

import fs from "node:fs"
import path from "node:path"

/**
 * Never host-overridable. The agent reads and rewrites files the browser names,
 * and `.env.local` sits in the project root next to the components. An
 * allowlist a host can empty is not a guard, so this list is applied after the
 * host's own extension allowlist and cannot be extended or removed.
 */
const SOURCE_DENY_PATTERNS = Object.freeze([
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])[^\\/]*\.config\.[cm]?[jt]sx?$/i,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/,
])

/**
 * Whether a `path.relative` result climbs out of its base. Compared by path
 * segment: a file whose own name begins with two dots (`..notes.tsx`) sits
 * inside the root, and a plain `startsWith("..")` refused it.
 */
function leavesRoot(relative) {
  return relative === ".." || relative.startsWith(`..${path.sep}`)
}

/**
 * A path with its symlinks resolved, or `null` for one that cannot be reached.
 *
 * `realpath` lstats, and lstat is the call a managed Mac refuses for a
 * protected folder while reading and listing it perfectly. Answering "not
 * editable" to that refusal means every source file in such a project is
 * refused and the editor can change nothing at all, which is why a path the
 * machine will not resolve but will still confirm falls back to its lexical
 * form. Only for EPERM: a path that is genuinely absent stays refused, and a
 * lexical path is a weaker containment check — it cannot see a symlink out of
 * the project — so it is the fallback and never the first answer.
 */
function canonicalPath(target) {
  try {
    return fs.realpathSync(target)
  } catch (error) {
    if (error?.code !== "EPERM") return null
    return fs.existsSync(target) ? path.resolve(target) : null
  }
}

/**
 * Canonical project and source roots, resolved once per config object.
 *
 * `isEditableSourcePath` is asked about every file a whole-project walk visits,
 * and re-resolving the same two or three roots for each of three thousand files
 * was a real share of what a usage lookup spent outside the parser. The entry
 * remembers the lexical roots it was made from, so a config whose roots are
 * reassigned is re-resolved rather than answered from the old ones, and a root
 * that did not resolve is never remembered — it may simply not exist yet.
 */
const canonicalRoots = new WeakMap()
function canonicalRootsOf(config) {
  const listed = config.source.roots.length === 0 ? [config.projectRoot] : config.source.roots
  const key = `${config.projectRoot}\0${listed.join("\0")}`
  const cached = canonicalRoots.get(config)
  if (cached?.key === key) return cached
  const entry = { key, projectRoot: canonicalPath(config.projectRoot), sourceRoots: listed.map(canonicalPath) }
  if (entry.projectRoot !== null && !entry.sourceRoots.includes(null)) canonicalRoots.set(config, entry)
  return entry
}

/**
 * A client-supplied source path, made absolute and proven editable, or `null`.
 *
 * The leading-slash case is not a nicety: Vite serves modules as
 * `/src/App.tsx`, and that is the path its sourcemap hands the browser, so on a
 * Vite host EVERY path arrives looking absolute. Read literally it names
 * `/src/App.tsx` at the filesystem root, which is outside the project — the
 * refusal is correct and the file is not the one meant. Every route that takes
 * a path from the browser goes through here, because a route that kept its own
 * copy of this rule could lose the retry, and variants did: it answered 403 to
 * every lookup on a Vite host.
 *
 * The reinterpretation is the vendor's own rule, kept deliberately narrow and
 * in this order. A path resolving inside the project is taken as written. A
 * path that EXISTS outside it is refused outright — `/etc/passwd` is a real
 * file and must never be re-read as `<root>/etc/passwd`. Only a leading slash
 * pointing at nothing is retried against the root, and whatever survives that
 * still has to pass `isEditableSourcePath`, which is the actual gate.
 */
export function resolveEditableSource(config, requested) {
  if (typeof requested !== "string" || !requested.trim()) return null
  const root = config.projectRoot
  const trimmed = requested.trim()
  const candidates = []
  if (path.isAbsolute(trimmed)) {
    const absolute = path.resolve(trimmed)
    candidates.push(absolute)
    if (!fs.existsSync(absolute)) candidates.push(path.resolve(root, trimmed.replace(/^[/\\]+/, "")))
  } else {
    candidates.push(path.resolve(root, trimmed))
  }
  for (const candidate of candidates) {
    if (isEditableSourcePath(config, candidate, path.relative(root, candidate))) return candidate
  }
  return null
}

/**
 * True when the agent is allowed to read/write this path.
 *
 * `resolvedPath` is for a caller that already knows where the path resolves —
 * a walk that followed no symlink, whose files are its resolved root plus their
 * relative paths — and spares the `realpath` (an lstat per path component)
 * that a walk of thousands of files otherwise pays once per file.
 */
export function isEditableSourcePath(config, absolutePath, relativePath, resolvedPath) {
  const lexicalProbe = relativePath ?? absolutePath
  if (SOURCE_DENY_PATTERNS.some((pattern) => pattern.test(lexicalProbe))) return false
  if (!config.source.extensions.includes(path.extname(absolutePath).toLowerCase())) return false

  const target = resolvedPath ?? canonicalPath(absolutePath)
  const { projectRoot, sourceRoots } = canonicalRootsOf(config)
  if (target === null || projectRoot === null) return false

  const projectRelative = path.relative(projectRoot, target)
  if (
    projectRelative === "" ||
    leavesRoot(projectRelative) ||
    path.isAbsolute(projectRelative) ||
    SOURCE_DENY_PATTERNS.some((pattern) => pattern.test(projectRelative)) ||
    !config.source.extensions.includes(path.extname(target).toLowerCase())
  ) {
    return false
  }

  return sourceRoots.some((canonicalRoot) => {
    if (canonicalRoot === null) return false
    const rel = path.relative(canonicalRoot, target)
    return rel !== "" && !leavesRoot(rel) && !path.isAbsolute(rel)
  })
}
