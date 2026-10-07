/**
 * The annotation store: the notes, the settings, and who is listening.
 *
 * Deliberately shaped like `core/store.ts` — a module-scoped value, a listener
 * set, and no framework — because the same rule applies for the same reason:
 * the canvas paints markers, the panel lists them, and the brief serializes
 * them, and three readers of one fact must not each keep their own copy.
 *
 * Notes live HERE and edits live in `journal.ts`, separately, until something
 * asks for both. They are produced by unrelated machinery — one by a pointer
 * gesture, one by every write the editor makes — and merging them at the
 * source would put the writer's hot path through this module for no reason.
 *
 * Where a note is FILED is not this module's argument to make. A note belongs to
 * one app and one page, and `core/app-scope.ts` owns both the key and the
 * reasoning behind it — anything else the editor remembers between reloads has
 * to be filed the same way, and two implementations of "which app is this" would
 * eventually disagree about one session.
 */

import { adoptUnscoped, appScopedKey, readScoped, writeScoped } from "../core/app-scope"
import {
  DEFAULT_SETTINGS,
  type AnnotationRecord,
  type AnnotationRect,
  type AnnotationSettings,
} from "./types"

/**
 * Per app and per page. The prefix alone is not a key — `storageKey()` builds
 * the rest.
 *
 * Notes are about what is on screen, and `/pricing` and `/settings` share
 * nothing worth carrying between them. Agentation keys its own local store the
 * same way, and the reason shows up the first time you annotate two routes and
 * come back to find one list holding both. The app half arrived later with the
 * chooser, and `core/app-scope.ts` is where that argument is written down.
 */
const STORAGE_PREFIX = "designlayer.annotations."

/**
 * Deliberately NOT app-scoped, unlike the notes.
 *
 * Read `AnnotationSettings` and every field in it is a fact about how the person
 * works: how verbose they want the brief, which marker colour is legible to them
 * against the page they are on, whether a click while annotating should reach
 * the app. None of them is a fact about an app. Scoping these would mean the
 * designer who picked a marker colour that survives a red page gets the default
 * blue back the moment they switch apps, and sets it again per app forever.
 *
 * `hideUntilRestart` is the one field that must not travel between sessions at
 * all, and it already does not — `load()` refuses it on read, whichever key it
 * arrived under.
 */
const SETTINGS_KEY = "designlayer.annotation-settings"

/**
 * Notes older than this are dropped on read.
 *
 * A week is long enough that a note survives a weekend, and short enough that
 * a stale list never becomes the thing that makes the feature untrustworthy.
 * The same window Agentation uses, and for the same reason.
 */
const RETENTION_DAYS = 7

let notes: AnnotationRecord[] = []
let settings: AnnotationSettings = { ...DEFAULT_SETTINGS }
let loaded = false

const listeners = new Set<() => void>()
const settingsListeners = new Set<() => void>()

function announce(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      // One panel failing to repaint must not stop the canvas repainting.
      console.warn("[designlayer] annotation listener failed", error)
    }
  }
}

function announceSettings(): void {
  for (const listener of [...settingsListeners]) {
    try {
      listener()
    } catch (error) {
      console.warn("[designlayer] annotation settings listener failed", error)
    }
  }
}

/**
 * The key for this app's copy of this page's notes.
 *
 * Two halves, added for different reasons. The pathname predates the app
 * chooser and stays: two ROUTES of one app are still two sets of notes. The app
 * half is what the chooser made necessary, because switching apps is a reload of
 * the same document on the same path — without it the shop's notes are what the
 * docs site opens with.
 *
 * Recomputed on every call rather than held in a constant. Holding it would be
 * safe for the app half, which `appScope()` derives from `config` and `config`
 * is frozen at module load, so nothing can change it under a live page. It would
 * not be safe for the pathname, which moves whenever the document does.
 */
function storageKey(): string {
  return appScopedKey(STORAGE_PREFIX)
}

/**
 * The key a build from before the chooser wrote to, and the only thing that
 * still reads it.
 *
 * It has to be this string exactly. Adopting from a key nothing ever wrote to
 * succeeds silently and leaves the designer reloading into the new build to find
 * yesterday's notes gone, which is the failure the adoption exists to prevent.
 */
function legacyStorageKey(): string {
  return `${STORAGE_PREFIX}${window.location.pathname}`
}

function withinRetention(note: AnnotationRecord): boolean {
  const age = Date.now() - Date.parse(note.createdAt)
  return Number.isFinite(age) ? age < RETENTION_DAYS * 24 * 60 * 60 * 1000 : true
}

