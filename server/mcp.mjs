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

import { RESOLUTIONS, STATUS_FILTERS, statusFilter } from "./handoff.mjs"
import { isJsonContentType, readBody, sendJson } from "./http-json.mjs"

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

/*
 * `sessionPrompt` is a send asking for a NEW chat session. A server cannot open
 * one in its client — nothing in MCP starts a turn, let alone a conversation —
 * so the agent parked in `wait_for_change` is told to open it, in whatever way
 * its own harness does. Resolving the change once the session is started is
 * what stops the next wait from opening a second session for the same send.
 * The prompt the agent forwards ends by naming the change id (`sessionPromptFor`),
 * so the session that does the work can resolve it again with what it did.
 */
const NEW_SESSION_STEPS =
  "For each change with startNewSession: true, start a new chat session — a separate top-level " +
  "conversation the user can see, not a subagent — and send its sessionPrompt, verbatim, as that " +
  "session's first message; the new session does the work. If you have no way to start one, do the " +
  "work here instead. Then call resolve_change for that id with resolution applied so the next wait " +
  "does not start it again. The sessionPrompt ends by naming the change id, so the new session can " +
  "call resolve_change again with what it actually did."

/*
 * One endpoint can serve several editors, each on its own project, so every
 * change names its repo. `files` and `handoffFile` are relative to it.
 */
const PROJECT_STEPS =
  "Each change names its projectRoot (an absolute folder) and app: do the work in that folder; " +
  "its files and handoffFile are relative to it."

/** How many ids an unknown-id error lists, newest first. */
const MAX_KNOWN_IDS = 20

/**
 * The prompt a new session opens with: the browser's, then the change's id
 * and how to close it. Without the id, the session that did the work could
 * not resolve or reject anything, and the change read "resolved, applied" from
 * the moment a session was merely opened.
 */
function sessionPromptFor(entry) {
  if (!entry.sessionPrompt) return null
  return (
    `${entry.sessionPrompt}\n\n---\nThis is DesignLayer change ${entry.id}. When the work is done, call the ` +
    `DesignLayer MCP tool resolve_change with id "${entry.id}", resolution "applied" (or "rejected" with ` +
    "the reason), and a one- or two-sentence summary of what you did."
  )
}

/**
 * What the agent is actually given for one change.
 *
 * `brief` is the same markdown the Changes tab's Copy button writes, because
 * two descriptions of one change drift and the copy-paste path has to stay
 * exactly as good as the MCP path — it is the fallback when no agent is
 * attached, not a lesser mode.
 *
 * `resolution`, `summary` and `resolvedAt` are null until `resolve_change`
 * runs, so an agent reading `list_changes` later sees why a change was
 * rejected. `selection` and `ancestry` stay for older clients; the Changes tab
 * sends none.
 */
function publicView(entry) {
  return {
    id: entry.id,
    status: entry.status,
    createdAt: entry.createdAt,
    app: entry.app ?? null,
    projectRoot: entry.projectRoot ?? null,
    origin: entry.origin,
    page: entry.url,
    framework: entry.framework,
    request: entry.prompt || null,
    brief: entry.brief || null,
    startNewSession: Boolean(entry.sessionPrompt),
    sessionPrompt: sessionPromptFor(entry),
    files: entry.files,
    selection: entry.selection,
    ancestry: entry.ancestry,
    handoffFile: entry.handoffPath,
    resolution: entry.resolution ?? null,
    summary: entry.summary ?? null,
    resolvedAt: entry.resolvedAt ?? null,
  }
}

