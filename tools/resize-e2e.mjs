#!/usr/bin/env node
/**
 * Real-browser check that resizing works and that the Design tab says so: the
 * canvas handles, the W and H fields, and the app resizing its own panels in
 * interactive mode, each read back from the element and from the panel.
 *
 *   DESIGNLAYER_E2E_DEPS=/path/to/node_modules node tools/resize-e2e.mjs
 *   ... --only handle-grow   # one flow
 *   ... --headed             # watch it
 *   ... --keep               # leave the temp host app on disk
 *
 * Same harness as tools/design-panel-e2e.mjs: a throwaway Vite + React host in
 * os.tmpdir(), Vite and `cli.mjs` on fresh free ports, so no running editor is
 * touched. Every flow starts from a fresh page load.
 *
 * The host is the shapes that broke: a rail whose width is React state with a
 * width transition and an edge the app drags itself, a `flex-1` column, a
 * `flex-basis` item, a full flex line, a `max-width`, an inline box.
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
const SHOTS = path.join(ROOT, ".harness", "resize-e2e")
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
      if (res.ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error(`${label} not answering ${url} after ${timeout}ms:\n${child.log}`)
}

/* ---------- the host app ---------- */

const APP = `import { useRef, useState } from "react"

// An edge the app drags itself, the way Command Center's rails and panels do.
function useDragWidth(initial) {
  const [width, setWidth] = useState(initial)
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, width: 0 })
  const handlers = {
    onPointerDown: (e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); start.current = { x: e.clientX, width }; setDragging(true) },
    onPointerMove: (e) => { if (dragging) setWidth(Math.max(120, start.current.width + e.clientX - start.current.x)) },
    onPointerUp: () => setDragging(false),
  }
  return { width, dragging, handlers }
}

export default function App() {
  const rail = useDragWidth(320)
  const panel = useDragWidth(260)
  return (
    <div className="shell">
      <nav id="rail" className={rail.dragging ? "rail" : "rail rail--tween"} style={{ width: rail.width }}>
        <div className="chip">Home</div>
        <div className="chip">Agents</div>
        <div id="rail-edge" className="edge" {...rail.handlers} />
      </nav>
      <main className="page">
        <aside id="panel" className="panel" style={{ width: panel.width }}>
          <div className="chip">Panel</div>
          <div id="panel-edge" className="edge" {...panel.handlers} />
        </aside>
        <div id="box" className="box bg-blue"></div>
        <div id="row" className="row">
          <div id="basis" className="basis chip">Basis</div>
          <div id="grow" className="grow chip">Grow</div>
        </div>
        <div id="full" className="full">
          <div id="squeeze" className="half chip">A</div>
          <div className="half chip">B</div>
        </div>
        <div id="capped" className="capped chip">Capped</div>
        <div id="banner" className="banner"></div>
        <p id="copy" className="copy">Some text with <span id="inline" className="chip">an inline span</span> in it.</p>
      </main>
    </div>
  )
}
`

const CSS = `body { margin: 0; font-family: system-ui, sans-serif; background: #f6f7f9; }
.shell { display: flex; height: 100vh; }
.rail { position: relative; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden; background: #e9edf0; padding-top: 200px; }
.rail--tween { transition: width 300ms cubic-bezier(0.2, 0, 0, 1); }
.edge { position: absolute; top: 0; bottom: 0; right: 0; width: 8px; cursor: col-resize; background: rgba(0,0,0,0.15); }
.page { flex: 1; min-width: 0; padding: 32px; display: flex; flex-direction: column; gap: 20px; align-items: flex-start; }
.panel { position: relative; height: 100px; background: #fff; display: flex; flex-direction: column; padding-top: 50px; }
.box { width: 120px; height: 60px; }
.row { display: flex; width: 420px; gap: 8px; }
.basis { flex: 0 0 120px; }
.grow { flex: 1 1 0%; }
.full { display: flex; width: 300px; }
.half { width: 150px; }
.capped { width: 150px; max-width: 200px; }
.chip { padding: 4px 8px; background: #d5dce2; }
.bg-blue { background: #4a5df9; }
.copy { margin: 0; }
.banner { width: 100%; height: 24px; background: #c9d3dc; }
`

