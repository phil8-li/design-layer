/**
 * Cases for tools/check-registry.mjs: a lockfile must only pin packages the
 * registry npm installs from can serve, and must only name the public
 * registry.
 *
 * A dependency bot bumped motion to a release a company npm mirror did not
 * have yet. Merged, `npm ci` would have failed for everyone installing through
 * that mirror, the updater included. The registry here is a local server, so
 * the suite runs offline.
 *
 * Usage: node designlayer/test/registry-check-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"

import { PACKAGE_DIR } from "./host.mjs"
import { changedTarballs, missingTarballs, onRegistry } from "../tools/check-registry.mjs"

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const tgz = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`
const lock = (entries) => ({
  lockfileVersion: 3,
  packages: {
    "": { name: "designlayer" },
    ...Object.fromEntries(entries.map(([where, version, extra = {}]) => [where, { version, resolved: tgz(where.split("node_modules/").pop(), version), ...extra }])),
  },
})

console.log("Which entries are asked for")

await check("only entries the base lockfile does not have, once per tarball", () => {
  const before = lock([["node_modules/motion", "14.0.0"], ["node_modules/react", "19.3.1"]])
  const after = lock([
    ["node_modules/motion", "14.9.0"],
    ["node_modules/react", "19.3.1"],
    ["node_modules/a/node_modules/motion", "14.9.0"],
    ["node_modules/@scope/pkg", "1.0.0"],
  ])
  after.packages["node_modules/local"] = { version: "1.0.0", resolved: "file:../local", link: true }
  assert.deepEqual(changedTarballs(before, after), [
    { name: "motion", version: "14.9.0", resolved: tgz("motion", "14.9.0") },
    { name: "@scope/pkg", version: "1.0.0", resolved: tgz("@scope/pkg", "1.0.0") },
  ])
})

await check("npm's host swap: the public registry's host becomes the configured one, any other host stays", () => {
  const mirror = "http://mirror.example:999/npm/proxy"
  assert.equal(onRegistry(tgz("motion", "14.9.0"), mirror), `${mirror}/motion/-/motion-14.9.0.tgz`)
  assert.equal(onRegistry(tgz("motion", "14.9.0"), `${mirror}/`), `${mirror}/motion/-/motion-14.9.0.tgz`)
  assert.equal(onRegistry(tgz("motion", "14.9.0"), "https://registry.npmjs.org/"), tgz("motion", "14.9.0"))
  const elsewhere = "https://npm.pkg.github.com/x/-/x-1.0.0.tgz"
  assert.equal(onRegistry(elsewhere, mirror), elsewhere)
})

console.log("\nWhat the registry serves")

const served = new Set(["/npm/motion/-/motion-14.9.0.tgz"])
const asked = []
const registry = http.createServer((req, res) => {
  asked.push(`${req.method} ${req.url}`)
  res.statusCode = served.has(req.url) ? 200 : 404
  res.end()
})
await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${registry.address().port}/npm`

await check("a version the registry lacks is named, with the answer it gave", async () => {
  const tarballs = [
    { name: "motion", version: "14.9.0", resolved: tgz("motion", "14.9.0") },
    { name: "motion", version: "14.14.0", resolved: tgz("motion", "14.14.0") },
  ]
  const { missing, unreachable } = await missingTarballs(tarballs, base)
  assert.equal(unreachable, null)
  assert.deepEqual(
    missing.map(({ name, version, status }) => `${name}@${version} ${status}`),
    ["motion@14.14.0 404"]
  )
  assert.deepEqual(asked, ["HEAD /npm/motion/-/motion-14.9.0.tgz", "HEAD /npm/motion/-/motion-14.14.0.tgz"], "it downloaded tarballs instead of asking")
})

await check("a registry that answers nothing is reported as unreachable, not as every package missing", async () => {
  const closed = http.createServer()
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve))
  const port = closed.address().port
  await new Promise((resolve) => closed.close(resolve))
  const { missing, unreachable } = await missingTarballs(
    [{ name: "motion", version: "14.9.0", resolved: tgz("motion", "14.9.0") }],
    `http://127.0.0.1:${port}/npm`
  )
  assert.deepEqual(missing, [])
  assert.ok(unreachable, "an unreachable registry passed as if it served everything")
})

registry.close()

console.log("\nThe lockfile and the verify step")

await check("every lockfile entry names the public registry, so a clone outside any company mirror installs", () => {
  const lockfile = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, "package-lock.json"), "utf8"))
  const elsewhere = Object.entries(lockfile.packages)
    .filter(([, entry]) => typeof entry.resolved === "string" && /^https?:/.test(entry.resolved))
    .filter(([, entry]) => !entry.resolved.startsWith("https://registry.npmjs.org/"))
    .map(([where, entry]) => `${where} → ${entry.resolved}`)
  assert.deepEqual(elsewhere, [], "a lockfile written through a mirror records the mirror's address")
})

await check("npm run verify runs the registry check", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"))
  assert.match(pkg.scripts.verify, /node tools\/check-registry\.mjs/)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
