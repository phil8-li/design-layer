/**
 * A Model Context Protocol server, so the designer's "Send to agent" button
 * lands inside a coding agent's turn instead of on the clipboard.
 *
 * ## Why the editor is the server
 *
 * It reads backwards — the editor is the thing with a UI, the agent is the
 * thing doing the work — but MCP's roles are about who offers context, not who
 * has a window. The agent is the client; whatever it reads from is a server.
 * Every other tool that has tried this (stagewise, after two rewrites, and
 * Agentation) arrived at the same inversion.
 *
 * ## Why a tool blocks
 *
 * A server has no way to start an agent's turn. It may answer requests, and it
 * may send notifications about its own lists going stale, and that is the
 * whole surface. So the handoff is a pull the agent parked earlier:
 * `wait_for_change` does not return until the designer presses the button.
 *
 * ## Why this is hand-rolled
 *
 * Streamable HTTP with no server-initiated traffic is JSON-RPC 2.0 over a
 * single POST, and the spec explicitly permits answering `application/json`
 * instead of opening an SSE stream. That is ~200 lines against a dependency
 * tree with its own protocol version to track, in a package that ships four
 * runtime dependencies on purpose and pins the one that matters exactly.
 *
 * The cost is real and worth naming: with no SSE stream there is nowhere to put
 * progress notifications, so a block cannot outlive the client's request
 * timeout. Clients default to 60s. `wait_for_change` therefore caps at 55s and
 * says, in the one place a model will read it, to call again — a loop of short
 * waits is indistinguishable from one long one, and cannot strand a watcher.
 */

import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"

// Required, not imported: an ES import of `node:http` reads its lazy getters
// and loads undici (~8ms) on the launch path. See runtime/start-screen.mjs.
const http = createRequire(import.meta.url)("node:http")

/**
 * Negotiated newest-first against what the client asks for. A client naming a
 * version this server does not know is answered with the newest it does know,
 * which is what the spec asks for and what every SDK client accepts.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * The ceiling a default-configured client aborts at, less a safety margin.
 *
 * Exported because it is a contract, not a tuning knob: the suite asserts it
 * stays under 60, and the tool's own schema prints it so a model asking for
 * 300 seconds learns the real limit instead of having its call thrown away.
 */
export const MAX_WAIT_SECONDS = 55
export const DEFAULT_WAIT_SECONDS = 45

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INTERNAL_ERROR = -32603

function clamp(value, min, max, fallback) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, number))
}

function jsonText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }
}

/**
 * What the agent is actually given for one change.
 *
 * `brief` is the same markdown the Prompts tab's Copy button writes, because
 * two descriptions of one change drift and the copy-paste path has to stay
 * exactly as good as the MCP path — it is the fallback when no agent is
 * attached, not a lesser mode.
 */
/*
 * `sessionPrompt` is a send asking for a NEW chat session. A server cannot open
 * one in its client — nothing in MCP starts a turn, let alone a conversation —
 * so the agent parked in `wait_for_change` is told to open it, in whatever way
 * its own harness does. Resolving the change once the session is started is
 * what stops the next wait from opening a second session for the same send.
 */
const NEW_SESSION_STEPS =
  "For each change with startNewSession: true, open a new chat session in your harness and send its " +
  "sessionPrompt, verbatim, as that session's first message; the new session does the work. If you " +
  "cannot open a session, do the work here instead. Then call resolve_change for that id so the next " +
  "wait does not start it again."

function publicView(entry) {
  return {
    id: entry.id,
    status: entry.status,
    createdAt: entry.createdAt,
    origin: entry.origin,
    page: entry.url,
    framework: entry.framework,
    request: entry.prompt || null,
    brief: entry.brief || null,
    startNewSession: Boolean(entry.sessionPrompt),
    sessionPrompt: entry.sessionPrompt || null,
    files: entry.files,
    selection: entry.selection,
    ancestry: entry.ancestry,
    handoffFile: entry.handoffPath,
  }
}

