/** Package-entry regression cases. */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { spawn, spawnSync } from "node:child_process"

import { PACKAGE_DIR } from "./host.mjs"
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-cli-"))
const installedBin = path.join(fixture, "designlayer")

try {
  fs.symlinkSync(path.join(PACKAGE_DIR, "cli.mjs"), installedBin)

  const help = spawnSync(installedBin, ["--help"], {
    cwd: fixture,
    encoding: "utf8",
  })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /^Usage: designlayer/m)

  const printed = spawnSync(installedBin, ["--print-config"], {
    cwd: fixture,
    encoding: "utf8",
  })
  assert.equal(printed.status, 0, printed.stderr)
  const config = JSON.parse(printed.stdout)
  assert.equal(fs.realpathSync(config.projectRoot), fs.realpathSync(fixture))
  assert.equal(config.controls.leva, null)
  assert.deepEqual(config.chrome.trustedSelectors, [])

  /*
   * A bare `designlayer` with no config anywhere above it serves the chooser
   * without loading one, and one with a config still reads it first: a config
   * that names the app's port skips the chooser, and one that is broken stops
   * the command, exactly as before the start screen stopped loading defaults.
   */
  const freePort = () =>
    new Promise((resolve) => {
      const server = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = server.address()
        server.close(() => resolve(port))
      })
    })
  const screenPort = await freePort()
  const screen = spawn(process.execPath, [path.join(PACKAGE_DIR, "cli.mjs"), "--no-open", "--start-screen-port", String(screenPort)], {
    cwd: fixture,
    stdio: ["ignore", "pipe", "pipe"],
  })
  try {
    let page = null
    for (let attempt = 0; attempt < 500 && page === null; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${screenPort}/`)
        if (response.ok) page = await response.text()
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    assert.match(page ?? "", /<title>Open an app · designlayer<\/title>/)
  } finally {
    screen.kill()
  }

  const configured = path.join(fixture, "configured")
  fs.mkdirSync(configured)
  const appPort = await freePort()
  fs.writeFileSync(path.join(configured, "designlayer.config.mjs"), `export default { app: { port: ${appPort} } }\n`)
  const skipped = spawnSync(process.execPath, [path.join(PACKAGE_DIR, "cli.mjs"), "--no-open"], {
    cwd: configured,
    encoding: "utf8",
    timeout: 20000,
  })
  assert.equal(skipped.status, 1)
  assert.match(skipped.stderr, new RegExp(`Nothing is listening on http://127\\.0\\.0\\.1:${appPort}`))

  const broken = path.join(fixture, "broken")
  fs.mkdirSync(broken)
  fs.writeFileSync(path.join(broken, "designlayer.config.mjs"), "export default { designSystem: 1 }\n")
  const refused = spawnSync(process.execPath, [path.join(PACKAGE_DIR, "cli.mjs"), "--no-open"], {
    cwd: broken,
    encoding: "utf8",
    timeout: 20000,
  })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /designSystem must be an object/)

  /*
   * An editor says where it is in two places — the endpoint file in the
   * project and the machine's editor registry — and takes both back when it
   * is stopped, so no tool reading either is sent to a port nothing serves.
   * Stopped by SIGTERM, it exits 143, which the supervisor reads as "stopped".
   */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-cli-home-"))
  const project = path.join(fixture, "editor")
  fs.mkdirSync(project)
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "editor-fixture", private: true, dependencies: { react: "19.0.0" } }))
  fs.writeFileSync(path.join(project, "vite.config.js"), "export default {}\n")
  // No MCP endpoint: its default port belongs to the person running the suite.
  fs.writeFileSync(path.join(project, "designlayer.config.mjs"), "export default { ports: { mcp: null } }\n")
  // Probes connect and hang up at once, so a reset is routine here.
  const app = net.createServer((socket) => {
    socket.on("error", () => {})
    socket.end("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n")
  })
  const appPortForEditor = await new Promise((resolve) => app.listen(0, "127.0.0.1", () => resolve(app.address().port)))
  let proxyPort
  for (;;) {
    proxyPort = await freePort()
    const second = await new Promise((resolve) => {
      const probe = net.createServer().once("error", () => resolve(false)).listen(proxyPort + 1, "127.0.0.1", () => probe.close(() => resolve(true)))
    })
    if (second) break
  }
  const endpointFile = path.join(project, ".local", "designlayer", "endpoint.json")
  const registryEntry = path.join(home, ".local", "state", "designlayer", "editors", `${proxyPort}.json`)
  const editor = spawn(
    process.execPath,
    [path.join(PACKAGE_DIR, "cli.mjs"), String(appPortForEditor), "--no-open", "--proxy-port", String(proxyPort), "--ws-port", String(proxyPort + 1)],
    { cwd: project, env: { ...process.env, HOME: home, DESIGNLAYER_NO_UPDATE_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] }
  )
  let output = ""
  editor.stdout.on("data", (chunk) => (output += chunk))
  editor.stderr.on("data", (chunk) => (output += chunk))
  const exited = new Promise((resolve) => editor.once("exit", (code, signal) => resolve({ code, signal })))
  try {
    let published = null
    for (let attempt = 0; attempt < 600 && published === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      try {
        published = JSON.parse(fs.readFileSync(endpointFile, "utf8"))
      } catch {
        // Not written yet.
      }
    }
    assert.ok(published, `the editor never wrote its endpoint file:\n${output}`)
    assert.equal(published.proxyPort, proxyPort)
    assert.equal(published.pid, editor.pid)
    assert.ok(fs.existsSync(registryEntry), "the editor is not on the registry")
    editor.kill("SIGTERM")
    const { code } = await exited
    assert.equal(code, 143, `the editor exited ${code}:\n${output}`)
    assert.equal(fs.existsSync(endpointFile), false, "endpoint.json outlived the editor")
    assert.equal(fs.existsSync(registryEntry), false, "the registry entry outlived the editor")
  } finally {
    editor.kill("SIGKILL")
    app.close()
    fs.rmSync(home, { recursive: true, force: true })
  }

  /*
   * Stopped by its supervisor, a real editor closes its MCP endpoint before it
   * exits: the supervisor asks over IPC, and an agent parked in
   * `wait_for_change` is answered "endpoint_closing" instead of having its
   * socket cut. SIGTERM could not do this (the vendor's handler exits
   * synchronously), so the editor that leaves on the ask gets no signal.
   */
  const stopHome = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-cli-stop-home-"))
  // The supervisor's screen and its child read state under HOME; never the real one.
  process.env.HOME = stopHome
  process.env.DESIGNLAYER_NO_UPDATE_CHECK = "1"
  const { runEditors } = await import(new URL("../cli.mjs", import.meta.url).href)
  const { createStartScreen } = await import(new URL("../runtime/start-screen.mjs", import.meta.url).href)
  const stopProject = path.join(fixture, "stopped")
  fs.mkdirSync(stopProject)
  fs.writeFileSync(path.join(stopProject, "package.json"), JSON.stringify({ name: "stop-fixture", private: true, dependencies: { react: "19.0.0" } }))
  fs.writeFileSync(path.join(stopProject, "vite.config.js"), "export default {}\n")
  // Bound before the ports below are chosen, so it cannot take one of them.
  const stopScreen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const mcpPort = await freePort()
  fs.writeFileSync(path.join(stopProject, "designlayer.config.mjs"), `export default { ports: { mcp: ${mcpPort} } }\n`)
  const stopApp = net.createServer((socket) => {
    socket.on("error", () => {})
    socket.end("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n")
  })
  const stopAppPort = await new Promise((resolve) => stopApp.listen(0, "127.0.0.1", () => resolve(stopApp.address().port)))
  let stopProxy
  for (;;) {
    stopProxy = await freePort()
    // A port freed and asked for again can come back: never the MCP port.
    if (stopProxy === mcpPort || stopProxy + 1 === mcpPort) continue
    const second = await new Promise((resolve) => {
      const probe = net.createServer().once("error", () => resolve(false)).listen(stopProxy + 1, "127.0.0.1", () => probe.close(() => resolve(true)))
    })
    if (second) break
  }
  const spawned = []
  let stopOutput = ""
  const supervisor = runEditors(stopScreen, {
    log: () => {},
    allocatePorts: async () => ({ proxyPort: stopProxy, wsPort: stopProxy + 1 }),
    // The production spawn, with the output kept for a failure message.
    spawnEditor: (argv, env) => {
      const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe", "ipc"] })
      child.stdout.on("data", (chunk) => (stopOutput += chunk))
      child.stderr.on("data", (chunk) => (stopOutput += chunk))
      child.signals = []
      const kill = child.kill.bind(child)
      child.kill = (signal) => {
        child.signals.push(signal)
        return kill(signal)
      }
      child.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
      spawned.push(child)
      return child
    },
  })
  const mcp = async (body) => {
    const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    })
    return response.json()
  }
  try {
    const started = await (
      await fetch(`${stopScreen.url}/api/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${stopAppPort}`, projectRoot: stopProject, devScript: null }),
      })
    ).json()
    assert.ok(started.id, `the start screen refused the choice: ${JSON.stringify(started)}`)
    let listening = false
    for (let attempt = 0; attempt < 600 && !listening; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      listening = await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }).then(() => true, () => false)
    }
    assert.ok(listening, `the editor never served MCP on ${mcpPort}:\n${stopOutput}`)
    const editorFile = path.join(stopProject, ".local", "designlayer", "endpoint.json")
    const editorEntry = path.join(stopHome, ".local", "state", "designlayer", "editors", `${stopProxy}.json`)
    assert.ok(fs.existsSync(editorEntry), "the editor is not on the registry")

    const parked = mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "wait_for_change", arguments: { timeoutSeconds: 30 } },
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const stopAt = Date.now()
    await fetch(`${stopScreen.url}/api/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: started.id }),
    })
    const answer = JSON.parse((await parked).result.content[0].text)
    assert.equal(answer.reason, "endpoint_closing", `the parked wait was answered ${JSON.stringify(answer)}`)
    const { code, signal } = await spawned[0].exited
    const tookMs = Date.now() - stopAt
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, `the editor did not leave on the ask:\n${stopOutput}`)
    assert.deepEqual(spawned[0].signals, [], "an editor that left on the ask was signalled")
    assert.ok(tookMs < 2500, `the stop took ${tookMs} ms, past the ask's bound`)
    assert.equal(fs.existsSync(editorFile), false, "endpoint.json outlived the editor")
    assert.equal(fs.existsSync(editorEntry), false, "the registry entry outlived the editor")
  } finally {
    supervisor.killAll()
    stopScreen.close()
    await supervisor.done
    for (const child of spawned) child.kill("SIGKILL")
    stopApp.close()
    fs.rmSync(stopHome, { recursive: true, force: true })
  }

  console.log("8 passed, 0 failed")
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
