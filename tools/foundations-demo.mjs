#!/usr/bin/env node
/**
 * The editor chrome on the design foundation, rendered at two revisions.
 *
 * Sibling of `tools/chrome-demo.mjs`, and built the same way: both columns are
 * real bundles of the shipped installers. The after column is bundled from the
 * working tree; the before column from a git worktree at
 * `.worktrees/foundations-before`, which never touches the working tree — other
 * agents have uncommitted work interleaved in it.
 *
 * Every surface is shot in both themes, cropped to its own box plus a margin,
 * and laid out on one page with a Dark/Light and a Before/After/Side-by-side
 * toggle. The words under each row come from `tools/foundations-demo-notes.json`
 * so whoever lands the restyle can say what changed without touching this file.
 *
 *   node tools/foundations-demo.mjs                  # before = existing worktree (created at HEAD if absent)
 *   node tools/foundations-demo.mjs --before=<rev>   # move the worktree to <rev> first
 *   node tools/foundations-demo.mjs --open
 *   node tools/foundations-demo.mjs --no-shots       # rebuild index.html from existing shots
 *
 * Output lands in `.demos/foundations/`, which is gitignored.
 */

import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT = path.join(ROOT, ".demos", "foundations")
const SHOTS = path.join(OUT, "shots")
const SCRATCH = path.join(OUT, ".build")
const BEFORE_TREE = path.join(ROOT, ".worktrees", "foundations-before")
const NOTES = path.join(ROOT, "tools", "foundations-demo-notes.json")
const SCENE = "foundations-demo-scene.js"

const args = process.argv.slice(2)
const flags = new Set(args)
const beforeRev = (args.find((a) => a.startsWith("--before=")) ?? "").slice("--before=".length) || null
const wantShots = !flags.has("--no-shots")

const THEMES = ["dark", "light"]
const PAD = 16
/** Served from a loopback origin so `localStorage` and the config's loopback checks both work. */
const ORIGIN = "http://127.0.0.1:3460"
const API = `${ORIGIN}/__designlayer`

const APPS = [
  { kind: "editor", label: "shop-web", target: "http://127.0.0.1:3460", url: "http://127.0.0.1:3000", projectRoot: "/Users/you/Projects/shop-web", packageName: "shop-web", placed: true },
  { kind: "app", label: "@acme/design-system-playground", url: "http://127.0.0.1:4200", projectRoot: "/Users/you/Projects/acme-design-system-playground", packageName: "@acme/design-system-playground", placed: true },
  { kind: "app", label: "docs", url: "http://127.0.0.1:5173", projectRoot: null, packageName: null, placed: false },
]

/* The library a populated Design system tab shows. Shape from test/library-panel-cases.mjs. */
const color = (slug, cssVar, light) => ({ id: `color:${slug}`, name: slug, category: "color", cssVar, values: { light } })
const LIBRARY = {
  id: "src-styles-acme-css",
  name: "Acme UI",
  enabled: true,
  source: { kind: "css", path: "src/styles/acme.css" },
  addedAt: 1737000000000,
  counts: { colors: 4, spacing: 2, radii: 1, textStyles: 0, effects: 0, icons: 0, motion: 0, components: 3, iconDrawings: 0 },
  catalog: {
    name: "Acme UI", trackingUnit: "em",
    colors: [
      color("brand-500", "--acme-brand-500", "#2447d1"),
      color("brand-600", "--acme-brand-600", "#1f3fb8"),
      color("surface", "--acme-surface", "#ffffff"),
      color("ink", "--acme-ink", "#111111"),
    ],
    spacing: [
      { id: "spacing:sm", name: "sm", category: "spacing", cssVar: "--acme-space-sm", values: { default: 8 } },
      { id: "spacing:md", name: "md", category: "spacing", cssVar: "--acme-space-md", values: { default: 16 } },
    ],
    radii: [{ id: "radius:md", name: "md", category: "radius", cssVar: "--acme-radius-md", values: { default: 12 } }],
    textStyles: [], uiTextStyles: [], effects: [], icons: [], motion: [], iconDrawings: [], iconAttribute: "",
    components: [
      { id: "component:button", name: "Button", description: "The primary action control.", file: "src/ui/button.tsx", snippet: '<Button variant="primary">Label</Button>', props: [{ name: "variant", type: "enum", values: ["primary", "ghost"], default: "primary" }] },
      { id: "component:card", name: "Card", description: "A raised surface for grouped content.", file: "src/ui/card.tsx", snippet: "<Card>…</Card>", props: [] },
      { id: "component:badge", name: "Badge", description: "A short status label.", file: "src/ui/badge.tsx", snippet: "<Badge>New</Badge>", props: [] },
    ],
  },
}

