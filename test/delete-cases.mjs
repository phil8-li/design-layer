/**
 * Deleting an element: the key, the command, and the two source writers.
 *
 * Delete is the first operation in this editor that takes markup AWAY, and
 * nothing that came before it is shaped for that. Every other write finds a
 * node and rewrites part of it, so every other write can be undone by writing
 * the old value back over the new one. A deletion has to remember where the
 * element was, and a source deletion has to cut a byte range that is correct at
 * both ends — one character short at the close tag and the file stops parsing.
 *
 * So the four layers are asserted separately and against the real thing:
 *
 *   The key      — Delete and Backspace, and nothing wearing a modifier.
 *   The command  — the writer, in jsdom, including undo putting the element
 *                  back between the same two siblings it came from.
 *   Angular      — a real template on disk, spliced by `angular-source.mjs`.
 *   React        — a real .tsx on disk, spliced by `react-source.mjs`.
 *
 * The refusals are cases, not omissions. Both writers are allowed to decline —
 * on an ambiguous match, on an element whose removal would leave code that does
 * not parse — and every decline has to stay a decline, because the alternative
 * is deleting something the user was not looking at.
 *
 * Usage: node designlayer/test/delete-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { JSDOM } from "jsdom"

import { resolveConfig } from "../config.mjs"
import { createAngularSource } from "../server/angular-source.mjs"
import { createReactSource } from "../server/react-source.mjs"
import { createDesignLayerRoutes } from "../server/routes.mjs"
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

/* -------------------------------------------------------------------------
 * The browser half
 * ---------------------------------------------------------------------- */

const PAGE = `<!doctype html><html><body><main id="app">
<section class="card" id="card">
  <h2 class="card__title">Title</h2>
  <p class="card__body">One</p>
  <p class="card__body">Two</p>
</section>
</main></body></html>`

const dom = new JSDOM(PAGE, { pretendToBeVisual: true, url: "http://localhost/" })
const { window } = dom
Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true })
window.document.elementsFromPoint = () => []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
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
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

/** One bundle: the queue and the timeline are module state every lane shares. */
const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createWriter } from "./src/core/writer"
      export { canvasAction } from "./src/core/keymap"
      export * as history from "./src/core/history"
      export * as removal from "./src/core/removal"
      export * as prompt from "./src/core/change-prompt"
      export * as store from "./src/core/store"
      export { isLayerCandidate } from "./src/core/resolve"
      export { DELETED_ATTRIBUTE } from "./src/core/dom"
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
const { history, removal, prompt, store, isLayerCandidate, DELETED_ATTRIBUTE } = editor

/** What every surface means by "gone": not a layer, and not painted. */
const isGone = (element) =>
  !isLayerCandidate(element) &&
  element.hasAttribute(DELETED_ATTRIBUTE) &&
  element.style.getPropertyValue("display") === "none"

const toasts = []
const bridge = {
  elementInfo: () => null,
  send() {},
  toast: (message, kind) => toasts.push({ message, kind }),
  subscribe: () => () => {},
  refreshGeometry() {},
  store: {
    hasChanges: () => false,
    buildBatchOperations: () => [],
    onStateChange() {},
    addPendingPropertyOperation() {},
  },
}
const writer = editor.createWriter(bridge)

const document = window.document
const describe = (element) => ({
  element,
  tagName: element.tagName.toLowerCase(),
  componentName: "CardComponent",
  source: { filePath: "src/app/card.tsx", lineNumber: 0, columnNumber: 0, componentName: "Card" },
  key: element.id || element.className,
})

const card = () => document.getElementById("card")
const reset = () => {
  history.resetHistory()
  removal.clearRemovalQueue()
  prompt.clearPreviewOnly()
  toasts.length = 0
  document.getElementById("app").innerHTML =
    '\n<section class="card" id="card">\n' +
    '  <h2 class="card__title">Title</h2>\n' +
    '  <p class="card__body">One</p>\n' +
    '  <p class="card__body">Two</p>\n' +
    "</section>\n"
}

