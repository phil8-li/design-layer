/**
 * The browser half of the panel harness. Bundled — never run — by
 * `tools/panel-harness.mjs`, which inlines the IIFE into `.harness/panel.html`.
 *
 * WHY A REAL PAGE RATHER THAN A SERIALIZED SNAPSHOT
 *
 * Every number a Figma comparison cares about is a *used* value: the height a
 * 24px row actually resolves to, what `color-mix()` computes the field well to,
 * where a `1fr 1fr` grid puts the second column at 260px. JSDOM has no layout
 * and no `color-mix`, so a snapshot taken there can only report what the
 * stylesheet says, which is the thing under test. So the panel is built in a
 * real Chromium, from the real modules, over a real selected element — and the
 * measurements come out of `getBoundingClientRect` and `getComputedStyle`.
 *
 * Nothing here re-implements a control. The panel is stood up by the shipped
 * `installInspector` over a context from the shipped `createContext`, so the
 * tab strip, the section order, and every field are the ones a user sees. The
 * only invented parts are the two things the editor gets from outside itself:
 * a bridge (the vendored React Rewrite engine) and a page to select in.
 */

import { recordEdit } from "../src/annotations/journal"
import { addAnnotation } from "../src/annotations/store"
import { createContext } from "../src/core/context"
import { shellCss } from "../src/core/css"
import { el } from "../src/core/dom"
import { tokens } from "../src/core/tokens"
import { installInspector } from "../src/panels/inspector/index"

const SOURCE_FILE = "app/(marketing)/pricing/page.tsx"

/**
 * Seed the outbox so the Changes tab has something to be.
 *
 * An empty Changes tab is one sentence and a button, which measures nothing:
 * the rows, their badges, the index discs and the action column only exist once
 * there is something owed. Both KINDS are seeded because they render
 * differently — a note is prose the designer typed, an edit is a property the
 * writer spelled — and the tab's whole job is to show them as one list.
 *
 * Three edit states as well, because the badge is the control most likely to
 * drift: one already in the files, one the writer can spell but has not
 * committed, and one it cannot express at all.
 */
function seedOutbox(target) {
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
        lineNumber: 24,
      },
      selectedText: null,
      element: target,
    })

  at("This card should use the elevated surface token, not a hand-rolled shadow.", "element")
  at("Spacing between the price and the CTA looks tight at 390px.", "region")

  recordEdit({ property: "padding", from: "16px", to: "20px 24px", element: target, written: true })
  recordEdit({ property: "gap", from: "8px", to: "16px", element: target, written: false })
  recordEdit({
    property: "box-shadow",
    from: "none",
    to: "0 8px 30px rgba(0,0,0,0.4)",
    element: target,
    written: false,
  })
}

/**
 * A page to select in.
 *
 * Deliberately built with `document.createElement` rather than `el()`: `el()`
 * stamps `data-designlayer`, which is what every rule in `shellCss` is scoped
 * under, so a fixture built with it would be styled as chrome and would also be
 * skipped by the editor's own hit filtering.
 *
 * The styles are inline and specific on purpose. Each section below reads the
 * element's *computed* style to decide what to draw and what to put in the
 * fields, so a bare `<button>` renders a Typography section full of browser
 * defaults and no Stroke or Effects section at all. This element is written to
 * be the "typical selected element" the harness is supposed to show: a padded,
 * rounded, bordered, shadowed, text-bearing box inside a flex row.
 */
function buildFixture() {
  const root = document.createElement("div")
  root.id = "harness-app"
  root.setAttribute("style", "padding:40px;font-family:ui-sans-serif,system-ui,sans-serif")

  const card = document.createElement("section")
  card.setAttribute(
    "style",
    [
      "display:flex",
      "flex-direction:row",
      "align-items:center",
      "justify-content:flex-start",
      "gap:16px",
      "padding:20px 24px",
      "width:420px",
      "border-radius:16px",
      "background:#ffffff",
      "box-shadow:0 8px 30px rgba(0,0,0,0.10)",
    ].join(";")
  )

  const heading = document.createElement("h2")
  heading.textContent = "Pro plan"
  heading.setAttribute("style", "margin:0;font-size:18px;font-weight:600;color:#0c1014")

  const target = document.createElement("button")
  target.type = "button"
  target.textContent = "Start free trial"
  target.setAttribute(
    "style",
    [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "gap:8px",
      "width:168px",
      "height:40px",
      "padding:10px 18px",
      "border:1px solid #2f56c4",
      "border-radius:12px",
      "background:#2f56c4",
      "box-shadow:0 2px 6px rgba(12,16,20,0.24)",
      "color:#ffffff",
      "font-family:ui-sans-serif, system-ui, sans-serif",
      "font-size:14px",
      "font-weight:500",
      "line-height:20px",
      "letter-spacing:0.2px",
      "text-align:center",
      "opacity:1",
    ].join(";")
  )

  /*
   * The button is a flex container with a child AND its own text node, and both
   * halves are load-bearing. `autoLayoutSection` returns null for an element
   * with no element children, so without the chevron there is no Auto layout
   * group — no direction row, no 3x3 pad, no gap or padding controls.
   * `typographySection` returns null unless the element has a direct TEXT node,
   * so moving the label into a span would delete the Typography section
   * instead. A real button with an icon after its label is both at once.
   */
  const chevron = document.createElement("span")
  chevron.textContent = "→"
  chevron.setAttribute("style", "display:inline-block;width:12px;height:12px;line-height:12px")

  target.append(chevron)
  card.append(heading, target)
  root.append(card)
  return { root, card, target }
}

