/**
 * Design options found in the running app, with nothing published for them.
 *
 * Most prototype toggles are not in any control library. They are plain
 * objects — `{ label, checked, onCheckedChange }` — handed to a "More" menu,
 * a settings list or a toolbar, and the menu that draws them is usually shut.
 * The objects are still there while it is shut: the component that owns the
 * menu holds them in its props. So this walks the live React tree, the way
 * `board/app-routes.ts` does for routes, and collects every list of on/off
 * descriptors it finds, grouped under the page component that owns them.
 *
 * Recognized by shape, never by name: a label (string), an on/off state
 * (boolean) and a function to set it, on an object inside an array prop. An
 * item that declares some other `type` (an action, a divider) is skipped. The
 * result is a store with leva's four methods, so `inventory.ts` merges it with
 * the configured and published ones and the pane cannot tell them apart.
 *
 * Bounded and best-effort: no React, a production build with minified names,
 * or a tree it does not understand each mean fewer options, never an error in
 * the page.
 */

import { CHROME_ATTR } from "../core/dom"
import { config } from "../core/config"

/** Guards on a hand-written tree, not product limits. */
const MAX_FIBERS = 20000
const MAX_ITEMS = 100
const MAX_OPTIONS = 200
const MAX_LABEL = 80
/** One scan serves every read inside this window — a render reads several times. */
const SCAN_TTL_MS = 250

interface FiberLike {
  type: unknown
  memoizedProps: Record<string, unknown> | null
  stateNode: unknown
  child: FiberLike | null
  sibling: FiberLike | null
  return: FiberLike | null
}

/** One on/off option as the app built it. */
interface Toggle {
  label: string
  checked: boolean
  disabled: boolean
  set: (next: boolean) => void
}

/** A found option and where it goes in the tree. */
interface Found extends Toggle {
  section: string
  path: string
}

const LABEL_KEYS = ["label", "headline", "title", "name", "text"] as const
const STATE_KEYS = ["checked", "selected", "on", "enabled", "active", "isOn", "isChecked", "isEnabled", "value"] as const
const SETTER_KEYS = ["onCheckedChange", "onToggle", "onChange", "onValueChange", "setChecked", "setValue", "toggle"] as const
/** Props that hold structure or styling, never a list of options. */
const SKIP_PROPS = new Set(["children", "style", "className", "ref", "key", "sx", "classes"])

const isElement = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "$$typeof" in value

/** The descriptor's on/off reading, or null when the object is not one. */
function toggleOf(value: unknown): Toggle | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || isElement(value)) return null
  const item = value as Record<string, unknown>
  if (typeof item.type === "string" && !/toggle|switch|check|bool/i.test(item.type)) return null
  let label = ""
  for (const key of LABEL_KEYS) {
    const raw = item[key]
    if (typeof raw === "string" && raw.trim()) {
      label = raw.trim()
      break
    }
  }
  if (!label || label.length > MAX_LABEL) return null
  const stateKey = STATE_KEYS.find((key) => typeof item[key] === "boolean")
  if (!stateKey) return null
  const setterKey = SETTER_KEYS.find((key) => typeof item[key] === "function")
  if (!setterKey) return null
  const setter = item[setterKey] as (next: boolean) => void
  return {
    label,
    checked: item[stateKey] === true,
    disabled: item.disabled === true,
    set: (next) => setter(next),
  }
}

const typeName = (type: unknown): string => {
  if (typeof type !== "function" && (typeof type !== "object" || type === null)) return ""
  const named = type as { displayName?: unknown; name?: unknown; render?: { name?: unknown }; type?: unknown }
  const own = named.displayName ?? named.name
  if (typeof own === "string" && own) return own
  // forwardRef and memo wrap the function that carries the name.
  if (typeof named.render?.name === "string") return named.render.name
  return named.type ? typeName(named.type) : ""
}

/** `CheckoutFlowView` → `Checkout flow`. Null for a minified or anonymous name. */
export function humanize(name: string): string | null {
  const core = name.replace(/(View|Page|Screen|Route|Container)$/, "")
  if (core.length < 3 || !/^[A-Z]/.test(core)) return null
  const words = core
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ")
  return words.map((word, index) => (index === 0 ? word : /^[A-Z]{2,}$/.test(word) ? word : word.toLowerCase())).join(" ")
}

/**
 * The section a list is filed under: the page that owns it.
 *
 * The nearest ancestor named like a page (`…View`, `…Page`, `…Screen`) wins,
 * because that is the thing a designer recognizes — "Checkout flow", not
 * "ProjectMoreMenu". Without one, the component holding the list names it, and
 * a minified tree falls back to a plain "Page options".
 */
function sectionFor(fiber: FiberLike): string {
  for (let up: FiberLike | null = fiber; up; up = up.return) {
    const name = typeName(up.type)
    if (/(View|Page|Screen|Route)$/.test(name)) {
      const human = humanize(name)
      if (human) return human
    }
  }
  return humanize(typeName(fiber.type)) ?? "Page options"
}

