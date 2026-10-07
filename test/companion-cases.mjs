/**
 * Companions: somebody else's dev-time browser tooling, loaded beside the
 * editor rather than instead of it.
 *
 * The feature is three small pieces that only mean anything together, and each
 * of them fails silently on its own — which is what this suite is for.
 *
 * ## Resolution, where a mistake must be loud
 *
 * A companion is declared by a path, and the path can be wrong in the ordinary
 * ways: missing file, a manifest that is not JSON, a directory where a bundle
 * was meant. Every one of those throws rather than resolving to "no companion",
 * because the failure mode this replaces is an editor that comes up looking
 * perfectly normal with a toolbar the person asked for silently absent. The one
 * thing that does NOT throw is a companion that disappears after launch: the
 * overlay keeps serving without it, since a file somebody else owns must not be
 * able to take the editor down mid-session.
 *
 * ## Selectors, which are the whole reason the manifest exists
 *
 * A companion's UI has to be trusted chrome or the canvas eats its clicks, and
 * the project whose page it lands on has never heard of it — a machine-wide
 * companion is wired in by the person, not by the repository. So the manifest
 * carries the selectors and `resolveConfig` folds them into
 * `chrome.trustedSelectors`, which is what the vendor patch bakes in and what
 * the browser prelude publishes. Both readers are checked here, because they
 * are two different strings built from one list.
 *
 * ## Load order, which decides who survives whom
 *
 * The bundles are concatenated after the editor's own, each fenced in a
 * `try`/`catch`, so a companion that throws on evaluation costs itself and
 * nothing else. That fencing is asserted by evaluating the real output, not by
 * matching source text: the point is the behaviour, and a regex would pass on
 * a `try` that wrapped the wrong half.
 *
 * Usage: node designlayer/test/companion-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"

import { JSDOM } from "jsdom"

import { resolveConfig, browserPrelude } from "../config.mjs"
import {
  COMPANIONS_ENV,
  companionSelectors,
  resolveCompanions,
  wrapCompanion,
} from "../server/companions.mjs"
import { readCompanionBundles } from "../runtime/launcher.mjs"
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

const TMP = fs.realpathSync(os.tmpdir())
const made = []

/** A throwaway project folder, cleared up however this process exits. */
function workspace(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, `designlayer-companion-${label}-`)))
  made.push(dir)
  return dir
}

