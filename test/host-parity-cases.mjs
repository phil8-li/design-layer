/**
 * The right panel, rendered once per host, with every section accounted for.
 *
 * The Angular lane was built by making one write path work and then checking
 * the rest by hand. That is not a thing anyone can repeat, and by-hand is how
 * three of these were missed the first time: a Responsive section offering
 * Tailwind breakpoints to a project with no Tailwind, a Code tab spelling an
 * Angular element as JSX, and an AI prompt telling an agent to edit the
 * `className` in a template whose attribute is `class`.
 *
 * So this mounts the real inspector against a real DOM under each host config
 * and asserts on what a designer would actually see. Two rules hold it
 * together:
 *
 *  - Every section is named. A section that renders on one host and not the
 *    other has to say why here, which is what stops "it disappeared" from being
 *    discovered in a browser six weeks later.
 *  - What differs is only ever what MUST differ. The panel is one product; the
 *    host decides how an edit is spelled, not which controls exist.
 *
 * Usage: node designlayer/test/host-parity-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

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

const MARKUP = `<!doctype html><html><body><main id="app">
  <div id="page" class="overview-page">
    <section id="card" class="welcome">
      <div id="text" class="welcome__text">
        <h1 id="title" class="welcome__title">Welcome to Acme Store</h1>
        <p id="lede" class="welcome__lede">Orders and invoices now live in one workspace.</p>
      </div>
    </section>
  </div>
</main></body></html>`

const dom = new JSDOM(MARKUP, { pretendToBeVisual: true, url: "http://localhost/" })
const { window } = dom
window.document.elementsFromPoint = () => []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200 }
}
window.Element.prototype.scrollIntoView = () => {}
globalThis.DOMMatrixReadOnly = class {
  constructor() {
    this.m41 = 0
    this.m42 = 0
  }
}
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement", "SVGElement",
  "SVGSVGElement", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
/*
 * The inspector repaints on a frame, not inline: `invalidate()` schedules one
 * and coalesces every write in between, which is what keeps a scrub off the
 * panel's render path. jsdom's own rAF is a ~16ms timer, so a test that
 * selected an element and read the panel in the same task saw the EMPTY STATE
 * and reported every section missing.
 *
 * Reduced to a macrotask so a settle is a known number of ticks rather than a
 * sleep long enough to be flaky on a loaded machine.
 */
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
// The panel fetches the icon set and the variant catalog; neither route exists
// here and neither is what these cases are about.
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })

const { build } = await import("esbuild")

let loadCount = 0
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "de-parity-"))

/**
 * The editor bundle, built once per host config.
 *
 * `src/core/config.ts` reads `window.__DESIGNLAYER_CONFIG__` at MODULE LOAD
 * and freezes the answer — deliberately, so two call sites can never disagree
 * mid-session. That means a host cannot be swapped at runtime, and a parity
 * test has to load the bundle twice. Doing it any other way would be testing a
 * configuration the product never runs in.
 */
