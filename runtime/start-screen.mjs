/**
 * The start screen's HTTP server, and the handoff back to cli.mjs.
 *
 * Until now the only way in was `designlayer --dev 3000`, so the port, the
 * project root and the dev script all had to be known before anything was on
 * screen. This server is the other order: bind on loopback first, let the page
 * ask what is running and what is on disk, and end with one validated choice.
 * `chosen` IS that handoff — the CLI awaits it, then loads that project's
 * config and boots the proxy.
 *
 * One choice used to be all there was: `/api/start` latched shut after the
 * first press and the page redirected to the editor forever after, so the only
 * way to design a different app was to kill the process. The handoff is a
 * sequence now — `nextChoice()` for each round, `reportReady` and
 * `reportStopped` for what became of it — and this server outlives every editor
 * it hands off to.
 *
 * The page is untrusted input like any other client, so the refusals on
 * `/api/start` are the safety story of the feature, not a formality: this
 * process rewrites source files and proxies whatever origin it is handed. Each
 * refusal is a sentence, because whoever reads one is looking at a screen.
 */

import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

import { DEFAULT_SCAN_PORTS, describeProject, isDirectory, scanLocalApps } from "./local-apps.mjs"
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

function badRequest(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/** Takes a bare `host` header as readily as a full origin. */
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

/**
 * The one thing a pasted path may be that `path.isAbsolute` refuses.
 *
 * A path arrives here from a text field, and that field is the only way to name
 * a project the scan did not find for itself. Every other source of a path on
 * this machine — the shell, `pwd`, Finder's Copy as Pathname — writes `~` for
 * the home directory, so a field that rejected it would be rejecting the most
 * likely thing to be typed into it, with nothing else left to try.
 */
function expandHome(value) {
  if (typeof value !== "string") return value
  if (value !== "~" && !value.startsWith("~/")) return value
  return path.join(os.homedir(), value.slice(1))
}

/**
 * The other thing a pasted path may be: shell-escaped.
 *
 * Dragging a folder onto a terminal — the most direct way there is to get a
 * path out of the Finder and into a field — writes `IG\ Projects\ Local`, and
 * `\ ` is the shell's escaping, not a folder called `IG\`. Copying the command
 * line of a running dev server produces the same thing. A path that exists
 * exactly as typed always wins, so the rare real backslash in a filename is
 * still reachable; only a path that is otherwise not there is unescaped.
 *
 * Windows paths are exempt, where a backslash IS the separator.
 */
function unescapePastedPath(value) {
  if (!value.startsWith("/") || !value.includes("\\") || fs.existsSync(value)) return value
  return value.replace(/\\(.)/g, "$1")
}

/** Everything done to a path between the text field and the filesystem. */
const pastedPath = (value) =>
  typeof value === "string" ? unescapePastedPath(expandHome(value.trim())) : value

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

function parseAppUrl(value) {
  if (typeof value !== "string" || value.trim() === "") throw badRequest("Choose an app, or type the address of the one to edit.")

  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    throw badRequest(`"${value.trim()}" is not a valid address. Try http://localhost:3000.`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw badRequest(`Use an http:// or https:// address.`)
  if (!isLoopbackHost(parsed.origin)) {
    throw badRequest(
      `Only apps on this machine can be edited: localhost, 127.0.0.1 or ::1.`
    )
  }
  return {
    appUrl: parsed.origin,
    appPort: Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80),
    appPath: appPathOf(parsed),
  }
}

/**
 * The page half of the address, kept apart from the origin the editor is aimed
 * at.
 *
 * The chooser is where you say which app AND which page, and the two answers
 * have different destinations: the origin picks the child process, the page
 * picks where the browser lands on the proxy that child puts up. Nothing about
 * the child differs by one page — the proxy serves the whole app — so the path
 * never travels with the choice, only alongside it.
 *
 * A bare origin has to stay bare. `pathname` is "/" even for a URL that was
 * typed without one, and turning `http://127.0.0.1:3456` into
 * `http://127.0.0.1:3456/` would change every URL this server has ever
 * reported. The fragment is dropped because it is never sent to a server and
 * nothing downstream of here could act on it.
 */
function appPathOf(parsed) {
  const page = `${parsed.pathname}${parsed.search}`
  return page === "/" ? "" : page
}

/**
 * The vendored CLI also refuses a project without React, but it refuses AFTER
 * boot from inside its own banner. Checking here is the difference between an
 * inline message on the screen and a terminal that simply stops.
 */
function resolveProject(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw badRequest("Confirm the project folder before starting.")
  const value = pastedPath(raw)
  if (!path.isAbsolute(value)) throw badRequest(`Enter a full path, like /Users/you/Projects/app.`)

  let projectRoot
  try {
    projectRoot = fs.realpathSync(value)
  } catch (error) {
    // A protected folder refuses `realpath` along with `stat` while still
    // opening and reading; the path as pasted is then the best name it has.
    if (error.code !== "EPERM" || !isDirectory(value)) throw badRequest(`There is no folder at ${value}. Check the path.`)
    projectRoot = value
  }

  if (!isDirectory(projectRoot)) throw badRequest(`${value} is a file, not a project folder. Pick the folder that contains it.`)

  let text
  try {
    text = fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
  } catch {
    throw badRequest(`No package.json in ${projectRoot}. Pick the folder that contains it.`)
  }
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw badRequest(`The package.json in ${projectRoot} is not valid JSON. Fix the file, then try again.`)
  }

  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  const name = manifest.name ?? path.basename(projectRoot)
  /*
   * A project this editor has a lane for. React was the only answer when this
   * guard was written, and it stayed the only answer after the Angular lane
   * landed — so the start screen refused, by name, the exact projects the
   * editor had just learned to edit. Every other entry point had been taught
   * about Angular; this one had not, and it is the one a designer uses.
   *
   * The two dependencies are the same signals `resolveHostFramework` reads, and
   * they are checked here rather than delegated because this must fail as a
   * sentence on the page. Refusing later, inside the child process, reaches the
   * terminal that nobody running the start screen is looking at.
   */
  if (typeof dependencies.react !== "string" && typeof dependencies["@angular/core"] !== "string") {
    throw badRequest(
      `${name} does not use React or Angular, the two frameworks the editor supports.`
    )
  }

  return { projectRoot, manifest, packageName: name }
}

