/**
 * Cases for the Mac desk: the desk server's routes and refusals, the manifest
 * Chrome's installability check reads, the "Open in Mac app" hand-off (the POST
 * an editor sends, the event stream a window listens on, and what the desk page
 * does with a page it is handed), the LaunchAgent plist and how the launcher
 * reads it, and the installer's dry run.
 *
 * The desk server runs in-process on an ephemeral port with the start-screen
 * supervisor off, and HOME points at a temp directory so the editor registry
 * (runtime/editor-registry.mjs reads os.homedir()) is one this file controls.
 *
 * Skipped, loudly, off macOS. Most of what is checked here is portable — the
 * routes, the refusals, the manifest — but the plist case shells out to
 * `/usr/bin/plutil` to prove the XML this writes is XML launchd will take, and
 * a Linux runner has nothing to answer that with. The suite is named in
 * `npm test` so the macOS legs of CI run it, rather than it being the one
 * subsystem in the repository that nothing runs.
 *
 * Usage: node desktop/mac/test/desk-cases.mjs
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "darwin") {
  console.log(
    `\nNot macOS (${process.platform}) — skipping the desk run.\n` +
      "  The desk is a Mac Dock app: a user LaunchAgent and a Chrome-installed web app.\n" +
      "  Its plist case needs /usr/bin/plutil, which only this platform has.\n" +
      "  Run it on a Mac with `node desktop/mac/test/desk-cases.mjs`."
  )
  console.log("\n0 passed, 0 failed")
  process.exit(0)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAC = path.resolve(HERE, "..")
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "desk-cases-"))
const realHome = os.homedir()
process.env.HOME = tempHome

const { createDeskServer, createHandoff, manifest } = await import("../desk-server.mjs")
const { GLYPHS } = await import("../shell-page.mjs")
const { APP_FEATURES, findMacChrome, profileChromeCommand } = await import("../chrome-pipe.mjs")
const { buildPlist, LABEL, plistPath } = await import("../launch-agent.mjs")
const { DEFAULT_DESK_PORT, DESK_LABEL, deskPlistPath, deskUrlFromHost } = await import("../../../runtime/mac-desk.mjs")

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

function request(port, { method = "GET", pathname = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        const body = Buffer.concat(chunks)
        let json = null
        try {
          json = JSON.parse(body.toString("utf8"))
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, headers: res.headers, body, json })
      })
    })
    req.on("error", reject)
    req.end(body)
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await sleep(10)
  }
}

/**
 * One desk window's event stream, as the page's EventSource would hold it.
 *
 * Resolves once the response headers are in, which is after the route has
 * subscribed: the handler writes its first line and subscribes in one turn.
 */
function stream(port, query = "") {
  return new Promise((resolve, reject) => {
    const events = []
    const req = http.get({ host: "127.0.0.1", port, path: `/api/events${query}` }, (res) => {
      let buffer = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const event = /^event: (.+)$/m.exec(block)?.[1]
          if (event) events.push({ event, data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) })
        }
      })
      resolve({ res, events, close: () => req.destroy() })
    })
    req.on("error", reject)
  })
}

let pickerCalls = 0
const activations = []
const desk = await createDeskServer({
  port: 0,
  supervise: false,
  logDir: path.join(tempHome, "logs"),
  log: () => {},
  pickFolder: async () => {
    pickerCalls += 1
    return { cancelled: true }
  },
  // Records instead of launching anything: the real one runs `open` on the app.
  activate: (deskUrl, context) => {
    activations.push({ deskUrl, ...context })
    return true
  },
})
const port = desk.port
const EDITOR = "http://127.0.0.1:3466"
/** A POST the way the editor sends it: JSON as text/plain, from its own origin. */
const post = (payload, headers = {}) =>
  request(port, {
    method: "POST",
    pathname: "/api/open",
    headers: { origin: EDITOR, "content-type": "text/plain;charset=UTF-8", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  })
const health = async () => (await request(port, { pathname: "/api/health" })).json

console.log("desk server")

await check("health answers ok with the supervisor disabled", async () => {
  const res = await request(port, { pathname: "/api/health" })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.startScreen.state, "disabled")
})

await check("shell page is the DesignLayer window with a manifest link and WCO strip", async () => {
  const res = await request(port)
  assert.equal(res.status, 200)
  const html = res.body.toString("utf8")
  assert.match(html, /<title>DesignLayer<\/title>/)
  assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/)
  assert.match(html, /titlebar-area-width/)
  assert.match(html, /clipboard-read; clipboard-write; fullscreen/)
  assert.equal(res.headers["x-frame-options"], "DENY")
})