/* Audit findings, mixed severity, with selectors that resolve on the sample page. Shape from src/lint/store.ts. */
const finding = (id, severity, rule, message, selector, property, snippet, fix, line) => ({
  id, tool: "stylelint", rule, severity, message, file: "src/app/products/product.css", line, column: 3,
  endLine: line, endColumn: 3 + snippet.length, selector, snippet, property, fix: fix ? { replacement: fix } : null,
})
const FINDINGS = [
  finding("f1", "error", "design-tokens/no-hardcoded-color", '"#2447d1" is a hardcoded colour. Use var(--acme-brand-500).', ".add-to-cart-button", "background", "#2447d1", "var(--acme-brand-500)", 12),
  finding("f2", "error", "design-tokens/no-hardcoded-color", '"#f5f5f7" is a hardcoded colour with no matching token.', ".feature-card", "background", "#f5f5f7", null, 31),
  finding("f3", "warning", "design-tokens/no-unknown-token", "--corner-tiny is never declared in the token sources. Did you mean --acme-radius-md?", ".size-chip", "border-radius", "var(--corner-tiny)", "var(--acme-radius-md)", 44),
  finding("f4", "warning", "design-tokens/spacing-scale", "18px is not on the spacing scale (8, 16).", ".product-details", "gap", "18px", "var(--acme-space-md)", 20),
]

/*
 * The scenarios. `drive` runs in Node against the booted page and returns the
 * selectors to crop to (union of every visible match), or "viewport".
 * `kind` picks how the page is stood up: the whole editor, a bare surface, or
 * the start screen document.
 */
