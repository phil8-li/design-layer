/**
 * Many editors at once, one per app.
 *
 * The supervisor used to run one editor and kill it on every choice, so in the
 * Mac app (one window, a tab per editor) opening a second app in a new tab
 * killed the first app's editor under the tab still showing it. This suite
 * pins the contract that replaced it: starting an app never stops another
 * app's editor, one app has one editor, each editor keeps its own ports, and
 * the screen's API names every editor by id.
 *
 * Offline and fast: the supervisor's loops run against fake children, every
 * server is on an ephemeral port, and state files go to a temporary HOME.
 *
 * Usage: node test/multi-editor-cases.mjs
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-multi-home-")))
process.env.HOME = home

const { childArgv, runEditors } = await import("../cli.mjs")
const { createStartScreen } = await import("../runtime/start-screen.mjs")
const { allocatePorts, isPortFree, portsFile, rememberedPorts } = await import("../runtime/editor-ports.mjs")
const { vendorBindPort } = await import("../runtime/launcher.mjs")
const { lastPage, pagesDir, pagesFile, rememberPage } = await import("../runtime/last-pages.mjs")
const { publishEditor, registryDir } = await import("../runtime/editor-registry.mjs")
const { projectRootForPort } = await import("../runtime/local-apps.mjs")

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

const temporary = [home]
function fixture(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `designlayer-${prefix}-`)))
  temporary.push(dir)
  return dir
}

/** A project the start screen accepts, in a folder named for the app. */
function project(name) {
  const dir = path.join(fixture("multi"), name)
  fs.mkdirSync(dir)
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "studio", private: true, dependencies: { react: "19.0.0" }, scripts: { dev: "node app.mjs" } })
  )
  return dir
}