process.once("exit", () => {
  for (const dir of made) {
    if (dir.startsWith(`${TMP}${path.sep}`)) fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** Writes a bundle and the manifest beside it, the shape a companion ships in. */
function companion(dir, name, { source = `window.${name} = true`, trustedSelectors } = {}) {
  const home = path.join(dir, name)
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, `${name}.js`), source, "utf8")
  const manifest = path.join(home, "companion.json")
  fs.writeFileSync(
    manifest,
    JSON.stringify({ name, script: `./${name}.js`, ...(trustedSelectors ? { trustedSelectors } : {}) }),
    "utf8"
  )
  return { home, manifest, script: path.join(home, `${name}.js`) }
}

/** `resolveCompanions` with an env that names no companions unless asked. */
function resolve(value, projectRoot, env = {}) {
  return resolveCompanions(value, projectRoot, env)
}

// ── Declaring one ───────────────────────────────────────────────────────────

check("a manifest resolves to its bundle, its name and its selectors", () => {
  const dir = workspace("manifest")
  const { manifest, script } = companion(dir, "toolbar", {
    trustedSelectors: ["[data-toolbar-root]", "toolbar-el"],
  })

  const [resolved] = resolve([manifest], dir)
  assert.equal(resolved.name, "toolbar")
  assert.equal(resolved.script, script)
  assert.deepEqual([...resolved.trustedSelectors], ["[data-toolbar-root]", "toolbar-el"])
})

check("a manifest's script path is read against the manifest, not the project", () => {
  // The manifest and its bundle travel together and are mounted from anywhere —
  // a machine-wide folder, most often — so `"./toolbar.js"` has to mean "beside
  // this file". Resolving it against the project root would work only for the
  // one project the companion happened to be copied into.
  const dir = workspace("relative")
  const { manifest, script } = companion(dir, "toolbar")
  const elsewhere = workspace("elsewhere")

  const [resolved] = resolve([manifest], elsewhere)
  assert.equal(resolved.script, script)
})

check("a bare bundle is a companion with no chrome to declare", () => {
  const dir = workspace("bare")
  const { script } = companion(dir, "probe")

  const [resolved] = resolve([script], dir)
  assert.equal(resolved.name, "probe")
  assert.deepEqual([...resolved.trustedSelectors], [])
})

check("an object states the same three things inline", () => {
  const dir = workspace("inline")
  companion(dir, "toolbar")

  const [resolved] = resolve(
    [{ name: "renamed", script: "toolbar/toolbar.js", trustedSelectors: ["#x"] }],
    dir
  )
  assert.equal(resolved.name, "renamed")
  assert.deepEqual([...resolved.trustedSelectors], ["#x"])
})

check("no companions is the default, and null says the same", () => {
  const dir = workspace("none")
  assert.deepEqual(resolve(undefined, dir), [])
  assert.deepEqual(resolve(null, dir), [])
  assert.deepEqual(resolve([], dir), [])
})

// ── Getting it wrong ────────────────────────────────────────────────────────

check("a missing bundle throws, naming the path it looked for", () => {
  const dir = workspace("missing")
  assert.throws(() => resolve(["./nope.js"], dir), /companions\[0\] script not found/)
})

check("a directory is not a bundle", () => {
  const dir = workspace("directory")
  // A folder that ends in `.js` takes the bundle branch and would otherwise be
  // handed to `readFileSync` at the first overlay request rather than here.
  fs.mkdirSync(path.join(dir, "toolbar.js"))
  assert.throws(() => resolve(["./toolbar.js"], dir), /script not found/)
})

check("a manifest that is not JSON throws rather than resolving to nothing", () => {
  const dir = workspace("broken-json")
  const manifest = path.join(dir, "companion.json")
  fs.writeFileSync(manifest, "{ not json", "utf8")
  assert.throws(() => resolve([manifest], dir), /is not valid JSON/)
})

check("a manifest with no script throws", () => {
  const dir = workspace("no-script")
  const manifest = path.join(dir, "companion.json")
  fs.writeFileSync(manifest, JSON.stringify({ name: "toolbar" }), "utf8")
  assert.throws(() => resolve([manifest], dir), /needs a script path/)
})

check("trustedSelectors has to be a list", () => {
  const dir = workspace("bad-selectors")
  companion(dir, "toolbar")
  assert.throws(
    () => resolve([{ script: "toolbar/toolbar.js", trustedSelectors: "#x" }], dir),
    /trustedSelectors must be an array/
  )
})

check("companions has to be a list", () => {
  const dir = workspace("not-a-list")
  assert.throws(() => resolve({ script: "x.js" }, dir), /companions must be an array/)
})

// ── The machine-wide lane ───────────────────────────────────────────────────

check("the env var wires a companion into a project that never mentioned it", () => {
  const dir = workspace("env")
  const { manifest } = companion(dir, "toolbar", { trustedSelectors: ["[data-toolbar-root]"] })

  const resolved = resolve([], dir, { [COMPANIONS_ENV]: manifest })
  assert.equal(resolved.length, 1)
  assert.deepEqual([...resolved[0].trustedSelectors], ["[data-toolbar-root]"])
})

check("the env var takes several, separated either way", () => {
  const dir = workspace("env-many")
  const one = companion(dir, "one")
  const two = companion(dir, "two")
  const three = companion(dir, "three")

  const colons = resolve([], dir, {
    [COMPANIONS_ENV]: `${one.manifest}:${two.manifest}`,
  })
  const commas = resolve([], dir, {
    [COMPANIONS_ENV]: `${one.manifest},${three.manifest}`,
  })
  assert.deepEqual(colons.map((c) => c.name), ["one", "two"])
  assert.deepEqual(commas.map((c) => c.name), ["one", "three"])
})

check("the project's copy wins over the machine's, and mounts once", () => {
  // Both lanes naming one companion is the ordinary case for anyone who wired
  // a toolbar in machine-wide and then pinned it in a project. Mounting it
  // twice would post two sessions and show two toolbars.
  const dir = workspace("dedupe")
  const mine = companion(dir, "toolbar", { trustedSelectors: ["#mine"] })
  const ambient = workspace("ambient")
  const theirs = companion(ambient, "toolbar", { trustedSelectors: ["#theirs"] })

  const resolved = resolve([mine.manifest], dir, { [COMPANIONS_ENV]: theirs.manifest })
  assert.equal(resolved.length, 1)
  assert.deepEqual([...resolved[0].trustedSelectors], ["#mine"])
})

check("an empty or absent env var adds nothing", () => {
  const dir = workspace("env-empty")
  assert.deepEqual(resolve([], dir, {}), [])
  assert.deepEqual(resolve([], dir, { [COMPANIONS_ENV]: "" }), [])
  assert.deepEqual(resolve([], dir, { [COMPANIONS_ENV]: "  ,  " }), [])
})

// ── What the browser is told ────────────────────────────────────────────────

check("a companion's selectors reach both readers of chrome.trustedSelectors", () => {
  const dir = workspace("trusted")
  const { manifest } = companion(dir, "toolbar", {
    trustedSelectors: ["[data-toolbar-root]", "toolbar-el"],
  })
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "host" }), "utf8")

  const config = resolveConfig(
    { companions: [manifest], chrome: { trustedSelectors: ["#host-devtools"] } },
    { cwd: dir }
  )

  // The vendor patch reads the joined string; the editor bundle reads the list.
  assert.deepEqual(
    [...config.chrome.trustedSelectors],
    ["#host-devtools", "[data-toolbar-root]", "toolbar-el"]
  )
  assert.equal(
    config.chrome.trustedSelector,
    "#host-devtools,[data-toolbar-root],toolbar-el"
  )
  const prelude = browserPrelude(config)
  assert.ok(prelude.includes("[data-toolbar-root]"), "the prelude withheld a companion's selectors")
})