const SCENARIOS = [
  {
    id: "overview",
    title: "Editor overview",
    caption: "Toolbar, Layers and the Design tab around a sample page, with the button selected.",
    viewport: { width: 1440, height: 900 },
    drive: async () => "viewport",
  },
  {
    id: "inspector-design",
    title: "Inspector: Design tab",
    caption: "The whole section stack for the selected button.",
    viewport: { width: 1440, height: 1800 },
    drive: async () => [{ panel: ".de-panel--right" }],
  },
  {
    id: "inspector-changes",
    title: "Inspector: Changes tab",
    caption: "Two notes and three edits in the outbox.",
    viewport: { width: 1440, height: 1100 },
    boot: { seed: true },
    drive: async (page, log) => {
      if (!(await page.evaluate(() => window.__demo.openTab("Changes", ".de-panel--right")))) log("no Changes tab")
      return [{ panel: ".de-panel--right" }]
    },
  },
  {
    id: "code",
    title: "Code tab",
    caption: "The selected element's source, in whichever panel carries the Code tab.",
    viewport: { width: 1440, height: 900 },
    drive: async (page, log) => {
      for (const panel of [".de-panel--left", ".de-panel--right"]) {
        if (await page.evaluate((p) => window.__demo.openTab("Code", p), panel)) return [{ panel }]
      }
      log("no Code tab in either panel")
      return [".de-panel--left"]
    },
  },
  {
    id: "left-controls",
    title: "Left panel: Design options tab",
    caption: "The app-scoped control inventory (empty: the sample page has no leva controls).",
    viewport: { width: 1440, height: 900 },
    drive: async (page, log) => {
      if (!(await page.evaluate(() => window.__demo.openTab("Design options", ".de-panel--left")))) log("no Design options tab")
      return [{ panel: ".de-panel--left" }]
    },
  },
  {
    id: "design-system",
    title: "Inspector: Design system tab",
    caption: "Libraries and lint sections, with no libraries added and a clean lint run.",
    viewport: { width: 1440, height: 900 },
    drive: async (page, log) => {
      if (!(await page.evaluate(() => window.__demo.openTab("Design system", ".de-panel--right")))) log("no Design system tab")
      await page.waitForTimeout(300)
      return [{ panel: ".de-panel--right" }]
    },
  },
  {
    id: "toolbar",
    title: "Toolbar with tooltip",
    caption: "The bar with the pointer on its second tool and the tooltip showing.",
    viewport: { width: 1440, height: 900 },
    drive: async (page, log) => {
      const tools = page.locator(".de-toolbar .de-tool")
      if ((await tools.count()) < 2) log("fewer than two tools in the bar")
      else await tools.nth(1).hover()
      await page.waitForTimeout(900)
      return [".de-toolbar", ".de-tip"]
    },
  },
  {
    id: "layer-menu",
    title: "Layer context menu",
    caption: "Right-click over the button: the stack of layers under the pointer.",
    viewport: { width: 1440, height: 900 },
    drive: async (page, log) => {
      const box = await page.locator("#sample-app button").boundingBox()
      if (!box) {
        log("sample button not on screen")
        return [".de-layer-menu"]
      }
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" })
      await page.waitForTimeout(300)
      return [".de-layer-menu"]
    },
  },
  {
    id: "toasts",
    title: "Toasts",
    caption: "A confirmation, and an error that stays with an action on it.",
    viewport: { width: 1440, height: 900 },
    drive: async (page) => {
      await page.evaluate(() => window.__demo.toast("Applied 3 changes to AddToCartButton.", "info"))
      await page.evaluate(() =>
        window.__demo.toast("Could not write page.tsx: the file changed on disk. Reload it, then apply again.", "error", "Retry")
      )
      await page.waitForTimeout(600)
      // Sonner stacks toasts collapsed; the pointer over the stack fans it out.
      const toast = page.locator("#designlayer-toaster [data-sonner-toast]").first()
      if (await toast.count()) await toast.hover().catch(() => {})
      await page.waitForTimeout(700)
      return ["#designlayer-toaster [data-sonner-toast]"]
    },
  },
  {
    id: "annotation-composer",
    title: "Annotation composer",
    caption: "Annotate mode, one click on the button: the note composer on the canvas.",
    viewport: { width: 1440, height: 900 },
    drive: async (page, log) => {
      await page.evaluate(() => window.__demo.setMode("annotating"))
      const box = await page.locator("#sample-app button").boundingBox()
      if (!box) log("sample button not on screen")
      else {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(80)
        await page.mouse.down()
        await page.mouse.up()
      }
      await page.waitForTimeout(400)
      return [".de-ann-composer", "#sample-app button"]
    },
  },
  {
    id: "saved-styles",
    title: "Saved styles panel",
    caption: "The Typography section with its styles panel open (what replaced the options window).",
    viewport: { width: 1440, height: 1400 },
    drive: async (page, log) => {
      if (!(await page.evaluate(() => window.__demo.openStyles("Typography")))) log("no Typography styles toggle")
      await page.waitForTimeout(200)
      return [".de-section:has(.de-style-panel:not([hidden]))"]
    },
  },
  {
    id: "shortcut-sheet",
    title: "Keyboard shortcut sheet",
    caption: "The shortcut sheet open over the editor (the ? key).",
    viewport: { width: 1440, height: 1000 },
    drive: async (page, log) => {
      if (!(await page.evaluate(() => window.__demo.shortcutSheet()))) log("help.shortcuts is not registered")
      await page.waitForTimeout(300)
      return [".de-shortcuts"]
    },
  },
  {
    id: "dismiss",
    title: "Dismissal: 60ms after Escape",
    caption: "The shortcut sheet 60ms after Escape. Before: already gone. After: the dialog is closed, and an inert copy fades to 0.98.",
    viewport: { width: 1440, height: 1000 },
    drive: async (page, log) => {
      if (!(await page.evaluate(() => window.__demo.shortcutSheet()))) log("help.shortcuts is not registered")
      await page.waitForTimeout(300)
      await page.keyboard.press("Escape")
      await page.waitForTimeout(60)
      const state = await page.evaluate(() => ({
        open: Boolean(document.querySelector("dialog.de-shortcuts[open]:not([data-de-leaving])")),
        ghosts: document.querySelectorAll("[data-de-leaving]").length,
        modal: Boolean(document.querySelector("dialog:modal")),
      }))
      if (state.open || state.modal) log(`the real sheet is still open (${JSON.stringify(state)})`)
      return "viewport"
    },
  },
  {
    id: "libraries",
    title: "Design system tab: library added",
    caption: "One enabled library (4 colors, 2 spacing, 1 radius, 3 components).",
    api: "libraries",
    viewport: { width: 1440, height: 1000 },
    drive: async (page, log) => {
      if (!(await page.evaluate(() => window.__demo.openTab("Design system", ".de-panel--right")))) log("no Design system tab")
      await page.waitForTimeout(500)
      return [{ panel: ".de-panel--right" }]
    },
  },
  {
    id: "library-signin",
    title: "Library sign-in dialog",
    caption: "Adding a Storybook URL that answers 401: the sign-in dialog.",
    api: "signin",
    viewport: { width: 1440, height: 1000 },
    drive: async (page, log) => {
      if (!(await page.evaluate(() => window.__demo.openTab("Design system", ".de-panel--right")))) log("no Design system tab")
      const field = page.locator(".de-panel--right .de-lib-field input, .de-panel--right input[placeholder^='https']").first()
      if (!(await field.count())) {
        log("no library URL field")
        return [".de-lib-signin"]
      }
      await field.fill("https://storybook.acme.dev/")
      await field.press("Enter")
      await page.waitForTimeout(250)
      if (!(await page.locator(".de-lib-signin[open]").count())) {
        await page.evaluate(() => window.__demo.pressButton("Add", ".de-panel--right"))
      }
      await page.waitForTimeout(600)
      if (!(await page.locator(".de-lib-signin[open]").count())) log("the sign-in dialog did not open")
      return [".de-lib-signin[open]"]
    },
  },
  {
    id: "lint",
    title: "Audit findings and canvas markers",
    caption: "Two errors and two warnings after Audit, with the markers on the page.",
    api: "lint",
    viewport: { width: 1440, height: 1000 },
    drive: async (page, log) => {
      if (!(await page.evaluate(() => window.__demo.openTab("Design system", ".de-panel--right")))) log("no Design system tab")
      if (!(await page.evaluate(() => window.__demo.pressButton("Audit", ".de-panel--right")))) log("no Audit button")
      await page.waitForTimeout(700)
      await page.evaluate(() => window.__demo.showLintMarkers())
      await page.waitForTimeout(300)
      return "viewport"
    },
  },
  {
    id: "layers-states",
    title: "Layers: hover and selection",
    caption: "The selected row (AddToCartButton) and a hovered row (Price) with its actions revealed.",
    viewport: { width: 1440, height: 900 },
    drive: async (page, log) => {
      const row = page.locator(".de-panel--left .de-layer", { hasText: "Price" }).first()
      if (!(await row.count())) log("no Price row in the tree")
      else await row.hover()
      await page.waitForTimeout(250)
      return [{ panel: ".de-panel--left" }]
    },
  },
  {
    id: "icons",
    title: "Icons: the whole set at 16 and 12",
    caption: "Every glyph the chrome draws, in full ink on the panel ground.",
    kind: "icons",
    viewport: { width: 760, height: 720 },
    drive: async () => [".de-demo-icons"],
  },
  {
    id: "token-picker",
    title: "Token picker",
    caption: "A color token field with its picker open.",
    kind: "token",
    viewport: { width: 640, height: 720 },
    drive: async () => [".de-panel--right", ".de-token-popover"],
  },
  {
    id: "app-chooser",
    title: "App chooser",
    caption: "The chooser open with three apps to switch to.",
    viewport: { width: 1440, height: 900 },
    drive: async (page, log) => {
      const trigger = page.locator(".de-app-chooser").first()
      if (!(await trigger.count())) log("no app chooser")
      else await trigger.click()
      await page.waitForTimeout(400)
      return [".de-app-chooser", ".de-app-menu"]
    },
  },
  {
    id: "start-screen",
    title: "Start screen",
    caption: "The front door with two dev servers found. A standalone document: shot under prefers-color-scheme, since it has no data-de-theme.",
    kind: "start",
    themes: ["dark"],
    viewport: { width: 900, height: 1000 },
    drive: async () => ["main.card"],
  },
]

