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
 * ## What is deliberately not here
 *
 * No token minting, no OAuth client id of our own, no refresh logic. When the
 * session expires the site says so, the wall comes back, and the same window
 * opens again — usually landing straight through, because the browser profile
 * still holds the identity provider's own session. The provider decides how
 * long a session lasts, which is the correct place for that decision to live.
 */

import { spawn } from "node:child_process"
import { readdirSync } from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"

import { classifyWall } from "./library-auth.mjs"

/**
 * Where a Chromium-family browser lives, per platform, best first.
 *
 * Found by name in the folders each platform installs browsers into, rather
 * than as a list of exact paths, so a copy in ~/Applications or a second
 * Program Files is found too. Chrome before Chromium before Edge: all three
 * speak the same protocol, and the point is to find a browser the person
 * already trusts rather than to have an opinion about which one.
 */
const BROWSER_NAMES = {
  // App bundle names; the binary inside is named like the bundle.
  darwin: [/ Chrome\.app$/, / Chrome .+\.app$/, /^Chromium\.app$/, /^Microsoft Edge\.app$/],
  linux: [/-chrome$/, /-chrome-stable$/, /^chromium$/, /^chromium-browser$/, /^microsoft-edge$/],
}

const listDir = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function browserCandidates({ platform = process.platform, env = process.env, roots } = {}) {
  if (platform === "win32") {
    const bases = roots ?? [env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"]
    const chrome = bases.flatMap((base) =>
      listDir(base)
        .filter((vendor) => listDir(path.join(base, vendor)).includes("Chrome"))
        .map((vendor) => path.join(base, vendor, "Chrome", "Application", "chrome.exe"))
    )
    return [...chrome, ...bases.map((base) => path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"))]
  }
  const patterns = BROWSER_NAMES[platform]
  if (!patterns) return []
  const dirs = roots ?? (platform === "darwin" ? ["/Applications", path.join(os.homedir(), "Applications")] : ["/usr/bin"])
  const found = []
  dirs.forEach((dir, order) => {
    for (const name of listDir(dir)) {
      const rank = patterns.findIndex((pattern) => pattern.test(name))
      if (rank === -1) continue
      const file = platform === "darwin" ? path.join(dir, name, "Contents", "MacOS", name.slice(0, -".app".length)) : path.join(dir, name)
      found.push({ rank, order, file })
    }
  })
  return found.sort((a, b) => a.rank - b.rank || a.order - b.order).map((entry) => entry.file)
}

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
/** How long to wait for the browser to open its debugging port. */
const LAUNCH_TIMEOUT = 20 * 1000
/*
 * How long ONE HTTP probe of the debugging endpoint may take.
 *
 * Separate from `LAUNCH_TIMEOUT`, and the distinction is the whole point: the
 * launch budget is only consulted BETWEEN probes, so a single `fetch` that
 * never settles defeats it entirely. `fetch` does not fail fast on a port that
 * accepts a connection and then says nothing — the eventual bound is undici's
 * own header timeout, five minutes, fifteen times the launch budget this code
 * believes it has, and it is paid on both passes.
 *
 * That is not a hypothetical port either. `freePort` binds port zero, reads the
 * number and closes the listener before the browser is asked to take it, and
 * anything on the machine can win that gap: an ssh tunnel, an agent socket, a
 * second editor mid-launch. A squatter that accepts and does not speak HTTP is
 * indistinguishable from a browser that is still starting, until the probe is
 * bounded — after which it is simply one lost second out of twenty.
 */
const PROBE_TIMEOUT = 1000
/*
 * Probes do not reuse their connection, and the request header is the only
 * place to say so.
 *
 * `fetch` keeps a pooled socket open after the answer, which is the right
 * default for a host being talked to repeatedly and the wrong one for a browser
 * this process is about to kill: the pool holds a connection to a peer that no
 * longer exists, and the editor's event loop holds the pool, once per sign-in,
 * for as long as the pool feels like it. These are two one-shot requests to a
 * throwaway local server — there is nothing to reuse and nothing to lose.
 */
const PROBE_HEADERS = { connection: "close" }
/** How often to look at where the window has got to. */
const POLL_INTERVAL = 600
/** How long a browser gets to exit on its own before it is killed outright. */
const EXIT_GRACE = 2500
/*
 * How many times to try raising the sign-in window, and how long to leave
 * between tries.
 *
 * A window that is still being created cannot be activated, and this runs in
 * exactly that gap — the browser has answered on its debugging port but macOS
 * may not have finished registering the process. Three tries over about a
 * second covers the cold case without delaying the warm one, which succeeds on
 * the first.
 */
const RAISE_ATTEMPTS = 3
const RAISE_RETRY = 400
/*
 * How long one raise attempt may take, and how long all of them together may.
 *
 * Raising the window is best-effort and ALWAYS optional — the sign-in still
 * works in a window nobody raised, just badly — so it may never be the reason
 * the flow stops. It was, though: the helper resolved only when the child
 * process exited, and the child is an Apple event to another application, which
 * on a machine that has not granted this one automation rights blocks on a
 * consent prompt. That prompt opens BEHIND other windows, which is the very
 * failure being fixed here, so nobody sees it to answer it; the best case is
 * AppleScript's own two-minute event timeout paid three times over, and the
 * worst case — the prompt suppressed by device policy, the target application
 * wedged — is forever, with the sign-in loop not yet started and the panel
 * still saying "waiting".
 *
 * A second and a half is longer than a raise that is going to work ever takes,
 * and the whole-budget cap means three retries cannot multiply into a stall.
 * Anything slower than this is a permission dialog or a hung process, and in
 * both cases the right answer is to give up on the raise and get on with the
 * sign-in.
 */
const RAISE_ATTEMPT_TIMEOUT = 1500
const RAISE_BUDGET = 3000
/*
 * How long any single DevTools command may take before it is treated as a
 * browser that has stopped answering.
 *
 * Far longer than anything here legitimately needs — the slowest is a
 * navigation commit — so a timeout is always a fault and never a slow machine.
 * See `connect().send`, which explains what happened without one.
 */
const COMMAND_TIMEOUT = 15 * 1000
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** What is left of an absolute deadline, never negative. */
const timeLeft = (deadline) => Math.max(0, deadline - Date.now())

/** The first browser on this platform that actually exists. */
export async function findBrowser(candidates = browserCandidates()) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      /* try the next one */
    }
  }
  return ""
}