/**
 * `describeProject` offers the page a shortlist of likely dev scripts, but that
 * list is a heuristic and this is a guard, so the name is checked against the
 * manifest itself: nothing but a real `npm run` target can be handed on.
 */
function resolveDevScript(value, projectRoot, manifest) {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || typeof manifest.scripts?.[value] !== "string") {
    throw badRequest(
      `No "${value}" script in ${path.basename(projectRoot)}/package.json.`
    )
  }
  return value
}

/**
 * The endpoint file is written by the launcher, and it is the only thing this
 * server sees of the editor it handed off to on the runs where the launcher is
 * a separate process. A file left by a previous run is indistinguishable from
 * success and the page would redirect to a dead port, so the pid has to be
 * ours.
 *
 * It is the second answer, not the first — see `reportReady`.
 */
function readStatus(endpointFile) {
  if (!endpointFile) return { ready: false }
  let endpoint
  try {
    endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8"))
  } catch {
    return { ready: false }
  }
  if (endpoint?.pid !== process.pid || !endpoint.proxyPort) return { ready: false }
  return { ready: true, url: `http://${LOOPBACK}:${endpoint.proxyPort}` }
}

/**
 * One round of the handoff: the promise a caller waits on for the next choice.
 *
 * A round is created before anyone asks for it, and the supervisor is usually
 * still busy spawning the last editor when the next one is made, so nothing may
 * be attached to it when `close()` rejects it. Marking it handled here keeps
 * that from surfacing as an unhandled rejection; whoever does await it still
 * sees the rejection when they get there.
 */
function openRound() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * Serves the start screen and hands over each choice the user makes.
 *
 * The port defaults to the preferred one rather than to 0, because the caller
 * that matters — the supervisor in cli.mjs — keeps this screen up for the whole
 * session and prints its URL as somewhere to come back to.
 */
