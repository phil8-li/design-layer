#!/usr/bin/env node
/**
 * Two surfaces, rendered under worst-case content, on one page you read top to
 * bottom.
 *
 * The third of the review tools and the only one that is not a comparison.
 * `before-after.mjs` measures two revisions of the start screen against each
 * other; `chrome-demo.mjs` does the same for the editor's chrome. Both answer
 * "did this change land". Neither answers "does it survive a 200-character
 * package name", because both feed their surfaces the same tidy fixtures — a
 * project called `workspaces`, two dev servers, a path three folders deep — and
 * a surface built against one happy path looks finished right up until real
 * content arrives.
 *
 * So this one holds the revision still and varies the CONTENT: length, shape,
 * quantity, container width, zoom and every state each surface can reach. It
 * issues no verdict. It renders, and what visibly broke is written under the
 * instance it broke in.
 *
 *   node tools/break.mjs                 # both surfaces, ~46 renders
 *   node tools/break.mjs --only=start    # the start screen alone
 *   node tools/break.mjs --only=chooser  # the app chooser alone
 *   node tools/break.mjs --page-only     # rebuild the page from the last run
 *   node tools/break.mjs --open
 *
 * Output lands in `.demos/break/`, which is gitignored via `.demos/`.
 *
 * ## The two surfaces need two completely different rigs, and both already exist
 *
 * The start screen is a pure function of no arguments producing one
 * self-contained document, so it is rendered with `setContent` and driven
 * through a canned `window.fetch` — exactly the rig in `before-after.mjs`, and
 * the two traps documented there are copied verbatim below because both are
 * silent failures: `addInitScript` does not run for `setContent`, and
 * `location.origin` on `about:blank` is the STRING "null", which makes
 * `new URL(path, location.origin)` throw and sends every route into the page's
 * own network-failure branch.
 *
 * The chooser is TypeScript that needs a context, a bridge and a stylesheet, so
 * it is bundled with esbuild and stood up by its shipped installer — the rig in
 * `chrome-demo.mjs`. That tool's scene file is reused rather than rewritten:
 * `tools/chrome-demo-scene.js` already mounts `installAppChooser` over a real
 * `createContext`, and a second scene that did the same thing slightly
 * differently would be a second thing to keep true. What this file adds on top
 * of it is a panel whose width varies, a config whose app name varies, and a
 * `fetch` that can refuse the switch — none of which the scene has to know
 * about, because all three are installed from the driver after it returns.
 *
 * ## Why the notes are data in this file
 *
 * The page has to read as the report on its own, which means a break is marked
 * under the instance it happened in rather than only in a table at the end. A
 * break is only known after the render, so `NOTES` below is filled in on the
 * second pass and `--page-only` rebuilds the page from `shots.json` without
 * paying for the renders again.
 */

import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT = path.join(ROOT, ".demos", "break")

const args = process.argv.slice(2)
const flags = new Set(args)
const only = (args.find((a) => a.startsWith("--only=")) ?? "--only=both").slice("--only=".length)
const pageOnly = flags.has("--page-only")

/* ---------- the worst-case strings, written once ---------- */

/**
 * A 200-character app name. Not padded filler: it is the shape a real one takes
 * when a monorepo names a package after the surface, the client and the branch,
 * which is where the longest names in this tool's own registry come from.
 */
const NAME_200 = (
  "Acme Corporation Internal Design System Playground and Component Explorer for the Shop, " +
  "Admin, Docs and Marketing Surfaces, Long Running Branch Preview Build Seventeen Thousand"
).padEnd(200, " and Forty Two").slice(0, 200)

/** Sixty characters with no break opportunity anywhere in them. */
const UNBREAKABLE = "a".repeat(60)

/** A name that is only emoji, several of which are multi-codepoint. */
const EMOJI = "🎨🚀✨🧪🌈🛠️🧭🔭"

/** Right-to-left, with no Latin in it at all. */
const RTL = "متجر التصميم التجريبي للعميل"

/** A path deep enough that the tail — the identifying part — is far from the start. */
const DEEP_PATH =
  "/Users/you/Projects/clients/acme-corporation/frontend/packages/applications/shop-web-storefront-experimental/apps/storefront"

/* ---------- surface 1: the start screen ---------- */

/** The project `/api/project` answers with unless a case says otherwise. */
const PROJECT = {
  path: "/Users/you/Projects/shop-web",
  name: "shop-web",
  exists: true,
  isDirectory: true,
  hasPackageJson: true,
  packageName: "shop-web",
  hasReact: true,
  devScripts: ["dev"],
  framework: "nextjs",
}

/**
 * A detected dev server, in the shape `/api/apps` sends.
 *
 * `title` is the field every content-length scenario varies, because it is the
 * one string on this screen the product does not author — it is whatever the
 * app puts in its `<title>`, which is to say whatever the designer's app puts
 * there.
 */
const app = (port, title, over = {}) => ({
  port,
  url: `http://127.0.0.1:${port}`,
  title,
  projectRoot: `/Users/you/Projects/${title.toLowerCase().replace(/\W+/g, "-").slice(0, 20) || "app"}`,
  packageName: null,
  ...over,
})

const THREE_APPS = [
  app(3000, "Shop", { projectRoot: "/Users/you/Projects/shop-web" }),
  app(4200, "Admin console", { projectRoot: "/Users/you/Projects/admin" }),
  app(5173, "Docs", { projectRoot: "/Users/you/Projects/docs" }),
]

/** Twenty dev servers. Ten times the realistic count, which on this machine is two. */
const TWENTY_APPS = Array.from({ length: 20 }, (_, i) =>
  app(3000 + i, `prototype-${i + 1}`, { projectRoot: `/Users/you/Projects/prototype-${i + 1}` })
)

/** Fills both fields the way a user does, then lets the 300ms debounce land. */
const typeFolder = (value) => `
  const url = document.getElementById("url")
  url.value = "http://127.0.0.1:3000"
  url.dispatchEvent(new Event("input", { bubbles: true }))
  const folder = document.getElementById("folder-path")
  folder.value = ${JSON.stringify(value)}
  folder.dispatchEvent(new Event("input", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 600))
`

