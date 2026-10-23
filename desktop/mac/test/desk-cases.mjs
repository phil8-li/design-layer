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
const { GLYPHS, isDeskTitle } = await import("../shell-page.mjs")
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
const openedWindows = []
const stateDir = path.join(tempHome, "state")
const desk = await createDeskServer({
  port: 0,
  supervise: false,
  logDir: path.join(tempHome, "logs"),
  stateDir,
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
  // Records instead of starting Chrome.
  openWindow: (url) => {
    openedWindows.push(url)
    return { ok: true }
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
  // Phil had the green dot and editor count taken out of the title bar.
  assert.doesNotMatch(html, /id="status"/)
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
      // On localhost, the host name editors are opened on, whichever spelling
      // the registry entry used.
      { name: "demo-app", url: "http://localhost:4100", projectRoot: "/tmp/demo-app", pid: process.pid, alive: true },
      { name: "no-name", url: "http://localhost:4200", projectRoot: "/tmp/no-name", pid: process.pid, alive: true },
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

await check("the desk keeps a copy of the window's tabs, written only by the desk page on either host name", async () => {
  const empty = await request(port, { pathname: "/api/tabs" })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json, {})
  const tabs = { tabs: [{ id: "h1", kind: "home" }, { id: "a", kind: "editor", url: "http://localhost:4101", junk: 1 }], active: "a", dismissed: [] }
  const put = (body, origin) =>
    request(port, { method: "PUT", pathname: "/api/tabs", headers: origin ? { origin } : {}, body: JSON.stringify(body) })
  assert.equal((await put(tabs, "http://localhost:4101")).status, 403, "an editor rewrote the window's tabs")
  assert.equal((await put({ nope: 1 }, `http://localhost:${port}`)).status, 400)
  assert.equal((await put(tabs, `http://127.0.0.1:${port}`)).status, 200, "the page on its old origin could not save")
  assert.equal((await put(tabs, `http://localhost:${port}`)).status, 200)
  const back = (await request(port, { pathname: "/api/tabs" })).json
  assert.deepEqual(back.tabs.map((t) => t.id), ["h1", "a"])
  assert.equal(back.tabs[1].junk, undefined)
  assert.equal(back.active, "a")
  // In the app's own folder, not in a project.
  assert.ok(fs.existsSync(path.join(stateDir, "desk-tabs.json")))
})

await check("the desk keeps the names given to apps' tabs, written only by the desk page", async () => {
  const put = (body, origin = `http://localhost:${port}`) =>
    request(port, { method: "PUT", pathname: "/api/names", headers: { origin }, body: JSON.stringify(body) })
  assert.deepEqual((await request(port, { pathname: "/api/names" })).json, { names: {} })
  assert.equal((await put({ app: "/p/shop", name: "Checkout" }, "http://localhost:4101")).status, 403, "an editor renamed a tab")
  assert.equal((await put({ name: "No app" })).status, 400)
  assert.deepEqual((await put({ app: "/p/shop", name: "  Checkout v2  " })).json, { names: { "/p/shop": "Checkout v2" } })
  assert.equal((await put({ app: "/p/docs", name: "x".repeat(200) })).json.names["/p/docs"].length, 80)
  // An empty name gives the tab back its folder's name.
  assert.deepEqual((await put({ app: "/p/docs", name: "" })).json, { names: { "/p/shop": "Checkout v2" } })
  assert.deepEqual((await request(port, { pathname: "/api/names" })).json, { names: { "/p/shop": "Checkout v2" } })
  assert.ok(fs.existsSync(path.join(stateDir, "desk-names.json")))
  await put({ app: "/p/shop", name: "" })
})

await check("the desk keeps each window's tabs apart, forgets a window that is gone, and lists them all", async () => {
  const put = (body) => request(port, { method: "PUT", pathname: "/api/tabs", headers: { origin: `http://localhost:${port}` }, body: JSON.stringify(body) })
  assert.equal((await put({ window: "wab12", tabs: [{ id: "x", kind: "home" }], active: "x", savedAt: 5, closedAt: 9 })).status, 200)
  assert.equal((await put({ window: "../evil", tabs: [] })).status, 400, "a window id that is not one was saved")
  const one = (await request(port, { pathname: "/api/tabs?window=wab12" })).json
  assert.deepEqual(one.tabs.map((t) => t.id), ["x"])
  assert.equal(one.closedAt, 9)
  // The main window's copy is still the one the bare route answers with.
  assert.deepEqual((await request(port, { pathname: "/api/tabs" })).json.tabs.map((t) => t.id), ["h1", "a"])
  assert.deepEqual(Object.keys((await request(port, { pathname: "/api/tabs?all=1" })).json.windows).sort(), ["main", "wab12"])
  // A save that arrives after a newer one is dropped.
  assert.equal((await put({ window: "wab12", tabs: [{ id: "old", kind: "home" }], active: "old", savedAt: 4 })).status, 200)
  assert.deepEqual((await request(port, { pathname: "/api/tabs?window=wab12" })).json.tabs.map((t) => t.id), ["x"])
  assert.equal((await put({ window: "wab12", gone: true, savedAt: 20 })).status, 200)
  assert.deepEqual((await request(port, { pathname: "/api/tabs?window=wab12" })).json, {})
  assert.deepEqual(Object.keys((await request(port, { pathname: "/api/tabs?all=1" })).json.windows), ["main"])
  // The list says when the window went, for a page that still holds a copy of it.
  assert.deepEqual((await request(port, { pathname: "/api/tabs?all=1" })).json.gone, { wab12: 20 })
  // Found in the real app: a window's last save landed after the note that it
  // was gone, and the window came back on the next launch.
  assert.equal((await put({ window: "wab12", tabs: [{ id: "x", kind: "home" }], active: "x", savedAt: 19 })).status, 200)
  assert.deepEqual(Object.keys((await request(port, { pathname: "/api/tabs?all=1" })).json.windows), ["main"], "a late save brought a closed window back")
  // A newer window on the same id is a window again.
  assert.equal((await put({ window: "wab12", tabs: [{ id: "y", kind: "home" }], active: "y", savedAt: 30 })).status, 200)
  assert.deepEqual((await request(port, { pathname: "/api/tabs?window=wab12" })).json.tabs.map((t) => t.id), ["y"])
  await put({ window: "wab12", gone: true, savedAt: 31 })
})

await check("a file from before there were several windows is the main window's", async () => {
  const file = path.join(stateDir, "desk-tabs.json")
  const was = fs.readFileSync(file, "utf8")
  try {
    fs.writeFileSync(file, JSON.stringify({ tabs: [{ id: "old", kind: "home" }], active: "old" }))
    assert.deepEqual((await request(port, { pathname: "/api/tabs" })).json.tabs.map((t) => t.id), ["old"])
    assert.deepEqual(Object.keys((await request(port, { pathname: "/api/tabs?all=1" })).json.windows), ["main"])
  } finally {
    fs.writeFileSync(file, was)
  }
})

await check("the desk page, and only the desk page, can ask the desk to open a saved window", async () => {
  const open = (body, origin) =>
    request(port, { method: "POST", pathname: "/api/windows/open", headers: origin ? { origin } : {}, body: JSON.stringify(body) })
  assert.equal((await open({ window: "wab12" }, "http://localhost:4101")).status, 403)
  assert.equal((await open({ window: "javascript:alert(1)" }, `http://localhost:${port}`)).status, 400)
  assert.deepEqual(openedWindows, [])
  const res = await open({ window: "wab12" }, `http://localhost:${port}`)
  assert.equal(res.status, 200)
  assert.deepEqual(openedWindows, [`http://localhost:${port}/?window=wab12`])
})

await check("the desk answers on localhost and hands out a localhost address", async () => {
  assert.equal(desk.url, `http://localhost:${port}`)
  const res = await request(port, { pathname: "/api/health", headers: { host: `localhost:${port}` } })
  assert.equal(res.status, 200)
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
  // One spelling of this machine: localhost, which apps treat as their dev host.
  assert.equal(res.json.url, "http://localhost:3466/studio?tab=agents")
  // The window is on localhost, the site of the editors it frames.
  assert.deepEqual(activations, [{ deskUrl: `http://localhost:${port}`, listening: 0 }])
  const first = await stream(port, "?window=app")
  await until(() => first.events.length === 1)
  assert.equal(first.events[0].event, "open-url")
  assert.equal(first.events[0].data.url, "http://localhost:3466/studio?tab=agents")
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
  assert.equal(window.events[0].data.url, "http://localhost:3466/studio")
  // Raising is the default, and it is told a window is already listening.
  await post({ url: `${EDITOR}/other` })
  assert.deepEqual(activations.at(-1), { deskUrl: `http://localhost:${port}`, listening: 1 })
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

// The start screen runs an editor per app; `editing` names only the latest.
await check("health lists every editor the start screen runs, and keeps editing", async () => {
  const running = [
    { id: "a", state: "ready", name: "shop", appUrl: "http://localhost:5173", appPort: 5173, projectRoot: "/p/shop", packageName: "web", url: "http://localhost:3456/cart" },
    { id: "b", state: "starting", name: "docs", appUrl: "http://localhost:5174", appPort: 5174, projectRoot: "/p/docs", packageName: "web", url: null },
  ]
  const screen = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ready: false, url: null, editing: null, stopped: null, editors: running }))
  })
  await new Promise((resolve) => screen.listen(0, "127.0.0.1", resolve))
  const supervised = await createDeskServer({
    port: 0,
    startScreenPort: screen.address().port,
    logDir: path.join(tempHome, "logs"),
    log: () => {},
    activate: () => true,
  })
  try {
    const res = await request(supervised.port, { pathname: "/api/health" })
    assert.equal(res.json.startScreen.ready, true)
    assert.deepEqual(res.json.startScreen.editors, running)
    assert.equal(res.json.startScreen.editing, null, "the most recent choice is still starting")
  } finally {
    await supervised.close()
    await new Promise((resolve) => screen.close(resolve))
  }
})

