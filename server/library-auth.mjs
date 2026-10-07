/**
 * Credentials for design-system URLs behind a sign-in wall, and the reading of
 * the wall itself.
 *
 * ## Why this exists at all
 *
 * A library URL is fetched by the EDITOR'S SERVER, not by the designer's
 * browser, and those two are signed in to entirely different things. A designer
 * who can open a component catalog in their browser — an SSO session, an OAuth
 * cookie, a VPN-scoped proxy — has given this Node process none of it, and
 * cannot: the session lives on another origin, so the panel cannot read it and
 * hand it over either. The gap is the whole problem. Without something here,
 * every design system that is not public reads as "empty" to this editor, which
 * is the one answer that is worse than an error.
 *
 * ## The flow, and the one thing that makes it trustworthy
 *
 *   fetch -> refused -> CLASSIFY the refusal -> ask for exactly what would open
 *   it -> verify that it does -> store it -> retry
 *
 * The verification step is not a nicety. A credential that does not work,
 * stored anyway, produces a panel claiming the designer is signed in to an
 * origin whose libraries still fail — and they will then look for the fault
 * anywhere except the token they just pasted. So `saveCredential` is
 * unreachable except behind a fetch that came back unwalled; see `routes.mjs`.
 *
 * ## Reading a refusal without knowing whose site it is
 *
 * Every rule below is an HTTP or OAuth standard rather than a fact about one
 * vendor, because the editor cannot know which identity provider it has walked
 * into and must not have to:
 *
 *   - **401** is the only unambiguous answer, and RFC 7235 says what to send
 *     back: the `WWW-Authenticate` challenge names the scheme and the realm.
 *   - **403** means reached but refused. A credential may or may not help, and
 *     the wording says so rather than promising.
 *   - **A cross-origin redirect carrying `response_type` and `client_id`** is an
 *     OAuth 2.0 authorization request (RFC 6749 §4.1.1). That is worth
 *     recognising by shape, because `client_id` is the AUDIENCE an identity
 *     token has to be minted for, and nothing else in the exchange names it.
 *   - **A cross-origin redirect to a sign-in-shaped path** is the ordinary SSO
 *     bounce. Cross-origin matters: an app redirecting to its own `/login` is
 *     routing, while being sent to somebody else's host is a handoff.
 *   - **A 200 that is a login page** is the case that catches people out. Follow
 *     a redirect and the hop disappears, so the status code alone proves
 *     nothing; an HTML body carrying a password input where a catalog was
 *     expected is the evidence that survives.
 *
 * Nothing here matches a hostname. A vendor-specific marker would work for
 * exactly one company's stack and silently fail for every other, which is the
 * failure mode this editor cannot see and its users would have to debug.
 *
 * ## Two rules this module will not bend
 *
 * **A credential is verified before it is stored.** As above.
 *
 * **Secrets never leave this process.** `listOrigins` reports the origin, the
 * scheme and the date, and never the value. The file is written 0600 and lives
 * beside `libraries.json` rather than inside it, because that file describes
 * the PROJECT — it is pointed at by config, it is read by every panel, and it
 * is the sort of thing a designer commits. A bearer token in it would be a
 * token in somebody's repository.
 */

import fs from "node:fs/promises"
import path from "node:path"

/** Long enough for any real token, short enough that a paste of a page is refused. */
const MAX_CREDENTIAL = 8192
/**
 * The three shapes a credential can take on the wire.
 *
 * `basic` earns its place rather than being folded into `bearer`, because RFC
 * 7617 is a different header VALUE and a site that asked for Basic rejects a
 * Bearer outright. Without it, a 401 classified as `basic` — which this module
 * detects and names — had no credential that could answer it, and the paste the
 * hint asked for went out under the wrong scheme and failed for a reason the
 * designer could not see.
 */
export const CREDENTIAL_SCHEMES = ["bearer", "basic", "cookie"]

/**
 * Path segments that mean "sign in here", across the frameworks that generate
 * them.
 *
 * Matched as whole segments rather than as substrings: `/authorize` is a
 * sign-in and `/unauthorized-report` is a page about one, and a substring test
 * cannot tell them apart.
 */