/**
 * A rect the painter can subtract a scroll offset from, or nothing.
 *
 * `AnnotationRect` is four required numbers in the type and that is worth
 * exactly as much as the source of the object: this one is `JSON.parse` of a
 * string out of `localStorage`, which anything on the machine can write and
 * which a build from any past or future version may have written. The compiler
 * is asserting a shape it never saw.
 */
function isRect(value: unknown): value is AnnotationRect {
  if (!value || typeof value !== "object") return false
  const rect = value as Record<string, unknown>
  // Finite, not merely `number`: `JSON.parse` yields no NaN, but a rect built
  // from one arrives as null and would put the marker at `NaN` px, which paints
  // nothing and reports no error.
  return (["x", "y", "width", "height"] as const).every(
    (axis) => typeof rect[axis] === "number" && Number.isFinite(rect[axis] as number)
  )
}

/**
 * One stored note, or nothing — the boundary the rest of this module trusts.
 *
 * Every field the painter and the panel read without checking is required here,
 * because a record missing one is not a note with a gap in it: `paint` runs on
 * every frame and reads `note.rect.x` on the fallback path, so a single rect-less
 * record throws inside the `requestAnimationFrame` callback, takes the whole
 * overlay draw down with it, and does it again on the next frame. The editor
 * that lands in is not missing one pin — it has no selection outline, no hover
 * highlight and no pins at all, with a console error that names the painter
 * rather than the data. It was a seeded record with no `rect` that produced
 * exactly that, and nothing between the storage read and the frame had an
 * opinion about the shape.
 *
 * Dropped rather than repaired. A default rect would put somebody's note at the
 * top-left corner of a page it was never about, which is a wrong answer wearing
 * the costume of a right one; the note is unanchored and unrecoverable, and the
 * honest outcome is that it is gone.
 */
function isStoredNote(value: unknown): value is AnnotationRecord {
  if (!value || typeof value !== "object") return false
  const note = value as Record<string, unknown>
  if (typeof note.id !== "string" || !note.id) return false
  if (typeof note.comment !== "string") return false
  if (typeof note.createdAt !== "string") return false
  return isRect(note.rect)
}

/**
 * Notes are rehydrated WITHOUT their live element.
 *
 * `element` is a DOM node and cannot be serialized, so a reloaded note paints
 * from its stored page rect alone. That is the honest state: the node it
 * pointed at may not exist any more, and a marker that silently re-attached
 * itself to whatever now sits at that selector would be a note about something
 * nobody wrote.
 */
function load(): void {
  if (loaded) return
  loaded = true

  const rawSettings = readScoped(SETTINGS_KEY)
  if (rawSettings) {
    try {
      const parsed = JSON.parse(rawSettings) as Partial<AnnotationSettings>
      // Merged over the defaults rather than replacing them, so a settings blob
      // written by an older build is missing keys rather than breaking the panel.
      settings = { ...DEFAULT_SETTINGS, ...parsed }
      /*
       * And keys the defaults DON'T have are dropped, which is the other half of
       * the same bargain.
       *
       * A retired setting is not inert once it is on disk: the spread above puts
       * it back into the live object, `persist` writes it out again, and it
       * outlives every build that ever read it. `includeComponents` is the first
       * one to go this way — the editor detects React or Angular itself now, so
       * a stored `false` is an answer to a question nobody asks. Filtering by
       * the defaults' own keys means the next retirement needs no code here —
       * and `markerColor` went the same way: pins wear the chrome's indigo
       * accent now, so a stored hex from the old swatches is simply dropped.
       */
      const live = settings as unknown as Record<string, unknown>
      for (const key of Object.keys(live)) {
        if (!(key in DEFAULT_SETTINGS)) delete live[key]
      }
    } catch {
      settings = { ...DEFAULT_SETTINGS }
    }
  }
  // Never restored, whatever is on disk: this one is per-tab by definition, and
  // a session that started with every marker hidden looks like a broken build.
  settings.hideUntilRestart = false
  /*
   * And `scope`, for a harder reason than "per tab".
   *
   * The switch that set it is gone from the settings fold, so a stored
   * `"editor"` is not a preference any more — it is a mode with no control to
   * leave by, on a session that would open with every click landing on the
   * editor's own panels instead of the app. `DEFAULT_SETTINGS` has always
   * claimed this value does not travel between sessions; it does, because
   * `persist` writes the whole blob, and this is the line that makes the claim
   * true. The key stays in the defaults on purpose: dropping it would make the
   * retirement filter above delete it from stored blobs, and `canvas.ts` still
   * reads it.
   */
  settings.scope = "app"

  const key = storageKey()
  // Whatever an older build left under the unscoped key belongs to somebody, and
  // nothing asks for that key any more. Moved here, before the read, so the
  // first load of the new build finds it: `adoptUnscoped` is a move rather than
  // a copy and refuses to run once this app's bucket has anything in it, both
  // for reasons written out at its own definition.
  adoptUnscoped(legacyStorageKey(), key)

  const raw = readScoped(key)
  if (!raw) return
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      // Shape first, age second. `withinRetention` reads `createdAt` off a
      // record this function has not yet established IS a record, and the
      // painter downstream reads `rect` off it every frame — so the filter that
      // decides what a note IS has to run before anything reads a field.
      notes = parsed
        .filter(isStoredNote)
        .filter(withinRetention)
        .map((note) => ({ ...note, element: null }))
    }
  } catch {
    notes = []
  }
}