// The start screen owns the update (runtime/updater.mjs); the desk relays it
// so the title bar can offer it while no Home tab is open.
await check("health relays the start screen's update status, and the commit the desk runs", async () => {
  const update = { state: "available", behind: 3, changes: [] }
  const screen = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json")
    if (req.url === "/api/update") return res.end(JSON.stringify(update))
    res.end(JSON.stringify({ ready: false, url: null, editing: null, stopped: null, editors: [] }))
  })
  await new Promise((resolve) => screen.listen(0, "127.0.0.1", resolve))
  const supervised = await createDeskServer({ port: 0, startScreenPort: screen.address().port, logDir: path.join(tempHome, "logs"), log: () => {} })
  try {
    const res = await request(supervised.port, { pathname: "/api/health" })
    assert.deepEqual(res.json.startScreen.update, update)
    assert.match(res.json.version, /^[0-9a-f]{40}$/, "the desk runs from this checkout, so it knows its commit")
    const page = await request(supervised.port, { pathname: "/" })
    assert.ok(page.body.toString("utf8").includes(`const VERSION = "${res.json.version}"`), "the window knows which commit served it")
  } finally {
    await supervised.close()
    await new Promise((resolve) => screen.close(resolve))
  }
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
    assert.equal(doc.querySelectorAll(".tab").length, 1, "the running editor had a tab before it was handed over")
    const hand = (url) => streams[0].listeners["open-url"]({ data: JSON.stringify({ id: 1, url }) })

    hand("http://127.0.0.1:4100/studio")
    // Framed on localhost, whichever spelling the page was handed with.
    const frame = [...doc.querySelectorAll("iframe")].find((f) => f.src === "http://localhost:4100/studio")
    assert.ok(frame, "no frame loaded the handed-over page")
    assert.match(frame.name, /^designlayer-desk:/, "the editor inside cannot tell it is in the app")
    assert.equal(frame.hidden, false, "the new tab is not the one showing")
    assert.equal(doc.querySelector('.tab[aria-selected="true"] .label').textContent, "shop-web")
    const frames = doc.querySelectorAll("iframe").length

    hand("http://127.0.0.1:4100/settings")
    assert.equal(doc.querySelectorAll("iframe").length, frames, "the same editor got a second tab")
    assert.equal(frame.src, "http://localhost:4100/settings")
    const saved = JSON.parse(dom.window.localStorage.getItem("designlayer.desk.tabs.v1"))
    assert.equal(saved.tabs.find((t) => t.url === "http://localhost:4100").src, "http://localhost:4100/settings")
  } finally {
    dom.window.close()
  }
})

// The strip used to add a dashed tab for each running editor with no tab.
// Phil had them removed: Home lists every running editor, and the strip shows
// only the tabs a person opened.
await check("a running editor with no tab gets no tab, dashed or otherwise, and no frame", async () => {
  const { JSDOM } = await import("jsdom")
  const { shellPage } = await import("../shell-page.mjs")
  const dom = new JSDOM(shellPage({ repoRoot: "/r" }), {
    url: "http://127.0.0.1:3454/",
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = async (url) => ({
        json: async () =>
          String(url).includes("/api/editors")
            ? { editors: [{ name: "shop-web", url: "http://127.0.0.1:4100", page: "/#/cart?step=2", pid: 7, projectRoot: "/p" }] }
            : { ok: true, startScreen: { ready: true, url: "http://127.0.0.1:3455" } },
      })
      window.matchMedia = () => ({ matches: false })
      window.EventSource = class {
        addEventListener() {}
      }
    },
  })
  try {
    const doc = dom.window.document
    await sleep(30)
    assert.deepEqual([...doc.querySelectorAll("#tabs > *")].map((node) => node.textContent.replace(/⌘\d/, "")), ["Home"])
    assert.ok(![...doc.querySelectorAll("iframe")].some((f) => f.src.includes("4100")), "the running editor was loaded unasked")
  } finally {
    dom.window.close()
  }
})

// A switch made in one tab starts a new editor on the same port. Another tab
// on that port still showed the app just left, or a refused connection.
await check("a background tab on a restarted editor loads the new app's page when opened", async () => {
  const { JSDOM } = await import("jsdom")
  const { shellPage } = await import("../shell-page.mjs")
  const dom = new JSDOM(shellPage({ repoRoot: "/r" }), {
    url: "http://127.0.0.1:3454/",
    runScripts: "dangerously",
    beforeParse(window) {
      window.localStorage.setItem(
        "designlayer.desk.tabs.v1",
        JSON.stringify({
          tabs: [{ id: "h1", kind: "home" }, { id: "e1", kind: "editor", url: "http://127.0.0.1:4100", name: "old", key: "http://localhost:4100#6" }],
          active: "h1",
        })
      )
      window.fetch = async (url) => ({
        json: async () =>
          String(url).includes("/api/editors")
            ? { editors: [{ name: "pinned", url: "http://localhost:4100", page: "/#/agents/a1", pid: 7, projectRoot: "/p/pinned" }] }
            : { ok: true, startScreen: { ready: true, url: "http://127.0.0.1:3455" } },
      })
      window.matchMedia = () => ({ matches: false })
      window.EventSource = class {
        addEventListener() {}
      }
    },
  })
  try {
    await sleep(30)
    const frame = dom.window.document.querySelector('iframe[data-id="e1"]')
    // Emptied while hidden: loading it would take the editor's one socket
    // from the tab in use.
    assert.equal(frame.src, "about:blank")
    const tab = dom.window.document.querySelectorAll(".tab")[1]
    assert.equal(tab.querySelector(".label").textContent, "pinned")
    tab.click()
    assert.equal(frame.src, "http://localhost:4100/#/agents/a1")
  } finally {
    dom.window.close()
  }
})

// A tab saved on the editor's bare root reopens on its app's last page: the
// root is the home page every copy of a template shares.
await check("a tab reopens on its app's last page, over the page saved with it", async () => {
  const { JSDOM } = await import("jsdom")
  const { shellPage } = await import("../shell-page.mjs")
  const dom = new JSDOM(shellPage({ repoRoot: "/r" }), {
    url: "http://127.0.0.1:3454/",
    runScripts: "dangerously",
    beforeParse(window) {
      window.localStorage.setItem(
        "designlayer.desk.tabs.v1",
        JSON.stringify({
          // Saved on another app's page by a window that quit before its storage
          // caught up.
          tabs: [{ id: "e1", kind: "editor", url: "http://localhost:4100", src: "http://localhost:4100/#/models", name: "vision", key: "http://localhost:4100#7" }],
          active: "e1",
        })
      )
      window.fetch = async (url) => ({
        json: async () =>
          String(url).includes("/api/editors")
            ? { editors: [{ name: "pinned", url: "http://localhost:4100", page: "/#/agents/a1", pid: 7, projectRoot: "/p/pinned" }] }
            : { ok: true, startScreen: { ready: true, url: "http://127.0.0.1:3455" } },
      })
      window.matchMedia = () => ({ matches: false })
      window.EventSource = class {
        addEventListener() {}
      }
    },
  })
  try {
    await sleep(30)
    assert.equal(dom.window.document.querySelector('iframe[data-id="e1"]').src, "http://localhost:4100/#/agents/a1")
    // The first list only: later lists leave a tab the person moved alone.
    const saved = JSON.parse(dom.window.localStorage.getItem("designlayer.desk.tabs.v1"))
    assert.equal(saved.tabs[0].src, "http://localhost:4100/#/agents/a1")
  } finally {
    dom.window.close()
  }
})

/*
 * The frame says which app it shows. A Home tab that started an editor used to
 * keep the name "Home" whenever the window lacked focus or another tab was on
 * the same editor, and an editor tab kept the name of the app before a switch.
 */
