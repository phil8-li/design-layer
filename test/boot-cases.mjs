/**
 * The boot, as tools and agents see it, and the two bridge facts it rests on.
 *
 * `src/index.ts` publishes one phase (`window.__designlayer.boot`, with a
 * `designlayer:boot` event at each move) instead of leaving tools to wait for
 * a console line. These cases drive the real entry point in jsdom down its
 * waiting → slow → failed path, which is the one a page can reach without a
 * vendor: the host claims the page, the bridge never installs, and the clock
 * is pushed past the bridge's ten seconds.
 *
 * The bridge cases pin the source-resolution cache rule (a transient `null`
 * is never remembered) and the bridge timeout.
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

const dom = new JSDOM(
  "<!doctype html><html><head></head><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "AbortController",
  "AbortSignal",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
for (const key of ["addEventListener", "removeEventListener", "getComputedStyle", "dispatchEvent"]) {
  Object.defineProperty(globalThis, key, { value: window[key].bind(window), configurable: true, writable: true })
}

const { build } = await import("esbuild")
const bundle = async (contents) => {
  const out = await build({
    stdin: { contents, resolveDir: PACKAGE_DIR, loader: "ts" },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`)
}

let passed = 0
let failed = 0
async function check(name, run) {
  try {
    await run()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const bridgeModule = await bundle(
  `export { resolveElementSource, whenBridgeReady, memoizeNonNull } from "./src/core/bridge"`
)

/*
 * B-boot-state-4. The vendor's `discoverFile` answers `null` after a timeout
 * when its socket is down (a dev server restart). That `null` was cached per
 * component for the life of the page, so the component never resolved again.
 */
await check("a grep that came back empty is asked again, and its answer is then kept", async () => {
  const answers = [null, "src/components/Card.tsx"]
  let asked = 0
  const bridge = {
    elementInfo: () => ({ tagName: "div", componentName: "Card", filePath: "", lineNumber: 0, columnNumber: 0, stack: [] }),
    discoverFile: async () => answers[Math.min(asked++, answers.length - 1)],
  }
  const element = window.document.createElement("div")
  window.document.body.append(element)
  assert.equal(await bridgeModule.resolveElementSource(bridge, element), null)
  const second = await bridgeModule.resolveElementSource(bridge, element)
  assert.equal(second?.filePath, "src/components/Card.tsx", "the first empty answer was remembered")
  assert.equal(asked, 2)
  // A found file is remembered: no third grep.
  const other = window.document.createElement("div")
  window.document.body.append(other)
  assert.equal((await bridgeModule.resolveElementSource(bridge, other))?.filePath, "src/components/Card.tsx")
  assert.equal(asked, 2, "a found path was not cached for the component")
  element.remove()
  other.remove()
})

await check("the cache forgets a rejection as it forgets a null, and keeps an answer", async () => {
  const cache = new Map()
  let calls = 0
  const flaky = () => {
    calls += 1
    if (calls === 1) throw new Error("socket closed")
    return Promise.resolve(calls === 2 ? null : "answer")
  }
  assert.equal(await bridgeModule.memoizeNonNull(cache, "k", flaky), null)
  assert.equal(cache.has("k"), false, "a rejection stayed cached")
  assert.equal(await bridgeModule.memoizeNonNull(cache, "k", flaky), null)
  assert.equal(cache.has("k"), false, "a null stayed cached")
  assert.equal(await bridgeModule.memoizeNonNull(cache, "k", flaky), "answer")
  assert.equal(await bridgeModule.memoizeNonNull(cache, "k", flaky), "answer")
  assert.equal(calls, 3)
})

/*
 * The clock, pushed forward on demand. The bridge's poll and the host's wait
 * both measure elapsed time; jumping it is how a ten-second timeout is
 * reached in a few frames.
 */
const realNow = Date.now
let skew = 0
Date.now = () => realNow() + skew

await check("a bridge that never installs fails after its ten seconds, not before", async () => {
  delete window.__DESIGNLAYER_BRIDGE__
  const waiting = bridgeModule.whenBridgeReady()
  let settled = false
  waiting.catch(() => {}).finally(() => (settled = true))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(settled, false, "the bridge gave up early")
  skew += 11_000
  await assert.rejects(waiting, /bridge never installed/)
  skew = 0
})

/*
 * The entry point itself. The host claims the page at once (a React expando
 * on the app's root), the bridge never installs, so the boot waits, says so
 * after 1.2 s, and fails when the clock passes the bridge's ten seconds.
 */
await check("the boot publishes waiting, then slow, then failed, as one value tools can read", async () => {
  const seen = []
  window.addEventListener("designlayer:boot", (event) => seen.push(event.detail))
  Object.defineProperty(window.document.getElementById("root"), "__reactFiber$fixture", { value: {} })
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args.join(" "))
  try {
    await bundle(`import "./src/index"`)
    assert.equal(window.__designlayer?.boot, "waiting")
    await new Promise((resolve) => setTimeout(resolve, 1400))
    assert.equal(window.__designlayer?.boot, "slow", "the wait passed 1.2 s without saying so")
    skew += 11_000
    for (let i = 0; i < 20 && window.__designlayer?.boot !== "failed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(window.__designlayer?.boot, "failed")
    assert.deepEqual(seen, ["waiting", "slow", "failed"])
    assert.ok(warnings.some((line) => /bridge never installed/.test(line)), "the failure was not logged")
  } finally {
    console.warn = warn
    skew = 0
  }
})

Date.now = realNow
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
