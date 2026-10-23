/**
 * Text typed on the page becomes a note.
 *
 * Double-clicking a text layer starts the vendored engine's own editor: it
 * makes the element `contenteditable`, lets the designer type, and ends on
 * Enter, Escape or blur. The engine kept that edit in a list of its own for an
 * "Apply to code" that no longer runs, so nothing in the Changes tab ever heard
 * about it. This watches the same session from outside — the element turning
 * editable, then turning back — and hands the before and after to the writer,
 * which makes it a note and an undo step like any other edit.
 *
 * Watched rather than patched into the engine, because the engine is a pinned
 * minified bundle and the session is visible from the DOM alone.
 */

import { isChrome } from "../core/dom"
import type { EditorContext } from "../core/context"
import type { LayerElement, Selection } from "../core/types"
import type { Writer } from "../core/writer"

/** How long after a double-click the engine's editor takes focus, at most. */
const DOUBLE_CLICK_WINDOW_MS = 1000

interface Session {
  element: HTMLElement
  before: { text: string; html: string }
  watcher: MutationObserver
}

export function installTextEditNotes(context: EditorContext, writer: Writer): void {
  /*
   * Elements that were editable before the double-click are the app's own
   * fields or rich-text editors: typing in them is using the app, not editing
   * its copy. Window capture runs before the engine's document listener, so
   * this sees the element as it was. The engine only ever starts on a
   * double-click, so a focus long after one is not its editor either.
   */
  const editableBefore = new WeakSet<Element>()
  let doubleClickAt = -Infinity
  let session: Session | null = null

  window.addEventListener(
    "dblclick",
    (event) => {
      doubleClickAt = performance.now()
      const target = event.target
      if (!(target instanceof Element)) return
      const host = target.closest("[contenteditable]")
      if (host && host.getAttribute("contenteditable") !== "false") editableBefore.add(host)
    },
    true
  )

  const finish = (): void => {
    const current = session
    if (!current) return
    session = null
    current.watcher.disconnect()
    const { element, before } = current
    const after = { text: element.textContent ?? "", html: element.innerHTML }
    if (after.text === before.text) return
    const selection = selectionOf(element)
    if (!selection) return
    writer.recordText(selection, before, after)
    // The Layers tree and the Design tab name a text layer by its words.
    context.refresh()
  }

  const selectionOf = (element: HTMLElement): Selection | null => {
    const find = () => context.getState().selection.find((entry) => entry.element === element) ?? null
    const selected = find()
    if (selected) return selected
    context.selectMany([element as LayerElement])
    return find()
  }

  window.addEventListener(
    "focusin",
    (event) => {
      const element = event.target
      if (!(element instanceof HTMLElement)) return
      if (element.getAttribute("contenteditable") !== "true" || editableBefore.has(element)) return
      if (isChrome(element) || session?.element === element) return
      if (performance.now() - doubleClickAt > DOUBLE_CLICK_WINDOW_MS) return
      finish()
      // Read on focus, before the first keystroke: the engine focuses the
      // element in the same task it makes it editable.
      const watcher = new MutationObserver(() => {
        if (element.getAttribute("contenteditable") !== "true") finish()
      })
      watcher.observe(element, { attributes: true, attributeFilter: ["contenteditable"] })
      session = { element, before: { text: element.textContent ?? "", html: element.innerHTML }, watcher }
    },
    true
  )

  window.addEventListener(
    "focusout",
    (event) => {
      if (session && event.target === session.element) finish()
    },
    true
  )
}
