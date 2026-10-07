/**
 * The Design system tab: the libraries you can draw from, and the audit that
 * says where you did not.
 *
 * It replaces `assets-panel-cases.mjs`, which tested a surface that no longer
 * exists. The Assets browser — the component grid, the cards, the thumbnails,
 * the group drill-down, the search box, the details popover and "Insert
 * instance" — is gone by request, and the library manager it opened is now a
 * `section()` on the right panel beside the audit. So the cases here are not a
 * port of that file's cases; they are the claims the new surface has to keep,
 * and one claim about what it must NOT have grown back.
 *
 * Bundled with esbuild and run in JSDOM against a stubbed `fetch`, the same
 * harness `library-panel-cases.mjs` and `lint-marker-cases.mjs` use, and for
 * the same reason: what is under test is what the CLIENT does with a library
 * payload, and a real server would only add a second thing that can fail while
 * proving nothing about the section.
 *
 * What each case guards, and why losing it would be SILENT:
 *
 *  - **a row per library, saying what it contains.** The counts line is the
 *    only thing on the surface that distinguishes a design system the server
 *    parsed from a file it merely pointed at. A row that lost it still looks
 *    like a row, and a designer reads a library with nothing in it as a library
 *    that is simply off;
 *  - **the browsing UI did not survive the move.** This is the case with the
 *    shortest half-life: a grid, a card or an insert button reappearing here is
 *    exactly what a later change "restoring" the assets panel would do, and
 *    nothing else in the suite would notice. It is asserted as the ABSENCE of
 *    the three hooks that surface owned;
 *  - **the URL CTA posts `{url}` and surfaces a refusal in the server's own
 *    words.** Both halves fail invisibly. A field that never posts reads as a
 *    link that failed to parse; a failure reported as "HTTP 400" instead of the
 *    sentence the route wrote is the difference between a user who can fix
 *    their mistake and one who cannot. So the body of the POST is asserted, and
 *    so is the exact sentence the stub refuses with;
 *  - **the field survives a repaint.** The list rebuilds on every store beat,
 *    including the beat a switch fires, and a CTA rebuilt with it eats a
 *    half-typed URL. Asserted by toggling an unrelated library mid-typing and
 *    reading the field back;
 *  - **a walled link offers a way in, and the way in completes the errand.**
 *    Five claims, and every one of them fails quietly. A refusal that carries a
 *    challenge and draws nothing is a dead end wearing a toast; a wall that
 *    names an OAuth client id or a realm and does not print it withholds the
 *    only two strings a designer cannot look up for themselves; a credential
 *    box that is not a password field puts a bearer token into somebody's
 *    screen recording; a refusal that clears the box sends the designer back to
 *    a terminal for a string they already had; and a sign-in that does not
 *    replay the add leaves them to re-paste a URL the editor is still holding.
 *    The suite asserts the ORDER of the two posts for that last one, because
 *    "signed in" and "added" both being true says nothing about whether the
 *    second happened by itself;
 *  - **the way in is a MODAL, and it behaves like one.** A wall stops the add,
 *    and it used to be answered by a well that unfolded in a 260px column with
 *    the whole panel still live behind it. It is a real `<dialog>` opened with
 *    `showModal()` now, which is where the top layer, the focus trap and the
 *    inertness come from — so the suite pins the element itself, that it is
 *    parked on `document.body` rather than inside a section that can be folded
 *    shut over it, that focus arrives on the card and goes back to the control
 *    that opened it, that dismissing takes the token with it, and that Escape
 *    marks the press spent. That last one is the subtlest: Escape is also the
 *    key that stands the editor down, so a dialog that closed without
 *    cancelling the event would dismiss itself and collapse the chrome on one
 *    press;
 *  - **the first screen of that modal has no jargon on it, and the cases are
 *    written as an ABSENCE.** The dialog used to open on "Sign-in redirect ·
 *    https://…", a Bearer/Cookie rail and a box asking for a Cookie header —
 *    all accurate, all addressed to the wrong reader. It now leads with the
 *    host, what the site wants of them in plain words, and the one fact nobody
 *    guesses: the editor fetches links from its own process, so the session
 *    they have with that site in this browser does not carry. Every protocol
 *    term lives behind an "I have an access token" fold. A register is only
 *    pinnable as an absence — a future "let's say which kind of sign-in it is"
 *    would pass every functional case in this file, because the controls it
 *    drives are all still there, one press down. So the visible text is read
 *    with `[hidden]` subtrees stripped and asserted to contain none of them;
 *  - **four plain sentences for five wall kinds, and the merges carry weight.**
 *    OAuth and a login bounce are one experience from outside and collapse
 *    together; HTTP Basic stays apart because a password is something a reader
 *    may already hold; and a 403 stays apart because it is the one refusal
 *    signing in does not fix — the editor got in and was turned away, so a
 *    dialog telling that reader to sign in sends them round a loop;
 *  - **each wall is named by its MECHANISM, and offers the right credential
 *    first.** The server classifies a refusal by HTTP and OAuth alone, and the
 *    panel's labels have to stay that generic or they describe one company's
 *    stack and mislead about every other. Asserted against three of the five
 *    kinds, each with the credential it should preselect;
 *  - **nothing claims a sign-in the server did not grant.** The list of signed-
 *    in origins is drawn only from what `GET`/`POST /libraries/auth` answered.
 *    Asserted from the refusal case: a rejected credential must leave the list
 *    exactly as empty as it was;
 *  - **DS Lint is a section, with its hooks intact.** The panel was re-housed,
 *    not rewritten: the audit button, the summary, the finding rows and the
 *    footer keep their `data-de-lint` hooks, and `lint-marker-cases.mjs` is
 *    what proves they still behave. What THIS file pins is the housing — a real
 *    `.de-section` whose title is "DS lint" — because the old bespoke header is
 *    the thing a re-housing is most likely to leave behind;
 *  - **the tab renders both, in that order.** Libraries is the vocabulary and
 *    the audit is the list of places the page does not use it. A tab that
 *    rendered them the other way round would work perfectly and read backwards.
 *
 * The fixtures are invented: two synthetic libraries, one candidate file for
 * the project scan, and the parsed library the URL add answers with. They
 * exercise the SHAPES the real ones have without being anybody's real design
 * system.
 *
 * Usage: node designlayer/test/design-system-tab-cases.mjs
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// ── The world the bundle loads into ────────────────────────────────────────

const API = "/__designlayer"

globalThis.__DESIGNLAYER_CONFIG__ = {
  apiBase: API,
  designSystem: {
    name: "Host",
    trackingUnit: "em",
    colors: [],
    spacing: [],
    radii: [],
    textStyles: [],
    uiTextStyles: [],
    effects: [],
    icons: [],
    motion: [],
    responsiveMeasures: [],
    aliases: { cssVariables: [], tailwind: [] },
  },
  icons: { attribute: "", available: false },
  host: { framework: "react", tailwind: true },
}

const dom = new JSDOM(
  '<!doctype html><html><body><main id="app"><button id="cta">Go</button></main></body></html>',
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom
window.document.elementsFromPoint = () => []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
}
window.Element.prototype.scrollIntoView = function scroll() {}
for (const name of ["setPointerCapture", "releasePointerCapture"]) {
  window.Element.prototype[name] = function capture() {}
}
window.Element.prototype.hasPointerCapture = function held() {
  return false
}
globalThis.DOMMatrixReadOnly = class {
  constructor() {
    this.m41 = 0
    this.m42 = 0
  }
}
for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement",
  "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLButtonElement",
  "SVGElement", "SVGSVGElement",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, {
    value: key === "getComputedStyle" ? window.getComputedStyle.bind(window) : window[key],
    configurable: true,
    writable: true,
  })
}

// ── Two invented libraries, and what a URL add answers with ────────────────

const emptyCatalog = (name) => ({
  name,
  trackingUnit: "em",
  colors: [],
  spacing: [],
  radii: [],
  textStyles: [],
  uiTextStyles: [],
  effects: [],
  icons: [],
  motion: [],
  components: [],
  iconDrawings: [],
  iconAttribute: "",
})

const noCounts = {
  colors: 0, spacing: 0, radii: 0, textStyles: 0, effects: 0,
  icons: 0, motion: 0, components: 0, iconDrawings: 0,
}

/**
 * A token stylesheet, added from a path.
 *
 * Its counts are deliberately in three different groups, so the summary line
 * has to be a sentence built from them rather than one number: a row that
 * printed "48" would pass an assertion about colors and say nothing true.
 */
const PIER = {
  id: "src-pier-tokens",
  name: "Pier",
  enabled: true,
  source: { kind: "css", path: "src/pier/tokens.css" },
  addedAt: 1737100000000,
  counts: { ...noCounts, colors: 48, spacing: 12, components: 38 },
  catalog: emptyCatalog("Pier"),
}

/** A second library, off, so the switch has something to be pressed against. */
const BEACON = {
  id: "src-app-shared",
  name: "Beacon",
  enabled: false,
  source: { kind: "components", path: "src/app/shared" },
  addedAt: 1737100001000,
  counts: { ...noCounts, components: 2 },
  catalog: emptyCatalog("Beacon"),
}

/**
 * What a URL add answers with, and the one field that can only have come from
 * the server.
 *
 * `detail` is prose the client cannot derive: the counts on this record say
 * nothing about stories, and a section that wrote its own summary from them
 * would print "9 components" over a Storybook the server described completely
 * differently. That is the assertion the URL row is worth.
 */
const ORBIT = {
  id: "url-orbit",
  name: "Orbit",
  enabled: false,
  source: { kind: "manifest", path: "orbit", url: "https://orbit.example.com/storybook" },
  addedAt: 1737100002000,
  counts: { ...noCounts, components: 9 },
  detail: "9 components across 24 stories",
  catalog: emptyCatalog("Orbit"),
}

/** The one design-system file in this project the scan can find. */
const CANDIDATE = {
  path: "src/anchor/icons.svg",
  kind: "icons",
  name: "Anchor Icons",
  detail: "18 icon drawings",
  installed: false,
}

/** The sentence a refused add has to reach the user as, word for word. */
const REFUSAL = "https://nope.example.com does not serve a design system"

/**
 * A link behind a sign-in wall, and the challenge the server answers it with.
 *
 * Shaped exactly as `classifyWall` writes one for an OAuth redirect: the kind,
 * the origin, the `client_id` lifted out of the authorization request, an empty
 * realm because only a 401 has one, and the server's own hint. The audience is
 * the field this fixture exists for — it is one of the two strings in the whole
 * flow a designer has no way to look up, so a panel that receives it and does
 * not print it looks complete and is useless.
 */
const WALL = {
  kind: "oauth",
  origin: "https://vault.example.com",
  audience: "482913055217-8sfk2m1q9d7vb3ljxcpt0uwyh6razn4e.apps.example.com",
  realm: "",
  hint:
    "This site signs in through OAuth. Mint an identity token for the client id below and " +
    "paste it, or paste the site's session cookie from a browser that can already open it.",
  url: "https://vault.example.com/storybook",
}