await check("every glyph in the strip comes from symbols/ at the 20px title-bar size", async () => {
  // Each is a file in symbols/, copied unchanged: one path, at the 20px optical size.
  const symbols = path.join(MAC, "symbols")
  for (const name of Object.keys(GLYPHS)) {
    const svg = fs.readFileSync(path.join(symbols, `${name}.svg`), "utf8")
    assert.match(svg, /viewBox="0 -960 960 960"/, name)
    assert.match(svg, /width="20"/, `${name} is not the 20px optical size`)
    assert.equal(svg.match(/<path /g).length, 1, `${name} draws more than one path`)
  }
  // The header's buttons, and the tab glyphs the script carries as JSON strings.
  const html = (await request(port)).body.toString("utf8").replace(/\\"/g, '"')
  const svgs = html.match(/<svg\b[^>]*>/g) ?? []
  assert.ok(svgs.length >= 6, `expected the strip's 6 glyphs, found ${svgs.length}`)
  for (const svg of svgs) {
    assert.ok(svg.includes('viewBox="0 -960 960 960"') && svg.includes('fill="currentColor"'), `${svg} is not a title-bar glyph`)
    assert.match(svg, /width="(16|20)"/, `${svg}: 20px in a button, 16px inside a tab`)
  }
})

await check("manifest meets Chrome installability", async () => {
  const res = await request(port, { pathname: "/manifest.webmanifest" })
  assert.equal(res.status, 200)
  assert.match(res.headers["content-type"], /application\/manifest\+json/)
  const m = res.json
  assert.deepEqual(m, manifest())
  assert.equal(m.id, "/")
  assert.equal(m.name, "DesignLayer")
  assert.ok(m.short_name)
  assert.equal(m.start_url, "/")
  assert.equal(m.scope, "/")
  assert.equal(m.display, "standalone")
  assert.deepEqual(m.display_override, ["window-controls-overlay"])
  assert.equal(m.theme_color, "#1a1a1a")
  assert.equal(m.background_color, "#1a1a1a")
  const sizes = m.icons.filter((i) => i.type === "image/png").map((i) => Number(i.sizes.split("x")[0]))
  assert.ok(sizes.some((s) => s >= 192), "needs a >=192 PNG")
  assert.ok(sizes.includes(512), "needs a 512 PNG")
  assert.ok(m.icons.some((i) => i.purpose === "maskable"), "needs a maskable icon")
})

await check("every manifest icon is served as a real PNG of the stated size", async () => {
  for (const icon of manifest().icons) {
    const res = await request(port, { pathname: icon.src })
    assert.equal(res.status, 200, icon.src)
    assert.equal(res.headers["content-type"], "image/png")
    assert.equal(res.body.subarray(1, 4).toString("latin1"), "PNG", `${icon.src} is not a PNG`)
    const width = res.body.readUInt32BE(16)
    const height = res.body.readUInt32BE(20)
    assert.equal(`${width}x${height}`, icon.sizes, icon.src)
  }
})

await check("the tab icon is the start screen's favicon, served as SVG", async () => {
  // make-icons.mjs copies runtime/favicon.svg here; an edit to only one of them would drift.
  const favicon = fs.readFileSync(path.join(MAC, "..", "..", "runtime", "favicon.svg"), "utf8")
  assert.equal(fs.readFileSync(path.join(MAC, "icons", "mark.svg"), "utf8"), favicon)
  const res = await request(port, { pathname: "/icons/mark.svg" })
  assert.equal(res.status, 200)
  assert.equal(res.headers["content-type"], "image/svg+xml")
  assert.equal(res.body.toString("utf8"), favicon)
})

await check("service worker and offline page are served", async () => {
  const sw = await request(port, { pathname: "/sw.js" })
  assert.equal(sw.status, 200)
  assert.match(sw.headers["content-type"], /javascript/)
  assert.match(sw.body.toString(), /offline\.html/)
  const offline = await request(port, { pathname: "/offline.html" })
  assert.equal(offline.status, 200)
  assert.match(offline.body.toString(), /install\.mjs --start/)
})

await check("refuses a foreign Host header", async () => {
  const res = await request(port, { pathname: "/api/health", headers: { host: "evil.example" } })
  assert.equal(res.status, 403)
})

await check("refuses a foreign Origin", async () => {
  const res = await request(port, { pathname: "/api/editors", headers: { origin: "https://evil.example" } })
  assert.equal(res.status, 403)
})

await check('refuses Origin "null" (sandboxed iframe, data: URL)', async () => {
  const res = await request(port, { pathname: "/api/health", headers: { origin: "null" } })
  assert.equal(res.status, 403)
})

await check("accepts a loopback Origin", async () => {
  const res = await request(port, { pathname: "/api/health", headers: { origin: `http://localhost:${port}` } })
  assert.equal(res.status, 200)
})

await check("editors: empty registry is an empty list", async () => {
  const res = await request(port, { pathname: "/api/editors" })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { editors: [] })
})

