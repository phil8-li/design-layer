/**
 * Breakpoint contract and responsive-class cases.
 *
 * Split out of token-cases.mjs so the responsive section and the token rows can
 * be worked on without two lanes editing one test file. The contract these
 * cases hold is that the pixel value and the design-system MEANING stay apart:
 * `tailwind.breakpoints` says which prefixes compile, `designSystem.breakpoints`
 * says which of them the host's system documents, and a prefix that compiles is
 * still offered — labelled as outside the system rather than hidden.
 */

import assert from "node:assert/strict"
import vm from "node:vm"
import { JSDOM } from "jsdom"

import { browserPrelude, loadConfig } from "../config.mjs"
import {
  normalizeBreakpoints,
  normalizeDesignSystemBreakpoints,
} from "../server/design-system-manifest.mjs"

import { PACKAGE_DIR, requireHostConfig } from "./host.mjs"

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

/**
 * jsdom does not install its window on the module realm, and the editor is
 * plain DOM that reaches for these by name. Shared by both render cases so the
 * two fixtures cannot drift into testing different globals.
 */
function installDomGlobals(window) {
  for (const key of [
    "window", "document", "navigator", "Node", "Element", "HTMLElement",
    "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement", "SVGSVGElement",
    "Event", "CustomEvent", "KeyboardEvent", "PointerEvent", "requestAnimationFrame",
    "cancelAnimationFrame", "getComputedStyle",
  ]) {
    Object.defineProperty(globalThis, key, {
      value: key === "getComputedStyle" ? window.getComputedStyle.bind(window) : window[key],
      configurable: true,
      writable: true,
    })
  }
}

async function loadEditorHelpers() {
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `
        export * from "./src/core/responsive"
        export { createContext } from "./src/core/context"
        export { installInspector } from "./src/panels/inspector"
        export { responsiveSection } from "./src/panels/inspector/section-responsive"
      `,
      resolveDir: PACKAGE_DIR,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  )
}

/**
 * A REAL host app's config, and its numbers are deliberately pinned below.
 *
 * That makes this suite one of the four places the editor is coupled to a real
 * app rather than a fixture, which is the point: it is the regression net that
 * catches a change to the tool silently changing what a real app sees, and the
 * numbers below are the pinned host app's. The host-AGNOSTIC contract — that
 * the same code reads a design system it has never met — is proved without this
 * file, on the fixture hosts in host-agnostic-cases.mjs.
 */
const { configPath: HOST_CONFIG } = requireHostConfig("responsive-cases")
const workspace = await loadConfig({ configPath: HOST_CONFIG })
const catalog = workspace.designSystem.catalog

console.log("\nBreakpoint contract")

check("every Tailwind prefix reaches the catalog, ordered by width", () => {
  assert.deepEqual(
    catalog.breakpoints.map((token) => [token.name, token.values.default]),
    [["sm", 640], ["md", 768], ["lg", 1024], ["xl", 1280], ["2xl", 1536]]
  )
  for (const token of catalog.breakpoints) {
    assert.equal(token.category, "breakpoint")
    assert.equal(token.prefix, `${token.name}:`)
  }
})

check("all 13 container prefixes reach the catalog and xl carries the documented decision", () => {
  assert.equal(catalog.containerBreakpoints.length, 13, "the container scale must not be vacuous")
  assert.deepEqual(
    catalog.containerBreakpoints.map((token) => [token.name, token.values.default]),
    [
      ["3xs", 256], ["2xs", 288], ["xs", 320], ["sm", 384], ["md", 448],
      ["lg", 512], ["xl", 576], ["2xl", 672], ["3xl", 768], ["4xl", 896],
      ["5xl", 1024], ["6xl", 1152], ["7xl", 1280],
    ]
  )
  const documented = catalog.containerBreakpoints.filter((token) => token.documented)
  assert.deepEqual(documented.map((token) => token.name), ["xl"])
  assert.match(documented[0].usage, /two columns/)
  assert.match(documented[0].owner, /^src\/.+\.tsx$/)
})

check("the catalog carries exactly the three read-only responsive measures", () => {
  assert.deepEqual(
    catalog.responsiveMeasures.map((measure) => [measure.name, measure.formula]),
    [
      ["leftPanelFits", "viewport - left panel - right panel >= 720px"],
      ["rightPanelMaxWidth", "viewport - 560px"],
      ["contextCardFits", "canvas width >= reader width + 372px * 2"],
    ]
  )
})

