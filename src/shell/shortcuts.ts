/**
 * The editor's one keyboard listener, and the panel that documents it.
 *
 * Everything about WHICH key means what lives in `core/keymap.ts`; everything
 * about what a command DOES lives in the lane that owns the surface. This file
 * is the wire between them, and it is deliberately the only wire — before it
 * there were two listeners answering three chords between them, each with its
 * own copy of the guards, which is a shape that does not survive a Figma-sized
 * keymap.
 *
 * ## The one rule that is not Figma's
 *
 * Figma owns the whole window. This editor is a guest on someone else's page,
 * and the page has its own keyboard: a prototype may well bind `c`, or `/`, or
 * the arrows. So bare-letter shortcuts are a loan, and the terms are that the
 * editor gives them back the moment it stands down to the floating disc.
 *
 * That gate is `shortcutFor` in the keymap, not a `chromeHidden` check here,
 * because it has to hold for every row including ones added later — a rule
 * enforced at the dispatch site is a rule the next contributor has to remember.
 * The single exception is ⌘., which is how the editor comes back; a platform
 * accelerator with a period on it is not a key a prototype reasonably claims.
 * It is not answered here at all but in `shell/way-back.ts`, which hears it
 * from text fields and frames this listener rightly ignores.
 *
 * ## Capture, and why the swallow is conditional
 *
 * Registered at capture on `window` for the same reason the canvas lane is: the
 * vendor overlay guards the document and an app may stop the event on its way
 * up. But the event is only cancelled once a command has actually RUN —
 * `runCommand` reports whether anything was registered under the name. A chord
 * whose lane is not mounted has to fall through to the page rather than being
 * eaten by an editor that cannot act on it.
 *
 * ## The one other listener, and why it is not a chord
 *
 * Escape collapses the editor, and it is the LAST thing Escape means: it closes
 * an overlay first, clears the selection second, and only stands the editor
 * down on a press nothing else took. That cannot be a row dispatched from the
 * table — the table is matched at capture, which is the earliest anything sees
 * a key, and this step is defined by being the latest. So it has a listener of
 * its own on the bubble phase at the bottom of `installShortcuts`. The rule it
 * asks is still the keymap's (`isCollapseFallback`); only the timing differs.
 */

import {
  POINTER_HINTS,
  SHORTCUTS,
  chordLabel,
  isCollapseFallback,
  isMac,
  shortcutFor,
  type Shortcut,
  type ShortcutGroup,
} from "../core/keymap"
import { hasCommand, registerCommand, runCommand } from "../core/commands"
import { arrange, arrangeRef, siblingLines } from "../core/arrange"
import { el } from "../core/dom"
import { playExit, smoothScroll } from "../core/motion"
import { getResolver } from "../core/resolve"
import { annotationSettings, markersVisible, updateSettings } from "../annotations/store"
import { createWriter } from "../core/writer"
import { editorMode, type EditorMode } from "../core/store"
import { tokens } from "../core/tokens"
import { icon } from "../core/icons"
import type { EditorContext } from "../core/context"

/**
 * The display an element had before ⇧⌘H hid it.
 *
 * The same bargain `panels/layers.ts` makes with its own eye, and a second map
 * rather than a shared one because the two are different surfaces reaching the
 * same write: `applyStyles` sets, it cannot unset, so showing has to name a
 * value, and `block` for a flex row would quietly restack its children. A
 * session that hides from the tree and shows from the keyboard falls back to
 * `block` — which is the behaviour a single map would also have after a reload,
 * and not worth coupling two panels to avoid.
 */
const restoreDisplay = new WeakMap<Element, string>()

