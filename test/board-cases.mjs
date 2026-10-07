/**
 * Canvas view: the board of pages, its camera, and the ways in and out of it.
 *
 * Three layers, pinned separately because they fail differently. The camera
 * and the layout are pure math, and a wrong sign there does not throw — the
 * board just zooms about the wrong point, or fits a page off-screen — so their
 * rules are asserted as numbers. The page list and the navigation strategy
 * take injected fetch/window stubs, so their orderings can be pinned without a
 * server or a router. The board itself is mounted over jsdom and driven with
 * real events and commands, both through the fallback path (no View
 * Transitions API, which jsdom lacks) and through a fake
 * `document.startViewTransition` that runs the update and resolves.
 *
 * jsdom performs no layout, so the canvas is declared: the window is 1200x800
 * and the panels hold 240px and 260px, which leaves a 700x800 canvas rect.
 *
 * Usage: node designlayer/test/board-cases.mjs
 */

import assert from "node:assert/strict"
import { JSDOM, VirtualConsole } from "jsdom"

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const near = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon

// jsdom reports unimplemented APIs (scrollTo, navigation) through the virtual
// console; they are expected here and would only bury the results.
const virtualConsole = new VirtualConsole()
virtualConsole.on("jsdomError", () => {})

const dom = new JSDOM(
  `<!doctype html><html><body>
    <main id="app">
      <a href="/about">About</a>
      <a href="/pricing/">Pricing</a>
      <a href="/blog?page=2#top">Blog</a>
      <a href="/posts/42">A post</a>
      <a href="https://example.com/away">Away</a>
      <a href="/brochure.pdf">Brochure</a>
      <a href="/new-tab" target="_blank">New tab</a>
      <a href="/export" download>Export</a>
    </main>
    <div data-designlayer><a href="/chrome-only">Chrome</a></div>
  </body></html>`,
  { pretendToBeVisual: true, url: "http://localhost/", virtualConsole }
)
const { window } = dom
Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true, writable: true })
Object.defineProperty(window, "innerHeight", { value: 800, configurable: true, writable: true })
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
}
globalThis.DOMMatrixReadOnly = class {
  constructor() {
    this.m41 = 0
    this.m42 = 0
  }
}
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "SVGElement",
  "SVGSVGElement",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "WheelEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  // The board watches its own style attribute for writes it did not make.
  "MutationObserver",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
// The panels' widths, written where `appInsets()` reads them.
window.document.documentElement.style.setProperty("--de-left", "240px")
window.document.documentElement.style.setProperty("--de-right", "260px")

/** One bundle, because the store and the command registry are singletons. */
const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export * as camera from "./src/board/camera"
      export * as layout from "./src/board/layout"
      export * as pages from "./src/board/pages"
      export * as appRoutes from "./src/board/app-routes"
      export * as navigate from "./src/board/navigate"
      export * as frames from "./src/board/frames"
      export { installBoard, staleLauncherMessage } from "./src/board/index"
      export { boardCss, boardEnterCss, boardExitCss, boardTrustedVtCss } from "./src/core/css/board"
      export { createContext } from "./src/core/context"
      export { getState, setState, editorOwnsInput } from "./src/core/store"
      export { hasCommand, runCommand } from "./src/core/commands"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const editor = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)
const { camera: cam, layout, pages, navigate, frames, appRoutes } = editor

// ── Camera ────────────────────────────────────────────────────────────────

console.log("camera")

await check("fit centers the content with padding and never magnifies", () => {
  const board = { width: 1000, height: 800 }
  const small = cam.fit(board, { x: 0, y: 0, width: 200, height: 100 })
  assert.equal(small.scale, 1, "a small board is shown at 100%, not blown up")
  assert.equal(small.x, 400)
  assert.equal(small.y, 350)
  const big = cam.fit(board, { x: 0, y: 0, width: 4000, height: 2000 })
  assert.ok(near(big.scale, (1000 * (1 - 2 * cam.FIT_PADDING)) / 4000), "width-bound fit")
  const centerX = big.x + 2000 * big.scale
  const centerY = big.y + 1000 * big.scale
  assert.ok(near(centerX, 500) && near(centerY, 400), "content center lands on the board center")
})

await check("fit clamps to the minimum scale for huge content", () => {
  const huge = cam.fit({ width: 100, height: 100 }, { x: 0, y: 0, width: 1e6, height: 1e6 })
  assert.equal(huge.scale, cam.MIN_SCALE)
})

await check("focus makes a frame exactly cover the board at 100%", () => {
  const frame = { x: 1500, y: 900, width: 700, height: 800 }
  const view = cam.focus(frame)
  assert.deepEqual(view, { x: -1500, y: -900, scale: 1 })
  const screen = cam.rectToScreen(view, frame)
  assert.deepEqual(screen, { x: 0, y: 0, width: 700, height: 800 })
})

await check("zoomAt keeps the world point under the pointer fixed", () => {
  const start = { x: 37, y: -12, scale: 0.3 }
  const point = { x: 410, y: 260 }
  const before = cam.screenToWorld(start, point)
  const after = cam.zoomAt(start, 2.5, point)
  const again = cam.screenToWorld(after, point)
  assert.ok(near(before.x, again.x) && near(before.y, again.y))
  assert.ok(near(after.scale, 0.75))
})

await check("zoomAt clamps scale to [0.05, 4] and still holds the point", () => {
  const point = { x: 100, y: 100 }
  const up = cam.zoomAt({ x: 0, y: 0, scale: 3 }, 10, point)
  assert.equal(up.scale, cam.MAX_SCALE)
  const down = cam.zoomAt({ x: 0, y: 0, scale: 0.1 }, 0.001, point)
  assert.equal(down.scale, cam.MIN_SCALE)
  const world = cam.screenToWorld({ x: 0, y: 0, scale: 3 }, point)
  const held = cam.screenToWorld(up, point)
  assert.ok(near(world.x, held.x) && near(world.y, held.y))
})

await check("toCss is translate3d then scale", () => {
  assert.equal(cam.toCss({ x: 12, y: -4, scale: 0.5 }), "translate3d(12px, -4px, 0) scale(0.5)")
})

await check("interpolate moves scale in log space and hits both ends", () => {
  const a = { x: 0, y: 0, scale: 0.1 }
  const b = { x: -500, y: -300, scale: 1 }
  const mid = cam.interpolate(a, b, 0.5)
  assert.ok(near(mid.scale, Math.sqrt(0.1 * 1)), `mid scale ${mid.scale}`)
  const end = cam.interpolate(a, b, 1)
  assert.ok(near(end.x, -500) && near(end.y, -300) && near(end.scale, 1))
  const begin = cam.interpolate(a, b, 0)
  assert.ok(near(begin.x, 0) && near(begin.y, 0) && near(begin.scale, 0.1))
  const panOnly = cam.interpolate({ x: 0, y: 0, scale: 1 }, { x: 100, y: 50, scale: 1 }, 0.25)
  assert.deepEqual(panOnly, { x: 25, y: 12.5, scale: 1 })
  assert.equal(cam.lerp(2, 4, 0.5), 3)
})

await check("interpolate is a zoom about one fixed point (no sideways swing)", () => {
  const a = { x: 10, y: 20, scale: 0.2 }
  const b = { x: -300, y: -100, scale: 1.5 }
  const px = (a.x * b.scale - b.x * a.scale) / (b.scale - a.scale)
  const py = (a.y * b.scale - b.y * a.scale) / (b.scale - a.scale)
  const w0 = cam.screenToWorld(a, { x: px, y: py })
  for (const t of [0.2, 0.5, 0.8]) {
    const w = cam.screenToWorld(cam.interpolate(a, b, t), { x: px, y: py })
    assert.ok(near(w.x, w0.x, 1e-6) && near(w.y, w0.y, 1e-6))
  }
})

await check("the easing matches cubic-bezier(0.22, 1, 0.36, 1) at its ends and is monotonic", () => {
  assert.equal(cam.boardEase(0), 0)
  assert.equal(cam.boardEase(1), 1)
  let last = 0
  for (let i = 1; i <= 20; i += 1) {
    const value = cam.boardEase(i / 20)
    assert.ok(value >= last - 1e-9)
    last = value
  }
  assert.ok(cam.boardEase(0.5) > 0.85, "fast out: most of the way there by halfway")
})

// ── Layout ────────────────────────────────────────────────────────────────

console.log("layout")

const overlaps = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

await check("frames never overlap and are all the canvas size", () => {
  const frame = { width: 700, height: 800 }
  for (const count of [1, 2, 3, 5, 8, 12, 16]) {
    const result = layout.layoutFrames(count, frame)
    assert.equal(result.frames.length, count)
    for (let i = 0; i < count; i += 1) {
      assert.equal(result.frames[i].width, 700)
      assert.equal(result.frames[i].height, 800)
      for (let j = i + 1; j < count; j += 1) {
        assert.ok(!overlaps(result.frames[i], result.frames[j]), `${count}: ${i} overlaps ${j}`)
      }
    }
  }
})

