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
fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
