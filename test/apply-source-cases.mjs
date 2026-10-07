/**
 * "Apply to code" from the element to the file on disk.
 *
 * The button was disabled for every element on every page of this app and no
 * signal said why: React 19.2 removed `fiber._debugSource`, the vendor's
 * synchronous walk returned `filePath: ""` for everything, the writer dropped
 * the operation on that empty string, and `hasChanges()` therefore stayed
 * false. Each layer behaved correctly in isolation, which is why the failure
 * was silent — so this file asserts the seam between them rather than any one
 * of them, and finishes by rewriting a real file through the vendor's own
 * transformer. A queued operation that never becomes a diff is the same bug
 * wearing a green test.
 *
 * Usage: node designlayer/test/apply-source-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
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
      export { createWriter, untranslatedProperties } from "./src/core/writer"
      export {
        buildChangePrompt,
        sanitizeChangePrompt,
        copyChangePrompt,
        recordPreviewOnly,
        previewOnlyChanges,
        clearPreviewOnly,
      } from "./src/core/change-prompt"
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
  untranslatedProperties,
  buildChangePrompt,
  sanitizeChangePrompt,
  copyChangePrompt,
  recordPreviewOnly,
  previewOnlyChanges,
  clearPreviewOnly,
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
  const queued = []
  const sent = []
  const store = {
    addPendingPropertyOperation(mergeKey, operation, propertyKeys) {
      queued.push({ mergeKey, operation, propertyKeys })
    },
    // The vendor copies its pending list verbatim, so a stub that filters or
    // re-derives here would test something the product does not do.
    buildBatchOperations() {
      return queued.map((entry) => entry.operation)
    },
    hasChanges() {
      return queued.length > 0
    },
  }
  return {
    queued,
    sent,
    store,
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

// --- the queue -------------------------------------------------------------

await check("AS-08 a class change queues and survives buildBatchOperations", async () => {
  resetSourceResolutionCache()
  const parent = mount('<div class="p-2 text-sm"><button class="rounded bg-blue-500 px-3">Go</button></div>')
  const element = parent.firstElementChild
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
  const selection = selectionFor(element)
  const writer = createWriter(bridge)

  assert.equal(bridge.store.hasChanges(), false)
  writer.applyClasses(selection, { remove: ["bg-blue-500"], add: ["bg-red-500"] }, "Background")
  await settle()

  assert.equal(bridge.store.hasChanges(), true, "the Apply button is still disabled")
  const operations = bridge.store.buildBatchOperations()
  assert.equal(operations.length, 1)
  assert.equal(operations[0].file, "src/Fixture.tsx")
  assert.equal(operations[0].tagName, "button")
  // Captured before the preview mutated it, so the AST matcher scores against
  // the class list that is actually written in the JSX.
  assert.equal(operations[0].className, "rounded bg-blue-500 px-3")
  assert.equal(operations[0].nthOfType, 0)
  // And the selection now knows where it lives, so the inspector and the next
  // edit read the same file this operation used.
  assert.equal(selection.source.filePath, "src/Fixture.tsx")
})

await check("AS-09 a text edit waits for the path instead of dropping", async () => {
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
  assert.equal(bridge.sent.length, 0, "sending before the path resolves would target nothing")
  await settle()
  assert.equal(bridge.sent.length, 1)
  assert.equal(bridge.sent[0].type, "updateText")
  assert.equal(bridge.sent[0].filePath, "src/Fixture.tsx")
  assert.equal(bridge.sent[0].originalText, "Before")
  assert.equal(bridge.sent[0].newText, "After")
})

// --- the file on disk ------------------------------------------------------

await check("AS-10 the queued operation rewrites a real file", async () => {
  resetSourceResolutionCache()
  const { executeBatch } = await import("react-rewrite-cli/dist/batch-transform.js")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-apply-"))
  const file = path.join(root, "src", "Fixture.tsx")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const original = [
    "export function Fixture() {",
    "  return (",
    '    <div className="p-2 text-sm">',
    '      <button className="rounded bg-blue-500 px-3">Go</button>',
    "    </div>",
    "  )",
    "}",
    "",
  ].join("\n")
  fs.writeFileSync(file, original)

  const parent = mount('<div class="p-2 text-sm"><button class="rounded bg-blue-500 px-3">Go</button></div>')
  const bridge = makeBridge({
    // No line and no column: the discoverFile fallback is the path that gives
    // the transformer the least to go on, so it is the one worth proving.
    asyncInfo: null,
    discovered: "src/Fixture.tsx",
  })
  const writer = createWriter(bridge)
  writer.applyClasses(
    selectionFor(parent.firstElementChild),
    { remove: ["bg-blue-500"], add: ["bg-red-500"] },
    "Background"
  )
  await settle()

  const operations = bridge.store.buildBatchOperations()
  assert.equal(operations.length, 1)
  assert.equal(operations[0].line, 0, "the fallback path carries no line")

  const { results } = executeBatch(operations, root)
  assert.equal(results[0].success, true, results[0].error ?? "no error reported")
  const written = fs.readFileSync(file, "utf8")
  assert.ok(written.includes("bg-red-500"), written)
  assert.ok(!written.includes("bg-blue-500"), written)
  // Nothing else moved.
  assert.ok(written.includes('<div className="p-2 text-sm">'), written)
  fs.rmSync(root, { recursive: true, force: true })
})

// --- what cannot be written ------------------------------------------------

await check("AS-11 a preview-only change becomes an agent-ready prompt", async () => {
  clearPreviewOnly()
  resetSourceResolutionCache()
  const element = mount('<div class="card">Card</div>')
  const bridge = makeBridge({
    asyncInfo: {
      tagName: "div",
      componentName: "Card",
      filePath: "src/components/card.tsx",
      lineNumber: 12,
      columnNumber: 2,
      stack: [],
    },
    componentName: "Card",
  })
  createWriter(bridge).applyStyles(
    selectionFor(element, "Card"),
    [{ property: "transform", value: "translate(12px, 0px)" }],
    "Move"
  )

  // The toolbar reads this on the very next line, so it cannot wait for a path.
  assert.deepEqual(untranslatedProperties(), ["transform"])
  await settle()

  const prompt = buildChangePrompt()
  assert.ok(prompt.includes("## src/components/card.tsx"), prompt)
  assert.ok(prompt.includes("`transform`"), prompt)
  assert.ok(prompt.includes("translate(12px, 0px)"), prompt)
  assert.ok(prompt.includes('<div class="card">'), prompt)
  assert.equal(previewOnlyChanges().length, 1)
})

await check("AS-12 dragging records one change, not one per frame", () => {
  clearPreviewOnly()
  for (const x of [1, 2, 3, 40]) {
    recordPreviewOnly({
      filePath: "src/a.tsx",
      componentName: "A",
      tagName: "div",
      className: "c",
      property: "transform",
      from: "none",
      to: `translate(${x}px, 0px)`,
    })
  }
  const changes = previewOnlyChanges()
  assert.equal(changes.length, 1)
  assert.equal(changes[0].from, "none")
  assert.equal(changes[0].to, "translate(40px, 0px)")
})

await check("AS-13 an icon swap is in the prompt but not in the Apply toast", () => {
  clearPreviewOnly()
  recordPreviewOnly({
    filePath: "src/components/chip.tsx",
    componentName: "Chip",
    tagName: "svg",
    className: "size-4",
    property: "icon",
    from: "ChevronRight",
    to: "ArrowUpRight",
  })
  const prompt = buildChangePrompt()
  assert.ok(prompt.includes("swap the icon to `ArrowUpRight`"), prompt)
  assert.ok(prompt.includes("ChevronRight"), prompt)
  // It already said "preview only" when it happened; the Apply toast lists the
  // CSS properties, and repeating the swap there reports one loss twice.
  assert.deepEqual(untranslatedProperties(), [])
})

await check("AS-14 an unresolved file becomes a component to search for", () => {
  clearPreviewOnly()
  recordPreviewOnly({
    filePath: null,
    componentName: "MysteryPanel",
    tagName: "section",
    className: "panel",
    property: "backdrop-filter",
    from: "none",
    to: "blur(8px)",
  })
  const prompt = buildChangePrompt()
  assert.ok(prompt.includes("File not resolved"), prompt)
  assert.ok(prompt.includes("Search for `MysteryPanel`"), prompt)
})

await check("AS-15 the clipboard text carries no home directory and no attribution", () => {
  const sanitized = sanitizeChangePrompt(
    [
      "## /Users/someone/Documents/Websites/Client Projects Local/host-app/src/a.tsx",
      "**Source:** src_components_ui_127363p._.js:2295",
      "- `<div>` — set `gap` to `8px`",
      "- see `packages/ui/src/b.tsx`",
      "",
    ].join("\n")
  )
  assert.ok(sanitized.includes("## src/a.tsx"), sanitized)
  assert.ok(!sanitized.includes("someone"), sanitized)
  assert.ok(!sanitized.includes("**Source:**"), sanitized)
  // A relative path that merely contains `src/` is not an absolute one.
  assert.ok(sanitized.includes("packages/ui/src/b.tsx"), sanitized)
})

await check("AS-16 copy is one sanitised clipboard write, and answers whether it landed", async () => {
  clearPreviewOnly()
  const writes = []
  Object.defineProperty(window.navigator, "clipboard", {
    value: {
      writeText(text) {
        writes.push(text)
        return Promise.resolve()
      },
    },
    configurable: true,
  })
  recordPreviewOnly({
    filePath: "/Users/someone/host-app/src/a.tsx",
    componentName: "A",
    tagName: "div",
    className: "c",
    property: "mix-blend-mode",
    from: "normal",
    to: "multiply",
  })
  assert.equal(await copyChangePrompt(), true)
  assert.equal(writes.length, 1)
  assert.ok(writes[0].includes("## src/a.tsx"), writes[0])
  assert.ok(writes[0].includes("mix-blend-mode"), writes[0])

  // Refused by the Clipboard API (Chrome, in an unfocused frame), the same
  // sanitised text still lands through the copy command.
  Object.defineProperty(window.navigator, "clipboard", {
    value: {
      writeText() {
        return Promise.reject(new Error("Document is not focused."))
      },
    },
    configurable: true,
  })
  let carried = null
  window.document.execCommand = (command) => {
    if (command !== "copy") return false
    const before = new window.Event("beforecopy", { bubbles: true, cancelable: true })
    window.document.body.dispatchEvent(before)
    if (!before.defaultPrevented) return false
    const copy = new window.Event("copy", { bubbles: true, cancelable: true })
    copy.clipboardData = { setData: (type, value) => type === "text/plain" && (carried = value) }
    window.document.body.dispatchEvent(copy)
    return true
  }
  assert.equal(await copyChangePrompt(), true)
  assert.equal(carried, writes[0], "the command route carried different text")

  // Refused on every route: answered, never thrown. Not an error the user has
  // to dismiss; the surface that owns the button decides what to say.
  delete window.document.execCommand
  assert.equal(await copyChangePrompt(), false)
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
 * The server rehearses an Apply before it is clicked (`runtime/apply-ahead.mjs`)
 * so the click only waits for a write. It can only rehearse what it is shown:
 * the queue's operations, once the edits settle — not one message per edit.
 */
await check("AS-18 queued edits hand the server their commit to rehearse, once they settle", async () => {
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
  await settle()
  assert.equal(bridge.sent.length, 0, "the hint went out before the edits settled")
  await new Promise((resolve) => setTimeout(resolve, 250))
  const hints = bridge.sent.filter((message) => message.type === "designlayer:applyAhead")
  assert.equal(hints.length, 1, "a hint went out per edit rather than once the edits settled")
  assert.deepEqual(hints[0].operations, bridge.store.buildBatchOperations())
  assert.equal(bridge.sent.length, 1, "the hint is not a commit")
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
