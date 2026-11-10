/**
 * The loopback guard every DesignLayer server applies: the editor's routes,
 * the MCP endpoint, the start screen and the Mac app's desk.
 *
 * Three copies of it used to exist (here in `server/`, in
 * `runtime/start-screen.mjs` and in `desktop/mac/desk-server.mjs`), each
 * kept because importing `server/routes.mjs` would have built the whole editor
 * server. It lives in `runtime/` and imports only `chooser-url.mjs`, another
 * leaf, so the start screen and the desk can take it without pulling in a
 * server module, and the MCP control can default to it without importing the
 * route table that imports the control. `routes.mjs` re-exports it under the
 * name callers already use.
 */

import { isLoopbackHost } from "./chooser-url.mjs"

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

/**
 * `"null"` is NOT an exemption. It is the Origin a sandboxed iframe, a
 * `data:`/`blob:` document, or a redirected cross-origin form sends, and those
 * are precisely the contexts an attacker controls. Treating it as "no origin"
 * let any page reach these routes with a CORS-preflight-free request.
 *
 * A genuinely absent header still passes: curl and the test harness send none,
 * and a non-browser client carries no ambient credentials to abuse.
 *
 * Any loopback Origin passes, which includes every other dev server on this
 * machine; `contentTypeRefusal` in `http-json.mjs` is the half that stops such
 * a page from sending a state-changing request without a preflight.
 *
 * Shared with the MCP endpoint on its own port: the transport spec requires
 * Origin validation against DNS rebinding, and a second implementation of it
 * is how the two come to disagree about `"null"`.
 */
export function isLocalRequest(req) {
  if (!LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress ?? "")) return false
  if (!isLoopbackHost(req.headers.host)) return false
  const origin = req.headers.origin
  if (origin !== undefined && !isLoopbackHost(origin)) return false
  return true
}
