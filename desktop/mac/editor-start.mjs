/**
 * Starting a stopped tab's editor again: the desk's side of
 * POST /api/editors/start (desk-server.mjs).
 *
 * A tab whose editor ended keeps its app ("<project folder>|<app port>"), and
 * the start screen already starts an editor for an app, once
 * (POST /api/start, runtime/start-screen.mjs). The window cannot ask it
 * itself: the start screen is another origin, and it takes only JSON, which
 * needs a preflight it never answers. So the desk asks for the window.
 *
 * Every answer is one of:
 *
 *   ready        { url }      the editor is up; url is the start screen's, with its landing page
 *   starting     { id }       asked for, not up yet; the window asks again with the id
 *   not-running  { address }  nothing answers on the app's port: nothing was started
 *   other-app    { address }  another folder has the port: its app answers there, or a live
 *                             editor is on it; nothing was started
 *   failed       { message? } the start screen refused, or the editor stopped while starting
 *   unavailable               no start screen to ask (HTTP 503); the window asks again later
 *
 * The port is probed before anything starts so the window can ask every poll
 * for free while the app is down: an editor spawned against a dead port only
 * exits with "Nothing is listening…". The folder is checked because copies
 * of one template run on one port at different times, and an editor for
 * folder A against folder B's server would map edits to the wrong source.
 * The scan behind that check names the nearest package.json to the app's
 * process, so a folder above or below the tab's (a monorepo root over
 * apps/web) is the same project; a sibling is another app. Any live editor on
 * the port for another folder also stops the ask, exactly, even when the
 * start screen cannot say whose app answers there: the start screen replaces
 * such an editor on any difference (startChoice), and opening a tab must
 * never stop an editor someone is using.
 *
 * An id the window sends back is the start screen's, and its ids start at 1
 * again when it restarts: by then the id can name another app's editor. Its
 * "ready" counts only when the editor it names is this app on this port;
 * otherwise the ask goes on as one without an id.
 */

import http from "node:http"
import path from "node:path"

import { loopbackHostFor } from "../../runtime/dev-server.mjs"
import { portOfOrigin, realFolder } from "../../runtime/start-choice.mjs"

const LOOPBACK = "127.0.0.1"

/** Whether one folder is the other or inside it, by whole path segments. */
function within(child, parent) {
  const rel = path.relative(parent, child)
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
}

/** The folder and port of a tab's app, split at the last "|", or a sentence saying what is wrong. */
export function parseApp(value) {
  if (typeof value !== "string" || value.length > 4096) return { error: "Starting an editor needs the tab's app: its project folder and port." }
  const cut = value.lastIndexOf("|")
  const folder = cut < 0 ? "" : value.slice(0, cut)
  const portText = cut < 0 ? "" : value.slice(cut + 1)
  if (!folder || !path.isAbsolute(folder)) return { error: "The tab's app needs the full path of its project folder." }
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN
  if (!(port >= 1 && port <= 65535)) return { error: "The tab's app needs a port from 1 to 65535." }
  return { folder, port }
}

/**
 * One JSON request to the start screen. Resolves { status, body } (body null
 * when it is not JSON), or null when nothing answered within `timeoutMs`: a
 * start screen that hangs must not hang the window's ask.
 */
function callJson(url, { method = "GET", body, timeoutMs }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const headers = payload ? { "content-type": "application/json", "content-length": String(payload.byteLength) } : {}
    const req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        let parsed = null
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        } catch {}
        resolve({ status: res.statusCode, body: parsed })
      })
      res.on("error", () => resolve(null))
    })
    req.on("timeout", () => req.destroy())
    req.on("error", () => resolve(null))
    req.end(payload)
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Answers one ask: `{ status, body }` for the route to send.
 *
 * `screenUrl` is the start screen's address, or null when it is not
 * answering. `liveEditors` are the editors running now, `{ appPort,
 * projectRoot }` each: the registry's and the start screen's own, starting
 * ones included. `wait` is how long one ask waits for an editor to come up before
 * it answers "starting": most editors are up within a few seconds, and
 * answering at once would cost the window a poll or two of "Starting…".
 */
export async function startEditor(body, { screenUrl, liveEditors = [], probe = loopbackHostFor, wait = {}, timeoutMs = 3000 } = {}) {
  const ask = body && typeof body === "object" ? body : {}
  const app = parseApp(ask.app)
  if (app.error) return { status: 400, body: { error: app.error } }
  if (!screenUrl) return { status: 503, body: { state: "unavailable" } }
  const unavailable = { status: 503, body: { state: "unavailable" } }
  const answer = (payload) => ({ status: 200, body: payload })
  const totalMs = wait.totalMs ?? 8000
  const stepMs = wait.stepMs ?? 250

  const folder = realFolder(app.folder)
  const isThisApp = (editing) =>
    Boolean(editing) && portOfOrigin(editing.appUrl) === app.port && realFolder(editing.projectRoot) === folder

  // Follows one editor by its start-screen id until it is up, it stopped, or
  // the wait is over. The start screen's farewell sentence is not passed on:
  // it speaks of "the terminal" and "below", which this window has neither.
  // A stopped one stays failed, whoever it was: asking again there would
  // start a crashing editor again on every poll. An id just handed out for
  // this app that is up as another can only be a start screen gone wrong.
  async function follow(id, { justStarted }) {
    const deadline = Date.now() + totalMs
    for (;;) {
      const status = await callJson(`${screenUrl}/api/status?id=${encodeURIComponent(id)}`, { timeoutMs })
      const s = status?.status === 200 ? status.body : null
      if (s?.ready === true && typeof s.url === "string") {
        if (isThisApp(s.editing)) return answer({ state: "ready", url: s.url })
        return justStarted ? answer({ state: "failed" }) : start()
      }
      if (s && typeof s.stopped === "string" && s.stopped) return answer({ state: "failed" })
      if (Date.now() + stepMs > deadline) return answer({ state: "starting", id })
      await sleep(stepMs)
    }
  }

  async function start() {
    const address = `localhost:${app.port}`
    if (!(await probe(app.port))) return answer({ state: "not-running", address })

    if (liveEditors.some((e) => e && e.appPort === app.port && realFolder(e.projectRoot) !== folder)) return answer({ state: "other-app", address })

    // An unknown folder (the start screen could not tell, or did not answer)
    // is not another app, nor is one above or below the tab's: the tab's own
    // folder goes on.
    const appUrl = `http://${LOOPBACK}:${app.port}`
    const owner = await callJson(`${screenUrl}/api/app-folder?url=${encodeURIComponent(appUrl)}`, { timeoutMs })
    const ownerPath = owner?.status === 200 ? realFolder(owner.body?.project?.path) : null
    if (ownerPath && !within(ownerPath, folder) && !within(folder, ownerPath)) return answer({ state: "other-app", address })

    const started = await callJson(`${screenUrl}/api/start`, { method: "POST", body: { url: appUrl, projectRoot: app.folder }, timeoutMs })
    if (!started || started.status >= 500) return unavailable
    if (started.status >= 400) {
      const message = typeof started.body?.error === "string" && started.body.error.trim() ? started.body.error.trim() : null
      return answer(message ? { state: "failed", message } : { state: "failed" })
    }
    const choice = started.body ?? {}
    if (typeof choice.url === "string" && choice.url) return answer({ state: "ready", url: choice.url })
    if (typeof choice.id === "string" && choice.id) return follow(choice.id, { justStarted: true })
    return unavailable
  }

  if (typeof ask.id === "string" && ask.id && ask.id.length <= 64) return follow(ask.id, { justStarted: false })
  return start()
}