check("the four documented steps carry their meaning and their owning file", () => {
  const documented = catalog.breakpoints.filter((token) => token.documented)
  assert.deepEqual(documented.map((token) => token.name), ["md", "lg", "xl", "2xl"])
  for (const token of documented) {
    assert.ok(token.usage && token.usage.length > 10, `${token.name} has no usage prose`)
    assert.match(token.owner, /^src\/.+\.ts$/, `${token.name} names no owning source file`)
  }
})

check("a prefix the design system never declared is offered but not dressed up", () => {
  const sm = catalog.breakpoints.find((token) => token.name === "sm")
  assert.ok(sm, "sm is missing — a compiling prefix must still be offered")
  assert.equal(sm.documented, false)
  assert.equal(sm.usage, undefined)
  assert.equal(sm.owner, undefined)
})

check("an annotation may not invent a breakpoint or omit its meaning", () => {
  assert.throws(
    () => normalizeBreakpoints({ md: 768 }, { xxl: { usage: "nope" } }),
    /designSystem\.breakpoints\.xxl names a breakpoint tailwind\.breakpoints does not define/
  )
  assert.throws(
    () => normalizeDesignSystemBreakpoints({ md: { owner: "src/x.ts" } }),
    /designSystem\.breakpoints\.md\.usage must be a non-empty string/
  )
  assert.deepEqual(normalizeDesignSystemBreakpoints(undefined), {})
})

check("the browser prelude carries the documented flag to the inspector", () => {
  const sandbox = { window: {} }
  vm.runInNewContext(browserPrelude(workspace, { proxyPort: 4567 }), sandbox)
  // Spread first: the prelude runs in a vm realm, so its arrays fail a strict
  // deepEqual on prototype identity alone, with a diff that shows no difference.
  const breakpoints = [...sandbox.window.__DESIGNLAYER_CONFIG__.designSystem.breakpoints]
  assert.deepEqual(
    breakpoints.map((token) => [token.name, token.documented]),
    [["sm", false], ["md", true], ["lg", true], ["xl", true], ["2xl", true]]
  )
  assert.ok(breakpoints.find((token) => token.name === "xl").usage.includes("right panel"))
  const browserConfig = sandbox.window.__DESIGNLAYER_CONFIG__
  assert.equal(browserConfig.designSystem.containerBreakpoints.length, 13)
  assert.equal(browserConfig.designSystem.responsiveMeasures.length, 3)
})

console.log("\nResponsive classes")

// The bundle reads `window.__DESIGNLAYER_CONFIG__` once at import, so the host
// catalog has to be in place BEFORE the import. Set it afterwards and the panel
// would render against the generic fallback, where no step is documented and
// the whole point of the section — the sentence a designer reads — is absent.
const injected = { window: {} }
vm.runInNewContext(browserPrelude(workspace, { proxyPort: 4567 }), injected)
globalThis.__DESIGNLAYER_CONFIG__ = injected.window.__DESIGNLAYER_CONFIG__

const helpers = await loadEditorHelpers()

check("the step model carries the catalog's order, widths, and meanings", () => {
  const steps = helpers.breakpointSteps(catalog.breakpoints)
  assert.deepEqual(
    steps.map((step) => [step.name, step.px, step.prefix]),
    [
      ["sm", 640, "sm:"],
      ["md", 768, "md:"],
      ["lg", 1024, "lg:"],
      ["xl", 1280, "xl:"],
      ["2xl", 1536, "2xl:"],
    ]
  )
  assert.deepEqual(
    steps.filter((step) => step.documented).map((step) => step.name),
    ["md", "lg", "xl", "2xl"]
  )
  assert.equal(steps.find((step) => step.name === "xl").owner, catalog.breakpoints.find((b) => b.name === "xl").owner)
  assert.equal(steps.find((step) => step.name === "sm").usage, undefined)
})

check("the container step model uses the separate 13-step scale", () => {
  const steps = helpers.containerBreakpointSteps(catalog.containerBreakpoints)
  assert.equal(steps.length, 13)
  const xlContainer = catalog.containerBreakpoints.find((b) => b.name === "xl")
  assert.deepEqual(steps.find((step) => step.name === "xl"), {
    name: "xl",
    px: 576,
    prefix: "@xl:",
    documented: true,
    usage: xlContainer.usage,
    owner: xlContainer.owner,
  })
})

check("the active step is the widest one the window has crossed", () => {
  const steps = helpers.breakpointSteps(catalog.breakpoints)
  assert.equal(helpers.activeBreakpoint(500, steps), null)
  assert.equal(helpers.activeBreakpoint(640, steps).name, "sm")
  assert.equal(helpers.activeBreakpoint(1279, steps).name, "lg")
  assert.equal(helpers.activeBreakpoint(4000, steps).name, "2xl")
})