check("a selector declared twice is matched once", () => {
  const dir = workspace("dupe-selector")
  const { manifest } = companion(dir, "toolbar", { trustedSelectors: ["#shared"] })
  const config = resolveConfig(
    { companions: [manifest], chrome: { trustedSelectors: ["#shared"] } },
    { cwd: dir }
  )
  assert.deepEqual([...config.chrome.trustedSelectors], ["#shared"])
})

check("no companions leaves the host's own selectors exactly as they were", () => {
  const dir = workspace("untouched")
  const config = resolveConfig({ chrome: { trustedSelectors: ["#host"] } }, { cwd: dir })
  assert.deepEqual([...config.chrome.trustedSelectors], ["#host"])
  assert.equal(config.chrome.trustedSelector, "#host")
})

// ── What the overlay serves ─────────────────────────────────────────────────

/** Evaluates a served bundle the way a page would, and reports what it did. */
function evaluate(source) {
  const sandbox = { window: {}, console: { error: () => {} } }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return sandbox.window
}

check("every companion's bundle is served, in declaration order", () => {
  const dir = workspace("served")
  const first = companion(dir, "first", { source: "window.order = (window.order || []).concat('first')" })
  const second = companion(dir, "second", { source: "window.order = (window.order || []).concat('second')" })

  const config = resolveConfig({ companions: [first.manifest, second.manifest] }, { cwd: dir })
  const served = readCompanionBundles(config)
  // Joined rather than compared as arrays: the value comes out of another realm,
  // where `deepEqual` refuses two arrays with different Array prototypes.
  assert.equal(evaluate(served).order.join(" then "), "first then second")
})

