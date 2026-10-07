/**
 * The audit's server half: which checkers a project may run, what a finding is,
 * and what may be written back into a designer's stylesheet.
 *
 * Everything here runs against a REAL project created under `os.tmpdir()` and
 * thrown away afterwards, with the routes driven over a real `http.createServer`
 * on 127.0.0.1 — the same harness `library-store-cases.mjs` uses, for the same
 * reason. Three of the claims below are facts about bytes on disk (an edit moves
 * a finding, a splice leaves the rest of the file alone, an ignore survives a
 * restart), and a fake filesystem cannot prove any of them.
 *
 * The linters themselves are SYNTHETIC. `node_modules/stylelint` here is forty
 * lines written for this file that scan the fixture stylesheets for four
 * literals and report them at the positions they really occupy. That is not a
 * shortcut around installing the real one — it is the only way to pin the thing
 * that matters, which is how the audit treats a MESSAGE. The real linter's
 * sentence is the entire input to the fix decision, and a test that could not
 * choose which sentence comes back could not tell the three kinds apart. The
 * stub's positions are real, so a re-read after an edit moves them exactly as
 * the real tool would, and nothing downstream of the message is faked.
 *
 * What is worth pinning, and why each one is a way this feature goes quietly
 * wrong:
 *
 *  - **shadcn must report unavailable, with a reason naming Tailwind, on a
 *    project that is not a Tailwind project.** This is the most important case
 *    in the file and it is not a style preference. `@shadcn/lint` is Tailwind-
 *    only by construction: its own token discovery returns null against a
 *    custom-property design system, and its unknown-class rule flagged 7,865
 *    ordinary class names as errors on one real project. An audit that turns it
 *    on there does not become stricter, it becomes a wall of false positives,
 *    and the cost is not a bad number — it is that nobody opens the panel
 *    again. The mirror case runs the same check against a project that DOES use
 *    Tailwind, because "always unavailable" would pass the first case while
 *    removing the checker entirely;
 *  - **a finding's `id` must not move when a line above it does.** The id is
 *    what an ignore is stored against. Hash the line number into it and every
 *    ignore in a file resurrects the moment someone adds an import at the top —
 *    silently, and worst for the person who dismissed the most. So the case
 *    edits a line ABOVE a finding, asserts the ids are unchanged, and asserts
 *    the line numbers DID move, because otherwise it proves only that nothing
 *    happened;
 *  - **`fix` is null for a message that only lists candidates.** Three of the
 *    four messages here name a replacement and one lists `Nearest: --a, --b,
 *    --c`. Choosing one of three guesses for the user is how a linter silently
 *    changes a colour nobody chose, and the damage is invisible in review
 *    because the diff looks exactly like a correct fix;
 *  - **a fix is a splice, and everything else in the file is untouched.** The
 *    assertion is byte equality against the original with one replacement
 *    applied, not "the token is now present" — a rewrite that reformats the
 *    file while fixing it would pass the weaker check and lose a designer's
 *    hand-written comments;
 *  - **a finding whose snippet has moved is reported failed, never written.**
 *    The file changed under us. A blind splice at a stale range corrupts a
 *    working stylesheet, and the failure mode of getting this wrong is not a
 *    missed fix, it is a broken page;
 *  - **an ignore is returned flagged, not filtered.** A run that drops ignored
 *    findings server-side makes an ignore impossible to undo, because the panel
 *    can only offer "Unignore" for a row it can still see;
 *  - **one tool crashing keeps the other's findings.** The stub `ds-lint`
 *    throws from every entry point it has. Losing the whole run to it would
 *    turn one broken dependency into an audit that reports a clean project.
 *
 * The fixtures are invented — two stylesheets and four literals written for
 * this file. They exercise the SHAPES the contract measured (a literal with a
 * near-identical token, a literal with nothing close, an undeclared token with
 * one obvious neighbour, the same literal twice in one declaration) without any
 * real design system's values in them.
 *
 * Usage: node designlayer/test/audit-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { resolveConfig } from "../config.mjs"
import { createDesignLint } from "../server/design-lint.mjs"
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

// ── The fixture stylesheets ────────────────────────────────────────────────

/*
 * Four literals, one per kind of message, and every one of them invented.
 *
 * `rgba(24, 28, 33, 0.06)` sits next to a declared token two hundredths away,
 * which is the shape that earns a confident replacement. `#6d3af2` is the shape
 * that must NOT: three tokens are near it and none of them is it. The
 * `--corner-tiny` reference is the undeclared-token shape, whose message names
 * exactly one neighbour. Token declarations deliberately use values that appear
 * nowhere else, so a finding can never be confused with the token it names.
 */
const PANEL_CSS = `/* Synthetic fixture. Nothing here came from a real design system. */
:root {
  --ink-surface-hover: rgba(24, 28, 33, 0.04);
  --corner-small: 8px;
  --brand-ink: #3f2a99;
}

.panel {
  background-color: rgba(24, 28, 33, 0.06);
  border-radius: var(--corner-tiny);
}

.panel__title:hover {
  color: #6d3af2;
}
`

/*
 * The same literal twice in ONE declaration: same file, same selector, same
 * property, same text. Nothing in the hash input distinguishes them, so the two
 * ids can only differ by an occurrence index — and if they do not, ignoring the
 * first half of a gradient silently ignores the second.
 */
const CARD_CSS = `/* Synthetic fixture. */
.card {
  background-image: linear-gradient(rgba(8, 10, 12, 0.16), rgba(8, 10, 12, 0.16));
}
`

