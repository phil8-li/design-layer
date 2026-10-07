#!/usr/bin/env node
/**
 * Real-browser end-to-end check of canvas mode (the board of live page frames).
 *
 *   node tools/board-e2e.mjs                   # every scenario, both routers, headless
 *   node tools/board-e2e.mjs --router hash     # only the hash-routed host
 *   node tools/board-e2e.mjs --only zoom       # one scenario (boot runs first)
 *   node tools/board-e2e.mjs --headed          # watch it
 *   node tools/board-e2e.mjs --keep            # leave the temp host apps on disk
 *
 * Two hosts, because "a page" means two different things. The path host
 * routes with pushState (`/pricing`) and links in its nav; the hash host
 * routes off the fragment (`/#/pricing`), navigates with buttons and declares
 * its pages in a `<Routes>` table of data, the way a HashRouter app does. The
 * board once keyed pages by pathname alone and was only ever run against the
 * first kind, so on a hash-routed app it showed one frame of the default
 * route; then it found only the pages the designer had visited. Nobody
 * noticed either until a real prototype showed it.
 *
 * Path scenarios: boot, open, clean-frames, zoom, drag, collapse, live-current,
 * live-other, escape, shortcut, reduced-motion. Hash scenarios: boot,
 * hash-open, clean-frames, hash-live-other, escape. Each prints `ok` / `FAIL`;
 * the exit code is non-zero when any fails. Screenshots land in
 * `.harness/board-e2e/` (gitignored).
 *
 * Why this is a tool and not part of `npm test`: it needs a real React + Vite
 * toolchain (borrowed read-only from DESIGNLAYER_E2E_DEPS by
 * symlink), a Chromium from the globally installed Playwright, and three free
 * local ports. None of that exists in CI or in the JSDOM suites, and a run
 * takes tens of seconds rather than milliseconds.
 *
 * What it stands up per host, all torn down on exit:
 *   1. a throwaway Vite + React SPA in os.tmpdir() with four routes and a
 *      hand-rolled router, so client-side navigation is possible;
 *   2. Vite on a free port;
 *   3. `cli.mjs` against it, on free proxy / ws / MCP ports (MCP via a
 *      designlayer.config.mjs in the temp dir, since it has no CLI flag).
 * Every port is picked fresh, so other DesignLayer instances on the machine
 * (3455, 3456, 5747, ...) are never touched.
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const SHOTS = path.join(ROOT, ".harness", "board-e2e")
// A Vite + React node_modules to borrow, named by DESIGNLAYER_E2E_DEPS.
const DEPS = process.env.DESIGNLAYER_E2E_DEPS

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null
const routerArg = args.includes("--router") ? args[args.indexOf("--router") + 1] : null
const headed = flag("--headed")
const keep = flag("--keep")

const WAIT = 8000 // selector waits: fail fast while the feature is missing
const BOOT_TIMEOUT = 60000
const READY_LINE = "[designlayer] Figma-style overlay ready"

const SEL = {
  toggle: 'button[data-de-control="canvas"]',
  board: "div.de-board",
  frame: "div.de-board-frame",
  currentFrame: 'div.de-board-frame[data-current]:not([data-current="false"])',
  iframe: 'iframe[name^="designlayer-frame:"][data-designlayer-frame]',
  live: "button.de-board-live",
  zoomIn: 'button[data-de-zoom="in"]',
  zoomOut: 'button[data-de-zoom="out"]',
  zoomFit: 'button[data-de-zoom="fit"]',
  zoomValue: "span.de-board-zoom-value",
}

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

let cleaned = false
async function cleanup() {
  if (cleaned) return
  cleaned = true
  await browser?.close().catch(() => {})
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode) continue
    try { process.kill(-child.pid, "SIGTERM") } catch {}
  }
  await sleep(500)
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode) continue
    try { process.kill(-child.pid, "SIGKILL") } catch {}
  }
  for (const dir of tmpDirs) {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true })
    else console.log(`kept host app at ${dir}`)
  }
}

/** Stops one host's processes, so the next host starts on a quiet machine. */
async function stopChildren() {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode) continue
    try { process.kill(-child.pid, "SIGTERM") } catch {}
  }
  await sleep(500)
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

async function waitHttp(url, child, label, timeout = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null) throw new Error(`${label} exited early:\n${child.log}`)
    try {
      const res = await fetch(url)
      if (res.ok) return Date.now() - start
    } catch {}
    await sleep(250)
  }
  throw new Error(`${label} not answering ${url} after ${timeout}ms:\n${child.log}`)
}

/* ---------- the host app ---------- */

const ROUTES = [
  { path: "/", title: "Home", headline: "Welcome home", color: "#2563eb" },
  { path: "/pricing", title: "Pricing", headline: "Simple pricing", color: "#16a34a" },
  { path: "/about", title: "About", headline: "About the team", color: "#db2777" },
  { path: "/settings", title: "Settings", headline: "Your settings", color: "#ea580c" },
]

/** A route of the hash host is the same page behind `/#`. */
const hashRoute = (routePath) => `/#${routePath}`