async function editorFor(hostConfig) {
  const injected = {
    apiBase: "/__designlayer",
    host: hostConfig,
    tailwind: { version: 3, breakpoints: { sm: 640, md: 768, lg: 1024 } },
  }
  // On BOTH globals. The launcher writes this onto the page's `window`, but
  // `src/core/config.ts` reads `globalThis`, and under Node those are two
  // different objects — setting only the jsdom one left every host running on
  // the built-in fallback, which is React with Tailwind. The test then agreed
  // with itself about two panels that were secretly the same panel.
  window.__DESIGNLAYER_CONFIG__ = injected
  globalThis.__DESIGNLAYER_CONFIG__ = injected

  const bundled = await build({
    stdin: {
      contents: `
        export { createContext } from "./src/core/context"
        export { installInspector } from "./src/panels/inspector/index"
        export { setState } from "./src/core/store"
        export { CODE_VIEWS, codeText, elementCode } from "./src/core/element-code"
        export { config } from "./src/core/config"
      `,
      resolveDir: PACKAGE_DIR,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  // Written to a file, one per load, rather than imported as a data: URL.
  // Two reasons, both learned the hard way: Node keys its module cache on the
  // URL, so two identical data: URLs are ONE module and the second host would
  // silently run under the first host's frozen config; and a throw inside a
  // data: module prints the whole base64 bundle in its stack, which buries the
  // one line that says what actually broke.
  const file = path.join(bundleDir, `editor-${loadCount++}.mjs`)
  fs.writeFileSync(file, bundled.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

/** A bridge with only the members the inspector reaches for. */
function stubBridge() {
  return {
    version: 1,
    tokens: { colors: {}, shadows: {}, radii: {}, font: "" },
    send() {},
    subscribe: () => () => {},
    discoverFile: async () => null,
    elementInfo: () => null,
    resolveSourceAt: async () => null,
    hitTest: () => null,
    selectedElement: () => null,
    refreshGeometry() {},
    toast() {},
    root: () => window.document.body,
    store: {
      getActiveTool: () => "move",
      setActiveTool() {},
      onToolChange: () => () => {},
      onStateChange: () => () => {},
      getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
      setCanvasTransform() {},
      onCanvasTransformChange: () => () => {},
      viewportToPage: (x, y) => ({ x, y }),
      pageToViewport: (x, y) => ({ x, y }),
      addPendingPropertyOperation() {},
      buildBatchOperations: () => [],
      hasChanges: () => false,
      addMove: () => null,
      updateMoveDelta() {},
      getMoveForElement: () => null,
      resetCanvas() {},
    },
  }
}

/** Mounts the inspector for one host and returns what it drew. */
async function panelFor(hostConfig, elementId) {
  const editor = await editorFor(hostConfig)
  const slots = {
    overlay: window.document.createElement("div"),
    toolbar: window.document.createElement("div"),
    left: window.document.createElement("div"),
    right: window.document.createElement("div"),
  }
  window.document.body.append(slots.right)
  const context = editor.createContext(stubBridge(), slots)
  editor.installInspector(context)

  const element = window.document.getElementById(elementId)
  context.select(element)
  context.refresh()
  // Three ticks: one for the scheduled frame, one for the options fetch to
  // settle, one for the repaint that follows it.
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

  /*
   * The ACCESSIBLE NAME, not the text content.
   *
   * A section's fold button used to contain its title, so `textContent` was the
   * name. It does not any more: the header is a grid with the title, the
   * actions and the chevron laid over an empty full-bleed button, because a `+`
   * nested inside the fold button would be a button inside a button. The
   * button's text is therefore `""` for every section, and reading it here made
   * this suite report that both hosts had lost every section they have — four
   * failures describing a panel that was in fact rendering correctly.
   *
   * `aria-label` is what `section()` pins the name to, precisely so a change to
   * the header's layout cannot rename a landmark. The fallback keeps any other
   * `aria-expanded` control in the panel readable.
   */
  const sections = Array.from(slots.right.querySelectorAll("button[aria-expanded]")).map((b) =>
    (b.getAttribute("aria-label") || b.textContent || "").trim()
  )
  const controls = Array.from(slots.right.querySelectorAll("input,select,button"))
    .map((c) => c.getAttribute("aria-label") || c.getAttribute("placeholder") || (c.textContent || "").trim())
    .filter(Boolean)
  slots.right.remove()
  return { editor, sections, controls, context, element }
}

const REACT = { framework: "react", tailwind: true }
const REACT_NO_TW = { framework: "react", tailwind: false }
const ANGULAR = { framework: "angular", tailwind: false }
const ANGULAR_TW = { framework: "angular", tailwind: true }

/* ---------------------------------------------------------------------- */
console.log("\nEvery section is accounted for on both hosts")

// A layout box, which is what makes the Responsive section eligible at all.
const reactPanel = await panelFor(REACT, "text")
const angularPanel = await panelFor(ANGULAR, "text")

// "Ask AI" was the ninth name here and is deliberately absent: a free-text box
// that posted one element to the agent, next to a Changes tab that already
// hands over every note and edit with a resolve lifecycle behind it. Two doors
// to one agent, and the narrower one was in the panel you use for direct
// manipulation.
const ALWAYS = ["Position", "Layout", "Appearance", "Fill", "Stroke", "Effects", "Classes"]

check("the React panel draws the sections it always has", () => {
  for (const name of ALWAYS) {
    assert.ok(reactPanel.sections.includes(name), `React lost the ${name} section`)
  }
})

check("Angular draws the same sections, none missing", () => {
  // The whole claim of the Angular lane: the panel is the same product, and
  // only the spelling of a write changes underneath it.
  for (const name of ALWAYS) {
    assert.ok(angularPanel.sections.includes(name), `Angular is missing the ${name} section`)
  }
})

check("the Design tab offers no second way to message the agent", () => {
  for (const panel of [reactPanel, angularPanel]) {
    assert.ok(!panel.sections.includes("Ask AI"), "the Ask AI section is back in the Design tab")
  }
})

check("the only section that differs is the Tailwind-only one", () => {
  const onlyInReact = reactPanel.sections.filter((name) => !angularPanel.sections.includes(name))
  const onlyInAngular = angularPanel.sections.filter((name) => !reactPanel.sections.includes(name))
  assert.deepEqual(onlyInReact, ["Responsive"], `unexpected React-only sections: ${onlyInReact}`)
  assert.deepEqual(onlyInAngular, [], `unexpected Angular-only sections: ${onlyInAngular}`)
})

check("the controls are the same set too, not just the headings", () => {
  // The Responsive section and its rows are the one sanctioned difference, so
  // its own heading is excluded alongside the rows it owns. Everything else
  // that React can reach, Angular must reach.
  const responsive = /^Responsive$|breakpoint|container/i
  // Responsive is now the ONLY exemption. There used to be a second — a
  // component-stack switch whose label named the host it was gathering from,
  // "React components" on one and "Angular components" on the other. It is
  // gone (see the case below), so the two panels' control sets match outright.
  const missing = reactPanel.controls.filter(
    (name) => !angularPanel.controls.includes(name) && !responsive.test(name)
  )
  assert.deepEqual(missing, [], `Angular is missing controls: ${missing.join(", ")}`)
})

check("neither host asks the designer to turn component detection on", () => {
  /*
   * The framework is DETECTED, not configured, so there is no row for it.
   *
   * The switch this replaces was the one control in the panel whose name had
   * to differ per host, which is the smell that gave it away: the editor knew
   * which framework it was attached to well enough to spell the label, and
   * then asked anyway. `output.ts` reads the stack off whichever host is
   * present and the brief always carries it; the only thing the switch could
   * do was withhold it.
   */
  const asksAboutComponents = (panel) =>
    panel.controls.filter((name) => /\bcomponents$/i.test(name))
  assert.deepEqual(asksAboutComponents(reactPanel), [], "the React panel is back to asking")
  assert.deepEqual(asksAboutComponents(angularPanel), [], "the Angular panel is back to asking")
})

check("every always-drawn section carries its saved-style control, on both", () => {
  /*
   * Saved styles have no section of their own: each is scoped to one section's
   * properties and opened from that section's header. A host that dropped the
   * control from one section would quietly lose the only way to save that
   * kind of style, so the toggles are counted per section.
   */
  const toggles = ["Layout styles", "Appearance styles", "Color styles", "Stroke styles", "Effect styles"]
  for (const panel of [reactPanel, angularPanel]) {
    for (const name of toggles) {
      assert.ok(panel.controls.includes(name), `${name} is missing`)
    }
    assert.ok(!panel.sections.includes("Saved styles"), "the standalone Saved styles section is back")
  }
})

/* ---------------------------------------------------------------------- */
console.log("\nResponsive follows Tailwind, not the framework")

await checkAsync("a React host without Tailwind is not offered breakpoints either", async () => {
  // The same defect from the other side: utility rows in a project with no
  // utility layer. Nothing about this is Angular-specific.
  const panel = await panelFor(REACT_NO_TW, "text")
  assert.ok(!panel.sections.includes("Responsive"), "breakpoint rows without Tailwind")
})

await checkAsync("an Angular host WITH Tailwind is offered them", async () => {
  const panel = await panelFor(ANGULAR_TW, "text")
  assert.ok(panel.sections.includes("Responsive"), "Tailwind on Angular lost its breakpoints")
})

/* ---------------------------------------------------------------------- */
console.log("\nThe Code tab speaks the host's dialect")

await checkAsync("React is offered JSX first", async () => {
  const { CODE_VIEWS } = await editorFor(REACT)
  assert.deepEqual(CODE_VIEWS.map((v) => v.id), ["jsx", "html", "classes"])
  assert.equal(CODE_VIEWS[2].label, "Tailwind classes")
})

await checkAsync("Angular is offered HTML first, and no JSX at all", async () => {
  const { CODE_VIEWS } = await editorFor(ANGULAR)
  assert.deepEqual(CODE_VIEWS.map((v) => v.id), ["html", "classes"])
  // `className=` and a JSX self-closing tag describe a file that does not exist
  // for this element.
  assert.ok(!CODE_VIEWS.some((v) => v.id === "jsx"), "JSX offered for an Angular element")
})

await checkAsync("the class list is not called Tailwind where there is none", async () => {
  const { CODE_VIEWS } = await editorFor(REACT_NO_TW)
  assert.equal(CODE_VIEWS[2].label, "Classes")
})

await checkAsync("Angular's runtime attributes stay out of the source view", async () => {
  const editor = await editorFor(ANGULAR)
  const element = window.document.getElementById("title")
  element.setAttribute("_ngcontent-ng-c3539969218", "")
  element.setAttribute("ng-reflect-value", "x")
  const selection = {
    element,
    tagName: "h1",
    componentName: "OverviewComponent",
    source: null,
    key: "h1",
  }
  const html = editor.codeText(editor.elementCode(selection, "html"))
  // They are in the DOM and in no template. The hash also changes on every
  // rebuild, so carrying it makes the panel disagree with the file for reasons
  // that have nothing to do with the design.
  assert.ok(!html.includes("_ngcontent"), `encapsulation attribute leaked: ${html.slice(0, 120)}`)
  assert.ok(!html.includes("ng-reflect"), "a dev-only reflection attribute leaked")
  assert.ok(html.includes('class="welcome__title"'), "the real attribute was dropped too")
  element.removeAttribute("_ngcontent-ng-c3539969218")
  element.removeAttribute("ng-reflect-value")
})

/* ---------------------------------------------------------------------- */
console.log("\nThe handover is written in the host's own vocabulary")

/*
 * This used to assert against the system prompt the editor sent to the
 * Anthropic API — a `HOST_GUIDANCE` table telling a model to edit `class` on
 * Angular and `className` on React. Both the table and the API call are gone
 * with the "Ask AI" panel that was the only way to reach them, so the claim is
 * now tested where it still holds: in the handoff record, which is the one
 * thing this route produces and the only description of the host an agent gets.
 *
 * Against the real route rather than the module text, because a grep for a
 * string in a source file passes just as happily when nothing calls it.
 */
{
  const { createAgent } = await import("../server/agent.mjs")
  const { resolveConfig } = await import("../config.mjs")
  const { handoffQueue } = await import("../server/handoff.mjs")

  /** Files one request through a throwaway project root and reads it back. */
  async function handoffFor(framework) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `de-parity-${framework}-`))
    handoffQueue().clear()
    const agent = createAgent({
      projectRoot: root,
      stateDir: path.join(root, ".local", "designlayer"),
      host: { framework },
    })
    const reply = await agent.runAgent({
      prompt: "1 note and 1 edit from DesignLayer",
      origin: "prompts",
      brief: "### src/overview\n- `<button>` — set `box-shadow` to `0 1px 2px`",
      files: ["src/overview"],
      url: "http://127.0.0.1:3456/overview",
      selection: {
        tagName: "button",
        componentName: "Overview",
        className: "btn btn--outlined",
        text: "Continue",
        source: { filePath: "src/overview", lineNumber: 31 },
      },
      ancestry: [],
    })
    const body = fs.readFileSync(path.join(root, reply.handoffPath), "utf8")
    const queued = handoffQueue().get(reply.changeId)
    fs.rmSync(root, { recursive: true, force: true })
    handoffQueue().clear()
    return { reply, body, queued }
  }

  const react = await handoffFor("react")
  const angular = await handoffFor("angular")

  check("React is told className, Angular is told class", () => {
    assert.match(react.body, /- className: btn btn--outlined/)
    assert.match(angular.body, /- class: btn btn--outlined/)
    assert.ok(
      !/- className:/.test(angular.body),
      "an Angular template has no className, and saying so sends the agent to a file that does not exist"
    )
  })

  check("the queue entry names the host too, so a waiting agent knows before it reads", () => {
    assert.equal(react.queued.framework, "react")
    assert.equal(angular.queued.framework, "angular")
  })

  check("the durable record carries the brief on both hosts", () => {
    // Without this the file on disk is a count and nothing else — see the
    // comment on `writeHandoff`.
    for (const { body } of [react, angular]) assert.match(body, /box-shadow/)
  })

  check("neither host reaches a model from here", () => {
    // The prose in this module is allowed to recount the transport that left;
    // the code is not allowed to grow it back without someone reading this.
    const agentSource = fs.readFileSync(new URL("../server/agent.mjs", import.meta.url), "utf8")
    assert.ok(!/@anthropic-ai\/sdk/.test(agentSource), "the direct-apply transport is back")
    assert.ok(!/process\.env/.test(agentSource), "the route reads the environment again")
  })

  check("the agent is constructible for both", () => {
    for (const framework of ["react", "angular"]) {
      const config = resolveConfig({ host: { framework } }, { cwd: PACKAGE_DIR })
      assert.ok(createAgent(config), `no agent for ${framework}`)
    }
  })
}

fs.rmSync(bundleDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
