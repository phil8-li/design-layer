/**
 * Signing in to a walled design system by opening the SITE'S OWN sign-in, in a
 * real browser window, and keeping whatever session that produces.
 *
 * ## The thing this replaces
 *
 * `library-auth.mjs` explains the gap: the editor's Node process fetches the
 * library URL and holds none of the designer's sessions. The first answer to
 * that gap was to ask the designer for a credential — paste a bearer token, or
 * paste a Cookie header out of dev tools.
 *
 * That answer asks the wrong person. A designer who pastes a private Storybook
 * link is not holding a token and usually has no supported way to get one.
 * Behind an SSO proxy the tooling that mints tokens is frequently built for
 * automation rather than for people, and will refuse to issue one against a
 * human account at all — which leaves copying a session cookie out of dev
 * tools, or standing up an OAuth client to mint against. Both are a small
 * infrastructure project standing between a person and a component list, and
 * both make this editor the keeper of a credential system it has no business
 * owning.
 *
 * The site already has a sign-in. It is the one the designer uses every day, it
 * knows how to do two-factor and device policy and account choosing, and it is
 * the only party entitled to decide whether this person gets in. So this module
 * does not ask for a credential. It opens that sign-in and waits.
 *
 * ## The measurement that settles it
 *
 * Driven against a real proxy-protected Storybook, the DevTools protocol
 * reports every cookie in the exchange — the proxy's own nonce on the target
 * origin, and the identity provider's session cookies at the host it bounced to
 * — as `httpOnly=true; secure=true`. Meanwhile `document.cookie`, evaluated in
 * that same page, returns the empty string.
 *
 * A flow that asks somebody to paste their session is therefore asking for a
 * value no page can read and most people cannot reach — while a browser hands
 * the same value over in one call. That is not a preference between two
 * designs; one of them cannot be completed by the person it is addressed to.
 *
 * ## The flow
 *
 *   launch a browser the editor owns -> open the library URL in it ->
 *   the site's own sign-in appears -> the person signs in as they always do ->
 *   the page lands back on the target origin -> take the session cookies for
 *   that origin -> verify them -> store them -> retry the fetch
 *
 * Only the middle step involves the designer, and it is the step they already
 * know how to do. Nothing is typed into this editor.
 *
 * ## Why a separate browser profile rather than theirs
 *
 * Chrome will not accept a debugging connection into a profile that is already
 * running, and taking over the browser somebody has their work in is rude even
 * when it is possible. A profile of our own under the editor's state directory
 * also means the session is remembered: sign in to an origin once and every
 * later library on that origin — and every later run of the editor — is already
 * through. That is the difference between a sign-in and a chore.
 *
 * ## Why the DevTools protocol rather than a browser-automation dependency
 *
 * Two reasons, and the second is the one that matters here. It adds no
 * dependency to a package that ships to other people's machines — `ws` is
 * already in this tree. And it drives the browser the person already has
 * installed, signed by its own vendor, rather than a browser build downloaded
 * at install time — which on a centrally managed machine is precisely the kind
 * of unrecognised binary that software policy blocks from running, and a
 * centrally managed machine behind an SSO proxy is exactly the case this
 * feature exists for.
 *
 * ## The session: one run per profile
 *
 * Every run uses the same profile directory, and Chrome lets one process own a
 * profile at a time: a second launch relays its command line to the first and
 * exits. So the profile has one owner, written down as a state, and every way a
 * run can end is a transition rather than a comment:
 *
 *   idle --signIn--> silent
 *   silent --landed--> verifying            (done, when the caller verifies itself)
 *   silent --needs-human | timed-out--> waitingForPerson
 *   silent --any other outcome--> failed
 *   waitingForPerson --landed--> verifying  (done, when the caller verifies itself)
 *   waitingForPerson --closed | timed-out | fault--> failed
 *   verifying --confirmed--> done
 *   verifying --refused--> failed
 *   silent | waitingForPerson | verifying --every caller gone--> cancelled
 *   done | failed | cancelled --browser stopped--> idle
 *   idle --forgetOrigin--> forgetting --cookies cleared or not--> idle
 *
 * A second `signIn` while a run is live joins it when it is for the same
 * origin, and is refused with a sentence when it is for another. A `signIn` or
 * `forgetOrigin` that arrives while the profile is being let go of (a forget,
 * a run tearing down) waits for `idle`. Nothing launches a second browser on a
 * profile that already has one.
 *
 * A caller passes an `AbortSignal`; when every caller of a run has aborted, the
 * run is `cancelled`: its window closes, its browser stops, and whatever it
 * would have produced is discarded. The transition is the guard — a completion
 * whose run no longer owns the session cannot move it, so a sign-in finished
 * after a cancel is never verified or stored.
 *
 * ## What is deliberately not here
 *
 * No token minting, no OAuth client id of our own, no refresh logic. When the
 * session expires the site says so, the wall comes back, and the same window
 * opens again — usually landing straight through, because the browser profile
 * still holds the identity provider's own session. The provider decides how
 * long a session lasts, which is the correct place for that decision to live.
 */

import fs from "node:fs/promises"
import path from "node:path"

import {
  COMMAND_TIMEOUT,
  EXIT_GRACE,
  RAISE_BUDGET,
  browserCandidates,
  findBrowser,
  raiseWindow,
  sleep,
  timeLeft,
  withBrowser,
} from "./cdp-browser.mjs"
import { classifyWall, originOf } from "./library-auth.mjs"

