/**
 * Signing the editor in to a design system that is behind a sign-in wall: how
 * the wall is READ, what a credential becomes on the wire, where the secret is
 * kept, and the rules the store will not bend.
 *
 * `library-url-cases.mjs` pins the fetching; this suite pins the half that only
 * exists because the fetch was refused. Five things are worth asserting here
 * and nowhere else:
 *
 *  - **a refusal is an instruction, not a dead end.** Every rule in
 *    `classifyWall` is an HTTP or OAuth standard rather than a fact about one
 *    company's stack, so the cases below are built out of standards too: a
 *    `WWW-Authenticate` challenge (RFC 7235), an authorization request carrying
 *    `response_type` and `client_id` (RFC 6749 §4.1.1), an ordinary sign-in
 *    bounce, a 403. The OAuth case is the one that carries a payload: the
 *    `client_id` in the redirect is the AUDIENCE an identity token has to be
 *    minted for, nothing else in the exchange names it, and a classifier that
 *    drops it leaves a designer needing a string they have no way to look up;
 *  - **cross-origin is the whole boundary.** An app redirecting to its own
 *    `/login` is routing; being sent to somebody else's host is a handoff to an
 *    identity provider. Both are 302s to a sign-in-shaped path, so the origin
 *    comparison is the only thing telling them apart — and reading the first as
 *    a wall would refuse to install perfectly public sites that happen to have
 *    a login page;
 *  - **a 200 is not proof of anything.** `fetch` follows redirects, so by the
 *    time a caller sees a response the 302 that explains it is gone and all
 *    that is left is a successful-looking page of login HTML. Left unread, the
 *    editor installs somebody's sign-in form as a design system with a green
 *    checkmark next to it;
 *  - **`credentialHeaders` is a header-injection guard wearing the clothes of a
 *    formatter.** A scheme it does not recognise would otherwise be a header
 *    name of the caller's choosing in a process that talks to arbitrary hosts,
 *    so the unknown-scheme case asserts an EMPTY object rather than a falsy one;
 *  - **a credential goes to its own origin and nowhere else.** A redirect can
 *    point at a host the designer has never heard of, and a bearer token
 *    forwarded across that hop is a token handed to a stranger. Browsers strip
 *    `Authorization` on a cross-origin redirect; this module follows redirects
 *    by hand, so the check is its own to make and its own to prove.
 *
 * Everything runs offline against a real temp directory. `fetchImpl` and
 * `runHelper` are injected, the credential file is a real 0600 file, and the
 * store is a real `createLibraryStore` — a fake filesystem could not prove the
 * two facts most worth proving, which are that the secret is on disk in its own
 * file and that a swept row is gone from the one the editor re-reads.
 *
 * Every host below is a documentation domain reserved by RFC 2606 and RFC 6761,
 * and the OAuth client id is invented. Nothing here names a real site, and
 * nothing here is a credential anybody holds.
 *
 * Usage: node designlayer/test/library-auth-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { resolveConfig } from "../config.mjs"
import {
  CREDENTIAL_SCHEMES,
  classifyWall,
  createAuthStore,
  credentialHeaders,
  originOf,
} from "../server/library-auth.mjs"
import { createLibraryStore } from "../server/libraries.mjs"
import { URL_SOURCE_KIND, fetchLibraryUrl } from "../server/library-url.mjs"

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

/* ---------- three sites and an identity provider, all fictional ----------- */

/**
 * A Storybook on a hosting platform that mints its own subdomains, which is why
 * the host says nothing about the design system and the path has to.
 */
const CATALOG_ORIGIN = "https://storybook-7f3a29b4-uc.example.net"
const CATALOG_URL = `${CATALOG_ORIGIN}/atlas/primitives/avatar`

/** A documentation site named after the system it documents. */
const DOCS_ORIGIN = "https://design-system.example.com"
const DOCS_URL = `${DOCS_ORIGIN}/toolkit/components/split-button`

/** Somebody else's host: the identity provider both sites hand off to. */
const IDP_ORIGIN = "https://login.example.org"

/**
 * The OAuth client id of the protected service. Invented for this suite, and
 * shaped like the UUID most providers issue.
 *
 * This string is the payload of the whole feature: it is the audience an
 * identity token has to be minted for, and the authorization redirect is the
 * only place it is ever named.
 */
const CLIENT_ID = "a1b2c3d4-5e6f-4071-8abc-9d0e1f2a3b4c"

/** An OAuth 2.0 authorization request, with the parameters RFC 6749 requires. */
const OAUTH_LOCATION =
  `${IDP_ORIGIN}/oauth2/authorize` +
  `?client_id=${CLIENT_ID}` +
  "&response_type=code" +
  "&scope=openid+email" +
  `&redirect_uri=${encodeURIComponent(`${CATALOG_ORIGIN}/oauth2/callback`)}` +
  "&state=Ab1Cd2Ef3Gh4"

/** The plainer bounce: a sign-in page on another host, naming no OAuth client. */
const SIGN_IN_LOCATION =
  `${IDP_ORIGIN}/sso/request?continue=${encodeURIComponent(DOCS_URL)}&level=2`

/** The same shape, except the app is routing to its own login page. */
const SAME_ORIGIN_LOGIN = `${DOCS_ORIGIN}/login?next=%2Ftoolkit%2Fcomponents%2Fsplit-button`

/**
 * A login form served with HTTP 200, which is what a followed redirect leaves
 * behind. Nothing in the status line says "refused"; the password input is the
 * evidence that survives.
 */
const PASSWORD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head>
<body>
<form method="post" action="/session">
  <label>Email <input type="email" name="email" autocomplete="username"></label>
  <label>Password <input type="password" name="password"></label>
  <button type="submit">Sign in</button>
</form>
</body></html>`

/**
 * The other 200-shaped wall: no form at all, just a page whose whole job is to
 * bounce the browser onward to the authorization endpoint. The client id is in
 * the markup rather than in a header, because the header is what was lost.
 */
const OAUTH_BOUNCE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Signing in</title>
<meta http-equiv="refresh" content="0;url=${OAUTH_LOCATION}">
</head><body>
<p>Redirecting to the sign-in service&hellip;</p>
<script>window.location.replace("${OAUTH_LOCATION}");</script>
</body></html>`