await check("the first frame (the current page) sits top-left", () => {
  const result = layout.layoutFrames(9, { width: 1000, height: 600 })
  assert.deepEqual({ x: result.frames[0].x, y: result.frames[0].y }, { x: 0, y: 0 })
})

await check("columns follow the canvas aspect", () => {
  // Frames already carry the canvas aspect, so the board lands near it at any size.
  for (const frame of [{ width: 1600, height: 900 }, { width: 400, height: 900 }, { width: 700, height: 800 }]) {
    const result = layout.layoutFrames(16, frame)
    const aspect = result.bounds.width / result.bounds.height
    assert.ok(Math.abs(Math.log(aspect / (frame.width / frame.height))) < 0.35, `board aspect ${aspect}`)
  }
  // And the column count is what moves when the target aspect does.
  const frame = { width: 700, height: 800 }
  const wide = layout.layoutFrames(12, frame, { width: 2400, height: 800 })
  const tall = layout.layoutFrames(12, frame, { width: 700, height: 2400 })
  assert.ok(wide.columns > tall.columns, `wide ${wide.columns} vs tall ${tall.columns}`)
  assert.equal(layout.layoutFrames(2, frame, { width: 1600, height: 800 }).columns, 2)
})

await check("gaps: ~8% column gap, row gap at least max(12%, 140px)", () => {
  const result = layout.layoutFrames(4, { width: 1000, height: 600 })
  assert.equal(result.gapX, 80)
  assert.equal(result.gapY, 140)
  const tall = layout.layoutFrames(4, { width: 1000, height: 2000 })
  assert.equal(tall.gapY, 240)
})

// ── Pages ─────────────────────────────────────────────────────────────────

console.log("pages")

const apiResponse = (routes) => async (url) => {
  apiResponse.last = url
  return { ok: true, json: async () => ({ framework: "next", routes }) }
}

await check("normalizePath drops hash, search and trailing slashes", () => {
  assert.equal(pages.normalizePath("/pricing/"), "/pricing")
  assert.equal(pages.normalizePath("/blog?x=1#top"), "/blog")
  assert.equal(pages.normalizePath("/"), "/")
  assert.equal(pages.normalizePath("//a//b/"), "/a/b")
})

await check("links: same-origin pages only, chrome and files and new tabs skipped", () => {
  const links = pages.collectLinkPaths(window.document, "http://localhost")
  assert.deepEqual(links, ["/about", "/pricing", "/blog", "/posts/42"])
})

await check("merge: current first, API routes, then links; dynamic only through a concrete link", async () => {
  const list = await pages.loadPages({
    apiBase: "/__designlayer",
    doc: window.document,
    location: { origin: "http://localhost", pathname: "/pricing/" },
    fetch: apiResponse([
      { path: "/", file: "app/page.tsx", dynamic: false },
      { path: "/settings", file: "app/settings/page.tsx", dynamic: false },
      { path: "/posts/[id]", file: "app/posts/[id]/page.tsx", dynamic: true },
      { path: "/users/:id", file: "src/users.tsx" },
    ]),
  })
  assert.equal(apiResponse.last, "/__designlayer/pages")
  assert.deepEqual(
    list.map((page) => page.path),
    ["/pricing", "/", "/settings", "/about", "/blog", "/posts/42"]
  )
  assert.equal(list[1].file, "app/page.tsx")
  assert.equal(list.find((page) => page.path === "/posts/42").file, "app/posts/[id]/page.tsx")
  assert.ok(!list.some((page) => pages.isDynamicPattern(page.path)), "no pattern survives")
})

await check("merge caps the list at 16", () => {
  const routes = Array.from({ length: 30 }, (_, i) => ({ path: `/p${i}` }))
  const list = pages.mergePages({ routes, links: [], current: "/" })
  assert.equal(list.length, 16)
  assert.equal(list[0].path, "/")
})

await check("an API failure (404, throw, bad body) leaves the links", async () => {
  const base = { apiBase: "/x", doc: window.document, location: { origin: "http://localhost", pathname: "/" } }
  const notFound = await pages.loadPages({ ...base, fetch: async () => ({ ok: false, json: async () => ({}) }) })
  const thrown = await pages.loadPages({
    ...base,
    fetch: async () => {
      throw new Error("offline")
    },
  })
  const junk = await pages.loadPages({ ...base, fetch: async () => ({ ok: true, json: async () => ({ nope: 1 }) }) })
  for (const list of [notFound, thrown, junk]) {
    assert.deepEqual(
      list.map((page) => page.path),
      ["/", "/about", "/pricing", "/blog", "/posts/42"]
    )
  }
})

/*
 * A hash router serves every page from one document and tells them apart by
 * the fragment. Keyed by pathname, every page of such an app was `/`: the board
 * showed one frame, loaded bare `/`, and so showed the app's default route
 * instead of the page it was opened from.
 */
await check("normalizeRoute keeps a hash router's route and drops an anchor", () => {
  assert.equal(pages.normalizeRoute("/#/pricing/"), "/#/pricing")
  assert.equal(pages.normalizeRoute("/#/pricing?tab=2"), "/#/pricing")
  assert.equal(pages.normalizeRoute("/#!/pricing"), "/#!/pricing")
  assert.equal(pages.normalizeRoute("/#/"), "/#/")
  assert.equal(pages.normalizeRoute("/about#top"), "/about")
  assert.equal(pages.normalizeRoute("/about/?x=1#"), "/about")
  assert.equal(pages.normalizeRoute("/pricing/"), "/pricing")
  // The document part of a hash route is an address, so a subdirectory keeps its slash.
  assert.equal(pages.normalizeRoute("/asset/abc/?v=1#/a//b/"), "/asset/abc/#/a/b")
  assert.equal(pages.routeOf({ pathname: "/", hash: "#/billing" }), "/#/billing")
  assert.equal(pages.routeOf({ pathname: "/billing/", hash: "" }), "/billing")
  assert.equal(pages.routeOf({ pathname: "/billing" }), "/billing")
  assert.equal(pages.hashBase("/#/x"), "/#")
  assert.equal(pages.hashBase("/#!/x"), "/#!")
  assert.equal(pages.hashBase("/x"), null)
  assert.equal(pages.hashBase("/x#top"), null)
})

await check("a hash-routed app: current route, routes behind the hash, hash links; anchors and the bare document dropped", async () => {
  const hashDoc = new JSDOM(
    `<!doctype html><body><nav>
      <a href="#/billing">Billing</a>
      <a href="#/projects/7">A project</a>
      <a href="#">Menu</a>
      <a href="#main">Skip</a>
      <a href="/">Logo</a>
      <a href="/desktop">Desktop build</a>
    </nav></body>`,
    { url: "http://localhost/#/home", virtualConsole }
  ).window.document
  assert.deepEqual(pages.collectLinkPaths(hashDoc, "http://localhost"), [
    "/#/billing",
    "/#/projects/7",
    "/",
    "/desktop",
  ])
  const list = await pages.loadPages({
    apiBase: "/__designlayer",
    doc: hashDoc,
    location: { origin: "http://localhost", pathname: "/", hash: "#/home" },
    fetch: apiResponse([
      { path: "/", file: "src/App.tsx" },
      { path: "/settings", file: "src/App.tsx" },
      { path: "/projects/:id", file: "src/Project.tsx", dynamic: true },
    ]),
    visited: ["/#/inbox", "/", "/#/home"],
  })
  // Nothing here is nearer `/#/home` than anything else, so visits lead.
  assert.deepEqual(list.map((page) => page.path), [
    "/#/home",
    "/#/inbox",
    "/#/",
    "/#/settings",
    "/#/billing",
    "/#/projects/7",
    "/desktop",
  ])
  assert.equal(list.find((page) => page.path === "/#/projects/7").file, "src/Project.tsx")
  assert.equal(list.find((page) => page.path === "/#/settings").file, "src/App.tsx")
})

await check("before the app has routed, its hash links say it is hash-routed", async () => {
  const hashDoc = new JSDOM(`<!doctype html><body><a href="#/billing">Billing</a></body>`, {
    url: "http://localhost/",
    virtualConsole,
  }).window.document
  const list = await pages.loadPages({
    apiBase: "/x",
    doc: hashDoc,
    location: { origin: "http://localhost", pathname: "/", hash: "" },
    fetch: apiResponse([{ path: "/settings" }]),
  })
  assert.deepEqual(list.map((page) => page.path), ["/", "/#/settings", "/#/billing"])
})

