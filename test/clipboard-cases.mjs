/**
 * Every Copy in the editor lands, wherever the editor runs.
 *
 * "Clipboard access blocked. Allow it for this site, then copy again" was the
 * editor's answer whenever `navigator.clipboard.writeText` refused. In the Mac
 * app, which shows every editor in an iframe, Chrome refuses that call for a
 * frame that does not hold focus, with no permission involved and nothing to
 * allow. `core/clipboard.ts` now owns the one write, with the copy command
 * behind the async API. These cases hold four things:
 *
 * THE FALLBACK. Every way the async API refuses (missing, throwing,
 * rejecting, withheld by permissions policy) still lands the exact text,
 * through `document.execCommand("copy")` with the text on the copy event.
 *
 * THE PAGE CANNOT HIJACK IT. The app's own `copy` handlers never see the event.
 *
 * THE GESTURE. The async write starts before `copyText` returns, inside the
 * caller's click task, where the activation both routes need still exists.
 *
 * ONE OWNER. Nothing else in `src/` touches `navigator.clipboard` or the copy
 * command, so a new Copy written the old way fails here instead of in front of
 * a designer.
 *
 * jsdom has neither the Clipboard API nor the copy command, so both are stubbed
 * the way Chrome runs them. `tools/clipboard-e2e.mjs` runs the real engine.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

const dom = new JSDOM("<!doctype html><html><body><main id=app></main></body></html>", {
  url: "http://localhost/",
})
const { window } = dom
for (const key of ["window", "document", "navigator", "Event"]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `export { copyText, COPY_REFUSED } from "./src/core/clipboard"`,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const { copyText, COPY_REFUSED } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

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

const TEXT = "## Page Feedback\n\n\t**Source:** src/a.tsx:12 — ünïcode ✓\n```css\n.a { gap: 8px }\n```\n"

/** The Clipboard API in one of its states. */
function asyncApi(behaviour) {
  const calls = []
  const writeText = (text) => {
    calls.push(text)
    if (behaviour === "resolve") return Promise.resolve()
    if (behaviour === "throw") throw new window.DOMException("Clipboard is unavailable", "NotAllowedError")
    return Promise.reject(new window.DOMException("Document is not focused.", "NotAllowedError"))
  }
  Object.defineProperty(window.navigator, "clipboard", {
    value: behaviour === "missing" ? undefined : { writeText },
    configurable: true,
  })
  return calls
}

/**
 * The copy command, run the way Chrome runs it: `beforecopy` decides whether it
 * is enabled when nothing is selected, then `copy` carries a writable
 * DataTransfer, and whatever was set on it when the event was cancelled is what
 * reaches the clipboard. `runs` false is an engine that has no command.
 */
function copyCommand({ runs = true, reachesWindow = true } = {}) {
  const state = { calls: 0, clipboard: null }
  if (!runs) {
    delete window.document.execCommand
    return state
  }
  window.document.execCommand = (command) => {
    state.calls += 1
    if (command !== "copy") return false
    const before = new window.Event("beforecopy", { bubbles: true, cancelable: true })
    window.document.body.dispatchEvent(before)
    if (!before.defaultPrevented) return false
    const data = new Map()
    const copy = new window.Event("copy", { bubbles: true, cancelable: true })
    copy.clipboardData = { setData: (type, value) => data.set(type, value) }
    if (reachesWindow) window.document.body.dispatchEvent(copy)
    if (copy.defaultPrevented) state.clipboard = data.get("text/plain") ?? null
    return true
  }
  return state
}

function resetPolicy() {
  delete window.document.featurePolicy
  delete window.document.permissionsPolicy
}

console.log("\nThe async API, when it works")

await check("it is the only route used, and the answer is true", async () => {
  resetPolicy()
  const writes = asyncApi("resolve")
  const command = copyCommand()
  assert.equal(await copyText(TEXT), true)
  assert.deepEqual(writes, [TEXT])
  assert.equal(command.calls, 0, "the copy command ran behind a write that worked")
})

await check("the write starts before copyText returns, inside the click task", () => {
  const writes = asyncApi("resolve")
  copyCommand()
  void copyText(TEXT)
  assert.deepEqual(writes, [TEXT], "nothing was written synchronously")
})

console.log("\nEvery refusal still lands the text")

for (const [state, why] of [
  ["reject", "Chrome in an unfocused frame, which is the Mac app"],
  ["throw", "an engine that throws instead of rejecting"],
  ["missing", "a page on an origin that is not secure, such as a LAN address"],
]) {
  await check(`a Clipboard API that is ${state === "missing" ? "missing" : `${state}ing`}: ${why}`, async () => {
    resetPolicy()
    asyncApi(state)
    const command = copyCommand()
    assert.equal(await copyText(TEXT), true)
    assert.equal(command.clipboard, TEXT, "the copy command carried different text, or none")
  })
}