/**
 * A Storybook behind an SSO proxy: the wall this whole flow exists
 * for, and the only fixture that exercises the provider-named button.
 *
 * Shaped after a real one and named after nobody. The hostname is a deployment
 * artefact of the kind a container platform hands out, the proxy bounces an
 * unauthenticated fetch to an identity provider on another origin, the
 * authorization request carries `response_type` and `client_id` per RFC 6749
 * §4.1.1, and the client id is the audience an identity token would have to be
 * minted for. Every value is invented; the SHAPE is what is under test.
 *
 * `login.microsoftonline.com` rather than the provider the real link used,
 * because the assertion is that `providerOf` reads the redirect and names
 * whoever is there — a fixture naming the first entry in the table could pass
 * against a function that returned a constant.
 *
 * Kept as a fixture rather than fetched: a test that needs the network is a
 * test that fails on a plane, and what is asserted here is how the panel READS
 * this shape.
 */
const PROXY_WALL = {
  kind: "oauth",
  origin: "https://storybook-3f81c0a2-ue.example.net",
  audience: "a1b2c3d4-5e6f-4071-8abc-9d0e1f2a3b4c",
  realm: "",
  location:
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=" +
    "a1b2c3d4-5e6f-4071-8abc-9d0e1f2a3b4c&response_type=code" +
    "&redirect_uri=https%3A%2F%2Fproxy.example.net%2Foauth%2FhandleRedirect" +
    "&scope=openid+email",
  hint:
    "This site signs in through OAuth. Mint an identity token for the client id below and " +
    "paste it, or paste the site's session cookie from a browser that can already open it.",
  url: "https://storybook-3f81c0a2-ue.example.net/acme/primitives/avatar",
}

/**
 * The other two walls the panel has to read differently, and why each is here.
 *
 * A 401 is the only refusal that carries a realm, so it is the only way to
 * exercise the second fact row — and it is also the one wall whose scheme the
 * wire cannot carry, since the credential union is bearer or cookie and neither
 * is `Authorization: Basic`. A plain sign-in redirect names nothing at all,
 * which is the case where a browser session is the likelier answer and the
 * block has to default to the cookie rather than to the token.
 */
const BASIC_WALL = {
  kind: "basic",
  origin: "https://mono.example.com",
  audience: "",
  realm: "Design tokens",
  hint:
    "This site asked for HTTP Basic authentication. Paste `user:password` base64-encoded, or a " +
    "token your provider issues in its place.",
  url: "https://mono.example.com/tokens.css",
}

const REDIRECT_WALL = {
  kind: "redirect",
  origin: "https://atlas.example.com",
  audience: "",
  realm: "",
  hint:
    "This site redirected to a sign-in page. Paste a bearer token it accepts, or its session " +
    "cookie from a browser that can already open it.",
  url: "https://atlas.example.com/storybook",
}

/**
 * The 403, and the reason the plain-language table has four sentences instead
 * of one.
 *
 * Every other wall is answered by signing in. This one was reached and turned
 * away, which means the identity the editor already has is not allowed to see
 * the page — so telling this reader to sign in sends them round a loop. It is
 * the one kind whose first screen must say something else.
 */
const FORBIDDEN_WALL = {
  kind: "forbidden",
  origin: "https://guarded.example.com",
  audience: "",
  realm: "",
  hint: "This site refused the request. A token with access to it should get through.",
  url: "https://guarded.example.com/tokens.json",
}

/** The sentence the refused ADD carries, beside the challenge. */
const WALLED = "vault.example.com asked this editor to sign in"

/**
 * The only credential this server accepts, and the sentence it refuses the rest
 * with.
 *
 * A single right answer rather than "any non-empty string", because the case
 * worth protecting is the WRONG one: the server verifies a credential against
 * the live site before storing it, so a stub that accepted anything would let a
 * panel that marks itself signed in optimistically pass every case here.
 */
const OPENS = "eyJhbGciOiJSUzI1NiJ9.a-real-looking-identity-token"
const BAD_CREDENTIAL =
  "The site refused that credential and still asked for sign-in. Check that it has not expired."

/** What the walled link resolves to once a credential opens it. */
const VAULT = {
  id: "url-vault",
  name: "Vault",
  enabled: false,
  source: { kind: "manifest", path: "vault", url: WALL.url },
  addedAt: 1737100003000,
  counts: { ...noCounts, components: 12 },
  detail: "12 components across 30 stories",
  catalog: emptyCatalog("Vault"),
}

/**
 * The server, as far as the client is concerned.
 *
 * It keeps state so a POST is visible to the next GET, and it records every
 * call — which is the only way the "the CTA posts `{url}`" case can be written,
 * because the claim is about the BODY of a request and nothing in the DOM
 * reports it.
 */
const server = {
  libraries: [],
  candidates: [],
  calls: [],
  /** Origins it holds a credential for — the shape `listOrigins` answers with,
   *  which is to say without the values. The secret never comes back out. */
  credentials: [],
  /** What a run of the sign-in window "produced"; see the route above. */
  signInOutcome: null,
  /**
   * A sign-in the stub HOLDS OPEN, which is how the waiting state is testable
   * at all.
   *
   * Every other route here answers in the same tick, and for the rest of the
   * flow that is right — what is under test is what the client does with a
   * payload. The window sign-in is the exception: the interesting states are
   * the ones that exist only while the request is outstanding, and on a real
   * machine that is up to six minutes of a person typing a password into a
   * browser. A gate is the only way to stand in the middle of it: the test
   * presses the button, looks at what the dialog became, and decides when — or
   * whether — the server ever answers.
   *
   * It honours `signal`, because the client's cancel is an abort and a stub
   * that ignored it would let a cancel "pass" while the request it claims to
   * have stopped was never told anything.
   */
  signInGate: null,
  /**
   * Whether the sign-in route answers the way a server a version BEHIND THE
   * PAGE does, which is not a rare case: the browser bundle is re-read on every
   * reload and the routes are loaded into the Node process once, at launch. Pull
   * a build that adds a route, reload, and the two halves disagree.
   */
  staleSignIn: false,
  /** Whether this machine claims a browser to open one in. */
  canOpenWindow: true,
  reset() {
    server.libraries = []
    server.candidates = []
    server.calls = []
    server.credentials = []
    server.signInOutcome = null
    server.signInGate = null
    server.staleSignIn = false
    server.canOpenWindow = true
  },
}

const clone = (value) => JSON.parse(JSON.stringify(value))

async function serve(input, init = {}) {
  const url = new URL(String(input), "http://localhost")
  const method = (init.method ?? "GET").toUpperCase()
  const rest = url.pathname.slice(API.length)
  const body = init.body ? JSON.parse(init.body) : null
  server.calls.push({ method, path: rest, body })

  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })

  if (rest === "/libraries" && method === "GET") {
    return reply({ libraries: clone(server.libraries) })
  }
  if (rest === "/libraries/available" && method === "GET") {
    return reply({ candidates: clone(server.candidates) })
  }
  /*
   * The add, both ways in. A link this server recognises comes back as a parsed
   * library; anything else is a 400 carrying a sentence, which is the whole of
   * the help a user gets at the moment of the mistake.
   */
  /*
   * Sign-in, tested BEFORE the `<id>` form below for the reason `routes.mjs`
   * orders itself the same way: `auth` satisfies the library-id pattern, so a
   * server that checked the id form first would answer every one of these with
   * "no such library" — which is exactly what this stub did before the flow
   * existed, and it is a failure the client cannot tell from an empty list.
   */
  /*
   * The window that opens the site's own sign-in, which is what the panel
   * offers first. Before the `/libraries/auth` block for the same ordering
   * reason that block gives: the exact-path test above it would never see this.
   *
   * `server.signInOutcome` is what a run of that window "produced", so a test
   * can play both the completed sign-in and the one somebody closed without
   * standing up a browser.
   */
  if (rest === "/libraries/auth/signin") {
    if (method === "GET") return reply({ available: server.canOpenWindow !== false })
    if (method === "POST") {
      const answer = (outcome) => {
        if (outcome.ok) {
          const record = { origin: WALL.origin, scheme: "cookie", addedAt: 1737100005000 }
          server.credentials = [
            ...server.credentials.filter((entry) => entry.origin !== record.origin),
            record,
          ]
          return reply({ ok: true, provider: "Okta", ...record })
        }
        // A closed window is a 200 carrying `ok: false`, not an error: the real
        // route reports it that way because changing your mind is not a fault.
        return reply({ ok: false, provider: "Okta", reason: outcome.reason })
      }
      if (server.staleSignIn) {
        // Verbatim what `routes.mjs` writes for a path it has never heard of:
        // correct for a developer, and the worst sentence in the codebase to
        // put in front of a designer.
        return {
          ok: false,
          status: 404,
          json: async () => ({
            message: "No designlayer route for POST /__designlayer/libraries/auth/signin",
          }),
        }
      }
      const gate = server.signInGate
      if (gate) {
        server.signInGate = null
        return new Promise((resolve, reject) => {
          gate.release = (outcome) => resolve(answer(outcome ?? { ok: true }))
          init.signal?.addEventListener("abort", () => {
            gate.aborted = true
            // The shape the platform rejects an aborted `fetch` with, name and
            // all: the client is expected to recognise it and say its own thing
            // rather than print "The operation was aborted" at a designer.
            const error = new Error("The operation was aborted.")
            error.name = "AbortError"
            reject(error)
          })
        })
      }
      return answer(server.signInOutcome ?? { ok: false, reason: "nothing configured" })
    }
  }

  if (rest === "/libraries/auth") {
    if (method === "GET") return reply({ origins: clone(server.credentials) })
    if (method === "POST") {
      /*
       * VERIFIED, not stored. The real route re-fetches the URL with the
       * credential attached and refuses to save one that does not open the
       * wall, so a 200 from here is the only thing entitled to make the panel
       * say a designer is signed in.
       */
      if (body?.value !== OPENS) {
        return { ok: false, status: 400, json: async () => ({ message: BAD_CREDENTIAL }) }
      }
      const record = { origin: WALL.origin, scheme: body.scheme, addedAt: 1737100004000 }
      server.credentials = [
        ...server.credentials.filter((entry) => entry.origin !== record.origin),
        record,
      ]
      return reply(clone(record))
    }
    if (method === "DELETE") {
      const before = server.credentials.length
      server.credentials = server.credentials.filter((entry) => entry.origin !== body?.origin)
      return reply({ forgotten: server.credentials.length !== before })
    }
  }

  if (rest === "/libraries" && method === "POST") {
    /*
     * The four walls that are only ever refused. They exist to be READ — which
     * plain sentence, which fact row, which credential offered first — so this
     * server never opens them, and nothing downstream has to unwind a sign-in
     * to them.
     */
    const other = [BASIC_WALL, REDIRECT_WALL, FORBIDDEN_WALL, PROXY_WALL].find(
      (wall) => wall.url === body?.url
    )
    if (other) {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          message: `${new URL(other.origin).host} asked this editor to sign in`,
          auth: clone(other),
        }),
      }
    }
    /*
     * The walled link, which answers two different ways depending on what this
     * server has been given. Refused with the challenge attached and NOTHING
     * written — the real store throws before it writes, because a walled row in
     * the panel is a library named after a site that reports zero colours.
     */
    if (body?.url === WALL.url) {
      if (!server.credentials.some((entry) => entry.origin === WALL.origin)) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ ok: false, message: WALLED, auth: clone(WALL) }),
        }
      }
      const library = clone(VAULT)
      server.libraries = [...server.libraries, library]
      return reply({ library: clone(library) })
    }
    if (body?.url === ORBIT.source.url) {
      const library = clone(ORBIT)
      server.libraries = [...server.libraries, library]
      return reply({ library: clone(library) })
    }
    if (body?.path === CANDIDATE.path) {
      const library = {
        ...clone(BEACON),
        id: "lib-anchor",
        name: "Anchor Icons",
        source: { kind: "icons", path: CANDIDATE.path },
        counts: { ...noCounts, iconDrawings: 18 },
        catalog: emptyCatalog("Anchor Icons"),
      }
      server.libraries = [...server.libraries, library]
      for (const candidate of server.candidates) {
        if (candidate.path === CANDIDATE.path) candidate.installed = true
      }
      return reply({ library: clone(library) })
    }
    return { ok: false, status: 400, json: async () => ({ message: REFUSAL }) }
  }
  // The audit, answered with nothing found: this file is about the section's
  // HOUSING, and `lint-marker-cases.mjs` owns what a finding does.
  if (rest === "/lint/tools") {
    return reply({ tools: [{ id: "stylelint", name: "Stylelint", available: true, reason: "" }] })
  }
  if (rest === "/lint/audit") {
    return reply({ findings: [], ignored: [], ranAt: Date.now() })
  }

  const keyed = /^\/libraries\/([a-z0-9-]+)(\/icons)?$/.exec(rest)
  if (keyed) {
    const library = server.libraries.find((entry) => entry.id === keyed[1])
    if (!library) return { ok: false, status: 404, json: async () => ({ message: "No such library" }) }
    if (keyed[2]) return reply({ attribute: library.catalog.iconAttribute, icons: [] })
    if (method === "PATCH") {
      Object.assign(library, body)
      return reply({ library: clone(library) })
    }
    if (method === "DELETE") {
      server.libraries = server.libraries.filter((entry) => entry.id !== library.id)
      return reply({ ok: true })
    }
  }

  return reply({})
}