await check("editors: live entries are normalized, dead ones swept", async () => {
  const dir = path.join(tempHome, ".local", "state", "designlayer", "editors")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "4100.json"),
    JSON.stringify({ proxyPort: 4100, packageName: "demo-app", projectRoot: "/tmp/demo-app", url: "http://127.0.0.1:4100", pid: process.pid, startedAt: 1 })
  )
  fs.writeFileSync(
    path.join(dir, "4200.json"),
    JSON.stringify({ proxyPort: 4200, projectRoot: "/tmp/no-name", pid: process.pid, startedAt: 2 })
  )
  // A pid that cannot exist.
  fs.writeFileSync(path.join(dir, "4300.json"), JSON.stringify({ proxyPort: 4300, pid: 2 ** 31 - 2 }))
  const res = await request(port, { pathname: "/api/editors" })
  assert.equal(res.status, 200)
  assert.deepEqual(
    res.json.editors.map(({ name, url, projectRoot, pid, alive }) => ({ name, url, projectRoot, pid, alive })),
    [
      { name: "demo-app", url: "http://127.0.0.1:4100", projectRoot: "/tmp/demo-app", pid: process.pid, alive: true },
      { name: "no-name", url: "http://127.0.0.1:4200", projectRoot: "/tmp/no-name", pid: process.pid, alive: true },
    ]
  )
  assert.equal(fs.existsSync(path.join(dir, "4300.json")), false, "dead entry should be swept")
})

await check("pick-folder refuses GET without opening a dialog", async () => {
  const res = await request(port, { pathname: "/api/pick-folder" })
  assert.equal(res.status, 405)
  assert.equal(pickerCalls, 0)
})

await check("pick-folder POST from a foreign Origin is refused before the dialog", async () => {
  const res = await request(port, { method: "POST", pathname: "/api/pick-folder", headers: { origin: "https://evil.example" } })
  assert.equal(res.status, 403)
  assert.equal(pickerCalls, 0)
})

await check("pick-folder POST reports a cancelled dialog", async () => {
  const res = await request(port, { method: "POST", pathname: "/api/pick-folder" })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { cancelled: true })
  assert.equal(pickerCalls, 1)
})

await check("unknown routes are 404", async () => {
  const res = await request(port, { pathname: "/nope" })
  assert.equal(res.status, 404)
})

console.log("open in Mac app")

await check("health says whether the app is installed and how many windows listen", async () => {
  // HOME is a temp directory here, so there is no app shim in it.
  assert.deepEqual((await health()).app, { installed: false, windows: 0 })
})

