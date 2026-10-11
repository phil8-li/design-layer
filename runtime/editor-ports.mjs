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

import { registryDir } from "./editor-registry.mjs"

export const FIRST_PROXY_PORT = 3456
const MAX_ENTRIES = 200
// Far past any session's worth of editors, and short of the ports above it
// that other tools are known to claim.
const MAX_PAIRS = 200

export function portsFile() {
  return path.join(path.dirname(registryDir()), "ports.json")
}

/*
 * One project has many spellings: a symlinked folder, a trailing slash, a
 * relative path. The supervisor, the start screen and each editor's config all
 * name the root their own way, so the key is the real folder or none of them
 * would find what another wrote. A folder that cannot be resolved (gone, or
 * one macOS will not stat) keeps its resolved spelling.
 */
export function realRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return ""
  try {
    return fs.realpathSync(projectRoot)
  } catch {
    return path.resolve(projectRoot)
  }
}

function keyFor(projectRoot, appPort) {
  return `${realRoot(projectRoot)}|${appPort}`
}

// The key as it was written before roots were resolved, still read so a pair
// remembered then is not lost.
function rawKeyFor(projectRoot, appPort) {
  return `${projectRoot ?? ""}|${appPort}`
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port < 65536
}

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(portsFile(), "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(all) {
  const file = portsFile()
  const temp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, "utf8")
    fs.renameSync(temp, file)
  } catch {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      /* nothing else to try */
    }
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
    // Nothing free at all. The child's own port check then fails with a
    // sentence, which says more than anything this function could.
    chosen ??= candidates[0] ?? { proxyPort: FIRST_PROXY_PORT, wsPort: FIRST_PROXY_PORT + 1 }
  }

  delete all[rawKey]
  delete all[key]
  all[key] = chosen
  // Insertion order is last use, so the cap drops the apps unused longest.
  const keys = Object.keys(all)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[old]
  writeAll(all)
  return { proxyPort: chosen.proxyPort, wsPort: chosen.wsPort }
}
