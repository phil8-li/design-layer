/**
 * The app chooser: the control at the top of the left panel that names the app
 * being edited, and the menu that changes it.
 *
 * This is the one surface in the editor whose failure mode is losing the
 * session. Every other control is a view of ONE app; this one decides which app
 * that is, and picking a row here asks a supervisor to start an editor for
 * another app beside this one, then goes to it. So the cases below are chosen
 * for the failures that are silent — a chooser that still draws, still lists,
 * still switches, and quietly does the wrong thing:
 *
 *  - **the current row, matched by port.** The two halves of this answer are
 *    built by different machines and spell loopback differently: the prelude
 *    names the app `http://127.0.0.1:3000` and the scanner names it whichever of
 *    `127.0.0.1` and `[::1]` answered first. A string compare marks nothing as
 *    current on exactly the machines where the scan had to work hardest, and
 *    nothing on screen says so — the menu just looks like it has lost track of
 *    which app you are on. The case that pins this lists the current app at
 *    `[::1]` and the config at `127.0.0.1`;
 *  - **switching never stops this editor.** The picked app gets its own editor
 *    on its own port; the page polls for it by the id the switch answered and
 *    goes to it once it is ready. The waiting note can be dismissed, a failed
 *    start says why and gives the rows back, and inside the Mac app the frame
 *    asks the desk to show the editor instead of navigating itself;
 *  - **the arm/confirm window, and the fact that it is usually not there.** The
 *    removal queue, the Angular queue and the vendor store live in this tab and
 *    nowhere else, and going to any other editor unloads them. So a row
 *    pressed with work outstanding names what the next click would cost and
 *    goes on the second press, and a row pressed with nothing outstanding goes
 *    on the first. Both halves are pinned, because each is a regression in the
 *    other direction: an unconditional confirm makes a navigation something you
 *    perform twice, and no confirm at all loses an afternoon of edits to a
 *    misaimed click;
 *  - **a note where the rows would be — never an empty card, and never a note
 *    that is false.** Silence reads as "there are no apps", which is worse than
 *    "one moment". The note that used to stand here for a session with no start
 *    screen was worse still: it told a reader who had just opened the app
 *    chooser that this session had no app chooser;
 *  - **one line per row, and what each state spends it on.** A row printed
 *    three facts on two lines — the name, then the full url, then a clause or a
 *    folder — plus a paragraph under the list, for a control whose whole
 *    question is which app am I on and which could I be. Every character of
 *    those urls before the port was identical on every row, because loopback is
 *    the only thing this editor can be pointed at. So the cases below pin what
 *    the slot beside the name holds in each state — a port, three words on the
 *    row that cannot be opened, a verb and a count while armed, one word while
 *    handing over — and pin the two rules that let the row change what it says
 *    without changing its height, which is what an inline `min-height` used to
 *    buy by measuring.
 *
 * ## What jsdom can and cannot answer
 *
 * It can answer everything about STRUCTURE and BEHAVIOUR: which node is the
 * first child of the panel, what a click posts, which row wears `--current`,
 * where focus lands after Escape. Those are what the cases below drive, with
 * real events against a real tree.
 *
 * It cannot answer anything about the CASCADE — there is no layout, no stacking
 * and no computed z-index — and two of this control's claims are cascade
 * claims: the name truncates rather than pushing the chevron out of the panel,
 * and the menu paints above the panel it drops out of. Those are asserted
 * against the TEXT of `appChooserCss`, the way `layers-cases.mjs` asserts its
 * selected band, because the stylesheet is where the two facts actually live.
 *
 * It also cannot navigate: `window.location.assign` is unforgeable in jsdom and
 * raises "Not implemented" rather than going anywhere. The bundle is handed a
 * proxy `window` whose `location` records the target instead, so the two cases
 * that turn on where the page goes can assert on a URL rather than on a log line.
 *
 * ## Why each prologue gets its own module graph
 *
 * `core/config.ts` reads `__DESIGNLAYER_CONFIG__` ONCE at module load — right
 * for a page whose prologue cannot change its mind mid-session, useless to a
 * suite that needs the control built both named and nameless. So each config is
 * its own bundle, keyed by a `marker` export so the two differ in TEXT: the
 * module registry is keyed by the data: URL, and two byte-identical bundles are
 * one cached module wearing the first lane's config. Installs are cheap after
 * that — `installAppChooser` is a factory and its state is per call — so every
 * case that ends its own page gets a fresh control on an existing graph.
 *
 * The server half is imported directly from `server/apps.mjs` against a stubbed
 * `fetch`, because what is under test there is what it does with the start
 * screen's answer, and a real start screen would only add a second thing that
 * can fail while proving nothing about the relay.
 *
 * Usage: node designlayer/test/app-chooser-cases.mjs
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { createAppSwitcher } from "../server/apps.mjs"
import { chooserUrlFromEnv } from "../runtime/chooser-url.mjs"
import { PACKAGE_DIR } from "./host.mjs"

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// ── The world the bundle loads into ────────────────────────────────────────

const API = "/__designlayer"
const CHOOSER = "http://127.0.0.1:3455/"
/** The address the prelude knows the app by. The scanner spells it `[::1]`. */
const CURRENT = "http://127.0.0.1:3000"

const dom = new JSDOM('<!doctype html><html><body><main id="app">Page</main></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom
window.document.elementsFromPoint = () => []
// The menu measures itself to decide which side of the trigger it opens on, and
// a zero box would pin every case to the flipped branch.
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
}
window.Element.prototype.scrollIntoView = function scrollIntoView() {}
globalThis.DOMMatrixReadOnly = class {
  constructor() {
    this.m41 = 0
    this.m42 = 0
  }
}

/**
 * Where the page was sent, instead of sending it.
 *
 * `location` is unforgeable on both `Window` and `Location` in jsdom — a
 * `defineProperty` on either throws — so the interception happens one level out:
 * the bundle reads `window` as a free global, and the global it reads is this
 * proxy rather than jsdom's window. Everything but `location` is forwarded to
 * the real object, bound to it so `addEventListener` and friends are not called
 * on the wrong receiver. The test file keeps its own `window` binding from the
 * destructure above, so only the code under test sees the substitute.
 */
const navigations = []
/**
 * Reloads are counted separately from navigations, because after the handover
 * landed in place they are the two different endings a switch can have: a
 * reload is the editor coming back on the app you picked, and a navigation is
 * the fallback to the start screen when it did not.
 */
const reloads = []
/**
 * What the page posted to the Mac app's desk. In jsdom a top-level window is
 * its own parent, so the editor's `window.parent.postMessage` lands here.
 */
const deskPosts = []
window.postMessage = (message, origin) => deskPosts.push({ message, origin })
const fakeLocation = {
  assign: (url) => navigations.push(String(url)),
  replace: (url) => navigations.push(String(url)),
  reload: () => reloads.push(Date.now()),
  href: window.location.href,
  origin: window.location.origin,
  protocol: window.location.protocol,
  host: window.location.host,
  hostname: window.location.hostname,
  port: window.location.port,
  pathname: window.location.pathname,
  search: "",
  hash: "",
  toString: () => window.location.href,
  /**
   * Missing, as in jsdom and Firefox, until a case says which page frames this
   * one; see `framedBy`.
   */
  ancestorOrigins: undefined,
}
const proxyWindow = new Proxy(window, {
  get(target, property) {
    if (property === "location") return fakeLocation
    const value = Reflect.get(target, property, target)
    return typeof value === "function" ? value.bind(target) : value
  },
  set(target, property, value) {
    target[property] = value
    return true
  },
})

for (const key of [
  "document", "navigator", "Node", "Element", "HTMLElement", "HTMLButtonElement",
  "SVGElement", "SVGSVGElement",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
]) {
  // `navigator` is a getter-only global on Node 24, so plain assignment fails.
  Object.defineProperty(globalThis, key, {
    value: key === "getComputedStyle" ? window.getComputedStyle.bind(window) : window[key],
    configurable: true,
    writable: true,
  })
}
Object.defineProperty(globalThis, "window", {
  value: proxyWindow,
  configurable: true,
  writable: true,
})

// ── The other apps on this machine ─────────────────────────────────────────

/**
 * Three running prototypes, written to exercise the three ways a row can be
 * named and the two ways it can say where it lives.
 *
 * The first is the app this editor is already pointed at, and it is listed at
 * `[::1]` while the config says `127.0.0.1` — the disagreement a real
 * IPv6-first machine produces, and the whole reason the current row is matched
 * by port. The second has no package name and falls back to its title, with a
 * trailing separator on its project path that the folder name has to survive.
 * The third has neither name and falls back to the url it answers on.
 */
const APPS = [
  {
    port: 3000,
    url: "http://[::1]:3000",
    title: "Shop",
    projectRoot: "/work/shop",
    packageName: "shop-web",
  },
  {
    port: 4200,
    url: "http://127.0.0.1:4200",
    title: "Docs site",
    projectRoot: "/Users/ann/projects/docs/",
    packageName: null,
  },
  {
    port: 5173,
    url: "http://127.0.0.1:5173",
    title: "",
    projectRoot: "/work/sketch",
    packageName: null,
  },
]

const clone = (value) => JSON.parse(JSON.stringify(value))

/** Where the menu banks the last answer, so it can open without waiting. */
const RUNNING_APPS_CACHE = "designlayer.running-apps"

/*
 * Every `createAppSwitcher` below is handed `editors: () => []`.
 *
 * Without it the switcher falls through to the real registry and describes the
 * machine the suite happens to be running on — which, on the machine this was
 * written on, had six editors up, so "a session with no start screen has
 * nothing to switch to" came back with six rows in it. The registry has a suite
 * of its own (`editor-registry-cases.mjs`) where the machine is the subject;
 * here it is noise, and a case that passes or fails by what else is running is
 * not a case.
 */

/**
 * Both halves of the conversation behind one stub.
 *
 * The browser talks to `{apiBase}/apps` on its own origin; `server/apps.mjs`
 * talks to `api/apps` on the chooser's. Routing both here rather than swapping
 * the global between sections keeps every request in one list, which is what
 * the "it never fetches" cases read.
 */
const server = {
  /** What `GET {apiBase}/apps` answers with, or a thrown request. */
  apps: { chooser: true, apps: clone(APPS) },
  appsUnreachable: false,
  /** What `POST {apiBase}/apps/switch` answers with. */
  switch: { ok: true, status: 200, body: { ok: true, id: "e2", existing: false } },
  switchUnreachable: false,
  /**
   * What `GET {apiBase}/apps/started` answers, one entry per poll; the last one
   * repeats. Not ready by default, so a case sees the wait unless it says when
   * the editor comes up.
   */
  started: [{ ok: true, status: 200, body: { ready: false, url: null, stopped: null } }],
  /** Held open to keep a switch in flight while a case looks at the rows. */
  gate: null,
  /** What the start screen answers the SERVER half with. */
  chooser: { ok: true, status: 200, body: { apps: [] } },
  chooserUnreachable: false,
  chooserMalformed: false,
  calls: [],
  reset() {
    server.apps = { chooser: true, apps: clone(APPS) }
    server.appsUnreachable = false
    server.switch = { ok: true, status: 200, body: { ok: true, id: "e2", existing: false } }
    server.switchUnreachable = false
    server.started = [{ ok: true, status: 200, body: { ready: false, url: null, stopped: null } }]
    server.gate = null
    deskPosts.length = 0
    server.calls = []
    navigations.length = 0
    reloads.length = 0
    // The menu keeps the last answer in localStorage so it can open warm. Every
    // case below states its own starting point, so the cache is cleared between
    // them and the ones that are ABOUT the cache put it back deliberately.
    try {
      window.localStorage.removeItem(RUNNING_APPS_CACHE)
    } catch {
      // jsdom always has storage here; the guard matches the source's own.
    }
  },
}

