/**
 * The token bindings after the `Design system` section was dissolved.
 *
 * That section drew ~30 labelled pickers — fill colour, text colour, text
 * style, corner radius, shadow, gap, padding, margin — every one of them naming
 * a CSS property some OTHER section already had a control for. It is gone, and
 * its rows have been redistributed into the sections that own those properties
 * (`src/panels/inspector/token-row.ts` carries the whole argument). This suite
 * exists for the two things that move can silently break, and for nothing else:
 *
 *   1. NO ROW WAS LOST. Each row was drawn behind a gate — "only when the
 *      element can carry it" — and every one of those gates now lives in a
 *      different file. A gate dropped or mistyped in the move deletes a control
 *      from the panel and throws nothing. So for each scenario element below,
 *      the axis is asserted to appear SOMEWHERE in the rendered Design tab.
 *
 *   2. NO ROW IS DRAWN TWICE, which is the entire point of the refactor. Across
 *      the whole rendered tab, `data-de-field="design-system.<axis>"` must
 *      appear at most once. This nearly broke in review on a flex container,
 *      where both the Layout section and the auto-layout block inside it wanted
 *      to draw gap and padding; `drawsSpacingControls` in
 *      `section-autolayout.ts` is the arbitration, and a grid container is where
 *      the two files most nearly disagree — `directionOf` reads grid as "none"
 *      while `laysOutChildren` accepts it.
 *
 * Self-contained, and deliberately so. `token-cases.mjs` pins a real host's own
 * numbers and SKIPS the whole process when no host is on disk, which takes its
 * inspector cases with it; a suite about which controls exist must not be one
 * that quietly stops running in a bare clone. The two catalogs below are
 * fixtures written out in full, so what is stocked on each axis is a fact of
 * this file rather than of somebody's checkout.
 *
 * ## Three defects the merge introduced, found by writing this suite
 *
 * All three are fixed. Their cases are kept, inverted, because each one is a
 * hole the MERGE opened rather than a pre-existing bug — so the merge is what
 * has to keep being tested:
 *
 *   - `corner-radius` vanished entirely on a SQUARE box with the Appearance
 *     per-corner toggle open: the uniform binding went with the fold and the
 *     four meant to replace it were gated away. Impossible before the move,
 *     when the uniform row sat behind a fold of its own.
 *   - `stroke-color` lost the "or a `border*` class" half of its gate.
 *     `hasBorder` was exported to express it and nothing called it — a browser
 *     hid the cost, because `class="border"` computes to 1px there.
 *   - `icon-size` required `role="img"`, an attribute the editor never writes
 *     and Lucide does not emit, which made the row unreachable in the only
 *     case its section runs in.
 *
 * Each case now asserts the FIXED behaviour and says, where it is asserted,
 * what the defect was. A regression re-breaks the case rather than passing it.
 *
 * ## Two things this suite cannot assert, and why
 *
 * `shadow` has no negative. JSDOM computes `box-shadow` as "" on an element
 * that has none, where a browser answers "none" — so the gate
 * (`computed.boxShadow !== "none"`) passes on every element here. The row is
 * asserted PRESENT where it should be and never asserted absent; see
 * SHADOW_IS_UNGATED_UNDER_JSDOM below.
 *
 * JSDOM also does not expand shorthands. `border-radius: 8px` leaves all four
 * `border-*-radius` longhands at 0, so every fixture that needs a real corner
 * writes the four longhands out, exactly as `token-cases.mjs` does.
 *
 * Usage: node test/token-binding-cases.mjs
 */

import assert from "node:assert/strict"
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

/*
 * The gate that has no negative here.
 *
 * Named rather than silently skipped: a reader who adds `shadow` to a `reject`
 * list below and watches it fail deserves to find out why in this file instead
 * of in JSDOM's source.
 */
const SHADOW_IS_UNGATED_UNDER_JSDOM = "shadow"

/* ---------- the catalogs ---------- */

/**
 * A design system that stocks every axis, so a missing row is always a missing
 * GATE rather than an empty shelf.
 *
 * Both `tokenRow` and `tokenControl` answer null when the catalog has nothing
 * for the axis, which is the right behaviour and the wrong fixture for property
 * 1: an empty category and a dropped gate produce the same absent field. Two
 * tokens per category rather than one, because a picker offering a single
 * choice is a shape the real panel rarely has.
 */
