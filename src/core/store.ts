/**
 * Editor state. A tiny observable store so every panel reads one source of
 * truth for selection and tool — the same rule the app itself follows for
 * continuous gestures (one live value, many followers).
 *
 * WHO OWNS THE POINTER. Four inputs decide it, read through `editorOwnsInput`
 * and `selectionOwnsInput` below; every mode combines with every
 * `chromeHidden` × `canvasView`, so there is no illegal row to forbid, only an
 * owner to name:
 *
 *   chromeHidden  canvasView  mode         owner
 *   true          any         any          the app (one disc on screen)
 *   false         true        any          the board (canvas view)
 *   false         false       interactive  the app
 *   false         false       annotating   the editor, pinning notes
 *   false         false       inspecting   the editor, selecting
 *
 * The mode survives hiding and the board, so leaving either lands back in
 * whichever mode was live. Writers: `setMode` (the mode pair), `setChromeHidden`
 * (hiding), the board (`canvasView`, a mirror of its own phase). Anything that
 * mirrors the answer outside the store (a class on `<html>`, a painter)
 * recomputes on `editorStandDownChanged`, never on one input it picked.
 *
 * Notification order: a listener that writes during a notification does not
 * interleave. Its patch is queued and applied when the current round ends, as
 * a round of its own with its own `previous`, so every listener sees every
 * change once and in order, and `getState()` (and every reader built on it)
 * agrees with the `next` the round's listeners were handed. A patch used to
 * land at once: later listeners of the same round read state their `previous`
 * did not account for, and a listener that threw left that patch applied and
 * never announced. Now a throw drops the queued patches unapplied.
 */

import type { ElementOptionSet, LayerElement, Selection, ToolId } from "./types"

