/**
 * The one path from "user changed something in the UI" to "the app shows it and
 * the source will too".
 *
 * Every section writes through here so live preview and the queued source
 * operation can never disagree — the failure mode that makes visual editors
 * untrustworthy is a preview that the code write silently drops.
 */

import { dropLastEdit, recordEdit } from "../annotations/journal"
import {
  isAngularHost,
  queueAngularClasses,
  queueAngularStyles,
  queueAngularText,
} from "./angular"
import { resolveElementSource, type RewriteBridge, type UpdateClassOperation } from "./bridge"
import { previewOnlyChanges, recordPreviewOnly } from "./change-prompt"
import { DELETED_ATTRIBUTE } from "./dom"
import { describeTarget, type ElementTarget } from "./element-target"
import { record, type HistoryStep } from "./history"
import { iconAttribute, type IconVariant } from "./icon-set"
import { drawHostIcon } from "./icons"
import { writeMove } from "./moves"
import { queueRemoval, unqueueRemoval, type RemovalOperation } from "./removal"
import { isLocked } from "./store"
import { propertyKey, toClassUpdate, type ClassUpdate } from "./tailwind"
import type { LayerElement, Selection, SourceRef } from "./types"

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
  /** Applies inline styles now and queues the equivalent utilities for source. */
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
  /** Swaps utility classes now and queues them for the source writer. */
  applyClasses(selection: Selection, write: ClassWrite, summary: string): void
  /** Replaces the element's text content. */
  applyText(selection: Selection, text: string): void
  /** Redraws a selected `<svg>` as another variant from the host's icon set. */
  applyIcon(selection: Selection, variant: IconVariant): void
  /**
   * Sets one DOM attribute as a PREVIEW, and files it for an agent. `null`
   * removes it.
   *
   * The only write in here that is preview-only by construction rather than by
   * accident, alongside `applyIcon`. Neither rewrite lane can edit a
   * component's prop in source — the pinned React engine has no JSX-attribute
   * operation, and `AngularOperation` is `setStyles | setClasses | setText` —
   * so the attribute changes on the page, the change goes to the ledger, and an
   * agent makes it real. See `panels/inspector/section-instance.ts` for why
   * that is still worth offering, and for the evidence gate that decides which
   * props get a control at all.
   *
   * `class` and `style` are refused. Both have real write lanes above, and
   * routing either through here would strand an edit that could have reached
   * the file.
   *
   * `target` is the element to write ON, and it defaults to the selected one.
   * It exists because a component's inputs are not necessarily on the node the
   * user clicked: an Angular component renders a template, the click usually
   * lands on something INSIDE it, and `variant="filled"` is on the host tag
   * further up. The selection still describes what was picked — it is what the
   * ledger entry and the source lookup are about — so the two are passed
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
   * Deletes elements: off the page now, out of the source at "Apply to code".
   * Takes the whole selection rather than one entry, because what has to be
   * captured before the first removal — where each element sat, and which
   * sibling it was — is only true while every one of them is still in place.
   */
  applyDelete(selections: Selection[]): void
  /** CSS properties the source writer cannot express, newest first. */
  untranslated(): string[]
}

/** Index among preceding siblings of the same tag — an AST disambiguator. */
function nthOfType(element: LayerElement): number {
  let index = 0
  let sibling = element.previousElementSibling
  while (sibling) {
    if (sibling.tagName === element.tagName) index += 1
    sibling = sibling.previousElementSibling
  }
  return index
}

/**
 * CSS properties this session previewed but could not express as utilities,
 * newest first.
 *
 * Derived rather than kept: the full record of what could not be written lives
 * in `change-prompt.ts`, because the toolbar needs the property names for its
 * toast and the copy button needs the file, the element and the values. Two
 * lists would let the warning and the prompt disagree about what was lost.
 *
 * Filtered to CSS properties on purpose. An icon swap is in the ledger — it is
 * exactly the kind of change that needs an agent — but it announces itself as
 * preview-only at the moment it happens, and repeating it in the Apply toast
 * would report the same loss twice. A stranded class list is in the ledger for
 * the same reason and skipped for the same one: `class` is an attribute, and a
 * toast that listed it among the declarations that "cannot be written to code"
 * would be naming a CSS property that does not exist.
 *
 * A stranded CSS property is NOT filtered. It is in the ledger precisely
 * because it could not be written, which is exactly what the toast reports —
 * the translator could spell it, but there was no file to spell it into.
 *
 * `remove` is filtered on both counts: a deletion is not a declaration, and it
 * has already said so in its own toast at the moment it happened.
 */
