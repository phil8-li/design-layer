/**
 * The browser half of the foundations demo. Bundled — never run — by
 * `tools/foundations-demo.mjs`, once against the working tree and once against
 * the `.worktrees/foundations-before` checkout, so the two bundles are each
 * other's before and after.
 *
 * `boot` stands the editor up the way `src/index.ts` does — `mountShell`, then
 * the shipped installers over `createContext` — around a sample product page.
 * The only invented parts are the bridge (the vendored engine) and the page.
 * The loopback routes are answered by the driver, through Playwright routing.
 *
 * Every module is imported as a namespace and every call goes through `call`,
 * so an export one revision lacks is `undefined` at runtime rather than a build
 * error, and a scenario that needs it records why instead of throwing. A
 * missing FILE is handled by the driver's esbuild plugin, which resolves it to
 * an empty module.
 */

import * as Context from "../src/core/context"
import * as Css from "../src/core/css"
import * as Dom from "../src/core/dom"
import * as Shell from "../src/shell/shell"
import * as Toolbar from "../src/shell/toolbar"
import * as Left from "../src/panels/left"
import * as Inspector from "../src/panels/inspector/index"
import * as Canvas from "../src/canvas/index"
import * as Annotations from "../src/annotations/canvas"
import * as AnnotationStore from "../src/annotations/store"
import * as Journal from "../src/annotations/journal"
import * as Tooltip from "../src/core/tooltip"
import * as Toast from "../src/core/toast"
import * as TokenPicker from "../src/panels/inspector/token-picker"
import * as Shortcuts from "../src/shell/shortcuts"
import * as Commands from "../src/core/commands"
import * as LintMarkers from "../src/lint/markers"
import * as LintStore from "../src/lint/store"
import * as Icons from "../src/core/icons"

const SOURCE_FILE = "app/(shop)/products/[slug]/page.tsx"
const problems = []

/** Runs one installer or verb, recording rather than throwing when it is missing or fails. */
function call(name, fn, ...args) {
  if (typeof fn !== "function") {
    problems.push(`${name}: not exported by this revision`)
    return undefined
  }
  try {
    return fn(...args)
  } catch (error) {
    problems.push(`${name}: ${String(error && error.message ? error.message : error).slice(0, 160)}`)
    return undefined
  }
}

const frames = (n = 2) =>
  new Promise((resolve) => {
    const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step))
    step()
  })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------- the sample page ---------- */

/**
 * A product page to select in, built with `document.createElement` rather than
 * `el()`: `el()` stamps the chrome attribute, which would style the page as
 * chrome and hide it from the editor's own hit testing and layer tree.
 *
 * Every node carries `data-c`, the component it belongs to, which the bridge
 * turns into the source frames the inspector and the layer tree read.
 */
