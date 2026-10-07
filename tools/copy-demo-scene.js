/**
 * The browser half of the copy demo. Bundled — never run — by
 * `tools/copy-demo.mjs`, once against `.worktrees/copy-before/` and once against
 * `.worktrees/copy-after/`, so the two bundles are each other's before and
 * after. The copy of this file inside each tree imports `../src/...`, which is
 * how one scene resolves to two revisions without an alias.
 *
 * Same contract as `chrome-demo-scene.js`: every surface is stood up by the
 * shipped installers over the shipped `createContext`. The invented parts are
 * a bridge, the loopback routes, and a page to select in.
 */

import { recordEdit } from "../src/annotations/journal"
import { addAnnotation } from "../src/annotations/store"
import { runCommand } from "../src/core/commands"
import { createContext } from "../src/core/context"
import { shellCss } from "../src/core/css"
import { el } from "../src/core/dom"
import { installAppChooser } from "../src/panels/app-chooser"
import { installInspector } from "../src/panels/inspector/index"
import { installLeftPanel } from "../src/panels/left"
import { installShortcuts } from "../src/shell/shortcuts"

const SOURCE_FILE = "app/pricing/page.tsx"
const settle = (ms = 120) =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, ms)))

function stubFetch() {
  const answer = (body, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
  window.fetch = async (target) => {
    const url = new URL(String(target), "http://127.0.0.1:3456")
    const p = url.pathname
    if (p.endsWith("/apps")) return answer({ chooser: true, apps: [] })
    if (p.endsWith("/mcp/status"))
      return answer({ url: "http://127.0.0.1:5747/mcp", listening: true, agents: 1, waiting: 0 })
    if (p.endsWith("/lint/tools"))
      return answer({
        tools: [
          { id: "stylelint", name: "Stylelint", available: true, reason: "", configFile: ".stylelintrc.json" },
          { id: "shadcn", name: "shadcn/lint", available: false, reason: "Not installed.", configFile: null },
        ],
      })
    if (p.includes("lint")) return answer({ findings: [] })
    if (p.includes("librar")) return answer({ libraries: [], candidates: [] })
    return answer({}, false, 404)
  }
}

function mountSheet(theme) {
  const style = document.createElement("style")
  style.textContent = shellCss
  document.head.append(style)
  document.documentElement.setAttribute("data-de-theme", theme)
}

/** A plain element that is NOT chrome (no `el()`), so the inspector treats it as the app. */
function fixture() {
  const stage = document.createElement("div")
  stage.style.cssText = "position:fixed;left:-9999px;top:0;width:480px"
  const card = document.createElement("section")
  card.setAttribute(
    "style",
    "display:flex;align-items:center;gap:16px;padding:20px 24px;width:420px;border-radius:16px;background:#fff;color:#0c1014;font-size:14px"
  )
  const para = document.createElement("p")
  para.textContent = "Start your free trial today."
  para.setAttribute("style", "display:block;margin:0;font-size:14px;line-height:20px;color:#0c1014")
  const button = document.createElement("button")
  button.textContent = "Start free trial"
  button.setAttribute(
    "style",
    "display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:12px;background:#2f56c4;color:#fff;border:1px solid #2f56c4"
  )
  button.append(document.createElement("span"))
  card.append(para, button)
  stage.append(card)
  document.body.append(stage)
  return { stage, card, para, button }
}

function bridgeFor(nodes) {
  const info = new Map()
  const frame = (componentName, lineNumber, tagName) => ({
    tagName,
    componentName,
    filePath: SOURCE_FILE,
    lineNumber,
    columnNumber: 6,
    stack: [],
  })
  if (nodes) {
    info.set(nodes.card, frame("PricingCard", 18, "section"))
    info.set(nodes.para, frame("PricingCard", 20, "p"))
    info.set(nodes.button, frame("TrialButton", 24, "button"))
  }
  return {
    version: 1,
    tokens: { colors: {}, shadows: {}, radii: {}, font: "" },
    elementInfo: (node) => info.get(node) ?? null,
    async elementSourceAsync(node) {
      return info.get(node) ?? null
    },
    async discoverFile() {
      return SOURCE_FILE
    },
    async resolveSourceAt() {
      return null
    },
    send() {},
    toast() {},
    subscribe: () => () => {},
    hitTest: () => null,
    refreshGeometry() {},
    root: () => nodes?.stage ?? document.body,
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
}

function panel(side, theme, width, height) {
  const host = el("div", { class: `de-panel de-panel--${side}` })
  host.style.cssText = `width:${width}px;height:${height}px;position:relative;display:flex;flex-direction:column`
  host.setAttribute("data-de-theme", theme)
  document.body.append(host)
  return host
}

function contextFor(nodes, slots) {
  return createContext(bridgeFor(nodes), {
    overlay: el("div", { class: "de-overlay-layer" }),
    toolbar: el("div", { class: "de-toolbar" }),
    left: slots.left ?? el("div", { class: "de-panel-body" }),
    right: slots.right ?? el("div", { class: "de-panel-body" }),
  })
}

async function pressTab(host, label) {
  const tab = [...host.querySelectorAll('[role="tab"]')].find(
    (node) => node.textContent.trim().toLowerCase() === label.toLowerCase()
  )
  tab?.click()
  await settle(150)
  return Boolean(tab)
}

function seed(target) {
  const rect = target.getBoundingClientRect()
  const at = (comment, kind) =>
    addAnnotation({
      kind,
      comment,
      url: location.href,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      target: {
        selector: "section.pricing-card",
        componentName: "PricingCard",
        tagName: "section",
        filePath: SOURCE_FILE,
        lineNumber: 18,
      },
      selectedText: null,
      element: target,
    })
  at("Use the elevated surface token here, not a hand-rolled shadow.", "element")
  recordEdit({ property: "padding", from: "16px", to: "20px 24px", element: target, written: true })
  recordEdit({ property: "gap", from: "8px", to: "16px", element: target, written: false })
}

function expandAll(host) {
  for (const toggle of host.querySelectorAll('[aria-expanded="false"]')) {
    if (!toggle.closest("[hidden]")) toggle.click()
  }
}

const SCENES = {
  async designEmpty(theme) {
    mountSheet(theme)
    stubFetch()
    const host = panel("right", theme, 260, 320)
    installInspector(contextFor(null, { right: host }))
    await settle()
    return host
  },

  async typography(theme) {
    mountSheet(theme)
    stubFetch()
    const nodes = fixture()
    const host = panel("right", theme, 260, 1600)
    const editor = contextFor(nodes, { right: host })
    installInspector(editor)
    editor.select(nodes.para)
    await settle(250)
    return host
  },

  async changes(theme) {
    mountSheet(theme)
    stubFetch()
    const nodes = fixture()
    const host = panel("right", theme, 260, 900)
    const editor = contextFor(nodes, { right: host })
    seed(nodes.card)
    installInspector(editor)
    await pressTab(host, "Changes")
    expandAll(host)
    await settle(300)
    return host
  },

  async designSystem(theme) {
    mountSheet(theme)
    stubFetch()
    const host = panel("right", theme, 260, 620)
    installInspector(contextFor(null, { right: host }))
    await pressTab(host, "Design system")
    await settle(400)
    return host
  },

  async layersEmpty(theme) {
    mountSheet(theme)
    stubFetch()
    const host = panel("left", theme, 260, 260)
    installLeftPanel(contextFor(null, { left: host }))
    await pressTab(host, "Layers")
    return host
  },

  async codeEmpty(theme) {
    mountSheet(theme)
    stubFetch()
    const host = panel("left", theme, 260, 260)
    installLeftPanel(contextFor(null, { left: host }))
    await pressTab(host, "Code")
    return host
  },

  async controlsEmpty(theme) {
    mountSheet(theme)
    stubFetch()
    const host = panel("left", theme, 260, 300)
    installLeftPanel(contextFor(null, { left: host }))
    await pressTab(host, "Controls")
    return host
  },

  async chooserEmpty(theme) {
    mountSheet(theme)
    stubFetch()
    const host = panel("left", theme, 280, 260)
    const mounted = installAppChooser(contextFor(null, { left: host }))
    host.append(mounted.node)
    host.querySelector(".de-app-chooser")?.click()
    await settle(200)
    return host
  },

  async shortcuts(theme) {
    mountSheet(theme)
    stubFetch()
    const host = panel("left", theme, 10, 10)
    const right = panel("right", theme, 10, 10)
    host.style.position = right.style.position = "absolute"
    host.style.left = right.style.left = "-9999px"
    const editor = contextFor(null, { left: host, right })
    installLeftPanel(editor)
    installInspector(editor)
    installShortcuts(editor)
    runCommand("help.shortcuts")
    await settle(500)
    const sheet = document.querySelector("dialog.de-shortcuts")
    if (sheet) sheet.style.animation = "none"
    return sheet ?? host
  },
}

window.__copy = {
  async run(name, theme) {
    const node = await SCENES[name](theme)
    node.setAttribute("data-copy-shot", "")
    return true
  },
}
