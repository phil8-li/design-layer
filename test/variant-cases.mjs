/**
 * Cases for component variants: the source parse, the loopback route, the
 * current-option reading, and the half of the inspector's instance section that
 * draws them.
 *
 * The section under test is `instanceSection`, which absorbed the old
 * `variantsSection` — so every case below is about a selection with a SOURCE
 * declaration and no library behind it, which is the axis half of that section
 * in isolation. The library half, and the merge of the two, are driven by
 * `library-panel-cases.mjs`, where a catalog exists to merge with.
 *
 * The parse runs against fixtures under `test/fixtures/variants/` rather than
 * against live source resolution on purpose. React 19 removed the debug field
 * the editor read a selection's file path from, so `selection.source.filePath`
 * is "" in the running app until that is restored; a fixture with an explicit
 * path is the only way to prove the rest of the chain works today.
 *
 * Usage: node designlayer/test/variant-cases.mjs
 */

import assert from "node:assert/strict"
import http from "node:http"
import { createRequire } from "node:module"
import path from "node:path"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"
const FIXTURES = path.join(PACKAGE_DIR, "test", "fixtures", "variants")

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

const dom = new JSDOM("<!doctype html><html><body></body></html>")
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Element = dom.window.Element
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.SVGSVGElement = dom.window.SVGSVGElement
globalThis.CustomEvent = dom.window.CustomEvent
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0)

const { DEFAULT_VARIANT_RECOGNIZERS, parseVariantDeclarations, createVariantCatalog } = await import(
  path.join(PACKAGE_DIR, "server", "variants.mjs")
)
const { resolveConfig } = await import(path.join(PACKAGE_DIR, "config.mjs"))
const { createDesignLayerRoutes } = await import(path.join(PACKAGE_DIR, "server", "routes.mjs"))

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export * from "./src/core/variants"
      export { instanceSection } from "./src/panels/inspector/section-instance"
      export { createWriter } from "./src/core/writer"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const client = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

/* ---------- parsing ---------- */

const fs = await import("node:fs/promises")
const cvaSource = await fs.readFile(path.join(FIXTURES, "button-cva.tsx"), "utf8")
const tvSource = await fs.readFile(path.join(FIXTURES, "badge-tv.tsx"), "utf8")
const plainSource = await fs.readFile(path.join(FIXTURES, "plain.tsx"), "utf8")

console.log("\nVariant parsing")

const cvaDeclarations = parseVariantDeclarations(cvaSource)

check("a cva component parses into axes, options, and its declared defaults", () => {
  assert.equal(cvaDeclarations.length, 1)
  const [declaration] = cvaDeclarations
  assert.equal(declaration.name, "buttonVariants")
  assert.equal(declaration.recognizer, "cva")
  assert.deepEqual(
    declaration.axes.map((axis) => axis.name),
    ["variant", "size"]
  )
  const [variant, size] = declaration.axes
  assert.deepEqual(
    variant.options.map((option) => option.name),
    ["default", "secondary", "ghost", "link", "outline", "destructive", "tone"]
  )
  assert.equal(variant.defaultOption, "default")
  assert.equal(size.defaultOption, "default")
  assert.deepEqual(size.options.map((option) => option.name), ["sm", "default", "lg"])
  assert.deepEqual(
    size.options.find((option) => option.name === "lg").classes,
    ["h-10", "px-8"]
  )
})

check("string, template, and array option bodies all read as class lists", () => {
  const [variant] = cvaDeclarations[0].axes
  const byName = new Map(variant.options.map((option) => [option.name, option]))
  assert.deepEqual(byName.get("secondary").classes, [
    "bg-secondary",
    "text-secondary-foreground",
    "hover:bg-secondary/80",
  ])
  assert.deepEqual(byName.get("outline").classes, ["border", "border-input", "bg-background"])
  assert.deepEqual(byName.get("destructive").classes, ["bg-destructive", "text-destructive-foreground"])
})