async function serve(input, init = {}) {
  const url = String(input)
  const method = (init.method ?? "GET").toUpperCase()
  server.calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null })

  if (url === `${API}/apps`) {
    if (server.appsUnreachable) throw new Error("Failed to fetch")
    return { ok: true, status: 200, json: async () => clone(server.apps) }
  }
  if (url.startsWith(`${API}/apps/started?`)) {
    const answer = server.started.length > 1 ? server.started.shift() : server.started[0]
    if (answer.unreachable) throw new Error("Failed to fetch")
    return { ok: answer.ok, status: answer.status, json: async () => clone(answer.body) }
  }
  if (url === `${API}/apps/switch`) {
    if (server.gate) await server.gate
    if (server.switchUnreachable) throw new Error("Failed to fetch")
    return {
      ok: server.switch.ok,
      status: server.switch.status,
      json: async () => clone(server.switch.body),
    }
  }
  // The start screen, as `server/apps.mjs` sees it.
  if (url.startsWith(CHOOSER)) {
    if (server.chooserUnreachable) throw new Error("connect ECONNREFUSED 127.0.0.1:3455")
    return {
      ok: server.chooser.ok,
      status: server.chooser.status,
      json: async () => {
        if (server.chooserMalformed) throw new Error("Unexpected end of JSON input")
        return clone(server.chooser.body)
      },
    }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

globalThis.fetch = serve
window.fetch = serve

// ── Two prologues, two module graphs ───────────────────────────────────────

const { build } = await import("esbuild")

/**
 * One editor bundle built against a config of this suite's choosing.
 *
 * `installLeftPanel` rides along because the chooser's position in the column
 * is a claim about that file rather than about this one, and asserting it
 * through the real panel is the only version of it worth having.
 */
async function laneFor(app, chooserUrl, marker, extra = {}) {
  globalThis.__DESIGNLAYER_CONFIG__ = { apiBase: API, chooserUrl, app, ...extra }
  const lane = await build({
    stdin: {
      contents: `
        export const marker = ${JSON.stringify(marker)}
        export { createContext } from "./src/core/context"
        export { editorAddress, installAppChooser, onLocalhost, rowLabels } from "./src/panels/app-chooser"
        export { installLeftPanel } from "./src/panels/left"
        export { config } from "./src/core/config"
        export { icon } from "./src/core/icons"
        export { tokens } from "./src/core/tokens"
        export { appChooserCss } from "./src/core/css/app-chooser"
        export { shellCss } from "./src/core/css"
        export { appScopedKey } from "./src/core/app-scope"
      `,
      resolveDir: PACKAGE_DIR,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(lane.outputFiles[0].text).toString("base64")}`
  )
  globalThis.__DESIGNLAYER_CONFIG__ = undefined
  return module
}

/** A session that knows its app and was started from a start screen. */
const named = await laneFor({ url: CURRENT, name: "shop-web" }, CHOOSER, "named-app")
/** A `--dev` launch: no app name yet, and no screen to go back to. */
const ghost = await laneFor({ url: null, name: null }, null, "no-app")
/** The same session as `named`, as one of the Mac app's tabs. */
const DESK = "http://127.0.0.1:3454"
const inDesk = await laneFor({ url: CURRENT, name: "shop-web" }, CHOOSER, "in-desk", { deskUrl: DESK })
/** The same, with the prelude naming the desk where it now lives. */
const NEW_DESK = "http://localhost:3454"
const inNewDesk = await laneFor({ url: CURRENT, name: "shop-web" }, CHOOSER, "in-new-desk", { deskUrl: NEW_DESK })

// ── Mounting one chooser ───────────────────────────────────────────────────

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}

const baseBridge = {
  elementInfo: () => null,
  send() {},
  toast() {},
  subscribe: () => () => {},
  store: {
    setActiveTool() {},
    hasChanges: () => false,
    buildBatchOperations: () => [],
    onStateChange() {},
    getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
    viewportToPage: (x, y) => ({ x, y }),
    pageToViewport: (x, y) => ({ x, y }),
  },
}

/**
 * One control, mounted into a panel slot, with its own toast log and its own
 * answer to "is there unapplied work".
 *
 * Pending work arrives through `bridge.store.hasChanges` rather than through
 * the ledger, because that is the queue a designer is most likely to be holding
 * and because `pendingWork` reads all of them through this one bridge — a
 * module-level ledger entry would leak into every later case on the same graph.
 *
 * The menu is found through `aria-controls` rather than by class: several
 * controls are mounted into this one document and every one of them appends a
 * `.de-app-menu` to the body, so a query by class would answer with whichever
 * was installed first.
 */
function mount(lane, { pending = false } = {}) {
  const toasts = []
  let hasChanges = pending
  const left = slot()
  const context = lane.createContext(
    {
      ...baseBridge,
      toast: (message, kind, action) => toasts.push({ message, kind, action }),
      store: { ...baseBridge.store, hasChanges: () => hasChanges },
    },
    { overlay: slot(), toolbar: slot(), left, right: slot() }
  )
  const chooser = lane.installAppChooser(context)
  left.append(chooser.node)
  const trigger = chooser.node
  const menu = window.document.getElementById(trigger.getAttribute("aria-controls"))
  return {
    context,
    left,
    trigger,
    menu,
    toasts,
    name: () => trigger.querySelector(".de-app-chooser-name").textContent,
    rows: () => Array.from(menu.querySelectorAll(".de-app-menu-row")),
    note: () => menu.querySelector(".de-app-menu-note"),
    setPending: (value) => {
      hasChanges = value
    },
    destroy: () => {
      chooser.destroy()
      left.remove()
    },
  }
}

/**
 * Real elapsed time, for the handover wait and nothing else.
 *
 * Every other case here turns the microtask queue, which is enough for a fetch
 * and a repaint and costs nothing. The wait between two editors is the one
 * thing under test that is genuinely about the clock — it polls on a timer —
 * so it is the one place a suite has to actually wait.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Enough turns of the loop for a fetch, its `.json()` and the repaint to land. */
async function settle(turns = 4) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 0)))
  }
}

/** A pointer click. `detail: 1` is what tells the control a hand did this. */
const press = (node) =>
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }))
/** Menu keys are handled on `window`, in capture, so they go in at the document. */
const key = (name) =>
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true }))
const pointerDownOn = (node) =>
  node.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }))

/**
 * Banks an answer, the way a previous open would have.
 *
 * A control fetches when it is opened, when it is hovered, and 800ms after it
 * mounts. Only the first of those is worth driving from a test — the timer
 * would make every case that needs a warm cache wait most of a second, and the
 * hover has a case of its own. So this opens one, lets the answer land and
 * throws the control away, leaving exactly what a real previous open leaves:
 * an entry in localStorage.
 */
async function bankAnAnswer() {
  const priming = mount(named)
  await opened(priming)
  priming.destroy()
}

/** Moves focus onto a row the way the arrow keys would, so a repaint can be caught stealing it. */
function focusRowAt(ui, index) {
  const row = ui.rows()[index]
  row.focus()
  return row
}

/** Opens the menu and waits for the list to arrive. */
async function opened(ui) {
  press(ui.trigger)
  await settle()
  return ui
}

/** Four words is the floor for "a sentence" rather than a status code. */
const readsAsASentence = (text) => String(text).trim().split(/\s+/).length >= 4

/** The rule for one selector, so a case reads the block it is talking about. */
function rule(css, selector) {
  const start = css.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `no rule for ${selector}`)
  return css.slice(start, css.indexOf("}", start) + 1)
}

// ── The trigger ────────────────────────────────────────────────────────────

console.log("\nThe control that names the app")

const withName = mount(named)
const withoutName = mount(ghost)

/*
 * The name of the app appears in exactly one place in this editor, and this is
 * it. Before the control existed it appeared nowhere at all — every panel was a
 * view of an app the chrome never named.
 */
await check("the control shows the name of the app being edited", () => {
  assert.equal(withName.name(), "shop-web")
  assert.ok(!withName.trigger.classList.contains("de-app-chooser--empty"))
  // The accessible name says the app AND what pressing does. "Choose app" alone
  // would leave a screen reader user with no way to hear which app they are on.
  assert.equal(
    withName.trigger.getAttribute("aria-label"),
    "Editing shop-web. Choose a different app"
  )
  const chevron = withName.trigger.querySelector("svg")
  assert.ok(chevron, "no glyph on the control")
  assert.equal(chevron.outerHTML, named.icon("ChevronDown", named.tokens.icon.marker).outerHTML)
})

/*
 * The band is one line of a 240px column, so it truncates, and truncation with
 * no route to the full value is the failure this pins.
 *
 * Two checkouts of one project, or two branches of it, differ in the TAIL of
 * the name — which is the part the ellipsis eats. Before the tip there was no
 * surface anywhere in the chrome that showed the name whole: the trigger cuts
 * it and so did every row in the menu below it, so a reader looking at
 * `@acme/design-system-play…` could not find out which of two checkouts they
 * were editing, which is the single question this control exists to answer.
 *
 * The project's own tip and not `title`: it is delegated from the document, so
 * it reaches a node built here with no listener, and it paints above the menu
 * by construction. It is asserted by attribute because `tooltip.ts` is a
 * document-level singleton the panel suites do not install — the contract this
 * control owes is the attribute, and the card is that module's case to make.
 */
await check("the truncated name has somewhere to be read in full", () => {
  const name = withName.trigger.querySelector(".de-app-chooser-name")
  assert.equal(name.getAttribute("data-de-tip"), "shop-web")
  // Never both: a leftover `title` paints the OS tip over ours a second later.
  assert.equal(name.getAttribute("title"), null)
  // The accessible name already carries the whole thing, so the tip does not
  // touch it — a control named twice announces itself twice.
  assert.equal(name.getAttribute("aria-label"), null)
})

/*
 * No app name known is the state a `--dev` session opens in, and the control
 * must be the SAME control there: same box, same glyph, one modifier class that
 * changes nothing but the ink. A control that is a button when it has a value
 * and a line of hint text when it does not is two controls, and the second one
 * is the one a new user meets first. Both states are checked for the chevron
 * because losing it in the empty state is the plausible regression — it is the
 * only mark saying the row opens anything.
 */
await check("with no app known it keeps its shape and asks you to choose one", () => {
  assert.ok(withoutName.trigger.classList.contains("de-app-chooser--empty"))
  assert.equal(withoutName.name(), "Choose an app")
  assert.equal(withoutName.trigger.getAttribute("aria-label"), "Choose an app")
  const chevron = withoutName.trigger.querySelector("svg")
  assert.ok(chevron, "the empty state dropped the chevron")
  assert.equal(chevron.outerHTML, ghost.icon("ChevronDown", ghost.tokens.icon.marker).outerHTML)
})

/*
 * It names the thing every other surface in the panel is a view OF, so it leads
 * the column rather than sitting in one of the tabs below it. Asserted through
 * the real `installLeftPanel`, because where the control lands is that file's
 * claim and a chooser mounted by hand would prove nothing about it.
 */
await check("it leads the left panel, ahead of the tab strip", async () => {
  const left = slot()
  named.installLeftPanel(
    named.createContext(baseBridge, { overlay: slot(), toolbar: slot(), left, right: slot() })
  )
  await settle()
  const children = Array.from(left.children)
  assert.ok(children[0].classList.contains("de-app-chooser"), "the chooser is not the first child")
  assert.ok(children[1].classList.contains("de-tabs"), "the tab strip is not directly under it")
})

await check("it announces itself as a menu button and says when the menu is open", async () => {
  assert.equal(withName.trigger.getAttribute("aria-haspopup"), "menu")
  assert.equal(withName.trigger.getAttribute("aria-expanded"), "false")
  // A dangling `aria-controls` is worse than none: it promises a relationship
  // the assistive technology then cannot follow.
  const controlled = window.document.getElementById(withName.trigger.getAttribute("aria-controls"))
  assert.ok(controlled, "aria-controls names an element that is not in the document")
  assert.equal(controlled.getAttribute("role"), "menu")

  await opened(withName)
  assert.equal(withName.trigger.getAttribute("aria-expanded"), "true")
  press(withName.trigger)
  assert.equal(withName.trigger.getAttribute("aria-expanded"), "false")
})

withoutName.destroy()

// ── The menu, which is the chooser ─────────────────────────────────────────

console.log("\nThe menu as the chooser")

server.reset()

/*
 * A card that appears empty while the request is in flight reads as "there are
 * no apps" — a different and much worse answer than "one moment". The note is
 * mounted with the menu rather than after the fetch, so the assertion is made
 * BEFORE anything is awaited.
 */
await check("a control that has never seen an answer says it is looking", async () => {
  server.reset()
  // Its OWN control, and a cold one. Every other case here drives `withName`,
  // which has been mounted since the top of the file and has long since banked
  // an answer — so it opens warm, which is the whole point of it and the reason
  // this case cannot be asked of it.
  const cold = mount(named)
  press(cold.trigger)
  assert.equal(cold.menu.style.display, "block")
  assert.equal(cold.rows().length, 0)
  assert.match(cold.note().textContent, /Looking for running apps/)
  assert.ok(
    server.calls.some((call) => call.method === "GET" && call.url === `${API}/apps`),
    "opening cold did not go and ask"
  )
  await settle()
  assert.equal(cold.rows().length, 3, "the answer never replaced the note")
  cold.destroy()
  server.reset()
})

// Opened here rather than inherited from the case above, which now drives a
// control of its own: the three cases below all read the same list, so it is
// put on screen once, deliberately, where they can be seen to depend on it.
await opened(withName)

await check("each running app becomes a row that is a name and a port", () => {
  const rows = withName.rows()
  assert.equal(rows.length, 3)
  assert.deepEqual(
    rows.map((row) => row.querySelector(".de-app-menu-name").textContent),
    // The folder it was started from, then the package name, then the title,
    // and only then the url (runtime/app-name.mjs). Copies of one template
    // share a package name and a title, so the folder comes first.
    ["shop", "docs", "sketch"]
  )
  assert.deepEqual(
    rows.map((row) => row.querySelector(".de-app-menu-where").textContent),
    // The PORT, and nothing else, which is the whole of this case.
    //
    // This slot used to hold `http://[::1]:3000 · shop`: the full url, a middle
    // dot, and the project folder — with a clause about the row's KIND in place
    // of the folder on two of the three kinds. Everything in it before the port
    // is the same string on every row any machine can produce, because loopback
    // is the only thing this editor can be pointed at; and the folder is either
    // already the row's name or a second word for what the name just said. The
    // port is what is left when the repeated part comes out, and it is also the
    // part that tells two checkouts of one project apart, which is the question
    // this list exists to answer.
    //
    // Read off the url rather than the `port` field, and the first row is why
    // the two spellings of loopback do not matter: `server/apps.mjs` types that
    // field `number | null` while the browser's own interface promises a
    // number, so the url is the half that is always there.
    ["3000", "4200", "5173"]
  )
  for (const row of rows) {
    assert.equal(row.tagName, "BUTTON")
    assert.equal(row.getAttribute("role"), "menuitem")
    // Two children and no third. The only row kind that gets a third is the
    // editor row, and what it gets is a glyph rather than a clause — see the
    // navigation cases further down.
    assert.equal(row.childElementCount, 2, `a row grew a third thing: ${row.textContent}`)
    // The name is whole rather than clipped, so there is nothing for a tooltip
    // to reveal and no `title` promising otherwise. The TRIGGER is the surface
    // with no room, and it keeps its truncation and its `tip()`.
    assert.equal(row.querySelector(".de-app-menu-name").getAttribute("title"), null)
  }
})

/*
 * And nothing under the list, in the shape of session that has nothing wrong
 * with it.
 *
 * The note under the rows explains one thing — how to open an app whose project
 * folder could not be found — and it is worth a sentence when there is such a
 * row and worth nothing when there is not. Standing it under every list turns
 * the commonest view of this control into a list of three names followed by a
 * paragraph about a case none of them are in.
 */
await check("an ordinary list carries no sentence under it", () => {
  assert.equal(withName.rows().length, 3)
  assert.equal(withName.note(), null, "a list with nothing wrong with it was explained anyway")
})

/*
 * Copies of one template keep its package name. Four prototypes all read the
 * same word and only the port told them apart, so rows that share a name and
 * come from different folders are named by their folder. Two servers from one
 * folder keep the name, because there the port is the real difference.
 */
await check("rows that share a name are told apart by their folders", () => {
  const rows = [
    { port: 3000, url: "http://127.0.0.1:3000", title: "Studio", projectRoot: "/work/studio", packageName: "studio" },
    { port: 3041, url: "http://127.0.0.1:3041", title: "Studio", projectRoot: "/work/studio-pinned/", packageName: "studio" },
    { port: 4200, url: "http://127.0.0.1:4200", title: "Docs", projectRoot: "/work/docs", packageName: "docs" },
    { port: 8000, url: "http://127.0.0.1:8000", title: "Docs", projectRoot: "/work/docs", packageName: "docs" },
  ]
  const labels = named.rowLabels(rows)
  assert.deepEqual(rows.map((row) => labels.get(row)), ["studio", "studio-pinned", "docs", "docs"])
})

await check("another editor is opened on localhost", () => {
  assert.equal(named.onLocalhost("http://127.0.0.1:3464"), "http://localhost:3464")
  assert.equal(named.onLocalhost("http://127.0.0.1:3464/#/a?b=c"), "http://localhost:3464/#/a?b=c")
  assert.equal(named.onLocalhost("http://localhost:3464"), "http://localhost:3464")
  assert.equal(named.onLocalhost("not a url"), "not a url")
})

/*
 * THE case in this file.
 *
 * The prelude knows the app as `http://127.0.0.1:3000` because that is the
 * address the proxy was aimed at; the scanner knows it as `http://[::1]:3000`
 * because on an IPv6-first machine that is the address a dev server bound to
 * the NAME `localhost` actually answered on. A string compare marks nothing as
 * current on exactly those machines, and the only symptom is a menu that has
 * apparently forgotten which app you are editing.
 */
await check("the row for the app you are on is marked, even spelled another way", () => {
  const [current, ...others] = withName.rows()
  assert.equal(named.config.app.url, CURRENT, "the config kept the prelude's spelling")
  assert.notEqual(APPS[0].url, CURRENT, "this case only means something if the two disagree")
  assert.ok(current.classList.contains("de-app-menu-row--current"))
  assert.equal(current.getAttribute("aria-current"), "true")
  assert.equal(current.getAttribute("aria-label"), "shop, the app you are editing")
  for (const row of others) {
    assert.ok(!row.classList.contains("de-app-menu-row--current"))
    assert.equal(row.getAttribute("aria-current"), null)
  }
  assert.equal(others[0].getAttribute("aria-label"), "Switch to docs")
})

/*
 * Switching to the app you are already on would be a real switch: the page
 * would go to this app's editor again, and in a browser tab the session's
 * unapplied work would be gone in exchange for nothing. The row stays pressable
 * because it is the one row that answers the question the menu was opened to
 * ask — it just answers it by closing.
 */
await check("clicking the app you are already editing only closes the menu", () => {
  press(withName.rows()[0])
  assert.equal(withName.menu.style.display, "none")
  assert.equal(withName.trigger.getAttribute("aria-expanded"), "false")
  assert.equal(
    server.calls.filter((call) => call.url.endsWith("/apps/switch")).length,
    0,
    "the editor asked to be replaced by itself"
  )
})

/*
 * Three answers that are not a list of apps, and all three are 200s in the
 * contract because "there is nothing to choose" is an answer rather than a
 * fault. What matters is that each one puts a SENTENCE where the rows would be
 * — an empty card is indistinguishable from a broken one — and that each
 * sentence names something the reader can DO. A failure that reports only that
 * it failed leaves the reader with the same problem and one more fact.
 */
for (const [name, arrange, expected] of [
  [
    "this is the only app running",
    () => (server.apps = { apps: [] }),
    /Run designlayer in another project/,
  ],
  [
    "the server could not reach the start screen",
    () => (server.apps = { apps: [], error: "The start screen did not answer." }),
    /The start screen did not answer\./,
  ],
  [
    "the request never arrived at all",
    () => (server.appsUnreachable = true),
    /Reload to try again/,
  ],
]) {
  await check(`${name}: the menu says so, and says what to do about it`, async () => {
    server.reset()
    arrange()
    // Cold, so there is no banked list for the menu to keep showing. A warm
    // control deliberately holds its rows through a failed refresh — that is a
    // separate promise, and it has its own case further down.
    const ui = mount(named)
    await opened(ui)
    assert.equal(ui.rows().length, 0)
    const note = ui.note()
    assert.ok(note, "no note where the rows would be")
    assert.match(note.textContent, expected)
    assert.ok(readsAsASentence(note.textContent), `not a sentence: ${note.textContent}`)
    ui.destroy()
  })
}

/*
 * The sentence this control used to open with, in the commonest shape there is,
 * was that this control did not exist.
 *
 * A single editor with no start screen behind it answered `chooser: false`, and
 * the menu drew "this session was started without the app chooser, so there is
 * nothing to switch between" — inside the app chooser, which the reader had
 * just opened, and which works the moment a second editor comes up. It named no
 * way to make one come up either, so the lesson it taught was that the control
 * is dead here and not worth opening again.
 *
 * The replacement has to survive two tests that the old string failed: it must
 * be true of every session, and it must name the thing that puts a row in this
 * list. The command is that thing, and it is the same command that started the
 * editor the reader is looking at.
 */
await check("with only one app running it says how to get a second one listed", async () => {
  server.reset()
  server.apps = { apps: [] }
  const ui = await opened(mount(ghost))
  const text = ui.note().textContent
  assert.doesNotMatch(text, /nothing to switch between/, "the old claim came back")
  assert.doesNotMatch(text, /without the app chooser/, "the menu denied its own existence again")
  assert.match(text, /No other apps running\./)
  assert.match(text, /designlayer in another project/)
  ui.destroy()
  server.reset()
})

/*
 * A session that HAS a start screen has two ways forward, and the screen is the
 * quicker one — so it is named as well, not instead. The command works in every
 * session, including this one, which is why it leads.
 */
await check("a session with a start screen is offered that too, not instead", async () => {
  server.reset()
  server.apps = { apps: [] }
  const ui = await opened(mount(named))
  const text = ui.note().textContent
  assert.match(text, /designlayer in another project/)
  assert.match(text, /http:\/\/127\.0\.0\.1:3455\//)
  ui.destroy()
  server.reset()
})

console.log("\nOpening, closing and the keyboard")

server.reset()

/*
 * The cases below all drive one long-lived control, so they state where it
 * starts rather than inheriting it. That used to be a trailing `press` at the
 * end of every case in the block above — a toggle standing in for an
 * assignment, which only worked while the number of cases up there stayed even,
 * and which broke this whole section for a reason nobody reading the failure
 * could see.
 */
if (withName.menu.style.display !== "none") press(withName.trigger)

await check("a second press on the control closes it again", async () => {
  await opened(withName)
  press(withName.trigger)
  assert.equal(withName.menu.style.display, "none")
  assert.equal(withName.rows().length, 0, "a closed menu still holds its rows")
})

/*
 * Escape hands focus BACK. A menu that closes and leaves focus on the body
 * drops a keyboard user at the top of the document, which is the moment they
 * stop using the keyboard for this control.
 */
await check("Escape closes it and puts focus back on the control", async () => {
  await opened(withName)
  withName.rows()[1].focus()
  key("Escape")
  assert.equal(withName.menu.style.display, "none")
  assert.equal(window.document.activeElement, withName.trigger)
})

await check("a press anywhere else on the page closes it", async () => {
  await opened(withName)
  pointerDownOn(window.document.getElementById("app"))
  assert.equal(withName.menu.style.display, "none")
})

/*
 * A roving tabindex rather than a focusable list: one tab stop for the whole
 * menu means Tab LEAVES it instead of walking it, which is what `role="menu"`
 * promises, and the arrow keys then have to deliver everything else. Wrapping
 * is asserted in both directions because a list that stops at the ends makes
 * the last row the hardest one to reach.
 */
await check("the arrow keys walk the rows and wrap at both ends", async () => {
  await opened(withName)
  const rows = withName.rows()
  key("ArrowDown")
  assert.equal(window.document.activeElement, rows[0])
  key("ArrowDown")
  assert.equal(window.document.activeElement, rows[1])
  key("ArrowUp")
  assert.equal(window.document.activeElement, rows[0])
  key("ArrowUp")
  assert.equal(window.document.activeElement, rows.at(-1), "the top of the list did not wrap")
  key("ArrowDown")
  assert.equal(window.document.activeElement, rows[0], "the bottom of the list did not wrap")
})

await check("Home and End jump to the ends, and one row owns the tab stop", () => {
  const rows = withName.rows()
  key("End")
  assert.equal(window.document.activeElement, rows.at(-1))
  key("Home")
  assert.equal(window.document.activeElement, rows[0])
  // Exactly one, or Tab walks the menu instead of leaving it.
  assert.deepEqual(
    rows.map((row) => row.tabIndex),
    [0, -1, -1]
  )
  press(withName.trigger)
})

/*
 * The tab stop exists before any arrow key has been pressed.
 *
 * Every row mounts `tabindex="-1"` and the roving focus was the only thing that
 * ever wrote a `0` — so a pointer user who opened the menu and then reached for
 * the keyboard had no resting position to land on, and Tab left the card
 * without focus ever having been inside it.
 */
await check("a menu opened by pointer already has somewhere for Tab to land", async () => {
  await opened(withName)
  assert.deepEqual(
    withName.rows().map((row) => row.tabIndex),
    [0, -1, -1],
    "the list was drawn with no tab stop in it"
  )
  press(withName.trigger)
})

/*
 * Tab leaves, and the menu goes with it.
 *
 * This key was simply not handled. The card stayed painted over content the
 * reader was now tabbing through, still reporting `aria-expanded="true"`, with
 * nothing inert behind it — and forward-Tab only appeared to work by accident,
 * because the menu is the last node in `<body>`, so focus landed in the
 * browser's own chrome, the window blurred, and the blur handler closed it.
 * That is to say: the keyboard user's way out of this control was to leave the
 * page.
 *
 * `preventDefault` is deliberately NOT called, which is the half that makes it
 * the APG contract rather than just a dismissal: focus goes back to the trigger
 * and the browser's own Tab then moves to whatever follows the trigger, so the
 * reader resumes where the control sits instead of where the card was floating.
 */
await check("Tab dismisses the menu and hands the tab order back to the trigger", async () => {
  await opened(withName)
  withName.rows()[1].focus()
  const tab = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
  window.document.dispatchEvent(tab)
  assert.equal(withName.menu.style.display, "none", "the menu was left open behind the focus")
  assert.equal(withName.trigger.getAttribute("aria-expanded"), "false")
  assert.equal(window.document.activeElement, withName.trigger)
  assert.equal(tab.defaultPrevented, false, "the browser's own Tab was swallowed")
})

/*
 * A wheel gesture aimed at the card is the opposite of evidence that the reader
 * has moved on.
 *
 * Scroll closes this menu, which is the right trade for a surface anchored to a
 * control in a panel that scrolls independently — following the anchor would
 * mean measuring on every frame of somebody else's scroll. But the listener is
 * on `window` in capture, so it saw scrolls inside the card too, and the card
 * scrolls now: five registered editors plus the trailing note is taller than a
 * short window at 200% zoom, and the registry's own notes record five editors
 * running on the machine this was written on. Reaching for the tail of the list
 * dismissed the list.
 */
await check("scrolling inside the card keeps it; scrolling the page closes it", async () => {
  await opened(withName)
  withName.rows()[0].dispatchEvent(new window.Event("scroll", { bubbles: true }))
  assert.notEqual(withName.menu.style.display, "none", "reaching for the tail of the list closed it")
  window.document.getElementById("app").dispatchEvent(new window.Event("scroll", { bubbles: true }))
  assert.equal(withName.menu.style.display, "none")
})

/*
 * A resize gets the same answer, one step further out. `position()` runs on
 * open and on a changed payload, so a window resized while the card is up
 * leaves a `fixed` card sitting where the trigger used to be — a floating
 * surface that no longer touches its anchor misreports what it belongs to.
 * Closing is cheaper and more honest than following.
 */
await check("resizing the window closes the card rather than stranding it", async () => {
  await opened(withName)
  window.dispatchEvent(new window.Event("resize"))
  assert.equal(withName.menu.style.display, "none")
})

/*
 * The kit's menu grammar: no entrance, and a 150ms exit played on a copy.
 *
 * A menu opens instantly in its final geometry — it is opened dozens of times
 * an hour — so the card wears no entrance class. Dismissal must still be
 * complete at the instant it is asked for (a card still in the document absorbs
 * the next Escape), so the real card hides at once and the fade plays on an
 * inert, aria-hidden, id-less clone that removes itself.
 */
await check("the card opens with no entrance, and its exit plays on an inert copy", async () => {
  await opened(withName)
  assert.ok(!withName.menu.classList.contains("de-arrive"), "the card still plays an entrance")
  // jsdom has neither Web Animations nor layout, and `playExit` plays nothing
  // without both — so give it an engine and a box, and restore them after.
  const animate = window.HTMLElement.prototype.animate
  window.HTMLElement.prototype.animate = () => ({ finished: new Promise((done) => window.setTimeout(done, 150)) })
  const measure = withName.menu.getBoundingClientRect
  withName.menu.getBoundingClientRect = () => ({ left: 10, top: 40, width: 240, height: 120 })
  press(withName.trigger)
  window.HTMLElement.prototype.animate = animate
  withName.menu.getBoundingClientRect = measure
  assert.equal(withName.menu.style.display, "none", "the real card did not close at once")
  const ghost = window.document.querySelector("[data-de-leaving]")
  assert.ok(ghost, "no exit was played")
  assert.equal(ghost.getAttribute("aria-hidden"), "true")
  assert.ok(ghost.inert, "the leaving copy can still take focus or a click")
  assert.equal(ghost.querySelector("[id]"), null, "the leaving copy duplicates an id")
  assert.ok(!ghost.hasAttribute("role"), "the leaving copy is still announced as a menu")
  await new Promise((resolve) => window.setTimeout(resolve, 260))
  assert.equal(ghost.style.position, "fixed", "the copy is not pinned over the card's old box")
  assert.equal(window.document.querySelector("[data-de-leaving]"), null, "the copy outlived its exit")
})

withName.destroy()

// ── Switching, which ends this page ────────────────────────────────────────

console.log("\nSwitching to another app")

/*
 * With nothing to lose the click goes straight through, and this is the half
 * the armed step must not be allowed to eat.
 *
 * Picking an app off a list is a navigation — the same gesture as clicking a
 * layer or a tab — and a navigation that answers the first click with a
 * question has to be performed twice every time, including the overwhelming
 * majority of times when the session is holding nothing at all. An
 * unconditional confirm is a regression even though it is the safer-sounding
 * one, which is why it has a case of its own rather than living as a clause in
 * the case below.
 *
 * The body carries the url and the project folder because the start screen
 * needs both — it stats the folder and reads its scripts — and an explicit
 * `devScript: null` because an absent key would leave it guessing whether the
 * browser meant "use the default" or "this is an old build".
 */
await check("with nothing unapplied, one click asks the server to switch", async () => {
  server.reset()
  const ui = await opened(mount(named))
  press(ui.rows()[1])
  await settle()
  const posted = server.calls.filter((call) => call.method === "POST" && call.url === `${API}/apps/switch`)
  assert.equal(posted.length, 1)
  assert.equal(posted[0].url, `${API}/apps/switch`)
  assert.deepEqual(posted[0].body, {
    url: "http://127.0.0.1:4200",
    projectRoot: "/Users/ann/projects/docs/",
    devScript: null,
  })
  ui.destroy()
})

/*
 * With work outstanding the first click buys a warning and the second buys the
 * switch.
 *
 * For one build this row went on the first click whatever the session was
 * holding, and the comment defending that said the switch had been made free:
 * the pinned notes and the preview-only ledger moved to per-app storage, so
 * switching away files them rather than losing them. Both true. Neither of them
 * is the removal queue, the Angular queue or the vendor store, which are in
 * memory, have no `beforeunload` anywhere in the package, and go with the
 * document when a supervisor kills it. A designer with a column of unapplied
 * inspector edits lost every one of them to a click on a row that looked
 * exactly like the safe one beside it.
 *
 * What the armed step must NOT do is charge everybody for that. It appears only
 * when there is something to lose, which is what the next case is about.
 */
await check("with work outstanding, the first press warns and the second switches", async () => {
  server.reset()
  const ui = await opened(mount(named, { pending: true }))
  const row = ui.rows()[1]

  press(row)
  await settle()
  assert.equal(
    server.calls.filter((call) => call.method === "POST" && call.url === `${API}/apps/switch`).length,
    0,
    "a session holding unapplied edits was switched away on one click"
  )
  // The row still says which app it is — losing that would make the warning
  // impossible to place — and the port's slot names the OUTCOME of the next
  // click rather than asking a question the toast then has to answer.
  //
  // A verb and a count, and no sentence around them. "Switch anyway — N
  // unapplied changes will be lost" was the wording when this slot was a line
  // of its own; it is now the slot that holds four digits, and every word in it
  // is width taken off the name beside it. The instruction lives in the toast
  // and the whole of it in the accessible name, both asserted below.
  assert.equal(row.querySelector(".de-app-menu-name").textContent, "docs")
  assert.match(row.querySelector(".de-app-menu-where").textContent, /^Discards \d+ unapplied change/)
  assert.ok(row.classList.contains("de-app-menu-row--danger"), "the armed row carries no fill")
  assert.match(row.getAttribute("aria-label"), /will be lost/)
  // The words are in the toast as well, because a reader looking at the canvas
  // rather than at the menu gets one chance to be told what is at stake.
  //
  // The DEFAULT rung, not `error`: `DURATION.error` is `Infinity`, and a card
  // that never dismisses outlives the `ARMED_MS` window it is instructing. The
  // row stands itself down after six seconds and the card would go on telling
  // the reader to click again, where clicking again now only re-arms.
  assert.equal(ui.toasts.at(-1).kind, "info")
  assert.match(ui.toasts.at(-1).message.title, /discards \d+ unapplied change/)

  press(row)
  await settle()
  assert.equal(
    server.calls.filter((call) => call.method === "POST" && call.url === `${API}/apps/switch`).length,
    1,
    "the second press did not go through"
  )
  ui.destroy()
  server.reset()
})

/*
 * And it stands itself down, so a row armed by a misaimed click is not left
 * one stray press away from ending the session.
 *
 * Six seconds is the window the annotations tab's clear-all uses, and this
 * borrows it rather than inventing a second number for the same gesture. The
 * case drives the clock directly instead of waiting it out: what is being
 * pinned is that a timer exists and that firing it puts the row back exactly
 * as it was, not the particular number of milliseconds.
 */
await check("an armed row goes back to being an ordinary row if it is left alone", async () => {
  server.reset()
  const ui = await opened(mount(named, { pending: true }))
  const row = ui.rows()[1]
  const resting = row.querySelector(".de-app-menu-where").textContent
  const restingLabel = row.getAttribute("aria-label")

  press(row)
  assert.notEqual(row.querySelector(".de-app-menu-where").textContent, resting)
  await sleep(6100)
  assert.equal(
    row.querySelector(".de-app-menu-where").textContent,
    resting,
    "the row stayed armed after the window closed"
  )
  assert.equal(row.getAttribute("aria-label"), restingLabel)
  assert.ok(!row.classList.contains("de-app-menu-row--danger"))
  // And the press that follows is a first press again, not the confirmation of
  // a question the reader has long since forgotten answering.
  press(row)
  await settle()
  assert.equal(server.calls.filter((call) => call.method === "POST" && call.url === `${API}/apps/switch`).length, 0)
  ui.destroy()
  server.reset()
})

/*
 * Closing the menu disarms it too. A row that stayed armed across a close would
 * turn the next open into a menu where one row — indistinguishable from the
 * others, since the card is drawn fresh — goes on a single click.
 */
await check("closing the menu takes the armed row's second click away with it", async () => {
  server.reset()
  const ui = await opened(mount(named, { pending: true }))
  press(ui.rows()[1])
  key("Escape")
  await opened(ui)
  press(ui.rows()[1])
  await settle()
  assert.equal(
    server.calls.filter((call) => call.method === "POST" && call.url === `${API}/apps/switch`).length,
    0,
    "a menu reopened onto a row that was still armed from last time"
  )
  ui.destroy()
  server.reset()
})

/*
 * The half of a session's work that a switch genuinely does not cost, stated
 * where the chooser can be held to it.
 *
 * Pinned notes and the preview-only ledger are keyed per app rather than per
 * page, so switching files them under the app they belong to and switching back
 * brings them out. That is why the armed step counts unapplied EDITS and says
 * nothing about notes: naming them would be warning about a loss that does not
 * happen, and a warning that overstates is one people learn to click through.
 * `core/app-scope.ts` owns the key and its own suites own the round trip; this
 * case exists so that removing the scope shows up here, in the control whose
 * copy depends on it, and not only three files away.
 */
await check("notes and the preview-only ledger are filed per app, not dropped", () => {
  assert.notEqual(
    named.appScopedKey("designlayer.annotations."),
    ghost.appScopedKey("designlayer.annotations."),
    "two apps share one annotation bucket, so switching would overwrite notes"
  )
  assert.notEqual(
    named.appScopedKey("designlayer.preview-only."),
    ghost.appScopedKey("designlayer.preview-only."),
    "two apps share one ledger, so switching would overwrite the change list"
  )
})

/*
 * The supervisor runs one editor per app, so the picked app gets its own editor
 * on its own port while this one keeps running. The page polls the start
 * screen, through this editor's relay, with the id the switch answered, and
 * goes to the new editor's address once it is ready. Switching used to replace
 * this editor on the same port and reload into whatever came back there.
 */
await check("an accepted switch waits for the new editor, then goes to it", async () => {
  server.reset()
  server.started = [
    { ok: true, status: 200, body: { ready: false, url: null, stopped: null } },
    { ok: true, status: 200, body: { ready: true, url: "http://localhost:3458/#/guide", stopped: null } },
  ]
  const ui = await opened(mount(named))
  press(ui.rows()[1])
  await settle()

  assert.ok(!ui.toasts.some((toast) => toast.kind === "error"), "a successful switch reported one")
  assert.match(ui.toasts.at(-1).message, /Starting docs/)
  assert.match(ui.note().textContent, /Starting docs/)
  assert.doesNotMatch(ui.note().textContent, /reloads/, "the note still promises this page reloads")
  const polled = server.calls.filter((call) => call.url.startsWith(`${API}/apps/started?`))
  assert.equal(polled[0]?.url, `${API}/apps/started?id=e2`, "it did not ask after the editor the switch started")
  assert.deepEqual(navigations, [], "it left before the new editor was ready")

  await sleep(700)
  assert.deepEqual(navigations, ["http://localhost:3458/#/guide"], "the editor came up and the page did not go to it")
  assert.deepEqual(reloads, [])
  ui.destroy()
  server.reset()
})

/*
 * The start screen answers with the editor's address and the page the app
 * lands on. The app being left files its own page first, so switching back to
 * it lands there too. An address on 127.0.0.1 is opened on localhost, because
 * apps branch on that host name.
 */
await check("a switch files the page being left, and lands on localhost", async () => {
  server.reset()
  server.started = [
    { ok: true, status: 200, body: { ready: true, url: "http://127.0.0.1:3458/#/guide?step=2", stopped: null } },
  ]
  const ui = await opened(mount(named))
  // Nothing is filed for a page the person never used: an app's redirect on
  // load would otherwise write its shared home over the page they were on.
  window.dispatchEvent(new window.Event("hashchange"))
  assert.equal(server.calls.filter((call) => call.url === `${API}/apps/page`).length, 0, "a page nobody used was filed")
  // A key in the app itself is use.
  window.document.getElementById("app").dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true }))
  press(ui.rows()[1])
  await settle()
  const filed = server.calls.filter((call) => call.url === `${API}/apps/page`)
  assert.ok(filed.length > 0, "the app being left did not file its page")
  assert.deepEqual(filed.at(-1).body, { appUrl: CURRENT, page: "/" })
  assert.deepEqual(navigations, ["http://localhost:3458/#/guide?step=2"])
  ui.destroy()
  server.reset()
})

