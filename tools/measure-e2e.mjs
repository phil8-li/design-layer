#!/usr/bin/env node
/**
 * Real-browser end-to-end check of the Alt/Option spacing readout.
 *
 *   node tools/measure-e2e.mjs              # build the bundle, then run headless
 *   node tools/measure-e2e.mjs --no-build   # reuse dist/designlayer.js as it is
 *   node tools/measure-e2e.mjs --headed     # watch it
 *   node tools/measure-e2e.mjs --keep       # leave the temp host app on disk
 *
 * With one element selected, holding Alt while hovering another paints red
 * lines (`.de-guide`), red number badges (`.de-badge--measure`) and dashed
 * extensions (`.de-guide--dashed-x/-y`) in the overlay. The unit cases in
 * test/measure-cases.mjs pin the geometry; this pins the wiring: that Alt is
 * seen at all, that the painter reacts to it without a pointer move, that the
 * numbers on screen match the page, and that letting go clears them.
 *
 * Harness copied from tools/board-e2e.mjs: a throwaway Vite + React host in
 * os.tmpdir() (node_modules borrowed by symlink from DESIGNLAYER_E2E_DEPS), Vite and
 * `cli.mjs` on fresh free ports, so no running editor's single-client socket
 * is touched. The fixture is one container with three absolutely placed boxes
 * of known geometry (CSS px, inside a 600×400 border-box container):
 *
 *   A  left 40  top 50   120×80   → insets 40 / 50 / 440 / 270
 *   B  left 200 top 70   100×80   → right of A, gap 40, rows overlap
 *   C  left 300 top 230  80×60    → diagonal from A: x gap 140, y gap 100
 *
 * Screenshots land in `.demos/measure/` (gitignored).
 */

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const SHOTS = path.join(ROOT, ".demos", "measure")
// A Vite + React node_modules to borrow, named by DESIGNLAYER_E2E_DEPS.
const DEPS = process.env.DESIGNLAYER_E2E_DEPS

const args = process.argv.slice(2)
const headed = args.includes("--headed")
const keep = args.includes("--keep")
const noBuild = args.includes("--no-build")

const WAIT = 8000
const BOOT_TIMEOUT = 60000
// ms after each input. Guides hide at once (`display 0s`), but `.de-badge`
// fades out over the exit duration (150ms) with `display` riding along
// allow-discrete, so a badge that was just hidden still computes as shown
// until then.
const SETTLE = Number(process.env.MEASURE_SETTLE ?? 250)
const READY_LINE = "[designlayer] Figma-style overlay ready"

const BOX = {
  container: { width: 600, height: 400 },
  a: { left: 40, top: 50, width: 120, height: 80, color: "#2563eb" },
  b: { left: 200, top: 70, width: 100, height: 80, color: "#16a34a" },
  c: { left: 300, top: 230, width: 80, height: 60, color: "#db2777" },
}

/* ---------- processes and cleanup (from board-e2e) ---------- */

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
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode) continue
      try { process.kill(-child.pid, signal) } catch {}
    }
    await sleep(500)
  }
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

