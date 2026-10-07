/**
 * Cases for the promise that a designer configures nothing.
 *
 * Every value here used to be a constant that happened to be right for one
 * framework: the dev script was `dev`, the port was 3000, the port travelled as
 * `PORT`, the app was assumed to be on `127.0.0.1`, and the folder column of
 * the start screen was macOS-only. Each of those is correct for Next and wrong
 * for something else, and the workaround in every case was a flag the designer
 * had to know to pass.
 *
 * So these are the questions the tool must answer for itself, asked once per
 * host kind against a real project on disk:
 *
 *   which framework  -> which resolver and which write lane
 *   which script     -> `npm run` what
 *   which port       -> where to wait
 *   how to say it    -> `PORT`, or `--port` on the command line
 *   which address    -> 127.0.0.1 or ::1, because the app picks, not us
 *
 * The port and host tables are measured behaviour, not documentation:
 * `PORT=3999 vite` binds 5173, and `npm start` in a stock Angular project
 * answers on `[::1]` and refuses `127.0.0.1`. A case that pins `--port` and
 * `--host` is pinning those measurements.
 *
 * Usage: node designlayer/test/zero-config-cases.mjs
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { detectDevServer, resolveConfig, resolveDevPort, resolveDevScript } from "../config.mjs"
import { createLibraryStore } from "../server/libraries.mjs"
import { describeProject, projectRootForPort, scanLocalApps } from "../runtime/local-apps.mjs"
import { ensureAppRunning, loopbackHostFor, urlHost } from "../runtime/dev-server.mjs"

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

async function checkAsync(name, fn) {
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
function project(files) {
  // `realpath`, because `os.tmpdir()` on macOS is itself a symlink
  // (`/var` -> `/private/var`). The library store resolves both ends of its
  // containment check, so a fixture spelled the unresolved way makes every file
  // in it read as outside the project it was just written into.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "de-zero-")))
  temporary.push(root)
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, typeof contents === "string" ? contents : JSON.stringify(contents))
  }
  return root
}

const manifest = (extra) => ({ name: "host", private: true, ...extra })

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

const serveOn = (host) =>
  new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<title>Hand started</title>")
    })
    server.once("error", reject)
    server.listen(0, host, () => resolve({ server, port: server.address().port }))
  })

/* ---------------------------------------------------------------------- */
console.log("\nWhat kind of host is this")

{
  const cases = [
    [
      "a stock Angular app",
      project({ "package.json": manifest({ dependencies: { "@angular/core": "^22.0.0" } }) }),
      { devServer: "angular", framework: "angular", port: 4200, portFlag: "--port", hostFlag: "--host" },
    ],
    [
      "a Next app with no next.config",
      project({ "package.json": manifest({ dependencies: { next: "^15.0.0", react: "^19.0.0" } }) }),
      { devServer: "next", framework: "react", port: 3000, portFlag: "--port", hostFlag: "--hostname" },
    ],
    [
      "a Next app known only by its config file",
      project({ "package.json": manifest({}), "next.config.mjs": "export default {}" }),
      { devServer: "next", framework: "react", port: 3000, portFlag: "--port", hostFlag: "--hostname" },
    ],
    [
      "a Vite + React app",
      project({
        "package.json": manifest({
          dependencies: { react: "^19.0.0" },
          devDependencies: { vite: "^7.0.0" },
        }),
      }),
      { devServer: "vite", framework: "react", port: 5173, portFlag: "--port", hostFlag: "--host" },
    ],
    [
      "a Create React App",
      project({ "package.json": manifest({ dependencies: { "react-scripts": "^5.0.0" } }) }),
      { devServer: "cra", framework: "react", port: 3000, portFlag: null, hostFlag: null },
    ],
    [
      "something this tool has never seen",
      project({ "package.json": manifest({ dependencies: { svelte: "^5.0.0" } }) }),
      { devServer: "unknown", framework: "react", port: 3000, portFlag: null, hostFlag: null },
    ],
  ]

  for (const [label, root, want] of cases) {
    check(label, () => {
      assert.equal(detectDevServer(root), want.devServer, "devServer")
      const config = resolveConfig({}, { cwd: root })
      assert.equal(config.host.framework, want.framework, "framework")
      assert.equal(config.app.devPort, want.port, "devPort")
      assert.equal(config.app.devPortFlag, want.portFlag, "devPortFlag")
      assert.equal(config.app.devHostFlag, want.hostFlag, "devHostFlag")
    })
  }

  check("Angular wins over a vite.config it happens to ship", () => {
    const root = project({
      "package.json": manifest({
        dependencies: { "@angular/core": "^22.0.0" },
        devDependencies: { vite: "^7.0.0" },
      }),
      "vite.config.ts": "export default {}",
    })
    assert.equal(detectDevServer(root), "angular")
  })

  check("Next wins over a Vite it depends on for tests", () => {
    const root = project({
      "package.json": manifest({
        dependencies: { next: "^15.0.0", react: "^19.0.0" },
        devDependencies: { vite: "^7.0.0" },
      }),
    })
    assert.equal(detectDevServer(root), "next")
  })

  check("a project with no package.json at all is still startable", () => {
    const root = project({ "index.html": "<html></html>" })
    const config = resolveConfig({}, { cwd: root })
    assert.equal(config.host.framework, "react")
    assert.equal(config.app.devPort, 3000)
  })
}