/*
 * Choosing an app whose editor is already running starts nothing: the start
 * screen answers with that editor's id and `existing: true`, the first poll
 * finds it ready, and the page goes there without a wait.
 */
await check("an app whose editor already runs opens on the first answer", async () => {
  server.reset()
  server.switch = { ok: true, status: 200, body: { ok: true, id: "e1", existing: true } }
  server.started = [{ ok: true, status: 200, body: { ready: true, url: "http://localhost:3460/#/cart", stopped: null } }]
  const ui = await opened(mount(named))
  press(ui.rows()[1])
  await settle()
  assert.deepEqual(navigations, ["http://localhost:3460/#/cart"])
  assert.equal(
    server.calls.filter((call) => call.url.startsWith(`${API}/apps/started?`)).length,
    1,
    "a ready editor was asked after more than once"
  )
  ui.destroy()
  server.reset()
})

/*
 * A page is filed under the editor's own app, read from the registry entry it
 * published. During a switch the page leaving reports to whichever editor holds
 * the port now, and that page is not this editor's app.
 */
await check("an editor files a page only for its own app", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-pages-"))
  const before = process.env.HOME
  process.env.HOME = home
  try {
    const pages = await import("../runtime/last-pages.mjs")
    const me = { pid: process.pid, appPort: 4100, projectRoot: "/work/shop", proxyPort: 3456 }
    const apps = createAppSwitcher({ chooserUrl: null, editors: () => [me] })
    assert.deepEqual(apps.rememberPage({ appUrl: "http://127.0.0.1:4100", page: "/#/cart" }), { ok: true })
    assert.equal(pages.lastPage({ port: 4100, projectRoot: "/work/shop" }), "/#/cart")
    // Another app's page, reported to this editor.
    assert.deepEqual(apps.rememberPage({ appUrl: "http://127.0.0.1:5173", page: "/#/other" }), { ok: false })
    // Not a page of this origin.
    apps.rememberPage({ appUrl: "http://127.0.0.1:4100", page: "//elsewhere.test/" })
    assert.equal(pages.lastPage({ port: 4100, projectRoot: "/work/shop" }), "/#/cart")
    // The same port from another project is another app.
    assert.equal(pages.lastPage({ port: 4100, projectRoot: "/work/docs" }), null)
  } finally {
    process.env.HOME = before
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/*
 * An editor that fails to start ends the wait with the start screen's own
 * sentence, in the note and in a toast, and the rows come back. This editor
 * was never in danger, so nothing navigates.
 */
await check("an editor that stops while starting says why, and the rows come back", async () => {
  server.reset()
  server.started = [
    { ok: true, status: 200, body: { ready: false, url: null, stopped: null } },
    { ok: true, status: 200, body: { ready: false, url: null, stopped: "docs stopped before it was ready." } },
  ]
  const ui = await opened(mount(named))
  press(ui.rows()[1])
  await sleep(700)
  assert.deepEqual(navigations, [], "it went to an editor that stopped")
  assert.equal(ui.note().textContent, "docs stopped before it was ready.")
  assert.equal(ui.toasts.at(-1).message, "docs stopped before it was ready.")
  assert.equal(ui.toasts.at(-1).kind, "error")
  const asked = server.calls.filter((call) => call.url.startsWith(`${API}/apps/started?`)).length
  await sleep(500)
  assert.equal(
    server.calls.filter((call) => call.url.startsWith(`${API}/apps/started?`)).length,
    asked,
    "it kept asking after an editor that had stopped"
  )
  key("Escape")
  await opened(ui)
  assert.deepEqual(
    ui.rows().map((row) => row.getAttribute("aria-disabled")),
    [null, null, null]
  )
  ui.destroy()
  server.reset()
})

/*
 * The relay refusing the question is final too: its sentence is the reason,
 * and asking again would get the same answer.
 */
await check("a refused status question ends the wait with its sentence", async () => {
  server.reset()
  server.started = [{ ok: false, status: 502, body: { ok: false, message: "The start screen did not answer." } }]
  const ui = await opened(mount(named))
  press(ui.rows()[1])
  await settle()
  assert.deepEqual(navigations, [])
  assert.equal(ui.note().textContent, "The start screen did not answer.")
  assert.equal(ui.toasts.at(-1).kind, "error")
  ui.destroy()
  server.reset()
})

/*
 * A request that fails is a failure. Switching used to kill the editor serving
 * this page, so a dropped connection was read as the switch taking effect;
 * nothing kills this editor now, so there is nothing to read into it.
 */
await check("a dropped switch request is reported and goes nowhere", async () => {
  server.reset()
  server.switchUnreachable = true
  const ui = await opened(mount(named))
  press(ui.rows()[1])
  await settle()

  assert.deepEqual(navigations, [], "it left the page over a switch that never happened")
  assert.deepEqual(reloads, [])
  assert.doesNotMatch(ui.note().textContent, /Starting docs/, "it waited for an editor nobody started")
  assert.equal(
    server.calls.filter((call) => call.url.startsWith(`${API}/apps/started?`)).length,
    0,
    "it polled for an editor nobody started"
  )
  assert.equal(ui.toasts.at(-1).kind, "error")
  // The sentence names a recovery rather than a status code. `Could not switch
  // apps (502)` was the old one: a number the reader cannot act on, standing in
  // for the sentence that would have told them how.
  assert.match(ui.note().textContent, /^Could not switch to docs\./)
  assert.match(ui.note().textContent, /Try again, or start it from http:\/\/127\.0\.0\.1:3455\//)
  assert.doesNotMatch(ui.note().textContent, /\(\d{3}\)/, "a raw HTTP status reached the reader")

  // And the card is dismissible, because nothing is happening to this page.
  key("Escape")
  assert.equal(ui.menu.style.display, "none", "a working editor was left under a card that will not close")
  // The rows come back rather than staying dead over a switch that did not take.
  await opened(ui)
  assert.deepEqual(
    ui.rows().map((row) => row.getAttribute("aria-disabled")),
    [null, null, null]
  )
  ui.destroy()
  server.reset()
})

/*
 * This editor keeps running while the other one starts, so the menu holding
 * the waiting note closes like any menu. The wait goes on behind it, a reopen
 * shows the note rather than rows that cannot be pressed, and the page still
 * goes once the editor is ready.
 */
await check("the waiting note can be dismissed, and the page still goes when ready", async () => {
  server.reset()
  const ui = await opened(mount(named))
  press(ui.rows()[1])
  await settle()
  assert.match(ui.note().textContent, /Starting docs/)

  key("Escape")
  assert.equal(ui.menu.style.display, "none", "Escape did not close a menu over a working editor")
  await opened(ui)
  assert.deepEqual(ui.rows(), [], "a reopen during the wait offered rows that cannot be pressed")
  assert.match(ui.note().textContent, /Starting docs/)
  pointerDownOn(window.document.getElementById("app"))
  assert.equal(ui.menu.style.display, "none")

  server.started = [{ ok: true, status: 200, body: { ready: true, url: "http://localhost:3458/", stopped: null } }]
  await sleep(600)
  assert.deepEqual(navigations, ["http://localhost:3458/"], "a closed menu gave up the wait")
  ui.destroy()
  server.reset()
})

/*
 * The wait is long and its note can be dismissed, so the designer keeps
 * editing through it. A page that went the moment the editor was ready took
 * those edits with it, on a click made before they existed. So readiness asks
 * again: with work outstanding the page stays, and the ready editor waits in
 * the menu as a row behind the same two-step every other row uses.
 */
const READY_GUIDE = [{ ok: true, status: 200, body: { ready: true, url: "http://127.0.0.1:3458/#/guide", stopped: null } }]

/** Starts docs, edits during the wait, and lets the editor come up. */
async function heldReady(lane = named, { closeFirst = false } = {}) {
  const ui = await opened(mount(lane))
  press(ui.rows()[1])
  await settle()
  if (closeFirst) key("Escape")
  ui.setPending(true)
  server.started = clone(READY_GUIDE)
  await sleep(600)
  return ui
}

await check("edits made during the wait keep the page, and the ready editor waits in the menu", async () => {
  server.reset()
  const ui = await heldReady()
  assert.deepEqual(navigations, [], "the page went and took the edits made during the wait")
  const told = ui.toasts.at(-1)
  assert.equal(told.kind, "info")
  assert.equal(told.message.title, "docs is ready")
  assert.equal(told.message.description, "It did not open, so your unapplied changes are still here.")
  assert.equal(told.action?.label, "Open")
  assert.equal(ui.note().textContent, "docs is ready. It did not open, so your unapplied changes are still here.")

  const row = ui.menu.querySelector(".de-app-menu-row--ready")
  assert.ok(row, "the menu does not offer the ready editor")
  assert.equal(ui.rows()[0], row, "the ready editor does not lead the card")
  assert.equal(row.getAttribute("aria-label"), "Open docs, which is ready")
  assert.equal(row.querySelector(".de-app-menu-where").textContent, "Ready")
  // It stands in for docs' own row; the rest of the list stays pressable.
  assert.deepEqual(
    ui.rows().slice(1).map((other) => other.querySelector(".de-app-menu-name").textContent),
    ["shop", "sketch"]
  )
  assert.ok(ui.rows().every((other) => other.getAttribute("aria-disabled") === null))

  press(row)
  await settle()
  assert.deepEqual(navigations, [], "the ready editor opened on one click over unapplied edits")
  assert.match(row.querySelector(".de-app-menu-where").textContent, /^Discards \d+ unapplied change/)
  assert.match(ui.toasts.at(-1).message.title, /^Switching discards \d+ unapplied change/)
  press(row)
  await settle()
  assert.deepEqual(navigations, ["http://localhost:3458/#/guide"])
  ui.destroy()
  server.reset()
})

await check("the toast's Open opens the menu onto the ready editor and arms it", async () => {
  server.reset()
  const ui = await heldReady(named, { closeFirst: true })
  assert.equal(ui.menu.style.display, "none")
  assert.deepEqual(navigations, [])

  ui.toasts.at(-1).action.onClick()
  await settle()
  assert.equal(ui.menu.style.display, "block", "Open did not show the menu")
  const row = ui.menu.querySelector(".de-app-menu-row--ready")
  assert.ok(row.classList.contains("de-app-menu-row--danger"), "Open did not arm the row")
  assert.deepEqual(navigations, [], "Open discarded the edits without the second press")
  press(row)
  await settle()
  assert.deepEqual(navigations, ["http://localhost:3458/#/guide"])
  ui.destroy()
  server.reset()
})

await check("a ready editor goes on one click once the edits are applied", async () => {
  server.reset()
  const ui = await heldReady()
  ui.setPending(false)
  press(ui.menu.querySelector(".de-app-menu-row--ready"))
  await settle()
  assert.deepEqual(navigations, ["http://localhost:3458/#/guide"], "it asked a question with nothing to lose")
  ui.destroy()
  server.reset()
})

/*
 * A JSON refusal is a different animal: the server is alive and declining, so
 * nothing navigates and the reason is carried through in the start screen's own
 * words. Both a toast and a note, and not one or the other — the toast is what
 * a designer looking at the canvas sees, the note is what is still there a
 * second later when they look back at the menu.
 */
await check("a refusal with a reason is reported and goes nowhere", async () => {
  server.reset()
  server.switch = {
    ok: false,
    status: 400,
    body: { ok: false, message: "There is no dev script in that folder." },
  }
  const ui = await opened(mount(named))
  press(ui.rows()[1])
  await settle()
  assert.deepEqual(navigations, [], "the page left on a refusal")
  assert.equal(ui.note().textContent, "There is no dev script in that folder.")
  assert.equal(ui.toasts.at(-1).message, "There is no dev script in that folder.")
  assert.equal(ui.toasts.at(-1).kind, "error")
  ui.destroy()
})

/*
 * One choice per page. A second row pressed while the first is in flight would
 * queue a switch to an app this editor will never see, and the rows say so
 * rather than silently swallowing the press.
 *
 * `aria-disabled` and not the native attribute, and the difference is where the
 * keyboard user ends up. `disabled` makes an element unfocusable in the same
 * frame it is set, so the row the reader just pressed drops focus to `<body>` —
 * their reward for choosing an app is to be thrown to the top of the document
 * while the switch is still in flight. The class beside it is what carries
 * `pointer-events: none`, which is the half the pointer needs and the half the
 * keyboard must not have.
 */
await check("the rows refuse a second choice without dropping the reader's place", async () => {
  server.reset()
  let release = () => {}
  server.gate = new Promise((resolve) => (release = resolve))
  const ui = await opened(mount(named))
  const chosen = ui.rows()[1]
  chosen.focus()
  press(chosen)
  assert.deepEqual(
    ui.rows().map((row) => row.getAttribute("aria-disabled")),
    ["true", "true", "true"]
  )
  assert.deepEqual(
    ui.rows().map((row) => row.disabled),
    [false, false, false],
    "the native attribute came back and took the focused row with it"
  )
  assert.equal(window.document.activeElement, chosen, "the row the reader pressed lost focus")
  assert.ok(chosen.classList.contains("de-app-menu-row--busy"))
  await settle()
  assert.deepEqual(
    ui.rows().map((row) => row.getAttribute("aria-disabled")),
    ["true", "true", "true"],
    "the rows came back to life with the request still out"
  )
  release()
  server.gate = null
  await settle()
  // Accepted, so the rows are gone entirely — the menu is holding the handover
  // note now, which is a stronger version of the same promise than three
  // disabled rows would be.
  assert.deepEqual(ui.rows(), [], "the list survived a switch it had already accepted")
  assert.match(ui.note().textContent, /Starting docs/)
  ui.destroy()
  server.reset()
})

/*
 * The row reports its own handover in the slot that held its port, in one word,
 * and it no longer measures itself to do it.
 *
 * There used to be a `min-height` written into the row's inline style before
 * the phrase went in, and it was doing real work at the time: the row was two
 * lines, the second of them a wrapping url, so a phrase swapped into it could
 * come out one line or two and the card resized under a pointer that was
 * waiting for the page to be replaced. A one-line row whose trailing slot is
 * `flex: none; white-space: nowrap` cannot do that, so the measurement went —
 * and it is pinned as GONE, because dead code that measures something looks far
 * more necessary than dead code that does not, and the next reader of this file
 * would put it back.
 *
 * The constraint it protected is pinned too, in the only two places it can be:
 * the row keeps its name and its element count while the phrase is up, and the
 * sheet holds the slot to one line (see the stylesheet cases at the end).
 */
await check("the row says it is starting where it said its port, and does not measure itself", async () => {
  server.reset()
  let release = () => {}
  server.gate = new Promise((resolve) => (release = resolve))
  const ui = await opened(mount(named))
  const chosen = ui.rows()[1]
  assert.equal(chosen.querySelector(".de-app-menu-where").textContent, "4200")
  press(chosen)

  assert.equal(chosen.getAttribute("data-de-switching"), "")
  // The picked app gets an editor of its own; nothing here is switched off.
  assert.equal(chosen.querySelector(".de-app-menu-where").textContent, "Starting\u2026")
  // One word, because the slot takes its width out of the name beside it and a
  // phrase long enough to push a long name onto a second line would move the
  // card exactly as the old wrapping url did.
  assert.equal(chosen.querySelector(".de-app-menu-where").textContent.split(/\s+/).length, 1)
  // Still the same row, saying which app it is: the reader has to be able to
  // see WHAT is being handed over, not just that something is.
  assert.equal(chosen.querySelector(".de-app-menu-name").textContent, "docs")
  assert.equal(chosen.childElementCount, 2, "the handover grew the row a line of its own")
  assert.equal(chosen.style.minHeight, "", "the row measured itself to hold a height it cannot change")

  release()
  server.gate = null
  await settle()
  ui.destroy()
  server.reset()
})

// ── The server half ────────────────────────────────────────────────────────

console.log("\nRelaying the question to the start screen")

/*
 * An empty list is a fact about the machine, not a missing feature.
 *
 * This used to answer `chooser: false` when there was no screen and no sibling
 * editor, and the browser read that as "this session has no app chooser" and
 * said so, in the app chooser, to everybody running a single editor — which is
 * most people. The field never meant that: it answers whether a supervisor can
 * START something. So the empty list goes back as an empty list, and the menu
 * writes its own empty state, which is the only place that knows what the
 * reader could do about it.
 */
await check("one editor and no start screen is an empty list, not a missing chooser", async () => {
  server.reset()
  const apps = createAppSwitcher({ chooserUrl: null, editors: () => [] })
  assert.deepEqual(await apps.list(), { chooser: true, apps: [] })
  assert.deepEqual(server.calls, [], "it went looking for a screen that does not exist")
  assert.equal(apps.chooserUrl, null)
})

/*
 * The row the browser is promised is built HERE rather than passed through.
 *
 * The start screen assembles its rows from a page probe and an `lsof` against
 * the machine's own processes, and a field added there for its own benefit
 * would reach the browser purely because a fetch was forwarded. So the extra
 * key in this fixture is the case: what the page is shown is decided on this
 * side, and the keys in the contract are all of it.
 *
 * Seven now rather than five. `kind` and `target` arrived with the registry —
 * a row is either an app needing an editor started for it or an editor already
 * running, and the second carries the URL the browser navigates to. Both are
 * built here for exactly the reason the other five are.
 */
await check("a listed app is cut down to the keys the contract promises", async () => {
  server.reset()
  server.chooser = {
    ok: true,
    status: 200,
    body: {
      apps: [
        {
          port: 3000,
          url: "http://127.0.0.1:3000",
          title: "Shop",
          projectRoot: "/work/shop",
          packageName: "shop-web",
          // What the start screen knows and the browser has no business seeing.
          pid: 48213,
        },
        "not an app at all",
      ],
    },
  }
  const { chooser, apps } = await createAppSwitcher({
    chooserUrl: CHOOSER,
    // No registry in this case: the subject is what a RELAYED row is cut down
    // to, and a machine with editors on it would add rows that are not that.
    editors: () => [],
  }).list()
  assert.equal(chooser, true)
  assert.equal(apps.length, 1, "a row that is not an object became one")
  assert.deepEqual(Object.keys(apps[0]).sort(), [
    "kind",
    "packageName",
    // Where a switch to it lands; filled by this side, not the start screen.
    "page",
    "port",
    "projectRoot",
    "target",
    "title",
    "url",
  ])
  // A relayed row is an app with no editor of its own, so there is nowhere for
  // the browser to navigate and the slow path is the only one open to it.
  assert.equal(apps[0].kind, "app")
  assert.equal(apps[0].target, null)
  assert.equal("pid" in apps[0], false, "a key the start screen invented reached the browser")
  assert.equal(server.calls[0].url, `${CHOOSER}api/apps`)
})

/*
 * Never throws, which is the whole point of it: an unreachable screen is an
 * ordinary fact about a session, and a 500 would turn it into a page that says
 * something went wrong without saying what. Each of the three goes back as a
 * sentence the menu can put on screen.
 */
for (const [name, arrange] of [
  ["the screen is not answering", () => (server.chooserUnreachable = true)],
  ["the screen answered with a status", () => (server.chooser = { ok: false, status: 503, body: {} })],
  ["the screen answered with something that is not JSON", () => (server.chooserMalformed = true)],
]) {
  await check(`${name}: the list is empty with a reason, not an exception`, async () => {
    server.reset()
    server.chooser = { ok: true, status: 200, body: { apps: [] } }
    server.chooserUnreachable = false
    server.chooserMalformed = false
    arrange()
    const answer = await createAppSwitcher({ chooserUrl: CHOOSER, editors: () => [] }).list()
    assert.equal(answer.chooser, true, "the session does have a screen; it is just not talking")
    assert.deepEqual(answer.apps, [])
    assert.ok(readsAsASentence(answer.error), `not a sentence: ${answer.error}`)
  })
}

server.chooserUnreachable = false
server.chooserMalformed = false

/*
 * The body is checked before the screen is. The screen validates it too, and
 * far better — it stats the folder and reads its scripts — but a request with
 * no URL in it never needed the round trip to find that out.
 */
await check("a switch with nothing to switch to is refused before anything is asked", async () => {
  server.reset()
  const apps = createAppSwitcher({ chooserUrl: CHOOSER, editors: () => [] })
  for (const body of [
    {},
    { url: "http://127.0.0.1:3000" },
    { projectRoot: "/work/shop" },
    { url: "  ", projectRoot: "/work/shop" },
    { url: "http://127.0.0.1:3000", projectRoot: null },
  ]) {
    const error = await apps.switchTo(body).then(
      () => null,
      (thrown) => thrown
    )
    assert.ok(error, `${JSON.stringify(body)} was accepted`)
    assert.equal(error.statusCode, 400)
    assert.ok(readsAsASentence(error.message))
  }
  assert.deepEqual(server.calls, [], "a refusal cost a round trip")
})

await check("a session with no start screen cannot switch, and says which it is", async () => {
  server.reset()
  const error = await createAppSwitcher({ chooserUrl: null, editors: () => [] })
    .switchTo({ url: "http://127.0.0.1:3000", projectRoot: "/work/shop" })
    .then(
      () => null,
      (thrown) => thrown
    )
  assert.equal(error.statusCode, 409)
  assert.match(error.message, /not started from the start screen/)
  assert.deepEqual(server.calls, [])
})

/*
 * The screen's refusals are written for whoever is looking at a screen — "there
 * is no dev script in that folder", not "400" — so its sentence and its status
 * are carried through rather than replaced with one of ours. Only a response
 * that says nothing gets a sentence invented for it.
 */
await check("a refusal from the screen arrives in its own words and its own status", async () => {
  server.reset()
  server.chooser = {
    ok: false,
    status: 422,
    body: { error: "There is no dev script in /work/sketch." },
  }
  const refused = await createAppSwitcher({ chooserUrl: CHOOSER, editors: () => [] })
    .switchTo({ url: "http://127.0.0.1:5173", projectRoot: "/work/sketch" })
    .then(
      () => null,
      (thrown) => thrown
    )
  assert.equal(refused.statusCode, 422)
  assert.equal(refused.message, "There is no dev script in /work/sketch.")

  server.chooser = { ok: false, status: 500, body: {} }
  const silent = await createAppSwitcher({ chooserUrl: CHOOSER, editors: () => [] })
    .switchTo({ url: "http://127.0.0.1:5173", projectRoot: "/work/sketch" })
    .then(
      () => null,
      (thrown) => thrown
    )
  assert.equal(silent.statusCode, 500)
  assert.ok(readsAsASentence(silent.message))

  // This side is fine and the machine behind it is not, which is a 502 rather
  // than a failure of the request that arrived.
  server.chooserUnreachable = true
  const gone = await createAppSwitcher({ chooserUrl: CHOOSER, editors: () => [] })
    .switchTo({ url: "http://127.0.0.1:5173", projectRoot: "/work/sketch" })
    .then(
      () => null,
      (thrown) => thrown
    )
  assert.equal(gone.statusCode, 502)
  server.chooserUnreachable = false
})

await check("an accepted switch is one POST to the screen's own start route", async () => {
  server.reset()
  server.chooser = { ok: true, status: 200, body: { ok: true, id: "e2", existing: false, replaced: null } }
  const apps = createAppSwitcher({ chooserUrl: CHOOSER, editors: () => [] })
  // The id is kept: it is the only way the page can ask when that editor is
  // ready.
  assert.deepEqual(
    await apps.switchTo({
      url: "  http://127.0.0.1:4200  ",
      projectRoot: " /work/docs ",
      devScript: "dev",
    }),
    { ok: true, id: "e2", existing: false }
  )
  assert.equal(server.calls.length, 1)
  assert.equal(server.calls[0].url, `${CHOOSER}api/start`)
  assert.equal(server.calls[0].method, "POST")
  // Trimmed, because a url with a stray space is a url the screen cannot parse.
  assert.deepEqual(server.calls[0].body, {
    url: "http://127.0.0.1:4200",
    projectRoot: "/work/docs",
    devScript: "dev",
  })

  /*
   * `devScript` is optional all the way down: the screen resolves the project's
   * own best script when the key is absent, and the `null` the browser sends in
   * its place is a value it would have to reject rather than a question it can
   * answer for itself. So a non-string is dropped rather than forwarded.
   */
  server.calls.length = 0
  await apps.switchTo({ url: "http://127.0.0.1:4200", projectRoot: "/work/docs", devScript: null })
  assert.deepEqual(server.calls[0].body, {
    url: "http://127.0.0.1:4200",
    projectRoot: "/work/docs",
  })

  // An app whose editor already runs comes back as that editor.
  server.chooser = { ok: true, status: 200, body: { ok: true, id: "e1", existing: true, replaced: null } }
  assert.deepEqual(
    await apps.switchTo({ url: "http://127.0.0.1:4200", projectRoot: "/work/docs" }),
    { ok: true, id: "e1", existing: true }
  )
})

/*
 * `started` relays the start screen's per-editor status, cut down to the three
 * keys the page reads. The id goes in the query, encoded.
 */
await check("asking whether an editor started relays the screen's status for that id", async () => {
  server.reset()
  server.chooser = {
    ok: true,
    status: 200,
    body: { ready: true, url: "http://localhost:3458/#/guide", editing: { name: "docs" }, stopped: null },
  }
  const apps = createAppSwitcher({ chooserUrl: CHOOSER, editors: () => [] })
  assert.deepEqual(await apps.started("e 2"), { ready: true, url: "http://localhost:3458/#/guide", stopped: null })
  assert.equal(server.calls[0].url, `${CHOOSER}api/status?id=e+2`)
  assert.equal(server.calls[0].method, "GET")

  // An id the screen no longer knows is a 200 with a sentence, so the page stops.
  server.chooser = { ok: true, status: 200, body: { ready: false, editing: null, stopped: "That editor is not running." } }
  assert.deepEqual(await apps.started("gone"), { ready: false, url: null, stopped: "That editor is not running." })
})

await check("asking whether an editor started is refused with a reason when it cannot be answered", async () => {
  server.reset()
  const refusedWith = (promise) => promise.then(() => null, (thrown) => thrown)
  const apps = createAppSwitcher({ chooserUrl: CHOOSER, editors: () => [] })

  const noId = await refusedWith(apps.started(""))
  assert.equal(noId.statusCode, 400)
  assert.deepEqual(server.calls, [], "a request with no id cost a round trip")

  const noScreen = await refusedWith(createAppSwitcher({ chooserUrl: null, editors: () => [] }).started("e2"))
  assert.equal(noScreen.statusCode, 409)
  assert.ok(readsAsASentence(noScreen.message))

  server.chooserUnreachable = true
  const gone = await refusedWith(apps.started("e2"))
  assert.equal(gone.statusCode, 502)
  assert.ok(readsAsASentence(gone.message))
  server.chooserUnreachable = false

  server.chooser = { ok: false, status: 500, body: {} }
  const broken = await refusedWith(apps.started("e2"))
  assert.equal(broken.statusCode, 502)
  assert.ok(readsAsASentence(broken.message))
})

/*
 * The default is read from the environment rather than inside, so the route can
 * be handed a screen of its own in a test — but the default is the whole of how
 * a real session finds one, and nothing else in the suite exercises that seam.
 */
await check("with no screen handed to it, it takes the one the launcher named", () => {
  const before = process.env.DESIGNLAYER_CHOOSER_URL
  try {
    process.env.DESIGNLAYER_CHOOSER_URL = "http://127.0.0.1:3455"
    assert.equal(createAppSwitcher().chooserUrl, CHOOSER)
    assert.equal(chooserUrlFromEnv(process.env), CHOOSER)
    // Off-machine, and there is now nothing to switch with — which is the same
    // answer as a session that was never started from a screen at all.
    process.env.DESIGNLAYER_CHOOSER_URL = "https://example.com/"
    assert.equal(createAppSwitcher().chooserUrl, null)
    delete process.env.DESIGNLAYER_CHOOSER_URL
    assert.equal(createAppSwitcher().chooserUrl, null)
  } finally {
    if (before === undefined) delete process.env.DESIGNLAYER_CHOOSER_URL
    else process.env.DESIGNLAYER_CHOOSER_URL = before
  }
})

/*
 * Two controls in one document must not claim one menu.
 *
 * This is guarded because of how it failed rather than because anyone expected
 * it. The id came from a counter, a counter is per MODULE, and this suite
 * instantiates the module twice — two bundles, two configs, both counters
 * starting at zero. Both controls asked for `de-app-menu-1`, and
 * `getElementById` gave the second trigger the first trigger's menu. The
 * symptom was a menu that opened with `aria-expanded="true"` on one element and
 * `display: none` on the other, and nothing about either of them reads as
 * broken on its own.
 */
await check("two controls in one document never share a menu", async () => {
  server.reset()
  const a = mount(named)
  const b = mount(ghost)
  const idA = a.trigger.getAttribute("aria-controls")
  const idB = b.trigger.getAttribute("aria-controls")
  assert.notEqual(idA, idB, "two triggers point at one menu")
  assert.ok(a.menu && b.menu, "a trigger names a menu that is not in the document")
  assert.notEqual(a.menu, b.menu)
  // And the one that was opened is the one that opened: the bug showed up as
  // these two disagreeing.
  press(a.trigger)
  assert.equal(a.trigger.getAttribute("aria-expanded"), "true")
  assert.notEqual(a.menu.style.display, "none")
  assert.equal(b.menu.style.display, "none", "opening one control opened the other's menu")
  await settle()
  a.destroy()
  b.destroy()
  server.reset()
})

// ── An app that already has an editor of its own ───────────────────────────

console.log("\nSwitching to an editor that is already running")

/*
 * The shape of session the chooser was originally blind to, and the reason it
 * had to be rebuilt.
 *
 * It was written against the start screen: a supervisor keeps one alive, it
 * scans for apps, and switching meant asking it to kill this editor and spawn
 * the next. That is a real way to run the editor. It is not the common one. The
 * common one is several editors, each started on its own against an app that
 * was already up, each with its ports pinned so they coexist — and in that
 * shape there is no screen to ask, so the menu said "this session was started
 * without the app chooser" on a machine with six editors running on it.
 *
 * A row backed by a live editor is a different and much better thing than an
 * app row. The destination is already serving, so switching is a NAVIGATION:
 * nothing is started and nothing is waited for. This document still ends, so
 * unapplied work arms the row like any other.
 */
const EDITOR_ROW = {
  kind: "editor",
  port: 4200,
  url: "http://127.0.0.1:4200",
  title: "",
  projectRoot: "/Users/ann/projects/shop",
  packageName: "shop-admin",
  target: "http://127.0.0.1:3464",
}

await check("an app with an editor of its own is offered, with no start screen in sight", async () => {
  server.reset()
  // `chooser: true` with no chooser URL anywhere: switching between editors
  // needs nothing but their addresses.
  server.apps = { chooser: true, apps: [clone(EDITOR_ROW)] }
  const ui = mount(ghost)
  await opened(ui)
  assert.equal(ui.note(), null, "it still claimed there was nothing to switch to")
  const rows = ui.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].querySelector(".de-app-menu-name").textContent, "shop")
  assert.equal(rows[0].getAttribute("aria-disabled"), null)
  // The two kinds of row are no longer the same row with different plumbing.
  // One moves the page; the other asks a supervisor to start an editor, and
  // the reader has to be able to tell them apart before pressing either.
  //
  // A MARK rather than the clause that used to say it. `editor already running`
  // was four words per row spent on a fact the reader only needs in order to
  // answer one question — is pressing this cheap — and an arrow answers that
  // question in the width of a glyph, leaving the slot free for the port. The
  // glyph is `aria-hidden` by construction, so the whole of the distinction is
  // still in the accessible name for anyone who cannot see it.
  assert.equal(rows[0].querySelector(".de-app-menu-where").textContent, "4200")
  assert.equal(rows[0].childElementCount, 3, "the row that navigates carries no mark")
  const mark = rows[0].lastElementChild
  assert.equal(mark.tagName.toLowerCase(), "svg")
  assert.equal(mark.getAttribute("aria-hidden"), "true")
  assert.match(rows[0].getAttribute("aria-label"), /already has an editor running/)
  ui.destroy()
  server.reset()
})

/*
 * The whole difference: it goes there, and no supervisor is involved.
 *
 * It does ask ONE thing first, and the thing it asks is the destination. See
 * the case below for why.
 */
await check("clicking it moves the page, with no process swapped anywhere", async () => {
  server.reset()
  server.apps = { chooser: true, apps: [clone(EDITOR_ROW)] }
  const ui = mount(ghost)
  await opened(ui)
  const before = server.calls.filter((call) => call.method === "POST" && call.url === `${API}/apps/switch`).length

  press(ui.rows()[0])
  await settle()
  // The registry may say 127.0.0.1; an app may branch on its host name, so
  // every editor opens on localhost. A row with no page known opens the root.
  assert.deepEqual(navigations, ["http://localhost:3464/"], "it did not go to the other editor")
  assert.equal(
    server.calls.filter((call) => call.method === "POST" && call.url === `${API}/apps/switch`).length,
    before,
    "a navigation asked the server to swap processes as well"
  )
  // Nothing to start, so nothing to wait for.
  assert.deepEqual(reloads, [])
  assert.equal(server.calls.filter((call) => call.url.startsWith(`${API}/apps/started?`)).length, 0)
  ui.destroy()
  server.reset()
})

/*
 * The row lands on the page its app was last used on. Its bare proxy root is
 * the template's shared home page, which looks like a different app.
 */
await check("an editor row lands on its app's last page, not the root", async () => {
  server.reset()
  server.apps = { chooser: true, apps: [{ ...clone(EDITOR_ROW), page: "/#/orders?tab=open" }] }
  const ui = await opened(mount(ghost))
  press(ui.rows()[0])
  await settle()
  assert.deepEqual(navigations, ["http://localhost:3464/#/orders?tab=open"])
  ui.destroy()
  server.reset()
  // Anything that is not a path on that origin is dropped for the root.
  assert.equal(ghost.editorAddress("http://127.0.0.1:3464", "//elsewhere.test/"), "http://localhost:3464/")
  assert.equal(ghost.editorAddress("http://127.0.0.1:3464/", "/#/a"), "http://localhost:3464/#/a")
  assert.equal(ghost.editorAddress("http://127.0.0.1:3464", null), "http://localhost:3464/")
})

/*
 * Going to another editor unloads this document, and the unapplied work goes
 * with it, exactly as for an app row. So with work outstanding the first press
 * arms and the second goes. The way back reaches the editor, not the edits,
 * which is why this row no longer skips the confirm.
 */
await check("an editor row arms with work outstanding, and goes on the second press", async () => {
  server.reset()
  server.apps = { chooser: true, apps: [clone(EDITOR_ROW)] }
  const ui = mount(ghost, { pending: true })
  await opened(ui)
  const row = ui.rows()[0]
  press(row)
  await settle()
  assert.deepEqual(navigations, [], "a session holding unapplied edits left on one click")
  assert.match(row.querySelector(".de-app-menu-where").textContent, /^Discards \d+ unapplied change/)
  assert.match(row.getAttribute("aria-label"), /will be lost/)
  assert.match(ui.toasts.at(-1).message.title, /discards \d+ unapplied change/)
  press(row)
  await settle()
  assert.deepEqual(navigations, ["http://localhost:3464/"], "the second press did not go")
  ui.destroy()
  server.reset()
})

await check("an editor row goes on one click when nothing is pending", async () => {
  server.reset()
  server.apps = { chooser: true, apps: [clone(EDITOR_ROW)] }
  const ui = await opened(mount(ghost))
  press(ui.rows()[0])
  await settle()
  assert.deepEqual(navigations, ["http://localhost:3464/"], "it asked a question with nothing to lose")
  ui.destroy()
  server.reset()
})

/*
 * A row is only as fresh as the last `GET /apps`, because the registry sweeps
 * for dead editors at read time and at no other time. An editor killed between
 * the refresh and the click leaves a row that looks perfectly alive — and
 * following it replaced a working editor with the browser's own "site can't be
 * reached" page, taking the chooser with the document, so the only route back
 * was typing the old address from memory.
 *
 * One round trip against the destination buys that back, on a gesture that was
 * about to cost a whole page load anyway.
 */
await check("a row whose editor died between the refresh and the click goes nowhere", async () => {
  server.reset()
  server.apps = { chooser: true, apps: [clone(EDITOR_ROW)] }
  const ui = mount(ghost)
  await opened(ui)

  // Killed now, with the row already drawn: this is the whole of the race. The
  // registry stops listing it at the same moment, because a sweep that runs at
  // read time is exactly what makes the drawn row stale in the first place.
  const live = serve
  globalThis.fetch = window.fetch = async (input, init) => {
    if (/^http:\/\/(127\.0\.0\.1|localhost):3464\b/.test(String(input))) throw new Error("Failed to fetch")
    return live(input, init)
  }
  server.apps = { chooser: true, apps: [] }
  press(ui.rows()[0])
  await settle()
  globalThis.fetch = window.fetch = live

  assert.deepEqual(navigations, [], "the page went to an editor that is not there")
  assert.equal(ui.toasts.at(-1).kind, "error")
  assert.match(ui.toasts.at(-1).message, /shop is no longer running\./)
  // And the list went back for a fresh answer rather than leaving a row the
  // reader has just been told is dead sitting there to be pressed again.
  assert.deepEqual(ui.rows(), [], "the stale row survived the probe that killed it")
  assert.match(ui.note().textContent, /No other apps running/)
  ui.destroy()
  server.reset()
})

/*
 * An editor row is switchable whatever else is missing from it. The folder is
 * what the slow path needs in order to start something; this path starts
 * nothing, so a row with no project root behind it is still a live address.
 */
await check("an editor row with no project folder is still somewhere to go", async () => {
  server.reset()
  server.apps = {
    chooser: true,
    apps: [{ ...clone(EDITOR_ROW), projectRoot: null, packageName: null, title: "Shop" }],
  }
  const ui = mount(ghost)
  await opened(ui)
  const row = ui.rows()[0]
  assert.equal(row.getAttribute("aria-disabled"), null, "a live editor was refused for want of a folder")
  assert.equal(row.querySelector(".de-app-menu-where").textContent, "4200", "it reported a missing folder")
  press(row)
  await settle()
  assert.deepEqual(navigations, ["http://localhost:3464/"])
  ui.destroy()
  server.reset()
})

// ── Inside the Mac app ─────────────────────────────────────────────────────

console.log("\nGoing from one of the Mac app's tabs")

/*
 * Inside the Mac app every editor has or gets its own tab. A frame that
 * navigated itself to another editor put a second copy of it in the window,
 * and the vendor's socket takes one client, so the copy disconnected the tab
 * already showing it. The frame asks the desk instead, on the desk's own
 * origin, and stays where it is.
 */
async function inDeskFrame(fn) {
  const before = window.name
  window.name = "designlayer-desk:1"
  try {
    await fn()
  } finally {
    window.name = before
  }
}

await check("in the Mac app an editor row asks the desk to show it, and does not navigate", () =>
  inDeskFrame(async () => {
    server.reset()
    server.apps = { chooser: true, apps: [{ ...clone(EDITOR_ROW), page: "/#/orders" }] }
    const ui = await opened(mount(inDesk))
    deskPosts.length = 0
    press(ui.rows()[0])
    await settle()
    assert.deepEqual(navigations, [], "the frame navigated itself inside the desk")
    assert.deepEqual(
      deskPosts.filter((post) => post.message?.type === "designlayer-desk:go"),
      [{ message: { type: "designlayer-desk:go", url: "http://localhost:3464/#/orders" }, origin: DESK }]
    )
    // The frame stays, so the control is back at rest rather than dead.
    assert.equal(ui.menu.style.display, "none")
    await opened(ui)
    assert.equal(ui.rows()[0].getAttribute("aria-disabled"), null, "the rows stayed dead in a frame that did not leave")
    ui.destroy()
    server.reset()
  })
)

await check("in the Mac app a started editor is handed to the desk when ready", () =>
  inDeskFrame(async () => {
    server.reset()
    server.started = [{ ok: true, status: 200, body: { ready: true, url: "http://127.0.0.1:3458/#/guide", stopped: null } }]
    const ui = await opened(mount(inDesk))
    deskPosts.length = 0
    press(ui.rows()[1])
    await settle()
    assert.deepEqual(navigations, [])
    assert.deepEqual(
      deskPosts.filter((post) => post.message?.type === "designlayer-desk:go").map((post) => post.message.url),
      ["http://localhost:3458/#/guide"]
    )
    ui.destroy()
    server.reset()
  })
)

/*
 * In a browser tab nothing is posted: the same lane with no desk frame name
 * navigates, so a page opened outside the app is unchanged.
 */
await check("outside the Mac app the same session navigates and posts nothing", async () => {
  server.reset()
  server.apps = { chooser: true, apps: [clone(EDITOR_ROW)] }
  const ui = await opened(mount(inDesk))
  deskPosts.length = 0
  press(ui.rows()[0])
  await settle()
  assert.deepEqual(navigations, ["http://localhost:3464/"])
  assert.deepEqual(deskPosts.filter((post) => post.message?.type === "designlayer-desk:go"), [])
  ui.destroy()
  server.reset()
})

/*
 * Inside the app going never unloads this document: the desk selects the tab
 * that shows the other editor, or opens a new one. So there is nothing for a
 * row to warn about, and a "Discards" step would be a second click that saves
 * nothing.
 */
const deskGoes = () =>
  deskPosts.filter((post) => post.message?.type === "designlayer-desk:go").map((post) => post.message.url)

await check("in the Mac app no row arms, because this tab stays", () =>
  inDeskFrame(async () => {
    server.reset()
    server.apps = { chooser: true, apps: [clone(EDITOR_ROW)] }
    const editorRow = await opened(mount(inDesk, { pending: true }))
    press(editorRow.rows()[0])
    await settle()
    assert.deepEqual(deskGoes(), ["http://localhost:3464/"], "an editor row armed inside the app")
    assert.ok(!editorRow.toasts.some((toast) => /discards/i.test(toast.message?.title ?? "")))
    editorRow.destroy()

    server.reset()
    const appRow = await opened(mount(inDesk, { pending: true }))
    press(appRow.rows()[1])
    await settle()
    assert.equal(
      server.calls.filter((call) => call.method === "POST" && call.url === `${API}/apps/switch`).length,
      1,
      "an app row armed inside the app"
    )
    assert.doesNotMatch(appRow.rows()[1]?.querySelector(".de-app-menu-where")?.textContent ?? "", /Discards/)
    appRow.destroy()
    server.reset()
  })
)

await check("in the Mac app edits made during the wait never hold the go", () =>
  inDeskFrame(async () => {
    server.reset()
    const ui = await heldReady(inDesk)
    assert.deepEqual(deskGoes(), ["http://localhost:3458/#/guide"], "the desk was not asked to show the ready editor")
    assert.deepEqual(navigations, [])
    assert.equal(ui.menu.querySelector(".de-app-menu-row--ready"), null)
    ui.destroy()
    server.reset()
  })
)

// ── Which parent is the desk ───────────────────────────────────────────────

console.log("\nOnly the desk is told anything")

/**
 * Runs `fn` as a frame of `origin` with the frame name `name`, the way Chrome
 * reports a parent: `location.ancestorOrigins`, nearest first.
 */
async function framedBy(origin, name, fn) {
  const before = window.name
  fakeLocation.ancestorOrigins = {
    length: 1,
    0: origin,
    item: (index) => (index === 0 ? origin : null),
    contains: (candidate) => candidate === origin,
  }
  window.name = name
  try {
    await fn()
  } finally {
    window.name = before
    fakeLocation.ancestorOrigins = undefined
  }
}

const deskMessages = () => deskPosts.filter((post) => String(post.message?.type).startsWith("designlayer-desk:"))

/*
 * Any page can frame an editor and name the frame the way the desk does. A
 * check on the name alone posted the app's name and the page path to that
 * page's origin. The parent's origin, which the browser reports and a page
 * cannot forge, decides.
 */
await check("a page that frames the editor and names the frame like the desk is told nothing", () =>
  framedBy("https://example.com", "designlayer-desk:x", async () => {
    server.reset()
    server.apps = { chooser: true, apps: [clone(EDITOR_ROW)] }
    const ui = await opened(mount(inDesk, { pending: true }))
    assert.deepEqual(deskMessages(), [], "the app's name and page went to a page that is not the desk")
    // To everyone else this is a browser tab, so the row arms and then navigates.
    press(ui.rows()[0])
    await settle()
    assert.match(ui.rows()[0].querySelector(".de-app-menu-where").textContent, /^Discards/)
    press(ui.rows()[0])
    await settle()
    assert.deepEqual(navigations, ["http://localhost:3464/"])
    assert.deepEqual(deskMessages(), [])
    ui.destroy()
    server.reset()
  })
)

await check("another loopback port is not the desk either", () =>
  framedBy("http://localhost:3999", "designlayer-desk:1", async () => {
    server.reset()
    const ui = mount(inDesk)
    assert.deepEqual(deskMessages(), [])
    ui.destroy()
    server.reset()
  })
)

/*
 * The desk moved from 127.0.0.1 to localhost. An editor whose prelude names
 * one spelling still talks to a desk window opened on the other until the app
 * is reinstalled, and each message goes to the origin the parent is actually
 * on.
 */
await check("the desk on either loopback spelling is the desk", async () => {
  await framedBy(NEW_DESK, "designlayer-desk:1", async () => {
    server.reset()
    server.apps = { chooser: true, apps: [clone(EDITOR_ROW)] }
    const ui = await opened(mount(inDesk))
    assert.deepEqual(deskMessages()[0], {
      message: { type: "designlayer-desk:showing", name: "shop-web", page: "/" },
      origin: NEW_DESK,
    })
    press(ui.rows()[0])
    await settle()
    assert.deepEqual(deskMessages().at(-1), {
      message: { type: "designlayer-desk:go", url: "http://localhost:3464/" },
      origin: NEW_DESK,
    })
    assert.deepEqual(navigations, [])
    ui.destroy()
    server.reset()
  })
  // A prelude already on the new desk, in a window still on the old one. The
  // frame name does not matter once the parent's origin is known.
  await framedBy(DESK, "", async () => {
    server.reset()
    const ui = mount(inNewDesk)
    assert.deepEqual(deskMessages().map((post) => post.origin), [DESK])
    ui.destroy()
    server.reset()
  })
})

// ── Opening without waiting ────────────────────────────────────────────────

console.log("\nThe menu opens on what it already knows")

/*
 * The menu used to open holding "Looking for running apps…" and swap it for
 * rows a round trip later. The delay was the smaller half of the problem: the
 * swap also resized the card from one line to three, under a cursor that had
 * just stopped moving — so a menu about to be read jumped, and because the
 * answer is nearly always the same handful of apps, it jumped to say nothing
 * new.
 *
 * It opens on the last answer instead, and goes and checks behind it. The set
 * of dev servers on a machine changes a few times a day and this menu is opened
 * far more often than that, so the overwhelmingly common case is a refresh that
 * finds nothing changed and touches nothing on screen.
 */
await check("a menu that has seen an answer opens straight onto it", async () => {
  server.reset()
  const ui = mount(named)
  await opened(ui)
  assert.equal(ui.rows().length, 3)
  ui.destroy()

  // A second control, standing in for the next open — and for the open right
  // after an app switch, which is a new document and therefore a fresh module graph
  // with nothing in memory. The bank is localStorage, so both are warm.
  const warm = mount(named)
  press(warm.trigger)
  // No await: this is the same task as the click. Rows are already up and there
  // is no "looking" line to be replaced, which is what removes the jump.
  assert.equal(warm.rows().length, 3, "the menu opened empty and made the reader wait")
  assert.equal(warm.note(), null, "it opened on a placeholder rather than on the list")
  await settle()
  warm.destroy()
  server.reset()
})

/*
 * Opening warm must not mean opening stale. The check still goes out, and a
 * list that has genuinely changed replaces the rows.
 */
await check("it still asks, and a list that really changed is redrawn", async () => {
  server.reset()
  await bankAnAnswer()

  const ui = mount(named)
  server.apps = {
    chooser: true,
    apps: [
      clone(APPS[0]),
      { port: 7777, url: "http://127.0.0.1:7777", title: "Just started", projectRoot: "/work/new", packageName: "brand-new" },
    ],
  }
  press(ui.trigger)
  await settle()
  const names = ui.rows().map((row) => row.querySelector(".de-app-menu-name").textContent)
  assert.ok(names.includes("new"), `the refresh never landed: ${names.join(", ")}`)
  assert.ok(
    server.calls.some((call) => call.method === "GET" && call.url === `${API}/apps`),
    "it opened warm and never went to check"
  )
  ui.destroy()
  server.reset()
})

/*
 * Reopening onto the same apps reuses the rows the close took down — building
 * them was most of an open's script — so the reuse must be invisible: the tab
 * stop is back on the first row as on a fresh list, and the arrow keys walk
 * from there.
 */
await check("a reopen onto the same apps is a fresh list to the keyboard", async () => {
  server.reset()
  await bankAnAnswer()

  const ui = mount(named)
  press(ui.trigger)
  await settle()
  const first = ui.rows()
  key("ArrowDown")
  key("ArrowDown")
  assert.equal(first[1].tabIndex, 0, "the arrow keys never moved the tab stop")
  key("Escape")
  assert.equal(ui.menu.style.display, "none")
  assert.equal(ui.menu.children.length, 0, "the closed card still holds its rows")

  ui.trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 0 }))
  const again = ui.rows()
  assert.deepEqual(again, first, "the same apps were rebuilt rather than reused")
  assert.deepEqual(again.map((row) => row.tabIndex), [0, -1, -1], "the tab stop stayed where the last open left it")
  assert.equal(window.document.activeElement, again[0], "a keyboard open did not land on the first row")
  key("ArrowDown")
  assert.equal(window.document.activeElement, again[1])
  await settle()
  ui.destroy()
  server.reset()
})