export function installShortcuts(context: EditorContext): void {
  const resolver = getResolver(context.bridge)
  const writer = createWriter(context.bridge)
  const panel = shortcutsPanel()

  /* ── Tools ──────────────────────────────────────────────────────────────── */

  // Straight to `setMode`, never to the two booleans: it is the only path that
  // cannot leave the editor interactive and annotating at once. V (and A) and C
  // are toggles: pressing the key for the mode you are already in drops back to
  // interactive, which is what the toolbar's Inspect and Notes buttons do. H is
  // the "off" state itself, so it only ever sets.
  const toggle = (mode: EditorMode) => () =>
    context.setMode(editorMode() === mode ? "interactive" : mode)
  registerCommand("mode.inspect", toggle("inspecting"))
  registerCommand("mode.notes", toggle("annotating"))
  registerCommand("mode.interactive", () => context.setMode("interactive"))

  /* ── View ───────────────────────────────────────────────────────────────── */

  registerCommand("panel.left.toggle", () =>
    context.setState({ layersOpen: !context.getState().layersOpen })
  )

  /*
   * `panel.left.tab1..3` and `panel.inspector.tab1..3` are NOT registered here.
   *
   * Each panel registers its own, by slot, because each panel owns which tabs
   * it has. This lane knew their names once and three keys went quietly dead
   * the afternoon the tab sets were reshuffled — the id is exactly the fact
   * that is not this module's to hold. See `panels/left.ts` and
   * `panels/inspector/index.ts`.
   */

  // `hideUntilRestart` is the annotation store's own name for "not on screen
  // right now", and `markersVisible()` is the assembled answer every painter
  // asks — so the toggle is written against the reading rather than against the
  // raw flag, which is how the two stay the same question.
  registerCommand("notes.markers.toggle", () => {
    const hidden = !markersVisible()
    // No toast: the pins appearing or leaving is the whole report.
    updateSettings({ ...annotationSettings(), hideUntilRestart: !hidden })
  })

  /* ── Selection ──────────────────────────────────────────────────────────── */

  /**
   * Everything at the level you are standing on, which is Figma's reading of
   * Select all: the current frame's children, not every node in the document.
   *
   * `scope` IS that level — it is the container the user drilled into — and the
   * scope root is `document.body`, the same root `panels/layers.ts` walks from.
   * Using the resolver rather than `children` matters: it is what skips the
   * wrappers the layer graph does not consider layers.
   */
  registerCommand("select.all", () => {
    const container = context.getState().scope ?? document.body
    const children = resolver.layerChildren(container)
    if (children.length) context.selectMany(children)
  })

  /**
   * Lock or unlock, on the whole selection and in one write.
   *
   * Mixed selections lock rather than unlock — if any picked element is
   * unlocked, the press locks everything. That is the reading that makes a
   * repeated press converge instead of oscillating half the set each time.
   *
   * A new Set per toggle, because `setState` compares by identity and a Set
   * edited in place would notify nobody.
   */
  registerCommand("select.lock", () => {
    const state = context.getState()
    if (!state.selection.length) return
    const locked = new Set(state.locked)
    const lock = state.selection.some((entry) => !locked.has(entry.element))
    for (const entry of state.selection) {
      if (lock) locked.add(entry.element)
      else locked.delete(entry.element)
    }
    // No toast: the Layers row's lock glyph says it, where the layer is.
    context.setState({ locked })
  })

  /**
   * The eye, from the keyboard, through the writer every other panel writes
   * through — so it previews now, lands as a real change at "Apply to code",
   * and ⌘Z undoes it like anything else.
   *
   * One `applyStyles` per element rather than a batch, which is a real cost:
   * hiding six elements is six undo steps. It is the honest one available here
   * — the batched path is `StyleBatchEdit`, whose vocabulary is one property
   * across a selection, and each element needs a DIFFERENT value on the way
   * back (its own remembered display). Six steps that each undo correctly beats
   * one step that restores every row to `block`.
   */
  registerCommand("select.hide", () => {
    const selection = context.getState().selection
    if (!selection.length) return
    for (const entry of selection) {
      const shown = getComputedStyle(entry.element).display
      const hidden = shown === "none"
      if (!hidden) restoreDisplay.set(entry.element, shown)
      const value = hidden ? restoreDisplay.get(entry.element) ?? "block" : "none"
      writer.applyStyles(entry, [{ property: "display", value }], hidden ? "Show" : "Hide")
    }
    // No toast: the element leaving the canvas is the report.
    context.refresh()
  })

  /**
   * Figma's Zoom to selection, in a tool with no zoom.
   *
   * There is no canvas transform to drive — the editor's surfaces sit over a
   * live, scrolling page — so the honest translation of "put the thing you
   * picked in front of me" is a scroll. `center` on both axes rather than
   * `nearest`, because the point of the key is to find something you have lost
   * track of, and `nearest` leaves it hard against whichever edge it came in
   * from.
   */
  registerCommand("select.reveal", () => {
    const primary = context.primarySelection()
    /*
     * The one smooth scroll in the editor, and the one motion no stylesheet can
     * reach: `behavior` is an argument, not a property, so the reduced-motion
     * blanket in `css/base.ts` cannot clamp it. Asked here instead.
     *
     * `auto` rather than dropping the call — the element still has to come into
     * view, and a reader who has asked for less motion has asked for less
     * travel, not for a command that quietly does nothing.
     *
     */
    primary?.element.scrollIntoView?.({
      block: "center",
      inline: "center",
      behavior: smoothScroll(),
    })
  })

  /* ── Arrange ────────────────────────────────────────────────────────────── */

  /**
   * Source order, and it may take a round trip to learn what that order is.
   *
   * `siblingLines` answers from a memo when it has one and otherwise asks the
   * server, returning null and calling back when the reply lands. The inspector
   * copes by re-rendering; a key press has no render to wait for, so it asks
   * again inside the callback — the second call is guaranteed to hit the memo
   * the first one just filled — and performs the move there.
   *
   * The callback is not a retry loop. One round trip or nothing: a key that
   * kept asking would queue a move per press while the answer was in flight.
   */
  const move = (direction: "front" | "forward" | "backward" | "back") => () => {
    const primary = context.primarySelection()
    if (!primary) return
    const ref = arrangeRef(context.bridge, primary.element)
    if (!ref) return
    const lines = siblingLines(context.bridge, ref, () => {
      arrange(context.bridge, ref, siblingLines(context.bridge, ref, () => {}), direction)
    })
    if (lines) arrange(context.bridge, ref, lines, direction)
  }
  registerCommand("arrange.front", move("front"))
  registerCommand("arrange.forward", move("forward"))
  registerCommand("arrange.backward", move("backward"))
  registerCommand("arrange.back", move("back"))

  /* ── Help ───────────────────────────────────────────────────────────────── */

  registerCommand("help.shortcuts", () => panel.toggle())

  /* ── The listener ───────────────────────────────────────────────────────── */

  window.addEventListener(
    "keydown",
    (event) => {
      /*
       * Escape closes the sheet before anything else looks at it.
       *
       * Ahead of `shortcutFor` because Escape is the canvas's deselect and this
       * is a modal over it: a sheet that stayed open while the key it swallowed
       * cleared the selection behind it would be two things happening for one
       * press. Nothing else in the editor can be reached while it is up.
       */
      if (panel.isOpen() && event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        panel.close()
        return
      }
      const shortcut = shortcutFor(event, context.getState().chromeHidden)
      if (!shortcut) return
      // Only once something answered. See the header: an unregistered command
      // means the lane is not mounted, and the page should get its key back.
      if (!runCommand(shortcut.command)) return
      event.preventDefault()
      event.stopPropagation()
    },
    true
  )

  /*
   * Escape, once nothing else wants it, collapses the editor.
   *
   * The second listener in a file whose header says there is one, and the
   * exception is the point: this is not dispatching a chord from the table, it
   * is answering a key AFTER the table has. Escape is the canvas's deselect,
   * every overlay's close and the note editor's cancel, and it is also the key
   * a designer presses to get the editor out of the way. Those four only
   * coexist as an escalation — close, then deselect, then collapse — and an
   * escalation needs a step that runs last.
   *
   * **Bubble phase on `window` is what "last" means here.** Every other
   * keyboard listener in the editor is registered at capture on `window`, which
   * for a key pressed at a focused element runs before the event has reached a
   * single other node; the bubble phase on `window` is the final hop of the
   * same dispatch. So this sees the press after the sheet, the layer menu, the
   * token picker, the app chooser, the insert drag and the canvas lane have all
   * had it — whichever of them happen to be mounted, and without this file
   * holding a list of them. A capture listener here would need exactly that
   * list, and would be wrong the first time somebody added a seventh surface.
   *
   * **`defaultPrevented` is the handshake.** Two things can happen upstream: a
   * modal surface stops propagation and the event never arrives here at all, or
   * a lane consumes the key in place — the canvas clearing a selection — and
   * marks it. Either way the press was spent and the editor stays up. Nothing
   * new is asked of those lanes beyond cancelling the event they answered,
   * which is what a handler that acted should do anyway.
   *
   * Through `chrome.hide` rather than `setChromeHidden`, so this, the `\` key
   * and the toolbar's own switch cannot come to mean three different things.
   */
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return
    if (!isCollapseFallback(event, context.getState().chromeHidden)) return
    if (!runCommand("chrome.hide")) return
    event.preventDefault()
  })
}