export function untranslatedProperties(): string[] {
  const seen = new Set<string>()
  for (const change of previewOnlyChanges()) {
    if (change.property === "icon" || change.property === "class") continue
    if (change.property === "remove") continue
    // A component prop previewed as an attribute, for the icon's reason: it
    // toasts "— preview only" at the moment it happens, and it is an ATTRIBUTE
    // — listing `attribute:variant` among the declarations that "cannot be
    // written to code" would name a CSS property that does not exist.
    if (change.property.startsWith("attribute:")) continue
    seen.add(change.property)
  }
  return [...seen]
}

/**
 * What undo has to put back.
 *
 * The computed value when nothing is set inline, not the empty string: an empty
 * string reverts the preview correctly but is not a value the translator can
 * turn into a utility, so the pending source operation would keep the change
 * the user just took back. Re-asserting the value the element already had is
 * visually identical and *is* expressible, which keeps the two halves of a
 * write — what you see and what will be committed — saying the same thing.
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
  selection: Selection
  element: LayerElement
  /** Read while the element is still a layer, which is the only time it is true. */
  target: ElementTarget
  componentName: string
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
 * is going anyway, and queueing it separately would ask the server to splice two
 * overlapping ranges out of one file, which it correctly refuses to do.
 *
 * Document order is not needed for undo any more — nothing is detached, so no
 * sibling reference can go stale — but it is still what the toast counts and the
 * order the operations reach the server in, and a list that matches the page
 * reads better in a failure report than the order the user happened to click in.
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
    selection,
    element: selection.element,
    target: describeTarget(selection.element),
    componentName: selection.componentName,
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

