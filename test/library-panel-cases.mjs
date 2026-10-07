/**
 * The browser half of libraries: the MERGE that makes a library's tokens
 * indistinguishable from the host's, and the one inspector section that reads
 * back out of the catalog the merge produces.
 *
 * Bundled with esbuild and run in JSDOM against a stubbed `fetch`, the same way
 * `token-cases.mjs` and `inspector-tabs-cases.mjs` run the rest of the client.
 * No server: what these cases are about is what the client does with a library
 * payload, and starting a real one would only add a second thing that can fail.
 *
 * MANAGING the list of libraries is not here, and browsing one no longer
 * exists at all. Add, toggle and remove live in the Libraries section on the
 * right panel's Design system tab and are covered end to end by
 * `design-system-tab-cases.mjs`, which drives the same store through the same
 * stubbed fetch; the component grid that used to sit beside them in the left
 * rail was deleted rather than moved. What is left in this file is the half of
 * the feature that has no surface of its own — a catalog, and an element that
 * turns out to be described by it.
 *
 * What is worth pinning, and why each one is a claim that would be lost quietly
 * rather than loudly:
 *
 *  - **the zero-library path costs nothing.** `activeDesignSystem()` returns the
 *    host's own catalog BY IDENTITY when nothing is enabled. Almost every
 *    session is this session, and a merge that rebuilt an equal-but-different
 *    object on every inspector render would be invisible in every assertion
 *    written with `deepEqual` — while breaking every `===` in the rest of the
 *    editor and rebuilding a 115-token catalog on every number scrub;
 *  - **two libraries may ship the same token.** `color:brand-500` is the most
 *    ordinary name a design system has, so two of them colliding is the normal
 *    case, not the edge. The id prefix is the only thing that stops the second
 *    library's brand colour from replacing the first in the token index — and
 *    the failure is silent: the picker shows the right number of rows and one
 *    of them writes the wrong variable;
 *  - **the inspector cannot tell the difference.** `authoredTokenMatches` binds
 *    an element whose inline style names a LIBRARY variable to that library's
 *    token, through the same code path and the same default registry the host's
 *    own tokens go through. That single assertion is the whole feature stated
 *    once: a library was added, and a real element is now described by it. If
 *    only one case in this file survives, it should be that one;
 *  - **the merge shows up as prose, too.** The inspector's instance section is
 *    the other end of the same catalog: select an element the bridge calls
 *    `Button` and, if an enabled library declares a `Button`, the inspector
 *    shows what that library says about it. It belongs to the LIBRARY rather
 *    than to the name, so turning the library off has to take the section with
 *    it — and the failure either way is a block that simply does not render,
 *    which reads from the outside like "this element is not from a library"
 *    rather than like a bug;
 *  - **and that section is ONE section over TWO sources.** The same block draws
 *    the axes a component's own SOURCE declares and the props a LIBRARY
 *    documents, so the cases below cover the seam the split used to hide: which
 *    of the two wins a name they both claim, which documented props earn a
 *    control and which are only stated, and what a control that cannot reach
 *    the file does instead. The axis half in isolation is `variant-cases.mjs`;
 *  - **a stylesheet nobody registered is a surface nobody styled.** The rules
 *    are asserted as CSS TEXT, not as geometry, because JSDOM parses a sheet
 *    and lays nothing out — every width it reports is the stub installed at the
 *    top of this file. Text is also the only honest way to ask the question
 *    that actually shipped broken this week: `assetsCss` existed, was correct,
 *    and was concatenated into nothing, so the assets browser rendered
 *    completely unstyled and no test noticed.
 *
 * The merge cases drive the real store, not a mock of it: the libraries arrive
 * over the stubbed fetch and are folded in by `refreshLibraries`, and every
 * enable is a PATCH whose response the store adopts. A catalog assembled from
 * rows the test injected itself would pass while wired to nothing.
 *
 * Usage: node designlayer/test/library-panel-cases.mjs
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

/**
 * A host design system with exactly one colour in it.
 *
 * One is enough and two would be noise: every case below is about what happens
 * to the tokens AROUND the host's, and a single host token makes "host first,
 * then each library in list order" readable as an index rather than a count.
 */
const HOST_COLOR = {
  id: "color:ink",
  name: "Ink",
  category: "color",
  cssVar: "--host-ink",
  values: { light: "#101319" },
}