await check("a preflight from an editor origin allows the POST", async () => {
  const res = await request(port, {
    method: "OPTIONS",
    pathname: "/api/open",
    headers: { origin: EDITOR, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  })
  assert.equal(res.status, 204)
  assert.equal(res.headers["access-control-allow-origin"], EDITOR)
  assert.equal(res.headers["access-control-allow-methods"], "POST")
  assert.match(res.headers["access-control-allow-headers"], /content-type/)
})

await check("open refuses a foreign Origin before it reads the body or raises the app", async () => {
  const res = await post({ url: `${EDITOR}/studio` }, { origin: "https://evil.example" })
  assert.equal(res.status, 403)
  assert.equal(res.headers["access-control-allow-origin"], undefined)
  assert.equal(activations.length, 0)
})

await check("open refuses anything that is not a page on this Mac, in a sentence the editor can read", async () => {
  for (const [url, sentence] of [
    ["https://example.com/", /Only pages on this Mac/],
    ["http://127.0.0.1.evil.test/", /Only pages on this Mac/],
    ["file:///etc/passwd", /Only http pages/],
    ["javascript:alert(1)", /Only http pages/],
    [`http://127.0.0.1:${port}/`, /own page/],
    ["not a url", /full URL/],
  ]) {
    const res = await post({ url })
    assert.equal(res.status, 400, url)
    assert.match(res.json.error, sentence, url)
    assert.equal(res.headers["access-control-allow-origin"], EDITOR, `the editor cannot read the refusal of ${url}`)
  }
  const garbled = await post("{nope")
  assert.equal(garbled.status, 400)
  assert.match(garbled.json.error, /JSON/)
  assert.equal(garbled.headers["access-control-allow-origin"], EDITOR)
  assert.equal(activations.length, 0, "a refused page raised the app")
})

await check("open answers GET with the method it takes", async () => {
  const res = await request(port, { pathname: "/api/open" })
  assert.equal(res.status, 405)
  assert.match(res.json.error, /accepts POST only/)
})

await check("with no window up, the page is held, the app is raised, and the first window takes it once", async () => {
  const res = await post({ url: "http://localhost:3466/studio?tab=agents" })
  assert.equal(res.status, 200)
  assert.equal(res.headers["access-control-allow-origin"], EDITOR)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.delivered, 0)
  assert.equal(res.json.launched, true)
  // One spelling of this machine, so the frame is same-site with the desk.
  assert.equal(res.json.url, "http://127.0.0.1:3466/studio?tab=agents")
  assert.deepEqual(activations, [{ deskUrl: `http://127.0.0.1:${port}`, listening: 0 }])
  const first = await stream(port, "?window=app")
  await until(() => first.events.length === 1)
  assert.equal(first.events[0].event, "open-url")
  assert.equal(first.events[0].data.url, "http://127.0.0.1:3466/studio?tab=agents")
  const second = await stream(port, "?window=app")
  await sleep(50)
  assert.equal(second.events.length, 0, "a held page was handed out twice")
  first.close()
  second.close()
  await until(async () => (await health()).app.windows === 0)
})

await check("a window that is up gets the page at once, and activate:false raises nothing", async () => {
  const window = await stream(port, "?window=app")
  const before = activations.length
  const quiet = await post({ url: `${EDITOR}/studio`, activate: false })
  assert.equal(quiet.json.delivered, 1)
  assert.equal(quiet.json.launched, false)
  assert.equal(activations.length, before)
  await until(() => window.events.length === 1)
  assert.equal(window.events[0].data.url, `${EDITOR}/studio`)
  // Raising is the default, and it is told a window is already listening.
  await post({ url: `${EDITOR}/other` })
  assert.deepEqual(activations.at(-1), { deskUrl: `http://127.0.0.1:${port}`, listening: 1 })
  window.close()
  await until(async () => (await health()).app.windows === 0)
})

await check("the app's windows take a page ahead of a desk page open in a browser tab", async () => {
  const tab = await stream(port, "?window=tab")
  const app = await stream(port, "?window=app")
  assert.equal((await health()).app.windows, 2)
  const res = await post({ url: `${EDITOR}/`, activate: false })
  assert.equal(res.json.delivered, 1)
  await until(() => app.events.length === 1)
  await sleep(50)
  assert.equal(tab.events.length, 0, "the browser tab took the page as well")
  app.close()
  await until(async () => (await health()).app.windows === 1)
  // With no app window left, the tab is the window there is.
  await post({ url: `${EDITOR}/`, activate: false })
  await until(() => tab.events.length === 1)
  tab.close()
})

