/**
 * The ledger of changes "Apply to code" cannot write, and the prompt that hands
 * them to an agent instead.
 *
 * Two paths leave this editor. "Apply to code" is the real one: a class change
 * or a text change goes down the wire, jscodeshift rewrites the JSX, the file
 * on disk changes, and no agent is involved. But the translator only speaks in
 * utility classes and text — an icon swap renames nothing in the JSX, and a CSS
 * property with no Tailwind equivalent has nowhere to land. Those changes are
 * real, they are on screen, and the next hot reload eats them.
 *
 * Before this file they were reported as a count in a toast and then lost. Now
 * they accumulate here with enough context to be acted on — file, element,
 * property, from, to — and "Copy change prompts" puts that on the clipboard as
 * markdown an agent can execute. That is the honest split: everything that can
 * be written is written, and only the remainder becomes a prompt.
 *
 * ## Why the ledger is written down
 *
 * All of the above was true of a list that lived only in memory, which made
 * this list the single copy of work nobody had taken yet: the changes are on
 * screen, they are in no file, and the button under the Prompts tab is the only
 * way they leave the browser. Any reload emptied it — an ordinary hot reload
 * already did, silently, and that was a bug before anything else changed.
 *
 * The app chooser turned it from a bug into a certainty. Switching apps kills
 * this editor process and the supervisor starts another bound to the same proxy
 * port, so from the browser's side a switch IS a reload of the same document on
 * the same origin, with no confirmation step in front of it. A designer would
 * have lost every stranded change by clicking a name in a menu.
 *
 * So the ledger is filed per app through `app-scope`, exactly as the notes are.
 * Switching away files these changes under the app they were made in, switching
 * back brings them out, and a hot reload no longer eats anything. There is no
 * `adoptUnscoped` call to go with it because there is nothing to adopt: this
 * list has never been written to storage under any key.
 */

import { appScopedKey, readScoped, writeScoped } from "./app-scope"
import { isProjectSourcePath } from "./bridge"
import { copyText } from "./clipboard"

export interface PreviewOnlyChange {
  /**
   * Filled in late. The change is recorded the moment it is previewed, but
   * source resolution is a round trip, so the writer patches this in when it
   * lands rather than holding the toast until it does.
   */
  filePath: string | null
  componentName: string
  tagName: string
  className: string
  /**
   * A CSS property in kebab-case, `icon` for a glyph swap, `class` for a class
   * list that was writable but had no file to be written into, or `remove` for
   * an element deleted on screen that no source writer could place.
   */
  property: string
  from: string
  to: string
}

/**
 * Module-scoped for the same reason `writer.ts` keeps its skip list here: the
 * canvas, the inspector and the options panel each build their own writer, and
 * the button that copies the prompt belongs to none of them.
 */
const ledger: PreviewOnlyChange[] = []

/**
 * The bucket these changes are filed in. `app-scope` appends the app and the
 * page, so this becomes something like
 * `designlayer.preview-only.http-127-0-0-1-3000:/pricing`.
 *
 * Named after the entries and not after the tab that shows them. The tab is
 * called Prompts, but a prompt is built on demand from this list and never
 * stored, so a key spelled `change-prompts` would name the derived thing while
 * holding the source one. The shape — `designlayer.`, the feature, then the
 * scope — is `annotations/store.ts`'s, so the editor's two persisted lists sit
 * next to each other wherever someone goes looking for them.
 */
const STORAGE_PREFIX = "designlayer.preview-only."

let loaded = false

/**
 * Where to write, or null when there is nowhere.
 *
 * `readScoped` and `writeScoped` already swallow everything `localStorage`
 * throws for a blocked origin or a full quota, but `appScopedKey` reads
 * `window.location` before either of them is reached, and that is a real case
 * rather than a hypothetical one: this module is pulled in by `writer.ts`, and
 * several suites import the writer in a bare Node process where `window` does
 * not exist at all. No window is not a failure here, it is a session with no
 * storage — the same bargain the blocked-origin case already accepts.
 */
function storageKey(): string | null {
  if (typeof window === "undefined") return null
  return appScopedKey(STORAGE_PREFIX)
}

/**
 * Read on first use, never at module load.
 *
 * The same lazy shape `annotations/store.ts` uses, for a sharper reason: this
 * module is in the bundle's import graph through the writer, so module-scope
 * work here runs before the page has settled and in every test process that
 * touches a write path. `loaded` is set before the read, so a parse that throws
 * still counts as having looked.
 *
 * Stored entries are appended rather than assigned over, so anything already in
 * memory keeps its place at the front. In practice the ledger is empty at this
 * point — every public entry point loads first — and the append is what makes
 * that an invariant rather than an assumption.
 */
