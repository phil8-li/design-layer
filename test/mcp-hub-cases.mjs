/**
 * "Stay on between apps": the start screen serving MCP while editors come and go.
 *
 * The claim: with the setting on, the MCP port never closes when an editor
 * stops, and moving the endpoint between an editor and the start screen does
 * not fail an agent's call, end its session or drop a change it was sent.
 * Some clients drop a server's tools after one failed call, so each of those
 * is the difference between an agent that keeps working and one that has to
 * be restarted.
 *
 * Everything runs in this process over real loopback sockets: a start screen
 * with its hub, an editor-side control, and an agent speaking JSON-RPC.
 *
 * Usage: node test/mcp-hub-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { createMcpHub } from "../runtime/mcp-hub.mjs"
import { createStartScreen } from "../runtime/start-screen.mjs"
import { createMcpControl } from "../server/mcp-control.mjs"

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

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * One JSON-RPC call on a fresh connection, the way an agent's next call after a
 * move would reach whichever process holds the port by then.
 */
function rpc(port, body, session = null) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(payload),
          ...(session ? { "mcp-session-id": session } : {}),
        },
      },
      (response) => {
        let text = ""
        response.on("data", (chunk) => (text += chunk))
        response.on("end", () =>
          resolve({ status: response.statusCode, session: response.headers["mcp-session-id"], body: text ? JSON.parse(text) : null })
        )
      }
    )
    request.on("error", reject)
    request.end(payload)
  })
}

const tool = async (port, session, name, args = {}) => {
  const response = await rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, session)
  assert.equal(response.status, 200, `${name} answered ${response.status}`)
  return JSON.parse(response.body.result.content[0].text)
}

const portIsOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1")
    socket.once("connect", () => (socket.destroy(), resolve(true)))
    socket.once("error", () => resolve(false))
  })

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "de-mcp-hub-"))
const file = path.join(dir, "mcp.json")
const MCP_PORT = await freePort()

let screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {}, mcp: { file, port: MCP_PORT } })
const hubGet = (token = screen.mcpToken) =>
  fetch(new URL("api/mcp", screen.url), { headers: token ? { "x-designlayer-token": token } : {} })

let control = createMcpControl({ port: MCP_PORT, hubUrl: screen.url, token: screen.mcpToken })

console.log("\nOff by default")

await check("with the setting off, the start screen serves no MCP", async () => {
  const status = await (await hubGet()).json()
  assert.equal(status.hosting, false)
  assert.equal(await portIsOpen(MCP_PORT), false, "something answered on the MCP port before anyone asked")
})

await check("its MCP routes answer only an editor it started", async () => {
  assert.equal((await hubGet(null)).status, 403)
  assert.equal((await hubGet("not-the-token")).status, 403)
  assert.equal((await hubGet()).status, 200)
})

await check("an editor serves MCP itself, and is told it can stay on between apps", async () => {
  const state = await control.boot()
  assert.equal(state.mode, "local")
  const status = await control.status()
  assert.equal(status.url, `http://127.0.0.1:${MCP_PORT}/mcp`)
  assert.equal(status.stay, false)
  assert.equal(status.canStay, true, "the switch would be hidden for an editor that can use it")
})

console.log("\nMoving the endpoint")

let session = null

await check("turning it on ends a parked wait as a timeout, and the session keeps working", async () => {
  const init = await rpc(MCP_PORT, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent", version: "1" } },
  })
  session = init.session
  assert.ok(session)
  const parked = tool(MCP_PORT, session, "wait_for_change", { timeoutSeconds: 30 })
  await new Promise((resolve) => setTimeout(resolve, 100))

  await control.setStay(true)

  const answer = await parked
  assert.equal(answer.timeout, true, "the parked call failed instead of timing out")
  const status = await (await hubGet()).json()
  assert.equal(status.hosting, true, "the start screen did not take the port")
  assert.equal(control.mode, "hub")
  // The id the editor issued, now answered by the start screen.
  const listed = await tool(MCP_PORT, session, "list_changes")
  assert.equal(listed.count, 0)
})