export interface EditorState {
  tool: ToolId
  /**
   * Hands the page back to the app: clicks, keys and drags reach the product
   * instead of the editor, and the canvas paints nothing over it.
   *
   * Default `false`, because the editor's whole reason to exist is that a click
   * selects rather than navigates. This is a MODE rather than a tool — a tool
   * changes what a canvas gesture means, this decides whether there is a canvas
   * gesture at all — so it lives beside `tool` instead of inside it.
   */
  interactive: boolean
  /**
   * Primary selection is `selection[0]`.
   *
   * THE IDENTITY RULE: this array is replaced only when the selected ELEMENTS
   * change (or a record is deliberately rebuilt, as `select` does on a
   * re-click). Every subscriber that diffs `selection` by identity — the layers
   * tree and its scroll, the inspector rebuild, the screen-reader announcer, the
   * canvas highlight reset — is paying for a new subject, so a write that only
   * learns more about the same subject must not trip them. Late facts about a
   * record are patched into it in place and announced on their own counter;
   * `sourceRevision` is the one that exists.
   */
  selection: Selection[]
  /**
   * Bumped when a stored Selection's `source` is filled in after the fact.
   *
   * React 19 answers an element's source asynchronously (the owner-stack
   * resolver in `core/context.ts`), so the record is complete a microtask to a
   * few hundred milliseconds after the click. Republishing `selection` for that
   * re-ran every selection subscriber for a fact only the panes that SHOW a
   * source care about, so the record is patched in place and this counter tells
   * those panes — today the inspector's Instance and Classes sections — to
   * re-read it. Everything else reads `source` lazily at the moment it needs
   * it (the handover when notes are copied or sent), so nothing goes stale.
   */
  sourceRevision: number
  /**
   * The container the user has drilled into. Plain clicks resolve against it,
   * so "select the parent" has one answer instead of "which parent?". `null`
   * means the scope root, which is where a click on the background returns it.
   */
  scope: Element | null
  /** Already resolved: the painter must never re-run the resolver per frame. */
  hovered: Element | null
  /**
   * Elements the user has locked from the layers tree.
   *
   * A lock is a property of THIS EDITING SESSION, not of the user's app. It
   * says "stop letting me grab this on the canvas", which is a fact about the
   * pointer and not about the product — there is nothing in the JSX it could
   * correspond to. That is exactly why it is never written to source and never
   * reaches the change ledger, and it is the one row affordance that differs
   * from the eye beside it, which is a real edit.
   *
   * It lives in the store rather than in the layers panel because the canvas
   * lane is the one that has to honour it, and lanes read each other only
   * through here. Keyed by the element, the same way the tree keys its rows.
   *
   * Replaced rather than mutated on every toggle: `setState` compares by
   * identity, so a Set edited in place would notify nobody.
   */
  locked: ReadonlySet<Element>
  layersOpen: boolean
  inspectorOpen: boolean
  /**
   * Which of the inspector's tabs is showing.
   *
   * It lives here rather than staying the private variable it was inside
   * `installInspector`, because other lanes have to be able to say "show me
   * the Changes tab": choosing a mode brings its tab (`chooseMode` in
   * `core/context.ts`), and the keymap reaches tabs by slot. The store is how
   * every lane in this editor reaches another one, and a direct call into the
   * panel would be the first exception to that.
   *
   * The inspector still OWNS it: it writes this when a tab is clicked and reads
   * it to decide what to show, so the two directions are one value rather than
   * a setter with a second opinion beside it. Anything else wanting a tab asks
   * the same way and never learns the panel's internals.
   */
  inspectorTab: string
  /**
   * Which of the left panel's tabs is showing — Layers, Assets, Design system.
   *
   * Here for the reason `inspectorTab` is here, arrived at one surface later:
   * the keyboard has to be able to say "show me Assets" (⌥2, Figma's key), and
   * the store is how one lane reaches another. `panels/left.ts` still OWNS it —
   * it writes on a tab click and reads to decide what to show — so the value is
   * one fact rather than a setter with a second opinion beside it.
   *
   * A string rather than a union of the three ids, matching `inspectorTab`: the
   * panel decides what tabs exist, and a type here would be a second list to
   * keep in step with the array that actually builds them.
   */
  leftTab: string
  /**
   * Whether the left panel's Controls tab lists every app control or only the
   * ones bound to the current selection.
   *
   * Here for the reason `leftTab` and `inspectorTab` are here, and arrived with
   * a second writer from the start: the Controls pane's own chips set it, and
   * so does the right panel's "N app controls affect this element" button,
   * which has to open the tab AND scope it in one `setState` — two writes would
   * paint the unscoped list for a frame. `panels/controls.ts` still owns the
   * value in the sense that matters: it is the only thing that reads it.
   *
   * A real union rather than the bare `string` the two tab fields carry,
   * because this one is not a list a panel owns. There are exactly two scopes
   * and there is no third a future pane could add without changing what the
   * word means, so the type can say so and every reader gets the narrowing.
   *
   * Defaults to `"all"`. A pane that opened scoped would be a pane that shows
   * nothing on a cold load, since nothing is selected yet — and "everything the
   * app exposes" is the question this tab exists to answer.
   */
  controlsScope: "all" | "selection"
  /**
   * The editor stands down entirely: no panels, no toolbar, no canvas chrome —
   * one floating button to bring it back, and nothing else.
   *
   * Not the same thing as closing both panels. `layersOpen` and `inspectorOpen`
   * say which surface you want to READ while you work; this one says you are
   * not working in the editor for a minute, so it hands the pointer back to the
   * app as well (see `editorOwnsInput`). Closing both panels leaves a toolbar
   * that still swallows every click, which is the state this exists to replace.
   *
   * Deliberately not persisted: a session that started hidden would look like
   * an editor that failed to load, and the way back is one click.
   */
  chromeHidden: boolean
  /**
   * Annotation mode: a click pins a note instead of selecting one.
   *
   * A mode beside `interactive` rather than a `tool`, for the same reason
   * `interactive` is one: a tool changes what a canvas gesture MEANS to the
   * selection lane, and this decides whether the selection lane sees the
   * gesture at all. The two are mutually exclusive by construction — the
   * toolbar drops one when it raises the other — because "hand every click to
   * the app" and "intercept every click" cannot both answer the same question.
   */
  annotating: boolean
  /**
   * Canvas view: every page of the app laid out on one pan/zoom board.
   *
   * A view rather than a mode. The three modes answer "what does a click on the
   * PAGE do", and in canvas view there is no page under the pointer to answer
   * for — there is a board of frames, and the board owns the pointer. So the
   * gate below stands the canvas lane down while it is up, the same way hidden
   * chrome does, and leaving it lands back in whichever mode was live before.
   *
   * Not persisted: a reload lands on the live page, which is what the URL says.
   */
  canvasView: boolean
  /** Option sets keyed by `Selection.key`. */
  optionSets: Record<string, ElementOptionSet>
}

type Listener = (state: EditorState, previous: EditorState) => void