await check("a tab is named by the app its frame says it shows", async () => {
  const { JSDOM } = await import("jsdom")
  const { shellPage } = await import("../shell-page.mjs")
  const dom = new JSDOM(shellPage({ repoRoot: "/r" }), {
    url: "http://127.0.0.1:3454/",
    runScripts: "dangerously",
    beforeParse(window) {
      window.localStorage.setItem(
        "designlayer.desk.tabs.v1",
        JSON.stringify({
          tabs: [
            { id: "h1", kind: "home" },
            { id: "e1", kind: "editor", url: "http://localhost:4100", name: "old-app", key: "http://localhost:4100#7" },
          ],
          active: "h1",
        })
      )
      window.fetch = async (url) => ({
        json: async () =>
          String(url).includes("/api/editors")
            ? { editors: [{ name: "pinned", url: "http://localhost:4100", pid: 7, projectRoot: "/p/pinned" }] }
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
    const say = (id, data, origin = "http://localhost:4100") =>
      win.dispatchEvent(
        new win.MessageEvent("message", {
          data: { type: "designlayer-desk:showing", ...data },
          origin,
          source: win.document.querySelector(`iframe[data-id="${id}"]`).contentWindow,
        })
      )
    // The Home tab pressed Start: it is now that editor's tab, under the app's
    // name, on the page it shows, and the older tab on the same editor is gone.
    say("h1", { name: "pinned", page: "/#/agents/a1" })
    const labels = () => [...win.document.querySelectorAll(".tab .label")].map((node) => node.textContent)
    assert.deepEqual(labels(), ["pinned"])
    const saved = JSON.parse(win.localStorage.getItem("designlayer.desk.tabs.v1"))
    assert.deepEqual(
      saved.tabs.map(({ id, kind, url, src, name }) => ({ id, kind, url, src, name })),
      [{ id: "h1", kind: "editor", url: "http://localhost:4100", src: "http://localhost:4100/#/agents/a1", name: "pinned" }]
    )
    assert.equal(win.document.title, "pinned — DesignLayer")

    // A switch made inside the frame renames the tab.
    say("h1", { name: "docs", page: "/guide" })
    assert.deepEqual(labels(), ["docs"])

    // A message from anywhere but this machine, or from no tab's frame, is ignored.
    say("h1", { name: "evil", page: "/" }, "https://example.test")
    assert.deepEqual(labels(), ["docs"])
    win.dispatchEvent(new win.MessageEvent("message", { data: { type: "designlayer-desk:showing", name: "stray", page: "/" }, origin: "http://localhost:4100" }))
    assert.deepEqual(labels(), ["docs"])
  } finally {
    dom.window.close()
  }
})

/**
 * The desk page with an editor per app, each on its own port. `lists` are the
 * editor lists the desk answers, one per poll, the last repeating; null is a
 * desk that refuses the connection, "hang" one that never answers. The page
 * polls when a case calls poll(), not on its 2 s timer. `remote` is the copy
 * of the tabs the desk keeps (GET /api/tabs), and `puts` what the page saved
 * there. `url` is the desk page's own address: localhost since the window
 * moved there, 127.0.0.1 for a window installed before.
 */
async function multiDesk({ tabs, active, lists, remote, url: pageUrl = "http://127.0.0.1:3454/", setup, version = null, health = () => ({}) }) {
  const { JSDOM, VirtualConsole } = await import("jsdom")
  const { shellPage } = await import("../shell-page.mjs")
  // jsdom cannot navigate, and says so: each reload the page asks for lands here.
  const navigations = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on("jsdomError", (error) => {
    if (error.type === "not-implemented" && /navigation/i.test(error.message)) navigations.push(error.message)
    else console.error(error.message)
  })
  let polls = 0
  let poller = null
  const streams = []
  const puts = []
  const dom = new JSDOM(shellPage({ repoRoot: "/r", version }), {
    url: pageUrl,
    runScripts: "dangerously",
    virtualConsole,
    beforeParse(window) {
      if (tabs) window.localStorage.setItem("designlayer.desk.tabs.v1", JSON.stringify({ tabs, active }))
      setup?.(window)
      window.fetch = async (url, init) => {
        const list = lists[Math.min(polls, lists.length - 1)]
        if (String(url).includes("/api/tabs")) {
          if (init?.method === "PUT") {
            puts.push(JSON.parse(init.body))
            return { json: async () => ({}) }
          }
          if (list === null) throw new Error("connection refused")
          return { json: async () => remote ?? {} }
        }
        // The page asks for health and then the list in one turn: one poll.
        if (String(url).includes("/api/editors")) polls += 1
        if (list === null) throw new Error("connection refused")
        if (list === "hang") return new Promise(() => {})
        return {
          json: async () =>
            String(url).includes("/api/editors")
              ? { editors: list }
              : { ok: true, ...health(), startScreen: { ready: true, url: "http://127.0.0.1:3455", ...health().startScreen } },
        }
      }
      const every = window.setInterval.bind(window)
      window.setInterval = (fn, ms) => (ms === 2000 ? ((poller = fn), 0) : every(fn, ms))
      window.matchMedia = () => ({ matches: false })
      window.EventSource = class {
        constructor() {
          streams.push(this)
        }
        addEventListener(type, fn) {
          this[type] = fn
        }
      }
    },
  })
  const win = dom.window
  const doc = win.document
  await sleep(30)
  const frame = (id) => doc.querySelector(`iframe[data-id="${id}"]`)
  return {
    win,
    doc,
    frame,
    navigations,
    srcs: () => Object.fromEntries([...doc.querySelectorAll("iframe")].map((f) => [f.dataset.id, f.src])),
    labels: () => [...doc.querySelectorAll(".tab[data-id] .label")].map((node) => node.textContent),
    selected: () => doc.querySelector('.tab[aria-selected="true"] .label').textContent,
    saved: () => JSON.parse(win.localStorage.getItem("designlayer.desk.tabs.v1")),
    puts,
    booting: () => !doc.getElementById("boot").hidden,
    async poll() {
      poller()
      await sleep(10)
    },
    say(id, data, origin) {
      win.dispatchEvent(new win.MessageEvent("message", { data, origin, source: id ? frame(id).contentWindow : null }))
    },
    hand: (url) => streams[0]["open-url"]({ data: JSON.stringify({ id: 1, url }) }),
    press: (init) => win.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, metaKey: true, ...init })),
    close: () => win.close(),
  }
}

const SHOP = { name: "shop", url: "http://localhost:4101", pid: 1, projectRoot: "/p/shop" }
const DOCS = { name: "docs", url: "http://localhost:4102", pid: 2, projectRoot: "/p/docs" }
const STUDIO = { name: "studio", url: "http://localhost:4103", pid: 3, projectRoot: "/p/studio" }
const tabOn = (id, e, extra = {}) => ({ id, kind: "editor", url: e.url, name: e.name, key: `${e.url}#${e.pid}`, ...extra })

/*
 * Every app has its own editor, so a frame that chose an app is shown that
 * app's tab. Navigating itself instead left the editor it showed with no tab,
 * or put a second tab on an editor whose socket takes one client.
 */
await check("go from a Home tab: an app with a tab is selected and the Home tab closes, one without loads in the Home tab", async () => {
  const d = await multiDesk({
    tabs: [{ id: "h1", kind: "home" }, tabOn("a", SHOP), tabOn("b", DOCS), { id: "h2", kind: "home" }],
    active: "h1",
    lists: [[SHOP, DOCS, STUDIO]],
    url: "http://localhost:3454/",
  })
  try {
    // The start screen is framed on localhost like the page, whatever address
    // the desk reaches it on: one site, so its cookies and storage are its own.
    assert.equal(d.frame("h1").src, "http://localhost:3455/")
    // studio runs too, and gets no tab until it is asked for.
    assert.deepEqual(d.labels(), ["Home", "shop", "docs", "Home"])
    const before = d.srcs()
    d.say("h1", { type: "designlayer-desk:go", url: "http://localhost:4102/guide" }, "http://localhost:3455")
    assert.equal(d.selected(), "docs")
    assert.deepEqual(d.labels(), ["shop", "docs", "Home"])
    assert.deepEqual(d.srcs(), { a: before.a, b: before.b, h2: before.h2 }, "a tab was reloaded")

    // The old spelling of the start screen is the same sender.
    d.say("h2", { type: "designlayer-desk:go", url: "http://127.0.0.1:4103/#/canvas" }, "http://127.0.0.1:3455")
    assert.equal(d.selected(), "studio")
    assert.deepEqual(d.labels(), ["shop", "docs", "studio"])
    assert.deepEqual(d.srcs(), { a: before.a, b: before.b, h2: "http://localhost:4103/#/canvas" })
    assert.equal(d.saved().tabs[2].url, "http://localhost:4103")
  } finally {
    d.close()
  }
})

/*
 * Found in the real app: a tab whose editor had stopped still showed the
 * refused connection, and the Home tab's go selected it before the next list
 * said the port was back. The tab stayed on the error page.
 */
await check("go onto a stopped editor's tab loads the page it was sent, even before the next list", async () => {
  const d = await multiDesk({
    tabs: [tabOn("a", SHOP), tabOn("b", DOCS, { src: "http://localhost:4102/old" }), { id: "h1", kind: "home" }],
    active: "h1",
    // The list still names only shop: docs stopped and its new editor is not listed yet.
    lists: [[SHOP]],
    url: "http://localhost:3454/",
  })
  try {
    const before = d.srcs()
    d.say("h1", { type: "designlayer-desk:go", url: "http://localhost:4102/#/guide" }, "http://localhost:3455")
    assert.equal(d.selected(), "docs")
    assert.equal(d.frame("b").src, "http://localhost:4102/#/guide", "the stopped tab kept its error page")
    assert.equal(d.frame("a").src, before.a, "a live tab was reloaded")
    assert.deepEqual(d.labels(), ["shop", "docs"])

    // A tab already on the running editor is selected as it is.
    const live = await multiDesk({
      tabs: [tabOn("a", SHOP), tabOn("b", DOCS, { src: "http://localhost:4102/old" }), { id: "h1", kind: "home" }],
      active: "h1",
      lists: [[SHOP, DOCS]],
      url: "http://localhost:3454/",
    })
    try {
      const was = live.srcs().b
      live.say("h1", { type: "designlayer-desk:go", url: "http://localhost:4102/#/guide" }, "http://localhost:3455")
      assert.equal(live.selected(), "docs")
      assert.equal(live.frame("b").src, was, "a live tab was reloaded")
    } finally {
      live.close()
    }
  } finally {
    d.close()
  }
})

// An editor tab replaced by another editor lost its unapplied edits, and its
// own editor came back only as an offer.
await check("go from an editor tab never replaces its editor: an app with a tab is selected, one without opens beside it", async () => {
  const d = await multiDesk({
    tabs: [tabOn("a", SHOP), tabOn("b", DOCS)],
    active: "a",
    lists: [[SHOP, DOCS]],
  })
  try {
    const before = d.srcs()
    d.say("a", { type: "designlayer-desk:go", url: "http://localhost:4102/guide" }, "http://localhost:4101")
    assert.equal(d.selected(), "docs")
    assert.deepEqual(d.srcs(), before, "a tab was reloaded")

    // One the list does not name yet: a new tab, drawn new rather than stopped.
    d.say("a", { type: "designlayer-desk:go", url: "http://127.0.0.1:4104/" }, "http://localhost:4101")
    assert.deepEqual(d.labels(), ["shop", "localhost:4104", "docs"])
    assert.equal(d.selected(), "localhost:4104")
    assert.equal(d.frame("a").src, before.a, "the asking editor was navigated away")
    assert.ok(Object.values(d.srcs()).includes("http://localhost:4104/"), "the new tab has no frame on the page")
    assert.equal(d.doc.querySelectorAll(".tab")[1].classList.contains("dead"), false, "a tab not yet listed is drawn stopped")
    await d.poll()
    assert.ok(d.labels().includes("shop"), "the asking editor lost its tab")

    const settled = JSON.stringify([d.srcs(), d.labels(), d.selected()])
    d.say(null, { type: "designlayer-desk:go", url: "http://localhost:4101/" }, "http://localhost:4102")
    d.say("b", { type: "designlayer-desk:go", url: "http://localhost:4101/" }, "https://example.test")
    d.say("b", { type: "designlayer-desk:go", url: "https://example.test/" }, "http://localhost:4102")
    d.say("b", { type: "designlayer-desk:go", url: "javascript:alert(1)" }, "http://localhost:4102")
    d.say("b", { type: "designlayer-desk:go", url: "http://127.0.0.1:3454/" }, "http://localhost:4102")
    d.say("b", { type: "designlayer-desk:go", url: "http://localhost:3454/" }, "http://localhost:4102")
    d.say("b", { type: "designlayer-desk:go", url: "http://localhost:3455/" }, "http://localhost:4102")
    // The start screen speaks only from a Home tab.
    d.say("b", { type: "designlayer-desk:go", url: "http://localhost:4101/" }, "http://localhost:3455")
    assert.equal(JSON.stringify([d.srcs(), d.labels(), d.selected()]), settled, "a refused go changed the tabs")
  } finally {
    d.close()
  }
})

await check("a Home tab that pressed Start becomes that editor's tab, and tabs on other editors are untouched", async () => {
  const d = await multiDesk({
    tabs: [tabOn("a", SHOP), { id: "h1", kind: "home" }, tabOn("b", DOCS), tabOn("c", STUDIO)],
    active: "h1",
    lists: [[SHOP, DOCS, STUDIO]],
  })
  try {
    const before = d.srcs()
    d.say("h1", { type: "designlayer-desk:showing", name: "studio", page: "/#/canvas" }, "http://localhost:4103")
    // Only the older tab on the same editor merges away.
    assert.deepEqual(d.labels(), ["shop", "studio", "docs"])
    assert.deepEqual(d.srcs(), { a: before.a, h1: before.h1, b: before.b })
    assert.equal(d.selected(), "studio")
  } finally {
    d.close()
  }
})

// The tab kept the key of the editor it left, so the next list took the new
// editor for a restart of that one and emptied the tab once it was hidden.
await check("a tab that moved to another editor is not emptied by the next list", async () => {
  const d = await multiDesk({
    tabs: [{ id: "h1", kind: "home" }, tabOn("a", SHOP)],
    active: "a",
    lists: [[SHOP], [SHOP, DOCS]],
  })
  try {
    d.say("a", { type: "designlayer-desk:showing", name: "docs", page: "/guide" }, "http://localhost:4102")
    d.doc.querySelectorAll(".tab")[0].click()
    await d.poll()
    assert.notEqual(d.frame("a").src, "about:blank")
    assert.deepEqual(d.labels(), ["Home", "docs"])
  } finally {
    d.close()
  }
})

// A desk still coming up answers nothing; the first list that does arrive is
// the one that moves each saved tab to its app's last page.
await check("the first editor list that arrives moves every saved tab to its own app's last page", async () => {
  const d = await multiDesk({
    tabs: [tabOn("a", SHOP, { src: "http://localhost:4101/" }), tabOn("b", DOCS, { src: "http://127.0.0.1:4102/old" })],
    active: "a",
    lists: [null, [{ ...SHOP, page: "/#/cart" }, { ...DOCS, page: "/guide" }, STUDIO]],
  })
  try {
    assert.deepEqual(d.srcs(), { a: "http://localhost:4101/", b: "http://localhost:4102/old" })
    await d.poll()
    assert.deepEqual(d.srcs(), { a: "http://localhost:4101/#/cart", b: "http://localhost:4102/guide" })
  } finally {
    d.close()
  }
})

// The first render loaded each saved page, and the first list then loaded the
// app's last page in the same frame.
await check("each saved editor tab loads once as the window opens, on its app's last page", async () => {
  const loads = []
  const d = await multiDesk({
    tabs: [{ id: "h1", kind: "home" }, tabOn("a", SHOP, { src: "http://localhost:4101/" }), tabOn("b", DOCS)],
    active: "a",
    lists: [[{ ...SHOP, page: "/#/cart" }, { ...DOCS, page: "/guide" }]],
    setup(window) {
      const proto = window.HTMLIFrameElement.prototype
      const src = Object.getOwnPropertyDescriptor(proto, "src")
      Object.defineProperty(proto, "src", {
        configurable: true,
        get: src.get,
        set(value) {
          loads.push([this.dataset.id, value])
          src.set.call(this, value)
        },
      })
    },
  })
  try {
    assert.deepEqual(
      loads.filter(([id]) => id !== "h1"),
      [["a", "http://localhost:4101/#/cart"], ["b", "http://localhost:4102/guide"]]
    )
  } finally {
    d.close()
  }
})

await check("a desk that never answers holds the saved editor tabs back 1.5 s, then loads their saved pages", async () => {
  const d = await multiDesk({
    tabs: [tabOn("a", SHOP, { src: "http://localhost:4101/cart" })],
    active: "a",
    lists: ["hang"],
  })
  try {
    assert.deepEqual(d.srcs(), {})
    assert.equal(d.booting(), true, "an empty window with no word of what it waits for")
    await sleep(1600)
    assert.deepEqual(d.srcs(), { a: "http://localhost:4101/cart" })
    assert.equal(d.booting(), false)
  } finally {
    d.close()
  }
})

// The window moved from 127.0.0.1 to localhost, and storage belongs to an
// origin: without the desk's copy the new window opened with one Home tab.
await check("saved tabs survive the move to localhost: the old page mirrors them, the new one restores them once", async () => {
  const old = await multiDesk({
    tabs: [{ id: "h1", kind: "home" }, tabOn("a", SHOP, { src: "http://127.0.0.1:4101/old" })],
    active: "a",
    lists: [[SHOP]],
  })
  let copy
  try {
    assert.ok(old.puts.length >= 1, "the old page kept its tabs to itself")
    copy = old.puts.at(-1)
    assert.deepEqual(copy.tabs.map((t) => t.id), ["h1", "a"])
    assert.equal(copy.active, "a")
  } finally {
    old.close()
  }

  const fresh = await multiDesk({ lists: [[{ ...SHOP, page: "/#/cart" }]], remote: copy, url: "http://localhost:3454/" })
  try {
    assert.deepEqual(fresh.labels(), ["Home", "shop"])
    assert.equal(fresh.selected(), "shop")
    assert.equal(fresh.frame("a").src, "http://localhost:4101/#/cart")
    assert.deepEqual(fresh.saved().tabs.map((t) => t.id), ["h1", "a"])
    assert.ok(fresh.puts.every((p) => p.tabs.some((t) => t.id === "a")), "a lone Home tab replaced the desk's copy")
  } finally {
    fresh.close()
  }

  // A desk that is down when the window opens: nothing is written until it answers.
  const late = await multiDesk({ lists: [null, [SHOP]], remote: copy, url: "http://localhost:3454/" })
  try {
    assert.deepEqual(late.puts, [])
    assert.equal(late.saved(), null)
    await late.poll()
    assert.deepEqual(late.labels(), ["Home", "shop"])
    assert.ok(late.puts.every((p) => p.tabs.some((t) => t.id === "a")), "a lone Home tab replaced the desk's copy")
  } finally {
    late.close()
  }
})

/*
 * Measured in the real app: tabs closed a moment before quitting came back,
 * because Chrome quit before it wrote the page's last change, and the page
 * that opened next pushed that older copy over the desk's newer one.
 */
await check("a newer copy on the desk wins over older storage, and an older one does not", async () => {
  const older = { tabs: [tabOn("a", SHOP), tabOn("b", DOCS), { id: "h1", kind: "home" }], active: "h1", savedAt: 100 }
  const newer = { tabs: [tabOn("a", SHOP)], active: "a", savedAt: 200 }
  const lost = await multiDesk({
    url: "http://localhost:3454/",
    lists: [[SHOP, DOCS]],
    remote: newer,
    setup: (window) => window.localStorage.setItem("designlayer.desk.tabs.v1", JSON.stringify(older)),
  })
  try {
    // Only the shop tab: docs has no tab any more.
    assert.equal(lost.doc.querySelectorAll(".tab").length, 1)
    assert.deepEqual(lost.saved().tabs.map((t) => t.id), ["a"], "the older storage won over the desk's newer copy")
    assert.ok(lost.puts.every((p) => p.tabs.length === 1), "the older copy was pushed over the newer one")
  } finally {
    lost.close()
  }

  const kept = await multiDesk({
    url: "http://localhost:3454/",
    lists: [[SHOP, DOCS]],
    remote: older,
    setup: (window) => window.localStorage.setItem("designlayer.desk.tabs.v1", JSON.stringify(newer)),
  })
  try {
    assert.deepEqual(kept.saved().tabs.map((t) => t.id), ["a"], "an older desk copy replaced newer storage")
  } finally {
    kept.close()
  }
})

// Found in the real app after a restart: the tab in front showed the refused
// connection, its editor came back, and the tab stayed on the error page.
await check("the tab in front loads its editor when that editor comes back, once", async () => {
  const back = { ...SHOP, pid: 9, page: "/#/cart" }
  const d = await multiDesk({
    tabs: [tabOn("a", SHOP), tabOn("b", DOCS)],
    active: "a",
    lists: [[DOCS], [DOCS], [back, DOCS], [back, DOCS]],
    url: "http://localhost:3454/",
  })
  try {
    const stopped = d.frame("a").src
    await d.poll()
    assert.equal(d.frame("a").src, stopped, "a tab with no editor was reloaded")
    await d.poll()
    assert.equal(d.frame("a").src, "http://localhost:4101/#/cart", "the tab in front stayed on the refused connection")
    const loaded = d.frame("a").src
    await d.poll()
    assert.equal(d.frame("a").src, loaded, "the tab loaded twice")
    assert.equal(d.frame("b").src.startsWith("http://localhost:4102"), true)
  } finally {
    d.close()
  }
})

/*
 * Phil: a tip that repeats a name the tab already shows in full says nothing.
 * It names the tab only when the tab cuts the name short, and always gives
 * the localhost address of what the tab shows.
 */
await check("hovering a tab gives its localhost address, and its full name only when the tab cuts it short", async () => {
  const LONG = { ...SHOP, name: "customer-onboarding-dashboard-experiment", appUrl: "http://127.0.0.1:3041" }
  const SHORT = { ...DOCS, appUrl: "http://127.0.0.1:5173" }
  const d = await multiDesk({
    tabs: [{ id: "h1", kind: "home" }, tabOn("a", LONG), tabOn("b", SHORT)],
    active: "a",
    lists: [[LONG, SHORT]],
    // jsdom lays nothing out: a label 7px a letter wide in a 120px tab body.
    setup(window) {
      Object.defineProperty(window.HTMLElement.prototype, "scrollWidth", {
        get() {
          return this.classList.contains("label") ? this.textContent.length * 7 : 0
        },
      })
      Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
        get() {
          return this.classList.contains("label") ? 120 : 0
        },
      })
    },
  })
  try {
    await d.poll()
    const tip = d.doc.getElementById("tip")
    const shown = () => [...tip.children].filter((line) => !line.hidden).map((line) => line.textContent)
    const hover = (el) => el.dispatchEvent(new d.win.MouseEvent("pointerover", { bubbles: true }))
    const [, a] = d.doc.querySelectorAll(".tab")
    assert.equal(a.title, "", "a native title tip would show beside this one")
    hover(a.querySelector(".label"))
    assert.equal(tip.classList.contains("open"), true)
    assert.deepEqual(shown(), [LONG.name, "localhost:3041"], "a name cut short is not given in full, or the address is not the app's")
    await d.poll()
    assert.equal(tip.classList.contains("open"), true, "the redraw closed the tip under the pointer")
    assert.deepEqual(shown(), [LONG.name, "localhost:3041"])

    const next = d.doc.querySelectorAll(".tab")[2]
    next.dispatchEvent(new d.win.MouseEvent("pointerout", { bubbles: true, relatedTarget: d.doc.querySelectorAll(".tab")[0] }))
    hover(d.doc.querySelectorAll(".tab")[0])
    assert.deepEqual(shown(), ["localhost:3455"], "Home, shown in full, was named again")

    d.doc.querySelectorAll(".tab")[2].dispatchEvent(new d.win.MouseEvent("pointerdown", { bubbles: true }))
    assert.equal(tip.classList.contains("open"), false, "a press leaves the tip open")
    hover(d.doc.querySelectorAll(".tab")[2])
    assert.equal(tip.classList.contains("open"), false, "the tip came back before the pointer left the pressed tab")
    d.doc.querySelectorAll(".tab")[2].dispatchEvent(new d.win.MouseEvent("pointerout", { bubbles: true, relatedTarget: d.doc.body }))
    hover(d.doc.querySelectorAll(".tab")[2])
    assert.deepEqual(shown(), ["localhost:5173"])
    d.doc.querySelectorAll(".tab")[2].dispatchEvent(new d.win.MouseEvent("pointerout", { bubbles: true, relatedTarget: d.doc.body }))
    assert.equal(tip.classList.contains("open"), false, "the tip stayed after the pointer left the strip")
  } finally {
    d.close()
  }
})