/**
 * Who is asking for the sign-in, said as a person would name them.
 *
 * `classifyWall` refuses to look at hostnames, and it is right to: guessing a
 * vendor from a URL would make it wrong for every stack it had not been taught.
 * Naming the provider HERE is a different job with a different failure mode. It
 * decides one thing — the words on a button — and being wrong costs a generic
 * label rather than a broken flow, which is why the fallback is the host itself
 * and never a guess.
 *
 * Kept to identity providers whose sign-in a designer would recognise by name.
 */
const PROVIDERS = [
  { host: "login.microsoftonline.com", label: "Microsoft" },
  { host: "okta.com", label: "Okta" },
  { host: "onelogin.com", label: "OneLogin" },
  { host: "auth0.com", label: "Auth0" },
  { host: "github.com", label: "GitHub" },
  { host: "gitlab.com", label: "GitLab" },
]

/**
 * The identity provider a wall hands off to, from the redirect it answered
 * with. Empty when the redirect named nobody we can put on a button.
 */
export function providerLabel(location = "") {
  let host = ""
  try {
    host = new URL(String(location)).hostname.toLowerCase()
  } catch {
    return ""
  }
  const match = PROVIDERS.find((entry) => host === entry.host || host.endsWith(`.${entry.host}`))
  return match ? match.label : ""
}

/** A free port for the debugging connection, so two editors never collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * One DevTools connection, as promises.
 *
 * Small on purpose: this needs four commands and none of the surface a browser
 * automation library exists to provide.
 */
