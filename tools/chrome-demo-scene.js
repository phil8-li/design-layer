/**
 * The browser half of the chrome demo. Bundled — never run — by
 * `tools/chrome-demo.mjs`, once against the working tree and once against a
 * git worktree at an older revision, so the two bundles are each other's
 * before and after.
 *
 * Sibling of `tools/panel-harness-scene.js`, and the same argument applies: the
 * surfaces here are stood up by the SHIPPED installers over a context from the
 * shipped `createContext`, so what is rendered is what a user gets. The only
 * invented parts are the two things the editor takes from outside itself — a
 * bridge, and the loopback routes the chooser asks for.
 *
 * It must compile against BOTH revisions, which is the constraint that shapes
 * it: nothing here may import a module either revision lacks, and every call is
 * guarded so a signature that moved degrades to a labelled empty panel instead
 * of a blank page with an exception in the console.
 */

import { createContext } from "../src/core/context"
import { shellCss } from "../src/core/css"
import { el } from "../src/core/dom"
import { installAppChooser } from "../src/panels/app-chooser"
/*
 * The left panel is reached through its INSTALLER, never through the tab
 * modules, and that is what lets this one file compile against both revisions.
 *
 * The whole subject of the options comparison is that a third tab now exists —
 * so `src/panels/controls.ts` is present in one revision and absent in the
 * other, and a direct import of it would fail the before build outright. The
 * installer's signature has not moved, so asking it to build the panel gets
 * two tabs from one revision and three from the other, which is the difference
 * the panel is there to show.
 */
import { installLeftPanel } from "../src/panels/left"
/*
 * Same argument as the left panel: reached through its installer, which exists
 * unchanged in both revisions, so one scene file compiles against each.
 */
import { installInspector } from "../src/panels/inspector/index"

/** The canned loopback, installed before anything can ask. */
function stubFetch(scenario) {
  const answer = (body, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
  window.fetch = async (target) => {
    const url = new URL(String(target), "http://127.0.0.1:3456")
    if (url.pathname.endsWith("/apps")) {
      if (scenario.appsFail) throw new TypeError("Failed to fetch")
      return answer({ chooser: true, apps: scenario.apps ?? [] })
    }
    if (url.pathname.endsWith("/switch")) return answer({ ok: true })
    return answer({}, false, 404)
  }
}

/**
 * A bridge with nothing behind it.
 *
 * The chooser reads `store.hasChanges()` to decide whether a switch has
 * anything to lose — which is the whole of the new armed behavior — so that one
 * is driven from the scenario. Everything else is the smallest shape that lets
 * `createContext` build.
 */
function buildBridge(scenario) {
  return {
    elementInfo: () => null,
    send() {},
    toast() {},
    subscribe: () => () => {},
    store: {
      setActiveTool() {},
      hasChanges: () => Boolean(scenario.dirty),
      buildBatchOperations: () => [],
      onStateChange() {},
      getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
      viewportToPage: (x, y) => ({ x, y }),
      pageToViewport: (x, y) => ({ x, y }),
    },
  }
}

function mountSheet(theme) {
  const style = document.createElement("style")
  style.textContent = shellCss
  document.head.append(style)
  document.documentElement.setAttribute("data-de-theme", theme)
}

/**
 * Stand up one scenario and hand back the node to shoot.
 *
 * Returns `{ node, open }` rather than screenshotting here: the driver decides
 * when the menu is open, because opening it is an interaction whose result is
 * half of what these panels are comparing.
 */
export async function scene(scenario, theme) {
  mountSheet(theme)
  stubFetch(scenario)

  const host = el("div", { class: "de-panel de-panel--left" })
  host.style.cssText = "width:260px;position:relative"
  host.setAttribute("data-de-theme", theme)
  document.body.append(host)

  const slots = {
    overlay: el("div", { class: "de-overlay-layer" }),
    toolbar: el("div", { class: "de-toolbar" }),
    left: host,
    right: el("div", { class: "de-panel-body" }),
  }
  const editor = createContext(buildBridge(scenario), slots)

  let mounted
  try {
    mounted = installAppChooser(editor)
  } catch (error) {
    // A revision whose signature moved. Say so on the panel rather than
    // rendering a blank cell that reads as "nothing changed here".
    host.append(el("div", { style: "padding:12px;color:#ff8a65" }, [`did not mount: ${error.message}`]))
    return { node: host, open: async () => {} }
  }
  host.append(mounted.node)

  const trigger = host.querySelector(".de-app-chooser")
  return {
    node: host,
    async open() {
      trigger?.click()
      // The list is fetched on open; two frames is enough for the rows to land.
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)))
    },
  }
}

