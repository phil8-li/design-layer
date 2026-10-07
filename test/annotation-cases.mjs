/**
 * Annotations: what a note remembers, what an edit remembers, and what the two
 * of them say to an agent.
 *
 * Everything else in this editor produces a change. An annotation produces a
 * SENTENCE, and a sentence has no visible consequence — nothing repaints wrong
 * when the subsystem lies. That is the whole reason this suite is long: every
 * claim below is one that breaks in silence, with the panel still full of pins
 * and the brief still landing on the clipboard.
 *
 * THE STORE. A note is persisted, and a note holds a live DOM node it must
 * never persist: a rehydrated marker that re-attached itself to whatever now
 * sits at that selector is a note about something nobody wrote. Notes are keyed
 * per pathname, so `/pricing` and `/settings` can never pool into one list.
 * `hideUntilRestart` is written out with the rest of the settings and refused on
 * read, because a session that started with every marker hidden is
 * indistinguishable from a build that shipped broken. And a settings blob from
 * an older build is missing keys rather than wrong ones, so it merges over the
 * defaults instead of blanking them.
 *
 * THE JOURNAL. Three facts an agent acts on. A drag across three hundred frames
 * is ONE edit that started where the element started — a journal that kept the
 * last frame's `from` hands over a diff from a value to itself. `written` is the
 * field that says whether re-applying would conflict, so promoting a
 * preview-only edit to written is how an agent skips the only work still owed to
 * source. And an edit the designer took back with Cmd+Z must leave: an outbox
 * that asks for a change the designer explicitly reversed is the single worst
 * thing this feature can do, because it is wrong in the direction that destroys
 * trust in both halves of the panel at once.
 *
 * THE OUTPUT. The brief is the product. It has to interleave notes and edits in
 * the order they happened, separate what is already in the file from what is
 * still only pixels, mean something different at each of its four detail levels,
 * and never carry `/Users/<name>/` into a screen-share. The selector has to pick
 * one of two sibling buttons rather than the first of them, which is how a note
 * on Cancel comes to read as a note on Save.
 *
 * THE CANVAS, as far as jsdom can be asked. Inert while the mode is off; one
 * click is one note; a pin is clickable through an inert layer; blocking is what
 * lets a menu item be annotated at all; and the editor never annotates its own
 * chrome, which would be an infinite regress with a marker at the bottom of it.
 *
 * HOST PARITY. `src/core/config.ts` freezes the framework at module load, so a
 * host cannot be swapped at runtime and this has to load the bundle twice —
 * `host-parity-cases.mjs` documents the same constraint and solves it the same
 * way. Telling an Angular developer to open a React component names a file that
 * was never going to exist, and reads as a brief about a different application.
 *
 * Usage: node designlayer/test/annotation-cases.mjs
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

// ── The page under the editor ──────────────────────────────────────────────

/**
 * Two buttons that share a class is the fixture the selector cases exist for,
 * and the `ng-star-inserted` span is the one Angular leaves behind between two
 * change detections.
 */
const MARKUP = `<!doctype html><html><body><main id="app">
  <section class="panel">
    <div class="row">
      <button class="btn px-4" type="button">Save</button>
      <button class="btn px-4" type="button">Cancel</button>
      <span class="tag ng-star-inserted">New</span>
    </div>
    <p id="lede" class="lede">Invoices and orders in one place.</p>
  </section>
</main></body></html>`

const dom = new JSDOM(MARKUP, { pretendToBeVisual: true, url: "http://localhost/" })
const { window } = dom

/**
 * The hit stack a gesture will see. jsdom has no layout and no
 * `elementsFromPoint`, and `elementAt` is the one place the canvas asks where
 * the pointer is — so a case states the stack it means rather than pretending
 * a compositor exists.
 */
window.document.elementsFromPoint = () => window.__stack ?? []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 40, width: 120, height: 40 }
}
globalThis.DOMMatrixReadOnly = class {
  constructor() {
    this.m41 = 0
    this.m42 = 0
  }
}

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
  "KeyboardEvent",
  "PointerEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

/**
 * The marker layer repaints on a frame. jsdom's own rAF is a ~16ms timer, so a
 * case that created a note and read the layer in the same task would see an
 * empty overlay and report the painter missing. Reduced to a macrotask, so a
 * settle is a known number of ticks rather than a sleep long enough to be flaky.
 */
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

const settle = async () => {
  for (let i = 0; i < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * The vendor bridge as the global holds it — `output.ts` and `journal.ts` both
 * read it directly, because capture is synchronous and `whenBridgeReady` is
 * behind a promise. Without one, every React component stack comes back empty
 * and the parity cases would agree about two briefs that both said nothing.
 */
const COMPONENTS = {
  BUTTON: { componentName: "SaveButton", stack: [{ componentName: "Toolbar" }] },
  P: { componentName: "Lede", stack: [{ componentName: "Panel" }] },
}
window.__DESIGNLAYER_BRIDGE__ = {
  elementInfo: (element) => COMPONENTS[element?.tagName] ?? null,
}

// ── The bundles ────────────────────────────────────────────────────────────

const { build } = await import("esbuild")
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "de-annotations-"))

