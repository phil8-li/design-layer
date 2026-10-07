/**
 * Added libraries in the browser: the cache, the calls that change it, and the
 * merge that folds what is enabled into the catalog every panel already reads.
 *
 * The merge is the whole feature. Nothing in the inspector knows libraries
 * exist — `tokensForProperty`, `authoredTokenMatches` and `computedTokenMatches`
 * take a registry, that registry now comes from `activeDesignSystem()`, and a
 * library's colour reaches the fill picker by being in the array the fill
 * picker was always walking. Every alternative to that costs the same thing
 * twice: a second list beside the host's is a second sort order, a second
 * grouping, a second set of matching rules, and a second place for the answer
 * to be wrong. So this module produces ONE catalog and the rest of the editor
 * is left exactly as it was.
 *
 * Three properties of the merge are load-bearing rather than tidy:
 *
 *  - **zero libraries costs nothing.** With nothing enabled — which is nearly
 *    every session — `activeDesignSystem()` hands back `config.designSystem`
 *    itself, the same object, not a copy of it. A rebuilt-but-equal catalog on
 *    every inspector render would be invisible to a `deepEqual` and fatal to a
 *    `===`, and it would rebuild a whole token index for every frame of a
 *    number scrub.
 *  - **ids are prefixed with the library they came from.** `color:brand-500` is
 *    the most ordinary name a design system has, so two libraries shipping it
 *    is the normal case. `tokenIndex` in `core/design-system.ts` keys by id, and
 *    an unprefixed collision there does not throw: the picker keeps showing
 *    both rows and one of them starts writing the other's variable.
 *  - **the host's own tokens are untouched.** They are concatenated first and
 *    never copied, so a host token can never come back stamped with a library,
 *    and the four groups a library may not contribute to — breakpoints,
 *    container breakpoints, responsive measures and aliases — are passed
 *    through by reference. Breakpoints are a compile-time fact of the host's
 *    build; a prefix borrowed from a library would compile to nothing.
 *
 * Loading follows `core/icon-set.ts` exactly, for the reasons stated there: one
 * shared in-flight promise, a warning and an empty answer on failure, and a
 * failure that is never cached — a dev server that was still starting has to be
 * askable again. Mutations are the opposite and REJECT, because every one of
 * them is a button a person just pressed and the panel has to be able to say so.
 */

import { config, type DesignSystemCatalog, type DesignSystemToken } from "../core/config"
import type { IconVariant } from "../core/icon-set"
import type {
  Library,
  LibraryCandidate,
  LibraryChallenge,
  LibraryComponent,
  LibraryCredentialScheme,
  LibraryIconDrawing,
  LibrarySignIn,
  LibrarySourceKind,
} from "./types"

/** A library's component, told apart from the others by who shipped it. */
export type LibraryComponentEntry = LibraryComponent & { library: string; libraryName: string }

let cache: Library[] = []
let loaded = false
let inFlight: Promise<Library[]> | null = null

const listeners = new Set<() => void>()

/* ---------- the wire ---------- */

function endpoint(apiBase: string, path = ""): string {
  return `${apiBase}/libraries${path}`
}

/**
 * A refusal that named a sign-in wall, carrying the wall with it.
 *
 * An `Error` SUBCLASS rather than a second return channel out of `addLibrary`,
 * because a challenge is a failure and every caller already has a `catch`. A
 * result union would make the ordinary path — add a library, show a row — carry
 * a check for a case that happens to one add in a hundred, and the one call
 * site that forgot the check would silently install nothing and say nothing.
 *
 * The challenge is a real property rather than something the panel digs out of
 * a response it no longer has: `send` reads the body once and it is gone, so if
 * this did not hold it, nothing downstream could. `instanceof` is the test —
 * `target: ES2022` makes that work on a subclass, which it does not under a
 * downlevelled build, and this package compiles to ES2022 or it does not
 * compile.
 */
export class LibraryAuthError extends Error {
  readonly auth: LibraryChallenge

  constructor(message: string, auth: LibraryChallenge) {
    super(message)
    this.name = "LibraryAuthError"
    this.auth = auth
  }
}

