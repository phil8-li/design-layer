/**
 * The design-system audit: which checkers this project has, what they found,
 * and the narrow set of findings this editor is willing to rewrite for you.
 *
 * A checker already installed in the project is the only kind worth running.
 * This package ships none of its own and resolves every one of them from the
 * PROJECT's `node_modules`, the way `server/variants.mjs` and
 * `server/react-source.mjs` resolve the host's parser: a linter bundled here
 * would be checking the designer's stylesheet against a configuration nobody in
 * their repository wrote, and would disagree with the `npm run lint` their CI
 * runs. The audit is a second face on the check the project already has, never
 * a second opinion about it.
 *
 * Four decisions shape everything below.
 *
 * A CHECKER IS REPORTED, NEVER ASSUMED. `tools()` answers "will this run, and
 * why" for every checker it knows about, from evidence on disk. The failure
 * this prevents is the one that makes an audit worthless: a checker that
 * silently does not run turns "no issues" into a lie, and the user has no way
 * to see the difference between a clean project and a switched-off rule. So an
 * unavailable checker is still returned, with a sentence saying what is missing.
 *
 * APPLICABILITY IS PART OF AVAILABILITY. One of these checkers reads Tailwind
 * utility classes and nothing else — its own token discovery returns null on a
 * design system built out of custom properties, and its unknown-class rule then
 * reports every ordinary class name in the project as an error. Measured on one
 * real project that was 7,865 errors. Running it there is not a stricter audit;
 * it is a wall of false positives that makes every true finding unfindable, and
 * a user who scrolls past a thousand wrong answers stops believing the right
 * ones. So "applicable to this project" is checked as hard as "installed", and
 * a checker that does not apply says so in plain words.
 *
 * A FINDING NEEDS AN ELEMENT, NOT A LINE. Every one of these tools reports a
 * file and a line, which is all a terminal needs and nothing a canvas can use:
 * there is no line number on screen. So each finding is enriched here with the
 * SELECTOR of the rule whose block it sits in, parsed out of the stylesheet
 * with postcss, and that selector is what the marker layer runs against the
 * live DOM. A finding in a template rather than a stylesheet has no enclosing
 * rule, and says so with a null rather than a guess.
 *
 * A FIX IS ONLY EVER ONE THE TOOL NAMED. These messages carry their own remedy,
 * and only sometimes: "Use var(--x)" and "Did you mean --x?" each name exactly
 * one replacement, while a message listing the nearest few candidates names
 * three guesses. Picking one of three for the user is how an audit silently
 * changes a colour nobody chose — so a finding with no single named token is
 * reported as unfixable and the row says why. An Auto Fix that invents a token
 * is worse than no Auto Fix, because the user stops reading the diff.
 *
 * Each tool runs in a CHILD PROCESS. These are third-party checkers walking the
 * whole project, and this process is the one holding the designer's unsaved
 * state: a linter that throws takes only its own child down, a linter that
 * loops is killed at the deadline instead of hanging the editor, and a linter
 * that leaks memory over a large repository exits with the child. It also makes
 * the 60-second bound real rather than decorative — a synchronous checker
 * cannot be preempted by a `Promise.race` inside the process running it, which
 * is exactly the checker most likely to need the bound.
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { applyEdits } from "./element-match.mjs"

/**
 * The checkers this module knows how to drive, and the names the panel shows.
 *
 * These three strings are product names of the checkers themselves, not the
 * vocabulary of any one design system — nothing here knows or cares what a
 * project's tokens are called.
 */
const TOOLS = [
  { id: "stylelint", name: "Tokens (Stylelint)" },
  { id: "ds-lint", name: "ds-lint" },
  { id: "shadcn", name: "shadcn/lint" },
]
const TOOL_IDS = TOOLS.map((tool) => tool.id)

/**
 * A checker gets a minute, then it is killed.
 *
 * Long enough that a first run over a repository with a few thousand
 * stylesheets finishes, short enough that a designer who clicked Audit and is
 * watching a spinner gets an answer rather than a hang. What comes back on a
 * timeout is an error for that one tool; the others' findings are unaffected.
 */
const TOOL_DEADLINE_MS = 60_000

/**
 * The ceiling on one audit.
 *
 * Not a performance guard so much as an honesty one: a project whose
 * configuration is wrong — a token source naming a file the page does not load
 * — produces a finding on nearly every line, and neither a list nor a canvas
 * can show that. Past this the list is truncated and `truncated` says so, which
 * is a panel that can tell the user their configuration is off. Silently
 * showing the first few hundred is a panel that looks like it worked.
 */
const MAX_FINDINGS = 5000

/** One gesture — Fix all over a page's worth of findings — and nothing larger. */
const MAX_IDS_PER_REQUEST = 500

/** Past this a "stylesheet" is a build artifact, and slicing it is a stall. */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024

/** What a child may print before we stop believing it is a findings payload. */
const MAX_CHILD_OUTPUT = 64 * 1024 * 1024

/** A finding id is a hash this module minted; anything else is a client composing one. */
const FINDING_ID_PATTERN = /^[a-f0-9]{16}$/

/** Only these are parsed as CSS. A template has no enclosing rule by construction. */
const STYLESHEET_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".pcss", ".postcss"])

/** Vendored, generated, or somebody else's code — never part of this project's design system. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "tmp",
])

/**
 * Where a checker's configuration is allowed to live.
 *
 * Read as TEXT, never loaded. Three of these five shapes are JavaScript, and
 * loading one executes project code — which is a perfectly reasonable thing to
 * do when the user has asked for an audit and an entirely unreasonable thing to
 * do during a cheap "which checkers exist here" probe that runs every time a
 * panel opens. So detection reads bytes and the checker itself loads the file
 * later, in its own child process, only once the user has asked it to run.
 */
