/**
 * The one-command flow: start the app, then attach to it.
 *
 * What is worth pinning here is not that `npm run dev` boots Next — that is the
 * host's business — but the three decisions this package makes around it:
 *
 *  - a server it did NOT start is not one it may stop. `started: false` is the
 *    whole guard, and a `stop` that killed an attached process would take down
 *    a terminal the user is still using;
 *  - a dev script that dies has to be reported as a dev script that died,
 *    rather than as the port timeout it would otherwise look like 60s later;
 *  - `--dev-script` implies `--dev`, and the CLI still refuses every flag it
 *    does not declare — the vendor's commander aborts on anything that leaks
 *    through, so an accepted-but-ignored flag is a broken launch;
 *  - an app that answers 500 is an app that is running. The vendor's health
 *    check disagrees, so these run the vendor's own `healthCheck` against real
 *    listeners to pin both halves: a broken app is attachable, a dead port is
 *    still dead.
 *
 * Usage: node designlayer/test/dev-flow-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { healthCheck } from "react-rewrite-cli/dist/detect.js"

import { parseArgs } from "../cli.mjs"
import { DEFAULT_CONFIG } from "../config.mjs"
import { ensureAppRunning, probePort } from "../runtime/dev-server.mjs"
import { acceptErroringDevServer } from "../runtime/launcher.mjs"

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

/** A listener standing in for the host's dev server. */
function listen() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end())
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }))
  })
}

/** A listener standing in for an app, answering every request the same way. */
function serve(status, body) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "content-type": "text/html" })
      res.end(body)
    })
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }))
  })
}

/** A port that answered once and does not any more. */
async function deadPort() {
  const { server, port } = await listen()
  await new Promise((resolve) => server.close(resolve))
  return port
}

const quiet = () => {}

console.log("\nFlags")

await check("--dev-script implies --dev", () => {
  assert.deepEqual(parseArgs(["--dev-script", "start"]), {
    open: undefined,
    start: undefined,
    dev: true,
    devScript: "start",
    verify: false,
    printConfig: false,
    verbose: false,
  })
})

await check("--dev alone leaves the script to the config", () => {
  const options = parseArgs(["--dev"])
  assert.equal(options.dev, true)
  assert.equal(options.devScript, undefined)
  assert.equal(DEFAULT_CONFIG.app.devScript, "dev")
})

await check("an undeclared flag is still refused", () => {
  assert.throws(() => parseArgs(["--dev-server"]), /Unknown option: --dev-server/)
})

