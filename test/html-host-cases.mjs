/**
 * Cases for the plain HTML host lane: a folder of pages, served by a static
 * server, opened in the editor like a React or Angular app.
 *
 * Such a folder usually has no package.json, and its server says nothing about
 * where it is: its working directory can be `/`, it can mount folders under a
 * prefix, and its root can answer with plain text. These pin that the lane is
 * detected, that the start screen accepts and finds the folder, that the scan
 * lists the server, and that a real editor starts against one and serves the
 * page with the editor in it.
 *
 * Servers here are throwaway: in-process, or child processes started in the
 * folder they serve, as `python -m http.server` is. The editor runs with a
 * temporary HOME and no MCP endpoint.
 *
 * Usage: node designlayer/test/html-host-cases.mjs
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { PACKAGE_DIR } from "./host.mjs"
import { resolveConfig } from "../config.mjs"
import { vendorDetectionShims } from "../runtime/launcher.mjs"
import {
  describeProject,
  projectRootForPage,
  projectRootForPort,
  scanLocalApps,
  servesFile,
} from "../runtime/local-apps.mjs"
import { resolveProject } from "../runtime/start-choice.mjs"

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

const temps = []
/** A throwaway folder holding `files` (relative path -> contents). */
function project(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "de-html-")))
  temps.push(root)
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }
  return root
}

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Agent Command Center: three hypotheses</title></head>
<body><main><h1 id="hero-title">Agent Command Center</h1></main></body>
</html>
`
const ABOUT = "<!doctype html><title>About</title><p>About the prototype</p>\n"
const OTHER = "<!doctype html><title>Another site</title><p>Not the same page</p>\n"

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
}
function close(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(() => resolve()))
}
function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * A static server shaped like the one this lane was built for: folders below
 * `root` mounted at `/p/`, plain text at `/`, and a 421 for any Host but its
 * own. `edit(text, file)` changes a page on its way out, for the live-reload
 * and the changed-page cases.
 */
async function mountServer(root, { edit = (text) => text } = {}) {
  let port = 0
  let requests = 0
  const server = http.createServer((req, res) => {
    requests += 1
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      res.writeHead(421, { "content-type": "text/plain" })
      return res.end("Misdirected request")
    }
    const { pathname } = new URL(req.url, "http://localhost")
    if (pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain" })
      return res.end("static: /p/<path>\n")
    }
    let file = path.join(root, ...pathname.split("/").slice(2).map(decodeURIComponent))
    if (!file.startsWith(root + path.sep) || !pathname.startsWith("/p/")) {
      res.writeHead(404, { "content-type": "text/plain" })
      return res.end("Not found")
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html")
    if (!fs.existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" })
      return res.end("Not found")
    }
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "text/css" })
    res.end(edit(fs.readFileSync(file, "utf8"), file))
  })
  port = await listen(server)
  return { port, server, requests: () => requests }
}

/**
 * A free port below the range the OS hands out, as a person picks for a
 * static server (8000, 4099). Port 0 would land in that range.
 */
async function freeChosenPort() {
  for (let port = 20000 + Math.floor(Math.random() * 10000); ; port += 1) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer().once("error", () => resolve(false)).listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
    })
    if (free) return port
  }
}

/**
 * A static server in its own process, started in `cwd` and serving it at `/`,
 * as `python -m http.server` does. `/` is `index.html`, or `body` when given.
 * It listens on `port`, or on one the OS picks.
 */
async function folderServer(cwd, { body = null, port = 0 } = {}) {
  const source = `const fs = require("node:fs"), path = require("node:path")
  const s = require("node:http").createServer((q, r) => {
    const name = q.url === "/" ? "index.html" : decodeURIComponent(q.url.slice(1))
    const file = path.join(process.cwd(), name)
    const text = ${JSON.stringify(body)} ?? (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null)
    if (text === null) { r.writeHead(404); return r.end() }
    r.writeHead(200, { "content-type": "text/html" }); r.end(text)
  }); s.listen(${Number(port)}, "127.0.0.1", () => console.log(s.address().port))`
  const child = spawn(process.execPath, ["-e", source], { cwd, stdio: ["ignore", "pipe", "inherit"] })
  const bound = await new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))))
  return { port: bound, close: () => child.kill() }
}

/* ---------------------------------------------------------------------- */
console.log("\nWhat kind of host is this")

const site = project({ "index.html": PAGE, "about.html": ABOUT, "css/base.css": "main { display: grid; }\n" })
const vanilla = project({
  "package.json": JSON.stringify({ name: "vanilla-site", devDependencies: { vite: "^7.0.0" }, scripts: { dev: "vite" } }),
  "index.html": PAGE,
})
const reactSite = project({
  "package.json": JSON.stringify({ name: "react-site", dependencies: { react: "^19.0.0" }, scripts: { dev: "vite" } }),
  "vite.config.ts": "export default {}\n",
  "index.html": "<div id=root></div>",
})
const empty = project({ "notes.txt": "nothing to serve\n" })
const toolsOnly = project({ "package.json": JSON.stringify({ name: "tools-only", dependencies: { lodash: "^4.0.0" } }) })

await check("a folder of pages with no package.json is a plain HTML host", () => {
  assert.equal(resolveConfig({}, { cwd: site }).host.framework, "html")
})

await check("a package.json without React or Angular, beside a page, is one too", () => {
  assert.equal(resolveConfig({}, { cwd: vanilla }).host.framework, "html")
})

await check("a React project with an index.html stays React", () => {
  assert.equal(resolveConfig({}, { cwd: reactSite }).host.framework, "react")
})

await check("host.framework accepts html, and still refuses what it does not know", () => {
  assert.equal(resolveConfig({ host: { framework: "html" } }, { cwd: reactSite }).host.framework, "html")
  assert.throws(() => resolveConfig({ host: { framework: "svelte" } }, { cwd: site }), /"html"/)
})

await check("a plain HTML host may write pages and stylesheets", () => {
  const { extensions } = resolveConfig({}, { cwd: site }).source
  assert.ok(extensions.includes(".html"), "expected .html in the allowlist")
  assert.ok(extensions.includes(".css"), "expected .css in the allowlist")
})

await check("the vendor's gates are answered for a folder with no package.json at all", () => {
  const shims = vendorDetectionShims(resolveConfig({}, { cwd: site }))
  assert.equal(shims.virtualManifest, true)
  assert.equal(shims.declareReact, true)
  assert.match(shims.virtualConfig, /vite\.config\.ts$/)
  assert.equal(shims.manifestPath, path.join(site, "package.json"))
})

await check("a real package.json is read, and only React is declared on top of it", () => {
  const shims = vendorDetectionShims(resolveConfig({}, { cwd: vanilla }))
  assert.equal(shims.virtualManifest, false)
  assert.equal(shims.declareReact, true)
})

await check("the start screen describes each folder by how the editor would open it", () => {
  const described = describeProject(site)
  assert.equal(described.hostFramework, "html")
  assert.equal(described.framework, "html")
  assert.equal(described.hasPackageJson, false)
  // A Vite project with no React is opened as the pages it serves.
  assert.equal(describeProject(vanilla).hostFramework, "html")
  assert.equal(describeProject(reactSite).hostFramework, "react")
  assert.equal(describeProject(empty).hostFramework, null)
  assert.equal(describeProject(toolsOnly).hostFramework, null)
})

/* ---------------------------------------------------------------------- */
console.log("\nThe start screen accepts a folder of pages")

await check("a folder of pages starts, named after itself", () => {
  const choice = resolveProject(site)
  assert.equal(choice.projectRoot, site)
  assert.deepEqual(choice.manifest, {})
  assert.equal(choice.packageName, path.basename(site))
})

await check("a folder with neither a package.json nor a page says what to look for", () => {
  assert.throws(() => resolveProject(empty), /No package\.json or HTML page in .*\. Pick the folder that holds one\./)
})

await check("a project of no kind the editor opens is refused by name", () => {
  assert.throws(() => resolveProject(toolsOnly), /tools-only is not a React, Angular or plain HTML project/)
})

/* ---------------------------------------------------------------------- */
console.log("\nA page is matched to the file it was served from")

const home = project({
  "Projects/Site One/index.html": PAGE,
  "Projects/Site One/about.html": ABOUT,
  "Projects/Site One/deep/page.html": ABOUT,
  "Projects/Other/index.html": OTHER,
  "Documents/Hidden/index.html": OTHER,
})
const siteOne = path.join(home, "Projects", "Site One")
const mounted = await mountServer(path.join(home, "Projects"))
// The server's working directory says nothing, as for a server started from `/`.
const at = (page, options = {}) => projectRootForPage(mounted.port, page, { cwds: ["/"], home, ...options })

await check("a page under a mount prefix finds its folder", async () => {
  assert.equal(await at("/p/Site%20One/index.html#connect"), siteOne)
})

await check("a folder address and an address without the slash find it too", async () => {
  assert.equal(await at("/p/Site%20One/"), siteOne)
  assert.equal(await at("/p/Site%20One"), siteOne)
})

await check("a page in a subfolder belongs to the folder that holds it", async () => {
  assert.equal(await at("/p/Site%20One/deep/page.html"), path.join(siteOne, "deep"))
})

await check("the project's own marker above a page wins over the page's folder", async () => {
  fs.mkdirSync(path.join(siteOne, ".git"), { recursive: true })
  try {
    assert.equal(await at("/p/Site%20One/deep/page.html"), siteOne)
  } finally {
    fs.rmSync(path.join(siteOne, ".git"), { recursive: true, force: true })
  }
})

await check("a page whose bytes differ from the file at that path finds nothing", async () => {
  const changed = await mountServer(path.join(home, "Projects"), { edit: (text) => text.replace("Agent", "Another") })
  try {
    assert.equal(await projectRootForPage(changed.port, "/p/Site%20One/index.html", { cwds: ["/"], home }), null)
  } finally {
    await close(changed.server)
  }
})

await check("a page with a live-reload script injected still finds its folder", async () => {
  const reloading = await mountServer(path.join(home, "Projects"), {
    edit: (text) => text.replace("</body>", "<!-- Code injected by live-server -->\n<script>new WebSocket('ws://x')</script></body>"),
  })
  try {
    assert.equal(await projectRootForPage(reloading.port, "/p/Site%20One/index.html", { cwds: ["/"], home }), siteOne)
  } finally {
    await close(reloading.server)
  }
})

await check("an address that climbs out of its folder is not looked up", async () => {
  assert.equal(await at("/p/%2e%2e/Other/index.html"), null)
  assert.equal(await at("/p/Site%20One/style.css"), null)
})

await check("a folder macOS guards with a prompt is never looked in", async () => {
  // Documents/Hidden/index.html is there, but asking for it could raise a
  // permission dialog in front of the start screen.
  const hidden = await mountServer(path.join(home, "Documents"))
  try {
    assert.equal(await projectRootForPage(hidden.port, "/p/Hidden/index.html", { cwds: ["/"], home }), null)
  } finally {
    await close(hidden.server)
  }
})

await check("an app route that is no file on disk costs no request", async () => {
  const before = mounted.requests()
  assert.equal(await at("/p/settings/billing"), null)
  assert.equal(mounted.requests(), before, "the page was fetched though no file could match it")
})

await check("a served page and its file are compared without scripts, comments or spacing", () => {
  assert.equal(servesFile(PAGE, PAGE), true)
  assert.equal(servesFile(PAGE.replace("</head>", '<script type="module" src="/@vite/client"></script></head>'), PAGE), true)
  assert.equal(servesFile(OTHER, PAGE), false)
  // A page read only in part is the start of its file, or not it.
  assert.equal(servesFile(PAGE.slice(0, 40), PAGE, { complete: false }), true)
  assert.equal(servesFile(OTHER.slice(0, 40), PAGE, { complete: false }), false)
})

/* ---------------------------------------------------------------------- */
console.log("\nThe scan lists static servers")

await check("an app opened before is listed on a server whose root is plain text", async () => {
  const rows = await scanLocalApps({
    ports: [],
    hosts: ["127.0.0.1"],
    remembered: [{ port: mounted.port, projectRoot: siteOne, page: "/p/Site%20One/index.html#connect" }],
  })
  const row = rows.find((app) => app.port === mounted.port)
  assert.ok(row, "the remembered page was not listed")
  assert.equal(row.projectRoot, siteOne)
  assert.equal(row.title, "Agent Command Center: three hypotheses")
  assert.equal(row.url, `http://127.0.0.1:${mounted.port}`)
})