/**
 * The five walls `classifyWall` can tell apart. Anything else is not one.
 *
 * Each is a mechanism the HTTP or OAuth standards define, which is what makes
 * the list closed: the server reads a refusal by its status, its
 * `WWW-Authenticate` scheme and the shape of its redirect, so there is no sixth
 * answer it can produce and no vendor whose stack adds one.
 */
const WALL_KINDS: ReadonlyArray<LibraryChallenge["kind"]> = [
  "oauth",
  "basic",
  "bearer",
  "redirect",
  "forbidden",
]

/**
 * A challenge off the wire, or null for a body that did not carry one.
 *
 * Validated on `kind` alone and then read field by field, because `kind` is the
 * only part the panel BRANCHES on — it picks the default credential scheme and
 * the label — while the other four are strings it prints. A missing string
 * prints as nothing, which is the correct degradation for a hint or for a field
 * the refusal simply did not name; a `kind` this build does not know would
 * silently take the branch belonging to whichever one happened to be first.
 */
function challengeOf(value: unknown): LibraryChallenge | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const kind = WALL_KINDS.find((known) => known === raw.kind)
  if (!kind) return null
  const text = (key: string): string => {
    const held = raw[key]
    return typeof held === "string" ? held : ""
  }
  return {
    kind,
    origin: text("origin"),
    audience: text("audience"),
    realm: text("realm"),
    // An older server does not send it; "" then means "nobody named", which is
    // exactly how the panel treats an unrecognised provider anyway.
    location: text("location"),
    hint: text("hint"),
    url: text("url"),
  }
}

/**
 * THE ONE SERVER SENTENCE A DESIGNER MUST NEVER BE SHOWN, and what to say
 * instead.
 *
 * `routes.mjs` answers an unknown path with "No designlayer route for POST
 * /__designlayer/…". That is the correct thing to tell a developer and the
 * worst thing to tell the person this editor is for: it names an internal
 * routing table, it reads like a crash, and it gives no action.
 *
 * It is also not a rare case. The browser bundle is re-read from `dist/` on
 * every page load, so the UI is always current; the server's routes are loaded
 * into the Node process ONCE, at launch. Pull a change that adds a route, reload
 * the page, and the two halves are a version apart — a new button calling an
 * endpoint the running server has never heard of. Measured exactly that way
 * here: an editor started before `library-signin.mjs` existed serves the newest
 * sign-in UI and answers its route with a 404, so "Sign in to this site" fails
 * with a sentence about routing.
 *
 * Detected by the shape of the message rather than by the status, because a 404
 * is also how "no such library" comes back and that one IS about the user's
 * own action. This names the single string the router writes for a path it does
 * not know.
 */
const STALE_SERVER =
  "This needs a restart. Restart designlayer in your terminal, then try again."

function isStaleServer(message: string): boolean {
  return /^No designlayer route for /i.test(message)
}

/**
 * Whether a failure that reached a panel is THAT one, so a surface can treat it
 * as news about the process rather than about the button that was pressed.
 *
 * The substitution above happens deep inside `failure()`, and what comes out
 * the other side is an ordinary `Error` carrying a sentence — indistinguishable,
 * at the call site, from "that credential was refused". The two want different
 * handling: a refused credential belongs on the dialog that asked for it and
 * dies with that dialog, while "your server is a version behind" is true of the
 * whole editor, survives every dialog being closed, and is fixed in a terminal.
 * The sign-in flow toasts it as well as printing it for exactly that reason.
 *
 * Compared against the constant rather than re-testing the wire shape, because
 * by this point the wire's own words are gone — `failure()` replaced them. One
 * string, one comparison, and no second regex to keep in step with the first.
 */
export function isStaleServerNotice(message: string): boolean {
  return message === STALE_SERVER
}

