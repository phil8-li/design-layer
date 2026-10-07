/**
 * Every change the designer made this session, as the outbox reads it back.
 *
 * The panel is one list with two kinds of row. Notes say what is wrong; edits
 * are the part the designer already fixed. `change-prompt.ts` keeps a ledger
 * too and this is deliberately not it — that one holds the SUBSET "Apply to
 * code" could not write, because its job is to be the second half of Apply.
 * This holds every edit, written or not, because its job is to be the record
 * of what happened. An agent handed only the unwritable ones reads a session
 * that moved a card, retyped its heading and deleted its sibling as a session
 * that swapped one icon.
 *
 * Nothing here is persisted, and that is the one decision in this file worth
 * arguing about. `store.ts` writes its notes to `localStorage` because a note
 * is about the design and survives a restart intact. An edit is not: it is a
 * `from` and a `to` against the source tree exactly as it stood when the edit
 * was made. Reload tomorrow, after the file has moved on, and a restored
 * journal hands an agent "set `padding-left` to 24px, currently 16px" for a
 * rule that now reads 32px — a diff against code nobody has. The journal dies
 * with the session on purpose.
 */

import { isAngularHost, owningComponentName } from "../core/angular"
import { nthOfType } from "../core/element-target"
import type { LayerElement } from "../core/types"
import { elementName, fullDomPath, locationPath } from "./identify"
import type { AnnotationTarget, EditRecord } from "./types"
import { HISTORY_LIMIT } from "../core/history"

/** Long enough to recognise the element, short enough not to be the row. */
const MAX_TEXT = 120

/** Ancestors in a selector before it stops helping anyone read it. */
const SELECTOR_DEPTH = 4

interface JournalEntry {
  record: EditRecord
  /**
   * The live node, held so repeats collapse onto one row. Never serialized —
   * nothing here is — and never read for anything the record already says.
   */
  element: Element | null
  /**
   * Whether the writer dispatched this edit to the source writer.
   *
   * Equal to `record.written` at the moment of the edit and kept separately
   * anyway, because `markEditsWritten` OVERWRITES `record.written` when an
   * Apply lands. Once that has happened the flag can no longer answer "was
   * this queued", and rebuilding the answer from it is how a preview-only icon
   * swap comes to be reported as already in the file.
   */
  queued: boolean
}

/**
 * What one `recordEdit` call did, so undo can put it back exactly.
 *
 * A stack of these rather than "delete the newest row" because a row is shared:
 * ten arrow-key nudges are ten timeline steps and one entry, and the first
 * Cmd+Z has to leave the other nine nudges standing.
 */
interface Mutation {
  entry: JournalEntry
  /** Where the entry sat, so an undo restores the order things happened in. */
  index: number
  /** What the entry read before this call, or null when this call created it. */
  previous: { to: string; written: boolean; queued: boolean } | null
  /** Whether this call took the entry out of the list — see `recordEdit`. */
  removed: boolean
}

/**
 * Module-scoped for the reason `change-prompt.ts` gives for its own ledger:
 * the writer fills this, the outbox panel reads it, the brief serializes it,
 * and none of the three owns the other two.
 */
const entries: JournalEntry[] = []
const mutations: Mutation[] = []
/**
 * A backstop on the recordings kept for undo. Each one pins its entry, and the
 * entry its element, so a long session of nudges across routes would otherwise
 * keep every detached subtree alive. Undo can only walk back `HISTORY_LIMIT`
 * steps, and twenty recordings a step is far past any real commit, so what is
 * dropped here is a recording no undo can reach any more.
 */
const MUTATION_LIMIT = HISTORY_LIMIT * 20

function remember(mutation: Mutation): void {
  mutations.push(mutation)
  // Trimmed in a batch rather than one shift per push.
  if (mutations.length > MUTATION_LIMIT + 500) mutations.splice(0, mutations.length - MUTATION_LIMIT)
}
const listeners = new Set<() => void>()

let sequence = 0

function announce(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      // One panel failing to repaint must not stop the next one repainting.
      console.warn("[designlayer] edit journal listener failed", error)
    }
  }
}

/**
 * The component that authored the element, asked the cheap way.
 *
 * Read off the bridge global rather than through `whenBridgeReady()`, which is
 * async and cannot be awaited from inside a write. By the time anything on the
 * page is editable the bridge has been installed for minutes. The Angular lane
 * is separate because the vendor's `elementInfo` answers `null` for every node
 * on that host, and the wrapper in `bridge.ts` that fixes that is applied to
 * the handle the editor holds — not to the global this reads.
 */