/*
 * The other half of "no weird transition", and the one a naive cache gets
 * wrong: when the answer comes back IDENTICAL, nothing may be repainted.
 *
 * Replacing three rows with three equal rows is invisible as a still image and
 * very visible as motion — the card reflows and, worse, focus is thrown off
 * whichever row the arrow keys had reached. So the rows a reader is looking at
 * have to be the same DOM nodes before and after the refresh, not merely the
 * same text.
 */
await check("a refresh that changes nothing leaves the rows alone", async () => {
  server.reset()
  await bankAnAnswer()

  const ui = mount(named)
  press(ui.trigger)
  const before = ui.rows()
  assert.equal(before.length, 3, "this case only means anything on a warm open")
  focusRowAt(ui, 1)
  const focused = window.document.activeElement
  await settle()
  const after = ui.rows()
  assert.deepEqual(after, before, "identical apps were redrawn as new elements")
  assert.equal(window.document.activeElement, focused, "the refresh stole focus off a row")
  ui.destroy()
  server.reset()
})

/*
 * A refresh that fails while a list is on screen is not worth reporting. The
 * rows are the last thing this machine actually said, and they stay more useful
 * than an apology: the editor's own server having a moment says nothing about
 * whether those apps are still running.
 */
await check("a failed refresh keeps the list rather than replacing it with an apology", async () => {
  server.reset()
  await bankAnAnswer()

  const ui = mount(named)
  server.appsUnreachable = true
  press(ui.trigger)
  assert.equal(ui.rows().length, 3)
  await settle()
  assert.equal(ui.rows().length, 3, "a list on screen was thrown away for a failed refresh")
  assert.equal(ui.note(), null)
  ui.destroy()
  server.reset()
})

