/**
 * Right-hand inspector.
 *
 * Three tabs. **Design** is the historical panel: a stack of collapsible
 * sections, each owning one file, each returning `null` when it has nothing to
 * say about the current selection — which keeps the panel as short as the
 * element is simple. **Changes** holds the session's outbox. **Design system**
 * holds the project's libraries and the audit against them.
 *
 * They are tabs rather than more sections because they are not more to scroll
 * past: each is a different thing to be looking at, and two of them own a
 * footer that has to stay put while their body scrolls.
 *
 * ## What came, what went, and why the panel is not "one selection" any more
 *
 * **Code** used to be the third tab and is now in the left rail beside Layers.
 * Both of those answer "what IS this" — one as a position in the page, one as
 * source — and neither is a control you change anything with, which is what
 * this panel is otherwise entirely made of. `panels/left.ts` carries the rest
 * of that argument.
 *
 * **Library** sat second here for a release, left for the left rail, grew into
 * a catalogue of cards and previews there, and has now come back as half of
 * **Design system** — without the catalogue. The thing that was wrong about it
 * as a tab was never the subject, it was the browsing: a grid of four hundred
 * components you scroll through is most useful in the one state a selection
 * panel has nothing to say, and least useful when you have actually selected
 * something. What is here now is the SETTING that argument was always sound
 * about — which libraries this project draws from, and what each one contains —
 * plus the design-system audit, which was the left rail's third tab. The
 * components themselves did not go anywhere: they reach the Design tab through
 * `instanceSection`, which shows a component's properties when you have one
 * selected, which is when they are worth showing.
 *
 * So two of these three tabs are views of the selection and the third is a view
 * of the project. That is a real difference and the strip does not hide it —
 * `tab-design-system.ts` documents why it deliberately does not repaint when
 * the selection moves.
 *
 * `css/inspector.ts` keeps the strip a scroller, and it has to be: "Design
 * system" is a two-word label and the seam drags down to `inspectorMinWidth`,
 * which is 200px. `activate()` below carries the other half, scrolling the
 * chosen tab into view so the keyboard path never depends on a scrollbar that
 * is deliberately not drawn.
 */

import { onPreviewOnlyChange } from "../../core/change-prompt"
import { registerCommand } from "../../core/commands"
import { onAnnotationsChange } from "../../annotations/store"
import { onEditsChange } from "../../annotations/journal"
import { owedCount } from "../../annotations/output"
import { clear, el } from "../../core/dom"
import { smoothScroll } from "../../core/motion"
import { holdScroll } from "../../core/scroll"
import { installTabPill } from "../../core/travelling-surface"
import { focusControl } from "../../core/focus"
import { createWriter, type Writer } from "../../core/writer"
import { tokens } from "../../core/tokens"
import { forgetNormalizedCssValues } from "../../core/design-system"
import type { EditorContext } from "../../core/context"
import type { Selection } from "../../core/types"

import type { InspectorTab } from "./tab-code"
import { annotationsTab } from "./tab-annotations"
import { designSystemTab } from "./tab-design-system"
import { iconSection } from "./section-icon"
import { instanceSection } from "./section-instance"
import { positionSection } from "./section-position"
import { unifiedLayoutSection } from "./section-unified-layout"
import { responsiveSection } from "./section-responsive"
import { appearanceSection } from "./section-appearance"
import { fillSection } from "./section-fill"
import { strokeSection } from "./section-stroke"
import { effectsSection } from "./section-effects"
import { typographySection } from "./section-typography"
import { classesSection } from "./section-classes"
import { formatCount } from "../../core/format"

