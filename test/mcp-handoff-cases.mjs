/**
 * The one-click handoff: the button, the queue, and the MCP endpoint an agent
 * sits inside.
 *
 * The claim being pinned is a single sentence — *pressing "Send to agent" ends
 * a `wait_for_change` call that was already outstanding* — and it spans three
 * pieces that are otherwise tested apart. So this suite drives them together:
 *
 *  - the queue's drain-then-block contract, because going straight to the block
 *    loses every click that lands between two calls, which is exactly when a
 *    designer clicks (the agent has just stopped talking);
 *  - the state machine, because a change that stays pending after it is applied
 *    is a change an agent hands itself forever;
 *  - the JSON-RPC surface over real HTTP, because a hand-rolled transport that
 *    answers `tools/list` correctly and `initialize` wrongly connects to nothing
 *    and fails silently in a client's logs rather than here;
 *  - the loopback guard, on the port with no proxy in front of it. This endpoint
 *    can reach the handoff queue, and the queue reaches a coding agent.
 *
 * Usage: node designlayer/test/mcp-handoff-cases.mjs
 */

import assert from "node:assert/strict"

import { createHandoffQueue, handoffQueue } from "../server/handoff.mjs"
import { createMcpEndpoint, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "../server/mcp.mjs"

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

const since = (start) => Date.now() - start

// ---------------------------------------------------------------- the queue

console.log("\nHandoff queue")

await check("a push while nothing waits is drained, not waited out", async () => {
  const queue = createHandoffQueue()
  queue.push({ prompt: "make it red" })
  const start = Date.now()
  // A generous timeout on purpose. Asserting only on `length` passes even with
  // the drain deleted — `finish()` reads `pending()` at resolve time, so the
  // entry comes back anyway once the timeout fires. Elapsed time is the only
  // thing separating "drained" from "blocked for the full window first", and
  // drain-first is the reason this module is not just an array.
  const got = await queue.wait({ timeoutMs: 3000, batchMs: 0 })
  assert.equal(got.length, 1)
  assert.equal(got[0].prompt, "make it red")
  assert.ok(since(start) < 100, `took ${since(start)}ms — it blocked instead of draining`)
})

await check("two waiters are both handed the same change", async () => {
  const queue = createHandoffQueue()
  const first = queue.wait({ timeoutMs: 3000, batchMs: 0 })
  const second = queue.wait({ timeoutMs: 3000, batchMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(queue.waiting, 2)
  queue.push({ prompt: "make it red" })
  const [a, b] = await Promise.all([first, second])
  // Pinning the documented behaviour, not endorsing it: there is no claim on an
  // entry, so two attached agents duplicate the work. The tool description says
  // so out loud. If a lease is ever added this is the test that has to change,
  // which is the point — the behaviour should not drift unnoticed either way.
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
  assert.equal(a[0].id, b[0].id, "no lease means both agents get it — say so, or fix it")
  assert.equal(queue.waiting, 0, "both waiters must be released, not only the first")
})

await check("a brief over the cap is cut in bytes, not code units", () => {
  const queue = createHandoffQueue()
  // Em dashes: 3 bytes each in UTF-8, one code unit each in UTF-16. Measuring
  // in one and slicing in the other let a 120KB brief through untouched, with a
  // note appended claiming it had been truncated.
  const huge = "—".repeat(40_000)
  const entry = queue.push({ brief: huge })
  assert.ok(
    Buffer.byteLength(entry.brief) < Buffer.byteLength(huge),
    "the cap did not cap: the brief came through whole"
  )
  assert.match(entry.brief, /truncated/, "a cut brief has to say it was cut")
})

await check("a resolution outside the enum is narrowed, not stored", () => {
  const queue = createHandoffQueue()
  const entry = queue.push({ prompt: "x" })
  queue.resolve(entry.id, { resolution: "eaten-by-a-goat" })
  assert.equal(queue.get(entry.id).resolution, "applied")
  assert.equal(queue.get(entry.id).status, "resolved")
})

await check("endpointListening starts false and only a real bind sets it", () => {
  const queue = createHandoffQueue()
  assert.equal(queue.endpointListening, false, "nothing may claim delivery before the endpoint binds")
  queue.push({ prompt: "x" })
  assert.equal(queue.endpointListening, false, "a push is not evidence that anyone can receive it")
  queue.markEndpointListening()
  assert.equal(queue.endpointListening, true)
})

await check("a push while an agent waits unblocks it", async () => {
  const queue = createHandoffQueue()
  const start = Date.now()
  const waiting = queue.wait({ timeoutMs: 4000, batchMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(queue.waiting, 1, "the waiter must be visible to the button's own route")
  queue.push({ prompt: "make it blue" })
  const got = await waiting
  assert.equal(got.length, 1)
  assert.ok(since(start) < 1000, `returned in ${since(start)}ms — it should not have run the timeout`)
  assert.equal(queue.waiting, 0, "the waiter must be gone, or it races the next click")
})

await check("a burst of clicks returns as one batch", async () => {
  const queue = createHandoffQueue()
  const waiting = queue.wait({ timeoutMs: 4000, batchMs: 200 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  queue.push({ prompt: "one" })
  await new Promise((resolve) => setTimeout(resolve, 30))
  queue.push({ prompt: "two" })
  await new Promise((resolve) => setTimeout(resolve, 30))
  queue.push({ prompt: "three" })
  const got = await waiting
  assert.equal(got.length, 3, "all three landed inside the window, so all three come back at once")
})

await check("the batch window is bounded by the first arrival, not extended by the last", async () => {
  const queue = createHandoffQueue()
  const start = Date.now()
  const waiting = queue.wait({ timeoutMs: 4000, batchMs: 150 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  queue.push({ prompt: "one" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  queue.push({ prompt: "two" })
  await waiting
  assert.ok(
    since(start) < 500,
    `returned in ${since(start)}ms — a window each push re-opened would never close under a drag`
  )
})

await check("a timeout returns empty rather than throwing", async () => {
  const queue = createHandoffQueue()
  const start = Date.now()
  const got = await queue.wait({ timeoutMs: 120, batchMs: 0 })
  assert.deepEqual(got, [])
  assert.ok(since(start) >= 100, `returned after ${since(start)}ms — it did not actually wait`)
})

await check("an abort releases the waiter", async () => {
  const queue = createHandoffQueue()
  const controller = new AbortController()
  const start = Date.now()
  const waiting = queue.wait({ timeoutMs: 8000, batchMs: 0, signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  assert.deepEqual(await waiting, [])
  assert.ok(since(start) < 1000, "a client that gave up must not leave a waiter parked for 8s")
  assert.equal(queue.waiting, 0)
})

await check("resolving takes a change out of pending", async () => {
  const queue = createHandoffQueue()
  const entry = queue.push({ prompt: "make it red" })
  assert.equal(queue.pending().length, 1)
  queue.resolve(entry.id, { resolution: "applied", summary: "done" })
  assert.equal(queue.pending().length, 0, "or wait_for_change hands the agent its own finished work")
  assert.equal(queue.get(entry.id).status, "resolved")
  assert.equal(queue.list("all").length, 1, "resolved is not deleted — the record is the audit trail")
})

await check("a rejection is recorded as its own status", async () => {
  const queue = createHandoffQueue()
  const entry = queue.push({ prompt: "make it red" })
  queue.resolve(entry.id, { resolution: "rejected", summary: "that token is shared" })
  assert.equal(queue.get(entry.id).status, "rejected")
  assert.equal(queue.pending().length, 0)
})

await check("two clicks in one millisecond are two changes", () => {
  const queue = createHandoffQueue()
  const first = queue.push({ prompt: "a" })
  const second = queue.push({ prompt: "b" })
  assert.notEqual(first.id, second.id, "a timestamp id would collide and resolve both at once")
})

await check("resolving an unknown id reports rather than throws", () => {
  const queue = createHandoffQueue()
  assert.equal(queue.resolve("chg-nope"), null)
  assert.equal(queue.get("chg-nope"), null)
})

await check("handoffQueue() is one queue, not one per caller", () => {
  assert.equal(handoffQueue(), handoffQueue(), "two queues means the button fills one and the agent reads the other")
})

// ------------------------------------------------------------ the endpoint

// --------------------------------------------------- the route, end to end

/*
 * The hop in the middle.
 *
 * The button→HTTP body is pinned below, and the queue→MCP payload is pinned
 * above. Between them sits `writeHandoff`, which is where the request becomes a
 * queue entry — and it was the one seam with no test. Deleting `brief:` from
 * its `queue.push(...)` left the whole suite green while the agent silently
 * started receiving a subject line with no changes under it.
 */

console.log("\nThe /agent route fills the queue")

await check("a handoff request lands in the queue with its brief intact", async () => {
  const os = await import("node:os")
  const fsp = await import("node:fs/promises")
  const nodePath = await import("node:path")
  const { createAgent } = await import("../server/agent.mjs")
  const { handoffQueue } = await import("../server/handoff.mjs")

  const root = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "de-handoff-"))
  const shared = handoffQueue()
  shared.clear()

  const agent = createAgent({
    projectRoot: root,
    stateDir: nodePath.join(root, ".local", "designlayer"),
    host: { framework: "angular" },
  })

  const reply = await agent.runAgent({
    prompt: "2 design changes from DesignLayer",
    origin: "prompts",
    brief: "### src/app/overview.component.html\n- `<button>` — set `box-shadow` to `0 1px 2px`",
    files: ["src/app/overview.component.html"],
    url: "http://127.0.0.1:3456/overview",
    selection: null,
    ancestry: [],
  })

  assert.equal(reply.ok, true)
  assert.ok(reply.handoffPath, "the durable record has to be written whatever the queue does")
  assert.ok(reply.changeId, "the reply has to name the entry an agent will see")

  const queued = shared.get(reply.changeId)
  assert.ok(queued, "the route wrote a file and told nobody — the trigger half is missing")
  assert.equal(queued.origin, "prompts")
  assert.match(queued.brief, /box-shadow/, "the brief did not survive the route")
  assert.deepEqual(queued.files, ["src/app/overview.component.html"])
  assert.equal(queued.framework, "angular", "the agent is told which host it is editing")
  assert.equal(queued.handoffPath, reply.handoffPath, "the entry points at its own durable record")

  await fsp.rm(root, { recursive: true, force: true })
  shared.clear()
})

await check("a path the browser names is a label, never something the server opens", async () => {
  /*
   * The route used to read the file named in `selection.source` and upload it,
   * which is why an extension allowlist had to stand in front of it: the same
   * project root that holds your components holds `.env.local`. That transport
   * is gone, so the guarantee is now absolute rather than conditional, and this
   * is where it is pinned — a real secret in a real project root, and a check
   * that not one byte of it reaches the record or the queue.
   *
   * It lives here rather than in `ui-change-cases.mjs`, where the old
   * extension-gate case was: that level talks to whichever editor is already
   * running, so it cannot plant a file in the server's own root. This one owns
   * its root.
   */
  const os = await import("node:os")
  const fsp = await import("node:fs/promises")
  const nodePath = await import("node:path")
  const { createAgent } = await import("../server/agent.mjs")
  const { handoffQueue } = await import("../server/handoff.mjs")

  const root = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "de-secret-"))
  const shared = handoffQueue()
  shared.clear()

  const SECRET = "sk-live-do-not-exfiltrate-0987654321"
  await fsp.writeFile(nodePath.join(root, ".env.local"), `API_KEY=${SECRET}\n`, "utf8")

  const agent = createAgent({
    projectRoot: root,
    stateDir: nodePath.join(root, ".local", "designlayer"),
    host: { framework: "react" },
  })

  const reply = await agent.runAgent({
    prompt: "read this",
    origin: "prompts",
    brief: "### .env.local\n- make it nicer",
    selection: { tagName: "div", source: { filePath: ".env.local", lineNumber: 1 } },
    ancestry: [],
  })

  assert.equal(reply.ok, true, "the route should hand over, not refuse — it read nothing to refuse")
  assert.equal(reply.filesChanged, undefined, "the route edited a file")

  const record = await fsp.readFile(nodePath.join(root, reply.handoffPath), "utf8")
  assert.match(record, /\.env\.local:1/, "the record dropped the path the caller named")
  assert.ok(!record.includes(SECRET), "the secret reached the durable record")
  assert.ok(
    !JSON.stringify(shared.get(reply.changeId)).includes(SECRET),
    "the secret reached the queue an agent reads"
  )

  await fsp.rm(root, { recursive: true, force: true })
  shared.clear()
})

await check("with no endpoint listening, the reply does not promise a delivery", async () => {
  const os = await import("node:os")
  const fsp = await import("node:fs/promises")
  const nodePath = await import("node:path")
  const { createAgent } = await import("../server/agent.mjs")
  const { handoffQueue } = await import("../server/handoff.mjs")

  const root = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "de-handoff-"))
  handoffQueue().clear()
  const agent = createAgent({
    projectRoot: root,
    stateDir: nodePath.join(root, ".local", "designlayer"),
    host: { framework: "react" },
    agent: { transport: "handoff" },
  })

  const reply = await agent.runAgent({ prompt: "make it red", selection: null, ancestry: [] })
  // The worst outcome in the feature is a designer waiting on an agent that
  // cannot hear them. `ports.mcp: null`, or a second editor holding the port,
  // both land here — and the only warning went to a terminal nobody is reading.
  assert.match(reply.message, /no agent is attached/i, `said: ${reply.message}`)
  assert.doesNotMatch(reply.message, /Delivered/)

  await fsp.rm(root, { recursive: true, force: true })
  handoffQueue().clear()
})

console.log("\nMCP endpoint")

const queue = createHandoffQueue()
const endpoint = createMcpEndpoint({ queue, isLocalRequest: () => true, version: "test" })
const server = await endpoint.listen(0)
const port = server.address().port
const url = `http://127.0.0.1:${port}/mcp`

async function rpc(body, { headers = {} } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    body: text ? JSON.parse(text) : null,
  }
}

const callTool = async (name, args = {}) => {
  const response = await rpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e6),
    method: "tools/call",
    params: { name, arguments: args },
  })
  return { ...response, payload: JSON.parse(response.body.result.content[0].text) }
}

/*
 * One queue serves the whole endpoint section, because a second endpoint per
 * case would be a second port per case. That makes leftovers the hazard: a
 * change one test pushes and does not resolve drains instantly into the next
 * test's `wait_for_change`, and the timeout cases pass or fail on the order
 * they were written in. Draining between cases is what keeps each one honest.
 */
const drain = () => {
  for (const entry of queue.pending()) queue.resolve(entry.id, { resolution: "applied" })
}

await check("initialize answers with a protocol version and a session", async () => {
  const response = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.result.protocolVersion, "2025-06-18", "the client's version, when we speak it")
  assert.equal(response.body.result.serverInfo.name, "designlayer")
  assert.ok(response.body.result.capabilities.tools, "a server with no tools capability is never asked for tools")
  assert.ok(response.sessionId, "the spec wants a session id on the initialize response")
})

await check("an unknown protocol version negotiates down rather than failing", async () => {
  const response = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  })
  assert.equal(response.body.result.protocolVersion, "2025-11-25")
})

