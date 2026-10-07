/**
 * Which pages go on the board.
 *
 * Several sources, because none is enough alone. The running app's React
 * Router holds its whole route table with every constant resolved (see
 * `app-routes.ts`). The server reads route tables out of source
 * (`GET <apiBase>/pages`), which covers apps the board cannot inspect and knows
 * each route's file. Neither can turn `/posts/[id]` into a page anybody can
 * look at; the live document's links are concrete URLs the app itself renders,
 * so they fill in exactly the dynamic routes the others leave blank, and the
 * pages this tab has shown fill in the rest. A route that is only a pattern,
 * with no link or visit to make it real, is dropped rather than guessed at.
 *
 * Each source may come up empty (an older runtime, a host with no router
 * anybody can read), and any failure is "no routes" from that source.
 *
 * A page is a ROUTE, not a pathname. A hash router (React Router's HashRouter,
 * Vue's hash history, Angular's `useHash`) serves every page from one document
 * and tells them apart by the fragment: `/#/settings`, `/#/billing`. Keyed by
 * pathname, every page of such an app was `/`, so the board showed one frame
 * that loaded bare `/` — whatever the app's default route was, not the page
 * the designer was on. See `normalizeRoute`.
 */

import { CHROME_ATTR } from "../core/dom"
import { readAppRoutes } from "./app-routes"

export interface RouteInfo {
  path: string
  file?: string
  dynamic?: boolean
}

export interface PageEntry {
  path: string
  /** The source file the route resolves to, when the server knew it. */
  file?: string
}

/** The board shows at most this many pages; past it a grid stops being a map. */
export const MAX_PAGES = 16

/** Links to these are downloads, not pages. */
const FILE_EXTENSION =
  /\.(pdf|png|jpe?g|gif|webp|avif|svg|ico|zip|gz|tgz|rar|7z|dmg|exe|mp3|mp4|mov|webm|wav|csv|xlsx?|docx?|pptx?|txt|json|xml|woff2?|ttf|js|css|map)$/i

/** `[id]`, `[...slug]`, `:id`, `$id` — Next, React Router / Angular, Remix / TanStack. */
const DYNAMIC_SEGMENT = /^(\[.+\]|:.+|\$.*)$/

/** Drops hash and query, and a trailing slash anywhere but the root. */
export function normalizePath(pathname: string): string {
  let path = pathname.split("#")[0].split("?")[0] || "/"
  if (!path.startsWith("/")) path = `/${path}`
  path = path.replace(/\/{2,}/g, "/")
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "") || "/"
  return path
}

/** `#/x` and `#!/x` are a hash router's routes; `#top` is an anchor. */
const HASH_ROUTE = /^#!?\//

/**
 * The page a URL shows, as the board keys it: the normalized path, plus the
 * fragment when that fragment is a hash router's route.
 *
 * With a hash route the pathname is the document's address rather than a page,
 * so it keeps its trailing slash — a subdirectory host serves `/asset/x/` and
 * not `/asset/x` — and only the route after the `#` is normalized.
 */
export function normalizeRoute(url: string): string {
  const cut = url.indexOf("#")
  const hash = cut === -1 ? "" : url.slice(cut)
  const before = (cut === -1 ? url : url.slice(0, cut)).split("?")[0]
  if (!HASH_ROUTE.test(hash)) return normalizePath(before)
  const prefix = hash.startsWith("#!") ? "#!" : "#"
  const documentPath = `/${before}`.replace(/\/{2,}/g, "/")
  return `${documentPath}${prefix}${normalizePath(hash.slice(prefix.length))}`
}

/** The page `location` is showing; see `normalizeRoute`. */
export function routeOf(location: { pathname: string; hash?: string }): string {
  return normalizeRoute(`${location.pathname}${location.hash ?? ""}`)
}

/**
 * The part a hash router's routes hang off (`/#`, `/#!`), or null when `route`
 * is an ordinary path. The server reads route tables as plain paths, and in a
 * hash-routed app each of those is a page only behind this prefix.
 */
export function hashBase(route: string): string | null {
  const cut = route.indexOf("#")
  if (cut === -1 || !HASH_ROUTE.test(route.slice(cut))) return null
  return route.slice(0, route.startsWith("#!", cut) ? cut + 2 : cut + 1)
}

export function isDynamicPattern(path: string): boolean {
  return path.split("/").some((segment) => DYNAMIC_SEGMENT.test(segment))
}

