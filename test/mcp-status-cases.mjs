/**
 * "Is an agent connected?" — the question the Changes tab asks, and the one it
 * used to get wrong.
 *
 * The status block read `endpointListening` and rendered it as "your agent is
 * connected". That flag is set by the LAUNCHER when our own MCP port binds, so
 * it is true from the moment the editor starts and says nothing at all about
 * whether anybody is on the other end. Every designer was told their agent was
 * attached before they had configured one, and the line never changed again —
 * which is exactly what "the coding agent field is not working" looks like from
 * the outside.
 *
 * So the three facts are now reported separately, and this suite pins them
 * against a REAL MCP endpoint over real loopback HTTP: our port being up, an
 * agent having completed a handshake, and an agent being parked in
 * `wait_for_change` right now. Each fails independently and each gets its own
 * sentence in the panel.
 */

import assert from "node:assert/strict"
import http from "node:http"

import { resolveConfig } from "../config.mjs"
import { createHandoffQueue, handoffQueue } from "../server/handoff.mjs"
import { createMcpEndpoint } from "../server/mcp.mjs"
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

const PROTOCOL = "2025-06-18"

/** One JSON-RPC call over the real endpoint, with real headers. */
function call(port, body, sessionId) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
      },
      (res) => {
        let text = ""
        res.on("data", (chunk) => (text += chunk))
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            session: res.headers["mcp-session-id"],
            body: text ? JSON.parse(text) : null,
          })
        )
      }
    )
    request.on("error", reject)
    request.end(payload)
  })
}

function close(port, sessionId) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "DELETE",
        headers: { "mcp-session-id": sessionId },
      },
      (res) => {
        res.resume()
        res.on("end", () => resolve(res.statusCode))
      }
    )
    request.on("error", reject)
    request.end()
  })
}

console.log("\nWhether an agent is actually there")

const queue = createHandoffQueue()
const endpoint = createMcpEndpoint({ queue, isLocalRequest: () => true })
// `listen` resolves to the node server itself, so the ephemeral port comes off
// its address. Port 0 rather than 5747: the real one is very often already held
// by an editor somebody is using, and a suite that fights for it fails for a
// reason that has nothing to do with what it tests.
const server = await endpoint.listen(0, "127.0.0.1")
const port = server.address().port

await check("a bound port is not a connected agent", () => {
  // The whole bug in one assertion. The launcher marks the endpoint listening
  // the moment the port binds; if that counted as "connected", the panel would
  // claim an agent before anything had spoken to us.
  queue.markEndpointListening()
  assert.equal(queue.endpointListening, true, "the endpoint did not report itself up")
  assert.equal(queue.attachedAgents, 0, "a bound port was counted as an attached agent")
})

let session = null

await check("an agent that completes a handshake is counted", async () => {
  const reply = await call(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t", version: "1" } },
  })
  assert.equal(reply.status, 200)
  session = reply.session
  assert.ok(session, "no session id came back from initialize")
  assert.equal(queue.attachedAgents, 1, "a handshaken agent was not counted")
})

await check("a second agent is counted too, and they do not collide", async () => {
  const reply = await call(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t2", version: "1" } },
  })
  assert.equal(reply.status, 200)
  assert.equal(queue.attachedAgents, 2)
  await close(port, reply.session)
  // Counted DOWN as well as up. A status that only ever climbed would show a
  // connected agent forever after the designer quit their editor, which is the
  // same lie in the other direction.
  assert.equal(queue.attachedAgents, 1, "a departed agent was still counted")
})

await check("an agent that leaves stops being counted", async () => {
  assert.equal(await close(port, session), 204)
  assert.equal(queue.attachedAgents, 0, "the last agent left and the count did not")
})

await check("attached and waiting are different questions", async () => {
  const reply = await call(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t3", version: "1" } },
  })
  const id = reply.session
  assert.equal(queue.attachedAgents, 1)
  /*
   * Attached, and NOT waiting — an agent mid-turn. This is the state the panel
   * must render as working rather than broken: it is what a correctly
   * configured agent looks like for the whole time it is off doing the work it
   * was just handed, and calling that "disconnected" would have a working setup
   * flicker to failure on every request.
   */
  assert.equal(queue.waiting, 0, "an idle-but-attached agent was reported as waiting")
  await close(port, id)
})