// Re-exported for the suites that pin how a browser is found.
export { browserCandidates, findBrowser }

/** How long to wait for a person to finish signing in, in milliseconds. */
const SIGN_IN_TIMEOUT = 4 * 60 * 1000
/*
 * The silent pass's ceiling, and why it is generous.
 *
 * ESCALATION IS DECIDED BY EVIDENCE, NOT BY THIS NUMBER. A fixed budget was the
 * first attempt and it was wrong in both directions: measured here, a first-run
 * Chrome against a brand-new profile takes over twelve seconds to get anywhere
 * — cold start, not a wall — while a warm one finishes the whole redirect dance
 * in about one. Any threshold that let the cold case through would make
 * somebody who genuinely has to sign in sit and watch nothing happen first.
 *
 * So the silent pass waits until it can see WHICH case it is in: parked on a
 * login page means a human is needed and it gives up at once, while "still
 * loading" is simply waited out. This ceiling exists only so a browser that has
 * hung cannot hold the flow forever.
 */
const SILENT_CEILING = 45 * 1000
/*
 * How long a cross-origin page has to sit unchanged before it counts as a login
 * page waiting for a person rather than a redirect in flight.
 *
 * Two and a half seconds is longer than any hop in an OAuth chain and shorter
 * than anybody's patience.
 */
const PARKED_MS = 2500
/** How often to look at where the window has got to. */
const POLL_INTERVAL = 600
/*
 * How many polls in a row may go unanswered before the window counts as gone.
 *
 * Three, so a renderer that is merely busy — a heavy two-factor step, a slow
 * redirect — costs a poll rather than the whole sign-in. See the loop.
 */
const UNANSWERED_POLLS = 3
/*
 * Everything a call spends OUTSIDE the two waits for a person, allowed for once.
 *
 * `SILENT_CEILING` bounds the silent poll loop and `SIGN_IN_TIMEOUT` bounds the
 * visible one, and those two numbers are what this module advertises. They were
 * never what it cost. Between and around them sit two browser launches, two
 * attaches, a handful of protocol commands, the window raise, a cookie read and
 * two teardowns — each bounded on its own, none of them counted against
 * anything, so the real worst case was the SUM of a dozen independent bounds
 * rather than the ceiling printed on the box.
 *
 * One minute covers all of it with room to spare on a slow machine, and it is
 * deliberately an allowance rather than a per-phase budget: a launch that takes
 * eighteen seconds is legal and should not steal the eighteen seconds the
 * cookie read might need, but the two of them together still cannot push the
 * call past its deadline, because every phase is clamped to that one deadline
 * rather than to a share of it.
 */
const OVERHEAD_ALLOWANCE = 60 * 1000

/*
 * What the whole answer can take beyond the run's own deadline, so a caller can
 * know when to stop waiting rather than guess.
 *
 * The deadline bounds the run, and the run can pass it by the one bounded
 * operation in flight when it did — a command and a teardown, under twenty
 * seconds (see `signIn`). Verification comes after: the route fetches the
 * library once with the captured session, fifteen seconds, or about thirty when
 * the fetch helper runs (`library-url.mjs`). `budgetMs` in every answer is the
 * sum, so the panel can derive its own deadline from it instead of keeping a
 * number that has to be remembered to stay larger than this one.
 */
const OVERRUN_ALLOWANCE = COMMAND_TIMEOUT + EXIT_GRACE + 2500
const VERIFY_ALLOWANCE = 30 * 1000

/** The run's deadline, as a duration: see `signIn` for the arithmetic. */
const runBudget = (options = {}) =>
  options.totalTimeoutMs ?? SILENT_CEILING + (options.timeoutMs ?? SIGN_IN_TIMEOUT) + OVERHEAD_ALLOWANCE

/** The longest a sign-in answer can take to arrive. */
const answerBudget = (options = {}) => runBudget(options) + OVERRUN_ALLOWANCE + VERIFY_ALLOWANCE

/*
 * The outcomes more than one place returns. `code` is what callers branch on
 * (escalation, the route, an agent); `reason` is the sentence a person reads.
 */
const NEEDS_HUMAN = Object.freeze({
  ok: false,
  code: "needs-human",
  reason: "That site needs a person to sign in",
})
const CANCELLED = Object.freeze({ ok: false, code: "cancelled", reason: "The sign-in was cancelled." })

/** Whether a URL is on `origin` — the origin itself, not a host that starts with it. */
const sameOrigin = (url, origin) => Boolean(origin) && originOf(url) === origin

/**
 * One browser run: open the URL, follow it until it lands on the target origin
 * or gives up, and hand back whatever session it produced.
 *
 * Shared by both passes of a sign-in so that the silent attempt and the
 * visible one cannot drift apart — the only difference between them is
 * `headless` and how long they are willing to wait.
 *
 * Resolves with `{ ok: true, code: "landed", cookie }` when the window came back
 * to the target origin carrying cookies, and with `{ ok: false, code, reason }`
 * for every way that can fail to happen:
 *
 *   needs-human    the silent pass is parked on a login page (escalate)
 *   timed-out      the pass ran out of time, or the page stopped answering
 *   closed         the person closed the window
 *   no-session     it landed, but left no cookie to reuse
 *   launch-failed | no-page | attach-failed   see `withBrowser`
 *   fault          the browser broke mid-run
 *   cancelled      `signal` aborted
 *
 * It never throws for an ordinary outcome — a person closing the window is a
 * normal thing to do, not an exception.
 *
 * `deadline` is an ABSOLUTE timestamp the caller owns, and it outranks
 * `timeoutMs`: the latter is how long this pass would like to wait for a
 * person, the former is when the whole call must be over whatever it is in the
 * middle of. Every phase below clamps to it. See `signIn`, which computes it.
 */
