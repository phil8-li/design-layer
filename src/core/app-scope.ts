/**
 * Which app's work this is, and where to keep it.
 *
 * Everything the editor remembers between reloads — the notes pinned to a page,
 * the ledger of changes the writer could not express — belongs to ONE app. That
 * was an invisible assumption for as long as an editor process meant an app: a
 * session edited what it was started with, and the storage key only had to tell
 * two ROUTES of that app apart.
 *
 * The app chooser broke it. Switching apps is a reload of the same document, on
 * the same origin and usually on the same path, because the supervisor binds
 * the next editor to the proxy port the last one had. So a key built from the
 * path alone names the same bucket for every app a designer visits, and the two
 * failures that follow are the two halves of one bug: the notes you wrote on the
 * shop are still on screen over the docs site, pinned to elements that do not
 * exist there, and they are no longer anywhere you can get at them by going
 * back to the shop.
 *
 * Naming the app in the key fixes both at once. Nothing is shared that should
 * not be, and nothing is lost — switching away files your work under that app
 * and switching back brings it out again.
 *
 * That used to end "which is what makes an app chooser safe to use without
 * being asked to confirm anything", and it is no longer true — not because this
 * scoping stopped working, but because it was never the whole story. Notes and
 * the preview-only ledger are filed per app and do survive a switch. The
 * removal queue, the Angular queue and the vendor store are in memory and die
 * with the document, and a switch SIGTERMs the editor. So the chooser arms
 * before it goes when any of those three is non-empty, and stays one click when
 * they are not — see the note on the click handler in \`panels/app-chooser.ts\`.
 *
 * ## Why the URL and not the name
 *
 * `config.app.name` is the host's package name, and two checkouts of one
 * project — a copy to try something in, the same repo on two branches — are two
 * apps with one name and different ports. The URL is what the editor is
 * actually pointed at, and the port in it is the part that differs. The name is
 * for reading; this is for filing.
 *
 * A session with no resolved app URL gets `"app"`, one shared bucket. That is
 * the `--dev` case, where there is exactly one app and no chooser to move
 * between apps with, so a bucket per app would be a distinction with nothing on
 * either side of it.
 */

import { config } from "./config"

/**
 * The app half of a storage key. Stable for the life of a session, because
 * `config` is read once from the prologue and the server cannot change its mind
 * mid-page.
 *
 * Punctuation is collapsed rather than encoded: these end up in a key next to a
 * pathname, and `http://127.0.0.1:3000` reads better as `http-127-0-0-1-3000`
 * than as a percent-escape. Two different URLs cannot collapse to one string
 * that matters here — the port survives either way.
 */
export function appScope(): string {
  const url = config.app.url
  if (!url) return "app"
  return url.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

/**
 * A full key for something remembered per app and per page.
 *
 * The pathname stays in it. Two routes of one app are still two sets of notes —
 * that was true before the chooser existed and the chooser does not change it.
 */
export function appScopedKey(prefix: string): string {
  return `${prefix}${appScope()}:${window.location.pathname}`
}

/**
 * Every storage call is wrapped, and none of them may throw.
 *
 * `localStorage` is not a given: it throws outright when a browser blocks
 * storage for an origin, and again when the quota is full. Losing a panel
 * because a note could not be written down would trade a whole feature for its
 * persistence, so a failed write is work that lives until reload and a failed
 * read is an empty list.
 */
export function readScoped(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeScoped(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Nothing to do and nothing worth saying: the session still works.
  }
  record(key, value)
}

export function dropScoped(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Same bargain as writing.
  }
  record(key, null)
}

/*
 * ## The machine copy
 *
 * localStorage belongs to one origin, and the editor no longer has one: each
 * app's editor is on its own port, the same editor answers as `localhost` and
 * as `127.0.0.1`, and the Mac app is a browser profile of its own. The keys
 * above were never about the origin, so every scoped change is also copied to
 * the editor's server (`runtime/app-storage.mjs`), which keeps one store for
 * the machine, and `hydrateScoped` copies it back before the stores first read.
 *
 * localStorage stays the synchronous source every read uses. The server copy is
 * written behind it and read only at boot, so a dead or slow server costs the
 * cross-origin copy and never a read.
 *
 * Only what is the designer's work is copied: notes, their settings and the
 * preview-only ledger. The running-apps cache is a guess about this moment and
 * is rewritten on every menu open; copying it would be traffic with no reader.
 */
const SYNCED_PREFIXES = [
  "designlayer.annotations.",
  "designlayer.annotation-settings",
  "designlayer.preview-only.",
]

/**
 * When each copied key last changed in THIS origin, so a merge with the server
 * can tell which copy is newer. A key in here that localStorage does not hold
 * was removed, and goes up as a tombstone. Not itself copied: it describes this
 * origin's copy and nothing else.
 */
