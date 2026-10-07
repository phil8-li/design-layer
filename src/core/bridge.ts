/**
 * Typed access to the React Rewrite engine.
 *
 * The package runtime patches the vendored overlay bundle to hang
 * this object off `window`. We never import the vendor bundle directly — it is
 * a pinned, minified artifact — so every internal we depend on is listed here
 * and shape-checked by the patch's `requiredFragments` gate.
 */

import { isAngularHost, owningComponentName, resolveAngularSource } from "./angular"
import type { ClassUpdate } from "./tailwind"
import { notify, type ToastAction, type ToastMessage } from "./toast"
import type { SourceRef } from "./types"

/**
 * The only source-write shape the engine's batch transformer understands for
 * style changes. Everything beyond `updates` is resolution context: the more of
 * it we supply, the more reliably the AST walker finds the right JSX node.
 */
export interface UpdateClassOperation {
  op: "updateClass"
  file: string
  line: number
  col: number
  componentName?: string
  tagName?: string
  className?: string
  parentTagName?: string
  parentClassName?: string
  nthOfType?: number
  updates: ClassUpdate[]
}

export interface RewriteStack {
  componentName: string
  filePath: string
  lineNumber: number
  columnNumber: number
}

export interface RewriteElementInfo {
  tagName: string
  componentName: string
  filePath: string
  lineNumber: number
  columnNumber: number
  stack: RewriteStack[]
}

/** Subset of the vendor store we rely on. */
export interface RewriteStore {
  getActiveTool(): string
  setActiveTool(tool: string): void
  onToolChange(fn: (tool: string, previous: string) => void): () => void
  onStateChange(fn: () => void): () => void
  getCanvasTransform(): { x: number; y: number; scale: number }
  setCanvasTransform(t: { x: number; y: number; scale: number }): void
  onCanvasTransformChange(fn: (t: { x: number; y: number; scale: number }) => void): () => void
  viewportToPage(x: number, y: number): { x: number; y: number }
  pageToViewport(x: number, y: number): { x: number; y: number }
  /**
   * `mergeKey` identifies the element so repeated edits accumulate into one
   * operation; `propertyKeys` runs parallel to `operation.updates` so a second
   * edit to the same property replaces the first instead of appending a class.
   */
  addPendingPropertyOperation(
    mergeKey: string,
    operation: UpdateClassOperation,
    propertyKeys: string[]
  ): void
  /**
   * The inverse: take named properties back out of a merged operation.
   *
   * The Changes tab's delete button has to mean "this will not be written".
   * Without this it could only ever mean "this row is now hidden" — the
   * operation stayed queued, and Apply wrote it anyway, minutes after the
   * designer watched the row disappear.
   *
   * OPTIONAL, because it is reached by patching the vendor bundle
   * (`runtime/vendor-patch.mjs` exposes the engine's own `su`), and a prebuilt
   * `dist/` served against an unpatched bundle still has to run. A caller that
   * finds it missing must say so rather than report a withdrawal that did not
   * happen; `core/withdraw.ts` is the single place that decides what to do
   * about that.
   *
   * Dropping every property of an element removes the pending entry outright,
   * which is what lets `hasChanges()` go quiet again on the last withdrawal.
   */
  removePendingPropertyOperation?(mergeKey: string, propertyKeys: string[]): void
  buildBatchOperations(): unknown[]
  hasChanges(): boolean
  addMove(move: unknown): unknown
  updateMoveDelta(id: string, delta: { x: number; y: number }): void
  getMoveForElement(el: Element): unknown
  resetCanvas(): void
}