globalThis.__DESIGNLAYER_CONFIG__ = {
  apiBase: API,
  designSystem: {
    name: "Host",
    trackingUnit: "em",
    colors: [HOST_COLOR],
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
  host: { framework: "react", tailwind: true },
}

const dom = new JSDOM(
  '<!doctype html><html><body><main id="app"><button id="cta">Go</button></main></body></html>',
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom
window.document.elementsFromPoint = () => window.__stack ?? []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
}
window.Element.prototype.scrollIntoView = function scroll() {}
globalThis.DOMMatrixReadOnly = class {
  constructor() {
    this.m41 = 0
    this.m42 = 0
  }
}
for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement",
  "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement", "SVGSVGElement",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, {
    value: key === "getComputedStyle" ? window.getComputedStyle.bind(window) : window[key],
    configurable: true,
    writable: true,
  })
}

// ── The library payloads the stubbed server serves ─────────────────────────

/**
 * Two libraries that deliberately ship the SAME token id.
 *
 * `color:brand-500` is what both of them call their brand colour, because that
 * is what two real design systems would call it. They differ only in the
 * variable behind it, which is what makes a mis-keyed merge visible: the wrong
 * prefix and `--meridian-brand-500` starts resolving to Nimbus's token.
 */
const libraryColor = (slug, cssVar, light) => ({
  id: `color:${slug}`,
  name: slug,
  category: "color",
  cssVar,
  values: { light },
})

const emptyCatalog = (name) => ({
  name,
  trackingUnit: "em",
  colors: [],
  spacing: [],
  radii: [],
  textStyles: [],
  uiTextStyles: [],
  effects: [],
  icons: [],
  motion: [],
  components: [],
  iconDrawings: [],
  iconAttribute: "",
})

const NIMBUS = {
  id: "src-styles-theme-css",
  name: "Nimbus",
  enabled: false,
  source: { kind: "css", path: "src/styles/theme.css" },
  addedAt: 1737000000000,
  counts: {
    colors: 2, spacing: 1, radii: 0, textStyles: 0, effects: 0,
    icons: 0, motion: 0, components: 0, iconDrawings: 0,
  },
  catalog: {
    ...emptyCatalog("Nimbus"),
    colors: [
      libraryColor("brand-500", "--nimbus-brand-500", "#5b8cff"),
      libraryColor("surface", "--nimbus-surface", "#ffffff"),
    ],
    spacing: [
      {
        id: "spacing:md",
        name: "md",
        category: "spacing",
        cssVar: "--nimbus-space-md",
        values: { default: 16 },
      },
    ],
  },
}

const MERIDIAN = {
  id: "design-meridian-json",
  name: "Meridian",
  enabled: false,
  source: { kind: "manifest", path: "design/meridian.json" },
  addedAt: 1737000001000,
  counts: {
    colors: 1, spacing: 0, radii: 0, textStyles: 0, effects: 0,
    icons: 0, motion: 0, components: 1, iconDrawings: 0,
  },
  catalog: {
    ...emptyCatalog("Meridian"),
    colors: [libraryColor("brand-500", "--meridian-brand-500", "#93b0ff")],
    components: [
      {
        id: "component:button",
        name: "Button",
        description: "The primary action control.",
        file: "design/button.md",
        snippet: '<Button variant="primary">Label</Button>',
        /*
         * A selector as well as a name, because the two joins are not
         * interchangeable and one case below needs the tag.
         *
         * It costs the cases that do not use it nothing: every element they
         * build is a bare `<button>` or `<div>` with no `<app-button>` anywhere
         * above it, so the host climb finds nothing and hands the selection
         * straight back. What it buys is the ability to state the Angular
         * shape — a component whose inputs live on a host tag the click never
         * lands on.
         */
        selector: "app-button",
        /*
         * Four props, one of each kind the instance section has to tell apart.
         *
         * `variant` is a string union, and whether it becomes a dropdown
         * depends entirely on whether the selected element is wearing it.
         * `disabled` is a boolean the DOM reflects natively on a `<button>`,
         * so it is readable and writable with no attribute in the markup;
         * `showIcon` is a boolean nothing reflects, so it is writable only
         * once a template has spelled it out. `onPress` is the kind no control
         * could ever be honest about.
         */
        props: [
          { name: "variant", type: "enum", values: ["primary", "ghost"], default: "primary" },
          { name: "disabled", type: "boolean" },
          { name: "showIcon", type: "boolean" },
          { name: "onPress", type: "() => void" },
        ],
      },
    ],
  },
}

/**
 * What the project's own source says about the same component.
 *
 * `variant` is deliberately a name MERIDIAN documents too: that collision is
 * the merge rule, and a fixture where the two sources never overlap could not
 * tell a working merge from a section that simply renders both lists.
 */
const VARIANT_FILE = "src/ui/button.ts"
const VARIANT_DECLARATIONS = [
  {
    name: "buttonVariants",
    recognizer: "cva",
    axes: [
      {
        name: "variant",
        defaultOption: "primary",
        options: [
          { name: "primary", classes: ["bg-primary"], resolved: true },
          { name: "ghost", classes: ["bg-transparent"], resolved: true },
        ],
      },
    ],
  },
]

