/**
 * The Figma keymap: what each key means, and the one rule that is not Figma's.
 *
 * Three things are asserted here and each of them is a way this feature breaks
 * silently rather than loudly:
 *
 *  1. THE TABLE IS COHERENT. No two rows claim the same chord, every row points
 *     at a command some lane registers, and the chords that a modifier rewrites
 *     on a Mac are matched on `event.code` rather than on `event.key`. That
 *     last one is the bug this suite exists for: ⌥8 reports `"•"` and ⇧2
 *     reports `"@"`, so a row written against `key` works on the machine it was
 *     written on and on no other layout.
 *  2. THE COLLAPSE RULE HOLDS. Bare letters are a loan from the page underneath
 *     and the editor gives them back the moment it stands down to the disc.
 *     ⌘. is the single exception, because it is the way back. A regression here
 *     is invisible in the editor and breaks somebody else's prototype.
 *  3. THE KEYS ACTUALLY DRIVE THE EDITOR. Matching is pure and easy to get
 *     right; the wire from a key press to a mode change runs through a registry
 *     and a capture listener, and that is the half that rots.
 *
 * Usage: node designlayer/test/shortcut-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
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

const dom = new JSDOM(
  '<!doctype html><html><body><main id="app"><button id="cta">Go</button>' +
    '<input id="field" /></main></body></html>',
  { pretendToBeVisual: true, url: "http://localhost/" }
)
const { window } = dom
// The product runs on a Mac and the interesting half of the matcher is the Mac
// half — ⌘ against ⌃, and the characters ⌥ and ⇧ rewrite. One case flips this.
const platform = (value) =>
  Object.defineProperty(window.navigator, "platform", { value, configurable: true })
platform("MacIntel")
window.document.elementsFromPoint = () => []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
}
window.Element.prototype.scrollIntoView = function noop() {}
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
  "localStorage",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

/** One bundle: the command registry is module state every lane has to share. */
const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createContext } from "./src/core/context"
      export { installToolbar } from "./src/shell/toolbar"
      export { installShortcuts } from "./src/shell/shortcuts"
      export { installWayBack } from "./src/shell/way-back"
      export { DESK_KEY_MESSAGE } from "./src/shell/desk"
      export { installCanvas } from "./src/canvas/index"
      export * as keymap from "./src/core/keymap"
      export * as commands from "./src/core/commands"
      export * as store from "./src/core/store"
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
const { keymap, commands, store } = editor
const { SHORTCUTS, chordLabel, matchShortcut, shortcutFor } = keymap
// The attribute the editor marks its own chrome with, and the one a companion
// declares its shadow host under. Spelled here rather than imported so a rename
// of it is caught by this suite rather than silently agreed with.
const CHROME_ATTR = "data-designlayer"

