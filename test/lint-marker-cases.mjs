/**
 * The audit on screen: badges over the page, rows in the Design system tab, and
 * the one rule that keeps the canvas readable.
 *
 * Bundled with esbuild and run in JSDOM against a stubbed `fetch`, the harness
 * `design-system-tab-cases.mjs` uses — and for the same reason. Everything under
 * test here is what the CLIENT does with a payload of findings; a real server
 * would add a second thing that can fail while proving nothing about the layer.
 * The findings are invented for this file, five of them, each written to make
 * one resolution outcome happen.
 *
 * A finding is a file and a line. A marker is a thing on screen. Almost every
 * claim below is about the distance between those two sentences, and each was
 * chosen because losing it is SILENT — the panel still lists rows, the canvas
 * still paints something, and the wrong thing is true:
 *
 *  - **a state selector resolves to the element, not to the state.** A
 *    `.card__title:hover` rule styles a title. A marker that waited for the
 *    hover would be waiting for a gesture the user has no reason to make on the
 *    one element they were just told to look at, and the finding would read as
 *    "not on this page" on a page that is showing it. The base compound is what
 *    gets marked;
 *  - **a selector the browser cannot parse takes itself down and nothing
 *    else.** `querySelectorAll` throws on anything it does not recognise, so one
 *    stylesheet using a syntax this browser has not shipped would otherwise lose
 *    every other finding's badge. The case asserts the survivors, not just the
 *    absence of a throw, because a layer that caught the error and gave up is
 *    also "no exception";
 *  - **a selector matching nothing is not an error, and is not on this page.**
 *    An audit covers a project; a page shows one screen of it. The finding is
 *    listed and counted in the total, gets no badge, and is excluded from the
 *    "on this page" figure — a panel claiming five while the canvas paints three
 *    reads as a broken marker layer rather than as a true statement about four
 *    other routes;
 *  - **the two layers are exclusive IN BOTH DIRECTIONS.** Showing audit badges
 *    hides note pins, and turning the notes back on hides the audit badges. Both
 *    are asserted separately and deliberately, because one direction working
 *    while the other silently does not is the likely bug — and it is the bug
 *    that produces the screen the exclusion exists to prevent: a round pin and a
 *    square plate on the same top-left corner, one covering the other, the loser
 *    invisible rather than obviously hidden;
 *  - **an error badge and a warning badge differ in more than hue.** Colour
 *    alone is a distinction not every reader can make. The two carry different
 *    classes — which is what lets the stylesheet shape them differently — and
 *    the stylesheet paints them from different tokens. The audit badge's own
 *    shape is checked against the note pin's in the same case, since the point
 *    of the square plate is that it is not a round dot;
 *  - **Ignore takes the marker AND moves the row**, because a dismissal that
 *    left the row where it was would read as a dead button, and one that deleted
 *    the row would leave nothing to undo it with. Unignore puts both back;
 *  - **Hide markers clears the canvas and leaves the list.** It is a statement
 *    about the overlay, not about the audit, and a toggle that emptied the panel
 *    would be a second Audit button that reads as an eye;
 *  - **"Fix 3" means three ticked.** Per-row Fix alone does not satisfy "let the
 *    user choose which ones to fix"; the checkbox subset does, and the footer
 *    button has to be about what is ticked rather than about what is fixable
 *    within it. It is disabled when nothing can be written at all.
 *
 * Everything is driven through the real store: findings arrive over the stubbed
 * fetch and are folded in by `runAudit`, the section is the real
 * `dsLintSection`, and the exclusion is driven by the real state on both
 * sides — `setMarkersShown` from the panel's end and annotation mode from the
 * notes' end, which is the seam a user actually moves. A test that set the flags
 * itself would pass against two layers wired to nothing.
 *
 * Usage: node designlayer/test/lint-marker-cases.mjs
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// ── The world the bundle loads into ────────────────────────────────────────

const API = "/__designlayer"

globalThis.__DESIGNLAYER_CONFIG__ = {
  apiBase: API,
  designSystem: {
    name: "Host",
    trackingUnit: "em",
    colors: [],
    spacing: [],
    radii: [],
    textStyles: [],
    uiTextStyles: [],
    effects: [],
    icons: [],
    motion: [],
    responsiveMeasures: [],
    aliases: { cssVariables: [], tailwind: [] },
  },
  icons: { attribute: "", available: false },
  host: { framework: "react", tailwind: false },
}

/*
 * The page the audit is about.
 *
 * `.card__title` is inside `.card` on purpose: the two carry findings of
 * different severities, so one page produces both badge treatments and the
 * nesting proves a badge is placed per ELEMENT rather than per selector match.
 * `.card__action` is the third marked element and the second fixable finding,
 * which is what makes "Fix all (2)" a number rather than a coin toss.
 */
const dom = new JSDOM(
  '<!doctype html><html><body><main id="app">' +
    '<section class="card">' +
    '<h2 class="card__title">Usage</h2>' +
    '<button class="card__action" type="button">Open</button>' +
    "</section>" +
    '<p class="lede">Nothing here is audited.</p>' +
    "</main></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom

window.document.elementsFromPoint = () => window.__stack ?? []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 12, y: 24, left: 12, top: 24, right: 212, bottom: 124, width: 200, height: 100 }
}
window.Element.prototype.scrollIntoView = function scroll() {}
for (const name of ["setPointerCapture", "releasePointerCapture"]) {
  window.Element.prototype[name] = function capture() {}
}
window.Element.prototype.hasPointerCapture = function held() {
  return false
}
globalThis.DOMMatrixReadOnly = class {
  constructor() {
    this.m41 = 0
    this.m42 = 0
  }
}
for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement",
  "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLButtonElement",
  "SVGElement", "SVGSVGElement",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent",
  "getComputedStyle", "localStorage",
]) {
  Object.defineProperty(globalThis, key, {
    value: key === "getComputedStyle" ? window.getComputedStyle.bind(window) : window[key],
    configurable: true,
    writable: true,
  })
}