/** Only ever added to a project that is meant to read as a Tailwind host. */
const TAILWIND_CSS = `@import "tailwindcss";

@theme {
  --color-accent: #3f2a99;
}
`

const STYLELINT_CONFIG = `{
  "plugins": ["stylelint-design-tokens"],
  "rules": {
    "design-tokens/no-hardcoded-color": [true, { "tokenSources": ["src/styles/panel.css"] }],
    "design-tokens/no-unknown-token": [true, { "tokenSources": ["src/styles/panel.css"] }]
  }
}
`

// ── The synthetic linters ──────────────────────────────────────────────────

/**
 * A stand-in for stylelint + stylelint-design-tokens.
 *
 * It answers `lint()` the way the real Node API does — `{ results: [{ source,
 * warnings }] }`, one-based `line`/`column`, exclusive `endColumn` — and it
 * finds its own files rather than trusting the caller's glob, so it behaves the
 * same whether the audit passes `cwd`, `configBasedir` or a list of absolute
 * paths. The messages are the real tool's four shapes, each ending in its own
 * `(rule-name)` so that stripping it can be asserted.
 */
const STYLELINT_STUB = `"use strict"

const fs = require("node:fs")
const path = require("node:path")

const RULES = [
  {
    needle: "rgba(24, 28, 33, 0.06)",
    rule: "design-tokens/no-hardcoded-color",
    severity: "error",
    text:
      '"rgba(24, 28, 33, 0.06)" is a hardcoded colour, all but identical to ' +
      "--ink-surface-hover (rgba(24, 28, 33, 0.04)) - close enough that it is " +
      "probably meant to be that token. Use var(--ink-surface-hover), or add a " +
      "token if this is a new colour. (design-tokens/no-hardcoded-color)",
  },
  {
    needle: "--corner-tiny",
    rule: "design-tokens/no-unknown-token",
    severity: "warning",
    text:
      "--corner-tiny is never declared in the token sources. " +
      "Did you mean --corner-small? (design-tokens/no-unknown-token)",
  },
  {
    needle: "#6d3af2",
    rule: "design-tokens/no-hardcoded-color",
    severity: "error",
    text:
      '"#6d3af2" is a hardcoded colour with no matching token. ' +
      "Nearest: --brand-ink, --brand-ink-soft, --brand-ink-strong. " +
      "(design-tokens/no-hardcoded-color)",
  },
  {
    needle: "rgba(8, 10, 12, 0.16)",
    rule: "design-tokens/no-hardcoded-color",
    severity: "error",
    text:
      '"rgba(8, 10, 12, 0.16)" is a hardcoded colour with no matching token. ' +
      "(design-tokens/no-hardcoded-color)",
  },
]

function walk(dir, out) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.charAt(0) === ".") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.slice(-4) === ".css") out.push(full)
  }
}

/** Whatever the caller called the project, reduced to a directory. */
function rootOf(options) {
  if (typeof options.cwd === "string") return options.cwd
  if (typeof options.configBasedir === "string") return options.configBasedir
  const files = Array.isArray(options.files) ? options.files : []
  const first = files.find(function (entry) {
    return typeof entry === "string" && path.isAbsolute(entry)
  })
  if (first) {
    const parts = first.split(path.sep)
    const wild = parts.findIndex(function (part) {
      return part.indexOf("*") !== -1
    })
    return wild === -1 ? path.dirname(first) : parts.slice(0, wild).join(path.sep)
  }
  return process.cwd()
}

function warningsFor(text) {
  const out = []
  for (const rule of RULES) {
    let from = 0
    for (;;) {
      const at = text.indexOf(rule.needle, from)
      if (at === -1) break
      from = at + rule.needle.length
      const before = text.slice(0, at)
      const line = before.split("\\n").length
      const column = at - (before.lastIndexOf("\\n") + 1) + 1
      out.push({
        line: line,
        column: column,
        endLine: line,
        endColumn: column + rule.needle.length,
        rule: rule.rule,
        severity: rule.severity,
        text: rule.text,
      })
    }
  }
  out.sort(function (a, b) {
    return a.line - b.line || a.column - b.column
  })
  return out
}

async function lint(options) {
  const opts = options || {}
  const root = rootOf(opts)
  const files = []
  walk(root, files)
  files.sort()
  const results = files.map(function (file) {
    const warnings = warningsFor(fs.readFileSync(file, "utf8"))
    return {
      source: file,
      errored: warnings.length > 0,
      warnings: warnings,
      deprecations: [],
      invalidOptionWarnings: [],
      parseErrors: [],
    }
  })
  const report = JSON.stringify(results)
  return {
    cwd: root,
    errored: results.some(function (result) {
      return result.errored
    }),
    results: results,
    report: report,
    output: report,
    reportedDisables: [],
    ruleMetadata: {},
  }
}

exports.lint = lint
exports.formatters = {
  json: function (results) {
    return JSON.stringify(results)
  },
}
exports.default = { lint: lint, formatters: exports.formatters }
`

/**
 * The CLI, which exists so that an audit shelling out rather than calling the
 * API meets the behaviour the contract measured: the JSON report goes to
 * STDERR and the process exits 2. A reader of stdout gets nothing at all.
 */
const STYLELINT_CLI = `#!/usr/bin/env node
"use strict"

const lint = require("./index.js").lint

lint({ cwd: process.cwd() }).then(function (result) {
  if (!result.errored) return
  process.stderr.write(result.report)
  process.exitCode = 2
})
`

