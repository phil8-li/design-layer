/**
 * The one way a server module refuses a request.
 *
 * An `Error` with a `statusCode`: the route table's catch turns it into
 * `{ ok: false, message }` with that status, and the start screen's does the
 * same. A leaf in `runtime/`, so the start screen and every server file can
 * import it (the server may import `runtime/`, never the reverse); eleven
 * modules used to keep their own copy, one of them on purpose to dodge an
 * import cycle through `routes.mjs`.
 */
export function httpError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}
