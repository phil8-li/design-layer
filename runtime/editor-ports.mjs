/**
 * The proxy and socket ports each editor gets, remembered per app.
 *
 * The supervisor runs one editor per app at once, so they cannot all take
 * 3456/3457 the way a single editor did. Which pair an app gets is not
 * arbitrary either: the browser keeps notes and settings per origin, and the
 * origin is the proxy's port. An app that came back on a different port each
 * time would come back with its notes gone. So the pair an app was given is
 * written down, keyed by project folder and app port, and handed back the next
 * time that app is started, whenever both ports are still free.
 *
 * A new app gets the first free pair from 3456 upward in steps of two (ws is
 * always proxy + 1), skipping pairs another app has remembered, so starting a
 * new app does not take an old one's origin while it happens to be stopped.
 * Only when every free pair is spoken for does a remembered one get reused.
 *
 * Never throws. A file that cannot be read or written costs the memory, not
 * the launch.
 */

import fs from "node:fs"
import net from "node:net"
import path from "node:path"

import { listEditors } from "./editor-registry.mjs"
import { realRoot, stateRoot, writeFileAtomic } from "./state-dir.mjs"

const FIRST_PROXY_PORT = 3456
const MAX_REMEMBERED_APPS = 200
// Far past any session's worth of editors, and short of the ports above it
// that other tools are known to claim.
const MAX_PAIRS = 200

export function portsFile() {
  return path.join(stateRoot(), "ports.json")
}

function keyFor(projectRoot, appPort) {
  return `${realRoot(projectRoot)}|${appPort}`
}

// The key as it was written before roots were resolved (see `realRoot`), still
// read so a pair remembered then is not lost. Time-boxed legacy: it can go once
// no install from before real-path keys is left.
function rawKeyFor(projectRoot, appPort) {
  return `${projectRoot ?? ""}|${appPort}`
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port < 65536
}

const samePair = (a, b) => a?.proxyPort === b?.proxyPort && a?.wsPort === b?.wsPort

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(portsFile(), "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Remembers `pair` for one app. The file is read again here rather than
 * reused from the start of `allocatePorts`: the port probes in between take
 * milliseconds, and a second supervisor (the desk's start screen beside a
 * terminal `designlayer`) writing in that time would otherwise lose its pair to
 * this write. Read, change one key, rename: the window is this function.
 */
function remember(key, rawKey, pair) {
  const all = readAll()
  delete all[rawKey]
  delete all[key]
  all[key] = pair
  // Insertion order is last use, so the cap drops the apps unused longest.
  const keys = Object.keys(all)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_APPS))) delete all[old]
  try {
    writeFileAtomic(portsFile(), `${JSON.stringify(all, null, 2)}\n`)
  } catch {
    // A file that cannot be written costs the memory, not the launch.
  }
}

// Binds and lets go. Machines without an IPv6 loopback refuse `::1` with one
// of these, which says nothing about whether the port is in use.
function freeOn(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.unref()
    probe.once("error", (error) => resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"))
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })
}

/**
 * Whether a port can be bound on loopback right now, on both loopbacks.
 *
 * The proxy listens on 127.0.0.1, but the browser is sent to `localhost`, and
 * a browser tries `[::1]` first when anything listens there. A dev server
 * bound to the name `localhost` often holds only `::1`, so a port free on
 * 127.0.0.1 alone would put the editor's address in front of that server.
 */
export async function isPortFree(port) {
  return (await freeOn(port, "127.0.0.1")) && (await freeOn(port, "::1"))
}

/** The pair remembered for an app, or null. */
export function rememberedPorts({ projectRoot, appPort }) {
  const all = readAll()
  const entry = all[keyFor(projectRoot, appPort)] ?? all[rawKeyFor(projectRoot, appPort)]
  return validPort(entry?.proxyPort) && validPort(entry?.wsPort) ? { proxyPort: entry.proxyPort, wsPort: entry.wsPort } : null
}