/* ---------------------------------------------------------------------- */
console.log("\nThe key")

const keyEvent = (init) => new window.KeyboardEvent("keydown", init)

check("Delete and Backspace are both the delete action", () => {
  assert.equal(editor.canvasAction(keyEvent({ key: "Delete" })), "delete")
  assert.equal(editor.canvasAction(keyEvent({ key: "Backspace" })), "delete")
})

check("a modifier takes the key back — that chord belongs to a text field", () => {
  assert.equal(editor.canvasAction(keyEvent({ key: "Backspace", metaKey: true })), null)
  assert.equal(editor.canvasAction(keyEvent({ key: "Delete", altKey: true })), null)
})

check("the keys that were already spoken for still answer as themselves", () => {
  assert.equal(editor.canvasAction(keyEvent({ key: "Escape" })), "deselect")
  assert.equal(editor.canvasAction(keyEvent({ key: "Enter" })), "select-child")
})

/* ---------------------------------------------------------------------- */
console.log("\nThe command")

check("the element goes, and one removal is owed to source", () => {
  reset()
  const title = document.querySelector(".card__title")
  writer.applyDelete([describe(title)])

  assert.ok(isGone(title), "the element is still a visible layer")
  assert.equal(removal.removalQueueSize(), 1)
  const [operation] = removal.buildRemovalOperations()
  assert.equal(operation.op, "removeElement")
  assert.equal(operation.target.tagName, "h2")
  assert.deepEqual(operation.target.classes, ["card__title"])
  assert.equal(operation.target.parentTagName, "section")
})

check("the descriptor names the element's real place among its siblings", () => {
  reset()
  // The descriptor is what the server matches a source node against, so a
  // sibling index read off the wrong element deletes the wrong line.
  const second = document.querySelectorAll(".card__body")[1]
  writer.applyDelete([describe(second)])
  const [operation] = removal.buildRemovalOperations()
  assert.equal(operation.target.nthOfType, 1, "the sibling index was read too late")
  assert.deepEqual(operation.target.parentClasses, ["card"])
})

check("the node itself never moves — the framework still owns it", () => {
  reset()
  const middle = document.querySelectorAll(".card__body")[0]
  const parent = middle.parentElement
  const next = middle.nextSibling
  writer.applyDelete([describe(middle)])

  // Detaching it is what killed the page on a live React host: the fibre kept
  // pointing at a parent that no longer held the node, and the next commit
  // threw `NotFoundError` in `removeChild` and unmounted everything.
  assert.equal(middle.parentElement, parent, "the element was detached")
  assert.equal(middle.nextSibling, next, "the element moved")
  assert.equal(card().children.length, 3, "a child left the DOM")
  assert.ok(isGone(middle))
})

check("undo brings it back as a layer, and takes the write back with it", () => {
  reset()
  const middle = document.querySelectorAll(".card__body")[0]
  writer.applyDelete([describe(middle)])

  history.undo()
  assert.ok(isLayerCandidate(middle), "the element is still not a layer")
  assert.equal(middle.style.getPropertyValue("display"), "", "an inline display was left behind")
  assert.equal(removal.removalQueueSize(), 0, "undo left the deletion owed to source")
})

check("redo takes it away again, and owes it again", () => {
  reset()
  const middle = document.querySelectorAll(".card__body")[0]
  writer.applyDelete([describe(middle)])
  history.undo()
  assert.equal(history.redo(), "Delete p.card__body")
  assert.ok(isGone(middle))
  assert.equal(removal.removalQueueSize(), 1)
})

check("an element hidden by the eye comes back hidden, not shown", () => {
  reset()
  const title = document.querySelector(".card__title")
  title.style.setProperty("display", "none")
  writer.applyDelete([describe(title)])
  history.undo()
  // Delete must not quietly undo the other edit standing on this element.
  assert.equal(title.style.getPropertyValue("display"), "none")
  assert.equal(title.style.getPropertyPriority("display"), "")
})

