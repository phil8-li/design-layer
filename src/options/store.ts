/**
 * Saved styles: client cache plus HTTP persistence.
 *
 * Editor state is the only cache — panels read `optionSets` from the store they
 * already subscribe to, so a style saved in the inspector cannot disagree with
 * what another lane sees. The server file is the durable copy, and a PUT
 * replaces the whole set for a key, which is why nothing here may send a set
 * built before the persisted ones arrived.
 *
 * ## The load, as a machine
 *
 *   idle    --ready() / an edit-->          loading
 *   loading --200-->                        ready    (queued edits replayed onto the loaded sets, then sent)
 *   loading --error-->                      failed   (retry timer armed; queued edits kept)
 *   failed  --an edit / retry timer-->      loading
 *   ready   --an edit-->                    ready    (shown at once and sent)
 *
 * An edit is a function from a set to the next set (`Edit`). While the load is
 * not `ready` it is applied to what is on screen, so the panel answers at once,
 * and queued; when the load lands it is replayed onto what the server holds, so
 * saving one style before the GET answered — or after it failed — can never
 * PUT a set that is missing the styles already saved. A late load also cannot
 * drop an edit made while it was in flight, for the same reason.
 *
 * `loadState()` is the one reader; `begin`, `landed` and `failedWith` are the
 * only writers. The first `ready()` is called at boot by the layers panel, whose
 * saved-style counts read the same `optionSets`.
 */

import { getState, setState } from "../core/store"
import type { EditorContext } from "../core/context"
import type { StyleWrite, Writer } from "../core/writer"
import type { ElementOption, ElementOptionSet, LayerElement, Selection, StyleEdit } from "../core/types"
import { SCOPE_LABELS, scopeOwnsClass, scopeOwnsProperty, sliceSnapshot, slicesEqual } from "./scopes"
import type { StyleScope } from "./scopes"

/** The element state a style captures and restores. */
export interface OptionSnapshot {
  className: string
  style: StyleEdit
  text?: string
}

/** Where the persisted sets are, as far as this tab knows. */
export type OptionsLoad =
  | { kind: "idle" }
  | { kind: "loading"; promise: Promise<void> }
  | { kind: "ready" }
  | { kind: "failed"; reason: string }

interface OptionsStore {
  /**
   * Starts the load once. Resolves when it settles, either way; a failed load
   * is retried by the next edit or by a timer, not by asking again.
   */
  ready(): Promise<void>
  loadState(): OptionsLoad
  get(key: string): ElementOptionSet | null
  rename(key: string, id: string, name: string): void
  hasBaseline(key: string): boolean

  /*
   * Scoped styles. Each Design-tab section offers the saved styles that own
   * its slice of the element — text styles in Typography, color styles in
   * Fill — and applying one touches that slice only. Which one is "active" is
   * computed from the element rather than stored, because a manual edit to the
   * font size should un-highlight the text style without anyone remembering to.
   */
  /** Options whose scope matches, plus legacy unscoped ones; never the baseline. */
  stylesFor(key: string, scope: StyleScope): ElementOption[]
  /** The first style whose slice equals the element's current slice, or null. */
  activeStyleId(selection: Selection, scope: StyleScope): string | null
  /** Saves the element's current slice as a new style. Does not restyle. */
  saveScoped(selection: Selection, writer: Writer, scope: StyleScope): ElementOption
  /** Applies only `option`'s slice; everything outside the scope is untouched. */
  applyScoped(selection: Selection, writer: Writer, option: ElementOption, scope: StyleScope): void
  /** Overwrites `id` with the element's current slice. No-op for the baseline. */
  updateScoped(selection: Selection, id: string, scope: StyleScope): void
  /** Applies the baseline's slice. False when there is no baseline. */
  revertScoped(selection: Selection, writer: Writer, scope: StyleScope): boolean
  /** Deletes a style without restyling the element. */
  removeStyle(selection: Selection, id: string): void
}

/** One change to one key's set; null deletes the set. Pure, so it can be replayed. */
type Edit = (set: ElementOptionSet | null) => ElementOptionSet | null

/** How long a failed load waits before it asks again on its own. */
const RETRY_MS = 5000

