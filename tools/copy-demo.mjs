#!/usr/bin/env node
/**
 * The copy audit, rendered as a page you decide from.
 *
 * Fourth of the before/after tools, and like `cheatsheet-demo.mjs` its "before"
 * is a SNAPSHOT rather than a git revision: the working tree carries other
 * sessions' uncommitted work, so the before is a copy of `src/`, `runtime/` and
 * `tools/` in `.worktrees/copy-before/`. The after is that snapshot with every
 * rewrite in `tools/copy-audit-edits.mjs` applied, in `.worktrees/copy-after/`.
 * The working tree is only read, never written.
 *
 *   node tools/copy-demo.mjs            # apply, patch, render, build the page
 *   node tools/copy-demo.mjs --no-shots # page and patch only
 *
 * Output lands in `.demos/copy/`, which is gitignored:
 *   index.html           the review page (self-contained, images inlined)
 *   copy-audit.patch     every rewrite as one patch against the snapshot
 */

import { build } from "esbuild"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { EDITS, SURFACES } from "./copy-audit-edits.mjs"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT = path.join(ROOT, ".demos", "copy")
const BEFORE = path.join(ROOT, ".worktrees", "copy-before")
const AFTER = path.join(ROOT, ".worktrees", "copy-after")
const wantShots = !process.argv.includes("--no-shots")

/* ---------- 1. the after tree ---------- */

function applyEdits() {
  if (!fs.existsSync(path.join(BEFORE, "src"))) {
    throw new Error(`No snapshot at ${BEFORE}. Copy src/, runtime/ and tools/ there first.`)
  }
  for (const dir of ["src", "runtime"]) {
    execFileSync("rsync", ["-a", "--delete", `${path.join(BEFORE, dir)}/`, `${path.join(AFTER, dir)}/`])
  }
  const problems = []
  for (const edit of EDITS) {
    for (const file of edit.files ?? [edit.file]) {
      const target = path.join(AFTER, file)
      const source = fs.readFileSync(target, "utf8")
      const count = source.split(edit.find).length - 1
      if (count === 0 || (count > 1 && !edit.all)) {
        problems.push(`${edit.id}: ${file} has ${count} matches`)
        continue
      }
      fs.writeFileSync(target, source.split(edit.find).join(edit.replace))
    }
  }
  if (problems.length) throw new Error(`Edits did not apply:\n  ${problems.join("\n  ")}`)
  console.log(`Applied   ${EDITS.length} rewrites to ${path.relative(ROOT, AFTER)}`)
}

function writePatch() {
  const result = spawnSync(
    "git",
    ["diff", "--no-index", "--no-color", "copy-before/src", "copy-after/src"],
    { cwd: path.join(ROOT, ".worktrees"), encoding: "utf8" }
  )
  const runtime = spawnSync(
    "git",
    ["diff", "--no-index", "--no-color", "copy-before/runtime", "copy-after/runtime"],
    { cwd: path.join(ROOT, ".worktrees"), encoding: "utf8" }
  )
  const patch = (result.stdout + runtime.stdout)
    .replaceAll("a/copy-before/", "a/")
    .replaceAll("b/copy-after/", "b/")
  const file = path.join(OUT, "copy-audit.patch")
  fs.writeFileSync(file, patch)
  console.log(`Patch     ${path.relative(ROOT, file)} (${patch.split("\n").length} lines)`)
  return patch
}

/* ---------- 2. screenshots ---------- */

const SCENES = [
  { id: "designEmpty", title: "Design tab, nothing selected", width: 260 },
  { id: "typography", title: "Design tab, a <p> selected — Typography's vertical-align hint", width: 260, crop: ".de-hint" },
  { id: "changes", title: "Changes tab with notes, edits and settings open", width: 260 },
  { id: "designSystem", title: "Design system tab — libraries and DS lint", width: 260 },
  { id: "layersEmpty", title: "Layers, before anything renders", width: 260 },
  { id: "codeEmpty", title: "Code, nothing selected", width: 260 },
  { id: "controlsEmpty", title: "Controls, no control panel configured", width: 260 },
  { id: "chooserEmpty", title: "App chooser with only this app running", width: 280, viewport: { width: 330, height: 300 }, page: true },
  { id: "shortcuts", title: "Keyboard shortcuts sheet", width: 1000, viewport: { width: 1040, height: 1300 } },
]