globalThis.fetch = serve
window.fetch = serve

// ── The bundle ─────────────────────────────────────────────────────────────

/*
 * Every name here is one the module contract states. Nothing is imported on a
 * guess: one wrong export name is a bundle failure and a file of red lines
 * whose real cause is a typo.
 */
const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createContext } from "./src/core/context"
      export { librariesSection } from "./src/libraries/libraries-section"
      export { dsLintSection } from "./src/lint/panel"
      export { designSystemTab } from "./src/panels/inspector/tab-design-system"
      export { libraryList, refreshLibraries } from "./src/libraries/store"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "silent",
})
const editor = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

/** Enough turns of the loop for a fetch, a notify and a repaint to land. */
async function settle(turns = 6) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 0)))
  }
}

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}

/** Every toast the editor raised, so a refusal can be read as words. */
const toasts = []
const bridge = {
  elementInfo: (element) => ({
    tagName: element?.tagName?.toLowerCase?.() ?? "div",
    componentName: "Page",
    filePath: "src/app/page.tsx",
    lineNumber: 7,
    columnNumber: 0,
    stack: [],
  }),
  elementSourceAsync: async (element) => bridge.elementInfo(element),
  send() {},
  toast: (message, kind) => toasts.push([message, kind]),
  subscribe: () => () => {},
  store: {
    setActiveTool() {},
    hasChanges: () => false,
    buildBatchOperations: () => [],
    onStateChange() {},
    getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
    viewportToPage: (x, y) => ({ x, y }),
    pageToViewport: (x, y) => ({ x, y }),
  },
}

const right = slot()
const context = editor.createContext(bridge, {
  overlay: slot(),
  toolbar: slot(),
  left: slot(),
  right,
})

server.reset()
server.libraries = [clone(PIER), clone(BEACON)]
server.candidates = [clone(CANDIDATE)]
await editor.refreshLibraries(API)

const libraries = editor.librariesSection(context)
right.append(libraries.node)
libraries.update()
await settle()

const click = (node) => {
  assert.ok(node, "nothing to click")
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
}

/**
 * The sign-in dialog, which is deliberately NOT inside the section.
 *
 * It is a real `<dialog>` parked on `document.body`. A modal has to outlive the
 * two enclosures it would otherwise sit in — the section body is `hidden` while
 * the section is folded, and the right panel goes `visibility: hidden` when the
 * chrome stands down — and neither is survivable for a top-layer element. So
 * the lookups below take two roots rather than one; scoped to the section alone
 * they would report every sign-in control missing, which reads as "the flow is
 * gone" rather than "it moved".
 */
const signInDialog = () => window.document.querySelector('dialog[data-de-lib="signin"]')
const roots = () => {
  const dialog = signInDialog()
  return dialog ? [libraries.node, dialog] : [libraries.node]
}

/** Every element on either surface wearing one of the contract's hooks. */
const all = (role) =>
  roots().flatMap((root) => [
    // The dialog wears `signin` itself, so a root can be its own match.
    ...(root.matches?.(`[data-de-lib="${role}"]`) ? [root] : []),
    ...root.querySelectorAll(`[data-de-lib="${role}"]`),
  ])
const one = (role) => all(role)[0] ?? null
const row = (id) => libraries.node.querySelector(`[data-de-lib="library"][data-de-lib-id="${id}"]`)
const control = (role, id) =>
  roots()
    .map((root) => root.querySelector(`[data-de-lib="${role}"][data-de-lib-id="${id}"]`))
    .find(Boolean) ?? null

/** The section's own title, read the way a reader would: off the header. */
const titleOf = (node) => node.querySelector(".de-section-title")?.textContent?.trim() ?? ""

// ── The Libraries section ──────────────────────────────────────────────────

console.log("\nLibraries is a section like Fill and Typography")

await check("it is a real de-section titled Libraries, not a panel with a bar", () => {
  assert.ok(libraries.node.classList.contains("de-section"), "the section is a bare div")
  assert.equal(titleOf(libraries.node), "Libraries")
  assert.ok(
    libraries.node.querySelector(".de-section-body"),
    "there is no section body, so the fold has nothing to hide"
  )
  assert.equal(
    libraries.node.querySelector(".de-lib-header"),
    null,
    "the old panel header bar came along with the move"
  )
})

await check("one row per installed library, naming it and where it came from", () => {
  assert.equal(all("library").length, 2, "the section did not draw a row per library")

  const pier = row(PIER.id)
  assert.ok(pier, "Pier is missing from the list")
  assert.match(pier.textContent, /Pier/)
  // No contents summary and no kind badge: a row is its name, its source and
  // its controls, and the remove control is an X rather than a trash can.
  assert.equal(pier.querySelector(".de-lib-detail"), null, "the row still prints a contents summary")
  assert.equal(pier.querySelector(".de-lib-kind"), null, "the row still prints a kind badge")
  // And where it came from, in full, in a title a pointer can read.
  const where = pier.querySelector(".de-lib-path")
  assert.ok(where, "the row does not say where the library came from")
  assert.equal(where.getAttribute("title"), PIER.source.path)

  const beacon = row(BEACON.id)
  assert.ok(beacon, "Beacon is missing from the list")
  assert.match(beacon.textContent, /Beacon/)
})

await check("every row carries a switch that says which library it is for", () => {
  const on = control("enable", PIER.id)
  const off = control("enable", BEACON.id)
  assert.ok(on && off, "a library has no enable switch")
  assert.equal(on.getAttribute("aria-pressed"), "true")
  assert.equal(off.getAttribute("aria-pressed"), "false")
  // The name has to carry the library, because a list of eight of these is
  // otherwise eight controls called the same thing.
  assert.equal(on.getAttribute("aria-label"), `Enable ${PIER.name}`)
  assert.ok(control("remove", PIER.id), "a library has no way out")
})

/*
 * The case with the shortest half-life.
 *
 * The browsing UI was deleted by request, and the way it comes back is not a
 * revert — it is somebody "restoring the assets panel" into the surface that
 * replaced it. Asserted as the absence of the three hooks that surface owned,
 * against the whole document rather than the section, because the details
 * popover was mounted on `document.body` and would not be inside it.
 */
await check("nothing of the assets browser came back", () => {
  for (const selector of [".de-asset-card", ".de-asset-grid", '[data-de-asset="insert"]']) {
    assert.equal(
      window.document.querySelector(selector),
      null,
      `the component browser is back: ${selector}`
    )
  }
  assert.equal(
    libraries.node.querySelector('[data-de-asset="search"]'),
    null,
    "the search box came back"
  )
})

console.log("\nAdding a library by link")

await check("the CTA is a URL field with a real name, and an Add beside it", () => {
  const field = one("url")
  assert.ok(field, "there is no way to add a library by link")
  assert.equal(field.getAttribute("placeholder"), "https://")
  assert.equal(field.getAttribute("aria-label"), "Link to a design system or Storybook")
  assert.ok(one("url-add"), "the URL field has no Add button")
})

await check("Add posts {url}, and the row that lands is the server's own", async () => {
  const field = one("url")
  field.value = ORBIT.source.url
  const before = server.calls.length
  click(one("url-add"))
  await settle(8)

  const post = server.calls
    .slice(before)
    .find((call) => call.method === "POST" && call.path === "/libraries")
  assert.ok(post, "Add never reached the server")
  assert.equal(post.body?.url, ORBIT.source.url, "the add posted something other than the link")
  assert.equal(post.body?.path, undefined, "a link was posted as a project path")

  const added = row(ORBIT.id)
  assert.ok(added, "the added library never appeared in the list")
  assert.match(added.textContent, /Orbit/)
  assert.equal(
    added.querySelector(".de-lib-path")?.getAttribute("title"),
    ORBIT.source.url,
    "the row shows a path where the library has a URL"
  )
  assert.equal(field.value, "", "the field kept the link it had already added")
})

await check("a refused link is reported in the server's own words", async () => {
  const field = one("url")
  field.value = "https://nope.example.com"
  toasts.length = 0
  click(one("url-add"))
  await settle(8)

  const said = toasts.find(([, kind]) => kind === "error")
  assert.ok(said, "a refused add said nothing at all")
  assert.equal(said[0], REFUSAL, `the refusal was reworded: ${said[0]}`)
  // The link stays, because it is the thing the user has to correct.
  assert.equal(field.value, "https://nope.example.com", "a failed add threw the link away")
  assert.equal(one("url-add").disabled, false, "the Add button stayed disabled after a refusal")
  assert.equal(row("nope"), null)
  field.value = ""
})

/*
 * The invariant the CTA is built once for.
 *
 * The list repaints on every store beat — including the beat an unrelated
 * switch fires — and a field rebuilt with it loses the caret and the text. The
 * failure is invisible in any test that types and immediately asserts, so this
 * one types, causes a repaint from somewhere else, and reads the field back.
 */
await check("a repaint of the list does not eat a half-typed link", async () => {
  const field = one("url")
  field.value = "https://half-typed.example"
  click(control("enable", BEACON.id))
  await settle(8)

  assert.equal(all("library").length, 3, "the list did not repaint at all, so this proves nothing")
  assert.equal(one("url"), field, "the URL field was rebuilt underneath the caret")
  assert.equal(field.value, "https://half-typed.example", "the half-typed link was thrown away")
  field.value = ""
})

