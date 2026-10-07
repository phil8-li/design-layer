#!/usr/bin/env node
/**
 * Performance harness: every flow of the editor, measured on a real browser
 * against a real host, so a speed claim is a number rather than a feeling.
 *
 *   node tools/perf.mjs                          # all metrics, 5 runs, headless
 *   node tools/perf.mjs --label after            # writes .harness/perf/after.json
 *   node tools/perf.mjs --compare baseline       # ratio against a saved run
 *   node tools/perf.mjs --only boot,select       # a subset (launch always runs)
 *   node tools/perf.mjs --runs 9 --cards 600     # more samples, a bigger page
 *   node tools/perf.mjs --steady-clock           # CPU held at one clock (see STEADY_CLOCK)
 *   node tools/perf.mjs --explore                # dump the chrome's DOM outline
 *
 * What it stands up, all torn down on exit (the board-e2e pattern):
 *   1. a throwaway Vite + React + Tailwind v4 host in os.tmpdir(), node_modules
 *      borrowed by symlink from DESIGNLAYER_E2E_DEPS — four routes, and a home page of
 *      `--cards` cards (default 300, ~3000 host nodes) so per-node costs show;
 *   2. Vite on a free port;
 *   3. `cli.mjs` on free proxy / ws / MCP / start-screen ports, so no running
 *      editor's single-client socket is touched.
 *
 * Every timing is a median over `--runs`. Browser timings are taken INSIDE the
 * page (performance.now around real input), and main-thread costs come from
 * CDP `Performance.getMetrics` deltas, so Playwright's own round trips are not
 * in the numbers. Lower is better for every metric.
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT_DIR = path.join(ROOT, ".harness", "perf")
// A Vite + React node_modules to borrow, named by DESIGNLAYER_E2E_DEPS.
const DEPS = process.env.DESIGNLAYER_E2E_DEPS
const READY_LINE = "[designlayer] Figma-style overlay ready"

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const RUNS = Number(option("--runs", 5))
const CARDS = Number(option("--cards", 300))
// Source files the app never imports, so the routes that walk a project
// (component usage, pages, lint) see a tree the size of a real one.
const FILES = Number(option("--files", 1500))
const LABEL = option("--label", null)
const COMPARE = option("--compare", null)
const ONLY = option("--only", null)?.split(",") ?? null
// Pools the samples of several saved runs into one (`--merge a,b,c --label all`),
// so runs interleaved with a baseline on a busy machine compare fairly.
const MERGE = option("--merge", null)?.split(",") ?? null
// `--profile select` prints where one flow's main-thread time went.
const PROFILE = option("--profile", null)
// `--timeline tabs` prints what the chrome wrote, and when, after each input.
const TIMELINE = option("--timeline", null)
// `--steady-clock` holds the CPU at its performance state for the whole run,
// the way a Linux benchmark pins its frequency governor. macOS clocks a
// core by how busy it is, so a lighter workload runs on a slower core: the
// same per-move work measured 0.3ms with two cores busy and 1.0ms without,
// while the baseline, heavy enough to keep its core fast either way, read
// 1.3-1.4ms in both. Two busy-looping children keep the performance cluster
// awake, so both trees are timed at one clock and the ratio is the work.
const STEADY_CLOCK = flag("--steady-clock")
const headed = flag("--headed")
const keep = flag("--keep")
const explore = flag("--explore")

const wants = (name) => !ONLY || ONLY.includes(name)

/* ---------- processes and cleanup ---------- */

const children = []
const tmpDirs = []
let browser = null

function run(cmd, argv, opts) {
  const child = spawn(cmd, argv, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  child.log = ""
  child.stdout.on("data", (d) => (child.log += d))
  child.stderr.on("data", (d) => (child.log += d))
  children.push(child)
  return child
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return
  const exited = new Promise((resolve) => child.once("exit", resolve))
  try { process.kill(-child.pid, "SIGTERM") } catch {}
  await Promise.race([exited, sleep(3000)])
  if (child.exitCode === null && !child.signalCode) {
    try { process.kill(-child.pid, "SIGKILL") } catch {}
  }
}

let cleaned = false
async function cleanup() {
  if (cleaned) return
  cleaned = true
  await browser?.close().catch(() => {})
  await Promise.all(children.map(stop))
  for (const dir of tmpDirs) {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true })
    else console.log(`kept host app at ${dir}`)
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { await cleanup(); process.exit(130) })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function waitHttp(url, child, label, timeout = 60000, every = 10) {
  const start = performance.now()
  while (performance.now() - start < timeout) {
    if (child.exitCode !== null) throw new Error(`${label} exited early:\n${child.log}`)
    try {
      const res = await fetch(url)
      await res.arrayBuffer()
      if (res.ok) return performance.now() - start
    } catch {}
    await sleep(every)
  }
  throw new Error(`${label} not answering ${url} after ${timeout}ms:\n${child.log}`)
}

/**
 * What any Node HTTP server takes from spawn to its first answer, on this
 * machine, polled the same way: the part of a launch no code of ours can
 * shorten. Startup metrics are reported raw and with this taken off.
 */
let nodeFloor = null
async function measureNodeFloor(port) {
  if (nodeFloor !== null) return nodeFloor
  const samples = []
  for (let i = 0; i < Math.max(RUNS, 5); i++) {
    // CommonJS, and that is the point: an ES import of `node:http` copies its
    // exports into a namespace, which runs Node's lazy getters for the fetch
    // globals and loads all of undici (~8ms) — work a server can skip, so not
    // part of any floor.
    const child = run(process.execPath, ["-e",
      `require("node:http").createServer((q, r) => r.end("ok")).listen(${port}, "127.0.0.1")`], {})
    samples.push(await waitHttp(`http://127.0.0.1:${port}/`, child, "node floor", 10000, 2))
    await stop(child)
    children.splice(children.indexOf(child), 1)
  }
  record("node.httpFloor", samples)
  return (nodeFloor = median(samples))
}

/* ---------- statistics ---------- */

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const metrics = {}
function record(name, values, unit = "ms") {
  const list = [values].flat()
  metrics[name] = { median: median(list), unit, samples: list.map((v) => Math.round(v * 100) / 100) }
  const m = metrics[name].median
  console.log(`  ${name.padEnd(34)} ${m === null ? "n/a" : formatValue(m, unit)}`)
}

function formatValue(value, unit) {
  if (unit === "bytes") return `${(value / 1024).toFixed(1)} KB`
  if (unit === "count") return String(Math.round(value))
  return `${value.toFixed(1)} ms`
}

/* ---------- the host app ---------- */

const ROUTES = [
  { path: "/", title: "Home" },
  { path: "/pricing", title: "Pricing" },
  { path: "/about", title: "About" },
  { path: "/settings", title: "Settings" },
]

