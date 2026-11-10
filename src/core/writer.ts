/**
 * The one path from "user changed something in the UI" to "the app shows it
 * and the agent is told".
 *
 * Every edit previews on the page and becomes a journal entry
 * (`annotations/journal.ts`) on the same undo step, so what the designer sees
 * and the note an agent is handed can never disagree. Nothing here writes
 * source: "Send to agent" hands the notes over and the agent makes the change
 * in code. So the host does not matter either — a React and an Angular page
 * preview the same inline styles, classes, text and attributes.
 */

import { dropLastEdit, recordEdit } from "../annotations/journal"
import { DELETED_ATTRIBUTE } from "./dom"
import { record, type HistoryStep } from "./history"
import { iconAttribute, type IconVariant } from "./icon-set"
import { drawHostIcon } from "./icons"
import { isLocked } from "./store"
import type { LayerElement, Selection } from "./types"

export interface StyleWrite {
  /** CSS property in kebab-case, e.g. `padding-left`. */
  property: string
  value: string
}

export interface ClassWrite {
  remove: string[]
  add: string[]
}

/** One element's share of a batched style write. */
export interface StyleBatchEdit {
  selection: Selection
  writes: StyleWrite[]
}

export interface Writer {
  /** Previews inline styles now and journals the change. */
  applyStyles(selection: Selection, writes: StyleWrite[], summary: string): void
  /**
   * The same write across several elements as ONE edit.
   *
   * Looping `applyStyles` would be the obvious way to align five selected
   * boxes, and it is wrong in three separate places at once: five history
   * steps, so Cmd+Z takes back a fifth of what the user did; five toasts for
   * one click; and five outbox rows that an agent reads as five decisions
   * rather than one. Handed the whole set, this reads every "before" while all
   * of them are still untouched, then records one step whose undo and redo
   * replay the batch — the same shape `applyDelete` uses, and for the same
   * reason.
   */
  applyStylesBatch(edits: StyleBatchEdit[], summary: string): void
  /** Swaps classes on the element now and journals the class list it ends on. */
  applyClasses(selection: Selection, write: ClassWrite, summary: string): void
  /** Replaces the element's text content. */
  applyText(selection: Selection, text: string): void
  /**
   * Journals a text edit the page already shows: the engine's double-click
   * editor typed it, so this only makes it a note and an undo step.
   */
  recordText(
    selection: Selection,
    before: { text: string; html: string },
    after: { text: string; html: string }
  ): void
  /**
   * Notes a move among the element's siblings. Nothing moves on the page: the
   * agent reorders the source. `move` is `front`, `forward`, `backward`,
   * `back`, or `before:<sibling name>`.
   */
  noteReorder(selection: Selection, move: string): void
  /** Redraws a selected `<svg>` as another variant from the host's icon set. */
  applyIcon(selection: Selection, variant: IconVariant): void
  /**
   * Sets one DOM attribute as a preview, and journals it for an agent. `null`
   * removes it. See `panels/inspector/section-instance.ts` for the evidence
   * gate that decides which props get a control at all.
   *
   * `class` and `style` are refused. Both have writes of their own above, and
   * the journal describes them better there: a class list it can diff, a
   * declaration it can name.
   *
   * `target` is the element to write ON, and it defaults to the selected one.
   * It exists because a component's inputs are not necessarily on the node the
   * user clicked: an Angular component renders a template, the click usually
   * lands on something INSIDE it, and `variant="filled"` is on the host tag
   * further up. The selection still describes what was picked, so the two are passed
   * separately rather than the caller fabricating a `Selection` for an element
   * nobody selected.
   */
  applyAttribute(
    selection: Selection,
    name: string,
    value: string | null,
    target?: Element
  ): void
  /**
   * Deletes elements: off the page now (hidden and marked, so undo can bring
   * each back between its siblings), and a note for the agent. Takes the whole selection rather than one entry, because what has to be
   * captured before the first removal — where each element sat, and which
   * sibling it was — is only true while every one of them is still in place.
   */
  applyDelete(selections: Selection[]): void
}

/**
 * What undo has to put back.
 *
 * The computed value when nothing is set inline, not the empty string, so the
 * journal's `from` names a value an agent can read ("was 16px") and undo
 * re-asserts what was on screen, which is visually identical.
 */