/** A Storybook v7 index, the thing behind the wall that is worth reaching. */
const INDEX_JSON = {
  v: 5,
  entries: {
    "primitives-avatar--default": {
      id: "primitives-avatar--default",
      title: "Primitives/Avatar",
      name: "Default",
      importPath: "./src/avatar/avatar.stories.ts",
      type: "story",
    },
    "primitives-badge--default": {
      id: "primitives-badge--default",
      title: "Primitives/Badge",
      name: "Default",
      importPath: "./src/badge/badge.stories.ts",
      type: "story",
    },
  },
}

/**
 * A token file documenting the colour of a sign-in button, carrying both
 * markers a body sniff looks for: the word "oauth" as a token name, and a whole
 * authorization URL in a description. It is JSON, so it is not a login page,
 * and a classifier that sniffed bodies without checking the content type would
 * read it as one and hide a real design system behind a sign-in prompt nobody
 * can satisfy.
 */
const OAUTH_COLOUR_TOKENS = {
  color: {
    oauth: {
      $type: "color",
      $value: "#3b5bdb",
      $description:
        "Sign-in button blue, as used on " +
        `${IDP_ORIGIN}/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}`,
    },
  },
}

const BEARER = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImExYjJjM2Q0ZTVmNiJ9.ZXhhbXBsZS1pZC10b2tlbg"
const COOKIE = "session=AbCdEf-1234; csrf=zxcv"

/* ---------- offline plumbing ---------------------------------------------- */

const NOT_FOUND = { status: 404, headers: { "content-type": "text/html" }, body: "" }

const json = (body) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const html = (body, status = 200) => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8" },
  body,
})

/**
 * A fake `fetch` over recorded responses, which RECORDS THE REQUEST as well.
 *
 * The request side is the point here: a credential that is stored, matched and
 * formatted correctly and then never attached to the outgoing request is a
 * sign-in that silently does nothing, and only the sent headers can tell those
 * two apart. It is also the only way to see a credential going somewhere it
 * should not. A route may be a function of the headers, which is how a fixture
 * says "this host answers to whoever is signed in".
 *
 * The response headers come back as a real `Headers`, which is what `fetch`
 * returns — a plain object still yields a content type and a `Location`, but
 * the full header set the classifier reads `WWW-Authenticate` out of does not
 * survive the trip, and a fake in that shape would test a narrower module than
 * the one that ships.
 */
function recordingFetch(routes) {
  const sent = []
  const fetchImpl = async (url, init = {}) => {
    const headers = { ...(init?.headers ?? {}) }
    sent.push({ url: String(url), headers })
    const recorded = routes[String(url)] ?? routes["*"]
    const response = (typeof recorded === "function" ? recorded(headers) : recorded) ?? NOT_FOUND
    return {
      status: response.status,
      headers: new Headers(response.headers ?? {}),
      text: async () => response.body ?? "",
    }
  }
  return { fetchImpl, sent }
}

/**
 * No helper command configured, which is the default and the ordinary case.
 *
 * `runHelper` is the hook a project uses to point the editor at whatever
 * command-line client its own proxy needs. Unset, there is no second route out
 * of a wall, and the caller reports the wall.
 */
const noHelper = async () => null

/** A host that answers the index only to a request carrying the credential. */
const walledUnless = (opens) => (headers) =>
  opens(headers) ? json(INDEX_JSON) : html(PASSWORD_PAGE)

/**
 * A throwaway project with a real state directory, a real auth store and a real
 * library store wired together exactly as `routes.mjs` wires them.
 */
