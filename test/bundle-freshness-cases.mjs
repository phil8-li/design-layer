/**
 * What the browser is served has to be what `src/` compiles to.
 *
 * `dist/` is gitignored and the launcher reads it off disk, so the two can drift
 * apart without a single check failing: the editor runs commits behind its own
 * source, the reviewed feature is simply absent, and nothing says a word. These
 * cases pin the behaviour that makes that impossible — not how it is detected.
 *
 * The real `dist/designlayer.js` is what the launcher serves, so it is what
 * gets damaged here. It is copied into a temp directory first and put back in a
 * `finally`, and the successful path leaves behind a bundle freshly built from
 * the current source, which is the state the repo wants anyway.
 *
 * Usage: node designlayer/test/bundle-freshness-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import { PACKAGE_DIR } from "./host.mjs"
import * as launcher from "../runtime/launcher.mjs"

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

const BUNDLE = path.join(PACKAGE_DIR, "dist", "designlayer.js")

/** Everything the launcher would have printed, as one string. */
function capture(fn) {
  const lines = []
  const record = (...args) => lines.push(args.join(" "))
  const { log, warn, error } = console
  Object.assign(console, { log: record, warn: record, error: record })
  try {
    fn()
  } finally {
    Object.assign(console, { log, warn, error })
  }
  return lines.join("\n")
}

const build = () =>
  assert.equal(
    spawnSync(process.execPath, [path.join(PACKAGE_DIR, "build.mjs")], {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
    }).status,
    0,
    "the fixture depends on `node build.mjs` succeeding"
  )

build()
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-bundle-"))
const current = path.join(scratch, "designlayer.js")
fs.copyFileSync(BUNDLE, current)

try {
  console.log("\nFresh")

  check("a bundle built from the current source is served without a word", () => {
    assert.equal(capture(() => launcher.ensureCurrentChromeBundle()), "")
  })

  console.log("\nBehind")

  check("a bundle older than its source is rebuilt before it is served", () => {
    fs.writeFileSync(BUNDLE, "/* two commits ago */\n")
    capture(() => launcher.ensureCurrentChromeBundle())
    // Read back through the function the overlay concatenation calls, rather
    // than off the file: what the browser gets is the only thing worth pinning.
    assert.equal(launcher.readChromeBundle(), fs.readFileSync(current, "utf8"))
  })

  check("and the rebuild is announced, because the source moved", () => {
    fs.writeFileSync(BUNDLE, "/* two commits ago */\n")
    const output = capture(() => launcher.ensureCurrentChromeBundle())
    assert.match(output, /dist\/ was behind src\//)
  })

  check("what it rebuilds satisfies its own next check", () => {
    assert.equal(capture(() => launcher.ensureCurrentChromeBundle()), "")
  })

  console.log("\nMissing")

  check("a bundle that is not there at all still says so at read time", () => {
    fs.rmSync(BUNDLE)
    let served
    const output = capture(() => {
      served = launcher.readChromeBundle()
    })
    assert.equal(served, "")
    assert.match(output, /chrome bundle missing/)
  })
} finally {
  fs.copyFileSync(current, BUNDLE)
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