/* ---------- git: the before worktree ---------- */

function git(cwd, ...argv) {
  return execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function prepareWorktree() {
  const exists = fs.existsSync(path.join(BEFORE_TREE, ".git"))
  if (beforeRev || !exists) {
    // Resolved in the MAIN checkout: `HEAD` inside the worktree is the worktree's own.
    const sha = git(ROOT, "rev-parse", "--verify", `${beforeRev ?? "HEAD"}^{commit}`)
    if (exists) {
      git(BEFORE_TREE, "checkout", "--detach", "--quiet", sha)
    } else {
      fs.mkdirSync(path.dirname(BEFORE_TREE), { recursive: true })
      git(ROOT, "worktree", "add", "--detach", "--quiet", BEFORE_TREE, sha)
    }
  }
  const modules = path.join(BEFORE_TREE, "node_modules")
  if (!fs.existsSync(modules)) fs.symlinkSync(path.join(ROOT, "node_modules"), modules)
  fs.mkdirSync(path.join(BEFORE_TREE, "tools"), { recursive: true })
  fs.copyFileSync(path.join(ROOT, "tools", SCENE), path.join(BEFORE_TREE, "tools", SCENE))
  return {
    rev: git(BEFORE_TREE, "rev-parse", "--short", "HEAD"),
    subject: git(BEFORE_TREE, "log", "-1", "--format=%s"),
  }
}

/* ---------- bundling ---------- */

/**
 * A module the other revision does not have resolves to an empty one, so the
 * scene still compiles and the scenario that needed it says so on its row.
 */
const tolerateMissing = {
  name: "tolerate-missing",
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, (a) => {
      if (!a.importer.includes(`${path.sep}tools${path.sep}`)) return undefined
      const base = path.resolve(a.resolveDir, a.path)
      const found = ["", ".ts", ".js", ".mjs", "/index.ts", "/index.js"].some((ext) => fs.existsSync(base + ext))
      return found ? undefined : { path: a.path, namespace: "missing" }
    })
    b.onLoad({ filter: /.*/, namespace: "missing" }, () => ({ contents: "export {}", loader: "js" }))
  },
}

/** Same neutering `build.mjs` does, but tolerant: a Sonner without the guard just keeps its sheet. */
const dropSonnerGlobalCss = {
  name: "drop-sonner-global-css",
  setup(b) {
    b.onLoad({ filter: /[\\/]node_modules[\\/]sonner[\\/]dist[\\/]index\.mjs$/ }, (a) => {
      const source = fs.readFileSync(a.path, "utf8")
      const guard = "if (!code || typeof document == 'undefined') return"
      return { contents: source.replace(guard, "if (true) return"), loader: "js" }
    })
  },
}

