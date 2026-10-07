/**
 * Every design option the running app has, from three kinds of source.
 *
 * 1. A Leva store the host names under `controls.leva` in its config, with
 *    explicit path-pattern bindings.
 * 2. Stores the host publishes on `window.__DESIGNLAYER_CONTROLS__` — one, or a
 *    list — with leva's four methods, no config and no Leva needed.
 * 3. Options DISCOVERED in the live React tree (`discover.ts`): the on/off
 *    descriptors an app hands to its own menus, found with nothing published.
 *
 * Most prototype toggles are not Leva controls — they live in the app's own
 * state, behind its own "More" or settings menu — which is why the second and
 * third exist. Nothing here imports Leva or guesses relationships from path
 * names; an option is tied to elements only by an explicit config binding.
 */

import { round } from "../core/dom"
import { discoveredStore } from "./discover"

/** The slice of leva's `Store` we read. Structural on purpose — see above. */
interface LevaInputData {
  type?: unknown
  value?: unknown
  label?: unknown
  settings?: unknown
  disabled?: unknown
}

interface LevaStoreLike {
  getData(): Record<string, LevaInputData>
  getVisiblePaths(): string[]
  setValueAtPath(path: string, value: unknown, fromPanel: boolean): void
  useStore?: { subscribe(listener: () => void): () => void }
  /** `"app"` for options that apply on every page; they list after the page's own. */
  scope?: unknown
}

export interface LevaControlBinding {
  pathPattern: string
  selectors: string[]
  relationship: string
  defaultGroup: string | null
  defaultKey: string | null
}

interface ClientLevaConfig {
  storeGlobal: string
  sourceDefaults: boolean
  bindings: LevaControlBinding[]
}

/** One tunable leaf: concept (a) in the options taxonomy. */
export interface LevaControl {
  /** Dot path leva keys on, e.g. `Overview.Hover.hoverPreset`. */
  path: string
  key: string
  label: string
  type: string
  value: unknown
  valueText: string
  /**
   * Named variants — concept (f), and the thing a designer means by "the
   * options we built". Present only on SELECT controls.
   */
  variants: string[] | null
  variantValues: unknown[] | null
  bounds: { min: number | null; max: number | null; step: number | null } | null
  disabled: boolean
  /** Leva `render` predicates hide about a third of the panel at any moment. */
  visible: boolean
  /** Explicit host relationship; absent means the editor makes no relevance claim. */
  selectors: string[]
  relationship: string | null
  /** Source-default address, supplied by the matching host binding. */
  defaultGroup: string | null
  defaultKey: string | null
  canPersistDefault: boolean
}

/** A leva folder — concept (b). Sections are the depth-0 folders. */
export interface LevaFolder {
  name: string
  path: string
  folders: LevaFolder[]
  controls: LevaControl[]
  /** Carries a `save as default` button, i.e. it can hold concept (c)/(d). */
  hasSaveDefault: boolean
  controlCount: number
  variantCount: number
}

export interface LevaTree {
  sections: LevaFolder[]
  controlCount: number
  variantCount: number
  selectCount: number
}

/**
 * The unavailable branch carries a headline as well as a sentence, because the
 * pane draws it as an empty state rather than as a status line. The four states
 * differ in KIND — no integration, integration on another screen, integration
 * with nothing in it, integration that threw — and a reader scanning a 240px
 * column reads the heading before the prose. Splitting them here rather than
 * letting the pane guess from the string keeps that decision with the code that
 * actually knows which state it is in.
 */
export type LevaInventory =
  | ({ available: true } & LevaTree)
  | { available: false; title: string; reason: string }

/**
 * The global a host publishes stores on, with or without a config: one store,
 * or an array of them (`getData`, `getVisiblePaths`, `setValueAtPath`, and
 * optionally `useStore.subscribe`). The Design options tab lists them all.
 */
export const DEFAULT_CONTROLS_GLOBAL = "__DESIGNLAYER_CONTROLS__"

