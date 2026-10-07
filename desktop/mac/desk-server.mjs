#!/usr/bin/env node

/**
 * The DesignLayer desk: a loopback HTTP server that the installed Chrome app
 * window loads, and the supervisor that keeps the start screen alive for it.
 *
 * Run by the `dev.designlayer.desk` LaunchAgent (see install.mjs). It adds no
 * editor logic of its own: the start screen (cli.mjs --start) still chooses
 * apps and spawns editors, and runtime/editor-registry.mjs still says which
 * editors are running. This process only puts them in one window, and passes
 * that window the pages an editor in a browser tab asks to move into it
 * ("Open in Mac app": POST /api/open, delivered over GET /api/events).
 *
 * Env:
 *   DESIGNLAYER_DESK_PORT        port to bind (default 3454)
 *   DESIGNLAYER_DESK_SUPERVISE   "0" to leave the start screen alone (tests)
 *   DESIGNLAYER_START_SCREEN_PORT start screen port to probe/spawn (default 3455)
 */

import { spawn, execFile, execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { listEditors } from "../../runtime/editor-registry.mjs"
import { DEFAULT_DESK_PORT } from "../../runtime/mac-desk.mjs"
import { PREFERRED_START_SCREEN_PORT } from "../../runtime/start-screen.mjs"
import { APP_FEATURES, CHROME_BINARY, chromeProfileDir, profileChromeCommand, quitProfileChrome } from "./chrome-pipe.mjs"
import { offlinePage, shellPage } from "./shell-page.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, "..", "..")
export { DEFAULT_DESK_PORT }
const LOOPBACK = "127.0.0.1"
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
const ICONS = new Map([
  ["/icons/icon-192.png", ["icon-192.png", "image/png"]],
  ["/icons/icon-512.png", ["icon-512.png", "image/png"]],
  ["/icons/icon-maskable-512.png", ["icon-maskable-512.png", "image/png"]],
  ["/icons/mark.svg", ["mark.svg", "image/svg+xml"]],
])

/** Same rule as server/routes.mjs `isLocalRequest`, including refusing Origin "null". */
function isLoopbackHost(value) {
  if (typeof value !== "string" || value.length === 0) return false
  let host
  try {
    host = new URL(value.includes("://") ? value : `http://${value}`).hostname.replace(/^\[|\]$/g, "")
  } catch {
    return false
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

export function isLocalRequest(req) {
  if (!LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress ?? "")) return false
  if (!isLoopbackHost(req.headers.host)) return false
  const origin = req.headers.origin
  if (origin !== undefined && !isLoopbackHost(origin)) return false
  return true
}

export function manifest() {
  return {
    id: "/",
    name: "DesignLayer",
    short_name: "DesignLayer",
    description: "Visual editing for the apps running on this Mac",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay"],
    theme_color: "#1a1a1a",
    background_color: "#1a1a1a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}

const SERVICE_WORKER = `// DesignLayer desk: network first; an offline page when the desk is not running.
const CACHE = "designlayer-desk-v1"
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add("/offline.html")).then(() => self.skipWaiting()))
})
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return
  event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")))
})
`

/** Registry entries in the shape the shell uses. The registry already swept dead pids. */
export function normalizeEditors(entries) {
  return entries.map((entry) => ({
    name: entry.packageName ?? (entry.projectRoot ? path.basename(entry.projectRoot) : `Editor on ${entry.proxyPort}`),
    url: entry.url ?? `http://${LOOPBACK}:${entry.proxyPort}`,
    projectRoot: entry.projectRoot ?? null,
    appUrl: entry.appUrl ?? null,
    pid: entry.pid,
    startedAt: entry.startedAt ?? null,
    alive: true,
  }))
}

function getJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })
        } catch {
          resolve({ status: res.statusCode, body: null })
        }
      })
    })
    req.on("timeout", () => req.destroy())
    req.on("error", () => resolve(null))
  })
}

/**
 * Keeps one start screen answering. Reuses one that is already up (another
 * terminal's `npx designlayer`), and never kills what it did not start.
 */