check("responsive parsing distinguishes viewport, container, and base utilities", () => {
  assert.equal(helpers.parseResponsiveClassName("gap-4", workspace.tailwind.breakpoints), null)

  const viewport = helpers.parseResponsiveClassName(
    "dark:md:hover:gap-6",
    workspace.tailwind.breakpoints
  )
  assert.equal(viewport.breakpoint, "md")
  assert.equal(viewport.px, 768)
  assert.equal(viewport.prefix, "dark:md:hover:")
  assert.equal(viewport.utility, "gap-6")
  assert.equal(viewport.context, "viewport")

  const container = helpers.parseResponsiveClassName(
    "@xl/sidebar:grid-cols-3",
    workspace.tailwind.breakpoints,
    workspace.tailwind.containerBreakpoints
  )
  assert.equal(container.breakpoint, "xl")
  assert.equal(container.px, 576)
  assert.equal(container.prefix, "@xl/sidebar:")
  assert.equal(container.utility, "grid-cols-3")
  assert.equal(container.context, "container")
})

check("responsive bindings are ordered by breakpoint without losing source order ties", () => {
  const bindings = helpers.responsiveClassBindings(
    ["xl:grid-cols-4", "md:grid-cols-2", "hover:md:gap-6", "grid"],
    workspace.tailwind.breakpoints
  )
  assert.deepEqual(
    bindings.map(({ className, px }) => [className, px]),
    [
      ["md:grid-cols-2", 768],
      ["hover:md:gap-6", 768],
      ["xl:grid-cols-4", 1280],
    ]
  )
})

check("replacing one breakpoint preserves base, siblings, and nested variants", () => {
  const classes = ["grid", "grid-cols-1", "md:grid-cols-2", "dark:md:hover:gap-6", "xl:grid-cols-4"]
  const binding = helpers.parseResponsiveClassName(
    "dark:md:hover:gap-6",
    workspace.tailwind.breakpoints
  )
  const edit = helpers.replaceResponsiveClass(binding, "gap-8")
  assert.deepEqual(edit, {
    remove: ["dark:md:hover:gap-6"],
    add: ["dark:md:hover:gap-8"],
  })
  const after = classes.filter((name) => !edit.remove.includes(name)).concat(edit.add)
  assert.ok(after.includes("grid-cols-1"))
  assert.ok(after.includes("md:grid-cols-2"))
  assert.ok(after.includes("xl:grid-cols-4"))
})

console.log("\nResponsive controls")