const STYLELINT_CONFIG_FILES = [
  ".stylelintrc",
  ".stylelintrc.json",
  ".stylelintrc.yaml",
  ".stylelintrc.yml",
  ".stylelintrc.js",
  ".stylelintrc.cjs",
  ".stylelintrc.mjs",
  "stylelint.config.js",
  "stylelint.config.cjs",
  "stylelint.config.mjs",
  "stylelint.config.ts",
]

const DS_LINT_CONFIG_FILES = ["dslint.config.json", ".dslintrc.json", ".dslintrc"]

const TAILWIND_CONFIG_FILES = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
  "tailwind.config.cts",
  "tailwind.config.mts",
]

/**
 * The directives that say a stylesheet is Tailwind's, in both of its dialects.
 * v3 pulls in layers with `@tailwind`; v4 declares the theme inline with
 * `@theme` and imports the framework by name.
 */
const TAILWIND_DIRECTIVE = /@tailwind\b|@theme\b|@import\s+["']tailwindcss/

/** What the child prints before its JSON, so a checker's own chatter cannot be mistaken for it. */
const CHILD_SENTINEL = "__design_lint_payload__"
const CHILD_FLAG = "--design-lint-tool"

/** How many stylesheets a Tailwind probe will open before it answers from what it has. */
const MAX_TAILWIND_PROBES = 300
/** Enough of a stylesheet to find a directive that only ever appears at the top of one. */
const TAILWIND_PROBE_BYTES = 64 * 1024

function badRequest(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/** A POSIX, project-relative path, or null for a file outside the project. */
function projectRelative(projectRoot, absolute) {
  const relative = path.relative(projectRoot, absolute)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join("/")
}

/** A resolver rooted at the project, so every checker comes from the project's own tree. */
function projectRequire(projectRoot) {
  return createRequire(path.join(projectRoot, "package.json"))
}

/** The absolute path a package resolves to from the project, or null when it is not installed. */
function resolveFromProject(projectRoot, specifier) {
  try {
    return projectRequire(projectRoot).resolve(specifier)
  } catch {
    return null
  }
}

/** A package's entry point as an import URL, so an ESM-only checker loads. */
function importUrl(resolved) {
  return pathToFileURL(resolved).href
}

async function readTextIfPresent(file, limit = MAX_SOURCE_BYTES) {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > limit) return null
    return await fs.readFile(file, "utf8")
  } catch {
    return null
  }
}

/**
 * The first of `names` present at the project root, as `{ file, text }`.
 *
 * Every candidate is asked for at once and the earliest in the list wins, so the
 * answer is the one a probe in list order gives; one at a time, a panel opening
 * paid a round trip per spelling that is not there. `mayExist` lets a caller
 * that has already listed the root skip the spellings it knows are absent.
 */
async function readFirstPresent(projectRoot, names, mayExist = () => true) {
  const texts = await Promise.all(
    names.map((name) => (mayExist(name) ? readTextIfPresent(path.join(projectRoot, name), 512 * 1024) : null))
  )
  const index = texts.findIndex((text) => text !== null)
  return index === -1 ? null : { file: names[index], text: texts[index] }
}

/**
 * The stylelint configuration this project carries, as the two facts detection
 * and the runner each need: where it is, and what it says.
 *
 * `package.json`'s `stylelint` key counts, because a project with three lines
 * of configuration very reasonably puts them there rather than in a sixth
 * dotfile, and a checker configured that way is just as configured.
 */
async function readStylelintConfig(projectRoot, mayExist) {
  const [found, packageText] = await Promise.all([
    readFirstPresent(projectRoot, STYLELINT_CONFIG_FILES, mayExist),
    readTextIfPresent(path.join(projectRoot, "package.json"), 512 * 1024),
  ])
  if (found !== null) return found
  if (packageText !== null) {
    try {
      const parsed = JSON.parse(packageText)
      if (parsed && typeof parsed === "object" && parsed.stylelint) {
        return { file: "package.json", text: JSON.stringify(parsed.stylelint) }
      }
    } catch {
      // A package.json this process cannot parse is one npm cannot either, and
      // saying so is the host's job rather than the audit's.
    }
  }
  return null
}

/**
 * Whether a stylelint configuration is pointed at design-system compliance
 * rather than at formatting.
 *
 * Stated in generic token vocabulary on purpose. Keying on one plugin's package
 * name would make this feature true for one project and quietly false for the
 * next one, which spells the same idea differently — the same reason the
 * library classifier in `server/library-sources.mjs` reads word segments
 * instead of a vendor's prefix. Any plugin or rule whose name mentions tokens
 * or colour is a configuration that will have something to say about a design
 * system; a config that mentions neither is a formatter, and reporting a
 * formatter as a design-system checker is how a green audit lies.
 */
function checksDesignSystem(configText) {
  return /token|colour|color/i.test(configText)
}

/**
 * Whether the configuration teaches stylelint to read anything that is not CSS.
 *
 * It decides which files the run is pointed at. Handing stylelint an HTML file
 * with no custom syntax configured does not produce findings, it produces a
 * parse error per file — noise that would land in the list looking exactly like
 * a design-system violation. So templates are audited only where the project
 * has said how to read them.
 */
function readsTemplates(configText) {
  return /customSyntax/i.test(configText)
}

/**
 * Whether this project is a Tailwind project, which is the load-bearing half of
 * one checker's availability. See the header: the cost of getting this wrong is
 * thousands of false positives, not a missing check.
 *
 * Two kinds of evidence, both of them things a Tailwind project has and a
 * custom-property design system does not: a config file at the root, or one of
 * the framework's own at-rules in a stylesheet. A dependency in `package.json`
 * deliberately does not count — an installed package is not a used one, and
 * this is the question where a false yes is expensive.
 */
