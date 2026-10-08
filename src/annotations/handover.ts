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
 * `handOver` is the send flow, and it is ONE flow in two stages, not two
 * buttons: everything the writer can spell is written first, and only what is
 * left — notes, and edits no commit can write — goes to the agent, with the
 * written half in the brief as context. A session that only moved some padding
 * finishes at the first stage and never waits on an agent round trip, which
 * was the one good reason the two buttons were ever split.
 */

import { isProjectSourcePath } from "../core/bridge"
import type { Committer } from "../core/apply"
import { COPY_REFUSED, copyText } from "../core/clipboard"
import type { ToastMessage } from "../core/toast"
import { requestAgent } from "../ai/transport"
import { clearEdits } from "./journal"
import { buildAnnotationBrief, outboxItems } from "./output"
import { annotationSettings, clearAnnotations } from "./store"
import type { OutboxItem } from "./types"
import { plural } from "../core/format"

type Toast = (message: ToastMessage, kind?: "info" | "error") => void

/**
 * What "Send to agent" opens the agent's new session with, ahead of the brief.
 *
 * A send starts a fresh chat rather than landing in whatever conversation the
 * agent happens to be in, and `/goal` makes that session keep going until
 * every item is done instead of stopping after the first.
 */
export const SESSION_PROMPT_PREFIX = "/goal get those done: "

/** The new session's first message: the prefix, then the brief verbatim. */
export function sessionPrompt(brief: string): string {
  return `${SESSION_PROMPT_PREFIX}${brief}`
}

/** "3 notes and 2 edits", with whichever half is zero left out. */
export function outboxSummary(items: OutboxItem[]): string {
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
export function filesInOutbox(items: OutboxItem[]): string[] {
  const files = new Set<string>()
  for (const item of items) {
    const path = item.type === "note" ? item.note.target?.filePath : item.edit.target?.filePath
    if (path && isProjectSourcePath(path)) files.add(path)
  }
  return [...files]
}

/**
 * Empty the outbox when the setting says a handover is the end of it. Called
 * only once a copy has RESOLVED or a send came back ok, so a refused clipboard
 * can never cost the list.
 */
export function clearIfAsked(): void {
  if (!annotationSettings().clearOnCopy) return
  clearAnnotations()
  clearEdits()
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
    clearIfAsked()
  })
  return true
}

/** Does anything in the outbox still need a person or an agent after a write? */
export function needsAgent(items: OutboxItem[] = outboxItems()): boolean {
  return items.some((item) => item.type === "note" || !item.edit.written)
}

export interface HandoverResult {
  /** The writer ran and wrote something. */
  wrote: boolean
  /** The brief went to the agent route. */
  sent: boolean
  ok: boolean
}

/**
 * Finish the session: write what can be written, then send what is left.
 *
 * The write goes FIRST so the brief that follows describes a source tree that
 * already contains the writable half — an agent handed "set padding to 24px"
 * for an edit that landed a moment ago re-applies it. `applyAll` awaits, so by
 * the time the brief is built those rows read as written and the brief marks
 * them "do not apply again".
 */
export async function handOver(options: {
  apiBase: string
  committer: Committer
  toast: Toast
  /**
   * False when no agent has connected over MCP: the write still runs, and the
   * rest stays in the outbox for Copy rather than going to a queue nobody reads.
   */
  sendToAgent?: boolean
}): Promise<HandoverResult> {
  const { apiBase, committer, toast, sendToAgent = true } = options

  /*
   * A send also puts the session prompt on the clipboard, so the designer can
   * paste it into a new chat in any agent when the queue has nobody reading it.
   * The copy runs HERE, before the first await, because both clipboard routes
   * need the click's transient activation, and the write below can outlast it.
   */
  const before = outboxItems()
  let copy: Promise<boolean> | null =
    sendToAgent && needsAgent(before) ? copyText(sessionPrompt(buildAnnotationBrief(before))) : null

  let wrote = false
  if (committer.hasPendingChanges()) {
    await committer.applyAll()
    wrote = true
  }

  const items = outboxItems()
  const brief = buildAnnotationBrief(items)
  // The write changed what the brief says ("already written, do not apply
  // again"), so copy again to keep the clipboard byte-for-byte what was sent.
  // Best effort: the activation may be spent, and then the first copy stands.
  if (wrote && copy) copy = copy.then((first) => copyText(sessionPrompt(brief)).then((again) => again || first))

  if (!sendToAgent) return { wrote, sent: false, ok: true }
  if (!needsAgent(items)) {
    // Everything was the writer's. There is nothing for an agent to do, and
    // sending it the written rows would only ask it to confirm a diff.
    if (!wrote) toast("Nothing to send")
    return { wrote, sent: false, ok: true }
  }

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
  const copied = copy ? await copy : false
  // The server's own words, whatever they are. A manufactured "Sent!" over a
  // route that answered with a refusal is the one thing this must never do.
  // The clipboard line is ours, and is only said when the copy landed.
  toast(
    copied ? `${response.message.replace(/\.?\s*$/, ".")} Also copied to the clipboard.` : response.message,
    response.ok ? "info" : "error"
  )
  if (response.ok) clearIfAsked()
  return { wrote, sent: true, ok: response.ok }
}
