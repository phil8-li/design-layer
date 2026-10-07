/**
 * Design-system token picker cases: the field, the popover, and the one rule
 * that keeps the fix from rotting — nothing code-shaped reaches the screen.
 *
 * The catalog and the matching underneath live in token-cases.mjs. Everything
 * here is about what a designer sees and can do with a pointer or a keyboard.
 *
 * Usage: node designlayer/test/picker-cases.mjs
 */

import assert from "node:assert/strict"
import vm from "node:vm"
import { JSDOM } from "jsdom"

import { browserPrelude, loadConfig } from "../config.mjs"

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

async function loadEditorHelpers() {
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `
        export { createContext } from "./src/core/context"
        export { installInspector } from "./src/panels/inspector"
        export { tokenPickerCss } from "./src/core/css/token-picker"
        export { baseCss } from "./src/core/css/base"
        export { tokens } from "./src/core/tokens"
        export { toClassUpdate } from "./src/core/tailwind"
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

const workspace = await loadConfig(requireHostConfig("picker-cases"))
const browserSandbox = { window: {} }
vm.runInNewContext(browserPrelude(workspace, { proxyPort: 4567 }), browserSandbox)
globalThis.__DESIGNLAYER_CONFIG__ = browserSandbox.window.__DESIGNLAYER_CONFIG__
const helpers = await loadEditorHelpers()

/** Mounts the real inspector over a fixture, the way token-cases.mjs does. */
async function withInspector(markup, run) {
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
  const paint = () => new Promise((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
  )
  try {
    helpers.installInspector(editor)
    editor.select(window.document.getElementById("target"))
    await paint()
    await run({ window, right, target: window.document.getElementById("target"), pending, paint })
  } finally {
    globalThis.fetch = originalFetch
    dom.window.close()
  }
}

const field = (right, property) =>
  right.querySelector(`[data-de-field="design-system.${property}"]`)

function open(harness, property) {
  const node = field(harness.right, property)
  assert.ok(node, `${property} has no field`)
  node.click()
  const popover = harness.window.document.querySelector(".de-token-popover")
  assert.ok(popover, `${property} opened no picker`)
  return { node, popover }
}

const rowsOf = (popover) => [...popover.querySelectorAll(".de-token-row")]
const customOf = (popover) => popover.querySelector(".de-token-custom-input")
const key = (window, node, name) =>
  node.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))

const FIXTURE = `<div id="target" class="bg-background p-4" style="display:flex;padding:16px;gap:16px;background-color:var(--color-background);border-radius:20px;font-size:16px;line-height:20px">Hello<span></span></div>`

console.log("\nToken field")

await checkAsync("the closed field is a swatch and a name, and nothing else", async () => {
  await withInspector(FIXTURE, async ({ right }) => {
    const fill = field(right, "fill-color")
    assert.equal(fill.tagName, "BUTTON", "the field must be one target, not a native select")
    assert.equal(fill.getAttribute("aria-haspopup"), "listbox")
    assert.ok(fill.querySelector(".de-token-swatch--color"), "the field lost its swatch")
    assert.equal(fill.textContent, "Background/Primary")

    // A text style previews the face rather than describing it.
    const specimen = field(right, "text-style").querySelector(".de-token-swatch--text")
    assert.ok(specimen, "the text style field lost its specimen")
    assert.equal(specimen.textContent, "Ag")
  })
})

await checkAsync("an unbound field shows the plain value with no label in front of it", async () => {
  await withInspector(
    `<div id="target" style="display:flex;gap:16px;background-color:rgb(240, 242, 245)">Hi<span></span></div>`,
    async ({ right }) => {
      const fill = field(right, "fill-color")
      assert.equal(fill.textContent, "#f0f2f5")
      assert.ok(
        fill.querySelector(".de-token-field-name--plain"),
        "an unbound value must read as the element's own, not as a name"
      )
    }
  )
})

console.log("\nPicker popover")

await checkAsync("the list groups by path prefix and each row carries only its leaf", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { popover } = open(harness, "fill-color")
    const list = popover.querySelector(".de-token-list")
    let group = null
    const seen = new Map()
    for (const node of list.children) {
      if (node.classList.contains("de-token-group")) {
        group = node.textContent
        continue
      }
      const leaf = node.querySelector(".de-token-row-name").textContent
      assert.ok(group, "a row appeared before any group header")
      assert.ok(!leaf.includes("/"), `the row still repeats its path: ${leaf}`)
      seen.set(`${group}/${leaf}`, true)
    }
    // The split has to reconstruct the token exactly, or the picker is showing
    // a name the design system does not have.
    assert.ok(seen.has("Background/Primary"), "Background/Primary went missing in the split")
    assert.ok(seen.has("Text and Icon/Primary (weak)"), "a multi-word group did not survive")
    assert.equal(seen.size, 63, "the colour catalog lost rows to the grouping")

    // Exactly one header per group, so `Background` is not said forty times.
    const headers = [...popover.querySelectorAll(".de-token-group")].map((node) => node.textContent)
    assert.equal(new Set(headers).size, headers.length, "a group was headed twice")
    assert.ok(headers.includes("Background"))
  })
})

await checkAsync("a text style row pairs its specimen with its size and leading", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { popover } = open(harness, "text-style")
    const row = popover.querySelector('[data-de-choice="typography:heading-h1"]')
    assert.equal(row.querySelector(".de-token-swatch--text").textContent, "Ag")
    assert.equal(row.querySelector(".de-token-row-name").textContent, "H1")
    assert.equal(row.querySelector(".de-token-row-detail").textContent, "36/40")
  })
})

await checkAsync("a measured axis shows the measurement, and its chips differ", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { popover } = open(harness, "corner-radius")
    // Eight rows called sm…pill with eight identical circles is a worse picker
    // than the one this replaced: the number IS the decision on this axis.
    const details = rowsOf(popover).map((row) => row.querySelector(".de-token-row-detail")?.textContent)
    assert.deepEqual(details, ["8px", "12px", "16px", "20px", "24px", "32px", "36px", "999px"])

    // And the chip is a scale model rather than a clamp, so the silhouettes are
    // eight silhouettes instead of one circle repeated.
    const chips = rowsOf(popover).map((row) => row.querySelector(".de-token-swatch--radius").style.borderRadius)
    assert.equal(new Set(chips).size, 8, `the radius chips collapsed: ${chips.join(", ")}`)
    assert.equal(chips[7], "8px", "the pill has to reach the cap and read as a pill")

    const gap = open(harness, "gap")
    assert.equal(
      gap.popover.querySelector('[data-de-choice="spacing:spacing-lg"] .de-token-row-detail').textContent,
      "16px"
    )
  })
})

await checkAsync("search filters on the name, case-insensitively", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window } = harness
    const { popover } = open(harness, "fill-color")
    const search = popover.querySelector(".de-token-search-input")
    assert.equal(search.getAttribute("placeholder"), "Search")
    assert.equal(window.document.activeElement, search, "the search did not take focus on open")

    search.value = "DECORATIVE"
    search.dispatchEvent(new window.Event("input", { bubbles: true }))
    const leaves = rowsOf(popover).map((row) => row.querySelector(".de-token-row-name").textContent)
    assert.deepEqual(leaves, [
      "Amber", "Blue", "Coral", "Ochre", "Green", "Indigo", "Lime", "Teal", "Violet", "On chrome",
      "On decorative",
    ])
    // The whole path is searched, so a hit inside another family brings its own
    // header with it rather than being filed under the one the typing named.
    assert.deepEqual(
      [...popover.querySelectorAll(".de-token-group")].map((node) => node.textContent),
      ["Decorative", "Text and Icon"]
    )

    search.value = "nothing here"
    search.dispatchEvent(new window.Event("input", { bubbles: true }))
    assert.equal(rowsOf(popover).length, 0)
    assert.equal(popover.querySelector(".de-token-empty").textContent, "No matching tokens. Enter your own value below.")
  })
})

await checkAsync("the selected row is filled with the accent and inked with its counterpart", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { popover } = open(harness, "fill-color")
    const selected = popover.querySelectorAll('[aria-selected="true"]')
    assert.equal(selected.length, 1, "exactly one row is the binding")
    assert.equal(selected[0].getAttribute("data-de-choice"), "color:background-primary")
    assert.ok(selected[0].querySelector(".de-token-row-check svg"), "the selected row lost its check")
  })
})

check("a row clears the sticky group header it scrolls up under", () => {
  const rule = helpers.tokenPickerCss
  const group = /\.de-token-group \{[^}]*height: (\d+)px/.exec(rule)
  const row = /\.de-token-row \{[^}]*scroll-margin-top: (\d+)px/.exec(rule)
  assert.ok(group, "the sticky header declares no height to clear")
  assert.ok(row, "rows declare no scroll margin, so the first of a group is sliced in half")
  assert.equal(row[1], group[1], "the margin does not match the header it has to clear")
})

check("the selected row's ink is the accent's counterpart, never white", () => {
  const rule = helpers.tokenPickerCss
    .split("\n")
    .find((line) => line.startsWith('.de-token-row[aria-selected="true"] {'))
  assert.ok(rule, "the selected-row rule went missing")
  // The design system's accent is a LIGHT indigo, so the ink flips instead of
  // the surface darkening. White here would land at 1.7:1 and vanish.
  assert.ok(rule.includes(helpers.tokens.color.accentSurface), "the fill is not the accent surface")
  assert.ok(rule.includes(helpers.tokens.color.onAccent), "the ink is not the accent's counterpart")
  assert.ok(!rule.includes("#ffffff"), "white ink on a light accent")
})

// The other half of that fact: flipping a surface's ink is worth nothing if the
// children cannot hear it. `el()` stamps CHROME_ATTR on every node it builds —
// 1604 of them against 4 roots in a live session — so a bare `[data-designlayer]
// { color }` re-declares the shell's white on every descendant, and a matching
// declaration beats an inherited value at any specificity. That is what drew a
// white check mark on the dark-inked selected row, at 1.9:1.
check("the shell declares ink at its roots, not on every node it stamps", () => {
  const blanket = /\[data-designlayer\] \{([^}]*)\}/.exec(helpers.baseCss)
  assert.ok(blanket, "the shell reset went missing")
  assert.ok(
    !/(^|[;\s])color:/.test(blanket[1]),
    "the reset declares color on every stamped element, which switches inheritance off for the whole chrome"
  )
  const scoped = /\[data-designlayer\]:where\(:not\(\[data-designlayer\] \*\)\) \{([^}]*)\}/.exec(
    helpers.baseCss
  )
  assert.ok(scoped, "no root-scoped rule declares the shell's ink")
  assert.ok(scoped[1].includes(helpers.tokens.color.text), "the roots do not carry the shell's ink")
})