async function runWindow({
  browserPath,
  profileDir,
  target,
  origin,
  headless,
  timeoutMs,
  commandTimeout,
  raiseCommand = [],
  deadline = Date.now() + timeoutMs + OVERHEAD_ALLOWANCE,
  signal,
}) {
  let outcome
  try {
    outcome = await withBrowser(
      { browserPath, profileDir, url: target, headless, deadline, commandTimeout, signal },
      ({ cdp, child }) =>
        followToLanding({ cdp, child, target, origin, headless, timeoutMs, raiseCommand, deadline, signal })
    )
  } catch (error) {
    /*
     * A BROWSER FAULT IS AN OUTCOME, NOT AN EXCEPTION.
     *
     * There was no `catch` here, which was invisible for as long as nothing in
     * the run could reject: the commands either answered or hung forever.
     * Bounding them turned the hang into a rejection, and a rejection thrown
     * out of here escapes the sign-in, escapes the route, and reaches the panel
     * as a 500 — so the fix for the freeze would have replaced it with a red
     * error where the contract promises a sentence.
     *
     * Every other way this function fails already returns `{ ok: false,
     * reason }`, and the caller is written to expect exactly that; see the
     * route, which turns a refusal into a 200 with the reason attached because
     * a person closing a window is an ordinary thing to do. A failure before
     * there was a window is `withBrowser`'s to report, and arrives below as a
     * code rather than here as a throw.
     */
    if (signal?.aborted) return CANCELLED
    const detail = error instanceof Error && error.message ? `: ${error.message}` : ""
    return { ok: false, code: "fault", reason: `The sign-in window stopped responding${detail}` }
  }

  // Whatever the run found after a cancel, nobody asked for it any more.
  if (signal?.aborted) return CANCELLED
  if (outcome.ok || !LAUNCH_REASONS[outcome.code]) return outcome
  return { ok: false, code: outcome.code, reason: LAUNCH_REASONS[outcome.code](outcome.error) }
}

/** The sentence for each way `withBrowser` can fail before there is a window. */
const LAUNCH_REASONS = {
  "launch-failed": (error) =>
    error
      ? `The editor could not start the sign-in browser${error.message ? `: ${error.message}` : ""}`
      : "The browser did not open. Try signing in to the site in your own browser, then add the " +
        "library again.",
  "no-page": () => "The browser opened without a page the editor could follow",
  "attach-failed": () => "The editor could not attach to the sign-in window",
  cancelled: () => CANCELLED.reason,
}