/**
 * The left panel, whole, so the tab strip can be compared across revisions.
 *
 * Mounted through `installLeftPanel` rather than by building the tabs here, for
 * the reason given on its import: the count and the labels of that strip ARE
 * the change, so they have to come from the revision under test.
 *
 * `openTab` presses a tab by its visible text rather than by index, because the
 * index of a given pane differs between the two revisions — which is the point
 * — and pressing the third tab in both would be comparing `Code` against
 * `Controls`.
 */
export async function leftPanel(scenario, theme) {
  mountSheet(theme)
  stubFetch(scenario)

  const host = el("div", { class: "de-panel de-panel--left" })
  host.style.cssText = "width:300px;height:520px;position:relative;display:flex;flex-direction:column"
  host.setAttribute("data-de-theme", theme)
  document.body.append(host)

  const slots = {
    overlay: el("div", { class: "de-overlay-layer" }),
    toolbar: el("div", { class: "de-toolbar" }),
    left: host,
    right: el("div", { class: "de-panel-body" }),
  }
  const editor = createContext(buildBridge(scenario), slots)

  try {
    installLeftPanel(editor)
  } catch (error) {
    host.append(
      el("div", { style: "padding:12px;color:#ff8a65" }, [`did not mount: ${error.message}`])
    )
    return { node: host, openTab: async () => {} }
  }

  return {
    node: host,
    async openTab(label) {
      const tab = [...host.querySelectorAll('[role="tab"]')].find(
        (node) => node.textContent.trim().toLowerCase() === label.toLowerCase()
      )
      // Absent is a RESULT here, not a failure: the before revision has no
      // Controls tab, and a panel showing two tabs is exactly what that column
      // is meant to show.
      tab?.click()
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 80)))
      return Boolean(tab)
    },
    tabs: () =>
      [...host.querySelectorAll('[role="tab"]')].map((node) => node.textContent.trim()),
  }
}

/**
 * The right panel over a selected element, for the spacing comparison.
 *
 * The fixture is a real DOM subtree with authored inline styles, because the
 * inspector reads its values off `getComputedStyle` — a mocked element reports
 * nothing and every section renders its empty state, which compares nothing.
 *
 * Deliberately smaller than `tools/panel-harness-scene.js`, which stands the
 * same panel up with a full fibre-resolution bridge for MEASURING it. All this
 * needs is a panel that renders, at two revisions, so the gaps can be looked at.
 */
export async function inspector(scenario, theme) {
  mountSheet(theme)
  stubFetch(scenario)

  const stage = el("div", {})
  stage.style.cssText = "position:fixed;left:-9999px;top:0;width:420px"
  const target = el("div", {})
  target.setAttribute(
    "style",
    [
      "display:flex", "flex-direction:row", "align-items:center", "gap:16px",
      "padding:20px 24px", "width:420px", "border-radius:16px",
      "background:#ffffff", "color:#0c1014", "font-size:14px",
    ].join(";")
  )
  target.append(el("span", {}, ["Pro plan"]), el("span", {}, ["$29"]))
  stage.append(target)
  document.body.append(stage)

  const host = el("div", { class: "de-panel de-panel--right" })
  host.style.cssText = `width:${scenario.panelWidth ?? 260}px;height:900px;position:relative;display:flex;flex-direction:column`
  host.setAttribute("data-de-theme", theme)
  document.body.append(host)

  const bridge = buildBridge(scenario)
  bridge.elementInfo = (node) =>
    node === target
      ? { tagName: "div", componentName: "PricingCard", filePath: "app/pricing/page.tsx", lineNumber: 18, columnNumber: 6, stack: [] }
      : null

  const slots = {
    overlay: el("div", { class: "de-overlay-layer" }),
    toolbar: el("div", { class: "de-toolbar" }),
    left: el("div", { class: "de-panel-body" }),
    right: host,
  }
  const editor = createContext(bridge, slots)
  try {
    installInspector(editor)
    editor.select(target)
  } catch (error) {
    host.append(el("div", { style: "padding:12px;color:#ff8a65" }, [`did not mount: ${error.message}`]))
    return { node: host, openSection: async () => {} }
  }
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 120)))

  return {
    node: host,
    /** Unfold a section by its visible title, so the stack can be compared open. */
    async openSection(title) {
      const header = [...host.querySelectorAll(".de-section-header, .de-section-title")].find(
        (node) => node.textContent.trim().toLowerCase().startsWith(title.toLowerCase())
      )
      const button = header?.closest("button") ?? header
      if (button && button.getAttribute("aria-expanded") === "false") button.click()
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100)))
    },
  }
}

// The driver calls these off the page, so they have to be reachable by name.
window.__demo = { scene, leftPanel, inspector }