console.log("\nAdding a link that is behind a sign-in wall")

/**
 * The dialog is built once and opened thereafter, so "showing" is `open`.
 *
 * Read off the property rather than off `hidden`, which is what this asked
 * before the wall became a modal: a closed `<dialog>` is not hidden, it simply
 * has no `open` attribute, and `hidden === false` is true of one all day.
 */
const signInShown = () => signInDialog()?.open === true

/*
 * The claim the modal exists for, and the one the flow used to fail.
 *
 * A wall STOPS the add — the library does not land until it is answered — and a
 * block growing quietly below the URL box said the opposite: optional, ignorable,
 * and with the whole panel still live behind it. Only `showModal()` states it,
 * and only a real `<dialog>` gets the top layer, the focus trap and the inertness
 * that make the statement true rather than decorative.
 *
 * Asserted as the ELEMENT rather than as a class, because a div that had grown
 * `role="dialog"` and a scrim would satisfy any looser check and enforce none of
 * it — the mistake `shell/shortcuts.ts` records having made and undone.
 */
await check("the way in is a real <dialog>, on the body rather than in the panel", () => {
  const dialog = signInDialog()
  assert.ok(dialog, "there is no sign-in dialog at all")
  assert.equal(dialog.tagName, "DIALOG", `the wall is answered in a ${dialog.tagName}`)
  assert.equal(
    libraries.node.contains(dialog),
    false,
    "the dialog is inside the section, so folding it or hiding the panel takes the modal with it"
  )
  assert.equal(dialog.parentNode, window.document.body, "the dialog is not parked on the body")
  assert.equal(signInShown(), false, "the sign-in dialog is open before anything was refused")
  // Named by its own heading, so the name cannot drift from the words on screen.
  const titled = dialog.getAttribute("aria-labelledby")
  assert.ok(titled, "the dialog has no accessible name")
  assert.ok(
    window.document.getElementById(titled),
    `the dialog is labelled by ${titled}, which is not in the document`
  )
})

/**
 * The text a person actually SEES, with the credential fold shut.
 *
 * `textContent` on the dialog is the wrong instrument for every case below: the
 * fold's contents stay in the DOM when it closes — they are clipped and made
 * `visibility: hidden`, not removed — so the raw string contains every word the
 * jargon cases are asserting the absence of. Cloning and dropping `[hidden]`
 * subtrees is the closest a DOM with no layout gets to "what is on screen".
 */
const visibleWords = () => {
  const clone = signInDialog().cloneNode(true)
  for (const gone of clone.querySelectorAll("[hidden]")) gone.remove()
  return clone.textContent.replace(/\s+/g, " ").trim()
}

/**
 * WHETHER A NODE CAN BE SEEN, WHICH IS NOT WHETHER THE NODE IS `hidden`.
 *
 * This pair exists because the weaker form shipped the worst bug this surface
 * has had. The case for "a closed sign-in window says so" asserted
 * `!said.hidden` and passed for months while the sentence it was checking was
 * inside the collapsed credential fold: the node's own property was false, its
 * parent's was true, and the fold is additionally clipped to a zero-height grid
 * row and given `visibility: hidden` by the stylesheet. So the test was reading
 * a property of the paragraph and claiming a fact about the screen, and what
 * the designer actually got was a button that greyed, un-greyed, and explained
 * nothing.
 *
 * `closest("[hidden]")` is the closest a DOM with no layout gets to the real
 * question. It walks the ancestors, so a node buried under any hidden parent
 * reports buried however its own attribute reads — and it is the form this file
 * already used for the fold's own controls, three hundred lines above the
 * assertion that did not.
 *
 * Neither of them knows about `<dialog>`: a control inside a CLOSED dialog is
 * not `[hidden]` and reads as visible here. Pair them with `signInShown()`
 * wherever that distinction carries weight.
 */
const visible = (node) => Boolean(node) && !node.closest("[hidden]")
const buried = (node) => Boolean(node) && Boolean(node.closest("[hidden]"))

/** Open the credential fold, where everything protocol-shaped now lives. */
const openCredentials = () => {
  const toggle = one("signin-more")
  assert.ok(toggle, "the dialog offers no way through for somebody who has a token")
  if (toggle.getAttribute("aria-expanded") !== "true") click(toggle)
  assert.equal(one("signin-panel").hidden, false, "the fold did not open")
}

/*
 * THE CASE THE WHOLE SURFACE WAS REWRITTEN FOR.
 *
 * This dialog used to open on "Sign-in redirect · https://…", a Bearer/Cookie
 * segmented control and a box labelled "Paste the Cookie header". Every word of
 * that is accurate and it is addressed to the wrong person: the reader is a
 * designer who pasted a link to their company's Storybook, and what they need
 * to be told is that the site is private. A protocol name is not a diagnosis to
 * them, it is a wall of its own.
 *
 * So the case is written as an ABSENCE, which is the only way to pin a register.
 * A future change that reintroduces the mechanism to the first screen — a
 * well-meant "say which kind of sign-in it is" — is exactly the regression this
 * catches, and nothing else in the suite would notice: every functional case
 * below would still pass with the jargon back on top, because the controls it
 * drives are all still there, one fold down.
 */
await check("a refused add says in plain words that the site is private", async () => {
  const field = one("url")
  field.value = WALL.url
  toasts.length = 0
  click(one("url-add"))
  await settle(8)

  // Nothing was installed: a walled URL is refused at the door, and a row for
  // it would be a library reporting zero colours for a reason it cannot state.
  assert.equal(row(VAULT.id), null, "a walled link was installed anyway")
  assert.ok(signInShown(), "a refused add produced no way to sign in")

  // The subject first, in a sentence: which site, and what it wants of you.
  const heading = window.document.getElementById(
    signInDialog().getAttribute("aria-labelledby")
  )
  assert.equal(
    heading.textContent,
    "vault.example.com needs you to sign in",
    `the heading is not a plain sentence: ${heading.textContent}`
  )
  // The HOST, not the origin. A scheme is noise in a heading and is not
  // something the reader chose or can change.
  assert.equal(
    heading.textContent.includes("https://"),
    false,
    "the heading prints a URL where a site name would do"
  )

  const seen = visibleWords()
  /*
   * ONE SENTENCE OF BODY, and the cap is the assertion.
   *
   * This was two paragraphs — why the editor's own process holds none of your
   * sessions, then a description of what the button below was going to do —
   * about fifty words in front of a single press. Both went: the first is a
   * question a reader handed a sign-in window never asks, and the second was
   * restating its own button.
   *
   * Counted rather than matched, because the failure this guards is drift
   * rather than a specific wrong string: every future edit that explains one
   * more thing here passes a content check and fails this one.
   */
  const body = seen
    .replace(heading.textContent, "")
    .split(/Use an access token/)[0]
    .trim()
  assert.ok(
    body.split(/\s+/).length <= 20,
    `the body has grown back into a paragraph (${body.split(/\s+/).length} words): ${body}`
  )

  /*
   * And not one term of art on the way in. Each of these was on the old first
   * screen; every one of them is still reachable, one press away, for the
   * person who is going to act on it.
   */
  for (const jargon of [
    "OAuth",
    "Bearer",
    "Cookie",
    "HTTP Basic",
    "Authorization",
    "client id",
    "Realm",
    "redirect",
  ]) {
    assert.equal(
      seen.toLowerCase().includes(jargon.toLowerCase()),
      false,
      `"${jargon}" is on the first screen of the sign-in dialog: ${seen}`
    )
  }

  /*
   * Two actions, and neither of them asks the reader for a string.
   *
   * The offer is the site's OWN sign-in, opened in a window: the provider runs
   * the login it always runs and the editor keeps whatever session that
   * produces. "Use this token" is the fallback for the sites that cannot be
   * opened that way, and it sits inside the fold with the box it submits —
   * asserted through an ancestor, because the control is built once and always
   * in the document, so what the fold changes is whether anything can reach it.
   */
  assert.ok(one("signin-dismiss"), "the dialog has no way out")
  const opener = one("signin-open")
  assert.ok(opener, "the dialog does not offer to open the site's own sign-in")
  assert.ok(visible(opener), "the sign-in offer is hidden on the first screen")
  assert.ok(
    /sign in/i.test(opener.textContent),
    `the primary action does not read as a sign-in: ${opener.textContent}`
  )
  assert.ok(
    one("signin-submit")?.closest("[hidden]"),
    "the token submit is reachable before anybody asked for it"
  )
  /*
   * The two things the button cannot say and the reader cannot guess: that a
   * WINDOW is about to appear, so it is expected rather than startling, and
   * that their password is not going near this editor.
   *
   * These are the whole of what survived the paragraph, so they are what the
   * remaining sentence has to carry.
   */
  assert.match(seen, /new window/, `nothing says a sign-in window will open: ${seen}`)
  assert.match(
    seen,
    /Your password stays there/,
    `the dialog does not say the credential stays out of it: ${seen}`
  )

  // The link stays. The designer may be about to sign in and the add is replayed
  // for them; clearing it here would ask them to find the URL twice.
  assert.equal(field.value, WALL.url, "the refused link was thrown away")
  assert.equal(one("url-add").disabled, false, "Add stayed disabled behind the sign-in dialog")
})

/*
 * The other half of the same decision: folded away is not thrown away.
 *
 * A designer who HAS a token needs the audience the refusal carried — seventy
 * characters they cannot look up anywhere else — and needs it copyable, because
 * nobody retypes one correctly. The fold would be a nicer dialog and a useless
 * one if opening it did not produce all of that.
 */
await check("the client id and the credential controls are one press away", async () => {
  // Unreachable while shut, and asserted as `hidden` on an ancestor rather than
  // as absence: the controls are built once and are always in the document, so
  // what the fold changes is whether anything can get at them.
  assert.ok(
    control("signin-fact-value", "audience")?.closest("[hidden]"),
    "the OAuth client id is reachable before anybody asked for it"
  )

  openCredentials()

  // The server's own sentence, which is the instruction for whoever opened this.
  assert.ok(
    visibleWords().includes(WALL.hint),
    "the fold opened without the server's own hint in it"
  )

  // The client id, in full — one of the two strings in this flow a designer has
  // no way to look up.
  const audience = control("signin-fact-value", "audience")
  assert.ok(audience, "an OAuth wall was reported with no client id to mint a token for")
  assert.equal(audience.textContent, WALL.audience)
  assert.equal(audience.closest("[hidden]"), null, "the client id is drawn but still unreachable")
  assert.ok(
    control("signin-copy", "audience"),
    "the client id has no copy button, so it has to be retyped"
  )
  // And nothing about a realm, which only a 401 carries.
  assert.ok(
    buried(control("signin-fact", "realm")),
    "an empty realm was drawn as a labelled box with nothing in it"
  )

  // Bearer by default for a wall that named an OAuth client: the hint above the
  // box asks for an identity token, and defaulting to Cookie would contradict it.
  assert.equal(control("signin-scheme", "bearer").getAttribute("aria-pressed"), "true")
  assert.equal(control("signin-scheme", "cookie").getAttribute("aria-pressed"), "false")

  // And the commit arrives with the box it commits.
  assert.ok(visible(one("signin-submit")), "the fold opened with no way to submit")
  // The caret lands in the box, because opening the fold IS asking for it.
  assert.equal(
    window.document.activeElement,
    one("signin-value"),
    "the fold opened without putting the caret in the box"
  )
})