const bundled = await build({
  stdin: {
    contents: `
      export {
        addAnnotation,
        annotations,
        removeAnnotation,
        clearAnnotations,
        annotationSettings,
        updateSettings,
        markersVisible,
        onAnnotationsChange,
        onSettingsChange,
        resetAnnotationsForTest,
      } from "./src/annotations/store"
      export {
        recordEdit,
        edits,
        editCount,
        removeEdit,
        clearEdits,
        onEditsChange,
        dropLastEdit,
        markEditsWritten,
        resetJournalForTest,
      } from "./src/annotations/journal"
      export {
        describeElement,
        cssPath,
        outboxItems,
        buildAnnotationBrief,
        sanitizeBrief,
      } from "./src/annotations/output"
      export { installAnnotations } from "./src/annotations/canvas"
      export { annotationsTab } from "./src/panels/inspector/tab-annotations"
      export { DEFAULT_SETTINGS, OUTPUT_DETAILS } from "./src/annotations/types"
      export { annotationsCss } from "./src/core/css/annotations"
      // The sheet that used to silently outrank the swap crossfade. Exported so
      // the relationship between the two can be asserted rather than described.
      export { iconsCss } from "./src/core/css/icons"
      export { createContext } from "./src/core/context"
      export { getState, setState, selectionOwnsInput } from "./src/core/store"
      export { config } from "./src/core/config"
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

/**
 * One build, two files, one import each.
 *
 * The TEXT is identical — nothing host-specific is compiled in. What differs is
 * `src/core/config.ts`, which reads `__DESIGNLAYER_CONFIG__` at MODULE LOAD
 * and freezes the answer so two call sites can never disagree mid-session. Node
 * keys its module cache on the URL, so two loads of one URL would be one module
 * and the second host would silently run under the first host's frozen config —
 * the trap `host-parity-cases.mjs` writes its bundles to separate files to
 * avoid, for exactly this reason.
 *
 * The app is frozen at the same moment and for the same reason, which is what
 * makes a lane usable as "this editor, bound to that app": the storage key the
 * notes go under is derived from `config.app.url`, so an editor on the shop and
 * an editor on the docs site are two lanes here, exactly as they are two
 * processes on the machine.
 */
async function loadEditor(name, framework, app = { url: null, name: null }) {
  const injected = { apiBase: "/__designlayer", app, host: { framework, tailwind: true } }
  // On BOTH globals: the launcher writes it onto the page's `window`, and
  // `config.ts` reads `globalThis`, which under Node is a different object.
  window.__DESIGNLAYER_CONFIG__ = injected
  globalThis.__DESIGNLAYER_CONFIG__ = injected

  const file = path.join(bundleDir, `${name}.mjs`)
  fs.writeFileSync(file, bundled.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

const editor = await loadEditor("react-host", "react")

/**
 * A frozen clock, installed after the build so esbuild's own timers ran on a
 * real one.
 *
 * `createdAt` is `new Date().toISOString()` on both stores, and the outbox
 * interleaves the two by that string. At millisecond resolution a note and an
 * edit made in the same task TIE, and a stable sort then prints every note
 * before every edit whatever the painter did — which is an ordering test that
 * cannot fail. `tick()` is how a case says time passed.
 */
const RealDate = Date
let clock = RealDate.parse("2026-03-01T09:00:00.000Z")
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [clock]))
  }
  static now() {
    return clock
  }
}
const tick = (ms = 1000) => {
  clock += ms
}

// ── Helpers ────────────────────────────────────────────────────────────────

const $ = (selector) => window.document.querySelector(selector)
const saveButton = window.document.querySelectorAll("button")[0]
const cancelButton = window.document.querySelectorAll("button")[1]
const lede = $("#lede")

/**
 * Where a lane with no app of its own files its notes.
 *
 * `app:` is the scope `core/app-scope.ts` hands a session whose app URL never
 * resolved — one shared bucket, which is the `--dev` case and the case every
 * lane here runs under except the two in "Switching apps" below.
 */
const STORAGE_KEY = "designlayer.annotations.app:/"
const SETTINGS_KEY = "designlayer.annotation-settings"

/**
 * Both stores are module state and both outlive a case, so a case that did not
 * start from empty would be asserting on whatever the last one left behind.
 * `resetAnnotationsForTest` deliberately does NOT touch what is stored — that is
 * the seam the round-trip case needs — so the storage is cleared here instead.
 */
function reset() {
  editor.resetAnnotationsForTest()
  editor.resetJournalForTest()
  editor.setState({ selection: [] })
  window.localStorage.clear()
}

/** A note about `element`, described the way the canvas describes one. */
function note(element, comment, overrides = {}) {
  return editor.addAnnotation({
    kind: "element",
    comment,
    url: window.location.href,
    rect: { x: 10, y: 20, width: 120, height: 40 },
    target: element ? editor.describeElement(element) : null,
    selectedText: null,
    element,
    ...overrides,
  })
}

/** A Selection the way `context.select` builds one, so `sourceOf` can answer. */
function selectWithSource(element, filePath, lineNumber) {
  editor.setState({
    selection: [
      {
        element,
        tagName: element.tagName.toLowerCase(),
        componentName: "SaveButton",
        source: { filePath, lineNumber, columnNumber: 1, componentName: "SaveButton" },
        key: "fixture",
      },
    ],
  })
}

/* ==========================================================================
 * The store
 * ======================================================================== */

console.log("\nWhat a note survives")

check("a note comes back after a reload, without the element it pointed at", () => {
  reset()
  const written = note(saveButton, "This gap is too tight")
  assert.ok(written.element, "the live note lost the node it paints against")

  const raw = window.localStorage.getItem(STORAGE_KEY)
  assert.ok(raw, "nothing reached localStorage, so a reload loses every note")
  // The key is dropped rather than nulled, and checked as a key rather than as
  // text: `"kind":"element"` is in every record and says nothing about this.
  const [stored] = JSON.parse(raw)
  assert.ok(!Object.hasOwn(stored, "element"), "a DOM node was handed to JSON.stringify")

  // The reload, as the store sees one: memory dropped, storage untouched.
  editor.resetAnnotationsForTest()
  const [restored] = editor.annotations()
  assert.ok(restored, "the note did not survive the reload")
  assert.equal(restored.comment, "This gap is too tight")
  assert.equal(restored.target.tagName, "button")
  assert.deepEqual(restored.rect, { x: 10, y: 20, width: 120, height: 40 })
  // The one field that must NOT come back. A marker that silently re-attached
  // to whatever now sits at that selector is a note about something nobody
  // wrote, and it would look exactly like a working marker.
  assert.equal(restored.element, null, "a rehydrated note re-attached itself to a live node")
})

/*
 * What arrives from storage is not what the type says it is.
 *
 * `localStorage` is a string anything on the machine can write, and every build
 * that ever shipped wrote its own idea of a record into this key. The painter
 * reads `note.rect.x` on the fallback path of EVERY frame, so one record
 * without a rect threw inside the `requestAnimationFrame` callback and took the
 * whole overlay down with it — no pins, no hover outline, no selection
 * highlight, and a console error naming the painter rather than the data. A
 * seeded record with no rect did exactly that, and nothing between the read and
 * the frame had an opinion about the shape.
 *
 * Dropped rather than repaired, for the reason the validator gives: a default
 * rect puts somebody's note at the top-left of a page it was never about.
 */
const rawNote = (overrides) => ({
  id: "ann-raw",
  kind: "element",
  comment: "A stored note",
  createdAt: new Date().toISOString(),
  url: window.location.href,
  rect: { x: 10, y: 20, width: 120, height: 40 },
  target: null,
  selectedText: null,
  ...overrides,
})

/** A reload, as the store sees one: memory dropped, storage untouched. */
function loadFromStorage(records) {
  reset()
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  editor.resetAnnotationsForTest()
  return editor.annotations()
}

check("a record with no rect is dropped rather than handed to the painter", () => {
  const loaded = loadFromStorage([{ id: "seed", kind: "element", comment: "No rect", createdAt: new Date().toISOString() }])
  assert.deepEqual(loaded, [], "a rect-less record reached the painter")
})

check("one malformed record does not cost the notes stored beside it", () => {
  const loaded = loadFromStorage([
    null,
    "not a record",
    rawNote({ id: "ann-no-rect", rect: undefined }),
    // Present but not a rect, which is what a half-written migration leaves
    // behind — and what a bare `typeof rect === "object"` check lets through.
    rawNote({ id: "ann-partial", rect: { x: 1, y: 2 } }),
    // A rect built from a measurement that failed. `JSON.parse` yields no NaN,
    // so this is the shape one arrives in, and it would paint at `NaN` px:
    // nothing on screen, and nothing in the console either.
    rawNote({ id: "ann-null", rect: { x: null, y: 0, width: 1, height: 1 } }),
    rawNote({ id: "ann-good", comment: "A real note" }),
  ])
  assert.deepEqual(
    loaded.map((entry) => entry.id),
    ["ann-good"],
    "the malformed records were not the only ones dropped"
  )
  assert.equal(loaded[0].comment, "A real note")
})

check("a well-formed list still loads whole", () => {
  const loaded = loadFromStorage([rawNote({ id: "ann-1" }), rawNote({ id: "ann-2" })])
  assert.deepEqual(
    loaded.map((entry) => entry.id),
    ["ann-1", "ann-2"],
    "the validator dropped records that were never malformed"
  )
})

check("two routes never share a list", () => {
  reset()
  note(saveButton, "A note about the home page")

  dom.reconfigure({ url: "http://localhost/pricing" })
  editor.resetAnnotationsForTest()
  assert.deepEqual(editor.annotations(), [], "the home page's notes followed the user to /pricing")
  note(lede, "A note about pricing")

  dom.reconfigure({ url: "http://localhost/" })
  editor.resetAnnotationsForTest()
  const home = editor.annotations()
  assert.equal(home.length, 1, "the two routes pooled into one list")
  assert.equal(home[0].comment, "A note about the home page")
})

check("clearing the list is remembered, so the notes do not come back", () => {
  reset()
  note(saveButton, "One")
  note(lede, "Two")
  editor.clearAnnotations()
  editor.resetAnnotationsForTest()
  assert.deepEqual(editor.annotations(), [], "cleared notes returned on the next load")
})

/*
 * A note has ONE way off the list, and that is what this pins.
 *
 * There used to be two. A tick resolved a note — kept the record, stopped
 * painting it, dropped it from the brief — and a bin deleted it. They sat 2px
 * apart under identical buttons and both made the row go away, so the choice
 * was a coin toss whose consequence only showed up if you went looking for a
 * resolved note later, which the panel gave you no way to do.
 *
 * The tick went, and then the `status` field behind it, which for a while
 * survived as read-only machinery that nothing set and four filters read. A
 * field that is always one value is a branch the next reader has to disprove.
 */
check("deleting a note is the only way off the list", () => {
  reset()
  const kept = note(saveButton, "Still wrong")
  const done = note(lede, "Fixed already")

  editor.removeAnnotation(done.id)
  assert.deepEqual(
    editor.annotations().map((entry) => entry.id),
    [kept.id],
    "deleting a note left it in the store"
  )
  // No second list. `openAnnotations()` is gone with the status it filtered on,
  // so the canvas, the brief and the panel all read the same one.
  assert.equal(typeof editor.openAnnotations, "undefined", "a second note list survived")
})

/* ==========================================================================
 * Switching apps
 * ======================================================================== */

/**
 * Two editors on two apps, which on a real machine is two processes and here is
 * two module graphs.
 *
 * A switch is not a navigation. The supervisor kills this editor and binds the
 * next one to the proxy port the last one had, so the browser sees a reload of
 * the same document, on the same origin, usually on the same path. Nothing the
 * page can be asked says which app is underneath it — only the injected config
 * does — which is why a lane per app is the honest fixture here and why
 * `dom.reconfigure` is not: reconfiguring the URL would test the route half of
 * the key, which already had cases, and leave the half that was broken untested.
 *
 * The two lanes share this document and this `localStorage`, exactly as the two
 * processes share a browser profile.
 */
const shop = await loadEditor("app-shop", "react", { url: "http://127.0.0.1:3000", name: "shop-web" })
const docs = await loadEditor("app-docs", "react", { url: "http://127.0.0.1:4200", name: "docs-site" })

const SHOP_KEY = "designlayer.annotations.http-127-0-0-1-3000:/"
const DOCS_KEY = "designlayer.annotations.http-127-0-0-1-4200:/"
/** What every build before the app chooser wrote to: the path and nothing else. */
const LEGACY_KEY = "designlayer.annotations./"

/** The same note `note()` makes, on a lane of the case's choosing. */
function noteOn(lane, element, comment) {
  return lane.addAnnotation({
    kind: "element",
    comment,
    url: window.location.href,
    rect: { x: 10, y: 20, width: 120, height: 40 },
    target: lane.describeElement(element),
    selectedText: null,
    element,
  })
}

/** One record in the shape `persist()` writes, for a bucket filled by hand. */
const storedNote = (comment) => ({
  id: "ann-legacy",
  kind: "element",
  status: "open",
  comment,
  createdAt: new Date().toISOString(),
  url: window.location.href,
  rect: { x: 10, y: 20, width: 120, height: 40 },
  target: null,
  selectedText: null,
})

/**
 * The switch, as the two stores experience one: both forget everything they were
 * holding, and nothing in storage is touched. That is a reload, and on this side
 * of the wire a reload is all a switch is.
 */
function switchApps() {
  shop.resetAnnotationsForTest()
  docs.resetAnnotationsForTest()
}

const comments = (lane) => lane.annotations().map((entry) => entry.comment)

console.log("\nSwitching apps")

check("a note is filed under the app it was written on, and the next app does not see it", () => {
  reset()
  switchApps()
  noteOn(shop, saveButton, "This hero is too tight")

  assert.ok(window.localStorage.getItem(SHOP_KEY), "the note was filed somewhere that does not name the shop")
  assert.equal(window.localStorage.getItem(DOCS_KEY), null, "a note about the shop reached the docs site's bucket")

  switchApps()
  // The bug in one assertion. Before the key named the app, this came back
  // holding a note about a page the docs site does not have, pinned to elements
  // that do not exist in it, and the designer could not tell where it came from.
  assert.deepEqual(docs.annotations(), [], "the shop's notes were on screen over the docs site")
})

check("going back to the app you left finds the notes you left there", () => {
  reset()
  switchApps()
  noteOn(shop, saveButton, "This hero is too tight")

  switchApps()
  noteOn(docs, lede, "This paragraph says nothing")
  assert.deepEqual(comments(docs), ["This paragraph says nothing"])

  switchApps()
  // The promise that makes the chooser safe to click without being asked to
  // confirm anything: switching away files your work and switching back brings
  // it out again. Asserted as the round trip rather than as a key string,
  // because a key nothing reads back is not a guarantee of anything.
  assert.deepEqual(
    comments(shop),
    ["This hero is too tight"],
    "an afternoon on the shop was lost by looking at another app"
  )

  switchApps()
  // Both directions, or the case only proves the shop's bucket was never used.
  assert.deepEqual(comments(docs), ["This paragraph says nothing"], "the docs site lost its own notes")
})

check("notes from before the chooser are adopted into the app being edited", () => {
  reset()
  switchApps()
  // What a build that predated the app scope left behind, keyed on the path.
  window.localStorage.setItem(LEGACY_KEY, JSON.stringify([storedNote("Yesterday's note")]))

  assert.deepEqual(
    comments(shop),
    ["Yesterday's note"],
    "a designer reloading into the new build found yesterday's work gone"
  )
  assert.ok(window.localStorage.getItem(SHOP_KEY), "the note was read but never filed under the new key")
  // A move, not a copy. Anything left under the old key is adopted a second time
  // by the next app with an empty bucket, which is the cross-contamination the
  // scope was added to stop.
  assert.equal(window.localStorage.getItem(LEGACY_KEY), null, "the old key still holds a copy")
})

check("adoption stands down once the app has notes of its own", () => {
  reset()
  switchApps()
  noteOn(shop, saveButton, "Written since the new build shipped")
  window.localStorage.setItem(LEGACY_KEY, JSON.stringify([storedNote("Yesterday's note")]))

  switchApps()
  // Guarded on the destination being empty, and this is what the guard is for:
  // an adoption that ran again would replace everything written since with a
  // blob from before the build changed.
  assert.deepEqual(
    comments(shop),
    ["Written since the new build shipped"],
    "an adoption overwrote the notes it found already there"
  )
})

console.log("\nThe settings")

check("hideUntilRestart is refused on read, however it got onto disk", () => {
  reset()
  editor.updateSettings({ hideUntilRestart: true, clearOnCopy: true })
  assert.equal(editor.markersVisible(), false, "hiding the markers did nothing in the live session")

  const raw = window.localStorage.getItem(SETTINGS_KEY)
  assert.ok(raw.includes('"hideUntilRestart":true'), "the case is not testing what it says it is")

  editor.resetAnnotationsForTest()
  // Per tab by definition. A session that started with every marker hidden is
  // indistinguishable from the feature having shipped broken.
  assert.equal(editor.annotationSettings().hideUntilRestart, false, "the hide survived a restart")
  assert.equal(editor.markersVisible(), true)
  // And the rest of the blob did come back, or the case above proves nothing.
  assert.equal(editor.annotationSettings().clearOnCopy, true, "no setting was restored at all")
})

check("a settings blob from an older build merges over the defaults", () => {
  reset()
  // What a build that predated every key but one wrote out.
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ outputDetail: "forensic" }))
  assert.deepEqual(
    editor.annotationSettings(),
    { ...editor.DEFAULT_SETTINGS, outputDetail: "forensic" },
    "an old blob blanked the keys it never knew about"
  )
})

check("a retired setting on disk is dropped, and cannot withhold the stack", () => {
  reset()
  /*
   * What a build that still had the component-stack switch wrote out, with the
   * switch turned OFF — the one stored state that used to produce a brief with
   * no components in it. The framework is detected now, so the key is dead: it
   * must not reappear in the live settings, where `persist` would write it out
   * again forever, and it must not change what is captured.
   */
  window.localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ outputDetail: "standard", includeComponents: false })
  )
  assert.deepEqual(
    editor.annotationSettings(),
    editor.DEFAULT_SETTINGS,
    "the retired key survived the load"
  )
  note(saveButton, "Whose component is this?")
  assert.match(
    editor.buildAnnotationBrief(),
    /^\*\*React:\*\* <Toolbar> <SaveButton>$/m,
    "a stale setting still suppressed the component stack"
  )
})

check("unparseable settings fall back rather than taking the panel down", () => {
  reset()
  window.localStorage.setItem(SETTINGS_KEY, "{not json")
  assert.deepEqual(editor.annotationSettings(), editor.DEFAULT_SETTINGS)
})

console.log("\nWho is listening")

check("a listener that throws does not stop the next one running", () => {
  reset()
  const warnings = []
  const realWarn = console.warn
  console.warn = (...args) => warnings.push(args)

  const seen = []
  const stopThrower = editor.onAnnotationsChange(() => {
    throw new Error("a panel blew up mid-repaint")
  })
  const stopFirst = editor.onAnnotationsChange(() => seen.push("panel"))
  const stopSecond = editor.onAnnotationsChange(() => seen.push("canvas"))

  try {
    note(saveButton, "Anything")
  } finally {
    stopThrower()
    stopFirst()
    stopSecond()
    console.warn = realWarn
  }

  // One panel failing to repaint must not leave the canvas painting nothing.
  assert.deepEqual(seen, ["panel", "canvas"], "one broken listener silenced the rest")
  assert.equal(warnings.length, 1, "the failure was swallowed without a word")
})

check("a settings change wakes the marker layer too, not just the settings panel", () => {
  reset()
  const woken = []
  const stopNotes = editor.onAnnotationsChange(() => woken.push("notes"))
  const stopSettings = editor.onSettingsChange(() => woken.push("settings"))
  editor.updateSettings({ clearOnCopy: true })
  stopNotes()
  stopSettings()
  // The canvas reads visibility and scope from settings, so a settings write
  // that only told the settings panel would leave markers that never repaint.
  assert.deepEqual(woken, ["settings", "notes"])
})

/* ==========================================================================
 * The journal
 * ======================================================================== */

console.log("\nWhat an edit remembers")

const drag = (element, frames) => {
  for (let i = 0; i < frames; i += 1) {
    editor.recordEdit({
      property: "transform",
      // The writer reads the element to decide what a change was FROM, so each
      // frame arrives claiming the previous frame as its origin.
      from: `translate(${i}px, 0px)`,
      to: `translate(${i + 1}px, 0px)`,
      element,
      written: false,
    })
  }
}

check("a drag across three hundred frames is one edit, from where it started", () => {
  reset()
  drag(saveButton, 300)

  assert.equal(editor.editCount(), 1, "the outbox has one row per animation frame")
  const [edit] = editor.edits()
  // The whole trap in one line: keep the last frame's `from` and the brief asks
  // an agent to change `translate(299px, 0px)` into `translate(300px, 0px)`.
  assert.equal(edit.from, "translate(0px, 0px)", "the edit forgot where the element started")
  assert.equal(edit.to, "translate(300px, 0px)")
})

check("two buttons that share a class are two edits, not one", () => {
  reset()
  editor.recordEdit({ property: "color", from: "red", to: "blue", element: saveButton, written: true })
  editor.recordEdit({ property: "color", from: "red", to: "green", element: cancelButton, written: true })
  // A string key built from the component, the tag and the class list collapses
  // these two, and one of the designer's edits vanishes from the handover.
  assert.equal(editor.editCount(), 2, "an edit to Cancel folded onto the edit to Save")
})

check("a write that lands back on its starting value is not an edit", () => {
  reset()
  assert.equal(
    editor.recordEdit({ property: "color", from: "red", to: "red", element: saveButton, written: true }),
    null,
    "a no-op write queued a row an agent has to read past"
  )
  assert.equal(editor.editCount(), 0)
})

check("written and unwritten stay distinguishable, which is what an agent acts on", () => {
  reset()
  editor.recordEdit({ property: "padding", from: "16px", to: "24px", element: lede, written: true })
  editor.recordEdit({ property: "icon", from: "Star", to: "Heart", element: saveButton, written: false })

  assert.deepEqual(
    editor.edits().map((edit) => [edit.property, edit.written]),
    [
      ["padding", true],
      ["icon", false],
    ]
  )

  editor.markEditsWritten()
  // The tempting one-liner sets every row written. It would also promote the
  // icon swap, which is in the outbox precisely BECAUSE Apply wrote nothing for
  // it — and an agent told it is already in the file skips the only change
  // still owed to source.
  assert.equal(
    editor.edits().find((edit) => edit.property === "icon").written,
    false,
    "Apply promoted a change it never wrote"
  )
})

console.log("\nUndo")

check("an edit the designer took back leaves the outbox", () => {
  reset()
  editor.recordEdit({ property: "gap", from: "8px", to: "16px", element: lede, written: false })
  assert.equal(editor.editCount(), 1)
  editor.dropLastEdit()
  // The worst thing this feature can do: hand an agent an instruction to put
  // back the thing the designer just took out.
  assert.deepEqual(editor.edits(), [], "Cmd+Z left the reversed change in the handover")
})

check("one undo is one nudge, not the whole collapsed row", () => {
  reset()
  drag(lede, 3)
  editor.dropLastEdit()

  assert.equal(editor.editCount(), 1, "undoing one keypress dropped the other two")
  const [edit] = editor.edits()
  assert.equal(edit.from, "translate(0px, 0px)")
  assert.equal(edit.to, "translate(2px, 0px)", "the row did not rewind by exactly one step")
})

check("nudging back to the start empties the row, and undo puts it back in place", () => {
  reset()
  editor.recordEdit({ property: "color", from: "red", to: "blue", element: saveButton, written: false })
  editor.recordEdit({ property: "top", from: "0px", to: "4px", element: lede, written: false })
  // Out and straight back: the same non-event arrived at in two steps, so the
  // entry leaves rather than reporting `red` -> `red`.
  editor.recordEdit({ property: "top", from: "4px", to: "0px", element: lede, written: false })
  assert.deepEqual(
    editor.edits().map((edit) => edit.property),
    ["color"]
  )

  editor.dropLastEdit()
  // Back at index 1, not appended: the outbox reads in the order things
  // happened, and an undo does not make an old edit new.
  assert.deepEqual(
    editor.edits().map((edit) => edit.property),
    ["color", "top"],
    "the restored edit jumped the order the session happened in"
  )
})

check("a row the designer dismissed is never resurrected by a later undo", () => {
  reset()
  const dropped = editor.recordEdit({
    property: "color",
    from: "red",
    to: "blue",
    element: saveButton,
    written: false,
  })
  editor.recordEdit({ property: "top", from: "0px", to: "4px", element: lede, written: false })
  editor.removeEdit(dropped.id)

  editor.dropLastEdit()
  editor.dropLastEdit()
  // Dismissing is not undoable, so the recordings behind that row are
  // neutralized rather than spliced out — splicing would have some later undo
  // eat an unrelated entry instead.
  assert.deepEqual(editor.edits(), [], "a dismissed row came back on the second Cmd+Z")
})

/* ==========================================================================
 * The output
 * ======================================================================== */

console.log("\nThe selector")

check("two siblings that share a class get two different selectors", () => {
  const save = editor.cssPath(saveButton)
  const cancel = editor.cssPath(cancelButton)
  assert.notEqual(save, cancel, "a note on Cancel reads in devtools as a note on Save")
  for (const [selector, element] of [
    [save, saveButton],
    [cancel, cancelButton],
  ]) {
    const found = Array.from(window.document.querySelectorAll(selector))
    assert.deepEqual(found, [element], `${selector} did not pick out the element it describes`)
  }
})

check("the path anchors on the nearest unique id rather than climbing to html", () => {
  const selector = editor.cssPath(saveButton)
  assert.ok(selector.startsWith("#app > "), selector)
})

check("Angular's runtime classes stay out of a selector that has to keep working", () => {
  const selector = editor.cssPath($(".tag"))
  // `ng-star-inserted` is there now and gone after the next change detection,
  // which reads to whoever pasted the selector as the element being deleted.
  assert.ok(!selector.includes("ng-"), selector)
  assert.deepEqual(Array.from(window.document.querySelectorAll(selector)), [$(".tag")])
})

console.log("\nThe outbox")

check("notes and edits come back as one list, in the order they happened", () => {
  reset()
  note(saveButton, "First thought")
  tick()
  editor.recordEdit({ property: "padding", from: "16px", to: "24px", element: lede, written: true })
  tick()
  note(lede, "Second thought")

  const items = editor.outboxItems()
  assert.deepEqual(
    items.map((item) => item.type),
    ["note", "edit", "note"],
    "the merge grouped the two stores instead of interleaving them"
  )
  assert.deepEqual(
    items.map((item) => item.at),
    [...items].sort((a, b) => a.at - b.at).map((item) => item.at)
  )
  // "I moved this" then "and it still looks wrong" is a different report from
  // the same two items the other way round.
  assert.equal(items[0].note.comment, "First thought")
  assert.equal(items[2].note.comment, "Second thought")
})

console.log("\nThe brief")

/** One note, one written change and one that is still only pixels. */
function seedBrief() {
  reset()
  selectWithSource(saveButton, "/Users/someone/app/src/components/card.tsx", 42)
  note(saveButton, "This button is doing too much")
  tick()
  editor.recordEdit({ property: "padding", from: "16px", to: "24px", element: lede, written: true })
  // Apply ran: the padding is in the file, not merely queued for it.
  editor.markEditsWritten()
  tick()
  editor.recordEdit({ property: "icon", from: "Star", to: "Heart", element: saveButton, written: false })
}

/** The block of one `### N.` item, up to the next item or the end. */
function briefItem(brief, number) {
  const start = brief.indexOf(`### ${number}. `)
  if (start === -1) return ""
  const next = brief.indexOf("\n### ", start + 1)
  return brief.slice(start, next === -1 ? undefined : next)
}

check("the brief states each change's status, unmissably", () => {
  seedBrief()
  editor.updateSettings({ outputDetail: "standard" })
  const brief = editor.buildAnnotationBrief()

  // Sections by kind are gone: one list, and the status rides on each item.
  assert.ok(!brief.includes("## Already written to source"), "the edits still sit under their own headings")
  assert.ok(!brief.includes("## Showing in the browser only"), "the edits still sit under their own headings")

  const done = briefItem(brief, 2)
  const todo = briefItem(brief, 3)
  assert.match(done, /24px/)
  assert.match(
    done,
    /\*\*Status:\*\* Already written to source — do not apply again\n\*\*Change:\*\*/,
    "the applied change does not say it is done, right before what it changed"
  )
  assert.match(todo, /swap the icon to `Heart`/)
  assert.match(todo, /\*\*Status:\*\* Showing in the browser only — still needs writing/)
  assert.ok(!/Already written/.test(todo), "the preview-only change was filed as already in the file")
  // Spelled out once at the top as well: this is the sentence that stops an
  // agent applying the designer's padding change a second time.
  const header = brief.slice(0, brief.indexOf("### 1."))
  assert.match(header, /Do not apply them again — a second application is a conflict, not a fix\./)
})

check("the brief numbers notes and edits as one list, in the order they happened", () => {
  reset()
  editor.updateSettings({ outputDetail: "standard" })
  note(saveButton, "First thought")
  tick()
  editor.recordEdit({ property: "padding", from: "16px", to: "24px", element: lede, written: false })
  tick()
  note(lede, "Second thought")
  const brief = editor.buildAnnotationBrief()

  assert.match(briefItem(brief, 1), /\*\*Feedback:\*\* First thought/)
  assert.match(briefItem(brief, 2), /\*\*Change:\*\* set `padding` to `24px`/)
  assert.match(briefItem(brief, 3), /\*\*Feedback:\*\* Second thought/)
  assert.equal(briefItem(brief, 4), "", "an item was numbered twice")
  // Nothing is written, so there is nothing to warn about re-applying.
  assert.ok(!brief.includes("Do not apply them again"), "a warning about written work with none written")
})

check("a queued edit is not described as already written", () => {
  reset()
  editor.updateSettings({ outputDetail: "standard" })
  // `written` is set the moment the writer can spell it; until Apply runs the
  // change is queued, and in no file.
  editor.recordEdit({ property: "padding", from: "16px", to: "24px", element: lede, written: true })
  const brief = editor.buildAnnotationBrief()

  assert.ok(!/Already written/i.test(brief), "a queued change told the agent it is already in the file")
  assert.match(
    briefItem(brief, 1),
    /\*\*Status:\*\* Queued in DesignLayer — it will write this itself; do not apply by hand/
  )

  editor.updateSettings({ outputDetail: "compact" })
  assert.match(editor.buildAnnotationBrief(), /^1\. .*— queued in DesignLayer, do not apply by hand$/m)

  editor.markEditsWritten()
  assert.match(editor.buildAnnotationBrief(), /^1\. .*— already written, do not apply again$/m)
})

check("nothing to hand over says so, rather than printing empty headings", () => {
  reset()
  assert.match(editor.buildAnnotationBrief(), /^Nothing to hand over yet\./)
})

check("the four detail levels mean four different things", () => {
  seedBrief()
  const briefs = {}
  for (const { id } of editor.OUTPUT_DETAILS) {
    editor.updateSettings({ outputDetail: id })
    briefs[id] = editor.buildAnnotationBrief()
  }

  assert.deepEqual(
    editor.OUTPUT_DETAILS.map((level) => level.id),
    ["compact", "standard", "detailed", "forensic"]
  )
  const sizes = ["compact", "standard", "detailed", "forensic"].map((id) => briefs[id].length)
  assert.deepEqual(
    sizes,
    [...sizes].sort((a, b) => a - b),
    `the levels do not grow: ${sizes.join(" < ")}`
  )
  assert.ok(new Set(sizes).size === 4, `two levels produced the same brief: ${sizes.join(", ")}`)

  // Compact is one line per item and stops. Anything else here means a level
  // that says it is compact and is not.
  assert.ok(!briefs.compact.includes("**Location:**"), "compact printed the location")
  assert.ok(!briefs.compact.includes("**Viewport:**"), "compact printed the viewport")
  assert.match(briefs.compact, /^1\. \*\*button "Save"\*\* \(src\/components\/card\.tsx:42:1\): /m)

  assert.ok(briefs.standard.includes("**Location:**"), "standard lost the location")
  assert.ok(briefs.standard.includes("**Source:**"), "standard lost the source line")
  assert.ok(briefs.standard.includes("**Viewport:**"), "standard lost the viewport")
  assert.ok(!briefs.standard.includes("**Classes:**"), "standard leaked the classes")

  assert.ok(briefs.detailed.includes("**Classes:** btn, px-4"), "detailed lost the classes")
  assert.ok(briefs.detailed.includes("**Position:** 10px, 20px (120×40px)"), "detailed lost the box")
  assert.ok(briefs.detailed.includes("**Context:**"), "detailed lost the nearby text")
  assert.ok(!briefs.detailed.includes("**Environment:**"), "detailed leaked the environment block")

  assert.ok(briefs.forensic.includes("**Environment:**"), "forensic lost the environment block")
  assert.ok(briefs.forensic.includes("- Viewport:"), "forensic lost the viewport")
  assert.ok(briefs.forensic.includes("**Full DOM Path:**"), "forensic lost the DOM path")
  assert.ok(briefs.forensic.includes("**Computed Styles:**"), "forensic lost the computed styles")
  assert.ok(briefs.forensic.includes("**Annotation at:**"), "forensic lost the pin's place")

  // Detailed is standard plus lines, so asking for more never takes a line away.
  assert.ok(briefs.detailed.includes("**Location:**"))
  assert.ok(briefs.forensic.includes("**Source:**"))
})

/*
 * Every note in the store is in the brief, and the two cannot drift.
 *
 * The brief used to filter on `status`, which is why the bar had to filter its
 * count the same way: two readers of one list, each deciding for itself what
 * counted, and a toast that could say "Copied 1 note" over a brief saying there
 * was nothing to hand over. With one state left there is nothing to filter and
 * nothing to disagree about — a note that is present is work, and a note that
 * is deleted is not there to ask about.
 */
check("every note in the store is in the brief", () => {
  seedBrief()
  editor.updateSettings({ outputDetail: "standard" })
  const [pinned] = editor.annotations()
  assert.ok(
    editor.buildAnnotationBrief().includes("This button is doing too much"),
    "a pinned note was left out of the brief"
  )

  editor.removeAnnotation(pinned.id)
  assert.ok(
    !editor.buildAnnotationBrief().includes("This button is doing too much"),
    "a deleted note was still asked for"
  )
})

console.log("\nThe brief is in Agentation's format")

/*
 * Agentation runs beside the editor as a companion, and a note from either tool
 * has to reach the agent as the same document. These cases pin the format
 * itself — header, item heading, field names and order — rather than words
 * somewhere in it.
 */

/** Markup from a settings page, mounted for one case and taken away again. */
function withFixture(markup, fn) {
  const host = window.document.createElement("div")
  host.innerHTML = markup
  window.document.body.append(host)
  try {
    fn(host)
  } finally {
    host.remove()
  }
}

check("a note reads exactly as Agentation would copy it", () => {
  reset()
  editor.updateSettings({ outputDetail: "standard" })
  selectWithSource(saveButton, "/Users/someone/app/src/components/card.tsx", 42)
  note(saveButton, "This button is doing too much")
  assert.equal(
    editor.buildAnnotationBrief(),
    [
      "## Page Feedback: /",
      "**App:** app on localhost",
      `**Viewport:** ${window.innerWidth}×${window.innerHeight}`,
      "",
      '### 1. button "Save"',
      "**Location:** #app > .panel > .row > .btn",
      "**Source:** src/components/card.tsx:42:1",
      "**React:** <Toolbar> <SaveButton>",
      "**Feedback:** This button is doing too much",
    ].join("\n")
  )
})

check("compact is Agentation's one line per note, and says nothing else", () => {
  reset()
  editor.updateSettings({ outputDetail: "compact" })
  selectWithSource(saveButton, "/Users/someone/app/src/components/card.tsx", 42)
  note(saveButton, "Too loud")
  assert.equal(
    editor.buildAnnotationBrief(),
    [
      "## Page Feedback: /",
      "**App:** app on localhost",
      "",
      '1. **button "Save"** (src/components/card.tsx:42:1): Too loud',
    ].join("\n")
  )
})

check("elements are named and located the way Agentation names them", () => {
  withFixture(
    `<div class="lt-page" data-testid="live-translate">
      <div class="lt-conversation lt-conversation-empty" data-testid="lt-empty-state">
        <div class="lt-empty-lockup">
          <div class="lt-empty-icon"></div>
          <p class="lt-empty-title">Translations will appear here</p>
        </div>
      </div>
    </div>`,
    (host) => {
      const title = editor.describeElement(host.querySelector(".lt-empty-title"))
      assert.equal(title.name, 'paragraph: "Translations will appear here"')
      assert.equal(
        title.path,
        '.lt-page[data-testid="live-translate"] > .lt-conversation[data-testid="lt-empty-state"] > .lt-empty-lockup > .lt-empty-title'
      )
      assert.equal(editor.describeElement(host.querySelector(".lt-empty-icon")).name, "empty icon")
    }
  )
  withFixture(
    `<nav class="Nav_bar__x1Y2z">
      <button aria-label="Close panel"></button>
      <button><svg class="lucide"></svg>Delete</button>
      <a href="/pricing">See pricing</a>
      <h2>Plans for every team</h2>
      <input placeholder="Search models">
      <span>New</span>
    </nav>`,
    (host) => {
      const name = (selector) => editor.describeElement(host.querySelector(selector)).name
      assert.equal(name("[aria-label]"), "button [Close panel]")
      assert.equal(name("svg"), 'icon in "Delete" button')
      assert.equal(name("a"), 'link "See pricing"')
      assert.equal(name("h2"), 'h2 "Plans for every team"')
      assert.equal(name("input"), 'input "Search models"')
      assert.equal(name("span"), '"New"')
      // A CSS-module hash is a build artifact, not a name.
      assert.match(editor.describeElement(host.querySelector("a")).path, /^.*\.Nav_bar > a$/)
    }
  )
})

check("a text note quotes its selection, in both forms Agentation does", () => {
  reset()
  editor.addAnnotation({
    kind: "text",
    comment: "Say what it replaced",
    url: window.location.href,
    rect: { x: 40, y: 120, width: 200, height: 18 },
    target: editor.describeElement(lede),
    selectedText: "Invoices and orders in one place and more besides",
    element: lede,
  })
  editor.updateSettings({ outputDetail: "standard" })
  const standard = editor.buildAnnotationBrief()
  assert.match(standard, /^### 1\. paragraph: "Invoices and orders in one place\."$/m)
  assert.match(
    standard,
    /^\*\*Selected text:\*\* "Invoices and orders in one place and more besides"\n\*\*Feedback:\*\* Say what it replaced$/m
  )
  editor.updateSettings({ outputDetail: "compact" })
  assert.match(
    editor.buildAnnotationBrief(),
    /: Say what it replaced \(re: "Invoices and orders in one pla\.\.\."\)$/m
  )
})

check("a dragged region is an Area selection at its page position", () => {
  reset()
  editor.updateSettings({ outputDetail: "standard" })
  editor.addAnnotation({
    kind: "region",
    comment: "Too much air here",
    url: window.location.href,
    rect: { x: 12.4, y: 300.6, width: 400, height: 120 },
    target: null,
    selectedText: null,
    element: null,
  })
  assert.match(
    editor.buildAnnotationBrief(),
    /^### 1\. Area selection\n\*\*Location:\*\* region at \(12, 301\)\n\*\*Feedback:\*\* Too much air here$/m
  )
})

check("edits read like notes, in the same numbered list, with a status line", () => {
  seedBrief()
  editor.updateSettings({ outputDetail: "standard" })
  const brief = editor.buildAnnotationBrief()
  assert.match(
    brief,
    /^### 2\. paragraph: "Invoices and orders in one place\."\n\*\*Location:\*\* #app > \.panel > #lede\n\*\*React:\*\* <Lede>\n\*\*Status:\*\* Already written to source — do not apply again\n\*\*Change:\*\* set `padding` to `24px` \(was `16px`\)$/m
  )
  assert.match(brief, /^### 3\. button "Save"\n[\s\S]*?\*\*Change:\*\* swap the icon to `Heart`/m)
})

check("forensic opens with Agentation's environment block and rule", () => {
  seedBrief()
  editor.updateSettings({ outputDetail: "forensic" })
  const brief = editor.buildAnnotationBrief()
  assert.match(
    brief,
    /^## Page Feedback: \/\n\*\*App:\*\* app on localhost\n\n\*\*Environment:\*\*\n- Viewport: \d+×\d+\n- URL: http:\/\/localhost\/\n- User Agent: .+\n- Timestamp: .+\n- Device Pixel Ratio: \d+(\.\d+)?\n\n---\n\nItems marked already written are in the source files\. [^\n]+\n\n### 1\. button "Save"\n\*\*Full DOM Path:\*\* body > main#app > section\.panel > div\.row > button\.btn\n/
  )
  assert.ok(!brief.includes("**Viewport:**"), "forensic printed the viewport twice")
})

check("a note stored before names were captured still gets a heading and location", () => {
  reset()
  editor.updateSettings({ outputDetail: "standard" })
  const legacy = editor.describeElement(saveButton)
  for (const key of ["name", "path", "fullPath", "nearbyText", "nearbyElements", "accessibility"]) {
    delete legacy[key]
  }
  note(saveButton, "Old note", { target: legacy })
  const brief = editor.buildAnnotationBrief()
  assert.match(brief, /^### 1\. button "Save"$/m)
  assert.match(brief, /^\*\*Location:\*\* .*button\.btn\.px-4:nth-of-type\(1\)$/m)
})

console.log("\nWhat leaves the machine")

check("sanitizeBrief shortens an absolute path to its src tail", () => {
  const cleaned = editor.sanitizeBrief("**Source:** /Users/someone/app/src/components/card.tsx:42")
  assert.equal(cleaned, "**Source:** src/components/card.tsx:42")
  // The failure it exists to prevent is a screen-share, not a broken path: a
  // brief on a projector carrying the user's home directory and their name.
  assert.ok(!cleaned.includes("/Users/"))
})

check("a relative path that merely contains src survives untouched", () => {
  const line = "**Source:** packages/ui/src/button.tsx:7"
  assert.equal(editor.sanitizeBrief(line), line, "a monorepo path was chopped at src/")
})

check("the brief's own **Source:** lines survive sanitizing", () => {
  // `**Source:**` is Agentation's field name, and the brief is in Agentation's
  // format. The change prompt's rule that deletes such lines would delete the
  // one fact the brief is surest of, so sanitizeBrief does not apply it.
  const brief = '### 1. button "Save"\n**Location:** .row > .btn\n**Source:** src/card.tsx:42\n**Feedback:** x'
  assert.equal(editor.sanitizeBrief(brief), brief)
})

check("the brief as built carries no home directory anywhere in it", () => {
  seedBrief()
  editor.updateSettings({ outputDetail: "forensic" })
  const brief = editor.buildAnnotationBrief()
  assert.ok(brief.includes("src/components/card.tsx:42"), "the source line never made it in")
  assert.ok(!brief.includes("/Users/"), "an absolute path reached the clipboard")
})

/* ==========================================================================
 * The canvas
 * ======================================================================== */

console.log("\nThe canvas")

const slots = {
  overlay: window.document.createElement("div"),
  toolbar: window.document.createElement("div"),
  left: window.document.createElement("div"),
  right: window.document.createElement("div"),
}
for (const slot of Object.values(slots)) {
  slot.setAttribute("data-designlayer", "")
  window.document.body.append(slot)
}
/**
 * Every toast the editor raised, newest last.
 *
 * The clear-all confirm is a glyph, so the words that say what it would cost
 * live in the toast and nowhere else. A case that only checked the button would
 * pass against a control that armed itself in total silence.
 */
const toasts = []
const context = editor.createContext(
  {
    elementInfo: () => null,
    send() {},
    // Three arguments now: an undo arrives as `action`, and a stub that drops
    // it would let a card ship with no way back and still pass.
    toast: (message, kind, action) => toasts.push([message, kind, action]),
    subscribe: () => () => {},
  },
  slots
)
editor.installAnnotations(context)
const layer = slots.overlay.querySelector(".de-ann-layer")

/** What the app hears. One entry per event that got past the editor. */
const heard = []
$("#app").addEventListener("click", () => heard.push("click"))

const fire = (target, type, init = {}) =>
  target.dispatchEvent(
    new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init })
  )

/** A press and a release over one point, which is the click-to-annotate gesture. */
function pin(target, x = 30, y = 30) {
  fire(target, "pointerdown", { clientX: x, clientY: y })
  fire(target, "pointerup", { clientX: x, clientY: y })
}

const composer = () => layer.querySelector(".de-ann-composer")
const write = (comment) => {
  const box = composer()
  assert.ok(box, "no composer opened, so there was nothing to type into")
  box.querySelector("textarea").value = comment
  const save = Array.from(box.querySelectorAll("button")).find((b) => b.textContent === "Save note")
  save.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
}

const enterAnnotating = (on) => {
  editor.setState({ annotating: on })
}

await checkAsync("with the mode off the layer paints nothing and takes no gesture", async () => {
  reset()
  enterAnnotating(false)
  heard.length = 0
  window.__stack = [saveButton]
  await settle()

  assert.equal(layer.children.length, 0, "the annotation layer drew chrome over an editor not in the mode")
  pin(saveButton)
  assert.equal(composer(), null, "a click outside the mode opened a composer")
  assert.deepEqual(editor.annotations(), [], "a click outside the mode pinned a note")

  saveButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
  // Not in the mode means the app keeps its own clicks, whatever
  // `blockPageInteractions` happens to say.
  assert.deepEqual(heard, ["click"], "the editor swallowed a click it had no business in")
})

await checkAsync("turning the mode on and clicking an element pins exactly one note", async () => {
  reset()
  enterAnnotating(true)
  window.__stack = [saveButton]
  await settle()

  pin(saveButton)
  write("The label wraps at 320px")
  const notes = editor.annotations()
  assert.equal(notes.length, 1, `one click produced ${notes.length} notes`)
  assert.equal(notes[0].kind, "element")
  assert.equal(notes[0].comment, "The label wraps at 320px")
  assert.equal(notes[0].target.tagName, "button")
  assert.equal(notes[0].element, saveButton, "the note cannot follow the element it is pinned to")
  assert.equal(composer(), null, "the composer stayed open after saving")
})

await checkAsync("a composer saved with nothing in it pins nothing", async () => {
  reset()
  enterAnnotating(true)
  window.__stack = [lede]
  await settle()

  pin(lede)
  // Changing your mind mid-gesture is cancelling. A pin with nothing to say is
  // one more marker an agent has to be told to ignore.
  write("   ")
  assert.deepEqual(editor.annotations(), [], "an empty note reached the page")
})

/**
 * The field is sized by the note, not by a drag.
 *
 * The composer is a popover: `place` measures it ONCE, on open, and clamps it
 * between the docked panels and the foot of the window. A textarea shipped with
 * the browser's resize grip let the designer drag that measurement out from
 * under itself — on a note taken low on the page, far enough to put Save under
 * the edge of the window with Escape the only way out. Both halves of the
 * replacement are asserted here, because either one alone is a regression: the
 * grip has to be gone AND the height has to follow the text, or a long note is
 * typed three lines at a time through a slot that no longer grows.
 */
await checkAsync("the note field grows with the note and has no grip to drag", async () => {
  reset()
  enterAnnotating(true)
  window.__stack = [lede]
  await settle()
  pin(lede)

  const rule = /\.de-ann-composer-text \{([^}]*)\}/.exec(editor.annotationsCss)?.[1] ?? ""
  assert.match(rule, /resize: none/, "the note field still carries a resize grip")
  assert.match(rule, /max-height: \d+px/, "the field grows without a ceiling, so it can outgrow the card")
  assert.match(rule, /overflow-y: auto/, "a note past the ceiling has no way to be scrolled")

  const box = composer()
  assert.ok(box, "no composer opened, so there was no field to grow")
  const field = box.querySelector("textarea")

  // jsdom lays nothing out, so the one number the grower reads has to be
  // supplied: `scrollHeight` is the height the text wants, and the borders it
  // leaves out are zero here.
  let content = 140
  for (const [name, get] of [
    ["scrollHeight", () => content],
    ["offsetHeight", () => 0],
    ["clientHeight", () => 0],
  ]) {
    Object.defineProperty(field, name, { configurable: true, get })
  }

  const type = (value) => {
    field.value = value
    field.dispatchEvent(new window.Event("input", { bubbles: true }))
  }

  type("a note long enough to wrap onto several lines")
  assert.equal(field.style.height, "140px", "the field did not grow to the note typed into it")

  // Down as well as up. A grower that only ever measures the box it is already
  // in reads its own height back and leaves the card tall after a delete.
  content = 56
  type("short")
  assert.equal(field.style.height, "56px", "the field stayed tall after the note was cut back")

  Array.from(box.querySelectorAll("button"))
    .find((b) => b.textContent === "Cancel")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
  assert.equal(composer(), null, "this case left a composer open for the next one")
})

await checkAsync("a pin carries the note's number and can be clicked through an inert layer", async () => {
  reset()
  enterAnnotating(true)
  window.__stack = [lede]
  await settle()
  pin(lede)
  write("Second")
  await settle()

  const marker = layer.querySelector(".de-ann-marker")
  assert.ok(marker, "the note was stored and never painted")
  assert.equal(marker.textContent, "1", "the pin does not say which note it is")
  assert.equal(marker.dataset.note, editor.annotations()[0].id)
  assert.equal(marker.getAttribute("aria-label"), "Note 1: Second")
  // The layer is inert so the app underneath stays usable, which means the pin
  // has to switch pointer events back on for itself or it cannot be clicked at
  // all. The inline style is the half jsdom can see; the stylesheet is the
  // other half, and they only work as a pair.
  assert.equal(marker.style.pointerEvents, "auto")
  assert.match(editor.annotationsCss, /\.de-ann-layer \{[^}]*pointer-events: none/)
  assert.match(editor.annotationsCss, /\.de-ann-marker \{[^}]*pointer-events: auto/s)
})

/*
 * A rehydrated note goes back onto its element, and it MUST.
 *
 * A reload drops every `element` — correctly; a DOM node cannot be serialized.
 * Until the marker re-resolved one, it fell through to the stored page rect for
 * the rest of the session, which is only the same thing while the PAGE is what
 * scrolls. Most apps scroll an inner container, so `window.scrollY` stays 0
 * forever, the rect never changes, and the pin freezes at the coordinate it was
 * dropped on while the content moves out from under it. Measured on the live
 * Angular host: after scrolling `main` by 400px the elements moved and both
 * markers stayed exactly where they were, one of them stranded off the top of
 * the viewport where it is hidden — which reads as a marker that has vanished.
 */
await checkAsync("a note rehydrated without its element finds it again by selector", async () => {
  reset()
  enterAnnotating(true)
  window.__stack = [lede]
  await settle()
  pin(lede)
  write("Anchored")
  await settle()

  const [note] = editor.annotations()
  assert.ok(note.target?.selector, "nothing was captured to re-find the element with")

  // Exactly what `load()` leaves behind after a reload: the record, no node.
  note.element = null
  // Move the element the way an inner scroll would, so a frozen pin and a
  // tracking one cannot land on the same number.
  lede.getBoundingClientRect = () => ({
    x: 40, y: 260, left: 40, top: 260, right: 240, bottom: 300, width: 200, height: 40,
  })
  await settle()

  const marker = layer.querySelector(".de-ann-marker")
  assert.ok(marker, "the rehydrated note painted no pin at all")
  assert.equal(
    marker.style.top,
    "260px",
    "the pin stayed on the stored rect instead of following its element"
  )
  assert.ok(note.element, "the element was never re-attached, so it will not track the next scroll")
})

/*
 * A note whose selector no longer matches used to re-run `querySelector` on
 * every frame of every scroll: the miss was written back as `element = null`,
 * which the next frame read as "not attached yet" and tried again.
 */
await checkAsync("an unresolvable note is retried at most every 500ms, or when the notes change", async () => {
  reset()
  enterAnnotating(false)
  const stray = note(null, "Gone", { target: { ...editor.describeElement(lede), selector: "#gone-for-good" } })
  stray.element = null
  const doc = window.document
  const original = doc.querySelector
  let tries = 0
  doc.querySelector = function query(selector) {
    if (selector === "#gone-for-good") tries += 1
    return original.call(this, selector)
  }
  try {
    for (let i = 0; i < 6; i += 1) {
      window.dispatchEvent(new window.Event("scroll"))
      await settle()
    }
    assert.ok(tries <= 1, `retried ${tries} times in six scroll frames`)
    const before = tries
    note(lede, "Another")
    await settle()
    assert.equal(tries, before + 1, "a change to the notes did not retry at once")
  } finally {
    doc.querySelector = original
  }
})

/*
 * The board covers the canvas between the panels, and the pins sit on the
 * chrome's layer above it. They used to watch only the mode, interactive and
 * hidden flags, so opening the board left them painted over it.
 */
await checkAsync("pins stand down for canvas view and come back when it closes", async () => {
  reset()
  enterAnnotating(false)
  note(lede, "Over the board")
  await settle()
  const marker = () => layer.querySelector(".de-ann-marker")
  assert.equal(marker()?.style.display, "block", "no pin to stand down")
  editor.setState({ canvasView: true })
  await settle()
  assert.equal(marker().style.display, "none", "the pin stayed painted over the board")
  editor.setState({ canvasView: false })
  await settle()
  assert.equal(marker().style.display, "block", "the pin did not come back after the board closed")
})

await checkAsync("re-attaching never binds a note to the editor's own chrome", async () => {
  reset()
  enterAnnotating(true)
  window.__stack = [lede]
  await settle()
  pin(lede)
  write("Chrome check")
  await settle()

  const [note] = editor.annotations()
  note.element = null
  // A selector that now matches a panel rather than the page. A marker that
  // anchored itself to the editor would follow the panel around and annotate
  // the annotator.
  note.target.selector = "[data-designlayer]"
  await settle()
  assert.equal(note.element, null, "the marker re-attached itself to the editor")
})

await checkAsync("with blocking on, the annotating click never reaches the app", async () => {
  reset()
  enterAnnotating(true)
  editor.updateSettings({ blockPageInteractions: true })
  heard.length = 0
  window.__stack = [saveButton]
  await settle()

  saveButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
  // Annotating a menu item is impossible if the click that annotates it also
  // closes the menu, which is why this is the default.
  assert.deepEqual(heard, [], "the app handled the click the designer was annotating with")
})

await checkAsync("with blocking off, the click lands so the app can be driven", async () => {
  reset()
  enterAnnotating(true)
  editor.updateSettings({ blockPageInteractions: false })
  heard.length = 0
  window.__stack = [saveButton]
  await settle()

  saveButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
  // The other case: driving the app INTO the state worth annotating.
  assert.deepEqual(heard, ["click"], "turning blocking off left the click swallowed anyway")
  editor.updateSettings({ blockPageInteractions: true })
})

await checkAsync("the editor never annotates its own chrome", async () => {
  reset()
  enterAnnotating(true)
  window.__stack = [lede]
  await settle()
  pin(lede)
  write("A note with a pin of its own")
  await settle()

  const marker = layer.querySelector(".de-ann-marker")
  assert.ok(marker, "there is no pin to try to annotate")

  // Pressing on the pin itself. A marker you can annotate is an infinite
  // regress with a marker at the bottom of it.
  pin(marker)
  assert.equal(composer(), null, "a pin opened a composer about itself")
  assert.equal(editor.annotations().length, 1, "annotating a pin pinned a note")

  // And through it: the hit stack is chrome first, which is the normal case
  // once the page has pins on it. The note has to land on the app underneath.
  window.__stack = [marker, layer, saveButton]
  pin(saveButton)
  write("Through the pin")
  const latest = editor.annotations().at(-1)
  assert.equal(latest.comment, "Through the pin")
  assert.equal(latest.target.tagName, "button", "the note was pinned to the editor's own overlay")
})

/*
 * COLLAPSING THE EDITOR TAKES THE MODE'S MARKS WITH IT.
 *
 * Reported from the running tool: leave the Notes mode armed, collapse the
 * editor to its disc, and the hover outline stays painted around whatever the
 * pointer was last over. Nothing on screen explains it — the panels, the bar and
 * the pins have all gone — and no gesture can clear it, because every handler in
 * the lane is gated on `editorOwnsInput()` and is now inert. The frame sits on
 * the app until the editor is opened again.
 *
 * The cause was that the surfaces were tied to the `annotating` flip alone,
 * which the collapse does not touch. `annotating` is the designer's switch and
 * SHOULD survive a collapse; what must not survive is any claim that the next
 * click will annotate something, and the outline and a half-typed composer are
 * both exactly that claim.
 *
 * Both directions are asserted, because a stand-down that never came back would
 * be the worse bug: the mode would still be lit in the toolbar with nothing on
 * the canvas answering to it.
 */
await checkAsync("collapsing the editor clears the mode's outline, and opening it restores it", async () => {
  reset()
  enterAnnotating(true)
  editor.setState({ chromeHidden: false })
  window.__stack = [saveButton]
  await settle()

  // Hover an element, so there is an outline with somewhere to be.
  fire(saveButton, "pointermove", { clientX: 30, clientY: 30 })
  await settle()
  const outline = () => layer.querySelector(".de-ann-target")
  assert.ok(outline(), "the mode drew no hover outline, so this case proves nothing")
  assert.equal(
    outline().style.display,
    "block",
    "the outline never painted around the hovered element"
  )
  // The mode draws no instruction pill over the page; the outline is its only surface.
  assert.equal(layer.querySelector(".de-ann-hint"), null, "annotation mode drew a hint bar over the page")

  editor.setState({ chromeHidden: true })
  await settle()
  assert.equal(outline(), null, "the hover outline stayed on the canvas after the editor collapsed")
  assert.equal(layer.querySelector(".de-ann-region"), null, "the drag rectangle outlived the editor")
  // The switch itself is the designer's, and is not touched.
  assert.equal(editor.getState().annotating, true, "collapsing turned the mode off behind the designer")

  // A pointer moving over the page while the editor is down must not bring it
  // back — the lane is inert, and a frame drawn by a hidden editor is the bug.
  fire(lede, "pointermove", { clientX: 40, clientY: 40 })
  await settle()
  assert.equal(outline(), null, "a hover repainted the outline while the editor was collapsed")

  editor.setState({ chromeHidden: false })
  await settle()
  assert.ok(outline(), "opening the editor left the armed mode with no surfaces at all")
  assert.equal(layer.querySelector(".de-ann-hint"), null, "opening the editor drew a hint bar over the page")
  // Nothing is outlined until the pointer says so again: the element hovered
  // before the collapse is a stale subject by the time the editor is back.
  assert.equal(outline().style.display, "none", "the outline came back around a stale element")

  // One outline, not two. `enter()` appends, so a second entrance without a
  // matching stand-down would stack duplicates on the same layer.
  assert.equal(layer.querySelectorAll(".de-ann-target").length, 1, "the editor came back with two outlines")
})

/*
 * A composer open when the editor collapses is closed, not left over the page.
 *
 * It is the one surface in this lane that takes the pointer (`pointer-events:
 * auto`), so a card outliving the editor is a dialog floating over an app with
 * no editor on screen, still able to write a note into a session the designer
 * believes they have left.
 */
await checkAsync("collapsing the editor closes a composer that was open", async () => {
  reset()
  enterAnnotating(true)
  editor.setState({ chromeHidden: false })
  window.__stack = [saveButton]
  await settle()

  pin(saveButton)
  assert.ok(composer(), "no composer opened, so there was nothing to close")

  editor.setState({ chromeHidden: true })
  await settle()
  assert.equal(composer(), null, "a half-typed note was left floating over the collapsed editor")
  assert.deepEqual(editor.annotations(), [], "collapsing saved the note instead of dropping it")

  editor.setState({ chromeHidden: false })
})

enterAnnotating(false)

/* ==========================================================================
 * The tab
 * ======================================================================== */

/**
 * The outbox as a panel, driven through its own buttons.
 *
 * Three actions live here that nothing else in this suite can see, and all
 * three fail quietly. A visibility toggle that writes somewhere other than the
 * store leaves a settings row swearing the markers are up over a page with
 * none on it. A row delete that addresses by index instead of id takes a
 * neighbour and looks, from the panel, exactly like it worked. And clear-all
 * is irreversible — there is no undo for annotations anywhere in this feature —
 * so the two clicks, the stand-down and the disabled state are not polish, they
 * are the only thing between a stray press and a session's work.
 *
 * The tab is built from the same context the canvas cases use, so it is wired
 * to the real stores rather than to a list the case posts rows into.
 */
console.log("\nThe Notes tab, as a panel you press")

const tab = editor.annotationsTab(context)
const pane = tab.node

const tools = () => Array.from(pane.querySelectorAll(".de-ann-tools button"))
const eyeButton = () => tools()[0]
const clearButton = () => tools()[1]
const settingsSwitch = () => pane.querySelector('.de-ann-toggle[aria-label="Show pins"]')
const noteRows = () => Array.from(pane.querySelectorAll(".de-ann-item--note"))
const editRows = () => Array.from(pane.querySelectorAll(".de-ann-item--edit"))
/**
 * The tab's sections, and NOT everything in its column.
 *
 * This read `pane.children` while the tab was two sections and nothing else.
 * It is now a column of blocks that come and go with the session — an empty
 * state, an edits section, a notes section, the whole-session buttons — so a
 * positional read of the children says something different depending on what
 * the designer has done. `.de-section` is the thing these cases mean.
 */
const sections = () => Array.from(pane.querySelectorAll(".de-section"))
const detailMenu = () => pane.querySelector(".de-ann-detail select")
const rowActions = (row) => Array.from(row.querySelectorAll(".de-ann-item-actions button"))
const deleteButton = (row) => row.querySelector(".de-ann-item-actions .de-mini--danger")
const press = (node) =>
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))

/**
 * Every detail the panel put on `window` while `fn` ran.
 *
 * The seam between this panel and the marker layer is an event and nothing
 * else — no import, no shared module — so the only way to test the panel's half
 * is to stand where the canvas stands and listen. A case that reached into the
 * canvas instead would pass on a build where the panel dispatched nothing.
 */
function heardOn(type, fn) {
  const details = []
  const listener = (event) => details.push(event.detail)
  window.addEventListener(type, listener)
  try {
    fn()
  } finally {
    window.removeEventListener(type, listener)
  }
  return details
}

const hover = (row, type) => row.dispatchEvent(new window.MouseEvent(type, { bubbles: false }))

/** Both stores empty and the panel painted from them, which `update` is for. */
function seedTab() {
  reset()
  toasts.length = 0
  tab.update()
}

check("an empty session is the empty state and Settings — no headings, no buttons", () => {
  seedTab()
  /*
   * NOTHING TO HEAD, SO NOTHING HEADS IT — AND NOTHING TO DO, SO NOTHING
   * OFFERS TO DO IT.
   *
   * The outbox is two sections, Direct edits and Notes, and each one is built
   * once and taken out of the document while it holds nothing. The
   * whole-session buttons go the same way, and that is the later half of this
   * case: they used to sit in the column unconditionally, which put four
   * controls under "Nothing to hand over yet" — Send and Copy disabled, an eye
   * toggling the visibility of no markers, a bin armed to clear an empty list.
   * A row of controls over an empty state is the panel offering its ending
   * before anything has begun.
   *
   * What is left is the sentence saying what the tab is for, MCP, and Settings.
   */
  assert.deepEqual(
    Array.from(pane.children).map((node) => node.className),
    ["de-empty de-ann-empty", "de-section", "de-section"]
  )
  assert.ok(sections()[0].querySelector(".de-mcp"), "the first section left is not MCP")
  assert.ok(sections()[1].querySelector(".de-ann-settings"), "the last section left is not Settings")
  // The old shapes, stated as negatives so neither can quietly come back.
  assert.equal(pane.querySelector(".de-ann-footer"), null, "the footer survived the restructure")
  assert.equal(pane.querySelector(".de-ann-group"), null, "the groups came back inside a section")
})

check("the whole-session buttons arrive with the first thing the session holds", () => {
  seedTab()
  assert.equal(pane.querySelector(".de-ann-ctas"), null, "the buttons sat over an empty session")

  note(saveButton, "Something to hand over")
  assert.ok(pane.querySelector(".de-ann-ctas"), "a note did not bring the buttons back")
  // Under the list and above MCP and Settings, which is the position that makes
  // their scope readable: they act on everything written above them.
  assert.deepEqual(
    Array.from(pane.children).map((node) => node.className),
    ["de-section", "de-ann-ctas", "de-section", "de-section"]
  )

  seedTab()
  assert.equal(pane.querySelector(".de-ann-ctas"), null, "the buttons outlived the session")
})

check("a note brings the Notes and edits section with it, holding the rows and nothing else", () => {
  seedTab()
  note(saveButton, "Something to pin")

  /*
   * The empty state goes, and the one section arrives in its place. Notes and
   * edits share it: there is no separate edits heading to stay away.
   */
  assert.deepEqual(
    Array.from(pane.children).map((node) => node.className),
    ["de-section", "de-ann-ctas", "de-section", "de-section"]
  )
  const notes = sections()[0]
  assert.equal(notes.querySelector(".de-section-title").textContent.trim(), "Notes and edits")
  /*
   * A header and the fold layer under it. The body is one level down now: the
   * section animates open and shut on a grid row, and the row has to belong to
   * a box with no padding of its own or a shut section leaves its padding
   * behind. See `.de-section-fold` in `css/panels.ts`.
   */
  assert.deepEqual(
    Array.from(notes.children).map((node) => node.className),
    ["de-section-header de-section-header--collapsible", "de-section-fold"]
  )
  assert.deepEqual(
    Array.from(notes.querySelector(".de-section-fold").children).map((node) => node.className),
    ["de-section-body"]
  )
  /*
   * Inside the body: the rows and nothing else. The sentence saying how the
   * list is sent is the title's hover, and the detail menu is in Settings.
   */
  assert.deepEqual(
    Array.from(notes.querySelector(".de-section-body").children).map((node) => node.className),
    ["de-ann-list"]
  )
  const title = notes.querySelector(".de-section-title")
  assert.equal(title.getAttribute("data-de-tip"), "Sent to your agent as one brief, in this order.")
  assert.equal(
    notes.querySelector(".de-section-toggle").getAttribute("aria-description"),
    title.getAttribute("data-de-tip"),
    "the brief sentence is silent to a screen reader"
  )
  assert.equal(notes.querySelector(".de-ann-brief"), null, "the brief sentence is back in the body")
  assert.equal(notes.querySelector(".de-ann-detail"), null, "the detail menu is back above the list")
  assert.equal(notes.querySelectorAll(".de-ann-item--note").length, 1)
  // Stated as negatives so no old shape can quietly come back.
  assert.equal(notes.querySelector(".de-ann-box"), null, "the notes container is back")
  assert.equal(notes.querySelector(".de-ann-formats"), null, "the format strip is back")
  assert.equal(notes.querySelector(".de-ann-count"), null, "the heading is counting again")
  assert.equal(notes.querySelector(".de-ann-group-count"), null, "the group tally is back")
})

check("one outbox heading, and Settings is said once", () => {
  seedTab()
  note(saveButton, "Something to pin")
  const titles = Array.from(pane.querySelectorAll(".de-section-title"))
  /*
   * Read RAW. Notes and edits are one list under one heading, with one
   * numbering and one set of buttons; "Direct edits" and "Notes" as separate
   * sections are gone.
   */
  assert.deepEqual(
    titles.map((node) => node.textContent.trim()),
    ["Notes and edits", "MCP", "Settings"]
  )
  assert.equal(titles[2].tagName, "SPAN", "the settings title is a control again")
  // Settings folds like the outbox: a toggle and a chevron, open on arrival.
  const settingsHeader = sections()[2].querySelector(".de-section-header")
  const toggle = settingsHeader.querySelector(".de-section-toggle")
  assert.ok(toggle, "settings has no fold")
  assert.ok(settingsHeader.querySelector(".de-chevron"), "settings has no chevron")
  assert.equal(toggle.getAttribute("aria-expanded"), "true", "settings arrived folded")
})

check("settings starts open, folds, and survives a repaint", () => {
  seedTab()
  const settingsSection = sections().at(-1)
  const body = settingsSection.querySelector(".de-section-body")
  const inner = pane.querySelector(".de-ann-settings-body")
  assert.equal(body.hidden, false, "settings arrived folded")

  const header = settingsSection.querySelector(".de-section-header")
  header.querySelector(".de-section-toggle").click()
  assert.equal(body.hidden, true, "the settings header did not fold it")
  header.querySelector(".de-section-toggle").click()
  assert.equal(body.hidden, false, "the settings header did not unfold it")

  // Dropping a marker repaints the list, and a settings block rebuilt with it
  // would take the focus of whoever had just used a control in it.
  note(saveButton, "Something to repaint for")
  assert.equal(body.hidden, false)
  assert.equal(
    pane.querySelector(".de-ann-settings-body"),
    inner,
    "the settings block was rebuilt, so every control in it was replaced"
  )
})

check("the visibility toggle sits with the CTAs, not behind the settings fold", () => {
  seedTab()
  // A note first: the buttons leave the column over an empty session, and the
  // eye leaves with them. There is nothing to show or hide until there is one.
  note(saveButton, "Something to pin")
  const eye = eyeButton()
  assert.ok(eye, "the tab has no visibility toggle at all")
  // It is reached for several times a session; settings is somewhere you go
  // once. A control folded away is a control nobody uses twice.
  assert.ok(eye.closest(".de-ann-ctas"), "the toggle is not with the actions under the list")
  assert.equal(eye.closest(".de-ann-settings"), null, "the toggle was filed under settings")
})

check("the footer toggle and the settings row are one flag, read both ways", () => {
  seedTab()
  note(saveButton, "Something to pin")
  const eye = eyeButton()

  assert.equal(editor.markersVisible(), true)
  assert.equal(eye.dataset.glyph, "Eye")
  assert.equal(eye.getAttribute("aria-label"), "Hide pins")
  // The switch is labelled "Show pins" and reads forward: checked means the
  // markers are on the page, which is the state the eye beside it also reports.
  assert.equal(settingsSwitch().getAttribute("aria-checked"), "true")

  press(eye)
  // The store first: a toggle that only repainted itself would look perfect and
  // leave every marker on the page.
  assert.equal(editor.markersVisible(), false, "the footer toggle never reached the store")
  assert.equal(editor.annotationSettings().hideUntilRestart, true)
  assert.equal(eye.dataset.glyph, "EyeOff", "the eye is not struck through while hidden")
  assert.equal(eye.getAttribute("aria-label"), "Show pins")
  assert.equal(
    settingsSwitch().getAttribute("aria-checked"),
    "false",
    "the settings row disagreed with the footer about one flag"
  )

  // And back, from the other surface. Two controls onto one flag are only safe
  // if the traffic runs both ways through the store.
  press(settingsSwitch())
  assert.equal(editor.markersVisible(), true)
  assert.equal(eye.dataset.glyph, "Eye")
  assert.equal(eye.getAttribute("aria-label"), "Hide pins")
})

check("hidden is a fact about the markers, so the eye is two drawings", () => {
  seedTab()
  // The eye only exists once the session holds something — see the CTA case
  // above.
  note(saveButton, "Something to pin")
  const eye = eyeButton()
  // No `aria-pressed`: the label already moves with the state, and a moving
  // label over a pressed state announces "Show pins, pressed", which says
  // the opposite of what is true. The state is carried by the drawing.
  assert.equal(eye.getAttribute("aria-pressed"), null, "the eye reports itself as a pressed button")
  press(eye)
  assert.equal(eye.getAttribute("aria-pressed"), null)
  assert.notEqual(eye.dataset.glyph, "Eye", "one drawing was reused for both states")
  press(eye)
  // Icon-only, so the name is the whole of what a screen reader gets.
  assert.ok(eye.getAttribute("aria-label"), "an icon-only toggle with no name")
})

console.log("\nDeleting one note")

check("a note deletes without touching its neighbours", () => {
  seedTab()
  note(saveButton, "First")
  tick()
  note(lede, "Second")
  tick()
  note(saveButton, "Third")
  tick()
  editor.recordEdit({ property: "padding", from: "16px", to: "24px", element: lede, written: true })

  const deletes = noteRows().map((row) => row.querySelector(".de-mini--danger"))
  assert.equal(deletes.length, 3)
  press(deletes[1])

  // Addressed by id, not by position in a merged list that also holds edits.
  assert.deepEqual(
    editor.annotations().map((entry) => entry.comment),
    ["First", "Third"],
    "deleting the middle note took a neighbour with it"
  )
  assert.equal(editor.editCount(), 1, "deleting a note dropped an edit")
  assert.equal(noteRows().length, 2, "the panel did not repaint after the delete")
})

check("a note row offers exactly edit and delete, and says what delete costs", () => {
  seedTab()
  note(saveButton, "Still wrong")
  /*
   * TWO ACTIONS, NOT THREE — the resolve tick is gone.
   *
   * It was a toggle beside the bin, defended on the grounds that resolving
   * keeps the record and deleting ends it. True of the data, and not true of
   * the panel: both take a dealt-with note off the list, they sat 2px apart
   * under near-identical 18px buttons, and nothing in the tab could show a
   * resolved note afterwards. One of the two was a coin toss.
   *
   * Addressed by what each control IS rather than by where it sits, so a case
   * cannot start asserting the delete copy against the edit button the day
   * somebody reorders them.
   */
  const actions = rowActions(noteRows()[0])
  const remove = deleteButton(noteRows()[0])
  assert.equal(actions.length, 2, "the row grew a third action back")
  assert.deepEqual(
    actions.map((node) => node.getAttribute("aria-pressed")),
    [null, null],
    "a row action announces itself as a toggle, and neither of these is one"
  )

  /*
   * The name carries the consequence, and the consequence changed.
   *
   * The delete is a step on the one undo timeline, and the sentence promises
   * the recovery — asserted rather than allowed, because a reader who believes
   * a reversible action is final does not press it.
   */
  assert.match(remove.getAttribute("aria-label"), /^Delete note/)
  assert.match(remove.getAttribute("aria-label"), /undo brings it back/i)
  assert.doesNotMatch(remove.getAttribute("aria-label"), /no undo/i)
  /*
   * `data-de-tip`, and deliberately NO `title`.
   *
   * The styled tip fires instantly; a `title` alongside it would paint the
   * operating system's own over the top about a second later, which is the
   * residual the help dot still carries and documents.
   */
  assert.equal(remove.getAttribute("data-de-tip"), remove.getAttribute("aria-label"))
  assert.equal(remove.getAttribute("title"), null, "the OS tooltip is back over the styled one")

  press(remove)
  assert.deepEqual(editor.annotations(), [], "the row's delete did not delete")
})

console.log("\nDeleting all of them")

check("clear-all is disabled with nothing to clear, edits included", () => {
  seedTab()
  // Over an empty session the whole button row is out of the column, so there
  // is no disabled bin to check — the absence IS the stronger version of the
  // assertion this case used to make.
  assert.equal(clearButton(), undefined, "an empty session drew the button row anyway")

  editor.recordEdit({ property: "gap", from: "8px", to: "16px", element: lede, written: false })
  // It clears notes only, so a list of edits is still nothing it can take.
  // Offering it would be the panel promising something the click does not do.
  assert.equal(clearButton().disabled, true, "clear-all armed itself over a list of edits")
  assert.equal(clearButton().getAttribute("aria-label"), "Delete all notes")

  note(saveButton, "Now there is one")
  assert.equal(clearButton().disabled, false)
  assert.match(clearButton().getAttribute("aria-label"), /Delete all 1 note\b/)
})

check("clear-all needs two clicks, and says what the second one costs", () => {
  seedTab()
  note(saveButton, "One")
  note(lede, "Two")
  editor.recordEdit({ property: "gap", from: "8px", to: "16px", element: lede, written: false })
  const clear = clearButton()
  assert.equal(clear.dataset.glyph, "Trash")
  // Icon-only and destructive, so it owes both a name and a tip.
  assert.ok(clear.getAttribute("aria-label"))
  assert.equal(clear.getAttribute("title"), clear.getAttribute("aria-label"))

  press(clear)
  assert.equal(editor.annotations().length, 2, "one click emptied the list")
  assert.equal(clear.dataset.glyph, "Check", "the armed control looks exactly like the safe one")
  assert.ok(clear.classList.contains("de-ann-clear--armed"))
  // The armed name states the OUTCOME of the next press, and still says that a
  // second press is what does it — a glyph that has quietly become a tick owes
  // both halves to anyone reading it by name.
  assert.match(clear.getAttribute("aria-label"), /^Click again to delete all 2 notes$/)
  // The words are in the toast because the control is a glyph, and they have to
  // count: "delete everything?" over two notes and over forty is not the same
  // question.
  const [message, kind] = toasts.at(-1)
  assert.match(message, /2 notes/)
  // Clear-all is one undoable step now, so the prompt must not call it final.
  assert.doesNotMatch(message, /cannot be undone/i)
  // The DEFAULT rung, not `error`. `DURATION.error` is `Infinity`, and a card
  // that never dismisses outlives the six-second arming window it is
  // instructing — it would go on saying "click again" after `disarm()` has
  // turned the tick back into a bin, where clicking again re-arms instead.
  assert.equal(kind, "info")

  press(clear)
  assert.deepEqual(editor.annotations(), [], "the second click did not clear the list")
  assert.equal(clear.dataset.glyph, "Trash", "the control stayed armed over an empty list")
  assert.equal(clear.disabled, true)
  assert.match(toasts.at(-1)[0], /Deleted 2 notes/)
  // And the card offers them back, as the one timeline's step.
  const undo = toasts.at(-1)[2]
  assert.equal(undo?.label, "Undo", "clearing the notes offered no Undo")
  undo.onClick()
  assert.deepEqual(
    editor.annotations().map((entry) => entry.comment),
    ["One", "Two"],
    "the toast's Undo did not bring the notes back in order"
  )
})

check("clearing the notes leaves the edits standing", () => {
  seedTab()
  note(saveButton, "A note")
  tick()
  editor.recordEdit({ property: "padding", from: "16px", to: "24px", element: lede, written: true })
  editor.recordEdit({ property: "icon", from: "Star", to: "Heart", element: saveButton, written: false })

  press(clearButton())
  press(clearButton())

  // An edit dropped from the outbox is not undone — the change is still live on
  // the page, and in the file if it was written. Taking the edits out with the
  // notes would leave a set of changes nobody is ever going to tell an agent
  // about, which is a quieter failure than losing the notes and a worse one.
  assert.deepEqual(editor.annotations(), [])
  assert.equal(editor.editCount(), 2, "clear-all took the edits with the notes")
  assert.equal(editRows().length, 2, "the edits left the panel even though the journal kept them")
  assert.equal(noteRows().length, 0)
})

check("an armed clear-all stands itself down, and the next click only re-arms", () => {
  seedTab()
  note(saveButton, "One")
  note(lede, "Two")
  const clear = clearButton()

  /*
   * The timer the control set for itself, held rather than waited on.
   *
   * Six seconds is the window, and a case that slept through it would be six
   * seconds of a suite that runs in one. Only `window.setTimeout` is swapped —
   * the marker layer's frames come from `globalThis`, which jsdom keeps
   * separate — so nothing else in this file loses its clock.
   */
  const realSetTimeout = window.setTimeout
  const realClearTimeout = window.clearTimeout
  let standDown = null
  let window_ms = null
  window.setTimeout = (fn, ms) => {
    standDown = fn
    window_ms = ms
    return 99
  }
  window.clearTimeout = () => {}
  try {
    press(clear)
    assert.equal(clear.dataset.glyph, "Check")
    assert.equal(window_ms, 6000, "the arm does not expire on the window the toolbar uses")
    standDown()
  } finally {
    window.setTimeout = realSetTimeout
    window.clearTimeout = realClearTimeout
  }

  assert.equal(clear.dataset.glyph, "Trash", "the control stayed armed after its window closed")
  assert.ok(!clear.classList.contains("de-ann-clear--armed"))
  assert.match(clear.getAttribute("aria-label"), /^Delete all 2 notes/)

  // The whole point of the stand-down: a click that lands long after the first
  // one asks again rather than emptying the list without a word.
  press(clear)
  assert.equal(editor.annotations().length, 2, "a click after the timeout deleted the list")
  assert.equal(clear.dataset.glyph, "Check")
})

check("deleting the last note by its own row disarms the clear-all above it", () => {
  seedTab()
  note(saveButton, "The only one")
  const clear = clearButton()
  press(clear)
  assert.equal(clear.dataset.glyph, "Check")

  press(noteRows()[0].querySelector(".de-mini--danger"))
  // An armed bin over an empty list is a control waiting to delete nothing, and
  // it would still be sitting there armed when the next note is pinned.
  assert.equal(clear.disabled, true)
  assert.equal(clear.dataset.glyph, "Trash", "the arm outlived the notes it was counting")
})

check("the stylesheet gives the two list actions a group of their own", () => {
  // The row under the box holds four controls at 260px. The pair that acts on
  // the list in place has to stay a pair, and nothing in it may wrap — a
  // wrapped label is how that row turns into one control per line.
  assert.match(editor.annotationsCss, /\.de-ann-tools \{[^}]*display: inline-flex/)
  assert.match(editor.annotationsCss, /\.de-ann-actions button \{[^}]*white-space: nowrap/)
  assert.match(editor.annotationsCss, /\.de-ann-clear--armed[^{]*\{[^}]*background:/)
  // And the row itself exists, rather than the two groups floating loose under
  // the box with nothing holding them on one line.
  assert.match(editor.annotationsCss, /\.de-ann-ctas \{[^}]*display: flex/)
  // One line: hide, bin, Send and Copy never fold into two rows.
  assert.match(editor.annotationsCss, /\.de-ann-ctas \{[^}]*flex-wrap: nowrap/)
})

check("the copy mark crossfades in a box the row never learns about", () => {
  /*
   * THE BOX IS THE POINT, not the transition.
   *
   * Two glyphs stacked absolutely inside a sized container is what keeps the
   * label still: without the explicit width and height the container collapses
   * on two absolute children, and without `position: absolute` the two marks
   * lay out side by side and the button is 12px wider than it should be, for
   * good. Either failure is visible only when the tick is up.
   */
  const box = /\.de-swap \{([^}]*)\}/.exec(editor.annotationsCss)
  assert.ok(box, "the swap has no box")
  assert.match(box[1], /position: relative/)
  assert.match(box[1], /width: 12px; height: 12px/)
  assert.match(
    editor.annotationsCss,
    /\[data-designlayer\] \.de-swap > svg\[data-de-glyph\] \{[^}]*position: absolute/
  )
  // Both properties transition, or the scale lands in one frame and the fade
  // it was supposed to ride arrives underneath it.
  assert.match(
    editor.annotationsCss,
    /\[data-designlayer\] \.de-swap > svg\[data-de-glyph\] \{[^}]*transition: opacity [^;]*transform/
  )
  /*
   * AND THE SELECTOR IS PART OF THE ASSERTION, not incidental to it.
   *
   * `css/icons.ts` declares `transition: stroke-width` on
   * `[data-designlayer] svg[data-de-glyph]` — (0,2,1). While this rule was a
   * plain `.de-swap > svg` at (0,1,1) it lost, and because `transition` is a
   * shorthand it did not lose one property, it lost the whole list: the
   * crossfade above was in the stylesheet and never once ran. Pinning the
   * winning form here is what stops it being simplified back.
   */
  assert.ok(
    !/(^|\n)\.de-swap > svg \{/.test(editor.annotationsCss),
    "the swap rule went back to a specificity the icon stroke rule beats"
  )
  assert.match(editor.iconsCss, /\[data-designlayer\] svg\[data-de-glyph\] \{[^}]*stroke-width/)
  // The tick is the only thing in this chrome that is green, and that is the
  // channel saying the press LANDED rather than merely registered.
  assert.match(
    editor.annotationsCss,
    /\.de-swap > \.de-swap-done \{[^}]*color: var\(--de-color-success/
  )
  assert.match(editor.annotationsCss, /\.de-swap--done > \.de-swap-rest \{[^}]*scale\(0\.8\)/)
  assert.match(editor.annotationsCss, /\.de-swap--done > \.de-swap-done \{[^}]*scale\(1\)/)
  /*
   * Reduced motion keeps the crossfade and drops the squeeze — the bargain the
   * rest of this file strikes. Cutting the fade too would leave a green tick
   * that was simply always there, which is a repaint rather than a change.
   */
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(
    editor.annotationsCss
  )
  assert.ok(reduced, "the reduced-motion block is gone")
  assert.match(
    reduced[1],
    /\[data-designlayer\] \.de-swap > svg\[data-de-glyph\] \{\s*transition: opacity [^}]*linear !important/
  )
  assert.match(reduced[1], /\.de-swap--done > \.de-swap-rest \{ transform: none/)
})

check("the tab scrolls as one column instead of pinning settings to the floor", () => {
  /*
   * The structural half of this is above, in the DOM. This is the other half,
   * and neither works alone: two sections in document order still read as a
   * drawer if the second one is pushed to the bottom edge by `margin-top:
   * auto`, and the dead gap the restructure removed comes straight back.
   *
   * ONE scroller, and it is not this one — the pane already has `overflow-y`
   * from `inspector.ts`. A box inside it that scrolls too is two scrollbars
   * four pixels apart, and a note scrolled out of the inner one that the wheel
   * cannot reach because the pointer is over the wrong box.
   */
  const tab = /\.de-ann \{([^}]*)\}/.exec(editor.annotationsCss)
  assert.ok(tab, "the tab has no rule at all")
  assert.ok(!/overflow-y:/.test(tab[1]), "the tab grew a second scrollbar inside the pane's")
  const list = /\.de-ann-list \{([^}]*)\}/.exec(editor.annotationsCss)
  assert.ok(list, "the list has no rule at all")
  assert.ok(!/overflow-y:\s*auto/.test(list[1]), "the rows still scroll inside their own box")

  const settings = /\.de-ann-settings \{([^}]*)\}/.exec(editor.annotationsCss)
  assert.ok(settings, "the settings block has no rule at all")
  assert.ok(
    !/margin-top:\s*auto/.test(settings[1]),
    "settings is still pinned to the bottom edge of the panel"
  )
})

console.log("\nThe pin's treatment")

/*
 * The pin is Agentation's pin, and these are the parts of it easiest to undo by
 * accident.
 *
 * It is a borrowed treatment, so "it still looks right" is not something a
 * future reader can check against anything in this repo — the reference lives in
 * another product. Pinning the decisions that MAKE it that treatment is the only
 * way the resemblance survives someone tidying this file.
 */
check("the pin and its row disc wear the indigo accent under a white numeral", () => {
  for (const selector of [".de-ann-marker", ".de-ann-index"]) {
    const rule = new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(editor.annotationsCss)
    assert.ok(rule, `${selector} has no rule at all`)
    assert.match(rule[1], /background:\s*var\(--de-color-accent-surface,/, `${selector} is off the accent fill`)
    assert.match(rule[1], /color:\s*var\(--de-color-on-accent,/, `${selector}'s numeral is off the accent ink`)
  }
  // The retired user colour must not come back by the side door.
  assert.doesNotMatch(editor.annotationsCss, /--de-ann-color/, "a rule still paints the retired marker colour")
})

check("the pin's edge is an inset shadow, not a border", () => {
  const marker = /\.de-ann-marker \{([^}]*)\}/.exec(editor.annotationsCss)
  assert.match(marker[1], /border:\s*none/, "the pin grew a real border")
  // A 22px disc with a 1px border is 24 across and lays a hard line between the
  // fill and the page; the inset hairline darkens the fill's own rim instead.
  assert.match(
    marker[1],
    /box-shadow:[^;]*inset 0 0 0 1px/,
    "the pin lost the inset hairline that draws its edge"
  )
  assert.match(marker[1], /box-shadow:\s*0 2px 6px/, "the pin's cast is no longer the tight one")
})

check("every marker state keeps the pin's shadow, so a hover does not change it", () => {
  const states = [...editor.annotationsCss.matchAll(/(\.de-ann-marker[^{]*)\{([^}]*)\}/g)].filter(
    (rule) => /box-shadow:/.test(rule[2])
  )
  assert.ok(states.length >= 3, "expected the pin and its states to declare shadows")
  for (const [, selector, body] of states) {
    // `popover` is the chrome's own `0 6px 22px` cast. A state that reaches for
    // it makes the pin jump from a tight shadow to a wide one on hover or focus,
    // which reads as the pin lifting off the page rather than as a state change.
    assert.ok(
      !/0 6px 22px/.test(body),
      `${selector.trim()} uses the popover cast instead of the pin's own`
    )
  }
})

check("a stored marker colour from the old swatches is dropped on load", () => {
  // Pins wear the chrome's indigo now. A blob written while the swatches
  // existed must not smuggle its hex back into the live settings.
  assert.ok(!("markerColor" in editor.DEFAULT_SETTINGS), "markerColor is a setting again")
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ markerColor: "#0088FF", clearOnCopy: true }))
  editor.resetAnnotationsForTest()
  assert.ok(!("markerColor" in editor.annotationSettings()), "the retired colour survived the load")
  assert.equal(editor.annotationSettings().clearOnCopy, true, "the rest of the blob was lost with it")
})

