/**
 * Opening the editor URL, which is not the URL the vendor would open.
 *
 * The pinned CLI calls `open()` with the proxy port it ASKED for, before the
 * server binds — and the listen patch in launcher.mjs remaps that port whenever
 * the config pins one. So its banner and its browser can both point at a port
 * nothing is serving. The launcher opens the port that was actually bound
 * instead, which is why this exists rather than `--open` being passed through.
 */

import { spawn } from "node:child_process"

const COMMANDS = {
  darwin: (url) => ["open", [url]],
  // `start` treats its first quoted argument as a window title, so it gets an
  // empty one and the URL stays the URL.
  win32: (url) => ["cmd", ["/c", "start", "", url]],
}

export function openBrowser(url) {
  const [command, args] = (COMMANDS[process.platform] ?? ((it) => ["xdg-open", [it]]))(url)
  // Detached and fully ignored: a browser must not keep this process alive, and
  // a box with no browser at all must not take the editor down with it — the
  // URL is on stdout either way.
  const child = spawn(command, args, { stdio: "ignore", detached: true })
  child.once("error", () => {})
  child.unref()
}