await check("while on, a send lands in the start screen's queue and the panel reads it there", async () => {
  const sent = await control.deliver({ origin: "prompts", prompt: "1 note from DesignLayer", brief: "### a.tsx" })
  assert.ok(sent.delivered?.id, "the send was not recorded")
  assert.equal(sent.listening, true)
  const status = await control.status()
  assert.equal(status.stay, true)
  assert.equal(status.pending, 1)
  assert.equal(status.url, `http://127.0.0.1:${MCP_PORT}/mcp`)
  const listed = await tool(MCP_PORT, session, "list_changes")
  assert.equal(listed.changes[0].id, sent.delivered.id)
})

await check("turning it off brings the endpoint back with the waiting change, under the same id", async () => {
  const [waiting] = (await tool(MCP_PORT, session, "list_changes")).changes
  await control.setStay(false)
  assert.equal(control.mode, "local")
  assert.equal((await (await hubGet()).json()).hosting, false)
  const listed = await tool(MCP_PORT, session, "list_changes")
  assert.equal(listed.changes[0]?.id, waiting.id, "the change did not come back with the endpoint")
  const resolved = await tool(MCP_PORT, session, "resolve_change", { id: waiting.id })
  assert.equal(resolved.ok, true, "the agent could not resolve the change by the id it was handed")
})

console.log("\nThe setting")

await check("the setting is saved, and a new start screen serves from boot", async () => {
  await control.setStay(true)
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).stayBetweenApps, true)
  // The editor goes away; the port must not.
  assert.equal(await portIsOpen(MCP_PORT), true)
  screen.close()
  await new Promise((resolve) => setTimeout(resolve, 200))
  screen = await createStartScreen({ host: "127.0.0.1", port: 0, log: () => {}, mcp: { file, port: MCP_PORT } })
  assert.equal((await (await hubGet()).json()).hosting, true, "the saved setting was not honoured at boot")
  const fresh = createMcpControl({ port: MCP_PORT, hubUrl: screen.url, token: screen.mcpToken })
  assert.equal((await fresh.boot()).mode, "hub", "a new editor bound a port the start screen already serves")
  await fresh.setStay(false)
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).stayBetweenApps, false)
  await fresh.close()
})

await check("with another program on the port, turning it on fails with a reason and changes nothing", async () => {
  const squatter = net.createServer().listen(MCP_PORT, "127.0.0.1")
  await new Promise((resolve) => squatter.once("listening", resolve))
  try {
    const stuck = createMcpControl({ port: MCP_PORT, hubUrl: screen.url, token: screen.mcpToken })
    assert.equal((await stuck.boot()).mode, "off")
    await assert.rejects(stuck.setStay(true), /Another program is using port/)
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).stayBetweenApps, false, "a failed switch was saved")
  } finally {
    await new Promise((resolve) => squatter.close(resolve))
  }
})

await check("an editor with no start screen behind it is not offered the switch", async () => {
  const alone = createMcpControl({ port: null })
  assert.equal((await alone.status()).canStay, false)
  await assert.rejects(alone.setStay(true), /wasn’t started from the start screen/)
})

screen.close()

/*
 * Several editors at once, one per app. Only one process can hold the MCP port,
 * so with each editor serving its own, every send but the first editor's went
 * nowhere. The hub here sits behind the same three routes the start screen
 * mounts for it, so the editors reach it exactly as they do in the app.
 */
console.log("\nMany editors, one endpoint")

async function hubScreen(options) {
  const hub = createMcpHub({ isLocalRequest: () => true, log: () => {}, ...options })
  const routes = {
    "GET /api/mcp": async () => hub.status(),
    "POST /api/mcp/push": async (body) => hub.push(body ?? {}),
    "POST /api/mcp/stay": async (body) => hub.stay(body?.on === true, Array.isArray(body?.pending) ? body.pending : []),
  }
  const listener = http.createServer(async (req, res) => {
    let text = ""
    for await (const chunk of req) text += chunk
    const route = routes[`${req.method} ${req.url}`]
    const reply = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(payload))
    }
    if (!route || req.headers["x-designlayer-token"] !== hub.token) return reply(403, { error: "no" })
    try {
      reply(200, await route(text ? JSON.parse(text) : null))
    } catch (error) {
      reply(error.statusCode ?? 500, { error: error.message })
    }
  })
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve))
  return {
    hub,
    url: `http://127.0.0.1:${listener.address().port}/`,
    async close() {
      await hub.close()
      listener.closeAllConnections()
      await new Promise((resolve) => listener.close(resolve))
    },
  }
}

