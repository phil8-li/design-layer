#!/usr/bin/env node
/**
 * Fails when the lockfile pins a package the registry npm installs from does
 * not serve.
 *
 *   node tools/check-registry.mjs                 # entries changed since origin/main
 *   node tools/check-registry.mjs --base <ref>    # entries changed since <ref>
 *   node tools/check-registry.mjs --all           # every entry
 *
 * The lockfile names registry.npmjs.org, and npm swaps that host for the
 * registry it is configured with when it installs. A company mirror can lag a
 * release by weeks: one served a version published 26 days earlier and not
 * one published 19 days earlier. A lockfile that pins a version the mirror
 * lacks makes `npm ci` fail for everyone who installs through it, and the
 * updater runs `npm ci`: it rolls back, and every later update fails the same
 * way until the mirror catches up. Dependency bots open exactly those
 * lockfiles. So `npm run verify` runs this before a dependency change ships.
 *
 * Only the entries that changed, by default, so a run costs a few requests
 * rather than one per package. A registry that does not answer at all, or no
 * base to compare with, is reported and skipped: that machine could not
 * install the lockfile either way, and npm says so itself.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PUBLIC_REGISTRY = "https://registry.npmjs.org/"

/**
 * The downloadable entries of `after` that `before` does not have, one per
 * tarball. A `link`, a folder or a git dependency has no tarball to ask for.
 */
export function changedTarballs(before, after) {
  const known = new Set(Object.values(before?.packages ?? {}).map((entry) => entry?.resolved))
  const changed = new Map()
  for (const [where, entry] of Object.entries(after?.packages ?? {})) {
    const resolved = entry?.resolved
    if (typeof resolved !== "string" || !/^https?:\/\//.test(resolved) || known.has(resolved)) continue
    const name = entry.name ?? where.slice(where.lastIndexOf("node_modules/") + "node_modules/".length)
    if (!changed.has(resolved)) changed.set(resolved, { name, version: entry.version, resolved })
  }
  return [...changed.values()]
}

/**
 * Where npm fetches `resolved` from, given its configured registry. npm
 * replaces the public registry's host and leaves every other host alone
 * (`replace-registry-host`, whose default is "npmjs").
 */
export function onRegistry(resolved, registry) {
  if (!registry || !resolved.startsWith(PUBLIC_REGISTRY)) return resolved
  const base = registry.endsWith("/") ? registry : `${registry}/`
  return base + resolved.slice(PUBLIC_REGISTRY.length)
}

/**
 * Asks the registry for each tarball. Answers the ones it does not serve, or
 * `{ unreachable }` when it answers nothing at all.
 */
export async function missingTarballs(tarballs, registry, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const missing = []
  let answered = 0
  let failure = null
  for (const tarball of tarballs) {
    const url = onRegistry(tarball.resolved, registry)
    try {
      const response = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
      answered += 1
      if (!response.ok) missing.push({ ...tarball, url, status: response.status })
    } catch (error) {
      failure ??= error
    }
  }
  if (tarballs.length && !answered) return { missing: [], unreachable: failure?.message ?? "no answer" }
  return { missing, unreachable: null }
}

function configuredRegistry() {
  // `npm run` hands its configuration to scripts; run by hand, npm is asked.
  if (process.env.npm_config_registry) return process.env.npm_config_registry
  const asked = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["config", "get", "registry"], {
    encoding: "utf8",
  })
  return asked.status === 0 ? asked.stdout.trim() : PUBLIC_REGISTRY
}

function lockfileAt(root, ref) {
  const shown = spawnSync("git", ["show", `${ref}:package-lock.json`], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 })
  if (shown.status !== 0) return null
  try {
    return JSON.parse(shown.stdout)
  } catch {
    return null
  }
}

async function main(argv) {
  const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
  const after = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
  const all = argv.includes("--all")
  const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "origin/main"
  const before = all ? {} : lockfileAt(root, base)
  if (!before) {
    console.log(`SKIPPED registry check — no lockfile at ${base} to compare with (pass --all to check every entry)`)
    return 0
  }
  const registry = configuredRegistry()
  const tarballs = changedTarballs(before, after)
  if (!tarballs.length) {
    console.log(`PASS registry check — no lockfile entry changed since ${all ? "nothing" : base}`)
    return 0
  }
  const { missing, unreachable } = await missingTarballs(tarballs, registry)
  if (unreachable) {
    console.log(`SKIPPED registry check — ${registry} did not answer (${unreachable})`)
    return 0
  }
  if (missing.length) {
    console.error(`FAIL registry check — ${registry} does not serve ${missing.length} of the ${tarballs.length} changed lockfile entries:`)
    for (const entry of missing) console.error(`  ${entry.name}@${entry.version} (${entry.status})`)
    console.error("npm ci fails wherever npm installs from this registry. Pin the newest version it serves, or wait until it has these.")
    return 1
  }
  console.log(`PASS registry check — ${registry} serves all ${tarballs.length} changed lockfile entries`)
  return 0
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)))
}
