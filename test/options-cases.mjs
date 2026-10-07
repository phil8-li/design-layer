/**
 * Cases for the options subsystem: the Leva inventory bridge, the
 * null-prototype guard on page-supplied keys, and baseline persistence.
 *
 * No browser and no servers. The inventory bridge is exercised against a
 * stubbed `window.__STORE` inside jsdom, and baseline persistence is checked
 * against the *real* server normaliser rather than a copy of it, because the
 * failure this guards against is precisely the normaliser silently dropping a
 * field the client added.
 *
 * Usage: node designlayer/test/options-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
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

/**
 * Does this sentence hand the reader something to DO?
 *
 * Deliberately not a match on the copy. Every empty and error state in this
 * subsystem is expected to keep getting better written, and an assertion that
 * pins the words is one that has to be edited each time it does — which teaches
 * the next person to change the test rather than read it. What must NOT change
 * is that the sentence names an action, so that is the whole of what is
 * checked: an imperative verb opening a clause.
 */
const RECOVERY =
  /(?:^|[.;\u2014]\s+)(Open|Reload|Select|Press|Start|Check|Navigate|Install|Add|Style|Pick|Try|Clear|Interact|Paste|Type|Run|Set|Restyle|Reselect|Apply|Save|Publish)\b/

/** A sentence with a stack trace or an HTTP status in it is addressed to nobody. */
const RAW_DIAGNOSTIC = /TypeError|ReferenceError|\bError:|\bHTTP \d|\[object /

/** Loads a TypeScript module through the bundler this package already uses. */
async function load(relativePath) {
  const { build } = await import("esbuild")
  const bundled = await build({
    entryPoints: [path.join(PACKAGE_DIR, relativePath)],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  const source = Buffer.from(bundled.outputFiles[0].text).toString("base64")
  return import(`data:text/javascript;base64,${source}`)
}

/** The shape leva's `Store.getData()` returns, reduced to what we read. */
function stubStore(data, visiblePaths) {
  const writes = []
  return {
    writes,
    getData: () => data,
    getVisiblePaths: () => visiblePaths,
    setValueAtPath(pathName, value) {
      if (pathName === "Broken.control") throw new Error("Selected value doesn't match")
      writes.push([pathName, value])
    },
  }
}

const SAMPLE = {
  "Overview.Hover.hoverPreset": {
    type: "SELECT",
    label: "preset",
    value: "Lift",
    settings: { keys: ["None", "Lift", "Tilt 3D"], values: ["None", "Lift", "Tilt 3D"] },
  },
  "Overview.Hover.hoverScale": {
    type: "NUMBER",
    label: "scale",
    value: 1.02,
    settings: { min: 1, max: 1.2, step: 0.01 },
  },
  // Ten of these share one schema in project-shell and are disambiguated with
  // trailing zero-width spaces, so the label needs normalising to be matched.
  "Overview.Hover.save": { type: "BUTTON", label: "save as default​​", value: null },
  "Overview.Analytics.chart types.barWidth": { type: "NUMBER", label: "bar width", value: 12 },
  "Sidebar.Width.collapsed": { type: "BOOLEAN", label: "collapsed", value: false },
}
const SAMPLE_VISIBLE = [
  "Overview.Hover.hoverPreset",
  "Overview.Hover.hoverScale",
  "Overview.Hover.save",
  "Sidebar.Width.collapsed",
]

/** Long enough for the filter (`FILTER_FROM`), and one of every kind of row. */
const MANY = {
  ...SAMPLE,
  "Theme.accent": { type: "COLOR", label: "accent", value: "#4f46e5" },
  "Theme.title": { type: "STRING", label: "title", value: "Turn your retail data into an app" },
  "Theme.surface": {
    type: "SELECT",
    label: "surface",
    value: "#ffffff",
    settings: { keys: ["Paper", "Ink"], values: ["#ffffff", "#111111"] },
  },
  "Theme.density": {
    type: "SELECT",
    label: "density",
    value: 3,
    settings: {
      keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
      values: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    },
  },
  "Theme.offset": { type: "VECTOR2D", label: "offset", value: { x: 1, y: 2 } },
}
const MANY_VISIBLE = [...SAMPLE_VISIBLE, ...Object.keys(MANY).filter((key) => key.startsWith("Theme."))]

async function inventoryCases() {
  console.log("\nInventory bridge")

  // A real URL, so history.pushState can move it (the list follows the page).
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.CustomEvent = dom.window.CustomEvent
  globalThis.__DESIGNLAYER_CONFIG__ = {
    controls: {
      leva: {
        storeGlobal: "__STORE",
        sourceDefaults: true,
        bindings: [
          {
            pathPattern: "Overview.Hover.*",
            selectors: ["[data-card]"],
            relationship: "spacing within",
            defaultGroup: "Card hover",
            defaultKey: null,
          },
        ],
      },
    },
  }
  const inventory = await load("src/options/inventory.ts")

  check("no __STORE reports an empty state instead of throwing", () => {
    delete dom.window.__STORE
    const result = inventory.readInventory()
    assert.equal(result.available, false)
    assert.match(result.reason, /shows your design options/)
  })

  /*
   * These four sentences ARE the Built controls tab in every state but the
   * working one. A reader who opens the browser and finds them has no list to
   * read and no control to press, so the sentence is the entire surface — and
   * one that only says the list is empty leaves them to guess whether the tab is
   * broken, whether the app is, or whether they opened the wrong thing.
   */
  check("every reason the controls tab can give names a way forward", () => {
    const reasons = []
    const config = globalThis.__DESIGNLAYER_CONFIG__

    delete dom.window.__STORE
    reasons.push(["a configured store that is absent", inventory.readInventory().reason])

    globalThis.__DESIGNLAYER_CONFIG__ = {}
    reasons.push(["a host with no Leva at all", inventory.readInventory().reason])
    globalThis.__DESIGNLAYER_CONFIG__ = config

    dom.window.__STORE = stubStore({}, [])
    reasons.push(["a store with no controls", inventory.readInventory().reason])

    // The thrown branch is the one that used to print `String(error)` into the
    // tab. The value still has to go somewhere a maintainer can read it, so the
    // warn is expected rather than merely tolerated.
    const warn = console.warn
    const warned = []
    console.warn = (...args) => warned.push(args)
    try {
      dom.window.__STORE = {
        getData() {
          throw new TypeError("Cannot read properties of undefined")
        },
        getVisiblePaths: () => [],
        setValueAtPath: () => {},
      }
      reasons.push(["a store that threw", inventory.readInventory().reason])
    } finally {
      console.warn = warn
    }
    assert.equal(warned.length, 1, "the thrown value was swallowed instead of logged")

    for (const [state, reason] of reasons) {
      assert.match(reason, RECOVERY, `${state} tells the reader nothing to do: ${reason}`)
      assert.doesNotMatch(
        reason,
        RAW_DIAGNOSTIC,
        `${state} shows a designer a diagnostic: ${reason}`
      )
    }
  })

  check("the tab calls the thing one name in every state it can be in", () => {
    const config = globalThis.__DESIGNLAYER_CONFIG__
    delete dom.window.__STORE
    const absent = inventory.readInventory().reason
    globalThis.__DESIGNLAYER_CONFIG__ = {}
    const unwired = inventory.readInventory().reason
    globalThis.__DESIGNLAYER_CONFIG__ = config
    dom.window.__STORE = stubStore({}, [])
    const empty = inventory.readInventory().reason

    // It was "the configured Leva store" in one branch and "a Leva control
    // integration" in the other, which reads as two different subsystems being
    // missing rather than one thing described twice. The vendor's name is out
    // of all of them now — the designer reading this did not choose the library
    // and cannot see it in the product — so the check is that the one name they
    // ARE given is the same name every time.
    for (const reason of [absent, unwired, empty]) {
      assert.match(reason, /design options/)
      assert.doesNotMatch(reason, /leva/i, `the vendor's name reaches a designer: ${reason}`)
    }
    assert.notEqual(absent, unwired, "the two states collapsed into one sentence")
  })

  /*
   * The pane draws these as an empty state, not as a status line, and an empty
   * state leads with what is going on before it explains it. A title that
   * merely repeated the first clause of the sentence under it would be the
   * heading costing a line and saying nothing.
   */
  check("every unavailable state leads with a headline the sentence does not repeat", () => {
    const config = globalThis.__DESIGNLAYER_CONFIG__
    const states = []

    delete dom.window.__STORE
    states.push(inventory.readInventory())
    globalThis.__DESIGNLAYER_CONFIG__ = {}
    states.push(inventory.readInventory())
    globalThis.__DESIGNLAYER_CONFIG__ = config
    dom.window.__STORE = stubStore({}, [])
    states.push(inventory.readInventory())

    for (const state of states) {
      assert.equal(state.available, false)
      assert.ok(state.title, "an unavailable state with no headline")
      assert.ok(state.title.length < 48, `the headline is a sentence: ${state.title}`)
      assert.doesNotMatch(state.title, /\.$/, `the headline is punctuated as prose: ${state.title}`)
      assert.notEqual(state.title, state.reason.split(".")[0])
    }
    assert.equal(new Set(states.map((state) => state.title)).size, states.length)
  })

  check("an object that is not a leva store is refused", () => {
    dom.window.__STORE = { getData: 1 }
    assert.equal(inventory.levaStore(), null)
    assert.equal(inventory.readInventory().available, false)
  })

  check("a store with no registered controls reports why, not zero rows", () => {
    dom.window.__STORE = stubStore({}, [])
    const result = inventory.readInventory()
    assert.equal(result.available, false)
    assert.match(result.reason, /screen that sets your design options/)
    // And it no longer tells the reader to reopen the pane afterwards. The pane
    // subscribes to the host's store and repaints itself, so that instruction
    // described a step the product has never required.
    assert.doesNotMatch(result.reason, /reopen/i)
  })

  check("a stubbed store is projected into sections, folders and controls", () => {
    dom.window.__STORE = stubStore(SAMPLE, SAMPLE_VISIBLE)
    const result = inventory.readInventory()
    assert.equal(result.available, true)
    assert.deepEqual(
      result.sections.map((section) => section.name),
      ["Overview", "Sidebar"]
    )
    const overview = result.sections[0]
    assert.deepEqual(
      overview.folders.map((folder) => folder.name),
      ["Hover", "Analytics"]
    )
    // 2 in Hover + 1 in Analytics/chart types; the save button is not a control.
    assert.equal(overview.controlCount, 3)
    assert.equal(result.controlCount, 4)
  })

  check("a save-as-default button becomes a folder badge, not a row", () => {
    dom.window.__STORE = stubStore(SAMPLE, SAMPLE_VISIBLE)
    const hover = inventory.readInventory().sections[0].folders[0]
    assert.equal(hover.hasSaveDefault, true)
    assert.deepEqual(
      hover.controls.map((control) => control.key),
      ["hoverPreset", "hoverScale"]
    )
  })

  check("named variants come through as the list a designer built", () => {
    dom.window.__STORE = stubStore(SAMPLE, SAMPLE_VISIBLE)
    const result = inventory.readInventory()
    const preset = result.sections[0].folders[0].controls[0]
    assert.deepEqual(preset.variants, ["None", "Lift", "Tilt 3D"])
    assert.equal(preset.value, "Lift")
    assert.equal(result.selectCount, 1)
    assert.equal(result.variantCount, 3)
  })

  check("explicit bindings annotate relevance and the source-default address", () => {
    dom.window.__STORE = stubStore(SAMPLE, SAMPLE_VISIBLE)
    const control = inventory.readInventory().sections[0].folders[0].controls[0]
    assert.equal(control.relationship, "spacing within")
    assert.deepEqual(control.selectors, ["[data-card]"])
    assert.equal(control.defaultGroup, "Card hover")
    assert.equal(control.defaultKey, "hoverPreset")
    assert.equal(control.canPersistDefault, true)
  })

  check("unbound paths stay unbound instead of guessing from their names", () => {
    const tree = inventory.buildTree(SAMPLE, SAMPLE_VISIBLE, [])
    const control = tree.sections[0].folders[0].controls[0]
    assert.equal(control.relationship, null)
    assert.deepEqual(control.selectors, [])
    assert.equal(control.defaultGroup, null)
  })

  check("highlight dispatch carries only host-declared target elements", () => {
    const card = dom.window.document.createElement("article")
    card.setAttribute("data-card", "")
    dom.window.document.body.append(card)
    dom.window.__STORE = stubStore(SAMPLE, SAMPLE_VISIBLE)
    const control = inventory.readInventory().sections[0].folders[0].controls[0]
    let detail = null
    dom.window.addEventListener("designlayer:highlight-elements", (event) => {
      detail = event.detail
    }, { once: true })
    const resolved = inventory.highlightControlTargets(control)
    assert.deepEqual(resolved.elements, [card])
    assert.deepEqual(detail.elements, [card])
    assert.equal(detail.relationship, "spacing within")
  })

  check("a control hidden by a render predicate is listed, flagged hidden", () => {
    dom.window.__STORE = stubStore(SAMPLE, SAMPLE_VISIBLE)
    const nested = inventory.readInventory().sections[0].folders[1].folders[0].controls[0]
    assert.equal(nested.key, "barWidth")
    assert.equal(nested.visible, false)
  })

  check("bounds published beside the value count as bounds too", () => {
    const tree = inventory.buildTree(
      { "Page.radius": { type: "NUMBER", label: "Corner radius", value: 12, min: 0, max: 32, step: 2 } },
      ["Page.radius"],
      []
    )
    assert.deepEqual(tree.sections[0].controls[0].bounds, { min: 0, max: 32, step: 2 })
  })

  check("number bounds survive so the editor can clamp", () => {
    dom.window.__STORE = stubStore(SAMPLE, SAMPLE_VISIBLE)
    const scale = inventory.readInventory().sections[0].folders[0].controls[1]
    assert.deepEqual(scale.bounds, { min: 1, max: 1.2, step: 0.01 })
  })

  check("setControlValue writes through, and a rejection is a false not a throw", () => {
    const store = stubStore(SAMPLE, SAMPLE_VISIBLE)
    dom.window.__STORE = store
    assert.equal(inventory.setControlValue("Overview.Hover.hoverPreset", "Tilt 3D"), true)
    assert.deepEqual(store.writes, [["Overview.Hover.hoverPreset", "Tilt 3D"]])
    // The rejection path warns on purpose; the stack would drown the results.
    const warn = console.warn
    console.warn = () => {}
    try {
      assert.equal(inventory.setControlValue("Broken.control", "x"), false)
    } finally {
      console.warn = warn
    }
  })

  check("subscribeToLeva degrades to a no-op when the store has no useStore", () => {
    dom.window.__STORE = stubStore(SAMPLE, SAMPLE_VISIBLE)
    const unsubscribe = inventory.subscribeToLeva(() => {})
    assert.equal(typeof unsubscribe, "function")
    unsubscribe()
  })

  /*
   * Prototype toggles usually live in the app's own state, not in Leva. A host
   * with no config at all can still hand them over on the conventional global.
   */
  check("with no config, a store on window.__DESIGNLAYER_CONTROLS__ is listed", () => {
    const config = globalThis.__DESIGNLAYER_CONFIG__
    globalThis.__DESIGNLAYER_CONFIG__ = {}
    try {
      dom.window.__DESIGNLAYER_CONTROLS__ = stubStore(
        { "Card layout options.full-height": { type: "BOOLEAN", label: "Full-height canvas", value: false } },
        ["Card layout options.full-height"]
      )
      const result = inventory.readInventory()
      assert.equal(result.available, true)
      assert.deepEqual(result.sections.map((section) => section.name), ["Card layout options"])
      const control = result.sections[0].controls[0]
      assert.equal(control.label, "Full-height canvas")
      assert.equal(control.canPersistDefault, false)
      assert.equal(inventory.setControlValue("Card layout options.full-height", true), true)
    } finally {
      delete dom.window.__DESIGNLAYER_CONTROLS__
      globalThis.__DESIGNLAYER_CONFIG__ = config
    }
  })

  check("every published store is listed, the configured one first", () => {
    const other = stubStore({ "Other.flag": { type: "BOOLEAN", label: "flag", value: true } }, ["Other.flag"])
    dom.window.__DESIGNLAYER_CONTROLS__ = other
    dom.window.__STORE = stubStore(SAMPLE, SAMPLE_VISIBLE)
    try {
      assert.deepEqual(
        inventory.readInventory().sections.map((section) => section.name),
        ["Overview", "Sidebar", "Other"]
      )
      // And a write goes to the store that owns the path, not to the first one.
      assert.equal(inventory.setControlValue("Other.flag", false), true)
      assert.deepEqual(other.writes, [["Other.flag", false]])
    } finally {
      delete dom.window.__DESIGNLAYER_CONTROLS__
    }
  })

  check("the conventional global can hold a list of stores", () => {
    const config = globalThis.__DESIGNLAYER_CONFIG__
    globalThis.__DESIGNLAYER_CONFIG__ = {}
    const page = stubStore({ "This page.full": { type: "BOOLEAN", label: "Full-height canvas", value: false } }, [])
    const app = stubStore(
      { "Theme.mode": { type: "SELECT", label: "Theme", value: "dark", settings: { keys: ["Light", "Dark"], values: ["light", "dark"] } } },
      []
    )
    // Published app-wide store FIRST: it still lists after the page's own.
    app.scope = "app"
    dom.window.__DESIGNLAYER_CONTROLS__ = [app, page, { not: "a store" }]
    try {
      const result = inventory.readInventory()
      assert.deepEqual(result.sections.map((section) => section.name), ["This page", "Theme"])
      assert.equal(inventory.setControlValue("Theme.mode", "light"), true)
      assert.deepEqual(app.writes, [["Theme.mode", "light"]])
    } finally {
      delete dom.window.__DESIGNLAYER_CONTROLS__
      globalThis.__DESIGNLAYER_CONFIG__ = config
    }
  })

  await checkAsync("a store that appears after subscribing is picked up and subscribed to", async () => {
    delete dom.window.__STORE
    let calls = 0
    const unsubscribe = inventory.subscribeToLeva(() => {
      calls += 1
    })
    try {
      const listeners = new Set()
      dom.window.__STORE = {
        ...stubStore(SAMPLE, SAMPLE_VISIBLE),
        useStore: {
          subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
      }
      await new Promise((resolve) => setTimeout(resolve, 1100))
      assert.equal(calls, 1, "the store's arrival did not notify")
      assert.equal(listeners.size, 1, "the late store was never subscribed to")
      for (const listener of listeners) listener()
      assert.equal(calls, 2)
      unsubscribe()
      assert.equal(listeners.size, 0, "unsubscribing left the store listener attached")
    } finally {
      unsubscribe()
      dom.window.__STORE = stubStore(SAMPLE, SAMPLE_VISIBLE)
    }
  })

  /*
   * Options nobody published: the on/off descriptors an app hands to its own
   * menus, found in the live React tree. Built here as a hand-made fiber tree
   * on a container, which is all `discover.ts` reads.
   */
  const discovery = await load("src/options/discover.ts")
  const fiber = (type, props = {}, children = []) => {
    const node = { type, memoizedProps: props, stateNode: null, child: null, sibling: null, return: null }
    children.forEach((child, index) => {
      child.return = node
      if (index === 0) node.child = child
      else children[index - 1].sibling = child
    })
    return node
  }
  const named = (name) => ({ [name]: function () {} })[name]
  const mount = (tree) => {
    const container = dom.window.document.createElement("div")
    const root = fiber(null, {}, [tree])
    root.stateNode = { current: root }
    container["__reactContainer$test"] = root
    dom.window.document.body.append(container)
    return container
  }
  const writes = []
  const moreItems = [
    { id: "raw", label: "View raw config", onSelect: () => {} },
    { type: "toggle", id: "full", label: "Full-height canvas", checked: false, onCheckedChange: (v) => writes.push(["full", v]) },
    { type: "divider", id: "d1" },
    { type: "toggle", id: "mesh", label: "Show mesh gradient", checked: true, onCheckedChange: (v) => writes.push(["mesh", v]) },
  ]
  const checkoutFlow = () =>
    fiber(named("CheckoutFlowView"), {}, [
      fiber(named("ProjectPageHeader"), { moreItems }, [fiber(named("ProjectMoreMenu"), { items: moreItems }, [fiber("div", {})])]),
      fiber(named("NavMenu"), { menu: { label: "Card layout options", options: [{ id: "x", label: "Hide card icons", checked: false, onCheckedChange: () => {} }] } }),
      // A form row is not an option: its value is not on/off.
      fiber(named("SettingsRows"), { rows: [{ label: "Model", value: "standard", options: ["standard"], onChange: () => {} }] }),
    ])

  check("discovery finds on/off items in a page's menus, filed under the page", () => {
    const container = mount(checkoutFlow())
    try {
      const found = discovery.scanOptions(dom.window.document)
      assert.deepEqual(
        found.map((option) => [option.section, option.label, option.checked]),
        [
          ["Checkout flow", "Full-height canvas", false],
          ["Checkout flow", "Show mesh gradient", true],
          ["Card layout options", "Hide card icons", false],
        ],
        "the same list handed down twice was listed twice, or an action or a form row slipped in"
      )
      found[0].set(true)
      assert.deepEqual(writes.at(-1), ["full", true])
    } finally {
      container.remove()
    }
  })

  check("discovery names a section the way a designer reads it", () => {
    assert.equal(discovery.humanize("CheckoutFlowView"), "Checkout flow")
    assert.equal(discovery.humanize("BillingHistoryPage"), "Billing history")
    assert.equal(discovery.humanize("ExportPDFView"), "Export PDF")
    assert.equal(discovery.humanize("e"), null, "a minified name became a section")
  })

  check("discovery never reads the editor's own chrome", () => {
    const container = mount(checkoutFlow())
    container.setAttribute("data-designlayer", "")
    try {
      assert.deepEqual(discovery.scanOptions(dom.window.document), [])
    } finally {
      container.remove()
    }
  })

  await checkAsync("discovered options join the inventory, and a published twin wins", async () => {
    const config = globalThis.__DESIGNLAYER_CONFIG__
    globalThis.__DESIGNLAYER_CONFIG__ = {}
    const published = stubStore(
      { "Page.full": { type: "BOOLEAN", label: "Full-height canvas", value: true } },
      ["Page.full"]
    )
    dom.window.__DESIGNLAYER_CONTROLS__ = published
    const container = mount(checkoutFlow())
    // A scan is reused for a quarter second; start from a fresh one.
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      const result = inventory.readInventory()
      assert.equal(result.available, true)
      const rows = result.sections.flatMap((section) => section.controls.map((control) => [section.name, control.label]))
      assert.deepEqual(rows, [
        ["Page", "Full-height canvas"],
        ["Checkout flow", "Show mesh gradient"],
        ["Card layout options", "Hide card icons"],
      ])
      const mesh = result.sections[1].controls[0]
      assert.equal(inventory.setControlValue(mesh.path, false), true)
      assert.deepEqual(writes.at(-1), ["mesh", false])
    } finally {
      container.remove()
      delete dom.window.__DESIGNLAYER_CONTROLS__
      globalThis.__DESIGNLAYER_CONFIG__ = config
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  })

  /*
   * The list follows the page. A router's `pushState` fires no event, so the
   * route is watched; coming back to the window repaints at once.
   */
  await checkAsync("a page change repaints the list without waiting for a store to say so", async () => {
    dom.window.__STORE = stubStore(SAMPLE, SAMPLE_VISIBLE)
    let calls = 0
    const unsubscribe = inventory.subscribeToLeva(() => {
      calls += 1
    })
    try {
      // A hash route, as the host uses; pushState fires no hashchange, so this is the polled path.
      dom.window.history.pushState({}, "", "#/dashboard/settings/checkout")
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.ok(calls >= 1, "a pushState navigation went unnoticed")
      const before = calls
      dom.window.dispatchEvent(new dom.window.Event("focus"))
      assert.equal(calls, before + 1, "coming back to the window did not repaint")
    } finally {
      unsubscribe()
    }
    const settled = calls
    dom.window.history.pushState({}, "", "#/somewhere-else")
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(calls, settled, "an unsubscribed listener still followed the page")
  })

  check("filtering matches a variant name, not just the control name", () => {
    const tree = inventory.buildTree(SAMPLE, SAMPLE_VISIBLE)
    const hit = inventory.filterTree(tree.sections, "tilt 3d")
    assert.deepEqual(
      hit.map((section) => section.name),
      ["Overview"]
    )
    assert.deepEqual(
      hit[0].folders[0].controls.map((control) => control.key),
      ["hoverPreset"]
    )
  })

  check("filtering a folder name keeps everything inside it", () => {
    const tree = inventory.buildTree(SAMPLE, SAMPLE_VISIBLE)
    const hit = inventory.filterTree(tree.sections, "sidebar")
    assert.equal(hit.length, 1)
    assert.equal(hit[0].controlCount, 1)
  })

  return inventory
}

function prototypeCases(inventory) {
  console.log("\nNull-prototype guard")

  check("the index every path is keyed on has no prototype", () => {
    assert.equal(Object.getPrototypeOf(inventory.nullIndex()), null)
  })

  check("a __proto__ path builds a folder instead of reassigning the prototype", () => {
    const data = {
      "__proto__.polluted.key": { type: "STRING", label: "key", value: "x" },
      "Real.Folder.key": { type: "STRING", label: "key", value: "y" },
    }
    const tree = inventory.buildTree(data, Object.keys(data))
    assert.equal({}.polluted, undefined, "Object.prototype was polluted")
    assert.equal(Object.prototype.polluted, undefined)
    assert.ok(
      tree.sections.some((section) => section.name === "__proto__"),
      "the __proto__ segment should be listed as an ordinary folder"
    )
    assert.equal(tree.controlCount, 2)
  })

  check("a __proto__ entry in visiblePaths is not read off Object.prototype", () => {
    const tree = inventory.buildTree({}, ["__proto__", "toString"])
    assert.equal(tree.controlCount, 0)
    assert.deepEqual(tree.sections, [])
  })

  check("zero-width padding does not create ten distinct labels", () => {
    assert.equal(inventory.plainLabel("save as default​​‍"), "save as default")
    assert.equal(inventory.plainLabel(undefined), "")
  })
}

async function sourceDefaultCases() {
  console.log("\nSource-backed control defaults")
  const { parseArgs } = await import(path.join(PACKAGE_DIR, "cli.mjs"))
  const { browserPrelude, resolveConfig } = await import(path.join(PACKAGE_DIR, "config.mjs"))
  const { createControlDefaults } = await import(
    path.join(PACKAGE_DIR, "server/control-defaults.mjs")
  )
  const { createDesignLayerRoutes } = await import(
    path.join(PACKAGE_DIR, "server/routes.mjs")
  )
  const fixtureDir = path.join(PACKAGE_DIR, "test/.control-default-fixture")
  const fixture = path.join(fixtureDir, "defaults.ts")
  const source = `// unrelated header stays byte-for-byte\nexport const DEFAULTS: Record<string, Record<string, unknown>> = {\n  "Card": {\n    // keep this note\n    "gap": 8,\n    "color": "#fff",\n    "dynamic": makeDefault(),\n  },\n  "Other": { "flag": true },\n}\n\nexport const SENTINEL = "untouched"\n`

  await fs.mkdir(fixtureDir, { recursive: true })
  await fs.writeFile(fixture, source)
  const config = resolveConfig(
    {
      projectRoot: PACKAGE_DIR,
      source: { roots: [fixtureDir], extensions: [".ts"] },
      controls: {
        leva: {
          storeGlobal: "__STORE",
          sourceDefaults: { file: fixture, exportName: "DEFAULTS" },
          bindings: [],
        },
      },
    },
    { cwd: PACKAGE_DIR }
  )
  const defaults = createControlDefaults(config)

  check("generic defaults do not assume Leva, Agentation, or host chrome", () => {
    const generic = resolveConfig({}, { cwd: PACKAGE_DIR })
    assert.deepEqual(generic.chrome.trustedSelectors, [])
    assert.equal(generic.chrome.trustedSelector, "")
    assert.equal(generic.controls.leva, null)
  })

  check("CLI open flags preserve an explicit false override", () => {
    assert.equal(parseArgs([]).open, undefined)
    assert.equal(parseArgs(["--open"]).open, true)
    assert.equal(parseArgs(["--no-open"]).open, false)
  })

  check("a relative projectRoot resolves from the config file, not process cwd", () => {
    const configPath = path.join(PACKAGE_DIR, ".local", "configs", "designlayer.config.mjs")
    const resolved = resolveConfig(
      { projectRoot: "../.." },
      { configPath, cwd: path.join(PACKAGE_DIR, "unrelated-cwd") }
    )
    assert.equal(resolved.projectRoot, path.resolve(PACKAGE_DIR))
  })

  /*
   * A host writes `src/lib/…` in its config meaning its own src. Resolved
   * against `process.cwd()` that became a path inside whatever directory the
   * command was typed in — outside the project by definition, and refused as
   * such. The start screen made this the normal case: it can be answered from
   * any folder on the machine, so the whole options panel and the AI handoff
   * went dark on projects that had done nothing wrong.
   */
  check("a relative source-default file is the project's, not the caller's", () => {
    const relative = resolveConfig(
      {
        projectRoot: PACKAGE_DIR,
        source: { roots: ["test/.control-default-fixture"], extensions: [".ts"] },
        controls: {
          leva: {
            storeGlobal: "__STORE",
            sourceDefaults: { file: "test/.control-default-fixture/defaults.ts", exportName: "DEFAULTS" },
            bindings: [],
          },
        },
      },
      { cwd: PACKAGE_DIR }
    )
    const elsewhere = process.cwd()
    process.chdir(os.tmpdir())
    try {
      assert.equal(createControlDefaults(relative).configured, true)
    } finally {
      process.chdir(elsewhere)
    }
  })

  check("the browser prelude excludes source-default file and export details", () => {
    const prelude = browserPrelude(config)
    assert.match(prelude, /"storeGlobal":"__STORE"/)
    assert.match(prelude, /"sourceDefaults":true/)
    assert.doesNotMatch(prelude, /defaults\.ts/)
    assert.doesNotMatch(prelude, /DEFAULTS/)
  })

  await checkAsync("reads and replaces one literal without reformatting the file", async () => {
    assert.deepEqual(await defaults.read("Card", "gap"), {
      configured: true,
      exists: true,
      value: 8,
    })
    await defaults.write("Card", "gap", 12)
    assert.equal(await fs.readFile(fixture, "utf8"), source.replace('"gap": 8', '"gap": 12'))
  })

  await checkAsync("adds and removes one key while preserving unrelated comments/content", async () => {
    await defaults.write("Card", "radius", 20)
    let next = await fs.readFile(fixture, "utf8")
    assert.match(next, /"radius": 20/)
    assert.match(next, /\/\/ keep this note/)
    assert.match(next, /export const SENTINEL = "untouched"/)
    assert.deepEqual(await defaults.remove("Card", "color"), { configured: true, existed: true })
    next = await fs.readFile(fixture, "utf8")
    assert.doesNotMatch(next, /"color"/)
    assert.match(next, /"gap": 12/)
    assert.match(next, /"radius": 20/)
    assert.match(next, /"Other": \{ "flag": true \}/)
  })

  await checkAsync("refuses to read, update, or remove a dynamic expression", async () => {
    await assert.rejects(defaults.read("Card", "dynamic"), /dynamic/)
    await assert.rejects(defaults.write("Card", "dynamic", 1), /dynamic/)
    await assert.rejects(defaults.remove("Card", "dynamic"), /dynamic/)
  })

  await checkAsync("loopback routes expose GET, PUT, and DELETE against the configured literal", async () => {
    const routes = createDesignLayerRoutes(config)
    const server = http.createServer((request, response) => {
      if (routes.handle(request, response)) return
      response.writeHead(404).end()
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    const base = `http://127.0.0.1:${address.port}${config.apiPrefix}/control-default`
    const url = `${base}?${new URLSearchParams({ group: "Other", key: "flag" })}`
    try {
      const initial = await (await fetch(url)).json()
      assert.deepEqual(initial, { configured: true, exists: true, value: true })
      const put = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: false }),
      })
      assert.equal(put.status, 200)
      assert.equal((await put.json()).value, false)
      assert.match(await fs.readFile(fixture, "utf8"), /"Other": \{ "flag": false \}/)
      const drop = await fetch(url, { method: "DELETE" })
      assert.deepEqual(await drop.json(), { configured: true, existed: true })
      assert.doesNotMatch(await fs.readFile(fixture, "utf8"), /"flag"/)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  check("refuses a configured defaults file outside editable source roots", () => {
    const unsafe = resolveConfig(
      {
        projectRoot: PACKAGE_DIR,
        source: { roots: [fixtureDir], extensions: [".ts"] },
        controls: {
          leva: {
            storeGlobal: "__STORE",
            sourceDefaults: { file: path.join(PACKAGE_DIR, "elsewhere.ts"), exportName: "DEFAULTS" },
            bindings: [],
          },
        },
      },
      { cwd: PACKAGE_DIR }
    )
    assert.throws(() => createControlDefaults(unsafe), /outside editable source roots/)
  })

  await checkAsync("refuses a source-root symlink that resolves outside the project", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "designlayer-outside-"))
    const outsideFile = path.join(outsideDir, "defaults.ts")
    const linkedFile = path.join(fixtureDir, "linked-defaults.ts")
    try {
      await fs.writeFile(outsideFile, 'export const DEFAULTS = { "Card": { "gap": 8 } }\n')
      await fs.symlink(outsideFile, linkedFile)
      const unsafe = resolveConfig(
        {
          projectRoot: PACKAGE_DIR,
          source: { roots: [fixtureDir], extensions: [".ts"] },
          controls: {
            leva: {
              storeGlobal: "__STORE",
              sourceDefaults: { file: linkedFile, exportName: "DEFAULTS" },
              bindings: [],
            },
          },
        },
        { cwd: PACKAGE_DIR }
      )
      assert.throws(() => createControlDefaults(unsafe), /outside editable source roots/)
    } finally {
      await fs.rm(linkedFile, { force: true })
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  await fs.rm(fixtureDir, { recursive: true, force: true })
}

async function writerCases() {
  console.log("\nClass snapshot writer")
  const { createWriter } = await load("src/core/writer.ts")
  const parent = document.createElement("div")
  parent.className = "parent-shell"
  const element = document.createElement("button")
  element.className = "rounded px-2 text-sm"
  parent.append(element)
  document.body.append(parent)

  const pending = []
  const bridge = {
    toast() {},
    store: {
      addPendingPropertyOperation(key, operation, propertyKeys) {
        pending.push({ key, operation, propertyKeys })
      },
    },
  }
  const selection = {
    element,
    tagName: "button",
    componentName: "Button",
    key: "Button:1:button0",
    source: {
      filePath: "src/Button.tsx",
      lineNumber: 1,
      columnNumber: 1,
      componentName: "Button",
    },
  }
  const writer = createWriter(bridge)

  check("class swaps queue the removal and preserve pre-mutation identity", () => {
    writer.applyClasses(selection, { remove: ["px-2"], add: ["px-4"] }, "Swap padding")
    assert.equal(element.className, "rounded text-sm px-4")
    assert.equal(pending[0].operation.className, "rounded px-2 text-sm")
    assert.equal(pending[0].operation.parentClassName, "parent-shell")
    assert.deepEqual(pending[0].operation.updates[0], {
      tailwindPrefix: "px-2",
      tailwindToken: "px-4",
      value: "px-4",
      standalone: true,
      classPattern: "^px-2$",
    })
  })

  check("a pure removal queues an empty exact replacement instead of preview-only", () => {
    writer.applyClasses(selection, { remove: ["text-sm"], add: [] }, "Remove text size")
    assert.equal(element.classList.contains("text-sm"), false)
    assert.equal(pending[1].operation.className, "rounded text-sm px-4")
    assert.equal(pending[1].operation.updates[0].tailwindToken, "")
    assert.equal(pending[1].operation.updates[0].classPattern, "^text-sm$")
  })

  parent.remove()
}

async function baselineCases() {
  console.log("\nBaseline persistence")

  const client = await load("src/options/store.ts")
  const { normalizeOptionSet } = await import(
    path.join(PACKAGE_DIR, "server/options-store.mjs")
  )

  const KEY = "ProjectShell:412:div0/div1/div2/div3/main0/button3"
  const baseline = {
    id: client.BASELINE_OPTION_ID,
    name: "Before options",
    className: "rounded-md p-2",
    style: { opacity: "1" },
    createdAt: 1,
  }
  const saved = {
    id: "abc",
    name: "Option 1",
    className: "rounded-xl p-4",
    style: { opacity: "0.9" },
    createdAt: 2,
  }
  const set = { key: KEY, label: "ProjectShell", activeOptionId: "abc", options: [baseline, saved] }

  check("the baseline survives the server normaliser's four-field rebuild", () => {
    const stored = normalizeOptionSet(JSON.parse(JSON.stringify(set)), KEY)
    const roundTripped = client.baselineOf(stored, KEY)
    assert.deepEqual(roundTripped, {
      className: "rounded-md p-2",
      style: { opacity: "1" },
      text: undefined,
    })
  })

  check("a top-level baseline field would NOT have survived — hence the option slot", () => {
    const stored = normalizeOptionSet({ ...set, options: [saved], baseline }, KEY)
    assert.equal(stored.baseline, undefined)
    assert.equal(client.baselineOf(stored, KEY), null)
  })

  check("the baseline is never shown as one of the saved options", () => {
    const stored = normalizeOptionSet(JSON.parse(JSON.stringify(set)), KEY)
    assert.deepEqual(
      client.visibleOptions(stored).map((option) => option.id),
      ["abc"]
    )
    assert.equal(client.visibleOptions(null).length, 0)
  })

  check("the baseline can never become the active option", () => {
    const stored = normalizeOptionSet(
      { ...set, activeOptionId: client.BASELINE_OPTION_ID },
      KEY
    )
    // The server only keeps an active id that names a real option, and the
    // client filters the baseline out of every list, so nothing can select it.
    assert.equal(stored.activeOptionId, client.BASELINE_OPTION_ID)
    assert.equal(
      client.visibleOptions(stored).some((option) => option.id === stored.activeOptionId),
      false
    )
  })

  check("a set with only a baseline reads as having no options", () => {
    const stored = normalizeOptionSet({ ...set, activeOptionId: null, options: [baseline] }, KEY)
    assert.equal(client.visibleOptions(stored).length, 0)
    assert.notEqual(client.baselineOf(stored, KEY), null)
  })
}

/**
 * Everything the options subsystem now draws, in the two places it draws it.
 *
 * One bundle for both surfaces and for `core/store`, so the state these cases
 * write is the state the panels read. Loading each entry point separately would
 * give every module its own copy of the store and the writes would land
 * nowhere — which is also why the Controls pane's scope chip has to be driven
 * through the same `setState` the right panel's button calls.
 */
async function surfaceCases() {
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `
        export { scopedStyles, styledSection } from "./src/options/panel"
        export { typographySection } from "./src/panels/inspector/section-typography"
        export { fillSection } from "./src/panels/inspector/section-fill"
        export { strokeSection } from "./src/panels/inspector/section-stroke"
        export { effectsSection } from "./src/panels/inspector/section-effects"
        export { appearanceSection } from "./src/panels/inspector/section-appearance"
        export { unifiedLayoutSection } from "./src/panels/inspector/section-unified-layout"
        export { controlsTab } from "./src/panels/controls"
        export { getState, setState, subscribe, primarySelection } from "./src/core/store"
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
 * Saved styles inside the design sections, one scope per section.
 *
 * The standalone "Saved styles" section is gone: each of Typography, Fill,
 * Stroke, Effects, Appearance and Layout carries a header toggle that opens
 * its scope's styles at the top of its body.
 */
function savedStylesCases(surface) {
  console.log("\nSaved styles, in the design sections")

  delete globalThis.window.__STORE
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  const { window } = globalThis

  const element = globalThis.document.createElement("p")
  element.textContent = "Hello"
  globalThis.document.body.append(element)
  const KEY = "panel-cases:1"
  const writes = []
  const context = {
    editor: {
      apiBase: "http://127.0.0.1:0/api",
      toast() {},
      getState: surface.getState,
      setState: surface.setState,
    },
    // Records every writer call, whatever the verb is named.
    writer: new Proxy({}, { get: (_, verb) => (...args) => writes.push([verb, ...args]) }),
    selection: { key: KEY, element, componentName: "Card", tagName: "p", source: null },
    computed: window.getComputedStyle(element),
    invalidate() {},
  }
  const click = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  const styles = (scope) => surface.scopedStyles(context, scope)
  /** Leaves the scope's panel in the wanted state, whatever an earlier case did. */
  const opened = (scope, open = true) => {
    const control = styles(scope)
    if ((control.action.getAttribute("aria-expanded") === "true") !== open) click(control.action)
    return styles(scope)
  }
  const option = (id, name, scope, className = "") => ({
    id,
    name,
    className,
    style: {},
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    scope,
  })
  const withStyles = (...options) =>
    surface.setState({ optionSets: options.length ? { [KEY]: { key: KEY, activeOptionId: null, options } } : {} })

  check("the header toggle is named for its scope and starts shut on a fresh element", () => {
    withStyles()
    const { action, body } = opened("typography", false)
    assert.equal(action.getAttribute("aria-label"), "Text styles")
    assert.equal(action.getAttribute("aria-expanded"), "false")
    assert.equal(action.disabled, false)
    assert.equal(body.hidden, true, "a shut panel with nothing applied still takes space")
    assert.equal(styles("fill").action.getAttribute("aria-label"), "Color styles")
  })

  check("the toggle opens in place and stays open across a rebuild", () => {
    withStyles()
    const shut = opened("typography", false)
    click(shut.action)
    assert.equal(shut.action.getAttribute("aria-expanded"), "true")
    assert.equal(shut.body.hidden, false)
    assert.equal(shut.body.querySelector(".de-style-panel").hidden, false)
    assert.equal(styles("typography").action.getAttribute("aria-expanded"), "true", "a rebuild closed it")
    assert.equal(styles("fill").action.getAttribute("aria-expanded"), "false", "open state leaked across scopes")
  })

  check("an empty scope names the action that fills it", () => {
    withStyles()
    const { body } = opened("typography")
    const text = body.querySelector(".de-style-empty")?.textContent ?? ""
    assert.match(text, RECOVERY, `the empty state names no action: ${text}`)
    assert.match(text, /text styles/)
  })

  check("Revert stays reachable while unavailable, and does nothing when pressed", () => {
    withStyles()
    const buttons = Array.from(opened("typography").body.querySelectorAll(".de-opt-actions button"))
    assert.deepEqual(buttons.map((b) => b.textContent.trim()), ["Save as text style", "Revert"])
    const revert = buttons[1]
    assert.equal(revert.getAttribute("aria-disabled"), "true")
    assert.equal(revert.disabled, false, "natively disabled hides its reason")
    writes.length = 0
    click(revert)
    assert.deepEqual(writes, [])
    assert.deepEqual(surface.getState().optionSets, {})
  })

  check("Save stores a style scoped to the section and restyles nothing", () => {
    withStyles()
    writes.length = 0
    const save = opened("typography").body.querySelector(".de-opt-actions button")
    click(save)
    const saved = surface.getState().optionSets[KEY]?.options.filter((o) => o.id !== "__baseline__" && o.scope)
    assert.equal(saved?.length, 1, JSON.stringify(surface.getState().optionSets[KEY]))
    assert.equal(saved[0].scope, "typography")
    assert.deepEqual(writes, [])
  })

  check("a style the element matches is shown without opening anything", () => {
    withStyles(option("s1", "Body", "typography"))
    const { body } = opened("typography", false)
    assert.equal(body.hidden, false)
    const row = body.querySelector(".de-style-applied")
    assert.ok(row && !row.hidden, "the applied style is not visible while the panel is shut")
    assert.match(row.textContent, /Body/)
    assert.equal(body.querySelector(".de-style-panel").hidden, true)
  })

  check("the open list is a radiogroup that checks the matching style", () => {
    withStyles(option("s1", "Body", "typography"), option("s2", "Large", "typography", "text-lg"))
    const { body } = opened("typography")
    const group = body.querySelector('[role="radiogroup"]')
    assert.equal(group?.getAttribute("aria-label"), "Text styles")
    const radios = Array.from(group.querySelectorAll('[role="radio"]'))
    assert.deepEqual(radios.map((r) => r.getAttribute("aria-checked")), ["true", "false"])
    for (const radio of radios) assert.equal(radio.querySelector("button"), null, "a radio owns a control")
    assert.equal(body.querySelector(".de-style-applied").hidden, true, "the name is drawn twice")
  })

  check("Update is unavailable on the matching style and live on the others", () => {
    withStyles(option("s1", "Body", "typography"), option("s2", "Large", "typography", "text-lg"))
    const updates = Array.from(opened("typography").body.querySelectorAll('button[aria-label^="Update"]'))
    assert.deepEqual(updates.map((b) => b.getAttribute("aria-disabled")), ["true", "false"])
    assert.ok(updates.every((b) => !b.disabled))
  })

  check("every row verb has an accessible name", () => {
    withStyles(option("s1", "Body", "typography"))
    const { body, action } = opened("typography")
    for (const button of [action, ...body.querySelectorAll("button")]) {
      assert.ok(button.getAttribute("aria-label") || button.textContent.trim(), button.outerHTML)
    }
    assert.ok(body.querySelector('button[aria-label="Rename Body"]'))
    assert.ok(body.querySelector('button[aria-label="Delete Body"]'))
  })

  check("a style saved in another scope is not offered here", () => {
    withStyles(option("s1", "Brand", "fill"), option("s2", "Body", "typography"))
    const names = Array.from(opened("typography").body.querySelectorAll('[role="radio"] .de-option-name')).map((n) =>
      n.textContent.trim()
    )
    assert.deepEqual(names, ["Body"])
  })

  check("choosing a style applies it through the writer", () => {
    withStyles(option("s1", "Body", "typography"), option("s2", "Large", "typography", "text-lg"))
    writes.length = 0
    const radio = opened("typography").body.querySelectorAll('[role="radio"]')[1]
    radio.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    assert.ok(writes.length > 0, "Enter on a style wrote nothing")
  })

  check("Delete removes the style and nothing else", () => {
    withStyles(option("s1", "Body", "typography"), option("s2", "Brand", "fill"))
    click(opened("typography").body.querySelector('button[aria-label="Delete Body"]'))
    const ids = surface.getState().optionSets[KEY]?.options.map((o) => o.id) ?? []
    assert.ok(!ids.includes("s1"))
    assert.ok(ids.includes("s2"))
  })

  check("the toggle and an existing + share one header strip, and styles sit above the body", () => {
    withStyles(option("s1", "Body", "typography"))
    opened("typography")
    const add = globalThis.document.createElement("button")
    add.setAttribute("aria-label", "Add fill")
    const body = globalThis.document.createElement("div")
    body.className = "own-body"
    const node = surface.styledSection(context, "typography", "Typography", body, add)
    const strip = node.querySelector(".de-section-actions .de-style-actions")
    assert.ok(strip, "no shared header strip")
    assert.deepEqual(
      Array.from(strip.children).map((b) => b.getAttribute("aria-label")),
      ["Text styles", "Add fill"]
    )
    const block = node.querySelector(".de-style-block")
    assert.ok(block.compareDocumentPosition(body) & window.Node.DOCUMENT_POSITION_FOLLOWING)
  })

  check("each design section carries its own scope's toggle", () => {
    withStyles()
    const expected = [
      ["typographySection", "Text styles"],
      ["fillSection", "Color styles"],
      ["strokeSection", "Stroke styles"],
      ["effectsSection", "Effect styles"],
      ["appearanceSection", "Appearance styles"],
      ["unifiedLayoutSection", "Layout styles"],
    ]
    // The sections reach for DOM constructors as globals, which JSDOM keeps on `window`.
    for (const name of ["Node", "HTMLElement", "HTMLInputElement", "SVGElement", "Element", "getComputedStyle", "requestAnimationFrame", "CSS"]) {
      if (!(name in globalThis) && name in window) globalThis[name] = window[name]
    }
    globalThis.requestAnimationFrame ??= (callback) => setTimeout(callback, 0)
    globalThis.cancelAnimationFrame ??= (handle) => clearTimeout(handle)
    for (const [name, label] of expected) {
      const node = surface[name](context)
      assert.ok(node, `${name} drew nothing`)
      const toggle = node.querySelector(".de-section-actions .de-style-toggle")
      assert.equal(toggle?.getAttribute("aria-label"), label, `${name} has no styles toggle`)
    }
  })

  withStyles()
  globalThis.fetch = originalFetch
  element.remove()
}

/**
 * The left panel's Controls pane — the docked replacement for the window.
 *
 * Driven through the real `controlsTab` rather than by calling its internals,
 * because most of what changed here is wiring: whether the pane needs a
 * selection to exist at all, whether the scope chips reach the store the right
 * panel's button also writes, and whether the buttons in an empty state are
 * joined up to the field or the chip that caused it.
 */
function controlsPaneCases(surface) {
  console.log("\nThe Controls pane, in the left panel")

  const { window } = globalThis
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

  let selection = null
  const editor = {
    apiBase: "http://127.0.0.1:0/api",
    toast() {},
    getState: surface.getState,
    setState: surface.setState,
    subscribe: surface.subscribe,
    primarySelection: () => selection,
  }

  window.__STORE = stubStore(MANY, MANY_VISIBLE)
  surface.setState({ controlsScope: "all" })
  const tab = surface.controlsTab(editor)
  window.document.body.append(tab.node)
  tab.update()

  const filter = () => tab.node.querySelector(".de-opt-filter")
  const chip = (label) =>
    Array.from(tab.node.querySelectorAll('[role="radio"]')).find(
      (button) => button.textContent.trim() === label
    )
  const empty = () => tab.node.querySelector(".de-empty")
  const rows = () => tab.node.querySelectorAll(".de-opt-row")
  const press = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))

  /*
   * The requirement the deleted window's own header gave as the reason it
   * mounted on `document.body`: a list of everything the app exposes must not
   * require picking something first. It is satisfied here by a pane in a tab
   * strip, which is what made the window redundant rather than merely ugly.
   */
  check("the list is fully readable with nothing selected", () => {
    assert.equal(editor.primarySelection(), null)
    assert.ok(rows().length > 0, "the pane needs a selection to show anything")
    assert.equal(empty(), null)
  })

  check("nothing is mounted over the app, and nothing here is a dialog", () => {
    assert.equal(window.document.querySelector(".de-opt-window"), null)
    assert.equal(window.document.querySelector(".de-options-root"), null)
    assert.equal(tab.node.querySelector('[role="dialog"]'), null)
    assert.equal(tab.node.getAttribute("role"), null)
  })

  /*
   * A native `disabled` would take the chip out of the accessibility tree's
   * reach and take the explanation with it. The chip stays, the reason is on
   * screen beside it, and pressing it changes nothing.
   */
  check("with nothing selected the element scope is refused out loud, not removed", () => {
    const element = chip("This element")
    assert.equal(element.getAttribute("aria-disabled"), "true")
    assert.equal(element.disabled, false, "the chip is natively disabled")
    const reason = tab.node.querySelector(".de-opt-reason")
    assert.equal(reason.hidden, false)
    assert.match(reason.textContent, RECOVERY)
    press(element)
    assert.equal(surface.getState().controlsScope, "all")
    assert.equal(chip("All").getAttribute("aria-checked"), "true")
  })

  check("selecting an element makes the scope available and takes the reason away", () => {
    const node = window.document.createElement("div")
    window.document.body.append(node)
    selection = { key: "k", element: node, componentName: "Card", tagName: "div", source: null }
    tab.update()
    assert.equal(chip("This element").getAttribute("aria-disabled"), "false")
    assert.equal(tab.node.querySelector(".de-opt-reason").hidden, true)
    node.remove()
  })

  /*
   * Bindings are opt-in, so "this element" finding nothing is an ordinary state
   * rather than a fault — which means it has to say what bindings are and hand
   * back the view that does have rows in it.
   */
  check("a scope that matches nothing explains itself and offers the way back", () => {
    const node = window.document.createElement("div")
    window.document.body.append(node)
    selection = { key: "k", element: node, componentName: "Card", tagName: "div", source: null }
    press(chip("This element"))
    assert.equal(surface.getState().controlsScope, "selection")
    assert.equal(rows().length, 0)
    const text = empty().textContent
    assert.match(text, /config/i, `the empty scope does not say where bindings come from: ${text}`)
    const back = empty().querySelector("button")
    assert.ok(back, "a scope with nothing in it offers no way out of itself")
    press(back)
    assert.equal(surface.getState().controlsScope, "all")
    assert.ok(rows().length > 0, "the rows did not come back")
    node.remove()
  })

  check("scoping to a bound element keeps its controls and drops the rest", () => {
    const node = window.document.createElement("div")
    node.setAttribute("data-card", "")
    window.document.body.append(node)
    selection = { key: "k", element: node, componentName: "Card", tagName: "div", source: null }
    const all = rows().length
    press(chip("This element"))
    assert.ok(rows().length > 0, "a bound element scoped to nothing")
    assert.ok(rows().length < all, "scoping the list did not prune it")
    press(chip("All"))
    node.remove()
    selection = null
    tab.update()
  })

  check("a filter that matches nothing hands back the control that undoes it", () => {
    filter().value = "zzzz"
    filter().dispatchEvent(new window.Event("input", { bubbles: true }))
    const miss = empty()
    assert.match(miss.textContent, /zzzz/, "the miss does not name what was typed")
    assert.equal(miss.getAttribute("role"), "status")
    const clear = miss.querySelector("button")
    assert.ok(clear, "a filter that matched nothing offers no way out of itself")
    press(clear)
    assert.equal(filter().value, "", "the button in the empty state does not clear the filter")
    assert.ok(rows().length > 0, "the rows did not come back")
    // Pressing it is what removes it from the document, so focus has to land
    // somewhere deliberate or the keyboard is dropped on the pane's body.
    assert.equal(window.document.activeElement, filter())
  })

  check("a host with no control panel gets a headline, a reason and a way forward", () => {
    delete window.__STORE
    const config = globalThis.__DESIGNLAYER_CONFIG__
    globalThis.__DESIGNLAYER_CONFIG__ = {}
    try {
      tab.update()
      const state = empty()
      assert.equal(state.getAttribute("role"), "status")
      const title = state.querySelector(".de-empty-title")
      assert.ok(title, "no headline over the explanation")
      // The reason alone: the headline's text runs straight into it in
      // textContent, which would hide a reason that opens on its verb.
      assert.match(state.textContent.slice(title.textContent.length), RECOVERY)
      assert.doesNotMatch(state.textContent, RAW_DIAGNOSTIC)
    } finally {
      globalThis.__DESIGNLAYER_CONFIG__ = config
      window.__STORE = stubStore(MANY, MANY_VISIBLE)
    }
  })

  /*
   * Invariant 5, scoped to what a rebuild can actually reach. The filter and
   * the chips outlive every render, so typing must not block the repaint the
   * typing asked for; a control inside a row must.
   */
  check("a rebuild is declined only while a row control holds focus", () => {
    tab.update()
    const input = tab.node.querySelector(".de-opt-input")
    assert.ok(input, "no editable row to hold focus")
    input.focus()
    filter().value = "zzzz"
    tab.update()
    assert.equal(empty(), null, "the pane rebuilt out from under a focused field")
    filter().value = ""
    filter().focus()
    tab.update()
    assert.ok(rows().length > 0, "typing in the filter blocked the render it asked for")
  })

  /*
   * One row, one control. Every row used to print a type eyebrow, the dot path
   * and a "Delete this control?" link; each kind now draws the control a
   * designer expects and nothing else.
   */
  const row = (label) =>
    Array.from(rows()).find((node) => node.querySelector(".de-opt-label")?.textContent === label)
  const openAll = () => {
    for (const details of tab.node.querySelectorAll("details.de-opt-folder")) details.open = true
  }

  check("a row is its label and its control, with no path, type or delete link", () => {
    tab.update()
    openAll()
    const text = tab.node.querySelector(".de-opt-body").textContent
    assert.doesNotMatch(text, /Delete this control|named choices|Changes apply/)
    assert.equal(tab.node.querySelector(".de-opt-path, .de-opt-type, .de-opt-note"), null)
    // The dot path is a developer's address: kept on the row, out of the tooltip.
    const scale = row("scale")
    assert.equal(scale.dataset.path, "Overview.Hover.hoverScale")
    assert.doesNotMatch(scale.querySelector(".de-opt-label").title, /Overview/)
    // And no bare count beside a section's name.
    assert.equal(tab.node.querySelector(".de-opt-count"), null)
  })

  check("an on/off option is a switch, and the whole line flips it", () => {
    const store = stubStore(MANY, MANY_VISIBLE)
    window.__STORE = store
    tab.update()
    openAll()
    const collapsed = row("collapsed")
    const toggle = collapsed.querySelector('[role="switch"]')
    assert.ok(toggle, "a boolean is not drawn as a switch")
    assert.equal(toggle.getAttribute("aria-checked"), "false")
    press(collapsed.querySelector(".de-opt-label"))
    assert.equal(toggle.getAttribute("aria-checked"), "true")
    assert.deepEqual(store.writes, [["Sidebar.Width.collapsed", true]])
    press(toggle)
    assert.equal(toggle.getAttribute("aria-checked"), "false")
    assert.deepEqual(store.writes.at(-1), ["Sidebar.Width.collapsed", false])
  })

  check("a bounded number is a slider and a field that clamps", () => {
    const store = stubStore(MANY, MANY_VISIBLE)
    window.__STORE = store
    tab.update()
    openAll()
    const scale = row("scale")
    const slider = scale.querySelector('input[type="range"]')
    assert.ok(slider, "a bounded number drew no slider")
    assert.equal(slider.min, "1")
    assert.equal(slider.max, "1.2")
    slider.value = "1.1"
    slider.dispatchEvent(new window.Event("input", { bubbles: true }))
    assert.deepEqual(store.writes.at(-1), ["Overview.Hover.hoverScale", 1.1])
    const field = scale.querySelector(".de-opt-input--number")
    assert.equal(field.value, "1.1", "the field did not follow the slider")
    field.value = "9"
    field.dispatchEvent(new window.Event("change", { bubbles: true }))
    assert.deepEqual(store.writes.at(-1), ["Overview.Hover.hoverScale", 1.2], "the field did not clamp")
    // An unbounded number is the field alone.
    assert.equal(row("bar width").querySelector('input[type="range"]'), null)
  })

  check("a few choices are chips, with a swatch when the value is a color", () => {
    tab.update()
    openAll()
    const surfaceRow = row("surface")
    const chips = surfaceRow.querySelectorAll(".de-opt-chip")
    assert.equal(chips.length, 2)
    assert.ok(chips[0].querySelector(".de-opt-swatch"), "a color choice has no swatch")
    assert.equal(chips[0].getAttribute("aria-pressed"), "true")
    // Nine choices are a menu rather than a wall of chips.
    const density = row("density")
    assert.equal(density.querySelectorAll(".de-opt-chip").length, 0)
    assert.equal(density.querySelector("select")?.value, "2")
  })

  check("a hex color is a swatch you can press, and its text writes through", () => {
    const store = stubStore(MANY, MANY_VISIBLE)
    window.__STORE = store
    tab.update()
    openAll()
    const accent = row("accent")
    const picker = accent.querySelector('input[type="color"]')
    assert.ok(picker, "a hex color drew no picker")
    assert.equal(picker.value, "#4f46e5")
    const text = accent.querySelector(".de-opt-input--color")
    text.value = "#ff0000"
    text.dispatchEvent(new window.Event("change", { bubbles: true }))
    assert.deepEqual(store.writes.at(-1), ["Theme.accent", "#ff0000"])
    assert.equal(picker.value, "#ff0000", "the swatch did not follow the text")
  })

  check("text is a field of its own, and a value it cannot edit is read-only", () => {
    tab.update()
    openAll()
    const title = row("title").querySelector(".de-opt-input--text")
    assert.equal(title?.value, "Turn your retail data into an app")
    const offset = row("offset")
    assert.equal(offset.querySelector("input, select, button"), null)
    assert.match(offset.querySelector(".de-opt-value").textContent, /"x":1/)
  })

  check("a long list shows the filter; a list with bindings shows the scope switch", () => {
    tab.update()
    assert.equal(filter().hidden, false, `${rows().length} options and no filter`)
    assert.equal(tab.node.querySelector(".de-opt-scope").hidden, false)
  })

  check("a lone section of prototype options starts open, like a leva panel", () => {
    window.__STORE = stubStore(
      {
        "Card layout options.full": { type: "BOOLEAN", label: "Full-height canvas", value: false },
        "Card layout options.journey": { type: "BOOLEAN", label: "Show journey controls", value: true },
      },
      ["Card layout options.full", "Card layout options.journey"]
    )
    try {
      tab.update()
      const sections = tab.node.querySelectorAll(".de-opt-body > details.de-opt-folder")
      assert.equal(sections.length, 1)
      assert.equal(sections[0].open, true, "the only section is folded shut")
      assert.equal(rows().length, 2)
      assert.equal(tab.node.querySelectorAll('.de-opt-row [role="switch"]').length, 2)
      // Three toggles need neither a filter nor a scope switch over them.
      assert.equal(filter().hidden, true, "a two-row list grew a filter")
      assert.equal(tab.node.querySelector(".de-opt-scope").hidden, true, "unbound options grew a scope switch")
    } finally {
      window.__STORE = stubStore(MANY, MANY_VISIBLE)
    }
  })

  check("a short list opens every section, and a section the reader shut stays shut", () => {
    tab.update()
    const sections = () => Array.from(tab.node.querySelectorAll(".de-opt-body > details.de-opt-folder"))
    assert.ok(sections().length > 1)
    assert.ok(sections().every((section) => section.open), "a short list hid its options behind folds")
    sections()[0].open = false
    sections()[0].dispatchEvent(new window.Event("toggle"))
    tab.update()
    assert.equal(sections()[0].open, false, "a rebuild reopened the section the reader shut")
    sections()[0].open = true
    sections()[0].dispatchEvent(new window.Event("toggle"))
  })

  check("a long list starts with its sections folded, so it reads as a map", () => {
    const long = {}
    for (let section = 0; section < 5; section += 1) {
      for (let row = 0; row < 6; row += 1) {
        long[`Section ${section}.row${row}`] = { type: "BOOLEAN", label: `Option ${row}`, value: false }
      }
    }
    window.__STORE = stubStore(long, Object.keys(long))
    try {
      tab.update()
      const sections = Array.from(tab.node.querySelectorAll(".de-opt-body > details.de-opt-folder"))
      assert.equal(sections.length, 5)
      assert.ok(sections.every((section) => !section.open), "thirty options opened as one wall")
    } finally {
      window.__STORE = stubStore(MANY, MANY_VISIBLE)
    }
  })

  tab.node.remove()
  delete window.__STORE
  globalThis.fetch = originalFetch
}

const inventory = await inventoryCases()
prototypeCases(inventory)
await sourceDefaultCases()
await writerCases()
await baselineCases()
const surface = await surfaceCases()
savedStylesCases(surface)
controlsPaneCases(surface)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