await check("visits: most recent first, no repeats, capped at the board's size, never throwing", () => {
  const data = new Map()
  const store = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
  pages.rememberVisit("/#/a/", store)
  pages.rememberVisit("/#/b", store)
  pages.rememberVisit("/#/a?x=1", store)
  assert.deepEqual(pages.readVisited(store), ["/#/a", "/#/b"])
  for (let i = 0; i < 30; i += 1) pages.rememberVisit(`/p${i}`, store)
  assert.equal(pages.readVisited(store).length, pages.MAX_PAGES)
  assert.equal(pages.readVisited(store)[0], "/p29")
  data.set("designlayer:board-visited", "{not json")
  assert.deepEqual(pages.readVisited(store), [])
  assert.deepEqual(pages.readVisited(null), [])
  pages.rememberVisit("/x", { getItem: () => null, setItem: () => { throw new Error("quota") } })
  // At equal nearness a visit leads, then the router's routes, then links.
  const merged = pages.mergePages({ routes: [{ path: "/r" }], links: ["/l"], current: "/", visited: ["/v", "/r"] })
  assert.deepEqual(merged.map((page) => page.path), ["/", "/v", "/r", "/l"])
})

/*
 * A real app's table runs to hundreds of routes, and the board shows sixteen.
 * In declaration order those were the first product's pages; the ones beside
 * the page the designer is on are the ones worth comparing, so they lead.
 */
await check("nearness: shared leading route segments, in either kind of route", () => {
  assert.equal(pages.nearness("/dashboard/orders", "/dashboard/invoices"), 1)
  assert.equal(pages.nearness("/#/web/billing/orders", "/#/web/billing/invoices"), 2)
  assert.equal(pages.nearness("/#/web/billing", "/#/web/billing/invoices"), 2)
  assert.equal(pages.nearness("/pricing", "/dashboard/invoices"), 0)
  assert.equal(pages.nearness("/#/dashboard", "/dashboard"), 0, "a hash route and a path are different documents")
})

await check("merge ranks pages nearest the current one first, then in declaration order, within the cap", () => {
  const product = (prefix) => ["", "/chat", "/inbox", "/library"].map((path) => ({ path: `${prefix}${path}` }))
  const studio = ["", "/overview", "/orders", "/invoices", "/customers", "/products", "/webhooks"]
  const routes = [
    ...product("/desktop"),
    ...product("/mobile"),
    ...product("/web"),
    ...studio.map((path) => ({ path: `/web/billing${path}` })),
    ...studio.map((path) => ({ path: `/mobile/billing${path}` })),
  ]
  const list = pages.mergePages({ routes, links: [], current: "/web/billing/invoices" })
  assert.equal(list.length, 16)
  assert.deepEqual(list.slice(0, 7).map((page) => page.path), [
    "/web/billing/invoices",
    "/web/billing",
    "/web/billing/overview",
    "/web/billing/orders",
    "/web/billing/customers",
    "/web/billing/products",
    "/web/billing/webhooks",
  ])
  // Then the same product's other pages, then the rest in the order declared.
  assert.deepEqual(list.slice(7, 11).map((page) => page.path), ["/web", "/web/chat", "/web/inbox", "/web/library"])
  assert.deepEqual(list.slice(11).map((page) => page.path), [
    "/desktop",
    "/desktop/chat",
    "/desktop/inbox",
    "/desktop/library",
    "/mobile",
  ])
})

// ── The app's own route table ─────────────────────────────────────────────

console.log("app routes")

/*
 * React elements and fibers, built by hand in the shapes React 19 and React
 * Router 6 leave them: the reader never imports either, so it is pinned
 * against the shapes alone.
 */
const ELEMENT = Symbol.for("react.transitional.element")
const h = (type, props = {}, ...children) => ({
  $$typeof: ELEMENT,
  type,
  props: children.length ? { ...props, children: children.length === 1 ? children[0] : children } : props,
})
function fiber(type, props, ...kids) {
  const node = { type, memoizedProps: props, stateNode: null, child: null, sibling: null, return: null }
  let previous = null
  for (const kid of kids) {
    kid.return = node
    if (previous) previous.sibling = kid
    else node.child = kid
    previous = kid
  }
  return node
}
/** A document whose `#root` is a React root holding `tree`, the way `createRoot` marks it. */
function reactDoc(tree, { url = "http://localhost/" } = {}) {
  const doc = new JSDOM(`<!doctype html><body><div id="root"></div></body>`, { url, virtualConsole }).window.document
  const live = fiber(null, null, tree)
  // The container keeps the host root it was made with; the root node knows the live one.
  doc.getElementById("root")["__reactContainer$test"] = { stateNode: { current: live } }
  return doc
}
const named = (name) => Object.defineProperty(function () {}, "name", { value: name })
const Routes = named("Routes")
const Route = named("Route")
const Navigate = named("Navigate")
const DashboardRedirect = named("DashboardRedirect")
const Page = named("Page")
const Layout = named("Layout")
const navigation = (child, basename = "/") => fiber(named("Router"), { value: { basename, navigator: {} } }, child)

const dashboardTable = () =>
  h(
    Routes,
    {},
    h(Route, { path: "/", element: h(Page) }),
    h(Route, { path: "/dashboard", element: h(Page) }),
    h(Route, { path: "/dashboard/orders", element: h(Page) }),
    h(Route, { path: "/dashboard/:id", element: h(Page) })
  )
const appTable = () => [
  h(Route, { path: "/", element: h(Navigate, { to: "/app/dashboard" }) }),
  h(Route, { path: "app", element: h(DashboardRedirect) }),
  // The table under `app/*` is written into the element, the way `element={AppRoutes()}` leaves it.
  h(Route, { path: "app/*", element: dashboardTable() }),
  h(Route, { path: "settings", element: h(Layout) }, h(Route, { index: true, element: h(Page) }), h(Route, { path: "team", element: h(Page) })),
  h(Route, { path: "*", element: h(Page) }),
]

await check("reads a <Routes> table: nested, index and descendant routes; redirects, mounts and catch-alls left out", () => {
  const doc = reactDoc(navigation(fiber(Routes, { children: appTable() })))
  const routes = appRoutes.readAppRoutes(doc)
  assert.deepEqual(routes.map((route) => route.path), [
    "/app/dashboard",
    "/app/dashboard/orders",
    "/app/dashboard/:id",
    "/settings",
    "/settings/team",
  ])
  assert.deepEqual(routes.filter((route) => route.dynamic).map((route) => route.path), ["/app/dashboard/:id"])
})

await check("a minified build is read by shape; a look-alike with readable names is not a router", () => {
  const MinRoutes = named("e")
  const MinRoute = named("t")
  const table = [h(MinRoute, { path: "/", element: h(Page) }), h(MinRoute, { path: "pricing", element: h(Page) })]
  assert.deepEqual(appRoutes.readAppRoutes(reactDoc(fiber(MinRoutes, { children: table }))).map((r) => r.path), ["/", "/pricing"])
  const Crumbs = named("Crumbs")
  const Crumb = named("Crumb")
  const crumbs = [h(Crumb, { path: "/a" }), h(Crumb, { path: "/a/b" })]
  assert.deepEqual(appRoutes.readAppRoutes(reactDoc(fiber(Crumbs, { children: crumbs }))), [])
})

await check("a data router's route objects, under its basename", () => {
  const router = {
    basename: "/base",
    routes: [
      {
        path: "/",
        element: h(Layout),
        children: [
          { index: true, element: h(Page) },
          { path: "reports", element: h(Page) },
          { path: "old", element: h(Navigate, { to: "/base/reports" }) },
        ],
      },
    ],
  }
  const doc = reactDoc(fiber(named("RouterProvider"), { router }))
  assert.deepEqual(appRoutes.readAppRoutes(doc).map((route) => route.path), ["/base", "/base/reports"])
})

await check("a table rendered inside a matched route hangs off where that route matched", () => {
  const cart = [h(Route, { path: "cart", element: h(Page) }), h(Route, { path: "/orders", element: h(Page) })]
  const matched = fiber(named("RouteContext"), { value: { matches: [{ pathnameBase: "/" }, { pathnameBase: "/shop" }] } }, fiber(Routes, { children: cart }))
  const doc = reactDoc(navigation(matched, "/app"))
  assert.deepEqual(appRoutes.readAppRoutes(doc).map((route) => route.path), ["/app/shop/cart", "/app/shop/orders"])
})

await check("no React, the editor's own roots, and junk all read as no routes", () => {
  const plain = new JSDOM(`<!doctype html><body><div id="root"></div></body>`, { virtualConsole }).window.document
  assert.deepEqual(appRoutes.readAppRoutes(plain), [])
  const chrome = reactDoc(fiber(Routes, { children: appTable() }))
  chrome.getElementById("root").setAttribute("data-designlayer", "")
  assert.deepEqual(appRoutes.readAppRoutes(chrome), [])
  const junk = reactDoc(fiber(Routes, { children: [null, false, "text", h(Route, { path: 7 })] }))
  assert.deepEqual(appRoutes.readAppRoutes(junk), [])
})