function writeHost(dir, ports) {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  write("package.json", JSON.stringify({
    name: "perf-host",
    private: true,
    type: "module",
    scripts: { dev: "vite" },
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    devDependencies: { vite: "^8.0.0", "@vitejs/plugin-react": "^6.0.0", tailwindcss: "^4.0.0", "@tailwindcss/vite": "^4.0.0" },
  }, null, 2))
  write("vite.config.js", `import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
export default {
  plugins: [react(), tailwindcss()],
  cacheDir: ${JSON.stringify(path.join(dir, ".vite-cache"))},
  server: { host: "127.0.0.1" },
}
`)
  write("designlayer.config.mjs", `export default {
  ports: { proxy: ${ports.proxy}, ws: ${ports.ws}, mcp: ${ports.mcp} },
}
`)
  write("index.html", `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>perf host</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`)
  write("src/index.css", `@import "tailwindcss";\n`)
  write("src/routes.jsx", `export const routes = ${JSON.stringify(ROUTES, null, 2)}\n`)
  write("src/Card.jsx", `export function Badge({ children }) {
  return <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">{children}</span>
}

export function Card({ index }) {
  return (
    <article data-testid={"card-" + index} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-slate-900">Card {index}</h3>
        <Badge>New</Badge>
      </header>
      <p className="text-sm leading-6 text-slate-600">A short description of item {index}, long enough to wrap onto a second line.</p>
      <footer className="flex items-center gap-2">
        <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">Open</button>
        <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700">Share</button>
      </footer>
    </article>
  )
}
`)
  write("src/main.jsx", `import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { routes } from "./routes.jsx"
import { Card } from "./Card.jsx"

const CARDS = ${CARDS}

function usePath() {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname)
    window.addEventListener("popstate", onChange)
    return () => window.removeEventListener("popstate", onChange)
  }, [])
  const go = (to) => {
    window.history.pushState({}, "", to)
    setPath(to)
  }
  return [path, go]
}

function Nav({ go }) {
  return (
    <nav data-testid="nav" className="sticky top-0 z-10 flex h-14 items-center gap-4 bg-slate-900 px-5 text-white">
      <strong>Acme</strong>
      {routes.map((r) => (
        <a key={r.path} href={r.path} className="text-sm text-slate-200" onClick={(e) => { e.preventDefault(); go(r.path) }}>{r.title}</a>
      ))}
    </nav>
  )
}

function Home() {
  return (
    <main className="mx-auto max-w-6xl p-8">
      <section data-testid="hero" className="mb-8 rounded-2xl bg-indigo-600 px-8 py-16 text-white">
        <h1 data-testid="headline" className="text-5xl font-bold">Welcome home</h1>
        <p className="mt-4 text-lg">A page of {CARDS} cards.</p>
      </section>
      <div data-testid="grid" className="grid grid-cols-3 gap-4">
        {Array.from({ length: CARDS }, (_, i) => <Card key={i} index={i} />)}
      </div>
    </main>
  )
}

function Plain({ title }) {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 data-testid="headline" className="text-4xl font-bold">{title}</h1>
      {Array.from({ length: 6 }, (_, i) => <p key={i} className="mt-4 text-slate-600">{title} paragraph {i + 1}.</p>)}
    </main>
  )
}

function App() {
  const [path, go] = usePath()
  const route = routes.find((r) => r.path === path) ?? routes[0]
  return (
    <>
      <Nav go={go} />
      {route.path === "/" ? <Home /> : <Plain title={route.title} />}
    </>
  )
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>)
`)
  for (let i = 0; i < FILES; i++) {
    const folder = `src/features/area${Math.floor(i / 50)}`
    write(`${folder}/Feature${i}.jsx`, `import { Card, Badge } from "../../Card.jsx"

export function Feature${i}({ items = [] }) {
  return (
    <section className="flex flex-col gap-2 p-4">
      <h2 className="text-lg font-semibold">Feature ${i}</h2>
      <Badge>v${i % 7}</Badge>
      {items.map((item, index) => <Card key={index} index={item} />)}
      <Card index={${i}} />
    </section>
  )
}
`)
  }
  fs.symlinkSync(DEPS, path.join(dir, "node_modules"), "dir")
}

/* ---------- page instrumentation ---------- */

/**
 * Installed before any page script, so its capture listeners run ahead of the
 * editor's and its timestamps bracket the editor's whole response.
 */
function pageProbe(readyLine) {
  window.__perf = { ready: null, input: null, mutations: [], panelMutations: [], hostRendered: null }
  // When the host app's own content first exists: the editor's script runs
  // ahead of the host's modules, so whatever it costs, the app pays it here.
  const hostWatch = new MutationObserver(() => {
    if (document.querySelector('[data-testid="headline"]')) {
      window.__perf.hostRendered = performance.now()
      hostWatch.disconnect()
    }
  })
  hostWatch.observe(document, { subtree: true, childList: true })
  const info = console.info
  console.info = function (...argv) {
    if (window.__perf.ready === null && String(argv[0]).includes(readyLine)) {
      window.__perf.ready = performance.now()
    }
    return info.apply(this, argv)
  }
  // When a view transition starts painting: the board's open and close are
  // one, and their first frame — not the end of the animation — is the answer
  // to the click.
  window.__perf.transitions = []
  const startTransition = Document.prototype.startViewTransition
  if (startTransition) {
    Document.prototype.startViewTransition = function (...argv) {
      const transition = startTransition.apply(this, argv)
      transition.ready.then(() => window.__perf.transitions.push(performance.now()), () => {})
      return transition
    }
  }
  // Every input, because the response belongs to the event that caused it: a
  // tab answers `click`, the canvas answers `pointerdown`, and the gap between
  // the two is the harness's own dispatch, not the editor's time. `pointerup`
  // for the same reason: a note's composer answers the release, and timing it
  // from the press counted the gap between the harness's two dispatches.
  window.__perf.inputs = []
  for (const type of ["pointerdown", "pointerup", "keydown", "click"]) {
    window.addEventListener(type, () => {
      const now = performance.now()
      window.__perf.input ??= now
      window.__perf.inputs.push(now)
    }, true)
  }
  // Which input each recorded change came after, by order rather than by
  // clock: the timer is coarsened to 0.1ms, so a write made in `pointerdown`
  // and the `click` that follows it can carry the same timestamp, and a
  // timestamp comparison then blamed the later click and read the write as
  // instant. An observer callback runs before the next event is dispatched,
  // so the count of inputs seen when it runs names the one that caused it.
  window.__perf.causes = []
  const observer = new MutationObserver((records) => {
    const now = performance.now()
    for (const r of records) {
      const target = r.target.nodeType === 1 ? r.target : r.target.parentElement
      // The tooltip answers the pointer resting on a control after a delay;
      // it is not part of any flow's response, so it must not extend one.
      if (target?.closest?.(".de-tip, .de-tip-ruler")) continue
      // A write that leaves the attribute as it was paints nothing — and
      // neither does a style write that only re-arms a transition.
      if (r.type === "attributes") {
        const now = r.target.getAttribute(r.attributeName)
        if (r.attributeName === "style") {
          const strip = (v) => (v ?? "").replace(/transition:[^;]*;?\s*/g, "").trim()
          if (strip(r.oldValue) === strip(now)) continue
        } else if (r.oldValue === now) continue
      }
      if (target?.closest?.("[data-designlayer]")) {
        window.__perf.mutations.push(now)
        window.__perf.causes.push(window.__perf.inputs.length - 1)
        if (window.__perf.timeline) {
          const where = `${target.tagName.toLowerCase()}${target.classList.length ? "." + [...target.classList].slice(0, 2).join(".") : ""}`
          window.__perf.timeline.push(`${(now - (window.__perf.input ?? now)).toFixed(1)}ms ${r.type}${r.attributeName ? ":" + r.attributeName : ""} ${where}`)
        }
        // Panels and toolbar only: the overlay layers follow the host's own
        // layout (an HMR re-render moves every outline), which is not the
        // editor's response time.
        if (!target.closest(".de-overlay-layer")) window.__perf.panelMutations.push(now)
        break
      }
    }
  })
  const start = () => observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true })
  if (document.documentElement) start()
  else document.addEventListener("DOMContentLoaded", start)
}

/**
 * Time from the input that caused it to the chrome's last change in response.
 * "Stopped" is `quiet` ms without a chrome mutation.
 */
async function settleAfterInput(page, quiet = 250, timeout = 5000, scope = "all") {
  const result = await settle(page, quiet, timeout, scope)
  if (TIMELINE) {
    const lines = await page.evaluate(() => window.__perf.timeline?.splice(0) ?? [])
    console.log(`    -- ${result.latency.toFixed(1)}ms\n${lines.slice(-40).map((l) => `       ${l}`).join("\n")}`)
  }
  return result
}

async function settle(page, quiet, timeout, scope) {
  return page.evaluate(async ({ quiet, timeout, scope }) => {
    const p = window.__perf
    const list = scope === "panels" ? p.panelMutations : p.mutations
    const started = performance.now()
    for (;;) {
      await new Promise((r) => setTimeout(r, 25))
      const last = list.length ? list[list.length - 1] : p.input
      if (performance.now() - Math.max(last ?? 0, p.input ?? 0) >= quiet) break
      if (performance.now() - started > timeout) break
    }
    const after = list.filter((t) => t >= p.input)
    const last = after.length ? after[after.length - 1] : p.input
    // The latest input before the first change is the one that caused it —
    // by order (`causes`, see the probe), which a shared timestamp cannot fool.
    // Panel changes are a subset of all changes, so the first panel change is
    // found among all of them by its own timestamp.
    const first = after.length ? p.mutations.indexOf(after[0]) : -1
    const cause = first >= 0 ? (p.inputs[p.causes[first]] ?? p.input) : p.input
    // To the last write, not to a guessed paint: a write made inside a frame
    // callback paints in that frame and one made in a task paints in the next,
    // and adding a fixed frame to both only buried the editor's own time under
    // a constant the display sets.
    return { latency: last - cause, changed: after.length > 0 }
  }, { quiet, timeout, scope })
}

async function resetInput(page) {
  await page.evaluate((timeline) => {
    if (timeline) window.__perf.timeline = []
    window.__perf.input = null
    window.__perf.inputs.length = 0
    window.__perf.mutations.length = 0
    window.__perf.causes.length = 0
    window.__perf.panelMutations.length = 0
  }, Boolean(TIMELINE))
}

async function cdpMetrics(cdp) {
  const { metrics: list } = await cdp.send("Performance.getMetrics")
  return Object.fromEntries(list.map((m) => [m.name, m.value]))
}

