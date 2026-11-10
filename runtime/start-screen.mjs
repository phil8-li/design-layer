/**
 * The start screen's HTTP server, and the handoff back to cli.mjs.
 *
 * Until now the only way in was `designlayer --dev 3000`, so the port, the
 * project root and the dev script all had to be known before anything was on
 * screen. This server is the other order: bind on loopback first, let the page
 * ask what is running and what is on disk, and hand each validated choice to
 * the supervisor in cli.mjs, which loads that project's config and boots the
 * proxy in a child process.
 *
 * One choice used to be all there was: `/api/start` latched shut after the
 * first press and the page redirected to the editor forever after, so the only
 * way to design a different app was to kill the process. The handoff is a
 * sequence now — `nextChoice()` for each choice, `nextStop()` for each Stop,
 * and `reportReady` and `reportStopped` for what became of each editor — and
 * this server outlives every editor it hands off to.
 *
 * And several editors run at once, one per app. The supervisor used to run one
 * and kill it on every choice, so opening a second app in a new tab of the Mac
 * app took the first app's editor away from the tab still showing it. Each
 * choice is an editor of its own now, with an id; a choice for an app that
 * already has one returns that one, and only Stop, a crash, or a choice that
 * replaces it (same app port, another folder) ends it. The editor machine is
 * in `createStartScreen`.
 *
 * What a choice is made of, and every refusal of one, is in
 * runtime/start-choice.mjs.
 */

import { createRequire } from "node:module"
import path from "node:path"

import { appName } from "./app-name.mjs"
import { listEditors } from "./editor-registry.mjs"
import { lastPage } from "./last-pages.mjs"
import { DEFAULT_SCAN_PORTS, describeProject, projectRootForPort, scanLocalApps } from "./local-apps.mjs"
import {
  badRequest,
  inBrowser,
  isLoopbackHost,
  parseAppUrl,
  pastedPath,
  portOfOrigin,
  realFolder,
  resolveDevScript,
  resolveProject,
} from "./start-choice.mjs"
import { startScreenPage } from "./start-screen-page.mjs"

/*
 * Required, not imported. An ES module import of `node:http` copies every one
 * of its exports into a module namespace, and that copy reads the lazy getters
 * Node keeps for the fetch-era globals — loading all of undici, ~8ms measured,
 * before this server can bind. Nothing here needs undici until the first app
 * scan, whose first `fetch` loads it then.
 */
const http = createRequire(import.meta.url)("node:http")

const LOOPBACK = "127.0.0.1"
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

/**
 * The port the chooser asks for first.
 *
 * It used to take whatever the OS handed out, which was fine while the screen
 * was transient — it existed for one press and then the browser left it. Now it
 * is the address the user comes back to all session, to see what is running or
 * to switch apps, so it has to be one they can guess: 3455 sits directly under
 * the proxy's 3456 and the edit socket's 3457.
 *
 * Preferred, not required. Something else on 3455 — a second designlayer, or
 * an unrelated server — is no reason to refuse to start, so the OS picks
 * instead and the banner says where it landed.
 */
export const PREFERRED_START_SCREEN_PORT = 3455
// The only body this server accepts is three short strings.
const MAX_BODY_BYTES = 16 * 1024
/** How long one app scan answers repeat asks. See `scanApps`. */
const SCAN_REUSE_MS = 3000
/** How many editors that ended are remembered, for a tab still polling one. */
const MAX_ENDED = 50
/** A moment for the page's next poll to see "updated" before the restart. */
const RESTART_DELAY_MS = 600

/**
 * Mirrors `isLocalRequest` in server/routes.mjs, including the reason `"null"`
 * is refused: that is the Origin a sandboxed iframe or a `data:`/`blob:`
 * document sends, which are precisely the contexts an attacker controls. A
 * genuinely absent header still passes — curl carries no ambient credentials.
 * Not imported from there: that module builds the options store and the agent,
 * and this server runs before there is a project to build either against.
 */
