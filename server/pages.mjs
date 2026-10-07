/**
 * The host app's pages, discovered from its source tree for canvas mode.
 *
 * Canvas mode lays every route out as a same-origin iframe on a board, so it
 * needs a list of URLs before any of them has been visited. The only place that
 * list exists ahead of time is the source: Next's file conventions, or the path
 * literals a React Router or Angular route table declares. Nothing here runs the
 * app or evaluates its code; every strategy is a bounded read of files.
 *
 * Every failure degrades to fewer routes, never to an error. A folder macOS
 * refuses to list, a file that vanishes mid-walk, a tree far larger than any
 * app — each shrinks the answer, and the board still opens with what was found.
 * A route that exists but was missed costs one frame; a 500 costs the board.
 */

import fs from "node:fs"
import path from "node:path"

import { createLimiter, readKnownSize } from "./file-io.mjs"

/**
 * Guards on a hand-written tree, not product limits.
 *
 * A directory entry costs a dirent and nothing more, so the entry budget is
 * sized for a real app's `src/` — two thousand files there is ordinary, and a
 * budget that size spent itself before reaching the router file and answered 2
 * of 95 routes. What bounds the expensive half is `MAX_SCANNED_BYTES`, the total
 * of the files whose text is scanned in one read; it counts files answered from
 * the cache too, so the answer does not depend on what an earlier read paid for.
 */
export const MAX_WALKED_ENTRIES = 10000
export const MAX_ROUTES = 200
const MAX_SOURCE_BYTES = 256 * 1024
const MAX_SCANNED_BYTES = 32 * 1024 * 1024

// Reads a source walk starts between turns of the event loop; see `walkReading`.
// Measured on a 1,500-file `src/`: 4 to 16 were alike, and no turns at all was
// slower than the old synchronous walk.
const YIELD_EVERY = 8

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", "dist", "build", ".git", "out", "coverage"])
const PAGE_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js", ".mdx"])
const SCRIPT_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js"])

// Tie-break order for `framework`, and the order routes are merged in, so a
// path both Next routers declare is attributed to the app router.
const FRAMEWORKS = ["next-app", "next-pages", "react-router", "angular"]