function toolDefinitions() {
  return [
    {
      name: "wait_for_change",
      title: "Wait for a design change",
      description:
        "Block until the designer presses Send to agent in DesignLayer, then return the " +
        "pending changes with their brief, source files and selected element. Returns immediately " +
        "if changes are already waiting. On timeout it returns `{timeout: true}` and nothing else " +
        "— that is not an error, it means the designer has not clicked yet. " +
        "Use this in a loop for hands-free work: wait, apply the changes it returns, call " +
        "resolve_change for each one, then wait again. Keep waiting until the user tells you to stop. " +
        `${NEW_SESSION_STEPS} ` +
        "Call it once at a time: there is no claim on a change, so two callers waiting at once are " +
        "both handed the same one and will both try to apply it.",
      inputSchema: {
        type: "object",
        properties: {
          timeoutSeconds: {
            type: "number",
            description: `Seconds to block before returning {timeout:true} (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}). Do not raise this — clients abort at 60s.`,
          },
          batchWindowSeconds: {
            type: "number",
            description:
              "After the first change arrives, keep collecting for this long so a burst of clicks returns as one batch (default 1.5, max 15).",
          },
        },
        required: [],
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: false },
    },
    {
      name: "list_changes",
      title: "List design changes",
      description:
        "List changes the designer has sent, without blocking. Use this to check the queue " +
        "at the start of a session; use wait_for_change to sit and wait for the next one.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "resolved", "rejected", "all"],
            description: "Which changes to return (default: pending).",
          },
        },
        required: [],
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    {
      name: "get_change",
      title: "Get one design change",
      description: "Return the full record for one change by id, including the whole brief.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The change id." } },
        required: ["id"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    {
      name: "resolve_change",
      title: "Resolve a design change",
      description:
        "Mark a change done so the next wait_for_change does not hand it back. Call it once " +
        "per change after you have applied it. Use resolution 'rejected' with a reason when you " +
        "decided not to make the change, so the designer learns why rather than watching nothing happen.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The change id." },
          resolution: {
            type: "string",
            enum: ["applied", "rejected"],
            description: "Whether you made the change (default: applied).",
          },
          summary: {
            type: "string",
            description: "One or two sentences on what you changed, or why you did not.",
          },
        },
        required: ["id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ]
}

/**
 * Dispatches one `tools/call`.
 *
 * A tool that cannot do what was asked returns `isError: true` with a sentence,
 * rather than a JSON-RPC error: a protocol error means "this call was
 * malformed", and the model never sees it as something it could act on.
 */
async function callTool(queue, name, args, signal) {
  const input = args && typeof args === "object" ? args : {}

  if (name === "wait_for_change") {
    const seconds = clamp(input.timeoutSeconds, 1, MAX_WAIT_SECONDS, DEFAULT_WAIT_SECONDS)
    const batch = clamp(input.batchWindowSeconds, 0, 15, 1.5)
    const changes = await queue.wait({
      timeoutMs: seconds * 1000,
      batchMs: batch * 1000,
      signal,
    })
    if (changes.length === 0) {
      return jsonText({
        timeout: true,
        waitedSeconds: seconds,
        message:
          "No change yet. This is normal — call wait_for_change again to keep watching, " +
          "or stop if the user is done.",
      })
    }
    const newSession = changes.some((entry) => entry.sessionPrompt)
    return jsonText({
      timeout: false,
      count: changes.length,
      changes: changes.map(publicView),
      next: newSession
        ? `${NEW_SESSION_STEPS} Then call wait_for_change again.`
        : "Apply these, then call resolve_change for each id, then call wait_for_change again.",
    })
  }

  if (name === "list_changes") {
    const status = typeof input.status === "string" ? input.status : "pending"
    const changes = queue.list(status)
    return jsonText({ status, count: changes.length, changes: changes.map(publicView) })
  }

  if (name === "get_change") {
    const entry = typeof input.id === "string" ? queue.get(input.id) : null
    if (!entry) {
      return { ...jsonText({ error: `No change with id ${input.id ?? "(missing)"}.` }), isError: true }
    }
    return jsonText(publicView(entry))
  }

  if (name === "resolve_change") {
    const entry =
      typeof input.id === "string"
        ? queue.resolve(input.id, { resolution: input.resolution, summary: input.summary })
        : null
    if (!entry) {
      return { ...jsonText({ error: `No change with id ${input.id ?? "(missing)"}.` }), isError: true }
    }
    return jsonText({ ok: true, id: entry.id, status: entry.status, resolution: entry.resolution })
  }

  return { ...jsonText({ error: `Unknown tool: ${name}` }), isError: true }
}