function writeHost(dir, ports, router) {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  write("package.json", JSON.stringify({
    name: "board-e2e-host",
    private: true,
    type: "module",
    scripts: { dev: "vite" },
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    devDependencies: { vite: "^8.0.0", "@vitejs/plugin-react": "^6.0.0" },
  }, null, 2))
  // `cacheDir` keeps Vite's optimizer out of the borrowed node_modules; the
  // native config loader keeps its temp-bundled config out of it too.
  write("vite.config.js", `import react from "@vitejs/plugin-react"
export default {
  plugins: [react()],
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
  <head><meta charset="utf-8" /><title>board-e2e host</title></head>
  <body style="margin:0;font-family:system-ui,sans-serif">
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`)
  write("src/routes.jsx", `export const routes = ${JSON.stringify(ROUTES, null, 2)}\n`)
  // The hash host routes off the fragment and navigates with buttons, the way
  // a HashRouter app does, and declares its pages in a <Routes> table shaped
  // like React Router's — paths from data, not literals, so no source read can
  // find them — with a redirect in it. Only one in-page link names a route.
  write("src/main.jsx", `import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { routes } from "./routes.jsx"

const HASH = ${JSON.stringify(router === "hash")}

// React Router's shape: <Routes> holds <Route path element> elements and
// renders the one that matches; a <Route> never renders itself.
function Route() {
  throw new Error("A <Route> renders only inside <Routes>")
}
function Routes({ at, children }) {
  const table = [children].flat(Infinity).filter(Boolean)
  const match = table.find((route) => route.props.path === at) ?? table.find((route) => route.props.path === "/")
  return match ? match.props.element : null
}
function Navigate({ to }) {
  useEffect(() => {
    window.location.hash = to
  }, [to])
  return null
}
const here = () => (HASH ? window.location.hash.replace(/^#/, "") || "/" : window.location.pathname)

function usePath() {
  const [path, setPath] = useState(here)
  useEffect(() => {
    if (HASH && !window.location.hash) window.history.replaceState(null, "", "#/")
    const onChange = () => setPath(here())
    window.addEventListener("popstate", onChange)
    window.addEventListener("hashchange", onChange)
    return () => {
      window.removeEventListener("popstate", onChange)
      window.removeEventListener("hashchange", onChange)
    }
  }, [])
  const go = (to) => {
    if (HASH) {
      window.location.hash = to
      return
    }
    window.history.pushState({}, "", to)
    setPath(to)
  }
  return [path, go]
}

function App() {
  const [path, go] = usePath()
  const [count, setCount] = useState(0)
  const page = (route) => <Page route={route} count={count} setCount={setCount} />
  return (
    <>
      <header data-testid="fixed-header" style={{ position: "fixed", top: 0, left: 0, right: 0, height: 56, background: "#111827", color: "white", display: "flex", alignItems: "center", gap: 16, padding: "0 20px", zIndex: 10 }}>
        <strong>Acme</strong>
        {routes.map((r) => HASH ? (
          <button key={r.path} type="button" onClick={() => go(r.path)}>{r.title}</button>
        ) : (
          <a key={r.path} href={r.path} style={{ color: "white" }}
            onClick={(e) => { e.preventDefault(); go(r.path) }}>{r.title}</a>
        ))}
      </header>
      {HASH ? (
        <Routes at={path}>
          {routes.map((r) => <Route key={r.path} path={r.path} element={page(r)} />)}
          <Route path="/start" element={<Navigate to="/pricing" />} />
        </Routes>
      ) : page(routes.find((r) => r.path === path) ?? routes[0])}
    </>
  )
}

function Page({ route, count, setCount }) {
  return (
    <>
      <main style={{ paddingTop: 56, paddingBottom: 48 }}>
        <section data-testid="hero" style={{ background: route.color, color: "white", padding: "96px 32px" }}>
          <h1 data-testid="headline" style={{ margin: 0, fontSize: 48 }}>{route.headline}</h1>
          <p>Route {route.path}</p>
          {HASH && route.path === "/" ? <a href="#/pricing" style={{ color: "white" }}>See pricing</a> : null}
        </section>
        <section style={{ padding: 32 }}>
          <button data-testid="counter" onClick={() => setCount((c) => c + 1)}>Clicked {count}</button>
          {Array.from({ length: 8 }, (_, i) => <p key={i}>{route.title} paragraph {i + 1}.</p>)}
        </section>
      </main>
      <footer data-testid="fixed-footer" style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: 48, background: route.color, color: "white", display: "flex", alignItems: "center", padding: "0 20px" }}>
        Bottom bar — {route.title}
      </footer>
    </>
  )
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>)
`)
  fs.symlinkSync(DEPS, path.join(dir, "node_modules"), "dir")
}

/* ---------- page instrumentation ---------- */

/**
 * Counts WebSocket connections to the vendor ws port from inside the page.
 * Frames report to `window.top`, so a board iframe that boots a second editor
 * shows up in the top window's list.
 */
function wsInstrument(wsPort) {
  const Native = window.WebSocket
  const isTop = window === window.top
  if (isTop) window.__deWs = []
  window.WebSocket = new Proxy(Native, {
    construct(target, argv) {
      const socket = new target(...argv)
      const url = String(argv[0])
      if (url.includes(`:${wsPort}`)) {
        const entry = { url, from: isTop ? "top" : "frame", path: location.pathname, closed: null }
        socket.addEventListener("close", (e) => { entry.closed = { code: e.code, reason: e.reason } })
        try { window.top.__deWs?.push(entry) } catch {}
      }
      return socket
    },
  })
}

/* ---------- scenario plumbing ---------- */

const results = []
function ok(name, detail = "") {
  console.log(`ok ${name}${detail ? ` — ${detail}` : ""}`)
}
class Fail extends Error {}
function check(cond, message) {
  if (!cond) throw new Fail(message)
}

async function waitFor(page, selector, what, timeout = WAIT) {
  try {
    return await page.waitForSelector(selector, { timeout, state: "attached" })
  } catch {
    throw new Fail(`${what}: \`${selector}\` not found after ${timeout}ms`)
  }
}