function connect(url, commandTimeout = COMMAND_TIMEOUT) {
  /*
   * THE HANDSHAKE IS BOUNDED TOO, and this is the same defect as the unbounded
   * `send` below, one layer earlier: in the one call that has to succeed before
   * `send` exists at all.
   *
   * `ws` arms no handshake timer unless it is given one — `handshakeTimeout` is
   * undefined by default and the request timeout is only set when it is
   * present — so a socket that completes its TCP connection and never finishes
   * the upgrade emits neither `open` nor `error`, forever. The promise below
   * settles on exactly those two events, so it settled on neither, and the
   * `await` for it is not inside any poll loop: no deadline was ever consulted
   * and the browser that was spawned one line earlier was never stopped.
   *
   * Reachable from more than a broken browser. A port stolen between
   * `freePort` closing its probe listener and Chrome binding it (see
   * `PROBE_TIMEOUT`) can leave a service on the other end that accepts the
   * connection and says nothing, and a browser suspended mid-launch — a sleeping
   * laptop, a debugger, a security agent scanning the binary — looks identical.
   *
   * Belt and braces on purpose: `handshakeTimeout` is the library's own bound,
   * and the timer below is ours, so a failure mode inside `ws` that skips the
   * handshake path cannot quietly reintroduce an await with no end.
   */
  const socket = new WebSocket(url, { handshakeTimeout: commandTimeout })
  const pending = new Map()
  let nextId = 0
  let closed = false

  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  /*
   * Two rejections that must not become crashes.
   *
   * `opened` is raced by `ready` below, so when the timer wins first the
   * original rejection arrives at a promise nobody is waiting on any more —
   * which Node reports as an unhandled rejection and, under the default policy,
   * exits the process for. Marking it handled here costs nothing: `ready` has
   * already taken the answer it needs.
   *
   * The permanent socket listener is the same argument in the emitter's terms.
   * `once("error")` above unsubscribes as it fires, and an `EventEmitter` with
   * no `error` listener THROWS when the next one arrives — so a socket that
   * failed and then failed again (a reset after a refused upgrade is the
   * ordinary way to get two) would take the whole editor down over a sign-in.
   */
  opened.catch(() => {})
  socket.on("error", () => {})

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("The sign-in window never finished connecting"))
    }, commandTimeout)
    const settle = (fn) => (value) => {
      clearTimeout(timer)
      fn(value)
    }
    opened.then(settle(resolve), settle(reject))
  })
  ready.catch(() => {})

  const listeners = new Map()

  socket.on("message", (raw) => {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (message.method) {
      listeners.get(message.method)?.(message.params ?? {})
      return
    }
    const waiting = message.id && pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    if (message.error) waiting.reject(new Error(message.error.message))
    else waiting.resolve(message.result)
  })

  socket.on("close", () => {
    closed = true
    for (const waiting of pending.values()) waiting.reject(new Error("The browser window closed"))
    pending.clear()
  })

  return {
    ready,
    get closed() {
      return closed
    },
    /** One handler per event, which is all this needs. */
    on(method, handler) {
      listeners.set(method, handler)
    },
    /**
     * EVERY COMMAND IS BOUNDED, and the absence of this is what made the flow
     * hang forever rather than fail.
     *
     * A pending entry used to settle on exactly two events: an answer, or the
     * socket closing. A browser that is alive and simply not answering matches
     * neither, so the promise stayed unresolved, the poll loop never reached
     * its next deadline check, the four-minute ceiling was never consulted, and
     * `stop()` — which lives in the `finally` below it — never ran.
     *
     * That is not a hypothetical. The report behind this fix was "it just shows
     * me Wait, nothing pops up", and the machine still had the evidence on it:
     * a sign-in browser launched at 12:58 and still running six hours later,
     * parked on the provider's page, long after a ceiling that should have
     * killed it at 13:02. The `await` it was sitting in had no way to end.
     *
     * A timeout turns that into an ordinary rejection, which the caller already
     * handles: the poll loop breaks, the run reports that it never landed, and
     * the browser is stopped. Fifteen seconds is far longer than any command
     * here legitimately takes — the slowest is a navigation commit — so a
     * timeout is always a fault rather than a slow machine.
     */
    send(method, params = {}) {
      if (closed) return Promise.reject(new Error("The browser window closed"))
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`The browser stopped answering (${method})`))
        }, commandTimeout)
        const settle = (fn) => (value) => {
          clearTimeout(timer)
          fn(value)
        }
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    /**
     * TERMINATE rather than close, because the other end is being killed in the
     * same breath.
     *
     * A polite `close()` sends a close frame and then waits for the peer's
     * answer before dropping the socket — and every caller here closes the
     * connection immediately before stopping the browser, so that answer is
     * never coming and `ws` sits out its own thirty-second close timeout
     * waiting for it. There is nothing to be polite about: the run is over, the
     * browser is being killed, and the only thing a graceful close can still do
     * is keep a dead socket in the editor's event loop.
     */
    close() {
      try {
        socket.terminate()
      } catch {
        /* already gone */
      }
    },
  }
}