/**
 * The server's own words for a failure, and a status code only when it had none.
 *
 * Worth the read of the body: every error this endpoint produces is about a
 * path the user just typed — it escapes the project, it is not a design system,
 * there are already twenty — and those sentences are the entire help available
 * at the moment of the mistake. "HTTP 400" in a toast is a dead end.
 *
 * A body that also carries `auth` is the one refusal with a way out of it, so
 * it comes back as a `LibraryAuthError`. Read here rather than in `addLibrary`
 * because this is the only place the body is parsed at all, and the check is
 * cheap enough to run for every route: a response that has no `auth` produces
 * exactly the `Error` it always did.
 */
async function failure(response: Response): Promise<Error> {
  let stated = ""
  let challenge: LibraryChallenge | null = null
  try {
    const payload = (await response.json()) as {
      message?: unknown
      error?: unknown
      auth?: unknown
    }
    const message = payload.message ?? payload.error
    if (typeof message === "string") stated = message.trim()
    challenge = challengeOf(payload.auth)
  } catch {
    // A body that is not JSON has nothing in it a person can act on.
  }
  if (isStaleServer(stated)) return new Error(STALE_SERVER)
  const said = stated || `The designlayer server answered ${response.status}. Check its terminal, then try again.`
  return challenge ? new LibraryAuthError(said, challenge) : new Error(said)
}

async function send<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as T
}

/* ---------- the cache ---------- */

/**
 * Subscribers are notified synchronously, inside the same task as the write.
 *
 * The panel re-renders from `libraryList()` on every beat, so a deferred notify
 * would leave the list one mutation behind for a frame — and the one frame a
 * user is looking hardest at a switch is the frame after they pressed it.
 */