export function createSupervisor({ repoRoot = REPO_ROOT, port = PREFERRED_START_SCREEN_PORT, logDir, enabled = true, log }) {
  const state = {
    state: enabled ? "checking" : "disabled",
    url: null,
    ready: false,
    owned: false,
    pid: null,
    restarts: 0,
    detail: null,
    editing: null,
  }
  let child = null
  let spawnedUrl = null
  let backoffMs = 1000
  let startedAt = 0
  let timer = null
  let stopped = false

  const probeUrl = () => spawnedUrl ?? `http://${LOOPBACK}:${port}`

  async function probe() {
    const answer = await getJson(`${probeUrl()}/api/status`)
    // The start screen's /api/status always carries `ready`; anything else on the port is not it.
    if (answer?.status === 200 && answer.body && "ready" in answer.body) {
      state.url = probeUrl()
      state.ready = true
      state.editing =
        answer.body.ready && answer.body.url
          ? { url: answer.body.url, projectRoot: answer.body.editing?.projectRoot ?? null, packageName: answer.body.editing?.packageName ?? null }
          : null
      return true
    }
    state.ready = false
    state.editing = null
    return false
  }

  function spawnStartScreen() {
    fs.mkdirSync(logDir, { recursive: true })
    const out = fs.openSync(path.join(logDir, "start-screen.log"), "a")
    const args = [path.join(repoRoot, "cli.mjs"), "--start", "--no-open"]
    if (port !== PREFERRED_START_SCREEN_PORT) args.push("--start-screen-port", String(port))
    // cwd is home, not the repo: the start screen then loads no project config,
    // and each chosen app is started with its own --project-root anyway.
    child = spawn(process.execPath, args, {
      cwd: os.homedir(),
      stdio: ["ignore", "pipe", out],
      env: { ...process.env, FORCE_COLOR: "0" },
    })
    fs.closeSync(out)
    startedAt = Date.now()
    state.owned = true
    state.pid = child.pid
    state.state = "starting"
    state.detail = "Starting the start screen…"
    log(`[desk] started start screen pid ${child.pid}: node ${args.join(" ")}`)
    const logStream = fs.createWriteStream(path.join(logDir, "start-screen.log"), { flags: "a" })
    let pending = ""
    child.stdout.on("data", (chunk) => {
      logStream.write(chunk)
      pending += chunk.toString()
      let nl
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        // cli.mjs prints this once it has bound (on 3455, or wherever the OS put it).
        const match = line.match(/open (http:\/\/[^\s]+) to choose an app/)
        if (match) spawnedUrl = match[1]
      }
    })
    child.once("exit", (code, signal) => {
      logStream.end()
      log(`[desk] start screen exited (${signal ?? code})`)
      child = null
      spawnedUrl = null
      state.ready = false
      state.pid = null
      if (stopped) return
      if (Date.now() - startedAt > 60000) backoffMs = 1000
      state.restarts += 1
      state.state = "backoff"
      state.detail = `The start screen stopped (${signal ?? `code ${code}`}). Restarting in ${Math.round(backoffMs / 1000)} s — see ~/Library/Logs/DesignLayer/start-screen.log.`
      clearTimeout(timer)
      timer = setTimeout(tick, backoffMs)
      backoffMs = Math.min(backoffMs * 2, 30000)
    })
  }

  async function tick() {
    if (stopped) return
    clearTimeout(timer)
    const up = await probe()
    if (up) {
      state.state = child ? "running" : "external"
      state.owned = Boolean(child)
      state.detail = null
    } else if (!child) {
      spawnStartScreen()
    }
    timer = setTimeout(tick, up ? 5000 : 700)
  }

  return {
    state,
    start() {
      if (enabled) tick()
    },
    /** Health reads call this so the page sees the start screen within one poll. */
    async refresh() {
      if (enabled && !stopped) await probe()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      if (child) child.kill("SIGTERM")
    },
  }
}

/**
 * CORS for the editor, which lives on another loopback port.
 *
 * "Open in Mac app" is a POST from the chrome in a browser tab, a different
 * origin from the desk, so the answer needs `Access-Control-Allow-Origin` to be
 * readable there. Only a loopback Origin is echoed; `isLocalRequest` has
 * already refused the rest.
 */
