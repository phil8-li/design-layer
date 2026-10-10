/**
 * Right panel, Annotations tab.
 *
 * The session's outbox, and the one door everything leaves by. A session in
 * this editor produces two kinds of intent — notes about what is wrong, and
 * edits that already fix part of it — and they used to leave separately, when
 * they left at all: notes had nowhere to go, and the change queue only ever
 * carried the subset of edits the writer could not spell in source. Handing an
 * agent one without the other is what makes it redo work that is done, or
 * guess at reasons it was never given.
 *
 * So this is one list in the order things happened, and every row says which
 * of the two it is. An edit says one thing more — whether it reached the file
 * — because an agent reads those cases completely differently: a written
 * change is already in the source it is about to open, and applying it again
 * is a conflict rather than a fix.
 *
 * The settings live here rather than behind a preferences screen for the same
 * reason the queue lives in the panel rather than the toolbar: they are
 * settings ABOUT this list — how much it says, what color its markers are,
 * whether a handover empties it — and reading them anywhere else means reading
 * them away from the thing they describe.
 *
 * The tab is ONE SECTION, "Notes and edits", then the handover buttons, then
 * Settings, in one scrolling column with nothing pinned to the bottom edge.
 * Notes and edits share one list, one numbering (the same number the pin on the
 * canvas and the brief use), one undo timeline, one Copy and one send.
 *
 * Brief detail is the first row in Settings, and there is exactly ONE of it.
 */

import { isProjectSourcePath } from "../../core/bridge"
import { createApply } from "../../core/apply"
import { previewOnlyChanges, type PreviewOnlyChange } from "../../core/change-prompt"
import { clear, el } from "../../core/dom"
import { holdScroll } from "../../core/scroll"
import { leaveRow } from "../../core/leave"
import { swapMark } from "../../core/swap-mark"
import { icon, type IconName } from "../../core/icons"
import { TIP_ATTR, TIP_WRAP_ATTR } from "../../core/tooltip"
import {
  annotationSettings,
  markersVisible,
  onAnnotationsChange,
  onSettingsChange,
  updateSettings,
} from "../../annotations/store"
import { isEditQueued, onEditsChange } from "../../annotations/journal"
import { clearNotesStep, deleteNote, undoNoteStep } from "../../annotations/actions"
import { copyHandover, handOver, needsAgent } from "../../annotations/handover"
import { COPY_REFUSED, copyText } from "../../core/clipboard"
import { onComponentUsageChange, sharedComponentWarning } from "../../core/component-usage"
import { withdrawEdit } from "../../core/withdraw"
import { outboxItems, outboxNumbers } from "../../annotations/output"
import {
  OUTPUT_DETAILS,
  type AnnotationRecord,
  type AnnotationTarget,
  type EditRecord,
  type OutputDetail,
} from "../../annotations/types"
import type { EditorContext } from "../../core/context"
import type { ToastMessage } from "../../core/toast"
import { section, selectField } from "./field"
import type { InspectorTab } from "./tab-code"
import { tokens } from "../../core/tokens"
import { plural } from "../../core/format"

/*
 * THE COMPONENTS SWITCH IS GONE, and nothing replaced it.
 *
 * It read "React components" or "Angular components" depending on the host,
 * which is the shape of a question the tool was already answering: the editor
 * detects its framework at startup and `output.ts` reads the stack either way
 * — fiber walk on React, `ng.getOwningComponent` on Angular. The only thing
 * the switch could do was make the brief worse, and it cost a row in a panel
 * where a row is expensive. The stack is always gathered now; how much of it
 * the brief prints is Output detail's job, which is a preference a designer
 * genuinely holds.
 */

/*
 * THE MARKER COLOUR PICKER IS GONE, and the setting it wrote is not.
 *
 * Seven swatches stood here, and before them a native `<input type="color">`.
 * What finished them off is that the choice was never one a designer came to
 * this panel to make: the pin is read by the person who dropped it, in the
 * session they dropped it in, and the shipped blue is legible on a white page
 * and a dark one alike. A row that is right by default is a row nobody opens
 * Settings for, and this block is small enough that every row in it has to
 * earn the line.
 *
 * `markerColor` is retired with it: the pin wears the chrome's indigo accent,
 * and `annotations/store.ts` drops a stored value like any other retired key.
 */

/**
 * What the bin on an edit row does: a real withdrawal (`core/withdraw.ts`). The
 * queued operation is taken back, the preview reverts, and the ledger entry
 * goes with it — so the label says that, rather than "Remove".
 */
const DROP_EDIT = "Discard change. Nothing is written."

/**
 * The consequence, said on the button. A delete is a step on the editor's one
 * undo timeline (`annotations/actions.ts`), so Cmd+Z brings the note back, and
 * so does the Undo on the card the delete raises.
 */
const DELETE_NOTE = "Delete note (undo brings it back)"

/**
 * Said as "reopen", not "edit", because the note is written somewhere else.
 *
 * Pressing this does not turn the row into a field. It sends the reader back to
 * the page, to the bubble they wrote the note in, which may be scrolled off
 * screen. A button labelled "Edit" that moves the user's attention to another
 * surface without saying so is how a designer loses track of where they are.
 */
const EDIT_NOTE = "Edit on page"

/**
 * The two things this panel says to the canvas, and the whole of the coupling.
 *
 * A row and a pin are two drawings of one note, and the panel has no business
 * knowing how the second one is drawn — importing the marker layer to light a
 * pin would make the inspector depend on the overlay for a highlight. An event
 * on `window` is the seam: the panel states a fact about where the pointer is,
 * the canvas decides what that looks like, and neither can break the other's
 * build.
 *
 * `null` is a value in the hover contract rather than a second event, because
 * both halves have to land in one handler on the far side. A listener that only
 * ever hears "now this one" is how a highlight gets stuck on a row the pointer
 * left minutes ago.
 */
const HOVER_EVENT = "designlayer:annotation-hover"
const EDIT_EVENT = "designlayer:annotation-edit"

/**
 * The mirror, coming back the other way: the pointer is on a PIN.
 *
 * This is the reason `.de-ann-item--hover` exists at all rather than the list
 * leaning on CSS `:hover`. A pin hovered on the page has to light its row in a
 * panel the pointer is nowhere near, and no selector can express that.
 */
const MARKER_HOVER_EVENT = "designlayer:marker-hover"

/** The row carries its record's id so the mirror can find it without a map. */
const ITEM_ID = "data-item"

function announceHover(id: string | null): void {
  window.dispatchEvent(new CustomEvent(HOVER_EVENT, { detail: { id } }))
}

/** `3 notes`, `1 note`. Spelled out because the confirm has to count aloud. */
function noteWord(count: number): string {
  return plural(count, "note")
}

/**
 * The two things the clear-all button can say, and how long it stays asking.
 *
 * The second string is the same control saying what pressing it now means, and
 * it reverts on its own: an armed button that stayed armed would let a click
 * ten minutes later empty the list without a word.
 */
const CLEAR = {
  armedMs: 6000,
  label: (count: number) =>
    count ? `Delete all ${noteWord(count)} (keeps edits)` : "Delete all notes",
  // The armed state names the outcome of the NEXT click rather than asking a
  // question and answering it.
  prompt: (count: number) => `Click again to delete all ${noteWord(count)}`,
} as const

/**
 * What the row calls an edit.
 *
 * `property` is a CSS property for all but these four, which are
 * `change-prompt.ts`'s own sentinels that `EditRecord` deliberately reuses.
 * Printing `icon` or `remove` as though it were a declaration would send the
 * reader to the stylesheet looking for a property nobody ever wrote there.
 */
const EDIT_LABELS: Record<string, string> = {
  class: "class attribute",
  icon: "swap icon",
  text: "text content",
  remove: "delete element",
}

