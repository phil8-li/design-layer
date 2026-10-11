/**
 * The start screen: the flow that replaces typing a port on the command line.
 *
 * The pieces are a discovery module that reads the machine, a loopback server
 * that carries the choice, and a page. This suite pins the two that have to be
 * correct rather than merely nice, and it pins the contract BETWEEN them —
 * three lanes were written against those names in parallel, so a renamed field
 * is the defect this file exists to catch.
 *
 * What is worth a case:
 *  - discovery degrades instead of throwing. It runs on a machine nobody can
 *    see, where half the directories are TCC-denied and `lsof` may refuse to
 *    name another process's cwd. Every function has to answer anyway;
 *  - the refusals are the safety story. This process writes source files and
 *    proxies whatever it is pointed at, so a non-loopback target, a folder with
 *    no package.json, and a project with no React are all rejected BEFORE the
 *    launch, with a sentence the page can show;
 *  - `ready` means the proxy this process started is up. A stale endpoint file
 *    from a previous run parses perfectly and would redirect the browser to a
 *    dead port, so the pid is what the check is really on;
 *  - the screen outlives every editor it starts. It used to latch shut on the
 *    first press, which is what made the whole command a one-way door: the only
 *    way to design a second app was to kill the process. A second choice being
 *    accepted is the point of the supervisor, so it is pinned here.
 *
 * Usage: node designlayer/test/start-screen-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { JSDOM, VirtualConsole } from "jsdom"

import {
  DEFAULT_SCAN_PORTS,
  describeProject,
  projectRootForPort,
  projectRootFromPage,
  scanLocalApps,
} from "../runtime/local-apps.mjs"
import { startScreenPage } from "../runtime/start-screen-page.mjs"
// The stylesheet, for the type cases at the foot of this file. It is a separate
// module from the page and imports the built token bundle, so it is read here
// directly rather than scraped back out of the `<style>` the page inlines.
import { startScreenStyle } from "../runtime/start-screen-style.mjs"
import { tokens } from "../dist/tokens.mjs"
import { PREFERRED_START_SCREEN_PORT, createStartScreen } from "../runtime/start-screen.mjs"

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

const temporary = []
function fixture(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `designlayer-${prefix}-`)))
  temporary.push(dir)
  return dir
}

/** A project the start screen should accept: package.json, React, a dev script. */
function reactProject(extra = {}) {
  const dir = fixture("project")
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      private: true,
      dependencies: { react: "19.0.0" },
      scripts: { dev: "node app.mjs", build: "true" },
      ...extra,
    })
  )
  return dir
}

/** A page server standing in for someone's dev server. */
function pageServer(title, body = "hi") {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`)
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, close: () => server.close() })
    )
  })
}

async function freePort() {
  const { server, port } = await pageServer("gone")
  await new Promise((resolve) => server.close(resolve))
  return port
}

const json = async (url, init) => {
  const response = await fetch(url, init)
  return { status: response.status, body: await response.json().catch(() => null) }
}

console.log("\nDiscovery")

await check("the scan list covers the ports a local app is actually on", () => {
  assert.ok(Array.isArray(DEFAULT_SCAN_PORTS))
  assert.ok(DEFAULT_SCAN_PORTS.includes(3000), "Next's default")
  assert.ok(DEFAULT_SCAN_PORTS.includes(5173), "Vite's default")
  assert.ok(DEFAULT_SCAN_PORTS.every((port) => Number.isInteger(port)))
})

await check("a running app is found, and named by its own <title>", async () => {
  const app = await pageServer("Host App")
  try {
    const apps = await scanLocalApps({ ports: [app.port] })
    assert.equal(apps.length, 1)
    assert.equal(apps[0].port, app.port)
    assert.equal(apps[0].title, "Host App")
    assert.match(apps[0].url, new RegExp(`:${app.port}$`))
    // Present on every hit, even when the machine will not say.
    assert.ok("projectRoot" in apps[0] && "packageName" in apps[0])
  } finally {
    app.close()
  }
})

await check("a port nobody is on is not an error", async () => {
  assert.deepEqual(await scanLocalApps({ ports: [await freePort()] }), [])
})

/*
 * The folder an app row carries. `lsof -d cwd` is the direct answer and a
 * managed Mac refuses it for the user's own dev servers, which left every row
 * with no folder and made the person type out a path the machine already knew.
 * A dev server writes absolute paths into its own page, so the page is the way
 * around a permission the process cannot get.
 */
await check("a dev server that names itself in its page needs no permission", () => {
  const root = reactProject()
  fs.mkdirSync(path.join(root, ".next"), { recursive: true })
  const trace = `at Layout (${root}/.next/dev/server/chunks/ssr/app_page_tsx.js:35:28)`
  assert.equal(projectRootFromPage(`<script>x=${JSON.stringify(trace)}</script>`), root)
})

await check("a path with spaces in it survives the page and the URL alike", () => {
  const root = path.join(fixture("Client Projects Local"), "host app")
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "host-app" }))
  assert.equal(projectRootFromPage(`at Boot (${root}/.next/dev/server/x.js:1:1)`), root)
  // The same path also arrives percent-encoded, inside a file:// URL.
  const encoded = root.split("/").map(encodeURIComponent).join("/")
  assert.equal(projectRootFromPage(`"file://${encoded}/.next/dev/server/x.js"`), root)
})

await check("a path in a page that leads nowhere is not a project folder", () => {
  assert.equal(projectRootFromPage("<html>nothing here</html>"), null)
  assert.equal(projectRootFromPage("at X (/no/such/place/.next/dev/server/x.js:1:1)"), null)
  assert.equal(projectRootFromPage("at X (relative/.next/dev/x.js:1:1)"), null)
})

await check("the folder reaches the app row the page came from", async () => {
  const root = reactProject()
  fs.mkdirSync(path.join(root, ".next"), { recursive: true })
  // Past where a title lives, so the read has to keep going to find it.
  const app = await pageServer("Host App", `${"<p>filler</p>".repeat(1200)}
    <script>window.__t = "at Layout (${root}/.next/dev/server/chunks/ssr/page.js:1:1)"</script>`)
  try {
    const [found] = await scanLocalApps({ ports: [app.port] })
    assert.equal(found.projectRoot, root)
    assert.equal(found.packageName, "fixture-app")
  } finally {
    app.close()
  }
})

await check("the cwd probe answers, or answers null — it never throws", async () => {
  const app = await pageServer("probe")
  try {
    const root = await projectRootForPort(app.port)
    assert.ok(root === null || typeof root === "string")
  } finally {
    app.close()
  }
})

/** A page server in its own process, started in `cwd`, as a dev server is. */
async function childServer(cwd, title) {
  const { spawn } = await import("node:child_process")
  const source = `const s = require("node:http").createServer((q, r) => {
    r.writeHead(200, { "content-type": "text/html" }); r.end("<title>${title}</title>")
  }); s.listen(0, "127.0.0.1", () => console.log(s.address().port))`
  const child = spawn(process.execPath, ["-e", source], { cwd, stdio: ["ignore", "pipe", "inherit"] })
  const port = await new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))))
  return { port, pid: child.pid, close: () => child.kill() }
}

/*
 * A dev server can be on any port. One pinned to 3041 was running, answering,
 * and absent from both the start screen and the editor's chooser, because the
 * scan only probed a fixed list. Ports off that list count when the process on
 * them runs from a project the editor can open, and never when it is the
 * editor's own.
 */
await check("an app on a port off the fixed list is found by its project", async () => {
  const react = await childServer(reactProject(), "Pinned Port App")
  const plain = await childServer(fixture("not-a-project"), "Some Desktop Helper")
  try {
    if ((await projectRootForPort(react.port)) === null) {
      console.log("       skip (this machine will not name another process's folder)")
      return
    }
    const found = await scanLocalApps({ ports: [], discover: { pids: [], ports: [] } })
    const row = found.find((app) => app.port === react.port)
    assert.ok(row, "the app on an unlisted port is missing")
    assert.equal(row.title, "Pinned Port App")
    assert.equal(row.packageName, "fixture-app")
    assert.ok(!found.some((app) => app.port === plain.port), "a server outside any React project was listed")

    // The editor's own processes run from the project they edit; they are not apps.
    const byPid = await scanLocalApps({ ports: [], discover: { pids: [react.pid], ports: [] } })
    assert.ok(!byPid.some((app) => app.port === react.port), "an excluded pid was listed")
    const byPort = await scanLocalApps({ ports: [react.port], discover: { pids: [], ports: [react.port] } })
    assert.ok(!byPort.some((app) => app.port === react.port), "an excluded port was listed")

    // Without `discover`, the fixed list is all there is.
    assert.deepEqual(await scanLocalApps({ ports: [] }), [])
  } finally {
    react.close()
    plain.close()
  }
})

await check("a project describes itself completely", () => {
  const dir = reactProject()
  fs.writeFileSync(path.join(dir, "next.config.mjs"), "export default {}\n")
  const project = describeProject(dir)
  assert.equal(project.exists, true)
  assert.equal(project.isDirectory, true)
  assert.equal(project.hasPackageJson, true)
  assert.equal(project.packageName, "fixture-app")
  assert.equal(project.hasReact, true)
  assert.ok(project.devScripts.includes("dev"))
  assert.equal(project.framework, "nextjs")
})

await check("a directory that is not there still answers every field", () => {
  const project = describeProject(path.join(os.tmpdir(), "designlayer-does-not-exist"))
  for (const key of [
    "path",
    "name",
    "exists",
    "isDirectory",
    "hasPackageJson",
    "packageName",
    "hasReact",
    "devScripts",
    "framework",
  ]) {
    assert.ok(key in project, `missing ${key}`)
  }
  assert.equal(project.exists, false)
  assert.deepEqual(project.devScripts, [])
})

console.log("\nThe screen")

const app = await pageServer("Host App")
const project = reactProject()
const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })

await check("it binds on loopback and serves one page", async () => {
  assert.match(screen.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  const response = await fetch(`${screen.url}/`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /text\/html/)
  const html = await response.text()
  assert.match(html.slice(0, 200).toLowerCase(), /<!doctype html/)
  // The two ways in, both on the page: type the address, paste the folder.
  assert.match(html, /<input id="url"/)
  assert.match(html, /<input id="folder-path"/)
})

await check("it reports what is running", async () => {
  const { status, body } = await json(`${screen.url}/api/apps`)
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.apps))
})

await check("it describes a folder", async () => {
  const { status, body } = await json(
    `${screen.url}/api/project?path=${encodeURIComponent(project)}`
  )
  assert.equal(status, 200)
  assert.equal(body.project.hasReact, true)
})

await check("a relative path is refused", async () => {
  const { status } = await json(`${screen.url}/api/project?path=..`)
  assert.equal(status, 400)
})

// A path is pasted into a text field here, and every other place a path is
// written on this machine — the shell, Finder's Copy as Pathname — writes `~`.
await check("a pasted ~ is the home directory, not a relative path", async () => {
  const { status, body } = await json(`${screen.url}/api/project?path=${encodeURIComponent("~")}`)
  assert.equal(status, 200)
  assert.equal(body.project.path, os.homedir())
  assert.equal(body.project.isDirectory, true)
})

// Dragging a folder onto a terminal is the most direct way to get a path out of
// the Finder, and it writes the shell's escaping along with it.
await check("a path pasted with shell escaping still finds the folder", async () => {
  const dir = fixture("with space")
  const spaced = path.join(dir, "Client Projects Local")
  fs.mkdirSync(spaced)
  const escaped = spaced.replace(/ /g, "\\ ")

  const { status, body } = await json(`${screen.url}/api/project?path=${encodeURIComponent(escaped)}`)
  assert.equal(status, 200)
  assert.equal(body.project.path, spaced)
  assert.equal(body.project.isDirectory, true)
})

await check("a folder whose name really has a backslash is not unescaped away", async () => {
  const dir = fixture("backslash")
  const odd = path.join(dir, "a\\ b")
  fs.mkdirSync(odd)
  const { body } = await json(`${screen.url}/api/project?path=${encodeURIComponent(odd)}`)
  assert.equal(body.project.path, odd)
  assert.equal(body.project.isDirectory, true)
})

const start = (payload) =>
  json(`${screen.url}/api/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })

await check("a target that is not local is refused, in a sentence", async () => {
  const { status, body } = await start({
    url: "https://example.com",
    projectRoot: project,
    devScript: null,
  })
  assert.equal(status, 400)
  assert.match(body.error, /local|loopback|localhost/i)
})

await check("a folder with no package.json is refused", async () => {
  const { status, body } = await start({
    url: `http://127.0.0.1:${app.port}`,
    projectRoot: fixture("empty"),
    devScript: null,
  })
  assert.equal(status, 400)
  assert.match(body.error, /package\.json/i)
})

await check("a project without React is refused before the launch, not after", async () => {
  const dir = fixture("plain")
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "plain" }))
  const { status, body } = await start({
    url: `http://127.0.0.1:${app.port}`,
    projectRoot: dir,
    devScript: null,
  })
  assert.equal(status, 400)
  assert.match(body.error, /react/i)
})

await check("a dev script the project does not have is refused", async () => {
  const { status, body } = await start({
    url: `http://127.0.0.1:${app.port}`,
    projectRoot: project,
    devScript: "nope",
  })
  assert.equal(status, 400)
  assert.match(body.error, /nope|script/i)
})

await check("an off-origin page cannot reach it", async () => {
  const { status } = await json(`${screen.url}/api/apps`, {
    headers: { origin: "https://evil.example" },
  })
  assert.ok(status >= 400, `expected a refusal, got ${status}`)
})

await check("an unknown path is a 404", async () => {
  const response = await fetch(`${screen.url}/nope`)
  assert.equal(response.status, 404)
})

// The native folder panel that used to answer here was dropped: a typed path is
// the only way to name a project folder now. A route removed by halves is the
// failure worth pinning — a 405 would mean some method is still registered on
// the path, and no answer at all would mean a page still calling it hangs
// instead of saying so.
await check("the folder panel's route is gone, not merely unanswered", async () => {
  const { status, body } = await json(`${screen.url}/api/browse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ startIn: os.homedir() }),
  })
  assert.equal(status, 404)
  assert.match(body.error, /no start screen route/i)
  // And nothing on the page asks for it.
  assert.doesNotMatch(startScreenPage(), /api\/browse/)
})

await check("status stays false until an endpoint file says otherwise", async () => {
  const { body } = await json(`${screen.url}/api/status`)
  assert.equal(body.ready, false)
})

await check("a stale endpoint file from another run is not ready", async () => {
  const file = path.join(fixture("state"), "endpoint.json")
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid + 1, proxyPort: 4312 }))
  screen.reportEndpointFile(file)
  const { body } = await json(`${screen.url}/api/status`)
  assert.equal(body.ready, false)
})

await check("this run's endpoint file flips it to ready, with the proxy URL", async () => {
  const file = path.join(fixture("state"), "endpoint.json")
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, proxyPort: 4312, wsPort: 4313 }))
  screen.reportEndpointFile(file)
  const { body } = await json(`${screen.url}/api/status`)
  assert.equal(body.ready, true)
  assert.equal(body.url, "http://localhost:4312")
})

/*
 * The launcher runs in this same process, so the endpoint file was never the
 * fact — only a way of carrying it, and one that fails whenever the project
 * folder refuses to be written to. When it does, the proxy is up, the page is
 * still polling, and "Starting the editor…" stays on screen forever.
 */
await check("the proxy being up is not a file the project folder has to accept", async () => {
  const deaf = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  try {
    // No endpoint file was ever reported: the write it would have come from failed.
    assert.equal((await json(`${deaf.url}/api/status`)).body.ready, false)
    deaf.reportReady("http://localhost:4344")
    const { body } = await json(`${deaf.url}/api/status`)
    assert.equal(body.ready, true)
    assert.equal(body.url, "http://localhost:4344")
  } finally {
    deaf.close()
  }
})

await check("a valid choice resolves the handoff the CLI is waiting on", async () => {
  const response = await start({
    url: `http://127.0.0.1:${app.port}`,
    projectRoot: project,
    devScript: "dev",
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)

  const choice = await Promise.race([
    screen.chosen,
    new Promise((_, reject) => setTimeout(() => reject(new Error("chosen never resolved")), 2000)),
  ])
  assert.equal(choice.appPort, app.port)
  assert.equal(choice.projectRoot, project)
  assert.equal(choice.devScript, "dev")
  assert.match(choice.appUrl, new RegExp(`:${app.port}$`))
  // The supervisor names the running editor on the page, and this is where the
  // name comes from — the manifest it just read to validate the folder.
  assert.equal(choice.packageName, "fixture-app")
})

// The press before this one is still on its way up, and the supervisor has not
// spawned anything yet. Acting on a second would kill a child the first is
// waiting on, so it is refused — and refused in words, on the screen.
// One app, one editor: a second press for the app that is already starting is
// that same editor, not a refusal and not a second process.
await check("a second press before the editor answers is the same press", async () => {
  const { status, body } = await start({
    url: `http://127.0.0.1:${app.port}`,
    projectRoot: project,
    devScript: "dev",
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.existing, true)
  assert.equal(body.replaced, null)
  assert.equal(typeof body.id, "string")
})

screen.close()

console.log("\nSwitching apps")

/*
 * The whole point of the supervisor. Before it, `/api/start` latched shut on
 * the first press for the life of the process: the page bounced to the editor
 * forever, and designing a second app meant Ctrl+C and starting over.
 */
await check("a second choice is accepted once the first editor is up", async () => {
  const second = await pageServer("Second")
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const press = (port) =>
    json(`${screen.url}/api/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${port}`, projectRoot: project, devScript: null }),
    })
  try {
    const first = screen.nextChoice()
    assert.equal((await press(app.port)).status, 200)
    assert.equal((await first).appPort, app.port)

    // The supervisor's loop: ask again the moment the child is spawned, then
    // report the URL it answered with.
    const next = screen.nextChoice()
    screen.reportReady("http://127.0.0.1:3456", {
      appUrl: `http://127.0.0.1:${app.port}`,
      projectRoot: project,
      packageName: "fixture-app",
    })

    assert.equal((await press(second.port)).status, 200)
    const choice = await Promise.race([
      next,
      new Promise((_, reject) => setTimeout(() => reject(new Error("the second choice never arrived")), 2000)),
    ])
    assert.equal(choice.appPort, second.port)
    // `chosen` is still the first choice, for the callers that only ever want one.
    assert.equal((await screen.chosen).appPort, app.port)
  } finally {
    screen.close()
    second.close()
  }
})

/*
 * A switch usually lands the new proxy on the very port the old one had, so a
 * page that kept the old URL and waited for it to change would follow the
 * corpse. Accepting a choice is what clears the old editor from the answer.
 */
// The top-level answer is about the newest choice, so a page waiting on it
// waits for the editor it asked for; every running editor is in `editors`.
await check("status says what is being edited, and answers for the newest choice", async () => {
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  try {
    const idle = (await json(`${screen.url}/api/status`)).body
    assert.deepEqual(idle, { ready: false, editing: null, stopped: null, editors: [] })

    screen.reportReady("http://127.0.0.1:3456", {
      appUrl: "http://127.0.0.1:3000",
      projectRoot: project,
      packageName: "fixture-app",
    })
    const running = (await json(`${screen.url}/api/status`)).body
    assert.equal(running.ready, true)
    assert.equal(running.url, "http://localhost:3456")
    assert.equal(running.editing.appUrl, "http://127.0.0.1:3000")
    assert.equal(running.editing.packageName, "fixture-app")
    assert.equal(running.editing.projectRoot, project)
    assert.equal(running.stopped, null)
    assert.equal(running.editors.length, 1)

    screen.nextChoice()
    const accepted = await json(`${screen.url}/api/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${app.port}`, projectRoot: project, devScript: null }),
    })
    assert.equal(accepted.status, 200)
    const switching = (await json(`${screen.url}/api/status`)).body
    assert.equal(switching.ready, false)
    assert.equal(switching.editing, null)
  } finally {
    screen.close()
  }
})

// A child that dies on its own must not be a dead terminal. The screen is still
// up, so it is where the explanation goes and where the next attempt starts.
await check("an editor that stops clears readiness and leaves a sentence behind", async () => {
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  try {
    screen.reportReady("http://127.0.0.1:3456", {
      appUrl: "http://127.0.0.1:3000",
      projectRoot: project,
      packageName: "fixture-app",
    })
    screen.reportStopped("The editor for fixture-app stopped with code 1.")
    const { body } = await json(`${screen.url}/api/status`)
    assert.equal(body.ready, false)
    assert.equal(body.url, undefined)
    assert.equal(body.editing, null)
    assert.match(body.stopped, /stopped with code 1/)

    // And the screen is a chooser again: the round the stopped child closed is
    // open, so the next press is accepted rather than refused as a double.
    const next = screen.nextChoice()
    const { status } = await json(`${screen.url}/api/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${app.port}`, projectRoot: project, devScript: null }),
    })
    assert.equal(status, 200)
    assert.equal((await next).appPort, app.port)
  } finally {
    screen.close()
  }
})