/**
 * The debugging endpoint, once the browser has one.
 *
 * EVERY PROBE IS ABORTABLE, and without that the deadline this takes is
 * decorative: it is read between attempts, so one `fetch` that never settles
 * skips it entirely and the loop simply never comes back round. See
 * `PROBE_TIMEOUT` for what is on the other end of such a socket and how it gets
 * there.
 *
 * The last probe is clamped to what is left of the deadline as well as to
 * `PROBE_TIMEOUT`, so the function cannot return late by up to a second on top
 * of a budget the caller is already sharing with everything after it.
 */
async function waitForDevTools(port, deadline, failed = () => null) {
  while (Date.now() < deadline) {
    // The launch itself died — no port is ever going to open, so stop waiting.
    if (failed()) return null
    const budget = Math.min(PROBE_TIMEOUT, timeLeft(deadline))
    if (!budget) break
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(budget),
        headers: PROBE_HEADERS,
      })
      if (res.ok) return await res.json()
    } catch {
      /* not up yet, or not answering — either way, try again or run out */
    }
    await sleep(Math.min(200, timeLeft(deadline)))
  }
  return null
}

/**
 * The page target to drive — the tab the browser opened with.
 *
 * NOTHING HERE MAY THROW, which it comfortably did: `res.json()` rejects on a
 * body that is not JSON and `targets.find` is a `TypeError` when the body is a
 * JSON object rather than an array, and both are ordinary answers from a port
 * that a non-browser has taken (see `PROBE_TIMEOUT`) or from a browser that
 * died between answering `/json/version` and this call. A throw from here
 * escaped the whole run and reached the panel as a 500 where the contract
 * promises a sentence — and, worse, escaped before anything had been written to
 * stop the browser, leaving a Chrome holding the profile's singleton lock so
 * that every LATER sign-in failed too, with a message naming neither the cause
 * nor the cure. `null` is already the "no page to drive" answer the caller
 * handles; every failure in here is that answer.
 *
 * The tab is chosen by URL rather than by position where there is a choice. A
 * browser that opens a second page of its own — a restore prompt, an extension,
 * a profile welcome — would otherwise hand back whichever target sorted first,
 * and the run would then navigate, poll and raise a tab the person is not
 * looking at.
 */
async function firstPage(port, deadline, target = "") {
  const budget = Math.min(PROBE_TIMEOUT, timeLeft(deadline))
  if (!budget) return null
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(budget),
      headers: PROBE_HEADERS,
    })
    const targets = await res.json()
    if (!Array.isArray(targets)) return null
    const pages = targets.filter((entry) => entry?.type === "page" && entry?.webSocketDebuggerUrl)
    return pages.find((entry) => String(entry.url ?? "") === target) ?? pages[0] ?? null
  } catch {
    return null
  }
}

/**
 * Sign-in against one origin, in a window the person can see.
 *
 * Resolves with `{ ok: true, cookie }` when the window came back to the target
 * origin carrying cookies, and with `{ ok: false, reason }` for every way that
 * can fail to happen. It never throws for an ordinary outcome — a person
 * closing the window is a normal thing to do, not an exception.
 *
 * `onProgress` is called with the current URL as the window moves, so a caller
 * can show where the sign-in has got to rather than a spinner with no news.
 */