function delta(after, before, name, scale = 1000) {
  return (after[name] - before[name]) * scale
}

/* ---------- main ---------- */

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  if (STEADY_CLOCK) {
    for (let i = 0; i < 2; i++) run(process.execPath, ["-e", "for (;;) {}"])
    console.log("steady clock: 2 busy cores")
  }
  const ports = {
    app: await freePort(), proxy: await freePort(), ws: await freePort(),
    mcp: await freePort(), screen: await freePort(),
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-perf-"))
  tmpDirs.push(tmpDir)
  writeHost(tmpDir, ports)
  console.log(`host ${tmpDir}\nports ${JSON.stringify(ports)}`)

  const vite = run(process.execPath,
    ["node_modules/vite/bin/vite.js", "--port", String(ports.app), "--strictPort", "--configLoader", "native"],
    { cwd: tmpDir, env: { ...process.env, BROWSER: "none" } })
  await waitHttp(`http://127.0.0.1:${ports.app}/`, vite, "vite")
  // Warm Vite's dependency optimizer and Tailwind once, outside every timing.
  browser = await chromium.launch({ headless: !headed })
  {
    const warm = await browser.newPage()
    await warm.goto(`http://127.0.0.1:${ports.app}/`, { waitUntil: "networkidle" })
    await warm.close()
  }

  const cliArgs = [path.join(ROOT, "cli.mjs"), String(ports.app),
    "--project-root", tmpDir, "--config", path.join(tmpDir, "designlayer.config.mjs"),
    "--proxy-port", String(ports.proxy), "--ws-port", String(ports.ws), "--no-open", "--no-start"]
  const proxyUrl = `http://127.0.0.1:${ports.proxy}/`

  console.log("\nlaunch")
  let cli = null
  if (wants("launch")) {
    // Ready is the proxy answering a route of its own — the editor's startup,
    // and nothing of the host's. The first page through it adds the host's
    // own response, and is recorded beside it.
    const ownRoute = new URL("/__designlayer/mcp/status", proxyUrl).href
    const launches = []
    const firstPages = []
    for (let i = 0; i < Math.max(RUNS, 3); i++) {
      cli = run(process.execPath, cliArgs, { cwd: tmpDir })
      const t = performance.now()
      launches.push(await waitHttp(ownRoute, cli, "designlayer proxy", 60000, 2))
      await waitHttp(proxyUrl, cli, "designlayer proxy", 60000, 2)
      firstPages.push(performance.now() - t)
      if (i < Math.max(RUNS, 3) - 1) { await stop(cli); children.splice(children.indexOf(cli), 1) }
    }
    record("launch.proxyReady", launches)
    record("launch.firstPage", firstPages)
    const floor = await measureNodeFloor(ports.screen)
    record("launch.overNode", launches.map((v) => v - floor))
  } else {
    cli = run(process.execPath, cliArgs, { cwd: tmpDir })
    await waitHttp(proxyUrl, cli, "designlayer proxy")
  }

  if (explore) return exploreChrome(proxyUrl, ports)
  // `--hold` keeps the host and the editor up for a probe of your own.
  if (flag("--hold")) {
    console.log(`\nholding: app http://127.0.0.1:${ports.app}/  editor ${proxyUrl}  (Ctrl+C to stop)`)
    await new Promise(() => {})
  }

  if (wants("overlay")) await measureOverlay(proxyUrl)
  if (wants("api")) await measureApi(tmpDir, ports)
  HOST_DIR = tmpDir
  await measureBrowser(proxyUrl, ports)
  if (wants("screen")) await measureStartScreen(ports)
  return 0
}

/* ---------- overlay delivery (Node side) ---------- */

/** One request read raw — no decoding — so the time is the server's and the wire's, not a decoder's. */
function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const t = performance.now()
    const req = http.get(url, { headers }, (res) => {
      let bytes = 0
      res.on("data", (chunk) => (bytes += chunk.length))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes, ms: performance.now() - t }))
    })
    req.on("error", reject)
  })
}

async function measureOverlay(proxyUrl) {
  console.log("\noverlay delivery")
  const url = new URL("/__react-rewrite/overlay.js", proxyUrl).href
  const browserEncodings = { "accept-encoding": "gzip, deflate, br, zstd" }
  const first = []
  const wire = []
  const decoded = []
  const repeat = []
  for (let i = 0; i < RUNS * 2; i++) {
    // What a browser's first load is sent: its own Accept-Encoding, read raw.
    const response = await rawGet(url, browserEncodings)
    first.push(response.ms)
    wire.push(response.bytes)
    decoded.push((await rawGet(url, { "accept-encoding": "identity" })).bytes)
    // A reload: revalidated when the server gave a validator, re-sent when not.
    const etag = response.headers.etag
    const again = await rawGet(url, { ...browserEncodings, ...(etag ? { "if-none-match": etag } : {}) })
    repeat.push(again.ms)
    if (i === 0) metrics.__revalidate = `${again.status}, ${again.bytes} bytes`
  }
  record("overlay.firstLoad", first)
  record("overlay.bytesOnWire", wire, "bytes")
  record("overlay.bytesDecoded", decoded, "bytes")
  record("overlay.repeatLoad", repeat)
  console.log(`  (repeat request answered ${metrics.__revalidate})`)
}

/* ---------- API routes (Node side) ---------- */

async function measureApi(tmpDir, ports) {
  console.log("\napi routes")
  const base = `http://127.0.0.1:${ports.proxy}`
  const endpoint = JSON.parse(fs.readFileSync(path.join(tmpDir, ".local", "designlayer", "endpoint.json"), "utf8"))
  const prefix = endpoint.apiPrefix
  const routes = [
    ["api.libraries", `${prefix}/libraries`],
    ["api.options", `${prefix}/options?file=src/Card.jsx`],
    ["api.icons", `${prefix}/icons`],
    // Project-relative, which the server answered before and after; the Vite
    // spelling (`/src/Card.jsx`) was a 403 before, and is pinned in variant-cases.
    ["api.variants", `${prefix}/variants?file=src%2FCard.jsx`],
    ["api.pages", `${prefix}/pages`],
    ["api.componentUsage", `${prefix}/component/usage?name=Card&definedIn=%2Fsrc%2FCard.jsx`],
    ["api.componentUsageOther", `${prefix}/component/usage?name=Badge&definedIn=%2Fsrc%2FCard.jsx`],
    ["api.lintTools", `${prefix}/lint/tools`],
    ["api.apps", `${prefix}/apps`],
    ["api.mcpStatus", `${prefix}/mcp/status`],
  ]
  for (const [name, route] of routes) {
    const times = []
    let status = null
    let first = null
    for (let i = 0; i <= RUNS; i++) {
      const t = performance.now()
      const res = await fetch(base + route, { headers: { origin: base } })
      await res.arrayBuffer()
      if (i === 0) first = performance.now() - t
      else times.push(performance.now() - t)
      status = res.status
    }
    record(`${name}.first`, [first])
    record(`${name}`, times)
    if (status >= 400) console.log(`    (${route} answered ${status})`)
  }
}

/* ---------- start screen ---------- */

