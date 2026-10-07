/**
 * Every toast in the editor comes out of one surface, in the corner it belongs.
 *
 * The editor used to speak through the vendor's `V`: one fixed div at
 * bottom-left, two seconds, and a `kind` argument it accepted and discarded —
 * so the forty-odd `toast(message, "error")` calls in this package rendered
 * exactly like the successes. Sonner replaces it, and these cases hold the four
 * things that swap can quietly get wrong.
 *
 * SEVERITY SURVIVES. `bridge.toast(msg, "error")` has to reach `toast.error`,
 * not the plain one. This is the regression the old surface shipped with.
 *
 * NOTHING IS DROPPED ON THE WAY UP. Sonner subscribes from a `useEffect`, so a
 * message raised before that effect has run has nobody listening. The queue in
 * `core/toast.ts` covers the gap, and the case below raises a toast BEFORE the
 * toaster is mounted to prove it.
 *
 * THE VENDOR IS MIRRORED, ONCE. Its own messages still come from inside its
 * bundle, and are re-emitted by watching the node it writes into. With the
 * bridge wrapped, our calls never reach that node — so a mirror that fires on
 * our traffic too would double every toast in the editor.
 *
 * THE LIBRARY IS NOT LEFT GLOBAL. Sonner's selectors are unprefixed and its
 * ESM entry appends its stylesheet to `document.head` on import. This editor is
 * loaded into apps it did not write, at least one of which may use Sonner
 * itself, so both the stylesheet and the markup have to stay in the shadow root.
 *
 * jsdom renders no React here on purpose: `installToaster` needs a real
 * reconciler and a real frame loop, and what these cases are about is the
 * PLUMBING around it — which call reaches which library function, what is
 * queued, and what lands in the document. The card's appearance was measured in
 * a browser instead, against the running editor.
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
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
  "Event",
  "CustomEvent",
  "MutationObserver",
  "ShadowRoot",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = (fn) => window.setTimeout(() => fn(Date.now()), 0)

/**
 * Sonner is replaced by a recorder, and that is the point of the suite.
 *
 * These cases are about the editor's own plumbing — which library call each
 * `kind` reaches, and what is held back until the subscription exists. Letting
 * the real library run would test React's scheduler instead, and would need a
 * DOM that jsdom does not provide (`ResizeObserver`, layout, `matchMedia`).
 * The stub is shaped exactly like the two entry points `core/toast.ts` uses.
 */
const calls = []
const stub = `
  const calls = globalThis.__toastCalls
  const toast = Object.assign(
    (message, options) => calls.push({ fn: "toast", message, options }),
    {
      error: (message, options) => calls.push({ fn: "error", message, options }),
      info: (message, options) => calls.push({ fn: "info", message, options }),
      dismiss: (id) => calls.push({ fn: "dismiss", id }),
    }
  )
  export { toast }
  export function Toaster(props) {
    // Its own list, not \`calls\`: the message cases reset \`calls\` between
    // assertions, and the single mount happens once, before most of them.
    globalThis.__toasterMounts.push(props)
    return null
  }
`
globalThis.__toastCalls = calls
globalThis.__toasterMounts = []

/*
 * A React stub small enough to reason about, and it has to RENDER.
 *
 * The first version of this only recorded the element tree, and every case
 * failed with "the Toaster was never rendered" — because a component is a
 * function React calls, and nothing was calling it. So `render` walks the tree
 * and invokes each function element, which is what makes the Toaster's props
 * observable and what makes `ReadyGate` reach `useEffect` at all.
 *
 * Effects are queued rather than run, exactly as React queues passive effects
 * past the commit. That separation is the whole subject of the first case: the
 * tree is committed, the subscription does not exist yet, and a message raised
 * in that window must be held.
 */
