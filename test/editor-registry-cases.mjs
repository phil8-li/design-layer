/**
 * The register of editors running on this machine, and the chooser rows it
 * feeds.
 *
 * The app chooser used to be able to answer only one question: "what does the
 * start screen say is running". That is a real way to run the editor and it is
 * not the common one. Most sessions are several editors started independently,
 * each pointed at an app that was already up, each with its proxy and socket
 * pinned so they can coexist — and in that shape there is no screen to ask, so
 * the menu said "this session was started without the app chooser" on a machine
 * with six editors on it. `runtime/editor-registry.mjs` is the fix: every
 * editor publishes a small file at boot, so any one of them can list the rest,
 * and switching becomes a NAVIGATION to another editor's proxy rather than a
 * request to kill this process and spawn the next.
 *
 * Two halves, and the cases below are split the same way.
 *
 * ## The registry, which is a directory of claims
 *
 * An entry is a claim and not a fact. An editor killed with SIGKILL never gets
 * to withdraw its own, so the reader has to sweep — and the sweep is the case
 * that matters most here, because a registry that accumulates the dead offers
 * rows that navigate to nothing. Everything else in that half is about
 * degrading rather than throwing: no directory, a half-written file, somebody
 * else's file in the folder, a home directory that cannot be written to at all.
 * The launcher publishes before the editor is of any use to anybody, so a
 * registry that throws is an editor that does not start.
 *
 * ## How this suite avoids taking down the real one
 *
 * `registryDir()` is `~/.local/state/designlayer/editors`, and `listEditors`
 * DELETES from it. That is the point of it, and it makes a naive suite
 * dangerous: the sweep is aimed by a pid, not by a name, so there is no way to
 * ask for the sweep and have it consider only the rows this file wrote. Run
 * against the real directory, one badly-judged case unregisters every editor
 * the person has open.
 *
 * So the whole suite runs under a `HOME` of its own, in a temp directory, and
 * that is checked rather than assumed: `os.homedir()` is documented to prefer
 * `$HOME` but it is a libuv call that could perfectly well read `/etc/passwd`,
 * and "the override silently did nothing" is exactly the failure that would eat
 * the real registry. `sandbox()` asserts the redirection took on every single
 * case, so a case can only ever write and delete inside its own directory. The
 * alternatives were both worse: patching `fs` hides the thing under test, and
 * adding a seam to the source for the directory would be a parameter that
 * exists only because of this file.
 *
 * ## The chooser half needs no machine at all
 *
 * `createAppSwitcher` takes `editors` and `self` precisely so a suite can
 * describe a machine instead of having to be on one, so the second half hands
 * it entries as plain objects and stubs the start screen behind `fetch`. What
 * is under test there is which rows come back and in what order, and a real
 * screen would only add a second thing that can fail while proving none of it.
 *
 * Usage: node designlayer/test/editor-registry-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createAppSwitcher } from "../server/apps.mjs"
import { listEditors, publishEditor, registryDir, withdrawEditor } from "../runtime/editor-registry.mjs"

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

// ── A home directory this suite is allowed to delete from ──────────────────

const REAL_HOME = process.env.HOME
const TMP = fs.realpathSync(os.tmpdir())
const sandboxes = []

/**
 * A fresh, empty `HOME`, with the redirection proved before anything is written.
 *
 * Every registry case calls this, and it is deliberately not hoisted to a
 * one-time setup: the guard is cheap and the thing it is guarding against is a
 * later case, or a later edit to this file, quietly putting `HOME` back and
 * pointing `listEditors` at the real directory with its sweep armed.
 */
function sandbox(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, `designlayer-registry-${label}-`)))
  sandboxes.push(dir)
  process.env.HOME = dir
  assert.equal(
    os.homedir(),
    dir,
    "overriding HOME did not move os.homedir(), so this suite would be editing the real registry"
  )
  assert.ok(
    registryDir().startsWith(`${dir}${path.sep}`),
    `the registry resolved to ${registryDir()}, which is outside this case's sandbox`
  )
  return dir
}

/**
 * Restores `HOME` and clears up, on every exit including a throw outside a
 * case. A suite that dies halfway through and leaves `HOME` pointed at a temp
 * directory would take the rest of the process with it.
 */
