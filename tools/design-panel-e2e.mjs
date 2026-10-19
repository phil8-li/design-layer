#!/usr/bin/env node
/**
 * Real-browser end-to-end check of the Design tab's flows: each one changes a
 * property through the panel the way a Figma user would, presses Apply to
 * code, and reads the host's source file for the class that edit must write.
 *
 *   DESIGNLAYER_E2E_DEPS=/path/to/node_modules node tools/design-panel-e2e.mjs
 *   ... --only radius     # one flow
 *   ... --headed          # watch it
 *   ... --keep            # leave the temp host app on disk
 *
 * Same harness shape as tools/board-e2e.mjs: a throwaway Vite + React host in
 * os.tmpdir() (node_modules borrowed by symlink from DESIGNLAYER_E2E_DEPS),
 * Vite and `cli.mjs` on fresh free ports, so no running editor is touched. The
 * host ships a few hand-written utility rules so its starting classes lay out
 * the way Tailwind would; the edits are asserted in the source, not on screen.
 *
 * Not part of `npm test`: it needs a React + Vite toolchain, a Chromium from
 * the global Playwright, and free local ports.
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const SHOTS = path.join(ROOT, ".harness", "design-panel-e2e")
const DEPS = process.env.DESIGNLAYER_E2E_DEPS

const args = process.argv.slice(2)
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null
const headed = args.includes("--headed")
const keep = args.includes("--keep")
const READY_LINE = "[designlayer] Figma-style overlay ready"
const WAIT = 8000

/* ---------- processes ---------- */

const children = []
let browser = null
let tmpDir = null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, argv, opts) {
  const child = spawn(cmd, argv, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  child.log = ""
  child.stdout.on("data", (d) => (child.log += d))
  child.stderr.on("data", (d) => (child.log += d))
  children.push(child)
  return child
}

async function cleanup() {
  await browser?.close().catch(() => {})
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode) continue
    try { process.kill(-child.pid, "SIGTERM") } catch {}
  }
  await sleep(400)
  if (tmpDir && !keep) fs.rmSync(tmpDir, { recursive: true, force: true })
  else if (tmpDir) console.log(`kept host app at ${tmpDir}`)
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await cleanup(); process.exit(130) })

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

const APP = `export default function App() {
  return (
    <main className="page">
      <section id="card" className="flex flex-row items-center gap-4 p-6 rounded-2xl bg-white">
        <h2 id="title" className="text-lg font-semibold">Pro plan</h2>
        <button id="cta" className="px-4 py-2 rounded-lg bg-blue">Upgrade</button>
      </section>
      <div id="stack" className="block p-4 bg-white">
        <div className="chip">One</div>
        <div className="chip">Two</div>
      </div>
      <div id="box" className="box rounded-xl bg-blue"></div>
      <p id="copy" className="text-base">Plans scale with your team.</p>
    </main>
  )
}
`

/* The few utilities the starting markup uses, so computed style matches the classes. */
const CSS = `body { margin: 0; font-family: system-ui, sans-serif; background: #f6f7f9; }
.page { padding: 40px; display: grid; gap: 24px; justify-items: start; }
.flex { display: flex; } .flex-row { flex-direction: row; } .items-center { align-items: center; }
.block { display: block; } .gap-4 { gap: 16px; } .p-6 { padding: 24px; } .p-4 { padding: 16px; }
.px-4 { padding-left: 16px; padding-right: 16px; } .py-2 { padding-top: 8px; padding-bottom: 8px; }
.rounded-2xl { border-radius: 16px; } .rounded-xl { border-radius: 12px; } .rounded-lg { border-radius: 8px; }
.bg-white { background: #ffffff; } .bg-blue { background: #4a5df9; color: #ffffff; }
.text-lg { font-size: 18px; line-height: 28px; } .text-base { font-size: 16px; line-height: 24px; }
.font-semibold { font-weight: 600; } .chip { padding: 4px 8px; background: #e9edf0; }
.box { width: 120px; height: 80px; }
h2 { margin: 0; } p { margin: 0; }
`