const START_CASES = [
  /* ----- content length ----- */
  {
    id: "len-typical",
    axis: "Content length",
    title: "Typical content — three apps with short titles",
    note: "The baseline the rest of this axis is judged against.",
    apps: THREE_APPS,
  },
  {
    id: "len-200",
    axis: "Content length",
    title: "A 200-character app title",
    note: "The title lands in a row, in the “Picked … for you” sentence, and in the hint under the button.",
    apps: [
      app(3000, NAME_200, { projectRoot: "/Users/you/Projects/shop-web" }),
      app(4200, "Admin console", { projectRoot: "/Users/you/Projects/admin" }),
    ],
  },
  {
    id: "len-unbreakable",
    axis: "Content length",
    title: "A 60-character title with no break opportunity",
    note: "Sixty a's: no space, no hyphen, nothing for a line breaker to use.",
    apps: [
      app(3000, UNBREAKABLE, { projectRoot: "/Users/you/Projects/shop-web" }),
      app(4200, "Admin console", { projectRoot: "/Users/you/Projects/admin" }),
    ],
  },
  {
    id: "len-empty",
    axis: "Content length",
    title: "An app that serves no title at all",
    note: "The scanner falls back to the address, which the page is supposed to catch and call “Untitled app”.",
    apps: [
      app(3000, "", { projectRoot: "/Users/you/Projects/shop-web" }),
      app(4200, "127.0.0.1:4200", { projectRoot: null }),
    ],
  },
  {
    id: "path-deep",
    axis: "Content length",
    title: "A 124-character project path, typed",
    note: "The path field, the hint under the button, and the tilde abbreviation all take the same string.",
    apps: [],
    project: { ...PROJECT, path: null },
    drive: typeFolder(DEEP_PATH),
  },

  /* ----- content shape ----- */
  {
    id: "shape-emoji",
    axis: "Content shape",
    title: "A title that is only emoji",
    note: "Eight glyphs, two of them multi-codepoint, in a row whose name and port share a baseline.",
    apps: [
      app(3000, EMOJI, { projectRoot: "/Users/you/Projects/shop-web" }),
      app(4200, "Admin console", { projectRoot: "/Users/you/Projects/admin" }),
    ],
  },
  {
    id: "shape-rtl",
    axis: "Content shape",
    title: "A right-to-left title",
    note: "Arabic with no Latin in it, inside a document that is `lang=\"en\"` and has no `dir` anywhere.",
    apps: [
      app(3000, RTL, { projectRoot: "/Users/you/Projects/shop-web" }),
      app(4200, "Admin console", { projectRoot: "/Users/you/Projects/admin" }),
    ],
  },

  /* ----- quantity ----- */
  { id: "qty-zero", axis: "Quantity", title: "Zero apps running", apps: [] },
  { id: "qty-one", axis: "Quantity", title: "One app running", apps: [THREE_APPS[0]] },
  { id: "qty-three", axis: "Quantity", title: "Three apps running", apps: THREE_APPS },
  {
    id: "qty-twenty",
    axis: "Quantity",
    title: "Twenty apps running",
    note: "Ten times the realistic count. The list has no ceiling and no scroll of its own.",
    apps: TWENTY_APPS,
    viewport: { width: 520, height: 1400 },
  },

  /* ----- container and zoom ----- */
  {
    id: "w-320",
    axis: "Container width",
    title: "320px viewport",
    apps: THREE_APPS,
    viewport: { width: 320, height: 900 },
  },
  {
    id: "w-1280",
    axis: "Container width",
    title: "1280px viewport",
    note: "The card is `width: min(100%, 496px)`, so this asks whether anything inside it stretches.",
    apps: THREE_APPS,
    viewport: { width: 1280, height: 800 },
  },
  {
    id: "zoom-200",
    axis: "Container width",
    title: "200% zoom — a 1024×760 window",
    note: "Zoom halves the viewport in CSS pixels, so this is the 1024×760 window a designer actually has.",
    apps: THREE_APPS,
    viewport: { width: 512, height: 380 },
  },

  /* ----- state ----- */
  {
    id: "state-now-editing",
    axis: "State",
    title: "Continue editing — an editor is already up",
    note: "The `#current` card, which `before-after.mjs` never renders.",
    apps: THREE_APPS,
    status: {
      ready: true,
      url: "http://127.0.0.1:3456",
      editing: {
        packageName: "@acme/design-system-playground",
        appUrl: "http://127.0.0.1:3000",
        projectRoot: DEEP_PATH,
      },
      stopped: null,
    },
  },
  {
    id: "state-now-editing-320",
    axis: "State",
    title: "Continue editing, at 320px",
    note: "The two actions are a wrapping flex row; this is the width its own comment says it failed at.",
    apps: THREE_APPS,
    viewport: { width: 320, height: 700 },
    status: {
      ready: true,
      url: "http://127.0.0.1:3456",
      editing: {
        packageName: "@acme/design-system-playground",
        appUrl: "http://127.0.0.1:3000",
        projectRoot: DEEP_PATH,
      },
      stopped: null,
    },
  },
  {
    id: "state-scan-failed",
    axis: "State",
    title: "The scan for running apps failed",
    apps: "fail",
  },
  {
    id: "state-crashed",
    axis: "State",
    title: "The editor died on the way up",
    apps: THREE_APPS,
    stopped:
      "The editor for @acme/design-system-playground stopped with code 1. Its output is in the terminal running designlayer. Pick an app below to try again.",
  },
  {
    id: "state-waiting",
    axis: "State",
    title: "Waiting for the app to come up",
    apps: [],
    drive: `${typeFolder("/Users/you/Projects/shop-web")}
      document.getElementById("submit").click()
      await new Promise((r) => setTimeout(r, 300))
    `,
  },
  {
    id: "state-waiting-lost",
    axis: "State",
    title: "Waiting, and the server stopped answering",
    note: "Three missed status polls in a row is the “lost contact” branch, about 1.5 seconds in.",
    apps: [],
    statusDiesAfterStart: true,
    drive: `${typeFolder("/Users/you/Projects/shop-web")}
      document.getElementById("submit").click()
      await new Promise((r) => setTimeout(r, 2600))
    `,
  },
  {
    id: "state-cancelled",
    axis: "State",
    title: "Stopped waiting",
    note: "The way out of the wait, and the sentence it leaves behind.",
    apps: [],
    drive: `${typeFolder("/Users/you/Projects/shop-web")}
      document.getElementById("submit").click()
      await new Promise((r) => setTimeout(r, 300))
      document.getElementById("waiting-back").click()
      await new Promise((r) => setTimeout(r, 120))
    `,
  },
  {
    id: "state-no-dev-script",
    axis: "State",
    title: "A project with no dev script",
    apps: [],
    project: { ...PROJECT, path: null, devScripts: [] },
    drive: typeFolder("/Users/you/Projects/shop-web"),
  },
  {
    id: "state-bad-path",
    axis: "State",
    title: "A relative path typed into the folder field",
    apps: [],
    drive: typeFolder("my-app"),
  },
  {
    id: "state-script-row",
    axis: "State",
    title: "Two dev scripts, so the command has to be chosen",
    note: "The `#script-row` select, which only appears when the project offers more than one.",
    apps: [],
    project: { ...PROJECT, path: null, devScripts: ["dev", "dev:turbo", "start:local"] },
    drive: typeFolder("/Users/you/Projects/shop-web"),
  },
  {
    id: "state-submit-empty",
    axis: "State",
    title: "Start pressed with both fields empty",
    apps: [],
    drive: `
      document.getElementById("submit").click()
      await new Promise((r) => setTimeout(r, 120))
    `,
  },
]