async function detectTailwind(projectRoot, rootEntries, mayExist = () => true) {
  const candidates = TAILWIND_CONFIG_FILES.filter(mayExist)
  if (candidates.length > 0) {
    const configs = await Promise.all(
      candidates.map((name) => fs.stat(path.join(projectRoot, name)).then((stat) => stat.isFile(), () => false))
    )
    const config = configs.indexOf(true)
    if (config !== -1) return { uses: true, evidence: candidates[config] }
  }

  // Depth-first in listing order, as before, but a directory's subdirectories
  // are listed the moment the directory is, so descending into one awaits a
  // listing already on its way instead of a round trip per directory in series.
  // A listing already in hand is taken without an await, so the first of those
  // requests leave before this function first yields.
  const list = (dir) => fs.readdir(dir, { withFileTypes: true }).catch(() => null)
  let probed = 0
  const walk = async (dir, listing) => {
    if (probed >= MAX_TAILWIND_PROBES) return null
    const entries = Array.isArray(listing) ? listing : await listing
    if (!entries) return null
    const children = new Map()
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRECTORIES.has(entry.name)) {
        const full = path.join(dir, entry.name)
        children.set(entry.name, { full, listing: list(full) })
      }
    }
    for (const entry of entries) {
      if (probed >= MAX_TAILWIND_PROBES) return null
      const child = children.get(entry.name)
      if (child) {
        const found = await walk(child.full, child.listing)
        if (found) return found
        continue
      }
      if (entry.name.startsWith(".") || entry.isDirectory()) continue
      if (!STYLESHEET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      const full = path.join(dir, entry.name)
      probed += 1
      const head = await readTextIfPresent(full, TAILWIND_PROBE_BYTES)
      if (head !== null && TAILWIND_DIRECTIVE.test(head)) {
        return { uses: true, evidence: projectRelative(projectRoot, full) ?? entry.name }
      }
    }
    return null
  }

  return (await walk(projectRoot, rootEntries ?? list(projectRoot))) ?? { uses: false, evidence: null }
}

/* -------------------------------------------------------------------------
 * Normalization: one finding shape out of three tools
 * ---------------------------------------------------------------------- */

function normalizeSeverity(value) {
  if (value === 2 || value === "error") return "error"
  return "warning"
}

/**
 * A message with its own rule name taken off the end.
 *
 * Only when the trailing parenthetical IS the rule name — a message that
 * genuinely ends in a parenthetical keeps it, because trimming whatever happens
 * to be in the last brackets would eat the half of the sentence that names the
 * fix.
 */
function cleanMessage(text, rule) {
  const value = String(text ?? "").trim()
  const suffix = ` (${rule})`
  return value.endsWith(suffix) ? value.slice(0, -suffix.length).trim() : value
}

/**
 * The single token a message tells the user to write, or null when it names
 * none, or more than one.
 *
 * Two grammars are a fix, and they are the two that name exactly one token:
 * an explicit "Use var(--x)" instruction, and a "Did you mean --x?" correction.
 * Everything else is null — most importantly a message that lists the nearest
 * few candidates, which reads like a fix and is not one. "Nearest: --a, --b,
 * --c" is the tool saying it does not know; turning that into a one-click Auto
 * Fix would have the editor choose a colour on the user's behalf and report
 * success. Two different tokens named in one message is the same problem and
 * gets the same answer.
 */
function namedToken(message) {
  const named = (pattern) => {
    const found = new Set()
    for (const match of message.matchAll(pattern)) found.add(match[1])
    return found.size === 1 ? [...found][0] : null
  }
  return (
    named(/\buse\s+var\(\s*(--[A-Za-z0-9_-]+)\s*\)/gi) ??
    named(/\bdid you mean\s+(--[A-Za-z0-9_-]+)\s*\?/gi)
  )
}

/**
 * The replacement text for a named token, in the shape the finding's own
 * snippet is in.
 *
 * The two grammars cover ranges of two different kinds. A raw-colour finding
 * covers the literal `rgba(0, 0, 0, .16)`, and replacing it means writing a
 * `var()` call. An undeclared-token finding covers the token NAME inside an
 * existing `var(--typo)` call, and writing `var(--x)` over that would produce
 * `var(var(--x))`. So the shape is read off the snippet rather than off the
 * tool: a range that is already a token name is replaced with a token name.
 */
function replacementFor(message, snippet) {
  if (!snippet) return null
  const token = namedToken(message)
  if (!token) return null
  if (snippet.trim().startsWith("--")) return token
  return `var(${token})`
}

/* -------------------------------------------------------------------------
 * Enrichment: the selector, the property and the exact bytes
 * ---------------------------------------------------------------------- */

/** Byte offsets of each line start, so a 1-based line/column becomes an index. */
function lineStarts(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1)
  }
  return starts
}

function offsetAt(starts, text, line, column) {
  if (!Number.isFinite(line) || !Number.isFinite(column)) return -1
  if (line < 1 || line > starts.length) return -1
  const offset = starts[line - 1] + Math.max(0, column - 1)
  return offset > text.length ? -1 : offset
}