await check("a stopped editor's tab is drawn stopped while the others stay live, and ⌘1–9, ⌘W, ⌘T act on tabs", async () => {
  const d = await multiDesk({
    tabs: [{ id: "h1", kind: "home" }, tabOn("a", SHOP), tabOn("b", DOCS)],
    active: "a",
    lists: [[SHOP, DOCS], [DOCS]],
  })
  try {
    await d.poll()
    const [, a, b] = d.doc.querySelectorAll(".tab")
    assert.equal(a.classList.contains("dead"), true)
    assert.equal(b.classList.contains("dead"), false)

    d.press({ key: "3" })
    assert.equal(d.selected(), "docs")
    d.press({ key: "1" })
    assert.equal(d.selected(), "Home")
    d.press({ key: "9" })
    assert.equal(d.selected(), "docs")
    d.press({ key: "2" })
    d.press({ key: "w" })
    assert.deepEqual(d.labels(), ["Home", "docs"])
    assert.equal(d.selected(), "docs")
    d.press({ key: "t" })
    assert.deepEqual(d.labels(), ["Home", "docs", "Home"])
    assert.equal(d.doc.querySelectorAll(".tab")[2].getAttribute("aria-selected"), "true")
  } finally {
    d.close()
  }
})

await check("Open in Mac app for a second editor opens its own tab, and a tab emptied in the background loads once", async () => {
  const d = await multiDesk({
    tabs: [{ id: "h1", kind: "home" }, tabOn("a", SHOP)],
    active: "h1",
    lists: [[SHOP, DOCS], [{ ...SHOP, pid: 9 }, DOCS]],
  })
  try {
    const shopSrc = d.frame("a").src
    d.hand("http://127.0.0.1:4102/guide")
    assert.deepEqual(d.labels(), ["Home", "shop", "docs"])
    assert.equal(d.selected(), "docs")
    assert.equal(d.frame("a").src, shopSrc)

    // Restarted while hidden: emptied, to load when next opened.
    d.doc.querySelectorAll(".tab")[0].click()
    await d.poll()
    const frame = d.frame("a")
    assert.equal(frame.src, "about:blank")
    const sets = []
    Object.defineProperty(frame, "src", { configurable: true, get: () => sets.at(-1), set: (v) => sets.push(v) })
    d.hand("http://127.0.0.1:4101/cart")
    d.doc.querySelectorAll(".tab")[0].click()
    d.doc.querySelectorAll(".tab")[1].click()
    assert.deepEqual(sets, ["http://localhost:4101/cart"], "the tab loaded more than once")
  } finally {
    d.close()
  }
})

