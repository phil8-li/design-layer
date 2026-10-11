#!/usr/bin/env node

/**
 * `designlayer [appPort] [--config <path>] [--proxy-port N] [--ws-port N]`
 *
 * Every flag is consumed here. The vendored CLI parses `process.argv` at module
 * scope with commander and aborts on anything it does not declare, so argv is
 * rewritten into exactly its shape before it is imported — that reshape is what
 * makes first-party flags possible at all.
 *
 * With the start screen, this command runs in one of two roles. The SUPERVISOR
 * owns the chooser for the whole session and never boots an editor itself; each
 * app the user picks is a CHILD of it, started by re-running this same file with
 * `--no-start` and a port. The two are the same code because they are the same
 * command; `wantsStartScreen` is the whole fork.
 */

import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { appName } from "./runtime/app-name.mjs"
import { findConfigFile } from "./runtime/config-file.mjs"

/*
 * Sixteen file-system threads instead of libuv's four, unless the person
 * running this chose a number. The editor's server reads whole projects — the
 * page list, a component's usages, the lint tools — and a first read of a few
 * thousand small files is bound by how many opens run at once: measured on
 * 1,500 files, ~32ms on four threads, ~19ms on sixteen. Set before anything
 * here touches the pool, which is created on first use.
 */
process.env.UV_THREADPOOL_SIZE ??= "16"

// config.mjs, the dev-server helpers and the browser opener are loaded where
// they are used rather than here. A bare `designlayer` is the start screen, and
// the start screen answers its first page in the time Node takes to bind a
// port plus a few milliseconds — config.mjs alone was more than that.

const USAGE = `Usage: designlayer [appPort] [options]

  (no arguments)          Open the start screen: pick a running app and its folder
  appPort                 Dev server port (default: config app.port, else framework detection)
  --start / --no-start    Force or skip the start screen (default: when no port is known)
  --dev                   Start the app's dev server too, and attach when it is up
  --dev-script <name>     npm script --dev runs (default: config app.devScript, "dev")
  --config <path>         Config file (default: nearest designlayer.config.mjs above cwd)
  --project-root <path>   Project the config loads against (default: the current folder)
  --start-screen-port <n> Port for the start screen (default: 3455, else any free port)
  --proxy-port <n>        Port for the editing proxy the browser loads
  --ws-port <n>           Port for the source-edit WebSocket
  --host <host>           Dev server host (default: 127.0.0.1)
  --open / --no-open      Open the editing URL on start (default: no)
  --verify                Check the vendor patch still applies, then exit
  --print-config          Print the resolved config as JSON, then exit
  --help
`

/** This file, as the supervisor has to name it when it re-runs it as a child. */
const CLI_PATH = fileURLToPath(import.meta.url)

/**
 * The port `--dev` falls back to when nothing else names one.
 *
 * The last resort, not the answer. `config.app.devPort` knows the host's
 * framework and reads an Angular project's own `angular.json`, and that is what
 * `main` reaches for first; a dev server still has to be told a port before it
 * can be asked which one it took, so a guess is unavoidable — this is only the
 * guess for a config object that carries no framework at all.
 */
const DEFAULT_APP_PORT = 3000

/** How long a child asked to stop gets before SIGKILL. See `runEditors`. */
const STOP_GRACE_MS = 5000