/**
 * The canned server, as a string spliced into the document's head.
 *
 * Two traps, both from `before-after.mjs` and both silent when you get them
 * wrong. `addInitScript` runs on NAVIGATION and `setContent` is not one, so the
 * stub would be installed on the `about:blank` that preceded the document and
 * thrown away — every panel renders, every panel shows the empty state, nothing
 * fails. And `location.origin` here is the string "null", so `new URL(path,
 * location.origin)` throws and every route falls into the page's own
 * network-failure branch. A literal loopback base cannot be wrong, because the
 * page only ever asks for same-origin paths.
 */
function startStub(spec) {
  const project = spec.project ?? PROJECT
  return `
    const APPS = ${JSON.stringify(spec.apps === "fail" ? [] : spec.apps)}
    const APPS_FAIL = ${JSON.stringify(spec.apps === "fail")}
    const PROJECT = ${JSON.stringify(project)}
    const STATUS = ${JSON.stringify(spec.status ?? null)}
    const STOPPED = ${JSON.stringify(spec.stopped ?? null)}
    const STATUS_DIES = ${JSON.stringify(Boolean(spec.statusDiesAfterStart))}
    let started = false
    window.fetch = async (target, init) => {
      const url = new URL(target, "http://127.0.0.1:3455")
      if (url.pathname === "/api/apps") {
        if (APPS_FAIL) throw new TypeError("Failed to fetch")
        return { ok: true, status: 200, json: async () => ({ apps: APPS }) }
      }
      if (url.pathname === "/api/status") {
        if (STATUS_DIES && started) throw new TypeError("Failed to fetch")
        const body = STATUS ?? { ready: false, editing: null, stopped: STOPPED }
        return { ok: true, status: 200, json: async () => body }
      }
      if (url.pathname === "/api/project") {
        /*
         * The typed path is echoed back when the case asks for it, because the
         * folder field is written from \`project.path\` and half the content-length
         * scenarios are about what happens to a long one once it lands there.
         */
        const asked = url.searchParams.get("path") ?? PROJECT.path
        const project = PROJECT.path === null
          ? { ...PROJECT, path: asked, name: asked.split(/[/\\\\]+/).filter(Boolean).pop() ?? asked }
          : PROJECT
        return { ok: true, status: 200, json: async () => ({ project }) }
      }
      if (url.pathname === "/api/start") {
        started = true
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
  `
}

/* ---------- surface 2: the app chooser ---------- */

/** A row of the chooser's menu, in the shape `GET /apps` sends. */
const menuApp = (port, over = {}) => ({
  kind: "app",
  port,
  url: `http://127.0.0.1:${port}`,
  title: "",
  projectRoot: `/Users/you/Projects/app-${port}`,
  packageName: `app-${port}`,
  target: null,
  ...over,
})

const MENU_THREE = [
  menuApp(3460, {
    kind: "editor",
    target: "http://127.0.0.1:3460",
    packageName: "shop-web",
    projectRoot: "/Users/you/Projects/shop-web",
  }),
  menuApp(4200, {
    packageName: "@acme/design-system-playground",
    projectRoot: "/Users/you/Projects/acme/design-system-playground",
  }),
  // Running, listed, and not openable: the scanner could not place it on disk.
  menuApp(5173, { packageName: null, projectRoot: null }),
]

const MENU_LONG = [
  menuApp(3460, { packageName: NAME_200, projectRoot: DEEP_PATH }),
  menuApp(4200, { packageName: UNBREAKABLE, projectRoot: `${DEEP_PATH}/${UNBREAKABLE}` }),
  menuApp(5173, { packageName: EMOJI, projectRoot: "/Users/you/Projects/emoji" }),
  menuApp(8080, { packageName: RTL, projectRoot: "/Users/you/مشاريع/متجر" }),
  menuApp(9000, { packageName: "", title: "", projectRoot: DEEP_PATH }),
]

const MENU_TWENTY = Array.from({ length: 20 }, (_, i) =>
  menuApp(3460 + i, {
    packageName: `prototype-${i + 1}`,
    projectRoot: `/Users/you/Projects/prototype-${i + 1}`,
  })
)

const CHOOSER_URL = "http://127.0.0.1:3455"