const json = async (url, init) => {
  const response = await fetch(url, init)
  return { status: response.status, body: await response.json().catch(() => null) }
}
const post = (url, body) =>
  json(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

async function until(test, what, ms = 2000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await test()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A child process as far as the supervisor can tell: messages, kill, exit. */
function fakeChild(argv) {
  const child = new EventEmitter()
  child.argv = argv
  child.killed = null
  child.kill = (signal) => {
    if (child.killed) return
    child.killed = signal
    setImmediate(() => child.emit("exit", null, signal))
  }
  child.ready = (url) => child.emit("message", { type: "ready", url })
  child.crash = (code) => child.emit("exit", code, null)
  return child
}

const portOf = (argv, flag) => Number(argv[argv.indexOf(flag) + 1])

/**
 * A screen with the supervisor's loops on it, fake children and fake ports.
 * The ports hand out 3456/3457, 3458/3459 ... skipping ones in `taken`, which
 * is what the real allocator does on a quiet machine.
 */
async function withSupervisor(run) {
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const children = []
  const asked = []
  const fakePorts = async ({ taken, preferred, projectRoot, appPort }) => {
    asked.push({ taken, preferred, projectRoot, appPort })
    for (let proxyPort = preferred?.proxyPort ?? 3456; ; proxyPort += 2) {
      if (!taken.includes(proxyPort)) return { proxyPort, wsPort: proxyPort + 1 }
    }
  }
  const supervisor = runEditors(screen, {
    options: {},
    allocatePorts: fakePorts,
    log: () => {},
    spawnEditor: (argv) => {
      const child = fakeChild(argv)
      children.push(child)
      return child
    },
  })
  const start = (url, projectRoot) => post(`${screen.url}/api/start`, { url, projectRoot, devScript: null })
  const status = async (id) => (await json(`${screen.url}/api/status${id ? `?id=${id}` : ""}`)).body
  try {
    await run({ screen, supervisor, children, asked, start, status })
  } finally {
    supervisor.killAll()
    screen.close()
    await supervisor.done
  }
}

const shop = project("shop")
const docs = project("docs")
const shopCopy = project("shop copy")

console.log("\nStarting apps")

await check("two different apps get two editors, and the first is untouched", async () => {
  await withSupervisor(async ({ children, start, status }) => {
    const first = await start("http://127.0.0.1:4101", shop)
    assert.equal(first.status, 200)
    assert.deepEqual(Object.keys(first.body).sort(), ["existing", "id", "ok", "replaced", "url"])
    assert.equal(first.body.existing, false)
    assert.equal(first.body.replaced, null)
    assert.equal(first.body.url, null)
    await until(() => children.length === 1, "the first child")
    children[0].ready("http://127.0.0.1:3456")

    const second = await start("http://127.0.0.1:4102", docs)
    assert.equal(second.status, 200)
    assert.notEqual(second.body.id, first.body.id)
    await until(() => children.length === 2, "the second child")
    assert.equal(children[0].killed, null, "starting a second app killed the first app's editor")

    // Each on its own pair of ports.
    assert.equal(portOf(children[0].argv, "--proxy-port"), 3456)
    assert.equal(portOf(children[0].argv, "--ws-port"), 3457)
    assert.equal(portOf(children[1].argv, "--proxy-port"), 3458)
    assert.equal(portOf(children[1].argv, "--ws-port"), 3459)

    children[1].ready("http://127.0.0.1:3458")
    assert.equal((await status(first.body.id)).url, "http://localhost:3456")
    assert.equal((await status(second.body.id)).url, "http://localhost:3458")
  })
})

await check("the same app twice is the editor it already has", async () => {
  await withSupervisor(async ({ children, start, status }) => {
    const first = await start("http://127.0.0.1:4101", shop)
    // Pressed again before the first answered: still one editor.
    const again = await start("http://localhost:4101", `${shop}/`)
    assert.equal(again.status, 200)
    assert.deepEqual(again.body, { ok: true, id: first.body.id, existing: true, replaced: null, url: null })
    await until(() => children.length === 1, "the child")
    children[0].ready("http://127.0.0.1:3456")
    const later = await start("http://127.0.0.1:4101/#/cart", shop)
    assert.equal(later.body.existing, true)
    assert.equal(later.body.id, first.body.id)
    assert.equal(later.body.url, "http://localhost:3456/#/cart")
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(children.length, 1, "a second editor was started for the same app")
    assert.equal(children[0].killed, null)
    // A typed page on a repeat press is where that press lands.
    assert.equal((await status()).url, "http://localhost:3456/#/cart")
  })
})

await check("the same port from another folder replaces that editor, and only it", async () => {
  await withSupervisor(async ({ children, start, status }) => {
    const keep = await start("http://127.0.0.1:4102", docs)
    const old = await start("http://127.0.0.1:4101", shop)
    await until(() => children.length === 2, "two children")
    children[0].ready("http://127.0.0.1:3456")
    children[1].ready("http://127.0.0.1:3458")

    const replacing = await start("http://127.0.0.1:4101", shopCopy)
    assert.equal(replacing.status, 200)
    assert.equal(replacing.body.existing, false)
    assert.equal(replacing.body.replaced, old.body.id)
    await until(() => children.length === 3, "the replacement")
    assert.equal(children[1].killed, "SIGTERM", "the replaced editor is still running")
    assert.equal(children[0].killed, null, "an unrelated editor was stopped")

    const ids = (await status()).editors.map((editor) => editor.id)
    assert.deepEqual(ids, [keep.body.id, replacing.body.id])
    // The replaced one says so to a tab still polling it, not "crashed".
    assert.match((await status(old.body.id)).stopped, /replaced/)
  })
})

await check("stop ends one editor; an unknown id is a 404", async () => {
  await withSupervisor(async ({ children, start, screen, status }) => {
    const a = await start("http://127.0.0.1:4101", shop)
    const b = await start("http://127.0.0.1:4102", docs)
    await until(() => children.length === 2, "two children")
    children[0].ready("http://127.0.0.1:3456")

    const stopped = await post(`${screen.url}/api/stop`, { id: a.body.id })
    assert.deepEqual(stopped, { status: 200, body: { ok: true } })
    await until(() => children[0].killed === "SIGTERM", "the stopped child to be killed")
    assert.equal(children[1].killed, null)
    assert.deepEqual((await status()).editors.map((editor) => editor.id), [b.body.id])
    assert.match((await status(a.body.id)).stopped, /was stopped/)

    const unknown = await post(`${screen.url}/api/stop`, { id: "nope" })
    assert.equal(unknown.status, 404)
    assert.equal(typeof unknown.body.error, "string")
  })
})

await check("an editor that crashes is reported under its own id", async () => {
  await withSupervisor(async ({ children, start, status }) => {
    const a = await start("http://127.0.0.1:4101", shop)
    const b = await start("http://127.0.0.1:4102", docs)
    await until(() => children.length === 2, "two children")
    children[1].ready("http://127.0.0.1:3458")
    children[0].crash(1)
    await until(async () => (await status(a.body.id)).stopped !== null, "the crash to be reported")
    assert.match((await status(a.body.id)).stopped, /The editor for shop stopped with code 1/)
    // The other editor, and the latest choice, are untouched.
    assert.equal((await status(b.body.id)).ready, true)
    const latest = await status()
    assert.equal(latest.ready, true)
    assert.equal(latest.stopped, null)
  })
})

await check("a ready message from an editor already replaced is ignored", async () => {
  await withSupervisor(async ({ children, start, status }) => {
    const old = await start("http://127.0.0.1:4101", shop)
    await until(() => children.length === 1, "the child")
    await start("http://127.0.0.1:4101", shopCopy)
    children[0].ready("http://127.0.0.1:3456")
    assert.equal((await status(old.body.id)).ready, false)
    assert.equal((await status()).editors.length, 1)
  })
})

await check("Ctrl+C takes every editor down", async () => {
  await withSupervisor(async ({ children, start, supervisor }) => {
    await start("http://127.0.0.1:4101", shop)
    await start("http://127.0.0.1:4102", docs)
    await until(() => children.length === 2, "two children")
    supervisor.killAll()
    assert.deepEqual(children.map((child) => child.killed), ["SIGTERM", "SIGTERM"])
  })
})

await check("the supervisor's own port flags are the first pair, not every pair", async () => {
  assert.deepEqual(
    childArgv({}, { projectRoot: shop, appPort: 4101 }, { proxyPort: 3460, wsPort: 3461 }).slice(1),
    ["--project-root", shop, "--no-start", "--no-open", "4101", "--proxy-port", "3460", "--ws-port", "3461"]
  )
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const asked = []
  const supervisor = runEditors(screen, {
    options: { proxyPort: 4800, wsPort: 4801 },
    log: () => {},
    allocatePorts: async (request) => {
      asked.push(request)
      return { proxyPort: 4800, wsPort: 4801 }
    },
    spawnEditor: (argv) => fakeChild(argv),
  })
  try {
    await post(`${screen.url}/api/start`, { url: "http://127.0.0.1:4101", projectRoot: shop, devScript: null })
    await until(() => asked.length === 1, "a port request")
    assert.deepEqual(asked[0].preferred, { proxyPort: 4800, wsPort: 4801 })
    assert.equal(asked[0].appPort, 4101)
    assert.equal(asked[0].projectRoot, shop)
  } finally {
    supervisor.killAll()
    screen.close()
    await supervisor.done
  }
})

await check("a replaced choice still in the queue is never spawned", async () => {
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const children = []
  const asked = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const supervisor = runEditors(screen, {
    log: () => {},
    allocatePorts: async ({ projectRoot, taken }) => {
      asked.push(projectRoot)
      // The first choice holds the loop, so the next one waits in the queue.
      if (asked.length === 1) await gate
      return { proxyPort: 3456 + taken.length, wsPort: 3457 + taken.length }
    },
    spawnEditor: (argv) => {
      const child = fakeChild(argv)
      children.push(child)
      return child
    },
  })
  const press = (url, projectRoot) => post(`${screen.url}/api/start`, { url, projectRoot, devScript: null })
  try {
    await press("http://127.0.0.1:4102", docs)
    await until(() => asked.length === 1, "the first choice to reach the ports")
    const queued = await press("http://127.0.0.1:4101", shop)
    const replacing = await press("http://127.0.0.1:4101", shopCopy)
    assert.equal(replacing.body.replaced, queued.body.id)
    release()
    await until(() => children.length === 2, "two children")
    await new Promise((resolve) => setTimeout(resolve, 30))
    const roots = children.map((child) => child.argv[child.argv.indexOf("--project-root") + 1])
    assert.deepEqual(roots, [docs, shopCopy], "the replaced choice was spawned")
    assert.deepEqual(asked, [docs, shopCopy], "the replaced choice was given ports")
    assert.match((await json(`${screen.url}/api/status?id=${queued.body.id}`)).body.stopped, /replaced/)
  } finally {
    release()
    supervisor.killAll()
    screen.close()
    await supervisor.done
  }
})

await check("a child that ignores SIGTERM is killed, and the next start goes ahead", async () => {
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const children = []
  const supervisor = runEditors(screen, {
    log: () => {},
    stopGraceMs: 30,
    allocatePorts: async ({ taken }) => ({ proxyPort: 3456 + taken.length, wsPort: 3457 + taken.length }),
    spawnEditor: (argv) => {
      const child = fakeChild(argv)
      child.signals = []
      // Exits on SIGKILL only, as a child stuck in a busy loop does.
      child.kill = (signal) => {
        child.signals.push(signal)
        if (signal === "SIGKILL") setImmediate(() => child.emit("exit", null, signal))
      }
      children.push(child)
      return child
    },
  })
  const press = (url, projectRoot) => post(`${screen.url}/api/start`, { url, projectRoot, devScript: null })
  try {
    await press("http://127.0.0.1:4101", shop)
    await until(() => children.length === 1, "the child")
    children[0].ready("http://127.0.0.1:3456")
    await press("http://127.0.0.1:4101", shopCopy)
    await until(() => children.length === 2, "the replacement to start after SIGKILL")
    assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"])
  } finally {
    for (const child of children) child.emit("exit", null, "SIGKILL")
    supervisor.killAll()
    screen.close()
    await supervisor.done
  }
})

/*
 * A stop asks a ready editor over IPC before it signals, so the editor can
 * close its MCP endpoint (a parked `wait_for_change` is answered, not cut).
 * A signal could not: the vendor's SIGTERM handler exits synchronously.
 */
console.log("\nStopping over IPC")

/**
 * A fake child with an IPC channel. `events` records, in order, each message
 * sent to it and each signal, with the time since the first; `onStop` and
 * `onSignal` decide whether it leaves.
 */
function ipcChild(argv, { onStop = () => {}, onSignal = () => {}, sendError = null } = {}) {
  const child = fakeChild(argv)
  child.events = []
  let first = null
  const stamp = (what) => {
    first ??= Date.now()
    child.events.push({ what, at: Date.now() - first })
  }
  child.connected = true
  child.send = (message, callback) => {
    stamp(`send:${message?.type}`)
    setImmediate(() => {
      callback?.(sendError)
      if (!sendError) onStop(child, message)
    })
    return true
  }
  child.kill = (signal) => {
    stamp(signal)
    onSignal(child, signal)
  }
  child.leave = (code, signal = null) => setImmediate(() => child.emit("exit", code, signal))
  child.order = () => child.events.map((event) => event.what)
  return child
}

async function withIpcSupervisor(childOptions, timing, run) {
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const children = []
  const supervisor = runEditors(screen, {
    log: () => {},
    ...timing,
    allocatePorts: async ({ taken }) => ({ proxyPort: 3456 + taken.length, wsPort: 3457 + taken.length }),
    spawnEditor: (argv) => {
      const child = ipcChild(argv, childOptions)
      children.push(child)
      return child
    },
  })
  const press = (url, projectRoot) => post(`${screen.url}/api/start`, { url, projectRoot, devScript: null })
  const stopId = (id) => post(`${screen.url}/api/stop`, { id })
  const status = async (id) => (await json(`${screen.url}/api/status?id=${id}`)).body
  try {
    await run({ children, press, stopId, status, supervisor })
  } finally {
    for (const child of children) child.emit("exit", null, "SIGKILL")
    supervisor.killAll()
    screen.close()
    await supervisor.done
  }
}

await check("a ready editor is asked to stop over IPC, and one that leaves on it gets no signal", async () => {
  await withIpcSupervisor(
    { onStop: (child, message) => message?.type === "stop" && child.leave(0) },
    // A bound no test waits out: the child leaves on the message.
    { stopAskMs: 10_000, stopGraceMs: 10_000 },
    async ({ children, press, stopId, status, supervisor }) => {
      const started = await press("http://127.0.0.1:4101", shop)
      await until(() => children.length === 1, "the child")
      children[0].ready("http://127.0.0.1:3456")
      const before = Date.now()
      assert.equal((await stopId(started.body.id)).status, 200)
      await until(() => supervisor.stateOf(started.body.id) === "exited", "the child to exit on the message")
      assert.ok(Date.now() - before < 2000, "the stop waited on a bound the child never needed")
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.deepEqual(children[0].order(), ["send:stop"], "a child that left on the message was signalled")
      // The screen keeps the reason it was stopped with, not "closed".
      assert.match((await status(started.body.id)).stopped, /was stopped/)
    }
  )
})

await check("an editor that ignores the ask gets SIGTERM after the bound, then SIGKILL after the grace", async () => {
  await withIpcSupervisor(
    // Ignores the message and SIGTERM, as a stuck event loop does.
    { onSignal: (child, signal) => signal === "SIGKILL" && child.leave(null, "SIGKILL") },
    { stopAskMs: 80, stopGraceMs: 80 },
    async ({ children, press }) => {
      await press("http://127.0.0.1:4101", shop)
      await until(() => children.length === 1, "the child")
      children[0].ready("http://127.0.0.1:3456")
      // A replacement waits on the old editor's exit, so it starts only after SIGKILL.
      await press("http://127.0.0.1:4101", shopCopy)
      await until(() => children.length === 2, "the replacement to start after SIGKILL", 3000)
      assert.deepEqual(children[0].order(), ["send:stop", "SIGTERM", "SIGKILL"])
      const [, term, kill] = children[0].events
      assert.ok(term.at >= 75, `SIGTERM came ${term.at} ms after the ask, inside the 80 ms bound`)
      assert.ok(term.at < 1000, `SIGTERM came ${term.at} ms after the ask, far past the 80 ms bound`)
      assert.ok(kill.at - term.at >= 75, `SIGKILL came ${kill.at - term.at} ms after SIGTERM, inside the grace`)
    }
  )
})

await check("an editor still starting is signalled at once, with no ask", async () => {
  await withIpcSupervisor(
    { onSignal: (child, signal) => child.leave(null, signal) },
    { stopAskMs: 10_000 },
    async ({ children, press, stopId }) => {
      const started = await press("http://127.0.0.1:4101", shop)
      await until(() => children.length === 1, "the child")
      // No "ready": the launcher is not listening yet, and nothing serves MCP.
      await stopId(started.body.id)
      await until(() => children[0].events.length > 0, "the stop")
      assert.deepEqual(children[0].order(), ["SIGTERM"])
    }
  )
})

await check("an ask the channel fails to deliver is followed by SIGTERM at once", async () => {
  await withIpcSupervisor(
    { sendError: new Error("channel closed"), onSignal: (child, signal) => child.leave(null, signal) },
    { stopAskMs: 10_000 },
    async ({ children, press, stopId }) => {
      const started = await press("http://127.0.0.1:4101", shop)
      await until(() => children.length === 1, "the child")
      children[0].ready("http://127.0.0.1:3456")
      await stopId(started.body.id)
      await until(() => children[0].events.length === 2, "SIGTERM after the failed ask", 1000)
      assert.deepEqual(children[0].order(), ["send:stop", "SIGTERM"])
    }
  )
})

await check("the port flags beat the first editor's remembered pair, and only the first's", async () => {
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const asked = []
  const supervisor = runEditors(screen, {
    options: { proxyPort: 4800, wsPort: 4801 },
    log: () => {},
    allocatePorts: async (request) => {
      asked.push(request)
      return { proxyPort: 4800 + request.taken.length, wsPort: 4801 + request.taken.length }
    },
    spawnEditor: (argv) => fakeChild(argv),
  })
  try {
    await post(`${screen.url}/api/start`, { url: "http://127.0.0.1:4101", projectRoot: shop, devScript: null })
    await post(`${screen.url}/api/start`, { url: "http://127.0.0.1:4102", projectRoot: docs, devScript: null })
    await until(() => asked.length === 2, "two port requests")
    assert.deepEqual(asked.map((request) => request.explicit), [true, false])
  } finally {
    supervisor.killAll()
    screen.close()
    await supervisor.done
  }
})

/** A child that takes `ms` to exit after SIGTERM, as a real editor closing its servers does. */
function slowChild(argv, ms, events) {
  const child = fakeChild(argv)
  child.kill = (signal) => {
    if (child.killed) return
    child.killed = signal
    setTimeout(() => {
      events.push(`exit ${portOf(argv, "--proxy-port")}`)
      child.emit("exit", null, signal)
    }, ms)
  }
  return child
}

await check("Stop, then Start for the same app, waits for the old editor and keeps its ports", async () => {
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const children = []
  const events = []
  const supervisor = runEditors(screen, {
    log: () => {},
    allocatePorts: async ({ taken }) => {
      for (let proxyPort = 3456; ; proxyPort += 2) {
        if (!taken.includes(proxyPort)) return { proxyPort, wsPort: proxyPort + 1 }
      }
    },
    spawnEditor: (argv) => {
      const child = slowChild(argv, 60, events)
      events.push(`spawn ${portOf(argv, "--proxy-port")}`)
      children.push(child)
      return child
    },
  })
  const press = (url, projectRoot) => post(`${screen.url}/api/start`, { url, projectRoot, devScript: null })
  try {
    const first = await press("http://127.0.0.1:4101", shop)
    await until(() => children.length === 1, "the first child")
    children[0].ready("http://127.0.0.1:3456")
    await post(`${screen.url}/api/stop`, { id: first.body.id })
    // Pressed again before the old process has exited.
    const again = await press("http://127.0.0.1:4101", `${shop}/`)
    assert.equal(again.body.existing, false)
    await until(() => children.length === 2, "the second child")
    assert.deepEqual(events, ["spawn 3456", "exit 3456", "spawn 3456"], "two editors ran for one app, on two origins")
    assert.equal(supervisor.stateOf(first.body.id), "exited")
    assert.equal(supervisor.stateOf(again.body.id), "running")
  } finally {
    supervisor.killAll()
    for (const child of children) child.emit("exit", null, "SIGTERM")
    screen.close()
    await supervisor.done
  }
})

await check("a first choice stopped while it finds its ports does not spend the port flags", async () => {
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const asked = []
  const children = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const supervisor = runEditors(screen, {
    options: { proxyPort: 4800, wsPort: 4801 },
    log: () => {},
    allocatePorts: async (request) => {
      asked.push(request)
      if (asked.length === 1) await gate
      return { proxyPort: 4800 + 2 * (asked.length - 1), wsPort: 4801 + 2 * (asked.length - 1) }
    },
    spawnEditor: (argv) => {
      const child = fakeChild(argv)
      children.push(child)
      return child
    },
  })
  const press = (url, projectRoot) => post(`${screen.url}/api/start`, { url, projectRoot, devScript: null })
  try {
    const first = await press("http://127.0.0.1:4101", shop)
    await until(() => asked.length === 1, "the first choice to reach the ports")
    await post(`${screen.url}/api/stop`, { id: first.body.id })
    // Let the stop reach the supervisor before the ports come back.
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await press("http://127.0.0.1:4102", docs)
    await until(() => children.length === 1, "the second app's child")
    assert.deepEqual(asked.map((request) => request.explicit), [true, true], "the stopped choice spent the flags")
    assert.equal(children[0].argv[children[0].argv.indexOf("--project-root") + 1], docs)
  } finally {
    release()
    supervisor.killAll()
    screen.close()
    await supervisor.done
  }
})

await check("an update restart stops a choice still finding its ports, and nothing starts after", async () => {
  const screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {} })
  const children = []
  let asked = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const supervisor = runEditors(screen, {
    log: () => {},
    allocatePorts: async () => {
      asked += 1
      await gate
      return { proxyPort: 3456, wsPort: 3457 }
    },
    spawnEditor: (argv) => {
      const child = fakeChild(argv)
      children.push(child)
      return child
    },
  })
  try {
    const choice = await post(`${screen.url}/api/start`, { url: "http://127.0.0.1:4101", projectRoot: shop, devScript: null })
    await until(() => asked === 1, "the choice to reach the ports")
    await supervisor.stopAll()
    release()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(children.length, 0, "an editor started after every editor was stopped for the restart")
    assert.equal(supervisor.stateOf(choice.body.id), "exited")
  } finally {
    release()
    supervisor.killAll()
    screen.close()
    await supervisor.done
  }
})