/** The part of a run that happens once there is a page to drive. */
async function followToLanding({ cdp, child, target, origin, headless, timeoutMs, raiseCommand, deadline, signal }) {
  /*
   * ENABLING `Page` MAKES US RESPONSIBLE FOR JAVASCRIPT DIALOGS, and not
   * knowing that is the likeliest way this flow froze.
   *
   * Chrome normally shows an `alert`, `confirm` or `beforeunload` itself and
   * the renderer waits for the person to dismiss it. With the Page domain
   * enabled, it stops doing that: the dialog is reported to the client as
   * `Page.javascriptDialogOpening` and the renderer stays blocked until the
   * client answers with `Page.handleJavaScriptDialog`. Nothing here ever did,
   * so one dialog anywhere in a sign-in chain — a `beforeunload` on a partly
   * filled form, a provider's "are you still there" — stopped the page dead.
   * `Runtime.evaluate` against a blocked renderer never answers, which is
   * precisely the shape of hang the command timeout (`cdp-browser.mjs`) was
   * written for.
   *
   * DISMISSED, EXCEPT FOR `beforeunload`, and that exception is a bug fix
   * rather than an inconsistency.
   *
   * Dismissing everything was the first version, on the reasoning that these
   * dialogs belong to the site and answering "yes" on somebody's behalf is a
   * decision this editor has no business making. That reasoning is right for
   * `confirm` and `prompt` — a question with two real answers, where the
   * conservative one is to decline — and it is exactly backwards for
   * `beforeunload`, because `beforeunload` is not a question about the page.
   * It is a confirmation of a NAVIGATION, and dismissing it means "stay here":
   * it cancels the very thing that was just asked for.
   *
   * Both halves of this flow ask for navigations. `Page.navigate` below is
   * one, and a dismissal silently turns it into nothing — the command still
   * resolves, no new document ever arrives, and the run burns its whole
   * ceiling on a page it believes it asked to leave. The person's own clicks
   * are the other and the worse one: they press the provider's Continue
   * button, the login page's unload guard fires, this handler answers "stay",
   * and nothing happens. They press it again. Nothing happens again. They
   * cannot answer the dialog themselves, because enabling the Page domain took
   * that away from them, so the window sits live, focused and unusable until
   * the ceiling kills it.
   *
   * `alert` stays on the dismissing side purely because there is nothing to
   * choose: an alert has one button, and the protocol closes it either way.
   *
   * Registered BEFORE `Page.enable`, not after it, and the ordering is a bug
   * a test caught rather than a preference. Chrome may report a dialog on the
   * document that is already loading the instant the domain comes up, and a
   * listener attached one await later misses it — leaving exactly the frozen
   * renderer this is here to prevent, in the one case hardest to reproduce.
   * Attaching first costs nothing: an event for a domain that is not enabled
   * yet is simply never sent.
   */
  cdp.on("Page.javascriptDialogOpening", (params) => {
    const accept = String(params?.type ?? "") === "beforeunload"
    // Best-effort and unawaited: this runs inside the socket's message
    // handler, and a rejection here must not take the run down with it.
    void cdp.send("Page.handleJavaScriptDialog", { accept }).catch(() => {})
  })

  await cdp.send("Page.enable")
  await cdp.send("Network.enable")

  /*
   * LANDED MEANS THE SITE SERVED THE PAGE, not that the address bar is
   * pointing at it.
   *
   * The window is launched ON the target URL, so for the first instant of
   * every run the address bar already reads as the target origin — before a
   * single byte has come back, and before the proxy has had its chance to
   * bounce the request to a sign-in. A check on the URL alone therefore
   * "lands" immediately, reads the cookies that do not exist yet, and reports
   * a site that grants no reusable session. Which is exactly what it did:
   * this is the bug the live test caught, and it was invisible against a slow
   * remote host and certain against a fast local one.
   *
   * The honest signal is the main frame's own document response: a 2xx whose
   * URL is on the target origin means the site answered with a page rather
   * than with a redirect to somebody's login. Redirect statuses never satisfy
   * it, so the whole OAuth dance can run through without ever looking like an
   * arrival.
   */
  let mainFrame = ""
  let servedUrl = ""
  let servedStatus = 0
  let servedAt = 0
  let servedType = ""

  cdp.on("Page.frameNavigated", (params) => {
    // The main frame is the one with no parent. Subframes navigate too, and a
    // tracking pixel inside a login page must not count as an arrival.
    if (!params?.frame || params.frame.parentId) return
    mainFrame = params.frame.id
  })
  cdp.on("Network.responseReceived", (params) => {
    if (params?.type !== "Document") return
    if (mainFrame && params.frameId && params.frameId !== mainFrame) return
    servedUrl = String(params.response?.url ?? "")
    servedStatus = Number(params.response?.status ?? 0)
    servedType = String(params.response?.mimeType ?? "")
    servedAt = Date.now()
  })

  /*
   * A LOGIN PAGE THE SITE SERVED ITSELF IS NOT AN ARRIVAL, and reading it as
   * one is the closest thing in this file to the reported symptom: press Sign
   * in, no window ever appears, and the answer is a sentence telling you to go
   * and find a token.
   *
   * The test above is satisfied by a 2xx document on the target origin with
   * the address bar to match — and a site that renders its own `/login` at 200
   * satisfies every word of that. Escalation to a visible window, meanwhile,
   * was triggered only by parking CROSS-ORIGIN. So for the whole family of
   * sites whose sign-in lives on their own origin — a self-hosted Storybook
   * behind a form, a dashboard with a JavaScript auth gate, anything that
   * routes rather than redirects — the silent pass "landed" on the login
   * screen, scraped whatever the login page had set (a CSRF token is enough to
   * look like a session), and returned success. No window was ever shown, the
   * route then probed the wall, found it still there, and told the person the
   * site "may need a token" — for a site that needed them to type a password.
   *
   * So an arrival now has to prove it is not a wall, and the proof is the one
   * this codebase already owns: `classifyWall` is the module that decides what
   * a wall looks like, and one of the two shapes it recognises is precisely a
   * 200 carrying a password input. Importing it rather than sniffing for a
   * `<input type=password>` here keeps that judgement in ONE place — a second
   * copy would be the version that never learns about the next shape, and the
   * two would disagree about the same page, which is the bug above wearing a
   * different hat.
   *
   * The live DOM is what gets classified, not the response body. It costs one
   * evaluation, it is already the thing being polled, and it sees a login form
   * that a framework rendered on the client — which a body read cannot.
   *
   * Cached against the response and the URL together so a page that sits still
   * is classified once rather than every poll, and re-classified the moment
   * either changes — which is what makes this safe on the visible pass, where
   * the person is expected to be looking at a login page right up until they
   * are not.
   */
  let wallCheckedFor = ""
  let servedIsWall = false
  const servedIsLoginPage = async (current) => {
    const key = `${servedAt}|${current}`
    if (wallCheckedFor === key) return servedIsWall
    wallCheckedFor = key
    let markup = ""
    try {
      const { result } = await cdp.send("Runtime.evaluate", {
        // Capped because a design system's own index page can be large and
        // none of this needs more than the top of the document to decide.
        expression: "document.documentElement ? document.documentElement.outerHTML : ''",
        returnByValue: true,
      })
      markup = String(result?.value ?? "").slice(0, 20000)
    } catch {
      /*
       * A renderer that will not answer cannot be classified, and guessing
       * "wall" here would turn one lost command into a sign-in that can never
       * complete. The poll loop already has a policy for a browser that has
       * gone quiet — three strikes — so leave the decision to it and let this
       * arrival stand or fall on the response alone.
       */
      markup = ""
    }
    servedIsWall = Boolean(
      classifyWall(
        { status: servedStatus, headers: {}, contentType: servedType, text: markup },
        servedUrl
      )
    )
    return servedIsWall
  }

  /*
   * RAISE THE WINDOW, or the whole flow can fail silently.
   *
   * The sign-in opens in a second instance of a browser the designer almost
   * certainly already has running, and macOS does not bring a new window of
   * an existing application forward on its own. So the window can be there,
   * correctly pointed at the provider, and completely invisible behind
   * whatever the person was looking at — they see a panel that says it is
   * waiting for a sign-in window, and no sign-in window. Measured exactly
   * that way: `document.hasFocus()` false on a visible, correctly placed,
   * correctly navigated window.
   *
   * Only for the visible pass: raising a headless window is meaningless, and
   * the silent pass must never steal focus.
   */
  if (!headless) {
    await raiseWindow(cdp, child.pid, raiseCommand, Math.min(Date.now() + RAISE_BUDGET, deadline))
  }

  /*
   * NAVIGATE OURSELVES, after attaching, rather than trusting the URL on the
   * command line.
   *
   * The browser is launched pointing at the target, and on a warm profile it
   * has often finished the whole redirect chain before this process has
   * attached — so the document responses that decide "landed" were delivered
   * to nobody and the flow waited out its ceiling staring at a page that had
   * already arrived. Measured cold, that gap is over twelve seconds wide.
   *
   * Navigating here closes it: every run observes its own navigation from the
   * start. The command-line URL stays because it is what the person sees
   * while the window opens, and a repeat GET of the same address costs a
   * round trip and nothing else.
   */
  try {
    await cdp.send("Page.navigate", { url: target })
  } catch {
    // A navigation that will not start is reported by the loop below as a
    // run that never landed, which is the same outcome by a plainer route.
  }

  /*
   * The poll's own ceiling, or the call's, whichever comes first.
   *
   * `timeoutMs` is how long this pass is willing to wait for a person; the
   * deadline is when the caller has to have an answer regardless. Taking the
   * earlier of the two is what stops the second pass promising four fresh
   * minutes to a call that has already spent its budget getting here.
   */
  const until = Math.min(Date.now() + timeoutMs, deadline)
  let landed = false
  /*
   * A command that times out is not on its own a reason to give up on the
   * person.
   *
   * Every `send` is bounded now, which is what stopped this loop hanging
   * forever — but the bound is a blunt instrument: a renderer busy for
   * fifteen seconds during a two-factor step would look identical to a dead
   * one, and abandoning a sign-in somebody is halfway through is a worse
   * failure than the hang was. So a lost answer costs a poll, not the run,
   * and only a browser that has gone quiet for three of them in a row is
   * treated as gone. The socket closing is still immediate: that is the
   * window actually being shut, which is a decision rather than a symptom.
   */
  let silentPolls = 0

  while (Date.now() < until) {
    if (cdp.closed || signal?.aborted) break
    let current = ""
    try {
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      })
      current = String(result?.value ?? "")
      silentPolls = 0
    } catch {
      silentPolls += 1
      if (silentPolls >= UNANSWERED_POLLS) break
      continue
    }
    if (
      sameOrigin(servedUrl, origin) &&
      servedStatus >= 200 &&
      servedStatus < 300 &&
      sameOrigin(current, origin)
    ) {
      if (!(await servedIsLoginPage(current))) {
        landed = true
        break
      }
      /*
       * The site's own login page, on the target origin — which is a sign-in
       * waiting for a person just as much as a cross-origin park is, and the
       * silent pass should say so in the same words rather than sit here. No
       * settling period, unlike the parked test below: a password field is
       * not a redirect in flight, it is the end of one.
       */
      if (headless) return NEEDS_HUMAN
    }

    /*
     * A silent pass that is parked on somebody else's page is a sign-in
     * waiting for a human. Give up immediately rather than burning the
     * ceiling: the caller's next move is to open a real window, and every
     * second spent here is a second the designer spends looking at nothing.
     */
    if (
      headless &&
      servedUrl &&
      !sameOrigin(servedUrl, origin) &&
      servedStatus >= 200 &&
      servedStatus < 300 &&
      Date.now() - servedAt > PARKED_MS
    ) {
      return NEEDS_HUMAN
    }

    await sleep(POLL_INTERVAL, signal)
  }

  if (!landed) {
    if (signal?.aborted) return CANCELLED
    return cdp.closed
      ? {
          ok: false,
          code: "closed",
          reason: "The sign-in window was closed before the site let the editor in.",
        }
      : {
          ok: false,
          code: "timed-out",
          reason: "The sign-in did not finish in time. Opening it again will pick up where it left off.",
        }
  }

  /*
   * Let the landing settle before reading cookies.
   *
   * The window can arrive on the target origin a moment before the identity
   * provider's last redirect has set its session cookie, and a read that
   * lands in that gap comes back empty — which would be reported as a failed
   * sign-in immediately after a successful one.
   */
  await sleep(400, signal)
  if (signal?.aborted) return CANCELLED
  const { cookies } = await cdp.send("Network.getCookies", { urls: [target] })
  const header = (cookies ?? []).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")

  if (!header) {
    return {
      ok: false,
      code: "no-session",
      reason:
        "The site let the window in without leaving a session the editor can reuse. A token may " +
        "be the only way in to this one.",
    }
  }

  return { ok: true, code: "landed", cookie: header }
}