/** A dynamic route as a matcher for concrete paths. */
function patternMatcher(pattern: string): RegExp {
  const parts = normalizeRoute(pattern)
    .split("/")
    .map((segment) => {
      if (/^\[\[?\.\.\..+\]?\]$/.test(segment)) return ".+"
      if (DYNAMIC_SEGMENT.test(segment)) return "[^/]+"
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    })
  return new RegExp(`^${parts.join("/")}$`)
}

/**
 * Same-origin page links in the live document, as routes, in document order.
 * The editor's own chrome is skipped: its anchors are about the editor.
 *
 * A bare fragment that is not a route (`#`, `#top`) is an anchor on the page
 * already open, not a page. In a hash-routed app it would otherwise resolve to
 * the bare document, `/`, which is only the app's default-route redirect.
 */
export function collectLinkPaths(doc: Document, origin: string): string[] {
  const paths: string[] = []
  for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    if (anchor.closest(`[${CHROME_ATTR}]`)) continue
    if (anchor.target === "_blank" || anchor.hasAttribute("download")) continue
    const href = anchor.getAttribute("href") ?? ""
    if (href.startsWith("#") && !HASH_ROUTE.test(href)) continue
    let url: URL
    try {
      url = new URL(href, doc.baseURI || origin)
    } catch {
      continue
    }
    if (url.origin !== origin) continue
    if (FILE_EXTENSION.test(url.pathname)) continue
    paths.push(normalizeRoute(`${url.pathname}${url.hash}`))
  }
  return paths
}

/** The server's route table, or none. Never throws. */
export async function fetchRoutes(
  apiBase: string,
  fetchImpl: typeof fetch | undefined = globalThis.fetch
): Promise<RouteInfo[]> {
  if (typeof fetchImpl !== "function") return []
  try {
    const response = await fetchImpl(`${apiBase}/pages`, { headers: { accept: "application/json" } })
    if (!response.ok) return []
    const body = (await response.json()) as { routes?: unknown }
    if (!Array.isArray(body?.routes)) return []
    return body.routes
      .filter((route): route is RouteInfo => typeof route?.path === "string")
      .map((route) => ({
        path: route.path,
        file: typeof route.file === "string" ? route.file : undefined,
        dynamic: Boolean(route.dynamic),
      }))
  } catch {
    return []
  }
}

/** A route's segments below its document: `/#/a/b` and `/a/b` are both `a`, `b`. */
function routeSegments(route: string): { documentPath: string; segments: string[] } {
  const base = hashBase(route)
  const path = base ? route.slice(base.length) : route
  return { documentPath: base ?? "", segments: path.split("/").filter(Boolean) }
}

/**
 * How near two pages sit in the app: the leading route segments they share.
 * `/settings/team` is nearer `/settings/billing` (1) than `/pricing` is (0).
 */
export function nearness(a: string, b: string): number {
  const one = routeSegments(a)
  const two = routeSegments(b)
  if (one.documentPath !== two.documentPath) return 0
  let shared = 0
  while (shared < one.segments.length && one.segments[shared] === two.segments[shared]) shared += 1
  return shared
}

/**
 * One ordered list, capped at the board's size: the current page first, then
 * every other page, nearest the current one first.
 *
 * Nearness is what makes the cap choose the right pages. A real app's route
 * table runs to hundreds of routes — one prototype mounted its whole table
 * under four product prefixes — and sixteen of them in declaration order were
 * the first product's, not the section the designer was working in. The pages
 * beside the current one (`/dashboard/orders` from `/dashboard/invoices`) are the
 * ones a designer compares, so they lead.
 *
 * At equal nearness, pages this tab has shown come first (most recent first),
 * then the router's routes in the order they were declared, then links. Visits
 * are also how an app whose routes nobody can read — button navigation over a
 * route table the server cannot parse, in an app the board cannot inspect —
 * still gets a board of the pages the designer has been through. Dynamic
 * routes appear only through a concrete link or visit, which inherits the
 * route's file.
 */
