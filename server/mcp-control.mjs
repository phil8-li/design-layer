/**
 * Where this editor's MCP endpoint runs, and the one object that knows.
 *
 * By default the editor serves MCP itself, on `ports.mcp`, and the endpoint
 * dies with the editor: switching apps or restarting one leaves the port shut
 * for a few seconds. An agent that calls in that window is answered by nothing,
 * and some clients drop a server's tools after one failed call and never take
 * them back.
 *
 * An editor started from the start screen can hand the endpoint to it instead
 * ("Stay on between apps" in the Changes tab). The start screen outlives every
 * editor, so the port never closes; this process then only relays to it — the
 * change a send records, and the status the panel shows. The start screen also
 * keeps the setting, because it is the process that outlives the choice.
 *
 * Every caller goes through here — the launcher at boot, the `/agent` route for
 * a send, the `/mcp/status` route for the panel — so none of them can disagree
 * about where the endpoint is.
 */

import { handoffQueue } from "./handoff.mjs"
import { closeEndpoint, openEndpoint } from "./mcp.mjs"

const HUB_TIMEOUT_MS = 4000
/** Long enough for the other process to let the port go; see `openEndpoint`. */
const MOVE_RETRY_MS = 1500

function refusal(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/** Why a port could not be had, as a sentence for the designer. */
function portReason(error, port) {
  return error?.code === "EADDRINUSE"
    ? `Another program is using port ${port}.`
    : (error?.message ?? "The port could not be opened.")
}

/**
 * @param {object} options
 * @param {number|null} options.port      `ports.mcp`; null serves nothing here
 * @param {string|null} options.hubUrl    the start screen this editor came from
 * @param {string|null} options.token     what the start screen asks its editors for
 */
export function createMcpControl({ port = null, hubUrl = null, token = null, isLocalRequest = () => true } = {}) {
  const queue = handoffQueue()
  /** "local": this process serves it. "hub": the start screen does. "off": nobody here. */
  let mode = "local"
  let server = null
  /** The switch in flight, so a send or a status read waits for it to land. */
  let moving = null
  const canStay = Boolean(hubUrl && token)

  async function hub(method, pathname, body) {
    let response
    try {
      response = await fetch(new URL(pathname, hubUrl), {
        method,
        headers: { "content-type": "application/json", "x-designlayer-token": token },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      })
    } catch {
      throw refusal("The start screen isn’t answering.", 502)
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw refusal(payload?.error ?? `The start screen answered ${response.status}.`, response.status)
    }
    return payload
  }

  async function serveHere(retryMs = 0) {
    if (typeof port !== "number") {
      mode = "off"
      return
    }
    try {
      server = await openEndpoint({ queue, isLocalRequest, port, retryMs })
      mode = "local"
    } catch (error) {
      mode = "off"
      throw refusal(portReason(error, port), 409)
    }
  }

  /** Closes the endpoint here and hands back the changes still waiting in it. */
  async function stopServingHere() {
    const waiting = queue.pending()
    if (server) await closeEndpoint(server, queue)
    server = null
    queue.remove(waiting.map((entry) => entry.id))
    return waiting
  }

  async function moveToHub() {
    if (mode === "hub") return
    const handed = await stopServingHere()
    try {
      await hub("POST", "api/mcp/stay", { on: true, pending: handed })
      mode = "hub"
    } catch (error) {
      // Back where it was, so the agent has an endpoint either way.
      await serveHere(MOVE_RETRY_MS).catch(() => {})
      queue.adopt(handed)
      throw error
    }
  }

  async function moveHere() {
    const answer = await hub("POST", "api/mcp/stay", { on: false })
    if (mode !== "hub") return
    const handed = Array.isArray(answer?.handed) ? answer.handed : []
    try {
      await serveHere(MOVE_RETRY_MS)
      queue.adopt(handed)
    } catch (error) {
      // The start screen let go and this process cannot bind: give it back.
      try {
        await hub("POST", "api/mcp/stay", { on: true, pending: handed })
      } catch {
        mode = "off"
      }
      throw error
    }
  }

  return {
    get mode() {
      return mode
    },

    /**
     * Serve here, unless the start screen already does.
     *
     * Never throws: an endpoint that cannot start is a warning, and the editor's
     * whole job is unaffected by it.
     */
    async boot() {
      if (canStay) {
        try {
          const answer = await hub("GET", "api/mcp")
          if (answer?.hosting) {
            mode = "hub"
            return { mode, port: answer.port ?? null }
          }
        } catch {
          // No answer: serve here, as an editor without a start screen would.
        }
      }
      try {
        await serveHere()
        return { mode, port: mode === "local" ? port : null }
      } catch (error) {
        return { mode, port, error: error.message }
      }
    },

    /**
     * Records one send where the agent will see it.
     *
     * `waiting` and `listening` are read before the push, by whichever process
     * holds the queue: pushing wakes every waiter, so asking afterwards always
     * reports zero and the message could never say an agent was there.
     */
    async deliver(input) {
      if (moving) await moving.catch(() => {})
      if (mode === "hub") {
        try {
          const answer = await hub("POST", "api/mcp/push", input)
          return { delivered: { id: answer.id }, waiting: answer.waiting ?? 0, listening: answer.listening === true }
        } catch {
          return { delivered: null, waiting: 0, listening: false }
        }
      }
      const waiting = queue.waiting
      const listening = queue.endpointListening
      let delivered = null
      try {
        delivered = queue.push(input)
      } catch {
        // The queue is the optional half of a send; the durable record is
        // already on disk.
        delivered = null
      }
      return { delivered, waiting, listening }
    },

    /**
     * What the panel shows. `fallbackPort` is the configured port, for a
     * process whose launcher never booted this object.
     */
    async status(fallbackPort = null) {
      if (moving) await moving.catch(() => {})
      if (mode === "hub") {
        try {
          const answer = await hub("GET", "api/mcp")
          return {
            url: answer.url ?? null,
            port: answer.port ?? null,
            listening: answer.listening === true,
            agents: answer.agents ?? 0,
            waiting: answer.waiting ?? 0,
            pending: answer.pending ?? 0,
            stay: true,
            canStay,
          }
        } catch {
          return { url: null, port: null, listening: false, agents: 0, waiting: 0, pending: 0, stay: true, canStay }
        }
      }
      const bound = queue.endpointListening ? (port ?? fallbackPort) : null
      return {
        url: bound ? `http://127.0.0.1:${bound}/mcp` : null,
        port: bound,
        listening: queue.endpointListening,
        agents: queue.attachedAgents ?? 0,
        waiting: queue.waiting,
        pending: queue.list("pending").length,
        stay: false,
        canStay,
      }
    },

    /**
     * Moves the endpoint to the start screen, or back here.
     *
     * The agent keeps its session across the move: parked waits end as
     * ordinary timeouts, the next call reaches whichever process holds the port
     * by then, and that process adopts the session id. Changes still waiting
     * move with the endpoint, under the ids the agent may already have seen.
     */
    async setStay(on) {
      if (!canStay) {
        throw refusal("This editor wasn’t started from the start screen, so MCP runs in this app.", 409)
      }
      if (moving) await moving.catch(() => {})
      moving = on ? moveToHub() : moveHere()
      try {
        await moving
      } finally {
        moving = null
      }
    },

    /** Stops serving here. The start screen's endpoint, if any, is not this object's. */
    async close() {
      if (mode === "local") await stopServingHere()
    },
  }
}

/**
 * One per process, like the queue: the launcher configures it at boot, and the
 * routes and the agent read the same one. Unconfigured — a suite building the
 * routes directly — it serves nothing and records sends on the local queue.
 */
let shared = null

export function mcpControl() {
  shared ??= createMcpControl()
  return shared
}

export function configureMcpControl(options) {
  shared = createMcpControl(options)
  return shared
}