console.log("\nThe format strip")

check("the detail menu offers every level and writes the one you pick", () => {
  seedTab()
  // A note first: the menu lives in the Notes section now, and a section with
  // nothing in it is not in the document. Nothing to hand over, nothing to set
  // the detail of.
  note(saveButton, "Something to hand over")
  /*
   * A MENU, where this was a segmented strip of four.
   *
   * Four labelled pills do not fit a 244px column, so the strip overflowed
   * sideways with its scrollbar hidden and announced the overflow by cutting
   * the last segment in half. The options were not all visible; the only one
   * that reliably was is the one already chosen. A `select` is as wide as its
   * trigger and as tall as it needs to be when opened.
   */
  const menu = detailMenu()
  assert.ok(menu, "the detail control is gone entirely")
  assert.equal(menu.tagName, "SELECT")
  assert.deepEqual(
    Array.from(menu.options).map((option) => option.value),
    editor.OUTPUT_DETAILS.map((level) => level.id),
    "the menu does not offer every level"
  )
  assert.deepEqual(
    Array.from(menu.options).map((option) => option.textContent),
    editor.OUTPUT_DETAILS.map((level) => level.label)
  )
  // The per-level hint used to live in each segment's `title`. `<option>` is
  // the one element whose `title` a platform menu actually surfaces, so it
  // moved onto the option rather than being dropped.
  assert.deepEqual(
    Array.from(menu.options).map((option) => option.getAttribute("title")),
    editor.OUTPUT_DETAILS.map((level) => level.hint)
  )

  /*
   * NOT a tablist, and not a radiogroup either any more.
   *
   * The strip had to claim `radiogroup` explicitly to stay out of the
   * inspector's own tablist — four more `[role="tab"]` nodes in the right panel
   * would have made `inspector-tabs-cases` report seven tabs with two selected.
   * A native select carries its own role and cannot collide.
   */
  assert.deepEqual(
    Array.from(pane.querySelectorAll('[role="tab"], [role="tablist"], [role="radio"]')),
    [],
    "the detail control joined the inspector's own tablist"
  )
  assert.equal(menu.getAttribute("aria-label"), "Brief detail")

  // Standard is the shipped default, so the menu opens on it.
  assert.equal(editor.annotationSettings().outputDetail, "standard")
  assert.equal(menu.value, "standard")

  menu.value = "forensic"
  menu.dispatchEvent(new window.Event("change", { bubbles: true }))
  assert.equal(
    editor.annotationSettings().outputDetail,
    "forensic",
    "picking a level never reached the store, so the brief is still Standard"
  )
})