function negotiateProtocol(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION
}

/**
 * One JSON-RPC message in, one response out — or `null` for a notification,
 * which by the spec gets no body and an HTTP 202.
 */
async function handleMessage(message, { queue, serverInfo, signal, onSession }) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "Not a JSON-RPC 2.0 message" } }
  }

  const { method, id, params } = message
  const isNotification = id === undefined || id === null

  if (method === "initialize") {
    onSession()
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiateProtocol(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions:
          "DesignLayer is open in a browser. When the designer presses Send to agent, " +
          "wait_for_change returns the change. Work the loop: wait_for_change, apply, " +
          "resolve_change, wait_for_change again. " +
          NEW_SESSION_STEPS,
      },
    }
  }

  // Every `notifications/*` the client sends is bookkeeping this server does
  // not act on, and a notification MUST NOT be answered with a result.
  if (isNotification) return null

  if (method === "ping") return { jsonrpc: "2.0", id, result: {} }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: toolDefinitions() } }
  }

  if (method === "tools/call") {
    const name = params?.name
    if (typeof name !== "string") {
      return { jsonrpc: "2.0", id, error: { code: JSONRPC_INVALID_REQUEST, message: "tools/call needs a name" } }
    }
    try {
      const result = await callTool(queue, name, params?.arguments, signal)
      return { jsonrpc: "2.0", id, result }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error"
      return { jsonrpc: "2.0", id, error: { code: JSONRPC_INTERNAL_ERROR, message: detail } }
    }
  }

  // Declaring no `resources`/`prompts` capability should stop these being asked
  // for at all, but some clients probe regardless and read a -32601 as a fault.
  if (method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [] } }
  if (method === "prompts/list") return { jsonrpc: "2.0", id, result: { prompts: [] } }

  return { jsonrpc: "2.0", id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Unknown method: ${method}` } }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    ...extraHeaders,
  })
  res.end(body)
}

/**
 * @param {object} options
 * @param {object} options.queue        the handoff queue this server reads
 * @param {(req: import("node:http").IncomingMessage) => boolean} options.isLocalRequest
 *   the same loopback guard the editor's own routes use. The transport spec
 *   requires Origin validation against DNS rebinding, and writing a second
 *   implementation of it is how the two come to disagree.
 */
/** A session heard from this recently counts as an attached agent. */
const SESSION_ACTIVE_MS = 10 * 60 * 1000
/** A session silent this long is forgotten; its client re-initializes on the 404. */
const SESSION_FORGET_MS = 24 * 60 * 60 * 1000

export function createMcpEndpoint({ queue, isLocalRequest, version = "0.1.0", path: mcpPath = "/mcp" }) {
  const serverInfo = { name: "designlayer", title: "DesignLayer", version }
  /** session id -> `{ lastSeen, inFlight }`, issued on `initialize`. */
  const sessions = new Map()

  /**
   * How many agents are attached, counted when asked rather than when a session
   * opens or closes.
   *
   * Most clients quit by closing the socket, not by sending DELETE, so a count
   * kept on those two edges only ever went up: every agent restart added one
   * and the panel said an agent was attached when none was. So a session counts
   * while it has a request in flight — an agent parked in `wait_for_change`
   * holds one for up to a minute and then asks again — or was heard from within
   * `SESSION_ACTIVE_MS`. A session silent for `SESSION_FORGET_MS` is forgotten
   * outright, which bounds the map; a client returning after that is answered
   * 404 and re-initializes, as the transport spec intends.
   */
  const attachedAgents = () => {
    const now = Date.now()
    let count = 0
    for (const [id, session] of sessions) {
      if (session.inFlight > 0 || now - session.lastSeen < SESSION_ACTIVE_MS) count += 1
      else if (now - session.lastSeen >= SESSION_FORGET_MS) sessions.delete(id)
    }
    return count
  }

  /**
   * Hand the queue the counter itself. The editor's own panel needs to answer
   * "is an agent connected?" and cannot ask this server directly: the browser
   * is refused by the content-type guard below, on purpose, so that a page
   * cannot reach the tool surface. So the count goes where the panel can
   * already see it, and is computed on each read so an agent that went silent
   * drops out without an event to report it.
   */
  const reportSessions = () => {
    try {
      queue.reportAttachedAgents?.(attachedAgents)
    } catch {
      // A queue without the method is an older one; the status simply stays at
      // zero, which reads as "no agent", which is the safe direction to be
      // wrong in.
    }
  }
  reportSessions()

  async function handle(req, res) {
    if (!isLocalRequest(req)) {
      sendJson(res, 403, {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSONRPC_INVALID_REQUEST, message: "DesignLayer MCP endpoint is loopback-only" },
      })
      return true
    }

    // No server-initiated traffic means no standalone stream to open. 405 with
    // `Allow` is exactly what the spec prescribes, and clients treat it as
    // "this server has nothing to push", not as a failure.
    if (req.method === "GET") {
      res.writeHead(405, { allow: "POST, DELETE" })
      res.end()
      return true
    }

    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"]
      if (typeof sessionId === "string") sessions.delete(sessionId)
      res.writeHead(204)
      res.end()
      return true
    }

    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST, DELETE" })
      res.end()
      return true
    }

    /*
     * Require JSON, and refuse to be a CORS-simple request.
     *
     * The loopback guard is not enough on its own here. It accepts any loopback
     * Origin, which includes the app being edited — so a script on the dev
     * server (a compromised dependency, an injected tag) is same-"origin"
     * enough to pass it. A POST with `content-type: text/plain` is a CORS
     * SIMPLE request: no preflight, so the browser sends it, and the side
     * effect lands even though the attacker cannot read the reply. Measured
     * before this check: such a request resolved a pending change to
     * "rejected".
     *
     * Demanding `application/json` forces a preflight, and this server answers
     * no OPTIONS and sets no `Access-Control-Allow-Origin`, so the preflight
     * fails and the request is never sent. A non-browser client sets the header
     * anyway — every MCP client does.
     */
    const contentType = String(req.headers["content-type"] ?? "")
    if (!contentType.toLowerCase().includes("application/json")) {
      sendJson(res, 415, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSONRPC_INVALID_REQUEST,
          message: "Content-Type must be application/json",
        },
      })
      return true
    }

    /*
     * Spec: an invalid or unsupported `MCP-Protocol-Version` MUST be a 400.
     * Absent is fine — it means the 2025-03-26 default, which is in the list.
     */
    const declaredVersion = req.headers["mcp-protocol-version"]
    if (typeof declaredVersion === "string" && !SUPPORTED_PROTOCOL_VERSIONS.includes(declaredVersion)) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSONRPC_INVALID_REQUEST,
          message: `Unsupported MCP-Protocol-Version: ${declaredVersion}`,
        },
      })
      return true
    }

    /*
     * A session id this server never issued, or one it has already deleted,
     * MUST be a 404 — that is the signal telling the client to re-initialize.
     * Answering 200 instead leaves a client reconnecting after a restart
     * talking to a session that does not exist and never learning.
     *
     * A request with no session id still passes: a client may decline to track
     * one, and refusing those would be refusing conformant clients.
     */
    const declaredSession = req.headers["mcp-session-id"]
    if (typeof declaredSession === "string" && !sessions.has(declaredSession)) {
      sendJson(res, 404, {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSONRPC_INVALID_REQUEST, message: "Unknown or terminated session" },
      })
      return true
    }

    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      sendJson(res, error.statusCode ?? 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSONRPC_INVALID_REQUEST, message: error.message },
      })
      return true
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSONRPC_PARSE_ERROR, message: "Invalid JSON" },
      })
      return true
    }

    // The client's own abort is the only signal that a blocking tool should
    // stop holding. Without this a cancelled `wait_for_change` keeps its waiter
    // parked and races the next real one for the designer's click.
    const controller = new AbortController()
    req.once("aborted", () => controller.abort())
    res.once("close", () => controller.abort())

    let assignedSession = null
    const onSession = () => {
      assignedSession = randomUUID()
      sessions.set(assignedSession, { lastSeen: Date.now(), inFlight: 0 })
    }

    // Seen at both ends of the request: a `wait_for_change` that held for a
    // minute is a minute of the agent being present.
    const declared = typeof declaredSession === "string" ? sessions.get(declaredSession) : null
    if (declared) {
      declared.lastSeen = Date.now()
      declared.inFlight += 1
    }
    const batch = Array.isArray(parsed) ? parsed : [parsed]
    const responses = []
    try {
      for (const message of batch) {
        const response = await handleMessage(message, {
          queue,
          serverInfo,
          signal: controller.signal,
          onSession,
        })
        if (response) responses.push(response)
      }
    } finally {
      if (declared) {
        declared.lastSeen = Date.now()
        declared.inFlight -= 1
      }
    }

    // Writing to a socket the client already closed throws; the work is done
    // either way and there is nobody left to tell.
    if (res.writableEnded || controller.signal.aborted) return true

    const headers = assignedSession ? { "mcp-session-id": assignedSession } : {}
    if (responses.length === 0) {
      res.writeHead(202, headers)
      res.end()
      return true
    }

    sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0], headers)
    return true
  }

  /** Mountable beside the editor's own routes: returns false when not ours. */
  function tryHandle(req, res) {
    const pathname = (req.url ?? "").split("?")[0]
    if (pathname !== mcpPath) return false
    void handle(req, res)
    return true
  }

  /**
   * A dedicated port, not the proxy's.
   *
   * `ports.proxy` defaults to `auto` and a static MCP config entry needs a URL
   * that is the same tomorrow. A designer who has to re-edit their agent config
   * every time they restart the editor will use the clipboard instead.
   */
  function listen(port, host = "127.0.0.1") {
    // `new http.Server(handler)`, NOT `http.createServer(handler)`.
    //
    // The launcher replaces `http.createServer` with a wrapper that mounts the
    // editor's own routes — options, control defaults, the Angular and React
    // source writers — in front of whatever handler it is given, so that they
    // share the page's origin on the proxy. A server built with it inherits
    // that wrapper, and this one would then serve the whole file-writing API on
    // a port the README publishes as a fixed number. Measured before the fix:
    // `POST 127.0.0.1:5747/__designlayer/source/remove` answered 200.
    //
    // The constructor is not patched, so this server serves exactly one path.
    const server = new http.Server((req, res) => {
      if (tryHandle(req, res)) return
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: `No designlayer MCP route for ${req.method} ${req.url}` }))
    })
    return new Promise((resolve, reject) => {
      const onListenError = (error) => reject(error)
      server.once("error", onListenError)
      server.listen(port, host, () => {
        // Left attached, this swallows the first post-listen socket error and
        // then throws an unhandled rejection on the second.
        server.removeListener("error", onListenError)
        resolve(server)
      })
    })
  }

  return { handle, tryHandle, listen, toolDefinitions }
}