/*
 * Most clients quit by closing the socket and never send DELETE. A count kept
 * only on initialize and DELETE went up with every agent restart and never came
 * down, so the panel reported an agent nobody was running. A session silent for
 * ten minutes stops counting; one that speaks again counts again.
 */
await check("an agent that vanishes without DELETE stops being counted", async () => {
  const reply = await call(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t4", version: "1" } },
  })
  assert.equal(queue.attachedAgents, 1)
  const realNow = Date.now
  const startedAt = realNow()
  try {
    Date.now = () => startedAt + 11 * 60 * 1000
    assert.equal(queue.attachedAgents, 0, "a session silent for eleven minutes was still counted")
    const again = await call(port, { jsonrpc: "2.0", id: 2, method: "ping" }, reply.session)
    assert.equal(again.status, 200, "a quiet session was refused rather than recognized")
    assert.equal(queue.attachedAgents, 1, "a session that spoke again was not counted")
  } finally {
    Date.now = realNow
  }
  await close(port, reply.session)
})

await new Promise((resolve) => server.close(resolve))

/* ==========================================================================
 * The route the panel actually reads it through
 * ======================================================================== */

/*
 * Everything above this line exercises the queue and the endpoint directly, and
 * every case passed while the feature was completely broken in the browser.
 *
 * `GET /__designlayer/mcp/status` read a free `config` that does not exist in
 * the handler's scope — `route()` takes its dependencies as arguments — so the
 * route threw a ReferenceError and answered 500 to every request it ever
 * received. The three facts this suite pins so carefully never reached the
 * panel: it could only render "disconnected", whatever the queue knew.
 *
 * So the last two cases go through the real handler over a real socket. A unit
 * test of a collaborator cannot see a wiring fault between that collaborator
 * and the thing that calls it, and this one hid behind a green suite.
 */
console.log("\nThe route the panel reads it through")

/** The routes over a real loopback socket, because the guard reads the socket. */
async function statusRoute(ports) {
  const config = resolveConfig({ ports })
  const routes = createDesignLayerRoutes(config)
  const listener = http.createServer((request, response) => {
    if (routes.handle(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const at = listener.address().port
  return {
    get: () => fetch(`http://127.0.0.1:${at}${config.apiPrefix}/mcp/status`),
    close: () => new Promise((resolve) => listener.close(resolve)),
  }
}

/*
 * A configured port is not a bound one. A second editor started on the default
 * port logs that it is taken; printing the address anyway pointed the agent at
 * the FIRST editor's project. The route reads the process-wide queue, which
 * this process has not marked listening yet.
 */
await check("a configured port this process never bound is reported as no URL", async () => {
  const api = await statusRoute({ mcp: 5747 })
  try {
    const payload = await (await api.get()).json()
    assert.equal(payload.listening, false)
    assert.equal(payload.url, null, "an address was printed for a port another process holds")
    assert.equal(payload.port, null)
  } finally {
    await api.close()
  }
})

await check("GET /mcp/status answers 200 with the port it was configured with", async () => {
  // What the launcher does once its MCP port binds.
  handoffQueue().markEndpointListening()
  const api = await statusRoute({ mcp: 5747 })
  try {
    const response = await api.get()
    assert.equal(response.status, 200, "the status route did not answer")
    const payload = await response.json()
    assert.equal(payload.port, 5747)
    assert.equal(payload.url, "http://127.0.0.1:5747/mcp")
    // The three facts, reported separately. Their VALUES belong to the
    // process-wide queue and are not this case's business; that each one
    // reaches the panel at all is exactly this case's business.
    for (const field of ["listening", "agents", "waiting", "pending"]) {
      assert.ok(field in payload, `the status payload has no ${field}`)
    }
  } finally {
    await api.close()
  }
})

await check("a port that never bound is reported as no URL, not a bad one", async () => {
  const api = await statusRoute({ mcp: null })
  try {
    const response = await api.get()
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.url, null, "an address was printed for a port nothing is on")
    assert.equal(payload.port, null)
  } finally {
    await api.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
