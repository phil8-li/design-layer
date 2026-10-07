/**
 * Saved option sets: client cache plus HTTP persistence.
 *
 * Editor state is the only cache — panels read `optionSets` from the store they
 * already subscribe to, so an option saved in the inspector cannot disagree
 * with what another lane sees. The server file is the durable copy.
 */

import { getState, setState } from "../core/store"
import type { EditorContext } from "../core/context"
import type { StyleWrite, Writer } from "../core/writer"
import type { ElementOption, ElementOptionSet, LayerElement, Selection, StyleEdit } from "../core/types"
import { SCOPE_LABELS, scopeOwnsClass, scopeOwnsProperty, sliceSnapshot, slicesEqual } from "./scopes"
import type { StyleScope } from "./scopes"

/** The element state an option captures and restores. */
export interface OptionSnapshot {
  className: string
  style: StyleEdit
  text?: string
}

export interface OptionsStore {
  /** Loads persisted sets once. Later calls resolve against the same load. */
  ready(): Promise<void>
  get(key: string): ElementOptionSet | null
  apply(selection: Selection, writer: Writer, option: ElementOption): void
  saveCurrent(selection: Selection, writer: Writer): void
  update(selection: Selection, id: string): void
  updateActive(selection: Selection): void
  rename(key: string, id: string, name: string): void
  remove(selection: Selection, writer: Writer, id: string): void
  /** Restores the element's pre-option state without deleting anything. */
  revert(selection: Selection, writer: Writer): boolean
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

/** Captures what an option needs to reproduce the element's current look. */
export function captureSnapshot(element: LayerElement): OptionSnapshot {
  const style: StyleEdit = {}
  for (const property of Array.from(element.style)) {
    style[property] = element.style.getPropertyValue(property)
  }
  // `className` is not a string on SVG nodes, and icons are SVG nodes.
  const snapshot: OptionSnapshot = { className: element.getAttribute("class") ?? "", style }
  if (element.children.length === 0) snapshot.text = element.textContent ?? ""
  return snapshot
}

function applySnapshot(
  selection: Selection,
  writer: Writer,
  snapshot: OptionSnapshot,
  summary: string
): void {
  const element = selection.element
  const current = Array.from(element.classList)
  const next = snapshot.className.split(/\s+/).filter(Boolean)
  const remove = current.filter((name) => !next.includes(name))
  const add = next.filter((name) => !current.includes(name))
  if (remove.length || add.length) writer.applyClasses(selection, { remove, add }, summary)

  const writes: StyleWrite[] = []
  // An empty value removes the declaration, which is how an option drops a
  // property the element picked up after the option was saved.
  for (const property of Array.from(element.style)) {
    if (!(property in snapshot.style)) writes.push({ property, value: "" })
  }
  for (const [property, value] of Object.entries(snapshot.style)) {
    if (element.style.getPropertyValue(property) !== value) writes.push({ property, value })
  }
  if (writes.length) writer.applyStyles(selection, writes, summary)

  if (snapshot.text !== undefined && element.textContent !== snapshot.text) {
    writer.applyText(selection, snapshot.text)
  }
}

/**
 * `applySnapshot` for one scope. Unlike the whole-element version it may only
 * remove what the scope owns: a class or declaration it cannot classify, or
 * that belongs to another section, is left exactly where it was.
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

function nextName(set: ElementOptionSet | null): string {
  return `Option ${visibleOptions(set).length + 1}`
}

function createStore(editor: EditorContext): OptionsStore {
  let loading: Promise<void> | null = null

  const url = (key?: string) =>
    key === undefined
      ? `${editor.apiBase}/options`
      : `${editor.apiBase}/options/${encodeURIComponent(key)}`

  const load = async () => {
    try {
      const response = await fetch(url(), { headers: { accept: "application/json" } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setState({ optionSets: (await response.json()) as Record<string, ElementOptionSet> })
    } catch (error) {
      console.warn("[designlayer] could not load saved options", error)
    }
  }

  const commit = (set: ElementOptionSet) => {
    setState({ optionSets: { ...getState().optionSets, [set.key]: set } })
    void fetch(url(set.key), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(set),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      })
      // The element on screen already wears the option; only the durable copy
      // failed. "Try again" is the whole recovery, and without it the reader is
      // told a write failed with no idea whether to redo the styling as well.
      .catch(() =>
        editor.toast(
          "Could not save this style. Try again.",
          "error"
        )
      )
  }

  const drop = (key: string) => {
    const sets = { ...getState().optionSets }
    delete sets[key]
    setState({ optionSets: sets })
    // Same `response.ok` check as `commit`. Without it a rejected DELETE — an
    // invalid key, a read-only state dir — resolves normally, so the row leaves
    // the UI, the file keeps the set, and it silently returns on next reload.
    void fetch(url(key), { method: "DELETE" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      })
      .catch(() =>
        editor.toast(
          "Could not delete these styles. Try again.",
          "error"
        )
      )
  }

  const setFor = (selection: Selection): ElementOptionSet => {
    return (
      getState().optionSets[selection.key] ?? {
        key: selection.key,
        label: selection.componentName,
        activeOptionId: null,
        options: [],
      }
    )
  }

  /**
   * Records the element's pre-option look the first time it gains an option.
   * Persisting it is what lets "revert" and "delete the active option" still
   * work after a reload — the session Map alone dies with the page, which left
   * elements permanently stuck in a deleted option's styling.
   */
  const withBaseline = (set: ElementOptionSet, selection: Selection): ElementOptionSet => {
    if (!baselines.has(selection.key)) {
      baselines.set(selection.key, captureSnapshot(selection.element))
    }
    if (set.options.some((option) => option.id === BASELINE_OPTION_ID)) return set
    const snapshot = baselines.get(selection.key)
    if (!snapshot) return set
    return { ...set, options: [baselineEntry(snapshot), ...set.options] }
  }