await check("a notification gets 202 and no body", async () => {
  const response = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })
  assert.equal(response.status, 202, "answering a notification with a result is a protocol violation")
  assert.equal(response.body, null)
})

await check("tools/list names all four tools", async () => {
  const response = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })
  const names = response.body.result.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ["get_change", "list_changes", "resolve_change", "wait_for_change"])
  const wait = response.body.result.tools.find((tool) => tool.name === "wait_for_change")
  assert.match(
    wait.description,
    /loop/i,
    "the description is what makes a model call it again — Agentation's whole hands-free mode rests on that sentence"
  )
})

await check("wait_for_change blocks, then returns what the button pushed", async () => {
  drain()
  const start = Date.now()
  const pending = callTool("wait_for_change", { timeoutSeconds: 10, batchWindowSeconds: 0.1 })
  await new Promise((resolve) => setTimeout(resolve, 120))
  queue.push({
    origin: "prompts",
    prompt: "2 design changes from DesignLayer",
    brief: "### src/app/overview.html\n- `<button>` — box-shadow: none → 0 1px 2px",
    url: "http://127.0.0.1:3456/overview",
    files: ["src/app/overview.html"],
  })
  const { payload } = await pending
  assert.equal(payload.timeout, false)
  assert.equal(payload.count, 1)
  assert.match(payload.changes[0].brief, /overview\.html/, "the brief must survive the trip verbatim")
  assert.deepEqual(payload.changes[0].files, ["src/app/overview.html"])
  assert.ok(since(start) < 3000, `returned in ${since(start)}ms`)
})

