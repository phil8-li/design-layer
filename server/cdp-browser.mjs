/**
 * A small driver for a Chromium-family browser over the DevTools protocol:
 * find one, launch it on a profile, attach to its page, and stop it again.
 *
 * Split out of `library-signin.mjs`, which keeps the sign-in POLICY (when a
 * run has landed, when a person is needed, one run per profile). This module
 * knows nothing about sign-in: it owns the browser process and the socket, and
 * the one rule it exists to keep is that a browser it launched never outlives
 * its use. `withBrowser` is the only way in, and its `finally` stops the
 * browser on every path; `spawnOwned` registers every child it starts, so the
 * process exit hook can stop what a run in flight still holds.
 *
 * Why the DevTools protocol rather than a browser-automation dependency is
 * explained in `library-signin.mjs`; the short form is that `ws` is already in
 * the tree and the browser the person already trusts is the one driven.
 */

import { spawn } from "node:child_process"
import { readdirSync } from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"

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

/** How long to wait for the browser to open its debugging port. */
export const LAUNCH_TIMEOUT = 20 * 1000
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

/** How long a browser gets to exit on its own before it is killed outright. */
export const EXIT_GRACE = 2500
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
export const RAISE_BUDGET = 3000
/*
 * How long any single DevTools command may take before it is treated as a
 * browser that has stopped answering.
 *
 * Far longer than anything here legitimately needs — the slowest is a
 * navigation commit — so a timeout is always a fault and never a slow machine.
 * See `connect().send`, which explains what happened without one.
 */
export const COMMAND_TIMEOUT = 15 * 1000

/**
 * A pause that ends early when `signal` aborts, so a cancelled run does not sit
 * out the rest of a poll interval before it notices.
 */
export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
  })
/** What is left of an absolute deadline, never negative. */
export const timeLeft = (deadline) => Math.max(0, deadline - Date.now())

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
 *
 * `failed` is asked before every probe, and `withBrowser` makes it true when
 * the child has EXITED, not only when the spawn failed. A browser that starts
 * and exits at once — a second Chrome relaying its command line to one that
 * already holds the profile, a crash, a wrong binary — used to be waited on for
 * the full `LAUNCH_TIMEOUT`: twenty seconds per launch to report a process that
 * was gone in the first ten milliseconds.
 */
async function waitForDevTools(port, deadline, failed = () => false) {
  while (Date.now() < deadline) {
    // The launch died, or the browser already exited, or the run was
    // cancelled: no port is ever going to open, so stop waiting.
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
export async function raiseWindow(cdp, pid, command, until) {
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
      const child = spawnOwned(command[0], [...command.slice(1), "-e", script])
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

/*
 * Every process this module started and has not yet seen exit.
 *
 * A browser child is not detached, but a child process is not killed with its
 * parent either: the editor exiting mid-run (a desk restart, Ctrl+C, an update)
 * used to leave the sign-in Chrome running. A headless one has no window and
 * never exits on its own, and it holds the profile's singleton lock, so every
 * later sign-in relayed to it and failed with "The browser did not open" until
 * somebody found the process in Activity Monitor.
 *
 * One `exit` listener for all of them, registered with the first child. The
 * editor turns SIGINT, SIGTERM and SIGHUP into `process.exit` (see
 * `runtime/launcher.mjs` and the vendor's own shutdown), so `exit` is the one
 * event every way out passes through. `kill()` is synchronous, which is the only
 * kind of work an `exit` listener can do; SIGTERM rather than SIGKILL so Chrome
 * still flushes the profile and drops its lock on the way down.
 */
const owned = new Set()
let exitHookInstalled = false

function stopOwnedOnExit() {
  for (const child of owned) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  owned.clear()
}

/** `spawn`, with the child registered for the exit hook above until it exits. */
export function spawnOwned(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "ignore", ...options })
  if (child.pid === undefined) return child
  owned.add(child)
  child.once("exit", () => owned.delete(child))
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once("exit", stopOwnedOnExit)
  }
  return child
}