export interface SectionContext {
  editor: EditorContext
  writer: Writer
  selection: Selection
  /**
   * Everything selected, primary first — `selection` is this one's head.
   *
   * Both are here rather than one, because a section that describes a box
   * (fill, typography, the frame readout) is answering a question about ONE
   * box however many are picked, and a section that places boxes relative to
   * each other is answering a question about the set. Making every section
   * read `selections[0]` would have been the same information with every
   * existing call site rewritten to say it.
   *
   * Optional, and a reader must treat an absent one as "just the primary".
   * The section suites build this object by hand to drive one section in
   * isolation, so a section that reaches for `.length` on an assumption
   * throws where the assertion should have failed.
   */
  selections?: Selection[]
  /** Computed style of the selected element, read once per render. */
  computed: CSSStyleDeclaration
  /** Re-renders the inspector after a write. */
  invalidate(): void
}

export type InspectorSection = (context: SectionContext) => HTMLElement | null

/** Figma's own top-to-bottom order, minus the sections with no DOM analogue. */
const SECTIONS: InspectorSection[] = [
  // First, like Figma's instance properties: the first question about a placed
  // symbol is which symbol it is.
  iconSection,
  // Directly under it, the way Figma stacks an instance's block: which main
  // component this is, then every property that component declares.
  //
  // One section and not two. The variant axes read out of the project's own
  // source and the props an installed library documents used to be a block
  // each, and a designer selecting one `<x-button>` got both — visibly about
  // the same component, disagreeing about how much of it was editable. Two
  // sources of truth is the right number to have and the wrong number to show,
  // so `section-instance.ts` merges them by name and says, per row, which of
  // them can actually be written.
  instanceSection,
  // Saved styles have no section of their own any more. Each is scoped to the
  // properties one section edits — text styles in Typography, color styles in
  // Fill, and so on — so it lives in that section's header, beside the controls
  // it would change. `options/panel.ts` builds that control.
  responsiveSection,
  // Above layout, the way every editor stacks it: where the thing sits and how
  // it lines up with its siblings is the first question, and it is answerable
  // without knowing anything about the box's own internals.
  positionSection,
  unifiedLayoutSection,
  appearanceSection,
  fillSection,
  strokeSection,
  effectsSection,
  typographySection,
  classesSection,
]

/**
 * The sections that print `Selection.source` — Instance reads the file's
 * variant declarations, Classes shows the path. When the owner-stack resolver
 * fills a source in after the click (`sourceRevision` in `core/store.ts`),
 * these are re-run in place and the other nine are left standing, since
 * nothing else they show depends on where the element was written.
 */
const SOURCE_SECTIONS: InspectorSection[] = [instanceSection, classesSection]

interface FocusMemory {
  /** `data-de-field` identity, when the control declared one. */
  field: string | null
  /** Child-index path from the panel host — the fallback for controls without one. */
  path: number[]
  start: number | null
  end: number | null
}

function indexPath(host: HTMLElement, node: Element): number[] {
  const path: number[] = []
  for (let step: Element | null = node; step && step !== host; step = step.parentElement) {
    const parent = step.parentElement
    if (!parent) return []
    path.unshift(Array.prototype.indexOf.call(parent.children, step))
  }
  return path
}

function nodeAtPath(host: HTMLElement, path: number[]): HTMLElement | null {
  let node: Element | undefined = host
  for (const index of path) {
    node = node?.children[index]
    if (!node) return null
  }
  return node instanceof HTMLElement ? node : null
}

function captureFocus(host: HTMLElement): FocusMemory | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !host.contains(active)) return null
  const text = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
  return {
    field: active.getAttribute("data-de-field"),
    path: indexPath(host, active),
    start: text ? active.selectionStart : null,
    end: text ? active.selectionEnd : null,
  }
}

/**
 * Puts the caret back after a rebuild.
 *
 * Every commit re-renders the whole panel, so without this the field you just
 * typed into is a detached node and focus has fallen to `<body>` — which makes
 * Tab-between-fields, Enter-to-commit, and repeated arrow nudges all impossible.
 */