/*
 * A failure is never banked. A cached error would be shown instantly on the
 * next open and sit there until a fetch replaced it — a menu that opens already
 * claiming something is broken, about a request nobody has made yet.
 */
await check("an error is never what the next open starts from", async () => {
  server.reset()
  server.apps = { chooser: true, apps: [], error: "The start screen did not answer." }
  const ui = mount(named)
  await opened(ui)
  assert.match(ui.note().textContent, /did not answer/)
  ui.destroy()
  assert.equal(
    window.localStorage.getItem(RUNNING_APPS_CACHE),
    null,
    "the failure was banked for the next open to show"
  )
  server.reset()
})

/*
 * A pointer arriving on the control is the most reliable signal in a pointer
 * interface that a click is coming, and it buys the round trip the distance
 * between hovering a control and pressing it.
 */
await check("hovering the control fetches, so the press does not have to", async () => {
  await bankAnAnswer()
  server.reset()

  const ui = mount(named)
  ui.trigger.dispatchEvent(new window.MouseEvent("pointerenter", { bubbles: false }))
  await settle()
  assert.ok(
    server.calls.some((call) => call.method === "GET" && call.url === `${API}/apps`),
    "a hand on the control bought nothing"
  )
  press(ui.trigger)
  assert.equal(ui.rows().length, 3, "the hover did not leave the menu ready to open")
  ui.destroy()
  server.reset()
})

