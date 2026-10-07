/**
 * One keymap for the editor chrome, and it is Figma's.
 *
 * The guards used to be re-derived in every listener, so a new shortcut was one
 * forgotten `isChrome` away from moving the selected element while the user was
 * arrowing through the layers tree.
 *
 * ## Why Figma's keys and not our own
 *
 * The people using this editor spend their day in Figma. Every key they already
 * know is a key we do not have to teach, and — more to the point — every key we
 * bind DIFFERENTLY from Figma is one they will press by accident for the rest of
 * the session. So the table below is a transcription rather than a design: each
 * row names the Figma command it comes from, and a row exists only where this
 * editor has something that command honestly means here.
 *
 * Three translations are worth stating, because they are the ones a reader will
 * want to argue with:
 *
 *   - **V, C and H are our three modes.** Figma's Move tool selects, its comment
 *     tool pins a note, and its Hand tool is the one state where a click does
 *     not touch the objects underneath. That is exactly `inspecting`,
 *     `annotating` and `interactive` — the mapping is a coincidence of design
 *     rather than a stretch, and it means the mode switch has the keys a
 *     designer already reaches for. One divergence: V and C toggle, so a second
 *     press drops back to interactive, as the toolbar buttons do.
 *   - **A is an alias for V.** In Figma it is the Frame tool. This editor edits
 *     a DOM that already exists and can no more create a frame than it can
 *     create a page, so the key is unclaimed, and it was asked for.
 *   - **⌘] and ⌘[ reorder SOURCE, not z-index.** See `core/arrange.ts`: front is
 *     the first JSX child. In a document flow that is what "bring forward"
 *     means, and z-index is a property this editor cannot write.
 *
 * Nothing is invented. Where Figma has a command and we have nothing to do with
 * it — the pen, the shape tools, zoom, pixel grid — there is no row, because a
 * key that is bound and does nothing is worse than a key that is free: it
 * swallows a keystroke the prototype underneath might have wanted.
 *
 * ## Where the keys are answered
 *
 * `shell/shortcuts.ts` is the only module that listens, and it dispatches
 * through `core/commands.ts`. The canvas lane still answers the five navigation
 * keys itself, because those depend on the selection, the scope and the
 * resolver memo it already holds — so they carry `owner: "canvas"` here. They
 * are in the table anyway: this is the one place that answers "what does this
 * key do?", and a table that omitted Tab because another file handles it would
 * be a table you cannot trust.
 *
 * ⌘. is the other exception. `shell/way-back.ts` answers it, because it has to
 * be heard in places `shell/shortcuts.ts` deliberately is not: inside a text
 * field, inside a frame, from the Mac app's tab strip. See `everywhereShortcut`.
 */

import { isChrome } from "./dom"
import type { CommandId } from "./commands"

export type CanvasAction =
  | "deselect"
  | "select-child"
  | "select-parent"
  | "next-sibling"
  | "prev-sibling"
  | "nudge"
  | "delete"

/** Arrow deltas in px. Shift multiplies. */
export const NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