export async function createStartScreen({
  host = LOOPBACK,
  port = PREFERRED_START_SCREEN_PORT,
  log = console.log,
} = {}) {
  if (!isLoopbackHost(host)) throw new Error(`The start screen is loopback-only and cannot bind ${host}`)

  let endpointFile = null
  let readyUrl = null
  /*
   * The page the last choice asked for, "" for a choice that asked for none.
   *
   * It lives here rather than travelling to the launcher because the launcher
   * has no use for it: the proxy serves the whole app either way. It belongs to
   * one editor, so it is set as that editor's choice is accepted and dropped
   * when that editor dies — the same lifecycle as `readyUrl`, for the same
   * reason. A path outliving its editor would send the next one's browser to a
   * page the next app may not have.
   */
  let readyPath = ""
  let editing = null
  let stopped = null
  let closed = false
  /*
   * Per round, not per session.
   *
   * The latch this replaces was permanent: one press and `/api/start` refused
   * everything after it for as long as the process lived. It still has to
   * refuse a SECOND press in the same round — two presses before the editor
   * answers are one intention, and acting on both would kill a child the first
   * press is still waiting on. So it closes on a choice and opens again on the
   * report of what became of it.
   */
  let starting = false
  let pending = openRound()
  const chosen = pending.promise

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
  function scanApps() {
    if (lastScan && Date.now() - lastScan.at < SCAN_REUSE_MS) return Promise.resolve(lastScan.apps)
    scanning ??= scanLocalApps({ ports: DEFAULT_SCAN_PORTS })
      .then((apps) => {
        lastScan = { at: Date.now(), apps }
        return apps
      })
      .finally(() => {
        scanning = null
      })
    return scanning
  }

  // The page is a pure function of modules already loaded, so it is built once,
  // on the first ask, rather than as ~73KB of template on every load.
  let page = null

  // Read-only and stateless, all of them, except the last — which is the point.
  const routes = {
    "GET /": (_req, res) => send(res, 200, "text/html; charset=utf-8", (page ??= startScreenPage())),
    "GET /api/apps": async (_req, res) => sendJson(res, 200, { apps: await scanApps() }),
    "GET /api/project": (_req, res, url) => {
      const dir = pastedPath(url.searchParams.get("path") ?? "")
      if (!path.isAbsolute(dir)) throw badRequest("Ask for a folder by its full path.")
      sendJson(res, 200, { project: describeProject(dir) })
    },
    /*
     * What the page needs to decide which face to show: the editor's URL if one
     * is up, what it is editing so a tab that merely arrived here can be told,
     * and the sentence explaining an editor that is gone. `ready` and `url`
     * keep the shape they had when readiness was the only question.
     */
    "GET /api/status": (_req, res) => {
      const proxy = readyUrl ? { ready: true, url: readyUrl } : readStatus(endpointFile)
      // Both answers name the proxy's origin, and neither knows which page was
      // asked for — the proxy serves all of them. This is where the two halves
      // of the typed address are put back together, so the tab that presses
      // Start and the card's "Continue" link both go to the same place.
      if (proxy.ready) proxy.url += readyPath
      sendJson(res, 200, { ...proxy, editing, stopped })
    },
    "POST /api/start": async (req, res) => {
      const body = await readJsonBody(req)
      // A second press, or a page reloaded mid-boot. The choice already made is
      // the one the supervisor is acting on, and it cannot be taken back until
      // the editor it asked for has either answered or died.
      if (starting) throw badRequest("Already starting. This page updates on its own.")
      if (!body) throw badRequest("Choose an app and a project folder before starting.")
      const { appUrl, appPort, appPath } = parseAppUrl(body.url)
      const { projectRoot, manifest, packageName } = resolveProject(body.projectRoot)
      const devScript = resolveDevScript(body.devScript, projectRoot, manifest)
      const choice = { appUrl, appPort, projectRoot, devScript, packageName }
      starting = true
      /*
       * Whatever was running is being taken down to make room for this, and the
       * two can land on the same proxy port — 3456 both times is the normal
       * case, not the exception. So a page waiting for the NEW editor cannot
       * tell them apart by URL, and would follow the old one's the instant it
       * asked. Clearing here is what makes the wait mean the new one.
       */
      readyUrl = null
      readyPath = appPath
      editing = null
      stopped = null
      log(`[designlayer] editing ${choice.appUrl}${appPath} from ${choice.projectRoot}`)
      const round = pending
      pending = openRound()
      round.resolve(choice)
      sendJson(res, 200, { ok: true })
    },
  }

  // The URL is parsed in here rather than in the listener so that a malformed
  // request line answers through the one error path instead of throwing at the
  // server, where an uncaught exception would take the CLI down with it.
  async function route(req, res) {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}`)
    const handler = routes[`${req.method} ${url.pathname}`]
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
    if (error.code !== "EADDRINUSE" || port !== PREFERRED_START_SCREEN_PORT) throw error
    await listenOn(0)
  }

  return {
    url: `http://${host}:${server.address().port}`,
    chosen,

    /**
     * The next choice the user makes, whenever they make it.
     *
     * `chosen` is the first of these and keeps its own name, because for the
     * one-app callers that is the entire handoff. The supervisor asks again
     * after every spawn, which is what keeps this screen answering all session
     * instead of latching shut on the first press.
     */
    nextChoice() {
      return pending.promise
    },

    /** Where the launcher will write the proxy's ports, once one exists. */
    reportEndpointFile(absolutePath) {
      endpointFile = absolutePath
    },

    /**
     * The proxy is up, said in memory rather than through the endpoint file.
     *
     * The file was never the fact — only a way of carrying it, and one that
     * fails outright when the project folder is somewhere macOS will not let
     * this process write. That leaves the proxy running, the page polling, and
     * "Starting the editor…" on screen forever. Said directly, the page moves
     * on whether or not the disk cooperated.
     *
     * `current` is what the editor is editing, for the tab that arrives here
     * later and has to be told what is already running rather than bounced into
     * it. Callers with nothing to say about it pass nothing.
     */
    reportReady(url, current = null) {
      readyUrl = url
      editing = current
      stopped = null
      starting = false
    },

    /**
     * The editor is gone — it crashed, its port was taken, its project turned
     * out not to be one. A dead child must not be a dead terminal, so the
     * screen goes back to being a chooser and carries the sentence explaining
     * what happened, rather than leaving a page that polls forever for a
     * process nobody is running.
     */
    reportStopped(reason) {
      readyUrl = null
      readyPath = ""
      editing = null
      stopped = reason
      starting = false
    },

    close() {
      if (closed) return
      closed = true
      pending.reject(new Error("The start screen closed before an app was chosen"))
      // The page holds a keep-alive socket open for its status poll, and
      // `close()` alone waits for it — leaving the CLI on a screen nobody is
      // looking at any more.
      server.closeAllConnections()
      server.close()
    },
  }
}
