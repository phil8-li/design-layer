/**
 * Getting the host app running before the editor attaches to it.
 *
 * The vendored CLI health-checks the app port and refuses to boot when nothing
 * answers, so until now the app had to be started by hand in another terminal
 * and the editor command was useless until that one was warm. This module is
 * what collapses the two into one: probe the port, attach silently if something
 * already answers, otherwise run the host's OWN dev script and wait for it.
 *
 * It guesses nothing on the host's behalf. The script is the host's own, so
 * whatever that script already does keeps happening.
 *
 * `portFlag` and `hostFlag` are the exception, and they are passed in rather
 * than decided here. Neither `vite` nor `ng serve` reads `PORT`, and both
 * default to binding `localhost` — which on an IPv6-first machine is `[::1]`
 * and not `127.0.0.1`, so the app comes up perfectly and the caller, probing
 * `127.0.0.1`, never sees it. Which flags a host takes is a property of its
 * framework, which the resolved config already knows; this module appends them.
 */

import net from "node:net"
import { spawn } from "node:child_process"

/** How often the port is re-probed while the app boots. */
const POLL_MS = 250

/**
 * How long to wait with NO sign of life before giving up, and the ceiling on
 * the whole wait however lively it is.
 *
 * A single fixed deadline was the wrong shape and 60 seconds was the wrong
 * number. Measured: a real Angular app's first `ng serve` compiled forty lazy
 * chunks and bound its port a little past the minute, so the launcher killed a
 * dev server that was visibly working and reported that the script "did not
 * answer" — the one explanation that was not true.
 *
 * The honest question is not "has a minute passed" but "is this still going".
 * A build printing chunk names is going; a script that has said nothing for a
 * minute and a half has hung or is waiting on a prompt nobody can see. The
 * ceiling is what stops a watcher that chatters forever without ever listening
 * from holding the terminal open all afternoon.
 */
const QUIET_TIMEOUT_MS = 90_000
const MAX_WAIT_MS = 10 * 60_000

/** Resolves true when something accepts a TCP connection on the port. */
export function probePort(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (answered) => {
      socket.destroy()
      resolve(answered)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
    socket.connect(port, host)
  })
}

/**
 * Loopback has two addresses, and a dev server the designer started themselves
 * is quite often on only one of them.
 *
 * `vite` and `ng serve` both default to binding the NAME `localhost`, which on
 * a machine whose resolver answers AAAA first is `[::1]` and nothing on
 * `127.0.0.1` — measured: `npm start` in a stock Angular project answers
 * `http://[::1]:4200` and refuses `http://127.0.0.1:4200`. Everything in this
 * package assumed the v4 address, so that app was invisible to the start
 * screen's scan and unreachable by the proxy, and the designer's only recourse
 * was to restart their own dev server with a flag they had to know about.
 *
 * v4 first, so a server bound to both keeps the address every other part of
 * this tool has always used.
 */
export const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"]

/**
 * Which loopback address is actually serving `port`, or null when neither is.
 *
 * Probed in parallel: a refused connection on loopback is instant, but a
 * machine with no IPv6 stack can leave the second probe to time out, and paying
 * that serially would double the wait for every port the start screen scans.
 */
export async function loopbackHostFor(port, timeoutMs = 500) {
  const answers = await Promise.all(
    LOOPBACK_ADDRESSES.map((host) => probePort(host, port, timeoutMs))
  )
  const index = answers.indexOf(true)
  return index === -1 ? null : LOOPBACK_ADDRESSES[index]
}

/**
 * A host as it must appear inside a URL. An IPv6 literal needs brackets —
 * `http://::1:4200` is not a URL — and everything downstream of here builds
 * one: this package's error messages, the vendored CLI's health check, and the
 * proxy target it hands to `http-proxy`. The socket form is what `net.connect`
 * wants, so the two cannot be the same string.
 */
export function urlHost(host) {
  return String(host).includes(":") ? `[${host}]` : String(host)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** npm ships as a shell shim on Windows, which `spawn` will not find unsuffixed. */
const npmCommand = () => (process.platform === "win32" ? "npm.cmd" : "npm")

/**
 * The dev server's output, line-prefixed so one terminal can carry both halves.
 *
 * Buffered to the newline rather than written per chunk: a framework that
 * prints its banner in three writes would otherwise get three prefixes in the
 * middle of one line.
 */
function relay(stream, write, onOutput = () => {}) {
  let carry = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk) => {
    onOutput()
    const lines = (carry + chunk).split("\n")
    carry = lines.pop() ?? ""
    for (const line of lines) write(`  [app] ${line}\n`)
  })
}

