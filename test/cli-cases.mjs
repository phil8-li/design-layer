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

  console.log("7 passed, 0 failed")
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