/**
 * The server, as far as the client is concerned.
 *
 * It holds the library rows rather than answering from a constant, because the
 * enable flag is the thing under test and a PATCH has to be visible to the
 * store that reads its response back. Only the two routes the merge travels
 * over are here — the list, and the flag — because the add/remove flows moved
 * to the Libraries section and are driven, over their own stub, by
 * `design-system-tab-cases.mjs`.
 */
const server = {
  libraries: [],
  reset() {
    server.libraries = []
  },
}

const clone = (value) => JSON.parse(JSON.stringify(value))

async function serve(input, init = {}) {
  const url = new URL(String(input), "http://localhost")
  const method = (init.method ?? "GET").toUpperCase()
  const rest = url.pathname.slice(API.length)
  const body = init.body ? JSON.parse(init.body) : null

  const reply = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })

  if (rest === "/libraries" && method === "GET") {
    return reply({ libraries: clone(server.libraries) })
  }

  /*
   * The OTHER source the instance section reads, and the reason it is here.
   *
   * A merged row needs a source-declared axis and a library-documented prop
   * with the same name, so the two halves have to be servable from one suite.
   * This is the shape `server/variants.mjs` produces, parsed out of the
   * project's own `cva`/`tailwind-variants` call — the parse itself is covered
   * by `variant-cases.mjs` and is not re-litigated here.
   */
  if (rest === "/variants" && method === "GET") {
    const file = url.searchParams.get("file")
    return reply({ declarations: file === VARIANT_FILE ? clone(VARIANT_DECLARATIONS) : [] })
  }

  const keyed = /^\/libraries\/([a-z0-9-]+)$/.exec(rest)
  if (keyed && method === "PATCH") {
    const library = server.libraries.find((entry) => entry.id === keyed[1])
    if (!library) return { ok: false, status: 404, json: async () => ({ message: "No such library" }) }
    Object.assign(library, body)
    return reply({ library: clone(library) })
  }

  // Everything else the chrome asks for while the context is alive.
  return reply({})
}

globalThis.fetch = serve
window.fetch = serve

// ── The bundle ─────────────────────────────────────────────────────────────

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export {
        activeDesignSystem, libraryComponents, libraryList, refreshLibraries,
        setLibraryEnabled, subscribeToLibraries,
      } from "./src/libraries/store"
      export { instanceSection } from "./src/panels/inspector/section-instance"
      export { loadVariants } from "./src/core/variants"
      export { createWriter } from "./src/core/writer"
      export { previewOnlyChanges, resetPreviewOnlyForTest } from "./src/core/change-prompt"
      export { authoredTokenMatches, tokensForProperty } from "./src/core/design-system"
      export { config } from "./src/core/config"
      export { createContext } from "./src/core/context"
      export { shellCss } from "./src/core/css"
      export { optionsCss } from "./src/core/css/options"
      export { librariesCss } from "./src/core/css/libraries"
      export { insertCss } from "./src/core/css/insert"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const editor = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

/** The state every merge case starts from: both libraries known, both off. */
async function loadBoth() {
  server.reset()
  server.libraries = [clone(NIMBUS), clone(MERIDIAN)]
  await editor.refreshLibraries(API)
}

const colorIds = () =>
  editor.tokensForProperty("fill-color", editor.activeDesignSystem()).map((token) => token.id)

// ── The merge ──────────────────────────────────────────────────────────────

console.log("\nThe merged design system")

await check("no library enabled costs nothing and changes no identity", async () => {
  server.reset()
  assert.deepEqual(editor.libraryList(), [], "the cache is not empty before the first load")
  assert.equal(
    editor.activeDesignSystem(),
    editor.config.designSystem,
    "the zero-library path rebuilt the catalog"
  )

  await loadBoth()
  assert.equal(editor.libraryList().length, 2)
  assert.equal(
    editor.activeDesignSystem(),
    editor.config.designSystem,
    "two DISABLED libraries were still merged in"
  )
  assert.deepEqual(colorIds(), ["color:ink"])
})

await check("an enabled library's colours follow the host's, named for their library", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, NIMBUS.id, true)

  const merged = editor.activeDesignSystem()
  assert.notEqual(merged, editor.config.designSystem, "enabling a library changed nothing")
  assert.deepEqual(colorIds(), [
    "color:ink",
    `${NIMBUS.id}/color:brand-500`,
    `${NIMBUS.id}/color:surface`,
  ])

  const [host, brand] = editor.tokensForProperty("fill-color", merged)
  assert.equal("library" in host, false, "a host token was stamped with a library")
  assert.equal(brand.library, NIMBUS.id)
  assert.equal(brand.libraryName, "Nimbus")
  assert.equal(brand.cssVar, "--nimbus-brand-500")
  assert.equal(brand.name, "brand-500", "the display name was mangled by the id prefix")

  // Copied, not renamed in place: the cached library still describes itself the
  // way the server sent it, so a second merge cannot prefix a prefixed id.
  assert.equal(editor.libraryList()[0].catalog.colors[0].id, "color:brand-500")

  // The other groups come through the same way, and the host's own extras are
  // carried over rather than recomputed.
  assert.deepEqual(
    editor.tokensForProperty("gap", merged).map((token) => token.id),
    [`${NIMBUS.id}/spacing:md`]
  )
  assert.equal(merged.trackingUnit, editor.config.designSystem.trackingUnit)
  assert.equal(merged.aliases, editor.config.designSystem.aliases)
})

