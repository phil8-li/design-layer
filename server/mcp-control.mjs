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
 * With several editors running, the start screen serves the endpoint for all
 * of them whatever the setting says (`runtime/mcp-hub.mjs`), because only one
 * process can hold the port. An editor then never binds it, and the switch
 * shows on and cannot be turned off: taking the endpoint back into one editor
 * would leave the others sending into nothing. If the start screen cannot bind
 * it yet, the editor still does not: it reports MCP off with the start
 * screen's reason and asks again on every send and status read, relaying as
 * soon as the start screen hosts.
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
/**
 * How long boot waits for a start screen that is binding the port right now.
 * Its own bind retries for `MOVE_RETRY_MS`, so this outlasts that.
 */
const HUB_STARTING_WAIT_MS = 3000
const HUB_POLL_MS = 50

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
  /**
   * Off because the start screen owns the endpoint and cannot bind it yet.
   * This editor never binds it instead: a second process on the port is what
   * left other editors' sends going nowhere. Each send and status read asks
   * the start screen again, which also makes it retry the bind.
   */
  let awaitingHub = false
  /** The start screen's reason, shown while `awaitingHub`. */
  let hubReason = null

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

  /** The start screen's status, polled while `keepWaiting` holds and it does not host yet. */
  async function askHub(keepWaiting) {
    let answer = await hub("GET", "api/mcp")
    const deadline = Date.now() + HUB_STARTING_WAIT_MS
    while (answer && !answer.hosting && keepWaiting(answer) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, HUB_POLL_MS))
      answer = await hub("GET", "api/mcp")
    }
    return answer
  }

  function waitForHub(answer) {
    mode = "off"
    awaitingHub = true
    hubReason = answer?.reason ?? "The start screen couldn’t start MCP."
  }

  /** While waiting on the start screen, one more ask: relay from now on if it hosts. */
  async function rejoinHub() {
    if (!awaitingHub || mode !== "off") return
    try {
      const answer = await askHub((reply) => reply.starting)
      if (answer?.hosting) {
        mode = "hub"
        awaitingHub = false
        hubReason = null
      } else if (answer?.reason) {
        hubReason = answer.reason
      }
    } catch {
      // Not answering right now; stay off and ask again next time.
    }
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
      awaitingHub = false
      hubReason = null
    } catch (error) {
      if (awaitingHub) throw error
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
          // Binding, or owning, the endpoint for the editors it runs, likely
          // this one. Binding here as well would race it for the port, and
          // whichever lost would leave some editors' sends going nowhere. Each
          // read makes a start screen that owns it try the port again.
          const answer = await askHub((reply) => reply.starting || reply.shared)
          if (answer?.hosting) {
            mode = "hub"
            return { mode, port: answer.port ?? null }
          }
          if (answer?.starting || answer?.shared) {
            waitForHub(answer)
            return { mode, port: null, error: hubReason }
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
      await rejoinHub()
      // Nobody serves this queue, and taking the port would split the agents.
      if (awaitingHub) return { delivered: null, waiting: 0, listening: false }
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
      await rejoinHub()
      if (awaitingHub) {
        return {
          url: null,
          port: null,
          listening: false,
          agents: 0,
          waiting: 0,
          pending: 0,
          stay: true,
          canStay,
          shared: true,
          reason: hubReason,
        }
      }
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
            shared: answer.shared === true,
          }
        } catch {
          return {
            url: null,
            port: null,
            listening: false,
            agents: 0,
            waiting: 0,
            pending: 0,
            stay: true,
            canStay,
            shared: false,
          }
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
        shared: false,
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
