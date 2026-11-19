/**
 * Discovery for the start screen: what is already running on this machine, and
 * where does each of those things live on disk.
 *
 * No UI, no HTTP, no config. This is the half of the start screen that touches
 * the machine, and the machine is one nobody here has seen: a port that hangs
 * mid-response, an `lsof` the OS refuses, a home directory behind a TCC prompt.
 * Every function degrades to `null` or `[]` rather than throwing — a wrong
 * guess costs one click at the folder picker, an exception costs the whole
 * start screen.
 *
 * Nothing here is authoritative. Whether a project can actually be edited stays
 * the vendor's call, which is why the framework test below is a transcription
 * of the vendor's own rather than an improvement on it.
 */

import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { LOOPBACK_ADDRESSES, urlHost } from "./dev-server.mjs"
import { DEV_SCRIPT_PREFERENCE, NEXT_CONFIG_FILES, VITE_CONFIG_FILES, hasHtmlPage } from "./project-facts.mjs"

/**
 * Where a local web app is actually likely to be, kept short so a full scan
 * costs one timeout rather than a minute:
 *
 *   3000-3005  Next.js and Create React App both default to 3000 and walk up
 *              one port at a time when it is taken, so a second app is 3001.
 *   5173-5175  Vite, which walks the same way.
 *   4321       Astro.  4200  Angular CLI and the scaffolds that copied it.
 *   8080, 8000 The generic pair: Remix, webpack-dev-server, anything Python.
 */
export const DEFAULT_SCAN_PORTS = [
  3000, 3001, 3002, 3003, 3004, 3005, 5173, 5174, 5175, 4321, 4200, 8080, 8000,
]

/**
 * How much of a document is read before giving up on it. The title sits in the
 * head; the project root sits further down among the script tags, measured at
 * ~18KB into a Next dev page. Reading stops the moment both are in hand, so the
 * ceiling only applies to a page that never names itself.
 */
const MAX_PAGE_BYTES = 256 * 1024
const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i

/**
 * An absolute path with a build directory under it, as a dev server writes into
 * the page it serves. Next puts server chunk paths in its dev stack traces —
 * `at BailoutToCSR (/Users/someone/app/.next/dev/server/...)` — and everything
 * above `.next` is the directory it was started in.
 *
 * Delimited by quotes and parens rather than whitespace, because real project
 * paths have spaces in them. Nothing rests on the pattern being exact: every
 * candidate has to survive `nearestProjectRoot`, so a bad guess is one that
 * finds no package.json and is dropped.
 */
