/**
 * Cases for the Angular host lane: framework detection, the vendor's detection
 * gates, template scanning and component resolution.
 *
 * No browser and no servers. A throwaway Angular project is written to a temp
 * directory and the real `server/angular-source.mjs` is driven against it,
 * because the failures worth catching here are about reading bytes on disk: a
 * bundler-renamed class, a start tag scanned at the wrong line, a descriptor
 * that matches two elements. An ambiguous match locates nothing rather than
 * guessing, and that refusal is a case, not an omission.
 *
 * Usage: node designlayer/test/angular-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolveConfig } from "../config.mjs"
import { vendorDetectionShims } from "../runtime/launcher.mjs"
import { createAngularSource, scanTemplate, matchNode } from "../server/angular-source.mjs"

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

const TEMPLATE = `<section class="card">
  <h2 class="card__title">Welcome to Acme Store</h2>
  <p class="card__body" style="color: red">Body copy</p>
  <button class="card__cta" type="button">Go</button>
  <img class="card__art" src="a.png" alt="">
  <p class="card__bound">{{ title }}</p>
  @if (title) {
    <span class="card__flag">on</span>
  }
  <ul class="card__list">
    <li class="card__item">one</li>
    <li class="card__item">two</li>
  </ul>
  <ul class="card__more">
    <li class="card__item">three</li>
  </ul>
</section>
`

/** A throwaway Angular project, rebuilt per case group so writes cannot leak. */
function scaffold({ angular = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-angular-"))
  fs.mkdirSync(path.join(root, "src/app/card"), { recursive: true })
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "host",
      dependencies: angular ? { "@angular/core": "^22.0.0" } : { next: "^15.0.0", react: "^19.0.0" },
    })
  )
  fs.writeFileSync(
    path.join(root, "src/app/card/card.component.ts"),
    `import {Component} from '@angular/core';\n` +
      `@Component({\n` +
      `  selector: 'app-card',\n` +
      `  templateUrl: './card.component.html',\n` +
      `  styleUrl: './card.component.css',\n` +
      `})\n` +
      `export class CardComponent { title = 'hi'; }\n`
  )
  fs.writeFileSync(path.join(root, "src/app/card/card.component.html"), TEMPLATE)
  fs.writeFileSync(path.join(root, "src/app/card/card.component.css"), ".card { display: grid; }\n")
  fs.writeFileSync(
    path.join(root, "src/app/app.ts"),
    `import {Component} from '@angular/core';\n` +
      `@Component({\n` +
      `  selector: 'app-root',\n` +
      "  template: `<div class=\"root\"><span class=\"root__tag\">v1</span></div>`,\n" +
      `})\n` +
      `export class App {}\n`
  )
  return root
}

/**
 * A descriptor that names two template nodes equally well: the first `<li>` of
 * each of the two lists. Shared by the matcher cases and the writer's refusal
 * case so both are talking about the same ambiguity.
 */
const AMBIGUOUS = {
  tagName: "li",
  classes: ["card__item"],
  id: null,
  nthOfType: 0,
  parentTagName: "ul",
  parentClasses: [],
  attributes: {},
}

const target = (tagName, classes, extra = {}) => ({
  tagName,
  classes,
  id: null,
  nthOfType: 0,
  parentTagName: "section",
  parentClasses: ["card"],
  attributes: {},
  ...extra,
})

/* ---------------------------------------------------------------------- */
console.log("\nWhat kind of host is this")

{
  const angularRoot = scaffold()
  const nextRoot = scaffold({ angular: false })

  check("an @angular/core dependency makes the host Angular", () => {
    assert.equal(resolveConfig({}, { cwd: angularRoot }).host.framework, "angular")
  })

  check("a React project is unaffected", () => {
    assert.equal(resolveConfig({}, { cwd: nextRoot }).host.framework, "react")
  })

  check("an explicit framework overrides detection", () => {
    const config = resolveConfig({ host: { framework: "react" } }, { cwd: angularRoot })
    assert.equal(config.host.framework, "react")
  })

  check("an unknown framework is refused rather than ignored", () => {
    assert.throws(() => resolveConfig({ host: { framework: "svelte" } }, { cwd: angularRoot }))
  })

  check("an Angular host may write templates and stylesheets", () => {
    const { extensions } = resolveConfig({}, { cwd: angularRoot }).source
    assert.ok(extensions.includes(".html"), "expected .html in the allowlist")
    assert.ok(extensions.includes(".css"), "expected .css in the allowlist")
  })

  check("a React host's allowlist is unchanged", () => {
    const { extensions } = resolveConfig({}, { cwd: nextRoot }).source
    assert.ok(!extensions.includes(".html"), "React hosts must not gain .html")
  })

  check("a host that narrows the allowlist keeps exactly what it asked for", () => {
    const config = resolveConfig({ source: { extensions: [".ts"] } }, { cwd: angularRoot })
    assert.deepEqual(config.source.extensions, [".ts"])
  })

  check("the vendor's react gate is answered only for an Angular host", () => {
    const angular = vendorDetectionShims(resolveConfig({}, { cwd: angularRoot }))
    assert.equal(angular.declareReact, true)
    assert.match(angular.virtualConfig, /vite\.config\.ts$/)
  })

  check("a Next host with a real react dep gets no react shim", () => {
    const next = vendorDetectionShims(resolveConfig({}, { cwd: nextRoot }))
    assert.equal(next.declareReact, false)
    assert.match(next.virtualConfig, /next\.config\.mjs$/)
  })

  fs.rmSync(angularRoot, { recursive: true, force: true })
  fs.rmSync(nextRoot, { recursive: true, force: true })
}

