/**
 * The editor's notes are kept for the machine, not for one browser origin.
 *
 * localStorage belongs to an origin, and the editor's page has several: each
 * app's editor on its own port, the same editor as `localhost` and as
 * `127.0.0.1`, and the Mac app as a browser profile of its own. Moving the page
 * to another port hid every saved note. So every scoped change is copied to the
 * editor's server (`runtime/app-storage.mjs`, behind `<prefix>/storage`), and
 * the page copies the store back before its first read (`hydrateScoped`).
 *
 * Three layers, each checked where it can fail: the store on disk, the route
 * over a real loopback socket (the guard reads the socket), and the browser
 * half in jsdom with `fetch` pointed at that socket, so two "origins" talk to
 * one real server.
 *
 * Offline and fast: an ephemeral port and a temporary HOME.
 *
 * Usage: node test/app-storage-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-storage-home-")))
process.env.HOME = home

const storage = await import("../runtime/app-storage.mjs")
const { resolveConfig } = await import("../config.mjs")
const { createDesignLayerRoutes } = await import("../server/routes.mjs")

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

function clearStore() {
  fs.rmSync(storage.storageDir(), { recursive: true, force: true })
}

const NOTES = "designlayer.annotations.http-127-0-0-1-3000:/pricing"

// ── The store on disk ──────────────────────────────────────────────────────

console.log("\nThe machine store")

await check("a merged entry is one file under ~/.local/state/designlayer/storage", () => {
  clearStore()
  const result = storage.mergeEntries([{ key: NOTES, value: "[1]", updatedAt: 10 }])
  assert.deepEqual(result, { accepted: 1, rejected: 0 })
  assert.equal(storage.storageDir(), path.join(home, ".local", "state", "designlayer", "storage"))
  const files = fs.readdirSync(storage.storageDir())
  assert.equal(files.length, 1)
  assert.ok(files[0].endsWith(".json"), `left a temporary file: ${files[0]}`)
  assert.deepEqual(storage.readEntries(), [{ key: NOTES, value: "[1]", updatedAt: 10, deleted: false }])
})

await check("the newer write wins, an older or equal one is ignored", () => {
  clearStore()
  storage.mergeEntries([{ key: NOTES, value: "new", updatedAt: 20 }])
  assert.equal(storage.mergeEntries([{ key: NOTES, value: "old", updatedAt: 19 }]).accepted, 0)
  assert.equal(storage.mergeEntries([{ key: NOTES, value: "tie", updatedAt: 20 }]).accepted, 0)
  assert.equal(storage.readEntries()[0].value, "new")
  storage.mergeEntries([{ key: NOTES, value: "newer", updatedAt: 21 }])
  assert.equal(storage.readEntries()[0].value, "newer")
})

await check("a removal is kept as a tombstone that beats an older copy", () => {
  clearStore()
  storage.mergeEntries([{ key: NOTES, value: "x", updatedAt: 5 }])
  storage.mergeEntries([{ key: NOTES, value: "ignored", updatedAt: 6, deleted: true }])
  assert.deepEqual(storage.readEntries(), [{ key: NOTES, value: null, updatedAt: 6, deleted: true }])
  assert.equal(storage.mergeEntries([{ key: NOTES, value: "stale", updatedAt: 4 }]).accepted, 0)
  assert.equal(storage.readEntries()[0].deleted, true)
})

await check("keys outside designlayer., oversized values and bad clocks are refused", () => {
  clearStore()
  const result = storage.mergeEntries([
    { key: "other.notes", value: "x", updatedAt: 1 },
    { key: `designlayer.${"k".repeat(storage.MAX_KEY_LENGTH)}`, value: "x", updatedAt: 1 },
    { key: NOTES, value: "x".repeat(storage.MAX_VALUE_LENGTH + 1), updatedAt: 1 },
    { key: NOTES, value: "x", updatedAt: Number.NaN },
    { key: NOTES, value: "x", updatedAt: 0 },
    { key: NOTES, value: 42, updatedAt: 1 },
    null,
  ])
  assert.deepEqual(result, { accepted: 0, rejected: 7 })
  assert.deepEqual(storage.readEntries(), [])
})

await check("past the size bound the oldest entries are dropped first", () => {
  clearStore()
  const big = "v".repeat(storage.MAX_VALUE_LENGTH - 1024)
  const count = Math.ceil(storage.MAX_TOTAL_BYTES / big.length) + 3
  for (let index = 0; index < count; index += 1) {
    storage.mergeEntries([{ key: `designlayer.preview-only.app:/p${index}`, value: big, updatedAt: 100 + index }])
  }
  const kept = storage.readEntries().map((entry) => entry.updatedAt).sort((a, b) => a - b)
  assert.ok(kept.length < count, "nothing was dropped")
  assert.equal(kept.at(-1), 100 + count - 1, "the newest entry was dropped")
  assert.ok(kept[0] > 100, "the oldest entry survived")
  const total = fs
    .readdirSync(storage.storageDir())
    .reduce((sum, name) => sum + fs.statSync(path.join(storage.storageDir(), name)).size, 0)
  assert.ok(total <= storage.MAX_TOTAL_BYTES, `kept ${total} bytes`)
})

await check("an unwritable store answers empty and never throws", () => {
  clearStore()
  fs.mkdirSync(path.dirname(storage.storageDir()), { recursive: true })
  fs.writeFileSync(storage.storageDir(), "not a directory")
  try {
    assert.deepEqual(storage.mergeEntries([{ key: NOTES, value: "x", updatedAt: 1 }]), { accepted: 0, rejected: 0 })
    assert.deepEqual(storage.readEntries(), [])
    assert.deepEqual(storage.mergeEntries("nonsense"), { accepted: 0, rejected: 0 })
  } finally {
    fs.rmSync(storage.storageDir(), { force: true })
  }
})

// ── The route ──────────────────────────────────────────────────────────────

console.log("\nThe storage route")

const config = resolveConfig({ ports: { mcp: null } })
const routes = createDesignLayerRoutes(config)
const listener = http.createServer((request, response) => {
  if (routes.handle(request, response)) return
  response.writeHead(404).end()
})
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${listener.address().port}`
const storageUrl = `${base}${config.apiPrefix}/storage`

const postJson = (body, headers = { "content-type": "application/json" }) =>
  fetch(storageUrl, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) })

await check("GET lists entries and POST merges last-write-wins", async () => {
  clearStore()
  let response = await postJson({ entries: [{ key: NOTES, value: "a", updatedAt: 50 }] })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).accepted, 1)
  await postJson({ entries: [{ key: NOTES, value: "older", updatedAt: 40 }] })
  response = await fetch(storageUrl)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    entries: [{ key: NOTES, value: "a", updatedAt: 50, deleted: false }],
  })
})

await check("a POST that is not JSON is refused with 415", async () => {
  const response = await postJson(JSON.stringify({ entries: [] }), { "content-type": "text/plain" })
  assert.equal(response.status, 415)
})

await check("a POST without an entries list is refused with 400", async () => {
  assert.equal((await postJson({ nope: true })).status, 400)
  assert.equal((await postJson("{not json")).status, 400)
})

await check("the route is loopback-only like every other", async () => {
  const response = await fetch(storageUrl, { headers: { origin: "http://evil.example" } })
  assert.equal(response.status, 403)
})

// ── The browser half ───────────────────────────────────────────────────────

console.log("\nThe page")

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `export { writeScoped, dropScoped, readScoped, flushScoped, hydrateScoped, isSyncedKey } from "./src/core/app-scope"`,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "silent",
})

/** One browser origin. Its own localStorage, as a real one would have. */
function origin(url) {
  return new JSDOM("<!doctype html><html><body></body></html>", { url }).window
}