function corsHeaders(req) {
  const origin = req.headers.origin
  return origin && isLoopbackHost(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {}
}

/**
 * A page the Mac app may be asked to open: an http(s) URL on this machine's
 * loopback, and not the desk itself (the desk inside one of its own tabs is not
 * an editor). Anything else is refused with a sentence the editor can show.
 */
export function openableUrl(value, deskPort) {
  let url
  try {
    url = new URL(String(value ?? ""))
  } catch {
    return { error: "Open needs a full URL, like http://127.0.0.1:3466/studio" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "Only http pages can open in the Mac app" }
  if (!isLoopbackHost(url.host)) return { error: "Only pages on this Mac (127.0.0.1 or localhost) can open in the Mac app" }
  if (Number(url.port) === Number(deskPort)) return { error: "That is the Mac app's own page" }
  // One spelling of this machine. The desk and every editor it lists are on
  // 127.0.0.1, and a frame on `localhost` would be a different site from the
  // page around it, with its storage partitioned away from theirs.
  if (url.hostname === "localhost") url.hostname = LOOPBACK
  return { url: url.href }
}

const SHIM = path.join(os.homedir(), "Applications", "Chrome Apps.localized", "DesignLayer.app")
const shimInstalled = () => fs.existsSync(path.join(SHIM, "Contents", "MacOS", "app_mode_loader"))
let lastLaunch = 0

/**
 * Brings the Mac app forward, launching it if it is not running, and says
 * whether it did anything.
 *
 * `open` on the installed shim is what clicking the Dock icon does: it raises
 * the window that is up, or launches the app. It also passes APP_FEATURES,
 * which the shim hands on to the Chrome it starts (`open` passes arguments
 * only when it launches). Without the shim (the `--app-window` fallback) there
 * is no app to raise, only Chrome, and starting it again opens a second window
 * instead of raising the first. So that path runs only while no window is
 * listening and no launch is already under way; a window that is up gets the
 * page over its event stream either way.
 */
function activateApp(deskUrl, { listening = 0 } = {}) {
  const done = (error) => {
    if (error) console.warn(`${new Date().toISOString()} [desk] could not bring the app forward: ${error.message}`)
  }
  if (shimInstalled()) {
    execFile("/usr/bin/open", [SHIM, "--args", APP_FEATURES], done)
    return true
  }
  if (listening > 0 || Date.now() - lastLaunch < 15_000) return false
  lastLaunch = Date.now()
  // The same command line as install.mjs --app-window.
  const child = spawn(
    CHROME_BINARY,
    [`--user-data-dir=${chromeProfileDir()}`, `--app=${deskUrl}/`, "--no-first-run", "--no-default-browser-check", APP_FEATURES],
    { detached: true, stdio: "ignore" }
  )
  child.on("error", done)
  child.unref()
  return true
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shimRunning = () => {
  try {
    execFileSync("/usr/bin/pgrep", ["-f", path.join(SHIM, "Contents", "MacOS", "app_mode_loader")])
    return true
  } catch {
    return false
  }
}

/**
 * Quits the app's Chrome and opens the app again with APP_FEATURES.
 *
 * Chrome quits cleanly on SIGTERM and the window's tabs are in localStorage, so
 * the window comes back as it was. The shim goes away with its Chrome; `open`
 * waits for that, because a shim still running would only be raised, and its
 * arguments dropped.
 */
async function relaunchApp() {
  if (!(await quitProfileChrome(chromeProfileDir()))) return false
  for (let waited = 0; waited < 5000 && shimRunning(); waited += 250) await sleep(250)
  execFile("/usr/bin/open", [SHIM, "--args", APP_FEATURES], (error) => {
    if (error) console.warn(`${new Date().toISOString()} [desk] could not reopen the app: ${error.message}`)
  })
  return true
}

/**
 * Pages waiting to be opened, and the windows listening for them.
 *
 * A request made while the app window is up goes straight to it over the event
 * stream. One made while it is closed waits here — for a minute at most, so a
 * stale request does not ambush the next launch — and is handed to the first
 * window that connects, which is usually the launch the request caused.
 *
 * The app's own windows come first. The desk page can also be open in an
 * ordinary browser tab, and that tab takes a page only when no app window is
 * up: "Open in Mac app" should land in the app.
 */
export function createHandoff({ maxAgeMs = 60_000 } = {}) {
  const clients = new Map()
  let pending = []
  let nextId = 1
  const fresh = (item) => Date.now() - item.at < maxAgeMs
  const write = (res, item) => res.write(`event: open-url\ndata: ${JSON.stringify(item)}\n\n`)
  return {
    request(url) {
      const item = { id: nextId++, url, at: Date.now() }
      const apps = [...clients].filter(([, client]) => client.app).map(([res]) => res)
      const targets = apps.length ? apps : [...clients.keys()]
      for (const res of targets) write(res, item)
      if (!targets.length) pending = [...pending.filter(fresh), item].slice(-10)
      return { item, delivered: targets.length }
    },
    subscribe(res, { app = false } = {}) {
      clients.set(res, { app })
      const due = pending.filter(fresh)
      pending = []
      for (const item of due) write(res, item)
      return () => clients.delete(res)
    },
    get listening() {
      return clients.size
    },
  }
}

async function readBody(req, limit = 16 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 })
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString("utf8").trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error("Request body must be JSON"), { status: 400 })
  }
}