export function parseArgs(argv) {
  const options = {
    open: undefined,
    start: undefined,
    dev: false,
    verify: false,
    printConfig: false,
    verbose: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      index += 1
      return value
    }

    if (arg === "--config") options.configPath = next()
    else if (arg === "--project-root") options.projectRoot = next()
    else if (arg === "--start-screen-port") options.startScreenPort = Number(next())
    else if (arg === "--dev") options.dev = true
    // Naming the script is asking for it to be run, so it implies the flag.
    else if (arg === "--dev-script") {
      options.devScript = next()
      options.dev = true
    }
    else if (arg === "--proxy-port") options.proxyPort = Number(next())
    else if (arg === "--ws-port") options.wsPort = Number(next())
    else if (arg === "--host") options.host = next()
    else if (arg === "--no-open") options.open = false
    else if (arg === "--open") options.open = true
    else if (arg === "--no-start") options.start = false
    else if (arg === "--start") options.start = true
    else if (arg === "--verbose") options.verbose = true
    else if (arg === "--verify") options.verify = true
    else if (arg === "--print-config") options.printConfig = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else if (/^\d+$/.test(arg)) options.appPort = Number(arg)
    else throw new Error(`Unknown option: ${arg}`)
  }

  return options
}

/**
 * An explicitly configured port that is already taken must stop the launch. The
 * vendor's own probe would silently walk to the next free port instead, and a
 * second editor answering on a port the host wrote down is worse than no start.
 */
function assertPortFree(port, label) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", (error) =>
      reject(
        new Error(
          error.code === "EADDRINUSE"
            ? `${label} port ${port} is already in use`
            : `${label} port ${port} is unusable: ${error.message}`
        )
      )
    )
    probe.once("listening", () => probe.close(() => resolve()))
    probe.listen(port, "127.0.0.1")
  })
}

/**
 * The start screen is the default way in, and the flags are how to say
 * otherwise. It is skipped the moment the command already knows which app it is
 * for — a port on the line, a port in the config, or `--dev` — because at that
 * point a screen asking which app would be asking a question already answered.
 */
