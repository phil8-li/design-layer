/**
 * One URL fetched for a library, with sign-in walls detected and, where the
 * project configured a way, walked through.
 *
 * The fetch layer of the URL reader, on its own so that the sign-in routes can
 * depend on fetching without depending on the catalog reader. Nothing here
 * knows what a design system is.
 *
 * EVERY NETWORK CALL IS INJECTABLE. `fetchImpl` and `runHelper` are options
 * with real defaults rather than imports, so the test suites run offline
 * against fakes.
 *
 * ONE FETCH IS A SMALL STATE MACHINE, and its end state is named in the
 * result's `outcome` rather than left to a combination of flags:
 *
 *   requesting(hop) --fetch throws on the timeout--------------> timeout
 *   requesting(hop) --fetch throws otherwise-------------------> unreachable
 *   requesting(hop) --the answer is a sign-in wall-------------> walled
 *   requesting(hop) --3xx, Location an http(s) URL-------------> requesting(hop + 1)
 *   requesting(hop) --3xx, Location unreadable or not http(s)--> bad-redirect
 *   requesting(MAX_REDIRECTS) --3xx---------------------------> redirect-limit
 *   requesting(hop) --2xx--------------------------------------> answered
 *   requesting(hop) --any other status-------------------------> http-error
 *   walled --the helper answers 2xx, not a wall----------------> rescued
 *   walled --no helper, or the helper is refused too-----------> walled
 *
 * `ok`, `sso` and `viaHelper` are derived from it in one place (`settle`), so
 * the callers that branch on them — the URL reader and the sign-in routes —
 * keep working, and an agent reading a result sees which ending it was.
 */

import { execFile } from "node:child_process"

import { classifyWall, credentialHeaders, originOf } from "./library-auth.mjs"
import { isPlainObject } from "./library-common.mjs"

/** Long enough for a cold serverless instance, short enough not to hang a panel. */
export const DEFAULT_TIMEOUT_MS = 15000
/**
 * A login page can run to a megabyte; a catalog worth reading is bigger than
 * this module used to allow.
 *
 * Four megabytes was sized against token FILES, and the largest thing read here
 * is not a token file — it is a compiled stylesheet. Tailwind's uncompiled
 * development build and a Figma Variables export for a large library both cross
 * four megabytes, and crossing it is silent: the body is sliced mid-token, JSON
 * stops parsing, CSS loses its tail, and the designer is told nothing was
 * found.
 *
 * It is a cap in BYTES on what is read off the wire: the body is streamed and
 * the stream cancelled at the cap, so one response holds at most this much
 * however much the server sends. Reading the whole body and slicing it after —
 * which is what this did — bounded nothing, and counted UTF-16 units besides.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_REDIRECTS = 5

const ACCEPT = "application/json, text/html;q=0.9, */*;q=0.1"

/** What the panel shows when the URL is real and the editor is not signed in. */
export const SSO_SENTENCE =
  "Needs sign-in: this site refused the editor. " +
  "Sign in to it below, or paste a public URL."

export function isLibraryUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) return false
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    return false
  }
  // Only the two schemes this module can actually fetch. `file:` would be a
  // filesystem read wearing a URL, which is the one thing `resolveSource` in
  // `libraries.mjs` exists to prevent.
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0
}

/**
 * Whether this response is a sign-in wall wearing the clothes of an answer.
 *
 * A thin reading of `classifyWall`, which owns every rule. Kept as its own name
 * because most callers only need the boolean, and because the question reads
 * better at a branch than `classifyWall(...) !== null` does.
 *
 * The case worth knowing about is the 200. `fetch` follows redirects by
 * default, so by the time a caller sees a response the 302 that explains it is
 * gone and all that is left is a successful-looking page of login HTML. Parsed
 * as a library, that page installs a design system made of somebody's sign-in
 * form — so the body evidence is not belt-and-braces, it is the check that
 * stops the failure this whole module was written around.
 */
export function looksLikeSsoWall(response, url = "") {
  if (!isPlainObject(response)) return false
  return classifyWall(response, url) !== null
}

