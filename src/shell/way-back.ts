/**
 * ⌘. from wherever focus is.
 *
 * ⌘. is the way back to a collapsed editor. `shell/shortcuts.ts` hears only
 * what reaches this window outside a text field, which is right for every
 * other key and left ⌘. dead in four places a page can put focus without the
 * designer choosing it:
 *
 *   - **A text field.** A composer that focuses itself on load, a search box,
 *     the editor's own layer filter. `everywhereShortcut` takes ⌘. out of the
 *     text-field gate, and this listener is what asks it.
 *   - **A frame.** A key goes to the focused frame's window and no other. A
 *     host that loads one of its own pages in a hidden frame, to index its
 *     routes say, and lets a field in there take focus sends every later key
 *     into a page nobody can see, until the designer happens to click
 *     somewhere. Every same-origin frame gets this listener as it loads.
 *   - **The Mac app's shell.** The editor is a cross-origin frame in it, so a
 *     key typed on the tab strip never arrives here. The shell posts the
 *     accelerators it does not use itself (desktop/mac/shell-page.mjs) and this
 *     answers the ones `everywhereShortcut` takes.
 *   - **A listener of the app's that swallows the key.** `index.ts` installs
 *     this at module scope, while the overlay script is still evaluating and
 *     before the app's own modules run, so it is the first keydown listener on
 *     the window and an app's `stopImmediatePropagation()` comes after it.
 *
 * A cross-origin frame inside the app keeps its keys. Nothing on this page can
 * hear them.
 */

import { runCommand } from "../core/commands"
import { readLoopbackOrigin } from "../core/config"
import { everywhereShortcut } from "../core/keymap"
import { DESK_KEY_MESSAGE } from "./desk"

/**
 * One function for every window it listens in, which is what keeps a window
 * from being answered twice: `addEventListener` ignores a listener it already
 * has, so adopting a frame again on its next `load` adds nothing.
 *
 * Before `boot` has registered the command, `runCommand` finds nothing to run
 * and the key is left to the page.
 */
function answer(event: KeyboardEvent): void {
  const shortcut = everywhereShortcut(event)
  if (!shortcut || !runCommand(shortcut.command)) return
  event.preventDefault()
  event.stopPropagation()
}

/**
 * Listens in a frame's window, if this page may reach it.
 *
 * Reading `document` is the same-origin test: across origins it throws. A frame
 * that navigates gets a new window and leaves these listeners with the old one;
 * its next `load` comes through `onLoad` and adopts the new window.
 *
 * The tag is read rather than tested with `instanceof`, because a frame inside
 * a frame belongs to the inner window's `HTMLIFrameElement`, not this one's.
 */
function adopt(node: EventTarget | Element | null): void {
  const frame = node as HTMLIFrameElement | null
  if (frame?.tagName !== "IFRAME" && frame?.tagName !== "FRAME") return
  let win: Window | null
  try {
    win = frame.contentWindow
    if (!win?.document) return
  } catch {
    return
  }
  listen(win)
}

/**
 * `load` does not bubble, but capture runs for every event, so one listener on
 * a document sees each frame in it load. On the document, not the window: the
 * DOM stops a `load` at the document, so a window never hears one from a frame.
 * Images load through here too, and `adopt` turns them away on the tag.
 */
function onLoad(event: Event): void {
  adopt(event.target)
}

/**
 * For a frame that takes focus before it has finished loading.
 *
 * Focus moving into a frame blurs the window around it, and by then
 * `activeElement` is the frame, or the shadow host it sits in.
 */
function onBlur(event: Event): void {
  let active = (event.currentTarget as Window).document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  adopt(active)
}

function listen(win: Window): void {
  win.addEventListener("keydown", answer, true)
  win.addEventListener("blur", onBlur)
  win.document.addEventListener("load", onLoad, true)
  for (const frame of win.document.querySelectorAll("iframe, frame")) adopt(frame)
}

/**
 * A key the Mac app's shell heard and handed over.
 *
 * Only from the window this one is framed in, and only from a loopback page,
 * which the desk is. The press is rebuilt as an event so the keymap matches it
 * exactly as it would a key typed here.
 */
function onMessage(event: MessageEvent): void {
  if (window.parent === window || event.source !== window.parent) return
  if (readLoopbackOrigin(event.origin) === null) return
  const data: unknown = event.data
  if (typeof data !== "object" || data === null) return
  const key = data as Record<string, unknown>
  if (key.type !== DESK_KEY_MESSAGE) return
  const press = new KeyboardEvent("keydown", {
    key: String(key.key ?? ""),
    code: String(key.code ?? ""),
    metaKey: key.metaKey === true,
    ctrlKey: key.ctrlKey === true,
    shiftKey: key.shiftKey === true,
    altKey: key.altKey === true,
  })
  const shortcut = everywhereShortcut(press)
  if (shortcut) runCommand(shortcut.command)
}

export function installWayBack(): void {
  listen(window)
  window.addEventListener("message", onMessage)
}
