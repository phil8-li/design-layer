/**
 * The board's frames, and the budget for how many of them are running an app.
 *
 * Every loaded frame is a whole second copy of the user's app — its bundle, its
 * data fetches, its timers — so loading sixteen at once would stall the very
 * dev server the live page is talking to. Frames therefore load ONE AT A TIME,
 * the current page first and then outward from the middle of the view, and no
 * more than eight hold a document at once. Past that, the frame farthest from
 * view is sent back to about:blank and shows its placeholder again.
 *
 * Frames are never moved in the DOM once built. Re-inserting an iframe throws
 * its document away and reloads it, which would undo the whole point of keeping
 * loaded frames alive between one opening of the board and the next.
 */

import { el } from "../core/dom"
import type { PageEntry } from "./pages"

/*
 * The mark a board iframe carries so the editor bundle injected into the page
 * it loads stands down instead of booting a second editor inside the frame.
 * Owned by the server lane: see `BOARD_FRAME_NAME_PREFIX` and
 * `BOARD_FRAME_ATTRIBUTE` in runtime/board-frame.mjs. Duplicated here because
 * the client bundle cannot import runtime modules; keep the two in step.
 */
export const BOARD_FRAME_NAME_PREFIX = "designlayer-frame:"
export const BOARD_FRAME_ATTRIBUTE = "data-designlayer-frame"

/**
 * Whether this window is one of the board's frames.
 *
 * The launcher already keeps the served bundle from running in one, so this is
 * the second line: an editor started before that guard existed still serves
 * the NEW chrome bundle (it is read from dist/ per request) inside the OLD
 * wrapper, and the bundle has to notice for itself that it is a frame.
 */
export function isBoardFrame(win: Window = window): boolean {
  try {
    if (typeof win.name === "string" && win.name.startsWith(BOARD_FRAME_NAME_PREFIX)) return true
    return Boolean(win.frameElement?.hasAttribute(BOARD_FRAME_ATTRIBUTE))
  } catch {
    // A cross-origin parent throws on `frameElement`; the board never makes one.
    return false
  }
}

const CLEAN_STYLE_ID = "designlayer-frame-clean"

/**
 * Takes everything the editor side draws out of a frame's document.
 *
 * A frame is meant to show the PAGE: the editor's chrome, the vendor overlay's
 * root and whatever the companions and the host's dev chrome draw (the
 * selectors `chrome.trustedSelectors` already lists as "not the product") have
 * no business in it. With the launcher's guard in place none of them boot, and
 * this is a no-op that costs one small style element; against an editor started
 * before that guard, it is what keeps a board of pages from being a board of
 * editors.
 */
export function cleanFrameDocument(iframe: HTMLIFrameElement, extraSelector = ""): void {
  try {
    const doc = iframe.contentDocument
    if (!doc || doc.getElementById(CLEAN_STYLE_ID)) return
    const selectors = ["[data-designlayer]", ".de-root", "#react-rewrite-root", extraSelector.trim()]
      .filter(Boolean)
      .join(", ")
    const style = doc.createElement("style")
    style.id = CLEAN_STYLE_ID
    style.textContent = `${selectors} { display: none !important; }`
    ;(doc.head ?? doc.documentElement)?.append(style)
  } catch {
    // Not same-origin, or already gone: there is nothing of ours to take out.
  }
}

/** Documents alive at once, the current page included. */
export const MAX_LOADED_FRAMES = 8
/** A page that never fires `load` must not hold the queue forever. */
const LOAD_TIMEOUT_MS = 15000

export type FrameStatus = "idle" | "loading" | "loaded" | "evicted"

export interface FrameView {
  path: string
  element: HTMLDivElement
  iframe: HTMLIFrameElement
  status: FrameStatus
  /** The frame document's `<title>`, once it has one. */
  title: string
  setCurrent(current: boolean): void
  setFile(file: string | undefined): void
}

