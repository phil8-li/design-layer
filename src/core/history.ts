/**
 * One undo timeline for everything the editor changes.
 *
 * The engine we vendor keeps an undo stack of its own, and nothing this editor
 * does ever reaches it: it is pushed only from the vendor's annotation, colour
 * and text tools, all of which are suppressed chrome here — this editor writes
 * through `core/writer` instead. So `store.canUndo()` was false in every
 * session and the toolbar's Undo button was permanently disabled. The stack is
 * also pop-only — `canvasUndo()` reverts an entry and discards it — so it could
 * not have answered Shift+Cmd+Z even if it had been reachable.
 *
 * The timeline therefore lives where the edits do. Every control writes through
 * the writer, which is the one path from a control to the page, so recording
 * the inverse there is what makes this cover the whole editor rather than the
 * surfaces someone remembered to wire up — including a section added next
 * month, which gets undo without knowing this file exists.
 */

export interface HistoryStep {
  /** What the toast names, e.g. "Set stroke width". The write's own summary. */
  label: string
  undo(): void
  redo(): void
}

const past: HistoryStep[] = []
/**
 * How many steps Undo can walk back. Each step closes over the element it
 * wrote, so an uncapped timeline pins every element a long session ever
 * nudged — detached subtrees from routes long since left included. Five
 * hundred is past any undo run a person makes; the oldest step falls off.
 */
export const HISTORY_LIMIT = 500
const future: HistoryStep[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * There is no re-entrancy flag here, and there must not be one.
 *
 * A step replays through the writer's PRIVATE write functions, which apply and
 * queue but never record — that is what makes "undoing does not itself record"
 * a structural property rather than a flag someone has to remember to check. A
 * step written against the public `applyStyles` instead would push an inverse
 * of the inverse and Cmd+Z would oscillate between two values forever; the
 * history suite fails on exactly that, so the structure is held by a test
 * rather than by a guard no test can trip.
 */
export function record(step: HistoryStep): HistoryStep {
  past.push(step)
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT)
  // A fresh edit after an undo forks the timeline, and the branch that was
  // undone is gone. Keeping it would make Redo re-apply a change to state it
  // was never computed against.
  future.length = 0
  notify()
  return step
}

export function canUndo(): boolean {
  return past.length > 0
}

export function canRedo(): boolean {
  return future.length > 0
}

/** The label of the step reverted, or null when there was nothing to revert. */
export function undo(): string | null {
  const step = past.pop()
  if (!step) return null
  step.undo()
  future.push(step)
  notify()
  return step.label
}

/** The label of the step re-applied, or null when there was nothing to redo. */
export function redo(): string | null {
  const step = future.pop()
  if (!step) return null
  step.redo()
  past.push(step)
  notify()
  return step.label
}

/**
 * Undo ONE particular step, from a surface that offered it — a toast's Undo.
 *
 * Only when it is still the newest step. A toast is up for seconds and the
 * timeline can move under it; reverting a step from the middle would leave the
 * steps above it replaying against state they were never computed against.
 * When something newer has landed, the step stays where it is and Cmd+Z walks
 * back to it in order. Returns whether it was undone.
 */
export function undoStep(step: HistoryStep): boolean {
  if (past[past.length - 1] !== step) return false
  undo()
  return true
}

export function onHistoryChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test seam: the stacks are module state, and a case must start empty. */
export function resetHistory(): void {
  past.length = 0
  future.length = 0
  notify()
}
