#!/usr/bin/env node
/**
 * Real-browser check that every Copy in the editor lands, wherever it runs.
 *
 *   node tools/clipboard-e2e.mjs --app 5173 --root ~/Projects/my-react-app
 *   node tools/clipboard-e2e.mjs --app 5197 --root ~/Projects/my-app --framework angular
 *   node tools/clipboard-e2e.mjs --editor http://localhost:3456 --ws 3457
 *   node tools/clipboard-e2e.mjs ... --only desk-unfocused
 *
 * `--app` starts a private editor on free ports against a running dev server,
 * so no editor already on this machine is touched. `--editor` attaches to one
 * that is running and mocks its WebSocket, because the vendor socket keeps one
 * client and a test that connected would disconnect the designer's tab.
 *
 * Each scenario is a place the editor runs, and the Copy surfaces are run in
 * every one of them:
 *
 *   tab             a browser tab. The Clipboard API works.
 *   desk            framed the way the Mac app frames it (desktop/mac/
 *                   shell-page.mjs), with focus left in the parent, as after
 *                   clicking one of its tabs.
 *   desk-unfocused  the same, with focus pulled back to the parent during the
 *                   click. Chrome then refuses the Clipboard API ("Document is
 *                   not focused"), which is what the designer met as
 *                   "Clipboard access blocked". The copy command has to land it.
 *   no-policy       framed by a parent that does not delegate clipboard-write.
 *   no-api          no `navigator.clipboard` at all, as on an origin that is
 *                   not secure.
 *
 * Surfaces: the Code tab's Copy (skipped in a build without that tab), the
 * Classes section's source path (skipped when nothing at the probe points has a
 * resolved file), the MCP address Copy, the Changes tab's Copy (after pinning a
 * note), and the ⌥⌘C chord. Each copy is checked by reading
 * the clipboard back from another page and comparing it with what the editor
 * shows, after a sentinel was written first so a copy that did nothing cannot
 * pass. The route each copy took is recorded too: `desk-unfocused` fails unless
 * the Clipboard API really was refused, so it cannot pass without exercising
 * the copy command.
 *
 * Headless Chromium keeps its own clipboard, so a run never touches the system
 * one. Needs the globally installed Playwright, like tools/board-e2e.mjs. A
 * failure leaves a screenshot in `.harness/clipboard-e2e/` (gitignored).
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
const SHOTS = path.join(ROOT, ".harness", "clipboard-e2e")
const SCENARIOS = ["tab", "desk", "desk-unfocused", "no-policy", "no-api"]
const FRAMED = new Set(["desk", "desk-unfocused", "no-policy"])
const READY_LINE = "[designlayer] Figma-style overlay ready"
const NOTE = "clipboard e2e note"
const SENTINEL = "SENTINEL: nothing was copied"

const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const appPort = option("--app")
const projectRoot = option("--root")
const framework = option("--framework") ?? "auto"
const attachTo = option("--editor")
const attachWs = option("--ws") ?? "3457"
const only = option("--only")

if (!appPort === !attachTo) {
  console.error("usage: --app <port> --root <dir> [--framework angular], or --editor <url> [--ws <port>]")
  process.exit(2)
}
if (only && !SCENARIOS.includes(only)) {
  console.error(`unknown scenario "${only}"; one of ${SCENARIOS.join(", ")}`)
  process.exit(2)
}

/* ---------- processes ---------- */

const children = []
const servers = []
let tmpDir = null
let browser = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitHttp(url, child, label, timeout = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (child && child.exitCode !== null) throw new Error(`${label} exited early:\n${child.log.slice(-2000)}`)
    const ok = await new Promise((resolve) => {
      http.get(url, (res) => (res.resume(), resolve(res.statusCode < 500))).on("error", () => resolve(false))
    })
    if (ok) return Date.now() - start
    await sleep(250)
  }
  throw new Error(`${label} did not answer at ${url} within ${timeout}ms${child ? `:\n${child.log.slice(-2000)}` : ""}`)
}

async function cleanup() {
  await browser?.close().catch(() => {})
  for (const server of servers) server.close()
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode) continue
    try { process.kill(-child.pid, "SIGTERM") } catch {}
  }
  await sleep(500)
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode) continue
    try { process.kill(-child.pid, "SIGKILL") } catch {}
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => { await cleanup(); process.exit(130) })
}