/*
 * Both marker layers repaint on a frame, and jsdom's own rAF is a ~16ms timer:
 * a case that ran the audit and read the overlay in the same task would see an
 * empty layer and report the painter missing. Reduced to a macrotask, so a
 * settle is a known number of ticks rather than a sleep long enough to be flaky.
 * `annotation-cases.mjs` makes the same substitution for the same reason.
 */
const raf = (fn) => setTimeout(() => fn(0), 0)
const caf = (id) => clearTimeout(id)
globalThis.requestAnimationFrame = raf
globalThis.cancelAnimationFrame = caf
window.requestAnimationFrame = raf
window.cancelAnimationFrame = caf

/*
 * `CSS.supports`, which JSDOM does not implement at all.
 *
 * The row asks the ENGINE whether a literal is a colour rather than matching it
 * against a list of syntaxes — see `paintable` in `lint/plain.ts` — because a
 * list is wrong the first time a project ships `oklch()`. JSDOM having no `CSS`
 * object would make every swatch silently vanish here and the cases about them
 * pass while asserting nothing.
 *
 * Stubbed rather than worked around, because the real answer in every browser
 * this editor runs in is the engine's. The stub covers the syntaxes the
 * fixtures use and is deliberately not a general colour parser: a second
 * implementation of "is this a colour", living in a test, is the thing that
 * would go quietly out of step with the one being tested.
 */
window.CSS = {
  supports: (property, value) =>
    property === "color" && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|[a-z]+$)/i.test(String(value).trim()),
}
globalThis.CSS = window.CSS

// ── Five invented findings ─────────────────────────────────────────────────

const finding = (id, patch) => ({
  id,
  tool: "stylelint",
  rule: "design-tokens/no-hardcoded-color",
  severity: "error",
  message: "A hardcoded value where a token belongs.",
  file: "src/styles/card.css",
  line: 12,
  column: 3,
  endLine: 12,
  endColumn: 26,
  selector: null,
  snippet: "rgba(24, 28, 33, 0.06)",
  property: "background-color",
  fix: null,
  ...patch,
})

/**
 * One finding per resolution outcome, and the fifth is the reason the other
 * four can be trusted.
 *
 * `card-bg` and `action-radius` are the two the audit may write, so the footer
 * reads "Fix all (2)". `title-color` carries a `:hover` and no fix, which is
 * the state-selector case and the "lists three candidates, so picks none" case
 * at once. `ghost` names a selector this page does not render. `broken` names
 * one the browser cannot parse at all, and everything else on this list has to
 * survive it.
 */
const FINDINGS = [
  /*
   * The one finding carrying a rule id a real checker actually emits.
   *
   * `stylelint-design-tokens`, `ds-lint` and `@shadcn/lint` all spell this
   * `no-raw-colors`, and `lint/plain.ts` has plain-English wording for it. The
   * others on this list keep their invented ids DELIBERATELY: a panel that
   * renames rules it recognises must leave the ones it does not alone, and a
   * fixture where every id is known could not catch it guessing.
   */
  finding("card-bg", {
    selector: ".card",
    severity: "error",
    rule: "design-tokens/no-raw-colors",
    message: '"rgba(24, 28, 33, 0.06)" is a hardcoded colour. Use var(--ink-surface-hover).',
    fix: { replacement: "var(--ink-surface-hover)" },
  }),
  finding("title-color", {
    selector: ".card__title:hover",
    severity: "warning",
    rule: "design-tokens/no-hardcoded-color",
    message: '"#6d3af2" is a hardcoded colour with no matching token. Nearest: --ink, --ink-soft.',
    property: "color",
    snippet: "#6d3af2",
    line: 21,
    fix: null,
  }),
  finding("action-radius", {
    selector: ".card__action",
    severity: "error",
    rule: "design-tokens/no-unknown-token",
    message: "--corner-tiny is never declared. Did you mean --corner-small?",
    property: "border-radius",
    snippet: "--corner-tiny",
    line: 28,
    fix: { replacement: "--corner-small" },
  }),
  finding("ghost", {
    selector: ".ghost-panel",
    severity: "error",
    message: '"#101418" is a hardcoded colour with no matching token.',
    file: "src/styles/settings.css",
    line: 4,
    fix: null,
  }),
  // A Sass placeholder that leaked into the compiled stylesheet, which is the
  // ordinary way a selector the browser refuses reaches a real project.
  finding("broken", {
    selector: ".grid > %placeholder",
    severity: "warning",
    message: "This rule sets a raw shadow instead of an elevation token.",
    file: "src/styles/settings.css",
    line: 9,
    snippet: "0 1px 2px rgba(8, 10, 12, 0.16)",
    property: "box-shadow",
    fix: null,
  }),
]

/** The three that resolve, in the order the page renders them. */
const ON_PAGE = ["card-bg", "title-color", "action-radius"]

const TOOLS = [
  {
    id: "stylelint",
    name: "Tokens (Stylelint)",
    available: true,
    reason: "Configured in .stylelintrc.json.",
    configFile: ".stylelintrc.json",
  },
  {
    id: "ds-lint",
    name: "ds-lint",
    available: false,
    reason: "ds-lint is not installed in this project.",
    configFile: null,
  },
  {
    id: "shadcn",
    name: "shadcn/lint",
    available: false,
    reason: "This project does not use Tailwind, so shadcn/lint has no tokens to read.",
    configFile: null,
  },
]

