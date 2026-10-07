/**
 * Libraries: which design systems this project can borrow from, and which of
 * them the rest of the editor is allowed to offer.
 *
 * It is a SECTION on the right panel's Design system tab now, built with the
 * same `section()` every block on the Design tab is built with, so it folds,
 * aligns and spaces exactly like Fill and Typography. Two surfaces were folded
 * into it and one was deleted outright, which is the thing a reader arriving
 * here needs told first:
 *
 *  - the library MANAGER, a dialog opened from the old Assets panel's header,
 *    is this section. Same store, same six calls, same switch;
 *  - the Assets BROWSER — the component grid, the cards, the thumbnails, the
 *    group and library drill-down, the search box, the details popover, "Insert
 *    instance" and drag-to-insert — is gone, deliberately and by request. It is
 *    not hiding behind a fold here and it has not moved somewhere else.
 *
 * **The catalog itself is untouched.** Deleting the browser removed a way of
 * LOOKING at the components an enabled library publishes; it removed nothing
 * from the catalog those components live in. `activeDesignSystem()` still folds
 * every enabled library's tokens into the one catalog the fill picker, the
 * text-style field, the radius field and the icon picker all read, and
 * `libraryComponents()` still feeds the Design tab's instance properties. Turn
 * a library on here and all of that grows its contents on the next repaint;
 * turn it off and they lose them. That is the whole of what this section is
 * for, and it is why the empty state says it in words.
 *
 * ## The two ways in, and why they are not peers
 *
 * A URL is the CTA: a design system published on the web, or a Storybook, is
 * one paste and the server does the rest. A file in this project is a fold
 * underneath it, because it is the rarer act and its flow is two controls wide
 * — a scan of the project, and a path box for the file the scan missed. It is
 * kept because the URL box genuinely cannot do it: a designer's own
 * `tokens.css` has no address, and dropping the fold would take the only route
 * to it with it.
 *
 * ## The one thing here that is not in the panel
 *
 * A link behind a sign-in wall is refused, and answering it is a MODAL — a real
 * `<dialog>` opened with `showModal()`, living on `document.body` rather than
 * in this column. Everything else on this surface is a list or a box you can
 * ignore; that one is a question that has to be answered before the add the
 * designer already asked for can land, and it wants the width a 70-character
 * OAuth client id and an 800-character token actually need. The long version is
 * at the dialog's own construction, below the CTA.
 *
 * Nothing in this file parses a design system. It renders `Library` records and
 * calls the store, which is what keeps the surface swappable without touching
 * the parsing at either end.
 */

import { clear, el } from "../core/dom"
import { leaveRow } from "../core/leave"
import { holdScroll } from "../core/scroll"
import { focusControl } from "../core/focus"
import { playExit } from "../core/motion"
import { icon } from "../core/icons"
import { tokens } from "../core/tokens"
import { section } from "../panels/inspector/field"
import { copyLibrarySnippet } from "./snippet"
import {
  addLibrary,
  canOpenProviderSignIn,
  discoverLibraries,
  forgetLibrarySignIn,
  isStaleServerNotice,
  libraryList,
  LibraryAuthError,
  librarySignIns,
  loadLibraries,
  openProviderSignIn,
  removeLibrary,
  setLibraryEnabled,
  signInToLibrary,
  subscribeToLibraries,
} from "./store"
import type {
  Library,
  LibraryCandidate,
  LibraryChallenge,
  LibraryCredentialScheme,
  LibrarySignIn,
  LibrarySource,
  LibrarySourceKind,
} from "./types"
import type { EditorContext } from "../core/context"
import { formatDate } from "../core/format"

/**
 * A library as this section reads it: the wire record, plus the two fields the
 * URL route adds to it.
 *
 * Declared here rather than added to `Library` in `libraries/types.ts` for the
 * reason the old assets browser gave about the same kind of widening: this lane
 * does not own the file the URL route is landing in, and both fields are
 * optional, so a `Library` is assignable to this exactly as it stands and the
 * two converge without a coordinated edit. Until the server sends them the
 * fields are simply absent at run time and the row degrades the way it should —
 * no `detail` means the counts write the summary, and no `url` means the source
 * line is the path it always was.
 */
interface InstalledLibrary extends Library {
  /**
   * The server's own one-line description of a library it fetched over HTTP.
   *
   * Preferred over the counts for a URL library because the counts are a poor
   * description of one: a Storybook's worth is its components and its stories,
   * and the server is the only thing on either side that has read the index.
   */
  detail?: string
  source: LibrarySource & { url?: string }
}

/**
 * What an add is, as this section builds one: a path inside the project, or a
 * link on the internet.
 *
 * There used to be a cast beside this — `addLibrary` was narrowed here while
 * the lane that taught the store about `{ url }` was still in flight, with a
 * note saying the cast could go once the widening landed. It has landed, so it
 * has gone. The interface stays, because the section needs a NAME for an add it
 * is holding on to: a refused one is replayed after a sign-in, and "the input
 * that was refused" has to be storable in a variable.
 */
interface AddLibraryInput {
  path?: string
  kind?: LibrarySourceKind
  url?: string
}

/**
 * How many candidate rows are dealt out on a stagger before the rest simply
 * land together.
 *
 * The walk reads up to four thousand files and a monorepo can answer it with a
 * dozen candidates, so an uncapped stagger would spend most of a second
 * finishing an arrival nobody is waiting on any more — and the last row would
 * still be fading in after the reader had started reading the first. Five is
 * enough for the eye to register that the list is filling rather than
 * appearing; past that the effect has already been made and the delay is all
 * that is left. The step itself is in `css/libraries.ts`, which is the only
 * place that knows how long one is.
 */
const ARRIVAL_STEPS = 5

/** The four things `detectLibraryKind` knows how to read, said in one breath. */
const RECOGNISED =
  "Looks for manifests, token files (DTCG, Style Dictionary), icon sets and CSS custom properties."

/** The kind of file a library was read out of, as a badge. */
function kindBadge(kind: string): HTMLElement {
  return el("span", { class: "de-lib-kind", title: `Read as a ${kind} file` }, [kind])
}

/** A thrown `Error`'s own words, which are the server's, or a stated fallback. */
function messageOf(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : ""
  return message || fallback
}

/* ---------- signing in to a walled origin ---------- */

/**
 * What each wall means, said the way a designer would say it.
 *
 * THESE USED TO BE THE PROTOCOL'S OWN WORDS — "OAuth sign-in", "HTTP Basic
 * auth", "Bearer token", "Sign-in redirect", "Access refused" — and the reason
 * they are not any more is the whole of this table's point. Every one of them
 * is accurate, and not one of them is the sentence a designer needs. Somebody
 * who pastes an internal Storybook link and is told "Sign-in redirect" has
 * learned a fact about HTTP; what they wanted to know is whether the link is
 * wrong, whether the editor is broken, or whether the site is simply private.
 * It is the third one, every time, and that is what these say.
 *
 * The mechanism has not been thrown away — it is still what picks the default
 * credential below, and the server's own hint still prints it verbatim for the
 * person who opens the fold and is going to go and mint a token. It is just no
 * longer the FIRST thing said, because for almost everybody it is also the
 * last thing they need.
 *
 * Four sentences for five kinds, and the merges are deliberate:
 *
 *  - **oauth and redirect both become "needs you to sign in".** SSO and a plain
 *    login bounce are one experience from outside — the site wants a human to
 *    log in — and the only thing that differs is a protocol detail, which is
 *    behind the fold where it belongs;
 *  - **basic stays separate** because it is the one wall a designer might
 *    genuinely already hold the answer to, in a password manager;
 *  - **forbidden stays separate** because it is the one that is NOT fixed by
 *    signing in. The editor got through the door and was turned away, which
 *    means the account needs access rather than the session needs a login, and
 *    telling someone to sign in there sends them round a loop.
 *
 * Written to complete "<host> …", so each is a verb phrase and none of them
 * names a company's identity product — `classifyWall` reads a status code, a
 * `WWW-Authenticate` scheme and the shape of a redirect, and never a hostname,
 * so a label claiming to know WHICH sign-in this is would be a guess.
 */
/**
 * The identity providers worth naming on a button, by the host a wall redirects
 * to.
 *
 * Mirrors the server's table in `library-signin.mjs` and exists for the same
 * one reason: "Sign in with Okta" tells a designer exactly which screen is
 * about to appear, and "Sign in" alone does not. The fallback is the generic
 * sentence, never a guess — `classifyWall` is right to refuse hostnames, and
 * the difference here is that a wrong label costs a word rather than a
 * misreading of the wall.
 */
const PROVIDER_HOSTS: ReadonlyArray<{ host: string; label: string }> = [
  { host: "login.microsoftonline.com", label: "Microsoft" },
  { host: "okta.com", label: "Okta" },
  { host: "onelogin.com", label: "OneLogin" },
  { host: "auth0.com", label: "Auth0" },
  { host: "github.com", label: "GitHub" },
  { host: "gitlab.com", label: "GitLab" },
]

/** Who the wall handed off to, or "" when the redirect named nobody we know. */
function providerOf(wall: LibraryChallenge | null): string {
  if (!wall?.location) return ""
  let host = ""
  try {
    host = new URL(wall.location).hostname.toLowerCase()
  } catch {
    return ""
  }
  const found = PROVIDER_HOSTS.find(
    (entry) => host === entry.host || host.endsWith(`.${entry.host}`)
  )
  return found ? found.label : ""
}

const WALL_SUMMARY: Record<LibraryChallenge["kind"], string> = {
  oauth: "needs you to sign in",
  redirect: "needs you to sign in",
  basic: "needs a username and password",
  bearer: "needs an access token",
  forbidden: "denied access",
}

/**
 * THE BODY IS ONE SENTENCE, AND WHICH ONE DEPENDS ON WHAT CAN BE DONE NEXT.
 *
 * It was two, stacked, totalling about fifty words: an explanation of why the
 * editor's own process holds none of your sessions, followed by a description
 * of what the button below it was going to do. Both were true and the pair was
 * a paragraph of reading in front of a single press.
 *
 * The first one stopped being necessary when the button arrived. It existed to
 * answer "but I AM signed in to that site" — a real and confusing question back
 * when the only way through was to go and find a token yourself. A reader who
 * is being handed a sign-in window does not ask it; they press the button and
 * the question never forms. Mechanism is not owed to somebody whose path is
 * already clear.
 *
 * The second was restating its own button. "The editor will open that sign-in
 * in a window" under a control reading "Sign in with …" is the adjacent
 * repetition that makes an interface feel padded — the heading frames, the body
 * adds, the action names the result, and no slot repeats another.
 *
 * What survives is the one thing the button cannot say and the reader cannot
 * guess: a window is about to open, and their password is not going anywhere
 * near this editor. Fourteen words.
 */
const OPEN_NOTE = "Opens the site’s sign-in in a new window. Your password stays there."

/**
 * The same moment when there is no window to offer.
 *
 * A machine with no Chrome-family browser cannot be handed the easy path, so
 * the body has to do the work the button was doing: say that the token fold
 * below is the way through, rather than leaving a dialog that states a problem
 * and offers only Close.
 */
const NO_WINDOW_NOTE =
  "No browser found to sign in with. Use an access token instead."

/**
 * While the sign-in is in flight — and it has to be true BEFORE the window
 * exists as well as after.
 *
 * "Finish in the sign-in window" was the wording, and for the first several
 * seconds of every press it describes something that is not on screen yet: the
 * editor silently checks whether the saved browser profile already has access
 * before it shows anybody anything, and against a cold browser that check runs
 * to ten seconds or more. A reader told to finish in a window they cannot see
 * goes looking for it, fails to find it, and concludes the button is broken —
 * which is half of the "nothing pops up" report. The other half was that the
 * window really was unreachable; see `raiseWindow` in `library-signin.mjs`.
 *
 * "Opening" is true in both phases. It promises a window without claiming one
 * is already there.
 */
const WAITING_NOTE = "Opening the sign-in window. Finish there and this closes itself."

/**
 * The same wait, once it has gone on long enough that the first sentence has
 * stopped being information.
 *
 * `WAITING_NOTE` is true for the whole of a sign-in and that is exactly its
 * weakness: the worst case on the other side of this await is the better part
 * of six minutes — twenty seconds to launch a browser, forty-five trying the
 * saved profile with nothing on screen, twenty more to launch again, four
 * minutes for a human at their provider, fifteen seconds verifying afterwards —
 * and one unchanging sentence for all of it is indistinguishable from a request
 * that died. A reader who has been looking at the same nine words for a minute
 * concludes the button is broken, which is the "it gets stuck" report.
 *
 * So the copy moves once, at twenty seconds. The word that earns its place is
 * "cancel": by then the reader has either found the window or has not, and the
 * useful thing to tell them is that the wait has a door in it. Twenty seconds
 * rather than the five a spinner would use, because under twenty the honest
 * answer really is "this is normal, wait" — the silent profile check alone is
 * measured at over twelve seconds against a cold browser.
 */
const WAITING_LONG_NOTE =
  "Still waiting. Finish in the sign-in window, or cancel and try again."

