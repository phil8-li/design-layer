/**
 * Arrange — moving the selection among its JSX siblings.
 *
 * "Front" and "back" here mean SOURCE ORDER, not z-index. In a document flow
 * that is the move that means something — siblings in normal flow do not
 * stack, they read in order. Front is the first child, which is the top row of
 * the Layers tree; back is the last.
 *
 * The reference we move is exactly the layers panel's `DragRef`, built the same
 * way from the same resolver memo. Two definitions of "which node is this, and
 * who are its siblings" would be two answers, and a drag and a button press on
 * the same layer would move different things.
 *
 * ── A move is a note ───────────────────────────────────────────────────────
 *
 * Arranging used to send the engine's `reorder`, which rewrote the file on the
 * spot. It writes a note now, like every other direct edit, and the agent
 * moves the element in source. The sibling lines still come from the engine's
 * `getSiblings`: they are how a move with nowhere to go is told apart from one
 * that has somewhere.
 */

import { getResolver, type LayerBridge } from "./resolve"
import type { Selection } from "./types"
import type { Writer } from "./writer"

export interface ArrangeBridge extends LayerBridge {
  send(message: unknown): void
  subscribe(fn: (message: Record<string, unknown>) => void): () => void
}

/** Everything the vendor server needs to move a node among its JSX siblings. */
export interface ArrangeRef {
  filePath: string
  fromLine: number
  parentPath: string
  parentLine: number
}

export type ArrangeMove = "front" | "forward" | "backward" | "back"

/**
 * The selection as something reorderable, or null when it is not.
 *
 * The gate is the layers panel's: a node is movable where the engine gave it a
 * JSX line of its own, and its host component a line to move it within. An
 * element the resolver does not call an instance root has no line the server
 * can find, so there is nothing to send.
 */
export function arrangeRef(bridge: ArrangeBridge, element: Element): ArrangeRef | null {
  const { info, isRoot } = getResolver(bridge).meta(element)
  const host = info?.stack[1]
  if (!isRoot || !info?.filePath || !info.lineNumber || !host?.filePath || !host.lineNumber) {
    return null
  }
  return {
    filePath: info.filePath,
    fromLine: info.lineNumber,
    parentPath: host.filePath,
    parentLine: host.lineNumber,
  }
}

/**
 * Sibling lines, memoised per parent.
 *
 * The memo is not an optimisation, it is what stops the section from spinning.
 * A panel section is rebuilt on every render, and the only way it learns the
 * sibling list is to ask the server and re-render when the answer lands — so a
 * section that asked unconditionally would answer its own question forever.
 * With the memo, the second render is a cache hit and the loop closes.
 *
 * Cleared whenever we move something: a rewrite shifts every line below the
 * edit, which is exactly the number the next reorder would be addressed by.
 */
const siblingsByParent = new Map<string, number[]>()

/** One question in flight at a time — see the note on `siblingsList` below. */
let asking: string | null = null

function parentKey(ref: ArrangeRef): string {
  return `${ref.parentPath}:${ref.parentLine}`
}

/**
 * The parent's JSX children as line numbers, in source order, or null while the
 * server has not answered yet.
 *
 * `siblingsList` carries no correlation id, so the reply is claimed by whoever
 * is listening — and the layers panel listens too, for the length of a drag.
 * Both take the first reply and both asked about the parent under the cursor,
 * so the worst case is that one of them reads the other's parent for one frame
 * and re-asks on the next render. Holding one question at a time keeps that
 * window to a single reply rather than a pile of them.
 */
export function siblingLines(
  bridge: ArrangeBridge,
  ref: ArrangeRef,
  onReady: () => void
): number[] | null {
  const key = parentKey(ref)
  const known = siblingsByParent.get(key)
  if (known) return known
  if (asking) return null

  asking = key
  const stop = bridge.subscribe((message) => {
    if (message.type !== "siblingsList") return
    stop()
    asking = null
    const siblings = (message.siblings ?? []) as Array<{ lineNumber: number }>
    siblingsByParent.set(
      key,
      siblings.map((sibling) => sibling.lineNumber).filter((line) => line > 0)
    )
    onReady()
  })
  bridge.send({ type: "getSiblings", filePath: ref.parentPath, parentLine: ref.parentLine })
  return null
}

/** Where the selection sits in the sibling list, or -1 when it is not in it. */
export function arrangeIndex(lines: number[] | null, ref: ArrangeRef): number {
  return lines ? lines.indexOf(ref.fromLine) : -1
}

/**
 * A move is offered only when it goes somewhere. An element already at the top
 * of the list cannot be brought further forward, and a list we have not been
 * told about yet cannot be reasoned over at all.
 */
export function canArrange(
  lines: number[] | null,
  ref: ArrangeRef | null,
  move: ArrangeMove
): boolean {
  if (!ref || !lines || lines.length < 2) return false
  const at = arrangeIndex(lines, ref)
  if (at < 0) return false
  return move === "front" || move === "forward" ? at > 0 : at < lines.length - 1
}

/**
 * Notes the move for the agent. A move that cannot go is a no-op.
 *
 * The memo is dropped all the same: the file has not changed, but a stale
 * answer must never outlive a gesture that may come back as a source edit.
 */
export function arrange(
  writer: Pick<Writer, "noteReorder">,
  selection: Selection,
  ref: ArrangeRef,
  lines: number[] | null,
  move: ArrangeMove
): void {
  if (!canArrange(lines, ref, move)) return
  siblingsByParent.clear()
  writer.noteReorder(selection, move)
}

/** Drops the memo. Exported for tests, which move the same parent repeatedly. */
export function forgetSiblings(): void {
  siblingsByParent.clear()
  asking = null
}