function levaConfig(): ClientLevaConfig | null {
  const raw = (globalThis as { __DESIGNLAYER_CONFIG__?: unknown }).__DESIGNLAYER_CONFIG__
  if (!raw || typeof raw !== "object") return null
  const controls = (raw as { controls?: unknown }).controls
  if (!controls || typeof controls !== "object") return null
  const leva = (controls as { leva?: unknown }).leva
  if (!leva || typeof leva !== "object") return null
  const shape = leva as Partial<ClientLevaConfig>
  if (typeof shape.storeGlobal !== "string" || !shape.storeGlobal) return null
  return {
    storeGlobal: shape.storeGlobal,
    sourceDefaults: shape.sourceDefaults === true,
    bindings: Array.isArray(shape.bindings) ? shape.bindings : [],
  }
}

function globPattern(pattern: string): RegExp {
  let source = "^"
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*"
      index += 1
    } else if (char === "*") {
      source += "[^.]*"
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`${source}$`)
}

/** First explicit binding wins; path names never imply an element relationship. */
export function bindingForPath(
  path: string,
  bindings: readonly LevaControlBinding[] = levaConfig()?.bindings ?? []
): LevaControlBinding | null {
  for (const binding of bindings) {
    try {
      if (globPattern(binding.pathPattern).test(path)) return binding
    } catch {
      // A malformed host pattern disables that one binding, not the inventory.
    }
  }
  return null
}

/**
 * Paths come from the page. A `__proto__` segment written onto a plain object
 * reassigns the prototype instead of adding a folder, so every keyed lookup in
 * this module uses a null-prototype record — the same rule the server store
 * follows for element keys.
 */
export function nullIndex<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/**
 * `project-shell.tsx` needs ten distinct `save as default` labels inside one
 * schema and disambiguates them with trailing zero-width spaces, so the label
 * has to be normalised before it can be recognised or shown.
 */
export function plainLabel(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim() : ""
}

function isSaveDefaultButton(type: string, label: string): boolean {
  return type === "BUTTON" && /^save as default$/i.test(label)
}

function readVariants(settings: unknown): { keys: string[]; values: unknown[] } | null {
  if (!settings || typeof settings !== "object") return null
  const shape = settings as { keys?: unknown; values?: unknown }
  if (!Array.isArray(shape.keys) || !Array.isArray(shape.values)) return null
  if (shape.keys.length === 0 || shape.keys.length !== shape.values.length) return null
  return { keys: shape.keys.map((key) => String(key)), values: shape.values }
}

function readBounds(settings: unknown): LevaControl["bounds"] {
  if (!settings || typeof settings !== "object") return null
  const shape = settings as { min?: unknown; max?: unknown; step?: unknown }
  const num = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : null)
  const bounds = { min: num(shape.min), max: num(shape.max), step: num(shape.step) }
  return bounds.min === null && bounds.max === null && bounds.step === null ? null : bounds
}

/**
 * A control's value as one line of text.
 *
 * `cut` is the row's version — an object longer than 64 characters is trimmed
 * to 61 and closed with an ellipsis, because the row is one line in a 240px
 * panel. Pass `false` for the whole thing.
 *
 * The two live in one function on purpose. This was the only truncation in the
 * chrome whose full text existed NOWHERE on screen: every other ellipsis here
 * cuts a string the file, the brief or the row above still holds, but a leva
 * value is only ever this. A caller that shortens has to be able to get the
 * long form back from the same place, or the second form drifts into being a
 * different serializer.
 */
export function formatValue(value: unknown, cut = true): string {
  if (typeof value === "number") return String(round(value, 3))
  if (typeof value === "string") return value === "" ? '""' : value
  if (typeof value === "boolean") return value ? "on" : "off"
  if (value === null || value === undefined) return "—"
  try {
    const text = JSON.stringify(value) ?? "—"
    return cut && text.length > 64 ? `${text.slice(0, 61)}…` : text
  } catch {
    return "—"
  }
}

function emptyFolder(name: string, path: string): LevaFolder {
  return {
    name,
    path,
    folders: [],
    controls: [],
    hasSaveDefault: false,
    controlCount: 0,
    variantCount: 0,
  }
}

function rollUp(folder: LevaFolder): void {
  let controls = folder.controls.length
  let variants = 0
  for (const control of folder.controls) variants += control.variants?.length ?? 0
  for (const child of folder.folders) {
    rollUp(child)
    controls += child.controlCount
    variants += child.variantCount
  }
  folder.controlCount = controls
  folder.variantCount = variants
}