/** A chord, spelled as the event a browser would dispatch for it. */
function press(chord, target = window.document.getElementById("cta")) {
  const mac = /Mac/.test(window.navigator.platform)
  const event = new window.KeyboardEvent("keydown", {
    key: chord.key ?? keyForCode(chord),
    code: chord.code ?? "",
    metaKey: mac ? Boolean(chord.mod) : false,
    ctrlKey: mac ? Boolean(chord.ctrl) : Boolean(chord.mod) || Boolean(chord.ctrl),
    shiftKey: Boolean(chord.shift),
    altKey: Boolean(chord.alt),
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(event, "target", { value: target, configurable: true })
  return event
}

/**
 * What macOS actually puts in `event.key` for the code chords in the table.
 *
 * Not a guess: these are the characters a US layout produces, and they are the
 * whole reason those rows match on `code`. A test that sent the unshifted digit
 * would pass against a `key` matcher too, and prove nothing.
 */
const MAC_KEY_FOR_CODE = {
  "Digit1:alt": "¡",
  "Digit2:alt": "™",
  "Digit2:shift": "@",
  "Digit3:alt": "£",
  "Digit8:alt": "•",
  "Digit9:alt": "ª",
  "Digit0:alt": "º",
  "BracketLeft:mod": "[",
  "BracketRight:mod": "]",
  "BracketLeft:mod:alt": "“",
  "BracketRight:mod:alt": "‘",
  "Backslash:mod:shift": "|",
  "Slash:ctrl:shift": "?",
  // ⌥C on a US Mac layout is a cedilla, which is the whole reason it matches on code.
  "KeyC:mod:alt": "ç",
}
function keyForCode(chord) {
  const flags = ["ctrl", "mod", "alt", "shift"].filter((flag) => chord[flag])
  return MAC_KEY_FOR_CODE[[chord.code, ...flags].join(":")] ?? chord.code ?? ""
}

// ── The table ──────────────────────────────────────────────────────────────

console.log("\nThe table")

check("no two rows claim the same chord", () => {
  const seen = new Map()
  for (const shortcut of SHORTCUTS) {
    for (const chord of [shortcut.chord, ...(shortcut.aliases ?? [])]) {
      const spelling = JSON.stringify([
        chord.key ?? null,
        chord.code ?? null,
        Boolean(chord.mod),
        Boolean(chord.ctrl),
        Boolean(chord.shift),
        Boolean(chord.alt),
      ])
      const owner = seen.get(spelling)
      assert.equal(
        owner,
        undefined,
        `${chordLabel(chord)} is claimed by both ${owner} and ${shortcut.command}`
      )
      seen.set(spelling, shortcut.command)
    }
  }
})

check("every row names a Figma command it came from", () => {
  for (const shortcut of SHORTCUTS) {
    assert.ok(shortcut.figma, `${shortcut.command} has no Figma lineage recorded`)
    assert.ok(shortcut.label, `${shortcut.command} has no label`)
  }
})

check("a chord a modifier rewrites is matched on the physical key", () => {
  /*
   * The bug this file exists for. On a Mac ⌥8 is "•" and ⇧2 is "@", so a row
   * written against `event.key` matches nothing a real keyboard sends.
   */
  for (const shortcut of SHORTCUTS) {
    for (const chord of [shortcut.chord, ...(shortcut.aliases ?? [])]) {
      if (!chord.key) continue
      const rewritten = (chord.alt || chord.shift) && /^[a-z0-9\\[\]/.]$/.test(chord.key)
      // Letters are exempt: ⇧V is still "v" with shiftKey set, and a letter is
      // deliberately matched where the user believes it is on their layout.
      const isLetter = /^[a-z]$/.test(chord.key)
      assert.ok(
        !rewritten || isLetter,
        `${shortcut.command} matches "${chord.key}" under a modifier that rewrites it — use code`
      )
    }
  }
})

check("⌥8 is recognised from the character macOS actually sends", () => {
  const hit = matchShortcut(press({ code: "Digit8", alt: true }))
  assert.equal(hit?.command, "panel.inspector.tab1")
})

check("⇧2 is recognised, and is not ⌥2", () => {
  assert.equal(matchShortcut(press({ code: "Digit2", shift: true }))?.command, "select.reveal")
  assert.equal(matchShortcut(press({ code: "Digit2", alt: true }))?.command, "panel.left.tab2")
})

check("modifiers are exact, so ⌘] and ⌥⌘] are two commands", () => {
  assert.equal(matchShortcut(press({ code: "BracketRight", mod: true }))?.command, "arrange.forward")
  assert.equal(
    matchShortcut(press({ code: "BracketRight", mod: true, alt: true }))?.command,
    "arrange.front"
  )
})

check("a modifier nobody asked for makes it somebody else's key", () => {
  // ⌃⌘Z on a Mac is not undo. It has to fall through rather than be eaten.
  assert.equal(matchShortcut(press({ key: "z", mod: true, ctrl: true })), null)
  assert.equal(matchShortcut(press({ key: "v", mod: true })), null)
})

check("the three modes are V, C and H, and A is a second V", () => {
  assert.equal(matchShortcut(press({ key: "v" }))?.command, "mode.inspect")
  assert.equal(matchShortcut(press({ key: "a" }))?.command, "mode.inspect")
  assert.equal(matchShortcut(press({ key: "c" }))?.command, "mode.notes")
  assert.equal(matchShortcut(press({ key: "h" }))?.command, "mode.interactive")
})

check("a chord prints the way a designer writes it down", () => {
  assert.equal(chordLabel({ key: "v" }, true), "V")
  assert.equal(chordLabel({ code: "Digit1", alt: true }, true), "⌥1")
  assert.equal(chordLabel({ code: "Digit1", alt: true }, false), "Alt+1")
  assert.equal(chordLabel({ key: "z", mod: true, shift: true }, true), "⇧⌘Z")
  assert.equal(chordLabel({ key: "z", mod: true, shift: true }, false), "Ctrl+Shift+Z")
  assert.equal(chordLabel({ code: "BracketRight", mod: true, alt: true }, true), "⌥⌘]")
  assert.equal(chordLabel({ code: "Slash", ctrl: true, shift: true }, true), "⌃⇧?")
  // The unshifted character, because that is the key you are told to press.
  assert.equal(chordLabel({ code: "Digit2", shift: true }, true), "⇧2")
})

// ── The rule that is not Figma's ───────────────────────────────────────────

console.log("\nA collapsed editor gives the keyboard back")

check("every bare key goes quiet while the chrome is hidden", () => {
  for (const shortcut of SHORTCUTS) {
    if (shortcut.owner === "canvas") continue
    assert.equal(
      shortcutFor(press(shortcut.chord), true),
      null,
      `${shortcut.command} still fires with the editor collapsed`
    )
    // The one that survives is answered by the way back, not by the table.
    const anywhere = keymap.everywhereShortcut(press(shortcut.chord))
    if (shortcut.everywhere) {
      assert.equal(anywhere?.command, shortcut.command, `${shortcut.command} must survive a collapse`)
    } else {
      assert.equal(anywhere, null, `${shortcut.command} is answered from anywhere, the page's own keys included`)
    }
  }
})

check("exactly one shortcut survives the collapse, and it is the way back", () => {
  const survivors = SHORTCUTS.filter((shortcut) => shortcut.everywhere)
  assert.deepEqual(
    survivors.map((shortcut) => shortcut.command),
    ["chrome.toggle"],
    "a second key that works while the editor is invisible is a key stolen from the prototype"
  )
})

check("every key is live again once the chrome is back", () => {
  assert.equal(shortcutFor(press({ key: "c" }), false)?.command, "mode.notes")
  assert.equal(shortcutFor(press({ key: "c" }), true), null)
})

check("typing in a field is typing, hidden or not", () => {
  const field = window.document.getElementById("field")
  assert.equal(shortcutFor(press({ key: "v" }, field), false), null)
  assert.equal(shortcutFor(press({ key: "c" }, field), false), null)
})

/*
 * ⌘. TYPES NOTHING, so the text-field gate has nothing to protect from it.
 *
 * It used to be held back like a letter, and every prototype has a field: a
 * composer that focuses itself when the page loads, a search box. Whenever one
 * had focus the way back went dead, with nothing on screen to say why. The
 * table's own listener still declines it, because the way back answers it and
 * two answers to one toggle cancel out.
 */
check("⌘. in a field is still the way back, and only the way back answers it", () => {
  const field = window.document.getElementById("field")
  for (const hidden of [false, true]) {
    assert.equal(shortcutFor(press({ key: ".", mod: true }, field), hidden), null)
  }
  assert.equal(keymap.everywhereShortcut(press({ key: ".", mod: true }, field))?.command, "chrome.toggle")
})

check("a key pressed while an input method is composing is the input method's", () => {
  const composing = new window.KeyboardEvent("keydown", { key: ".", metaKey: true, isComposing: true })
  assert.equal(keymap.everywhereShortcut(composing), null)
})

/*
 * TYPING INSIDE A SHADOW ROOT IS STILL TYPING, and this is the case the guard
 * above cannot see on its own.
 *
 * `event.target` is RETARGETED at a shadow boundary: a keystroke typed into a
 * `<textarea>` inside somebody's shadow root arrives here as the host element,
 * which is not a text field by any test. The editor read that as a bare key on
 * the page and spent it on a tool.
 *
 * It is not hypothetical and it is not rare. A sentence typed into a companion
 * toolbar came out as "Noe oggle read a a cha bubble" — every `a`, `c`, `h`,
 * `s` and `t` eaten, five letters that are tools on the table above. Any host
 * app with a shadow-DOM text field loses characters the same way, and loses
 * them silently: the editor does exactly what it was asked, one keystroke at a
 * time, and the user watches their sentence come out wrong.
 *
 * These two dispatch REAL events through a REAL shadow root rather than
 * building one by hand, because the whole bug lives in what `composedPath()`
 * reports versus what `target` does — a hand-made event would agree with
 * whichever one the implementation happened to read.
 */

/** A `<textarea>` inside an open shadow root, and the host it hides behind. */
function shadowField(hostAttributes = {}) {
  const host = window.document.createElement("div")
  for (const [name, value] of Object.entries(hostAttributes)) host.setAttribute(name, value)
  window.document.body.append(host)
  const field = window.document.createElement("textarea")
  host.attachShadow({ mode: "open" }).append(field)
  return { host, field }
}

/**
 * Asks `question` about the key press from inside a window-capture listener,
 * which is where the editor's own lanes ask it.
 *
 * It has to be answered DURING dispatch. `composedPath()` is defined to return
 * an empty array once dispatch is over, so an event captured and examined
 * afterwards reports only its retargeted `target` — the very thing these cases
 * exist to see past. A harness that asked afterwards would report this bug as
 * unfixed forever, and the fix as impossible.
 */
function whileTyping(field, key, question) {
  let answer
  const listener = (event) => {
    answer = question(event)
  }
  window.addEventListener("keydown", listener, true)
  field.dispatchEvent(
    new window.KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true })
  )
  window.removeEventListener("keydown", listener, true)
  return answer
}