/**
 * The sentence a cancelled wait leaves behind, and it has to mention the window.
 *
 * Cancelling stops the EDITOR waiting. It does not close the browser the server
 * opened, because there is no route to ask it to — the request is a single long
 * POST with no handle on it, so the window stays up until the server's own
 * four-minute ceiling kills it. A message that said "cancelled" and stopped
 * would leave a designer looking at a sign-in page they now believe is broken,
 * wondering whether finishing it would do something. It would not, and saying
 * so is one clause.
 */
const CANCELLED_NOTE =
  "Sign-in cancelled. You can close the sign-in window."

/**
 * And the wait that ran out on its own.
 *
 * The client deadline is deliberately LONGER than the server's own worst case,
 * so it never cuts short a sign-in somebody is genuinely in the middle of. It
 * exists for the failure the server's ceiling cannot catch: these routes are
 * grafted onto the host project's dev server, so whether a six-minute response
 * survives is decided by Vite, Next or whatever corporate proxy sits in front
 * of them. When one of those drops the connection the promise never settles at
 * all, and without a deadline the dialog waits until the page is reloaded.
 *
 * It names a press rather than a cause, because this side cannot tell a dropped
 * connection from a person who walked away from the window.
 */
const DEADLINE_NOTE =
  "Sign-in timed out. If the window is still open, finish there and press Sign in again."

/**
 * One sign-in at a time, said to the reader who just met the second one.
 *
 * Every sign-in the server runs launches Chrome against the SAME profile
 * directory, and a second launch into a directory the first still holds does
 * not fail loudly — it loses the singleton race, returns no debugging port, and
 * the designer is told "the browser did not open" for a reason that has nothing
 * to do with their machine. So the editor runs them one at a time, and the
 * second dialog says which site is holding the queue rather than offering a
 * button that would produce that.
 */
function busyNote(host: string): string {
  return (
    `Finish or cancel the sign-in for ${host} first. Only one can run at a time.`
  )
}

/**
 * The guard that used to be a bare `return`, given words.
 *
 * Nothing reachable produces it today: the server stamps a URL onto every
 * challenge it sends, and only a URL add can be walled in the first place. It
 * is written out all the same because of how it fails if that ever stops being
 * true — a primary button that does nothing at all, forever, with no sentence
 * and no console line. A guard whose only possible symptom is a dead control
 * owes the reader an explanation.
 */
const NO_TARGET_NOTE =
  "No link to sign in with. Add the link again."

/**
 * When the wait's copy moves, and when the editor gives up on it.
 *
 * Both are timers on the CLIENT, and neither of them stops the server: the
 * sign-in route has no cancel of its own. See `WAITING_LONG_NOTE` for why the
 * first is twenty seconds and `DEADLINE_NOTE` for why the second is longer than
 * the ~5m40s the server itself can take.
 */
const WAITING_NUDGE_MS = 20_000
const WAITING_DEADLINE_MS = 390_000

/**
 * What the window sign-in answers with, taken off the call rather than written
 * out again — the shape lives in `store.ts` with the request that produces it,
 * and a second declaration here would be a copy to forget when a field is
 * added.
 */
type ProviderSignInAnswer = Awaited<ReturnType<typeof openProviderSignIn>>

/** The 403's version: it got in and was turned away, which is a different fix. */
const REFUSED_NOTE =
  "The site refused access. Signing in again will not help, because the account needs permission."

/**
 * The facts a refusal named that a designer has nowhere else to read.
 *
 * Two, and they are mutually exclusive in practice: `audience` comes off an
 * OAuth redirect and `realm` off a 401, so a wall produces at most one of them.
 * They are drawn from one table all the same, because what the dialog does with
 * either is identical — a label, the value on a plate, a copy button — and two
 * hand-built rows would be two places for that treatment to drift.
 *
 * `copy` is the word `copyLibrarySnippet` puts in its toast, so it reads as a
 * thing rather than as a field name.
 */
const WALL_FACTS: ReadonlyArray<{
  key: "audience" | "realm"
  label: string
  copy: string
}> = [
  { key: "audience", label: "OAuth client ID", copy: "OAuth client ID" },
  { key: "realm", label: "Realm", copy: "realm" },
]

/**
 * The two credentials, as a person picks them.
 *
 * The placeholder moves with the choice because the two are not the same act:
 * a token is issued by whatever mints tokens for that site, and a cookie is
 * copied out of a browser's dev tools. A single placeholder would have to be
 * vague enough to cover both, and the box would then say nothing at the moment
 * it is being looked at hardest.
 */
const SCHEMES: ReadonlyArray<{
  value: LibraryCredentialScheme
  label: string
  placeholder: string
  title: string
}> = [
  {
    value: "bearer",
    label: "Bearer token",
    placeholder: "Paste the token",
    title: "Sent to the site as an Authorization: Bearer header",
  },
  {
    value: "cookie",
    label: "Cookie",
    placeholder: "Paste the Cookie header",
    title: "Sent to the site as a Cookie header",
  },
]

/** The same two, as one word on a row that is reporting rather than asking. */
const SCHEME_WORDS: Record<LibraryCredentialScheme, string> = {
  bearer: "token",
  cookie: "cookie",
}

/**
 * Which credential to offer first, and it follows the server's own sentence.
 *
 * A token for the three walls that asked for one in so many words — an OAuth
 * redirect, a `WWW-Authenticate: Bearer`, and a 403, where the server's hint
 * says a token with access will get through. A cookie for a plain sign-in
 * redirect, which named no token format at all and is the case a browser
 * session is most likely to be the only answer to. A default that contradicted
 * the hint printed two lines above it would be a trap rather than a
 * convenience, so this table and that one are written to agree.
 *
 * **HTTP Basic falls in with the token.** The wire accepts two credential
 * shapes and neither of them is `Authorization: Basic` — see
 * `LibraryCredentialScheme`, which is closed because the server refuses any
 * word it does not know rather than send a header of the caller's choosing to
 * an arbitrary host. So a Basic wall gets the token box, the server's hint says
 * what to put in it, and `basicNote` below says plainly what this editor will
 * do with it. Nothing here pretends the paste is sent as a Basic header: if the
 * site wants one, the sign-in is verified against the live URL and refused, and
 * a refusal the designer can read beats a claim they cannot check.
 */
function defaultScheme(wall: LibraryChallenge): LibraryCredentialScheme {
  if (wall.kind === "redirect") return "cookie"
  return "bearer"
}

/**
 * The one sentence the server cannot write, for the one wall it cannot satisfy.
 *
 * The server's hint for a Basic wall tells the designer what the SITE asked
 * for. This says what the EDITOR will send, which is the part that decides
 * whether the paste is going to work, and only this side knows it.
 */
const BASIC_NOTE =
  "Sent as an Authorization header. If the site refuses it, try a session cookie from a signed-in browser."

