/**
 * JSON over loopback HTTP: the reply writer, the body reader and the
 * content-type rule that the editor's routes and the MCP endpoint share.
 *
 * They used to keep one copy each, with two body limits and two readers, and
 * only one of them refused a body that was not JSON.
 */

import { httpError } from "../runtime/http-error.mjs"

export function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    ...extraHeaders,
  })
  res.end(body)
}

/** The whole body as text; past `limit` bytes it is a 413 and the stream is dropped. */
export async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw httpError("Request body is too large", 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Whether the request says its body is JSON, by the media type's essence.
 *
 * The essence, not a substring: `text/plain; x=application/json` is still
 * `text/plain` to a browser, so it is still a CORS-simple request that needs no
 * preflight. A substring test let exactly that through.
 */
export function isJsonContentType(req) {
  const essence = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase()
  return essence === "application/json"
}

/** Whether a request carries a body at all, by its framing headers. */
function hasBody(req) {
  if (req.headers["transfer-encoding"] !== undefined) return true
  const length = Number(req.headers["content-length"] ?? 0)
  return Number.isFinite(length) && length > 0
}

/**
 * Why a state-changing request is refused before any route runs, or null.
 *
 * The loopback guard accepts any loopback Origin, and that includes every
 * other dev server on this machine. A POST whose content type is `text/plain`,
 * a form type or none at all is a CORS-SIMPLE request: the browser sends it
 * without a preflight, so the side effect lands even though the page cannot
 * read the reply. Measured before this rule: a `text/plain` POST from
 * `http://localhost:8123` queued instructions for the designer's coding agent.
 *
 * Demanding `application/json` forces a preflight, which these servers never
 * answer, so the request is never sent. POST always needs it, body or not: an
 * empty POST is simple too, and `/mcp/stay` reads an empty body as "off".
 * PUT, PATCH and DELETE are never simple, so they are preflighted whatever
 * they carry; they need the type only when they carry a body, which keeps a
 * body-less DELETE (removing a saved option, a library) working.
 */
export function contentTypeRefusal(req) {
  const method = req.method ?? "GET"
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null
  if (isJsonContentType(req)) return null
  if (method !== "POST" && !hasBody(req)) return null
  return "Content-Type must be application/json"
}