/** One edit as the annotation outbox remembers it. */
interface JournalEdit {
  property: string
  from: string
  to: string
  element: Element | null
  /**
   * Whether it reached the source queue, answered at the fork that already
   * decides it: `writeStyles` hands back the properties it could not
   * translate, and an icon swap is preview-only by construction.
   *
   * A class, a text change and a delete are dispatched, so they are recorded
   * as written, and a LATE strand — resolution answering with a bundler chunk
   * half a second after the keystroke — is not read back here. Nothing is lost
   * by that: recording the late strand is what the change-prompt ledger is
   * for, and a row that changed its mind long after the edit would be the
   * outbox contradicting itself while the user watches.
   */
  written: boolean
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
 * Journaled before `record`, for the reason `applyIcon` already documents:
 * pushing the history step repaints the toolbar, and the toolbar counts what
 * is waiting to be handed over.
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

/**
 * Hands the server the commit an Apply would send now, once the edits settle.
 *
 * `runtime/apply-ahead.mjs` rehearses it — the vendor's own batch transform,
 * with its writes captured — so that when Apply is clicked the parse and the
 * reprint are already done and the click only waits for a file write. It is a
 * hint and nothing more: the server uses the rehearsal only for a commit with
 * exactly these operations on exactly the file text it rehearsed against, so a
 * hint that goes stale (an undo, a file edited underneath) costs a wasted
 * rehearsal and never a wrong write. A vendor that does not know the message
 * ignores it. Module-wide, because every surface that edits builds its own
 * writer and the queue they feed is one.
 */
const AHEAD_MS = 150
let aheadTimer = 0

function rehearseSoon(bridge: RewriteBridge): void {
  window.clearTimeout(aheadTimer)
  aheadTimer = window.setTimeout(() => {
    try {
      const operations = bridge.store.buildBatchOperations()
      if (operations.length) bridge.send({ type: "designlayer:applyAhead", operations })
    } catch {
      // A store that cannot build has nothing an Apply could send either.
    }
  }, AHEAD_MS)
}

export function createWriter(bridge: RewriteBridge): Writer {

  /**
   * The source ref for a selection, resolving it if selection time could not.
   *
   * Under React 19 selection time never can: `bridge.elementInfo` is a walk over
   * `fiber._debugSource`, which React 19.2 removed, so every `Selection` this
   * editor builds arrives with `source: null`. That is what made "Apply to code"
   * a permanently disabled button — the operation was dropped here, quietly, and
   * `hasChanges()` stayed false, so nothing downstream could report it.
   *
   * The answer is written back onto the selection so the inspector and the
   * layers panel see the same file the queue used, and so a second edit to the
   * same element does not pay for the round trip again.
   */
  const ensureSource = async (selection: Selection) => {
    if (selection.source?.filePath) return selection.source
    const resolved = await resolveElementSource(bridge, selection.element)
    if (resolved) selection.source = resolved
    return resolved
  }

  const operationFor = (
    selection: Selection,
    source: SourceRef,
    updates: ClassUpdate[],
    identity?: { className: string; parentClassName: string | undefined }
  ): UpdateClassOperation | null => {
    if (!source.filePath) return null
    const element = selection.element
    const parent = element.parentElement

    return {
      op: "updateClass",
      file: source.filePath,
      line: source.lineNumber,
      col: source.columnNumber ?? 0,
      componentName: source.componentName,
      tagName: element.tagName.toLowerCase(),
      className: identity
        ? identity.className || undefined
        : element.getAttribute("class") || undefined,
      parentTagName: parent?.tagName.toLowerCase(),
      parentClassName:
        identity?.parentClassName ?? parent?.getAttribute("class") ?? undefined,
      nthOfType: nthOfType(element),
      updates,
    }
  }

  /**
   * True only when the engine took the operation.
   *
   * The answer matters because a rejection used to end here. The comment that
   * stood in this catch claimed "Apply to code reports the shortfall", but the
   * toolbar's shortfall report is `untranslatedProperties()`, which reads the
   * ledger — and nothing had been written to it. The change stayed on screen,
   * `hasChanges()` stayed false, and the next hot reload ate it. Callers use
   * the false to strand the change into the ledger instead.
   */
  const dispatch = (
    selection: Selection,
    source: SourceRef,
    updates: ClassUpdate[],
    keys: string[],
    identity?: { className: string; parentClassName: string | undefined }
  ): boolean => {
    const operation = operationFor(selection, source, updates, identity)
    if (!operation) return false
    try {
      bridge.store.addPendingPropertyOperation(selection.key, operation, keys)
      rehearseSoon(bridge)
      return true
    } catch {
      // The engine rejects operations it cannot locate in source.
      return false
    }
  }

  /**
   * A change the translator could spell but that has nowhere to land.
   *
   * Recorded with whatever path is known and never patched afterwards, unlike
   * the preview-only branch in `writeStyles`: this only ever runs once
   * resolution has already been attempted and come back empty or unusable, so
   * asking again would be a second sourcemap round trip for the same "no".
   */
  const strand = (
    selection: Selection,
    change: { className: string; property: string; from: string; to: string }
  ) => {
    recordPreviewOnly({
      filePath: selection.source?.filePath ?? null,
      componentName: selection.componentName,
      tagName: selection.element.tagName.toLowerCase(),
      ...change,
    })
  }

  /**
   * Synchronous when the file is known, deferred only when it is not.
   *
   * The wait is not free — it is a sourcemap fetch and sometimes a `grep` — so
   * it is paid once per element and never on a path that already has an answer.
   * When it is paid, nothing awaits it: the preview is already on screen, and
   * the engine's `addPendingPropertyOperation` fires its own state-change
   * listeners when the entry lands, which is what takes the toolbar's Apply
   * button out of its disabled state. Awaiting here would stall a drag instead.
   *
   * `stranded` is the caller's answer to the two ways this can come up empty:
   * the file never resolves — under React 19 the sync walk always says `""`,
   * the async resolver hands back a bundler chunk about half the time, and
   * `isProjectSourcePath` rejects it — or the engine refuses an operation it
   * cannot locate. Both used to end in silence, which is the whole reason a
   * panel edit could leave the Prompts tab empty. The change is on screen
   * either way, so the only honest place left for it is the ledger.
   */
  const queue = (
    selection: Selection,
    updates: ClassUpdate[],
    keys: string[],
    stranded: () => void,
    identity?: { className: string; parentClassName: string | undefined }
  ) => {
    const known = selection.source
    if (known?.filePath) {
      if (!dispatch(selection, known, updates, keys, identity)) stranded()
      return
    }
    void ensureSource(selection).then((source) => {
      if (source && dispatch(selection, source, updates, keys, identity)) return
      stranded()
    })
  }

  /**
   * Apply and queue, with no toast and no history entry of its own.
   *
   * Both directions of the timeline replay through here rather than through
   * `applyStyles`, so undoing a change neither announces itself twice nor
   * records an inverse of the inverse.
   */
  /**
   * The Angular lane: preview, then queue the CSS declarations verbatim.
   *
   * No Tailwind translation happens here, and that is not a shortcut — an
   * Angular template has no utility classes to carry one. The write target is
   * the element's own `style` attribute in the template, which means the set of
   * expressible properties is every CSS property rather than the subset the
   * translator can spell. `transform`, which a drag produces and which has no
   * utility, is writable on this lane; on the React one only a plain translate
   * is, through the vendor's move record (`core/moves.ts`).
   *
   * Returns the properties that could not be queued, in the same shape the
   * React lane returns, so the toast and the ledger stay one code path. The
   * only way to land there is an element Angular does not own — inside a
   * third-party web component, say — which is a real answer, not a shortfall
   * in the translator.
   */
  const writeStylesAngular = (
    selection: Selection,
    writes: StyleWrite[],
    known?: readonly StyleWrite[]
  ): string[] => {
    const before =
      known ??
      writes.map((write) => ({
        property: write.property,
        value: currentValue(selection.element, write.property),
      }))
    for (const write of writes) {
      selection.element.style.setProperty(write.property, write.value)
    }

    /*
     * A declaration that changes nothing is not an edit, and on this lane that
     * distinction reaches the file.
     *
     * The inspector's numeric fields commit on `change` as well as on Enter, so
     * leaving one by clicking the canvas re-commits the value it was showing.
     * Selecting an element, looking at it, and clicking the next one therefore
     * arrives here as "set opacity to 1" for an element already at 1. The
     * React lane turns that into a utility class nobody notices; here it would
     * write `style="opacity: 1"` into the template of every element the user
     * merely passed through on the way to the one they meant.
     *
     * Compared through `currentValue` in both directions rather than against
     * the input string, because the browser re-serializes what it is given —
     * `rgb(0,0,255)` reads back as `rgb(0, 0, 255)`, and a string compare would
     * call that a change.
     */
    const changed = writes.filter(
      (write, index) => currentValue(selection.element, write.property) !== before[index].value
    )
    if (!changed.length) return []
    if (queueAngularStyles(selection.element, changed)) return []

    const className = selection.element.getAttribute("class") ?? ""
    for (const write of changed) {
      const index = writes.indexOf(write)
      strand(selection, {
        className,
        property: write.property,
        from: before[index].value,
        to: write.value,
      })
    }
    return changed.map((write) => write.property)
  }

  /*
   * `known` is the caller's own read of every property's value from before any
   * of these writes, when it already took one — `applyStyles` and
   * `commitStyles` both do, to decide whether the edit is a step. Reading it a
   * second time here would be a forced style recalc per property, each one
   * landing straight after the previous property's `setProperty`.
   */
  const writeStyles = (
    selection: Selection,
    writes: StyleWrite[],
    known?: readonly StyleWrite[]
  ): string[] => {
    if (isAngularHost()) return writeStylesAngular(selection, writes, known)

    const updates: ClassUpdate[] = []
    const keys: string[] = []
    const dropped: string[] = []
    // What each queued write would have to say for itself if it never reaches
    // source. Collected here rather than rebuilt in the fallback because by the
    // time resolution answers, the "from" is long overwritten by the preview.
    const translated: Array<{ property: string; from: string; to: string }> = []
    const className = selection.element.getAttribute("class") ?? ""

    for (const [index, write] of writes.entries()) {
      // Read before the write: a preview-only change is only actionable as
      // "from this, to that", and after `setProperty` the "from" is gone.
      const before = known?.[index]?.value ?? currentValue(selection.element, write.property)
      // A move reaches source through the vendor's move record rather than a
      // utility class (`core/moves.ts`). Asked before the write, because the
      // record keeps the inline transform the element had before its first move.
      const moved =
        write.property === "transform" &&
        writeMove(bridge, selection.element, before, write.value, () => ensureSource(selection), () =>
          strand(selection, { className, property: write.property, from: before, to: write.value })
        )
      selection.element.style.setProperty(write.property, write.value)
      if (moved) continue

      const update = toClassUpdate(write.property, write.value)
      if (!update) {
        // Preview-only. Recorded rather than swallowed so the toolbar can say
        // which properties will not survive "Apply to code", and so the change
        // prompt can hand the agent the one edit this editor cannot make.
        //
        // Recorded synchronously with whatever file is known now, because the
        // toast reads the list on the very next line. The path is patched in
        // when resolution lands, which is usually a few hundred milliseconds
        // after that and always long before anyone presses copy.
        const entry = recordPreviewOnly({
          filePath: selection.source?.filePath ?? null,
          componentName: selection.componentName,
          tagName: selection.element.tagName.toLowerCase(),
          className: selection.element.getAttribute("class") ?? "",
          property: write.property,
          from: before,
          to: write.value,
        })
        void ensureSource(selection).then((source) => {
          if (source && !entry.filePath) entry.filePath = source.filePath
        })
        dropped.push(write.property)
        continue
      }
      updates.push(update)
      keys.push(propertyKey(write.property))
      translated.push({ property: write.property, from: before, to: write.value })
    }

    // Only the writes in `updates` are stranded here. The branch above already
    // recorded the ones the translator could not spell, and recording those a
    // second time would put the same loss in front of the user twice.
    if (updates.length) {
      queue(selection, updates, keys, () => {
        for (const write of translated) strand(selection, { className, ...write })
      })
    }
    return dropped
  }

  const writeClasses = (selection: Selection, write: ClassWrite): void => {
    const element = selection.element
    // Source resolution must see the element that exists in JSX, not the
    // already-mutated preview. A large removal can otherwise erase enough of
    // the identity for the vendor's overlap matcher to lose the node.
    const identity = {
      className: element.getAttribute("class") ?? "",
      parentClassName: element.parentElement?.getAttribute("class") ?? undefined,
    }
    for (const name of write.remove) element.classList.remove(name)
    for (const name of write.add) element.classList.add(name)

    if (isAngularHost()) {
      if (!queueAngularClasses(element, write)) {
        strand(selection, {
          className: identity.className,
          property: "class",
          from: identity.className,
          to: element.getAttribute("class") ?? "",
        })
      }
      return
    }

    const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const additions = [...new Set(write.add.filter((name) => !write.remove.includes(name)))]
    const removals = [...new Set(write.remove)]
    const updates: ClassUpdate[] = []
    const keys: string[] = []

    // The pinned writer has no remove verb. Replacing an exact class with an
    // empty standalone token removes it; pairing a removal with an addition
    // also avoids the double-space the empty token necessarily leaves behind.
    for (const removed of removals) {
      const replacement = additions.shift() ?? ""
      updates.push({
        tailwindPrefix: removed,
        tailwindToken: replacement,
        value: replacement,
        standalone: true,
        classPattern: `^${escape(removed)}$`,
      })
      keys.push(`class:${removed}`)
    }
    for (const added of additions) {
      updates.push({
        tailwindPrefix: added,
        tailwindToken: added,
        value: added,
        standalone: true,
        classPattern: `^${escape(added)}$`,
      })
      keys.push(`class:${added}`)
    }
    if (updates.length) {
      // One entry for the whole write, not one per token: what an agent needs
      // is the class attribute it should end up with, and a variant swap is
      // half a dozen tokens moving together. The element is described by the
      // class list it had BEFORE the write, because that is still what stands
      // in the JSX — the write is stranded precisely because it never got
      // there.
      const after = element.getAttribute("class") ?? ""
      queue(
        selection,
        updates,
        keys,
        () =>
          strand(selection, {
            className: identity.className,
            property: "class",
            from: identity.className,
            to: after,
          }),
        identity
      )
    }
  }

  const writeText = (selection: Selection, text: string): void => {
    const element = selection.element
    const originalText = element.textContent ?? ""
    element.textContent = text

    if (isAngularHost()) {
      if (!queueAngularText(element, text)) {
        strand(selection, {
          className: element.getAttribute("class") ?? "",
          property: "text",
          from: originalText,
          to: text,
        })
      }
      return
    }
    // The identity the AST matcher needs is read here, before the await: by the
    // time source resolves, a re-render may have replaced the classes we would
    // otherwise send, and the matcher scores JSX against them.
    const className = element.getAttribute("class") || undefined
    const parentClassName = element.parentElement?.getAttribute("class") || undefined
    const post = (source: SourceRef) => {
      bridge.send({
        type: "updateText",
        filePath: source.filePath,
        lineNumber: source.lineNumber,
        columnNumber: source.columnNumber ?? 0,
        componentName: source.componentName,
        tagName: element.tagName.toLowerCase(),
        className,
        parentTagName: element.parentElement?.tagName.toLowerCase(),
        parentClassName,
        nthOfType: nthOfType(element),
        originalText,
        newText: text,
      })
    }
    // Same split as `queue`: immediate when the file is known, and only then.
    if (selection.source?.filePath) {
      post(selection.source)
      return
    }
    void ensureSource(selection).then((source) => {
      if (source) post(source)
    })
  }

  /**
   * A deletion that will never reach source, written down instead.
   *
   * `remove` is its own property name in the ledger for the same reason `icon`
   * and `class` are: an agent told to "set remove to true" would go looking for
   * a CSS declaration. `change-prompt` spells this one as a sentence.
   */
  const strandRemoval = (removal: Removal) => {
    recordPreviewOnly({
      filePath: removal.selection.source?.filePath ?? null,
      componentName: removal.componentName,
      tagName: removal.target.tagName,
      className: removal.target.classes.join(" "),
      property: "remove",
      from: removal.label,
      to: "",
    })
  }

  /**
   * Queues the source half of one deletion.
   *
   * The two hosts need different things and the split is not cosmetic. The
   * Angular server locates an element by component name and descriptor, so it
   * can be handed the job immediately and the file it eventually names is its
   * own answer. The React server has only a file to open, so there is nothing
   * to send until resolution lands — the same "synchronous when the file is
   * known, deferred when it is not" shape as `queue`, and the same ending: a
   * change with nowhere to go is written to the ledger rather than dropped.
   */
  const queueSourceRemoval = (removal: Removal) => {
    const operation = (source: SourceRef | null): RemovalOperation => ({
      op: "removeElement",
      componentName: removal.componentName,
      filePath: source?.filePath ?? null,
      lineNumber: source?.lineNumber ?? 0,
      columnNumber: source?.columnNumber ?? 0,
      target: removal.target,
    })

    if (isAngularHost()) {
      if (!removal.componentName) {
        strandRemoval(removal)
        return
      }
      const queued = queueRemoval(removal.element, operation(removal.selection.source ?? null))
      // Not awaited and not required: the server finds the template from the
      // component name. The path is filled in only so an Apply that happens to
      // race resolution still reports the file it wrote.
      void ensureSource(removal.selection).then((source) => {
        if (source && !queued.filePath) queued.filePath = source.filePath
      })
      return
    }

    const known = removal.selection.source
    if (known?.filePath) {
      queueRemoval(removal.element, operation(known))
      return
    }
    void ensureSource(removal.selection).then((source) => {
      // Undone while resolution was in flight. The element is back, and queueing
      // now would delete from source something the user has already taken back.
      if (!removal.element.hasAttribute(DELETED_ATTRIBUTE)) return
      if (source?.filePath) queueRemoval(removal.element, operation(source))
      else strandRemoval(removal)
    })
  }

  /**
   * Gone from the page, and owed to source. No toast and no history entry.
   *
   * `!important` because the preview has to beat the element's own class, and a
   * card whose stylesheet says `display: flex` would otherwise stay on screen
   * looking deleted to the layers tree and present to the user.
   */
  const writeRemovals = (removals: Removal[]): void => {
    for (const removal of removals) {
      removal.element.setAttribute(DELETED_ATTRIBUTE, "")
      removal.element.style.setProperty("display", "none", "important")
      queueSourceRemoval(removal)
    }
  }

  /**
   * Back on the page, and owed to nobody.
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
      unqueueRemoval(removal.element)
    }
  }

  /**
   * Both directions of a swap, with no toast and no history entry — the same
   * split as `writeStyles`, for the same reason.
   *
   * A `null` in `root` means the variant does not set that attribute, so it is
   * removed rather than blanked: a stroke-drawn glyph swapped for a filled one
   * must lose `stroke-width`, not carry it as an empty string.
   */
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
      const dropped = writeStyles(selection, writes, before)

      // A write that changed nothing is not a step. A numeric field commits on
      // both Enter and `change`, so one edit arrives here twice; recording the
      // second would make the first Cmd+Z a no-op — measured as exactly that
      // before this guard. Reading the "after" back through `currentValue`
      // rather than comparing to `write.value` keeps the two sides in the same
      // serialization: the browser rewrites `rgb(0,0,255)` as `rgb(0, 0, 255)`,
      // and a string compare against the input would call that a change.
      const changed = before.some(
        (entry) => currentValue(selection.element, entry.property) !== entry.value
      )
      if (changed) {
        // `dropped` is the fork that already decided which of these will never
        // reach source — the translator could not spell them — so it is also
        // the honest answer to "is this edit in the file or only in pixels".
        // Filtered to the writes that moved for the same reason the step is:
        // a field re-committing the value it was showing is not an edit, and
        // the outbox is read by an agent that would act on it.
        journalStep(
          {
            label: summary,
            undo: () => writeStyles(selection, before),
            redo: () => writeStyles(selection, writes),
          },
          before
            .filter((entry) => currentValue(selection.element, entry.property) !== entry.value)
            .map((entry) => ({
              property: entry.property,
              from: entry.value,
              to: currentValue(selection.element, entry.property),
              element: selection.element,
              written: !dropped.includes(entry.property),
            }))
        )
      }

      // Silent on success: the edit is on screen, and direct manipulation does
      // not narrate itself (see "WHEN TO TOAST" in `core/toast.ts`). A dropped
      // property is the exception — the change is on screen, so this message is
      // the only thing that can tell the user it will not reach source. Drag
      // and arrow-nudge both land here and both write `transform`, which has no
      // utility: a plain translate reaches source as the vendor's move record
      // (`core/moves.ts`), and one that also rotates or scales lands here.
      if (dropped.length === writes.length && dropped.length > 0) {
        bridge.toast(`${summary}: preview only (${dropped.join(", ")})`, "error")
      } else if (dropped.length > 0) {
        bridge.toast(`${summary}: ${dropped.join(", ")} is preview only`, "error")
      }
    },