/**
 * A helper command the PROJECT configures, for a site this process cannot
 * authenticate to on its own.
 *
 * This is the generic replacement for what would otherwise be a hardcoded
 * vendor integration. Plenty of organisations front their internal docs with a
 * proxy that has a command-line client — a signed-request tool, a VPN-aware
 * curl wrapper, a credential helper — and the editor has no business knowing
 * which. So it knows none of them: the project names a command in its config,
 * the editor runs it when a fetch is refused, and the command's job is to print
 * an HTTP response.
 *
 *   libraries: { fetchCommand: ["my-auth-curl", "--dump-header", "-", "{url}"] }
 *
 * `{url}` is substituted per argument. The command must print a full HTTP
 * response — status line, headers, blank line, body — which is what
 * `curl -i` and most such tools already emit, and what `parseHttpResponse`
 * below reads back. A bare body would be indistinguishable from an error page,
 * which is the same "install the login screen as a library" failure the wall
 * detection exists to prevent.
 *
 * Unset by default, so out of the box the editor does no such thing. When it is
 * set, `execFile` with an argv array and never a shell: the URL is input that
 * arrived from a web page, and a shell here would make that a command
 * injection.
 */
function runFetchCommand(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchCommand = null } = {}) {
  const argv = Array.isArray(fetchCommand) ? fetchCommand.filter((part) => typeof part === "string") : []
  if (argv.length < 1) return Promise.resolve(null)

  const [binary, ...rest] = argv.map((part) => part.split("{url}").join(url))
  return new Promise((resolve) => {
    execFile(
      binary,
      rest,
      { timeout: timeoutMs, maxBuffer: MAX_RESPONSE_BYTES, encoding: "utf8" },
      (error, stdout) => {
        // A missing binary is the ordinary case for a config carried between
        // machines: there is no helper here, so there is no second route, and
        // the caller reports the wall.
        if (error?.code === "ENOENT") {
          resolve(null)
          return
        }
        // A non-zero exit is NOT a reason to discard the output. These tools
        // conventionally exit non-zero on any HTTP error while still printing
        // the response, and a 401 is exactly what the caller needs to see.
        resolve(parseHttpResponse(typeof stdout === "string" ? stdout : ""))
      }
    )
  })
}

/** Where the header block of a printed response ends: `{ at, width }`, or null. */
function headerEnd(dump, from) {
  const crlf = dump.indexOf("\r\n\r\n", from)
  const lf = dump.indexOf("\n\n", from)
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { at: crlf, width: 4 }
  return lf !== -1 ? { at: lf, width: 2 } : null
}

/**
 * A printed HTTP response — status line, headers, body — as a record.
 *
 * The LAST header block is the response. A helper that follows redirects
 * (`curl -i -L`) prints one block per hop, and a proxy prints its own
 * `HTTP/1.1 200 Connection established` before the real one; reading the first
 * block reported the proxy's status and served the next block's headers as the
 * body.
 */
function parseHttpResponse(dump) {
  if (!/^HTTP\/[\d.]+ \d{3}/.test(dump)) return null
  let start = 0
  let split = headerEnd(dump, start)
  while (split && /^HTTP\/[\d.]+ \d{3}/.test(dump.slice(split.at + split.width, split.at + split.width + 16))) {
    start = split.at + split.width
    split = headerEnd(dump, start)
  }
  if (!split) return null
  const status = /^HTTP\/[\d.]+ (\d{3})/.exec(dump.slice(start))

  const headers = {}
  for (const line of dump.slice(start, split.at).split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return {
    status: Number(status[1]),
    contentType: headers["content-type"] ?? "",
    text: dump.slice(split.at + split.width, split.at + split.width + MAX_RESPONSE_BYTES),
    location: headers.location ?? "",
    headers,
  }
}

/**
 * The header set as a plain object with lower-cased names, from either shape a
 * response carries them in: a `Headers` (what `fetch` returns) or a plain object
 * (every test fake, and some polyfills). `classifyWall` reads
 * `www-authenticate` and `location` off it, and must not be limited to what
 * this function anticipated.
 */
function lowerCasedHeaders(headers) {
  if (!headers) return {}
  const pairs =
    typeof headers.entries === "function" ? [...headers.entries()] : isPlainObject(headers) ? Object.entries(headers) : []
  return Object.fromEntries(pairs.map(([key, value]) => [String(key).toLowerCase(), value]))
}

/** A string cut to at most `MAX_RESPONSE_BYTES` of UTF-8. */
function capped(text) {
  if (text.length * 3 <= MAX_RESPONSE_BYTES || Buffer.byteLength(text) <= MAX_RESPONSE_BYTES) return text
  return Buffer.from(text, "utf8").subarray(0, MAX_RESPONSE_BYTES).toString("utf8")
}

/**
 * The body as text, never more than `MAX_RESPONSE_BYTES` of it.
 *
 * Streamed when the response has a stream, which every real one does: bytes
 * are counted as they arrive and the stream is cancelled at the cap, keeping
 * the head. A body that fails part-way reads as empty, as it did when the whole
 * body was awaited at once — half a stylesheet is a different design system.
 * A response with no stream (a test fake) is read whole and cut.
 */
async function readBody(response) {
  const reader = typeof response?.body?.getReader === "function" ? response.body.getReader() : null
  if (!reader) {
    try {
      return capped(String(await response.text()))
    } catch {
      return ""
    }
  }
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const room = MAX_RESPONSE_BYTES - bytes
      const chunk = value.byteLength > room ? value.subarray(0, room) : value
      bytes += chunk.byteLength
      text += decoder.decode(chunk, { stream: true })
      if (bytes >= MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        // Not flushed: a character the cap cut in half is dropped rather
        // than replaced by one three bytes wider.
        return text
      }
    }
  } catch {
    return ""
  }
  return text + decoder.decode()
}