function writeHost(dir, ports) {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  write("package.json", JSON.stringify({
    name: "design-panel-e2e-host",
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
  <head><meta charset="utf-8" /><title>design-panel e2e host</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>
</html>
`)
  write("src/main.jsx", `import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App.jsx"
import "./app.css"
createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>)
`)
  write("src/App.jsx", APP)
  write("src/app.css", CSS)
  fs.symlinkSync(DEPS, path.join(dir, "node_modules"), "dir")
}

/* ---------- page helpers ---------- */

class Fail extends Error {}
const check = (cond, message) => { if (!cond) throw new Fail(message) }
const panel = "#de-tabpanel-design"

async function selectApp(page, id) {
  const box = await page.evaluate((target) => {
    const node = document.getElementById(target)
    if (!node) return null
    const r = node.getBoundingClientRect()
    // Just inside the top-left corner: a container's centre is usually one of
    // its children, and a click there would select the child instead.
    return { x: r.left + Math.min(6, r.width / 2), y: r.top + Math.min(6, r.height / 2) }
  }, id)
  check(box, `#${id} is not on the page`)
  await page.mouse.click(box.x, box.y)
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.querySelector(".de-section") !== null,
    panel,
    { timeout: WAIT }
  ).catch(() => { throw new Fail(`selecting #${id} did not fill the Design tab`) })
  await sleep(150)
}

/** Shift-clicks #id to add it to the selection, then waits for the header's count. */
async function selectAlso(page, id, count) {
  const box = await page.evaluate((target) => {
    const node = document.getElementById(target)
    if (!node) return null
    const r = node.getBoundingClientRect()
    return { x: r.left + Math.min(6, r.width / 2), y: r.top + Math.min(6, r.height / 2) }
  }, id)
  check(box, `#${id} is not on the page`)
  await page.keyboard.down("Shift")
  await page.mouse.click(box.x, box.y)
  await page.keyboard.up("Shift")
  await page.waitForFunction(
    ({ sel, label }) => document.querySelector(sel)?.textContent?.includes(label),
    { sel: panel, label: `${count} selected` },
    { timeout: WAIT }
  ).catch(() => { throw new Fail(`shift-clicking #${id} did not make ${count} selected`) })
  await sleep(150)
}

/**
 * The first visible control in the Design tab whose accessible name matches: its
 * `aria-label`, or the text of the `<label>` around it (the Clip content box).
 * A RegExp matches names that change with state, such as the gap's axis.
 */
async function control(page, name) {
  const wanted = name instanceof RegExp ? { source: name.source, flags: name.flags } : { exact: name }
  const handle = await page.evaluateHandle(({ sel, wanted }) => {
    const root = document.querySelector(sel)
    const all = [...(root?.querySelectorAll("button, input, select, [role=checkbox]") ?? [])]
    const nameOf = (node) => node.getAttribute("aria-label") ?? node.closest("label")?.textContent?.trim() ?? ""
    const test = wanted.exact !== undefined
      ? (text) => text === wanted.exact
      : (text) => new RegExp(wanted.source, wanted.flags).test(text)
    return all.find((node) => test(nameOf(node)) && node.getClientRects().length > 0) ?? null
  }, { sel: panel, wanted })
  const node = handle.asElement()
  check(node, `no visible control named "${name}" in the Design tab`)
  return node
}

async function press(page, name) {
  await (await control(page, name)).click()
  await sleep(150)
}

async function type(page, name, value) {
  const input = await control(page, name)
  await input.click({ clickCount: 3 })
  await input.fill(String(value))
  // The keyboard, not the handle: a commit rebuilds the panel, and a handle
  // press waits for the old node to be actionable again.
  await page.keyboard.press("Enter")
  await sleep(150)
}

async function choose(page, name, value) {
  await (await control(page, name)).selectOption(value)
  await sleep(150)
}

async function applyToCode(page) {
  await page.click("#de-tab-annotations")
  const apply = await page.waitForSelector("button:has-text('Apply to code')", { timeout: WAIT })
    .catch(() => { throw new Fail("no Apply to code button in the Changes tab") })
  await apply.click()
  await sleep(300)
  await page.click("#de-tab-design")
  await sleep(150)
}

/** A needle is a substring, or a RegExp when it must sit on one particular element. */
const found = (text, needle) => (needle instanceof RegExp ? needle.test(text) : text.includes(needle))

async function sourceHas(file, expected, timeout = 10000) {
  const start = Date.now()
  let text = ""
  while (Date.now() - start < timeout) {
    text = fs.readFileSync(file, "utf8")
    if (expected.every((needle) => found(text, needle))) return text
    await sleep(200)
  }
  const missing = expected.filter((needle) => !found(text, needle))
  throw new Fail(`source never gained ${missing.map((m) => `"${m}"`).join(", ")}`)
}

/** Types a hex into the Selection colors row showing `from`, by its field id. */
async function recolor(page, from, to) {
  const field = await page.evaluateHandle(({ sel, from }) => {
    const inputs = [...document.querySelectorAll(`${sel} .de-selcolor-row .de-paint-value`)]
    return inputs.find((input) => input.value.toUpperCase() === from) ?? null
  }, { sel: panel, from })
  const input = field.asElement()
  check(input, `no Selection colors row reads ${from}`)
  await input.click({ clickCount: 3 })
  await input.fill(to)
  await page.keyboard.press("Enter")
  await sleep(150)
}

/* ---------- the flows ---------- */

/*
 * Each flow names the element, the gesture, and the classes the source must
 * gain. Control names are the panel's accessible names, which are also its
 * tooltips, so a renamed control fails here by name.
 */
const FLOWS = [
  // Layout / Auto layout
  { name: "add-auto-layout", select: "stack", act: (p) => press(p, "Add auto layout"), expect: ["flex"] },
  { name: "gap", select: "card", act: (p) => type(p, /gap between objects$/, 24), expect: ["gap-6"] },
  { name: "gap-auto", select: "card", act: (p) => choose(p, "Gap options", "auto"), expect: ["justify-between"] },
  { name: "flow-vertical", select: "card", act: (p) => press(p, "Vertical"), expect: ["flex-col"] },
  { name: "wrap", select: "stack", act: async (p) => { await press(p, "Horizontal"); await press(p, "Wrap") }, expect: ["flex-wrap"] },
  { name: "padding-horizontal", select: "card", act: (p) => type(p, "Horizontal padding", 32), expect: ["pl-8", "pr-8"] },
  { name: "padding-individual", select: "card", act: async (p) => { await press(p, "Individual padding"); await type(p, "Padding top", 12) }, expect: ["pt-3"] },
  { name: "clip-content", select: "card", act: (p) => press(p, "Clip content"), expect: ["overflow-hidden"] },
  // Appearance
  { name: "radius", select: "box", act: (p) => type(p, "Corner radius", 20), expect: ["rounded-[20px]"] },
  { name: "corners", select: "box", act: async (p) => { await press(p, "Individual corners"); await type(p, "Top left radius", 4) }, expect: ["rounded-tl-[4px]"] },
  // Two layers, radius 12 and 0: the field reads Mixed, and one commit writes both.
  {
    name: "multi-radius",
    select: "box",
    act: async (p) => { await selectAlso(p, "copy", 2); await type(p, "Corner radius", 6) },
    expect: [/id="box" className="[^"]*rounded-\[6px\]/, /id="copy" className="[^"]*rounded-\[6px\]/],
  },
  { name: "opacity", select: "box", act: (p) => type(p, "Opacity", 50), expect: ["opacity-"] },
  // Position
  { name: "rotation", select: "box", act: (p) => type(p, "Rotation", 45), expect: ["rotate-[45deg]"] },
  { name: "flip", select: "box", act: (p) => press(p, "Flip horizontal"), expect: ["[scale:-1_1]"] },
  // Typography and the text's fill
  { name: "text-weight", select: "copy", act: (p) => choose(p, "Font weight", "700"), expect: ["font-bold"] },
  { name: "text-align", select: "copy", act: (p) => press(p, /^Align text center$/), expect: ["text-center"] },
  { name: "text-case", select: "copy", act: async (p) => { await press(p, "Type settings"); await press(p, "Uppercase") }, expect: ["uppercase"] },
  // Last, because it leaves the box invisible for anything after it.
  { name: "hide", select: "box", act: (p) => press(p, "Hide"), expect: ["invisible"] },
  // Selection colors: the card's white is its background and the button's label.
  { name: "selection-color", select: "card", act: (p) => recolor(p, "FFFFFF", "ff0066"), expect: ["bg-[#ff0066]", "text-[#ff0066]"] },
]