const ROUTER_IMPORT = /\bfrom\s*["'](?:react-router|react-router-dom|@tanstack\/react-router)["']|\brequire\(\s*["'](?:react-router|react-router-dom|@tanstack\/react-router)["']\s*\)/
// `path: "/x"`, `path="/x"`, `path={"/x"}` — absolute literals only, since a
// relative child path cannot be placed without resolving its parent.
const ROUTER_PATH = /\bpath\s*(?::|=\s*\{?)\s*(["'`])(\/[^"'`\n]*)\1/g
// TanStack's file routes name their own path in the call.
const TANSTACK_FILE_ROUTE = /\bcreateFileRoute\(\s*(["'`])(\/[^"'`\n]*)\1/g
const ANGULAR_PATH = /\bpath\s*:\s*(["'`])([^"'`\n]*)\1/g

/**
 * A bounded, symlink-free, error-tolerant walk. `budget` is shared across every
 * walk in one `read()`, so the whole discovery touches at most
 * `MAX_WALKED_ENTRIES` entries however many roots it probes.
 *
 * Breadth-first in sorted order: route tables sit near the top of a tree
 * (`src/App.tsx`, `src/apps/web/App.tsx`), so the shallow files are the ones the
 * budget must reach first, and sorting makes a truncated answer the same one on
 * every read rather than whatever order the disk lists in.
 */
function walk(root, budget, visit) {
  const pending = [root]
  for (let next = 0; next < pending.length; next += 1) {
    const directory = pending[next]
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      // Unreadable, missing, or a guarded folder: fewer routes, not an error.
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (budget.remaining <= 0) {
        budget.exhausted = true
        return
      }
      budget.remaining -= 1
      const full = path.join(directory, entry.name)
      // Dirent types never follow symlinks, so a link cycle cannot loop here.
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue
        pending.push(full)
      } else if (entry.isFile()) {
        visit(full, entry.name)
      }
    }
  }
}

/**
 * `walk` for a walk that reads what it finds: directories are listed on the
 * thread pool, ahead of the walk, and the event loop gets a turn every few reads.
 *
 * A file read is several trips through the pool, and each trip's callback,
 * which starts the next, runs on this thread. A walk that holds the thread from
 * start to end lets the gate's first reads open their files and then stall
 * there until it is over: on a 1,500-file `src/` the pool sat idle for most of
 * the walk, and the reads only really began after it. Of what the walk itself
 * spends on this thread, the listings were the largest part (~5ms there, each a
 * directory open), so each folder is listed as soon as it is found and the walk
 * takes the listing when it gets there. The order — and with it the budget and
 * a truncated answer — is the same as `walk`'s.
 */
async function walkReading(root, budget, visit) {
  const list = (directory) => fs.promises.readdir(directory, { withFileTypes: true }).catch(() => null)
  const pending = [[root, list(root)]]
  let reads = 0
  for (let next = 0; next < pending.length; next += 1) {
    const [directory, listing] = pending[next]
    const entries = await listing
    // Unreadable, missing, or a guarded folder: fewer routes, not an error.
    if (!entries) continue
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (budget.remaining <= 0) {
        budget.exhausted = true
        return
      }
      budget.remaining -= 1
      const full = path.join(directory, entry.name)
      // Dirent types never follow symlinks, so a link cycle cannot loop here.
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue
        pending.push([full, list(full)])
      } else if (entry.isFile()) {
        // Only while there are reads to keep moving: a repeat answered from the
        // cache walks straight through.
        reads += visit(full, entry.name)
        if (reads >= YIELD_EVERY) {
          reads = 0
          await new Promise((resolve) => setImmediate(resolve))
        }
      }
    }
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * The route literals one file declares, answered from `cache` while its
 * `mtimeMs:size` holds — or a promise of them when the file has to be read.
 *
 * Every `.ts/.tsx/.js` file under `src/` is a candidate router file, and reading
 * them all to test for a router import was the whole cost of a board open. A
 * repeat costs one stat per file, and a page added or edited while the board is
 * open still shows on the next read, because its stat no longer matches.
 *
 * The stat stays synchronous, so the byte budget is still spent in walk order
 * and a truncated answer is the one it always was. The read goes through `gate`
 * and runs while the walk carries on: one at a time, each paid a whole
 * open/read/close round trip in series, and that was nearly all of a first
 * board open.
 */
function scanFile(file, budget, cache, extract, gate) {
  let stats
  try {
    stats = fs.statSync(file)
  } catch {
    return []
  }
  if (stats.size > MAX_SOURCE_BYTES) return []
  budget.seen.add(file)
  if (budget.bytes + stats.size > MAX_SCANNED_BYTES) {
    budget.exhausted = true
    return []
  }
  budget.bytes += stats.size
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.literals
  return gate(() => readKnownSize(file, stats.size)).then(
    (source) => {
      const literals = extract(source)
      cache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, literals })
      return literals
    },
    // Vanished mid-walk: no routes from it, and nothing cached.
    () => []
  )
}

function toPosix(value) {
  return value.split(path.sep).join("/")
}

/** Collapses doubled slashes and drops a trailing one, keeping `/` itself. */
export function normalizeRoutePath(value) {
  const collapsed = `/${value}`.replace(/\/{2,}/g, "/")
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed
}

/** `[id]`, `[...slug]`, `[[...slug]]`, `:id`, and `$id` all name a parameter. */
export function isDynamicPath(routePath) {
  return routePath.split("/").some((segment) => /^\[.+\]$/.test(segment) || /^[:$]/.test(segment))
}

/**
 * Next only counts as the framework when the project depends on it. A Vite app
 * with a `src/pages/` folder of screen components is common, and reading those
 * as a Pages Router would fill the board with URLs that 404.
 */
function usesNext(projectRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"))
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      if (pkg?.[field] && Object.hasOwn(pkg[field], "next")) return true
    }
  } catch {
    // No readable manifest: fall through to the config-file check.
  }
  return ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"].some((name) =>
    fs.existsSync(path.join(projectRoot, name))
  )
}

/**
 * App Router: a `page.*` file makes its folder a route. Route groups `(x)` add
 * no URL segment; private `_x`, parallel `@slot`, and intercepting `(.)x`
 * folders are not addressable pages of their own, so their subtrees are skipped.
 */
function nextAppRoutes(projectRoot, budget, add) {
  for (const base of ["app", "src/app"]) {
    const root = path.join(projectRoot, base)
    if (!isDirectory(root)) continue
    walk(root, budget, (file, name) => {
      const extension = path.extname(name)
      if (path.basename(name, extension) !== "page" || !PAGE_EXTENSIONS.has(extension)) return
      const segments = toPosix(path.relative(root, path.dirname(file))).split("/").filter(Boolean)
      const kept = []
      for (const segment of segments) {
        if (segment.startsWith("_") || segment.startsWith("@") || /^\(\.{1,3}\)/.test(segment)) return
        if (/^\(.*\)$/.test(segment)) continue
        kept.push(segment)
      }
      add("next-app", normalizeRoutePath(kept.join("/")), file)
    })
  }
}

/**
 * Pages Router: every page file is a route and `index` names its folder. `_app`,
 * `_document`, and other `_` files are framework hooks, `api/` is server-only,
 * and `404`/`500` are error pages nobody navigates to on purpose.
 */
function nextPagesRoutes(projectRoot, budget, add) {
  for (const base of ["pages", "src/pages"]) {
    const root = path.join(projectRoot, base)
    if (!isDirectory(root)) continue
    walk(root, budget, (file, name) => {
      const extension = path.extname(name)
      if (!PAGE_EXTENSIONS.has(extension) || name.endsWith(".d.ts")) return
      const segments = toPosix(path.relative(root, file)).slice(0, -extension.length).split("/")
      if (segments[0] === "api") return
      if (segments.some((segment) => segment.startsWith("_"))) return
      const last = segments.at(-1)
      if (segments.length === 1 && (last === "404" || last === "500")) return
      if (last === "index") segments.pop()
      add("next-pages", normalizeRoutePath(segments.join("/")), file)
    })
  }
}

/**
 * React Router and TanStack Router: absolute path literals in files that import
 * the router. Relative child paths and wildcards are left out — neither is a
 * URL on its own.
 */
function reactRouterLiterals(source) {
  if (!ROUTER_IMPORT.test(source)) return []
  const literals = []
  for (const pattern of [ROUTER_PATH, TANSTACK_FILE_ROUTE]) {
    for (const match of source.matchAll(pattern)) {
      const literal = match[2]
      if (literal.includes("*") || literal.includes("${")) continue
      literals.push(normalizeRoutePath(literal))
    }
  }
  return literals
}

/**
 * Angular: `path: 'x'` entries in route files. Angular paths are relative and
 * nesting is not resolved without an AST, so each entry is read as top-level;
 * `**` is the not-found catch-all and is skipped.
 */
function angularLiterals(source) {
  const literals = []
  for (const match of source.matchAll(ANGULAR_PATH)) {
    const literal = match[2]
    if (literal.includes("*")) continue
    literals.push(normalizeRoutePath(literal))
  }
  return literals
}

/**
 * Both `src/` strategies in one walk, each only where the host can use it: a
 * React host has no Angular route files worth opening, and an Angular host's
 * `.ts` files are not React Router tables. A config that names no framework (a
 * bare catalog, as the cases build) runs both. Walking once matters beyond the
 * time: two walks shared one budget, so the first starved the second.
 */
async function sourceRoutes(projectRoot, framework, budget, caches, add) {
  const root = path.join(projectRoot, "src")
  if (!isDirectory(root)) return
  const react = framework !== "angular"
  const angular = framework !== "react"
  const gate = createLimiter()
  const found = []
  await walkReading(root, budget, (file, name) => {
    const before = found.length
    if (react && SCRIPT_EXTENSIONS.has(path.extname(name)) && !name.endsWith(".d.ts")) {
      found.push(["react-router", file, scanFile(file, budget, caches.react, reactRouterLiterals, gate)])
    }
    if (angular && /(?:\.routes|-routing\.module)\.ts$/.test(name)) {
      found.push(["angular", file, scanFile(file, budget, caches.angular, angularLiterals, gate)])
    }
    // How many reads this file started, for `walkReading`'s turns: a promise is
    // a read, an array an answer from the cache.
    let reads = 0
    for (let index = before; index < found.length; index += 1) if (found[index][2] instanceof Promise) reads += 1
    return reads
  })
  // Added in walk order once every read is back, as when each was read in turn.
  const literals = await Promise.all(found.map((entry) => entry[2]))
  found.forEach(([strategy, file], index) => {
    for (const literal of literals[index]) add(strategy, literal, file)
  })
}

function compareRoutes(a, b) {
  if (a.path === "/" || b.path === "/") return a.path === "/" ? -1 : b.path === "/" ? 1 : 0
  if (a.dynamic !== b.dynamic) return a.dynamic ? 1 : -1
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

export function createPageCatalog(config) {
  const projectRoot = config.projectRoot
  const hostFramework = config.host?.framework
  // Per-file route literals, one map per strategy since each reads a file for
  // a different pattern. See `scanFile`.
  const caches = { react: new Map(), angular: new Map() }

  return {
    /** Never rejects: an unreadable project answers `unknown` with no routes. */
    async read() {
      const budget = { remaining: MAX_WALKED_ENTRIES, exhausted: false, bytes: 0, seen: new Set() }
      const found = Object.fromEntries(FRAMEWORKS.map((framework) => [framework, []]))
      const add = (framework, routePath, file) => {
        found[framework].push({
          path: routePath,
          file: toPosix(path.relative(projectRoot, file)),
          dynamic: isDynamicPath(routePath),
        })
      }

      try {
        if (usesNext(projectRoot)) {
          nextAppRoutes(projectRoot, budget, add)
          nextPagesRoutes(projectRoot, budget, add)
        }
        await sourceRoutes(projectRoot, hostFramework, budget, caches, add)
      } catch {
        // Discovery is best-effort; whatever was gathered before the fault stands.
      }
      // A file a complete walk no longer reached is gone; forget it so the
      // cache stays the size of the project.
      if (!budget.exhausted) {
        for (const cache of Object.values(caches)) {
          for (const file of cache.keys()) if (!budget.seen.has(file)) cache.delete(file)
        }
      }

      const seen = new Set()
      const routes = []
      const counts = {}
      for (const framework of FRAMEWORKS) {
        counts[framework] = 0
        for (const route of found[framework]) {
          if (seen.has(route.path)) continue
          seen.add(route.path)
          counts[framework] += 1
          routes.push(route)
        }
      }

      let framework = "unknown"
      for (const candidate of FRAMEWORKS) {
        if (counts[candidate] > (counts[framework] ?? 0)) framework = candidate
      }

      routes.sort(compareRoutes)
      return {
        framework,
        routes: routes.slice(0, MAX_ROUTES),
        truncated: budget.exhausted || routes.length > MAX_ROUTES,
      }
    },
  }
}
