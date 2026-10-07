#!/usr/bin/env node
/**
 * Real-browser check that ⌘. hides and shows the editor wherever focus is.
 *
 *   node tools/shortcut-e2e.mjs --app 3000 --root ~/Projects/my-app
 *   node tools/shortcut-e2e.mjs --app 3000 --root ~/Projects/my-app --host localhost
 *   node tools/shortcut-e2e.mjs --editor http://localhost:3456 --ws 3457
 *   node tools/shortcut-e2e.mjs ... --only desk-reload
 *
 * `--app` starts a private editor on free ports against a running dev server,
 * so no editor already on this machine is touched: the vendor socket keeps one
 * client, and a test that connected to the designer's editor would disconnect
 * their tab. `--editor` attaches to one that is running and mocks its socket
 * instead; the runtime it was started with is the one tested, so a change under
 * `runtime/` needs that editor restarted first. `--host` is the hostname a
 * private editor is opened on; some apps only sign in a mock user on
 * `localhost`.
 *
 * ⌘. is the way back to a collapsed editor, so it has to work from every place
 * focus can be. Each scenario puts focus somewhere a designer leaves it, then
 * presses ⌘. twice and expects the chrome to hide and come back:
 *
 *   page          nothing focused, a browser tab. The case that always worked.
 *   app-field     a text field of the app: its own if one is on screen,
 *                 otherwise a stand-in added to the page. Every prototype has
 *                 one, and the editor used to treat ⌘. typed there as typing.
 *   editor-field  the editor's own layer filter.
 *   app-frame     a field inside a same-origin frame on the page. Keys typed in
 *                 a frame go to that frame's window, not to the editor's.
 *   hidden-frame  an off-screen frame nobody can see or click, whose own page
 *                 focuses a field while it loads: what a host does when it
 *                 loads its own pages in the background to index them. Focus
 *                 leaves the page with no click, which is how ⌘. "stopped
 *                 working after a while". An image that never arrives keeps
 *                 the frame from finishing its load, so ⌘. is pressed in a
 *                 frame the editor can only have noticed by losing focus.
 *   desk-strip    the Mac app's shell (desktop/mac/shell-page.mjs, the real
 *                 page) with focus on its tab strip, as after clicking a tab.
 *                 The editor is a cross-origin frame there and never sees a key
 *                 typed in the shell.
 *   desk-field    the Mac app, focus in a text field of the app.
 *   desk-reload   the Mac app, focus in the editor, then the editor's frame
 *                 reloads, as on a full reload from the app's dev server.
 *
 * A cross-origin frame inside the app (an embed, a sandboxed preview) keeps its
 * keys and nothing on the page can hear them, so it is not a scenario here.
 *
 * Needs the globally installed Playwright, like tools/clipboard-e2e.mjs. A
 * failure leaves a screenshot in `.harness/shortcut-e2e/` (gitignored).
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs"
import { shellPage } from "../desktop/mac/shell-page.mjs"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const SHOTS = path.join(ROOT, ".harness", "shortcut-e2e")
const SCENARIOS = [
  "page",
  "app-field",
  "editor-field",
  "app-frame",
  "hidden-frame",
  "desk-strip",
  "desk-field",
  "desk-reload",
]
const READY_LINE = "[designlayer] Figma-style overlay ready"
const HIDDEN_CLASS = "designlayer-chrome-hidden"
const DESK_KEY = "designlayer.desk.tabs.v1"

const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const appPort = option("--app")
const projectRoot = option("--root")
const host = option("--host") ?? "127.0.0.1"
const attachTo = option("--editor")?.replace(/\/$/, "")
const attachWs = option("--ws") ?? "3457"
const only = option("--only")

if (!appPort === !attachTo) {
  console.error(
    "usage: --app <port> --root <dir> [--host localhost], or --editor <url> [--ws <port>]; then [--only <scenario>]"
  )
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
    if (child.exitCode !== null) throw new Error(`${label} exited early:\n${child.log.slice(-2000)}`)
    const ok = await new Promise((resolve) => {
      http.get(url, (res) => (res.resume(), resolve(res.statusCode < 500))).on("error", () => resolve(false))
    })
    if (ok) return
    await sleep(250)
  }
  throw new Error(`${label} did not answer at ${url} within ${timeout}ms:\n${child.log.slice(-2000)}`)
}

async function cleanup() {
  await browser?.close().catch(() => {})
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-shortcut-e2e-"))
  const config = path.join(tmpDir, "designlayer.config.mjs")
  fs.writeFileSync(config, `export default {
  projectRoot: ${JSON.stringify(path.resolve(projectRoot ?? "."))},
  app: { port: ${Number(appPort)}, open: false },
  ports: { proxy: ${ports.proxy}, ws: ${ports.ws}, mcp: ${ports.mcp} },
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
  await waitHttp(`http://127.0.0.1:${ports.proxy}/`, child, "designlayer proxy")
  return `http://${host}:${ports.proxy}`
}

/**
 * The Mac app's shell, served the way the desk serves it, with the desk's API
 * answered by stubs: one running editor, which the stored tabs already show.
 */