/**
 * PUT THE SIGN-IN WINDOW IN FRONT OF THE PERSON, which is the whole feature.
 *
 * A window nobody can see is the same as no window. The panel says "waiting for
 * the sign-in", the designer looks at an unchanged screen, and after a while
 * they conclude the button is broken — which is exactly the report that sent
 * this rewrite: *"when I click Sign in with Okta, it just shows me Wait,
 * nothing pops up."*
 *
 * ## What was measured
 *
 * The window was there the whole time. Asked over the DevTools protocol, the
 * stranded instance answered:
 *
 *   bounds {left: 22, top: 30, width: 520, height: 720}, windowState "normal"
 *   document.visibilityState "visible", document.hidden false
 *   document.hasFocus() FALSE
 *
 * On screen, correct size, correct URL, painting — and behind everything else
 * the person had open.
 *
 * ## Why the old call could not have worked
 *
 * It ran `open -a` on the browser app. That activates an
 * APPLICATION, identified by its bundle — and the designer is already running
 * that same bundle with their own profile. macOS has no idea the caller meant
 * the second instance, so it brings the person's ordinary browser window
 * forward and leaves the sign-in window exactly where it was. On the machines
 * where this feature matters most, that is every time: nobody who needs to sign
 * in to a private Storybook has no browser open.
 *
 * ## What works
 *
 * Activate the PROCESS, by its pid. `System Events` addresses a running process
 * by `unix id`, which is the one handle that distinguishes our Chrome from
 * theirs — verified against the stranded window above, which went to
 * `hasFocus() === true` on the first try.
 *
 * `Page.bringToFront` stays and runs first: it raises the right TAB inside the
 * process, and the activation then raises the process. Neither does the other's
 * job.
 *
 * Retried a few times because a window that is still being created cannot be
 * raised, and the launch-to-paint gap is exactly where this is called.
 *
 * ## Why every attempt is on a stopwatch
 *
 * An earlier version of this comment claimed the activation "needs no
 * Automation permission for a process the same user launched". That is true of
 * the Accessibility API and false of Apple events, which is what this is:
 * addressing another application from an unbundled `node` crosses a privacy
 * boundary and the operating system asks the person's permission first,
 * attributing the request to whichever terminal or launcher owns this process.
 * Until that question is answered the helper simply does not exit — and the
 * question is asked in a dialog that opens behind other windows, which is the
 * exact failure this function exists to correct, so it is never answered.
 *
 * Hence `RAISE_ATTEMPT_TIMEOUT` and a SIGKILL rather than a wait: a child that
 * has not finished raising a window in a second and a half is not raising one,
 * it is holding a question open, and leaving it alive leaks a process per
 * attempt on top of stalling the sign-in that has not started yet. Every step
 * here is best-effort — a failure costs a raised window, never a sign-in — and
 * bounding it is what makes that sentence true rather than aspirational.
 *
 * `command` is the raise helper as a command line, empty on platforms with no
 * such mechanism. A parameter rather than a hardcoded `osascript` because this
 * is the one branch a test cannot otherwise reach: it runs only on the visible
 * pass, and a suite that shipped its own hanging stand-in is the only way to
 * prove the stopwatch above works.
 */
async function raiseWindow(cdp, pid, command, until) {
  try {
    await cdp.send("Page.bringToFront")
  } catch {
    // Not fatal — the window is still open and still usable.
  }
  if (!command.length || !pid) return

  /*
   * THE BUDGET IS ENFORCED HERE, and an unenforced one is the whole bug this
   * guards against.
   *
   * Raising the window sends an Apple event to another application. On a machine
   * that has not granted this process automation rights that opens a consent
   * dialog — and it opens it BEHIND other windows, which is the exact failure
   * the raise exists to cure, so nobody ever sees it to answer it. The helper
   * then never exits, and a promise that settles only on `exit` or `error`
   * never settles at all: no sign-in window the person can use, no ceiling, no
   * end. It is the same shape as the DevTools hang, one process further out.
   *
   * So the timer is the answer and the kill is the other half of it. Resolving
   * on the timeout alone would leave the consent dialog and its process behind
   * on every attempt, three per sign-in, accumulating for the session.
   * `SIGKILL` because a helper blocked on a modal will not answer a polite
   * signal, and it is holding nothing that needs flushing.
   */
  const activate = (budget) =>
    new Promise((resolve) => {
      const script = `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`
      const child = spawn(command[0], [...command.slice(1), "-e", script], { stdio: "ignore" })
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          /* already gone */
        }
        finish(false)
      }, budget)
      child.on("exit", (code) => finish(code === 0))
      child.on("error", () => finish(false))
    })

  for (let attempt = 0; attempt < RAISE_ATTEMPTS; attempt += 1) {
    const budget = Math.min(RAISE_ATTEMPT_TIMEOUT, timeLeft(until))
    if (!budget) return
    if (await activate(budget)) return
    if (timeLeft(until) <= RAISE_RETRY) return
    await sleep(RAISE_RETRY)
  }
}

