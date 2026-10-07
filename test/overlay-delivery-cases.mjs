/**
 * Cases for serving the overlay: the same bytes as before, now revalidated and
 * compressed.
 *
 * The overlay is ~3MB and asked for on every page load. These pin what makes a
 * reload cheap — an ETag the browser can send back for a bodiless 304, and a
 * compressed copy whose length is the length on the wire — and the two things
 * that must not be lost to the cache: the body is byte-for-byte the guarded
 * concatenation the launcher always served, and a rebuilt companion (or a
 * prelude whose ports changed) is a new body on the next request.
 *
 * Over real sockets with `http.get`, because `fetch` decodes transparently and
 * would hide the very bytes being measured.
 *
 * Usage: node designlayer/test/overlay-delivery-cases.mjs
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"

import { browserPrelude, resolveConfig } from "../config.mjs"
import { guardBoardFrames } from "../runtime/board-frame.mjs"
import {
  createOverlayResponder,
  OVERLAY_PATH,
  readChromeBundle,
  readCompanionBundles,
  TOASTER_PATH,
} from "../runtime/launcher.mjs"

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

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-overlay-")))
process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }))

const script = path.join(dir, "toolbar", "toolbar.js")
fs.mkdirSync(path.dirname(script), { recursive: true })
fs.writeFileSync(script, "window.toolbar = 1", "utf8")
const manifest = path.join(dir, "toolbar", "companion.json")
fs.writeFileSync(manifest, JSON.stringify({ name: "toolbar", script: "./toolbar.js" }), "utf8")

const config = resolveConfig({ companions: [manifest] }, { cwd: dir })
const runtime = { appPort: 5173, proxyPort: 3456, wsPort: 3457 }
const patchedOverlay = "var ReactRewrite = 1"
const overlay = createOverlayResponder({ config, runtime, patchedOverlay })

const server = http.createServer((req, res) => {
  if (overlay.respond(req, res)) return
  res.writeHead(404)
  res.end()
})
const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))

/** One raw request: status, headers, and the undecoded body bytes. */
function get(headers = {}, method = "GET", url = OVERLAY_PATH) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: url, method, headers }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end()
  })
}

// The toaster's React half is its own module, and the overlay names it by a
// URL that carries a hash of the module file's stamp — what the launcher keys
// it on, so naming it never means reading it.
const TOASTER = new URL("../dist/toaster.js", import.meta.url)
const toasterUrl = () => {
  const stat = fs.statSync(TOASTER)
  return `${TOASTER_PATH}?v=${createHash("sha1").update(`${stat.mtimeMs}:${stat.size}`).digest("base64url")}`
}

const expected = () =>
  guardBoardFrames(
    `${browserPrelude(config, runtime)}\nwindow.__DESIGNLAYER_TOASTER__=${JSON.stringify(toasterUrl())};\n` +
      `${patchedOverlay}\n;\n${readChromeBundle()}\n;\n${readCompanionBundles(config)}`
  )

console.log("\nOverlay delivery")

await check("the body is exactly the guarded concatenation, with a validator", async () => {
  const response = await get({ "accept-encoding": "identity" })
  assert.equal(response.status, 200)
  assert.equal(response.body.toString("utf8"), expected())
  assert.equal(response.headers["content-type"], "application/javascript")
  assert.equal(response.headers["cache-control"], "no-cache")
  assert.equal(response.headers.vary, "Accept-Encoding")
  assert.match(response.headers.etag, /^"[^"]+"$/)
  assert.equal(response.headers["content-encoding"], undefined)
  assert.equal(Number(response.headers["content-length"]), response.body.length)
})

await check("a repeat load with the ETag is a 304 with no body", async () => {
  const { headers } = await get()
  const again = await get({ "if-none-match": headers.etag, "accept-encoding": "br, gzip" })
  assert.equal(again.status, 304)
  assert.equal(again.body.length, 0)
  assert.equal(again.headers.etag, headers.etag)
})

await check("br is preferred, its length is the wire length, and it decodes to the body", async () => {
  const response = await get({ "accept-encoding": "gzip, deflate, br" })
  assert.equal(response.headers["content-encoding"], "br")
  assert.equal(Number(response.headers["content-length"]), response.body.length)
  assert.equal(zlib.brotliDecompressSync(response.body).toString("utf8"), expected())
})

await check("gzip when br is not accepted, or refused with q=0", async () => {
  for (const header of ["gzip", "br;q=0, gzip"]) {
    const response = await get({ "accept-encoding": header })
    assert.equal(response.headers["content-encoding"], "gzip", header)
    assert.equal(Number(response.headers["content-length"]), response.body.length, header)
    assert.equal(zlib.gunzipSync(response.body).toString("utf8"), expected(), header)
  }
})

await check("HEAD answers the headers and no body", async () => {
  const response = await get({ "accept-encoding": "identity" }, "HEAD")
  assert.equal(response.status, 200)
  assert.equal(response.body.length, 0)
  assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(expected()))
})

await check("a rebuilt companion is a new body and a new ETag on the next request", async () => {
  const before = await get({ "accept-encoding": "identity" })
  fs.writeFileSync(script, "window.toolbar = 2 // rebuilt", "utf8")
  const after = await get({ "if-none-match": before.headers.etag, "accept-encoding": "identity" })
  assert.equal(after.status, 200)
  assert.notEqual(after.headers.etag, before.headers.etag)
  assert.match(after.body.toString("utf8"), /window\.toolbar = 2 \/\/ rebuilt/)
  assert.equal(after.body.toString("utf8"), expected())
})

await check("a prelude whose ports changed is a new body", async () => {
  const before = await get({ "accept-encoding": "identity" })
  runtime.wsPort = 4457
  const after = await get({ "accept-encoding": "identity" })
  assert.notEqual(after.headers.etag, before.headers.etag)
  assert.equal(after.body.toString("utf8"), expected())
})

await check("the versioned URL is immutable; a stale or bare one revalidates", async () => {
  const path = overlay.versionedPath()
  assert.match(path, /^\/__react-rewrite\/overlay\.js\?v=[\w-]+$/)
  const pinned = await get({ "accept-encoding": "identity" }, "GET", path)
  assert.equal(pinned.status, 200)
  assert.equal(pinned.headers["cache-control"], "public, max-age=31536000, immutable")
  assert.equal(pinned.body.toString("utf8"), expected())
  // The version names what the body is built from: a rebuild moves it, and
  // the old URL stops being promised forever.
  const stale = await get({ "accept-encoding": "identity" }, "GET", `${path}x`)
  assert.equal(stale.headers["cache-control"], "no-cache")
  const bare = await get({ "accept-encoding": "identity" })
  assert.equal(bare.headers["cache-control"], "no-cache")
})

await check("the toaster module is served at the URL the overlay names, immutably", async () => {
  const named = await get({ "accept-encoding": "br" }, "GET", toasterUrl())
  assert.equal(named.status, 200)
  assert.equal(named.headers["content-type"], "application/javascript")
  assert.equal(named.headers["cache-control"], "public, max-age=31536000, immutable")
  assert.equal(named.headers["content-encoding"], "br")
  assert.equal(zlib.brotliDecompressSync(named.body).toString("utf8"), fs.readFileSync(TOASTER, "utf8"))
  const again = await get({ "if-none-match": named.headers.etag }, "GET", TOASTER_PATH)
  assert.equal(again.status, 304)
})

await check("any other path is left to the vendor", async () => {
  const response = await get({}, "GET", "/__react-rewrite/inter-regular.woff2")
  assert.equal(response.status, 404)
})

server.close()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
