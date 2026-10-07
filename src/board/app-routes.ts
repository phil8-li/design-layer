/**
 * The app's own route table, read from the running React tree.
 *
 * The server reads route tables out of source, which works while a route is a
 * literal (`path="/billing"`) and stops working when it is a constant
 * (`path={ROUTES.BILLING}`), when it is nested under a prefix
 * (`<Route path="web/*" element={<Routes>…</Routes>} />`), or when it sits in
 * one of the files past the walk's budget. A real prototype did all three, and
 * its board showed the two pages the designer happened to have visited. The
 * running app has already evaluated every one of those: React Router's
 * `<Routes>` holds all of its `<Route>` elements, matched or not, with their
 * `path` props resolved. So the board reads them there.
 *
 * Recognized by shape first, because a production build minifies both `Routes`
 * and `Route`: a `<Routes>` is a component whose children are all elements of
 * one type carrying `path` or `index` props — React Router allows nothing else
 * there — and `Route` is whatever type those are. Where names survive, they
 * have to agree (see `isRoutesType`). A data router (`createBrowserRouter` +
 * `<RouterProvider>`) carries its route objects on the `router` prop and is
 * read from those instead.
 *
 * Bounded and best-effort like everything else the board reads: no React, no
 * router, or a tree it does not understand each mean "no routes", never an
 * error in the page.
 */

import { CHROME_ATTR } from "../core/dom"
import type { RouteInfo } from "./pages"

/** Guards on a hand-written tree, not product limits. */
const MAX_FIBERS = 20000
const MAX_ELEMENTS = 20000
const MAX_ROUTES = 2000

const FRAGMENT = Symbol.for("react.fragment")

interface ElementLike {
  $$typeof: unknown
  type: unknown
  props: Record<string, unknown>
}

interface FiberLike {
  type: unknown
  memoizedProps: Record<string, unknown> | null
  stateNode: unknown
  child: FiberLike | null
  sibling: FiberLike | null
  return: FiberLike | null
}

interface RouteObjectLike {
  path?: unknown
  index?: unknown
  element?: unknown
  children?: unknown
}

const isElement = (value: unknown): value is ElementLike =>
  typeof value === "object" &&
  value !== null &&
  "$$typeof" in value &&
  typeof (value as ElementLike).props === "object" &&
  (value as ElementLike).props !== null

/** Children as React Router reads them: arrays and fragments flattened, holes dropped. */
function flatten(children: unknown, out: ElementLike[] = [], budget = { left: MAX_ELEMENTS }): ElementLike[] {
  if (budget.left <= 0) return out
  if (Array.isArray(children)) {
    for (const child of children) flatten(child, out, budget)
  } else if (isElement(children)) {
    budget.left -= 1
    if (children.type === FRAGMENT) flatten(children.props.children, out, budget)
    else out.push(children)
  }
  return out
}

const typeName = (type: unknown): string => {
  if (typeof type !== "function" && (typeof type !== "object" || type === null)) return ""
  const named = type as { displayName?: unknown; name?: unknown }
  const name = named.displayName ?? named.name
  return typeof name === "string" ? name : ""
}

/**
 * A route whose element only sends the browser somewhere else is not a page:
 * as a frame it shows the page it redirects to, a second time. React Router's
 * `<Navigate>` is the usual one; apps name their own `…Redirect`. Only visible
 * where names survive — a minified build keeps such routes on the board.
 */
const isRedirect = (element: unknown): boolean =>
  isElement(element) && /^Navigate$|Redirect/.test(typeName(element.type))

/** `<Route>` elements, if `children` is what a `<Routes>` holds: one type, and some `path` or `index`. */
function routeChildren(children: unknown): ElementLike[] | null {
  const elements = flatten(children)
  if (!elements.length) return null
  const type = elements[0].type
  if (typeof type !== "function") return null
  if (!elements.every((element) => element.type === type)) return null
  const routed = elements.some((element) => typeof element.props.path === "string" || element.props.index === true)
  return routed ? elements : null
}

/**
 * Whether a component holding `routes` is React Router's `<Routes>`. The shape
 * alone would also fit, say, a breadcrumb list of `<Crumb path>` items, so the
 * names decide where they are readable — `Routes` or `Route` — and where a
 * minifier has shortened both, the shape is all there is to go on.
 */
