/**
 * DesignLayer.app, from the chrome's side.
 *
 * The Mac app (desktop/mac) is one window of tabs, each an iframe of an editor
 * like this one, served by a "desk" on another loopback port. The same editor
 * can be open there or in a browser tab, and the toolbar offers the move in
 * one direction: out of a browser tab and into the app. Inside the app there
 * is nowhere better to send it, so the control is not drawn there at all.
 *
 * Moving is a hand-off rather than a copy. The vendor's socket takes one
 * client, so the app's frame connecting is what disconnects this tab — nothing
 * here has to close it, and nothing could: a script may only close windows a
 * script opened.
 */

import { config } from "../core/config"

/**
 * What the desk names each tab's frame, followed by the tab's id.
 *
 * Any page can name a frame, so the name decides nothing where the browser
 * reports the parent's origin (`ancestorOrigins`, which Chrome, the app's only
 * browser, always does); see `deskOrigin`. It is the fallback where that
 * property is missing.
 */
export const DESK_FRAME_PREFIX = "designlayer-desk:"

/**
 * The `type` of the message the desk posts with a key typed on its tab strip.
 *
 * The editor is a cross-origin frame in the app, so a key pressed while focus
 * is in the shell never reaches it. The shell posts the accelerators it does
 * not use itself, and `shell/way-back.ts` answers the ones meant to work from
 * anywhere. desktop/mac/shell-page.mjs spells the same string.
 */
export const DESK_KEY_MESSAGE = "designlayer-desk:key"

/**
 * The `type` of the message this editor posts to the desk: which app the frame
 * is showing, and on which page.
 *
 * The desk used to guess. It relabeled a Home tab only while the window had
 * focus, only if no other tab was on the same editor (and every editor then
 * shared one proxy port), and never followed a switch made inside the frame. So a tab
 * that showed one app kept the name "Home", or the name of the app before. The
 * frame knows what it shows; it says so on load and on every page change.
 * desktop/mac/shell-page.mjs spells the same string.
 */
export const DESK_SHOWING_MESSAGE = "designlayer-desk:showing"

/**
 * The `type` of the message this editor posts to ask the desk to show another
 * editor's URL.
 *
 * Inside the app every editor runs at once, one per app, each in its own tab.
 * A frame that navigated itself to another editor put a second copy of that
 * editor in the window, and the vendor's socket takes one client, so the copy
 * disconnected the tab that was already showing it. The desk knows which tab
 * shows which editor: it selects that tab, or opens the URL in a new tab when
 * no tab shows it. It never replaces the sending tab, so this document and the
 * unapplied edits it holds stay. desktop/mac/shell-page.mjs spells the same
 * string.
 */
export const DESK_GO_MESSAGE = "designlayer-desk:go"

/**
 * The origins the desk can be on: the one the prelude names, and the same port
 * on the other loopback spelling.
 *
 * The desk moved from `127.0.0.1` to `localhost` so that editor frames are
 * same-site with it, and a desk window opened before the app was reinstalled
 * is still on the old host. Both are this machine's loopback, so the port is
 * the part that names the desk.
 */
function deskOrigins(): string[] {
  const desk = config.deskUrl
  if (!desk) return []
  try {
    const url = new URL(desk)
    const other = url.hostname === "localhost" ? "127.0.0.1" : url.hostname === "127.0.0.1" ? "localhost" : null
    return other ? [url.origin, `${url.protocol}//${other}${url.port ? `:${url.port}` : ""}`] : [url.origin]
  } catch {
    return [desk]
  }
}

/**
 * The desk page's origin, for a message only the desk may read, or null when
 * this frame's parent is not the desk.
 *
 * The parent's origin decides, not the frame's name. Any page can frame an
 * editor and name the frame `designlayer-desk:x`, and a check on the name alone
 * posted the app's name and the page path to whatever origin that page was on.
 * `ancestorOrigins` is set by the browser, so a page cannot forge it. Where it
 * is missing (not Chrome, which the app never is) the name is all there is, and
 * the message is aimed at the prelude's desk origin, so the browser delivers it
 * to nothing else.
 */
function deskOrigin(win: Window): string | null {
  if (win.parent === win) return null
  // Typed as always present; jsdom and Firefox have no such property.
  const ancestors: DOMStringList | undefined = win.location.ancestorOrigins
  if (ancestors) {
    const parent = ancestors.length > 0 ? ancestors[0] : null
    return parent && deskOrigins().includes(parent) ? parent : null
  }
  return win.name.startsWith(DESK_FRAME_PREFIX) ? config.deskUrl : null
}

export function tellDesk(name: string | null, page: string, win: Window = window): void {
  const target = deskOrigin(win)
  if (!target) return
  win.parent.postMessage({ type: DESK_SHOWING_MESSAGE, name, page }, target)
}

/**
 * Hands `url` to the desk instead of navigating this frame. False when this is
 * not one of the app's tabs, or the desk's origin is unknown, and the caller
 * navigates itself.
 */
export function goInDesk(url: string, win: Window = window): boolean {
  const target = deskOrigin(win)
  if (!target) return false
  win.parent.postMessage({ type: DESK_GO_MESSAGE, url }, target)
  return true
}

/**
 * True when this editor is one of the Mac app's tabs rather than a browser tab.
 *
 * The same rule as the messages, so a frame that is told it is in the desk is
 * always a frame whose `goInDesk` is delivered: the chooser skips its discard
 * warning on this answer, and a go that then fell back to navigating would
 * lose the edits the warning was for.
 */
export function isInDesk(win: Window = window): boolean {
  return deskOrigin(win) !== null
}

export type DeskAnswer =
  /** `delivered` is how many app windows took the page: 0 while the app is still starting. */
  | { ok: true; delivered: number }
  /** `refused` carries the desk's own sentence; `unreachable` means nothing answered. */
  | { ok: false; reason: "refused" | "unreachable"; message?: string }

/**
 * Ask the desk to open `url` in the app and bring the app forward.
 *
 * The body is a JSON string sent as text/plain, which keeps the POST a simple
 * cross-origin request with no preflight. The desk echoes the CORS header for
 * loopback origins only, and refuses every other origin before it reads the
 * body (desktop/mac/desk-server.mjs `isLocalRequest`).
 *
 * The timeout is for a desk that accepted the connection and then hung. A desk
 * that is not running refuses the connection at once.
 */
export async function openInDesk(url: string, timeoutMs = 4000): Promise<DeskAnswer> {
  const desk = config.deskUrl
  if (!desk) return { ok: false, reason: "unreachable" }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${desk}/api/open`, {
      method: "POST",
      body: JSON.stringify({ url }),
      cache: "no-store",
      signal: controller.signal,
    })
    const body: unknown = await response.json().catch(() => null)
    const answer = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
    if (response.ok && answer.ok === true) {
      return { ok: true, delivered: typeof answer.delivered === "number" ? answer.delivered : 0 }
    }
    return {
      ok: false,
      reason: "refused",
      message: typeof answer.error === "string" ? answer.error : undefined,
    }
  } catch {
    return { ok: false, reason: "unreachable" }
  } finally {
    clearTimeout(timer)
  }
}