check("an option built at runtime is named but marked unresolved", () => {
  const tone = cvaDeclarations[0].axes[0].options.find((option) => option.name === "tone")
  assert.equal(tone.resolved, false)
  assert.deepEqual(tone.classes, [])
  // The rest of the axis must NOT be dragged down with it.
  const resolved = cvaDeclarations[0].axes[0].options.filter((option) => option.resolved)
  assert.equal(resolved.length, 6)
})

check("a tailwind-variants component parses from its first argument", () => {
  const declarations = parseVariantDeclarations(tvSource)
  assert.equal(declarations.length, 1)
  assert.equal(declarations[0].name, "badge")
  assert.equal(declarations[0].recognizer, "tailwind-variants")
  assert.deepEqual(
    declarations[0].axes.map((axis) => axis.name),
    ["intent", "density"]
  )
  assert.deepEqual(
    declarations[0].axes[0].options.map((option) => option.name),
    ["neutral", "success", "danger"]
  )
  assert.equal(declarations[0].axes[1].defaultOption, "cozy")
})

check("a host with no variant system yields an empty list, not a throw", () => {
  assert.deepEqual(parseVariantDeclarations(plainSource), [])
})

check("an empty recognizer list recognizes nothing, and says so quietly", () => {
  assert.deepEqual(parseVariantDeclarations(cvaSource, { recognizers: [] }), [])
  // Guard the case above from being vacuous: the same source with the shipped
  // recognizers is not empty.
  assert.equal(parseVariantDeclarations(cvaSource, { recognizers: DEFAULT_VARIANT_RECOGNIZERS }).length, 1)
})

check("unparseable source degrades to no variants rather than failing", () => {
  assert.deepEqual(parseVariantDeclarations("const = = = broken"), [])
})

check("a file that never spells a recognizer's name is answered without a parse", () => {
  const { parse: babelParse } = createRequire(import.meta.url)("@babel/parser")
  let parses = 0
  const parse = (...args) => {
    parses += 1
    return babelParse(...args)
  }
  assert.deepEqual(parseVariantDeclarations(plainSource, { parse }), [])
  assert.equal(parses, 0)
  // A `\u` escape spells an identifier without writing it, so it still parses.
  const escaped = `const x = \\u0063va("a", { variants: { tone: { loud: "x" } } })\n`
  assert.equal(parseVariantDeclarations(escaped, { parse })[0]?.recognizer, "cva")
  assert.equal(parses, 1)
})

/* ---------- the catalog and its route ---------- */

console.log("\nVariant route")

const config = resolveConfig(
  { projectRoot: PACKAGE_DIR, source: { roots: [FIXTURES], extensions: [".tsx"] } },
  { cwd: PACKAGE_DIR }
)
const catalog = createVariantCatalog(config)
const FIXTURE_RELATIVE = path.relative(PACKAGE_DIR, path.join(FIXTURES, "button-cva.tsx"))

check("the catalog reads a fixture inside the source roots", () => {
  const payload = catalog.read(FIXTURE_RELATIVE)
  assert.equal(payload.file, FIXTURE_RELATIVE)
  assert.deepEqual(payload.recognizers, ["cva", "tailwind-variants"])
  assert.equal(payload.declarations.length, 1)
})

check("a file outside the editable source roots is refused, not read", () => {
  assert.throws(() => catalog.read("config.mjs"), /outside the editable source roots/)
  assert.throws(() => catalog.read("../package.json"), /outside the editable source roots/)
})

/*
 * Vite hands the browser `/src/Card.jsx`, a root-relative module path, and that
 * is the only spelling the client has. Read as filesystem-absolute it names a
 * file outside the project, which made every Vite lookup answer 403. A
 * leading-slash path that does not exist on disk is retried against the root;
 * one that DOES exist outside the project is still refused, never re-rooted.
 */
check("a Vite root-relative module path reads the project file, and a real outside path stays refused", () => {
  const payload = catalog.read(`/${FIXTURE_RELATIVE.split(path.sep).join("/")}`)
  assert.equal(payload.file, FIXTURE_RELATIVE)
  assert.equal(payload.declarations.length, 1)
  assert.throws(() => catalog.read("/etc/passwd"), /outside the editable source roots/)
  assert.throws(() => catalog.read("/../package.json"), /outside the editable source roots/)
})