await check("a held page expires instead of ambushing a later launch", async () => {
  const handoff = createHandoff({ maxAgeMs: 30 })
  handoff.request("http://127.0.0.1:3466/old")
  await sleep(60)
  handoff.request("http://127.0.0.1:3466/new")
  const writes = []
  const off = handoff.subscribe({ write: (chunk) => writes.push(chunk) })
  assert.equal(writes.length, 1)
  assert.match(writes[0], /^event: open-url\ndata: \{.*"url":"http:\/\/127\.0\.0\.1:3466\/new"/)
  assert.doesNotMatch(writes[0], /\/old/)
  off()
})

await desk.close()

console.log("title bar")

/** A desk whose app's Chrome runs with `command`, counting the restarts it asks for. */
async function deskWithApp(command) {
  const lines = []
  const counts = { relaunches: 0 }
  const server = await createDeskServer({
    port: 0,
    supervise: false,
    logDir: path.join(tempHome, "logs"),
    log: (line) => lines.push(line),
    appChromeCommand: () => command,
    relaunch: () => {
      counts.relaunches += 1
    },
  })
  const connect = async (query) => {
    const s = await stream(server.port, query)
    await sleep(30)
    s.close()
  }
  return { server, lines, counts, connect }
}

await check("an app opened from the Dock is restarted once with the title-bar features", async () => {
  // No toggle for the overlay, and Extensions folded into the ⋮ menu.
  assert.match(APP_FEATURES, /^--enable-features=\S*DesktopPWAsWindowControlsOverlayWithNoToggle/)
  assert.match(APP_FEATURES, /DesktopPWAsElidedExtensionsMenu/)
  const chrome = "/Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/p --no-startup-window"
  const dock = await deskWithApp(chrome)
  try {
    await dock.connect("?window=tab")
    assert.equal(dock.counts.relaunches, 0, "a desk page in a browser tab restarted the app")
    await dock.connect("?window=app")
    assert.equal(dock.counts.relaunches, 1, "the app was not restarted")
    // Back without them: Chrome stopped passing them on, and a second restart would only blink the window.
    await dock.connect("?window=app")
    assert.equal(dock.counts.relaunches, 1, "the app was restarted a second time")
    assert.ok(dock.lines.some((line) => line.includes("leaving it as it is")), dock.lines.join("\n"))
  } finally {
    await dock.server.close()
  }
  const flagged = await deskWithApp(`${chrome} ${APP_FEATURES}`)
  try {
    await flagged.connect("?window=app")
    assert.equal(flagged.counts.relaunches, 0, "an app already running with the features was restarted")
  } finally {
    await flagged.server.close()
  }
  const closed = await deskWithApp(null)
  try {
    await closed.connect("?window=app")
    assert.equal(closed.counts.relaunches, 0, "the desk restarted an app that is not running")
  } finally {
    await closed.server.close()
  }
})

console.log("desk page")

/**
 * The page's own script, run in jsdom against a stubbed desk: the event stream
 * is a class that records its listener, so a case can hand the page a URL the
 * way the server would.
 */
await check("a handed-over page opens in a named frame, and the next one for that editor reuses its tab", async () => {
  const { JSDOM } = await import("jsdom")
  const { shellPage } = await import("../shell-page.mjs")
  const streams = []
  const dom = new JSDOM(shellPage({ repoRoot: "/r" }), {
    url: "http://127.0.0.1:3454/",
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = async (url) => ({
        json: async () =>
          String(url).includes("/api/editors")
            ? { editors: [{ name: "shop-web", url: "http://127.0.0.1:4100", pid: 7, projectRoot: "/p" }] }
            : { ok: true, startScreen: { ready: true, url: "http://127.0.0.1:3455" } },
      })
      // Anything but "browser" is an app window.
      window.matchMedia = () => ({ matches: false })
      // jsdom logs "not implemented" for it; the page calls it after a hand-off.
      window.focus = () => {}
      window.EventSource = class {
        constructor(url) {
          this.url = url
          this.listeners = {}
          streams.push(this)
        }
        addEventListener(type, listener) {
          this.listeners[type] = listener
        }
      }
    },
  })
  try {
    const doc = dom.window.document
    await sleep(30)
    assert.equal(streams.length, 1)
    assert.equal(streams[0].url, "/api/events?window=app")
    assert.ok(doc.querySelector(".tab.offer"), "the running editor should be offered before the hand-off")
    const hand = (url) => streams[0].listeners["open-url"]({ data: JSON.stringify({ id: 1, url }) })

    hand("http://127.0.0.1:4100/studio")
    const frame = [...doc.querySelectorAll("iframe")].find((f) => f.src === "http://127.0.0.1:4100/studio")
    assert.ok(frame, "no frame loaded the handed-over page")
    assert.match(frame.name, /^designlayer-desk:/, "the editor inside cannot tell it is in the app")
    assert.equal(frame.hidden, false, "the new tab is not the one showing")
    assert.equal(doc.querySelector('.tab[aria-selected="true"] .label').textContent, "shop-web")
    assert.equal(doc.querySelector(".tab.offer"), null, "the editor is still offered after it opened")
    const frames = doc.querySelectorAll("iframe").length

    hand("http://127.0.0.1:4100/settings")
    assert.equal(doc.querySelectorAll("iframe").length, frames, "the same editor got a second tab")
    assert.equal(frame.src, "http://127.0.0.1:4100/settings")
    const saved = JSON.parse(dom.window.localStorage.getItem("designlayer.desk.tabs.v1"))
    assert.equal(saved.tabs.find((t) => t.url === "http://127.0.0.1:4100").src, "http://127.0.0.1:4100/settings")
  } finally {
    dom.window.close()
  }
})

