/** Packed-package smoke test against config-free App and Pages Router hosts. */

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { WebSocket } from "ws"

import { PACKAGE_DIR, requireHostConfig } from "./host.mjs"

const { root: HOST_ROOT } = requireHostConfig("standalone-next-cases")
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-next-")))
const processes = new Set()

function write(relativePath, contents) {
  const target = path.join(fixture, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

function packageVersion(name) {
  return JSON.parse(fs.readFileSync(path.join(HOST_ROOT, "node_modules", name, "package.json"))).version
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  })
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const port = address.port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function start(command, args) {
  const child = spawn(command, args, {
    cwd: fixture,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.output = ""
  child.stdout.on("data", (chunk) => child.output += String(chunk))
  child.stderr.on("data", (chunk) => child.output += String(chunk))
  processes.add(child)
  child.once("exit", () => processes.delete(child))
  return child
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGINT")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
}

async function waitFor(url, timeoutMs = 30_000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = new Error(`${response.status} ${url}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`)
}

async function commitClass(wsPort, file, source) {
  const lines = source.split("\n")
  const index = lines.findIndex((line) => line.includes("<section"))
  assert.notEqual(index, -1)
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`)
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Source write timed out")), 5_000)
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "commitBatch",
        operations: [{
          op: "updateClass",
          file,
          line: index + 1,
          col: lines[index].indexOf("<section") + 1,
          tagName: "section",
          className: "mx-auto max-w-xl rounded-2xl bg-slate-900 p-4",
          updates: [{ tailwindPrefix: "p", tailwindToken: "6", value: "24px" }],
        }],
      }))
    })
    socket.on("message", (data) => {
      const next = JSON.parse(String(data))
      if (next.type !== "commitBatchComplete") return
      clearTimeout(timer)
      resolve(next)
    })
    socket.on("error", reject)
  })
  socket.close()
  assert.equal(message.success, true, JSON.stringify(message))
  assert.match(fs.readFileSync(file, "utf8"), /bg-slate-900 p-6/)
}

async function verifyRouter(name, sourceFile) {
  const appPort = await freePort()
  const proxyPort = await freePort()
  const wsPort = await freePort()
  const next = start(path.join(fixture, "node_modules", ".bin", "next"), [
    "dev", "--hostname", "127.0.0.1", "--port", String(appPort),
  ])
  let editor
  try {
    await waitFor(`http://127.0.0.1:${appPort}`)
    editor = start(path.join(fixture, "node_modules", ".bin", "designlayer"), [
      String(appPort), "--host", "127.0.0.1", "--proxy-port", String(proxyPort),
      "--ws-port", String(wsPort), "--no-open",
    ])
    const proxy = await waitFor(`http://127.0.0.1:${proxyPort}`)
    const hostHtml = await (await fetch(`http://127.0.0.1:${appPort}`)).text()
    const proxyHtml = await proxy.text()
    assert.doesNotMatch(hostHtml, /__react-rewrite\/overlay\.js/)
    assert.match(proxyHtml, /__react-rewrite\/overlay\.js/)
    assert.equal((await fetch(`http://127.0.0.1:${appPort}/__designlayer/options`)).status, 404)
    assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/__designlayer/options`)).status, 200)

    const file = path.join(fixture, sourceFile)
    const original = fs.readFileSync(file, "utf8")
    try {
      await commitClass(wsPort, file, original)
    } finally {
      fs.writeFileSync(file, original)
    }
    console.log(`ok   ${name}: isolated proxy and source write`)
  } catch (error) {
    const output = [next.output, editor?.output].filter(Boolean).join("\n")
    throw new Error(`${error instanceof Error ? error.message : error}\n${output}`)
  } finally {
    if (editor) await stop(editor)
    await stop(next)
  }
}

try {
  const packed = JSON.parse(run("npm", [
    "pack", PACKAGE_DIR, "--ignore-scripts", "--json", "--pack-destination", fixture,
  ]))
  const tarball = path.join(fixture, packed[0].filename)
  write("package.json", JSON.stringify({
    name: "standalone-next-designlayer-fixture",
    private: true,
    dependencies: {
      "designlayer": `file:${tarball}`,
      "@tailwindcss/postcss": packageVersion("@tailwindcss/postcss"),
      "@types/node": packageVersion("@types/node"),
      "@types/react": packageVersion("@types/react"),
      "@types/react-dom": packageVersion("@types/react-dom"),
      next: packageVersion("next"),
      react: packageVersion("react"),
      "react-dom": packageVersion("react-dom"),
      tailwindcss: packageVersion("tailwindcss"),
      typescript: packageVersion("typescript"),
    },
  }, null, 2))
  write("postcss.config.mjs", `export default { plugins: { "@tailwindcss/postcss": {} } }\n`)
  write("styles/globals.css", `@import "tailwindcss";\n`)
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"])
  assert.equal(fs.existsSync(path.join(fixture, "next.config.js")), false)
  assert.equal(fs.existsSync(path.join(fixture, "next.config.mjs")), false)
  assert.equal(fs.existsSync(path.join(fixture, "next.config.ts")), false)

  write("app/layout.tsx", `import "../styles/globals.css"\nexport default function Layout({ children }) { return <html lang="en"><body>{children}</body></html> }\n`)
  write("app/page.tsx", `export default function Page() {\n  return <main>\n    <section className="mx-auto max-w-xl rounded-2xl bg-slate-900 p-4">App Router fixture</section>\n  </main>\n}\n`)
  await verifyRouter("App Router without next.config", "app/page.tsx")

  fs.rmSync(path.join(fixture, "app"), { recursive: true, force: true })
  fs.rmSync(path.join(fixture, ".next"), { recursive: true, force: true })
  write("pages/_app.tsx", `import "../styles/globals.css"\nexport default function App({ Component, pageProps }) { return <Component {...pageProps} /> }\n`)
  write("pages/index.tsx", `export default function Page() {\n  return <main>\n    <section className="mx-auto max-w-xl rounded-2xl bg-slate-900 p-4">Pages Router fixture</section>\n  </main>\n}\n`)
  await verifyRouter("Pages Router without next.config", "pages/index.tsx")
  console.log("2 passed, 0 failed")
} finally {
  await Promise.all([...processes].map(stop))
  fs.rmSync(fixture, { recursive: true, force: true })
}
