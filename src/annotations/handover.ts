/**
 * The one way a session leaves the editor: copied, or sent.
 *
 * There were three copies and two sends. The Changes tab and the toolbar's
 * `notes.copy` chord each built the brief and wrote the clipboard with their
 * own counting — one said "2 edits", the other "2 changes" — and the tab split
 * finishing a session across "Apply to code" and "Send to agent", which made the
 * designer route their own change by guessing whether the writer could spell
 * it. Every surface now calls these two functions, so a copy from the chord and
 * a copy from the panel are the same act with the same words.
 *
 * `handOver` is the send flow, and it writes nothing. It used to write every
 * edit the codemod could spell first and send only the rest, which left the
 * designer's change split between two writers that disagreed about class
 * order, tokens and component boundaries. Now every edit is a note like any
 * other: the editor previews it, and the agent makes it in code.
 *
 * ## The send, as one value
 *
 * A send used to be a `sending` flag in the tab, a result nobody read and a
 * toast. A second press re-sent every item, a note pinned while the request
 * was in flight was cleared by "Clear on copy or send" although the brief never
 * carried it, and a send that reached no agent cleared the list anyway. Now:
 *
 *   idle | sent | failed --press (something new)--> sending{token, itemIds}
 *   sending{t} --reply ok, delivered|queued------> sent{at, outcome}   stamps itemIds sent, clears only itemIds if asked
 *   sending{t} --reply ok, undelivered-----------> sent{at, outcome}   stamps nothing, clears nothing
 *   sending{t} --reply refused / unreachable-----> failed{reason}
 *   sending{t} --a reply for a token not t-------> (ignored)
 *
 * `sendState()` is the one reader and `moveSend()` the one writer. The token
 * is what makes a stale completion harmless.
 */

import { isProjectSourcePath } from "../core/bridge"
import { COPY_REFUSED, copyText } from "../core/clipboard"
import type { ToastMessage } from "../core/toast"
import { requestAgent } from "../ai/transport"
import type { AgentOutcome } from "../core/types"
import { plural } from "../core/format"
import { removeNotesStep } from "./actions"
import { markEditsSent, removeEdit } from "./journal"
import { buildAnnotationBrief, outboxId, outboxItems } from "./output"
import { annotationSettings, markNotesSent } from "./store"
import type { OutboxItem } from "./types"

type Toast = (message: ToastMessage, kind?: "info" | "error") => void

/**
 * What "Send to agent" opens the agent's new session with, ahead of the brief.
 *
 * A send starts a fresh chat rather than landing in whatever conversation the
 * agent happens to be in, and `/goal` makes that session keep going until
 * every item is done instead of stopping after the first.
 */
const SESSION_PROMPT_PREFIX = "/goal get those done: "

/** The new session's first message: the prefix, then the brief verbatim. */
export function sessionPrompt(brief: string): string {
  return `${SESSION_PROMPT_PREFIX}${brief}`
}

/** "3 notes and 2 edits", with whichever half is zero left out. */
function outboxSummary(items: OutboxItem[]): string {
  const notes = items.filter((item) => item.type === "note").length
  const edits = items.length - notes
  return [
    notes ? plural(notes, "note") : null,
    edits ? plural(edits, "edit") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" and ")
}

/**
 * The files the agent should open first, filtered through `isProjectSourcePath`
 * so a compiled chunk never reaches it as a path to go and edit.
 */
function filesInOutbox(items: OutboxItem[]): string[] {
  const files = new Set<string>()
  for (const item of items) {
    const path = item.type === "note" ? item.note.target?.filePath : item.edit.target?.filePath
    if (path && isProjectSourcePath(path)) files.add(path)
  }
  return [...files]
}

/**
 * Empty the handed-over items when the setting says a handover is the end of
 * them. Called only once a copy has RESOLVED or a send reached the queue, so a
 * refused clipboard or an undelivered send can never cost the list — and only
 * with the items the brief carried, so anything added since stays.
 *
 * Notes leave as one step on the undo timeline, so Cmd+Z brings them back.
 * Edits leave like a dismissed row (`removeEdit`): their previews stay on the
 * page, and the brief that described them is with the agent.
 */
function clearIfAsked(items: OutboxItem[]): void {
  if (!annotationSettings().clearOnCopy) return
  removeNotesStep(items.filter((item) => item.type === "note").map(outboxId))
  for (const item of items) if (item.type === "edit") removeEdit(item.edit.id)
}

/**
 * Copy the whole session as one brief.
 *
 * `copyText` is called synchronously inside the caller's click or key task,
 * before anything awaits: both of its routes need the transient activation the
 * gesture carries. Returns false when there was nothing to copy, so a caller
 * raises its tick only for a real copy. The toast waits for the answer, a
 * microtask or more later, so a refusal never follows a "Copied" it
 * contradicts; a refusal also comes back through `onRefused`.
 */
export function copyHandover(toast: Toast, onRefused?: () => void): boolean {
  const items = outboxItems()
  if (!items.length) {
    toast("Nothing to copy. Pin a note or make an edit first.")
    return false
  }
  const summary = outboxSummary(items)
  void copyText(buildAnnotationBrief(items)).then((copied) => {
    if (!copied) {
      onRefused?.()
      toast(COPY_REFUSED, "error")
      return
    }
    toast(`Copied ${summary}`)
    clearIfAsked(items)
  })
  return true
}