const reactStub = `
  export const Fragment = "Fragment"
  export function createElement(type, props, ...children) {
    return { __element: true, type, props: props || {}, children }
  }
  export function useEffect(fn) { globalThis.__toastEffects.push(fn) }
  function renderTree(node) {
    if (Array.isArray(node)) { for (const child of node) renderTree(child); return }
    if (!node || typeof node !== "object" || !node.__element) return
    if (typeof node.type === "function") { renderTree(node.type(node.props)); return }
    renderTree(node.children)
  }
  export function createRoot() {
    return { render: (tree) => renderTree(tree), unmount() {} }
  }
`

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `export { notify, retract, installToaster, mirrorVendorToasts, classifyVendorToast, splitToast } from "./src/core/toast"
      export { toasterCss } from "./src/core/css/toast"`,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
  plugins: [
    {
      name: "stub-sonner",
      setup(b) {
        b.onResolve({ filter: /^sonner$/ }, () => ({ path: "sonner", namespace: "stub" }))
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stub, loader: "js" }))
        // React is never rendered here, but the module graph still imports it.
        for (const name of [/^react$/, /^react-dom\/client$/]) {
          b.onResolve({ filter: name }, (args) => ({ path: args.path, namespace: "react-stub" }))
        }
        b.onLoad({ filter: /.*/, namespace: "react-stub" }, () => ({
          contents: reactStub,
          loader: "js",
        }))
      },
    },
  ],
})
globalThis.__toastEffects = []

const editor = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)
const { notify, retract, installToaster, mirrorVendorToasts, classifyVendorToast, splitToast, toasterCss } = editor

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

/** Runs the effects React would have flushed after committing the tree. */
const flushEffects = () => {
  for (const fn of globalThis.__toastEffects.splice(0)) fn()
}

const emitted = () => calls.filter((c) => ["toast", "info", "error"].includes(c.fn))
const tick = () => new Promise((resolve) => window.setTimeout(resolve, 0))

/** Just the editor's overrides — everything after Sonner's own stylesheet. */
const overridesCss = toasterCss.slice(toasterCss.indexOf(":host { display: contents; }"))

/**
 * The overrides with every `var(…)` expression taken out, fallbacks and all.
 *
 * Every token in `core/tokens.ts` is `var(--de-x, #literal)` — the literal is
 * the fallback, and it is the token's own business. A naive scan for `#` in the
 * stylesheet therefore reports 14 colours in a file that hard-codes none, which
 * is what the first version of the colour case did. Removing the `var()` groups
 * first leaves exactly the colours this file states on its own behalf, which is
 * the set that should be empty.
 *
 * Written as a balanced-paren walk rather than a regex because the fallbacks
 * contain `color-mix(in srgb, …)`, which nests.
 */
function stripVars(css) {
  let out = ""
  for (let i = 0; i < css.length; i += 1) {
    if (!css.startsWith("var(", i)) {
      out += css[i]
      continue
    }
    let depth = 0
    let j = i + 3
    for (; j < css.length; j += 1) {
      if (css[j] === "(") depth += 1
      else if (css[j] === ")") {
        depth -= 1
        if (depth === 0) break
      }
    }
    i = j
  }
  return out
}

/* ---------------------------------------------------------------------- */
console.log("\nThe toast is Sonner, in the editor's own corner")

await check("a message raised before the toaster exists is queued, not lost", async () => {
  calls.length = 0
  notify("Applying 3 changes\u2026")
  // `installToaster` ran inside `notify`, which also loads the React half —
  // nothing else does. It renders once that lazy `import()` resolves, and
  // Sonner's subscription exists only once the effects flush.
  assert.equal(emitted().length, 0, "a queued toast was emitted before anything was listening")
  await tick()
  assert.equal(globalThis.__toasterMounts.length, 1, "the first notify did not load the toaster")
  assert.equal(emitted().length, 0, "a queued toast was emitted before anything was listening")
  flushEffects()
  assert.deepEqual(
    emitted().map((c) => [c.fn, c.message]),
    [["toast", "Applying 3 changes\u2026"]],
    "the queued message did not arrive once the subscription existed"
  )
})

