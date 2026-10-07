#!/usr/bin/env node
/**
 * The editor's own chrome, rendered at two revisions and laid out side by side.
 *
 * The sibling of `tools/before-after.mjs`, which does the same for the start
 * screen. That one can redeclare a few custom properties to reproduce the past,
 * because the start screen is a pure function of no arguments. The chrome is
 * not: these surfaces changed in TypeScript as well as in CSS — a menu that
 * arms before it destroys, a note that takes focus, a card that scrolls — so
 * the only honest "before" is the old code, running.
 *
 * So both columns are real builds. The after column is bundled from the working
 * tree; the before column from a git worktree, which is a second checkout in
 * its own directory and touches the working tree not at all. That matters here
 * beyond tidiness: another agent has uncommitted work interleaved in this tree,
 * and `git stash` would take theirs with mine.
 *
 *   node tools/chrome-demo.mjs                      # against .worktrees/before
 *   node tools/chrome-demo.mjs --before=<rev>       # create the worktree first
 *   node tools/chrome-demo.mjs --open
 *
 * Output lands in `.demos/chrome/`, which is gitignored.
 */

import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT = path.join(ROOT, ".demos", "chrome")
const BEFORE_TREE = path.join(ROOT, ".worktrees", "before")

const args = process.argv.slice(2)
const flags = new Set(args)

const VIEWPORT = { width: 520, height: 620 }

/*
 * The scenarios, each a named state of the app chooser and the reason it is
 * worth a row.
 *
 * `dirty` drives `store.hasChanges()`, which is the whole hinge of the new
 * armed switch: the audit's finding was not "add a confirmation" but "arm only
 * when there is something to lose", so the two rows that differ only in `dirty`
 * are the pair that proves the distinction was kept.
 */
const SCENARIOS = [
  {
    id: "menu-empty",
    title: "The only app running",
    why:
      "Before: “This session was started without the app chooser, so there is nothing to switch " +
      "between” — rendered inside the app chooser, in the shape the registry calls the common one.",
    scenario: { apps: [] },
    open: true,
  },
  {
    id: "menu-rows",
    title: "Other apps to switch to",
    why: "The ordinary case. Watch the hover ground and whether a row reads as pressable.",
    scenario: {
      apps: [
        { kind: "editor", label: "shop-web", target: "http://127.0.0.1:3460", url: "http://127.0.0.1:3460", projectRoot: "/Users/you/Projects/shop-web", packageName: "shop-web", placed: true },
        { kind: "app", label: "@acme/design-system-playground", url: "http://127.0.0.1:4200", projectRoot: "/Users/you/Projects/acme-design-system-playground", packageName: "@acme/design-system-playground", placed: true },
        { kind: "app", label: "docs", url: "http://127.0.0.1:5173", projectRoot: null, packageName: null, placed: false },
      ],
    },
    open: true,
  },
  {
    id: "menu-dirty",
    title: "Switching with unapplied edits",
    why:
      "The switch SIGTERMs this editor and the three edit queues are in-memory. Before: one click, " +
      "no confirm, no undo — on a row identical to the safe one beside it.",
    scenario: {
      dirty: true,
      apps: [
        { kind: "app", label: "shop-web", url: "http://127.0.0.1:3460", projectRoot: "/Users/you/Projects/shop-web", packageName: "shop-web", placed: true },
      ],
    },
    open: true,
    press: ".de-app-menu-row",
  },
  {
    id: "menu-many",
    title: "Five editors, short window",
    why:
      "The registry's own notes record five running on the machine this was written on. Before: " +
      "the card had no ceiling and hung off the viewport with no scrollbar.",
    scenario: {
      apps: Array.from({ length: 6 }, (_, i) => ({
        kind: "editor",
        label: `project-${i + 1}`,
        target: `http://127.0.0.1:34${60 + i}`,
        url: `http://127.0.0.1:34${60 + i}`,
        projectRoot: `/Users/you/Projects/project-${i + 1}`,
        packageName: `project-${i + 1}`,
        placed: true,
      })),
    },
    open: true,
    viewport: { width: 520, height: 420 },
  },
  {
    id: "menu-failed",
    title: "The list could not be fetched",
    why: "Before: “Could not reach the editor server to list the running apps.” and nothing else.",
    scenario: { appsFail: true },
    open: true,
  },
  /*
   * The design-options rework, shown as the left panel's tab strip.
   *
   * `surface: "left"` switches the driver from the chooser scene to the whole
   * panel. The before revision has two tabs and no Controls pane; pressing a
   * tab that is not there is a no-op, so that column renders the two-tab strip,
   * which is the comparison.
   */
  /*
   * The spacing findings, which are only legible as a rendered stack.
   *
   * A sub-heading was the bare first child of an 8px column, so it sat 8px from
   * the block it names AND 8px from the one before — a ratio of 1.0 where the
   * grouping rule wants 2. Nothing in the rhythm said which lines belonged
   * together. Rendered at both panel widths, because the narrow one is where a
   * missing boundary costs most.
   */
  {
    id: "inspector-spacing",
    surface: "inspector",
    title: "The inspector's section stack",
    why:
      "Look at where one block ends and the next begins. Before, a sub-heading is the same " +
      "8px from its own content as from the block above it.",
    scenario: { apps: [] },
    viewport: { width: 320, height: 940 },
  },
  {
    id: "inspector-spacing-narrow",
    surface: "inspector",
    title: "The same stack at the 200px minimum",
    why: "The narrow end, where an invisible block boundary costs the most.",
    scenario: { apps: [], panelWidth: 200 },
    viewport: { width: 260, height: 940 },
  },
  /*
   * The Controls pane, which carries four of this round's spacing fixes at
   * once: the filter's band, the scope chips' hover ground and pill caps, and
   * the folder body's gap between rows against the gap inside one.
   */
  {
    id: "controls-density",
    surface: "left",
    title: "The Controls pane's density",
    why:
      "Look at the filter's top edge against the tab strip, the chip caps, and how far apart " +
      "two rows sit compared with a label and its own field.",
    scenario: { apps: [] },
    tab: "Controls",
    viewport: { width: 360, height: 560 },
  },
  {
    id: "left-tabs",
    surface: "left",
    title: "The left panel's tab strip",
    why:
      "Before: Layers | Code, with the app-wide control inventory in a floating dialog that " +
      "mounted its own root “so it survives deselection” — which is the left panel's default.",
    scenario: { apps: [] },
    viewport: { width: 360, height: 600 },
  },
  {
    id: "left-controls",
    surface: "left",
    title: "The Controls pane",
    why:
      "The app-scoped leva inventory, docked. Before: no such pane — this column shows what the " +
      "third tab press finds instead.",
    scenario: { apps: [] },
    tab: "Controls",
    viewport: { width: 360, height: 600 },
  },
]