/*
 * The URL has to be one the user can come back to, all session, without reading
 * it off a terminal — so it is a port next to the proxy's rather than whatever
 * the OS handed out. Preferred, though: something else on 3455 moves the screen
 * aside instead of stopping the command.
 *
 * The squatter below plays that "something else". On a machine where the port
 * is ALREADY spoken for — a corporate SSH agent parked on it is a real case —
 * the bind fails, and this used to take the suite down with EADDRINUSE while
 * testing the one behavior that was working perfectly. So a failed bind is now
 * read as what it is: the contended case, already set up for us. The half that
 * needs the port free cannot run there, and says so instead of failing.
 */
await check("the screen prefers one port, and steps aside when it is taken", async () => {
  const squatter = http.createServer()
  const ours = await new Promise((resolve) => {
    squatter.once("error", () => resolve(false))
    squatter.listen(PREFERRED_START_SCREEN_PORT, "127.0.0.1", () => resolve(true))
  })

  const moved = await createStartScreen({ host: "127.0.0.1", log: () => {} })
  const movedPort = Number(new URL(moved.url).port)
  moved.close()
  assert.notEqual(movedPort, PREFERRED_START_SCREEN_PORT)
  assert.ok(movedPort > 0)

  if (!ours) {
    console.log(
      `       skip (something outside the suite holds ${PREFERRED_START_SCREEN_PORT}, ` +
        "so it cannot be claimed back here)"
    )
    return
  }

  await new Promise((resolve) => squatter.close(resolve))
  const preferred = await createStartScreen({ host: "127.0.0.1", log: () => {} })
  const port = Number(new URL(preferred.url).port)
  preferred.close()
  assert.equal(port, PREFERRED_START_SCREEN_PORT)
})

console.log("\nWhat an app is called")

/*
 * Copies of one template share a package name and a page title, so four
 * prototypes all had one name in the editor, on the card, in the Mac app's
 * tabs and in the terminal. Every surface names an app by its folder now.
 */
await check("an app is named by its folder, everywhere", async () => {
  const { appName } = await import("../runtime/app-name.mjs")
  assert.equal(appName({ projectRoot: "/work/pinned copy", packageName: "studio" }), "pinned copy")
  assert.equal(appName({ projectRoot: null, packageName: "studio" }), "studio")
  assert.equal(appName({}), null)

  const { browserPrelude, resolveConfig } = await import("../config.mjs")
  const dir = reactProject({ name: "studio" })
  const prelude = browserPrelude(resolveConfig({ projectRoot: dir }), { proxyPort: 4567, appPort: 3041 })
  const payload = JSON.parse(prelude.slice(prelude.indexOf("=") + 1, prelude.indexOf(";window.") > 0 ? prelude.indexOf(";window.") : prelude.lastIndexOf(";")))
  assert.equal(payload.app.name, path.basename(dir), "the editor's own chooser named the package")
})

await check("the card names the app being edited by its folder, and the pick is the app not open yet", async () => {
  const dom = new JSDOM(startScreenPage(), { runScripts: "outside-only", url: "http://127.0.0.1:3455/" })
  const editor = {
    id: "e1",
    state: "ready",
    name: "pinned",
    appUrl: "http://127.0.0.1:3041",
    appPort: 3041,
    projectRoot: "/work/pinned",
    packageName: "studio",
    url: "http://localhost:3456/#/home",
  }
  dom.window.fetch = async (target) => {
    const url = new URL(target, "http://127.0.0.1:3455")
    const body =
      url.pathname === "/api/status"
        ? { ready: true, url: editor.url, editing: editor, stopped: null, editors: [editor] }
        : url.pathname === "/api/apps"
          ? {
              apps: [
                { port: 3000, url: "http://127.0.0.1:3000", title: "Studio", projectRoot: "/work/vision", packageName: "studio", editor: null },
                { port: 3041, url: "http://127.0.0.1:3041", title: "Studio", projectRoot: "/work/pinned", packageName: "studio", editor: { id: "e1", url: editor.url } },
              ],
            }
          : { project: { path: url.searchParams.get("path"), name: path.basename(url.searchParams.get("path")), exists: true, isDirectory: true, hasPackageJson: true, packageName: "studio", hasReact: true, devScripts: ["dev"], framework: "vite" } }
    return { ok: true, status: 200, json: async () => body }
  }
  try {
    dom.window.eval(/<script type="module">([\s\S]*)<\/script>/.exec(startScreenPage())[1])
    await new Promise((resolve) => setTimeout(resolve, 50))
    const $ = (id) => dom.window.document.getElementById(id)
    assert.equal($("current-name").textContent, "Continue editing pinned?")
    // Behind "Open another app", the pick is the app that has no editor yet:
    // whoever goes past the card is adding another app, not reopening this one.
    assert.equal($("apps").querySelector('[aria-checked="true"]').dataset.port, "3000")
    assert.match($("apps-note").textContent, /Picked vision for you/)
  } finally {
    dom.window.close()
  }
})

console.log("\nThe page you asked for")

/*
 * The chooser is where you say which app AND which page, and only the first
 * half used to survive: `http://127.0.0.1:3000/ds` started the right editor and
 * landed the browser on the app's "/".
 *
 * The path never reaches the child, and it should not — the proxy serves the
 * whole app, so one page is the same process on a different address. It has to
 * survive from the press to the moment the page is told where to go, which is
 * `/api/status` and nowhere else.
 */
async function withScreen(run) {
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const press = (url) =>
    json(`${screen.url}/api/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, projectRoot: project, devScript: null }),
    })
  const status = async () => (await json(`${screen.url}/api/status`)).body
  try {
    await run({ screen, press, status })
  } finally {
    screen.close()
  }
}

await check("the page the address named is the page the browser is sent to", async () => {
  await withScreen(async ({ screen, press, status }) => {
    assert.equal((await press(`http://127.0.0.1:${app.port}/ds`)).status, 200)
    screen.reportReady("http://127.0.0.1:3456", { appUrl: `http://127.0.0.1:${app.port}` })
    assert.equal((await status()).url, "http://localhost:3456/ds")
    // The app is still the whole app. Only the browser's destination differs,
    // so what the launcher was handed has to be the origin, unchanged.
    assert.equal((await screen.chosen).appUrl, `http://127.0.0.1:${app.port}`)
    assert.equal((await screen.chosen).appPort, app.port)
  })
})

// Every URL this server has ever reported was a bare origin, and the page and
// the tests alike compare it as a string.
await check("a choice with no page reports exactly the URL it always did", async () => {
  for (const typed of [`http://127.0.0.1:${app.port}`, `http://127.0.0.1:${app.port}/`]) {
    await withScreen(async ({ screen, press, status }) => {
      assert.equal((await press(typed)).status, 200)
      screen.reportReady("http://127.0.0.1:3456")
      assert.equal((await status()).url, "http://localhost:3456")
    })
  }
})

// A query string is how a page says which of itself to show, and so is a
// fragment: an app with a hash router keeps its whole page there.
await check("the query string and the fragment are both part of the page", async () => {
  await withScreen(async ({ screen, press, status }) => {
    assert.equal((await press(`http://127.0.0.1:${app.port}/ds?theme=dark#row-4`)).status, 200)
    screen.reportReady("http://127.0.0.1:3456")
    assert.equal((await status()).url, "http://localhost:3456/ds?theme=dark#row-4")
  })
  await withScreen(async ({ screen, press, status }) => {
    const page = "/#/dev-tools/playground?app=demo&view=agent"
    assert.equal((await press(`http://127.0.0.1:${app.port}${page}`)).status, 200)
    screen.reportReady("http://127.0.0.1:3456")
    assert.equal((await status()).url, `http://localhost:3456${page}`)
  })
})

/*
 * Apps branch on `location.hostname === "localhost"` — a dev sign-in bypass, an
 * auth-provider allowlist. Served from `127.0.0.1`, such an app showed its
 * signed-out screen inside the editor. That happened for a typed address, a row
 * pick and a switch from the editor's chooser alike, so every editor address
 * the browser is sent to is on localhost, whatever spelling chose the app.
 */
await check("the browser is always sent to the editor on localhost", async () => {
  for (const typed of [`http://localhost:${app.port}/#/home`, `http://127.0.0.1:${app.port}/#/home`]) {
    await withScreen(async ({ screen, press, status }) => {
      assert.equal((await press(typed)).status, 200)
      screen.reportReady("http://127.0.0.1:3456")
      assert.equal((await status()).url, "http://localhost:3456/#/home")
      // The proxy is still aimed at the address that was typed.
      assert.equal((await screen.chosen).appUrl, new URL(typed).origin)
    })
  }
})

/*
 * A bare address — a row click — opens the page that app was last used on.
 * Copies of one template share a home page, so the root of the app picked
 * looked like a different app.
 */
await check("a bare address opens the page that app was last used on", async () => {
  const home = fixture("home")
  const before = process.env.HOME
  process.env.HOME = home
  try {
    const { rememberPage } = await import("../runtime/last-pages.mjs")
    rememberPage({ port: app.port, projectRoot: project, page: "/#/agents/a1?view=agent" })
    await withScreen(async ({ screen, press, status }) => {
      assert.equal((await press(`http://127.0.0.1:${app.port}`)).status, 200)
      screen.reportReady("http://127.0.0.1:3456")
      assert.equal((await status()).url, "http://localhost:3456/#/agents/a1?view=agent")
    })
    // A typed page is still the page.
    await withScreen(async ({ screen, press, status }) => {
      assert.equal((await press(`http://127.0.0.1:${app.port}/#/settings`)).status, 200)
      screen.reportReady("http://127.0.0.1:3456")
      assert.equal((await status()).url, "http://localhost:3456/#/settings")
    })
  } finally {
    process.env.HOME = before
  }
})

// The endpoint file is the other way readiness arrives, on the runs where the
// launcher is a separate process. It names a port, never a page.
await check("the page is on the end of the endpoint file's URL too", async () => {
  await withScreen(async ({ screen, press, status }) => {
    const file = path.join(fixture("state"), "endpoint.json")
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, proxyPort: 4312 }))
    screen.reportEndpointFile(file)
    assert.equal((await press(`http://127.0.0.1:${app.port}/ds`)).status, 200)
    assert.equal((await status()).url, "http://localhost:4312/ds")
  })
})

/*
 * One app, one editor: pressing the app again does not restart its editor, so
 * the editor stays ready and keeps the page it is on. A restart here used to
 * throw away the work open in another tab on that editor. HOME is a temporary
 * folder because a bare press reads the app's saved page from the machine.
 */
await check("the same app pressed again keeps its editor and its page", async () => {
  const before = process.env.HOME
  process.env.HOME = fixture("home")
  try {
    await withScreen(async ({ screen, press, status }) => {
      await press(`http://127.0.0.1:${app.port}/ds`)
      screen.reportReady("http://127.0.0.1:3456")
      assert.equal((await status()).url, "http://localhost:3456/ds")

      screen.nextChoice()
      const again = await press(`http://127.0.0.1:${app.port}`)
      assert.equal(again.body.existing, true)
      assert.equal((await status()).ready, true)
      assert.equal((await status()).url, "http://localhost:3456/ds")
    })
  } finally {
    process.env.HOME = before
  }
})

