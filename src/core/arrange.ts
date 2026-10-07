/**
 * Arrange — moving the selection among its JSX siblings.
 *
 * "Front" and "back" here mean SOURCE ORDER, not z-index. That is not a
 * simplification, it is the only thing that survives the trip to source:
 * `core/tailwind.ts` has no entry for `z-index`, so a `z-*` write is dropped
 * silently at "Apply to code" and the user is left with a preview that no file
 * agrees with. Reordering the JSX children is the move the engine can actually
 * make, and in a document flow it is also the move that means something —
 * siblings in normal flow do not stack, they read in order. Front is the first
 * child, which is the top row of the Layers tree; back is the last.
 *
 * The reference we move is exactly the layers panel's `DragRef`, built the same
 * way from the same resolver memo. Two definitions of "which node is this, and
 * who are its siblings" would be two answers, and a drag and a button press on
 * the same layer would move different things.
 *
 * ── What `reorder` can and cannot say ──────────────────────────────────────
 *
 * The engine's `reorder` inserts `fromLine` *before* `toLine`, and that is its
 * whole vocabulary. Three of the four moves fall straight out of it. The two
 * that do not are worth naming, because they look like tricks and are not:
 *
 *   - one step LATER is the same edit as swapping with the next sibling, so it
 *     is sent as "move the next sibling before me" rather than as a move of the
 *     selection. There is no "insert after" to ask for.
 *   - the LAST slot cannot be named by an insert-before, because there is no
 *     sibling after it to insert before. Passing the element's own line as the
 *     target is how you say it: the vendor removes the node first, then fails
 *     to find its target, and splices at -1 — which lands the node before the
 *     parent's trailing whitespace, i.e. last. Verified against the pinned
 *     `react-rewrite-cli@0.1.1`. It relies on the parent's children ending in a
 *     JSXText, which is true of any JSX written one child per line — and the
 *     protocol is line-addressed, so anything else was already out of reach.
 */

import { getResolver, type LayerBridge } from "./resolve"

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

/** Sends the one `reorder` that performs `move`. A move that cannot go is a no-op. */
export function arrange(
  bridge: ArrangeBridge,
  ref: ArrangeRef,
  lines: number[] | null,
  move: ArrangeMove
): void {
  if (!canArrange(lines, ref, move) || !lines) return
  const at = arrangeIndex(lines, ref)

  // "backward" moves the sibling below us instead of moving us: swapping two
  // adjacent children is symmetric, and it is the only way to say "one later"
  // in a vocabulary that has no insert-after.
  const fromLine = move === "backward" ? lines[at + 1] : ref.fromLine
  const toLine =
    move === "front" ? lines[0]
    : move === "forward" ? lines[at - 1]
    : ref.fromLine

  siblingsByParent.clear()
  bridge.send({ type: "reorder", filePath: ref.filePath, fromLine, toLine })
}

/** Drops the memo. Exported for tests, which move the same parent repeatedly. */
export function forgetSiblings(): void {
  siblingsByParent.clear()
  asking = null
}