check("deleting a parent and its child is one removal, not two", () => {
  reset()
  const parent = card()
  const child = document.querySelector(".card__title")
  writer.applyDelete([describe(child), describe(parent)])

  assert.ok(isGone(parent))
  assert.equal(removal.removalQueueSize(), 1, "the child was queued inside a range already queued")
  assert.equal(removal.buildRemovalOperations()[0].target.tagName, "section")
})

check("two siblings both go, and both come back", () => {
  reset()
  const [first, second] = document.querySelectorAll(".card__body")
  writer.applyDelete([describe(first), describe(second)])
  assert.ok(isGone(first) && isGone(second))
  assert.equal(removal.removalQueueSize(), 2)

  history.undo()
  assert.ok(isLayerCandidate(first) && isLayerCandidate(second))
  assert.equal(removal.removalQueueSize(), 0)
})

check("a multi-element delete is one step, and says nothing", () => {
  reset()
  const [first, second] = document.querySelectorAll(".card__body")
  writer.applyDelete([describe(first), describe(second)])
  // Direct manipulation: the layers leaving the canvas is the report.
  assert.deepEqual(toasts, [], "a canvas delete raised a toast")
  assert.equal(history.canUndo(), true)
  history.undo()
  assert.equal(history.canUndo(), false, "the two deletions recorded two steps")
})

check("deleting nothing is not a step", () => {
  reset()
  writer.applyDelete([])
  assert.equal(history.canUndo(), false)
  assert.equal(removal.removalQueueSize(), 0)
})

check("an element the app has already dropped is not deleted again", () => {
  reset()
  const title = document.querySelector(".card__title")
  const selection = describe(title)
  title.remove()
  // A row in the layers tree can outlive the element it describes by one frame.
  writer.applyDelete([selection])
  assert.equal(history.canUndo(), false)
  assert.equal(removal.removalQueueSize(), 0)
})

check("a locked layer survives Delete, from the tree as well as the canvas", () => {
  reset()
  const title = document.querySelector(".card__title")
  store.setState({ locked: new Set([title]) })
  writer.applyDelete([describe(title)])
  store.setState({ locked: new Set() })

  assert.ok(document.querySelector(".card__title"), "the lock did not hold")
  assert.equal(removal.removalQueueSize(), 0)
  assert.equal(history.canUndo(), false, "a refused delete recorded a step")
})

check("a deletion with no file behind it lands in the Prompts tab", () => {
  reset()
  const title = document.querySelector(".card__title")
  writer.applyDelete([{ ...describe(title), source: null }])
  // React host, no resolver on this bridge: the file never arrives, so the
  // change is on screen with nothing owed to source — the one place left for it
  // is the ledger the Prompts tab reads.
  return new Promise((resolve) => {
    setTimeout(() => {
      const entries = prompt.previewOnlyChanges()
      assert.equal(entries.length, 1, "the deletion was dropped in silence")
      assert.equal(entries[0].property, "remove")
      assert.match(prompt.buildChangePrompt(), /delete this element/)
      resolve()
    }, 0)
  })
})

/* -------------------------------------------------------------------------
 * The Angular writer
 * ---------------------------------------------------------------------- */

const TEMPLATE = `<section class="card">
  <h2 class="card__title">Welcome</h2>
  <p class="card__body">Body copy</p>
  <img class="card__art" src="a.png" alt="">
  <ul class="card__list">
    <li class="card__item">one</li>
    <li class="card__item">two</li>
  </ul>
  <ul class="card__more">
    <li class="card__item">three</li>
  </ul>
  <p class="card__inline">before <span class="card__pill">pill</span> after</p>
</section>
`

function angularProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-delete-ng-"))
  fs.mkdirSync(path.join(root, "src/app/card"), { recursive: true })
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "host", dependencies: { "@angular/core": "^22.0.0" } })
  )
  fs.writeFileSync(
    path.join(root, "src/app/card/card.component.ts"),
    "import {Component} from '@angular/core';\n" +
      "@Component({\n" +
      "  selector: 'app-card',\n" +
      "  templateUrl: './card.component.html',\n" +
      "})\n" +
      "export class CardComponent {}\n"
  )
  fs.writeFileSync(path.join(root, "src/app/card/card.component.html"), TEMPLATE)
  return root
}