await check("the credential is masked until it is asked for", async () => {
  const value = one("signin-value")
  assert.ok(value, "there is nowhere to paste a credential")
  // The default, and the only state that matters: a designer pastes this with
  // somebody at their shoulder or with a recording running.
  assert.equal(value.getAttribute("type"), "password", "the credential box shows the token")

  const toggle = one("signin-reveal")
  assert.ok(toggle, "a masked field with no way to check what was pasted")
  click(toggle)
  assert.equal(value.getAttribute("type"), "text", "the reveal toggle revealed nothing")
  assert.equal(toggle.getAttribute("aria-pressed"), "true")
  click(toggle)
  assert.equal(value.getAttribute("type"), "password", "the field stayed revealed")
})

/*
 * The invariant the block is built once for, and it is worse here than on the
 * URL field: what this box holds is an 800-character token fetched from another
 * program, and a repaint that ate it would send the designer back for it.
 */
await check("a repaint of the list does not eat a half-pasted credential", async () => {
  const value = one("signin-value")
  value.value = "eyJhbGciOi.half-pas"
  click(control("enable", PIER.id))
  await settle(8)

  assert.ok(signInShown(), "the sign-in block closed when an unrelated switch fired")
  assert.equal(one("signin-value"), value, "the credential box was rebuilt underneath the caret")
  assert.equal(value.value, "eyJhbGciOi.half-pas", "the half-pasted credential was thrown away")
})

await check("a refused credential keeps what was typed and says why", async () => {
  const value = one("signin-value")
  value.value = "eyJhbGciOi.expired-yesterday"
  const before = server.calls.length
  click(one("signin-submit"))
  await settle(8)

  const post = server.calls
    .slice(before)
    .find((call) => call.method === "POST" && call.path === "/libraries/auth")
  assert.ok(post, "Sign in never reached the server")
  // The URL the add was refused for, not the origin: the origin's front page
  // can be public while the page under it is not.
  assert.equal(post.body?.url, WALL.url, "the sign-in posted something other than the walled URL")
  assert.equal(post.body?.scheme, "bearer")
  assert.equal(post.body?.value, "eyJhbGciOi.expired-yesterday")

  const said = one("signin-error")
  assert.ok(visible(said), "a refused credential said nothing on the surface")
  assert.equal(said.textContent, BAD_CREDENTIAL, `the refusal was reworded: ${said.textContent}`)

  // The two things a refusal must not do: empty the box, or claim a sign-in.
  assert.equal(value.value, "eyJhbGciOi.expired-yesterday", "a refused credential was cleared")
  assert.ok(signInShown(), "the block closed on a refusal, taking the way in with it")
  assert.equal(
    one("signed-in"),
    null,
    "the panel claims a sign-in the server refused"
  )
  assert.equal(row(VAULT.id), null, "the walled library appeared without a working credential")
})

await check("a credential that opens the wall signs in and finishes the add", async () => {
  const value = one("signin-value")
  value.value = OPENS
  toasts.length = 0
  const before = server.calls.length
  click(one("signin-submit"))
  await settle(10)

  /*
   * ORDER, not merely presence. "Signed in" and "added" both being true says
   * nothing about whether the second happened by itself — the designer could
   * have pressed Add again — and the whole point of the replay is that they
   * did not have to.
   */
  const after = server.calls.slice(before)
  const signIn = after.findIndex((call) => call.method === "POST" && call.path === "/libraries/auth")
  const add = after.findIndex((call) => call.method === "POST" && call.path === "/libraries")
  assert.ok(signIn >= 0, "the credential never reached the server")
  assert.ok(add > signIn, "the add the wall refused was not replayed after the sign-in")
  assert.equal(after[add].body?.url, WALL.url, "the replay posted a different link")

  const added = row(VAULT.id)
  assert.ok(added, "the library behind the wall never arrived")
  assert.match(added.textContent, /Vault/)

  assert.equal(signInShown(), false, "the sign-in block stayed open over a completed sign-in")
  assert.equal(value.value, "", "the credential was left in the DOM after it was posted")
  assert.equal(one("url").value, "", "the URL box kept a link that is now a row above it")
  assert.ok(
    toasts.some(([message]) => message.includes(WALL.origin)),
    `nothing said the sign-in worked: ${JSON.stringify(toasts)}`
  )
})

await check("the signed-in origins are listed, and Forget reaches the server", async () => {
  const listed = one("signed-in")
  assert.ok(listed, "the editor holds a credential and says so nowhere")
  assert.equal(listed.getAttribute("data-de-lib-id"), WALL.origin)
  // Named after the library it opens; the link waits in the hover title.
  const name = listed.querySelector(".de-lib-name")
  assert.equal(name?.textContent, VAULT.name, `the row does not name the library: ${listed.textContent}`)
  assert.ok(!listed.textContent.includes(WALL.origin), "the row still prints the raw origin")
  assert.ok(name.getAttribute("title").includes(WALL.url), "the link is not on hover")
  assert.ok(!/signed in/i.test(one("signed").textContent), "the block still says 'Signed in'")
  // Which of the two credentials it is lives in the title, not as a badge.
  assert.equal(listed.querySelector(".de-lib-kind"), null, "the row still prints a kind badge")
  assert.match(name.getAttribute("title"), /token/)

  const forget = control("forget", WALL.origin)
  assert.ok(forget, "a stored credential with no way to drop it")
  const before = server.calls.length
  click(forget)
  await settle(8)

  const dropped = server.calls
    .slice(before)
    .find((call) => call.method === "DELETE" && call.path === "/libraries/auth")
  assert.ok(dropped, "Forget never reached the server")
  assert.equal(dropped.body?.origin, WALL.origin, "Forget dropped a different origin")
  assert.deepEqual(server.credentials, [], "the server still holds the credential")

  // Empty draws NOTHING: "signed in to nothing" is furniture in a 260px column.
  assert.equal(one("signed-in"), null, "the forgotten origin is still listed")
  assert.ok(buried(one("signed")), "an empty sign-in list is still taking up room")
})

console.log("\nEvery wall is read by its mechanism")

/**
 * Walk a walled link into the dialog, so a case can read what it drew.
 *
 * Each of these origins is refused for good — the point is the READING, not the
 * sign-in — so the dialog is dismissed afterwards and the URL box emptied,
 * leaving the section exactly as the previous case left it.
 */
async function refuseAdd(wall) {
  const field = one("url")
  field.value = wall.url
  click(one("url-add"))
  await settle(8)
  assert.ok(signInShown(), `${wall.kind} was refused and offered no way in`)
}

function dismissSignIn() {
  click(one("signin-dismiss"))
  one("url").value = ""
  assert.equal(signInShown(), false, "Close left the dialog open")
}

/*
 * The two ways out, and what each of them owes.
 *
 * "Close" and Escape, and deliberately nothing else — a press on the backdrop
 * is the cheapest accidental gesture in the interface, and this dialog is
 * holding a token somebody went to another program to fetch.
 *
 * Escape is the one with a second obligation. `shell/shortcuts.ts` listens on
 * the bubble phase of `window` and stands the WHOLE EDITOR down on an Escape
 * that nothing else took — the last rung of that key's escalation — and it
 * reads `defaultPrevented` as the handshake. A dialog that closed without
 * marking the press would dismiss itself and collapse the chrome behind it on
 * one key, and that is invisible to any case which only checks the dialog shut.
 * So the EVENT is asserted, not just the outcome.
 */
await check("Escape closes it, and the press does not also collapse the editor", async () => {
  await refuseAdd(REDIRECT_WALL)
  const key = new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  })
  signInDialog().dispatchEvent(key)

  assert.equal(signInShown(), false, "Escape left the dialog open")
  assert.ok(key.defaultPrevented, "Escape was not marked as spent, so the chrome collapses too")
  one("url").value = ""
})

await check("dismissing it takes the credential and hands the keyboard back", async () => {
  const opener = one("url-add")
  opener.focus()
  one("url").value = REDIRECT_WALL.url
  click(opener)
  /*
   * FOCUS MOVES WHILE THE REQUEST IS IN FLIGHT, and this line is why the case
   * is written out longhand instead of calling `refuseAdd`.
   *
   * On a real page it moves by itself: `addFrom` disables the Add button for
   * the length of the request, and disabling the focused control drops focus to
   * `<body>`, so `document.activeElement` is the body every time a refusal
   * lands in Chrome. JSDOM does not do that, which is how a panel that read its
   * return target off the document at that moment passed this suite and handed
   * a keyboard user nothing on a real page. Blurring cannot stage it here —
   * JSDOM refuses to blur an element it considers unfocusable, and the button
   * is disabled by now — so focus is moved to the URL box instead. Same
   * invariant either way: the way back is the control the add was COMMITTED
   * from, not wherever focus has drifted to by the time the wall answers.
   */
  one("url").focus()
  await settle(8)
  assert.ok(signInShown(), "the redirect wall was refused and offered no way in")

  /*
   * The CARD takes focus, not a control inside it — this is a statement to read
   * and the credential box is folded away. Landing on the disclosure toggle,
   * which is what the platform's own focus delegate picks, would announce "I
   * have an access token, collapsed button" to a screen reader before it had
   * said which site this is about or why.
   */
  assert.equal(
    window.document.activeElement,
    signInDialog(),
    "the dialog handed focus to a control instead of to the sentence it is showing"
  )

  const value = one("signin-value")
  openCredentials()
  value.value = "eyJhbGciOi.abandoned"
  click(one("signin-dismiss"))

  assert.equal(signInShown(), false, "Close left the dialog open")
  // Folded shut with it, so the next site's wall opens on the plain sentence
  // rather than on the last one's OAuth client id.
  assert.equal(one("signin-panel").hidden, true, "the credential fold stayed open behind a close")
  // A token left in a closed dialog is a secret in the DOM of a page that will
  // be open for hours, held for a wall nobody is answering any more.
  assert.equal(value.value, "", "the abandoned credential is still in the DOM")
  // And the keyboard goes back where it came from. A modal takes focus off the
  // page and `close()` does not put it back — without this, dismissing drops a
  // keyboard user onto `<body>` with nothing left to Tab from.
  assert.equal(
    window.document.activeElement,
    opener,
    "dismissing the dialog dropped focus instead of returning it"
  )
  one("url").value = ""
})

/*
 * The 401, and it exercises both halves of the split at once.
 *
 * On the FIRST screen it is the one wall that is not about signing in — a
 * username and password is a thing a designer may already hold in a password
 * manager, so collapsing it into "needs you to sign in" would hide the one
 * refusal here somebody can answer without leaving their desk.
 *
 * Inside the FOLD it is the only refusal that carries a realm, and the only
 * wall whose own scheme the wire cannot speak: the credential union is bearer
 * or cookie, because the server refuses to build a header out of a word it does
 * not know. So the token box is what a Basic wall gets, and the fold owes the
 * designer a sentence saying what will actually be sent.
 */