const MANY_PORT = await freePort()
const manyFile = path.join(dir, "many.json")
const many = await hubScreen({ port: MANY_PORT, file: manyFile })
const editorFor = () => createMcpControl({ port: MANY_PORT, hubUrl: many.url, token: many.hub.token })
const shop = editorFor()
const docs = editorFor()
let manySession = null

await check("the first editor makes the start screen serve MCP, with the setting off", async () => {
  assert.equal(many.hub.status().hosting, false, "it served MCP before any editor existed")
  await many.hub.editorsChanged(1)
  const status = many.hub.status()
  assert.equal(status.hosting, true)
  assert.equal(status.shared, true)
  assert.equal(fs.existsSync(manyFile), false, "hosting for editors saved the setting")
})

await check("two editors both relay to it, and neither binds the port", async () => {
  assert.equal((await shop.boot()).mode, "hub")
  await many.hub.editorsChanged(2)
  assert.equal((await docs.boot()).mode, "hub", "a second editor tried to serve the port itself")
  const status = await docs.status()
  assert.equal(status.url, `http://127.0.0.1:${MANY_PORT}/mcp`)
  assert.equal(status.shared, true)
  assert.equal(status.stay, true, "the switch would show off while MCP is shared")
})

await check("a send from each editor reaches the one agent, each naming its project", async () => {
  const init = await rpc(MANY_PORT, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent", version: "1" } },
  })
  manySession = init.session
  const fromShop = await shop.deliver({ origin: "prompts", prompt: "1 note", projectRoot: "/work/shop", app: "shop" })
  const fromDocs = await docs.deliver({ origin: "prompts", prompt: "1 note", projectRoot: "/work/docs", app: "docs" })
  assert.ok(fromShop.delivered?.id && fromDocs.delivered?.id, "a send was dropped")
  assert.equal(fromDocs.listening, true, "the second editor's send was reported as going nowhere")
  const listed = await tool(MANY_PORT, manySession, "list_changes")
  assert.deepEqual(
    listed.changes.map((change) => [change.app, change.projectRoot]),
    [["shop", "/work/shop"], ["docs", "/work/docs"]]
  )
})

await check("turning the switch off from one editor is refused, and MCP stays shared", async () => {
  await assert.rejects(docs.setStay(false), /shares this MCP address, so it stays on/)
  assert.equal(docs.mode, "hub")
  assert.equal(many.hub.status().hosting, true)
  assert.equal(await portIsOpen(MANY_PORT), true)
  assert.equal(fs.existsSync(manyFile), false, "a refused switch was saved")
})

await check("after the last editor stops, the endpoint stays up with its changes", async () => {
  await many.hub.editorsChanged(0)
  const status = many.hub.status()
  assert.equal(status.hosting, true, "the port closed with changes still waiting")
  assert.equal(status.shared, false)
  assert.equal(status.pending, 2)
  assert.equal((await tool(MANY_PORT, manySession, "list_changes")).count, 2)
})

await many.close()

await check("an editor that boots while the start screen is binding waits for it", async () => {
  const racePort = await freePort()
  const race = await hubScreen({ port: racePort, file: manyFile })
  // An editor from before is still letting the port go.
  const leaving = net.createServer().listen(racePort, "127.0.0.1")
  await new Promise((resolve) => leaving.once("listening", resolve))
  try {
    const hosting = race.hub.editorsChanged(1)
    assert.equal(race.hub.status().starting, true)
    setTimeout(() => leaving.close(), 300)
    const early = createMcpControl({ port: racePort, hubUrl: race.url, token: race.hub.token })
    assert.equal((await early.boot()).mode, "hub", "the editor raced the start screen for the port")
    await hosting
    assert.equal(race.hub.status().hosting, true)
  } finally {
    await race.close()
  }
})

/*
 * The hub tried the port only when the editor count changed. A first bind
 * that lost to a briefly busy port sent editor 1 to serve the port itself, and
 * editor 2's count change then failed against editor 1: editor 2 ended off,
 * its sends reaching no agent. One process must own the endpoint.
 */
console.log("\nOne owner when the first bind fails")

