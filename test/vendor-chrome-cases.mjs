/**
 * The vendor's UI stays down — on the first frame, and after a re-mount.
 *
 * Two bugs are pinned here, both of which put another tool's toolbar on screen
 * in a product whose entire job is to be the tool you are looking at.
 *
 * TIMING. The suppression stylesheet has to be inside `#react-rewrite-root`'s
 * shadow root, because a shadow boundary blocks selectors. The old injector ran
 * from `mountShell`, which waits on the bridge and on host hydration first, and
 * measured 49ms behind the vendor's own paint on a warm local reload. So the
 * assertion here is not "the style arrives" — it is that it arrives inside the
 * `attachShadow` call itself, with no frame, timer or microtask in between.
 * `sameTick` below is the whole point of the case.
 *
 * REPAIR. The old injector only started a watcher if its FIRST attempt failed,
 * so on the common path nothing was watching: a vendor re-mount dropped the
 * style and the chrome came back for the rest of the session. A re-mount is
 * cheap to simulate and is the only case here that needs to await anything,
 * because `MutationObserver` delivers on a microtask.
 */

import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const { window } = dom

for (const key of ["window", "document", "Node", "Element", "HTMLElement", "MutationObserver"]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `export { installVendorChromeSuppression } from "./src/shell/vendor-chrome"
      export { vendorChromeCss } from "./src/core/css"`,
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
const { installVendorChromeSuppression, vendorChromeCss } = editor

const STYLE_ID = "designlayer-vendor-suppression"
const HOST_ID = "react-rewrite-root"

let failures = 0
let release = null

async function check(name, run) {
  try {
    await run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  } finally {
    release?.()
    release = null
    window.document.getElementById(HOST_ID)?.remove()
  }
}

/** Mounts the vendor's root exactly the way its bundle does: id, append, attach. */
const mountVendorRoot = () => {
  const host = window.document.createElement("div")
  host.id = HOST_ID
  window.document.body.appendChild(host)
  return host.attachShadow({ mode: "open" })
}

const styleIn = (root) => root.getElementById(STYLE_ID)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

console.log("\nvendor chrome suppression")

await check("the stylesheet lands inside attachShadow, not a frame later", () => {
  release = installVendorChromeSuppression()

  const host = window.document.createElement("div")
  host.id = HOST_ID
  window.document.body.appendChild(host)

  // Nothing between these two lines: if the style is only there after a timer,
  // a microtask or a frame, this is the assertion that fails.
  const root = host.attachShadow({ mode: "open" })
  const sameTick = styleIn(root)

  assert.ok(sameTick, "no suppression stylesheet after attachShadow returned")
  assert.equal(sameTick.textContent, vendorChromeCss)
})

await check("it goes in the shadow root, where it can actually reach the chrome", () => {
  release = installVendorChromeSuppression()
  const root = mountVendorRoot()

  assert.ok(styleIn(root), "style is not in the shadow root")
  assert.equal(
    window.document.getElementById(STYLE_ID),
    null,
    "the copy that matters must not be in the document, which cannot cross the boundary"
  )
  // The nine surfaces from `css/base.ts`, spot-checked at both ends of the list.
  for (const selector of [".toolbar", ".prop-sidebar", ".tools-panel", ".marquee-box"]) {
    assert.ok(vendorChromeCss.includes(selector), `${selector} is not suppressed`)
  }
  assert.ok(vendorChromeCss.includes("display: none !important"))
})

await check("a root that already exists when we install is adopted", () => {
  const root = mountVendorRoot()
  assert.equal(styleIn(root), null, "precondition: nothing has suppressed it yet")

  release = installVendorChromeSuppression()
  assert.ok(styleIn(root), "an already-mounted vendor was left visible")
})

await check("a style torn out of the root is put back", async () => {
  release = installVendorChromeSuppression()
  const root = mountVendorRoot()

  styleIn(root).remove()
  assert.equal(styleIn(root), null, "precondition: the style is gone")

  await tick()
  assert.ok(styleIn(root), "removal was permanent — the old injector's bug")
})

await check("a vendor re-mount gets its own suppression", async () => {
  release = installVendorChromeSuppression()
  const first = mountVendorRoot()
  assert.ok(styleIn(first))

  window.document.getElementById(HOST_ID).remove()
  const second = mountVendorRoot()

  assert.notEqual(first, second, "precondition: this is a different root")
  assert.ok(styleIn(second), "the re-mounted vendor kept its UI")

  // The observer must have followed the new root rather than stayed on the dead
  // one: repair it and see that the LIVE root is the one being watched.
  styleIn(second).remove()
  await tick()
  assert.ok(styleIn(second), "the watcher is still pointed at the discarded root")
})

await check("everybody else's shadow roots are left alone", () => {
  release = installVendorChromeSuppression()

  const other = window.document.createElement("div")
  other.id = "some-host-web-component"
  window.document.body.appendChild(other)
  const root = other.attachShadow({ mode: "open" })

  assert.equal(
    styleIn(root),
    null,
    "a display:none for .toolbar was injected into an unrelated component"
  )
  other.remove()
})

await check("releasing puts attachShadow back and takes the style out", () => {
  const before = window.Element.prototype.attachShadow
  const dispose = installVendorChromeSuppression()
  assert.notEqual(window.Element.prototype.attachShadow, before, "precondition: it is hooked")

  const root = mountVendorRoot()
  assert.ok(styleIn(root))

  dispose()
  assert.equal(window.Element.prototype.attachShadow, before, "the hook outlived the install")
  assert.equal(styleIn(root), null, "the style outlived the install")
})

await check("a second install does not stack a second hook", () => {
  const before = window.Element.prototype.attachShadow
  const first = installVendorChromeSuppression()
  const hooked = window.Element.prototype.attachShadow
  const second = installVendorChromeSuppression()

  assert.equal(second, first, "a second call handed back a different disposer")
  assert.equal(window.Element.prototype.attachShadow, hooked, "the hook was applied twice")

  first()
  assert.equal(window.Element.prototype.attachShadow, before)
})

console.log(failures === 0 ? "\nvendor chrome: all cases pass" : `\nvendor chrome: ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