async function bundleScene(treeRoot) {
  try {
    const result = await build({
      entryPoints: [path.join(treeRoot, "tools", SCENE)],
      absWorkingDir: treeRoot,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["chrome110"],
      write: false,
      logLevel: "silent",
      tsconfig: fs.existsSync(path.join(treeRoot, "tsconfig.json")) ? path.join(treeRoot, "tsconfig.json") : undefined,
      define: { "process.env.NODE_ENV": '"production"' },
      nodePaths: [path.join(treeRoot, "node_modules")],
      plugins: [tolerateMissing, dropSonnerGlobalCss],
    })
    return { js: result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script") }
  } catch (error) {
    const first = (error.errors ?? [])[0]
    const where = first?.location ? `${first.location.file}:${first.location.line}: ` : ""
    return { error: `did not compile: ${where}${first?.text ?? error.message}`.slice(0, 300) }
  }
}

/**
 * The start screen document at a revision. Its stylesheet imports
 * `../dist/tokens.mjs`, which is a build artifact, so the token module is
 * bundled fresh from that revision's `src/core/tokens.ts` into a scratch copy
 * of the layout — the working tree's `dist/` may be stale against a restyle in
 * progress, and the worktree has none.
 */
async function startScreenHtml(treeRoot, label) {
  try {
    const dir = path.join(SCRATCH, label)
    fs.rmSync(dir, { recursive: true, force: true })
    for (const file of ["runtime/start-screen-page.mjs", "runtime/start-screen-style.mjs"]) {
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true })
      fs.copyFileSync(path.join(treeRoot, file), path.join(dir, file))
    }
    await build({
      entryPoints: [path.join(treeRoot, "src", "core", "tokens.ts")],
      absWorkingDir: treeRoot,
      bundle: true,
      format: "esm",
      platform: "neutral",
      outfile: path.join(dir, "dist", "tokens.mjs"),
      logLevel: "silent",
    })
    const mod = await import(`${pathToFileURL(path.join(dir, "runtime", "start-screen-page.mjs")).href}?t=${Date.now()}`)
    return { html: mod.startScreenPage() }
  } catch (error) {
    return { error: `start screen did not render: ${String(error.message).slice(0, 240)}` }
  }
}

/* ---------- Playwright, borrowed rather than depended on ---------- */

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

/* ---------- shooting ---------- */

const START_STUB = `
  window.fetch = async (target) => {
    const url = new URL(target, "http://127.0.0.1:3455")
    const ok = (body) => ({ ok: true, status: 200, json: async () => body })
    if (url.pathname === "/api/apps") return ok({ apps: [
      { port: 3000, url: "http://127.0.0.1:3000", title: "Shop Web", projectRoot: "/Users/you/Projects/shop-web", packageName: "shop-web" },
      { port: 3001, url: "http://127.0.0.1:3001", title: "127.0.0.1:3001", projectRoot: null, packageName: null },
    ] })
    if (url.pathname === "/api/status") return ok({ ready: false, editing: null, stopped: null })
    if (url.pathname === "/api/project") return ok({ project: { path: "/Users/you/Projects/shop-web", name: "shop-web", exists: true, isDirectory: true, hasPackageJson: true, packageName: "shop-web", hasReact: true, devScripts: ["dev"], framework: "nextjs" } })
    return ok({ ok: true })
  }
`

/**
 * The loopback routes the chrome asks for, answered with small plausible bodies.
 * `api` is the scenario's variant: "libraries" lists one library, "signin"
 * walls a URL add behind a sign-in, "lint" answers an audit with findings.
 */
function apiAnswer(pathname, method, api) {
  const route = pathname.slice("/__designlayer".length)
  if (api === "signin" && route === "/libraries" && method === "POST") {
    return {
      status: 401,
      body: {
        message: "storybook.acme.dev asked for a sign-in before it would share its components.",
        auth: { kind: "basic", origin: "https://storybook.acme.dev", audience: "", realm: "Acme Storybook", location: "", hint: "", url: "https://storybook.acme.dev/" },
      },
    }
  }
  if (route === "/libraries" && api === "libraries") return { libraries: [LIBRARY] }
  if (route === "/lint/run" && api === "lint") return { findings: FINDINGS, ranAt: new Date().toISOString() }
  if (route === "/apps") return { chooser: true, apps: APPS }
  if (route.startsWith("/apps/switch")) return { ok: true }
  if (route === "/options") return {}
  if (route === "/libraries") return { libraries: [] }
  if (route === "/libraries/available") return { candidates: [] }
  if (route.startsWith("/libraries/auth")) return { origins: [] }
  if (route === "/lint/tools") {
    return { tools: [{ id: "stylelint", name: "Stylelint", available: true, reason: "", configFile: ".stylelintrc.json" }] }
  }
  if (route === "/lint/run") return { findings: [], ranAt: new Date(0).toISOString() }
  if (route === "/mcp/status") return { url: "http://127.0.0.1:5747/mcp", listening: true, agents: 1, waiting: 0 }
  if (route === "/icons") return { icons: [] }
  return null
}