function wantsStartScreen(options, config) {
  if (options.start !== undefined) return options.start
  return !options.dev && options.appPort === undefined && config.app.port === null
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }

  /*
   * The start screen without a config, when there is no config to load.
   *
   * The only thing the screen's role takes from a config is `app.port`, the
   * one answer that skips the chooser; resolving the rest — design system,
   * icons, companions, the host's framework — is for an editor this process
   * never boots. With no file at or above the folder, every one of those is a
   * default, and a default `app.port` is null, so the answer is already known.
   * A config that exists is still loaded in full below, so one that names a
   * port, or one that is broken, behaves exactly as it always has.
   */
  if (
    !options.printConfig &&
    !options.verify &&
    wantsStartScreen(options, { app: { port: null } }) &&
    options.configPath === undefined &&
    findConfigFile(options.projectRoot ?? process.cwd()) === null
  ) {
    return supervise(options)
  }

  const overrides = {
    app: { port: options.appPort, host: options.host, open: options.open },
    ports: { proxy: options.proxyPort, ws: options.wsPort },
  }
  const [{ loadConfig }, devServer] = await Promise.all([
    import("./config.mjs"),
    import("./runtime/dev-server.mjs"),
  ])
  const { ensureAppRunning, loopbackHostFor, urlHost } = devServer
  /*
   * `--project-root` rather than a working directory. A child spawned with
   * `cwd: projectRoot` cannot read its own cwd back when that folder is one
   * macOS protects — `chdir` succeeds and every later `process.cwd()` fails
   * with EPERM — so the root travels as an argument the child never has to ask
   * the OS about.
   */
  const config = await loadConfig({
    cwd: options.projectRoot,
    configPath: options.configPath,
    overrides,
  })

  if (options.printConfig) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
    return
  }

  if (options.verify) {
    // Loaded here and at the launch below, not up top: importing the launcher
    // is a third of this file's startup, and the start screen — the process a
    // bare `designlayer` runs — never launches an editor itself.
    const [{ readOverlaySource, resolveVendor }, { patchOverlay }] = await Promise.all([
      import("./runtime/launcher.mjs"),
      import("./runtime/vendor-patch.mjs"),
    ])
    const source = readOverlaySource(config)
    const patched = patchOverlay(source, config)
    console.log("PASS React Rewrite overlay patch compatibility")
    // A hoisted or symlinked install resolves outside the project, where a
    // relative path reads as a stack of `../` and hides which copy was checked.
    const overlay = resolveVendor(config).overlay
    const inProject = overlay.startsWith(`${config.projectRoot}${path.sep}`)
    console.log(`Checked: ${inProject ? path.relative(config.projectRoot, overlay) : overlay}`)
    console.log(`Config: ${config.configPath ?? "defaults (no designlayer.config.mjs found)"}`)
    console.log(`Patched bundle: ${source.length} -> ${patched.length} bytes`)
    return
  }

  /*
   * The start screen answers the three questions this command used to require
   * on the line — which app, which folder, and whether to start it — from a
   * page, before anything else has bound a port. Answering them is a job of its
   * own: nothing below this line runs in the process that serves it.
   */
  if (wantsStartScreen(options, config)) return supervise(options)
  // Loading from here on, beside the port checks and the app probe, rather than
  // at the top of the file, where the start screen paid for it too.
  const launcherReady = import("./runtime/launcher.mjs")

  // With `--dev` the port can no longer be left to the vendor's framework
  // detection: a dev server has to be told one before it can be asked.
  const appPort =
    options.appPort ??
    config.app.port ??
    (options.dev ? config.app.devPort ?? DEFAULT_APP_PORT : null)
  const devScript = options.dev ? options.devScript ?? config.app.devScript : null

  // The app probe below starts now, beside the port checks: it is a loopback
  // round trip with nothing to wait for from them. The checks themselves stay
  // one after another, so a ws and proxy port configured alike do not fail
  // each other's probe.
  const appProbe = devScript === null && appPort !== null ? loopbackHostFor(appPort) : null
  for (const [port, label] of [
    [config.ports.ws, "WebSocket"],
    [config.ports.proxy, "Proxy"],
  ]) {
    if (port !== "auto") await assertPortFree(port, label)
  }

  /*
   * The address the app is actually on, which is not always the one asked for.
   *
   * A server this command starts is told `--host`, so it lands where it was
   * sent. A server the DESIGNER started is wherever their own dev script put
   * it, and `vite` and `ng serve` both default to the name `localhost` — which
   * on an IPv6-first machine is `[::1]` and nothing on `127.0.0.1`. Attaching
   * to the address we wanted rather than the one answering is how a running,
   * working app came back as "nothing is listening".
   *
   * Only ever a loopback address either way: this is a resolution among the
   * two, not a widening.
   */
  let appHost = config.app.host

  if (devScript !== null) {
    const app = await ensureAppRunning({
      projectRoot: config.projectRoot,
      host: config.app.host,
      port: appPort,
      script: devScript,
      // Angular's `ng serve` ignores PORT and reads `--port`; neither it nor
      // Vite binds 127.0.0.1 unless told. Which flags (if any) a host needs is
      // a property of its framework, resolved once in the config.
      portFlag: config.app.devPortFlag,
      hostFlag: config.app.devHostFlag,
    })
    if (app.started) holdUntilExit(app.stop)
    // `ensureAppRunning` reports the address it found or reached — a script
    // that ignored the host flag, or that had none, may still have gone to the
    // other one, and an app it attached to rather than started is wherever the
    // designer's own command put it.
    appHost = app.host ?? (await loopbackHostFor(appPort)) ?? config.app.host
  } else if (appPort !== null) {
    const found = await appProbe
    if (!found) {
      // The vendor's own health check fails here too, but it fails from inside
      // a banner that has already claimed to be starting, and it does not know
      // that starting the app is something this command can do.
      throw new Error(
        `Nothing is listening on http://${urlHost(config.app.host)}:${appPort}.\n` +
          `  Start your dev server first, or run with --dev to start it here.`
      )
    }
    if (found !== config.app.host) {
      // Said out loud. It is the difference between the editor proxying the app
      // and proxying nothing, and a silent correction is impossible to debug
      // when some later thing goes wrong for an unrelated reason.
      console.log(
        `[designlayer] your app is on http://${urlHost(found)}:${appPort} — attaching there`
      )
    }
    appHost = found
  }

  const { launch } = await launcherReady
  await launch(config, {
    appPort,
    host: appHost,
    open: config.app.open,
    verbose: options.verbose,
    /*
     * How a supervised child tells its parent where the editor is. `process.send`
     * exists only when this process was spawned with an IPC channel, so an
     * ordinary run passes a function that does nothing.
     *
     * IPC rather than the endpoint file: that file is written inside the
     * project folder, and the write fails outright on the folders macOS
     * protects — which is where a great many people keep their projects. The
     * proxy comes up fine there; only the note about it does not.
     */
    onReady: (url) => process.send?.({ type: "ready", url }),
  })
}