function currentValue(element: LayerElement, property: string): string {
  return (
    element.style.getPropertyValue(property) ||
    getComputedStyle(element).getPropertyValue(property)
  )
}

/**
 * The attributes `drawHostIcon` decides, and therefore the ones a swap owns.
 *
 * `width`, `height` and `class` are deliberately absent: the size and the
 * colour of an icon belong to the call site that placed it, and a variant swap
 * that resized the glyph would be answering a question the user did not ask.
 */
const ICON_ROOT_ATTRIBUTES = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]

/** Enough of an `<svg>` to put a swap back exactly as it was. */
interface IconState {
  name: string | null
  markup: string
  root: Array<[string, string | null]>
}

function readIconState(element: SVGSVGElement, attribute: string): IconState {
  return {
    name: element.getAttribute(attribute),
    markup: element.innerHTML,
    root: ICON_ROOT_ATTRIBUTES.map((name) => [name, element.getAttribute(name)]),
  }
}

function iconStateOf(variant: IconVariant): IconState {
  const drawn = drawHostIcon(variant)
  return {
    name: variant.name,
    markup: drawn.innerHTML,
    root: ICON_ROOT_ATTRIBUTES.map((name) => [name, drawn.getAttribute(name)]),
  }
}

/* -------------------------------------------------------------------------
 * Deleting
 * ---------------------------------------------------------------------- */

/** An element marked deleted, and everything needed to bring it back. */
interface Removal {
  element: LayerElement
  label: string
  /** The inline `display` to put back — usually none, but the eye may have set one. */
  display: string
  displayPriority: string
}

/**
 * What a delete actually removes.
 *
 * Two rules, both of them Figma's. A locked layer is not deleted, by any route —
 * the tree can still select one, because that is the only way back out of the
 * lock, so the tree is also the one place a locked layer could be deleted from
 * if this gate sat on the canvas instead of here. And a selection that contains
 * one of its own ancestors deletes the ancestor and nothing else: the descendant
 * is going anyway, and a second row for it would tell the agent to delete
 * something already inside a deletion.
 *
 * Document order is not needed for undo — nothing is detached, so no sibling
 * reference can go stale — but it is what the toast counts and the order the
 * notes are listed in, and a list that matches the page reads better than the
 * order the user happened to click in.
 */
function planRemovals(selections: Selection[], name: (element: LayerElement) => string): Removal[] {
  const elements = selections.map((entry) => entry.element)
  const roots = selections.filter((entry) => {
    const element = entry.element
    if (!element.isConnected || !element.parentElement) return false
    if (isLocked(element)) return false
    return !elements.some((other) => other !== element && other.contains(element))
  })

  const seen = new Set<LayerElement>()
  const unique = roots.filter((entry) => {
    if (seen.has(entry.element)) return false
    seen.add(entry.element)
    return true
  })

  unique.sort((a, b) => {
    const relation = a.element.compareDocumentPosition(b.element)
    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })

  return unique.map((selection) => ({
    element: selection.element,
    label: name(selection.element),
    display: selection.element.style.getPropertyValue("display"),
    displayPriority: selection.element.style.getPropertyPriority("display"),
  }))
}

/**
 * A readable name for the toast and the history entry.
 *
 * The layers panel has a much better answer and this is not it — that one knows
 * about component boundaries. This one only has to be recognisable in a
 * sentence, and `<div class="card stat">` reads as `.card` there.
 */
function elementLabel(element: LayerElement): string {
  const tag = element.tagName.toLowerCase()
  const first = element.classList[0]
  return first ? `${tag}.${first}` : tag
}

/**
 * An attribute value as the journal spells it.
 *
 * Absent is empty, and present-but-empty — a native boolean such as
 * `disabled=""` — is "true". Spelled as "" too, switching a boolean on would
 * read as an edit from "" to "", which is no edit, and the note was dropped.
 */
function attributeWord(value: string | null): string {
  if (value === null) return ""
  return value === "" ? "true" : value
}

/** One edit as the annotation outbox remembers it. */
interface JournalEdit {
  property: string
  from: string
  to: string
  element: Element | null
}