check("a companion that throws on evaluation costs only itself", () => {
  const dir = workspace("throwing")
  const bad = companion(dir, "bad", { source: "throw new Error('boom')" })
  const good = companion(dir, "good", { source: "window.good = true" })

  const config = resolveConfig({ companions: [bad.manifest, good.manifest] }, { cwd: dir })
  assert.equal(evaluate(readCompanionBundles(config)).good, true)
})

check("a companion cannot leak a declaration into the shared scope", () => {
  const dir = workspace("scope")
  const { manifest } = companion(dir, "leaky", {
    source: "var privateToTheBundle = 1; window.leaked = typeof privateToTheBundle",
  })
  const config = resolveConfig({ companions: [manifest] }, { cwd: dir })
  const served = readCompanionBundles(config)

  // It sees its own declaration, and the scope it ran in is gone afterwards.
  assert.equal(evaluate(served).leaked, "number")
  assert.ok(
    served.startsWith(";(function(){try{"),
    "a companion was concatenated without its fence"
  )
})

check("a companion deleted after launch warns and is skipped", () => {
  // The alternative is a 500 on the overlay, which takes the editor down over a
  // file this package does not own and did not write.
  const dir = workspace("vanished")
  const gone = companion(dir, "gone")
  const stays = companion(dir, "stays", { source: "window.stays = true" })
  const config = resolveConfig({ companions: [gone.manifest, stays.manifest] }, { cwd: dir })

  fs.rmSync(gone.script)
  const warnings = []
  const realWarn = console.warn
  console.warn = (message) => warnings.push(String(message))
  let served
  try {
    served = readCompanionBundles(config)
  } finally {
    console.warn = realWarn
  }

  assert.equal(evaluate(served).stays, true)
  assert.ok(
    warnings.some((line) => line.includes('companion "gone"')),
    "a missing companion was skipped without saying so"
  )
})

check("no companions serves nothing at all", () => {
  const dir = workspace("silent")
  assert.equal(readCompanionBundles(resolveConfig({}, { cwd: dir })), "")
})

check("the fence names the companion, so a console error says which one", () => {
  const wrapped = wrapCompanion("agentation", "throw new Error('x')")
  assert.ok(wrapped.includes('companion \\"agentation\\" failed to start'))
})

check("companionSelectors flattens in declaration order", () => {
  assert.deepEqual(
    companionSelectors([
      { name: "a", script: "", trustedSelectors: ["#a1", "#a2"] },
      { name: "b", script: "", trustedSelectors: ["#b1"] },
    ]),
    ["#a1", "#a2", "#b1"]
  )
})

// ── The pointer, and who is holding it ──────────────────────────────────────

/*
 * Trusted chrome makes a companion CLICKABLE; the claim makes it WORK. An
 * annotation toolbar's gesture is clicking the app, which is the one thing
 * `inspecting` exists to swallow, so a companion that wants the page says so
 * and the editor stands down for as long as it is asked to.
 *
 * Driven against the real store rather than a booted editor: what is under
 * test is the bookkeeping — who claimed, what to put back, and who outranks
 * whom — and a jsdom shell would add a page's worth of failure modes without
 * proving a single one of those.
 */
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" })
globalThis.window = dom.window

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { installCompanionApi } from "./src/core/companion-api"
      export { editorMode, setMode, setState, subscribe } from "./src/core/store"
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

/** The editor reduced to the two members the API drives. */
function api(startingMode = "inspecting") {
  editor.setMode(startingMode)
  editor.installCompanionApi({
    setMode: (mode) => editor.setMode(mode),
    subscribe: editor.subscribe,
  })
  return dom.window.__DESIGNLAYER__
}

