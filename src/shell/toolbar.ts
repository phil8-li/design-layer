/**
 * Floating bottom toolbar: one row of icons, read left to right.
 *
 * Every control in it is a glyph with a hover tip now, including the two that
 * used to carry words. The mode switch was the last holdout and the argument
 * for its label was a good one — no 16px drawing says "the editor is not
 * intercepting your clicks" — but the bar it was written for had three
 * controls in it. At nine, one wide pill among eight squares is not emphasis,
 * it is a ragged row: the squares no longer line up into clusters, and the
 * cluster is the thing that makes nine controls findable at all. The word did
 * not disappear, it moved into the tip and into the accessible name, which is
 * where every other control in this strip has always kept its.
 *
 * It used to carry a zoom stepper, a measurement reminder and an overflow menu
 * inventorying every Figma tool this editor does not have. All three answered
 * questions nobody asked at the bottom of the screen — the zoom scaled a
 * transformed ancestor the product's own `layoutId` morphs cannot survive, the
 * measure button was a label for a modifier that works whether or not you press
 * it, and the inventory was a changelog wearing a menu. What is left is the set
 * of things a click here actually does.
 *
 * Two more went the same way, and for the same reason.
 *
 *  - The Hand tool. It suppressed selection so the page could be scrolled, but
 *    the wheel and the trackpad scroll the live page in EVERY mode, so all it
 *    added was a state in which clicking did nothing — the exact thing the mode
 *    switch below now says in a word.
 *  - The Move tool, as a separate button. With Hand gone it was a one-member
 *    radio group: a control whose pressed state could never change. The arrow it
 *    drew was the useful part, so the arrow moved INTO the mode switch, where it
 *    finally means something, because there the pointer really does change hands.
 *
 * The two panel toggles STAY here, and this is the one place they live — a
 * disclosure with two homes is a disclosure with two answers. Each draws ONE
 * mark, and the mark is now the PANEL rather than what the panel holds: a
 * framed box with its left column inked, and the same box mirrored. Naming the
 * contents (a layer stack, a slider rack) made two unrelated drawings that had
 * to be learned as a pair, and dated as soon as either panel grew a second tab.
 * Left and right are read rather than remembered.
 *
 * They are also the two controls in the bar that report ON without the accent
 * chip. The glyph fills, and that is all — see `quiet` on `panelToggle`.
 *
 * Every glyph in the strip is drawn at ONE size, `GLYPH`, and inks the same
 * share of its grid (see `inkViewBox` in `core/icons.ts`). Two glyphs at the
 * same nominal size still read a step apart when one of them fills more of its
 * box, so the size alone was never the whole of "consistent".
 *
 * "Copy notes and edits" has left this bar for the second time, and this time
 * without a square. It came back once because the panel that holds the same
 * Copy can be CLOSED, and handing the work over from the only place it was
 * drawn meant first reopening 260px you had shut on purpose. That argument
 * expired with the change below it: Notes and Inspect now raise the right panel
 * on the tab that answers them, so the list is up by the time there is anything
 * in it worth copying. What is left is the chord — `notes.copy` runs
 * `copyBrief` directly, and a keydown is as much a user gesture as a click, so
 * the clipboard still opens for it.
 *
 * One thing LEFT this bar, and it was never a tool: the way back to the
 * chooser. It names the app the whole editor is pointed at, and that is a
 * statement about what you are looking at rather than a thing you do to this
 * page — while everything else in this strip is a verb about the current
 * selection. A control answering "which app is this?" belongs above the panel
 * that lists what is IN that app, not among the verbs, so it now lives at the
 * top of the left panel, where the name it shows reads as the heading for the
 * tree underneath it instead of as the one word in a row of glyphs.
 *
 * The remaining tool state is still mirrored into the vendor engine so its
 * selection mode stays in sync with ours — two sources of truth for "what does a
 * click do" is the fastest way to make a direct-manipulation tool feel broken.
 *
 * Read left to right the row is: what a click does (the pointer, and notes) —
 * what to do with what you did (step back, step forward) — and what the editor
 * is showing you (how the chrome is painted, the left panel, the right panel,
 * and then the whole editor away).
 *
 * The two mode controls also REACH the right panel, which is the one place this
 * bar's clusters touch. Inspect raises Design, Notes raises Changes; each mode
 * has exactly one tab that is the rest of it, and the pairing is enforced in
 * `setMode` (`core/context.ts`) rather than here, so the keymap cannot arrive
 * at a different panel than the buttons do.
 *
 * The pill also MOVES. It is a floating surface over someone else's product,
 * and the product does not know it is coming: parked at the bottom centre it
 * covers a tab bar on one app and a cookie banner on the next, and the only
 * remedy was to hide the whole editor. It is draggable by its ground now, the
 * way Agentation's is, and it remembers where it was put. The disc remembers
 * its own corner separately — `shell/launcher.ts` owns the gesture both use,
 * and nothing else about either of them.
 */

import { onAngularQueueChange } from "../core/angular"
import { copyHandover } from "../annotations/handover"
import { onAnnotationsChange } from "../annotations/store"
import { onEditsChange } from "../annotations/journal"
import { onPreviewOnlyChange } from "../core/change-prompt"
import { editorMode } from "../core/store"
import { el } from "../core/dom"
import { focusControl } from "../core/focus"
import { canRedo, canUndo, onHistoryChange, redo, undo } from "../core/history"
import { icon, type IconName, type IconWeight } from "../core/icons"
import { swapMark, type SwapMark } from "../core/swap-mark"
import { chordLabel, SHORTCUTS } from "../core/keymap"
import { registerCommand, runCommand } from "../core/commands"
import { onRemovalQueueChange } from "../core/removal"
import { tokens, type ThemeName } from "../core/tokens"
import type { EditorContext } from "../core/context"
import { installDrag } from "./launcher"
import { onInsetsChange } from "./shell"

/**
 * The one size every glyph in this strip is drawn at.
 *
 * The mode switch used to draw its arrow at 14 while everything else drew at
 * 16, on the theory that a glyph beside a word should sit back. Beside a row of
 * 16s it does not read as deferential, it reads as a different icon set. The
 * ramp in `tokens.icon` owns that number now, and `IconSize` turns the 14 this
 * once was into a compile error rather than something to catch in review.
 */