/**
 * Stop a browser this module launched AND wait for it to let go of the profile.
 *
 * A kill is not a quit: Chrome takes a moment to flush the profile and drop its
 * singleton lock, and a second run that launches into that window finds the
 * directory still held. It does not fail loudly — it falls back — so the
 * symptom is a silent pass that mysteriously stops working whenever it runs
 * straight after another one, which is precisely the case it exists for (press
 * Sign in, get refused, press it again).
 *
 * SIGKILL after a grace period, because a browser that has not exited by then
 * is not going to, and holding the flow open for it helps nobody.
 *
 * A spawn that never produced a process returns at once. Node emits no `exit`
 * for a launch that failed with ENOENT — there was never anything to exit — so
 * waiting for one meant every "there is no browser at that path" answer sat out
 * the full grace period first, twice per sign-in, for nothing.
 */
function stopBrowser(child) {
  if (!child || child.pid === undefined) return Promise.resolve()
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      // Give the OS a beat to reap it, then carry on regardless.
      setTimeout(resolve, 300)
    }, EXIT_GRACE)
    child.once("exit", done)
    try {
      child.kill()
    } catch {
      done()
    }
  })
}

/**
 * One browser run: open the URL, follow it until it lands on the target origin
 * or gives up, and hand back whatever session it produced.
 *
 * Shared by both passes of `signIn` so that the silent attempt and the visible
 * one cannot drift apart — the only difference between them is `headless` and
 * how long they are willing to wait.
 *
 * `deadline` is an ABSOLUTE timestamp the caller owns, and it outranks
 * `timeoutMs`: the latter is how long this pass would like to wait for a
 * person, the former is when the whole call must be over whatever it is in the
 * middle of. Every phase below clamps to it. See `signIn`, which computes it.
 *
 * ## One owner for the browser, from the first line
 *
 * Everything from `freePort` down is inside a single `try` whose `finally`
 * stops the browser, and that shape is the fix for a defect rather than a
 * tidiness preference. The launch prologue used to sit OUTSIDE any cleanup:
 * five awaits — a port probe, a directory create, the spawn itself, the target
 * list, the attach — each of which can reject, and each of which therefore
 * escaped this function with a Chrome running and nobody holding a reference to
 * it. That is worse than a failed sign-in. The orphan keeps the profile's
 * singleton lock, so the NEXT run's browser relays its command line to the
 * orphan and exits immediately, its debugging port never binds, and the person
 * gets "The browser did not open" from then on — a feature that stays broken
 * until someone finds a stray process in Activity Monitor.
 */
