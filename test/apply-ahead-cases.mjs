/**
 * Cases for the rehearsed Apply (`runtime/apply-ahead.mjs`).
 *
 * The editor sends the operations an Apply would commit before the click; the
 * server runs the vendor's own batch transform on them with its writes
 * captured, and lets the real commit skip the parse and the reprint. These pin
 * that a rehearsed commit writes exactly what the vendor alone writes, that a
 * rehearsal writes nothing, and that every way the rehearsal could be out of
 * date — other operations, a file edited underneath, a commit that does not run
 * in its own delivery, a batch whose result is not a function of the text — is
 * the vendor's ordinary path. The transform is the real vendored one, over a
 * real file.
 *
 * Usage: node designlayer/test/apply-ahead-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

import { PACKAGE_DIR } from "./host.mjs"

const { createApplyAhead, installApplyAhead, APPLY_AHEAD } = await import(
  path.join(PACKAGE_DIR, "runtime", "apply-ahead.mjs")
)

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

const vendorEntry = createRequire(path.join(PACKAGE_DIR, "package.json")).resolve("react-rewrite-cli")
const dist = path.dirname(vendorEntry)
const { executeBatch } = await import(pathToFileURL(path.join(dist, "batch-transform.js")).href)
const { getParser } = await import(pathToFileURL(path.join(dist, "transform.js")).href)
const jscodeshift = createRequire(vendorEntry)("jscodeshift")

const CARD = `export function Card({ index }) {
  return (
    <article className="flex flex-col gap-3 rounded-xl p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-slate-900">Card {index}</h3>
      </header>
      <p className="text-sm leading-6 text-slate-600">A short description.</p>
    </article>
  )
}
`

/** One project for the rehearsed path and one for the vendor alone, same text. */
const project = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-apply-ahead-"))
const control = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-apply-ahead-control-"))
for (const root of [project, control]) fs.mkdirSync(path.join(root, "src"))
const file = path.join(project, "src", "Card.jsx")
const controlFile = path.join(control, "src", "Card.jsx")
const reset = (text = CARD) => {
  fs.writeFileSync(file, text)
  fs.writeFileSync(controlFile, text)
}

/** The size update the inspector sends for the `<h3>`. */
const sizeOps = (value) => [
  {
    op: "updateClass",
    file: "/src/Card.jsx",
    line: 5,
    col: 8,
    componentName: "Card",
    tagName: "h3",
    className: "text-base font-semibold text-slate-900",
    parentTagName: "header",
    parentClassName: "flex items-center justify-between",
    nthOfType: 0,
    updates: [
      {
        tailwindPrefix: "text",
        tailwindToken: null,
        value,
        classPattern: "^text-(\\[(?:[^\\]]*(?:px|rem|em|ch|%)|length:var\\(--[\\w-]+\\))\\]|xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl)$",
      },
    ],
  },
]

/*
 * Every string parse the vendor asks jscodeshift for, counted underneath the
 * module's own hook — so a commit that drew on the rehearsal shows up as one
 * that parsed nothing.
 */
let parses = 0
const withParser = jscodeshift.withParser
jscodeshift.withParser = function countedWithParser(parser) {
  const j = withParser.call(this, parser)
  return new Proxy(j, {
    apply(target, self, args) {
      if (typeof args[0] === "string") parses += 1
      return Reflect.apply(target, self, args)
    },
  })
}

const { wrapListener } = createApplyAhead({ jscodeshift, executeBatch, getParser, projectRoot: () => project })

/** The vendor's handler, reduced to what matters here: a commit runs the batch at once. */
let delivered = []
let outcome = null
const vendor = wrapListener((data) => {
  const message = JSON.parse(String(data))
  delivered.push(message.type)
  if (message.type === "commitBatch") outcome = executeBatch(message.operations, project)
})

const send = (listener, message) => listener(Buffer.from(JSON.stringify(message)))
const turn = () => new Promise((resolve) => setImmediate(resolve))
const hint = async (operations) => {
  send(vendor, { type: APPLY_AHEAD, operations })
  await turn()
  await turn()
}
/** What the vendor writes for these operations with no rehearsal anywhere near it. */
const alone = (operations) => {
  const result = executeBatch(structuredClone(operations), control)
  return { text: fs.readFileSync(controlFile, "utf8"), results: result.results }
}
const strip = (results) => results.map(({ op, file: name, line, success, error }) => ({ op, name, line, success, error }))

console.log("\nThe rehearsal")

await check("the hint is the server's, and never reaches the vendor", async () => {
  reset()
  delivered = []
  await hint(sizeOps("20px"))
  assert.deepEqual(delivered, [])
})

await check("a rehearsal writes nothing", async () => {
  reset()
  const before = fs.statSync(file).mtimeMs
  await hint(sizeOps("18px"))
  assert.equal(fs.readFileSync(file, "utf8"), CARD)
  assert.equal(fs.statSync(file).mtimeMs, before)
})