await check("loadPages puts the running app's routes on the board, behind the hash, nearest first", async () => {
  const table = [
    h(Route, { path: "/", element: h(Navigate, { to: "/web/billing/overview" }) }),
    h(Route, { path: "web/*", element: h(Routes, {}, h(Route, { path: "/chat", element: h(Page) }), h(Route, { path: "/billing", element: h(Page) }), h(Route, { path: "/billing/overview", element: h(Page) }), h(Route, { path: "/billing/orders", element: h(Page) }), h(Route, { path: "/billing/invoices", element: h(Page) }), h(Route, { path: "/billing/customers", element: h(Page) })) }),
  ]
  const doc = reactDoc(navigation(fiber(Routes, { children: table })), { url: "http://localhost/#/web/billing/invoices" })
  const list = await pages.loadPages({
    apiBase: "/x",
    doc,
    location: { origin: "http://localhost", pathname: "/", hash: "#/web/billing/invoices" },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  })
  assert.deepEqual(list.map((page) => page.path), [
    "/#/web/billing/invoices",
    "/#/web/billing",
    "/#/web/billing/overview",
    "/#/web/billing/orders",
    "/#/web/billing/customers",
    "/#/web/chat",
  ])
})

// ── Navigation strategy ───────────────────────────────────────────────────

console.log("navigate")

/*
 * A fake live window. `routes` is what the app renders per path; a router that
 * "hears" popstate re-renders from `location.pathname`, one that does not
 * leaves the page as it was — which is the difference navigateLive has to see.
 */
function navWindow({ router, routerNavigates = true, hearsPopstate = true, history = true } = {}) {
  const nav = new JSDOM(
    `<!doctype html><body><main id="app">Home page</main><div data-designlayer>Editor chrome text</div></body>`,
    { url: "http://localhost/", virtualConsole }
  )
  const log = []
  const location = {
    pathname: "/",
    origin: "http://localhost",
    assign(url) {
      log.push(`assign:${url}`)
    },
  }
  const doc = nav.window.document
  const render = () => {
    doc.getElementById("app").textContent = location.pathname === "/about" ? "About page" : "Home page"
  }
  const win = {
    location,
    document: doc,
    PopStateEvent: nav.window.PopStateEvent,
    scrollTo(x, y) {
      log.push(`scroll:${x},${y}`)
    },
    dispatchEvent(event) {
      log.push(`dispatch:${event.type}`)
      if (event.type === "popstate" && hearsPopstate) render()
      return true
    },
  }
  if (history) {
    win.history = {
      pushState(_state, _unused, url) {
        log.push(`pushState:${url}`)
        location.pathname = url
      },
    }
  }
  if (router) {
    win.next = {
      router: {
        push(path) {
          log.push(`push:${path}`)
          if (routerNavigates) {
            location.pathname = path
            render()
          }
          return Promise.resolve(true)
        },
      },
    }
  }
  let clock = 0
  const env = {
    window: win,
    frame: async () => {
      clock += 100
      log.push("frame")
    },
    now: () => clock,
  }
  return { env, log, doc }
}

await check("Next's router is tried first, then the page scrolls to the top", async () => {
  const { env, log } = navWindow({ router: true })
  const strategy = await navigate.navigateLive("/about", env)
  assert.equal(strategy, "router")
  assert.equal(log[0], "push:/about")
  assert.ok(!log.some((entry) => entry.startsWith("pushState")), "no popstate once the router worked")
  assert.ok(log.includes("scroll:0,0"))
  assert.equal(log.filter((entry) => entry === "frame").length, 2, "two frames after arriving")
})

await check("a router that never arrives goes straight to location.assign", async () => {
  const { env, log } = navWindow({ router: true, routerNavigates: false })
  assert.equal(await navigate.navigateLive("/about", env), "assign")
  assert.equal(log.at(-1), "assign:/about")
  assert.ok(!log.some((entry) => entry.startsWith("pushState")), "a popstate raced the router")
  assert.ok(log.filter((entry) => entry === "frame").length >= 20, "polled for ~2.5s of frames")
})

// Clicking the app's own link is not an option here: with the board up the
// shell declaws app events, so the app's preventDefault is gone and the browser
// would follow the href anyway. pushState + popstate reaches the same routers.
await check("without a router, pushState + popstate, believed only when the page changes", async () => {
  const { env, log, doc } = navWindow({})
  assert.equal(await navigate.navigateLive("/about", env), "popstate")
  assert.deepEqual(log.slice(0, 2), ["pushState:/about", "dispatch:popstate"])
  assert.equal(doc.getElementById("app").textContent, "About page")
  assert.ok(log.includes("scroll:0,0"))
  assert.ok(!log.some((entry) => entry.startsWith("assign")))
})

await check("a popstate nobody routes falls through to location.assign", async () => {
  const { env, log } = navWindow({ hearsPopstate: false })
  assert.equal(await navigate.navigateLive("/about", env), "assign")
  assert.equal(log.at(-1), "assign:/about")
  assert.ok(log.filter((entry) => entry === "frame").length >= 10, "waited ~1.2s for the page to change")
})

await check("with no router and no history, location.assign", async () => {
  const { env, log } = navWindow({ history: false })
  assert.equal(await navigate.navigateLive("/about", env), "assign")
  assert.deepEqual(log, ["assign:/about"])
})

await check("the page text ignores the editor's own chrome", () => {
  const { doc } = navWindow({})
  assert.equal(navigate.appText(doc), "Home page")
})

/** A live window whose app routes off the hash; `hearsHash` says whether it re-renders. */
function hashWindow({ hearsHash = true, router = false } = {}) {
  const { env, log, doc } = navWindow({ router })
  const location = env.window.location
  let hash = "#/home"
  Object.defineProperty(location, "hash", {
    get: () => hash,
    set(value) {
      log.push(`hash:${value}`)
      hash = value
      if (hearsHash) doc.getElementById("app").textContent = `Page ${value}`
    },
  })
  location.reload = () => log.push("reload")
  return { env, log, doc }
}

await check("a hash route on the same document: set location.hash, believed when the page changes", async () => {
  const { env, log, doc } = hashWindow({ router: true })
  assert.equal(await navigate.navigateLive("/#/billing", env), "hash")
  assert.equal(log[0], "hash:#/billing", "Next's router or pushState went first")
  assert.equal(doc.getElementById("app").textContent, "Page #/billing")
  assert.ok(!log.some((entry) => /^(push|pushState|assign|reload)/.test(entry)))
  assert.ok(log.includes("scroll:0,0"))
})

await check("a hash nobody routes reloads, since assign to a new fragment would not load", async () => {
  const { env, log } = hashWindow({ hearsHash: false })
  assert.equal(await navigate.navigateLive("/#/billing", env), "assign")
  assert.equal(log.at(-1), "reload")
  assert.ok(!log.some((entry) => entry.startsWith("assign")))
})

await check("a hash route on another document is a full load", async () => {
  const { env, log } = hashWindow({})
  env.window.history = undefined
  assert.equal(await navigate.navigateLive("/other/#/billing", env), "assign")
  assert.deepEqual(log, ["assign:/other/#/billing"])
})

// ── Frame pool ────────────────────────────────────────────────────────────

console.log("frame pool")

/** Fires `load` on every iframe that has been pointed at its page and is not loaded yet. */
function loadPending(container) {
  let fired = 0
  for (const frame of container.querySelectorAll(".de-board-frame")) {
    const iframe = frame.querySelector("iframe")
    const src = iframe.getAttribute("src")
    if (src && src !== "about:blank" && frame.getAttribute("data-loaded") !== "true") {
      iframe.dispatchEvent(new window.Event("load"))
      fired += 1
    }
  }
  return fired
}

await check("12 pages: one load at a time, never more than 8 alive, farthest evicted", () => {
  const container = window.document.createElement("div")
  const loadedOrder = []
  const pool = frames.createFramePool({ onLoad: (view) => loadedOrder.push(view.path) })
  const paths = Array.from({ length: 12 }, (_, i) => `/p${i}`)
  for (const path of paths) container.append(pool.ensure({ path }).element)
  pool.schedule(paths)
  let max = 0
  for (let i = 0; i < 30; i += 1) {
    const loading = Array.from(container.querySelectorAll("iframe")).filter((iframe) => {
      const src = iframe.getAttribute("src")
      return src && src !== "about:blank" && iframe.parentElement.getAttribute("data-loaded") !== "true"
    })
    assert.ok(loading.length <= 1, "one load in flight at a time")
    if (!loadPending(container)) break
    max = Math.max(max, pool.loadedCount())
  }
  assert.equal(max, 8)
  assert.deepEqual(loadedOrder, paths.slice(0, 8), "loaded in priority order")
  // The view moves to the other end: the new top eight load, the old tail goes.
  const reversed = [...paths].reverse()
  pool.schedule(reversed)
  for (let i = 0; i < 30; i += 1) {
    if (!loadPending(container)) break
    assert.ok(pool.loadedCount() <= 8, `loaded ${pool.loadedCount()}`)
  }
  const alive = pool.views().filter((view) => view.status === "loaded").map((view) => view.path).sort()
  assert.deepEqual(alive, reversed.slice(0, 8).sort())
  const evicted = pool.get("/p0")
  assert.equal(evicted.status, "evicted")
  assert.equal(evicted.iframe.getAttribute("src"), "about:blank")
  assert.match(evicted.element.textContent, /Zoom in to load/)
  pool.destroy()
})