/* ═════════════════════════════ the sheet ══════════════════════════════════ */

interface ShortcutsPanel {
  toggle(): void
  close(): void
  isOpen(): boolean
}

const GROUPS: ShortcutGroup[] = ["Tools", "View", "Selection", "Arrange", "Edit", "Help"]

/**
 * The shortcuts sheet, built once and shown or hidden thereafter.
 *
 * It is generated FROM `SHORTCUTS`, which is the only reason it is worth having
 * at all: a hand-written cheat sheet is a second list, and a second list is a
 * list that is wrong by the third commit. Each row prints what the key does
 * here and, quieter beside it, the Figma command it comes from — so a designer
 * can check their muscle memory against the lineage rather than against our
 * paraphrase of it.
 *
 * Centred rather than Figma's bottom strip. Figma's sits along the bottom
 * because you are meant to keep working while it is up and watch it light rows
 * as you use them; this one is a reference you open, read and close, and a
 * 900px card in the middle of the screen is how every other product prints one.
 */
function shortcutsPanel(): ShortcutsPanel {
  // `HTMLDialogElement`, so `showModal`/`close` are reachable without a cast.
  // The card IS the root now — the scrim it used to be wrapped in is gone, and
  // `::backdrop` is not a node this code has to own.
  let root: HTMLDialogElement | null = null
  let returnFocus: Element | null = null

  const row = (keys: string, label: string, lineage: string) =>
    el("div", { class: "de-shortcut-row" }, [
      el("div", { class: "de-shortcut-keys" }, [el("kbd", { class: "de-kbd" }, [keys])]),
      el("div", { class: "de-shortcut-text" }, [
        el("span", { class: "de-shortcut-label" }, [label]),
        el("span", { class: "de-shortcut-figma" }, [lineage]),
      ]),
    ])

  const keysFor = (shortcut: Shortcut): string =>
    [shortcut.chord, ...(shortcut.aliases ?? [])].map((chord) => chordLabel(chord)).join("  ")

  /**
   * "Left panel: second view" is honest and unhelpful, so the sheet says which
   * view that currently IS.
   *
   * The tab rows are positional on purpose — see `core/keymap.ts` — which means
   * the name cannot live in the table without going stale the next time a panel
   * gains or loses a tab. It is read off the live strip instead, at the moment
   * the sheet is drawn, so it is right by construction.
   *
   * Both strips are `.de-tabs` / `role="tab"` and their ids are prefixed per
   * panel, which is a contract `panels/left.ts` states in its own header. A
   * panel that is not mounted contributes nothing and the row keeps the plain
   * label, which is the correct thing to print when there is no tab to name.
   */
  /**
   * A key with nothing behind it is left OUT of the sheet.
   *
   * The table is the set of keys this editor can have; what it actually has
   * depends on which lanes are mounted and, for the positional tab rows, on how
   * many tabs a panel currently holds. A two-tab left panel leaves ⌥3
   * unregistered — the key correctly falls through to the page — and printing
   * "Left panel: third view" beside it would be advertising a key that does
   * nothing, which is the one thing a shortcut sheet must never do.
   *
   * `canvas` rows are always kept: they are answered by the selection lane
   * directly rather than through the registry, so there is no registration to
   * look for and their absence would mean Tab and Enter vanished from the list.
   */
  const live = (shortcut: Shortcut): boolean =>
    shortcut.owner === "canvas" || hasCommand(shortcut.command)

  const named = (shortcut: Shortcut): string => {
    const slot = /^panel\.(left|inspector)\.tab(\d)$/.exec(shortcut.command)
    if (!slot) return shortcut.label
    const prefix = slot[1] === "left" ? "de-left-tab-" : "de-tab-"
    const tabs = [...document.querySelectorAll<HTMLElement>('.de-tabs [role="tab"]')].filter(
      (tab) => tab.id.startsWith(prefix)
    )
    const tab = tabs[Number(slot[2]) - 1]
    return tab ? `${shortcut.label.split(":")[0]}: ${tab.textContent?.trim()}` : shortcut.label
  }

  const build = (): HTMLDialogElement => {
    const groups = GROUPS.map((group) => {
      const rows = SHORTCUTS.filter(
        (shortcut) => shortcut.group === group && live(shortcut)
      ).map((shortcut) => row(keysFor(shortcut), named(shortcut), shortcut.figma))
      return el("section", { class: "de-shortcut-group" }, [
        el("h3", { class: "de-shortcut-heading" }, [group]),
        ...rows,
      ])
    })

    const pointer = el("section", { class: "de-shortcut-group" }, [
      el("h3", { class: "de-shortcut-heading" }, ["Pointer"]),
      ...POINTER_HINTS.map((hint) => row(hint.keys, hint.label, hint.figma)),
    ])

    const close = el(
      "button",
      { class: "de-shortcut-close", type: "button", "aria-label": "Close keyboard shortcuts" },
      [icon("X", tokens.icon.action)]
    )
    close.addEventListener("click", () => hide())

    const card = el(
      /*
       * A REAL `<dialog>`, and this change is a deletion rather than an
       * addition.
       *
       * It was a `<div role="dialog" aria-modal="true" tabindex="-1">` inside a
       * scrim div, and those two attributes were a claim the code did not keep:
       * nothing trapped focus and nothing was made inert, so Tab from the close
       * button walked straight out into the app behind a scrim that had just
       * dimmed it — the focus ring landing on a control the reader cannot see,
       * while `aria-modal="true"` had already told a screen reader the rest of
       * the document was unavailable. A dialog that claims modality without
       * enforcing it is worse than one that claims nothing, and this is the
       * HELP surface: the one a keyboard user reaches when already lost.
       *
       * `showModal()` supplies all of it — the focus trap, the top layer, the
       * inertness, `::backdrop`, and Escape. So `role`, `aria-modal`,
       * `tabindex`, the scrim element and its click handler all go, and what is
       * left is a platform element doing its own job. `aria-label` stays,
       * because a dialog still needs a name.
       *
       * Built fresh on every open, so the entrance needs no re-arming: a node
       * that has just been appended runs its animation once, which is exactly
       * the number of times this sheet appears.
       */
      "dialog",
      {
        class: "de-shortcuts de-arrive",
        "aria-label": "Keyboard shortcuts",
      },
      [
        el("header", { class: "de-shortcut-head" }, [
          el("h2", { class: "de-shortcut-title" }, ["Keyboard shortcuts"]),
          el("p", { class: "de-shortcut-note" }, [
            // The whole contract in one sentence, where the person who is about
            // to press a key will read it.
            `Figma’s keys. When the editor is collapsed, keys go to your page, except ${isMac() ? "⌘." : "Ctrl+."}, which brings it back. Esc closes, then deselects, then collapses.`,
          ]),
          close,
        ]),
        el("div", { class: "de-shortcut-body" }, [...groups, pointer]),
      ]
    )

    /*
     * A press on the backdrop closes, a press inside does not.
     *
     * `::backdrop` is not an element, so it cannot carry a listener of its own
     * and the old `event.target === scrim` test has nothing to compare against
     * — a click on the backdrop is reported with the DIALOG as its target. The
     * geometry is what distinguishes them: the dialog's own box is the card, so
     * a pointer outside that rectangle landed on the backdrop.
     *
     * `getBoundingClientRect` rather than `contains(event.target)` because the
     * card is one element with padding, not a tree with a gap in it, and a
     * press in that padding is a press in the dialog.
     */
    card.addEventListener("click", (event) => {
      const box = card.getBoundingClientRect()
      const outside =
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      // A keyboard-activated close reports 0,0 and must not be read as a press
      // in the corner of the screen — `detail` is 0 for those.
      if (outside && event.detail > 0) hide()
    })
    /*
     * Escape reaches this dialog before any listener in the editor does, and
     * the platform's answer is to close it — which is the right outcome and the
     * wrong route: `hide()` owns removing the node and restoring focus, and a
     * native close would leave a detached open dialog and `root` still set.
     * Cancelling the default and running our own path keeps one way out.
     */
    card.addEventListener("cancel", (event) => {
      event.preventDefault()
      hide()
    })
    return card
  }

  const show = (): void => {
    if (root) return
    returnFocus = document.activeElement
    const card = build()
    root = card
    document.body.append(card)
    /*
     * `showModal`, not `show` and not `append` alone. It is what puts the card
     * in the top layer — above every z-index in the document, including the
     * 2147483000s this chrome and the vendor overlay trade in — and it is what
     * makes everything behind it inert.
     *
     * Guarded because JSDOM implements `<dialog>` without it. Falling back to
     * the `open` attribute keeps the suites able to build and query the sheet:
     * they assert the markup, and modality is a browser behaviour there is
     * nothing to assert against in a DOM with no layout.
     */
    if (typeof card.showModal === "function") card.showModal()
    else card.setAttribute("open", "")
    // The card takes focus itself rather than handing it to the first control:
    // this is a document to read, and landing on Close would be an answer to a
    // question nobody asked. `showModal` already does this when nothing inside
    // is autofocused, so the call only matters on the JSDOM path.
    card.focus()
  }

  const hide = (): void => {
    if (!root) return
    /*
     * A dismissal is complete at the instant it is asked for. A modal still
     * open for the length of a fade keeps its backdrop over the whole page,
     * keeps taking clicks and stays the front-most thing a second Escape would
     * reach. So the dialog closes now, and the kit's modal exit (to 0.98 over
     * 150ms) plays on an inert copy outside the top layer, with no backdrop.
     *
     * `close()` before `remove()`, and both. Removing an open modal leaves the
     * document's top-layer bookkeeping holding a node that is no longer in it,
     * which in some engines leaves the page inert with nothing on screen to
     * explain why.
     */
    playExit(root, "modal")
    if (typeof root.close === "function" && root.open) root.close()
    root.remove()
    root = null
    // Back where it came from, which is the only way a key-driven dialog can be
    // opened twice from the keyboard without a mouse in between.
    if (returnFocus instanceof HTMLElement) returnFocus.focus()
    returnFocus = null
  }

  return {
    toggle: () => (root ? hide() : show()),
    close: hide,
    isOpen: () => Boolean(root),
  }
}
