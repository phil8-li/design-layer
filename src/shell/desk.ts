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
 * `window.name` is the one fact about its frame a framed page can read from
 * the inside whatever origin the parent is on. `ancestorOrigins` says the same
 * thing in Chrome, which is the only browser the app runs in, and covers a
 * frame the desk page made before it started naming them.
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

/** True when this editor is one of the Mac app's tabs rather than a browser tab. */
export function isInDesk(win: Window = window): boolean {
  if (win.name.startsWith(DESK_FRAME_PREFIX)) return true
  // Typed as always present; jsdom and Firefox have no such property.
  const ancestors: DOMStringList | undefined = win.location.ancestorOrigins
  return Boolean(config.deskUrl && ancestors?.contains(config.deskUrl))
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