async function runWindow({
  browserPath,
  profileDir,
  target,
  origin,
  headless,
  timeoutMs,
  onProgress,
  commandTimeout,
  raiseCommand = [],
  deadline = Date.now() + timeoutMs + OVERHEAD_ALLOWANCE,
}) {
  /** Both `null` until they exist, so the `finally` can clean up either. */
  let child = null
  let cdp = null
  /*
   * Which sentence an unexpected throw becomes. "The sign-in window stopped
   * responding" is true once there is a window to respond; before that it would
   * name the wrong thing, and a person reading it would go looking for a window
   * that was never opened.
   */
  let attached = false

  try {
    const port = await freePort()
    await fs.mkdir(profileDir, { recursive: true })

    let launchError = null
    child = spawn(
      browserPath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        ...(headless ? ["--headless=new"] : []),
        "--no-first-run",
        "--no-default-browser-check",
        "--no-service-autorun",
        "--disable-background-networking",
        "--window-size=520,720",
        target,
      ],
      { stdio: "ignore" }
    )
    child.on("error", (error) => {
      launchError = error
    })

    const launchBy = Math.min(Date.now() + LAUNCH_TIMEOUT, deadline)
    const version = await waitForDevTools(port, launchBy, () => launchError)
    if (!version) {
      return {
        ok: false,
        reason:
          "The browser did not open. Try signing in to the site in your own browser, then add the " +
          "library again.",
      }
    }

    const page = await firstPage(port, Math.min(Date.now() + LAUNCH_TIMEOUT, deadline), target)
    if (!page?.webSocketDebuggerUrl) {
      return { ok: false, reason: "The browser opened without a page the editor could follow" }
    }

    cdp = connect(page.webSocketDebuggerUrl, commandTimeout)
    try {
      await cdp.ready
    } catch {
      return { ok: false, reason: "The editor could not attach to the sign-in window" }
    }
    attached = true

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
     * precisely the shape of hang the timeout above was written for.
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
    let provider = ""
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
      if (cdp.closed) break
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
      // The address bar is still the best thing to SAY — it is where the person
      // is — even though it is not what decides arrival.
      if (!provider) provider = providerLabel(current)
      onProgress?.({ url: current, provider })

      if (
        servedUrl.startsWith(origin) &&
        servedStatus >= 200 &&
        servedStatus < 300 &&
        current.startsWith(origin)
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
        if (headless) {
          return {
            ok: false,
            needsHuman: true,
            provider,
            reason: "That site needs a person to sign in",
          }
        }
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
        !servedUrl.startsWith(origin) &&
        servedStatus >= 200 &&
        servedStatus < 300 &&
        Date.now() - servedAt > PARKED_MS
      ) {
        return { ok: false, needsHuman: true, provider, reason: "That site needs a person to sign in" }
      }

      await sleep(POLL_INTERVAL)
    }

    if (!landed) {
      const reason = cdp.closed
        ? "The sign-in window was closed before the site let the editor in."
        : "The sign-in did not finish in time. Opening it again will pick up where it left off."
      return { ok: false, reason, provider }
    }

    /*
     * Let the landing settle before reading cookies.
     *
     * The window can arrive on the target origin a moment before the identity
     * provider's last redirect has set its session cookie, and a read that
     * lands in that gap comes back empty — which would be reported as a failed
     * sign-in immediately after a successful one.
     */
    await sleep(400)
    const { cookies } = await cdp.send("Network.getCookies", { urls: [target] })
    const header = (cookies ?? []).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")

    if (!header) {
      return {
        ok: false,
        provider,
        reason:
          "The site let the window in without leaving a session the editor can reuse. A token may " +
          "be the only way in to this one.",
      }
    }

    return { ok: true, cookie: header, origin, provider }
  } catch (error) {
    /*
     * A BROWSER FAULT IS AN OUTCOME, NOT AN EXCEPTION.
     *
     * There was no `catch` here, which was invisible for as long as nothing in
     * the block could reject: the commands either answered or hung forever.
     * Bounding them turned the hang into a rejection, and a rejection thrown
     * out of here escapes `signIn`, escapes the route, and reaches the panel as
     * a 500 — so the fix for the freeze would have replaced it with a red
     * error where the contract promises a sentence.
     *
     * Every other way this function fails already returns `{ ok: false,
     * reason }`, and the caller is written to expect exactly that; see the
     * route, which turns a refusal into a 200 with the reason attached because
     * a person closing a window is an ordinary thing to do.
     *
     * It now covers the launch as well as the window, because the launch had
     * the same hole in a worse place: a profile directory that cannot be
     * created, a browser path that cannot be spawned, a debugging endpoint that
     * answers something other than JSON. See the note on this function about
     * what an escape from there used to leave running.
     */
    const detail = error instanceof Error && error.message ? `: ${error.message}` : ""
    return {
      ok: false,
      reason: attached
        ? `The sign-in window stopped responding${detail}`
        : `The editor could not start the sign-in browser${detail}`,
    }
  } finally {
    cdp?.close()
    await stopBrowser(child)
  }
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
 * their company because they forgot one Storybook would be its own bug; see
 * `forgetSessions` for the whole-profile version.
 */
