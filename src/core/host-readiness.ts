/**
 * Waits until the host framework has claimed the DOM.
 *
 * The editor is injected outside the app, so it cannot use a host component's
 * effect as a readiness signal. Next's `afterInteractive` contract also allows
 * a script to run after only part of the page has hydrated. Each framework does
 * leave a mark on the elements it owns, and that mark is the narrow signal we
 * need before changing attributes on `<html>` or adding editor chrome to
 * `<body>`.
 *
 *   React   — a Fiber/props expando on every claimed host element.
 *   Angular — `ng-version` on the element it bootstrapped into.
 *
 * Asking the wrong question is not a harmless miss: nothing in an Angular page
 * ever grows a `__reactFiber$`, so the poll below ran to its full ten-second
 * timeout on EVERY load and the editor appeared ten seconds after the app did.
 * It worked, so it never failed a test — it was just slow enough to feel broken.
 */

import { config } from "./config"

const REACT_HOST_PREFIXES = ["__reactFiber$", "__reactProps$"]
const MAX_ELEMENTS_TO_SCAN = 128
const DEFAULT_TIMEOUT_MS = 10_000

function isEditorTree(element: Element): boolean {
  return (
    element.matches("[data-designlayer], #react-rewrite-root, nextjs-portal") ||
    Boolean(element.closest("[data-designlayer], #react-rewrite-root, nextjs-portal"))
  )
}

function hasReactHostMarker(element: Element): boolean {
  return Object.getOwnPropertyNames(element).some((name) =>
    REACT_HOST_PREFIXES.some((prefix) => name.startsWith(prefix))
  )
}

/**
 * Angular stamps `ng-version` on the element it bootstrapped into, once, at the
 * end of bootstrap — the same "this subtree is mine now" claim React's expando
 * makes, and it arrives at the same moment in the page's life.
 */
function hasAngularHostMarker(element: Element): boolean {
  return element.hasAttribute("ng-version")
}

function markerFor(framework: string): (element: Element) => boolean {
  return framework === "angular" ? hasAngularHostMarker : hasReactHostMarker
}

/**
 * The first host-owned element, breadth-first from `<html>`, or null while
 * nothing has been hydrated or client-rendered yet.
 */
export function findHostClaim(
  root: Document = document,
  framework: string = config.host.framework
): Element | null {
  const claimed = markerFor(framework)
  const queue: Element[] = [root.documentElement]

  for (let index = 0; index < queue.length && index < MAX_ELEMENTS_TO_SCAN; index += 1) {
    const element = queue[index]
    if (isEditorTree(element)) continue
    if (claimed(element)) return element
    // `<head>` itself is checked (App Router claims it with `<html>`), but not
    // its children: no framework mounts into them, and Vite or Emotion in dev
    // can put a hundred `<style>`s there — enough to spend the whole budget
    // before the scan reaches the app's container, which then stalled boot
    // for the full ten-second timeout.
    if (element !== root.head) queue.push(...element.children)
  }

  return null
}

/** True once a host-owned element has been hydrated or client-rendered. */
export function hasHydratedReactHost(
  root: Document = document,
  framework: string = config.host.framework
): boolean {
  return findHostClaim(root, framework) !== null
}

const NOT_MARKUP = new Set(["SCRIPT", "NOSCRIPT", "TEMPLATE", "STYLE", "LINK"])

/**
 * True when the page arrived with markup in `<body>` for a framework to take
 * over — the only kind of page that can hydrate.
 *
 * Read when this script evaluates, which is the end of `<body>`: everything the
 * server sent is parsed by then and nothing the app renders exists yet. A
 * client-rendered app ships an empty container (`<div id="root"></div>`); a
 * server-rendered one ships the page. A container holding a static spinner
 * reads as markup too, which only costs that page the slower, older path.
 */
export function hasServerMarkup(root: Document = document): boolean {
  for (const child of root.body?.children ?? []) {
    if (NOT_MARKUP.has(child.tagName) || isEditorTree(child)) continue
    if (child.firstElementChild || child.textContent?.trim()) return true
  }
  return false
}

function reactContainerKey(node: object): string | undefined {
  return Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactContainer$"))
}

/**
 * Whether React may still be hydrating the root that owns `claim`.
 *
 * `createRoot` and `hydrateRoot` both stamp their container with the root's
 * HostRoot fiber, and that root's state says whether it is still dehydrated.
 * The App Router hydrates the whole `document`, which can only mean hydration.
 * A claim with no container above it is not something this can vouch for, so
 * it answers yes and keeps the wait.
 */
export function mayBeHydrating(claim: Element, root: Document = document): boolean {
  if (reactContainerKey(root)) return true
  for (let node: Element | null = claim; node; node = node.parentElement) {
    const key = reactContainerKey(node)
    if (!key) continue
    const fiber = (node as unknown as Record<string, any>)[key]
    return fiber?.stateNode?.current?.memoizedState?.isDehydrated !== false
  }
  return true
}

function afterTwoPaints(resolve: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(resolve))
}

/**
 * Resolves once the host framework has claimed its markup and it is safe to
 * write on `<html>` and `<body>`.
 *
 * A server-rendered page waits two more paint turns after the claim: React can
 * hydrate it in parts, and an attribute written on `<html>` or chrome appended
 * to `<body>` while a part is still dehydrated is a mismatch React answers by
 * discarding the tree. Its claim also arrives without a DOM mutation — hydration
 * adopts nodes rather than inserting them — so it is found by checking once a
 * frame, as it always was. Angular keeps the same path.
 *
 * A client-rendered React root has nothing to hydrate. Its claim IS a mutation,
 * the commit inserting the app, so an observer hears it at the end of the very
 * task that committed — before the browser has styled, laid out or painted the
 * app — and the editor mounts right there. The app is then laid out once,
 * already inset, instead of full width first and again around the panels; and
 * nothing polls through the page's load, where a pending frame callback alone
 * made Chrome style and lay out the half-loaded document.
 *
 * The bounded fallback keeps the editor available if a framework changes its
 * private marker; by then the document has long since finished loading.
 */
export function whenHostHydrated(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const framework = config.host.framework
  const slow = framework === "angular" || hasServerMarkup()
  return new Promise((resolve) => {
    let observer: MutationObserver | null = null
    let timer = 0
    let settled = false
    const settle = (claim: Element | null) => {
      if (settled) return
      settled = true
      observer?.disconnect()
      clearTimeout(timer)
      if (claim && !slow && !mayBeHydrating(claim)) resolve()
      else afterTwoPaints(resolve)
    }
    const claim = findHostClaim(document, framework)
    if (claim) return settle(claim)

    if (slow) {
      const started = performance.now()
      const poll = () => {
        const found = findHostClaim(document, framework)
        if (found || performance.now() - started >= timeoutMs) settle(found)
        else requestAnimationFrame(poll)
      }
      requestAnimationFrame(poll)
      return
    }
    observer = new MutationObserver(() => {
      const found = findHostClaim(document, framework)
      if (found) settle(found)
    })
    observer.observe(document, { childList: true, subtree: true })
    timer = setTimeout(() => settle(null), timeoutMs) as unknown as number
  })
}