function writeHost(dir, ports) {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  write("package.json", JSON.stringify({
    name: "measure-e2e-host",
    private: true,
    type: "module",
    scripts: { dev: "vite" },
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    devDependencies: { vite: "^8.0.0", "@vitejs/plugin-react": "^6.0.0" },
  }, null, 2))
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
  <head><meta charset="utf-8" /><title>measure-e2e host</title></head>
  <body style="margin:0;font-family:system-ui,sans-serif">
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`)
  write("src/main.jsx", `import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

const BOX = ${JSON.stringify(BOX)}

function Box({ id, spec }) {
  return (
    <div data-testid={id} style={{ position: "absolute", left: spec.left, top: spec.top, width: spec.width, height: spec.height, background: spec.color, color: "white", display: "grid", placeItems: "center", fontWeight: 600 }}>
      {id.toUpperCase()}
    </div>
  )
}

function App() {
  return (
    <main style={{ padding: 80 }}>
      <section data-testid="container" style={{ position: "relative", boxSizing: "border-box", width: BOX.container.width, height: BOX.container.height, padding: 24, background: "#f3f4f6" }}>
        <Box id="a" spec={BOX.a} />
        <Box id="b" spec={BOX.b} />
        <Box id="c" spec={BOX.c} />
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>)
`)
  fs.symlinkSync(DEPS, path.join(dir, "node_modules"), "dir")
}

/* ---------- reading the overlay ---------- */

const results = []
class Fail extends Error {}
function check(cond, message) {
  if (!cond) throw new Fail(message)
}

/** Every visible measure node, with the geometry the painter wrote. */
const readOverlay = (page) => page.evaluate(() => {
  const shown = (node) => getComputedStyle(node).display !== "none"
  const geom = (node) => {
    const r = node.getBoundingClientRect()
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), transform: node.style.transform }
  }
  const all = (sel) => [...document.querySelectorAll(sel)].filter(shown)
  return {
    badges: all(".de-badge.de-badge--measure").map((n) => ({ text: n.textContent.trim(), ...geom(n) })),
    lines: all(".de-guide:not(.de-guide--dashed-x):not(.de-guide--dashed-y)").map(geom),
    dashes: all(".de-guide--dashed-x, .de-guide--dashed-y").map((n) => ({ axis: n.classList.contains("de-guide--dashed-x") ? "x" : "y", ...geom(n) })),
    hover: all(".de-outline--hover").map(geom),
  }
})

const rectOf = (page, id) => page.$eval(`[data-testid="${id}"]`, (n) => {
  const r = n.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
})

const centerOf = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })

/** The page may be drawn at a zoom; a readout reports CSS px, so scale expectations by it. */
async function pageScale(page) {
  const r = await rectOf(page, "container")
  return r.width / BOX.container.width
}

const texts = (overlay) => overlay.badges.map((b) => b.text).sort((x, y) => Number(x) - Number(y))
const fmt = (v) => String(Math.round(v * 10) / 10)
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol

/* ---------- scenarios ---------- */

function scenarios(page) {
  let a, b, c, container, scale

  const hover = async (r) => {
    const p = centerOf(r)
    await page.mouse.move(p.x, p.y, { steps: 4 })
    await sleep(SETTLE)
  }
  // A failed scenario releases Alt (see main), so each scenario that needs it
  // held asks for it rather than inheriting it, and one failure cannot cascade.
  let altHeld = false
  const altDown = async () => { await page.keyboard.down("Alt"); altHeld = true; await sleep(SETTLE) }
  const altUp = async () => { await page.keyboard.up("Alt"); altHeld = false; await sleep(SETTLE) }
  const ensureAlt = async () => { if (!altHeld) await altDown() }
  page.on("measure:alt-released", () => (altHeld = false))
  /** Badge values the page geometry predicts, in the units the readout shows. */
  const expect = (cssValues) => cssValues.map((v) => fmt(v * scale)).sort((x, y) => Number(x) - Number(y))

  return {
    async "1 no alt, no readout"() {
      a = await rectOf(page, "a")
      b = await rectOf(page, "b")
      c = await rectOf(page, "c")
      container = await rectOf(page, "container")
      scale = await pageScale(page)
      await hover(a)
      await page.mouse.click(centerOf(a).x, centerOf(a).y)
      await sleep(300)
      const selected = await page.evaluate(() => [...document.querySelectorAll(".de-outline:not(.de-outline--hover):not(.de-outline--related)")]
        .filter((n) => getComputedStyle(n).display !== "none").map((n) => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round) }))
      check(selected.some(([x, y, w, h]) => near(x, a.left, 2) && near(y, a.top, 2) && near(w, a.width, 2) && near(h, a.height, 2)),
        `clicking A did not select it; selection outlines ${JSON.stringify(selected)}, A ${JSON.stringify(a)}`)
      await hover(b)
      const o = await readOverlay(page)
      check(o.badges.length === 0, `measure badges visible without Alt: ${JSON.stringify(o.badges)}`)
      return `A selected (page scale ${scale}), hovering B without Alt shows 0 badges`
    },

    async "2 alt + hover B: gap"() {
      await page.mouse.move(5, 5)
      await sleep(SETTLE)
      await altDown()
      await hover(b)
      const o = await readOverlay(page)
      await page.screenshot({ path: path.join(SHOTS, "2-alt-hover-b.png") })
      const want = expect([BOX.b.left - (BOX.a.left + BOX.a.width)])
      check(o.badges.length === 1 && texts(o)[0] === want[0],
        `expected one badge ${JSON.stringify(want)}, saw ${JSON.stringify(o)}`)
      const span = o.lines.find((l) => l.h <= 1.5 && near(l.x, a.right) && near(l.x + l.w, b.left))
      check(span, `no horizontal .de-guide from A.right ${a.right} to B.left ${b.left}; lines ${JSON.stringify(o.lines)}`)
      const rowTop = Math.max(a.top, b.top), rowBottom = Math.min(a.bottom, b.bottom)
      check(span.y >= rowTop && span.y <= rowBottom, `gap line y ${span.y} outside the shared rows ${rowTop}–${rowBottom}`)
      return `badge "${o.badges[0].text}", line x ${span.x}→${+(span.x + span.w).toFixed(1)} at y ${span.y}`
    },

    async "3 alt + hover C: two gaps, dashed"() {
      await ensureAlt()
      await hover(c)
      const o = await readOverlay(page)
      await page.screenshot({ path: path.join(SHOTS, "3-alt-hover-c.png") })
      const want = expect([BOX.c.left - (BOX.a.left + BOX.a.width), BOX.c.top - (BOX.a.top + BOX.a.height)])
      check(JSON.stringify(texts(o)) === JSON.stringify(want), `expected badges ${JSON.stringify(want)}, saw ${JSON.stringify(o)}`)
      check(o.dashes.length >= 1, `no visible dashed extension; overlay ${JSON.stringify(o)}`)
      return `badges ${texts(o).join(", ")}, ${o.dashes.length} dashed (${o.dashes.map((d) => d.axis).join(", ")})`
    },

    async "4 alt + hover A: insets"() {
      await ensureAlt()
      await hover(a)
      const o = await readOverlay(page)
      const want = expect([
        BOX.a.left,
        BOX.a.top,
        BOX.container.width - BOX.a.left - BOX.a.width,
        BOX.container.height - BOX.a.top - BOX.a.height,
      ])
      check(JSON.stringify(texts(o)) === JSON.stringify(want), `expected inset badges ${JSON.stringify(want)}, saw ${JSON.stringify(o)} (container ${JSON.stringify(container)})`)
      return `badges ${texts(o).join(", ")}`
    },

    async "5 release alt: cleared"() {
      await ensureAlt()
      await altUp()
      const o = await readOverlay(page)
      check(o.badges.length === 0 && o.dashes.length === 0, `readout still visible after Alt up: ${JSON.stringify(o)}`)
      return "0 badges, 0 dashes"
    },

    async "6 alt with a still pointer"() {
      await hover(b)
      const before = await readOverlay(page)
      check(before.badges.length === 0, `badges before Alt: ${JSON.stringify(before.badges)}`)
      await altDown()
      const o = await readOverlay(page)
      const want = expect([BOX.b.left - (BOX.a.left + BOX.a.width)])
      check(o.badges.length === 1 && o.badges[0].text === want[0], `pressing Alt over B without moving: expected badge ${JSON.stringify(want)}, saw ${JSON.stringify(o)}`)
      await altUp()
      return `badge "${o.badges[0].text}" appeared on keydown alone`
    },
  }
}

/* ---------- main ---------- */

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  if (!noBuild) {
    const built = spawnSync(process.execPath, [path.join(ROOT, "build.mjs")], { cwd: ROOT, encoding: "utf8" })
    if (built.status !== 0) throw new Error(`node build.mjs failed:\n${built.stdout}${built.stderr}`)
    console.log("built dist/designlayer.js")
  }

  const ports = { app: await freePort(), proxy: await freePort(), ws: await freePort(), mcp: await freePort() }
  console.log(`ports: app ${ports.app}, proxy ${ports.proxy}, ws ${ports.ws}, mcp ${ports.mcp}`)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-measure-e2e-"))
  tmpDirs.push(tmpDir)
  writeHost(tmpDir, ports)

  const vite = run(process.execPath,
    ["node_modules/vite/bin/vite.js", "--port", String(ports.app), "--strictPort", "--configLoader", "native"],
    { cwd: tmpDir, env: { ...process.env, BROWSER: "none" } })
  await waitHttp(`http://127.0.0.1:${ports.app}/`, vite, "vite")
  const cli = run(process.execPath,
    [path.join(ROOT, "cli.mjs"), String(ports.app),
      "--project-root", tmpDir, "--config", path.join(tmpDir, "designlayer.config.mjs"),
      "--proxy-port", String(ports.proxy), "--ws-port", String(ports.ws), "--no-open", "--no-start"],
    { cwd: tmpDir })
  const url = `http://127.0.0.1:${ports.proxy}/`
  await waitHttp(url, cli, "designlayer proxy")

  browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const consoleLines = []
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`))
  const ready = page.waitForEvent("console", { predicate: (m) => m.text().includes(READY_LINE), timeout: BOOT_TIMEOUT })
  await page.goto(url)
  await ready.catch(() => { throw new Error(`no "${READY_LINE}" within ${BOOT_TIMEOUT}ms`) })
  await page.waitForSelector('[data-testid="c"]', { timeout: WAIT })
  await page.waitForSelector(".de-root", { timeout: WAIT, state: "attached" })
  await sleep(800)

  const table = scenarios(page)
  for (const [name, fn] of Object.entries(table)) {
    try {
      const detail = await fn()
      console.log(`ok ${name} — ${detail}`)
      results.push({ name, pass: true })
    } catch (error) {
      console.log(`FAIL ${name} — ${error instanceof Fail ? error.message : error.stack}`)
      results.push({ name, pass: false })
      await page.screenshot({ path: path.join(SHOTS, `fail-${name.split(" ")[0]}.png`) }).catch(() => {})
      await page.keyboard.up("Alt").catch(() => {})
      page.emit("measure:alt-released")
    }
  }

  const errors = consoleLines.filter((l) => /^(error|pageerror)/.test(l))
  if (errors.length) console.log(`console errors (${errors.length}):\n  ${errors.slice(0, 5).join("\n  ")}`)
  const failed = results.filter((r) => !r.pass)
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
