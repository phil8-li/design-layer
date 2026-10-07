/**
 * The editor against design systems that are not this app's.
 *
 * Figma does not know your palette. It opens a file, reads whatever collections
 * that file happens to contain, and draws a picker for each. This suite is the
 * committed proof the editor behaves the same way: three synthetic hosts in
 * test/fixtures, each with a genuinely different design system, each resolving
 * a sane catalog, sane aliases and sane inspector rows.
 *
 * Deliberately self-contained. It never reads the repository this package sits
 * in — a decoupling suite that needs the app it is decoupling from proves
 * nothing. The real host's own numbers stay pinned in token-cases.mjs and
 * responsive-cases.mjs, which is where a regression in THIS app belongs.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { JSDOM } from "jsdom"

import { browserPrelude, loadConfig, resolveConfig } from "../config.mjs"
import { DEFAULT_THEME_NAMESPACES, aliasesFromCss } from "../server/design-system-aliases.mjs"
import { normalizeDesignSystemManifest } from "../server/design-system-manifest.mjs"

import { PACKAGE_DIR } from "./host.mjs"
const FIXTURES = path.join(PACKAGE_DIR, "test", "fixtures")
const TOKEN_GROUPS = [
  "colors", "spacing", "radii", "textStyles", "uiTextStyles", "effects", "icons", "motion",
]

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

async function loadFixtureHost(dir) {
  const configPath = path.join(FIXTURES, dir, "designlayer.config.mjs")
  const config = await loadConfig({ configPath })
  return { dir, config, catalog: config.designSystem.catalog }
}

/**
 * The editor's browser half, loaded as THIS host sees it.
 *
 * `src/core/config.ts` reads `window.__DESIGNLAYER_CONFIG__` once at module
 * load, exactly as it does behind the proxy, so a second host needs a second
 * module instance. The `__host` export makes each bundle's text unique and
 * therefore its data: URL a distinct module rather than a cache hit.
 */