console.log("\nKeyboard and dismissal")

await checkAsync("arrows move the active row and Enter commits it", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window, right, target, pending } = harness
    const { popover } = open(harness, "corner-radius")
    const search = popover.querySelector(".de-token-search-input")

    search.value = "2xl"
    search.dispatchEvent(new window.Event("input", { bubbles: true }))
    assert.equal(rowsOf(popover).length, 1)

    key(window, search, "ArrowDown")
    key(window, search, "ArrowUp")
    assert.equal(rowsOf(popover)[0].getAttribute("data-active"), "true")

    const before = field(right, "corner-radius")
    key(window, search, "Enter")
    await harness.paint()

    assert.equal(window.document.querySelector(".de-token-popover"), null, "the picker stayed open")
    assert.match(target.style.borderRadius, /var\(--radius-2xl\)/)
    assert.ok(pending.length > 0, "the pick queued no source operation")
    // The commit rebuilds the panel, so the field the keyboard was on has to be
    // handed back or the next arrow key goes to <body>.
    const after = field(right, "corner-radius")
    assert.notEqual(after, before, "the inspector did not rebuild")
    assert.equal(window.document.activeElement, after)
    assert.equal(after.textContent, "Radius/2xl")
  })
})

await checkAsync("Escape closes and hands focus back to the field", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window } = harness
    const { node, popover } = open(harness, "fill-color")
    key(window, popover.querySelector(".de-token-search-input"), "Escape")
    assert.equal(window.document.querySelector(".de-token-popover"), null)
    assert.equal(window.document.activeElement, node)
    assert.equal(node.getAttribute("aria-expanded"), "false")
  })
})