const GLYPH = tokens.icon.action

/**
 * How far the pointer travels on the pill's ground before it is a drag.
 *
 * Ten, which is the disc's figure and Agentation's, where this used to be four.
 * The old four had a real argument behind it — this ground has no press to
 * steal, so the threshold only had to beat a tremor, and every pixel above
 * that is slop between the pointer and an object meant to be stuck to it.
 *
 * What that argument missed is the hand. The bar and the disc are separate
 * objects, but they are moved by the same gesture and a hand does not steady
 * itself differently for a 600px pill than for a 44px disc — so a threshold
 * written twice is a number that drifts for no reason anybody could point at.
 * Six pixels of extra travel is not a cost a hand can feel.
 *
 * (`canvas/marquee.ts` still uses three, and should: a marquee is not this
 * object, and its press has a selection to protect rather than a position.)
 */
const DRAG_SLACK = 10

/**
 * Everything in the bar that is a control rather than ground.
 *
 * A press that lands on any of these is that control's press and never a drag.
 * The bar holds nothing but buttons now that its one anchor has gone to the
 * left panel; the anchor and the field types are named anyway, because the
 * failure if one is ever added and missed here is silent — a text field you
 * cannot put a caret in, because dragging its own text moved the toolbar
 * instead.
 */
const CONTROLS = "button, a, input, select, textarea"

/**
 * Draw a control's glyph, and only when the weight it draws has changed.
 *
 * Every toggle in this bar changes its mark when it flips, because ON is a FILL
 * here rather than a heavier stroke — and a fill is a different `<svg>` rather
 * than a different value on the one already mounted.
 *
 * ## Both drawings are mounted, and the flip is a crossfade
 *
 * This used to be `replaceChildren`, and a replacement cannot be animated: the
 * new node has no previous state, so it paints at its final appearance and the
 * change is a cut. `core/swap-mark.ts` holds the general form of the fix —
 * stack the two glyphs in one sized box and crossfade — and this takes the
 * TOGGLE variant of it, which keeps `currentColor` instead of going green,
 * because the accent surface under a pressed tool has already said which state
 * it is in and a second, greener claim would contradict it.
 *
 * ## Why the guard outlived the rewrite
 *
 * `syncPressed` runs on selection, on history and on every queue change, and
 * the weight is unchanged in nearly all of them. Under the old build an
 * unconditional call tore the node out from under the pointer — dropping hover
 * until it moved — and restarted the stroke transition in `css/icons.ts`, so a
 * glyph flickered while a selection was being dragged around. Under this one a
 * redundant call would only be a redundant `classList.toggle`, but the guard
 * stays: it is also what keeps a repaint that changed nothing from re-running
 * the crossfade.
 *
 * The pair is built on first use and cached against the element, so it cannot
 * outlive the button it belongs to; a control whose glyph NAME changes gets a
 * fresh pair rather than a stale one.
 */
const glyphMarks = new WeakMap<HTMLElement, { name: IconName; mark: SwapMark }>()

function drawGlyph(button: HTMLElement, name: IconName, weight: IconWeight): void {
  if (button.dataset.deWeight === weight) return
  button.dataset.deWeight = weight
  let entry = glyphMarks.get(button)
  if (!entry || entry.name !== name) {
    entry = {
      name,
      mark: swapMark(name, {
        size: GLYPH,
        done: name,
        restWeight: "outline",
        doneWeight: "filled",
        tint: "inherit",
      }),
    }
    glyphMarks.set(button, entry)
    button.replaceChildren(entry.mark.node)
  }
  entry.mark.show(weight === "filled")
}

/**
 * Hover text for an icon-only control, plus the label everyone else reads.
 *
 * `data-de-tip` rather than `title`: the native tooltip waits about a second
 * and then paints in the OS's own chrome, which next to this strip reads as the
 * page having glitched rather than as an answer. The CSS in `css/toolbar.ts`
 * draws it above the strip. The `aria-label` is not a duplicate of it — a
 * pseudo-element is not an accessible name, so a tooltip on its own leaves the
 * control unnamed.
 *
 * `second` is whatever the name cannot say on its own: the shortcut for the
 * controls that have one, and for the mode switch the consequence of pressing
 * it. It is one parameter rather than two because the tip has one shape, and a
 * second overload would be how the separator ends up spelled two ways.
 */
function tip(label: string, second?: string): Record<string, string> {
  return { "data-de-tip": second ? `${label} · ${second}` : label, "aria-label": label }
}

/**
 * The key a control answers to, spelled the platform's way, read off the one
 * table in `core/keymap.ts`.
 *
 * The tips used to write their own — `isMac() ? "⌘Z" : "Ctrl+Z"`, twice — which
 * is exactly how a tooltip comes to advertise a shortcut the keymap no longer
 * binds. Asking the table means a control with no key shows no key, and a key
 * that moves moves in the tip on the same commit.
 */
function keyFor(command: string): string | undefined {
  const shortcut = SHORTCUTS.find((entry) => entry.command === command)
  return shortcut && chordLabel(shortcut.chord)
}

/**
 * The mode switch's second line: its key, then what pressing it leads to.
 *
 * The key leads because the sentence after it is long, and a tip is read left
 * to right until it stops being useful — "V" is the part a designer is looking
 * for the second time they hover. `tip` joins on one separator, so the two are
 * composed here rather than by teaching it a third slot nothing else wants.
 */
function modeDetail(detail: string): string {
  const key = keyFor("mode.inspect")
  return key ? `${key} · ${detail}` : detail
}

/**
 * The two halves of the mode, spelled out.
 *
 * The switch used to be labelled "Interactive" in both states and told apart
 * only by a pressed treatment, which meant the label was a promise in one state
 * and a lie in the other — you had to look at the ring to learn whether the
 * editor was still holding your clicks. So each half names the state you are
 * STANDING IN, and carries a second sentence for what pressing would do; those
 * were being asked to share one string.
 *
 * Both now reach the user through the tip and the accessible name rather than
 * through a word on the button. `label` is still the state and `detail` still
 * the consequence — losing the pill did not merge them, which is the failure
 * that would actually cost something.
 *
 * The glyph is the same arrow in both states — filled while the editor holds
 * the pointer, hollow once it has handed it over. Weight, not colour: this pair
 * is read in the corner of the eye at `GLYPH`, and a mode told apart by hue
 * alone is not told apart at all. It is also the same arrow the floating
 * launcher wears, because it is the same claim about who owns the pointer.
 */
