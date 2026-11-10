/**
 * The queue between the designer's button and the coding agent's turn loop.
 *
 * An MCP server cannot push work to an agent. The complete set of messages a
 * server may send a client — `ServerRequestSchema` / `ServerNotificationSchema`
 * in the protocol — contains no "here is a task, go do it": there is ping,
 * elicitation, roots, task bookkeeping, and notifications about lists going
 * stale. Nothing starts a turn. An agent's loop runs when a human types, or
 * while a tool call it made has not yet returned.
 *
 * So a one-click handoff is not a push. It is a pull that was already parked:
 * the agent calls a tool that blocks, the designer clicks, the tool returns.
 * This module is the thing in the middle — the only shared state between the
 * HTTP route the button posts to and the MCP tool the agent is sitting inside.
 *
 * It is deliberately in-memory. The durable record of a request is the markdown
 * file `writeHandoff` already writes under `<stateDir>/requests/`; this queue is
 * the *trigger*, and a trigger that outlives the process it was meant to wake is
 * worse than no trigger at all — an agent attaching tomorrow would be handed a
 * change the designer made yesterday against source that has since moved.
 */

/*
 * ## The words, in one place
 *
 * A change's `status` is one of `CHANGE_STATUSES`; `resolve_change` takes one
 * of `RESOLUTIONS`. The two vocabularies meet at one point: resolution
 * "applied" files the change as status "resolved", and "rejected" as
 * "rejected". `list_changes` filters by status, and also takes "applied" as
 * the alias an agent reaches for after writing it (`statusFilter`).
 *
 *   pending  --resolve_change applied---> resolved
 *   pending  --resolve_change rejected--> rejected
 *   resolved / rejected --resolve_change--> either (the last call wins)
 *   any      --201st newer push---------> gone, remembered as "evicted"
 *   pending  --endpoint moves away------> gone here, remembered as "moved";
 *                                          the other process adopts it, same id
 *
 * The endpoint that serves this queue is in one of `ENDPOINT_STATES`:
 *
 *   never-bound --markEndpointListening--> listening
 *   listening   --release----------------> draining   (parked waits end empty)
 *   draining    --markEndpointStopped----> stopped
 *   stopped     --markEndpointListening--> listening  (the endpoint came back)
 *
 * A wait asked for while draining or stopped answers at once, empty: its
 * changes are about to belong to another process.
 */

export const CHANGE_STATUSES = Object.freeze(["pending", "resolved", "rejected"])
export const RESOLUTIONS = Object.freeze(["applied", "rejected"])
/** What `list_changes` accepts: a status, or "all". */
export const STATUS_FILTERS = Object.freeze([...CHANGE_STATUSES, "all"])
export const ENDPOINT_STATES = Object.freeze(["never-bound", "listening", "draining", "stopped"])

const [PENDING, RESOLVED, REJECTED] = CHANGE_STATUSES

/**
 * The status a `list_changes` filter names, or null for a word that is none.
 *
 * "applied" is the word `resolve_change` takes, so an agent that just wrote it
 * asks for it back; it means "resolved". Anything else outside the list used
 * to answer an empty list, which reads as "nothing there" rather than "you
 * asked wrong".
 */
export function statusFilter(value) {
  if (value === undefined || value === null || value === "") return PENDING
  if (value === "applied") return RESOLVED
  return STATUS_FILTERS.includes(value) ? value : null
}

/** How many dropped ids are remembered, so an agent asking for one learns why. */
const MAX_FORGOTTEN = 1000

/**
 * Past this, the oldest entry is dropped rather than grown into.
 *
 * By insertion order, regardless of status — so a run of 200 resolved changes
 * will evict a pending one. Acceptable only because 200 unsent changes in one
 * editor session is already a session that has gone wrong, and because the
 * durable record is the markdown file, not this.
 */
const MAX_ENTRIES = 200

/**
 * Bounded so one enormous ledger cannot be posted through an agent's context.
 * A brief this long has already stopped being one change and become a rewrite.
 */
const MAX_BRIEF_BYTES = 64 * 1024

let sequence = 0