function editorHtml(js) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>foundations demo</title>
<style>html,body{margin:0}</style></head><body><script>${js}</script></body></html>`
}

function messageHtml(text, theme) {
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  return `<!doctype html><html><body style="margin:0;background:${theme === "light" ? "#f2f2f2" : "#1b1b1b"}">
<div id="msg" style="display:inline-block;margin:16px;padding:16px 20px;max-width:420px;border:1px dashed #ff8a65;border-radius:10px;color:#ff8a65;font:13px/1.5 ui-sans-serif,system-ui">${esc}</div></body></html>`
}

async function unionBox(page, selectors) {
  const boxes = []
  for (const selector of selectors) {
    if (typeof selector === "object") {
      const box = await page.evaluate((sel) => window.__demo?.panelBox(sel) ?? null, selector.panel).catch(() => null)
      if (box && box.width > 0 && box.height > 0) boxes.push(box)
      continue
    }
    const all = await page.locator(selector).all().catch(() => [])
    for (const node of all) {
      const box = await node.boundingBox().catch(() => null)
      if (box && box.width > 0 && box.height > 0) boxes.push(box)
    }
  }
  if (!boxes.length) return null
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.width))
  const y1 = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

async function shoot(browser, side, spec, theme) {
  const file = `${spec.id}-${theme}-${side.label}.png`
  const problems = []
  const context = await browser.newContext({
    viewport: spec.viewport,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    colorScheme: theme,
  })
  const page = await context.newPage()
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e.message ?? e).slice(0, 180)}`))
  const log = (message) => problems.push(message)

  let crop = null
  try {
    const failure = spec.kind === "start" ? side.start.error : side.error
    if (failure) {
      await page.setContent(messageHtml(failure, theme))
      crop = ["#msg"]
      problems.push(failure)
    } else if (spec.kind === "start") {
      await page.setContent(side.start.html.replace("</head>", `<script>${START_STUB}</script></head>`), { waitUntil: "load" })
      await page.waitForTimeout(350)
      crop = await spec.drive(page, log)
    } else {
      await page.route(`${ORIGIN}/**`, async (route) => {
        const url = new URL(route.request().url())
        if (url.pathname === "/") {
          return route.fulfill({ status: 200, contentType: "text/html", body: editorHtml(side.js) })
        }
        const answer = url.pathname.startsWith("/__designlayer")
          ? apiAnswer(url.pathname, route.request().method(), spec.api)
          : null
        if (answer === null) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
        const { status, body } = answer.status ? answer : { status: 200, body: answer }
        return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
      })
      await page.addInitScript(
        ([t, api]) => {
          try {
            localStorage.setItem("designlayer:theme", t)
          } catch {}
          window.__DESIGNLAYER_CONFIG__ = {
            apiBase: api,
            app: { url: "http://127.0.0.1:3000", name: "shop-web" },
            chooserUrl: "http://127.0.0.1:3455",
          }
        },
        [theme, "/__designlayer"]
      )
      await page.goto(`${ORIGIN}/`, { waitUntil: "load" })
      if (!(await page.evaluate(() => Boolean(window.__demo)))) {
        throw new Error("the scene bundle threw while loading (see the pageerror above)")
      }
      if (spec.kind === "token") {
        const r = await page.evaluate((t) => window.__demo.tokenPicker(t), theme)
        problems.push(...(r?.problems ?? []))
      } else if (spec.kind === "icons") {
        const r = await page.evaluate((t) => window.__demo.iconSheet(t), theme)
        problems.push(...(r?.problems ?? []))
      } else {
        const r = await page.evaluate((o) => window.__demo.boot(o), spec.boot ?? {})
        problems.push(...(r?.problems ?? []))
      }
      crop = await spec.drive(page, log)
    }
  } catch (error) {
    problems.push(`drive: ${String(error.message ?? error).slice(0, 200)}`)
  }

  const vp = spec.viewport
  let clip = null
  if (crop && crop !== "viewport") {
    const box = await unionBox(page, crop)
    const named = crop.map((c) => (typeof c === "object" ? c.panel : c)).join(", ")
    if (!box) problems.push(`nothing to crop: ${named} not visible`)
    else {
      const x = Math.max(0, Math.floor(box.x - PAD))
      const y = Math.max(0, Math.floor(box.y - PAD))
      const width = Math.min(vp.width, Math.ceil(box.x + box.width + PAD)) - x
      const height = Math.min(vp.height, Math.ceil(box.y + box.height + PAD)) - y
      if (width > 0 && height > 0) clip = { x, y, width, height }
      else problems.push(`crop box is off screen: ${named}`)
    }
  }
  await page.screenshot({ path: path.join(SHOTS, file), ...(clip ? { clip } : {}) })
  await context.close()
  return { file, problems: [...new Set(problems)] }
}

