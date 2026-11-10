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
 * Every caller goes through here — the launcher at boot and at exit, the
 * `/agent` route for a send, the `/mcp/status` and `/mcp/stay` routes for the
 * panel — so none of them can disagree about where the endpoint is.
 *
 * ## The machine
 *
 * `placement` is one of these, and nothing else:
 *
 *   { kind: "booting" }               configured; `boot` has not landed yet
 *   { kind: "local", server }         this process serves the port
 *   { kind: "relayed" }               the start screen serves it; this relays
 *   { kind: "awaitingHub", reason }   the start screen owns it and cannot bind yet
 *   { kind: "off", reason }           nobody serves it here: no port, a failed
 *                                     bind, or `close`
 *
 *   booting     --boot, start screen hosts---------------> relayed
 *   booting     --boot, start screen binding or shared---> awaitingHub(reason)
 *   booting     --boot, no start screen, or no answer----> local | off(reason)
 *   awaitingHub --send or status, start screen hosts-----> relayed
 *   awaitingHub --setStay(true), start screen hosts------> relayed
 *   local, off  --setStay(true), start screen takes it---> relayed
 *   local       --setStay(true), start screen refuses----> local (bound again) | off(reason)
 *   relayed     --setStay(false), bound here-------------> local
 *   relayed     --setStay(false), cannot bind------------> relayed (handed back) | off(reason)
 *   awaitingHub --setStay(false), start screen lets go---> local | off(reason)
 *   any         --close----------------------------------> off("closed")
 *
 * `transition` is the only writer. Every event — boot, a send, a status read,
 * a switch, close — runs on one promise chain (`serial`), so none of them
 * interleave: a send waits for the move in flight to land, and three clicks on
 * the switch from two tabs run one after another instead of racing into a
 * split endpoint. Entering `relayed` from boot or a rejoin forwards any change
 * this process queued before it knew the start screen hosts.
 *
 * An unconfigured control — a suite building the routes directly — stays
 * `booting`: it records sends on the process's queue and reports whatever that
 * queue's endpoint says.
 */

import { handoffQueue } from "./handoff.mjs"
import { httpError as refusal } from "../runtime/http-error.mjs"
import { isLocalRequest as loopbackOnly } from "../runtime/loopback.mjs"
import { closeEndpoint, openEndpoint } from "./mcp.mjs"
import { createSerial } from "./serial.mjs"

const HUB_TIMEOUT_MS = 4000
/** Long enough for the other process to let the port go; see `openEndpoint`. */
const MOVE_RETRY_MS = 1500
/**
 * How long boot waits for a start screen that is binding the port right now.
 * Its own bind retries for `MOVE_RETRY_MS`, so this outlasts that.
 */
const HUB_STARTING_WAIT_MS = 3000
const HUB_POLL_MS = 50
/** A status read asks a start screen that cannot bind yet at most this often. */
const REJOIN_STATUS_EVERY_MS = 1000

const HUB_SILENT = "The start screen isn’t answering."

/** Why a port could not be had, as a sentence for the designer. */
function portReason(error, port) {
  return error?.code === "EADDRINUSE"
    ? `Another program is using port ${port}.`
    : (error?.message ?? "The port could not be opened.")
}

/**
 * What one send became, from the queue's two facts read before the push.
 *
 * "delivered": an agent was parked in `wait_for_change`, and the push woke it.
 * "queued": the endpoint is up and nobody waits yet; the next wait gets it.
 * "undelivered": no endpoint serves the queue, so nothing will pick it up.
 */
function outcomeOf({ entry, waiting, listening }) {
  if (!entry || !listening) return "undelivered"
  return waiting > 0 ? "delivered" : "queued"
}

/**
 * @param {object} options
 * @param {number|null} options.port      `ports.mcp`; null serves nothing here
 * @param {string|null} options.hubUrl    the start screen this editor came from
 * @param {string|null} options.token     what the start screen asks its editors for
 * @param {Function} [options.isLocalRequest] the loopback guard; the real one by default
 */
