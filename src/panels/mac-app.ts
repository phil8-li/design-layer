/**
 * "Open in Mac app": a banner across the foot of the left panel.
 *
 * DesignLayer.app (desktop/mac) is one window with every running editor as a
 * tab. This offers the move from a browser tab into it, and it is drawn only
 * where that move exists: on a Mac with the app installed (`config.deskUrl`,
 * which the launcher reads from the app's LaunchAgent), and never inside the
 * app itself, where it would send the page to the window it is already in.
 *
 * ## Why the left panel, and why its foot
 *
 * The toolbar holds verbs about the page and the selection, and this is
 * neither: it is about where the editor runs, which is a statement about the
 * whole session. That is the left panel's subject — the app chooser at its head
 * names the app every view below it is OF, and it is also the one other control
 * here that moves the session somewhere else. The chooser leads the column
 * because it is read first; this sits at the foot because it is read once. A
 * banner the tree scrolls past would be in the way of the list the panel exists
 * for, so it is pinned below the panes, outside their scroll.
 *
 * It is quiet on purpose. The same row is on screen for every session on this
 * Mac, and a tinted card would be asking for the same click all day. It reads
 * as the chooser's mirror: full-bleed, one divider, the name in the text ink
 * and one line under it saying what the app is.
 */

import { config } from "../core/config"
import { el } from "../core/dom"
import { icon } from "../core/icons"
import { tokens } from "../core/tokens"
import type { EditorContext } from "../core/context"
import { isInDesk, openInDesk } from "../shell/desk"

/**
 * An id the document does not already hold, asked of the document itself for
 * the reason `freeMenuId` in `app-chooser.ts` gives: two graphs of this module
 * each counting from zero would both claim the first id.
 */
let sequence = 0
function freeNoteId(): string {
  let candidate = `de-mac-banner-note-${++sequence}`
  while (document.getElementById(candidate)) candidate = `de-mac-banner-note-${++sequence}`
  return candidate
}

/** The banner, or null where there is no app to move into. */
export function macAppBanner(context: EditorContext): HTMLElement | null {
  if (!config.deskUrl || isInDesk()) return null
  const noteId = freeNoteId()

  let moving = false
  const move = async (): Promise<void> => {
    // A second press while the first is in flight would hand the same page
    // over twice, and the app would load it twice.
    if (moving) return
    moving = true
    try {
      const answer = await openInDesk(window.location.href)
      if (answer.ok) {
        // Nothing to undo and nothing left to do here: the app's frame takes
        // the editor's one socket, and this tab says so on its own.
        context.toast(
          answer.delivered > 0
            ? "Opened in the Mac app. You can close this tab."
            : "Opening the Mac app… This page opens there once its window is up."
        )
      } else if (answer.reason === "refused") {
        context.toast(
          `The Mac app could not open this page. ${answer.message ?? "It refused the request"}.`,
          "error"
        )
      } else {
        // The page never learns where the checkout is (the prelude carries no
        // paths), so the command is written relative to it.
        context.toast(
          "Could not reach the Mac app. Run node desktop/mac/install.mjs --start in the DesignLayer folder, then try again.",
          "error"
        )
      }
    } finally {
      moving = false
    }
  }

  return el(
    "button",
    {
      class: "de-mac-banner",
      type: "button",
      "data-de-control": "mac-app",
      // The name is the action; the line under it is its description, so a
      // screen reader says the verb first and the explanation after it.
      "aria-label": "Open in Mac app",
      "aria-describedby": noteId,
      onclick: () => void move(),
    },
    [
      el("span", { class: "de-mac-banner-text" }, [
        el("span", { class: "de-mac-banner-title" }, ["Open in Mac app"]),
        el("span", { class: "de-mac-banner-note", id: noteId }, ["One window for all your apps"]),
      ]),
      icon("ExternalLink", tokens.icon.action),
    ]
  )
}