await check("a stop for an editor that already exited cancels nothing", async () => {
  // The screen's side of the race, by hand: the child dies in the same tick
  // the screen pushes its Stop.
  const choices = []
  const stops = []
  const waiting = { choice: null, stop: null }
  const queue = (items, key) => () =>
    items.length ? Promise.resolve(items.shift()) : new Promise((resolve) => (waiting[key] = resolve))
  const push = (items, key, item) => (waiting[key] ? (waiting[key](item), (waiting[key] = null)) : items.push(item))
  const reported = []
  const screen = {
    url: "http://127.0.0.1:1",
    nextChoice: queue(choices, "choice"),
    nextStop: queue(stops, "stop"),
    reportReady: () => {},
    reportStopped: (reason, id) => reported.push(id),
  }
  const children = []
  const supervisor = runEditors(screen, {
    log: () => {},
    allocatePorts: async () => ({ proxyPort: 3456, wsPort: 3457 }),
    spawnEditor: (argv) => {
      const child = fakeChild(argv)
      children.push(child)
      return child
    },
  })
  push(choices, "choice", { id: "1", appPort: 4101, projectRoot: shop, appUrl: "http://127.0.0.1:4101", replaces: null })
  await until(() => children.length === 1, "the child")
  children[0].crash(1)
  await until(() => supervisor.stateOf("1") === "exited", "the crash")
  push(stops, "stop", { id: "1" })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(supervisor.stateOf("1"), "exited")
  assert.deepEqual(reported, ["1"], "the crash was reported once")
  // An id the supervisor has not seen yet is still cancelled before it starts.
  push(stops, "stop", { id: "2" })
  await new Promise((resolve) => setTimeout(resolve, 10))
  push(choices, "choice", { id: "2", appPort: 4102, projectRoot: docs, appUrl: "http://127.0.0.1:4102", replaces: null })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(children.length, 1, "a choice stopped while queued was spawned")
  supervisor.killAll()
})