/**
 * The supervisor: the chooser is the session, and each chosen app is a process
 * under it.
 *
 * A fresh process per app is not ceremony. The vendored CLI is a one-shot
 * `await import(...)` that reads the project root, the source roots, the routes
 * and the browser prelude at module scope, and it binds 3456/3457 as it goes.
 * There is no in-process way to point it at a second app, so switching apps
 * means a second process — and the only honest way to have a chooser that
 * outlives the choice is for the chooser not to be in that process at all.
 *
 * Many children at once, one per app. See `runEditors`.
 */
async function supervise(options) {
  // Imported here, not at the top: the screen's page and styles are ~1,700
  // lines that every editor launch — the supervisor's children included —
  // would otherwise parse before binding anything, for a screen only this
  // role serves.
  const { createStartScreen } = await import("./runtime/start-screen.mjs")
  // `mcp: {}` lets this screen serve MCP between apps when the designer turns
  // that on. It is the only screen that outlives its editors.
  const screen = await createStartScreen({ port: options.startScreenPort, mcp: {} })
  holdUntilExit(screen.close)

  const { allocatePorts } = await import("./runtime/editor-ports.mjs")
  const editors = runEditors(screen, { options, allocatePorts })
  // Ctrl+C here is Ctrl+C for every editor too. Each child is a process of its
  // own, so nothing takes them down on the way out unless this line does.
  holdUntilExit(editors.killAll)

  console.log(`[designlayer] open ${screen.url} to choose an app`)
  if (options.open !== false) {
    const { openBrowser } = await import("./runtime/open-browser.mjs")
    openBrowser(screen.url)
  }

  await editors.done
}

/**
 * The supervisor's loops over a start screen, apart from the process plumbing
 * so a test can drive them with fake children (`spawnEditor`) and fake ports
 * (`allocatePorts`).
 *
 * It used to run one editor and kill it on every choice. In the Mac app, a tab
 * per editor, that meant opening a second app in a new tab killed the first
 * app's editor under the tab still showing it. Now each choice is a child of
 * its own, on its own proxy and socket ports, and a child ends only when:
 * Stop asks for it (`screen.nextStop()`), it exits by itself, a choice
 * replaces it (`choice.replaces`: same app port, another folder), or the
 * supervisor exits (`killAll`).
 *
 * Choices are handled one at a time, so two arriving together cannot be given
 * the same ports before either child has bound them.
 */