async function startDesk(editorUrl) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://desk")
    const json = (body) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(body))
    }
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end(shellPage({ repoRoot: ROOT }))
    } else if (url.pathname === "/api/health") {
      json({ ok: true, startScreen: { ready: true, url: `http://127.0.0.1:${server.address().port}/home` } })
    } else if (url.pathname === "/api/editors") {
      json({ editors: [{ name: "e2e", url: editorUrl, pid: 1, projectRoot: projectRoot ?? "." }] })
    } else if (url.pathname === "/home") {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end("<!doctype html><title>Home</title>")
    } else if (url.pathname === "/hang") {
      // Never answered: whatever page asks for it never finishes loading.
    } else {
      // The event stream, the service worker, the icons: nothing a key needs.
      res.statusCode = 204
      res.end()
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}/`
}

/* ---------- focus ---------- */

class Fail extends Error {}
class Skip extends Error {}

/** Where focus is, said the way a failure needs it said. */
async function describeFocus(page, frame) {
  const top = await page.evaluate(() => {
    const active = document.activeElement
    return { tag: active?.tagName.toLowerCase() ?? "none", focused: document.hasFocus() }
  })
  const inner = frame === page.mainFrame() ? null : await frame.evaluate(() => document.hasFocus()).catch(() => null)
  const where = await frame.evaluate(() => {
    const describe = (node, prefix = "") => {
      if (!node || node === document.body) return `${prefix}body`
      const name = node.tagName.toLowerCase()
      const editable = node.isContentEditable ? "[contenteditable]" : ""
      const chrome = node.closest("[data-designlayer]") ? " (editor)" : " (app)"
      return `${prefix}${name}${editable}${chrome}`
    }
    const active = document.activeElement
    if (active?.tagName === "IFRAME") {
      try {
        return describe(active.contentDocument.activeElement, "frame › ")
      } catch {
        return "a cross-origin frame"
      }
    }
    return describe(active)
  })
  return inner === null
    ? `${where}; page focused=${top.focused}`
    : `${top.tag} in the shell, editor frame focused=${inner}, inside it: ${where}`
}

/** A text field of the app, its own when one is on screen. */
async function focusAppField(frame) {
  const own = await frame.evaluate(() => {
    const fields = [...document.querySelectorAll('textarea, input, [contenteditable="true"], [contenteditable=""]')]
    const typeable = (node) => {
      if (node.closest("[data-designlayer]") || node.disabled || node.readOnly) return false
      if (node.tagName === "INPUT" && !/^(text|search|email|url|tel|password|number|)$/.test(node.type)) return false
      const box = node.getBoundingClientRect()
      return box.width > 20 && box.height > 10 && getComputedStyle(node).visibility !== "hidden"
    }
    const field = fields.find(typeable)
    if (!field) return null
    field.setAttribute("data-shortcut-e2e", "")
    return field.tagName.toLowerCase() + (field.isContentEditable ? "[contenteditable]" : "")
  })
  if (!own) {
    await frame.evaluate(() => {
      const field = document.createElement("textarea")
      field.setAttribute("data-shortcut-e2e", "")
      field.style.cssText = "position:fixed;left:45%;top:45%;width:200px;height:40px;z-index:1"
      document.body.append(field)
    })
  }
  await frame.locator("[data-shortcut-e2e]").first().focus()
  return own ? `the app's own ${own}` : "a stand-in textarea (the app showed no field)"
}