    applyClasses(selection, write, summary) {
      const before = selection.element.getAttribute("class") ?? ""
      writeClasses(selection, write)
      // Same rule as `applyStyles`: re-picking the radius already applied is
      // not a step, and the class list is the honest reading of whether the
      // add/remove pair moved anything.
      const after = selection.element.getAttribute("class") ?? ""
      if (after !== before) {
        // One entry for the whole write, matching the ledger: what an agent
        // needs is the class attribute to end up with, and a variant swap is
        // half a dozen tokens moving together.
        journalStep(
          {
            label: summary,
            undo: () => writeClasses(selection, { remove: write.add, add: write.remove }),
            redo: () => writeClasses(selection, write),
          },
          [
            {
              property: "class",
              from: before,
              to: after,
              element: selection.element,
              written: true,
            },
          ]
        )
      }
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
        [{ property: "text", from: before, to: text, element: selection.element, written: true }]
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
      // Preview only, and said so every time rather than once in a hint the
      // user scrolled past: the source writer speaks in classes and text, and
      // an icon is neither — the JSX still names the component it always did.
      //
      // Which makes it the clearest case for the change prompt: the only way
      // this reaches source is an agent editing the import and the tag, so the
      // swap is recorded with both names for it to act on.
      //
      // BEFORE `record`, which is the ordering `writeStyles` already has and
      // this had backwards: pushing the history entry repaints the toolbar, and
      // the toolbar decides whether "Copy change prompts" is live by reading
      // this ledger. Recorded after, the swap left the one button that could
      // act on it disabled until some later, unrelated repaint.
      const entry = recordPreviewOnly({
        filePath: selection.source?.filePath ?? null,
        componentName: selection.componentName,
        tagName: element.tagName.toLowerCase(),
        className: element.getAttribute("class") ?? "",
        property: "icon",
        from: before.name ?? "",
        to: variant.name,
      })
      void ensureSource(selection).then((source) => {
        if (source && !entry.filePath) entry.filePath = source.filePath
      })
      // `written: false`, always: the JSX still names the component it always
      // did, so this one reaches source only by an agent editing the import
      // and the tag — which is the same thing the ledger entry above says.
      journalStep(
        {
          label: `Swap icon to ${variant.name}`,
          undo: () => writeIcon(element, attribute, before),
          redo: () => writeIcon(element, attribute, after),
        },
        [
          {
            property: "icon",
            from: before.name ?? "",
            to: variant.name,
            element,
            written: false,
          },
        ]
      )
      // No toast. Preview-only is this lane's normal outcome, not a loss: the
      // swap is in the ledger above, and the Changes tab lists it for the agent.
    },