await check("an editor that exits through its exit hooks after a signal reads as stopped", async () => {
  await withSupervisor(async ({ children, start, status }) => {
    const a = await start("http://127.0.0.1:4101", shop)
    await until(() => children.length === 1, "the child")
    children[0].ready("http://127.0.0.1:3456")
    // runtime/exit-hooks.mjs exits 128 + 15 on SIGTERM rather than dying of it.
    children[0].crash(143)
    await until(async () => (await status(a.body.id)).stopped !== null, "the exit to be reported")
    assert.equal(
      (await status(a.body.id)).stopped,
      "The editor for shop was stopped (SIGTERM). Choose an app to start again."
    )
  })
})

await check("a row edited by an editor started elsewhere opens that editor, not a second", async () => {
  try {
    rememberPage({ port: 4111, projectRoot: shop, page: "/#/cart" })
    publishEditor({
      proxyPort: 4990,
      wsPort: 4991,
      appPort: 4111,
      appUrl: "http://127.0.0.1:4111",
      projectRoot: shop,
      url: "http://localhost:4990",
    })
    await withSupervisor(async ({ children, start }) => {
      // Another spelling of the same folder is the same app.
      const opened = await start("http://localhost:4111", `${shop}/`)
      assert.equal(opened.status, 200)
      assert.deepEqual(opened.body, { ok: true, id: null, existing: true, replaced: null, url: "http://localhost:4990/#/cart" })
      const typed = await start("http://127.0.0.1:4111/settings", shop)
      assert.equal(typed.body.url, "http://localhost:4990/settings")
      // Another folder on that port is another app, and gets its own editor.
      const other = await start("http://127.0.0.1:4111", shopCopy)
      assert.equal(other.body.existing, false)
      await until(() => children.length === 1, "the other folder's child")
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(children.length, 1, "an editor was started for an app that already had one")
    })
  } finally {
    fs.rmSync(registryDir(), { recursive: true, force: true })
  }
})