export interface RewriteBridge {
  version: number
  tokens: {
    colors: Record<string, string>
    shadows: Record<string, string>
    radii: Record<string, string>
    font: string
  }
  send(message: unknown): void
  subscribe(fn: (message: Record<string, unknown>) => void): () => void
  discoverFile(componentName: string): Promise<string | null>
  // `Element`, not `HTMLElement`: the runtime resolves any host node, and an
  // SVG icon is a legitimate target now that hit-testing reaches one.
  elementInfo(el: Element): RewriteElementInfo | null
  /**
   * The only accessor that answers "which file is this element written in"
   * under React 19.
   *
   * `elementInfo` walks `fiber._debugSource`, which React 19.2 removed — it
   * returns a populated object whose `filePath` is the empty string for every
   * node in this app. This one reads the owner stack and symbolicates it
   * through the chunk's sourcemap, so it is async and it is fallible.
   * Optional because an older patched bundle will not have it.
   */
  elementSourceAsync?(el: Element): Promise<RewriteElementInfo | null>
  resolveSourceAt(x: number, y: number): Promise<RewriteElementInfo | null>
  hitTest(x: number, y: number): HTMLElement | null
  selectedElement(): HTMLElement | null
  refreshGeometry(): void
  /**
   * The vendor's method, replaced by ours — see `withEditorToast`.
   *
   * `action` is not the vendor's and it never passes one: `V` takes a message
   * and a kind it then discards. It is declared here because this signature is
   * what every caller in the product is typed against, and after the wrapper
   * has run the function behind it is `notify`, which does take one. Declaring
   * it anywhere else would mean a second path to the toaster, which is exactly
   * what the wrapper exists to prevent.
   */
  toast(message: ToastMessage, kind?: "info" | "error", action?: ToastAction): void
  root(): HTMLElement | null
  store: RewriteStore
}

declare global {
  interface Window {
    __DESIGNLAYER_BRIDGE__?: RewriteBridge
    __DESIGNLAYER_WS_PORT__?: number
    /** The patched vendor's deferred boot; see `whenBridgeReady`. */
    __DESIGNLAYER_VENDOR_BOOT__?: () => void
  }
}

const BRIDGE_TIMEOUT_MS = 10_000

/**
 * The bridge with `elementInfo` answering for an Angular host.
 *
 * One wrap rather than an Angular branch in each caller. `elementInfo` is the
 * synchronous "what is this element" every surface asks — the inspector header,
 * the layers tree's row names and its component-root test, the options key —
 * and on Angular the vendor's copy answers `null` for all of them, which is how
 * a page of named components read as a list of `div`s.
 *
 * `filePath` stays empty on purpose. This is the SYNCHRONOUS accessor, and the
 * file is a round trip away; `resolveElementSource` is the one that waits for
 * it. Naming a file here that nobody had confirmed is exactly the class of
 * error the vendor's own text-matching fallback makes.
 */
function withAngularElementInfo(bridge: RewriteBridge): RewriteBridge {
  if (!isAngularHost()) return bridge
  const angularInfo = (element: Element): RewriteElementInfo | null => {
    const componentName = owningComponentName(element)
    if (!componentName) return null
    return {
      tagName: element.tagName.toLowerCase(),
      // Bundlers prefix a renamed class with `_`; the server owns the real
      // mapping, but a row in the layers tree reading `_ShellComponent` is
      // noise, so the display name is tidied here and nowhere else.
      componentName: componentName.replace(/^_+/, ""),
      filePath: "",
      lineNumber: 0,
      columnNumber: 0,
      stack: [],
    }
  }
  return {
    ...bridge,
    elementInfo: angularInfo,
    elementSourceAsync: (element: Element) => Promise.resolve(angularInfo(element)),
    store: bridge.store,
  }
}

/**
 * The bridge with `toast` answering in OUR voice, not the vendor's.
 *
 * `bridge.toast` is the vendor's `V`: one fixed `div` at bottom-left, two
 * seconds, and a `kind` argument it accepts and then discards — so every
 * `toast(message, "error")` in this package rendered exactly like a success.
 * Forty-odd call sites reach it, directly or through `context.toast`, and
 * replacing the method here rather than at each of them is what makes the
 * swap total: there is no path left that can paint the old toast by accident.
 *
 * `Object.create` rather than a spread, unlike the wrapper above. `tokens` is
 * defined on the bridge as GETTERS over the vendor's live values; spreading
 * would freeze them into a snapshot taken at boot, and a prototype link keeps
 * them live for the cost of the same one line.
 */
function withEditorToast(bridge: RewriteBridge): RewriteBridge {
  const wrapped: RewriteBridge = Object.create(bridge)
  wrapped.toast = (message: ToastMessage, kind: "info" | "error" = "info", action?: ToastAction) =>
    notify(message, kind, action)
  return wrapped
}

/**
 * Boots the vendor overlay, then resolves once it has installed the bridge.
 *
 * The vendor used to boot itself on `DOMContentLoaded`, which runs before a
 * client-rendered app's first render task: building its hidden UI, opening its
 * socket and observing `<body>` all held the app's first paint back, for an
 * engine nothing reads until the editor mounts. The patch now leaves that boot
 * for this call (`runtime/vendor-patch.mjs`), and `index.ts` makes it after
 * the host has claimed the page, so the bridge is there synchronously.
 *
 * The poll is for a vendor that still boots itself — an editor process started
 * before that patch, serving this bundle fresh from `dist/` — and for one that
 * fails to: it keeps the bounded wait and the error the boot reports.
 */