await check("a page does not outlive the editor it belonged to", async () => {
  await withScreen(async ({ screen, press, status }) => {
    await press(`http://127.0.0.1:${app.port}/ds`)
    screen.reportReady("http://127.0.0.1:3456")
    screen.reportStopped("The editor for fixture-app stopped with code 1.")
    assert.equal((await status()).ready, false)
    // Whatever comes up next is not the app that asked for /ds.
    screen.reportReady("http://127.0.0.1:3456")
    assert.equal((await status()).url, "http://localhost:3456")
  })
})

console.log("\nPicking a row")

/*
 * The page's own script, over the page's own markup, with the loopback routes
 * answered from a table.
 *
 * Which folder a row leaves behind is a decision the page makes and the server
 * never sees, so this is the only place it can be pinned. The routes are canned
 * rather than served because the row that matters is the one a real machine has
 * to be coaxed into producing: an app whose source folder nobody can work out.
 */
const CLIENT = /<script type="module">([\s\S]*)<\/script>/.exec(startScreenPage())[1]

/*
 * `routes` answers a path from a function of the URL and the parsed request
 * body, ahead of the defaults; null is a 404. Every request lands in
 * `dom.requests`, so a case can say what was NOT asked for. jsdom cannot
 * navigate, and says so; each attempt lands in `dom.navigations`. `before`
 * gets the window ahead of the script, to make it a frame of something.
 */
async function mountPage(apps, projects, folders = {}, routes = {}, before = () => {}) {
  const navigations = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.forwardTo(console, { jsdomErrors: "none" })
  virtualConsole.on("jsdomError", (error) => {
    if (error.type === "not-implemented" && /navigation/i.test(error.message)) navigations.push(error.message)
    else console.error(error.cause?.stack ?? error.message)
  })
  const dom = new JSDOM(startScreenPage(), { runScripts: "outside-only", url: "http://127.0.0.1:3455/", virtualConsole })
  dom.navigations = navigations
  dom.requests = []
  before(dom.window)
  dom.window.fetch = async (target, init = {}) => {
    const url = new URL(target, "http://127.0.0.1:3455")
    const sent = init.body ? JSON.parse(init.body) : null
    dom.requests.push({ method: init.method ?? "GET", path: url.pathname + url.search, body: sent })
    const body =
      url.pathname in routes
        ? await routes[url.pathname](url, sent)
        : url.pathname === "/api/status"
          ? { ready: false, editing: null, stopped: null, editors: [] }
          : url.pathname === "/api/apps"
            ? { apps }
            : url.pathname === "/api/project"
              ? { project: projects[url.searchParams.get("path")] }
              : url.pathname === "/api/app-folder"
                ? { project: folders[new URL(url.searchParams.get("url")).port] ?? null }
                : null
    return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body }
  }
  dom.window.eval(CLIENT)
  // `boot()` is several awaits deep before the first row is on screen.
  await new Promise((resolve) => setTimeout(resolve, 50))
  return dom
}

/** What `describeProject` would say about a folder that is fine. */
const projectSaid = (dir) => ({
  path: dir,
  name: path.basename(dir),
  exists: true,
  isDirectory: true,
  hasPackageJson: true,
  packageName: path.basename(dir),
  hasReact: true,
  devScripts: ["dev"],
  framework: "nextjs",
})

const KNOWN = "/Users/someone/Projects/host app"
const ROWS = [
  { port: 3000, url: "http://127.0.0.1:3000", title: "Host App", projectRoot: KNOWN, packageName: "host-app" },
  // The 500 page a broken dev server serves carries no absolute path, and the
  // same machine refuses `lsof -d cwd` for its owner's processes. Between them
  // there is nothing left to work the folder out from.
  { port: 3001, url: "http://127.0.0.1:3001", title: "127.0.0.1:3001", projectRoot: null, packageName: null },
]

/*
 * The dangerous one. Picking the second row used to leave the first row's
 * folder standing, so Start was enabled with THIS server and THAT app's source
 * tree — every edit written into the wrong project.
 */
await check("a row whose folder is unknown never inherits the last row's", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    const rows = [...$("apps").children]
    assert.equal(rows.length, 2)

    rows[0].click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal($("url").value, "http://127.0.0.1:3000")
    assert.equal($("folder-path").value, KNOWN)
    assert.equal($("submit").disabled, false)

    rows[1].click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal($("url").value, "http://127.0.0.1:3001")
    assert.equal($("folder-path").value, "", "the other app's source tree is still in the field")
    // Said plainly, where the field it emptied is, rather than left to be noticed.
    assert.equal($("folder-error").hidden, false)
    assert.match($("folder-error").textContent, /could not|cannot/i)
    assert.match($("folder-error").textContent, /3001/)
    /*
     * The BUTTON is no longer the thing that says no — the sentence is.
     *
     * This used to assert `submit.disabled === true`, which was the whole of
     * the old refusal: a grey rectangle that could not be focused, could not be
     * hovered, and explained nothing. It is enabled now, and pressing it is how
     * a user learns what is missing. So what has to hold here is the pair that
     * actually protects the wrong project — the field is empty, and the field
     * is flagged — plus the guarantee that pressing anyway cannot start.
     */
    assert.equal($("submit").disabled, false, "the refusal is a sentence now, not a dead button")
    assert.equal($("folder-path").getAttribute("aria-invalid"), "true")

    $("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(dom.window.document.activeElement, $("folder-path"), "the gap did not take focus")
    assert.equal($("submit-error").hidden, false)
    assert.match($("submit-error").textContent, /folder/i)
    assert.equal($("waiting").hidden, true, "a press with no folder started something")

    // And back: the row that does know its folder fills it in again.
    rows[0].click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal($("folder-path").value, KNOWN)
    assert.equal($("folder-error").hidden, true)
    assert.equal($("folder-path").getAttribute("aria-invalid"), null)
  } finally {
    dom.window.close()
  }
})

// A path in the field is the page the user asked for, and picking the row it
// already belongs to must not throw it away.
await check("clicking the row you are already on keeps the page you typed", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    $("url").value = "http://127.0.0.1:3000/ds?theme=dark"
    ;[...$("apps").children][0].click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal($("url").value, "http://127.0.0.1:3000/ds?theme=dark")

    // A different row is a different app, so the page goes with the origin.
    ;[...$("apps").children][1].click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal($("url").value, "http://127.0.0.1:3001")
  } finally {
    dom.window.close()
  }
})

/*
 * The screen clicks the first row on its own, so its folder is in the field
 * before anyone types. Pasting the address of a different app used to leave it
 * there: Start proxied the pasted app and wrote its edits into the first one.
 */
const PINNED = "/Users/someone/Projects/pinned app"
const ELSEWHERE = "/Users/someone/Projects/elsewhere"
const typeAddress = async (dom, value) => {
  const field = dom.window.document.getElementById("url")
  field.value = value
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 400))
}

await check("a typed address brings its own app's folder", async () => {
  const rows = [
    ...ROWS,
    { port: 3041, url: "http://127.0.0.1:3041", title: "Pinned", projectRoot: PINNED, packageName: "pinned" },
  ]
  const dom = await mountPage(rows, { [KNOWN]: projectSaid(KNOWN), [PINNED]: projectSaid(PINNED) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    assert.equal($("folder-path").value, KNOWN, "boot did not pick the first row")
    const typed = "http://localhost:3041/#/dev-tools/playground?app=demo"
    await typeAddress(dom, typed)
    assert.equal($("folder-path").value, PINNED, "the first row's folder stayed for another app")
    assert.equal($("url").value, typed, "the typed page was replaced")
  } finally {
    dom.window.close()
  }
})

// Copies of one template share its page title; every row is named by its folder.
await check("rows are named by their folders, not their shared titles", async () => {
  const rows = [
    { port: 3000, url: "http://127.0.0.1:3000", title: "Studio", projectRoot: KNOWN, packageName: "studio" },
    { port: 3041, url: "http://127.0.0.1:3041", title: "Studio", projectRoot: PINNED, packageName: "studio" },
    { port: 4200, url: "http://127.0.0.1:4200", title: "Docs", projectRoot: ELSEWHERE, packageName: "docs" },
  ]
  const dom = await mountPage(rows, { [KNOWN]: projectSaid(KNOWN) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    const names = [...$("apps").querySelectorAll(".app-name")].map((node) => node.textContent)
    assert.deepEqual(names, ["host app", "pinned app", "elsewhere"])
    assert.match($("apps-note").textContent, /host app/)
  } finally {
    dom.window.close()
  }
})

await check("an address no row lists asks the server for its folder", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) }, { 4555: projectSaid(ELSEWHERE) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    await typeAddress(dom, "http://localhost:4555")
    assert.equal($("folder-path").value, ELSEWHERE)

    // Nobody can say where this one is, so the field empties and says why.
    await typeAddress(dom, "http://localhost:4666")
    assert.equal($("folder-path").value, "")
    assert.equal($("folder-error").hidden, false)
    assert.match($("folder-error").textContent, /4666/)
  } finally {
    dom.window.close()
  }
})

await check("a folder the user typed stays when the address changes", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN), [ELSEWHERE]: projectSaid(ELSEWHERE) }, {
    4555: projectSaid(PINNED),
  })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    $("folder-path").value = ELSEWHERE
    $("folder-path").dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    await typeAddress(dom, "http://localhost:4555")
    assert.equal($("folder-path").value, ELSEWHERE)
  } finally {
    dom.window.close()
  }
})

// ── The front door on a cold boot ───────────────────────────────────────────

/*
 * THE STATE THE PRODUCT IS MET IN, and the one it used to answer worst.
 *
 * Nothing running, nothing typed. Measured before this rework: two tab stops on
 * the whole page, both of them empty text fields; zero buttons, because the
 * only one was `disabled` and a disabled button leaves the tab order; zero
 * headings; zero live regions; and `#hint` explicitly blanked, so the single
 * sentence that could have said what the screen wanted was the one branch that
 * rendered nothing.
 *
 * Every case in this section is that measurement turned into a guard. They are
 * about REACHABILITY and being TOLD — not about the specific wording, which is
 * free to improve without failing a test.
 */
console.log("\nA cold boot with nothing running")

const coldPage = () => mountPage([], {})

/*
 * Every word the card is actually showing, in DOM order.
 *
 * `hidden` is honored, and so is the one thing this screen hides with a class
 * rather than the attribute: the list's heading and the "or" rule, which are
 * furniture for a choice and are gone when there is nothing to choose between.
 * jsdom has no cascade worth trusting, so that pair is matched by hand rather
 * than read off `getComputedStyle` — which is also why the budget below is a
 * floor on prose and not a layout measurement.
 */