/*
 * The editor is a cross-origin frame in the app, so a key typed while focus is
 * in the shell — on the strip after a click on a tab, or after the frame
 * reloaded — never reaches it. ⌘. is how a hidden editor comes back, and it
 * did nothing until the page was clicked. test/shortcut-cases.mjs holds the
 * other half: what the editor does with the message.
 */
await check("⌘. typed in the shell is handed to the editor in the active tab, and the shell's own keys are not", async () => {
  const { JSDOM } = await import("jsdom")
  const { shellPage } = await import("../shell-page.mjs")
  const dom = new JSDOM(shellPage({ repoRoot: "/r" }), {
    url: "http://127.0.0.1:3454/",
    runScripts: "dangerously",
    beforeParse(window) {
      window.localStorage.setItem(
        "designlayer.desk.tabs.v1",
        JSON.stringify({
          tabs: [{ id: "h1", kind: "home" }, { id: "e1", kind: "editor", url: "http://127.0.0.1:4100", name: "shop-web" }],
          active: "e1",
        })
      )
      window.fetch = async (url) => ({
        json: async () =>
          String(url).includes("/api/editors")
            ? { editors: [{ name: "shop-web", url: "http://127.0.0.1:4100", pid: 7, projectRoot: "/p" }] }
            : { ok: true, startScreen: { ready: true, url: "http://127.0.0.1:3455" } },
      })
      window.matchMedia = () => ({ matches: false })
      window.EventSource = class {
        addEventListener() {}
      }
    },
  })
  try {
    const win = dom.window
    await sleep(30)
    const frame = win.document.querySelector('iframe[data-id="e1"]')
    assert.ok(frame, "the editor tab has no frame")
    const posted = []
    // Copied out of the page's realm, so a strict comparison sees plain objects.
    frame.contentWindow.postMessage = (message, origin) => posted.push([JSON.parse(JSON.stringify(message)), origin])
    const press = (init) => win.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))

    press({ key: ".", code: "Period", metaKey: true })
    assert.deepEqual(posted, [
      [
        { type: "designlayer-desk:key", key: ".", code: "Period", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
        "http://127.0.0.1:4100",
      ],
    ])
    const editorSide = fs.readFileSync(path.join(MAC, "..", "..", "src", "shell", "desk.ts"), "utf8")
    assert.match(editorSide, /DESK_KEY_MESSAGE = "designlayer-desk:key"/, "the editor listens for another message type")

    posted.length = 0
    press({ key: "." })
    assert.deepEqual(posted, [], "a bare key is not the editor's to be handed")
    press({ key: "1", code: "Digit1", metaKey: true })
    assert.deepEqual(posted, [], "⌘1 is the shell's own key and went to the editor too")
    assert.equal(win.document.querySelector('.tab[aria-selected="true"] .label').textContent, "Home")
    press({ key: ".", code: "Period", metaKey: true })
    assert.deepEqual(posted, [], "the Home tab is not an editor, and was handed a key")
  } finally {
    dom.window.close()
  }
})

console.log("the launcher's view of the desk")

await check("the label and the plist path have one definition", () => {
  assert.equal(LABEL, DESK_LABEL)
  assert.equal(plistPath("/Users/me"), deskPlistPath("/Users/me"))
})