/** Every entry point throws, whichever one the audit reaches for. */
const DS_LINT_STUB = `"use strict"

function boom() {
  throw new Error("ds-lint: the configured rule set failed to load")
}

exports.lint = boom
exports.run = boom
exports.check = boom
exports.default = boom
`

const DS_LINT_CLI = `#!/usr/bin/env node
"use strict"

process.stderr.write("ds-lint: the configured rule set failed to load\\n")
process.exit(1)
`

/** Installed, inert, and applicable only to a Tailwind project. */
const SHADCN_STUB = `"use strict"

exports.rules = {}
exports.default = { rules: {} }
`

/**
 * The host's ESLint, because shadcn/lint is a plugin for it rather than a
 * linter of its own.
 *
 * Installed in EVERY project that has `@shadcn/lint`, the custom-property one
 * included, so that the availability pair below differs in exactly one thing:
 * whether the project uses Tailwind. No case asks the audit to RUN the Tailwind
 * checker, so this only has to resolve.
 */
const ESLINT_STUB = `"use strict"

class ESLint {
  async lintFiles() {
    return []
  }
}

exports.ESLint = ESLint
exports.default = { ESLint: ESLint }
`

const PLUGIN_STUB = `"use strict"

exports.rules = {}
exports.default = { rules: {} }
`

/**
 * postcss, reduced to the four things the audit asks of it.
 *
 * `selector` is the whole reason a marker can exist — a finding is a file and a
 * line, and a marker needs an element — so a fixture that could not resolve one
 * would leave the most load-bearing field in the payload permanently null and
 * every assertion about it vacuously true. The real parser is not resolvable
 * from this repo (it arrives as a dependency of the host's own stylelint, which
 * this project does not have), so this is a scanner for FLAT stylesheets:
 * rules, declarations, comments, and nothing else. It is enough for the two
 * fixtures above and would be wrong for anything with nesting or an at-rule
 * block in it — which is why neither fixture has one.
 *
 * What it reports is `node.source.start` / `node.source.end` in postcss's own
 * one-based line/column terms, so what is under test is the audit's WALK of the
 * tree, not this parser.
 */
const POSTCSS_STUB = `"use strict"

function at(text, index) {
  const before = text.slice(0, index)
  const line = before.split("\\n").length
  return { line: line, column: index - (before.lastIndexOf("\\n") + 1) + 1 }
}

function skipTrivia(text, index) {
  for (;;) {
    while (index < text.length && /\\s/.test(text[index])) index += 1
    if (text.startsWith("/*", index)) {
      const close = text.indexOf("*/", index + 2)
      index = close === -1 ? text.length : close + 2
      continue
    }
    return index
  }
}

function parse(text) {
  const rules = []
  const declarations = []
  let index = 0

  while (index < text.length) {
    index = skipTrivia(text, index)
    if (index >= text.length) break

    const preludeStart = index
    while (index < text.length && text[index] !== "{" && text[index] !== ";" && text[index] !== "}") {
      index += 1
    }
    if (index >= text.length) break
    if (text[index] !== "{") {
      // A stray top-level statement — an @import, a leftover semicolon. Not a
      // rule and not a declaration in any block, so nothing records it.
      index += 1
      continue
    }

    const selector = text.slice(preludeStart, index).trim()
    const bodyStart = index + 1
    let close = bodyStart
    let depth = 1
    while (close < text.length && depth > 0) {
      if (text[close] === "{") depth += 1
      else if (text[close] === "}") depth -= 1
      if (depth === 0) break
      close += 1
    }

    const body = text.slice(bodyStart, close)
    let cursor = 0
    while (cursor < body.length) {
      const relative = skipTrivia(body, cursor)
      if (relative >= body.length) break
      let end = relative
      while (end < body.length && body[end] !== ";") end += 1
      const declaration = body.slice(relative, end)
      const colon = declaration.indexOf(":")
      if (colon !== -1 && declaration.trim()) {
        declarations.push({
          prop: declaration.slice(0, colon).trim(),
          source: {
            start: at(text, bodyStart + relative),
            end: at(text, bodyStart + Math.min(end, body.length - 1)),
          },
        })
      }
      cursor = end + 1
    }

    rules.push({
      selector: selector,
      source: { start: at(text, preludeStart), end: at(text, close) },
    })
    index = close + 1
  }

  return {
    walkRules: function (visit) {
      rules.forEach(visit)
    },
    walkDecls: function (visit) {
      declarations.forEach(visit)
    },
  }
}

exports.parse = parse
exports.default = { parse: parse }
`

// ── The project ────────────────────────────────────────────────────────────

/**
 * A throwaway project, assembled from flags so each case states the ONE thing
 * it is about.
 *
 * `fs.realpath` on the root before anything else, because `os.tmpdir()` on
 * macOS is itself a symlink and a store that resolves real paths on one side of
 * a comparison and not the other refuses every file in the project.
 */