/* ---------------------------------------------------------------------- */
console.log("\nWhich script to run")

{
  check("`dev` is used when the host has one", () => {
    const root = project({
      "package.json": manifest({ scripts: { dev: "next dev", start: "next start" } }),
    })
    assert.equal(resolveConfig({}, { cwd: root }).app.devScript, "dev")
  })

  check("an Angular host's `start` is found without being asked for", () => {
    // `ng new` writes `start` and no `dev`, which is the whole reason this
    // resolution exists: the old default named a script that does not exist and
    // the run died on `Missing script: dev`.
    const root = project({
      "package.json": manifest({
        dependencies: { "@angular/core": "^22.0.0" },
        scripts: { ng: "ng", start: "ng serve", build: "ng build" },
      }),
    })
    assert.equal(resolveConfig({}, { cwd: root }).app.devScript, "start")
  })

  check("the preference order holds when several are present", () => {
    const root = project({
      "package.json": manifest({ scripts: { serve: "x", start: "y", develop: "z" } }),
    })
    assert.equal(resolveDevScript(root, "dev", false), "develop")
  })

  check("`build` is not mistaken for a dev script", () => {
    const root = project({ "package.json": manifest({ scripts: { build: "ng build" } }) })
    assert.equal(resolveDevScript(root, "dev", false), "dev")
  })

  check("an explicit devScript wins, even one the host does not have", () => {
    const root = project({
      "package.json": manifest({
        dependencies: { "@angular/core": "^22.0.0" },
        scripts: { start: "ng serve" },
      }),
    })
    // npm should be the one to say there is no such script — silently running
    // something else would be the tool overruling a stated choice.
    const config = resolveConfig({ app: { devScript: "dev" } }, { cwd: root })
    assert.equal(config.app.devScript, "dev")
  })
}

/* ---------------------------------------------------------------------- */
console.log("\nWhich port to wait on")

{
  check("an Angular project that moved its port is believed over the default", () => {
    const root = project({
      "package.json": manifest({ dependencies: { "@angular/core": "^22.0.0" } }),
      "angular.json": {
        projects: { app: { architect: { serve: { options: { port: 4400 } } } } },
      },
    })
    assert.equal(resolveConfig({}, { cwd: root }).app.devPort, 4400)
  })

  check("the newer `targets` spelling is read too", () => {
    const root = project({
      "package.json": manifest({ dependencies: { "@angular/core": "^22.0.0" } }),
      "angular.json": { projects: { app: { targets: { serve: { options: { port: 4500 } } } } } },
    })
    assert.equal(resolveDevPort(root, "angular"), 4500)
  })

  check("a malformed angular.json falls back rather than throwing", () => {
    const root = project({
      "package.json": manifest({ dependencies: { "@angular/core": "^22.0.0" } }),
      "angular.json": "{ not json",
    })
    assert.equal(resolveDevPort(root, "angular"), 4200)
  })
}

/* ---------------------------------------------------------------------- */
console.log("\nHow the port is handed over")