await check("an editor this screen stopped is not taken for one started elsewhere", async () => {
  try {
    await withSupervisor(async ({ children, start, screen }) => {
      const first = await start("http://127.0.0.1:4112", shop)
      await until(() => children.length === 1, "the child")
      children[0].ready("http://127.0.0.1:4992")
      // Its registry entry outlives the record while the process exits.
      publishEditor({ proxyPort: 4992, wsPort: 4993, appPort: 4112, projectRoot: shop, url: "http://localhost:4992" })
      await post(`${screen.url}/api/stop`, { id: first.body.id })
      const again = await start("http://127.0.0.1:4112", shop)
      assert.equal(again.body.existing, false)
      assert.notEqual(again.body.id, null)
      await until(() => children.length === 2, "a new child")
    })
  } finally {
    fs.rmSync(registryDir(), { recursive: true, force: true })
  }
})

await check("a POST that is not JSON is refused before it changes anything", async () => {
  await withSupervisor(async ({ children, screen, start }) => {
    const plain = (pathname, body, type) =>
      json(`${screen.url}${pathname}`, { method: "POST", headers: { "content-type": type }, body })
    const choice = JSON.stringify({ url: "http://127.0.0.1:4101", projectRoot: shop, devScript: null })
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const refused = await plain("/api/start", choice, type)
      assert.equal(refused.status, 415, type)
      assert.match(refused.body.error, /JSON/)
    }
    const accepted = await start("http://127.0.0.1:4101", shop)
    assert.equal(accepted.status, 200)
    await until(() => children.length === 1, "the child")
    const stop = await plain("/api/stop", JSON.stringify({ id: accepted.body.id }), "text/plain;charset=UTF-8")
    assert.equal(stop.status, 415)
    assert.equal(children[0].killed, null, "a text/plain POST stopped an editor")
    assert.equal((await plain("/api/mcp/stay", "{}", "text/plain")).status, 415)
    // A charset parameter on JSON is still JSON.
    const charset = await json(`${screen.url}/api/stop`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ id: accepted.body.id }),
    })
    assert.equal(charset.status, 200)
  })
})

console.log("\nWhat the screen says")