/**
 * The server, as far as the client is concerned.
 *
 * It keeps state so an ignore is visible to the next read, and it records every
 * call — which is the only way to assert that a button reached the wire at all,
 * since a panel that updated its own list optimistically looks identical from
 * the DOM.
 */
const server = {
  findings: FINDINGS,
  ignored: [],
  calls: [],
  reset() {
    server.findings = FINDINGS
    server.ignored = []
    server.calls = []
  },
}

const clone = (value) => JSON.parse(JSON.stringify(value))

async function serve(input, init = {}) {
  const url = new URL(String(input), "http://localhost")
  const method = (init.method ?? "GET").toUpperCase()
  const rest = url.pathname.slice(API.length)
  const body = init.body ? JSON.parse(init.body) : null
  server.calls.push({ method, path: rest, body })

  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })

  if (rest === "/lint/tools" && method === "GET") return reply({ tools: clone(TOOLS) })
  if (rest === "/lint/run" && method === "POST") {
    return reply({
      findings: clone(server.findings).map((entry) => ({
        ...entry,
        ignored: server.ignored.includes(entry.id),
      })),
      ranAt: new Date().toISOString(),
      tools: ["stylelint"],
    })
  }
  if (rest === "/lint/fix" && method === "POST") {
    const ids = body?.ids ?? []
    return reply({ fixed: ids, failed: [] })
  }
  if (rest === "/lint/ignore") {
    const ids = body?.ids ?? []
    server.ignored =
      method === "DELETE"
        ? server.ignored.filter((id) => !ids.includes(id))
        : [...new Set([...server.ignored, ...ids])]
    return reply({ ignored: [...server.ignored] })
  }
  return reply({})
}

globalThis.fetch = serve
window.fetch = serve

// ── The bundle ─────────────────────────────────────────────────────────────

/*
 * Every name here is one the contract states, plus the two stylesheets the
 * severity case reads. Nothing is imported on a guess: one wrong export name is
 * a bundle failure and a file of red lines whose real cause is a typo.
 */
const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createContext } from "./src/core/context"
      export { getState, setState } from "./src/core/store"
      export { dsLintSection } from "./src/lint/panel"
      export { installLintMarkers, relaxSelector } from "./src/lint/markers"
      export {
        lintFindings, lintSummary, markersShown, setMarkersShown,
        runAudit, isOnThisPage, elementsForFinding, findingsFor,
        resetLintForTest,
      } from "./src/lint/store"
      export { installAnnotations } from "./src/annotations/canvas"
      export {
        addAnnotation, markerLayer, notePinsVisible, resetAnnotationsForTest,
      } from "./src/annotations/store"
      export { lintMarkersCss } from "./src/core/css/lint-markers"
      export { annotationsCss } from "./src/core/css/annotations"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "silent",
})
const editor = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

/** Enough turns of the loop for a fetch, a notify and a repaint to land. */
async function settle(turns = 6) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 0)))
  }
}

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}