const CHOOSER_CASES = [
  /* ----- the trigger, closed: content length and shape against the panel width ----- */
  {
    id: "trigger-typical",
    axis: "Trigger — content",
    title: "Typical app name, 240px panel",
    note: "`size.panelWidth` is 240: the width a panel starts at.",
    appName: "shop-web",
    panel: 240,
    viewport: { width: 300, height: 100 },
  },
  {
    id: "trigger-200",
    axis: "Trigger — content",
    title: "A 200-character app name",
    appName: NAME_200,
    panel: 240,
    viewport: { width: 300, height: 100 },
  },
  {
    id: "trigger-unbreakable",
    axis: "Trigger — content",
    title: "A 60-character name with no break opportunity",
    appName: UNBREAKABLE,
    panel: 240,
    viewport: { width: 300, height: 100 },
  },
  {
    id: "trigger-empty",
    axis: "Trigger — content",
    title: "No app name known",
    note: "`config.app.name` is null, which is the state a `--dev` launch with no package.json opens in.",
    appName: null,
    panel: 240,
    viewport: { width: 300, height: 100 },
  },
  {
    id: "trigger-emoji",
    axis: "Trigger — content",
    title: "A name that is only emoji",
    appName: EMOJI,
    panel: 240,
    viewport: { width: 300, height: 100 },
  },
  {
    id: "trigger-rtl",
    axis: "Trigger — content",
    title: "A right-to-left name",
    appName: RTL,
    panel: 240,
    viewport: { width: 300, height: 100 },
  },
  {
    id: "trigger-min",
    axis: "Trigger — container",
    title: "A long name at the 180px panel minimum",
    note: "`size.panelMinWidth` is 180 — as narrow as `shell/resize.ts` lets the panel be dragged.",
    appName: NAME_200,
    panel: 180,
    viewport: { width: 240, height: 100 },
  },
  {
    id: "trigger-below-min",
    axis: "Trigger — container",
    title: "A long name at 160px, below the documented minimum",
    note: "Twenty pixels under the drag floor. Nothing in the chrome should be able to get here, so this is the margin the layout has.",
    appName: NAME_200,
    panel: 160,
    viewport: { width: 220, height: 100 },
  },

  /* ----- the menu: quantity ----- */
  {
    id: "menu-zero",
    axis: "Menu — quantity",
    title: "Nothing else running",
    note: "The empty state, which is the first thing most sessions ever see this control say.",
    appName: "shop-web",
    chooserUrl: CHOOSER_URL,
    apps: [],
    open: true,
  },
  {
    id: "menu-one",
    axis: "Menu — quantity",
    title: "One other app",
    appName: "shop-web",
    apps: [MENU_THREE[1]],
    open: true,
  },
  {
    id: "menu-three",
    axis: "Menu — quantity",
    title: "Three apps — an editor, a placed app, an unplaced one",
    note: "The unplaced row drags a trailing explanatory note in with it.",
    appName: "shop-web",
    chooserUrl: CHOOSER_URL,
    apps: MENU_THREE,
    open: true,
  },
  {
    id: "menu-twenty",
    axis: "Menu — quantity",
    title: "Twenty apps",
    note: "The card is capped at `100vh - 16px` and scrolls past it.",
    appName: "shop-web",
    apps: MENU_TWENTY,
    open: true,
  },

  /* ----- the menu: content ----- */
  {
    id: "menu-long",
    axis: "Menu — content",
    title: "Worst-case names: 200 characters, 60 unbreakable, emoji, RTL, empty",
    note: "Five rows, one per content scenario, plus a deep path on the second line of each.",
    appName: "shop-web",
    apps: MENU_LONG,
    open: true,
    viewport: { width: 520, height: 760 },
  },

  /* ----- the menu: state ----- */
  {
    id: "menu-unreachable",
    axis: "Menu — state",
    title: "The list could not be fetched",
    appName: "shop-web",
    appsFail: true,
    open: true,
  },
  {
    id: "menu-error",
    axis: "Menu — state",
    title: "The server declined to list, with a reason",
    note: "A 200 carrying an `error` string — the contract's way of saying “I cannot look right now”.",
    appName: "shop-web",
    appsError:
      "The editor's app scanner could not run: lsof was refused by the operating system, so the project folder behind each running dev server could not be resolved. Run designlayer from the project folder instead.",
    open: true,
  },
  {
    id: "menu-armed",
    axis: "Menu — state",
    title: "Armed — a switch that would discard unapplied edits",
    note: "The first click on a row arms it when `hasPendingChanges()` is true; the second click goes.",
    appName: "shop-web",
    apps: MENU_THREE,
    dirty: true,
    open: true,
    /*
     * The SECOND row, and the selector has to say so.
     *
     * `.de-app-menu-row` on its own takes the first, which in this fixture is
     * an `editor` row — the one kind that never arms, because it is a
     * navigation to a proxy that is already serving. It followed the link, the
     * page left for `127.0.0.1:3460`, and the render came back blank with
     * "Execution context was destroyed". `nth-of-type` counts buttons, so the
     * live region ahead of the rows does not shift the index.
     */
    press: ".de-app-menu-row:nth-of-type(2)",
  },
  {
    id: "menu-inflight",
    axis: "Menu — state",
    title: "In flight — the switch was accepted",
    note: "The menu pins itself open and holds the only sentence explaining why the page is about to freeze.",
    appName: "shop-web",
    apps: [MENU_THREE[1]],
    open: true,
    press: ".de-app-menu-row",
  },
  {
    id: "menu-refused",
    axis: "Menu — state",
    title: "Refused — the start screen declined the switch",
    appName: "shop-web",
    chooserUrl: CHOOSER_URL,
    apps: [MENU_THREE[1]],
    switchFail:
      "That app is already being edited by another designlayer on this machine. Close that editor first, or pick a different app.",
    open: true,
    press: ".de-app-menu-row",
  },

  /* ----- the menu: container and zoom ----- */
  {
    id: "menu-w320",
    axis: "Menu — container",
    title: "320px viewport",
    note: "The card is `min-width: 232px; max-width: 340px` and clamps itself 8px off each edge.",
    appName: "shop-web",
    apps: MENU_THREE,
    open: true,
    viewport: { width: 320, height: 620 },
  },
  {
    id: "menu-w1280",
    axis: "Menu — container",
    title: "1280px viewport (cropped to the left 760px)",
    appName: "shop-web",
    apps: MENU_THREE,
    open: true,
    viewport: { width: 1280, height: 620 },
  },
  {
    id: "menu-zoom200",
    axis: "Menu — container",
    title: "200% zoom — a 1040×640 window, six apps",
    note: "A row is 42px and 84px at this zoom, which is what the card's height cap was written for.",
    appName: "shop-web",
    apps: MENU_TWENTY.slice(0, 6),
    open: true,
    viewport: { width: 520, height: 320 },
  },
]