const ROOT_PATTERN = /((?:\/|[A-Za-z]:\\)[^"'`()\n\r]*?)[/\\](?:\.next|\.nuxt|\.svelte-kit)[/\\]/g
const buildDirSeen = (text) => /[/\\](?:\.next|\.nuxt|\.svelte-kit)[/\\]/.test(text)
// Titles carry entities, and the picker prints what it is given.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" }

/** `lsof` is fast, but a hung one must not hold the start screen open. */
const LSOF_TIMEOUT_MS = 1500

// The `dev` and `start` families, best first. The exact names come first in
// this order; anything else in the family (`dev:https`, `start-local`) keeps
// its declaration order behind them.
const PREFERRED_DEV_SCRIPTS = DEV_SCRIPT_PREFERENCE
const DEV_SCRIPT_FAMILY = /^(dev|develop|start|serve)([:_-]|$)/

// The React families are transcribed from `react-rewrite-cli/dist/detect.js`,
// whose config-file test is what the launcher has to satisfy. Angular is named
// by its dependency instead, the same way `resolveHostFramework` names it —
// this screen must not report a project as unrecognised when the launcher is
// about to accept it.
const NEXT_CONFIGS = NEXT_CONFIG_FILES
const VITE_CONFIGS = VITE_CONFIG_FILES

function statOf(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

/**
 * Denied is not missing.
 *
 * A protected folder on macOS can refuse `stat` on every path inside it and
 * still open, list and read perfectly — measured on this machine against a real
 * Next.js checkout, where `statSync` was EPERM and `readdirSync` was fine. Read
 * as "there is no folder there", that turns an openable project into a dead end
 * on the start screen, so both probes fall back to the weaker syscall that the
 * same folder does answer.
 */
export function isDirectory(target) {
  const stat = statOf(target)
  if (stat) return stat.isDirectory()
  try {
    fs.opendirSync(target).closeSync()
    return true
  } catch {
    return false
  }
}

function hasFile(dir, name) {
  const target = path.join(dir, name)
  const stat = statOf(target)
  if (stat) return stat.isFile()
  try {
    fs.accessSync(target, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** The parsed `package.json`, or null for missing, unreadable and malformed alike. */
function readPackageJson(dir) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
  } catch {
    return null
  }
  return parsed && typeof parsed === "object" ? parsed : null
}

const withinNodeModules = (dir) => dir.split(path.sep).includes("node_modules")

/**
 * The nearest ancestor (including `start`) holding a package.json and not
 * itself vendored. `npm run dev` is often invoked from a subdirectory, and a
 * cwd inside node_modules describes a launcher rather than a project.
 */
function nearestProjectRoot(start) {
  let dir = start
  for (;;) {
    if (!withinNodeModules(dir) && hasFile(dir, "package.json")) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The project a process with working directory `cwd` runs from, or null.
 *
 * A static server serves the folder it was started in, which holds the pages
 * and often no package.json. That folder is the project, not the nearest
 * manifest above it, unless that manifest is a React or Angular app whose dev
 * server was started from a subfolder.
 */
function projectRootOfCwd(cwd) {
  const dir = isDirectory(cwd) ? cwd : path.dirname(cwd)
  const root = nearestProjectRoot(dir)
  if (root === dir || !hasHtmlPage(dir)) return root
  const framework = root === null ? null : describeProject(root).hostFramework
  return framework === "react" || framework === "angular" ? root : dir
}

/**
 * Runs `lsof` and resolves its stdout, or null if it is missing, slow or denied.
 *
 * Asynchronous: two `lsof` forks cost ~135ms per app, and run synchronously
 * they held the start screen's event loop — every other request included —
 * for the whole lookup, one app after another.
 *
 * Exit status 1 still carries an answer. `lsof` reports it whenever one of
 * several pids it was asked about printed nothing — exited, or another user's —
 * and the rows for the rest are on stdout as usual.
 *
 * `-O` keeps the kernel calls in this one process instead of a forked helper
 * per call, which `lsof` does so that a hung network mount cannot block it:
 * ~40% of each lookup, measured, and the timeout below already bounds a hang.
 */
function lsof(args) {
  return new Promise((resolve) => {
    // stderr is discarded: a denied lookup is an expected answer here, not
    // something the user should see printed under the start screen banner.
    const child = execFile("lsof", ["-O", ...args], { timeout: LSOF_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) =>
      resolve(!error || (error.code === 1 && !error.killed) ? stdout : null)
    )
    child.stdin?.end()
  })
}

/**
 * `lsof -F` output as `{ pid, name }` pairs. `-Fpn` is the machine-readable
 * form: one field per line, a `p` line opening each process, and an `n` line
 * per file it has open (a socket's address, a working directory's path).
 */
function* lsofNames(output) {
  let pid = null
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1).trim()
    else if (line.startsWith("n") && pid !== null) yield { pid, name: line.slice(1).trim() }
  }
}

/** The pids listening on `port`, lowest first, as `lsof` lists them. */
async function listenerPids(port) {
  return (
    (await lsof(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]))
      ?.split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line)) ?? []
  )
}

/**
 * Every TCP listener on the machine, as port -> pids lowest first, from one
 * `netstat` — or null where that cannot say.
 *
 * `lsof -iTCP:<port> -sTCP:LISTEN` walks every open file of every process to
 * answer for one port, ~85ms measured, and it was the larger half of every app
 * row the page did not name a folder for. macOS's `netstat -anv` reads the
 * kernel's socket table instead and names each socket's process beside it,
 * every port in one ~15ms fork. The pid is the last field shaped `name:pid` —
 * a process name may hold spaces, and no address ends in `:digits`, since
 * netstat writes the port after a dot. Where netstat prints no such field (older
 * releases) or withholds TCP sockets from unprivileged processes (macOS 27+),
 * `table` comes back empty and resolves null so `lsof` takes over.
 */
function runNetstat() {
  if (process.platform !== "darwin") return Promise.resolve(null)
  return new Promise((resolve) => {
    // The buffer is for the busiest machines: one line per socket, listening or not.
    const options = { timeout: LSOF_TIMEOUT_MS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    const child = execFile("netstat", ["-anv", "-p", "tcp"], options, (error, stdout) =>
      resolve(error ? null : stdout)
    )
    child.stdin?.end()
  })
}

async function listenerTable(netstat = runNetstat) {
  const stdout = await netstat()
  if (stdout === null) return null
  const table = new Map()
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/)
    if (fields[5] !== "LISTEN") continue
    const port = Number(fields[3].slice(fields[3].lastIndexOf(".") + 1))
    const pid = fields.slice(6).findLast((field) => /:\d+$/.test(field))?.split(":").pop()
    if (!Number.isInteger(port) || !pid) continue
    const pids = table.get(port) ?? []
    if (!pids.includes(pid)) pids.push(pid)
    table.set(port, pids)
  }
  if (table.size === 0) return null
  for (const pids of table.values()) pids.sort((a, b) => a - b)
  return table
}