/**
 * One scene file, compiled against whichever revision's `src/` it is handed.
 *
 * The entry point is the COPY inside the tree rather than the original, and
 * that is the whole mechanism: the scene imports `../src/...` relatively, so a
 * copy sitting in `<tree>/tools/` resolves those imports to `<tree>/src/`
 * without an alias. esbuild rejects a relative alias key outright, and an
 * absolute one would have had to be written per-import anyway.
 */
async function bundleScene(treeRoot) {
  const result = await build({
    entryPoints: [path.join(treeRoot, "tools", "chrome-demo-scene.js")],
    absWorkingDir: treeRoot,
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [path.join(treeRoot, "node_modules")],
  })
  return result.outputFiles[0].text
}

async function loadPlaywright() {
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
    for (const anchor of ["@playwright/mcp/cli.js", "playwright/index.js"]) {
      try {
        return createRequire(path.join(root, anchor))("playwright")
      } catch {
        /* try the next one */
      }
    }
  }
  return null
}

const escape = (v) =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const PROBE = `(() => {
  const vis = (n) => { const s = getComputedStyle(n); return s.display !== "none" && s.visibility !== "hidden" && n.offsetParent !== null }
  const stops = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]')]
    .filter((n) => vis(n) && n.tabIndex >= 0)
  const menu = document.querySelector(".de-app-menu")
  const said = [...document.querySelectorAll(".de-app-menu-note, .de-app-menu-where")]
    .filter((n) => vis(n) && n.textContent.trim())
    .map((n) => n.textContent.trim())
  return {
    tabStops: stops.length,
    live: document.querySelectorAll("[aria-live], [role=status], [role=alert]").length,
    scrolls: menu ? getComputedStyle(menu).overflowY : "—",
    clipped: menu ? Math.round(menu.getBoundingClientRect().bottom) > window.innerHeight : false,
    nativeDisabled: document.querySelectorAll(".de-app-menu-row[disabled]").length,
    armed: document.querySelectorAll(".de-app-menu-row--danger").length,
    tabs: document.documentElement.dataset.demoTabs ?? "—",
    // The floating dialog the options split deletes. Counted rather than
    // described, because "is it still there" is the whole question.
    floatingDialog: document.querySelectorAll(".de-opt-window").length,
    sentences: said.slice(0, 4),
  }
})()`

