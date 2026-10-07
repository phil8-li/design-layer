/**
 * The browser half of variant loading: how often it asks the server.
 *
 * The Instance section calls `loadVariants` on every render while nothing is
 * loaded for the selection's file, and it renders on every commit, refresh and
 * nudge frame. A failed answer used to be forgotten at once, so a route that
 * answered 404 or 500 was asked again on every one of those frames. A failure
 * now stands for a retry window; a success is cached for good.
 *
 * Usage: node test/variant-client-cases.mjs
 */

import assert from "node:assert/strict"

import { PACKAGE_DIR } from "./host.mjs"

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

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `export { loadVariants, loadedVariants } from "./src/core/variants"`,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "silent",
})
const { loadVariants, loadedVariants } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

const API = "/__designlayer"
let requests = 0
let answer = { ok: false, status: 500, json: async () => ({}) }
globalThis.fetch = async () => {
  requests += 1
  return answer
}
const realNow = Date.now
let clock = 1_000_000
Date.now = () => clock

console.log("\nVariant requests")

await check("a failure is not re-asked on the next render", async () => {
  requests = 0
  assert.deepEqual(await loadVariants(API, "src/Failing.tsx"), [])
  assert.deepEqual(await loadVariants(API, "src/Failing.tsx"), [])
  assert.deepEqual(await loadVariants(API, "src/Failing.tsx"), [])
  assert.equal(requests, 1, `${requests} requests for one failing file inside the window`)
  // Still unanswered, so the section keeps showing nothing rather than "none".
  assert.equal(loadedVariants("src/Failing.tsx"), null)
})

await check("a failure is asked again once the window has passed", async () => {
  requests = 0
  clock += 10_001
  answer = {
    ok: true,
    status: 200,
    json: async () => ({ declarations: [{ name: "buttonVariants", recognizer: "cva", axes: [] }] }),
  }
  const loaded = await loadVariants(API, "src/Failing.tsx")
  assert.equal(requests, 1)
  assert.equal(loaded.length, 1)
})

await check("a success is cached and never asked again", async () => {
  requests = 0
  clock += 60_000
  await loadVariants(API, "src/Failing.tsx")
  assert.equal(requests, 0)
  assert.equal(loadedVariants("src/Failing.tsx")?.length, 1)
})

await check("concurrent asks share one request", async () => {
  requests = 0
  answer = { ok: true, status: 200, json: async () => ({ declarations: [] }) }
  await Promise.all([loadVariants(API, "src/Other.tsx"), loadVariants(API, "src/Other.tsx")])
  assert.equal(requests, 1)
  assert.deepEqual(loadedVariants("src/Other.tsx"), [])
})

Date.now = realNow
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