/** A selector as one line, because a marker's tooltip is one line. */
function flattenSelector(selector) {
  const value = String(selector ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return value ? value.slice(0, 300) : null
}

/**
 * Every rule and declaration in a stylesheet, as flat ranges sorted so the
 * innermost containing one can be found by a scan.
 *
 * postcss is resolved from the PROJECT, the same as the checkers — it is
 * already there as their own dependency, and a copy shipped here would be a
 * second CSS parser disagreeing with the one that produced the finding. When it
 * cannot be resolved at all, every selector is null and the marker layer falls
 * back; the audit still works, it just cannot point at anything.
 */
function stylesheetIndex(postcss, text, file) {
  let root
  try {
    root = postcss.parse(text, { from: file })
  } catch {
    // A file postcss cannot parse is a file with no enclosing rules to find.
    // That is the ordinary case for a template, and a lossy one for a dialect
    // this parser does not speak — either way a null selector is the honest
    // answer and a wrong one would put a marker on the wrong element.
    return null
  }

  const rules = []
  const declarations = []
  const record = (node, into, value) => {
    const start = node.source?.start
    const end = node.source?.end
    if (!start || !end) return
    into.push({
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
      value,
    })
  }

  root.walkRules((rule) => record(rule, rules, flattenSelector(rule.selector)))
  root.walkDecls((declaration) => record(declaration, declarations, declaration.prop))
  return { rules, declarations }
}

function contains(range, line, column) {
  if (line < range.startLine || line > range.endLine) return false
  if (line === range.startLine && column < range.startColumn) return false
  if (line === range.endLine && column > range.endColumn) return false
  return true
}

/**
 * The innermost range covering a position.
 *
 * Innermost rather than outermost because a nested rule — an SCSS nesting, or
 * a rule inside a media query — is the one whose selector actually describes
 * the element the finding sits on. The outer one describes its ancestor, and a
 * marker painted on an ancestor is a marker on the wrong box.
 */
function innermost(ranges, line, column) {
  let best = null
  for (const range of ranges) {
    if (!contains(range, line, column)) continue
    if (
      best === null ||
      range.startLine > best.startLine ||
      (range.startLine === best.startLine && range.startColumn > best.startColumn)
    ) {
      best = range
    }
  }
  return best?.value ?? null
}

/* -------------------------------------------------------------------------
 * The child process: one checker, isolated and on a clock
 * ---------------------------------------------------------------------- */

/**
 * Run one checker in a child and return whatever it printed after the sentinel.
 *
 * The sentinel exists because a checker is free to write to stdout — a plugin
 * logging a deprecation, a config file printing a warning — and a JSON payload
 * with a stray line in front of it is a parse failure reported as a crash. Only
 * what follows the last sentinel is read as the payload.
 *
 * A child that dies without printing one is reported with the tail of its
 * stderr, which is where a module-resolution failure or a stack trace lands.
 * That string reaches the panel, so the user can see WHICH checker failed and
 * roughly why rather than seeing one silently contribute nothing.
 */
function runToolInChild(toolId, projectRoot) {
  const self = fileURLToPath(import.meta.url)
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [self, CHILD_FLAG, toolId, projectRoot], {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      resolve({ error: error?.message ?? `${toolId} could not be started` })
      return
    }

    let out = ""
    let err = ""
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ error: `${toolId} did not finish within ${TOOL_DEADLINE_MS / 1000} seconds` })
    }, TOOL_DEADLINE_MS)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      if (out.length < MAX_CHILD_OUTPUT) out += chunk
    })
    child.stderr.on("data", (chunk) => {
      if (err.length < 8192) err += chunk
    })

    child.on("error", (error) => finish({ error: error?.message ?? `${toolId} could not be run` }))
    child.on("close", (code) => {
      const at = out.lastIndexOf(CHILD_SENTINEL)
      if (at === -1) {
        const tail = err.trim().split("\n").slice(-3).join(" ").slice(0, 400)
        finish({ error: tail || `${toolId} exited with code ${code} and said nothing` })
        return
      }
      try {
        finish(JSON.parse(out.slice(at + CHILD_SENTINEL.length)))
      } catch {
        finish({ error: `${toolId} produced output this editor could not read` })
      }
    })
  })
}

/* -------------------------------------------------------------------------
 * The child's half: each checker's own API, in its own process
 * ---------------------------------------------------------------------- */

/**
 * Stylelint, through its Node API rather than its CLI, and the reason is not
 * taste.
 *
 * `--formatter json` writes to STDERR whenever there are findings, and the
 * process exits 2. A caller reading stdout and treating a non-zero exit as a
 * crash therefore sees an empty, failed run on precisely the projects that have
 * something to report — a checker that appears to work perfectly right up until
 * it finds something. The Node API hands back a structured result and has no
 * opinion about exit codes.
 */
async function childStylelint(projectRoot) {
  const resolved = projectRequire(projectRoot).resolve("stylelint")
  const stylelint = (await import(importUrl(resolved))).default
  const config = await readStylelintConfig(projectRoot)
  const files = ["**/*.css", "**/*.scss", "**/*.sass", "**/*.less"]
  if (config && readsTemplates(config.text)) files.push("**/*.html", "**/*.htm", "**/*.vue")
  for (const skipped of SKIP_DIRECTORIES) files.push(`!**/${skipped}/**`)

  const result = await stylelint.lint({ cwd: projectRoot, files, allowEmptyInput: true })
  const findings = []
  for (const entry of result.results) {
    if (!entry.source) continue
    for (const warning of entry.warnings) {
      // A syntax error is the checker saying "this is not CSS", not the design
      // system saying "this is wrong". It belongs in a build log, and in a list
      // of compliance findings it is indistinguishable from a real violation.
      if (warning.rule === "CssSyntaxError") continue
      findings.push({
        rule: warning.rule ?? "stylelint",
        severity: warning.severity,
        message: warning.text,
        file: entry.source,
        line: warning.line,
        column: warning.column,
        endLine: warning.endLine ?? warning.line,
        endColumn: warning.endColumn ?? warning.column,
      })
    }
  }
  return { findings }
}

/** ds-lint, whose engine takes the project root and its own config object. */
async function childDsLint(projectRoot) {
  const resolved = projectRequire(projectRoot).resolve("ds-lint")
  const { lint } = await import(importUrl(resolved))

  let config = {}
  for (const name of DS_LINT_CONFIG_FILES) {
    const text = await readTextIfPresent(path.join(projectRoot, name), 512 * 1024)
    if (text === null) continue
    try {
      config = JSON.parse(text)
    } catch {
      throw new Error(`${name} is not valid JSON`)
    }
    break
  }

  const result = lint(projectRoot, config)
  return {
    findings: (result?.findings ?? []).map((finding) => ({
      rule: finding.rule ?? "ds-lint",
      severity: finding.severity,
      message: finding.message,
      file: finding.file,
      line: finding.line,
      column: finding.column,
      endLine: finding.line,
      // `length` is how this engine spells an end, and a missing one collapses
      // the range onto the start rather than guessing how far it runs.
      endColumn: finding.column + (Number.isFinite(finding.length) ? finding.length : 0),
      literal: typeof finding.literal === "string" ? finding.literal : null,
      // The engine's own verdict, honoured as a veto and never as a promise: a
      // finding it will not rewrite itself is not one this editor should.
      fixable: finding.fixable !== false,
    })),
  }
}