const META_KEY = "designlayer.storage-meta"
// Removals are remembered so they can win a merge, and dropped oldest first
// past this many, after which a stale copy elsewhere could bring one back.
const MAX_TOMBSTONES = 500
// The server refuses a body over 1 MB. Batches stay well under it.
const MAX_BATCH = 512 * 1024
// The browser refuses a keepalive body over 64 KB outright.
const MAX_KEEPALIVE = 60 * 1024
const FLUSH_DELAY = 250
const HYDRATE_WAIT = 400

interface StorageEntry {
  key: string
  value: string | null
  updatedAt: number
  deleted: boolean
}

export function isSyncedKey(key: string): boolean {
  return SYNCED_PREFIXES.some((prefix) => key.startsWith(prefix))
}

function readMeta(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(META_KEY) ?? "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const meta: Record<string, number> = {}
    for (const [key, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at) && at > 0) meta[key] = at
    }
    return meta
  } catch {
    return {}
  }
}

function writeMeta(meta: Record<string, number>): void {
  const tombstones = Object.keys(meta)
    .filter((key) => readScoped(key) === null)
    .sort((a, b) => meta[a] - meta[b])
  for (const key of tombstones.slice(0, Math.max(0, tombstones.length - MAX_TOMBSTONES))) {
    delete meta[key]
  }
  try {
    window.localStorage.setItem(META_KEY, JSON.stringify(meta))
  } catch {
    // Without it the next merge treats this origin's copies as untracked, which
    // loses to the server rather than overwriting it.
  }
}

// Strictly increasing within a page, so two writes in one millisecond still
// order the way they happened.
let lastStamp = 0
function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return lastStamp
}

const pending = new Map<string, StorageEntry>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushOnHide = false

function record(key: string, value: string | null): void {
  if (!isSyncedKey(key)) return
  const updatedAt = stamp()
  const meta = readMeta()
  meta[key] = updatedAt
  writeMeta(meta)
  pending.set(key, { key, value, updatedAt, deleted: value === null })
  if (!flushOnHide) {
    flushOnHide = true
    // A note written just before the tab closes would otherwise wait for a
    // timer that never fires.
    window.addEventListener("pagehide", () => flushScoped())
  }
  if (flushTimer === null) flushTimer = setTimeout(() => flushScoped(), FLUSH_DELAY)
}

// Sends not yet answered, so a flush resolves only once everything recorded
// before it has been answered, including what an earlier flush sent.
const inflight = new Set<Promise<unknown>>()