await checkAsync("the active row is announced, and reads apart from the pointer's", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window } = harness
    const { popover } = open(harness, "fill-color")
    const search = popover.querySelector(".de-token-search-input")
    // Focus never leaves the search field, so the row the arrows are on has to
    // be announced from here or a screen reader hears nothing move.
    const active = () => popover.querySelector('[data-active="true"]')
    assert.equal(search.getAttribute("aria-activedescendant"), active().id)
    key(window, search, "ArrowDown")
    assert.equal(search.getAttribute("aria-activedescendant"), active().id)
    assert.equal(search.getAttribute("aria-controls"), popover.querySelector(".de-token-list").id)

    // A listbox's children are its options; a header announced as one would be
    // an option that cannot be chosen.
    for (const header of popover.querySelectorAll(".de-token-group")) {
      assert.equal(header.getAttribute("role"), "presentation")
    }

    const rule = helpers.tokenPickerCss
    assert.match(rule, /\.de-token-row\[data-active="true"\] \{[^}]*inset 0 0 0 1px/)
  })
})

await checkAsync("scrolling the list keeps the list", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window } = harness
    const { popover } = open(harness, "fill-color")
    // Seventy-one colour rows in a 320px scroller: a capture-phase scroll
    // listener sees its own list's scroll, and closing on it made the one
    // gesture this surface exists for — browsing the colours — impossible.
    popover.querySelector(".de-token-list").dispatchEvent(new window.Event("scroll"))
    assert.ok(window.document.querySelector(".de-token-popover"), "the first wheel tick closed the picker")

    // Anything else moved the field the popover is anchored to.
    window.dispatchEvent(new window.Event("scroll"))
    assert.ok(!window.document.querySelector(".de-token-popover"), "an outer scroll left it anchored to nothing")
  })
})