check("the API announces itself with a version a companion can check", () => {
  const surface = api()
  assert.equal(surface.version, 1)
  assert.equal(surface.mode(), "inspecting")
})

check("a claim hands the pointer to the page, and releasing hands it back", () => {
  const surface = api("inspecting")
  const release = surface.claimPointer("agentation")
  assert.equal(surface.mode(), "interactive")
  release()
  assert.equal(surface.mode(), "inspecting")
})

check("the mode it restores is the one in force when the claim was taken", () => {
  const surface = api("annotating")
  const release = surface.claimPointer("agentation")
  assert.equal(surface.mode(), "interactive")
  release()
  assert.equal(surface.mode(), "annotating")
})

check("claiming from interactive leaves it there afterwards", () => {
  const surface = api("interactive")
  surface.claimPointer("agentation")()
  assert.equal(surface.mode(), "interactive")
})

check("the user outranks the claim, and the release does not argue", () => {
  // Pressing Inspect while a companion holds the pointer is a person choosing,
  // and a release that restored afterwards would yank the mode out from under
  // them some arbitrary number of seconds later.
  const surface = api("inspecting")
  const release = surface.claimPointer("agentation")
  surface.setMode("inspecting")
  release()
  assert.equal(surface.mode(), "inspecting")
})

check("two companions both have to let go", () => {
  const surface = api("inspecting")
  const first = surface.claimPointer("agentation")
  const second = surface.claimPointer("flags")
  first()
  assert.equal(surface.mode(), "interactive", "one release freed a pointer two tools were holding")
  second()
  assert.equal(surface.mode(), "inspecting")
})

check("claiming twice under one name is one claim, and releasing twice is safe", () => {
  const surface = api("inspecting")
  surface.claimPointer("agentation")
  const release = surface.claimPointer("agentation")
  release()
  assert.equal(surface.mode(), "inspecting")
  release()
  assert.equal(surface.mode(), "inspecting")
})

// ── Telling a companion it has been overruled ───────────────────────────────

/*
 * The claim is only half of it. A companion that is armed while the user takes
 * the pointer back answers the same click the editor does — measured on :3466,
 * one click both selected a `<span>` into the inspector and opened an
 * annotation box on it. `onModeChange` is where the companion learns to disarm,
 * so exactly one tool is ever listening.
 */

check("a companion is told when the user takes the pointer back", () => {
  const surface = api("inspecting")
  const seen = []
  surface.onModeChange((mode) => seen.push(mode))

  surface.claimPointer("agentation")
  surface.setMode("inspecting")
  assert.deepEqual(seen, ["interactive", "inspecting"])
})

check("unsubscribing stops the notices", () => {
  const surface = api("inspecting")
  const seen = []
  const off = surface.onModeChange((mode) => seen.push(mode))

  surface.setMode("interactive")
  off()
  surface.setMode("annotating")
  assert.deepEqual(seen, ["interactive"])
})

check("only a real mode change wakes a companion", () => {
  // The store publishes on every selection and every hover. A companion woken
  // by a hover is a companion polling, so the same mode twice says nothing.
  const surface = api("inspecting")
  const seen = []
  surface.onModeChange((mode) => seen.push(mode))

  editor.setState({ hovered: null })
  editor.setState({ selection: [] })
  surface.setMode("inspecting")
  assert.deepEqual(seen, [])

  surface.setMode("interactive")
  surface.setMode("interactive")
  assert.deepEqual(seen, ["interactive"])
})

check("the release and the notice agree on the mode that ends up on screen", () => {
  // The round trip a companion actually makes: arm, be overruled, disarm. The
  // release must not put `interactive` back after the user has left it.
  const surface = api("inspecting")
  const seen = []
  surface.onModeChange((mode) => seen.push(mode))

  const release = surface.claimPointer("agentation")
  surface.setMode("inspecting")
  release()

  assert.equal(surface.mode(), "inspecting")
  assert.deepEqual(seen, ["interactive", "inspecting"])
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
