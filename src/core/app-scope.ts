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
}

export function dropScoped(key: string): void {
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