async function readResponse(response) {
  const headers = lowerCasedHeaders(response?.headers)
  return {
    status: Number(response?.status) || 0,
    contentType: String(headers["content-type"] ?? ""),
    text: await readBody(response),
    location: String(headers.location ?? ""),
    headers,
  }
}

/** Whether a helper's answer got through the wall. */
function isRescue(answer, url) {
  return (
    isPlainObject(answer) &&
    Number(answer.status) >= 200 &&
    Number(answer.status) < 300 &&
    !looksLikeSsoWall(answer, url)
  )
}

/**
 * The one place a fetch's ending becomes a result. Every field a caller reads
 * is derived from `outcome` here, so no two endings can disagree about what
 * `ok` or `sso` mean.
 */
function settle(outcome, { status = 0, contentType = "", text = "", wall = null, error = "" } = {}) {
  return {
    outcome,
    ok: outcome === "answered" || outcome === "rescued",
    status,
    contentType,
    text,
    viaHelper: outcome === "rescued",
    sso: outcome === "walled",
    ...(outcome === "walled" ? { wall } : {}),
    error,
  }
}

function unreachable(error, url) {
  const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError"
  return timedOut
    ? settle("timeout", { error: `${url} took too long to answer` })
    : settle("unreachable", { error: `${url} could not be reached (${error?.message ?? "network error"})` })
}

/**
 * One URL fetched, with sign-in walls detected and, where possible, walked
 * through. The ending is one of the outcomes in the header.
 *
 * `redirect: "manual"` on purpose. The default would follow the 302 to the
 * login service and hand back a 200 with no trace of the hop, which is the
 * shape this module cannot afford to be handed. So redirects are followed here
 * instead — an http-to-https hop and a trailing-slash hop are ordinary and must
 * keep working — and the chain stops the moment a hop points at a login page.
 *
 * `sso` is what the probe chain reads: it separates "this host refused us" from
 * "there is nothing at that path", and only the first is worth abandoning the
 * whole chain over. `viaHelper` records that the answer came back through the
 * project's configured helper command rather than through `fetch`, which is a
 * fact worth having when a response looks different from a browser's.
 *
 * `helperGate`, when the caller passes one (a `Map`), shares the helper's
 * verdict per origin across the fetches of one reading. A host that walls every
 * path used to start the helper once per probe — sixteen child processes for
 * one paste, each allowed fifteen seconds. Now the first walled fetch on an
 * origin runs it, the rest wait for that answer, and they only run their own if
 * the first got through.
 */
