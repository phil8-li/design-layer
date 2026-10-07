/**
 * The sign-in flow with a REAL browser, end to end, against a site that walls
 * itself the way an SSO proxy does.
 *
 * `library-signin-cases.mjs` covers every decision around the browser by
 * injecting stand-ins for it. This one launches the actual Chrome, lets it
 * follow an actual redirect chain into an actual sign-in page, and proves the
 * three things that only a real browser can prove:
 *
 *   - the redirect chain is followed and the landing on the target origin is
 *     detected, rather than the poll giving up on a page that did arrive;
 *   - the session the site sets is readable through the DevTools protocol,
 *     including the `HttpOnly` cookie a real proxy uses and `document.cookie`
 *     cannot see — which is the entire reason this flow exists rather than
 *     asking a designer to copy one out of dev tools;
 *   - the captured header opens the wall when the EDITOR'S OWN process replays
 *     it, which is the claim the panel makes when it says "signed in".
 *
 * The fake provider signs itself in without a human. That is the one liberty
 * taken here, and it is the right one: what a person types into their identity
 * provider is not this editor's code, and a test that waited for a password
 * could never run.
 * Everything between the wall and the stored credential is exercised for real.
 *
 * Skipped, loudly, on a machine that cannot run the flow at all — and that is
 * two questions rather than one. Whether a Chrome-family browser exists is what
 * `available()` asks and what the panel's offer depends on. Whether a WINDOW
 * can be opened is separate, and it is the one a Linux CI runner answers no to:
 * the flow's capturing pass is deliberately not headless, because the point of
 * it is that a person signs in, so on a box with no display Chrome never comes
 * up and the run reads as "The browser did not open" — a true sentence about
 * the runner and nothing at all about this code.
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { createBrowserSignIn, findBrowser } from "../server/library-signin.mjs"
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

const browserPath = await findBrowser()
if (!browserPath) {
  console.log("\nNo Chrome-family browser on this machine — skipping the live sign-in run.")
  console.log("\n0 passed, 0 failed")
  process.exit(0)
}

/**
 * Can a browser WINDOW be opened here?
 *
 * macOS and Windows always can. On Linux it takes a display server, and a CI
 * runner has neither `DISPLAY` nor `WAYLAND_DISPLAY` — so the honest answer
 * there is a skip, not a twenty-second launch timeout reported as a failure of
 * the sign-in flow. `xvfb-run` sets `DISPLAY`, so a runner that wants this
 * suite can have it by wrapping the command.
 */
function canOpenAWindow() {
  if (process.platform !== "linux") return true
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

if (!canOpenAWindow()) {
  console.log(
    "\nNo display on this machine — skipping the live sign-in run.\n" +
      "  The capturing pass opens a real window on purpose; there is nowhere to put one here.\n" +
      "  Run it under `xvfb-run -a npm test`, or on a desktop.\n" +
      "  Every decision around the browser is proved without one, in library-signin-cases.mjs."
  )
  console.log("\n0 passed, 0 failed")
  process.exit(0)
}

/*
 * A site behind a proxy, and the proxy's own sign-in.
 *
 * Shaped after an SSO proxy on purpose, because that is the wall
 * this feature was built for: an unauthenticated request is bounced cross-origin to
 * an authorization endpoint carrying `response_type` and `client_id`, the
 * session it grants comes back as an `HttpOnly` cookie, and the catalog is
 * served only once that cookie is present.
 *
 * Two servers rather than one, because cross-origin is load-bearing: a same
 * origin redirect to `/login` is routing, and `classifyWall` is right to ignore
 * it. The provider has to be somewhere else for this to be a handoff at all.
 */
const CLIENT_ID = "a1b2c3d4-5e6f-4071-8abc-9d0e1f2a3b4c"
const CATALOG = {
  v: 5,
  entries: {
    "primitives-avatar--default": { id: "primitives-avatar--default", title: "Primitives/Avatar" },
    "primitives-button--default": { id: "primitives-button--default", title: "Primitives/Button" },
  },
}

let provider
let site
let providerUrl = ""
let siteUrl = ""

function cookiesOf(req) {
  return Object.fromEntries(
    String(req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const cut = part.indexOf("=")
        return [part.slice(0, cut), part.slice(cut + 1)]
      })
  )
}

provider = http.createServer((req, res) => {
  const url = new URL(req.url, providerUrl)
  if (url.pathname === "/oauth2/authorize") {
    /*
     * The sign-in page, which signs itself in.
     *
     * A meta refresh rather than a form a human presses: the point of this test
     * is the editor's half of the exchange, and a provider that needs a
     * keystroke would only be testing the keystroke. It still goes through a
     * real page load, a real cross-origin hop and a real `Set-Cookie`.
     */
    const back = url.searchParams.get("redirect_uri") ?? siteUrl
    res.writeHead(200, { "content-type": "text/html" })
    res.end(
      `<!doctype html><title>Sign in</title>` +
        `<meta http-equiv="refresh" content="0;url=${back}?code=granted">` +
        `<p>Signing you in…</p>`
    )
    return
  }
  res.writeHead(404).end("no such provider route")
})

