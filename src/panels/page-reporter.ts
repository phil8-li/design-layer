/**
 * The page this document is on, filed with the server under this app, and the
 * Mac app's tab told its name and page.
 *
 * Filed on every change and on the way out. An app that routes with pushState
 * fires no event for it, so a change is also looked for on a timer. Leaving by
 * any route — a reload, a typed address, a closed tab — files the page for the
 * next switch back to this app (`runtime/last-pages.mjs`).
 *
 * Only once the person has used the app itself. An app redirects on load —
 * from its root to its home, from a stale link to a default — and filing that
 * page wrote the app's shared home over the page the person had been working
 * on, so the next switch opened a page that looks like every other copy of the
 * template. Clicks and keys in the editor's own chrome do not count: they are
 * not a choice of page.
 *
 *   unused --pointer or key in the app--> used
 *   per page: unreported --change, 2 s poll, hashchange, popstate, pagehide, a switch--> reported
 *
 * It used to live inside the app chooser, which needed it only to file the
 * page at the moment a switch starts (`report`).
 */

import { config } from "../core/config"
import type { EditorContext } from "../core/context"
import { tellDesk } from "../shell/desk"

export interface PageReporter {
  /** Files the current page now, if the app has been used and the page is new. */
  report(): void
  destroy(): void
}

function currentPage(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

export function installPageReporter(context: EditorContext): PageReporter {
  let used = false
  const onUse = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest("[data-designlayer], [class^='de-'], [class*=' de-']")) return
    used = true
  }
  let reported = ""
  const reportPage = (beacon = false): void => {
    const page = currentPage()
    if (!used || !config.app.url || (page === reported && !beacon)) return
    reported = page
    const body = JSON.stringify({ appUrl: config.app.url, page })
    const url = `${context.apiBase}/apps/page`
    if (beacon && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))
      return
    }
    void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(
      () => {}
    )
  }
  // The Mac app names each tab from this, and reopens it on this page. Not
  // gated on use: a tab's name has to be right from the first paint.
  let told = ""
  const tellDeskPage = (): void => {
    const page = currentPage()
    if (page === told) return
    told = page
    tellDesk(config.app.name ?? null, page)
  }
  const onPageHide = (): void => reportPage(true)
  const onRouteChange = (): void => {
    reportPage()
    tellDeskPage()
  }
  const pageTimer = window.setInterval(onRouteChange, 2000)
  tellDeskPage()
  window.addEventListener("pointerdown", onUse, true)
  window.addEventListener("keydown", onUse, true)
  window.addEventListener("pagehide", onPageHide)
  window.addEventListener("hashchange", onRouteChange)
  window.addEventListener("popstate", onRouteChange)

  return {
    report: () => reportPage(),
    destroy() {
      window.removeEventListener("pagehide", onPageHide)
      window.removeEventListener("pointerdown", onUse, true)
      window.removeEventListener("keydown", onUse, true)
      window.removeEventListener("hashchange", onRouteChange)
      window.removeEventListener("popstate", onRouteChange)
      window.clearInterval(pageTimer)
    },
  }
}
