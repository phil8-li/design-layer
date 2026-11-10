/**
 * The start screen's MCP endpoint: shared by every editor it runs, and kept on
 * between apps.
 *
 * The supervisor runs several editors at once, one per app, and the MCP port is
 * one fixed number an agent's config names. Only one process can bind it, so
 * with each editor serving its own, "Send to agent" from every editor but the
 * first went nowhere. So while the start screen runs any editor, it serves the
 * endpoint itself, whatever the setting says, and every editor relays to it
 * (`editorsChanged`). Each queued change names its project root, so one agent
 * can tell the projects apart.
 *
 * When the last editor stops, the endpoint stays up until the screen closes. A
 * change sent just before an editor was stopped is still waiting for the agent,
 * and closing the port would drop it along with the agent's session.
 *
 * "Stay on between apps" is the older half: with it on, the screen serves from
 * boot, before any editor exists. Editors reach the endpoint through three
 * token-guarded start screen routes (see `runtime/start-screen.mjs`) by way of
 * `server/mcp-control.mjs`.
 *
 * The setting lives here, in one small file outside any project: it belongs to
 * the machine's start screen, not to an app, and it has to be read before any
 * editor exists.
 *
 * ## The machine
 *
 * The endpoint is off, binding, hosting, or failed (off with a `reason`).
 * `host` and `letGo` are its only writers, and each bind carries the
 * `generation` it started in:
 *
 *   off, failed --boot (setting on) | editorsChanged(n > 0)--> binding
 *   failed      --status() read while editors run-----------> binding
 *                 (a read with a side effect, on purpose: see `status`)
 *   binding     --bound, generation still current-----------> hosting
 *   binding     --bound, a letGo or close came first--------> off (the new server is closed)
 *   binding     --bind failed-------------------------------> failed(reason)
 *   hosting     --stay(false), no editors | close-----------> off (pending handed back)
 *   hosting     --stay(false) with editors------------------> refused, still hosting
 *   any         --close--------------------------------------> off for good
 *
 * Without the generation, a `close` or a stay-off during a bind found no
 * server to close, and the bind then finished and served a port the setting
 * and the editors both said was off.
 */

import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DEFAULT_CONFIG } from "../config.mjs"
import { writeAtomicSync } from "../server/file-io.mjs"
import { createHandoffQueue } from "../server/handoff.mjs"
import { httpError as refusal } from "../server/http-error.mjs"
import { closeEndpoint, openEndpoint } from "../server/mcp.mjs"

/** Long enough for an editor to let the port go; see `openEndpoint`. */
const MOVE_RETRY_MS = 1500

/** Beside the editor registry, in the per-user state this package already keeps. */
function mcpSettingsFile() {
  return path.join(os.homedir(), ".local", "state", "designlayer", "mcp.json")
}