check("the menu repaints from the store, and a stored junk level does not blank it", () => {
  seedTab()
  note(saveButton, "Something to hand over")
  editor.updateSettings({ outputDetail: "compact" })
  assert.equal(detailMenu().value, "compact", "the menu did not follow the store")

  /*
   * A settings blob written by a build that spelled the levels differently
   * leaves a value none of the options carry, and a `select` handed one of
   * those goes BLANK — a menu naming no level at all, over a brief still being
   * written at some level. It falls back to the first option instead.
   */
  editor.updateSettings({ outputDetail: "nonsense-level" })
  assert.equal(
    detailMenu().value,
    editor.OUTPUT_DETAILS[0].id,
    "an unknown stored level blanked the menu"
  )
})

check("brief detail is offered once, as the first row in Settings", () => {
  seedTab()
  note(saveButton, "Something to hand over")
  const settingsPane = sections().at(-1)
  assert.equal(pane.querySelectorAll(".de-ann-detail").length, 1, "one setting has two controls")
  const row = settingsPane.querySelector(".de-ann-setting")
  assert.ok(row.classList.contains("de-ann-detail"), "the detail menu is not the first setting")
  assert.equal(row.querySelector(".de-ann-setting-label").textContent, "Brief detail")
  assert.equal(
    settingsPane.querySelector(".de-ann-value"),
    null,
    "the cycling output-detail row is back, so one setting has two controls"
  )
})