/**
 * The same table from `lsof`, for where `netstat` names no process: Linux, and
 * older macOS. Slower, and it sees only this user's own processes, which are
 * the only dev servers this screen could edit anyway.
 */
async function listenerTableFromLsof() {
  const output = await lsof(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
  if (output === null) return null
  const table = new Map()
  for (const { pid, name } of lsofNames(output)) {
    const port = Number(name.slice(name.lastIndexOf(":") + 1))
    if (!Number.isInteger(port)) continue
    const pids = table.get(port) ?? []
    if (!pids.includes(pid)) pids.push(pid)
    table.set(port, pids)
  }
  for (const pids of table.values()) pids.sort((a, b) => a - b)
  return table
}

/**
 * Working directories on macOS, via BSD `lsof`: pid -> cwd (null when denied)
 * for every pid `lsof` can see at all. One fork for any number of pids — each
 * fork is ~40ms of the scan, and several untitled apps used to pay it each.
 *
 * Denial arrives as a VALUE, not as a failure: a process this user does not own
 * answers with a zero exit status and the reason inside the field itself
 * ("ncwd|rtd info error: Operation not permitted"), which `path` is happy to
 * read as a relative path. So the field only counts when it is absolute.
 */
async function cwdsFromLsof(pids) {
  // Every pid lsof answered for is in the map, null until its cwd line counts.
  const output = (await lsof(["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"])) ?? ""
  const cwds = new Map()
  for (const line of output.split("\n")) if (line.startsWith("p")) cwds.set(line.slice(1).trim(), null)
  for (const { pid, name } of lsofNames(output)) {
    if (cwds.get(pid) === null) cwds.set(pid, path.isAbsolute(name) ? name : null)
  }
  return cwds
}

/**
 * A process's working directory on Linux, via `/proc`.
 *
 * `lsof -d cwd` is the wrong tool here — Linux answers it only for your own
 * processes, and even then it is a subprocess where a `readlink` will do. The
 * symlink is the same fact without the fork, and it is readable for exactly the
 * processes whose folder this screen has any business naming: your own.
 */
function cwdFromProc(pid) {
  try {
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
    return path.isAbsolute(cwd) ? cwd : null
  } catch {
    // Another user's process, or one that exited between the two calls.
    return null
  }
}

/** Working directories for `pids`, pid -> cwd, by whichever lookup this platform has. */
async function cwdsOf(pids) {
  if (pids.length === 0) return new Map()
  if (process.platform === "darwin") return cwdsFromLsof(pids)
  return new Map(pids.map((pid) => [pid, cwdFromProc(pid)]))
}

/**
 * The listener table, and the folders of every process in it listening on one
 * of `ports` — asked for before anyone knows which of those ports is an app.
 *
 * The scan starts this beside its probes. The two forks it takes, ~15ms and
 * ~25ms, used to start only once the probes were done, and a dev server's own
 * page takes about as long to arrive as both of them together. A listener the
 * probes then rule out — a database, a JSON API — costs a line in the one
 * `lsof` that was running anyway.
 */
async function lookAhead(ports, skip = null, netstat = runNetstat) {
  const table = (await listenerTable(netstat)) ?? (skip ? await listenerTableFromLsof() : null)
  const extra = skip && table ? unlistedPorts(table, ports, skip) : []
  const asked = [...new Set([...ports, ...extra].flatMap((port) => table?.get(port) ?? []))]
  return { table, asked: new Set(asked), cwds: await cwdsOf(asked), extra }
}

/**
 * The folder this package is installed in. Its own processes — the Mac app's
 * desk server, a start screen run from a checkout — sit in it, and its
 * package.json names React, so it would otherwise pass for an app.
 */
const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Listening ports the fixed list does not name, minus the ones `discover` says
 * belong to the editor itself. A dev server can be on any port: a project that
 * pins `--port 3041` is as common as one that takes the default, and a fixed
 * list left such an app off the start screen and out of the editor's chooser
 * while it was running and answering.
 */
function unlistedPorts(table, ports, skip) {
  return [...table.keys()]
    .filter((port) => port >= 1024 && !ports.includes(port) && !isOwnPort(table, port, skip))
    .sort((a, b) => a - b)
}

/** Whether `port` is the editor's own: one `skip` names, or held by a pid it names. */
function isOwnPort(table, port, skip) {
  if (!skip) return false
  return skip.ports.has(port) || (table?.get(port) ?? []).some((pid) => skip.pids.has(pid))
}

/**
 * The project the process on an unlisted port runs from, `{ root,
 * hostFramework }`, when the editor can open it; else null. This is the filter
 * that keeps the list to dev servers: every desktop app, sync client and
 * language server on the machine listens somewhere too, and some of them serve
 * HTML. A cwd inside a React, Angular or plain HTML project is what a dev
 * server has and they do not. A plain HTML folder also has to be what the port
 * serves (see `scanLocalApps`), since any process can be started in one.
 */
function editableProjectOn(port, { table, cwds }) {
  for (const pid of table?.get(port) ?? []) {
    const cwd = cwds.get(pid)
    if (!cwd) continue
    const root = projectRootOfCwd(cwd)
    if (!root || path.resolve(root) === OWN_ROOT) continue
    const { hostFramework } = describeProject(root)
    if (hostFramework) return { root, hostFramework }
  }
  return null
}

/**
 * The project root for whatever is listening on each of `ports`, by asking
 * that process for its own working directory — which, for a dev server, IS the
 * project root. Resolves port -> root, null where there is no answer.
 *
 * This is the difference between a start screen that fills the folder in for
 * you and one that sends you to a file picker to find a path the machine
 * already knows. It used to be macOS-only, which meant every row on a Linux
 * workstation arrived blank — the platform where a designer is most likely to
 * be driving a remote dev server they did not start themselves.
 *
 * Windows has no equivalent; there every root is null and the user picks the
 * folder, which is the behaviour every platform had before.
 *
 * One port can have several listeners (IPv4 and IPv6 rows, or a cluster). The
 * lowest pid `lsof` can see answers for it, as it always has. `known` is the
 * caller's `lookAhead`; whatever it did not cover is asked for here.
 */
async function projectRootsForPorts(ports, known = lookAhead(ports)) {
  const roots = new Map(ports.map((port) => [port, null]))
  if (process.platform !== "darwin" && process.platform !== "linux") return roots
  const { table, asked, cwds: early } = await known
  const candidates = await Promise.all(
    ports.map(async (port) => table?.get(port) ?? (await listenerPids(port)))
  )
  const missing = [...new Set(candidates.flat())].filter((pid) => !asked.has(pid))
  const cwds = missing.length ? new Map([...early, ...(await cwdsOf(missing))]) : early
  ports.forEach((port, index) => {
    for (const candidate of candidates[index]) {
      const cwd = cwds.get(candidate)
      const root = cwd ? projectRootOfCwd(cwd) : null
      if (root) {
        roots.set(port, root)
        break
      }
    }
  })
  return roots
}

/** `projectRootsForPorts` for one port. */
export async function projectRootForPort(port) {
  if (!Number.isInteger(port)) return null
  return (await projectRootsForPorts([port])).get(port)
}

/**
 * The project root a dev server names in its own page, for when `lsof` has no
 * answer.
 *
 * It usually has none. A managed Mac refuses `-d cwd` for the user's own dev
 * servers — the field comes back "Operation not permitted" — so every app row
 * arrives with no folder and the person is sent to a file picker to find a path
 * their machine already knows. The page is the way around that: it is served by
 * the process being asked about, so it needs no permission at all.
 *
 * Percent-encoding is undone because the same path appears both plain and
 * inside a `file://` URL, and a candidate only counts once an ancestor of it
 * holds a package.json. A `file://` URL also brings its own leading slashes:
 * the match starts at the first one of the three, and `///Users/...` is a path
 * nothing on disk answers to.
 */
export function projectRootFromPage(html) {
  const tried = new Set()
  for (const [, candidate] of String(html).matchAll(ROOT_PATTERN)) {
    let dir = candidate.replace(/^\/{2,}/, "/")
    if (dir.includes("%")) {
      try {
        dir = decodeURIComponent(dir)
      } catch {
        // A stray percent is not an encoding; the raw path is still worth a look.
      }
    }
    if (tried.has(dir)) continue
    tried.add(dir)
    if (!path.isAbsolute(dir)) continue
    const root = nearestProjectRoot(dir)
    if (root) return root
  }
  return null
}

function decodeEntities(text) {
  return text.replace(/&(#39|[a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
}

/**
 * As much of the response as the two questions need. Bounded, and matched
 * rather than parsed: all that is wanted is the `<title>` and a path, and a dev
 * server's index page is a megabyte of inlined bundle below them both.
 *
 * `whole` reads on to the end, up to the same bound, for a page that is about
 * to be compared with a file on disk. `complete` says whether it got there.
 */
async function readPage(response, { whole = false } = {}) {
  if (!response.body) return { text: "", complete: true }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let page = ""
  let complete = false
  try {
    while (page.length < MAX_PAGE_BYTES) {
      const { done, value } = await reader.read()
      if (done) {
        complete = true
        break
      }
      page += decoder.decode(value, { stream: true })
      if (!whole && TITLE_PATTERN.test(page) && buildDirSeen(page)) break
    }
  } catch {
    // A truncated read is still worth a regex.
  }
  reader.cancel().catch(() => {})
  return { text: page, complete }
}

/**
 * What the app at `url` will say about itself — its title, and the project root
 * if the page names one — or null when there is no app here. Content type
 * carries the "is this an app" half of the question, so a Postgres port or a
 * bare JSON API drops out here, and a closed port is refused before that —
 * hence no separate TCP probe in front.
 *
 * `page` is the text read, and `complete` whether it is all of it; see
 * `readPage` for `whole`.
 */
async function probeApp(url, timeoutMs, { whole = false } = {}) {
  let response
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html" },
    })
  } catch (error) {
    // On loopback a closed port is refused instantly, so running out of time is
    // not silence: something accepted and is still thinking, which is a dev
    // server compiling its first page — the row the user came for. It counts as
    // a hit with no title rather than being dropped for being slow.
    return error?.name === "TimeoutError" ? { title: "", projectRoot: null, page: "", complete: false } : null
  }

  if (!(response.headers.get("content-type") ?? "").includes("text/html")) {
    response.body?.cancel().catch(() => {})
    return null
  }

  const { text, complete } = await readPage(response, { whole })
  const title = TITLE_PATTERN.exec(text)?.[1] ?? ""
  return {
    title: decodeEntities(title).replace(/\s+/g, " ").trim(),
    projectRoot: projectRootFromPage(text),
    page: text,
    complete,
  }
}