    applyAttribute(selection, name, value, target) {
      // The host when the caller named one, the selection otherwise. Every
      // read below — the "before", the tag, the class list the ledger records —
      // comes off this element rather than off the selection, because the whole
      // point of the parameter is that they can be different nodes and it is
      // the one being written that an agent has to go and find.
      const element = target ?? selection.element
      // `class` and `style` have lanes of their own that reach the file; an
      // attribute write that quietly took one of them over would turn a
      // committable edit into a preview nobody asked for.
      if (!name || name === "class" || name === "style") return
      const before = element.getAttribute(name)
      if (before === value) return

      writeAttribute(element, name, value)

      // BEFORE `record`, the ordering `applyIcon` documents: pushing the
      // history step repaints the toolbar, and the toolbar decides whether
      // "Copy change prompts" is live by reading this ledger.
      const property = `attribute:${name}`
      const entry = recordPreviewOnly({
        filePath: selection.source?.filePath ?? null,
        componentName: selection.componentName,
        tagName: element.tagName.toLowerCase(),
        className: element.getAttribute("class") ?? "",
        property,
        from: before ?? "",
        to: value ?? "",
      })
      void ensureSource(selection).then((source) => {
        if (source && !entry.filePath) entry.filePath = source.filePath
      })

      const summary = value === null ? `Clear ${name}` : `Set ${name} to ${value}`
      // `written: false`, always: the template still spells the attribute it
      // always did, so this reaches source only by an agent editing it — which
      // is the same thing the ledger entry above says.
      journalStep(
        {
          label: summary,
          undo: () => writeAttribute(element, name, before),
          redo: () => writeAttribute(element, name, value),
        },
        [{ property, from: before ?? "", to: value ?? "", element, written: false }]
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
          // The ledger's sentinel, spelled the same way here. `to` is empty
          // because a deletion has no value to end on — the instruction is the
          // property, and `change-prompt` renders it as a sentence.
          property: "remove",
          from: removal.label,
          to: "",
          element: removal.element,
          written: true,
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
        // Filled by the write below, per element rather than per batch: the
        // React lane drops a property the translator cannot spell, which is
        // the same answer for every element, but the Angular lane drops one
        // it could not place in a template, which is not.
        dropped: [] as string[],
      }))

      for (const edit of planned) edit.dropped = writeStyles(edit.selection, edit.writes, edit.before)

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

      if (moved.length) {
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
              written: !edit.dropped.includes(entry.property),
            }))
          )
        )
      }

      // At most one toast, in the branches `applyStyles` uses (silent on
      // success), counted across the whole batch. Aggregated by PROPERTY NAME
      // rather than by occurrence: five elements that all failed to spell
      // `align-self` lost one thing, said once, not the same word five times.
      const dropped = planned.flatMap((edit) => edit.dropped)
      const names = [...new Set(dropped)]
      const total = planned.reduce((count, edit) => count + edit.writes.length, 0)
      if (dropped.length === total && dropped.length > 0) {
        bridge.toast(`${summary}: preview only (${names.join(", ")})`, "error")
      } else if (dropped.length > 0) {
        bridge.toast(`${summary}: ${names.join(", ")} is preview only`, "error")
      }
    },

    untranslated() {
      return untranslatedProperties()
    },
  }
}