check("the fold no longer offers to turn the lane on the editor", () => {
  seedTab()
  /*
   * The one row in this fold that could strand the person who pressed it.
   *
   * Editor scope swallows clicks on the editor's own chrome in order to
   * annotate it, which includes the switch that turns it off — so the hint had
   * to teach a keyboard escape before anyone touched the control. The setting
   * still exists for `annotations/canvas.ts` and for the cases at the bottom of
   * this file; what is gone is the row that let a designer walk into it by
   * accident while annotating an app.
   */
  const settingsPane = sections().at(-1)
  assert.ok(
    !Array.from(settingsPane.querySelectorAll(".de-ann-setting-label")).some((node) =>
      node.textContent.includes("Annotate the editor")
    ),
    "the settings fold still offers to point the lane at the editor"
  )
})

check("each setting's hint opens on hover of its label, with no help dot", () => {
  seedTab()
  const pane = sections().at(-1)
  assert.equal(pane.querySelector(".de-ann-help"), null, "a help dot is still drawn")
  const rows = Array.from(pane.querySelectorAll(".de-ann-setting"))
  assert.equal(rows.length, 4, "expected four settings")
  for (const row of rows) {
    const label = row.querySelector(".de-ann-setting-label")
    // The detail row's control is a menu, described the same way a switch is.
    const toggle = row.querySelector(".de-ann-toggle, select")
    const hint = label.getAttribute("data-de-tip")
    assert.ok(hint, `${label.textContent} opens no hint on hover`)
    assert.equal(label.querySelector("svg"), null, `${label.textContent} still carries a glyph`)
    assert.equal(toggle.getAttribute("aria-description"), hint, `${label.textContent}'s switch does not describe itself`)
  }
})