/**
 * The pointer mode, in the two states this one control can show.
 *
 * `label` names what the control IS, and pressed means the mode is live. That
 * is the flip: it used to wear the name of the current state while its
 * `aria-pressed` tracked `interactive`, so the arrow filled at the exact moment
 * the editor handed the pointer away — a lit control announcing its own feature
 * was off.
 *
 * Interactive has no button of its own. It is what you get when neither Inspect
 * nor Notes is on; a third control would offer two ways into one state and a
 * fourth combination to get stuck in.
 */
const MODES = {
  inspecting: {
    label: "Inspect",
    weight: "filled",
    detail: "Click an element to select it",
  },
  interactive: {
    label: "Inspect",
    weight: "outline",
    detail: "Off. Clicks go to the app",
  },
} as const satisfies Record<string, { label: string; weight: IconWeight; detail: string }>

/**
 * The chrome's own paint, in the two states this one control can show.
 *
 * Shaped like `MODES` above, and for the same reason: one stable name, because
 * this is one thing that is on or off rather than two controls sharing a
 * square, and `aria-pressed` carries which. A name that rewrote itself under
 * the pointer would announce two different controls in the same place.
 *
 * The name is "Light mode" in both states — the thing the button OFFERS —
 * rather than "Theme", which names a category and tells you nothing about what
 * pressing does. `detail` is the half that moves, and it says the state you are
 * standing in exactly as the mode switch's does.
 */
/**
 * An ACTION, not a toggle, and the glyph is the whole of it.
 *
 * It wore `aria-pressed` and the pressed fill every other control in this bar
 * wears, which asked the reader to decode two things at once: a sun that means
 * "light is available" sitting in a lit chip that means "something is on". The
 * chip was answering a question nobody had — the chrome's colour is the most
 * visible state on the screen, so a control reporting it is restating what the
 * whole editor already says.
 *
 * So: no pressed state, and the name says what pressing DOES rather than where
 * you are. A button whose label is the outcome needs no state of its own.
 */
const THEMES = {
  dark: { label: "Switch to light mode", glyph: "Sun" },
  light: { label: "Switch to dark mode", glyph: "Moon" },
} as const satisfies Record<ThemeName, { label: string; glyph: IconName }>

/**
 * Where the choice is kept, and it IS kept — unlike the bar's drag position.
 *
 * `shell/launcher.ts` argues its position out of storage on the grounds that a
 * 600px pill reappearing mid-page reads as a broken layout rather than as a
 * preference. A theme is the opposite case: it is a preference in the plainest
 * sense, there is nothing surprising about the editor looking the way you left
 * it, and a designer who picked light and found dark again tomorrow would have
 * to re-pick it every single morning.
 */
const THEME_KEY = "designlayer:theme"

/**
 * The stored choice, or null when there is not one that can be trusted.
 *
 * Every read is wrapped, because `localStorage` does not return null when an
 * origin's storage is blocked — Safari with cross-site tracking prevention,
 * Chrome with third-party cookies off and this overlay served from the proxy,
 * or any browser in a hardened profile — it THROWS on property access. This
 * runs during `installToolbar`, before the bar is appended, so an unguarded
 * read there does not cost a theme, it costs the whole editor.
 */
function storedTheme(): ThemeName | null {
  try {
    const raw = window.localStorage.getItem(THEME_KEY)
    return raw === "light" || raw === "dark" ? raw : null
  } catch {
    return null
  }
}

function rememberTheme(theme: ThemeName): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Same bargain the launcher's saved corner makes: the toggle still worked,
    // it just will not outlive the tab.
  }
}

/**
 * Write the theme where the palette can see it — in two places, on purpose.
 *
 * `css/base.ts` declares the custom properties on `:root` and keys the light
 * block off `data-de-theme`, so `<html>` is what actually switches the chrome:
 * it is the only ancestor shared by the four roots the editor mounts on
 * `<body>`, and a popover parked outside the editor root would otherwise stay
 * dark on a light page. The editor root carries the same attribute so the
 * scoped selector beside it is real rather than decoration.
 *
 * Re-queried rather than captured at install: `mountShell` runs first so the
 * root is already there, but a lane that cannot find it must still theme the
 * document rather than throw on a null.
 */
function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute("data-de-theme", theme)
  document.querySelector(".de-root")?.setAttribute("data-de-theme", theme)
}

/*
 * Re-exported, not redefined.
 *
 * The commit moved to `core/apply.ts` so the Changes tab could reach it, and
 * this went with it — it is a consequence of an Angular refusal, which only the
 * commit can observe. The name stays reachable here because it was part of this
 * module's surface before the move, and a re-export costs a line where chasing
 * the new path costs every caller a change.
 */
export { recordRefusedWrite } from "../core/apply"