await check("the launcher finds the desk by its plist and reads a non-default port out of it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-home-"))
  try {
    assert.equal(deskUrlFromHost({ home, platform: "darwin" }), null, "no plist, no desk")
    const agent = {
      nodePath: "/opt/homebrew/bin/node",
      serverPath: "/r/desktop/mac/desk-server.mjs",
      repoRoot: "/r",
      env: { HOME: home },
      logFile: "/r/desk.log",
    }
    fs.mkdirSync(path.dirname(deskPlistPath(home)), { recursive: true })
    fs.writeFileSync(deskPlistPath(home), buildPlist(agent))
    assert.equal(deskUrlFromHost({ home, platform: "darwin" }), `http://127.0.0.1:${DEFAULT_DESK_PORT}`)
    fs.writeFileSync(deskPlistPath(home), buildPlist({ ...agent, port: 4999 }))
    assert.equal(deskUrlFromHost({ home, platform: "darwin" }), "http://127.0.0.1:4999")
    assert.equal(deskUrlFromHost({ home, platform: "linux" }), null, "only a Mac has the app")
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

console.log("launch agent plist")

const plistInput = {
  nodePath: "/opt/homebrew/bin/node",
  serverPath: "/Users/me/designlayer/desktop/mac/desk-server.mjs",
  repoRoot: "/Users/me/designlayer",
  env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: "/Users/me", LANG: "en_US.UTF-8" },
  logFile: "/Users/me/Library/Logs/DesignLayer/desk.log",
}

await check("plist has the label, absolute program, env, logs and keep-alive policy", () => {
  const xml = buildPlist(plistInput)
  assert.equal(LABEL, "dev.designlayer.desk")
  assert.match(xml, /<key>Label<\/key>\s*<string>dev\.designlayer\.desk<\/string>/)
  assert.match(xml, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/me\/designlayer\/desktop\/mac\/desk-server\.mjs<\/string>\s*<\/array>/)
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/me\/designlayer<\/string>/)
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/)
  assert.match(xml, /<key>HOME<\/key>\s*<string>\/Users\/me<\/string>/)
  assert.match(xml, /<key>LANG<\/key>/)
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/me\/Library\/Logs\/DesignLayer\/desk\.log<\/string>/)
  assert.match(xml, /<key>StandardErrorPath<\/key>/)
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/)
  assert.match(xml, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/)
  assert.match(xml, /dev\.designlayer\.desk/)
})

await check("plist escapes XML and passes plutil -lint", () => {
  const xml = buildPlist({ ...plistInput, repoRoot: "/Users/me/R&D <x>" })
  assert.match(xml, /R&amp;D &lt;x&gt;/)
  const file = path.join(tempHome, "lint.plist")
  fs.writeFileSync(file, xml)
  const out = execFileSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" })
  assert.match(out, /OK/)
})

await check("plist refuses relative paths", () => {
  assert.throws(() => buildPlist({ ...plistInput, nodePath: "node" }), /absolute/)
})

console.log("installer")

await check("install.mjs --dry-run prints the plan and writes nothing", () => {
  const dryHome = fs.mkdtempSync(path.join(os.tmpdir(), "desk-dry-"))
  const out = execFileSync(process.execPath, [path.join(MAC, "install.mjs"), "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, HOME: dryHome },
  })
  assert.match(out, /\[1\/5\] Preflight/)
  assert.match(out, /dev\.designlayer\.desk/)
  assert.match(out, /PWA\.install/)
  assert.ok(out.includes(`--args ${APP_FEATURES}`), "the app would open without the title-bar features")
  assert.match(out, /Dry run: nothing was written/)
  const written = fs.readdirSync(dryHome, { recursive: true })
  assert.deepEqual(written, [], `dry run wrote: ${written.join(", ")}`)
  fs.rmSync(dryHome, { recursive: true, force: true })
})

await check("install.mjs --uninstall --dry-run against an empty home says nothing to do", () => {
  const dryHome = fs.mkdtempSync(path.join(os.tmpdir(), "desk-dry-"))
  const out = execFileSync(process.execPath, [path.join(MAC, "install.mjs"), "--uninstall", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, HOME: dryHome },
  })
  assert.match(out, /Nothing to uninstall/)
  fs.rmSync(dryHome, { recursive: true, force: true })
})

console.log("app profile")