check("the MCP sentence is the section title's hover, not a line in the body", () => {
  seedTab()
  const mcp = sections().find((node) => node.querySelector(".de-mcp"))
  assert.ok(mcp, "no MCP section")
  assert.equal(mcp.querySelector(".de-mcp .de-ann-brief"), null, "the brief is still in the MCP body")
  const title = mcp.querySelector(".de-section-title")
  assert.match(title.getAttribute("data-de-tip") ?? "", /MCP settings/, "the MCP title opens no hint")
  assert.equal(
    mcp.querySelector(".de-section-toggle").getAttribute("aria-description"),
    title.getAttribute("data-de-tip"),
    "the MCP hint is silent to a screen reader"
  )
})

console.log("\nA row and its pin")

check("hovering a row names its note, and leaving it names nothing", () => {
  seedTab()
  const pinned = note(saveButton, "This gap is too tight")
  const row = noteRows()[0]

  assert.deepEqual(
    heardOn("designlayer:annotation-hover", () => hover(row, "mouseenter")),
    [{ id: pinned.id }],
    "hovering a row told the canvas nothing, so the pin never lights"
  )
  assert.ok(row.classList.contains("de-ann-item--hover"), "the row does not light itself")

  // `null` rather than silence. A canvas that only ever hears "now this one"
  // leaves the last pin lit long after the pointer has gone.
  assert.deepEqual(
    heardOn("designlayer:annotation-hover", () => hover(row, "mouseleave")),
    [{ id: null }]
  )
  assert.ok(!row.classList.contains("de-ann-item--hover"))
})