export interface FramePool {
  get(path: string): FrameView | undefined
  /** The view for a page, built on first ask. */
  ensure(page: PageEntry): FrameView
  remove(path: string): void
  views(): FrameView[]
  /** Which frames matter most, most important first. Loads and evicts to match. */
  schedule(order: readonly string[]): void
  loadedCount(): number
  /**
   * Takes back a load asked for less than `ms` ago that has no document yet,
   * so it starts again on the next `schedule`. For a view transition about to
   * capture the page: see `open` in ./index.
   */
  holdFresh(ms: number): void
  /**
   * Sends every frame back to about:blank after `ms`, unless `schedule` is
   * called first. For a board that has closed, or a prewarm nobody followed.
   */
  release(ms: number): void
  destroy(): void
}

export interface FramePoolOptions {
  max?: number
  /** Extra selectors to hide inside every frame — the host's dev chrome and the companions'. */
  hideSelector?: string
  onLoad?(view: FrameView): void
}

export function createFramePool(options: FramePoolOptions = {}): FramePool {
  const max = Math.max(1, options.max ?? MAX_LOADED_FRAMES)
  const views = new Map<
    string,
    FrameView & { statusLine: HTMLElement; timer: number; startedAt: number; before: Document | null }
  >()
  let loading: string | null = null
  let desired: string[] = []
  let idleTimer = 0

  const statusText = (status: FrameStatus) => (status === "evicted" ? "Zoom in to load" : "Loading…")

  const setStatus = (view: FrameView & { statusLine: HTMLElement }, status: FrameStatus) => {
    view.status = status
    view.statusLine.textContent = statusText(status)
    if (status === "loaded") view.element.setAttribute("data-loaded", "true")
    else view.element.removeAttribute("data-loaded")
  }

  const readTitle = (view: FrameView) => {
    try {
      view.title = view.iframe.contentDocument?.title?.trim() ?? ""
    } catch {
      view.title = ""
    }
  }

  const finish = (path: string) => {
    const view = views.get(path)
    if (!view || view.status !== "loading") return
    clearTimeout(view.timer)
    cleanFrameDocument(view.iframe, options.hideSelector)
    setStatus(view, "loaded")
    readTitle(view)
    if (loading === path) loading = null
    try {
      options.onLoad?.(view)
    } catch (error) {
      console.warn("[designlayer]", error)
    }
    pump()
  }

  const start = (path: string) => {
    const view = views.get(path)
    if (!view) return
    loading = path
    setStatus(view, "loading")
    view.startedAt = performance.now()
    view.before = view.iframe.contentDocument
    view.iframe.setAttribute("src", path)
    view.timer = setTimeout(() => finish(path), LOAD_TIMEOUT_MS) as unknown as number
  }

  const evict = (path: string) => {
    const view = views.get(path)
    if (!view) return
    clearTimeout(view.timer)
    if (loading === path) loading = null
    view.iframe.setAttribute("src", "about:blank")
    view.title = ""
    setStatus(view, "evicted")
  }

  const loaded = () => Array.from(views.values()).filter((view) => view.status === "loaded")

  function pump(): void {
    const wanted = desired.filter((path) => views.has(path)).slice(0, max)
    // A frame past the budget waits for the view to come to it, and says so
    // instead of "Loading…" for as long as the board is open.
    for (const view of views.values()) {
      if (view.status === "idle") view.statusLine.textContent = statusText(wanted.includes(view.path) ? "idle" : "evicted")
    }
    if (loading) return
    const next = wanted.find((path) => views.get(path)!.status !== "loaded")
    if (!next) return
    const live = loaded()
    if (live.length >= max) {
      // Farthest first: the loaded frame latest in the priority order, and any
      // frame not in it at all before that.
      const rank = (path: string) => {
        const index = desired.indexOf(path)
        return index === -1 ? Number.MAX_SAFE_INTEGER : index
      }
      const victim = live
        .filter((view) => !wanted.includes(view.path))
        .sort((a, b) => rank(b.path) - rank(a.path))[0]
      if (!victim) return
      evict(victim.path)
    }
    start(next)
  }

  return {
    get: (path) => views.get(path),

    ensure(page) {
      const existing = views.get(page.path)
      if (existing) {
        existing.setFile(page.file)
        return existing
      }
      const pathLine = el("span", { class: "de-board-placeholder-path" }, [page.path])
      const fileLine = el("span", { class: "de-board-placeholder-file" })
      const statusLine = el("span", { class: "de-board-placeholder-status" }, ["Loading…"])
      const placeholder = el("div", { class: "de-board-placeholder" }, [pathLine, fileLine, statusLine])
      const iframe = el("iframe", {
        name: `${BOARD_FRAME_NAME_PREFIX}${page.path}`,
        [BOARD_FRAME_ATTRIBUTE]: true,
        loading: "eager",
        tabindex: "-1",
        "aria-hidden": "true",
        title: page.path,
        style: "pointer-events: none",
      })
      const element = el("div", { class: "de-board-frame", "data-path": page.path }, [placeholder, iframe])
      const view = {
        path: page.path,
        element,
        iframe,
        status: "idle" as FrameStatus,
        title: "",
        statusLine,
        timer: 0,
        startedAt: 0,
        before: null as Document | null,
        setCurrent(current: boolean) {
          if (current) element.setAttribute("data-current", "true")
          else element.removeAttribute("data-current")
        },
        setFile(file: string | undefined) {
          fileLine.textContent = file ?? ""
        },
      }
      view.setFile(page.file)
      iframe.addEventListener("load", () => {
        // The initial about:blank and an eviction's about:blank both fire
        // `load` too; only the page this frame was asked for counts.
        if (iframe.getAttribute("src") !== page.path) return
        // A frame that reloads on its own (a full hot reload) is a new document
        // with none of the clean-up in it.
        if (view.status === "loaded") cleanFrameDocument(iframe, options.hideSelector)
        finish(page.path)
      })
      views.set(page.path, view)
      return view
    },

    remove(path) {
      const view = views.get(path)
      if (!view) return
      clearTimeout(view.timer)
      if (loading === path) loading = null
      view.element.remove()
      views.delete(path)
      pump()
    },

    views: () => Array.from(views.values()),

    schedule(order) {
      clearTimeout(idleTimer)
      desired = order.slice()
      pump()
    },

    loadedCount: () => loaded().length,

    holdFresh(ms) {
      const view = loading ? views.get(loading) : undefined
      if (!view || view.status !== "loading" || performance.now() - view.startedAt >= ms) return
      // Still the document it had before `src` was set: nothing has committed.
      if (view.iframe.contentDocument !== view.before) return
      clearTimeout(view.timer)
      loading = null
      view.iframe.setAttribute("src", "about:blank")
      setStatus(view, "idle")
    },

    /*
     * A closed board's frames are still running apps behind `display: none`:
     * each one keeps its timers and fetches, and re-runs every hot update the
     * editor's own writes trigger. Kept for a while so a quick reopen is
     * instant, then dropped. Back to "idle", not "evicted", so a reopen shows
     * the same "Loading…" placeholders a first opening does.
     */
    release(ms) {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        desired = []
        loading = null
        for (const view of views.values()) {
          if (view.status !== "loaded" && view.status !== "loading") continue
          clearTimeout(view.timer)
          view.iframe.setAttribute("src", "about:blank")
          view.title = ""
          setStatus(view, "idle")
        }
      }, ms) as unknown as number
    },

    destroy() {
      clearTimeout(idleTimer)
      for (const view of views.values()) {
        clearTimeout(view.timer)
        view.element.remove()
      }
      views.clear()
      loading = null
      desired = []
    },
  }
}