check("a letter typed into a shadow-DOM field is never spent on a tool", () => {
  const { host, field } = shadowField()
  try {
    for (const key of ["c", "v", "a", "h"]) {
      assert.equal(
        whileTyping(field, key, (event) => shortcutFor(event, false)),
        null,
        `"${key}" was taken as a shortcut out of a shadow-DOM text field`
      )
    }
  } finally {
    host.remove()
  }
})

check("the canvas declines keys from inside a shadow root it does not own", () => {
  // The other half: chrome is recognised through the HOST, which is where a
  // companion's declared selector lives, while the field is a node a
  // `closest()` from out here can never reach.
  const { host, field } = shadowField({ [CHROME_ATTR]: "" })
  try {
    assert.equal(whileTyping(field, "ArrowLeft", keymap.ownsCanvasKeys), false)
  } finally {
    host.remove()
  }

  const plain = shadowField()
  try {
    // Not chrome, but still a text field: the canvas keeps its hands off.
    assert.equal(whileTyping(plain.field, "ArrowLeft", keymap.ownsCanvasKeys), false)
  } finally {
    plain.host.remove()
  }
})

check("the canvas keeps its own five, so they are documented and not dispatched", () => {
  const owned = SHORTCUTS.filter((shortcut) => shortcut.owner === "canvas")
  assert.ok(owned.length >= 5, "the navigation keys should be listed here")
  for (const shortcut of owned) {
    assert.equal(
      shortcutFor(press(shortcut.chord), false),
      null,
      `${shortcut.command} is the canvas lane's and must not be dispatched twice`
    )
  }
})