await check("a 401 asks for a password in plain words, and for a realm in the fold", async () => {
  await refuseAdd(BASIC_WALL)

  // Not "needs you to sign in": this one is answerable from a password manager,
  // and saying so is the only reason the five kinds are not one sentence.
  const seen = visibleWords()
  assert.ok(
    seen.startsWith("mono.example.com needs a username and password"),
    `a 401 was not put in plain words: ${seen}`
  )
  assert.equal(
    seen.toLowerCase().includes("basic"),
    false,
    `the protocol's own name is still on the first screen: ${seen}`
  )

  openCredentials()
  const realm = control("signin-fact-value", "realm")
  assert.equal(realm.textContent, BASIC_WALL.realm, "the realm the 401 named was dropped")
  assert.equal(realm.closest("[hidden]"), null, "the realm is drawn but unreachable")
  assert.ok(control("signin-copy", "realm"), "the realm has no copy button")
  assert.ok(
    buried(control("signin-fact", "audience")),
    "a 401 carries no OAuth client id and the fold drew a box for one"
  )

  // The server's sentence AND the editor's, because only this side knows what
  // this side sends. A designer who is told to paste base64 and not told what
  // happens to it has no way to read the refusal that may follow. Both belong
  // in here: they are addressed to somebody who has already said they have a
  // credential.
  const opened = visibleWords()
  assert.ok(opened.includes(BASIC_WALL.hint), "the server's own hint did not reach the fold")
  assert.match(
    opened,
    /Authorization header/,
    "nothing says what this editor will do with the paste"
  )

  assert.equal(control("signin-scheme", "bearer").getAttribute("aria-pressed"), "true")
  dismissSignIn()
})

/*
 * The bounce to a sign-in page, which names nothing at all: no token format, no
 * client id, no realm.
 *
 * Read the same way as an OAuth handoff on the first screen — from outside they
 * are one experience, "this site wants a human to log in", and the protocol
 * difference is behind the fold where it can be acted on. Inside, a browser
 * session is the likeliest thing a designer can actually produce for it, so the
 * cookie is what the fold offers first, and both fact rows stay out of the way.
 */
await check("a sign-in bounce reads like an SSO wall, and offers the cookie", async () => {
  await refuseAdd(REDIRECT_WALL)

  const seen = visibleWords()
  assert.ok(
    seen.startsWith("atlas.example.com needs you to sign in"),
    `the bounce was not put in plain words: ${seen}`
  )

  openCredentials()
  for (const key of ["audience", "realm"]) {
    assert.ok(buried(control("signin-fact", key)), `an empty ${key} was drawn anyway`)
  }

  assert.equal(control("signin-scheme", "cookie").getAttribute("aria-pressed"), "true")
  assert.equal(control("signin-scheme", "bearer").getAttribute("aria-pressed"), "false")
  dismissSignIn()
})

/*
 * The 403, which is the one refusal that is NOT fixed by signing in.
 *
 * The editor got through the door and was turned away, so the account needs
 * access rather than the session needs a login — and a dialog that told this
 * reader to sign in would send them round a loop they cannot get out of. It is
 * the reason the five kinds collapse to four sentences and not to one.
 */
await check("a 403 says the editor was turned away, not that it should sign in", async () => {
  await refuseAdd(FORBIDDEN_WALL)

  const seen = visibleWords()
  assert.ok(
    seen.startsWith("guarded.example.com denied access"),
    `a 403 was reported as something else: ${seen}`
  )
  assert.match(
    seen,
    /the account needs permission/,
    `nothing distinguishes a refusal from a missing sign-in: ${seen}`
  )
  dismissSignIn()
})

console.log("\nAdding a file from this project")

await check("the local-file fold is shut until it is asked for, and scans when opened", async () => {
  const toggle = one("add-toggle")
  assert.ok(toggle, "a designer can no longer add their own tokens file")
  assert.equal(toggle.getAttribute("aria-expanded"), "false", "the fold is open by default")
  /*
   * "Shut" is asked of the DOM rather than of the flag, and it is asked as
   * `hidden` on an ANCESTOR rather than as absence. The path box is built once
   * and never rebuilt — same invariant as the URL field above — so it is always
   * in the document; what the fold changes is whether anything can reach it,
   * which `hidden` is exactly the statement of.
   */
  assert.ok(
    one("manual-path")?.closest("[hidden]"),
    "the path box is reachable with the fold shut"
  )

  const before = server.calls.length
  click(toggle)
  await settle(8)

  assert.equal(toggle.getAttribute("aria-expanded"), "true")
  assert.ok(
    server.calls.slice(before).some((call) => call.path === "/libraries/available"),
    "the fold never asked the server what this project has in it"
  )
  const candidate = one("candidate")
  assert.ok(candidate, "the scan found a file and the fold drew nothing")
  assert.match(candidate.textContent, /Anchor Icons/)
  assert.match(candidate.textContent, /18 icon drawings/)
  assert.equal(
    one("manual-path").closest("[hidden]"),
    null,
    "the fold was announced as open and left shut"
  )
  assert.ok(one("manual-add"), "a file the scan missed can no longer be added by hand")
})

console.log("\nThe empty state")

await check("with nothing installed it draws no empty-state sentence", async () => {
  const installed = clone(server.libraries)

  server.libraries = []
  await editor.refreshLibraries(API)
  await settle()

  assert.deepEqual(all("library"), [], "the section lists libraries this project does not have")
  assert.equal(libraries.node.querySelector(".de-lib-empty"), null, "the empty-state sentence came back")
  assert.equal(
    libraries.node.querySelector(".de-lib-cta .de-lib-cta-label"),
    null,
    "the URL box grew its visible label back"
  )

  // Scaffolding: the libraries go back, so the file ends where it started.
  server.libraries = installed
  await editor.refreshLibraries(API)
  await settle()
  assert.equal(all("library").length, installed.length, "the borrowed libraries did not come back")
})

// ── DS Lint ────────────────────────────────────────────────────────────────

console.log("\nDS Lint is a section too")

const lint = editor.dsLintSection(context)
right.append(lint.node)
lint.update()
await settle()

const lintHook = (role) => lint.node.querySelector(`[data-de-lint="${role}"]`)

await check("it is a de-section titled DS lint, with the bespoke header bar gone", () => {
  assert.ok(lint.node.classList.contains("de-section"), "the audit is not in a section")
  assert.equal(titleOf(lint.node), "DS lint")
  assert.equal(
    lint.node.querySelector(".de-lint-header"),
    null,
    "the panel kept its own header bar inside a section header"
  )
  assert.equal(
    lint.node.querySelector(".de-lint-title"),
    null,
    "the panel is drawing a second title under the section's"
  )
})

await check("Audit is in the body; the section title explains the checkers", () => {
  const audit = lintHook("audit")
  assert.ok(audit, "the audit button is gone")
  // Audit led the group it belongs to out of the header: the two buttons that
  // join it after a run live in the body, and a group split across the fold
  // line is not a group.
  assert.equal(
    audit.closest(".de-section-actions"),
    null,
    "Audit is still riding in the section header"
  )
  assert.ok(audit.closest(".de-lint-controls"), "Audit is not in the button group")

  const title = lintHook("checkers")
  assert.ok(title, "nothing in the header says which checkers run")
  assert.ok(title.closest(".de-section-header"), "the checkers sentence is not in the section header")
  assert.ok(title.getAttribute("data-de-tip"), "the section title opens no hint on hover")
  assert.equal(lint.node.querySelector(".de-section-info"), null, "the checkers dot is still drawn")
})

await check("the report keeps every data-de-lint hook it had", async () => {
  // Run it, so the summary has something to count. This fixture answers with no
  // findings — the housing is what this file is about.
  click(lintHook("audit"))
  await settle(8)
  for (const role of ["audit", "summary", "checkers"]) {
    assert.ok(lintHook(role), `the ${role} hook did not survive the move into a section`)
  }
  assert.match(lintHook("summary").textContent, /issues/, "the summary line says nothing")

  // This fixture's audit finds nothing, which is exactly the state in which the
  // other two must NOT be on screen. `lint-marker-cases.mjs` owns the case where
  // they are. Asserting it here as well is cheap and keeps the two files from
  // disagreeing about when the group grows.
  for (const role of ["fix-all", "hide-markers"]) {
    assert.equal(lintHook(role), null, `${role} is offered with no findings to act on`)
  }
})

// ── The tab ────────────────────────────────────────────────────────────────

console.log("\nThe tab holds both, in that order")

await check("designSystemTab renders Libraries then DS lint", () => {
  const tab = editor.designSystemTab(context)
  assert.ok(tab.node, "the tab has no node")
  assert.equal(typeof tab.update, "function", "the tab does not answer the InspectorTab shape")

  const titles = Array.from(tab.node.querySelectorAll(".de-section-title")).map((node) =>
    node.textContent.trim()
  )
  assert.deepEqual(
    titles,
    ["Libraries", "DS lint"],
    // The vocabulary before the corrections: a tab that lists what is wrong
    // above what the project measures itself against reads backwards.
    `the tab's sections are ${JSON.stringify(titles)}`
  )

  // And `update()` reaches both, which is what tab activation relies on.
  tab.update()
  assert.ok(
    tab.node.querySelector('[data-de-lib="url"]'),
    "the Libraries section did not render into the tab"
  )
  assert.ok(
    tab.node.querySelector('[data-de-lint="audit"]'),
    "the DS Lint section did not render into the tab"
  )
})

/*
 * The button the dialog leads with, all the way through.
 *
 * The token path is covered above; this is the one a designer actually takes.
 * Two things are asserted that nothing else can: that pressing it posts to the
 * window route rather than the credential route — nothing typed, nothing
 * collected — and that a completed sign-in replays the add by itself, in that
 * order.
 */
await check("Sign in with Okta opens the window and finishes the add by itself", async () => {
  await refuseAdd(WALL)
  server.signInOutcome = { ok: true }
  toasts.length = 0
  const before = server.calls.length

  click(one("signin-open"))
  await settle(10)

  const after = server.calls.slice(before)
  const opened = after.findIndex(
    (call) => call.method === "POST" && call.path === "/libraries/auth/signin"
  )
  const add = after.findIndex((call) => call.method === "POST" && call.path === "/libraries")
  assert.ok(opened >= 0, "pressing the button never reached the sign-in route")
  assert.equal(after[opened].body?.url, WALL.url, "the window was opened for the wrong link")
  // Nothing was collected from the designer, which is the entire point.
  assert.equal(after[opened].body?.value, undefined, "a credential was posted from a button press")
  assert.equal(
    after.some((call) => call.method === "POST" && call.path === "/libraries/auth"),
    false,
    "the window flow fell through to the paste route"
  )
  assert.ok(add > opened, "the add the wall refused was not replayed after the sign-in")

  assert.ok(row(VAULT.id), "the library behind the wall never arrived")
  assert.equal(signInShown(), false, "the dialog stayed open over a completed sign-in")
  assert.ok(
    toasts.some((text) => /signed in/i.test(text)),
    `no confirmation of the sign-in: ${toasts.join(" | ")}`
  )
})