/**
 * The ports for one app's editor: `{ proxyPort, wsPort }`.
 *
 * `taken` holds ports other editors of this supervisor already use, which may
 * not be bound yet while they start. `preferred` is a pair the person asked
 * for with --proxy-port/--ws-port; it replaces 3456/3457 as the first pair
 * tried, and the scan carries on from there.
 *
 * The order is: the flag pair when `explicit` and free, then the pair this app
 * was given before, then the scan. An explicit flag beats memory because it is
 * what the person typed for this run; the supervisor marks only its first
 * editor `explicit`, so later apps keep their remembered origins.
 *
 * The pair handed out is remembered as the app's, with two exceptions. A
 * remembered pair that an editor still holds — one in `taken`, or this same
 * app's editor in the registry (an editor of it that is still shutting down,
 * or one started from another terminal) — stays remembered: this run borrows
 * another pair, and the app's origin, with its notes, is there for the next
 * run. And a pair that is not free at all (nothing was) is never written down.
 */
export async function allocatePorts({ projectRoot = null, appPort = null, taken = [], preferred = null, explicit = false } = {}) {
  const busy = new Set(taken.filter(validPort))
  const all = readAll()
  const key = keyFor(projectRoot, appPort)
  const rawKey = rawKeyFor(projectRoot, appPort)
  const usable = async (pair) =>
    !busy.has(pair.proxyPort) && !busy.has(pair.wsPort) && (await isPortFree(pair.proxyPort)) && (await isPortFree(pair.wsPort))

  const flagPair = explicit && validPort(preferred?.proxyPort)
    ? { proxyPort: preferred.proxyPort, wsPort: validPort(preferred.wsPort) ? preferred.wsPort : preferred.proxyPort + 1 }
    : null
  let chosen = flagPair && (await usable(flagPair)) ? flagPair : null

  const remembered = rememberedPorts({ projectRoot, appPort })
  if (!chosen && remembered && (await usable(remembered))) chosen = remembered

  let free = chosen !== null
  if (!chosen) {
    const others = new Set()
    for (const [other, pair] of Object.entries(all)) {
      if (other === key || other === rawKey) continue
      if (validPort(pair?.proxyPort)) others.add(pair.proxyPort)
      if (validPort(pair?.wsPort)) others.add(pair.wsPort)
    }
    const base = validPort(preferred?.proxyPort) ? preferred.proxyPort : FIRST_PROXY_PORT
    const candidates = []
    for (let index = 0; index < MAX_PAIRS && base + index * 2 + 1 < 65536; index += 1) {
      const proxyPort = base + index * 2
      const wsPort = index === 0 && validPort(preferred?.wsPort) ? preferred.wsPort : proxyPort + 1
      candidates.push({ proxyPort, wsPort })
    }
    for (const pair of candidates) {
      if (others.has(pair.proxyPort) || others.has(pair.wsPort)) continue
      if (await usable(pair)) {
        chosen = pair
        break
      }
    }
    // Every free pair belongs to some other app's memory: borrow one rather
    // than refuse to start.
    if (!chosen) {
      for (const pair of candidates) {
        if (await usable(pair)) {
          chosen = pair
          break
        }
      }
    }
    free = chosen !== null
    // Nothing free at all. The child's own port check then fails with a
    // sentence, which says more than anything this function could.
    chosen ??= candidates[0] ?? { proxyPort: FIRST_PROXY_PORT, wsPort: FIRST_PROXY_PORT + 1 }
  }

  const keepsMemory =
    remembered !== null && !samePair(chosen, remembered) && heldByAnEditor(remembered, busy, projectRoot, appPort)
  if (free && !keepsMemory) remember(key, rawKey, chosen)
  return { proxyPort: chosen.proxyPort, wsPort: chosen.wsPort }
}

/** Whether a live editor holds `pair`: one of the caller's own, or this app's in the registry. */
function heldByAnEditor(pair, busy, projectRoot, appPort) {
  if (busy.has(pair.proxyPort) || busy.has(pair.wsPort)) return true
  const root = realRoot(projectRoot)
  return listEditors().some(
    (editor) => editor.proxyPort === pair.proxyPort && editor.appPort === appPort && realRoot(editor.projectRoot) === root
  )
}
