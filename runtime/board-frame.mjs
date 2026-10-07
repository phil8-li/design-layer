/**
 * Canvas-mode frames: keep the editor out of them, and let them load at all.
 *
 * The board shows each page of the host app in a same-origin iframe, and every
 * page the proxy serves carries the overlay script. Left alone, each frame would
 * boot a whole second editor, and the vendor's WebSocket server keeps exactly
 * one client — `activeClient.close(4001, "replaced by new connection")` — so the
 * last frame to load would kick the real editor off the socket.
 *
 * The board marks its frames two ways, and the check accepts either: the frame's
 * `name`, which the document inside can read before anything else, and an
 * attribute on the <iframe> element, which survives a page that reassigns
 * `window.name`. The client lane in src/board/ sets both, from these constants.
 */

export const BOARD_FRAME_NAME_PREFIX = "designlayer-frame:"
export const BOARD_FRAME_ATTRIBUTE = "data-designlayer-frame"

// `frameElement` is null in a top-level window and throws in some embedders; a
// throw is read as "not a board frame" so the editor still boots where it would
// have before this guard existed.
//
// The last two tests cover every OTHER same-origin frame, which takes the socket
// just the same: a host page embedding `<iframe src="/preview">` booted a
// second editor there and closed the real one's connection. Reading
// `location.href` throws across origins, so an editor framed by a page on
// another origin — the Mac app's shell, on its own port — still boots. The
// parent is asked as well as the top because in the Mac app the top is the
// shell, which reads as cross-origin from every frame inside the editor too:
// only the parent tells the host's own frame there from the editor's page.
const IN_BOARD_FRAME =
  `(function(){try{return window.name.indexOf(${JSON.stringify(BOARD_FRAME_NAME_PREFIX)})===0||` +
  `!!(window.frameElement&&window.frameElement.hasAttribute(${JSON.stringify(BOARD_FRAME_ATTRIBUTE)}))}` +
  `catch(e){return false}})()||` +
  `(function(){try{return window.parent!==window&&!!window.parent.location.href}catch(e){return false}})()||` +
  `(function(){try{return window.top!==window&&!!window.top.location.href}catch(e){return false}})()`

/**
 * Wraps the served overlay so none of it runs inside a board frame.
 *
 * A block, not a function: the vendor bundle's `var ReactRewrite=` has to stay
 * a global, and `var` inside an `if` block of a classic script still lands on
 * the window where a function wrapper would scope it away. Skipping instead of
 * throwing matters too — Next's dev overlay reports an uncaught error in a frame
 * the same as in the page.
 */
export function guardBoardFrames(source) {
  return `if (!(${IN_BOARD_FRAME})) {\n${source}\n}\n`
}

function isBoardFrameRequest(request) {
  const headers = request?.headers
  return headers?.["sec-fetch-dest"] === "iframe" && headers?.["sec-fetch-site"] === "same-origin"
}

// The two tags the vendor's proxy appends to every HTML page, byte for byte as
// `inject.js` writes them.
const INJECTED_TAGS =
  /\n<script src="\/__react-rewrite\/overlay\.js"><\/script>\n<script>window\.__REACT_REWRITE_WS_PORT__ = \d+;<\/script>/
const OVERLAY_SRC = 'src="/__react-rewrite/overlay.js"'

/**
 * What a same-origin frame gets in place of the tags: one inline script that
 * writes them only if the frame turns out to be the editor's own page.
 *
 * A same-origin frame request is nearly always a frame inside a page of this
 * app, a board frame or one the host made, and those must not download the
 * ~3MB overlay. But the editor's own page sends exactly the same Fetch Metadata
 * when the Mac app's shell frames it and it navigates itself: a dev server's
 * full reload, a `location.href` assignment. The tags used to be cut there too,
 * so in the Mac app the editor came back from every full reload with no panels
 * and no toolbar, and ⌘. had no editor to bring back. The request cannot tell
 * the two apart; the frame can, with the guard the overlay already carries.
 *
 * `document.write` from a parser-inserted script puts the tags exactly where
 * the proxy would have, so the overlay runs at the same point in the page's
 * load either way. The string is escaped so no `</script>` closes the loader.
 */
function frameLoader(tags) {
  const literal = JSON.stringify(tags.trim()).replace(/</g, "\\u003c")
  return `\n<script>if(!(${IN_BOARD_FRAME}))document.write(${literal})</script>`
}