await check("a timeout is reported as data, not as an error", async () => {
  drain()
  const { payload, body } = await callTool("wait_for_change", { timeoutSeconds: 1 })
  assert.equal(payload.timeout, true)
  assert.ok(!body.result.isError, "a model that reads a timeout as a failure stops looping")
  assert.match(payload.message, /again/i, "it has to say what to do next, or the loop ends here")
})

/*
 * Asserted on the constant rather than by waiting it out: the only honest
 * behavioural test of a 55-second ceiling takes 55 seconds, and a suite nobody
 * runs pins nothing. The number itself is the claim — past 60s a default client
 * aborts, the response is thrown away, and the waiter on this side is stranded
 * holding the designer's next click.
 */
await check("the wait ceiling stays below the client's own 60s abort", () => {
  assert.ok(MAX_WAIT_SECONDS < 60, `MAX_WAIT_SECONDS is ${MAX_WAIT_SECONDS}`)
  assert.ok(DEFAULT_WAIT_SECONDS <= MAX_WAIT_SECONDS)
})

await check("a too-long timeoutSeconds is clamped, and the tool says so", async () => {
  const response = await rpc({ jsonrpc: "2.0", id: 12, method: "tools/list" })
  const wait = response.body.result.tools.find((tool) => tool.name === "wait_for_change")
  assert.match(
    wait.inputSchema.properties.timeoutSeconds.description,
    new RegExp(`max ${MAX_WAIT_SECONDS}`),
    "a model that cannot see the ceiling will ask for 300 and get an aborted call"
  )
})

