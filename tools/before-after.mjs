#!/usr/bin/env node
/**
 * Renders the same interface state twice — as it was, and as it is — and builds
 * one page you can flip through to accept or reject each change.
 *
 * This is review tooling, not part of the editor: nothing under `src/`,
 * `server/` or `runtime/` knows it exists, and it only ever reads them. It is
 * the sibling of `tools/panel-harness.mjs`, which measures ONE revision against
 * a Figma frame; this one measures two revisions against each other.
 *
 * ## How "before" is obtained
 *
 * From git, not from a copy kept by hand. `--before=<rev>` names any revision
 * and the surface modules are read out of it with `git show`, written to a
 * scratch directory, and imported from there. A hand-maintained "before" is a
 * second source of truth that starts drifting the day it is written, and the
 * whole value of this page is that the left-hand column is really what shipped.
 *
 * Only the start screen can be done this way today, and the reason is the seam
 * rather than an omission: it is a self-contained document produced by a pure
 * function of no arguments, so an old revision of it renders with no editor, no
 * host app and no dev server. The editor chrome needs all three, which is what
 * `panel-harness.mjs` exists to stand up; extending this tool to cover it means
 * teaching it that harness's scene, not adding another `git show`.
 *
 *   node tools/before-after.mjs                    # against HEAD
 *   node tools/before-after.mjs --before=6681a93   # against a named revision
 *   node tools/before-after.mjs --open             # and open the page after
 *   node tools/before-after.mjs --no-shots         # page only, no browser
 *
 * Output lands in `.demos/` at the repo root, which is gitignored.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT = path.join(ROOT, ".demos")

const args = process.argv.slice(2)
const flags = new Set(args)
const wantShots = !flags.has("--no-shots")
const beforeRev = (args.find((arg) => arg.startsWith("--before=")) ?? "--before=HEAD").slice(
  "--before=".length
)

/** The viewport every shot is taken at. Wide enough for the card, no wider. */
const VIEWPORT = { width: 900, height: 1000 }

/*
 * The three modules the start screen is: the document, its stylesheet, and the
 * token bundle both of them resolve through. The bundle is taken from the
 * WORKING TREE in both columns on purpose — it is a build artifact, `dist/` is
 * gitignored, and an old revision of it usually does not exist to be read. That
 * makes the comparison one of the page and its stylesheet against themselves,
 * which is what actually changed.
 */
const SURFACE_FILES = ["runtime/start-screen-page.mjs", "runtime/start-screen-style.mjs"]

function git(...argv) {
  return execFileSync("git", argv, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
}

/**
 * A revision's copy of the surface, on disk and importable.
 *
 * The scratch tree mirrors the repo's own layout rather than flattening the
 * files into one directory, because `start-screen-page.mjs` imports its
 * stylesheet by relative path and `start-screen-style.mjs` imports the token
 * bundle by `../dist/tokens.mjs`. Both resolve correctly only if the shape is
 * the shape they were written against.
 */
function checkoutSurface(rev) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `de-before-${rev.replace(/\W/g, "")}-`))
  for (const file of SURFACE_FILES) {
    const target = path.join(dir, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, git("show", `${rev}:${file}`))
  }
  // The token bundle, symlinked from the working tree. See SURFACE_FILES.
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true })
  fs.symlinkSync(path.join(ROOT, "dist", "tokens.mjs"), path.join(dir, "dist", "tokens.mjs"))
  return dir
}

/* ---------- the states, and how each one is driven ---------- */

/**
 * Every state worth showing, as a name, a why, and the script that produces it.
 *
 * `drive` runs INSIDE the rendered page, against whichever revision built it,
 * so it may only touch things both revisions have: element ids, the three
 * routes, and the DOM. Anything it reaches for that one side lacks is a state
 * that cannot be compared, and it should be written to degrade rather than
 * throw — the page is more useful with one panel empty and labelled than with
 * a column missing.
 */