await check("a supervised editor never binds the port, and reports the start screen's reason", async () => {
  const busyPort = await freePort()
  const busy = await hubScreen({ port: busyPort, file: manyFile })
  const squatter = net.createServer().listen(busyPort, "127.0.0.1")
  await new Promise((resolve) => squatter.once("listening", resolve))
  try {
    await busy.hub.editorsChanged(1)
    assert.equal(busy.hub.status().hosting, false)
    const first = createMcpControl({ port: busyPort, hubUrl: busy.url, token: busy.hub.token })
    const state = await first.boot()
    assert.equal(state.mode, "off", "the editor took the port the start screen owns")
    assert.match(state.error, new RegExp(`Another program is using port ${busyPort}`))
    const status = await first.status()
    assert.equal(status.url, null)
    assert.equal(status.listening, false)
    assert.match(status.reason, /Another program is using port/)
    const sent = await first.deliver({ origin: "prompts", prompt: "1 note" })
    assert.equal(sent.delivered, null, "a send was promised to an agent nobody serves")
  } finally {
    await new Promise((resolve) => squatter.close(resolve))
    await busy.close()
  }
})

await check("once the port frees, a status read makes the start screen host and both editors relay", async () => {
  const busyPort = await freePort()
  const busy = await hubScreen({ port: busyPort, file: manyFile })
  const squatter = net.createServer().listen(busyPort, "127.0.0.1")
  await new Promise((resolve) => squatter.once("listening", resolve))
  try {
    await busy.hub.editorsChanged(1)
    const first = createMcpControl({ port: busyPort, hubUrl: busy.url, token: busy.hub.token })
    assert.equal((await first.boot()).mode, "off")
    await new Promise((resolve) => squatter.close(resolve))

    const status = await first.status()
    assert.equal(first.mode, "hub", "the editor did not switch to relaying once the start screen hosted")
    assert.equal(status.url, `http://127.0.0.1:${busyPort}/mcp`)
    assert.equal(busy.hub.status().hosting, true)

    await busy.hub.editorsChanged(2)
    const second = createMcpControl({ port: busyPort, hubUrl: busy.url, token: busy.hub.token })
    assert.equal((await second.boot()).mode, "hub", "the second editor ended off")
    const fromFirst = await first.deliver({ origin: "prompts", prompt: "1 note", app: "shop" })
    const fromSecond = await second.deliver({ origin: "prompts", prompt: "1 note", app: "docs" })
    assert.ok(fromFirst.delivered?.id && fromSecond.delivered?.id, "a send was dropped")
    assert.equal(busy.hub.status().pending, 2)
  } finally {
    if (squatter.listening) await new Promise((resolve) => squatter.close(resolve))
    await busy.close()
  }
})

await check("a send alone is enough to rejoin the start screen", async () => {
  const busyPort = await freePort()
  const busy = await hubScreen({ port: busyPort, file: manyFile })
  const squatter = net.createServer().listen(busyPort, "127.0.0.1")
  await new Promise((resolve) => squatter.once("listening", resolve))
  try {
    await busy.hub.editorsChanged(1)
    const first = createMcpControl({ port: busyPort, hubUrl: busy.url, token: busy.hub.token })
    assert.equal((await first.boot()).mode, "off")
    await new Promise((resolve) => squatter.close(resolve))
    const sent = await first.deliver({ origin: "prompts", prompt: "1 note" })
    assert.ok(sent.delivered?.id, "the send after the port freed went nowhere")
    assert.equal(first.mode, "hub")
    assert.equal(busy.hub.status().pending, 1)
  } finally {
    if (squatter.listening) await new Promise((resolve) => squatter.close(resolve))
    await busy.close()
  }
})

await check("the start screen retries only while editors run", async () => {
  const idlePort = await freePort()
  const idle = await hubScreen({ port: idlePort, file: manyFile })
  try {
    const status = idle.hub.status()
    assert.equal(status.starting, false, "a status read with no editors tried the port")
    assert.equal(status.hosting, false)
    assert.equal(await portIsOpen(idlePort), false)
  } finally {
    await idle.close()
  }
})

await check("an editor with no start screen still serves the port itself", async () => {
  const alonePort = await freePort()
  const alone = createMcpControl({ port: alonePort })
  try {
    assert.equal((await alone.boot()).mode, "local")
    assert.equal((await alone.status()).url, `http://127.0.0.1:${alonePort}/mcp`)
  } finally {
    await alone.close()
  }
})

fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