await check("a too-short timeoutSeconds is clamped up rather than returning instantly", async () => {
  drain()
  const start = Date.now()
  await callTool("wait_for_change", { timeoutSeconds: 0.001 })
  assert.ok(
    since(start) >= 900,
    `returned in ${since(start)}ms — an unclamped 1ms wait turns the loop into a busy poll`
  )
})

await check("resolve_change stops the next wait re-serving it", async () => {
  drain()
  const entry = queue.push({ prompt: "make it red" })
  const resolved = await callTool("resolve_change", { id: entry.id, summary: "made it red" })
  assert.equal(resolved.payload.ok, true)
  assert.equal(resolved.payload.status, "resolved")
  const after = await callTool("wait_for_change", { timeoutSeconds: 1 })
  assert.equal(after.payload.timeout, true, "a resolved change must not come back round")
})

await check("list_changes reads without blocking", async () => {
  const entry = queue.push({ prompt: "list me" })
  const start = Date.now()
  const { payload } = await callTool("list_changes")
  assert.ok(since(start) < 1000, "this one must never block")
  assert.ok(payload.changes.some((change) => change.id === entry.id))
  const all = await callTool("list_changes", { status: "all" })
  assert.ok(all.payload.count >= payload.count)
  queue.resolve(entry.id)
})

await check("get_change on an unknown id is a tool error, not a protocol error", async () => {
  const response = await callTool("get_change", { id: "chg-nope" })
  assert.equal(response.body.result.isError, true)
  assert.equal(response.body.error, undefined, "a JSON-RPC error is invisible to the model")
})

await check("an unknown method is -32601", async () => {
  const response = await rpc({ jsonrpc: "2.0", id: 9, method: "frobnicate" })
  assert.equal(response.body.error.code, -32601)
})

await check("resources/list and prompts/list answer empty instead of erroring", async () => {
  const resources = await rpc({ jsonrpc: "2.0", id: 10, method: "resources/list" })
  const prompts = await rpc({ jsonrpc: "2.0", id: 11, method: "prompts/list" })
  assert.deepEqual(resources.body.result.resources, [])
  assert.deepEqual(prompts.body.result.prompts, [])
})

await check("malformed JSON is a parse error, not a crash", async () => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, -32700)
})

await check("GET says there is nothing to stream", async () => {
  const response = await fetch(url, { method: "GET" })
  assert.equal(response.status, 405, "this server sends nothing unprompted, and must say so")
  assert.match(response.headers.get("allow") ?? "", /POST/)
})

await check("a batch of messages comes back as a batch", async () => {
  const response = await rpc([
    { jsonrpc: "2.0", id: 20, method: "ping" },
    { jsonrpc: "2.0", id: 21, method: "tools/list" },
  ])
  assert.ok(Array.isArray(response.body))
  assert.equal(response.body.length, 2)
})

/*
 * The three guards below are not protocol politeness — they are what stops a
 * script on the app being edited from driving these tools.
 *
 * `isLocalRequest` accepts any LOOPBACK Origin, which includes the dev server
 * the designer is editing. So a compromised dependency on that page is
 * "same-origin" enough to pass it. The remaining defence is the CORS preflight,
 * and a POST only requires one if it is not a simple request — which means the
 * Content-Type check IS the defence. Measured before it existed: a
 * `text/plain` POST from `http://localhost:3000` resolved a pending change.
 */

await check("a non-JSON content type is refused, so a simple POST cannot reach a tool", async () => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 40, method: "tools/list" }),
  })
  assert.equal(response.status, 415, "text/plain is a CORS-simple POST — no preflight, no protection")
  const body = await response.json()
  assert.match(body.error.message, /application\/json/i)
})

await check("no OPTIONS handler and no CORS headers, so the preflight cannot succeed", async () => {
  const response = await fetch(url, { method: "OPTIONS" })
  assert.equal(response.status, 405)
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    null,
    "one permissive ACAO header would undo the whole guard above"
  )
})

await check("an unsupported MCP-Protocol-Version is a 400", async () => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "1999-01-01" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/list" }),
  })
  assert.equal(response.status, 400, "the spec says MUST")
  const absent = await rpc({ jsonrpc: "2.0", id: 42, method: "tools/list" })
  assert.equal(absent.status, 200, "an absent header means the default version, which is supported")
})