function componentNameOf(element: Element): string | null {
  if (isAngularHost()) return owningComponentName(element)?.replace(/^_+/, "") ?? null
  try {
    return window.__DESIGNLAYER_BRIDGE__?.elementInfo(element)?.componentName || null
  } catch {
    // The vendor's fiber walk throws on a node React never mounted.
    return null
  }
}

/** A path good enough to find the element again by hand, and no longer. */
function selectorFor(element: Element): string {
  const parts: string[] = []
  let node: Element | null = element
  while (node && parts.length < SELECTOR_DEPTH) {
    const id = node.getAttribute("id")
    if (id) {
      parts.unshift(`#${id}`)
      break
    }
    const classes = Array.from(node.classList).slice(0, 2)
    const index = nthOfType(node)
    parts.unshift(
      [
        node.tagName.toLowerCase(),
        ...classes.map((name) => `.${name}`),
        index ? `:nth-of-type(${index + 1})` : "",
      ].join("")
    )
    node = node.parentElement
  }
  return parts.join(" > ")
}

/**
 * What the outbox knows about the element an edit happened to.
 *
 * Deliberately thinner than the capture on the annotation path, which reads
 * computed styles, the ancestry and the component stack. This runs INSIDE the
 * write: an arrow-key nudge reaches it on every keypress and an inspector
 * field on every commit, and `getComputedStyle` on each of those is a forced
 * style recalculation the user pays for as lag in the interaction that most
 * has to feel immediate. The trade is also asymmetric. A note is worth the
 * full snapshot because the surrounding context IS the note; an edit carries
 * its own meaning in the `from` and the `to`, and the element only has to be
 * findable. `output.ts` describes an element properly when a note needs it.
 */
function describeEditTarget(element: Element): AnnotationTarget {
  const text = (element.textContent ?? "").trim()
  return {
    tagName: element.tagName.toLowerCase(),
    componentName: componentNameOf(element),
    className: element.getAttribute("class") ?? "",
    id: element.getAttribute("id"),
    selector: selectorFor(element),
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    // Left null rather than guessed: `recordEdit` is handed an element, not a
    // selection, and the writer's own source resolution is a round trip that
    // lands long after this record is on screen. The selector and the
    // component name are what an agent locates this by.
    filePath: null,
    lineNumber: null,
    ancestry: [],
    computed: {},
    components: [],
    // The brief's heading, `**Location:**` and forensic DOM path, the same as a
    // note's. All three read attributes and text nodes only — no style
    // recalculation in the write.
    name: attempt(() => elementName(element)) || element.tagName.toLowerCase(),
    path: attempt(() => locationPath(element)),
    fullPath: attempt(() => fullDomPath(element)),
  }
}

function attempt(read: () => string): string {
  try {
    return read()
  } catch {
    return ""
  }
}

/**
 * Same element, same property — one entry, keeping the original `from`.
 *
 * `change-prompt.ts` answers this with a string built from the component, the
 * tag and the class list, because the row it has to match may outlive the node
 * it describes. Here the element itself is in hand and is the stronger answer:
 * two `<button class="btn">`s side by side are ONE entry under the string and
 * two under this, and they are two edits. It is also the only answer that
 * survives a class edit, which rewrites the very list the string is built from.
 *
 * An edit with no element never collapses. There is no target to build the
 * fallback string out of either, and two unidentifiable edits merged into one
 * row would silently lose one of them.
 */
function collapseTarget(property: string, element: Element | null) {
  if (!element) return undefined
  return entries.find((entry) => entry.record.property === property && entry.element === element)
}

/**
 * Records one edit, collapsing it onto the entry it repeats.
 *
 * Returns the entry the edit landed on, or null when nothing was recorded —
 * and the caller can read that as "there is now one more recording for
 * `dropLastEdit` to take back" versus "nothing happened". Null therefore means
 * exactly one thing: the write ended on the value it started from, which is
 * not an edit and is not worth a row an agent has to read past.
 *
 * A collapse that lands back on the original `from` is the same non-event
 * arrived at in two steps — nudge right, nudge left — so the entry leaves.
 * That call still returns the record, because the entry LEAVING is itself the
 * recording undo has to put back.
 */