/*
 * And the ordinary way it does not complete: somebody closes the window.
 *
 * A sentence on the surface, the dialog still up, and — the part that matters —
 * no claim of a sign-in and no library. A flow that quietly added a row here
 * would be reporting a design system nobody can read.
 *
 * THIS CASE USED TO PASS OVER THE BUG IT EXISTS TO CATCH. It asked
 * `!said.hidden`, which is a fact about a paragraph, while the paragraph lived
 * inside the collapsed credential fold — so the assertion was green and the
 * designer's screen was blank. The fold is shut here, as it is for every new
 * wall, and it is the whole point: the reason has to be legible to the reader
 * who never opens it, which is nearly all of them. Asserted twice over, through
 * the ancestor walk and through the text the dialog actually renders.
 */
await check("a window the designer closed says so, with the token fold shut", async () => {
  /*
   * A different origin from the case above, deliberately: that one is signed in
   * now and would not refuse a second add. This wall is one of the three this
   * stub never opens, so nothing here can succeed by accident.
   */
  const libraryCount = server.libraries.length
  await refuseAdd(REDIRECT_WALL)
  server.signInOutcome = {
    ok: false,
    reason: "The sign-in window was closed before the site let the editor in.",
  }
  const heldBefore = server.credentials.length
  click(one("signin-open"))
  await settle(10)

  // The fold is where this sentence used to be buried, so the state it is read
  // in is asserted rather than assumed.
  assert.equal(
    one("signin-more").getAttribute("aria-expanded"),
    "false",
    "the fold was already open, so this case is not testing the state the bug lived in"
  )
  const said = one("signin-error")
  assert.ok(visible(said), "a closed window said nothing the designer can see")
  assert.match(said.textContent, /closed/i, `the reason was reworded: ${said.textContent}`)
  assert.match(
    visibleWords(),
    /closed before the site let the editor in/,
    `the reason is in the DOM but not on the dialog: ${visibleWords()}`
  )
  assert.ok(signInShown(), "the dialog closed itself over an unfinished sign-in")
  assert.equal(server.libraries.length, libraryCount, "a library was added without a sign-in")
  assert.equal(
    server.credentials.length,
    heldBefore,
    "the panel stored a credential for a sign-in that never happened"
  )
  assert.equal(
    server.credentials.some((entry) => entry.origin === REDIRECT_WALL.origin),
    false,
    "an origin nobody signed in to is listed as signed in"
  )
  // And the button is pressable again, because the obvious next move is to
  // press it again.
  assert.equal(one("signin-open").disabled, false, "the offer was left disabled after a refusal")
  dismissSignIn()
})

/*
 * The case the whole flow exists for, end to end on one wall.
 *
 * A designer pastes a Storybook behind an SSO proxy. What they used
 * to get was a dialog asking them to mint an identity token for a
 * seventy-character client id — a thing no designer has, and one the usual
 * tooling refuses to issue for a human account at all. What they get now is the
 * name of the provider they already log in to every morning, on a button.
 */
await check("a proxied Storybook offers the provider's own sign-in, not a token", async () => {
  await refuseAdd(PROXY_WALL)

  /*
   * The provider is READ OFF THE REDIRECT, not guessed from the site. The
   * fixture bounces to a provider that is not first in the table, so a
   * `providerOf` that returned a constant — or that matched on the target
   * host — fails here and passes everywhere else.
   */
  const opener = one("signin-open")
  assert.ok(opener, "no offer to open the site's own sign-in")
  assert.equal(
    opener.textContent.trim(),
    "Sign in with Microsoft",
    `the button does not name the provider the wall handed off to: ${opener.textContent}`
  )
  assert.ok(visible(opener), "the offer was hidden for a wall it can answer")

  // The first screen names the site, says a window is coming, and never
  // mentions OAuth, a client id or a token.
  const seen = visibleWords()
  assert.ok(
    seen.startsWith("storybook-3f81c0a2-ue.example.net needs you to sign in"),
    `the heading is not a plain sentence about the site: ${seen}`
  )
  assert.match(seen, /new window/)
  /*
   * The same list the plain-words case enforces, and for the same reason. Note
   * what is NOT in it: "I have an access token" is the fold's own label, and it
   * is deliberately on screen — it is the filter that lets the one person in a
   * hundred who holds a token find the path meant for them, while everybody
   * else reads past it.
   */
  for (const jargon of [
    "OAuth",
    "Bearer",
    "Cookie",
    "HTTP Basic",
    "Authorization",
    "client id",
    "Realm",
  ]) {
    assert.equal(
      seen.toLowerCase().includes(jargon.toLowerCase()),
      false,
      `"${jargon}" is on the first screen: ${seen}`
    )
  }

  // And the audience is still there for whoever needs it — folded away, where
  // the person who is going to mint a token can reach it in one press.
  openCredentials()
  const audience = control("signin-fact-value", "audience")
  assert.equal(audience.textContent, PROXY_WALL.audience, "the proxy's client id was dropped")
})

// ── The wait itself ────────────────────────────────────────────────────────

/*
 * EVERY CASE ABOVE ANSWERS IN THE SAME TICK, AND THE BUG WAS IN THE MINUTES
 * BETWEEN.
 *
 * The window sign-in is the longest thing this editor does by a wide margin:
 * the server budgets twenty seconds to launch a browser, forty-five to try the
 * saved profile with nothing on screen, twenty more to launch again, four
 * minutes for a human at their provider and fifteen seconds to verify
 * afterwards. Nearly six minutes in which the client is holding one outstanding
 * POST, and not one of the cases above spends a single tick there, because the
 * stub answers immediately.
 *
 * So every defect in that stretch shipped: a dialog with no cancel and no
 * deadline, a "Waiting…" state that leaked into the NEXT dialog and disabled
 * it, a second sign-in racing the first for one browser profile, and an add
 * that was silently dropped if the designer closed the dialog before the window
 * finished. The block below is the one that stands in the middle of the wait.
 */

/**
 * Hold the next window sign-in open, and hand back the handle that ends it.
 *
 * `gate.release(outcome)` answers it the way the immediate path would;
 * `gate.aborted` says whether the client's cancel actually reached the
 * transport. One gate per request — the stub takes it on arrival — so a test
 * that means to hold two has to ask twice.
 */
function holdSignIn() {
  const gate = { release: null, aborted: false }
  server.signInGate = gate
  return gate
}

/**
 * Make the dialog's own timers fire NOW, for delays up to `underMs`.
 *
 * The two things being tested here are twenty seconds and six and a half
 * minutes away, and a suite cannot wait for either. Patching the global the
 * bundle calls is the smallest lever that still exercises the real code path —
 * the real `setTimeout` call, the real callback, the real repaint — where a
 * hook on the module would test a seam invented for the test.
 *
 * `underMs` is the point of the parameter: raise the nudge without the deadline
 * and the escalating copy can be read on its own, which is the whole claim of
 * that case. Zero-delay timers are left alone, because `settle()` is built out
 * of them.
 */
const realSetTimeout = globalThis.setTimeout
function hurryTimers(underMs = Infinity) {
  globalThis.setTimeout = (fn, delay = 0, ...rest) =>
    realSetTimeout(fn, delay > 0 && delay <= underMs ? 0 : delay, ...rest)
  return () => {
    globalThis.setTimeout = realSetTimeout
  }
}

/** A walled add that the stub will refuse, with nothing held for its origin. */
async function refuseWalledAdd() {
  server.credentials = []
  await refuseAdd(WALL)
}

/*
 * The state the report was written about, and the one thing it lacked: a way
 * out.
 *
 * A designer presses Sign in and the editor may have nothing to show them for a
 * minute — the first leg is headless, so there is no window on screen at all.
 * What the dialog used to offer in that minute was a greyed button reading
 * "Waiting…" and Close, which abandons the UI and leaves the request running.
 * Nothing stopped it, nothing said how long, nothing changed. This asserts the
 * three things that make the wait survivable: a live control, an announcement,
 * and the fact that pressing it actually reaches the request.
 */
await check("a sign-in in flight can be cancelled, and the cancel reaches the request", async () => {
  dismissSignIn()
  await refuseWalledAdd()
  const gate = holdSignIn()

  click(one("signin-open"))
  await settle(6)

  // The offer is not a disabled button, it is GONE — its slot belongs to the
  // control that can do something while the request is out.
  assert.ok(signInShown(), "the dialog closed itself the moment the sign-in started")
  assert.equal(visible(one("signin-open")), false, "the dialog still offers a sign-in mid-sign-in")
  const cancel = one("signin-cancel")
  assert.ok(visible(cancel), "a sign-in was started with no way to stop it")
  assert.equal(cancel.disabled, false, "the only control in the waiting state is disabled")
  assert.match(
    visibleWords(),
    /Opening the sign-in window/,
    `the wait says nothing about what is happening: ${visibleWords()}`
  )

  /*
   * And the wait is announced. The button that was pressed is no longer there
   * to carry a label change, and an `aria-describedby` target is read on open
   * and never again — so the sentence itself is the live region, and the dialog
   * says it is busy for anything that asks.
   */
  assert.equal(
    window.document.getElementById("de-lib-signin-hint").getAttribute("role"),
    "status",
    "nothing in the dialog announces that a sign-in started"
  )
  assert.equal(signInDialog().getAttribute("aria-busy"), "true", "the dialog is not marked busy")
  // Focus went with the button that was replaced, so it is put on the control
  // that replaced it rather than dropped on `<body>` for the length of the wait.
  assert.equal(
    window.document.activeElement,
    cancel,
    "disabling the pressed button dropped the keyboard mid-wait"
  )

  /*
   * ONE AT A TIME, and the impatient path is the one that has to be held.
   *
   * Nothing serialised these. The server launches every sign-in against the
   * same Chrome profile directory, and a second launch into a directory the
   * first still holds loses the singleton race and comes back as "the browser
   * did not open" — a sentence about the designer's machine for a fault the
   * editor caused. The offer is off the row while a run is out, so a mouse
   * cannot start a second; Enter in the credential box can, which is exactly
   * what somebody two minutes into a silent wait does.
   */
  const racing = server.calls.length
  click(one("signin-open"))
  const field = one("signin-value")
  field.value = "eyJhbGciOi.impatient"
  field.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
  )
  await settle(6)
  assert.deepEqual(
    server.calls.slice(racing).filter((call) => call.method === "POST").map((call) => call.path),
    [],
    "a second sign-in was started against the same browser profile as the first"
  )

  const before = server.calls.length
  click(cancel)
  await settle(6)

  assert.ok(gate.aborted, "Cancel stopped the dialog waiting but never told the request")
  const said = one("signin-error")
  assert.ok(visible(said), "a cancelled sign-in left the dialog with no account of itself")
  assert.match(said.textContent, /cancelled/i, `the cancel was reworded: ${said.textContent}`)
  // The window the server opened is not ours to close, and saying so is the
  // difference between a stray browser window and a broken one.
  assert.match(said.textContent, /window/i, "nothing says the browser window may still be up")

  // And the offer is back, because the obvious next move is to try again.
  const opener = one("signin-open")
  assert.ok(visible(opener), "cancelling took the sign-in offer away with it")
  assert.equal(opener.disabled, false, "the offer came back disabled")
  assert.equal(visible(one("signin-cancel")), false, "a cancel is offered with nothing to cancel")
  assert.equal(
    server.calls.slice(before).some((call) => call.path === "/libraries"),
    false,
    "a cancelled sign-in went on to add the library anyway"
  )
  dismissSignIn()
})

