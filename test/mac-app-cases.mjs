/**
 * "Open in Mac app": the banner at the foot of the left panel, and the request
 * it sends to DesignLayer.app's desk.
 *
 * The cases are chosen for the failures that stay quiet:
 *
 *  - **an offer that can only fail.** The banner drawn with no desk in the
 *    prelude, with a desk that is not on this machine, or inside the app
 *    itself — where it would send the page to the window it is already in;
 *  - **a request the browser would stop.** The body goes as text/plain so the
 *    cross-origin POST needs no preflight; a custom header or a JSON content
 *    type turns it into one, which fails in a real browser and passes every
 *    unit test that does not look at the shape;
 *  - **an answer read the wrong way round.** A toast that says the page opened
 *    when the desk refused it, or one that goes quiet when nothing answered.
 *
 * The desk's half — its routes, CORS and event stream, and the page that takes
 * the hand-off — is desktop/mac/test/desk-cases.mjs. Whether the prelude says
 * there is a desk is the launcher's half, and the last cases here.
 *
 * jsdom has no `location.ancestorOrigins` and its `window.name` is its own, so
 * the bundle reads `window` through a proxy that answers both from `frame`.
 * Each prologue is its own module graph for the reason `app-chooser-cases.mjs`
 * gives: `core/config.ts` reads the prelude once, at load.
 *
 * Usage: node test/mac-app-cases.mjs
 */

import assert from "node:assert/strict"
import vm from "node:vm"
import { JSDOM } from "jsdom"

import { browserPrelude, resolveConfig } from "../config.mjs"
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

const DESK = "http://127.0.0.1:3454"
/** The editor page the banner is pressed on, query and all. */
const PAGE = "http://127.0.0.1:3466/dashboard?tab=billing"

// ── The world the bundle loads into ────────────────────────────────────────

const dom = new JSDOM('<!doctype html><html><body><main id="app">Page</main></body></html>', {
  pretendToBeVisual: true,
  url: PAGE,
})
const { window } = dom
window.document.elementsFromPoint = () => []
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