await check("a session id this server never issued is a 404", async () => {
  const response = await rpc(
    { jsonrpc: "2.0", id: 43, method: "tools/list" },
    { headers: { "mcp-session-id": "00000000-0000-4000-8000-000000000000" } }
  )
  // 404 is the signal that tells a client to re-initialize. Answering 200 left
  // a client reconnecting after an editor restart talking to a session that
  // does not exist, and never finding out.
  assert.equal(response.status, 404)
})

await check("a terminated session stops working", async () => {
  const init = await rpc({
    jsonrpc: "2.0",
    id: 44,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  })
  const sid = init.sessionId
  assert.ok(sid)
  const alive = await rpc({ jsonrpc: "2.0", id: 45, method: "ping" }, { headers: { "mcp-session-id": sid } })
  assert.equal(alive.status, 200)

  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sid } })
  const dead = await rpc({ jsonrpc: "2.0", id: 46, method: "ping" }, { headers: { "mcp-session-id": sid } })
  assert.equal(dead.status, 404, "issuing a session id and then never enforcing it is worse than issuing none")
})

server.close()

// ------------------------------------------------------- the loopback guard

console.log("\nLoopback guard")

const guarded = createMcpEndpoint({ queue, isLocalRequest: () => false })
const guardedServer = await guarded.listen(0)
const guardedUrl = `http://127.0.0.1:${guardedServer.address().port}/mcp`

