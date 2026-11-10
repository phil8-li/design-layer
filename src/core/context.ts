/**
 * The single object every lane receives. Lanes never import each other; they
 * read state from the store, act through `select`/`commands`, and mount their
 * own DOM into the slot they are handed.
 */

import { config } from "./config"
import type { ToastAction, ToastKind, ToastMessage } from "./toast"
import {
  elementKey,
  getState,
  primarySelection,
  setChromeHidden,
  setMode,
  setState,
  subscribe,
  type EditorMode,
  type EditorState,
} from "./store"
import { resolveElementSource, toSourceRef, type RewriteBridge } from "./bridge"
import type { LayerElement, Selection, ToolId } from "./types"

export interface EditorSlots {
  /** Fixed layer above the app, below the panels — canvas chrome lives here. */
  overlay: HTMLElement
  /** Top toolbar strip. */
  toolbar: HTMLElement
  /** Scrollable body of the left (layers) panel. */
  left: HTMLElement
  /** Scrollable body of the right (inspector) panel. */
  right: HTMLElement
}

/**
 * What a lane may write through `setState`: everything but the mode pair and
 * the hide switch, which have one writer each (`setMode`, `setChromeHidden`)
 * so the illegal (interactive, annotating) pair and a stale hover after a hide
 * cannot be written by accident. Suites that need a raw write import the
 * store's own `setState`.
 */
export type LaneStatePatch = Partial<Omit<EditorState, "interactive" | "annotating" | "chromeHidden">>

export interface EditorContext {
  bridge: RewriteBridge
  slots: EditorSlots
  getState: typeof getState
  setState(patch: LaneStatePatch): void
  subscribe: typeof subscribe
  primarySelection: typeof primarySelection
  /** Selects an element (or clears selection with `null`). */
  select(el: LayerElement | null, options?: { additive?: boolean }): void
  /** Replaces the selection in one store write — one repaint, not one per element. */
  selectMany(els: LayerElement[]): void
  /**
   * `tool` is a one-member union today (`ToolId`); kept because suites outside
   * this lane still call it. No product caller.
   */
  setTool(tool: ToolId): void
  /**
   * Moves to one of the three pointer modes, and nothing else — the store's
   * pure `setMode`. For a restore or a scripted switch (a companion, a suite).
   */
  setMode(mode: EditorMode): void
  /**
   * A PERSON choosing a mode: the mode, and the right panel that answers it —
   * Design for `inspecting`, Changes for `annotating`. The toolbar's buttons
   * and the mode keys call this. See the implementation for why that rule
   * lives here rather than on the buttons.
   */
  chooseMode(mode: EditorMode): void
  /** Stands the editor down to the launcher disc, or brings it back. */
  setChromeHidden(hidden: boolean): void
  /** Rebuilds every registered panel. Cheap: panels diff internally. */
  refresh(): void
  onRefresh(fn: () => void): () => void
  /**
   * Says what just happened, and — for the one case that needs it — offers to
   * take it back.
   *
   * `action` is a single optional undo rather than a general options bag, for
   * the reason `core/toast.ts` gives on `ToastAction`: a toast reports, and the
   * only interaction that belongs on a report is unmaking it.
   */
  toast(message: ToastMessage, kind?: ToastKind, action?: ToastAction): void
  /** Base URL for designlayer server routes, e.g. `/__designlayer`. */
  apiBase: string
}