await checkAsync("the field closes the picker it opened", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window } = harness
    const { node } = open(harness, "fill-color")
    node.click()
    assert.equal(window.document.querySelector(".de-token-popover"), null, "the field cannot put it away")
    node.click()
    assert.ok(window.document.querySelector(".de-token-popover"), "the field cannot open it again")
  })
})

await checkAsync("Home and End belong to the text being typed", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window } = harness
    const { popover } = open(harness, "fill-color")
    const search = popover.querySelector(".de-token-search-input")
    search.value = "backgrnud"
    for (const name of ["Home", "End"]) {
      assert.equal(
        key(window, search, name),
        true,
        `${name} was swallowed while the caret was in the search field`
      )
    }
  })
})

await checkAsync("a click outside closes the picker", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window } = harness
    open(harness, "fill-color")
    window.document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }))
    assert.equal(window.document.querySelector(".de-token-popover"), null)
  })
})

await checkAsync("the picker flips above the field rather than off the bottom", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window } = harness
    // 320 of list under a field at y=700 in a 768-tall window: below is off the
    // screen, and the rows past the edge are rows that cannot be picked.
    window.Element.prototype.getBoundingClientRect = () => ({
      top: 700, bottom: 724, left: 100, right: 360, width: 260, height: 320, x: 100, y: 700,
    })
    const { popover } = open(harness, "fill-color")
    assert.equal(popover.style.top, "376px")
    assert.equal(popover.style.left, "100px")
  })
})

console.log("\nA value of your own")