check("an edit row names itself too, so the previous pin does not stay lit", () => {
  seedTab()
  note(saveButton, "A note")
  tick()
  const made = editor.recordEdit({
    property: "padding",
    from: "16px",
    to: "24px",
    element: lede,
    written: true,
  })

  assert.deepEqual(
    heardOn("designlayer:annotation-hover", () => hover(editRows()[0], "mouseenter")),
    [{ id: made.id }],
    "moving from a note onto an edit left the note's pin lit"
  )
})

check("a keyboard user reaches the row actions, and lights the pin doing it", () => {
  seedTab()
  const pinned = note(saveButton, "Reachable by Tab")
  const row = noteRows()[0]
  const actions = rowActions(row)

  // Mounted at all times, not rendered on hover. A control that exists only
  // while the pointer is over it is a control no screen reader ever sees and no
  // keyboard ever reaches.
  assert.equal(actions.length, 2, "the row actions are conditionally mounted")
  for (const action of actions) {
    assert.equal(action.hidden, false, "a row action is hidden from the accessibility tree")
    assert.equal(action.getAttribute("tabindex"), null, "a row action was taken out of the tab order")
    assert.ok(action.getAttribute("aria-label"), "an icon-only row action with no name")
  }

  // The reveal is `:hover`/`:focus-within` in the stylesheet, so focus has to
  // light the row for the same reason the pointer does.
  assert.deepEqual(
    heardOn("designlayer:annotation-hover", () =>
      actions[0].dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }))
    ),
    [{ id: pinned.id }]
  )
  assert.ok(row.classList.contains("de-ann-item--hover"))

  // Tabbing between this row's own buttons is not leaving the row. Reporting it
  // would blink the pin once per keypress.
  assert.deepEqual(
    heardOn("designlayer:annotation-hover", () =>
      actions[0].dispatchEvent(
        new window.FocusEvent("focusout", { bubbles: true, relatedTarget: actions[1] })
      )
    ),
    [],
    "a hop between two buttons in one row was reported as leaving it"
  )

  assert.deepEqual(
    heardOn("designlayer:annotation-hover", () =>
      actions[actions.length - 1].dispatchEvent(
        new window.FocusEvent("focusout", { bubbles: true, relatedTarget: eyeButton() })
      )
    ),
    [{ id: null }],
    "focus left the row entirely and the pin stayed lit"
  )
})