async function loadEditorFor(host) {
  const prelude = browserPrelude(host.config, { proxyPort: 4567 })
  globalThis.__DESIGNLAYER_CONFIG__ = JSON.parse(
    prelude.slice(prelude.indexOf("=") + 1, prelude.lastIndexOf(";"))
  )
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `
        export const __host = ${JSON.stringify(host.dir)}
        export * from "./src/core/design-system"
        export { createContext } from "./src/core/context"
        export { installInspector } from "./src/panels/inspector"
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

/** Mounts the real inspector over a fixture and hands back the panel. */
async function withInspector(helpers, markup, run) {
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
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  const paint = () => new Promise((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
  )
  try {
    helpers.installInspector(editor)
    editor.select(window.document.getElementById("target"))
    await paint()
    await run({ window, right, paint, editor })
  } finally {
    globalThis.fetch = originalFetch
    dom.window.close()
  }
}

const rowLabels = (right) =>
  [...right.querySelectorAll('[data-de-field^="design-system."]')].map((node) =>
    node.getAttribute("aria-label")
  )

function expectRows(right, { present = [], absent = [] }) {
  const labels = rowLabels(right)
  assert.ok(labels.length > 0, "the design-system section rendered no rows at all")
  for (const label of present) assert.ok(labels.includes(label), `${label} is missing`)
  for (const label of absent) {
    assert.equal(labels.includes(label), false, `${label} should not be here`)
  }
}

/** A field with tokens behind it must open a picker with choices in it. */
function expectPicker({ window, right }, property, expectedIds) {
  const field = right.querySelector(`[data-de-field="design-system.${property}"]`)
  assert.ok(field, `${property} has no row to pick in`)
  field.click()
  const popover = window.document.querySelector(".de-token-popover")
  assert.ok(popover, `${property} opened no picker`)
  const offered = [...popover.querySelectorAll("[data-de-choice]")].map((node) =>
    node.getAttribute("data-de-choice")
  )
  for (const id of expectedIds) assert.ok(offered.includes(id), `${property} did not offer ${id}`)
  field.click()
}

const aurora = await loadFixtureHost("aurora-v4")
const relay = await loadFixtureHost("relay-v3")
const lattice = await loadFixtureHost("lattice-adapter")
const HOSTS = [aurora, relay, lattice]

const counts = (catalog) =>
  Object.fromEntries(TOKEN_GROUPS.map((group) => [group, catalog[group].length]))

console.log("\nThe sweep is not vacuous")

check("three fixture hosts exist, each resolved something, and none is another", () => {
  // A loop over an empty list passes while asserting nothing. Everything below
  // this case is a loop, so this is the case that says the loops have a body.
  assert.ok(HOSTS.length >= 2, "a decoupling proof needs at least two hosts")
  assert.equal(new Set(HOSTS.map((host) => host.dir)).size, HOSTS.length)

  const idSets = []
  for (const host of HOSTS) {
    const ids = TOKEN_GROUPS.flatMap((group) => host.catalog[group].map((token) => token.id))
    assert.ok(ids.length > 0, `${host.dir} resolved no tokens at all`)
    assert.ok(
      host.catalog.aliases.tailwind.length > 0,
      `${host.dir} resolved no Tailwind aliases, so its alias assertions would be empty`
    )
    assert.equal(new Set(ids).size, ids.length, `${host.dir} has duplicate token ids`)
    idSets.push(new Set(ids))
  }

  // Three different design systems, not one catalog read three times.
  for (let a = 0; a < idSets.length; a += 1) {
    for (let b = a + 1; b < idSets.length; b += 1) {
      const shared = [...idSets[a]].filter((id) => idSets[b].has(id))
      assert.deepEqual(
        shared,
        [],
        `${HOSTS[a].dir} and ${HOSTS[b].dir} share token ids: ${shared.join(", ")}`
      )
    }
  }

  // And a host with no design system at all still gets none of theirs.
  const generic = resolveConfig({}, { cwd: PACKAGE_DIR }).designSystem.catalog
  for (const group of TOKEN_GROUPS) assert.deepEqual(generic[group], [], `${group} should be empty`)
})

console.log("\nAurora — Tailwind v4, its own @theme namespaces")

check("a manifest that omits four token groups resolves to four empty axes", () => {
  assert.equal(aurora.catalog.name, "Aurora")
  assert.deepEqual(counts(aurora.catalog), {
    colors: 3,
    spacing: 0,
    radii: 1,
    textStyles: 1,
    uiTextStyles: 0,
    effects: 2,
    icons: 0,
    motion: 0,
  })
  // The axes are empty because the file never mentions them, not because the
  // fixture spells them wrong.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "aurora-v4", "tokens.json"), "utf8")
  )
  for (const key of ["motion", "iconScale", "uiTextStyles"]) {
    assert.equal(key in manifest, false, `the fixture must not declare ${key}`)
  }
  assert.equal(
    manifest.collections.some((entry) => entry.name === "Spacing"),
    false,
    "the fixture must not ship a Spacing collection"
  )

  // Absence degrades; malformation still refuses. A group that is PRESENT and
  // the wrong shape is a host mistake, and silence would hide it.
  assert.throws(
    () => normalizeDesignSystemManifest({ ...manifest, motion: 5 }),
    /motion must be an array/
  )
  assert.throws(
    () => normalizeDesignSystemManifest({ ...manifest, effectStyles: [{ name: "X" }] }),
    /effectStyles\[0\].layers must be an array/
  )
})

check("a light-only palette keeps one value per colour", () => {
  for (const token of aurora.catalog.colors) {
    assert.deepEqual(Object.keys(token.values), ["light"], `${token.id} invented a second theme`)
  }
})

check("Aurora's own @theme namespaces resolve, and the built-in four cannot read them", () => {
  const byVar = Object.fromEntries(
    aurora.catalog.aliases.tailwind.map((alias) => [alias.cssVar, alias])
  )
  assert.deepEqual(byVar["--text-shadow-lift"], {
    namespace: "text-shadow",
    name: "lift",
    cssVar: "--text-shadow-lift",
    tokenIds: ["shadow:lift"],
    ambiguous: false,
  })
  assert.deepEqual(byVar["--drop-shadow-halo"], {
    namespace: "drop-shadow",
    name: "halo",
    cssVar: "--drop-shadow-halo",
    tokenIds: ["shadow:halo"],
    ambiguous: false,
  })

  // The counter-example, and the reason the list is config-driven rather than a
  // literal: read with Tailwind's own four namespaces, Aurora's drop shadow is
  // invisible and its text shadow is filed under the typography scale.
  const css = fs.readFileSync(path.join(FIXTURES, "aurora-v4", "theme.css"), "utf8")
  const hardcoded = aliasesFromCss(aurora.catalog, [css], {
    namespaces: DEFAULT_THEME_NAMESPACES,
  })
  const wrong = Object.fromEntries(hardcoded.tailwind.map((alias) => [alias.cssVar, alias]))
  assert.equal(wrong["--drop-shadow-halo"], undefined)
  assert.equal(wrong["--text-shadow-lift"].namespace, "text")
  assert.equal(wrong["--text-shadow-lift"].name, "shadow-lift")
})

check("Aurora's breakpoints are its own, and only the documented one says so", () => {
  const documented = aurora.catalog.breakpoints
    .filter((token) => token.documented)
    .map((token) => token.name)
  assert.deepEqual(documented, ["roomy"])
  const named = aurora.catalog.breakpoints.map((token) => token.name)
  assert.ok(named.includes("compact"), "compact is Aurora's own step")
  assert.equal(
    aurora.catalog.breakpoints.find((token) => token.name === "roomy").values.default,
    1080
  )
})

console.log("\nRelay — Tailwind v3, no @theme anywhere")

check("a manifest that omits five token groups still resolves the two it has", () => {
  assert.equal(relay.catalog.name, "Relay")
  assert.deepEqual(counts(relay.catalog), {
    colors: 3,
    spacing: 0,
    radii: 2,
    textStyles: 0,
    uiTextStyles: 0,
    effects: 0,
    icons: 0,
    motion: 0,
  })
})

check("the v3 scale comes from tailwind.config.js, through var() and through literals", () => {
  const css = fs.readFileSync(path.join(FIXTURES, "relay-v3", "styles.css"), "utf8")
  assert.equal(/@theme\b/.test(css), false, "the whole point of Relay is that it has none")

  const byKey = Object.fromEntries(
    relay.catalog.aliases.tailwind.map((alias) => [`${alias.namespace}:${alias.name}`, alias])
  )
  assert.deepEqual(Object.keys(byKey).sort(), [
    "color:brand",
    "color:brand-muted",
    "color:ink",
    "color:paper",
    "radius:card",
    "radius:pill",
  ])
  // A `var()` entry is traced the same way a v4 `@theme` entry is.
  assert.deepEqual(byKey["color:ink"].tokenIds, ["color:ink"])
  assert.equal(byKey["color:ink"].cssVar, "--relay-ink")
  // A nested DEFAULT is a literal, matched against the token's own value.
  assert.deepEqual(byKey["color:brand"].tokenIds, ["color:teal"])
  assert.equal(byKey["color:brand"].cssVar, "")
  assert.deepEqual(byKey["radius:card"].tokenIds, ["radius:card"])
  // A chain through an authored variable still lands on the canonical token.
  assert.deepEqual(byKey["color:brand-muted"].tokenIds, ["color:paper"])
  // Relay ships no effect tokens, so its boxShadow scale resolves to nothing
  // rather than to a shadow the design system does not have.
  assert.equal(
    relay.catalog.aliases.tailwind.some((alias) => alias.namespace === "shadow"),
    false
  )
})

check("a v3 host can declare its scale instead of pointing at a config file", () => {
  const declared = resolveConfig(
    {
      designSystem: {
        manifest: "./tokens.json",
        cssSources: ["./styles.css"],
        tailwindTheme: {
          color: { ink: "var(--relay-ink)" },
          radius: { pill: "var(--relay-radius-pill)" },
        },
      },
      tailwind: { version: 3 },
    },
    { configPath: path.join(FIXTURES, "relay-v3", "designlayer.config.mjs") }
  ).designSystem.catalog
  assert.deepEqual(
    declared.aliases.tailwind.map((alias) => `${alias.namespace}:${alias.name}`).sort(),
    ["color:ink", "radius:pill"]
  )
})

console.log("\nLattice — tokens that were never a manifest")

check("an adapter produces the same catalog contract a manifest does", () => {
  assert.equal(lattice.catalog.name, "Lattice")
  assert.deepEqual(counts(lattice.catalog), {
    colors: 2,
    spacing: 0,
    radii: 2,
    textStyles: 0,
    uiTextStyles: 0,
    effects: 0,
    icons: 0,
    motion: 0,
  })
  for (const group of TOKEN_GROUPS) {
    assert.ok(Array.isArray(lattice.catalog[group]), `${group} must be an array`)
  }
  // Downstream is the same code: its `@theme` block aliases exactly as a
  // manifest host's does, and an authored chain still resolves.
  assert.deepEqual(
    lattice.catalog.aliases.tailwind.map((alias) => alias.cssVar).sort(),
    ["--color-accent", "--radius-lg"]
  )
  assert.deepEqual(
    lattice.catalog.aliases.cssVariables.find((alias) => alias.name === "--lattice-button-bg"),
    { name: "--lattice-button-bg", tokenIds: ["color:accent"], ambiguous: false }
  )
})

check("a manifest and an adapter together are refused rather than silently ranked", () => {
  assert.throws(
    () => resolveConfig(
      {
        designSystem: {
          manifest: "./tokens.json",
          adapter: () => ({ colors: [] }),
          cssSources: [],
        },
      },
      { configPath: path.join(FIXTURES, "relay-v3", "designlayer.config.mjs") }
    ),
    /manifest or an adapter, not both/
  )
  assert.throws(
    () => resolveConfig(
      { designSystem: { manifest: null, adapter: () => "nope", cssSources: [] } },
      { configPath: path.join(FIXTURES, "relay-v3", "designlayer.config.mjs") }
    ),
    /adapter must return an object/
  )
})

console.log("\nTracking is declared, not guessed")

const auroraEditor = await loadEditorFor(aurora)

check("Aurora states tracking in px, so -0.4 stays -0.4px", () => {
  assert.equal(aurora.catalog.trackingUnit, "px")
  const signature = auroraEditor.textStyleSignature({
    fontSize: 28,
    lineHeight: 34,
    fontWeight: 650,
    letterSpacing: -0.4,
  })
  const matches = auroraEditor.computedTokenMatches("text-style", signature, aurora.catalog)
  assert.deepEqual(matches.map((match) => match.token.id), ["typography:headline"])

  // The magnitude heuristic this replaced read anything under 1 as em, which
  // would have multiplied Aurora's half-pixel into -11.2px and matched nothing.
  const asEm = auroraEditor.textStyleSignature({
    fontSize: 28,
    lineHeight: 34,
    fontWeight: 650,
    letterSpacing: -0.4 * 28,
  })
  assert.deepEqual(auroraEditor.computedTokenMatches("text-style", asEm, aurora.catalog), [])

  // A host that really does mean em says so, and the same token reads the other way.
  const emCatalog = { ...aurora.catalog, trackingUnit: "em" }
  assert.deepEqual(
    auroraEditor.computedTokenMatches("text-style", asEm, emCatalog).map((m) => m.token.id),
    ["typography:headline"]
  )
})

check("the config's declaration overrides the manifest's", () => {
  const overridden = resolveConfig(
    {
      designSystem: {
        manifest: "./tokens.json",
        cssSources: ["./theme.css"],
        trackingUnit: "em",
      },
    },
    { configPath: path.join(FIXTURES, "aurora-v4", "designlayer.config.mjs") }
  ).designSystem.catalog
  assert.equal(overridden.trackingUnit, "em")
  assert.throws(
    () => resolveConfig(
      { designSystem: { manifest: null, cssSources: [], trackingUnit: "rem" } },
      { configPath: path.join(FIXTURES, "aurora-v4", "designlayer.config.mjs") }
    ),
    /must be one of em, px/
  )
})

console.log("\nInspector rows follow the host, not this app")

const AURORA_FIXTURE =
  '<div id="target" class="rounded shadow" style="display:flex;gap:16px;padding:16px;' +
  "background-color:var(--aurora-surface-base);border-radius:var(--aurora-corner-panel);" +
  "box-shadow:var(--aurora-elevation-lift);font-size:28px;line-height:34px;font-weight:650;" +
  'letter-spacing:-0.4px">Aurora<span></span></div>'

const RELAY_FIXTURE =
  '<div id="target" class="rounded" style="display:flex;gap:16px;padding:16px;' +
  "background-color:var(--relay-paper);border-radius:var(--relay-radius-card);" +
  'font-size:16px;line-height:24px">Relay<span></span></div>'

await checkAsync("Aurora gets colour, text-style, radius and shadow rows — and no gap row", async () => {
  await withInspector(auroraEditor, AURORA_FIXTURE, async (harness) => {
    expectRows(harness.right, {
      present: [
        "Fill color token", "Text color token", "Text style token",
        "Corner radius token", "Shadow / effect token",
      ],
      // Aurora ships no spacing scale, so the rows that would need one are
      // dropped rather than rendering a picker with nothing in it.
      absent: ["Container gap token", "Uniform padding token", "Icon size token"],
    })
    expectPicker(harness, "fill-color", ["color:surface-base", "color:ink-primary"])
    expectPicker(harness, "shadow", ["shadow:lift", "shadow:halo"])
    expectPicker(harness, "text-style", ["typography:headline"])
  })
})

/**
 * The clamp a real engine applies to an emptied scroller, staged by hand.
 *
 * JSDOM lays nothing out, so the defect this case is about cannot occur here on
 * its own: `scrollTop` is a number it stores and hands back, and emptying a
 * container never touches it. A browser clamps the offset to zero the first
 * time anything forces layout while the container has no content, and the
 * inspector's sections force exactly that as they read computed geometry while
 * they build — which is how a panel measured at 666px came back at 0 after a
 * single property change.
 *
 * So the clamp is emulated at the one moment it happens for real: a child being
 * removed from inside the pane. Scoped to that pane, undone by the caller, and
 * deliberately blunt — what is being pinned is that the panel ends up where the
 * reader left it, not how many times an engine would have zeroed it on the way.
 */
function clampOnEmpty(window, pane) {
  const original = window.Node.prototype.removeChild
  window.Node.prototype.removeChild = function removeChild(child) {
    const removed = original.call(this, child)
    if (this === pane || pane.contains(this)) pane.scrollTop = 0
    return removed
  }
  return () => {
    window.Node.prototype.removeChild = original
  }
}

await checkAsync("picking a text style leaves the panel where the reader scrolled it", async () => {
  await withInspector(auroraEditor, AURORA_FIXTURE, async (harness) => {
    const { window, right, editor, paint } = harness
    const pane = right.querySelector("#de-tabpanel-design")
    assert.ok(pane, "the Design tab has no pane")

    /*
     * The text-style row, because it is the row this was reported against.
     * Typography sits near the bottom of a panel about twice the height of the
     * window, so choosing a style is always done scrolled down — and being
     * returned to the top costs the reader the comparison they were in the
     * middle of, on the one gesture people repeat most. Every committed
     * property takes the same path through `render()`.
     */
    const field = right.querySelector('[data-de-field="design-system.text-style"]')
    assert.ok(field, "no text-style row to pick in")
    field.click()
    const choice = window.document.querySelector(".de-token-popover [data-de-choice]")
    assert.ok(choice, "the text-style picker offered nothing to choose")

    pane.scrollTop = 240
    let restore = clampOnEmpty(window, pane)
    try {
      choice.click()
      await paint()
    } finally {
      restore()
    }
    assert.equal(pane.scrollTop, 240, "the panel jumped after a text style was picked")

    // The other half of the rule: a DIFFERENT element is a different set of
    // sections, so it gets the top of the panel rather than an offset into the
    // box that is no longer selected.
    restore = clampOnEmpty(window, pane)
    try {
      editor.select(window.document.querySelector("#target span"))
      await paint()
    } finally {
      restore()
    }
    assert.equal(pane.scrollTop, 0, "a new selection kept the previous element's scroll")
  })
})

await checkAsync("Relay gets colour and radius rows — and no text-style or shadow row", async () => {
  const relayEditor = await loadEditorFor(relay)
  await withInspector(relayEditor, RELAY_FIXTURE, async (harness) => {
    expectRows(harness.right, {
      present: ["Fill color token", "Text color token", "Corner radius token"],
      absent: [
        "Text style token", "Shadow / effect token", "Container gap token",
        "Uniform padding token", "Icon size token", "Motion duration token",
      ],
    })
    expectPicker(harness, "fill-color", ["color:ink", "color:paper", "color:teal"])
    expectPicker(harness, "corner-radius", ["radius:card", "radius:pill"])
  })
})

await checkAsync("an adapter host draws the same rows a manifest host would", async () => {
  const latticeEditor = await loadEditorFor(lattice)
  const markup =
    '<div id="target" class="rounded" style="display:flex;gap:16px;padding:16px;' +
    "background-color:var(--lattice-graphite);border-radius:var(--lattice-radius-lg);" +
    'font-size:16px;line-height:24px">Lattice<span></span></div>'
  await withInspector(latticeEditor, markup, async (harness) => {
    expectRows(harness.right, {
      present: ["Fill color token", "Corner radius token"],
      absent: ["Text style token", "Shadow / effect token", "Container gap token"],
    })
    expectPicker(harness, "corner-radius", ["radius:sm", "radius:lg"])
  })
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