function use(window) {
  globalThis.window = window
}

const realFetch = globalThis.fetch
let fetchMode = "server"
let requests = []
globalThis.fetch = (input, init = {}) => {
  requests.push({ url: String(input), method: init.method ?? "GET", body: init.body })
  if (fetchMode === "stall") {
    return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
  }
  if (fetchMode === "down") return Promise.reject(new Error("connection refused"))
  // The page's own origin would answer a relative URL; here the one server does.
  const { cache: _cache, ...rest } = init
  return realFetch(`${base}${input}`, rest)
}

const oldOrigin = origin("http://127.0.0.1:3456/pricing")
const newOrigin = origin("http://localhost:3458/pricing")
use(oldOrigin)
const scope = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

const serverValue = (key) => storage.readEntries().find((entry) => entry.key === key) ?? null
const meta = (window) => JSON.parse(window.localStorage.getItem("designlayer.storage-meta") ?? "{}")

await check("a write lands in localStorage at once and on the server after the debounce", async () => {
  clearStore()
  use(newOrigin)
  scope.writeScoped(NOTES, "[\"n1\"]")
  assert.equal(newOrigin.localStorage.getItem(NOTES), "[\"n1\"]", "the local write was not synchronous")
  assert.equal(serverValue(NOTES), null, "sent before the debounce")
  await new Promise((resolve) => setTimeout(resolve, 400))
  const entry = serverValue(NOTES)
  assert.equal(entry?.value, "[\"n1\"]")
  assert.equal(entry.updatedAt, meta(newOrigin)[NOTES], "the server and the page disagree on when")
})

await check("the running-apps cache stays in the page", async () => {
  requests = []
  scope.writeScoped("designlayer.running-apps", "{}")
  await scope.flushScoped()
  assert.equal(requests.length, 0)
  assert.equal(scope.isSyncedKey("designlayer.running-apps"), false)
  assert.equal(newOrigin.localStorage.getItem("designlayer.running-apps"), "{}")
})

await check("a removal goes to the server as a tombstone", async () => {
  scope.dropScoped(NOTES)
  await scope.flushScoped()
  assert.equal(newOrigin.localStorage.getItem(NOTES), null)
  assert.equal(serverValue(NOTES)?.deleted, true)
  assert.equal(typeof meta(newOrigin)[NOTES], "number", "the removal was not tracked")
})

