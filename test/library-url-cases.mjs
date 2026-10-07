/**
 * Adding a design system by pasting a URL: what is probed, what is parsed, and
 * what a sign-in wall does to both.
 *
 * Every other library kind is a file this process can open, so its test is a
 * string and a parser. This one is a conversation with somebody else's server,
 * and that makes three things worth pinning that no other suite has to think
 * about:
 *
 *  - **the suite runs offline, always.** `fetchImpl` and `runHelper` are
 *    injected, so nothing here touches the network. That is not tidiness: a
 *    suite allowed to reach the real internet fails on a plane, fails behind a
 *    proxy, and silently changes meaning the day somebody redeploys the site it
 *    points at. Every host below is a documentation domain reserved by RFC 2606
 *    and RFC 6761, so none of them can ever resolve to a real server either;
 *  - **a sign-in wall is the normal case, and it arrives disguised as success.**
 *    Most catalogs worth pointing this at belong to some organisation, and a
 *    refused request mostly does not fail the way a refused request is supposed
 *    to: a `fetch` that follows redirects answers HTTP 200 with a body, and the
 *    body is a login page. So the detection works off the BODY as well as off
 *    the redirect, because following the redirect is exactly what hides the 302.
 *    Left undetected, this feature installs a "library" containing the sign-in
 *    form, reports success, and gives the designer no way to see what happened;
 *  - **cross-origin is the line between a handoff and ordinary routing.** A site
 *    that redirects to its own `/login` is routing inside itself and is not a
 *    wall; a site that sends the request to another host has handed it to an
 *    identity provider. Getting that backwards would refuse to install public
 *    sites for the crime of having a login page.
 *
 * The probe ordering is pinned for a related reason. A designer pastes the page
 * they are reading, which is several levels below the story index describing
 * the whole system, so the walk goes deepest-first and ends at the bare origin.
 * Reverse that order and a Storybook mounted at `/atlas` is found only after
 * the origin has been asked — which on a site that serves its app shell for
 * every path means it is never found at all.
 *
 * The store cases at the end go through a REAL `createLibraryStore` against a
 * real temp directory, because the rules they check are rules about
 * persistence: a URL that could not be READ is installed anyway, carrying its
 * sentence, and a URL that could not be SEEN AT ALL is refused outright.
 *
 * Usage: node designlayer/test/library-url-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { resolveConfig } from "../config.mjs"
import { classifyWall } from "../server/library-auth.mjs"
import { createLibraryStore } from "../server/libraries.mjs"
import {
  URL_SOURCE_KIND,
  catalogProbes,
  componentFromPage,
  fetchLibraryUrl,
  isLibraryUrl,
  libraryNameFromUrl,
  looksLikeSsoWall,
  parseStorybookIndex,
  parseUrlLibrary,
} from "../server/library-url.mjs"

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

/* ---------- two kinds of site, and the provider they hand off to ---------- */

/**
 * A Storybook on a platform that mints its own subdomains. The host is a
 * deployment artefact and says nothing about the design system; the path does.
 */
const STORYBOOK_ORIGIN = "https://storybook-7f3a29b4-uc.example.net"
const STORYBOOK_URL = `${STORYBOOK_ORIGIN}/atlas/primitives/avatar`

/** A documentation site named after the system it documents. */
const DOCS_ORIGIN = "https://design-system.example.com"
const DOCS_URL = `${DOCS_ORIGIN}/toolkit/components/split-button`

/** Somebody else's host: the identity provider these sites hand off to. */
const IDP_ORIGIN = "https://login.example.org"