await checkAsync("breakpoint controls are named and keep the caret across their write", async () => {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="target" class="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 dark:md:hover:gap-6 xl:grid-cols-4" style="display:grid;gap:16px;padding:16px">Hello<span></span></div></body></html>`,
    { pretendToBeVisual: true, url: "http://localhost/" }
  )
  const { window } = dom
  installDomGlobals(window)

  const target = window.document.getElementById("target")
  const right = window.document.createElement("aside")
  right.setAttribute("data-designlayer", "")
  window.document.body.append(right)
  const slot = () => {
    const node = window.document.createElement("div")
    node.setAttribute("data-designlayer", "")
    window.document.body.append(node)
    return node
  }
  const pending = []
  const bridge = {
    elementInfo: () => ({
      tagName: "div", componentName: "Fixture", filePath: "/tmp/fixture.tsx",
      lineNumber: 1, columnNumber: 0, stack: [],
    }),
    send() {}, subscribe: () => () => {}, toast() {},
    store: {
      addPendingPropertyOperation: (...args) => pending.push(args),
      getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
      setCanvasTransform() {}, onCanvasTransformChange: () => () => {},
      onStateChange: () => () => {}, hasChanges: () => false,    },
  }
  const editor = helpers.createContext(bridge, {
    overlay: slot(), toolbar: slot(), left: slot(), right,
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  try {
    helpers.installInspector(editor)
    editor.select(target)
    const paint = () => new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
    )
    await paint()

    for (const breakpoint of ["sm", "md", "lg", "xl", "2xl"]) {
      assert.ok(
        right.querySelector(`[aria-label="${breakpoint} breakpoint utilities"]`),
        `${breakpoint} control is missing`
      )
    }

    const before = right.querySelector('[data-de-field="responsive.md"]')
    before.focus()
    before.value = "grid-cols-3 gap-6"
    before.setSelectionRange(3, 7)
    before.dispatchEvent(new window.Event("change", { bubbles: true }))
    await paint()

    const after = right.querySelector('[data-de-field="responsive.md"]')
    assert.notEqual(after, before, "the inspector did not rebuild")
    assert.equal(window.document.activeElement, after)
    assert.equal(after.selectionStart, 3)
    assert.equal(after.selectionEnd, 7)
    assert.ok(target.classList.contains("grid-cols-1"), "base class was removed")
    assert.ok(target.classList.contains("xl:grid-cols-4"), "sibling breakpoint was removed")
    assert.ok(target.classList.contains("dark:md:hover:gap-6"), "nested variant was removed")
    assert.ok(target.classList.contains("md:grid-cols-3"))
    assert.ok(target.classList.contains("md:gap-6"))
    assert.ok(pending.length > 0, "responsive edit did not queue a source operation")
  } finally {
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})

/**
 * Renders the section on its own rather than through `installInspector`: these
 * cases are about what the Responsive rows SAY, and a failure should name that
 * section instead of surfacing as a swallowed warning from the panel's
 * per-section try/catch.
 */
function mountResponsiveSection(html, { containerWidth = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
  })
  const { window } = dom
  installDomGlobals(window)
  const target = window.document.getElementById("target")
  if (containerWidth !== null) {
    let container = target
    while (container && !Array.from(container.classList).some(
      (name) => name === "@container" || name.startsWith("@container/")
    )) {
      container = container.parentElement
    }
    assert.ok(container, "the fixture has no container to measure")
    container.getBoundingClientRect = () => ({ width: containerWidth })
  }
  const host = window.document.createElement("div")
  window.document.body.append(host)

  const writes = []
  const writer = {
    applyClasses(_selection, write, summary) {
      for (const name of write.remove) target.classList.remove(name)
      for (const name of write.add) target.classList.add(name)
      writes.push({ write, summary })
    },
  }
  const render = () => {
    const node = helpers.responsiveSection({
      editor: null,
      writer,
      selection: { element: target },
      computed: window.getComputedStyle(target),
      invalidate: render,
    })
    host.replaceChildren(node)
  }
  render()
  // The expander is panel-level memory and survives each fixture. Normalize
  // every mount to the compact state so cases never depend on execution order.
  host.querySelector('[aria-label="Show documented and authored container steps"]')?.click()

  const field = (id) => host.querySelector(`[data-de-field="${id}"]`)
  return {
    dom,
    window,
    target,
    host,
    writes,
    field,
    /** Everything the row around a control says, title and hints included. */
    rowText: (id) => field(id).closest(".de-stack").textContent,
    containerFields: () => [...host.querySelectorAll('[data-de-field^="responsive.@"]')],
    type: (id, value) => {
      const input = field(id)
      input.value = value
      input.dispatchEvent(new window.Event("change", { bubbles: true }))
    },
  }
}

check("a documented step reads its meaning and names the file that owns the number", () => {
  const panel = mountResponsiveSection(
    `<div id="target" class="grid grid-cols-1" style="display:grid"><span></span></div>`
  )
  try {
    const md = panel.rowText("responsive.md")
    assert.match(md, /768px and up/)
    assert.match(md, /left panel stops docking/)
    assert.match(md, /src\/hooks\/use-mobile\.ts/)
    assert.ok(!md.includes("declares no step here"), "a documented step was marked undocumented")
    assert.match(panel.rowText("responsive.xl"), /docked right panel by default/)
  } finally {
    panel.dom.window.close()
  }
})

check("an undocumented prefix is offered, marked, and still writes", () => {
  const panel = mountResponsiveSection(
    `<div id="target" class="grid grid-cols-1" style="display:grid"><span></span></div>`
  )
  try {
    const sm = panel.rowText("responsive.sm")
    assert.match(sm, /640px and up/)
    assert.match(sm, /Compiles, but this design system declares no step here/)
    assert.ok(!/src\//.test(sm), "an undocumented step invented an owning file")

    panel.type("responsive.sm", "gap-2")
    assert.ok(panel.target.classList.contains("sm:gap-2"))
    assert.equal(panel.writes.at(-1).summary, "Set sm responsive utilities")
  } finally {
    panel.dom.window.close()
  }
})

check("exactly the step the window is standing on is marked active", () => {
  const panel = mountResponsiveSection(
    `<div id="target" class="grid" style="display:grid"><span></span></div>`
  )
  try {
    // jsdom's window is 1024 wide, which is `lg` to the pixel.
    assert.equal(panel.window.innerWidth, 1024)
    const marked = ["sm", "md", "lg", "xl", "2xl"].filter((name) =>
      panel.rowText(`responsive.${name}`).includes("active now")
    )
    assert.deepEqual(marked, ["lg"])
    assert.match(panel.host.textContent, /Viewport 1024px · lg is the active step/)
  } finally {
    panel.dom.window.close()
  }
})

check("container rows stay folded while current width, xl, and three measures remain visible", () => {
  const panel = mountResponsiveSection(
    `<div class="@container/sidebar"><div id="target" class="grid grid-cols-1 @md/sidebar:grid-cols-2 hover:@lg/sidebar:gap-4" style="display:grid"><span></span></div></div>`,
    { containerWidth: 600 }
  )
  try {
    assert.match(panel.host.textContent, /Inside @container\/sidebar/)
    assert.match(panel.host.textContent, /Nearest container width: 600px · xl is the active container step/)
    assert.equal(panel.containerFields().length, 2, "all 13 container controls rendered while folded")
    assert.deepEqual(
      panel.containerFields().map((field) => field.dataset.deField),
      ["responsive.@md", "responsive.@xl"]
    )
    assert.equal(panel.field("responsive.@md").value, "grid-cols-2")
    assert.match(panel.rowText("responsive.@md"), /448px and up/)
    assert.match(panel.rowText("responsive.@xl"), /576px and up · active now/)
    assert.match(panel.rowText("responsive.@xl"), /Project stage rows become two columns/)
    assert.equal(panel.field("responsive.md").value, "")
    assert.match(panel.host.textContent, /Nested\/state variants stay unchanged: hover:@lg\/sidebar:gap-4/)
    assert.ok(!panel.host.textContent.includes("—"), "responsive copy contains an em dash")

    const measures = [...panel.host.querySelectorAll("[data-de-responsive-measure]")]
    assert.equal(measures.length, 3)
    assert.deepEqual(
      measures.map((node) => node.getAttribute("data-de-responsive-measure")),
      [
        "responsive-measure:left-panel-fits",
        "responsive-measure:right-panel-max-width",
        "responsive-measure:context-card-fits",
      ]
    )
    for (const measure of measures) {
      assert.equal(measure.querySelector("input, select, button"), null, "a responsive measure is editable")
    }

    panel.host.querySelector('[aria-label="Show all container steps"]').click()
    assert.equal(panel.containerFields().length, 13)
    assert.ok(panel.field("responsive.@3xs"))
    assert.ok(panel.field("responsive.@7xl"))
  } finally {
    panel.dom.window.close()
  }
})

check("container edits retain the named prefix and every nested or viewport variant", () => {
  const panel = mountResponsiveSection(
    `<div class="@container/sidebar"><div id="target" class="grid grid-cols-1 lg:grid-cols-3 @md/sidebar:grid-cols-2 hover:@lg/sidebar:gap-4" style="display:grid"><span></span></div></div>`,
    { containerWidth: 600 }
  )
  try {
    assert.equal(
      panel.field("responsive.@md").getAttribute("aria-label"),
      "@md container utilities"
    )

    panel.type("responsive.@md", "grid-cols-4 gap-2")
    const classes = Array.from(panel.target.classList)
    assert.ok(classes.includes("@md/sidebar:grid-cols-4"), "the named container scope was dropped")
    assert.ok(classes.includes("@md/sidebar:gap-2"))
    assert.ok(!classes.includes("@md/sidebar:grid-cols-2"))
    assert.ok(classes.includes("hover:@lg/sidebar:gap-4"), "a nested container variant was disturbed")
    assert.ok(classes.includes("lg:grid-cols-3"), "a viewport variant was disturbed")
    assert.ok(classes.includes("grid-cols-1"), "a base class was disturbed")

    panel.type("responsive.lg", "grid-cols-6")
    const after = Array.from(panel.target.classList)
    assert.ok(after.includes("lg:grid-cols-6"))
    assert.ok(after.includes("@md/sidebar:grid-cols-4"), "a container variant was disturbed")
    assert.ok(after.includes("hover:@lg/sidebar:gap-4"), "a nested container variant was disturbed")

    panel.host.querySelector('[aria-label="Show all container steps"]').click()
    panel.type("responsive.@lg", "grid-cols-5")
    assert.ok(panel.target.classList.contains("@lg/sidebar:grid-cols-5"))
    assert.ok(panel.target.classList.contains("hover:@lg/sidebar:gap-4"))
  } finally {
    panel.dom.window.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
