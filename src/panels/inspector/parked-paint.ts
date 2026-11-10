/**
 * Paints the eye has switched off, per layer and per paint kind.
 *
 * The eye on a Fill, Text color, Stroke or Effect row hides the paint without
 * losing it: the element gets `transparent`, `0px` or a shorter shadow list,
 * and the value it had waits here until the eye brings it back. Panel-level,
 * not DOM-level, because the inspector is rebuilt on every write and the point
 * of the eye is that the value survives being switched off.
 *
 * One store, keyed by paint kind AND by layer. Fill, Stroke and Effects each
 * kept a map keyed by the primary selection only, so on a multi-selection Hide
 * remembered the primary's value and Show wrote it to every layer: two layers
 * with 1px and 4px strokes both came back at 1px, and the agent was handed a
 * note to change the second one. Every selected layer now parks its own value
 * and gets its own value back.
 *
 * Per (layer, kind):
 *
 *   live   --eye-->          parked(value)   (the section writes the hidden form)
 *   parked --eye-->          live            (the section writes `value` back)
 *   any    --remove | add | a new paint picked--> live (the entry is dropped)
 */

import type { Selection } from "../../core/types"

export type PaintKind = "fill" | "text" | "stroke" | "effects"

const parked = new Map<string, unknown>()

const slot = (kind: PaintKind, layer: string): string => `${kind}\u0000${layer}`

export interface ParkedPaints<T> {
  get(layer: Pick<Selection, "key">): T | undefined
  set(layer: Pick<Selection, "key">, value: T): void
  /** Drops the entry for every layer given: a paint written to all of them is live on all of them. */
  drop(layers: ReadonlyArray<Pick<Selection, "key">>): void
}

/** The parked values of one paint kind. The type is the section's: a colour, four widths, effect rows. */
export function parkedPaints<T>(kind: PaintKind): ParkedPaints<T> {
  return {
    get: (layer) => parked.get(slot(kind, layer.key)) as T | undefined,
    set: (layer, value) => {
      parked.set(slot(kind, layer.key), value)
    },
    drop: (layers) => {
      for (const layer of layers) parked.delete(slot(kind, layer.key))
    },
  }
}
