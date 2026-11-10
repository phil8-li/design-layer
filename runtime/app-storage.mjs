/**
 * The editor's remembered state, kept for the whole machine.
 *
 * Notes and their settings used to live only in the page's
 * localStorage, and localStorage belongs to one origin. Each app's editor is
 * served from its own port now, the same editor can be reached as `localhost`
 * or `127.0.0.1`, and the Mac app is a browser profile of its own, so a note
 * written in one of those places was invisible from every other. The keys were
 * already named by app, not by origin (`src/core/app-scope.ts`), so the only
 * thing missing was somewhere every origin could reach. This is it: the page
 * keeps writing localStorage, and copies each change here.
 *
 * One small file per key in `storage/` beside the editor registry, written to a
 * temporary name and renamed, for the reason `last-pages.mjs` gives: several
 * editor processes write here at once, and a shared file read-modify-written by
 * each of them loses all but the last write. A removal is kept as a tombstone
 * (`deleted: true`, no value) so a merge can tell "deleted after" from "never
 * had it", which is the difference between a note staying gone and a stale
 * copy in another origin bringing it back.
 *
 * Merges are last-write-wins on `updatedAt`, the page's clock at the time of
 * the change. Two editors merging one key in the same instant can both pass the
 * comparison, and the later rename wins whichever is newer; that needs one
 * person editing one note in two places within a millisecond, and costs one of
 * those two edits.
 *
 * Never throws: a store that cannot be written costs only the cross-origin copy.
 * The page still has its own.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { stateRoot, writeFileAtomic } from "./state-dir.mjs"

const KEY_PREFIX = "designlayer."
export const MAX_KEY_LENGTH = 512
// A page of notes is a few kilobytes. This is far above that and far below
// what would make one key crowd the others out of the total.
export const MAX_VALUE_LENGTH = 256 * 1024
// The total kept on disk. Past it, the entries written longest ago go first,
// which drops the apps nobody has opened in the longest time.
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024
export const MAX_STORED_ENTRIES = 2000

export function storageDir() {
  return path.join(stateRoot(), "storage")
}

// Hashed because a key holds a URL and a pathname, and neither is a file name.
function fileFor(key) {
  return path.join(storageDir(), `${crypto.createHash("sha1").update(key).digest("hex")}.json`)
}

/** A clean entry, or null for anything a page should not have sent. */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null
  const { key, value, updatedAt } = raw
  if (typeof key !== "string" || !key.startsWith(KEY_PREFIX) || key.length > MAX_KEY_LENGTH) return null
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) return null
  if (raw.deleted === true) return { key, value: null, updatedAt, deleted: true }
  if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH) return null
  return { key, value, updatedAt, deleted: false }
}

function readFile(file) {
  try {
    return normalizeEntry(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch {
    return null
  }
}

/** Every entry on disk, tombstones included. */
export function readEntries() {
  let names
  try {
    names = fs.readdirSync(storageDir()).filter((name) => name.endsWith(".json"))
  } catch {
    return []
  }
  const entries = []
  for (const name of names) {
    const entry = readFile(path.join(storageDir(), name))
    if (entry) entries.push(entry)
  }
  return entries
}

function writeEntry(entry) {
  try {
    writeFileAtomic(fileFor(entry.key), `${JSON.stringify(entry)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * Drops the entries written longest ago once the store is over either cap.
 *
 * Counted and sized from `stat` first, because the caps are rarely reached and
 * this runs after every merge that took an entry — and the page copies each
 * localStorage change here, so typing a note merged several times a second.
 * Reading and parsing every file (up to 2,000 of them) on each of those merges
 * was the cost; `updatedAt` is read only when something has to go.
 *
 * Ordered by the entry's own `updatedAt`, not the file's mtime: a merge of an
 * old note uploaded today is still an old note.
 */
function prune() {
  const dir = storageDir()
  let names
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch {
    return
  }
  const files = names.map((name) => {
    const file = path.join(dir, name)
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      /* counted as empty */
    }
    return { file, size }
  })
  let total = files.reduce((sum, { size }) => sum + size, 0)
  if (total <= MAX_TOTAL_BYTES && files.length <= MAX_STORED_ENTRIES) return
  const dated = files.map((entry) => ({ ...entry, at: readFile(entry.file)?.updatedAt ?? 0 }))
  dated.sort((a, b) => a.at - b.at)
  let count = dated.length
  for (const { file, size } of dated) {
    if (total <= MAX_TOTAL_BYTES && count <= MAX_STORED_ENTRIES) break
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* the next merge tries again */
    }
    total -= size
    count -= 1
  }
}

/**
 * Keeps each incoming entry that is newer than the copy on disk.
 *
 * Returns how many were taken and how many were refused as malformed; an entry
 * that lost to a newer copy is neither, because losing is a normal answer.
 */
export function mergeEntries(list) {
  let accepted = 0
  let rejected = 0
  if (!Array.isArray(list)) return { accepted, rejected }
  for (const raw of list) {
    const entry = normalizeEntry(raw)
    if (!entry) {
      rejected += 1
      continue
    }
    const current = readFile(fileFor(entry.key))
    if (current && current.key === entry.key && current.updatedAt >= entry.updatedAt) continue
    if (writeEntry(entry)) accepted += 1
  }
  if (accepted > 0) prune()
  return { accepted, rejected }
}