// ── An app the scanner found but could not place ───────────────────────────

console.log("\nA running app with no project folder behind it")

/*
 * `scanLocalApps` reads a project folder out of the paths a dev server writes
 * into its own page, and falls back to asking `lsof` where the process was
 * started. Both come up empty often enough to matter — a server that names no
 * paths, a machine where `lsof` is refused — and the row is still worth drawing,
 * because the app is genuinely running and leaving it out would be the stranger
 * answer.
 *
 * What it must not do is offer to switch. The editor rewrites source files, so
 * with no folder there is nothing to rewrite, and `server/apps.mjs` refuses the
 * request with a 400 the moment it arrives. Left live, the row armed, confirmed,
 * disabled the whole menu and only then replaced the list with a complaint about
 * a folder the menu offers no way to supply — four steps to reach a wall.
 */
const unplacedServer = () => {
  server.reset()
  server.apps = {
    chooser: true,
    apps: [
      { ...clone(APPS[0]) },
      { port: 9100, url: "http://127.0.0.1:9100", title: "Nameless", projectRoot: null, packageName: null },
    ],
  }
}

await (async () => {
  unplacedServer()
  const ui = await opened(mount(named))

  await check("an app with no project folder is listed, and listed as unopenable", () => {
    const [, dead] = ui.rows()
    assert.ok(dead, "the app vanished from the list instead of being marked")
    assert.ok(dead.classList.contains("de-app-menu-row--unplaced"))
    assert.equal(dead.getAttribute("aria-disabled"), "true", "a row that cannot work was left pressable")
    // Not the native attribute, which is the whole of the next case: `disabled`
    // takes the element out of the accessibility tree and the `aria-label`
    // below is the only place the reason lives.
    assert.equal(dead.disabled, false, "the reason went back behind a native disabled")
    // The reason is ON the row. A greyed row with no explanation reads as "not
    // available just now" and invites a second click.
    //
    // In three words, in the slot every other row spends on its port — which is
    // the trade this state is FOR: the port disambiguates two checkouts of one
    // project, and there is nothing to disambiguate on a row that cannot be
    // opened at all. `http://127.0.0.1:9100 · source folder not found` said the
    // same thing with a url in front of it that no reader could act on.
    assert.equal(dead.querySelector(".de-app-menu-where").textContent, "No project folder")
    assert.match(dead.getAttribute("aria-label"), /project folder not found/i)
  })

  await check("the row says it cannot work; the note under the list says what can", () => {
    // The row has no room to carry the way out, and repeating it once per app
    // would be noise. It is said once, under the list, and it names the start
    // screen — which has a folder picker, because a native directory dialog
    // belongs to the process that can open one.
    const note = ui.note()
    assert.ok(note, "no way out was offered at all")
    assert.match(note.textContent, /enter its path at/)
    assert.ok(readsAsASentence(note.textContent))
  })

  await check("the reason a row cannot be opened is reachable from the keyboard", () => {
    /*
     * This row used to be skipped by the arrow keys, on the argument that
     * parking focus on a control which refuses to act wastes a keystroke. The
     * argument is right about a row killed mid-switch and wrong about this one:
     * the explanation IS the row's purpose — it is why the row is drawn at all
     * rather than dropped — and it lives in an `aria-label` that only focus
     * reaches. Skipping it delivered the reason to exactly the readers who
     * could already see the second line, and hid it from the ones who could
     * not.
     */
    key("ArrowDown")
    key("ArrowDown")
    assert.equal(window.document.activeElement, ui.rows()[1], "the walk stepped over the reason")
    assert.match(window.document.activeElement.getAttribute("aria-label"), /project folder/i)
    // And it still wraps, so the walk is a loop rather than a dead end.
    key("ArrowDown")
    assert.equal(window.document.activeElement, ui.rows()[0])
  })

  await check("pressing it asks for nothing, so nothing can be refused", () => {
    const before = server.calls.length
    press(ui.rows()[1])
    assert.equal(server.calls.length, before, "a folderless app was still sent to the server")
  })

  /*
   * The way out is named whether or not there is a start screen to name.
   *
   * The note used to render only when `config.chooserUrl` was set, which gated
   * the one sentence in this menu that offers a recovery on the one session
   * shape least likely to have one. An unopenable row in a session with no
   * screen got the reason and nothing else at all.
   */
  await check("with no start screen the way out is still named", async () => {
    unplacedServer()
    const bare = await opened(mount(ghost))
    const note = bare.note()
    assert.ok(note, "an unopenable row was left with no way out at all")
    assert.match(note.textContent, /run designlayer in that folder/)
    assert.doesNotMatch(note.textContent, /enter its path at/, "it offered a screen this session has not got")
    bare.destroy()
  })

  ui.destroy()
  server.reset()
})()

