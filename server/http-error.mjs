/**
 * The one way a server module refuses a request.
 *
 * An `Error` with a `statusCode`: the route table's catch turns it into
 * `{ ok: false, message }` with that status, and the start screen's does the
 * same. It lives in a leaf module so every server file can import it; seven
 * modules used to keep their own copy, one of them on purpose to dodge an
 * import cycle through `routes.mjs`.
 */
export function httpError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}