// A closed board's frames are whole running apps behind display:none, so they
// are dropped after a grace period — and come back as a first opening would.
await check("release blanks every frame after the grace, unless the board schedules first", async () => {
  const container = window.document.createElement("div")
  const pool = frames.createFramePool()
  for (const path of ["/a", "/b"]) container.append(pool.ensure({ path }).element)
  pool.schedule(["/a", "/b"])
  while (loadPending(container)) {}
  assert.equal(pool.loadedCount(), 2)
  pool.release(20)
  pool.schedule(["/a", "/b"])
  await sleep(40)
  assert.equal(pool.loadedCount(), 2, "a reopen inside the grace keeps every document")
  pool.release(20)
  await sleep(40)
  assert.equal(pool.loadedCount(), 0)
  for (const view of pool.views()) {
    assert.equal(view.iframe.getAttribute("src"), "about:blank")
    assert.equal(view.status, "idle")
    assert.match(view.element.textContent, /Loading…/, "the first-open placeholder, not 'Zoom in to load'")
  }
  // The eviction's own about:blank load is not the page arriving.
  for (const view of pool.views()) view.iframe.dispatchEvent(new window.Event("load"))
  assert.equal(pool.loadedCount(), 0)
  pool.schedule(["/a", "/b"])
  assert.equal(pool.get("/a").iframe.getAttribute("src"), "/a", "reloads one at a time on the next open")
  while (loadPending(container)) {}
  assert.equal(pool.loadedCount(), 2)
  pool.destroy()
})

// A load that has only just been asked for, and has no document yet, is taken
// back for a view transition to capture past it; an older one keeps going.
await check("holdFresh takes back only a load younger than its limit", async () => {
  // Detached, so jsdom gives the frame no document and nothing ever commits.
  const container = window.document.createElement("div")
  const pool = frames.createFramePool()
  container.append(pool.ensure({ path: "/a" }).element)
  pool.schedule(["/a"])
  const view = pool.get("/a")
  assert.equal(view.status, "loading")
  pool.holdFresh(20)
  assert.equal(view.status, "idle")
  assert.equal(view.iframe.getAttribute("src"), "about:blank")
  view.iframe.dispatchEvent(new window.Event("load"))
  assert.equal(view.status, "idle", "the hold's own about:blank load is not the page")
  pool.schedule(["/a"])
  assert.equal(view.iframe.getAttribute("src"), "/a", "asked for again on the next schedule")
  await sleep(30)
  pool.holdFresh(20)
  assert.equal(view.status, "loading", "an older load keeps its head start")
  while (loadPending(container)) {}
  assert.equal(pool.loadedCount(), 1)
  pool.holdFresh(20)
  assert.equal(view.status, "loaded")
  pool.destroy()
})

await check("the initial about:blank load is not mistaken for the page", () => {
  const pool = frames.createFramePool()
  const view = pool.ensure({ path: "/x" })
  view.iframe.dispatchEvent(new window.Event("load"))
  assert.equal(view.status, "idle")
  assert.match(view.element.textContent, /Loading…/)
  pool.destroy()
})

// A frame shows the PAGE. Whatever the editor side draws — its chrome, the
// vendor overlay's root, the companions and the host's declared dev chrome —
// is hidden inside it, so a board of pages cannot turn into a board of editors
// even under an editor started before the launcher learned to skip frames.
await check("a loaded frame hides the editor, vendor, companion and dev chrome inside it", () => {
  const frameDoc = window.document.implementation.createHTMLDocument("frame")
  const iframe = window.document.createElement("iframe")
  Object.defineProperty(iframe, "contentDocument", { value: frameDoc, configurable: true })
  frames.cleanFrameDocument(iframe, "[data-agentation-root], .leva-panel")
  const style = frameDoc.getElementById("designlayer-frame-clean")
  assert.ok(style, "no clean-up style in the frame")
  for (const selector of ["[data-designlayer]", ".de-root", "#react-rewrite-root", "[data-agentation-root]", ".leva-panel"]) {
    assert.ok(style.textContent.includes(selector), `${selector} is not hidden`)
  }
  assert.match(style.textContent, /display: none !important/)
  frames.cleanFrameDocument(iframe, "")
  assert.equal(frameDoc.querySelectorAll("#designlayer-frame-clean").length, 1, "added twice")
  // A cross-origin frame throws on contentDocument; that is not an error here.
  const foreign = window.document.createElement("iframe")
  Object.defineProperty(foreign, "contentDocument", { get() { throw new Error("cross-origin") } })
  frames.cleanFrameDocument(foreign)
})

await check("isBoardFrame knows a frame by its name or its attribute", () => {
  assert.equal(frames.isBoardFrame({ name: "designlayer-frame:/pricing", frameElement: null }), true)
  assert.equal(frames.isBoardFrame({ name: "", frameElement: { hasAttribute: (name) => name === "data-designlayer-frame" } }), true)
  assert.equal(frames.isBoardFrame({ name: "checkout", frameElement: null }), false)
  assert.equal(
    frames.isBoardFrame({ name: "", get frameElement() { throw new Error("cross-origin") } }),
    false
  )
})

// An editor started before the launcher guarded frames still serves this new
// chrome, and its frames would each boot the vendor overlay and take the one
// socket. Its prelude does not claim `boardFrames`, and the board says so
// instead of opening.
await check("a launcher that does not guard frames gets a sentence, not a board", () => {
  assert.equal(editor.staleLauncherMessage({ boardFrames: true }), null)
  assert.match(editor.staleLauncherMessage({ boardFrames: false }), /Restart this editor/)
})

// ── The board ─────────────────────────────────────────────────────────────

console.log("board")

const bridge = {
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
const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  return node
}
const chromeRoot = window.document.createElement("div")
chromeRoot.className = "de-root"
chromeRoot.setAttribute("data-designlayer", "")
window.document.body.append(chromeRoot)
const context = editor.createContext(bridge, { overlay: slot(), toolbar: slot(), left: slot(), right: slot() })

let routes = [
  { path: "/", file: "app/page.tsx" },
  { path: "/settings", file: "app/settings/page.tsx" },
]
globalThis.fetch = async () => ({ ok: true, json: async () => ({ framework: "next", routes }) })

const board = editor.installBoard(context)
const $ = (selector) => window.document.querySelector(selector)
const $$ = (selector) => Array.from(window.document.querySelectorAll(selector))
const root = $(".de-board")
const html = window.document.documentElement

function readCamera() {
  const match = /translate3d\(([-\d.e]+)px, ([-\d.e]+)px, 0\) scale\(([-\d.e]+)\)/.exec(
    $(".de-board-world").style.transform
  )
  assert.ok(match, `world transform: ${$(".de-board-world").style.transform}`)
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) }
}

await check("mounts as a body sibling of .de-root, hidden, below the chrome", () => {
  assert.ok(root, "board exists")
  assert.equal(root.parentElement, window.document.body)
  assert.equal(chromeRoot.parentElement, root.parentElement, "siblings, not nested")
  assert.ok(!chromeRoot.contains(root))
  assert.ok(root.hasAttribute("data-designlayer"))
  assert.equal(root.dataset.state, "closed")
  assert.equal(html.dataset.deView, "live")
  assert.equal(root.style.getPropertyValue("--de-board-left"), "240px")
  assert.equal(root.style.getPropertyValue("--de-board-right"), "260px")
  const css = $("#designlayer-board-style").textContent
  assert.match(css, /\.de-board\[data-state="closed"\] \{ display: none; \}/)
  assert.match(css, /z-index: 2147482990/)
  assert.match(css, /html\.de-vt \.de-root \{ view-transition-name: dl-chrome; \}/)
  assert.equal(board.isOpen(), false)
})

await check("the three commands are registered", () => {
  for (const id of ["view.canvas", "view.canvas.toggle", "view.canvas.prewarm"]) {
    assert.ok(editor.hasCommand(id), id)
  }
})