/*
 * The collision, which is the normal case rather than the edge.
 *
 * Both of these libraries call their brand colour `color:brand-500`, because
 * that is what a design system calls it. Without the id prefix the second one
 * to be folded in simply replaces the first in the token index: the picker
 * still shows two rows, and one of them writes the other's variable.
 */
await check("two libraries shipping the same token name both survive", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, NIMBUS.id, true)
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)

  const ids = colorIds()
  assert.deepEqual(ids, [
    "color:ink",
    `${NIMBUS.id}/color:brand-500`,
    `${NIMBUS.id}/color:surface`,
    `${MERIDIAN.id}/color:brand-500`,
  ])
  assert.equal(new Set(ids).size, ids.length, "the merged catalog has duplicate ids")

  // And each variable still finds its own library's token, which is the half a
  // deduplicated index would get wrong while the counts still looked right.
  const bind = (variable) =>
    editor.authoredTokenMatches("fill-color", `var(${variable})`, [])[0]?.token
  assert.equal(bind("--nimbus-brand-500")?.id, `${NIMBUS.id}/color:brand-500`)
  assert.equal(bind("--meridian-brand-500")?.id, `${MERIDIAN.id}/color:brand-500`)
})

await check("disabling a library takes its tokens back out", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, NIMBUS.id, true)
  assert.equal(colorIds().length, 3)

  await editor.setLibraryEnabled(API, NIMBUS.id, false)
  assert.deepEqual(colorIds(), ["color:ink"])
  assert.equal(
    editor.activeDesignSystem(),
    editor.config.designSystem,
    "turning the last library off did not return the host's own catalog"
  )
})

await check("the merged catalog is memoised while the library list stands still", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, NIMBUS.id, true)
  const first = editor.activeDesignSystem()
  assert.equal(editor.activeDesignSystem(), first, "every inspector render rebuilds the catalog")

  await editor.setLibraryEnabled(API, MERIDIAN.id, true)
  assert.notEqual(editor.activeDesignSystem(), first, "the memo outlived the change it caches")
})

/*
 * The feature, stated once.
 *
 * A designer added a stylesheet; an element in their app is painted with a
 * variable from it; the inspector's Fill row now reads back the library's token
 * name instead of a hex. Nothing about this call site knows libraries exist —
 * it is the default registry, the same function, the same `via: "authored"`.
 */
await check("an element painted with a library variable reads back as that token", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, NIMBUS.id, true)

  const element = window.document.createElement("div")
  element.setAttribute("style", "background-color: var(--nimbus-brand-500)")
  window.document.body.append(element)
  assert.equal(
    element.style.backgroundColor,
    "var(--nimbus-brand-500)",
    "the fixture element is not carrying the variable"
  )

  const matches = editor.authoredTokenMatches(
    "fill-color",
    element.style.backgroundColor,
    [...element.classList]
  )
  assert.equal(matches.length, 1)
  assert.equal(matches[0].token.id, `${NIMBUS.id}/color:brand-500`)
  assert.equal(matches[0].token.library, NIMBUS.id)
  assert.equal(matches[0].token.libraryName, "Nimbus")
  assert.equal(matches[0].via, "authored")
  assert.equal(matches[0].ambiguous, false)

  // And the host's own tokens still match, through the same call.
  const host = editor.authoredTokenMatches("fill-color", "var(--host-ink)", [])
  assert.equal(host[0]?.token.id, "color:ink")

  // Turn it off and the element is no longer described by anything.
  await editor.setLibraryEnabled(API, NIMBUS.id, false)
  assert.deepEqual(
    editor.authoredTokenMatches("fill-color", "var(--nimbus-brand-500)", []),
    [],
    "a disabled library still claims elements in the page"
  )
  element.remove()
})

await check("components come from enabled libraries only, stamped with their owner", async () => {
  await loadBoth()
  assert.deepEqual(editor.libraryComponents(), [])

  await editor.setLibraryEnabled(API, MERIDIAN.id, true)
  const [button] = editor.libraryComponents()
  assert.ok(button, "an enabled library's component was not offered")
  assert.equal(button.name, "Button")
  assert.equal(button.library, MERIDIAN.id)
  assert.equal(button.libraryName, "Meridian")
})