await check("an error keeps its severity all the way to the library", () => {
  calls.length = 0
  notify("Could not resolve source files for these changes", "error")
  assert.deepEqual(
    emitted().map((c) => c.fn),
    ["error"],
    "an error toast was emitted through the plain, untyped call"
  )
})

await check("plain news does not come out as an error", () => {
  calls.length = 0
  notify("Copied 2 notes")
  // The UNTYPED call, which draws no glyph: only an error carries an icon, so
  // the one card that matters is the one that looks different.
  assert.deepEqual(emitted().map((c) => c.fn), ["toast"])
})

await check("a two-part message becomes a concise title over a body", () => {
  calls.length = 0
  notify("Could not write the changes. Check the designlayer terminal, then try again", "error")
  const [card] = emitted()
  assert.equal(card.message, "Could not write the changes")
  assert.equal(card.options.description, "Check the designlayer terminal, then try again.")
})

await check("an explicit title and body pass through untouched", () => {
  calls.length = 0
  notify({ title: "Default not saved", description: "Radius is set here. Try again." }, "error")
  const [card] = emitted()
  assert.deepEqual([card.message, card.options.description], ["Default not saved", "Radius is set here. Try again."])
})

await check("the split: sentence end, ellipsis, em dash, or none", () => {
  assert.deepEqual(splitToast("Copied JSX"), { title: "Copied JSX" })
  assert.deepEqual(splitToast("Applying 3 changes\u2026"), { title: "Applying 3 changes\u2026" })
  assert.deepEqual(splitToast("Nothing to copy. Pin a note or make an edit first."), {
    title: "Nothing to copy",
    description: "Pin a note or make an edit first.",
  })
  assert.deepEqual(splitToast("Delivered to your coding agent \u2014 it was waiting"), {
    title: "Delivered to your coding agent",
    description: "It was waiting.",
  })
  assert.deepEqual(splitToast("Wrote 3 to src/app.component.html"), { title: "Wrote 3 to src/app.component.html" })
})

/*
 * AN ERROR WAITS TO BE DISMISSED; NEWS DOES NOT.
 *
 * This used to assert only that an error was given LONGER than news, which the
 * old 6000 against 4000 satisfied — and six seconds is still a deadline. 52 of
 * this product's 77 error states exist only as a toast, and every one of those
 * sentences now ends in an instruction, so the clause most likely never to be
 * read was the one naming what to do. An unread instruction with the preview
 * still showing an unwritten change is the failure; two extra seconds was not a
 * fix for it.
 *
 * Both halves are asserted because either alone is a defect. An error that
 * never leaves and offers no way out parks over the corner of the canvas
 * forever, so the close button is not a nicety here — it is what makes the
 * infinite duration safe.
 */
await check("an error waits to be dismissed, and news still goes away by itself", () => {
  calls.length = 0
  notify("Applied 3 changes")
  notify("That fix could not be written", "error")
  const [info, error] = emitted()
  assert.ok(
    Number.isFinite(info.options.duration),
    `news sits at ${info.options.duration}ms — only a failure should wait for the reader`
  )
  assert.ok(
    !Number.isFinite(error.options.duration),
    `an error expires after ${error.options.duration}ms, taking its instruction with it`
  )
})



await check("a named card can be taken back once it is showing", () => {
  calls.length = 0
  notify({ title: "Waiting for the app\u2026", id: "boot-wait" })
  assert.equal(emitted()[0].options.id, "boot-wait", "the id did not reach the library")
  retract("boot-wait")
  assert.deepEqual(calls.filter((c) => c.fn === "dismiss"), [{ fn: "dismiss", id: "boot-wait" }])
})

await check("an empty message says nothing at all", () => {
  calls.length = 0
  notify("   ")
  notify("")
  assert.deepEqual(emitted(), [], "the editor raised a toast with no words in it")
})

/* ---------------------------------------------------------------------- */
console.log("\nThe corner, and the props that decide it")