/**
 * The vendored engine, as much of it as the inspector actually asks for.
 *
 * `elementInfo` is the load-bearing one: it is how a DOM node becomes a JSX
 * line, and without it the Position section has no parent to align against and
 * no siblings to arrange among. `send`/`subscribe` carry exactly one exchange
 * here — `getSiblings` -> `siblingsList` — answered on a microtask so the
 * section takes the same "ask, re-render, read the memo" path it takes live.
 */
function buildBridge(nodes) {
  const info = new Map()
  const frame = (componentName, lineNumber) => ({
    componentName,
    filePath: SOURCE_FILE,
    lineNumber,
    columnNumber: 6,
  })
  info.set(nodes.card, {
    tagName: "section",
    ...frame("PricingCard", 18),
    stack: [frame("PricingCard", 18), frame("PricingPage", 9)],
  })
  info.set(nodes.target, {
    tagName: "button",
    ...frame("TrialButton", 24),
    stack: [frame("TrialButton", 24), frame("PricingCard", 18)],
  })

  const listeners = new Set()
  const sent = []

  return {
    version: 1,
    tokens: { colors: {}, shadows: {}, radii: {}, font: "" },
    sent,
    send(message) {
      sent.push(message)
      if (!message || message.type !== "getSiblings") return
      queueMicrotask(() => {
        // Three children around the selection, so arrange offers forward and
        // backward rather than drawing four disabled buttons.
        const reply = {
          type: "siblingsList",
          siblings: [{ lineNumber: 20 }, { lineNumber: 24 }, { lineNumber: 28 }],
        }
        for (const listener of [...listeners]) listener(reply)
      })
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    elementInfo(node) {
      return info.get(node) ?? null
    },
    async elementSourceAsync(node) {
      return info.get(node) ?? null
    },
    async discoverFile() {
      return SOURCE_FILE
    },
    async resolveSourceAt() {
      return null
    },
    hitTest: () => null,
    selectedElement: () => nodes.target,
    refreshGeometry() {},
    toast() {},
    root: () => nodes.root,
  }
}

/**
 * Stands the panel up and returns the handles the Node side drives it by.
 *
 * Returns rather than assigns so the page's own bootstrap decides what to hang
 * on `window`; the harness page keeps it all under one `__panelHarness`.
 */
export function mount(options = {}) {
  const theme = options.theme === "light" ? "light" : "dark"

  const style = document.createElement("style")
  style.id = "designlayer-harness-style"
  style.textContent = shellCss
  document.head.append(style)

  // Both selectors the palette is declared on, exactly as `applyTheme` in
  // `shell/toolbar.ts` writes them.
  document.documentElement.setAttribute("data-de-theme", theme)

  const fixture = buildFixture()

  const rail = document.createElement("div")
  rail.id = "harness-rail"
  rail.setAttribute("style", "display:flex;align-items:stretch;height:100vh;overflow:hidden")

  const stage = document.createElement("div")
  stage.id = "harness-stage"
  stage.setAttribute("style", "flex:1;min-width:0;overflow:auto;background:#f6f7f9")
  stage.append(fixture.root)

  // The same two nodes `shell/shell.ts` builds for the right panel, with the
  // same classes, so the width, the hairline and the tab-strip layout are the
  // shipped ones rather than something this file decided.
  const right = el("div", { class: "de-panel-body" })
  const rightPanel = el("aside", { class: "de-panel de-panel--right", "aria-label": "Inspector" }, [
    right,
  ])
  rightPanel.id = "harness-panel"
  rightPanel.setAttribute("data-de-theme", theme)

  rail.append(stage, rightPanel)
  document.body.append(rail)

  const bridge = buildBridge(fixture)
  const slots = {
    overlay: el("div", { class: "de-overlay-layer" }),
    toolbar: el("div", { class: "de-toolbar" }),
    left: el("div", { class: "de-panel-body" }),
    right,
  }
  const editor = createContext(bridge, slots)

  // Seeded BEFORE the inspector mounts, so the Changes tab is built with its
  // list already populated rather than repainted into by a later announce —
  // which is the state a screenshot should show and the one a count is read
  // from.
  seedOutbox(fixture.target)

  installInspector(editor)
  editor.select(fixture.target)

  /**
   * Switch tabs the way a user does: by pressing the tab.
   *
   * The panes stay mounted when hidden (the code view's scroll position is the
   * reason), so reaching in and clearing `hidden` would show a pane that had
   * never been told to update — `activate()` in `panels/inspector/index.ts` is
   * what repaints the tab you switch TO, and only that one.
   */
  const showTab = (label) => {
    for (const tab of rightPanel.querySelectorAll(".de-tab")) {
      if ((tab.textContent ?? "").trim().toLowerCase() !== label.toLowerCase()) continue
      tab.click()
      return true
    }
    return false
  }

  /**
   * Open every collapsed disclosure in the visible pane.
   *
   * The Changes tab keeps Settings folded by default, which is right for the
   * product and useless for a screenshot: the switches, the swatch row and the
   * checkboxes are the half of the tab most in need of measuring, and folded
   * they report 0x0 like any hidden node. Pressed rather than un-hidden, for
   * the same reason `collapse()` presses: the open state lives in the module,
   * not in the attribute.
   */
  const expandAll = () => {
    const opened = []
    for (const toggle of rightPanel.querySelectorAll('[aria-expanded="false"]')) {
      if (toggle.closest("[hidden]")) continue
      toggle.click()
      opened.push((toggle.textContent ?? "").trim() || toggle.getAttribute("aria-label") || "?")
    }
    return opened
  }

  const applyTheme = (next) => {
    const value = next === "light" ? "light" : "dark"
    document.documentElement.setAttribute("data-de-theme", value)
    rightPanel.setAttribute("data-de-theme", value)
    stage.style.background = value === "light" ? "#f6f7f9" : "#20242b"
    return value
  }

  /** Tall enough that the whole panel is on screen with nothing scrolled off. */
  const contentHeight = () => {
    const strip = rightPanel.querySelector(".de-tabs")
    const pane = rightPanel.querySelector(".de-tabpanel:not([hidden])")
    const stripHeight = strip ? strip.getBoundingClientRect().height : 0
    const paneHeight = pane ? pane.scrollHeight : 0
    return Math.ceil(stripHeight + paneHeight) + 2
  }

  /**
   * A section's title, read off the header rather than off the fold button.
   *
   * The button holds no text: the chevron sits on the trailing edge now, so the
   * title is a `.de-section-title` span beside it and the button is an empty
   * layer under the whole bar. `aria-label` is the fallback because that is
   * where the button's accessible name went when its text left.
   */
  const titleOf = (toggle) =>
    (
      toggle.parentElement?.querySelector(".de-section-title")?.textContent ??
      toggle.getAttribute("aria-label") ??
      ""
    ).trim()

  /**
   * Folds sections by title, by pressing their own headers.
   *
   * A real click rather than a `hidden` flag: `section()` in `field.ts` keeps
   * collapse state in a panel-level Map and toggles the header's classes and
   * `aria-expanded` with it, so anything else would produce a folded body under
   * an unfolded header — a state the shipped panel cannot be in.
   */
  const collapse = (titles) => {
    const wanted = new Set(titles.map((title) => title.toLowerCase()))
    const folded = []
    for (const toggle of rightPanel.querySelectorAll(".de-section-toggle")) {
      const title = titleOf(toggle)
      if (!wanted.has(title.toLowerCase())) continue
      if (toggle.getAttribute("aria-expanded") === "true") toggle.click()
      folded.push(title)
    }
    return folded
  }

  return {
    panel: rightPanel,
    editor,
    applyTheme,
    collapse,
    contentHeight,
    showTab,
    expandAll,
    inspectorWidth: tokens.size.inspectorWidth,
    sectionTitles: () => [...rightPanel.querySelectorAll(".de-section-toggle")].map(titleOf),
  }
}

/**
 * Every element in the panel, with its box and the computed values a Figma
 * comparison is settled by.
 *
 * Walks with `querySelectorAll("*")` rather than by section so nothing is
 * missed, keeps SVG nodes (the icon sizes are half the question), and records
 * the *used* values — `width`/`height` from `getComputedStyle` are resolved
 * pixels in Chromium, and `backgroundColor` has already had `color-mix()`
 * evaluated. Boxes are given twice: viewport-absolute, and relative to the
 * panel's own top-left, which is the frame a Figma artboard is measured in.
 */
export function measure(panel) {
  const origin = panel.getBoundingClientRect()
  const rows = []

  const path = (node) => {
    const steps = []
    for (let step = node; step && step !== panel; step = step.parentElement) {
      const parent = step.parentElement
      if (!parent) break
      steps.unshift([...parent.children].indexOf(step))
    }
    return steps
  }

  const record = (node) => {
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const own = [...node.childNodes]
      .filter((child) => child.nodeType === 3)
      .map((child) => (child.textContent ?? "").trim())
      .join(" ")
      .trim()

    rows.push({
      path: path(node),
      tag: node.tagName.toLowerCase(),
      /*
       * The hidden tab panes are walked too — they are real DOM and their
       * scroll position is the reason they stay mounted — but a node inside one
       * measures 0x0, which would read as a broken control rather than as an
       * off-screen one. Both flags are here so a consumer can filter rather
       * than guess from a zero.
       */
      visible: box.width > 0 && box.height > 0,
      within: {
        tool: within(node, ".de-tool"),
        mini: within(node, ".de-mini"),
        field: within(node, ".de-field"),
        segmented: within(node, ".de-segmented"),
        tab: within(node, ".de-tab"),
        sectionHeader: within(node, ".de-section-header"),
        hiddenPane: within(node, "[hidden]"),
      },
      classes: node.getAttribute("class") ? node.getAttribute("class").split(/\s+/) : [],
      text: own.slice(0, 60),
      attrs: {
        type: node.getAttribute("type"),
        role: node.getAttribute("role"),
        title: node.getAttribute("title"),
        ariaLabel: node.getAttribute("aria-label"),
        ariaPressed: node.getAttribute("aria-pressed"),
        ariaSelected: node.getAttribute("aria-selected"),
        ariaExpanded: node.getAttribute("aria-expanded"),
        disabled: node.hasAttribute("disabled") ? "" : null,
        hidden: node.hasAttribute("hidden") ? "" : null,
        placeholder: node.getAttribute("placeholder"),
        value: node.tagName === "INPUT" ? node.value : null,
        svgWidth: node.tagName.toLowerCase() === "svg" ? node.getAttribute("width") : null,
        svgHeight: node.tagName.toLowerCase() === "svg" ? node.getAttribute("height") : null,
        strokeWidth:
          node.tagName.toLowerCase() === "svg" ? node.getAttribute("stroke-width") : null,
      },
      box: {
        x: round(box.x),
        y: round(box.y),
        width: round(box.width),
        height: round(box.height),
      },
      panelBox: {
        x: round(box.x - origin.x),
        y: round(box.y - origin.y),
        width: round(box.width),
        height: round(box.height),
      },
      style: {
        display: style.display,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontFamily: style.fontFamily.slice(0, 80),
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        color: style.color,
        backgroundColor: style.backgroundColor,
        opacity: style.opacity,
        borderRadius: style.borderRadius,
        /*
         * A radius does not say what CURVE is drawn in it.
         *
         * The chrome squircles every corner from one rule in `css/base.ts` and
         * opts its round things back out by name, so the failure to look for is
         * a superellipse sitting on a radius that means "circle" or "pill".
         * That is exactly how the switch track was caught: 28x16 at radius 16,
         * drawn as a rounded rectangle, with a true circle for a knob inside it.
         */
        cornerShape: style.getPropertyValue("corner-shape"),
        borderTopLeftRadius: style.borderTopLeftRadius,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow === "none" ? "none" : style.boxShadow,
        padding: style.padding,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        margin: style.margin,
        gap: style.gap,
        rowGap: style.rowGap,
        columnGap: style.columnGap,
        width: style.width,
        height: style.height,
        minHeight: style.minHeight,
        gridTemplateColumns: style.gridTemplateColumns,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent,
        textAlign: style.textAlign,
        overflow: style.overflow,
      },
    })
  }

  record(panel)
  for (const node of panel.querySelectorAll("*")) record(node)
  return { origin: { width: round(origin.width), height: round(origin.height) }, rows }
}

/** Is this node inside (or itself) a match for `selector`, within the panel? */
function within(node, selector) {
  return typeof node.closest === "function" && node.closest(selector) !== null
}

function round(value) {
  return Math.round(value * 100) / 100
}