async function waitUntil(page, fn, arg, what, timeout = WAIT) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 50 })
  } catch {
    // Say where it stopped, not only that it did.
    const seen = await page.evaluate((s) => ({
      deView: document.documentElement.dataset.deView ?? null,
      board: document.querySelector(s.board)?.dataset.state ?? "absent",
      frames: document.querySelectorAll(s.frame).length,
      pressed: document.querySelector(s.toggle)?.getAttribute("aria-pressed") ?? "no button",
    }), SEL).catch(() => null)
    throw new Fail(`${what} (timed out after ${timeout}ms; saw ${JSON.stringify(seen)})`)
  }
}

const boardState = (page) =>
  page.evaluate((sel) => ({
    view: document.documentElement.dataset.deView ?? null,
    state: document.querySelector(sel)?.dataset.state ?? null,
    scale: document.querySelector(sel)?.dataset.scale ?? null,
  }), SEL.board)

let shotPrefix = ""
async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${shotPrefix}${name}.png`) }).catch(() => {})
}

async function openBoard(page) {
  const s = await boardState(page)
  if (s.view === "canvas" && s.state === "open") return
  await (await waitFor(page, SEL.toggle, "toolbar canvas button")).click()
  await waitUntil(page, (sel) => document.querySelector(sel)?.dataset.state === "open", SEL.board,
    "board never reached data-state=open")
}

async function isClosed(page) {
  const s = await boardState(page)
  return s.view !== "canvas" && (s.state === null || s.state === "closed")
}
async function waitClosed(page, what) {
  await waitUntil(page, (sel) => {
    const board = document.querySelector(sel)
    return document.documentElement.dataset.deView !== "canvas" &&
      (!board || board.dataset.state === "closed")
  }, SEL.board, what)
}

async function wsReport(page) {
  return page.evaluate(() => (window.__deWs ?? []).map((e) => ({ ...e })))
}
function openSockets(list) {
  return list.filter((e) => !e.closed)
}

async function zoomReading(page) {
  return page.evaluate(({ board, value, frame }) => {
    const b = document.querySelector(board)
    const f = document.querySelector(frame)?.getBoundingClientRect()
    return {
      scale: b?.dataset.scale ?? null,
      value: document.querySelector(value)?.textContent?.trim() ?? null,
      frameX: f ? Math.round(f.x) : null,
      frameY: f ? Math.round(f.y) : null,
    }
  }, { board: SEL.board, value: SEL.zoomValue, frame: SEL.frame })
}

async function boardCenter(page) {
  const box = await (await waitFor(page, SEL.board, "board")).boundingBox()
  check(box, "board has no box")
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Put the pointer over a frame the way a person does.
 *
 * Frames are `pointer-events: none` on purpose — the board owns the pointer and
 * hit-tests frames itself — so Playwright's element `hover()` refuses them
 * ("the board intercepts pointer events"). Moving the mouse to the frame's box
 * is the real gesture, and it is what reveals the frame's Live button.
 */
async function hoverFrame(page, selector) {
  const frame = await waitFor(page, selector, selector)
  const box = await frame.boundingBox()
  check(box, `${selector} has no box`)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
  await sleep(250)
  return frame
}

/** The headline a board path should show, on either host. */
function headlineFor(boardPath) {
  const routePath = boardPath.startsWith("/#") ? boardPath.slice(2) || "/" : boardPath
  return ROUTES.find((r) => r.path === routePath)?.headline ?? null
}

/**
 * Every frame shows the page its label names.
 *
 * The check a pathname-only board failed without anyone seeing it: on a
 * hash-routed app its one frame was labeled `/`, loaded bare `/`, and showed
 * the default route while the designer was on another page.
 */
async function checkFramesShowTheirPages(page) {
  await waitUntil(page, (sel) => [...document.querySelectorAll(sel)].every((e) => {
    if (e.dataset.loaded !== "true") return false
    try { return Boolean(e.querySelector("iframe").contentDocument?.querySelector('[data-testid="headline"]')) } catch { return false }
  }), SEL.frame, "frames never all rendered a headline", 20000)
  const frames = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => ({
    path: e.dataset.path,
    shows: e.querySelector("iframe").contentDocument?.querySelector('[data-testid="headline"]')?.textContent ?? null,
  })), SEL.frame)
  const wrong = frames.filter((f) => f.shows !== headlineFor(f.path))
  check(!wrong.length, `frames show another page than their label: ${JSON.stringify(wrong.map((f) => ({ ...f, expected: headlineFor(f.path) })))}`)
  return frames
}

/** Where the live page is, fragment included: a hash router's page lives there. */
const where = (page) => {
  const url = new URL(page.url())
  return `${url.pathname}${url.hash}`
}

/** Undo a collapsed editor left behind by an earlier scenario (⌘. brings it back). */
async function ensureChromeShown(page) {
  const hidden = await page.evaluate(() => document.documentElement.classList.contains("designlayer-chrome-hidden"))
  if (hidden) {
    await page.keyboard.press("Meta+Period")
    await sleep(400)
  }
}

/* ---------- scenarios ---------- */

function scenarios(env) {
  const { page, consoleLines } = env
  return {
    async boot() {
      check(env.bootMs !== null, `no "${READY_LINE}" console line within ${BOOT_TIMEOUT}ms`)
      await waitFor(page, ".de-root", "editor root")
      const ws = await wsReport(page)
      check(ws.length === 1, `expected exactly 1 vendor WS connection, saw ${ws.length}: ${JSON.stringify(ws)}`)
      check(!ws[0].closed, `vendor WS closed: ${JSON.stringify(ws[0].closed)}`)
      await shot(page, "before-open")
      return `editor ready ${env.bootMs}ms after navigation, 1 WS to :${env.ports.ws}`
    },

    async open() {
      await waitFor(page, SEL.toggle, "toolbar canvas button")
      check(await isClosed(page), "board already open before the scenario")
      // Sample rAF from just before the click until the board is open.
      await page.evaluate(() => {
        window.__deRaf = { stamps: [], running: true }
        const tick = (t) => {
          window.__deRaf.stamps.push(t)
          if (window.__deRaf.running) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await page.click(SEL.toggle)
      const pressed = await page.getAttribute(SEL.toggle, "aria-pressed")
      await waitUntil(page, (sel) => document.querySelector(sel)?.dataset.state === "open", SEL.board,
        "board never reached data-state=open")
      await sleep(100)
      const stamps = await page.evaluate(() => {
        window.__deRaf.running = false
        return window.__deRaf.stamps
      })
      const t0 = stamps[0]
      const deltas = []
      const lateLong = []
      for (let i = 1; i < stamps.length; i++) {
        const d = stamps[i] - stamps[i - 1]
        deltas.push(d)
        if (d > 50 && stamps[i - 1] - t0 > 100) lateLong.push(Math.round(d))
      }
      const sorted = [...deltas].sort((a, b) => a - b)
      const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1) : "n/a"
      const long = deltas.filter((d) => d > 50).length
      const motion = `rAF p50 ${pct(0.5)}ms p95 ${pct(0.95)}ms max ${sorted.length ? sorted.at(-1).toFixed(1) : "n/a"}ms, ${long} frames >50ms (${lateLong.length} after first 100ms)`
      console.log(`  ${motion}`)

      const s = await boardState(page)
      check(s.view === "canvas", `documentElement.dataset.deView is ${JSON.stringify(s.view)}, expected "canvas"`)
      check(pressed === "true" || (await page.getAttribute(SEL.toggle, "aria-pressed")) === "true",
        "canvas button aria-pressed is not true")
      const sibling = await page.evaluate((sel) => {
        const b = document.querySelector(sel)
        return b?.parentElement === document.body && !!document.querySelector("body > .de-root")
      }, SEL.board)
      check(sibling, "div.de-board is not a <body> child beside .de-root")
      const frames = await page.$$eval(SEL.frame, (els) => els.map((e) => ({
        path: e.dataset.path, current: e.dataset.current, loaded: e.dataset.loaded,
      })))
      check(frames.length >= 4, `expected ≥ 4 frames, found ${frames.length}: ${JSON.stringify(frames)}`)
      const current = await page.$eval(SEL.currentFrame, (e) => e.dataset.path).catch(() => null)
      check(current === "/", `current frame is ${JSON.stringify(current)}, expected "/"`)
      const guarded = await page.$$eval(SEL.frame, (els, iframe) =>
        els.every((e) => e.querySelector(iframe)), SEL.iframe)
      check(guarded, `every frame must contain \`${SEL.iframe}\``)

      await waitUntil(page, (sel) => [...document.querySelectorAll(sel)]
        .every((e) => e.dataset.loaded && e.dataset.loaded !== "false"), SEL.frame,
      "frames never all reported data-loaded", 20000)
      await checkFramesShowTheirPages(page)
      await sleep(1500)
      await shot(page, "open")
      const ws = await wsReport(page)
      check(ws.length === 1 && openSockets(ws).length === 1,
        `frames booted editors: ${ws.length} WS connections: ${JSON.stringify(ws)}`)
      const replaced = consoleLines.filter((l) => /replaced by new connection/.test(l))
      check(!replaced.length, `console mentions a replaced connection: ${replaced[0]}`)
      check(!lateLong.length, `frames >50ms after the first 100ms: ${lateLong.join(", ")}ms (${motion})`)
      return `${frames.length} frames, current "/", 1 WS, ${motion}`
    },

    // A frame is a picture of the PAGE: nothing the editor side draws may be in
    // it — not the chrome, not the vendor overlay, not a companion.
    async "clean-frames"() {
      await openBoard(page)
      await waitUntil(page, (sel) => [...document.querySelectorAll(sel)].every((e) => e.dataset.loaded === "true"),
        SEL.frame, "frames never all loaded", 20000)
      const report = await page.evaluate((iframeSel) => [...document.querySelectorAll(iframeSel)].map((iframe) => {
        const win = iframe.contentWindow
        const doc = iframe.contentDocument
        if (!doc || !win) return { path: iframe.name, error: "no document" }
        const visible = [...doc.querySelectorAll('.de-root, [data-designlayer], #react-rewrite-root, .de-toolbar, .de-panel')]
          .filter((node) => win.getComputedStyle(node).display !== "none")
        return {
          path: iframe.name,
          editorBooted: Boolean(win.__DESIGNLAYER_CONFIG__) || typeof win.ReactRewrite !== "undefined",
          visibleUi: visible.map((node) => node.className || node.id || node.tagName).slice(0, 3),
          cleaned: Boolean(doc.getElementById("designlayer-frame-clean")),
        }
      }), SEL.iframe)
      const dirty = report.filter((r) => r.error || r.editorBooted || r.visibleUi.length)
      check(!dirty.length, `frames carry editor UI: ${JSON.stringify(dirty)}`)
      check(report.every((r) => r.cleaned), `a frame was not given the clean-up style: ${JSON.stringify(report)}`)
      return `${report.length} frames, no editor booted, no DesignLayer UI rendered`
    },

    async zoom() {
      await openBoard(page)
      const center = await boardCenter(page)
      const before = await zoomReading(page)
      check(before.scale !== null, "board has no data-scale")
      await waitFor(page, SEL.zoomValue, "zoom value")

      await page.mouse.move(center.x, center.y)
      await page.keyboard.down("Control")
      await page.mouse.wheel(0, -300)
      await page.keyboard.up("Control")
      await sleep(400)
      const wheeled = await zoomReading(page)
      check(wheeled.scale !== before.scale && wheeled.value !== before.value,
        `ctrl+wheel did not zoom: ${JSON.stringify(before)} -> ${JSON.stringify(wheeled)}`)
      await shot(page, "zoomed")

      // In, out, then in again before Fit: after an in/out pair the camera can
      // be back at the fitted scale, and a Fit that has nothing to undo would
      // prove nothing.
      const readings = { wheel: wheeled.value }
      for (const [name, sel] of [["in", SEL.zoomIn], ["out", SEL.zoomOut], ["in again", SEL.zoomIn], ["fit", SEL.zoomFit]]) {
        const prev = await zoomReading(page)
        await (await waitFor(page, sel, `zoom ${name} button`)).click()
        // Fit tweens for 400ms and data-scale is written when input settles
        // 120ms later, so read after both.
        await sleep(750)
        const next = await zoomReading(page)
        check(next.scale !== prev.scale, `zoom ${name} did not change data-scale (${prev.scale})`)
        readings[name] = next.value
      }

      const beforePan = await zoomReading(page)
      await page.mouse.move(center.x, center.y)
      await page.mouse.wheel(120, 200)
      await sleep(400)
      const panned = await zoomReading(page)
      check(panned.scale === beforePan.scale, `plain wheel changed scale ${beforePan.scale} -> ${panned.scale}`)
      check(panned.frameX !== beforePan.frameX || panned.frameY !== beforePan.frameY,
        `plain wheel did not pan (first frame stayed at ${beforePan.frameX},${beforePan.frameY})`)
      return `${before.value} → wheel ${readings.wheel}, in ${readings.in}, out ${readings.out}, fit ${readings.fit}; pan moved frame`
    },

    // Dragging moves what is ON the board, never the board. The board is the
    // ground under the frames: moved off the canvas rect, it shows the live page
    // round its edges.
    async drag() {
      if (!(await isClosed(page))) {
        await page.keyboard.press("Escape")
        await waitClosed(page, "could not close the board before the scenario")
      }
      const read = () => page.evaluate(({ board, frame }) => {
        const b = document.querySelector(board)
        const r = b.getBoundingClientRect()
        const f = document.querySelector(frame)?.getBoundingClientRect()
        const layer = document.querySelector("[data-react-rewrite-interaction]")
        return {
          rect: [r.x, r.y, r.width, r.height].map(Math.round),
          frame: f ? [Math.round(f.x), Math.round(f.y)] : null,
          focused: document.activeElement === b,
          vendorLayer: layer ? getComputedStyle(layer).pointerEvents : null,
        }
      }, { board: SEL.board, frame: SEL.frame })
      // Opened from the toolbar, which is where focus is left by a click.
      await (await waitFor(page, SEL.toggle, "toolbar canvas button")).click()
      await waitUntil(page, (sel) => document.querySelector(sel)?.dataset.state === "open", SEL.board,
        "board never reached data-state=open")
      await sleep(300)
      const opened = await read()
      check(opened.focused, "the board did not take focus from the toolbar button")
      const box = await (await waitFor(page, SEL.board, "board")).boundingBox()
      // The fitted board leaves air around the frames, so a corner is empty ground.
      const start = { x: box.x + 24, y: box.y + 24 }

      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(start.x + 150, start.y + 90, { steps: 10 })
      await page.mouse.up()
      await sleep(200)
      const plain = await read()
      check(JSON.stringify(plain.rect) === JSON.stringify(opened.rect), `a plain drag moved the board: ${JSON.stringify(opened)} -> ${JSON.stringify(plain)}`)

      // Space+drag straight after the click: the board's pan, not the vendor's,
      // and not a press of the Canvas button that still had focus.
      await page.mouse.move(start.x, start.y)
      await page.keyboard.down("Space")
      await sleep(50)
      const held = await read()
      await page.mouse.down()
      await page.mouse.move(start.x + 120, start.y + 60, { steps: 10 })
      await page.mouse.up()
      await page.keyboard.up("Space")
      await sleep(200)
      const panned = await read()
      const s = await boardState(page)
      check(s.state === "open", `Space closed the board: ${JSON.stringify(s)}`)
      check(held.vendorLayer !== "auto", "the vendor's pan layer went up over the board while Space was held")
      check(JSON.stringify(panned.rect) === JSON.stringify(opened.rect), `Space+drag moved the board: ${JSON.stringify(panned)}`)
      check(panned.frame[0] - plain.frame[0] === 120 && panned.frame[1] - plain.frame[1] === 60,
        `Space+drag did not pan the frames by the drag: ${JSON.stringify(plain.frame)} -> ${JSON.stringify(panned.frame)}`)

      // Another tool writing a transform or an offset onto the board, the way a
      // drag preview or an element-moving extension does: taken back before it paints.
      const shifted = await page.evaluate((sel) => new Promise((resolve) => {
        const b = document.querySelector(sel)
        b.style.transform = "translate(-162px, 40px)"
        b.style.setProperty("top", "40px", "important")
        requestAnimationFrame(() => {
          const r = b.getBoundingClientRect()
          resolve({ rect: [r.x, r.y, r.width, r.height].map(Math.round), style: b.getAttribute("style") })
        })
      }), SEL.board)
      check(JSON.stringify(shifted.rect) === JSON.stringify(opened.rect),
        `a foreign transform moved the board: ${JSON.stringify(shifted)}`)
      await shot(page, "dragged")
      await page.keyboard.press("Escape")
      await waitClosed(page, "Escape did not close after the drag scenario")
      return `board stayed at ${JSON.stringify(opened.rect)} through a drag, Space+drag (+120,+60) and a foreign transform`
    },

    // Collapsing the editor (⌘.) keeps canvas view: the board grows into the
    // room the panels gave up and its frames are laid out again at that width.
    async collapse() {
      await openBoard(page)
      const viewport = page.viewportSize()
      await page.keyboard.press("Meta+Period")
      await sleep(900)
      const hidden = await page.evaluate(() => document.documentElement.classList.contains("designlayer-chrome-hidden"))
      check(hidden, "⌘. did not collapse the editor")
      const s = await boardState(page)
      check(s.view === "canvas" && s.state === "open", `collapsing left canvas view: ${JSON.stringify(s)}`)
      const box = await (await waitFor(page, SEL.board, "board")).boundingBox()
      check(Math.round(box.x) === 0 && Math.round(box.width) === viewport.width,
        `board did not grow to the window: ${JSON.stringify(box)}`)
      const frameWidth = await page.$eval(SEL.frame, (e) => Number.parseFloat(e.style.width))
      check(Math.abs(frameWidth - viewport.width) < 2, `frames not re-laid at ${viewport.width}px: ${frameWidth}`)
      const overlap = await page.evaluate(() => {
        const zoom = document.querySelector(".de-board-zoom")?.getBoundingClientRect()
        const disc = document.querySelector(".de-launcher")?.getBoundingClientRect()
        if (!zoom || !disc || !disc.width) return false
        return !(zoom.right <= disc.left || disc.right <= zoom.left || zoom.bottom <= disc.top || disc.bottom <= zoom.top)
      })
      check(!overlap, "the zoom control sits under the collapsed editor's disc")
      await shot(page, "collapsed-canvas")
      await page.keyboard.press("Meta+Period")
      await sleep(900)
      const back = await boardState(page)
      check(back.view === "canvas" && back.state === "open", `bringing the editor back left canvas view: ${JSON.stringify(back)}`)
      const narrowed = await page.$eval(SEL.frame, (e) => Number.parseFloat(e.style.width))
      check(narrowed < viewport.width - 100, `frames did not narrow again when the panels came back: ${narrowed}`)
      await page.keyboard.press("Escape")
      await waitClosed(page, "Escape did not close after the collapse scenario")
      return `board ${Math.round(box.width)}px wide while collapsed, frames ${Math.round(frameWidth)} → ${Math.round(narrowed)}px`
    },

    async "live-current"() {
      await openBoard(page)
      await hoverFrame(page, SEL.currentFrame)
      const live = await waitFor(page, `${SEL.live}[data-path="/"]`, "current frame Live button")
      const opacity = await live.evaluate((e) => Number(getComputedStyle(e).opacity))
      check(opacity > 0.5, `Live button opacity on hover is ${opacity}`)
      const label = await live.getAttribute("aria-label")
      check(label === "Open / live", `Live button aria-label is ${JSON.stringify(label)}`)
      await live.click()
      await waitClosed(page, "board did not close after clicking the current frame's Live button")
      const s = await boardState(page)
      const url = new URL(page.url())
      check(url.pathname === "/", `URL is ${url.pathname}, expected /`)
      check(await page.$(".de-root"), "editor chrome (.de-root) missing after closing")
      // Inspect mode (the default) takes every click, so the app only gets one
      // in interactive mode: flip the mode switch, click, flip it back.
      const mode = ".de-button--mode"
      const inspecting = (await page.getAttribute(mode, "aria-pressed").catch(() => null)) === "true"
      if (inspecting) await page.click(mode)
      const counter = page.locator('[data-testid="counter"]')
      const beforeText = await counter.textContent()
      await counter.click()
      await sleep(200)
      const afterText = await counter.textContent()
      if (inspecting) await page.click(mode)
      check(beforeText !== afterText, `app not interactive: counter stayed "${afterText}"`)
      return `deView ${JSON.stringify(s.view)}, URL /, counter "${beforeText}" -> "${afterText}"`
    },

    async "live-other"() {
      await page.evaluate(() => (window.__deBoardMarker = true))
      await openBoard(page)
      await hoverFrame(page, `${SEL.frame}[data-path="/pricing"]`)
      const live = await waitFor(page, `${SEL.live}[data-path="/pricing"]`, "/pricing Live button")
      await live.click()
      await waitClosed(page, "board did not close after clicking /pricing's Live button", 12000)
      await page.waitForURL((u) => new URL(u).pathname === "/pricing", { timeout: WAIT })
        .catch(() => { throw new Fail(`URL is ${new URL(page.url()).pathname}, expected /pricing`) })
      const headline = await page.locator('[data-testid="headline"]').textContent({ timeout: WAIT }).catch(() => null)
      check(headline === "Simple pricing", `live page headline is ${JSON.stringify(headline)}, expected "Simple pricing"`)
      await waitFor(page, ".de-root", "editor chrome after navigating")
      const clientSide = await page.evaluate(() => window.__deBoardMarker === true)
      if (!clientSide) {
        await page.waitForEvent("console", { predicate: (m) => m.text().includes(READY_LINE), timeout: 30000 }).catch(() => {})
      }
      await sleep(500)
      await shot(page, "after-live-other")
      const ws = await wsReport(page)
      check(openSockets(ws).length === 1, `expected 1 open vendor WS, saw ${JSON.stringify(ws)}`)
      if (clientSide) check(ws.length === 1, `client-side nav opened extra WS connections: ${JSON.stringify(ws)}`)
      return `URL /pricing, headline "${headline}", ${clientSide ? "client-side" : "FULL-PAGE (not client-side)"} navigation, 1 WS`
    },

    // Hash host: the page on screen is a route in the fragment, reached with
    // buttons, and the route table is data no source read can find — so every
    // page on the board has to come from the running app's own <Routes>.
    async "hash-open"() {
      check(await isClosed(page), "board already open before the scenario")
      // What the app's buttons do; inspect mode would take a click on them.
      await page.evaluate(() => { window.location.hash = "/settings" })
      await page.waitForFunction((h) => document.querySelector('[data-testid="headline"]')?.textContent === h,
        headlineFor("/settings"), { timeout: WAIT }).catch(() => { throw new Fail("the app did not route to #/settings") })
      await openBoard(page)
      const current = await page.$eval(SEL.currentFrame, (e) => e.dataset.path).catch(() => null)
      check(current === hashRoute("/settings"), `current frame is ${JSON.stringify(current)}, expected "${hashRoute("/settings")}"`)
      const frames = await checkFramesShowTheirPages(page)
      const paths = frames.map((f) => f.path)
      for (const expected of ROUTES.map((r) => hashRoute(r.path))) {
        check(paths.includes(expected), `no frame for ${expected}, a page in the app's route table: ${JSON.stringify(paths)}`)
      }
      check(!paths.includes(hashRoute("/start")), `a route that only redirects is on the board: ${JSON.stringify(paths)}`)
      check(!paths.includes("/"), `the bare document, which only redirects, is on the board: ${JSON.stringify(paths)}`)
      await shot(page, "open")
      const ws = await wsReport(page)
      check(ws.length === 1 && openSockets(ws).length === 1, `frames booted editors: ${JSON.stringify(ws)}`)
      return `${paths.length} frames (${paths.join(", ")}), current ${current}, each showing its own route`
    },

    async "hash-live-other"() {
      await page.evaluate(() => (window.__deBoardMarker = true))
      await openBoard(page)
      const target = hashRoute("/about")
      await hoverFrame(page, `${SEL.frame}[data-path="${target}"]`)
      const live = await waitFor(page, `${SEL.live}[data-path="${target}"]`, `${target} Live button`)
      await live.click()
      await waitClosed(page, `board did not close after clicking ${target}'s Live button`, 12000)
      check(where(page) === target, `URL is ${where(page)}, expected ${target}`)
      const headline = await page.locator('[data-testid="headline"]').textContent({ timeout: WAIT }).catch(() => null)
      check(headline === "About the team", `live page headline is ${JSON.stringify(headline)}, expected "About the team"`)
      check(await page.evaluate(() => window.__deBoardMarker === true), "the live page reloaded instead of routing the hash")
      const ws = await wsReport(page)
      check(ws.length === 1 && openSockets(ws).length === 1, `expected the one vendor WS, saw ${JSON.stringify(ws)}`)
      await shot(page, "after-live-other")
      return `URL ${target}, headline "${headline}", client-side, 1 WS`
    },

    async escape() {
      if (!(await isClosed(page))) await page.keyboard.press("Escape")
      await (await waitFor(page, SEL.toggle, "toolbar canvas button")).click()
      await sleep(250)
      await shot(page, "mid-open")
      await waitUntil(page, (sel) => document.querySelector(sel)?.dataset.state === "open", SEL.board,
        "board never reached data-state=open")
      const pathBefore = where(page)
      await page.keyboard.press("Escape")
      await waitClosed(page, "Escape did not close the board")
      const pathAfter = where(page)
      check(pathAfter === pathBefore, `Escape changed the URL ${pathBefore} -> ${pathAfter}`)
      return `closed, still on ${pathAfter}`
    },

    async shortcut() {
      if (!(await isClosed(page))) {
        await page.keyboard.press("Escape")
        await waitClosed(page, "could not close the board before the scenario")
      }
      await page.mouse.click(5, 300) // focus the page, not an input
      await page.keyboard.press("Shift+Digit1")
      await waitUntil(page, (sel) => document.querySelector(sel)?.dataset.state === "open", SEL.board,
        "⇧1 did not open the board")
      const center = await boardCenter(page)
      await page.mouse.move(center.x, center.y)
      await page.mouse.wheel(300, 300) // pan away so fit has something to undo
      await page.keyboard.down("Control")
      await page.mouse.wheel(0, -200)
      await page.keyboard.up("Control")
      await sleep(400)
      const moved = await zoomReading(page)
      await page.keyboard.press("Shift+Digit1")
      await sleep(600)
      const s = await boardState(page)
      check(s.view === "canvas" && s.state === "open", `second ⇧1 closed the board: ${JSON.stringify(s)}`)
      const fitted = await zoomReading(page)
      check(JSON.stringify(fitted) !== JSON.stringify(moved),
        `second ⇧1 did not fit: view unchanged ${JSON.stringify(fitted)}`)
      await page.keyboard.press("Escape")
      await waitClosed(page, "Escape did not close after the shortcut scenario")
      return `open, then fit (${moved.value} → ${fitted.value})`
    },

    async "reduced-motion"() {
      const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } })
      await context.addInitScript(wsInstrument, env.ports.ws)
      try {
        const rm = await context.newPage()
        const ready = rm.waitForEvent("console", { predicate: (m) => m.text().includes(READY_LINE), timeout: BOOT_TIMEOUT })
        await rm.goto(env.url)
        await ready.catch(() => { throw new Fail("editor did not boot in the reduced-motion context") })
        await openBoard(rm)
        await rm.keyboard.press("Escape")
        await waitClosed(rm, "Escape did not close under reduced motion")
        await (await waitFor(rm, SEL.toggle, "toolbar canvas button")).click()
        await waitUntil(rm, (sel) => document.querySelector(sel)?.dataset.state === "open", SEL.board,
          "second open under reduced motion failed")
        await rm.click(SEL.toggle)
        await waitClosed(rm, "toolbar button did not close under reduced motion")
        return "open/close via button and Escape"
      } finally {
        await context.close()
      }
    },
  }
}

