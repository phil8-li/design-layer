/**
 * The sign-in that opens the SITE'S OWN login rather than asking for a token.
 *
 * What is exercised here is everything around the browser: which provider a
 * wall names, whether a machine has a browser to open at all, the route's
 * contract, and — the part that matters most — that a window which produced no
 * usable session is reported as a sentence rather than stored as a sign-in.
 *
 * The browser itself is not launched. A test that opened a real window would
 * need a human to sign in, which is the one thing a test cannot supply; the
 * launch is covered by injecting a stand-in for it and asserting on what the
 * route does with each outcome.
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { browserCandidates, createBrowserSignIn, findBrowser, providerLabel } from "../server/library-signin.mjs"
import { classifyWall } from "../server/library-auth.mjs"

let passed = 0
let failed = 0
const heading = (text) => console.log(`\n${text}`)

async function check(name, run) {
  try {
    await run()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message.split("\n").join("\n       ")}`)
  }
}

/**
 * Await something that is supposed to finish, and resolve `{ hung: true }` if
 * it does not.
 *
 * Every case below that pins a hang has to be raced rather than awaited bare:
 * the failure mode of a regression in this module is an await with no end, and
 * without a bound such a case would stop the whole suite instead of failing it.
 *
 * The timer is cleared as well as raced. A pending `setTimeout` keeps Node's
 * event loop alive, so a handful of cases each holding a twenty-second bound
 * left the process sitting there long after the last assertion — the suite did
 * its work in fourteen seconds and took thirty-four to exit, which is the sort
 * of thing that gets a test file dropped from the default run.
 */
function bounded(work, ms) {
  let timer
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ hung: true }), ms)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

heading("Who the wall handed off to")

await check("a GitHub sign-in redirect is named as GitHub", () => {
  assert.equal(
    providerLabel("https://github.com/login/oauth/authorize?client_id=123"),
    "GitHub"
  )
})

await check("a subdomain of a known provider still names it", () => {
  assert.equal(providerLabel("https://dev-12345.okta.com/oauth2/v1/authorize"), "Okta")
})

await check("a provider nobody has heard of is not guessed at", () => {
  assert.equal(providerLabel("https://sso.internal.example.com/login"), "")
  assert.equal(providerLabel("not a url"), "")
  assert.equal(providerLabel(""), "")
})

await check("a lookalike host is not mistaken for the provider", () => {
  // `endsWith(".okta.com")` would be wrong here and `endsWith("okta.com")`
  // catastrophically so: this is somebody else's domain.
  assert.equal(providerLabel("https://acme.okta.com.evil.example/login"), "")
})

heading("The wall reports the redirect it saw")

await check("a classified OAuth wall carries the location a provider can be read from", () => {
  const location =
    "https://acme.okta.com/oauth2/v1/authorize?response_type=code&client_id=abc.apps.example.com"
  const wall = classifyWall(
    { status: 302, headers: { location }, contentType: "text/html", text: "" },
    "https://storybook.example.com/index.json"
  )
  assert.equal(wall.kind, "oauth")
  assert.equal(wall.location, location)
  // The pair is the point: the classifier stays vendor-free and the caller gets
  // the one fact it needs to put a name on a button.
  assert.equal(providerLabel(wall.location), "Okta")
})

await check("a relative redirect is resolved before it is reported", () => {
  const wall = classifyWall(
    { status: 401, headers: { location: "/login", "www-authenticate": "Bearer" }, text: "" },
    "https://storybook.example.com/index.json"
  )
  assert.equal(wall.location, "https://storybook.example.com/login")
})

heading("Finding a browser to open")

await check("a browser that exists is found, and a list of ghosts finds nothing", async () => {
  const real = path.join(os.tmpdir(), `de-fake-browser-${process.pid}`)
  await fs.writeFile(real, "#!/bin/sh\n", { mode: 0o755 })
  try {
    assert.equal(await findBrowser(["/nope/one", real, "/nope/two"]), real)
    assert.equal(await findBrowser(["/nope/one", "/nope/two"]), "")
  } finally {
    await fs.rm(real, { force: true })
  }
})