/**
 * Pushes a step onto the timeline and the same edit into the outbox, and makes
 * undo take BOTH back.
 *
 * An undone edit left in the outbox is the worst thing this feature can do:
 * the panel would hand an agent a change the designer explicitly reversed, and
 * the agent would go and put it back. Cmd+Z has to mean the same thing to the
 * page and to the brief, so the journal entry is dropped by the step's own
 * undo and re-recorded by its redo — which keeps the outbox describing what is
 * on screen rather than everything that was ever typed.
 *
 * Only the PUBLIC write functions come through here. The private `writeStyles`
 * / `writeClasses` / `writeText` / `writeIcon` / `writeRemovals` that a replay
 * calls stay untouched, so "replaying does not re-record" remains the same
 * structural property `history.ts` relies on rather than a flag.
 *
 * Journaled before `record`: pushing the history step repaints the toolbar,
 * and the toolbar counts what is waiting to be handed over.
 */
function journalStep(step: HistoryStep, edits: JournalEdit[]): void {
  // Counted rather than assumed: an edit that ends on the value it started
  // from is not recorded, and dropping more than was recorded would eat the
  // previous step's entry.
  const journal = () => edits.filter((edit) => recordEdit(edit) !== null).length
  let recorded = journal()
  record({
    label: step.label,
    undo: () => {
      step.undo()
      for (let index = 0; index < recorded; index += 1) dropLastEdit()
    },
    redo: () => {
      step.redo()
      recorded = journal()
    },
  })
}