/**
 * Reserved id for the pre-option snapshot.
 *
 * The baseline is stored *as an option* rather than as a field on the set
 * because the server's `normalizeOptionSet` rebuilds every set from exactly
 * four properties and silently drops anything else — a top-level `baseline`
 * would not survive the PUT round-trip, but an entry in `options[]` does. It is
 * filtered out of everything a user sees by `visibleOptions`.
 */
export const BASELINE_OPTION_ID = "baseline:pre-option-state"

/**
 * Session-only mirror of the baseline. Kept alongside the persisted copy so
 * sets written before baselines were durable keep behaving as they did.
 */
const baselines = new Map<string, OptionSnapshot>()

let cached: OptionsStore | null = null

/** The options a designer saved, without the reserved baseline entry. */
export function visibleOptions(set: ElementOptionSet | null | undefined): ElementOption[] {
  if (!set) return []
  return set.options.filter((option) => option.id !== BASELINE_OPTION_ID)
}

/** Captures what a style needs to reproduce the element's current look. */
function captureSnapshot(element: LayerElement): OptionSnapshot {
  const style: StyleEdit = {}
  for (const property of Array.from(element.style)) {
    style[property] = element.style.getPropertyValue(property)
  }
  // `className` is not a string on SVG nodes, and icons are SVG nodes.
  const snapshot: OptionSnapshot = { className: element.getAttribute("class") ?? "", style }
  if (element.children.length === 0) snapshot.text = element.textContent ?? ""
  return snapshot
}

/**
 * Restores one scope of a snapshot. It may only remove what the scope owns: a
 * class or declaration it cannot classify, or that belongs to another section,
 * is left exactly where it was. An empty value removes a declaration, which is
 * how a style drops a property the element picked up after it was saved.
 */
function applySlice(
  selection: Selection,
  writer: Writer,
  snapshot: OptionSnapshot,
  scope: StyleScope,
  summary: string
): void {
  const element = selection.element
  const slice = sliceSnapshot(snapshot, scope)
  const current = Array.from(element.classList)
  const next = slice.className.split(/\s+/).filter(Boolean)
  const remove = current.filter((name) => scopeOwnsClass(scope, name) && !next.includes(name))
  const add = next.filter((name) => !current.includes(name))
  if (remove.length || add.length) writer.applyClasses(selection, { remove, add }, summary)

  const writes: StyleWrite[] = []
  for (const property of Array.from(element.style)) {
    if (scopeOwnsProperty(scope, property) && !(property in slice.style)) {
      writes.push({ property, value: "" })
    }
  }
  for (const [property, value] of Object.entries(slice.style)) {
    if (element.style.getPropertyValue(property) !== value) writes.push({ property, value })
  }
  if (writes.length) writer.applyStyles(selection, writes, summary)
}

/** "Text style" -> "text style", for summaries that read as a sentence. */
function scopeNoun(scope: StyleScope): string {
  return SCOPE_LABELS[scope].toLowerCase()
}

function sliceIsEmpty(slice: OptionSnapshot): boolean {
  return !slice.className.trim() && Object.keys(slice.style).length === 0
}

function snapshotOf(option: ElementOption): OptionSnapshot {
  return { className: option.className, style: option.style, text: option.text }
}

function baselineEntry(snapshot: OptionSnapshot): ElementOption {
  return {
    id: BASELINE_OPTION_ID,
    name: "Before options",
    className: snapshot.className,
    style: snapshot.style,
    text: snapshot.text,
    createdAt: Date.now(),
  }
}

/** The persisted baseline first, then the session mirror for older sets. */
export function baselineOf(set: ElementOptionSet | null, key: string): OptionSnapshot | null {
  const stored = set?.options.find((option) => option.id === BASELINE_OPTION_ID)
  if (stored) return snapshotOf(stored)
  return baselines.get(key) ?? null
}

function emptySet(selection: Selection): ElementOptionSet {
  return { key: selection.key, label: selection.componentName, activeOptionId: null, options: [] }
}

/** `set` with `snapshot` recorded as its baseline, unless it already has one. */
function withBaselineEntry(set: ElementOptionSet, snapshot: OptionSnapshot): ElementOptionSet {
  if (set.options.some((option) => option.id === BASELINE_OPTION_ID)) return set
  return { ...set, options: [baselineEntry(snapshot), ...set.options] }
}

/**
 * The sets in a `GET /options` answer, or null when it is not a map at all.
 * An entry that is not a set is dropped rather than drawn: every reader walks
 * `options`, and one malformed entry would throw in the tree's render.
 */