/* ---------- the review page ---------- */

const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function readNotes() {
  try {
    return JSON.parse(fs.readFileSync(NOTES, "utf8"))
  } catch {
    return {}
  }
}

/** Adds an entry for any scenario the notes do not have yet, never touching what is there. */
function seedNotes() {
  const notes = fs.existsSync(NOTES) ? readNotes() : {}
  let added = false
  if (!Array.isArray(notes._summary)) {
    notes._summary = []
    added = true
  }
  for (const s of SCENARIOS) {
    if (notes[s.id]) continue
    notes[s.id] = { title: s.title, changes: [] }
    added = true
  }
  if (added) fs.writeFileSync(NOTES, `${JSON.stringify(notes, null, 2)}\n`)
}

/** CSS width of a 2x shot, read from the PNG header, so a 260px panel is not blown up to column width. */
function cssWidth(file) {
  try {
    const fd = fs.openSync(path.join(SHOTS, file), "r")
    const head = Buffer.alloc(24)
    fs.readSync(fd, head, 0, 24, 0)
    fs.closeSync(fd)
    return Math.round(head.readUInt32BE(16) / 2)
  } catch {
    return null
  }
}

function pageHtml(meta, results) {
  const notes = readNotes()
  const summary = Array.isArray(notes._summary) ? notes._summary.filter(Boolean) : []
  const rows = SCENARIOS.map((spec) => {
    const note = notes[spec.id] ?? {}
    const changes = (Array.isArray(note.changes) ? note.changes : []).filter(Boolean).slice(0, 5)
    const result = results[spec.id] ?? {}
    const themes = spec.themes ?? THEMES
    const problems = [...new Set(themes.flatMap((t) => ["before", "after"].flatMap((s) => result[`${t}-${s}`]?.problems ?? [])))]
    const figure = (theme, side) => {
      const file = `${spec.id}-${theme}-${side}.png`
      const width = cssWidth(file)
      const label = `${side === "before" ? "Before" : "After"}${themes.length === 1 ? ` · ${theme} only` : ""}`
      return `<figure class="shot ${side}${themes.length === 1 ? "" : ` t-${theme}`}"><span class="tag">${label}</span>` +
        `<img loading="lazy" src="shots/${file}"${width ? ` style="width:${width}px"` : ""} alt="${esc(note.title ?? spec.title)}, ${side}, ${theme}"></figure>`
    }
    return `<section class="row" id="${spec.id}">
  <div class="head"><h2>${esc(note.title ?? spec.title)}</h2><p>${esc(note.caption ?? spec.caption)}</p></div>
  ${changes.length ? `<ul class="changes">${changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
  <div class="pair${themes.length === 1 ? " one-theme" : ""}">${themes.map((t) => figure(t, "before") + figure(t, "after")).join("")}</div>
  ${problems.length ? `<details class="problems"><summary>${problems.length} note${problems.length > 1 ? "s" : ""} from the run</summary><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></details>` : ""}
</section>`
  }).join("\n")

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DesignLayer foundations: before and after</title>
<style>
  :root { --bg:#161616; --fg:#f2f2f2; --dim:rgba(255,255,255,.6); --line:rgba(255,255,255,.12); --chip:rgba(255,255,255,.08); color-scheme:dark; }
  body.light { --bg:#f4f4f5; --fg:#18181b; --dim:rgba(0,0,0,.58); --line:rgba(0,0,0,.12); --chip:rgba(0,0,0,.06); color-scheme:light; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:400 14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
  header { position:sticky; top:0; z-index:2; display:flex; flex-wrap:wrap; align-items:center; gap:16px; padding:12px 24px;
           background:var(--bg); border-bottom:1px solid var(--line); }
  header h1 { margin:0; font-size:15px; font-weight:600; margin-right:auto; }
  header .meta { color:var(--dim); font-size:12px; }
  header code { font:12px ui-monospace,monospace; }
  .seg { display:inline-flex; padding:2px; border-radius:8px; background:var(--chip); }
  .seg button { border:0; background:none; color:var(--dim); font:inherit; font-size:13px; padding:4px 12px; border-radius:6px; cursor:pointer; }
  .seg button[aria-pressed=true] { background:var(--bg); color:var(--fg); box-shadow:0 0 0 1px var(--line); }
  main { max-width:1600px; margin:0 auto; padding:16px 24px 80px; }
  .summary { margin:8px 0 24px; padding:12px 16px 12px 32px; border:1px solid var(--line); border-radius:10px; }
  .summary li { margin:2px 0; }
  .row { padding:20px 0; border-top:1px solid var(--line); }
  .head { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 12px; }
  .head h2 { margin:0; font-size:15px; }
  .head p { margin:0; color:var(--dim); }
  .changes { margin:6px 0 0; padding-left:18px; font-size:13px; }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:12px; align-items:start; }
  .shot { position:relative; margin:0; min-width:0; }
  .shot img { display:block; max-width:100%; height:auto; border:1px solid var(--line); border-radius:8px; }
  .tag { display:inline-block; margin:0 0 4px; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600;
         background:var(--chip); color:var(--dim); }
  .after .tag { background:rgba(36,71,209,.85); color:#fff; }
  body:not(.light) .t-light, body.light .t-dark { display:none; }
  body.only-before .after, body.only-after .before { display:none; }
  body.only-before .pair, body.only-after .pair { grid-template-columns:minmax(0,900px); }
  .problems { margin-top:8px; font-size:12px; color:#ff8a65; }
  .problems ul { margin:4px 0 0; padding-left:18px; }
  nav.toc { display:flex; flex-wrap:wrap; gap:6px; margin:4px 0 8px; }
  nav.toc a { padding:2px 8px; border-radius:6px; background:var(--chip); color:var(--fg); text-decoration:none; font-size:12px; }
</style></head>
<body>
<header>
  <h1>Foundations: before / after</h1>
  <span class="meta">Before <code>${esc(meta.rev)}</code> ${esc(meta.subject)} · After: working tree · ${esc(meta.when)}</span>
  <div class="seg" role="group" aria-label="Theme"><button data-theme="dark" aria-pressed="true">Dark</button><button data-theme="light" aria-pressed="false">Light</button></div>
  <div class="seg" role="group" aria-label="Columns"><button data-view="before" aria-pressed="false">Before</button><button data-view="after" aria-pressed="false">After</button><button data-view="both" aria-pressed="true">Side by side</button></div>
</header>
<main>
  ${summary.length ? `<ul class="summary">${summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
  <nav class="toc">${SCENARIOS.map((s) => `<a href="#${s.id}">${esc(notes[s.id]?.title ?? s.title)}</a>`).join("")}</nav>
  ${rows}
</main>
<script>
  const body = document.body
  const press = (attr, value) => document.querySelectorAll("[" + attr + "]").forEach((b) => b.setAttribute("aria-pressed", String(b.getAttribute(attr) === value)))
  document.querySelectorAll("[data-theme]").forEach((b) => b.addEventListener("click", () => {
    body.classList.toggle("light", b.dataset.theme === "light"); press("data-theme", b.dataset.theme)
  }))
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    body.classList.toggle("only-before", b.dataset.view === "before")
    body.classList.toggle("only-after", b.dataset.view === "after")
    press("data-view", b.dataset.view)
  }))
</script>
</body></html>`
}

/* ---------- run ---------- */

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  seedNotes()
  const resultsFile = path.join(OUT, "results.json")

  let meta
  try {
    meta = prepareWorktree()
  } catch (error) {
    console.error(`could not prepare ${path.relative(ROOT, BEFORE_TREE)}: ${error.stderr || error.message}`)
    process.exitCode = 1
    return
  }
  console.log(`before: ${meta.rev}  ${meta.subject}`)
  meta.when = new Date().toISOString().slice(0, 16).replace("T", " ")

  let results = {}
  if (wantShots) {
    const sides = [
      { label: "before", ...(await bundleScene(BEFORE_TREE)), start: await startScreenHtml(BEFORE_TREE, "before") },
      { label: "after", ...(await bundleScene(ROOT)), start: await startScreenHtml(ROOT, "after") },
    ]
    for (const side of sides) if (side.error) console.warn(`  ${side.label}: ${side.error}`)

    const pw = await loadPlaywright()
    if (!pw) {
      console.error("Playwright was not found. Install it (npm i -D playwright) or rerun with --no-shots.")
      process.exitCode = 1
      return
    }
    const browser = await pw.chromium.launch()
    for (const spec of SCENARIOS) {
      process.stdout.write(`  ${spec.id.padEnd(20)} `)
      results[spec.id] = {}
      for (const theme of spec.themes ?? THEMES) {
        for (const side of sides) {
          results[spec.id][`${theme}-${side.label}`] = await shoot(browser, side, spec, theme)
        }
      }
      const problems = [...new Set(Object.values(results[spec.id]).flatMap((r) => r.problems))]
      console.log(problems.length ? `notes: ${problems.slice(0, 3).join(" | ")}` : "ok")
    }
    await browser.close()
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1))
  } else if (fs.existsSync(resultsFile)) {
    results = JSON.parse(fs.readFileSync(resultsFile, "utf8"))
  }

  const target = path.join(OUT, "index.html")
  fs.writeFileSync(target, pageHtml(meta, results))
  console.log(`\n${pathToFileURL(target).href}`)
  if (flags.has("--open")) execFileSync("open", [target])
}

await main()