await check("subscribers hear every mutation", async () => {
  await loadBoth()
  let beats = 0
  const stop = editor.subscribeToLibraries(() => {
    beats += 1
  })
  await editor.setLibraryEnabled(API, NIMBUS.id, true)
  assert.ok(beats > 0, "enabling a library notified nobody")
  const after = beats
  stop()
  await editor.setLibraryEnabled(API, NIMBUS.id, false)
  assert.equal(beats, after, "unsubscribing did not stop the notifications")
})

// ── The instance section ───────────────────────────────────────────────────

console.log("\nThe instance section")

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const bridge = {
  elementInfo: () => null,
  send() {},
  toast() {},
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

const context = editor.createContext(bridge, {
  overlay: slot(),
  toolbar: slot(),
  left: slot(),
  right: slot(),
})

/*
 * The REAL writer, not a spy.
 *
 * What a documented prop does when you change it is the whole of this
 * section's honesty claim — the attribute moves, the ledger gains a row, and
 * the file is untouched — and a stub `applyAttribute` that recorded the call
 * would assert the section's intention rather than the editor's behaviour.
 * The ledger is the half that actually matters: it is how the change reaches
 * an agent, and it is the only reason offering the control is defensible.
 */
const writer = editor.createWriter(bridge)

const SOURCE = {
  filePath: VARIANT_FILE,
  lineNumber: 12,
  columnNumber: 0,
  componentName: "Button",
}

/**
 * The section context `SECTIONS` entries are handed, reduced to what this one
 * reads, plus the two things a case needs to vary: the attributes the element
 * is wearing, and the classes that decide which variant option it is on.
 */
function sectionContext(componentName, options = {}) {
  const element = window.document.createElement(options.tagName ?? "button")
  if (options.className) element.className = options.className
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    element.setAttribute(name, value)
  }
  /*
   * Optionally wrapped in a component HOST, which is the Angular shape.
   *
   * `host: { tagName, attributes }` builds `<app-button variant="primary">` and
   * puts the selected element inside it, leaving the selection pointing at the
   * CHILD — which is what a click on a rendered component actually produces.
   * Without this the suite could only ever describe a component whose inputs
   * happen to sit on the node the pointer hit, which is the React case and the
   * one that was already working.
   */
  const shell = options.host
    ? window.document.createElement(options.host.tagName ?? "app-button")
    : null
  if (shell) {
    for (const [name, value] of Object.entries(options.host.attributes ?? {})) {
      shell.setAttribute(name, value)
    }
    shell.append(element)
  }
  window.document.body.append(shell ?? element)
  return {
    editor: context,
    writer,
    selection: {
      key: "lib:1",
      element,
      componentName,
      tagName: element.tagName.toLowerCase(),
      // A file on every selection, so `ensureSource` never goes to the wire
      // mid-case. Whether the file DECLARES variants is the interesting
      // variable and it is controlled by the path, not by its absence.
      source: { ...SOURCE, filePath: options.filePath ?? "src/ui/other.ts" },
    },
    computed: window.getComputedStyle(element),
    invalidate() {},
  }
}

/** The row a property was drawn into, by the name in its left column. */
const rowFor = (node, name) => node.querySelector(`[data-de-prop="${name}"]`)

await check("a selection whose component a library declares gets a section", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)

  const node = editor.instanceSection(sectionContext("Button"))
  assert.ok(node, "a library component was not recognised on the selection")
  assert.match(node.textContent, /Meridian/)
  assert.match(node.textContent, /The primary action control/)
  assert.match(node.textContent, /variant/)
  // Case is a spelling accident of whichever resolver named the component.
  assert.ok(editor.instanceSection(sectionContext("button")))
})

await check("the header says what this is and who it came from", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)

  const node = editor.instanceSection(sectionContext("Button"))
  const head = node.querySelector('[data-de-instance="header"]')
  assert.ok(head, "an instance block with no header says what, about what")
  assert.match(head.querySelector(".de-instance-name").textContent, /Button/)
  assert.match(head.querySelector(".de-instance-owner").textContent, /From Meridian/)
  // A picture, and its absence is a normal answer: the page holds no instance
  // of this component, so the preview falls back to a monogram plate rather
  // than reporting a failure.
  assert.ok(head.querySelector(".de-instance-thumb"), "the header drew no preview box")
  // The declaring file, which only the library knows — the panel's own header
  // already prints the selection's source line.
  assert.match(node.textContent, /design\/button\.md/)
})