function isLocalRequest(req) {
  if (!LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress ?? "")) return false
  if (!isLoopbackHost(req.headers.host)) return false
  const origin = req.headers.origin
  if (origin !== undefined && !isLoopbackHost(origin)) return false
  return true
}

function send(res, statusCode, contentType, payload) {
  const body = Buffer.from(payload)
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
  })
  res.end(body)
}

const sendJson = (res, statusCode, payload) =>
  send(res, statusCode, "application/json; charset=utf-8", JSON.stringify(payload))

function isJsonRequest(req) {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase()
  return type === "application/json"
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw badRequest("Request body is too large", 413)
    chunks.push(chunk)
  }
  if (size === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw badRequest("Request body is not valid JSON")
  }
}

/**
 * Things the supervisor has to act on, in order, whenever it next asks.
 *
 * One pending promise was enough while a latch kept a second press out until
 * the first was handled. Without the latch two presses can land while the
 * supervisor is still spawning, and the second must not be lost, so items wait
 * here until `next()` takes them.
 *
 * A promise handed out may have nothing attached when `close()` rejects it —
 * the supervisor is often busy elsewhere — so each is marked handled here;
 * whoever does await it still sees the rejection.
 */
function openQueue(closedMessage) {
  const items = []
  const waiters = []
  let closed = false
  const settled = (promise) => {
    promise.catch(() => {})
    return promise
  }
  return {
    push(item) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(item)
      else items.push(item)
    },
    next() {
      if (items.length > 0) return settled(Promise.resolve(items.shift()))
      if (closed) return settled(Promise.reject(new Error(closedMessage)))
      return settled(new Promise((resolve, reject) => waiters.push({ resolve, reject })))
    },
    close() {
      closed = true
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(closedMessage))
    },
  }
}

/**
 * Serves the start screen and hands over each choice the user makes.
 *
 * The port defaults to the preferred one rather than to 0, because the caller
 * that matters — the supervisor in cli.mjs — keeps this screen up for the whole
 * session and prints its URL as somewhere to come back to.
 *
 * THE EDITORS, by id. Every record carries `state`, an `EditorState`:
 *
 *   "starting"  chosen and handed to the supervisor; no proxy yet
 *   "ready"     its proxy is up (`url`, `editing`)
 *   "stopping"  Stop, or a choice that replaces it, asked it to go; its
 *               process may still be running
 *   "gone"      its process is over, or it never had one
 *
 * A stopping or gone record carries `reason`, the sentence a tab still polling
 * it is told. `transition(id, event)` is the one place a record moves:
 *
 *   (a choice)      --------------------> starting
 *   starting|ready  --ready(url)-------> ready
 *   starting|ready  --stop(reason)-----> stopping   (Stop, or replaced)
 *   starting|ready  --exit(reason)-----> gone       (a crash, a failed start)
 *   stopping        --exit-------------> gone       (keeps the reason it went with)
 *   stopping|gone   --ready------------> unchanged  (a late "ready" brings nothing back)
 *
 * "Live" is starting or ready. Only a live editor is listed, counted, resumed
 * after a restart, or answers a press for its app. A choice for an app whose
 * editor is still stopping names that editor in `replaces`, so the supervisor
 * waits for the old process to exit before it starts the new one: Stop then
 * Start used to run both at once, on two pairs of ports.
 *
 * The supervisor reports the exit of a stopping editor with `reportStopped`.
 * Until it does (a supervisor that reports only crashes), the record stays
 * stopping, out of every list, and a new choice for its app still waits on it.
 */