export function runEditors(
  screen,
  { options = {}, spawnEditor = spawnChild, allocatePorts, log = console.log, stopGraceMs = STOP_GRACE_MS } = {}
) {
  const running = new Map()
  const cancelled = new Set()
  // The flag pair beats the first editor's remembered pair, and only the
  // first's. See `allocatePorts`.
  let flagsSpent = false

  /*
   * An exit asked for is not news: the screen already holds the reason, or
   * the replacement already took the editor's place.
   *
   * Every later start waits on this, so a child that ignores SIGTERM (a stuck
   * dev server, a busy event loop) would hold every app behind it. It gets a
   * few seconds to close its servers, then SIGKILL.
   */
  async function stop(entry) {
    entry.quiet = true
    entry.child.kill("SIGTERM")
    const escalate = setTimeout(() => entry.child.kill("SIGKILL"), stopGraceMs)
    try {
      await entry.exited
    } finally {
      clearTimeout(escalate)
    }
  }

  async function start(choice) {
    // Stopped or replaced from the screen while still in the queue.
    if (cancelled.delete(choice.id)) return
    const displaced = choice.replaces ? running.get(choice.replaces) : null
    // Waiting frees the app's old ports and its source writes before the
    // replacement comes up.
    if (displaced) await stop(displaced)
    const taken = [...running.values()].flatMap((entry) => [entry.ports.proxyPort, entry.ports.wsPort])
    const preferred = options.proxyPort
      ? { proxyPort: options.proxyPort, wsPort: options.wsPort ?? options.proxyPort + 1 }
      : null
    const explicit = preferred !== null && !flagsSpent
    flagsSpent = true
    const ports = await allocatePorts({ projectRoot: choice.projectRoot, appPort: choice.appPort, taken, preferred, explicit })
    // Stopped from the screen before it ever had a process.
    if (cancelled.delete(choice.id)) return
    const entry = startEditor(options, choice, screen, { ports, spawnEditor, log })
    running.set(choice.id, entry)
    entry.exited.then(() => {
      if (running.get(choice.id) === entry) running.delete(choice.id)
    })
  }

  async function choiceLoop() {
    for (;;) {
      let choice
      try {
        choice = await screen.nextChoice()
      } catch {
        // `close()` rejects the ask nobody answered — the process is exiting.
        return
      }
      try {
        await start(choice)
      } catch (error) {
        screen.reportStopped(
          `The editor for ${appName(choice)} could not start (${error.message}). Pick an app below to try again.`,
          choice.id
        )
      }
    }
  }

  async function stopLoop() {
    for (;;) {
      let request
      try {
        request = await screen.nextStop()
      } catch {
        return
      }
      const entry = running.get(request.id)
      if (entry) void stop(entry)
      else cancelled.add(request.id)
    }
  }

  return {
    running,
    done: Promise.all([choiceLoop(), stopLoop()]).then(() => {}),
    /** Synchronous, because it runs from the process's `exit` handler. */
    killAll() {
      for (const entry of running.values()) {
        entry.quiet = true
        entry.child.kill("SIGTERM")
      }
    },
  }
}

/** The argv that turns this command into the single-app child of a supervisor. */
export function childArgv(options, choice, ports = {}) {
  return [
    CLI_PATH,
    "--project-root",
    choice.projectRoot,
    // The chooser is the parent's, and there is only one of it.
    "--no-start",
    // The tab that pressed Start moves itself to the editor. A window opened
    // from here would be the same page a second time, one of them orphaned.
    "--no-open",
    String(choice.appPort),
    ...(choice.devScript ? ["--dev-script", choice.devScript] : []),
    // Every child is told its pair. Left to the vendor, each would take
    // 3456/3457 or wander to whatever was next, and an app's notes live under
    // its proxy's origin. A supervisor's own flags are only the first pair.
    ...(ports.proxyPort ?? options.proxyPort ? ["--proxy-port", String(ports.proxyPort ?? options.proxyPort)] : []),
    ...(ports.wsPort ?? options.wsPort ? ["--ws-port", String(ports.wsPort ?? options.wsPort)] : []),
    ...(options.host ? ["--host", options.host] : []),
    ...(options.configPath ? ["--config", options.configPath] : []),
    ...(options.verbose ? ["--verbose"] : []),
  ]
}

/**
 * The sentence the chooser shows where the editor used to be.
 *
 * All three end by naming the next action, and the crash case used not to. It
 * said where the output was and stopped there — which is the one of the three
 * where the reader most needs telling that the screen in front of them still
 * works, because the other two are things they did on purpose and this is not.
 */
