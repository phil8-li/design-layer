/**
 * The loopback guard every DesignLayer route and the MCP endpoint apply.
 *
 * A leaf module so the MCP control can default to it without importing the
 * route table that imports the control. `routes.mjs` re-exports it under the
 * name callers already use.
 */

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

function hostnameOf(value) {
  if (typeof value !== "string" || value.length === 0) return ""
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`)
    return url.hostname.replace(/^\[|\]$/g, "")
  } catch {
    return ""
  }
}

function isLoopbackHost(value) {
  const host = hostnameOf(value)
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

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