export function whenBridgeReady(): Promise<RewriteBridge> {
  window.__DESIGNLAYER_VENDOR_BOOT__?.()
  if (window.__DESIGNLAYER_BRIDGE__) {
    return Promise.resolve(withEditorToast(withAngularElementInfo(window.__DESIGNLAYER_BRIDGE__)))
  }

  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      const bridge = window.__DESIGNLAYER_BRIDGE__
      if (bridge) {
        resolve(withEditorToast(withAngularElementInfo(bridge)))
        return
      }
      if (Date.now() - started > BRIDGE_TIMEOUT_MS) {
        reject(new Error("DesignLayer bridge never installed"))
        return
      }
      requestAnimationFrame(poll)
    }
    poll()
  })
}

/** Normalizes the vendor's element info into our `SourceRef`. */
export function toSourceRef(info: RewriteElementInfo | null): SourceRef | null {
  if (!info || !info.filePath) return null
  return {
    filePath: info.filePath,
    lineNumber: info.lineNumber,
    columnNumber: info.columnNumber,
    componentName: info.componentName,
  }
}

/*
 * ---------------------------------------------------------------------------
 * Source resolution — one owner
 * ---------------------------------------------------------------------------
 *
 * "Which file is this element written in" is a fact, so it has exactly one
 * function that answers it: `resolveElementSource`. Everything that writes to
 * source goes through it, because the three ways of asking disagree.
 *
 *   - `elementInfo` is synchronous and, under React 19.2, always answers "".
 *   - `elementSourceAsync` answers correctly about half the time; the other
 *     half it hands back the BUNDLER CHUNK the component was compiled into.
 *   - `discoverFile` greps the project for the component name and is the only
 *     one that works when the sourcemap does not.
 *
 * Measured live against this app on 2026-08-23: `Button` resolved to
 * `/Users/…/src/components/ui/button.tsx:57`, while `FolderChip` resolved to
 * `src_components_workspace_space_0w_i7fl._.js:953` — a chunk filename the
 * server would try to open and fail on. A resolver that trusted either answer
 * alone would be wrong for half the page, which is why validation is not
 * optional here.
 */

/**
 * A synthetic bundler root, e.g. `[project]/src/app/page.tsx`.
 *
 * The vendor strips a list of URL schemes but not this, because turbopack
 * writes it as a path segment rather than a protocol. Left on, the server
 * resolves it into a directory that does not exist.
 */
const BUNDLER_ROOT = /^\[[^\]]*\]\//
const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//
const SOURCE_EXTENSION = /\.(?:tsx|ts|jsx|js|mjs|cjs)$/

export function normalizeSourcePath(raw: string | null | undefined): string {
  if (!raw) return ""
  let path = raw.trim()
  if (path.includes("%")) {
    try {
      // React 19 owner stacks percent-encode spaces in absolute paths, and this
      // project lives under a directory with two of them.
      path = decodeURIComponent(path)
    } catch {
      // A literal `%` that is not an escape sequence. Keep the path as written.
    }
  }
  path = path.replace(URL_SCHEME, "")
  while (BUNDLER_ROOT.test(path)) path = path.replace(BUNDLER_ROOT, "")
  while (path.startsWith("./")) path = path.slice(2)
  return path
}

/**
 * Whether the server could open this and find JSX in it.
 *
 * The rejections are all things the resolver has actually been observed to
 * return. A turbopack chunk is the common one and it is recognisable two ways:
 * its basename carries `._.`, and it arrives with no directory at all — the
 * server's path resolver needs either a project-relative path or an absolute
 * one inside the project, so a bare basename is unusable even when it is real.
 */
export function isProjectSourcePath(path: string): boolean {
  if (!path) return false
  if (!SOURCE_EXTENSION.test(path)) return false
  const basename = path.slice(path.lastIndexOf("/") + 1)
  if (basename.includes("._.")) return false
  if (!path.includes("/")) return false
  if (path.includes("node_modules/")) return false
  if (path.includes("/_next/") || path.includes(".next/")) return false
  if (path.includes("/chunks/") || path.includes("/dist/") || path.includes("/build/")) {
    return false
  }
  return true
}