/**
 * Drop one origin's cookies from the remembered profile.
 *
 * Best-effort on purpose, and the caller must not wait on it to decide whether
 * the forget succeeded: the credential this editor holds is the thing being
 * forgotten, and that is a file write that cannot fail halfway. This is the
 * second half — the session sitting in the browser profile — and it matters
 * because without it "Forget" is a promise the next sign-in immediately breaks.
 * Somebody who signed in as the wrong account, or who is handing the laptop
 * over, presses Forget and then watches the very next press walk straight back
 * in with no prompt. That is the bug this closes.
 *
 * Only this origin's cookies go. The identity provider's own session is shared
 * with every other site behind the same SSO, and signing a designer out of
 * their company because they forgot one Storybook would be its own bug.
 *
 * No profile, no launch: a credential that was pasted rather than captured
 * left nothing in a browser to clear, and launching one anyway would create a
 * profile as a side effect of forgetting.
 */
async function clearOriginCookies({ browserPath, profileDir, origin, commandTimeout }) {
  if (!browserPath || !origin) return { cleared: false }
  try {
    await fs.access(profileDir)
  } catch {
    return { cleared: false }
  }
  try {
    const outcome = await withBrowser(
      { browserPath, profileDir, url: "about:blank", headless: true, commandTimeout },
      async ({ cdp }) => {
        await cdp.send("Network.enable")
        const { cookies } = await cdp.send("Network.getCookies", { urls: [origin] })
        for (const cookie of cookies ?? []) {
          // Name plus domain plus path, because a cookie is identified by all three
          // and deleting by name alone leaves the host-only twin behind.
          await cdp.send("Network.deleteCookies", {
            name: cookie.name,
            domain: cookie.domain,
            path: cookie.path,
          })
        }
        return { cleared: true, count: (cookies ?? []).length }
      }
    )
    return outcome.cleared ? outcome : { cleared: false }
  } catch {
    return { cleared: false }
  }
}