async function measureStartScreen(ports) {
  console.log("\nstart screen")
  const ready = []
  const scans = []
  const floor = await measureNodeFloor(ports.screen)
  for (let i = 0; i < Math.max(RUNS, 3); i++) {
    const screen = run(process.execPath, [path.join(ROOT, "cli.mjs"), "--no-open", "--start-screen-port", String(ports.screen)], { cwd: os.tmpdir() })
    const url = `http://127.0.0.1:${ports.screen}/`
    ready.push(await waitHttp(url, screen, "start screen", 60000, 2))
    const page = await fetch(url).then((r) => r.text())
    const apiPath = page.match(/["'`](\/api\/apps[^"'`]*)["'`]/)?.[1] ?? "/api/apps"
    const t = performance.now()
    const res = await fetch(new URL(apiPath, url), { headers: { origin: url.slice(0, -1) } })
    await res.arrayBuffer()
    scans.push(performance.now() - t)
    await stop(screen)
    children.splice(children.indexOf(screen), 1)
  }
  record("screen.ready", ready)
  record("screen.overNode", ready.map((v) => v - floor))
  record("screen.appScan", scans)
}

/* ---------- browser flows ---------- */

const failedUrls = new Set()
let HOST_DIR = null

async function newEditorPage(context) {
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  await cdp.send("Network.enable")
  const overlay = { encoded: 0, fromCache: false }
  cdp.on("Network.responseReceived", (e) => {
    if (e.response.url.includes("/__react-rewrite/overlay.js")) {
      overlay.requestId = e.requestId
      overlay.fromCache = e.response.fromDiskCache || e.response.fromMemoryCache || e.response.status === 304
      overlay.status = e.response.status
    }
  })
  cdp.on("Network.loadingFinished", (e) => {
    if (e.requestId === overlay.requestId) overlay.encoded = e.encodedDataLength
  })
  page.on("pageerror", (e) => console.log(`    pageerror: ${e.message}`))
  page.on("response", (r) => {
    if (r.status() >= 400 && !failedUrls.has(r.url())) {
      failedUrls.add(r.url())
      console.log(`    ${r.status()} ${r.request().method()} ${r.url()}`)
    }
  })
  return { page, cdp, overlay }
}

/**
 * Main-thread time spent compiling and evaluating the injected overlay script
 * while `action` runs, from a Chromium trace: the top-level compile plus the
 * evaluation of the script, the part the host's own modules wait behind.
 */
async function overlayEvalMs(page, action) {
  await browser.startTracing(page, { categories: ["devtools.timeline", "v8"] })
  try {
    await action()
  } finally {
    var buffer = await browser.stopTracing()
  }
  let micros = 0
  for (const event of JSON.parse(buffer.toString()).traceEvents ?? []) {
    if (event.ph !== "X" || !["EvaluateScript", "v8.compile"].includes(event.name)) continue
    const url = event.args?.data?.url ?? event.args?.data?.fileName ?? event.args?.fileName ?? ""
    if (url.includes("/__react-rewrite/overlay.js")) micros += event.dur ?? 0
  }
  return micros / 1000
}

async function waitReady(page, timeout = 60000) {
  await page.waitForFunction(() => window.__perf?.ready !== null && window.__perf?.ready !== undefined, null, { timeout, polling: 20 })
  return page.evaluate(() => window.__perf.ready)
}

async function measureBrowser(proxyUrl, ports) {
  const appUrl = `http://127.0.0.1:${ports.app}/`
  const viewport = { width: 1440, height: 900 }

  if (wants("boot")) {
    console.log("\nboot")
    /*
     * Three reloads after each cold load, and "warm" is the second and third.
     *
     * A browser builds a script's code cache on the script's SECOND run, so the
     * first reload after a new version — of the bundle, or of the host's own
     * modules — is a state of its own: it compiles nearly as much as a cold
     * load, pays once for the caches (~2.7ms of main thread for this bundle),
     * and every load after it starts from them. Steady state is what a
     * session's reloads cost; the first reload is reported beside it, and is
     * a target too except for the cache build itself. A script served
     * uncacheable — the baseline's — never reaches steady state, and re-parses
     * on every load.
     */
    const RELOADS = 3
    const hostOnly = { script: [], task: [], heap: [], rendered: [], warmRendered: [], firstRendered: [], layout: [], style: [] }
    for (let i = 0; i < RUNS; i++) {
      const context = await browser.newContext({ viewport })
      await context.addInitScript(pageProbe, READY_LINE)
      const page = await context.newPage()
      const cdp = await context.newCDPSession(page)
      await cdp.send("Performance.enable")
      await page.goto(appUrl, { waitUntil: "load" })
      await page.waitForSelector('[data-testid="card-0"]')
      await sleep(300)
      await cdp.send("HeapProfiler.collectGarbage")
      const m = await cdpMetrics(cdp)
      hostOnly.script.push(m.ScriptDuration * 1000)
      hostOnly.task.push(m.TaskDuration * 1000)
      hostOnly.heap.push(m.JSHeapUsedSize)
      hostOnly.layout.push(m.LayoutDuration * 1000)
      hostOnly.style.push(m.RecalcStyleDuration * 1000)
      hostOnly.rendered.push(await page.evaluate(() => window.__perf.hostRendered))
      for (let reload = 1; reload <= RELOADS; reload++) {
        await page.reload({ waitUntil: "load" })
        await page.waitForSelector('[data-testid="card-0"]')
        const rendered = await page.evaluate(() => window.__perf.hostRendered)
        ;(reload === 1 ? hostOnly.firstRendered : hostOnly.warmRendered).push(rendered)
        await sleep(300)
      }
      await context.close()
    }

    const cold = { ready: [], script: [], task: [], layout: [], style: [], heap: [], bytes: [], rendered: [], eval: [] }
    const warm = { ready: [], bytes: [], rendered: [], eval: [] }
    const first = { ready: [], rendered: [], eval: [] }
    for (let i = 0; i < RUNS; i++) {
      const context = await browser.newContext({ viewport })
      await context.addInitScript(pageProbe, READY_LINE)
      const { page, cdp, overlay } = await newEditorPage(context)
      await page.goto(proxyUrl, { waitUntil: "commit" })
      cold.ready.push(await waitReady(page))
      await sleep(300)
      await cdp.send("HeapProfiler.collectGarbage")
      const m = await cdpMetrics(cdp)
      cold.script.push(m.ScriptDuration * 1000)
      cold.task.push(m.TaskDuration * 1000)
      cold.layout.push(m.LayoutDuration * 1000)
      cold.style.push(m.RecalcStyleDuration * 1000)
      cold.heap.push(m.JSHeapUsedSize)
      cold.bytes.push(overlay.encoded)
      cold.rendered.push(await page.evaluate(() => window.__perf.hostRendered))

      // Reloads in the same context: what navigations after the first cost.
      for (let reload = 1; reload <= RELOADS; reload++) {
        overlay.encoded = 0
        await page.reload({ waitUntil: "commit" })
        const ready = await waitReady(page)
        await sleep(300)
        const rendered = await page.evaluate(() => window.__perf.hostRendered)
        const into = reload === 1 ? first : warm
        into.ready.push(ready)
        into.rendered.push(rendered)
        if (reload > 1) warm.bytes.push(overlay.encoded)
      }
      await context.close()
    }
    // Traced on their own runs: a trace slows everything it watches, so the
    // timings above are taken without one.
    for (let i = 0; i < RUNS; i++) {
      const context = await browser.newContext({ viewport })
      await context.addInitScript(pageProbe, READY_LINE)
      const { page } = await newEditorPage(context)
      cold.eval.push(await overlayEvalMs(page, async () => {
        await page.goto(proxyUrl, { waitUntil: "commit" })
        await waitReady(page)
      }))
      for (let reload = 1; reload <= RELOADS; reload++) {
        await sleep(300)
        ;(reload === 1 ? first : warm).eval.push(await overlayEvalMs(page, async () => {
          await page.reload({ waitUntil: "commit" })
          await waitReady(page)
        }))
      }
      await context.close()
    }
    const hostScript = median(hostOnly.script)
    const hostTask = median(hostOnly.task)
    const hostRendered = median(hostOnly.rendered)
    const hostWarm = median(hostOnly.warmRendered)
    const hostFirst = median(hostOnly.firstRendered)
    console.log(`  (host renders at ${hostRendered.toFixed(1)} cold / ${hostFirst.toFixed(1)} first reload / ${hostWarm.toFixed(1)} warm; with the editor ${median(cold.rendered).toFixed(1)} / ${median(first.rendered).toFixed(1)} / ${median(warm.rendered).toFixed(1)})`)
    record("boot.hostRenderDelayCold", cold.rendered.map((v) => v - hostRendered))
    record("boot.hostRenderDelayWarm", warm.rendered.map((v) => v - hostWarm))
    record("boot.hostRenderDelayFirstReload", first.rendered.map((v) => v - hostFirst))
    record("boot.coldReadyAfterHost", cold.ready.map((v, i) => v - cold.rendered[i]))
    record("boot.warmReadyAfterHost", warm.ready.map((v, i) => v - warm.rendered[i]))
    // The editor's whole cost to a page load: how long it held the app's first
    // render back, plus how long after that render it took to be ready.
    record("boot.editorOverheadCold", cold.rendered.map((v, i) => v - hostRendered + (cold.ready[i] - v)))
    record("boot.editorOverheadWarm", warm.rendered.map((v, i) => v - hostWarm + (warm.ready[i] - v)))
    record("boot.editorOverheadFirstReload", first.rendered.map((v, i) => v - hostFirst + (first.ready[i] - v)))
    record("boot.coldReady", cold.ready)
    record("boot.warmReady", warm.ready)
    record("boot.overlayEvalCold", cold.eval)
    record("boot.overlayEvalWarm", warm.eval)
    record("boot.overlayEvalFirstReload", first.eval)
    record("boot.coldEditorScript", cold.script.map((v) => v - hostScript))
    record("boot.coldEditorTask", cold.task.map((v) => v - hostTask))
    record("boot.coldEditorLayout", cold.layout.map((v) => v - median(hostOnly.layout)))
    record("boot.coldEditorRecalcStyle", cold.style.map((v) => v - median(hostOnly.style)))
    record("boot.editorHeap", cold.heap.map((v) => v - median(hostOnly.heap)), "bytes")
    record("boot.coldOverlayBytes", cold.bytes, "bytes")
    record("boot.warmOverlayBytes", warm.bytes, "bytes")
  }

  if (wants("toast")) {
    console.log("\ntoast")
    // Each in a fresh page, because the first card of a page is the one that
    // used to wait for the toaster to load at all.
    const first = []
    const later = []
    for (let i = 0; i < RUNS; i++) {
      const context = await browser.newContext({ viewport })
      await context.addInitScript(pageProbe, READY_LINE)
      const { page } = await newEditorPage(context)
      await page.goto(proxyUrl, { waitUntil: "commit" })
      await waitReady(page)
      await sleep(800)
      first.push(await toastAfterApply(page, "20"))
      later.push(await toastAfterApply(page, "18"))
      await context.close()
    }
    record("toast.firstShown", first)
    record("toast.shown", later)
  }

  if (wants("board")) {
    console.log("\nboard")
    /*
     * Each run in a fresh page. The first open of a page is the one that asks
     * for the page list and loads every frame; a later open in the same page
     * finds both still there. They were once one median over three opens of
     * one long-lived page, which mixed the two states and compared whichever
     * each build happened to be in.
     */
    const first = { response: [], frames: [], end: [] }
    const reopen = []
    const closed = []
    let overlayRequests = 0
    // At least one run per frame phase, each input of a run at the next one.
    const runs = Math.max(RUNS, FRAME_PHASES.length)
    const phase = (run, step) => FRAME_PHASES[(run + step) % FRAME_PHASES.length]
    for (let i = 0; i < runs; i++) {
      const context = await browser.newContext({ viewport })
      await context.addInitScript(pageProbe, READY_LINE)
      const { page } = await newEditorPage(context)
      await page.goto(proxyUrl, { waitUntil: "commit" })
      await waitReady(page)
      await sleep(800)
      const count = (request) => { if (request.url().includes("/__react-rewrite/overlay.js")) overlayRequests++ }
      page.on("request", count)
      const opened = await openBoard(page, phase(i, 0))
      first.response.push(opened.response)
      first.frames.push(opened.frames)
      first.end.push(opened.open)
      await sleep(300)
      closed.push(await closeBoard(page, phase(i, 1)))
      await sleep(800)
      reopen.push((await openBoard(page, phase(i, 2))).response)
      page.off("request", count)
      await sleep(300)
      closed.push(await closeBoard(page, phase(i, 3)))
      await context.close()
    }
    /*
     * The frames are four copies of the host app, and most of the time until
     * they show is the app booting four times — work no editor can do for it.
     * So the same four routes are loaded as plain frames of the bare app, and
     * the target is the board's time over that.
     */
    const hostFrames = []
    for (let i = 0; i < runs; i++) {
      const context = await browser.newContext({ viewport })
      const page = await context.newPage()
      await page.goto(appUrl, { waitUntil: "load" })
      await page.waitForSelector('[data-testid="card-0"]')
      await sleep(500)
      hostFrames.push(await page.evaluate((routes) => new Promise((resolve) => {
        const t0 = performance.now()
        const frames = routes.map((route) => {
          const frame = document.createElement("iframe")
          frame.src = route
          frame.style.cssText = "position:fixed;left:0;top:0;width:1440px;height:900px;border:0;"
          document.body.append(frame)
          return frame
        })
        const tick = () => {
          const ready = frames.every((f) => {
            try { return f.contentDocument?.readyState === "complete" && f.contentDocument.querySelector('[data-testid="headline"]') } catch { return false }
          })
          if (ready || performance.now() - t0 > 30000) resolve(performance.now() - t0)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }), ROUTES.map((route) => route.path)))
      await context.close()
    }
    const hostFloor = median(hostFrames)
    record("board.openResponse", first.response)
    record("board.framesReady", first.frames)
    record("board.framesReadyOverHost", first.frames.map((v) => v - hostFloor))
    record("board.openAnimationEnd", first.end)
    record("board.reopenResponse", reopen)
    record("board.closeResponse", closed)
    // The frames are copies of the page for the board to show; none of them
    // should download the editor.
    record("board.overlayRequests", [overlayRequests], "count")
  }

  if (wants("hover") || wants("scroll")) await measureHostInteraction(appUrl)

  // One long-lived editor page for the interaction flows.
  const context = await browser.newContext({ viewport })
  await context.addInitScript(pageProbe, READY_LINE)
  const { page, cdp } = await newEditorPage(context)
  await page.goto(proxyUrl, { waitUntil: "commit" })
  await waitReady(page)
  await sleep(800)

  try {
    await interactionFlows(page, cdp)
  } finally {
    await context.close()
  }
}

async function interactionFlows(page, cdp) {
  const centerOf = async (selector) => {
    const box = await page.locator(selector).first().boundingBox()
    if (!box) throw new Error(`no box for ${selector}`)
    return { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 12) }
  }
  /** Clicks `selector` (a chrome control) and times it until the chrome settles. */
  const timedClick = async (selector, quiet) => {
    const target = page.locator(selector).first()
    await target.waitFor({ state: "visible", timeout: 5000 })
    await resetInput(page)
    await target.click()
    return settleAfterInput(page, quiet)
  }
  const timedKey = async (key, quiet) => {
    await resetInput(page)
    await page.keyboard.press(key)
    return settleAfterInput(page, quiet)
  }
  const select = async (selector) => {
    const target = await centerOf(selector)
    await page.mouse.click(target.x, target.y)
    await sleep(400)
  }
  /**
   * Selects an element and returns the inspector's font-size field, trying
   * again from a reset chrome if the field does not show: an Apply rewrites
   * the host's source, and a click that lands while the app is hot-reloading
   * can select a node that is about to be replaced.
   */
  const selectForEdit = async (selector) => {
    for (let attempt = 0; ; attempt++) {
      await page.locator('.de-panel--right .de-tab:text-is("Design")').click({ timeout: 2000 }).catch(() => {})
      await select(selector)
      const input = page.locator('input[data-de-field="type.size"]').first()
      try {
        await input.waitFor({ state: "visible", timeout: 2000 })
        return input
      } catch (error) {
        if (attempt >= 2) throw error
        await sleep(800)
        await resetChrome()
      }
    }
  }
  /** Back to a known state: editor shown, Inspect tool, nothing focused or open. */
  const resetChrome = async () => {
    await page.evaluate(() => document.activeElement?.blur?.())
    // Escape with nothing selected stands the editor down to the disc, so
    // whatever these two leave behind, the disc brings the editor back.
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await sleep(500)
    if (await page.locator(".de-launcher").isVisible().catch(() => false)) {
      await page.locator(".de-launcher").click({ timeout: 3000 }).catch(() => {})
      await sleep(600)
    }
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.mouse.move(700, 120)
    await sleep(150)
  }

  const flows = {
    async hover() {
      const perMove = await hoverLoop(page, cdp)
      record("hover.mainThreadPerMove", perMove)
      if (hostBaseline.hover !== undefined) record("hover.editorPerMove", perMove.map((v) => v - hostBaseline.hover))
    },

    async select() {
      const latencies = []
      const tasks = []
      const targets = ['[data-testid="card-1"] h3', '[data-testid="card-5"] p', '[data-testid="headline"]', '[data-testid="card-7"] button']
      for (let r = 0; r < RUNS * 2; r++) {
        const target = await centerOf(targets[r % targets.length])
        await page.mouse.move(target.x, target.y)
        await sleep(60)
        await resetInput(page)
        const before = await cdpMetrics(cdp)
        await page.mouse.click(target.x, target.y)
        // Counted over a fixed window with the page left alone, then settled.
        // `settleAfterInput` polls the page every 25ms until it has been quiet
        // for 250ms, and each poll is a task on the main thread being measured:
        // ~12 of them a click, the same few milliseconds in both trees, added
        // to what the editor spent. The settle reads the timestamps the page
        // recorded, so measuring after the window changes no latency.
        await sleep(MAIN_THREAD_WINDOW_MS)
        const after = await cdpMetrics(cdp)
        const { latency, changed } = await settleAfterInput(page)
        if (changed) latencies.push(latency)
        tasks.push(delta(after, before, "TaskDuration"))
      }
      record("select.clickToSettled", latencies)
      record("select.mainThread", tasks)
    },

    async scroll() {
      await select('[data-testid="card-1"] h3')
      const perFrame = await scrollLoop(page, cdp)
      record("scroll.mainThreadPerFrame", perFrame)
      if (hostBaseline.scroll !== undefined) record("scroll.editorPerFrame", perFrame.map((v) => v - hostBaseline.scroll))
    },

    async tabs() {
      const right = []
      const left = []
      await select('[data-testid="card-2"] h3')
      for (let r = 0; r < RUNS; r++) {
        for (const name of ["Changes", "Design system", "Design"]) {
          right.push((await timedClick(`.de-panel--right .de-tab:text-is("${name}")`)).latency)
        }
        for (const name of ["Design options", "Layers"]) {
          left.push((await timedClick(`.de-panel--left .de-tab:text-is("${name}")`)).latency)
        }
      }
      record("tabs.inspectorSwitch", right)
      record("tabs.leftSwitch", left)
    },

    async layers() {
      const filter = []
      for (let r = 0; r < RUNS; r++) {
        const input = page.locator(".de-layer-filter")
        await input.fill("")
        await sleep(200)
        await input.focus()
        await resetInput(page)
        await page.keyboard.type("Card", { delay: 0 })
        filter.push((await settleAfterInput(page)).latency)
        await input.fill("")
        await sleep(300)
      }
      record("layers.filterSettled", filter)
    },

    async walk() {
      await select('[data-testid="card-3"]')
      const presses = []
      for (let r = 0; r < RUNS * 2; r++) presses.push((await timedKey("Tab", 120)).latency)
      record("walk.tabToSettled", presses)
    },

    async edit() {
      const preview = []
      for (let r = 0; r < RUNS; r++) {
        const input = await selectForEdit('[data-testid="card-4"] h3')
        const size = r % 2 ? "18" : "20"
        await input.fill(size)
        await resetInput(page)
        // Watched from inside the page, from before the key: the time is
        // keydown → the write after which the host element computes the value.
        // A mutation observer, not a frame loop, so the answer is the editor's
        // own time and not the distance to the next frame.
        const watch = page.evaluate((px) => new Promise((resolve) => {
          const h3 = document.querySelector('[data-testid="card-4"] h3')
          const shows = () => getComputedStyle(h3).fontSize === `${px}px`
          const observer = new MutationObserver(() => {
            if (window.__perf.input === null || !shows()) return
            observer.disconnect()
            resolve(performance.now() - window.__perf.input)
          })
          observer.observe(h3, { attributes: true, attributeFilter: ["style", "class"] })
          observer.observe(document.head, { childList: true, subtree: true, characterData: true })
          setTimeout(() => { observer.disconnect(); resolve(NaN) }, 5000)
        }), size)
        await input.press("Enter")
        preview.push(await watch)
        await settleAfterInput(page)
      }
      record("edit.previewApplied", preview)
    },

    async notes() {
      const open = []
      const tasks = []
      for (let r = 0; r < RUNS; r++) {
        await resetChrome()
        await page.keyboard.press("c")
        await sleep(200)
        // Cards 6-8 are the row on screen; card 9 and later sit under the
        // fold, where the click met nothing and the run recorded no change.
        const target = await centerOf(`[data-testid="card-${6 + (r % 3)}"] p`)
        await page.mouse.move(target.x, target.y)
        await sleep(60)
        await resetInput(page)
        const before = await cdpMetrics(cdp)
        await page.mouse.click(target.x, target.y)
        // The whole press and release, as `select.mainThread` counts a click
        // and over the same untouched window: the composer answers the
        // release, but the press is handled too, and that is where the two
        // trees differ.
        await sleep(MAIN_THREAD_WINDOW_MS)
        tasks.push(delta(await cdpMetrics(cdp), before, "TaskDuration"))
        open.push((await settleAfterInput(page)).latency)
        await page.keyboard.press("Escape")
        await page.keyboard.press("Escape")
        await page.keyboard.press("v")
        await sleep(200)
      }
      record("notes.clickToComposer", open)
      record("notes.mainThread", tasks)
    },

    async chooser() {
      const open = []
      for (let r = 0; r < RUNS; r++) {
        open.push((await timedClick(".de-app-chooser")).latency)
        await page.keyboard.press("Escape")
        await sleep(300)
      }
      record("chooser.open", open)
    },

    async theme() {
      const tasks = []
      for (let r = 0; r < RUNS; r++) {
        const before = await cdpMetrics(cdp)
        await page.locator('.de-toolbar button[aria-label^="Switch to"]').first().click()
        await sleep(600)
        const after = await cdpMetrics(cdp)
        tasks.push(delta(after, before, "TaskDuration"))
      }
      record("theme.toggleMainThread", tasks)
    },

    async hide() {
      const hide = []
      const show = []
      for (let r = 0; r < RUNS; r++) {
        hide.push((await timedKey("Meta+Period", 400)).latency)
        show.push((await timedKey("Meta+Period", 400)).latency)
      }
      record("hide.toggleOff", hide)
      record("hide.toggleOn", show)
    },

    async apply() {
      const file = path.join(HOST_DIR, "src", "Card.jsx")
      const written = []
      const settled = []
      const panels = []
      for (let r = 0; r < RUNS; r++) {
        const input = await selectForEdit('[data-testid="card-4"] h3')
        await input.fill(r % 2 ? "18" : "20")
        await input.press("Enter")
        await sleep(300)
        await page.locator('.de-panel--right .de-tab:text-is("Changes")').click()
        // "Send to agent" when a note is pending too; it writes the edits all the same.
        const button = page.locator('.de-panel--right button:visible').filter({ hasText: /^\s*(Apply to code|Send to agent)\s*$/ }).first()
        await button.waitFor({ state: "visible", timeout: 5000 })
        await sleep(200)
        if (process.env.PERF_DEBUG && r === 0) {
          console.log(`    button "${(await button.textContent()).trim()}", ledger: ${await page.evaluate(() => document.querySelector(".de-panel--right .de-tabpanel:not([hidden])")?.innerText.slice(0, 300).replace(/\s+/g, " "))}`)
        }
        const before = fs.statSync(file).mtimeMs
        await resetInput(page)
        const t = performance.now()
        await button.click()
        let wroteAt = null
        while (performance.now() - t < 10000) {
          if (fs.statSync(file).mtimeMs !== before) { wroteAt = performance.now(); break }
          await sleep(1)
        }
        // The click's own time (in the page) against the file's own mtime, both
        // on the wall clock: what the editor took, without the harness's click
        // dispatch or its polling in it.
        const clickedAt = await page.evaluate(() => performance.timeOrigin + window.__perf.inputs[window.__perf.inputs.length - 1])
        written.push(wroteAt === null ? NaN : fs.statSync(file).mtimeMs - clickedAt)
        panels.push((await settleAfterInput(page, 400, 10000, "panels")).latency)
        settled.push((await settleAfterInput(page, 400, 10000)).latency)
        await page.locator('.de-panel--right .de-tab:text-is("Design")').click()
        await resetChrome()
      }
      record("apply.clickToFileWritten", written)
      record("apply.clickToPanelsSettled", panels)
      record("apply.clickToSettled", settled)
    },

    async undo() {
      // Cmd+Z after an edit: keydown → the write after which the host element
      // computes its old value again, watched the way `edit` watches.
      const reverted = []
      for (let r = 0; r < RUNS; r++) {
        const input = await selectForEdit('[data-testid="card-4"] h3')
        const before = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="card-4"] h3')).fontSize)
        await input.fill(r % 2 ? "22" : "24")
        await input.press("Enter")
        await sleep(300)
        await page.evaluate(() => document.activeElement?.blur?.())
        await page.mouse.move(1300, 880)
        await sleep(200)
        await resetInput(page)
        const watch = page.evaluate((px) => new Promise((resolve) => {
          const h3 = document.querySelector('[data-testid="card-4"] h3')
          const observer = new MutationObserver(() => {
            if (window.__perf.input === null || getComputedStyle(h3).fontSize !== px) return
            observer.disconnect()
            resolve(performance.now() - window.__perf.input)
          })
          observer.observe(h3, { attributes: true, attributeFilter: ["style", "class"] })
          observer.observe(document.head, { childList: true, subtree: true, characterData: true })
          setTimeout(() => { observer.disconnect(); resolve(NaN) }, 5000)
        }), before)
        await page.keyboard.press("Meta+z")
        reverted.push(await watch)
        await settleAfterInput(page)
      }
      record("undo.previewReverted", reverted)
    },

    async drag() {
      // Dragging a selected card by its body: main-thread time per pointer
      // move, then undone so the next run starts from the same page.
      const perMove = []
      for (let r = 0; r < RUNS; r++) {
        // From a known chrome: Escape with nothing selected collapses the editor.
        await resetChrome()
        const box = await page.locator('[data-testid="card-2"]').first().boundingBox()
        const x = box.x + 30
        const y = box.y + box.height - 12
        await page.mouse.click(x, y)
        await sleep(300)
        await page.mouse.move(x, y)
        await page.mouse.down()
        const before = await cdpMetrics(cdp)
        const steps = 40
        for (let i = 1; i <= steps; i++) await page.mouse.move(x + i * 2, y + i)
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
        const after = await cdpMetrics(cdp)
        await page.mouse.up()
        perMove.push(delta(after, before, "TaskDuration") / steps)
        if (process.env.PERF_DEBUG && r === 0) {
          const moved = await page.locator('[data-testid="card-2"]').first().boundingBox()
          console.log(`    dragged card from ${box.x.toFixed(0)},${box.y.toFixed(0)} to ${moved.x.toFixed(0)},${moved.y.toFixed(0)}`)
        }
        await sleep(300)
        await page.keyboard.press("Meta+z")
        await sleep(300)
      }
      record("drag.mainThreadPerMove", perMove)
    },

    async idle() {
      // A session's resting state: something selected, a few edits pending.
      const input = await selectForEdit('[data-testid="card-4"] h3')
      for (const size of ["19", "21", "17"]) {
        await input.fill(size)
        await input.press("Enter")
        await sleep(150)
      }
      await page.evaluate(() => document.activeElement?.blur?.())
      await page.mouse.move(1300, 880)
      await sleep(1500)
      const perSecond = []
      for (let r = 0; r < RUNS; r++) {
        const before = await cdpMetrics(cdp)
        await sleep(1000)
        const after = await cdpMetrics(cdp)
        perSecond.push(delta(after, before, "TaskDuration"))
      }
      record("idle.mainThreadPerSecond", perSecond)
    },

  }

  for (const [name, flow] of Object.entries(flows)) {
    if (!wants(name)) continue
    console.log(`\n${name}`)
    try {
      await resetChrome()
      if (PROFILE === name) await cdp.send("Profiler.enable").then(() => cdp.send("Profiler.start"))
      await flow()
      if (PROFILE === name) printProfile((await cdp.send("Profiler.stop")).profile)
    } catch (error) {
      console.log(`  FAIL ${name}: ${error.message.split("\n")[0]}`)
      await page.screenshot({ path: path.join(OUT_DIR, `fail-${name}.png`) }).catch(() => {})
    }
  }
}

/** Self time by function, heaviest first — enough to say where a flow's time went. */
function printProfile(profile) {
  const self = new Map()
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const gaps = profile.timeDeltas ?? []
  profile.samples?.forEach((id, index) => {
    const frame = byId.get(id)?.callFrame
    if (!frame) return
    const where = frame.url ? `${frame.url.split("/").pop()}:${frame.lineNumber + 1}` : ""
    const key = `${frame.functionName || "(anonymous)"} ${where}`.trim()
    self.set(key, (self.get(key) ?? 0) + (gaps[index] ?? 0) / 1000)
  })
  const total = [...self.values()].reduce((a, b) => a + b, 0)
  console.log(`  profile: ${total.toFixed(0)}ms sampled`)
  for (const [key, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`    ${ms.toFixed(1).padStart(7)}ms  ${key}`)
  }
  // Inclusive time too: a cheap function that calls an expensive one is where
  // the fix goes.
  const nodeSelf = new Map()
  profile.samples?.forEach((id, index) => nodeSelf.set(id, (nodeSelf.get(id) ?? 0) + (gaps[index] ?? 0) / 1000))
  const inclusive = new Map()
  const visit = (node, stack) => {
    const frame = node.callFrame
    const key = frame.url ? `${frame.functionName || "(anonymous)"} ${frame.url.split("/").pop()}:${frame.lineNumber + 1}` : null
    let ms = nodeSelf.get(node.id) ?? 0
    for (const child of node.children ?? []) ms += visit(byId.get(child), key ? [...stack, key] : stack)
    // Counted once per call path, so recursion does not double it.
    if (key && !stack.includes(key)) inclusive.set(key, (inclusive.get(key) ?? 0) + ms)
    return ms
  }
  visit(profile.nodes[0], [])
  console.log("  inclusive:")
  for (const [key, ms] of [...inclusive].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`    ${ms.toFixed(1).padStart(7)}ms  ${key}`)
  }
}

/**
 * Returns `phase` ms after the page's next animation frame, so the input sent
 * next lands at a chosen point between two frames.
 *
 * A view transition can only begin on a frame, so its first frame comes after
 * whatever is left of the current one — up to a whole frame that no code
 * decides. Left to the harness's own timing that remainder was systematic, and
 * not the same in both trees (one build's Escape kept landing just before a
 * frame, the other's most of a frame early), which made it most of the
 * difference being measured. The board's opens and closes step through the
 * same phases in both trees instead, so each sees the whole frame.
 */
/** Long enough for a click's response and the 250ms quiet a settle waits for. */
const MAIN_THREAD_WINDOW_MS = 450

const FRAME_PHASES = [0, 4, 8, 12]
async function atFramePhase(page, phase) {
  await page.evaluate((ms) => new Promise((done) => requestAnimationFrame(() => setTimeout(done, ms))), phase)
}

/**
 * Opens canvas view from the toolbar. In the page's clock, from the click:
 * `response` is the open's first frame (its view transition's `ready`), `open`
 * the end of the entrance, `frames` when every frame shows its page.
 */
async function openBoard(page, phase = 0) {
  await page.evaluate(() => { window.__perf.transitions.length = 0 })
  await resetInput(page)
  await atFramePhase(page, phase)
  await page.locator('button[data-de-control="canvas"]').click()
  const times = await page.evaluate(() => new Promise((resolve) => {
    // The toolbar button acts on `click`, the last input of the press.
    const t0 = window.__perf.inputs[window.__perf.inputs.length - 1]
    const out = { response: NaN, frames: NaN, open: NaN }
    const until = performance.now() + 30000
    const tick = () => {
      const now = performance.now()
      if (Number.isNaN(out.response) && window.__perf.transitions.length) out.response = window.__perf.transitions[0] - t0
      if (Number.isNaN(out.open) && document.querySelector("div.de-board")?.dataset.state === "open") {
        out.open = now - t0
        if (Number.isNaN(out.response)) out.response = out.open
      }
      if (Number.isNaN(out.frames)) {
        const frames = [...document.querySelectorAll("div.de-board iframe")]
        const ready = frames.length > 0 && frames.every((f) => {
          try { return f.contentDocument?.readyState === "complete" && f.contentDocument.querySelector('[data-testid="headline"]') } catch { return false }
        })
        if (ready) out.frames = now - t0
      }
      if ((!Number.isNaN(out.open) && !Number.isNaN(out.frames)) || now > until) resolve(out)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }))
  return times
}

/**
 * Closes canvas view with Escape. Answered by the first frame of the close's
 * own transition, the same event as the open's response, and timed the same
 * way: in the page, from the key. (It was timed from Node once, which added
 * the harness's key dispatch and a frame-aligned poll to both trees.)
 */
async function closeBoard(page, phase = 0) {
  await page.evaluate(() => { window.__perf.transitions.length = 0 })
  await resetInput(page)
  await atFramePhase(page, phase)
  await page.keyboard.press("Escape")
  return page.evaluate(() => new Promise((resolve) => {
    const t0 = window.__perf.inputs[window.__perf.inputs.length - 1]
    const until = performance.now() + 10000
    const tick = () => {
      const shut = document.querySelector("div.de-board")?.dataset.state === "closed"
      // Without a transition (reduced motion), the close is its state.
      if (window.__perf.transitions.length) resolve(window.__perf.transitions[0] - t0)
      else if (shut && !document.documentElement.classList.contains("de-vt")) resolve(performance.now() - t0)
      else if (performance.now() > until) resolve(NaN)
      else requestAnimationFrame(tick)
    }
    tick()
  }))
}

/**
 * Edits a card's font size and applies it, timing the click to the toast card
 * it raises. The toaster renders into a shadow root, which the probe's
 * document-wide observer cannot see, so it is watched on its own.
 */
async function toastAfterApply(page, size) {
  const box = await page.locator('[data-testid="card-4"] h3').first().boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 12))
  await sleep(400)
  const input = page.locator('input[data-de-field="type.size"]').first()
  await input.waitFor({ state: "visible", timeout: 5000 })
  await input.fill(size)
  await input.press("Enter")
  await sleep(300)
  await page.locator('.de-panel--right .de-tab:text-is("Changes")').click({ timeout: 5000 })
  const button = page.locator('.de-panel--right button:visible').filter({ hasText: /^\s*(Apply to code|Send to agent)\s*$/ }).first()
  await button.waitFor({ state: "visible", timeout: 5000 })
  await sleep(300)
  await page.evaluate(() => {
    window.__perf.toast = null
    const host = () => document.getElementById("designlayer-toaster")?.shadowRoot ?? null
    const seen = new Set(host()?.querySelectorAll("[data-sonner-toast]") ?? [])
    const look = () => {
      const root = host()
      const fresh = [...(root?.querySelectorAll("[data-sonner-toast]") ?? [])].some((card) => !seen.has(card))
      const clicked = window.__perf.inputs[window.__perf.inputs.length - 1]
      if (fresh && clicked !== undefined && window.__perf.toast === null) window.__perf.toast = performance.now() - clicked
      return root
    }
    // An observer once the toaster's root exists; until then, a short poll.
    const attach = () => {
      const root = look()
      if (window.__perf.toast !== null) return
      if (root) new MutationObserver(look).observe(root, { subtree: true, childList: true })
      else setTimeout(attach, 1)
    }
    attach()
  })
  await resetInput(page)
  await button.click({ timeout: 5000 })
  const ms = await page
    .waitForFunction(() => (window.__perf.toast === null ? null : { ms: window.__perf.toast }), null, { timeout: 5000 })
    .then(async (handle) => (await handle.jsonValue()).ms)
    .catch(() => NaN)
  await sleep(600)
  await page.locator('.de-panel--right .de-tab:text-is("Design")').click({ timeout: 5000 })
  await sleep(300)
  return ms
}

