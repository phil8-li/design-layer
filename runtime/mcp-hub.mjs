/**
 * The start screen's MCP endpoint, for "Stay on between apps".
 *
 * Off by default, and then this does nothing: each editor serves MCP itself.
 * On, the start screen serves it on the same fixed port and keeps serving it
 * while editors come and go, so an agent's connection survives switching or
 * restarting apps. Editors reach it through three token-guarded start screen
 * routes (see `runtime/start-screen.mjs`) by way of `server/mcp-control.mjs`.
 *
 * The setting lives here, in one small file outside any project: it belongs to
 * the machine's start screen, not to an app, and it has to be read before any
 * editor exists.
 */

import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DEFAULT_CONFIG } from "../config.mjs"
import { createHandoffQueue } from "../server/handoff.mjs"
import { closeEndpoint, openEndpoint } from "../server/mcp.mjs"

/** Long enough for an editor to let the port go; see `openEndpoint`. */
const MOVE_RETRY_MS = 1500

/** Beside the editor registry, in the per-user state this package already keeps. */
export function mcpSettingsFile() {
  return path.join(os.homedir(), ".local", "state", "designlayer", "mcp.json")
}

function refusal(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
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
  let server = null

  function readSetting() {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"))?.stayBetweenApps === true
    } catch {
      return false
    }
  }

  function writeSetting(on) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify({ stayBetweenApps: on })}\n`, "utf8")
    } catch (error) {
      log(`[designlayer] could not save the MCP setting (${error.message})`)
    }
  }

  async function host(retryMs) {
    if (server) return
    try {
      server = await openEndpoint({ queue, isLocalRequest, port, retryMs })
    } catch (error) {
      throw refusal(
        error?.code === "EADDRINUSE" ? `Another program is using port ${port}.` : error.message,
        409
      )
    }
    log(`[designlayer] MCP http://127.0.0.1:${port}/mcp — on between apps`)
  }

  /** Closes the endpoint and hands back the changes still waiting in it. */
  async function letGo() {
    const waiting = queue.pending()
    if (server) await closeEndpoint(server, queue)
    server = null
    queue.clear()
    return waiting
  }

  function status() {
    return {
      hosting: server !== null,
      url: server ? `http://127.0.0.1:${port}/mcp` : null,
      port: server ? port : null,
      listening: queue.endpointListening,
      agents: queue.attachedAgents,
      waiting: queue.waiting,
      pending: queue.list("pending").length,
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
        log(`[designlayer] MCP not on between apps (${error.message}) — each editor serves its own`)
      }
    },

    status,

    /** One send from an editor, read and pushed the way `mcp-control` does it locally. */
    push(input) {
      if (!server) throw refusal("MCP isn’t on between apps right now.", 409)
      const waiting = queue.waiting
      const listening = queue.endpointListening
      const entry = queue.push(input)
      return { id: entry.id, waiting, listening }
    },

    /**
     * Turns the setting on or off, moving the endpoint with it.
     *
     * On takes the port (the editor has just let it go) and the changes the
     * editor still had waiting; the setting is saved only once the port is
     * ours. Off saves at once, lets the port go and hands the waiting changes
     * back for the editor to serve.
     */
    async stay(on, pending = []) {
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
      return letGo()
    },
  }
}