/** The first frame of an owner stack whose file the server can actually open. */
function usableFrame(info: RewriteElementInfo | null): SourceRef | null {
  if (!info) return null
  const frames: RewriteStack[] = [
    {
      componentName: info.componentName,
      filePath: info.filePath,
      lineNumber: info.lineNumber,
      columnNumber: info.columnNumber,
    },
    // The owner stack, so a component whose own frame symbolicated into a chunk
    // can still be written through the parent that renders it.
    ...(Array.isArray(info.stack) ? info.stack : []),
  ]
  for (const frame of frames) {
    const filePath = normalizeSourcePath(frame.filePath)
    if (!isProjectSourcePath(filePath)) continue
    return {
      filePath,
      lineNumber: frame.lineNumber ?? 0,
      columnNumber: frame.columnNumber ?? 0,
      componentName: frame.componentName || info.componentName,
    }
  }
  return null
}

/** Per-element, because resolution costs a sourcemap fetch and never changes. */
const sourceByElement = new WeakMap<Element, Promise<SourceRef | null>>()
/** Per-component, because `discoverFile` shells out to `grep`. */
const pathByComponent = new Map<string, Promise<string | null>>()

function discoverPath(bridge: RewriteBridge, componentName: string): Promise<string | null> {
  const cached = pathByComponent.get(componentName)
  if (cached) return cached
  const pending = Promise.resolve()
    .then(() => bridge.discoverFile(componentName))
    .then((path) => {
      const normalized = normalizeSourcePath(path)
      return isProjectSourcePath(normalized) ? normalized : null
    })
    .catch(() => null)
  pathByComponent.set(componentName, pending)
  return pending
}

async function resolve(bridge: RewriteBridge, element: Element): Promise<SourceRef | null> {
  // An Angular host has no fiber at all, so none of the three React routes
  // below can answer — `elementInfo` returns null for every node, the owner
  // stack does not exist, and `discoverFile` would grep for a component name
  // nobody supplied. The Angular resolver is not a fallback after them; it is
  // the whole answer, and reaching the React path first would only cost a
  // round trip to learn that.
  if (isAngularHost()) return resolveAngularSource(element)

  let info: RewriteElementInfo | null = null
  try {
    info = bridge.elementInfo(element)
  } catch {
    // The fiber lookup throws on a node React never rendered.
  }

  const fromSync = usableFrame(info)
  if (fromSync) return fromSync

  if (typeof bridge.elementSourceAsync === "function") {
    let asyncInfo: RewriteElementInfo | null = null
    try {
      asyncInfo = await bridge.elementSourceAsync(element)
    } catch {
      // Symbolication is best-effort; the grep below is the fallback.
    }
    const fromAsync = usableFrame(asyncInfo)
    if (fromAsync) return fromAsync
    // The async walk names the component even when it cannot place it, and the
    // sync walk under React 19 often names nothing at all.
    if (asyncInfo && !info?.componentName) info = asyncInfo
  }

  // Last resort: the owner stack named a component but every frame it gave us
  // was a chunk. `discoverFile` greps the project for where that component is
  // defined, which is a file the AST writer can find the element inside using
  // the tag name, the class list and the sibling index.
  const componentName = info?.componentName
  if (!componentName) return null
  const discovered = await discoverPath(bridge, componentName)
  if (!discovered) return null
  return {
    filePath: discovered,
    // No line, deliberately. The batch transformer treats `line`/`col` as a
    // hint it cross-validates against `tagName` and falls back to matching on
    // tag, class overlap and `nthOfType` — a wrong line is worse than none.
    lineNumber: 0,
    columnNumber: 0,
    componentName,
  }
}

/**
 * Where this element is written, resolved once and remembered.
 *
 * A `null` is not cached: the first ask can land before the sourcemap has been
 * fetched, and a permanently-remembered "no" would leave that element
 * unwritable for as long as it stays mounted.
 */
export function resolveElementSource(
  bridge: RewriteBridge,
  element: Element
): Promise<SourceRef | null> {
  const cached = sourceByElement.get(element)
  if (cached) return cached
  const pending = resolve(bridge, element).then((source) => {
    if (!source) sourceByElement.delete(element)
    return source
  })
  sourceByElement.set(element, pending)
  return pending
}

/** Test seam: drops the per-component grep results. */
export function resetSourceResolutionCache(): void {
  pathByComponent.clear()
}
