/**
 * The note operations a person performs, each one a step on the editor's single
 * undo timeline.
 *
 * Notes and edits used to have two ways back. An edit went through
 * `core/history.ts`, so Cmd+Z took it back; a note had a toast with its own
 * Undo button for a delete and nothing at all for a pin or a rewrite, so Cmd+Z
 * after pinning a note reverted the padding change made before it instead. One
 * list in the Changes tab and two timelines behind it is the list lying about
 * what Undo will do.
 *
 * So every note gesture records here, beside the writer's steps, and the store
 * keeps its raw primitives for the replays — the same split `core/writer.ts`
 * uses between its public writes and the private ones a step calls. A replay
 * through these functions would record the inverse of the inverse and Cmd+Z
 * would oscillate; a replay through the store records nothing, by construction.
 *
 * Every inverse is written to survive the list having moved under it: a note
 * cleared by "Clear on copy" makes the step that pinned it a no-op rather than
 * an error, because `removeAnnotation` answers null for an id it does not hold
 * and `restoreAnnotation` refuses an id already present.
 */

import { record, undoStep, type HistoryStep } from "../core/history"
import {
  addAnnotation,
  annotations,
  clearAnnotations,
  removeAnnotation,
  restoreAnnotation,
  updateAnnotation,
} from "./store"
import type { AnnotationRecord } from "./types"

/** Pin a new note. Undo takes it off the page; redo puts back the SAME note. */
export function pinNote(input: Parameters<typeof addAnnotation>[0]): AnnotationRecord {
  const note = addAnnotation(input)
  let index = annotations().findIndex((entry) => entry.id === note.id)
  record({
    label: "Pin note",
    undo: () => {
      const removed = removeAnnotation(note.id)
      if (removed) index = removed.index
    },
    redo: () => restoreAnnotation(note, index),
  })
  return note
}

/** Rewrite a note's words. A rewrite to the same words is not a step. */
export function rewriteNote(id: string, comment: string): void {
  const before = annotations().find((note) => note.id === id)
  if (!before || before.comment === comment) return
  const previous = before.comment
  updateAnnotation(id, { comment })
  record({
    label: "Edit note",
    undo: () => updateAnnotation(id, { comment: previous }),
    redo: () => updateAnnotation(id, { comment }),
  })
}

/**
 * Delete one note, and hand back the step so the caller can offer it back.
 *
 * The toast's Undo is `undoNoteStep(step)`, which is Cmd+Z when the delete is
 * still the newest thing on the timeline — so the two can never disagree about
 * whether the note came back.
 */
export function deleteNote(
  id: string
): { note: AnnotationRecord; index: number; step: HistoryStep } | null {
  const removed = removeAnnotation(id)
  if (!removed) return null
  const { note, index } = removed
  const step = record({
    label: "Delete note",
    undo: () => restoreAnnotation(note, index),
    redo: () => {
      removeAnnotation(note.id)
    },
  })
  return { note, index, step }
}

/**
 * Delete every note, as ONE step — Cmd+Z brings the whole set back, in order.
 * Returns how many went.
 */
export function clearNotes(): number {
  return clearNotesStep()?.count ?? 0
}

/** `clearNotes`, handing back the step too so a toast can offer it back. */
export function clearNotesStep(): { count: number; step: HistoryStep } | null {
  const taken = annotations().map((note, index) => ({ note, index }))
  if (!taken.length) return null
  clearAnnotations()
  const step = record({
    label: taken.length === 1 ? "Delete note" : `Delete ${taken.length} notes`,
    undo: () => {
      for (const { note, index } of taken) restoreAnnotation(note, index)
    },
    redo: () => {
      for (const { note } of taken) removeAnnotation(note.id)
    },
  })
  return { count: taken.length, step }
}

/**
 * A toast's Undo for a step it announced: the timeline's own undo when the step
 * is still the newest; otherwise the step's inverse alone, which is safe for
 * a note because every note inverse is idempotent and touches only that note.
 * Taking the step off the timeline in the second case is not possible without
 * reordering it, so the step stays — and its later undo is a no-op.
 */
export function undoNoteStep(step: HistoryStep): void {
  if (!undoStep(step)) step.undo()
}
