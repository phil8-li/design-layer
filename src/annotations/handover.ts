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
 */

import { isProjectSourcePath } from "../core/bridge"
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

/** Is there anything to send? Every note and every edit goes to the agent. */
export function needsAgent(items: OutboxItem[] = outboxItems()): boolean {
  return items.length > 0
}

export interface HandoverResult {
  /** The brief went to the agent route. */
  sent: boolean
  ok: boolean
}

/** Send the whole session to the agent, and put the same prompt on the clipboard. */
export async function handOver(options: { apiBase: string; toast: Toast }): Promise<HandoverResult> {
  const { apiBase, toast } = options
  const items = outboxItems()
  if (!needsAgent(items)) {
    toast("Nothing to send")
    return { sent: false, ok: true }
  }
  const brief = buildAnnotationBrief(items)

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
  // The server's own words, whatever they are. A manufactured "Sent!" over a
  // route that answered with a refusal is the one thing this must never do.
  // The clipboard line is ours, and is only said when the copy landed.
  toast(
    copied ? `${response.message.replace(/\.?\s*$/, ".")} Also copied to the clipboard.` : response.message,
    response.ok ? "info" : "error"
  )
  if (response.ok) clearIfAsked()
  return { sent: true, ok: response.ok }
}