/*
 * WHICH FOLDER SERVES A PAGE.
 *
 * A static server says nothing about its folder. Its working directory can be
 * `/` (a server that mounts several folders under a prefix, such as
 * `/p/<folder>/…`), and its root can answer with plain text rather than a
 * page. What it does do is send a file byte for byte, so a page is matched to
 * the file on disk it came from: every way of reading the address as a path
 * below a likely folder is tried, longest first, and a candidate counts only
 * when its bytes are the page.
 */

const SCRIPT_ELEMENT = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi
const HTML_COMMENT = /<!--[\s\S]*?-->/g
// Whitespace between tags goes too: an injected script leaves its line break behind.
const markupOf = (text) =>
  text.replace(HTML_COMMENT, "").replace(SCRIPT_ELEMENT, "").replace(/\s+/g, " ").replace(/> </g, "><").trim()

/** Above this a file is not read to be compared: no static page is this large. */
const MAX_PAGE_FILE_BYTES = 8 * 1024 * 1024

/**
 * Where the ports the OS hands out start: a server that asks for port 0 gets
 * one at or above this (Linux from 32768, macOS and Windows from 49152). A
 * folder of pages served there is a program's own server, such as a render
 * worker or a test fixture, not a site someone started to look at. A scan
 * listed several of them, each on a new port every few seconds, so they are
 * not listed unasked. A pasted page still finds one.
 */