async function shoot(browser, js, spec, label) {
  const page = await browser.newPage({
    viewport: spec.viewport ?? VIEWPORT,
    deviceScaleFactor: 2,
  })
  const problems = []
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)))
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
       html,body{margin:0;height:100%}
       body{display:flex;align-items:flex-start;padding:16px;
            background:${spec.theme === "light" ? "#f2f2f2" : "#1b1b1b"}}
     </style></head><body></body></html>`,
    { waitUntil: "load" }
  )
  await page.addScriptTag({ content: js })
  try {
    await page.evaluate(
      async ([scenario, theme, open, press, surface, tab]) => {
        if (surface === "inspector") {
          const panel = await window.__demo.inspector(scenario, theme)
          if (tab) await panel.openSection(tab)
          return
        }
        if (surface === "left") {
          const panel = await window.__demo.leftPanel(scenario, theme)
          if (tab) await panel.openTab(tab)
          // Recorded on the document so the probe can report it without a
          // second round trip. A revision with no such tab reports the strip it
          // does have, which is the finding rather than an error.
          document.documentElement.dataset.demoTabs = panel.tabs().join(" | ")
          return
        }
        const built = await window.__demo.scene(scenario, theme)
        if (open) await built.open()
        if (press) document.querySelector(press)?.click()
      },
      [
        spec.scenario,
        spec.theme ?? "dark",
        spec.open,
        spec.press ?? null,
        spec.surface ?? "chooser",
        spec.tab ?? null,
      ]
    )
  } catch (error) {
    problems.push(`drive: ${String(error).slice(0, 200)}`)
  }
  await page.waitForTimeout(160)
  const probe = await page.evaluate(PROBE).catch(() => null)
  const file = `${spec.id}-${label}.png`
  await page.screenshot({ path: path.join(OUT, file) })
  await page.close()
  return { file, probe, problems }
}

function metrics(before, after) {
  if (!before || !after) return ""
  // Only the rows that mean something for this surface. A chooser panel has no
  // tab strip and a panel has no menu, and printing "—" against both halves of
  // six irrelevant rows buries the two that moved.
  const all = [
    ["Tab strip", before.tabs, after.tabs],
    ["Floating dialog", before.floatingDialog, after.floatingDialog],
    ["Tab stops", before.tabStops, after.tabStops],
    ["Live regions", before.live, after.live],
    ["Menu overflow-y", before.scrolls, after.scrolls],
    ["Clipped off-screen", String(before.clipped), String(after.clipped)],
    ["Native disabled rows", before.nativeDisabled, after.nativeDisabled],
    ["Armed rows", before.armed, after.armed],
  ]
  const rows = all.filter(([, a, b]) => !(String(a) === "—" && String(b) === "—"))
    .map(
      ([k, a, b]) =>
        `<tr class="${String(a) !== String(b) ? "moved" : ""}"><th>${k}</th><td>${escape(a)}</td><td>${escape(b)}</td></tr>`
    )
    .join("")
  return `<table class="metrics"><thead><tr><th></th><th>Before</th><th>After</th></tr></thead><tbody>${rows}</tbody></table>`
}

const sentences = (probe) =>
  probe && probe.sentences.length
    ? `<ul class="said">${probe.sentences.map((s) => `<li>${escape(s)}</li>`).join("")}</ul>`
    : `<p class="none">Nothing on screen says anything.</p>`

function panel(spec, before, after) {
  const problems = [...before.problems, ...after.problems]
  return `
<section class="state" id="${spec.id}">
  <header><h2>${escape(spec.title)}</h2><p class="why">${escape(spec.why)}</p></header>
  ${metrics(before.probe, after.probe)}
  <div class="pair">
    <figure><figcaption><span class="tag tag-before">Before</span></figcaption>
      <img src="${before.file}" alt="${escape(spec.title)}, before">${sentences(before.probe)}</figure>
    <figure><figcaption><span class="tag tag-after">After</span></figcaption>
      <img src="${after.file}" alt="${escape(spec.title)}, after">${sentences(after.probe)}</figure>
  </div>
  ${problems.length ? `<p class="problem">${problems.map(escape).join("<br>")}</p>` : ""}