/** Every toast the editor raised, so a refusal can be read as words. */
const toasts = []
const bridge = {
  elementInfo: (element) => ({
    tagName: element?.tagName?.toLowerCase?.() ?? "div",
    componentName: "Card",
    filePath: "src/app/page.tsx",
    lineNumber: 7,
    columnNumber: 0,
    stack: [],
  }),
  elementSourceAsync: async (element) => bridge.elementInfo(element),
  send() {},
  toast: (message, kind) => toasts.push([message, kind]),
  subscribe: () => () => {},
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

const overlay = slot()
const left = slot()
const context = editor.createContext(bridge, {
  overlay,
  toolbar: slot(),
  left,
  right: slot(),
})

/*
 * Both layers, in the order the shell mounts them, and both are needed by every
 * exclusivity case: a test that installed only the audit layer could watch its
 * badges disappear without ever proving the pins came back.
 */
editor.installAnnotations(context)
editor.installLintMarkers(context)

const panel = editor.dsLintSection(context)
left.append(panel.node)
panel.update()

const $ = (selector) => window.document.querySelector(selector)
const card = $(".card")
const title = $(".card__title")
const action = $(".card__action")

// ── Reading the two layers ─────────────────────────────────────────────────

const visible = (node) => node.style.display !== "none"

/** Audit badges currently painted, by the finding id each one speaks for. */
const badges = () =>
  Array.from(overlay.querySelectorAll("[data-de-lint-id]")).filter(visible)
const badgeFor = (id) =>
  badges().find((node) => node.getAttribute("data-de-lint-id") === id) ?? null
const badgeIds = () => badges().map((node) => node.getAttribute("data-de-lint-id")).sort()

/** Note pins currently painted. Pooled nodes are parked, not removed. */
const pins = () => Array.from(overlay.querySelectorAll(".de-ann-marker")).filter(visible)

/** Every element in the panel wearing one of §2's hooks. */
const all = (role) => Array.from(panel.node.querySelectorAll(`[data-de-lint="${role}"]`))
const one = (role) => all(role)[0] ?? null
const row = (id) => panel.node.querySelector(`[data-de-lint="finding"][data-de-lint-id="${id}"]`)
const ignoredRow = (id) =>
  panel.node.querySelector(`[data-de-lint="ignored"][data-de-lint-id="${id}"]`)
const rowIds = () => all("finding").map((node) => node.getAttribute("data-de-lint-id"))

const click = (node) => {
  assert.ok(node, "nothing to click")
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
}
/** The row checkbox has no hook of its own; it is the only input in a row. */
const tick = async (id) => {
  const box = row(id).querySelector('input[type="checkbox"]')
  assert.ok(box, `the row for ${id} has no checkbox, so no subset can be chosen`)
  box.checked = true
  box.dispatchEvent(new window.Event("change", { bubbles: true }))
  await settle(2)
}

/** Clears every tick, so a case about the footer's label starts from "Fix all". */
async function untickAll() {
  for (const box of panel.node.querySelectorAll('input[type="checkbox"]')) {
    if (!box.checked) continue
    box.checked = false
    box.dispatchEvent(new window.Event("change", { bubbles: true }))
  }
  await settle(2)
}

/** One rule block out of a stylesheet string, by class name. */
function ruleFor(css, name) {
  const found = new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(css)
  assert.ok(found, `${name} is a class the stylesheet never mentions`)
  return found[1]
}

const radiusOf = (block) => /border-radius\s*:\s*([^;]+)/.exec(block)?.[1].trim() ?? ""

/** A run of the audit, from whatever the stub server is currently holding. */
async function audit() {
  await editor.runAudit(API)
  panel.update()
  await settle()
}

await audit()

// ── Resolving a finding to an element ──────────────────────────────────────

console.log("\nFrom a selector in a stylesheet to a box on the page")

await check("a selector carrying :hover still marks the base element", () => {
  assert.equal(editor.relaxSelector(".card__title:hover").relaxed, ".card__title")
  assert.deepEqual(editor.elementsForFinding("title-color"), [title])
  assert.ok(badgeFor("title-color"), "the state rule was left unmarked on a page showing it")
  assert.deepEqual(editor.findingsFor(title).map((entry) => entry.id), ["title-color"])
})

await check("a selector the browser cannot parse is skipped, and takes nothing with it", () => {
  assert.equal(editor.relaxSelector(".grid > %placeholder").relaxed, "")
  assert.deepEqual(editor.elementsForFinding("broken"), [])
  assert.equal(badgeFor("broken"), null, "an unparseable selector was marked anyway")
  // The survivors are the assertion. A layer that caught the error and gave up
  // would also raise no exception.
  assert.deepEqual(badgeIds(), ON_PAGE.slice().sort(), "the layer went down with one bad selector")
})

await check("a selector matching nothing gets no marker and is off the page count", () => {
  assert.equal(editor.isOnThisPage("ghost"), false)
  assert.equal(badgeFor("ghost"), null, "a finding on another route was painted here")
  // Listed and counted, because it is a real violation of the design system —
  // just not one this route can show.
  assert.ok(row("ghost"), "a finding that is not on this page was dropped from the list")
  assert.equal(editor.lintSummary().total, 5)
  assert.equal(editor.lintSummary().onPage, 3)
})

await check("the summary counts issues, severities and what is on this page", () => {
  const text = one("summary").textContent
  assert.match(text, /5 issues/)
  assert.match(text, /3 errors/)
  assert.match(text, /2 warnings/)
  // The number that stops the panel looking broken: five rows, three badges.
  assert.match(text, /3 on this page/)
  assert.equal(badges().length, 3, `${badges().length} badges under a summary claiming 3`)
})

// ── Telling the two severities, and the two layers, apart ──────────────────

console.log("\nWhat a badge looks like")

/*
 * Hue alone is not a distinction every reader can make, so the two severities
 * differ in class as well — which is what lets the stylesheet shape them
 * differently — and the stylesheet paints them from different tokens. The
 * second half of the case is the OTHER distinction: an audit badge against a
 * note pin, where the contract asks for a square plate beside a round dot.
 */
await check("an error badge and a warning badge differ in class and in colour", () => {
  const error = badgeFor("card-bg")
  const warning = badgeFor("title-color")
  assert.ok(error && warning, "the two severities did not both produce a badge")

  const errorClasses = new Set(error.classList)
  const warningClasses = new Set(warning.classList)
  const onlyError = [...errorClasses].filter((name) => !warningClasses.has(name))
  const onlyWarning = [...warningClasses].filter((name) => !errorClasses.has(name))
  assert.ok(onlyError.length > 0 && onlyWarning.length > 0, "both severities carry the same classes")
  assert.match(onlyError.join(" "), /error/)
  assert.match(onlyWarning.join(" "), /warn/)

  const errorRule = ruleFor(editor.lintMarkersCss, onlyError.find((name) => /error/.test(name)))
  const warningRule = ruleFor(editor.lintMarkersCss, onlyWarning.find((name) => /warn/.test(name)))

  const paint = (block) =>
    (block.match(/(?:background|background-color|color|border-color)\s*:[^;]+/g) ?? []).join("|")
  assert.ok(paint(errorRule).length > 0, "the error badge is given no colour of its own")
  assert.notEqual(paint(errorRule), paint(warningRule), "the two severities are painted identically")

  // The other channel, and the one the colour cannot stand in for: amber
  // against red is the pair a colour-blind reader is most likely to lose, so
  // the two plates are not the same shape either.
  assert.notEqual(
    radiusOf(errorRule),
    radiusOf(warningRule),
    `both severities are cut to the same corner: ${radiusOf(errorRule)}`
  )
})

await check("an audit badge is a rounded square where a note pin is a disc", () => {
  const pin = /\.de-ann-marker \{([^}]*)\}/.exec(editor.annotationsCss)
  assert.ok(pin, "the note pin has no base rule to compare against")

  const pinRadius = radiusOf(pin[1])
  assert.match(pinRadius, /50%|999|9999|100%/, `a note pin is not round: ${pinRadius}`)

  // The plate's corner is stated per severity, so both are checked: either one
  // reading as a disc would be the two layers converging on one shape.
  for (const name of ["de-lint-marker--error", "de-lint-marker--warning"]) {
    const corner = radiusOf(ruleFor(editor.lintMarkersCss, name))
    assert.ok(corner.length > 0, `${name} sets no corner at all`)
    assert.doesNotMatch(corner, /50%|999|9999|100%/, `${name} is as round as a note pin: ${corner}`)
  }

  // No info glyph on the plate: shape and colour are the mark, and the hover
  // tip says what was found.
  const badge = badgeFor("card-bg")
  assert.equal(badge.querySelector("svg"), null, "the audit badge still draws a glyph")
  assert.ok((badge.getAttribute("title") ?? "").length > 0, "the audit badge explains nothing on hover")
})