function post(entries: StorageEntry[]): Promise<unknown> {
  const body = JSON.stringify({ entries })
  let sent: Promise<unknown>
  try {
    sent = fetch(`${config.apiBase}/storage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: body.length <= MAX_KEEPALIVE,
    }).catch(() => undefined)
  } catch {
    return Promise.resolve()
  }
  inflight.add(sent)
  void sent.finally(() => inflight.delete(sent))
  return sent
}

/**
 * Sends every recorded change now. A send that fails is not retried: this
 * origin's copy is still newer than the server's, so the next boot's
 * `hydrateScoped` sends it again.
 */
export function flushScoped(): Promise<unknown> {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = null
  const entries = [...pending.values()]
  pending.clear()
  const sends: Promise<unknown>[] = [...inflight]
  let batch: StorageEntry[] = []
  let size = 0
  for (const entry of entries) {
    const length = entry.key.length + (entry.value?.length ?? 0) + 64
    if (batch.length > 0 && size + length > MAX_BATCH) {
      sends.push(post(batch))
      batch = []
      size = 0
    }
    batch.push(entry)
    size += length
  }
  if (batch.length > 0) sends.push(post(batch))
  return Promise.all(sends)
}

function readServerEntries(raw: unknown): StorageEntry[] {
  const list = (raw as { entries?: unknown } | null)?.entries
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is StorageEntry =>
      !!entry &&
      typeof entry.key === "string" &&
      isSyncedKey(entry.key) &&
      typeof entry.updatedAt === "number" &&
      Number.isFinite(entry.updatedAt) &&
      (entry.deleted === true || typeof entry.value === "string")
  )
}

/**
 * A copy this origin holds from before changes were tracked, against a newer
 * one on the server: the case of notes written on an old address, opened after
 * notes were already written for the same page somewhere else. Neither is
 * "newer" in any sense the person would agree with, so when both are lists —
 * which notes and the ledger are — the result keeps both, the old ones first,
 * and drops an entry the server already has by `id` or by content. Anything
 * else goes to the server's copy.
 */
function unionLegacy(local: string, server: string): string | null {
  try {
    const mine: unknown = JSON.parse(local)
    const theirs: unknown = JSON.parse(server)
    if (!Array.isArray(mine) || !Array.isArray(theirs)) return null
    const identity = (item: unknown): string =>
      item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
        ? `id:${(item as { id: string }).id}`
        : `json:${JSON.stringify(item)}`
    const known = new Set(theirs.map(identity))
    const extra = mine.filter((item) => !known.has(identity(item)))
    return extra.length === 0 ? null : JSON.stringify([...extra, ...theirs])
  } catch {
    return null
  }
}

function localSyncedKeys(): string[] {
  const keys: string[] = []
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (key !== null && isSyncedKey(key)) keys.push(key)
    }
  } catch {
    // A blocked store has nothing to send.
  }
  return keys
}

/**
 * Brings this origin's localStorage level with the machine copy, once, before
 * anything reads it.
 *
 * Newer server entries are written in (a tombstone removes the key), then every
 * copied key the server lacks or holds an older copy of goes up. That second
 * half is also how notes saved on an old origin reach the server: the first
 * boot of this code there finds them untracked and absent from the server.
 *
 * Waits at most `HYDRATE_WAIT` for the server. Past that, or on any failure,
 * the editor boots on this origin's copy alone, which is what it did before.
 */
export async function hydrateScoped(wait = HYDRATE_WAIT): Promise<void> {
  let serverEntries: StorageEntry[]
  const controller = typeof AbortController === "function" ? new AbortController() : null
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const response = await Promise.race([
      fetch(`${config.apiBase}/storage`, { signal: controller?.signal, cache: "no-store" }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort()
          reject(new Error("storage timed out"))
        }, wait)
      }),
    ])
    if (!response.ok) return
    serverEntries = readServerEntries(await response.json())
  } catch {
    return
  } finally {
    if (timer !== null) clearTimeout(timer)
  }

  const meta = readMeta()
  const server = new Map(serverEntries.map((entry) => [entry.key, entry]))
  const upload: StorageEntry[] = []

  for (const key of new Set([...localSyncedKeys(), ...Object.keys(meta).filter(isSyncedKey)])) {
    const local = readScoped(key)
    const theirs = server.get(key)
    const at = meta[key]
    if (at === undefined) {
      if (local === null) continue
      if (!theirs) {
        // Untracked and unknown to the server: an old origin's notes on their
        // first trip. Stamped as the oldest possible change, so any edit made
        // anywhere since wins over it.
        meta[key] = 1
        upload.push({ key, value: local, updatedAt: 1, deleted: false })
      } else if (theirs.value !== local) {
        // A tombstone removed notes this origin never showed anyone, so it
        // counts as an empty list here rather than as a removal of these.
        const merged = unionLegacy(local, theirs.deleted ? "[]" : (theirs.value as string))
        if (merged !== null) {
          const updatedAt = stamp()
          setLocal(key, merged)
          meta[key] = updatedAt
          upload.push({ key, value: merged, updatedAt, deleted: false })
        }
      }
      continue
    }
    if (!theirs || theirs.updatedAt < at) {
      upload.push({ key, value: local, updatedAt: at, deleted: local === null })
    }
  }

  for (const entry of serverEntries) {
    const at = meta[entry.key] ?? 0
    if (entry.updatedAt <= at) continue
    if (entry.deleted) removeLocal(entry.key)
    else setLocal(entry.key, entry.value as string)
    meta[entry.key] = entry.updatedAt
  }

  writeMeta(meta)
  for (const entry of upload) pending.set(entry.key, entry)
  if (upload.length > 0) void flushScoped()
}

// The raw writes hydration uses: writing through `writeScoped` would record a
// server entry as a fresh change and send it straight back.
function setLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The session runs on what this origin already had.
  }
}

function removeLocal(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Same bargain as writing.
  }
}

/**
 * Moves what an older build wrote under an unscoped key into this app's bucket,
 * once, and only when the bucket is empty.
 *
 * Without it, shipping the scoped key would read to a designer exactly like the
 * data loss this whole file exists to prevent: they reload into the new build
 * and yesterday's notes are gone, because they are filed under a key nothing
 * asks for any more. The guard on emptiness is what stops it running twice and
 * overwriting work done since.
 *
 * It is deliberately a MOVE. Leaving the old copy behind would resurrect it in
 * the next app the designer switched to, which is the cross-contamination the
 * scope was added to stop.
 */
export function adoptUnscoped(legacyKey: string, scopedKey: string): void {
  if (readScoped(scopedKey) !== null) return
  const legacy = readScoped(legacyKey)
  if (legacy === null) return
  writeScoped(scopedKey, legacy)
  dropScoped(legacyKey)
}