const STATES = [
  {
    id: "cold-boot",
    title: "Cold boot, nothing running",
    why:
      "The commonest first state, and the one the user named. Before: two empty fields, " +
      "a disabled grey button, and no sentence anywhere saying what the screen wants.",
    apps: [],
    drive: "",
  },
  {
    id: "cold-boot-pressed",
    title: "Cold boot, the button pressed",
    why:
      "What pressing the primary action gets you with nothing filled in. Before: nothing at " +
      "all — the button is disabled, so the press never happens.",
    apps: [],
    drive: `
      document.getElementById("submit").click()
      await new Promise((r) => setTimeout(r, 60))
    `,
  },
  {
    id: "apps-found",
    title: "Two dev servers found, one picked for you",
    why:
      "A choice was made on the user's behalf. Before: the only mark was a row tint at " +
      "1.44:1 whose border resolved to the same color as its fill.",
    apps: [
      { port: 3000, url: "http://127.0.0.1:3000", title: "Host App", projectRoot: "/Users/you/Projects/host-app", packageName: "host-app" },
      { port: 3001, url: "http://127.0.0.1:3001", title: "127.0.0.1:3001", projectRoot: null, packageName: null },
    ],
    drive: "",
  },
  {
    id: "unknown-folder",
    title: "An app whose code folder cannot be found",
    why:
      "The second row has no resolvable project root. The editor has to ask, and the asking " +
      "is what this state is judged on.",
    apps: [
      { port: 3000, url: "http://127.0.0.1:3000", title: "Host App", projectRoot: "/Users/you/Projects/host-app", packageName: "host-app" },
      { port: 3001, url: "http://127.0.0.1:3001", title: "127.0.0.1:3001", projectRoot: null, packageName: null },
    ],
    drive: `
      const rows = [...document.getElementById("apps").children]
      rows[1].click()
      await new Promise((r) => setTimeout(r, 80))
    `,
  },
  {
    id: "wrong-folder",
    title: "A folder with no package.json in it",
    why:
      "Pointing at a parent directory. Before: reported as a package.json with no dev " +
      "script — untrue, about a file that does not exist, and with nothing to try next.",
    apps: [],
    project: {
      path: "/Users/you/Projects",
      name: "Projects",
      exists: true,
      isDirectory: true,
      hasPackageJson: false,
      packageName: null,
      hasReact: false,
      devScripts: [],
      framework: null,
    },
    drive: `
      const url = document.getElementById("url")
      url.value = "http://127.0.0.1:3000"
      url.dispatchEvent(new Event("input", { bubbles: true }))
      const folder = document.getElementById("folder-path")
      folder.value = "/Users/you/Projects"
      folder.dispatchEvent(new Event("input", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 500))
    `,
  },
  {
    id: "ready",
    title: "Both answers given, ready to start",
    why:
      "The state the whole form is for. Judged on whether the screen says what the button " +
      "is about to do before it is pressed.",
    apps: [],
    drive: `
      const url = document.getElementById("url")
      url.value = "http://127.0.0.1:3000"
      url.dispatchEvent(new Event("input", { bubbles: true }))
      const folder = document.getElementById("folder-path")
      folder.value = "/Users/you/Projects/host-app"
      folder.dispatchEvent(new Event("input", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 500))
    `,
  },
  {
    id: "scan-failed",
    title: "The scan for running apps failed",
    why:
      "Before: an error saying the scan could not run, directly above a note saying nothing " +
      "is running. Two contradictory sentences, and the wrong one is the dangerous one.",
    apps: "fail",
    drive: "",
  },
  {
    id: "starting",
    title: "Waiting for the app to come up",
    why:
      "Focus, and the way out. Before: the form is hidden while the submit button holds " +
      "focus, so the page is left with zero tab stops and no cancel.",
    apps: [],
    drive: `
      const url = document.getElementById("url")
      url.value = "http://127.0.0.1:3000"
      url.dispatchEvent(new Event("input", { bubbles: true }))
      const folder = document.getElementById("folder-path")
      folder.value = "/Users/you/Projects/host-app"
      folder.dispatchEvent(new Event("input", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 500))
      document.getElementById("submit").click()
      await new Promise((r) => setTimeout(r, 200))
    `,
  },
  {
    id: "crashed",
    title: "The editor died on the way up",
    why:
      "Before: styled as a muted note, so a crash reads like a tip, and the sentence ends " +
      "without naming anything to do about it.",
    apps: [],
    stopped:
      "The editor for host-app stopped with code 1. Its output is in the terminal running designlayer. Pick an app below to try again.",
    drive: "",
  },
]