{
  // A stand-in dev server that binds whichever port it was TOLD about, by
  // whichever route. The assertion is then about what reached the script rather
  // than about what this package believes it sent.
  //
  // A file rather than `node -e`, because `node -e "..." --port 3000` makes
  // node parse `--port` as its own option and exit 9 — the script has to be a
  // script for npm's `--` forwarding to mean anything.
  const SERVER = [
    "const args = process.argv.slice(2)",
    "const at = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] }",
    "const port = at('--port') ?? process.env.PORT",
    "const host = at('--host') ?? process.env.HOST",
    "if (!port) { console.error('told no port'); process.exit(2) }",
    "if (!host) { console.error('told no host'); process.exit(3) }",
    "require('http')",
    "  .createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>up</title>') })",
    "  .listen(Number(port), host)",
  ].join("\n")
  const script = "node server.cjs"

  await checkAsync("a flagged host is told on the command line, and lands there", async () => {
    const port = await freePort()
    const root = project({
      "package.json": manifest({ scripts: { dev: script } }),
      "server.cjs": SERVER,
    })
    const app = await ensureAppRunning({
      projectRoot: root,
      host: "127.0.0.1",
      port,
      script: "dev",
      portFlag: "--port",
      hostFlag: "--host",
      timeoutMs: 20_000,
      log: () => {},
    })
    assert.equal(app.started, true)
    app.stop()
  })

  await checkAsync("an unflagged host is told through PORT, and lands there", async () => {
    const port = await freePort()
    const root = project({
      "package.json": manifest({ scripts: { dev: script } }),
      "server.cjs": SERVER,
    })
    const app = await ensureAppRunning({
      projectRoot: root,
      host: "127.0.0.1",
      port,
      script: "dev",
      portFlag: null,
      hostFlag: null,
      timeoutMs: 20_000,
      log: () => {},
    })
    assert.equal(app.started, true)
    app.stop()
  })

  await checkAsync("the interface is named too, not just the port", async () => {
    // The silent half of the same bug: `vite` and `ng serve` default to
    // `localhost`, which on an IPv6-first machine is `[::1]` alone. The app
    // comes up and the launcher, probing 127.0.0.1, never sees it. This server
    // exits rather than guessing, so a missing host fails the case.
    const port = await freePort()
    const root = project({
      "package.json": manifest({ scripts: { dev: script } }),
      "server.cjs": SERVER,
    })
    const app = await ensureAppRunning({
      projectRoot: root,
      host: "127.0.0.1",
      port,
      script: "dev",
      portFlag: "--port",
      hostFlag: "--host",
      timeoutMs: 20_000,
      log: () => {},
    })
    assert.equal(app.started, true)
    // Reachable on the interface the editor's proxy will actually target.
    const response = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(response.status, 200)
    app.stop()
  })

  await checkAsync("a server someone else already started is left alone", async () => {
    const port = await freePort()
    const server = http.createServer((_req, res) => res.end("hi"))
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve))
    const root = project({ "package.json": manifest({ scripts: { dev: "exit 1" } }) })
    const app = await ensureAppRunning({
      projectRoot: root,
      host: "127.0.0.1",
      port,
      script: "dev",
      portFlag: "--port",
      log: () => {},
    })
    assert.equal(app.started, false, "it started a second server over a live one")
    await new Promise((resolve) => server.close(resolve))
  })

  await checkAsync("a build that is still talking is not killed for being slow", async () => {
    const port = await freePort()
    // Prints for a while, then binds — the shape of a big first compile. With a
    // fixed deadline shorter than the build, this is the case that got a
    // working dev server killed and blamed for not answering.
    const root = project({
      "package.json": manifest({ scripts: { dev: "node slow.cjs" } }),
      "slow.cjs": [
        "const args = process.argv.slice(2)",
        "const port = args[args.indexOf('--port') + 1]",
        "let n = 0",
        "const tick = setInterval(() => { console.log('building chunk ' + ++n) }, 100)",
        "setTimeout(() => {",
        "  clearInterval(tick)",
        "  require('http').createServer((_q, s) => { s.writeHead(200, {'content-type':'text/html'}); s.end('<title>up</title>') }).listen(Number(port), '127.0.0.1')",
        "}, 1200)",
      ].join("\n"),
    })
    const app = await ensureAppRunning({
      projectRoot: root,
      host: "127.0.0.1",
      port,
      script: "dev",
      portFlag: "--port",
      // Shorter than the build it is waiting on. It survives because the child
      // keeps printing, which is the whole point of the quiet-timeout model.
      timeoutMs: 500,
      log: () => {},
    })
    assert.equal(app.started, true)
    app.stop()
  })

  await checkAsync("a script that goes silent without binding is given up on", async () => {
    const port = await freePort()
    const root = project({
      "package.json": manifest({ scripts: { dev: "node hang.cjs" } }),
      "hang.cjs": "console.log('starting'); setTimeout(() => {}, 60000)",
    })
    await assert.rejects(
      ensureAppRunning({
        projectRoot: root,
        host: "127.0.0.1",
        port,
        script: "dev",
        portFlag: null,
        timeoutMs: 1_500,
        log: () => {},
      }),
      /has said nothing for \d+s/
    )
  })

  await checkAsync("the failure names the command it actually ran", async () => {
    const port = await freePort()
    const root = project({
      "package.json": manifest({ scripts: { dev: "node fail.cjs" } }),
      "fail.cjs": "process.exit(3)",
    })
    await assert.rejects(
      ensureAppRunning({
        projectRoot: root,
        host: "127.0.0.1",
        port,
        script: "dev",
        portFlag: "--port",
        hostFlag: "--host",
        timeoutMs: 5_000,
        log: () => {},
      }),
      /npm run dev -- --host 127\.0\.0\.1 --port \d+/
    )
  })
}

/* ---------------------------------------------------------------------- */
console.log("\nLoopback has two addresses and the app may be on either")

{
  check("a URL host brackets an IPv6 literal and leaves v4 alone", () => {
    // `http://::1:4200` is not a URL. The socket form is not the URL form, and
    // conflating them takes the launch down inside `new URL()`.
    assert.equal(urlHost("::1"), "[::1]")
    assert.equal(urlHost("127.0.0.1"), "127.0.0.1")
  })

  await checkAsync("an app on ::1 alone is still found", async () => {
    // What `npm start` in a stock Angular project actually produces on an
    // IPv6-first machine: `ng serve` binds the NAME localhost, which resolves
    // to [::1] and leaves 127.0.0.1 refusing connections.
    let listener
    try {
      listener = await serveOn("::1")
    } catch {
      return // No IPv6 stack on this machine; nothing to prove.
    }
    try {
      assert.equal(await loopbackHostFor(listener.port), "::1")
      const apps = await scanLocalApps({ ports: [listener.port], timeoutMs: 2000 })
      assert.equal(apps.length, 1, "the start screen could not see an IPv6-only app")
      assert.equal(apps[0].url, `http://[::1]:${listener.port}`)
      assert.equal(apps[0].title, "Hand started")
    } finally {
      await new Promise((resolve) => listener.server.close(resolve))
    }
  })

  await checkAsync("an app on 127.0.0.1 keeps the address it always had", async () => {
    const listener = await serveOn("127.0.0.1")
    try {
      assert.equal(await loopbackHostFor(listener.port), "127.0.0.1")
      const apps = await scanLocalApps({ ports: [listener.port], timeoutMs: 2000 })
      assert.equal(apps[0].url, `http://127.0.0.1:${listener.port}`)
    } finally {
      await new Promise((resolve) => listener.server.close(resolve))
    }
  })

  await checkAsync("a port with nothing on it resolves to no address", async () => {
    assert.equal(await loopbackHostFor(await freePort()), null)
  })

  await checkAsync("--dev attaches to an IPv6 app rather than starting a rival", async () => {
    // A designer with `npm start` already running has their app on whichever
    // address their own script chose. Probing v4 only concluded nothing was
    // there and spawned a SECOND dev server on the same port and a different
    // address — both alive, and the editor proxying the wrong one.
    let listener
    try {
      listener = await serveOn("::1")
    } catch {
      return // No IPv6 stack here.
    }
    try {
      const app = await ensureAppRunning({
        projectRoot: project({ "package.json": manifest({ scripts: { dev: "exit 1" } }) }),
        host: "127.0.0.1",
        port: listener.port,
        script: "dev",
        portFlag: "--port",
        hostFlag: "--host",
        log: () => {},
      })
      assert.equal(app.started, false, "it started a rival server beside a live one")
      assert.equal(app.host, "::1", "it attached without saying where")
    } finally {
      await new Promise((resolve) => listener.server.close(resolve))
    }
  })
}

