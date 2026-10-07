/**
 * One function, and it is here because of WHERE it has to run rather than what
 * it does.
 *
 * It used to live at the top of `libraries/panel.ts`, the library-manager
 * dialog, and was exported from there so the inspector's library-component
 * section could offer the same copy against the same snippets. That dialog is
 * gone — the Libraries surface is a section on the right panel's Design system
 * tab now — and a clipboard helper is not a thing to re-derive at whichever
 * call site happens to survive a rework. A second copy would get the one hard
 * part wrong (see below) and would get it wrong silently.
 *
 * So it moves, unchanged, into a module of its own: no DOM, no store, nothing
 * to render, and therefore nothing that can pull a panel into a file that only
 * wanted to copy a string.
 */

import { COPY_REFUSED, copyText } from "../core/clipboard"
import type { EditorContext } from "../core/context"

/**
 * Write a component's snippet to the clipboard, from inside the click task.
 *
 * Exported because the library-component inspector section offers the same
 * copy against the same snippets, and the one thing this function does that is
 * easy to get wrong is the thing a second copy of it would get wrong: the write
 * is issued SYNCHRONOUSLY, before anything awaits. Both of `copyText`'s routes
 * need the transient user activation the click carries — so a refactor that
 * puts an `await` in front of this passes every test that awaits before
 * asserting and fails on real clicks. Same shape and same reasoning as the
 * Code tab's copy and `copyChangePrompt` in `core/change-prompt.ts`.
 */
export function copyLibrarySnippet(editor: EditorContext, snippet: string, name: string): void {
  if (!snippet) return
  void copyText(snippet).then((copied) =>
    copied ? editor.toast(`Copied the ${name} snippet`) : editor.toast(COPY_REFUSED, "error")
  )
}