/*
 * Captured from the ONE mount, not re-taken per case. `installToaster` is
 * idempotent by design — `notify` calls it on every message — so a second call
 * returns early and renders nothing, and asking it to re-render for each
 * assertion would test the wrong thing.
 */
const toasterProps = (() => {
  const mounts = globalThis.__toasterMounts
  assert.equal(mounts.length, 1, `the Toaster was mounted ${mounts.length} times, not once`)
  return mounts[0]
})()

await check("it is mounted bottom-right", () => {
  assert.equal(toasterProps.position, "bottom-right")
})

await check("it stacks above the launcher and lines up with the panel gutter", () => {
  // The launcher shares this corner (`css/launcher.ts` pins the disc there) and
  // is the only way back once the chrome is hidden, so the stack must clear it:
  // 32 inset + 40 disc + 8 gap on the bottom, the panels' 12 on the right.
  assert.deepEqual(toasterProps.offset, { bottom: 80, right: 12 })
})

/*
 * The other half of the infinite error duration, and the reason it is safe.
 *
 * This was `false`, on the note that a toast this short is read in one glance
 * and gone before a close button could be aimed at. True while every toast
 * expired; not true of an error that now waits. A card that never leaves and
 * offers no way out parks over the bottom-right corner of the canvas until
 * something else happens to dismiss it.
 */
await check("a toast that waits for the reader can still be got rid of", () => {
  assert.equal(
    toasterProps.closeButton,
    true,
    "an error waits indefinitely, so a card with no close control never leaves"
  )
})

await check("it never stacks more cards than can be read", () => {
  assert.ok(toasterProps.visibleToasts <= 3)
})

await check("its width is set where Sonner will actually obey it", () => {
  // Sonner writes `--width` inline on the section from this prop, so a
  // stylesheet cannot reach it — the value has to travel as a prop.
  assert.equal(toasterProps.style["--width"], "300px")
  assert.ok(
    !/^\s*--width\s*:/m.test(overridesCss),
    "the editor's own overrides set --width, where an inline value beats it"
  )
})

/* ---------------------------------------------------------------------- */
console.log("\nThe card's layout, and the stack built from its height")

/*
 * Sonner measured each card with `getBoundingClientRect()`, which includes the
 * entrance `scale(0.96)` the card wears at that moment — so a 40px card was
 * recorded as 38.4px, and the collapsed stack peeked 5.4px then 7.0px. The
 * patch in `tools/sonner-plugin.mjs` swaps in the layout height. Compiled
 * against the real package, so a Sonner bump that moves the needle fails here.
 */
await check("Sonner measures a card by its layout height, not its transformed box", async () => {
  const { patchSonner } = await import("../tools/sonner-plugin.mjs")
  const out = await build({
    stdin: { contents: `export * from "sonner"`, resolveDir: PACKAGE_DIR, loader: "js" },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    external: ["react", "react-dom"],
    plugins: [patchSonner],
  })
  const code = out.outputFiles[0].text
  assert.ok(!code.includes("toastNode.getBoundingClientRect().height"), "a measurement still reads through the transform")
  assert.equal(code.split("toastNode.offsetHeight").length - 1, 2, "both of Sonner's height measurements should be patched")
})

/*
 * The glyph centres on the TITLE, including a title that wraps. That needs the
 * title and the glyph in one grid row, so the content column is dissolved —
 * and a dissolved column has no box for Sonner's `> *` opacity rule, so the
 * text on the cards behind the front one has to be hidden by its own rule.
 */