await check("a frame without clipboard-write delegated skips the async API entirely", async () => {
  // Chrome logs a permissions-policy violation for every refused call, so the
  // async API is not asked when the policy already says no.
  window.document.featurePolicy = { allowsFeature: (feature) => feature !== "clipboard-write" }
  const writes = asyncApi("resolve")
  const command = copyCommand()
  assert.equal(await copyText(TEXT), true)
  assert.deepEqual(writes, [], "the async API was asked under a policy that forbids it")
  assert.equal(command.clipboard, TEXT)
  resetPolicy()
})

await check("the newer permissionsPolicy name is read too", async () => {
  window.document.permissionsPolicy = { allowsFeature: () => false }
  const writes = asyncApi("resolve")
  const command = copyCommand()
  assert.equal(await copyText(TEXT), true)
  assert.deepEqual(writes, [])
  assert.equal(command.clipboard, TEXT)
  resetPolicy()
})

console.log("\nThe page cannot change what lands")

await check("the app's own copy handler never sees the event", async () => {
  asyncApi("reject")
  const command = copyCommand()
  let hijacks = 0
  const hijack = (event) => {
    hijacks += 1
    event.clipboardData.setData("text/plain", "THE APP'S TEXT")
    event.preventDefault()
  }
  window.document.addEventListener("copy", hijack, true)
  window.document.body.addEventListener("copy", hijack)
  try {
    assert.equal(await copyText(TEXT), true)
    assert.equal(command.clipboard, TEXT)
    assert.equal(hijacks, 0, "an app listener ran on the editor's copy")
  } finally {
    window.document.removeEventListener("copy", hijack, true)
    window.document.body.removeEventListener("copy", hijack)
  }
})

await check("nothing is left listening after a copy", async () => {
  asyncApi("reject")
  copyCommand()
  await copyText(TEXT)
  // A copy the user makes afterwards, with ⌘C, is theirs alone.
  const theirs = new window.Event("copy", { bubbles: true, cancelable: true })
  theirs.clipboardData = { setData: () => assert.fail("the editor wrote into the user's own copy") }
  window.document.body.dispatchEvent(theirs)
  assert.equal(theirs.defaultPrevented, false)
  const before = new window.Event("beforecopy", { bubbles: true, cancelable: true })
  window.document.body.dispatchEvent(before)
  assert.equal(before.defaultPrevented, false)
})

console.log("\nA real refusal is answered, never thrown")

await check("no copy command at all answers false", async () => {
  asyncApi("reject")
  copyCommand({ runs: false })
  assert.equal(await copyText(TEXT), false)
})

await check("a command that runs but never reaches our listener answers false", async () => {
  // Something earlier on window capture stopped the event: the command ran, but
  // our text was never set, so "it ran" is not "it landed".
  asyncApi("missing")
  copyCommand({ reachesWindow: false })
  assert.equal(await copyText(TEXT), false)
})

await check("a command that throws answers false", async () => {
  asyncApi("missing")
  window.document.execCommand = () => {
    throw new Error("SecurityError")
  }
  assert.equal(await copyText(TEXT), false)
  delete window.document.execCommand
})

await check("the refusal sentence says what happened and what to do, and nothing untrue", () => {
  assert.equal(COPY_REFUSED, "Could not copy to the clipboard. Try again")
  assert.doesNotMatch(COPY_REFUSED, /allow|permission|setting/i, "it sends the designer looking for a setting")
})

console.log("\nOne owner")

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [full] : []
  })
}
const SRC = path.join(PACKAGE_DIR, "src")
const OWNER = path.join(SRC, "core", "clipboard.ts")

await check("nothing in src/ but core/clipboard.ts touches the clipboard", () => {
  const offenders = []
  for (const file of sources(SRC)) {
    if (file === OWNER) continue
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/navigator\s*\.\s*clipboard|execCommand\s*\(|\.clipboardData\b/.test(line)) {
          offenders.push(`${path.relative(PACKAGE_DIR, file)}:${index + 1}: ${line.trim()}`)
        }
      })
  }
  assert.deepEqual(offenders, [], `copy through copyText() in src/core/clipboard.ts instead:\n${offenders.join("\n")}`)
})

await check("the old sentence, and its advice to allow a setting, is gone", () => {
  // The owner quotes it once, in the history at its top; COPY_REFUSED is pinned above.
  const offenders = sources(SRC).filter(
    (file) => file !== OWNER && /Clipboard access blocked|Allow it for this site/.test(fs.readFileSync(file, "utf8"))
  )
  assert.deepEqual(offenders.map((file) => path.relative(PACKAGE_DIR, file)), [])
})

await check("every Copy surface goes through copyText", () => {
  const surfaces = [
    "src/annotations/handover.ts",
    "src/core/change-prompt.ts",
    "src/libraries/snippet.ts",
    "src/panels/inspector/section-classes.ts",
    "src/panels/inspector/tab-annotations.ts",
    "src/panels/inspector/tab-code.ts",
  ]
  const missing = surfaces.filter(
    (file) => !/\bcopyText\(/.test(fs.readFileSync(path.join(PACKAGE_DIR, file), "utf8"))
  )
  assert.deepEqual(missing, [])
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
