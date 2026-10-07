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

  console.log("6 passed, 0 failed")
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
