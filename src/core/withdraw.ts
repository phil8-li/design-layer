/**
 * Taking one change back, from anywhere in the list, in any order.
 *
 * The Changes tab has always had a delete button on every row, and until now it
 * did one thing: remove the row. The change stayed queued. A designer who
 * dropped a padding tweak, watched the row vanish, and then pressed Apply found
 * that padding in their source anyway — the tab and the file disagreed, and the
 * tab was the one lying.
 *
 * That is what this module fixes. Dropping a row now withdraws the work behind
 * it: the queued source operation, the preview on screen, and the ledger entry
 * if the change was one no commit could write. Afterwards nothing anywhere
 * believes the change is owed.
 *
 * WHY IT CAN BE ORDER-FREE, which is the part worth understanding. Undo is a
 * timeline and has to be walked backwards — step 7 before step 3 — because
 * steps compose. This is not undo. A ROW is one (element, property), and the
 * journal collapses every repeat of that pair onto the same row, so no two rows
 * can ever describe the same property of the same element. Rows are therefore
 * independent by construction, and dropping the third of seven cannot disturb
 * the other six. The collapse rule that exists to keep three hundred drag
 * frames from becoming three hundred rows is the same rule that makes arbitrary
 * withdrawal safe.
 *
 * The preview reverts for the same reason. Restoring a row's `from` would be
 * reckless if a later row could have written the same property afterwards —
 * it would clobber that later value — and collapse is the guarantee that no
 * later row did.
 *
 * WHAT THIS IS NOT. It does not touch the history stack. Cmd+Z still owns the
 * timeline, and a withdrawn row leaves its history step in place, neutralized
 * in the journal by `removeEdit` exactly as a dismissal always was. Undo after
 * a withdrawal pops a step whose journal work is already gone, and that pops as
 * a no-op — see the `mutations` design note in `annotations/journal.ts`.
 */

import {
  isAngularHost,
  unqueueAngularProperty,
} from "./angular"
import { editElement, editRecord, removeEdit } from "../annotations/journal"
import { previewOnlyChanges, removePreviewOnly } from "./change-prompt"
import { DELETED_ATTRIBUTE } from "./dom"
import { unqueueRemoval } from "./removal"
import { elementKey } from "./store"
import type { RewriteBridge } from "./bridge"
import type { LayerElement } from "./types"

/**
 * What actually happened, because the caller has to be able to say so.
 *
 * `queueCleared` false with `row` true is the honest description of a
 * withdrawal against an unpatched vendor bundle: the row is gone and the
 * operation is not, which is the old broken behaviour and must never be
 * reported as success. The panel turns this into a sentence rather than a
 * silent partial.
 */
export interface WithdrawResult {
  /** The row left the outbox. */
  row: boolean
  /** The pending source operation was taken back. */
  queueCleared: boolean
  /** The preview on the page was returned to what it was before the edit. */
  previewReverted: boolean
  /** A ledger entry for an unwritable change was retracted. */
  ledgerCleared: boolean
}

/**
 * The merge key the writer filed this element's operation under.
 *
 * Rebuilt rather than remembered. The writer keys the vendor store on
 * `selection.key`, which is `elementKey(element, componentName, line)`, and the
 * journal deliberately does not store a selection — it stores the live element,
 * because that is what survives a re-render and what the collapse rule needs.
 * So the key is recomputed here from the same three inputs, through the same
 * function, which is what keeps the two in agreement when the shape of a key
 * changes.
 *
 * A component the bridge can no longer name yields the same `"?"` and line 0
 * the writer would have used at edit time, so the key still matches.
 */
function mergeKeyFor(bridge: RewriteBridge, element: LayerElement): string {
  let componentName = ""
  let line = 0
  try {
    const info = bridge.elementInfo(element)
    componentName = info?.componentName ?? ""
    line = info?.lineNumber ?? 0
  } catch {
    // The vendor walk throws on a detached or foreign node. An unnamed key is
    // still a key, and it is the one the writer would have built too.
  }
  return elementKey(element, componentName, line)
}

/**
 * Put the element back the way it looked before this row.
 *
 * Only the preview: the inline style the writer set to show the change. A
 * deletion is its own case because it was never a style — the element is still
 * in the page, marked and hidden, so undoing it means taking the mark off
 * rather than restoring a value.
 */
function revertPreview(element: LayerElement, property: string, from: string): boolean {
  if (property === "remove") {
    if (!element.hasAttribute(DELETED_ATTRIBUTE)) return false
    element.removeAttribute(DELETED_ATTRIBUTE)
    element.style.removeProperty("display")
    return true
  }
  // `class`, `icon` and `text` are sentinels, not CSS: there is no inline
  // declaration to take back, and the live attribute is the only record of the
  // change. Reverting those would mean re-running the writer backwards, which
  // is undo's job and not this one — the row leaves, the pixels stay, and the
  // toast says so.
  if (property === "class" || property === "icon" || property === "text") return false

  const style = element.style
  if (from) style.setProperty(property, from)
  else style.removeProperty(property)
  return true
}

/**
 * Drop one row and take back everything behind it.
 *
 * The order matters in one place: the row is removed LAST. Everything before it
 * can fail — an unpatched bundle, an element the bridge has lost, a queue that
 * never held this property — and a row still standing over a failed withdrawal
 * is recoverable, because the designer can see it and try again. A row removed
 * first would leave them with no evidence anything went wrong.
 */
export function withdrawEdit(bridge: RewriteBridge, id: string): WithdrawResult {
  const result: WithdrawResult = {
    row: false,
    queueCleared: false,
    previewReverted: false,
    ledgerCleared: false,
  }

  const record = editRecord(id)
  if (!record) return result
  const element = editElement(id)
  const property = record.property

  if (element) {
    if (property === "remove") {
      result.queueCleared = unqueueRemoval(element)
    } else if (isAngularHost()) {
      result.queueCleared = unqueueAngularProperty(element, property)
    } else {
      /*
       * The vendor store, through the one function that can take a property
       * back out of a merged operation.
       *
       * Optional on the type and checked here, because it only exists on a
       * patched bundle. Left unchecked this would throw inside a click handler
       * and take the panel down; reported honestly it becomes a sentence the
       * designer can act on.
       */
      const remove = bridge.store.removePendingPropertyOperation
      if (typeof remove === "function") {
        try {
          remove.call(bridge.store, mergeKeyFor(bridge, element), [property])
          result.queueCleared = true
        } catch {
          result.queueCleared = false
        }
      }
    }

    result.previewReverted = revertPreview(element, property, record.from)
  }

  /*
   * The ledger, matched the way the ledger matches itself.
   *
   * A change that could not be written lives in `change-prompt.ts` as well as
   * in the journal, and leaving it there would put the withdrawn change back in
   * front of the agent through the brief — the one place the designer would
   * never think to look for a row they just deleted. Matched on the identity
   * the ledger collapses by (component, tag, class, property) rather than by
   * reference, because the ledger's own records collapse too.
   */
  const tagName = record.target?.tagName ?? ""
  const className = record.target?.className ?? ""
  for (const change of previewOnlyChanges()) {
    if (change.property !== property) continue
    if (change.tagName !== tagName || change.className !== className) continue
    if (removePreviewOnly(change)) result.ledgerCleared = true
    break
  }

  removeEdit(id)
  result.row = true
  return result
}