export function createMcpHub({
  port = DEFAULT_CONFIG.ports.mcp,
  file = mcpSettingsFile(),
  isLocalRequest,
  log = console.log,
} = {}) {
  /** What an editor this start screen spawned shows to use the routes below. */
  const token = randomBytes(24).toString("hex")
  const queue = createHandoffQueue()
  /** The bound endpoint, or null. Written only by `host` and `letGo`. */
  let server = null
  /** The bind in flight, so two callers never open two servers. */
  let opening = null
  /** Bumped by every `letGo`; a bind that finishes under an older one closes itself. */
  let generation = 0
  /** Set by `close`: this screen is going away, and binds no more. */
  let closed = false
  /** Live editors (starting or ready), as the start screen last reported. */
  let editors = 0
  /** Why the last bind failed, for an editor to show; null once one succeeds. */
  let reason = null

  function readSetting() {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"))?.stayBetweenApps === true
    } catch {
      return false
    }
  }

  function writeSetting(on) {
    try {
      writeAtomicSync(file, `${JSON.stringify({ stayBetweenApps: on })}\n`)
    } catch (error) {
      log(`[designlayer] could not save the MCP setting (${error.message})`)
    }
  }

  async function host(retryMs) {
    // A bind from before the last `letGo` is finishing only to close itself:
    // wait it out rather than share its refusal.
    while (opening && opening.ticket !== generation) await opening.promise.catch(() => {})
    if (server) return
    if (closed) throw refusal("The start screen is closing.", 409)
    if (opening) return opening.promise
    const ticket = generation
    const promise = (async () => {
      let bound
      try {
        bound = await openEndpoint({ queue, isLocalRequest, port, retryMs })
      } catch (error) {
        reason = error?.code === "EADDRINUSE" ? `Another program is using port ${port}.` : error.message
        throw refusal(reason, 409)
      }
      if (ticket !== generation) {
        // Turned off, or closed, while the port was being bound.
        await closeEndpoint(bound, queue)
        throw refusal("MCP was turned off while it was starting.", 409)
      }
      server = bound
      reason = null
      log(`[designlayer] MCP http://127.0.0.1:${port}/mcp — shared by every app you start here`)
    })()
    opening = { ticket, promise }
    try {
      await promise
    } finally {
      if (opening?.promise === promise) opening = null
    }
  }

  /** Closes the endpoint, or the bind in flight, and hands back the changes still waiting in it. */
  async function letGo() {
    generation += 1
    const current = server
    server = null
    if (current) await closeEndpoint(current, queue)
    const handed = queue.handOff()
    // Resolved ones stay with nobody: the agent already finished them.
    queue.clear()
    return handed
  }

  /**
   * What an editor reads, and the moment the hub tries the port again.
   *
   * The count changes only when an editor starts or stops, so a bind that lost
   * to a briefly busy port would otherwise stay lost until the next one did.
   * Editors in a supervised session never bind the port themselves, so without
   * this retry every one of them would report MCP as off for good. Each read
   * starts at most one quick attempt, and `starting` tells the editor to wait
   * for it.
   */
  function status() {
    if (editors > 0 && !server && !opening && !closed) {
      // Not logged: editors read status every few seconds, and `reason` carries it.
      host(0).catch(() => {})
    }
    return {
      hosting: server !== null,
      // About to host: an editor booting now waits for it rather than racing
      // the screen for the port.
      starting: opening !== null,
      // Editors share it, so no one editor may take it back.
      shared: editors > 0,
      editors,
      url: server ? `http://127.0.0.1:${port}/mcp` : null,
      port: server ? port : null,
      reason: server ? null : reason,
      ...queue.snapshot(),
    }
  }

  return {
    token,

    get hosting() {
      return server !== null
    },

    /** Serve from the start, when the setting was left on. Never throws. */
    async boot() {
      if (!readSetting()) return
      try {
        await host(0)
      } catch (error) {
        log(`[designlayer] MCP not on between apps (${error.message}) — the start screen tries again when an app starts`)
      }
    },

    status,

    /**
     * The start screen's count of live editors, starting or ready.
     *
     * Any editor at all means the screen hosts, so every one of them reaches the
     * same endpoint. Back at zero it keeps hosting; see the top of this file.
     * The retry covers an editor from before this screen still letting the
     * port go. Never throws: a port another program holds is logged, each
     * editor then reports MCP as not running with the reason, and the next
     * editor status read tries again (`status`).
     */
    async editorsChanged(count) {
      editors = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
      if (editors === 0 || server) return
      try {
        await host(MOVE_RETRY_MS)
      } catch (error) {
        log(`[designlayer] MCP not started (${error.message})`)
      }
    },

    /**
     * One send from an editor, read and pushed the way `mcp-control` does it
     * locally. A change that already has an id — one the editor queued before
     * it knew this screen hosts — keeps it.
     */
    push(input) {
      if (!server) throw refusal("MCP isn’t on between apps right now.", 409)
      const waiting = queue.waiting
      const listening = queue.endpointListening
      let id
      if (typeof input?.id === "string" && input.id && !queue.get(input.id)) {
        queue.adopt([input])
        id = input.id
      } else {
        id = queue.push(input).id
      }
      return { id, waiting, listening }
    },

    /**
     * Turns the setting on or off, moving the endpoint with it.
     *
     * On takes the port (the editor has just let it go) and the changes the
     * editor still had waiting; the setting is saved only once the port is
     * ours. Off saves at once, lets the port go and hands the waiting changes
     * back for the editor to serve. Off is refused while editors share the
     * endpoint: moving it into one of them would cut off the rest.
     */
    async stay(on, pending = []) {
      if (!on && editors > 0) {
        throw refusal("Every app you start from the start screen shares this MCP address, so it stays on.", 409)
      }
      if (on) {
        await host(MOVE_RETRY_MS)
        queue.adopt(pending)
        writeSetting(true)
        return status()
      }
      writeSetting(false)
      const handed = await letGo()
      return { ...status(), handed }
    },

    close() {
      closed = true
      return letGo()
    },
  }
}
