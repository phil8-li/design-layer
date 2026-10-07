/**
 * Deleting an element, on the way to the file that wrote it.
 *
 * Every other edit this editor makes is a CHANGE to an element that stays where
 * it is: a class swapped, a declaration set, some text replaced. Each of those
 * has a lane already — the vendor's batch transformer on React, the template
 * splicer on Angular — and each of those lanes is built around finding a node
 * and rewriting part of it. None of them can take a node away.
 *
 * So a removal is queued here instead, in one place for both hosts, and the
 * server decides what a removal means in the language the project is written
 * in. That is also why this queue is not folded into `core/angular.ts`: the
 * pending entries there merge repeated edits onto a LIVE element and describe
 * it at commit time, and a deleted element is neither live nor describable by
 * then. A removal is captured whole at the moment it happens and never merged
 * with anything.
 *
 * The queue is keyed by the element so undo can take a removal back out of it.
 * A delete that is undone and never redone must leave nothing behind for
 * "Apply to code" to write — the alternative is an editor that deletes a card
 * out of the user's source ten minutes after they pressed Cmd+Z.
 */

import { config } from "./config"
import type { ElementTarget } from "./element-target"
import type { LayerElement } from "./types"

/** One element, described well enough for a server to find and delete it. */
export interface RemovalOperation {
  op: "removeElement"
  /** The component whose file holds it: a class name on Angular, a React one. */
  componentName: string
  /**
   * Filled in late, and legitimately null.
   *
   * Source resolution is a round trip, and a delete is not going to wait for
   * it — the element leaves the screen on the keystroke. Angular does not need
   * this at all (the server locates by component and descriptor); React does,
   * which is why the entry is patched in place when resolution lands.
   */
  filePath: string | null
  lineNumber: number
  columnNumber: number
  target: ElementTarget
}

export interface RemovalResult {
  applied: Array<{ op: string; filePath: string; lineNumber: number }>
  failed: Array<{ reason: string; operation: { op: string; componentName: string } }>
}

const pending = new Map<LayerElement, RemovalOperation>()
const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of [...listeners]) listener()
}

/** Fires whenever the queue's size or contents change, so the toolbar repaints. */
export function onRemovalQueueChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function removalQueueSize(): number {
  return pending.size
}

/**
 * Queues a removal and hands back the stored record, so a caller that learns
 * the file path afterwards can fill it in — the same contract
 * `recordPreviewOnly` has, for the same reason.
 */
export function queueRemoval(
  element: LayerElement,
  operation: RemovalOperation
): RemovalOperation {
  pending.set(element, operation)
  announce()
  return operation
}

/** Undo's half of the deal: the element is back, so nothing is owed to source. */
export function unqueueRemoval(element: LayerElement): boolean {
  if (!pending.delete(element)) return false
  announce()
  return true
}

export function buildRemovalOperations(): RemovalOperation[] {
  return [...pending.values()]
}

export function clearRemovalQueue(): void {
  if (!pending.size) return
  pending.clear()
  announce()
}

export async function applyRemovals(operations: RemovalOperation[]): Promise<RemovalResult> {
  const response = await fetch(`${config.apiBase}/source/remove`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ operations }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.message ?? `Delete failed (${response.status})`)
  }
  return response.json()
}