export function subscribeToLibraries(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** The libraries this session knows about. Empty before the first load. */
export function libraryList(): Library[] {
  return cache
}

/**
 * Folds one library from a response into the cache.
 *
 * The response is the truth, always — an added library comes back with the
 * catalog the server just parsed, and a toggled one comes back with the flag
 * the server actually wrote. A client that kept its own idea of `enabled` and
 * only asked the server to agree would drift the first time a write was refused.
 */
function adopt(library: Library): Library {
  const known = cache.some((entry) => entry.id === library.id)
  cache = known
    ? cache.map((entry) => (entry.id === library.id ? library : entry))
    : [...cache, library]
  notify()
  return library
}

export function loadLibraries(apiBase: string): Promise<Library[]> {
  if (loaded) return Promise.resolve(cache)
  inFlight ??= send<{ libraries?: Library[] }>(endpoint(apiBase))
    .then((payload) => {
      cache = Array.isArray(payload.libraries) ? payload.libraries : []
      loaded = true
      notify()
      return cache
    })
    .catch((error: unknown) => {
      console.warn("[designlayer] could not load the added libraries", error)
      // Not cached, and `loaded` is left alone: the next surface to ask gets a
      // real request rather than the empty list this one settled for.
      inFlight = null
      return []
    })
  return inFlight
}

/**
 * The same load, past the cache.
 *
 * The list endpoint re-reads and re-parses every source file it points at, so
 * this is how a designer who just edited their own token CSS sees the new token
 * without restarting anything.
 */
export function refreshLibraries(apiBase: string): Promise<Library[]> {
  loaded = false
  inFlight = null
  return loadLibraries(apiBase)
}

export function discoverLibraries(apiBase: string): Promise<LibraryCandidate[]> {
  return send<{ candidates?: LibraryCandidate[] }>(endpoint(apiBase, "/available")).then(
    (payload) => (Array.isArray(payload.candidates) ? payload.candidates : [])
  )
}

/**
 * A path inside the project, or a URL on the internet — one or the other.
 *
 * Both are optional in the type rather than a union, because the server owns
 * the rule about which one it was handed and answers a body with neither in the
 * same sentence it answers a bad path with. A union here would move that
 * decision into the browser, where it would have to be kept in step with the
 * server's version of it.
 *
 * REJECTS WITH `LibraryAuthError` when the URL is behind a sign-in wall, and
 * the panel is expected to catch that case by name. Nothing is installed in
 * that event — the server refuses a walled URL rather than storing a row that
 * reports zero colours — so there is no library here to hang the problem on and
 * the error is the only carrier the challenge has.
 */
export function addLibrary(
  apiBase: string,
  input: { path?: string; url?: string; kind?: LibrarySourceKind; name?: string }
): Promise<Library> {
  return send<{ library: Library }>(endpoint(apiBase), {
    method: "POST",
    body: JSON.stringify(input),
  }).then((payload) => adopt(payload.library))
}

export function setLibraryEnabled(
  apiBase: string,
  id: string,
  enabled: boolean
): Promise<Library> {
  return send<{ library: Library }>(endpoint(apiBase, `/${encodeURIComponent(id)}`), {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  }).then((payload) => adopt(payload.library))
}

export function removeLibrary(apiBase: string, id: string): Promise<void> {
  return send<{ ok?: boolean }>(endpoint(apiBase, `/${encodeURIComponent(id)}`), {
    method: "DELETE",
  }).then(() => {
    cache = cache.filter((entry) => entry.id !== id)
    notify()
  })
}

/* ---------- signing in ---------- */

/**
 * The three sign-in calls, and the one thing they deliberately do NOT do:
 * remember anything.
 *
 * There is no cache under this section and there is not going to be one. A
 * credential lives in one place — a 0600 file beside the server's own state —
 * and the browser is the side of the loopback a screen recording, a shared
 * screen and a `console.log` all happen on. So the panel asks when it needs to
 * know, and what comes back is a list of ORIGINS with no secrets in it.
 *
 * The second reason is correctness rather than secrecy: the server verifies a
 * credential against the live site before it stores one, so a cached "signed
 * in" in the browser would be a claim this side has no way to re-check. The
 * only thing that may make the panel say a designer is signed in is a 200 from
 * the endpoint below, which by construction happened after the wall opened.
 *
 * `libraries/auth` is a fixed path rather than an id route for the reason
 * `routes.mjs` gives at length: the resource is the ORIGIN, not the library.
 * Two deep links into one Storybook are two libraries and one sign-in.
 */
function authEndpoint(apiBase: string): string {
  return endpoint(apiBase, "/auth")
}

/** Every origin this editor holds a credential for. Never the credentials. */
export function librarySignIns(apiBase: string): Promise<LibrarySignIn[]> {
  return send<{ origins?: LibrarySignIn[] }>(authEndpoint(apiBase)).then((payload) =>
    Array.isArray(payload.origins) ? payload.origins : []
  )
}

/**
 * Hands a credential to the server, which VERIFIES it before storing it.
 *
 * Takes the `url` the add was refused for rather than the origin it will be
 * filed under, because the verification is a real fetch of that exact address:
 * an origin's front page can be public while the Storybook under it is not, so
 * probing the origin would happily accept a credential that does not open the
 * thing the designer actually asked for.
 *
 * A rejection here is the server saying the wall did not open. That is the only
 * honest failure mode this call has, and it is why the panel may treat a
 * resolved promise as proof of a working sign-in.
 */
export function signInToLibrary(
  apiBase: string,
  input: { url: string; scheme: LibraryCredentialScheme; value: string }
): Promise<LibrarySignIn> {
  return send<LibrarySignIn>(authEndpoint(apiBase), {
    method: "POST",
    body: JSON.stringify(input),
  })
}

/**
 * Signs in by opening the SITE'S OWN sign-in in a browser window, and comes
 * back when the session that produces has been verified and stored.
 *
 * The long wait is the point rather than a flaw: the promise is outstanding for
 * as long as the person is in front of the provider's login, which can be a
 * minute of typing a password and approving a phone prompt. So the panel shows
 * a waiting state instead of a spinner-and-hope, and the server bounds the wait
 * rather than leaving the request open forever.
 *
 * Unlike `signInToLibrary`, a refusal comes back as `ok: false` with a sentence
 * rather than as a rejection. Closing the window is an ordinary thing a person
 * does, and an exception is the wrong shape for "you changed your mind".
 *
 * ## The signal is not optional politeness, it is the only way out
 *
 * This is the longest request the editor makes by a wide margin — the server
 * budgets twenty seconds to launch a browser, forty-five to try the saved
 * profile silently, another twenty to launch again, four minutes for a human at
 * their provider, and fifteen for the verification fetch afterwards, which is
 * the better part of six minutes with nothing coming back down the wire. A
 * caller with no `signal` has precisely two options while that runs: wait, or
 * lie to the user about having stopped. The first is what shipped and is the
 * "the dialog is stuck" report; the second is worse, because the browser window
 * is still up and the credential may still land.
 *
 * Passing it through `init` rather than adding a parameter to `send`: `fetch`
 * already takes `signal` on the init object, `send` spreads whatever it is
 * given, so the abort reaches the transport with no new plumbing. The rejection
 * that comes back on abort is the platform's `AbortError`, which is NOT a
 * sentence to show anybody — the caller knows it asked, and says its own thing.
 */
export function openProviderSignIn(
  apiBase: string,
  url: string,
  options: { signal?: AbortSignal } = {}
): Promise<{ ok: boolean; reason?: string; provider?: string; origin?: string; scheme?: LibraryCredentialScheme; addedAt?: number }> {
  return send(`${authEndpoint(apiBase)}/signin`, {
    method: "POST",
    body: JSON.stringify({ url }),
    signal: options.signal,
  })
}

/**
 * Whether this machine has a browser the editor can open a sign-in in.
 *
 * UNKNOWN COUNTS AS YES, and that asymmetry is deliberate. Hiding the offer
 * costs the designer the whole point of the flow — they are left with the token
 * fold, which is the thing this replaced — while showing one that turns out to
 * be impossible costs a press and an honest sentence from the server. So only
 * an explicit `available: false` withdraws it; a request that failed, or a
 * server too old to know the route, leaves it standing.
 */
export async function canOpenProviderSignIn(apiBase: string): Promise<boolean> {
  try {
    const answer = await send<{ available?: boolean }>(`${authEndpoint(apiBase)}/signin`, {
      method: "GET",
    })
    return answer?.available !== false
  } catch {
    return true
  }
}

/**
 * Drops an origin's credential. Answers whether there was one to drop.
 *
 * The origin rides in the BODY of a DELETE, which is unusual enough to be worth
 * the sentence: an origin contains a colon and two slashes, and a path segment
 * holding an encoded URL is a thing the client and the server then have to
 * agree about how to unescape. `routes.mjs` reads it from the body for the same
 * reason `/lint/ignore` does.
 */
export function forgetLibrarySignIn(apiBase: string, origin: string): Promise<boolean> {
  return send<{ forgotten?: boolean }>(authEndpoint(apiBase), {
    method: "DELETE",
    body: JSON.stringify({ origin }),
  }).then((payload) => payload.forgotten === true)
}

/* ---------- the merge ---------- */

/**
 * The eight groups a library may contribute to, and the four it may not.
 *
 * Breakpoints and container breakpoints are what the host's build compiles and
 * nothing else; responsive measures and aliases describe the host's own source.
 * A library has no standing to add to any of them, so they are not in this list
 * and are carried over by reference instead.
 */
const TOKEN_GROUPS = [
  "colors",
  "spacing",
  "radii",
  "textStyles",
  "uiTextStyles",
  "effects",
  "icons",
  "motion",
] as const

type TokenGroup = (typeof TOKEN_GROUPS)[number]

function enabledLibraries(): Library[] {
  return cache.filter((library) => library.enabled)
}

/** Identity, not equality: every write replaces the record it changed. */
function sameLibraries(a: readonly Library[], b: readonly Library[]): boolean {
  return a.length === b.length && a.every((library, index) => library === b[index])
}

/**
 * A library's tokens, COPIED and named for where they came from.
 *
 * Copied rather than renamed in place because the cached library still has to
 * describe itself the way the server sent it: a second merge over a mutated
 * record would prefix an already-prefixed id, and the card in the Libraries tab
 * would start reading `src-styles-theme-css/color:brand-500` back to a designer
 * who wrote `--brand-500`. Only `id` moves; `name` is what a human reads in the
 * picker and it stays exactly as the library spelled it.
 */
function stamped(library: Library, group: TokenGroup): DesignSystemToken[] {
  return library.catalog[group].map((token) => ({
    ...token,
    id: `${library.id}/${token.id}`,
    library: library.id,
    libraryName: library.name,
  }))
}

function mergeCatalog(enabled: readonly Library[]): DesignSystemCatalog {
  const host = config.designSystem
  // Spread first, so everything a library cannot contribute to — breakpoints,
  // container breakpoints, responsive measures, aliases, the tracking unit —
  // arrives by reference and is provably the host's own.
  const merged: DesignSystemCatalog = { ...host, name: host.name ?? enabled[0].name }
  for (const group of TOKEN_GROUPS) {
    merged[group] = [...host[group], ...enabled.flatMap((library) => stamped(library, group))]
  }
  return merged
}

let mergeKey: readonly Library[] = []
let mergeValue: DesignSystemCatalog = config.designSystem

/** The host's own catalog with every ENABLED library folded into it. */
export function activeDesignSystem(): DesignSystemCatalog {
  const enabled = enabledLibraries()
  // Memoised on the enabled list rather than on a counter, because the panel
  // re-renders the whole inspector on every store beat and most of those beats
  // change nothing this function can see.
  if (sameLibraries(enabled, mergeKey)) return mergeValue
  mergeKey = enabled
  mergeValue = enabled.length ? mergeCatalog(enabled) : config.designSystem
  return mergeValue
}

/* ---------- glyphs ---------- */

let iconCache: IconVariant[] = []
let iconKey: readonly Library[] | null = null
let iconsInFlight: Promise<IconVariant[]> | null = null

/** Only a library that actually ships drawings is worth a request. */
function glyphLibraries(): Library[] {
  return cache.filter((library) => library.enabled && library.counts.iconDrawings > 0)
}

/**
 * The attribute enabled libraries name their glyphs with, "" when none does.
 *
 * First one wins, and two libraries disagreeing is not a case worth resolving:
 * the attribute is how a selected `<svg>` says which icon it is, a page has one
 * convention for that, and a second answer would only change which of two
 * libraries a selection is read against.
 */
export function libraryIconAttribute(): string {
  for (const library of enabledLibraries()) {
    if (library.catalog.iconAttribute) return library.catalog.iconAttribute
  }
  return ""
}

/** One library's drawings, or null when the request failed. */
function fetchGlyphs(apiBase: string, library: Library): Promise<IconVariant[] | null> {
  return send<{ icons?: LibraryIconDrawing[] }>(
    endpoint(apiBase, `/${encodeURIComponent(library.id)}/icons`)
  )
    .then((payload) =>
      (payload.icons ?? []).map((drawing) => ({
        name: drawing.name,
        nodes: drawing.nodes,
        rootFill: drawing.rootFill || "currentColor",
        rootStroke: drawing.rootStroke,
        glyph: drawing.glyph,
      }))
    )
    .catch((error: unknown) => {
      console.warn(`[designlayer] could not load ${library.name}'s icons`, error)
      return null
    })
}

/**
 * Enabled libraries' glyphs, fetched once per set of them.
 *
 * Keyed on which libraries are on rather than loaded once forever: turning one
 * off has to take its glyphs out of the picker, and the cache would otherwise
 * keep offering an icon the editor can no longer name.
 */
export function loadLibraryIcons(apiBase: string): Promise<IconVariant[]> {
  const wanted = glyphLibraries()
  if (iconKey && sameLibraries(wanted, iconKey)) return iconsInFlight ?? Promise.resolve(iconCache)
  iconKey = wanted
  iconCache = []
  iconsInFlight = null
  if (!wanted.length) return Promise.resolve(iconCache)
  iconsInFlight = Promise.all(wanted.map((library) => fetchGlyphs(apiBase, library))).then(
    (sets) => {
      const icons = sets.flatMap((set) => set ?? [])
      iconsInFlight = null
      // A failure is handed to this caller and remembered by nobody: dropping
      // the key is what makes the next picker open ask again.
      if (sets.some((set) => set === null)) iconKey = null
      else iconCache = icons
      return icons
    }
  )
  return iconsInFlight
}

/** What is already loaded, for a synchronous render that must not wait. */
export function loadedLibraryIcons(): IconVariant[] {
  return iconKey && sameLibraries(glyphLibraries(), iconKey) ? iconCache : []
}

/* ---------- components ---------- */

/** Every component an enabled library declares, stamped with its owner. */
export function libraryComponents(): LibraryComponentEntry[] {
  return enabledLibraries().flatMap((library) =>
    library.catalog.components.map((component) => ({
      ...component,
      library: library.id,
      libraryName: library.name,
    }))
  )
}

/**
 * The element tags a component answers to, lowercased.
 *
 * Falling back to the snippet's opening tag is worth the regex because a
 * manifest-sourced component often has a snippet and no selector, and without
 * this the component section never lights up on the host it was written for.
 * The hyphen test is what keeps that safe: a tag containing one is a custom
 * element and can only be this component, while a React snippet opens
 * `<Button`, which lowercases to `button` and would otherwise claim every plain
 * button on the page.
 *
 * Exported because the match is not the only thing that needs these tags. The
 * instance section needs them to find a component's HOST: a click inside an
 * Angular component lands on a node in its template, and the inputs the library
 * documents — `variant="filled"` — are on the host tag above it. Deriving the
 * tag list a second time over there would be two answers to "what is this
 * component called in the DOM", and the snippet fallback above is exactly the
 * sort of rule that gets left out of the copy.
 */
export function componentSelectors(component: LibraryComponent): string[] {
  return selectorsOf(component)
}

function selectorsOf(component: LibraryComponent): string[] {
  const opening = /^<([a-z][\w.-]*-[\w.-]*)/i.exec(component.snippet?.trim() ?? "")
  const declared = component.selector ?? (opening ? opening[1] : "")
  return declared
    .split(",")
    .map((part) => /^\s*([a-z][\w-]*)/i.exec(part)?.[1]?.toLowerCase() ?? "")
    .filter(Boolean)
}

/**
 * The components that could describe this element, best first.
 *
 * Two joins, because the two frameworks leave different evidence. A React
 * component is named — the bridge reports `Button`, the library documents
 * `Button` — and the case is a spelling accident of whichever side wrote it
 * down. An Angular component is TAGGED: the DOM node is literally
 * `<x-button>`, which is the selector the library declared, and that is a much
 * stronger bond than the name is. Name matches come first because a name is
 * what a reader was looking at when they selected the thing.
 */
export function libraryComponentsFor(
  componentName: string,
  tagName: string
): LibraryComponentEntry[] {
  const name = componentName.trim().toLowerCase()
  const tag = tagName.trim().toLowerCase()
  const index = componentIndex()
  const named = name ? index.byName.get(name) ?? [] : []
  const tagged = tag ? (index.byTag.get(tag) ?? []).filter((entry) => !named.includes(entry)) : []
  return [...named, ...tagged]
}

/**
 * Both joins above, indexed once per state of the cache.
 *
 * The Design tab asks on every render, and answering by re-stamping every
 * component of every library and running the snippet regex over each one was
 * work repeated for nothing: the cache is replaced, never mutated, so its
 * identity says when the answer can change. Each list keeps catalog order, so
 * the result is the one the two filters produced.
 */
let indexed: {
  of: Library[]
  byName: Map<string, LibraryComponentEntry[]>
  byTag: Map<string, LibraryComponentEntry[]>
} | null = null

function componentIndex(): NonNullable<typeof indexed> {
  if (indexed?.of === cache) return indexed
  const byName = new Map<string, LibraryComponentEntry[]>()
  const byTag = new Map<string, LibraryComponentEntry[]>()
  const add = (map: Map<string, LibraryComponentEntry[]>, key: string, entry: LibraryComponentEntry) => {
    const list = map.get(key)
    if (list) list.push(entry)
    else map.set(key, [entry])
  }
  for (const entry of libraryComponents()) {
    add(byName, entry.name.trim().toLowerCase(), entry)
    for (const tag of new Set(selectorsOf(entry))) add(byTag, tag, entry)
  }
  return (indexed = { of: cache, byName, byTag })
}