function shownWords(dom) {
  const document = dom.window.document
  const form = document.getElementById("form")
  const parts = []
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent.trim()
        if (text) parts.push(text)
      } else if (child.nodeType === 1 && !child.hasAttribute("hidden")) {
        const furniture = child.id === "apps-label" || child.classList.contains("or")
        if (furniture && !form.classList.contains("has-apps")) continue
        walk(child)
      }
    }
  }
  walk(document.querySelector("main.card"))
  return parts.join(" ").split(/\s+/).filter(Boolean)
}

/*
 * THE COUNT IS THE POINT, and it is the one thing prose regression can't hide
 * behind.
 *
 * Every sentence this screen accumulated was individually defensible: a hint
 * per state, a help paragraph per field, a recovery clause per error. Ninety-six
 * words in the state a first-time user meets, all of them correct, none of them
 * skimmable. The structure carries it now — a list, a rule reading "or", two
 * labelled boxes — so what is left to read is what the structure cannot say.
 *
 * A budget rather than a fixed number, because the wording is still free to
 * move; a budget with this much room is still less than a quarter of what it
 * replaced, and a paragraph cannot be added back under it.
 */
await check("a cold boot is read in one breath, not six sentences", async () => {
  const dom = await coldPage()
  try {
    const words = shownWords(dom)
    assert.ok(
      words.length <= 28,
      `the cold-boot card shows ${words.length} words (was 96): ${words.join(" ")}`
    )
    const $ = (id) => dom.window.document.getElementById(id)
    // The one fact a user cannot see for themselves — whether anything is up.
    assert.match($("apps-note").textContent, /no dev server is running/i)
    /*
     * And the hint says NOTHING here, which is the inverse of what this case
     * used to assert. It required "Fill in both fields above" — a sentence
     * describing two visibly empty boxes to the person looking at them. The
     * hint's job is now only the facts the screen holds and the screen does not
     * show, and on a cold boot it holds none.
     */
    assert.equal($("hint").hidden, true, "the hint is narrating the layout again")
  } finally {
    dom.window.close()
  }
})

/*
 * The two answers, as two groups rather than as a sentence explaining that
 * there are two. The heading over the list and the "or" above the fields exist
 * only to tell them apart, so they come and go with the list itself — with
 * nothing running there is no alternative for the fields to be the second of.
 */
await check("the two ways in are two groups, and the second only exists beside a first", async () => {
  const cold = await coldPage()
  try {
    assert.equal(cold.window.document.getElementById("form").classList.contains("has-apps"), false)
  } finally {
    cold.window.close()
  }

  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) })
  try {
    const document = dom.window.document
    assert.equal(document.getElementById("form").classList.contains("has-apps"), true)
    // The rule carries one word, which is the whole of what it has to say: the
    // fields are an alternative to the list, not the next step after it.
    const or = document.querySelector(".or")
    assert.ok(or, "nothing on the screen says the two groups are alternatives")
    assert.equal(or.textContent.trim().toLowerCase(), "or")
    // And it sits between them, in reading order.
    const apps = document.getElementById("apps")
    assert.ok(
      apps.compareDocumentPosition(or) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "the or rule is not between the list and the fields"
    )
    assert.ok(
      or.compareDocumentPosition(document.getElementById("url")) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING
    )
  } finally {
    dom.window.close()
  }
})

/*
 * A paragraph under every field is how the last pass answered "what goes here",
 * and two of the three said what the label and the placeholder already said.
 * What survives is the single fact neither can carry: how macOS is made to give
 * up an absolute path at all.
 */
await check("the fields are labelled and exampled, not annotated", async () => {
  const dom = await coldPage()
  try {
    const document = dom.window.document
    const url = document.getElementById("url")
    assert.equal(url.getAttribute("aria-describedby"), null, "the address field grew help again")
    assert.equal(document.getElementById("url-help"), null)
    // The placeholder is the example the deleted sentence was describing.
    assert.match(url.getAttribute("placeholder"), /^https?:\/\//)
    assert.match(document.getElementById("folder-path").getAttribute("placeholder"), /^[/~]/)
    const help = [...document.querySelectorAll(".fields .note")]
    assert.equal(help.length, 1, `${help.length} help paragraphs under two fields`)
    assert.equal(help[0].id, "folder-help")
    // Both fields still have a visible, associated label — the placeholder is
    // an example and vanishes on input, so it is never the naming.
    for (const id of ["url", "folder-path"]) {
      const label = document.querySelector(`label[for="${id}"]`)
      assert.ok(label && label.textContent.trim() !== "", `no visible label for ${id}`)
    }
  } finally {
    dom.window.close()
  }
})

await check("there is something to press, and pressing it says what is missing", async () => {
  const dom = await coldPage()
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    assert.equal($("submit").disabled, false, "the only action on a cold boot is unreachable")

    $("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The gap gets the focus AND the sentence. An announcement alone still
    // leaves a sighted keyboard user hunting for which of two fields is meant.
    assert.equal(dom.window.document.activeElement, $("url"))
    assert.equal($("url").getAttribute("aria-invalid"), "true")
    assert.equal($("submit-error").hidden, false)
    assert.match($("submit-error").textContent, /address/i)

    // Answer that one, and the press moves to the next unanswered question
    // rather than repeating the one just closed.
    $("url").value = "http://127.0.0.1:3000"
    $("url").dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    $("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(dom.window.document.activeElement, $("folder-path"))
    assert.match($("submit-error").textContent, /folder/i)
    assert.equal($("url").getAttribute("aria-invalid"), null, "the answered field is still flagged")
  } finally {
    dom.window.close()
  }
})

await check("the button keeps one name, whatever the screen is about to do", async () => {
  const dom = await coldPage()
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    const cold = $("submit").textContent
    $("url").value = "http://127.0.0.1:3000"
    $("url").dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // It used to flip between "Start designing" and "Start app & designing" as
    // the user typed — a control that changes identity under the hand reaching
    // for it. Which of the two happens is the hint's job now, and it says so.
    assert.equal($("submit").textContent, cold)
  } finally {
    dom.window.close()
  }
})

await check("every async message has somewhere to be announced from", async () => {
  const dom = await coldPage()
  try {
    const document = dom.window.document
    // Measured at zero before this rework: the scan result, every refusal, the
    // progress and the crash sentence all appeared with no focus move and no
    // announcement of any kind.
    for (const id of ["apps-note", "hint"]) {
      assert.equal(document.getElementById(id).getAttribute("role"), "status", id)
    }
    /*
     * The waiting heading is the exception, and deliberately so.
     *
     * It carried `role="status"` for a while. An explicit role replaces the
     * implicit one, so that made it a live region and left the waiting view
     * with no heading at all — while the comment above it in the document
     * claimed a heading was exactly what it was. It bought nothing either: it
     * sits inside `#waiting`, which is `hidden` until the state arrives, and a
     * live region revealed with its text already in it does not reliably
     * announce.
     *
     * What announces the sentence is `waitForEditor` moving focus to it, which
     * is the same line that rescues the keyboard from being stranded. So the
     * guarantee here is the heading and the focus target, not a role.
     */
    const progress = document.getElementById("progress")
    assert.equal(progress.getAttribute("role"), null, "the waiting heading is not a live region")
    assert.equal(progress.tagName, "H2")
    assert.equal(progress.tabIndex, -1, "nothing can move focus to the waiting view")
    for (const id of ["apps-error", "submit-error", "stopped"]) {
      assert.equal(document.getElementById(id).getAttribute("role"), "alert", id)
    }
    // The field errors take the other route: tied to their field rather than
    // announced loose, which is what `aria-describedby` on the input is for.
    assert.match(
      document.getElementById("folder-path").getAttribute("aria-describedby"),
      /folder-error/
    )
  } finally {
    dom.window.close()
  }
})

await check("the card is navigable by heading, and says which face is up", async () => {
  const dom = await coldPage()
  try {
    const document = dom.window.document
    const headings = [...document.querySelectorAll("h1, h2")].map((node) => node.textContent.trim())
    // One title on screen, and it is the face's question rather than the
    // product's name — the h1 was a `designlayer` wordmark over every face.
    const titles = [...document.querySelectorAll("h1")].filter((node) => !node.closest("[hidden]"))
    assert.deepEqual(
      titles.map((node) => node.textContent.trim()),
      ["Choose an app to edit"]
    )
    // The other face has a title of its own, so a non-visual reader can tell
    // which one is up.
    assert.equal(document.getElementById("current-name").tagName, "H1")
    // The list's own heading, which is also the radiogroup's accessible name.
    // Matched on the word rather than the sentence: it was "Apps running on
    // this machine" and is now two words, and either satisfies the guarantee.
    assert.ok(headings.some((text) => /running/i.test(text)))
  } finally {
    dom.window.close()
  }
})

/*
 * An editor that is already up is one question and its answers. It was a
 * wordmark, a "Now editing" label, the name and "Open the editor" — four slots
 * for one fact, with the product's name above the reader's app.
 */
const SHOP = {
  id: "e1",
  state: "ready",
  name: "shop",
  appUrl: "http://127.0.0.1:3000",
  appPort: 3000,
  projectRoot: "/Users/me/Projects/shop",
  packageName: "shop-web",
  url: "http://localhost:3456/",
}
const statusOf = (editors) => ({
  ready: editors.at(-1)?.state === "ready",
  url: editors.at(-1)?.url ?? null,
  editing: editors.at(-1) ?? null,
  stopped: null,
  editors,
})

await check("an editor that is already up is one question with its answers", async () => {
  const dom = await mountPage([], {}, {}, { "/api/status": () => statusOf([SHOP]) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    assert.equal($("current").hidden, false)
    assert.equal($("editors").querySelector("a.primary").getAttribute("href"), "http://localhost:3456/")
    // Everything the face shows, in order — the chooser's title goes with it.
    // Named by its folder, not its package, and once: the heading says it.
    assert.equal(
      shownWords(dom).join(" "),
      "Continue editing shop? 127.0.0.1:3000 · ~/Projects/shop Continue Stop Open another app"
    )

    $("current-change").click()
    assert.equal($("current").hidden, true)
    assert.equal($("choose-title").hidden, false)
    assert.equal($("form").hidden, false)
  } finally {
    dom.window.close()
  }
})

// A server without the list still reports its one editor in `editing`.
await check("a status with no editor list still offers its one editor", async () => {
  const legacy = { ready: true, url: "http://localhost:3456/", stopped: null, editing: { packageName: "shop-web", appUrl: "http://127.0.0.1:3000" } }
  const dom = await mountPage([], {}, {}, { "/api/status": () => legacy })
  try {
    assert.equal(shownWords(dom).join(" "), "Continue editing shop-web? 127.0.0.1:3000 Continue Open another app")
  } finally {
    dom.window.close()
  }
})

console.log("\nSeveral editors at once")

const DOCS = {
  id: "e2",
  state: "starting",
  name: "docs",
  appUrl: "http://127.0.0.1:4200",
  appPort: 4200,
  projectRoot: "/Users/me/Projects/docs",
  packageName: "docs",
  url: null,
}

await check("every running editor is listed with its own Continue and Stop", async () => {
  const dom = await mountPage([], {}, {}, { "/api/status": () => statusOf([SHOP, DOCS]) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    // No one name fits several, so the heading asks without one.
    assert.equal($("current-name").textContent, "Continue editing?")
    const items = [...$("editors").children]
    assert.equal($("editors").tagName, "UL")
    assert.equal($("editors").getAttribute("aria-labelledby"), "current-name")
    assert.deepEqual(items.map((item) => item.querySelector(".editor-name").textContent), ["shop", "docs"])
    const [shop, docs] = items
    assert.equal(shop.querySelector("a.primary").getAttribute("href"), "http://localhost:3456/")
    // Two Continue links on one screen are told apart by the app they open.
    assert.equal(shop.querySelector("a.primary").getAttribute("aria-label"), "Continue editing shop")
    assert.equal(shop.querySelector("button").getAttribute("aria-label"), "Stop shop")
    // Still starting: no address to go to yet, and it says so.
    assert.equal(docs.querySelector("a"), null)
    assert.equal(docs.querySelector(".editor-starting").textContent, "Starting…")
    assert.equal(docs.querySelector("button").textContent, "Stop")
    assert.equal($("current-change").textContent, "Open another app")
  } finally {
    dom.window.close()
  }
})

await check("a starting editor gains its Continue without a reload", async () => {
  let editors = [SHOP, DOCS]
  const dom = await mountPage([], {}, {}, { "/api/status": () => statusOf(editors) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    editors = [SHOP, { ...DOCS, state: "ready", url: "http://localhost:3458/ds" }]
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const docs = [...$("editors").children][1]
    assert.equal(docs.querySelector("a.primary").getAttribute("href"), "http://localhost:3458/ds")
  } finally {
    dom.window.close()
  }
})

await check("Open another app shows the chooser and stops nothing", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) }, {}, { "/api/status": () => statusOf([SHOP]) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    $("current-change").click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal($("form").hidden, false)
    assert.equal(dom.window.document.activeElement, $("url"))
    assert.deepEqual(dom.requests.filter((request) => request.method === "POST"), [])
  } finally {
    dom.window.close()
  }
})

await check("Stop ends that one editor and the card keeps the rest", async () => {
  let editors = [SHOP, { ...DOCS, state: "ready", url: "http://localhost:3458/" }]
  const rows = [
    { ...ROWS[0], editor: null },
    { port: 4200, url: "http://127.0.0.1:4200", title: "Docs", projectRoot: "/Users/me/Projects/docs", packageName: "docs", editor: { id: "e2", url: "http://localhost:3458/" } },
  ]
  const dom = await mountPage(rows, { [KNOWN]: projectSaid(KNOWN) }, {}, {
    "/api/status": () => statusOf(editors),
    "/api/stop": (url, sent) => {
      editors = editors.filter((editor) => editor.id !== sent.id)
      return { ok: true }
    },
  })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    const stop = [...$("editors").children][1].querySelector("button")
    stop.focus()
    stop.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(dom.requests.find((request) => request.path === "/api/stop").body, { id: "e2" })
    assert.equal($("editors").children.length, 1)
    assert.equal($("current-name").textContent, "Continue editing shop?")
    // The focused Stop went with its entry, so focus lands on the card's heading
    // rather than on <body>.
    assert.equal(dom.window.document.activeElement, $("current-name"))
    // And its row in the list is no longer marked open.
    assert.equal($("apps").querySelector('[data-port="4200"] .app-open'), null)

    // The last Stop leaves nothing to continue, so the chooser comes back.
    $("editors").querySelector("button").click()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal($("current").hidden, true)
    assert.equal($("form").hidden, false)
  } finally {
    dom.window.close()
  }
})