/** The frame this page believes it is in. */
const frame = { name: "", ancestors: undefined }
const fakeLocation = {
  href: PAGE,
  origin: window.location.origin,
  protocol: window.location.protocol,
  host: window.location.host,
  hostname: window.location.hostname,
  port: window.location.port,
  pathname: window.location.pathname,
  search: window.location.search,
  hash: "",
  assign() {},
  replace() {},
  reload() {},
  toString: () => PAGE,
  get ancestorOrigins() {
    return frame.ancestors
  },
}
const proxyWindow = new Proxy(window, {
  get(target, property) {
    if (property === "location") return fakeLocation
    if (property === "name") return frame.name
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
  Object.defineProperty(globalThis, key, {
    value: key === "getComputedStyle" ? window.getComputedStyle.bind(window) : window[key],
    configurable: true,
    writable: true,
  })
}
Object.defineProperty(globalThis, "window", { value: proxyWindow, configurable: true, writable: true })

/**
 * The desk, as far as the page can see it. Every other request the panel makes
 * at boot gets an empty answer.
 */
const sent = []
let reply = () => ({ status: 200, body: { ok: true, id: 1, delivered: 1, launched: true } })
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  if (!url.startsWith(DESK)) return new Response("{}", { status: 200 })
  sent.push({ url, init })
  const answer = await reply(init)
  if (answer instanceof Error) throw answer
  return new Response(JSON.stringify(answer.body), { status: answer.status })
}

// ── One module graph per prologue ──────────────────────────────────────────

const { build } = await import("esbuild")

async function laneFor(prelude, marker) {
  globalThis.__DESIGNLAYER_CONFIG__ = prelude
  const lane = await build({
    stdin: {
      contents: `
        export const marker = ${JSON.stringify(marker)}
        export { createContext } from "./src/core/context"
        export { installLeftPanel } from "./src/panels/left"
        export { isInDesk, openInDesk, DESK_FRAME_PREFIX } from "./src/shell/desk"
        export { config } from "./src/core/config"
        export { shellCss } from "./src/core/css"
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

/** No prelude at all: a test, a bundle loaded by hand. */
const bare = await laneFor(undefined, "no-prelude")
/** A Mac with the app installed. */
const mac = await laneFor({ deskUrl: DESK }, "mac-with-app")
/** A prelude naming a desk somewhere else, which the reader must refuse. */
const offMachine = await laneFor({ deskUrl: "https://desk.example.com" }, "desk-off-machine")
/** The same desk spelled with a trailing slash and `localhost`. */
const spelled = await laneFor({ deskUrl: "http://localhost:3454/" }, "desk-spelled-loosely")

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}

const bridge = {
  elementInfo: () => null,
  send() {},
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

/** The real left panel, mounted fresh, with its own toast log. */
function mount(lane) {
  const toasts = []
  const left = slot()
  lane.installLeftPanel(
    lane.createContext(
      { ...bridge, toast: (message, kind) => toasts.push({ message, kind }) },
      { overlay: slot(), toolbar: slot(), left, right: slot() }
    )
  )
  return { left, toasts, banner: left.querySelector('[data-de-control="mac-app"]') }
}

const press = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ── Where the banner is drawn ──────────────────────────────────────────────

console.log("Where the banner is drawn")

await check("no desk in the prelude, no banner", () => {
  assert.equal(bare.config.deskUrl, null)
  assert.equal(mount(bare).banner, null)
})

await check("a desk that is not on this machine is refused, and draws nothing", () => {
  assert.equal(offMachine.config.deskUrl, null)
  assert.equal(mount(offMachine).banner, null)
})

await check("the desk is read as an origin, whatever trailing slash it arrives with", () => {
  assert.equal(mac.config.deskUrl, DESK)
  assert.equal(spelled.config.deskUrl, "http://localhost:3454")
})

await check("on a Mac with the app it is the last thing in the left panel, under every pane", () => {
  const { left, banner } = mount(mac)
  assert.ok(banner, "no banner")
  assert.equal(left.lastElementChild, banner)
  assert.equal(banner.closest('[role="tabpanel"]'), null, "the banner is inside a pane and scrolls with it")
  assert.ok(left.firstElementChild.classList.contains("de-app-chooser"), "the chooser no longer leads")
  assert.equal(banner.tagName, "BUTTON")
  assert.equal(banner.getAttribute("type"), "button")
})

await check("it names the action, and the line under it is the description", () => {
  const { banner } = mount(mac)
  assert.equal(banner.getAttribute("aria-label"), "Open in Mac app")
  assert.equal(banner.querySelector(".de-mac-banner-title").textContent, "Open in Mac app")
  const note = window.document.getElementById(banner.getAttribute("aria-describedby"))
  assert.ok(note && banner.contains(note), "aria-describedby names nothing inside the banner")
  assert.equal(note.textContent, "One window for all your apps")
  assert.ok(banner.querySelector("svg"), "the banner lost its glyph")
})

await check("inside the app it is not drawn: a frame the desk named", () => {
  frame.name = `${mac.DESK_FRAME_PREFIX}t1`
  try {
    assert.equal(mount(mac).banner, null)
  } finally {
    frame.name = ""
  }
})

await check("inside the app it is not drawn: a frame the desk made before it named them", () => {
  frame.ancestors = { length: 1, 0: DESK, contains: (origin) => origin === DESK }
  try {
    assert.equal(mount(mac).banner, null)
    // Another page framing the editor is not the app.
    frame.ancestors = { length: 1, 0: "http://127.0.0.1:9000", contains: (origin) => origin === "http://127.0.0.1:9000" }
    assert.ok(mount(mac).banner)
  } finally {
    frame.ancestors = undefined
  }
})

// ── What it sends, and what it says back ───────────────────────────────────

console.log("\nThe hand-off")

await check("a press posts this page to the desk as a simple request", async () => {
  sent.length = 0
  const { banner } = mount(mac)
  press(banner)
  await settle()
  assert.equal(sent.length, 1)
  const [{ url, init }] = sent
  assert.equal(url, `${DESK}/api/open`)
  assert.equal(init.method, "POST")
  // A string body with no headers goes as text/plain, which is what keeps a
  // real browser from sending a preflight first.
  assert.equal(typeof init.body, "string")
  assert.equal(init.headers, undefined, "a header on this request turns it into a preflighted one")
  assert.notEqual(init.credentials, "include")
  assert.deepEqual(JSON.parse(init.body), { url: PAGE })
})

await check("a second press while the first is in flight sends nothing", async () => {
  sent.length = 0
  let release
  reply = () => new Promise((resolve) => {
    release = () => resolve({ status: 200, body: { ok: true, delivered: 1 } })
  })
  try {
    const { banner } = mount(mac)
    press(banner)
    press(banner)
    await settle()
    assert.equal(sent.length, 1)
    release()
    await settle()
    press(banner)
    await settle()
    assert.equal(sent.length, 2, "the banner stayed busy after its answer")
    release()
    await settle()
  } finally {
    reply = () => ({ status: 200, body: { ok: true, delivered: 1 } })
  }
})

await check("a window that took the page says so, and that this tab can go", async () => {
  const { banner, toasts } = mount(mac)
  press(banner)
  await settle()
  assert.deepEqual(toasts.at(-1), { message: "Opened in the Mac app. You can close this tab.", kind: "info" })
})

await check("an app that is still starting is told apart from one that took the page", async () => {
  reply = () => ({ status: 200, body: { ok: true, delivered: 0, launched: true } })
  try {
    const { banner, toasts } = mount(mac)
    press(banner)
    await settle()
    assert.equal(toasts.at(-1).kind, "info")
    assert.match(toasts.at(-1).message, /^Opening the Mac app…/)
  } finally {
    reply = () => ({ status: 200, body: { ok: true, delivered: 1 } })
  }
})

await check("a refusal is an error that carries the desk's own sentence", async () => {
  reply = () => ({ status: 400, body: { error: "Only pages on this Mac (127.0.0.1 or localhost) can open in the Mac app" } })
  try {
    const { banner, toasts } = mount(mac)
    press(banner)
    await settle()
    assert.deepEqual(toasts.at(-1), {
      message: "The Mac app could not open this page. Only pages on this Mac (127.0.0.1 or localhost) can open in the Mac app.",
      kind: "error",
    })
  } finally {
    reply = () => ({ status: 200, body: { ok: true, delivered: 1 } })
  }
})

await check("nothing answering is an error that says how to start the desk", async () => {
  reply = () => new TypeError("Failed to fetch")
  try {
    const { banner, toasts } = mount(mac)
    press(banner)
    await settle()
    assert.equal(toasts.at(-1).kind, "error")
    assert.match(toasts.at(-1).message, /^Could not reach the Mac app\./)
    assert.match(toasts.at(-1).message, /node desktop\/mac\/install\.mjs --start/)
  } finally {
    reply = () => ({ status: 200, body: { ok: true, delivered: 1 } })
  }
})

await check("a desk that takes the connection and never answers times out as unreachable", async () => {
  reply = (init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })
  try {
    assert.deepEqual(await mac.openInDesk(PAGE, 20), { ok: false, reason: "unreachable" })
  } finally {
    reply = () => ({ status: 200, body: { ok: true, delivered: 1 } })
  }
})

// ── What the stylesheet has to hold ────────────────────────────────────────

console.log("\nThe stylesheet")

/*
 * jsdom has no layout, so the two claims that are about the cascade — the
 * banner keeps its height while the pane above it scrolls, and its focus ring
 * is drawn inside a box that is flush with the panel edge — are asserted
 * against the stylesheet text, where they live.
 */
await check("the banner keeps its own height and draws its focus ring inside", () => {
  const rule = (selector) => {
    const start = mac.shellCss.indexOf(`${selector} {`)
    assert.ok(start >= 0, `no rule for ${selector}`)
    return mac.shellCss.slice(start, mac.shellCss.indexOf("}", start))
  }
  assert.match(rule(".de-mac-banner"), /flex: none;/)
  assert.match(rule(".de-mac-banner"), /border-top: 1px solid/)
  assert.match(rule(".de-mac-banner:focus-visible"), /box-shadow: inset 0 0 0 1px/)
  // Registered beside the chooser it mirrors.
  assert.ok(mac.shellCss.indexOf(".de-mac-banner {") > mac.shellCss.indexOf(".de-app-chooser {"))
})

// ── The launcher's half ────────────────────────────────────────────────────

console.log("\nThe prelude")

await check("the prelude carries the desk through, and null when there is none", () => {
  const host = resolveConfig({}, { cwd: PACKAGE_DIR })
  const payload = (runtime) => {
    const sandbox = { window: {} }
    vm.runInNewContext(browserPrelude(host, runtime), sandbox)
    return sandbox.window.__DESIGNLAYER_CONFIG__
  }
  assert.equal(payload({ proxyPort: 4567 }).deskUrl, null)
  assert.equal(payload({ proxyPort: 4567, deskUrl: DESK }).deskUrl, DESK)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