/**
 * The Tailwind checker, which is an ESLint plugin rather than a linter — so
 * running it means running ESLint with the plugin loaded and its rules turned
 * on. Every rule the plugin declares is enabled at its defaults, because which
 * rules exist is the plugin's business and hardcoding a list here would go
 * stale the first time it ships another one.
 */
async function childShadcn(projectRoot) {
  const require_ = projectRequire(projectRoot)
  let eslintPath
  try {
    eslintPath = require_.resolve("eslint")
  } catch {
    throw new Error("ESLint is not installed in this project, and this checker is a plugin for it")
  }
  const { ESLint } = await import(importUrl(eslintPath))
  const plugin = (await import(importUrl(require_.resolve("@shadcn/lint")))).default

  const rules = {}
  for (const name of Object.keys(plugin?.rules ?? {})) rules[`shadcn/${name}`] = "error"

  const layer = [
    { ignores: [...SKIP_DIRECTORIES].map((skipped) => `**/${skipped}/**`) },
    { files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"], plugins: { shadcn: plugin }, rules },
  ]

  /**
   * The project's own ESLint configuration is used, with the rules layered on
   * top — not replaced.
   *
   * Replacing it looks tidier and silently does nothing useful: the default
   * parser cannot read TypeScript or JSX, so a run over a TSX codebase reports
   * a parse error per file, every parse error is discarded below for having no
   * rule id, and the audit comes back clean on a project full of violations.
   * That is the worst failure this feature has, because it is indistinguishable
   * from success. The parser, the ignores and the settings all have to come
   * from the project that knows what its own files are.
   *
   * The standalone fallback is for a project with no ESLint configuration at
   * all, or one that already registers this plugin under the same name and
   * refuses a second definition of it.
   */
  const lintWith = async (options) => {
    const eslint = new ESLint({ cwd: projectRoot, errorOnUnmatchedPattern: false, ...options })
    return eslint.lintFiles(["."])
  }
  let results
  try {
    results = await lintWith({ overrideConfig: layer })
  } catch {
    results = await lintWith({ overrideConfigFile: true, overrideConfig: layer })
  }
  const findings = []
  for (const entry of results) {
    for (const message of entry.messages) {
      if (!message.ruleId) continue
      findings.push({
        rule: message.ruleId,
        severity: message.severity,
        message: message.message,
        file: entry.filePath,
        line: message.line,
        column: message.column,
        endLine: message.endLine ?? message.line,
        endColumn: message.endColumn ?? message.column,
      })
    }
  }
  return { findings }
}

const CHILD_RUNNERS = {
  stylelint: childStylelint,
  "ds-lint": childDsLint,
  shadcn: childShadcn,
}

/* -------------------------------------------------------------------------
 * The ignore store
 * ---------------------------------------------------------------------- */

/**
 * The finding ids the user has dismissed.
 *
 * One JSON file under the host's state directory, written atomically through
 * the same serialised queue `server/options-store.mjs` uses and for the same
 * reason: two panels dismissing a finding at once must not both read the file
 * and clobber each other's entry. The state directory comes from the resolved
 * config, never from `import.meta.url` — once this package is installed,
 * `../../` is `node_modules/`, and every dismissal would land inside a
 * dependency instead of the host project.
 */
function createIgnoreStore({ stateDir }) {
  const storeDir = path.resolve(stateDir)
  const ignoreFile = path.join(storeDir, "lint-ignored.json")
  let queue = Promise.resolve()

  function serial(task) {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async function readFileIds() {
    let parsed
    try {
      parsed = JSON.parse(await fs.readFile(ignoreFile, "utf8"))
    } catch {
      // Missing or corrupt: nothing is ignored, and the next write heals it.
      return []
    }
    const rows = Array.isArray(parsed?.ids) ? parsed.ids : []
    const ids = []
    const seen = new Set()
    for (const row of rows) {
      if (typeof row !== "string" || !FINDING_ID_PATTERN.test(row) || seen.has(row)) continue
      seen.add(row)
      ids.push(row)
      if (ids.length >= MAX_FINDINGS) break
    }
    return ids
  }

  async function writeFileIds(ids) {
    await fs.mkdir(storeDir, { recursive: true })
    const temp = `${ignoreFile}.${process.pid}.tmp`
    await fs.writeFile(temp, `${JSON.stringify({ ids }, null, 2)}\n`, "utf8")
    await fs.rename(temp, ignoreFile)
  }

  return {
    read() {
      return serial(readFileIds)
    },

    add(ids) {
      return serial(async () => {
        const current = await readFileIds()
        const merged = [...new Set([...current, ...ids])].slice(0, MAX_FINDINGS)
        await writeFileIds(merged)
        return merged
      })
    },

    remove(ids) {
      return serial(async () => {
        const dropped = new Set(ids)
        const kept = (await readFileIds()).filter((id) => !dropped.has(id))
        await writeFileIds(kept)
        return kept
      })
    },
  }
}

/* -------------------------------------------------------------------------
 * The store
 * ---------------------------------------------------------------------- */

/** Ids a request may name: hashes this module minted, and nothing a client composed. */
function readIds(body) {
  const ids = Array.isArray(body?.ids) ? body.ids : null
  if (!ids) throw badRequest("This needs an array of finding ids")
  if (ids.length > MAX_IDS_PER_REQUEST) {
    throw badRequest(`No more than ${MAX_IDS_PER_REQUEST} findings in one request`)
  }
  const clean = []
  for (const id of ids) {
    if (typeof id !== "string" || !FINDING_ID_PATTERN.test(id)) {
      throw badRequest("A finding id is not one this audit produced")
    }
    clean.push(id)
  }
  return [...new Set(clean)]
}

/** One audit per project. */
export function createDesignLint(config) {
  const projectRoot = path.resolve(config.projectRoot)
  const ignores = createIgnoreStore({ stateDir: config.stateDir })

  /**
   * postcss, resolved from the project and remembered, because an audit parses
   * every stylesheet that has a finding in it and resolving the parser once per
   * file would be the slowest part of a run.
   */
  let cachedPostcss
  async function loadPostcss() {
    if (cachedPostcss !== undefined) return cachedPostcss
    const resolved = resolveFromProject(projectRoot, "postcss")
    if (resolved === null) {
      cachedPostcss = null
      return cachedPostcss
    }
    try {
      const loaded = await import(importUrl(resolved))
      cachedPostcss = loaded.default ?? loaded
    } catch {
      cachedPostcss = null
    }
    return cachedPostcss
  }

  /** Every checker, with whether it will run here and the one sentence saying why. */
  async function describeTools() {
    // Every configuration file this asks about sits at the project root, so one
    // listing of it settles which of some twenty spellings are worth a stat, and
    // is the first directory the Tailwind walk needs anyway. Compared without
    // case, since a case-insensitive disk opens `.StylelintRC` by any spelling;
    // a root that cannot be listed is probed name by name, as before.
    //
    // The package lookups are synchronous, so they are placed where disk work
    // is in flight: the listing during the first, which the Tailwind walk
    // waits on, and the reads it unlocks during the rest.
    const rootListing = fs.readdir(projectRoot, { withFileTypes: true }).catch(() => null)
    const shadcnPath = resolveFromProject(projectRoot, "@shadcn/lint")
    const rootEntries = await rootListing
    const present = rootEntries && new Set(rootEntries.map((entry) => entry.name.toLowerCase()))
    const mayExist = (name) => present === null || present.has(name.toLowerCase())

    const reads = Promise.all([
      readStylelintConfig(projectRoot, mayExist),
      readFirstPresent(projectRoot, DS_LINT_CONFIG_FILES, mayExist),
      shadcnPath === null ? { uses: false, evidence: null } : detectTailwind(projectRoot, rootEntries, mayExist),
    ])
    const stylelintPath = resolveFromProject(projectRoot, "stylelint")
    const dsLintPath = resolveFromProject(projectRoot, "ds-lint")
    const eslintPath = shadcnPath === null ? null : resolveFromProject(projectRoot, "eslint")

    const [stylelintConfig, dsLintFound, tailwind] = await reads
    const dsLintConfig = dsLintFound?.file ?? null

    const stylelint = (() => {
      if (stylelintPath === null) {
        return { available: false, reason: "Stylelint is not installed in this project." }
      }
      if (stylelintConfig === null) {
        return { available: false, reason: "This project has no Stylelint configuration." }
      }
      if (!checksDesignSystem(stylelintConfig.text)) {
        return {
          available: false,
          reason: `${stylelintConfig.file} sets up formatting rules, not token rules, so it has nothing to say about the design system.`,
        }
      }
      return { available: true, reason: `Configured in ${stylelintConfig.file}.` }
    })()

    const dsLint = (() => {
      if (dsLintPath === null) {
        return { available: false, reason: "ds-lint is not installed in this project." }
      }
      if (dsLintConfig === null) {
        return { available: false, reason: "This project has no ds-lint configuration." }
      }
      return { available: true, reason: `Configured in ${dsLintConfig}.` }
    })()

    // The verdict this whole function exists for. See the header: on a project
    // whose design system is custom properties rather than utility classes,
    // this checker's token discovery finds nothing and its unknown-class rule
    // reports every class name in the project. Unavailable with a reason is the
    // correct answer, and it is a better one than a thousand wrong findings.
    const shadcn = (() => {
      if (shadcnPath === null) {
        return { available: false, reason: "shadcn/lint is not installed in this project." }
      }
      if (!tailwind.uses) {
        return {
          available: false,
          reason:
            "This project does not use Tailwind. shadcn/lint reads utility classes, so on a design system built from custom properties it finds no tokens and reports ordinary class names as errors.",
        }
      }
      if (eslintPath === null) {
        return {
          available: false,
          reason: "shadcn/lint runs as an ESLint plugin, and ESLint is not installed here.",
        }
      }
      return { available: true, reason: `Tailwind found in ${tailwind.evidence}.` }
    })()

    const verdicts = { stylelint, "ds-lint": dsLint, shadcn }
    const files = {
      stylelint: stylelintConfig?.file ?? null,
      "ds-lint": dsLintConfig,
      shadcn: tailwind.evidence,
    }
    return TOOLS.map((tool) => ({
      id: tool.id,
      name: tool.name,
      available: verdicts[tool.id].available,
      reason: verdicts[tool.id].reason,
      configFile: verdicts[tool.id].available ? files[tool.id] : null,
    }))
  }

  /**
   * Raw findings turned into the shape the panel and the canvas both read.
   *
   * Each file is opened once, parsed once, and every finding in it resolved
   * against that one index — the alternative, reading and parsing per finding,
   * is thousands of reads of the same handful of stylesheets on a project whose
   * configuration is off.
   */
  async function enrich(raw) {
    const postcss = await loadPostcss()
    const byFile = new Map()
    for (const finding of raw) {
      const list = byFile.get(finding.file)
      if (list) list.push(finding)
      else byFile.set(finding.file, [finding])
    }

    const enriched = []
    for (const [absolute, list] of byFile) {
      const relative = projectRelative(projectRoot, absolute)
      // A finding in a file outside the project is a checker reaching into a
      // dependency. There is nothing here to mark and nothing to fix.
      if (relative === null) continue

      const text = await readTextIfPresent(absolute)
      const starts = text === null ? null : lineStarts(text)
      const parsed =
        text !== null && postcss !== null && STYLESHEET_EXTENSIONS.has(path.extname(absolute).toLowerCase())
          ? stylesheetIndex(postcss, text, absolute)
          : null

      for (const finding of list) {
        const start = starts === null ? -1 : offsetAt(starts, text, finding.line, finding.column)
        const end = starts === null ? -1 : offsetAt(starts, text, finding.endLine, finding.endColumn)
        const sliced = start >= 0 && end > start ? text.slice(start, end) : ""
        // The tool's own literal is the fallback, not a replacement for the
        // slice: it is the same bytes when both exist, and it is all there is
        // when the file has moved on since the checker read it.
        const snippet = sliced || finding.literal || ""
        const rule = String(finding.rule ?? "")
        const message = cleanMessage(finding.message, rule)
        const replacement = finding.fixable === false ? null : replacementFor(message, snippet)

        enriched.push({
          tool: finding.tool,
          rule,
          severity: normalizeSeverity(finding.severity),
          message,
          file: relative,
          line: finding.line,
          column: finding.column,
          endLine: finding.endLine,
          endColumn: finding.endColumn,
          selector: parsed === null ? null : innermost(parsed.rules, finding.line, finding.column),
          snippet,
          property: parsed === null ? null : innermost(parsed.declarations, finding.line, finding.column),
          fix: replacement === null ? null : { replacement },
        })
      }
    }

    // Document order, because the occurrence index below counts along it and a
    // reordering would renumber — and therefore re-id — findings that did not
    // change.
    enriched.sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.column - b.column ||
        a.tool.localeCompare(b.tool) ||
        a.rule.localeCompare(b.rule)
    )

    /**
     * An id has to survive a run, because an ignore is stored against it and a
     * user who dismisses a finding expects it to stay dismissed.
     *
     * So the hash is over what the finding IS — which checker, which rule,
     * which file, which selector, which property, which exact text — and
     * deliberately NOT over the line number. Line numbers move every time
     * anything above them is edited, and an id keyed on one would resurrect
     * every dismissal below the first line anybody touched.
     *
     * The same literal can appear twice inside one block, which is one finding
     * shape and two findings. The occurrence index, counted in document order,
     * is what separates them; it shifts only when a matching finding above is
     * added or removed, which is the smallest set of ids it is possible to
     * disturb without putting the line number back in.
     */
    const occurrences = new Map()
    for (const finding of enriched) {
      const shape = [
        finding.tool,
        finding.rule,
        finding.file,
        finding.selector ?? "",
        finding.property ?? "",
        finding.snippet,
      ].join("|")
      const occurrence = occurrences.get(shape) ?? 0
      occurrences.set(shape, occurrence + 1)
      finding.id = createHash("sha1").update(`${shape}|${occurrence}`).digest("hex").slice(0, 16)
    }

    return enriched
  }

  /**
   * One audit.
   *
   * Every requested checker runs, and one that fails contributes an entry in
   * `errors` rather than taking the run with it. A checker crashing is a normal
   * Tuesday — a config referencing a plugin somebody uninstalled, a stylesheet
   * in a dialect its parser does not speak — and losing the other checkers'
   * findings to it would make the audit as fragile as its flakiest dependency.
   */
  /** finding id -> the checker that reported it; see `audit` and `fix`. */
  const toolOfFinding = new Map()

  async function audit(requested) {
    const tools = await describeTools()
    const wanted =
      requested === null ? tools.filter((tool) => tool.available) : tools.filter((tool) => requested.includes(tool.id))

    const errors = []
    for (const tool of wanted) {
      if (tool.available) continue
      errors.push({ tool: tool.id, reason: tool.reason })
    }

    const runnable = wanted.filter((tool) => tool.available)
    const results = await Promise.all(
      runnable.map((tool) => runToolInChild(tool.id, projectRoot))
    )

    const raw = []
    runnable.forEach((tool, index) => {
      const result = results[index]
      if (result?.error) {
        errors.push({ tool: tool.id, reason: String(result.error).slice(0, 400) })
        return
      }
      for (const finding of result?.findings ?? []) raw.push({ ...finding, tool: tool.id })
    })

    const enriched = await enrich(raw)
    // Which checker reported each id, so a fix re-runs only the checkers that
    // own the findings it was asked for. Replaced per checker that ran; a
    // checker that did not run keeps its ids from the last run it was in.
    const ran = new Set(runnable.map((tool) => tool.id))
    for (const [id, tool] of toolOfFinding) if (ran.has(tool)) toolOfFinding.delete(id)
    for (const finding of enriched) toolOfFinding.set(finding.id, finding.tool)
    const ignoredIds = new Set(await ignores.read())
    // Ignored findings are RETURNED, flagged, never filtered. A finding the
    // server drops is one the panel cannot offer to un-ignore, which would make
    // a dismissal permanent and undoable only by hand-editing a JSON file.
    for (const finding of enriched) finding.ignored = ignoredIds.has(finding.id)

    return {
      findings: enriched.slice(0, MAX_FINDINGS),
      truncated: enriched.length > MAX_FINDINGS,
      ranAt: Date.now(),
      tools: runnable.map((tool) => tool.id),
      errors,
    }
  }

  return {
    async tools() {
      return { tools: await describeTools() }
    },

    async run(body = {}) {
      let requested = null
      if (body && body.tools !== undefined && body.tools !== null) {
        if (!Array.isArray(body.tools)) throw badRequest("Run needs an array of tool ids")
        for (const id of body.tools) {
          if (!TOOL_IDS.includes(id)) throw badRequest(`"${id}" is not a checker this editor knows`)
        }
        requested = [...new Set(body.tools)]
      }
      return audit(requested)
    },

    /**
     * Apply the named findings, as text splices and nothing cleverer.
     *
     * It re-runs the audit first, because the ids came from a run that may be
     * minutes old and the user has been editing since — so the positions this
     * writes against are the ones in the file right now, not the ones in the
     * list on their screen. Only the checkers that reported the requested ids
     * are re-run: each one is a child process that can take seconds, and an id
     * is a hash over its own checker's findings, so the others cannot change
     * it. An id this process has never seen re-runs everything.
     *
     * Then every splice is checked before it is made: the bytes at the recorded
     * range must still BE the snippet the finding covers. A range that no
     * longer holds what the checker saw means the file moved under us, and
     * writing anyway would cut a replacement into the middle of whatever is
     * there now. That is reported as a failure with a reason, which is a row
     * the user can re-audit and fix; a corrupted stylesheet is not.
     */
    async fix(body = {}) {
      const ids = readIds(body)
      const owners = new Set(ids.map((id) => toolOfFinding.get(id)))
      const { findings } = await audit(owners.has(undefined) ? null : [...owners])
      const known = new Map(findings.map((finding) => [finding.id, finding]))

      const fixed = []
      const failed = []
      const byFile = new Map()

      for (const id of ids) {
        const finding = known.get(id)
        if (!finding) {
          failed.push({ id, reason: "This finding is no longer reported. Run Audit again." })
          continue
        }
        if (!finding.fix) {
          failed.push({ id, reason: "This finding names no single replacement, so it cannot be applied for you." })
          continue
        }
        const list = byFile.get(finding.file)
        if (list) list.push(finding)
        else byFile.set(finding.file, [finding])
      }

      for (const [relative, list] of byFile) {
        const absolute = path.join(projectRoot, relative)
        const text = await readTextIfPresent(absolute)
        if (text === null) {
          for (const finding of list) {
            failed.push({ id: finding.id, reason: `${relative} could not be read.` })
          }
          continue
        }

        const starts = lineStarts(text)
        const edits = []
        const applied = []
        for (const finding of list) {
          const start = offsetAt(starts, text, finding.line, finding.column)
          const end = offsetAt(starts, text, finding.endLine, finding.endColumn)
          if (start < 0 || end <= start || text.slice(start, end) !== finding.snippet) {
            failed.push({
              id: finding.id,
              reason: `${relative} changed since it was checked, so this was not written.`,
            })
            continue
          }
          edits.push({ start, end, text: finding.fix.replacement, id: finding.id })
        }

        // Two findings covering the same bytes cannot both be written, and
        // `applyEdits` refuses the whole file over it. Resolving it here means
        // the first one lands and the second is reported, rather than an
        // overlap costing every other fix in the file.
        edits.sort((a, b) => a.start - b.start || a.end - b.end)
        const clear = []
        let previousEnd = -1
        for (const edit of edits) {
          if (edit.start < previousEnd) {
            failed.push({
              id: edit.id,
              reason: "This overlaps another fix in the same place. Apply them one at a time.",
            })
            continue
          }
          previousEnd = edit.end
          clear.push(edit)
          applied.push(edit.id)
        }
        if (clear.length === 0) continue

        try {
          await fs.writeFile(absolute, applyEdits(text, clear), "utf8")
          fixed.push(...applied)
        } catch (error) {
          for (const id of applied) {
            failed.push({ id, reason: `${relative} could not be written: ${error?.message ?? "unknown error"}` })
          }
        }
      }

      return { fixed, failed }
    },

    async ignore(body = {}) {
      return { ignored: await ignores.add(readIds(body)) }
    },

    async unignore(body = {}) {
      return { ignored: await ignores.remove(readIds(body)) }
    },

    async ignored() {
      return { ignored: await ignores.read() }
    },
  }
}

/* -------------------------------------------------------------------------
 * Child mode
 * ---------------------------------------------------------------------- */

/**
 * This same file, run as a program, is the child a checker executes in.
 *
 * One file rather than two because the two halves are one contract — the shape
 * the child prints is the shape the parent reads — and a second file is where
 * that contract goes to drift. The guard is an exact path comparison, so
 * importing this module never runs it.
 */
async function runAsChild(toolId, projectRoot) {
  let payload
  try {
    const runner = CHILD_RUNNERS[toolId]
    if (!runner) throw new Error(`${toolId} is not a checker this editor knows`)
    const root = path.resolve(projectRoot)

    /**
     * The working directory is part of a checker's configuration, whatever its
     * API says, and getting it wrong is silent.
     *
     * Measured: a token plugin resolves the relative paths in its own
     * `tokenSources` against `process.cwd()` when the linter does not hand it
     * one, so running the same project from somewhere else finds no token file,
     * concludes that every token in the project is undeclared, and reports 2,168
     * errors instead of 19. Nothing in that run looks like a misconfiguration —
     * it looks like a project in terrible shape, which is the worst way for an
     * audit to be wrong.
     *
     * A checker's own `cwd` option is passed as well wherever it takes one. This
     * is the backstop for the ones that quietly do not use it, and it is safe to
     * set here precisely because this is a child: the editor's own process never
     * moves, and a chdir in it would break every relative path the server holds.
     */
    process.chdir(root)
    payload = await runner(root)
  } catch (error) {
    payload = { error: error?.message ?? `${toolId} failed` }
  }
  // Exit 0 whatever happened: the payload IS the report, and a non-zero exit
  // would have the parent discard a perfectly readable explanation in favour of
  // guessing from a number.
  process.stdout.write(`\n${CHILD_SENTINEL}${JSON.stringify(payload)}`)
}

if (
  process.argv[2] === CHILD_FLAG &&
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runAsChild(process.argv[3] ?? "", process.argv[4] ?? process.cwd())
}