// ── What the menu says when it has no rows to show ─────────────────────────

/*
 * Most of the menu's states are a sentence and nothing else: looking, nothing
 * else running, and the request failed.
 *
 * A bare `<div>` is not a permitted child of `role="menu"`, and a screen reader
 * walking the menu's children is entitled to drop it — which would announce
 * those states as an empty menu. The disabled menu item is the standard way to
 * say "there is one thing here and it is not actionable", and it stays out of
 * the arrow keys' way for free, because the roving focus walks
 * `.de-app-menu-row` and this is not one.
 */
await check("a sentence where the rows would be is still a thing the menu contains", async () => {
  server.reset()
  server.apps = { apps: [] }
  const ui = await opened(mount(named))
  const note = ui.note()
  assert.ok(note, "the menu is empty rather than explaining itself")
  assert.equal(note.getAttribute("role"), "menuitem")
  assert.equal(note.getAttribute("aria-disabled"), "true")
  assert.equal(note.getAttribute("tabindex"), "-1")
  // And it is not reachable by the arrow keys, which is what `aria-disabled`
  // promises: there is nothing here to activate.
  key("ArrowDown")
  assert.notEqual(window.document.activeElement, note)
  ui.destroy()
  server.reset()
})

/*
 * A menu opened from the keyboard onto a sentence used to be an open menu that
 * said nothing at all.
 *
 * `open(fromKeyboard)` set a flag, and only the row-drawing path ever read it —
 * every note path returned before reaching it. So Enter on the trigger opened a
 * card, left focus on the trigger, and answered the next ArrowDown with
 * nothing, because there were no rows to walk. In the session shape where this
 * menu's only content IS a sentence, that is a control reporting
 * `aria-expanded="true"` over an empty box.
 *
 * The note already carries `tabindex="-1"`, so the fix costs nothing but the
 * reading of the flag.
 */
