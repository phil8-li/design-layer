/**
 * The overlay script every proxied page loads, served by DesignLayer rather
 * than by the vendor: the browser prelude, the patched vendor overlay, the
 * editor's chrome bundle and the configured companions, all inside
 * `guardBoardFrames`, with an ETag, compression and an immutable versioned URL.
 * The toaster's React half is served beside it.
 *
 * Its own module, apart from the launcher, because nothing here patches the
 * process: it reads files and answers requests, and its cases drive it with a
 * plain `http` server (`test/overlay-delivery-cases.mjs`).
 *
 * The cache, as a machine: `cached` is empty, then the body for one key; a
 * request whose key (prelude text plus the `mtimeMs:size` of every input)
 * differs builds the body for the new key. Each body carries its own map of
 * compressed copies, one promise per encoding.
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import zlib from "node:zlib"

import { browserPrelude } from "../config.mjs"
import { wrapCompanion } from "../server/companions.mjs"
import { guardBoardFrames } from "./board-frame.mjs"
import { statSignature } from "./bundle-stamp.mjs"

const CHROME_BUNDLE = fileURLToPath(
  new URL("../dist/designlayer.js", import.meta.url)
)
// The toaster's React half, built as a module of its own (see `build.mjs`).
const TOASTER_BUNDLE = fileURLToPath(new URL("../dist/toaster.js", import.meta.url))

export function readChromeBundle() {
  try {
    return fs.readFileSync(CHROME_BUNDLE, "utf8")
  } catch {
    console.warn(
      "[designlayer] chrome bundle missing — run `npm run build` in the package"
    )
    return ""
  }
}

/**
 * The configured companions, concatenated after the editor's own chrome.
 *
 * After, because the editor is the thing this package is responsible for: a
 * companion that blows up on evaluation must not be able to take it with it,
 * and `wrapCompanion` fences each one for the same reason. Not cached across
 * changes: `createOverlayResponder` keys its cache on each companion script's
 * mtime and size, so rebuilding a companion's bundle shows up on the next
 * reload — the editor's own dist is checked at launch as well, because a stale
 * dist is a fact about this tree that nobody rebuilds by hand mid-session.
 *
 * A companion that has gone missing since launch warns and is skipped. The
 * alternative is a 500 on the overlay, which takes down the editor over a file
 * that belongs to somebody else.
 */
export function readCompanionBundles(config) {
  return (config.companions ?? [])
    .map((companion) => {
      try {
        return wrapCompanion(companion.name, fs.readFileSync(companion.script, "utf8"))
      } catch (error) {
        console.warn(
          `[designlayer] companion "${companion.name}" could not be read (${error.message})`
        )
        return ""
      }
    })
    .join("")
}

export const OVERLAY_PATH = "/__react-rewrite/overlay.js"
export const TOASTER_PATH = "/__designlayer/toaster.js"

const brotli = promisify(zlib.brotliCompress)
const gzip = promisify(zlib.gzip)

/** `mtimeMs:size`, or a fixed word for a file that is not there right now. */
function fileStamp(file) {
  return statSignature(file) ?? "missing"
}

/** The best encoding the request accepts: br, then gzip, then none. `q=0` refuses. */
function pickEncoding(header) {
  const accepted = new Set()
  for (const part of String(header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";")
    const refused = params.some((param) => /^\s*q\s*=\s*0(\.0*)?\s*$/.test(param))
    if (name && !refused) accepted.add(name)
  }
  if (accepted.has("br")) return "br"
  if (accepted.has("gzip")) return "gzip"
  return null
}

/**
 * Serves `/__react-rewrite/overlay.js` itself, ahead of the vendor's handler.
 *
 * The vendor writes the overlay with a bare `Content-Type` and nothing else: no
 * validator, no compression. So every page load re-downloaded ~3MB and, with
 * nothing to revalidate against, Chrome threw away its V8 code cache for the
 * script each time — measured at ~20ms of top-level compile against ~0.1ms
 * with cached data, before the eager compile of the functions that run. By the
 * time the vendor's `createReadStream` runs it has already called `writeHead`,
 * so a 304 is impossible from there; it has to be answered before the vendor
 * sees the request.
 *
 * The body is exactly what was served before — prelude, patched vendor overlay,
 * chrome, companions, all inside `guardBoardFrames` — built once per key. The
 * key is every input that can change while this process lives: the prelude
 * text (its ports are filled in at bind), and `mtimeMs:size` of the chrome
 * bundle and of each companion script, so a rebuilt companion still shows up
 * on the next reload. A handful of `stat`s per request is the whole cost of a
 * hit. The ETag is the body's own hash, so a rebuild that produces the same
 * bytes keeps the browser's cache, and each encoding is compressed once per
 * body, off the main thread.
 *
 * The toaster's React half is served the same way at `TOASTER_PATH`: its own
 * file, keyed by its stamp. The overlay names its versioned URL in
 * `window.__DESIGNLAYER_TOASTER__`, so the first toast of a session imports
 * exactly the build the page was served beside, and every later page takes it
 * from cache.
 *
 * Returns `respond(req, res)`, true when it took the request; `warm()`, which
 * builds the current body and its brotli copy ahead of the first page; and
 * `versionedPath()`, the URL a page is handed, which is served as immutable — a
 * reload then runs the script from cache without even the 304's round trip.
 * Its `?v=` is a hash of the key rather than of the body: the key already
 * changes whenever the body can, and naming it costs a few `stat`s, where
 * hashing the body meant building it inside the first page's response.
 */