/**
 * The config the bundle reads at load, which is why it is installed with
 * `setContent` rather than from `evaluate`.
 *
 * `src/core/config.ts` calls `read()` at module scope, so
 * `window.__DESIGNLAYER_CONFIG__` has to exist before the bundle's first line
 * runs — and the app NAME is the string the whole trigger axis varies. A
 * classic `<script>` in the head is ordered before `addScriptTag`, so this is
 * the same ordering trick the start screen's stub uses.
 */
function chooserConfig(spec) {
  return JSON.stringify({
    apiBase: "http://127.0.0.1:3456/__designlayer",
    chooserUrl: spec.chooserUrl ?? null,
    app: { url: "http://127.0.0.1:3000", name: spec.appName ?? null },
  })
}

/* ---------- Playwright, borrowed rather than depended on ---------- */

/*
 * Same resolution order as `panel-harness.mjs`, `before-after.mjs` and
 * `chrome-demo.mjs`, and for the same reason: this repo does not depend on
 * Playwright and should not start. See the long note in `panel-harness.mjs`.
 */
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

/* ---------- what the page measures, beyond the pixels ---------- */

/**
 * Three things a screenshot argues about and a measurement does not: whether
 * anything escaped its container, whether the container escaped the viewport,
 * and which strings are being truncated.
 *
 * It is deliberately thin. This is a look-once tool, not an instrument, and the
 * only reason to measure at all is that "does that text overflow by 2px or is
 * it inside the padding" is a question an image cannot settle and a
 * `getBoundingClientRect` can.
 */
const probeFor = (selector) => `(() => {
  const root = document.querySelector(${JSON.stringify(selector)})
  if (!root) return { missing: true }
  const box = root.getBoundingClientRect()
  const name = (node) => {
    const cls = [...node.classList].filter((c) => !c.startsWith("de-arrive"))[0]
    return cls ? "." + cls : node.tagName.toLowerCase()
  }
  const escapes = []
  const truncated = []
  const cut = []
  for (const node of root.querySelectorAll("*")) {
    const rect = node.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    const over = Math.round(Math.max(rect.right - box.right, box.left - rect.left))
    if (over > 1) escapes.push(name(node) + " by " + over + "px")
    const style = getComputedStyle(node)
    const clips = style.overflowX === "hidden" || style.overflowX === "clip"
    if (clips && node.scrollWidth > node.clientWidth + 1) {
      const where = name(node) + " (" + (node.scrollWidth - node.clientWidth) + "px hidden)"
      if (style.textOverflow === "ellipsis") truncated.push(where)
      else cut.push(where)
    }
  }
  return {
    missing: false,
    width: Math.round(box.width),
    height: Math.round(box.height),
    // The container itself, against the window. A card taller than the viewport
    // is only a break if it cannot be scrolled to, which is what the two
    // overflow reads below settle.
    offRight: Math.round(Math.max(0, box.right - window.innerWidth)),
    offBottom: Math.round(Math.max(0, box.bottom - window.innerHeight)),
    offLeft: Math.round(Math.max(0, -box.left)),
    offTop: Math.round(Math.max(0, -box.top)),
    scrolls: getComputedStyle(root).overflowY,
    pageScrollsX:
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    pageScrollsY:
      document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    escapes: escapes.slice(0, 6),
    truncated: truncated.slice(0, 6),
    cut: cut.slice(0, 6),
  }
})()`

/* ---------- rendering ---------- */

const START_VIEWPORT = { width: 520, height: 820 }
const MENU_VIEWPORT = { width: 520, height: 620 }

function withStub(html, spec) {
  return html.replace("</head>", `<script>${startStub(spec)}</script>\n</head>`)
}

async function shootStart(browser, html, spec) {
  const viewport = spec.viewport ?? START_VIEWPORT
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
  const problems = []
  page.on("pageerror", (error) => problems.push(String(error).slice(0, 220)))
  await page.setContent(withStub(html, spec), { waitUntil: "load" })
  await page.waitForTimeout(260)
  if (spec.drive) {
    try {
      await page.evaluate(`(async () => { ${spec.drive} })()`)
    } catch (error) {
      problems.push(`drive: ${String(error).slice(0, 220)}`)
    }
  }
  await page.waitForTimeout(140)
  const probe = await page.evaluate(probeFor("main.card")).catch(() => null)
  const file = `${spec.id}.png`
  /*
   * The card plus a margin, exactly as `before-after.mjs` frames it: a full-page
   * shot at these viewports is mostly empty ground, and the margin keeps the
   * card's shadow and its step off the page in frame. A card taller than the
   * window is shot whole, because the point of the quantity axis is how tall it
   * gets.
   */
  const box = await page.locator("main.card").boundingBox().catch(() => null)
  const margin = 20
  await page.screenshot({
    path: path.join(OUT, file),
    clip: box
      ? {
          x: Math.max(0, box.x - margin),
          y: Math.max(0, box.y - margin),
          width: Math.min(viewport.width, box.width + margin * 2),
          height: box.height + margin * 2,
        }
      : undefined,
    fullPage: !box,
  })
  await page.close()
  return { file, probe, problems, viewport }
}