function load(): void {
  if (loaded) return
  loaded = true
  const key = storageKey()
  if (!key) return
  const raw = readScoped(key)
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as PreviewOnlyChange[]
    if (Array.isArray(parsed)) ledger.push(...parsed.map(tracked))
  } catch {
    // A blob this build cannot read is dropped whole rather than salvaged. Half
    // an entry is a row in the Prompts tab describing an edit nobody can act
    // on, and the user cannot tell it apart from one that is merely wrong.
  }
}

/**
 * Every field of `PreviewOnlyChange` is a string or null, so the array goes out
 * as it stands. Nothing here is the annotation store's `element`: there is no
 * DOM node to strip, nothing that comes back as a different type than it went
 * in, and no field whose absence would change what a row means.
 */
function persist(): void {
  const key = storageKey()
  if (!key) return
  writeScoped(key, JSON.stringify(ledger))
}

/**
 * The stored record, with `filePath` wired to storage.
 *
 * `recordPreviewOnly` hands the caller back the object it stored so the writer
 * can fill the path in when source resolution lands, a few hundred milliseconds
 * later — see the comment on the field. That patch is a plain assignment
 * through the reference, and a plain assignment cannot call `persist()`: the
 * entry would be written down with the `filePath: null` it was recorded with
 * and reload as a change with no file. That is not a cosmetic loss: whether the
 * path is known is what decides between a prompt that names the file to open
 * and a prompt that asks the agent to go searching for a component by name.
 *
 * So the field is an accessor and the late patch persists itself. The other
 * honest fix was an exported `setChangeFilePath(entry, path)` for `writer.ts`
 * to call instead of assigning, which works just as well and asks every future
 * caller to remember it; this keeps `filePath` a property that reads, writes,
 * spreads and serializes exactly as it did, and keeps the repair inside the
 * module that knows it is needed.
 */
function tracked(change: PreviewOnlyChange): PreviewOnlyChange {
  let filePath = change.filePath
  const entry: PreviewOnlyChange = { ...change }
  Object.defineProperty(entry, "filePath", {
    enumerable: true,
    configurable: true,
    get: () => filePath,
    set: (next: string | null) => {
      if (next === filePath) return
      filePath = next
      persist()
    },
  })
  return entry
}

/**
 * Who to tell when the ledger moves, because nothing else will.
 *
 * The two paths that fill this list run on different clocks. A property the
 * translator cannot spell is recorded inside the commit, in the same task as
 * the keystroke. A property it CAN spell but that turns out to have no file to
 * land in is recorded from `ensureSource(...).then(...)` in `writer.ts` —
 * behind a sourcemap fetch and sometimes a grep, so hundreds of milliseconds
 * after the edit that caused it, and sometimes seconds.
 *
 * The panel had no way to hear about the second one. The inspector repaints
 * from a store subscription and from `refresh()`, and a write to this array is
 * neither. A user who opened the Prompts tab while resolution was still in
 * flight got it rendered from an empty ledger, read "Nothing to hand over yet"
 * over a change that was plainly on screen, and had no action left that would
 * ever correct it — the tab stayed wrong for the rest of the session. So the
 * ledger announces itself, and whoever is showing it listens.
 */
const listeners = new Set<() => void>()

export function onPreviewOnlyChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Copied before it is walked: a listener is free to drop its subscription the
 * moment it hears from us, and deleting from a Set mid-iteration would skip
 * whoever was queued behind it.
 */
function announce(): void {
  for (const listener of [...listeners]) listener()
}

/** Same element, same property — one entry, keeping the original `from`. */
function identityOf(change: PreviewOnlyChange): string {
  return [change.componentName, change.tagName, change.className, change.property].join("|")
}

/**
 * Records a change that will not reach source, and hands back the stored record
 * so a caller that learns the file path afterwards can fill it in.
 *
 * The RETURNED object, and never the one that was passed in. It was already
 * that way whenever a re-edit collapsed onto an existing row, and it is now
 * always that way, because the stored record carries the accessor `tracked`
 * installs and the caller's literal does not. Patching the argument instead
 * writes to an object the ledger has never heard of.
 */