const ngTarget = (tagName, classes, extra = {}) => ({
  tagName,
  classes,
  id: null,
  nthOfType: 0,
  parentTagName: "section",
  parentClasses: ["card"],
  attributes: {},
  ...extra,
})

console.log("\nDeleting from an Angular template")

{
  const root = angularProject()
  const template = path.join(root, "src/app/card/card.component.html")
  const source = createAngularSource(resolveConfig({ projectRoot: root }, { cwd: root }))
  const restore = () => fs.writeFileSync(template, TEMPLATE)
  const remove = (target) =>
    source.apply([{ op: "removeElement", componentName: "CardComponent", target }])

  check("an element and its whole line go, and nothing else moves", () => {
    restore()
    const result = remove(ngTarget("p", ["card__body"]))
    assert.equal(result.failed.length, 0, result.failed[0]?.reason)
    const after = fs.readFileSync(template, "utf8")
    assert.doesNotMatch(after, /card__body/)
    // Not `/^\s*$/m`, which matches the empty string after the file's own final
    // newline and fails on a template that is perfectly fine.
    assert.doesNotMatch(after, /\n[ \t]*\n/, "a blank line was left where the element was")
    assert.match(after, /<h2 class="card__title">Welcome<\/h2>\n {2}<img/)
  })

  check("children go with the element that held them", () => {
    restore()
    const result = remove(
      ngTarget("ul", ["card__list"], { attributes: {}, parentClasses: ["card"] })
    )
    assert.equal(result.failed.length, 0, result.failed[0]?.reason)
    const after = fs.readFileSync(template, "utf8")
    assert.doesNotMatch(after, /card__list/)
    assert.doesNotMatch(after, /one/)
    assert.doesNotMatch(after, /two/)
    assert.match(after, /three/, "the other list went too")
  })

  check("a void element needs no closing tag to be removed", () => {
    restore()
    const result = remove(ngTarget("img", ["card__art"], { attributes: { src: "a.png", alt: "" } }))
    assert.equal(result.failed.length, 0, result.failed[0]?.reason)
    assert.doesNotMatch(fs.readFileSync(template, "utf8"), /card__art/)
  })

  check("an element sharing its line keeps the rest of that line", () => {
    restore()
    const result = remove(
      ngTarget("span", ["card__pill"], { parentTagName: "p", parentClasses: ["card__inline"] })
    )
    assert.equal(result.failed.length, 0, result.failed[0]?.reason)
    const after = fs.readFileSync(template, "utf8")
    assert.match(after, /<p class="card__inline">before {2}after<\/p>/)
  })

  check("an ambiguous element is refused, not guessed at", () => {
    restore()
    // The first `<li class="card__item">` of each list scores identically.
    const result = remove(
      ngTarget("li", ["card__item"], { parentTagName: "ul", parentClasses: [] })
    )
    assert.equal(result.applied.length, 0)
    assert.match(result.failed[0].reason, /no unique <li>/)
    assert.equal(fs.readFileSync(template, "utf8"), TEMPLATE, "the template was written anyway")
  })

  check("two deletions in one template are one rewrite", () => {
    restore()
    const result = source.apply([
      { op: "removeElement", componentName: "CardComponent", target: ngTarget("h2", ["card__title"]) },
      { op: "removeElement", componentName: "CardComponent", target: ngTarget("p", ["card__body"]) },
    ])
    assert.equal(result.applied.length, 2, result.failed[0]?.reason)
    const after = fs.readFileSync(template, "utf8")
    assert.doesNotMatch(after, /card__title/)
    assert.doesNotMatch(after, /card__body/)
    assert.match(after, /card__art/)
  })

  fs.rmSync(root, { recursive: true, force: true })
}

/* -------------------------------------------------------------------------
 * The React writer
 * ---------------------------------------------------------------------- */