async function focusEditorField(frame) {
  const filter = frame.locator("[data-designlayer] input.de-layer-filter")
  if (!(await filter.count()) || !(await filter.first().isVisible())) throw new Skip("no layer filter on screen")
  await filter.first().focus()
  return "the layer filter"
}

async function focusAppFrame(frame) {
  await frame.evaluate(
    () =>
      new Promise((resolve) => {
        const inner = document.createElement("iframe")
        inner.id = "shortcut-e2e-frame"
        inner.srcdoc = '<!doctype html><input id="field" style="width:160px">'
        inner.style.cssText = "position:fixed;left:45%;top:45%;width:220px;height:60px;z-index:1;border:1px solid red"
        inner.addEventListener("load", () => resolve(), { once: true })
        document.body.append(inner)
      })
  )
  const inner = await (await frame.waitForSelector("#shortcut-e2e-frame")).contentFrame()
  await inner.locator("#field").focus()
  return "a field in a same-origin frame"
}

/** The page inside takes focus itself, and never finishes loading. */
async function focusHiddenFrame(frame, hangUrl) {
  await frame.evaluate((hang) => {
    const inner = document.createElement("iframe")
    inner.id = "shortcut-e2e-hidden"
    inner.setAttribute("aria-hidden", "true")
    inner.tabIndex = -1
    inner.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1280px;height:900px;opacity:0;pointer-events:none;border:0"
    inner.srcdoc =
      '<!doctype html><input id="field"><script>document.getElementById("field").focus()<\/script>' +
      `<img src="${hang}">`
    inner.addEventListener("load", () => inner.setAttribute("data-loaded", ""))
    document.body.append(inner)
  }, hangUrl)
  const took = await frame
    .waitForFunction(() => document.activeElement?.id === "shortcut-e2e-hidden", null, { timeout: 5000 })
    .then(() => true, () => false)
  if (!took) throw new Fail("the hidden frame never took focus, so nothing was reproduced")
  await sleep(300)
  if (await frame.evaluate(() => document.getElementById("shortcut-e2e-hidden").hasAttribute("data-loaded"))) {
    throw new Fail("the hidden frame finished loading, so its load, not its focus, introduced it")
  }
  return "a field in an off-screen frame that focused itself and is still loading"
}

/* ---------- main ---------- */

const hidden = (frame) => frame.evaluate((name) => document.documentElement.classList.contains(name), HIDDEN_CLASS)

async function settle(frame, want, timeout = 1500) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if ((await hidden(frame)) === want) return true
    await sleep(50)
  }
  return false
}

async function editorReady(frame, page) {
  const ready = page.waitForEvent("console", { predicate: (m) => m.text().includes(READY_LINE), timeout: 60000 }).catch(() => null)
  await frame.waitForSelector("[data-designlayer] button", { state: "attached", timeout: 60000 })
  await Promise.race([ready, sleep(8000)])
  await sleep(1000)
}