export function recordPreviewOnly(change: PreviewOnlyChange): PreviewOnlyChange {
  // Before the collapse check, or a change made on a reloaded page would not
  // see the one it is a re-edit of and the user would get two rows for it.
  load()
  const identity = identityOf(change)
  const index = ledger.findIndex((entry) => identityOf(entry) === identity)
  if (index !== -1) {
    // Dragging an element writes `transform` on every pointermove. What the
    // user needs in the prompt is where it started and where it ended up, not
    // three hundred intermediate steps.
    const existing = ledger[index]
    existing.to = change.to
    if (!existing.filePath) existing.filePath = change.filePath
    ledger.splice(index, 1)
    ledger.unshift(existing)
    persist()
    announce()
    return existing
  }
  const entry = tracked(change)
  ledger.unshift(entry)
  persist()
  announce()
  return entry
}

/** Everything previewed but not yet writable here, newest first. */
export function previewOnlyChanges(): PreviewOnlyChange[] {
  load()
  return [...ledger]
}

export function clearPreviewOnly(): void {
  // Loaded before it is emptied, even though emptying reads nothing. Without
  // it `loaded` stays false, the next read rehydrates from a copy this call
  // never reached, and the list the user just cleared is back on screen.
  load()
  ledger.length = 0
  persist()
  announce()
}

/**
 * Drops one entry, so a row in the Prompts tab can retract just itself.
 *
 * Matched by `identityOf` rather than by object reference on purpose. The two
 * have to agree: `recordPreviewOnly` COLLAPSES a re-edit of the same element
 * and property onto the stored record, so the object a caller recorded second
 * is not the object in the ledger, while the row the user is looking at is
 * exactly the one that survived the collapse. Identity is the only thing both
 * ends can name, and it is what the row is showing.
 */
export function removePreviewOnly(change: PreviewOnlyChange): boolean {
  load()
  const identity = identityOf(change)
  const index = ledger.findIndex((entry) => identityOf(entry) === identity)
  if (index === -1) return false
  ledger.splice(index, 1)
  persist()
  announce()
  return true
}

function describe(change: PreviewOnlyChange): string {
  const element = change.className
    ? `\`<${change.tagName} class="${change.className}">\``
    : `\`<${change.tagName}>\``
  if (change.property === "icon") {
    return `- ${element} — swap the icon to \`${change.to}\` (currently \`${change.from || "unknown"}\`)`
  }
  if (change.property === "class") {
    // The same fork the icon line makes, for the same reason. A class list is
    // an attribute on the JSX, not a declaration: "set `class` to ..." would
    // send the agent looking for a CSS rule that was never going to exist.
    return `- ${element} — the class attribute becomes \`${change.to}\` (currently \`${change.from || "none"}\`)`
  }
  // The same fork the two above make, and the one with the most to lose by not
  // making it. `attribute:variant` printed as a property would send an agent
  // looking for a CSS declaration called `attribute:variant`; spelled out, it
  // names the prop and the element it belongs to, which is the whole of the
  // edit — neither rewrite lane can write a component prop, so this line is the
  // only way the change ever reaches the file.
  const attribute = /^attribute:(.+)$/.exec(change.property)
  if (attribute) {
    const [, name] = attribute
    if (!change.to) {
      return `- ${element} — remove the \`${name}\` attribute (currently \`${change.from}\`)`
    }
    const from = change.from ? ` (currently \`${change.from}\`)` : ""
    return `- ${element} — set the \`${name}\` attribute to \`${change.to}\`${from}`
  }
  if (change.property === "remove") {
    // An instruction, not a value. This is the one entry that asks for markup
    // to go away rather than for an attribute to read differently, and an agent
    // handed "set `remove` to ``" would have no idea what was wanted.
    return `- ${element} — delete this element, and any import or handler left unused by its removal`
  }
  const from = change.from ? ` (currently \`${change.from}\`)` : ""
  return `- ${element} — set \`${change.property}\` to \`${change.to}\`${from}`
}

const UNKNOWN_FILE = "File not resolved"

/**
 * Agent-ready markdown, grouped by file because that is the unit of work.
 *
 * Deliberately not a chat message. It states what is true, where, and what to
 * change it to, and it says nothing about why — an agent reading this needs the
 * edit, and the person pasting it already knows why they made it.
 */