/** One svg child and no direct text, which is the only shape an icon row appears on. */
const ICON_FIXTURE = `<div id="target" style="display:flex;gap:16px"><svg></svg></div>`
/**
 * No classes on the box.
 *
 * FIXTURE carries `bg-background`, and authored tracing reads a class ahead of
 * the element's own value — so its fill field keeps naming that token until the
 * source write lands, whatever is typed. That is a fact about tracing rather
 * than about this footer, and it lives in core, so the round trip is measured
 * on a box where the typed value is the only thing there is to report.
 */
const PLAIN_FIXTURE = `<div id="target" style="display:flex;padding:16px;gap:16px;background-color:rgb(240, 242, 245);border-radius:20px">Hello<span></span></div>`
/** The two axes that only appear on an element that actually moves and casts. */
const MOTION_FIXTURE = `<div id="target" style="display:flex;gap:16px;transition-duration:0.15s;box-shadow:0 1px 2px rgba(0,0,0,0.2)">Hi<span></span></div>`

await checkAsync("a typed value lands on the element, in source, and hands the field back", async () => {
  await withInspector(PLAIN_FIXTURE, async (harness) => {
    const { window, right, target, pending } = harness
    const { popover } = open(harness, "fill-color")
    const custom = customOf(popover)
    assert.ok(custom, "the picker offers no way out of the list")
    // The example is in the empty field, not in prose beside it.
    assert.equal(custom.getAttribute("placeholder"), "#0a0a0a")

    const before = field(right, "fill-color")
    custom.value = "#123456"
    key(window, custom, "Enter")
    await harness.paint()

    assert.equal(window.document.querySelector(".de-token-popover"), null, "the picker stayed open")
    assert.match(target.style.backgroundColor, /^(?:#123456|rgb\(18, 52, 86\))$/)
    assert.ok(pending.length > 0, "the typed value queued no source operation")
    // And it reaches source as a class, not as a preview the writer dropped.
    assert.deepEqual(pending.at(-1)[1].updates[0].value, "#123456")
    assert.equal(pending.at(-1)[1].updates[0].tailwindPrefix, "bg")

    // Same contract as a picked token: close first, write second, so the panel
    // has a field to hand focus back to instead of dropping it to <body>.
    const after = field(right, "fill-color")
    assert.notEqual(after, before, "the inspector did not rebuild")
    assert.equal(window.document.activeElement, after)
    // The closed field still says one thing, and now it is the designer's value.
    assert.equal(after.textContent, "#123456")
    assert.equal(after.querySelector(".de-token-custom"), null, "the escape hatch leaked into the closed field")
  })
})

await checkAsync("Enter in the typed field takes what was typed, not the row the arrows are on", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window, target } = harness
    const { popover } = open(harness, "corner-radius")
    const custom = customOf(popover)
    assert.ok(custom, "the radius picker offers no way out of the list")

    // A row IS highlighted — opening the picker parks the cursor on the binding
    // — so the window-level capture handler has a token ready to commit.
    const active = popover.querySelector('[data-active="true"]')
    assert.ok(active, "no row is highlighted, so this case cannot catch the bug it exists for")

    custom.value = "7px"
    key(window, custom, "Enter")
    await harness.paint()

    assert.equal(target.style.borderRadius, "7px")
    assert.ok(
      !target.style.borderRadius.includes("var("),
      "Enter committed the highlighted token instead of the typed value"
    )
  })
})

await checkAsync("an empty field commits nothing and leaves the picker up", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window, target, pending } = harness
    const before = target.style.backgroundColor
    const { popover } = open(harness, "fill-color")
    key(window, customOf(popover), "Enter")
    await harness.paint()
    assert.ok(window.document.querySelector(".de-token-popover"), "an empty Enter closed the picker")
    assert.equal(target.style.backgroundColor, before)
    assert.equal(pending.length, 0)
  })
})

await checkAsync("Escape still belongs to the picker while the caret is in the typed field", async () => {
  await withInspector(FIXTURE, async (harness) => {
    const { window } = harness
    const { node, popover } = open(harness, "fill-color")
    const custom = customOf(popover)
    custom.value = "#123456"
    key(window, custom, "Escape")
    assert.equal(window.document.querySelector(".de-token-popover"), null, "there is no way out of the field")
    assert.equal(window.document.activeElement, node)
  })
})