check("edit asks the canvas to reopen the note, and only a note offers it", () => {
  seedTab()
  const pinned = note(saveButton, "Wrong word")
  tick()
  editor.recordEdit({ property: "gap", from: "8px", to: "16px", element: lede, written: false })

  // First of two now, not second of three: the resolve tick that used to lead
  // the row is gone, so edit is the row's opening action.
  const [edit] = rowActions(noteRows()[0])
  assert.match(edit.getAttribute("aria-label"), /^Edit on page/)
  assert.equal(edit.getAttribute("data-de-tip"), edit.getAttribute("aria-label"))
  assert.equal(edit.getAttribute("title"), null, "the OS tooltip is back over the styled one")
  assert.deepEqual(
    heardOn("designlayer:annotation-edit", () => press(edit)),
    [{ id: pinned.id }],
    "the edit button opened nothing"
  )
  // Pressing it must not also delete or resolve anything — it is a request to
  // another surface and changes no store on its own.
  assert.equal(editor.annotations().length, 1)

  // An edit row has no composer to reopen: the way to change an edit is to
  // change the element again, which writes a new row. A button that opened
  // nothing would be a door into a room that was never built.
  const editActions = rowActions(editRows()[0])
  assert.equal(editActions.length, 1, "an edit row offered more than the one thing it can do")
  assert.equal(editActions[0], deleteButton(editRows()[0]), "the edit row's one action is not delete")
  // "Take this change back", not the old "Drop this edit … the change stays
  // applied". That sentence described a bug: the row left the list and the
  // queued write stayed, so pressing Apply afterwards wrote a change the
  // designer had explicitly discarded. The bin withdraws the work now, and the
  // label is the thing that has to say so.
  assert.match(editActions[0].getAttribute("aria-label"), /^Discard change/)
})

check("a pin hovered on the page lights its row, and no other", () => {
  seedTab()
  const first = note(saveButton, "One")
  tick()
  note(lede, "Two")
  const rows = noteRows()

  const mirror = (id) =>
    window.dispatchEvent(new window.CustomEvent("designlayer:marker-hover", { detail: { id } }))

  mirror(first.id)
  assert.deepEqual(
    rows.map((row) => row.classList.contains("de-ann-item--hover")),
    [true, false],
    "a pin hovered on the page lit the wrong row, or none"
  )

  // A note deleted while the pointer sat on its pin names a row that is not in
  // the list any more, and nothing may stay lit on the strength of it.
  mirror("ann-gone")
  assert.deepEqual(
    rows.map((row) => row.classList.contains("de-ann-item--hover")),
    [false, false]
  )

  mirror(first.id)
  mirror(null)
  assert.deepEqual(
    rows.map((row) => row.classList.contains("de-ann-item--hover")),
    [false, false],
    "the row stayed lit after the pointer left the pin"
  )
})

/* ==========================================================================
 * Host parity
 * ======================================================================== */

console.log("\nThe brief names the host's own components")

/**
 * Angular has no owner stack to read, so `owningComponentName` asks
 * `ng.getOwningComponent` and the walk keeps the changes. One instance for every
 * node is what a single-component template looks like.
 */
class ShellComponent {}
window.ng = { getOwningComponent: () => new ShellComponent() }

reset()
note(saveButton, "Whose component is this?")
const reactBrief = editor.buildAnnotationBrief()

const angularEditor = await loadEditor("angular-host", "angular")
angularEditor.resetAnnotationsForTest()
angularEditor.resetJournalForTest()
window.localStorage.clear()
angularEditor.addAnnotation({
  kind: "element",
  comment: "Whose component is this?",
  url: window.location.href,
  rect: { x: 10, y: 20, width: 120, height: 40 },
  target: angularEditor.describeElement(saveButton),
  selectedText: null,
  element: saveButton,
})
const angularBrief = angularEditor.buildAnnotationBrief()

check("the two bundles really are two hosts, not one module loaded twice", () => {
  assert.equal(editor.config.host.framework, "react")
  assert.equal(angularEditor.config.host.framework, "angular")
})

check("a React host is told to look for React components", () => {
  // Agentation's field, outermost component first.
  assert.match(reactBrief, /^\*\*React:\*\* <Toolbar> <SaveButton>$/m)
  assert.ok(!reactBrief.includes("**Angular:**"), "a React brief named Angular")
})

check("an Angular host is told to look for Angular components", () => {
  // Told to find a React component in an Angular project, an agent searches for
  // a file that was never going to exist and concludes the brief describes a
  // different application. The field keeps Agentation's shape and takes the
  // host's name.
  assert.match(angularBrief, /^\*\*Angular:\*\* <ShellComponent>$/m)
  assert.ok(!angularBrief.includes("**React:**"), "an Angular brief named React")
})


/* ── Annotating the editor itself ────────────────────────────────────────── */

/*
 * The scope that replaced a second annotation tool.
 *
 * The editor cannot normally be pointed at its own chrome — `isChrome` is what
 * stops a pin becoming the target of a pin — and that gap is the only thing a
 * separate, PolyForm-licensed toolbar was mounted beside this lane to do. The
 * cases below are the terms on which the gap was closed: the app stays the
 * default, the chrome becomes targetable when asked, and the lane's own
 * surfaces never do.
 */

await checkAsync("the app is the default subject, and chrome is not annotatable", async () => {
  reset()
  editor.updateSettings({ scope: "app" })
  // Dismiss a composer an earlier case left open, through its own Cancel —
  // the mode flag does not tear one down, and without this the assertion below
  // reads someone else's state rather than this case's.
  const stale = composer()
  if (stale) {
    Array.from(stale.querySelectorAll("button"))
      .find((b) => b.textContent === "Cancel")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
  }
  enterAnnotating(true)
  await settle()
  assert.equal(composer(), null, "a composer survived into this case from an earlier one")

  assert.equal(editor.annotationSettings().scope, "app", "the lane did not start on the app")

  // A press on the editor's own panel does nothing at all in app scope.
  window.__stack = [slots.right]
  pin(slots.right)
  assert.equal(composer(), null, "a click on the editor's own panel opened a composer in app scope")
  assert.deepEqual(editor.annotations(), [], "app scope pinned a note on the editor's chrome")
})

await checkAsync("editor scope pins a note on the editor's own panel", async () => {
  reset()
  editor.updateSettings({ scope: "editor" })
  enterAnnotating(true)
  await settle()

  window.__stack = [slots.right]
  pin(slots.right)
  assert.ok(composer(), "editor scope did not open a composer over the editor's own panel")
  write("the inspector empty state is too quiet")

  const notes = editor.annotations()
  assert.equal(notes.length, 1, "editor scope did not record the note")
  assert.equal(notes[0].comment, "the inspector empty state is too quiet")
})

await checkAsync("editor scope leaves the app alone", async () => {
  reset()
  editor.updateSettings({ scope: "editor" })
  enterAnnotating(true)
  await settle()

  // The app is not the subject now, so a press on it is not a note. Without
  // this the two scopes would be additive and every note ambiguous about which
  // product it is feedback on.
  window.__stack = [saveButton]
  pin(saveButton)
  assert.equal(composer(), null, "editor scope opened a composer over the app")
  assert.deepEqual(editor.annotations(), [], "editor scope pinned a note on the app")
})

await checkAsync("the lane never becomes its own subject", async () => {
  reset()
  editor.updateSettings({ scope: "editor" })
  enterAnnotating(true)
  await settle()

  // `layer` is inside `slots.overlay`, which is chrome — so without the
  // `layer.contains` guard this is exactly the infinite regress: a pin you can
  // annotate, and a note about a note.
  const ownSurface = window.document.createElement("div")
  layer.append(ownSurface)
  window.__stack = [ownSurface]
  pin(ownSurface)
  assert.equal(composer(), null, "the annotation layer annotated itself")
  assert.deepEqual(editor.annotations(), [], "a note was pinned to the lane's own chrome")
  ownSurface.remove()
})

await checkAsync("the scope does not survive a restart", async () => {
  editor.updateSettings({ scope: "editor" })
  assert.equal(editor.annotationSettings().scope, "editor")
  // A session that silently resumed pointed at the panels would look like the
  // annotation tool had stopped seeing the page.
  assert.equal(
    editor.DEFAULT_SETTINGS.scope,
    "app",
    "the shipped default points the lane at the editor rather than the page"
  )
  editor.updateSettings({ scope: "app" })

  /*
   * And the default is not the whole claim, now that no control sets this.
   *
   * `persist` writes the settings blob whole, so a session that reached editor
   * scope left `"editor"` on disk — and with the switch gone from the fold
   * there is nothing left to flip it back with. The next load has to do it, or
   * the editor opens permanently pointed at its own panels. A fresh module over
   * a seeded blob is the only way to assert it: `load()` runs once per module
   * instance, and this file's main instance ran it long ago.
   */
  window.localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ ...editor.DEFAULT_SETTINGS, scope: "editor" })
  )
  const restarted = await loadEditor("scope-restart", "react")
  assert.equal(
    restarted.annotationSettings().scope,
    "app",
    "a stored editor scope came back on the next load, with no control left to leave it by"
  )
  window.localStorage.clear()
})

fs.rmSync(bundleDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