await check("status lists every editor in start order, with its fields", async () => {
  await withSupervisor(async ({ children, start, status }) => {
    rememberPage({ port: 4101, projectRoot: shop, page: "/#/cart" })
    const a = await start("http://127.0.0.1:4101", shop)
    const b = await start("http://127.0.0.1:4102/guide", docs)
    await until(() => children.length === 2, "two children")
    children[0].ready("http://127.0.0.1:3456")

    const body = await status()
    assert.deepEqual(Object.keys(body).sort(), ["editing", "editors", "ready", "stopped"])
    // The top-level answer is the most recent choice, still starting.
    assert.equal(body.ready, false)
    assert.deepEqual(body.editors, [
      {
        id: a.body.id,
        state: "ready",
        name: "shop",
        appUrl: "http://127.0.0.1:4101",
        appPort: 4101,
        projectRoot: shop,
        packageName: "studio",
        url: "http://localhost:3456/#/cart",
      },
      {
        id: b.body.id,
        state: "starting",
        name: "docs",
        appUrl: "http://127.0.0.1:4102",
        appPort: 4102,
        projectRoot: docs,
        packageName: "studio",
        url: null,
      },
    ])

    children[1].ready("http://127.0.0.1:3458")
    const latest = await status()
    assert.equal(latest.ready, true)
    assert.equal(latest.url, "http://localhost:3458/guide")
    assert.equal(latest.editing.name, "docs")
    assert.equal(latest.editing.packageName, "studio")
  })
})

await check("status for one id answers for that editor; an unknown id stops the poller", async () => {
  await withSupervisor(async ({ children, start, status }) => {
    const a = await start("http://127.0.0.1:4105", shop)
    assert.deepEqual(await status(a.body.id), { ready: false, editing: null, stopped: null })
    await until(() => children.length === 1, "the child")
    children[0].ready("http://127.0.0.1:3456")
    const ready = await status(a.body.id)
    assert.equal(ready.ready, true)
    assert.equal(ready.url, "http://localhost:3456")
    assert.equal(ready.editing.projectRoot, shop)
    assert.equal(ready.stopped, null)
    assert.equal("editors" in ready, false)

    const missing = await status("999")
    assert.equal(missing.ready, false)
    assert.equal(missing.editing, null)
    assert.equal(typeof missing.stopped, "string")
  })
})

await check("MCP is told every time the number of live editors changes", async () => {
  const counts = []
  // The same call the hub's `editorsChanged` gets, without booting a hub.
  const screen = await createStartScreen({
    host: "127.0.0.1",
    port: 0,
    log: () => {},
    onEditorsChanged: (count) => counts.push(count),
  })
  const children = []
  const supervisor = runEditors(screen, {
    log: () => {},
    allocatePorts: async ({ taken }) => ({ proxyPort: 3456 + taken.length, wsPort: 3457 + taken.length }),
    spawnEditor: (argv) => {
      const child = fakeChild(argv)
      children.push(child)
      return child
    },
  })
  try {
    const press = (url, projectRoot) => post(`${screen.url}/api/start`, { url, projectRoot, devScript: null })
    const a = await press("http://127.0.0.1:4101", shop)
    await press("http://127.0.0.1:4101", shop)
    await press("http://127.0.0.1:4102", docs)
    await until(() => children.length === 2, "two children")
    // Ready is not a change in the number.
    children[0].ready("http://127.0.0.1:3456")
    await post(`${screen.url}/api/stop`, { id: a.body.id })
    children[1].crash(1)
    await until(() => counts.length === 4, "the crash to be counted")
    assert.deepEqual(counts, [1, 2, 1, 0])
  } finally {
    supervisor.killAll()
    screen.close()
    await supervisor.done
  }
})

/** A page server in its own process, started in `cwd`, as a dev server is. */
async function childServer(cwd) {
  const source = `const s = require("node:http").createServer((q, r) => {
    r.writeHead(200, { "content-type": "text/html" }); r.end("<title>Studio</title>")
  }); s.listen(0, "127.0.0.1", () => console.log(s.address().port))`
  const child = spawn(process.execPath, ["-e", source], { cwd, stdio: ["ignore", "pipe", "inherit"] })
  const port = await new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))))
  return { port, close: () => child.kill() }
}

await check("an app row names the editor it already has", async () => {
  const mine = await childServer(shop)
  const theirs = await childServer(docs)
  const idle = await childServer(shopCopy)
  try {
    if ((await projectRootForPort(mine.port)) === null) {
      console.log("       skip (this machine will not name another process's folder)")
      return
    }
    rememberPage({ port: mine.port, projectRoot: shop, page: "/#/cart" })
    // An editor this screen did not start: another process, in the registry.
    publishEditor({
      proxyPort: 4990,
      wsPort: 4991,
      appPort: theirs.port,
      appUrl: `http://127.0.0.1:${theirs.port}`,
      projectRoot: docs,
      url: "http://localhost:4990",
    })
    await withSupervisor(async ({ children, start, screen }) => {
      const a = await start(`http://127.0.0.1:${mine.port}`, shop)
      await until(() => children.length === 1, "the child")
      children[0].ready("http://127.0.0.1:3456")
      const { apps } = (await json(`${screen.url}/api/apps`)).body
      const row = (port) => apps.find((app) => app.port === port)
      assert.deepEqual(row(mine.port).editor, { id: a.body.id, url: "http://localhost:3456/#/cart" })
      assert.deepEqual(row(theirs.port).editor, { id: null, url: "http://localhost:4990" })
      assert.equal(row(idle.port).editor, null)
    })
  } finally {
    mine.close()
    theirs.close()
    idle.close()
    fs.rmSync(registryDir(), { recursive: true, force: true })
  }
})

console.log("\nPorts per app")

/** A base port with `count` free ports above it, away from the usual ones. */
async function freeBase(count) {
  const { isPortFree } = await import("../runtime/editor-ports.mjs")
  for (;;) {
    const base = 20000 + 2 * Math.floor(Math.random() * 10000)
    let free = true
    for (let port = base; port < base + count && free; port += 1) free = await isPortFree(port)
    if (free) return base
  }
}

function hold(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve(() => new Promise((done) => server.close(done))))
  })
}

