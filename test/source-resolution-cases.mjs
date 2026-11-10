/**
 * Where an element is written: from the element to a file path.
 *
 * React 19.2 removed `fiber._debugSource`, so the vendor's synchronous walk
 * returns `filePath: ""` for every element. The inspector header, the layers
 * tree and the agent's brief all need a real path, so this file asserts the
 * seam between the vendor patch, the path rules and the async resolver
 * (`resolveElementSource`), and that a source landing late patches the
 * selection in place. Edits themselves are notes: the last cases pin that the
 * editor sends the vendor nothing while they happen.
 *
 * Usage: node designlayer/test/source-resolution-cases.mjs
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR as PACKAGE, vendorOverlayPath } from "./host.mjs"

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

const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "SVGSVGElement",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export {
        normalizeSourcePath,
        isProjectSourcePath,
        resolveElementSource,
        resetSourceResolutionCache,
      } from "./src/core/bridge"
      export { createWriter } from "./src/core/writer"
      export { createContext } from "./src/core/context"
      export { getState, subscribe } from "./src/core/store"
    `,
    resolveDir: PACKAGE,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
})
const module_ = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)
const {
  normalizeSourcePath,
  isProjectSourcePath,
  resolveElementSource,
  resetSourceResolutionCache,
  createWriter,
  createContext,
  getState,
  subscribe,
} = module_

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/**
 * A bridge shaped like the patched vendor's, with the two answers the real one
 * gives: `elementInfo` is populated but its `filePath` is empty, exactly as
 * React 19.2 leaves it, and the async twin is where anything true comes from.
 */
function makeBridge({ asyncInfo = null, discovered = null, componentName = "Fixture" } = {}) {
  const sent = []
  return {
    sent,
    store: {},
    discoverCalls: [],
    elementInfo() {
      return {
        tagName: "div",
        componentName,
        filePath: "",
        lineNumber: 0,
        columnNumber: 0,
        stack: [],
      }
    },
    async elementSourceAsync() {
      return asyncInfo
    },
    async discoverFile(name) {
      this.discoverCalls.push(name)
      return discovered
    },
    send(message) {
      sent.push(message)
    },
    toast() {},
  }
}

function mount(html) {
  const host = window.document.getElementById("app")
  host.innerHTML = html
  return host.firstElementChild
}

function selectionFor(element, componentName = "Fixture") {
  return {
    element,
    tagName: element.tagName.toLowerCase(),
    componentName,
    source: null,
    key: `${componentName}:${element.tagName}`,
  }
}

// --- the vendor patch gate -------------------------------------------------

const { patchOverlay } = await import(path.join(PACKAGE, "runtime/vendor-patch.mjs"))
const { resolveConfig } = await import(path.join(PACKAGE, "config.mjs"))
const config = resolveConfig({})
const overlayPath = vendorOverlayPath()
const overlaySource = fs.readFileSync(overlayPath, "utf8")

await check("AS-01 the patched bridge exposes the element-taking async resolver", () => {
  const patched = patchOverlay(overlaySource, config)
  assert.ok(patched.includes("elementSourceAsync:function"))
  assert.ok(patched.includes("return zu(e)"))
})

await check("AS-02 a vendor upgrade that renames the resolver fails loudly", () => {
  // Not a cosmetic assertion: the whole defect this file exists for is a source
  // path that silently becomes empty, and a renamed `zu` would reproduce it
  // exactly — bridge installs, editor runs, every write drops.
  const renamed = overlaySource.replace("async function zu(e){", "async function zq(e){")
  assert.notEqual(renamed, overlaySource)
  assert.throws(() => patchOverlay(renamed, config), /no longer declares an internal/)
})

// --- path handling ---------------------------------------------------------

await check("AS-03 a turbopack root marker and percent-encoded spaces are normalised", () => {
  assert.equal(
    normalizeSourcePath("[project]/src/components/ui/button.tsx"),
    "src/components/ui/button.tsx"
  )
  assert.equal(
    normalizeSourcePath("/Users/x/Client%20Projects%20Local/host-app/src/a.tsx"),
    "/Users/x/Client Projects Local/host-app/src/a.tsx"
  )
  assert.equal(normalizeSourcePath("file:///Users/x/src/a.tsx"), "/Users/x/src/a.tsx")
  assert.equal(normalizeSourcePath("./src/a.tsx"), "src/a.tsx")
  assert.equal(normalizeSourcePath(null), "")
})

await check("AS-04 a bundler chunk is not a source file", () => {
  // Measured live on 2026-08-23: this is what the resolver handed back for
  // `FolderChip`, and the server would have tried to open it.
  assert.equal(isProjectSourcePath("src_components_workspace_space_0w_i7fl._.js"), false)
  assert.equal(isProjectSourcePath("static/chunks/src_app_page.js"), false)
  assert.equal(isProjectSourcePath("node_modules/react-dom/index.js"), false)
  assert.equal(isProjectSourcePath("src/components/ui/button.tsx"), true)
  assert.equal(isProjectSourcePath("/Users/x/host-app/src/components/ui/button.tsx"), true)
})

// --- resolution ------------------------------------------------------------

await check("AS-05 the async resolver fills a selection the sync walk left empty", async () => {
  resetSourceResolutionCache()
  const element = mount('<button class="rounded px-3">Go</button>')
  const bridge = makeBridge({
    asyncInfo: {
      tagName: "button",
      componentName: "Button",
      filePath: "/Users/x/Client%20Projects%20Local/host-app/src/components/ui/button.tsx",
      lineNumber: 57,
      columnNumber: 4,
      stack: [],
    },
  })
  const source = await resolveElementSource(bridge, element)
  assert.equal(source.filePath, "/Users/x/Client Projects Local/host-app/src/components/ui/button.tsx")
  assert.equal(source.lineNumber, 57)
  assert.equal(source.componentName, "Button")
})