async function bundleScene(tree) {
  fs.copyFileSync(path.join(ROOT, "tools", "copy-demo-scene.js"), path.join(tree, "tools", "copy-demo-scene.js"))
  const result = await build({
    entryPoints: [path.join(tree, "tools", "copy-demo-scene.js")],
    bundle: true,
    format: "iife",
    write: false,
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    loader: { ".ts": "ts" },
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  })
  return result.outputFiles[0].text
}

function loadPlaywright() {
  const candidates = [
    path.join(ROOT, "package.json"),
    "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright/package.json",
    "/opt/homebrew/lib/node_modules/playwright/package.json",
  ]
  for (const anchor of candidates) {
    try {
      return createRequire(anchor)(anchor.includes("node_modules/playwright") ? path.dirname(anchor) : "playwright")
    } catch {
      /* next */
    }
  }
  return null
}

const pageFor = (code) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0e0f11}body{padding:16px}</style></head><body><script>${code.replace(/<\/script/gi, "<\\/script")}</script></body></html>`

async function shootChrome(browser, code, scene, theme) {
  const page = await browser.newPage({
    viewport: scene.viewport ?? { width: scene.width + 40, height: 1700 },
    deviceScaleFactor: 2,
  })
  const errors = []
  page.on("pageerror", (error) => errors.push(String(error)))
  await page.setContent(pageFor(code), { waitUntil: "load" })
  await page.evaluate(({ id, theme }) => window.__copy.run(id, theme), { id: scene.id, theme }).catch((error) =>
    errors.push(String(error))
  )
  await page.waitForTimeout(300)
  let shot = null
  const target = scene.crop
    ? page.locator(`[data-copy-shot] ${scene.crop}`).last()
    : page.locator("[data-copy-shot]").first()
  try {
    if (scene.page) {
      shot = await page.screenshot()
    } else if (scene.crop) {
      // The hint plus its section, so the reader sees where it sits.
      const box = await page.evaluate((sel) => {
        const hint = [...document.querySelectorAll(`[data-copy-shot] ${sel}`)].pop()
        const section = hint?.closest(".de-section") ?? hint
        section?.scrollIntoView()
        const r = section.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }, scene.crop)
      shot = await page.screenshot({ clip: box })
    } else {
      // Trim trailing empty panel height so the pair is comparable.
      await page.evaluate(() => {
        const node = document.querySelector("[data-copy-shot]")
        if (node.tagName === "DIALOG") return
        const kids = [...node.querySelectorAll("*")].filter((n) => n.children.length === 0 && n.getClientRects().length && n.getBoundingClientRect().height > 0)
        const bottom = Math.max(...kids.map((n) => n.getBoundingClientRect().bottom), 0)
        const top = node.getBoundingClientRect().top
        node.style.height = `${Math.ceil(bottom - top + 12)}px`
      })
      shot = await target.screenshot()
    }
  } catch (error) {
    errors.push(String(error))
  }
  await page.close()
  return { shot, errors }
}

const START_STATES = [
  { id: "start-waiting", title: "Start screen, waiting for the app", drive: "starting" },
]

function startStub() {
  return `<script>window.fetch = async (t) => { const u = new URL(t, "http://127.0.0.1:3455");
    if (u.pathname === "/api/apps") return { ok: true, status: 200, json: async () => ({ apps: [] }) };
    if (u.pathname === "/api/status") return { ok: true, status: 200, json: async () => ({ ready: false, editing: null, stopped: null }) };
    if (u.pathname === "/api/project") return { ok: true, status: 200, json: async () => ({ project: { path: "/Users/you/Projects/host-app", name: "host-app", exists: true, isDirectory: true, hasPackageJson: true, packageName: "host-app", hasReact: true, devScripts: ["dev"], framework: "nextjs" } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) } }</script>`
}

async function shootStart(browser, tree) {
  const mod = await import(pathToFileURL(path.join(tree, "runtime", "start-screen-page.mjs")).href + `?t=${Date.now()}`)
  const html = mod.startScreenPage().replace("</head>", `${startStub()}</head>`)
  const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 })
  await page.setContent(html, { waitUntil: "load" })
  await page.waitForTimeout(250)
  await page.evaluate(async () => {
    const set = (id, v) => {
      const n = document.getElementById(id)
      n.value = v
      n.dispatchEvent(new Event("input", { bubbles: true }))
    }
    set("url", "http://127.0.0.1:3000")
    set("folder-path", "/Users/you/Projects/host-app")
    await new Promise((r) => setTimeout(r, 500))
    document.getElementById("submit").click()
    await new Promise((r) => setTimeout(r, 300))
  })
  const shot = await page.locator("main.card").screenshot()
  await page.close()
  return shot
}

async function screenshots() {
  const playwright = loadPlaywright()
  if (!playwright) {
    console.log("Playwright not found; skipping screenshots.")
    return []
  }
  const browser = await playwright.chromium.launch()
  const [beforeCode, afterCode] = await Promise.all([bundleScene(BEFORE), bundleScene(AFTER)])
  const rows = []
  for (const scene of SCENES) {
    const before = await shootChrome(browser, beforeCode, scene, "dark")
    const after = await shootChrome(browser, afterCode, scene, "dark")
    const errors = [...before.errors, ...after.errors]
    if (errors.length) console.log(`  ${scene.id}: ${errors[0].slice(0, 160)}`)
    rows.push({ ...scene, before: before.shot, after: after.shot })
    if (before.shot) fs.writeFileSync(path.join(OUT, `${scene.id}-before.png`), before.shot)
    if (after.shot) fs.writeFileSync(path.join(OUT, `${scene.id}-after.png`), after.shot)
    console.log(`Shot      ${scene.id}`)
  }
  for (const state of START_STATES) {
    rows.push({ ...state, before: await shootStart(browser, BEFORE), after: await shootStart(browser, AFTER) })
    console.log(`Shot      ${state.id}`)
  }
  await browser.close()
  return rows
}

/* ---------- 3. the page ---------- */

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length
const img = (buf) => (buf ? `<img src="data:image/png;base64,${buf.toString("base64")}" alt="">` : `<div class="missing">not rendered</div>`)

function pageHtml(shots) {
  const totalBefore = EDITS.reduce((n, e) => n + words(e.before), 0)
  const totalAfter = EDITS.reduce((n, e) => n + words(e.after), 0)
  const tags = { cut: 0, clarify: 0, jargon: 0, consistency: 0 }
  for (const e of EDITS) tags[e.tag]++

  const shotRows = shots
    .map(
      (s) => `<figure class="shot"><figcaption>${esc(s.title)}</figcaption>
      <div class="pair"><div><span class="side">Before</span>${img(s.before)}</div><div><span class="side after">After</span>${img(s.after)}</div></div></figure>`
    )
    .join("")

  const groups = SURFACES.map((surface) => {
    const items = EDITS.filter((e) => e.surface === surface)
    if (!items.length) return ""
    const rows = items
      .map((e) => {
        const b = words(e.before)
        const a = words(e.after)
        return `<article class="item" data-id="${e.id}" data-tag="${e.tag}">
  <header><span class="tag tag-${e.tag}">${e.tag}</span><span class="slot">${esc(e.slot)}</span><code class="file">${esc((e.files ?? [e.file]).join(", "))}</code><span class="wc">${b} → ${a} words</span></header>
  <div class="texts"><div class="before"><span class="side">Before</span><p>${esc(e.before)}</p></div><div class="after"><span class="side after">After</span><p class="after-text">${esc(e.after)}</p></div></div>
  <p class="why">${esc(e.why)}</p>
  <div class="decide">
    <label><input type="radio" name="d-${e.id}" value="accept"> Accept</label>
    <label><input type="radio" name="d-${e.id}" value="reject"> Keep original</label>
    <label><input type="radio" name="d-${e.id}" value="edit"> Use my wording</label>
    <input class="mine" type="text" placeholder="Your wording or a comment" aria-label="Your wording or a comment for ${e.id}">
  </div>
</article>`
      })
      .join("")
    return `<section class="group"><h2>${esc(surface)} <span>${items.length}</span></h2>${rows}</section>`
  }).join("")

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DesignLayer copy audit — before and after</title>
<style>
:root{color-scheme:dark;--bg:#111214;--card:#1a1b1e;--line:#2a2c31;--text:#e8e9ec;--dim:#9a9ea8;--accent:#6c8cff;--ok:#4cc38a;--bad:#e5684f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 24px 120px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:40px 0 12px;padding-top:16px;border-top:1px solid var(--line)}h2 span{color:var(--dim);font-weight:400}
.lede{color:var(--dim);margin:0 0 20px;max-width:70ch}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0 8px}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}.stat b{display:block;font-size:20px}
.rules{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px;margin:16px 0}.rules li{margin:4px 0}
nav{position:sticky;top:0;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);padding:10px 0;z-index:5;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--line)}
button{font:inherit;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
nav .count{color:var(--dim);margin-left:auto}
.shot{margin:0 0 28px}.shot figcaption{color:var(--dim);margin-bottom:8px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}.pair>div{background:#0b0c0d;border:1px solid var(--line);border-radius:10px;padding:10px;overflow:auto}.pair img{max-width:100%;height:auto;display:block;margin:6px auto 0}
.side{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--bad)}.side.after{color:var(--ok)}
.item{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 10px}
.item header{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--dim)}.file{font:11px ui-monospace,Menlo,monospace}.wc{margin-left:auto}
.tag{font-size:11px;padding:1px 8px;border-radius:99px;font-weight:600}.tag-cut{background:#23324d;color:#9db7ff}.tag-clarify{background:#2c3b2c;color:#9fe0a8}.tag-jargon{background:#45301f;color:#ffb987}.tag-consistency{background:#3b2a47;color:#d9a8ff}
.texts{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:8px 0}.texts p{margin:4px 0 0}.before p{color:#c9b4ae;text-decoration:line-through;text-decoration-color:#e5684f66}.after p{color:#e8fff0}
.why{color:var(--dim);margin:0 0 8px;font-size:13px}
.decide{display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:13px}.decide .mine{flex:1;min-width:220px;background:#111;border:1px solid var(--line);color:var(--text);border-radius:6px;padding:5px 8px;font:inherit}
.item[data-state=accept]{border-color:#2f6b4c}.item[data-state=reject]{border-color:#6b3a2f;opacity:.75}.item[data-state=edit]{border-color:#5a4a8a}
.item.hidden{display:none}.missing{color:var(--dim);padding:40px;text-align:center}
textarea#out{width:100%;height:260px;background:#0b0c0d;color:var(--text);border:1px solid var(--line);border-radius:8px;font:12px ui-monospace,Menlo,monospace;padding:10px}
@media (max-width:800px){.texts,.pair{grid-template-columns:1fr}}
</style></head><body><main>
<h1>DesignLayer copy audit</h1>
<p class="lede">${EDITS.length} rewrites of labels, tooltips, hints, empty states, toasts and errors across ${SURFACES.length} surfaces. The screenshots come from real builds of the snapshot before and after the edits. Nothing in the working tree has changed. Pick a decision on each row, then press <b>Export decisions</b> and paste the result back to the agent.</p>
<div class="stats">
  <div class="stat"><b>${EDITS.length}</b>rewrites</div>
  <div class="stat"><b>${totalBefore} → ${totalAfter}</b>words (−${Math.round((1 - totalAfter / totalBefore) * 100)}%)</div>
  <div class="stat"><b>${tags.cut}</b>cut</div><div class="stat"><b>${tags.clarify}</b>clarify</div><div class="stat"><b>${tags.jargon}</b>jargon</div><div class="stat"><b>${tags.consistency}</b>consistency</div>
</div>
<ol class="rules">
  <li><b>One job per slot.</b> Titles name the thing, bodies add the missing fact, and buttons name the action. None of them repeats another.</li>
  <li><b>Say the outcome, not the mechanism.</b> No “source writer”, “bindings”, “surface”, “route”, “compiles” or file names like <code>core/tailwind.ts</code>.</li>
  <li><b>Don’t narrate the tool.</b> “The editor could not…” becomes “Could not…”. The server is “the DesignLayer server”, not “the editor’s own server”.</li>
  <li><b>One word per concept.</b> Note pins are <i>pins</i> (lint keeps <i>markers</i>), saved styles are <i>styles</i> (not options), responsive sizes are <i>breakpoints</i> (not steps), and Ignore is <i>Ignore</i> (not Dismiss).</li>
  <li><b>Errors: cause, then fix.</b> One sentence each, ending on something you can do.</li>
</ol>
<nav>
  <button data-filter="all" class="primary">All</button><button data-filter="cut">Cut</button><button data-filter="clarify">Clarify</button><button data-filter="jargon">Jargon</button><button data-filter="consistency">Consistency</button><button data-filter="undecided">Undecided</button>
  <button id="accept-rest">Accept all undecided</button><button id="export" class="primary">Export decisions</button><span class="count" id="count"></span>
</nav>
<h2>Rendered surfaces <span>${shots.length}</span></h2>
${shotRows || '<p class="lede">Screenshots were skipped.</p>'}
<h2>Every rewrite <span>${EDITS.length}</span></h2>
${groups}
<h2>Export</h2>
<p class="lede">Paste this back into the session. Your decisions are also saved in this browser.</p>
<textarea id="out" readonly></textarea>
</main>
<script>
const KEY = "designlayer-copy-audit-v1"
const state = JSON.parse(localStorage.getItem(KEY) || "{}")
const items = [...document.querySelectorAll(".item")]
function save(){ localStorage.setItem(KEY, JSON.stringify(state)); count() }
function paint(item){ const s = state[item.dataset.id] || {}; item.dataset.state = s.d || ""; const r = item.querySelector('input[value="'+s.d+'"]'); if (r) r.checked = true; item.querySelector(".mine").value = s.text || "" }
function count(){ const d = items.filter(i => state[i.dataset.id]?.d).length; document.getElementById("count").textContent = d + " / " + items.length + " decided" }
items.forEach(item => {
  paint(item)
  item.querySelectorAll('input[type=radio]').forEach(r => r.addEventListener("change", () => { state[item.dataset.id] = { ...(state[item.dataset.id]||{}), d: r.value }; paint(item); save() }))
  item.querySelector(".mine").addEventListener("input", e => { const s = state[item.dataset.id] = { ...(state[item.dataset.id]||{}), text: e.target.value }; if (e.target.value && !s.d) s.d = "edit"; paint(item); save() })
})
document.querySelectorAll("nav [data-filter]").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("nav [data-filter]").forEach(x => x.classList.toggle("primary", x === b))
  const f = b.dataset.filter
  items.forEach(i => i.classList.toggle("hidden", !(f === "all" || (f === "undecided" ? !state[i.dataset.id]?.d : i.dataset.tag === f))))
}))
document.getElementById("accept-rest").addEventListener("click", () => { items.forEach(i => { if (!state[i.dataset.id]?.d) state[i.dataset.id] = { ...(state[i.dataset.id]||{}), d: "accept" }; paint(i) }); save() })
document.getElementById("export").addEventListener("click", () => {
  const g = { accept: [], reject: [], edit: [], undecided: [] }
  items.forEach(i => { const s = state[i.dataset.id] || {}; const line = i.dataset.id + (s.text ? " — " + s.text : ""); (g[s.d] || g.undecided).push(line) })
  const out = ["## Copy audit decisions", "", "Accept (" + g.accept.length + "): " + (g.accept.join(", ") || "none"), "", "Keep original (" + g.reject.length + "):", ...g.reject.map(x => "- " + x), "", "Use my wording (" + g.edit.length + "):", ...g.edit.map(x => "- " + x), "", "Undecided (" + g.undecided.length + "): " + (g.undecided.join(", ") || "none")].join("\\n")
  const ta = document.getElementById("out"); ta.value = out; ta.scrollIntoView({ behavior: "smooth" }); navigator.clipboard?.writeText(out).catch(() => {})
})
count()
</script></body></html>`
}

/* ---------- run ---------- */

fs.mkdirSync(OUT, { recursive: true })
applyEdits()
writePatch()
const shots = wantShots ? await screenshots() : []
const file = path.join(OUT, "index.html")
fs.writeFileSync(file, pageHtml(shots))
console.log(`Page      ${file}`)