const FIRST_OS_ASSIGNED_PORT = 32768

/**
 * Whether `served` is the file `text` as a server sends it: byte for byte, or
 * with only scripts and comments added, which a live-reload server injects and
 * Vite adds its client as. A page read only in part is compared as the start
 * of the file.
 */
export function servesFile(served, text, { complete = true } = {}) {
  if (!complete) return served.length > 0 && text.startsWith(served)
  return served === text || markupOf(served) === markupOf(text)
}

function readPageFile(file) {
  try {
    const stat = statOf(file)
    if (stat && (!stat.isFile() || stat.size > MAX_PAGE_FILE_BYTES)) return null
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

/**
 * The relative paths a page address could name on disk, most specific first,
 * as lists of segments; null when the address is not a page. Leading segments
 * are dropped one at a time, because a server may mount a folder under a
 * prefix, and a folder address is its `index.html`.
 */
function pageSuffixes(pathname) {
  let segments
  try {
    segments = pathname.split("/").slice(1).map(decodeURIComponent)
  } catch {
    return null
  }
  const folder = segments.at(-1) === ""
  if (folder) segments.pop()
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || /[\\/\0]/.test(segment))) {
    return null
  }
  const last = segments.at(-1)
  let variants
  if (folder || last === undefined) variants = [[...segments, "index.html"]]
  else if (/\.html?$/i.test(last)) variants = [segments]
  else if (!last.includes(".")) variants = [[...segments, "index.html"], [...segments.slice(0, -1), `${last}.html`]]
  else return null
  const suffixes = []
  const longest = Math.max(...variants.map((variant) => variant.length))
  for (let drop = 0; drop < longest; drop += 1) {
    for (const variant of variants) if (drop < variant.length) suffixes.push(variant.slice(drop))
  }
  return suffixes
}