const STOCKED = {
  name: "Fixture System",
  trackingUnit: "em",
  colors: [
    {
      id: "color:surface",
      name: "Surface/Base",
      category: "color",
      values: { default: "#ffffff" },
      cssVar: "--fx-surface-base",
    },
    {
      id: "color:ink",
      name: "Text/Primary",
      category: "color",
      values: { default: "#101418" },
      cssVar: "--fx-text-primary",
    },
  ],
  spacing: [
    { id: "spacing:sm", name: "spacing/sm", category: "spacing", values: { default: 8 } },
    { id: "spacing:md", name: "spacing/md", category: "spacing", values: { default: 16 } },
  ],
  radii: [
    {
      id: "radius:sm",
      name: "radius/sm",
      category: "radius",
      values: { default: 8 },
      cssVar: "--fx-radius-sm",
    },
    {
      id: "radius:md",
      name: "radius/md",
      category: "radius",
      values: { default: 12 },
      cssVar: "--fx-radius-md",
    },
  ],
  textStyles: [
    {
      id: "typography:body",
      name: "Body/Default",
      category: "typography",
      values: { default: { fontSize: 16, lineHeight: 24, fontWeight: 400, letterSpacing: 0 } },
      cssVars: {
        fontSize: "--fx-body-size",
        lineHeight: "--fx-body-leading",
        fontWeight: "--fx-body-weight",
        letterSpacing: "--fx-body-tracking",
      },
    },
    {
      id: "typography:heading",
      name: "Heading/H2",
      category: "typography",
      values: { default: { fontSize: 24, lineHeight: 32, fontWeight: 600, letterSpacing: -0.01 } },
      cssVars: {
        fontSize: "--fx-h2-size",
        lineHeight: "--fx-h2-leading",
        fontWeight: "--fx-h2-weight",
        letterSpacing: "--fx-h2-tracking",
      },
    },
  ],
  uiTextStyles: [],
  effects: [
    {
      id: "shadow:e1",
      name: "Elevation/1",
      category: "shadow",
      values: { default: "0 1px 2px #0002" },
      cssVar: "--fx-elev-1",
    },
    {
      id: "shadow:e2",
      name: "Elevation/2",
      category: "shadow",
      values: { default: "0 4px 12px #0003" },
      cssVar: "--fx-elev-2",
    },
  ],
  icons: [
    { id: "icon-size:action", name: "action", category: "icon-size", values: { default: 16 } },
    { id: "icon-size:display", name: "display", category: "icon-size", values: { default: 24 } },
  ],
  // One flat spring and one that bounces: the bouncing one is the axis's whole
  // honesty rule, and a motion category with only writable tokens in it would
  // make the `motion-duration` row a different row than the shipped one.
  motion: [
    {
      id: "motion:crossfade",
      name: "crossfade",
      category: "motion",
      values: { default: { visualDuration: 0.15, bounce: 0 } },
    },
    {
      id: "motion:lively",
      name: "lively",
      category: "motion",
      values: { default: { visualDuration: 0.3, bounce: 0.3 } },
    },
  ],
  breakpoints: [],
  containerBreakpoints: [],
  responsiveMeasures: [],
  aliases: { cssVariables: [], tailwind: [] },
}

/**
 * The same system with one shelf stocked and the rest bare.
 *
 * Spacing survives so the case has a positive half — a suite that proves "no
 * field for an unstocked axis" against a catalog with nothing in it proves
 * nothing about stocking. Everything else is empty, which is the ordinary state
 * of a project with three colours and no shadow scale.
 */
const SPARSE = {
  ...STOCKED,
  name: "Sparse Fixture",
  colors: [],
  radii: [],
  textStyles: [],
  uiTextStyles: [],
  effects: [],
  icons: [],
  motion: [],
}

/* ---------- loading the editor ---------- */

/**
 * The editor's browser half, as a project with THIS catalog sees it.
 *
 * `src/core/config.ts` reads `globalThis.__DESIGNLAYER_CONFIG__` once at
 * module load, exactly as it does behind the proxy, so a second catalog needs a
 * second module instance. The `__fixture` export makes each bundle's text
 * unique and therefore its `data:` URL a distinct module rather than a cache
 * hit — the same trick `host-agnostic-cases.mjs` uses for its three hosts.
 */