/* ---------------------------------------------------------------------- */
console.log("\nThe start screen opens both frameworks")

{
  const { createStartScreen } = await import("../runtime/start-screen.mjs")

  /** Presses Start the way the page does, and returns what the server said. */
  async function pressStart(screen, body) {
    const response = await fetch(new URL("/api/start", screen.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  const angular = project({
    "package.json": manifest({
      name: "ng-app",
      dependencies: { "@angular/core": "^22.0.0" },
      scripts: { start: "ng serve" },
    }),
  })
  const react = project({
    "package.json": manifest({
      name: "rx-app",
      dependencies: { react: "^19.0.0" },
      scripts: { dev: "vite" },
    }),
  })
  const neither = project({
    "package.json": manifest({ name: "svelte-app", dependencies: { svelte: "^5.0.0" } }),
  })

  /*
   * One screen per case. The first accepted Start latches the supervisor —
   * "the editor is already starting" — which is right for the product and
   * would otherwise make every case after the first pass for the wrong reason.
   */
  async function onFreshScreen(fn) {
    const screen = await createStartScreen({ port: 0, log: () => {} })
    try {
      return await fn(screen)
    } finally {
      screen.close()
    }
  }

  await checkAsync("an Angular project is accepted", () =>
    onFreshScreen(async (screen) => {
      // The gate here read `dependencies.react` and nothing else, so the screen
      // refused BY NAME the projects the editor had just learned to edit — and
      // this is the entry point a designer actually uses.
      const answer = await pressStart(screen, {
        url: "http://127.0.0.1:4200/",
        projectRoot: angular,
        devScript: "start",
      })
      assert.notEqual(answer.status, 400, `refused: ${answer.body?.error}`)
    })
  )

  await checkAsync("a React project is still accepted", () =>
    onFreshScreen(async (screen) => {
      const answer = await pressStart(screen, {
        url: "http://127.0.0.1:3000/",
        projectRoot: react,
        devScript: "dev",
      })
      assert.notEqual(answer.status, 400, `refused: ${answer.body?.error}`)
    })
  )

  await checkAsync("a project of neither kind is refused, and says so", () =>
    onFreshScreen(async (screen) => {
      const answer = await pressStart(screen, {
        url: "http://127.0.0.1:3000/",
        projectRoot: neither,
        devScript: null,
      })
      assert.equal(answer.status, 400)
      assert.match(answer.body.error, /does not use React or Angular/)
    })
  )
}

/* ---------------------------------------------------------------------- */
console.log("\nThe start screen fills the folder in")

{
  check("an Angular project is named as Angular, not as unrecognised", () => {
    const root = project({
      "package.json": manifest({
        dependencies: { "@angular/core": "^22.0.0" },
        scripts: { start: "ng serve" },
      }),
    })
    const described = describeProject(root)
    assert.equal(described.framework, "angular")
    assert.deepEqual(described.devScripts, ["start"])
  })

  check("a Vite React project still reports vite", () => {
    const root = project({
      "package.json": manifest({ dependencies: { react: "^19.0.0" }, scripts: { dev: "vite" } }),
      "vite.config.ts": "export default {}",
    })
    const described = describeProject(root)
    assert.equal(described.framework, "vite")
    assert.equal(described.hasReact, true)
  })

  await checkAsync("a running app's folder is discovered without asking the user", async () => {
    if (process.platform === "win32") {
      // No supported way to ask; the screen falls back to the folder picker.
      return
    }
    const root = project({
      "package.json": manifest({ name: "found-me", scripts: { dev: "x" } }),
    })
    // A server whose working directory IS the project, which is what a dev
    // server started by `npm run dev` looks like to the machine.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<title>Discovered</title>")
    })
    const port = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port))
    })
    const previous = process.cwd()
    process.chdir(root)
    try {
      // `projectRootForPort` asks the OS for the LISTENER's cwd. This process is
      // the listener, so chdir makes it answerable — and it is answerable only
      // because the lookup works off /proc on Linux as well as lsof on macOS.
      const found = await projectRootForPort(port)
      assert.equal(found && fs.realpathSync(found), fs.realpathSync(root))

      const apps = await scanLocalApps({ ports: [port], timeoutMs: 2000 })
      assert.equal(apps.length, 1)
      assert.equal(apps[0].title, "Discovered")
      assert.equal(apps[0].packageName, "found-me")
      assert.ok(apps[0].projectRoot, "the row arrived with no folder")
    } finally {
      process.chdir(previous)
      await new Promise((resolve) => server.close(resolve))
    }
  })

  await checkAsync("several untitled apps each get their own folder from one lookup", async () => {
    if (process.platform === "win32") return
    // Three listeners in two processes. The folders are asked for together, so
    // each row must still get its OWN process's folder, and a process with two
    // ports must answer for both of them.
    const names = ["first-app", "second-app"]
    const roots = names.map((name) => project({ "package.json": manifest({ name, scripts: { dev: "x" } }) }))
    const script =
      'const http = require("node:http");' +
      'const up = () => new Promise((r) => { const s = http.createServer((q, a) => { a.writeHead(200, { "content-type": "text/html" }); a.end("<p>untitled</p>") }); s.listen(0, "127.0.0.1", () => r(s.address().port)) });' +
      "(async () => { const ports = []; for (let i = 0; i < Number(process.argv[1]); i++) ports.push(await up()); console.log(JSON.stringify(ports)) })()"
    const children = roots.map((cwd, index) =>
      spawn(process.execPath, ["-e", script, String(index + 1)], { cwd, stdio: ["ignore", "pipe", "ignore"] })
    )
    try {
      const ports = await Promise.all(
        children.map((child) => new Promise((resolve) => child.stdout.once("data", (data) => resolve(JSON.parse(data)))))
      )
      const expected = ports
        .flatMap((list, index) => list.map((port) => ({ port, root: roots[index], name: names[index] })))
        .sort((a, b) => a.port - b.port)
      const apps = await scanLocalApps({ ports: expected.map(({ port }) => port), timeoutMs: 2000 })
      assert.deepEqual(
        apps.map(({ port, projectRoot, packageName }) => ({ port, root: projectRoot && fs.realpathSync(projectRoot), name: packageName })),
        expected
      )
    } finally {
      for (const child of children) child.kill()
    }
  })
}