const SIGN_IN_SEGMENTS = new Set([
  "login",
  "signin",
  "sign-in",
  "sign_in",
  "auth",
  "authorize",
  "authorization",
  "oauth",
  "oauth2",
  "sso",
  "saml",
  "session",
  "account",
  "accounts",
])

/**
 * A reader for headers that came from `fetch` or from a plain object.
 * Case-insensitive, because only the first of those guarantees it.
 */
function headerReader(headers) {
  if (headers && typeof headers.get === "function") {
    return (name) => headers.get(name) ?? ""
  }
  const lowered = new Map(
    Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  )
  return (name) => lowered.get(name.toLowerCase()) ?? ""
}

/** The origin a credential is filed under: scheme and host, never a path. */
export function originOf(url) {
  try {
    return new URL(String(url)).origin
  } catch {
    return ""
  }
}

/** Whether a redirect hands the request to somebody else's host. */
function crossOrigin(from, to) {
  const source = originOf(from)
  const target = originOf(to)
  return Boolean(source) && Boolean(target) && source !== target
}

/** Whether a URL's path looks like the front door of an identity provider. */
function signInShaped(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return parsed.pathname
    .split("/")
    .some((segment) => SIGN_IN_SEGMENTS.has(segment.toLowerCase()))
}

/**
 * An OAuth 2.0 authorization request, by its required parameters.
 *
 * RFC 6749 §4.1.1 makes `response_type` and `client_id` mandatory, so the pair
 * identifies the exchange without naming a provider. `client_id` is the part
 * worth keeping: it is the audience an identity token has to carry, and a
 * designer has no way to look it up otherwise.
 */
function oauthClientId(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  const clientId = parsed.searchParams.get("client_id")
  if (!clientId || !parsed.searchParams.get("response_type")) return null
  return clientId
}

/** The `WWW-Authenticate` scheme a 401 asked for, lowercased. */
function challengedScheme(header) {
  const first = String(header ?? "").trim().split(/[\s,]+/)[0] ?? ""
  return first.toLowerCase()
}

const HINTS = {
  oauth:
    "This site signs in through OAuth. Mint an identity token for the client id below and " +
    "paste it, or paste the site's session cookie from a browser that can already open it.",
  oauthNoClient:
    "This site signs in through OAuth, and its redirect did not name a client id. Paste the " +
    "site's session cookie from a browser that can already open it.",
  basic:
    "This site asked for HTTP Basic authentication. Paste `user:password` base64-encoded, or a " +
    "token your provider issues in its place.",
  bearer:
    "This site asked for a bearer token. Paste one issued for this site, or paste its session " +
    "cookie from a browser that can already open it.",
  redirect:
    "This site redirected to a sign-in page. Paste a bearer token it accepts, or its session " +
    "cookie from a browser that can already open it.",
  forbidden:
    "This site reached the editor and refused it. A credential may not be the problem: the " +
    "account may simply not have access, but a token or cookie with access will get through.",
}

/**
 * What KIND of wall this response is, and the one string that would open it.
 *
 * `null` for a response that is not a wall, so a caller can use it as the test
 * as well as the reading. `audience` is the OAuth `client_id` when there was
 * one and empty otherwise; `realm` is the `WWW-Authenticate` realm, same rule.
 *
 * `url` is the request this response answered. It is needed, not decorative:
 * cross-origin is the test that separates an app routing to its own `/login`
 * from an app handing the request to an identity provider.
 */