await check("each app keeps its own pair, distinct from every other app's", async () => {
  fs.rmSync(portsFile(), { force: true })
  const base = await freeBase(12)
  const preferred = { proxyPort: base, wsPort: base + 1 }
  const a = await allocatePorts({ projectRoot: shop, appPort: 4101, preferred })
  assert.deepEqual(a, { proxyPort: base, wsPort: base + 1 })
  // Not running and not taken, yet still not handed to another app.
  const b = await allocatePorts({ projectRoot: docs, appPort: 4102, preferred })
  assert.deepEqual(b, { proxyPort: base + 2, wsPort: base + 3 })
  // Back again: the same origin, so its notes are still there.
  assert.deepEqual(await allocatePorts({ projectRoot: shop, appPort: 4101, preferred }), a)
  assert.deepEqual(rememberedPorts({ projectRoot: docs, appPort: 4102 }), b)
  // The same port from another folder is another app.
  const c = await allocatePorts({ projectRoot: shopCopy, appPort: 4101, preferred })
  assert.deepEqual(c, { proxyPort: base + 4, wsPort: base + 5 })
  const saved = JSON.parse(fs.readFileSync(portsFile(), "utf8"))
  assert.deepEqual(saved[`${shop}|4101`], a)
})

await check("busy and taken ports are skipped, and a busy remembered pair moves", async () => {
  fs.rmSync(portsFile(), { force: true })
  const base = await freeBase(12)
  const preferred = { proxyPort: base, wsPort: base + 1 }
  const release = await hold(base + 1)
  try {
    // The first pair's socket port is busy, so the whole pair is skipped.
    const a = await allocatePorts({ projectRoot: shop, appPort: 4101, preferred })
    assert.deepEqual(a, { proxyPort: base + 2, wsPort: base + 3 })
    // Taken by an editor still starting, not yet bound.
    const b = await allocatePorts({ projectRoot: docs, appPort: 4102, preferred, taken: [base + 4] })
    assert.deepEqual(b, { proxyPort: base + 6, wsPort: base + 7 })
  } finally {
    await release()
  }
  // A remembered pair that something else now holds is not reused, and the
  // app's memory moves with it: that pair is lost to another program.
  const squat = await hold(base + 2)
  try {
    const moved = await allocatePorts({ projectRoot: shop, appPort: 4101, preferred })
    assert.deepEqual(moved, { proxyPort: base, wsPort: base + 1 })
    assert.deepEqual(rememberedPorts({ projectRoot: shop, appPort: 4101 }), moved)
  } finally {
    await squat()
  }
})

await check("a remembered pair an editor of the same app still holds stays remembered", async () => {
  fs.rmSync(portsFile(), { force: true })
  const base = await freeBase(8)
  const preferred = { proxyPort: base, wsPort: base + 1 }
  const own = await allocatePorts({ projectRoot: shop, appPort: 4140, preferred })
  assert.deepEqual(own, preferred)
  // The app's previous editor, still up (shutting down, or started from
  // another terminal): bound, and on the register.
  const held = await hold(own.proxyPort)
  publishEditor({ proxyPort: own.proxyPort, wsPort: own.wsPort, appPort: 4140, projectRoot: `${shop}/`, url: `http://localhost:${own.proxyPort}` })
  try {
    const borrowed = await allocatePorts({ projectRoot: shop, appPort: 4140, preferred })
    assert.notDeepEqual(borrowed, own)
    assert.deepEqual(rememberedPorts({ projectRoot: shop, appPort: 4140 }), own, "the app lost its origin to one run")
    // Held by one of the caller's own editors counts the same.
    fs.rmSync(registryDir(), { recursive: true, force: true })
    await allocatePorts({ projectRoot: shop, appPort: 4140, preferred, taken: [own.proxyPort, own.wsPort] })
    assert.deepEqual(rememberedPorts({ projectRoot: shop, appPort: 4140 }), own)
  } finally {
    await held()
    fs.rmSync(registryDir(), { recursive: true, force: true })
  }
  // Free again: the app is back on it.
  assert.deepEqual(await allocatePorts({ projectRoot: shop, appPort: 4140, preferred }), own)
})

await check("a pair that is not free is handed out but never written down", async () => {
  fs.rmSync(portsFile(), { force: true })
  const base = await freeBase(2)
  // Every pair the scan could try, taken.
  const taken = Array.from({ length: 400 }, (_, index) => base + index)
  const pair = await allocatePorts({ projectRoot: docs, appPort: 4150, preferred: { proxyPort: base, wsPort: base + 1 }, taken })
  assert.deepEqual(pair, { proxyPort: base, wsPort: base + 1 })
  assert.equal(rememberedPorts({ projectRoot: docs, appPort: 4150 }), null)
})

await check("an unreadable ports file costs the memory, not the launch", async () => {
  fs.mkdirSync(path.dirname(portsFile()), { recursive: true })
  fs.writeFileSync(portsFile(), "{not json")
  const base = await freeBase(4)
  const pair = await allocatePorts({ projectRoot: shop, appPort: 4101, preferred: { proxyPort: base, wsPort: base + 1 } })
  assert.deepEqual(pair, { proxyPort: base, wsPort: base + 1 })
})