/** Folders in a home folder that macOS guards with a permission prompt, or that hold no projects. */
const SKIPPED_HOME_FOLDERS = new Set([
  "Applications", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public",
])

/** The home folder and the folders directly in it: where projects are kept. */
function homeBases(home) {
  const bases = [home]
  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIPPED_HOME_FOLDERS.has(entry.name)) continue
      const dir = path.join(home, entry.name)
      if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(dir))) bases.push(dir)
    }
  } catch {
    // An unreadable home leaves the home folder itself.
  }
  return bases
}

/** Every file on disk `suffixes` name below one of `bases`, most specific first: `{ file, base }`. */
function pageFiles(bases, suffixes) {
  const found = []
  for (const suffix of suffixes) {
    const relative = path.join(...suffix)
    for (const base of bases) {
      if (hasFile(base, relative)) found.push({ file: path.join(base, relative), base })
    }
  }
  return found
}

/** The first of `candidates` whose bytes are the served page, or null. */
function servedFileOf(candidates, served, complete) {
  return candidates.find(({ file }) => {
    const text = readPageFile(file)
    return text !== null && servesFile(served, text, { complete })
  }) ?? null
}

/** The working directories of the processes listening on `port`. */
async function listenerCwds(port) {
  if (process.platform !== "darwin" && process.platform !== "linux") return []
  const cwds = await cwdsOf(await listenerPids(port))
  return [...cwds.values()].filter((cwd) => typeof cwd === "string" && path.isAbsolute(cwd))
}

/**
 * The project a matched page belongs to. A static server's own folder is it
 * when that folder holds pages; otherwise the nearest folder between the page
 * and where the match started that has a package.json or a `.git`, else the
 * page's own folder.
 */
function rootOfPage({ file, base }, servedFolders) {
  if (servedFolders.includes(base) && hasHtmlPage(base)) return base
  const below = (dir) => {
    const relative = path.relative(base, dir)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  }
  for (let dir = path.dirname(file); below(dir); dir = path.dirname(dir)) {
    if (hasFile(dir, "package.json") || isDirectory(path.join(dir, ".git"))) return dir
  }
  return path.dirname(file)
}