// ── The wire from a key press to the editor ────────────────────────────────

console.log("\nThe keys drive the editor")

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
    addPendingPropertyOperation() {},
  },
}

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const toolbarSlot = slot()
const context = editor.createContext(bridge, {
  overlay: slot(),
  toolbar: toolbarSlot,
  left: slot(),
  right: slot(),
})
editor.installToolbar(context)
editor.installShortcuts(context)
editor.installWayBack()
/*
 * The canvas lane is mounted too, and only Escape needs it.
 *
 * Escape's escalation is a handshake between two lanes — the canvas cancels the
 * event when it clears a selection, and the shell collapses only on a press
 * nobody cancelled. Stubbing either half would assert the stub. With both real,
 * a canvas that stops cancelling, or a shell that stops checking, fails here.
 */
editor.installCanvas(context)

/** A real dispatch, so the capture listener and its guards are in the path. */
const type = (chord, target) => window.dispatchEvent(press(chord, target))

/**
 * The same press, from a focused element rather than from `window`.
 *
 * Escape's last step listens on the BUBBLE phase, and a dispatch aimed at
 * `window` has no phases — every listener on it runs AT_TARGET, in registration
 * order. Sending from a node in the page is what puts capture genuinely before
 * bubble, which is the whole mechanism under test.
 */