function persist(): void {
  // `element` is dropped explicitly rather than left to `JSON.stringify` to
  // choke on: a DOM node in the payload throws a cyclic-structure error, which
  // would take the whole write down and lose the notes that CAN be stored.
  const portable = notes.map(({ element: _element, ...rest }) => rest)
  writeScoped(storageKey(), JSON.stringify(portable))
}

/** Every note for this page, oldest first. */
export function annotations(): AnnotationRecord[] {
  load()
  return notes
}

export function onAnnotationsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function onSettingsChange(listener: () => void): () => void {
  settingsListeners.add(listener)
  return () => settingsListeners.delete(listener)
}

/**
 * A counter, not a timestamp.
 *
 * Two markers dropped in the same millisecond are two notes, and an id that
 * collided would have the panel resolve both when the user dismissed one.
 */
let sequence = 0

export function addAnnotation(
  input: Omit<AnnotationRecord, "id" | "createdAt" | "status">
): AnnotationRecord {
  load()
  sequence += 1
  const note: AnnotationRecord = {
    ...input,
    id: `ann-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  }
  notes = [...notes, note]
  persist()
  announce()
  return note
}

export function updateAnnotation(id: string, patch: Partial<AnnotationRecord>): void {
  load()
  const index = notes.findIndex((note) => note.id === id)
  if (index === -1) return
  notes = notes.map((note) => (note.id === id ? { ...note, ...patch, id: note.id } : note))
  persist()
  announce()
}

/**
 * Deletes a note and hands back what it took, so the caller can offer it back.
 *
 * ## Why this returns something now
 *
 * Every other destructive act in this editor is recoverable. An element delete
 * and a style change go through `core/history.ts`; a revert restores what it
 * reverted; clearing every note arms first and says what it will cost. Deleting
 * ONE note was the last irreversible single click in the product — and it is
 * irreversible over the one thing on screen the user typed themselves. A note
 * cannot be recovered from a source file the way an edit can, because it was
 * never written to one.
 *
 * The row control is right to ask nothing, and `tab-annotations.ts` argues it:
 * a control used on most rows in a session cannot confirm every time. Confirm
 * and undo are alternatives rather than a pair, so the row keeps its single
 * click and this returns the note instead — the cheaper half for the reader as
 * well as for the code.
 *
 * The INDEX comes back with it because this list is ordered, and the order is
 * the order the notes were taken in. Restoring onto the end would quietly
 * reorder a brief the designer is about to hand over: a second edit nobody
 * asked for, made while undoing the first.
 */
export function removeAnnotation(id: string): { note: AnnotationRecord; index: number } | null {
  load()
  const index = notes.findIndex((note) => note.id === id)
  if (index === -1) return null
  const note = notes[index]
  notes = [...notes.slice(0, index), ...notes.slice(index + 1)]
  persist()
  announce()
  return { note, index }
}

/**
 * Puts a deleted note back where it was.
 *
 * The inverse of `removeAnnotation`, and deliberately NOT "add it again".
 * `addAnnotation` mints a fresh id and a fresh `createdAt`, so a note restored
 * through it would be a different note that merely reads the same: the new id
 * breaks any marker, row or pending handover still pointing at the old one, and
 * the new timestamp moves it in anything that sorts by age.
 *
 * Restored at the recorded index, clamped, because the list can have moved
 * while the toast was up — notes can be dropped from the canvas at any moment,
 * and the whole list can be cleared. A no-op if the id is somehow present
 * again, so that a double-pressed Undo cannot produce two of the same note.
 */
export function restoreAnnotation(note: AnnotationRecord, index: number): void {
  load()
  if (notes.some((existing) => existing.id === note.id)) return
  const at = Math.max(0, Math.min(index, notes.length))
  notes = [...notes.slice(0, at), note, ...notes.slice(at)]
  persist()
  announce()
}

export function clearAnnotations(): void {
  load()
  if (!notes.length) return
  notes = []
  persist()
  announce()
}

export function annotationSettings(): AnnotationSettings {
  load()
  return settings
}

export function updateSettings(patch: Partial<AnnotationSettings>): void {
  load()
  const next = { ...settings, ...patch }
  settings = next
  // `hideUntilRestart` is written out with the rest and filtered on read, which
  // is cheaper than maintaining a second key and cannot drift out of sync with
  // it. `load()` forces it back to false.
  writeScoped(SETTINGS_KEY, JSON.stringify(next))
  announceSettings()
  // The marker layer reads BOTH — colour and visibility live in settings, and
  // nothing else would tell it to repaint.
  announce()
}

/**
 * Whether markers should be on screen at all right now.
 *
 * Asked as a function, for the same reason `editorOwnsInput()` is: two readers
 * of "should this be painted" that each assemble the answer themselves will
 * disagree, and the symptom is a marker layer that is half there.
 */
export function markersVisible(): boolean {
  return !annotationSettings().hideUntilRestart
}

/* ---------- which marker layer owns the canvas ---------- */

/**
 * There are two things that pin a badge to an element, and only one of them may
 * be on screen.
 *
 * A note pin and an audit badge are drawn at the same place by construction:
 * both anchor to the TOP-LEFT corner of the element they are about, because
 * that is the one corner every box has in the same place whatever its size and
 * whatever its writing direction. Run both layers at once on a real page and
 * the badges do not sit beside each other, they sit ON each other — a 22px disc
 * and a 20px plate sharing a coordinate, with whichever was appended last
 * covering the other. Neither is then readable, neither is clickable, and the
 * one that lost is invisible rather than obviously hidden, which is worse: the
 * user reads it as a note that was never saved, or as an audit finding the
 * editor failed to mark.
 *
 * So the two layers are exclusive, and the exclusion is ONE VALUE rather than a
 * boolean each. Two booleans spell four states and only three of them are
 * describable — the fourth is "both", which is exactly the broken screen above.
 * This is the same argument `core/store.ts` makes for `EditorMode` over its
 * `interactive`/`annotating` pair, and it is here for the same reason: an
 * illegal combination that cannot be represented needs no call site to remember
 * to clear the other flag.
 *
 * It lives in the ANNOTATION store, not the lint store, because the annotation
 * layer is the one that ships without the other. The canvas pins have to know
 * whether they are the layer in charge whether or not an audit has ever been
 * run, and an import from `annotations` into `lint` — the direction this way
 * round — is the one that keeps notes working on a page that has no linter.
 *
 * Two values and not three. There is no `"none"`, because "show nothing" is
 * already sayable and adding a third state would give it a second spelling: the
 * notes layer in charge with `hideUntilRestart` set paints no pins, and the
 * audit is not the layer in charge, so the canvas is clean. A third value would
 * be a state two settings could disagree about, which is the whole thing this
 * type exists to prevent.
 */
export type MarkerLayer = "notes" | "audit"

/**
 * Notes by default, because notes are what exists before an audit is run.
 *
 * Not persisted, and that matches `hideUntilRestart`'s reasoning: a session
 * that opened showing audit badges from yesterday's run — over findings nobody
 * has re-measured — would be the editor asserting something it has not checked.
 */
let activeLayer: MarkerLayer = "notes"

const layerListeners = new Set<() => void>()

export function markerLayer(): MarkerLayer {
  return activeLayer
}

export function setMarkerLayer(next: MarkerLayer): void {
  if (activeLayer === next) return
  activeLayer = next
  for (const listener of [...layerListeners]) {
    try {
      listener()
    } catch (error) {
      console.warn("[designlayer] marker layer listener failed", error)
    }
  }
  // The note pins listen on the settings channel and know nothing about this
  // module's third listener set, so the change is announced there too. Both,
  // not one: the panel footers read the layer, and the canvas reads visibility.
  announceSettings()
  announce()
}

export function onMarkerLayerChange(listener: () => void): () => void {
  layerListeners.add(listener)
  return () => layerListeners.delete(listener)
}

/**
 * Whether the NOTE pins specifically should be painted.
 *
 * Assembled here rather than at the two places in `canvas.ts` that ask, for the
 * reason `markersVisible` gives one function up: the moment two readers each
 * combine the hide setting with the active layer themselves, one of them will
 * be updated and the other will not, and the symptom is a pin layer that paints
 * but never repaints — or repaints forever with nothing in it.
 */
export function notePinsVisible(): boolean {
  return markersVisible() && activeLayer === "notes"
}

/** Test seam: drop everything in memory without touching what is stored. */
export function resetAnnotationsForTest(): void {
  notes = []
  settings = { ...DEFAULT_SETTINGS }
  loaded = false
  sequence = 0
  activeLayer = "notes"
}