  const update = (selection: Selection, id: string) => {
    const set = setFor(selection)
    if (id === BASELINE_OPTION_ID || !set.options.some((option) => option.id === id)) return
    const snapshot = captureSnapshot(selection.element)
    commit({
      ...set,
      options: set.options.map((option) =>
        option.id === id ? { ...option, ...snapshot } : option
      ),
    })
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
      const set = withBaseline(setFor(selection), selection)
      const slice = sliceSnapshot(captureSnapshot(selection.element), scope)
      const count = visibleOptions(set).filter((option) => option.scope === scope).length
      const option: ElementOption = {
        id: crypto.randomUUID(),
        name: `${SCOPE_LABELS[scope]} ${count + 1}`,
        className: slice.className,
        style: slice.style,
        createdAt: Date.now(),
        scope,
      }
      commit({ ...set, options: [...set.options, option] })
      return option
    },

    applyScoped(selection, writer, option, scope) {
      const set = withBaseline(setFor(selection), selection)
      applySlice(selection, writer, snapshotOf(option), scope, `Apply ${scopeNoun(scope)} "${option.name}"`)
      // Only a newly recorded baseline needs persisting; the style itself is unchanged.
      if (set !== getState().optionSets[selection.key]) commit(set)
    },

    updateScoped(selection, id, scope) {
      const set = setFor(selection)
      if (id === BASELINE_OPTION_ID || !set.options.some((option) => option.id === id)) return
      const slice = sliceSnapshot(captureSnapshot(selection.element), scope)
      commit({
        ...set,
        options: set.options.map((option) =>
          option.id === id
            ? { ...option, className: slice.className, style: slice.style, text: undefined, scope }
            : option
        ),
      })
    },

    revertScoped(selection, writer, scope) {
      const baseline = baselineOf(setFor(selection), selection.key)
      if (!baseline) return false
      applySlice(selection, writer, baseline, scope, `Revert ${scopeNoun(scope)}`)
      return true
    },

    removeStyle(selection, id) {
      if (id === BASELINE_OPTION_ID) return
      const set = getState().optionSets[selection.key]
      if (!set || !set.options.some((option) => option.id === id)) return
      const options = set.options.filter((option) => option.id !== id)
      if (visibleOptions({ ...set, options }).length === 0) {
        baselines.delete(selection.key)
        drop(selection.key)
        return
      }
      commit({
        ...set,
        activeOptionId: set.activeOptionId === id ? null : set.activeOptionId,
        options,
      })
    },

    ready() {
      loading ??= load()
      return loading
    },

    get(key) {
      return getState().optionSets[key] ?? null
    },

    hasBaseline(key) {
      return baselineOf(getState().optionSets[key] ?? null, key) !== null
    },

    apply(selection, writer, option) {
      const set = withBaseline(setFor(selection), selection)
      applySnapshot(selection, writer, snapshotOf(option), `Apply style "${option.name}"`)
      commit({ ...set, activeOptionId: option.id })
    },

    revert(selection, writer) {
      const set = setFor(selection)
      const baseline = baselineOf(set, selection.key)
      if (!baseline) return false
      applySnapshot(selection, writer, baseline, "Revert style")
      commit({ ...set, activeOptionId: null })
      return true
    },

    saveCurrent(selection, writer) {
      const set = withBaseline(setFor(selection), selection)
      const snapshot = captureSnapshot(selection.element)
      const option: ElementOption = {
        id: crypto.randomUUID(),
        name: nextName(set),
        className: snapshot.className,
        style: snapshot.style,
        text: snapshot.text,
        createdAt: Date.now(),
      }
      // Saving is not an edit, but it is the moment the element gains its
      // first option — re-apply so the queued source write matches what is shown.
      applySnapshot(selection, writer, snapshot, `Save style “${option.name}”`)
      commit({ ...set, activeOptionId: option.id, options: [...set.options, option] })
    },

    update(selection, id) {
      update(selection, id)
    },

    updateActive(selection) {
      const set = setFor(selection)
      if (!set.activeOptionId) return
      update(selection, set.activeOptionId)
    },

    rename(key, id, name) {
      if (id === BASELINE_OPTION_ID) return
      const set = getState().optionSets[key]
      if (!set) return
      commit({
        ...set,
        options: set.options.map((option) => (option.id === id ? { ...option, name } : option)),
      })
    },

    remove(selection, writer, id) {
      if (id === BASELINE_OPTION_ID) return
      const set = setFor(selection)
      const options = set.options.filter((option) => option.id !== id)
      if (set.activeOptionId === id) {
        const baseline = baselineOf(set, selection.key)
        if (baseline) applySnapshot(selection, writer, baseline, "Delete style")
      }
      if (visibleOptions({ ...set, options }).length === 0) {
        baselines.delete(selection.key)
        drop(selection.key)
        return
      }
      commit({
        ...set,
        activeOptionId: set.activeOptionId === id ? null : set.activeOptionId,
        options,
      })
    },
  }
}

/** One store per session; the inspector rebuilds its DOM on every render. */
export function optionsStore(editor: EditorContext): OptionsStore {
  cached ??= createStore(editor)
  return cached
}