process.once("exit", () => {
  if (REAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = REAL_HOME
  for (const dir of sandboxes) {
    // Only ever under the temp directory, so a bug in the line above cannot
    // turn this into a recursive delete of somebody's home.
    if (dir.startsWith(`${TMP}${path.sep}`)) fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** An entry written by hand, for the states no healthy editor would publish. */
function writeEntry(name, contents) {
  fs.mkdirSync(registryDir(), { recursive: true })
  fs.writeFileSync(
    path.join(registryDir(), name),
    typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
    "utf8"
  )
  return path.join(registryDir(), name)
}

const entries = () => fs.readdirSync(registryDir()).sort()

/**
 * A pid that names no process, confirmed rather than assumed.
 *
 * The sweep asks the operating system, so a case about the sweep has to know
 * the answer the operating system will give. A number that happened to be in
 * use would make the case pass for the wrong reason on the one machine where it
 * mattered. EPERM is not good enough either: the registry counts a process it
 * cannot signal as alive, on purpose, because it exists and belongs to somebody
 * else.
 */
function deadPid() {
  for (const candidate of [999999, 999998, 888888, 777777]) {
    try {
      process.kill(candidate, 0)
    } catch (error) {
      if (error.code === "ESRCH") return candidate
    }
  }
  throw new Error("could not find a pid that is definitely not running")
}

/** What the launcher publishes, minus the two keys the registry fills in itself. */
function published(overrides = {}) {
  return {
    proxyPort: 3456,
    wsPort: 3457,
    appPort: 3000,
    appUrl: "http://127.0.0.1:3000",
    projectRoot: "/work/shop",
    packageName: "shop-web",
    url: "http://127.0.0.1:3456",
    ...overrides,
  }
}

console.log("\nPublishing and reading the register")

/*
 * The port is the file name because it is the one thing about an editor that is
 * unique by construction: two editors cannot both be answering on 3456, and
 * naming the file after it means a restarted editor overwrites its own row
 * rather than adding a second one.
 */
await check("an editor that comes up is on the register, under the port it answers on", () => {
  sandbox("publish")
  const before = Date.now()
  publishEditor(published())
  const after = Date.now()

  assert.deepEqual(entries(), ["3456.json"])
  const written = JSON.parse(fs.readFileSync(path.join(registryDir(), "3456.json"), "utf8"))
  for (const [key, value] of Object.entries(published())) {
    assert.deepEqual(written[key], value, `the entry lost ${key} on the way to disk`)
  }
  // The pid is the editor's own, not anything the caller passed: the liveness
  // check on the other side is only worth having if the registry is the one
  // deciding whose pid goes in.
  assert.equal(written.pid, process.pid)
  assert.ok(Number.isFinite(written.startedAt), "no start time, so the list has nothing to sort on")
  assert.ok(written.startedAt >= before && written.startedAt <= after)

  // Nothing to name the file after is nothing to write. A `undefined.json` in
  // the directory would be swept on the next read anyway, but it would also be
  // a row that claims a port nobody is on.
  publishEditor({ ...published(), proxyPort: undefined })
  assert.deepEqual(entries(), ["3456.json"])
})

await check("what was published is what comes back", () => {
  sandbox("round-trip")
  publishEditor(published())
  publishEditor(published({ proxyPort: 3460, appPort: 5173, url: "http://127.0.0.1:3460" }))

  const running = listEditors()
  assert.equal(running.length, 2)
  assert.deepEqual(
    running.map((entry) => entry.proxyPort).sort(),
    [3456, 3460]
  )
  assert.equal(running.find((entry) => entry.proxyPort === 3460).appPort, 5173)
  assert.ok(running.every((entry) => entry.pid === process.pid))
})

/*
 * The first editor on a machine reads the registry before it writes one, and
 * the directory it is reading does not exist yet. An empty list is the truth
 * there; a thrown ENOENT would be a chooser that fails on exactly the machine
 * with the least going on.
 */
await check("a machine that has never run an editor lists nothing rather than failing", () => {
  const home = sandbox("empty")
  assert.ok(!fs.existsSync(registryDir()), "this case only means something with no directory there")
  assert.deepEqual(listEditors(), [])
  // Reading did not create it either, which is what keeps a chooser open on a
  // machine with no editors from leaving state behind.
  assert.deepEqual(fs.readdirSync(home), [])
})

/*
 * THE case in this file.
 *
 * An entry is a claim, and the process that made it is the only one that can
 * withdraw it — so the one exit that skips the withdrawal is the one that
 * happens most: SIGKILL, a crash, a laptop that slept through it. Left in
 * place, the row is offered to the next designer who opens the menu and it
 * navigates them to a port nothing is listening on. Sweeping on read is also
 * the only thing stopping the directory growing one file per editor ever run.
 */
await check("an editor killed outright still stops being offered", () => {
  sandbox("sweep-dead")
  const gone = deadPid()
  writeEntry("4200.json", { ...published({ proxyPort: 4200 }), pid: gone, startedAt: Date.now() })
  publishEditor(published())
  assert.deepEqual(entries(), ["3456.json", "4200.json"])

  const running = listEditors()
  assert.deepEqual(
    running.map((entry) => entry.proxyPort),
    [3456],
    "a dead editor was offered as somewhere to switch to"
  )
  // Off disk, not merely filtered out of the answer. A row skipped on every
  // read but never removed is a directory that only grows.
  assert.deepEqual(entries(), ["3456.json"])
})

/*
 * Half-written is a real state, not a hypothetical one: the file is one
 * `writeFileSync` with no rename behind it, so a machine that goes down mid-put
 * leaves a truncated object. The reader cannot tell that apart from a file
 * somebody edited by hand, and the answer to both is the same — it names no
 * editor anybody can reach, so it goes.
 */
await check("an entry nobody can parse is swept instead of breaking the list", () => {
  sandbox("sweep-malformed")
  writeEntry("4300.json", '{ "proxyPort": 4300, "url": "http://127.0.0.1')
  publishEditor(published())

  assert.deepEqual(
    listEditors().map((entry) => entry.proxyPort),
    [3456]
  )
  assert.deepEqual(entries(), ["3456.json"])
})

// A plain write truncates first, and a reader in that window swept the empty
// file as unparseable — a live editor gone from every chooser. The entry is
// written beside itself and renamed over, so no reader ever sees half of it.
await check("publishing replaces the entry whole and leaves no temp file behind", () => {
  sandbox("atomic")
  publishEditor(published())
  const renamed = []
  const realRename = fs.renameSync
  fs.renameSync = (from, to) => {
    renamed.push([path.basename(from), path.basename(to)])
    // Mid-publish, the entry a reader would open is still the complete old one.
    assert.equal(JSON.parse(fs.readFileSync(to, "utf8")).proxyPort, 3456)
    return realRename(from, to)
  }
  try {
    publishEditor(published())
  } finally {
    fs.renameSync = realRename
  }
  assert.deepEqual(renamed, [[`3456.json.${process.pid}.tmp`, "3456.json"]])
  assert.deepEqual(entries(), ["3456.json"])
  assert.deepEqual(listEditors().map((entry) => entry.proxyPort), [3456])
})

/*
 * The sweep deletes files, and it is pointed at a directory under the person's
 * home rather than one this package owns outright. Anything that is not an
 * entry is therefore somebody else's, and the reader looks at the name before
 * it decides — which is the difference between a tidy-up and a data loss bug.
 */
await check("something else living in the registry folder is left where it is", () => {
  sandbox("foreign-file")
  const notes = writeEntry("README.txt", "why these files exist")
  writeEntry("3456.json.tmp", "half a write, from an editor that never finished")
  publishEditor(published())

  assert.deepEqual(
    listEditors().map((entry) => entry.proxyPort),
    [3456]
  )
  assert.deepEqual(entries(), ["3456.json", "3456.json.tmp", "README.txt"])
  assert.equal(fs.readFileSync(notes, "utf8"), "why these files exist")
})

await check("an editor that shuts down cleanly takes its own row with it", () => {
  sandbox("withdraw")
  publishEditor(published())
  publishEditor(published({ proxyPort: 3460, url: "http://127.0.0.1:3460" }))

  withdrawEditor(3456)
  assert.deepEqual(entries(), ["3460.json"])
  assert.deepEqual(
    listEditors().map((entry) => entry.proxyPort),
    [3460]
  )

  // Withdrawal runs from an `exit` handler and from three signal handlers, so
  // it can and does run twice for one editor, and it runs for ports that were
  // never published when a launch failed before the proxy bound. Neither is an
  // error worth raising on the way out of a process.
  withdrawEditor(3456)
  withdrawEditor(9999)
  withdrawEditor(undefined)
  assert.deepEqual(entries(), ["3460.json"])
})

/*
 * Oldest first, and by start time rather than by port. The ports are whatever
 * the launcher had free and carry no meaning, so a list sorted by port reorders
 * itself between sessions for reasons nobody can see. Opening order is the
 * order the person thinks of their own apps in.
 */
await check("the editors come back in the order they were opened", () => {
  sandbox("order")
  // The oldest editor is on the highest port, so the answer this case wants
  // disagrees with sorting by port and with sorting by name. Written in a third
  // order again, so the order `readdir` happens to hand back cannot produce it
  // either — the sort has to be doing the work.
  writeEntry("3456.json", { ...published({ proxyPort: 3456 }), pid: process.pid, startedAt: 200 })
  writeEntry("3464.json", { ...published({ proxyPort: 3464 }), pid: process.pid, startedAt: 100 })
  writeEntry("3460.json", { ...published({ proxyPort: 3460 }), pid: process.pid, startedAt: 300 })

  assert.deepEqual(
    listEditors().map((entry) => entry.proxyPort),
    [3464, 3456, 3460]
  )

  // An entry from an editor old enough not to have published a start time sinks
  // to the top of the list rather than throwing the sort, because `undefined`
  // in a comparator leaves the whole order unspecified.
  writeEntry("3470.json", { ...published({ proxyPort: 3470 }), pid: process.pid })
  assert.deepEqual(
    listEditors().map((entry) => entry.proxyPort),
    [3470, 3464, 3456, 3460]
  )
})

/*
 * The registry is published from the launcher, before the editor is any use to
 * anybody, and it is a nicety: it costs the chooser some rows when it fails and
 * it must never cost the person their session. A home directory that cannot
 * hold the folder is the blunt version of the read-only and out-of-space and
 * TCC-denied cases, and it is the one a test can actually arrange.
 */
await check("a registry that cannot be written does not stop an editor starting", () => {
  const home = sandbox("unwritable")
  const blocker = path.join(home, "blocker")
  fs.writeFileSync(blocker, "a file where a directory would have to be")
  process.env.HOME = path.join(blocker, "home")
  assert.ok(registryDir().startsWith(`${home}${path.sep}`), "the sandbox guard must still hold")

  assert.doesNotThrow(() => publishEditor(published()))
  assert.doesNotThrow(() => withdrawEditor(3456))
  // And the read degrades the same way, because the chooser calls it on a menu
  // open and an exception there is a menu that renders nothing at all.
  assert.deepEqual(listEditors(), [])
})

// ── The rows the chooser is handed ─────────────────────────────────────────

/**
 * One editor as the registry would report it.
 *
 * `appPort`/`appUrl` are the app being edited and `url` is the editor's own
 * proxy — the row carries both because they answer different questions: one
 * names the row, the other is where the browser goes.
 */
function editorEntry(overrides = {}) {
  return {
    pid: 4242,
    proxyPort: 3456,
    wsPort: 3457,
    appPort: 3000,
    appUrl: "http://127.0.0.1:3000",
    projectRoot: "/work/shop",
    packageName: "shop-web",
    url: "http://127.0.0.1:3456",
    startedAt: 100,
    ...overrides,
  }
}

const OTHER = editorEntry({
  pid: 4243,
  proxyPort: 3460,
  wsPort: 3461,
  appPort: 5173,
  appUrl: "http://127.0.0.1:5173",
  projectRoot: "/work/sketch",
  packageName: "sketch",
  url: "http://127.0.0.1:3460",
  startedAt: 200,
})

const CHOOSER = "http://127.0.0.1:3455/"

/** The start screen, as `server/apps.mjs` sees it and nowhere else. */
const screen = {
  reachable: true,
  ok: true,
  status: 200,
  body: { apps: [] },
  calls: [],
  reset() {
    screen.reachable = true
    screen.ok = true
    screen.status = 200
    screen.body = { apps: [] }
    screen.calls = []
  },
}

globalThis.fetch = async (input) => {
  const url = String(input)
  screen.calls.push(url)
  if (!screen.reachable) throw new Error("connect ECONNREFUSED 127.0.0.1:3455")
  return {
    ok: screen.ok,
    status: screen.status,
    json: async () => JSON.parse(JSON.stringify(screen.body)),
  }
}

console.log("\nWhat the chooser is offered")

/*
 * The case the registry was written for.
 *
 * Six editors, no supervisor, and the menu used to say there was nothing to
 * switch between — which was true about start screens and false about the
 * machine. Switching between editors needs nothing but their URLs, so the
 * absence of a screen stopped being the absence of a chooser.
 */
await check("a session with no start screen still offers the other editors", async () => {
  screen.reset()
  const answer = await createAppSwitcher({
    chooserUrl: null,
    self: 1,
    editors: () => [editorEntry(), OTHER],
  }).list()

  assert.equal(answer.chooser, true, "the menu was told there is nothing to choose from")
  assert.equal(answer.apps.length, 2)
  assert.ok(
    answer.apps.every((row) => row.kind === "editor"),
    "a running editor was offered as an app that still needs one started"
  )
  // The target is the OTHER editor's proxy, not the app it is pointed at:
  // navigating to the bare app would leave the person on a page with no editor
  // on it at all.
  assert.deepEqual(
    answer.apps.map((row) => row.target),
    ["http://127.0.0.1:3456", "http://127.0.0.1:3460"]
  )
  assert.deepEqual(
    answer.apps.map((row) => row.port),
    [3000, 5173]
  )
  assert.deepEqual(
    answer.apps.map((row) => row.packageName),
    ["shop-web", "sketch"]
  )
  assert.deepEqual(screen.calls, [], "it went looking for a screen it had been told is not there")
})

/*
 * Its own row is dropped rather than marked. The browser already knows which
 * app it is on and marks that row itself from `config.app`, so a row for this
 * editor would be a link back to the page you are looking at — and matched on
 * pid, because the proxy port is not necessarily bound when this is built.
 */
await check("the editor you are already in is never offered as somewhere to go", async () => {
  screen.reset()
  const answer = await createAppSwitcher({
    chooserUrl: null,
    self: 4242,
    editors: () => [editorEntry(), OTHER],
  }).list()

  assert.deepEqual(
    answer.apps.map((row) => row.target),
    ["http://127.0.0.1:3460"]
  )
})

await check("the only editor on the machine has nothing to switch to", async () => {
  screen.reset()
  const answer = await createAppSwitcher({
    chooserUrl: null,
    self: 4242,
    editors: () => [editorEntry()],
  }).list()

  /*
   * AN EMPTY LIST, AND THE FEATURE STILL EXISTS.
   *
   * This used to assert `chooser: false`, and the browser read that as "this
   * session has no app chooser" and said so — inside the app chooser, to
   * everybody running a single editor with no start screen, which is the common
   * shape. The field never meant that. It answers whether a supervisor can
   * START something; an empty list is a fact about the machine right now, not a
   * missing feature. So the answer is `true` with no rows, and the sentence
   * about what the reader can do next belongs in the menu, where
   * `test/app-chooser-cases.mjs` pins it.
   */
  assert.deepEqual(answer, { chooser: true, apps: [] })
})

/*
 * A row with no target is a menu item that does nothing when it is clicked,
 * which is worse than one that is not there: the person presses it twice,
 * decides the editor is wedged and reloads. An entry can reach here without a
 * URL — an older editor publishing an older shape, or a truncated file that
 * happened to stay parseable — so the row is dropped on the way out.
 */
await check("an editor that published no URL is not offered as a dead link", async () => {
  screen.reset()
  const answer = await createAppSwitcher({
    chooserUrl: null,
    self: 1,
    editors: () => [editorEntry({ url: undefined }), editorEntry({ pid: 4244, url: null }), OTHER],
  }).list()

  assert.deepEqual(
    answer.apps.map((row) => row.target),
    ["http://127.0.0.1:3460"]
  )
})

/*
 * Both halves can see the same app: the screen scanned the port, and the
 * registry knows an editor is already pointed at it. Listing it twice would ask
 * the person to choose between two spellings of the same thing, where one of
 * them kills their session to get somewhere they can already navigate to. The
 * editor wins, and the match is on port because the two sides spell loopback
 * differently.
 */
await check("an app that already has an editor is listed once, as the editor", async () => {
  screen.reset()
  screen.body = {
    apps: [
      // The same app as the first editor, seen from the screen's own scan and
      // spelled the way an IPv6-first machine answers.
      { port: 3000, url: "http://[::1]:3000", title: "Shop", projectRoot: "/work/shop" },
      { port: 4200, url: "http://127.0.0.1:4200", title: "Docs site", projectRoot: "/work/docs" },
    ],
  }
  const answer = await createAppSwitcher({
    chooserUrl: CHOOSER,
    self: 1,
    editors: () => [editorEntry(), OTHER],
  }).list()

  assert.equal(screen.calls[0], `${CHOOSER}api/apps`)
  assert.deepEqual(
    answer.apps.map((row) => `${row.kind} ${row.port}`),
    // The editors lead, because they are the rows that cost nothing to follow.
    ["editor 3000", "editor 5173", "app 4200"]
  )
  const docs = answer.apps.at(-1)
  // An app with no editor of its own can only be reached by asking the screen
  // to start one, so there is nowhere for the browser to navigate to and the
  // row says so rather than carrying a URL that would go to the bare app.
  assert.equal(docs.target, null)
  assert.equal(docs.title, "Docs site")
})

/*
 * The screen going down is not the editors going away. Before the registry
 * there was nothing else to report, so an unreachable screen was the whole
 * answer; now it costs the rows it knows about and nothing else, and an error
 * sentence alongside real rows would put an apology on a menu that is working.
 */
await check("the start screen going down does not take the local editors with it", async () => {
  screen.reset()
  screen.reachable = false
  const answer = await createAppSwitcher({
    chooserUrl: CHOOSER,
    self: 1,
    editors: () => [OTHER],
  }).list()

  assert.equal(answer.chooser, true)
  assert.deepEqual(
    answer.apps.map((row) => row.target),
    ["http://127.0.0.1:3460"]
  )
  assert.equal("error" in answer, false, "a working menu was handed an apology to display")

  // With nothing local to fall back on it is the sentence it always was, which
  // is the one thing the menu can put where the rows would be.
  const alone = await createAppSwitcher({ chooserUrl: CHOOSER, self: 1, editors: () => [] }).list()
  assert.deepEqual(alone.apps, [])
  assert.ok(
    String(alone.error).trim().split(/\s+/).length >= 4,
    `not a sentence: ${alone.error}`
  )
  assert.match(alone.error, /did not answer/)
})

/*
 * The registry is a directory of files under somebody's home, so reading it can
 * fail for reasons that have nothing to do with this editor. It is a source of
 * rows and never of failures: a menu that throws renders nothing, and "no other
 * editors" is a far better wrong answer than a blank card.
 */
await check("a registry that cannot be read costs rows, never the answer", async () => {
  screen.reset()
  const answer = await createAppSwitcher({
    chooserUrl: null,
    self: 1,
    editors: () => {
      throw new Error("EACCES: permission denied, scandir")
    },
  }).list()
  // `chooser: true` with no rows, for the reason given on the single-editor
  // case above: the field says a supervisor could start something, not that
  // the menu exists. A failed read costs rows and nothing else.
  assert.deepEqual(answer, { chooser: true, apps: [] })

  // And with a screen behind the session it still gets asked, because the half
  // that failed is not the half that answers this.
  screen.body = { apps: [{ port: 4200, url: "http://127.0.0.1:4200", title: "Docs site" }] }
  const relayed = await createAppSwitcher({
    chooserUrl: CHOOSER,
    self: 1,
    editors: () => {
      throw new Error("EACCES: permission denied, scandir")
    },
  }).list()
  assert.deepEqual(
    relayed.apps.map((row) => `${row.kind} ${row.port}`),
    ["app 4200"]
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