await check("--dev is documented", () => {
  const usage = fs.readFileSync(new URL("../cli.mjs", import.meta.url), "utf8")
  assert.match(usage, /^ {2}--dev {19}Start the app's dev server/m)
  assert.match(usage, /^ {2}--dev-script <name>/m)
})

// The two flags the supervisor puts on its children's command lines. A child
// cannot read its own working directory when the project is somewhere macOS
// protects, so `--project-root` is the only way it learns which project it is.
await check("the supervisor's flags are taken, and documented like the rest", () => {
  assert.equal(parseArgs(["--project-root", "/tmp/app"]).projectRoot, "/tmp/app")
  assert.equal(parseArgs(["--start-screen-port", "3455"]).startScreenPort, 3455)
  const usage = fs.readFileSync(new URL("../cli.mjs", import.meta.url), "utf8")
  assert.match(usage, /^ {2}--project-root <path> {3}Project the config loads against/m)
  assert.match(usage, /^ {2}--start-screen-port <n> Port for the start screen/m)
})

console.log("\nAttaching")

await check("attaches to a port that already answers, and starts nothing", async () => {
  const { server, port } = await listen()
  try {
    const app = await ensureAppRunning({
      projectRoot: process.cwd(),
      host: "127.0.0.1",
      port,
      // Would fail loudly if it were ever run, which is the point.
      script: "designlayer-should-not-run-this",
      log: quiet,
    })
    assert.equal(app.started, false)
    assert.equal(app.child, null)
    // Calling it is legal and does nothing; the port stays up.
    app.stop()
    assert.equal(await probePort("127.0.0.1", port), true)
  } finally {
    server.close()
  }
})

await check("probePort says no when the port is free", async () => {
  const { server, port } = await listen()
  await new Promise((resolve) => server.close(resolve))
  assert.equal(await probePort("127.0.0.1", port), false)
})

console.log("\nStarting")

await check("a dev script that exits is reported as such, not as a timeout", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-dev-"))
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "fixture", private: true, scripts: { dev: "exit 7" } })
  )
  const { server, port } = await listen()
  await new Promise((resolve) => server.close(resolve))
  try {
    await assert.rejects(
      ensureAppRunning({
        projectRoot: fixture,
        host: "127.0.0.1",
        port,
        script: "dev",
        timeoutMs: 30_000,
        log: quiet,
      }),
      /npm run dev.*before anything answered on port/s
    )
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

// A script with no host flag binds wherever it likes, and `localhost` is often
// `[::1]` alone. Polling only the asked-for host never saw it, and the server
// was killed as hung once it went quiet.
await check("a dev server that comes up on ::1 is found, and reported there", async () => {
  const v6 = await new Promise((resolve) => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.listen(0, "::1", () => probe.close(() => resolve(true)))
  })
  if (!v6) return // No IPv6 loopback on this machine: nothing to pin.
  const { server, port } = await listen()
  await new Promise((resolve) => server.close(resolve))
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-dev-"))
  const serverScript =
    `require("net").createServer((s)=>s.end()).listen(${port},"::1",()=>console.log("up"))`
  fs.writeFileSync(path.join(fixture, "server.js"), serverScript)
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "fixture", private: true, scripts: { dev: "node server.js" } })
  )
  let app = null
  try {
    app = await ensureAppRunning({
      projectRoot: fixture,
      host: "127.0.0.1",
      port,
      script: "dev",
      timeoutMs: 30_000,
      log: quiet,
    })
    assert.equal(app.started, true)
    assert.equal(app.host, "::1")
  } finally {
    app?.stop()
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

console.log("\nAttaching to an app that is throwing")

await check("the vendor alone walks away from a dev server that answers 500", async () => {
  const { server, port } = await serve(500, "<html><body>Turbopack error</body></html>")
  try {
    await assert.rejects(healthCheck(port, "127.0.0.1"), /No dev server found on 127\.0\.0\.1/)
  } finally {
    server.close()
  }
})

await check("with the patch, a 500 is a server that was found", async () => {
  const { server, port } = await serve(500, "<html><body>Turbopack error</body></html>")
  const restore = acceptErroringDevServer("127.0.0.1", port)
  try {
    await healthCheck(port, "127.0.0.1")
  } finally {
    restore()
    server.close()
  }
})

await check("a port with nothing on it is still a port with nothing on it", async () => {
  const port = await deadPort()
  const restore = acceptErroringDevServer("127.0.0.1", port)
  try {
    await assert.rejects(fetch(`http://127.0.0.1:${port}`))
    await assert.rejects(healthCheck(port, "127.0.0.1"), /No dev server found on 127\.0\.0\.1/)
  } finally {
    restore()
  }
})

await check("a listening app is reached without its page being asked for", async () => {
  let requests = 0
  const { server, port } = await serve(200, "<html><body>fine</body></html>")
  server.on("request", () => (requests += 1))
  const restore = acceptErroringDevServer("127.0.0.1", port)
  try {
    // A verdict, not a page: no body and no status are invented, and the dev
    // server is not made to render anything to give it.
    assert.deepEqual(await fetch(`http://127.0.0.1:${port}`), { ok: true, status: 0 })
    await healthCheck(port, "127.0.0.1")
    assert.equal(requests, 0)
  } finally {
    restore()
    server.close()
  }
})

// The window belongs to one origin root. Another app's 500, and this app's own
// 500 on any other path, are somebody else's business.
await check("nothing else fetched during the window is touched", async () => {
  const root = await serve(500, "<html><body>Turbopack error</body></html>")
  const other = await serve(500, "<html><body>someone else</body></html>")
  const restore = acceptErroringDevServer("127.0.0.1", root.port)
  try {
    for (const url of [
      `http://127.0.0.1:${other.port}`,
      `http://127.0.0.1:${root.port}/api/things`,
    ]) {
      const response = await fetch(url)
      assert.ok(response instanceof Response, url)
      assert.equal(response.ok, false, url)
      assert.equal(response.status, 500, url)
    }
  } finally {
    restore()
    root.server.close()
    other.server.close()
  }
})

/** A listener that accepts and then says nothing: a dev server compiling its first page. */
function compiling() {
  return new Promise((resolve) => {
    const sockets = new Set()
    const server = http.createServer(() => {})
    server.on("connection", (socket) => sockets.add(socket))
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close: () => {
          for (const socket of sockets) socket.destroy()
          server.close()
        },
      })
    )
  })
}

await check("a root that would time out while the port accepts is reached, with no status", async () => {
  const app = await compiling()
  const restore = acceptErroringDevServer("127.0.0.1", app.port)
  try {
    const reached = await fetch(`http://127.0.0.1:${app.port}`, { signal: AbortSignal.timeout(100) })
    assert.deepEqual(reached, { ok: true, status: 0 })
    // Only the root: any other path that times out still times out.
    await assert.rejects(
      fetch(`http://127.0.0.1:${app.port}/slow`, { signal: AbortSignal.timeout(100) }),
      (error) => error.name === "TimeoutError"
    )
  } finally {
    restore()
    app.close()
  }
})

await check("the vendor's health check attaches to a cold dev server on its first try", async () => {
  const app = await compiling()
  const restore = acceptErroringDevServer("127.0.0.1", app.port)
  try {
    const startedAt = Date.now()
    await healthCheck(app.port, "127.0.0.1")
    // At once — not one 2s attempt, and not three and a "No dev server found".
    assert.ok(Date.now() - startedAt < 500, `took ${Date.now() - startedAt}ms`)
  } finally {
    restore()
    app.close()
  }
})

await check("the window closes and leaves the original fetch behind", async () => {
  const original = globalThis.fetch
  const restore = acceptErroringDevServer("127.0.0.1", 4321)
  assert.notEqual(globalThis.fetch, original)
  restore()
  assert.equal(globalThis.fetch, original)
  // Undoing twice is what happens when a launch binds more than one port.
  restore()
  assert.equal(globalThis.fetch, original)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