/*
 * Nothing else on the page may move the board. To a drag preview, a companion
 * or a browser extension it is one more element on <body>, and a board shifted
 * off the canvas rect shows the live page round its edges — the canvas
 * "dragged around". The stylesheet pins the box; the board takes back any
 * inline style it did not write, an inline !important included.
 */
await check("the board's box is pinned, and a foreign transform or offset is taken back out", async () => {
  const css = $("#designlayer-board-style").textContent
  const start = css.indexOf(".de-board {")
  const rule = css.slice(start, css.indexOf("}", start))
  for (const pinned of [
    "position: fixed !important",
    "top: 0 !important",
    "bottom: 0 !important",
    "left: var(--de-board-left, 0px) !important",
    "right: var(--de-board-right, 0px) !important",
    "margin: 0 !important",
    "transform: none !important",
    "translate: none !important",
  ]) {
    assert.ok(rule.includes(pinned), `not pinned: ${pinned}`)
  }
  root.style.transform = "translate(-162px, 40px)"
  root.style.top = "40px"
  root.style.setProperty("translate", "10px 10px", "important")
  root.style.marginLeft = "-20px"
  await sleep(0)
  for (const name of ["transform", "top", "translate", "margin-left"]) {
    assert.equal(root.style.getPropertyValue(name), "", `${name} survived on the board`)
  }
  assert.equal(root.style.getPropertyValue("--de-board-left"), "240px", "the board's own insets were taken too")
  assert.equal(root.style.getPropertyValue("--de-board-right"), "260px")
})

await check("prewarm starts loading the current page before the board opens", async () => {
  editor.runCommand("view.canvas.prewarm")
  const frame = $('.de-board-frame[data-path="/"]')
  assert.ok(frame, "current frame built")
  assert.equal(frame.querySelector("iframe").getAttribute("src"), "/")
  assert.equal(root.dataset.state, "closed")
  await sleep(10)
})

await check("open (fallback path): canvas view on, frames, live buttons, zoom control", async () => {
  const opening = board.open()
  assert.equal(html.dataset.deView, "canvas", "set from the start of opening")
  await opening
  assert.equal(editor.getState().canvasView, true)
  assert.equal(editor.editorOwnsInput(), false)
  assert.equal(root.dataset.state, "open")
  assert.equal(board.isOpen(), true)
  const paths = $$(".de-board-frame").map((frame) => frame.dataset.path)
  assert.deepEqual(paths.sort(), ["/", "/about", "/blog", "/posts/42", "/pricing", "/settings"])
  for (const frame of $$(".de-board-frame")) {
    const iframe = frame.querySelector("iframe")
    assert.equal(iframe.getAttribute("name"), `designlayer-frame:${frame.dataset.path}`)
    assert.ok(iframe.hasAttribute("data-designlayer-frame"))
    assert.equal(iframe.getAttribute("loading"), "eager")
    assert.equal(iframe.getAttribute("tabindex"), "-1")
    assert.equal(iframe.getAttribute("aria-hidden"), "true")
    assert.equal(iframe.style.pointerEvents, "none")
    assert.equal(frame.style.width, "700px", "frame is the canvas width")
    assert.equal(frame.style.height, "800px", "frame is the canvas height")
  }
  assert.equal($('.de-board-frame[data-current="true"]').dataset.path, "/")
  const live = $$("button.de-board-live")
  assert.equal(live.length, 6)
  assert.equal(live[0].dataset.path, "/", "the current page's button comes first in tab order")
  assert.equal(live[0].getAttribute("aria-label"), "Open / live")
  assert.equal(live[0].getAttribute("data-de-tip"), "Open this page live")
  assert.match(live[0].textContent, /Live/)
  assert.ok(live[0].querySelector("svg"), "play glyph")
  assert.ok(!live[0].closest(".de-board-world"), "buttons are in screen space")
  assert.ok($(".de-board-labels .de-board-label[data-path='/'] .de-board-tag:not([hidden])"), "Current tag")
  assert.ok($(".de-board-zoom button[data-de-zoom='out']"))
  assert.ok($(".de-board-zoom button[data-de-zoom='in']"))
  assert.ok($(".de-board-zoom button[data-de-zoom='fit']"))
  assert.match($(".de-board-zoom-value").textContent, /^\d+%$/)
  const camera = readCamera()
  assert.ok(camera.scale < 1, "fitted, not at 100%")
  assert.equal(root.dataset.scale, String(Math.round(camera.scale * 1000) / 1000))
})

await check("the current frame's load marks it loaded and the label picks up the file", () => {
  loadPending(root)
  assert.equal($('.de-board-frame[data-path="/"]').getAttribute("data-loaded"), "true")
  assert.match($(".de-board-label[data-path='/']").textContent, /app\/page\.tsx/)
})

await check("zoom buttons step the camera and update data-scale on settle", async () => {
  const before = Number(root.dataset.scale)
  $("button[data-de-zoom='in']").click()
  await sleep(450)
  const after = Number(root.dataset.scale)
  assert.ok(near(after, Math.min(4, before * 1.5), 0.002), `${before} -> ${after}`)
  assert.equal(root.hasAttribute("data-navigating"), false, "settled")
  $("button[data-de-zoom='out']").click()
  await sleep(450)
  assert.ok(near(Number(root.dataset.scale), before, 0.002))
})

await check("ctrl-wheel zooms about the pointer, coalesced into one frame", async () => {
  const before = readCamera()
  const client = { x: 500, y: 300 }
  const local = { x: client.x - 240, y: client.y }
  const world = cam.screenToWorld(before, local)
  for (let i = 0; i < 3; i += 1) {
    root.dispatchEvent(
      new window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -20,
        clientX: client.x,
        clientY: client.y,
      })
    )
  }
  assert.ok(root.hasAttribute("data-navigating"), "navigating while input is active")
  await sleep(40)
  const after = readCamera()
  assert.ok(near(after.scale, before.scale * Math.exp(60 * 0.0022), 1e-6), `scale ${after.scale}`)
  const held = cam.screenToWorld(after, local)
  assert.ok(near(held.x, world.x, 1e-6) && near(held.y, world.y, 1e-6), "fixed point")
  await sleep(160)
  assert.ok(!root.hasAttribute("data-navigating"), "settles 120ms after input stops")
})

await check("plain wheel pans; wheel outside the board is ignored", async () => {
  const before = readCamera()
  root.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 10, deltaY: 30 }))
  await sleep(40)
  const after = readCamera()
  assert.ok(near(after.x, before.x - 10) && near(after.y, before.y - 30))
  window.document.getElementById("app").dispatchEvent(
    new window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 30 })
  )
  await sleep(40)
  assert.deepEqual(readCamera(), after)
  await sleep(150)
})

await check("= zooms in around the center; the fit command animates back to fit", async () => {
  const before = readCamera()
  window.document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "=", bubbles: true, cancelable: true }))
  await sleep(420)
  assert.ok(near(readCamera().scale, before.scale * 1.5, 1e-6))
  editor.runCommand("view.canvas")
  await sleep(600)
  const count = $$(".de-board-frame").length
  const fitted = cam.fit({ width: 700, height: 800 }, layout.layoutFrames(count, { width: 700, height: 800 }).bounds)
  const after = readCamera()
  assert.ok(near(after.scale, fitted.scale, 1e-9) && near(after.x, fitted.x, 1e-6) && near(after.y, fitted.y, 1e-6))
})

await check("⇧0 goes to 100% around the center; arrows pan 80px", async () => {
  window.document.body.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: ")", code: "Digit0", shiftKey: true, bubbles: true, cancelable: true })
  )
  await sleep(420)
  assert.ok(near(readCamera().scale, 1, 1e-9))
  const before = readCamera()
  window.document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
  assert.ok(near(readCamera().x, before.x - 80))
  editor.runCommand("view.canvas")
  await sleep(600)
})

await check("keys typed into a field are not the board's", () => {
  const input = window.document.createElement("input")
  window.document.body.append(input)
  const before = readCamera()
  const event = new window.KeyboardEvent("keydown", { key: "-", bubbles: true, cancelable: true })
  input.dispatchEvent(event)
  assert.equal(event.defaultPrevented, false)
  assert.deepEqual(readCamera(), before)
  input.remove()
})

await check("hovering a frame reveals its Live button and outline; Space+drag pans", async () => {
  const camera = readCamera()
  const frame = $('.de-board-frame[data-path="/"]')
  const x = 240 + camera.x + (Number.parseFloat(frame.style.left) + 100) * camera.scale
  const y = camera.y + (Number.parseFloat(frame.style.top) + 100) * camera.scale
  root.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y }))
  assert.equal($('button.de-board-live[data-path="/"]').getAttribute("data-hover"), "true")
  assert.equal($(".de-board-hover").getAttribute("data-on"), "true")
  window.document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }))
  assert.ok(root.hasAttribute("data-space"))
  root.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 400, clientY: 400 }))
  root.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 430, clientY: 390 }))
  root.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 430, clientY: 390 }))
  window.document.body.dispatchEvent(new window.KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }))
  const after = readCamera()
  assert.ok(near(after.x, camera.x + 30) && near(after.y, camera.y - 10), "panned with the pointer")
  assert.ok(!root.hasAttribute("data-space"))
  editor.runCommand("view.canvas")
  await sleep(600)
})