await check("every other selection gets nothing at all", async () => {
  assert.equal(editor.instanceSection(sectionContext("Card")), null)
  assert.equal(editor.instanceSection(sectionContext("")), null)

  // And the section belongs to the LIBRARY, not to the name: turn it off and
  // the same selection stops having one.
  await editor.setLibraryEnabled(API, MERIDIAN.id, false)
  assert.equal(editor.instanceSection(sectionContext("Button")), null)
})

/*
 * The gate, stated from both sides.
 *
 * Neither rewrite lane can edit a component's prop in source, so the only
 * honest control this section can offer is one that changes something real on
 * the page. A documented prop the element is not wearing has nothing to
 * change, so it is printed as a fact; one it IS wearing has an attribute, and
 * setting that attribute is a live preview the ledger then hands to an agent.
 */
await check("a documented prop the element does not carry is stated, never offered", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)

  // A `<div>` rather than the default `<button>`, so that NOTHING here is
  // writable: `disabled` reflects natively on a button and would otherwise be
  // one writable prop in a block this case is about the all-stated shape of.
  const node = editor.instanceSection(sectionContext("Button", { tagName: "div" }))
  const row = rowFor(node, "variant")
  assert.ok(row, "the documented prop was dropped rather than stated")
  assert.equal(row.querySelector("[data-de-field]"), null, "an unwritable prop got a control")
  assert.match(row.textContent, /primary \u00b7 ghost/)
  assert.equal(node.querySelectorAll("[data-de-field]").length, 0)
  // And the note says so, rather than leaving the reader to infer it from the
  // absence of a control.
  const notes = [...node.querySelectorAll(".de-variant-note")].map((n) => n.textContent).join(" ")
  assert.match(notes, /Read-only/)
})

await check("a documented union the element wears becomes a dropdown, and the write is a preview", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)
  editor.resetPreviewOnlyForTest()

  const context = sectionContext("Button", { attributes: { variant: "primary" } })
  const node = editor.instanceSection(context)
  const select = node.querySelector('[data-de-field="instance.variant"]')
  assert.ok(select, "a prop the element carries was not offered")
  assert.equal(select.tagName, "SELECT", "two options went to the searchable picker")
  assert.equal(select.value, "primary")
  assert.deepEqual(
    [...select.options].map((option) => option.textContent),
    ["primary (default)", "ghost"]
  )

  select.value = "ghost"
  select.dispatchEvent(new window.Event("change"))

  assert.equal(context.selection.element.getAttribute("variant"), "ghost")
  const [change] = editor.previewOnlyChanges()
  assert.ok(change, "the attribute write reached the page and nothing else")
  assert.equal(change.property, "attribute:variant")
  assert.equal(change.from, "primary")
  assert.equal(change.to, "ghost")
  assert.equal(change.componentName, "Button")
})

/*
 * The Angular shape, and the bug it cost.
 *
 * A component renders a template; a click lands somewhere inside it. On the
 * real host this was built against, `<app-button variant="filled" size="sm">`
 * wraps a `<button class="btn btn--filled">`, the bridge names the inner node
 * `ButtonComponent`, and the library match succeeds on that name — so the
 * section drew, read the INNER element for evidence, found no `variant` on it,
 * and printed every prop as an unwritable sentence while the attribute was
 * visible in the inspector two lines above. The panel was wrong and looked
 * deliberate, which is the expensive kind.
 *
 * Both halves are asserted here: the control appears at all, and the write
 * lands on the host rather than on the node that was selected.
 */
await check("a prop on the component's host is found from a selection inside it", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)
  editor.resetPreviewOnlyForTest()

  const context = sectionContext("Button", {
    host: { tagName: "app-button", attributes: { variant: "ghost" } },
  })
  const inner = context.selection.element
  const host = inner.parentElement

  const node = editor.instanceSection(context)
  const select = node.querySelector('[data-de-field="instance.variant"]')
  assert.ok(select, "a prop on the host was read off the selected child and lost")
  assert.equal(select.value, "ghost", "the control did not read the host's own value")

  select.value = "primary"
  select.dispatchEvent(new window.Event("change"))

  assert.equal(host.getAttribute("variant"), "primary", "the write missed the host")
  assert.equal(inner.getAttribute("variant"), null, "the write landed on the selected child")

  // The ledger describes the element an agent has to go and edit, which is the
  // host — not the node that happened to be under the pointer.
  const [change] = editor.previewOnlyChanges()
  assert.equal(change.property, "attribute:variant")
  assert.equal(change.tagName, "app-button")

  // And the note names it, so the designer is not left wondering which element
  // in the tree just moved.
  const notes = [...node.querySelectorAll(".de-variant-note")].map((n) => n.textContent).join(" ")
  assert.match(notes, /<app-button>/)
})