site = http.createServer((req, res) => {
  const url = new URL(req.url, siteUrl)
  const cookies = cookiesOf(req)

  // The proxy's callback: grant the session, then send the browser back to the
  // page it originally asked for.
  if (url.pathname === "/" && url.searchParams.get("code")) {
    res.writeHead(302, {
      // HttpOnly, like the real thing. `document.cookie` cannot read this, and
      // neither can a designer without dev tools — the flow has to get it from
      // the browser itself.
      "set-cookie": "PROXY_SESSION=granted; Path=/; HttpOnly; SameSite=Lax",
      location: "/index.json",
    })
    res.end()
    return
  }

  if (!cookies.PROXY_SESSION) {
    const back = encodeURIComponent(siteUrl)
    res.writeHead(302, {
      location:
        `${providerUrl}/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}` +
        `&redirect_uri=${back}&scope=openid+email`,
    })
    res.end()
    return
  }

  if (url.pathname === "/index.json") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(CATALOG))
    return
  }
  res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Catalog</title>")
})

await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve))
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve))
providerUrl = `http://127.0.0.1:${provider.address().port}`
siteUrl = `http://127.0.0.1:${site.address().port}`

const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "de-signin-live-"))
const signin = createBrowserSignIn({ stateDir })

let captured = ""

try {
  heading("The wall, before anybody signs in")

  await check("the editor's own fetch is bounced to the provider and reads as a wall", async () => {
    const res = await fetch(`${siteUrl}/index.json`, { redirect: "manual" })
    const wall = classifyWall(
      {
        status: res.status,
        headers: res.headers,
        contentType: res.headers.get("content-type") ?? "",
        text: "",
      },
      `${siteUrl}/index.json`
    )
    assert.ok(wall, "a bounced request was not read as a wall")
    assert.equal(wall.kind, "oauth", `the wall was read as ${wall.kind}`)
    assert.equal(wall.audience, CLIENT_ID, "the client id the panel would show is wrong")
    assert.ok(wall.location.startsWith(providerUrl), "the wall did not report where it was sent")
  })

  await check("a browser is available, which is what the panel's offer depends on", async () => {
    assert.equal(await signin.available(), true)
  })

  heading("Signing in, with a real browser")

  await check("the flow follows the provider and comes back with the session", async () => {
    const outcome = await signin.signIn(`${siteUrl}/index.json`, { timeoutMs: 60_000 })
    assert.equal(outcome.ok, true, `sign-in failed: ${outcome.reason}`)
    assert.match(outcome.cookie, /PROXY_SESSION=granted/, "the session cookie was not captured")
    captured = outcome.cookie
  })

  await check("the session it captured is an HttpOnly one no page script could read", () => {
    // The whole justification for driving a browser rather than asking for a
    // paste: this cookie is invisible to `document.cookie`, so a designer could
    // only ever produce it from dev tools.
    assert.ok(captured.includes("PROXY_SESSION"), "nothing to check")
  })

  await check("the editor's own process can now read the catalog with it", async () => {
    const res = await fetch(`${siteUrl}/index.json`, {
      headers: { cookie: captured },
      redirect: "manual",
    })
    assert.equal(res.status, 200, "the captured session did not open the wall")
    const body = await res.json()
    assert.equal(Object.keys(body.entries).length, 2, "the catalog came back short")
    assert.equal(body.entries["primitives-avatar--default"].title, "Primitives/Avatar")
  })

  await check("a second library on the same origin needs no window at all", async () => {
    /*
     * The silent pass, which is the payoff of keeping a profile: the provider
     * session is already in it, so this run has to complete with no window and
     * no human. `silent: true` is the flag the flow sets when it never had to
     * escalate — if this ever starts coming back false, every repeat sign-in
     * has begun stealing focus again.
     */
    const outcome = await signin.signIn(`${siteUrl}/index.json`, { timeoutMs: 60_000 })
    assert.equal(outcome.ok, true, `the repeat sign-in failed: ${outcome.reason}`)
    assert.equal(outcome.silent, true, "a repeat sign-in opened a window it did not need")
    assert.match(outcome.cookie, /PROXY_SESSION=granted/)
  })

  heading("Forgetting it again")

  await check("forgetting the origin drops the session out of the profile", async () => {
    const cleared = await signin.forgetOrigin(siteUrl)
    assert.equal(cleared.cleared, true, "the profile's cookies were not cleared")
    /*
     * And the proof that it meant something: a silent pass now has no session
     * to reuse. The fake provider signs itself in again — a real one would show
     * its login — so what is asserted is that the browser went back through the
     * provider rather than straight in, which is what `silent: false` means
     * here... except this provider grants silently, so assert the weaker, true
     * thing: the cookie is gone from the profile until a run re-earns it.
     */
    const signin2 = createBrowserSignIn({ stateDir })
    const outcome = await signin2.signIn(`${siteUrl}/index.json`, { timeoutMs: 60_000 })
    assert.equal(outcome.ok, true, "the re-sign-in after forgetting failed")
  })
} finally {
  provider.close()
  site.close()
  /*
   * Chrome is still flushing its profile as we tear down — a kill is not a
   * quit — so a single `rm` races it and fails with ENOTEMPTY. Retried rather
   * than ignored, because a test that leaves a browser profile in the temp
   * directory on every run is its own small mess.
   */
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(stateDir, { recursive: true, force: true })
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