/** The canned server, as a string the page can be initialized with. */
function stubFetch(state) {
  const project = state.project ?? {
    path: "/Users/you/Projects/host-app",
    name: "host-app",
    exists: true,
    isDirectory: true,
    hasPackageJson: true,
    packageName: "host-app",
    hasReact: true,
    devScripts: ["dev"],
    framework: "nextjs",
  }
  return `
    const APPS = ${JSON.stringify(state.apps === "fail" ? [] : state.apps)}
    const APPS_FAIL = ${JSON.stringify(state.apps === "fail")}
    const PROJECT = ${JSON.stringify(project)}
    const STOPPED = ${JSON.stringify(state.stopped ?? null)}
    window.fetch = async (target) => {
      /*
       * A literal base, not \`location.origin\`.
       *
       * The document is installed with \`setContent\` on an \`about:blank\` page,
       * where \`location.origin\` is the STRING "null" — and \`new URL(path, "null")\`
       * throws, so every route fell into the page's own network-failure branch
       * and every panel rendered the same "could not check what is running"
       * state. The page only ever asks for same-origin paths, so any valid base
       * will do and a fixed one cannot be wrong.
       */
      const url = new URL(target, "http://127.0.0.1:3455")
      if (url.pathname === "/api/apps") {
        if (APPS_FAIL) throw new TypeError("Failed to fetch")
        return { ok: true, status: 200, json: async () => ({ apps: APPS }) }
      }
      if (url.pathname === "/api/status") {
        return { ok: true, status: 200, json: async () => ({ ready: false, editing: null, stopped: STOPPED }) }
      }
      if (url.pathname === "/api/project") {
        return { ok: true, status: 200, json: async () => ({ project: PROJECT }) }
      }
      // /api/start, and anything else: accepted, then never ready. The waiting
      // state is a state to look at here, not a thing to get out of.
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
  `
}

/* ---------- Playwright, borrowed rather than depended on ---------- */

/*
 * Same resolution order as `panel-harness.mjs`, and for the same reason: this
 * repo does not depend on Playwright and should not start. See the long note
 * in that file.
 */
async function loadPlaywright() {
  const anchors = []
  const localRequire = createRequire(path.join(ROOT, "package.json"))
  try {
    return localRequire("playwright")
  } catch {
    /* not a dependency here, which is the expected case */
  }
  let globalRoot = null
  try {
    globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim()
  } catch {
    /* npm may not be on PATH in a sandbox */
  }
  for (const root of [globalRoot, "/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"]) {
    if (!root) continue
    anchors.push(path.join(root, "@playwright", "mcp", "cli.js"))
    anchors.push(path.join(root, "playwright", "index.js"))
  }
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)("playwright")
    } catch {
      /* try the next one */
    }
  }
  return null
}

/* ---------- what each shot reports beyond the pixels ---------- */

/**
 * The four numbers that carry most of this rework, measured in the page.
 *
 * Screenshots argue about taste; these do not. "Two tab stops and no button" is
 * the finding, and it is the kind of thing a reviewer should not have to count
 * off an image.
 */
const PROBE = `(() => {
  const visible = (node) => {
    const style = getComputedStyle(node)
    return style.display !== "none" && style.visibility !== "hidden" && node.offsetParent !== null
  }
  /*
   * A real Tab count, which means honouring \`tabindex\` rather than matching on
   * the tag. A \`<button tabindex="-1">\` is still a \`button\`, so selecting by tag
   * counted all of a roving-tabindex radiogroup's rows and reported the group as
   * N stops when the whole point of it is that the group is one.
   */
  const focusable = [...document.querySelectorAll(
    "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]"
  )].filter((node) => visible(node) && node.tabIndex >= 0)
  const live = [...document.querySelectorAll("[aria-live], [role=status], [role=alert]")]
  // `.lede` for revisions before the app name became the face's `.title`.
  const said = [...document.querySelectorAll(".note, .error, .lede, .title")]
    .filter((node) => visible(node) && node.textContent.trim() !== "")
    .map((node) => node.textContent.trim())
  return {
    tabStops: focusable.length,
    headings: document.querySelectorAll("h1, h2, h3").length,
    liveRegions: live.length,
    disabledActions: [...document.querySelectorAll("button[disabled]")].length,
    sentences: said,
  }
})()`

/**
 * The canned server, spliced into the document rather than installed on the page.
 *
 * `addInitScript` is the obvious way and it silently does not work here: it runs
 * on NAVIGATION, and `setContent` replaces the document without one, so the stub
 * was being installed on the `about:blank` that preceded it and thrown away. The
 * symptom was a page that rendered — every panel showed the empty state, every
 * state looked identical, and nothing failed.
 *
 * A classic `<script>` in the head has neither problem: it is ordered before the
 * `<script type="module">` that boots the page, which is deferred by definition,
 * so `window.fetch` is replaced before the first request can be made.
 */
function withStub(html, state) {
  return html.replace("</head>", `<script>${stubFetch(state)}</script>\n</head>`)
}