/*
 * The session of every profile in this process, keyed by profile directory, so
 * two `createBrowserSignIn` over one state directory still share one owner.
 * The machine itself is in this module's header.
 */
const sessions = new Map()

/** Which phase may follow which; anything else is a stale or illegal move. */
const MOVES = {
  idle: ["silent", "forgetting"],
  silent: ["waitingForPerson", "verifying", "done", "failed", "cancelled"],
  waitingForPerson: ["verifying", "done", "failed", "cancelled"],
  verifying: ["done", "failed", "cancelled"],
  forgetting: ["idle"],
  done: ["idle"],
  failed: ["idle"],
  cancelled: ["idle"],
}
/** The phases in which a run holds the session and a caller can still join it. */
const LIVE = new Set(["silent", "waitingForPerson", "verifying"])

function sessionFor(profileDir) {
  let session = sessions.get(profileDir)
  if (!session) {
    session = createSession()
    sessions.set(profileDir, session)
  }
  return session
}

function createSession() {
  /** `{ phase: "idle" }`, or `{ phase, owner }` where `owner` is the run or forget holding it. */
  let state = { phase: "idle" }
  let idleWaiters = []

  return {
    /** The one reader. */
    get state() {
      return state
    },

    /**
     * The one writer. `owner` is whoever is making the move: from `idle` any
     * new owner may take the session; after that only the owner holding it can
     * move it, and only along `MOVES`. Answers whether the move happened, so a
     * run whose result arrives after it was cancelled learns that it no longer
     * speaks for anybody.
     */
    transition(owner, next) {
      if (state.phase !== "idle" && state.owner !== owner) return false
      if (!MOVES[state.phase].includes(next)) return false
      if (next !== "idle") {
        state = { phase: next, owner }
        return true
      }
      state = { phase: "idle" }
      const waiting = idleWaiters
      idleWaiters = []
      for (const resolve of waiting) resolve()
      return true
    },

    /** Resolves at the next `idle`, or when `signal` aborts, whichever is first. */
    idle(signal) {
      if (state.phase === "idle" || signal?.aborted) return Promise.resolve()
      return new Promise((resolve) => {
        const done = () => {
          signal?.removeEventListener("abort", done)
          resolve()
        }
        idleWaiters.push(done)
        signal?.addEventListener("abort", done, { once: true })
      })
    },
  }
}