await check("browsers are found by name, best first, wherever the platform installs them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "de-browsers-"))
  try {
    const apps = path.join(root, "Applications")
    const userApps = path.join(root, "home", "Applications")
    await fs.mkdir(userApps, { recursive: true })
    for (const name of ["Notes.app", "Microsoft Edge.app", "Chromium.app", "Acme Chrome Canary.app"]) {
      await fs.mkdir(path.join(apps, name), { recursive: true })
    }
    await fs.mkdir(path.join(userApps, "Acme Chrome.app"))
    // The stable channel wins even from ~/Applications; then the other channels, Chromium, Edge.
    assert.deepEqual(browserCandidates({ platform: "darwin", roots: [apps, userApps] }), [
      path.join(userApps, "Acme Chrome.app", "Contents", "MacOS", "Acme Chrome"),
      path.join(apps, "Acme Chrome Canary.app", "Contents", "MacOS", "Acme Chrome Canary"),
      path.join(apps, "Chromium.app", "Contents", "MacOS", "Chromium"),
      path.join(apps, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"),
    ])

    const bin = path.join(root, "bin")
    await fs.mkdir(bin)
    for (const name of ["vim", "chromium", "acme-chrome-stable", "acme-chrome", "chrome-gnome-shell"]) {
      await fs.writeFile(path.join(bin, name), "")
    }
    assert.deepEqual(browserCandidates({ platform: "linux", roots: [bin] }), [
      path.join(bin, "acme-chrome"),
      path.join(bin, "acme-chrome-stable"),
      path.join(bin, "chromium"),
    ])

    const programFiles = path.join(root, "Program Files")
    await fs.mkdir(path.join(programFiles, "Acme", "Chrome"), { recursive: true })
    await fs.mkdir(path.join(programFiles, "Other", "Tool"), { recursive: true })
    assert.deepEqual(browserCandidates({ platform: "win32", roots: [programFiles] }), [
      path.join(programFiles, "Acme", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    ])

    assert.deepEqual(browserCandidates({ platform: "aix" }), [], "an unknown platform guessed at a path")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

await check("no browser on the machine is reported rather than thrown", async () => {
  const signin = createBrowserSignIn({ stateDir: os.tmpdir(), browserPath: "" })  // explicitly none
  // An empty path is the "nothing found" answer from `findBrowser`, and the
  // panel needs a sentence for it, not a stack trace.
  const outcome = await signin.signIn("https://storybook.example.com/index.json")
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /browser/i)
})

await check("a URL the editor cannot parse is refused before anything launches", async () => {
  const signin = createBrowserSignIn({ stateDir: os.tmpdir(), browserPath: "/nope" })
  const outcome = await signin.signIn("not a url")
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /not a URL/i)
})

await check("a run that may not ask a human says so instead of opening a window", async () => {
  /*
   * The silent pass is tried first and, with a browser that cannot launch, it
   * fails; `interactive: false` then stops the flow rather than escalating to a
   * window. This is the branch a background refresh would take, and the point
   * of asserting it is that the escalation is a decision rather than an
   * accident of control flow.
   */
  const signin = createBrowserSignIn({ stateDir: os.tmpdir(), browserPath: "/nope/not-a-browser" })
  const outcome = await signin.signIn("https://storybook.example.com/index.json", {
    interactive: false,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /not allowed to ask/i)
})

await check("a browser that cannot launch fails fast rather than waiting out the timeout", async () => {
  const signin = createBrowserSignIn({ stateDir: os.tmpdir(), browserPath: "/nope/not-a-browser" })
  const started = Date.now()
  const outcome = await signin.signIn("https://storybook.example.com/index.json", {
    interactive: false,
  })
  const took = Date.now() - started
  assert.equal(outcome.ok, false)
  // The launch timeout is 20s and the silent pass 12s; a spawn error has to
  // short-circuit both or every "no browser" answer takes half a minute.
  assert.ok(took < 8000, `a failed launch took ${took}ms to report`)
})

heading("What the route does with each outcome")

/**
 * The route's logic, lifted out of `routes.mjs` shape-for-shape.
 *
 * `routes.mjs` builds its dependencies inside `createDesignLayerRoutes`, so
 * driving the real handler would mean standing up a server and a store to
 * assert on three branches. This mirror keeps the branches honest: it is the
 * same four decisions in the same order, and if the route grows a fifth this
 * test is where the omission shows up.
 */
async function routeSignIn({ signin, probe, save }, url) {
  const outcome = await signin.signIn(url)
  if (!outcome.ok) return { ok: false, reason: outcome.reason, provider: outcome.provider ?? "" }
  const credential = { scheme: "cookie", value: outcome.cookie }
  const result = await probe(url, { credential })
  if (result.sso || !result.ok) {
    return { ok: false, provider: outcome.provider ?? "", reason: "still refused" }
  }
  return { ok: true, provider: outcome.provider ?? "", ...(await save({ url, ...credential })) }
}

await check("a session that opens the wall is verified and then stored", async () => {
  const saved = []
  const answer = await routeSignIn(
    {
      signin: { signIn: async () => ({ ok: true, cookie: "SESSION=abc", provider: "Okta" }) },
      probe: async (_url, options) => {
        assert.equal(options.credential.scheme, "cookie", "the cookie was not the thing verified")
        assert.equal(options.credential.value, "SESSION=abc")
        return { ok: true, sso: false, status: 200 }
      },
      save: async (entry) => {
        saved.push(entry)
        return { origin: "https://storybook.example.com", scheme: "cookie", addedAt: 1 }
      },
    },
    "https://storybook.example.com/index.json"
  )
  assert.equal(answer.ok, true)
  assert.equal(answer.provider, "Okta")
  assert.equal(saved.length, 1, "a verified session was not stored")
})

await check("a session the site still refuses is NOT stored", async () => {
  const saved = []
  const answer = await routeSignIn(
    {
      signin: { signIn: async () => ({ ok: true, cookie: "SESSION=abc", provider: "Okta" }) },
      // The window signed in to the identity provider and the site still said
      // no — which is exactly the state that, stored, makes the panel claim a
      // sign-in whose libraries keep failing.
      probe: async () => ({ ok: false, sso: true, status: 302 }),
      save: async (entry) => {
        saved.push(entry)
        return {}
      },
    },
    "https://storybook.example.com/index.json"
  )
  assert.equal(answer.ok, false)
  assert.equal(saved.length, 0, "an unverified session was written to disk")
})

await check("a window the person closed is an ordinary answer, not an error", async () => {
  const answer = await routeSignIn(
    {
      signin: {
        signIn: async () => ({
          ok: false,
          reason: "The sign-in window was closed before the site let the editor in.",
          provider: "Okta",
        }),
      },
      // Neither of these may run: there is no session to verify and nothing to
      // store, and reaching either would mean the route treated a closed window
      // as a successful sign-in.
      probe: async () => {
        throw new Error("the wall should never have been probed")
      },
      save: async () => {
        throw new Error("nothing should have been stored")
      },
    },
    "https://storybook.example.com/index.json"
  )
  assert.equal(answer.ok, false)
  assert.match(answer.reason, /closed/i)
  assert.equal(answer.provider, "Okta")
})

heading("The remembered profile")

await check("the profile lives under the editor's state directory, not the user's browser", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "de-signin-state-"))
  try {
    const signin = createBrowserSignIn({ stateDir, browserPath: "/nope" })
    assert.equal(signin.profileDir, path.join(stateDir, "signin-browser"))
    // Forgetting is the whole-profile operation, because a provider session is
    // not per-origin: one sign-in at the identity provider opens every site it
    // vouches for.
    await fs.mkdir(signin.profileDir, { recursive: true })
    await signin.forgetSessions()
    await assert.rejects(fs.access(signin.profileDir))
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

await check("forgetting one origin does not sign the designer out of everything", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "de-signin-forget-"))
  try {
    // No browser: the per-origin clear cannot run, and the contract is that it
    // reports that rather than throwing — the credential has already been
    // dropped by the time this is called, and a forget must not fail on its
    // cleanup step.
    const signin = createBrowserSignIn({ stateDir, browserPath: "" })
    const answer = await signin.forgetOrigin("https://storybook.example.com")
    assert.equal(answer.cleared, false)
    // And the profile itself survives, because one origin is not every origin.
    await fs.mkdir(signin.profileDir, { recursive: true })
    await signin.forgetOrigin("https://storybook.example.com")
    await fs.access(signin.profileDir)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

heading("A browser that stops cooperating")

/*
 * THE TWO WAYS THIS FLOW USED TO FREEZE, and they produced one symptom: a
 * dialog stuck on "Opening the sign-in window…" that never resolved, and a
 * browser process still running hours after its own ceiling should have killed
 * it. Measured on a real machine — launched 12:58, still alive at 19:00,
 * against a four-minute timeout.
 *
 * Neither is reachable with a real Chrome in a test, so `fixtures/fake-chrome`
 * stands in: it takes Chrome's command line, opens the debugging port it was
 * asked for, and then misbehaves in one specific way. `browserPath` is a
 * supported config option precisely so a caller can supply one.
 */
const FAKE_CHROME = fileURLToPath(new URL("./fixtures/fake-chrome.mjs", import.meta.url))

await check("a browser that answers nothing ends the run instead of hanging", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "de-signin-mute-"))
  try {
    process.env.FAKE_CHROME_MODE = "mute"
    const signin = createBrowserSignIn({
      stateDir,
      browserPath: FAKE_CHROME,
      // The shipped ceiling is fifteen seconds a command. The defect is the
      // same at any value, and a suite nobody waits for is a suite nobody runs.
      commandTimeout: 250,
    })

    /*
     * The assertion is that this RESOLVES. Before the timeout existed, a
     * pending DevTools request settled only on an answer or on the socket
     * closing — and a browser that is alive and silent is neither, so the
     * promise never settled, the poll loop never reached its next deadline
     * check, and the `finally` that stops the browser never ran.
     *
     * Raced against a bound rather than awaited bare, because the failure mode
     * of a regression here is an infinite hang: without the race this case
     * would stop the whole suite rather than fail it.
     */
    const started = Date.now()
    const outcome = await bounded(
      signin.signIn("https://storybook.example.com/tokens.json", {
        interactive: false,
        timeoutMs: 2000,
      }),
      30000
    )
    assert.equal(outcome.hung, undefined, "the sign-in never returned — the hang is back")
    assert.equal(outcome.ok, false)
    assert.ok(
      typeof outcome.reason === "string" && outcome.reason.length > 0,
      `a failed sign-in must come back as a sentence: ${JSON.stringify(outcome)}`
    )
    assert.ok(
      Date.now() - started < 25000,
      `the run took ${Date.now() - started}ms, which is a ceiling rather than a fault`
    )
  } finally {
    delete process.env.FAKE_CHROME_MODE
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

await check("a JavaScript dialog is dismissed rather than left blocking the page", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "de-signin-dialog-"))
  const report = path.join(stateDir, "report.json")
  try {
    process.env.FAKE_CHROME_MODE = "dialog"
    process.env.FAKE_CHROME_REPORT = report
    const signin = createBrowserSignIn({
      stateDir,
      browserPath: FAKE_CHROME,
      commandTimeout: 250,
    })

    await signin.signIn("https://storybook.example.com/tokens.json", {
      interactive: false,
      // The whole call, not just the window: `timeoutMs` bounds the pass that
      // asks a person, and this run never gets one, so on its own it left the
      // silent pass free to poll a browser that will never land for its full
      // forty-five-second ceiling — three quarters of a minute of suite time to
      // observe something that happens in the first exchange.
      totalTimeoutMs: 1500,
    })

    /*
     * `Page.enable` hands dialog handling to the CLIENT: Chrome stops showing
     * `alert`, `confirm` and `beforeunload` itself and blocks the renderer
     * until the client answers. A driver that enables the domain and never
     * answers freezes the page — and every `Runtime.evaluate` against it then
     * hangs, which is the other half of the report these two cases exist for.
     * The fixture raises one; this asserts the answer came back.
     */
    const seen = JSON.parse(await fs.readFile(report, "utf8"))
    assert.equal(
      seen.handledDialog,
      true,
      `a dialog was left blocking the renderer; the driver sent ${JSON.stringify(seen.commands)}`
    )
  } finally {
    delete process.env.FAKE_CHROME_MODE
    delete process.env.FAKE_CHROME_REPORT
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

await check("a beforeunload is accepted, while a confirm is still dismissed", async () => {
  /*
   * The answer to a dialog is not one policy, and answering everything with
   * "no" was a stall rather than a caution.
   *
   * `beforeunload` is a confirmation of a NAVIGATION: dismissing it means "stay
   * on this page", which cancels the navigation that was just requested — ours
   * at the start of every run, and the person's own click on the provider's
   * Continue button for the rest of it. Nothing happens, they click again,
   * nothing happens again, and they cannot answer the dialog themselves because
   * enabling the Page domain took that away from them.
   *
   * `confirm` is the case the caution was written for and keeps it: a question
   * with two real answers belongs to the person signing in, not to this editor.
   * Both halves are asserted together because either one alone would pass
   * against a blanket policy — it is the DIFFERENCE between them that is the
   * fix.
   */
  const answered = async (mode) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `de-signin-${mode}-`))
    const report = path.join(stateDir, "report.json")
    try {
      process.env.FAKE_CHROME_MODE = mode
      process.env.FAKE_CHROME_REPORT = report
      const signin = createBrowserSignIn({ stateDir, browserPath: FAKE_CHROME, commandTimeout: 250 })
      await signin.signIn("https://storybook.example.com/tokens.json", {
        interactive: false,
        totalTimeoutMs: 1500,
      })
      return JSON.parse(await fs.readFile(report, "utf8")).dialogs ?? []
    } finally {
      delete process.env.FAKE_CHROME_MODE
      delete process.env.FAKE_CHROME_REPORT
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  }

  assert.deepEqual(
    await answered("dialog"),
    [{ type: "beforeunload", accept: true }],
    "a beforeunload was answered 'stay on this page', which cancels the navigation"
  )
  assert.deepEqual(
    await answered("dialog-confirm"),
    [{ type: "confirm", accept: false }],
    "a confirm was answered on the person's behalf"
  )
})

heading("A browser that never gets as far as a window")

await check("a WebSocket upgrade that never completes is given up on, and the browser stopped", async () => {
  /*
   * THE HANG THAT SURVIVED THE FIRST FIX. Bounding every DevTools command left
   * the one await that has to succeed before a command can be sent at all: the
   * upgrade from HTTP to WebSocket. `ws` arms no handshake timer unless it is
   * given one, so a socket that connects and never upgrades settles neither
   * `open` nor `error`, and that await is not inside any poll loop — no
   * deadline is ever consulted and no ceiling can fire.
   *
   * Two assertions, because the hang had two costs. The run has to come back,
   * and the browser it spawned has to be dead: an attach that failed used to
   * leave a Chrome holding the profile's lock, after which every later sign-in
   * on this machine failed too.
   */
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "de-signin-nohandshake-"))
  const report = path.join(stateDir, "report.json")
  try {
    process.env.FAKE_CHROME_MODE = "no-handshake"
    process.env.FAKE_CHROME_REPORT = report
    const signin = createBrowserSignIn({ stateDir, browserPath: FAKE_CHROME, commandTimeout: 500 })

    const outcome = await bounded(
      signin.signIn("https://storybook.example.com/tokens.json", {
        interactive: false,
        totalTimeoutMs: 5000,
      }),
      15000
    )
    assert.equal(outcome.hung, undefined, "the attach never gave up — the hang is back")
    assert.equal(outcome.ok, false)
    assert.ok(outcome.reason, "a failed attach must come back as a sentence")

    const seen = JSON.parse(await fs.readFile(report, "utf8"))
    assert.equal(seen.stopped, true, "the browser was left running after the attach failed")
  } finally {
    delete process.env.FAKE_CHROME_MODE
    delete process.env.FAKE_CHROME_REPORT
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

await check("a debugging endpoint that never answers cannot outlast the run's budget", async () => {
  /*
   * Two defects in one shape, because they are the same defect.
   *
   * The launch deadline was read only BETWEEN probes, and `fetch` carried no
   * abort signal, so a port that accepts a connection and never answers HTTP —
   * an ssh tunnel, an agent socket, a peer editor that won the race for the
   * port number — held each probe until undici's own five-minute header
   * timeout. Fifteen times the launch budget, paid once per pass.
   *
   * And nothing above it would have noticed, because there was no budget for
   * the call as a whole: two ceilings, a dozen independent bounds around them,
   * and a worst case of roughly fifteen minutes against an advertised four. So
   * what is asserted here is the total: the call is told it has three seconds,
   * and it has to be finished in something like three seconds whatever the
   * browser does.
   */
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "de-signin-hanghttp-"))
  try {
    process.env.FAKE_CHROME_MODE = "hang-http"
    const signin = createBrowserSignIn({ stateDir, browserPath: FAKE_CHROME, commandTimeout: 500 })

    const started = Date.now()
    const outcome = await bounded(
      // Interactive, so BOTH passes run and the budget has to cover the pair.
      signin.signIn("https://storybook.example.com/tokens.json", { totalTimeoutMs: 3000 }),
      20000
    )
    const took = Date.now() - started
    assert.equal(outcome.hung, undefined, "the run never returned — an unbounded fetch is back")
    assert.equal(outcome.ok, false)
    assert.match(outcome.reason, /did not open/i)
    // The margin is the one operation that can still be in flight when the
    // deadline passes, plus the teardown that follows it.
    assert.ok(took < 3000 + 8000, `a 3s budget took ${took}ms`)
  } finally {
    delete process.env.FAKE_CHROME_MODE
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

await check("a target list that is not JSON is an outcome, and the browser is still stopped", async () => {
  /*
   * Reading the target list had no error handling and sat outside the cleanup
   * the rest of the run lives in, so a body that is not JSON — a browser that
   * died after answering `/json/version`, a non-browser on the port — threw a
   * `SyntaxError` all the way out of `signIn` and reached the panel as a 500,
   * where the contract promises a sentence. The throw also skipped every line
   * that would have stopped the browser, leaving a Chrome holding the profile's
   * singleton lock; from then on every sign-in on this machine failed with "The
   * browser did not open", which names neither the cause nor the cure.
   *
   * So: a sentence, and a dead browser.
   */
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "de-signin-badlist-"))
  const report = path.join(stateDir, "report.json")
  try {
    process.env.FAKE_CHROME_MODE = "bad-list"
    process.env.FAKE_CHROME_REPORT = report
    const signin = createBrowserSignIn({ stateDir, browserPath: FAKE_CHROME, commandTimeout: 500 })

    const outcome = await signin.signIn("https://storybook.example.com/tokens.json", {
      interactive: false,
      totalTimeoutMs: 5000,
    })
    assert.equal(outcome.ok, false)
    assert.ok(outcome.reason, "a browser with no usable page must come back as a sentence")

    const seen = JSON.parse(await fs.readFile(report, "utf8"))
    assert.equal(seen.stopped, true, "the browser was orphaned when the target list was unreadable")
  } finally {
    delete process.env.FAKE_CHROME_MODE
    delete process.env.FAKE_CHROME_REPORT
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

await check("a window-raising helper that blocks is killed rather than waited on", async () => {
  /*
   * The raise is best-effort, and this is what makes that sentence true.
   *
   * Bringing the window to the front sends an Apple event to another
   * application, which on a machine that has not granted this process
   * automation rights opens a consent dialog — BEHIND other windows, which is
   * the very failure the raise exists to fix, so nobody sees it to answer it.
   * The helper resolved only on the child's exit, so the sign-in loop never
   * started: no window the person could use, no ceiling, no end.
   *
   * The helper is injected because this branch runs only on the visible pass
   * and only where a raise mechanism exists; the stand-in is a process that
   * starts, records its pid and then does nothing at all, which is what the
   * blocked `osascript` looks like from here. What is asserted is that the run
   * came back and that nothing it started is still alive.
   */
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "de-signin-raise-"))
  const pidFile = path.join(stateDir, "raise-pids")
  const hangScript = path.join(stateDir, "hang.mjs")
  await fs.writeFile(
    hangScript,
    `import fs from "node:fs"\n` +
      `fs.appendFileSync(process.argv[2], String(process.pid) + "\\n")\n` +
      `setInterval(() => {}, 1000)\n`
  )
  try {
    process.env.FAKE_CHROME_MODE = "idle"
    const signin = createBrowserSignIn({
      stateDir,
      browserPath: FAKE_CHROME,
      commandTimeout: 500,
      raiseCommand: [process.execPath, hangScript, pidFile],
    })

    const outcome = await bounded(
      // Interactive: the raise happens on the visible pass and nowhere else.
      signin.signIn("https://storybook.example.com/tokens.json", { totalTimeoutMs: 4000 }),
      25000
    )
    assert.equal(outcome.hung, undefined, "the raise never gave up and the sign-in never started")
    assert.equal(outcome.ok, false)

    const pids = (await fs.readFile(pidFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => Number(line))
    assert.ok(pids.length > 0, "the raise helper was never run, so nothing was proved")
    // A moment for the OS to reap what was killed; `kill(pid, 0)` only asks.
    await new Promise((resolve) => setTimeout(resolve, 300))
    for (const pid of pids) {
      assert.throws(
        () => process.kill(pid, 0),
        `the raise helper (pid ${pid}) was left running after it overran`
      )
    }
  } finally {
    delete process.env.FAKE_CHROME_MODE
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

heading("A login page is not an arrival")

await check("a same-origin login page is not landed on, while a real page still is", async () => {
  /*
   * THE CLOSEST THING IN THIS FLOW TO THE REPORTED SYMPTOM: press Sign in, no
   * window ever appears, and the answer is a sentence telling you to go and
   * find a token.
   *
   * Landing required a 2xx document on the target origin with the address bar
   * to match, and escalation to a visible window required parking CROSS-origin.
   * A site that renders its own `/login` at 200 satisfies the first and can
   * never satisfy the second — so the silent pass "landed" on the login screen,
   * scraped the CSRF cookie it had set, and reported success. No window opened.
   * Same-origin login pages are the norm rather than the exception: a
   * self-hosted Storybook behind a form, a dashboard with a JavaScript auth
   * gate, anything that routes to a login instead of redirecting to one.
   *
   * Both modes are asserted together on purpose. Refusing to land is trivial to
   * get right by never landing at all, and that would break every sign-in this
   * module exists for; the control run proves the one difference between the
   * two pages — a password input — is what decided it.
   */
  const outcomeFor = async (mode) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `de-signin-${mode}-`))
    try {
      process.env.FAKE_CHROME_MODE = mode
      const signin = createBrowserSignIn({ stateDir, browserPath: FAKE_CHROME, commandTimeout: 500 })
      return await signin.signIn("https://storybook.example.com/tokens.json", {
        // Not allowed to open a window, so an escalation is visible in the
        // answer rather than in a browser nobody can see from here.
        interactive: false,
        totalTimeoutMs: 6000,
      })
    } finally {
      delete process.env.FAKE_CHROME_MODE
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  }

  const login = await outcomeFor("login-page")
  assert.equal(login.ok, false, "the silent pass reported success from the site's login page")
  assert.equal(login.cookie, undefined, "a login page's cookies were captured as a session")
  assert.match(
    login.reason,
    /not allowed to ask/i,
    `a login page has to escalate to a window, not answer with ${JSON.stringify(login.reason)}`
  )

  const landed = await outcomeFor("landing")
  assert.equal(landed.ok, true, `a page that is not a login page stopped landing: ${landed.reason}`)
  assert.equal(landed.silent, true, "a silent arrival should not have opened a window")
  assert.match(landed.cookie, /SESSION=granted/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