function buildProductPage() {
  const h = (tag, component, style, children = []) => {
    const node = document.createElement(tag)
    if (component) {
      node.dataset.c = component
      // A class per component, so a lint finding's selector has something to resolve to.
      node.className = component.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
    }
    if (style) node.setAttribute("style", style)
    for (const child of children) node.append(child)
    return node
  }
  const text = (tag, component, style, value) => {
    const node = h(tag, component, style)
    node.textContent = value
    return node
  }

  const nav = h("header", "SiteHeader", "display:flex;align-items:center;justify-content:space-between;padding:18px 40px;border-bottom:1px solid #e7e7ea;background:#fff", [
    text("strong", "Logo", "font-size:18px;letter-spacing:-0.2px;color:#111", "Northwind"),
    h("nav", "MainNav", "display:flex;gap:24px;font-size:14px;color:#555", [
      text("a", "NavLink", "color:inherit;text-decoration:none", "Shop"),
      text("a", "NavLink", "color:inherit;text-decoration:none", "Journal"),
      text("a", "NavLink", "color:inherit;text-decoration:none", "About"),
    ]),
    text("span", "CartButton", "font-size:14px;color:#111", "Cart (2)"),
  ])

  const gallery = h("div", "ProductGallery", "flex:1;min-width:0;aspect-ratio:1/1;max-width:520px;border-radius:20px;background:linear-gradient(145deg,#e8e4dc,#cfc6b6);display:flex;align-items:flex-end;padding:20px", [
    text("span", "Badge", "padding:4px 10px;border-radius:999px;background:#fff;font-size:12px;color:#333", "New season"),
  ])

  const title = text("h1", "ProductTitle", "margin:0;font-size:34px;line-height:40px;letter-spacing:-0.6px;color:#111;font-weight:600", "Linen overshirt")
  const price = text("p", "Price", "margin:0;font-size:20px;color:#333", "$128")
  const blurb = text("p", "ProductBlurb", "margin:0;font-size:15px;line-height:24px;color:#555;max-width:380px", "Garment-dyed European linen with a relaxed cut. Softens with every wash.")
  const sizes = h("div", "SizePicker", "display:flex;gap:8px", ["XS", "S", "M", "L", "XL"].map((s) =>
    text("span", "SizeChip", `width:40px;height:36px;display:inline-flex;align-items:center;justify-content:center;border-radius:10px;border:1px solid ${s === "M" ? "#111" : "#dcdce0"};font-size:13px;color:#111`, s)
  ))

  // The selected element: a flex container with its own text node AND a child,
  // so the Auto layout and Typography sections both render (see the note in
  // tools/panel-harness-scene.js on why both halves are load-bearing).
  const cta = document.createElement("button")
  cta.type = "button"
  cta.dataset.c = "AddToCartButton"
  cta.className = "add-to-cart-button"
  cta.textContent = "Add to bag"
  cta.setAttribute("style", [
    "display:inline-flex", "align-items:center", "justify-content:center", "gap:8px",
    "width:220px", "height:48px", "padding:12px 22px", "border:1px solid #1f3fb8",
    "border-radius:12px", "background:#2447d1", "box-shadow:0 2px 6px rgba(12,16,20,0.24)",
    "color:#fff", "font-family:ui-sans-serif, system-ui, sans-serif", "font-size:15px",
    "font-weight:500", "line-height:20px", "letter-spacing:0.2px", "cursor:pointer",
  ].join(";"))
  const arrow = document.createElement("span")
  arrow.textContent = "→"
  arrow.setAttribute("style", "display:inline-block;width:14px;height:14px;line-height:14px")
  cta.append(arrow)

  const details = h("div", "ProductDetails", "flex:1;min-width:0;display:flex;flex-direction:column;gap:18px;padding-top:12px", [
    title, price, blurb, sizes, cta,
  ])
  const hero = h("section", "ProductHero", "display:flex;gap:48px;padding:40px", [gallery, details])

  const card = (name, body) =>
    h("article", "FeatureCard", "flex:1;padding:20px;border-radius:16px;background:#f5f5f7", [
      text("h3", "FeatureTitle", "margin:0 0 6px;font-size:15px;color:#111", name),
      text("p", "FeatureBody", "margin:0;font-size:13px;line-height:20px;color:#666", body),
    ])
  const features = h("section", "FeatureGrid", "display:flex;gap:16px;padding:0 40px 40px", [
    card("Free returns", "Thirty days, no questions."),
    card("Carbon neutral", "Shipping offset by default."),
    card("Made to last", "Two-year repair guarantee."),
  ])

  const root = h("div", "ProductPage", "font-family:ui-sans-serif,system-ui,sans-serif;background:#fff;min-height:100vh", [nav, hero, features])
  root.id = "sample-app"
  return { root, target: cta, card: details }
}

/**
 * The vendored engine, as much of it as the chrome asks for. Mirrors the bridge
 * in `tools/panel-harness-scene.js`, widened to every node on the sample page
 * so the layer tree has names, and given the store stubs the toolbar reads.
 */