/**
 * The fifth sentinel, and the one that could not be a row in that table: a
 * component prop previewed as a DOM attribute is spelled `attribute:<name>` in
 * the ledger, so the NAME is part of the key rather than one of four known
 * words. Printed raw it reads as a namespace the designer never typed.
 */
function editLabel(property: string): string {
  const known = EDIT_LABELS[property]
  if (known) return known
  const attribute = /^attribute:(.+)$/.exec(property)
  return attribute ? `${attribute[1]} attribute` : property
}

/**
 * ONE LINE, and it is the route in rather than the fact of the emptiness.
 *
 * This was two: "Nothing to hand over yet." over "Pin a note on the page, or
 * change anything in the inspector. Both land here." The first of those said
 * only what an empty list has already said — a box with nothing in it does not
 * need a caption announcing that — and the second spent three wrapped lines of
 * a 260px panel restating the two gestures the toolbar above it offers.
 *
 * So the headline went and the detail was cut to the verbs. An empty outbox is
 * where every session starts, which makes this the copy most often read in the
 * product; the shorter it is, the fewer times a returning user re-reads a
 * sentence they already know. What the merged list is FOR — the order, the
 * agent reading intent and change as one story — was never the empty state's
 * to explain.
 */
const EMPTY_DETAIL = "Pin a note or make an edit."

/**
 * Where a row points, short enough for a 260px panel.
 *
 * Basename and line rather than the full path: the tail is the part that
 * identifies the file to someone who already knows the repo, which is the same
 * call the Code tab's source line makes. Run through `isProjectSourcePath`
 * first, so a bundler chunk the resolver guessed at is never printed as a
 * place to go and edit.
 */
function whereOf(target: AnnotationTarget | null): string {
  if (!target) return "no element"
  const name = target.componentName || `<${target.tagName}>`
  if (!target.filePath || !isProjectSourcePath(target.filePath)) return name
  const file = target.filePath.split("/").pop()
  return target.lineNumber ? `${name} · ${file}:${target.lineNumber}` : `${name} · ${file}`
}

/**
 * The second line of a note: what it is pinned to.
 *
 * A `text` note is ABOUT the exact words, and an agent told only which element
 * they were in has to guess which run of text was meant. A `region` over empty
 * space has no element at all, and "no element" on its own reads as a failure
 * to resolve one rather than as the mode working exactly as intended.
 */
function noteSubject(note: AnnotationRecord): string {
  const where = whereOf(note.target)
  if (note.kind === "text" && note.selectedText) return `“${note.selectedText}” in ${where}`
  if (note.kind === "region" && !note.target) return "A region of the page, over no element"
  return where
}

/** How long the tick stays up after a copy, matching agentation's own. */
const COPIED_FOR = 2000

/*
 * The tick-on-copy helper used to live here, and the argument for it still
 * reads best next to a copy button — but it is a general statement about glyph
 * state and three other surfaces needed it, one of which (the Code tab's copy
 * button) was doing the exact clear-and-append the note warns against. It is
 * `core/swap-mark.ts` now; the reasoning moved with it.
 */

