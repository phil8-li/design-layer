/**
 * Cases for the Angular host lane: framework detection, the vendor's detection
 * gates, component resolution, and the template writer.
 *
 * No browser and no servers. A throwaway Angular project is written to a temp
 * directory and the real `server/angular-source.mjs` is driven against it,
 * because the failures worth catching here are all about bytes on disk: a
 * splice landing one character past a quote, an attribute inserted in front of
 * the ones the author wrote, an edit reaching a template it should have refused.
 *
 * The refusals are cases, not omissions. This writer is allowed to decline —
 * on an ambiguous match, on interpolated text — and every decline has to stay
 * a decline, because the alternative is a silent write to the wrong element.
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

/* ---------------------------------------------------------------------- */
console.log("\nTemplate writing")

{
  const root = scaffold()
  const angular = createAngularSource(resolveConfig({}, { cwd: root }))
  const html = () => fs.readFileSync(path.join(root, "src/app/card/card.component.html"), "utf8")
  const ts = () => fs.readFileSync(path.join(root, "src/app/app.ts"), "utf8")

  check("a style lands after the attributes the author wrote", () => {
    const result = angular.apply([
      {
        op: "setStyles",
        componentName: "_CardComponent",
        target: target("h2", ["card__title"]),
        declarations: { "font-size": "40px", opacity: "0.4" },
      },
    ])
    assert.equal(result.failed.length, 0, JSON.stringify(result.failed))
    assert.ok(
      html().includes('<h2 class="card__title" style="font-size: 40px; opacity: 0.4">'),
      html().split("\n")[1]
    )
    assert.equal(result.applied[0].lineNumber, 2)
  })

  check("a second style merges, replacing only the property it names", () => {
    angular.apply([
      {
        op: "setStyles",
        componentName: "CardComponent",
        target: target("p", ["card__body"]),
        declarations: { color: "blue", "margin-top": "8px" },
      },
    ])
    assert.ok(html().includes('style="color: blue; margin-top: 8px"'), html().split("\n")[2])
  })

  check("an empty value deletes a declaration", () => {
    angular.apply([
      {
        op: "setStyles",
        componentName: "CardComponent",
        target: target("p", ["card__body"]),
        declarations: { "margin-top": "" },
      },
    ])
    assert.ok(html().includes('style="color: blue"'), html().split("\n")[2])
  })

  check("classes are added and removed in the class attribute", () => {
    angular.apply([
      {
        op: "setClasses",
        componentName: "CardComponent",
        target: target("button", ["card__cta"]),
        add: ["card__cta--primary"],
        remove: ["card__cta"],
      },
    ])
    assert.ok(html().includes('<button class="card__cta--primary" type="button">'))
  })

  check("static text is replaced", () => {
    angular.apply([
      {
        op: "setText",
        componentName: "CardComponent",
        target: target("h2", ["card__title"]),
        text: "Welcome to Agent Builder",
      },
    ])
    assert.ok(html().includes(">Welcome to Agent Builder</h2>"))
  })

  check("interpolated text is refused, not overwritten", () => {
    const result = angular.apply([
      {
        op: "setText",
        componentName: "CardComponent",
        target: target("p", ["card__bound"]),
        text: "nope",
      },
    ])
    assert.equal(result.applied.length, 0)
    assert.match(result.failed[0].reason, /bound|control flow/)
    assert.ok(html().includes("{{ title }}"), "the binding must survive")
  })

  check("an ambiguous target is refused, not guessed", () => {
    const result = angular.apply([
      {
        op: "setStyles",
        componentName: "CardComponent",
        target: AMBIGUOUS,
        declarations: { color: "black" },
      },
    ])
    assert.equal(result.applied.length, 0)
    assert.match(result.failed[0].reason, /no unique <li>/)
  })

  check("a void element takes a style without gaining a closing tag", () => {
    angular.apply([
      {
        op: "setStyles",
        componentName: "CardComponent",
        target: target("img", ["card__art"], { attributes: { src: "a.png" } }),
        declarations: { "border-radius": "8px" },
      },
    ])
    assert.ok(html().includes('<img class="card__art" src="a.png" alt="" style="border-radius: 8px">'))
  })

  check("an element inside a control-flow block is reachable", () => {
    angular.apply([
      {
        op: "setStyles",
        componentName: "CardComponent",
        target: target("span", ["card__flag"]),
        declarations: { color: "green" },
      },
    ])
    assert.ok(html().includes('<span class="card__flag" style="color: green">'))
    assert.ok(html().includes("@if (title) {"), "the block itself must be untouched")
  })

  check("two operations on one element are one rewrite", () => {
    angular.apply([
      {
        op: "setClasses",
        componentName: "CardComponent",
        target: target("h2", ["card__title"]),
        add: ["is-large"],
        remove: [],
      },
      {
        op: "setStyles",
        componentName: "CardComponent",
        target: target("h2", ["card__title"]),
        declarations: { color: "purple" },
      },
    ])
    const line = html().split("\n")[1]
    assert.ok(line.includes("is-large"), line)
    assert.ok(line.includes("color: purple"), line)
  })

  check("one failure does not stop the operations beside it", () => {
    const result = angular.apply([
      {
        op: "setStyles",
        componentName: "CardComponent",
        target: AMBIGUOUS,
        declarations: { color: "black" },
      },
      {
        op: "setStyles",
        componentName: "CardComponent",
        target: target("section", ["card"], { parentTagName: null, parentClasses: [] }),
        declarations: { gap: "12px" },
      },
    ])
    assert.equal(result.applied.length, 1)
    assert.equal(result.failed.length, 1)
    assert.ok(html().includes('<section class="card" style="gap: 12px">'))
  })

  check("an inline template is spliced without disturbing its module", () => {
    const result = angular.apply([
      {
        op: "setStyles",
        componentName: "_App",
        target: {
          tagName: "span",
          classes: ["root__tag"],
          id: null,
          nthOfType: 0,
          parentTagName: "div",
          parentClasses: ["root"],
          attributes: {},
        },
        declarations: { "font-weight": "700" },
      },
    ])
    assert.equal(result.failed.length, 0, JSON.stringify(result.failed))
    assert.ok(ts().includes('<span class="root__tag" style="font-weight: 700">v1</span>'))
    assert.ok(ts().includes("export class App {}"))
    assert.ok(ts().includes("selector: 'app-root'"))
  })

  /*
   * The index holds byte offsets into each `.ts` file. An edit made outside the
   * editor — the IDE, an agent — used to leave them pointing at the old text, so
   * the next splice into an inline template landed a few bytes early.
   */
  check("an edit made outside the editor does not leave the index splicing at old offsets", () => {
    assert.equal(angular.component("_App")?.componentName, "App")
    fs.writeFileSync(path.join(root, "src/app/app.ts"), `// edited elsewhere\n// and again\n${ts()}`)
    const result = angular.apply([
      {
        op: "setText",
        componentName: "_App",
        target: {
          tagName: "span",
          classes: ["root__tag"],
          id: null,
          nthOfType: 0,
          parentTagName: "div",
          parentClasses: ["root"],
          attributes: {},
        },
        text: "v2",
      },
    ])
    assert.equal(result.failed.length, 0, JSON.stringify(result.failed))
    assert.ok(ts().startsWith("// edited elsewhere\n// and again\n"))
    assert.ok(ts().includes('<span class="root__tag" style="font-weight: 700">v2</span>'), ts())
    assert.ok(ts().includes("export class App {}"))
  })

  check("a write outside the editable roots is refused", () => {
    const config = resolveConfig({ source: { roots: ["src/nowhere"] } }, { cwd: root })
    const guarded = createAngularSource(config)
    const result = guarded.apply([
      {
        op: "setStyles",
        componentName: "CardComponent",
        target: target("section", ["card"], { parentTagName: null, parentClasses: [] }),
        declarations: { gap: "99px" },
      },
    ])
    assert.equal(result.applied.length, 0)
    assert.match(result.failed[0].reason, /outside the editable roots/)
  })

  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