await check("a request the guard refuses gets 403 before any tool runs", async () => {
  const response = await fetch(guardedUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  assert.equal(response.status, 403)
  const body = await response.json()
  assert.match(body.error.message, /loopback/i)
})

await check("the real guard rejects a non-loopback Origin", async () => {
  const { isLocalRequest } = await import("../server/routes.mjs")
  const request = (headers) => ({ socket: { remoteAddress: "127.0.0.1" }, headers })
  assert.equal(isLocalRequest(request({ host: "127.0.0.1:5747" })), true, "no Origin is a non-browser client")
  assert.equal(isLocalRequest(request({ host: "127.0.0.1:5747", origin: "http://localhost:3000" })), true)
  assert.equal(isLocalRequest(request({ host: "127.0.0.1:5747", origin: "https://evil.example" })), false)
  assert.equal(
    isLocalRequest(request({ host: "127.0.0.1:5747", origin: "null" })),
    false,
    '"null" is the Origin a sandboxed iframe sends — the one context an attacker controls'
  )
})

guardedServer.close()

// ------------------------------------------------------------- the button

/*
 * The browser half, in jsdom.
 *
 * The live loop was proved by hand once; this is what keeps it proved. What
 * rots silently is not the transport — a broken transport fails loudly — but
 * the PAYLOAD: a rename or a well-meant tidy that stops sending `brief`, after
 * which the agent receives a subject line with no changes under it. The route
 * would still answer 200 and the toast would still say it was sent.
 *
 * So these cases assert what crosses the wire, not that a fetch happened.
 */

console.log("\nApply all (browser)")

const { JSDOM } = await import("jsdom")
const { PACKAGE_DIR } = await import("./host.mjs")

const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
  pretendToBeVisual: true,
  url: "http://127.0.0.1:3456/overview",
})
const { window } = dom
window.document.elementsFromPoint = () => []
window.Element.prototype.getBoundingClientRect = function box() {
  return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }
}
globalThis.DOMMatrixReadOnly = class {
  constructor() {
    this.m41 = 0
    this.m42 = 0
  }
}
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "SVGSVGElement",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { createContext } from "./src/core/context"
      export { annotationsTab } from "./src/panels/inspector/tab-annotations"
      export { recordRefusedWrite } from "./src/shell/toolbar"
      export {
        buildChangePrompt,
        recordPreviewOnly,
        clearPreviewOnly,
        previewOnlyChanges,
      } from "./src/core/change-prompt"
      export { addAnnotation, resetAnnotationsForTest } from "./src/annotations/store"
      export { recordEdit, resetJournalForTest } from "./src/annotations/journal"
      export { buildAnnotationBrief } from "./src/annotations/output"
    `,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
})
const ui = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

const slot = () => {
  const node = window.document.createElement("div")
  node.setAttribute("data-designlayer", "")
  window.document.body.append(node)
  return node
}
const toasts = []
const uiBridge = {
  elementInfo: () => null,
  send() {},
  toast: (message) => toasts.push(message),
  subscribe: () => () => {},
  store: {
    setActiveTool() {},
    hasChanges: () => false,
    buildBatchOperations: () => [],
    onStateChange() {},
    getCanvasTransform: () => ({ x: 0, y: 0, scale: 1 }),
    viewportToPage: (x, y) => ({ x, y }),
    pageToViewport: (x, y) => ({ x, y }),
  },
}
const right = slot()
const uiContext = ui.createContext(uiBridge, {
  overlay: slot(),
  toolbar: slot(),
  left: slot(),
  right,
})
/*
 * An agent is attached before the tab is built: it asks `/mcp/status` once on
 * construction, and only offers "Send to agent" after a handshake. The stub
 * below keeps answering the same route.
 */
const MCP_STATUS = { url: "http://127.0.0.1:5747/mcp", listening: true, agents: 1, waiting: 1 }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => MCP_STATUS })
const tab = ui.annotationsTab(uiContext)
right.append(tab.node)

/**
 * A clean outbox, and one that cannot be refilled from disk.
 *
 * The notes persist to `localStorage` and the journal is module state, so a
 * case that seeded either one is still seeding the next case otherwise —
 * `resetAnnotationsForTest` empties memory and deliberately leaves storage
 * alone, and the next read reloads what was written.
 */
function emptyOutbox() {
  ui.clearPreviewOnly()
  ui.resetJournalForTest()
  ui.resetAnnotationsForTest()
  window.localStorage.clear()
  tab.update()
}

/** One note, pinned to an element the resolver could place. */
function note(comment, target) {
  return ui.addAnnotation({
    kind: "element",
    comment,
    url: window.location.href,
    rect: { x: 0, y: 0, width: 120, height: 32 },
    selectedText: null,
    target: {
      tagName: "button",
      componentName: "AuthCard",
      className: "btn btn--outlined",
      id: null,
      selector: "button.btn",
      text: "Sign in",
      filePath: null,
      lineNumber: null,
      ancestry: [],
      computed: {},
      components: [],
      ...target,
    },
  })
}

/** Every `/agent` POST the panel made, decoded. */
const posted = []
let reply = {
  ok: true,
  message: "Delivered to your coding agent — it was waiting and has just picked this up.",
}
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/mcp/status")) {
    return { ok: true, status: 200, json: async () => MCP_STATUS }
  }
  posted.push({ url: String(url), body: JSON.parse(init.body) })
  return { ok: true, status: 200, json: async () => reply }
}

/*
 * The agent group's own button.
 *
 * The tab briefly had one "Apply all" that did both halves; it now has a verb
 * per group, each sitting under the rows it acts on. This suite is about the
 * handover, so it wants the one in the agent group.
 */
const sendButton = () =>
  Array.from(tab.node.querySelectorAll("button")).find(
    (node) => node.textContent.trim() === "Send to agent"
  ) ?? null
const copyButton = () =>
  Array.from(tab.node.querySelectorAll("button")).find((node) => node.textContent.trim() === "Copy") ??
  null
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The last thing Copy put on the clipboard, or null since it was reset. */
let copied = null
Object.defineProperty(window.navigator, "clipboard", {
  value: { writeText: (text) => ((copied = text), Promise.resolve()) },
  configurable: true,
})

// Let the construction-time `/mcp/status` answer land.
await settle()

await check("the agent group has a button that hands it over, and Copy survives", () => {
  note("The shadow on this is too heavy")
  tab.update()
  assert.ok(sendButton(), "the one-click handoff has no button")
  assert.ok(
    copyButton(),
    "Copy must survive — the editor cannot see whether an agent is attached, so the paste path stays"
  )
})

await check("it is not offered at all with an empty outbox", () => {
  emptyOutbox()
  /*
   * ABSENT, where this case used to insist on present-and-refusing.
   *
   * The old argument was that a control a designer knows about should stay
   * where they left it and plainly refuse, rather than disappear and leave
   * them wondering whether the handover had moved. That holds for a control
   * that comes and goes mid-session; it does not hold for the state BEFORE a
   * session exists, which is the only state this row is now missing from. A
   * first-time reader met four disabled controls above a sentence explaining
   * that there is nothing to hand over yet — the sentence is the answer, and
   * the buttons were three more things to read past to reach it.
   *
   * The guarantee this case exists for is unchanged and is asserted below on
   * the path that would have to break it: `sendNow()` re-checks the outbox
   * before posting, so an empty session cannot be sent even if something put
   * the button back.
   */
  assert.equal(sendButton(), null, "the handover row sat over an empty session")

  // And it comes back with the first thing worth handing over.
  note("Something to send", window.document.body)
  tab.update()
  assert.ok(sendButton(), "a note did not bring the handover row back")
  assert.equal(sendButton().disabled, false)
})

await check("it sends the brief, the files and the origin", async () => {
  emptyOutbox()
  // Both halves of a handover, because the payload is supposed to carry both:
  // the note says what is wrong, the edit says what has already been done.
  note("The shadow on this is too heavy", {
    // A `.tsx` path, not the `.html` the live Angular run used: this harness
    // builds the panel against the default (react) host, where `.html` is not a
    // source extension and `isProjectSourcePath` rightly disowns it.
    filePath: "/Users/someone/app/src/components/auth-card.tsx",
    lineNumber: 31,
  })
  const subject = window.document.createElement("button")
  subject.className = "btn btn--outlined"
  window.document.body.append(subject)
  ui.recordEdit({
    property: "box-shadow",
    from: "none",
    to: "0 1px 2px rgba(0,0,0,.2)",
    element: subject,
    written: false,
  })
  posted.length = 0
  assert.equal(sendButton().disabled, false, "a filled outbox must arm the button")

  sendButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  await settle()

  assert.equal(posted.length, 1, "one click, one post")
  const { url, body } = posted[0]
  assert.match(url, /\/agent$/, "it reuses the existing agent route rather than adding a second one")
  assert.equal(body.origin, "prompts", "the agent has to know this is a finished outbox, not a question")
  assert.match(body.brief, /box-shadow/, "the brief IS the payload — without it the agent gets a subject line")
  assert.match(body.brief, /too heavy/, "a brief with the edits and none of the notes omits every reason")
  assert.match(body.brief, /auth-card\.tsx/)
  assert.deepEqual(body.files, ["/Users/someone/app/src/components/auth-card.tsx"])
  assert.equal(body.url, "http://127.0.0.1:3456/overview")
  assert.match(body.prompt, /1 note and 1 edit/)
})

await check("what it sends is byte-for-byte what Copy writes", () => {
  copied = null
  copyButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  assert.ok(copied, "Copy wrote nothing in the click task, where the clipboard activation still exists")
  assert.equal(
    posted[0].body.brief,
    copied,
    "the two are only trustworthy if they are the same bytes — a designer pastes one and the agent gets the other"
  )
  // Same claim from the other side: the outbox has one brief, not a sent one
  // and a copied one that drifted.
  assert.equal(posted[0].body.brief, ui.buildAnnotationBrief())
})

await check("Send to agent also puts the brief on the clipboard, in the click task", async () => {
  emptyOutbox()
  note("Copy this too", { filePath: "/app/src/y.tsx", componentName: "Y", lineNumber: 9 })
  const expected = ui.buildAnnotationBrief()
  posted.length = 0
  toasts.length = 0
  copied = null
  reply = { ok: true, message: "Queued for your coding agent." }
  sendButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  // Before any settle: a copy after an await has lost the click's activation.
  assert.equal(copied, expected, "the send did not copy synchronously inside the click")
  await settle()
  assert.equal(posted[0].body.brief, copied, "the clipboard and the agent got different briefs")
  assert.match(toasts.at(-1) ?? "", /Queued.*copied to the clipboard/s, "the toast hid the copy")
})

await check("a refused clipboard does not claim a copy, and the send still goes", async () => {
  emptyOutbox()
  note("Clipboard says no", { filePath: "/app/src/z.tsx", componentName: "Z", lineNumber: 2 })
  const real = window.navigator.clipboard
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: () => Promise.reject(new Error("Document is not focused")) },
    configurable: true,
  })
  const exec = window.document.execCommand
  window.document.execCommand = () => false
  try {
    posted.length = 0
    toasts.length = 0
    reply = { ok: true, message: "Queued for your coding agent." }
    sendButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    await settle()
    await settle()
    assert.equal(posted.length, 1, "a refused copy blocked the send")
    assert.doesNotMatch(toasts.at(-1) ?? "", /clipboard/, "it claimed a copy that never landed")
  } finally {
    window.document.execCommand = exec
    Object.defineProperty(window.navigator, "clipboard", { value: real, configurable: true })
  }
})

await check("an unresolved file is not offered to the agent as a path", async () => {
  emptyOutbox()
  note("This one is a mystery", { componentName: "Mystery", tagName: "div", filePath: null })
  posted.length = 0
  sendButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  await settle()
  assert.deepEqual(posted[0].body.files, [], "a guessed path sends the agent to edit the wrong file")
  assert.match(posted[0].body.brief, /Mystery/, "the component name is still how the agent finds it")
})

await check("the route's own message is what the designer is told", async () => {
  emptyOutbox()
  note("Tighten this up", { filePath: "/app/src/x.tsx", componentName: "X", lineNumber: 4 })
  toasts.length = 0
  reply = {
    ok: true,
    message: "Queued for your coding agent. It arrives the next time the agent calls wait_for_change.",
  }
  sendButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  await settle()
  assert.match(
    toasts.at(-1) ?? "",
    /Queued/,
    "the panel must not invent a delivery the server did not claim — nothing may be listening"
  )
})

await check("a failing route is reported, and the button comes back", async () => {
  toasts.length = 0
  reply = { ok: false, message: "Could not reach the agent route." }
  sendButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  await settle()
  assert.match(toasts.at(-1) ?? "", /Could not reach/)
  assert.equal(sendButton().disabled, false, "one failure must not end the session")
})

// ----------------------------------------------- what the button can carry

/*
 * A refused Angular write has to be recorded, or it exists only in the pixels.
 *
 * On an Angular host the most interesting failures do not arrive by the React
 * route — they arrive as a `failed[]` entry in the reply to Apply. Those used
 * to be a toast and nothing else: queue cleared, preview still on screen, no
 * record anywhere.
 *
 * Seen on a real page: two `<div class="auth-row__icon">` in one template score
 * identically, the server correctly refused with "no unique <div>", and the
 * edit vanished.
 *
 * What they are recorded INTO is the change-prompt ledger, and the ledger is no
 * longer what "Send to agent" carries: the outbox above reads the annotation
 * store and the edit journal, and `recordRefusedWrite` writes to neither. So
 * these cases read the ledger and its brief directly rather than through a
 * panel. The gap between the two is real and is not this suite's to close —
 * pinning the recorder is what keeps closing it a small change.
 */

console.log("\nA refused Angular write reaches the ledger")

await check("a refused setStyles becomes one ledger entry per declaration", () => {
  ui.clearPreviewOnly()
  ui.recordRefusedWrite({
    op: "setStyles",
    componentName: "_OverviewComponent",
    target: {
      tagName: "div",
      classes: ["auth-row__icon"],
      id: null,
      nthOfType: 0,
      parentTagName: "article",
      parentClasses: ["auth-row"],
      attributes: {},
    },
    declarations: { opacity: "0.4", "border-radius": "8px" },
  })
  const changes = ui.previewOnlyChanges()
  assert.equal(changes.length, 2, "two declarations refused together are two things to fix")
  const opacity = changes.find((change) => change.property === "opacity")
  assert.ok(opacity)
  assert.equal(opacity.to, "0.4")
  assert.equal(opacity.tagName, "div")
  assert.equal(opacity.className, "auth-row__icon")
  // Angular's compiled class names carry a leading underscore. Printing
  // `_OverviewComponent` in a brief sends the agent grepping for a symbol that
  // appears nowhere in the source it is about to open.
  assert.equal(opacity.componentName, "OverviewComponent")
  assert.equal(opacity.filePath, null, "the reply names the file only in prose — do not parse it back out")
  assert.equal(opacity.from, "", "the pre-edit value is genuinely gone by commit time; do not invent one")
})

await check("the brief it produces is one an agent can act on", () => {
  // Read from `buildChangePrompt` rather than off a panel. The Prompts tab had
  // a region that showed these bytes and the outbox that replaced it shows its
  // own; the document is the claim, and the region was one reader of it.
  const brief = ui.buildChangePrompt()
  assert.match(brief, /Search for `OverviewComponent`/)
  assert.match(brief, /<div class="auth-row__icon">/)
  assert.match(brief, /set `opacity` to `0\.4`/)
  assert.doesNotMatch(
    brief,
    /currently/,
    "an empty `from` must omit the parenthetical, not print an empty one"
  )
})

await check("a refused setClasses becomes the class sentinel", () => {
  ui.clearPreviewOnly()
  ui.recordRefusedWrite({
    op: "setClasses",
    componentName: "OverviewComponent",
    target: {
      tagName: "button",
      classes: ["btn", "btn--filled"],
      id: null,
      nthOfType: 0,
      parentTagName: "div",
      parentClasses: [],
      attributes: {},
    },
    add: ["btn--filled"],
    remove: ["btn--outlined"],
  })
  const [change] = ui.previewOnlyChanges()
  assert.equal(change.property, "class")
  // The live class list, read after the preview applied, IS the attribute the
  // source should end up with — which is what the sentinel means.
  assert.equal(change.to, "btn btn--filled")
})

/*
 * The call site, not just the recorder.
 *
 * The four cases above would all still pass with the one line that calls
 * `recordRefusedWrite` deleted from `applyAngular` — which is exactly the line
 * that was missing in the first place. So this one drives the real toolbar:
 * queue an edit, let the server refuse it, and look in the ledger.
 *
 * It needs its own bundle. `src/core/config.ts` reads the host config at MODULE
 * LOAD and freezes it, so an Angular host cannot be switched on afterwards —
 * the same constraint `host-parity-cases.mjs` documents and solves the same way.
 */
await check("Apply to code files what the server refused", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const nodePath = await import("node:path")
  const { pathToFileURL } = await import("node:url")

  const injected = {
    apiBase: "/__designlayer",
    host: { framework: "angular", tailwind: false },
    tailwind: { version: 3, breakpoints: { sm: 640, md: 768, lg: 1024 } },
  }
  window.__DESIGNLAYER_CONFIG__ = injected
  globalThis.__DESIGNLAYER_CONFIG__ = injected

  // The Angular queue refuses an element it cannot name an owner for, so
  // without this the queue stays empty and Apply never runs. Three lines of
  // `window.ng` is the whole dependency.
  window.ng = { getOwningComponent: () => ({ constructor: { name: "_OverviewComponent" } }) }
  globalThis.ng = window.ng

  const angularBundle = await build({
    stdin: {
      contents: `
        export { createContext } from "./src/core/context"
        export { installToolbar } from "./src/shell/toolbar"
        export { createApply } from "./src/core/apply"
        export { queueAngularStyles } from "./src/core/angular"
        export { previewOnlyChanges, clearPreviewOnly } from "./src/core/change-prompt"
      `,
      resolveDir: PACKAGE_DIR,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  // A file, not a data: URL — Node keys its module cache on the URL, so this
  // bundle has to be distinguishable from the react-host one loaded above.
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "de-handoff-ng-"))
  const file = nodePath.join(dir, "angular-editor.mjs")
  fs.writeFileSync(file, angularBundle.outputFiles[0].text)
  const ng = await import(pathToFileURL(file).href)

  const toolbarSlot = slot()
  const ngContext = ng.createContext(uiBridge, {
    overlay: slot(),
    toolbar: toolbarSlot,
    left: slot(),
    right: slot(),
  })
  ng.installToolbar(ngContext)

  const subject = window.document.createElement("div")
  subject.className = "auth-row__icon"
  window.document.body.append(subject)
  assert.equal(ng.queueAngularStyles(subject, [{ property: "opacity", value: "0.4" }]), true)

  // The refusal a real server sent, verbatim, for two `<div
  // class="auth-row__icon">` that score identically in one template.
  const refusal = {
    applied: [],
    failed: [
      {
        reason: "no unique <div> in overview.component.html",
        operation: {
          op: "setStyles",
          componentName: "_OverviewComponent",
          target: {
            tagName: "div",
            classes: ["auth-row__icon"],
            id: null,
            nthOfType: 0,
            parentTagName: "body",
            parentClasses: [],
            attributes: {},
          },
          declarations: { opacity: "0.4" },
        },
      },
    ],
  }
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => refusal })

  ng.clearPreviewOnly()
  /*
   * Driven through the committer, not through a button.
   *
   * The bar used to carry the commit and this case used to click it. It does
   * not any more — finishing work belongs to the Changes tab, and the bar holds
   * only an indicator that navigates. What is under test here was never the
   * button though: it is that a write the SERVER refuses comes back as a row
   * the designer still owns, instead of disappearing into a toast. That claim
   * lives in `core/apply.ts`, which is what both surfaces call, so this drives
   * it directly and stops depending on which control happens to be wired to it.
   */
  const committer = ng.createApply({
    bridge: uiBridge,
    toast: (message) => toasts.push(message),
  })
  assert.equal(committer.hasPendingChanges(), true, "a queued Angular edit must be owed")

  await committer.applyAll()
  await new Promise((resolve) => setTimeout(resolve, 50))
  globalThis.fetch = previousFetch

  const filed = ng.previewOnlyChanges()
  assert.equal(
    filed.length,
    1,
    "the server refused the write and the commit dropped it — the change now exists only in the pixels"
  )
  assert.equal(filed[0].property, "opacity")
  assert.equal(filed[0].to, "0.4")
  assert.match(JSON.stringify(toasts.at(-1) ?? ""), /Changes/, "the toast has to say where the change went")

  fs.rmSync(dir, { recursive: true, force: true })
})

await check("a refused setText is not silently dropped", () => {
  ui.clearPreviewOnly()
  ui.recordRefusedWrite({
    op: "setText",
    componentName: "OverviewComponent",
    target: {
      tagName: "a",
      classes: [],
      id: null,
      nthOfType: 0,
      parentTagName: "div",
      parentClasses: ["auth-row__desc"],
      attributes: { href: "#" },
    },
    text: "Read the docs",
  })
  const [change] = ui.previewOnlyChanges()
  assert.ok(change, "text is the refusal most likely to be right and most likely to be lost")
  assert.equal(change.to, "Read the docs")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