await check("a host the selection is not inside is never climbed to", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)

  // An `<app-button>` exists in the document from the case above, and it is a
  // SIBLING of this selection rather than an ancestor. `closest` walks up and
  // only up, so it must not be found — a section that searched the document
  // would write another component's attribute.
  const context = sectionContext("Button", { tagName: "div" })
  const node = editor.instanceSection(context)
  assert.equal(
    node.querySelector('[data-de-field="instance.variant"]'),
    null,
    "a host elsewhere in the document was treated as this selection's"
  )
})

await check("an attribute holding a value the library never declared reads as Mixed", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)

  const node = editor.instanceSection(
    sectionContext("Button", { attributes: { variant: "danger" } })
  )
  const select = node.querySelector('[data-de-field="instance.variant"]')
  assert.equal(select.value, "")
  assert.equal([...select.options][0].textContent, "Mixed")
  // Mixed is a reading of the element, never a state you can choose into: it
  // is here because the element is in it, and the axis cases pin the converse.
  assert.equal(
    [...select.options].filter((option) => option.value === "").length,
    1
  )
})

await check("a boolean the DOM reflects natively is writable with no attribute in the markup", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)
  editor.resetPreviewOnlyForTest()

  const context = sectionContext("Button")
  const node = editor.instanceSection(context)
  const toggle = node.querySelector('[data-de-field="instance.disabled"]')
  assert.ok(toggle, "a native boolean was stated rather than offered")
  assert.equal(toggle.getAttribute("role"), "switch")
  assert.equal(toggle.getAttribute("aria-checked"), "false")
  assert.equal(toggle.disabled, false)

  toggle.click()
  // Presence, not `disabled="false"`: on a real `<button>` the string "false"
  // is still disabled, and a switch that said otherwise would be lying.
  assert.equal(context.selection.element.getAttribute("disabled"), "")
  assert.equal(context.selection.element.disabled, true)
  assert.equal(editor.previewOnlyChanges()[0].property, "attribute:disabled")
})

await check("a boolean nothing reflects is inert until the element carries it", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)

  // No switch at all, and that is the point: a switch is drawn in a POSITION,
  // and "off" is exactly what this section does not know about a prop that
  // leaves no trace on the element. A component input can default to true.
  const bare = editor.instanceSection(sectionContext("Button"))
  assert.equal(bare.querySelector('[data-de-field="instance.showIcon"]'), null)
  const stated = rowFor(bare, "showIcon")
  assert.ok(stated, "an unreadable boolean was dropped rather than stated")
  assert.match(stated.textContent, /boolean/)

  const worn = sectionContext("Button", { attributes: { "show-icon": "true" } })
  const node = editor.instanceSection(worn)
  const toggle = node.querySelector('[data-de-field="instance.showIcon"]')
  assert.equal(toggle.disabled, false, "the dashed spelling of the prop was not recognised")
  assert.equal(toggle.getAttribute("aria-checked"), "true")

  toggle.click()
  // "false" rather than a removal, so the row is still writable next render:
  // a control that disappears the first time you turn it off is a dead end.
  assert.equal(worn.selection.element.getAttribute("show-icon"), "false")
})

await check("a prop no attribute could hold is stated and given no control", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)

  const node = editor.instanceSection(sectionContext("Button"))
  const row = rowFor(node, "onPress")
  assert.ok(row, "a documented callback was dropped instead of stated")
  assert.equal(row.querySelector("[data-de-field]"), null)
  assert.match(row.textContent, /\(\) => void/)
})

/*
 * The merge, which is the reason the two sections became one.
 *
 * Both sources name `variant`. The axis is the half that can be written — its
 * options are classes, and classes reach the file — so it takes the row, and
 * the reading comes from the CLASSES rather than from the attribute. The
 * attribute deliberately disagrees here: an element whose markup says `ghost`
 * while its classes say `primary` is what a hand-edited call site looks like,
 * and the panel has to report what the element is actually wearing.
 */
await check("an axis and a documented prop of the same name are one row, and the axis wins", async () => {
  await loadBoth()
  await editor.setLibraryEnabled(API, MERIDIAN.id, true)
  await editor.loadVariants(API, VARIANT_FILE)

  const node = editor.instanceSection(
    sectionContext("Button", {
      filePath: VARIANT_FILE,
      className: "bg-primary",
      attributes: { variant: "ghost" },
    })
  )
  assert.equal(node.querySelectorAll('[data-de-prop="variant"]').length, 1, "variant drew twice")
  const row = rowFor(node, "variant")
  assert.ok(row.querySelector('[data-de-field="variants.variant"]'), "the library's row won")
  assert.equal(row.querySelector('[data-de-field="instance.variant"]'), null)
  assert.equal(row.querySelector("select").value, "primary")

  // The props that do NOT collide are still there, so the merge dropped one
  // row rather than one source.
  assert.ok(rowFor(node, "disabled"))
  assert.ok(rowFor(node, "onPress"))

  // And both notes are on screen, because the two halves land in two different
  // places and a designer has to know which is which.
  const notes = [...node.querySelectorAll(".de-variant-note")].map((n) => n.textContent)
  assert.equal(notes.length, 2)
  assert.match(notes[0], /writes its classes, not the/)
  assert.match(notes[1], /not written to the file/)
})