await check("opening from the keyboard onto a sentence puts the reader on the sentence", async () => {
  server.reset()
  server.apps = { apps: [] }
  const ui = mount(named)
  // `detail: 0` is the click a keyboard synthesises from Enter or Space, and it
  // is how this control tells a keystroke from a hand.
  ui.trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 0 }))
  await settle()
  assert.equal(window.document.activeElement, ui.note(), "the menu opened and focus stayed behind")
  ui.destroy()
  server.reset()
})

/*
 * And the same open onto a LIST lands on the first row, which is the half that
 * already worked and is pinned here so the two cannot drift apart.
 */
await check("opening from the keyboard onto a list puts the reader on the first row", async () => {
  server.reset()
  const ui = mount(named)
  ui.trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 0 }))
  await settle()
  assert.equal(window.document.activeElement, ui.rows()[0])
  ui.destroy()
  server.reset()
})

/*
 * The sentence written mid-switch is announced, and it is announced because the
 * node it lands in was already in the document.
 *
 * A live region only reports mutations that happen INSIDE it while it is
 * mounted. Every state of this menu used to arrive as a fresh subtree handed to
 * `replaceChildren`, which is precisely the mutation a live region cannot see —
 * so the handover sentence, the failure sentence and the empty state were all
 * silent, and a screen-reader user watched an open menu say nothing while their
 * editor was being killed.
 *
 * The note lives inside the region rather than beside it: a separate hidden
 * copy of the same sentence is two strings that can disagree, and the first
 * time they did nobody would notice.
 */
await check("the sentence lands in a node that was already there to announce it", async () => {
  server.reset()
  const ui = await opened(mount(named))
  const region = ui.menu.querySelector('[role="status"]')
  assert.ok(region, "there is nothing here that can announce a change")
  assert.equal(region.parentElement, ui.menu)
  // Rows are on screen, so the region is empty and costs no height.
  assert.equal(region.textContent, "")

  press(ui.rows()[1])
  await settle()
  assert.equal(
    ui.menu.querySelector('[role="status"]'),
    region,
    "the live region was replaced along with the rows, which is what made it silent"
  )
  assert.equal(region.firstElementChild, ui.note())
  assert.match(region.textContent, /Starting docs/)
  ui.destroy()
  server.reset()
})

/*
 * Focus follows the sentence when the sentence took the reader's row away.
 *
 * `showNote` mid-switch detaches whatever the keyboard was on, and a detached
 * element hands focus to `<body>` — so choosing an app from the keyboard
 * dropped the reader out of the editor at the exact moment something was
 * happening that they needed to be told about. It only moves focus when the
 * menu HELD focus: a reader who has gone back to the canvas is told by the live
 * region instead, and is not dragged back.
 */
await check("a switch that destroys the focused row hands focus to the explanation", async () => {
  server.reset()
  const ui = await opened(mount(named))
  const row = ui.rows()[1]
  row.focus()
  press(row)
  await settle()
  assert.equal(window.document.activeElement, ui.note(), "focus was dropped on the body")
  ui.destroy()
  server.reset()

  const elsewhere = await opened(mount(named))
  window.document.getElementById("app").setAttribute("tabindex", "-1")
  window.document.getElementById("app").focus()
  press(elsewhere.rows()[1])
  await settle()
  assert.equal(
    window.document.activeElement,
    window.document.getElementById("app"),
    "a reader looking at the canvas was dragged back into the menu"
  )
  elsewhere.destroy()
  server.reset()
})

// ── The stylesheet ─────────────────────────────────────────────────────────

console.log("\nThe rules jsdom cannot answer")

/*
 * jsdom has no cascade and no layout, so these are asserted against the text of
 * the sheet — which is where the facts live anyway. Each one is a rule whose
 * loss is invisible in structure and fatal on screen.
 */
await check("a long app name truncates rather than pushing the chevron off the row", () => {
  const nameRule = rule(named.appChooserCss, ".de-app-chooser-name")
  // A flex item's default `min-width: auto` refuses to shrink below its
  // content, so without this a long package name pushes the glyph out of the
  // panel — and the glyph is the only thing on the row that says it opens.
  assert.match(nameRule, /min-width: 0;/)
  assert.match(nameRule, /text-overflow: ellipsis;/)
  assert.match(nameRule, /white-space: nowrap;/)
  // The glyph never gives up its width to the name.
  assert.match(rule(named.appChooserCss, ".de-app-chooser svg"), /flex: none;/)
})

/*
 * And the same name in a ROW does the opposite, which is the point.
 *
 * The two boxes get two answers because they have different room. The trigger
 * is a 32px band with a chevron to fit and no choice; a row is inside a card up
 * to 340px wide with no height to run out of, so the whole name fits, on a
 * second line when it has to. Truncating in BOTH was the state this control
 * shipped in for a while, and it meant a reader looking at
 * `@acme/design-system-play…` had nowhere in the editor to find out which of
 * two checkouts they were about to open — which is the one question this list
 * exists to answer.
 */
await check("a long app name wraps in a row rather than losing its tail", () => {
  const nameRule = rule(named.appChooserCss, ".de-app-menu-name")
  assert.doesNotMatch(nameRule, /text-overflow: ellipsis;/, "the row started hiding the tail again")
  assert.doesNotMatch(nameRule, /white-space: nowrap;/)
  // The scoped package with no space in it, which would push past the card's
  // edge rather than wrap.
  assert.match(nameRule, /overflow-wrap: break-word;/)
  // And it is the item that gives, so the figure beside it keeps its place.
  assert.match(nameRule, /min-width: 0;/)
})

/*
 * THE RULE THAT REPLACED AN INLINE `min-height`.
 *
 * `panels/app-chooser.ts` used to measure the row before writing a progress
 * phrase into it and pin the measurement, because the phrase was landing in a
 * line that wrapped. These two declarations are what make that measurement
 * unnecessary: a slot that cannot grow and cannot wrap holds a port, three
 * words and a one-word phrase at the same height, so the row is the same height
 * in every state it has.
 *
 * Losing either one is invisible in jsdom and invisible on screen until a
 * handover, at which point the card resizes under a pointer that is waiting for
 * the page to be replaced — which is the whole failure the pin was bought to
 * prevent.
 */
await check("the trailing figure cannot wrap, so the row cannot change height mid-handover", () => {
  const slot = rule(named.appChooserCss, ".de-app-menu-where")
  assert.match(slot, /flex: none;/)
  assert.match(slot, /white-space: nowrap;/)
})

/*
 * The armed row's ink is the row's, not a second copy of the row's decision.
 *
 * The figure is quiet everywhere except on a danger fill, where it inherits —
 * so there is exactly one rule in this sheet deciding what is legible on that
 * fill, and it is the rule that sets the fill. A descendant rule naming
 * `onSemantic` a second time is the shape the palette has already shipped two
 * contrast bugs in: it stays true while the thing under it moves.
 */
await check("the figure takes the armed row's ink by inheriting it, not by restating it", () => {
  assert.doesNotMatch(
    named.appChooserCss,
    /\.de-app-menu-row--danger \.de-app-menu-where/,
    "the armed row's ink was copied onto the figure instead of inherited"
  )
  assert.match(
    named.appChooserCss,
    /\.de-app-menu-row:not\(\.de-app-menu-row--danger\) \.de-app-menu-where/
  )
})

/*
 * The card's ceiling, which is not this lane's work and is the thing a lane
 * rewriting every rule in the file is most likely to drop.
 *
 * Five registered editors at 200% zoom is taller than a short window — the
 * registry's own notes record five on the machine this was written on — and
 * before the ceiling existed the overflow simply hung off the bottom edge with
 * no scrollbar, putting the rows NEAREST the trigger out of reach.
 */
await check("the card still stops at the viewport and scrolls past it", () => {
  const menuRule = rule(named.appChooserCss, ".de-app-menu")
  // 16, and the number is pinned rather than matched loosely because it was
  // wrong: the sheet read `space["2xs"]` where the positioner reads 8, so the
  // ceiling was `100vh - 8px` and the card was allowed to be one edge taller
  // than the room it had. Off by an amount too small to see and exactly big
  // enough to hide the last row's lower half.
  assert.match(menuRule, /max-height: calc\(100vh - 16px\);/)
  assert.match(menuRule, /overflow-y: auto;/)
  // Without this the wheel gesture that reaches the end of the list carries on
  // into the page behind an open menu anchored to a control that just moved.
  assert.match(menuRule, /overscroll-behavior: contain;/)
})

await check("the menu is a fixed card that paints above the panel it drops out of", () => {
  const menuRule = rule(named.appChooserCss, ".de-app-menu")
  assert.match(menuRule, /position: fixed;/)
  const menuZ = Number(/z-index: (\d+);/.exec(menuRule)?.[1])
  // Read out of the shell rather than written down twice: the menu is mounted
  // in `document.body` precisely so it can clear `.de-root`, and a sheet that
  // lost this would leave it perfectly unclipped and perfectly invisible.
  const rootZ = Number(/z-index: (\d+);/.exec(rule(named.shellCss, ".de-root"))?.[1])
  assert.equal(rootZ, 2147483000, "the shell's own layer moved; this rule follows it")
  assert.ok(menuZ > rootZ, `the menu sits at ${menuZ}, under the panels at ${rootZ}`)
})

await check("the chooser's rules are actually in the sheet the shell serves", () => {
  assert.ok(named.shellCss.includes(named.appChooserCss), "appChooserCss is not in shellCss")
  // Directly after the tab strip it sits on top of: the two are the head of one
  // panel, and the trigger borrows the column the tabs start on.
  assert.ok(
    named.shellCss.indexOf(".de-tabs") < named.shellCss.indexOf(".de-app-chooser {"),
    "the chooser's rules were lifted ahead of the strip they sit above"
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