await check("AS-06 a chunk answer falls through to the discoverFile grep", async () => {
  resetSourceResolutionCache()
  const element = mount('<span class="chip">Chip</span>')
  const bridge = makeBridge({
    asyncInfo: {
      tagName: "span",
      componentName: "FolderChip",
      filePath: "src_components_workspace_space_0w_i7fl._.js",
      lineNumber: 953,
      columnNumber: 12,
      stack: [],
    },
    discovered: "src/components/workspace/folder-chip.tsx",
    componentName: "FolderChip",
  })
  const source = await resolveElementSource(bridge, element)
  assert.equal(source.filePath, "src/components/workspace/folder-chip.tsx")
  assert.deepEqual(bridge.discoverCalls, ["FolderChip"])
  // No line, on purpose. The transformer cross-validates `line` against the tag
  // and falls back to class overlap when it disagrees; 953 was a line in a
  // chunk and would have pointed at the wrong node in the real file.
  assert.equal(source.lineNumber, 0)
})

await check("AS-07 an owner-stack frame is used when the element's own is a chunk", async () => {
  resetSourceResolutionCache()
  const element = mount('<i class="glyph">x</i>')
  const bridge = makeBridge({
    asyncInfo: {
      tagName: "i",
      componentName: "Icon",
      filePath: "src_components_ui_127363p._.js",
      lineNumber: 2295,
      columnNumber: 3,
      stack: [
        { componentName: "Icon", filePath: "src_components_ui_127363p._.js", lineNumber: 1, columnNumber: 1 },
        { componentName: "TabStrip", filePath: "src/components/ui/tab-strip.tsx", lineNumber: 88, columnNumber: 6 },
      ],
    },
  })
  const source = await resolveElementSource(bridge, element)
  assert.equal(source.filePath, "src/components/ui/tab-strip.tsx")
  assert.equal(source.componentName, "TabStrip")
  assert.deepEqual(bridge.discoverCalls, [])
})


// --- edits are notes ------------------------------------------------------

await check("AS-09 a text edit previews and sends nothing, before or after the path resolves", async () => {
  resetSourceResolutionCache()
  const element = mount('<h2 class="title">Before</h2>')
  const bridge = makeBridge({
    asyncInfo: {
      tagName: "h2",
      componentName: "Fixture",
      filePath: "src/Fixture.tsx",
      lineNumber: 3,
      columnNumber: 4,
      stack: [],
    },
  })
  createWriter(bridge).applyText(selectionFor(element), "After")
  assert.equal(element.textContent, "After")
  await settle()
  // A text edit is a note for the agent. The engine's `updateText`, which
  // wrote the file on the spot, is never sent.
  assert.deepEqual(bridge.sent, [])
})


await check("AS-17 a source that lands after the click patches the record, not the selection", async () => {
  // The identity rule in core/store.ts: a new \`selection\` array tells every
  // subscriber the SUBJECT changed (layers re-render and re-scroll, the
  // inspector rebuilds, the announcer speaks), so learning more about the same
  // subject must not publish one. It bumps \`sourceRevision\` instead.
  resetSourceResolutionCache()
  const element = mount('<button class="cta">Go</button>')
  const bridge = makeBridge({
    asyncInfo: {
      tagName: "button",
      componentName: "Fixture",
      filePath: "src/Fixture.tsx",
      lineNumber: 4,
      columnNumber: 6,
      stack: [],
    },
  })
  const context = createContext(bridge, {})
  const writes = []
  const stop = subscribe((next, previous) => {
    writes.push({
      selection: next.selection !== previous.selection,
      source: next.sourceRevision !== previous.sourceRevision,
    })
  })
  try {
    context.select(element)
    const selected = getState().selection
    const revision = getState().sourceRevision
    assert.equal(selected[0].source, null, "the synchronous walk is expected to find nothing")
    await settle()
    assert.equal(getState().selection, selected, "the source landing republished the selection")
    assert.equal(selected[0].source?.filePath, "src/Fixture.tsx", "the record was not patched")
    assert.equal(getState().sourceRevision, revision + 1)
    assert.deepEqual(writes, [
      { selection: true, source: false },
      { selection: false, source: true },
    ])
  } finally {
    stop()
    context.select(null)
  }
})


/*
 * Edits are notes for the agent: the editor sends the server nothing while
 * they happen, so no commit and no rehearsal of one reaches the vendor.
 */
await check("AS-18 edits send the server nothing: no commit and no rehearsal of one", async () => {
  resetSourceResolutionCache()
  const parent = mount('<div class="p-2"><button class="rounded bg-blue-500 px-3">Go</button></div>')
  const bridge = makeBridge({
    asyncInfo: { tagName: "button", componentName: "Fixture", filePath: "src/Fixture.tsx", lineNumber: 4, columnNumber: 6, stack: [] },
  })
  const selection = selectionFor(parent.firstElementChild)
  const writer = createWriter(bridge)
  writer.applyClasses(selection, { remove: ["bg-blue-500"], add: ["bg-red-500"] }, "Background")
  await settle()
  writer.applyClasses(selection, { remove: ["px-3"], add: ["px-4"] }, "Padding")
  await new Promise((resolve) => setTimeout(resolve, 250))
  // Edits are notes for the agent now, so the editor never writes them and
  // has no commit to rehearse.
  assert.deepEqual(bridge.sent, [])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