const from = (target, chord = { key: "Escape" }) => {
  const event = press(chord, target)
  target.dispatchEvent(event)
  return event
}

check("V, C and H move between the three modes", () => {
  type({ key: "c" })
  assert.equal(store.editorMode(), "annotating")
  type({ key: "h" })
  assert.equal(store.editorMode(), "interactive")
  type({ key: "v" })
  assert.equal(store.editorMode(), "inspecting")
  context.setMode("interactive")
  type({ key: "a" })
  assert.equal(store.editorMode(), "inspecting", "A is a second key for Inspect")
})

check("V and C toggle their mode off again, back to interactive", () => {
  context.setMode("annotating")
  type({ key: "c" })
  assert.equal(store.editorMode(), "interactive", "C again leaves Notes")
  type({ key: "c" })
  assert.equal(store.editorMode(), "annotating")
  type({ key: "v" })
  assert.equal(store.editorMode(), "inspecting", "V from Notes switches, not toggles")
  type({ key: "v" })
  assert.equal(store.editorMode(), "interactive", "V again leaves Inspect")
  context.setMode("inspecting")
  type({ key: "a" })
  assert.equal(store.editorMode(), "interactive", "A toggles like V")
  type({ key: "h" })
  type({ key: "h" })
  assert.equal(store.editorMode(), "interactive", "H only sets; it is the off state")
  context.setMode("inspecting")
})

/*
 * The tab keys are positional, and the PANELS register them — see the note in
 * `core/keymap.ts` for why the names moved out of the table. This suite owns
 * the wire from a key to a command, so it stands in for the panels with spies:
 * whether `panels/left.ts` really registers `panel.left.tab2` is asserted
 * separately below, against the source of truth rather than against a mock.
 */
const fired = []
let drop3 = () => {}
for (const slot of [1, 2, 3]) {
  const off = commands.registerCommand(`panel.left.tab${slot}`, () => fired.push(`left${slot}`))
  if (slot === 3) drop3 = off
  commands.registerCommand(`panel.inspector.tab${slot}`, () => fired.push(`right${slot}`))
}

check("⌥1 / ⌥2 / ⌥3 reach the left panel's first three views", () => {
  fired.length = 0
  type({ code: "Digit1", alt: true })
  type({ code: "Digit2", alt: true })
  type({ code: "Digit3", alt: true })
  assert.deepEqual(fired, ["left1", "left2", "left3"])
})

check("⌥8 / ⌥9 / ⌥0 reach the inspector's first three views", () => {
  fired.length = 0
  type({ code: "Digit8", alt: true })
  type({ code: "Digit9", alt: true })
  type({ code: "Digit0", alt: true })
  assert.deepEqual(fired, ["right1", "right2", "right3"])
})