function buildBridge(page) {
  const lines = new WeakMap()
  let line = 10
  const frame = (node) => {
    if (!lines.has(node)) lines.set(node, (line += 2))
    return { componentName: node.dataset.c, filePath: SOURCE_FILE, lineNumber: lines.get(node), columnNumber: 6 }
  }
  const infoOf = (node) => {
    if (!(node instanceof HTMLElement) || !node.dataset || !node.dataset.c) return null
    const parent = node.parentElement && node.parentElement.closest("[data-c]")
    const stack = [frame(node)]
    if (parent) stack.push(frame(parent))
    return { tagName: node.tagName.toLowerCase(), ...frame(node), stack }
  }
  const listeners = new Set()
  return {
    version: 1,
    tokens: { colors: {}, shadows: {}, radii: {}, font: "" },
    send(message) {
      if (!message || message.type !== "getSiblings") return
      queueMicrotask(() => {
        const reply = { type: "siblingsList", siblings: [{ lineNumber: 20 }, { lineNumber: 24 }, { lineNumber: 28 }] }
        for (const listener of [...listeners]) listener(reply)
      })
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    elementInfo: infoOf,
    async elementSourceAsync(node) {
      return infoOf(node)
    },
    async discoverFile() {
      return SOURCE_FILE
    },
    async resolveSourceAt() {
      return null
    },
    hitTest: () => null,
    selectedElement: () => page.target,
    refreshGeometry() {},
    toast() {},
    root: () => page.root,
    store: {
      setActiveTool() {},
      hasChanges: () => false,
      buildBatchOperations: () => [],
      addPendingPropertyOperation() {},
      removePendingPropertyOperation() {},
      onStateChange() {},
      getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
      viewportToPage: (x, y) => ({ x, y }),
      pageToViewport: (x, y) => ({ x, y }),
    },
  }
}

/** Notes and edits, so the Changes tab has rows. Same seed as the panel harness. */
function seedOutbox(target) {
  const rect = target.getBoundingClientRect()
  const note = (comment, kind) =>
    call("addAnnotation", AnnotationStore.addAnnotation, {
      kind,
      comment,
      url: location.href,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      target: { selector: "button.add-to-bag", componentName: "AddToCartButton", tagName: "button", filePath: SOURCE_FILE, lineNumber: 24 },
      selectedText: null,
      element: target,
    })
  note("This button should use the primary action token, not a hand-rolled blue.", "element")
  note("Spacing between the size chips and the CTA looks tight at 390px.", "region")
  const edit = (property, from, to, written) =>
    call("recordEdit", Journal.recordEdit, { property, from, to, element: target, written })
  edit("padding", "16px", "12px 22px", true)
  edit("gap", "4px", "8px", false)
  edit("box-shadow", "none", "0 2px 6px rgba(12,16,20,0.24)", false)
}

/* ---------- the whole editor ---------- */

let editor = null
let page = null

/**
 * The real boot sequence from `src/index.ts`, minus the vendor wait and the
 * companion API. `seed` fills the outbox before the inspector mounts, so the
 * Changes tab is built with its list already populated.
 */
export async function boot(options = {}) {
  page = buildProductPage()
  document.body.append(page.root)
  if (options.seed) seedOutbox(page.target)

  call("installToaster", Toast.installToaster)
  const shell = call("mountShell", Shell.mountShell)
  if (!shell) return { problems }
  editor = call("createContext", Context.createContext, buildBridge(page), shell.slots)
  if (!editor) return { problems }
  call("installToolbar", Toolbar.installToolbar, editor)
  call("installLeftPanel", Left.installLeftPanel, editor)
  call("installInspector", Inspector.installInspector, editor)
  call("installCanvas", Canvas.installCanvas, editor)
  call("installAnnotations", Annotations.installAnnotations, editor)
  call("installLintMarkers", LintMarkers.installLintMarkers, editor)
  call("installShortcuts", Shortcuts.installShortcuts, editor)
  call("installTooltips", Tooltip.installTooltips)
  if (options.select !== false) call("select", editor.select, page.target)
  // The shell mounts at the end of its own exit and plays it backwards; the
  // driver runs with reduced motion, so this only has to outlast the two frames.
  await frames(3)
  await wait(400)
  return { problems }
}

/** Press a tab by its visible label, in whichever panel has it. */
export async function openTab(label, panelSelector = ".de-root") {
  const scope = document.querySelector(panelSelector) || document
  const tab = [...scope.querySelectorAll('[role="tab"]')].find(
    (node) => node.textContent.trim().toLowerCase() === label.toLowerCase()
  )
  if (!tab) return false
  tab.click()
  await frames(2)
  await wait(150)
  return true
}

/** Fold every open section except the named ones, so a crop stays readable. */
export function tabs(panelSelector) {
  const scope = document.querySelector(panelSelector)
  return scope ? [...scope.querySelectorAll('[role="tab"]')].map((n) => n.textContent.trim()) : []
}

export async function setMode(mode) {
  if (!editor) return false
  call("setMode", editor.setMode, mode)
  await frames(2)
  await wait(120)
  return true
}

export async function toast(message, kind, actionLabel) {
  const action = actionLabel ? { label: actionLabel, onClick() {} } : undefined
  call("notify", Toast.notify, message, kind, action)
  await frames(2)
}

/** Open a section's saved-styles panel by the section title. */
export async function openStyles(title) {
  for (const toggle of document.querySelectorAll(".de-style-toggle")) {
    const section = toggle.closest(".de-section")
    const name = section && section.querySelector(".de-section-title")
    if (!name || name.textContent.trim().toLowerCase() !== title.toLowerCase()) continue
    toggle.click()
    await frames(2)
    section.scrollIntoView({ block: "start" })
    await frames(2)
    return true
  }
  return false
}

/**
 * A docked panel's box, cut off below its last visible content.
 *
 * The panels run the full window height, so a short tab would otherwise be
 * shot with half a screen of empty ground under it. Width and top stay the
 * panel's own, so its edge hairline stays in frame.
 */
export function panelBox(selector) {
  const panel = document.querySelector(selector)
  if (!panel) return null
  const outer = panel.getBoundingClientRect()
  let bottom = outer.top
  for (const node of panel.querySelectorAll("*")) {
    if (node.closest("[hidden]")) continue
    const box = node.getBoundingClientRect()
    // Stretched containers (the pane, its scroller) span the panel whatever
    // they hold, so only boxes shorter than most of the panel count.
    if (box.width > 0 && box.height > 0 && box.height < outer.height * 0.75) {
      bottom = Math.max(bottom, box.bottom)
    }
  }
  bottom = Math.min(bottom, outer.bottom)
  return { x: outer.left, y: outer.top, width: outer.width, height: bottom - outer.top }
}

/** Open the keyboard shortcut sheet through its registered command, as `?` does. */
export async function shortcutSheet() {
  const ran = call("runCommand", Commands.runCommand, "help.shortcuts")
  await frames(2)
  await wait(200)
  return Boolean(ran)
}

/** Put the audit markers on the canvas rather than the note pins. */
export async function showLintMarkers() {
  call("setMarkersShown", LintStore.setMarkersShown, true)
  await frames(3)
  await wait(150)
}

/** Press a button by its visible text, inside `scopeSelector`. */
export async function pressButton(text, scopeSelector = ".de-root") {
  const scope = document.querySelector(scopeSelector) || document
  const button = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent.trim().toLowerCase() === text.toLowerCase() && !node.closest("[hidden]")
  )
  if (!button) return false
  button.click()
  await frames(2)
  return true
}

