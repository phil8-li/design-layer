import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

import { PACKAGE_DIR } from "./host.mjs"
const dom = new JSDOM(
  "<!doctype html><html><body><main><section id='host'></section></main></body></html>",
  { pretendToBeVisual: true }
)
const { window } = dom
for (const key of [
  "window",
  "document",
  "Element",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `export * from "./src/core/host-readiness"`,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const readiness = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

assert.equal(readiness.hasHydratedReactHost(), false)

const editorRoot = document.createElement("div")
editorRoot.setAttribute("data-designlayer", "")
Object.defineProperty(editorRoot, "__reactFiber$editor", { value: {} })
document.body.prepend(editorRoot)
assert.equal(readiness.hasHydratedReactHost(), false)

const nextPortal = document.createElement("nextjs-portal")
const portalChild = document.createElement("div")
Object.defineProperty(portalChild, "__reactProps$dev-overlay", { value: {} })
nextPortal.append(portalChild)
document.body.prepend(nextPortal)
assert.equal(readiness.hasHydratedReactHost(), false)

const pending = readiness.whenHostHydrated(1_000)
Object.defineProperty(document.getElementById("host"), "__reactFiber$fixture", { value: {} })
await pending
assert.equal(readiness.hasHydratedReactHost(), true)

/*
 * An Angular host leaves a different mark, and asking React's question of it
 * is not a harmless miss: nothing in an Angular page ever grows a
 * `__reactFiber$`, so the poll ran its full timeout on every load and the
 * editor appeared ten seconds after the app did. It worked, so nothing failed
 * — it was merely slow enough to feel broken.
 */
assert.equal(
  readiness.hasHydratedReactHost(document, "angular"),
  false,
  "a React expando was mistaken for an Angular bootstrap"
)

const angularRoot = document.createElement("app-root")
angularRoot.setAttribute("ng-version", "22.0.5")
document.body.append(angularRoot)
assert.equal(
  readiness.hasHydratedReactHost(document, "angular"),
  true,
  "ng-version did not read as a bootstrapped Angular host"
)

/*
 * The scan has a budget, and `<head>` used to eat it. Breadth-first from
 * `<html>`, every child of `<head>` came before the children of the app's
 * container — and Vite or Emotion in dev put one `<style>` there per CSS
 * import or per rule. 130 of them hid a claimed element one level under the
 * container, and boot waited out the full ten-second timeout.
 */
{
  const page = new JSDOM(
    `<!doctype html><html><head>${"<style></style>".repeat(130)}</head>` +
      `<body><div id="root"><div id="app"></div></div></body></html>`
  ).window.document
  Object.defineProperty(page.getElementById("app"), "__reactFiber$fixture", { value: {} })
  assert.equal(
    readiness.hasHydratedReactHost(page, "react"),
    true,
    "a hundred <style>s in <head> spent the scan budget before it reached the app"
  )
}

/*
 * A client-rendered root has nothing to hydrate, so the editor mounts in the
 * task that committed it: the claim is heard by an observer, not a frame poll,
 * and no paint is waited for. A root that may still be hydrating — one whose
 * HostRoot is dehydrated, or the App Router's `document` — keeps the two-paint
 * wait. These run with frames that never come, so a wait shows up as a hang.
 */
{
  const install = (html) => {
    const page = new JSDOM(html, { pretendToBeVisual: true }).window
    for (const key of ["window", "document", "Element", "MutationObserver"]) {
      Object.defineProperty(globalThis, key, { value: page[key], configurable: true, writable: true })
    }
    let frames = 0
    globalThis.requestAnimationFrame = () => ++frames
    return { page, frames: () => frames }
  }
  const settledWithin = (promise, ms) =>
    Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))])
  const claim = (container, isDehydrated) => {
    Object.defineProperty(container, "__reactContainer$fixture", {
      value: { stateNode: { current: { memoizedState: { element: null, isDehydrated } } } },
    })
    const app = container.ownerDocument.createElement("main")
    Object.defineProperty(app, "__reactFiber$fixture", { value: {} })
    return app
  }

  const csr = install("<!doctype html><html><body><div id='root'></div><script></script></body></html>")
  assert.equal(readiness.hasServerMarkup(), false, "an empty container read as server markup")
  const mounted = readiness.whenHostHydrated(1_000)
  const root = document.getElementById("root")
  root.append(claim(root, false))
  assert.equal(await settledWithin(mounted, 200), true, "a client-rendered commit waited for a frame")
  assert.equal(csr.frames(), 0, "a client-rendered page polled frames while it loaded")

  install("<!doctype html><html><body><div id='root'></div></body></html>")
  const dehydrated = readiness.whenHostHydrated(1_000)
  const partial = document.getElementById("root")
  partial.append(claim(partial, true))
  assert.equal(await settledWithin(dehydrated, 200), false, "a dehydrated root skipped the paint wait")

  install("<!doctype html><html><body><div id='root'></div></body></html>")
  Object.defineProperty(document, "__reactContainer$fixture", { value: {} })
  const appRouter = readiness.whenHostHydrated(1_000)
  const body = document.getElementById("root")
  body.append(claim(body, false))
  assert.equal(await settledWithin(appRouter, 200), false, "a document-level root skipped the paint wait")

  install("<!doctype html><html><body><div id='__next'><h1>Server page</h1></div></body></html>")
  assert.equal(readiness.hasServerMarkup(), true, "a server-rendered page read as empty")
  install("<!doctype html><html><body><noscript>Enable JavaScript</noscript><div id='root'></div></body></html>")
  assert.equal(readiness.hasServerMarkup(), false, "<noscript> text read as server markup")
}

console.log("13 passed, 0 failed")