function send(res, status, type, body, extra = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
  res.writeHead(status, {
    "content-type": type,
    "content-length": String(buffer.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  })
  res.end(buffer)
}
const sendJson = (res, status, payload, extra) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(payload), extra)

let picking = null
function pickFolder() {
  // One dialog at a time; a second press waits for the first answer.
  picking ??= new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Choose your app folder")'],
      { timeout: 10 * 60 * 1000 },
      (error, stdout, stderr) => {
        picking = null
        if (error) {
          // -128 is "User canceled."
          if (/-128/.test(String(stderr)) || /-128/.test(String(error.message))) resolve({ cancelled: true })
          else resolve({ error: String(stderr || error.message).trim() })
          return
        }
        resolve({ path: stdout.trim().replace(/\/$/, "") || "/" })
      }
    )
  })
  return picking
}

export async function createDeskServer({
  port = DEFAULT_DESK_PORT,
  repoRoot = REPO_ROOT,
  supervise = true,
  startScreenPort = PREFERRED_START_SCREEN_PORT,
  logDir = path.join(os.homedir(), "Library", "Logs", "DesignLayer"),
  log = (line) => console.log(`${new Date().toISOString()} ${line}`),
  pickFolder: picker = pickFolder,
  activate = activateApp,
  // The app's Chrome command line, or null with no app running; and how to
  // restart it. Both are replaced in tests.
  appChromeCommand = () => (shimInstalled() ? profileChromeCommand(chromeProfileDir()) : null),
  relaunch = relaunchApp,
} = {}) {
  const supervisor = createSupervisor({ repoRoot, port: startScreenPort, logDir, enabled: supervise, log })
  const handoff = createHandoff()
  const startedAt = Date.now()
  const iconsDir = path.join(HERE, "icons")
  const origin = () => `http://${LOOPBACK}:${server.address().port}`

  /*
   * The Dock icon runs the shim with no arguments, so an app opened from the
   * Dock runs in a Chrome without APP_FEATURES, and the title-bar toggle and
   * the Extensions button are back. Its window connecting is the first sign of
   * that, so the desk restarts the app then, with the features.
   *
   * Once, not twice in a row: an app that comes back without them means this
   * Chrome no longer passes them on, and trying again would only close and
   * reopen the window every time it connects.
   */
  let relaunchedAt = 0
  let relaunchGaveUp = false
  function keepAppFeatures() {
    if (relaunchGaveUp) return
    const command = appChromeCommand()
    if (!command || command.includes(APP_FEATURES)) return
    if (Date.now() - relaunchedAt < 120_000) {
      relaunchGaveUp = true
      log(`[desk] the app came back without ${APP_FEATURES}; leaving it as it is`)
      return
    }
    relaunchedAt = Date.now()
    log(`[desk] the app is running without ${APP_FEATURES} (opened from the Dock): restarting it`)
    Promise.resolve(relaunch()).catch((error) => log(`[desk] could not restart the app: ${error.message}`))
  }

  const routes = {
    "GET /": (_req, res) =>
      send(res, 200, "text/html; charset=utf-8", shellPage({ repoRoot }), {
        "content-security-policy": "frame-ancestors 'none'",
        "x-frame-options": "DENY",
      }),
    "GET /offline.html": (_req, res) => send(res, 200, "text/html; charset=utf-8", offlinePage({ repoRoot })),
    "GET /manifest.webmanifest": (_req, res) =>
      send(res, 200, "application/manifest+json; charset=utf-8", JSON.stringify(manifest(), null, 2)),
    "GET /sw.js": (_req, res) =>
      send(res, 200, "text/javascript; charset=utf-8", SERVICE_WORKER, { "service-worker-allowed": "/" }),
    "GET /api/health": async (_req, res) => {
      await supervisor.refresh()
      const s = supervisor.state
      sendJson(res, 200, {
        ok: true,
        name: "designlayer-desk",
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        node: process.execPath,
        repoRoot,
        startScreen: {
          state: s.state,
          ready: s.ready,
          url: s.url,
          owned: s.owned,
          pid: s.pid,
          restarts: s.restarts,
          detail: s.detail,
          editing: s.editing,
        },
        app: { installed: shimInstalled(), windows: handoff.listening },
      })
    },
    "GET /api/editors": (_req, res) => sendJson(res, 200, { editors: normalizeEditors(listEditors()) }),
    "POST /api/pick-folder": async (_req, res) => {
      const result = await picker()
      sendJson(res, result.error ? 500 : 200, result)
    },
    // "Open in Mac app" from an editor in a browser tab. The editor sends its
    // JSON as text/plain, which needs no preflight; OPTIONS below answers for
    // any client that sends application/json instead.
    "POST /api/open": async (req, res) => {
      const cors = corsHeaders(req)
      const raw = await readBody(req)
      const body = raw && typeof raw === "object" ? raw : {}
      const target = openableUrl(body.url, server.address().port)
      if (target.error) return sendJson(res, 400, { error: target.error }, cors)
      const { item, delivered } = handoff.request(target.url)
      // `activate: false` hands the page over without raising a window, for a
      // caller that is checking the hand-off rather than using it.
      const launched = body.activate !== false && Boolean(activate(origin(), { listening: handoff.listening }))
      log(`[desk] open ${item.url}: ${delivered ? `sent to ${delivered} window(s)` : "held for the next window"}${launched ? ", app raised" : ""}`)
      sendJson(res, 200, { ok: true, id: item.id, url: item.url, delivered, launched }, cors)
    },
    "OPTIONS /api/open": (req, res) => {
      res.writeHead(204, {
        ...corsHeaders(req),
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
        "cache-control": "no-store",
      })
      res.end()
    },
    // The desk page's side of the hand-off: one event per page to open.
    "GET /api/events": (req, res, url) => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      })
      // EventSource reconnects on its own; two seconds matches the page's poll.
      res.write("retry: 2000\n\n")
      const app = url.searchParams.get("window") === "app"
      const unsubscribe = handoff.subscribe(res, { app })
      if (app) keepAppFeatures()
      // A comment now and then keeps an idle stream from being taken for dead.
      const beat = setInterval(() => res.write(": keep-alive\n\n"), 25_000)
      res.on("error", () => {})
      req.on("close", () => {
        clearInterval(beat)
        unsubscribe()
      })
    },
  }

  async function route(req, res) {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}`)
    const icon = req.method === "GET" && ICONS.get(url.pathname)
    if (icon) {
      return send(res, 200, icon[1], fs.readFileSync(path.join(iconsDir, icon[0])), { "cache-control": "max-age=3600" })
    }
    const handler = routes[`${req.method} ${url.pathname}`]
    if (handler) return handler(req, res, url)
    const methods = Object.keys(routes)
      .filter((key) => key.endsWith(` ${url.pathname}`) && !key.startsWith("OPTIONS "))
      .map((key) => key.split(" ")[0])
    if (methods.length) return sendJson(res, 405, { error: `${url.pathname} accepts ${methods.join(", ")} only` })
    sendJson(res, 404, { error: `No desk route for ${url.pathname}` })
  }

  const server = http.createServer((req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: "The DesignLayer desk is loopback-only" })
    route(req, res).catch((error) => {
      if (res.headersSent) return res.end()
      sendJson(res, error?.status ?? 500, { error: error?.message ?? "desk route failed" }, corsHeaders(req))
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, LOOPBACK, () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  supervisor.start()

  return {
    url: `http://${LOOPBACK}:${server.address().port}`,
    port: server.address().port,
    supervisor,
    close() {
      supervisor.stop()
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function isDirectRun() {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectRun()) {
  const port = Number(process.env.DESIGNLAYER_DESK_PORT) || DEFAULT_DESK_PORT
  const startScreenPort = Number(process.env.DESIGNLAYER_START_SCREEN_PORT) || PREFERRED_START_SCREEN_PORT
  try {
    const desk = await createDeskServer({ port, startScreenPort, supervise: process.env.DESIGNLAYER_DESK_SUPERVISE !== "0" })
    console.log(`${new Date().toISOString()} [desk] serving ${desk.url} (node ${process.version}, pid ${process.pid})`)
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, async () => {
        await desk.close()
        process.exit(0)
      })
    }
  } catch (error) {
    console.error(`${new Date().toISOString()} [desk] could not start: ${error.message}`)
    // Non-zero so launchd's KeepAlive {SuccessfulExit:false} retries (e.g. port still held).
    process.exit(1)
  }
}