/* ---------- surfaces with no home in the booted editor ---------- */

function mountSheet(theme) {
  const style = document.createElement("style")
  style.textContent = Css.shellCss || ""
  document.head.append(style)
  document.documentElement.setAttribute("data-de-theme", theme)
}

/**
 * The token picker, open, on a field in a panel-shaped host.
 *
 * Stood up bare rather than inside the booted inspector, because the rows that
 * carry a token field only render once a design-system catalog is configured —
 * and the picker is what this row is about, not the catalog.
 */
export async function tokenPicker(theme) {
  mountSheet(theme)
  if (typeof TokenPicker.tokenField !== "function") {
    problems.push("tokenField: not exported by this revision")
    return { problems }
  }
  const swatch = (css) => ({ kind: "color", css })
  const choice = (group, leaf, css) => ({
    id: `${group}/${leaf}`, group, leaf, name: `${group}/${leaf}`, preview: swatch(css), detail: "", disabled: false,
  })
  const choices = [
    choice("Background", "Default", "#ffffff"),
    choice("Background", "Subtle", "#f5f5f7"),
    choice("Background", "Inverse", "#111111"),
    choice("Brand", "Primary", "#2447d1"),
    choice("Brand", "Primary hover", "#1f3fb8"),
    choice("Brand", "On primary", "#ffffff"),
    choice("Text", "Default", "#111111"),
    choice("Text", "Muted", "#555555"),
    choice("Border", "Default", "#dcdce0"),
  ]
  const host = Dom.el("aside", { class: "de-panel de-panel--right", "data-de-theme": theme })
  host.style.cssText = "position:fixed;left:24px;top:24px;width:260px;height:auto"
  const body = Dom.el("div", { class: "de-panel-body" })
  body.style.cssText = "padding:12px"
  const field = call("tokenField", TokenPicker.tokenField, {
    id: "demo-fill",
    title: "Fill",
    choices,
    selectedId: "Brand/Primary",
    fallback: { preview: swatch("#2447d1"), text: "#2447D1" },
    onCommit() {},
    custom: { placeholder: "#000000", onCommit() {} },
  })
  if (!field) return { problems }
  body.append(field)
  host.append(body)
  document.body.append(host)
  await frames(2)
  field.click()
  await frames(2)
  await wait(120)
  return { problems }
}