/** Storybook v7+: `entries`, keyed by `title`, with a docs entry beside the stories. */
const INDEX_V4 = {
  v: 5,
  entries: {
    "primitives-avatar--docs": {
      id: "primitives-avatar--docs",
      title: "Primitives/Avatar",
      name: "Docs",
      importPath: "./src/avatar/avatar.stories.ts",
      type: "docs",
    },
    "primitives-avatar--default": {
      id: "primitives-avatar--default",
      title: "Primitives/Avatar",
      name: "Default",
      importPath: "./src/avatar/avatar.stories.ts",
      type: "story",
    },
    "primitives-avatar--with-image": {
      id: "primitives-avatar--with-image",
      title: "Primitives/Avatar",
      name: "With image",
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

/** Storybook v6: `stories`, keyed by `kind`, docs flagged in `parameters`. */
const INDEX_V3 = {
  v: 3,
  stories: {
    "primitives-avatar--page": {
      id: "primitives-avatar--page",
      kind: "Primitives/Avatar",
      name: "Page",
      importPath: "./src/avatar/avatar.stories.ts",
      parameters: { docsOnly: true },
    },
    "primitives-avatar--default": {
      id: "primitives-avatar--default",
      kind: "Primitives/Avatar",
      name: "Default",
      importPath: "./src/avatar/avatar.stories.ts",
      parameters: {},
    },
    "primitives-avatar--with-image": {
      id: "primitives-avatar--with-image",
      kind: "Primitives/Avatar",
      name: "With image",
      importPath: "./src/avatar/avatar.stories.ts",
      parameters: {},
    },
    "primitives-badge--default": {
      id: "primitives-badge--default",
      kind: "Primitives/Badge",
      name: "Default",
      importPath: "./src/badge/badge.stories.ts",
      parameters: {},
    },
  },
}

/**
 * What a walled site serves once its redirect has been followed: HTTP 200,
 * `text/html`, and a login form. The password input is the evidence, because
 * the status line has none left.
 */
const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head>
<body>
<form method="post" action="/session">
  <label>Email <input type="email" name="email" autocomplete="username"></label>
  <label>Password <input type="password" name="password"></label>
  <button type="submit">Sign in</button>
</form>
</body></html>`

/** An OAuth 2.0 authorization request, with the parameters RFC 6749 requires. */
const OAUTH_LOCATION =
  `${IDP_ORIGIN}/oauth2/authorize` +
  "?client_id=a1b2c3d4-5e6f-4071-8abc-9d0e1f2a3b4c" +
  "&response_type=code" +
  "&scope=openid+email" +
  `&redirect_uri=${encodeURIComponent(`${STORYBOOK_ORIGIN}/oauth2/callback`)}`

const DOCS_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Design system web components</title>
<meta name="description" content="Split button: a primary action with a menu of related actions.">
</head><body><ds-split-button></ds-split-button></body></html>`

/**
 * A fake `fetch` over a recorded map of URL to response. 404 for anything else.
 *
 * The headers come back as a real `Headers`, which is what `fetch` returns and
 * what the code under test reads the challenge out of: a response whose headers
 * are a plain object still yields its content type and its `Location`, but its
 * full header set — `WWW-Authenticate` included — does not survive the trip.
 * A fake that took the easier shape would quietly test a narrower module than
 * the one that ships.
 */
function fakeFetch(routes) {
  return async (url) => {
    const recorded = routes[String(url)]
    const response = recorded ?? { status: 404, headers: { "content-type": "text/html" }, body: "" }
    return {
      status: response.status,
      headers: new Headers(response.headers ?? {}),
      text: async () => response.body ?? "",
    }
  }
}

/**
 * No helper command configured, which is the default and the ordinary case.
 *
 * `runHelper` is how a project points the editor at whatever command-line
 * client its own proxy needs — the editor ships knowing none of them. Unset,
 * there is no second route out of a wall, and the caller reports the wall.
 */
const noHelper = async () => null

const offline = (routes) => ({ fetchImpl: fakeFetch(routes), runHelper: noHelper })

const json = (body) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const html = (body, status = 200) => ({
  status,
  headers: { "content-type": "text/html" },
  body,
})

// ── Naming ─────────────────────────────────────────────────────────────────

console.log("\nWhat a URL is called")

check("only http and https are library URLs", () => {
  assert.equal(isLibraryUrl(STORYBOOK_URL), true)
  assert.equal(isLibraryUrl("http://localhost:6006/"), true)
  assert.equal(isLibraryUrl("file:///etc/passwd"), false)
  assert.equal(isLibraryUrl("src/styles/theme.css"), false)
  assert.equal(isLibraryUrl(""), false)
  assert.equal(isLibraryUrl(null), false)
})

/*
 * The host wins when it says something, and loses to the path when it is a
 * deployment artefact. `design-system.example.com` is the system's own name;
 * `storybook-7f3a29b4-uc.example.net` is what a hosting platform handed out, and
 * naming a library after it would put a build hash in the panel.
 */
check("a URL is named after whichever of the host and the path is a name", () => {
  assert.equal(libraryNameFromUrl(DOCS_URL), "Design system")
  assert.equal(libraryNameFromUrl(STORYBOOK_URL), "Atlas")
})

// ── Probing ────────────────────────────────────────────────────────────────

console.log("\nWhere the catalog might be")

/*
 * Three filenames at every level, and each belongs to a different tool:
 * `index.json` is Storybook v7+, `stories.json` is what v6 called the same
 * file, and `meta.json` is what `ladle build` writes. A filename that is never
 * asked for is a tool that can never be found, and the extra 404 costs nothing
 * in a round of requests that is already parallel.
 */
check("a deep URL is probed deepest-first, with the bare origin last", () => {
  assert.deepEqual(catalogProbes(STORYBOOK_URL), [
    `${STORYBOOK_ORIGIN}/atlas/primitives/avatar/index.json`,
    `${STORYBOOK_ORIGIN}/atlas/primitives/avatar/stories.json`,
    `${STORYBOOK_ORIGIN}/atlas/primitives/avatar/meta.json`,
    `${STORYBOOK_ORIGIN}/atlas/primitives/index.json`,
    `${STORYBOOK_ORIGIN}/atlas/primitives/stories.json`,
    `${STORYBOOK_ORIGIN}/atlas/primitives/meta.json`,
    `${STORYBOOK_ORIGIN}/atlas/index.json`,
    `${STORYBOOK_ORIGIN}/atlas/stories.json`,
    `${STORYBOOK_ORIGIN}/atlas/meta.json`,
    `${STORYBOOK_ORIGIN}/index.json`,
    `${STORYBOOK_ORIGIN}/stories.json`,
    `${STORYBOOK_ORIGIN}/meta.json`,
  ])
})

check("a URL that already names a JSON file is its own first probe", () => {
  const probes = catalogProbes("https://example.com/design/tokens.json")
  assert.equal(probes[0], "https://example.com/design/tokens.json")
  assert.equal(probes[probes.length - 1], "https://example.com/meta.json")
})

/*
 * THE PREFIXES AT BOTH ENDS OF THE PATH, which is a different list from the
 * four deepest and a better one.
 *
 * Walking outwards and keeping the first four prefixes keeps the four DEEPEST —
 * `…/overview`, `…/text-field`, `…/forms`, `…/components` — and then jumps
 * straight to the origin. Nobody mounts a component explorer at
 * `…/forms/text-field/overview`; organisations mount one at `/v2/web`, and
 * those are exactly the prefixes that walk used to discard. Modelled on a
 * versioned enterprise documentation site, where the tool sits two segments
 * down and the pasted URL is six.
 */
check("a deep URL is probed at the shallow end of its path as well as the deep end", () => {
  const probes = catalogProbes(
    "https://design.example.com/v2/web/components/forms/text-field/overview"
  )
  assert.ok(
    probes.includes("https://design.example.com/v2/web/index.json"),
    "never asked the prefix a tool is actually mounted at"
  )
  assert.ok(probes.includes("https://design.example.com/v2/index.json"))
  // Still deepest-first, and still ending at the origin.
  assert.equal(
    probes[0],
    "https://design.example.com/v2/web/components/forms/text-field/overview/index.json"
  )
  assert.equal(probes[probes.length - 1], "https://design.example.com/meta.json")
})

// ── Storybook ──────────────────────────────────────────────────────────────

console.log("\nReading a story index")

/*
 * A story index is a flat list of STORIES and a designer thinks in components,
 * so the collapse onto `title` is the whole translation. Left flat, one
 * component with a dozen variants is a dozen near-identical rows.
 */
check("a v4 index groups stories by title and keeps the names as variants", () => {
  const parsed = parseStorybookIndex(INDEX_V4)
  assert.equal(parsed.components.length, 2)

  const [avatar, badge] = parsed.components
  assert.equal(avatar.id, "component:primitives-avatar")
  assert.equal(avatar.name, "Avatar")
  assert.equal(avatar.group, "Primitives")
  assert.equal(avatar.file, "./src/avatar/avatar.stories.ts")
  assert.deepEqual(avatar.props, [
    { name: "Story", type: "variant", values: ["Default", "With image"], default: "Default" },
  ])
  assert.equal(badge.name, "Badge")
  assert.deepEqual(badge.props?.[0].values, ["Default"])
})

/*
 * `kind` is v3's word for `title` and `parameters.docsOnly` is its word for
 * `type: "docs"`. Two dialects of one fact, so they have to produce one answer
 * — a project that has not upgraded Storybook is not a project with a different
 * design system.
 */
check("a v3 stories.json reads to exactly the same shape through `kind`", () => {
  const fourth = parseStorybookIndex(INDEX_V4)
  const third = parseStorybookIndex(INDEX_V3)
  assert.deepEqual(third, fourth)
})

check("JSON that is not a story index is refused rather than guessed at", () => {
  assert.equal(parseStorybookIndex({ color: { brand: { $value: "#0b57d0" } } }), null)
  assert.equal(parseStorybookIndex([]), null)
  assert.equal(parseStorybookIndex(null), null)
  // `entries` present but carrying no titles is not an index either.
  assert.equal(parseStorybookIndex({ v: 4, entries: { a: { id: "a" } } }), null)
})

// ── Sign-in walls ──────────────────────────────────────────────────────────

console.log("\nTelling a login page from a design system")

/*
 * The 200 case is the one that matters. A `fetch` that follows redirects turns
 * the 302 into a successful-looking HTML page, and every marker of what went
 * wrong is left in the body. Miss it and the editor installs somebody's sign-in
 * form as a design system, with a green checkmark next to it.
 */
check("a 200 HTML body carrying a password input is a wall", () => {
  assert.equal(
    looksLikeSsoWall({ status: 200, contentType: "text/html", text: LOGIN_PAGE }, STORYBOOK_URL),
    true
  )
})

check("a cross-origin 302 to a sign-in service is a wall", () => {
  assert.equal(
    looksLikeSsoWall(
      {
        status: 302,
        contentType: "text/html; charset=UTF-8",
        text: "",
        location: `${IDP_ORIGIN}/sso/request?continue=${encodeURIComponent(DOCS_URL)}`,
      },
      DOCS_URL
    ),
    true
  )
  // And so is the OAuth flavour of the same hop.
  assert.equal(
    looksLikeSsoWall(
      { status: 302, contentType: "text/html", text: "", location: OAUTH_LOCATION },
      STORYBOOK_URL
    ),
    true
  )
})

/*
 * THE BOUNDARY that the cross-origin rule exists to draw. A site redirecting to
 * its own login page is routing inside itself: plenty of perfectly public
 * documentation sites bounce an anonymous visitor to `/login` and then serve
 * them anyway, and reading that as a refusal would make the editor decline to
 * install them with an error blaming the site.
 */
check("a same-origin redirect to /login is routing, not a wall", () => {
  for (const location of [
    "/login",
    `${DOCS_ORIGIN}/login?next=%2Ftoolkit`,
    `${DOCS_ORIGIN}/signin`,
    `${DOCS_ORIGIN}/oauth2/authorize?response_type=code&client_id=a1b2c3d4`,
  ]) {
    assert.equal(
      looksLikeSsoWall({ status: 302, contentType: "text/html", text: "", location }, DOCS_URL),
      false,
      location
    )
  }
})

check("a 401 is a wall whatever its body says, and so is a 403", () => {
  assert.equal(
    looksLikeSsoWall(
      {
        status: 401,
        contentType: "text/html",
        text: "Not authorized",
        headers: { "www-authenticate": "Bearer" },
      },
      STORYBOOK_URL
    ),
    true
  )
  assert.equal(
    looksLikeSsoWall(
      {
        status: 401,
        contentType: "text/html",
        text: "",
        headers: { "www-authenticate": 'Basic realm="Docs"' },
      },
      DOCS_URL
    ),
    true
  )
  assert.equal(
    looksLikeSsoWall({ status: 403, contentType: "text/html", text: "Forbidden" }, DOCS_URL),
    true
  )
})

check("real JSON is not a wall", () => {
  assert.equal(
    looksLikeSsoWall(
      { status: 200, contentType: "application/json", text: JSON.stringify(INDEX_V4) },
      STORYBOOK_URL
    ),
    false
  )
  assert.equal(
    looksLikeSsoWall({ status: 200, contentType: "text/html", text: DOCS_PAGE }, DOCS_URL),
    false
  )
})

// ── The page itself ────────────────────────────────────────────────────────

console.log("\nThe last-resort page parse")

/*
 * One component is the honest answer for a page about one component, and it is
 * what makes pasting a deep link useful at all. The URL is the evidence rather
 * than the markup: every documentation site renders its own chrome, and no
 * scrape of the DOM survives a redesign, while the path segments are the site's
 * own information architecture.
 */
check("a component documentation page names one component from its path", () => {
  const component = componentFromPage(DOCS_URL, DOCS_PAGE)
  assert.equal(component.id, "component:split-button")
  assert.equal(component.name, "Split button")
  assert.equal(component.group, "Components")
  assert.equal(component.description, "Split button: a primary action with a menu of related actions.")
  assert.equal(component.file, DOCS_URL)
})

check("a bare origin, and anything that is not HTML, names nothing", () => {
  assert.equal(componentFromPage("https://example.com/", DOCS_PAGE), null)
  assert.equal(componentFromPage(DOCS_URL, '{"v":4}'), null)
  assert.equal(componentFromPage(DOCS_URL, null), null)
})

// ── Fetching ───────────────────────────────────────────────────────────────

console.log("\nFetching, redirecting and being refused")

await checkAsync("a plain redirect is followed; a login page is refused", async () => {
  const followed = await fetchLibraryUrl("https://example.com/atlas", {
    ...offline({
      "https://example.com/atlas": {
        status: 301,
        headers: { location: "https://example.com/atlas/" },
        body: "",
      },
      "https://example.com/atlas/": json(INDEX_V4),
    }),
  })
  assert.equal(followed.ok, true)
  assert.equal(followed.sso, false)
  assert.equal(followed.viaHelper, false)

  const walled = await fetchLibraryUrl(STORYBOOK_URL, {
    ...offline({ [STORYBOOK_URL]: html(LOGIN_PAGE) }),
  })
  assert.equal(walled.ok, false)
  assert.equal(walled.sso, true)
  assert.equal(walled.wall.kind, "redirect")
  assert.equal(walled.wall.origin, STORYBOOK_ORIGIN)
  assert.match(walled.error, /sign-in/i)
})

await checkAsync("a 401 comes back as the challenge the site actually sent", async () => {
  const refused = await fetchLibraryUrl(DOCS_URL, {
    ...offline({
      [DOCS_URL]: {
        status: 401,
        headers: { "content-type": "text/html", "www-authenticate": 'Basic realm="Docs"' },
        body: "Unauthorized",
      },
    }),
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.sso, true)
  assert.equal(refused.wall.kind, "basic")
  assert.equal(refused.wall.realm, "Docs")
  assert.equal(refused.wall.origin, DOCS_ORIGIN)
})

/*
 * The project's own escape hatch. Some organisations front their internal docs
 * with a proxy that has a command-line client — a signed-request tool, a
 * VPN-aware curl wrapper, a credential helper — and the editor has no business
 * knowing which, so it knows none of them: the project names a command in its
 * config and the editor runs it when a fetch is refused. The rescue is recorded
 * on the response, because an answer that came back by a different route is
 * worth being able to see.
 */
await checkAsync("a wall the project's helper command can get through sets viaHelper", async () => {
  const rescued = await fetchLibraryUrl(DOCS_URL, {
    fetchImpl: fakeFetch({
      [DOCS_URL]: {
        status: 401,
        headers: { "content-type": "text/html", "www-authenticate": "Bearer" },
        body: "",
      },
    }),
    runHelper: async () => ({ status: 200, contentType: "text/html", text: DOCS_PAGE }),
  })
  assert.equal(rescued.ok, true)
  assert.equal(rescued.viaHelper, true)
  assert.equal(rescued.sso, false)
  assert.equal(rescued.text, DOCS_PAGE)
})

/*
 * FIXED, and kept as the guard — this was a real bug and a subtle one.
 *
 * `fetchLibraryUrl` tests the same response for a wall twice: once inside the
 * redirect loop and once after it. The second test was written without the
 * request URL, and the URL is not decorative — it is how `classifyWall` tells a
 * cross-origin handoff from an app routing to its own login page. So the second
 * test could not see any wall whose evidence is cross-origin: an OAuth 302, a
 * sign-in bounce, or a 200 embedding an authorization URL.
 *
 * The loop stopped at the wall correctly and the code after it then denied
 * there was one. The caller got `sso: false`, no `wall`, and "redirected more
 * times than this editor will follow" — a sentence about redirect limits, for a
 * request refused on its first hop. The panel had no challenge to act on, the
 * store installed the login page as a library instead of refusing it, and the
 * OAuth `client_id`, which is the whole payload of the feature, never reached
 * the designer.
 *
 * The fix was one argument. The case stays because nothing else would notice it
 * coming back: every symptom is a plausible-looking message about redirects.
 */
await checkAsync("a cross-origin OAuth 302 is read, and its audience survives", async () => {
  const record = {
    status: 302,
    contentType: "text/html",
    text: "",
    headers: { location: OAUTH_LOCATION, "content-type": "text/html" },
  }

  // The classifier is right, and it is right only because it was given the URL.
  const read = classifyWall(record, STORYBOOK_URL)
  assert.equal(read.kind, "oauth")
  assert.equal(read.audience, "a1b2c3d4-5e6f-4071-8abc-9d0e1f2a3b4c")
  assert.equal(classifyWall(record, ""), null, "without the URL there is nothing to compare")

  // And the caller is told the same thing the classifier saw.
  const refused = await fetchLibraryUrl(STORYBOOK_URL, {
    ...offline({
      [STORYBOOK_URL]: {
        status: 302,
        headers: { location: OAUTH_LOCATION, "content-type": "text/html" },
        body: "",
      },
    }),
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.sso, true, "the wall was detected and then unread again")
  assert.equal(refused.wall?.kind, "oauth")
  assert.equal(refused.wall?.audience, "a1b2c3d4-5e6f-4071-8abc-9d0e1f2a3b4c")
  // The redirect-limit sentence is what this bug used to produce. It must not
  // come back for a request that was refused on its first hop.
  assert.doesNotMatch(refused.error, /redirected more times/)
})

// ── The whole job ──────────────────────────────────────────────────────────

console.log("\nEnd to end, offline")

await checkAsync("a Storybook deep link resolves to the system's whole catalog", async () => {
  const result = await parseUrlLibrary(
    STORYBOOK_URL,
    offline({ [`${STORYBOOK_ORIGIN}/atlas/index.json`]: json(INDEX_V4) })
  )
  assert.equal(result.error, "")
  assert.equal(result.name, "Atlas")
  assert.deepEqual(
    result.catalog.components.map((component) => component.name),
    ["Avatar", "Badge"]
  )
  assert.equal(result.detail, "2 components · 3 variants")
})

/*
 * A token file served over HTTP has to read exactly as the same file on disk
 * does, which is why this branch hands the text to `library-sources.mjs` rather
 * than parsing it again. A second DTCG reader is how a designer who moves a
 * file behind a URL silently loses half their tokens.
 */
await checkAsync("a token file at a URL is read by the parsers the file path uses", async () => {
  const tokens = {
    color: { brand: { $type: "color", $value: "#0b57d0" } },
    space: { md: { $type: "dimension", $value: "16px" } },
  }
  const result = await parseUrlLibrary(
    "https://example.com/design/tokens.json",
    offline({ "https://example.com/design/tokens.json": json(tokens) })
  )
  assert.equal(result.error, "")
  assert.equal(result.catalog.colors.length, 1)
  assert.equal(result.catalog.colors[0].values.light, "#0b57d0")
  assert.equal(result.catalog.spacing.length, 1)
  assert.equal(result.detail, "1 color · 1 spacing step")
})

await checkAsync("a page with no story index behind it yields its one component", async () => {
  const result = await parseUrlLibrary(DOCS_URL, offline({ [DOCS_URL]: html(DOCS_PAGE) }))
  assert.equal(result.error, "")
  assert.equal(result.detail, "1 component")
  assert.equal(result.catalog.components.length, 1)
  assert.equal(result.catalog.components[0].name, "Split button")
})

/*
 * THE SHAPE OF EVERY MODERN COMPONENT EXPLORER, and the one this lane used to
 * install as an empty library.
 *
 * Nothing here is machine-readable in the way the cases above assume. The site
 * is a client-rendered application: it answers 200 with the SAME HTML shell for
 * every path, so every `index.json` probe comes back as HTML that will not
 * parse, and the whole reading collapses to one component guessed from the URL.
 * The counts read zero, the pickers gain nothing, and the designer reports that
 * they added a design system and no styles appeared. Modelled on a real one.
 *
 * The tokens are in its compiled CSS, which this editor has always known how to
 * read — the lane simply never fetched a stylesheet. Three things have to hold
 * for that to produce the right answer, and this case pins all three:
 *
 *  1. the stylesheets are followed at all;
 *  2. the PREVIEW document's are preferred over the shell's, because the shell
 *     is the tool's own chrome and its CSS is the tool's own theme;
 *  3. a preview candidate that answered with the shell is discarded — on a
 *     catch-all SPA `…/avatar/preview.html` returns the shell with a 200, and
 *     being deeper it is reached before the real `/preview.html`.
 *
 * Drop (3) and this case still satisfies (1) and (2) while returning the
 * chrome's palette, which is the wrong answer wearing the right shape.
 */
const SPA_ORIGIN = "https://explorer.example.net"
const SPA_URL = `${SPA_ORIGIN}/acme/primitives/avatar`
const SPA_SHELL = `<!doctype html><html><head><title>Explorer</title>
<link rel="stylesheet" href="/assets/chrome.css"></head><body><div id="root"></div></body></html>`
const SPA_PREVIEW = `<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.example.com/css2?family=X&amp;display=swap">
<link rel="stylesheet" href="/assets/preview.css"></head><body></body></html>`
// The tool's own theme: plausible, complete, and not the design system.
const CHROME_CSS = ":root{--color-amber-50:#fffbeb;--color-green-50:#f0fdf4;--spacing:4px}"
// The design system, behind an escaped-quote selector of the kind a utility
// framework emits — the parser bug and the fetching gap in one fixture.
const PREVIEW_CSS =
  String.raw`.\[\&\>svg\]\:size-4\:not\(\'x\'\)>svg{display:none}` +
  ":root{--color-accent:#9dd2ff;--color-surface:#faf9f9;--spacing-m:8px;--radius-md:12px}" +
  ".dark{--color-accent:#1f3b9b;--color-surface:#0f0f0f}"

const css = (body) => ({ status: 200, headers: { "content-type": "text/css" }, body })

/** Every other path answers with the shell, which is what a catch-all SPA does. */
const spaFetch = (routes) => async (url) => {
  const recorded = routes[String(url)]
  const response = recorded ?? { status: 200, headers: { "content-type": "text/html" }, body: SPA_SHELL }
  return {
    status: response.status,
    headers: new Headers(response.headers ?? {}),
    text: async () => response.body ?? "",
  }
}

await checkAsync("a client-rendered explorer yields the preview's tokens, not the shell's", async () => {
  const result = await parseUrlLibrary(SPA_URL, {
    fetchImpl: spaFetch({
      [`${SPA_ORIGIN}/preview.html`]: html(SPA_PREVIEW),
      [`${SPA_ORIGIN}/assets/preview.css`]: css(PREVIEW_CSS),
      [`${SPA_ORIGIN}/assets/chrome.css`]: css(CHROME_CSS),
    }),
    runHelper: noHelper,
  })

  assert.equal(result.error, "")
  const names = result.catalog.colors.map((color) => color.name).sort()
  assert.deepEqual(names, ["accent", "surface"], `read the wrong stylesheet: ${names.join(", ")}`)
  // The dark block came with it, which is what a picker needs and what a
  // single-theme read would silently drop.
  const accent = result.catalog.colors.find((color) => color.name === "accent")
  assert.deepEqual(accent.values, { light: "#9dd2ff", dark: "#1f3b9b" })
  assert.equal(result.catalog.radii.length, 1)
  // And the component the pasted page names is still there: one paste gives the
  // row its component and the pickers their tokens.
  assert.deepEqual(result.catalog.components.map((entry) => entry.name), ["Avatar"])
  assert.match(result.detail, /2 colors/)
  assert.match(result.detail, /1 component/)
})

/*
 * The credential belongs to ONE host. A stylesheet link pointing anywhere else
 * is not followed, so a session cookie given to the editor for a Storybook
 * cannot be handed to a font service on the strength of a `<link>` tag in
 * somebody's build output.
 */
await checkAsync("stylesheets are followed only on the pasted URL's own origin", async () => {
  const asked = []
  await parseUrlLibrary(SPA_URL, {
    fetchImpl: async (url) => {
      asked.push(String(url))
      return spaFetch({
        [`${SPA_ORIGIN}/preview.html`]: html(SPA_PREVIEW),
        [`${SPA_ORIGIN}/assets/preview.css`]: css(PREVIEW_CSS),
      })(url)
    },
    runHelper: noHelper,
  })
  const offOrigin = asked.filter((url) => !url.startsWith(SPA_ORIGIN))
  assert.deepEqual(offOrigin, [], `followed a cross-origin link: ${offOrigin.join(", ")}`)
})

/**
 * One URL read offline, with a RECORD of every request it made.
 *
 * Half the cases below are about a request that must not happen — a
 * cross-origin `@import`, a `media="print"` stylesheet, a composed Storybook on
 * somebody else's host — and a catalog assertion cannot see those. A sheet that
 * was fetched and contributed nothing looks exactly like a sheet that was never
 * fetched, right up until the day it contributes something wrong.
 *
 * `fallback` is what every unrecorded path answers with, which is how a
 * catch-all single-page application is modelled; without one, anything not
 * named in `routes` is a 404.
 */
async function readUrl(url, routes, fallback = null) {
  const asked = []
  const result = await parseUrlLibrary(url, {
    fetchImpl: async (target) => {
      asked.push(String(target))
      const response =
        routes[String(target)] ??
        fallback ?? { status: 404, headers: { "content-type": "text/html" }, body: "" }
      return {
        status: response.status,
        headers: new Headers(response.headers ?? {}),
        text: async () => response.body ?? "",
      }
    },
    runHelper: noHelper,
  })
  return { result, asked }
}

/*
 * THE MOST OBVIOUS THING A DESIGNER CAN DO, which used to be the one thing this
 * lane could not read.
 *
 * Everything else here hunts for a catalog NEAR the pasted URL, on the
 * assumption that the URL is a page beside the design system rather than the
 * design system. Paste the CDN address of a system published as CSS — the
 * `dist/tokens.css` every Style Dictionary build emits and every such package
 * ships — and that assumption is simply false: the body is the whole answer,
 * and it came back as "nothing at this URL read as a design system" because
 * only a path ending `.json` ever had its own body parsed.
 */
await checkAsync("a pasted stylesheet is read as the design system it is", async () => {
  const url = "https://cdn.example.com/@acme/tokens@2.1.0/dist/tokens.css"
  const { result } = await readUrl(url, {
    [url]: css(
      ":root{--acme-color-brand-primary:#0b57d0;--acme-color-brand-on-primary:#ffffff;" +
        "--acme-space-4:16px;--acme-radius-md:8px}"
    ),
  })
  assert.equal(result.error, "")
  assert.equal(result.detail, "2 colors · 1 spacing step · 1 radius")
  assert.deepEqual(
    result.catalog.colors.map((color) => color.name),
    ["brand-primary", "brand-on-primary"]
  )
})

/*
 * The same gap in its two other spellings, and the first of them is the one
 * that stings: `.tokens` is the extension the DTCG format module itself
 * recommends, so the canonical filename of the open standard was the filename
 * that failed. The second is a tokens endpoint with no extension at all, which
 * is what a design-system API serves.
 *
 * The content types are deliberately unhelpful — `application/octet-stream` for
 * the first — because a static host serving a `.tokens` file has no reason to
 * know what it is. Detection is by content, and pinning that here keeps it so.
 */
await checkAsync("a token file is read by its contents, not by its extension", async () => {
  const dtcg = JSON.stringify({
    color: { brand: { $type: "color", $value: "#0b57d0" } },
    space: { md: { $type: "dimension", $value: "16px" } },
  })

  const spelled = "https://design.example.com/tokens/theme.tokens"
  const { result: fromExtension } = await readUrl(spelled, {
    [spelled]: { status: 200, headers: { "content-type": "application/octet-stream" }, body: dtcg },
  })
  assert.equal(fromExtension.error, "")
  assert.equal(fromExtension.detail, "1 color · 1 spacing step")

  const endpoint = "https://api.example.com/v1/design/tokens"
  const { result: fromApi } = await readUrl(endpoint, {
    [endpoint]: { status: 200, headers: { "content-type": "application/json" }, body: dtcg },
  })
  assert.equal(fromApi.error, "")
  assert.equal(fromApi.detail, "1 color · 1 spacing step")
})

/*
 * A SPLIT TOKEN BUILD IS ONE DESIGN SYSTEM, and reading the first file and
 * stopping turned it into a third of one.
 *
 * Style Dictionary's per-category CSS output is a file per axis — `color.css`,
 * `size.css`, `radius.css` — and it is not an unusual configuration;
 * `@primer/primitives` and `@spectrum-css` both publish in that shape. Read
 * first-sheet-wins, the page gave up three colours and reported no spacing and
 * no radii at all, which is indistinguishable from a system that has none: the
 * spacing picker is empty and nothing says why.
 */
await checkAsync("a design system split across stylesheets is merged, not truncated", async () => {
  const origin = "https://tokens.example.com"
  const url = `${origin}/docs/color`
  const { result } = await readUrl(url, {
    [url]: html(`<!doctype html><html><head><title>Tokens</title>
<link rel="stylesheet" href="/css/color.css">
<link rel="stylesheet" href="/css/size.css">
<link rel="stylesheet" href="/css/radius.css"></head><body></body></html>`),
    [`${origin}/css/color.css`]: css(
      ":root{--color-blue-500:#0969da;--color-neutral-100:#f6f8fa;--color-green-500:#1a7f37}"
    ),
    [`${origin}/css/size.css`]: css(":root{--size-space-4:4px;--size-space-8:8px;--size-space-16:16px}"),
    [`${origin}/css/radius.css`]: css(":root{--radius-small:3px;--radius-medium:6px;--radius-large:12px}"),
  })
  assert.equal(result.error, "")
  assert.equal(result.catalog.colors.length, 3)
  assert.equal(result.catalog.spacing.length, 3, "the second stylesheet was fetched and discarded")
  assert.equal(result.catalog.radii.length, 3, "the third stylesheet was fetched and discarded")
})

/*
 * THE DOCUMENTATION FRAMEWORK'S THEME IS NOT THE DESIGN SYSTEM, and on a
 * Docusaurus site it is the first stylesheet the page links.
 *
 * Infima is Docusaurus's own theme and it ships a complete, plausible set of
 * `--ifm-*` variables in `:root`. First-sheet-wins therefore answered every
 * Docusaurus-published design system with Infima's palette — a well-formed
 * catalog of the wrong thing, with nothing in it to suggest the product's own
 * tokens were sitting in the very next link. Bootstrap 5.3's hundred-odd
 * `--bs-*` variables do the same to any page that loads it first.
 *
 * Merging alone would not fix this: the two namespaces do not collide, so both
 * would simply appear and the designer would find a docs theme mixed into their
 * palette. A sheet that is almost entirely one framework's namespace is
 * therefore a separate, lower answer — used only when there is no other.
 */
await checkAsync("a docs framework's own theme loses to the product's tokens", async () => {
  const origin = "https://docs.example.com"
  const url = `${origin}/design/components/button`
  const { result } = await readUrl(url, {
    [url]: html(`<!doctype html><html><head><title>Button</title>
<link rel="stylesheet" href="/assets/css/styles.1a2b3c.css">
<link rel="stylesheet" href="/assets/css/custom.3c4d5e.css"></head><body></body></html>`),
    [`${origin}/assets/css/styles.1a2b3c.css`]: css(
      ":root{--ifm-color-primary:#3578e5;--ifm-color-primary-dark:#306cce;" +
        "--ifm-color-primary-darker:#2d66c3;--ifm-color-primary-light:#538ce9;" +
        "--ifm-color-emphasis-100:#f5f6f7;--ifm-background-color:#ffffff;" +
        "--ifm-spacing-horizontal:1rem;--ifm-global-radius:0.4rem;" +
        "--ifm-font-size-base:100%;--ifm-line-height-base:1.65}"
    ),
    [`${origin}/assets/css/custom.3c4d5e.css`]: css(
      ":root{--acme-color-brand:#0b57d0;--acme-color-surface:#faf9f9;" +
        "--acme-space-md:16px;--acme-radius-md:12px}"
    ),
  })
  assert.equal(result.error, "")
  assert.deepEqual(
    result.catalog.colors.map((color) => color.name).sort(),
    ["brand", "surface"],
    "the documentation framework's palette reached the picker"
  )
})

/*
 * THE CAP USED TO BITE BEFORE THE RIGHT SHEET WAS REACHED. Modelled on a real
 * twelve-link page: a vendor bundle, a `print` sheet, a dark-only sheet, eight
 * build chunks, and `tokens.css` last.
 *
 * Collecting six links and fetching those six meant the budget was spent on
 * chunks before `tokens.css` was even a candidate — and a `media="print"` sheet
 * outranked it, which is absurd on its face: a print stylesheet is by
 * definition not the palette anybody designs against, and its `--color-bg:#ccc`
 * is a value that must never reach a swatch.
 *
 * Collecting widely and ranking before spending the budget is what makes the
 * twelfth link reachable. The dark-only sheet is real CSS and is not dropped
 * for being wrong, only sorted behind the default palette, where it cannot
 * overwrite `--color-bg`.
 */
await checkAsync("print and dark sheets never outrank the token sheet", async () => {
  const origin = "https://kit.example.com"
  const url = `${origin}/docs/button`
  const chunks = Array.from(
    { length: 8 },
    (_, index) => `<link rel="stylesheet" href="/chunk-${index + 1}.css">`
  ).join("\n")
  const routes = {
    [url]: html(`<!doctype html><html><head><title>Kit</title>
<link rel="stylesheet" href="/vendor.css">
<link rel="stylesheet" media="print" href="/print.css">
<link rel="stylesheet" media="(prefers-color-scheme: dark)" href="/dark.css">
${chunks}
<link rel="stylesheet" href="/tokens.css"></head><body></body></html>`),
    [`${origin}/vendor.css`]: css(".a{color:red}"),
    [`${origin}/print.css`]: css(":root{--color-bg:#cccccc;--color-ink:#000;--space-md:0;--radius-md:0}"),
    [`${origin}/dark.css`]: css(":root{--color-bg:#000000;--color-night:#111;--space-md:8px;--radius-md:4px}"),
    [`${origin}/tokens.css`]: css(
      ":root{--color-bg:#ffffff;--color-brand:#0b57d0;--space-md:16px;--radius-md:12px}"
    ),
  }
  for (let index = 1; index <= 8; index += 1) {
    routes[`${origin}/chunk-${index}.css`] = css(`.c${index}{display:block}`)
  }

  const { result, asked } = await readUrl(url, routes)
  assert.equal(result.error, "")
  assert.ok(asked.includes(`${origin}/tokens.css`), "the twelfth link was never reached")
  assert.ok(!asked.includes(`${origin}/print.css`), "a print stylesheet was fetched")
  const background = result.catalog.colors.find((color) => color.name === "bg")
  assert.equal(background?.values.light, "#ffffff", "a print or dark value became the default")
})

/*
 * THE AGGREGATE ENTRY FILE, which is how the biggest published systems ship.
 *
 * `@primer/primitives` and `@spectrum-css` both publish an `index.css` whose
 * entire body is `@import` lines, and so does every Style Dictionary build
 * configured to emit one file per category. Followed no further, that file has
 * no custom properties in it at all — so the page linking it read as a page
 * with no design system, while pointing directly at one.
 *
 * One level, and SAME-ORIGIN. An `@import` is a URL inside a file, one step
 * further from anything the designer looked at, and the editor may be holding a
 * session cookie for the pasted host; a CDN import is not followed even though
 * following it would produce a better catalog.
 */
await checkAsync("one level of @import is followed, and never off-origin", async () => {
  const origin = "https://spectrum.example.com"
  const url = `${origin}/page/tokens`
  const { result, asked } = await readUrl(url, {
    [url]: html(
      '<!doctype html><html><head><link rel="stylesheet" href="/css/index.css"></head><body></body></html>'
    ),
    [`${origin}/css/index.css`]: css(
      '@import "./color.css";\n@import url("./dimension.css");\n' +
        '@import "https://cdn.other.example/reset.css";\n'
    ),
    [`${origin}/css/color.css`]: css(
      ":root{--spectrum-blue-500:#0265dc;--spectrum-gray-100:#f8f8f8;--spectrum-red-500:#d31510}"
    ),
    [`${origin}/css/dimension.css`]: css(
      ":root{--spectrum-spacing-100:8px;--spectrum-spacing-200:12px;--spectrum-corner-radius-medium:8px}"
    ),
  })
  assert.equal(result.error, "")
  assert.equal(result.catalog.colors.length, 3, "the imported colour file was not followed")
  assert.equal(result.catalog.spacing.length, 2, "the imported dimension file was not followed")
  const offOrigin = asked.filter((entry) => !entry.startsWith(origin))
  assert.deepEqual(offOrigin, [], `followed a cross-origin @import: ${offOrigin.join(", ")}`)

  // And the same entry file pasted DIRECTLY, which is the shorter path to the
  // same place and reaches this code from the other side: the pasted document
  // is the sheet, so nothing linked it and nothing would have asked it what it
  // imports.
  const { result: pasted } = await readUrl(`${origin}/css/index.css`, {
    [`${origin}/css/index.css`]: css('@import "./color.css";\n@import url("./dimension.css");\n'),
    [`${origin}/css/color.css`]: css(
      ":root{--spectrum-blue-500:#0265dc;--spectrum-gray-100:#f8f8f8;--spectrum-red-500:#d31510}"
    ),
    [`${origin}/css/dimension.css`]: css(
      ":root{--spectrum-spacing-100:8px;--spectrum-spacing-200:12px;--spectrum-corner-radius-medium:8px}"
    ),
  })
  assert.equal(pasted.error, "")
  assert.equal(pasted.catalog.colors.length, 3)
  assert.equal(pasted.catalog.spacing.length, 2)
})

/*
 * CSS THE DOCUMENT CARRIES ITSELF. Tailwind v4 declares a design system in
 * `@theme`, and a framework that inlines critical CSS puts that block straight
 * into the page — as does Storybook's `preview-head.html`, and Astro's global
 * styles. Scanning `<link>` only, every one of those is a page with no
 * stylesheets, which is the one outcome that reads as the site's fault.
 */
await checkAsync("tokens declared in an inline <style> block are read", async () => {
  const url = "https://site.example.com/design/button"
  const { result } = await readUrl(url, {
    [url]: html(`<!doctype html><html><head><title>Button</title>
<style>@theme{--color-brand:#ff5722;--color-ink:#111827;--spacing-4:1rem;--radius-lg:12px}</style>
</head><body></body></html>`),
  })
  assert.equal(result.error, "")
  assert.deepEqual(
    result.catalog.colors.map((color) => color.name),
    ["brand", "ink"]
  )
  assert.equal(result.catalog.radii.length, 1)
})

/*
 * `rel="preload" as="style"` is a stylesheet link by another name, and on a
 * Gatsby build it is sometimes the ONLY one in the served markup: the real
 * `<link rel=stylesheet>` is inserted by script this module never runs, with
 * the `<noscript>` copy as the fallback for a reader that is not a browser.
 */
await checkAsync("a preloaded stylesheet counts as a stylesheet", async () => {
  const origin = "https://gatsby.example.com"
  const url = `${origin}/docs/card`
  const { result } = await readUrl(url, {
    [url]: html(`<!doctype html><html><head>
<link rel="preload" as="style" href="/styles.abc.css"></head><body></body></html>`),
    [`${origin}/styles.abc.css`]: css(
      ":root{--color-primary:#663399;--color-text:#232129;--space-5:1rem;--radius-2:8px}"
    ),
  })
  assert.equal(result.error, "")
  assert.deepEqual(
    result.catalog.colors.map((color) => color.name),
    ["primary", "text"]
  )
})

/*
 * `<base href>` MOVES WHAT A RELATIVE LINK MEANS, and a reading that ignores it
 * asks for every stylesheet in the wrong directory. A docs build served from a
 * sub-path commonly declares one so the same markup works wherever it is
 * mounted.
 *
 * What it must NOT move is what "same-origin" means. A document declaring a
 * base on another host would otherwise make every relative link on the page
 * same-origin by its own say-so — the credential rule rewritten by the document
 * it exists to be careful of — so the origin test stays pinned to the URL the
 * designer pasted.
 */
await checkAsync("a <base href> is honoured for resolution and ignored for origin", async () => {
  const origin = "https://handbook.example.com"
  const url = `${origin}/docs/button`
  const { result } = await readUrl(url, {
    [url]: html(`<!doctype html><html><head><base href="/build/">
<link rel="stylesheet" href="tokens.css"></head><body></body></html>`),
    [`${origin}/build/tokens.css`]: css(
      ":root{--color-brand:#0b57d0;--color-ink:#1f1f1f;--space-md:16px;--radius-md:8px}"
    ),
  })
  assert.equal(result.error, "")
  assert.deepEqual(
    result.catalog.colors.map((color) => color.name),
    ["brand", "ink"],
    "the base href was ignored, so every link resolved to the wrong directory"
  )

  const { asked } = await readUrl(`${origin}/docs/card`, {
    [`${origin}/docs/card`]: html(`<!doctype html><html><head><base href="https://cdn.other.example/">
<link rel="stylesheet" href="tokens.css"></head><body></body></html>`),
  })
  const offOrigin = asked.filter((entry) => !entry.startsWith(origin))
  assert.deepEqual(offOrigin, [], `a base href widened the origin rule: ${offOrigin.join(", ")}`)
})

/*
 * LADLE publishes a story index too, under a different filename and with the
 * title pre-split. `ladle build` writes `meta.json`, whose `stories` map keys
 * `levels: ["forms", "text field"]` where Storybook would write
 * `title: "Forms/Text field"`. Neither the filename nor the key was known here,
 * so every deployed Ladle fell through to the page parse and produced one
 * component guessed from the URL.
 */
await checkAsync("a Ladle meta.json reads as the same catalog a Storybook would", async () => {
  const url = "https://ladle.example.com/"
  const { result } = await readUrl(url, {
    "https://ladle.example.com/meta.json": json({
      stories: {
        "colored-button--basic": {
          levels: ["colored-button"],
          name: "basic",
          entry: "src/colored-button.stories.tsx",
        },
        "colored-button--another": {
          levels: ["colored-button"],
          name: "another",
          entry: "src/colored-button.stories.tsx",
        },
        "forms-text-field--default": {
          levels: ["forms", "text field"],
          name: "default",
          entry: "src/text-field.stories.tsx",
        },
      },
    }),
  })
  assert.equal(result.error, "")
  assert.equal(result.detail, "2 components · 3 variants")
  const [button, field] = result.catalog.components
  assert.deepEqual(button.props?.[0].values, ["basic", "another"])
  assert.equal(field.name, "text field")
  assert.equal(field.group, "forms")
  assert.equal(field.file, "src/text-field.stories.tsx")
})

/*
 * HISTOIRE keeps its preview in `__sandbox.html`, a filename nobody would
 * guess and the only document on the origin that carries the product's CSS.
 * Asking only for `iframe.html` and `preview.html`, the reading falls back to
 * the shell and answers with Histoire's own `--htw-*` interface theme — the
 * exact failure the preview-before-shell rule exists to prevent, reached by a
 * filename rather than by a decoy.
 */
await checkAsync("Histoire's sandbox is a preview document, and beats the shell", async () => {
  const origin = "https://histoire.example.com"
  const url = `${origin}/story/src-button-story-vue`
  const shell = html(`<!doctype html><html><head><title>Histoire</title>
<link rel="stylesheet" href="/assets/histoire.css"></head><body><div id="app"></div></body></html>`)
  const { result } = await readUrl(
    url,
    {
      [url]: shell,
      [`${origin}/__sandbox.html`]: html(
        '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head><body></body></html>'
      ),
      [`${origin}/assets/app.css`]: css(
        ":root{--color-accent:#10b981;--color-surface:#fafafa;--space-md:12px;--radius-md:10px}"
      ),
      [`${origin}/assets/histoire.css`]: css(
        ":root{--htw-color-primary:#6366f1;--htw-color-gray-50:#f9fafb;--htw-space-2:8px;--htw-radius:4px}"
      ),
    },
    shell
  )
  assert.equal(result.error, "")
  assert.deepEqual(
    result.catalog.colors.map((color) => color.name).sort(),
    ["accent", "surface"],
    "read the tool's own interface theme instead of the sandbox's"
  )
})

/*
 * A COMPOSED STORYBOOK'S CATALOG IS IN OTHER STORYBOOKS, and its own index is
 * an empty file that parses perfectly — the worst shape of failure, because it
 * looks like an answer. An organisation publishing one address in front of
 * several team Storybooks got a row reporting zero components.
 *
 * The refs are in the built manager HTML as `window['REFS']`, each with a
 * `url`. Same-origin only: a ref is somebody else's string in somebody else's
 * build output, and "the editor fetched a third-party host because a page told
 * it to" is not a thing to be talked into by a `<script>` tag.
 */
await checkAsync("a composed Storybook is read through its refs", async () => {
  const origin = "https://sb.example.net"
  const url = `${origin}/`
  const { result, asked } = await readUrl(url, {
    [url]: html(`<!doctype html><html><head><title>Storybook</title></head>
<body><div id="root"></div>
<script>window['REFS'] = {"design-system":{"id":"design-system","url":"${origin}/design-system","title":"Design System"},"partner":{"id":"partner","url":"https://other.example.org/storybook","title":"Partner"}};</script>
</body></html>`),
    [`${origin}/index.json`]: json({ v: 5, entries: {} }),
    [`${origin}/design-system/index.json`]: json(INDEX_V4),
  })
  assert.equal(result.error, "")
  assert.deepEqual(
    result.catalog.components.map((component) => component.name),
    ["Avatar", "Badge"]
  )
  const offOrigin = asked.filter((entry) => !entry.startsWith(origin))
  assert.deepEqual(offOrigin, [], `followed a cross-origin ref: ${offOrigin.join(", ")}`)
})

/*
 * The failure this feature would otherwise ship. Every probe and the page
 * itself answer 200 with the login page, so nothing here is an HTTP error —
 * the only thing standing between the designer and a design system made of
 * somebody's sign-in form is the body sniff.
 */
await checkAsync("a walled URL parses to an empty catalog and a sentence, not a login page", async () => {
  const nothing = await parseUrlLibrary(STORYBOOK_URL, offline({}))
  assert.equal(nothing.catalog.components.length, 0)
  assert.equal(nothing.auth, null, "a 404 is not a sign-in wall")

  const walled = await parseUrlLibrary(STORYBOOK_URL, {
    fetchImpl: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      text: async () => LOGIN_PAGE,
    }),
    runHelper: noHelper,
  })
  assert.equal(walled.catalog.components.length, 0)
  assert.equal(walled.auth.kind, "redirect")
  assert.equal(walled.auth.origin, STORYBOOK_ORIGIN)
  assert.match(walled.error, /sign-in/i)
  assert.match(walled.error, /public URL/)
})

// ── The store ──────────────────────────────────────────────────────────────

console.log("\nWhat the store does with a URL")

/** A throwaway project, so the pointer file has somewhere real to live. */
async function project(urlOptions) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "de-library-url-")))
  await fs.writeFile(
    path.join(root, "package.json"),
    '{ "name": "temp-host", "version": "0.0.0" }\n',
    "utf8"
  )
  const config = resolveConfig({ projectRoot: root }, { cwd: root })
  return {
    config,
    store: createLibraryStore(config, urlOptions),
    stateFile: path.join(config.stateDir, "libraries.json"),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

/** The pointer file as it is on disk, or `[]` when nothing has written it. */
async function storedLibraries(context) {
  try {
    const parsed = JSON.parse(await fs.readFile(context.stateFile, "utf8"))
    return Array.isArray(parsed?.libraries) ? parsed.libraries : []
  } catch {
    return []
  }
}

/*
 * A sign-in wall is the one URL failure that is REFUSED rather than installed,
 * and the distinction is worth stating because the two neighbours go the other
 * way. A URL that times out or answers 500 gets a row: those reasons change
 * while the editor is open, and the row is what carries the retry and the
 * removal. A URL behind a wall gets nothing, because a row named after a site
 * and reporting zero components is a lie in the only way that matters — a
 * designer reading it concludes their design system is empty when the truth is
 * that they are signed out.
 *
 * So the refusal has to carry the challenge with it: `error.auth` is what lets
 * the panel offer a way in instead of just reporting a failure.
 */
await checkAsync("an SSO-walled URL is refused, and never reaches the list", async () => {
  const context = await project(offline({ [STORYBOOK_URL]: html(LOGIN_PAGE) }))
  try {
    await assert.rejects(context.store.add({ url: STORYBOOK_URL }), (error) => {
      assert.equal(error.statusCode, 400)
      assert.match(error.message, /sign-in/i)
      assert.equal(error.auth.kind, "redirect")
      assert.equal(error.auth.origin, STORYBOOK_ORIGIN)
      assert.equal(error.auth.url, STORYBOOK_URL)
      assert.ok(error.auth.hint, "a challenge with no hint gives the panel nothing to say")
      return true
    })

    // Nothing in the answer, and nothing in the file behind it.
    assert.deepEqual((await context.store.list()).libraries, [])
    assert.deepEqual(await storedLibraries(context), [])
  } finally {
    await context.cleanup()
  }
})

/*
 * The neighbouring case, so the rule above reads as a line and not as a blanket
 * refusal: a URL the editor could reach and could not understand is installed,
 * with its sentence on it.
 */
await checkAsync("a URL that answered with nothing useful is installed anyway", async () => {
  // A bare origin serving a home page: reachable, readable, and not a design
  // system. There is no component to read off a path with no segments in it.
  const homepage = "https://docs.example.org/"
  const context = await project(
    offline({ [homepage]: html("<!doctype html><html><body><h1>Welcome</h1></body></html>") })
  )
  try {
    const { library } = await context.store.add({ url: homepage })
    assert.equal(library.source.kind, URL_SOURCE_KIND)
    assert.equal(library.source.path, homepage)
    assert.equal(library.enabled, true)
    assert.ok(library.error, "a library that read as nothing said nothing about it")
    assert.doesNotMatch(library.error, /sign-in/i)
    assert.deepEqual(
      Object.values(library.counts).filter((count) => count !== 0),
      []
    )

    // And it survives a round trip through the pointer file, error included.
    const { libraries } = await context.store.list()
    assert.equal(libraries.length, 1)
    assert.equal(libraries[0].source.path, homepage)
    assert.ok(libraries[0].error)
  } finally {
    await context.cleanup()
  }
})

await checkAsync("a URL library caches its catalog and refreshes on request", async () => {
  let served = json(INDEX_V4)
  const context = await project({
    fetchImpl: async (url) => {
      const recorded =
        String(url) === `${STORYBOOK_ORIGIN}/atlas/index.json`
          ? served
          : { status: 404, headers: { "content-type": "text/html" }, body: "" }
      return {
        status: recorded.status,
        headers: recorded.headers,
        text: async () => recorded.body,
      }
    },
    runHelper: noHelper,
  })
  try {
    const { library } = await context.store.add({ url: STORYBOOK_URL })
    assert.equal(library.counts.components, 2)
    assert.equal(library.detail, "2 components · 3 variants")

    // The catalog is IN the file: this is the one kind that is not re-parsed on
    // every `list()`, because re-reading it means a network round trip.
    const stored = JSON.parse(await fs.readFile(context.stateFile, "utf8"))
    assert.equal(stored.libraries[0].catalog.components.length, 2)

    // So the site changing under the editor is invisible until somebody asks.
    served = json({ v: 5, entries: {} })
    assert.equal((await context.store.list()).libraries[0].counts.components, 2)

    const refreshed = await context.store.update(library.id, { refresh: true })
    assert.equal(refreshed.library.counts.components, 0)
    assert.ok(refreshed.library.error, "a refresh that found nothing said nothing about it")
    assert.match(refreshed.library.error, /Check the address/)
  } finally {
    await context.cleanup()
  }
})

await checkAsync("a url is refused when it is not one, and the same page adds once", async () => {
  const context = await project(offline({ [DOCS_URL]: html(DOCS_PAGE) }))
  try {
    await assert.rejects(context.store.add({ url: "ftp://example.com/tokens.json" }), (error) => {
      assert.equal(error.statusCode, 400)
      assert.match(error.message, /https?:\/\//)
      return true
    })

    const first = await context.store.add({ url: DOCS_URL })
    const again = await context.store.add({ url: DOCS_URL })
    assert.equal(first.library.id, again.library.id)
    assert.equal((await context.store.list()).libraries.length, 1)

    // `url` is a kind, but it is not a kind a PATH can be.
    await assert.rejects(
      context.store.add({ path: "package.json", kind: "url" }),
      (error) => error.statusCode === 400
    )
  } finally {
    await context.cleanup()
  }
})

/*
 * ADDING THE SAME LINK AGAIN RE-READS IT, and that is the only way back from a
 * catalog that is out of date.
 *
 * A URL library's catalog is a snapshot taken when it was added — re-fetching
 * every URL on every `list()` would put somebody else's network on the panel's
 * hot path. So a row can be wrong and stay wrong, and the case that matters is
 * not "the site changed" but "the editor's own reading improved": a
 * stylesheet-parsing fix landed and left every row added before it reporting
 * nothing, with no gesture in the panel that would renew one.
 *
 * Re-pasting is that gesture. The row must keep its identity while its contents
 * move, so both halves are asserted — one library, new tokens.
 */
await checkAsync("re-adding a URL renews its catalog without adding a second row", async () => {
  const empty = "<!doctype html><html><head><title>Kit</title></head><body></body></html>"
  const withTokens =
    "<!doctype html><html><head><title>Kit</title>" +
    '<link rel="stylesheet" href="/kit.css"></head><body></body></html>'
  const PAGE = "https://kit.example.com/docs/button"
  let serving = empty

  const context = await project({
    fetchImpl: async (url) => {
      const target = String(url)
      const body =
        target === PAGE
          ? serving
          : target === "https://kit.example.com/kit.css"
            ? ":root{--color-brand:#123456;--color-ink:#000;--radius-md:8px}"
            : ""
      return {
        status: body ? 200 : 404,
        headers: new Headers({
          "content-type": target.endsWith(".css") ? "text/css" : "text/html",
        }),
        text: async () => body,
      }
    },
    runHelper: noHelper,
  })
  try {
    const first = await context.store.add({ url: PAGE })
    assert.equal(first.library.catalog.colors.length, 0, "the fixture started with tokens")

    // The site — or the editor's reading of it — improves.
    serving = withTokens
    const again = await context.store.add({ url: PAGE })

    assert.equal(again.library.id, first.library.id, "re-adding made a different library")
    assert.equal((await context.store.list()).libraries.length, 1, "re-adding grew the list")
    assert.deepEqual(
      again.library.catalog.colors.map((color) => color.name).sort(),
      ["brand", "ink"],
      "re-adding handed back the stale catalog instead of re-reading"
    )

    /*
     * And a re-read that FAILS keeps what was working. Losing a good catalog to
     * one flaky moment would make this gesture something to avoid using.
     */
    serving = ""
    const afterFailure = await context.store.add({ url: PAGE })
    assert.equal(
      afterFailure.library.catalog.colors.length,
      2,
      "a failed re-read threw away the tokens that were already there"
    )
  } finally {
    await context.cleanup()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
