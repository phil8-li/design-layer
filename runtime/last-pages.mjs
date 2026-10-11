/**
 * The page each app was last looked at in, for the whole machine.
 *
 * Copies of one template share their home page, so landing a switch on an
 * app's root showed a screen identical to the app just left, and read as the
 * switch having failed. A switch has to land on the page the person was using
 * in that app. The browser cannot keep that alone: the Mac app frames each
 * editor cross-site, so its storage is partitioned away from a browser tab's,
 * and the two never saw each other's pages. So the editor reports its page
 * here, and every surface that opens an app reads it back.
 *
 * Keyed by project folder and port together. A port is reused by whatever
 * starts next, and a page of one project is not a page of another.
 *
 * One small file per app, in `pages/` beside the editor registry. It used to be
 * one JSON file for every app, and with several editors running at once that
 * lost pages: each writer read the whole file, changed its own key and wrote
 * the whole file back, so two editors reporting together kept only the last
 * one's write. A file per key has one writer at a time by construction, and
 * each write is a rename, so a reader never sees half of one.
 *
 * The old single file is still read as a fallback, so pages saved before the
 * split are not lost; nothing writes to it any more.
 *
 * Never throws: a page that cannot be remembered costs a landing on the root.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { registryDir } from "./editor-registry.mjs"
import { realRoot } from "./editor-ports.mjs"

const MAX_ENTRIES = 200
const MAX_PAGE_LENGTH = 4096

/** The pre-split file every app's page used to share. Read, never written. */
export function pagesFile() {
  return path.join(path.dirname(registryDir()), "pages.json")
}

/** One file per app from here on. See the top of this file. */
export function pagesDir() {
  return path.join(path.dirname(registryDir()), "pages")
}

// The real folder, so every spelling of one project's root finds one entry.
// See `realRoot` in editor-ports.mjs.
function keyFor(port, projectRoot) {
  return Number.isInteger(port) && port > 0 ? `${realRoot(projectRoot)}|${port}` : null
}

// The key as written before roots were resolved. Read, never written.
function rawKeyFor(port, projectRoot) {
  return Number.isInteger(port) && port > 0 ? `${projectRoot ?? ""}|${port}` : null
}

// Hashed because a project root is a path, and a path is not a file name.
function fileFor(key) {
  return path.join(pagesDir(), `${crypto.createHash("sha1").update(key).digest("hex")}.json`)
}

function readLegacy() {
  try {
    const parsed = JSON.parse(fs.readFileSync(pagesFile(), "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

// Drops the files nobody has written in longest once there are too many. Two
// editors pruning at once can only both delete an old file, which is harmless.
function prune(dir) {
  let names
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch {
    return
  }
  if (names.length <= MAX_ENTRIES) return
  const dated = names.map((name) => {
    try {
      return { name, at: fs.statSync(path.join(dir, name)).mtimeMs }
    } catch {
      return { name, at: 0 }
    }
  })
  dated.sort((a, b) => a.at - b.at)
  for (const { name } of dated.slice(0, dated.length - MAX_ENTRIES)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch {
      /* the next write tries again */
    }
  }
}

/** A path on the app's own origin: "/", then anything. Not "//host", which leaves it. */
function isPage(page) {
  return typeof page === "string" && page.startsWith("/") && !page.startsWith("//") && page.length <= MAX_PAGE_LENGTH
}

export function rememberPage({ port, projectRoot, page }) {
  const key = keyFor(port, projectRoot)
  if (!key || !isPage(page)) return
  const file = fileFor(key)
  // Unique per write, not just per process: one editor can report twice
  // before the first write is renamed.
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify({ key, page })}\n`, "utf8")
    fs.renameSync(temp, file)
    prune(path.dirname(file))
  } catch {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      /* nothing else to try */
    }
  }
}

/** The last page of the app on `port` from `projectRoot`, or null. */
export function lastPage({ port, projectRoot }) {
  const key = keyFor(port, projectRoot)
  if (!key) return null
  const rawKey = rawKeyFor(port, projectRoot)
  const keys = rawKey === key ? [key] : [key, rawKey]
  for (const candidate of keys) {
    const page = readPage(candidate)
    if (page !== undefined) return isPage(page) ? page : null
  }
  let legacy = null
  for (const candidate of keys) legacy ??= readLegacy()[candidate] ?? null
  return isPage(legacy) ? legacy : null
}

// The page in one key's file; undefined when there is no file for it.
function readPage(key) {
  try {
    const entry = JSON.parse(fs.readFileSync(fileFor(key), "utf8"))
    // The key is stored too, so a hash collision reads as no page, not as
    // another app's.
    return entry?.key === key ? entry.page : null
  } catch {
    return undefined
  }
}

/** The port in a loopback app URL, or null. */
export function portOfUrl(url) {
  try {
    const parsed = new URL(url)
    return Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80)
  } catch {
    return null
  }
}