function setsIn(value: unknown): Record<string, ElementOptionSet> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const sets: Record<string, ElementOptionSet> = {}
  for (const [key, set] of Object.entries(value)) {
    if (typeof set === "object" && set !== null && Array.isArray((set as ElementOptionSet).options)) {
      sets[key] = set as ElementOptionSet
    }
  }
  return sets
}

function createStore(editor: EditorContext): OptionsStore {
  let load: OptionsLoad = { kind: "idle" }
  /** Edits made before the load landed, per key, oldest first. */
  const queued = new Map<string, Edit[]>()
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const url = (key?: string) =>
    key === undefined
      ? `${editor.apiBase}/options`
      : `${editor.apiBase}/options/${encodeURIComponent(key)}`

  const setLocal = (key: string, set: ElementOptionSet | null) => {
    const sets = { ...getState().optionSets }
    if (set) sets[key] = set
    else delete sets[key]
    setState({ optionSets: sets })
  }

  /** The durable copy of one key: a PUT for a set, a DELETE for none. */
  const persist = (key: string, set: ElementOptionSet | null) => {
    const request = set
      ? fetch(url(key), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(set),
        })
      : fetch(url(key), { method: "DELETE" })
    void request
      .then((response) => {
        // Without the status check a rejected DELETE — an invalid key, a
        // read-only state dir — resolves normally, so the row leaves the UI,
        // the file keeps the set, and it silently returns on next reload.
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      })
      // The element on screen already wears the style; only the durable copy
      // failed. "Try again" is the whole recovery, and without it the reader is
      // told a write failed with no idea whether to redo the styling as well.
      .catch(() =>
        editor.toast(set ? "Could not save this style. Try again." : "Could not delete these styles. Try again.", "error")
      )
  }

  const landed = (loaded: Record<string, ElementOptionSet>) => {
    const sets = { ...loaded }
    const touched = Array.from(queued.keys())
    for (const key of touched) {
      let set: ElementOptionSet | null = sets[key] ?? null
      for (const edit of queued.get(key) ?? []) set = edit(set)
      if (set) sets[key] = set
      else delete sets[key]
    }
    queued.clear()
    load = { kind: "ready" }
    setState({ optionSets: sets })
    for (const key of touched) persist(key, sets[key] ?? null)
  }

  const failedWith = (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn("[designlayer] could not load saved styles", error)
    load = { kind: "failed", reason }
    // An edit is waiting on this load, so the reader believes it saved. Said
    // once per failure, in the words a failed PUT uses; the retry still runs.
    if (queued.size > 0) editor.toast("Could not save this style. Try again.", "error")
    retryTimer = setTimeout(begin, RETRY_MS)
    // A retry must not hold a test runner or a closing page open.
    ;(retryTimer as { unref?: () => void }).unref?.()
  }

  function begin(): void {
    if (load.kind === "loading" || load.kind === "ready") return
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
    const promise = (async () => {
      let sets: Record<string, ElementOptionSet> | null
      try {
        const response = await fetch(url(), { headers: { accept: "application/json" } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        sets = setsIn(await response.json())
        if (!sets) throw new Error("the saved styles were not an object")
      } catch (error) {
        failedWith(error)
        return
      }
      // Outside the try: a panel that throws while repainting is not a failed load.
      landed(sets)
    })()
    load = { kind: "loading", promise }
  }

  /**
   * The one path a style change takes. Shown at once; sent now when the
   * persisted sets are known, queued for the load otherwise.
   */
  const change = (key: string, edit: Edit) => {
    const before = getState().optionSets[key] ?? null
    const after = edit(before)
    if (after === before) return
    setLocal(key, after)
    if (load.kind === "ready") {
      persist(key, after)
      return
    }
    queued.set(key, [...(queued.get(key) ?? []), edit])
    begin()
  }

  /**
   * The element's pre-style look, captured the first time it gains a style.
   * Persisting it is what lets "revert" still work after a reload — the
   * session Map alone dies with the page, which left elements permanently
   * stuck in a deleted style's styling.
   */
  const baselineFor = (selection: Selection): OptionSnapshot => {
    let snapshot = baselines.get(selection.key)
    if (!snapshot) baselines.set(selection.key, (snapshot = captureSnapshot(selection.element)))
    return snapshot
  }

  /*
   * A legacy whole-element option is offered only where it has something to
   * say. One saved before scopes existed with no stroke in it would otherwise
   * sit in Stroke as an empty style — and, matching an element with no stroke,
   * read as the style that element is wearing.
   */
  const stylesFor = (key: string, scope: StyleScope): ElementOption[] =>
    visibleOptions(getState().optionSets[key] ?? null)
      .filter((option) =>
        option.scope === undefined ? !sliceIsEmpty(sliceSnapshot(snapshotOf(option), scope)) : option.scope === scope
      )
      .sort((a, b) => a.createdAt - b.createdAt)

  return {
    stylesFor,

    activeStyleId(selection, scope) {
      const current = sliceSnapshot(captureSnapshot(selection.element), scope)
      const match = stylesFor(selection.key, scope).find((option) =>
        slicesEqual(sliceSnapshot(snapshotOf(option), scope), current)
      )
      return match?.id ?? null
    },

    saveScoped(selection, _writer, scope) {
      const baseline = baselineFor(selection)
      const shown = getState().optionSets[selection.key] ?? null
      const count = visibleOptions(shown).filter((option) => option.scope === scope).length
      const slice = sliceSnapshot(captureSnapshot(selection.element), scope)
      const option: ElementOption = {
        id: crypto.randomUUID(),
        name: `${SCOPE_LABELS[scope]} ${count + 1}`,
        className: slice.className,
        style: slice.style,
        createdAt: Date.now(),
        scope,
      }
      change(selection.key, (set) => {
        const base = withBaselineEntry(set ?? emptySet(selection), baseline)
        return { ...base, options: [...base.options, option] }
      })
      return option
    },

    applyScoped(selection, writer, option, scope) {
      const baseline = baselineFor(selection)
      applySlice(selection, writer, snapshotOf(option), scope, `Apply ${scopeNoun(scope)} "${option.name}"`)
      // Only a newly recorded baseline needs persisting; the style itself is
      // unchanged, and an edit that returns its input sends nothing.
      change(selection.key, (set) => withBaselineEntry(set ?? emptySet(selection), baseline))
    },

    updateScoped(selection, id, scope) {
      const shown = getState().optionSets[selection.key]
      if (id === BASELINE_OPTION_ID || !shown?.options.some((option) => option.id === id)) return
      const slice = sliceSnapshot(captureSnapshot(selection.element), scope)
      change(selection.key, (set) =>
        set && set.options.some((option) => option.id === id)
          ? {
              ...set,
              options: set.options.map((option) =>
                option.id === id
                  ? { ...option, className: slice.className, style: slice.style, text: undefined, scope }
                  : option
              ),
            }
          : set
      )
    },

    revertScoped(selection, writer, scope) {
      const baseline = baselineOf(getState().optionSets[selection.key] ?? null, selection.key)
      if (!baseline) return false
      applySlice(selection, writer, baseline, scope, `Revert ${scopeNoun(scope)}`)
      return true
    },

    removeStyle(selection, id) {
      if (id === BASELINE_OPTION_ID) return
      const shown = getState().optionSets[selection.key]
      if (!shown || !shown.options.some((option) => option.id === id)) return
      change(selection.key, (set) => {
        if (!set) return set
        const options = set.options.filter((option) => option.id !== id)
        // The last visible style takes its baseline and the whole set with it.
        return visibleOptions({ ...set, options }).length === 0 ? null : { ...set, options }
      })
      if (!getState().optionSets[selection.key]) baselines.delete(selection.key)
    },

    rename(key, id, name) {
      if (id === BASELINE_OPTION_ID || !getState().optionSets[key]) return
      change(key, (set) =>
        set ? { ...set, options: set.options.map((option) => (option.id === id ? { ...option, name } : option)) } : set
      )
    },

    ready() {
      if (load.kind === "idle") begin()
      return load.kind === "loading" ? load.promise : Promise.resolve()
    },

    loadState: () => load,

    get(key) {
      return getState().optionSets[key] ?? null
    },

    hasBaseline(key) {
      return baselineOf(getState().optionSets[key] ?? null, key) !== null
    },
  }
}

/** One store per session; the inspector rebuilds its DOM on every render. */
export function optionsStore(editor: EditorContext): OptionsStore {
  cached ??= createStore(editor)
  return cached
}