await check("another origin hydrates notes written elsewhere, and applies removals", async () => {
  clearStore()
  const other = origin("http://localhost:3460/pricing")
  use(newOrigin)
  scope.writeScoped(NOTES, "[\"shared\"]")
  await scope.flushScoped()
  use(other)
  await scope.hydrateScoped()
  assert.equal(other.localStorage.getItem(NOTES), "[\"shared\"]")
  use(newOrigin)
  scope.dropScoped(NOTES)
  await scope.flushScoped()
  use(other)
  await scope.hydrateScoped()
  assert.equal(other.localStorage.getItem(NOTES), null, "the removal did not reach the other origin")
})

await check("a newer local copy goes up and a newer server copy comes down", async () => {
  clearStore()
  const key = "designlayer.preview-only.app:/a"
  use(newOrigin)
  newOrigin.localStorage.setItem(key, "local")
  newOrigin.localStorage.setItem("designlayer.storage-meta", JSON.stringify({ ...meta(newOrigin), [key]: 500 }))
  storage.mergeEntries([{ key, value: "server", updatedAt: 400 }])
  await scope.hydrateScoped()
  await scope.flushScoped()
  assert.equal(serverValue(key).value, "local")
  storage.mergeEntries([{ key, value: "server-newer", updatedAt: 900 }])
  await scope.hydrateScoped()
  assert.equal(newOrigin.localStorage.getItem(key), "server-newer")
  assert.equal(meta(newOrigin)[key], 900)
})

await check("notes saved on an old origin before this version reach the server and a new origin", async () => {
  clearStore()
  const legacyKey = "designlayer.annotations.http-127-0-0-1-3000:/legacy"
  // Written by an older build: no tracking entry at all.
  oldOrigin.localStorage.setItem(legacyKey, JSON.stringify([{ id: "old-1" }]))
  use(oldOrigin)
  await scope.hydrateScoped()
  await scope.flushScoped()
  assert.equal(serverValue(legacyKey)?.value, JSON.stringify([{ id: "old-1" }]))
  const fresh = origin("http://localhost:3462/legacy")
  use(fresh)
  await scope.hydrateScoped()
  assert.equal(fresh.localStorage.getItem(legacyKey), JSON.stringify([{ id: "old-1" }]))
  // Any later edit outranks the migrated copy.
  scope.writeScoped(legacyKey, "[]")
  await scope.flushScoped()
  use(oldOrigin)
  await scope.hydrateScoped()
  assert.equal(oldOrigin.localStorage.getItem(legacyKey), "[]")
})

await check("old-origin notes meeting newer notes for the same page keep both", async () => {
  clearStore()
  const key = "designlayer.annotations.http-127-0-0-1-3000:/both"
  storage.mergeEntries([{ key, value: JSON.stringify([{ id: "new-1" }]), updatedAt: Date.now() }])
  const legacy = origin("http://127.0.0.1:3456/both")
  legacy.localStorage.setItem(key, JSON.stringify([{ id: "old-1" }, { id: "new-1" }]))
  use(legacy)
  await scope.hydrateScoped()
  await scope.flushScoped()
  const expected = JSON.stringify([{ id: "old-1" }, { id: "new-1" }])
  assert.equal(legacy.localStorage.getItem(key), expected)
  assert.equal(serverValue(key).value, expected)
})

await check("a stalled server is given up on after the wait, leaving local storage as it was", async () => {
  use(newOrigin)
  newOrigin.localStorage.setItem("designlayer.preview-only.app:/stall", "kept")
  fetchMode = "stall"
  try {
    const started = Date.now()
    await scope.hydrateScoped(150)
    const took = Date.now() - started
    assert.ok(took >= 140 && took < 1000, `waited ${took} ms`)
    assert.equal(newOrigin.localStorage.getItem("designlayer.preview-only.app:/stall"), "kept")
  } finally {
    fetchMode = "server"
  }
})

await check("a server that is down costs nothing but the copy", async () => {
  fetchMode = "down"
  try {
    await scope.hydrateScoped()
    scope.writeScoped("designlayer.preview-only.app:/down", "local")
    await scope.flushScoped()
    assert.equal(newOrigin.localStorage.getItem("designlayer.preview-only.app:/down"), "local")
  } finally {
    fetchMode = "server"
  }
})

await check("the editor hydrates before it creates the context", () => {
  const source = fs.readFileSync(path.join(PACKAGE_DIR, "src", "index.ts"), "utf8")
  const started = source.indexOf("const hydrated = hydrateScoped()")
  const awaited = source.indexOf("await hydrated")
  const created = source.indexOf("const context = createContext(")
  assert.ok(started > 0 && started < source.indexOf("await whenHostHydrated()"), "hydration is not started first")
  assert.ok(awaited > 0 && awaited < created, "the context is created before hydration settles")
})

globalThis.fetch = realFetch
await new Promise((resolve) => listener.close(resolve))
fs.rmSync(home, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