/**
 * Rewrites the overlay tags in an HTML page on its way out.
 *
 * A same-origin frame gets `frameLoader` instead of the tags. The guard above
 * stops the overlay RUNNING in a frame, but only after the frame has downloaded
 * and compiled all ~3MB of it — per frame, so a board of a dozen pages paid
 * that a dozen times for code that never ran. The loader asks the same
 * question before anything is fetched. The guard stays as the backstop for
 * whatever this misses: a page the vendor injected into differently, or a
 * browser that sends no Fetch Metadata.
 *
 * A page gets the script at `versioned()` instead — a URL that names the exact
 * body it will be served (`?v=<hash>`), so the response can be cached as
 * immutable and a reload runs the script straight from cache with no round
 * trip at all. It is a thunk because most responses through here are not HTML
 * and never need the answer.
 *
 * The vendor writes an HTML page with one `writeHead` carrying its
 * `content-length` and one `end` carrying the body, so `writeHead` is held for
 * an HTML response until the body arrives, then both go out with the tags
 * rewritten and the length recounted. Anything else — a script, a 502, a body
 * that is streamed — is passed straight through.
 */
export function rewriteOverlayInjection(request, response, versioned) {
  const frame = isBoardFrameRequest(request)
  if (!frame && !versioned) return
  const { writeHead, write, end } = response
  let held = null
  const restore = () => {
    response.writeHead = writeHead
    response.write = write
    response.end = end
  }
  const flush = () => {
    restore()
    if (held) writeHead.apply(response, held)
    held = null
  }

  response.writeHead = function holdHtmlHead(...args) {
    const headers = args.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg))
    const type = headers && Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1]
    if (!String(type ?? "").includes("text/html")) {
      restore()
      return writeHead.apply(this, args)
    }
    held = args
    return this
  }
  response.write = function writeAfterHead(...args) {
    flush()
    return write.apply(this, args)
  }
  response.end = function endRewritten(chunk, ...rest) {
    if (held && typeof chunk === "string" && INJECTED_TAGS.test(chunk)) {
      chunk = chunk.replace(INJECTED_TAGS, (tags) => {
        const served = versioned ? tags.replace(OVERLAY_SRC, `src="${versioned()}"`) : tags
        return frame ? frameLoader(served) : served
      })
      const headers = held.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg))
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "content-length") headers[name] = String(Buffer.byteLength(chunk))
      }
    }
    flush()
    return end.call(this, chunk, ...rest)
  }
}

/** The CSP value with only its `frame-ancestors` directive removed. */
function withoutFrameAncestors(policy) {
  return String(policy)
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^frame-ancestors(\s|$)/i.test(directive))
    .join("; ")
}

/**
 * Drops what stops the board framing the host's own pages.
 *
 * A host that sends `X-Frame-Options: DENY` or `frame-ancestors 'none'` would
 * render every board frame blank. Only a same-origin iframe request is relaxed —
 * the board is the proxy's own origin — so a cross-site page still cannot frame
 * the app through this proxy, and a top-level load keeps every header. The rest
 * of the policy is left exactly as the host wrote it.
 */
export function stripFrameBlockingHeaders(request, headers) {
  if (!headers || typeof headers !== "object" || !isBoardFrameRequest(request)) return headers
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase()
    if (lower === "x-frame-options") {
      delete headers[name]
    } else if (lower === "content-security-policy") {
      const value = headers[name]
      const policy = Array.isArray(value)
        ? value.map(withoutFrameAncestors).filter(Boolean)
        : withoutFrameAncestors(value)
      if (policy.length === 0) delete headers[name]
      else headers[name] = policy
    }
  }
  return headers
}

/**
 * The same relaxation for headers a handler set with `setHeader` before
 * `writeHead`, which never appear in the object `writeHead` is handed.
 */
export function stripFrameBlockingResponseHeaders(response) {
  if (!isBoardFrameRequest(response?.req)) return
  response.removeHeader("x-frame-options")
  const current = response.getHeader("content-security-policy")
  if (current === undefined) return
  const stripped = stripFrameBlockingHeaders(response.req, { "content-security-policy": current })
  if (stripped["content-security-policy"] === undefined) response.removeHeader("content-security-policy")
  else response.setHeader("content-security-policy", stripped["content-security-policy"])
}
