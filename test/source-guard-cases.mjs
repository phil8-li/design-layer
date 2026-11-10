/**
 * The source-path guard (runtime/source-guard.mjs, re-exported by config.mjs):
 * which paths the server may read and write for the browser.
 *
 * Most of its behaviour is pinned where it is used (apply-source, component
 * usage, variants). These cases pin the containment test itself.
 *
 * Usage: node test/source-guard-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { isEditableSourcePath, resolveConfig, resolveEditableSource } from "../config.mjs"

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-guard-")))
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-guard-outside-")))
fs.mkdirSync(path.join(root, "src"))
for (const file of ["..root.tsx", "src/..notes.tsx", "src/ok.tsx", ".env.local", "next.config.ts"]) {
  fs.writeFileSync(path.join(root, file), "export {}\n")
}
fs.writeFileSync(path.join(outside, "x.tsx"), "export {}\n")

const config = resolveConfig({}, { cwd: root })

// `path.relative` of a file named `..notes.tsx` starts with two dots without
// climbing out of anything; only a `..` segment does.
check("a file whose name starts with two dots is inside the project", () => {
  assert.equal(resolveEditableSource(config, "..root.tsx"), path.join(root, "..root.tsx"))
  assert.equal(resolveEditableSource(config, "src/..notes.tsx"), path.join(root, "src", "..notes.tsx"))
  const scoped = resolveConfig({ source: { roots: ["src"] } }, { cwd: root })
  assert.equal(resolveEditableSource(scoped, "src/..notes.tsx"), path.join(root, "src", "..notes.tsx"))
})

check("a path that climbs out of the project is still refused", () => {
  const relative = path.relative(root, path.join(outside, "x.tsx"))
  assert.ok(relative.startsWith(`..${path.sep}`))
  assert.equal(resolveEditableSource(config, relative), null)
  assert.equal(resolveEditableSource(config, path.join(outside, "x.tsx")), null)
  assert.equal(isEditableSourcePath(config, path.join(outside, "x.tsx")), false)
})

check("env and config files are refused whatever the allowlist says", () => {
  const wide = resolveConfig({ source: { extensions: [".tsx", ".ts", ".local"] } }, { cwd: root })
  assert.equal(resolveEditableSource(wide, ".env.local"), null)
  assert.equal(resolveEditableSource(wide, "next.config.ts"), null)
  assert.equal(resolveEditableSource(wide, "src/ok.tsx"), path.join(root, "src", "ok.tsx"))
})

fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(outside, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