await checkAsync("the route serves loopback and refuses a foreign or null Origin", async () => {
  const routes = createDesignLayerRoutes(config)
  const server = http.createServer((request, response) => {
    if (routes.handle(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}${config.apiPrefix}/variants?file=${encodeURIComponent(FIXTURE_RELATIVE)}`
  try {
    const ok = await fetch(url)
    assert.equal(ok.status, 200)
    const payload = await ok.json()
    assert.equal(payload.declarations.length, 1)
    assert.equal(payload.declarations[0].name, "buttonVariants")

    // "null" is the Origin a sandboxed iframe or a data: document sends, which
    // is precisely the context an attacker controls.
    const spoofed = await fetch(url, { headers: { origin: "null" } })
    assert.equal(spoofed.status, 403)
    const foreign = await fetch(url, { headers: { origin: "http://evil.test" } })
    assert.equal(foreign.status, 403)

    const outside = await fetch(
      `http://127.0.0.1:${port}${config.apiPrefix}/variants?file=${encodeURIComponent("config.mjs")}`
    )
    assert.equal(outside.status, 403)
    assert.match((await outside.json()).message, /outside the editable source roots/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

/* ---------- reading the live element ---------- */

console.log("\nCurrent option")

const [buttonDeclaration] = cvaDeclarations
const [variantAxis, sizeAxis] = buttonDeclaration.axes

function element(className) {
  const node = document.createElement("button")
  node.className = className
  return node
}

check("an instance wearing an option's full class string reads as that option", () => {
  const node = element("inline-flex bg-secondary text-secondary-foreground hover:bg-secondary/80 h-8 px-3 text-xs")
  assert.equal(client.currentOption(node, variantAxis), "secondary")
  assert.equal(client.currentOption(node, sizeAxis), "sm")
})

check("a hand-modified instance reads as mixed, not silently as the default", () => {
  // tailwind-merge at the call site dropped `bg-secondary` for a local override.
  const node = element("inline-flex bg-brand-500 text-secondary-foreground hover:bg-secondary/80")
  assert.equal(client.currentOption(node, variantAxis), null)
})

check("an option that is a superset of another wins the reading", () => {
  const axis = {
    name: "variant",
    defaultOption: null,
    options: [
      { name: "base", classes: ["rounded"], resolved: true },
      { name: "loud", classes: ["rounded", "shadow-lg"], resolved: true },
    ],
  }
  assert.equal(client.currentOption(element("rounded shadow-lg"), axis), "loud")
  assert.equal(client.currentOption(element("rounded"), axis), "base")
})

check("a plain element matches no declaration in the file", () => {
  assert.equal(client.matchDeclaration(element("flex gap-2"), cvaDeclarations), null)
  // Guard: the same call with a real instance does match, so the assertion above
  // is about the element and not about an empty declaration list.
  assert.equal(
    client.matchDeclaration(element("bg-primary text-primary-foreground shadow hover:bg-primary/90"), cvaDeclarations)
      ?.name,
    "buttonVariants"
  )
})

check("a class swap removes the outgoing option and keeps what both share", () => {
  const node = element("inline-flex bg-primary text-primary-foreground shadow hover:bg-primary/90")
  const write = client.variantClassWrite(node, variantAxis, "secondary")
  assert.deepEqual(write.remove.sort(), [
    "bg-primary",
    "hover:bg-primary/90",
    "shadow",
    "text-primary-foreground",
  ])
  assert.deepEqual(write.add, ["bg-secondary", "text-secondary-foreground", "hover:bg-secondary/80"])
  assert.equal(write.remove.includes("inline-flex"), false)
})

check("an unresolved option cannot be applied", () => {
  assert.equal(client.variantClassWrite(element("bg-primary"), variantAxis, "tone"), null)
})

/* ---------- the inspector section ---------- */

console.log("\nInstance section: the source-declared axes")

const pending = []
const bridge = {
  toast() {},
  store: {
    addPendingPropertyOperation(key, operation, propertyKeys) {
      pending.push({ key, operation, propertyKeys })
    },
  },
}
const writer = client.createWriter(bridge)

const API_BASE = "/__designlayer"
const SOURCE = {
  filePath: FIXTURE_RELATIVE,
  lineNumber: 37,
  columnNumber: 10,
  componentName: "Button",
}

// The client half fetches; serve it the parse the server route would have.
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => catalog.read(new URL(url, "http://localhost").searchParams.get("file")),
})

let invalidations = 0
function contextFor(node, source) {
  return {
    editor: { apiBase: API_BASE },
    writer,
    selection: {
      element: node,
      tagName: node.tagName.toLowerCase(),
      componentName: "Button",
      key: "Button:37:button0",
      source,
    },
    computed: dom.window.getComputedStyle(node),
    invalidate: () => {
      invalidations += 1
    },
  }
}

check("a selection with no source at all draws nothing", () => {
  assert.equal(client.instanceSection(contextFor(element("flex"), null)), null)
})

check("an empty filePath draws nothing — it lights up when lane 2 lands", () => {
  assert.equal(
    client.instanceSection(
      contextFor(element("bg-primary text-primary-foreground shadow hover:bg-primary/90"), {
        ...SOURCE,
        filePath: "",
      })
    ),
    null
  )
})

await checkAsync("the first render requests the file and draws nothing yet", async () => {
  const node = element("bg-primary text-primary-foreground shadow hover:bg-primary/90")
  assert.equal(client.instanceSection(contextFor(node, SOURCE)), null)
  const loaded = await client.loadVariants(API_BASE, FIXTURE_RELATIVE)
  assert.equal(loaded.length, 1)
})

const instance = element(
  "inline-flex items-center bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
)
const host = document.createElement("div")
document.body.append(host, instance)

function renderSection(node = instance) {
  host.textContent = ""
  const rendered = client.instanceSection(contextFor(node, SOURCE))
  if (rendered) host.append(rendered)
  return rendered
}

check("a plain div in a variant-bearing file still draws nothing", () => {
  const plain = document.createElement("div")
  plain.className = "flex gap-2"
  assert.equal(client.instanceSection(contextFor(plain, SOURCE)), null)
})

check("the header names the component, not the factory the axes came out of", () => {
  assert.ok(renderSection(), "the section should render for a matched instance")
  const head = host.querySelector('[data-de-instance="header"]')
  assert.ok(head, "an instance with no header is a block that says what, about what")
  // `buttonVariants` is what the source calls the recipe; `Button` is what the
  // designer selected, and the bridge is the one that knows it.
  assert.match(head.textContent, /Button/)
  assert.equal(head.textContent.includes("buttonVariants"), false)
  // No library is on, so there is nothing to attribute this to and the section
  // must not invent an owner.
  assert.equal(host.querySelector(".de-instance-owner"), null)
  assert.equal(host.querySelector(".de-instance-thumb"), null)
})

check("both axes render, each control declaring a data-de-field", () => {
  assert.ok(renderSection(), "the section should render for a matched instance")
  const fields = [...host.querySelectorAll("[data-de-field]")].map((node) =>
    node.getAttribute("data-de-field")
  )
  assert.deepEqual(fields, ["variants.variant", "variants.size"])
  // Seven options goes to the searchable picker; three to a plain select.
  assert.equal(host.querySelector('[data-de-field="variants.variant"]').tagName, "BUTTON")
  assert.equal(host.querySelector('[data-de-field="variants.size"]').tagName, "SELECT")
})

check("the small axis shows its current option and marks the declared default", () => {
  renderSection()
  const select = host.querySelector('[data-de-field="variants.size"]')
  assert.equal(select.value, "default")
  assert.deepEqual(
    [...select.options].map((option) => option.textContent),
    ["sm", "default (default)", "lg"]
  )
  // Mixed is a reading, never an option you can choose into.
  assert.equal([...select.options].some((option) => option.value === ""), false)
})

check("a mixed instance offers Mixed as the shown value", () => {
  const modified = element("inline-flex h-9 px-4 py-2 bg-brand-500 text-primary-foreground shadow hover:bg-primary/90")
  const rendered = client.instanceSection(contextFor(modified, SOURCE))
  assert.ok(rendered, "an instance matched on size alone still has variants to show")
  const select = rendered.querySelector('[data-de-field="variants.variant"], [data-de-field="variants.size"]')
  assert.ok(select)
  const picker = rendered.querySelector('[data-de-field="variants.variant"]')
  assert.match(picker.textContent, /Mixed/)
})

check("choosing an option previews on the element and queues one source operation", () => {
  renderSection()
  const before = pending.length
  const select = host.querySelector('[data-de-field="variants.size"]')
  select.value = "lg"
  select.dispatchEvent(new dom.window.Event("change"))

  const classes = instance.getAttribute("class").split(/\s+/)
  assert.equal(classes.includes("h-10"), true)
  assert.equal(classes.includes("px-8"), true)
  assert.equal(classes.includes("h-9"), false)
  assert.equal(classes.includes("px-4"), false)
  assert.equal(classes.includes("py-2"), false)
  // Untouched: the swap owns one axis, not the element's whole class list.
  assert.equal(classes.includes("bg-primary"), true)

  assert.equal(pending.length, before + 1)
  const { operation } = pending[pending.length - 1]
  assert.equal(operation.op, "updateClass")
  assert.equal(operation.file, FIXTURE_RELATIVE)
  assert.equal(operation.line, SOURCE.lineNumber)
  const patterns = operation.updates.map((update) => update.classPattern)
  assert.equal(patterns.includes("^h-9$"), true)
  assert.equal(patterns.includes("^px-4$"), true)
  assert.equal(operation.updates.some((update) => update.value === "h-10"), true)
})

check("the new option is what the rebuilt panel reads back", () => {
  renderSection()
  assert.equal(host.querySelector('[data-de-field="variants.size"]').value, "lg")
})

check("focus survives the rebuild through data-de-field", () => {
  renderSection()
  const before = host.querySelector('[data-de-field="variants.size"]')
  before.focus()
  assert.equal(document.activeElement, before)

  renderSection()
  // The lookup the inspector's restoreFocus performs, verbatim in shape.
  const after = [...host.querySelectorAll("[data-de-field]")].find(
    (node) => node.getAttribute("data-de-field") === "variants.size"
  )
  assert.ok(after, "the rebuilt panel must expose the same field identity")
  assert.notEqual(after, before)
  after.focus()
  assert.equal(document.activeElement, after)
})

check("the section says plainly that it writes classes, not the prop", () => {
  renderSection()
  const note = host.querySelector(".de-variant-note")
  assert.ok(note)
  assert.match(note.textContent, /writes its classes, not the/)
})

/*
 * The one rule in this section that is about honesty rather than about wiring.
 *
 * `tone` is declared by the fixture and built at runtime, so its classes are
 * unknown and `variantClassWrite` refuses it. The picker has to say so BEFORE
 * the click — a refusal that arrives as nothing happening is how a designer
 * ends up trying every option in the list one at a time.
 */
check("an option the source builds at runtime is offered inert, and says why", () => {
  renderSection()
  const picker = host.querySelector('[data-de-field="variants.variant"]')
  picker.click()
  const tone = document.querySelector('[data-de-choice="tone"]')
  assert.ok(tone, "the runtime-built option was dropped rather than disabled")
  assert.equal(tone.getAttribute("aria-disabled"), "true")
  assert.match(tone.textContent, /built at runtime/)

  const before = pending.length
  tone.click()
  assert.equal(pending.length, before, "an unresolved option queued a source operation")
  assert.equal(instance.getAttribute("class").includes("tone"), false)
  document.querySelector(".de-token-popover")?.remove()
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