export function createMcpControl({ port = null, hubUrl = null, token = null, isLocalRequest = loopbackOnly } = {}) {
  const queue = handoffQueue()
  const canStay = Boolean(hubUrl && token)
  const serial = createSerial()
  /** See the table at the top of this file. Written only by `transition`. */
  let placement = { kind: "booting" }
  /** When a status read last asked a start screen that cannot bind yet. */
  let rejoinAskedAt = 0
  /** The port the start screen reported at boot, for the launcher's log line. */
  let hubPort = null

  function transition(next) {
    placement = next
  }

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
      throw refusal(HUB_SILENT, 502)
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

  /**
   * Relay from now on, after handing the start screen whatever this process
   * queued while it did not know the start screen hosts (a send before boot
   * landed). Each keeps its id; one that cannot be handed stays here.
   */
  async function enterRelayed() {
    transition({ kind: "relayed" })
    for (const entry of queue.pending()) {
      try {
        await hub("POST", "api/mcp/push", entry)
        queue.remove([entry.id])
      } catch {
        break
      }
    }
  }

  /** While waiting on the start screen, one more ask: relay from now on if it hosts. */
  async function rejoinHub() {
    if (placement.kind !== "awaitingHub") return
    rejoinAskedAt = Date.now()
    try {
      const answer = await askHub((reply) => reply.starting)
      if (answer?.hosting) await enterRelayed()
      else if (answer?.reason) transition({ kind: "awaitingHub", reason: answer.reason })
    } catch {
      // Not answering right now; stay off and ask again next time.
    }
  }

  /** Binds the port here. Never throws; lands in `local` or `off(reason)`. */
  async function serveHere(retryMs = 0) {
    if (typeof port !== "number") {
      transition({ kind: "off", reason: null })
      return null
    }
    try {
      const server = await openEndpoint({ queue, isLocalRequest, port, retryMs })
      transition({ kind: "local", server })
      return null
    } catch (error) {
      const reason = portReason(error, port)
      transition({ kind: "off", reason })
      return reason
    }
  }

  /** Closes the endpoint here, if any, and hands back the changes still waiting in it. */
  async function stopServingHere() {
    if (placement.kind === "local") await closeEndpoint(placement.server, queue)
    return queue.handOff()
  }

  async function moveToHub() {
    if (placement.kind === "relayed") return
    const wasAwaiting = placement.kind === "awaitingHub"
    const wasLocal = placement.kind === "local"
    const handed = await stopServingHere()
    try {
      await hub("POST", "api/mcp/stay", { on: true, pending: handed })
      transition({ kind: "relayed" })
    } catch (error) {
      queue.adopt(handed)
      // Still the start screen's to bind; this editor never takes it instead.
      if (wasAwaiting) throw error
      // Back where it was, so the agent has an endpoint either way.
      if (wasLocal) await serveHere(MOVE_RETRY_MS)
      else transition({ kind: "off", reason: placement.reason ?? null })
      throw error
    }
  }

  async function moveHere() {
    // Asked only when the start screen holds it: asking otherwise made it let
    // go of the port and hand back changes this process then dropped.
    if (placement.kind !== "relayed" && placement.kind !== "awaitingHub") return
    const answer = await hub("POST", "api/mcp/stay", { on: false })
    const handed = Array.isArray(answer?.handed) ? answer.handed : []
    queue.adopt(handed)
    const reason = await serveHere(MOVE_RETRY_MS)
    if (reason === null) return
    // The start screen let go and this process cannot bind: give it back.
    const back = queue.handOff()
    try {
      await hub("POST", "api/mcp/stay", { on: true, pending: back })
      transition({ kind: "relayed" })
    } catch {
      queue.adopt(back)
      transition({ kind: "off", reason })
    }
    throw refusal(reason, 409)
  }

  /** The status every placement reports, from one shape. */
  function view(fields) {
    return {
      url: null,
      port: null,
      listening: false,
      agents: 0,
      waiting: 0,
      pending: 0,
      stay: false,
      canStay,
      shared: false,
      ...fields,
    }
  }

  /** The queue in this process, as the panel reads it. */
  function localView(fallbackPort) {
    const snapshot = queue.snapshot()
    const bound = snapshot.listening ? (port ?? fallbackPort) : null
    return view({
      ...snapshot,
      url: bound ? `http://127.0.0.1:${bound}/mcp` : null,
      port: bound,
    })
  }

  /** One send, recorded where the agent will see it. Runs on the chain. */
  async function deliverNow(input) {
    if (placement.kind === "awaitingHub") await rejoinHub()
    // Nobody serves this queue, and taking the port would split the agents.
    if (placement.kind === "awaitingHub") {
      return { outcome: "undelivered", changeId: null, cause: "no-endpoint", reason: placement.reason }
    }
    if (placement.kind === "relayed") {
      try {
        const answer = await hub("POST", "api/mcp/push", input)
        const entry = answer?.id ? { id: answer.id } : null
        const outcome = outcomeOf({ entry, waiting: answer?.waiting ?? 0, listening: answer?.listening === true })
        return { outcome, changeId: entry?.id ?? null, cause: outcome === "undelivered" ? "no-endpoint" : null }
      } catch (error) {
        return { outcome: "undelivered", changeId: null, cause: "relay-failed", reason: error.message }
      }
    }
    // `waiting` and `listening` are read before the push, by whichever process
    // holds the queue: pushing wakes every waiter, so asking afterwards always
    // reports zero and the message could never say an agent was there.
    const waiting = queue.waiting
    const listening = queue.endpointListening
    let entry = null
    try {
      entry = queue.push(input)
    } catch {
      // The queue is the optional half of a send; the durable record is
      // already on disk.
      entry = null
    }
    const outcome = outcomeOf({ entry, waiting, listening })
    return { outcome, changeId: entry?.id ?? null, cause: outcome === "undelivered" ? "no-endpoint" : null }
  }

  /** What the panel shows. Runs on the chain. */
  async function statusNow(fallbackPort) {
    if (placement.kind === "awaitingHub" && Date.now() - rejoinAskedAt >= REJOIN_STATUS_EVERY_MS) {
      await rejoinHub()
    }
    switch (placement.kind) {
      case "awaitingHub":
        return view({ stay: true, shared: true, reason: placement.reason })
      case "relayed":
        try {
          const answer = await hub("GET", "api/mcp")
          return view({
            url: answer.url ?? null,
            port: answer.port ?? null,
            listening: answer.listening === true,
            agents: answer.agents ?? 0,
            waiting: answer.waiting ?? 0,
            pending: answer.pending ?? 0,
            stay: true,
            shared: answer.shared === true,
          })
        } catch (error) {
          // Named, so the panel does not blame another editor for the port.
          return view({ stay: true, reason: error.message || HUB_SILENT })
        }
      default:
        return localView(fallbackPort)
    }
  }

  /** The boot decision. Runs on the chain; never throws. */
  async function bootNow() {
    if (placement.kind !== "booting") return
    if (canStay) {
      try {
        // Binding, or owning, the endpoint for the editors it runs, likely
        // this one. Binding here as well would race it for the port, and
        // whichever lost would leave some editors' sends going nowhere. Each
        // read makes a start screen that owns it try the port again.
        const answer = await askHub((reply) => reply.starting || reply.shared)
        if (answer?.hosting) {
          hubPort = answer.port ?? null
          await enterRelayed()
          return
        }
        if (answer?.starting || answer?.shared) {
          transition({ kind: "awaitingHub", reason: answer?.reason ?? "The start screen couldn’t start MCP." })
          return
        }
      } catch {
        // No answer: serve here, as an editor without a start screen would.
      }
    }
    await serveHere()
  }

  /** `placement` in the three words the launcher and older callers read. */
  function mode() {
    if (placement.kind === "relayed") return "hub"
    if (placement.kind === "local" || placement.kind === "booting") return "local"
    return "off"
  }

  return {
    /** "local", "hub" or "off"; see `placement` for the whole state. */
    get mode() {
      return mode()
    },

    /** The placement's kind: booting, local, relayed, awaitingHub or off. */
    get placement() {
      return placement.kind
    },

    /**
     * Serve here, unless the start screen already does.
     *
     * Never throws: an endpoint that cannot start is a warning, and the editor's
     * whole job is unaffected by it. Answers `{ mode, port, error? }`.
     */
    boot() {
      return serial(async () => {
        await bootNow()
        const answer = { mode: mode(), port: null }
        if (placement.kind === "relayed") answer.port = hubPort
        if (placement.kind === "local") answer.port = port
        if (placement.kind === "off" || placement.kind === "awaitingHub") {
          if (placement.reason) answer.error = placement.reason
          if (placement.kind === "off") answer.port = port
        }
        return answer
      })
    },

    /**
     * Records one send where the agent will see it.
     *
     * Answers `{ outcome, changeId, cause, reason? }`: `outcome` is
     * "delivered", "queued" or "undelivered" (see `outcomeOf`), and `cause`
     * says why a send went undelivered — "no-endpoint" (nothing serves the
     * queue, or nobody can be listening) or "relay-failed" (the start screen
     * did not answer the push).
     */
    deliver(input) {
      return serial(() => deliverNow(input))
    },

    /**
     * What the panel shows. `fallbackPort` is the configured port, for a
     * process whose launcher never booted this object.
     */
    status(fallbackPort = null) {
      return serial(() => statusNow(fallbackPort))
    },

    /**
     * Moves the endpoint to the start screen, or back here.
     *
     * The agent keeps its session across the move: parked waits end with
     * reason "endpoint_closing", the next call reaches whichever process holds
     * the port by then, and that process adopts the session id. Changes still
     * waiting move with the endpoint, under the ids the agent may already
     * have seen.
     */
    setStay(on) {
      if (!canStay) {
        return Promise.reject(
          refusal("This editor wasn’t started from the start screen, so MCP runs in this app.", 409)
        )
      }
      return serial(() => (on ? moveToHub() : moveHere()))
    },

    /**
     * Stops serving here, for an editor that is exiting: parked waits get an
     * answer and connections close within the one-second grace, instead of
     * being cut. The start screen's endpoint, if any, is not this object's.
     */
    close() {
      return serial(async () => {
        if (placement.kind === "local") await closeEndpoint(placement.server, queue)
        transition({ kind: "off", reason: "closed" })
      })
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

/**
 * Closes this process's control on the way out, bounded so an exit is never
 * held up for long: `closeEndpoint`'s own grace is one second. A process that
 * never made a control has nothing to close.
 */
export async function shutdownMcpControl(timeoutMs = 1500) {
  if (!shared) return
  let timer
  await Promise.race([
    shared.close().catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  clearTimeout(timer)
}