export async function createStartScreen({
  host = LOOPBACK,
  /*
   * The port to step aside from when it is taken. Only tests pass another: a
   * suite that checked the stepping aside on 3455 itself bound the port the
   * user's own start screen holds.
   */
  preferredPort = PREFERRED_START_SCREEN_PORT,
  port = preferredPort,
  log = console.log,
  /*
   * Options for the MCP endpoint this screen can serve between apps, or null
   * for none. Only the supervisor passes it: it is the one caller whose screen
   * outlives its editors, which is the whole reason to serve MCP from here.
   */
  mcp = null,
  /*
   * Called with the number of live editors (starting + ready) each time it
   * changes, beside the hub's own `editorsChanged`. For callers that watch
   * the count without serving MCP, tests among them.
   */
  onEditorsChanged = null,
  /*
   * The updater (runtime/updater.mjs) whose status this screen shows, or null
   * for none. Only the supervisor passes one, with `onRestart`: what to do
   * once an update is on disk. It is called with the editors to start again
   * after the restart, as `resume` takes them, once per entry into "updated",
   * and may return a promise; a throw or a rejection is told to the updater
   * (`restartFailed`), which the page then shows.
   */
  updater = null,
  onRestart = null,
} = {}) {
  if (!isLoopbackHost(host)) throw new Error(`The start screen is loopback-only and cannot bind ${host}`)

  // Imported only when asked for: it brings the MCP server and the config
  // defaults with it, which no other caller of this screen needs.
  const mcpHub = mcp ? (await import("./mcp-hub.mjs")).createMcpHub({ ...mcp, isLocalRequest, log }) : null

  /**
   * The hub's routes answer only an editor this screen started. The token
   * arrives in the child's environment; a page in the browser has no way to
   * learn it, and a custom header makes any cross-origin attempt preflight,
   * which this server never answers.
   */
  function hubFor(req) {
    if (!mcpHub || req.headers["x-designlayer-token"] !== mcpHub.token) {
      throw badRequest("Only an editor this start screen started can use its MCP endpoint.", 403)
    }
    return mcpHub
  }

  let closed = false
  /*
   * Every editor this screen started, by id, in start order: the live ones,
   * and the last MAX_ENDED that ended. A record:
   * { id, state, appUrl, appPort, projectRoot, packageName, devScript, path,
   *   url, editing, reason }.
   *
   * `path` is the page the browser lands on: the page the choice typed, else
   * the page that app was last used on, else "". It lives here rather than
   * travelling to the launcher because the launcher has no use for it: the
   * proxy serves the whole app either way. `url` is the proxy's origin once
   * the editor says it is up.
   */
  const records = new Map()
  /*
   * Every proxy port an editor of this screen has reported, kept after it
   * ends, so the registry's copy of one of ours is never taken for an editor
   * started elsewhere. Small by nature: ports are reused across a session.
   */
  const startedPorts = new Set()
  /*
   * The most recent choice. `/api/status` without an id answers for this one,
   * with the shape it had when there was only ever one editor, so callers
   * written for one stay correct.
   */
  let latest = null
  let nextId = 1
  const choices = openQueue("The start screen closed before an app was chosen")
  const stops = openQueue("The start screen closed")
  let reportedCount = 0

  const isLive = (record) => record.state === "starting" || record.state === "ready"
  const liveRecords = () => [...records.values()].filter(isLive)

  function liveCountChanged() {
    const count = liveRecords().length
    if (count === reportedCount) return
    reportedCount = count
    mcpHub?.editorsChanged?.(count)
    onEditorsChanged?.(count)
  }

  /** The one writer of a record's state. See the table above. False when the event does not apply. */
  function transition(id, event, { url = null, editing = null, reason = null } = {}) {
    const record = records.get(id)
    if (!record) return false
    if (event === "ready") {
      if (!isLive(record)) return false
      record.state = "ready"
      record.url = url
      record.editing = editing
    } else if (event === "stop") {
      if (!isLive(record)) return false
      record.state = "stopping"
      record.reason = reason
    } else if (event === "exit") {
      if (record.state === "gone") return false
      if (record.state !== "stopping") record.reason = reason
      record.state = "gone"
    } else {
      throw new Error(`No editor transition "${event}"`)
    }
    // Bounded: one sentence per editor ever ended would grow all session.
    const ended = [...records.values()].filter((other) => !isLive(other))
    for (const old of ended.slice(0, Math.max(0, ended.length - MAX_ENDED))) records.delete(old.id)
    liveCountChanged()
    return true
  }

  // The editor address a browser is sent to: on localhost, with its page.
  const browserUrl = (record) => (record.url ? inBrowser(record.url) + record.path : null)

  function editingOf(record) {
    return record.editing ?? {
      appUrl: record.appUrl,
      projectRoot: record.projectRoot,
      packageName: record.packageName,
      name: appName(record),
    }
  }

  /** The old one-editor answer, for one editor. */
  function statusOf(record) {
    if (record?.state === "ready") {
      return { ready: true, url: browserUrl(record), editing: editingOf(record), stopped: null }
    }
    return { ready: false, editing: null, stopped: record && !isLive(record) ? record.reason : null }
  }

  /** The editors to start again after a restart, in start order, as `resume` takes them. */
  function resumable() {
    return liveRecords().map((record) => ({
      url: record.appUrl + (record.path ?? ""),
      projectRoot: record.projectRoot,
      devScript: record.devScript ?? null,
    }))
  }

  function editorRow(record) {
    return {
      id: record.id,
      state: record.state,
      name: appName(record),
      appUrl: record.appUrl,
      appPort: record.appPort,
      projectRoot: record.projectRoot,
      packageName: record.packageName,
      url: record.state === "ready" ? browserUrl(record) : null,
    }
  }

  /*
   * The editor already running for a listed app, if any: one this screen
   * started, else one the registry knows of (started on its own, or by another
   * supervisor). Ready ones only — a starting editor has no address yet.
   */
  function editorForApp(app, registry) {
    const root = realFolder(app.projectRoot)
    const sameRoot = (other) => root === null || realFolder(other) === root
    const landing = (projectRoot) => lastPage({ port: app.port, projectRoot }) ?? ""
    for (const record of records.values()) {
      if (record.state !== "ready" || record.appPort !== app.port || !sameRoot(record.projectRoot)) continue
      return { id: record.id, url: inBrowser(record.url) + landing(record.projectRoot) }
    }
    for (const entry of registry) {
      if (entry.appPort !== app.port || startedPorts.has(entry.proxyPort) || !sameRoot(entry.projectRoot)) continue
      const url = entry.url ?? `http://${LOOPBACK}:${entry.proxyPort}`
      return { id: null, url: inBrowser(url) + landing(entry.projectRoot) }
    }
    return null
  }

  /*
   * A running editor for this app that this screen did not start, from the
   * registry, or null. Editors this screen started are left out even after
   * they end: one stopped a moment ago is still in the registry until its
   * process exits, and answering a fresh press with it would send the browser
   * to an editor on its way out.
   */
  function registryEditorFor(appPort, projectRoot) {
    let registry = []
    try {
      registry = listEditors()
    } catch {
      // A registry that cannot be read leaves only this screen's own editors.
      return null
    }
    const root = realFolder(projectRoot)
    return registry.find(
      (entry) => entry.appPort === appPort && !startedPorts.has(entry.proxyPort) && realFolder(entry.projectRoot) === root
    ) ?? null
  }

  /*
   * The last scan, reused for a few seconds, and the one in flight, shared.
   *
   * A full scan is ~50ms warm and up to the 1.5s probe ceiling while any app
   * is compiling, and it is asked for on every open of every editor's chooser
   * menu (server/apps.mjs relays here) as well as by this page. Opening the
   * menu twice in a row, or two tabs asking at once, is one question. The
   * window is short enough that an app started or stopped since still shows up
   * the next time anyone looks.
   */
  let lastScan = null
  let scanning = null
  /*
   * The scan looks at every listening port, so it has to be told which ones are
   * the editor's own. An editor runs from the folder of the project it edits,
   * and its proxy serves that project's pages: without this, each editor would
   * be listed as one more copy of the app it is editing.
   */
  function ownProcesses() {
    let editors = []
    try {
      editors = listEditors()
    } catch {
      // A registry that cannot be read costs the filter, never the scan.
    }
    const ports = editors.flatMap((entry) => [entry.proxyPort, entry.wsPort]).filter(Number.isInteger)
    if (server.listening) ports.push(server.address().port)
    return { pids: [process.pid, ...editors.map((entry) => entry.pid)], ports }
  }
  function scanApps() {
    if (lastScan && Date.now() - lastScan.at < SCAN_REUSE_MS) return Promise.resolve(lastScan.apps)
    scanning ??= scanLocalApps({ ports: DEFAULT_SCAN_PORTS, discover: ownProcesses() })
      .then((apps) => {
        lastScan = { at: Date.now(), apps }
        return apps
      })
      .finally(() => {
        scanning = null
      })
    return scanning
  }

  /*
   * A choice of app: from the page's POST /api/start, or from `resume` after
   * a restart. Throws a 4xx error for a choice that cannot start.
   */
  function startChoice(body) {
    const { appUrl, appPort, appPath } = parseAppUrl(body.url)
    const { projectRoot, manifest, packageName } = resolveProject(body.projectRoot)
    const devScript = resolveDevScript(body.devScript, projectRoot, manifest)
    /*
     * A bare address — a row click, or an origin typed alone — opens the page
     * that app was last used on. Copies of one template share a home page,
     * so opening the root of the app picked looked like a different app.
     */
    const remembered = lastPage({ port: appPort, projectRoot })

    /*
     * One app, one editor. A second press for an app already starting or
     * running — a double click, a page reloaded mid-boot, a second tab — is
     * that editor, and nothing is started or stopped for it.
     *
     * Every answer is `{ ok, id, existing, replaced, url }`. `url` is the
     * editor's address with its landing page once it is up, else null; a
     * caller handed `id: null` has no editor here to poll, and goes to `url`.
     */
    const live = liveRecords()
    const sameApp = live.find(
      (record) => record.appPort === appPort && realFolder(record.projectRoot) === realFolder(projectRoot)
    )
    if (sameApp) {
      sameApp.path = appPath || (remembered ?? sameApp.path)
      latest = sameApp.id
      return { ok: true, id: sameApp.id, existing: true, replaced: null, url: browserUrl(sameApp) }
    }

    /*
     * An editor this screen did not start counts too. `/api/apps` marks a
     * row as edited when the registry has one for it, so starting a second
     * here would put two editors on one app. That editor has no id on this
     * screen, so the answer carries its address instead.
     */
    const elsewhere = registryEditorFor(appPort, projectRoot)
    if (elsewhere) {
      return {
        ok: true,
        id: null,
        existing: true,
        replaced: null,
        url: inBrowser(elsewhere.url ?? `http://${LOOPBACK}:${elsewhere.proxyPort}`) + (appPath || (remembered ?? "")),
      }
    }

    // The same port from another folder is another app, and the port can only
    // be proxied for one of them: the old editor is replaced, and only it.
    const displaced = live.find((record) => record.appPort === appPort)
    if (displaced) {
      const queued = displaced.state === "starting"
      transition(displaced.id, "stop", {
        reason: `The editor for ${appName(displaced)} was replaced by ${appName({ projectRoot, packageName })}.`,
      })
      // One still starting may be waiting in the queue, and spawning it only
      // to kill it can start its dev server for nothing. It is cancelled
      // the way Stop cancels it; a spawned one is stopped by either path.
      if (queued) stops.push({ id: displaced.id })
    }
    // Else an editor of this app's port may still be on its way out (Stop,
    // then Start again before it exited). The new one waits for it.
    const stopping = displaced ? null : [...records.values()].findLast((record) => record.state === "stopping" && record.appPort === appPort)

    const id = String(nextId++)
    const choice = { id, appUrl, appPort, projectRoot, devScript, packageName, replaces: (displaced ?? stopping)?.id ?? null }
    records.set(id, {
      id,
      state: "starting",
      appUrl,
      appPort,
      projectRoot,
      packageName,
      devScript,
      path: appPath || (remembered ?? ""),
      url: null,
      editing: null,
      reason: null,
    })
    latest = id
    liveCountChanged()
    log(`[designlayer] editing ${appUrl}${appPath} from ${projectRoot}`)
    choices.push(choice)
    return { ok: true, id, existing: false, replaced: choice.replaces, url: null }
  }

  /*
   * One restart per entry into "updated", however many presses or tabs asked
   * for the update: the subscription is the only caller of `onRestart`. A
   * restart that throws becomes the updater's error, with the reason.
   */
  let restartTimer = null
  let updaterWas = updater?.status().state ?? null
  const unsubscribe = updater?.onChange((status) => {
    const entered = status.state === "updated" && updaterWas !== "updated"
    updaterWas = status.state
    if (!entered || !onRestart) return
    log("[designlayer] restarting to run the update")
    clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      Promise.resolve()
        .then(() => onRestart(resumable()))
        .catch((error) => updater.restartFailed(error?.message ?? String(error)))
    }, RESTART_DELAY_MS)
  })

  // The page is a pure function of modules already loaded, so it is built once,
  // on the first ask, rather than as ~73KB of template on every load.
  let page = null

  // Read-only and stateless, all of them, except `/api/start` and `/api/stop`
  // — which are the point — the update, and the MCP routes at the end, which
  // only an editor can call.
  const routes = {
    "GET /": (_req, res) => send(res, 200, "text/html; charset=utf-8", (page ??= startScreenPage())),
    /*
     * Each row also says whether that app already has an editor, so opening it
     * goes to that editor instead of starting another. Worked out per answer,
     * not cached with the scan: editors come and go faster than it expires.
     */
    "GET /api/apps": async (_req, res) => {
      const apps = await scanApps()
      let registry = []
      try {
        registry = listEditors()
      } catch {
        // A registry that cannot be read costs rows their editor, never the list.
      }
      sendJson(res, 200, { apps: apps.map((app) => ({ ...app, editor: editorForApp(app, registry) })) })
    },
    /*
     * The folder behind a typed address. The scan answers for every app it
     * listed; an address it did not list is asked of the process on that port.
     * `project` is null when neither knows, which the page says out loud.
     */
    "GET /api/app-folder": async (_req, res, url) => {
      const { appPort } = parseAppUrl(url.searchParams.get("url") ?? "")
      const listed = (await scanApps()).find((app) => app.port === appPort)
      const root = listed ? listed.projectRoot : await projectRootForPort(appPort)
      sendJson(res, 200, { project: root ? describeProject(root) : null })
    },
    "GET /api/project": (_req, res, url) => {
      const dir = pastedPath(url.searchParams.get("path") ?? "")
      if (!path.isAbsolute(dir)) throw badRequest("Ask for a folder by its full path.")
      sendJson(res, 200, { project: describeProject(dir) })
    },
    /*
     * What the page needs to decide which face to show: the editor's URL if one
     * is up, what it is editing so a tab that merely arrived here can be told,
     * and the sentence explaining an editor that is gone. `ready`, `url`,
     * `editing` and `stopped` keep the shape they had when there was one
     * editor, and answer for the most recent choice; `editors` lists the live
     * ones.
     *
     * `?id=` asks about one editor. A stopping editor already answers with
     * the sentence it was stopped with, as a gone one does. An id this screen
     * does not know — an editor stopped long ago, or a screen restarted since
     * — answers with a sentence rather than a 404, so a poller stops instead
     * of retrying.
     *
     * Every URL is the proxy's origin with the page put back on: this is where
     * the two halves of the typed address meet again, so the tab that presses
     * Start and the card's "Continue" link both go to the same place.
     */
    "GET /api/status": (_req, res, url) => {
      const id = url.searchParams.get("id")
      if (id !== null) {
        const record = records.get(id)
        if (record) {
          const { ready, url: editorUrl, editing, stopped } = statusOf(record)
          sendJson(res, 200, ready ? { ready, url: editorUrl, editing, stopped } : { ready, editing, stopped })
          return
        }
        sendJson(res, 200, {
          ready: false,
          editing: null,
          stopped: "That editor is no longer running. Choose an app to start again.",
        })
        return
      }
      const status = statusOf(latest === null ? null : records.get(latest))
      sendJson(res, 200, { ...status, editors: liveRecords().map(editorRow) })
    },
    "POST /api/start": async (req, res) => {
      const body = await readJsonBody(req)
      if (!body) throw badRequest("Choose an app and a project folder before starting.")
      sendJson(res, 200, startChoice(body))
    },
    /*
     * Stop one editor, and only that one. The supervisor does the killing; the
     * record turns "stopping" now, so the editor leaves every list the moment
     * Stop is pressed rather than when its process gets round to exiting.
     */
    "POST /api/stop": async (req, res) => {
      const body = (await readJsonBody(req)) ?? {}
      const id = typeof body.id === "string" ? body.id : String(body.id ?? "")
      const record = records.get(id)
      if (!record || !isLive(record)) throw badRequest("No editor with that id is running.", 404)
      transition(id, "stop", { reason: `The editor for ${appName(record)} was stopped. Choose an app to start again.` })
      log(`[designlayer] stopping the editor for ${appName(record)}`)
      stops.push({ id })
      sendJson(res, 200, { ok: true })
    },
    // "Stay on between apps": where the endpoint is, a send to record on it,
    // and the switch itself. See runtime/mcp-hub.mjs.
    "GET /api/mcp": (req, res) => sendJson(res, 200, hubFor(req).status()),
    "POST /api/mcp/push": async (req, res) => {
      const hub = hubFor(req)
      sendJson(res, 200, hub.push((await readJsonBody(req)) ?? {}))
    },
    "POST /api/mcp/stay": async (req, res) => {
      const hub = hubFor(req)
      const body = (await readJsonBody(req)) ?? {}
      sendJson(res, 200, await hub.stay(body.on === true, Array.isArray(body.pending) ? body.pending : []))
    },
    /*
     * Updates (runtime/updater.mjs). `openEditors` lets the page say what a
     * restart touches. `off` means this screen was started without an
     * updater, which only tests and embedders do.
     */
    "GET /api/update": (_req, res) =>
      sendJson(res, 200, updater ? { ...updater.status(), openEditors: liveRecords().length } : { state: "off" }),
    /*
     * Update, then restart: one press. It answers at once, since an update
     * takes up to a few minutes, and the answer already says "updating"; the
     * page follows along on GET /api/update, and through the restart, when
     * this server is briefly gone. The restart itself is the subscription
     * above, so a second press, or a second tab, is the same update.
     */
    "POST /api/update/apply": (_req, res) => {
      if (!updater) throw badRequest("This start screen has no updater.", 404)
      void updater.apply()
      sendJson(res, 202, { ...updater.status(), openEditors: liveRecords().length })
    },
  }

  // The URL is parsed in here rather than in the listener so that a malformed
  // request line answers through the one error path instead of throwing at the
  // server, where an uncaught exception would take the CLI down with it.
  async function route(req, res) {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}`)
    const handler = routes[`${req.method} ${url.pathname}`]
    /*
     * Every POST here changes something, and a form or a `text/plain` fetch
     * from any page on a loopback origin (a dev server, a proxied app) reaches
     * this server without a preflight: the Origin check passes, since that
     * page IS on loopback. A JSON body needs a preflight this server never
     * answers, so requiring one leaves only the page and its own callers.
     */
    if (handler && req.method === "POST" && !isJsonRequest(req)) {
      throw badRequest("Send the request body as JSON (content-type: application/json).", 415)
    }
    if (handler) return handler(req, res, url)
    const known = Object.keys(routes).find((key) => key.endsWith(` ${url.pathname}`))
    throw known
      ? badRequest(`${url.pathname} accepts ${known.split(" ")[0]} only`, 405)
      : badRequest(`No start screen route for ${url.pathname}`, 404)
  }

  const server = http.createServer((req, res) => {
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { error: "The start screen is loopback-only" })
      return
    }

    route(req, res).catch((error) => {
      if (res.headersSent) {
        res.end()
        return
      }
      sendJson(res, Number(error?.statusCode) || 500, {
        error: error?.message ?? "The start screen could not handle that request",
      })
    })
  })

  function listenOn(candidate) {
    return new Promise((resolve, reject) => {
      const onError = (error) => reject(error)
      server.once("error", onError)
      server.listen(candidate, host, () => {
        server.removeListener("error", onError)
        resolve()
      })
    })
  }

  try {
    await listenOn(port)
  } catch (error) {
    // Only the preferred port steps aside. A port asked for by name is a port
    // somebody is pointing something else at, so a silent move would be worse
    // than the refusal.
    if (error.code !== "EADDRINUSE" || port !== preferredPort) throw error
    await listenOn(0)
  }

  await mcpHub?.boot()

  return {
    url: `http://${host}:${server.address().port}`,
    /** Handed to each editor this screen starts, so it can reach the routes above. */
    mcpToken: mcpHub?.token ?? null,

    /**
     * The next choice that needs a process, whenever the user makes it:
     * `{ id, appUrl, appPort, projectRoot, devScript, packageName, replaces }`.
     *
     * A press for an app that already has an editor is answered here and never
     * reaches this queue. `replaces` is the id of the one editor to stop and
     * wait for first — same app port, another folder; or an editor of that
     * port still stopping — or null; no other editor is touched. Choices
     * queue, so two presses that land while the supervisor is busy spawning
     * are both delivered.
     */
    nextChoice() {
      return choices.next()
    },

    /**
     * The next editor the user asked to stop with POST /api/stop, or a
     * replaced one still starting: `{ id }`.
     *
     * The record is already "stopping" when this resolves; the supervisor's
     * part is to end the process, quietly, since the reason is already on
     * record, and then to say so with `reportStopped`. Rejects when the screen
     * closes, like `nextChoice`.
     */
    nextStop() {
      return stops.next()
    },

    /**
     * Starts again the editors a restart stopped (`resumable` above, through
     * runtime/updater.mjs `saveResume`). One that can no longer start, such
     * as a deleted folder, is skipped and logged.
     */
    resume(entries) {
      for (const entry of entries) {
        try {
          startChoice(entry)
        } catch (error) {
          log(`[designlayer] could not reopen ${entry.url} after the restart: ${error.message}`)
        }
      }
    },

    /**
     * Editor `id`'s proxy is up at `url`, said in memory over the supervisor's
     * IPC rather than through the endpoint file, which fails outright when the
     * project folder is somewhere macOS will not let this process write.
     *
     * `current` is what the editor is editing, for the tab that arrives here
     * later and has to be told what is already running rather than bounced into
     * it. An id this screen has let go of — stopped or replaced while it
     * booted — is ignored, so a late "ready" cannot bring an editor back.
     */
    reportReady(url, current, id) {
      // Ours even when ignored below: a replaced editor still running is in
      // the registry until it exits.
      const port = portOfOrigin(url)
      if (port) startedPorts.add(port)
      transition(String(id), "ready", {
        url,
        editing: current ? { ...current, name: current.name ?? appName(current) } : null,
      })
    },

    /**
     * Editor `id`'s process is over. On its own — it crashed, its port was
     * taken, its project turned out not to be one — `reason` is the sentence
     * the screen carries for a tab polling it, rather than leaving a page that
     * polls forever for a process nobody is running. After a Stop or a
     * replacement it keeps the reason it was stopped with.
     */
    reportStopped(reason, id) {
      transition(String(id), "exit", { reason })
    },

    close() {
      if (closed) return
      closed = true
      unsubscribe?.()
      clearTimeout(restartTimer)
      choices.close()
      stops.close()
      // The page holds a keep-alive socket open for its status poll, and
      // `close()` alone waits for it — leaving the CLI on a screen nobody is
      // looking at any more.
      server.closeAllConnections()
      server.close()
      void mcpHub?.close()
    },
  }
}