async function clearOriginCookies({ browserPath, profileDir, origin }) {
  if (!browserPath || !origin) return { cleared: false }
  const port = await freePort()

  let launchError = null
  const child = spawn(
    browserPath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-service-autorun",
      "--disable-background-networking",
      "about:blank",
    ],
    { stdio: "ignore" }
  )
  child.on("error", (error) => {
    launchError = error
  })
  /*
   * The same stop the sign-in run uses, and sharing it is a fix.
   *
   * This one was a plain `child.kill()` that returned immediately, despite
   * every caller writing `await stop()` — awaiting `undefined` — so it did the
   * one thing the shared version exists to prevent: hand back control while
   * Chrome is still flushing the profile and holding its lock, which is how the
   * NEXT sign-in ends up launching into a directory somebody else still owns.
   * It never escalated to SIGKILL either, so a browser that ignored the polite
   * signal simply stayed alive and poisoned the profile for good.
   */
  const stop = () => stopBrowser(child)

  const version = await waitForDevTools(port, Date.now() + LAUNCH_TIMEOUT, () => launchError)
  if (!version) {
    await stop()
    return { cleared: false }
  }
  const page = await firstPage(port, Date.now() + LAUNCH_TIMEOUT)
  if (!page?.webSocketDebuggerUrl) {
    await stop()
    return { cleared: false }
  }
  const cdp = connect(page.webSocketDebuggerUrl)
  try {
    await cdp.ready
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
  } catch {
    return { cleared: false }
  } finally {
    cdp.close()
    await stop()
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

  return {
    profileDir,

    /** Whether this machine has a browser we can drive. */
    async available() {
      return Boolean(await browserPathPromise)
    },

    /** Forgets the remembered sign-in profile, for every origin at once. */
    async forgetSessions() {
      await fs.rm(profileDir, { recursive: true, force: true })
      return { cleared: true }
    },

    /**
     * Forgets one origin's session inside that profile, so the next sign-in
     * actually asks. Best-effort: see `clearOriginCookies`.
     */
    async forgetOrigin(origin) {
      const browserPath = await browserPathPromise
      try {
        return await clearOriginCookies({ browserPath, profileDir, origin: String(origin ?? "") })
      } catch {
        return { cleared: false }
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
     */
    async signIn(url, options = {}) {
      const target = String(url ?? "")
      let origin = ""
      try {
        origin = new URL(target).origin
      } catch {
        return { ok: false, reason: "That is not a URL the editor can open" }
      }

      const browserPath = await browserPathPromise
      if (!browserPath) {
        return {
          ok: false,
          reason:
            "No Chrome-compatible browser was found on this machine, so the editor cannot open " +
            "the site's sign-in for you.",
        }
      }

      const visibleMs = options.timeoutMs ?? SIGN_IN_TIMEOUT
      const budget = options.totalTimeoutMs ?? SILENT_CEILING + visibleMs + OVERHEAD_ALLOWANCE
      const deadline = Date.now() + budget

      const silent = await runWindow({
        browserPath,
        profileDir,
        target,
        origin,
        headless: true,
        /*
         * Never more than half of the whole budget, however generous the
         * ceiling is. The silent pass exists to save the person a window, not
         * to spend the time they would have used in one — and on a total the
         * caller has deliberately shortened, a fixed 45-second ceiling would
         * eat the visible pass entirely and the window would never open.
         */
        timeoutMs: Math.min(SILENT_CEILING, Math.floor(budget / 2)),
        deadline,
        commandTimeout,
      })
      if (silent.ok) return { ...silent, silent: true }

      if (options.interactive === false) {
        return { ok: false, reason: "That site needs a sign-in and this run was not allowed to ask for one" }
      }

      /*
       * A window with no time left in which to sign in is worse than no window:
       * it opens, steals focus, and is killed from under the person mid-type.
       * Report what the silent pass found instead.
       */
      if (timeLeft(deadline) <= 0) {
        return {
          ok: false,
          provider: silent.provider ?? "",
          reason: silent.reason ?? "The sign-in did not finish in time.",
        }
      }

      return runWindow({
        browserPath,
        profileDir,
        target,
        origin,
        headless: false,
        timeoutMs: visibleMs,
        deadline,
        onProgress: options.onProgress,
        commandTimeout,
        raiseCommand,
      })
    }
  }
}