/*
 * Found in the real app: the reload button set the frame's src to the page it
 * already showed. Apps route by hash, and a src that differs only after the #
 * is a same-document navigation, so the prototype never reloaded.
 */
await check("the reload button loads the active tab's page in a new frame and leaves the other tabs alone", async () => {
  const d = await multiDesk({
    tabs: [tabOn("a", SHOP, { src: "http://localhost:4101/#/cart" }), tabOn("b", DOCS)],
    active: "a",
    lists: [[SHOP, DOCS]],
  })
  try {
    const old = d.frame("a"), other = d.frame("b")
    // The editor reports a page change inside the app after the tab loaded.
    d.say("a", { type: "designlayer-desk:showing", name: "shop", page: "/#/checkout" }, "http://localhost:4101")
    d.doc.getElementById("reload").click()
    const fresh = d.frame("a")
    assert.notEqual(fresh, old, "the frame was only given its src again, which a hash route ignores")
    assert.equal(old.isConnected, false)
    assert.equal(fresh.src, "http://localhost:4101/#/checkout", "the reload left the page the editor was on")
    assert.equal(fresh.hidden, false)
    assert.equal(fresh.name, "designlayer-desk:a")
    assert.equal(d.frame("b"), other, "another tab was reloaded")
    assert.equal(d.doc.querySelectorAll('iframe[data-id="a"]').length, 1)
  } finally {
    d.close()
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
        "http://localhost:4100",
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

console.log("several windows")

/**
 * Desk windows side by side, as the app runs them: one origin's storage, one
 * BroadcastChannel, one desk. jsdom shares neither storage nor a channel
 * between two windows, so `desk.storage` and a bus stand in for them. jsdom
 * lays nothing out either: here tabs are 100px wide, 2px apart from x 80, and
 * the strip is the top 38px of a 1024x768 window whose top left corner is at
 * `at` on screen.
 */
function fakeApp({ lists = [[SHOP, DOCS, STUDIO]], windows = {}, openOk = true, tabWidth = () => 100, measure = false } = {}) {
  const channels = new Set()
  const desk = { windows: structuredClone(windows), opened: [], puts: [], storage: new Map(), names: {} }
  const opened = []
  return {
    desk,
    closeAll: () => opened.forEach((w) => w.close()),
    async open({ url = "http://localhost:3454/", at = { x: 0, y: 0 }, focused = true, popupsBlocked = false, movable = true, tabs } = {}) {
      const { JSDOM } = await import("jsdom")
      const { shellPage } = await import("../shell-page.mjs")
      const popups = []
      const moves = []
      const streams = []
      let closed = false
      const dom = new JSDOM(shellPage({ repoRoot: "/r" }), {
        url,
        runScripts: "dangerously",
        beforeParse(window) {
          const store = desk.storage
          if (tabs) store.set("designlayer.desk.tabs.v1", JSON.stringify(tabs))
          Object.defineProperty(window, "localStorage", {
            value: {
              getItem: (k) => (store.has(k) ? store.get(k) : null),
              setItem: (k, v) => store.set(k, String(v)),
              removeItem: (k) => store.delete(k),
              key: (i) => [...store.keys()][i] ?? null,
              get length() {
                return store.size
              },
            },
          })
          window.BroadcastChannel = class {
            constructor(name) {
              this.name = name
              this.window = window
              channels.add(this)
            }
            postMessage(data) {
              // A closed window says nothing more; jsdom keeps its timers running.
              if (this.window.closed) return
              const copy = structuredClone(data)
              for (const c of channels) if (c !== this && c.name === this.name) setTimeout(() => c.onmessage?.({ data: copy }))
            }
          }
          Object.defineProperty(window, "screenX", { value: at.x, configurable: true })
          Object.defineProperty(window, "screenY", { value: at.y, configurable: true })
          Object.defineProperty(window, "closed", { get: () => closed, configurable: true })
          window.close = () => {
            closed = true
            for (const c of channels) if (c.window === window) channels.delete(c)
          }
          window.document.hasFocus = () => focused
          const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })
          // A tab is as wide as the page set it, or as `tabWidth` says.
          const widthOf = (el) => parseFloat(el.style.width) || tabWidth(el)
          window.Element.prototype.getBoundingClientRect = function () {
            if (this.id === "strip") return rect(0, 0, 1024, 38)
            if (this.id === "tabs") return rect(80, 6, 800, 26)
            if (this.id === "measure") return rect(0, 0, measure ? this.textContent.length * 7 : 0, 14)
            if (this.parentElement?.id === "tabs") {
              const before = [...this.parentElement.children].slice(0, [...this.parentElement.children].indexOf(this))
              return rect(80 + before.reduce((x, el) => x + widthOf(el) + 2, 0), 6, widthOf(this), 26)
            }
            return rect(0, 0, 0, 0)
          }
          window.requestAnimationFrame = (fn) => setTimeout(fn, 0)
          window.cancelAnimationFrame = (id) => clearTimeout(id)
          // A window the page may move (one it opened), or one it may not.
          window.moveTo = (x, y) => {
            moves.push([x, y])
            if (!movable) return
            Object.defineProperty(window, "screenX", { value: x, configurable: true })
            Object.defineProperty(window, "screenY", { value: y, configurable: true })
          }
          window.Element.prototype.setPointerCapture = () => {}
          window.Element.prototype.releasePointerCapture = () => {}
          window.fetch = async (u, init = {}) => {
            const req = new URL(String(u), "http://localhost:3454")
            const answer = (body) => ({ ok: true, json: async () => body })
            if (req.pathname === "/api/tabs") {
              if (init.method === "PUT") {
                const body = JSON.parse(init.body)
                desk.puts.push(body)
                desk.windows[body.window ?? "main"] = body
                return answer({})
              }
              if (req.searchParams.get("all") === "1") {
                const live = Object.entries(desk.windows).filter(([, w]) => !w.gone)
                const gone = Object.entries(desk.windows).filter(([, w]) => w.gone).map(([id, w]) => [id, w.savedAt])
                return answer({ windows: Object.fromEntries(live), gone: Object.fromEntries(gone) })
              }
              return answer(desk.windows[req.searchParams.get("window") ?? "main"] ?? {})
            }
            if (req.pathname === "/api/names") {
              if (init.method === "PUT") {
                const body = JSON.parse(init.body)
                if (body.name) desk.names[body.app] = body.name
                else delete desk.names[body.app]
              }
              return answer({ names: { ...desk.names } })
            }
            if (req.pathname === "/api/windows/open") {
              desk.opened.push(JSON.parse(init.body).window)
              return answer({ ok: openOk })
            }
            if (req.pathname === "/api/editors") return answer({ editors: lists[0] })
            return answer({ ok: true, startScreen: { ready: true, url: "http://127.0.0.1:3455" } })
          }
          window.open = (href, target, features) => {
            popups.push({ href, features })
            return popupsBlocked ? null : {}
          }
          window.matchMedia = () => ({ matches: false })
          window.focus = () => {}
          window.EventSource = class {
            constructor() {
              streams.push(this)
            }
            addEventListener(type, fn) {
              this[type] = fn
            }
          }
        },
      })
      const win = dom.window
      const doc = win.document
      const handle = {
        win,
        doc,
        popups,
        moves,
        id: () => new URLSearchParams(win.location.search).get("window"),
        closed: () => closed,
        labels: () => [...doc.querySelectorAll(".tab[data-id] .label")].map((n) => n.textContent),
        selected: () => doc.querySelector('.tab[aria-selected="true"] .label')?.textContent,
        tab: (label) => [...doc.querySelectorAll(".tab[data-id]")].find((n) => n.querySelector(".label").textContent === label),
        frames: () => [...doc.querySelectorAll("iframe")].map((f) => f.src),
        hand: (href) => streams[0]?.["open-url"]({ data: JSON.stringify({ id: 1, url: href }) }),
        // A drag, as Chrome delivers it to a captured tab: client coordinates
        // in this window, screen coordinates anywhere.
        drag(label, path) {
          const el = handle.tab(label)
          const fire = (type, [x, y]) =>
            el.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y, screenX: x + at.x, screenY: y + at.y }))
          fire("pointerdown", path[0])
          for (const point of path.slice(1)) fire("pointermove", point)
          fire("pointerup", path.at(-1))
        },
        // The window closing itself, as the page does; closeAll tears jsdom down.
        close: () => win.close(),
      }
      opened.push({ close: () => dom.window.close() })
      // Long enough for the window to learn its id and hear the others.
      await sleep(260)
      return handle
    },
  }
}

/*
 * Phil: reordering was less sensitive than Chrome's; a neighbour moved only
 * once the dragged tab's middle passed the neighbour's middle. Chrome moves a
 * tab to the slot nearest its left edge (TabStrip CalculateInsertionIndex),
 * so a neighbour steps aside once the tab covers half of it, and takes a new
 * slot only after the pointer moves past a small threshold
 * (DraggingTabsSession kHorizontalMoveThreshold), so the row does not jitter.
 */
await check("a dragged tab swaps with a neighbour once it covers half of it, does not jitter back, and a press without a drag only selects", async () => {
  const app = fakeApp()
  try {
    const a = await app.open({ tabs: { tabs: [tabOn("a", SHOP), tabOn("b", DOCS), { id: "h1", kind: "home" }], active: "b" } })
    assert.equal(a.id(), "main", "the app's first window is the main window, and its address says so")
    // Tabs here are 100px wide, 102px apart. shop moves 60px right: past half
    // of docs, though its middle (190) is still short of docs' middle (232).
    a.drag("shop", [[130, 19], [140, 20], [190, 19]])
    assert.deepEqual(a.labels(), ["docs", "shop", "Home"], "docs did not step aside once shop covered half of it")
    assert.equal(a.selected(), "shop", "the dragged tab is the one showing")
    assert.deepEqual(JSON.parse(app.desk.storage.get("designlayer.desk.tabs.v1")).tabs.map((t) => t.id), ["b", "a", "h1"])
    // Back over half of docs, then 4px the other way, inside the threshold:
    // the tab keeps its new slot.
    a.drag("shop", [[232, 19], [200, 19], [180, 19], [184, 19]])
    assert.deepEqual(a.labels(), ["shop", "docs", "Home"], "the tab jittered back across the boundary")
    // Most of the way over Home: the last slot.
    a.drag("shop", [[130, 19], [200, 19], [300, 19]])
    assert.deepEqual(a.labels(), ["docs", "Home", "shop"])
    // A press that never moves.
    a.drag("Home", [[232, 19]])
    assert.deepEqual(a.labels(), ["docs", "Home", "shop"])
    // Escape puts a dragged tab back.
    const el = a.tab("docs")
    const fire = (type, x) => el.dispatchEvent(new a.win.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: 19 }))
    fire("pointerdown", 130)
    fire("pointermove", 400)
    a.win.dispatchEvent(new a.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    fire("pointerup", 400)
    assert.deepEqual(a.labels(), ["docs", "Home", "shop"])
  } finally {
    app.closeAll()
  }
})