await check("Escape closes to the current page", async () => {
  window.document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await sleep(600)
  assert.equal(root.dataset.state, "closed")
  assert.equal(editor.getState().canvasView, false)
  assert.equal(html.dataset.deView, "live")
})

/*
 * Opening from the toolbar leaves focus on the Canvas button, and a focused
 * button answers Space by pressing itself — so the first Space+drag closed the
 * board, and while Space was held the vendor's own pan layer covered the window
 * and took the drag. The board holds focus while it is up and hands it back.
 */
await check("opening takes focus from the toolbar button, and closing hands it back", async () => {
  const opener = window.document.createElement("button")
  opener.setAttribute("data-designlayer", "")
  chromeRoot.append(opener)
  opener.focus()
  await board.open()
  assert.equal(window.document.activeElement, root, "focus stayed on the button that opened the board")
  const space = new window.KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true })
  window.document.activeElement.dispatchEvent(space)
  assert.equal(space.defaultPrevented, true, "Space went past the board")
  assert.ok(root.hasAttribute("data-space"), "Space is not the pan key")
  root.dispatchEvent(new window.KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }))
  await board.close()
  assert.equal(root.dataset.state, "closed")
  assert.equal(window.document.activeElement, opener, "focus was not handed back")
  opener.remove()
})

await check("re-opening keeps loaded frames instead of rebuilding them", async () => {
  const iframe = $('.de-board-frame[data-path="/"] iframe')
  await board.open()
  assert.equal($('.de-board-frame[data-path="/"] iframe'), iframe, "same iframe element")
  assert.equal($('.de-board-frame[data-path="/"]').getAttribute("data-loaded"), "true")
})

await check("toggle closes, and the toggle command opens again", async () => {
  await board.toggle()
  assert.equal(editor.getState().canvasView, false)
  assert.equal(root.dataset.state, "closed")
  editor.runCommand("view.canvas.toggle")
  await sleep(700)
  assert.equal(editor.getState().canvasView, true)
})

await check("a mode change closes instantly", () => {
  context.setMode("interactive")
  assert.equal(root.dataset.state, "closed")
  assert.equal(editor.getState().canvasView, false)
  assert.equal(html.dataset.deView, "live")
  context.setMode("inspecting")
})

/*
 * Collapsing the editor keeps the board. The designer asked for room to look
 * at it, so it grows into the space the panels gave up, and its frames are laid
 * out again at the new canvas size so a zoom back into a page still lands on
 * the layout it showed. The board keeps its own ways out while the chrome is
 * down; what stays refused is OPENING from a collapsed editor, which has no
 * toolbar and no keymap to ask with.
 */
await check("collapsing the editor keeps canvas view and re-lays the frames at full width", async () => {
  await board.open()
  assert.equal(editor.getState().canvasView, true)
  const before = Number.parseFloat($('.de-board-frame[data-path="/"]').style.width)
  assert.ok(near(before, 1200 - 240 - 260), `frame starts at the canvas width, got ${before}`)
  html.style.setProperty("--de-left", "0px")
  html.style.setProperty("--de-right", "0px")
  context.setChromeHidden(true)
  assert.equal(root.dataset.state, "open", "the board went away with the chrome")
  assert.equal(editor.getState().canvasView, true)
  window.dispatchEvent(new window.Event("resize"))
  await sleep(700)
  assert.equal(root.style.getPropertyValue("--de-board-left"), "0px")
  assert.equal(root.style.getPropertyValue("--de-board-right"), "0px")
  const after = Number.parseFloat($('.de-board-frame[data-path="/"]').style.width)
  assert.ok(near(after, 1200), `frames re-laid at the full width, got ${after}`)
  // Escape still leaves while the chrome is down.
  window.document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await sleep(600)
  assert.equal(root.dataset.state, "closed")
  await board.open()
  assert.equal(root.dataset.state, "closed", "opened from a collapsed editor")
  context.setChromeHidden(false)
  html.style.setProperty("--de-left", "240px")
  html.style.setProperty("--de-right", "260px")
  window.dispatchEvent(new window.Event("resize"))
})

/*
 * Clicking the toolbar's Canvas button leaves focus ON the button, so the
 * Escape that follows is aimed at the chrome, not the page. It still has to
 * close the board; a menu or a dialog that owns Escape keeps it.
 */
await check("Escape closes from a focused chrome button, but not from a menu", async () => {
  await board.open()
  const button = window.document.createElement("button")
  button.setAttribute("data-designlayer", "")
  chromeRoot.append(button)
  const menu = window.document.createElement("div")
  menu.setAttribute("role", "menu")
  const item = window.document.createElement("button")
  menu.append(item)
  chromeRoot.append(menu)
  item.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await sleep(50)
  assert.equal(root.dataset.state, "open", "Escape inside a menu closed the board")
  button.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await sleep(600)
  assert.equal(root.dataset.state, "closed")
  button.remove()
  menu.remove()
})

// Unanswered, Escape reaches the shell's last-resort handler and collapses the
// whole editor. An Escape pressed while the page is still shrinking must be
// taken by the board and close it once the opening lands.
await check("Escape during the opening is taken, and closes the board once it lands", async () => {
  const opening = board.open()
  const event = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  window.document.body.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true, "Escape fell through to the collapse handler")
  await opening
  await sleep(700)
  assert.equal(root.dataset.state, "closed")
  assert.equal(editor.getState().canvasView, false)
})

/*
 * Transitions never overlap, but a request made during one is not dropped: the
 * LAST one runs when the transition lands. Dropping them felt like a dead
 * button — a ⇧1 pressed while the board was still growing back into the page
 * did nothing at all.
 */
await check("the last request made mid-transition runs when it lands", async () => {
  const first = board.open()
  const second = board.open()
  assert.equal(root.dataset.state === "opening" || root.dataset.state === "closed", true)
  const closing = board.close()
  await Promise.all([first, second, closing])
  await sleep(700)
  assert.equal(root.dataset.state, "closed", "the close asked for mid-open never ran")
  assert.equal(editor.getState().canvasView, false)

  // And the other way round: an open asked for while closing opens again.
  await board.open()
  const shutting = board.close()
  editor.runCommand("view.canvas")
  await shutting
  await sleep(700)
  assert.equal(root.dataset.state, "open", "the open asked for mid-close never ran")
  await board.close()
  assert.equal(root.dataset.state, "closed")
})