async function loadEditor(fixture, designSystem) {
  globalThis.__DESIGNLAYER_CONFIG__ = {
    apiBase: "/__designlayer",
    designSystem,
    // A host that names its glyphs, so `iconSection` has something to key on.
    icons: { attribute: "data-fx-icon", available: true },
    host: { framework: "react", tailwind: true },
  }
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `
        export const __fixture = ${JSON.stringify(fixture)}
        export { createContext } from "./src/core/context"
        export { installInspector } from "./src/panels/inspector"
        export { isExpanded, setExpanded } from "./src/panels/inspector/field"
        export * as inspector from "./src/panels/inspector"
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

/** The two panel-level expanders the per-side and per-corner axes sit behind. */
const RADIUS_EXPANDER = "appearance.radius"
const PRECISION_EXPANDER = "layout.spacing-precision"

/**
 * Mounts the real inspector over a fixture and hands back the Design tabpanel.
 *
 * The sections read `getComputedStyle`, `Node`, `SVGSVGElement` and friends off
 * the global scope the way they do in a browser, so the JSDOM's own have to be
 * installed there before the panel is built rather than passed in.
 *
 * `expanded` is written through `setExpanded` BEFORE the selection lands, not
 * by hunting for a toggle button afterwards. Both expanders are panel-level
 * state that outlives a fixture, so a case that did not state its own starting
 * position would inherit whatever its predecessor left behind — and the per-side
 * rows are exactly what half of these cases are asserting the absence of.
 */
async function withPanel(helpers, markup, run, { expanded = [], payload = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
  })
  const { window } = dom
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

  const right = window.document.createElement("aside")
  right.setAttribute("data-designlayer", "")
  window.document.body.append(right)
  const slot = () => {
    const node = window.document.createElement("div")
    node.setAttribute("data-designlayer", "")
    window.document.body.append(node)
    return node
  }
  const bridge = {
    elementInfo: () => ({
      tagName: "div", componentName: "Fixture", filePath: "/tmp/fixture.tsx",
      lineNumber: 1, columnNumber: 0, stack: [],
    }),
    send() {}, subscribe: () => () => {}, toast() {},
    store: {
      addPendingPropertyOperation() {},
      getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
      setCanvasTransform() {}, onCanvasTransformChange: () => () => {},
      onStateChange: () => () => {}, hasChanges: () => false,
    },
  }
  const editor = helpers.createContext(bridge, {
    overlay: slot(), toolbar: slot(), left: slot(), right,
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => payload })
  const paint = () =>
    new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
    )
  try {
    for (const key of [RADIUS_EXPANDER, PRECISION_EXPANDER]) {
      helpers.setExpanded(key, expanded.includes(key))
    }
    helpers.installInspector(editor)
    editor.select(window.document.getElementById("target"))
    await paint()
    const design = right.querySelector("#de-tabpanel-design")
    assert.ok(design, "the inspector mounted no Design tabpanel")
    await run({ window, right, design, paint, editor })
  } finally {
    globalThis.fetch = originalFetch
    // The store is module-level and outlives this window, so a selection left
    // behind is one the NEXT mount renders before it has a fixture of its own.
    editor.select(null)
    dom.window.close()
  }
}

/* ---------- reading the panel ---------- */

/** Every token binding in the tab, in document order, as bare axis names. */
const axesIn = (design) =>
  [...design.querySelectorAll('[data-de-field^="design-system."]')].map((node) =>
    node.getAttribute("data-de-field").slice("design-system.".length)
  )

/** The label each rendered binding wears — `aria-label` is `${title} token`. */
const labelsIn = (design) =>
  [...design.querySelectorAll('[data-de-field^="design-system."]')].map((node) =>
    (node.getAttribute("aria-label") ?? "").replace(/ token$/, "")
  )

const fieldFor = (design, axis) =>
  design.querySelector(`[data-de-field="design-system.${axis}"]`)

const sectionTitlesIn = (design) =>
  [...design.querySelectorAll(".de-section-title")].map((node) => node.textContent)

/** Axes drawn more than once, with their counts — the refactor's own failure. */
function duplicates(design) {
  const counts = new Map()
  for (const axis of axesIn(design)) counts.set(axis, (counts.get(axis) ?? 0) + 1)
  return [...counts].filter(([, count]) => count > 1)
}

function expectAxes(design, where, { present = [], absent = [] }) {
  const axes = axesIn(design)
  for (const axis of present) {
    assert.ok(axes.includes(axis), `${where}: ${axis} is missing — the panel drew [${axes}]`)
  }
  for (const axis of absent) {
    assert.equal(
      axes.includes(axis),
      false,
      `${where}: ${axis} should not be drawn here — the panel drew [${axes}]`
    )
  }
}

/* ---------- the scenarios ---------- */

/**
 * One element per row of the applicability table, plus the pairs that prove a
 * gate reads what it claims to.
 *
 * Every style is INLINE and every class-driven gate is given the class
 * directly: JSDOM's `getComputedStyle` resolves no cascade, so a stylesheet
 * here would assert nothing. `border-*-radius` is written as four longhands
 * because JSDOM does not expand the shorthand — `border-radius: 8px` leaves all
 * four corners at 0 and a per-corner case written the short way would pass for
 * the wrong reason.
 */
const ROUNDED = [
  "border-top-left-radius:8px",
  "border-top-right-radius:8px",
  "border-bottom-right-radius:8px",
  "border-bottom-left-radius:8px",
].join(";")

const SCENARIOS = [
  {
    name: "a plain <div>",
    markup: `<div id="target"></div>`,
    present: ["corner-radius", "margin"],
    // No background, so there is no fill to bind — Fill draws its `+` instead.
    absent: [
      "fill-color", "text-color", "text-style", "stroke-color", "ring-color",
      "outline-color", "svg-fill", "svg-stroke", "icon-size", "gap", "padding",
      "motion-duration",
    ],
  },
  {
    name: "a painted box",
    markup: `<div id="target" style="background-color:#ffffff"></div>`,
    present: ["fill-color", "corner-radius", "margin"],
    absent: ["text-color", "gap", "padding"],
  },
  {
    name: "a heading with direct text",
    markup: `<h2 id="target" style="background-color:#ffffff;color:#101418">Section title</h2>`,
    present: ["text-color", "text-style", "fill-color", "corner-radius", "margin"],
    // Text, but no element children and no layout — neither padding nor gap.
    absent: ["gap", "padding", "svg-fill", "svg-stroke", "icon-size"],
  },
  {
    name: "a wrapper whose text lives in a child",
    markup: `<div id="target"><span>Section title</span></div>`,
    // The child renders the text, so styling type here sets an inherited value
    // the child may override. `padding` arrives instead: there is a child box.
    present: ["padding", "margin", "corner-radius"],
    absent: ["text-color", "text-style"],
  },
  {
    name: "a flex container with children",
    markup: `<div id="target" style="display:flex;gap:16px;padding:16px"><span>a</span><span>b</span></div>`,
    present: ["gap", "padding", "margin", "corner-radius"],
    absent: ["text-color", "text-style", "svg-fill", "svg-stroke"],
  },
  {
    name: "a grid container with children",
    markup: `<div id="target" style="display:grid;gap:16px;padding:16px"><span>a</span><span>b</span></div>`,
    // `directionOf` reads grid as "none" and `laysOutChildren` accepts it, so
    // this is the element the two spacing owners disagree about most nearly.
    present: ["gap", "padding", "margin", "corner-radius"],
    absent: ["text-color", "text-style"],
  },
  {
    name: "a leaf <span> with no children",
    markup: `<span id="target"></span>`,
    present: ["margin", "corner-radius"],
    absent: ["gap", "padding", "text-color", "text-style"],
  },
  {
    name: "a bordered box",
    markup: `<div id="target" style="border:1px solid #123456"></div>`,
    present: ["stroke-color", "margin", "corner-radius"],
    absent: ["ring-color", "outline-color"],
  },
  {
    name: "a box with a box-shadow",
    markup: `<div id="target" style="box-shadow:0 1px 2px #0002"></div>`,
    present: ["shadow", "margin", "corner-radius"],
    absent: ["stroke-color", "ring-color"],
  },
  {
    name: "a box with a non-initial --tw-ring-shadow",
    markup: `<div id="target" style="--tw-ring-shadow:0 0 0 2px #0000ff"></div>`,
    present: ["ring-color"],
    absent: ["stroke-color", "outline-color"],
  },
  {
    name: "a box wearing a ring utility",
    markup: `<div id="target" class="ring-2"></div>`,
    present: ["ring-color"],
    absent: ["outline-color"],
  },
  {
    name: "a box carrying Tailwind's registered ring initial",
    markup: `<div id="target" style="--tw-ring-shadow:0 0 #0000"></div>`,
    // v4 registers the property, so it resolves on every element in the
    // document. A row keyed on "non-empty" would be a row on the whole page.
    present: ["margin"],
    absent: ["ring-color"],
  },
  {
    name: "an outlined box",
    markup: `<div id="target" style="outline-width:2px;outline-style:solid"></div>`,
    present: ["outline-color"],
    absent: ["stroke-color", "ring-color"],
  },
  {
    name: "an outline that is wide but not painted",
    markup: `<div id="target" style="outline-width:2px;outline-style:none"></div>`,
    present: ["margin"],
    absent: ["outline-color"],
  },
  {
    name: "an <svg>",
    markup: `<svg id="target" data-fx-icon="star"></svg>`,
    present: ["svg-fill", "svg-stroke", "margin"],
    absent: ["text-color", "text-style"],
  },
  {
    name: "a <button> whose only child is an <svg>",
    markup: `<button id="target" style="padding:8px"><svg data-fx-icon="star"></svg></button>`,
    present: ["svg-fill", "svg-stroke", "padding", "margin", "corner-radius"],
    // No text of its own, so the two type rows would edit nothing — and the
    // button is not an icon itself, so there is no icon NAME to size.
    absent: ["text-color", "text-style", "icon-size"],
  },
  {
    name: "a <button> with an <svg> and text of its own",
    markup: `<button id="target" style="color:#101418"><svg data-fx-icon="star"></svg>Save</button>`,
    // The glyph is decoration beside a label, not the thing being edited.
    present: ["text-color", "text-style", "padding"],
    absent: ["svg-fill", "svg-stroke", "icon-size"],
  },
  {
    name: "a <path> inside an <svg>",
    markup: `<svg data-fx-icon="star"><path id="target" d="M0 0h8v8z"></path></svg>`,
    // `svgTarget` asks `closest("svg")`, so a selection anywhere inside the
    // drawing paints the drawing rather than nothing.
    present: ["svg-fill", "svg-stroke"],
    absent: ["text-color", "text-style"],
  },
  {
    name: "an element with a transition",
    markup: `<div id="target" style="transition-duration:0.15s"></div>`,
    present: ["motion-duration", "margin"],
    absent: ["gap", "padding"],
  },
  {
    name: "an element with no transition",
    markup: `<div id="target"></div>`,
    present: ["margin"],
    absent: ["motion-duration"],
  },
]

/* ---------- the run ---------- */

const helpers = await loadEditor("stocked", STOCKED)

console.log("\nThe section is gone, and nothing wears its name")

/*
 * Asserted against what the module EXPORTS and what it RENDERS, not against the
 * source text. A `SECTIONS` entry can be deleted from the array and left in the
 * file, or renamed and left registered; only the panel knows which sections
 * actually ran.
 */
await checkAsync("no section named or titled `Design system` survives in the Design tab", async () => {
  assert.equal(
    "designSystemSection" in helpers.inspector,
    false,
    "`panels/inspector` still exports designSystemSection"
  )

  const seen = new Set()
  for (const scenario of SCENARIOS) {
    await withPanel(helpers, scenario.markup, ({ design }) => {
      const titles = sectionTitlesIn(design)
      assert.ok(titles.length >= 5, `${scenario.name}: the Design tab drew ${titles.length} sections`)
      for (const title of titles) seen.add(title)
    })
  }
  assert.equal(
    seen.has("Design system"),
    false,
    `a section is still titled "Design system" — the panel drew [${[...seen].sort()}]`
  )
  // The sections that DID run, so this case fails loudly on a rename rather
  // than passing because the panel quietly stopped drawing anything.
  // "Saved styles" is not a section any more: each scoped style control lives
  // in the header of the section whose properties it saves.
  const known = new Set([
    "Icon", "Responsive", "Position", "Layout", "Appearance", "Fill", "Stroke",
    "Effects", "Typography", "Classes",
  ])
  const strangers = [...seen].filter((title) => !known.has(title))
  assert.deepEqual(strangers, [], `unrecognised section titles: ${strangers.join(", ")}`)
})

await checkAsync("the TAB keeps the name, which is the thing that did not move", async () => {
  // Worth pinning next to the case above: "Design system" is still a word in
  // this panel, and a future reader deleting the last of it would be deleting
  // the libraries-and-audit tab, which was never part of this refactor.
  await withPanel(helpers, `<div id="target"></div>`, ({ right, design }) => {
    const tabs = [...right.querySelectorAll(".de-tab")].map((node) => node.textContent)
    assert.deepEqual(tabs, ["Design", "Changes", "Design system"])
    assert.equal(sectionTitlesIn(design).includes("Design system"), false)
  })
})

console.log("\nProperty 1: no row was lost")

check("no scenario claims to prove `shadow` is absent", () => {
  // The one gate with no negative here, guarded rather than remembered: JSDOM
  // computes `box-shadow` as "" where a browser answers "none", so the row is
  // drawn on every element and an `absent: ["shadow"]` would fail for a reason
  // that has nothing to do with the refactor.
  const wrong = SCENARIOS.filter((scenario) =>
    (scenario.absent ?? []).includes(SHADOW_IS_UNGATED_UNDER_JSDOM)
  ).map((scenario) => scenario.name)
  assert.deepEqual(wrong, [], "see the header: `shadow` has no negative under JSDOM")
})

for (const scenario of SCENARIOS) {
  await checkAsync(`${scenario.name} still reaches every axis it can carry`, async () => {
    await withPanel(helpers, scenario.markup, ({ design }) => {
      expectAxes(design, scenario.name, { present: scenario.present, absent: scenario.absent })
    })
  })
}

console.log("\nProperty 2: no row is drawn twice")

await checkAsync("no axis is drawn twice on any scenario element", async () => {
  for (const scenario of SCENARIOS) {
    await withPanel(helpers, scenario.markup, ({ design }) => {
      const drawn = duplicates(design)
      assert.deepEqual(
        drawn,
        [],
        `${scenario.name}: ${drawn.map(([axis, count]) => `${axis} x${count}`).join(", ")}`
      )
      // A tab with no bindings at all would make the check above vacuous.
      assert.ok(axesIn(design).length > 0, `${scenario.name}: no bindings rendered`)
    })
  }
})

/*
 * The two elements the arbitration was written for, asserted directly.
 *
 * On a flex container `drawsSpacingControls` says yes, so the auto-layout block
 * houses gap and padding under its own number fields and `spacingBindings`
 * stands down. On a grid container it says no — `directionOf` reads grid as
 * "none" — so the block draws only its flow strip and the bindings come from
 * `spacingBindings` instead. Same one control each way, from opposite files.
 */
await checkAsync("a flex container gets exactly one gap and one padding, under the number fields", async () => {
  await withPanel(
    helpers,
    `<div id="target" style="display:flex;gap:16px;padding:16px"><span>a</span></div>`,
    ({ design }) => {
      assert.equal(design.querySelectorAll('[data-de-field="design-system.gap"]').length, 1)
      assert.equal(design.querySelectorAll('[data-de-field="design-system.padding"]').length, 1)
      // Housed: the binding sits in the auto-layout block's own `Gap` group,
      // beside `autolayout.gap`, not in a captioned row further down.
      const gap = fieldFor(design, "gap")
      const group = gap.closest(".de-group")
      assert.ok(group, "the gap binding is not inside a captioned group")
      assert.ok(
        group.querySelector('[data-de-field="autolayout.gap"]'),
        "the gap binding did not land under the gap number field"
      )
      const padding = fieldFor(design, "padding")
      assert.ok(
        padding.closest(".de-group").querySelector('[data-de-field="autolayout.padding"]'),
        "the padding binding did not land under the padding number field"
      )
    }
  )
})

await checkAsync("a grid container gets exactly one gap and one padding, from the other file", async () => {
  await withPanel(
    helpers,
    `<div id="target" style="display:grid;gap:16px;padding:16px"><span>a</span></div>`,
    ({ design }) => {
      assert.equal(design.querySelectorAll('[data-de-field="design-system.gap"]').length, 1)
      assert.equal(design.querySelectorAll('[data-de-field="design-system.padding"]').length, 1)
      // Not housed: the auto-layout block drew no number fields for either, so
      // these are `spacingBindings`' own captioned rows.
      assert.equal(design.querySelector('[data-de-field="autolayout.gap"]'), null)
      assert.equal(design.querySelector('[data-de-field="autolayout.padding"]'), null)
      assert.equal(fieldFor(design, "gap").getAttribute("aria-label"), "Container gap token")
    }
  )
})

await checkAsync("a flex container with no children keeps its gap and loses its padding", async () => {
  // The asymmetry is the point: `laysOutChildren` is about display and
  // `hasChildren` is about content, so a childless flex box has a gap to bind
  // and nothing to pad. `drawsSpacingControls` says no, so both come from
  // `spacingBindings` — the branch where a dropped `!housed` would double up.
  await withPanel(helpers, `<div id="target" style="display:flex;gap:16px"></div>`, ({ design }) => {
    expectAxes(design, "childless flex", { present: ["gap", "margin"], absent: ["padding"] })
    assert.deepEqual(duplicates(design), [])
  })
})

console.log("\nThe per-side and per-corner axes, in both states")

await checkAsync("the per-side spacing axes are absent until the expander is opened", async () => {
  const markup = `<div id="target" style="display:flex;gap:16px;padding:16px"><span>a</span></div>`
  const PER_SIDE = [
    "row-gap", "column-gap",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
  ]
  await withPanel(helpers, markup, ({ design }) => {
    expectAxes(design, "spacing folded", { present: ["gap", "padding", "margin"], absent: PER_SIDE })
  })
  await withPanel(
    helpers,
    markup,
    ({ design }) => {
      expectAxes(design, "spacing unfolded", { present: ["gap", "padding", "margin", ...PER_SIDE] })
      assert.deepEqual(duplicates(design), [], "unfolding doubled a spacing axis")
    },
    { expanded: [PRECISION_EXPANDER] }
  )
})

await checkAsync("the per-side axes follow the same gates their uniform rows do", async () => {
  // A leaf has no children to pad and lays out nothing, so opening the expander
  // must lengthen the margin list and nothing else.
  await withPanel(
    helpers,
    `<span id="target"></span>`,
    ({ design }) => {
      expectAxes(design, "leaf unfolded", {
        present: ["margin", "margin-top", "margin-right", "margin-bottom", "margin-left"],
        absent: ["row-gap", "column-gap", "padding-top", "padding-left"],
      })
    },
    { expanded: [PRECISION_EXPANDER] }
  )
})

await checkAsync("the four corner axes appear only for a box that has corners", async () => {
  const rounded = `<div id="target" style="${ROUNDED}"></div>`
  const CORNERS = [
    "corner-radius-top-left", "corner-radius-top-right",
    "corner-radius-bottom-right", "corner-radius-bottom-left",
  ]
  await withPanel(helpers, rounded, ({ design }) => {
    expectAxes(design, "radius folded", { present: ["corner-radius"], absent: CORNERS })
  })
  await withPanel(
    helpers,
    rounded,
    ({ design }) => {
      expectAxes(design, "radius unfolded", { present: CORNERS })
      assert.deepEqual(duplicates(design), [], "unfolding doubled a corner axis")
    },
    { expanded: [RADIUS_EXPANDER] }
  )
  // A `rounded-*` utility is the other half of the gate, and the only evidence
  // there is when the radius arrives from a stylesheet JSDOM never reads.
  await withPanel(
    helpers,
    `<div id="target" class="rounded-lg"></div>`,
    ({ design }) => expectAxes(design, "rounded utility unfolded", { present: CORNERS }),
    { expanded: [RADIUS_EXPANDER] }
  )
})

/*
 * FIXED, and the case is kept as the guard rather than deleted.
 *
 * `section-appearance.ts` puts the uniform binding and the four per-corner ones
 * in the two arms of one `perCorner ? … : …`, and the per-corner arm carries a
 * second gate — `cornerTokens`, meaning some corner above 0 or a `rounded*`
 * class. For one release those two facts combined into a hole: a SQUARE box with
 * the per-corner toggle OPEN bound no radius at all, because the uniform row had
 * gone with the fold and the four meant to replace it were gated away. The one
 * arrangement in which a designer had asked for more corner control was the one
 * with less.
 *
 * It could not happen before the token rows moved into this section — the
 * uniform binding lived in the dissolved `Design system` section behind its own
 * double chevron, where the Appearance toggle could not reach it. That is what
 * makes it worth a permanent case: the defect was created by the merge, so it
 * is the merge that has to keep being tested.
 *
 * `cornerTokens` now chooses between the FOUR and the ONE, never between the
 * four and nothing.
 */
await checkAsync("a square box binds its radius in both states of the corner toggle", async () => {
  await withPanel(
    helpers,
    `<div id="target"></div>`,
    ({ design }) => {
      expectAxes(design, "square box, toggle open", { present: ["corner-radius"] })
      // The four per-corner bindings stay out: a square box has no corner for
      // them to be about, which is the gate doing its job rather than failing.
      assert.deepEqual(
        axesIn(design).filter((axis) => axis.startsWith("corner-radius-")),
        [],
        "a square box grew four per-corner bindings it has no corners for"
      )
      // The per-corner NUMBER fields are still there, so the fold did open.
      assert.ok(
        design.querySelector('[data-de-field="appearance.radius.top-left"]'),
        "the per-corner number fields went missing, so the toggle did not open"
      )
    },
    { expanded: [RADIUS_EXPANDER] }
  )
  await withPanel(helpers, `<div id="target"></div>`, ({ design }) => {
    expectAxes(design, "square box folded", { present: ["corner-radius"] })
  })
})

/*
 * FIXED, and kept as the guard for the same reason as the case above.
 *
 * The rule the dissolved section applied was "a border wider than 0, OR a
 * `border*` class", and `token-row.ts` exports `hasBorder` to say exactly that
 * disjunction. For one release nothing called it: `section-stroke.ts` gated the
 * binding on its own `visible` — computed width and style alone — while a
 * comment beside it claimed the table agreed. The utility half of the gate had
 * been dropped, and the dead export was the evidence it was meant to survive.
 *
 * A browser hid almost all of the cost, which is what makes this worth pinning:
 * `class="border"` computes to 1px there, so `visible` is usually true anyway
 * and the loss only appears somewhere the stylesheet has not resolved.
 *
 * The binding is now drawn from the empty state too, captioned, because with no
 * paint row to fold into the axis has to name itself.
 */
await checkAsync("a border utility alone still reaches the stroke binding", async () => {
  await withPanel(helpers, `<div id="target" class="border border-solid"></div>`, ({ design }) => {
    expectAxes(design, "border utility only", { present: ["margin", "stroke-color"] })
  })
  // Its two siblings always carried their class half, and still do.
  await withPanel(helpers, `<div id="target" class="ring-2"></div>`, ({ design }) =>
    expectAxes(design, "ring utility only", { present: ["ring-color"] })
  )
  await withPanel(helpers, `<div id="target" class="outline-dashed"></div>`, ({ design }) =>
    expectAxes(design, "outline utility only", { present: ["outline-color"] })
  )
  // And an element with neither a border nor a border class still gets none:
  // the fix widened the gate, it did not remove it.
  await withPanel(helpers, `<div id="target"></div>`, ({ design }) =>
    expectAxes(design, "no border at all", { absent: ["stroke-color"] })
  )
})

/*
 * FIXED, and the third of the three the merge broke.
 *
 * `icon-size` used to need TWO gates to pass: `iconSection` needs `iconNameOf`
 * — an `<svg>` carrying the host's icon attribute — and `sizeRow` went through
 * `iconTarget`, which answers with the selection only for an `<img>` or an
 * element carrying `role="img"`, and otherwise looks for a single `<svg>`
 * INSIDE the selection. A bare `<svg>` contains no `<svg>`, so neither arm
 * fired and the row appeared only for `<svg role="img">`. The editor never
 * writes that attribute and Lucide's output does not emit it, so in practice
 * the row was unreachable in the only situation this section runs in.
 *
 * `sizeRow` now targets the selection directly, which is the question this
 * section has already answered by the time it draws anything.
 */
await checkAsync("an <svg> the icon set names binds its size, with or without role=img", async () => {
  await withPanel(helpers, `<svg id="target" data-fx-icon="star"></svg>`, ({ design }) => {
    assert.ok(sectionTitlesIn(design).includes("Icon"), "the Icon section did not draw at all")
    assert.ok(design.querySelector('[data-de-field="icon.name"]'), "the icon name field is missing")
    expectAxes(design, "svg without role=img", {
      present: ["svg-fill", "svg-stroke", "icon-size"],
    })
    assert.equal(fieldFor(design, "icon-size").getAttribute("aria-label"), "Icon size token")
  })
  // `role="img"` is no longer load-bearing, so it must change nothing.
  await withPanel(helpers, `<svg id="target" data-fx-icon="star" role="img"></svg>`, ({ design }) => {
    expectAxes(design, "svg with role=img", { present: ["icon-size"] })
  })
  // The icon-only host still reaches the glyph's PAINT and not its size:
  // `iconNameOf` refuses a `<button>`, so there is no Icon section to put a
  // size row in. That narrowing is deliberate and documented in the section.
  await withPanel(
    helpers,
    `<button id="target"><svg data-fx-icon="star"></svg></button>`,
    ({ design }) => {
      assert.equal(sectionTitlesIn(design).includes("Icon"), false)
      expectAxes(design, "icon-only button", {
        present: ["svg-fill", "svg-stroke"],
        absent: ["icon-size"],
      })
    }
  )
})

await checkAsync("the toggles really drive the keys these cases write", async () => {
  // Otherwise every state above is asserted against an expander the panel's own
  // buttons have stopped being wired to.
  await withPanel(
    helpers,
    `<div id="target" style="display:flex;gap:16px;padding:16px;${ROUNDED}"><span>a</span></div>`,
    async ({ design, paint }) => {
      assert.equal(helpers.isExpanded(PRECISION_EXPANDER), false)
      design.querySelector('[aria-label="Show per-side tokens"]').click()
      await paint()
      assert.equal(helpers.isExpanded(PRECISION_EXPANDER), true)
      expectAxes(design, "after the per-side click", { present: ["margin-top", "row-gap"] })

      assert.equal(helpers.isExpanded(RADIUS_EXPANDER), false)
      design.querySelector('[aria-label="Set each corner"]').click()
      await paint()
      assert.equal(helpers.isExpanded(RADIUS_EXPANDER), true)
      expectAxes(design, "after the per-corner click", { present: ["corner-radius-top-left"] })
      assert.deepEqual(duplicates(design), [])
    }
  )
})

console.log("\nThe rows read as controls, not as inserts from somewhere else")

/*
 * The caption RANK, which was a real defect found in review.
 *
 * These rows drew `.de-layout-group-title` while every neighbour was another
 * token row, so the titles were peers of each other. Out in Typography and
 * Stroke every neighbour is a `group()` caption — `Font`, `Color`, `Opacity` —
 * at `.de-group-caption`: caption size, body weight, dim ink.
 * `.de-layout-group-title` is body size, section weight, full-strength ink, the
 * rank `Auto layout` uses for a whole feature. Keeping it made `Ring color`
 * shout over `Font` in the same column.
 *
 * The labels are read off the rendered fields rather than listed here, so a
 * renamed row cannot slip out of the check.
 */
await checkAsync("a token row's caption is a group caption, never a layout-group title", async () => {
  const markup =
    `<div id="target" class="ring-2" style="background-color:#ffffff;color:#101418;` +
    `border:1px solid #123456;outline-width:2px;outline-style:solid;` +
    `box-shadow:0 1px 2px #0002;transition-duration:0.15s;display:flex;gap:16px;padding:16px;${ROUNDED}">` +
    `Hello<span>a</span></div>`
  await withPanel(helpers, markup, ({ design }) => {
    const labels = labelsIn(design)
    assert.ok(labels.length >= 10, `only ${labels.length} bindings rendered: ${labels}`)
    const quiet = [...design.querySelectorAll(".de-group-caption")].map((n) => n.textContent)
    const loud = [...design.querySelectorAll(".de-layout-group-title")].map((n) => n.textContent)

    const shouting = loud.filter((text) => labels.includes(text))
    assert.deepEqual(
      shouting,
      [],
      `these token rows are captioned at the Auto-layout rank: ${shouting.join(", ")}`
    )

    // The captioned blocks — `tokenRow` call sites, the axes with no control of
    // their own to fold into — name themselves at the rank their neighbours use.
    for (const label of [
      "Ring color", "Outline color", "Shadow / effect", "Motion duration",
      "Text style", "Uniform margin",
    ]) {
      assert.ok(quiet.includes(label), `"${label}" is not captioned as a group caption`)
    }

    // And the folded ones carry no caption of their own, which is the other
    // half of "one control rather than two": the paint row is already named by
    // its section, and a second heading would put the axis on screen twice.
    for (const label of ["Fill color", "Stroke color", "Text color"]) {
      assert.equal(quiet.includes(label), false, `"${label}" grew a caption of its own`)
    }
    for (const [axis, title] of [["fill-color", "Fill"], ["stroke-color", "Stroke"]]) {
      const field = fieldFor(design, axis)
      assert.ok(field.closest(".de-paint-row"), `${axis} is not in the section's paint row`)
      assert.equal(field.closest(".de-group"), null, `${axis} was given a group of its own`)
      assert.equal(
        field.closest(".de-section").querySelector(".de-section-title").textContent,
        title
      )
    }

    // The block captions that legitimately DO wear the loud rank, so the
    // negative above is not passing because nothing uses the class.
    for (const title of ["Auto layout", "Spacing"]) {
      assert.ok(loud.includes(title), `${title} should be a layout-group title, and is not`)
    }
  })
})