/*
 * Measured in Chrome 155 and read in its source (TabContainerImpl): after a
 * click on a close button the tabs keep their width while the pointer stays
 * on the strip, so the next close button is under the pointer, and clicking
 * on the spot closes tab after tab.
 */
await check("closing tabs with the mouse puts each next close button under the pointer, until the pointer leaves", async () => {
  // Tabs as wide as their names: 10px a letter and 50px besides.
  const app = fakeApp({ tabWidth: (el) => el.querySelector(".label").textContent.length * 10 + 50 })
  try {
    const a = await app.open({ tabs: { tabs: [tabOn("c", STUDIO), tabOn("b", DOCS), tabOn("a", SHOP), { id: "h1", kind: "home" }], active: "c" } })
    const tabsEl = a.doc.getElementById("tabs")
    const x = (label) => a.tab(label).querySelector(".close").click()
    const width = (label) => a.tab(label).style.width
    assert.equal(width("docs"), "")
    // studio (110px) hands its width to docs (90px), which slides into its
    // place: docs' close button is where studio's was.
    x("studio")
    assert.deepEqual(a.labels(), ["docs", "shop", "Home"])
    assert.equal(width("docs"), "110px")
    assert.equal(width("shop"), "90px")
    assert.equal(tabsEl.style.width, "270px")
    x("docs")
    assert.equal(width("shop"), "110px")
    // The last tab shares its 90px, less the 10px overlap, with the rest.
    x("Home")
    assert.deepEqual(a.labels(), ["shop"])
    assert.equal(width("shop"), "", "one tab left has no next close button to line up")
  } finally {
    app.closeAll()
  }
  const more = fakeApp({ tabWidth: (el) => el.querySelector(".label").textContent.length * 10 + 50 })
  try {
    const a = await more.open({ tabs: { tabs: [tabOn("a", SHOP), tabOn("b", DOCS), tabOn("c", STUDIO)], active: "a" } })
    const tabsEl = a.doc.getElementById("tabs")
    const width = (label) => a.tab(label).style.width
    a.tab("studio").querySelector(".close").click()
    assert.deepEqual([width("shop"), width("docs")], ["140px", "140px"], "the last tab's room did not go to the others")
    // A pointer that slips off the strip and back keeps them; one that stays off ends it.
    tabsEl.dispatchEvent(new a.win.PointerEvent("pointerleave"))
    await sleep(100)
    tabsEl.dispatchEvent(new a.win.PointerEvent("pointerenter"))
    await sleep(300)
    assert.equal(width("shop"), "140px")
    tabsEl.dispatchEvent(new a.win.PointerEvent("pointerleave"))
    await sleep(350)
    assert.equal(width("shop"), "", "the tabs kept their held widths after the pointer left the strip")
    // A close from the keyboard is not a close under the pointer.
    a.win.dispatchEvent(new a.win.KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true, cancelable: true }))
    assert.deepEqual(a.labels(), ["docs"])
    assert.equal(width("docs"), "")
    // A new tab ends it too.
    a.doc.getElementById("newTab").click()
    a.doc.getElementById("newTab").click()
    a.tab("docs").querySelector(".close").click()
    assert.notEqual(a.doc.querySelector(".tab[data-id]").style.width, "")
    a.doc.getElementById("newTab").click()
    assert.ok([...a.doc.querySelectorAll(".tab[data-id]")].every((el) => el.style.width === ""))
  } finally {
    more.closeAll()
  }
})

/*
 * Phil: show the whole name when there is room. A tab is as wide as its name
 * needs; short of room the widest names are cut first. The tabs carry no ⌘
 * number: Phil wanted the strip clean.
 */
await check("a tab is as wide as its whole name while there is room, and the widest give way first", async () => {
  const LONG = { ...SHOP, name: "gemini-app-builder-cujs-integrations" }
  const app = fakeApp({ measure: true, lists: [[LONG, DOCS, STUDIO]] })
  try {
    const a = await app.open({ tabs: { tabs: [tabOn("a", LONG), { id: "h1", kind: "home" }], active: "a" } })
    const tabsEl = a.doc.getElementById("tabs")
    const widths = () => [...a.doc.querySelectorAll(".tab[data-id]")].map((el) => parseFloat(el.style.width))
    // 7px a letter here. Both tabs have a glyph and a close button, so they
    // differ by their names alone.
    const [long, home] = widths()
    assert.equal(long - home, (LONG.name.length - "Home".length) * 7, "a tab is not as wide as its name")
    assert.ok(home > 72)
    assert.equal(a.doc.querySelector(".tab .num"), null, "a tab still shows its ⌘ number")
    assert.doesNotMatch(tabsEl.textContent, /⌘/, "a tab still shows its ⌘ number")
    // Twelve more Home tabs: the long name is cut first.
    for (let i = 0; i < 12; i++) a.doc.getElementById("newTab").click()
    const crowded = widths()
    assert.ok(crowded[0] < long, "the long name was not cut")
    assert.ok(crowded.slice(1).every((w) => w === crowded[1]), "the Home tabs differ")
    assert.ok(crowded.reduce((t, w) => t + w, 0) - 10 * (crowded.length - 1) <= 1024, "the row overflows the strip")
    assert.ok(crowded[1] >= home - 1, "a short name was cut while a long one could give way")
  } finally {
    app.closeAll()
  }
})

// The list can change under a drag: here another window takes the dragged
// tab's editor. The drop used to splice at index -1 and take the last tab out.
await check("a tab that leaves the list mid-drag is not dropped back, and takes no other tab with it", async () => {
  const app = fakeApp()
  try {
    const a = await app.open({ tabs: { tabs: [tabOn("a", SHOP), tabOn("b", DOCS), { id: "h1", kind: "home" }], active: "a" } })
    const el = a.tab("shop")
    const fire = (type, x) => el.dispatchEvent(new a.win.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: 19 }))
    fire("pointerdown", 130)
    fire("pointermove", 200)
    new a.win.BroadcastChannel("designlayer-desk").postMessage({ t: "claimed", url: SHOP.url, from: "wother" })
    await sleep(20)
    fire("pointerup", 200)
    assert.deepEqual(a.labels(), ["docs", "Home"], "the drop brought the claimed tab back, or took another out")
  } finally {
    app.closeAll()
  }
})

await check("⌘⇧← and ⌘⇧→ move the focused tab, so a tab moves without a drag", async () => {
  const app = fakeApp()
  try {
    const a = await app.open({ tabs: { tabs: [tabOn("a", SHOP), tabOn("b", DOCS), { id: "h1", kind: "home" }], active: "a" } })
    const key = (label, k) =>
      a.tab(label).dispatchEvent(new a.win.KeyboardEvent("keydown", { key: k, metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))
    key("shop", "ArrowRight")
    assert.deepEqual(a.labels(), ["docs", "shop", "Home"])
    key("shop", "ArrowRight")
    assert.deepEqual(a.labels(), ["docs", "Home", "shop"])
    key("shop", "ArrowRight")
    assert.deepEqual(a.labels(), ["docs", "Home", "shop"], "the last tab wrapped around")
    key("docs", "ArrowLeft")
    assert.deepEqual(a.labels(), ["docs", "Home", "shop"])
  } finally {
    app.closeAll()
  }
})

await check("a tab pulled out of the strip opens in a new window where it is let go, with only that tab", async () => {
  const app = fakeApp()
  try {
    const a = await app.open({ tabs: { tabs: [tabOn("a", SHOP), tabOn("b", DOCS, { src: "http://localhost:4102/guide" }), { id: "h1", kind: "home" }], active: "a" } })
    assert.ok(a.frames().includes("http://localhost:4102/guide"))
    a.drag("docs", [[232, 19], [235, 60], [240, 400]])
    assert.deepEqual(a.labels(), ["shop", "Home"])
    assert.ok(!a.frames().includes("http://localhost:4102/guide"), "the old window kept its frame, and with it the editor's socket")
    assert.equal(a.popups.length, 1)
    const { href, features } = a.popups[0]
    const w = new URL(href, "http://localhost:3454").searchParams.get("window")
    assert.match(w, /^w[a-z0-9]+$/)
    // Under the pointer: the tab was held 50px into it, and it is the first tab at x 80.
    assert.match(features, /^popup,left=110,top=381,width=1024,height=768$/)
    const handed = JSON.parse(app.desk.storage.get(`designlayer.desk.tabs.v1:${w}`))
    assert.deepEqual(handed.tabs.map((t) => t.id), ["b"])

    const b = await app.open({ url: `http://localhost:3454${href}`, at: { x: 110, y: 381 } })
    assert.equal(b.id(), w)
    assert.deepEqual(b.labels(), ["docs"])
    assert.ok(b.frames().includes("http://localhost:4102/guide"), "the new window did not load the tab's page")

    // A window's only tab has nowhere to go but another window's strip.
    b.drag("docs", [[130, 19], [130, 200], [130, 500]])
    assert.deepEqual(b.labels(), ["docs"])
    assert.equal(b.popups.length, 0)
  } finally {
    app.closeAll()
  }
})

await check("a tab let go over another window's strip moves into it there, and a window left empty closes", async () => {
  const app = fakeApp()
  try {
    const a = await app.open({ tabs: { tabs: [tabOn("a", SHOP), tabOn("b", DOCS)], active: "a" }, focused: true })
    app.desk.storage.set("designlayer.desk.tabs.v1:wright", JSON.stringify({ tabs: [{ id: "h9", kind: "home" }, tabOn("c", STUDIO)], active: "h9" }))
    const b = await app.open({ url: "http://localhost:3454/?window=wright", at: { x: 1100, y: 0 }, focused: false })
    await sleep(1100)
    // Over the other window's strip at its x 150 (screen 1250): past its first tab's middle.
    const el = a.tab("docs")
    const fire = (type, x, y) =>
      el.dispatchEvent(new a.win.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y, screenX: x, screenY: y }))
    fire("pointerdown", 232, 19)
    fire("pointermove", 600, 19)
    fire("pointermove", 1250, 19)
    await until(() => b.doc.querySelector(".tab.incoming")).catch(() => {})
    assert.ok(b.doc.querySelector(".tab.incoming"), "the other window shows no slot where the tab will land")
    assert.equal(b.doc.querySelector(".tab.incoming .label").textContent, "docs")
    assert.equal(a.doc.querySelector(".tab-ghost .hint").textContent, "Move to window with Home and 1 other tab")
    fire("pointerup", 1250, 19)
    await until(() => a.labels().length === 1).catch(() => {})
    assert.equal(b.doc.querySelector(".tab.incoming"), null)
    assert.equal(b.labels()[1], "docs")
    assert.equal(b.selected(), "docs")
    assert.deepEqual(a.labels(), ["shop"])

    // The last tab of a window moves too, and the window it left closes.
    const last = a.tab("shop")
    const go = (type, x) => last.dispatchEvent(new a.win.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: 19, screenX: x, screenY: 19 }))
    go("pointerdown", 130)
    go("pointermove", 1180)
    go("pointerup", 1180)
    await until(() => a.closed()).catch(() => {})
    assert.equal(b.labels()[0], "shop")
    assert.ok(a.closed(), "the empty window stayed open")
    assert.equal(app.desk.storage.get("designlayer.desk.tabs.v1"), undefined, "the closed window's tabs would come back")
    assert.ok(app.desk.puts.some((p) => p.window === "main" && p.gone))
  } finally {
    app.closeAll()
  }
})