const { quitProfileChrome } = await import("../chrome-pipe.mjs")
const { spawn } = await import("node:child_process")
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A stand-in for the app's Chrome: a live process whose command line names a profile. */
async function lockedProfile(namedDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-profile-"))
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${namedDir ?? dir}`], {
    stdio: "ignore",
  })
  fs.symlinkSync(`${os.hostname()}-${child.pid}`, path.join(dir, "SingletonLock"))
  await new Promise((resolve) => setTimeout(resolve, 300))
  return { dir, child }
}

await check("quitProfileChrome leaves a process alone when it names another profile", async () => {
  const { dir, child } = await lockedProfile("/somewhere/else")
  try {
    assert.equal(await quitProfileChrome(dir, 1000), false)
    assert.equal(alive(child.pid), true, "the unrelated process was signalled")
  } finally {
    child.kill("SIGKILL")
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check("profileChromeCommand reads the command line of the profile's owner, and of nothing else", async () => {
  const own = await lockedProfile()
  const other = await lockedProfile("/somewhere/else")
  try {
    assert.ok(profileChromeCommand(own.dir)?.includes(`--user-data-dir=${own.dir}`), "the owner's command line")
    assert.equal(profileChromeCommand(other.dir), null, "a lock whose process names another profile")
    assert.equal(profileChromeCommand(path.join(own.dir, "none")), null, "no lock at all")
  } finally {
    own.child.kill("SIGKILL")
    other.child.kill("SIGKILL")
    fs.rmSync(own.dir, { recursive: true, force: true })
    fs.rmSync(other.dir, { recursive: true, force: true })
  }
})

await check("the stable Chrome is found by name in either Applications folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-mac-apps-"))
  try {
    const apps = path.join(root, "Applications")
    const userApps = path.join(root, "home", "Applications")
    fs.mkdirSync(path.join(apps, "Acme Chrome Canary.app"), { recursive: true })
    fs.mkdirSync(path.join(apps, "Notes.app"))
    assert.equal(findMacChrome([apps, userApps]), "", "a Canary-only Mac was given a Chrome")
    fs.mkdirSync(path.join(userApps, "Acme Chrome.app"), { recursive: true })
    assert.equal(findMacChrome([apps, userApps]), path.join(userApps, "Acme Chrome.app", "Contents", "MacOS", "Acme Chrome"))
    fs.mkdirSync(path.join(apps, "Acme Chrome.app"))
    assert.equal(findMacChrome([apps, userApps]), path.join(apps, "Acme Chrome.app", "Contents", "MacOS", "Acme Chrome"), "/Applications comes first")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

await check("quitProfileChrome stops the process that owns this exact profile", async () => {
  const { dir, child } = await lockedProfile()
  try {
    assert.equal(await quitProfileChrome(dir, 3000), true)
    assert.equal(alive(child.pid), false)
  } finally {
    if (alive(child.pid)) child.kill("SIGKILL")
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// macOS 15+ refuses a quarantined, unsigned .command until the user clicks Open
// Anyway in Privacy & Security, and managed Macs warn on `curl | bash`. The page
// installs from a git clone, which has neither problem, and its steps must work:
// the clone's own `npm install` comes first, because npm installs no
// dependencies for a folder dependency and the prepare script needs esbuild.
await check("the get-started section installs from a clone, with no security prompt", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
  const pkg = fs.readFileSync(path.join(repo, "desktop", "mac", "package.mjs"), "utf8")
  const page = fs.readFileSync(path.join(repo, "landing", "index.html"), "utf8")
  const start = page.slice(page.indexOf('id="start"'), page.indexOf("</section>\n    </section>", page.indexOf('id="start"')))
  assert.doesNotMatch(page, /\|\s*(ba)?sh\b/, "the page pipes nothing into a shell")
  assert.doesNotMatch(page, /right-click/i, "the page must not send users to right-click > Open")
  assert.doesNotMatch(start, /\.zip|\.command/, "the section offers no quarantined download")
  const setup = "git clone https://github.com/phil8-li/design-layer.git\ncd design-layer &amp;&amp; npm install\n"
  assert.ok(start.includes(`<code>${setup}npx designlayer</code>`), "the browser card clones, installs, then starts")
  assert.ok(start.includes(`<code>${setup}node desktop/mac/install.mjs</code>`), "the Mac card clones, installs, then installs the app")
  assert.match(start, /Use it in your browser on top of your app\./)
  const readme = pkg.slice(pkg.indexOf("const README = `"), pkg.indexOf("`", pkg.indexOf("const README = `") + 16))
  assert.doesNotMatch(readme, /right-click|curl/i, "README.txt sends no one to right-click > Open or curl")
  assert.match(readme, /Open Anyway/, "README.txt names the Privacy & Security step for the zip")
  assert.doesNotMatch(pkg, /write\(`Uninstall/, "the zip's top folder has no uninstaller to double-click")
  assert.match(pkg, /cat "\$APP\/uninstall\.command" >"\$UNINSTALLER"/, "the installer writes the uninstaller as a new, unquarantined file")
})

process.env.HOME = realHome
fs.rmSync(tempHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