/**
 * Launch a browser on `profileDir` pointed at `url`, attach to its page, run
 * `body({ cdp, child })`, and stop the browser — on every path.
 *
 * Resolves with whatever `body` returns, or, when the launch never got as far
 * as a page to drive, with `{ ok: false, code }`:
 *
 *   launch-failed  the browser could not be started, exited, or never opened
 *                  its debugging port in time (`error` set when something threw)
 *   no-page        it opened without a page target to follow
 *   attach-failed  the page would not accept a DevTools connection
 *   cancelled      `signal` aborted before `body` started
 *
 * A throw from `body` propagates, after the browser is stopped.
 *
 * ## One owner for the browser, from the first line
 *
 * Everything from `freePort` down is inside a single `try` whose `finally`
 * stops the browser, and that shape is the fix for a defect rather than a
 * tidiness preference. The launch prologue used to sit OUTSIDE any cleanup:
 * five awaits — a port probe, a directory create, the spawn itself, the target
 * list, the attach — each of which can reject, and each of which therefore
 * escaped with a Chrome running and nobody holding a reference to it. That is
 * worse than a failed sign-in. The orphan keeps the profile's singleton lock,
 * so the NEXT run's browser relays its command line to the orphan and exits
 * immediately, its debugging port never binds, and the person gets "The
 * browser did not open" from then on — a feature that stays broken until
 * someone finds a stray process in Activity Monitor.
 *
 * There used to be two copies of this prologue, one per caller, with two flag
 * lists; the cookie clear's copy called `connect` outside its `try`, so a bad
 * debugger URL leaked exactly that orphan. One prologue means one `finally`.
 *
 * ## Cancelling
 *
 * When `signal` aborts, the DevTools socket is closed at once. Every pending
 * command rejects, a poll loop in `body` sees `cdp.closed`, and the `finally`
 * stops the browser — so a cancelled run lets go of the profile in the time it
 * takes Chrome to quit, not when its own ceiling runs out.
 *
 * `deadline` is an absolute timestamp; the launch and the target list each
 * clamp to it as well as to `LAUNCH_TIMEOUT`. Omitted, each gets the full
 * `LAUNCH_TIMEOUT`.
 */
export async function withBrowser(
  { browserPath, profileDir, url, headless, deadline = Infinity, commandTimeout = COMMAND_TIMEOUT, signal },
  body
) {
  let child = null
  let cdp = null
  const abandon = () => cdp?.close()
  signal?.addEventListener("abort", abandon, { once: true })

  try {
    try {
      const port = await freePort()
      await fs.mkdir(profileDir, { recursive: true })

      let launchError = null
      child = spawnOwned(browserPath, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        ...(headless ? ["--headless=new"] : []),
        "--no-first-run",
        "--no-default-browser-check",
        "--no-service-autorun",
        "--disable-background-networking",
        "--window-size=520,720",
        url,
      ])
      child.on("error", (error) => {
        launchError = error
      })
      const gone = () =>
        Boolean(launchError) || child.exitCode !== null || child.signalCode !== null || Boolean(signal?.aborted)

      const version = await waitForDevTools(port, Math.min(Date.now() + LAUNCH_TIMEOUT, deadline), gone)
      if (signal?.aborted) return { ok: false, code: "cancelled" }
      if (!version) return { ok: false, code: "launch-failed" }

      const page = await firstPage(port, Math.min(Date.now() + LAUNCH_TIMEOUT, deadline), url)
      if (!page?.webSocketDebuggerUrl) return { ok: false, code: "no-page" }

      cdp = connect(page.webSocketDebuggerUrl, commandTimeout)
      try {
        await cdp.ready
      } catch {
        return { ok: false, code: signal?.aborted ? "cancelled" : "attach-failed" }
      }
    } catch (error) {
      // A profile directory that cannot be created, a browser path that cannot
      // be spawned, a debugger URL `ws` refuses: all one outcome.
      return { ok: false, code: "launch-failed", error }
    }
    if (signal?.aborted) return { ok: false, code: "cancelled" }

    return await body({ cdp, child })
  } finally {
    signal?.removeEventListener("abort", abandon)
    cdp?.close()
    await stopBrowser(child)
  }
}