async function shootChooser(browser, js, spec) {
  const viewport = spec.viewport ?? (spec.open ? MENU_VIEWPORT : { width: 300, height: 100 })
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
  const problems = []
  page.on("pageerror", (error) => problems.push(String(error).slice(0, 220)))
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8">
     <script>window.__DESIGNLAYER_CONFIG__ = ${chooserConfig(spec)}</script>
     <style>html,body{margin:0;height:100%}
       body{display:flex;align-items:flex-start;background:#1b1b1b}</style>
     </head><body></body></html>`,
    { waitUntil: "load" }
  )
  await page.addScriptTag({ content: js })
  try {
    await page.evaluate(
      async ([spec]) => {
        const built = await window.__demo.scene(
          { apps: spec.apps ?? [], appsFail: spec.appsFail, dirty: spec.dirty },
          "dark"
        )
        /*
         * The panel's width is a scenario, so it is set from here rather than
         * baked into the scene: the scene is shared with `chrome-demo.mjs`,
         * which has one width and no reason to grow a parameter.
         */
        const host = document.querySelector(".de-panel--left")
        if (host) host.style.width = `${spec.panel ?? 240}px`
        /*
         * Two answers the scene's stub has no opinion on, layered over it AFTER
         * it is installed and BEFORE the menu opens: a 200 carrying an `error`
         * string, and a refused switch. Both are states the control draws
         * differently and neither is reachable by varying the app list.
         */
        const inner = window.fetch
        window.fetch = async (target, init) => {
          const url = new URL(String(target), "http://127.0.0.1:3456")
          if (url.pathname.endsWith("/apps") && spec.appsError) {
            return { ok: true, status: 200, json: async () => ({ error: spec.appsError }) }
          }
          if (url.pathname.endsWith("/switch") && spec.switchFail) {
            return { ok: false, status: 409, json: async () => ({ message: spec.switchFail }) }
          }
          return inner(target, init)
        }
        if (spec.open) await built.open()
        if (spec.press) {
          document.querySelector(spec.press)?.click()
          await new Promise((resolve) => setTimeout(resolve, 260))
        }
      },
      [spec]
    )
  } catch (error) {
    problems.push(`drive: ${String(error).slice(0, 220)}`)
  }
  await page.waitForTimeout(180)
  const probe = await page
    .evaluate(probeFor(spec.open ? ".de-app-menu" : ".de-app-chooser"))
    .catch(() => null)
  const file = `${spec.id}.png`
  /*
   * The viewport, cropped at 760px. The menu is `position: fixed` and a clip
   * around it would hide exactly the thing these cases are about — whether it
   * fits — so the frame is the window. Past 760px there is nothing but ground,
   * and a 1280px shot at 2x costs a megabyte to say so.
   */
  await page.screenshot({
    path: path.join(OUT, file),
    clip: {
      x: 0,
      y: 0,
      width: Math.min(viewport.width, 760),
      height: viewport.height,
    },
  })
  await page.close()
  return { file, probe, problems, viewport }
}

/* ---------- the page ---------- */

const escape = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * What visibly broke, per scenario, written after the look.
 *
 * Empty on the first run by construction — a predicted failure is not a
 * finding, so nothing goes in here until the render exists to have broken. The
 * page is rebuilt from `shots.json` with `--page-only` once it is filled in.
 */
const NOTES = {
  "len-200":
    "The row truncates correctly, and then the same 200 characters are printed in full twice more — four wrapped lines in the note, four in the hint. The card grows from 655px to 724px on one app's title.",
  "len-unbreakable":
    "The note breaks after the single word “Picked”, leaving a one-word line above a 60-character run, and strands “for you.” at the end of it.",
  "len-empty":
    "Both rows read “Untitled app” and differ only by port, while the sentence under them says “Picked 127.0.0.1:3000 for you” — a name that appears nowhere in the list it is pointing at.",
  "qty-twenty":
    "The card reaches 1,327px with no ceiling and no scroll region of its own: 507px taller than the 820px window every other case here renders in.",
  "zoom-200":
    "267px of the card is below the fold, including both fields and the button the hint refers to. The page scrolls vertically to reach them.",
  "state-now-editing-320":
    "The project path runs past the right edge of the card and past the window, and the page gains a horizontal scrollbar. `.note` sets no `overflow-wrap`.",
  "state-waiting-lost":
    "The failure replaces the tip in the same muted grey, under a heading that still reads “Starting your app…” with the dot still pulsing — two contradictory statements, and the quieter one is the true one.",
  "menu-zero":
    "The backticks around `designlayer` are rendered as literal characters, and the start-screen address in the sentence is plain text rather than a link.",
  "menu-three":
    "The third row prints `http://127.0.0.1:5173` as its name and the same address again on the line below it. The trailing note renders its backticks literally too.",
  "menu-long":
    "Both long names ellipsise at 340px — 915px and 90px of string hidden — and the rows carry no tooltip, unlike the trigger above them, which does.",
  "menu-twenty":
    "The card flips above the trigger and covers it, the fifteenth row is sliced at the bottom edge, and no scrollbar is painted over it.",
  "menu-error":
    "Rendered in the same dim caption ink as the empty state above: a scan that failed and a machine with nothing else running look identical.",
  "menu-refused":
    "The rows are gone. A refused switch replaces the whole list with the sentence, so the apps the reader was choosing between are only reachable by closing the menu and opening it again.",
  "menu-w320":
    "The card keeps its 8px margin on the left and sits flush against the right edge of the window. Nothing is clipped; the gap is on one side only.",
  "menu-w1280":
    "The card is 8px inboard of the trigger it drops from, so with the panel flush to the window edge its left edge lines up with nothing.",
}

function instance(spec, shot) {
  const probe = shot.probe ?? {}
  const facts = []
  if (probe.missing) facts.push("the container was not in the document")
  if (probe.width) facts.push(`${probe.width}×${probe.height}px`)
  if (probe.offRight) facts.push(`${probe.offRight}px past the right edge of the window`)
  if (probe.offBottom) facts.push(`${probe.offBottom}px below the window`)
  if (probe.offLeft) facts.push(`${probe.offLeft}px past the left edge`)
  if (probe.offTop) facts.push(`${probe.offTop}px above the window`)
  if (probe.pageScrollsX) facts.push("the page scrolls horizontally")
  if (probe.pageScrollsY) facts.push("the page scrolls vertically")
  if (probe.escapes?.length) facts.push(`escapes its container: ${probe.escapes.join(", ")}`)
  if (probe.cut?.length) facts.push(`clipped with no ellipsis: ${probe.cut.join(", ")}`)
  if (probe.truncated?.length) facts.push(`ellipsised: ${probe.truncated.join(", ")}`)

  const broke = NOTES[spec.id]
  return `
<section class="case${broke ? " broke" : ""}" id="${spec.id}">
  <h3>${escape(spec.title)}</h3>
  <p class="meta">${escape(spec.id)} · ${shot.viewport.width}×${shot.viewport.height}px viewport${
    spec.panel ? ` · ${spec.panel}px panel` : ""
  }</p>
  ${spec.note ? `<p class="why">${escape(spec.note)}</p>` : ""}
  ${broke ? `<p class="broke-note">${escape(broke)}</p>` : ""}
  <img src="${shot.file}" alt="${escape(spec.title)}">
  ${facts.length ? `<p class="facts">${escape(facts.join(" · "))}</p>` : ""}
  ${shot.problems.length ? `<p class="problem">${shot.problems.map(escape).join("<br>")}</p>` : ""}
</section>`
}

/**
 * What broke, and the domain skill whose rules diagnose the fix.
 *
 * Empty until the look, for the same reason `NOTES` is: this file may only
 * report what was rendered. Filled in on the second pass, alongside the
 * per-instance notes it summarises.
 */
const FINDINGS = [
  [
    "Start screen · two apps that serve no title",
    "Both rows read “Untitled app” and differ only by port; the auto-pick sentence names “127.0.0.1:3000”, which appears nowhere in the list",
    "better-writing",
  ],
  [
    "Start screen · a 200-character app title",
    "Truncated in the row, then printed in full twice more — four wrapped lines in the note and four in the hint; the card grows 69px",
    "better-typography",
  ],
  [
    "Start screen · a 60-character unbreakable title",
    "The note breaks after the single word “Picked”, leaving a one-word line above a 60-character run",
    "better-typography",
  ],
  [
    "Start screen · deep project path at 320px",
    "The path escapes the card's right edge and the window; the page gains a horizontal scrollbar",
    "better-typography",
  ],
  [
    "Start screen · twenty apps",
    "The card reaches 1,327px with no ceiling and no scroll region — 507px past the window the other cases render in",
    "better-layout",
  ],
  [
    "Start screen · 200% zoom",
    "267px below the fold, including both fields and the button the hint tells the reader to press",
    "better-layout",
  ],
  [
    "Start screen · contact lost while waiting",
    "The failure sentence arrives in muted grey under a heading still reading “Starting your app…”, with the dot still pulsing",
    "better-writing",
  ],
  [
    "Chooser · an app with no package name and no folder",
    "The row prints its address as the name and the same address again on the line beneath it",
    "better-writing",
  ],
  [
    "Chooser · three sentences containing backticks",
    "The backticks around `designlayer` render as literal characters, and the start-screen address beside them is plain text rather than a link",
    "better-writing",
  ],
  [
    "Chooser · twenty apps",
    "The card flips above the trigger and covers it; the fifteenth row is sliced at the bottom edge with no scrollbar painted",
    "better-layout",
  ],
  [
    "Chooser · a refused switch",
    "The rows are replaced by the refusal sentence, so the list being chosen from is only reachable by closing and reopening the menu",
    "better-ui",
  ],
  [
    "Chooser · error, unreachable and empty states",
    "All three render as the same dim caption paragraph in the same box: a failed scan and a quiet machine look identical",
    "better-colors",
  ],
  [
    "Chooser · 320px viewport",
    "The card keeps its 8px margin on the left and sits flush against the right edge of the window",
    "better-layout",
  ],
  [
    "Chooser · the card against its trigger",
    "With the panel flush to the window edge the card is clamped 8px inboard, so its left edge aligns with nothing",
    "better-layout",
  ],
  [
    "Chooser · long names in a row",
    "Ellipsised at 340px with 915px of string hidden; the trigger above carries a tooltip with the full name and the rows do not",
    "better-typography",
  ],
]

function findingsTable() {
  if (FINDINGS.length === 0) {
    return `<p class="meta">No findings written yet — this page has not been read.</p>`
  }
  return `<table class="findings">
<thead><tr><th>Scenario</th><th>Observed</th><th>Owner</th></tr></thead>
<tbody>${FINDINGS.map(
    ([scenario, observed, owner]) =>
      `<tr><th>${escape(scenario)}</th><td>${escape(observed)}</td><td><code>${escape(
        owner.replace(/`/g, "")
      )}</code></td></tr>`
  ).join("")}</tbody></table>`
}

function buildPage(groups, meta) {
  const toc = groups
    .map(
      (group) =>
        `<li><a href="#${group.id}">${escape(group.axis)} <span>${group.cases.length}</span></a></li>`
    )
    .join("")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>designlayer — the start screen and the app chooser, under stress</title>
<style>
  :root { color-scheme: dark; --ink:#f2f2f2; --dim:rgba(255,255,255,0.62); --line:rgba(255,255,255,0.14); --warn:#ff8a65; }
  * { box-sizing: border-box; }
  body { margin:0; padding:40px 32px 96px; background:#1b1b1b; color:var(--ink);
         font:400 14px/1.6 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
  .page { max-width: 1180px; margin: 0 auto; }
  h1 { margin:0 0 6px; font-size:26px; }
  h2 { margin:0 0 18px; font-size:19px; }
  h3 { margin:0 0 2px; font-size:15px; }
  .meta { margin:0 0 10px; color:var(--dim); font-size:13px; }
  .meta code { font-family: ui-monospace, monospace; color:var(--ink); }
  .toc { margin:24px 0 40px; padding:0; list-style:none; display:flex; flex-wrap:wrap; gap:8px; }
  .toc a { display:block; padding:6px 10px; border:1px solid var(--line); border-radius:8px;
           color:var(--ink); text-decoration:none; font-size:13px; }
  .toc a span { color:var(--dim); }
  .toc a:hover { border-color:#7cc4f8; }
  .findings { width:100%; border-collapse:collapse; margin:0 0 40px; font-size:13px; }
  .findings th, .findings td { padding:8px 14px 8px 0; text-align:left; vertical-align:top;
                               border-bottom:1px solid var(--line); font-weight:400; }
  .findings thead th { color:var(--ink); font-weight:600; }
  .findings tbody th { color:var(--ink); font-weight:600; width:24%; }
  .findings td { color:var(--dim); }
  .findings code { font-family: ui-monospace, monospace; color:#7cc4f8; white-space:nowrap; }
  .group { margin:0 0 56px; padding-top:24px; border-top:1px solid var(--line); }
  .cases { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr));
           gap:28px; align-items:start; }
  .case { min-width:0; }
  .why { margin:0 0 8px; color:var(--dim); font-size:13px; }
  .broke-note { margin:0 0 8px; padding:8px 12px; border-radius:8px; font-size:13px;
                background:rgba(255,138,101,0.12); color:var(--warn); }
  .case.broke h3 { color:var(--warn); }
  img { width:100%; display:block; border:1px solid var(--line); border-radius:10px; background:#111; }
  .facts { margin:8px 0 0; font-size:12px; color:var(--dim); font-family:ui-monospace, monospace; }
  .problem { margin:8px 0 0; padding:6px 10px; border-radius:8px; font-size:12px;
             background:rgba(255,138,101,0.12); color:var(--warn); }
</style></head>
<body><div class="page">
  <h1>The start screen and the app chooser, under worst-case content</h1>
  <p class="meta">Both surfaces are the real ones: the start screen is <code>startScreenPage()</code> rendered as its own document, the chooser is <code>installAppChooser</code> over a real <code>createContext</code>, bundled from the working tree. Only the loopback routes and the bridge are invented. ${escape(
    meta.generatedAt
  )}</p>
  <p class="meta">Every instance is labelled with its scenario and the viewport it was rendered at. An orange note under a label is something that visibly broke. The line under each image is measured in the page, not read off the image.</p>
  <p class="meta">Not rendered here, and yours to try on this page's instances: keyboard focus, hover, OS dark mode (this chrome is dark in both), and <code>prefers-reduced-motion</code>.</p>
  ${findingsTable()}
  <ul class="toc">${toc}</ul>
  ${groups
    .map(
      (group) => `<section class="group" id="${group.id}">
    <h2>${escape(group.axis)}</h2>
    <div class="cases">${group.cases.join("\n")}</div>
  </section>`
    )
    .join("\n")}
</div></body></html>`
}

/** One group per axis, in the order the cases declare them. */
function groupCases(entries) {
  const groups = []
  for (const { spec, html } of entries) {
    const axis = spec.axis
    let group = groups.find((candidate) => candidate.axis === axis)
    if (!group) {
      group = { axis, id: axis.toLowerCase().replace(/\W+/g, "-"), cases: [] }
      groups.push(group)
    }
    group.cases.push(html)
  }
  return groups
}

function writePages(entries) {
  const html = buildPage(groupCases(entries), { generatedAt: new Date().toISOString() })
  fs.writeFileSync(path.join(OUT, "index.html"), html)
  /*
   * A second copy with the images inside it. The page above references its PNGs
   * by name and is the one to open locally; an artifact viewer or a bug comment
   * gets one file or nothing, and a page whose every image is a broken icon is
   * worse than no page.
   */
  const inlined = html.replace(/src="([^"]+\.png)"/g, (_, file) => {
    const bytes = fs.readFileSync(path.join(OUT, file))
    return `src="data:image/png;base64,${bytes.toString("base64")}"`
  })
  fs.writeFileSync(path.join(OUT, "standalone.html"), inlined)
  console.log(`\nwrote ${path.relative(ROOT, path.join(OUT, "index.html"))}`)
  console.log(`wrote standalone.html (${Math.round(inlined.length / 1024)}kb, images inlined)`)
}