async function shoot(browser, html, state, label) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 })
  const problems = []
  page.on("pageerror", (error) => problems.push(String(error)))
  // `setContent` rather than a server: the document is self-contained, and the
  // stub above swallows every request it would otherwise make.
  await page.setContent(withStub(html, state), { waitUntil: "load" })
  await page.waitForTimeout(250)
  if (state.drive.trim()) {
    try {
      await page.evaluate(`(async () => { ${state.drive} })()`)
    } catch (error) {
      problems.push(`drive: ${error.message}`)
    }
  }
  await page.waitForTimeout(120)
  const probe = await page.evaluate(PROBE).catch(() => null)
  const file = `${state.id}-${label}.png`
  /*
   * The card plus a margin, not the page.
   *
   * A full-page shot at this viewport is four-fifths empty ground, which costs
   * nothing to render and everything to read: two cards 900px apart on a review
   * page are two things you compare by memory rather than by eye. The margin is
   * kept so the card's shadow and its step off the page — both of which changed
   * here — are still in frame.
   */
  const box = await page.locator("main.card").boundingBox()
  const margin = 24
  await page.screenshot({
    path: path.join(OUT, file),
    clip: box
      ? {
          x: Math.max(0, box.x - margin),
          y: Math.max(0, box.y - margin),
          width: box.width + margin * 2,
          height: box.height + margin * 2,
        }
      : undefined,
    fullPage: !box,
  })
  await page.close()
  return { file, probe, problems }
}

/* ---------- the page ---------- */

const escape = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function metricRow(before, after) {
  if (!before || !after) return ""
  const rows = [
    ["Tab stops", before.tabStops, after.tabStops],
    ["Headings", before.headings, after.headings],
    ["Live regions", before.liveRegions, after.liveRegions],
    ["Disabled controls", before.disabledActions, after.disabledActions],
  ]
    .map(([name, a, b]) => {
      const moved = a !== b ? " moved" : ""
      return `<tr class="${moved.trim()}"><th>${name}</th><td>${a}</td><td>${b}</td></tr>`
    })
    .join("")
  return `<table class="metrics"><thead><tr><th></th><th>Before</th><th>After</th></tr></thead><tbody>${rows}</tbody></table>`
}

function sentenceList(probe, side) {
  if (!probe || !probe.sentences.length) {
    return `<p class="none">No sentence is shown in this state.</p>`
  }
  return `<ul class="said">${probe.sentences
    .map((text) => `<li>${escape(text)}</li>`)
    .join("")}</ul>`
}

function statePanel(state, before, after) {
  const problems = [...before.problems, ...after.problems]
  return `
<section class="state" id="${state.id}">
  <header>
    <h2>${escape(state.title)}</h2>
    <p class="why">${escape(state.why)}</p>
  </header>
  ${metricRow(before.probe, after.probe)}
  <div class="pair">
    <figure>
      <figcaption><span class="tag tag-before">Before</span></figcaption>
      <img src="${before.file}" alt="${escape(state.title)}, before">
      ${sentenceList(before.probe, "before")}
    </figure>
    <figure>
      <figcaption><span class="tag tag-after">After</span></figcaption>
      <img src="${after.file}" alt="${escape(state.title)}, after">
      ${sentenceList(after.probe, "after")}
    </figure>
  </div>
  ${problems.length ? `<p class="problem">${problems.map(escape).join("<br>")}</p>` : ""}
</section>`
}