export function createContext(bridge: RewriteBridge, slots: EditorSlots): EditorContext {
  // Per context, so two contexts in one suite do not refresh each other.
  const refreshListeners = new Set<() => void>()
  /**
   * React 19 dropped `fiber._debugSource`, so the synchronous walk behind
   * `toSourceRef` answers `null` for every element in this app — measured 0/12
   * on a live page, against 12/12 for the owner-stack resolver. The handover
   * copes by resolving lazily when notes are sent, but a Selection built here
   * is also what the inspector header reads, which is why it showed a component
   * name and no file. Nothing else may re-derive an element's source: this
   * patches the stored Selection in place when the resolver lands, so the panel
   * repaints from the one answer rather than asking a second time.
   *
   * In place for real, and announced on `sourceRevision` rather than a new
   * `selection` array — see the identity rule on `EditorState.selection`. A
   * fresh array here made every click a double select: the layers tree
   * re-rendered and re-scrolled, the inspector rebuilt, the announcer said
   * "selected" twice and a Controls highlight raised in between was dropped.
   * The writer already fills `source` in place the same way (`ensureSource`).
   *
   * Only the element the inspector is actually describing is primed. A marquee
   * over fifty nodes would otherwise pay fifty owner-stack walks to fill a
   * header that shows one of them.
   */
  const primeSource = (element: LayerElement): void => {
    void resolveElementSource(bridge, element)
      .then((source) => {
        if (!source) return
        const state = getState()
        const entry = state.selection.find((candidate) => candidate.element === element)
        // Gone, or already answered by a later selection: leave it alone.
        if (!entry || entry.source) return
        entry.source = source
        setState({ sourceRevision: state.sourceRevision + 1 })
      })
      .catch(() => null)
  }

  const describe = (element: LayerElement): Selection => {
    const info = bridge.elementInfo(element)
    const componentName = info?.componentName || element.tagName.toLowerCase()
    return {
      element,
      tagName: element.tagName.toLowerCase(),
      componentName,
      source: toSourceRef(info),
      key: elementKey(element, componentName, info?.lineNumber ?? 0),
    }
  }

  const context: EditorContext = {
    bridge,
    slots,
    getState,
    setState,
    subscribe,
    primarySelection,
    apiBase: config.apiBase,

    select(element, options = {}) {
      if (!element) {
        setState({ selection: [] })
        return
      }
      const selection = describe(element)
      if (!selection.source) primeSource(element)
      const current = getState().selection
      if (options.additive) {
        const existing = current.findIndex((entry) => entry.element === element)
        setState({
          selection:
            existing === -1
              ? [...current, selection]
              : current.filter((_, index) => index !== existing),
        })
        return
      }
      // No identity early-return. The same element can need a fresh Selection:
      // a source edit moves the line it was described from, and drilling
      // re-selects it at a different depth. Skipping the write leaves both
      // stale, and the object is cheap to rebuild.
      setState({ selection: [selection] })
    },

    selectMany(elements) {
      const seen = new Set<LayerElement>()
      const selection: Selection[] = []
      for (const element of elements) {
        if (seen.has(element)) continue
        seen.add(element)
        selection.push(describe(element))
      }
      if (selection.length && !selection[0].source) primeSource(selection[0].element)
      setState({ selection })
    },

    setTool(tool) {
      setState({ tool })
    },

    setMode,

    /**
     * The mode, and the right panel that answers it.
     *
     * Each of the two working modes has a tab that is the rest of it. Inspect
     * selects an element and Design is where its properties are read and
     * written; Notes pins a comment and Changes is the list those land in. A
     * designer who turns one on and then has to go and find the matching tab is
     * doing the editor's filing for it — and the pairing is not a guess, it is
     * the only tab either mode has anything to say to.
     *
     * HERE rather than in the toolbar's two click handlers, because a person
     * reaches a mode by two doors: the buttons and the keymap (`mode.inspect`,
     * `mode.notes`). A rule written on the buttons would leave the keys
     * switching a mode into a panel still showing the other one's tab. A
     * companion is not a person choosing: it goes through the pure `setMode`.
     *
     * The panel is OPENED, not merely retabbed, which is the same bargain
     * `panel.inspector.tab1..3` already struck: a tab switched behind a closed
     * panel is indistinguishable from a control that did nothing. Leaving a
     * mode is not a request for a tab — `interactive` writes neither, so
     * pressing Notes off leaves the Changes list up to read rather than
     * snapping the panel back to Design under the pointer.
     *
     * One `setState` for both flags, after the mode write: two writes paint an
     * open panel on the old tab for a frame, and every subscriber in the editor
     * would run twice for one user action.
     */
    chooseMode(mode) {
      setMode(mode)
      const tab = mode === "annotating" ? "annotations" : mode === "inspecting" ? "design" : null
      if (tab) setState({ inspectorOpen: true, inspectorTab: tab })
    },

    setChromeHidden,

    refresh() {
      for (const listener of refreshListeners) listener()
    },

    onRefresh(fn) {
      refreshListeners.add(fn)
      return () => refreshListeners.delete(fn)
    },

    /*
     * Through the bridge, which is OUR seam and not only the vendor's.
     *
     * Calling `notify` directly from here looks tidier and is wrong twice over.
     * `withEditorToast` in `core/bridge.ts` replaces the vendor's method with
     * `notify` precisely so that no path in the product can paint the old
     * toast — so the bridge IS the one place every message passes through, and
     * a second route around it is the thing that file exists to prevent. It is
     * also the seam the suites substitute: a context built over a stub bridge
     * observes what the editor said without standing up React and a shadow
     * root, and a direct call would make every one of those cases blind.
     *
     * The third parameter is ours, not the vendor's — see the note on `toast`
     * in `RewriteBridge`.
     */
    toast(message, kind = "info", action) {
      bridge.toast(message, kind, action)
    },
  }

  return context
}