await check("a source declaration alone still draws the block, with no owner invented", async () => {
  server.reset()
  await editor.refreshLibraries(API)
  await editor.loadVariants(API, VARIANT_FILE)

  const node = editor.instanceSection(
    sectionContext("Button", { filePath: VARIANT_FILE, className: "bg-primary" })
  )
  assert.ok(node, "an instance of a source-declared component drew nothing")
  assert.equal(node.querySelector(".de-instance-owner"), null)
  assert.equal(node.querySelector(".de-instance-thumb"), null)
  assert.ok(node.querySelector('[data-de-field="variants.variant"]'))
})

// ── The stylesheets ────────────────────────────────────────────────────────

console.log("\nThe stylesheets the chrome ships")

/*
 * Asserted as CSS text, not as geometry.
 *
 * JSDOM parses a stylesheet and lays out nothing, so every width it reports is
 * the stub installed at the top of this file. A measurement here would pass on
 * a strip that clips its last tab off the end in a real browser — the rule is
 * the only thing that can be checked honestly from here.
 *
 * The strip is `.de-tabs` on BOTH sides: the left panel's tab host borrows the
 * inspector's rules rather than restating them. Neither panel has a fixed width
 * any more — the seams are draggable — so there is no number to design against,
 * and the only safe answer for a strip that can be narrowed to anything is that
 * it scrolls.
 */
await check("the tab strip scrolls rather than clipping a tab a narrow panel cannot fit", () => {
  const strip = editor.shellCss.match(/\.de-tabs\s*\{[^}]*\}/s)
  assert.ok(strip, "there is no .de-tabs rule at all")
  assert.match(strip[0], /overflow-x:\s*auto/, "a dragged-in panel clips its last tab silently")
  assert.match(strip[0], /scrollbar-width:\s*none/, "a scrollbar eats a row of a narrowed panel")
  assert.match(
    editor.shellCss,
    /\.de-tabs::-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
    "WebKit still paints the scrollbar"
  )
})

/*
 * Registered, which is the whole of the claim.
 *
 * `assetsCss` once shipped correct, complete, and concatenated into nothing.
 * The assets browser rendered as unstyled markup in the left rail and every
 * test in the suite still passed, because a stylesheet nobody imports is not an
 * error in any file — it is simply absent. So each sheet is checked for
 * MEMBERSHIP of `shellCss` by name, and for the relative order the modules' own
 * comments say their cascade depends on: libraries after options because it
 * borrows that sheet's vocabulary, and insert after it because it is canvas
 * chrome that lands a component on the page.
 *
 * `assetsCss` itself is no longer one of them. The browser it styled — the
 * component grid, the cards, the details popover — was deleted rather than
 * moved when the Libraries surface became a section on the Design system tab,
 * so the sheet has no markup left to reach and is being unregistered. Asserting
 * its membership here would make the file's removal fail a suite that is about
 * whether LIVE sheets are wired up.
 */
await check("both library stylesheets ship, in the order their cascade needs", () => {
  // `options` is the anchor rather than a third entry: nothing below it may be
  // lifted ahead of it, and it is not this feature's sheet to move.
  let previous = editor.shellCss.indexOf(editor.optionsCss)
  assert.notEqual(previous, -1, "optionsCss is not in the shell sheet")

  for (const [name, sheet, prefix] of [
    ["librariesCss", editor.librariesCss, /\.de-lib-/],
    ["insertCss", editor.insertCss, /\.de-insert-/],
  ]) {
    assert.ok(sheet.length > 0, `${name} is empty`)
    const at = editor.shellCss.indexOf(sheet)
    assert.notEqual(at, -1, `${name} is written but never registered in core/css.ts`)
    assert.ok(at > previous, `${name} was registered ahead of a sheet it has to win over`)
    assert.match(sheet, prefix, `${name}'s rules use another class prefix`)
    previous = at
  }
})

/*
 * A colour written as a literal is a colour that cannot follow the theme, and
 * the chrome has two. Fallbacks inside `var(--de-…, #hex)` are the tokens' own
 * and are stripped before looking, because those ARE the themed path.
 */
await check("the libraries stylesheet names no colour of its own", () => {
  const withoutTokens = editor.librariesCss.replace(/var\([^)]*\)/g, "")
  const literals = withoutTokens.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  assert.deepEqual(literals, [], `raw colours in librariesCss: ${literals.join(", ")}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