export function recordEdit(input: {
  property: string
  from: string
  to: string
  element: Element | null
  written: boolean
}): EditRecord | null {
  if (input.from === input.to) return null

  const existing = collapseTarget(input.property, input.element)
  if (existing) {
    // Dragging writes `transform` once per gesture and nudging once per
    // keypress; what an agent needs is where the element started and where it
    // ended up, not every step in between. The stored `from` and the stored
    // target are the ones captured first, because they describe the element as
    // it stood when the change began — which is what `from` is a fact about.
    const index = entries.indexOf(existing)
    const previous = {
      to: existing.record.to,
      written: existing.record.written,
      queued: existing.queued,
    }
    existing.record.to = input.to
    existing.record.written = input.written
    existing.queued = input.written
    const removed = existing.record.from === input.to
    if (removed) entries.splice(index, 1)
    remember({ entry: existing, index, previous, removed })
    announce()
    return existing.record
  }

  sequence += 1
  const entry: JournalEntry = {
    record: {
      // A counter, not a timestamp: two edits in the same millisecond are two
      // edits, and a collided id would have the panel dismiss both as one.
      id: `edit-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      property: input.property,
      from: input.from,
      to: input.to,
      // Described only here, never on the collapse path: an entry keeps the
      // element as it stood when the change began, and paying for a fresh
      // descriptor on every nudge would put that cost on the writer for a
      // result thrown away on the next line.
      target: input.element ? describeEditTarget(input.element) : null,
      written: input.written,
    },
    element: input.element,
    queued: input.written,
  }
  entries.push(entry)
  remember({ entry, index: entries.length - 1, previous: null, removed: false })
  announce()
  return entry.record
}

/**
 * Every edit this session, oldest first.
 *
 * Oldest first, and a collapse does not reorder — the two together are what
 * lets the outbox interleave edits with notes by `createdAt` and have the
 * array agree with the result. `previewOnlyChanges()` is newest-first and does
 * move a collapsed entry to the front, because a ledger is a to-do list and
 * this is a record of what happened.
 */
export function edits(): EditRecord[] {
  return entries.map((entry) => entry.record)
}

export function editCount(): number {
  return entries.length
}

export function onEditsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Drops one entry, so a row in the outbox can retract just itself.
 *
 * The recordings behind it are neutralized rather than spliced out of the
 * stack. Dismissing a row is not undoable, so none of them may fire again — a
 * later Cmd+Z that re-inserted the dismissed row would put it back on screen
 * with nothing on the timeline left to explain it. But each timeline step
 * drops exactly as many recordings as it made, so shortening the stack from
 * the middle would have some later undo eat an unrelated entry instead. A
 * neutralized recording pops as a no-op and keeps the count honest.
 */
export function removeEdit(id: string): void {
  const index = entries.findIndex((entry) => entry.record.id === id)
  if (index === -1) return
  const [removed] = entries.splice(index, 1)
  for (const mutation of mutations) {
    if (mutation.entry !== removed) continue
    mutation.previous = null
    mutation.removed = false
  }
  announce()
}

export function clearEdits(): void {
  if (!entries.length && !mutations.length) return
  entries.length = 0
  mutations.length = 0
  announce()
}

/**
 * Takes the last recording back, for undo.
 *
 * An undone edit MUST leave the journal, and this is the single most important
 * line in the feature: the outbox is handed to an agent, and an entry the
 * designer explicitly reversed with Cmd+Z is an instruction to put back the
 * thing they just took out. Wrong in the one direction that destroys trust in
 * both halves of the panel at once.
 *
 * Not "delete the newest entry", though, for the reason `Mutation` gives: ten
 * nudges are one entry, and one undo is one nudge. The entry goes back to the
 * `to` it had before the last recording, and only disappears when that
 * recording is what created it.
 */
export function dropLastEdit(): void {
  const mutation = mutations.pop()
  if (!mutation) return

  if (!mutation.previous) {
    const index = entries.indexOf(mutation.entry)
    if (index !== -1) entries.splice(index, 1)
  } else {
    mutation.entry.record.to = mutation.previous.to
    mutation.entry.record.written = mutation.previous.written
    mutation.entry.queued = mutation.previous.queued
    // Back where it was, not on the end: the outbox reads in the order things
    // happened, and an undo does not make an old edit new.
    if (mutation.removed) {
      entries.splice(Math.min(mutation.index, entries.length), 0, mutation.entry)
    }
  }
  announce()
}

/**
 * Apply to code succeeded: what was queued is in the file, not promised to it.
 *
 * Deliberately not a sweep. `written` is already true for everything the
 * translator could spell, because the writer knows that fork at the moment of
 * the edit, so this usually changes nothing — but the tempting one-liner that
 * sets every row written would also promote the icon swap and the stranded
 * `transform`, which are in the outbox precisely BECAUSE Apply wrote nothing
 * for them. An agent told those are already in the file skips the only changes
 * still owed to source.
 */
export function markEditsWritten(): void {
  let moved = false
  for (const entry of entries) {
    if (!entry.queued) continue
    // Clearing `queued` is the point of the call, not bookkeeping beside it.
    //
    // `written` alone cannot answer "has this reached the file", because the
    // writer sets it at the MOMENT OF THE EDIT for anything it can spell —
    // long before anyone presses Apply. Read on its own it means "this is
    // writable", and the Changes tab spent a version telling designers a
    // padding tweak was already in their files because of it.
    //
    // `queued` is the missing half: set beside `written` when the edit is
    // recorded, cleared here when the commit that owed it has run. Ready and
    // In-your-files are the two sides of this flag, and nothing else in the
    // journal can tell them apart.
    entry.queued = false
    if (!entry.record.written) entry.record.written = true
    moved = true
  }
  if (moved) announce()
}

/**
 * Is this edit still owed to a file?
 *
 * True between the edit and the commit that writes it. The panel needs the
 * distinction and `written` cannot carry it — see `markEditsWritten` — so the
 * flag is read through here rather than copied onto `EditRecord`, where it
 * would become a fourth piece of state for `recordEdit`'s collapse path to
 * keep consistent and for the brief to have an opinion about.
 */
export function isEditQueued(id: string): boolean {
  return entries.some((entry) => entry.record.id === id && entry.queued)
}

/**
 * How many edits still want something: not writable, or writable and queued.
 *
 * The edit half of `owedCount`, in one pass. Asking `isEditQueued` per row was
 * a scan per row, run by the tab badge on every announce.
 */
export function owedEditCount(): number {
  let owed = 0
  for (const entry of entries) if (!entry.record.written || entry.queued) owed += 1
  return owed
}

/**
 * One row, by id, for a caller that has to act on it rather than draw it.
 *
 * `edits()` hands out a list for rendering; this answers the single question
 * "what was this row" without making the caller scan that list. Returned as-is
 * rather than cloned, because the one caller — `core/withdraw.ts` — reads it
 * and never writes it, and a clone would only invite somebody to mutate the
 * copy and wonder why nothing happened.
 */
export function editRecord(id: string): EditRecord | null {
  return entries.find((entry) => entry.record.id === id)?.record ?? null
}

/**
 * The live node a row is about.
 *
 * Deliberately NOT a field on `EditRecord`, which is the serializable half and
 * goes to briefs and clipboards where a DOM node means nothing. It lives on the
 * private `JournalEntry` for the collapse rule, and this is the one door out —
 * opened because withdrawing a change needs the element both to un-queue the
 * operation and to put the preview back, and a descriptor can do neither.
 *
 * Null once the app has re-rendered the node away, which is a real state rather
 * than an error: the row is still droppable, there is simply nothing left on
 * screen to revert.
 */
export function editElement(id: string): LayerElement | null {
  // The entry stores it as a plain `Element` because that is all the collapse
  // rule needs to compare by identity. Every element that reaches the journal
  // came from a selection, so it is a `LayerElement`; the cast states that
  // rather than widening the field and making every reader re-narrow it.
  return (entries.find((entry) => entry.record.id === id)?.element as LayerElement) ?? null
}

/**
 * Apply to code REFUSED one operation: take back the claim that it landed.
 *
 * The writer decides `written` when the edit is made, and on an Angular host it
 * answers true for a style the template writer can express. The server gets the
 * last word and can disagree: two `<div class="auth-row__icon">` in one
 * template score identically, so `matchNode` returns null rather than guess,
 * and the write is refused at commit time with the element already repainted.
 *
 * Left alone, that row sits in the outbox reading "In source". It is the one
 * field an agent acts on differently — told a change is already in the file it
 * skips it, and the change is then in nobody's hands: not the editor's, which
 * refused it, and not the agent's, which was told not to bother. Silently
 * losing a change is worse than either making it or reporting it undone.
 *
 * Matched on tag, classes and property, which is the identity the server
 * refused on. A descriptor ambiguous enough to be refused THERE is precise
 * enough to find the row here.
 */
export function markEditRefused(match: {
  tagName: string
  className: string
  property: string
}): void {
  let changed = false
  for (const entry of entries) {
    const target = entry.record.target
    if (!target) continue
    if (!entry.record.written) continue
    if (entry.record.property !== match.property) continue
    if (target.tagName !== match.tagName) continue
    if (target.className !== match.className) continue
    entry.record.written = false
    entry.queued = false
    changed = true
  }
  if (changed) announce()
}

/** Test seam: the journal is module state, and a case must start empty. */
export function resetJournalForTest(): void {
  entries.length = 0
  mutations.length = 0
  sequence = 0
}