await check("a row whose app is open says so in words, not only in colour", async () => {
  const rows = [{ ...ROWS[0], editor: { id: "e1", url: "http://localhost:3456/" } }, { ...ROWS[1], editor: null }]
  const dom = await mountPage(rows, { [KNOWN]: projectSaid(KNOWN) })
  try {
    const [open, closed] = [...dom.window.document.getElementById("apps").children]
    assert.equal(open.querySelector(".app-open").textContent, "Editing")
    assert.equal(closed.querySelector(".app-open"), null)
  } finally {
    dom.window.close()
  }
})

await check("the pre-pick is the first app with no editor, else the first app", async () => {
  const rows = [
    { ...ROWS[0], editor: { id: "e1", url: "http://localhost:3456/" } },
    { port: 3041, url: "http://127.0.0.1:3041", title: "Pinned", projectRoot: PINNED, packageName: "pinned", editor: null },
  ]
  const dom = await mountPage(rows, { [KNOWN]: projectSaid(KNOWN), [PINNED]: projectSaid(PINNED) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    assert.equal($("apps").querySelector('[aria-checked="true"]').dataset.port, "3041")
    assert.equal($("apps-note").textContent, "Picked pinned app for you.")
  } finally {
    dom.window.close()
  }

  const all = rows.map((row) => ({ ...row, editor: { id: "e" + row.port, url: "http://localhost:3456/" } }))
  const full = await mountPage(all, { [KNOWN]: projectSaid(KNOWN), [PINNED]: projectSaid(PINNED) })
  try {
    assert.equal(full.window.document.getElementById("apps").querySelector('[aria-checked="true"]').dataset.port, "3000")
  } finally {
    full.window.close()
  }
})

await check("Start for an app that is open goes to its editor", async () => {
  const rows = [{ ...ROWS[0], editor: { id: "e1", url: "http://localhost:3456/" } }]
  const dom = await mountPage(rows, { [KNOWN]: projectSaid(KNOWN) }, {}, {
    "/api/start": () => ({ ok: true, id: "e1", existing: true }),
    // Held not-ready so the wait can be read; a real answer is ready at once.
    "/api/status": (url) => (url.searchParams.get("id") ? { ready: false, url: null, editing: null, stopped: null } : statusOf([])),
  })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    $("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal($("progress-text").textContent, "Opening host app…")
    // Nothing compiles for an editor that is already up, so nothing says it will.
    assert.equal($("waiting-note").hidden, true)
    // It may be open in another tab, and opening it is no reason to end it.
    assert.equal($("waiting-stop").hidden, true)
    assert.ok(dom.requests.some((request) => request.path === "/api/status?id=e1"), "the wait did not ask about its own editor")
  } finally {
    dom.window.close()
  }
})

/*
 * Other editors are ready while this one starts, so the global status says
 * ready. Polling it would send the tab to whichever app was chosen last.
 */
await check("the wait follows its own editor, not the latest one", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) }, {}, {
    "/api/start": () => ({ ok: true, id: "e9", existing: false }),
    "/api/status": (url) =>
      url.searchParams.get("id") === "e9"
        ? { ready: false, editing: null, stopped: "The editor for host app stopped with code 1." }
        : statusOf([]),
  })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    const before = dom.requests.length
    $("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal($("form").hidden, false)
    assert.equal($("stopped").textContent, "The editor for host app stopped with code 1.")
    const asked = dom.requests.slice(before).map((request) => request.path)
    assert.ok(asked.includes("/api/status?id=e9"))
    assert.ok(!asked.includes("/api/status"), "the wait read the global status")
  } finally {
    dom.window.close()
  }
})

await check("the wait says what it is doing, and never Switching", async () => {
  const page = startScreenPage()
  assert.doesNotMatch(page, /Switching/)
  assert.doesNotMatch(page, /Switch app/)
  assert.match(page, /"Starting your app…"/)
  assert.match(page, /"Starting the editor…"/)
})

/*
 * Inside the Mac app this page is a Home tab. The vendor's socket takes one
 * client, so a Home tab that loaded an editor another tab shows disconnected
 * that tab and lost its unapplied edits. The desk knows which tab shows what.
 */
const DESK = "http://127.0.0.1:3454"
const deskFrame = (sent, origin = DESK) => (window) => {
  window.name = "designlayer-desk:home-1"
  Object.defineProperty(window.location, "ancestorOrigins", { value: [origin], configurable: true })
  Object.defineProperty(window, "parent", {
    // Cloned, as a real postMessage would, out of the page's realm.
    value: { postMessage: (message, target) => sent.push({ message: structuredClone(message), target }) },
    configurable: true,
  })
}
const pressStart = async (dom, ms = 80) => {
  dom.window.document.getElementById("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, ms))
}
const READY_E9 = { ...DOCS, id: "e9", name: "host app", state: "ready", url: "http://localhost:3458/" }

await check("inside the desk, a ready editor is asked of the desk, not loaded into the Home tab", async () => {
  let started = false
  const routes = {
    "/api/start": () => {
      started = true
      return { ok: true, id: "e9", existing: false }
    },
    "/api/status": (url) =>
      url.searchParams.get("id") ? { ready: true, url: READY_E9.url, stopped: null } : statusOf(started ? [READY_E9] : []),
  }
  const sent = []
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) }, {}, routes, deskFrame(sent))
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    await pressStart(dom)
    assert.deepEqual(sent, [{ message: { type: "designlayer-desk:go", url: READY_E9.url }, target: DESK }])
    assert.deepEqual(dom.navigations, [], "the Home tab loaded the editor itself")
    // In case the desk keeps this tab, it shows the same editor's Continue.
    assert.equal($("current").hidden, false)
    assert.equal(dom.window.document.activeElement, $("current-name"))
  } finally {
    dom.window.close()
  }

  // A browser tab, and a frame of anything that is not a loopback desk, go there.
  for (const before of [() => {}, deskFrame([], "https://example.com")]) {
    started = false
    const tab = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) }, {}, routes, before)
    try {
      await pressStart(tab)
      assert.equal(tab.navigations.length, 1, "the tab did not go to its editor")
    } finally {
      tab.window.close()
    }
  }
})