/** The path and query of a page address, without its fragment; null unless it starts at "/". */
function pageRequest(page) {
  if (typeof page !== "string" || !page.startsWith("/") || page.startsWith("//")) return null
  const request = page.replace(/#.*$/, "")
  return { request, pathname: request.replace(/\?.*$/, "") }
}

/** The served page at `request` on `port`, read whole, from the first loopback address that answers. */
async function fetchPage(port, request, { hosts, timeoutMs }) {
  for (const host of hosts) {
    const app = await probeApp(`http://${urlHost(host)}:${port}${request}`, timeoutMs, { whole: true })
    if (app !== null) return { ...app, url: `http://${urlHost(host)}:${port}` }
  }
  return null
}

/**
 * The project folder of the page at `page` (a path, as typed after the port)
 * on `port`, found by matching the page to the file it was served from; null
 * when no file on disk is that page. Nothing is fetched unless a candidate file
 * exists, so an app's routes, which are no files at all, cost a few `stat`s.
 *
 * Looked for below the listening process's working directory, the home folder,
 * and each folder directly in it, except the ones macOS guards with a prompt.
 */
export async function projectRootForPage(
  port,
  page,
  { hosts = LOOPBACK_ADDRESSES, timeoutMs = 1500, cwds = null, home = os.homedir() } = {}
) {
  const address = pageRequest(page)
  const suffixes = address && pageSuffixes(address.pathname)
  if (!suffixes || !Number.isInteger(port)) return null
  const served = cwds ?? (await listenerCwds(port))
  const candidates = pageFiles([...new Set([...served, ...homeBases(home)])], suffixes)
  if (candidates.length === 0) return null
  const app = await fetchPage(port, address.request, { hosts, timeoutMs })
  if (!app?.page) return null
  const match = servedFileOf(candidates, app.page, app.complete)
  return match ? rootOfPage(match, served) : null
}

/**
 * Apps the screen has opened before on a server whose root says nothing, such
 * as a static server that answers `/` with plain text: each is asked for the
 * page it was last used on, and counts only while that page is still a file in
 * its folder. Newest first, one per port.
 */
async function recallPages(remembered, { hosts, timeoutMs }) {
  const byPort = new Map()
  for (const entry of remembered) {
    const address = pageRequest(entry?.page)
    const suffixes = address && pageSuffixes(address.pathname)
    if (!suffixes || !Number.isInteger(entry.port) || typeof entry.projectRoot !== "string") continue
    if (describeProject(entry.projectRoot).hostFramework !== "html") continue
    const candidates = pageFiles([entry.projectRoot], suffixes)
    if (candidates.length === 0) continue
    const list = byPort.get(entry.port) ?? []
    list.push({ ...entry, address, candidates })
    byPort.set(entry.port, list)
  }
  const rows = await Promise.all(
    [...byPort].map(async ([port, entries]) => {
      const pages = await Promise.all(entries.map((entry) => fetchPage(port, entry.address.request, { hosts, timeoutMs })))
      const index = entries.findIndex((entry, i) => pages[i]?.page && servedFileOf(entry.candidates, pages[i].page, pages[i].complete))
      if (index < 0) return null
      const { url, title } = pages[index]
      return { port, url, title: title || url.replace(/^https?:\/\//, ""), said: entries[index].projectRoot }
    })
  )
  return rows.filter(Boolean)
}

/**
 * Every local app the machine will admit to, sorted by port. Probed
 * concurrently, because a serial scan pays every dead port's timeout in turn
 * and most of this list is dead on any given machine.
 *
 * Never rejects. Finding nothing is the empty list, which the start screen's
 * URL field covers.
 */
export async function scanLocalApps({
  ports = DEFAULT_SCAN_PORTS,
  /**
   * Which loopback addresses to look on. Both, by default, because a dev server
   * the designer started themselves is often on only one: `vite` and `ng serve`
   * bind the NAME `localhost`, which on an IPv6-first machine resolves to
   * `[::1]` alone. Scanning v4 only meant a running Angular app simply did not
   * appear on the start screen, and the person was sent to type a URL for an
   * app the machine could see perfectly well.
   */
  hosts = LOOPBACK_ADDRESSES,
  // Long enough to get a NAME out of a dev server, not just a port. A warm one
  // answers in milliseconds, but the scan is often the first request the thing
  // has had all day and Next compiles the route before it replies — measured at
  // 8s cold, well past any timeout worth waiting through. So this buys the warm
  // case and the cold one still lists, labelled by its address. Probes run
  // concurrently, so it is the whole scan's ceiling, not a cost per port.
  timeoutMs = 1500,
  /**
   * Also look past `ports`, at every port something on this machine listens
   * on, and keep the ones served from a React, Angular or plain HTML project.
   * Null for the fixed list alone. `{ pids, ports }` names the editor's own
   * processes and ports, which run from the project they edit and would pass
   * for its app.
   */
  discover = null,
  netstat = runNetstat,
  /**
   * Apps opened before, `[{ port, projectRoot, page }]` newest first, for a
   * server the probes cannot recognise: one whose root is not a page. See
   * `recallPages`.
   */
  remembered = [],
} = {}) {
  // Which processes listen on these ports, and where each was started, looked
  // up beside the probes rather than after them. See `lookAhead`.
  const skip = discover && {
    pids: new Set([...(discover.pids ?? [])].map(String)),
    ports: new Set(discover.ports ?? []),
  }
  const known = lookAhead(ports, skip, netstat)
  const probe = (list, { whole = false } = {}) => Promise.all(
    list.map(async (port) => {
      // First address that answers wins, and the row carries THAT address — it
      // is what the editor will proxy, so a row naming the other one would send
      // the launch somewhere nothing is listening.
      for (const host of hosts) {
        const url = `http://${urlHost(host)}:${port}`
        const app = await probeApp(`${url}/`, timeoutMs, { whole })
        if (app === null) continue
        // An untitled page is still an app worth offering; the address is the
        // only honest label left for it.
        return {
          port,
          url,
          title: app.title || `${urlHost(host)}:${port}`,
          said: app.projectRoot,
          page: app.page,
          complete: app.complete,
        }
      }
      return null
    })
  )
  // A folder of pages is the app on its port only when the port serves its
  // index page. Any process can be started in such a folder.
  const servesIndex = (hit, root) => {
    const text = readPageFile(path.join(root, "index.html"))
    return text !== null && servesFile(hit.page, text, { complete: hit.complete })
  }
  const probeUnlisted = async (look) => {
    const found = look.extra.map((port) => ({ port, project: editableProjectOn(port, look) })).filter((entry) => entry.project)
    const pages = found.filter((entry) => entry.project.hostFramework === "html" && entry.port < FIRST_OS_ASSIGNED_PORT)
    const [apps, sites] = await Promise.all([
      probe(found.filter((entry) => entry.project.hostFramework !== "html").map((entry) => entry.port)),
      probe(pages.map((entry) => entry.port), { whole: true }),
    ])
    return [...apps, ...sites.map((hit, index) => (hit && servesIndex(hit, pages[index].project.root) ? hit : null))]
  }
  // The fixed list is probed at once, as before. Unlisted ports wait for the
  // look-ahead, because only a process's folder says whether it is worth a probe.
  // Remembered pages are asked for alongside, and give way to anything the
  // probes found on the same port.
  const [listed, unlisted, remembers] = await Promise.all([
    probe(ports),
    known.then(probeUnlisted),
    recallPages(remembered, { hosts, timeoutMs }),
  ])
  const { table } = await known
  const probed = [...listed, ...unlisted].filter((hit) => hit === null || !isOwnPort(table, hit.port, skip))
  const found = probed.filter((hit) => hit !== null)
  const recalled = remembers.filter(
    (row) => !found.some((hit) => hit.port === row.port) && !isOwnPort(table, row.port, skip)
  )

  // Folders are resolved only for apps whose page named none, all of them from
  // the one look-ahead: no fork per port, dead or alive.
  const hits = [...found, ...recalled].map(({ page, complete, ...hit }) => hit).sort((a, b) => a.port - b.port)
  const unnamed = hits.filter((hit) => hit.said === null).map((hit) => hit.port)
  const roots = unnamed.length ? await projectRootsForPorts(unnamed, known) : new Map()
  return hits.map(({ said, ...hit }) => {
    // What the page said first: those paths are the app's own build output,
    // so they name the project being served. A cwd is only where the command
    // was typed, which `npm --prefix` and a monorepo root both get wrong —
    // it is the fallback, for servers that write no path into their page.
    const projectRoot = said ?? roots.get(hit.port) ?? null
    return {
      ...hit,
      projectRoot,
      packageName: projectRoot ? describeProject(projectRoot).packageName : null,
    }
  })
}

/**
 * One directory, read synchronously and reported flat. Every field is present
 * on every return — including for a directory that does not exist — so the page
 * never has to feature-test one. `hasReact` is separate from `framework`
 * because the vendor checks it FIRST, before any config file: a Vite project
 * without React reports `framework: "vite"`.
 *
 * `hostFramework` is how the editor would open the folder — "react",
 * "angular" or "html", as `resolveHostFramework` in config.mjs decides — or
 * null when it cannot. "html" is a folder with an HTML page at its top level
 * and neither React nor Angular, which is how that Vite project is opened.
 */
export function describeProject(dir) {
  const target = path.resolve(dir)
  const result = {
    path: target,
    name: path.basename(target),
    exists: fs.existsSync(target),
    isDirectory: isDirectory(target),
    hasPackageJson: false,
    packageName: null,
    hasReact: false,
    devScripts: [],
    framework: null,
    hostFramework: null,
  }
  if (!result.isDirectory) return result

  const pkg = readPackageJson(target)
  result.hasPackageJson = hasFile(target, "package.json")
  const htmlPage = hasHtmlPage(target)
  if (!pkg) {
    // A folder of pages a static server serves has no manifest to read.
    if (htmlPage) result.framework = result.hostFramework = "html"
    return result
  }

  result.packageName = typeof pkg.name === "string" ? pkg.name : null
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies }
  result.hasReact = Boolean(dependencies.react)

  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}
  const named = Object.keys(scripts).filter(
    (name) => typeof scripts[name] === "string" && DEV_SCRIPT_FAMILY.test(name)
  )
  const preferred = PREFERRED_DEV_SCRIPTS.filter((name) => named.includes(name))
  result.devScripts = [...preferred, ...named.filter((name) => !preferred.includes(name))]

  // Angular first: it ships a `vite.config.ts` in some scaffolds, and calling
  // such a project "vite" would name the bundler where the row wants the
  // framework the editor is about to treat it as.
  if (dependencies["@angular/core"]) result.framework = "angular"
  else if (NEXT_CONFIGS.some((name) => hasFile(target, name))) result.framework = "nextjs"
  else if (VITE_CONFIGS.some((name) => hasFile(target, name))) result.framework = "vite"
  else if (dependencies["react-scripts"]) result.framework = "cra"

  if (result.framework === "angular") result.hostFramework = "angular"
  else if (result.hasReact) result.hostFramework = "react"
  else if (htmlPage) result.hostFramework = "html"

  return result
}