/*
 * The other half of "never unable to act": the answer that never comes.
 *
 * The server bounds its own wait, but these routes are grafted onto the host
 * project's dev server — Vite, Next, whatever proxy a company puts in front of
 * it — and a six-minute response is the most fragile shape a request can take.
 * When one of those drops the connection the promise simply never settles, and
 * without a deadline on this side the dialog waits until the page is reloaded.
 */
await check("a wait that never answers ends by itself and hands the action back", async () => {
  await refuseWalledAdd()
  const gate = holdSignIn()
  const restore = hurryTimers()

  click(one("signin-open"))
  await settle(8)
  restore()

  assert.ok(gate.aborted, "the deadline gave up on the dialog but not on the request")
  const said = one("signin-error")
  assert.ok(visible(said), "the wait ended with nothing on screen, which is where it started")
  assert.match(
    said.textContent,
    /timed out/i,
    `the deadline does not say what happened: ${said.textContent}`
  )
  // Re-offered, not merely explained: a dead end with a sentence in it is still
  // a dead end.
  assert.ok(visible(one("signin-open")), "the deadline left the dialog with no way forward")
  assert.equal(one("signin-open").disabled, false, "the offer came back disabled")
  dismissSignIn()
})

/*
 * THE STALE SERVER, WHICH IS THE MOST ACUTE FORM OF THE ORIGINAL REPORT.
 *
 * `canOpenProviderSignIn` treats an unknown answer as yes, deliberately: hiding
 * the offer costs the designer the whole feature, while showing one that turns
 * out to be impossible costs a press and an honest sentence. That bargain is
 * only sound if the sentence is legible — and it was written into the collapsed
 * fold, so a page newer than the process serving it produced a primary button
 * that did nothing at all, instantly, forever. "Press Sign in, nothing happens"
 * is the bug report verbatim.
 *
 * Two claims here, and the second is not decoration: this sentence is about the
 * PROCESS rather than about this dialog, it is fixed in a terminal, and the
 * next thing a designer does with a button that appears dead is close the
 * dialog. So it is toasted as well as printed, and it outlives the surface that
 * raised it.
 */
await check("a server too old to know the route says so where it can be read", async () => {
  await refuseWalledAdd()
  server.staleSignIn = true
  toasts.length = 0

  click(one("signin-open"))
  await settle(8)
  server.staleSignIn = false

  const said = one("signin-error")
  assert.ok(visible(said), "the route is missing and the dialog says nothing a designer can see")
  assert.match(
    said.textContent,
    /Restart designlayer/,
    `the stale-server sentence was lost on the way: ${said.textContent}`
  )
  assert.doesNotMatch(
    said.textContent,
    /No designlayer route/,
    "the router's own words about its routing table reached a designer"
  )
  assert.ok(
    toasts.some(([message]) => /Restart designlayer/.test(message)),
    `news about the whole process died with the dialog: ${JSON.stringify(toasts)}`
  )
  assert.ok(visible(one("signin-open")), "the offer did not come back after an instant failure")
  dismissSignIn()
})

/*
 * And the minute before either of those, which used to be nine unchanging
 * words.
 *
 * "Opening the sign-in window. Finish there and this closes itself." is true on
 * the first frame and on the last, which means it reports that something is
 * happening and never that it is getting anywhere. A reader who has been
 * looking at it for a minute concludes the button is broken — so it moves once,
 * and what it moves to is the fact that there is a door.
 */
await check("a wait that drags on stops saying the same nine words", async () => {
  await refuseWalledAdd()
  const gate = holdSignIn()
  // Only the nudge: the deadline is minutes away and must not fire, or this
  // would be reading the give-up copy instead of the escalation.
  const restore = hurryTimers(60_000)

  click(one("signin-open"))
  await settle(8)
  restore()

  const seen = visibleWords()
  assert.ok(signInShown(), "the dialog gave up rather than escalating")
  assert.equal(gate.aborted, false, "the nudge aborted a sign-in that had not run out")
  assert.doesNotMatch(
    seen,
    /Finish there and this closes itself/,
    `a minute in, the wait is still saying its opening line: ${seen}`
  )
  assert.match(seen, /cancel/i, `the long wait does not mention the way out: ${seen}`)

  click(one("signin-cancel"))
  await settle(6)
  dismissSignIn()
})

/*
 * THE SECOND HALF OF THE "STUCK" REPORT, AND IT IS A DIFFERENT BUG.
 *
 * Close during a sign-in used to leave `signInWaiting` set — every other piece
 * of the dialog's state was reset and that one was not — so the NEXT wall
 * opened on a dialog whose primary button was already disabled and already read
 * "Waiting…", for a request it had no part in. The only control that did
 * anything was Close, and doing it again reproduced it exactly. That is a dead
 * end a designer cannot reason their way out of, and it recurs until the first
 * request finally settles, up to six minutes later.
 *
 * The fix is not to clear a flag harder. The wait is derived from which run the
 * dialog is attached to, so a fresh dialog cannot inherit one — and because the
 * server drives a single browser profile, the honest thing for it to say is
 * whose sign-in is in the way, with the control that clears it.
 */
await check("closing during a sign-in does not leave the next dialog waiting on it", async () => {
  await refuseWalledAdd()
  const gate = holdSignIn()
  click(one("signin-open"))
  await settle(6)
  click(one("signin-dismiss"))
  one("url").value = ""
  assert.equal(signInShown(), false, "Close left the dialog open")

  // A different site's wall, with the first sign-in still outstanding.
  await refuseAdd(REDIRECT_WALL)

  const opener = one("signin-open")
  assert.equal(
    opener.disabled && visible(opener),
    false,
    "a fresh dialog opened disabled, waiting on a sign-in it did not start"
  )
  assert.doesNotMatch(
    visibleWords(),
    /Waiting/,
    `a new wall is reporting the last one's wait: ${visibleWords()}`
  )
  // What it says instead: whose sign-in is holding the queue, and why there is
  // one. Two of these racing produce "the browser did not open", because both
  // launch the same Chrome profile.
  assert.match(
    visibleWords(),
    new RegExp(`sign-in for ${new URL(WALL.origin).host} first`),
    `the dialog does not say what is in the way: ${visibleWords()}`
  )
  const cancel = one("signin-cancel")
  assert.ok(visible(cancel), "the dialog names the sign-in in the way and cannot clear it")

  click(cancel)
  await settle(6)
  assert.ok(gate.aborted, "cancelling from the second dialog never reached the first request")

  // And now this dialog can do its own job.
  const offer = one("signin-open")
  assert.ok(visible(offer), "clearing the queue left the dialog with no offer of its own")
  assert.equal(offer.disabled, false, "the offer came back disabled")
  assert.match(offer.textContent, /sign in/i, `the offer lost its label: ${offer.textContent}`)
  dismissSignIn()
})

/*
 * THE ERRAND OUTLIVES THE DIALOG.
 *
 * `pendingAdd` used to be read AFTER the await — five minutes after, on the
 * worst path — so it was whatever the dialog happened to be holding when the
 * answer came back rather than the add the sign-in was started for. Close the
 * dialog while waiting, finish signing in anyway in the window that is still
 * open, and the editor toasted "Signed in to vault.example.com" and quietly
 * never added the library. The designer is told it worked and gets nothing, and
 * the URL is still sitting in the box with nothing saying it needs pressing
 * again.
 *
 * Captured before the await, the request carries its own errand and finishes it.
 */
await check("a sign-in that lands after the dialog was closed still adds the library", async () => {
  await refuseWalledAdd()
  const gate = holdSignIn()
  click(one("signin-open"))
  await settle(6)

  click(one("signin-dismiss"))
  assert.equal(signInShown(), false, "Close left the dialog open")

  toasts.length = 0
  const before = server.calls.length
  gate.release({ ok: true })
  await settle(12)

  const after = server.calls.slice(before)
  const added = after.find((call) => call.method === "POST" && call.path === "/libraries")
  assert.ok(added, "the add the sign-in was started for was dropped when the dialog closed")
  assert.equal(added.body?.url, WALL.url, "the replay posted a link nobody asked about")
  assert.ok(
    toasts.some(([message]) => /signed in/i.test(message)),
    `nothing said the sign-in worked: ${JSON.stringify(toasts)}`
  )
  assert.equal(one("url").value, "", "the URL box kept a link that is now a row above it")
})

/*
 * And the last thing that claimed an outcome it did not get.
 *
 * `DELETE /libraries/auth` answers `{forgotten}` — false when there was nothing
 * of that origin to drop — and the panel ignored the boolean: it removed the
 * row and toasted "Forgot the sign-in for X" either way. The one time that is
 * wrong is the one time it matters, because the two sides have disagreed about
 * what is stored and the interface has just said the sentence that stops the
 * designer looking into it.
 */
await check("Forget does not claim a credential the server did not have", async () => {
  assert.ok(one("signed-in"), "the previous case left no credential to forget")
  // The server loses it behind the panel's back, which is the disagreement this
  // is about: a second editor, a restart, a hand-edited store.
  server.credentials = []
  toasts.length = 0

  click(control("forget", WALL.origin))
  await settle(8)

  assert.equal(
    toasts.some(([message]) => /^Forgot the sign-in/.test(message)),
    false,
    `the panel claimed an outcome the server refused: ${JSON.stringify(toasts)}`
  )
  assert.ok(
    toasts.some(([message]) => /was not holding/i.test(message)),
    `nothing said what actually happened: ${JSON.stringify(toasts)}`
  )
  // Re-read from the server rather than asserted from here: the list on screen
  // is now the list the server answered with, whatever that turned out to be.
  assert.equal(one("signed-in"), null, "the row survived a list the server says is empty")
})

/*
 * JSDOM does no layout, so this reads the rules rather than measuring a box.
 * Both folds are one-column grids, and a grid with no column template sizes
 * its implicit track to the content's min-content width: a nowrap URL in the
 * Libraries card or a file path in the candidate drawer pushed the whole
 * section past the panel edge, clipping the switch and delete controls and
 * stopping every ellipsis from firing.
 */
await check("the section fold and the libraries drawer are held to the panel width", () => {
  const rule = (file, selector) => {
    const css = readFileSync(join(PACKAGE_DIR, "src/core/css", file), "utf8")
    const found = new RegExp(`^${selector.replace(/[.>]/g, "\\$&")} \\{\\n([\\s\\S]*?)\\n\\}`, "m").exec(css)
    assert.ok(found, `${selector} is missing from ${file}`)
    return found[1]
  }
  for (const [file, grid, item] of [
    ["panels.ts", ".de-section-fold", ".de-section-fold > .de-section-body"],
    ["libraries.ts", ".de-lib-drawer", ".de-lib-panel"],
  ]) {
    assert.match(rule(file, grid), /grid-template-columns: minmax\(0, 1fr\)/, `${grid} has no zero floor on its column`)
    assert.match(rule(file, item), /min-width: 0/, `${item} can still grow past its track`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