// ── One canvas, two layers, never both ─────────────────────────────────────

console.log("\nThe two marker layers are exclusive, both ways round")

/*
 * A note to have a pin for, pinned to an element the audit also marks — which
 * is the collision the exclusion exists to prevent. Both directions are driven
 * through the state a user actually moves: the panel's own toggle on one side,
 * and entering annotation mode on the other, which is how a user says "I am
 * about to leave a note".
 */
await check("showing audit markers hides the note pins", async () => {
  editor.addAnnotation({
    kind: "element",
    comment: "This corner is where both markers would land.",
    rect: { x: 12, y: 24, width: 200, height: 100 },
    element: card,
    target: { tagName: "section", selector: ".card", componentName: "Card", source: null },
    selectedText: null,
  })
  context.setState({ annotating: false })
  await settle()

  editor.setMarkersShown(true)
  await settle()

  assert.equal(editor.markerLayer(), "audit", "the panel's toggle never reached the shared state")
  assert.equal(editor.notePinsVisible(), false, "the note layer still believes it is on screen")
  assert.deepEqual(pins(), [], `${pins().length} note pins are still painted under the badges`)
  assert.equal(badges().length, 3, "the audit layer claimed the canvas and painted nothing")
})

await check("showing note pins hides the audit markers", async () => {
  // Entering annotation mode is the user saying the next click leaves a note,
  // and a note pinned under an audit badge is a note they cannot see.
  context.setState({ annotating: true })
  await settle()

  assert.equal(editor.markerLayer(), "notes", "annotating did not take the canvas back")
  assert.equal(editor.notePinsVisible(), true)
  assert.ok(pins().length > 0, "the note pin never came back")
  assert.deepEqual(badges(), [], `${badges().length} audit badges are still over the note pins`)
  // The panel's own vocabulary has to agree, or its footer would offer to hide
  // markers that are already gone.
  assert.equal(editor.markersShown(), false, "the panel still thinks the audit owns the canvas")

  context.setState({ annotating: false })
  editor.setMarkersShown(true)
  await settle()
  assert.equal(badges().length, 3, "the audit layer could not be got back")
})

await check("Hide markers clears the layer and leaves the list alone", async () => {
  const before = rowIds()
  assert.equal(before.length, 5)

  const toggle = one("hide-markers")
  assert.ok(toggle, "the footer has no Hide markers control")
  assert.match(toggle.textContent, /Hide markers/)
  click(toggle)
  await settle()

  assert.deepEqual(badges(), [], "Hide markers left the badges on screen")
  assert.equal(editor.markersShown(), false)
  assert.deepEqual(rowIds(), before, "Hide markers emptied the findings list as well")
  assert.match(one("hide-markers").textContent, /Show markers/, "the toggle does not say what it will do next")

  click(one("hide-markers"))
  await settle()
  assert.equal(badges().length, 3, "Show markers did not put them back")
})

/*
 * The board hides every badge (the editor stands down for it), and closing it
 * changes only `canvasView` — which the layer used not to watch, so the badges
 * stayed hidden after Escape until something scrolled.
 */
await check("badges come back when canvas view closes, without a scroll", async () => {
  assert.equal(badges().length, 3, "no badges to hide")
  context.setState({ canvasView: true })
  await settle()
  assert.deepEqual(badges(), [], "badges stayed painted over the board")
  context.setState({ canvasView: false })
  await settle()
  assert.equal(badges().length, 3, "the badges did not come back after the board closed")
})

// ── Dismissing one ─────────────────────────────────────────────────────────

console.log("\nIgnore, and taking it back")

await check("Ignore takes the marker and moves the row under Show ignored", async () => {
  assert.ok(badgeFor("card-bg"), "the finding about to be ignored has no marker to lose")

  click(row("card-bg").querySelector('[data-de-lint="ignore"]'))
  await settle()

  assert.ok(
    server.calls.some((call) => call.path === "/lint/ignore" && call.method === "POST"),
    "Ignore never reached the server, so it would come back on the next reload"
  )
  assert.equal(badgeFor("card-bg"), null, "the ignored finding is still marked on the canvas")
  assert.equal(row("card-bg"), null, "the ignored finding is still an open row")
  assert.equal(badges().length, 2, "ignoring one finding changed the others' markers")

  const disclosure = one("show-ignored")
  assert.ok(disclosure, "nothing offers to show the ignored findings, so this cannot be undone")
  assert.match(disclosure.textContent, /Show ignored \(1\)/)
  click(disclosure)
  await settle()
  assert.ok(ignoredRow("card-bg"), "the dismissed finding is nowhere in the panel")
})

await check("Unignore restores the row and the marker", async () => {
  click(ignoredRow("card-bg").querySelector('[data-de-lint="unignore"]'))
  await settle()

  assert.ok(
    server.calls.some((call) => call.path === "/lint/ignore" && call.method === "DELETE"),
    "Unignore never reached the server"
  )
  assert.ok(row("card-bg"), "the restored finding is not back in the open list")
  assert.ok(badgeFor("card-bg"), "the restored finding is back in the list and not on the canvas")
  assert.equal(badges().length, 3)
})

// ── Choosing what to fix ───────────────────────────────────────────────────

console.log("\nFix all, and fixing three of them")