/**
 * Projects leva's flat `path -> input` map into the section/folder/control tree
 * the panel renders. Split out from `readInventory` so it can be exercised
 * against a stubbed store with no browser.
 */
export function buildTree(
  data: Record<string, LevaInputData>,
  visiblePaths: readonly string[] = [],
  bindings: readonly LevaControlBinding[] = levaConfig()?.bindings ?? []
): LevaTree {
  const sections: LevaFolder[] = []
  const byPath = nullIndex<LevaFolder>()
  const visible = new Set(visiblePaths)
  let selectCount = 0

  const folderAt = (segments: string[]): LevaFolder | null => {
    let siblings = sections
    let prefix = ""
    let node: LevaFolder | null = null
    for (const segment of segments) {
      prefix = prefix ? `${prefix}.${segment}` : segment
      let existing = byPath[prefix]
      if (!existing) {
        existing = emptyFolder(segment, prefix)
        byPath[prefix] = existing
        siblings.push(existing)
      }
      node = existing
      siblings = existing.folders
    }
    return node
  }

  // Visible paths carry leva's own render order; the rest are appended so a
  // control hidden behind a `render` predicate is still discoverable.
  const ordered = [...visiblePaths, ...Object.keys(data).filter((path) => !visible.has(path))]
  const seen = new Set<string>()

  for (const path of ordered) {
    if (seen.has(path)) continue
    seen.add(path)
    // `Object.hasOwn` rather than a truthiness test: a `__proto__` entry in
    // `visiblePaths` would otherwise resolve to `Object.prototype` and be
    // listed as a control.
    if (!Object.hasOwn(data, path)) continue
    const input = data[path]
    if (!input || typeof input !== "object") continue

    const segments = path.split(".")
    const key = segments.pop() ?? path
    const parent = folderAt(segments.length ? segments : ["(root)"])
    if (!parent) continue

    const type = typeof input.type === "string" ? input.type : "UNKNOWN"
    const label = plainLabel(input.label) || key

    if (isSaveDefaultButton(type, label)) {
      parent.hasSaveDefault = true
      continue
    }

    const variants = readVariants(input.settings)
    if (variants) selectCount += 1
    const binding = bindingForPath(path, bindings)
    const defaultGroup = binding?.defaultGroup ?? null
    const defaultKey = defaultGroup
      ? (binding?.defaultKey?.replaceAll("$key", key) ?? key)
      : null

    parent.controls.push({
      path,
      key,
      label,
      type,
      value: input.value,
      valueText: formatValue(input.value),
      variants: variants?.keys ?? null,
      variantValues: variants?.values ?? null,
      // Leva keeps min/max/step in `settings`; a hand-published store often
      // puts them beside the value. Either is a bound the slider can use.
      bounds: readBounds(input.settings) ?? readBounds(input),
      disabled: input.disabled === true,
      visible: visible.has(path),
      selectors: binding?.selectors ?? [],
      relationship: binding?.relationship ?? null,
      defaultGroup,
      defaultKey,
      canPersistDefault: Boolean(levaConfig()?.sourceDefaults && defaultGroup && defaultKey),
    })
  }

  let controlCount = 0
  let variantCount = 0
  for (const section of sections) {
    rollUp(section)
    controlCount += section.controlCount
    variantCount += section.variantCount
  }

  return { sections, controlCount, variantCount, selectCount }
}

/** A value that behaves like a store, never one recognized on its name alone. */
function asStore(candidate: unknown): LevaStoreLike | null {
  if (!candidate || typeof candidate !== "object") return null
  const store = candidate as Partial<LevaStoreLike>
  if (typeof store.getData !== "function") return null
  if (typeof store.getVisiblePaths !== "function") return null
  if (typeof store.setValueAtPath !== "function") return null
  return store as LevaStoreLike
}

/**
 * Every store a host has published: the configured global first, then the
 * conventional one, which may hold one store or a list of them — a page can
 * publish its own options and the app shell its app-wide ones, side by side.
 */