await checkAsync("the three compound axes offer no typed value, and every single-declaration axis does", async () => {
  // text-style writes four declarations and icon-size writes two: one typed
  // string cannot say which of them it is. motion-duration is the sharper case
  // — it refuses seven of its nine tokens because a spring that bounces cannot
  // survive the trip into a duration, and a typed number is that bypass.
  const has = (harness, property) => customOf(open(harness, property).popover) !== null

  await withInspector(FIXTURE, async (harness) => {
    assert.equal(has(harness, "text-style"), false, "a text style is four declarations, not one typed string")
    for (const property of ["fill-color", "text-color", "corner-radius", "gap", "padding"]) {
      assert.equal(has(harness, property), true, `${property} is one declaration and has no way out of the list`)
    }
  })
  await withInspector(ICON_FIXTURE, async (harness) => {
    assert.equal(has(harness, "icon-size"), false, "an icon size is a width and a height, not one typed string")
    assert.equal(has(harness, "svg-fill"), true)
  })
  await withInspector(MOTION_FIXTURE, async (harness) => {
    assert.equal(has(harness, "motion-duration"), false, "a typed duration walks around the bounce this axis refuses")
    assert.equal(has(harness, "shadow"), true)
  })
})

check("a typed value survives the trip into source as an arbitrary class", () => {
  // One per axis family the escape hatch is offered on. The engine assembles
  // `prefix-[value]`, so what matters is that the translation admits the raw
  // spelling rather than refusing it and leaving the edit preview-only.
  const shape = (property, value) => {
    const update = helpers.toClassUpdate(property, value)
    assert.ok(update, `${property} refuses a typed value, so it would never reach source`)
    assert.equal(update.tailwindToken, null, `${property} pretended a typed value was on the scale`)
    return `${update.tailwindPrefix}-[${update.value}]`
  }
  assert.equal(shape("background-color", "#123456"), "bg-[#123456]")
  assert.equal(shape("color", "#123456"), "text-[#123456]")
  assert.equal(shape("border-radius", "7px"), "rounded-[7px]")
  assert.equal(shape("gap", "13px"), "gap-[13px]")
  assert.equal(shape("box-shadow", "0 1px 2px #00000033"), "shadow-[0_1px_2px_#00000033]")
  assert.equal(shape("--tw-ring-color", "#123456"), "ring-[#123456]")

  // `bg` is not only a colour stem. Without a pattern of its own a recolour
  // matched on the bare prefix, so typing a fill took `bg-cover` off with it.
  const fill = new RegExp(helpers.toClassUpdate("background-color", "#123456").classPattern)
  assert.equal(fill.test("bg-[#123456]"), true)
  assert.equal(fill.test("bg-background"), true, "a themed fill must be replaced rather than duplicated")
  for (const survivor of ["bg-cover", "bg-center", "bg-no-repeat", "bg-contain"]) {
    assert.equal(fill.test(survivor), false, `recolouring the box deleted ${survivor}`)
  }
})

console.log("\nNothing code-shaped on the screen")

/**
 * The case that keeps this fix from rotting.
 *
 * Every one of these was on the screen before: option labels spelled the
 * Tailwind stem and the custom property, and the hints under them said Bound,
 * Value matches and Custom value. A row that regrows any of them fails here
 * rather than in a screenshot six weeks later.
 */
/**
 * Utility stems are matched at a word boundary rather than as bare substrings:
 * `p-` inside `Drop-shadow` is a token name, not a Tailwind class, and a sweep
 * that fails on the design system's own vocabulary gets deleted rather than fixed.
 */
