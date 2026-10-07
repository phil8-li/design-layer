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
  let endpointListening = false
  /**
   * How many MCP sessions are open right now.
   *
   * Distinct from `endpointListening` in the way that actually matters to a
   * designer, and conflating the two is a bug this file has already paid for:
   * the endpoint flag is set by the LAUNCHER when our own port binds, so it is
   * true from the moment the editor starts and says nothing whatsoever about
   * whether anybody is on the other end. A panel that read it as "connected"
   * told every user their agent was attached before they had configured one.
   *
   * This is the other half. The MCP server owns the truth — it issues a session
   * id on `initialize` and drops it on DELETE — and reports the number here,
   * because the queue is the one object both the server and the HTTP routes can
   * already reach.
   */
  let attachedAgents = 0

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
      status: "pending",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolution: null,
      summary: null,
      origin: typeof input.origin === "string" ? input.origin : "unknown",
      prompt: truncate(input.prompt ?? ""),
      brief: truncate(input.brief ?? ""),
      url: typeof input.url === "string" ? input.url : null,
      framework: typeof input.framework === "string" ? input.framework : null,
      selection: input.selection ?? null,
      ancestry: Array.isArray(input.ancestry) ? input.ancestry : [],
      files: Array.isArray(input.files) ? input.files : [],
      handoffPath: typeof input.handoffPath === "string" ? input.handoffPath : null,
    }
    entries.set(entry.id, entry)
    prune()
    wake()
    return entry
  }

  function list(status) {
    const all = [...entries.values()]
    if (!status || status === "all") return all
    return all.filter((entry) => entry.status === status)
  }

  function get(id) {
    return entries.get(id) ?? null
  }

  function pending() {
    return list("pending")
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
    const settled = resolution === "rejected" ? "rejected" : "applied"
    entry.status = settled === "rejected" ? "rejected" : "resolved"
    entry.resolution = settled
    entry.summary = typeof summary === "string" ? summary.slice(0, 2000) : null
    entry.resolvedAt = new Date().toISOString()
    return entry
  }

  function clear() {
    entries.clear()
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
   */
  function wait({ timeoutMs = 45_000, batchMs = 1500, signal } = {}) {
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
      const finish = () => {
        if (settled) return
        settled = true
        resolveWait(pending())
        waiters.delete(onPush)
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
      const timer = setTimeout(finish, Math.max(0, timeoutMs))

      waiters.add(onPush)
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
    wait,
    get size() {
      return entries.size
    },
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
     * Whether the MCP endpoint actually bound.
     *
     * Separate from `waiting`, and the difference is the whole point. An agent
     * can be attached and merely mid-turn, which is "queued". But if the
     * endpoint never came up — `ports.mcp` is `null`, or a second editor
     * session already holds the port — then nothing can EVER call
     * `wait_for_change`, and telling the designer their change is on its way
     * would be a lie whose only correction went to a terminal they are not
     * looking at.
     */
    markEndpointListening() {
      endpointListening = true
    },
    get endpointListening() {
      return endpointListening
    },
    /**
     * The MCP server reporting how many sessions it currently holds: a count,
     * or a function that counts when called.
     *
     * Pushed rather than pulled because the server is created by the launcher
     * and the routes never see it; the queue is the only thing they share. A
     * count rather than an increment, so a server that resets cannot leave this
     * drifting upwards forever.
     */
    reportAttachedAgents(count) {
      attachedAgents = count
    },
    get attachedAgents() {
      // A counter function is what the MCP server hands over, because whether
      // a silent session still counts depends on when you ask.
      let value = attachedAgents
      if (typeof value === "function") {
        try {
          value = value()
        } catch {
          value = 0
        }
      }
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
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