async function main() {
  check(DEPS && fs.existsSync(path.join(DEPS, "vite")), "set DESIGNLAYER_E2E_DEPS to a node_modules with vite, @vitejs/plugin-react, react, react-dom")
  fs.mkdirSync(SHOTS, { recursive: true })
  const ports = { app: await freePort(), proxy: await freePort(), ws: await freePort(), mcp: await freePort() }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-panel-e2e-"))
  writeHost(tmpDir, ports)
  const appFile = path.join(tmpDir, "src", "App.jsx")

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
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
  // Fail a stuck gesture in seconds rather than hang the run on Playwright's 30s default.
  page.setDefaultTimeout(WAIT)
  const logs = []
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`))
  const ready = page.waitForEvent("console", { predicate: (m) => m.text().includes(READY_LINE), timeout: 60000 })
  await page.goto(url)
  await ready
  await sleep(800)

  const results = []
  for (const flow of FLOWS.filter((f) => !only || f.name === only)) {
    try {
      await selectApp(page, flow.select)
      await flow.act(page)
      await applyToCode(page)
      await sourceHas(appFile, flow.expect)
      console.log(`ok ${flow.name} — source has ${flow.expect.join(" ")}`)
      results.push(true)
    } catch (error) {
      console.log(`FAIL ${flow.name} — ${error instanceof Fail ? error.message : error.stack}`)
      await page.screenshot({ path: path.join(SHOTS, `fail-${flow.name}.png`) }).catch(() => {})
      results.push(false)
    }
  }
  const errors = logs.filter((l) => l.startsWith("error") || l.startsWith("pageerror"))
  if (errors.length) console.log(`console errors (${errors.length}):\n  ${errors.slice(0, 5).join("\n  ")}`)
  const passed = results.filter(Boolean).length
  console.log(`\n${passed}/${results.length} flows passed; failure shots in ${path.relative(ROOT, SHOTS)}/`)
  return passed === results.length ? 0 : 1
}

let code = 1
try {
  code = await main()
} catch (error) {
  console.log(error instanceof Fail ? `FAIL ${error.message}` : error.stack)
} finally {
  await cleanup()
}
process.exit(code)