const BANNED = [
  ["var(", /var\(/],
  ["--", /--/],
  ["oklch(", /oklch\(/],
  ["lab(", /lab\(/],
  ["color-mix(", /color-mix\(/],
  ["rgb(", /rgb\(/],
  ["rgba(", /rgba\(/],
  ["hsl(", /hsl\(/],
  ["utility stem", /\b(?:bg|text|rounded|shadow|gap|size|p|px|py|m|mx|my|font|border|ring|outline|duration|ease)-(?:\[|[a-z\d])/],
  ["Bound", /Bound/],
  ["Value matches", /Value matches/],
  ["authored", /authored/],
  ["Custom value", /Custom value/],
  ["token id", /token id/],
  [".de-", /\.de-/],
]

const offenders = (text) => BANNED.filter(([, pattern]) => pattern.test(text)).map(([label]) => label)

/**
 * The row types FIXTURE cannot reach.
 *
 * Only the motion axis has inert tokens, so the `Unavailable because …` hint — the
 * one remaining sentence of prose in this section — never entered the sweep
 * while the fixture declared no transition. A ring and a shadow are here for
 * the same reason: a row type that is never rendered is never scanned.
 *
 * The fill is left to `bg-sidebar` alone. An inline `background-color` here
 * would override that class in the cascade, and the row reports what the
 * element obeys — so the ambiguous-alias hint, the second sentence this fixture
 * exists to sweep, would silently stop rendering.
 */
const PROSE_FIXTURE = `<div id="target" class="ring-1 bg-sidebar" style="display:flex;gap:16px;transition-duration:0.15s;box-shadow:0 1px 2px rgba(0,0,0,0.2)">Hi<span></span></div>`

await checkAsync("no field, list or hint carries a machine spelling", async () => {
  for (const markup of [FIXTURE, PROSE_FIXTURE]) {
    await withInspector(markup, async (harness) => {
      const { right } = harness
      const properties = [...right.querySelectorAll('[data-de-field^="design-system."]')].map((node) =>
        node.getAttribute("data-de-field").replace("design-system.", "")
      )
      assert.ok(properties.length >= 6, `only ${properties.length} rows to scan`)
      if (markup === PROSE_FIXTURE) {
        // Named, because the hint this fixture exists for hangs off this row.
        assert.ok(properties.includes("motion-duration"), "the prose row never rendered")
        assert.ok(properties.includes("shadow") && properties.includes("ring-color"))
        const hints = [...right.querySelectorAll(".de-hint")].map((node) => node.textContent)
        assert.ok(
          hints.some((text) => text.startsWith("Unavailable because ")),
          "the sweep still misses the section's only prose"
        )
        assert.ok(hints.some((text) => text.startsWith("Could be ")), "the alias hint is not in the sweep")
      }

      const read = []
      let scannedTheWayOut = false
      for (const property of properties) {
        read.push(field(right, property).closest(".de-stack").textContent)
        const { popover } = open(harness, property)
        scannedTheWayOut ||= popover.querySelector(".de-token-custom") !== null
        read.push(popover.textContent)
      }
      // The escape hatch puts a label of its own in the popover, and the label
      // it must never grow back is on the list below. A sweep that never met one
      // would pass while the footer said anything at all.
      assert.ok(scannedTheWayOut, "no picker in this sweep carried the way out of the list")
      for (const text of read) {
        assert.deepEqual(offenders(text), [], `a machine spelling is on the screen: ${text.slice(0, 160)}`)
      }
    })
  }
})

check("the sweep can still fail", () => {
  // A sweep that cannot fail is not a sweep: these are the labels the old row
  // and the old option shipped, and they have to come back flagged.
  assert.deepEqual(offenders("Bound: Background/Primary · bg-background · var(--sem-background-primary)"), [
    "var(", "--", "utility stem", "Bound",
  ])
  // `rgba(` is not a superset of `rgb(` as a string, which is how the alpha
  // spelling used to walk past a list that only banned the opaque one.
  assert.deepEqual(offenders("Custom value: rgba(0, 0, 0, 0) · authored · duration-150"), [
    "rgba(", "utility stem", "authored", "Custom value",
  ])
  assert.deepEqual(offenders("rgb(12 16 20) · hsl(210 8% 20%)"), ["rgb(", "hsl("])
  // And the design system's own words are not machine spellings.
  assert.deepEqual(offenders("Drop-shadow · Elevation/2 · Text and Icon/On chrome (weak) · 999px"), [])
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