await check("Continue inside the desk asks the desk; in a browser tab it stays a link", async () => {
  const click = (dom, link, init = {}) =>
    link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }))
  const sent = []
  const dom = await mountPage([], {}, {}, { "/api/status": () => statusOf([SHOP]) }, deskFrame(sent))
  try {
    const link = dom.window.document.querySelector("#editors a.primary")
    assert.equal(link.getAttribute("href"), SHOP.url)
    assert.equal(click(dom, link), false, "the click still navigated this frame")
    assert.deepEqual(sent, [{ message: { type: "designlayer-desk:go", url: SHOP.url }, target: DESK }])
    assert.deepEqual(dom.navigations, [])
    // A modified click is the person asking for the link itself.
    assert.equal(click(dom, link, { metaKey: true }), true)
    assert.equal(sent.length, 1)
  } finally {
    dom.window.close()
  }

  const tab = await mountPage([], {}, {}, { "/api/status": () => statusOf([SHOP]) })
  try {
    assert.equal(click(tab, tab.window.document.querySelector("#editors a.primary")), true)
  } finally {
    tab.window.close()
  }
})

// Started outside this screen, so it has no id here and nothing to wait for.
await check("an editor started elsewhere is opened at once, not waited on", async () => {
  const elsewhere = "http://localhost:3470/"
  const routes = { "/api/start": () => ({ ok: true, id: null, existing: true, url: elsewhere }) }
  const tab = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) }, {}, routes)
  try {
    await pressStart(tab)
    assert.equal(tab.navigations.length, 1)
    assert.ok(!tab.requests.some((request) => request.path.startsWith("/api/status?id")), "the page polled an id it was never given")
  } finally {
    tab.window.close()
  }

  const sent = []
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) }, {}, routes, deskFrame(sent))
  try {
    await pressStart(dom)
    assert.deepEqual(sent, [{ message: { type: "designlayer-desk:go", url: elsewhere }, target: DESK }])
    assert.deepEqual(dom.navigations, [])
  } finally {
    dom.window.close()
  }
})

const pollsOf = (dom, id) => dom.requests.filter((request) => request.path === "/api/status?id=" + id).length

await check("Stop on the wait ends the editor being started and comes back with no error", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) }, {}, {
    "/api/start": () => ({ ok: true, id: "e9", existing: false }),
    "/api/status": (url) => (url.searchParams.get("id") ? { ready: false, url: null, stopped: null } : statusOf([])),
    "/api/stop": () => ({ ok: true }),
  })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    await pressStart(dom)
    assert.equal($("waiting-stop").hidden, false)
    assert.equal($("waiting-stop").textContent, "Stop")
    assert.equal($("waiting-stop").getAttribute("aria-label"), "Stop host app")
    assert.equal($("waiting-back").textContent, "Back")
    $("waiting-stop").click()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(dom.requests.find((request) => request.path === "/api/stop").body, { id: "e9" })
    assert.equal($("waiting").hidden, true)
    assert.equal($("form").hidden, false)
    assert.equal($("stopped").hidden, true, "stopping on purpose is not an error")
    assert.equal(dom.window.document.activeElement, $("url"))
    const polls = pollsOf(dom, "e9")
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(pollsOf(dom, "e9"), polls, "the wait goes on polling an editor that was stopped")
  } finally {
    dom.window.close()
  }
})

await check("Back leaves the editor starting and shows it on the card", async () => {
  let started = false
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) }, {}, {
    "/api/start": () => {
      started = true
      return { ok: true, id: "e9", existing: false }
    },
    "/api/status": (url) =>
      url.searchParams.get("id")
        ? { ready: false, url: null, stopped: null }
        : statusOf(started ? [{ ...READY_E9, state: "starting", url: null }] : []),
  })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    await pressStart(dom)
    $("waiting-back").click()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(!dom.requests.some((request) => request.path === "/api/stop"), "Back stopped the editor")
    assert.equal($("current").hidden, false)
    assert.equal($("editors").querySelector(".editor-starting").textContent, "Starting…")
    assert.equal(dom.window.document.activeElement, $("current-name"))
    assert.equal($("stopped").hidden, true)
    const polls = pollsOf(dom, "e9")
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(pollsOf(dom, "e9"), polls, "the wait still polls, and would move the tab")
  } finally {
    dom.window.close()
  }
})

// ── The list of running apps ────────────────────────────────────────────────

console.log("\nThe list of running apps")

await check("the list is one choice, not a row of independent switches", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    assert.equal($("apps").getAttribute("role"), "radiogroup")
    assert.equal($("apps").getAttribute("aria-labelledby"), "apps-label")
    const rows = [...$("apps").children]
    for (const row of rows) {
      assert.equal(row.getAttribute("role"), "radio")
      // `aria-pressed` announced "toggle button, pressed" — a promise of
      // independent on/off per row, where picking one un-picks every other.
      assert.equal(row.getAttribute("aria-pressed"), null)
    }
    assert.deepEqual(rows.map((row) => row.getAttribute("aria-checked")), ["true", "false"])
    // One tab stop for the whole group, on the row the eye is already on —
    // not one stop per detected app.
    assert.deepEqual(rows.map((row) => row.tabIndex), [0, -1])
  } finally {
    dom.window.close()
  }
})

await check("arrowing the list moves the choice, not just the cursor", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    const rows = [...$("apps").children]
    rows[0].focus()
    rows[0].dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    // In a radiogroup the arrows carry the selection with the focus, so
    // arrowing down the list is the same gesture as clicking down it.
    assert.equal(dom.window.document.activeElement, rows[1])
    assert.equal(rows[1].getAttribute("aria-checked"), "true")
    assert.equal($("url").value, "http://127.0.0.1:3001")
  } finally {
    dom.window.close()
  }
})

await check("a choice made for you is said out loud, not only tinted", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    // The tint that used to be the only signal measured 1.44:1 against an
    // unchosen row, and its border resolved to the same value as its fill.
    assert.match($("apps-note").textContent, /picked/i)
    // Named by its folder, as the row is.
    assert.match($("apps-note").textContent, /host app/)
    // The non-color half, which is the one that survives forced-colors.
    const chosen = $("apps").querySelector('[aria-checked="true"]')
    assert.ok(chosen.querySelector(".app-check"), "nothing marks the chosen row but its fill")
  } finally {
    dom.window.close()
  }
})

await check("an untitled server is named, not made to stutter its own address", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    const row = [...$("apps").children][1]
    // `scanLocalApps` labels a titleless server with its own address, and the
    // row then appends the port: "127.0.0.1:3001:3001".
    assert.equal(row.querySelector(".app-name").textContent, "Untitled app")
    assert.equal(row.querySelector(".app-port").textContent, ":3001")
    /*
     * The SENTENCE names the same thing the row does, plus the one fact that
     * tells two untitled servers apart.
     *
     * This asserted the bare address for a while, which was the other half of
     * the same bug rather than a fix: the prose then said "127.0.0.1:3001"
     * while the row it pointed at said "Untitled app", so the one name on
     * screen and the one name in the sentence were different strings. Two
     * untitled servers is the case that shows it, which is why the fixture has
     * two.
     */
    row.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const said = $("folder-error").textContent
    assert.match(said, /untitled app/i, "the sentence does not say what the row says")
    assert.match(said, /3001/, "the sentence cannot be tied to one of two untitled rows")
  } finally {
    dom.window.close()
  }
})

// ── Being told why, rather than being stopped ───────────────────────────────

console.log("\nBeing told why")

/** A folder the editor cannot do anything with, described honestly. */
const brokenProject = (dir, over) => ({ ...projectSaid(dir), ...over })

await check("a folder with no package.json is told so, not told about its scripts", async () => {
  const dir = "/Users/someone/Projects"
  const dom = await mountPage([], {
    [dir]: brokenProject(dir, { hasPackageJson: false, devScripts: [], hasReact: false }),
  })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    $("url").value = "http://127.0.0.1:3000"
    $("url").dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    $("folder-path").value = dir
    $("folder-path").dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    /*
     * It used to say "That folder has no dev script in its package.json." for
     * this, which is a dead end AND untrue in the commonest case: pointing at a
     * parent folder reported a missing script in a file that does not exist.
     */
    assert.match($("hint").textContent, /no package\.json/i)
    assert.match($("hint").textContent, /node_modules/, "the sentence names nothing to look for")
  } finally {
    dom.window.close()
  }
})

await check("a project the editor cannot edit says so before the press, not after", async () => {
  const dir = "/Users/someone/Projects/svelte-thing"
  const dom = await mountPage([], {
    [dir]: brokenProject(dir, { hasReact: false, framework: "vite" }),
  })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    $("url").value = "http://127.0.0.1:3000"
    $("url").dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    $("folder-path").value = dir
    $("folder-path").dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    // Both facts arrive with the folder, a full round-trip before the press
    // that used to be the first place either of them was mentioned.
    assert.match($("hint").textContent, /does not use React or Angular/i)
  } finally {
    dom.window.close()
  }
})