export function createBrowserSignIn(config = {}) {
  const profileDir = path.join(path.resolve(config.stateDir ?? "."), "signin-browser")
  /*
   * `undefined` means "go and look"; an empty string means "there is none".
   *
   * Truthiness cannot tell those apart, and getting it wrong is not a small
   * bug: a caller that said "no browser" and got a search would have a real
   * Chrome window open on somebody's screen, which is the one thing a headless
   * caller — a test, a CI run — must never cause.
   */
  const browserPathPromise =
    config.browserPath === undefined ? findBrowser() : Promise.resolve(config.browserPath)

  /*
   * How long one DevTools command may take, overridable for tests.
   *
   * The default is the only value that ships. It is a parameter because the
   * case worth testing here is a browser that answers nothing, and a suite that
   * had to sit through the real fifteen seconds per command to prove the flow
   * still terminates would be a suite somebody deletes.
   */
  const commandTimeout = config.commandTimeout ?? COMMAND_TIMEOUT

  /*
   * How the visible window is brought to the front, as a command line.
   *
   * Empty away from macOS, which is the only platform with a mechanism here and
   * the only one where the window comes up behind everything else in the first
   * place. Overridable for the same reason `commandTimeout` is: this runs only
   * on the visible pass, so a suite that cannot substitute its own helper
   * cannot prove that a helper which never exits is killed rather than waited
   * for — and that hang is the first thing a person meets on a machine where
   * the raise needs a permission they have not granted yet.
   */
  const raiseCommand = config.raiseCommand ?? (process.platform === "darwin" ? ["osascript"] : [])

  const session = sessionFor(profileDir)

  /**
   * Add a caller to a run. Resolves with the run's answer, or with `CANCELLED`
   * the moment this caller's `signal` aborts — and when that leaves the run
   * with nobody waiting, the run is cancelled: its window closes, its browser
   * stops, and the profile is let go of.
   */
  function join(run, signal) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, cleanup: () => {} }
      run.waiters.add(waiter)
      if (!signal) return
      const leave = () => {
        if (!run.waiters.delete(waiter)) return
        resolve(CANCELLED)
        if (run.waiters.size === 0 && session.transition(run, "cancelled")) run.abort.abort()
      }
      if (signal.aborted) return leave()
      signal.addEventListener("abort", leave, { once: true })
      waiter.cleanup = () => signal.removeEventListener("abort", leave)
    })
  }

  /** Hand every caller still waiting on `run` the same answer, or the same error. */
  function settle(run, answer, error) {
    for (const waiter of run.waiters) {
      waiter.cleanup()
      if (error) waiter.reject(error)
      else waiter.resolve(answer)
    }
    run.waiters.clear()
  }

  /** End the run as `phase` and tell its callers, unless it was cancelled first. */
  function finish(run, phase, answer, error) {
    if (session.transition(run, phase)) settle(run, answer, error)
  }

  /*
   * The two passes, as transitions. Escalation reads the silent pass's code:
   * only a pass that found a person is needed, or ran out of time before it
   * could tell, opens a window. A browser that would not launch, a landing that
   * left no session, a fault — none of those is helped by a second browser,
   * and opening one is the window that appears and vanishes the header warns
   * about.
   */
  async function drive(run, { browserPath, visibleMs }) {
    const pass = {
      browserPath,
      profileDir,
      target: run.target,
      origin: run.origin,
      deadline: run.deadline,
      commandTimeout,
      signal: run.abort.signal,
    }
    try {
      let outcome = await runWindow({
        ...pass,
        headless: true,
        /*
         * Never more than half of the whole budget, however generous the
         * ceiling is. The silent pass exists to save the person a window, not
         * to spend the time they would have used in one — and on a total the
         * caller has deliberately shortened, a fixed 45-second ceiling would
         * eat the visible pass entirely and the window would never open.
         */
        timeoutMs: Math.min(SILENT_CEILING, Math.floor(run.budget / 2)),
      })

      const escalate = outcome.code === "needs-human" || outcome.code === "timed-out"
      /*
       * A window with no time left in which to sign in is worse than no window:
       * it opens, steals focus, and is killed from under the person mid-type.
       * Report what the silent pass found instead.
       */
      if (!outcome.ok && escalate && timeLeft(run.deadline) > 0) {
        if (!session.transition(run, "waitingForPerson")) return
        outcome = await runWindow({ ...pass, headless: false, timeoutMs: visibleMs, raiseCommand })
      }

      if (!outcome.ok) return finish(run, "failed", { ok: false, code: outcome.code, reason: outcome.reason })
      if (!run.confirm) return finish(run, "done", { ok: true, cookie: outcome.cookie })

      if (!session.transition(run, "verifying")) return
      const confirmed = await run.confirm(outcome.cookie, { signal: run.abort.signal })
      finish(run, confirmed?.ok ? "done" : "failed", confirmed)
    } catch (error) {
      // Only `confirm` can throw — `runWindow` turns every browser failure into
      // an outcome — and its throw is the caller's to see, as it was before the
      // verification moved in here.
      finish(run, "failed", null, error)
    } finally {
      // Every path above ends the run; this is the backstop that keeps a path
      // added later from leaving the profile owned by a run that has stopped.
      if (LIVE.has(session.state.phase) && session.state.owner === run) {
        finish(run, "failed", { ok: false, code: "fault", reason: "The sign-in stopped unexpectedly" })
      }
      session.transition(run, "idle")
    }
  }

  return {
    profileDir,

    /** Whether this machine has a browser we can drive. */
    async available() {
      return Boolean(await browserPathPromise)
    },

    /**
     * What `GET /libraries/auth/signin` can report: whether a browser exists,
     * how long a sign-in answer can take (`budgetMs`, so a client derives its
     * deadline rather than keeping a copy), and the session's phase, with the
     * origin a live run is for.
     */
    async status() {
      const { phase, owner } = session.state
      return {
        available: Boolean(await browserPathPromise),
        budgetMs: answerBudget(),
        phase,
        ...(LIVE.has(phase) ? { origin: owner.origin } : {}),
      }
    },

    /**
     * Forgets one origin's session inside that profile, so the next sign-in
     * actually asks. Best-effort: see `clearOriginCookies`. Waits for the
     * profile to be free, so it never launches into a sign-in's browser.
     */
    async forgetOrigin(origin) {
      const browserPath = await browserPathPromise
      const wanted = String(origin ?? "")
      if (!browserPath || !wanted) return { cleared: false }
      const forget = { origin: wanted }
      while (session.state.phase !== "idle") await session.idle()
      session.transition(forget, "forgetting")
      try {
        return await clearOriginCookies({ browserPath, profileDir, origin: wanted, commandTimeout })
      } catch {
        return { cleared: false }
      } finally {
        session.transition(forget, "idle")
      }
    },

    /**
     * Sign in to the origin behind `url`, showing a window only if one is
     * needed.
     *
     * TWO PASSES, and the first is the reason this is worth writing. The
     * profile remembers the identity provider's own session, so the second
     * library behind the same SSO — and every library after a restart, until
     * the provider expires it — needs no interaction at all. A silent pass
     * catches exactly those cases: it opens the same profile with no window,
     * follows the redirects, and if the site lets it through, the designer
     * never sees anything. Only a pass that ends up sitting on a login page
     * opens a real window and asks for a human.
     *
     * Doing it the other way round — always show the window, close it when it
     * turns out to be unnecessary — is the same mechanism and a much worse
     * experience: a window that appears and vanishes reads as a glitch, and it
     * steals focus from whatever the designer was doing to do it.
     *
     * ## ONE DEADLINE FOR THE WHOLE CALL, and why there has to be one
     *
     * Two passes, each with a ceiling, is not a budget. Every phase inside a
     * pass used to be bounded on its own and counted against nothing, so the
     * real worst case was the SUM of a dozen independent bounds — two launches,
     * two attaches, a window raise that retried three times, a handful of
     * commands, a cookie read, two teardowns, plus the two poll loops — which
     * added up to roughly fifteen minutes against an advertised four. Nothing
     * upstream rescues that, either: Node stops applying its request timeout
     * once the request body has arrived, so a wedged run holds the socket, the
     * panel and the person for as long as it likes.
     *
     * So the deadline is computed HERE, once, as an absolute timestamp, and
     * threaded into both passes. Every phase inside `runWindow` clamps to it
     * rather than to a share of it, which keeps a slow-but-legitimate launch
     * from stealing the cookie read's budget while still making the total
     * inescapable. The call can overrun it by at most whatever single bounded
     * operation was in flight when it passed — one command and one teardown, a
     * shade under twenty seconds — and not by a second more.
     *
     * The arithmetic is deliberately the sum of the parts the caller can see:
     * the silent pass's ceiling, the window's own ceiling (the four minutes a
     * person is given, or whatever the caller asked for instead), and one
     * allowance for everything that is not waiting for a person. A caller that
     * wants a different total says so with `totalTimeoutMs`.
     *
     * ## Options
     *
     * `signal` cancels: see the header. `confirm(cookie, { signal })` runs in
     * the `verifying` phase and its answer becomes the answer; without it the
     * captured cookie is the answer and verifying is the caller's job (see
     * `completeSignIn`, which is what the route should use). `timeoutMs` and
     * `totalTimeoutMs` are above. Every answer carries `budgetMs`.
     */
    async signIn(url, options = {}) {
      const { signal } = options
      const budgetMs = answerBudget(options)
      const answer = (outcome) => ({ ...outcome, budgetMs })

      const target = String(url ?? "")
      let parsed = null
      try {
        parsed = new URL(target)
      } catch {
        /* refused below */
      }
      // Only a web page: `file:` and `chrome:` URLs parse, have the origin
      // "null", and would open in a visible window that can never land.
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        return answer({ ok: false, code: "bad-url", reason: "That is not a URL the editor can open" })
      }
      const origin = parsed.origin

      const browserPath = await browserPathPromise
      if (!browserPath) {
        return answer({
          ok: false,
          code: "no-browser",
          reason:
            "No Chrome-compatible browser was found on this machine, so the editor cannot open " +
            "the site's sign-in for you.",
        })
      }

      for (;;) {
        if (signal?.aborted) return answer(CANCELLED)
        const { phase, owner } = session.state
        if (phase === "idle") break
        if (LIVE.has(phase)) {
          if (owner.origin === origin) return answer(await join(owner, signal))
          return answer({
            ok: false,
            code: "busy",
            reason:
              `A sign-in to ${owner.origin} is already open. Finish it in that window, or close ` +
              "the window, then try again.",
          })
        }
        // A forget, or a cancelled run still letting go of the profile.
        await session.idle(signal)
      }

      const budget = runBudget(options)
      const run = {
        target,
        origin,
        budget,
        deadline: Date.now() + budget,
        confirm: typeof options.confirm === "function" ? options.confirm : null,
        abort: new AbortController(),
        waiters: new Set(),
      }
      session.transition(run, "silent")
      const answered = join(run, signal)
      void drive(run, { browserPath, visibleMs: options.timeoutMs ?? SIGN_IN_TIMEOUT })
      return answer(await answered)
    },
  }
}

