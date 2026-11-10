/**
 * Taking one change back, from anywhere in the list, in any order.
 *
 * The Changes tab has a delete button on every row. Dropping a row withdraws
 * the change behind it: the note leaves the outbox, so no brief carries it, and
 * the preview on the page goes back to what it was before the edit.
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

import { editElement, editRecord, removeEdit } from "../annotations/journal"
import { DELETED_ATTRIBUTE } from "./dom"
import type { LayerElement } from "./types"

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
  if (property === "class" || property === "icon" || property === "text" || property === "reorder") return false

  const style = element.style
  if (from) style.setProperty(property, from)
  else style.removeProperty(property)
  return true
}

/**
 * Drop one row and put its preview back. False when no row has that id.
 *
 * The preview reverts before the row leaves, so the element the journal holds
 * is still the one to write on.
 */
export function withdrawEdit(id: string): boolean {
  const record = editRecord(id)
  if (!record) return false
  const element = editElement(id)
  if (element) revertPreview(element, record.property, record.from)
  removeEdit(id)
  return true
}