export function createOverlayResponder({ config, runtime, patchedOverlay }) {
  let cached = null
  let toaster = null

  const versionOf = (key) => createHash("sha1").update(key).digest("base64url")

  function entryFor(key, text) {
    const body = Buffer.from(text)
    const etag = `"${createHash("sha1").update(body).digest("base64url")}"`
    return { key, body, version: versionOf(key), etag, encoded: new Map() }
  }

  /** The toaster module's entry, or null while `dist/` has none. */
  function currentToaster() {
    const key = fileStamp(TOASTER_BUNDLE)
    if (key === "missing") return (toaster = null)
    if (toaster?.key === key) return toaster
    let text = null
    try {
      text = fs.readFileSync(TOASTER_BUNDLE, "utf8")
    } catch {
      // No module, no URL: `core/toast.ts` falls back to its plain import.
    }
    toaster = text === null ? null : entryFor(key, text)
    return toaster
  }

  /** Everything the body is made from, as one string; see the header. */
  function overlayKey() {
    const prelude = browserPrelude(config, runtime)
    const toasterStamp = fileStamp(TOASTER_BUNDLE)
    const key = [
      prelude,
      fileStamp(CHROME_BUNDLE),
      toasterStamp,
      ...(config.companions ?? []).map((companion) => fileStamp(companion.script)),
    ].join("\n")
    return { prelude, toasterStamp, key }
  }

  function current() {
    const { prelude, toasterStamp, key } = overlayKey()
    if (cached?.key === key) return cached
    const named =
      toasterStamp === "missing"
        ? ""
        : `window.__DESIGNLAYER_TOASTER__=${JSON.stringify(`${TOASTER_PATH}?v=${versionOf(toasterStamp)}`)};\n`
    cached = entryFor(
      key,
      guardBoardFrames(
        `${prelude}\n${named}${patchedOverlay}\n;\n${readChromeBundle()}\n;\n${readCompanionBundles(config)}`
      )
    )
    return cached
  }

  function encodedBody(entry, encoding) {
    if (!encoding) return Promise.resolve(entry.body)
    let pending = entry.encoded.get(encoding)
    if (!pending) {
      // Brotli 5 is the measured sweet spot: 679KB in ~35ms, against gzip's
      // 751KB in ~55ms. Higher qualities cost seconds for a few percent.
      pending =
        encoding === "br"
          ? brotli(entry.body, {
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.body.length,
              },
            })
          : gzip(entry.body, { level: 6 })
      // A failed compression falls back to the plain body rather than a 500.
      pending = pending.catch(() => entry.body)
      entry.encoded.set(encoding, pending)
    }
    return pending
  }

  function respond(req, res) {
    const url = new URL(req.url || "/", "http://localhost")
    const entry =
      url.pathname === OVERLAY_PATH ? current() : url.pathname === TOASTER_PATH ? currentToaster() : null
    if (!entry) return false
    const headers = {
      "Content-Type": "application/javascript",
      // The URL a page is handed names this exact body (`versionedPath`), so it
      // can never go stale: the browser keeps it without asking again. Any
      // other spelling — the bare path, a version from before a rebuild —
      // revalidates against the ETag.
      "Cache-Control":
        url.searchParams.get("v") === entry.version ? "public, max-age=31536000, immutable" : "no-cache",
      ETag: entry.etag,
      Vary: "Accept-Encoding",
    }
    const tags = String(req.headers["if-none-match"] ?? "").split(",").map((tag) => tag.trim())
    if (tags.includes(entry.etag) || tags.includes("*")) {
      res.writeHead(304, headers)
      res.end()
      return true
    }
    const encoding = pickEncoding(req.headers["accept-encoding"])
    void encodedBody(entry, encoding).then((payload) => {
      if (res.destroyed) return
      const plain = payload === entry.body
      res.writeHead(200, {
        ...headers,
        ...(plain ? {} : { "Content-Encoding": encoding }),
        "Content-Length": String(payload.length),
      })
      res.end(req.method === "HEAD" ? undefined : payload)
    })
    return true
  }

  function warm() {
    try {
      void encodedBody(current(), "br")
      const view = currentToaster()
      if (view) void encodedBody(view, "br")
    } catch {
      // A body that cannot be built now will say why on the request that asks.
    }
  }

  /** The overlay's URL for a page being served now, naming the body it gets. */
  function versionedPath() {
    return `${OVERLAY_PATH}?v=${versionOf(overlayKey().key)}`
  }

  return { respond, warm, versionedPath }
}