function isRoutesType(type: unknown, routes: ElementLike[]): boolean {
  const own = typeName(type)
  const child = typeName(routes[0].type)
  if (own === "Routes" || child === "Route") return true
  return own.length <= 3 && child.length <= 3
}

/** `/a` + `b` → `/a/b`, the way React Router joins a child path onto its parent's. */
function joinPath(base: string, path: string): string {
  const joined = `${base}/${path}`.replace(/\/{2,}/g, "/")
  return joined.length > 1 ? joined.replace(/\/+$/, "") : joined
}

/**
 * Where a route's own path puts it within one `<Routes>`. An absolute child
 * path is already whole there (React Router requires it to start with its
 * parent's); a relative one hangs off the parent. A splat keeps its prefix,
 * which is a page of its own, and a bare `*` is a catch-all, not a page.
 */
function localPath(parent: string, path: unknown): string | null {
  if (typeof path !== "string") return parent
  if (path === "*") return null
  const clean = path.replace(/\/?\*$/, "")
  return clean.startsWith("/") ? joinPath("/", clean) : joinPath(parent, clean)
}

export function readAppRoutes(doc: Document = document): RouteInfo[] {
  const out: RouteInfo[] = []
  const seen = new Set<string>()
  const add = (path: string) => {
    if (seen.has(path) || out.length >= MAX_ROUTES) return
    seen.add(path)
    out.push({ path, dynamic: path.split("/").some((segment) => /^[:*]/.test(segment) || segment.endsWith("?")) })
  }
  /*
   * URLs some route redirects. Another route can claim the same URL — a nested
   * table's home under `/app/*` beside a `/app` that redirects — and React
   * Router ranks the plain `/app` above the splat, so the redirect is what
   * that URL shows. It is not a page, whichever route named it.
   */
  const redirects = new Set<string>()

  const elementBudget = { left: MAX_ELEMENTS }
  const visitedElements = new Set<unknown>()
  let routesType: unknown = null

  /** The `<Route>` elements of one `<Routes>`, whose paths are relative to `base`. */
  const readRouteElements = (routes: ElementLike[], base: string, parent: string, basename: string) => {
    for (const route of routes) {
      if (elementBudget.left-- <= 0) return
      const props = route.props
      const local = props.index === true ? parent : localPath(parent, props.path)
      if (local === null) continue
      const full = joinPath(base, local)
      if (typeof props.path === "string" || props.index === true) {
        const url = joinPath(basename, full)
        if (isRedirect(props.element)) redirects.add(url)
        // `app/*` holding a table is where that table mounts, not a page: the
        // table's own routes say what `/app` shows.
        else if (!(String(props.path).endsWith("*") && findRoutesIn(props.element, full, basename, false))) add(url)
      }
      const nested = routeChildren(props.children)
      if (nested) readRouteElements(nested, base, local, basename)
      // A `<Routes>` inside the element is a descendant table: its paths, even
      // the absolute ones, are relative to where this route matched.
      findRoutesIn(props.element, full, basename)
    }
  }

  /**
   * Every `<Routes>` in an element tree that has not rendered, e.g.
   * `element={AppRoutes()}`, read — or with `read` off, only looked for.
   * Reports whether there was one.
   */
  const findRoutesIn = (value: unknown, base: string, basename: string, read = true): boolean => {
    let found = false
    const pending: unknown[] = [value]
    const visited = read ? visitedElements : new Set<unknown>()
    while (pending.length && elementBudget.left > 0) {
      const next = pending.pop()
      if (Array.isArray(next)) {
        pending.push(...next)
        continue
      }
      if (!isElement(next) || visited.has(next)) continue
      visited.add(next)
      elementBudget.left -= 1
      const routes = typeof next.type === "function" ? routeChildren(next.props.children) : null
      if (routes && (routesType === null ? isRoutesType(next.type, routes) : next.type === routesType)) {
        found = true
        if (!read) return true
        routesType ??= next.type
        readRouteElements(routes, base, "/", basename)
        continue
      }
      for (const prop of Object.values(next.props)) {
        if (isElement(prop) || Array.isArray(prop)) pending.push(prop)
      }
    }
    return found
  }

  const readRouteObjects = (routes: unknown, parent: string, basename: string) => {
    if (!Array.isArray(routes)) return
    for (const route of routes as RouteObjectLike[]) {
      if (typeof route !== "object" || route === null || elementBudget.left-- <= 0) continue
      const local = route.index === true ? parent : localPath(parent, route.path)
      if (local === null) continue
      if (typeof route.path === "string" || route.index === true) {
        if (isRedirect(route.element)) redirects.add(joinPath(basename, local))
        else add(joinPath(basename, local))
      }
      readRouteObjects(route.children, local, basename)
    }
  }

  /**
   * What React Router's contexts say above a rendered `<Routes>`: the router's
   * basename, and where the enclosing route matched — the base of a descendant
   * table rendered by a component rather than written into an `element` prop.
   */
  const contextOf = (fiber: FiberLike): { base: string; basename: string } => {
    let base: string | null = null
    for (let up = fiber.return; up; up = up.return) {
      const value = up.memoizedProps?.value as { matches?: unknown; basename?: unknown; navigator?: unknown } | undefined
      if (!value || typeof value !== "object") continue
      if (base === null && Array.isArray(value.matches) && value.matches.length) {
        const last = value.matches[value.matches.length - 1] as { pathnameBase?: unknown }
        if (typeof last?.pathnameBase === "string") base = last.pathnameBase
      }
      if (value.navigator && typeof value.basename === "string") return { base: base ?? "/", basename: value.basename || "/" }
    }
    return { base: base ?? "/", basename: "/" }
  }

  try {
    for (const root of rootFibers(doc)) {
      const pending: FiberLike[] = [root]
      let fibers = 0
      while (pending.length && fibers++ < MAX_FIBERS) {
        const fiber = pending.pop()!
        if (fiber.sibling) pending.push(fiber.sibling)
        if (fiber.child) pending.push(fiber.child)
        const props = fiber.memoizedProps
        if (!props || typeof props !== "object") continue
        const router = props.router as { routes?: unknown; basename?: unknown } | undefined
        if (router && typeof router === "object" && Array.isArray(router.routes)) {
          readRouteObjects(router.routes, "/", typeof router.basename === "string" ? router.basename || "/" : "/")
          continue
        }
        if (typeof fiber.type !== "function" || (routesType !== null && fiber.type !== routesType)) continue
        const routes = routeChildren(props.children)
        if (!routes || (routesType === null && !isRoutesType(fiber.type, routes))) continue
        routesType ??= fiber.type
        const { base, basename } = contextOf(fiber)
        readRouteElements(routes, base, "/", basename)
      }
    }
  } catch (error) {
    console.warn("[designlayer]", error)
  }
  return out.filter((route) => !redirects.has(route.path))
}

/**
 * The app's React roots: `createRoot` containers and legacy `render` ones.
 * Looked for near the top of <body>, where apps mount, and never inside the
 * editor's own chrome.
 */
function rootFibers(doc: Document): FiberLike[] {
  const body = doc.body
  if (!body) return []
  const candidates: Element[] = [body]
  for (const child of Array.from(body.children)) {
    candidates.push(child)
    for (const grandchild of Array.from(child.children)) candidates.push(grandchild)
  }
  const roots: FiberLike[] = []
  for (const element of candidates) {
    if (element.closest(`[${CHROME_ATTR}]`)) continue
    const record = element as unknown as Record<string, unknown>
    for (const key of Object.keys(record)) {
      let fiber: FiberLike | undefined
      if (key.startsWith("__reactContainer$")) fiber = record[key] as FiberLike
      else if (key === "_reactRootContainer") {
        fiber = (record[key] as { _internalRoot?: { current?: FiberLike } } | undefined)?._internalRoot?.current
      }
      if (!fiber) continue
      // The container keeps the host root it was created with, which after a
      // commit may be the stale alternate; the root node knows the live one.
      const live = (fiber.stateNode as { current?: FiberLike } | null)?.current
      roots.push(live ?? fiber)
    }
  }
  return roots
}