const describeExit = ({ code, signal }) =>
  signal ? `killed by ${signal}` : `exit code ${code}`

/**
 * Attach to the app on `port`, starting `npm run <script>` first if nothing is
 * listening. Returns `{ started, stop }` — `started` is false when it attached
 * to a server someone else owns, and `stop` is a no-op in that case, because a
 * process this one did not start is not this one's to kill.
 */
export async function ensureAppRunning({
  projectRoot,
  host,
  port,
  script,
  portFlag = null,
  hostFlag = null,
  timeoutMs = QUIET_TIMEOUT_MS,
  maxWaitMs = MAX_WAIT_MS,
  log = console.log,
}) {
  // Both loopback addresses, not just the one we would have asked for. A
  // designer who already has `npm start` running has an app on whichever
  // address their own script chose — usually `[::1]` — and probing only v4
  // would conclude nothing was there and start a SECOND dev server beside the
  // first, on the same port and a different address. Attaching to what is
  // already up is the whole point of this check.
  const running = await loopbackHostFor(port)
  if (running) {
    log(`[designlayer] app already running on http://${urlHost(running)}:${port}`)
    return { started: false, stop: () => {}, child: null, host: running }
  }

  // `npm run <script> -- <args>` is how npm forwards arguments into the script,
  // so the flags reach `ng serve` rather than npm. A script that already names
  // a port keeps its own flag too; the CLI takes the last one, which is ours.
  const flags = [
    ...(hostFlag ? [hostFlag, host] : []),
    ...(portFlag ? [portFlag, String(port)] : []),
  ]
  const forwarded = flags.length ? ["--", ...flags] : []
  const command = `npm run ${script}${forwarded.length ? ` ${forwarded.join(" ")}` : ""}`
  log(`[designlayer] starting your app: ${command}`)
  const child = spawn(npmCommand(), ["run", script, ...forwarded], {
    cwd: projectRoot,
    // Set for every host, flags or not. Create React App takes no flags and
    // reads exactly these two; for the others they are a harmless second way of
    // saying what the command line already says.
    env: { ...process.env, PORT: String(port), HOST: host },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so `stop` can take the whole `npm` -> `next` chain
    // down. Killing the npm shim alone orphans the server that holds the port,
    // and the next run would attach to a stale build.
    detached: process.platform !== "win32",
  })
  // Any output at all counts as progress. Not parsed for a "ready" line: every
  // framework spells that differently and a version bump rewords it, whereas
  // "the build is still talking" is true of all of them.
  let lastOutputAt = Date.now()
  const sawOutput = () => {
    lastOutputAt = Date.now()
  }
  relay(child.stdout, (text) => process.stdout.write(text), sawOutput)
  relay(child.stderr, (text) => process.stderr.write(text), sawOutput)

  let exited = null
  child.once("exit", (code, signal) => {
    exited = { code, signal }
  })
  child.once("error", (error) => {
    exited = { code: null, signal: null, message: error.message }
  })

  let stopped = false
  const stop = () => {
    if (stopped || exited) return
    stopped = true
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM")
      else child.kill("SIGTERM")
    } catch {
      // Already gone. Nothing to clean up.
    }
  }

  // Polled on the asked-for host AND both loopbacks, for the reason the check
  // above probes both: a host with no host flag (`unknown`, CRA) runs a script
  // that binds `localhost`, which is `[::1]` here, and polling only `host` never
  // saw it — the server came up, went quiet, and was killed as hung. The
  // address that answered is the one reported.
  let found = null
  const startedAt = Date.now()
  for (;;) {
    if (exited) {
      throw new Error(
        `\`${command}\` ${exited.message ?? describeExit(exited)} before anything answered on port ${port}`
      )
    }
    const [onHost, onLoopback] = await Promise.all([probePort(host, port), loopbackHostFor(port)])
    found = onHost ? host : onLoopback
    if (found) break

    const quietFor = Date.now() - lastOutputAt
    const waitedFor = Date.now() - startedAt
    if (quietFor > timeoutMs || waitedFor > maxWaitMs) {
      stop()
      const seconds = (ms) => Math.round(ms / 1000)
      throw new Error(
        quietFor > timeoutMs
          ? `\`${command}\` has said nothing for ${seconds(quietFor)}s and nothing is listening on port ${port}`
          : `\`${command}\` is still running after ${seconds(waitedFor)}s and has not bound port ${port}`
      )
    }
    await delay(POLL_MS)
  }

  log(`[designlayer] app ready on http://${urlHost(found)}:${port}`)
  return { started: true, stop, child, host: found }
}