await check("a rehearsed commit writes exactly what the vendor alone writes, without parsing", async () => {
  reset()
  await hint(sizeOps("20px"))
  const parsed = parses
  send(vendor, { type: "commitBatch", operations: sizeOps("20px") })
  assert.equal(parses, parsed, "the commit parsed the file again")
  const expected = alone(sizeOps("20px"))
  assert.equal(fs.readFileSync(file, "utf8"), expected.text)
  assert.notEqual(expected.text, CARD, "the case wrote nothing to compare")
  assert.deepEqual(strip(outcome.results), strip(expected.results))
  assert.equal(outcome.undoEntries.length, 1)
  assert.equal(outcome.undoEntries[0].content, CARD)
  assert.equal(outcome.undoEntries[0].afterContent, expected.text)
})

await check("the commit spends the rehearsal: the next one parses", async () => {
  // The file changed under the first commit, so the same operations again are
  // a new question, answered by the vendor from the file as it now reads.
  reset()
  await hint(sizeOps("20px"))
  send(vendor, { type: "commitBatch", operations: sizeOps("20px") })
  const parsed = parses
  send(vendor, { type: "commitBatch", operations: sizeOps("20px") })
  assert.ok(parses > parsed, "a spent rehearsal answered a second commit")
})

console.log("\nEvery stale rehearsal is the vendor's ordinary path")

await check("other operations than the rehearsed ones", async () => {
  reset()
  await hint(sizeOps("20px"))
  const parsed = parses
  send(vendor, { type: "commitBatch", operations: sizeOps("18px") })
  assert.ok(parses > parsed, "a commit of other operations drew on the rehearsal")
  assert.equal(fs.readFileSync(file, "utf8"), alone(sizeOps("18px")).text)
})

await check("a file edited underneath after the rehearsal", async () => {
  reset()
  await hint(sizeOps("20px"))
  // The user, or an agent, edits the file between the hint and the click.
  const edited = CARD.replace("A short description.", "Rewritten by hand.")
  reset(edited)
  const parsed = parses
  send(vendor, { type: "commitBatch", operations: sizeOps("20px") })
  assert.ok(parses > parsed, "the commit trusted a rehearsal of text the file no longer holds")
  const text = fs.readFileSync(file, "utf8")
  assert.equal(text, alone(sizeOps("20px")).text)
  assert.ok(text.includes("Rewritten by hand."), "the edit made underneath was lost")
})

await check("a commit that does not run inside its own delivery", async () => {
  // The vendor queues writes; one that lands behind another runs later.
  reset()
  let queued = null
  const busy = wrapListener((data) => {
    queued = () => executeBatch(JSON.parse(String(data)).operations, project)
  })
  await hint(sizeOps("20px"))
  send(busy, { type: "commitBatch", operations: sizeOps("20px") })
  const parsed = parses
  queued()
  assert.ok(parses > parsed, "a commit run after its delivery drew on the rehearsal")
  assert.equal(fs.readFileSync(file, "utf8"), alone(sizeOps("20px")).text)
})

await check("a click that arrives before the rehearsal ran", async () => {
  // Both messages in one read of the socket: the commit is delivered before the
  // rehearsal's turn comes, and that turn must find nothing left to do.
  reset()
  send(vendor, { type: APPLY_AHEAD, operations: sizeOps("20px") })
  const parsed = parses
  send(vendor, { type: "commitBatch", operations: sizeOps("20px") })
  assert.ok(parses > parsed)
  await turn()
  await turn()
  assert.equal(fs.readFileSync(file, "utf8"), alone(sizeOps("20px")).text)
})

await check("a batch whose outcome is not a function of the file's text is not rehearsed", async () => {
  // The vendor answers a stamped operation from the file's clock.
  reset()
  const stat = fs.statSync(file)
  const stamped = sizeOps("20px").map((op) => ({ ...op, fileMtime: stat.mtimeMs, fileSize: stat.size }))
  await hint(stamped)
  const parsed = parses
  send(vendor, { type: "commitBatch", operations: stamped })
  assert.ok(parses > parsed)
  assert.equal(fs.readFileSync(file, "utf8"), alone(sizeOps("20px")).text)
})

await check("a batch the vendor would refuse is not rehearsed", async () => {
  reset()
  const nowhere = sizeOps("20px").map((op) => ({ ...op, tagName: "table", line: 99, className: "nope" }))
  await hint(nowhere)
  const parsed = parses
  send(vendor, { type: "commitBatch", operations: nowhere })
  assert.ok(parses > parsed)
  assert.equal(outcome.results[0].success, false)
  assert.equal(fs.readFileSync(file, "utf8"), CARD)
})

console.log("\nWiring")

await check("only message listeners are wrapped, and a hint stops at the server", async () => {
  class Socket {
    constructor() {
      this.listeners = {}
    }
    on(event, listener) {
      this.listeners[event] = listener
      return this
    }
  }
  const cwd = process.cwd()
  process.chdir(project)
  try {
    await installApplyAhead({ WebSocket: Socket, vendorEntry })
  } finally {
    process.chdir(cwd)
  }
  const socket = new Socket()
  const close = () => {}
  const seen = []
  socket.on("close", close)
  socket.on("message", (data) => seen.push(JSON.parse(String(data)).type))
  assert.equal(socket.listeners.close, close)
  send(socket.listeners.message, { type: APPLY_AHEAD, operations: sizeOps("20px") })
  send(socket.listeners.message, { type: "fileStat", filePath: "/src/Card.jsx" })
  assert.deepEqual(seen, ["fileStat"])
  await turn()
  await turn()
})

fs.rmSync(project, { recursive: true, force: true })
fs.rmSync(control, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