const PAGE_TSX = `import { Card } from "./card"

export default function Page({ open }: { open: boolean }) {
  return (
    <main className="page">
      <h1 className="page__title">Overview</h1>
      <section className="panel">
        <p className="panel__body">Body</p>
        <Card className="panel__card" />
      </section>
      {open && <aside className="drawer">Drawer</aside>}
    </main>
  )
}
`

const ROOT_TSX = `export function Solo() {
  return <div className="solo">alone</div>
}
`

function reactProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-delete-react-"))
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "host", dependencies: { next: "^15.0.0", react: "^19.0.0" } })
  )
  fs.writeFileSync(path.join(root, "src/page.tsx"), PAGE_TSX)
  fs.writeFileSync(path.join(root, "src/solo.tsx"), ROOT_TSX)
  return root
}

const jsxTarget = (tagName, classes, extra = {}) => ({
  tagName,
  classes,
  id: null,
  nthOfType: 0,
  parentTagName: null,
  parentClasses: [],
  attributes: {},
  ...extra,
})

console.log("\nDeleting from a React file")

{
  const root = reactProject()
  const page = path.join(root, "src/page.tsx")
  const solo = path.join(root, "src/solo.tsx")
  const react = createReactSource(resolveConfig({ projectRoot: root }, { cwd: root }))
  const restore = () => {
    fs.writeFileSync(page, PAGE_TSX)
    fs.writeFileSync(solo, ROOT_TSX)
  }
  const remove = (filePath, target, extra = {}) =>
    react.remove([{ op: "removeElement", componentName: "Page", filePath, target, ...extra }])

  check("a child element and its line go, and the file still parses as it read", () => {
    restore()
    const result = remove("src/page.tsx", jsxTarget("p", ["panel__body"], {
      parentTagName: "section",
      parentClasses: ["panel"],
    }))
    assert.equal(result.failed.length, 0, result.failed[0]?.reason)
    const after = fs.readFileSync(page, "utf8")
    assert.doesNotMatch(after, /panel__body/)
    assert.match(after, /<section className="panel">\n {8}<Card className="panel__card" \/>/)
    assert.match(after, /import \{ Card \} from ".\/card"/, "the imports were reformatted")
  })

  check("an element with children takes them with it", () => {
    restore()
    const result = remove("src/page.tsx", jsxTarget("section", ["panel"], {
      parentTagName: "main",
      parentClasses: ["page"],
    }))
    assert.equal(result.failed.length, 0, result.failed[0]?.reason)
    const after = fs.readFileSync(page, "utf8")
    assert.doesNotMatch(after, /panel__body/)
    assert.doesNotMatch(after, /panel__card/)
    assert.match(after, /page__title/)
  })

  check("a component's root element is refused — there would be nothing to return", () => {
    restore()
    const result = react.remove([
      { op: "removeElement", componentName: "Solo", filePath: "src/solo.tsx", target: jsxTarget("div", ["solo"]) },
    ])
    assert.equal(result.applied.length, 0)
    assert.match(result.failed[0].reason, /not inside another element/)
    assert.equal(fs.readFileSync(solo, "utf8"), ROOT_TSX)
  })

  check("an element inside a conditional is refused, not left as `{open && }`", () => {
    restore()
    const result = remove("src/page.tsx", jsxTarget("aside", ["drawer"], {
      parentTagName: "main",
      parentClasses: ["page"],
    }))
    assert.equal(result.applied.length, 0)
    assert.match(result.failed[0].reason, /not inside another element/)
    assert.equal(fs.readFileSync(page, "utf8"), PAGE_TSX)
  })

  check("a line number from the browser beats the descriptor", () => {
    restore()
    // Two `<p>` would be ambiguous on classes alone; the resolver's line is the
    // browser's own answer for this exact node, so it decides.
    const result = remove(
      "src/page.tsx",
      jsxTarget("h1", [], { parentTagName: "main", parentClasses: ["page"] }),
      { lineNumber: 6 }
    )
    assert.equal(result.failed.length, 0, result.failed[0]?.reason)
    assert.doesNotMatch(fs.readFileSync(page, "utf8"), /page__title/)
  })

  check("an element nobody can place is refused", () => {
    restore()
    const result = remove("src/page.tsx", jsxTarget("footer", ["nope"]))
    assert.equal(result.applied.length, 0)
    assert.match(result.failed[0].reason, /no unique <footer>/)
    assert.equal(fs.readFileSync(page, "utf8"), PAGE_TSX)
  })

  check("a Vite path is project-relative, not filesystem-absolute", () => {
    restore()
    // Vite serves `/src/page.tsx` and its sourcemap says so, which at the
    // filesystem root is a file that does not exist and is outside the project.
    const result = remove("/src/page.tsx", jsxTarget("p", ["panel__body"], {
      parentTagName: "section",
      parentClasses: ["panel"],
    }))
    assert.equal(result.failed.length, 0, result.failed[0]?.reason)
    assert.doesNotMatch(fs.readFileSync(page, "utf8"), /panel__body/)
  })

  check("a real file outside the project is refused, not re-read under it", () => {
    restore()
    // `/etc/hosts` exists, so it must never be retried as `<root>/etc/hosts`.
    for (const outside of ["../escape.tsx", "/etc/hosts", "/etc/hosts.tsx"]) {
      const result = remove(outside, jsxTarget("div", ["x"]))
      assert.equal(result.applied.length, 0, `${outside} was accepted`)
      assert.match(result.failed[0].reason, /outside the editable roots/)
    }
  })

  check("an element with no file resolved says so rather than guessing one", () => {
    restore()
    const result = react.remove([
      { op: "removeElement", componentName: "Page", filePath: null, target: jsxTarget("p", ["panel__body"]) },
    ])
    assert.equal(result.applied.length, 0)
    assert.match(result.failed[0].reason, /no source file/)
  })

  fs.rmSync(root, { recursive: true, force: true })
}