/* ---------------------------------------------------------------------- */
console.log("\nTemplate scanning")

{
  const nodes = scanTemplate(TEMPLATE)
  const byTag = (tag) => nodes.filter((node) => node.tagName === tag)

  check("every start tag is found, including inside a control-flow block", () => {
    assert.equal(byTag("span").length, 1)
    assert.equal(byTag("li").length, 3)
  })

  check("a void element does not open a scope", () => {
    const img = byTag("img")[0]
    assert.equal(img.selfClosing, true)
    assert.equal(byTag("p")[1].parentTagName, "section")
  })

  check("nthOfType counts same-tag siblings under one parent, and restarts", () => {
    // Two lists: the third item is the first child of the second `<ul>`, so it
    // is index 0 again. A counter that did not restart per parent would call
    // it 2 and quietly make every list item after the first list unmatchable.
    assert.deepEqual(
      byTag("li").map((node) => node.nthOfType),
      [0, 1, 0]
    )
  })

  check("a parent is the enclosing element, not the previous tag", () => {
    assert.equal(byTag("li")[0].parentTagName, "ul")
    assert.equal(byTag("h2")[0].parentTagName, "section")
  })

  check("an element with two static classes reads both", () => {
    const parsed = scanTemplate('<div class="a  b">x</div>')
    assert.deepEqual(parsed[0].classes, ["a", "b"])
  })

  check("a comment cannot contribute a tag", () => {
    const parsed = scanTemplate('<!-- <div class="ghost"> --><p class="real">x</p>')
    assert.deepEqual(
      parsed.map((node) => node.tagName),
      ["p"]
    )
  })

  check("a template class list must be a subset of the live one", () => {
    // `[class.is-open]` puts `is-open` on the element at runtime only.
    const node = matchNode(nodes, target("h2", ["card__title", "is-open"]))
    assert.equal(node?.tagName, "h2")
  })

  check("a live element missing a static class is not that element", () => {
    assert.equal(matchNode(nodes, target("h2", ["something-else"])), null)
  })

  check("two equally good candidates resolve to nothing", () => {
    // First item of each list: same tag, same class, same index, same parent
    // tag. Nothing in the descriptor separates them, so nothing may be picked.
    assert.equal(matchNode(nodes, AMBIGUOUS), null)
  })

  check("nthOfType separates candidates the classes cannot", () => {
    const node = matchNode(nodes, { ...AMBIGUOUS, nthOfType: 1 })
    assert.equal(node?.nthOfType, 1)
  })

  check("a parent class separates them too", () => {
    const node = matchNode(nodes, { ...AMBIGUOUS, parentClasses: ["card__more"] })
    assert.equal(node?.parentClasses[0], "card__more")
  })
}

/* ---------------------------------------------------------------------- */
console.log("\nComponent resolution")

{
  const root = scaffold()
  const angular = createAngularSource(resolveConfig({}, { cwd: root }))

  check("a bundler-renamed class still finds its component", () => {
    assert.equal(angular.component("_CardComponent")?.componentName, "CardComponent")
    assert.equal(angular.component("CardComponent")?.componentName, "CardComponent")
  })

  check("a component names its template and stylesheet", () => {
    const found = angular.component("CardComponent")
    assert.equal(found.templateFile, path.join("src/app/card/card.component.html"))
    assert.equal(found.styleFile, path.join("src/app/card/card.component.css"))
  })

  check("an unknown class resolves to nothing rather than to a guess", () => {
    assert.equal(angular.component("NoSuchComponent"), null)
  })

  check("an element resolves to its template file and line", () => {
    const source = angular.resolve("_CardComponent", target("h2", ["card__title"]))
    assert.equal(source.filePath, path.join("src/app/card/card.component.html"))
    assert.equal(source.lineNumber, 2)
    assert.equal(source.located, true)
  })

  check("an element that cannot be placed still names its component's file", () => {
    const source = angular.resolve("_CardComponent", AMBIGUOUS)
    assert.equal(source.located, false)
    assert.equal(source.lineNumber, 0)
    assert.match(source.reason, /no unique <li>/)
  })

  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