await check("the glyph shares the title's grid row, and hidden cards hide their text", () => {
  const css = overridesCss.replace(/\/\*[\s\S]*?\*\//g, "")
  assert.match(css, /\[data-content\] \{ display: contents; \}/, "the content column still boxes the title away from the glyph")
  assert.match(css, /\[data-icon\] \{\s*grid-area: 1 \/ 1;/, "the glyph is not in the title's row")
  assert.match(css, /\[data-title\] \{\s*grid-area: 1 \/ 2;/, "the title is not in the first row")
  assert.match(
    css,
    /\[data-expanded='false'\]\[data-front='false'\]\[data-styled='true'\] \[data-content\] > \* \{\s*opacity: 0;/,
    "text on the cards behind the front one would show through"
  )
})

/* ---------------------------------------------------------------------- */
console.log("\nThe library stays inside the shadow root")

await check("the editor ships Sonner's stylesheet rather than retyping it", () => {
  assert.ok(
    toasterCss.includes("[data-sonner-toast][data-styled='true']"),
    "Sonner's own stylesheet is missing from what the toaster mounts"
  )
})

await check("the overrides come after the library, which is what makes them win", () => {
  const library = toasterCss.indexOf("[data-sonner-toaster][data-sonner-theme='light']")
  const ours = toasterCss.indexOf("[data-sonner-toaster][data-sonner-theme] {")
  assert.ok(library !== -1 && ours !== -1, "one of the two palettes is missing")
  assert.ok(ours > library, "the editor's palette is declared before Sonner's, so Sonner wins")
})

await check("every colour it paints with is a design-system token", () => {
  // Sonner's own palette is full of `hsl(…)`; this is about what OUR half says.
  // Comments are dropped first — several of them QUOTE the library's hard-coded
  // `#3f3f3f` and `rgba(0,0,0,0.2)` to say why the rule below replaces them,
  // and a scanner that cannot tell a citation from a declaration is no use.
  const stated = stripVars(overridesCss.replace(/\/\*[\s\S]*?\*\//g, ""))
  const literals = stated.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []
  assert.deepEqual(literals, [], `the overrides hard-code colour: ${literals.join(", ")}`)
  for (const token of ["--de-color-bg-raised", "--de-color-text", "--de-color-danger"]) {
    assert.ok(overridesCss.includes(token), `the overrides never reach for ${token}`)
  }
})

await check("it wears the chrome's own corner, not Sonner's square one", () => {
  assert.ok(
    /corner-shape:\s*superellipse\(2\)/.test(toasterCss),
    "the toast does not get the squircle every other corner in the chrome has"
  )
})

await check("nothing of Sonner's is left in the host document", () => {
  // `build.mjs` neuters the `__insertCSS` that Sonner's ESM entry runs on
  // import; this is the assertion that the host's head stays clean. The plugin
  // itself is proved by `bundle-freshness`, which compiles the real thing.
  const leaked = [...window.document.head.querySelectorAll("style")].filter((node) =>
    (node.textContent || "").includes("data-sonner-toaster")
  )
  assert.deepEqual(leaked, [], "Sonner's stylesheet was appended to the host document")
})

/* ---------------------------------------------------------------------- */
console.log("\nThe vendor's own toasts, mirrored exactly once")

const vendorRoot = () => {
  const host = window.document.createElement("div")
  host.id = "react-rewrite-root"
  window.document.body.append(host)
  const root = host.attachShadow({ mode: "open" })
  const node = window.document.createElement("div")
  node.className = "toast"
  root.append(node)
  return { root, node, dispose: () => host.remove() }
}

await check("a vendor message is re-emitted through ours", async () => {
  const { root, node, dispose } = vendorRoot()
  const release = mirrorVendorToasts(root)
  calls.length = 0
  node.textContent = "Reorder failed"
  node.classList.add("visible")
  await tick()
  assert.deepEqual(
    emitted().map((c) => c.message),
    ["Reorder failed"],
    "the vendor's message never reached our toast"
  )
  release()
  dispose()
})

await check("the same message showing twice is said twice", async () => {
  const { root, node, dispose } = vendorRoot()
  const release = mirrorVendorToasts(root)
  node.textContent = "Reorder failed"
  node.classList.add("visible")
  await tick()
  node.classList.remove("visible")
  await tick()
  calls.length = 0
  node.classList.add("visible")
  await tick()
  assert.equal(emitted().length, 1, "a repeat of the same vendor message was swallowed")
  release()
  dispose()
})

await check("a message that is still up is not repeated on every mutation", async () => {
  const { root, node, dispose } = vendorRoot()
  const release = mirrorVendorToasts(root)
  node.textContent = "Reorder failed"
  node.classList.add("visible")
  await tick()
  calls.length = 0
  // The vendor re-adds the class on a second raise; `DOMTokenList.add` of a
  // token already present writes nothing, but other mutations still arrive.
  node.classList.add("visible")
  node.setAttribute("data-noise", "1")
  await tick()
  assert.deepEqual(emitted(), [], "the mirror repeated a toast that was already up")
  release()
  dispose()
})

await check("a hidden vendor toast says nothing", async () => {
  const { root, node, dispose } = vendorRoot()
  const release = mirrorVendorToasts(root)
  calls.length = 0
  // Text without the visible class is the vendor priming the node, not showing it.
  node.textContent = "Not shown"
  await tick()
  assert.deepEqual(emitted(), [], "the mirror spoke for a toast the vendor never showed")
  release()
  dispose()
})

await check("releasing the mirror stops it", async () => {
  const { root, node, dispose } = vendorRoot()
  const release = mirrorVendorToasts(root)
  release()
  calls.length = 0
  node.textContent = "After release"
  node.classList.add("visible")
  await tick()
  assert.deepEqual(emitted(), [], "a released mirror is still listening")
  dispose()
})

/*
 * The vendor's `V` drops its kind, so the mirror recovers it from the words —
 * and stays silent for the two messages the vendor raises for direct
 * manipulation. Every sentence in the pinned `react-rewrite-cli@0.1.1` overlay
 * is listed, so a reclassification is a visible diff here.
 */
await check("vendor messages keep their severity, and direct manipulation is silent", () => {
  const expected = {
    "Undo: Set width": null,
    "Everything reset": null,
    "Can't reorder this element": "error",
    "Could not resolve source files for these changes \u2014 try re-selecting": "error",
    "Dev server disconnected": "error",
    "Disconnected: another tab took over": "error",
    "Disconnected. Click to reconnect.": "error",
    "Couldn't find Card": "error",
    "Error: Batch apply failed": "error",
    "Revert failed: file changed": "error",
    "Applied 2/3 \u2014 1 failed": "error",
    "Dev server reconnected": "info",
    "Applied 3/3 changes": "info",
    "Applying 3 changes...": "info",
    "Component Card removed \u2014 move cleared": "info",
    "Nothing to confirm \u2014 make some visual changes first": "info",
    "Operation in progress": "info",
  }
  const actual = Object.fromEntries(Object.keys(expected).map((text) => [text, classifyVendorToast(text)]))
  assert.deepEqual(actual, expected)
})

await check("a silent vendor message never reaches the corner", async () => {
  const { root, node, dispose } = vendorRoot()
  const release = mirrorVendorToasts(root)
  calls.length = 0
  node.textContent = "Undo: Set width"
  node.classList.add("visible")
  await tick()
  assert.deepEqual(emitted(), [], "the vendor's undo report was mirrored")
  node.classList.remove("visible")
  node.textContent = "Can't reorder this element"
  node.classList.add("visible")
  await tick()
  assert.deepEqual(emitted().map((c) => [c.fn, c.message]), [["error", "Can't reorder this element"]])
  release()
  dispose()
})

// Last, because it tears the one mount down to get a fresh queue.
await check("a named card still queued is dropped, and the rest still arrive", async () => {
  const release = installToaster()
  release()
  await tick()
  calls.length = 0
  globalThis.__toastEffects.length = 0
  notify({ title: "Waiting for the app\u2026", id: "boot-wait" })
  notify("Copied JSX")
  retract("boot-wait")
  await tick()
  flushEffects()
  assert.deepEqual(emitted().map((c) => c.message), ["Copied JSX"], "a retracted card still came out of the queue")
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