await check("a window's only tab drags the whole window, which hangs below another window's strip while its tab can drop there", async () => {
  const app = fakeApp()
  try {
    const main = await app.open({ tabs: { tabs: [tabOn("a", SHOP), tabOn("b", DOCS)], active: "a" } })
    app.desk.storage.set("designlayer.desk.tabs.v1:wsolo", JSON.stringify({ tabs: [tabOn("c", STUDIO)], active: "c" }))
    const solo = await app.open({ url: "http://localhost:3454/?window=wsolo", at: { x: 300, y: 400 } })
    await sleep(1100)
    const el = solo.tab("studio")
    const fire = (type, sx, sy) =>
      el.dispatchEvent(new solo.win.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: sx - solo.win.screenX, clientY: sy - solo.win.screenY, screenX: sx, screenY: sy }))
    // Held 50px into the window at (300, 400): the window follows the pointer.
    fire("pointerdown", 430, 419)
    fire("pointermove", 500, 450)
    await sleep(20)
    assert.deepEqual(solo.moves.at(-1), [370, 431])
    // Over the main window's strip it hangs below it (strip bottom 38, plus 6).
    fire("pointermove", 200, 20)
    await sleep(20)
    assert.deepEqual(solo.moves.at(-1), [70, 44])
    assert.ok(main.doc.querySelector(".tab.incoming"), "the main window shows no slot")
    fire("pointerup", 200, 20)
    await until(() => solo.closed()).catch(() => {})
    assert.deepEqual(main.labels(), ["shop", "studio", "docs"])
    assert.ok(solo.closed())
  } finally {
    app.closeAll()
  }
  // Escape puts the window back; a window the page may not move falls back to the copy.
  const again = fakeApp()
  try {
    const main = await again.open({ tabs: { tabs: [tabOn("a", SHOP)], active: "a" } })
    again.desk.storage.set("designlayer.desk.tabs.v1:wsolo", JSON.stringify({ tabs: [tabOn("c", STUDIO)], active: "c" }))
    const solo = await again.open({ url: "http://localhost:3454/?window=wsolo", at: { x: 300, y: 400 } })
    await sleep(1100)
    const el = solo.tab("studio")
    const fire = (type, sx, sy) =>
      el.dispatchEvent(new solo.win.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: sx - 300, clientY: sy - 400, screenX: sx, screenY: sy }))
    fire("pointerdown", 430, 419)
    fire("pointermove", 600, 600)
    await sleep(20)
    solo.win.dispatchEvent(new solo.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    assert.deepEqual(solo.moves.at(-1), [300, 400], "Escape left the window where it was dragged")
    assert.deepEqual(main.labels(), ["shop"])
    const stuck = await again.open({ url: "http://localhost:3454/?window=wstuck", at: { x: 300, y: 400 }, movable: false })
    await sleep(1100)
    const tab = stuck.doc.querySelector(".tab[data-id]")
    const go = (type, sx, sy) =>
      tab.dispatchEvent(new stuck.win.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: sx - 300, clientY: sy - 400, screenX: sx, screenY: sy }))
    go("pointerdown", 430, 419)
    for (let i = 1; i <= 4; i++) { go("pointermove", 430 + i * 40, 419 + i * 40); await sleep(20) }
    go("pointermove", 200, 20)
    await sleep(20)
    assert.ok(main.doc.querySelector(".tab.incoming"), "a window that cannot move could not reach the main strip")
    go("pointerup", 200, 20)
    await until(() => stuck.closed()).catch(() => {})
    assert.deepEqual(main.labels(), ["shop", "Home"])
    // Found in the real app: the desk reopened a window exactly on top of the
    // main one, where it could not move, and its tab could not reach the
    // strip underneath. The strip under the pointer counts, below the window too.
    again.desk.storage.set("designlayer.desk.tabs.v1:wover", JSON.stringify({ tabs: [tabOn("d", DOCS)], active: "d" }))
    const over = await again.open({ url: "http://localhost:3454/?window=wover", movable: false })
    await sleep(1100)
    const top = over.tab("docs")
    const press = (type, x) => top.dispatchEvent(new over.win.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: 19, screenX: x, screenY: 19 }))
    press("pointerdown", 130)
    for (let x = 160; x <= 320; x += 40) { press("pointermove", x); await sleep(20) }
    assert.ok(main.doc.querySelector(".tab.incoming"), "the strip under the window got no slot")
    assert.match(over.doc.querySelector(".tab-ghost .hint")?.textContent ?? "", /^Move to window with /)
    press("pointerup", 320)
    await until(() => over.closed()).catch(() => {})
    assert.deepEqual(main.labels(), ["shop", "Home", "docs"])
  } finally {
    again.closeAll()
  }
})

await check("a tab's menu moves it to a new window or into another window", async () => {
  const app = fakeApp()
  try {
    const a = await app.open({ tabs: { tabs: [tabOn("a", SHOP), tabOn("b", DOCS), { id: "h1", kind: "home" }], active: "a" } })
    const b = await app.open({ url: "http://localhost:3454/?window=wother", at: { x: 1100, y: 0 } })
    await sleep(1100)
    const menu = (label) => {
      a.tab(label).dispatchEvent(new a.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 30 }))
      return [...a.doc.querySelectorAll("#menu button")]
    }
    let items = menu("docs")
    assert.deepEqual(items.map((i) => i.textContent), ["Rename tab…", "Move to new window", "Move to window with Home", "Close tab"])
    items = items.slice(1)
    items[1].click()
    await until(() => a.labels().length === 2).catch(() => {})
    assert.deepEqual(a.labels(), ["shop", "Home"])
    assert.deepEqual(b.labels(), ["Home", "docs"])
    assert.ok(a.doc.getElementById("menu").hidden)
    items = menu("shop").slice(1)
    items[0].click()
    assert.deepEqual(a.labels(), ["Home"])
    assert.equal(a.popups.length, 1)
    assert.match(a.popups[0].features, /^popup,left=40,top=40,/, "a moved tab opens beside the window")
    // A window's only tab cannot leave by its menu for a new window, or be closed.
    items = menu("Home")
    assert.equal(items[0].disabled, true)
    assert.equal(items.at(-1).disabled, true)
  } finally {
    app.closeAll()
  }
})

await check("a tab renamed by a double-click, F2 or its menu keeps the name for its app in every window", async () => {
  // One folder running two apps, a front end and its agent server: each tab is named on its own.
  const WEB = { ...SHOP, appUrl: "http://127.0.0.1:3041" }
  const AGENT = { name: "shop", url: "http://localhost:4103", pid: 3, projectRoot: "/p/shop", appUrl: "http://127.0.0.1:8002" }
  const app = fakeApp({ lists: [[WEB, AGENT, DOCS]] })
  try {
    const a = await app.open({ tabs: { tabs: [tabOn("a", WEB), tabOn("b", DOCS), tabOn("c", AGENT), { id: "h1", kind: "home" }], active: "a" } })
    await sleep(100)
    const field = () => a.doc.querySelector(".tab input.rename")
    const key = (el, k) => el.dispatchEvent(new a.win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }))
    a.tab("shop").dispatchEvent(new a.win.MouseEvent("dblclick", { bubbles: true }))
    assert.ok(field(), "a double-click left the name as it was")
    assert.equal(field().value, "shop")
    assert.equal(a.doc.activeElement, field())
    field().value = "  Checkout  "
    key(field(), "Enter")
    assert.equal(field(), null)
    assert.deepEqual(a.labels(), ["Checkout", "docs", "shop", "Home"])
    assert.equal(a.doc.title, "Checkout — DesignLayer")
    assert.deepEqual(app.desk.names, { "/p/shop|3041": "Checkout" }, "the name is the app's, kept by the desk")
    // The strip is rebuilt on every poll; a name being typed survives it.
    key(a.tab("docs"), "F2")
    field().value = "Guide"
    await sleep(2200)
    assert.equal(field()?.value, "Guide")
    key(field(), "Escape")
    assert.deepEqual(a.labels(), ["Checkout", "docs", "shop", "Home"], "Escape saved the name")
    // Home has no name to change.
    a.tab("Home").dispatchEvent(new a.win.MouseEvent("dblclick", { bubbles: true }))
    assert.equal(field(), null)
    const menu = (label) => {
      a.tab(label).dispatchEvent(new a.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 30 }))
      return [...a.doc.querySelectorAll("#menu button")]
    }
    assert.equal(menu("Home")[0].textContent, "Move to new window")
    let items = menu("Checkout")
    assert.deepEqual(items.slice(0, 2).map((i) => i.textContent), ["Rename tab…", "Use folder name"])
    items[1].click()
    assert.deepEqual(a.labels(), ["shop", "docs", "shop", "Home"])
    assert.deepEqual(app.desk.names, {})
    // An empty name is the folder's name too.
    menu("shop")[0].click()
    field().value = "Cart"
    key(field(), "Enter")
    key(a.tab("Cart"), "F2")
    field().value = ""
    key(field(), "Enter")
    assert.deepEqual(a.labels(), ["shop", "docs", "shop", "Home"])
    menu("shop")[0].click()
    field().value = "Cart"
    key(field(), "Enter")
    // Another window, with nothing of this origin's copy, takes the desk's names.
    app.desk.storage.delete("designlayer.desk.tabs.v1.names")
    const b = await app.open({ url: "http://localhost:3454/?window=wother", at: { x: 1100, y: 0 } })
    await sleep(1100)
    menu("Cart").find((i) => i.textContent === "Move to window with Home").click()
    await until(() => b.labels().includes("Cart"))
    assert.deepEqual(b.labels(), ["Home", "Cart"])
  } finally {
    app.closeAll()
  }
})