async function runScenario(scenario, editorUrl, deskUrl) {
  const framed = scenario.startsWith("desk-")
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  if (attachTo) await context.routeWebSocket((url) => String(url).includes(`:${attachWs}`), () => {})
  const page = await context.newPage()
  let frame
  try {
    if (framed) {
      // The tabs the desk would have stored: Home, and this editor, showing.
      await context.addInitScript(
        ({ key, url }) => {
          if (window !== window.top || localStorage.getItem(key)) return
          localStorage.setItem(key, JSON.stringify({
            tabs: [{ id: "home", kind: "home" }, { id: "editor", kind: "editor", url, name: "e2e" }],
            active: "editor",
            dismissed: [],
          }))
        },
        { key: DESK_KEY, url: editorUrl }
      )
      await page.goto(deskUrl)
      frame = await (await page.waitForSelector('iframe[data-id="editor"]')).contentFrame()
    } else {
      await page.goto(`${editorUrl}/`)
      frame = page.mainFrame()
    }
    await page.bringToFront()
    await editorReady(frame, page)
    if (await hidden(frame)) throw new Fail("the editor started hidden")

    let placed
    if (scenario === "page") {
      await frame.evaluate(() => document.activeElement?.blur?.())
      placed = "nothing focused"
    } else if (scenario === "app-field" || scenario === "desk-field") {
      placed = await focusAppField(frame)
    } else if (scenario === "editor-field") {
      placed = await focusEditorField(frame)
    } else if (scenario === "app-frame") {
      placed = await focusAppFrame(frame)
    } else if (scenario === "hidden-frame") {
      placed = await focusHiddenFrame(frame, `${deskUrl}hang`)
    } else if (scenario === "desk-strip") {
      await page.locator('.tab[aria-selected="true"]').click()
      placed = "the shell's tab strip, after a click on the tab"
    } else if (scenario === "desk-reload") {
      placed = `${await focusAppField(frame)}, then the frame reloaded`
      // The reload is the page's own, as a dev server's full reload is. The
      // marker tells the new document from the old one still on screen.
      await frame.evaluate(() => ((window.__shortcutE2eBefore = true), location.reload())).catch(() => {})
      const back = await frame
        .waitForFunction(
          () => !window.__shortcutE2eBefore && document.querySelector("[data-designlayer] button"),
          null,
          { timeout: 60000 }
        )
        .then(() => true, () => false)
      if (!back) throw new Fail("the editor did not come back after its frame reloaded itself")
      await sleep(2000)
    }
    const before = await describeFocus(page, frame)

    await page.keyboard.press("Meta+Period")
    if (!(await settle(frame, true))) throw new Fail(`⌘. did not hide the editor. Focus: ${before} (${placed})`)
    const between = await describeFocus(page, frame)
    await page.keyboard.press("Meta+Period")
    if (!(await settle(frame, false))) throw new Fail(`⌘. hid the editor but did not bring it back. Focus: ${between}`)

    console.log(`  ok   ${scenario.padEnd(13)} ${placed}; focus ${before}`)
    return true
  } catch (error) {
    if (error instanceof Skip) {
      console.log(`  skip ${scenario.padEnd(13)} ${error.message}`)
      return null
    }
    console.log(`  FAIL ${scenario.padEnd(13)} ${error instanceof Fail ? error.message : error.stack.split("\n").slice(0, 3).join(" | ")}`)
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, `fail-${scenario}.png`) }).catch(() => {})
    return false
  } finally {
    await context.close()
  }
}

async function main() {
  const editorUrl = attachTo ?? (await startEditor())
  const deskUrl = await startDesk(editorUrl)
  console.log(`editor ${editorUrl} (${attachTo ? `socket :${attachWs} mocked` : "private"}), shell ${deskUrl}`)
  browser = await chromium.launch({ headless: true })
  const results = []
  for (const scenario of only ? [only] : SCENARIOS) results.push(await runScenario(scenario, editorUrl, deskUrl))
  const ran = results.filter((result) => result !== null)
  const failed = ran.filter((result) => !result).length
  console.log(`\n${ran.length - failed}/${ran.length} places answered ⌘.`)
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
