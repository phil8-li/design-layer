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

// DESIGNLAYER_DESK_LABEL runs a second desk beside the installed one, under a
// LaunchAgent of its own, so a test can restart it without touching the app.
export const DESK_LABEL = process.env.DESIGNLAYER_DESK_LABEL || "dev.designlayer.desk"
export const DEFAULT_DESK_PORT = 3454

export function deskPlistPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${DESK_LABEL}.plist`)
}

/**
 * The two facts the desk's LaunchAgent plist carries for this package, or null
 * when this machine has no Mac app installed (the plist is written by the
 * installer and removed by the uninstaller, so its presence is the answer):
 *
 * - `port`: `DESIGNLAYER_DESK_PORT`, set on the LaunchAgent, which is the
 *   process that binds it. The installer writes the key only when the port is
 *   not the default (desktop/mac/launch-agent.mjs `buildPlist`), so a plist
 *   without it means `DEFAULT_DESK_PORT`.
 * - `workingDirectory`: the folder the desk runs from, unescaped from the
 *   plist's XML; null when the plist names none.
 *
 * Read with patterns rather than a plist parser: the installer writes this file
 * and its shape is ours.
 */
export function readDeskPlist({ platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== "darwin") return null
  let plist
  try {
    plist = fs.readFileSync(deskPlistPath(home), "utf8")
  } catch {
    return null
  }
  const string = (key) => new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1] ?? null
  const port = Number(string("DESIGNLAYER_DESK_PORT"))
  const dir = string("WorkingDirectory")
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_DESK_PORT,
    workingDirectory: dir === null ? null : unescapeXml(dir),
  }
}

const unescapeXml = (value) =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")

/**
 * The desk's origin, or null when this machine has no Mac app installed.
 *
 * The port is read out of the plist rather than this process's environment;
 * see `readDeskPlist`.
 *
 * On localhost, though the desk binds 127.0.0.1: the app window is served
 * from there, so it is same-site with the editors it frames, which are on
 * localhost too. Across sites, a frame gets no SameSite=Lax cookie and an app
 * with cookie sign-in shows its signed-out screen.
 */
export function deskUrlFromHost(where = {}) {
  const desk = readDeskPlist(where)
  return desk ? `http://localhost:${desk.port}` : null
}