export function classifyWall(response, url = "") {
  if (!response || typeof response !== "object") return null
  const header = headerReader(response.headers)
  const status = Number(response.status) || 0
  const location = String(response.location || header("location") || "")
  const contentType = String(response.contentType ?? "").toLowerCase()
  const text = typeof response.text === "string" ? response.text : ""
  const origin = originOf(url) || originOf(location)
  // Resolved up here because `wall()` reports it and the 401 branch returns
  // before the redirect branch would otherwise have computed it.
  const absoluteLocation = (() => {
    if (!location) return ""
    try {
      return new URL(location, url || undefined).toString()
    } catch {
      return ""
    }
  })()

  /*
   * `location` is reported rather than interpreted.
   *
   * This module will not look at a hostname — see the header — because a
   * classifier that recognised one vendor would be silently wrong for every
   * other. But the redirect target is a fact it already read, and the caller
   * that opens the site's own sign-in needs it to say WHOSE sign-in is about to
   * appear. Handing over the evidence keeps the vendor table outside this file,
   * where being wrong costs a button label instead of a classification.
   */
  const wall = (kind, extra = {}) => ({
    kind,
    origin,
    audience: "",
    realm: "",
    location: absoluteLocation,
    hint: HINTS[kind] ?? HINTS.redirect,
    ...extra,
  })

  // 401 is the unambiguous one, and the only status that is REQUIRED to say
  // what it wants. Read the scheme rather than assuming a bearer token.
  if (status === 401) {
    const challenge = String(header("www-authenticate") ?? "")
    const scheme = challengedScheme(challenge)
    const realm = /realm="?([^",]+)"?/i.exec(challenge)?.[1] ?? ""
    if (scheme === "basic") return wall("basic", { realm })
    return wall("bearer", { realm })
  }

  const absolute = absoluteLocation

  if (status >= 300 && status < 400 && absolute && crossOrigin(url, absolute)) {
    const clientId = oauthClientId(absolute)
    if (clientId) return wall("oauth", { audience: clientId })
    if (signInShaped(absolute)) return wall("redirect")
  }

  /*
   * A login page served with a 200, which is what a followed redirect leaves
   * behind. The status proves nothing here, so the body has to: a password
   * input, or an OAuth authorize URL embedded in the markup.
   *
   * Gated on the response not being JSON, because a token file documenting an
   * "oauth" colour is not a login page and must never be read as one.
   */
  if (text && !contentType.includes("json")) {
    if (/<input[^>]+type=["']?password/i.test(text)) return wall("redirect")
    const embedded = /https?:\/\/[^\s"'<>]*[?&]response_type=[^\s"'<>]*/i.exec(text)?.[0]
    if (embedded) {
      const clientId = oauthClientId(embedded)
      if (clientId && crossOrigin(url, embedded)) return wall("oauth", { audience: clientId })
    }
  }

  // Last, because it is the weakest: 403 is also what a working credential with
  // the wrong access gets, so it is a wall only when nothing above matched.
  if (status === 403) return wall("forbidden")

  return null
}

/**
 * The header a stored credential becomes.
 *
 * Two schemes because the two available routes produce different things: a
 * minted ID token is an `Authorization: Bearer`, and a browser session is a
 * `Cookie`. Nothing else is accepted — a scheme this does not know would be
 * sent as a header name of the caller's choosing, which is a header-injection
 * hole in a process that talks to arbitrary hosts.
 */
export function credentialHeaders(credential) {
  if (!credential || typeof credential !== "object") return {}
  const value = String(credential.value ?? "").trim()
  if (!value) return {}
  if (credential.scheme === "bearer") {
    // Tolerate a token pasted with the word already on it, which is what
    // copying from most documentation gives you.
    return { authorization: /^bearer\s/i.test(value) ? value : `Bearer ${value}` }
  }
  if (credential.scheme === "basic") {
    /*
     * Either half of RFC 7617 is accepted: the base64 blob, or the plain
     * `user:password` it is made from.
     *
     * Encoding here rather than demanding the blob is the difference between a
     * flow a designer can complete and one that sends them to a base64 tool
     * first. The test is for a colon in the decoded-looking value — base64 of
     * `user:password` never contains one, and a raw pair always does.
     */
    if (/^basic\s/i.test(value)) return { authorization: value }
    const encoded = value.includes(":") ? Buffer.from(value, "utf8").toString("base64") : value
    return { authorization: `Basic ${encoded}` }
  }
  if (credential.scheme === "cookie") return { cookie: value }
  return {}
}

/**
 * The credential store, one per editor process.
 *
 * Mirrors `createLibraryStore`'s shape — a factory over `config.stateDir`, a
 * serialized write queue, temp-file-and-rename — because the two files live
 * side by side and a reader who has understood one should not have to learn a
 * second set of habits for the other.
 */
export function createAuthStore(config = {}) {
  const storeDir = path.resolve(config.stateDir ?? ".")
  const authFile = path.join(storeDir, "library-auth.json")

  let queue = Promise.resolve()
  const serial = (job) => {
    const run = queue.then(job, job)
    // Swallowed on the QUEUE only: the caller still gets the rejection, and a
    // failed write must not poison every write after it.
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async function readAll() {
    let parsed
    try {
      parsed = JSON.parse(await fs.readFile(authFile, "utf8"))
    } catch {
      return []
    }
    if (!parsed || !Array.isArray(parsed.credentials)) return []
    return parsed.credentials.filter(
      (entry) =>
        entry &&
        typeof entry.origin === "string" &&
        CREDENTIAL_SCHEMES.includes(entry.scheme) &&
        typeof entry.value === "string" &&
        entry.value
    )
  }

  async function writeAll(credentials) {
    await fs.mkdir(storeDir, { recursive: true })
    const temp = `${authFile}.${process.pid}.tmp`
    const payload = { credentials }
    /*
     * 0600 on the temp file, before it has any content in it.
     *
     * Written on the TEMP rather than fixed up after the rename, because the
     * window between "a file with a token in it exists" and "that file is
     * unreadable by anyone else" has to be zero. `writeFile`'s mode applies
     * only at creation, so this also means the mode survives a rewrite of an
     * existing file, which a later `chmod` would not guarantee.
     */
    await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await fs.rename(temp, authFile)
  }

  return {
    authFile,

    /** The credential for this URL's origin, or null. Includes the secret. */
    async credentialFor(url) {
      const origin = originOf(url)
      if (!origin) return null
      const found = (await readAll()).find((entry) => entry.origin === origin)
      return found ?? null
    },

    /**
     * Every origin that has one, WITHOUT the values.
     *
     * The panel lists these so a designer can see what they are signed in to
     * and forget one. It has no use for the secret, so it is never sent — a
     * value that does not cross the wire cannot be logged by anything between
     * here and the page.
     */
    async listOrigins() {
      return (await readAll()).map((entry) => ({
        origin: entry.origin,
        scheme: entry.scheme,
        addedAt: entry.addedAt ?? 0,
      }))
    },

    /**
     * Stores a credential, replacing any this origin already had.
     *
     * Deliberately NOT exported as a route on its own: `routes.mjs` verifies
     * the credential against the live URL first and only calls this once the
     * wall has actually opened. See the header.
     */
    async saveCredential({ url, scheme, value }) {
      const origin = originOf(url)
      if (!origin) throw new Error("A credential needs a http:// or https:// URL to belong to")
      if (!CREDENTIAL_SCHEMES.includes(scheme)) {
        throw new Error(`"${scheme}" is not a credential kind. Use bearer or cookie.`)
      }
      const trimmed = String(value ?? "").trim()
      if (!trimmed) throw new Error("That credential is empty")
      if (trimmed.length > MAX_CREDENTIAL) {
        throw new Error(
          "That is too long to be a token. Paste the token itself, not the page you copied it from."
        )
      }
      return serial(async () => {
        const rest = (await readAll()).filter((entry) => entry.origin !== origin)
        const entry = { origin, scheme, value: trimmed, addedAt: Date.now() }
        await writeAll([...rest, entry])
        return { origin, scheme: entry.scheme, addedAt: entry.addedAt }
      })
    },

    /** Drops this origin's credential. Answers whether there was one. */
    async forgetCredential(origin) {
      const wanted = originOf(origin) || String(origin ?? "")
      return serial(async () => {
        const all = await readAll()
        const rest = all.filter((entry) => entry.origin !== wanted)
        if (rest.length === all.length) return { forgotten: false }
        await writeAll(rest)
        return { forgotten: true }
      })
    },
  }
}