export async function fetchLibraryUrl(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    runHelper = runFetchCommand,
    fetchCommand = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    helperGate = null,
    /*
     * A credential for this URL's origin, when the designer has signed this
     * editor in to it. Sent on the FIRST request rather than after a refusal:
     * a wall costs a round trip to discover and the answer is already known
     * here, so re-learning it per probe would multiply the slowest path in the
     * module by the number of probes.
     */
    credential = null,
  } = options
  // Checked here as well as by every caller that builds a URL, because the
  // sign-in route passes on what the panel sent: `fetch` accepts `data:` URLs.
  if (!isLibraryUrl(String(url))) {
    return settle("unreachable", { error: `${url} is not an http:// or https:// address` })
  }
  const authHeaders = credentialHeaders(credential)
  // The origin the credential belongs to. Empty when there is none, which can
  // never equal a real origin, so the guard below simply sends nothing.
  const credentialOrigin = credential ? originOf(credential.origin ?? url) : ""

  let target = String(url)
  let record = null
  let wall = null
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response
    try {
      response = await fetchImpl(target, {
        redirect: "manual",
        /*
         * The credential goes ONLY to the origin it was stored for.
         *
         * A redirect can point anywhere, including at a host the designer has
         * never heard of, and a bearer token forwarded across that hop is a
         * token handed to a third party. Browsers strip `Authorization` on a
         * cross-origin redirect for exactly this reason and `fetch` cannot do
         * it for us here, because following redirects by hand is what the
         * `manual` mode above exists for — so the check is ours to make.
         *
         * Recomputed per hop rather than once, since a chain can leave the
         * origin and come back.
         */
        headers: { accept: ACCEPT, ...(originOf(target) === credentialOrigin ? authHeaders : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      return unreachable(error, target)
    }

    record = await readResponse(response)
    /*
     * Classified ONCE, against the hop that answered — `target`, never the
     * pasted URL. Every cross-origin rule in `classifyWall` compares a redirect
     * with the request it answered, and the origin it reports is the one the
     * designer has to sign in to. Testing without the request URL read every
     * OAuth bounce as "not a wall" and installed the login page; testing
     * against the pasted URL after a cross-host hop named a host that never
     * refused anything, and a credential saved for it is never sent to the one
     * that did.
     */
    wall = classifyWall(record, target)
    if (wall) break
    if (record.status >= 300 && record.status < 400 && record.location) {
      let next
      try {
        next = new URL(record.location, target).toString()
      } catch {
        next = ""
      }
      if (!isLibraryUrl(next)) {
        return settle("bad-redirect", {
          status: record.status,
          contentType: record.contentType,
          error: `${target} sent a redirect this editor cannot follow`,
        })
      }
      target = next
      continue
    }

    const ok = record.status >= 200 && record.status < 300
    return settle(ok ? "answered" : "http-error", {
      status: record.status,
      contentType: record.contentType,
      text: record.text,
      error: ok ? "" : `${target} answered HTTP ${record.status}`,
    })
  }

  if (!wall) {
    return settle("redirect-limit", {
      status: record?.status ?? 0,
      contentType: record?.contentType ?? "",
      text: record?.text ?? "",
      error: `${url} redirected more times than this editor will follow`,
    })
  }

  const rescued = await throughHelper(String(url), { runHelper, timeoutMs, fetchCommand, helperGate })
  if (rescued) {
    return settle("rescued", {
      status: Number(rescued.status),
      contentType: String(rescued.contentType ?? ""),
      text: typeof rescued.text === "string" ? rescued.text : "",
    })
  }

  /*
   * The refusal, read rather than merely reported.
   *
   * `sso: true` is the flag the probe chain has always branched on. `wall` is
   * the new half: which kind of sign-in this is, and — for OAuth — the
   * client id pulled out of the redirect, which is the audience an identity
   * token has to be minted for. Nothing else in the exchange names it, so a
   * refusal that throws it away leaves the designer needing a string they have
   * no way to look up.
   */
  return settle("walled", { status: record.status, contentType: record.contentType, wall, error: SSO_SENTENCE })
}

/** The helper's answer when it got through the wall, or null. See `helperGate`. */
async function throughHelper(url, { runHelper, timeoutMs, fetchCommand, helperGate }) {
  const origin = originOf(url)
  const scout = helperGate?.get(origin)
  if (scout && !(await scout)) return null
  const attempt = Promise.resolve(runHelper(url, { timeoutMs, fetchCommand })).catch(() => null)
  if (helperGate && !scout) helperGate.set(origin, attempt.then((answer) => isRescue(answer, url)))
  const answer = await attempt
  // Judged against the pasted URL, not a hop: the helper fetched the URL itself.
  return isRescue(answer, url) ? answer : null
}