/** Is there anything to send? Every note and every edit goes to the agent. */
export function needsAgent(items: OutboxItem[] = outboxItems()): boolean {
  return items.length > 0
}

/** Has a send that reached the queue already carried this item? */
function wasSent(item: OutboxItem): boolean {
  return Boolean(item.type === "note" ? item.note.sentAt : item.edit.sentAt)
}

/**
 * Is there anything a send would add? With every item already sent, a second
 * press would hand the agent the same work again as if it were new.
 */
export function hasUnsent(items: OutboxItem[] = outboxItems()): boolean {
  return items.some((item) => !wasSent(item))
}

/** What an item asks for, to tell whether it changed while a send was out. */
function itemWords(item: OutboxItem): string {
  return item.type === "note" ? `note:${item.note.comment}` : `edit:${item.edit.property}:${item.edit.to}`
}

/* ---------- the send machine (transition table in the header) ---------- */

type SendState =
  | { kind: "idle" }
  | { kind: "sending"; token: number; itemIds: string[] }
  | { kind: "sent"; at: string; outcome: AgentOutcome; changeId: string | null }
  | { kind: "failed"; reason: string }

let send: SendState = { kind: "idle" }
let tokens = 0
const sendListeners = new Set<() => void>()

export function sendState(): SendState {
  return send
}

export function onSendChange(listener: () => void): () => void {
  sendListeners.add(listener)
  return () => sendListeners.delete(listener)
}

function moveSend(next: SendState): void {
  send = next
  for (const listener of [...sendListeners]) {
    try {
      listener()
    } catch (error) {
      console.warn("[designlayer] send listener failed", error)
    }
  }
}

/** Test seam: back to idle, so a reply still in flight is stale. */
export function resetSendForTest(): void {
  send = { kind: "idle" }
}

/** What one press of "Send to agent" came to. */
interface HandoverResult {
  /** The brief went to the agent route. False when nothing was sent. */
  sent: boolean
  ok: boolean
  /** Where it went; null when nothing was sent or the route refused. */
  outcome: AgentOutcome | null
  changeId: string | null
  /** The items the brief carried. */
  itemIds: string[]
  /** A reply that arrived after the send it answered was superseded. */
  stale: boolean
}

/** Send the whole session to the agent, and put the same prompt on the clipboard. */
export async function handOver(options: { apiBase: string; toast: Toast }): Promise<HandoverResult> {
  const { apiBase, toast } = options
  const nothing: HandoverResult = { sent: false, ok: true, outcome: null, changeId: null, itemIds: [], stale: false }
  if (send.kind === "sending") return nothing
  const items = outboxItems()
  if (!needsAgent(items)) {
    toast("Nothing to send")
    return nothing
  }
  const brief = buildAnnotationBrief(items)
  const itemIds = items.map(outboxId)
  // What each item said when the brief was built. An edit record is mutated
  // in place by a collapse, so its words are copied now, not read later.
  const words = new Map(items.map((item) => [outboxId(item), itemWords(item)]))
  tokens += 1
  const token = tokens
  moveSend({ kind: "sending", token, itemIds })

  /*
   * A send also puts the session prompt on the clipboard, so the designer can
   * paste it into a new chat in any agent when the queue has nobody reading it.
   * The copy runs HERE, before the first await, because both clipboard routes
   * need the click's transient activation.
   */
  const copy = copyText(sessionPrompt(brief))

  const response = await requestAgent(apiBase, {
    // The outbox IS the request; this line is the subject, not the ask.
    prompt: `${outboxSummary(items)} from DesignLayer`,
    brief,
    sessionPrompt: sessionPrompt(brief),
    origin: "prompts",
    files: filesInOutbox(items),
    selection: null,
    ancestry: [],
    url: window.location.href,
  })
  const copied = await copy
  const outcome = response.ok ? (response.outcome ?? "queued") : null
  const changeId = response.changeId ?? null
  const result: HandoverResult = { sent: true, ok: response.ok, outcome, changeId, itemIds, stale: false }
  const now = sendState()
  if (now.kind !== "sending" || now.token !== token) return { ...result, stale: true }

  // The server's own words, whatever they are. A manufactured "Sent!" over a
  // route that answered with a refusal is the one thing this must never do.
  // The clipboard line is ours, and is only said when the copy landed.
  toast(
    copied ? `${response.message.replace(/\.?\s*$/, ".")} Also copied to the clipboard.` : response.message,
    response.ok ? "info" : "error"
  )
  if (!outcome) {
    moveSend({ kind: "failed", reason: response.message })
    return result
  }
  const at = new Date().toISOString()
  // Undelivered reached nobody: nothing is stamped "sent" and nothing is
  // cleared, so the list is still there to send once an agent attaches.
  if (outcome !== "undelivered") {
    // Only what still reads as it did in the brief: a note rewritten or an
    // edit nudged while the send was in flight is a request the agent has not
    // seen, so it stays unsent and stays on the list.
    const carried = outboxItems().filter((item) => words.get(outboxId(item)) === itemWords(item))
    const carriedIds = carried.map(outboxId)
    markNotesSent(carriedIds, at, changeId)
    markEditsSent(carriedIds, at, changeId)
    clearIfAsked(carried)
  }
  moveSend({ kind: "sent", at, outcome, changeId })
  return result
}