export function isMac(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

/**
 * Deep select is Cmd on Mac and Ctrl everywhere else — never both. On macOS
 * Ctrl+click is the system context-menu gesture, so accepting it here deep
 * selects and opens a menu on the same press.
 */
export function isDeepSelect(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac() ? event.metaKey : event.ctrlKey
}

/** Editing text is editing text: the canvas keeps its hands off those keys. */
export function isTextEntry(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false
  if (node.isContentEditable) return true
  return node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT"
}

/**
 * Where a key press actually came from, shadow roots included.
 *
 * `event.target` is RETARGETED at a shadow boundary: a keystroke typed into a
 * `<textarea>` inside somebody's shadow root arrives at this editor as its
 * host element, which is not a text field by any test. The editor then read it
 * as a bare key press on the page and spent it on a single-letter shortcut.
 *
 * That is not a hypothetical. Typing a sentence into a companion toolbar whose
 * UI lives in a shadow root came out as "Noe oggle red bubble" — every `a`,
 * `c`, `h`, `s` and `t` eaten, because those five letters are tools on the
 * keymap below and each one was `preventDefault`ed on its way to the caret.
 * Any host app with a shadow-DOM text field loses characters the same way.
 *
 * `composedPath()[0]` is the real innermost target, before retargeting.
 */
function deepTarget(event: Event): EventTarget | null {
  return event.composedPath()[0] ?? event.target
}

/** Whether a key press landed in a text field, wherever that field lives. */
export function isTextEntryEvent(event: Event): boolean {
  return isTextEntry(deepTarget(event))
}

/**
 * Whether a key press landed in chrome — this editor's, the host's dev GUI, or
 * a companion's.
 *
 * Asked of the whole composed path rather than of one node, because the two
 * ends answer different halves: a shadow host carries the trusted selector a
 * companion declared, while the nodes inside its shadow root are the ones a
 * `closest()` from the outside can never reach.
 */
export function isChromeEvent(event: Event): boolean {
  return event.composedPath().some((node) => isChrome(node))
}

/**
 * Keys pressed inside our own chrome belong to that control. Without this the
 * layers tree's arrows would nudge the selected element, and Tab on `window`
 * capture would make every panel unreachable by keyboard.
 */
export function ownsCanvasKeys(event: KeyboardEvent): boolean {
  return !isChromeEvent(event) && !isTextEntryEvent(event)
}

/* ══════════════════════════ The Figma keymap ══════════════════════════════ */

/**
 * One chord, described rather than matched by hand.
 *
 * `key` or `code`, never both, and which one is a real decision per row:
 *
 *   - **`key`** is the character the user believes they are typing, so a French
 *     or German layout gets the shortcut where the letter actually is. Every
 *     bare letter uses it, and so does ⌘. — the period is a period wherever the
 *     keyboard keeps it.
 *   - **`code`** is the physical key, and it is what a chord with ⌥ or ⇧ on a
 *     digit or a bracket MUST use. On macOS ⌥8 does not report `"8"`, it
 *     reports `"•"`; ⇧2 reports `"@"`; ⇧\ reports `"|"`. Matching those on
 *     `key` is how a shortcut comes to work on the reviewer's keyboard and
 *     nowhere else.
 *
 * The four modifier flags are EXACT: a flag left off means the modifier must be
 * absent, not that we do not care. That is what lets ⌘] and ⌥⌘] be two commands
 * rather than one that fires twice, and it is why ⌃⌘Z on a Mac falls through to
 * whoever wants it instead of being read as undo.
 *
 * `mod` is the platform accelerator — ⌘ on a Mac, Ctrl everywhere else. `ctrl`
 * is literally Control on both, which only Figma's shortcuts-panel key needs.
 */
export interface Chord {
  /** Lowercased `event.key`. For letters and for characters no modifier rewrites. */
  key?: string
  /** `event.code`. For digits, brackets and slashes, which ⌥ and ⇧ rewrite. */
  code?: string
  /** ⌘ on a Mac, Ctrl elsewhere. */
  mod?: boolean
  /** Control on both platforms. On Windows this and `mod` are the same key. */
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export type ShortcutGroup = "Tools" | "View" | "Selection" | "Arrange" | "Edit" | "Help"

export interface Shortcut {
  /** The name `core/commands.ts` knows it by. */
  command: CommandId
  chord: Chord
  /** Extra chords for the same command. Listed in the panel, matched the same. */
  aliases?: Chord[]
  /** What it does HERE, in the words the shortcuts panel prints. */
  label: string
  /** What it is in Figma. The lineage, stated so a divergence is visible. */
  figma: string
  group: ShortcutGroup
  /**
   * Who answers the key.
   *
   * `"canvas"` rows are documentation: `canvas/index.ts` has answered Tab,
   * Enter, Escape, the arrows and Delete since before this table existed, and
   * it answers them against the selection, the scope and a resolver memo that
   * only it holds. Moving them here would be a refactor of the selection lane
   * dressed up as a keymap change. They are listed because this file is meant
   * to be the complete answer to "what does this key do", and a table with
   * holes in it is one nobody checks before binding something new.
   */
  owner?: "shortcuts" | "canvas"
  /**
   * Answered wherever focus is: in a text field, in a frame on the page, on the
   * Mac app's tab strip, and while the editor is collapsed. Exactly one row
   * sets it, and that is the whole point — see `everywhereShortcut`.
   */
  everywhere?: boolean
}

/**
 * Every key this editor answers, and the Figma command each one comes from.
 *
 * Ordered by group and then by how often a designer reaches for it, because
 * this array IS the shortcuts panel's running order — there is no second list
 * to keep in step with it.
 */
export const SHORTCUTS: readonly Shortcut[] = [
  /* ── Tools: the three answers to "what does a click do" ─────────────────── */
  {
    command: "mode.inspect",
    chord: { key: "v" },
    aliases: [{ key: "a" }],
    label: "Inspect: click to select (again to turn off)",
    figma: "Move tool (V). A also works.",
    group: "Tools",
  },
  {
    command: "mode.notes",
    chord: { key: "c" },
    label: "Notes: click to pin a note (again to turn off)",
    figma: "Add comment (C)",
    group: "Tools",
  },
  {
    command: "mode.interactive",
    chord: { key: "h" },
    label: "Interactive: clicks go to the app",
    figma: "Hand tool (H)",
    group: "Tools",
  },

  /* ── View: what is on screen ────────────────────────────────────────────── */
  /*
   * Figma's "zoom to fit" is the nearest thing it has to this, and it is the
   * same promise: show me everything. From the live page that means opening the
   * board of every page; on the board it means fitting the board, so a second
   * press is never a surprise. Leaving is Escape, the Live button on a frame, or
   * the toolbar toggle — see `src/board/`.
   */
  {
    command: "view.canvas",
    chord: { code: "Digit1", shift: true },
    label: "Canvas view: every page on one board (again to fit)",
    figma: "Zoom to fit (⇧1)",
    group: "View",
  },
  {
    command: "chrome.toggle",
    chord: { key: ".", mod: true },
    label: "Show or hide the editor",
    figma: "Show/hide UI (⌘.)",
    group: "View",
    everywhere: true,
  },
  {
    command: "chrome.hide",
    chord: { key: "\\" },
    label: "Hide the editor (⌘. brings it back)",
    figma: "Show/hide UI (\\)",
    group: "View",
  },
  {
    command: "panel.left.toggle",
    chord: { code: "Backslash", mod: true, shift: true },
    label: "Show or hide the left panel",
    figma: "Show/hide left panel (⇧⌘\\)",
    group: "View",
  },
  /*
   * THE WAY IN, which this keymap did not have.
   *
   * Every other row moves something around once you are already inside the
   * editor. Nothing put a keyboard user INTO it. The chrome is appended to
   * `<body>`, so it is last in tab order behind the whole of the host app — and
   * while anything is selected the canvas takes Tab outright (see `select.next`
   * below), so a keyboard user standing in the app cannot reach the chrome by
   * tabbing at all until they press Escape first. The editor was pointer-first
   * at the one moment it could least afford to be.
   *
   * ⇧⌘1 rather than a bare letter, because this has to keep working while a
   * prototype holds the plain keys — the loan this file's header describes. Not
   * an ⌥ digit either: ⌥1..⌥3 and ⌥8..⌥0 are the panel slots already.
   *
   * Figma has no counterpart to copy, and `figma` says so rather than inventing
   * a lineage. Figma owns its window and is never re-entered from somewhere
   * else; that is exactly the difference between an app and a guest on someone
   * else's page.
   */
  {
    command: "chrome.focus",
    chord: { code: "Digit1", mod: true, shift: true },
    label: "Focus the toolbar",
    figma: "No Figma equivalent",
    group: "View",
  },
  /*
   * The panel tabs are POSITIONAL, and that is the second version of these six
   * rows.
   *
   * They first named the tabs — `panel.left.assets`, `panel.inspector.code` —
   * and a refactor landing the same afternoon moved Code from the right panel
   * to the left and retired Assets. Three keys went quiet and nothing failed,
   * because a command nobody registered is a no-op by design. That is the right
   * behaviour for a lane that is not mounted and the wrong coupling for a tab
   * strip: the panel owns which tabs exist, so it owns the numbering too, and
   * the keymap should only say WHICH SLOT.
   *
   * Figma's own keys are positional in exactly this way — ⌥1/⌥2/⌥3 are the left
   * panel's three views and ⌥8/⌥9/⌥0 the right panel's — so naming the slot is
   * closer to Figma than naming the tab was, as well as sturdier. The sheet
   * fills in the tab's real name when it draws, so the reader still sees
   * "first view (Layers)" rather than a number.
   */
  {
    command: "panel.left.tab1",
    chord: { code: "Digit1", alt: true },
    label: "Left panel: first view",
    figma: "Layers panel (⌥1)",
    group: "View",
  },
  {
    command: "panel.left.tab2",
    chord: { code: "Digit2", alt: true },
    label: "Left panel: second view",
    figma: "Assets panel (⌥2)",
    group: "View",
  },
  {
    command: "panel.left.tab3",
    chord: { code: "Digit3", alt: true },
    label: "Left panel: third view",
    figma: "Libraries (⌥3)",
    group: "View",
  },
  {
    command: "panel.inspector.tab1",
    chord: { code: "Digit8", alt: true },
    label: "Inspector: first view",
    figma: "Design panel (⌥8)",
    group: "View",
  },
  {
    command: "panel.inspector.tab2",
    chord: { code: "Digit9", alt: true },
    label: "Inspector: second view",
    figma: "Prototype panel (⌥9)",
    group: "View",
  },
  {
    command: "panel.inspector.tab3",
    chord: { code: "Digit0", alt: true },
    label: "Inspector: third view",
    figma: "Inspect panel (⌥0)",
    group: "View",
  },
  {
    command: "notes.markers.toggle",
    chord: { key: "c", shift: true },
    label: "Show or hide note pins",
    figma: "Show/hide comments (⇧C)",
    group: "View",
  },

  /* ── Selection ──────────────────────────────────────────────────────────── */
  {
    command: "select.all",
    chord: { key: "a", mod: true },
    label: "Select everything at this level",
    figma: "Select all (⌘A)",
    group: "Selection",
  },
  {
    command: "select.none",
    chord: { key: "escape" },
    label: "Deselect (press again to collapse)",
    figma: "Select none (Esc)",
    group: "Selection",
    owner: "canvas",
  },
  {
    command: "select.child",
    chord: { key: "enter" },
    label: "Select the first child",
    figma: "Select children (Enter)",
    group: "Selection",
    owner: "canvas",
  },
  {
    command: "select.parent",
    chord: { key: "enter", shift: true },
    label: "Select the parent",
    figma: "Select parent (⇧Enter)",
    group: "Selection",
    owner: "canvas",
  },
  /*
   * TAB IS CLAIMED WHILE SOMETHING IS SELECTED, AND THE LABEL SAYS HOW TO GET
   * IT BACK.
   *
   * `canvas/index.ts` calls `preventDefault()` on Tab whenever there is a
   * selection and focus is outside the chrome — which is where focus sits after
   * any canvas click. So Tab moves nothing, including into the app under edit.
   * That is the Figma behavior and it is deliberate, but on its own it is a
   * keyboard trap: WCAG 2.1.2 allows a widget to claim Tab only if the user is
   * ADVISED of the way out, and nothing advised them.
   *
   * Escape is the way out — it clears the selection, and with nothing selected
   * `canvas/index.ts` returns before the `preventDefault()`. The exit already
   * worked; it was undocumented, which under 2.1.2 is the whole of the failure.
   * Saying it on the two rows that claim the key is the cheapest fix that
   * actually satisfies the criterion.
   *
   * The structural fix — giving the canvas a focusable representation so Tab is
   * a widget key rather than a stolen one — is the better answer and is a
   * larger piece of work; it is recorded in the audit rather than done here.
   */
  {
    command: "select.next",
    chord: { key: "tab" },
    label: "Select the next sibling",
    figma: "Select next sibling (Tab)",
    group: "Selection",
    owner: "canvas",
  },
  {
    command: "select.prev",
    chord: { key: "tab", shift: true },
    label: "Select the previous sibling",
    figma: "Select previous sibling (⇧Tab)",
    group: "Selection",
    owner: "canvas",
  },
  {
    command: "select.lock",
    chord: { key: "l", mod: true, shift: true },
    label: "Lock or unlock the selection",
    figma: "Lock/unlock selection (⇧⌘L)",
    group: "Selection",
  },
  {
    command: "select.hide",
    chord: { key: "h", mod: true, shift: true },
    label: "Show or hide the selection",
    figma: "Show/hide selection (⇧⌘H)",
    group: "Selection",
  },
  {
    command: "select.reveal",
    chord: { code: "Digit2", shift: true },
    label: "Scroll the selection into view",
    figma: "Zoom to selection (⇧2)",
    group: "Selection",
  },

  /* ── Arrange: source order, which in a document flow is reading order ───── */
  {
    command: "arrange.front",
    chord: { code: "BracketRight", mod: true, alt: true },
    label: "Move to the front (first child)",
    figma: "Bring to front (⌥⌘])",
    group: "Arrange",
  },
  {
    command: "arrange.forward",
    chord: { code: "BracketRight", mod: true },
    label: "Move one step forward",
    figma: "Bring forward (⌘])",
    group: "Arrange",
  },
  {
    command: "arrange.backward",
    chord: { code: "BracketLeft", mod: true },
    label: "Move one step backward",
    figma: "Send backward (⌘[)",
    group: "Arrange",
  },
  {
    command: "arrange.back",
    chord: { code: "BracketLeft", mod: true, alt: true },
    label: "Move to the back (last child)",
    figma: "Send to back (⌥⌘[)",
    group: "Arrange",
  },

  /* ── Edit ───────────────────────────────────────────────────────────────── */
  {
    command: "history.undo",
    chord: { key: "z", mod: true },
    label: "Undo",
    figma: "Undo (⌘Z)",
    group: "Edit",
  },
  {
    command: "history.redo",
    chord: { key: "z", mod: true, shift: true },
    label: "Redo",
    figma: "Redo (⇧⌘Z)",
    group: "Edit",
  },
  {
    command: "element.delete",
    chord: { key: "backspace" },
    aliases: [{ key: "delete" }],
    label: "Delete the selection",
    figma: "Delete (Delete)",
    group: "Edit",
    owner: "canvas",
  },
  {
    command: "element.nudge",
    chord: { key: "arrowleft" },
    aliases: [{ key: "arrowright" }, { key: "arrowup" }, { key: "arrowdown" }],
    label: "Nudge by 1px. Hold ⇧ for 10px",
    figma: "Nudge / big nudge (arrows, ⇧arrows)",
    group: "Edit",
    owner: "canvas",
  },
  {
    command: "notes.copy",
    chord: { code: "KeyC", mod: true, alt: true },
    label: "Copy notes and edits",
    figma: "Copy properties (⌥⌘C)",
    group: "Edit",
  },

  /* ── Help ───────────────────────────────────────────────────────────────── */
  {
    command: "help.shortcuts",
    chord: { code: "Slash", ctrl: true, shift: true },
    label: "Keyboard shortcuts",
    figma: "Keyboard shortcuts panel (⌃⇧?)",
    group: "Help",
  },
]

/**
 * Gestures worth printing in the panel that are not chords at all.
 *
 * They are in Figma's own shortcut list and they are the ones a designer is
 * most surprised to find working here, so leaving them out of the panel would
 * hide the editor's best trick behind a mouse nobody told them to hold a key
 * with.
 */
export const POINTER_HINTS: ReadonlyArray<{ keys: string; label: string; figma: string }> = [
  { keys: "⌘ click", label: "Select the deepest element under the pointer", figma: "Deep select" },
  { keys: "⌘ drag", label: "Marquee-select deeply", figma: "Deep select with rectangle" },
  { keys: "⇧ click", label: "Add to or remove from the selection", figma: "Add to selection" },
  { keys: "⌥ hover", label: "Measure to the hovered element", figma: "Measure to selection" },
  { keys: "double click", label: "Drill into the element under the pointer", figma: "Enter group" },
]

/**
 * How a key prints, for the one row in the panel that shows it.
 *
 * `code` values are spelled back as the character the key produces UNSHIFTED —
 * `Digit2` is "2", not "@" — because that is how Figma prints them and how a
 * designer reads them: ⇧2 is the instruction "hold shift, press the 2 key".
 * Printing "⇧@" would be describing the same press in a way nobody types.
 */
const KEY_NAMES: Record<string, string> = {
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit8: "8",
  Digit9: "9",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Slash: "/",
  KeyC: "C",
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  // Platform-corrected in `chordLabel`: the Mac key labelled "delete" IS
  // backspace, and its forward-delete is ⌦ and only exists on a full keyboard.
  backspace: "Backspace",
  delete: "Del",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  ".": ".",
  "\\": "\\",
}

/**
 * The chord as a designer would write it down.
 *
 * Apple's own modifier order on the Mac — ⌃ ⌥ ⇧ ⌘ — because that is the order
 * every menu on the machine prints, and a shortcut sheet that reordered them
 * would read as a different product's. Windows gets the spelled-out chain.
 *
 * ⌃⇧/ prints as ⌃⇧? , which is the one place the shifted character IS the name:
 * "the shortcuts key" is `?` in every app that has one, including Figma's own
 * documentation of it.
 */
export function chordLabel(chord: Chord, mac = isMac()): string {
  const source = chord.code ?? chord.key ?? ""
  let name = KEY_NAMES[source] ?? source.toUpperCase()
  if (chord.code === "Slash" && chord.shift) name = "?"
  // A Mac laptop has one delete key and it is backspace, labelled "delete";
  // its forward delete is ⌦ and is not on the keyboard most designers own.
  if (mac && chord.key === "backspace") name = "Delete"
  if (mac && chord.key === "delete") name = "⌦"
  const parts: string[] = []
  if (mac) {
    if (chord.ctrl) parts.push("⌃")
    if (chord.alt) parts.push("⌥")
    if (chord.shift) parts.push("⇧")
    if (chord.mod) parts.push("⌘")
    return parts.join("") + name
  }
  if (chord.ctrl || chord.mod) parts.push("Ctrl")
  if (chord.alt) parts.push("Alt")
  if (chord.shift) parts.push("Shift")
  parts.push(name)
  return parts.join("+")
}

/** Exact. A modifier not asked for is a modifier that must be up. */
function chordMatches(event: KeyboardEvent, chord: Chord): boolean {
  if (chord.code) {
    if (event.code !== chord.code) return false
  } else if (chord.key) {
    if (event.key.toLowerCase() !== chord.key) return false
  } else {
    return false
  }
  const mac = isMac()
  // On Windows `mod` and `ctrl` are the same physical key, so a row asking for
  // either wants Ctrl down; on a Mac they are two keys and must agree exactly.
  const wantMeta = mac ? Boolean(chord.mod) : false
  const wantCtrl = mac ? Boolean(chord.ctrl) : Boolean(chord.mod) || Boolean(chord.ctrl)
  return (
    event.metaKey === wantMeta &&
    event.ctrlKey === wantCtrl &&
    event.shiftKey === Boolean(chord.shift) &&
    event.altKey === Boolean(chord.alt)
  )
}

/**
 * The row this key press is, or null.
 *
 * Linear over ~25 rows on a keystroke, which is nothing, and the alternative —
 * a map keyed by a serialised chord — would have to serialise the event the
 * same way the table was serialised, which is a second matcher to keep honest.
 *
 * First match wins, so the table's order is the tie-break. Nothing in it
 * currently ties; the exact-modifier rule above is what keeps ⌘] and ⌥⌘] apart.
 */
export function matchShortcut(event: KeyboardEvent): Shortcut | null {
  for (const shortcut of SHORTCUTS) {
    if (chordMatches(event, shortcut.chord)) return shortcut
    if (shortcut.aliases?.some((chord) => chordMatches(event, chord))) return shortcut
  }
  return null
}

/**
 * The shortcut to run for this press, with the two gates every row shares.
 *
 * **Text entry is never ours.** A designer typing a class name into the
 * inspector presses `c` for a reason that is not annotation mode, and a `v` in
 * a prototype's search box is a letter. This is the gate that makes bare-letter
 * shortcuts safe to have at all.
 *
 * **A collapsed editor answers nothing here.** When the chrome is down to the
 * floating disc the editor is a guest on someone else's page, and the page may
 * well bind `c` or `v` itself — so every row goes quiet. This is the whole of
 * the "shortcuts only work while the editor is shown" rule, in one place,
 * rather than a `chromeHidden` check copied into every handler.
 *
 * `canvas`-owned rows return null: they are documentation here, and the
 * selection lane answers them on its own terms. So does the `everywhere` row,
 * ⌘., which `shell/way-back.ts` answers through `everywhereShortcut`. Two
 * listeners answering one toggle would run it twice and leave the editor
 * exactly where it was.
 */
export function shortcutFor(event: KeyboardEvent, chromeHidden: boolean): Shortcut | null {
  if (chromeHidden || isTextEntryEvent(event)) return null
  const shortcut = matchShortcut(event)
  if (!shortcut || shortcut.owner === "canvas" || shortcut.everywhere) return null
  return shortcut
}

/**
 * The way back, from anywhere: the `everywhere` row this press is, or null.
 *
 * Neither gate in `shortcutFor` applies to it. Not the collapse, because ⌘. is
 * the only way back from one, and unlike a bare letter a platform accelerator
 * is not something a prototype reasonably claims. Not the text field either:
 * that gate exists because a letter typed into a field is typing, and ⌘. types
 * nothing. It used to apply anyway, and every prototype has a field — a
 * composer that focuses itself on load, a search box, the editor's own layer
 * filter — so the way back went dead whenever one had focus, with nothing on
 * screen to say why.
 *
 * A press made while an input method is composing belongs to the input method,
 * whatever key it is.
 */
export function everywhereShortcut(event: KeyboardEvent): Shortcut | null {
  if (event.isComposing) return null
  const shortcut = matchShortcut(event)
  return shortcut?.everywhere ? shortcut : null
}

/**
 * Undo and redo on the platform's own pair, read off the table above.
 *
 * Cmd+Z and Shift+Cmd+Z on macOS — the system shortcuts, which are also
 * Figma's. Ctrl and Shift+Ctrl elsewhere. Ctrl+Y, Windows' other redo, is
 * deliberately not accepted: the editor runs inside a page, and Ctrl+Y is a
 * browser command there.
 *
 * Kept as a function because the shape "undo" | "redo" | null is what the
 * history lane and its tests speak in; the MATCHING is the table's, so the two
 * cannot drift.
 */
export function historyAction(event: KeyboardEvent): "undo" | "redo" | null {
  const command = matchShortcut(event)?.command
  if (command === "history.undo") return "undo"
  if (command === "history.redo") return "redo"
  return null
}

/**
 * Escape's last meaning: stand the editor down to the disc.
 *
 * Escape is not a chord this table can own, because it is already the canvas's
 * deselect and every overlay's close. It is one key with an ESCALATING meaning
 * — close what is open, then clear what is selected, then collapse — and the
 * order is the whole feature: a key that collapsed the editor while a note
 * editor was up, or while something was selected, would be a key nobody could
 * use to deselect. So this answers only the question "is this press a candidate
 * for the last step", and the caller in `shell/shortcuts.ts` is what makes it
 * last: it listens on the BUBBLE phase, after every capture listener in the
 * editor has had the key, and stands down if any of them took it.
 *
 * Two gates of its own, and they are the same two the table's rows get:
 *
 *   - **A collapsed editor does not answer it.** Escape belongs to the page
 *     once the editor is a disc, exactly like the bare letters — and unlike ⌘.
 *     it is a key a prototype reasonably owns, so there is no `everywhere`
 *     exception here and never should be.
 *   - **Text entry is never ours.** Escape in a field reverts the field, which
 *     is `panels/inspector/field.ts`'s business and not a reason to collapse.
 */
export function isCollapseFallback(event: KeyboardEvent, chromeHidden: boolean): boolean {
  if (chromeHidden) return false
  if (isTextEntryEvent(event)) return false
  return event.key === "Escape"
}

/**
 * Both delete keys, which is what every editor on this platform accepts.
 *
 * Backspace is the one people actually press on a Mac keyboard, where the key
 * labelled "delete" IS backspace and the forward-delete key does not exist on
 * a laptop. It is also the browser's legacy back-navigation shortcut, so the
 * canvas handler has to `preventDefault` — a delete that silently navigated the
 * app away would be a far worse bug than a delete that did nothing.
 *
 * No modifier is accepted. Cmd+Backspace is "delete to start of line" in every
 * text field, and this gate has already let non-text targets through; taking
 * the modifier version too would only add a way to hit this by accident.
 */
function isDeleteKey(event: KeyboardEvent): boolean {
  if (event.key !== "Delete" && event.key !== "Backspace") return false
  return !event.metaKey && !event.ctrlKey && !event.altKey
}

/**
 * Enter selects the child and Shift+Enter the parent. That direction surprises
 * people and is nonetheless what Figma does; Escape only ever deselects.
 */
export function canvasAction(event: KeyboardEvent): CanvasAction | null {
  if (event.key === "Escape") return "deselect"
  if (isDeleteKey(event)) return "delete"
  if (event.key === "Enter") return event.shiftKey ? "select-parent" : "select-child"
  if (event.key === "Tab") return event.shiftKey ? "prev-sibling" : "next-sibling"
  if (event.key in NUDGE) return "nudge"
  return null
}