function publishedStores(): LevaStoreLike[] {
  const win = window as unknown as Record<string, unknown>
  const stores: LevaStoreLike[] = []
  const add = (candidate: unknown) => {
    const store = asStore(candidate)
    if (store && !stores.includes(store)) stores.push(store)
  }
  const configured = levaConfig()
  if (configured) add(win[configured.storeGlobal])
  const conventional = win[DEFAULT_CONTROLS_GLOBAL]
  if (Array.isArray(conventional)) conventional.forEach(add)
  else add(conventional)
  return stores
}

/** The first published store, for callers that only ever had one. */
export function levaStore(): LevaStoreLike | null {
  return publishedStores()[0] ?? null
}

/** Which store answered for each path on the last read, so a write goes back to it. */
let owners = new Map<string, LevaStoreLike>()

interface Merged {
  data: Record<string, LevaInputData>
  visible: string[]
  owners: Map<string, LevaStoreLike>
  failed: number
}

/**
 * Every source in one map: what the host published, then what discovery found
 * in the running app that no published store already lists.
 *
 * The first source to claim a path keeps it, and a discovered option whose
 * label a published one already carries is the same option seen twice — a
 * page that publishes its toggles usually also hands them to its own menu.
 * One source that throws is logged and skipped; the rest still list.
 */
function mergeSources(stores: readonly LevaStoreLike[]): Merged {
  const data = nullIndex<LevaInputData>()
  const visible: string[] = []
  const claimed = new Map<string, LevaStoreLike>()
  const labels = new Set<string>()
  let failed = 0
  // The page's own options first — published, then discovered — and the ones
  // that apply on every page last, under them, where they read as the backdrop.
  const appWide = (store: LevaStoreLike) => store.scope === "app"
  const ordered = [
    ...stores.filter((store) => !appWide(store)),
    discoveredStore as unknown as LevaStoreLike,
    ...stores.filter(appWide),
  ]
  for (const store of ordered) {
    const found = (store as { discovered?: boolean }).discovered === true
    try {
      const own = store.getData()
      if (!own || typeof own !== "object") throw new Error("getData() returned no map")
      for (const path of Object.keys(own)) {
        if (Object.hasOwn(data, path)) continue
        const input = own[path]
        if (!input || typeof input !== "object") continue
        const label = (plainLabel(input.label) || path.split(".").pop() || path).toLowerCase()
        if (found && labels.has(label)) continue
        data[path] = input
        claimed.set(path, store)
        if (!found) labels.add(label)
      }
      for (const path of store.getVisiblePaths()) {
        if (claimed.get(path) === store) visible.push(path)
      }
    } catch (error) {
      failed += 1
      console.warn("[designlayer] could not read the control store", error)
    }
  }
  return { data, visible, owners: claimed, failed }
}

/**
 * The inventory, or the reason there isn't one — and every reason names a way on.
 *
 * These sentences ARE the Design options tab in every state but the working
 * one, which is what makes them empty states rather than statuses: each says
 * what the tab would list, why it is listing nothing, and the one thing the
 * reader can do about it. They speak about the page, because the list follows
 * the page you are on.
 *
 * No library name, no global name, no stack trace. A designer did not choose
 * the library and cannot act on a property name; the thrown value goes to the
 * console, where the person who can act on it is. What matters is that ONE
 * name is used throughout, and "design options" — the tab's own — is it.
 */
export function readInventory(): LevaInventory {
  const stores = publishedStores()
  const merged = mergeSources(stores)
  if (merged.failed > 0 && Object.keys(merged.data).length === 0) {
    return {
      available: false,
      title: "The design options could not be read",
      reason: "Reload the page, then open the screen with the options.",
    }
  }
  const tree = buildTree(merged.data, merged.visible)
  owners = merged.owners
  if (tree.controlCount > 0) return { available: true, ...tree }
  if (stores.length) {
    return {
      available: false,
      title: "No design options yet",
      reason: "Open the screen that sets your design options. This list follows the page you're on.",
    }
  }
  return levaConfig()
    ? {
        available: false,
        title: "No design options on this page",
        reason: "Open the page that shows your design options. This list follows the page you're on.",
      }
    : {
        available: false,
        title: "No design options",
        reason: "Open a page that has design options, or publish them from your app's code. This list follows the page you're on.",
      }
}