// The toaster, the tooltip card and the shortcuts sheet mount on <body>, outside
// `.de-root`. Left in the root snapshot they would shrink into the frame with
// the page, so each gets a name of its own and stays still, and so do the
// companions and the host's dev chrome through the per-transition rule.
await check("no editor surface travels with the page in the view transition", () => {
  const css = editor.boardCss
  assert.match(css, /html\.de-vt body > \[data-designlayer\]:not\(\.de-root\):not\(\.de-board\) \{\s*view-transition-name: match-element;\s*view-transition-class: dl-ui;/)
  assert.match(css, /::view-transition-old\(\*\.dl-ui\) \{ display: none; \}/)
  assert.match(css, /::view-transition-group\(\*\.dl-ui\) \{ animation: none; \}/)
  assert.equal(editor.boardTrustedVtCss(""), "")
  assert.match(
    editor.boardTrustedVtCss("[data-agentation-root], .leva-panel"),
    /html\.de-vt :is\(\[data-agentation-root\], \.leva-panel\) \{ view-transition-name: match-element; view-transition-class: dl-ui; \}/
  )
})

await check("view transition open: chrome captured apart, old root flies into the slot", async () => {
  let seen = null
  let calls = 0
  window.document.startViewTransition = (update) => {
    calls += 1
    seen = {
      classes: html.className,
      css: window.document.getElementById("designlayer-board-vt-style")?.textContent ?? "",
      stateBefore: root.dataset.state,
    }
    const done = Promise.resolve().then(update)
    return { updateCallbackDone: done, ready: done, finished: done.then(() => undefined), skipTransition() {} }
  }
  await board.open()
  assert.equal(calls, 1)
  assert.equal(seen.stateBefore, "closed", "the old snapshot is the live page")
  assert.match(seen.classes, /\bde-vt\b/)
  assert.match(seen.classes, /\bde-vt-enter\b/)
  assert.match(seen.css, /::view-transition-old\(root\)/)
  assert.match(seen.css, /clip-path: inset\(0 260px 0 240px\)/)
  assert.match(seen.css, /animation: de-board-enter 560ms cubic-bezier\(0\.22, 1, 0\.36, 1\) both/)
  // The keyframes map the canvas rect onto the current frame's slot on screen.
  const camera = readCamera()
  const s = camera.scale
  const tx = 240 + camera.x - s * 240
  const ty = camera.y
  const match = /scale\(([-\d.e]+)\)/.exec(seen.css.split("to {")[1])
  assert.ok(near(Number(match[1]), s, 1e-9), `keyframe scale ${match?.[1]} vs ${s}`)
  assert.match(seen.css, new RegExp(`translate\\(${Math.round(tx * 100) / 100}px, ${Math.round(ty * 100) / 100}px\\)`))
  assert.equal(root.dataset.state, "open")
  assert.equal(editor.getState().canvasView, true)
  assert.ok(!/\bde-vt-enter\b/.test(html.className), "the entrance's class removed after finished")
  assert.equal(window.document.getElementById("designlayer-board-vt-style"), null)
  // The exit's names wait in place while the board is open (`armExitNames`).
  assert.match(html.className, /\bde-vt\b/)
  assert.ok(window.document.getElementById("designlayer-board-vt-names"))
})

await check("view transition close: board grows into the page, live underneath", async () => {
  let seen = null
  window.document.startViewTransition = (update) => {
    seen = { css: window.document.getElementById("designlayer-board-vt-style")?.textContent ?? "", classes: html.className }
    const done = Promise.resolve().then(update)
    return { updateCallbackDone: done, ready: done, finished: done.then(() => undefined), skipTransition() {} }
  }
  const camera = readCamera()
  await board.close()
  assert.match(seen.classes, /\bde-vt-exit\b/)
  assert.match(seen.css, /de-board-exit 460ms/)
  // The keyframes are static, so the keypress adds no @keyframes rule; the
  // landing transform rides on the old image as `--de-vt-to`.
  assert.ok(!/@keyframes/.test(seen.css), "the exit's style brings no @keyframes")
  assert.match(editor.boardCss, /@keyframes de-board-exit \{[^}]*\}\s*80% \{ opacity: 1; \}\s*to \{ transform: var\(--de-vt-to\); opacity: 0; \}/)
  const s = 700 / (700 * camera.scale)
  const match = /--de-vt-to: translate\([^)]*\) scale\(([-\d.e]+)\)/.exec(seen.css)
  assert.ok(near(Number(match[1]), s, 1e-9))
  assert.equal(root.dataset.state, "closed")
  assert.equal(editor.getState().canvasView, false)
  delete window.document.startViewTransition
})

await check("closing to another page flies to it, routes the live page, then fades", async () => {
  await board.open()
  window.next = { router: { push: (path) => window.history.pushState({}, "", path) } }
  $('button.de-board-live[data-path="/settings"]').click()
  await sleep(520)
  const settings = $('.de-board-frame[data-path="/settings"]')
  const camera = readCamera()
  assert.ok(near(camera.scale, 1), "the target frame fills the canvas")
  assert.ok(near(camera.x, -Number.parseFloat(settings.style.left)))
  await sleep(200)
  assert.equal(window.location.pathname, "/settings")
  assert.equal(root.dataset.state, "closed")
  assert.equal(editor.getState().canvasView, false)
  delete window.next
  window.history.pushState({}, "", "/")
})

await check("12 routes through the board: never more than 8 frames alive", async () => {
  routes = Array.from({ length: 12 }, (_, i) => ({ path: i === 0 ? "/" : `/r${i}` }))
  await sleep(5100) // let the cached page list go stale
  const before = $$(".de-board-frame").length
  const opening = board.open()
  // The open starts on the last answer, and the fresher one re-lays the board
  // once it has landed: the transition never waits on the server.
  await sleep(50)
  assert.equal($$(".de-board-frame").length, before, "the open waited for the server")
  await opening
  assert.ok($$(".de-board-frame").length >= 12, "the fresher answer never reached the board")
  await sleep(400 + 120 + 50) // the fit tween, then the settle that schedules the frames
  let max = 0
  for (let i = 0; i < 40; i += 1) {
    if (!loadPending(root)) break
    max = Math.max(max, $$('.de-board-frame[data-loaded="true"]').length)
  }
  assert.ok(max <= 8, `max loaded ${max}`)
  assert.equal(max, 8)
  assert.ok($$(".de-board-frame").length >= 12)
  // The whole board is in view, so the eight documents go to the board's
  // first eight pages — its ranking — not to whatever sits mid-grid.
  const ranked = $$("button.de-board-live").map((button) => button.dataset.path)
  const alive = $$('.de-board-frame[data-loaded="true"]').map((frame) => frame.dataset.path)
  assert.deepEqual(alive.sort(), ranked.slice(0, 8).sort())
  const waiting = $(`.de-board-frame[data-path="${ranked[11]}"]`)
  assert.match(waiting.textContent, /Zoom in to load/, "a frame past the budget claims to be loading")
  // Rows this far out are closer together on screen than a two-line label is tall.
  assert.ok(root.hasAttribute("data-compact-labels"), "labels keep their second line over the row above")
  assert.match($("#designlayer-board-style").textContent, /\.de-board\[data-compact-labels\] \.de-board-label-meta \{ display: none; \}/)
  window.document.body.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: ")", code: "Digit0", shiftKey: true, bubbles: true, cancelable: true })
  )
  await sleep(420)
  assert.ok(!root.hasAttribute("data-compact-labels"), "labels stay compact at 100%")
  await board.close()
})

await check("reduced motion opens and closes without a camera flight", async () => {
  window.matchMedia = (query) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} })
  const start = Date.now()
  await board.open()
  assert.ok(Date.now() - start < 300, "no 560ms tween")
  assert.equal(root.dataset.state, "open")
  await board.close()
  assert.equal(root.dataset.state, "closed")
  delete window.matchMedia
})

/*
 * The same board over an app that routes off the hash, the way a HashRouter app
 * does: the page on screen is `/#/pricing`, not `/`, and its frame has to load
 * that route — bare `/` would show the app's default route instead.
 */
await check("a hash-routed app: the current frame is the hash route, and Live moves the hash", async () => {
  routes = [{ path: "/" }, { path: "/settings" }]
  const app = window.document.getElementById("app")
  const links = app.innerHTML
  const router = () => {
    app.textContent = `Hash page ${window.location.hash}`
  }
  window.addEventListener("hashchange", router)
  window.history.pushState({}, "", "/#/pricing")
  await sleep(5100) // let the cached page list go stale
  try {
    await board.open()
    const current = $('.de-board-frame[data-current="true"]')
    assert.equal(current?.dataset.path, "/#/pricing", "the current frame is not the page on screen")
    // jsdom never fires `load`, so a frame an earlier case left loading holds the queue.
    const iframe = current.querySelector("iframe")
    for (let i = 0; i < 20 && !iframe.getAttribute("src"); i += 1) loadPending(root)
    assert.equal(iframe.getAttribute("src"), "/#/pricing", "the current frame does not load its route")
    assert.ok($(".de-board-label[data-path='/#/pricing'] .de-board-tag:not([hidden])"), "Current tag")
    const paths = $$(".de-board-frame").map((frame) => frame.dataset.path)
    assert.ok(paths.includes("/#/settings"), `server routes not behind the hash: ${paths}`)
    assert.ok(!paths.includes("/"), `the bare document, which only redirects, is on the board: ${paths}`)
    $('button.de-board-live[data-path="/#/settings"]').click()
    for (let i = 0; i < 40 && root.dataset.state !== "closed"; i += 1) await sleep(50)
    assert.equal(window.location.hash, "#/settings")
    assert.equal(window.location.pathname, "/")
    assert.equal(app.textContent, "Hash page #/settings")
    assert.equal(root.dataset.state, "closed")
    assert.equal(pages.readVisited()[0], "/#/settings", "the visit was not remembered")
    // Routed somewhere no page list has, and reopened while the last list is
    // still cached: the board leads with the page on screen anyway.
    window.location.hash = "#/brand-new"
    await sleep(20)
    await board.open()
    const fresh = $('.de-board-frame[data-current="true"]')
    assert.equal(fresh?.dataset.path, "/#/brand-new", "a board without the page it was opened from")
    assert.equal($$("button.de-board-live")[0].dataset.path, "/#/brand-new", "the current page does not lead")
    await board.close()
  } finally {
    window.removeEventListener("hashchange", router)
    app.innerHTML = links
    window.history.pushState({}, "", "/")
  }
})

await check("destroy removes the board, its styles and its commands", () => {
  board.destroy()
  assert.equal($(".de-board"), null)
  assert.equal($("#designlayer-board-style"), null)
  assert.equal(editor.hasCommand("view.canvas"), false)
  assert.equal(html.dataset.deView, undefined)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
