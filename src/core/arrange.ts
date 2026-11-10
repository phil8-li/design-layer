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

interface ArrangeBridge extends LayerBridge {
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
 * Known lists are cleared whenever we move something: a rewrite shifts every
 * line below the edit, which is exactly the number the next reorder would be
 * addressed by.
 *
 * ── The machine, per parent key ────────────────────────────────────────────
 *
 * A key is `unknown` (absent from the map), `asking` (queued or on the wire,
 * with the waiters to call and the request id it is waiting under), or
 * `known(lines)`.
 *
 *   unknown --siblingLines / askSiblings--> asking(id)   (queued; sent when the wire is free)
 *   asking  --siblingLines / askSiblings--> asking(id)   (waiter added, deduped by identity)
 *   asking  --reply naming an asker, or empty--> known   (waiters called)
 *   asking  --non-empty reply naming no asker--> asking  (foreign reply, ignored)
 *   asking  --timeout, same id--> unknown                (waiters dropped, next request sent)
 *   asking  --timeout, stale id--> asking                (nothing)
 *   known   --arrange()--> unknown
 *   *       --forgetSiblings()--> unknown                (queue, timers and listener dropped too)
 *
 * ── One request on the wire per bridge ─────────────────────────────────────
 *
 * The vendor server answers `getSiblings` synchronously and in request order,
 * and its `siblingsList` carries no correlation id. So a reply can only be
 * matched to a request by position: we keep exactly one request of ours on the
 * wire, give the next reply to it, and only then send the next queued one.
 * Adding an id to the message would not help — the server would not echo it.
 *
 * The layers panel sends its own `getSiblings` during a drag, so the reply we
 * receive may be the answer to its question. The list a parent returns always
 * contains the line of the child that asked about it (that child is one of its
 * JSX children, and a list without it could not be arranged over anyway), so a
 * non-empty reply that names none of the askers' `fromLine`s is someone else's
 * and is ignored. An empty list names nobody and is accepted: it means "no
 * children the engine could place", which arranges nothing either way.
 *
 * A reply that never lands (the socket dropped it during a dev-server restart)
 * would otherwise hold the wire forever; after `SIBLINGS_TIMEOUT_MS` the key
 * goes back to unknown, its waiters are dropped without being called (nothing
 * changed for them to re-render over), and the queue moves on. The next render
 * or key press asks again.
 */
export const SIBLINGS_TIMEOUT_MS = 2000

type SiblingsEntry =
  | { state: "asking"; id: number; askers: Set<number>; waiters: Set<() => void>; lost: Set<() => void> }
  | { state: "known"; lines: number[] }

interface SiblingsRequest {
  key: string
  id: number
  message: { type: "getSiblings"; filePath: string; parentLine: number }
}

interface Wire {
  queue: SiblingsRequest[]
  current: SiblingsRequest | null
  timer: ReturnType<typeof setTimeout> | null
  stop: (() => void) | null
}

const siblingsByParent = new Map<string, SiblingsEntry>()
const wires = new Map<ArrangeBridge, Wire>()
let nextRequestId = 0

function parentKey(ref: ArrangeRef): string {
  return `${ref.parentPath}:${ref.parentLine}`
}

/** Puts a new or existing asker on the key, queuing a request when the key was unknown. */
function ask(bridge: ArrangeBridge, ref: ArrangeRef, waiter: (() => void) | null, lost: (() => void) | null): void {
  const key = parentKey(ref)
  let entry = siblingsByParent.get(key)
  if (entry?.state === "known") return
  if (!entry) {
    nextRequestId += 1
    entry = { state: "asking", id: nextRequestId, askers: new Set(), waiters: new Set(), lost: new Set() }
    siblingsByParent.set(key, entry)
    const wire = wireFor(bridge)
    wire.queue.push({
      key,
      id: entry.id,
      message: { type: "getSiblings", filePath: ref.parentPath, parentLine: ref.parentLine },
    })
    entry.askers.add(ref.fromLine)
    if (waiter) entry.waiters.add(waiter)
    if (lost) entry.lost.add(lost)
    pump(bridge, wire)
    return
  }
  entry.askers.add(ref.fromLine)
  if (waiter) entry.waiters.add(waiter)
  if (lost) entry.lost.add(lost)
}

function wireFor(bridge: ArrangeBridge): Wire {
  let wire = wires.get(bridge)
  if (!wire) {
    wire = { queue: [], current: null, timer: null, stop: null }
    wires.set(bridge, wire)
  }
  return wire
}

/** Sends the next queued request when nothing of ours is on the wire. */
function pump(bridge: ArrangeBridge, wire: Wire): void {
  if (wire.current) return
  const next = wire.queue.shift()
  if (!next) {
    // Idle: stop listening, so a bridge with nothing asked carries no listener.
    wire.stop?.()
    wire.stop = null
    return
  }
  wire.current = next
  wire.stop ??= bridge.subscribe((message) => {
    if (message.type === "siblingsList") answer(bridge, wire, message)
  })
  wire.timer = setTimeout(() => expire(bridge, wire, next.id), SIBLINGS_TIMEOUT_MS)
  bridge.send(next.message)
}

function answer(bridge: ArrangeBridge, wire: Wire, message: Record<string, unknown>): void {
  const request = wire.current
  if (!request) return
  const entry = siblingsByParent.get(request.key)
  if (entry?.state !== "asking" || entry.id !== request.id) return
  const siblings = (message.siblings ?? []) as Array<{ lineNumber: number }>
  const lines = siblings.map((sibling) => sibling.lineNumber).filter((line) => line > 0)
  if (lines.length > 0 && !lines.some((line) => entry.askers.has(line))) return

  siblingsByParent.set(request.key, { state: "known", lines })
  settle(wire)
  pump(bridge, wire)
  for (const waiter of entry.waiters) waiter()
}

function expire(bridge: ArrangeBridge, wire: Wire, id: number): void {
  if (wire.current?.id !== id) return
  const entry = siblingsByParent.get(wire.current.key)
  if (entry?.state === "asking" && entry.id === id) {
    siblingsByParent.delete(wire.current.key)
    for (const lost of entry.lost) lost()
  }
  settle(wire)
  pump(bridge, wire)
}

function settle(wire: Wire): void {
  if (wire.timer) clearTimeout(wire.timer)
  wire.timer = null
  wire.current = null
}

/**
 * The parent's JSX children as line numbers, in source order, or null while the
 * server has not answered yet. `onReady` is called once when the answer lands,
 * and not at all when the question times out.
 */
export function siblingLines(
  bridge: ArrangeBridge,
  ref: ArrangeRef,
  onReady: () => void
): number[] | null {
  const entry = siblingsByParent.get(parentKey(ref))
  if (entry?.state === "known") return entry.lines
  ask(bridge, ref, onReady, null)
  return null
}

/**
 * The same question as a promise: the lines, or null when the server did not
 * answer in time. Shares the memo and the queue with `siblingLines`, so every
 * caller of `getSiblings` (the layers panel's drag included, once it adopts
 * this) goes through the one request on the wire.
 */
export function askSiblings(bridge: ArrangeBridge, ref: ArrangeRef): Promise<number[] | null> {
  const entry = siblingsByParent.get(parentKey(ref))
  if (entry?.state === "known") return Promise.resolve(entry.lines)
  return new Promise((resolve) => {
    ask(
      bridge,
      ref,
      () => {
        const settled = siblingsByParent.get(parentKey(ref))
        resolve(settled?.state === "known" ? settled.lines : null)
      },
      () => resolve(null)
    )
  })
}

/** Where the selection sits in the sibling list, or -1 when it is not in it. */
function arrangeIndex(lines: number[] | null, ref: ArrangeRef): number {
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
 * A noted move drops the known lists: the file has not changed yet, but a
 * stale answer must never outlive a gesture that may come back as a source
 * edit. Questions in flight stay — they were asked of the same unchanged file,
 * and their waiters are still owed an answer.
 */
export function arrange(
  writer: Pick<Writer, "noteReorder">,
  selection: Selection,
  ref: ArrangeRef,
  lines: number[] | null,
  move: ArrangeMove
): void {
  if (!canArrange(lines, ref, move)) return
  for (const [key, entry] of siblingsByParent) {
    if (entry.state === "known") siblingsByParent.delete(key)
  }
  writer.noteReorder(selection, move)
}

/**
 * Drops the memo, the queue, every timer and listener; pending `askSiblings`
 * promises resolve null. Exported for tests, which move the same parent
 * repeatedly.
 */
export function forgetSiblings(): void {
  for (const wire of wires.values()) {
    if (wire.timer) clearTimeout(wire.timer)
    wire.stop?.()
  }
  wires.clear()
  const asking = [...siblingsByParent.values()]
  siblingsByParent.clear()
  for (const entry of asking) {
    if (entry.state === "asking") for (const lost of entry.lost) lost()
  }
}