await check("a port held only on ::1 is not free", async () => {
  const base = await freeBase(2)
  const server = net.createServer()
  const bound = await new Promise((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(base, "::1", () => resolve(true))
  })
  if (!bound) {
    console.log("       skip (this machine has no IPv6 loopback)")
    return
  }
  try {
    assert.equal(await isPortFree(base), false, "a dev server on [::1] would answer the editor's localhost address")
    assert.equal(await isPortFree(base + 1), true)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

await check("an explicit port pair beats a remembered one when it is free", async () => {
  fs.rmSync(portsFile(), { force: true })
  const base = await freeBase(8)
  const remembered = await allocatePorts({ projectRoot: shop, appPort: 4101, preferred: { proxyPort: base, wsPort: base + 1 } })
  const flags = { proxyPort: base + 4, wsPort: base + 5 }
  // Not explicit: the remembered origin stands.
  assert.deepEqual(await allocatePorts({ projectRoot: shop, appPort: 4101, preferred: flags }), remembered)
  assert.deepEqual(await allocatePorts({ projectRoot: shop, appPort: 4101, preferred: flags, explicit: true }), flags)
  // Busy flags fall back to memory.
  const squat = await hold(base + 4)
  try {
    const fallback = await allocatePorts({ projectRoot: docs, appPort: 4102, preferred: flags, explicit: true })
    assert.notDeepEqual(fallback, flags)
  } finally {
    await squat()
  }
})

await check("ports are remembered under the real folder, and old raw keys still read", async () => {
  fs.rmSync(portsFile(), { force: true })
  const link = path.join(fixture("link"), "shop-link")
  fs.symlinkSync(shop, link)
  const base = await freeBase(8)
  const pair = await allocatePorts({ projectRoot: link, appPort: 4120, preferred: { proxyPort: base, wsPort: base + 1 } })
  assert.deepEqual(rememberedPorts({ projectRoot: shop, appPort: 4120 }), pair)
  assert.deepEqual(rememberedPorts({ projectRoot: `${shop}/`, appPort: 4120 }), pair)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(portsFile(), "utf8"))), [`${shop}|4120`])

  // Written by an older version, under the root as it was spelled.
  const old = { proxyPort: base + 4, wsPort: base + 5 }
  const saved = JSON.parse(fs.readFileSync(portsFile(), "utf8"))
  fs.writeFileSync(portsFile(), JSON.stringify({ ...saved, [`${link}|4121`]: old }))
  assert.deepEqual(rememberedPorts({ projectRoot: link, appPort: 4121 }), old)
  assert.deepEqual(await allocatePorts({ projectRoot: link, appPort: 4121 }), old)
  const moved = JSON.parse(fs.readFileSync(portsFile(), "utf8"))
  assert.equal(`${link}|4121` in moved, false, "the old key was left beside the new one")
  assert.deepEqual(moved[`${shop}|4121`], old)
})

console.log("\nPinned ports in the editor")

await check("pinned ports turn the vendor's walk into a refusal, and only then", async () => {
  const pinned = { proxy: 4800, ws: 4801 }
  // The socket server's probe: its own port, then the walk upward.
  assert.equal(vendorBindPort(pinned, 3457, "ws"), 4801)
  assert.equal(vendorBindPort(pinned, 3458, "ws"), null)
  assert.equal(vendorBindPort(pinned, 3556, "ws"), null)
  // The proxy's: 3457 is not this editor's socket port here, and 3458 is
  // literal, possibly a sibling editor's.
  assert.equal(vendorBindPort(pinned, 3456, "proxy"), 4800)
  for (let port = 3457; port < 3557; port += 1) assert.equal(vendorBindPort(pinned, port, "proxy"), null, String(port))
  // Binds outside the walk, and binds once both servers are up, pass.
  assert.equal(vendorBindPort(pinned, 0, "proxy"), 0)
  assert.equal(vendorBindPort(pinned, 5747, "proxy"), 5747)
  assert.equal(vendorBindPort(pinned, 3458, null), 3458)
  assert.equal(vendorBindPort(pinned, 3457, null), 4801)

  // Unpinned, the walk is the vendor's own.
  const auto = { proxy: "auto", ws: "auto" }
  for (const phase of ["ws", "proxy", null]) {
    for (const port of [3456, 3457, 3458, 3500]) assert.equal(vendorBindPort(auto, port, phase), port)
  }
})

console.log("\nLast pages, written by many editors at once")

await check("concurrent writers in separate processes keep every page", async () => {
  fs.rmSync(pagesDir(), { recursive: true, force: true })
  const moduleUrl = new URL("../runtime/last-pages.mjs", import.meta.url).href
  const writers = Array.from({ length: 8 }, (_, index) => {
    const source = `const { rememberPage } = await import(${JSON.stringify(moduleUrl)})
      for (let round = 0; round < 20; round += 1) {
        rememberPage({ port: ${5100 + index}, projectRoot: "/work/app-${index}", page: "/page-${index}/" + round })
      }`
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, HOME: home },
      stdio: "inherit",
    })
    return new Promise((resolve) => child.once("exit", resolve))
  })
  assert.deepEqual(await Promise.all(writers), Array(8).fill(0))
  for (let index = 0; index < 8; index += 1) {
    assert.equal(lastPage({ port: 5100 + index, projectRoot: `/work/app-${index}` }), `/page-${index}/19`)
  }
})

await check("pages saved in the old single file are still read", async () => {
  fs.mkdirSync(path.dirname(pagesFile()), { recursive: true })
  fs.writeFileSync(pagesFile(), JSON.stringify({ "/work/old|4200": "/#/saved" }))
  assert.equal(lastPage({ port: 4200, projectRoot: "/work/old" }), "/#/saved")
  // A newer write wins over the old file.
  rememberPage({ port: 4200, projectRoot: "/work/old", page: "/#/newer" })
  assert.equal(lastPage({ port: 4200, projectRoot: "/work/old" }), "/#/newer")
  // Only pages: never a path that leaves the app's origin.
  rememberPage({ port: 4200, projectRoot: "/work/old", page: "//elsewhere.test/" })
  assert.equal(lastPage({ port: 4200, projectRoot: "/work/old" }), "/#/newer")
})

await check("every spelling of a project folder finds one last page, and old raw keys still read", async () => {
  const link = path.join(fixture("link"), "shop-link")
  fs.symlinkSync(shop, link)
  rememberPage({ port: 4130, projectRoot: link, page: "/#/from-link" })
  assert.equal(lastPage({ port: 4130, projectRoot: shop }), "/#/from-link")
  assert.equal(lastPage({ port: 4130, projectRoot: `${shop}/` }), "/#/from-link")

  // A file written by an older version, keyed by the root as it was spelled.
  const rawKey = `${link}|4131`
  const rawFile = path.join(pagesDir(), `${crypto.createHash("sha1").update(rawKey).digest("hex")}.json`)
  fs.mkdirSync(pagesDir(), { recursive: true })
  fs.writeFileSync(rawFile, JSON.stringify({ key: rawKey, page: "/#/old" }))
  assert.equal(lastPage({ port: 4131, projectRoot: link }), "/#/old")
  // A newer write, under the real folder, wins over it.
  rememberPage({ port: 4131, projectRoot: shop, page: "/#/new" })
  assert.equal(lastPage({ port: 4131, projectRoot: link }), "/#/new")
})

for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