/** The app's React roots, never the editor's own chrome or a companion's. */
function rootFibers(doc: Document): FiberLike[] {
  const body = doc.body
  if (!body) return []
  const trusted = config.chrome?.trustedSelector || ""
  const candidates: Element[] = [body]
  for (const child of Array.from(body.children)) {
    candidates.push(child)
    for (const grandchild of Array.from(child.children)) candidates.push(grandchild)
  }
  const roots: FiberLike[] = []
  for (const element of candidates) {
    if (element.closest(`[${CHROME_ATTR}]`)) continue
    try {
      if (trusted && element !== body && element.matches(trusted)) continue
    } catch {
      // A malformed host selector excludes nothing.
    }
    const record = element as unknown as Record<string, unknown>
    for (const key of Object.keys(record)) {
      let fiber: FiberLike | undefined
      if (key.startsWith("__reactContainer$")) fiber = record[key] as FiberLike
      else if (key === "_reactRootContainer") {
        fiber = (record[key] as { _internalRoot?: { current?: FiberLike } } | undefined)?._internalRoot?.current
      }
      if (!fiber) continue
      const live = (fiber.stateNode as { current?: FiberLike } | null)?.current
      roots.push(live ?? fiber)
    }
  }
  return roots
}

/** Every option list in the tree, as flat rows with a section and a path. */
export function scanOptions(doc: Document = document): Found[] {
  const found: Found[] = []
  const seenLists = new WeakSet<object>()
  const seenItems = new WeakSet<object>()
  const taken = new Set<string>()

  const take = (fiber: FiberLike, list: unknown[], section: string | null) => {
    if (seenLists.has(list)) return
    seenLists.add(list)
    const toggles: Toggle[] = []
    for (const item of list.slice(0, MAX_ITEMS)) {
      if (!item || typeof item !== "object" || seenItems.has(item)) continue
      const toggle = toggleOf(item)
      if (!toggle) continue
      seenItems.add(item)
      toggles.push(toggle)
    }
    if (!toggles.length) return
    const name = section ?? sectionFor(fiber)
    for (const toggle of toggles) {
      if (found.length >= MAX_OPTIONS) return
      const base = `${name.replaceAll(".", " ")}.${toggle.label.replaceAll(".", " ")}`
      let path = base
      for (let n = 2; taken.has(path); n += 1) path = `${base} (${n})`
      taken.add(path)
      found.push({ ...toggle, section: name, path })
    }
  }

  try {
    for (const root of rootFibers(doc)) {
      const pending: FiberLike[] = [root]
      let fibers = 0
      while (pending.length && fibers++ < MAX_FIBERS) {
        const fiber = pending.pop()!
        if (fiber.sibling) pending.push(fiber.sibling)
        if (fiber.child) pending.push(fiber.child)
        // Only components take option lists as props; host elements take strings.
        if (typeof fiber.type === "string" || fiber.type === null) continue
        const props = fiber.memoizedProps
        if (!props || typeof props !== "object") continue
        for (const [key, value] of Object.entries(props)) {
          if (SKIP_PROPS.has(key) || !value || typeof value !== "object" || isElement(value)) continue
          if (Array.isArray(value)) {
            take(fiber, value, null)
            continue
          }
          // A menu object one level down — `{ label: "Card layout options",
          // options: [...] }` — names its own section.
          const holder = value as Record<string, unknown>
          const label = typeof holder.label === "string" ? holder.label.trim() : ""
          for (const inner of ["options", "items"]) {
            const list = holder[inner]
            if (Array.isArray(list)) take(fiber, list, label || null)
          }
        }
      }
    }
  } catch (error) {
    console.warn("[designlayer] could not read the app's options", error)
  }
  return found
}

interface DiscoveredInput {
  type: "BOOLEAN"
  label: string
  value: boolean
  disabled: boolean
}

/** What `inventory.ts` reads: leva's store methods over the last scan. */
export interface DiscoveredStore {
  readonly discovered: true
  getData(): Record<string, DiscoveredInput>
  getVisiblePaths(): string[]
  setValueAtPath(path: string, value: unknown, fromPanel?: boolean): void
  /** A fresh scan's fingerprint, for noticing that the app changed under the pane. */
  signature(): string
}

let cache: { at: number; found: Found[] } | null = null

function current(fresh = false): Found[] {
  const now = Date.now()
  if (!fresh && cache && now - cache.at < SCAN_TTL_MS) return cache.found
  cache = { at: now, found: scanOptions() }
  return cache.found
}

export const discoveredStore: DiscoveredStore = {
  discovered: true,
  getData() {
    const data: Record<string, DiscoveredInput> = Object.create(null)
    for (const option of current()) {
      data[option.path] = { type: "BOOLEAN", label: option.label, value: option.checked, disabled: option.disabled }
    }
    return data
  },
  getVisiblePaths() {
    return current().map((option) => option.path)
  },
  setValueAtPath(path, value) {
    // A fresh scan, so the setter is the one from the app's latest render.
    const option = current(true).find((candidate) => candidate.path === path)
    if (!option) throw new Error(`No option at ${path}`)
    option.set(value === true)
    cache = null
  },
  signature() {
    return current(true)
      .map((option) => `${option.path}=${option.checked ? 1 : 0}${option.disabled ? "d" : ""}`)
      .join("|")
  },
}