await check("a ready screen says what pressing the button will actually do", async () => {
  const dom = await mountPage([], { [KNOWN]: projectSaid(KNOWN) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    $("url").value = "http://127.0.0.1:3000"
    $("url").dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    $("folder-path").value = KNOWN
    $("folder-path").dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.match($("hint").textContent, /npm run dev/)
    assert.match($("hint").textContent, /opens the editor/i)
    // The home directory never reaches the browser, so the tilde is the page's.
    assert.doesNotMatch($("hint").textContent, /\/Users\/someone/)
  } finally {
    dom.window.close()
  }
})

/*
 * THE INVERSE, AND IT IS THE HALF THAT KEEPS THE SENTENCE MEANINGFUL.
 *
 * Pressing the button against a server that is already up starts no process, so
 * there is nothing to warn about: the row carries a check, the two boxes carry
 * the address and the folder, and the button says Start editing. The sentence
 * that used to sit here — "Opens Host App at http://127.0.0.1:3000, editing
 * ~/Projects/…" — read the screen back to the person reading it.
 *
 * With silence as the default, the one case that does speak says something by
 * speaking: a command is about to run on this machine.
 */
await check("a running app that was picked needs no sentence about being picked", async () => {
  const dom = await mountPage(ROWS, { [KNOWN]: projectSaid(KNOWN) })
  try {
    const $ = (id) => dom.window.document.getElementById(id)
    assert.equal($("url").value, "http://127.0.0.1:3000")
    assert.equal($("folder-path").value, KNOWN)
    assert.equal($("hint").hidden, true, `the hint is narrating again: ${$("hint").textContent}`)
    // The choice itself is still said out loud, once, where the choosing happened.
    assert.match($("apps-note").textContent, /picked/i)
    // And the how-to-get-a-path help goes with the question it answered: the
    // row click already put a path in the box it sits under.
    assert.equal($("folder-help").hidden, true, "help is captioning a solved problem")
  } finally {
    dom.window.close()
  }
})

await check("a scan that could not run never claims nothing is running", async () => {
  const dom = new JSDOM(startScreenPage(), {
    runScripts: "outside-only",
    url: "http://127.0.0.1:3455/",
  })
  try {
    dom.window.fetch = async (target) => {
      const url = new URL(target, "http://127.0.0.1:3455")
      if (url.pathname === "/api/status") {
        return { ok: true, status: 200, json: async () => ({ ready: false, editing: null, stopped: null }) }
      }
      // The scan itself is what fails here.
      if (url.pathname === "/api/apps") throw new TypeError("Failed to fetch")
      return { ok: false, status: 404, json: async () => null }
    }
    dom.window.eval(CLIENT)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const $ = (id) => dom.window.document.getElementById(id)
    /*
     * "I found nothing" and "I could not look" are different sentences, and the
     * page used to say the first whenever the second was true — sending the
     * user to start an app that may already be up, on a port already taken.
     */
    assert.doesNotMatch($("apps-note").textContent, /no dev server is running/i)
    assert.match($("apps-note").textContent, /could not check/i)
    // And the failure itself names a recovery rather than a browser's phrasing.
    assert.equal($("apps-error").hidden, false)
    assert.match($("apps-error").textContent, /reload this page/i)
    assert.doesNotMatch($("apps-error").textContent, /Failed to fetch/)
  } finally {
    dom.window.close()
  }
})

/*
 * The screen's own type scale, which is deliberately not the chrome's.
 *
 * The card is a full window and the editor is a 240px docked panel, so this
 * surface runs a rung larger on purpose — `--size-body` at 13 against the
 * token's 12, a 15px lede, a 16px address field. That decision is recorded in
 * `start-screen-style.mjs` and these cases exist to hold it to its own terms
 * rather than to undo it: a scale that is deliberately different still has to
 * be internally consistent, and the three failures below were all cases of it
 * not being.
 */
await check("the h1 is not out-sized by the h2 beneath it", async () => {
  const css = startScreenStyle()
  const page = startScreenPage()
  // The markup this is about: `h1.title` for each face, and `h2`s at `.label`
  // and `.progress`. If the page stops spelling it that way the sizes below are
  // measuring nothing, so the shape is asserted before the sizes are.
  assert.match(page, /<h1 class="title"/)
  assert.match(page, /<h2 class="progress"/)

  const step = (rule, property = "font-size") => {
    const block = new RegExp(`(^|\\n)\\${rule} \\{([\\s\\S]*?)\\n\\}`, "m").exec(css)
    assert.ok(block, `no rule for ${rule}`)
    const found = new RegExp(`${property}: var\\((--size-[a-z]+)\\)`).exec(block[2])
    assert.ok(found, `${rule} sets no ${property} from the scale`)
    const declared = new RegExp(`${found[1]}: (?:\\$\\{[^}]+\\}|(\\d+)px)`).exec(css)
    assert.ok(declared, `${found[1]} is not declared in :root`)
    // `--size-label` is interpolated from the token rather than written out, and
    // the token is the chrome's body rung.
    return declared[1] ? Number(declared[1]) : 12
  }

  const title = step(".title")
  const progress = step(".progress")
  assert.ok(
    title >= progress,
    `the h1 title is ${title}px under a ${progress}px h2 — a child heading outsizing its parent`
  )
  // And the label h2s stay clearly subordinate to both, which is the half of the
  // hierarchy that was already right.
  assert.ok(step(".label") < title, "the section labels are not a step below the title")
})

await check("the screen renders text the way the editor it launches does", async () => {
  const css = startScreenStyle()
  /*
   * Smoothing is a PAIR. Only the `-webkit-` half was here, which is the half
   * Chromium and WebKit read — so macOS Firefox kept subpixel antialiasing and
   * drew this card a notch heavier than the editor it starts, in the one
   * situation where a user has both open and can compare them.
   */
  assert.match(css, /-webkit-font-smoothing: antialiased/)
  assert.match(css, /-moz-osx-font-smoothing: grayscale/)
  /*
   * Tabular figures for the port column. Three dev servers up is three
   * `:3000`-shaped numbers in a flex list, and proportional digits gave each
   * row its own width — a column that does not line up.
   */
  assert.match(css, /font-variant-numeric: tabular-nums/)
  // And the controls, which reset `font-variant` via the UA's `font` shorthand
  // and so do not inherit the line above.
  assert.match(css, /:where\(input, textarea, select, button\) \{ font-variant-numeric: inherit; \}/)
})

await check("the screen's leading comes from the same scale as the chrome's", async () => {
  const css = startScreenStyle()
  /*
   * It used to be one literal — a `/1.5` inside `body`'s `font` shorthand — and
   * every other line of text on the screen was leaded by inheriting from it,
   * which meant nothing here could be changed without guessing what depended
   * on it. The roles come from `tokens.type` now, so the two surfaces cannot
   * drift apart on what "body leading" means.
   */
  // The kit's reading leading (body 16/26) and caption leading (12/16), read
  // from the token bundle rather than restated, so a retune moves both.
  assert.match(css, new RegExp(`--leading-body: ${tokens.type.leadingBody};`))
  assert.match(css, new RegExp(`--leading-row: ${tokens.type.leadingRow};`))
  assert.match(css, /font: var\(--weight-body\) var\(--size-body\)\/var\(--leading-body\)/)
  // No bare numeric leading left anywhere: a literal here is the start of the
  // scale coming apart again.
  const literal = css.match(/line-height:\s*[\d.]+/g)
  assert.deepEqual(literal, null, `leading written as a number rather than a role: ${literal}`)
})

await check("the sentences on the screen are punctuated, not typed", async () => {
  const page = startScreenPage()
  /*
   * The screen already curled its quotation marks — `“Copy as Pathname”` in the
   * folder hint — and left every apostrophe straight, so one voice was
   * punctuating two ways in the same paragraph. Possessives are the only
   * apostrophes this page has.
   *
   * Scoped to the rendered markup, not the client script's source, because a
   * straight quote is how JavaScript is written and this is about what a reader
   * sees. The strings the script SHOWS are covered by the same sweep over the
   * template the script is embedded in.
   */
  const rendered = page
    .replace(/<script type="module">[\s\S]*?<\/script>/, "")
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
  const straight = rendered.match(/[A-Za-z]'[A-Za-z]/g)
  assert.deepEqual(straight, null, `straight apostrophes in rendered prose: ${straight}`)
  // The quotation marks are curled too. This asserted a possessive apostrophe
  // in a field label for a while; the labels are two words each now and carry
  // none, so the check moved to the one quoted string left on the screen.
  assert.match(rendered, /“Copy as Pathname”/)
  assert.doesNotMatch(rendered, /"Copy as Pathname"/)
  // The ellipsis is the single character, not three periods — already true, and
  // pinned so the two conventions stay one convention.
  assert.doesNotMatch(rendered, /\w\.\.\./)
})

/*
 * WORST-CASE CONTENT, which is where this card was last found to break.
 *
 * These came out of a stress run that rendered the real document against
 * content nobody had tried: twenty dev servers, a 200-character title, a
 * 60-character word with no spaces, a path deep enough to escape the window.
 * Four of the seven breaks it found were content overflow, and none of them was
 * visible in any state the rest of this suite drives.
 *
 * Asserted against the STYLESHEET rather than by measuring a rendered box,
 * because jsdom has no layout — so what these pin is that the defences are
 * declared, and the rendered proof lives in `.demos/break/`.
 */
console.log("\nWorst-case content")

await check("a sentence holding a path cannot push the card off the screen", () => {
  // `#hint` prints `~/Projects/…` and `#folder-help` names package.json. At
  // 320px a deep path escaped the card AND the window, and the page grew a
  // horizontal scrollbar — the one thing a 320px layout may never do.
  const rule = /\.note,\s*\.error\s*\{([^}]*)\}/s.exec(startScreenStyle())
  assert.ok(rule, "the note and error rules are no longer declared together")
  assert.match(rule[1], /overflow-wrap: break-word/)
})

await check("a list of twenty dev servers does not bury the fields below it", () => {
  // Rendered against twenty, the card came out 1,327px with no scroll region,
  // so the two fields and the button — the whole task — were pushed off the
  // bottom by a list that is only a shortcut to filling them in.
  const rule = /\.apps\s*\{([^}]*)\}/s.exec(startScreenStyle())
  assert.ok(rule, ".apps is missing from the stylesheet")
  assert.match(rule[1], /max-height:/)
  assert.match(rule[1], /overflow-y: auto/)
  // And a wheel that reaches the end of it must not scroll the card away.
  assert.match(rule[1], /overscroll-behavior: contain/)
})

await check("losing contact stops the screen promising progress", async () => {
  const dom = new JSDOM(startScreenPage(), {
    runScripts: "outside-only",
    url: "http://127.0.0.1:3455/",
  })
  try {
    let asked = 0
    dom.window.fetch = async (target) => {
      const url = new URL(target, "http://127.0.0.1:3455")
      if (url.pathname === "/api/apps") return { ok: true, status: 200, json: async () => ({ apps: [] }) }
      if (url.pathname === "/api/project") {
        return { ok: true, status: 200, json: async () => ({ project: projectSaid(KNOWN) }) }
      }
      if (url.pathname === "/api/start") return { ok: true, status: 200, json: async () => ({ ok: true }) }
      // The editor never answers again once the start has been accepted.
      asked += 1
      if (asked > 1) throw new TypeError("Failed to fetch")
      return { ok: true, status: 200, json: async () => ({ ready: false, editing: null, stopped: null }) }
    }
    dom.window.eval(CLIENT)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const $ = (id) => dom.window.document.getElementById(id)
    $("url").value = "http://127.0.0.1:3000"
    $("url").dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    $("folder-path").value = KNOWN
    $("folder-path").dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    $("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))
    // Three misses at 500ms apart is when the screen gives up on the wait.
    await new Promise((resolve) => setTimeout(resolve, 2200))

    /*
     * The failure used to be a muted note UNDER a heading still reading
     * "Starting your app…", with the dot still pulsing — the two halves of the
     * screen telling the reader opposite things, and the confident one louder.
     */
    assert.doesNotMatch($("progress-text").textContent, /Starting|Switching/i)
    assert.match($("progress-text").textContent, /lost contact/i)
    assert.ok(
      $("progress").classList.contains("progress--stalled"),
      "the dot goes on promising progress after the screen has given up"
    )
    // And the sentence is where this screen says failures, not in a footnote.
    assert.equal($("stopped").hidden, false)
    assert.equal($("stopped").getAttribute("role"), "alert")
  } finally {
    dom.window.close()
  }
})

await check("the tab shows DesignLayer's icon, inline like the style", async () => {
  // The page fetches nothing but its own JSON routes, so the icon rides in the head.
  const link = /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)">/.exec(startScreenPage())
  assert.ok(link, "no inline SVG icon in the head")
  const favicon = fs.readFileSync(new URL("../runtime/favicon.svg", import.meta.url), "utf8")
  assert.equal(Buffer.from(link[1], "base64").toString("utf8"), favicon)
})

app.close()
for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