/*
 * One swatch per paint row — also a real defect found in review.
 *
 * A fill, a stroke and a text colour are each `[well] [value]`, where the well
 * is a live `input[type=color]`. Folding the binding in where the value sat put
 * the field's OWN chip 4px to the right of the well: two swatches of one
 * colour, only one of which does anything. `hidePreview` in `token-picker.ts`
 * is the fix, and it is per-row rather than global — the rows the picker leads
 * still need their mark.
 */
await checkAsync("the three paint rows draw exactly one colour well and no second chip", async () => {
  await withPanel(
    helpers,
    `<div id="target" style="background-color:#ffffff;color:#101418;border:1px solid #123456">Hello</div>`,
    ({ design }) => {
      for (const axis of ["fill-color", "stroke-color", "text-color"]) {
        const field = fieldFor(design, axis)
        assert.ok(field, `${axis} has no row`)
        const row = field.closest(".de-paint-row") ?? field.parentElement
        assert.equal(
          row.querySelectorAll('input[type="color"]').length,
          1,
          `${axis}: the row does not hold exactly one colour well`
        )
        assert.equal(
          row.querySelectorAll(".de-token-swatch").length,
          0,
          `${axis}: the field drew a second, dead swatch beside the live well`
        )
      }

      // Targeted, not global: a row with no well beside it keeps its preview,
      // which is the only mark it gets.
      assert.equal(
        fieldFor(design, "corner-radius").querySelectorAll(".de-token-swatch").length,
        1,
        "the radius row lost the preview that is its only mark"
      )
      assert.equal(
        fieldFor(design, "margin").querySelectorAll(".de-token-swatch").length,
        1,
        "the margin row lost its leading slot, so its name column no longer aligns"
      )
    }
  )
})

