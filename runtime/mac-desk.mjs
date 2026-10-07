/**
 * Where DesignLayer.app's desk is, when this Mac has one.
 *
 * The Mac app (desktop/mac) is a Chrome-installed window served by a loopback
 * "desk" server that a LaunchAgent keeps running. The chrome in a browser tab
 * offers "Open in Mac app" only where there is an app to open in, and the
 * launcher is the side that can tell without touching the network: the
 * installer writes the LaunchAgent's plist, the uninstaller removes it, so the
 * plist is on disk for exactly as long as the app is installed.
 *
 * The page could ask the desk itself instead. It would get the same answer on
 * this Mac and, on every machine without the app — most of the machines this
 * chrome is injected on — print a refused connection into the console of
 * somebody else's product on every load.
 *
 * The label and the default port live here, not in desktop/mac, because this
 * directory ships in the package and that one does not: the desk imports them
 * from here, and the dependency cannot point the other way.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const DESK_LABEL = "dev.designlayer.desk"
export const DEFAULT_DESK_PORT = 3454

export function deskPlistPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${DESK_LABEL}.plist`)
}

/**
 * The desk's origin, or null when this machine has no Mac app installed.
 *
 * The port is read out of the plist rather than this process's environment:
 * `DESIGNLAYER_DESK_PORT` is set on the LaunchAgent, which is the process that
 * binds it, and the installer writes the key only when the port is not the
 * default (desktop/mac/launch-agent.mjs `buildPlist`).
 */
export function deskUrlFromHost({ platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== "darwin") return null
  let plist
  try {
    plist = fs.readFileSync(deskPlistPath(home), "utf8")
  } catch {
    return null
  }
  const port = Number(/<key>DESIGNLAYER_DESK_PORT<\/key>\s*<string>(\d+)<\/string>/.exec(plist)?.[1])
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_DESK_PORT}`
}