function buildPage(panels, meta) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>designlayer — the start screen, before and after</title>
<style>
  :root { color-scheme: dark; --ink: #f2f2f2; --dim: rgba(255,255,255,0.62); --line: rgba(255,255,255,0.14); }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 32px 96px;
    background: #1b1b1b; color: var(--ink);
    font: 400 14px/1.6 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  }
  .page { max-width: 1400px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 24px; }
  .meta { margin: 0 0 8px; color: var(--dim); font-size: 13px; }
  .meta code { font-family: ui-monospace, monospace; color: var(--ink); }
  .toc { margin: 24px 0 40px; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 8px; }
  .toc a {
    display: block; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px;
    color: var(--ink); text-decoration: none; font-size: 13px;
  }
  .toc a:hover { border-color: #7cc4f8; }
  .state { margin: 0 0 56px; padding-top: 24px; border-top: 1px solid var(--line); }
  .state h2 { margin: 0 0 4px; font-size: 18px; }
  .why { margin: 0 0 16px; max-width: 78ch; color: var(--dim); }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
  figure { margin: 0; }
  figcaption { margin: 0 0 8px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .tag-before { background: rgba(255,138,101,0.16); color: #ff8a65; }
  .tag-after { background: rgba(124,196,248,0.16); color: #7cc4f8; }
  img { width: 100%; display: block; border: 1px solid var(--line); border-radius: 10px; background: #111; }
  .said { margin: 10px 0 0; padding-left: 18px; font-size: 13px; color: var(--dim); }
  .said li { margin: 2px 0; }
  .none { margin: 10px 0 0; font-size: 13px; color: #ff8a65; }
  .metrics { margin: 0 0 16px; border-collapse: collapse; font-size: 13px; }
  .metrics th, .metrics td { padding: 3px 14px 3px 0; text-align: left; font-weight: 400; color: var(--dim); }
  .metrics thead th { color: var(--ink); font-weight: 600; }
  .metrics tbody th { color: var(--ink); }
  .metrics tr.moved td:last-child { color: #7cc4f8; font-weight: 600; }
  .problem { margin: 12px 0 0; padding: 8px 12px; border-radius: 8px; background: rgba(255,138,101,0.12); color: #ff8a65; font-size: 13px; }
</style>
</head>
<body>
<div class="page">
  <h1>The start screen, before and after</h1>
  <p class="meta">Before is <code>${escape(meta.before)}</code> (${escape(meta.beforeSubject)}). After is the working tree. Rendered at ${VIEWPORT.width}px, 2x, full page. ${escape(meta.generatedAt)}</p>
  <p class="meta">Every "before" panel is rendered from the real revision, read out of git — not from a copy kept by hand.</p>
  <ul class="toc">${panels
    .map((panel) => `<li><a href="#${panel.id}">${escape(panel.title)}</a></li>`)
    .join("")}</ul>
  ${panels.map((panel) => panel.html).join("\n")}
</div>
</body>
</html>
`
}

/* ---------- run ---------- */

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  const head = git("rev-parse", "--short", beforeRev).trim()
  const subject = git("log", "-1", "--format=%s", beforeRev).trim()
  console.log(`before: ${head}  ${subject}`)

  const beforeDir = checkoutSurface(beforeRev)
  const beforePage = await import(
    pathToFileURL(path.join(beforeDir, "runtime/start-screen-page.mjs")).href
  )
  const afterPage = await import(
    pathToFileURL(path.join(ROOT, "runtime/start-screen-page.mjs")).href
  )
  const beforeHtml = beforePage.startScreenPage()
  const afterHtml = afterPage.startScreenPage()

  if (!wantShots) {
    fs.writeFileSync(path.join(OUT, "before.html"), beforeHtml)
    fs.writeFileSync(path.join(OUT, "after.html"), afterHtml)
    console.log(`wrote ${path.relative(ROOT, OUT)}/before.html and after.html`)
    return
  }

  const pw = await loadPlaywright()
  if (!pw) {
    console.error("Playwright was not found. Install it (npm i -D playwright) or rerun with --no-shots.")
    process.exitCode = 1
    return
  }

  const browser = await pw.chromium.launch()
  const panels = []
  for (const state of STATES) {
    process.stdout.write(`  ${state.id}… `)
    const before = await shoot(browser, beforeHtml, state, "before")
    const after = await shoot(browser, afterHtml, state, "after")
    panels.push({ id: state.id, title: state.title, html: statePanel(state, before, after) })
    const moved =
      before.probe && after.probe
        ? `tab stops ${before.probe.tabStops}→${after.probe.tabStops}, live ${before.probe.liveRegions}→${after.probe.liveRegions}`
        : "no probe"
    console.log(moved)
  }
  await browser.close()

  const page = buildPage(panels, {
    before: head,
    beforeSubject: subject,
    generatedAt: new Date().toISOString(),
  })
  const target = path.join(OUT, "index.html")
  fs.writeFileSync(target, page)
  /*
   * A second copy with the images inside it, for anywhere the folder cannot go.
   *
   * The page above references its PNGs by name and is the one to open locally.
   * A review tool, a bug comment or an artifact viewer gets one file or nothing,
   * and a page whose every image is a broken icon is worse than no page — so
   * the same HTML is emitted again with each shot as a data URI.
   */
  const inlined = page.replace(/src="([^"]+\.png)"/g, (whole, file) => {
    const bytes = fs.readFileSync(path.join(OUT, file))
    return `src="data:image/png;base64,${bytes.toString("base64")}"`
  })
  const standalone = path.join(OUT, "standalone.html")
  fs.writeFileSync(standalone, inlined)
  fs.rmSync(beforeDir, { recursive: true, force: true })
  console.log(`\nwrote ${path.relative(ROOT, target)}`)
  console.log(
    `wrote ${path.relative(ROOT, standalone)} (${Math.round(inlined.length / 1024)}kb, images inlined)`
  )
  if (flags.has("--open")) execFileSync("open", [target])
}

await main()