await check("Fix all counts what can be written, and says so", () => {
  const button = one("fix-all")
  assert.ok(button, "the footer has no Fix all")
  assert.equal(button.disabled, false, "Fix all is disabled with two fixable findings")
  assert.match(button.textContent, /Fix all \(2\)/)
})

await check("three ticked rows make it Fix 3", async () => {
  for (const id of ["card-bg", "title-color", "action-radius"]) await tick(id)
  const button = one("fix-all")
  assert.equal(
    button.textContent.trim(),
    "Fix 3",
    `the footer reads ${JSON.stringify(button.textContent.trim())} with three rows ticked`
  )
  assert.equal(button.disabled, false, "a subset containing two fixable findings cannot be fixed")

  click(button)
  await settle()
  const posted = server.calls.filter((call) => call.path === "/lint/fix").pop()
  assert.ok(posted, "Fix 3 never posted anything")
  // Two of the three can actually be written, and only those two may be sent:
  // asking the server to fix a finding that named no replacement is how one
  // gets guessed at.
  assert.deepEqual(posted.body.ids.slice().sort(), ["action-radius", "card-bg"])
})

await check("Fix all is disabled when nothing can be written", async () => {
  await untickAll()
  server.findings = FINDINGS.map((entry) => ({ ...entry, fix: null }))
  await audit()

  const button = one("fix-all")
  assert.equal(button.disabled, true, "Fix all offers to write findings that name no replacement")
  assert.match(button.textContent, /Fix all \(0\)/)
  assert.deepEqual(all("fix"), [], "a row with no fix still offers one")

  server.reset()
  await audit()
})

// ── The row and the canvas ─────────────────────────────────────────────────

console.log("\nA row points at an element")

await check("clicking a row selects the element on the canvas", async () => {
  context.select(null)
  await settle(2)

  click(row("action-radius"))
  await settle()
  assert.equal(
    editor.getState().selection[0]?.element,
    action,
    "the row did not select the element its finding is about"
  )
})

await check("clicking a row for a finding that is not on this page says so", async () => {
  toasts.length = 0
  click(row("ghost"))
  await settle()

  assert.equal(editor.getState().selection[0]?.element, action, "an off-page row moved the selection")
  assert.equal(toasts.length, 1, "clicking an off-page row did nothing and said nothing")
  assert.match(toasts[0][0], /is not on this page/)
})

await check("the Audit button runs the audit over the wire", async () => {
  server.calls.length = 0
  click(one("audit"))
  await settle()
  assert.ok(
    server.calls.some((call) => call.path === "/lint/run" && call.method === "POST"),
    "the Audit button is wired to nothing"
  )
})

// ── What a row actually says ───────────────────────────────────────────────

/*
 * A row is a VALUE and its replacement, not the checker's paragraph.
 *
 * These cases exist because the obvious way to "improve" a cramped row is to
 * print the message again — one line of code, and it looks like more
 * information. That is the exact failure this shape undoes: forty checker
 * paragraphs down a 260px rail, each ending in an instruction, plus the same
 * forty-word NO_FIX note under every unfixable one. So half the assertions
 * below are about what must NOT be on the row, and the sentence still being
 * reachable on hover is what makes that deletion honest rather than lossy.
 */
console.log("\nA row reads as a value, not as a paragraph")

const textOf = (id, selector) => row(id).querySelector(selector)?.textContent.trim() ?? null

await check("a fixable row is the found value, an arrow, and the token", () => {
  assert.deepEqual(
    Array.from(row("card-bg").querySelectorAll(".de-lint-literal-text")).map((n) =>
      n.textContent.trim()
    ),
    ["rgba(24, 28, 33, 0.06)", "--ink-surface-hover"],
    "the row does not read as one value becoming another"
  )
  assert.ok(
    row("card-bg").querySelector(".de-lint-arrow"),
    "nothing says the first value becomes the second"
  )
})

await check("the token is SHOWN as a name and WRITTEN as a var() call", () => {
  // The two differ on purpose: the row is read by a designer, the file is
  // written by the button, and neither should have to wear the other's form.
  assert.equal(
    textOf("card-bg", ".de-lint-literal--fix .de-lint-literal-text"),
    "--ink-surface-hover",
    "the row makes a designer read CSS syntax to find the token's name"
  )
  assert.match(
    row("card-bg").querySelector('[data-de-lint="fix"]').getAttribute("title") ?? "",
    /var\(--ink-surface-hover\)/,
    "the control that writes the file does not say what it will write"
  )
})

await check("a colour value carries its colour, and a non-colour carries none", () => {
  const swatch = row("card-bg").querySelector(".de-lint-literal--found .de-lint-swatch")
  assert.ok(swatch, "a hardcoded colour is listed with no way to see what colour it is")
  assert.match(swatch.getAttribute("style") ?? "", /rgba\(24, 28, 33, 0\.06\)/)
  // `--corner-tiny` is a radius. A neutral square beside it would be this panel
  // claiming a colour it has not got.
  assert.equal(
    row("action-radius").querySelector(".de-lint-swatch"),
    null,
    "a radius token was given a colour swatch"
  )
})

await check("the checker's whole sentence survives, on hover", () => {
  for (const id of ["card-bg", "title-color"]) {
    const { message } = FINDINGS.find((entry) => entry.id === id)
    const title = row(id).querySelector('[data-de-lint="select"]').getAttribute("title") ?? ""
    assert.ok(
      title.includes(message),
      `${id} dropped the checker's sentence instead of moving it to the tooltip`
    )
  }
})

await check("no row prints the message, and none prints the no-fix note", () => {
  for (const id of rowIds()) {
    assert.equal(
      row(id).querySelector(".de-lint-why"),
      null,
      `${id} still carries the NO_FIX paragraph that made this list unreadable`
    )
    assert.ok(
      !row(id).textContent.includes("is a hardcoded colour"),
      `${id} prints the checker's sentence in the row body`
    )
  }
})

