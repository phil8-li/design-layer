#!/usr/bin/env node
/**
 * The test runner `npm test` calls.
 *
 *   node test/run.mjs                      every suite, one at a time
 *   node test/run.mjs mcp board            only suites whose id contains "mcp" or "board"
 *   node test/run.mjs --from toast-cases   resume: start at that suite, keep the order
 *   node test/run.mjs --skip a,b           leave out suites whose id contains a or b
 *   node test/run.mjs --jobs 4             run the PARALLEL_SAFE suites 4 at a time
 *   node test/run.mjs --list               print the plan and run nothing
 *   node test/run.mjs --verbose            stream every suite's own output
 *   node test/run.mjs --timeout 300        seconds before a suite is killed (default 300)
 *
 * A suite id is its path without `.mjs`: `test/board-cases`,
 * `desktop/mac/test/desk-cases`, `tools/motion-budget`. Filters match a
 * substring of the id, so `board` selects `board-cases` and `board-frame-cases`.
 * One suite alone is still `node test/<name>-cases.mjs`.
 *
 * Suites are found on disk (`test/*-cases.mjs`, `desktop/mac/test/*-cases.mjs`)
 * and sorted by id, so adding or deleting a suite needs no edit here or in
 * package.json. The only lists below are the exceptions: arguments a suite
 * needs, suites left out of `npm test`, extra non-suite gates, and the
 * parallel allow-list.
 *
 * Every suite runs to the end even after a failure. Each prints one line
 * (ok / FAIL / skipped, wall time, its own pass count), a failure also prints
 * the tail of its output, and a summary closes the run. Exit 1 if any suite
 * failed, 2 on a usage error.
 *
 * What counts as what:
 *   ok       exit 0
 *   skipped  exit 0, and the suite printed SKIPPED (the four host-pinned suites
 *            on a clean clone) or ran zero checks (`0 passed, 0 failed`)
 *   FAIL     a non-zero exit, a timeout, or exit 0 after printing a `FAIL`
 *            line. The last one is real: `requireHostConfig` exits 0 after a
 *            suite's first checks ran, so a failure in those checks used to
 *            pass (token-cases, icon-set-cases).
 *
 * `--jobs N` is opt-in. Only suites in PARALLEL_SAFE share the machine; they
 * touch no fixed port, no fixed folder in the repository, no real
 * ~/.local/state and do not write dist/. Every other suite then runs alone,
 * in order, after the parallel ones finish. A new suite is serial until
 * someone checks it and adds it to the list. Timing-heavy suites can still
 * flake when the machine is loaded; the default stays serial for that reason.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const SUITE_DIRS = ["test", "desktop/mac/test"]

// Gates that are not `*-cases.mjs` files but belong in `npm test`.
const EXTRA = ["tools/motion-budget.mjs"]

const ARGS = {
  // Levels 2-5 drive a live editor on 3456/3457; `npm test` must not.
  "test/ui-change-cases": ["--offline"],
}

const EXCLUDED = {
  // Needs a host app and runs `npm install`: `npm run test:standalone-next`.
  "test/standalone-next-cases": "npm run test:standalone-next",
}

// Checked by reading each suite: servers listen on port 0, fixtures live in
// mkdtemp folders, and HOME (when touched) is a temp folder. Left out on
// purpose: bundle-freshness (rebuilds and stubs dist/), start-screen (binds
// 3455, scans machine ports, real HOME), ui-change (writes test/.fixtures),
// icon-set and options (fixed folders under test/), cli, dev-flow, mcp-hub,
// multi-editor, zero-config (free-port races, real HOME), updater (git and
// builds in clones), desk (fixed sleeps against timers), the host-pinned
// token, picker and responsive suites, and library-signin-live (real Chrome).
const PARALLEL_SAFE = new Set([
  "test/angular-cases", "test/annotation-cases", "test/app-chooser-cases",
  "test/app-storage-cases", "test/app-viewport-cases",
  "test/appearance-typography-cases", "test/apply-ahead-cases",
  "test/apply-source-cases", "test/apply-token-cases", "test/audit-cases",
  "test/board-cases", "test/board-frame-cases", "test/boot-cases",
  "test/changes-tab-cases", "test/clipboard-cases", "test/code-tab-cases",
  "test/color-space-cases", "test/companion-cases",
  "test/component-usage-cases", "test/concentric-cases",
  "test/context-menu-cases", "test/contrast-sweep-cases", "test/delete-cases",
  "test/design-follow-cases", "test/design-md-cases",
  "test/design-system-tab-cases", "test/drag-write-cases",
  "test/edit-notes-cases", "test/editor-registry-cases",
  "test/focus-modality-cases", "test/hidden-chrome-cases",
  "test/history-cases", "test/host-agnostic-cases", "test/host-parity-cases",
  "test/host-readiness-cases", "test/icon-cases", "test/insert-cases",
  "test/inspector-tabs-cases", "test/layer-header-cases",
  "test/layers-cases", "test/layers-figma-cases", "test/layers-scroll-cases",
  "test/layout-section-cases", "test/library-auth-cases",
  "test/library-components-cases", "test/library-generality-cases",
  "test/library-panel-cases", "test/library-signin-cases",
  "test/library-source-cases", "test/library-store-cases",
  "test/library-url-cases", "test/lint-marker-cases", "test/mac-app-cases",
  "test/mcp-handoff-cases", "test/mcp-status-cases", "test/measure-cases",
  "test/mixed-selection-cases", "test/moves-cases", "test/multi-align-cases",
  "test/overlay-delivery-cases", "test/pages-cases",
  "test/paint-sections-cases", "test/position-cases",
  "test/proxy-retry-cases", "test/resize-cases", "test/routes-cases",
  "test/selection-cases", "test/selection-colors-cases",
  "test/selection-shell-cases", "test/shortcut-cases",
  "test/source-guard-cases", "test/spacing-handles-cases",
  "test/stranded-write-cases", "test/style-scope-cases", "test/toast-cases",
  "test/token-binding-cases", "test/toolbar-cases", "test/tooltip-cases",
  "test/unified-marker-cases", "test/variant-cases",
  "test/variant-client-cases", "test/vendor-chrome-cases",
  "test/vendor-server-patch-cases", "tools/motion-budget",
])

const FAIL_TAIL = 80

function usage(message) {
  if (message) console.error(`run.mjs: ${message}`)
  console.error("usage: node test/run.mjs [substring...] [--from <name>] [--skip <a,b>] [--jobs N] [--timeout S] [--list] [--verbose]")
  process.exit(2)
}

function parseArgs(argv) {
  const options = { filters: [], from: null, skip: [], jobs: 1, timeout: 300, list: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) usage(`${arg} needs a value`)
      return next
    }
    if (arg === "--from") options.from = value()
    else if (arg === "--skip") options.skip.push(...value().split(",").map((s) => s.trim()).filter(Boolean))
    else if (arg === "--jobs" || arg === "-j") options.jobs = Number(value())
    else if (arg === "--timeout") options.timeout = Number(value())
    else if (arg === "--list") options.list = true
    else if (arg === "--verbose" || arg === "-v") options.verbose = true
    else if (arg === "--help" || arg === "-h") usage()
    else if (arg.startsWith("-")) usage(`unknown option ${arg}`)
    else options.filters.push(arg)
  }
  if (!Number.isInteger(options.jobs) || options.jobs < 1) usage("--jobs takes a whole number of at least 1")
  if (!(options.timeout > 0)) usage("--timeout takes a number of seconds")
  return options
}

export function discover(root = ROOT) {
  const files = []
  for (const dir of SUITE_DIRS) {
    const abs = path.join(root, dir)
    if (!fs.existsSync(abs)) continue
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith("-cases.mjs")) files.push(`${dir}/${name}`)
    }
  }
  for (const file of EXTRA) if (fs.existsSync(path.join(root, file))) files.push(file)
  return files
    .map((file) => ({ id: file.replace(/\.mjs$/, ""), file }))
    .filter((suite) => !(suite.id in EXCLUDED))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((suite) => ({ ...suite, args: ARGS[suite.id] ?? [], parallel: PARALLEL_SAFE.has(suite.id) }))
}

const matches = (suite, token) => suite.id.includes(token)

export function select(suites, { filters = [], from = null, skip = [] } = {}) {
  let list = suites
  if (filters.length) list = list.filter((suite) => filters.some((token) => matches(suite, token)))
  if (from) {
    // An exact name wins over a substring, so `--from board-cases` does not
    // start at `app-board-cases` should one ever exist.
    const exact = list.findIndex((s) => path.basename(s.id) === from || path.basename(s.id) === `${from}-cases` || s.id === from)
    const start = exact >= 0 ? exact : list.findIndex((s) => matches(s, from))
    if (start < 0) usage(`--from ${from} matches no selected suite`)
    list = list.slice(start)
  }
  if (skip.length) list = list.filter((suite) => !skip.some((token) => matches(suite, token)))
  return list
}

function runSuite(suite, { timeout, verbose }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [suite.file, ...suite.args], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    running.add(child)
    let output = ""
    const take = (stream, sink) => stream.on("data", (chunk) => {
      output += chunk
      if (verbose) sink.write(chunk)
    })
    take(child.stdout, process.stdout)
    take(child.stderr, process.stderr)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeout * 1000)
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      running.delete(child)
      resolve({ suite, ...classify(output, code, signal, timedOut), seconds: (Date.now() - started) / 1000, output })
    })
  })
}

export function classify(output, code, signal = null, timedOut = false) {
  const counts = [...output.matchAll(/(\d+) passed, (\d+) failed/g)].pop()
  const passed = counts ? Number(counts[1]) : null
  const failed = counts ? Number(counts[2]) : null
  if (timedOut) return { status: "FAIL", passed, failed, reason: "timed out" }
  if (code !== 0) return { status: "FAIL", passed, failed, reason: signal ? `killed by ${signal}` : `exit ${code}` }
  if (/^\s*FAIL\b/m.test(output)) return { status: "FAIL", passed, failed, reason: "exit 0 after a FAIL line" }
  if (/\bSKIPPED\b/.test(output) || (passed === 0 && failed === 0)) return { status: "skipped", passed, failed, reason: "" }
  return { status: "ok", passed, failed, reason: "" }
}

const running = new Set()
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of running) child.kill("SIGKILL")
    process.exit(130)
  })
}

const width = (suites) => Math.max(...suites.map((s) => s.id.length))

function line(result, pad) {
  const status = result.status.padEnd(7)
  const time = `${result.seconds.toFixed(1)}s`.padStart(7)
  const count = result.passed === null ? "" : `  ${result.passed} passed${result.failed ? `, ${result.failed} failed` : ""}`
  const reason = result.reason ? `  (${result.reason})` : ""
  return `${status} ${result.suite.id.padEnd(pad)} ${time}${count}${reason}`
}

function report(result, pad, verbose) {
  console.log(line(result, pad))
  if (result.status !== "FAIL" || verbose) return
  const lines = result.output.trimEnd().split("\n")
  const tail = lines.slice(-FAIL_TAIL)
  if (lines.length > tail.length) console.log(`        … ${lines.length - tail.length} earlier lines cut; rerun: node ${result.suite.file} ${result.suite.args.join(" ")}`.trimEnd())
  for (const text of tail) console.log(`        ${text}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const suites = select(discover(), options)
  if (!suites.length) usage("no suite matches")
  const pad = width(suites)

  if (options.list) {
    for (const suite of suites) {
      const mode = options.jobs > 1 ? (suite.parallel ? "parallel" : "serial  ") : ""
      console.log(`${mode ? `${mode} ` : ""}node ${suite.file}${suite.args.length ? ` ${suite.args.join(" ")}` : ""}`)
    }
    console.log(`${suites.length} suites`)
    return
  }

  const started = Date.now()
  const results = []
  const verbose = options.verbose && options.jobs === 1
  if (options.jobs > 1) {
    const pool = suites.filter((s) => s.parallel)
    let next = 0
    const worker = async () => {
      while (next < pool.length) {
        const result = await runSuite(pool[next++], options)
        results.push(result)
        report(result, pad, false)
      }
    }
    await Promise.all(Array.from({ length: Math.min(options.jobs, pool.length) }, worker))
    for (const suite of suites.filter((s) => !s.parallel)) {
      const result = await runSuite(suite, options)
      results.push(result)
      report(result, pad, false)
    }
  } else {
    for (const suite of suites) {
      if (verbose) console.log(`\n=== node ${suite.file} ${suite.args.join(" ")}`.trimEnd())
      const result = await runSuite(suite, { ...options, verbose })
      results.push(result)
      report(result, pad, verbose)
    }
  }

  const order = new Map(suites.map((s, i) => [s.id, i]))
  results.sort((a, b) => order.get(a.suite.id) - order.get(b.suite.id))
  const by = (status) => results.filter((r) => r.status === status)
  const failedRuns = by("FAIL")
  const skipped = by("skipped")
  const wall = (Date.now() - started) / 1000
  const cpu = results.reduce((sum, r) => sum + r.seconds, 0)

  console.log("\nSummary")
  console.log(`  ${"status".padEnd(8)} ${"suites".padStart(6)}`)
  console.log(`  ${"ok".padEnd(8)} ${String(by("ok").length).padStart(6)}`)
  console.log(`  ${"skipped".padEnd(8)} ${String(skipped.length).padStart(6)}`)
  console.log(`  ${"FAIL".padEnd(8)} ${String(failedRuns.length).padStart(6)}`)
  console.log(`  ${"total".padEnd(8)} ${String(results.length).padStart(6)}   ${wall.toFixed(1)}s wall${options.jobs > 1 ? `, ${cpu.toFixed(1)}s summed, --jobs ${options.jobs}` : ""}`)
  if (skipped.length) {
    console.log("\n  skipped:")
    for (const r of skipped) console.log(`    ${r.suite.id}`)
  }
  const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 5)
  console.log("\n  slowest:")
  for (const r of slowest) console.log(`    ${`${r.seconds.toFixed(1)}s`.padStart(7)}  ${r.suite.id}`)
  if (failedRuns.length) {
    console.log("\n  failed (rerun one alone):")
    for (const r of failedRuns) console.log(`    node ${r.suite.file}${r.suite.args.length ? ` ${r.suite.args.join(" ")}` : ""}   # ${r.reason}`)
    const rest = suites.findIndex((s) => s.id === failedRuns[0].suite.id)
    if (rest > 0) console.log(`    resume from the first failure: node test/run.mjs --from ${path.basename(failedRuns[0].suite.id)}`)
  }
  process.exitCode = failedRuns.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
