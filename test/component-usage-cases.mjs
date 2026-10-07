/**
 * Cases for the component usage counter: the number the editor shows a designer
 * before it lets them edit a component that forty pages render.
 *
 * Everything here runs against REAL projects created under `os.tmpdir()` and
 * thrown away afterwards, with the route driven over a real `http.createServer`
 * on 127.0.0.1 — the harness `audit-cases.mjs` uses, for the same reason. The
 * whole feature is a walk of a directory tree: which files it opens, which it
 * refuses to open, and what it does at the edge of its own budget. A fake
 * filesystem would prove none of that.
 *
 * What is pinned, and why each one is a way this number goes quietly wrong:
 *
 *  - **build output is not walked.** `dist/`, `build/`, `.next/` and
 *    `coverage/` hold compiled COPIES of the same source, so a walk that
 *    entered them would not find new render sites, it would find the same ones
 *    again and hand the designer a doubled number. The fixture plants a
 *    `<Button/>` in every one of them and the count must not move;
 *  - **a lowercase name is refused in words.** `button` is a DOM tag: there
 *    really are `<button>` elements out there and none of them is a render of
 *    anyone's component, so both "0" and "the DOM count" are wrong answers. The
 *    case asserts a refusal sentence AND a zero count, because a refusal that
 *    still carried a number would be read as the number;
 *  - **the file cap reports `truncated`.** A count taken from a partial walk is
 *    a floor, and a UI that cannot tell a floor from a total prints the wrong
 *    one. The case lowers the cap rather than writing three thousand files;
 *  - **the usage LIST being clipped does not set `truncated`.** The two limits
 *    mean different things — one bounds what is listed, the other says the
 *    number itself is incomplete — and collapsing them would make every large
 *    component look like an unfinished walk;
 *  - **a declaration is not a call site, and a render inside the defining file
 *    is.** `export function Button` must never count as a usage of Button, while
 *    a `<Button>` written lower down the same file is a real render. A rule that
 *    skipped the whole defining file would lose it;
 *  - **`.ts` is not scanned as JSX.** `<Button>value` in a `.ts` file is a
 *    TypeScript type assertion. A parser running with the JSX plugin reads it as
 *    an element, so scanning `.ts` would invent a usage that does not exist,
 *    which is worse than missing one;
 *  - **a file that does not parse contributes nothing instead of failing the
 *    answer.** The half-written file is the one the designer is working in, so
 *    it is the likeliest file in the project to be unparseable at the moment
 *    they ask;
 *  - **an Angular usage inside an HTML comment is not a usage.** Commented-out
 *    markup is the commonest false positive a textual search produces, and the
 *    template scanner blanking comments is the reason this one does not;
 *  - **two files declaring the same name are both reported.** The count is by
 *    name and does not resolve imports; when two unrelated `Card`s exist, the
 *    honest answer is to say so rather than to pick one and imply the number
 *    belongs to it.
 *
 * The fixtures are invented — a small React app and a smaller Angular one,
 * written for this file.
 *
 * Usage: node designlayer/test/component-usage-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { resolveConfig } from "../config.mjs"
import { createComponentUsage } from "../server/component-usage.mjs"
import { createDesignLayerRoutes } from "../server/routes.mjs"

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

// ── The fixture project ────────────────────────────────────────────────────

/*
 * The defining file, which also renders what it defines.
 *
 * `IconButton` is not decoration: it is the case that separates "skip the file
 * the component is declared in" from "skip the declaration", and only the
 * second of those is correct. The `<button>` inside `Button` is the other half
 * — a component that wraps a DOM element of a similar name is the normal shape,
 * and counting the wrapped tag would double every wrapper in the project.
 */
const BUTTON_TSX = `/** The shared Button every page reaches for. */
export function Button({ children }) {
  return <button className="btn">{children}</button>
}

/** Renders the shared Button, in the very file that declares it. */
export function IconButton() {
  return <Button>icon</Button>
}
`

/*
 * Two renders, one native `<button>` that must not count, and a `<Card.Header>`
 * that must not count as a `Card` — the member tag is a different component
 * that happens to hang off the same object.
 */
const PAGE_TSX = `import { Button } from "../ui/button"
import { Card } from "../ui/card"

export default function Page() {
  return (
    <main>
      <Card>
        <Card.Header>Settings</Card.Header>
        <Button>Save</Button>
        <Button variant="ghost" />
        <button type="button">native</button>
      </Card>
    </main>
  )
}
`

const SETTINGS_JSX = `import { Button } from "../ui/button"

export function Settings() {
  return <Button>Settings</Button>
}
`