/**
 * The route's half of a window sign-in: run it, verify the captured session
 * against the live URL, and store it only if the wall actually opened.
 *
 * VERIFIED BEFORE IT IS STORED, for the reason `library-auth.mjs` gives: a
 * stored credential has been seen to work, however it was obtained. And NOT
 * STORED AFTER A CANCEL: the check runs inside the session's `verifying` phase
 * with the run's own signal, so a person who pressed Cancel while the probe
 * was in flight is not signed in behind their back.
 *
 * `probe` is `fetchLibraryUrl` and `save` is the auth store's `saveCredential`;
 * passed in so this module imports neither the network reader nor the store,
 * and so the suite drives the real decisions instead of a copy of them.
 */
export function completeSignIn({ signin, probe, save }, url, { signal } = {}) {
  const target = String(url ?? "")
  return signin.signIn(target, {
    signal,
    confirm: async (cookie, { signal: run }) => {
      const credential = { scheme: "cookie", value: cookie }
      const result = await probe(target, { credential, signal: run })
      if (run?.aborted) return CANCELLED
      if (result.sso || !result.ok) {
        return {
          ok: false,
          code: "refused",
          reason: result.sso
            ? "The sign-in worked in the window, but the site still refuses the editor. This one " +
              "may need a token."
            : `The site answered HTTP ${result.status} after signing in`,
        }
      }
      return { ok: true, ...(await save({ url: target, ...credential })) }
    },
  })
}