/* ---------- main ---------- */

/** Which scenarios run against which host; `boot` always runs first. */
const PASSES = {
  path: ["boot", "open", "clean-frames", "zoom", "drag", "collapse", "live-current", "live-other", "escape", "shortcut", "reduced-motion"],
  hash: ["boot", "hash-open", "clean-frames", "hash-live-other", "escape"],
}

async function runHost(router) {
  console.log(`\n── ${router}-routed host ──`)
  shotPrefix = router === "path" ? "" : `${router}-`
  const ports = { app: await freePort(), proxy: await freePort(), ws: await freePort(), mcp: await freePort() }
  console.log(`ports: app ${ports.app}, proxy ${ports.proxy}, ws ${ports.ws}, mcp ${ports.mcp}`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `designlayer-board-e2e-${router}-`))
  tmpDirs.push(tmpDir)
  writeHost(tmpDir, ports, router)

  const vite = run(process.execPath,
    ["node_modules/vite/bin/vite.js", "--port", String(ports.app), "--strictPort", "--configLoader", "native"],
    { cwd: tmpDir, env: { ...process.env, BROWSER: "none" } })
  const viteMs = await waitHttp(`http://127.0.0.1:${ports.app}/`, vite, "vite")

  const cli = run(process.execPath,
    [path.join(ROOT, "cli.mjs"), String(ports.app),
      "--project-root", tmpDir, "--config", path.join(tmpDir, "designlayer.config.mjs"),
      "--proxy-port", String(ports.proxy), "--ws-port", String(ports.ws), "--no-open", "--no-start"],
    { cwd: tmpDir })
  const url = `http://127.0.0.1:${ports.proxy}/`
  const cliMs = await waitHttp(url, cli, "designlayer proxy")
  console.log(`vite up in ${viteMs}ms, proxy up in ${cliMs}ms`)

  browser ??= await chromium.launch({ headless: !headed })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(wsInstrument, ports.ws)
  const page = await context.newPage()
  const consoleLines = []
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`))

  const env = { page, consoleLines, ports, url, bootMs: null }
  const navStart = Date.now()
  const ready = page.waitForEvent("console", { predicate: (m) => m.text().includes(READY_LINE), timeout: BOOT_TIMEOUT })
  await page.goto(url)
  env.bootMs = await ready.then(() => Date.now() - navStart, () => null)
  await sleep(500) // let the WS settle before counting

  const table = scenarios(env)
  const planned = PASSES[router]
  const selected = !only ? planned : planned.includes(only) ? ["boot", ...(only === "boot" ? [] : [only])] : []
  // A scenario whose open state leaks into the next is closed between runs.
  for (const name of selected) {
    const start = Date.now()
    try {
      // One scenario's failure must not leave the next with a collapsed editor.
      await ensureChromeShown(page)
      const detail = await table[name]()
      ok(name, `${detail} (${Date.now() - start}ms)`)
      results.push({ name: `${router}:${name}`, pass: true })
    } catch (error) {
      console.log(`FAIL ${name} — ${error instanceof Fail ? error.message : error.stack}`)
      results.push({ name: `${router}:${name}`, pass: false })
      await shot(page, `fail-${name}`)
      if (!(await isClosed(page).catch(() => true))) await page.keyboard.press("Escape").catch(() => {})
    }
  }

  const errors = consoleLines.filter((l) => /^(error|pageerror)/.test(l))
  if (errors.length) console.log(`console errors (${errors.length}):\n  ${errors.slice(0, 5).join("\n  ")}`)
  await context.close()
  await stopChildren()
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  const routers = routerArg ? [routerArg] : Object.keys(PASSES)
  for (const router of routers) {
    if (!PASSES[router]) throw new Error(`unknown router "${router}"; one of ${Object.keys(PASSES).join(", ")}`)
  }
  if (only && !routers.some((router) => PASSES[router].includes(only))) {
    throw new Error(`unknown scenario "${only}"; one of ${[...new Set(routers.flatMap((r) => PASSES[r]))].join(", ")}`)
  }
  for (const router of routers) await runHost(router)
  const failed = results.filter((r) => !r.pass)
  if (failed.length) console.log(`\nfailed: ${failed.map((r) => r.name).join(", ")}`)
  console.log(`\n${results.length - failed.length}/${results.length} passed; screenshots in ${path.relative(ROOT, SHOTS)}/`)
  return failed.length ? 1 : 0
}

let code = 1
try {
  code = await main()
} catch (error) {
  console.error(`FAIL harness — ${error.message}`)
} finally {
  await cleanup()
}
process.exit(code)