</section>`
}

function pageHtml(panels, meta) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>designlayer — the app chooser, before and after</title>
<style>
  :root { color-scheme: dark; --dim: rgba(255,255,255,0.62); --line: rgba(255,255,255,0.14); }
  * { box-sizing: border-box; }
  body { margin:0; padding:40px 32px 96px; background:#1b1b1b; color:#f2f2f2;
         font:400 14px/1.6 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
  .page { max-width: 1240px; margin: 0 auto; }
  h1 { margin:0 0 4px; font-size:24px; }
  .meta { margin:0 0 6px; color:var(--dim); font-size:13px; }
  .meta code { font-family: ui-monospace, monospace; color:#f2f2f2; }
  .toc { margin:24px 0 40px; padding:0; list-style:none; display:flex; flex-wrap:wrap; gap:8px; }
  .toc a { display:block; padding:6px 10px; border:1px solid var(--line); border-radius:8px;
           color:#f2f2f2; text-decoration:none; font-size:13px; }
  .toc a:hover { border-color:#7cc4f8; }
  .state { margin:0 0 56px; padding-top:24px; border-top:1px solid var(--line); }
  .state h2 { margin:0 0 4px; font-size:18px; }
  .why { margin:0 0 16px; max-width:82ch; color:var(--dim); }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:20px; align-items:start; }
  figure { margin:0; }
  figcaption { margin:0 0 8px; }
  .tag { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; }
  .tag-before { background:rgba(255,138,101,0.16); color:#ff8a65; }
  .tag-after { background:rgba(124,196,248,0.16); color:#7cc4f8; }
  img { width:100%; display:block; border:1px solid var(--line); border-radius:10px; background:#111; }
  .said { margin:10px 0 0; padding-left:18px; font-size:13px; color:var(--dim); }
  .none { margin:10px 0 0; font-size:13px; color:#ff8a65; }
  .metrics { margin:0 0 16px; border-collapse:collapse; font-size:13px; }
  .metrics th,.metrics td { padding:3px 16px 3px 0; text-align:left; font-weight:400; color:var(--dim); }
  .metrics thead th { color:#f2f2f2; font-weight:600; }
  .metrics tbody th { color:#f2f2f2; }
  .metrics tr.moved td:last-child { color:#7cc4f8; font-weight:600; }
  .problem { margin:12px 0 0; padding:8px 12px; border-radius:8px;
             background:rgba(255,138,101,0.12); color:#ff8a65; font-size:13px; }
</style></head>
<body><div class="page">
  <h1>The app chooser, before and after</h1>
  <p class="meta">Before is <code>${escape(meta.rev)}</code>, built from a git worktree. After is the working tree. Both columns are real bundles of the shipped installers — nothing is mocked but the loopback routes.</p>
  <ul class="toc">${panels.map((p) => `<li><a href="#${p.id}">${escape(p.title)}</a></li>`).join("")}</ul>
  ${panels.map((p) => p.html).join("\n")}
</div></body></html>`
}

async function main() {
  if (!fs.existsSync(BEFORE_TREE)) {
    console.error(
      `No worktree at ${path.relative(ROOT, BEFORE_TREE)}.\n` +
        "Create one first — it does not touch the working tree:\n" +
        "  git worktree add .worktrees/before HEAD\n" +
        "  ln -s $PWD/node_modules .worktrees/before/node_modules"
    )
    process.exitCode = 1
    return
  }
  fs.mkdirSync(OUT, { recursive: true })

  const rev = execFileSync("git", ["-C", BEFORE_TREE, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim()
  console.log(`before: ${rev}`)

  // The scene file lives in the working tree and is bundled twice, once with
  // each revision's `src/` behind it. A worktree at a revision that predates
  // the scene would otherwise have no scene to build.
  fs.copyFileSync(
    path.join(ROOT, "tools", "chrome-demo-scene.js"),
    path.join(BEFORE_TREE, "tools", "chrome-demo-scene.js")
  )

  let beforeJs
  try {
    beforeJs = await bundleScene(BEFORE_TREE)
  } catch (error) {
    console.error(`the before revision does not compile against this scene:\n${error.message}`)
    process.exitCode = 1
    return
  }
  const afterJs = await bundleScene(ROOT)

  const pw = await loadPlaywright()
  if (!pw) {
    console.error("Playwright was not found. Install it (npm i -D playwright).")
    process.exitCode = 1
    return
  }
  const browser = await pw.chromium.launch()
  const panels = []
  for (const spec of SCENARIOS) {
    process.stdout.write(`  ${spec.id}… `)
    const before = await shoot(browser, beforeJs, spec, "before")
    const after = await shoot(browser, afterJs, spec, "after")
    panels.push({ id: spec.id, title: spec.title, html: panel(spec, before, after) })
    console.log(
      before.probe && after.probe
        ? `tab stops ${before.probe.tabStops}→${after.probe.tabStops}, clipped ${before.probe.clipped}→${after.probe.clipped}`
        : "no probe"
    )
  }
  await browser.close()

  const html = pageHtml(panels, { rev })
  fs.writeFileSync(path.join(OUT, "index.html"), html)
  const inlined = html.replace(/src="([^"]+\.png)"/g, (_, file) => {
    const bytes = fs.readFileSync(path.join(OUT, file))
    return `src="data:image/png;base64,${bytes.toString("base64")}"`
  })
  fs.writeFileSync(path.join(OUT, "standalone.html"), inlined)
  console.log(`\nwrote ${path.relative(ROOT, path.join(OUT, "index.html"))}`)
  console.log(`wrote standalone.html (${Math.round(inlined.length / 1024)}kb, images inlined)`)
  if (flags.has("--open")) execFileSync("open", [path.join(OUT, "index.html")])
}

await main()