await check("of two folders remembered on one port, the newest that still answers is listed", async () => {
  const rows = await scanLocalApps({
    ports: [],
    hosts: ["127.0.0.1"],
    remembered: [
      { port: mounted.port, projectRoot: path.join(home, "Projects", "Gone"), page: "/p/Gone/index.html" },
      { port: mounted.port, projectRoot: path.join(home, "Projects", "Other"), page: "/p/Other/index.html" },
      { port: mounted.port, projectRoot: siteOne, page: "/p/Site%20One/" },
    ],
  })
  const listed = rows.filter((app) => app.port === mounted.port)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].projectRoot, path.join(home, "Projects", "Other"))
})

await check("a remembered page that is no longer its folder's file is not listed", async () => {
  const changed = await mountServer(path.join(home, "Projects"), { edit: (text) => text.replace("Agent", "Another") })
  try {
    const rows = await scanLocalApps({
      ports: [],
      hosts: ["127.0.0.1"],
      remembered: [{ port: changed.port, projectRoot: siteOne, page: "/p/Site%20One/index.html" }],
    })
    assert.ok(!rows.some((app) => app.port === changed.port), "a page that changed was listed as the remembered folder")
  } finally {
    await close(changed.server)
  }
})

await check("a page started from the start screen is filed, so the scan lists its server after", async () => {
  // Under a temporary HOME: the start screen files pages in the state folder.
  const realHome = process.env.HOME
  process.env.HOME = project({})
  const { createStartScreen } = await import("../runtime/start-screen.mjs")
  const { rememberedPages } = await import("../runtime/last-pages.mjs")
  const screen = await createStartScreen({ port: 0, log: () => {} })
  try {
    const page = "/p/Site%20One/index.html#connect"
    const response = await fetch(new URL("/api/start", screen.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${mounted.port}${page}`, projectRoot: siteOne, devScript: null }),
    })
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)))
    const filed = rememberedPages()
    assert.deepEqual(filed, [{ port: mounted.port, projectRoot: siteOne, page }])
    const rows = await scanLocalApps({ ports: [], hosts: ["127.0.0.1"], remembered: filed })
    assert.ok(rows.some((app) => app.port === mounted.port && app.projectRoot === siteOne), "the filed page did not list its server")
  } finally {
    screen.close()
    process.env.HOME = realHome
  }
})

await check("a static server on a port off the fixed list is found by the folder it serves", async () => {
  const pages = await folderServer(site, { port: await freeChosenPort() })
  const helper = await folderServer(project({ "README.html": ABOUT }), {
    body: "<title>Some Desktop Helper</title>",
    port: await freeChosenPort(),
  })
  // The same folder, on a port the OS picked: a program's own server.
  const worker = await folderServer(site)
  try {
    if ((await projectRootForPort(pages.port)) === null) {
      console.log("       skip (this machine will not name another process's folder)")
      return
    }
    assert.equal(await projectRootForPort(pages.port), site)
    const rows = await scanLocalApps({ ports: [], discover: { pids: [], ports: [] } })
    const row = rows.find((app) => app.port === pages.port)
    assert.ok(row, "the static server was not listed")
    assert.equal(row.projectRoot, site)
    // A process started in a folder of pages whose root is not that folder's
    // index page is some other program, not a server for it.
    assert.ok(!rows.some((app) => app.port === helper.port), "a helper started in a folder of pages was listed")
    assert.ok(worker.port >= 32768, `the OS picked port ${worker.port}, below the range this case is about`)
    assert.ok(!rows.some((app) => app.port === worker.port), "a server on a port the OS picked was listed unasked")
  } finally {
    pages.close()
    helper.close()
    worker.close()
  }
})

/* ---------------------------------------------------------------------- */
console.log("\nAn editor starts against a folder of pages")

await check("the editor proxies a strict static server and serves its page with the editor in it", async () => {
  const appRoot = project({ "index.html": PAGE.replace("Agent Command Center:", "Static Prototype:") })
  const app = await mountServer(path.dirname(appRoot))
  const proxyPort = await freePort()
  const wsPort = await freePort()
  fs.writeFileSync(
    path.join(appRoot, "designlayer.config.mjs"),
    `export default { ports: { proxy: ${proxyPort}, ws: ${wsPort}, mcp: null } }\n`
  )
  const editorHome = project({})
  let output = ""
  const child = spawn(process.execPath, [path.join(PACKAGE_DIR, "cli.mjs"), String(app.port), "--project-root", appRoot, "--no-open"], {
    cwd: appRoot,
    env: { ...process.env, HOME: editorHome, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk) => (output += chunk))
  child.stderr.on("data", (chunk) => (output += chunk))
  try {
    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 30000)
      const look = () => {
        if (/\[designlayer\] proxy http:\/\/\S+:\d+/.test(output)) {
          clearTimeout(timer)
          resolve(true)
        }
      }
      child.stdout.on("data", look)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    assert.ok(ready, `the editor did not start:\n${output}`)
    const page = `/p/${encodeURIComponent(path.basename(appRoot))}/index.html`
    const response = await fetch(`http://127.0.0.1:${proxyPort}${page}`, { headers: { accept: "text/html" } })
    const body = await response.text()
    assert.equal(response.status, 200, `the static server refused the proxied page: ${body.slice(0, 80)}`)
    assert.match(body, /Static Prototype/)
    assert.match(body, /__REACT_REWRITE_WS_PORT__/, "the editor was not injected into the page")
    const overlay = /<script src="([^"]+)"/.exec(body.slice(body.indexOf("</main>")))?.[1]
    assert.ok(overlay, "no editor script in the page")
    const script = await (await fetch(`http://127.0.0.1:${proxyPort}${overlay}`)).text()
    assert.match(script, /"framework":"html"/, "the editor was not told it is on a plain HTML page")
  } finally {
    child.kill()
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)))
    await close(app.server)
  }
})

await close(mounted.server)
for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