export function createHandoffQueue() {
  /** @type {Map<string, object>} */
  const entries = new Map()
  /** @type {Set<() => void>} */
  const waiters = new Set()
  /** Ends one parked wait with nothing in it; see `release`. */
  const releasers = new Set()
  /** One of `ENDPOINT_STATES`; see the table at the top of this file. */
  let endpoint = "never-bound"
  /**
   * The serving endpoint's count of attached agents, a function called on each
   * read, or null when no endpoint serves this queue.
   *
   * Distinct from the endpoint being up in the way that actually matters to a
   * designer, and conflating the two is a bug this file has already paid for:
   * the port is bound from the moment the editor starts, which says nothing
   * whatsoever about whether anybody is on the other end. A panel that read it
   * as "connected" told every user their agent was attached before they had
   * configured one.
   *
   * The MCP server owns the truth — which sessions it has heard from lately —
   * and hands its counter here, because the queue is the one object both the
   * server and the HTTP routes can already reach. A function rather than a
   * number, because whether a silent session still counts depends on when you
   * ask.
   */
  let agentCounter = null
  /** Ids no longer here, and why: "evicted" or "moved". Bounded, oldest first. */
  const forgotten = new Map()

  function forget(id, cause) {
    forgotten.delete(id)
    forgotten.set(id, cause)
    if (forgotten.size > MAX_FORGOTTEN) forgotten.delete(forgotten.keys().next().value)
  }

  function wake() {
    // Copied before iterating: a waiter removes itself from the set inside its
    // own callback, and mutating a Set mid-iteration skips the next member.
    for (const waiter of [...waiters]) {
      try {
        waiter()
      } catch {
        // One agent's request dying must not cost a second agent its wake-up,
        // and must not throw back into the route that is recording the click.
      }
    }
  }

  function prune() {
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next()
      if (oldest.done) return
      entries.delete(oldest.value)
      forget(oldest.value, "evicted")
    }
  }

  /**
   * Measured and cut in the SAME unit.
   *
   * `Buffer.byteLength` counts UTF-8 bytes and `String.slice` counts UTF-16
   * code units, so mixing them meant a 40,000-character brief measured as
   * 120,048 bytes, failed the test, and was then "sliced" to 65,536 *characters*
   * — which is the whole string. It passed through untouched with a note
   * claiming it had been truncated. One em dash was enough to start the drift.
   *
   * Cutting the Buffer can land mid-sequence; `toString` renders that last
   * partial character as U+FFFD, which is the honest outcome for a cut.
   */
  function truncate(value) {
    if (typeof value !== "string") return ""
    const bytes = Buffer.from(value, "utf8")
    if (bytes.byteLength <= MAX_BRIEF_BYTES) return value
    const cut = bytes.subarray(0, MAX_BRIEF_BYTES).toString("utf8")
    return `${cut}\n\n[truncated — the brief exceeded ${MAX_BRIEF_BYTES} bytes]`
  }

  /**
   * Records one press of "Send to agent" and wakes anything waiting.
   *
   * The id is a counter, not a timestamp: two clicks inside the same
   * millisecond are two changes, and an agent that resolves one of them must
   * not thereby resolve the other.
   */
  function push(input = {}) {
    sequence += 1
    const entry = {
      id: `chg-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      status: PENDING,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolution: null,
      summary: null,
      origin: typeof input.origin === "string" ? input.origin : "unknown",
      prompt: truncate(input.prompt ?? ""),
      brief: truncate(input.brief ?? ""),
      sessionPrompt: truncate(input.sessionPrompt ?? ""),
      url: typeof input.url === "string" ? input.url : null,
      framework: typeof input.framework === "string" ? input.framework : null,
      selection: input.selection ?? null,
      ancestry: Array.isArray(input.ancestry) ? input.ancestry : [],
      files: Array.isArray(input.files) ? input.files : [],
      handoffPath: typeof input.handoffPath === "string" ? input.handoffPath : null,
      // Which project the change is for. One endpoint serves every editor the
      // start screen runs, and `files` and `handoffPath` are relative to this.
      projectRoot: typeof input.projectRoot === "string" && input.projectRoot ? input.projectRoot : null,
      app: typeof input.app === "string" && input.app ? input.app : null,
    }
    entries.set(entry.id, entry)
    prune()
    wake()
    return entry
  }

  /** Entries with `status`, or every entry for "all" or none. */
  function list(status) {
    const all = [...entries.values()]
    if (!status || status === "all") return all
    return all.filter((entry) => entry.status === status)
  }

  function get(id) {
    return entries.get(id) ?? null
  }

  function pending() {
    return list(PENDING)
  }

  /**
   * Moves an entry out of `pending` so the next `wait` does not hand the agent
   * the same change again. Agentation's state machine is the reference here:
   * without it, a loop re-reads its own finished work forever.
   */
  function resolve(id, { resolution = "applied", summary = null } = {}) {
    const entry = entries.get(id)
    if (!entry) return null
    // Narrowed to the declared enum rather than stored verbatim. A model that
    // answers "partially" or mistypes "aplied" would otherwise have that word
    // read back out of `list_changes` later as if it were a real state.
    const settled = resolution === REJECTED ? REJECTED : "applied"
    entry.status = settled === REJECTED ? REJECTED : RESOLVED
    entry.resolution = settled
    entry.summary = typeof summary === "string" ? summary.slice(0, 2000) : null
    entry.resolvedAt = new Date().toISOString()
    return entry
  }

  function clear() {
    entries.clear()
  }

  /**
   * Takes changes queued in another process, keeping their ids.
   *
   * The endpoint moves between the editor and the start screen, and a change
   * an agent was already handed must still resolve by the id it was given.
   */
  function adopt(incoming = []) {
    for (const entry of incoming) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue
      entries.set(entry.id, { ...entry })
      forgotten.delete(entry.id)
    }
    prune()
    if (incoming.length > 0) wake()
  }

  /** Drops changes another process now holds, so they are not delivered twice. */
  function remove(ids = []) {
    for (const id of ids) if (entries.delete(id)) forget(id, "moved")
  }

  /**
   * Takes every pending change out, to hand to the process the endpoint moves
   * to. Called after the endpoint here has closed, so a send that landed while
   * it was closing goes too rather than staying behind where nothing serves it.
   */
  function handOff() {
    const handed = pending()
    remove(handed.map((entry) => entry.id))
    return handed
  }

  /**
   * Ends every parked wait with nothing, as if each had timed out.
   *
   * Used when the endpoint is about to close. An agent sees an ordinary
   * `{timeout: true}` and calls again, which reaches whichever process holds
   * the port by then. Cutting the request instead reads as a failed call, and
   * some clients drop a server's tools after a single one.
   */
  function release() {
    endpoint = "draining"
    for (const end of [...releasers]) end()
  }

  /**
   * Drain first, then block.
   *
   * Going straight to the blocking wait loses every click that landed while the
   * agent was thinking about the previous one — the window between two calls is
   * exactly when a designer is most likely to press the button, because the
   * agent has just finished talking. Draining first closes it.
   *
   * `batchMs` then lets a burst coalesce: only the FIRST arrival opens the
   * window, so five fast clicks still return in one batch bounded by `batchMs`
   * rather than extending it five times.
   *
   * The timeout is ours, not the caller's. A client that gave up sends an abort
   * if it is well behaved and nothing at all if it is not, and a waiter left
   * parked on a dead request is a leak that races the next real one.
   *
   * TWO WAITERS BOTH GET THE SAME CHANGES. There is no lease and no claim: a
   * push wakes every waiter and each resolves with the whole pending set, so
   * two agents attached at once will both be handed the same edit and both try
   * to apply it. That is deliberate for a tool where one designer drives one
   * browser — an entry claimed by an agent that then crashed would be worse,
   * because nothing would ever hand it to anyone again. It is why
   * `wait_for_change` does not advertise itself as safe to call speculatively.
   *
   * One call's states: drained (pending at the call, resolved at once),
   * refused (the endpoint is draining or stopped: resolved at once, empty),
   * parked, collecting (the first push opened the batch window), and settled
   * by one of delivered, timed out (whatever is pending then, usually
   * nothing), aborted, or released (empty). `finish` is the one exit.
   */
  function wait({ timeoutMs = 45_000, batchMs = 1500, signal } = {}) {
    if (endpoint === "draining" || endpoint === "stopped") return Promise.resolve([])
    const drained = pending()
    if (drained.length > 0) return Promise.resolve(drained)

    return new Promise((resolveWait) => {
      let batchTimer = null
      let settled = false

      /*
       * Resolve FIRST, then tidy up.
       *
       * With the cleanup ahead of the resolve, anything that threw in it —
       * `removeEventListener` on an exotic signal, say — escaped `finish`
       * having already set `settled`, so the timeout path returned early and
       * the promise never settled at all. The agent's tool call then hung until
       * its client gave up. Nothing reachable throws there today; the ordering
       * is what makes that not matter.
       */
      const finish = (deliver = true) => {
        if (settled) return
        settled = true
        resolveWait(deliver ? pending() : [])
        waiters.delete(onPush)
        releasers.delete(end)
        clearTimeout(timer)
        if (batchTimer) clearTimeout(batchTimer)
        try {
          signal?.removeEventListener("abort", onAbort)
        } catch {
          // A listener that cannot be removed is a leak on a dead request, not
          // a reason to drop the answer we have already handed back.
        }
      }

      const onPush = () => {
        if (batchMs <= 0) return finish()
        // Already collecting. Returning here rather than finishing is the whole
        // batch: the window belongs to the first arrival, and every later one
        // rides it out. Finishing on the second push instead would cap a batch
        // at two entries however fast the designer clicked.
        if (batchTimer) return
        batchTimer = setTimeout(finish, batchMs)
      }
      const onAbort = () => finish()
      const end = () => finish(false)
      const timer = setTimeout(finish, Math.max(0, timeoutMs))

      waiters.add(onPush)
      releasers.add(end)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  return {
    push,
    list,
    get,
    pending,
    resolve,
    clear,
    adopt,
    remove,
    handOff,
    release,
    wait,
    /**
     * How many agents are parked in `wait_for_change` right now.
     *
     * The one honest answer to "will anything pick this up?". An agent that is
     * attached but mid-turn is not waiting, and a queue entry it has not asked
     * for yet is a note on a desk, not a delivery — so the button says "queued"
     * unless this is non-zero, rather than claiming a handoff it cannot see.
     */
    get waiting() {
      return waiters.size
    },
    /**
     * The endpoint bound. Separate from `waiting`, and the difference is the
     * whole point: an agent can be attached and merely mid-turn, which is
     * "queued". But if the endpoint never came up — `ports.mcp` is `null`, or
     * another process holds the port — then nothing can EVER call
     * `wait_for_change`, and telling the designer their change is on its way
     * would be a lie whose only correction went to a terminal they are not
     * looking at.
     */
    markEndpointListening() {
      endpoint = "listening"
    },
    /** The endpoint closed, because it moved to another process or this one is ending. */
    markEndpointStopped() {
      endpoint = "stopped"
      agentCounter = null
    },
    /** One of `ENDPOINT_STATES`. */
    get endpointState() {
      return endpoint
    },
    get endpointListening() {
      return endpoint === "listening"
    },
    /**
     * Why `id` is not here, when this queue knows: "evicted" (more than
     * `MAX_ENTRIES` newer changes arrived) or "moved" (the endpoint moved to
     * another process, which holds it under the same id). Null for an id this
     * queue never held — mistyped, or from before a restart.
     */
    whyMissing(id) {
      return forgotten.get(id) ?? null
    },
    /** The serving endpoint hands over its counter; see `agentCounter`. */
    reportAttachedAgents(counter) {
      agentCounter = typeof counter === "function" ? counter : null
    },
    /**
     * How many agents are attached. An agent parked in `wait_for_change`
     * always counts, whatever its session bookkeeping says: a client that
     * sends no session id is invisible to the endpoint's counter once it has
     * been quiet for a while, and the panel then told the designer "No agent
     * connected" while one was waiting.
     */
    get attachedAgents() {
      let counted = 0
      try {
        counted = agentCounter ? agentCounter() : 0
      } catch {
        counted = 0
      }
      const sessions = Number.isFinite(counted) && counted > 0 ? Math.floor(counted) : 0
      return Math.max(sessions, waiters.size)
    },
    /** The queue's half of an MCP status, read in one place by every process. */
    snapshot() {
      return {
        listening: endpoint === "listening",
        agents: this.attachedAgents,
        waiting: waiters.size,
        pending: pending().length,
      }
    },
  }
}

/**
 * One queue per process. The editor is one process editing one project, and a
 * second queue would mean the button filled one while the agent watched the
 * other — the failure mode being that nothing at all happens, with no error.
 */
let shared = null

export function handoffQueue() {
  if (!shared) shared = createHandoffQueue()
  return shared
}