console.log("\nAn axis the catalog does not stock")

const sparse = await loadEditor("sparse", SPARSE)

await checkAsync("an unstocked axis renders no field and no empty captioned group", async () => {
  await withPanel(
    sparse,
    `<div id="target" class="ring-2" style="background-color:#ffffff;color:#101418;` +
      `border:1px solid #123456;box-shadow:0 1px 2px #0002;transition-duration:0.15s;` +
      `display:flex;gap:16px;padding:16px;${ROUNDED}">Hello<span>a</span></div>`,
    ({ design }) => {
      // Every gate on this element passes. Only the shelves are bare.
      expectAxes(design, "sparse catalog", {
        present: ["gap", "padding", "margin"],
        absent: [
          "fill-color", "text-color", "stroke-color", "ring-color", "outline-color",
          "svg-fill", "svg-stroke", "corner-radius", "text-style", "shadow",
          "icon-size", "motion-duration",
        ],
      })

      // `tokenRow` returns null before it builds anything, so the caption never
      // reaches the DOM either — an axis with no tokens must not cost a heading.
      const captions = [...design.querySelectorAll(".de-group-caption")].map((n) => n.textContent)
      for (const orphan of [
        "Shadow / effect", "Text style", "Ring color", "Outline color",
        "SVG fill", "SVG stroke", "Motion duration", "Icon size",
      ]) {
        assert.equal(captions.includes(orphan), false, `"${orphan}" is a caption over nothing`)
      }
      // The stocked half still captions its rows, so the check above is not
      // passing because the panel drew no captions at all.
      for (const kept of ["Uniform margin"]) {
        assert.ok(captions.includes(kept), `"${kept}" went missing from a stocked axis`)
      }

      // And the sections draw their OWN controls instead, which is what a null
      // binding is the signal for.
      assert.ok(
        design.querySelector(".de-paint-value"),
        "Fill dropped its plain hex readout as well as its binding"
      )
      assert.ok(
        design.querySelector('[data-de-field="type.color"]'),
        "Typography dropped its colour field instead of falling back to it"
      )
      assert.ok(
        design.querySelector('[data-de-field="appearance.radius"]'),
        "Appearance dropped its radius number field"
      )
    }
  )
})