await check("a long drag that outlives Chrome's popup permission asks the desk for the window", async () => {
  const app = fakeApp()
  try {
    const a = await app.open({ tabs: { tabs: [tabOn("a", SHOP), tabOn("b", DOCS)], active: "a" }, popupsBlocked: true })
    a.drag("docs", [[232, 19], [232, 300]])
    await until(() => a.labels().length === 1).catch(() => {})
    assert.equal(app.desk.opened.length, 1)
    assert.match(app.desk.opened[0], /^w[a-z0-9]+$/)
    assert.deepEqual(a.labels(), ["shop"])
  } finally {
    app.closeAll()
  }
  const refused = fakeApp({ openOk: false })
  try {
    const a = await refused.open({ tabs: { tabs: [tabOn("a", SHOP), tabOn("b", DOCS)], active: "a" }, popupsBlocked: true })
    a.drag("docs", [[232, 19], [232, 300]])
    await sleep(100)
    assert.deepEqual(a.labels(), ["shop", "docs"], "a tab with no window to go to was lost")
    assert.ok(![...refused.desk.storage.keys()].some((k) => k.includes(":w")), "the window that never opened kept its tabs")
  } finally {
    refused.closeAll()
  }
})

await check("a window opened while the app is up is a new window with a Home tab, and loads no other window's editors", async () => {
  const app = fakeApp()
  try {
    const main = await app.open({ tabs: { tabs: [tabOn("a", SHOP)], active: "a" } })
    const fresh = await app.open()
    assert.equal(main.id(), "main")
    assert.match(fresh.id(), /^w[a-z0-9]+$/)
    assert.deepEqual(fresh.labels(), ["Home"])
    assert.ok(!fresh.frames().some((src) => src.includes("4101")), "the new window took the main window's editor")
    assert.deepEqual(main.labels(), ["shop"])
  } finally {
    app.closeAll()
  }
})

await check("the app's first window reopens the windows that closed with it, and forgets one closed long before", async () => {
  const windows = {
    main: { tabs: [tabOn("a", SHOP)], active: "a", savedAt: 10, closedAt: 100_000 },
    wquit: { tabs: [tabOn("b", DOCS)], active: "b", savedAt: 10, closedAt: 98_000 },
    wolder: { tabs: [tabOn("c", STUDIO)], active: "c", savedAt: 10, closedAt: 10_000 },
  }
  const app = fakeApp({ windows })
  try {
    const main = await app.open()
    await until(() => app.desk.opened.length === 1).catch(() => {})
    assert.deepEqual(main.labels(), ["shop"])
    assert.deepEqual(app.desk.opened, ["wquit"])
    assert.ok(app.desk.windows.wolder.gone, "a window closed on its own came back")
  } finally {
    app.closeAll()
  }
  // A desk that cannot open a window: its tabs join the first one.
  const folded = fakeApp({ windows, openOk: false })
  try {
    const main = await folded.open()
    await until(() => main.labels().length === 2).catch(() => {})
    assert.deepEqual(main.labels(), ["shop", "docs"])
    assert.ok(folded.desk.windows.wquit.gone)
  } finally {
    folded.closeAll()
  }
  // Found in the real app: Chrome dropped a closed window's last write to the
  // page's storage when the app quit, and that copy brought it back.
  const stale = fakeApp({ windows: { main: windows.main, wmerged: { gone: true, savedAt: 60 } } })
  try {
    stale.desk.storage.set("designlayer.desk.tabs.v1:wmerged", JSON.stringify({ tabs: [tabOn("b", DOCS)], active: "b", savedAt: 50 }))
    const main = await stale.open()
    await sleep(150)
    assert.deepEqual(stale.desk.opened, [], "a window that had closed was opened again")
    assert.deepEqual(main.labels(), ["shop"])
    assert.equal(stale.desk.storage.has("designlayer.desk.tabs.v1:wmerged"), false)
  } finally {
    stale.closeAll()
  }
  // The main window closed first, on its own: the app opens as the window that was still up.
  const moved = fakeApp({ windows: { main: { ...windows.main, closedAt: 10_000 }, wquit: windows.wquit } })
  try {
    const main = await moved.open()
    await until(() => main.labels()[0] === "docs").catch(() => {})
    assert.deepEqual(main.labels(), ["docs"])
    assert.deepEqual(moved.desk.opened, [])
  } finally {
    moved.closeAll()
  }
})

/*
 * Found in the real app: Chrome drops a request a closing window sends, so a
 * window closed on its own stayed saved and came back on the next launch.
 * The windows still up tell the desk instead.
 */
await check("a window closed while another stays up is forgotten, and a window that reloads is not", async () => {
  const app = fakeApp()
  try {
    const main = await app.open({ tabs: { tabs: [tabOn("a", SHOP)], active: "a" } })
    app.desk.storage.set("designlayer.desk.tabs.v1:wshut", JSON.stringify({ tabs: [tabOn("b", DOCS)], active: "b", savedAt: 1 }))
    const shut = await app.open({ url: "http://localhost:3454/?window=wshut" })
    app.desk.storage.set("designlayer.desk.tabs.v1:wload", JSON.stringify({ tabs: [tabOn("c", STUDIO)], active: "c", savedAt: 1 }))
    const load = await app.open({ url: "http://localhost:3454/?window=wload" })
    await sleep(1100)
    for (const w of [shut, load]) {
      w.win.dispatchEvent(new w.win.Event("pagehide"))
      w.close()
    }
    // The reload: the same window, back within the wait.
    const back = await app.open({ url: "http://localhost:3454/?window=wload" })
    await sleep(2300)
    assert.ok(app.desk.windows.wshut?.gone, "a window closed on its own stayed saved")
    assert.equal(app.desk.storage.has("designlayer.desk.tabs.v1:wshut"), false)
    assert.ok(!app.desk.windows.wload?.gone, "a window that reloaded was forgotten")
    assert.deepEqual(back.labels(), ["studio"])
    assert.deepEqual(main.labels(), ["shop"])
  } finally {
    app.closeAll()
  }
})

await check("a page from Open in Mac app opens once: in the window showing its editor, or else the window used last", async () => {
  const app = fakeApp()
  try {
    const a = await app.open({ tabs: { tabs: [tabOn("a", SHOP)], active: "a" }, focused: false })
    const b = await app.open({ url: "http://localhost:3454/?window=wlast", focused: true })
    await sleep(1100)
    for (const w of [a, b]) w.hand("http://localhost:4102/guide")
    assert.deepEqual(a.labels(), ["shop"])
    assert.ok(b.labels().includes("docs"))
    for (const w of [a, b]) w.hand("http://localhost:4101/cart")
    assert.ok(a.frames().includes("http://localhost:4101/cart"))
    assert.ok(!b.labels().includes("shop"))
  } finally {
    app.closeAll()
  }
})

await check("a window asked for an editor another window shows leaves its tabs alone and has that window show it", async () => {
  const app = fakeApp()
  try {
    const a = await app.open({ tabs: { tabs: [{ id: "h1", kind: "home" }], active: "h1" } })
    app.desk.storage.set("designlayer.desk.tabs.v1:wdocs", JSON.stringify({ tabs: [tabOn("h2", { name: "x", url: "http://localhost:4199", pid: 9 }), tabOn("b", DOCS)], active: "h2" }))
    const c = await app.open({ url: "http://localhost:3454/?window=wdocs", focused: false })
    await sleep(1100)
    a.win.dispatchEvent(
      new a.win.MessageEvent("message", {
        data: { type: "designlayer-desk:go", url: "http://localhost:4102/guide" },
        origin: "http://localhost:3455",
        source: a.doc.querySelector('iframe[data-id="h1"]').contentWindow,
      })
    )
    await until(() => c.selected() === "docs").catch(() => {})
    assert.deepEqual(a.labels(), ["Home"])
    assert.equal(c.selected(), "docs")
  } finally {
    app.closeAll()
  }
})

console.log("the launcher's view of the desk")


await check("an update on offer shows in the title bar, and opens Home", async () => {
  let update = null
  const d = await multiDesk({
    tabs: [tabOn("a", SHOP)],
    active: "a",
    lists: [[SHOP]],
    url: "http://localhost:3454/",
    health: () => ({ startScreen: { update } }),
  })
  try {
    const button = d.doc.getElementById("update")
    assert.equal(button.hidden, true, "nothing to offer yet")
    update = { state: "available", behind: 2 }
    await d.poll()
    assert.equal(button.hidden, false)
    assert.equal(button.textContent, "Update available")
    button.click()
    assert.equal(d.selected(), "Home", "the button opens a Home tab, where the update is")
    assert.deepEqual(d.labels(), ["shop", "Home"])
    update = { state: "updating", step: "Installing dependencies" }
    await d.poll()
    assert.equal(button.textContent, "Updating…")
    button.click()
    assert.deepEqual(d.labels(), ["shop", "Home"], "an open Home tab is reused")
    update = { state: "current" }
    await d.poll()
    assert.equal(button.hidden, true)
  } finally {
    d.close()
  }
})

await check("the window reloads once the desk runs another commit", async () => {
  let version = "a".repeat(40)
  const d = await multiDesk({ tabs: [{ id: "h", kind: "home" }], active: "h", lists: [[]], version, health: () => ({ version }) })
  try {
    await d.poll()
    assert.equal(d.navigations.length, 0, "the same commit is not a reason to reload")
    version = "b".repeat(40)
    await d.poll()
    assert.equal(d.navigations.length, 1, "an update restarted the desk: the page reloads to get the new one")
  } finally {
    d.close()
  }
})

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
    // On localhost: the desk page and the editors it frames are one site.
    assert.equal(deskUrlFromHost({ home, platform: "darwin" }), `http://localhost:${DEFAULT_DESK_PORT}`)
    fs.writeFileSync(deskPlistPath(home), buildPlist({ ...agent, port: 4999 }))
    assert.equal(deskUrlFromHost({ home, platform: "darwin" }), "http://localhost:4999")
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
  // Installed from localhost, and the app installed from 127.0.0.1 removed, so one app remains.
  assert.ok(out.includes('PWA.install {manifestId: "http://localhost:3454/", installUrlOrBundleUrl: "http://localhost:3454/"}'), out)
  assert.ok(out.includes('PWA.uninstall {manifestId: "http://127.0.0.1:3454/"}'), out)
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

// The window retitles itself "<editor> — DesignLayer" when an editor tab is
// active, and the app reopens on its last tab, so --verify-window must accept both.
await check("--verify-window recognizes the desk window on Home and on an editor tab", () => {
  assert.equal(isDeskTitle("DesignLayer"), true)
  assert.equal(isDeskTitle("storefront — DesignLayer"), true)
  assert.equal(isDeskTitle("DesignLayer docs"), false)
  assert.equal(isDeskTitle("New Tab"), false)
})

// macOS 15+ refuses a quarantined, unsigned .command until the user clicks Open
// Anyway in Privacy & Security, and managed Macs warn on `curl | bash`. The
// landing page installs from a git clone, which has neither problem; its
// commands are held by test/get-started-cases.mjs in
// phil8-li/design-layer-landing-page. The zip is for people without git.
await check("the Mac zip names Open Anyway, and sends no one to right-click or curl", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
  const pkg = fs.readFileSync(path.join(repo, "desktop", "mac", "package.mjs"), "utf8")
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