export function buildChangePrompt(changes: PreviewOnlyChange[] = previewOnlyChanges()): string {
  if (changes.length === 0) {
    return "No changes are waiting. Everything edited so far can be written by Apply to code."
  }

  const byFile = new Map<string, PreviewOnlyChange[]>()
  for (const change of changes) {
    const file =
      change.filePath && isProjectSourcePath(change.filePath) ? change.filePath : UNKNOWN_FILE
    const bucket = byFile.get(file)
    if (bucket) bucket.push(change)
    else byFile.set(file, [change])
  }

  const count = changes.length
  const lines: string[] = [
    "# DesignLayer changes to apply by hand",
    "",
    `${count} visual ${count === 1 ? "change is" : "changes are"} showing in the browser that Apply to code cannot write. Apply ${count === 1 ? "it" : "them"} in the files below.`,
  ]

  for (const [file, entries] of byFile) {
    lines.push("", `## ${file}`)
    if (file === UNKNOWN_FILE) {
      // Naming the component is the whole value of the section: without a path
      // this is the only thing that tells the agent where to look.
      const components = [...new Set(entries.map((entry) => entry.componentName))].filter(Boolean)
      if (components.length) {
        lines.push("", `Search for ${components.map((name) => `\`${name}\``).join(", ")}.`)
      }
    }
    lines.push("")
    for (const entry of entries) lines.push(describe(entry))
  }

  return `${lines.join("\n")}\n`
}

/**
 * What is safe to put on someone's clipboard.
 *
 * Two rules, both borrowed from the app's own agentation copy path, which
 * sanitizes for exactly these reasons. A `**Source:**` line is attribution the
 * resolver is only half-right about — the same overlay that gave us
 * `button.tsx:57` gave us a compiled chunk for the element beside it — so it
 * gets dropped rather than pasted into a prompt as fact. And an absolute path
 * carries the user's home directory and their name; the tail from `src/` is
 * what an agent working in the repo can actually use.
 */
const SOURCE_LINE = /^\*\*Source:\*\*[^\r\n]*(?:\r?\n|$)/gm
// Anchored on the leading slash so it only ever shortens an ABSOLUTE path:
// `packages/ui/src/x.tsx` has an `src/` too, and must survive untouched.
const ABSOLUTE_PREFIX = /(^|[\s`])\/(?:[^\n`]*\/)?(?=src\/)/gm

export function sanitizeChangePrompt(markdown: string): string {
  return shortenAbsolutePaths(markdown.replace(SOURCE_LINE, ""))
}

/**
 * The second rule alone, for text whose `**Source:**` lines are its own.
 *
 * The annotation brief is written in Agentation's format, where `**Source:**`
 * is the field name — and every path on those lines already passed
 * `isProjectSourcePath`, so dropping them would delete the one fact the brief
 * is surest of.
 */
export function shortenAbsolutePaths(markdown: string): string {
  return markdown.replace(ABSOLUTE_PREFIX, "$1")
}

/**
 * Copy the sanitised prompt. Answers whether it landed.
 *
 * Modelled on the app's agentation Copy: the vendor component's own copy is
 * turned off and this runs in its place, synchronously inside the click task so
 * the transient user activation the clipboard requires still holds.
 *
 * There used to be no fallback here, on the claim that the only browsers that
 * reject the Clipboard API are ones that have already told the user why. Chrome
 * rejects it without a word in a frame that does not hold focus, and the Mac
 * app shows every editor in a frame, so the write goes through `copyText` and
 * its command route.
 *
 * It returns a boolean because the catch used to be empty AND the return type
 * `void`, which made success and denial indistinguishable from the outside: a
 * button wired to this could not confirm the copy even if it wanted to, because
 * there was nothing to confirm from. Raising a toast from in here would still
 * be wrong — this is a library function and the surface that owns the button is
 * the one that knows what to say — but refusing to report is a different thing
 * from refusing to announce.
 */
export function copyChangePrompt(markdown?: string): Promise<boolean> {
  // Refused on every route: the change is still on screen and still listed.
  return copyText(sanitizeChangePrompt(markdown ?? buildChangePrompt()))
}

/**
 * Test seam: drop the ledger in memory and forget that storage was ever read,
 * without touching what is in it.
 *
 * The same bargain `resetAnnotationsForTest` strikes, and here it buys a second
 * thing. Clearing memory and re-arming `load()` is precisely what a reload does
 * to this module, so this is how a suite watches an app switch happen without
 * building the bundle again: record, reset, read, and see whether the work came
 * back. `clearPreviewOnly` is the opposite call and deliberately not this one —
 * it empties storage as well, because that is what the user asked for.
 */
export function resetPreviewOnlyForTest(): void {
  ledger.length = 0
  loaded = false
}