/* ---------- loops shared by the editor and the host-only baseline ---------- */

async function hoverLoop(page, cdp) {
  const perMove = []
  for (let r = 0; r < RUNS; r++) {
    await page.mouse.move(400, 300)
    await sleep(100)
    const before = await cdpMetrics(cdp)
    const steps = 60
    for (let i = 0; i < steps; i++) {
      await page.mouse.move(380 + (i % 20) * 30, 260 + Math.floor(i / 20) * 120)
    }
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const after = await cdpMetrics(cdp)
    perMove.push(delta(after, before, "TaskDuration") / steps)
  }
  return perMove
}

async function scrollLoop(page, cdp) {
  const perFrame = []
  for (let r = 0; r < RUNS; r++) {
    const before = await cdpMetrics(cdp)
    const frames = await page.evaluate(async () => {
      let frames = 0
      const until = performance.now() + 600
      await new Promise((resolve) => {
        const step = () => {
          frames++
          window.scrollBy(0, 40)
          if (performance.now() < until) requestAnimationFrame(step)
          else resolve()
        }
        requestAnimationFrame(step)
      })
      window.scrollTo(0, 0)
      return frames
    })
    const after = await cdpMetrics(cdp)
    perFrame.push(delta(after, before, "TaskDuration") / frames)
  }
  return perFrame
}