async function project({
  stylelint = true,
  shadcn = true,
  dsLint = false,
  tailwind = false,
} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "de-audit-")))
  const write = async (relative, contents, mode) => {
    const file = path.join(root, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, contents, "utf8")
    if (mode) await fs.chmod(file, mode)
    return file
  }
  /** A resolvable package in the PROJECT's node_modules, never in this one's. */
  const install = async (name, manifest, files) => {
    await write(`node_modules/${name}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`)
    for (const [relative, contents] of Object.entries(files)) {
      await write(`node_modules/${name}/${relative}`, contents, relative.endsWith("cli.js") ? 0o755 : undefined)
    }
  }

  const manifest = {
    name: "temp-audit-host",
    version: "0.0.0",
    private: true,
    devDependencies: {},
  }
  if (stylelint) {
    manifest.devDependencies.stylelint = "^16.0.0"
    manifest.devDependencies["stylelint-design-tokens"] = "^1.0.0"
  }
  if (shadcn) {
    manifest.devDependencies["@shadcn/lint"] = "^0.3.0"
    manifest.devDependencies.eslint = "^9.0.0"
  }
  if (dsLint) manifest.devDependencies["ds-lint"] = "^2.0.0"
  if (tailwind) manifest.devDependencies.tailwindcss = "^4.0.0"

  await write("package.json", `${JSON.stringify(manifest, null, 2)}\n`)
  await write("src/styles/panel.css", PANEL_CSS)
  await write("src/styles/card.css", CARD_CSS)

  if (stylelint) {
    await write(".stylelintrc.json", STYLELINT_CONFIG)
    await install(
      "stylelint",
      { name: "stylelint", version: "16.24.0", main: "index.js", bin: { stylelint: "./cli.js" } },
      { "index.js": STYLELINT_STUB, "cli.js": STYLELINT_CLI }
    )
    await install(
      "stylelint-design-tokens",
      { name: "stylelint-design-tokens", version: "1.4.0", main: "index.js" },
      { "index.js": PLUGIN_STUB }
    )
    // postcss arrives as stylelint's own dependency on a real host, and the
    // audit resolves it the same way it resolves the checkers: from the
    // project. Installed here alongside stylelint so a fixture never has one
    // without the other.
    await install(
      "postcss",
      { name: "postcss", version: "8.5.6", main: "index.js" },
      { "index.js": POSTCSS_STUB }
    )
    await fs.mkdir(path.join(root, "node_modules/.bin"), { recursive: true })
    await fs.symlink(
      path.join(root, "node_modules/stylelint/cli.js"),
      path.join(root, "node_modules/.bin/stylelint")
    )
  }
  if (shadcn) {
    await install(
      "@shadcn/lint",
      { name: "@shadcn/lint", version: "0.3.0", main: "index.js" },
      { "index.js": SHADCN_STUB }
    )
    await install(
      "eslint",
      { name: "eslint", version: "9.40.0", main: "index.js" },
      { "index.js": ESLINT_STUB }
    )
  }
  if (dsLint) {
    await write("dslint.config.json", '{ "rules": { "token-usage": "error" } }\n')
    await install(
      "ds-lint",
      { name: "ds-lint", version: "2.1.0", main: "index.js", bin: { "ds-lint": "./cli.js" } },
      { "index.js": DS_LINT_STUB, "cli.js": DS_LINT_CLI }
    )
    await fs.mkdir(path.join(root, "node_modules/.bin"), { recursive: true })
    await fs.symlink(
      path.join(root, "node_modules/ds-lint/cli.js"),
      path.join(root, "node_modules/.bin/ds-lint")
    )
  }
  if (tailwind) {
    await write("tailwind.config.js", "export default { content: [\"./src/**/*\"] }\n")
    await write("src/styles/tailwind.css", TAILWIND_CSS)
  }

  const config = resolveConfig({ projectRoot: root }, { cwd: root })
  return {
    root,
    config,
    write,
    read: (relative) => fs.readFile(path.join(root, relative), "utf8"),
    lint: createDesignLint(config),
    ignoreFile: path.join(config.stateDir, "lint-ignored.json"),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

/** Runs a case against its own project directory, and always cleans up. */
async function withProject(name, options, fn) {
  await check(name, async () => {
    const context = await project(options)
    try {
      await fn(context)
    } finally {
      await context.cleanup()
    }
  })
}

// ── Reading the answers ────────────────────────────────────────────────────

/*
 * §1 gives the ROUTE payloads (`{ tools }`, `{ findings, ranAt, tools }`) and
 * not the return shape of the methods underneath them. Both readings are
 * accepted here rather than guessed at, so a lane that returns the bare array
 * fails on a claim about the audit instead of on a wrapper.
 */
const toolList = (answer) => (Array.isArray(answer) ? answer : (answer?.tools ?? []))
const findingList = (answer) => (Array.isArray(answer) ? answer : (answer?.findings ?? []))
const idList = (answer) =>
  Array.isArray(answer) ? answer : (answer?.ids ?? answer?.ignored ?? [])

const toolNamed = (answer, id) => toolList(answer).find((tool) => tool.id === id) ?? null
const ids = (findings) => findings.map((finding) => finding.id)
const bySnippet = (findings, snippet) =>
  findings.filter((finding) => finding.snippet === snippet)
const oneWith = (findings, fragment) => {
  const matched = findings.filter((finding) => finding.message.includes(fragment))
  assert.equal(matched.length, 1, `${matched.length} findings say ${JSON.stringify(fragment)}`)
  return matched[0]
}

/** Only stylelint, so a case about findings is never about tool discovery. */
const STYLELINT_ONLY = { tools: ["stylelint"] }

// ── Which checkers this project may run ────────────────────────────────────

console.log("\nSurfacing the checkers dynamically, from the project")

await withProject("stylelint is available on a project configured for it", {}, async ({ lint }) => {
  const answer = await lint.tools()
  const tools = toolList(answer)
  assert.deepEqual(
    tools.map((tool) => tool.id).sort(),
    ["ds-lint", "shadcn", "stylelint"],
    "a checker was left out of the list rather than reported unavailable"
  )
  for (const tool of tools) {
    assert.equal(typeof tool.name, "string")
    assert.ok(tool.name.length > 0, `${tool.id} has no display name`)
    assert.equal(typeof tool.available, "boolean")
    assert.equal(typeof tool.reason, "string")
    assert.ok(tool.reason.length > 0, `${tool.id} is reported with no reason`)
    assert.ok(
      tool.configFile === null || typeof tool.configFile === "string",
      `${tool.id} reports a configFile that is neither a path nor null`
    )
  }

  const stylelint = toolNamed(answer, "stylelint")
  assert.equal(stylelint.available, true, `stylelint was refused: ${stylelint.reason}`)
  assert.match(stylelint.configFile ?? "", /\.stylelintrc\.json$/)
})

/*
 * The case this file exists for.
 *
 * Not a preference. `@shadcn/lint` reads Tailwind classes, its token discovery
 * returns null against a custom-property system, and its unknown-class rule
 * reported 7,865 ordinary class names as errors on one real project. Running it
 * on a non-Tailwind host does not make the audit stricter; it makes every other
 * finding unfindable. The reason has to SAY Tailwind, because a chip that reads
 * "not available" and nothing else is indistinguishable from a broken install.
 */
await withProject(
  "shadcn is unavailable, and names Tailwind, on a custom-property project",
  {},
  async ({ lint }) => {
    const shadcn = toolNamed(await lint.tools(), "shadcn")
    assert.ok(shadcn, "shadcn is missing from the list rather than reported unavailable")
    assert.equal(
      shadcn.available,
      false,
      "shadcn would run on a project with no Tailwind in it, which is thousands of false positives"
    )
    assert.match(
      shadcn.reason,
      /tailwind/i,
      `the reason never says why: ${JSON.stringify(shadcn.reason)}`
    )
  }
)

/*
 * The mirror, without which the case above is satisfied by deleting the
 * checker: the package is resolvable in both projects and only the Tailwind
 * evidence differs.
 */
await withProject(
  "shadcn becomes available once the project really is a Tailwind project",
  { tailwind: true },
  async ({ lint }) => {
    const shadcn = toolNamed(await lint.tools(), "shadcn")
    assert.equal(shadcn.available, true, `shadcn stayed off a Tailwind host: ${shadcn.reason}`)
  }
)

await withProject(
  "a project with none of them installed reports three reasons, not an empty list",
  { stylelint: false, shadcn: false },
  async ({ lint }) => {
    const tools = toolList(await lint.tools())
    assert.equal(tools.length, 3, `${tools.length} checkers were reported`)
    for (const tool of tools) {
      assert.equal(tool.available, false, `${tool.id} claims it can run with nothing installed`)
      assert.ok(tool.reason.length > 0, `${tool.id} is unavailable for no stated reason`)
    }
  }
)

/*
 * The configuration spellings are probed all at once, and the answer must still
 * be the one a probe in list order gives: the earliest spelling present wins,
 * whichever read happens to finish first.
 */
await withProject(
  "the earliest configuration spelling wins when several are present",
  { tailwind: true },
  async ({ lint, write }) => {
    await write(".stylelintrc", STYLELINT_CONFIG)
    await write("tailwind.config.cjs", "module.exports = {}\n")
    const tools = await lint.tools()
    assert.equal(toolNamed(tools, "stylelint").configFile, ".stylelintrc")
    assert.equal(toolNamed(tools, "shadcn").configFile, "tailwind.config.js")
  }
)

// ── What a finding is ──────────────────────────────────────────────────────

console.log("\nOne list, whatever produced it")

await withProject("a run normalizes every finding into the documented shape", {}, async ({ lint }) => {
  const answer = await lint.run(STYLELINT_ONLY)
  const findings = findingList(answer)
  assert.equal(findings.length, 5, `the fixture's five violations came back as ${findings.length}`)
  assert.ok(answer.ranAt, "the run does not say when it ran")

  for (const finding of findings) {
    assert.equal(typeof finding.id, "string")
    assert.ok(finding.id.length > 0)
    assert.equal(finding.tool, "stylelint")
    assert.match(finding.rule, /^design-tokens\//)
    assert.ok(
      finding.severity === "error" || finding.severity === "warning",
      `severity ${JSON.stringify(finding.severity)} is neither`
    )
    for (const key of ["line", "column", "endLine", "endColumn"]) {
      assert.equal(typeof finding[key], "number", `${key} is not a number`)
      assert.ok(finding[key] > 0, `${key} is ${finding[key]}`)
    }
    // Project-relative POSIX, because the panel prints it and the marker layer
    // keys on it. An absolute path here puts /Users/<name>/ in a screen-share.
    assert.equal(finding.file.includes("\\"), false, `${finding.file} is not POSIX`)
    assert.equal(path.isAbsolute(finding.file), false, `${finding.file} is absolute`)
    assert.match(finding.file, /^src\/styles\/(panel|card)\.css$/)
    assert.equal(typeof finding.snippet, "string")
    assert.ok(finding.snippet.length > 0, "a finding covers no source text")
    assert.ok(
      finding.selector === null || typeof finding.selector === "string",
      "selector is neither a selector nor null"
    )
    assert.ok(
      finding.property === null || typeof finding.property === "string",
      "property is neither a property nor null"
    )
    // The tool's own sentence, minus the trailing rule name it repeats. The
    // rule is already its own field and the panel prints both.
    assert.equal(typeof finding.message, "string")
    assert.doesNotMatch(
      finding.message,
      /\((?:design-tokens|[a-z-]+)\/[a-z-]+\)\s*$/,
      `the message still carries its rule name: ${JSON.stringify(finding.message)}`
    )
  }

  const literals = findings.map((finding) => finding.snippet).sort()
  assert.deepEqual(literals, [
    "#6d3af2",
    "--corner-tiny",
    "rgba(24, 28, 33, 0.06)",
    "rgba(8, 10, 12, 0.16)",
    "rgba(8, 10, 12, 0.16)",
  ])
})

/*
 * The field the canvas cannot do without.
 *
 * A finding is a file and a line; a marker needs an ELEMENT. The enclosing
 * rule's selector is the only bridge between the two, so a null here is a
 * finding the designer can read in the list and never see on the page. The
 * pseudo-class is kept exactly as written — stripping it is the marker layer's
 * job, and a server that guessed at it would hand the panel a selector that
 * matches nothing it can explain.
 */
await withProject("a finding names the selector and property its marker needs", {}, async ({ lint }) => {
  const findings = findingList(await lint.run(STYLELINT_ONLY))

  const panel = oneWith(findings, "Use var(--ink-surface-hover)")
  assert.equal(panel.selector, ".panel", "the finding cannot be resolved to an element")
  assert.equal(panel.property, "background-color")

  const title = oneWith(findings, "Nearest:")
  assert.equal(title.selector, ".panel__title:hover")
  assert.equal(title.property, "color")

  const radius = oneWith(findings, "Did you mean --corner-small?")
  assert.equal(radius.selector, ".panel")
  assert.equal(radius.property, "border-radius")
})

/*
 * The id, and the one thing it must not be made of.
 *
 * An ignore is stored against it and has to survive a run. Hash the line number
 * in and the first edit at the top of a file resurrects every ignore below —
 * quietly, and worst for whoever dismissed the most.
 */
await withProject("an id is the same across two runs of an unchanged project", {}, async ({ lint }) => {
  const first = ids(findingList(await lint.run(STYLELINT_ONLY))).sort()
  const second = ids(findingList(await lint.run(STYLELINT_ONLY))).sort()
  assert.deepEqual(second, first, "a second run of the same bytes produced different ids")
  assert.equal(new Set(first).size, first.length, "two findings share one id")
})

await withProject(
  "an id survives an edit to a line ABOVE the finding it names",
  {},
  async ({ lint, read, write }) => {
    const before = findingList(await lint.run(STYLELINT_ONLY)).filter(
      (finding) => finding.file === "src/styles/panel.css"
    )
    assert.equal(before.length, 3)

    // Two lines of comment at the very top: every finding in the file moves
    // down, and not one of them is about anything that changed.
    const source = await read("src/styles/panel.css")
    await write("src/styles/panel.css", `/* A note the designer added. */\n/* And a second line. */\n${source}`)

    const after = findingList(await lint.run(STYLELINT_ONLY)).filter(
      (finding) => finding.file === "src/styles/panel.css"
    )
    assert.deepEqual(
      ids(after).sort(),
      ids(before).sort(),
      "editing a line above a finding changed its id, so every ignore in the file is back"
    )
    // And the edit really did move things, or the claim above is vacuous.
    const lineOf = (list, snippet) => bySnippet(list, snippet)[0]?.line
    assert.equal(
      lineOf(after, "#6d3af2"),
      lineOf(before, "#6d3af2") + 2,
      "the fixture edit did not move the finding at all"
    )
  }
)

await withProject(
  "the same literal twice in one declaration is two findings with two ids",
  {},
  async ({ lint }) => {
    const twins = bySnippet(
      findingList(await lint.run(STYLELINT_ONLY)),
      "rgba(8, 10, 12, 0.16)"
    )
    assert.equal(twins.length, 2, `the doubled literal came back ${twins.length} times`)
    assert.equal(twins[0].file, twins[1].file)
    assert.equal(twins[0].selector, twins[1].selector)
    assert.equal(twins[0].property, twins[1].property)
    assert.notEqual(
      twins[0].id,
      twins[1].id,
      "both halves of the gradient share one id, so ignoring one ignores both"
    )
  }
)

// ── What may be fixed, and what may only be reported ───────────────────────

console.log("\nA replacement the tool named, or none at all")

await withProject("a message naming Use var(--x) carries that replacement", {}, async ({ lint }) => {
  const finding = oneWith(findingList(await lint.run(STYLELINT_ONLY)), "Use var(--ink-surface-hover)")
  assert.ok(finding.fix, "the one message that names its own replacement is reported unfixable")
  assert.equal(finding.fix.replacement, "var(--ink-surface-hover)")
  assert.equal(finding.snippet, "rgba(24, 28, 33, 0.06)")
})

await withProject("a message asking Did you mean --x? carries that token", {}, async ({ lint }) => {
  const finding = oneWith(findingList(await lint.run(STYLELINT_ONLY)), "Did you mean --corner-small?")
  assert.ok(finding.fix, "a single named token is a confident replacement and was dropped")
  assert.equal(finding.fix.replacement, "--corner-small")
  assert.equal(finding.snippet, "--corner-tiny")
})

/*
 * The one that must stay null.
 *
 * `Nearest: --a, --b, --c` is three guesses. Picking one for the designer is
 * how an Auto Fix silently changes a colour nobody chose, and the diff it
 * leaves behind is indistinguishable from a correct fix.
 */
await withProject("a message that only lists nearest candidates is not fixable", {}, async ({ lint }) => {
  const findings = findingList(await lint.run(STYLELINT_ONLY))

  const candidates = oneWith(findings, "Nearest:")
  assert.equal(
    candidates.fix,
    null,
    `three candidates were turned into one fix: ${JSON.stringify(candidates.fix)}`
  )

  // And the plainest unfixable message of all, which names nothing.
  for (const twin of bySnippet(findings, "rgba(8, 10, 12, 0.16)")) {
    assert.equal(twin.fix, null, "a colour with no matching token was given a replacement anyway")
  }

  assert.equal(
    findings.filter((finding) => finding.fix).length,
    2,
    "the fixable count is not the two messages that name a replacement"
  )
})

console.log("\nWriting it back")

await withProject(
  "fixing two findings in one file splices both and leaves every other byte alone",
  {},
  async ({ lint, read }) => {
    const before = await read("src/styles/panel.css")
    const otherBefore = await read("src/styles/card.css")
    const findings = findingList(await lint.run(STYLELINT_ONLY))
    const fixable = findings.filter((finding) => finding.fix)
    assert.equal(fixable.length, 2)

    const answer = await lint.fix({ ids: ids(fixable) })
    assert.deepEqual(answer.failed, [], `a fix the audit offered then refused: ${JSON.stringify(answer.failed)}`)
    assert.deepEqual(answer.fixed.slice().sort(), ids(fixable).sort())

    // Byte equality against the original with exactly two substitutions, not
    // "the token is present now": a fix that reformatted the file on its way
    // through would pass the weaker check and lose the designer's comments.
    const expected = before
      .replace("rgba(24, 28, 33, 0.06)", "var(--ink-surface-hover)")
      .replace("var(--corner-tiny)", "var(--corner-small)")
    assert.equal(await read("src/styles/panel.css"), expected)
    assert.equal(await read("src/styles/card.css"), otherBefore, "a file with no requested fix was rewritten")

    // The declarations that were never fixable are still exactly where they were.
    const after = await read("src/styles/panel.css")
    assert.ok(after.includes("#6d3af2"), "an unfixable literal was changed by a fix of its neighbours")
    assert.ok(after.includes("--ink-surface-hover: rgba(24, 28, 33, 0.04);"), "the token declaration was spliced")
  }
)

/*
 * The file moved under us.
 *
 * A designer who fixed one by hand between the run and the Auto Fix is the
 * ordinary case, not an edge one. The recorded range no longer holds the text
 * the finding was about, so the only safe answer is to report it and write
 * nothing: a blind splice at a stale range does not miss a fix, it corrupts a
 * working stylesheet.
 */
await withProject(
  "a finding whose snippet has moved is failed rather than force-written",
  {},
  async ({ lint, read, write }) => {
    const finding = oneWith(findingList(await lint.run(STYLELINT_ONLY)), "Use var(--ink-surface-hover)")

    const edited = (await read("src/styles/panel.css")).replace(
      "background-color: rgba(24, 28, 33, 0.06);",
      "background-color: var(--ink-surface-hover);\n  padding-block: var(--space-tight);"
    )
    await write("src/styles/panel.css", edited)

    const answer = await lint.fix({ ids: [finding.id] })
    assert.deepEqual(answer.fixed, [], "a finding that is no longer in the file was reported fixed")
    assert.equal(answer.failed.length, 1, `${answer.failed.length} failures for one stale finding`)
    assert.equal(answer.failed[0].id, finding.id)
    assert.equal(typeof answer.failed[0].reason, "string")
    assert.ok(answer.failed[0].reason.length > 0, "the failure has no reason the panel can print")
    assert.equal(await read("src/styles/panel.css"), edited, "the designer's own edit was overwritten")
  }
)

// ── Ignores ────────────────────────────────────────────────────────────────

console.log("\nDismissing a finding, and taking it back")

await withProject("an ignore is persisted and survives a new instance", {}, async ({ lint, config, ignoreFile }) => {
  const finding = findingList(await lint.run(STYLELINT_ONLY))[0]
  const answer = await lint.ignore({ ids: [finding.id] })
  assert.deepEqual(idList(answer), [finding.id])

  const stored = JSON.parse(await fs.readFile(ignoreFile, "utf8"))
  assert.deepEqual(Object.keys(stored), ["ids"], `lint-ignored.json holds ${Object.keys(stored).join(", ")}`)
  assert.deepEqual(stored.ids, [finding.id])

  // A second process — which is what a restart is.
  const reopened = createDesignLint(config)
  assert.deepEqual(idList(await reopened.ignored()), [finding.id], "the ignore was lost with the instance")
})

/*
 * Returned, and flagged. Filtering ignored findings out server-side would make
 * an ignore impossible to undo: the panel can only offer Unignore for a row it
 * can still see, and §2's "Show ignored (n)" disclosure has nothing to list.
 */
await withProject("an ignored finding still comes back, flagged", {}, async ({ lint }) => {
  const before = findingList(await lint.run(STYLELINT_ONLY))
  const target = before[0]
  await lint.ignore({ ids: [target.id] })

  const answer = await lint.run(STYLELINT_ONLY)
  const after = findingList(answer)
  assert.equal(after.length, before.length, "an ignored finding was filtered out of the run")
  const returned = after.find((finding) => finding.id === target.id)
  assert.ok(returned, "the ignored finding is gone, so nothing can unignore it")

  // §1 says "flagged" and its interface does not name the field, so both
  // spellings are accepted: a flag on the finding, or a list beside it.
  const flagged =
    returned.ignored === true || idList(answer.ignored ?? []).includes(target.id)
  assert.ok(flagged, "the ignored finding comes back indistinguishable from a live one")

  const others = after.filter((finding) => finding.id !== target.id)
  assert.equal(
    others.some((finding) => finding.ignored === true),
    false,
    "everything came back flagged as ignored"
  )
})

await withProject("unignoring puts it back", {}, async ({ lint, ignoreFile }) => {
  const target = findingList(await lint.run(STYLELINT_ONLY))[0]
  await lint.ignore({ ids: [target.id] })
  const answer = await lint.unignore({ ids: [target.id] })
  assert.deepEqual(idList(answer), [], `unignore answered with ${JSON.stringify(answer)}`)
  assert.deepEqual(idList(await lint.ignored()), [])

  const stored = JSON.parse(await fs.readFile(ignoreFile, "utf8"))
  assert.deepEqual(stored.ids, [], "the id is gone from memory and still on disk")

  const returned = findingList(await lint.run(STYLELINT_ONLY)).find(
    (finding) => finding.id === target.id
  )
  assert.notEqual(returned.ignored, true, "the finding is still flagged after an unignore")
})

// ── One tool failing ───────────────────────────────────────────────────────

console.log("\nA broken checker is one checker, not the audit")

/*
 * The stub `ds-lint` throws from every entry point it has, and exits 1 from its
 * bin, so whichever way the audit invokes it the invocation fails. What must
 * not happen is stylelint's five findings going down with it — a project whose
 * ds-lint install is broken would then report as clean, which is the one answer
 * an audit must never give wrongly.
 *
 * The SHAPE of the error report is not in §1 — it says only "a clear error if a
 * tool crashes" — so the assertion is that the answer names the tool somewhere
 * alongside a failure, rather than a guess at a field name.
 */
await withProject("one tool crashing still returns the other's findings", { dsLint: true }, async ({ lint }) => {
  const tools = toolList(await lint.tools())
  assert.equal(toolNamed(tools, "ds-lint")?.available, true, "the fixture's ds-lint was never offered")

  const answer = await lint.run({ tools: ["stylelint", "ds-lint"] })
  const findings = findingList(answer)
  assert.equal(findings.length, 5, `a crashing checker cost the run ${5 - findings.length} findings`)
  assert.ok(
    findings.every((finding) => finding.tool === "stylelint"),
    "the crashing tool produced findings anyway"
  )

  const said = JSON.stringify(answer)
  assert.ok(said.includes("ds-lint"), "the run never mentions the checker that failed")
  assert.match(
    said,
    /error|fail|crash/i,
    "the crash is reported as silence, so the panel says the project is clean"
  )
})

// ── The routes ─────────────────────────────────────────────────────────────

console.log("\nThe five endpoints the panel reaches all of this through")

/** The routes over a real loopback socket, because the guard reads the socket. */
async function server(context) {
  const routes = createDesignLayerRoutes(context.config)
  const listener = http.createServer((request, response) => {
    if (routes.handle(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${listener.address().port}${context.config.apiPrefix}/lint`
  return {
    base,
    json: async (url, init) => {
      const response = await fetch(url, init)
      return { status: response.status, body: await response.json() }
    },
    send: (method, body) => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    close: () => new Promise((resolve) => listener.close(resolve)),
  }
}

await withProject("every lint endpoint answers over loopback", {}, async (context) => {
  const api = await server(context)
  try {
    const tools = await api.json(`${api.base}/tools`)
    assert.equal(tools.status, 200)
    assert.ok(Array.isArray(tools.body.tools), "GET /lint/tools is not a list of tools")
    assert.equal(tools.body.tools.length, 3)

    const run = await api.json(`${api.base}/run`, api.send("POST", { tools: ["stylelint"] }))
    assert.equal(run.status, 200)
    assert.equal(run.body.findings.length, 5)
    assert.ok(run.body.ranAt, "the run payload does not say when it ran")
    assert.ok(Array.isArray(run.body.tools), "the run payload does not say what it ran")

    const target = run.body.findings.find((finding) => finding.fix)
    const ignored = await api.json(`${api.base}/ignore`, api.send("POST", { ids: [target.id] }))
    assert.equal(ignored.status, 200)
    assert.deepEqual(ignored.body.ignored, [target.id])

    const restored = await api.json(`${api.base}/ignore`, api.send("DELETE", { ids: [target.id] }))
    assert.equal(restored.status, 200)
    assert.deepEqual(restored.body.ignored, [])

    const fixed = await api.json(`${api.base}/fix`, api.send("POST", { ids: [target.id] }))
    assert.equal(fixed.status, 200)
    assert.deepEqual(fixed.body.fixed, [target.id])
    assert.deepEqual(fixed.body.failed, [])
    assert.ok(
      (await context.read(target.file)).includes(target.fix.replacement),
      "the route answered fixed and wrote nothing"
    )
  } finally {
    await api.close()
  }
})

await withProject("a fix with no ids is a 400, not a 500", {}, async (context) => {
  const api = await server(context)
  try {
    const empty = await fetch(`${api.base}/fix`, api.send("POST", {}))
    assert.equal(empty.status, 400, `POST /lint/fix with no ids answered ${empty.status}`)
    const unknown = await fetch(`${api.base}/nowhere`, { method: "GET" })
    assert.equal(unknown.status, 404, `an unknown lint route answered ${unknown.status}`)
  } finally {
    await api.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