export function createWriter(): Writer {
  /**
   * Preview only, with no toast and no history entry of its own.
   *
   * Both directions of the timeline replay through here rather than through
   * `applyStyles`, so undoing a change neither announces itself twice nor
   * records an inverse of the inverse. The same split holds for every private
   * write below.
   */
  const writeStyles = (selection: Selection, writes: readonly StyleWrite[]): void => {
    for (const write of writes) selection.element.style.setProperty(write.property, write.value)
  }

  const writeClasses = (selection: Selection, write: ClassWrite): void => {
    for (const name of write.remove) selection.element.classList.remove(name)
    for (const name of write.add) selection.element.classList.add(name)
  }

  const writeText = (selection: Selection, text: string): void => {
    selection.element.textContent = text
  }

  /**
   * Gone from the page. No toast and no history entry.
   *
   * `!important` because the preview has to beat the element's own class, and a
   * card whose stylesheet says `display: flex` would otherwise stay on screen
   * looking deleted to the layers tree and present to the user.
   */
  const writeRemovals = (removals: Removal[]): void => {
    for (const removal of removals) {
      removal.element.setAttribute(DELETED_ATTRIBUTE, "")
      removal.element.style.setProperty("display", "none", "important")
    }
  }

  /**
   * Back on the page.
   *
   * The `display` it had before is restored rather than simply cleared: the eye
   * in the layers panel writes `display: none` as a real edit, so an element
   * that was hidden and then deleted has to come back hidden — clearing would
   * silently undo the other change too.
   */
  const undoRemovals = (removals: Removal[]): void => {
    for (const removal of removals) {
      removal.element.removeAttribute(DELETED_ATTRIBUTE)
      if (removal.display) {
        removal.element.style.setProperty("display", removal.display, removal.displayPriority)
      } else {
        removal.element.style.removeProperty("display")
      }
    }
  }

  /**
   * Both directions of an attribute write, with no toast and no history entry —
   * the same split every other write in here has, for the same reason.
   *
   * `null` removes rather than blanks, because the two are different states for
   * a native boolean: `disabled=""` is disabled and no `disabled` is not, while
   * `disabled="false"` is still disabled. An undo that blanked would put the
   * element back in a state it was never in.
   */
  // `Element` and not `LayerElement`: this only ever calls two methods every
  // element has, and the one caller that needs it can be aiming at a component
  // HOST tag — `<app-button>` — which is neither an `HTMLElement` the layers
  // tree would offer nor an `<svg>`. Narrowing the parameter to the tree's own
  // union would exclude exactly the node this exists to write.
  const writeAttribute = (element: Element, name: string, value: string | null): void => {
    if (value === null) element.removeAttribute(name)
    else element.setAttribute(name, value)
  }

  /**
   * Both directions of a swap, with no toast and no history entry — the same
   * split as `writeStyles`, for the same reason.
   *
   * A `null` in `root` means the variant does not set that attribute, so it is
   * removed rather than blanked: a stroke-drawn glyph swapped for a filled one
   * must lose `stroke-width`, not carry it as an empty string.
   */
  const writeIcon = (element: SVGSVGElement, attribute: string, state: IconState): void => {
    if (state.name === null) element.removeAttribute(attribute)
    else element.setAttribute(attribute, state.name)
    element.innerHTML = state.markup
    for (const [name, value] of state.root) {
      if (value === null) element.removeAttribute(name)
      else element.setAttribute(name, value)
    }
  }

  return {
    applyStyles(selection, writes, summary) {
      // Read before the write, or the "before" is the value we are about to set.
      const before = writes.map((write) => ({
        property: write.property,
        value: currentValue(selection.element, write.property),
      }))
      writeStyles(selection, writes)

      // A write that changed nothing is not a step. A numeric field commits on
      // both Enter and `change`, so one edit arrives here twice; recording the
      // second would make the first Cmd+Z a no-op — measured as exactly that
      // before this guard. Reading the "after" back through `currentValue`
      // rather than comparing to `write.value` keeps the two sides in the same
      // serialization: the browser rewrites `rgb(0,0,255)` as `rgb(0, 0, 255)`,
      // and a string compare against the input would call that a change.
      //
      // Filtered to the writes that moved for the same reason: a field
      // re-committing the value it was showing is not an edit, and the outbox
      // is read by an agent that would act on it.
      const moved = before.filter(
        (entry) => currentValue(selection.element, entry.property) !== entry.value
      )
      if (!moved.length) return
      // Silent: the edit is on screen, and direct manipulation does not
      // narrate itself (see "WHEN TO TOAST" in `core/toast.ts`).
      journalStep(
        {
          label: summary,
          undo: () => writeStyles(selection, before),
          redo: () => writeStyles(selection, writes),
        },
        moved.map((entry) => ({
          property: entry.property,
          from: entry.value,
          to: currentValue(selection.element, entry.property),
          element: selection.element,
        }))
      )
    },

    applyClasses(selection, write, summary) {
      const before = selection.element.getAttribute("class") ?? ""
      writeClasses(selection, write)
      // Same rule as `applyStyles`: re-picking the radius already applied is
      // not a step, and the class list is the honest reading of whether the
      // add/remove pair moved anything.
      const after = selection.element.getAttribute("class") ?? ""
      if (after === before) return
      // One entry for the whole write: what an agent needs is the class
      // attribute to end up with, and a variant swap is half a dozen tokens
      // moving together.
      journalStep(
        {
          label: summary,
          undo: () => writeClasses(selection, { remove: write.add, add: write.remove }),
          redo: () => writeClasses(selection, write),
        },
        [{ property: "class", from: before, to: after, element: selection.element }]
      )
    },

    applyText(selection, text) {
      const before = selection.element.textContent ?? ""
      if (text === before) return
      writeText(selection, text)
      journalStep(
        {
          label: "Edit text",
          undo: () => writeText(selection, before),
          redo: () => writeText(selection, text),
        },
        [{ property: "text", from: before, to: text, element: selection.element }]
      )
    },

    noteReorder(selection, move) {
      journalStep(
        { label: "Reorder", undo: () => {}, redo: () => {} },
        [{ property: "reorder", from: "", to: move, element: selection.element }]
      )
    },

    recordText(selection, before, after) {
      if (before.text === after.text) return
      const element = selection.element
      // Already on the page: the engine's own text editor typed it. Undo puts
      // the markup back rather than the text, so inline children survive.
      journalStep(
        {
          label: "Edit text",
          undo: () => {
            element.innerHTML = before.html
          },
          redo: () => {
            element.innerHTML = after.html
          },
        },
        [{ property: "text", from: before.text, to: after.text, element }]
      )
    },

    applyIcon(selection, variant) {
      const attribute = iconAttribute()
      const element = selection.element
      if (!attribute || !(element instanceof SVGSVGElement)) return
      const before = readIconState(element, attribute)
      if (before.name === variant.name) return
      const after = iconStateOf(variant)

      writeIcon(element, attribute, after)
      // Journaled with both names: the JSX still names the component it always
      // did, so the agent edits the import and the tag.
      journalStep(
        {
          label: `Swap icon to ${variant.name}`,
          undo: () => writeIcon(element, attribute, before),
          redo: () => writeIcon(element, attribute, after),
        },
        [{ property: "icon", from: before.name ?? "", to: variant.name, element }]
      )
      // No toast: the Changes tab lists the swap for the agent.
    },

    applyAttribute(selection, name, value, target) {
      // The host when the caller named one, the selection otherwise. Every
      // read below comes off this element rather than off the selection,
      // because the whole point of the parameter is that they can be different
      // nodes and it is the one being written that an agent has to go and find.
      const element = target ?? selection.element
      // `class` and `style` have writes of their own; an attribute write that
      // quietly took one of them over would journal a raw attribute where the
      // agent should read a class list or a declaration.
      if (!name || name === "class" || name === "style") return
      const before = element.getAttribute(name)
      if (before === value) return

      writeAttribute(element, name, value)

      const property = `attribute:${name}`
      const summary = value === null ? `Clear ${name}` : `Set ${name} to ${value}`
      journalStep(
        {
          label: summary,
          undo: () => writeAttribute(element, name, before),
          redo: () => writeAttribute(element, name, value),
        },
        [{ property, from: attributeWord(before), to: attributeWord(value), element }]
      )
      // No toast, for the reason `applyIcon` gives.
    },

    applyDelete(selections) {
      const removals = planRemovals(selections, elementLabel)
      if (!removals.length) return
      writeRemovals(removals)

      const summary =
        removals.length === 1 ? `Delete ${removals[0].label}` : `Delete ${removals.length} layers`
      // One entry per element, not one per keystroke: deleting three cards at
      // once is three things an agent has to take out of the source, and a
      // single row naming the count would not say which three.
      journalStep(
        {
          label: summary,
          undo: () => undoRemovals(removals),
          redo: () => writeRemovals(removals),
        },
        removals.map((removal) => ({
          // `to` is empty because a deletion has no value to end on — the
          // instruction is the property, and `edit-words.ts` renders it as a
          // sentence.
          property: "remove",
          from: removal.label,
          to: "",
          element: removal.element,
        }))
      )
    },

    applyStylesBatch(edits, summary) {
      if (!edits.length) return

      /*
       * Every "before" is read while every element is still untouched.
       *
       * Reading them inside the write loop would be correct only for as long
       * as the elements are independent, and the writes this exists to make
       * are not: `align-self` on the first child of a flex row changes what
       * the browser computes for its siblings' `align-items`-derived values,
       * so an element read after its neighbour has already moved would record
       * a "before" that was never on screen — and undo would put THAT back.
       */
      const planned = edits.map((edit) => ({
        selection: edit.selection,
        writes: edit.writes,
        before: edit.writes.map((write) => ({
          property: write.property,
          value: currentValue(edit.selection.element, write.property),
        })),
      }))

      for (const edit of planned) writeStyles(edit.selection, edit.writes)

      // The same "a write that changed nothing is not a step" rule the
      // single-element path applies, asked per element: aligning a row where
      // two of the five were already at the top is three elements' worth of
      // edit, and replaying the other two on undo would write values nobody
      // set. An element that did not move is dropped from the step entirely,
      // so it is also absent from the outbox.
      const moved = planned
        .map((edit) => ({
          ...edit,
          before: edit.before.filter(
            (entry) => currentValue(edit.selection.element, entry.property) !== entry.value
          ),
        }))
        .filter((edit) => edit.before.length > 0)
      if (!moved.length) return

      // ONE step for the whole batch, and one journal entry per element —
      // `applyDelete`'s split, for its reason: a single row saying "aligned
      // 5" would not say which five an agent has to change in source.
      journalStep(
        {
          label: summary,
          undo: () => {
            for (const edit of moved) writeStyles(edit.selection, edit.before)
          },
          redo: () => {
            for (const edit of moved) writeStyles(edit.selection, edit.writes)
          },
        },
        moved.flatMap((edit) =>
          edit.before.map((entry) => ({
            property: entry.property,
            from: entry.value,
            to: currentValue(edit.selection.element, entry.property),
            element: edit.selection.element,
          }))
        )
      )
    },
  }
}