/**
 * Every glyph the chrome can draw, at the two rungs most of them are drawn at
 * (16 and 12), on the panel ground in the current theme, in full ink.
 */
export async function iconSheet(theme) {
  mountSheet(theme)
  const names = Icons.ICON_NAMES ?? []
  if (!names.length || typeof Icons.icon !== "function") {
    problems.push("icons: no ICON_NAMES/icon export in this revision")
    return { problems }
  }
  const sheet = document.createElement("div")
  sheet.className = "de-demo-icons"
  sheet.setAttribute("data-designlayer", "")
  sheet.style.cssText =
    "position:fixed;left:16px;top:16px;display:grid;grid-template-columns:repeat(10,64px);gap:4px;" +
    "padding:12px;border-radius:12px;background:var(--de-color-bg);color:var(--de-color-text);" +
    "font:10px/1.2 -apple-system,system-ui,sans-serif"
  for (const name of names) {
    const cell = document.createElement("div")
    cell.style.cssText = "display:grid;justify-items:center;gap:4px;padding:6px 0"
    const row = document.createElement("div")
    row.style.cssText = "display:flex;align-items:center;gap:8px;height:16px"
    for (const size of [16, 12]) {
      try { row.append(Icons.icon(name, size)) } catch { /* a size this revision does not draw */ }
    }
    const label = document.createElement("span")
    label.textContent = name.length > 11 ? `${name.slice(0, 10)}…` : name
    label.style.cssText = "opacity:.6;max-width:62px;overflow:hidden;white-space:nowrap"
    cell.append(row, label)
    sheet.append(cell)
  }
  document.body.append(sheet)
  return { problems }
}

window.__demo = { iconSheet, boot, panelBox, shortcutSheet, showLintMarkers, pressButton, openTab, tabs, setMode, toast, openStyles, tokenPicker, problems }