/* ---------- run ---------- */

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const cacheFile = path.join(OUT, "shots.json")

  if (pageOnly) {
    if (!fs.existsSync(cacheFile)) {
      console.error("No shots.json — run without --page-only first.")
      process.exitCode = 1
      return
    }
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"))
    writePages(cached.map(({ spec, shot }) => ({ spec, html: instance(spec, shot) })))
    if (flags.has("--open")) execFileSync("open", [path.join(OUT, "index.html")])
    return
  }

  const pw = await loadPlaywright()
  if (!pw) {
    console.error("Playwright was not found. Install it (npm i -D playwright).")
    process.exitCode = 1
    return
  }

  /*
   * The chooser's scene, bundled through esbuild's stdin rather than from a
   * file of its own. `tools/chrome-demo-scene.js` already stands the control up
   * over a real context; importing it for its side effect is the whole entry
   * point, and a second scene file would be a second thing to keep true.
   */
  const bundled = await build({
    stdin: {
      contents: 'import "./chrome-demo-scene.js"\n',
      resolveDir: path.join(ROOT, "tools"),
      sourcefile: "break-scene.js",
      loader: "js",
    },
    absWorkingDir: ROOT,
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [path.join(ROOT, "node_modules")],
  })
  const sceneJs = bundled.outputFiles[0].text

  const { startScreenPage } = await import(
    pathToFileURL(path.join(ROOT, "runtime/start-screen-page.mjs")).href
  )
  const startHtml = startScreenPage()

  const browser = await pw.chromium.launch()
  const cache = []

  if (only !== "chooser") {
    for (const spec of START_CASES) {
      process.stdout.write(`  start/${spec.id}… `)
      const shot = await shootStart(browser, startHtml, spec)
      const plain = { ...spec, axis: `Start screen · ${spec.axis}` }
      cache.push({ spec: plain, shot })
      console.log(shot.probe ? `${shot.probe.width}×${shot.probe.height}` : "no probe")
    }
  }
  if (only !== "start") {
    for (const spec of CHOOSER_CASES) {
      process.stdout.write(`  chooser/${spec.id}… `)
      const shot = await shootChooser(browser, sceneJs, spec)
      /*
       * The surface's name is prefixed WHOLE rather than folded into the case's
       * own axis. Stripping it left "Trigger — content" and "Menu — content"
       * both reading "App chooser — content", which groups a closed button in
       * with an open card because two axes happened to share a last word.
       */
      const plain = { ...spec, axis: `App chooser · ${spec.axis}` }
      cache.push({ spec: plain, shot })
      console.log(shot.probe ? `${shot.probe.width}×${shot.probe.height}` : "no probe")
    }
  }
  await browser.close()

  /*
   * A `--only` run re-shoots one surface and keeps the other's shots, so the
   * page stays whole. Without this, fixing one chooser scenario would cost
   * twenty-five start-screen renders to get the report back.
   */
  let merged = cache
  if (only !== "both" && fs.existsSync(cacheFile)) {
    const previous = JSON.parse(fs.readFileSync(cacheFile, "utf8"))
    const fresh = new Set(cache.map((entry) => entry.spec.id))
    const kept = previous.filter((entry) => !fresh.has(entry.spec.id))
    merged = only === "chooser" ? [...kept, ...cache] : [...cache, ...kept]
  }
  fs.writeFileSync(cacheFile, JSON.stringify(merged, null, 2))
  writePages(merged.map(({ spec, shot }) => ({ spec, html: instance(spec, shot) })))
  if (flags.has("--open")) execFileSync("open", [path.join(OUT, "index.html")])
}

await main()