const state: EditorState = {
  tool: "move",
  interactive: false,
  selection: [],
  sourceRevision: 0,
  scope: null,
  hovered: null,
  locked: new Set<Element>(),
  layersOpen: true,
  inspectorOpen: true,
  // Design, the same tab `installInspector` has always landed on. Named here
  // rather than left empty so the panel has an answer before it first paints.
  inspectorTab: "design",
  // Layers, which is the tab `installLeftPanel` has always landed on — the tree
  // answers "what is on this page", and that is the question a session opens
  // with. Named here for the same reason `inspectorTab` is: the panel has an
  // answer before it first paints.
  leftTab: "layers",
  // Everything, because on a cold load there is no selection to scope to and a
  // pane that opened on "this element" would open empty.
  controlsScope: "all",
  chromeHidden: false,
  annotating: false,
  canvasView: false,
  optionSets: {},
}

const listeners = new Set<Listener>()

export function getState(): Readonly<EditorState> {
  return state
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/*
 * Patches written from inside a listener, oldest first, each applied when the
 * round before it ends. See "Notification order" in the header.
 */
const pending: Array<Partial<EditorState>> = []
let notifying = false

/** Lands a patch; the state from just before it, or null when nothing changed. */
function apply(patch: Partial<EditorState>): EditorState | null {
  const previous = { ...state }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (state[key as keyof EditorState] === value) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(state as any)[key] = value
    changed = true
  }
  return changed ? previous : null
}

export function setState(patch: Partial<EditorState>): void {
  if (notifying) {
    pending.push(patch)
    return
  }
  let previous = apply(patch)
  if (!previous) return
  notifying = true
  try {
    while (previous) {
      // A snapshot, so a listener that keeps `next` holds this round's state.
      const next = { ...state }
      for (const listener of listeners) listener(next, previous)
      // Compared when it lands, not when it was written: a later patch can
      // undo an earlier one, and then it is a change again.
      previous = null
      while (!previous && pending.length) previous = apply(pending.shift() as Partial<EditorState>)
    }
  } finally {
    notifying = false
    pending.length = 0
  }
}

export function primarySelection(): Selection | null {
  return state.selection[0] ?? null
}

/**
 * Whether a canvas gesture belongs to the editor at all.
 *
 * Every pointer and key handler in the canvas lane asks this one function
 * rather than reading `interactive` for itself. Interactive mode is only
 * trustworthy if it is airtight: a mode that leaks through a single handler —
 * the double-click that still drills, the pointerdown that still starts a drag
 * — is worse than no mode, because the user has already stopped expecting the
 * editor to intercept anything.
 *
 * Hidden chrome answers the same way, and has to: an editor with nothing on
 * screen that still ate every click would be indistinguishable from a page
 * that had frozen. Two reasons, one gate — which is the whole point of asking
 * a function. The painters ask it too, so a stale outline cannot be left over
 * an app the editor has stood down from.
 *
 * Canvas view is the third reason: the page is behind the board, so an outline
 * or a note pin drawn over it would float over frames it does not belong to.
 */
export function editorOwnsInput(): boolean {
  return !state.interactive && !state.chromeHidden && !state.canvasView
}

/**
 * Whether the SELECTION lane should act on a canvas gesture.
 *
 * Narrower than `editorOwnsInput`, and the difference is annotation mode. The
 * editor owns the pointer more firmly than ever while annotating — it is
 * intercepting every click — but the thing it does with it is pin a note, not
 * move a selection. Hover outlines, drag-to-move, marquee, the layer menu and
 * the arrow-key nudge all ask this instead, so annotation mode cannot leak a
 * resize handle or a drilled scope out of one handler that forgot.
 *
 * Kept here beside `editorOwnsInput` rather than in the annotation lane so
 * that the canvas has one place to ask, and both answers come from one store.
 */
export function selectionOwnsInput(): boolean {
  return editorOwnsInput() && !state.annotating
}

/**
 * Whether a write changed either answer above.
 *
 * A painter gated on `editorOwnsInput` or `selectionOwnsInput` has to wake when
 * the gate moves, not only when its own data does — or it stands down when the
 * board opens and then stays dark after the board closes, because closing it
 * changed nothing the painter was watching. One comparison over all four inputs,
 * so a gate that grows a fifth reason grows it here once.
 */
export function editorStandDownChanged(next: EditorState, previous: EditorState): boolean {
  return (
    next.interactive !== previous.interactive ||
    next.chromeHidden !== previous.chromeHidden ||
    next.canvasView !== previous.canvasView ||
    next.annotating !== previous.annotating
  )
}