/** The store that holds `path`: the one that answered last time, else whoever has it now. */
function ownerOf(path: string): LevaStoreLike | null {
  const live = [...publishedStores(), discoveredStore as unknown as LevaStoreLike]
  // Only while that store is still published: a page that remounts publishes a
  // new object, and a write to the old one would land nowhere.
  const known = owners.get(path)
  if (known && live.includes(known)) return known
  for (const store of live) {
    try {
      if (Object.hasOwn(store.getData(), path)) return store
    } catch {
      // A store that cannot be read cannot own the path either.
    }
  }
  return null
}

/** Writes a value exactly as moving the control in the app's own panel would. */
export function setControlValue(path: string, value: unknown): boolean {
  const store = ownerOf(path)
  if (!store) return false
  try {
    store.setValueAtPath(path, value, true)
    return true
  } catch (error) {
    console.warn("[designlayer] the app rejected a value", path, error)
    return false
  }
}

export function controlValueAtPath(path: string): unknown {
  try {
    return ownerOf(path)?.getData()?.[path]?.value
  } catch {
    return undefined
  }
}

/** How often to look for stores that appeared, went, or changed. */
const STORE_POLL_MS = 1000
/** How often to check whether the page changed. A string compare, so cheap. */
const ROUTE_POLL_MS = 250
/** After a page change, look again at these delays: the new page mounts late. */
const AFTER_ROUTE_MS = [150, 500, 1200]

/**
 * Notifies on any store write, when the stores themselves change, when the
 * options found in the app change, and when the page does.
 *
 * The tab subscribes once, when the editor mounts, and almost nothing it lists
 * is there yet: a page publishes its store when it mounts and withdraws it when
 * it unmounts, a hot reload swaps the object, and discovered options exist only
 * while their page is rendered. So:
 *
 * - published stores are re-read every second and re-subscribed when the set
 *   changes; a store without `useStore.subscribe` still gets that refresh;
 * - the discovered options are re-scanned on the same beat, but only while
 *   `isActive()` says the list is on screen — a tree walk is not free — and
 *   the listener fires only when what they say actually changed;
 * - THE LIST FOLLOWS THE PAGE. A change of URL — a link, the back button, a
 *   router's `pushState`, which fires no event — is noticed within a quarter
 *   second and answered at once, then again as the new page finishes mounting;
 *   coming back to the window (focus, or the tab becoming visible) repaints
 *   immediately rather than on the next beat.
 */
export function subscribeToLeva(listener: () => void, isActive: () => boolean = () => true): () => void {
  let attached: LevaStoreLike[] = []
  let detachers: Array<() => void> = []
  let signature = ""
  const where = () => (typeof window === "undefined" ? "" : window.location.href)
  let href = where()
  const later: Array<ReturnType<typeof setTimeout>> = []

  const attach = (): boolean => {
    const stores = publishedStores()
    if (stores.length === attached.length && stores.every((store, index) => store === attached[index])) {
      return false
    }
    for (const off of detachers) off()
    detachers = []
    attached = stores
    for (const store of stores) {
      const subscribe = store.useStore?.subscribe
      if (!store.useStore || typeof subscribe !== "function") continue
      try {
        const off = store.useStore.subscribe(listener)
        if (typeof off === "function") detachers.push(off)
      } catch {
        // A store that refuses a listener is still readable; polling covers it.
      }
    }
    return true
  }

  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden"

  /** One look at everything. `force` repaints even when nothing seems to have changed. */
  const look = (force = false) => {
    let changed = attach() || force
    if (isActive() && visible()) {
      const next = discoveredStore.signature()
      if (next !== signature) {
        signature = next
        changed = true
      }
    }
    if (changed) listener()
  }

  const followPage = () => {
    const now = where()
    if (now === href) return
    href = now
    look(true)
    for (const delay of AFTER_ROUTE_MS) later.push(setTimeout(() => look(), delay))
  }
  const onReturn = () => {
    if (visible()) look(true)
  }

  attach()
  const timers = [setInterval(() => look(), STORE_POLL_MS), setInterval(followPage, ROUTE_POLL_MS)]
  // Under Node (the test runner) an interval keeps the process alive; a
  // browser timer has no `unref` and needs none.
  for (const timer of timers) (timer as unknown as { unref?: () => void }).unref?.()
  const win = typeof window === "undefined" ? null : window
  win?.addEventListener("popstate", followPage)
  win?.addEventListener("hashchange", followPage)
  win?.addEventListener("focus", onReturn)
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onReturn)

  return () => {
    for (const timer of timers) clearInterval(timer)
    for (const timer of later) clearTimeout(timer)
    win?.removeEventListener("popstate", followPage)
    win?.removeEventListener("hashchange", followPage)
    win?.removeEventListener("focus", onReturn)
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onReturn)
    for (const off of detachers) off()
  }
}