function restoreFocus(host: HTMLElement, memory: FocusMemory | null): void {
  if (!memory) return
  // Matched by string compare rather than an attribute selector: field ids are
  // dotted (`appearance.radius.tl`), and building a selector from them means
  // escaping, which is one more thing to get wrong for no gain at this size.
  const byField = memory.field
    ? [...host.querySelectorAll<HTMLElement>("[data-de-field]")].find(
        (node) => node.getAttribute("data-de-field") === memory.field
      ) ?? null
    : null
  const target = byField ?? nodeAtPath(host, memory.path)
  if (!target || !target.isConnected) return
  focusControl(target, { preventScroll: true })
  if (memory.start === null) return
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return
  const limit = target.value.length
  target.setSelectionRange(Math.min(memory.start, limit), Math.min(memory.end ?? memory.start, limit))
}

interface TabDefinition {
  id: string
  label: string
  tab: InspectorTab
}

export function installInspector(editor: EditorContext): void {
  const writer = createWriter(editor.bridge)
  const host = el("div")

  /*
   * Design is a tab like the other three, but its body is built by `render()`
   * rather than by a controller — so it hands over the same `{node, update}`
   * shape and the strip below never has to know which is which.
   */
  const design: InspectorTab = { node: host, update: () => render() }
  /*
   * The order is a claim about what the panel is for, and it is read left to
   * right as a widening scope: this element, then what you have done to it,
   * then the system both of those are measured against.
   *
   * Changes REPLACED the Prompts tab rather than joining it. Prompts held one
   * half of the handover — the edits the writer could not spell as classes — so
   * a designer with something to say about the page had nowhere to put it, and
   * a designer with both had two surfaces to gather from before they could hand
   * anything over. Notes and edits are one message: the notes say what is
   * wrong, the edits say what has already been done about it, and an agent sent
   * only one of them either redoes finished work or acts with no reason given.
   * One outbox, or neither half is trustworthy.
   *
   * Design system is last and is the odd one out: it is the only tab here that
   * is NOT a view of the selection. It sits in this panel anyway because both
   * of its halves are about the vocabulary the other two tabs speak — the
   * libraries are where the Design tab's tokens and instance properties come
   * from, and the audit is a list of places the page ignored them. Its own
   * header explains why it does not re-render on selection.
   */
  /**
   * A count on the tab, because the tab is the only place unfinished work shows.
   *
   * It counts what is still OWED, which is every row the Changes tab does not
   * badge "In your files": the notes, the edits no commit can write, and — the
   * one that is easy to get wrong — the edits that are merely QUEUED. A badge
   * is read as "this many things want you", so a session that has applied
   * everything must stop wearing a number, and a session that has applied
   * nothing must not read as zero.
   *
   * `written` alone cannot answer this. The writer sets it at the moment of the
   * edit for anything it can spell, so counting `!written` silently omitted
   * every Ready row — the tab said 3 with four things waiting. `isEditQueued`
   * is the other half, exactly as it is for the badge, and the two must agree:
   * the number on the tab is a promise about what the list below it shows.
   *
   * It is an ATTRIBUTE the stylesheet draws, not a child element, and that is
   * the whole of why. A tab's text content is its name: every reader of this
   * strip — the switcher below, the three suites that find a pane by its label,
   * a person reading the DOM — takes `textContent` to be the word. Appending a
   * `<span>` with a number in it makes the name "Changes3" for all of them at
   * once, and it does so only once there is something to count, so the failure
   * arrives later than the change that caused it.
   *
   * `aria-label` pins the accessible name for the same reason, and against the
   * opposite risk: generated content is announced by some screen readers, and a
   * name that changes on every keystroke is a name announced on every
   * keystroke.
   */
  function installChangeCount(button: HTMLElement, label: string): void {
    button.setAttribute("aria-label", label)
    const paint = (): void => {
      const owed = owedCount()
      const count = owed > 0 ? formatCount(owed) : undefined
      if (count === button.dataset.deCount) return
      if (count === undefined) delete button.dataset.deCount
      else button.dataset.deCount = count
      /*
       * The badge changes this tab's width, and the pill may be standing under
       * it. The pill's resize observer would notice only after the next layout,
       * so an Apply showed the old pill width for a frame and the panel's last
       * write trailed everything else by that frame. Re-tracking here measures
       * in the same task; the observer then finds the box already published and
       * writes nothing.
       */
      pill.track(buttons.get(activeId))
    }
    paint()
    onAnnotationsChange(paint)
    onEditsChange(paint)
  }

  const tabs: TabDefinition[] = [
    { id: "design", label: "Design", tab: design },
    { id: "annotations", label: "Changes", tab: annotationsTab(editor) },
    { id: "system", label: "Design system", tab: designSystemTab(editor) },
  ]

  let activeId = tabs[0].id
  const buttons = new Map<string, HTMLElement>()
  const panels = new Map<string, HTMLElement>()

  /*
   * ⌥8 / ⌥9 / ⌥0, registered BY SLOT rather than by name.
   *
   * Figma's three right-panel keys select its first, second and third view, and
   * so do these — which is also what keeps them working through a change to the
   * array above. An earlier version named the tabs and went silently dead the
   * afternoon the tab set was reshuffled; a command nobody registers is a no-op
   * by design, so nothing failed and three keys simply stopped.
   *
   * Only the slots that exist are registered, so a shorter strip leaves the
   * spare key to the page rather than eating it. Opening the panel is part of
   * the command: a key that switched a tab inside a closed panel would look
   * like a key that did nothing. One `setState`, because the subscription below
   * runs per notification and two writes paint the old tab for a frame.
   */
  tabs.slice(0, 3).forEach((definition, index) => {
    registerCommand(`panel.inspector.tab${index + 1}`, () =>
      editor.setState({ inspectorOpen: true, inspectorTab: definition.id })
    )
  })

  const strip = el("div", { class: "de-tabs", role: "tablist", "aria-label": "Inspector views" })
  const pill = installTabPill(strip)
  for (const definition of tabs) {
    const button = el(
      "button",
      {
        class: "de-tab",
        type: "button",
        role: "tab",
        id: `de-tab-${definition.id}`,
        "aria-controls": `de-tabpanel-${definition.id}`,
        "aria-selected": String(definition.id === activeId),
        onclick: () => activate(definition.id),
      },
      [definition.label]
    )
    buttons.set(definition.id, button)
    strip.append(button)
    if (definition.id === "annotations") installChangeCount(button, definition.label)

    const panel = el(
      "div",
      {
        class: "de-tabpanel",
        role: "tabpanel",
        id: `de-tabpanel-${definition.id}`,
        "aria-labelledby": `de-tab-${definition.id}`,
      },
      [definition.tab.node]
    )
    panel.hidden = definition.id !== activeId
    panels.set(definition.id, panel)
  }

  editor.slots.right.append(strip, ...panels.values())

  /* A frame late, for the reason `panels/left.ts` gives at the same call: the
     strip is in the document but not yet laid out, and `installTabPill` will
     not publish a measurement of zero. */
  requestAnimationFrame(() => pill.track(buttons.get(activeId)))

  /**
   * Switching tabs updates the tab you switch TO, and only that one.
   *
   * The hidden panes keep their DOM — losing the code view's scroll position
   * every time you glance at the design tab would make the pair unusable — but
   * a hidden pane is not re-read on every write either, which is what keeps the
   * ledger and the code view off the hot path of a scrub.
   */
  function activate(id: string): void {
    activeId = id
    /*
     * Published, so the bar can ask for a tab without reaching into this
     * closure.
     *
     * Written on every switch and not only on a user click, because the store
     * is the record of WHICH TAB IS SHOWING — a switch this function made for
     * some other reason is still a switch, and a record that skips those is one
     * the toolbar would read as stale. Guarded on inequality so the write that
     * comes back from the subscription below cannot loop.
     */
    if (editor.getState().inspectorTab !== id) editor.setState({ inspectorTab: id })
    for (const definition of tabs) {
      const selected = definition.id === id
      buttons.get(definition.id)?.setAttribute("aria-selected", String(selected))
      const panel = panels.get(definition.id)
      if (panel) panel.hidden = !selected
    }
    /*
     * The strip scrolls and draws no scrollbar, so the chosen tab has to bring
     * itself into view or there is no way to know another one is out there.
     * Three tabs clear the panel's mounted width — but the seam is draggable
     * down to `inspectorMinWidth`, which is 200px and a good 50 short of what
     * the strip measures, so the overflow is an everyday state now rather than
     * the backstop it was when the width was fixed.
     *
     * `nearest` on both axes, and the inline half is the one that matters: a
     * `center` would slide the strip on every switch even when nothing was ever
     * off screen, which is motion answering a click that needed none. The block
     * half is `nearest` for a stricter reason — the strip lives inside the
     * panel body, and asking to scroll it vertically would drag the whole right
     * panel to put a 34px landmark where the browser thinks it belongs.
     *
     * Guarded, because JSDOM does not implement it and the tab suite drives
     * this function directly; an unguarded call would make every tab-switch
     * case fail on a method that has nothing to do with what they assert.
     */
    const button = buttons.get(id)
    button?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: smoothScroll() })
    // After the scroll: the pill reads content-relative offsets, and a strip
    // that just scrolled is a different layout from the one measured before it.
    pill.track(button)
    tabs.find((definition) => definition.id === id)?.tab.update()
    // That was the repaint any off-screen write was owed.
    stale = false
  }

  /*
   * Repaints are coalesced to the end of the task that asked for them, and
   * owed rather than paid while the panel is off screen.
   *
   * A microtask, not a frame. Every write of one task — a commit's four
   * properties, a selection and the ledger entry it files — still lands in one
   * repaint, and the repaint is done before the task yields, so the panel
   * describes the new element in the same task as the keypress or click that
   * chose it. A `requestAnimationFrame` here waited for the next frame and ran
   * behind every other frame callback, so the panel was always the last thing
   * on screen to answer: a Tab walk settled a frame late, after the outline.
   *
   * A closed inspector or a stood-down chrome still hears every selection,
   * commit and nudge, and rebuilding eleven sections nobody can see is the
   * whole cost of a click with nothing to show for it. So those writes only
   * mark the panel `stale`, and the subscription below pays the debt once, on
   * the write that brings it back — in the same task it opens, so the reader
   * never sees the old element. Canvas view is NOT a reason: the board covers
   * the strip between the panels and leaves this one on screen.
   *
   * Two weights of repaint share the microtask. `invalidate` re-reads the whole
   * active tab; `invalidateSource` re-runs only the sections that print a
   * source (see `SOURCE_SECTIONS`), for a Selection whose `source` landed
   * after the click. A full repaint already owed swallows the narrow one.
   */
  let scheduled = false
  let owedFull = false
  let stale = false
  const offScreen = (): boolean => {
    const state = editor.getState()
    return !state.inspectorOpen || state.chromeHidden
  }
  const schedule = (full: boolean): void => {
    if (offScreen()) {
      stale = true
      return
    }
    if (full) owedFull = true
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      const wasFull = owedFull
      owedFull = false
      // Closed by a later write of the same task: still owed, not paid.
      if (offScreen()) {
        stale = true
        return
      }
      if (wasFull) tabs.find((definition) => definition.id === activeId)?.tab.update()
      else if (activeId === "design") renderSourceSections()
    })
  }
  const invalidate = (): void => schedule(true)
  const invalidateSource = (): void => schedule(false)

  /**
   * Which element the panel currently shows, so a repaint can tell a tweak from
   * a new subject.
   *
   * `Selection.key` and not the object: the store hands out a fresh selection
   * record on every resolve, so identity would read every repaint as a change
   * of element and the scroll hold below would never once apply.
   */
  let renderedKey: string | null = null
  /** The last full render's context and the node each section returned, for `renderSourceSections`. */
  let renderedContext: SectionContext | null = null
  const renderedNodes = new Map<InspectorSection, HTMLElement>()

  function render(): void {
    renderedContext = null
    renderedNodes.clear()
    const focus = captureFocus(host)
    const selections = editor.getState().selection
    const selection = editor.primarySelection()
    /*
     * Stay where the reader put us — but only while the panel is describing the
     * same element.
     *
     * Every committed property rebuilds this whole host, and an emptied
     * scroller is clamped to the top by the first layout that happens while it
     * is empty — which the sections themselves force, since they read computed
     * geometry as they build. So changing a weight from a row two thirds of the
     * way down sent the panel back to the top with the control you had just
     * used off screen. `core/scroll.ts` carries the mechanism and why the pin,
     * rather than a scroll-back, is what does the work.
     *
     * A different element gets the top of the panel, which is both the old
     * behaviour and the right one: the sections below are a different set
     * describing a different box, so a remembered offset into the previous
     * one points at nothing in particular.
     */
    const key = selection?.key ?? null
    const hold = key !== null && key === renderedKey ? holdScroll(host) : null
    renderedKey = key
    clear(host)

    /*
     * Nothing selected is not nothing to do — but what there is to do is on the
     * other side of the window now.
     *
     * This used to read "Browse all design options" and call
     * `openOptionsBrowser(editor)` directly, and the comment here argued the
     * directness at length: a `window` event went nowhere on a cold load
     * because the floating browser mounted lazily and its listener did not yet
     * exist. That whole problem is gone with the browser. What is left is a
     * store write, which is how every other lane in this editor reaches
     * another one, and it cannot be too early — `panels/left.ts` subscribes to
     * `leftTab` at mount and the store is there before any panel is.
     *
     * The label leads with a verb and names the destination the left rail
     * actually calls it: Design options. It used to be one of two names for one
     * place — a `.de-button` saying "Browse all design options" here, a
     * text link saying "All design options" in the footer — which is how a
     * reader concludes there are two places.
     */
    if (!selection) {
      host.append(
        el("div", { class: "de-empty" }, [
          el("div", {}, ["Select an element or layer to edit it."]),
          el(
            "button",
            {
              class: "de-button",
              type: "button",
              style: `margin-top:${tokens.space.md}px`,
              onclick: () => editor.setState({ layersOpen: true, leftTab: "controls" }),
            },
            ["Browse design options"]
          ),
        ])
      )
      // Unreachable while a hold is only taken for an unchanged element — the
      // empty state has no element at all — but released on the way out anyway,
      // because a `min-height` left pinned would freeze the panel at the height
      // of whatever was selected before it.
      hold?.release()
      return
    }

    /*
     * No identity header over the sections. It named the component, its tag
     * and its source line, and every one of those is already on screen where it
     * belongs: the layer row is selected in the left panel, the canvas labels
     * the box, and the Code tab beside Layers is where source lives. Repeating
     * them here spent the top of the panel on a readout instead of a control.
     */
    const context: SectionContext = {
      editor,
      writer,
      selection,
      selections,
      computed: getComputedStyle(selection.element),
      invalidate,
    }

    /*
     * Built detached and appended in one go. The sections read the element's
     * computed style as they build, and with each one appended as it was built
     * every read after the first found the document changed by the section
     * before it and recalculated style again — a recalculation per section
     * where one does.
     */
    const built: HTMLElement[] = []
    for (const section of SECTIONS) {
      let node: HTMLElement | null = null
      try {
        node = section(context)
      } catch (error) {
        console.warn("[designlayer] inspector section failed", error)
      }
      if (node) {
        built.push(node)
        renderedNodes.set(section, node)
      }
    }
    host.append(...built)
    renderedContext = context

    // Focus first, then the scroll: `restoreFocus` asks for `preventScroll`, but
    // an engine that ignored it would scroll the refocused control into view and
    // the release below is what puts the panel back where the reader had it.
    restoreFocus(host, focus)
    hold?.release()
  }

  /**
   * Re-runs `SOURCE_SECTIONS` against the record the last render described.
   *
   * The source is patched into that very object, so identity is the test: a
   * panel now showing anything else (a new selection, the empty state) gets
   * the full render instead. Each new node takes its old one's place, or —
   * for a section that had nothing to say without a source — slots in before
   * the next section that rendered, keeping `SECTIONS` order.
   */
  function renderSourceSections(): void {
    const context = renderedContext
    if (!context || context.selection !== editor.primarySelection()) return render()
    const focus = captureFocus(host)
    const hold = holdScroll(host)
    for (const section of SOURCE_SECTIONS) {
      let node: HTMLElement | null = null
      try {
        node = section(context)
      } catch (error) {
        console.warn("[designlayer] inspector section failed", error)
      }
      const old = renderedNodes.get(section)
      if (old) {
        if (node) old.replaceWith(node)
        else old.remove()
      } else if (node) {
        const later = SECTIONS.slice(SECTIONS.indexOf(section) + 1)
          .map((candidate) => renderedNodes.get(candidate))
          .find(Boolean)
        host.insertBefore(node, later ?? null)
      }
      if (node) renderedNodes.set(section, node)
      else renderedNodes.delete(section)
    }
    restoreFocus(host, focus)
    hold.release()
  }

  // Rebuild only when what the inspector shows actually changed. `hovered` is
  // written on every pointermove; rebuilding on it would tear the focused
  // control out of the DOM mid-edit and drop a drag-scrub's pointer capture.
  editor.subscribe((next, previous) => {
    // Somebody else asked for a tab — today the bar's pending indicator, which
    // is the only way to reach the Changes tab from outside this panel. Handled
    // before the selection check below because a tab switch is not a selection
    // change and would otherwise be dropped by it.
    if (next.inspectorTab !== previous.inspectorTab && next.inspectorTab !== activeId) {
      activate(next.inspectorTab)
    }
    // Back on screen with a repaint owed from while it was away.
    if (
      stale &&
      (next.inspectorOpen !== previous.inspectorOpen || next.chromeHidden !== previous.chromeHidden) &&
      !offScreen()
    ) {
      stale = false
      invalidate()
      return
    }
    if (next.selection !== previous.selection || next.optionSets !== previous.optionSets) {
      invalidate()
    } else if (next.sourceRevision !== previous.sourceRevision) {
      invalidateSource()
    }
  })
  // A refresh is the editor saying the page moved under us, so the token rows'
  // memoized probe answers (`normalizedCssValue`) go with it.
  editor.onRefresh(() => {
    forgetNormalizedCssValues()
    invalidate()
  })
  /*
   * The ledger keeps its own time, and it is nobody else's.
   *
   * A write that turns out to have no file to land in reaches the ledger from
   * `ensureSource(...).then(...)` in the writer, long after the store settled
   * and long after the edit that caused it. Neither the subscription above nor
   * `onRefresh` fires for that, so the outbox could be sitting open, already
   * rendered, insisting there was nothing to hand over while the change was on
   * screen behind it.
   *
   * Only when the outbox is the tab being looked at. `invalidate()` repaints
   * whichever tab is active, and a ledger write says nothing whatsoever about
   * the Design or Code views — repainting either of them on a write they do not
   * show is exactly the hot-path cost `activate()` is written to avoid. A
   * hidden pane needs nothing: switching to it updates it.
   *
   * Routed through `invalidate()` rather than rendering here so the repaint
   * lands once the write is done. A commit carrying four properties records four
   * times, and the recording happens mid-write — a synchronous render would
   * rebuild the panel three times for nothing and do it inside the writer's own
   * loop, with the element half-styled.
   */
  onPreviewOnlyChange(() => {
    if (activeId === "annotations") invalidate()
  })
  /*
   * Only the visible tab is built at boot. A hidden one is built by `activate`
   * the moment it is switched to — before that frame paints, so it is never
   * seen empty — and building it here too was a full list render plus the
   * requests behind it on every page load, for tabs most sessions never open.
   * A tab with work that cannot wait for its first showing (the library list
   * the Design tab's pickers draw on) says so through `boot`.
   */
  for (const definition of tabs) {
    if (definition.id !== activeId) definition.tab.boot?.()
    else if (offScreen()) stale = true
    else definition.tab.update()
  }
}