export function mergePages(options: {
  routes: readonly RouteInfo[]
  links: readonly string[]
  current: string
  visited?: readonly string[]
  cap?: number
}): PageEntry[] {
  const cap = options.cap ?? MAX_PAGES
  const current = normalizeRoute(options.current)
  const statics = new Map<string, string | undefined>()
  const dynamics: Array<{ match: RegExp; file?: string }> = []
  for (const route of options.routes) {
    if (route.dynamic || isDynamicPattern(route.path)) {
      dynamics.push({ match: patternMatcher(route.path), file: route.file })
    } else {
      // The same page from two sources keeps its first place and gains a file
      // from whichever source knew one.
      const path = normalizeRoute(route.path)
      if (!statics.get(path)) statics.set(path, route.file)
    }
  }
  const fileFor = (path: string): string | undefined => {
    if (statics.has(path)) return statics.get(path)
    return dynamics.find((entry) => entry.match.test(path))?.file
  }

  const seen = new Set<string>()
  const pages: PageEntry[] = []
  const add = (path: string) => {
    if (seen.has(path) || pages.length >= cap) return
    // A link can itself be a pattern when an app renders its route table
    // literally; that is no more viewable than the route was.
    if (isDynamicPattern(path)) return
    seen.add(path)
    const file = fileFor(path)
    pages.push(file ? { path, file } : { path })
  }
  const candidates = [
    ...(options.visited ?? []).map((path, order) => ({ path: normalizeRoute(path), source: 0, order })),
    ...Array.from(statics.keys(), (path, order) => ({ path, source: 1, order })),
    ...options.links.map((path, order) => ({ path: normalizeRoute(path), source: 2, order })),
  ].map((candidate) => ({ ...candidate, near: nearness(candidate.path, current) }))
  candidates.sort((a, b) => b.near - a.near || a.source - b.source || a.order - b.order)
  add(current)
  for (const candidate of candidates) add(candidate.path)
  return pages
}

/* ── pages this tab has shown ─────────────────────────────────────────────── */

const VISITED_KEY = "designlayer:board-visited"

type VisitStore = Pick<Storage, "getItem" | "setItem">

function sessionStore(): VisitStore | null {
  try {
    return window.sessionStorage
  } catch {
    // Storage disabled, or an opaque origin.
    return null
  }
}

/** Routes this tab has shown, most recent first. Never throws. */
export function readVisited(store: VisitStore | null = sessionStore()): string[] {
  try {
    const list = JSON.parse(store?.getItem(VISITED_KEY) ?? "[]")
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

/** Puts `route` at the front of the visits, capped at the board's size. Never throws. */
export function rememberVisit(route: string, store: VisitStore | null = sessionStore()): void {
  if (!store) return
  try {
    const path = normalizeRoute(route)
    const list = [path, ...readVisited(store).filter((entry) => entry !== path)].slice(0, MAX_PAGES)
    store.setItem(VISITED_KEY, JSON.stringify(list))
  } catch {
    // Full or refused: the board just has fewer pages.
  }
}

/** Everything above, against the live page. Never throws. */
export async function loadPages(options: PageSources & { fetch?: typeof fetch }): Promise<PageEntry[]> {
  return buildPages({ ...options, routes: await fetchRoutes(options.apiBase, options.fetch) })
}

export interface PageSources {
  apiBase: string
  doc?: Document
  location?: { origin: string; pathname: string; hash?: string }
  visited?: readonly string[]
  cap?: number
}

/**
 * `loadPages` with the server's answer already in hand, and so synchronous.
 *
 * Everything else the list is made of — the links on the page, the running
 * app's route table, the visits — is read off this document as it is now, so
 * the board can keep the one part that costs a request (the server's source
 * scan) from an earlier answer and still open on a list that is current in
 * every other respect.
 */
export function buildPages(options: PageSources & { routes: readonly RouteInfo[] }): PageEntry[] {
  const doc = options.doc ?? document
  const location = options.location ?? window.location
  const current = routeOf(location)
  let links: string[] = []
  try {
    links = collectLinkPaths(doc, location.origin)
  } catch (error) {
    console.warn("[designlayer]", error)
  }
  // In a hash-routed app the router's plain paths are pages only behind the
  // hash. The live URL says so; before the app has routed, its links can.
  const base = hashBase(current) ?? links.map(hashBase).find((entry) => entry !== null) ?? null
  // The running app's table first: it is in declaration order and complete
  // where the source read is not. The server's adds what the app has not
  // rendered a router for, and the files the app cannot know.
  let routes = [...readAppRoutes(doc), ...options.routes]
  let visited = options.visited ?? []
  if (base) {
    routes = routes.map((route) => ({ ...route, path: `${base}${normalizePath(route.path)}` }))
    // The bare document of a hash-routed app is only its default-route
    // redirect: as a frame it would show that redirect again. A link to it (a
    // logo's `href="/"`) or a visit from the moment before the redirect ran is
    // dropped; a link to another document stays.
    const documentPath = base.slice(0, base.indexOf("#"))
    const bare = (route: string) => hashBase(route) === null && normalizePath(route) === normalizePath(documentPath)
    links = links.filter((link) => !bare(link))
    visited = visited.filter((visit) => !bare(normalizeRoute(visit)))
  }
  return mergePages({ routes, links, current, visited, cap: options.cap })
}