await check("only an unfixable row gets a hint, and it names the choice left", () => {
  // Two near-misses listed and no single answer: the reader has to pick one.
  assert.equal(textOf("title-color", ".de-lint-hint"), "2 near matches. Pick one in the inspector")
  // An unfixable row under a rule this editor ships no wording for still says
  // the fact, and deliberately does not invent an instruction to go with it.
  assert.equal(textOf("ghost", ".de-lint-hint"), "No automatic fix")
  assert.equal(
    row("card-bg").querySelector(".de-lint-hint"),
    null,
    "a row with a Fix button repeats in words what its arrow already says"
  )
})

await check("the group heading is the problem in English, with the id on hover", () => {
  const heads = Array.from(panel.node.querySelectorAll(".de-lint-group-rule"))
  const named = heads.find((n) => n.getAttribute("title") === "design-tokens/no-raw-colors")
  assert.ok(named, "the raw-colour group is missing")
  assert.equal(named.textContent.trim(), "Hard-coded colors")
  // A rule this editor ships no wording for keeps its id, rather than being
  // renamed by guesswork into something that sounds authoritative and is wrong.
  const unknown = heads.find((n) => n.getAttribute("title") === "design-tokens/no-hardcoded-color")
  assert.equal(
    unknown.textContent.trim(),
    "design-tokens/no-hardcoded-color",
    "an unknown rule was given an invented friendly name"
  )
})

await check("the line number cannot be truncated away with the filename", () => {
  const where = row("ghost").querySelector(".de-lint-where")
  assert.equal(where.querySelector(".de-lint-where-file").textContent.trim(), "settings.css")
  assert.equal(
    where.querySelector(".de-lint-where-line").textContent.trim(),
    ":4",
    "the line number shares a shrinking box with the filename"
  )
  assert.match(where.getAttribute("title") ?? "", /src\/styles\/settings\.css:4/)
})

await check("an off-page row still says so, in two words", () => {
  assert.equal(row("ghost").querySelector(".de-lint-offpage")?.textContent.trim(), "off page")
  assert.equal(
    row("card-bg").querySelector(".de-lint-offpage"),
    null,
    "a row that IS on this page was labelled off page"
  )
})

await check("Fix and Ignore stay real buttons inside the row", () => {
  // The stylesheet floats them out of flow, which is a LOOK. They have to stay
  // in the row's DOM and in its tab order, or the keyboard loses them entirely.
  assert.ok(row("card-bg").querySelector('[data-de-lint="fix"]'), "the Fix button left the row")
  assert.ok(row("card-bg").querySelector('[data-de-lint="ignore"]'), "the Ignore button left the row")
  assert.equal(
    row("ghost").querySelector('[data-de-lint="fix"]'),
    null,
    "a finding with no confident replacement was offered a Fix"
  )
})

// ── Which checkers run ─────────────────────────────────────────────────────

console.log("\nThe checkers are routed, not chosen")

await check("the chip row is gone — nobody picks a checker here", () => {
  assert.deepEqual(all("tool"), [], "the section still lists the checkers as chips")
  assert.equal(
    panel.node.querySelector(".de-lint-tools"),
    null,
    "the chip row survived as an empty container"
  )
})

await check("hovering the section title names what runs and what does not", () => {
  const title = one("checkers")
  assert.ok(title, "there is nothing in the section saying which checkers run")
  assert.ok(title.classList.contains("de-section-title"), "the checkers sentence is not on the section title")
  assert.equal(title.textContent, "DS lint", "the hint landed on something other than the title")
  assert.equal(
    panel.node.querySelector(".de-lint-info, .de-section-info"),
    null,
    "the info dot is still drawn"
  )

  // The sentence is the whole contract: a checker that will NOT run must still
  // be named, or a green audit reads as "everything was checked".
  const line = title.getAttribute("data-de-tip") ?? ""
  assert.match(line, /Running Tokens \(Stylelint\)/, `the title never says what runs: ${line}`)
  assert.match(line, /Not running: ds-lint, shadcn\/lint/, `the title hides the skipped ones: ${line}`)

  // The tooltip card is aria-hidden, so the fold button carries the sentence.
  assert.equal(
    panel.node.querySelector(".de-section-toggle").getAttribute("aria-description"),
    line,
    "the checkers sentence is silent to a screen reader"
  )

  // Concise: names and nothing else. The server's full reason for shadcn runs
  // to two sentences about Tailwind, and a hover is not where it belongs.
  assert.ok(line.length < 120, `the hover copy is ${line.length} characters: ${line}`)
  assert.ok(!line.includes("Tailwind"), `the title spent a checker's whole reason on a hover: ${line}`)
})

// ── The button group ───────────────────────────────────────────────────────

console.log("\nAudit, Fix all and Hide markers are one group")

await check("Audit is in the section body, not in the header's actions slot", () => {
  const audit = one("audit")
  assert.ok(audit, "the Audit button is gone")
  assert.equal(
    audit.closest(".de-section-actions"),
    null,
    "Audit is still riding in the section header"
  )
  assert.ok(audit.closest(".de-section-body"), "Audit is not inside the section's body")
})

await check("the three controls share one group, with Audit first", async () => {
  await audit()
  const group = panel.node.querySelector(".de-lint-controls")
  assert.ok(group, "there is no button group")
  assert.equal(group.getAttribute("role"), "group", "the group is not announced as one")
  assert.deepEqual(
    Array.from(group.children).map((node) => node.getAttribute("data-de-lint")),
    ["audit", "fix-all", "hide-markers"],
    "the group is not the three controls in order"
  )
  // And nothing is left behind in the footer, which is now only the ignored list.
  const footer = panel.node.querySelector(".de-lint-footer")
  assert.equal(
    footer.querySelector('[data-de-lint="fix-all"]'),
    null,
    "Fix all is in the footer as well as in the group"
  )
})

