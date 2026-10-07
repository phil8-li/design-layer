/**
 * The single object every lane receives. Lanes never import each other; they
 * read state from the store, act through `select`/`commands`, and mount their
 * own DOM into the slot they are handed.
 */

import { config } from "./config"
import type { ToastAction, ToastMessage } from "./toast"
import {
  elementKey,
  getState,
  primarySelection,
  setMode,
  setState,
  subscribe,
  type EditorMode,
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

export interface EditorContext {
  bridge: RewriteBridge
  slots: EditorSlots
  getState: typeof getState
  setState: typeof setState
  subscribe: typeof subscribe
  primarySelection: typeof primarySelection
  /** Selects an element (or clears selection with `null`). */
  select(el: LayerElement | null, options?: { additive?: boolean }): void
  /** Replaces the selection in one store write — one repaint, not one per element. */
  selectMany(els: LayerElement[]): void
  setTool(tool: ToolId): void
  /**
   * Enters or leaves pass-through mode. Entering it drops the hover target as
   * well: the highlight is suppressed either way, but a stale `hovered` would
   * keep the chrome's frame loop awake for a canvas nobody is painting.
   */
  setInteractive(interactive: boolean): void
  /**
   * Moves to one of the three pointer modes, clearing the others.
   *
   * Offered beside `setInteractive` rather than replacing it because the shell
   * and the keymap still speak in "hand the pointer back", which is one edge of
   * the same idea. Anything CHOOSING a mode should call this: it is the only
   * path that cannot leave the editor interactive and annotating at once.
   *
   * It also BRINGS THE RIGHT PANEL WITH IT — Design for `inspecting`, Changes
   * for `annotating`. See the implementation for why that rule lives here
   * rather than on the two buttons.
   */
  setMode(mode: EditorMode): void
  /**
   * Stands the whole editor down to a single floating button, or brings it
   * back. Drops the hover target for the same reason `setInteractive` does.
   */
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
  toast(message: ToastMessage, kind?: "info" | "error", action?: ToastAction): void
  /** Base URL for designlayer server routes, e.g. `/__designlayer`. */
  apiBase: string
}

const refreshListeners = new Set<() => void>()

export function createContext(bridge: RewriteBridge, slots: EditorSlots): EditorContext {
  /**
   * React 19 dropped `fiber._debugSource`, so the synchronous walk behind
   * `toSourceRef` answers `null` for every element in this app — measured 0/12
   * on a live page, against 12/12 for the owner-stack resolver. The writer
   * already copes by resolving lazily at Apply time, but a Selection built here
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

    setInteractive(interactive) {
      setState(interactive ? { interactive, hovered: null } : { interactive })
    },

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
     * HERE rather than in the toolbar's two click handlers, because the modes
     * have three doors: the buttons, the keymap (`mode.inspect`, `mode.notes`)
     * and anything else that reaches a mode through this context. A rule
     * written on the buttons would leave the keys switching a mode into a panel
     * still showing the other one's tab.
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
    setMode(mode) {
      setMode(mode)
      const tab = mode === "annotating" ? "annotations" : mode === "inspecting" ? "design" : null
      if (tab) setState({ inspectorOpen: true, inspectorTab: tab })
    },

    setChromeHidden(hidden) {
      // Cleared in BOTH directions, unlike the mode switch. Going out, a stale
      // hover would keep the frame loop awake over a canvas nobody is drawing;
      // coming back, the pointer has been over the app for a while and the
      // element it last rested on is not news worth painting an outline for.
      setState({ chromeHidden: hidden, hovered: null })
    },

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