function writeHost(dir, ports) {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  write("package.json", JSON.stringify({
    name: "resize-e2e-host",
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
  <head><meta charset="utf-8" /><title>resize e2e host</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>
</html>
`)
  write("src/main.jsx", `import { createRoot } from "react-dom/client"
import App from "./App.jsx"
import "./app.css"
createRoot(document.getElementById("root")).render(<App />)
`)
  write("src/App.jsx", APP)
  write("src/app.css", CSS)
  fs.symlinkSync(DEPS, path.join(dir, "node_modules"), "dir")
}

/* ---------- page helpers ---------- */

class Fail extends Error {}
const check = (cond, message) => { if (!cond) throw new Fail(message) }
const panel = "#de-tabpanel-design"

/** The element's border box and inline declarations, and what the Design tab says about it. */
function read(page, id) {
  return page.evaluate(({ id, panel }) => {
    const node = document.getElementById(id)
    const box = node.getBoundingClientRect()
    const field = (name) => document.querySelector(`${panel} [data-de-field="${name}"]`)
    const menu = (name) => field(name)?.closest(".de-field")?.querySelector("select")
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      left: Math.round(box.left),
      right: Math.round(box.right),
      inline: {
        width: node.style.width,
        flex: node.style.flex,
        flexShrink: node.style.flexShrink,
        display: node.style.display,
        transition: node.style.transition,
      },
      W: Number(field("size.width")?.value),
      H: Number(field("size.height")?.value),
      modeW: menu("size.width")?.value ?? null,
    }
  }, { id, panel })
}

async function open(page, url) {
  const ready = page.waitForEvent("console", { predicate: (m) => m.text().includes(READY_LINE), timeout: 60000 })
  await page.goto(url)
  await ready
  await sleep(500)
}

/**
 * Clicks an empty spot inside #id (its bottom-left, past any child) and waits
 * for the tab. `deep` holds Cmd, the deep select, for a layer inside another.
 */
async function select(page, id, { deep = false } = {}) {
  const point = await page.evaluate((target) => {
    const r = document.getElementById(target).getBoundingClientRect()
    return { x: r.left + Math.min(6, r.width / 2), y: r.bottom - Math.min(4, r.height / 2) }
  }, id)
  if (deep) await page.keyboard.down("Meta")
  await page.mouse.click(point.x, point.y)
  if (deep) await page.keyboard.up("Meta")
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.querySelector('[data-de-field="size.width"]') !== null,
    panel,
    { timeout: WAIT }
  ).catch(() => { throw new Fail(`selecting #${id} did not fill the Design tab`) })
  const outlined = await page.evaluate((target) => {
    const r = document.getElementById(target).getBoundingClientRect()
    const outline = [...document.querySelectorAll(".de-outline")].find(
      (n) => n.className === "de-outline" && n.style.display !== "none"
    )
    return outline ? Math.abs(Number.parseFloat(outline.style.width) - r.width) < 1 : false
  }, id)
  check(outlined, `the click selected something other than #${id}`)
  await sleep(100)
}

async function dragFrom(page, from, dx, dy = 0) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(from.x + (dx * i) / 12, from.y + (dy * i) / 12)
    await sleep(16)
  }
  await page.mouse.up()
}

/** Drags a selection handle with Alt held, so snapping cannot round the travel. */
async function dragHandle(page, handle, dx, dy = 0) {
  const from = await page.evaluate((h) => {
    const node = document.querySelector(`.de-handle-hit[data-handle="${h}"]`)
    if (!node || node.style.display === "none") return null
    const r = node.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, handle)
  check(from, `no ${handle} handle on the selection`)
  await page.keyboard.down("Alt")
  try {
    await dragFrom(page, from, dx, dy)
  } finally {
    await page.keyboard.up("Alt")
  }
}

/** Drags the app's own edge with the editor handing clicks to the app. */
async function dragAppEdge(page, id, dx) {
  await page.evaluate(() => window.__DESIGNLAYER__.setMode("interactive"))
  await sleep(150)
  const from = await page.evaluate((target) => {
    const r = document.getElementById(target).getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, id)
  await dragFrom(page, from, dx)
}

async function type(page, field, value) {
  const input = await page.$(`${panel} [data-de-field="${field}"]`)
  check(input, `no ${field} field`)
  await input.click({ clickCount: 3 })
  await input.fill(String(value))
  await page.keyboard.press("Enter")
  await sleep(200)
}

async function pickMode(page, field, mode) {
  const menu = await page.$(`${panel} [data-de-field="${field}"]`)
  const select = await menu?.evaluateHandle((node) => node.closest(".de-field").querySelector("select"))
  check(select?.asElement(), `no mode menu beside ${field}`)
  await select.asElement().selectOption(mode)
  await sleep(200)
}

async function scrub(page, field, dx) {
  const label = await page.evaluateHandle(
    ({ panel, field }) => document.querySelector(`${panel} [data-de-field="${field}"]`)?.closest(".de-field")?.querySelector(".de-field-label"),
    { panel, field }
  )
  const box = await label.asElement()?.boundingBox()
  check(box, `no ${field} label to scrub`)
  await dragFrom(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, dx)
  await sleep(200)
}

async function undo(page) {
  // The canvas owns Cmd+Z only while focus is not in a field.
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.press("Meta+z")
  await sleep(250)
}

async function applyToCode(page) {
  await page.click("#de-tab-annotations")
  const apply = await page.waitForSelector("button:has-text('Apply to code')", { timeout: WAIT })
    .catch(() => { throw new Fail("no Apply to code button in the Changes tab") })
  await apply.click()
  await sleep(300)
  await page.click("#de-tab-design")
}

async function sourceHas(pattern, timeout = 10000) {
  const file = path.join(tmpDir, "src", "App.jsx")
  const start = Date.now()
  let text = ""
  while (Date.now() - start < timeout) {
    text = fs.readFileSync(file, "utf8")
    if (pattern.test(text)) return text
    await sleep(200)
  }
  throw new Fail(`source never matched ${pattern}:\n${text.split("\n").filter((line) => line.includes("grow")).join("\n")}`)
}

/** The panel reads what the element is, give or take the rounding both sides do. */
function agrees(state, label) {
  check(Math.abs(state.W - state.width) <= 1, `${label}: the Design tab says W ${state.W}, the element is ${state.width}`)
  check(Math.abs(state.H - state.height) <= 1, `${label}: the Design tab says H ${state.H}, the element is ${state.height}`)
}

/* ---------- the flows ---------- */

const FLOWS = [
  {
    name: "handle-transition",
    async run(page) {
      await select(page, "rail")
      const before = await read(page, "rail")
      await dragHandle(page, "e", 60)
      await sleep(80)
      const soon = await read(page, "rail")
      check(soon.width === before.width + 60, `the rail tweened behind the handle: ${soon.width}, wanted ${before.width + 60}`)
      agrees(soon, "right after the drag")
      await sleep(600)
      const settled = await read(page, "rail")
      check(settled.width === before.width + 60, `the rail ended at ${settled.width}`)
      check(settled.inline.transition === "", `the drag left transition "${settled.inline.transition}" inline`)
      agrees(settled, "after the tween")
    },
  },
  {
    name: "interactive-splitter",
    async run(page) {
      await select(page, "panel")
      const before = await read(page, "panel")
      await dragAppEdge(page, "panel-edge", 80)
      await sleep(300)
      const after = await read(page, "panel")
      check(after.width === before.width + 80, `the app did not resize its panel (${before.width} → ${after.width})`)
      agrees(after, "after the app resized the panel")
    },
  },
  {
    name: "interactive-transition",
    async run(page) {
      await select(page, "rail")
      await dragAppEdge(page, "rail-edge", -60)
      await sleep(700)
      const after = await read(page, "rail")
      check(after.width < 300, `the app did not shrink its rail (${after.width})`)
      agrees(after, "after the app's own tween")
      await page.evaluate(() => window.__DESIGNLAYER__.setMode("inspecting"))
      await sleep(200)
      agrees(await read(page, "rail"), "back in inspect mode")
    },
  },
  {
    name: "handle-grow",
    async run(page) {
      await select(page, "grow")
      const before = await read(page, "grow")
      check(before.modeW === "fill", `a flex-1 column reads ${before.modeW}, not Fill`)
      await dragHandle(page, "e", -40)
      await sleep(150)
      const after = await read(page, "grow")
      check(after.width === before.width - 40, `a flex-1 column did not take the handle: ${before.width} → ${after.width}`)
      check(after.inline.flex === "none" || after.inline.flex === "0 0 auto", `the resize kept the column growing (flex "${after.inline.flex}")`)
      check(after.modeW === "fixed", `a resized column reads ${after.modeW}, not Fixed`)
      agrees(after, "after the resize")
    },
  },
  {
    name: "handle-basis",
    async run(page) {
      await select(page, "basis")
      const before = await read(page, "basis")
      check(before.modeW === "fixed", `a flex-basis item reads ${before.modeW}, not Fixed`)
      await dragHandle(page, "e", 40)
      await sleep(150)
      const after = await read(page, "basis")
      check(after.width === before.width + 40, `a flex-basis item did not take the handle: ${before.width} → ${after.width}`)
      agrees(after, "after the resize")
    },
  },
  {
    name: "handle-squeeze",
    async run(page) {
      await select(page, "squeeze")
      const before = await read(page, "squeeze")
      await dragHandle(page, "e", 60)
      await sleep(150)
      const after = await read(page, "squeeze")
      check(after.width === before.width + 60, `a full flex line squeezed the resize: ${before.width} → ${after.width}`)
      check(after.inline.flexShrink === "0", `no shrink-0 on an item the line would squeeze (got "${after.inline.flexShrink}")`)
      agrees(after, "after the resize")
    },
  },
  {
    name: "handle-capped",
    async run(page) {
      await select(page, "capped")
      await dragHandle(page, "e", 120)
      await sleep(150)
      const after = await read(page, "capped")
      check(after.inline.width === "200px", `a max-width element was written ${after.inline.width}, not its 200px cap`)
      agrees(after, "after the resize")
    },
  },
  {
    name: "handle-west",
    async run(page) {
      await select(page, "box")
      const before = await read(page, "box")
      await dragHandle(page, "w", -30)
      await sleep(150)
      const after = await read(page, "box")
      check(after.width === before.width + 30, `a west handle grew the box to ${after.width}`)
      check(Math.abs(after.right - before.right) <= 1, `a west handle moved the east edge (${before.right} → ${after.right})`)
      agrees(after, "after the resize")
    },
  },
  {
    name: "handle-inline",
    async run(page) {
      await select(page, "inline", { deep: true })
      const before = await read(page, "inline")
      await dragHandle(page, "e", 40)
      await sleep(150)
      const after = await read(page, "inline")
      check(after.width === before.width + 40, `an inline span did not take the handle: ${before.width} → ${after.width}`)
      check(after.inline.display === "inline-block", `an inline span was resized without inline-block (display "${after.inline.display}")`)
      agrees(after, "after the resize")
    },
  },
  {
    name: "type-width-grow",
    async run(page) {
      await select(page, "grow")
      await type(page, "size.width", 150)
      const after = await read(page, "grow")
      check(after.width === 150, `typing W 150 on a flex-1 column drew ${after.width}`)
      agrees(after, "after typing")
    },
  },
  {
    name: "type-width-content-box",
    async run(page) {
      await select(page, "capped")
      await type(page, "size.width", 120)
      const after = await read(page, "capped")
      check(after.width === 120, `typing W 120 on a padded content-box element drew ${after.width}`)
      agrees(after, "after typing")
    },
  },
  {
    name: "fill-main-axis",
    async run(page) {
      await select(page, "basis")
      await pickMode(page, "size.width", "fill")
      const row = await page.evaluate(() => Math.round(document.getElementById("row").getBoundingClientRect().width))
      const basis = await read(page, "basis")
      const grow = await read(page, "grow")
      check(Math.abs(basis.width - grow.width) <= 1, `Fill on a flex line did not share the line: ${basis.width} vs ${grow.width} of ${row}`)
      check(basis.modeW === "fill", `Fill reads back as ${basis.modeW}`)
      agrees(basis, "after Fill")
    },
  },
  {
    name: "hug-main-axis",
    async run(page) {
      await select(page, "grow")
      await pickMode(page, "size.width", "hug")
      const grow = await read(page, "grow")
      check(grow.width < 100, `Hug left a flex-1 column at ${grow.width}`)
      check(grow.modeW === "hug", `Hug reads back as ${grow.modeW}`)
      agrees(grow, "after Hug")
    },
  },
  {
    name: "scrub-undo",
    async run(page) {
      await select(page, "box")
      const before = await read(page, "box")
      await scrub(page, "size.width", 30)
      const scrubbed = await read(page, "box")
      check(scrubbed.width > before.width, `scrubbing W did not grow the box (${scrubbed.width})`)
      agrees(scrubbed, "after the scrub")
      await undo(page)
      const undone = await read(page, "box")
      check(undone.width === before.width, `Cmd+Z after a scrub left the box at ${undone.width}, not ${before.width}`)
      agrees(undone, "after the undo")
    },
  },
  {
    // The rewind is one mechanism for every numeric field, so it is checked on
    // fields whose previews write different properties.
    name: "scrub-undo-fields",
    async run(page) {
      const cases = [
        { id: "panel", field: "autolayout.gap", property: "rowGap", dx: 12 },
        { id: "panel", field: "autolayout.padding-x", property: "paddingLeft", dx: 8 },
        { id: "box", field: "appearance.radius", property: "borderTopLeftRadius", dx: 10 },
        { id: "box", field: "appearance.opacity", property: "opacity", dx: -20 },
        { id: "copy", field: "type.size", property: "fontSize", dx: 6 },
      ]
      for (const entry of cases) {
        await select(page, entry.id)
        const value = () => page.evaluate(({ id, property }) => getComputedStyle(document.getElementById(id))[property], entry)
        const before = await value()
        await scrub(page, entry.field, entry.dx)
        const scrubbed = await value()
        check(scrubbed !== before, `scrubbing ${entry.field} changed nothing (${before})`)
        const canUndo = await page.evaluate(() => {
          const button = [...document.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === "Undo")
          return button ? !button.disabled : false
        })
        check(canUndo, `a scrub of ${entry.field} left nothing to undo`)
        await undo(page)
        check((await value()) === before, `Cmd+Z after scrubbing ${entry.field} left ${await value()}, not ${before}`)
      }
    },
  },
  {
    name: "resize-undo",
    async run(page) {
      await select(page, "grow")
      const before = await read(page, "grow")
      await dragHandle(page, "e", -40)
      await sleep(150)
      const resized = await read(page, "grow")
      check(resized.width === before.width - 40, `the resize to undo never happened (${before.width} → ${resized.width})`)
      await undo(page)
      const undone = await read(page, "grow")
      check(undone.width === before.width, `Cmd+Z after a resize left the column at ${undone.width}, not ${before.width}`)
      agrees(undone, "after the undo")
    },
  },
  {
    name: "window-resize",
    async run(page) {
      await select(page, "banner")
      const before = await read(page, "banner")
      await page.setViewportSize({ width: 1300, height: 800 })
      await sleep(400)
      const after = await read(page, "banner")
      check(after.width < before.width, `the window resize did not narrow the banner (${before.width} → ${after.width})`)
      agrees(after, "after the window resized")
      await page.setViewportSize({ width: 1440, height: 900 })
    },
  },
  {
    // Last, because it rewrites the host's source; `main` puts it back.
    name: "apply-resize",
    async run(page) {
      await select(page, "grow")
      await dragHandle(page, "e", -40)
      await sleep(150)
      const { width } = await read(page, "grow")
      await applyToCode(page)
      // Off its grow, at the width it was dragged to, in one class list.
      await sourceHas(/id="grow" className="[^"]*\bflex-none\b[^"]*"/)
      await sourceHas(new RegExp(`id="grow" className="[^"]*\\bw-\\[${width - 16}px\\]`))
    },
  },
]

async function main() {
  check(DEPS && fs.existsSync(path.join(DEPS, "vite")), "set DESIGNLAYER_E2E_DEPS to a node_modules with vite, @vitejs/plugin-react, react, react-dom")
  fs.mkdirSync(SHOTS, { recursive: true })
  const ports = { app: await freePort(), proxy: await freePort(), ws: await freePort(), mcp: await freePort() }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-resize-e2e-"))
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
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  page.setDefaultTimeout(WAIT)
  const logs = []
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`))
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))

  const results = []
  for (const flow of FLOWS.filter((f) => !only || f.name === only)) {
    try {
      await open(page, url)
      await flow.run(page)
      console.log(`ok ${flow.name}`)
      results.push(true)
    } catch (error) {
      console.log(`FAIL ${flow.name} — ${error instanceof Fail ? error.message : error.stack}`)
      await page.screenshot({ path: path.join(SHOTS, `fail-${flow.name}.png`) }).catch(() => {})
      results.push(false)
    }
  }
  fs.writeFileSync(path.join(tmpDir, "src", "App.jsx"), APP)
  const errors = logs.filter((l) => l.startsWith("error") || l.startsWith("pageerror"))
  if (errors.length) console.log(`console errors (${errors.length}):\n  ${errors.slice(0, 5).join("\n  ")}`)
  const passed = results.filter(Boolean).length
  console.log(`\n${passed}/${results.length} flows passed; failure shots in ${path.relative(ROOT, SHOTS)}/`)
  return passed === results.length && errors.length === 0 ? 0 : 1
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