/* ---------------------------------------------------------------------- */
/*
 * The design system the prototype already has.
 *
 * The same promise as everything above it, applied to the one question the tool
 * exists to answer. A designer opening somebody else's prototype has no
 * `designlayer.config.mjs` and is not going to write one, so "declare where your
 * tokens are" is not a workaround — it is the Design tab having no token pickers
 * at all on a project whose entire palette is sitting in `app/globals.css`.
 *
 * Every fixture below is a real project layout rather than a minimal one that
 * happens to exercise the code: a stock `shadcn init` stylesheet with its
 * `:root`, `.dark` and `@theme inline` blocks, a v3 palette that lives only in
 * `tailwind.config.js`, a Next app with four and a half thousand generated SVGs
 * in front of its stylesheet. Detection that works on a three-line fixture and
 * not on those is detection that does not work.
 *
 * The negative cases are paired with a positive one in the same case body. "A
 * reset is not a design system" passes trivially against a tool that detects
 * nothing at all, so each one also asserts what the SAME shape of project does
 * find — which is what makes the case fail when detection is missing as well as
 * when it is too eager.
 */
console.log("\nThe design system the project already has")

{
  const TOKEN_GROUPS = [
    "colors", "spacing", "radii", "textStyles", "uiTextStyles", "effects", "icons", "motion",
  ]
  const tokenCount = (catalog) =>
    TOKEN_GROUPS.reduce((total, group) => total + catalog[group].length, 0)
  const named = (catalog, group, name) =>
    catalog[group].some((token) => token.name === name || token.cssVar === name)

  // `shadcn init` output, trimmed to the blocks that carry values: the light
  // ramp, the dark overrides, and the `@theme inline` mapping that is the only
  // place a Tailwind v4 project says `bg-primary` means `--primary`.
  const SHADCN_GLOBALS = `@import "tailwindcss";

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --primary: oklch(0.985 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --border: oklch(1 0 0 / 10%);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-muted: var(--muted);
  --radius-lg: var(--radius);
}
`

  // Six one-off properties and a pile of rules: what `worthOffering` already
  // rejects in the Add panel, asserted here because detection adopting one would
  // make it the project's design system everywhere in the editor.
  const RESET = `*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; -webkit-font-smoothing: antialiased; }
img, picture, video { display: block; max-width: 100%; }
:root { --reset-line: 1.5; }
`

  const TOKENS_CSS = `:root {
  --brand-ink: #101828;
  --brand-paper: #ffffff;
  --brand-accent: #3b5bdb;
  --brand-muted: #667085;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --radius-sm: 4px;
  --radius-lg: 12px;
}
`

  const palette = (prefix, count) =>
    `:root {\n${Array.from(
      { length: count },
      (_, index) => `  --${prefix}-${index}: #${(index * 7919).toString(16).padStart(6, "0").slice(-6)};`
    ).join("\n")}\n}\n`

  check("a stock Next + Tailwind v4 + shadcn app arrives with its own tokens", () => {
    const root = project({
      "package.json": manifest({
        dependencies: { next: "^15.0.0", react: "^19.0.0" },
        devDependencies: { tailwindcss: "^4.0.0" },
      }),
      "components.json": { style: "new-york", tailwind: { css: "app/globals.css" } },
      "app/globals.css": SHADCN_GLOBALS,
    })
    const { catalog, detectedFrom } = resolveConfig({}, { cwd: root }).designSystem

    // The measurement this whole section exists for: before detection this was
    // 0 colors, 0 radii and 0 aliases on a file the editor could already read.
    assert.ok(catalog.colors.length >= 10, `only ${catalog.colors.length} colors`)
    assert.ok(catalog.radii.length >= 1, "no radius came out of --radius")
    assert.ok(named(catalog, "colors", "--primary"), "the primary colour is not in the catalog")
    assert.deepEqual(detectedFrom, ["app/globals.css"])

    // `.dark` is read as the same token's other value rather than as a second
    // token, which is what lets one swatch show both themes.
    assert.ok(
      catalog.colors.some((token) => token.values?.dark),
      "no colour carried a dark value, so the .dark block was not read"
    )

    // The v4 alias arm. `aliasesFromCss` has always known how to read `@theme`;
    // it sat behind the empty-catalog short-circuit and was never called.
    assert.ok(
      catalog.aliases.tailwind.length > 0,
      "no Tailwind aliases, so the inspector cannot say an element is bg-primary"
    )
    assert.ok(
      catalog.aliases.tailwind.every((alias) => alias.tokenIds.length > 0),
      "an alias resolved to no token at all"
    )
  })

  check("components.json is believed over the convention list", () => {
    // A project that moved its stylesheet moved this pointer with it, and it is
    // the only signal available here that is a statement rather than a guess.
    const root = project({
      "package.json": manifest({ dependencies: { next: "^15.0.0" } }),
      "components.json": { tailwind: { css: "src/assets/app.css" } },
      "src/assets/app.css": SHADCN_GLOBALS,
    })
    const { catalog, detectedFrom } = resolveConfig({}, { cwd: root }).designSystem
    assert.deepEqual(detectedFrom, ["src/assets/app.css"])
    assert.ok(catalog.colors.length >= 10)
  })

  check("an entry stylesheet that is nothing but imports still resolves", () => {
    // Three `@import`s over a `styles/` folder is a normal shape, and read on
    // its own the entry declares no custom properties at all — so without
    // following one level this file is rejected as carrying no tokens.
    const root = project({
      "package.json": manifest({ dependencies: { next: "^15.0.0" } }),
      "app/globals.css": '@import "tailwindcss";\n@import "./theme.css";\n',
      "app/theme.css": TOKENS_CSS,
    })
    const { catalog, detectedFrom } = resolveConfig({}, { cwd: root }).designSystem
    assert.ok(catalog.colors.length >= 4, `only ${catalog.colors.length} colors`)
    assert.ok(catalog.spacing.length >= 4, `only ${catalog.spacing.length} spacing steps`)
    // Imports first, because that is where the cascade puts them.
    assert.deepEqual(detectedFrom, ["app/theme.css", "app/globals.css"])
  })

  check("a Vite + Tailwind v3 palette that exists only in the config is read", () => {
    // The commonest "prototype with a design system built in" shape before v4:
    // no `:root`, no custom properties, the whole scale in a JavaScript object.
    // The reader for it has been in this package the whole time and only fired
    // when a config file named the file by hand.
    const root = project({
      "package.json": manifest({
        dependencies: { react: "^19.0.0" },
        devDependencies: { tailwindcss: "^3.4.0", vite: "^7.0.0" },
      }),
      "src/index.css": "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
      "tailwind.config.js": [
        "module.exports = {",
        "  content: ['./index.html', './src/**/*.tsx'],",
        "  theme: {",
        "    extend: {",
        "      colors: { brand: { 500: '#3b5bdb', 900: '#1c2f8f' }, ink: '#101828' },",
        "      borderRadius: { pill: '9999px', card: '0.75rem' },",
        "    },",
        "  },",
        "}",
      ].join("\n"),
    })
    const { catalog, detectedFrom } = resolveConfig({}, { cwd: root }).designSystem
    assert.deepEqual(detectedFrom, ["tailwind.config.js"])
    assert.ok(named(catalog, "colors", "brand-500"), "brand-500 is not in the catalog")
    assert.ok(named(catalog, "colors", "ink"), "ink is not in the catalog")
    assert.ok(named(catalog, "radii", "pill"), "pill is not in the catalog")
    // v3 has no custom property behind its scale, so a token that claimed one
    // would send the inspector to write `var(--color-brand-500)` into a page
    // that has never defined it.
    assert.ok(
      catalog.colors.every((token) => !token.cssVar),
      "a v3 theme token claimed a CSS variable"
    )
  })

  check("a Tailwind config this process cannot evaluate does not take startup down", () => {
    const broken = project({
      "package.json": manifest({ devDependencies: { tailwindcss: "^3.4.0" } }),
      "tailwind.config.js": "module.exports = require('./nothing-here')",
    })
    // Declared, this is a mistake the host has to hear about. Detected, it is a
    // guess, and a guess that throws would kill the editor on a project that had
    // merely been looked at too eagerly.
    assert.equal(tokenCount(resolveConfig({}, { cwd: broken }).designSystem.catalog), 0)
    assert.throws(
      () => resolveConfig({ designSystem: { tailwindConfig: "./tailwind.config.js" } }, { cwd: broken }),
      /Could not read Tailwind config/
    )

    // The pair, so "it did not throw" cannot be satisfied by never looking: the
    // same project with a config this process CAN evaluate resolves its scale.
    const sound = project({
      "package.json": manifest({ devDependencies: { tailwindcss: "^3.4.0" } }),
      "tailwind.config.js": "module.exports = { theme: { colors: { ink: '#101828' } } }",
    })
    assert.ok(named(resolveConfig({}, { cwd: sound }).designSystem.catalog, "colors", "ink"))
  })

  check("a design system shipped as a dependency is reached without walking node_modules", () => {
    const root = project({
      "package.json": manifest({ dependencies: { "@acme/tokens": "^1.0.0", react: "^19.0.0" } }),
      "node_modules/@acme/tokens/package.json": { name: "@acme/tokens", style: "tokens.css" },
      "node_modules/@acme/tokens/tokens.css": TOKENS_CSS,
      // A dependency that ships a stylesheet and does not claim to be a design
      // system stays out of it. Without the name filter this project's palette
      // would be Bootstrap's.
      "node_modules/bootstrap/package.json": { name: "bootstrap", style: "dist/bootstrap.css" },
      "node_modules/bootstrap/dist/bootstrap.css": palette("bs", 120),
    })
    const { catalog, detectedFrom } = resolveConfig({}, { cwd: root }).designSystem
    assert.deepEqual(detectedFrom, ["@acme/tokens/tokens.css"])
    assert.ok(named(catalog, "colors", "--brand-accent"), "the package's accent is missing")
    assert.equal(
      catalog.colors.some((token) => String(token.cssVar).startsWith("--bs-")),
      false,
      "a dependency that never claimed to be a design system was adopted as one"
    )
  })

  check("a monorepo sibling package is reached through the workspace symlink", () => {
    const root = project({
      "package.json": { name: "workspace-root", private: true, workspaces: ["apps/*", "packages/*"] },
      "packages/tokens/package.json": { name: "@acme/tokens" },
      "packages/tokens/tokens.css": TOKENS_CSS,
      "apps/web/package.json": manifest({
        dependencies: { next: "^15.0.0", "@acme/tokens": "workspace:*" },
      }),
    })
    const app = path.join(root, "apps/web")
    fs.mkdirSync(path.join(app, "node_modules/@acme"), { recursive: true })
    fs.symlinkSync(
      path.join(root, "packages/tokens"),
      path.join(app, "node_modules/@acme/tokens"),
      "dir"
    )
    // Nothing here knows what a workspace is. The package is reached because the
    // app's own manifest declares it and `realpath` follows the link the package
    // manager already wrote.
    const { catalog, detectedFrom } = resolveConfig({}, { cwd: app }).designSystem
    assert.deepEqual(detectedFrom, ["@acme/tokens/tokens.css"])
    assert.ok(catalog.spacing.length >= 4, "the sibling package's spacing scale is missing")
  })

  check("a project whose only stylesheet is a reset gets nothing, and says nothing", () => {
    const reset = project({
      "package.json": manifest({ dependencies: { next: "^15.0.0" } }),
      "app/globals.css": RESET,
      "src/components/card.css": ".card { --card-pad: 12px; --card-gap: 8px; }",
    })
    const bare = resolveConfig({}, { cwd: reset }).designSystem
    assert.equal(tokenCount(bare.catalog), 0, "a CSS reset was adopted as a design system")
    assert.deepEqual(bare.detectedFrom, [])

    // The pair: the same project, plus a real token file. A detector that finds
    // nothing anywhere would pass the assertion above for the wrong reason.
    const tokens = project({
      "package.json": manifest({ dependencies: { next: "^15.0.0" } }),
      "app/globals.css": RESET,
      "src/components/card.css": ".card { --card-pad: 12px; --card-gap: 8px; }",
      "src/styles/tokens.css": TOKENS_CSS,
    })
    const found = resolveConfig({}, { cwd: tokens }).designSystem
    assert.deepEqual(found.detectedFrom, ["src/styles/tokens.css"])
    assert.ok(tokenCount(found.catalog) >= 10)
  })

  /*
   * A PALETTE AND NOTHING ELSE IS STILL A DESIGN SYSTEM, when it sits at the
   * entry point.
   *
   * Detection reused the Add panel's bar at first, and that bar asks for
   * twenty-four tokens from a stylesheet declaring a single axis — a sensible
   * rule where it belongs, choosing one file out of a whole tree, because a
   * dozen colours there could just as easily be one busy component.
   *
   * At a conventional entry it is the wrong question, and it failed against
   * real projects rather than imagined ones: of four prototypes keeping their
   * tokens in `src/index.css`, two were adopted and two were refused for
   * declaring colours and no second axis — thirteen in one, seven in the other,
   * both inside an explicit theme block. Each showed a completely empty Design
   * tab for a project whose tokens were thirty lines into the stylesheet its
   * own build treats as the entry point.
   *
   * The two counts below are those two projects. Thirteen is under the old
   * single-axis bar and seven is under the breadth bar as well, so this case
   * fails against either half of the strict rule.
   */
  check("an entry stylesheet that declares only colours is still adopted", () => {
    const palette = (count) =>
      `@theme {\n${Array.from(
        { length: count },
        (_, index) => `  --color-token-${index}: #${(index + 16).toString(16).repeat(3)};`
      ).join("\n")}\n}\n`

    for (const count of [13, 7]) {
      const root = project({
        "package.json": manifest({ dependencies: { vite: "^5.0.0" } }),
        "src/index.css": `@import 'tailwindcss';\n${palette(count)}`,
      })
      const { catalog, detectedFrom } = resolveConfig({}, { cwd: root }).designSystem
      assert.deepEqual(
        detectedFrom,
        ["src/index.css"],
        `a ${count}-colour entry stylesheet was not adopted`
      )
      assert.equal(
        catalog.colors.length,
        count,
        `the ${count}-colour palette did not reach the catalog`
      )
    }
  })

  check("a declared design system is never second-guessed", () => {
    const files = {
      "package.json": manifest({ dependencies: { next: "^15.0.0" } }),
      "app/globals.css": SHADCN_GLOBALS,
      "src/brand.css": TOKENS_CSS,
    }
    const declared = resolveConfig(
      { designSystem: { cssSources: ["src/brand.css"] } },
      { cwd: project(files) }
    ).designSystem
    assert.deepEqual(declared.detectedFrom, [], "detection ran beside a declared design system")
    assert.ok(named(declared.catalog, "colors", "--brand-accent"))
    assert.equal(
      named(declared.catalog, "colors", "--primary"),
      false,
      "the detected stylesheet was merged into the one the host declared"
    )

    // And the same project with nothing declared finds the entry stylesheet, so
    // the assertion above is about precedence rather than about a detector that
    // never runs.
    assert.deepEqual(resolveConfig({}, { cwd: project(files) }).designSystem.detectedFrom, [
      "app/globals.css",
    ])
  })
}

/* ---------------------------------------------------------------------- */
console.log("\nDiscovery survives a project of a realistic size and shape")

{
  const TOKENS_CSS = `:root {
  --brand-ink: #101828;
  --brand-paper: #ffffff;
  --brand-accent: #3b5bdb;
  --brand-muted: #667085;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --radius-sm: 4px;
  --radius-lg: 12px;
}
`
  const palette = (prefix, count) =>
    `:root {\n${Array.from(
      { length: count },
      (_, index) => `  --${prefix}-${index}: #${(index * 7919).toString(16).padStart(6, "0").slice(-6)};`
    ).join("\n")}\n}\n`

  await checkAsync("a stylesheet behind four thousand generated assets is still found", async () => {
    const root = project({
      "package.json": manifest({ dependencies: { next: "^15.0.0" } }),
      "src/styles/tokens.css": TOKENS_CSS,
    })
    // Alphabetically ahead of `src/styles`, which is the whole failure: the walk
    // charged its file budget for every SVG it could never parse and gave up
    // before it reached the stylesheet. 4,500 is what a generated icon set or a
    // folder of OG cards actually looks like.
    const generated = path.join(root, "src/assets/generated")
    fs.mkdirSync(generated, { recursive: true })
    for (let index = 0; index < 4500; index += 1) {
      fs.writeFileSync(
        path.join(generated, `icon-${String(index).padStart(5, "0")}.svg`),
        "<svg xmlns='http://www.w3.org/2000/svg'/>"
      )
    }

    const config = resolveConfig({}, { cwd: root })
    const { candidates } = await createLibraryStore(config).discover()
    assert.ok(
      candidates.some((candidate) => candidate.path === "src/styles/tokens.css"),
      `the walk starved before reaching the stylesheet: ${JSON.stringify(candidates)}`
    )
    // And the host catalog resolves it without walking anything at all.
    assert.deepEqual(config.designSystem.detectedFrom, ["src/styles/tokens.css"])
  })

  await checkAsync("the project's own design system outranks the things that look like one", async () => {
    const root = project({
      "package.json": manifest({ dependencies: { next: "^15.0.0" } }),
      // Any JSON with a nested `value` leaf reads as a token file, and `tokens`
      // outranks `css` — so this sat at the TOP of the list describing itself as
      // "no tokens", above the project's real design system.
      "locales/en.json": { greeting: { value: "Hello" }, farewell: { value: "Bye" } },
      "public/vendor/open-props.css": palette("op", 200),
      "test/fixtures/theme.css": palette("fixture", 40),
      "src/styles/tokens.css": TOKENS_CSS,
    })
    const { candidates } = await createLibraryStore(resolveConfig({}, { cwd: root })).discover()
    const paths = candidates.map((candidate) => candidate.path)
    assert.equal(paths[0], "src/styles/tokens.css", `ranked: ${paths.join(", ")}`)
    for (const noise of ["locales/en.json", "public/vendor/open-props.css", "test/fixtures/theme.css"]) {
      assert.equal(paths.includes(noise), false, `${noise} was offered as a design system`)
    }
  })
}

for (const root of temporary) fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