export interface ContextualControlTargets {
  path: string
  relationship: string
  selectors: string[]
  elements: Element[]
}

/** Resolves only selectors the host explicitly attached to this control. */
export function targetsForControl(control: LevaControl): ContextualControlTargets | null {
  if (!control.relationship || control.selectors.length === 0) return null
  const elements: Element[] = []
  const seen = new Set<Element>()
  for (const selector of control.selectors) {
    let matches: Element[] = []
    try {
      matches = Array.from(document.querySelectorAll(selector))
    } catch {
      continue
    }
    for (const element of matches) {
      if (seen.has(element)) continue
      seen.add(element)
      elements.push(element)
    }
  }
  return { path: control.path, relationship: control.relationship, selectors: control.selectors, elements }
}

/** Captain hook: the canvas may render these targets without coupling options to canvas state. */
export function highlightControlTargets(control: LevaControl): ContextualControlTargets | null {
  const targets = targetsForControl(control)
  if (!targets) return null
  window.dispatchEvent(
    new CustomEvent("designlayer:highlight-elements", {
      detail: targets,
    })
  )
  return targets
}

export function isControlRelevantToElement(control: LevaControl, element: Element): boolean {
  for (const selector of control.selectors) {
    try {
      if (element.matches(selector) || element.closest(selector) || element.querySelector(selector)) {
        return true
      }
    } catch {
      // Invalid host selector: it binds nothing.
    }
  }
  return false
}

function matches(control: LevaControl, query: string): boolean {
  if (control.path.toLowerCase().includes(query)) return true
  if (control.label.toLowerCase().includes(query)) return true
  if (control.valueText.toLowerCase().includes(query)) return true
  return Boolean(control.variants?.some((name) => name.toLowerCase().includes(query)))
}

/**
 * Prunes the tree to folders that still have a hit. A folder whose own name
 * matches keeps all of its contents, so searching "Hover" shows what is in it
 * rather than an empty heading.
 */
export function filterTree(sections: readonly LevaFolder[], rawQuery: string): LevaFolder[] {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return sections as LevaFolder[]

  const prune = (folder: LevaFolder): LevaFolder | null => {
    if (folder.path.toLowerCase().includes(query)) return folder
    const controls = folder.controls.filter((control) => matches(control, query))
    const folders = folder.folders.map(prune).filter((child): child is LevaFolder => child !== null)
    if (controls.length === 0 && folders.length === 0) return null
    const pruned: LevaFolder = { ...folder, controls, folders }
    rollUp(pruned)
    return pruned
  }

  return sections.map(prune).filter((section): section is LevaFolder => section !== null)
}

/**
 * Prunes to the controls a predicate keeps, dropping the folders left empty.
 *
 * `filterTree` cannot do this job: it keeps a whole folder whose NAME matches,
 * which is right for a text query — searching "Hover" should show what is in
 * Hover — and wrong for a scope, where a folder's name says nothing about
 * whether its controls touch the selected element. Two prunes with two rules,
 * composed by the caller: scope first, then the query over what survived.
 *
 * Counts are rolled up again on the way out, so a folder's "12 controls" is a
 * promise about the rows under it rather than about the tree it came from.
 */
export function filterControls(
  sections: readonly LevaFolder[],
  keep: (control: LevaControl) => boolean
): LevaFolder[] {
  const prune = (folder: LevaFolder): LevaFolder | null => {
    const controls = folder.controls.filter(keep)
    const folders = folder.folders.map(prune).filter((child): child is LevaFolder => child !== null)
    if (controls.length === 0 && folders.length === 0) return null
    const pruned: LevaFolder = { ...folder, controls, folders }
    rollUp(pruned)
    return pruned
  }

  return sections.map(prune).filter((section): section is LevaFolder => section !== null)
}