/* -------------------------------------------------------------------------
 * The route
 * ---------------------------------------------------------------------- */

console.log("\nThe route both hosts share")

async function serve(config) {
  const routes = createDesignLayerRoutes(config)
  const server = http.createServer((request, response) => {
    if (routes.handle(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}${config.apiPrefix}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const post = (base, body) =>
  fetch(`${base}/source/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

{
  const root = angularProject()
  const template = path.join(root, "src/app/card/card.component.html")
  const config = resolveConfig({ projectRoot: root }, { cwd: root })
  const server = await serve(config)

  await checkAsync("an Angular host deletes through the shared route", async () => {
    const response = await post(server.base, {
      operations: [
        {
          op: "removeElement",
          componentName: "CardComponent",
          filePath: "src/app/card/card.component.html",
          target: ngTarget("h2", ["card__title"]),
        },
      ],
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.applied.length, 1, body.failed[0]?.reason)
    assert.doesNotMatch(fs.readFileSync(template, "utf8"), /card__title/)
  })

  await checkAsync("an operation with no target is refused before anything is read", async () => {
    const response = await post(server.base, { operations: [{ op: "removeElement" }] })
    assert.equal(response.status, 400)
    assert.match((await response.json()).message, /needs a target/)
  })

  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

{
  const root = reactProject()
  const page = path.join(root, "src/page.tsx")
  const config = resolveConfig({ projectRoot: root }, { cwd: root })
  const server = await serve(config)

  await checkAsync("a React host deletes through the same route", async () => {
    const response = await post(server.base, {
      operations: [
        {
          op: "removeElement",
          componentName: "Page",
          filePath: "src/page.tsx",
          lineNumber: 0,
          target: jsxTarget("p", ["panel__body"], {
            parentTagName: "section",
            parentClasses: ["panel"],
          }),
        },
      ],
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.applied.length, 1, body.failed[0]?.reason)
    assert.doesNotMatch(fs.readFileSync(page, "utf8"), /panel__body/)
  })

  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