/** A `.js` file with JSX in it, which is what Next and CRA projects write by default. */
const LEGACY_JS = `import { Button } from "../ui/button"

export function Legacy() {
  return <Button>Legacy</Button>
}
`

/*
 * A `.ts` file whose `<Button>` is a type assertion, not an element.
 *
 * This is the whole reason `.ts` is left out of the JSX lane. Handed to a
 * parser with the JSX plugin on, this file reports a usage of Button that a
 * TypeScript compiler would tell you is a cast.
 */
const CAST_TS = `import type { Button } from "../ui/button"

declare const value: unknown
export const asButton = <Button>value
`

/** Unparseable even with error recovery on, which is the point of it. */
const BROKEN_TSX = `const = = = <Button /> ) )
`

/** A second, unrelated Card, so the name spans two components. */
const CARD_TSX = `export function Card({ children }) {
  return <section className="card">{children}</section>
}
`
const LEGACY_CARD_TSX = `export const Card = () => <div className="old-card" />
`

/** Planted in every directory the walk must refuse to enter. */
const EXCLUDED_TSX = `export const Copy = () => <Button>compiled copy</Button>
`

async function reactProject() {
  // `realpath` because `os.tmpdir()` is itself a symlink on macOS, and the
  // containment check resolves real paths on one side of its comparison.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "de-usage-")))
  const write = async (relative, contents) => {
    const file = path.join(root, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, contents, "utf8")
    return file
  }

  await write("package.json", `${JSON.stringify({ name: "usage-host", private: true }, null, 2)}\n`)
  await write("src/ui/button.tsx", BUTTON_TSX)
  await write("src/ui/card.tsx", CARD_TSX)
  await write("src/legacy/card.tsx", LEGACY_CARD_TSX)
  await write("src/app/page.tsx", PAGE_TSX)
  await write("src/app/settings.jsx", SETTINGS_JSX)
  await write("src/app/legacy.js", LEGACY_JS)
  await write("src/app/cast.ts", CAST_TS)
  await write("src/app/broken.tsx", BROKEN_TSX)

  for (const excluded of [
    "node_modules/ui-kit/demo.tsx",
    "dist/page.js",
    "build/page.jsx",
    ".next/server/page.js",
    "coverage/lcov-report/page.js",
  ]) {
    await write(excluded, EXCLUDED_TSX)
  }

  const config = resolveConfig({ projectRoot: root }, { cwd: root })
  return {
    root,
    config,
    write,
    usage: createComponentUsage(config),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

/*
 * The Angular fixture: two templates, one comment, one inline template.
 *
 * `host.framework` is stated rather than inferred from a dependency, because
 * the fact under test is what the lane does on an Angular host and not how the
 * host is detected — that belongs to `zero-config-cases.mjs`.
 */
const HOME_HTML = `<div class="page">
  <app-button label="Save"></app-button>
  <!-- <app-button label="commented out"></app-button> -->
  <app-button label="Cancel"/>
  <button type="button">native</button>
</div>
`
const OTHER_HTML = `<section>
  <app-button label="Elsewhere"></app-button>
</section>
`
/** An inline template, which this module does not read — a documented floor. */
const HOME_TS = `import { Component } from "@angular/core"

@Component({
  selector: "app-home",
  template: \`<app-button label="Inline"></app-button>\`,
})
export class HomeComponent {}
`

async function angularProject() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "de-usage-ng-")))
  const write = async (relative, contents) => {
    const file = path.join(root, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, contents, "utf8")
    return file
  }

  await write("package.json", `${JSON.stringify({ name: "usage-ng-host", private: true }, null, 2)}\n`)
  await write("src/app/home.component.html", HOME_HTML)
  await write("src/app/other.component.html", OTHER_HTML)
  await write("src/app/home.component.ts", HOME_TS)
  await write("dist/index.html", HOME_HTML)

  const config = resolveConfig({ projectRoot: root, host: { framework: "angular" } }, { cwd: root })
  return {
    root,
    config,
    usage: createComponentUsage(config),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

/** Runs a case against its own project directory, and always cleans up. */
async function withProject(name, make, fn) {
  await check(name, async () => {
    const context = await make()
    try {
      await fn(context)
    } finally {
      await context.cleanup()
    }
  })
}

const react = (name, fn) => withProject(name, reactProject, fn)
const angular = (name, fn) => withProject(name, angularProject, fn)

const at = (answer, file) => answer.usages.filter((entry) => entry.file === file).map((u) => u.line)

// ── Counting ───────────────────────────────────────────────────────────────

console.log("\nCounting the places a React component is rendered")

/*
 * Five renders across four files: two on the page, one in a `.jsx`, one in a
 * `.js`, and one inside the file that declares Button. The assertion is on the
 * whole list rather than on the total, because a total can be right for the
 * wrong reasons — a missed usage and a phantom one cancel out.
 */
await react("every JSX call site is counted, across .tsx, .jsx and .js", async ({ usage }) => {
  const answer = await usage.read("Button")
  assert.equal(answer.count, 5, `counted ${answer.count} renders of Button: ${JSON.stringify(answer.usages)}`)
  assert.equal(answer.usages.length, 5)
  assert.deepEqual(at(answer, "src/app/page.tsx"), [9, 10])
  assert.deepEqual(at(answer, "src/app/settings.jsx"), [4])
  assert.deepEqual(at(answer, "src/app/legacy.js"), [4], "a .js file with JSX in it was skipped")
  assert.deepEqual(at(answer, "src/ui/button.tsx"), [8])
  assert.equal(answer.truncated, false)
  assert.equal(answer.refused, "")
})

await react("the declaration is not a call site, and a render beside it is", async ({ usage }) => {
  const answer = await usage.read("Button")
  const own = at(answer, "src/ui/button.tsx")
  assert.equal(own.length, 1, `the defining file reported ${own.length} usages, expected exactly the one <Button>`)
  assert.equal(own[0], 8, "the counted line is not the <Button> inside IconButton")
})

await react("a native <button> is never counted as a render of Button", async ({ usage }) => {
  const answer = await usage.read("Button")
  assert.equal(
    answer.usages.some((entry) => entry.file === "src/app/page.tsx" && entry.line === 11),
    false,
    "the native <button> on line 11 was counted"
  )
})

await react("a member tag is its own component, not a usage of its parent", async ({ usage }) => {
  const parent = await usage.read("Card")
  assert.equal(parent.count, 1, `<Card.Header> was rolled into Card's count (${parent.count})`)

  const child = await usage.read("Card.Header")
  assert.equal(child.count, 1)
  assert.deepEqual(at(child, "src/app/page.tsx"), [8])
})

await react("a .ts type assertion is not read as a usage", async ({ usage }) => {
  const answer = await usage.read("Button")
  assert.equal(
    answer.usages.some((entry) => entry.file === "src/app/cast.ts"),
    false,
    "`<Button>value` in a .ts file was counted as a render"
  )
})

await react("a file that does not parse costs its own usages and nothing else", async ({ usage }) => {
  const answer = await usage.read("Button")
  assert.equal(answer.count, 5, "an unparseable file took the rest of the answer down with it")
  assert.equal(
    answer.usages.some((entry) => entry.file === "src/app/broken.tsx"),
    false,
    "an unparseable file contributed a usage"
  )
})

// ── Where the walk refuses to go ───────────────────────────────────────────

console.log("\nDirectories a count must never be taken from")

await react("node_modules, dist, build, .next and coverage are not walked", async ({ usage }) => {
  const answer = await usage.read("Button")
  const strays = answer.usages.filter((entry) =>
    /^(node_modules|dist|build|\.next|coverage)\//.test(entry.file)
  )
  assert.deepEqual(strays, [], `the walk entered excluded directories: ${JSON.stringify(strays)}`)
  assert.equal(answer.count, 5)
})

await react("a file outside the project is never reachable through definedIn", async ({ usage }) => {
  await assert.rejects(
    () => usage.read("Button", "../../etc/passwd"),
    /outside the editable source roots/,
    "a traversing definedIn was accepted"
  )
  await assert.rejects(() => usage.read("Button", "/etc/hosts"), /outside the editable source roots/)
})

// ── What it refuses to answer ──────────────────────────────────────────────

console.log("\nRefusals, which are answers rather than omissions")

await react("a lowercase name is refused rather than counted as a DOM element", async ({ usage }) => {
  const answer = await usage.read("button")
  assert.equal(answer.count, 0, "a refusal came back carrying a number")
  assert.deepEqual(answer.usages, [])
  assert.match(answer.refused, /lowercase/, `the refusal does not say why: ${answer.refused}`)
  assert.match(answer.refused, /app-button/, "the refusal does not say what to ask for instead")
})

await react("a name that is not an identifier is refused, not searched", async ({ usage }) => {
  for (const name of ["Butt on", "Button!", "<Button>", "9Lives", "-"]) {
    const answer = await usage.read(name)
    assert.equal(answer.count, 0, `${JSON.stringify(name)} produced a count`)
    assert.ok(answer.refused.length > 0, `${JSON.stringify(name)} was accepted as a component name`)
    assert.equal(answer.scanned, 0, `${JSON.stringify(name)} walked the project before refusing`)
  }
})

await react("no name at all is a bad request, not an empty answer", async ({ usage }) => {
  await assert.rejects(() => usage.read(""), /needs a component name/)
  await assert.rejects(() => usage.read("   "), /needs a component name/)
  await assert.rejects(() => usage.read("B".repeat(500)), /too long/)
})

// ── The caps ───────────────────────────────────────────────────────────────

console.log("\nBudgets, and saying so when one is reached")

await react("hitting the file cap reports truncated rather than a quiet under-count", async ({ config }) => {
  const capped = createComponentUsage(config, { maxFiles: 2 })
  const answer = await capped.read("Button")
  assert.equal(answer.truncated, true, "a walk that stopped early reported a total")
  assert.ok(answer.count < 5, `the cap was not reached at all (counted ${answer.count})`)

  const whole = await createComponentUsage(config).read("Button")
  assert.equal(whole.truncated, false, "an uncapped walk of the same project claims to be truncated")
})

await react("a clipped usage list leaves the count exact and truncated false", async ({ config }) => {
  const answer = await createComponentUsage(config, { maxUsages: 2 }).read("Button")
  assert.equal(answer.usages.length, 2, "the list ignored its cap")
  assert.equal(answer.count, 5, "clipping the list changed the number the designer acts on")
  assert.equal(answer.truncated, false, "a clipped list was reported as an incomplete walk")
})

// ── Where the component is defined ─────────────────────────────────────────

console.log("\nThe defining file, given or discovered")

await react("the defining file is discovered when the caller does not name one", async ({ usage }) => {
  const answer = await usage.read("Button")
  assert.equal(answer.definedIn, "src/ui/button.tsx")
  assert.deepEqual(answer.definitions, ["src/ui/button.tsx"])
})

await react("a caller-supplied defining file is reported project-relative", async ({ usage }) => {
  const named = await usage.read("Button", "src/ui/button.tsx")
  assert.equal(named.definedIn, "src/ui/button.tsx")
  assert.equal(named.count, 5, "naming the defining file changed the count")

  // Vite serves modules as `/src/App.tsx`, so on a Vite host every path the
  // browser knows arrives looking absolute.
  const viteStyle = await usage.read("Button", "/src/ui/button.tsx")
  assert.equal(viteStyle.definedIn, "src/ui/button.tsx")
})

await react("two components sharing a name are both reported, and neither is 'the' definition", async ({ usage }) => {
  const answer = await usage.read("Card")
  assert.deepEqual(answer.definitions.sort(), ["src/legacy/card.tsx", "src/ui/card.tsx"])
  assert.equal(answer.definedIn, "", "one of two same-named components was presented as the definition")
})

await react("a component nothing renders is zero, not a refusal", async ({ usage }) => {
  const answer = await usage.read("Tooltip")
  assert.equal(answer.count, 0)
  assert.deepEqual(answer.usages, [])
  assert.equal(answer.refused, "", "an honest zero was reported as a refusal")
  assert.ok(answer.scanned > 0, "the project was never walked")
})

// ── Angular templates ──────────────────────────────────────────────────────

console.log("\nAngular element selectors, counted in templates")

await angular("an element selector is counted across .html templates", async ({ usage }) => {
  const answer = await usage.read("app-button")
  assert.equal(answer.count, 3, `counted ${answer.count} usages: ${JSON.stringify(answer.usages)}`)
  assert.deepEqual(at(answer, "src/app/home.component.html"), [2, 4])
  assert.deepEqual(at(answer, "src/app/other.component.html"), [2])
})

await angular("a selector inside an HTML comment is not a usage", async ({ usage }) => {
  const answer = await usage.read("app-button")
  assert.equal(
    answer.usages.some((entry) => entry.file === "src/app/home.component.html" && entry.line === 3),
    false,
    "commented-out markup was counted as a render"
  )
})

await angular("a template under dist is not walked", async ({ usage }) => {
  const answer = await usage.read("app-button")
  assert.equal(
    answer.usages.some((entry) => entry.file.startsWith("dist/")),
    false,
    "the built copy of a template was counted"
  )
})

/*
 * The documented floor, pinned so it cannot become an undocumented one. An
 * inline `template:` in a `.ts` decorator holds a real usage that this module
 * does not read; the case states the number it therefore reports, so a later
 * change that starts reading them fails here and gets to update the comment
 * that promises it does not.
 */
await angular("an inline template's usage is not counted, which is a floor and not a total", async ({ usage }) => {
  const answer = await usage.read("app-button")
  assert.equal(answer.count, 3, "inline templates started counting without the header saying so")
  assert.equal(
    answer.usages.some((entry) => entry.file.endsWith(".ts")),
    false
  )
})

await react("an element selector on a React host walks nothing, and says it scanned nothing", async ({ usage }) => {
  const answer = await usage.read("app-button")
  assert.equal(answer.count, 0)
  assert.equal(answer.scanned, 0, "a React host opened .html files the writer may not touch")
})

// ── The per-file cache ─────────────────────────────────────────────────────

console.log("\nRepeat lookups, which reuse unchanged files and never a stale answer")

/*
 * Each file's parsed tags are kept against its mtime and size, so the second
 * lookup must see exactly what a fresh instance would: an edited file's new
 * renders, a new file, and nothing from a deleted one. Asking for a second
 * name in between proves the cache holds every tag a file renders, not just the
 * name that caused it to be parsed.
 */
await react("an edited, added or deleted file changes the very next count", async ({ usage, write, root, config }) => {
  const first = await usage.read("Button")
  assert.equal(first.count, 5)
  assert.equal((await usage.read("Card")).count, 1)

  await write("src/app/settings.jsx", `${SETTINGS_JSX}\nexport const Twice = () => <><Button /><Button /></>\n`)
  await write("src/app/fresh.tsx", `export const Fresh = () => <Button>new</Button>\n`)
  await fs.rm(path.join(root, "src/app/legacy.js"))

  const again = await usage.read("Button")
  const fresh = await createComponentUsage(config).read("Button")
  assert.deepEqual(again, fresh, "the cached instance answered differently from a fresh one")
  assert.equal(again.count, 7, `expected 5 - 1 deleted + 2 edited + 1 added, got ${again.count}`)
  assert.deepEqual(at(again, "src/app/fresh.tsx"), [1])
  assert.deepEqual(at(again, "src/app/legacy.js"), [])
})

// ── The route ──────────────────────────────────────────────────────────────

console.log("\nThe endpoint the inspector asks through")

/** The routes over a real loopback socket, because the guard reads the socket. */
async function server(config) {
  const routes = createDesignLayerRoutes(config)
  const listener = http.createServer((request, response) => {
    if (routes.handle(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const { port } = listener.address()
  return {
    url: (query) => `http://127.0.0.1:${port}${config.apiPrefix}/component/usage?${query}`,
    close: () => new Promise((resolve) => listener.close(resolve)),
  }
}

await react("GET /component/usage answers the count over loopback", async ({ config }) => {
  const api = await server(config)
  try {
    const response = await fetch(api.url("name=Button"))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.name, "Button")
    assert.equal(payload.count, 5)
    assert.equal(payload.usages.length, 5)
    assert.equal(payload.definedIn, "src/ui/button.tsx")
    assert.equal(payload.truncated, false)
  } finally {
    await api.close()
  }
})

await react("the route refuses a foreign or null Origin", async ({ config }) => {
  const api = await server(config)
  try {
    // "null" is the Origin a sandboxed iframe or a data: document sends, which
    // is precisely the context an attacker controls.
    const spoofed = await fetch(api.url("name=Button"), { headers: { origin: "null" } })
    assert.equal(spoofed.status, 403)
    const foreign = await fetch(api.url("name=Button"), { headers: { origin: "http://evil.test" } })
    assert.equal(foreign.status, 403)
  } finally {
    await api.close()
  }
})

await react("the route says 400 for no name and 403 for a definedIn outside the project", async ({ config }) => {
  const api = await server(config)
  try {
    const nameless = await fetch(api.url(""))
    assert.equal(nameless.status, 400, `a nameless lookup answered ${nameless.status}`)
    assert.match((await nameless.json()).message, /needs a component name/)

    const outside = await fetch(api.url(`name=Button&definedIn=${encodeURIComponent("../secrets.tsx")}`))
    assert.equal(outside.status, 403, `a traversing definedIn answered ${outside.status}`)
    assert.match((await outside.json()).message, /outside the editable source roots/)

    // A refusal about the NAME is a 200 carrying a sentence, not an error: the
    // panel has something to show, and it is not a failure.
    const lowercase = await fetch(api.url("name=button"))
    assert.equal(lowercase.status, 200)
    const payload = await lowercase.json()
    assert.equal(payload.count, 0)
    assert.match(payload.refused, /lowercase/)
  } finally {
    await api.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