/**
 * What a click does. There are exactly three answers.
 *
 * `inspecting` selects, `annotating` pins a note, `interactive` hands the
 * pointer back to the app. They are stored as two booleans for the same reason
 * they always were — every gate in the canvas lane reads one of them — but two
 * booleans spell FOUR states, and the fourth (`interactive` and `annotating`
 * both true) is not a mode anybody can describe. A user who reached it would be
 * clicking on a page where nothing happened, with two lit controls and no way
 * to tell which was lying.
 *
 * So the pair is written through `setMode` and read through `editorMode`, and
 * the illegal combination is unreachable by construction rather than by every
 * call site remembering to clear the other flag.
 */
export type EditorMode = "inspecting" | "annotating" | "interactive"

export function editorMode(): EditorMode {
  if (state.annotating) return "annotating"
  return state.interactive ? "interactive" : "inspecting"
}

/**
 * Moves to one of the three, clearing whatever the last one set.
 *
 * The PURE move: the mode and nothing else. A person choosing a mode also gets
 * the inspector tab that answers it (`EditorContext.chooseMode`); a restore —
 * a companion handing the pointer back — must not, or it throws open a panel
 * the person closed.
 *
 * Dropping the hover target on the way out of `inspecting`: `hovered` is
 * written on every pointermove and a stale one keeps the canvas frame loop
 * awake painting an outline over an app the editor has stood down from.
 */
export function setMode(mode: EditorMode): void {
  setState({
    interactive: mode === "interactive",
    annotating: mode === "annotating",
    ...(mode === "inspecting" ? {} : { hovered: null }),
  })
}

/**
 * The drilled scope, with one reader and one writer.
 *
 * `scope` and `selection` are two fields of this store, and they used to be
 * cleared together by hand in three places and written in nine, each reader
 * patching a scope the app had since unmounted on its own. `activeScope` is
 * the reader: a detached scope reads as none. `setScope` is the writer, and
 * `clearSelection` the one way to empty both, in one write.
 */
export function activeScope(): Element | null {
  const held = state.scope
  return held?.isConnected ? held : null
}

export function setScope(scope: Element | null): void {
  setState({ scope })
}

export function clearSelection(): void {
  setState({ selection: [], scope: null })
}

/** Whether a write moved the mode. The one diff every mode follower uses. */
export function modeChanged(next: EditorState, previous: EditorState): boolean {
  return next.interactive !== previous.interactive || next.annotating !== previous.annotating
}

/**
 * Stands the whole editor down to the launcher disc, or brings it back. The
 * one writer of `chromeHidden`: the bar's Hide button, the keys, the escape
 * stop and the disc all come through here.
 *
 * The hover target is cleared in BOTH directions, unlike the mode switch.
 * Going out, a stale hover would keep the frame loop awake over a canvas
 * nobody is drawing; coming back, the pointer has been over the app for a
 * while and the element it last rested on is not news worth an outline.
 */
export function setChromeHidden(hidden: boolean): void {
  setState({ chromeHidden: hidden, hovered: null })
}

/**
 * Whether the canvas should refuse to hit-test `element`.
 *
 * Asked as a function for the same reason as `editorOwnsInput`: the lock is
 * only worth anything if every path that can grab an element asks the same
 * question. The tree deliberately does NOT ask it — a locked layer stays
 * selectable from the panel, which is the only way back out of the lock.
 */
export function isLocked(element: Element | null): boolean {
  return Boolean(element && state.locked.has(element))
}

/** `tag` plus index among same-tag siblings — one step of a DOM path. */
function step(el: Element): string {
  let index = 0
  for (const sibling of Array.from(el.parentElement?.children ?? [])) {
    if (sibling === el) break
    if (sibling.tagName === el.tagName) index += 1
  }
  return `${el.tagName.toLowerCase()}${index}`
}

/**
 * Stable identity for an element across re-renders: component + source line +
 * a short ancestor path. Good enough to key saved options without writing
 * anything into the app's DOM.
 *
 * The path matters: the engine reports one source line per JSX element, so
 * every item rendered from a `.map()` — and every element the engine cannot
 * resolve at all, which reports line 0 — would otherwise collapse onto one key
 * and share another element's saved options.
 */
export function elementKey(el: LayerElement, componentName: string, line: number): string {
  const path: string[] = []
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    path.unshift(step(node))
    if (path.length === 6) break
  }
  return `${componentName || "?"}:${line}:${path.join("/")}`
}