async function project(urlOptions = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "de-library-auth-")))
  await fs.writeFile(
    path.join(root, "package.json"),
    '{ "name": "temp-host", "version": "0.0.0" }\n',
    "utf8"
  )
  const config = resolveConfig({ projectRoot: root }, { cwd: root })
  const auth = createAuthStore(config)
  return {
    config,
    auth,
    store: createLibraryStore(config, urlOptions, auth),
    librariesFile: path.join(config.stateDir, "libraries.json"),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

/** The pointer file as it is on disk, or `[]` when nothing has written it. */
async function storedLibraries(context) {
  try {
    const parsed = JSON.parse(await fs.readFile(context.librariesFile, "utf8"))
    return Array.isArray(parsed?.libraries) ? parsed.libraries : []
  } catch {
    return []
  }
}

async function seedLibraries(context, rows) {
  await fs.mkdir(context.config.stateDir, { recursive: true })
  await fs.writeFile(
    context.librariesFile,
    `${JSON.stringify({ libraries: rows }, null, 2)}\n`,
    "utf8"
  )
}

/** The shape every wall has, so a new field cannot appear without a case. */
/*
 * The wall's whole shape, and `location` earns its place in it.
 *
 * It is the redirect the site answered with, reported so the caller that opens
 * the site's own sign-in can name the provider on a button. The rule this list
 * has always enforced still holds: these are facts for a panel to render, and
 * anything that reintroduces a "run this" field has to come back through here.
 */
const WALL_KEYS = ["audience", "hint", "kind", "location", "origin", "realm"]

// ── Reading the wall ───────────────────────────────────────────────────────

console.log("\nWhat kind of wall this is")

/*
 * The case that carries a payload. An authorization request names the client id
 * of the service it is protecting, that client id is the audience an identity
 * token has to be minted for, and no other part of the exchange mentions it —
 * so a classifier that reports "signed out" without it has thrown away the one
 * string the designer cannot find on their own.
 */
check("a cross-origin OAuth redirect is read for the audience it names", () => {
  const wall = classifyWall(
    {
      status: 302,
      contentType: "text/html; charset=UTF-8",
      text: "",
      headers: { location: OAUTH_LOCATION, "content-type": "text/html; charset=UTF-8" },
    },
    CATALOG_URL
  )

  assert.equal(wall.kind, "oauth")
  assert.equal(wall.origin, CATALOG_ORIGIN, "the wall belongs to the site, not to the provider")
  assert.equal(wall.audience, CLIENT_ID)
  assert.equal(wall.realm, "")
  assert.match(wall.hint, /client id/i)
  // The shape is data for a panel, not a command for a shell. Anything that
  // reintroduces a "run this" field has to come back through this line.
  assert.deepEqual(Object.keys(wall).sort(), WALL_KEYS)
})

/*
 * The same handoff without the OAuth parameters: still a wall, still somebody
 * else's host, and no audience to report. A hint promising a client id that is
 * not there would send the designer looking for a string that does not exist.
 */
check("a cross-origin bounce to a sign-in page is a redirect, with no audience", () => {
  const wall = classifyWall(
    {
      status: 302,
      contentType: "text/html; charset=UTF-8",
      text: "",
      headers: { location: SIGN_IN_LOCATION, "content-type": "text/html; charset=UTF-8" },
    },
    DOCS_URL
  )

  assert.equal(wall.kind, "redirect")
  assert.equal(wall.origin, DOCS_ORIGIN)
  assert.equal(wall.audience, "")
  assert.match(wall.hint, /cookie/i)
})

/*
 * THE BOUNDARY, and the reason `classifyWall` takes the request URL at all.
 *
 * An app that redirects to its own `/login` is routing; an app that sends the
 * request to another host has handed it to an identity provider. Both are a 302
 * to a sign-in-shaped path and nothing but the origin comparison separates
 * them. Read the first as a wall and the editor refuses to install public sites
 * for having a login page — a failure that looks like the site's fault.
 */
check("a same-origin redirect to /login is routing, not a wall", () => {
  const sameOrigin = (location) =>
    classifyWall(
      { status: 302, contentType: "text/html", text: "", headers: { location } },
      DOCS_URL
    )

  assert.equal(sameOrigin(SAME_ORIGIN_LOGIN), null)
  // Relative, which is how most servers actually write it.
  assert.equal(sameOrigin("/login?next=%2Ftoolkit"), null)
  assert.equal(sameOrigin("/signin"), null)
  // Even its own authorization endpoint: a site is allowed to run one.
  assert.equal(sameOrigin(`${DOCS_ORIGIN}/oauth2/authorize?response_type=code&client_id=x`), null)

  // And the same path on another host is the handoff, so the only difference
  // between the two answers really is the origin.
  assert.equal(
    classifyWall(
      { status: 302, contentType: "text/html", text: "", headers: { location: `${IDP_ORIGIN}/login` } },
      DOCS_URL
    ).kind,
    "redirect"
  )
})

/*
 * 401 is the only status that is REQUIRED to say what it wants, and RFC 7235
 * says where: the `WWW-Authenticate` challenge names the scheme and the realm.
 * The realm is worth keeping because it is the only human-readable label the
 * site offers for what is being protected.
 */
check("a 401 asking for Basic is read as Basic, realm and all", () => {
  const wall = classifyWall(
    {
      status: 401,
      contentType: "text/html",
      text: "Unauthorized",
      headers: { "www-authenticate": 'Basic realm="Docs"' },
    },
    DOCS_URL
  )

  assert.equal(wall.kind, "basic")
  assert.equal(wall.realm, "Docs")
  assert.equal(wall.origin, DOCS_ORIGIN)
  assert.equal(wall.audience, "")
  assert.match(wall.hint, /basic/i)
})

check("a 401 asking for Bearer is read as Bearer, with or without a realm", () => {
  const bearer = classifyWall(
    {
      status: 401,
      contentType: "application/json",
      text: '{"error":"invalid_token"}',
      headers: { "www-authenticate": "Bearer" },
    },
    CATALOG_URL
  )
  assert.equal(bearer.kind, "bearer")
  assert.equal(bearer.realm, "")
  assert.equal(bearer.origin, CATALOG_ORIGIN)
  assert.match(bearer.hint, /bearer token/i)

  const withRealm = classifyWall(
    {
      status: 401,
      contentType: "application/json",
      text: "",
      headers: { "www-authenticate": 'Bearer realm="catalog", error="invalid_token"' },
    },
    CATALOG_URL
  )
  assert.equal(withRealm.kind, "bearer")
  assert.equal(withRealm.realm, "catalog")

  // A 401 that says nothing at all is still a refusal, and a bearer token is
  // the credential most likely to answer it.
  const silent = classifyWall({ status: 401, contentType: "text/html", text: "" }, CATALOG_URL)
  assert.equal(silent.kind, "bearer")
  assert.equal(silent.realm, "")
})

/*
 * 403 means reached and refused, which a credential may or may not fix — the
 * account may simply not have access. So it is classified last, and its wording
 * says "may" where the others say "will".
 */
check("a 403 is forbidden, and is the weakest reading", () => {
  const wall = classifyWall(
    { status: 403, contentType: "text/html", text: "Forbidden", headers: {} },
    DOCS_URL
  )
  assert.equal(wall.kind, "forbidden")
  assert.equal(wall.origin, DOCS_ORIGIN)
  assert.equal(wall.audience, "")
  assert.match(wall.hint, /may not be the problem/i)

  // Checked LAST, so a 403 that also serves a login form is the login form: the
  // stronger evidence in the body wins over the weaker evidence in the status.
  assert.equal(
    classifyWall({ status: 403, contentType: "text/html", text: PASSWORD_PAGE }, DOCS_URL).kind,
    "redirect"
  )
})

/*
 * The case that catches people out. Following a redirect is what hides the 302,
 * so this response is HTTP 200 with a content type of `text/html` and a body —
 * indistinguishable from a real page by anything except the body. Left unread,
 * the editor installs the sign-in form as a design system.
 */
check("a 200 carrying a password input is a wall", () => {
  const response = { status: 200, contentType: "text/html; charset=utf-8", text: PASSWORD_PAGE }
  assert.equal(response.status, 200, "the fixture has to be a success as far as HTTP is concerned")

  const wall = classifyWall(response, CATALOG_URL)
  assert.notEqual(wall, null)
  assert.equal(wall.kind, "redirect")
  assert.equal(wall.origin, CATALOG_ORIGIN)
  assert.deepEqual(Object.keys(wall).sort(), WALL_KEYS)

  // Case and quoting vary by framework; the evidence is the input, not its
  // spelling.
  for (const markup of [
    '<INPUT TYPE="PASSWORD" NAME="p">',
    "<input name=p type=password>",
    "<input class='field' type='password'>",
  ]) {
    assert.notEqual(classifyWall({ status: 200, contentType: "text/html", text: markup }, CATALOG_URL), null, markup)
  }
})

/*
 * The other 200: no form, just a page that bounces onward. The client id is
 * still there, in the markup rather than in a header, and it is still the
 * audience — so it is read out of the body exactly as it would be out of a
 * `Location`.
 */
check("a 200 that embeds an authorization URL is a wall, and still names the audience", () => {
  const wall = classifyWall(
    { status: 200, contentType: "text/html; charset=utf-8", text: OAUTH_BOUNCE_PAGE },
    CATALOG_URL
  )
  assert.equal(wall.kind, "oauth")
  assert.equal(wall.audience, CLIENT_ID)
  assert.equal(wall.origin, CATALOG_ORIGIN)

  // Same page, served BY the identity provider itself: the authorize URL is now
  // same-origin, so it is that site's own plumbing rather than a handoff.
  assert.equal(
    classifyWall(
      { status: 200, contentType: "text/html", text: OAUTH_BOUNCE_PAGE },
      `${IDP_ORIGIN}/oauth2/authorize`
    ),
    null
  )
})

/*
 * The mirror image, and the reason the content type is consulted before the
 * body. A design system is entitled to have a colour called `oauth` and to
 * document where it is used; a token file read as a login page is a library
 * that vanishes behind a sign-in prompt nobody can satisfy.
 */
check("real JSON is not a wall, even when it documents an OAuth colour", () => {
  assert.equal(
    classifyWall(
      { status: 200, contentType: "application/json", text: JSON.stringify(INDEX_JSON) },
      `${CATALOG_ORIGIN}/atlas/index.json`
    ),
    null
  )

  const tokens = JSON.stringify(OAUTH_COLOUR_TOKENS)
  assert.ok(tokens.includes("response_type=code"), "the fixture must carry the marker")
  assert.ok(tokens.includes(CLIENT_ID), "the fixture must carry a client id too")
  assert.equal(
    classifyWall(
      { status: 200, contentType: "application/json; charset=utf-8", text: tokens },
      "https://example.com/design/tokens.json"
    ),
    null
  )
})

check("an ordinary HTML page is not a wall either", () => {
  assert.equal(
    classifyWall(
      {
        status: 200,
        contentType: "text/html",
        text: "<!doctype html><html><body><ds-split-button></ds-split-button></body></html>",
      },
      DOCS_URL
    ),
    null
  )
  assert.equal(classifyWall(null, DOCS_URL), null)
  assert.equal(classifyWall("nope", DOCS_URL), null)
})

check("the origin a wall belongs to is scheme and host, never a path", () => {
  assert.equal(originOf(CATALOG_URL), CATALOG_ORIGIN)
  assert.equal(originOf("not a url"), "")
  assert.equal(originOf(undefined), "")
})

// ── The credential on the wire ─────────────────────────────────────────────

console.log("\nWhat a credential becomes on the wire")

/*
 * Copying a token out of documentation gives you the word `Bearer` with it, and
 * copying it out of a command-line tool does not. Both have to arrive as one
 * `Bearer `: two is a 401 the designer cannot see the cause of, and none is a
 * header the server ignores.
 */
check("a bearer token carries exactly one `Bearer `, pasted with the word or without", () => {
  const bare = credentialHeaders({ scheme: "bearer", value: BEARER })
  assert.deepEqual(bare, { authorization: `Bearer ${BEARER}` })

  const prefixed = credentialHeaders({ scheme: "bearer", value: `Bearer ${BEARER}` })
  assert.deepEqual(prefixed, bare)

  for (const header of [bare.authorization, prefixed.authorization]) {
    assert.equal((header.match(/bearer/gi) ?? []).length, 1, `doubled the scheme: ${header}`)
    assert.ok(header.startsWith("Bearer "))
  }

  // Pasted with the whitespace that comes with it.
  assert.deepEqual(credentialHeaders({ scheme: "bearer", value: `  ${BEARER}\n` }), bare)
})

check("a cookie is sent as a cookie, verbatim", () => {
  assert.deepEqual(credentialHeaders({ scheme: "cookie", value: COOKIE }), { cookie: COOKIE })
  assert.deepEqual(credentialHeaders({ scheme: "cookie", value: ` ${COOKIE} ` }), { cookie: COOKIE })
})

/*
 * The header-injection guard, asserted as an empty object rather than as
 * "falsy". An unrecognised scheme is a header NAME chosen by whoever filled in
 * the form, in a process that then sends it to a host of their choosing — so
 * the answer has to be no headers at all, and a test that only checks
 * truthiness would pass on a `{ "x-evil": value }` that is very much a header.
 *
 * `basic` is NOT in this list, and it used to be. The store answered a 401
 * challenging with Basic by sending the pasted value as a Bearer, which is the
 * wrong header for RFC 7617 and failed for a reason the designer could not see;
 * `basic` is a scheme of its own now, and its own case is directly below.
 */
/*
 * RFC 7617, from either end.
 *
 * A designer copying credentials out of a password manager has `user:password`,
 * and one copying from an API console has the base64 of it. Demanding the
 * second would send them to an encoder first, so both are accepted — the colon
 * is the tell, since base64 of a `user:password` pair never contains one.
 */
check("a basic credential is sent as Basic, from either form", () => {
  const encoded = Buffer.from("ada:hunter2", "utf8").toString("base64")
  assert.deepEqual(credentialHeaders({ scheme: "basic", value: "ada:hunter2" }), {
    authorization: `Basic ${encoded}`,
  })
  assert.deepEqual(credentialHeaders({ scheme: "basic", value: encoded }), {
    authorization: `Basic ${encoded}`,
  })
  // Already carrying the word, which is what copying from documentation gives.
  assert.deepEqual(credentialHeaders({ scheme: "basic", value: `Basic ${encoded}` }), {
    authorization: `Basic ${encoded}`,
  })
  // It must never come out as a Bearer, which is the bug this scheme exists to
  // end: a site that challenged with Basic rejects a Bearer outright.
  for (const form of ["ada:hunter2", encoded]) {
    assert.doesNotMatch(
      credentialHeaders({ scheme: "basic", value: form }).authorization,
      /bearer/i
    )
  }
})

check("a scheme this module does not know sends no header at all", () => {
  const refused = [
    { scheme: "token", value: BEARER },
    { scheme: "x-api-key", value: BEARER },
    // Case matters: the allowlist is an exact match, not a normalised one.
    { scheme: "Bearer", value: BEARER },
    { scheme: "authorization: x\r\nx-injected: 1", value: BEARER },
    { scheme: "", value: BEARER },
    { scheme: null, value: BEARER },
  ]
  for (const credential of refused) {
    const headers = credentialHeaders(credential)
    assert.deepEqual(headers, {}, `"${credential.scheme}" produced a header`)
    assert.equal(Object.keys(headers).length, 0)
  }

  assert.deepEqual(
    CREDENTIAL_SCHEMES,
    ["bearer", "basic", "cookie"],
    "the allowlist is the whole guard"
  )
})

check("an empty or absent credential sends nothing", () => {
  assert.deepEqual(credentialHeaders({ scheme: "bearer", value: "" }), {})
  assert.deepEqual(credentialHeaders({ scheme: "cookie", value: "   " }), {})
  assert.deepEqual(credentialHeaders({ scheme: "bearer" }), {})
  assert.deepEqual(credentialHeaders(null), {})
  assert.deepEqual(credentialHeaders("Bearer token"), {})
})

// ── Where the secret lives ─────────────────────────────────────────────────

console.log("\nStoring a credential")

await checkAsync("a credential comes back for its origin, and a second save replaces it", async () => {
  const context = await project()
  try {
    const saved = await context.auth.saveCredential({
      url: CATALOG_URL,
      scheme: "bearer",
      value: BEARER,
    })
    assert.equal(saved.origin, CATALOG_ORIGIN)
    assert.equal(saved.scheme, "bearer")
    assert.ok(Number.isFinite(saved.addedAt))
    assert.equal("value" in saved, false, "the answer to a save echoed the secret back")

    // Filed under the ORIGIN, so a second deep link into the same site is one
    // sign-in rather than two.
    const found = await context.auth.credentialFor(`${CATALOG_ORIGIN}/atlas/index.json`)
    assert.equal(found.value, BEARER)
    assert.equal(found.scheme, "bearer")
    assert.equal(await context.auth.credentialFor(DOCS_URL), null)
    assert.equal(await context.auth.credentialFor("not a url"), null)

    await context.auth.saveCredential({ url: CATALOG_ORIGIN, scheme: "cookie", value: COOKIE })
    const origins = await context.auth.listOrigins()
    assert.equal(origins.length, 1, "a second save for one origin duplicated the row")
    const replaced = await context.auth.credentialFor(CATALOG_URL)
    assert.equal(replaced.scheme, "cookie")
    assert.equal(replaced.value, COOKIE)
  } finally {
    await context.cleanup()
  }
})

/*
 * The panel lists what the designer is signed in to so they can forget one. It
 * has no use for the value, so the value does not cross the wire — a secret
 * that is never sent cannot be logged by anything between here and the page.
 * Asserted on the KEYS, because a field holding `undefined` still serialises
 * into the response as a field.
 */
await checkAsync("listing origins carries no value field at all", async () => {
  const context = await project()
  try {
    await context.auth.saveCredential({ url: CATALOG_URL, scheme: "bearer", value: BEARER })
    await context.auth.saveCredential({ url: DOCS_URL, scheme: "cookie", value: COOKIE })

    const origins = await context.auth.listOrigins()
    assert.equal(origins.length, 2)
    for (const entry of origins) {
      assert.deepEqual(Object.keys(entry).sort(), ["addedAt", "origin", "scheme"])
    }
    assert.deepEqual(
      origins.map((entry) => entry.origin).sort(),
      [DOCS_ORIGIN, CATALOG_ORIGIN].sort()
    )
    const wire = JSON.stringify(origins)
    assert.equal(wire.includes(BEARER), false)
    assert.equal(wire.includes(COOKIE), false)
  } finally {
    await context.cleanup()
  }
})

await checkAsync("forgetting is reported once, and then reported as nothing to forget", async () => {
  const context = await project()
  try {
    await context.auth.saveCredential({ url: CATALOG_URL, scheme: "bearer", value: BEARER })
    assert.deepEqual(await context.auth.forgetCredential(CATALOG_ORIGIN), { forgotten: true })
    assert.deepEqual(await context.auth.forgetCredential(CATALOG_ORIGIN), { forgotten: false })
    assert.deepEqual(await context.auth.forgetCredential(DOCS_ORIGIN), { forgotten: false })
    assert.equal(await context.auth.credentialFor(CATALOG_URL), null)
    assert.deepEqual(await context.auth.listOrigins(), [])
  } finally {
    await context.cleanup()
  }
})

/*
 * 0600 on the file itself, asserted through `stat` rather than through the call
 * that wrote it. The mode is applied to the temp file before it has any content
 * in it, so the window in which a token is on disk and world-readable is zero —
 * and the second save is asserted too, because a rewrite is exactly where a
 * mode applied only at creation would be lost.
 */
await checkAsync("the credential file is written 0600, and stays 0600", async () => {
  const context = await project()
  try {
    await context.auth.saveCredential({ url: CATALOG_URL, scheme: "bearer", value: BEARER })
    const first = await fs.stat(context.auth.authFile)
    assert.equal(first.mode & 0o777, 0o600, `mode was 0${(first.mode & 0o777).toString(8)}`)

    await context.auth.saveCredential({ url: DOCS_URL, scheme: "cookie", value: COOKIE })
    const second = await fs.stat(context.auth.authFile)
    assert.equal(second.mode & 0o777, 0o600, `mode was 0${(second.mode & 0o777).toString(8)}`)
  } finally {
    await context.cleanup()
  }
})

/*
 * Several refusals, and none of them may write. A store that refuses loudly and
 * persists anyway is worse than one that accepts, because the panel then lists
 * an origin the designer was told was not saved.
 */
await checkAsync("a credential that cannot be one is refused, and nothing is written", async () => {
  const context = await project()
  try {
    await context.auth.saveCredential({ url: CATALOG_URL, scheme: "bearer", value: BEARER })
    const before = await fs.readFile(context.auth.authFile, "utf8")

    // A paste of the page you copied the token from, rather than the token.
    await assert.rejects(
      context.auth.saveCredential({
        url: CATALOG_URL,
        scheme: "bearer",
        value: "x".repeat(8193),
      }),
      /too long to be a token/
    )
    // The ceiling itself is a token, not a page.
    const atCeiling = await context.auth.saveCredential({
      url: DOCS_URL,
      scheme: "cookie",
      value: "c".repeat(8192),
    })
    assert.equal(atCeiling.origin, DOCS_ORIGIN)
    await context.auth.forgetCredential(DOCS_ORIGIN)

    await assert.rejects(
      context.auth.saveCredential({ url: CATALOG_URL, scheme: "api-key", value: BEARER }),
      /not a credential kind/
    )
    await assert.rejects(
      context.auth.saveCredential({ url: "design-system.example.com", scheme: "bearer", value: BEARER }),
      /URL/
    )
    await assert.rejects(
      context.auth.saveCredential({ url: "", scheme: "bearer", value: BEARER }),
      /URL/
    )
    await assert.rejects(
      context.auth.saveCredential({ url: CATALOG_URL, scheme: "bearer", value: "   " }),
      /empty/
    )

    assert.equal(await fs.readFile(context.auth.authFile, "utf8"), before)
    assert.equal((await context.auth.listOrigins()).length, 1)
  } finally {
    await context.cleanup()
  }
})

/*
 * The secret is in a file of its own, beside `libraries.json` and never inside
 * it. `libraries.json` describes the PROJECT — it is pointed at by config, read
 * by every panel, and the sort of thing a designer commits — so a bearer token
 * in it would be a token in somebody's repository.
 */
await checkAsync("the secret is in its own file, never in libraries.json", async () => {
  const recorded = recordingFetch({
    "*": walledUnless((headers) => headers.authorization === `Bearer ${BEARER}`),
  })
  const context = await project({ fetchImpl: recorded.fetchImpl, runHelper: noHelper })
  try {
    assert.equal(path.basename(context.auth.authFile), "library-auth.json")
    assert.equal(path.dirname(context.auth.authFile), context.config.stateDir)

    await context.auth.saveCredential({ url: CATALOG_URL, scheme: "bearer", value: BEARER })
    assert.ok((await fs.readFile(context.auth.authFile, "utf8")).includes(BEARER))

    // A library that really installs THROUGH the credential, so `libraries.json`
    // has been written by the one code path that could leak it.
    const { library } = await context.store.add({ url: CATALOG_URL })
    assert.equal(library.counts.components, 2)

    const libraries = await fs.readFile(context.librariesFile, "utf8")
    assert.ok(libraries.includes(CATALOG_URL), "the fixture must have written a real row")
    assert.equal(libraries.includes(BEARER), false, "libraries.json carried the credential")
    assert.equal(/bearer|authorization|cookie/i.test(libraries), false)
  } finally {
    await context.cleanup()
  }
})

// ── The credential on the request ──────────────────────────────────────────

console.log("\nFetching with a credential")

/*
 * A credential that is stored, matched and formatted and then never attached to
 * the request is a sign-in that silently does nothing. So the assertion is on
 * what the host RECEIVED, and the same fixture is run twice — once signed out,
 * once signed in — because "the wall opened" only means something if the wall
 * was there a moment ago.
 */
await checkAsync("a bearer credential reaches the request and opens the wall", async () => {
  const signedOut = recordingFetch({
    "*": walledUnless((headers) => headers.authorization === `Bearer ${BEARER}`),
  })
  const refused = await fetchLibraryUrl(CATALOG_URL, {
    fetchImpl: signedOut.fetchImpl,
    runHelper: noHelper,
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.sso, true)
  assert.equal(refused.wall.kind, "redirect")
  assert.equal(refused.wall.origin, CATALOG_ORIGIN)
  assert.equal(signedOut.sent[0].headers.authorization, undefined)

  const signedIn = recordingFetch({
    "*": walledUnless((headers) => headers.authorization === `Bearer ${BEARER}`),
  })
  const opened = await fetchLibraryUrl(CATALOG_URL, {
    fetchImpl: signedIn.fetchImpl,
    runHelper: noHelper,
    credential: { scheme: "bearer", value: BEARER },
  })
  assert.equal(opened.ok, true)
  assert.equal(opened.sso, false)
  assert.equal(opened.viaHelper, false)
  assert.equal(JSON.parse(opened.text).v, 5)

  assert.equal(signedIn.sent.length, 1)
  assert.equal(signedIn.sent[0].url, CATALOG_URL)
  assert.equal(signedIn.sent[0].headers.authorization, `Bearer ${BEARER}`)
  // And the credential is added to the request rather than replacing it.
  assert.match(String(signedIn.sent[0].headers.accept), /application\/json/)
})

await checkAsync("a cookie credential rides as a cookie, and only as a cookie", async () => {
  const recorded = recordingFetch({
    "*": walledUnless((headers) => headers.cookie === COOKIE),
  })
  const opened = await fetchLibraryUrl(DOCS_URL, {
    fetchImpl: recorded.fetchImpl,
    runHelper: noHelper,
    credential: { scheme: "cookie", value: COOKIE },
  })
  assert.equal(opened.ok, true)
  assert.equal(recorded.sent[0].headers.cookie, COOKIE)
  assert.equal("authorization" in recorded.sent[0].headers, false)
})

/*
 * A credential the site does not accept leaves the wall exactly where it was,
 * so the panel can say "that token was refused" and still describe what would
 * open the site.
 */
await checkAsync("a credential the site refuses still reports the wall it hit", async () => {
  const recorded = recordingFetch({
    "*": walledUnless((headers) => headers.authorization === `Bearer ${BEARER}`),
  })
  const refused = await fetchLibraryUrl(CATALOG_URL, {
    fetchImpl: recorded.fetchImpl,
    runHelper: noHelper,
    credential: { scheme: "bearer", value: "expired-token" },
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.sso, true)
  assert.equal(refused.wall.origin, CATALOG_ORIGIN)
  assert.equal(recorded.sent[0].headers.authorization, "Bearer expired-token")
})

/*
 * THE LEAK THIS CASE EXISTS TO KEEP FIXED.
 *
 * A redirect can point anywhere, including at a host the designer has never
 * heard of and never signed in to. A bearer token forwarded across that hop is
 * a token handed to a third party, and the third party does not have to be
 * malicious for it to be a disclosure — a logging proxy is enough. Browsers
 * strip `Authorization` on a cross-origin redirect for exactly this reason;
 * `fetchLibraryUrl` follows redirects by hand, so `fetch` cannot do it here and
 * the check is the module's own.
 *
 * Asserted per hop on what was SENT, because every other observable — the
 * stored credential, the formatted header, the final response — is identical
 * whether the token leaked or not. The same fixture then runs with a
 * same-origin hop, so the case proves a rule about origins rather than a rule
 * about "only the first request".
 */
await checkAsync("a credential is not forwarded across a cross-origin redirect", async () => {
  const start = `${CATALOG_ORIGIN}/atlas/index.json`
  const elsewhere = "https://cdn.example.org/atlas/index.json"

  const away = recordingFetch({
    [start]: { status: 302, headers: { location: elsewhere, "content-type": "text/html" }, body: "" },
    [elsewhere]: json(INDEX_JSON),
  })
  const crossed = await fetchLibraryUrl(start, {
    fetchImpl: away.fetchImpl,
    runHelper: noHelper,
    credential: { scheme: "bearer", value: BEARER },
  })

  assert.equal(crossed.ok, true, "the redirect itself must still be followed")
  assert.equal(away.sent.length, 2, `expected two hops, saw ${away.sent.length}`)
  assert.equal(away.sent[0].url, start)
  assert.equal(away.sent[1].url, elsewhere)

  // Hop 1 is the origin the credential was stored for, so it gets it.
  assert.equal(away.sent[0].headers.authorization, `Bearer ${BEARER}`)
  // Hop 2 is somebody else, so it gets nothing — not an empty header, none.
  assert.equal(
    "authorization" in away.sent[1].headers,
    false,
    "the token was forwarded to another origin"
  )
  assert.equal(JSON.stringify(away.sent[1].headers).includes(BEARER), false)

  // A cookie is a credential too, and leaks the same way.
  const cookies = recordingFetch({
    [start]: { status: 302, headers: { location: elsewhere, "content-type": "text/html" }, body: "" },
    [elsewhere]: json(INDEX_JSON),
  })
  await fetchLibraryUrl(start, {
    fetchImpl: cookies.fetchImpl,
    runHelper: noHelper,
    credential: { scheme: "cookie", value: COOKIE },
  })
  assert.equal(cookies.sent[0].headers.cookie, COOKIE)
  assert.equal("cookie" in cookies.sent[1].headers, false, "the cookie was forwarded to another origin")

  // The control: a hop within the same origin keeps the credential, so the rule
  // above is about WHERE the request went and not about how many hops it took.
  const withinSite = `${CATALOG_ORIGIN}/atlas/`
  const home = recordingFetch({
    [start]: { status: 301, headers: { location: withinSite, "content-type": "text/html" }, body: "" },
    [withinSite]: json(INDEX_JSON),
  })
  await fetchLibraryUrl(start, {
    fetchImpl: home.fetchImpl,
    runHelper: noHelper,
    credential: { scheme: "bearer", value: BEARER },
  })
  assert.equal(home.sent.length, 2)
  assert.equal(home.sent[1].headers.authorization, `Bearer ${BEARER}`)
})

// ── The promise the store makes ────────────────────────────────────────────

console.log("\nWhat the store does with a wall")

/*
 * The rule, and the reason for it: a row named after a site reporting zero
 * components tells a designer their design system is empty, when the truth is
 * that they are signed out. So the add is refused — and the refusal carries the
 * challenge, because a refusal the panel cannot act on is just a failure.
 */
await checkAsync("a walled URL is refused, carrying the challenge, and never appears", async () => {
  const context = await project({
    fetchImpl: recordingFetch({ "*": html(PASSWORD_PAGE) }).fetchImpl,
    runHelper: noHelper,
  })
  try {
    await assert.rejects(context.store.add({ url: CATALOG_URL }), (error) => {
      assert.equal(error.statusCode, 400)
      assert.match(error.message, /sign-in/i)
      assert.equal(error.auth.kind, "redirect")
      assert.equal(error.auth.origin, CATALOG_ORIGIN)
      assert.equal(error.auth.url, CATALOG_URL)
      assert.ok(error.auth.hint, "a challenge with no hint gives the panel nothing to say")
      return true
    })

    // The promise, checked where the designer would see it broken.
    assert.deepEqual((await context.store.list()).libraries, [])
    assert.deepEqual(await storedLibraries(context), [])
  } finally {
    await context.cleanup()
  }
})

await checkAsync("the same URL installs once the editor is signed in to its origin", async () => {
  const recorded = recordingFetch({
    "*": walledUnless((headers) => headers.authorization === `Bearer ${BEARER}`),
  })
  const context = await project({ fetchImpl: recorded.fetchImpl, runHelper: noHelper })
  try {
    // Signed in first: the credential is read per fetch, not at construction,
    // because signing in happens while the editor is open.
    await context.auth.saveCredential({ url: CATALOG_URL, scheme: "bearer", value: BEARER })

    const { library } = await context.store.add({ url: CATALOG_URL })
    assert.equal(library.source.kind, URL_SOURCE_KIND)
    assert.equal(library.source.path, CATALOG_URL)
    assert.equal(library.counts.components, 2)
    assert.ok(!library.error, `installed with an error: ${library.error}`)

    const { libraries } = await context.store.list()
    assert.equal(libraries.length, 1)
    assert.equal(libraries[0].counts.components, 2)

    // Every request that went out carried it, probes included.
    assert.ok(recorded.sent.length > 1)
    for (const request of recorded.sent) {
      assert.equal(request.headers.authorization, `Bearer ${BEARER}`)
    }

    const stored = await fs.readFile(context.librariesFile, "utf8")
    assert.equal(stored.includes(BEARER), false, "the pointer file carried the credential")
  } finally {
    await context.cleanup()
  }
})

/*
 * `addUrl` refuses to create a walled row, so a store written by this version
 * holds none — but one written before the wall was refused does, and so does
 * one whose credential has since expired. A rule that only holds for rows added
 * after the upgrade is not the rule, so `list()` sweeps them: out of the answer,
 * and out of the file, so the next add of the same URL is a clean install
 * rather than a collision with a ghost.
 */
await checkAsync("a walled row from an older build is swept from the answer and the file", async () => {
  const context = await project({
    fetchImpl: recordingFetch({ "*": html(PASSWORD_PAGE) }).fetchImpl,
    runHelper: noHelper,
  })
  try {
    await seedLibraries(context, [
      {
        id: "atlas-ghost",
        name: "Atlas",
        enabled: true,
        source: { kind: URL_SOURCE_KIND, path: CATALOG_URL },
        addedAt: 1700000000000,
        catalog: null,
        detail: "",
        error: "Needs sign-in: this site refused the editor. Sign in to it below, or paste a public URL.",
      },
      {
        id: "unreachable-tokens",
        name: "Tokens",
        enabled: true,
        source: { kind: URL_SOURCE_KIND, path: "https://tokens.example.com/tokens.json" },
        addedAt: 1700000000001,
        catalog: null,
        detail: "",
        error: "https://tokens.example.com/tokens.json could not be reached (network error)",
      },
    ])

    const { libraries } = await context.store.list()
    assert.deepEqual(
      libraries.map((library) => library.id),
      ["unreachable-tokens"],
      "the walled row was still in the answer"
    )

    const onDisk = await storedLibraries(context)
    assert.deepEqual(
      onDisk.map((entry) => entry.id),
      ["unreachable-tokens"],
      "the walled row was still in the file"
    )
  } finally {
    await context.cleanup()
  }
})

/*
 * The boundary the sweep must not cross. An unreachable URL is not a wall: the
 * network comes back, and the row is what carries the retry and the removal. A
 * sweep that read "empty catalog plus an error" as "walled" would delete a
 * library every time the designer's wifi dropped.
 */
await checkAsync("a URL that is merely unreachable is installed, listed and kept", async () => {
  const unreachable = "https://tokens.example.invalid/tokens.json"
  const context = await project({
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND tokens.example.invalid")
    },
    runHelper: noHelper,
  })
  try {
    const { library } = await context.store.add({ url: unreachable })
    assert.equal(library.source.kind, URL_SOURCE_KIND)
    assert.match(library.error, /could not be reached/)
    assert.doesNotMatch(library.error, /needs sign-in/i)
    assert.deepEqual(
      Object.values(library.counts).filter((count) => count !== 0),
      []
    )

    const { libraries } = await context.store.list()
    assert.equal(libraries.length, 1, "the sweep ate a row that was only unreachable")
    assert.equal(libraries[0].id, library.id)
    assert.match(libraries[0].error, /could not be reached/)

    assert.deepEqual(
      (await storedLibraries(context)).map((entry) => entry.id),
      [library.id]
    )
  } finally {
    await context.cleanup()
  }
})

/*
 * A GHOST ROW IS REPAIRED BY PASTING THE LINK AGAIN — and this case used to
 * pin the opposite, as a documented gap.
 *
 * The gap was in `addUrl`'s idempotence check: it ran against `readEntries`,
 * matched the existing row, and handed it straight back WITHOUT fetching. So a
 * row left empty by an earlier failure — a wall that has since been signed in
 * to, or a reading bug that has since been fixed — stayed empty, and re-pasting
 * the link, the one gesture a person would try, provably did nothing. The only
 * way out was to notice the Remove button and use it first.
 *
 * Adding the same URL now re-reads it, so this asserts the repair. The sweep
 * half of the old case is kept, because it is a different mechanism and still
 * true: `list()` drops a walled ghost entirely rather than leaving it in the
 * file.
 */
await checkAsync("a ghost row is repaired by adding the same link again", async () => {
  const recorded = recordingFetch({
    "*": walledUnless((headers) => headers.authorization === `Bearer ${BEARER}`),
  })
  const context = await project({ fetchImpl: recorded.fetchImpl, runHelper: noHelper })
  try {
    await context.auth.saveCredential({ url: CATALOG_URL, scheme: "bearer", value: BEARER })
    await seedLibraries(context, [
      {
        id: "atlas-ghost",
        name: "Atlas",
        enabled: true,
        source: { kind: URL_SOURCE_KIND, path: CATALOG_URL },
        addedAt: 1700000000000,
        catalog: null,
        detail: "",
        error: "Needs sign-in: this site refused the editor. Sign in to it below, or paste a public URL.",
      },
    ])

    /*
     * The credential is stored, so the re-read gets through and the row that
     * was a ghost comes back carrying the catalog — in place, keeping the id,
     * the name and the switch the designer had already set.
     */
    const repaired = await context.store.add({ url: CATALOG_URL })
    assert.equal(repaired.library.id, "atlas-ghost", "the repair moved the row instead of filling it")
    assert.equal(repaired.library.counts.components, 2, "adding the same link again did not re-read it")
    assert.ok(!repaired.library.error, `the stale sentence survived: ${repaired.library.error}`)
    assert.ok(recorded.sent.length > 0, "the re-add never went to the network")
    assert.equal((await context.store.list()).libraries.length, 1, "the repair added a second row")

    // And the sweep still does its own job: a row that is STILL walled is
    // dropped by `list()` rather than left in the file as a ghost.
    await context.auth.forgetCredential(CATALOG_ORIGIN)
    await seedLibraries(context, [
      {
        id: "atlas-ghost",
        name: "Atlas",
        enabled: true,
        source: { kind: URL_SOURCE_KIND, path: CATALOG_URL },
        addedAt: 1700000000000,
        catalog: null,
        detail: "",
        error: "Needs sign-in: this site refused the editor. Sign in to it below, or paste a public URL.",
      },
    ])
    assert.deepEqual((await context.store.list()).libraries, [])
  } finally {
    await context.cleanup()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