function toolDefinitions() {
  return [
    {
      name: "wait_for_change",
      title: "Wait for a design change",
      description:
        "Block until the designer presses Send to agent in DesignLayer, then return the pending " +
        "changes, each with its brief (the designer's notes and edits, as markdown), source files and " +
        "projectRoot. Returns at once if changes are already pending. When none arrives it returns " +
        "`{timeout: true}` with reason, waitedSeconds and message — not an error: reason \"timeout\" " +
        "means the designer has not clicked yet, and \"endpoint_closing\" means the MCP endpoint closed " +
        "or is moving between DesignLayer processes. Call it again either way. " +
        "Use this in a loop for hands-free work: wait, apply the changes it returns, call " +
        "resolve_change for each one, then wait again. Keep waiting until the user tells you to stop. " +
        `${PROJECT_STEPS} ` +
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
        "List changes the designer has sent, without blocking. A change's status is pending (sent and " +
        "not resolved yet, even if a wait already returned it), resolved (resolve_change with applied) " +
        "or rejected. Use this to check the queue at the start of a session; use wait_for_change to sit " +
        "and wait for the next one. Changes live in the editor's memory, so a restart empties the list.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [...STATUS_FILTERS],
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
      description:
        "Return the full record for one change by id, including the whole brief, its status, and its " +
        "resolution and summary once resolved.",
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
        "Mark a change done so the next wait_for_change does not hand it back: resolution applied " +
        "gives it status resolved, and rejected gives it status rejected. Call it once per change, after " +
        "you have applied it or decided not to, with a summary of what you changed or why you did not. " +
        "The summary is kept with the change for list_changes and get_change; the editor does not show " +
        "it to the designer yet. Calling it again replaces the earlier resolution.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The change id." },
          resolution: {
            type: "string",
            enum: [...RESOLUTIONS],
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

/** A tool answer the model reads as a failure, with what to do next. */
function toolError(payload) {
  return { ...jsonText(payload), isError: true }
}

/**
 * Why `id` is not in the queue, in words an agent can act on.
 *
 * Four causes look alike from outside: a mistyped id, one dropped by the
 * 200-entry cap, one that moved with the endpoint to another process, and one
 * from before a restart (the queue lives in memory). The queue remembers the
 * two it caused; for the other two the answer lists the ids it does hold.
 */
function unknownChange(queue, tool, id) {
  if (typeof id !== "string" || id.length === 0) {
    return toolError({
      error: `${tool} needs an id: the id field of a change from wait_for_change or list_changes.`,
      code: "invalid_argument",
      next: "Call list_changes with status all to see the ids, then call this tool again with one.",
    })
  }
  const cause = queue.whyMissing(id)
  const knownIds = queue
    .list("all")
    .map((entry) => entry.id)
    .slice(-MAX_KNOWN_IDS)
    .reverse()
  if (cause === "evicted") {
    return toolError({
      error: `No change with id ${id}: it was dropped after more than 200 newer changes arrived.`,
      code: "unknown_change",
      cause,
      next: "Its brief is still in its request file (handoffFile). Ask the designer to send it again if it still matters.",
      knownIds,
    })
  }
  if (cause === "moved") {
    return toolError({
      error: `No change with id ${id} here: it moved with the MCP endpoint to another DesignLayer process, under the same id.`,
      code: "unknown_change",
      cause,
      next: "Call wait_for_change or list_changes again in a few seconds; the process that holds the port then answers for it.",
      knownIds,
    })
  }
  return toolError({
    error:
      `No change with id ${id}. The id may be mistyped, or from before the editor or start screen ` +
      `restarted: changes live in memory, and this endpoint now holds ${knownIds.length === 0 ? "none" : `these: ${knownIds.join(", ")}`}.`,
    code: "unknown_change",
    cause: "unknown",
    next: "Use an id from list_changes with status all, or ask the designer to send the change again.",
    knownIds,
  })
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
    const startedAt = Date.now()
    const changes = await queue.wait({
      timeoutMs: seconds * 1000,
      batchMs: batch * 1000,
      signal,
    })
    if (changes.length === 0) {
      // Measured, not echoed: a wait the closing endpoint ended after 0.2 s
      // used to report the 45 s it was asked for, which made an agent's log
      // unreadable and its backoff wrong.
      const waitedSeconds = Math.round((Date.now() - startedAt) / 100) / 10
      const state = queue.endpointState
      if (state === "draining" || state === "stopped") {
        return jsonText({
          timeout: true,
          reason: "endpoint_closing",
          waitedSeconds,
          timeoutSeconds: seconds,
          message:
            "The MCP endpoint closed or is moving between DesignLayer processes (the editor and the " +
            "start screen), so this wait ended early. Call wait_for_change again; if that call cannot " +
            "connect, wait 2 seconds and try again, or stop if the user closed DesignLayer.",
        })
      }
      return jsonText({
        timeout: true,
        reason: "timeout",
        waitedSeconds,
        timeoutSeconds: seconds,
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
        : "Apply each one in its projectRoot, then call resolve_change for each id, then call wait_for_change again.",
    })
  }

  if (name === "list_changes") {
    const asked = input.status
    const status = statusFilter(asked)
    if (status === null) {
      return toolError({
        error: `Unknown status ${JSON.stringify(asked)}. Use one of: ${STATUS_FILTERS.join(", ")}.`,
        code: "invalid_argument",
        next: "Call list_changes again with one of those, or with no status for pending changes.",
      })
    }
    const changes = queue.list(status)
    // `status` echoes the word asked for, as it always has; "applied" lists
    // the resolved changes.
    return jsonText({
      status: typeof asked === "string" && asked ? asked : status,
      count: changes.length,
      changes: changes.map(publicView),
    })
  }

  if (name === "get_change") {
    const entry = typeof input.id === "string" ? queue.get(input.id) : null
    if (!entry) return unknownChange(queue, name, input.id)
    return jsonText(publicView(entry))
  }

  if (name === "resolve_change") {
    const entry =
      typeof input.id === "string"
        ? queue.resolve(input.id, { resolution: input.resolution, summary: input.summary })
        : null
    if (!entry) return unknownChange(queue, name, input.id)
    const reply = { ok: true, id: entry.id, status: entry.status, resolution: entry.resolution }
    // Narrowed, as the queue always has; now the agent is told, so a typo of
    // "rejected" does not pass as a silent "applied".
    if (input.resolution !== undefined && !RESOLUTIONS.includes(input.resolution)) {
      reply.warning =
        `${JSON.stringify(input.resolution)} is not a resolution; recorded as applied. ` +
        `Call resolve_change again with resolution rejected if you meant that.`
    }
    return jsonText(reply)
  }

  return toolError({
    error: `Unknown tool: ${name}`,
    code: "unknown_tool",
    next: "Call tools/list: this server has wait_for_change, list_changes, get_change and resolve_change.",
  })
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
        /*
         * The first sentence carries the name and the purpose. Harnesses that
         * defer MCP tools show only that sentence beside the server, and an
         * agent asked to "connect to design layer" read the old one — "DesignLayer
         * is open in a browser." — and picked a different annotation server.
         * Connecting means waiting: an agent that is not parked in
         * wait_for_change cannot hear the button.
         */
        instructions:
          "DesignLayer (design layer) visual editor: when the designer presses Send to agent, " +
          "wait_for_change returns their notes and edits. When the user asks you to connect, " +
          "call wait_for_change right away and keep calling it until they say stop. " +
          `${PROJECT_STEPS} ` +
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

/** A session heard from this recently counts as an attached agent. */
const SESSION_ACTIVE_MS = 10 * 60 * 1000
/** A session silent this long is forgotten; it is adopted again if it comes back. */
const SESSION_FORGET_MS = 24 * 60 * 60 * 1000
/** How many ended session ids are remembered, so a reused one is still refused. */
const MAX_TERMINATED = 1000

/**
 * Who is attached: the session registry, with one writer per event.
 *
 * Per session id: unknown --initialize--> live (new id); unknown --request
 * with an unseen id--> live (adopted); live --request starts / ends--> busy /
 * live; live --SESSION_ACTIVE_MS silence--> idle (not counted); idle
 * --SESSION_FORGET_MS--> forgotten; any --DELETE--> terminated (404 for good).
 * An `initialize` sent inside a session replaces that session rather than
 * adding a second, so one client re-initializing counts once.
 *
 * A request with no session id is a client that declined to track one, which
 * the spec allows. It cannot be remembered between calls, so it counts while
 * a request of its is in flight — which covers an agent parked in
 * `wait_for_change` for as long as it is parked.
 *
 * Counted when asked rather than when a session opens or closes. Most clients
 * quit by closing the socket, not by sending DELETE, so a count kept on those
 * two edges only ever went up: every agent restart added one and the panel
 * said an agent was attached when none was.
 */
function createSessionRegistry() {
  /** session id -> `{ lastSeen, inFlight }` */
  const sessions = new Map()
  /** Ids the client ended with DELETE. The one case still answered 404. */
  const terminated = new Set()
  let anonymousInFlight = 0

  return {
    isTerminated: (id) => terminated.has(id),
    has: (id) => sessions.has(id),
    adopt(id) {
      sessions.set(id, { lastSeen: Date.now(), inFlight: 0 })
    },
    /** A new session from `initialize`; `replacing` is the id it was sent under, if any. */
    open(replacing) {
      if (typeof replacing === "string") sessions.delete(replacing)
      const id = randomUUID()
      sessions.set(id, { lastSeen: Date.now(), inFlight: 0 })
      return id
    },
    terminate(id) {
      sessions.delete(id)
      terminated.add(id)
      // Bounded like the session map: the oldest ended id goes first.
      if (terminated.size > MAX_TERMINATED) terminated.delete(terminated.values().next().value)
    },
    /**
     * A request starts; returns its `end`. Seen at both ends: a
     * `wait_for_change` that held for a minute is a minute of the agent being
     * present.
     */
    begin(id) {
      const session = typeof id === "string" ? sessions.get(id) : null
      if (!session) {
        anonymousInFlight += 1
        return () => {
          anonymousInFlight -= 1
        }
      }
      session.lastSeen = Date.now()
      session.inFlight += 1
      return () => {
        session.lastSeen = Date.now()
        session.inFlight -= 1
      }
    },
    count() {
      const now = Date.now()
      let count = anonymousInFlight
      for (const [id, session] of sessions) {
        if (session.inFlight > 0 || now - session.lastSeen < SESSION_ACTIVE_MS) count += 1
        else if (now - session.lastSeen >= SESSION_FORGET_MS) sessions.delete(id)
      }
      return count
    },
  }
}

/**
 * The MCP endpoint for one queue, ready to `listen` on its own port.
 *
 * @param {object} options
 * @param {object} options.queue        the handoff queue this server reads
 * @param {(req: import("node:http").IncomingMessage) => boolean} options.isLocalRequest
 *   the same loopback guard the editor's own routes use. The transport spec
 *   requires Origin validation against DNS rebinding, and writing a second
 *   implementation of it is how the two come to disagree.
 */
export function createMcpEndpoint({ queue, isLocalRequest, version = "0.1.0", path: mcpPath = "/mcp" }) {
  const serverInfo = { name: "designlayer", title: "DesignLayer", version }
  const sessions = createSessionRegistry()

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
      if (typeof sessionId === "string") sessions.terminate(sessionId)
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
    if (!isJsonContentType(req)) {
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
     * A session id this process has not seen is ADOPTED, not refused.
     *
     * It used to be a 404, which the spec reserves for a terminated session so
     * the client re-initializes. Clients do not all do that: one in daily use
     * marks the server failed on the 404 and drops its tools until it is
     * restarted. And an unseen id is the normal case here, not a stale one: the
     * endpoint moves between the editor and the start screen, and an editor
     * restart is a new process. A session holds nothing but its last-seen
     * time, so adopting one costs nothing and keeps the agent connected.
     *
     * A session the client ended with DELETE is still a 404: that one is
     * terminated in exactly the spec's sense.
     *
     * A request with no session id still passes: a client may decline to track
     * one, and refusing those would be refusing conformant clients. It counts
     * as attached while its request is in flight (see `createSessionRegistry`).
     */
    const declaredSession = req.headers["mcp-session-id"]
    if (typeof declaredSession === "string" && !sessions.has(declaredSession)) {
      // The spec's alphabet for an id: visible ASCII. Anything else is not one.
      if (sessions.isTerminated(declaredSession) || !/^[\x21-\x7e]{1,128}$/.test(declaredSession)) {
        sendJson(res, 404, {
          jsonrpc: "2.0",
          id: null,
          error: { code: JSONRPC_INVALID_REQUEST, message: "Unknown or terminated session" },
        })
        return true
      }
      sessions.adopt(declaredSession)
    }

    let raw
    try {
      raw = await readBody(req, MAX_BODY_BYTES)
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
      assignedSession = sessions.open(declaredSession)
    }

    const end = sessions.begin(declaredSession)
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
      end()
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
      if ((req.url ?? "").split("?")[0] === mcpPath) {
        void handle(req, res)
        return
      }
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
        /*
         * Hand the queue the counter itself, once the port is ours. The
         * editor's own panel needs to answer "is an agent connected?" and
         * cannot ask this server directly: the browser is refused by the
         * content-type guard above, on purpose, so that a page cannot reach the
         * tool surface. So the count goes where the panel can already see it,
         * and is computed on each read so an agent that went silent drops out
         * without an event to report it. `closeEndpoint` takes it back.
         */
        queue.reportAttachedAgents(sessions.count)
        resolve(server)
      })
    })
  }

  return { listen }
}

/**
 * Binds an endpoint for `queue` on `port`.
 *
 * `retryMs` covers the moment the endpoint moves between processes: the one it
 * comes from may still be letting the port go when this one asks for it.
 */
export async function openEndpoint({ queue, isLocalRequest, port, retryMs = 0 }) {
  const endpoint = createMcpEndpoint({ queue, isLocalRequest })
  const deadline = Date.now() + retryMs
  for (;;) {
    try {
      const server = await endpoint.listen(port, "127.0.0.1")
      queue.markEndpointListening()
      return server
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

/**
 * Closes an endpoint so its port can move, or its process end, without failing
 * anybody's call.
 *
 * Parked waits end first, as answers with reason "endpoint_closing", then the
 * server stops taking connections and closes each one once its last answer is
 * written. A socket cut mid-request is what a client reads as the server
 * failing. The queue stops counting this server's sessions as attached.
 */
export function closeEndpoint(server, queue, graceMs = 1000) {
  queue.release()
  queue.markEndpointStopped()
  return new Promise((resolve) => {
    const force = setTimeout(() => server.closeAllConnections(), graceMs)
    server.close(() => {
      clearTimeout(force)
      resolve()
    })
  })
}