export function installToolbar(context: EditorContext): void {
  const { slots, bridge } = context

  /*
   * One tool, mirrored once.
   *
   * The vendor engine has its own idea of the active tool and the canvas reads
   * ours, so the two have to agree; with the tool cluster gone there is no
   * moment at which they could diverge, which makes this an install-time
   * statement rather than a per-click sync.
   */
  try {
    bridge.store.setActiveTool("select")
  } catch {
    // Vendor tool set is version-pinned; a missing mode is not fatal.
  }

  /**
   * The one control that changes what a click means everywhere, and it sits at
   * the far LEFT, first in the strip, because it is the question every other
   * control's answer depends on.
   *
   * `de-button--mode` on a `de-tool` looks like a mistake and is not: the class
   * is the name two other lanes address this control by, and the square is what
   * it is drawn as now. Renaming it would be a rename in files this change does
   * not own, for no gain a reader of the bar can see.
   */
  const interactiveButton = el(
    "button",
    {
      class: "de-tool de-button--mode",
      type: "button",
      "aria-pressed": "true",
      ...tip(MODES.inspecting.label, modeDetail(MODES.inspecting.detail)),
      /*
       * Pressing an ON mode turns it OFF, and off means interactive.
       *
       * That is the whole three-mode rule stated once: Inspect and Notes are
       * the two things the editor can be doing with a click, and interactive is
       * the absence of both. Writing `setMode` rather than flipping a boolean
       * is what stops the fourth, undescribable state where the editor has
       * handed the pointer away and is still intercepting clicks to pin notes.
       */
      onclick: () => context.setMode(editorMode() === "inspecting" ? "interactive" : "inspecting"),
    },
    [icon("Cursor", GLYPH, MODES.inspecting.weight)]
  )

  /** Name, tip and glyph are one fact about the mode, so one function writes them. */
  const paintMode = (): void => {
    const inspecting = editorMode() === "inspecting"
    const mode = inspecting ? MODES.inspecting : MODES.interactive
    interactiveButton.setAttribute("aria-pressed", String(inspecting))
    // Through `tip` rather than two `setAttribute` calls with the separator
    // written out again here: the name and the hover text are built the same
    // way for every other control in the bar, and this is the only one that
    // rebuilds them after install.
    for (const [name, value] of Object.entries(tip(mode.label, modeDetail(mode.detail)))) {
      interactiveButton.setAttribute(name, value)
    }
    /*
     * The weight now agrees with `aria-pressed` instead of contradicting it.
     *
     * It is still named here rather than left to CSS, because the glyph has to
     * hollow in TWO states — interactive and annotating — and `aria-pressed`
     * only distinguishes one of them. Filled means "a click selects", which is
     * true in exactly one of the three modes.
     */
    drawGlyph(interactiveButton, "Cursor", mode.weight)
  }

  /*
   * Nothing here reports the queue any more, and that is deliberate.
   *
   * The bar used to build a committer, then an indicator that replaced it: a
   * square carrying `owedCount()` that opened the Changes tab on a press. Both
   * are gone. The committer went because the tab writes better than a tick in a
   * toolbar can; the indicator went because it was a second, quieter way to say
   * what the tab's own badge already says, on a control whose only action was
   * "open the panel" — which the inspector toggle three glyphs to its left
   * already does.
   *
   * What the split left behind is still worth stating: the queues (what can be
   * written) and the outbox (what the designer is owed) are different lists,
   * and the bar now reads neither. The count lives in one place, on the tab.
   */

  /**
   * The notes brief, on the clipboard — a COMMAND, with no square in the bar.
   *
   * `notes.copy` is registered on it below, and a keydown is as much a user
   * gesture as a click, so the clipboard still opens for it. The copy itself is
   * `copyHandover`, the same call the Changes tab's Copy makes, so the chord and
   * the button put the same text on the clipboard and say the same toast.
   */
  const copyBrief = (): void => {
    copyHandover(context.toast)
  }

  /**
   * The button and the shortcut are the same call, not two that agree.
   *
   * `travel` is what Cmd+Z runs and what the button runs, so the refresh and
   * the disabled state cannot drift apart — which is the shape the old Undo
   * button failed at from the other direction: it asked the vendor engine
   * whether there was anything to undo, and the answer was always no.
   *
   * No toast. Undo and redo are direct manipulation: the canvas moving back is
   * the report, and a card per ⌘Z stacked over the corner on every press.
   */
  const travel = (direction: "undo" | "redo") => {
    if (direction === "undo") undo()
    else redo()
    // The inspector reads the element, so the panel is stale until it re-reads.
    context.refresh()
  }

  /*
   * A HOOK, not a circular arrow.
   *
   * These wore Lucide's `RotateCcw` and `RotateCw`, which are arrows bent
   * around 300 degrees of a circle, and they were the two marks in the bar that
   * read a size larger than everything beside them. Measured, they inked 13.5
   * of the 16 lattice against a 12-unit panel frame — but the extra size is not
   * really the number. A closed ring gives the eye no gap to stop at, so it
   * reads as one big round thing at whatever size it is drawn, and it says the
   * more roundabout thing too: the reader has to work out which way a circle is
   * turning before they know which button goes back.
   *
   * `ToolUndo` and `ToolRedo` are half a ring with a straight shaft and an
   * arrowhead pointing the way they travel. Simpler to read, a unit and a half
   * smaller, and — the reason the family can draw them at all — a half ring is
   * cut on the vertical diameter, where the tangent is horizontal, so the shaft
   * and the tail land on the lattice instead of leaving the curve at an angle
   * nothing else here can meet.
   */
  const undoButton = el(
    "button",
    {
      class: "de-tool",
      type: "button",
      // Spelled the way the platform spells it, since the tooltip is the only
      // place the shortcut is written down.
      ...tip("Undo", keyFor("history.undo")),
      onclick: () => travel("undo"),
    },
    [icon("ToolUndo", GLYPH)]
  )

  const redoButton = el(
    "button",
    {
      class: "de-tool",
      type: "button",
      ...tip("Redo", keyFor("history.redo")),
      onclick: () => travel("redo"),
    },
    [icon("ToolRedo", GLYPH)]
  )

  /**
   * A panel toggle that NAMES its panel and lets the panel report itself.
   *
   * It used to own two drawings — an open layout and a collapsed one — and swap
   * between them, on the reasoning that a pressed tint is a colour-only signal.
   * True, but the conclusion was wrong: the thing being reported is a whole side
   * of the screen, and it is either there or it is not. Nobody consults a 16px
   * rectangle to find out whether the panel they are looking at is open. What
   * they cannot get from the screen is which panel a button opens, and a picture
   * of a sliding rectangle does not answer that either — so the mark names the
   * CONTENTS instead: the layer tree, and the controls.
   *
   * The name stays put through both states — "Toggle …" is true either way, and
   * a name that rewrote itself under the pointer would be the second report of a
   * state `aria-pressed` already carries. `aria-pressed` is read from the store
   * rather than remembered from the last click, since the shell writes
   * `layersOpen` and `inspectorOpen` too and a button counting its own clicks
   * would drift the first time anything else moved the flag.
   *
   * ON FILLS THE MARK, and that is the one thing the state says on the glyph
   * itself. It used to say it in stroke weight alone — half a unit heavier,
   * applied by `css/icons.ts` — which is a signal you can only read by
   * comparing: set the pressed glyph beside the same glyph at rest and the
   * difference is obvious, look at one button on its own and there is nothing
   * to measure it against. That is the wrong shape for these four, because the
   * question they answer ("are notes armed?", "is the inspector up?") is asked
   * of ONE button at a time. Solid or hollow needs no reference.
   *
   * The mode switch two clusters to the left has always done this, for exactly
   * this reason, and it has been the only control in the bar that does. Three
   * toggles reporting their state one way and a fourth reporting it another was
   * the actual inconsistency — the fix is the rest of them catching up rather
   * than the pointer giving up its fill.
   */
  const panelToggle = (options: {
    label: string
    glyph: IconName
    read: () => boolean
    write: (next: boolean) => void
    /** The key that does the same thing, for the tip. Not every toggle has one. */
    key?: string
    /**
     * Report ON with the GLYPH alone — no accent chip behind it.
     *
     * The chip is the right report for a mode, because a mode is a claim about
     * what the next click will do and there is nothing on screen to check it
     * against until you make one. A panel toggle is the opposite case: press it
     * and a quarter of the screen appears. Lighting the button as well is the
     * third report of one fact, and two accent squares in a four-glyph cluster
     * flatten the distinction the cluster is there to make — "what a click
     * does" and "what is on screen" stop looking like different questions.
     *
     * So the fill in the mark carries it, which is the signal that survives
     * having nothing to compare against, and the square stays quiet.
     */
    quiet?: boolean
  }) => {
    const { label, glyph, read, write, key, quiet } = options
    const button = el(
      "button",
      {
        class: quiet ? "de-tool de-tool--quiet" : "de-tool",
        type: "button",
        ...tip(label, key),
        onclick: () => write(!read()),
      },
      [icon(glyph, GLYPH)]
    )
    const paint = () => {
      const on = read()
      button.setAttribute("aria-pressed", String(on))
      // One read of the state, two reports of it: the attribute for anything
      // listening, the weight for the eye. Painting them from separate reads is
      // how a button comes to look off while announcing itself on.
      drawGlyph(button, glyph, on ? "filled" : "outline")
    }
    return { button, paint }
  }

  /*
   * The two panels, drawn as the SIDES they are.
   *
   * These wore the contents — a layer stack and a slider rack — on the argument
   * that what a designer cannot get from the screen is which panel a button
   * opens, and that a picture of the panel does not answer it either. The first
   * half still holds and the second turned out to be false in the one way that
   * matters: the two marks were unrelated drawings that happened to sit next to
   * each other, so the pair had to be learned. Left and right are one drawing
   * mirrored, and a mirrored pair is read rather than remembered — the
   * side the ink is on IS the side of the screen that moves.
   *
   * It also stops the marks lying as the panels grow. The left panel has held
   * three tabs since Assets and Design system landed there, so a layer stack on
   * its button names one of them; the right one holds Design, Changes and
   * Design system, and sliders name a section of a section. A panel's contents
   * are a moving target. Which edge it is attached to is not.
   */
  const layersToggle = panelToggle({
    label: "Show or hide left panel",
    glyph: "PanelLeft",
    read: () => context.getState().layersOpen,
    write: (next) => context.setState({ layersOpen: next }),
    key: keyFor("panel.left.toggle"),
    quiet: true,
  })
  const inspectorToggle = panelToggle({
    label: "Show or hide inspector",
    glyph: "PanelRight",
    read: () => context.getState().inspectorOpen,
    write: (next) => context.setState({ inspectorOpen: next }),
    quiet: true,
  })

  /**
   * Canvas view: every page of the app on one board, and back to the live page.
   *
   * Third in the bar, straight after the two modes: it is the other half of
   * "where am I working" — one live page, or every page on a board — and it is
   * reached for as often as they are. It is QUIET for the reason the panel
   * toggles are: pressing it replaces the page with a board of frames, so an
   * accent chip would be the third report of a change nobody can miss.
   *
   * It goes through commands rather than importing the board. The board installs
   * after the toolbar (it needs the panels' insets to size itself), and a name
   * resolved at click time is the same seam the keymap already uses — so the
   * button and ⇧1 cannot drift into doing two different things.
   *
   * Hovering it starts loading the current page's frame, so the frame the page
   * shrinks into on the way out has usually painted by the time the motion ends.
   */
  const canvasToggle = panelToggle({
    label: "Canvas view",
    glyph: "Grid2x2",
    read: () => context.getState().canvasView,
    write: () => void runCommand("view.canvas.toggle"),
    key: keyFor("view.canvas"),
    quiet: true,
  })
  canvasToggle.button.setAttribute("data-de-control", "canvas")
  const prewarmCanvas = () => void runCommand("view.canvas.prewarm")
  canvasToggle.button.addEventListener("pointerenter", prewarmCanvas)
  // A task later on focus, because the commonest focus this button gets is
  // the board handing it back from inside its closing transition's update
  // callback, where a canvas measure and a frame's setup sat between Escape
  // and the frame that shows the page again. A Tab onto it has no such hurry.
  canvasToggle.button.addEventListener("focus", () => void setTimeout(prewarmCanvas, 0))

  /**
   * Annotation mode, beside the mode switch rather than the panel toggles.
   *
   * It answers the same question the mode switch answers — what does a click
   * do — and a designer scanning the bar for that answer must not have to find
   * it in two places. The panel toggles next door answer a different one:
   * which surfaces are on screen. Grouping this with them would file "clicking
   * now writes a note" under "a panel is open", which is the same category
   * error as putting undo in with them.
   *
   * It TURNS INTERACTIVE MODE OFF, and has to. Interactive mode hands every
   * click to the app; annotation mode intercepts every click. Both true at
   * once is not a state the canvas can act on, and leaving the user to
   * discover that by clicking is worse than deciding it here — the last mode
   * pressed is plainly the one meant.
   *
   * It keeps the accent chip the two panel toggles have given up, and that is
   * the distinction the chip is now FOR: a mode is a claim about the next
   * click, with nothing on screen to check it against until the click is made.
   * See `quiet` above.
   */
  const annotateToggle = panelToggle({
    label: "Notes",
    glyph: "MessageSquare",
    read: () => editorMode() === "annotating",
    // The other half of the three-mode rule. Turning notes ON leaves inspect
    // behind; turning it OFF lands in interactive, not back in inspect —
    // leaving a mode is not a request for a different one. Two writes used to
    // do this (`annotating` here, `interactive` there) and the pair could
    // interleave into the state where the editor had given the pointer away
    // and was still swallowing clicks.
    //
    // Raising it also raises the Changes tab, which is where the notes it pins
    // land. That rule is `setMode`'s rather than this button's, so the ⌥ key
    // bound to the same mode cannot arrive at a different panel.
    write: (next) => context.setMode(next ? "annotating" : "interactive"),
    key: keyFor("mode.notes"),
  })

  /**
   * Which way the chrome is painted — and it sits with the panel toggles,
   * because that cluster is the one that answers "what is the editor showing
   * you". Layers and the inspector say which surfaces are up; this says how all
   * of them are inked. Neither changes what a click means, and neither touches
   * the document or the file, which is what keeps it out of the two clusters
   * either side of it.
   *
   * BEFORE "Hide editor", not after. Hide is the terminal member of this
   * cluster — the one that takes the whole bar with it — and a control read
   * after the one that removes the bar is a control in the wrong place. So the
   * run escalates: one panel, the other panel, how it is all painted, then all
   * of it away.
   *
   * `Square`, and it is the honest pick rather than the obvious one: this set
   * has no sun, no moon and no half-filled contrast disc, and `tools/build-icons
   * .mjs` is not this change's to edit. What `Square` has is two weights and no
   * drawing of its own, so the `aria-pressed` rule in `css/icons.ts` turns it
   * into exactly the contrast chip the missing glyph would have been — a hollow
   * chip on the dark chrome, a solid one once the light theme is on. The layers
   * tree also draws `Square` as its "plain element" mark; that is a 12px mark
   * in a tree and never appears in this bar, so the two cannot be read side by
   * side and mistaken for each other.
   *
   * No `prefers-color-scheme`, on first run or ever. See the note on
   * `storedTheme` for where the choice lives; the reason not to seed it from
   * the OS is that this chrome is a frame around SOMEONE ELSE'S product, and
   * the OS preference is a fact about the designer's desktop rather than about
   * the thing under review. Honouring it would also quietly change the editor's
   * appearance for every user on a light desktop the next time they load it,
   * with no interaction to explain the change — which is the one thing "default
   * to the current appearance" rules out. If this ever follows anything, it
   * should follow the app in the viewport, not the menu bar above it.
   */
  let theme: ThemeName = storedTheme() ?? "dark"

  /*
   * Sun and Moon are both mounted, and the flip crossfades between them.
   *
   * `drawGlyph` cannot serve this one: its pair is two WEIGHTS of a single
   * glyph, and these are two different drawings. Same helper underneath, same
   * `inherit` tint for the same reason — this is a toggle, not a confirmation.
   *
   * `Sun` rests and `Moon` is the swapped-to state, which follows the table
   * above: the dark theme offers the sun, so `show(true)` means light is on.
   */
  const themeMark = swapMark(THEMES.dark.glyph, {
    size: GLYPH,
    done: THEMES.light.glyph,
    tint: "inherit",
  })
  themeMark.show(theme === "light")

  const themeButton = el(
    "button",
    {
      class: "de-tool",
      type: "button",
      ...tip(THEMES[theme].label),
      onclick: () => setTheme(theme === "light" ? "dark" : "light"),
    },
    [themeMark.node]
  )

  /** Name, tip and glyph are one fact about the theme, so one function writes them. */
  const paintTheme = (): void => {
    for (const [name, value] of Object.entries(tip(THEMES[theme].label))) {
      themeButton.setAttribute(name, value)
    }
    themeMark.show(theme === "light")
  }

  const setTheme = (next: ThemeName): void => {
    theme = next
    applyTheme(next)
    rememberTheme(next)
    paintTheme()
  }

  // Restore before anything paints. `installToolbar` runs inside the same task
  // as `mountShell`, so the attribute is on `<html>` before the first frame and
  // a session that ended in light mode never flashes dark on its way back.
  applyTheme(theme)

  /**
   * The way out of the editor's way — and it sits with the panel toggles,
   * because it is the same question asked about everything at once.
   *
   * Closing both panels never achieved this. The bar stayed, and behind the
   * bar the canvas lane stayed too, so every click on the product was still
   * being swallowed by an editor with almost nothing on screen to explain why.
   * This one stands the whole thing down, hands the pointer back, and leaves a
   * single button in the corner as the receipt.
   *
   * No `aria-pressed`. A toggle reports a state you can see it in; press this
   * and the button itself is gone, so the honest thing is a plain action whose
   * name says where it goes. No keyboard shortcut either: a key would have to
   * be live while the editor is invisible, which is how an app ends up with
   * chrome nobody can explain the arrival of.
   */
  const hideButton = el(
    "button",
    {
      class: "de-tool",
      type: "button",
      ...tip("Hide editor", keyFor("chrome.toggle")),
      onclick: () => context.setChromeHidden(true),
    },
    /*
     * A cross, where this used to draw four arrows converging on a centre.
     *
     * The arrows were the honest mark while collapsing was a jump cut: one
     * surface vanished, another appeared, and the glyph had to carry the whole
     * story of where the editor went. The collapse animates now — the bar
     * shrinks toward the corner the disc grows out of — so the motion tells
     * that story, and the four arrows were left restating it at 16px. A cross
     * says the plainer thing that is left: this closes.
     *
     * `ToolClose` rather than `X`: the bar keeps a name of its own so its
     * cross can be redrawn without touching the seven other places `X` is
     * drawn, most of them at `icon.marker`. Both are Phosphor's `x` today.
     */
    [icon("ToolClose", GLYPH)]
  )

  // UI3 keeps one slim, stable strip at the bottom. Selection never moves it.
  //
  // ONE group, and the reading order carries what the clusters used to.
  //
  // There were three, each answering a different question: what a click does,
  // what to do with what you did, and what the editor is showing you. The
  // partition was real, and it was still costing more than it returned. Every
  // control in this bar is a 32px square, so the only thing a cluster could be
  // made of was air — and air between squares that look identical does not say
  // WHICH question the break is about, only that somebody drew one. Eight
  // glyphs is short enough to read straight through; the reader who needs undo
  // finds it by its glyph, not by working out which third of the bar it is in.
  //
  // What the clusters were protecting survives as ORDER, which costs nothing
  // and cannot be misread as a stray gap. Left to right: the mode leads, because
  // every other control's answer depends on which mode you are in; the notes
  // toggle sits with it, because it is the other thing a click can mean; the
  // canvas view comes third, because it is the other half of "where am I
  // working" — one live page, or every page on a board — and it is reached for
  // as often as the modes are; then time travel over what you did; then the
  // chrome — how it is painted, the left panel, the right panel, and then all
  // of it away. Hide is last because nothing is read after the control that
  // takes the bar off screen.
  //
  // The mirrored pair still has to stay adjacent and in screen order — a panel
  // on the left, a panel on the right — which is the one adjacency in this run
  // that is load-bearing rather than conventional. The theme leads them rather
  // than splitting them.
  slots.toolbar.append(
    el("div", { class: "de-toolbar-group" }, [
      interactiveButton,
      annotateToggle.button,
      canvasToggle.button,
      undoButton,
      redoButton,
      themeButton,
      layersToggle.button,
      inspectorToggle.button,
      hideButton,
    ])
  )

  /**
   * The bar, draggable by its ground.
   *
   * Four things about this are decisions rather than plumbing.
   *
   * ITS OWN POSITION, and only its own. The drag holds the box it last
   * resolved, which outlives every collapse and expand of the session because
   * the element and the gesture both do — so a bar that was moved is still
   * moved when the editor comes back. The disc keeps a separate one. They were
   * briefly a single shared position, which is what a collapse that MORPHED
   * one surface into the other needed; the collapse is a fade now, nothing
   * travels, and two surfaces you can park independently is the better trade.
   *
   * THE GROUND ONLY. A press that lands on a control belongs to that control,
   * so `grabbable` declines it and the drag is never armed — which is also why
   * a drag can never fire the control it ends over. The browser dispatches a
   * click to the nearest common ancestor of the mousedown and the mouseup
   * targets, and a gesture that began on the ground has a ground element on one
   * side of that pair, so the common ancestor is always the bar itself and
   * never a button inside it. Worth knowing because the obvious belt — swallow
   * the click in a capture listener — does NOT work in this chrome: the
   * shell's `restoreChromeFocus` guard replaces `stopPropagation` and
   * `preventDefault` with no-ops for every event aimed at our own surfaces, so
   * a handler here cannot cancel anything. See `shell/shell.ts`.
   *
   * `--de-bar-left` / `--de-bar-right`, not the app's own pair. Those two hold
   * their value while the chrome is hidden; the app's collapse to zero. A bar
   * clamped against zero the moment it is hidden would slide out from under
   * the panels while it faded, which is the exact jump those variables were
   * introduced to prevent, now applied to a bar that has been dragged.
   *
   * `panelInset` as the margin, because that is the inset the pill rests at.
   * A dragged surface should be able to land exactly where an undragged one
   * sits, or the resting position is somewhere the user cannot choose.
   */
  /*
   * The size is KEPT, not asked for, once the browser has reported it.
   *
   * Every clamp needs the pill's size, and the clamps run exactly when the
   * app's inset has just changed — a panel toggled, the editor hidden or shown.
   * Asking the element then forced a layout of the whole app for a number the
   * inset cannot affect: the pill sits outside the app and is as wide as its
   * own buttons. A ResizeObserver hands over each new border box after the
   * frame's own layout, so the kept size is current at every paint, and the
   * element is measured directly only until the first report arrives.
   */
  let size: { width: number; height: number } | null = null
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize?.[0]
      size = box ? { width: box.inlineSize, height: box.blockSize } : null
    }).observe(slots.toolbar)
  }
  const measure = () => {
    if (size) return size
    const rect = slots.toolbar.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }

  const drag = installDrag({
    element: slots.toolbar,
    dragging: "de-toolbar--dragging",
    slack: DRAG_SLACK,
    inset: tokens.size.panelInset,
    sides: ["--de-bar-left", "--de-bar-right"],
    size: measure,
    grabbable: (event) =>
      !(event.target instanceof Element) || event.target.closest(CONTROLS) === null,
    paint(box) {
      /*
       * `left` is the pill's CENTRE, not its left edge.
       *
       * The centring `translateX(-50%)` stays in force while the bar is
       * dragged, and it has to: base.ts restates that translate with
       * `!important` under reduced motion, so an inline `transform: none` here
       * would lose to it and shunt the bar half its own width sideways for the
       * one person who asked for less motion. Writing the centre into `left`
       * leaves the transform alone and keeps both arrangements true at once.
       */
      slots.toolbar.style.left = `${box.x + measure().width / 2}px`
      slots.toolbar.style.top = `${box.y}px`
      // The stylesheet anchors the pill to the bottom; a dragged one is
      // anchored to the top, and both cannot be in force at once.
      slots.toolbar.style.bottom = "auto"
    },
    rest() {
      slots.toolbar.style.removeProperty("left")
      slots.toolbar.style.removeProperty("top")
      slots.toolbar.style.removeProperty("bottom")
    },
    /**
     * Where the pill rests: the middle of the WINDOW, at the bottom inset.
     *
     * The same two numbers `css/toolbar.ts` writes, restated here because the
     * clamp cannot read a stylesheet. Keep them in agreement — a second answer
     * to "where does it rest" is a bar that jumps the first time a panel is
     * toggled, which is the exact bug this pair exists to close.
     *
     * A top-LEFT, where the stylesheet writes a centre, because that is the
     * corner `installDrag` bounds and paints from. `paint` above converts back.
     */
    anchor: () => {
      const { width, height } = measure()
      return {
        x: (window.innerWidth - width) / 2,
        y: window.innerHeight - height - tokens.size.panelInset,
      }
    },
  })

  /*
   * A SEAM drag moves the same edges a toggle moves, and does not go through
   * the store.
   *
   * The subscription below hears the two panel flags, which is every way a
   * panel can appear or disappear — but not the way it can grow. Pulling the
   * inspector out to its share of a narrow window walks its inner edge across
   * a bar that is centred on the window and knows nothing about it, and with
   * nothing listening here the bar would sit under the panel until the next
   * toggle. `resize.ts` already filters this down to the frames where the
   * published inset actually moved, so it is one clamp per changed pixel-width
   * and not one per pointermove.
   */
  onInsetsChange(() => drag.place())

  const syncPressed = () => {
    paintMode()
    layersToggle.paint()
    inspectorToggle.paint()
    annotateToggle.paint()
    canvasToggle.paint()
    undoButton.toggleAttribute("disabled", !canUndo())
    redoButton.toggleAttribute("disabled", !canRedo())
    /*
     * No count is painted here any more.
     *
     * The bar used to mirror `owedCount()` onto a Changes square, which meant
     * two lanes reading one list and a standing risk that the bar and the panel
     * it pointed at disagreed. The tab's own badge is the single reader now.
     */
  }

  // The engine pushes its own change events below; from our store only the two
  // modes, the two panel flags and the dirty flag affect this row. Anything
  // broader would re-query the engine on every pointermove.
  //
  // `annotating` has to be in this list, not just in `syncPressed`. The toggle
  // writes the flag and paints nothing itself, so a key missing from here is a
  // button that shows the wrong state until something unrelated happens to
  // repaint the bar — and the state it shows wrong is which mode a click is in.
  context.subscribe((next, previous) => {
    /*
     * The app area changed shape, so a dragged bar may now be under a panel.
     *
     * Three flags move those edges and all three are here. The two panel
     * toggles move one edge each; "Hide editor" moves both at once and then
     * moves them back, and it is the one that has to be listened for in BOTH
     * directions — the bar has to be back inside the work area by the time it
     * fades in, not a frame afterwards.
     *
     * The shell's own subscriber is registered first (it mounts before any
     * lane installs), so `--de-bar-left` and `--de-bar-right` already hold
     * their new values by the time this runs. That ordering is why the clamp
     * can read them synchronously instead of waiting a frame.
     *
     * Not animated, and that is the same decision `syncInsets` makes about the
     * app's padding: the correction lands in one step, in the frame the panel
     * appears. Animating it would mean transitioning `left`, which relayouts
     * the app under a moving bar for the length of the slide.
     */
    if (
      next.layersOpen !== previous.layersOpen ||
      next.inspectorOpen !== previous.inspectorOpen ||
      next.chromeHidden !== previous.chromeHidden
    ) {
      drag.place()
    }
    if (
      next.interactive === previous.interactive &&
      next.annotating === previous.annotating &&
      next.layersOpen === previous.layersOpen &&
      next.inspectorOpen === previous.inspectorOpen &&
      next.canvasView === previous.canvasView &&
      next.dirty === previous.dirty
    ) {
      return
    }
    syncPressed()
  })
  context.onRefresh(syncPressed)
  onHistoryChange(syncPressed)
  try {
    bridge.store.onStateChange(syncPressed)
  } catch {
    // Older engine builds do not expose every subscription.
  }
  // The Angular lane keeps its queue outside the vendor store, so the button's
  // disabled state has to hear from it directly — the engine has nothing to say
  // about a write it is not carrying.
  onAngularQueueChange(syncPressed)
  // Deletions are queued outside both of those, so they need their own line
  // here for the same reason: nothing else will tell the button they exist.
  onRemovalQueueChange(syncPressed)

  /*
   * This bar has no keyboard listener. It publishes what its controls DO, and
   * `shell/shortcuts.ts` is the one module in the editor that listens for a key.
   *
   * It used to own two chords — ⌘. and ⌘Z — each carrying its own copy of the
   * guards. That was fine at two and is not at thirty: the point of a
   * Figma-sized keymap is that "does this key already do something?" has ONE
   * place to ask. What stays here is the behaviour, because the behaviour is the
   * bar's: `travel` is the same call the buttons make, so the toast, the refresh
   * and the disabled state cannot drift between a click and a keystroke.
   *
   * `notes.copy` no longer has a button to go through — it IS the copy now, and
   * the clipboard write still lands inside a real user gesture because a keydown
   * is one. That is what let the square leave the bar without the chord leaving
   * with it.
   *
   * Registered rather than exported, so that nothing has to care which of the
   * two lanes is installed first: a name in the registry is resolved at the
   * moment the key is pressed, by which time everything that mounts has.
   */
  registerCommand("chrome.toggle", () => context.setChromeHidden(!context.getState().chromeHidden))
  registerCommand("chrome.hide", () => context.setChromeHidden(true))
  /*
   * THE KEYBOARD'S WAY INTO THE CHROME, and the bar is the right place to land.
   *
   * The editor mounts on `<body>`, so it sits LAST in tab order behind the
   * whole of the host app; and while a selection exists the canvas consumes Tab
   * outright for sibling navigation. Between the two there was no route from
   * the page into the chrome that did not involve a mouse. This is it.
   *
   * It lands on the first enabled TOOL rather than on the bar, because the bar
   * is a `div`: focusing a container draws a ring around a strip and says
   * nothing about what the reader has arrived at. The first tool is the
   * selection tool, which is where a pointer user starts too.
   *
   * It UNHIDES first. A collapsed editor is `visibility: hidden`, whose whole
   * purpose is that nothing inside it can take focus — so asking while hidden
   * would silently do nothing, which is the one outcome a keyboard affordance
   * must never have. `setChromeHidden(false)` on a chrome that is already up is
   * a no-op, so the ordinary case costs nothing.
   *
   * The focus waits a frame for the same reason: unhiding is a state write, and
   * the element is not focusable until the class it drives has landed.
   * `focusControl` rather than `.focus()` so the ring is actually drawn — this
   * is a keyboard gesture by construction, and the modality guard in
   * `core/focus.ts` has to be told so.
   */
  registerCommand("chrome.focus", () => {
    context.setChromeHidden(false)
    requestAnimationFrame(() => {
      focusControl(slots.toolbar.querySelector<HTMLElement>("button:not([disabled])"))
    })
  })
  registerCommand("history.undo", () => travel("undo"))
  registerCommand("history.redo", () => travel("redo"))
  registerCommand("notes.copy", copyBrief)
  registerCommand("theme.toggle", () => setTheme(theme === "light" ? "dark" : "light"))

  /*
   * The outbox moves the indicator's count, and nothing else in this bar was
   * watching it.
   *
   * The existing subscriptions cover the QUEUES — the vendor store, the Angular
   * queue, the removal queue — which is what the old commit button cared about.
   * The count is a different list: a pinned note or a stranded write changes it
   * without touching any queue, and a commit clearing `queued` changes it
   * without touching the store. Both of those left the number stale for as long
   * as the bar sat there, which on a collapsed panel is the whole session.
   */
  onAnnotationsChange(syncPressed)
  onEditsChange(syncPressed)
  onPreviewOnlyChange(syncPressed)

  syncPressed()
}