export function librariesSection(editor: EditorContext): { node: HTMLElement; update(): void } {
  /*
   * Everything the section remembers between renders, and it is all view state.
   *
   * None of it belongs in the store: which fold is open and what half-typed
   * path is in the box are facts about this surface, not about the project, and
   * a second surface onto the same libraries would be wrong to inherit them.
   * They live in the closure rather than on a node for the reason `field.ts`
   * keeps its collapse map at module level — the list is rebuilt on every store
   * write, so anything held on a row is lost the first time somebody flips a
   * switch.
   */
  let addOpen = false
  let scanning = false
  let scanned = false
  let candidates: LibraryCandidate[] = []
  let scanError = ""
  let loaded = false
  /*
   * Whether the NEXT paint of the candidate list is the one the walk just
   * produced, and the reason it is a flag rather than an inference.
   *
   * `renderCandidates()` runs on every store notification while the fold is
   * open — a switch flipped two sections up rebuilds these rows — so a list
   * that animated whenever it was built would deal itself out again as
   * punctuation for edits that have nothing to do with the scan. Same call
   * `takeJustExpanded` makes for the inspector's disclosure groups, and made
   * the same way: the arrival is asked for by the one event that earned it and
   * consumed by the render that plays it.
   */
  let justScanned = false

  /*
   * The sign-in flow's own state, and the one thing that is NOT here.
   *
   * There is no credential in this closure and there is not going to be one.
   * The value lives in the input element until the moment it is posted, and the
   * only thing that comes back is a list of origins with no secrets in it — the
   * server is the single place a credential is held, on purpose, and a copy
   * kept here to save a round trip would be a copy in every heap snapshot this
   * page ever takes.
   *
   * `challenge` is the wall currently being answered and `pendingAdd` is the
   * add it refused, held so it can be replayed the moment the wall opens. They
   * move together and are cleared together: a challenge with no add behind it
   * would be a sign-in that completes and then asks the designer to paste the
   * URL they already pasted.
   */
  let challenge: LibraryChallenge | null = null
  let pendingAdd: AddLibraryInput | null = null
  let scheme: LibraryCredentialScheme = "bearer"
  let signInProblem = ""
  /*
   * Whether the credential fold is open, which is also whether this dialog is
   * asking anything at all.
   *
   * Shut is the default and the common case: the dialog reports that a site is
   * private and offers a way out. It is reset per WALL rather than per open, so
   * a second refusal from the same origin — the ordinary shape of getting a long
   * token slightly wrong — leaves the designer's fold and their half-corrected
   * paste exactly where they were.
   */
  let signInMoreOpen = false
  /*
   * THE SIGN-IN IN FLIGHT, AS ONE OBJECT, AND THE NUMBER THE DIALOG IS ATTACHED
   * TO — and the pair of them is a bug fix rather than a tidy-up.
   *
   * This used to be a plain `let signInWaiting = false` that `openProviderWindow`
   * set and its own `finally` cleared. `closeSignIn` cleared five other pieces
   * of state and not that one, and the result was the worst report this feature
   * has had: press Sign in, get bored after forty seconds, press Close, paste
   * another link, and the fresh dialog opens with its primary button DISABLED
   * and reading "Waiting…" for a sign-in it is not waiting on. The only control
   * that did anything was Close, and doing it again reproduced it.
   *
   * A flag that one path sets and another forgets to clear is a bug waiting to
   * be rediscovered, so the flag is gone. What is here instead:
   *
   *  - `signIn` is the request itself — the run that is happening ANYWHERE,
   *    with the controller that can stop it and the timers watching it. One at
   *    a time, because every run drives the same Chrome profile on the server
   *    and two of them racing produce "the browser did not open"; see
   *    `busyNote`;
   *  - `signInRun` is which run THIS DIALOG belongs to. `closeSignIn` bumps it,
   *    which detaches the dialog from whatever is in flight without pretending
   *    the flight ended.
   *
   * Everything the dialog draws is then DERIVED from the two — waiting is
   * `signIn.run === signInRun` and nothing else — so there is no third place
   * for the truth to be forgotten. The response that lands afterwards compares
   * its own run against `signInRun` to decide whether it still owns the surface:
   * a stale one may report the credential it won, and may not close a dialog
   * that is now asking about a different site.
   */
  interface SignInRun {
    run: number
    /** The host in the copy, for the sentence a SECOND dialog has to show. */
    host: string
    abort: AbortController
    /** Whether the wait has gone on long enough to change what it says. */
    nudged: boolean
    /** Set before the abort, so the rejection knows which sentence it is. */
    cancelled: boolean
    expired: boolean
    nudge: ReturnType<typeof setTimeout> | null
    deadline: ReturnType<typeof setTimeout> | null
  }
  let signIn: SignInRun | null = null
  let signInRun = 0
  /** Whether the token fold's own request is out; see `submitSignIn`. */
  let signInSubmitting = false
  /** Whether this machine has a browser to open at all; see `canOpenProviderSignIn`. */
  let canOpenWindow = true
  let signIns: LibrarySignIn[] = []
  /*
   * Where the keyboard was standing when the wall interrupted it.
   *
   * A modal takes focus off the page and the platform does not put it back: the
   * dialog is closed, not removed, so `close()` leaves focus on `<body>` unless
   * somebody restores it. Held here rather than inferred at close time, because
   * by then the answer — the Add button, or the URL field if the add was
   * committed with Enter — is no longer the active element.
   */
  let signInReturn: Element | null = null

  const count = el("span", { class: "de-lib-count" })
  const list = el("div", { class: "de-lib-list" })

  /* ---------- the CTA ---------- */

  /*
   * The URL field is built ONCE and never rebuilt.
   *
   * It is the control in this section a user types into, and the list beside it
   * repaints on every store notification — including the one caused by the add
   * this field just issued. Rebuilding it would take the caret out of a
   * half-typed URL the moment an unrelated switch fired, which is invariant 5
   * in `panels/controls.ts` written out for one input. The same applies
   * to the path box in the fold below, and for the same reason.
   */
  const urlField = el("input", {
    class: "de-lib-field",
    type: "url",
    placeholder: "https://",
    // A design system OR a Storybook, because those are two different things a
    // designer has a link to and the field takes either. Naming only one of
    // them would make the other look unsupported.
    "aria-label": "Link to a design system or Storybook",
    "data-de-lib": "url",
  }) as HTMLInputElement

  const urlAdd = el(
    "button",
    {
      class: "de-button de-button--primary",
      type: "button",
      "data-de-lib": "url-add",
      onclick: () => void addUrl(),
    },
    ["Add"]
  ) as HTMLButtonElement

  urlField.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    void addUrl()
  })

  /* ---------- the sign-in dialog ---------- */

  /*
   * A MODAL, and that is the decision this block is built around.
   *
   * It used to be a well that unfolded under the URL row, in a 260px column,
   * between the CTA and the list of installed libraries. Three things were
   * wrong with that, and all three are the same thing said at different sizes:
   *
   *  - **the column is the wrong shape for the content.** What this asks for is
   *    an 800-character bearer token, beside a 70-character OAuth client id on
   *    a plate. At 260px minus the section's padding the id wraps five times
   *    and the field shows about thirty characters of the paste. The dialog is
   *    420px and the same content fits in half the height;
   *  - **it was a question asked from the corner of the room.** A wall stops
   *    the errand the designer is on — the add does not land until this is
   *    answered — and an inline block states that by growing quietly below the
   *    box while the rest of the panel stays live. A modal is the only surface
   *    in this chrome whose shape means "answer this or leave";
   *  - **it competed with the thing it interrupted.** The list, the switches
   *    and the local-file fold all stayed clickable underneath, so a designer
   *    could flip a library on mid-sign-in and watch the block survive a
   *    repaint it had to be engineered not to be eaten by.
   *
   * `showModal()` supplies the part that matters and none of it is written
   * here: the top layer, above every stacking context the host page and this
   * chrome have between them; the focus trap; the inertness of everything
   * behind; and `::backdrop` as the dim. The same call `shell/shortcuts.ts`
   * makes for the one other modal in the editor, and for the same reasons —
   * that file's header is the long version.
   *
   * ## Two things that did NOT change with the shape
   *
   * **It is built once and never rebuilt.** What a designer puts in this box is
   * a token they fetched from another program, and the list behind it repaints
   * on every store notification. A dialog rebuilt on one of those beats would
   * take the paste with it. So the nodes are made here and the only thing that
   * moves afterwards is their text.
   *
   * **It hangs off `document.body`, not off the section.** Both of the
   * enclosures it would otherwise sit in can be taken away underneath it: the
   * section body is `hidden` while the section is folded, and the right panel
   * goes `visibility: hidden` when the chrome stands down. Neither is survivable
   * for a top-layer element — `display` and `visibility` still reach it through
   * the DOM ancestry, top layer or not — and the failure is a modal that has
   * made the page inert and cannot be seen. The chrome standing down closes it
   * outright instead; see the subscription at the foot of this file.
   */
  /*
   * TWO sentences about one refusal, and they are written for two different
   * people — which is why they are two nodes rather than one paragraph.
   *
   * `wallHint` is the plain one and it is always on screen: what happened, and
   * why the browser session the reader is sitting in did not prevent it. It
   * names no protocol and it is the dialog's accessible description.
   *
   * `signInHint` is the server's own words, and it lives inside the fold. It is
   * the sentence that tells somebody to mint an identity token for a client id,
   * which is precisely the help a person who opened the fold is looking for and
   * precisely the noise that made this dialog unreadable when it led.
   */
  const wallTitle = el("h2", { class: "de-lib-signin-title", id: "de-lib-signin-title" })
  /*
   * `role="status"`, on the node that is ALSO the dialog's description, and the
   * double duty is the point rather than an accident.
   *
   * This sentence is the only thing on the surface that reports what the flow is
   * doing: it swaps to the waiting note when a window opens, swaps again when
   * the wait has gone on, and swaps back when it ends. None of those were
   * announced to anybody. An accessible-name change on a button that was
   * disabled — and therefore had just lost focus — announces nothing, and a
   * change to an `aria-describedby` target is read when the dialog opens and
   * never again. So a screen-reader user pressed Sign in and heard silence for
   * up to six minutes, and then heard silence again when it failed.
   *
   * A live region is the mechanism that fits, and this node is the right one to
   * make live: it already holds exactly the text that changes, so there is no
   * second copy to keep in step and no visually-hidden twin saying the same
   * thing to half the audience. `status` rather than `alert` because a phase of
   * a wait is polite news; the refusal below it is the rude kind and is an
   * `alert`.
   *
   * It is not announced twice on open: the dialog is `display: none` until
   * `showModal`, and a live region that is not rendered does not fire.
   */
  const wallHint = el("p", {
    class: "de-lib-hint de-lib-signin-hint",
    id: "de-lib-signin-hint",
    role: "status",
  })
  const signInHint = el("p", { class: "de-lib-hint", "data-de-lib": "signin-hint" })

  /*
   * One of the two facts the refusal named, on a plate, with a copy button.
   *
   * Built here — once, like everything else in this dialog — and shown only when
   * the wall in hand carries a value for it. An absent field draws nothing
   * rather than an empty plate, because a labelled box with nothing in it reads
   * as a value that failed to load.
   *
   * The copy button is the point of the row. An OAuth client id is around
   * seventy characters of digits, a dash and a domain, and a designer retyping
   * one gets a character wrong and reads the refusal that follows as "my token
   * is bad" rather than "I mistyped the audience". `copyLibrarySnippet` is
   * reused rather than reimplemented because its one subtlety is invisible in a
   * copy: the clipboard write is issued synchronously inside the click task, and
   * an `await` in front of it passes every test that awaits before asserting and
   * fails on every real click.
   */
  function factRow(fact: (typeof WALL_FACTS)[number]): {
    row: HTMLElement
    value: HTMLElement
  } {
    const value = el("code", {
      class: "de-lib-fact-value",
      "data-de-lib": "signin-fact-value",
      "data-de-lib-id": fact.key,
    })
    const copy = el(
      "button",
      {
        class: "de-mini",
        type: "button",
        title: `Copy the ${fact.copy}`,
        "aria-label": `Copy the ${fact.copy}`,
        "data-de-lib": "signin-copy",
        "data-de-lib-id": fact.key,
        onclick: () => copyLibrarySnippet(editor, value.textContent ?? "", fact.copy),
      },
      // `icon.action`: the copy glyph needs the detail. The X buttons in this
      // section sit in the same 18px box at `icon.marker`, because an X that
      // size fills the box.
      [icon("Copy", tokens.icon.action)]
    )
    const row = el(
      "div",
      { class: "de-lib-fact", "data-de-lib": "signin-fact", "data-de-lib-id": fact.key },
      [
        el("span", { class: "de-lib-fact-label" }, [fact.label]),
        el("div", { class: "de-lib-fact-row" }, [value, copy]),
      ]
    )
    row.hidden = true
    return { row, value }
  }

  const facts = WALL_FACTS.map((fact) => ({ fact, ...factRow(fact) }))

  const schemeButtons = SCHEMES.map(
    (option) =>
      el(
        "button",
        {
          class: "de-segment",
          type: "button",
          title: option.title,
          "aria-pressed": "false",
          "data-de-lib": "signin-scheme",
          "data-de-lib-id": option.value,
          onclick: () => setScheme(option.value),
        },
        [option.label]
      ) as HTMLButtonElement
  )

  const schemeRow = el(
    "div",
    { class: "de-segmented", role: "group", "aria-label": "What kind of credential this is" },
    schemeButtons
  )

  /*
   * A password field, and it is not optional politeness.
   *
   * A designer pastes this with a colleague at their shoulder, on a call they
   * are sharing a screen on, or into a panel that is on screen while something
   * is recording. A bearer token rendered as plain text in a 260px column is a
   * credential that leaves the building in somebody's video, and it does not
   * expire when the meeting ends. The reveal toggle beside it is what makes
   * that survivable: masked is the default, and seeing it is a thing you ask
   * for once you have looked at the room.
   */
  const credentialField = el("input", {
    class: "de-lib-field",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "The credential for this site",
    "data-de-lib": "signin-value",
  }) as HTMLInputElement

  const reveal = el("button", {
    class: "de-mini",
    type: "button",
    "aria-pressed": "false",
    "data-de-lib": "signin-reveal",
    onclick: () => setRevealed(reveal.getAttribute("aria-pressed") !== "true"),
  }) as HTMLButtonElement

  /*
   * The refusal, on the surface rather than in a toast — and OUTSIDE THE FOLD,
   * which is the fix for the worst bug this dialog has had.
   *
   * A toast is gone in four seconds and this sentence is the whole of what
   * separates "this token has expired" from "this token is for another site" —
   * a designer reads it, looks back at the box the token is still sitting in,
   * and fixes one of the two. It is `role="alert"` because the press that
   * produced it moved no focus, so nothing else would announce it.
   *
   * ## Why it is built here and appended to the DIALOG rather than to the panel
   *
   * It used to be the last child of `signInPanel`, next to the credential box,
   * which reads perfectly for the token path and was catastrophic for the other
   * one. The panel is `hidden` whenever the "I have an access token" fold is
   * shut, and shut is the default for every new wall — the whole design of this
   * surface is that most readers never open it. Worse than `hidden`: the drawer
   * clips the panel to a zero-height grid row and `.de-lib-signin-panel[hidden]`
   * adds `visibility: hidden`, so the node was not merely below the fold, it was
   * unrenderable and its `role="alert"` was dead with it.
   *
   * Every failure the WINDOW sign-in can produce was written there. A closed
   * window, a site that still refuses after a successful login, a dropped
   * connection, and — the sharpest one — the sentence this codebase wrote
   * specifically so a designer on a stale server process would know to restart
   * it. All of them landed in a node nobody could see. What the designer got
   * was a button that went grey, came back, and changed nothing else. That is
   * the "the modal gets stuck with no explanation" report, exactly.
   *
   * ONE line for both paths rather than one in the fold and one out here. Two
   * would drift, and the fold-shut reader — who is the common case — needs the
   * out-of-fold one anyway; the token reader loses a little adjacency and keeps
   * the whole sentence. It sits directly above the actions row, so it is under
   * the submit when the fold is open and under the toggle when it is shut, in
   * both cases next to whatever produced it.
   */
  const problemLine = el("p", {
    class: "de-lib-hint de-lib-error",
    role: "alert",
    "data-de-lib": "signin-error",
  })
  problemLine.hidden = true

  /*
   * The one button this dialog leads with, and the whole point of the surface.
   *
   * It does not collect anything. It opens the site's own sign-in — the page
   * the designer's company runs, with their account picker and their second
   * factor — and waits for it to finish. Everything the old flow asked a person
   * to go and find is a thing the provider already knows and this editor has no
   * business learning.
   *
   * Labelled with the provider's name when the redirect named one, because
   * "Sign in with Okta" is a promise a reader can check against the window that
   * appears, and "Sign in" alone is a leap of faith.
   */
  /*
   * The label is the only thing that moves; the glyph is built once beside it.
   *
   * `paintSignIn` rewrites the word on every repaint — provider name, or the
   * waiting state — and `textContent` on the button would take the icon with
   * it. A span of its own is what lets one be replaced without the other, and
   * it is the same split every other relabelled control in this chrome uses.
   */
  const signInOpenLabel = el("span")
  const signInOpen = el(
    "button",
    {
      class: "de-button de-button--primary",
      type: "button",
      "data-de-lib": "signin-open",
      onclick: () => void openProviderWindow(),
    },
    [
      /*
       * The arrow out of a box, and it is the one thing on this dialog that
       * says "elsewhere" without a sentence.
       *
       * The body says a window opens; this is the same statement in the place a
       * reader's eye actually lands, which is the primary button. `icon.marker`
       * because `.de-button` is the kit's 24px action size, whose glyph is the
       * marker role — the same 12px the lint panel's Audit glyph draws at — and
       * the stroke is the set's single weight — see `icons.ts`.
       */
      icon("ExternalLink", tokens.icon.marker),
      signInOpenLabel,
    ]
  ) as HTMLButtonElement

  /*
   * The token path's own submit, INSIDE the fold with the box it submits.
   *
   * It used to be the dialog's primary action. It is now the fallback for the
   * sites the window cannot open, and a button in the action row would still
   * read as the main offer however it is styled — so it moved to sit under the
   * field, where it belongs to the thing it sends.
   */
  const signInSubmit = el(
    "button",
    {
      class: "de-button",
      type: "button",
      "data-de-lib": "signin-submit",
      onclick: () => void submitSignIn(),
    },
    ["Use this token"]
  ) as HTMLButtonElement

  /*
   * "Close", where it used to say "Not now", and a real button where it used to
   * be a quiet word.
   *
   * The LABEL first: "Not now" is a reply to an offer, and with the credential
   * controls folded away the default state of this dialog makes none — it
   * reports that a site is private. A lone "Not now" under a statement reads as
   * declining something the reader was never shown. "Close" is true in both
   * states: before the fold it dismisses a report, and after it walks away from
   * the paste.
   *
   * The SHAPE second, and it follows from the fold. This used to share
   * `.de-lib-dismiss` with the disclosure toggle — both were a quiet word
   * declining the loud thing beside them — and that was right when the loud
   * thing was on screen. It is not any more: with the fold shut, a quiet "Close"
   * sits directly under a quiet "I have an access token" at the same weight, in
   * the same colour, on the same margin, and the pair reads as two links rather
   * than as a disclosure and the only action the dialog has. A `.de-button`
   * separates them by rank, which is the true relationship.
   */
  const signInDismiss = el(
    "button",
    {
      class: "de-button de-lib-signin-close",
      type: "button",
      "data-de-lib": "signin-dismiss",
      onclick: () => closeSignIn(),
    },
    ["Close"]
  )

  /*
   * THE WAY OUT OF THE WAIT, and the dialog had none.
   *
   * What the waiting state used to be: the primary button greyed out and
   * relabelled "Waiting…", a sentence that never changed, and Close. Close is
   * not a cancel — it takes the dialog away and leaves the request running, so
   * a designer who pressed it had no way to tell the editor to stop, no way to
   * start a different sign-in (one browser profile, one at a time), and no way
   * to find out what had become of the first. For up to six minutes. "The user
   * must never be unable to act" is the rule this breaks, and it breaks it in
   * the one state a person is most likely to be stuck in.
   *
   * So the primary is not disabled here, it is REPLACED. While a run is in
   * flight this button stands where "Sign in" was, and pressing it stops the
   * wait: the fetch is aborted, the dialog says what happened, and the offer
   * comes back. That also disposes of the focus problem the old shape had —
   * disabling the button somebody just pressed drops their focus to `<body>`,
   * which this file warns about twice for `addFrom` and then did anyway — since
   * there is now a live control to move focus TO.
   *
   * It is shown whenever a run exists, not only when this dialog started it. A
   * second wall opened while the first is still signing in cannot offer its own
   * Sign in — the profile is busy — so the only useful thing it can offer is the
   * ability to stop the one in the way.
   *
   * Not `--primary`: cancelling is not the act this dialog is recommending. It
   * takes the same recessed treatment as Close so that both are legible on a
   * raised card; see `.de-lib-signin-close`.
   */
  const signInCancel = el(
    "button",
    {
      class: "de-button de-lib-signin-close",
      type: "button",
      "data-de-lib": "signin-cancel",
      onclick: () => cancelSignIn(),
    },
    ["Cancel sign-in"]
  ) as HTMLButtonElement
  signInCancel.hidden = true

  credentialField.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    void submitSignIn()
  })

  /*
   * EVERYTHING TECHNICAL IN THIS FLOW IS INSIDE THIS FOLD, and that is the
   * whole shape of the surface.
   *
   * Above it the dialog says two things in plain words: this site is private,
   * and here is why being logged in to it in this browser does not help. That
   * is the complete and correct answer for almost everybody who ever sees it —
   * they pasted a link to something they cannot share with a tool, and the
   * useful next step is to go and find a public one.
   *
   * What is in here is for the minority who can actually act: the server's own
   * hint naming the mechanism, the OAuth client id or realm the refusal carried,
   * the choice between the two credential shapes, and the box. All of it is
   * jargon and all of it is necessary — a person minting an identity token needs
   * the audience, and there is no plainer word for it. A fold is how both
   * readers get served by one surface: the first never meets any of it, and the
   * second is one press away.
   *
   * The toggle's label is the filter. Somebody who has a token recognises the
   * phrase immediately; somebody who does not reads past it, which is the
   * correct outcome for them.
   */
  const signInPanel = el(
    "div",
    { class: "de-lib-signin-panel", id: "de-lib-signin-panel", "data-de-lib": "signin-panel" },
    [
      // The server's own words, which are the instruction for the person who
      // opened this — and which said nothing to the person who did not.
      signInHint,
      ...facts.map((entry) => entry.row),
      schemeRow,
      el("div", { class: "de-lib-signin-row" }, [credentialField, reveal]),
      // No error line in here any more: it is a child of the dialog now, where
      // it is visible with the fold shut. The long version is where it is built.
      el("div", { class: "de-lib-signin-panel-actions" }, [signInSubmit]),
    ]
  )
  signInPanel.hidden = true

  // The same clip the local-file fold uses, and for the same reason: a grid row
  // animating to nothing has to be clipped by something while it is short.
  const signInDrawer = el("div", { class: "de-lib-drawer" }, [signInPanel])

  const signInMore = el(
    "button",
    {
      class: "de-lib-expand",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": "de-lib-signin-panel",
      "data-de-lib": "signin-more",
      onclick: () => setSignInMore(signInMore.getAttribute("aria-expanded") !== "true"),
    },
    [
      el("span", { class: "de-lib-twisty", "aria-hidden": "true" }, [
        icon("ChevronRight", tokens.icon.marker),
      ]),
      "Use an access token",
    ]
  )

  /*
   * Named by its own heading and described by the plain sentence under it,
   * rather than by an `aria-label` this code keeps in step by hand. Both strings
   * are repainted from the challenge on every open and `aria-labelledby` follows
   * them for free — an `aria-label` would be a third copy of the title to
   * forget. The description is the PLAIN line, not the server's hint: the hint
   * is folded away and may never be shown at all.
   */
  const signInDialog = el(
    "dialog",
    {
      class: "de-lib-signin",
      /*
       * `tabindex="-1"` so the CARD can be focused programmatically.
       *
       * `showModal()` does not focus the dialog when it has a focusable
       * descendant — it picks the first one in tree order, which here is the
       * "I have an access token" toggle. That is the wrong landing: a screen
       * reader would announce a collapsed disclosure before it had said which
       * site this is about. So `openSignIn` focuses the card itself, and a
       * `<dialog>` is not focusable on its own for an explicit `focus()` call.
       * Out of the tab order at -1, so it is a target and never a stop.
       */
      tabindex: "-1",
      "aria-labelledby": "de-lib-signin-title",
      "aria-describedby": "de-lib-signin-hint",
      "data-de-lib": "signin",
    },
    [
      wallTitle,
      wallHint,
      el("div", { class: "de-lib-signin-more" }, [signInMore, signInDrawer]),
      problemLine,
      /*
       * Three controls in the row and never more than two on screen: Close is
       * always there, and the trailing slot is "Sign in" or "Cancel sign-in"
       * depending on whether anything is in flight. `paintSignIn` owns the
       * swap, and both are built here because this dialog is built once —
       * moving a button in and out of the DOM at the moment a reader is looking
       * at it is how the old surface lost its focus.
       */
      el("div", { class: "de-lib-signin-actions" }, [signInDismiss, signInCancel, signInOpen]),
    ]
  )
  document.body.append(signInDialog)

  /*
   * Escape closes it, and the press is SPENT here.
   *
   * `shell/shortcuts.ts` listens for Escape on the bubble phase of `window` and
   * stands the whole editor down on a press nothing else took — that is the
   * last step of the key's escalation, and it reads `defaultPrevented` as the
   * handshake. Without both calls below, one Escape would dismiss this dialog
   * AND collapse the chrome behind it, which is two answers to one question.
   *
   * The `cancel` handler is the same route by a second door: the platform's own
   * response to a close request is to close the dialog directly, which would
   * leave `challenge` and the pending add set on a surface that is no longer on
   * screen. Cancelled, so `closeSignIn` stays the only way out.
   */
  signInDialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    closeSignIn()
  })
  signInDialog.addEventListener("cancel", (event) => {
    event.preventDefault()
    closeSignIn()
  })

  /*
   * A PRESS ON THE BACKDROP DOES NOT CLOSE IT, which is where this modal parts
   * company with the shortcuts sheet.
   *
   * That one is a document you open, read and dismiss, and a click anywhere off
   * it is unambiguously "I am done reading". This one is a form holding a
   * credential the designer went to another program to fetch, and a stray press
   * on the dim is the cheapest accidental gesture in the interface. Losing an
   * 800-character token to one would send them back for it at the exact moment
   * they are most likely to give up on the feature.
   *
   * So the two ways out are both deliberate: "Not now", and Escape. Neither is
   * reachable by a mis-aimed click.
   */

  // No visible label: the field's placeholder and aria-label name it.
  const cta = el("div", { class: "de-lib-cta" }, [
    el("div", { class: "de-lib-cta-row" }, [urlField, urlAdd]),
  ])

  /* ---------- what this editor is signed in to ---------- */

  const signInRows = el("div", { class: "de-lib-signed-rows" })

  /*
   * Hidden when there is nothing in it, rather than drawn with an empty state.
   *
   * "Signed in to nothing" is furniture: it takes a row and a half of a 260px
   * column to report the case that is true in almost every session, and it
   * teaches nothing, because a designer who has never met a walled library has
   * no use for the concept. The block appears the first time it has something
   * to say and disappears again when the last credential is forgotten.
   */
  const signedBlock = el("div", { class: "de-lib-signed", "data-de-lib": "signed" }, [signInRows])
  signedBlock.hidden = true

  /* ---------- the fold: a file in this project ---------- */

  const status = el("span", { class: "de-lib-status", "aria-live": "polite" })
  const candidateList = el("div", { class: "de-lib-candidates" })

  const manualPath = el("input", {
    class: "de-lib-field",
    type: "text",
    placeholder: "src/styles/tokens.css",
    "aria-label": "Path to a design-system file, relative to the project root",
    "data-de-lib": "manual-path",
  }) as HTMLInputElement

  const manualAdd = el(
    "button",
    {
      class: "de-button",
      type: "button",
      "data-de-lib": "manual-add",
      onclick: () => void addManual(),
    },
    ["Add"]
  ) as HTMLButtonElement

  manualPath.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    void addManual()
  })

  const addPanel = el("div", { class: "de-lib-panel", id: "de-lib-local" }, [
    status,
    candidateList,
    el("div", { class: "de-lib-manual" }, [
      el("span", { class: "de-lib-manual-label" }, ["Or add a file by path"]),
      el("div", { class: "de-lib-manual-row" }, [manualPath, manualAdd]),
    ]),
  ])
  addPanel.hidden = true

  /*
   * A wrapper whose only job is to be the box the drawer closes into.
   *
   * The fold opens by animating a grid row from `0fr` to `1fr` — see
   * `.de-lib-drawer` in `css/libraries.ts` for why that shape and not
   * `revealGroup` — and the row has to be clipped by something while it is
   * short. It cannot be the panel itself: the panel carries the well's padding,
   * and a padded box with `box-sizing: border-box` squeezed to zero still
   * paints its padding, so the shut fold would leave eight pixels of sunken
   * background under the toggle. It cannot be `.de-lib-local` either, because
   * that also contains the toggle, and clipping it would cut the two pixels the
   * toggle's focus ring is offset by — a keyboard user would lose the ring on
   * the one control that opens this thing.
   *
   * So the clip gets an element of its own, holding nothing but the panel.
   */
  const drawer = el("div", { class: "de-lib-drawer" }, [addPanel])

  /*
   * Folded shut by default, and quiet on purpose.
   *
   * Adding a library at all is a once-a-project act and adding one from a local
   * FILE is the rarer half of it, so the control that opens it takes the same
   * treatment the options browser gives its "why can't I…" folds rather than
   * the filled accent above it. The twisty is the part that says these words are
   * a fold and not a link out of the panel.
   */
  const addToggle = el(
    "button",
    {
      class: "de-lib-expand",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": "de-lib-local",
      "data-de-lib": "add-toggle",
      onclick: () => setAddOpen(addToggle.getAttribute("aria-expanded") !== "true"),
    },
    [
      el("span", { class: "de-lib-twisty", "aria-hidden": "true" }, [
        icon("ChevronRight", tokens.icon.marker),
      ]),
      "Add a file from this project",
    ]
  )

  const body = el("div", { class: "de-lib" }, [
    list,
    cta,
    // Under the CTA, because a sign-in is a fact about the box above it: the
    // credentials listed here are the reason a link that used to be refused now
    // lands. Above the local-file fold, because nothing in this project has an
    // origin and nothing in that fold can ever be walled.
    signedBlock,
    el("div", { class: "de-lib-local" }, [addToggle, drawer]),
  ])

  const node = section("Libraries", body, count)

  /* ---------- the add flow ---------- */

  function setAddOpen(open: boolean): void {
    addOpen = open
    addPanel.hidden = !open
    addToggle.setAttribute("aria-expanded", String(open))
    // Scanned once per session, not once per open. The walk reads up to four
    // thousand files, and re-running it because somebody folded the panel shut
    // and open again would spend that on an answer nothing has changed.
    if (open && !scanned && !scanning) void scan()
    else if (open) renderCandidates()
  }

  async function scan(): Promise<void> {
    scanning = true
    scanError = ""
    renderCandidates()
    try {
      candidates = await discoverLibraries(editor.apiBase)
      scanned = true
      // Only here, and only on the way out of a walk that actually returned
      // something: an arrival is a statement that the answer has landed, and
      // playing one over the error hint below would dress a failure up as a
      // result.
      justScanned = candidates.length > 0
    } catch {
      // Said on the surface as well as in a toast: a toast is gone in seconds
      // and this fold is then an empty list claiming the project has nothing in
      // it, which is a different and much worse statement than "the scan
      // failed". The path box below is still the way in either way.
      scanError = "Could not scan this project for design-system files. Add one by path below."
      editor.toast({ title: "Could not scan this project", description: "Add a design-system file by path below." }, "error")
    } finally {
      scanning = false
      renderCandidates()
    }
  }

  /**
   * The one add path, for all three ways in.
   *
   * Reports whether it landed, because the callers want different things from
   * the answer: a candidate row is about to be rebuilt by `render()` with its
   * button reading "Added", so it needs nothing back, while the two boxes are
   * built once and live forever and have to clear their own field and stand
   * their own button back up.
   */
  async function addFrom(
    input: AddLibraryInput,
    button: HTMLButtonElement,
    fallback: string
  ): Promise<boolean> {
    button.disabled = true
    try {
      const library = await addLibrary(editor.apiBase, input)
      // Marked locally rather than by rescanning: the walk that produced this
      // list costs thousands of stats, and the only thing about it that just
      // became untrue is one row's `installed`.
      for (const candidate of candidates) {
        if (input.path && candidate.path === input.path) candidate.installed = true
      }
      editor.toast(`Added ${library.name}`)
      // The Design tab is built from the merged catalog, and it does not
      // subscribe to this store — `refresh()` is how the tokens this library
      // just contributed reach the fill picker without a reselection.
      editor.refresh()
      render()
      return true
    } catch (error) {
      button.disabled = false
      /*
       * A wall is the one refusal that is not a mistake, so it does not go out
       * as a toast.
       *
       * Every other error here is about what the designer typed and is fixed by
       * typing something else, which is what a toast over the box is for. This
       * one is about who the SERVER is signed in as, the sentence alone cannot
       * be acted on, and the way out is four controls long — so it opens the
       * sign-in dialog instead, which stays up while the designer goes and
       * fetches a token.
       */
      if (error instanceof LibraryAuthError) {
        // The button is handed over as the place to put the keyboard back,
        // because by now `document.activeElement` cannot answer that: this
        // function disabled the button while the request was in flight, and a
        // disabled control drops its focus to `<body>`. See `openSignIn`.
        openSignIn(error.auth, input, button)
        return false
      }
      // The server's own sentence, which `failure()` in `store.ts` has already
      // unwrapped out of the response body: every error this route produces is
      // about the thing the user just typed — the link does not resolve, it is
      // not a design system, there are already twenty — and those sentences are
      // the entire help available at the moment of the mistake.
      editor.toast(messageOf(error, fallback), "error")
      return false
    }
  }

  /**
   * The box is cleared only if it still holds the link that just landed.
   *
   * Unconditional before, and it could be: the value was read one statement
   * earlier. It cannot be now — a refused add opens the sign-in dialog, the
   * designer spends a minute in a terminal, and the add is replayed for them
   * afterwards. Anything they typed into the URL box in between is theirs, and
   * blanking it because an older add finally succeeded would be the field
   * eating a paste by a slower route than a rebuild.
   */
  function clearUrlField(input: AddLibraryInput): void {
    if (input.url && urlField.value.trim() === input.url) urlField.value = ""
    urlAdd.disabled = false
  }

  async function addUrl(): Promise<void> {
    const url = urlField.value.trim()
    if (!url) {
      editor.toast("Paste a link first", "error")
      urlField.focus()
      return
    }
    // Cleared rather than left for a second press: adding it again is a no-op
    // the store answers idempotently, but a box still holding a link that is
    // now a row above it reads as unfinished.
    if (await addFrom({ url }, urlAdd, "Could not read that link. Check the address, then add it again")) clearUrlField({ url })
  }

  async function addManual(): Promise<void> {
    const path = manualPath.value.trim()
    if (!path) {
      editor.toast("Type a project-relative path first", "error")
      manualPath.focus()
      return
    }
    // No `kind`: the server detects it, and an undetectable file comes back as
    // a 400 naming the four it looks for, which is a better error than any
    // guess this section could make from a file extension.
    const added = await addFrom({ path }, manualAdd, `Could not add ${path}`)
    if (!added) return
    manualPath.value = ""
    manualAdd.disabled = false
  }

  /* ---------- the sign-in flow ---------- */

  function setScheme(next: LibraryCredentialScheme): void {
    scheme = next
    SCHEMES.forEach((option, index) => {
      schemeButtons[index].setAttribute("aria-pressed", String(option.value === next))
      if (option.value === next) credentialField.placeholder = option.placeholder
    })
  }

  function setRevealed(shown: boolean): void {
    credentialField.type = shown ? "text" : "password"
    reveal.setAttribute("aria-pressed", String(shown))
    // The label says what pressing it will DO, not what the field currently is:
    // a toggle whose name reports its own state is a control a screen reader
    // user has to press to find out what it was called.
    const label = shown ? "Hide the credential" : "Show the credential"
    reveal.setAttribute("title", label)
    reveal.setAttribute("aria-label", label)
    clear(reveal)
    reveal.append(icon(shown ? "EyeOff" : "Eye", tokens.icon.action))
  }

  /**
   * Open or shut the token fold.
   *
   * The submit lives inside the panel now rather than being carried in and out
   * of the action row, so this only moves one thing. Shut, the dialog has one
   * action — open the site's own sign-in — which is the honest offer for
   * everybody who is not holding a token already.
   */
  function setSignInMore(open: boolean): void {
    signInMoreOpen = open
    signInPanel.hidden = !open
    signInMore.setAttribute("aria-expanded", String(open))
    if (open) focusControl(credentialField, { preventScroll: true })
  }

  /** The host on its own, which is the part of a URL a person reads. */
  function hostOf(wall: LibraryChallenge): string {
    const where = wall.origin || wall.url
    try {
      return new URL(where).host
    } catch {
      // Not a URL this engine will parse — say the whole string rather than
      // nothing. A dialog whose subject is missing is worse than a long one.
      return where
    }
  }

  /**
   * The dialog's words, recomputed from the challenge and nothing else.
   *
   * Deliberately touches no control the designer has set: not the value in the
   * box, not which scheme is chosen, not whether the value is revealed, not
   * whether the fold is open. Those four are their input and this function runs
   * whenever the dialog's SUBJECT changes — a repaint that reset them would be
   * the rebuild this whole surface was built once to avoid, arriving by a
   * different route.
   *
   * It does not open or close the dialog either. Whether it is up is a fact
   * `openSignIn` and `closeSignIn` own between them; a painter that also decided
   * modality would put a `showModal()` on the path of every store beat, since
   * `renderSignIns` calls this to keep the "replaces an expired one" sentence
   * honest.
   *
   * IT IS ALSO THE ONLY WRITER of the three controls whose state a sign-in
   * moves — the offer, the cancel and the token submit. They were previously
   * written from four places between them, `paintSignIn` deriving one value
   * while `openProviderWindow` imperatively set the same one two lines later,
   * and that is the arrangement the "Waiting…" leak grew in. Everything here
   * reads `signIn` and `signInRun`; nothing outside this function touches a
   * `hidden` or a `disabled` on them.
   */
  function paintSignIn(): void {
    /*
     * UNHIDDEN BEFORE THE TEXT IS WRITTEN, and the order is the announcement.
     *
     * `role="alert"` fires on a mutation inside a RENDERED live region. Writing
     * the sentence into a node that is still `hidden` and revealing it
     * afterwards is two mutations in the order that announces neither: the
     * first happens where nothing is listening, and the second changes no text.
     * Reveal first and the text lands in a region that is on screen, which is
     * the whole reason the node carries the role.
     */
    problemLine.hidden = !signInProblem
    problemLine.textContent = signInProblem

    /*
     * Waiting is DERIVED, not remembered. A run belongs to the dialog it was
     * started from; `closeSignIn` detaches by bumping `signInRun`, so a dialog
     * can never inherit a wait from the one before it — which is precisely what
     * the old boolean did. `elsewhere` is the other half: a run exists and this
     * dialog is not its owner, which is the state a second wall opens into
     * while the first is still in a browser window.
     */
    const waiting = signIn !== null && signIn.run === signInRun
    const elsewhere = signIn !== null && !waiting
    signInCancel.hidden = signIn === null
    /*
     * The token path is held back for the length of a window sign-in, because
     * the two race for the same answer: both adopt the credential, both close
     * the dialog and both replay the add, and the loser writes its refusal into
     * a dialog that is no longer there. A designer who gets impatient mid-wait
     * and pastes a token is not doing anything unreasonable — the fold is right
     * there — so the interlock is the code's job, not theirs.
     */
    signInSubmit.disabled = signInSubmitting || signIn !== null
    // "Checking…" while it is out, because the request behind it can take
    // fifteen seconds and a grey button with its original label on it is
    // indistinguishable from a press that was ignored. No icon inside it, so
    // `textContent` is safe where the offer above needs a span of its own.
    signInSubmit.textContent = signInSubmitting ? "Checking…" : "Use this token"
    /*
     * The same attribute the project scan wears while it is running, so the two
     * indeterminate waits in this chrome are one idea rather than two. It is
     * what turns "a sign-in is happening" into "a sign-in is getting somewhere"
     * — the words alone are identical on the first frame and the last, and there
     * is no honest number to put beside them.
     *
     * It moved here from the button: the button is not on screen during the
     * wait any more, and the sentence below is the thing that is actually
     * reporting, so the mark belongs under the sentence. `aria-busy` on the
     * dialog is the same statement for a reader who is not looking at it.
     *
     * Above the `challenge` guard rather than beside the sentence it decorates,
     * because a dialog CLOSED mid-wait must not keep either mark: the next wall
     * would open on a card that claims to be busy with a request nobody in the
     * room started.
     */
    if (waiting) {
      wallHint.setAttribute("data-de-busy", "")
      signInDialog.setAttribute("aria-busy", "true")
    } else {
      wallHint.removeAttribute("data-de-busy")
      signInDialog.removeAttribute("aria-busy")
    }

    if (!challenge) return

    /*
     * The site, then what it wants, as one sentence a person can read aloud.
     *
     * It was `${MECHANISM} · ${origin}` — "Sign-in redirect ·
     * https://design-system.example.com" — which put the least useful half
     * first and led with a term of art. Subject first is the fix: the
     * reader already knows which link they pasted, so the host is what anchors
     * the sentence, and `WALL_SUMMARY` completes it in words nobody has to look
     * up.
     *
     * The HOST rather than the origin, because `https://` is noise in a heading
     * and a scheme is not something the reader chose or can change.
     */
    wallTitle.textContent = `${hostOf(challenge)} ${WALL_SUMMARY[challenge.kind]}`

    /*
     * The plain body: why this happened, and — the part nobody guesses — why
     * being signed in to that very site in this very browser did not prevent it.
     *
     * A wall over an origin the panel is already listing as signed in is the
     * confusing case in the whole feature: the panel behind says the editor has
     * a credential and the dialog in front says the site refused. Both are true
     * — the credential expired — and saying so is what stops a designer hunting
     * for a fault in the library. That sentence stays out here in plain words
     * rather than going in the fold with the rest, because it explains a change
     * in the world ("this worked yesterday") to a reader who may have no token
     * and no intention of getting one.
     */
    const stale = signIns.some((entry) => entry.origin === challenge?.origin)
    const provider = providerOf(challenge)

    /*
     * A 403 is the wall a sign-in does not fix — the editor got through the
     * door and the ACCOUNT was refused — so no window is offered there. Sending
     * that reader to a sign-in they have already passed is a loop with no exit.
     */
    const offersWindow = canOpenWindow && challenge.kind !== "forbidden"

    /*
     * "Sign in", not "Sign in to this site".
     *
     * The heading one line above already names the site and already says it
     * needs a sign-in. A button restating both is the third slot in a row
     * saying one thing, and the extra words buy nothing: there is no other
     * site this button could mean. The provider's name is the one addition
     * that earns its space — it tells the reader which sign-in screen is about
     * to appear, which is the only thing they cannot predict.
     */
    signInOpenLabel.textContent = provider ? `Sign in with ${provider}` : "Sign in"
    /*
     * The offer is WITHDRAWN while anything is in flight rather than greyed out,
     * because the slot it stands in is given to Cancel — see the button. A
     * disabled "Waiting…" was a control that could not be used, could not be
     * left, and took the keyboard's place with it; a control that has been
     * replaced by one that works is the same information with a way out of it.
     *
     * `elsewhere` withdraws it too: a second dialog opened over somebody else's
     * running sign-in cannot start its own, so offering the button would be
     * offering the failure in `busyNote`.
     */
    signInOpen.hidden = !offersWindow || waiting || elsewhere

    /*
     * ONE SENTENCE, chosen by what the reader can do next — see `OPEN_NOTE`.
     * The stale clause is the only thing that ever joins it, because it reports
     * a change in the world ("this worked yesterday") that none of the others
     * cover.
     *
     * The waiting case is two sentences rather than one, twenty seconds apart:
     * `WAITING_LONG_NOTE` carries why.
     */
    const situation = waiting
      ? signIn?.nudged
        ? WAITING_LONG_NOTE
        : WAITING_NOTE
      : elsewhere
        ? busyNote(signIn?.host ?? "another site")
        : challenge.kind === "forbidden"
          ? REFUSED_NOTE
          : offersWindow
            ? OPEN_NOTE
            : NO_WINDOW_NOTE
    wallHint.textContent = [
      situation,
      !waiting && !elsewhere && stale
        ? "The sign-in saved for this site has stopped working."
        : "",
    ]
      .filter(Boolean)
      .join(" ")

    /*
     * And the protocol's own account of it, inside the fold. The Basic case
     * carries a second sentence that only this side can write — what the editor
     * will actually send — see `BASIC_NOTE`.
     */
    signInHint.textContent = [challenge.hint, challenge.kind === "basic" ? BASIC_NOTE : ""]
      .filter(Boolean)
      .join(" ")

    // Each fact appears only if this wall named it — an OAuth redirect carries
    // an audience and a 401 carries a realm, so at most one row is ever drawn.
    for (const entry of facts) {
      const value = challenge[entry.fact.key]
      entry.value.textContent = value
      entry.row.hidden = !value
    }
  }

  /**
   * A wall refused an add: put the question on screen, and remember the add so
   * it can be replayed.
   *
   * The box is emptied only when the WALL changes. Two refusals for the same
   * origin in a row is the ordinary shape of getting a long token slightly
   * wrong, and the half-pasted value is the thing being corrected — see
   * `submitSignIn`, which keeps it for exactly the same reason. A second
   * refusal from the same origin therefore repaints a dialog that is already
   * up rather than reopening it, which is why the modal call is guarded.
   *
   * `opener` is the control the add was committed from, and it is passed in
   * rather than read off the document for a reason that cost a bug: `addFrom`
   * disables that button for the length of the request, and disabling a focused
   * control moves focus to `<body>`. By the time a refusal lands,
   * `document.activeElement` is the body every time, so a dismissal would hand
   * the keyboard back to nowhere.
   */
  function openSignIn(
    wall: LibraryChallenge,
    input: AddLibraryInput,
    opener?: HTMLElement
  ): void {
    const moved = challenge?.origin !== wall.origin
    challenge = wall
    pendingAdd = input
    signInProblem = ""
    if (moved) {
      /*
       * A NEW WALL IS NOT WAITING ON THE LAST ONE'S SIGN-IN, and this line is
       * what says so. `closeSignIn` detaches on the ordinary route out, but the
       * dialog can also be re-pointed at a different site without ever having
       * been closed, and a dialog that inherited the previous site's run would
       * draw a wait it has no part in — the leak this state was reshaped to
       * make impossible, arriving by the one door left open.
       */
      signInRun += 1
      credentialField.value = ""
      setRevealed(false)
      setScheme(defaultScheme(wall))
      // A NEW site starts folded, whatever the last one ended as. The fold is
      // the answer to "do you have a token for this", and that is asked afresh
      // per origin — carrying a yes across from another site would put a reader
      // who has never seen the jargon straight back into it.
      setSignInMore(false)
    }
    paintSignIn()
    if (!signInDialog.open) {
      // Where the errand started, so dismissing puts the keyboard back on the
      // control that opened this rather than on `<body>`.
      signInReturn = opener ?? document.activeElement
      /*
       * `showModal`, not `show` and not the `open` attribute. It is the call
       * that supplies the top layer, the focus trap, the inertness and the
       * backdrop — see the block comment where this dialog is built.
       *
       * Guarded because JSDOM implements `<dialog>` without modality in some
       * versions; falling back to the attribute keeps the suites able to drive
       * the flow, which is what they are actually asserting.
       */
      if (typeof signInDialog.showModal === "function") signInDialog.showModal()
      else signInDialog.setAttribute("open", "")
      // The chrome's shared entrance, added on each open and removed on each
      // close. A CSS animation runs when the class lands, so a dialog that kept
      // it would arrive once a session and appear instantly ever after — the
      // same re-arming `panels/app-chooser.ts` does with its menu.
      signInDialog.classList.add("de-arrive")
    }
    /*
     * Focus follows what is actually on screen.
     *
     * Shut, this is a statement to read and there is no box to type into, so
     * the card takes focus itself — the same call the shortcuts sheet makes,
     * and for the same reason: landing on a button would be an answer to a
     * question nobody asked. `showModal` already does this when nothing inside
     * is autofocused; the explicit call is for the JSDOM path and for a repeat
     * refusal, where the dialog was already open and nothing moved focus.
     *
     * Open — a second refusal for the same origin, so the designer is already
     * correcting a token — the caret goes back in the box.
     */
    if (signInMoreOpen) focusControl(credentialField, { preventScroll: true })
    else signInDialog.focus({ preventScroll: true })
  }

  /**
   * Shut it, drop everything it was holding, and hand the keyboard back.
   *
   * `to` overrides where focus lands, for the one caller that needs it: a
   * sign-in that completed goes straight on to replay the add, and the button
   * that opened the dialog is about to be disabled for the length of that
   * request — focus restored onto it would be dropped to `<body>` a tick later.
   */
  function closeSignIn(to?: HTMLElement): void {
    challenge = null
    pendingAdd = null
    signInProblem = ""
    /*
     * DETACHED FROM WHATEVER IS IN FLIGHT, which is the half this used to miss.
     *
     * Everything else in this function was already reset and the wait was not,
     * so closing during a sign-in left a flag set that the NEXT dialog read as
     * its own: a fresh wall, a disabled primary button reading "Waiting…", and
     * Close as the only control that did anything. Bumping the run is the whole
     * fix, because the wait is derived from this number rather than stored.
     *
     * It does NOT abort the request, and that is deliberate. Close means "take
     * this dialog off my screen"; Cancel means "stop trying". A designer who
     * closes the dialog and then finishes signing in in the window that is still
     * open has done exactly what the dialog asked them to do, and the response
     * that lands is still allowed to adopt the credential and finish the add —
     * see the tail of `openProviderWindow`. What detaching prevents is that
     * response painting into, or closing, a dialog that has moved on.
     */
    signInRun += 1
    // The value goes with the dialog. A token left in a closed dialog is a
    // secret in the DOM of a page that will be open for hours, held for a wall
    // nobody is answering any more.
    credentialField.value = ""
    setRevealed(false)
    // Folded shut with it, so the next wall — a different site, a different
    // person's problem — opens on the plain sentence rather than on somebody
    // else's OAuth client id. Safe to route through `setSignInMore` because it
    // only moves focus on the way OPEN.
    setSignInMore(false)
    paintSignIn()

    const back = to ?? (signInReturn instanceof HTMLElement ? signInReturn : null)
    signInReturn = null
    if (!signInDialog.open) return
    signInDialog.classList.remove("de-arrive")
    /*
     * Closed at once, for the reason the shortcuts sheet gives: a modal still
     * open for a fade is a backdrop over the page that takes clicks and
     * Escapes. The kit's modal exit plays on an inert copy instead.
     */
    playExit(signInDialog, "modal")
    if (typeof signInDialog.close === "function") signInDialog.close()
    else signInDialog.removeAttribute("open")
    if (back?.isConnected) focusControl(back)
  }

  /**
   * Post the credential, and on a 200 replay the add it was refused for.
   *
   * The 200 is the whole of the evidence this surface has, and it is enough:
   * the route re-fetches the URL with the credential attached and refuses to
   * store one that does not open the wall, so a resolved promise here means the
   * site actually answered. Nothing below marks a sign-in optimistically, and
   * nothing marks one from a request this side merely sent.
   *
   * The replay is what makes the flow one act rather than two. The designer
   * pasted a link, was asked for a credential, and gave one; asking them to
   * find the link again afterwards would be the editor forgetting the errand it
   * interrupted them for.
   */
  /**
   * Start the two timers that watch a wait, and stop them when it is over.
   *
   * Both belong to the RUN rather than to the closure, so a response that
   * arrives after the designer has started a second sign-in cannot cancel the
   * second one's timers on its way out. `release` is written to be safe to call
   * twice for the same run — Cancel calls it before the abort, and the rejection
   * the abort produces calls it again on the way through.
   */
  function watchWait(run: SignInRun): void {
    run.nudge = setTimeout(() => {
      run.nudged = true
      if (signIn === run) paintSignIn()
    }, WAITING_NUDGE_MS)
    run.deadline = setTimeout(() => {
      run.expired = true
      run.abort.abort()
    }, WAITING_DEADLINE_MS)
  }

  function release(run: SignInRun): void {
    if (run.nudge !== null) clearTimeout(run.nudge)
    if (run.deadline !== null) clearTimeout(run.deadline)
    run.nudge = null
    run.deadline = null
    if (signIn === run) signIn = null
  }

  /**
   * Stop waiting, now, and say so.
   *
   * The dialog is repainted from this press rather than from the rejection the
   * abort will produce, because the two are not the same instant and the press
   * is the one the designer is watching. A transport that takes its time
   * failing — or one that has already stopped answering, which is the case this
   * exists for — would otherwise leave the button they just pressed looking
   * ignored.
   *
   * It cancels whichever run is in flight, including one this dialog did not
   * start. There is one browser profile behind all of them, so "the sign-in in
   * the way" is a thing any dialog is entitled to stop.
   */
  function cancelSignIn(): void {
    const run = signIn
    if (!run) return
    run.cancelled = true
    release(run)
    run.abort.abort()
    signInProblem = CANCELLED_NOTE
    paintSignIn()
    // Back onto the offer that has just returned to the row, since the control
    // the press landed on is the one that has gone.
    focusControl(signInOpen.hidden ? signInDialog : signInOpen, { preventScroll: true })
  }

  /**
   * Hand the wall back to whoever owns it, and wait.
   *
   * The await here is long by design — a person is signing in to their company
   * on the other side of it — so the dialog says what it is waiting for, offers
   * a way to stop, and bounds the wait rather than pretending to be instant. A
   * refusal comes back as a sentence rather than an exception, because closing
   * the window is an ordinary decision and not an error.
   *
   * On success it finishes the errand: the add that was refused is replayed, so
   * the designer gets the library they asked for rather than a signed-in state
   * and a form to fill in again.
   *
   * ## Everything this function needs is captured BEFORE the await
   *
   * `replay` especially, and it is the fix for a bug that lost a designer's
   * library without saying anything. It used to be read from `pendingAdd` after
   * the await — five minutes after, on the worst path — by which time the
   * closure variable is whatever the dialog is holding NOW. Two ways that goes
   * wrong, and both of them were reachable: close the dialog while waiting and
   * finish signing in anyway, and `pendingAdd` is `null`, so the editor says
   * "Signed in to storybook.acme.com" and quietly never adds the library; or
   * open a second wall while the first is in flight, and the first sign-in
   * replays the SECOND wall's add against the wrong site. Captured here, the
   * request carries its own errand and neither is possible.
   *
   * The run's own number is the other capture. Whether this response may still
   * draw on the dialog is decided by comparing it with `signInRun` afterwards,
   * never by looking at what the dialog currently shows.
   */
  async function openProviderWindow(): Promise<void> {
    if (!challenge) return
    /*
     * One at a time. The button is withdrawn while a run exists, so this is
     * only reachable by a second press queued in the same task as the first —
     * but the failure it prevents is bad enough to be worth the guard: two runs
     * launch the same Chrome profile twice and the second loses the singleton
     * race, which the designer reads as "the browser did not open".
     */
    if (signIn) {
      signInProblem = busyNote(signIn.host)
      paintSignIn()
      return
    }
    const target = challenge.url || pendingAdd?.url || ""
    if (!target) {
      signInProblem = NO_TARGET_NOTE
      paintSignIn()
      return
    }

    const replay = pendingAdd
    const run: SignInRun = {
      run: (signInRun += 1),
      host: hostOf(challenge),
      abort: new AbortController(),
      nudged: false,
      cancelled: false,
      expired: false,
      nudge: null,
      deadline: null,
    }
    signIn = run
    signInProblem = ""
    paintSignIn()
    // The press has just taken its own button off the row, so the keyboard is
    // moved to the control that replaced it rather than dropped on `<body>` —
    // the hazard this file warns about twice for `addFrom` and used to walk
    // into here, at the start of a wait that can run for minutes.
    focusControl(signInCancel, { preventScroll: true })
    watchWait(run)

    /*
     * Settled rather than try/catch/finally, so the flight can be released
     * BEFORE either outcome is handled. A `finally` runs after the handler, and
     * the handler repaints — which would draw one frame of a dialog that still
     * believes it is waiting on a request that has answered.
     */
    const settled: { ok: true; answer: ProviderSignInAnswer } | { ok: false; error: unknown } =
      await openProviderSignIn(editor.apiBase, target, { signal: run.abort.signal }).then(
        (answer) => ({ ok: true as const, answer }),
        (error: unknown) => ({ ok: false as const, error })
      )
    release(run)
    // Whether this response still owns the surface. A stale one may report what
    // it won and may not touch what is on screen.
    const mine = run.run === signInRun

    if (!settled.ok) {
      /*
       * An abort is not a fault and must not be reported as one: the platform's
       * `AbortError` says "The operation was aborted", which is true, unhelpful
       * and alarming. The run knows why it was aborted, so the sentence comes
       * from the run and the error is only consulted for failures nobody asked
       * for.
       */
      const said = run.cancelled
        ? CANCELLED_NOTE
        : run.expired
          ? DEADLINE_NOTE
          : messageOf(settled.error, "Could not open the sign-in")
      /*
       * The stale-server sentence is news about the PROCESS, not about this
       * dialog: the page has outrun the server it is talking to and the fix is
       * a restart in a terminal. It is toasted as well as printed so it
       * survives the dialog being closed, which is what a designer does next
       * when a button appears to do nothing.
       */
      if (isStaleServerNotice(said)) editor.toast(said, "error")
      if (mine) {
        signInProblem = said
        paintSignIn()
        if (document.activeElement === signInCancel || document.activeElement === document.body) {
          focusControl(signInOpen.hidden ? signInDialog : signInOpen, { preventScroll: true })
        }
        return
      }
      // The dialog it belonged to is gone. Cancelled runs are silent — the
      // designer asked for this and was told at the time — and anything else
      // goes to a toast, because a failure with nowhere to print is still a
      // failure somebody is waiting on.
      if (!run.cancelled && !isStaleServerNotice(said)) editor.toast(said, "error")
      return
    }

    const answer = settled.answer
    if (!answer.ok) {
      const said = answer.reason || "That sign-in did not complete. Try signing in again."
      if (mine) {
        signInProblem = said
        paintSignIn()
        return
      }
      editor.toast(said, "error")
      return
    }

    /*
     * The credential is real whether or not this dialog is still up: the server
     * verified it against the live URL and stored it before answering. So it is
     * adopted and announced first, and only then does the question of who owns
     * the screen come into it.
     */
    if (answer.origin) {
      adoptSignIn({
        origin: answer.origin,
        scheme: answer.scheme ?? "cookie",
        addedAt: answer.addedAt ?? Date.now(),
      })
    }
    editor.toast(`Signed in to ${answer.origin ?? "that site"}`)

    if (mine) {
      // Closed before the replay, for the reason `submitSignIn` gives: the
      // question has been answered and the add that follows is the editor
      // finishing the errand rather than something still waiting on the reader.
      closeSignIn(urlField)
      if (replay && (await addFrom(replay, urlAdd, "Could not read that link. Check the address, then add it again"))) {
        clearUrlField(replay)
      }
      return
    }

    /*
     * Detached, and the errand outlives the dialog.
     *
     * The designer closed this while it was in flight and then finished signing
     * in anyway — which is not an abandonment, it is them doing what the dialog
     * asked. Dropping the add here is what the old code did, and it produced
     * the worst possible pair of outcomes: a toast saying the sign-in worked,
     * and no library.
     *
     * The one case it is NOT allowed to finish is when another wall is on
     * screen. Replaying then would answer a question the designer is in the
     * middle of a different one of, so the add is handed back in words instead.
     */
    if (!replay) return
    if (challenge) {
      editor.toast(`Signed in. Add ${replay.url || replay.path} again to finish it.`)
      return
    }
    if (await addFrom(replay, urlAdd, "Could not read that link. Check the address, then add it again")) clearUrlField(replay)
  }

  async function submitSignIn(): Promise<void> {
    if (!challenge) return
    /*
     * Not while a window sign-in is out. Both paths end in the same three acts
     * — adopt the credential, close the dialog, replay the add — so two in
     * flight race to do them, and the loser writes its refusal into a dialog
     * that is already gone. The button is disabled by `paintSignIn` for the
     * length of the wait; this is the keyboard's way in, since the field still
     * takes Enter.
     */
    if (signIn) {
      signInProblem = busyNote(signIn.host)
      paintSignIn()
      return
    }
    const value = credentialField.value.trim()
    if (!value) {
      signInProblem = "Paste the credential first."
      paintSignIn()
      focusControl(credentialField, { preventScroll: true })
      return
    }

    // The URL the add was refused for, because that is what the server probes.
    // The origin's front page can be public while the page under it is not.
    const target = challenge.url || pendingAdd?.url || ""
    /*
     * THE PREVIOUS REFUSAL GOES BEFORE THE NEW REQUEST, and it is the fix for a
     * press that looks ignored.
     *
     * The route behind this re-fetches the walled URL with the credential
     * attached and gives that fetch fifteen seconds. For all of them the screen
     * used to hold the LAST refusal — "That credential was refused" — over a
     * greyed button, which is a perfect description of the attempt that already
     * failed and says nothing about the one that is running. Worse, when the
     * second attempt failed the same way, the repaint wrote identical text and
     * nothing on screen changed at all: a press with no observable consequence.
     */
    signInProblem = ""
    signInSubmitting = true
    paintSignIn()
    // Captured before the await, for the reason `openProviderWindow` gives at
    // length: `pendingAdd` is the dialog's current errand, and fifteen seconds
    // is long enough for the dialog to have been closed and reopened on another
    // site. The request carries the add it was made for.
    const replay = pendingAdd
    try {
      const record = await signInToLibrary(editor.apiBase, { url: target, scheme, value })
      signInSubmitting = false
      adoptSignIn(record)
      editor.toast(`Signed in to ${record.origin}`)
      /*
       * Closed BEFORE the replay, not after it.
       *
       * The question has been answered — the server verified the credential
       * against the live URL — and the add that follows is the editor finishing
       * the errand on the designer's behalf. A modal left up over it would make
       * a completed sign-in look like one still waiting on something, and would
       * hold the page inert for the length of a fetch of somebody's Storybook.
       *
       * Focus goes to the URL field rather than back to Add, which is about to
       * be disabled for the length of that request.
       */
      closeSignIn(urlField)
      if (replay && (await addFrom(replay, urlAdd, "Could not read that link. Check the address, then add it again"))) {
        clearUrlField(replay)
      }
    } catch (error) {
      /*
       * The field KEEPS what is in it, and this is the whole reason the
       * refusal is drawn here rather than thrown away in a toast.
       *
       * A refused token is usually a token that lost its last character to a
       * bad copy, or one that expired eleven minutes ago. Clearing the box
       * sends the designer back to a terminal for a string they already have,
       * and it does it at the exact moment they are most likely to give up on
       * the feature.
       */
      signInProblem = messageOf(error, "The site refused that credential. Check that it has not expired, then try again")
      focusControl(credentialField, { preventScroll: true })
    } finally {
      // Both paths, and painted from here rather than from each of them: the
      // label and the disabled state are derived, so the one thing either
      // outcome has to do is say the request is over and repaint.
      signInSubmitting = false
      paintSignIn()
    }
  }

  /* ---------- what this editor is signed in to ---------- */

  /** One origin's row, replacing whatever that origin had before. */
  function adoptSignIn(record: LibrarySignIn): void {
    signIns = [...signIns.filter((held) => held.origin !== record.origin), record]
    renderSignIns()
  }

  /**
   * What a credential's row is called: the libraries it opens, by name.
   *
   * An origin is plumbing — `https://storybook-3f81c0a2-ue.example.net` tells a
   * designer nothing about which design system it is — so the row is labelled
   * with the names of the installed libraries read from that origin, and the
   * link itself moves to the hover title. Before any library from the origin
   * has landed (the add is replayed after the sign-in), the bare host stands in.
   */
  function signedLabel(entry: LibrarySignIn): { name: string; link: string } {
    const opened = (libraryList() as InstalledLibrary[]).filter((library) => {
      try {
        return !!library.source.url && new URL(library.source.url).origin === entry.origin
      } catch {
        return false
      }
    })
    const host = entry.origin.replace(/^[a-z]+:\/\//i, "")
    if (!opened.length) return { name: host, link: entry.origin }
    return {
      name: opened.map((library) => library.name).join(", "),
      link: opened.map((library) => library.source.url).join("\n"),
    }
  }

  /** Relabel the rows in place, so a library landing does not rebuild them. */
  function paintSignedLabels(): void {
    const rows = [...signInRows.querySelectorAll<HTMLElement>('[data-de-lib="signed-in"]')]
    for (const entry of signIns) {
      const row = rows.find((candidate) => candidate.getAttribute("data-de-lib-id") === entry.origin)
      const nameEl = row?.querySelector<HTMLElement>(".de-lib-name")
      const forget = row?.querySelector<HTMLElement>('[data-de-lib="forget"]')
      if (!row || !nameEl || !forget) continue
      const { name, link } = signedLabel(entry)
      const when = entry.addedAt > 0 ? formatDate(entry.addedAt) : ""
      const word = SCHEME_WORDS[entry.scheme] ?? entry.scheme
      nameEl.textContent = name
      nameEl.title = `${link}\n${when ? `A ${word}, saved ${when}` : `A ${word}`}`
      const said = `Forget sign-in for ${name}. It will not load until you sign in again.`
      forget.title = said
      forget.setAttribute("aria-label", said)
    }
  }

  function signedRow(entry: LibrarySignIn): HTMLElement {
    // Two sentences, the way the library row's Remove is: "Forget" alone does
    // not say what stops working, and what stops working is every library on
    // that origin, silently, on the next refresh. `paintSignedLabels` writes
    // the final wording once the row is in the list.
    const said = `Forget the credential for ${entry.origin}.`
    const forget = el(
      "button",
      {
        class: "de-mini de-mini--danger",
        type: "button",
        title: said,
        "aria-label": said,
        "data-de-lib": "forget",
        "data-de-lib-id": entry.origin,
      },
      // Same size as the library row's remove X.
      [icon("XSmall", tokens.icon.marker)]
    ) as HTMLButtonElement
    forget.addEventListener("click", () => {
      forget.disabled = true
      void forgetLibrarySignIn(editor.apiBase, entry.origin)
        .then(async (forgotten) => {
          /*
           * THE SERVER'S ANSWER IS A BOOLEAN AND IT USED TO BE THROWN AWAY.
           *
           * `DELETE /libraries/auth` resolves with `{forgotten}` — false when
           * there was nothing of that origin to drop — and the old `.then`
           * ignored it, removed the row and toasted "Forgot the sign-in for X"
           * either way. That is a claim about the server's state made from the
           * client's, and the one time it is wrong is the one time it matters:
           * the two have disagreed, and the interface has just said the thing
           * that stops the designer investigating.
           *
           * So a `false` re-reads the list instead of asserting anything. The
           * row may come back — in which case the credential is still there and
           * the surface says so — or it may not, because something else dropped
           * it first. Either is the truth, and neither is this side's guess.
           */
          if (!forgotten) {
            signIns = await librarySignIns(editor.apiBase).catch(() => signIns)
            renderSignIns()
            editor.toast(`The editor was not holding a sign-in for ${entry.origin}`)
            return
          }
          signIns = signIns.filter((held) => held.origin !== entry.origin)
          editor.toast(`Forgot the sign-in for ${entry.origin}`)
          renderSignIns()
        })
        .catch((error: unknown) => {
          forget.disabled = false
          editor.toast(messageOf(error, `Could not forget ${entry.origin}. Try again.`), "error")
        })
    })

    return el(
      "div",
      { class: "de-lib-signed-row", "data-de-lib": "signed-in", "data-de-lib-id": entry.origin },
      [
        // The link, the kind of credential and the date live in the title.
        el("span", { class: "de-lib-name" }, [entry.origin]),
        forget,
      ]
    )
  }

  /**
   * Rebuilt by its own three events, and NOT by the store's beat.
   *
   * Sign-ins are not libraries: adding, toggling or removing a library changes
   * nothing here, and rebuilding this list on those notifications would drop
   * focus off a Forget button every time a switch was flipped two rows up. The
   * three things that do change it — the first load, a sign-in landing, a
   * credential being forgotten — each call this directly.
   */
  function renderSignIns(): void {
    signedBlock.hidden = signIns.length === 0
    clear(signInRows)
    for (const entry of signIns) signInRows.append(signedRow(entry))
    paintSignedLabels()
    // The sign-in dialog's hint reads this list to say whether it is replacing
    // a credential rather than adding a first one.
    paintSignIn()
  }

  function candidateRow(candidate: LibraryCandidate): HTMLElement {
    const add = el(
      "button",
      {
        class: "de-button",
        type: "button",
        disabled: candidate.installed,
        title: candidate.installed ? "Already added" : `Add ${candidate.path}`,
        "aria-label": candidate.installed
          ? `${candidate.name} is already added`
          : `Add ${candidate.name}`,
        "data-de-lib": "candidate-add",
      },
      [candidate.installed ? "Added" : "Add"]
    ) as HTMLButtonElement
    add.addEventListener("click", () => {
      void addFrom(
        { path: candidate.path, kind: candidate.kind },
        add,
        `Could not add ${candidate.path}`
      )
    })

    return el("div", { class: "de-lib-candidate", "data-de-lib": "candidate" }, [
      el("div", { class: "de-lib-line" }, [
        el("span", { class: "de-lib-name", title: candidate.name }, [candidate.name]),
        kindBadge(candidate.kind),
      ]),
      el("div", { class: "de-lib-detail" }, [candidate.detail]),
      el("code", { class: "de-lib-path", title: candidate.path }, [candidate.path]),
      el("div", { class: "de-lib-actions" }, [add]),
    ])
  }

  /**
   * The SHAPE of the answer, drawn while the walk that produces it is running.
   *
   * The scan is the one slow thing this section does — several seconds of
   * `stat` over a whole project — and for all of them the drawer used to be a
   * sentence over an empty box, which is also what a drawer looks like when the
   * request has quietly failed. Two rests where the candidates will land say
   * the useful thing about a gap, which is its shape.
   *
   * TWO, and not the three the lint panel's skeleton uses. That list is a page
   * of findings and three rests under-promise it; this one is the design-system
   * files in a project, and the ordinary answer is one or two. A ghost list
   * longer than the real one turns every successful scan into a small
   * disappointment.
   *
   * `aria-hidden`, because the status line beside it is a live region that has
   * already said "Scanning the project…" in words. A screen reader wants that
   * sentence, not a description of two grey rectangles.
   */
  function scanSkeleton(): HTMLElement {
    return el(
      "div",
      { class: "de-lib-scan", "aria-hidden": "true" },
      [0, 1].map(() => el("div", { class: "de-lib-scan-row" }))
    )
  }

  function renderCandidates(): void {
    clear(candidateList)
    status.textContent = scanning ? "Scanning the project…" : ""
    /*
     * The same attribute the lint header's button wears while its audit is in
     * flight, and deliberately the same word: one name for "this is working"
     * keeps the two indeterminate sweeps in the chrome one idea rather than
     * two. `css/libraries.ts` hangs the sweep off it.
     *
     * It is what turns "a scan is happening" into "a scan is getting
     * somewhere". The sentence alone cannot do that — it is identical on the
     * first frame and the last — and there is no honest number to put beside
     * it: `discoverLibraries` is one GET that answers with the finished list,
     * so the browser never learns how many files have been read. An
     * indeterminate mark is the whole of what this side knows.
     */
    if (scanning) status.setAttribute("data-de-busy", "")
    else status.removeAttribute("data-de-busy")

    if (scanning) {
      candidateList.append(scanSkeleton())
      return
    }
    if (scanError) {
      candidateList.append(el("p", { class: "de-lib-hint de-lib-error" }, [scanError]))
      return
    }
    if (!candidates.length) {
      candidateList.append(
        el("p", { class: "de-lib-hint" }, [
          `No design-system files found. ${RECOGNISED} Add one by path below.`,
        ])
      )
      return
    }
    /*
     * Dealt out rather than pasted in, once — on the paint that follows the
     * walk answering and on no other. The index rides on a custom property so
     * that one rule owns the step; capped, because the point of a stagger is
     * made in the first few rows and paid for in every row after them.
     */
    const arriving = justScanned
    justScanned = false
    candidates.forEach((candidate, index) => {
      const row = candidateRow(candidate)
      if (arriving) {
        row.classList.add("de-lib-candidate--arriving")
        row.style.setProperty("--de-lib-arrive", String(Math.min(index, ARRIVAL_STEPS)))
      }
      candidateList.append(row)
    })
  }

  /* ---------- the installed list ---------- */

  /**
   * The switch, as a toggle BUTTON rather than a checkbox or a `role="switch"`.
   *
   * `aria-pressed` on a plain button is the one shape where the accessible name
   * can stay still while the state moves — "Enable Brand tokens", pressed or
   * not — and a name that does not move is what a screen reader user needs to
   * find the same control twice in a list of eight. The alternative the Changes
   * tab uses, `role="switch"` with `aria-checked`, is right there because its
   * switches sit in a settings block where each one is named by the row it is
   * in; here the name has to carry the library it belongs to.
   *
   * It is drawn as a track and a travelling knob all the same, because what it
   * does — flip a thing on now, not record a preference for later — is what a
   * switch means. The drawing is `de-lib-switch` in `css/libraries.ts`.
   */
  function enableSwitch(library: InstalledLibrary): HTMLElement {
    const toggle = el("button", {
      class: "de-lib-switch",
      type: "button",
      "aria-pressed": String(library.enabled),
      "aria-label": `Enable ${library.name}`,
      title: library.enabled ? `Turn ${library.name} off` : `Turn ${library.name} on`,
      "data-de-lib": "enable",
      "data-de-lib-id": library.id,
    }) as HTMLButtonElement
    toggle.addEventListener("click", () => {
      const next = toggle.getAttribute("aria-pressed") !== "true"
      // Painted before the round trip, and corrected if it fails. A switch that
      // waits for a loopback response reads as a dead control on the one gesture
      // this section exists for.
      toggle.setAttribute("aria-pressed", String(next))
      toggle.disabled = true
      void setLibraryEnabled(editor.apiBase, library.id, next)
        .then(() => {
          editor.refresh()
          render()
        })
        .catch((error: unknown) => {
          toggle.setAttribute("aria-pressed", String(library.enabled))
          toggle.disabled = false
          editor.toast(
            messageOf(error, `Could not turn ${library.name} ${next ? "on" : "off"}. Try again.`),
            "error"
          )
        })
    })
    return toggle
  }

  /**
   * Where the library came from, on one line that cannot push anything off the
   * row.
   *
   * A URL prints as the URL and a file prints as its path, because those are
   * the two strings the person who added it typed. Both are unbounded, so the
   * line truncates and carries the whole of itself in `title` — a project path
   * nested six folders deep and a Storybook URL with a query on it fail the
   * same way and are fixed by the same rule.
   */
  function sourceLine(library: InstalledLibrary): HTMLElement {
    const where = library.source.url || library.source.path
    return el("code", { class: "de-lib-path", title: where }, [where])
  }

  function libraryRow(library: InstalledLibrary): HTMLElement {
    const remove = el(
      "button",
      {
        class: "de-mini de-mini--danger",
        type: "button",
        // Two sentences, because "Remove" alone leaves the reader guessing
        // whether this touches the file. It does not: the library is a pointer
        // at a path or a link, and removing it takes the pointer.
        title: `Remove ${library.name} (the file stays on disk)`,
        "aria-label": `Remove ${library.name} (the file stays on disk)`,
        "data-de-lib": "remove",
        "data-de-lib-id": library.id,
      },
      // `icon.marker`, like the annotation row's X: a 16px X fills the 18px
      // box edge to edge and reads louder than the name beside it.
      [icon("XSmall", tokens.icon.marker)]
    ) as HTMLButtonElement
    remove.addEventListener("click", () => {
      remove.disabled = true
      void removeLibrary(editor.apiBase, library.id)
        .then(async () => {
          // The path is free to be offered again the moment it is gone.
          for (const candidate of candidates) {
            if (candidate.path === library.source.path) candidate.installed = false
          }
          editor.toast(`Removed ${library.name}`)
          editor.refresh()
          /*
           * Close the card before the list is rebuilt without it.
           *
           * The request has already landed by here, so this is not a pending
           * state — it is the ending, which used to be the card merely not
           * appearing in the next render. The same helper the annotations list
           * uses, deliberately: two panels removing a row two different ways is
           * exactly the drift this codebase keeps closing elsewhere.
           */
          const card = remove.closest(".de-lib-card")
          if (card instanceof HTMLElement) await leaveRow(card)
          render()
        })
        .catch((error: unknown) => {
          remove.disabled = false
          editor.toast(messageOf(error, `Could not remove ${library.name}. Try again.`), "error")
        })
    })

    return el(
      "div",
      {
        class: library.enabled ? "de-lib-card" : "de-lib-card de-lib-card--off",
        "data-de-lib": "library",
        "data-de-lib-id": library.id,
      },
      [
        el("div", { class: "de-lib-line" }, [
          el("span", { class: "de-lib-name", title: library.name }, [library.name]),
          el("span", { class: "de-lib-actions" }, [enableSwitch(library), remove]),
        ]),
        // A library that failed to parse still says so; one that read cleanly
        // shows only its name and where it came from.
        library.error ? el("div", { class: "de-lib-error" }, [library.error]) : null,
        sourceLine(library),
      ]
    )
  }

  /* ---------- render ---------- */

  /**
   * Which control the keyboard was standing on, so a rebuild can put it back.
   *
   * The list is rebuilt whole on every store notification, and the write that
   * causes the notification is usually a press of one of the buttons IN it — so
   * without this, toggling a library with the keyboard drops focus to `<body>`
   * and there is nothing left to Tab from. The identity is the pair the test
   * hooks already carry, `data-de-lib` plus `data-de-lib-id`, rather than an
   * index path: a remove takes a whole row out, and every path after it would
   * then point at the wrong library. Same problem and same shape as
   * `restoreFocus` in `panels/inspector/index.ts`, on a much smaller surface.
   */
  function focusedControl(): { action: string; id: string } | null {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !list.contains(active)) return null
    const action = active.getAttribute("data-de-lib")
    if (!action) return null
    return { action, id: active.getAttribute("data-de-lib-id") ?? "" }
  }

  function restore(memory: { action: string; id: string } | null): void {
    if (!memory) return
    const match = [...list.querySelectorAll<HTMLElement>("[data-de-lib]")].find(
      (candidate) =>
        candidate.getAttribute("data-de-lib") === memory.action &&
        (candidate.getAttribute("data-de-lib-id") ?? "") === memory.id
    )
    focusControl(match, { preventScroll: true })
  }

  /** The list the rows were last built from; see `update`. */
  let painted: Library[] | null = null

  function render(): void {
    const memory = focusedControl()
    /*
     * The same pairing `restore` makes above, one axis over: this render is
     * driven by the store, so it lands while a reader is toggling a library
     * three rows down, and an emptied list is clamped to the top by the next
     * layout. Focus without scroll puts the caret back on a control that is no
     * longer on screen. `core/scroll.ts` carries the mechanism.
     */
    const hold = holdScroll(node)
    const libraries: InstalledLibrary[] = libraryList()
    painted = libraries

    // Silent at zero, the way the Handover heading's count is.
    count.textContent = libraries.length ? String(libraries.length) : ""

    clear(list)
    for (const library of libraries) list.append(libraryRow(library))
    // A credential's row is named after the libraries it opens.
    paintSignedLabels()

    if (addOpen) renderCandidates()
    restore(memory)
    hold.release()
  }

  function update(): void {
    // The first paint is what asks the server for the list. Doing it at mount
    // time would put a request on every page load for a feature most sessions
    // never open, which is the same call `core/icon-set.ts` makes about its
    // 114KB of path data.
    if (!loaded) {
      loaded = true
      void loadLibraries(editor.apiBase).then(() => render())
      /*
       * The sign-ins ride the same first paint, and a failure here is warned
       * about rather than toasted.
       *
       * An editor with no credentials at all is the ordinary case and answers
       * this with an empty list, which draws nothing — so a request that fails
       * produces exactly what a successful one usually produces, and a toast
       * about it would be an error message for a feature the reader has never
       * used. Same bargain `loadLibraries` strikes one line up.
       */
      void librarySignIns(editor.apiBase)
        .then((origins) => {
          signIns = origins
          renderSignIns()
        })
        .catch((error: unknown) => {
          console.warn("[designlayer] could not list the library sign-ins", error)
        })

      /*
       * Whether a sign-in window is even possible here, asked once.
       *
       * A machine with no Chrome-family browser cannot be offered one, and a
       * button that opens nothing is worse than an honest fold. Asked at load
       * rather than at the moment the dialog opens, because the answer is a
       * property of the machine and the dialog is a place a person is already
       * waiting. It defaults to true so the ordinary case never waits on this
       * request, and only ever narrows.
       */
      void canOpenProviderSignIn(editor.apiBase).then((available) => {
        canOpenWindow = available
        if (challenge) paintSignIn()
      })
    }
    /*
     * The tab calls this on every selection while it is showing, and nothing a
     * selection changes is drawn here. The list is replaced, never mutated, on
     * every write, so an unchanged identity means the rows on screen are still
     * the rows; every write also renders on its own through the subscription.
     */
    if (libraryList() !== painted) render()
  }

  // The controls in the sign-in dialog that carry state in an attribute rather
  // than in their markup, put into their resting position once. The reveal
  // toggle also has no glyph until this runs — its icon is chosen by the state,
  // so there is no sensible one to write into the constructor — and the fold
  // owns whether the submit is on screen, which nothing else sets at build
  // time.
  setRevealed(false)
  setScheme(scheme)
  setSignInMore(false)

  subscribeToLibraries(() => render())

  /*
   * The editor standing down takes the dialog with it.
   *
   * ⌘. hides the whole chrome and is deliberately answered from wherever focus
   * happens to be, including from inside a modal — that is the `everywhere`
   * flag on the `chrome.toggle` row in `core/keymap.ts`, which is the one
   * shortcut not gated on the chrome being visible. This
   * dialog hangs off `document.body` rather than off the panel, so nothing
   * would carry it away: the panels would slide out and leave a card and an
   * inert page behind, with the one surface that explains them gone. Closed
   * instead, which is also the honest reading of the gesture — a designer
   * putting the editor away is not still answering its questions.
   */
  editor.subscribe((state, previous) => {
    if (state.chromeHidden && !previous.chromeHidden) closeSignIn()
  })

  return { node, update }
}