/** A private editor on free ports, so no editor already running is touched. */
async function startEditor() {
  const ports = { proxy: await freePort(), ws: await freePort(), mcp: await freePort() }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-clipboard-e2e-"))
  const config = path.join(tmpDir, "designlayer.config.mjs")
  fs.writeFileSync(config, `export default {
  projectRoot: ${JSON.stringify(path.resolve(projectRoot ?? "."))},
  app: { port: ${Number(appPort)}, open: false },
  ports: { proxy: ${ports.proxy}, ws: ${ports.ws}, mcp: ${ports.mcp} },
  host: { framework: ${JSON.stringify(framework)} },
}
`)
  const child = spawn(process.execPath, ["cli.mjs", "--config", config, "--no-start", "--no-open", String(appPort)], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.log = ""
  child.stdout.on("data", (chunk) => (child.log += chunk))
  child.stderr.on("data", (chunk) => (child.log += chunk))
  children.push(child)
  const url = `http://127.0.0.1:${ports.proxy}/`
  await waitHttp(url, child, "designlayer proxy")
  return { url, mockWs: null }
}

/** The parent page a framed scenario loads the editor into. */
async function startParent() {
  const server = http.createServer((req, res) => {
    const query = new URL(req.url, "http://parent").searchParams
    const src = query.get("src") ?? ""
    const policy = query.get("policy") === "none" ? "" : ' allow="clipboard-read; clipboard-write; fullscreen"'
    const name = query.get("policy") === "none" ? "embedder" : "designlayer-desk:e2e"
    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end(`<!doctype html><html><body style="margin:0;background:#1a1a1a">
<div style="height:38px;display:flex;align-items:center;padding-left:8px">
  <div id="tab" tabindex="0" role="tab" style="color:#fff;padding:4px 10px">Editor</div>
</div>
<iframe id="editor" name="${name}"${policy} src="${src.replace(/"/g, "&quot;")}"
  style="position:fixed;left:0;right:0;bottom:0;top:39px;width:100%;height:calc(100% - 39px);border:0"></iframe>
</body></html>`)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}/`
}

/* ---------- in-page instrumentation, run in every frame ---------- */

function instrument({ scenario, readerOrigin }) {
  window.__clipRoutes = []
  // The page that reads the clipboard back keeps its API in every scenario.
  if (location.origin === readerOrigin) return
  if (scenario === "no-api") {
    Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined, configurable: true })
  } else if (navigator.clipboard) {
    const clipboard = navigator.clipboard
    const write = clipboard.writeText.bind(clipboard)
    clipboard.writeText = (text) =>
      write(text).then(
        (value) => (window.__clipRoutes.push("api"), value),
        (error) => {
          window.__clipRoutes.push(`api refused (${error.message.replace(/^Failed to execute .*?: /, "")})`)
          throw error
        }
      )
  }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function execCommand(command, ...rest) {
    const ran = exec.call(this, command, ...rest)
    if (command === "copy") window.__clipRoutes.push(ran ? "command" : "command refused")
    return ran
  }
  if (scenario === "desk-unfocused" && window !== window.top) {
    // Focus leaves the frame between the press and the write, before any of
    // the editor's handlers run: the state Chrome is in when the click that
    // activates the window outruns its focus update.
    window.addEventListener("click", () => window.top.focus(), true)
  }
}

/* ---------- surfaces ---------- */

class Fail extends Error {}
/** A surface this build does not draw, which is not a failed copy. */
class Skip extends Error {}

/** Whether the scenario running now frames the editor; the surfaces aim at its frame. */
let FRAMED_SCENARIO = false

/**
 * Where on the app to click, as fractions of the area between the panels.
 * Tried in order until something takes: the centre of some apps is a dialog's
 * backdrop or a gap that selects nothing.
 */
const APP_POINTS = [[0.5, 0.5], [0.5, 0.3], [0.4, 0.6], [0.6, 0.4], [0.5, 0.15]]

/**
 * One of the editor's own tabs. Scoped to its chrome and matched on the whole
 * label: an app's tabs are `[role=tab]` too, and a Material icon ligature such
 * as "code" makes a substring match land on the app instead.
 */
const editorTab = (frame, label) => frame.locator("[data-designlayer] [role=tab]", { hasText: label }).first()

async function clickApp(page, [fx, fy]) {
  const box = await page.locator(FRAMED_SCENARIO ? "#editor" : "body").boundingBox()
  // The left rail and the inspector are 240px and 260px; aim between them.
  const left = box.x + 240
  const width = box.width - 240 - 260
  await page.mouse.click(left + width * fx, box.y + box.height * fy)
}

const toastsIn = (frame) =>
  frame.evaluate(() =>
    [...(document.getElementById("designlayer-toaster")?.shadowRoot?.querySelectorAll("[data-sonner-toast]") ?? [])].map(
      (toast) => toast.textContent.trim()
    )
  )

/** Each returns what the clipboard should hold, or a test for it. */
const SURFACES = {
  async code(frame, page) {
    if (!(await editorTab(frame, /^Code$/).count())) throw new Skip("this build has no Code tab")
    await editorTab(frame, /^Code$/).click()
    const copy = frame.locator('button[title="Copy this view to the clipboard"]')
    await copy.waitFor({ state: "visible", timeout: 8000 })
    // Inspect mode is the default; a click on the app selects what is under it.
    const enabled = () => frame.evaluate(() => {
      const button = document.querySelector('button[title="Copy this view to the clipboard"]')
      return Boolean(button && !button.disabled)
    })
    for (const point of APP_POINTS) {
      await clickApp(page, point)
      for (let wait = 0; wait < 10 && !(await enabled()); wait += 1) await sleep(150)
      if (await enabled()) break
    }
    if (!(await enabled())) throw new Fail("nothing on the app could be selected: the Code tab's Copy stayed disabled")
    const expected = await frame.evaluate(() =>
      [...document.querySelectorAll(".de-code-view .de-code-text")].map((line) => line.textContent).join("\n")
    )
    await copy.click()
    return expected
  },
  async source(frame, page) {
    // The Classes section's path button, on the Design tab, for an element whose
    // source file resolved. Not every app resolves one at the probe points.
    await editorTab(frame, /^Design$/).click()
    const button = frame.locator('[data-designlayer] button[title="Copy source path"]').first()
    for (const point of APP_POINTS) {
      await clickApp(page, point)
      if (await button.waitFor({ state: "attached", timeout: 2500 }).then(() => true, () => false)) break
    }
    if (!(await button.count())) throw new Skip("no element at the probe points has a resolved source file")
    const shown = (await button.textContent()).trim()
    await button.click()
    // The button shows `file:line`; the copy adds the column.
    return (text) => text === shown || text.startsWith(`${shown}:`)
  },
  async mcp(frame) {
    await editorTab(frame, /^Changes/).click()
    const address = frame.locator(".de-mcp-url")
    await frame.waitForFunction(() => /^https?:/.test(document.querySelector(".de-mcp-url")?.textContent ?? ""), null, { timeout: 10000 })
      .catch(() => { throw new Fail("the MCP address never appeared") })
    const expected = (await address.textContent()).trim()
    const copy = frame.locator('button[title="Copy MCP address"]')
    if (!(await copy.isVisible())) {
      // The MCP section folds; its header opens it.
      await frame.locator(".de-mcp-state").first().click().catch(() => {})
    }
    await copy.click()
    return expected
  },
  async notes(frame, page) {
    await frame.locator('[data-designlayer] button[aria-label="Notes"]').click()
    const field = frame.locator('textarea[placeholder="What should change?"]')
    for (const point of APP_POINTS) {
      await clickApp(page, point)
      if (await field.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false)) break
    }
    if (!(await field.isVisible())) throw new Fail("no note composer opened on the app")
    await field.fill(NOTE)
    await field.press("Enter")
    await editorTab(frame, /^Changes/).click()
    await frame.locator('button[title="Copy all notes and edits"]').click()
    return (text) => text.startsWith("## Page Feedback") && text.includes(NOTE)
  },
  async chord(frame, page) {
    // Keys reach the focused frame only, so focus one of the editor's own
    // controls first, the way any click on its chrome does.
    await editorTab(frame, /^Changes/).click()
    await page.keyboard.press("Meta+Alt+KeyC")
    return (text) => text.startsWith("## Page Feedback") && text.includes(NOTE)
  },
}

/** Which surfaces each scenario can reach. Keys go to the focused frame only. */
const SURFACES_FOR = {
  tab: ["code", "source", "mcp", "notes", "chord"],
  desk: ["code", "source", "mcp", "notes", "chord"],
  "desk-unfocused": ["code", "source", "mcp", "notes"],
  "no-policy": ["code", "source", "mcp", "notes", "chord"],
  "no-api": ["code", "source", "mcp", "notes", "chord"],
}

/** What a scenario must have exercised, so it cannot pass on the easy path. */
function routeProblem(scenario, routes) {
  const last = routes.at(-1) ?? "nothing"
  if (scenario === "desk-unfocused" && !routes.some((route) => route.startsWith("api refused"))) {
    return `the Clipboard API was never refused (${routes.join(" → ") || "no write"}), so the scenario did not reproduce the bug`
  }
  if ((scenario === "no-policy" || scenario === "no-api") && routes.includes("api")) {
    return "the Clipboard API was used where it does not exist"
  }
  if (last !== "api" && last !== "command") return `the copy did not land (${routes.join(" → ") || "no write"})`
  return null
}

/** True once the app, not just the editor's chrome, has drawn something with text in it. */
async function appRendered(frame, timeout = 20000) {
  return frame
    .waitForFunction(
      () =>
        [...document.body.querySelectorAll("*")].some((node) => {
          if (node.closest("[data-designlayer]") || !node.textContent.trim()) return false
          const box = node.getBoundingClientRect()
          return box.width > 40 && box.height > 12
        }),
      null,
      { timeout }
    )
    .then(() => true, () => false)
}

/* ---------- main ---------- */

async function runScenario(scenario, editor, parentUrl) {
  FRAMED_SCENARIO = FRAMED.has(scenario)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  if (editor.mockWs) await context.routeWebSocket((url) => String(url).includes(`:${editor.mockWs}`), () => {})
  await context.addInitScript(instrument, { scenario, readerOrigin: new URL(parentUrl).origin })
  const page = await context.newPage()
  const reader = await context.newPage()
  await reader.goto(parentUrl)
  await page.bringToFront()

  const ready = page.waitForEvent("console", { predicate: (m) => m.text().includes(READY_LINE), timeout: 60000 }).catch(() => null)
  let frame
  if (FRAMED_SCENARIO) {
    const policy = scenario === "no-policy" ? "none" : "desk"
    await page.goto(`${parentUrl}?policy=${policy}&src=${encodeURIComponent(editor.url)}`)
    frame = await (await page.waitForSelector("#editor")).contentFrame()
  } else {
    await page.goto(editor.url)
    frame = page.mainFrame()
  }
  await frame.waitForSelector("[data-designlayer] button", { state: "attached", timeout: 60000 })
  await Promise.race([ready, sleep(8000)])
  if (!(await appRendered(frame))) {
    // A dev server under load can drop one module and leave the app blank.
    // That is the app's failure, not the clipboard's: reload once, then say so.
    await frame.evaluate(() => location.reload())
    await sleep(3000)
    await frame.waitForSelector("[data-designlayer] button", { state: "attached", timeout: 60000 }).catch(() => {})
    if (!(await appRendered(frame))) {
      console.log(`  FAIL ${scenario.padEnd(15)} the app never rendered in this scenario, so no Copy could be tried`)
      await context.close()
      return SURFACES_FOR[scenario].map((surface) => ({ surface, pass: false }))
    }
  }
  await sleep(1500)

  const results = []
  for (const surface of SURFACES_FOR[scenario]) {
    const started = Date.now()
    try {
      await reader.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL)
      await frame.evaluate(() => (window.__clipRoutes.length = 0))
      // The parent holds focus at the start of every framed copy, as after a
      // click on one of the Mac app's tabs.
      if (FRAMED_SCENARIO) await page.click("#tab")
      const expected = await SURFACES[surface](frame, page)
      await sleep(700)
      const got = await reader.evaluate(() => navigator.clipboard.readText())
      const routes = await frame.evaluate(() => window.__clipRoutes.slice())
      const toasts = await toastsIn(frame)
      const matches = typeof expected === "function" ? expected(got) : got === expected
      if (!matches) {
        throw new Fail(`clipboard holds ${JSON.stringify(got.slice(0, 120))}, expected ${typeof expected === "function" ? "a notes brief" : JSON.stringify(String(expected).slice(0, 120))} (${routes.join(" → ") || "no write"})`)
      }
      const problem = routeProblem(scenario, routes)
      if (problem) throw new Fail(problem)
      if (toasts.some((toast) => /Could not copy|Clipboard access blocked/.test(toast))) {
        throw new Fail(`the copy landed but the editor still toasted a refusal: ${JSON.stringify(toasts)}`)
      }
      results.push({ surface, pass: true })
      console.log(`  ok   ${scenario.padEnd(15)} ${surface.padEnd(6)} via ${routes.join(" → ")} (${Date.now() - started}ms)`)
    } catch (error) {
      if (error instanceof Skip) {
        console.log(`  skip ${scenario.padEnd(15)} ${surface.padEnd(6)} ${error.message}`)
        continue
      }
      results.push({ surface, pass: false })
      console.log(`  FAIL ${scenario.padEnd(15)} ${surface.padEnd(6)} ${error instanceof Fail ? error.message : error.stack.split("\n").slice(0, 3).join(" | ")}`)
      fs.mkdirSync(SHOTS, { recursive: true })
      await page.screenshot({ path: path.join(SHOTS, `fail-${scenario}-${surface}.png`) }).catch(() => {})
    }
  }
  await context.close()
  return results
}

async function main() {
  const editor = attachTo ? { url: attachTo, mockWs: attachWs } : await startEditor()
  const parentUrl = await startParent()
  console.log(`editor ${editor.url}${editor.mockWs ? ` (socket :${editor.mockWs} mocked)` : " (private)"}`)
  browser = await chromium.launch({ headless: true })
  const all = []
  for (const scenario of only ? [only] : SCENARIOS) all.push(...(await runScenario(scenario, editor, parentUrl)))
  const failed = all.filter((result) => !result.pass).length
  console.log(`\n${all.length - failed}/${all.length} copies landed`)
  return failed ? 1 : 0
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
