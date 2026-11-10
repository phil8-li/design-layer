/**
 * Saved control defaults: whether a control's default is written in the
 * project's source, and the requests that read, write and delete it.
 *
 * This is one of the two explicit source writes the editor still makes (the
 * other is a lint fix), so every press must be one request and every row must
 * say what the file holds. The state is kept per URL — one URL is one entry in
 * one defaults file — and outlives the rows, which the Design options pane
 * rebuilds on every store write.
 *
 * ## The machine, per URL
 *
 *   unknown | unavailable --approach-->  loading
 *   loading  --200-->                    saved | absent
 *   loading  --error-->                  unavailable
 *   any settled or loading --Apply-->    saving   (a GET still in flight is dropped)
 *   saving   --ok-->                     saved
 *   saving   --error-->                  the state it left
 *   saved    --Delete-->                 deleting
 *   deleting --ok-->                     absent
 *   deleting --error-->                  saved
 *
 * Every request carries a generation token in the state it moved to, and a
 * completion whose token is no longer current changes nothing, so a GET that
 * answers after a PUT cannot put "not saved" back on a row that just saved.
 * While `saving` or `deleting` neither button can send another write.
 *
 * `defaultStatus(url)` is the one reader; `move` is the one writer.
 */

/** A settled answer, or no answer yet. */
export type KnownDefault = "unknown" | "saved" | "absent" | "unavailable"

export type DefaultStatus =
  | { kind: KnownDefault }
  | { kind: "loading"; token: number; from: KnownDefault }
  | { kind: "saving"; token: number; from: KnownDefault }
  | { kind: "deleting"; token: number; from: KnownDefault }

/** What a request ended as, for the row that asked: a toast for `done` and `failed`, nothing for the rest. */
export type DefaultOutcome = "done" | "failed" | "stale" | "refused"

const statuses = new Map<string, DefaultStatus>()
const watchers = new Map<string, Set<(status: DefaultStatus) => boolean>>()
let generation = 0

export function defaultStatus(url: string): DefaultStatus {
  return statuses.get(url) ?? { kind: "unknown" }
}

/** The last settled answer, which is what a row prints while a request runs. */
export function knownDefault(status: DefaultStatus): KnownDefault {
  return status.kind === "loading" || status.kind === "saving" || status.kind === "deleting" ? status.from : status.kind
}

/** Whether a write for this URL is on its way to the file. */
export function writing(status: DefaultStatus): boolean {
  return status.kind === "saving" || status.kind === "deleting"
}

function move(url: string, next: DefaultStatus): void {
  statuses.set(url, next)
  const listening = watchers.get(url)
  if (!listening) return
  for (const paint of Array.from(listening)) {
    if (!paint(next)) listening.delete(paint)
  }
}

/** Calls `paint` on every change for `url` until it returns false (its row left the document). */
export function watchDefault(url: string, paint: (status: DefaultStatus) => boolean): void {
  let listening = watchers.get(url)
  if (!listening) watchers.set(url, (listening = new Set()))
  listening.add(paint)
}

const current = (url: string, token: number): boolean => {
  const status = defaultStatus(url)
  return "token" in status && status.token === token
}

/** Reads whether the default is saved. Only from `unknown` or `unavailable`. */
export async function readDefault(url: string): Promise<DefaultOutcome> {
  const from = defaultStatus(url)
  if (from.kind !== "unknown" && from.kind !== "unavailable") return "refused"
  const token = ++generation
  move(url, { kind: "loading", token, from: from.kind })
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const result = (await response.json()) as { exists?: boolean }
    if (!current(url, token)) return "stale"
    move(url, { kind: result.exists === true ? "saved" : "absent" })
    return "done"
  } catch {
    if (!current(url, token)) return "stale"
    move(url, { kind: "unavailable" })
    return "failed"
  }
}

/** Writes `value` as the default. Refused while another write runs. */
export async function writeDefault(url: string, value: unknown): Promise<DefaultOutcome> {
  const from = defaultStatus(url)
  if (writing(from)) return "refused"
  const token = ++generation
  const back = knownDefault(from)
  move(url, { kind: "saving", token, from: back })
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (current(url, token)) move(url, { kind: "saved" })
    return "done"
  } catch {
    if (current(url, token)) move(url, { kind: back })
    return "failed"
  }
}

/** Deletes the saved default. Only once the row knows one exists. */
export async function deleteDefault(url: string): Promise<DefaultOutcome> {
  const from = defaultStatus(url)
  if (from.kind !== "saved") return "refused"
  const token = ++generation
  move(url, { kind: "deleting", token, from: "saved" })
  try {
    const response = await fetch(url, { method: "DELETE" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (current(url, token)) move(url, { kind: "absent" })
    return "done"
  } catch {
    if (current(url, token)) move(url, { kind: "saved" })
    return "failed"
  }
}
