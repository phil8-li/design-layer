/**
 * Where the chooser screen is, for the two halves of the process that need it.
 *
 * It began as one function inside the launcher, which was the only caller while
 * the answer was only ever injected into a page. It is a module of its own now
 * because `server/apps.mjs` asks the same screen for the list of running apps,
 * and the launcher cannot be imported from there: loading it patches `fs`,
 * `http` and `net` and pulls in the vendor bundle, none of which a route
 * handler has any business causing. The alternative was a second copy of the
 * environment read and the loopback check, and two copies is how one of them
 * comes to accept an origin the other refuses.
 */

/**
 * Mirrors `isLoopbackHost` in server/routes.mjs. Not imported from there: that
 * module pulls in the agent and the options store, and the launcher loads this
 * before the vendor boots, when neither exists yet.
 */
function isLoopbackOrigin(value) {
  if (typeof value !== "string" || value.length === 0) return false
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "")
    return host === "localhost" || host === "127.0.0.1" || host === "::1"
  } catch {
    return false
  }
}

/**
 * The chooser screen this editor was started from, or null when there is none.
 *
 * A supervisor that keeps its chooser alive for the whole session sets
 * `DESIGNLAYER_CHOOSER_URL` on the editor process, and that is the ONLY way
 * this value arrives. Started any other way — a plain `node cli.mjs 3000`, or
 * `--dev` — there is no second screen in existence, so there is nothing to
 * guess at and no default worth inventing: the toolbar simply carries no way
 * back, which is the truth about that session.
 *
 * The value ends up as an `href` inside the page, so it is held to the same
 * rule as every other origin this package accepts: loopback, and http. The
 * parsed form is what is handed on rather than the raw environment string,
 * because the URL parser tolerates leading control characters and whitespace
 * that the injected copy should not carry.
 */
export function chooserUrlFromEnv(env = process.env) {
  const value = env.DESIGNLAYER_CHOOSER_URL
  if (!isLoopbackOrigin(value)) return null
  const url = new URL(value)
  return url.protocol === "http:" ? url.href : null
}

/**
 * Exported for the launcher's WebSocket handshake guard, which asks the same
 * question of a browser-supplied Origin. It travels with `chooserUrlFromEnv`
 * rather than staying behind because that function is the reason the rule is
 * written down, and a guard reading a second definition of "loopback" is the
 * disagreement this module exists to prevent.
 */
export { isLoopbackOrigin }