export function annotationsTab(editor: EditorContext): InspectorTab {
  /*
   * ONE LIST, notes and edits interleaved in the order they happened. Each row
   * carries the shared number from `outboxNumbers`, so row 4, pin 4 and item 4
   * in the brief are the same thing.
   */
  const list = el("div", { class: "de-ann-list" })

  /*
   * Copy and Send are bare labels: with the two glyph utilities beside them,
   * marks on the pills too made four icons on one 244px line, and the row
   * folded in two. The toast confirms a copy.
   */
  const copyButton = el(
    "button",
    {
      class: "de-button",
      type: "button",
      title: "Copy all notes and edits",
      /*
       * `copyHandover` is the one copy — the toolbar's `notes.copy` chord calls
       * it too — and it writes the clipboard synchronously inside this click
       * task, which is the only time the Clipboard API is open.
       */
      onclick: () => {
        copyHandover(editor.toast)
      },
    },
    /*
     * The label does NOT become "Copied": a wider label would shove the primary
     * button leftward and back two seconds later. The toast already says it.
     */
    ["Copy"]
  )

  /**
   * ONE BUTTON THAT FINISHES THE SESSION.
   *
   * It runs `handOver`: everything the writer can spell is written first, and
   * whatever is left — notes, and edits no commit can write — goes to the agent
   * with the written half in the brief as context. Its label says which of the
   * two will happen: "Send to agent" when anything needs the agent, "Apply to
   * code" when the session is only writable edits. The designer never routes a
   * change themselves.
   */
  let sending = false

  const primaryButton = el("button", {
    class: "de-button de-button--primary",
    type: "button",
    onclick: () => {
      void finish()
    },
  })

  /** The label, written only when it changes, so a repaint per store write is free. */
  function setPrimaryLabel(text: string): void {
    if (primaryButton.textContent !== text) primaryButton.textContent = text
  }

  /**
   * The committer, built here because the queues are module state and there is
   * nothing per-render to close over. `onChange` repaints this tab: "the write
   * finished" is when the rows' badges change, and only the caller knows it.
   */
  const committer = createApply({
    bridge: editor.bridge,
    toast: (message: ToastMessage, kind?: "info" | "error") => editor.toast(message, kind),
    onChange: () => render(),
  })

  /**
   * Has an agent completed an MCP handshake during this page load?
   *
   * Latched rather than live: an agent that drops off mid-session is still
   * configured, and the queue holds a send until it comes back. Before the
   * first handshake there is nobody to send to, so the button never offers it.
   */
  let agentReady = false

  /** What the primary button would do right now, or null when nothing. */
  function primaryMode(): "send" | "apply" | null {
    if (agentReady && needsAgent()) return "send"
    if (committer.hasPendingChanges()) return "apply"
    return null
  }

  function paintPrimary(): void {
    const mode = primaryMode()
    const send = sending ? primaryButton.dataset.mode === "send" : mode === "send"
    if (!sending) primaryButton.dataset.mode = mode ?? ""
    // With no agent and nothing writable the button has nothing it could ever
    // do, so it leaves rather than sitting disabled beside Copy.
    primaryButton.hidden = !sending && mode === null && !agentReady
    primaryButton.disabled = sending || mode === null
    primaryButton.title = send
      ? "Write what it can to your files, send the rest to your agent"
      : "Write these changes to your files"
    setPrimaryLabel(
      sending ? (send ? "Sending…" : "Applying…") : send ? "Send to agent" : "Apply to code"
    )
  }

  /**
   * Disabled while in flight, so a second click cannot write or post the same
   * work twice while the first round trip is outstanding.
   */
  async function finish(): Promise<void> {
    if (sending || primaryMode() === null) return
    sending = true
    paintPrimary()
    try {
      await handOver({
        apiBase: editor.apiBase,
        committer,
        toast: (message, kind) => editor.toast(message, kind),
        sendToAgent: agentReady,
      })
    } finally {
      sending = false
      render()
    }
  }

  /* ---------- footer actions ---------- */

  /**
   * An icon button whose glyph IS its state, repainted only when it changes.
   *
   * Redrawing the `<svg>` on every render would cut a fresh drawing on every
   * store write — the reason the layers tree remembers its mark on the node
   * rather than rebuilding it — and this tab renders on three stores.
   *
   * The label names the OUTCOME rather than the state, which is the rule that
   * tree's row actions follow too: a button announcing "Hidden" leaves a screen
   * reader user to work out for themselves what pressing it would do.
   */
  function setGlyph(button: HTMLElement, glyph: IconName, label: string): void {
    if (button.dataset.glyph !== glyph) {
      button.dataset.glyph = glyph
      button.replaceChildren(icon(glyph, tokens.icon.marker))
    }
    button.setAttribute("aria-label", label)
    button.title = label
  }

  /**
   * Take the markers off the page, from where you are already standing.
   *
   * The same flag the settings row carries, deliberately twice. Settings is a
   * place you visit once a session; lifting the pins to look at the thing
   * underneath them is something you do several times an hour, and a control
   * for that cannot live behind a fold. Two surfaces onto one flag is only safe
   * because neither holds any state of its own — `syncSettings` paints both
   * from ONE read of `annotationSettings()`, so the only way for them to
   * disagree is to stop calling it.
   *
   * Eye and struck-eye are TWO DRAWINGS, not one glyph in a pressed state.
   * Hidden is a fact about the markers on the page rather than the pressed
   * state of this button, and the layers tree already draws that distinction
   * for a row the app has hidden — with the same open eye, which the glyph set
   * vends under both `Eye` and `EyeOpen`. No `aria-pressed` here for the same
   * reason: the label moves with the state, and a moving label over a pressed
   * state announces "Show markers, pressed", the opposite of what is true.
   */
  const visibility = el("button", {
    class: "de-mini",
    type: "button",
    // The function the canvas paints from, so the footer and the page cannot
    // hold different opinions about whether the markers are up.
    onclick: () => updateSettings({ hideUntilRestart: markersVisible() }),
  })

  /*
   * Delete every note, behind two clicks, as one undoable step.
   *
   * The per-row delete needs no confirm and this one does: one row is one
   * mistake, the whole list is a session's work. The toast offers it back, and
   * Cmd+Z does too, because `clearNotesStep` records on the one timeline.
   *
   * It takes NOTES ONLY. Dropping an edit withdraws a change from the page and
   * the queue, which is a different act with its own button on each row; one
   * button doing both would cause that every time somebody meant to clear notes.
   */
  let armed = 0
  let noteCount = 0

  const clearAll = el("button", {
    class: "de-mini de-mini--danger",
    type: "button",
    onclick: () => {
      // `disabled` stops a pointer, not a dispatched event.
      if (!noteCount) return
      if (armed !== 0) {
        disarm()
        const cleared = clearNotesStep()
        if (!cleared) return
        editor.toast(`Deleted ${noteWord(cleared.count)}`, "info", {
          label: "Undo",
          onClick: () => undoNoteStep(cleared.step),
        })
        return
      }
      armed = window.setTimeout(disarm, CLEAR.armedMs)
      // Painted here rather than through `render()`: arming changes no store,
      // and a full repaint would rebuild the rows the reader is looking at.
      paintClear()
      // The words live in the toast because the control is a glyph. The default
      // rung, not `error`: an error card stays until dismissed and would outlive
      // the six-second arming window it describes; `info` ends inside it.
      editor.toast(CLEAR.prompt(noteCount))
    },
  })

  function disarm(): void {
    if (armed === 0) return
    window.clearTimeout(armed)
    armed = 0
    paintClear()
  }

  function paintClear(): void {
    clearAll.disabled = noteCount === 0
    // Armed changes the drawing as well as the fill. Colour alone is the one
    // channel nothing in this tab is allowed to carry a state on — and a danger
    // tint on a button that already goes danger on hover says nothing anyway.
    setGlyph(
      clearAll,
      armed === 0 ? "Trash" : "Check",
      armed === 0 ? CLEAR.label(noteCount) : CLEAR.prompt(noteCount)
    )
    clearAll.classList.toggle("de-ann-clear--armed", armed !== 0)
  }

  /* ---------- the format strip ---------- */

  /*
   * ONE CONTROL, NOT FOUR — the levels moved into a menu.
   *
   * This was a segmented strip of four: Compact, Standard, Detailed, Forensic,
   * laid side by side above the list. Four words is about 210px of a 260px
   * panel, so the strip was a horizontal scroller in its own right — the fourth
   * segment sat half off the edge at the panel's default width and fully off it
   * once the seam was dragged in. A control you have to scroll to see the
   * options of is a menu wearing a strip's clothes.
   *
   * So it is a menu now: the group's name on the left, the chosen level and a
   * chevron on the right. That is the same shape every other one-of-several
   * setting in the inspector uses — `selectField` draws the font weight, the
   * stroke style and the effect type — and it costs one line instead of two.
   *
   * WHAT THE STRIP WAS DOING FOR FREE, and who does it now. The radiogroup
   * carried roving tabindex and arrow-key navigation, hand-written here across
   * about forty lines: `FORMAT_STEPS`, `onFormatKey`, a focus call after each
   * write. A native `<select>` is one tab stop with arrow keys, Home, End and
   * type-ahead supplied by the platform, in every locale, so all of that is
   * deleted rather than ported. The per-level hint that lived in each segment's
   * `title` moves onto the option itself.
   */
  const formatSelect = selectField({
    id: "annotations.detail",
    label: "Brief detail",
    value: annotationSettings().outputDetail,
    options: OUTPUT_DETAILS.map((level) => ({ value: level.id, label: level.label })),
    onCommit: (value: string) => updateSettings({ outputDetail: value as OutputDetail }),
  })
  const formatControl = formatSelect.querySelector("select") as HTMLSelectElement
  /*
   * The hint per option, which the strip carried in each segment's `title`.
   * `<option>` is the one element whose `title` the platform menu actually
   * shows, so this is the one place the native control is the better host.
   */
  for (const [index, level] of OUTPUT_DETAILS.entries()) {
    formatControl.options[index]?.setAttribute("title", level.hint)
  }

  /* ---------- settings ---------- */

  /*
   * Built once and only re-read, never rebuilt inside `render()`: every control
   * below writes through `updateSettings`, which announces, which re-renders
   * this tab. A settings block rebuilt on render would destroy the control the
   * user had just used — focus back on the document, and a keyboard user who
   * toggled a checkbox with Space with nothing to Tab on from. The fold is user
   * state for the same reason: a panel that re-collapsed itself every time a
   * marker was dropped is a panel nobody finishes reading.
   */
  /*
   * Settings folds like every other `section()`, but starts open: the fold is
   * there for a reader who wants the list alone, not a default that hides it.
   */
  const settingsBody = el("div", { class: "de-ann-settings-body", id: "de-ann-settings-body" })
  /**
   * A setting's name, carrying its hint as the tooltip on hover.
   *
   * Every setting used to carry its hint as a paragraph under it, then as a
   * help dot beside the label. The dot is gone too: hovering the name is how a
   * reader asks what a setting means, so the name opens the sentence itself.
   * ONE SENTENCE each, and it has to say something the label does not.
   *
   * The tooltip card is `aria-hidden` and the label is not focusable, so the
   * same sentence goes on the row's switch as `aria-description` — see
   * `switchRow` and the Show pins row.
   */
  function hintedLabel(text: string, hint: string): HTMLElement {
    return el("span", { class: "de-ann-setting-label", [TIP_ATTR]: hint, [TIP_WRAP_ATTR]: "" }, [text])
  }

  /**
   * A switch. EVERY setting in this block is one now.
   *
   * There used to be two vocabularies here, and the split was defended at
   * length: a switch for a setting that changes the editor from now on, a
   * checkbox for a "one-shot preference" about some later handover. It was a
   * distinction the panel could state and the reader could not use. All five
   * rows persist, all five take effect the moment they are pressed, and none
   * of them is scoped to a single handover — "Clear on copy or send" is a
   * standing instruction about every copy, not a box you tick before one. What
   * the two drawings actually communicated was that some rows in one fold were
   * a different KIND of thing, which they are not.
   *
   * So: one control, on the right edge, for every row. The alignment is no
   * longer carrying a meaning, which means it can no longer carry a wrong one.
   *
   * The button carries no text: the row's label already names it, and a second
   * copy inside the control is one more thing to read for the same fact. That
   * is what `aria-label` is here to replace.
   *
   * `aria-checked` is the state itself rather than a mirror of some variable —
   * `syncSettings` writes it, the click handler reads it back, and the
   * stylesheet paints off it. One place to be wrong instead of three.
   */
  function switchControl(label: string, onCommit: (value: boolean) => void): HTMLButtonElement {
    const node = el("button", {
      class: "de-ann-toggle",
      type: "button",
      role: "switch",
      "aria-checked": "false",
      "aria-label": label,
    })
    node.addEventListener("click", () => onCommit(node.getAttribute("aria-checked") !== "true"))
    return node
  }

  /**
   * A whole row: the name, its dot, and the switch opposite them.
   *
   * The three rows this builds were `<input type="checkbox">` with a `<label
   * for>`, and losing the native input costs one real thing — clicking the
   * WORDS no longer toggles the setting. That is the price of the row above
   * being a `role="switch"` too, and it is paid on purpose: `.de-ann-setting`
   * is not a `<label>` and cannot become one without putting a `<button>`
   * inside label content, which is invalid and makes a press on the help dot
   * silently flip the setting behind it. Every row in the block now has one
   * target, in the same place, doing the same thing.
   *
   * The returned switch is handed back rather than looked up again, because
   * `syncSettings` writes `aria-checked` on it on every render and a
   * `querySelector` per render over a block that never rebuilds is a lookup
   * for a node we are holding.
   */
  function switchRow(
    label: string,
    hint: string,
    onCommit: (value: boolean) => void
  ): { row: HTMLElement; toggle: HTMLButtonElement } {
    const toggle = switchControl(label, onCommit)
    toggle.setAttribute("aria-description", hint)
    const row = el("div", { class: "de-ann-setting" }, [hintedLabel(label, hint), toggle])
    return { row, toggle }
  }

  /*
   * A SWITCH IS LABELLED WITH WHAT IS TRUE WHEN IT IS ON.
   *
   * This was "Hide until reload", which inverts the contract of the control it
   * is on: a `role="switch"` reads out as "Hide until reload, on", and what
   * that state actually produces is markers you cannot see. The reader has to
   * negate the label in their head to know what the switch is doing, and the
   * negation is exactly the part people get wrong under time pressure.
   *
   * "Show markers" is the same setting stated forward, so ON means markers are
   * on the page — and it is already the product's own word for it: the eye
   * button in the strip above says "Show markers"/"Hide markers" off the same
   * flag. Two surfaces onto one setting now agree about which direction is
   * which.
   *
   * The FLAG does not move. `hideUntilRestart` is persisted, filtered on read,
   * and reasoned about in four files (`annotations/store.ts` most of all);
   * renaming it to chase the label would be a migration in exchange for
   * nothing. The inversion lives here, at the one seam where a word becomes a
   * boolean, and at the one read in `syncSettings`.
   *
   * "Reload", not "restart", survives in the hint for its original reason:
   * restart has three referents on a dev machine — the browser, the dev server,
   * the editor — and only one of them brings the markers back. A designer who
   * reads "restart" and bounces their dev server has spent a minute on
   * something Cmd+R does, with the setting looking broken meanwhile.
   */
  const SHOW_PINS_HINT = "Off hides pins until you reload."
  /* The per-level detail still rides on each option's `title`; this one names
     the setting, and is also the menu's description for a screen reader. */
  const BRIEF_DETAIL_HINT = "How much the brief tells your agent about each note and edit."
  formatControl.setAttribute("aria-description", BRIEF_DETAIL_HINT)
  const hideMarkers = switchControl("Show pins", (value) =>
    updateSettings({ hideUntilRestart: !value })
  )
  hideMarkers.setAttribute("aria-description", SHOW_PINS_HINT)
  const clearOnCopy = switchRow(
    "Clear on copy or send",
    // The label already says when. The hint owes the two facts it does not:
    // that the edits go too, and that a refused clipboard keeps the list.
    "Clears edits too, once the copy or send succeeds.",
    (value) => updateSettings({ clearOnCopy: value })
  )
  const blockInteractions = switchRow(
    "Block page interactions",
    "Turn off to use the app, for example to open a menu you want to note.",
    (value) => updateSettings({ blockPageInteractions: value })
  )
  /*
   * "Annotate the editor itself" STOOD HERE, and the switch is gone.
   *
   * It was the one setting in the fold that took away the gesture you would
   * undo it with: once the editor is annotatable, a click on that row files a
   * note about the row, and the only way back out is a keyboard shortcut the
   * switch itself had to teach you. A control whose own hint has to name an
   * escape hatch is a control that can strand the person who pressed it, and
   * the surface it unlocked — notes filed against the editor's own panels — is
   * one this product's designers do not need in the middle of annotating an
   * app.
   *
   * `AnnotationSettings.scope` survives, because `annotations/canvas.ts` asks
   * it one question in three places and the answer is now always `"app"`. It
   * is reachable from the console and from the tests, and no longer from here.
   * `annotations/store.ts` forces it back to `"app"` on load for the reason
   * written there: with no row to flip, a persisted `"editor"` would be
   * permanent.
   */

  /*
   * CONNECTING AN AGENT, in the one place a designer will look for it.
   *
   * The setup has always been a single fact — one URL, pasted into a coding
   * agent's config — and it was nonetheless the hardest thing in the product to
   * do, because that URL was printed once, at startup, into a terminal most
   * designers never open. Miss it and there is no way back: the port is not
   * shown anywhere in the editor, and the browser cannot probe it (`mcp.mjs`
   * refuses a non-JSON content type on purpose, so that a page cannot reach the
   * tool surface). A designer who missed one line of console output had no
   * route to the feature at all.
   *
   * So: the address, a button that copies it, and a live answer to the only
   * question that follows — did it work. Three things, no configuration, no
   * vocabulary. Nothing here can be edited, because there is nothing here a
   * designer should have to choose: the port is fixed precisely so this string
   * stays the same across restarts and can be typed into a config file once.
   */
  const mcpAddress = el("code", { class: "de-mcp-url" }, ["checking…"])
  /*
   * The status, as a mark in the MCP section header rather than a sentence
   * under the address. The sentence survives as its name and tooltip; the
   * mark's SHAPE carries the state as well as its colour — filled when an
   * agent is attached, a ring while waiting for one, dashed when the port is
   * down — so the state is not left to colour alone.
   */
  const mcpState = el("span", {
    class: "de-mcp-state",
    role: "img",
    "data-de-state": "checking",
    "aria-label": "MCP: checking",
    title: "Checking…",
  })

  function setMcpState(state: "on" | "idle" | "off", sentence: string): void {
    mcpState.dataset.deState = state
    mcpState.setAttribute("aria-label", `MCP: ${sentence}`)
    mcpState.title = sentence
  }

  /*
   * The SAME Copy, because it is the same panel.
   *
   * This button and the outbox's Copy are two pills reading "Copy" in one
   * 260px column, and they used to disagree about how big a copy mark is and
   * about how a copy announces itself — one at `control` answering in a toast,
   * one at `row` answering on itself. Nobody decided that; it is what happens
   * when a second instance of a control is written at a different time. The
   * mark and the confirmation are the control's, not the call site's.
   */
  const mcpMark = swapMark("Copy")
  let mcpCopiedTimer = 0

  function showMcpCopied(): void {
    mcpMark.show(true)
    if (mcpCopiedTimer) clearTimeout(mcpCopiedTimer)
    mcpCopiedTimer = setTimeout(() => {
      mcpCopiedTimer = 0
      mcpMark.show(false)
    }, COPIED_FOR) as unknown as number
  }

  function undoMcpCopied(): void {
    if (mcpCopiedTimer) clearTimeout(mcpCopiedTimer)
    mcpCopiedTimer = 0
    mcpMark.show(false)
  }

  const mcpCopy = el(
    "button",
    {
      class: "de-button",
      type: "button",
      title: "Copy MCP address",
      onclick: () => {
        const url = mcpAddress.textContent ?? ""
        if (!url.startsWith("http")) {
          editor.toast("The MCP server is not running", "error")
          return
        }
        // Synchronous inside the click task, before any await: the clipboard
        // only works under the transient activation the click carries. Same
        // shape as Copy: the tick answers the press, the toast the result.
        void copyText(url).then((copied) => {
          if (!copied) {
            undoMcpCopied()
            editor.toast(COPY_REFUSED, "error")
            return
          }
          editor.toast({ title: "Copied the MCP address", description: "Paste it into your agent’s MCP settings." })
        })
        showMcpCopied()
      },
    },
    [mcpMark.node, "Copy"]
  )

  /*
   * STAY ON BETWEEN APPS, optional and off by default.
   *
   * The editor serves MCP itself, so switching or restarting apps shuts the
   * port for a few seconds, and some agents drop the server's tools after one
   * failed call. On, the start screen serves the same address and keeps it up
   * while editors come and go. The row exists only when a start screen is
   * behind this editor: anywhere else the switch could do nothing.
   *
   * The same row as every setting below it, in the section it governs — no
   * heading, no sentence under it. The hint rides on the label's hover.
   */
  const STAY_HINT = "Your agent stays connected when you switch or restart apps."
  let staySwitching = false
  const stay = switchRow("Stay on between apps", STAY_HINT, (value) => void setStay(value))
  stay.row.hidden = true

  /**
   * Flips at once and settles on the server's answer. The switch is held while
   * the endpoint moves, so a second press cannot start a second move.
   */
  async function setStay(on: boolean): Promise<void> {
    if (staySwitching) return
    staySwitching = true
    stay.toggle.setAttribute("aria-checked", String(on))
    stay.toggle.disabled = true
    try {
      const response = await fetch(`${editor.apiBase}/mcp/stay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      })
      const payload = (await response.json().catch(() => null)) as { message?: string } | null
      if (!response.ok) throw new Error(payload?.message ?? "The editor didn’t answer.")
    } catch (error) {
      stay.toggle.setAttribute("aria-checked", String(!on))
      editor.toast(
        {
          title: on ? "Couldn’t keep MCP on between apps" : "MCP is still on between apps",
          description: error instanceof Error ? error.message : String(error),
        },
        "error"
      )
    } finally {
      staySwitching = false
      stay.toggle.disabled = false
      void refreshMcp()
    }
  }

  /**
   * Ask the server where it is and whether anybody arrived.
   *
   * Polled rather than pushed, and slowly. The fact changes at human speed — an
   * agent is attached when somebody edits a config file and restarts a tool —
   * and the panel is usually not even on screen. A socket for this would be
   * more machinery than the question deserves.
   *
   * Three states, and the middle one is why `connected` and `waiting` are both
   * reported. An agent that is attached but busy is a WORKING setup; showing it
   * as disconnected the moment it went off to do the work it was just handed is
   * how a correct configuration comes to look broken.
   */
  async function refreshMcp(): Promise<void> {
    try {
      const response = await fetch(`${editor.apiBase}/mcp/status`)
      if (!response.ok) throw new Error("status")
      const status = (await response.json()) as {
        url: string | null
        listening: boolean
        agents: number
        waiting: number
        stay?: boolean
        canStay?: boolean
      }
      mcpAddress.textContent = status.url ?? "not running"
      stay.row.hidden = status.canStay !== true
      if (!staySwitching) stay.toggle.setAttribute("aria-checked", String(status.stay === true))

      /*
       * THREE FACTS, AND THEY FAIL INDEPENDENTLY.
       *
       * This block read one flag and got it wrong. `endpointListening` is set
       * by the launcher when OUR OWN port binds, so it is true from the moment
       * the editor starts — and the panel, reading it as "connected", told
       * every designer their agent was attached before they had configured one.
       * The status was decorative: it said the same thing forever.
       *
       * So the order below is the order the setup can fail in. Is our port up
       * at all? Then has anything completed a handshake? Then is it parked
       * waiting, or off doing the work it was handed? Each sentence is only
       * reachable when the one before it is true, which is what makes the line
       * worth reading rather than worth ignoring.
       */
      if (!status.url || !status.listening) {
        setMcpState("off", "Not running. Another editor may be using the port.")
      } else if (status.agents < 1) {
        setMcpState("idle", "No agent connected. Paste this address into your agent.")
      } else if (status.waiting > 0) {
        setMcpState("on", "Connected. Waiting for changes.")
      } else {
        // Attached but not parked in `wait_for_change`. A working setup, mid-turn
        // — and it must not read as a broken one, or a correct configuration
        // looks like a failure every time the agent goes off to do its job.
        setMcpState("on", "Connected. Your agent is working.")
      }
      // The first handshake is what makes "Send to agent" worth offering.
      if (!agentReady && status.url && status.listening && status.agents > 0) {
        agentReady = true
        paintPrimary()
      }
    } catch {
      // A dead route reads the same as a refusal, the bargain `ai/transport.ts`
      // makes too: say nothing confident rather than invent a state.
      setMcpState("off", "Could not reach the DesignLayer server.")
    }
  }

  /*
   * MCP IS ITS OWN SECTION, above Settings.
   *
   * It is an address and a status, not a setting anybody sets, so it no longer
   * sits in the Settings fold as a stacked row. "MCP", not "Your coding agent":
   * a designer told "your coding agent" is not working restarts their agent,
   * when what is actually down is this editor's MCP server.
   */
  const mcpBody = el("div", { class: "de-mcp" }, [
    // A field-and-action pair: Copy sits beside the address at its height, and
    // wraps under it only when the panel cannot fit the whole address.
    el("div", { class: "de-mcp-row" }, [mcpAddress, mcpCopy]),
    stay.row,
  ])

  settingsBody.append(
    /*
     * ONE group, everything a designer sets.
     *
     * There were three: Show markers on its own, Marker colour on its own, and
     * the three checkboxes under a rule. The rules between them were drawing a
     * distinction the controls used to make — switch versus checkbox, right
     * edge versus left — and the controls stopped making it. Four rows that
     * look the same and behave the same, separated by two hairlines, would be
     * the block claiming three kinds of setting and showing one.
     *
     * Brief detail leads the group. It sat above the list for a while, on the
     * argument that it should be near the thing it governs, but it is set once
     * per project and was costing the list a line and a caption on every visit.
     * Settings that used to live here and are gone, for the record:
     * the component-stack switch was deleted outright — the editor detects
     * React or Angular itself and reads the stack either way, so the row only
     * ever offered a worse brief. Marker colour went because the shipped blue
     * is legible everywhere the pin lands and nobody came to this fold to
     * change it; see the note at the top of this file.
     */
    el("div", { class: "de-ann-setting-group" }, [
      el("div", { class: "de-ann-setting de-ann-detail" }, [
        hintedLabel("Brief detail", BRIEF_DETAIL_HINT),
        formatSelect,
      ]),
      el("div", { class: "de-ann-setting" }, [
        // Stated forward to match the switch. The hint carries the half the
        // label cannot: that turning it off is scoped to this page load.
        hintedLabel("Show pins", SHOW_PINS_HINT),
        hideMarkers,
      ]),
      clearOnCopy.row,
      blockInteractions.row,
    ])
  )

  const settings = el("div", { class: "de-ann-settings" }, [settingsBody])

  function syncSettings(): void {
    const current = annotationSettings()
    // Both surfaces onto `hideUntilRestart`, off ONE read, in one place. Either
    // of them keeping its own copy is how a switch comes to say "off" over a
    // page with no markers on it.
    // Inverted at the read for the reason given where the switch is built: the
    // stored flag says "hidden" and the label says "shown", and this is the one
    // other place the two meet.
    hideMarkers.setAttribute("aria-checked", String(!current.hideUntilRestart))
    setGlyph(
      visibility,
      current.hideUntilRestart ? "EyeOff" : "Eye",
      // Verb and object, and no "on the page": a marker has nowhere else to be.
      // This button and the settings switch now share the phrase "Show markers"
      // on purpose — they are one setting, and the button names the action
      // while the switch names the state.
      current.hideUntilRestart ? "Show pins" : "Hide pins"
    )
    // `aria-checked` rather than `.checked`, for the same reason the switch
    // above reads it back on click: the attribute IS the state now, and the
    // stylesheet paints off it. Written as a string because that is what an
    // attribute holds — `String(false)` is "false", not the empty attribute a
    // boolean property would leave behind.
    clearOnCopy.toggle.setAttribute("aria-checked", String(current.clearOnCopy))
    blockInteractions.toggle.setAttribute("aria-checked", String(current.blockPageInteractions))

    /*
     * The chosen level, painted onto the menu rather than across four segments.
     *
     * The fallback is not defensive padding: a settings blob written by a build
     * that spelled the levels differently resolves to no match at all, and a
     * `<select>` handed a value none of its options carry goes BLANK — a
     * dropdown showing nothing, over a brief that is still being written at
     * some level. Falling back to the first option means the control always
     * names a real level, and the next write repairs the stored value.
     */
    const level = OUTPUT_DETAILS.some((entry) => entry.id === current.outputDetail)
      ? current.outputDetail
      : OUTPUT_DETAILS[0].id
    if (formatControl.value !== level) formatControl.value = level
  }

  /* ---------- the section ---------- */

  /*
   * What you can do with the list, directly under it: the two glyphs on the
   * left act on the list in place, the two labelled buttons on the right hand
   * it over. The bin sits at the opposite end from Send.
   */
  const ctas = el("div", { class: "de-ann-ctas" }, [
    el("span", { class: "de-ann-tools" }, [visibility, clearAll]),
    el("span", { class: "de-ann-actions" }, [primaryButton, copyButton]),
  ])

  /*
   * ONE SECTION, "Notes and edits": the list and nothing else. No tally — the
   * rows are the section and are never off screen. The sentence that said how
   * the list is sent rides on the title's hover, the way MCP's does, and the
   * detail menu lives in Settings.
   */
  const outboxSection = section(
    "Notes and edits",
    list,
    undefined,
    false,
    "Sent to your agent as one brief, in this order."
  )

  /*
   * The empty state is the TAB's, not the section's: a header over an empty
   * body would be the panel filing nothing under a name.
   */
  const empty = emptyState()

  /*
   * MCP and Settings are the two blocks ALWAYS in the column; MCP comes first,
   * so it anchors everything inserted above it.
   */
  const mcpSection = section(
    "MCP",
    mcpBody,
    mcpState,
    false,
    "Paste into your agent’s MCP settings. It stays the same across restarts."
  )
  const settingsSection = section("Settings", settings)

  const node = el("div", { class: "de-ann" }, [
    empty,
    outboxSection,
    /*
     * The handover buttons sit OUTSIDE the section so folding the list away
     * cannot hide the button that finishes the session.
     */
    ctas,
    mcpSection,
    settingsSection,
  ])

  /**
   * A row lights its pin, and a pin lights its row, through one pair of calls.
   *
   * The class and the event are set together and never apart. Leaving the row's
   * own highlight to CSS `:hover` would be a second, independent answer to "is
   * the pointer on this row" — and the day the event fails to send, the panel
   * would still light up and the page would not, which reads as the marker
   * being broken rather than the seam.
   *
   * Focus drives the same pair as the pointer, for the reason the trailing
   * actions are revealed on `:focus-within`: a keyboard user arriving at a row
   * is standing on it just as much as a pointer is, and a highlight they can
   * never trigger is a feature that does not exist for them.
   */
  function trackHover(row: HTMLElement, id: string): HTMLElement {
    row.setAttribute(ITEM_ID, id)
    const enter = (): void => {
      row.classList.add("de-ann-item--hover")
      announceHover(id)
    }
    const leave = (): void => {
      row.classList.remove("de-ann-item--hover")
      announceHover(null)
    }
    row.addEventListener("mouseenter", enter)
    row.addEventListener("mouseleave", leave)
    row.addEventListener("focusin", enter)
    row.addEventListener("focusout", (event) => {
      // `focusout` fires on every hop between this row's own buttons. Tabbing
      // from edit to delete would otherwise report the row left and re-entered,
      // and the pin would blink once per key.
      if (row.contains((event as FocusEvent).relatedTarget as Node | null)) return
      leave()
    })
    return row
  }

  /**
   * One note, as a row you can act on without acting on the rest.
   *
   * TWO ACTIONS, WHERE THERE WERE THREE. The tick is gone.
   *
   * Resolving was a toggle beside a delete, and the pair was defended on the
   * grounds that they are different — resolve keeps the note in the session's
   * history, delete takes the only copy with it. That distinction is real in
   * the data and turned out not to be real to the person using the panel: both
   * controls take a dealt-with note off the list, they sit 2px apart under
   * near-identical 18px buttons, and the difference only exists if you go
   * looking for a resolved note later, which this panel gives you no way to do.
   * One of the two was therefore a 33% wider action column and a coin toss.
   *
   * The status field went with it. For a while it survived as read-only
   * machinery — set by nothing, still filtered on in four places — and that is
   * a worse state than either having the feature or not: a reader cannot tell
   * from the code that "resolved" is unreachable. Deleting a note is now the
   * only way to take it off this list, which is what the tick's removal always
   * meant.
   */
  function noteRow(note: AnnotationRecord, index: number): HTMLElement {
    const subject = noteSubject(note)

    /*
     * A bin rather than a cross, which the edit row keeps.
     *
     * The two rows do different things under the same-shaped button: dropping
     * an edit retracts it from the handover and leaves the change standing,
     * deleting a note destroys the note. Giving the destructive one a different
     * drawing is the cheapest way to say that before the label is read — the
     * same bin the layers tree deletes with.
     *
     * No confirm, unlike the footer's clear-all: one row is one mistake, and a
     * control you use on most rows in a session cannot ask twice every time.
     * The recovery is an UNDO instead — see `erase` below.
     */
    const remove = el(
      "button",
      {
        class: "de-mini de-mini--danger",
        type: "button",
        "data-de-tip": DELETE_NOTE,
        "aria-label": DELETE_NOTE,
        /*
         * The row closes first, and the store is written once it has: the
         * delete rebuilds this whole list through its subscription, and doing
         * both at once would race the rebuild against the row's departure.
         */
        onclick: (event: Event) => {
          const row = (event.currentTarget as HTMLElement).closest(".de-ann-item")
          const closing = row instanceof HTMLElement ? leaveRow(row) : null
          // Synchronous where the row cannot close — see `leaveRow`. A delete
          // does not become async because a panel happens to be paintable.
          if (closing) void closing.then(erase)
          else erase()
        },
      },
      [icon("Trash", tokens.icon.marker)]
    )

    /*
     * THE DELETE, AND THE WAY BACK FROM IT.
     *
     * One click, and a step on the editor's one undo timeline: Cmd+Z brings the
     * note back, and so does the card's Undo, which is the same step
     * (`undoNoteStep`), so the two cannot disagree.
     *
     * The card names WHICH note, because by the time it appears the row is
     * gone. Nothing is raised if the store had already dropped it — a second
     * press during the row's departure, or a clear-all landing first.
     */
    function erase(): void {
      const removed = deleteNote(note.id)
      if (!removed) return
      editor.toast(`Deleted the note on ${noteSubject(removed.note)}`, "info", {
        label: "Undo",
        onClick: () => undoNoteStep(removed.step),
      })
    }

    /*
     * Rewriting a note happens where the note is, not in the row.
     *
     * The composer already exists on the canvas, anchored to the thing the note
     * is about — so this asks for it back rather than growing a second editor
     * in a 260px panel that could not show the reader what they were writing
     * about. `EDIT_EVENT` is the whole of how it asks: the panel names the
     * note, the canvas decides what reopening looks like.
     *
     * A PENCIL, where this drew the text mark. `Type` was chosen because the
     * set had no pencil and it was the closest thing to "the words" available —
     * but a `T` is what every other toolbar puts on "insert text" or "text
     * style", so the button read as a formatting control for the note rather
     * than as a way back into writing it. The set has a pencil now.
     */
    const edit = el(
      "button",
      {
        class: "de-mini",
        type: "button",
        "data-de-tip": EDIT_NOTE,
        "aria-label": EDIT_NOTE,
        onclick: () =>
          window.dispatchEvent(new CustomEvent(EDIT_EVENT, { detail: { id: note.id } })),
      },
      [icon("Pencil", tokens.icon.marker)]
    )
    return trackHover(
      el("div", { class: "de-ann-item de-ann-item--note" }, [
        /*
         * No "Note" chip: the row carries a numbered disc matching its pin, and
         * its line is a sentence somebody typed. An edit row still badges,
         * because which of three things is true of an edit is the fact its row
         * exists to tell.
         */
        el("div", { class: "de-ann-item-head" }, [
          el("span", { class: "de-ann-index" }, [String(index)]),
        ]),
        /*
         * ONE LINE: what the designer wrote, and nothing under it.
         *
         * The second line was the filing note — "OverviewComponent ·
         * overview.html:24", or the quoted run of text for a text note. It is
         * the tool's own bookkeeping, and it was printed on every row of a
         * 260px column, so half the ink in the list went to strings the reader
         * did not write and cannot act on. The pin on the canvas already says
         * where a note is; the number on the row ties the two together.
         *
         * It is not deleted, it is demoted to the row's tooltip, which is where
         * the rest of this panel keeps a long form of a short line. The brief
         * still carries the selector, the component and the file — that is the
         * copy an agent reads, and it was never this line.
         */
        el("div", { class: "de-ann-item-body" }, [
          el("div", { class: "de-ann-item-line", title: `${note.comment}\n${subject}` }, [
            note.comment,
          ]),
        ]),
        el("div", { class: "de-ann-item-actions" }, [edit, remove]),
      ]),
      note.id
    )
  }

  /**
   * THREE STATES, WHERE THERE USED TO BE TWO.
   *
   * "Preview only" covered two completely different situations and a designer
   * had no way to tell them apart: a change that WILL be written the moment
   * they press the button, and a change that never can be because the writer
   * has no way to spell it. Both said "live in this page only", both looked
   * like the same problem, and only one of them was one.
   *
   * The split is the ledger. `change-prompt.ts` holds exactly the changes Apply
   * cannot write — an icon swap, a drag's `transform`, a class list whose file
   * never resolved — so an unwritten edit that appears there needs a person or
   * an agent, and an unwritten edit that does not is simply queued.
   *
   * Matched on the same `(tagName, className, property)` triple that
   * `markEditRefused` uses to demote a row when the server refuses a write. One
   * identity for "these two records are about the same edit", used in both
   * directions, is what keeps the badge and the refusal path from disagreeing.
   */
  function stateOf(edit: EditRecord): { label: string; title: string; kind: string } {
    // Asked FIRST, because a queued edit is also a written one: the writer sets
    // `written` the moment it knows it can spell the change, and only the
    // commit clears `queued`. Reading them the other way round is what had
    // every fresh padding tweak claiming to be in a file already.
    if (isEditQueued(edit.id)) {
      return {
        label: "Ready",
        title: "Apply to code will write this.",
        kind: "ready",
      }
    }
    if (edit.written) {
      return {
        label: "In your files",
        title: "Already in your files. Do not apply again.",
        kind: "written",
      }
    }
    const unwritable = previewOnlyChanges().some(
      (change: PreviewOnlyChange) =>
        change.property === edit.property &&
        change.tagName === (edit.target?.tagName ?? "") &&
        change.className === (edit.target?.className ?? "")
    )
    // Not queued and not written. Either the ledger already knows why (an icon
    // swap, a `transform`, a file that never resolved), or a commit refused it
    // and `markEditRefused` took the claim back. Both are the agent’s.
    return unwritable
      ? {
          label: "Needs the agent",
          title:
            "Apply to code cannot write this. It goes to your agent.",
          kind: "agent",
        }
      : {
          label: "Needs the agent",
          title: "Apply to code failed on this. It goes to your agent.",
          kind: "agent",
        }
  }

  /**
   * One edit the designer made, and what still has to happen to it.
   *
   * State is stated three ways on purpose — a class the stylesheet can tint, a
   * badge with words in it, and the sentence behind that badge — because it is
   * the fact that decides what happens to the row next, and a tint alone is a
   * fact nobody can read out loud.
   */
  function editRow(edit: EditRecord, index: number): HTMLElement {
    const label = editLabel(edit.property)
    // The empty side is spelled rather than dropped: a blank where a value goes
    // reads as a rendering bug, and "unset" is the actual claim.
    const change = `${label}: ${edit.from || "unset"} → ${edit.to || "unset"}`
    const where = whereOf(edit.target)
    const state = stateOf(edit)
    // Asked for every edit row; answered for the few whose component the server
    // finds in more than one place. The first call per component starts a
    // lookup and returns nothing, and the subscription below repaints when it
    // lands — a render cannot wait on a project walk.
    const shared = sharedComponentWarning(edit.target?.componentName ?? "")

    const remove = el(
      "button",
      {
        class: "de-mini de-mini--danger",
        type: "button",
        "data-de-tip": DROP_EDIT,
        "aria-label": DROP_EDIT,
        /*
         * ANY ROW, IN ANY ORDER — and this is why that is safe.
         *
         * Undo is a timeline and has to be walked backwards, because steps
         * compose. This is not undo. A row is one (element, property), and the
         * journal collapses every repeat of that pair onto the same row, so no
         * two rows can describe the same property of the same element. Rows are
         * independent by construction and the third of seven can go without
         * disturbing the other six.
         *
         * The same rule is what lets the preview revert: restoring this row's
         * "from" would be reckless if a later row could have written the same
         * property afterwards, and collapse guarantees none did.
         */
        onclick: () => {
          const result = withdrawEdit(editor.bridge, edit.id)
          /*
           * Only spoken about when it FAILED, which is the one case the list
           * cannot show on its own.
           *
           * A successful withdrawal explains itself: the row disappears and the
           * pixels go back. A withdrawal that could not reach the queue leaves
           * a page that reverted and a file that will still be written, and
           * nothing on screen says so — that is worth a sentence, and it is the
           * honest one rather than a generic failure.
           */
          if (!result.queueCleared && isEditQueued(edit.id)) {
            editor.toast(
              { title: "Still queued", description: "Removed from the list, but Apply to code will still write it." },
              "error"
            )
          }
        },
      },
      [icon("X", tokens.icon.marker)]
    )

    /*
     * Delete alone, and the missing edit button is not an oversight.
     *
     * A note row's edit reopens the composer the note was written in. An edit
     * row has no composer — it is a record of something the inspector already
     * did to the page, and the way to change it is to change the element again,
     * which writes a new row. A button that opened nothing would be the panel
     * offering a door into a room that was never built.
     */
    return trackHover(
      el(
        "div",
        { class: `de-ann-item de-ann-item--edit${edit.written ? " de-ann-item--written" : ""}` },
        [
          /*
           * Same cut as the note row above: the "Edit" chip said what the mono
           * `opacity: 1 → 0.55` beneath it already said. The state chip stays,
           * because whether a change reached the file is the one fact on this
           * row an agent acts on differently and nothing else here reports it.
           */
          el("div", { class: "de-ann-item-head" }, [
            el("span", { class: "de-ann-index" }, [String(index)]),
            el("span", { class: "de-ann-badge", "data-de-state": state.kind, title: state.title }, [
              state.label,
            ]),
          ]),
          el("div", { class: "de-ann-item-body" }, [
            /*
             * The element this changed rides in the TOOLTIP, for the reason the
             * note row's second line went: one row, one line. The difference
             * here is that an edit's line is a property and two values, which
             * does not name the thing it happened to — so the tooltip is doing
             * real work rather than storing a duplicate, and the badge below
             * stays because it reports the one fact that decides what happens
             * to this row next.
             */
            el("div", { class: "de-ann-item-line", title: `${change}\n${where}` }, [change]),
            /*
             * THE BLAST RADIUS, said before the write rather than discovered
             * after it.
             *
             * Only for a component the server found in more than one place, so
             * the ordinary row stays silent — a caution on every row is
             * wallpaper, and wallpaper does not get read. This is the one fact
             * about an edit that the preview cannot show: the page in front of
             * the designer looks identical whether this button is used once or
             * forty times.
             *
             * It is a line in the row and not a dialog. The write has not
             * happened yet — the button that performs it is under the list —
             * so there is nothing to interrupt, only something to know before
             * pressing it.
             */
            shared ? el("div", { class: "de-ann-item-shared" }, [shared]) : null,
          ]),
          el("div", { class: "de-ann-item-actions" }, [remove]),
        ]
      ),
      // The canvas paints a pin for an edit too, so hovering the row lights it.
      edit.id
    )
  }

  function emptyState(): HTMLElement {
    return el("div", { class: "de-empty de-ann-empty" }, [
      el("span", { "aria-hidden": "true" }, [icon("MessageSquare", tokens.icon.feature)]),
      el("div", {}, [EMPTY_DETAIL]),
    ])
  }


  function render(): void {
    /*
     * The outbox repaints on four stores, and two of them fire while the reader
     * is looking at a row halfway down it — a note deleted from its own row, an
     * edit landing from a scrub on the canvas. The list is emptied and refilled
     * below, and an emptied scroller is clamped to the top by the next layout,
     * so without this the list jumps under the hand working in it.
     * `core/scroll.ts` carries the mechanism.
     */
    const hold = holdScroll(node)
    clear(list)
    const items = outboxItems()
    const filled = items.length > 0

    copyButton.disabled = !filled
    paintPrimary()

    // Notes only, because clear-all is notes only.
    noteCount = items.reduce((total, item) => total + (item.type === "note" ? 1 : 0), 0)
    // An armed bin over a list whose last note just went would sit waiting to
    // delete nothing. The arm goes with the notes it was counting.
    if (!noteCount) disarm()
    paintClear()

    syncSettings()
    refreshMcpSoon()

    /*
     * ONE RUN OF NUMBERS, in the order things happened. The number is the
     * item's position in `outboxItems()`, so the row, the pin on the canvas and
     * the brief all call it the same thing.
     */
    const numbers = outboxNumbers(items)
    list.append(
      ...items.map((item, index) =>
        item.type === "note"
          ? noteRow(item.note, numbers.get(item.note.id) ?? index + 1)
          : editRow(item.edit, numbers.get(item.edit.id) ?? index + 1)
      )
    )

    /*
     * WHAT IS ON SCREEN. The section and the buttons appear when the outbox
     * holds anything OR a write is still owed: a deletion queues a source
     * operation without leaving a row, and a designer who deleted a card and
     * saw no section and no button would think the delete had not registered.
     * Otherwise the tab's own empty state takes the column.
     *
     * A block with nothing to say LEAVES THE DOCUMENT rather than hiding, and
     * is detached rather than rebuilt, so the detail menu and the buttons keep
     * their listeners and whoever's focus was on them. Placed bottom-up,
     * because each block goes in before a sibling already in the column.
     */
    const shown = filled || committer.hasPendingChanges()
    place(ctas, shown, mcpSection)
    place(outboxSection, shown, inColumn(ctas) ? ctas : mcpSection)
    place(empty, !shown, node.firstChild)
    // Last: the release measures the rebuilt column.
    hold.release()
  }

  /**
   * Is this block in the column right now — asked of THIS parent, not of the
   * document.
   *
   * `isConnected` is the obvious call and it is the wrong question. It means
   * "reachable from a Document", so it is false for every block here whenever
   * the tab itself is off the document — which is most of the tab's life in
   * the test host, and any moment the inspector is holding a pane it has not
   * mounted. Every block then reported itself absent, `place` re-inserted one
   * that was already there, and an insert of a node that already has this
   * parent is a MOVE: the column quietly reordered itself, which is how the
   * buttons ended up above the section they belong under.
   *
   * The question this file actually asks is about membership of one parent, so
   * that is what it asks.
   */
  function inColumn(block: HTMLElement): boolean {
    return block.parentNode === node
  }

  /** In the column at `before`, or out of it entirely. */
  function place(block: HTMLElement, wanted: boolean, before: Node | null): void {
    if (!wanted) {
      block.remove()
      return
    }
    if (!inColumn(block)) node.insertBefore(block, before)
  }

  /*
   * Three stores, one list. Nothing unsubscribes: the inspector builds its tabs
   * once and holds them for the life of the editor, so a disposer kept here
   * would be a function with no caller. Every mutation above therefore leaves
   * the repaint to the store — calling `render()` as well would draw twice for
   * one click.
   *
   * Skipped while this tab is not the one showing. The journal announces once
   * per property of every edit, so with the Design tab up each scrub and nudge
   * was rebuilding this whole list out of sight. The tab host calls `update`
   * when the tab is shown again, and that render reads everything afresh, so
   * nothing is owed.
   */
  const repaint = (): void => {
    for (let step: HTMLElement | null = node; step; step = step.parentElement) {
      if (step.hidden) return
    }
    render()
  }
  onAnnotationsChange(repaint)
  onEditsChange(repaint)
  onSettingsChange(repaint)
  // A usage answer arriving is the only thing that can add a warning line to a
  // row that is already on screen; nothing else in the tab knows it happened.
  onComponentUsageChange(repaint)

  /*
   * The agent's arrival is the one thing on this tab nothing else can notice.
   *
   * Every other row here moves because the designer did something. An agent
   * attaching happens in another process, so the panel has to go and look.
   *
   * It looks on RENDER, throttled, and not on a timer. A timer was the obvious
   * build and it was wrong twice: it keeps a jsdom test process alive forever —
   * the suite hung for four hundred seconds before this was traced back here —
   * and in the product it polls a loopback route all day on behalf of a panel
   * nobody is looking at. Render already fires on everything that brings a
   * designer near this block, and the throttle keeps a number scrub from
   * turning into a request per frame.
   */
  const MCP_POLL_MS = 5_000
  let mcpCheckedAt = 0
  function refreshMcpSoon(): void {
    const now = Date.now()
    if (now - mcpCheckedAt < MCP_POLL_MS) return
    mcpCheckedAt = now
    void refreshMcp()
  }
  refreshMcpSoon()
  /*
   * The ledger is NOT subscribed to here, and the badge still tracks it.
   *
   * A stranded write moves a row from "Ready" to "Needs the agent" without the
   * journal changing at all, so this list does have to be rebuilt when the
   * ledger moves — but the tab host already does it, gated on this being the
   * visible tab (`onPreviewOnlyChange` in `./index.ts`). Subscribing again here
   * would repaint a pane nobody is looking at on every stranded write, which is
   * the hot-path cost the tab host exists to avoid, and `inspector-tabs-cases`
   * fails on exactly that.
   */

  /*
   * The other direction: the pointer is on a PIN, so light its row.
   *
   * Read off the DOM rather than kept in a variable, because the rows are
   * rebuilt on every store write and a held reference would point at a node
   * that left the panel three repaints ago. The class is cleared from every row
   * first, so a mirror event that names a note the list no longer holds — a
   * note deleted while the pointer sat on its pin — leaves nothing lit.
   *
   * Nothing is dispatched back. Answering the canvas with `HOVER_EVENT` would
   * be the two surfaces telling each other the same fact forever.
   */
  window.addEventListener(MARKER_HOVER_EVENT, (event) => {
    const id = (event as CustomEvent<{ id?: string | null }>).detail?.id ?? null
    for (const row of node.querySelectorAll(".de-ann-item")) {
      row.classList.toggle("de-ann-item--hover", id !== null && row.getAttribute(ITEM_ID) === id)
    }
  })

  return { node, update: render }
}