await checkAsync("the stocked catalog is what makes the sparse one meaningful", async () => {
  // The same element under the full catalog, so the case above is a statement
  // about stocking rather than about the element's gates.
  await withPanel(
    helpers,
    `<div id="target" class="ring-2" style="background-color:#ffffff;color:#101418;` +
      `border:1px solid #123456;box-shadow:0 1px 2px #0002;transition-duration:0.15s;` +
      `display:flex;gap:16px;padding:16px;${ROUNDED}">Hello<span>a</span></div>`,
    ({ design }) => {
      expectAxes(design, "stocked catalog", {
        present: [
          "fill-color", "text-color", "stroke-color", "ring-color", "corner-radius",
          "text-style", "shadow", "motion-duration", "gap", "padding", "margin",
        ],
      })
      assert.deepEqual(duplicates(design), [])
    }
  )
})

console.log("\nAn enabled library's tokens match by value too")

/*
 * The computed fallback reads the MERGED catalog, as the authored match and the
 * picker do. It used to read the host's alone, so a library token was offered
 * in the picker while the field sitting on exactly its value — a plain class,
 * Angular CSS, anything that is not a `var()` — read back as a raw colour.
 */
const withLibrary = await loadEditor("library", SPARSE)
await checkAsync("a plain value equal to a library token reads as that token", async () => {
  const library = {
    id: "brand",
    name: "Brand",
    enabled: true,
    source: { kind: "file", path: "brand.json" },
    addedAt: 0,
    counts: { iconDrawings: 0 },
    catalog: {
      colors: [
        {
          id: "color:pink",
          name: "Brand/Pink",
          category: "color",
          values: { default: "#ff0066" },
          cssVar: "--brand-pink",
        },
      ],
      spacing: [], radii: [], textStyles: [], uiTextStyles: [], effects: [], icons: [], motion: [],
      components: [],
    },
  }
  await withPanel(
    withLibrary,
    `<div id="target" style="--brand-pink:#ff0066;background-color:rgb(255, 0, 102)"></div>`,
    async ({ design, editor, window, paint }) => {
      // The library list lands after the first paint; a refresh re-reads it.
      await new Promise((resolve) => setTimeout(resolve, 0))
      editor.refresh()
      await paint()
      const field = fieldFor(design, "fill-color")
      assert.ok(field, "the fill row drew no token field")
      assert.match(field.textContent, /Pink/, `the field read "${field.textContent}"`)
    },
    { payload: { libraries: [library] } }
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