function farewell(choice, code, signal) {
  const name = appName(choice)
  if (signal) return `The editor for ${name} was stopped (${signal}). Choose an app to start again.`
  if (code === 0) return `The editor for ${name} closed. Choose an app to start again.`
  return (
    `The editor for ${name} stopped with code ${code}. Its output is in the terminal ` +
    "running designlayer. Pick an app below to try again."
  )
}

/** The production `spawnEditor`: this same file, re-run as one app's editor. */
function spawnChild(argv, env) {
  return spawn(process.execPath, argv, {
    // The child's banner and the app's compile output are what the person in
    // the terminal came to read, so they stay on the terminal unedited. The
    // fourth stream is the IPC channel `onReady` answers on.
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    // Deliberately no `cwd`. See `--project-root`.
    env,
  })
}

function startEditor(options, choice, screen, { ports, spawnEditor = spawnChild, log = console.log } = {}) {
  const child = spawnEditor(childArgv(options, choice, ports), {
    ...process.env,
    DESIGNLAYER_CHOOSER_URL: screen.url,
    ...(screen.mcpToken ? { DESIGNLAYER_MCP_TOKEN: screen.mcpToken } : {}),
  })

  const running = { child, ports, quiet: false }
  child.on("message", (message) => {
    if (message?.type !== "ready") return
    screen.reportReady(
      message.url,
      {
        appUrl: choice.appUrl,
        projectRoot: choice.projectRoot,
        packageName: choice.packageName,
        name: appName(choice),
      },
      choice.id
    )
    log(`[designlayer] editing ${appName(choice)} at ${message.url} — ${screen.url} to open another app`)
  })

  // A child that dies on its own — a crash, a port clash, a project the vendor
  // refuses — must not take the supervisor with it. The chooser is still up, so
  // it is where the explanation goes and where the next attempt starts.
  running.exited = new Promise((resolve) => {
    let settled = false
    const report = (reason) => {
      if (settled) return
      settled = true
      if (!running.quiet) {
        screen.reportStopped(reason, choice.id)
        log(`[designlayer] ${reason}`)
      }
      resolve()
    }
    child.once("exit", (code, signal) => report(farewell(choice, code, signal)))
    // A spawn that fails outright (EAGAIN, EMFILE, ENOMEM under load) emits
    // `error` and may never emit `exit`; with no listener the event throws and
    // takes the supervisor down — the one outcome the comment above rules out.
    child.once("error", (error) => {
      const name = appName(choice)
      report(`The editor for ${name} could not start (${error.message}). Pick an app below to try again.`)
    })
  })
  return running
}

/**
 * Whatever this process started is this process's to take down with it: a dev
 * server it spawned, a start screen it bound.
 *
 * The SIGINT listener lands before the vendor's, which means Ctrl+C exits here
 * and the vendor never closes its two servers — a cost of nothing, since the
 * process is going away and the sockets go with it. Not exiting instead would
 * be worse: a signal with a listener stops terminating by default, so Ctrl+C
 * during a slow first compile would do nothing at all.
 */
const cleanups = []
function holdUntilExit(stop) {
  if (cleanups.length === 0) {
    // One pass over the list on the way out, rather than a listener per caller:
    // the first signal handler to call `process.exit` is the only one that runs,
    // so the cleanup cannot live in the signal handlers themselves.
    process.once("exit", () => {
      for (const cleanup of cleanups) cleanup()
    })
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
      process.once(signal, () => process.exit(code))
    }
  }
  cleanups.push(stop)
}

/** npm exposes package bins through a symlink in `node_modules/.bin`. Compare
 * canonical paths so the installed command boots just like `node cli.mjs`. */
function isDirectRun(entry = process.argv[1]) {
  if (!entry) return false
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectRun()) {
  try {
    await main()
  } catch (error) {
    console.error(`\n  designlayer: ${error.message}\n`)
    process.exit(1)
  }
}