check("a panel names its own tabs, so a tab key survives the set changing", () => {
  /*
   * The regression that produced the positional design. Both panels register by
   * SLOT, so read that out of their source rather than trusting a mock — a
   * panel that goes back to registering `panel.left.assets` passes every case
   * above and still leaves ⌥2 dead the next time a tab is renamed.
   */
  const read = (file) =>
    fs.readFileSync(path.join(PACKAGE_DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
  assert.match(
    read("src/panels/left.ts"),
    /registerCommand\(`panel\.left\.tab\$\{index \+ 1\}`/,
    "the left panel must register its tab keys by slot"
  )
  assert.match(
    read("src/panels/inspector/index.ts"),
    /registerCommand\(`panel\.inspector\.tab\$\{index \+ 1\}`/,
    "the inspector must register its tab keys by slot"
  )
  for (const file of ["src/shell/shortcuts.ts", "src/core/keymap.ts"]) {
    assert.doesNotMatch(
      read(file),
      /"panel\.(left|inspector)\.(layers|assets|system|design|changes|code)"/,
      `${file} names a tab by id again — the panel owns which tabs exist`
    )
  }
})

check("⌘. hides the editor and brings it back", () => {
  assert.equal(context.getState().chromeHidden, false)
  type({ key: ".", mod: true })
  assert.equal(context.getState().chromeHidden, true)
  type({ key: ".", mod: true })
  assert.equal(context.getState().chromeHidden, false)
})

/** ⌘., typed at `target`: dispatched from that node, as an event of its own window. */
function wayBack(target) {
  const view = target.ownerDocument.defaultView
  const event = new view.KeyboardEvent("keydown", {
    key: ".",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
  return event
}

/** A field in a frame on the page, and the frame. */
function frameWithField(parent = window.document.body) {
  const frame = window.document.createElement("iframe")
  parent.append(frame)
  const inner = frame.contentWindow.document
  const field = inner.createElement("input")
  inner.body.append(field)
  return { frame, field }
}

check("⌘. in a text field of the app hides the editor and brings it back", () => {
  context.setChromeHidden(false)
  const field = window.document.getElementById("field")
  const event = wayBack(field)
  assert.equal(context.getState().chromeHidden, true, "⌘. typed in a field was read as typing")
  assert.equal(event.defaultPrevented, true, "the key must be taken off the page")
  wayBack(field)
  assert.equal(context.getState().chromeHidden, false, "from a field, ⌘. must also be the way back")
})

check("⌘. in one of the editor's own fields does the same", () => {
  const filter = window.document.createElement("input")
  slot().append(filter)
  wayBack(filter)
  assert.equal(context.getState().chromeHidden, true)
  wayBack(filter)
  assert.equal(context.getState().chromeHidden, false)
})

/*
 * A KEY GOES TO THE FOCUSED FRAME'S WINDOW, and to no other.
 *
 * A host that loads one of its own pages in a hidden frame, to index its routes
 * say, and lets a field in there focus itself sends every later key into a page
 * nobody can see. ⌘. went with them, and the designer's way back stopped
 * working "after a while", until they happened to click.
 */
/*
 * The frame is introduced by its load, which reaches the document and never the
 * window: a listener on the window heard nothing, and this case is what caught
 * it. A frame that takes focus before it has loaded is introduced by the blur
 * instead; jsdom loads a frame the moment it is appended, so that half is
 * checked in a real browser by `tools/shortcut-e2e.mjs`, scenario hidden-frame.
 */
check("⌘. typed in a frame on the page reaches the editor once the frame has loaded", () => {
  context.setChromeHidden(false)
  const { frame, field } = frameWithField()
  try {
    const event = wayBack(field)
    assert.equal(context.getState().chromeHidden, true, "⌘. typed in a frame never reached the editor")
    assert.equal(event.defaultPrevented, true)
    // Every navigation loads the frame again; it must not be answered twice.
    frame.dispatchEvent(new window.Event("load"))
    wayBack(field)
    assert.equal(context.getState().chromeHidden, false, "one press toggled twice")
  } finally {
    frame.remove()
  }
})

/*
 * THE MAC APP'S SHELL HANDS OVER WHAT IT HEARS. The editor is a cross-origin
 * frame there, so ⌘. typed on the tab strip, or after the frame reloaded and
 * left focus in the shell, never arrived. desktop/mac/test/desk-cases.mjs holds
 * the other half: what the shell sends.
 */
check("⌘. handed over by the Mac app's shell toggles the editor, and nothing else does", () => {
  context.setChromeHidden(false)
  const shell = window.document.createElement("iframe")
  window.document.body.append(shell)
  const parent = Object.getOwnPropertyDescriptor(window, "parent")
  Object.defineProperty(window, "parent", { get: () => shell.contentWindow, configurable: true })
  const hand = (data, { origin = "http://127.0.0.1:3454", source = shell.contentWindow } = {}) =>
    window.dispatchEvent(new window.MessageEvent("message", { data, origin, source }))
  const dot = {
    type: editor.DESK_KEY_MESSAGE,
    key: ".",
    code: "Period",
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  }
  try {
    hand(dot)
    assert.equal(context.getState().chromeHidden, true, "the shell's ⌘. did not reach the editor")
    hand(dot)
    assert.equal(context.getState().chromeHidden, false)
    hand(dot, { origin: "https://example.com" })
    assert.equal(context.getState().chromeHidden, false, "a page off this machine drove the editor")
    hand(dot, { source: window })
    assert.equal(context.getState().chromeHidden, false, "a window that does not frame the editor drove it")
    hand({ ...dot, type: "something-else" })
    assert.equal(context.getState().chromeHidden, false)
    // Only the keys answered from anywhere. ⇧⌘\ is a real command, and the
    // shell must not become a second keyboard for it.
    const layers = context.getState().layersOpen
    hand({ ...dot, key: "|", code: "Backslash", shiftKey: true })
    assert.equal(context.getState().layersOpen, layers, "the shell ran a key that is not the way back")
  } finally {
    Object.defineProperty(window, "parent", parent)
    shell.remove()
  }
})

check("\\ hides the editor, and does nothing once it is hidden", () => {
  type({ key: "\\" })
  assert.equal(context.getState().chromeHidden, true)
  type({ key: "\\" })
  assert.equal(context.getState().chromeHidden, true, "a bare key must not work while collapsed")
  type({ key: ".", mod: true })
  assert.equal(context.getState().chromeHidden, false)
})

check("a bare letter reaches the prototype again once the editor is collapsed", () => {
  context.setMode("inspecting")
  context.setChromeHidden(true)
  const event = press({ key: "c" })
  window.dispatchEvent(event)
  assert.equal(store.editorMode(), "inspecting", "the mode must not have changed")
  assert.equal(event.defaultPrevented, false, "the key must be left for the page")
  context.setChromeHidden(false)
})

check("a key the editor answers is taken off the page", () => {
  const event = press({ key: "c" })
  window.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true)
  context.setMode("inspecting")
})

check("⇧⌘\\ toggles the left panel", () => {
  const before = context.getState().layersOpen
  type({ code: "Backslash", mod: true, shift: true })
  assert.equal(context.getState().layersOpen, !before)
  type({ code: "Backslash", mod: true, shift: true })
  assert.equal(context.getState().layersOpen, before)
})

check("⌃⇧? opens the shortcuts sheet and Escape closes it", () => {
  const sheet = () => window.document.querySelector(".de-shortcuts")
  assert.equal(sheet(), null)
  type({ code: "Slash", ctrl: true, shift: true })
  assert.ok(sheet(), "the sheet did not open")
  window.dispatchEvent(press({ key: "Escape" }))
  assert.equal(sheet(), null, "Escape did not close it")
})

check("the sheet is generated from the table, not written out by hand", () => {
  type({ code: "Slash", ctrl: true, shift: true })
  const text = window.document.querySelector(".de-shortcuts").textContent
  for (const shortcut of SHORTCUTS) {
    if (shortcut.owner !== "canvas" && !commands.hasCommand(shortcut.command)) continue
    assert.ok(text.includes(shortcut.label), `the sheet omits ${shortcut.command}`)
  }
  assert.ok(text.includes("⌥1"), "the sheet omits a key it should print")
  window.dispatchEvent(press({ key: "Escape" }))
})

check("a key with nothing behind it is left out of the sheet", () => {
  /*
   * A two-tab panel leaves ⌥3 unregistered and the key falls through to the
   * page, so the row must not be printed — a sheet that advertises a dead key
   * is worse than one that is short.
   */
  const label = SHORTCUTS.find((s) => s.command === "panel.left.tab3").label
  type({ code: "Slash", ctrl: true, shift: true })
  assert.ok(
    window.document.querySelector(".de-shortcuts").textContent.includes(label),
    "a registered slot should be listed"
  )
  window.dispatchEvent(press({ key: "Escape" }))

  drop3()
  type({ code: "Slash", ctrl: true, shift: true })
  assert.equal(
    window.document.querySelector(".de-shortcuts").textContent.includes(label),
    false,
    "an unregistered slot is still advertised in the sheet"
  )
  window.dispatchEvent(press({ key: "Escape" }))
})

check("a chord whose lane is not mounted leaves the key to the page", () => {
  /*
   * The conditional swallow. `select.all` is registered, so take one that is
   * not: the registry answers false and the event must come out uncancelled.
   */
  assert.equal(commands.hasCommand("nothing.here"), false)
  assert.equal(commands.runCommand("nothing.here"), false)
})

// ── Escape, and the order it means things in ───────────────────────────────

/*
 * One key, three meanings, and the ORDER is the feature. A press that collapsed
 * the editor while a sheet was up, or while something was selected, would take
 * away the two things Escape is for. Each case below is one step of the ladder,
 * and the last one is the rung a designer asked for: with nothing left to
 * dismiss, Escape stands the editor down to the disc.
 */
console.log("\nEscape escalates: close, deselect, collapse")

const cta = () => window.document.getElementById("cta")

check("with nothing left to dismiss, Escape collapses the editor", () => {
  context.setChromeHidden(false)
  store.setState({ selection: [], scope: null })
  const event = from(cta())
  assert.equal(context.getState().chromeHidden, true, "Escape did not stand the editor down")
  assert.equal(event.defaultPrevented, true, "the press must be marked as spent")
  context.setChromeHidden(false)
})

check("Escape deselects first, and the editor stays up", () => {
  context.setChromeHidden(false)
  store.setState({ selection: [{ element: cta() }], scope: null })
  from(cta())
  assert.deepEqual(context.getState().selection, [], "the canvas did not clear the selection")
  assert.equal(
    context.getState().chromeHidden,
    false,
    "one press deselected AND collapsed — the ladder has no rungs"
  )
  // And the next one, with nothing left, does collapse.
  from(cta())
  assert.equal(context.getState().chromeHidden, true)
  context.setChromeHidden(false)
})

check("a scope with no selection is still something to clear", () => {
  store.setState({ selection: [], scope: window.document.getElementById("app") })
  from(cta())
  assert.equal(context.getState().scope, null)
  assert.equal(context.getState().chromeHidden, false, "drilling out is not collapsing")
})

check("a surface that took the key keeps it", () => {
  const sheet = () => window.document.querySelector(".de-shortcuts")
  type({ code: "Slash", ctrl: true, shift: true })
  assert.ok(sheet(), "the sheet did not open")
  from(cta())
  assert.equal(sheet(), null, "Escape did not close the sheet")
  assert.equal(
    context.getState().chromeHidden,
    false,
    "closing the sheet also collapsed the editor"
  )
})

check("Escape in a field is the field's", () => {
  const event = from(window.document.getElementById("field"))
  assert.equal(context.getState().chromeHidden, false)
  assert.equal(event.defaultPrevented, false, "the key must be left to the input")
})

check("a collapsed editor gives Escape back to the page", () => {
  context.setChromeHidden(true)
  const event = from(cta())
  assert.equal(event.defaultPrevented, false, "Escape is the prototype's while we are a disc")
  assert.equal(context.getState().chromeHidden, true)
  context.setChromeHidden(false)
})

check("the way back is still ⌘., and Escape is not a second one", () => {
  const survivors = SHORTCUTS.filter((shortcut) => shortcut.everywhere)
  assert.deepEqual(survivors.map((shortcut) => shortcut.command), ["chrome.toggle"])
  assert.equal(keymap.isCollapseFallback(press({ key: "Escape" }), true), false)
  assert.equal(keymap.isCollapseFallback(press({ key: "Escape" }), false), true)
})

// ── The platform ───────────────────────────────────────────────────────────

console.log("\nThe other platform")

check("Windows reads the accelerator as Ctrl", () => {
  platform("Win32")
  try {
    const event = new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true })
    assert.equal(keymap.historyAction(event), "undo")
    const mac = new window.KeyboardEvent("keydown", { key: "z", metaKey: true })
    assert.equal(keymap.historyAction(mac), null, "⌘Z is not a Windows shortcut")
    assert.equal(chordLabel({ key: "." , mod: true }), "Ctrl+.")
  } finally {
    platform("MacIntel")
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