/** The same loops on the bare host, so the editor's share can be told apart. */
const hostBaseline = {}
async function measureHostInteraction(appUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  await page.goto(appUrl, { waitUntil: "load" })
  await page.waitForSelector('[data-testid="card-0"]')
  await sleep(500)
  if (wants("hover")) hostBaseline.hover = median(await hoverLoop(page, cdp))
  if (wants("scroll")) hostBaseline.scroll = median(await scrollLoop(page, cdp))
  await context.close()
}

/* ---------- exploration ---------- */

async function exploreChrome(proxyUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(pageProbe, READY_LINE)
  const page = await context.newPage()
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`console.${m.type()}: ${m.text()}`) })
  page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`))
  await page.goto(proxyUrl, { waitUntil: "commit" })
  await waitReady(page)
  await sleep(1500)
  const pick = option("--explore-click", null)
  if (pick) {
    const box = await page.locator(pick).first().boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 12))
    await sleep(1500)
  }
  const scope = option("--explore-scope", "body")
  const outline = await page.evaluate((scope) => {
    const lines = []
    const walk = (node, depth) => {
      if (depth > 14) return
      for (const child of node.children) {
        if (!child.closest("[data-designlayer]") && !child.querySelector?.("[data-designlayer]")) continue
        if (child.tagName === "svg") continue
        const attrs = [...child.attributes]
          .filter((a) => /^(class|aria-label|data-de-[a-z-]+|role|data-state|title)$/.test(a.name))
          .map((a) => `${a.name}="${a.value.slice(0, 60)}"`).join(" ")
        const text = child.children.length === 0 ? (child.textContent ?? "").trim().slice(0, 40) : ""
        lines.push(`${"  ".repeat(depth)}<${child.tagName.toLowerCase()} ${attrs}>${text}`)
        walk(child, depth + 1)
      }
    }
    walk(document.querySelector(scope), 0)
    return lines.join("\n")
  }, scope)
  const file = path.join(OUT_DIR, "chrome-outline.txt")
  fs.writeFileSync(file, outline)
  await page.screenshot({ path: path.join(OUT_DIR, "explore.png") })
  console.log(`outline -> ${path.relative(ROOT, file)} (${outline.split("\n").length} lines)`)
  await context.close()
  return 0
}

/* ---------- reporting ---------- */

/**
 * Measured and printed, but not a speed target, each for a stated reason:
 * the time is the host's, the platform's, or a designed duration, or the
 * route is a sub-millisecond round trip the HTTP stack sets.
 */
const CONTEXT = new Set([
  "node.httpFloor", // Node itself: any HTTP server, spawn to first answer
  "boot.coldReady", "boot.warmReady", // include the host app's own boot
  // Once per bundle version: the reload on which the browser builds the
  // script's code cache (see the boot flow), ~2.7ms of main thread no script
  // of ours can skip; the baseline's uncacheable script never builds one and
  // re-parses ~2.4MB on every load instead. Steady state is the target, and
  // the first reload's render delay and overhead stay targets too.
  "boot.overlayEvalFirstReload",
  "board.openAnimationEnd", // the 560ms enter animation, by design
  // Four boots of the host app; board.framesReadyOverHost is the target.
  "board.framesReady",
  "apply.clickToSettled", // ends with the host's own hot reload re-rendering
  "overlay.bytesDecoded", // the script stays readable; its parse is overlayEval
  "api.libraries", "api.libraries.first", "api.options", "api.options.first",
  "api.icons", "api.icons.first", "api.mcpStatus", "api.mcpStatus.first",
  "api.variants", "api.apps", // repeat calls under 1ms before and after
  // Under 1ms in every baseline run (0.6-1.0ms), of which the round trip
  // itself is ~0.25ms (api.mcpStatus): half of it is the HTTP stack's floor.
  "api.apps.first",
  // Spawn to first answer, and Node alone takes ~45ms of it (node.httpFloor):
  // half the baseline's ~60ms is below that floor. screen.overNode — the same
  // time with the floor taken off — is the target.
  "screen.ready",
])

function report() {
  const clean = Object.fromEntries(Object.entries(metrics).filter(([k]) => !k.startsWith("__")))
  const result = { date: new Date().toISOString(), runs: RUNS, cards: CARDS, metrics: clean }
  if (LABEL) {
    const file = path.join(OUT_DIR, `${LABEL}.json`)
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`)
    console.log(`\nsaved ${path.relative(ROOT, file)}`)
  }
  if (COMPARE) {
    const base = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `${COMPARE}.json`), "utf8")).metrics
    const line = (name, was, now) => {
      const ratio = now.median === 0 ? Infinity : was.median / now.median
      // Halved or better, which also holds for a time that went to zero or
      // below it (an over-floor metric that now beats the floor).
      const mark = CONTEXT.has(name) ? " " : now.median <= was.median / 2 ? "✓" : "✗"
      const shown = ratio === Infinity || now.median <= 0 ? "∞" : ratio.toFixed(2)
      return `${name.padEnd(34)} ${formatValue(was.median, was.unit).padStart(11)} ${formatValue(now.median, now.unit).padStart(11)}  ${shown}x ${mark}`
    }
    const rows = Object.entries(clean).filter(([name, now]) => base[name] && base[name].median !== null && now.median !== null)
    console.log(`\n${"target metric".padEnd(34)} ${"before".padStart(11)} ${"after".padStart(11)}  speedup`)
    for (const [name, now] of rows) if (!CONTEXT.has(name)) console.log(line(name, base[name], now))
    console.log(`\n${"context (not a target)".padEnd(34)}`)
    for (const [name, now] of rows) if (CONTEXT.has(name)) console.log(line(name, base[name], now))
  }
}

function merge() {
  for (const label of MERGE) {
    const saved = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `${label}.json`), "utf8")).metrics
    for (const [name, metric] of Object.entries(saved)) {
      metrics[name] ??= { median: null, unit: metric.unit, samples: [] }
      metrics[name].samples.push(...metric.samples)
    }
  }
  for (const metric of Object.values(metrics)) metric.median = median(metric.samples)
  return 0
}

let code = 1
try {
  code = MERGE ? merge() : await main()
  if (!explore) report()
} catch (error) {
  console.error(`FAIL harness — ${error.stack}`)
} finally {
  await cleanup()
}
process.exit(code)