await check("a clean run collapses the group back to Audit", async () => {
  const kept = server.findings
  server.findings = []
  await audit()

  assert.ok(one("audit"), "a clean run took the Audit button away")
  assert.equal(one("fix-all"), null, "a clean run still offers to fix all of nothing")
  assert.equal(one("hide-markers"), null, "a clean run still offers to hide markers that are not there")
  assert.match(
    panel.node.querySelector(".de-empty")?.textContent ?? "",
    /No design-system issues/,
    "a clean run says nothing about being clean"
  )

  server.findings = kept
  await audit()
  assert.ok(one("fix-all"), "the group did not grow back when findings came back")
})

// ── What the section says when it has nothing to list ──────────────────────

console.log("\nEvery answer with no rows in it points somewhere")

await check("the row and its hover give the missing fix one name, not two", () => {
  const hint = textOf("ghost", ".de-lint-hint")
  const title = row("ghost").querySelector('[data-de-lint="select"]').getAttribute("title") ?? ""
  // The hover exists to EXPAND the row. It opened "No safe automatic fix" over a
  // row reading "No automatic fix", which is one state wearing two names — and
  // the extra word invites the reader to wonder what the unsafe fix would have
  // been, when there is no such thing on this surface.
  assert.ok(title.includes(hint), `the hover restates the hint differently: ${hint} / ${title}`)
  assert.doesNotMatch(title, /No safe automatic/, "the hover still spells it its own way")
  // And it still ends somewhere the reader can act, which is the whole reason
  // the sentence is longer than the hint.
  assert.match(title, /inspector/)
})

await check("a run that failed is announced, not quietly swapped into the list", async () => {
  const answering = globalThis.fetch
  const warn = console.warn
  const warned = []
  console.warn = (...args) => warned.push(args)
  globalThis.fetch = async (input, init = {}) =>
    String(input).endsWith("/lint/run")
      ? { ok: false, status: 500, json: async () => ({}) }
      : answering(input, init)
  try {
    await editor.runAudit(API).catch(() => {})
    panel.update()
    await settle()
  } finally {
    globalThis.fetch = answering
    console.warn = warn
  }

  const line = one("failure")
  assert.ok(line, "a failed run has nowhere to be said")
  assert.equal(line.hidden, false, "the failure is in the document and not shown")
  // The press that started the audit moved no focus and the button has already
  // gone back to reading "Audit", so without this a screen-reader user is never
  // told the thing they asked for did not happen.
  assert.equal(line.getAttribute("role"), "alert")
  // It cannot live inside the list it stands in for: `body` is cleared on every
  // render, and a live region rebuilt each paint either announces a sentence
  // that has not changed or is inserted already-populated and announces nothing.
  assert.equal(line.closest(".de-lint-body"), null, "the alert is rebuilt with the list")

  const said = line.textContent
  assert.doesNotMatch(said, /HTTP \d/, `the section handed a designer a status code: ${said}`)
  assert.match(said, /Check its terminal/, `the failure names no recovery: ${said}`)
  assert.ok(warned.length, "the status was dropped rather than logged for whoever runs the server")

  await audit()
  assert.equal(one("failure").hidden, true, "the failure line outlived the run that worked")
})

await check("with everything ignored, the sentence names the control that undoes it", async () => {
  for (const id of rowIds()) {
    click(row(id).querySelector('[data-de-lint="ignore"]'))
    await settle(2)
  }
  assert.deepEqual(rowIds(), [], "something is still open, so this is not the empty state")

  const disclosure = one("show-ignored")
  assert.ok(disclosure, "nothing offers the ignored list, so none of this can be undone")
  const said = panel.node.querySelector(".de-empty")?.textContent ?? ""
  // It gave the count and not the control, which is one line below it. A reader
  // told that five things are hidden and not told what hides them reads the
  // sentence as a statistic rather than as a door.
  const label = disclosure.textContent.replace(/\s*\(\d+\)\s*$/, "").trim()
  assert.ok(said.includes(label), `the empty state never names “${label}”: ${said}`)
})

/*
 * Last, because it resets the store the rest of this file has been building up.
 * Nothing runs after it, which is the point: a section opened on an editor that
 * has never audited is the state a designer actually arrives in, and it cannot
 * be reached from a session that already has findings in it.
 */
await check("on an untouched editor the group is Audit alone", async () => {
  editor.resetLintForTest()
  const fresh = editor.dsLintSection(context)
  fresh.update()
  await settle(8)

  const hook = (role) => fresh.node.querySelector(`[data-de-lint="${role}"]`)
  assert.ok(hook("audit"), "the fresh section has no Audit button")
  assert.equal(hook("fix-all"), null, "Fix all is offered before there is anything to fix")
  assert.equal(
    hook("hide-markers"),
    null,
    "Hide markers is offered before there are any markers to hide"
  )
  const said = fresh.node.querySelector(".de-empty")?.textContent ?? ""
  assert.match(said, /Audit finds/, "the untouched section does not say what to press")
  // "Nothing audited yet" said only that nothing had happened. The first state a
  // designer meets has to say what the section is for.
  assert.match(said, /design tokens/, "the untouched section does not say what an audit looks for")
  // The title's hint is already answering, because the tool list is fetched on
  // first paint rather than waiting for a run.
  assert.match(
    hook("checkers").getAttribute("data-de-tip") ?? "",
    /Running Tokens \(Stylelint\)/,
    "the fresh section cannot say which checkers it would use"
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
