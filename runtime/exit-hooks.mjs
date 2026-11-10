/**
 * What this process must undo on its way out, whichever way out it takes.
 *
 * A process here starts things that outlive it unless it stops them: a dev
 * server in its own process group, a start screen's port, editor children, a
 * registry entry and an endpoint file that tell other processes where it is.
 * There used to be two registries for that, one in cli.mjs and one in the
 * launcher, each installing its own signal handlers when it was first used.
 * Which cleanups ran then depended on which of them happened to exist when the
 * signal landed, and the two disagreed on the exit code (130/143 against 0).
 * Worse, the dev server's stop was registered only after its first compile had
 * finished, so Ctrl+C or a Stop during that wait killed this process and left
 * the dev server running with the app's port.
 *
 * One registry, installed on first use:
 *
 *   no hooks   --onExit(fn)-->        installed (exit + SIGINT/SIGTERM/SIGHUP)
 *   installed  --onExit(fn)-->        installed (fn added)
 *   installed  --remove()-->          installed (fn dropped; it ran its own course)
 *   installed  --SIGINT/TERM/HUP-->   process.exit(128 + signal number)
 *   installed  --process "exit"-->    every remaining fn runs once, in order
 *
 * The signal handler only exits; the cleanups run from `exit`, because the
 * first handler to call `process.exit` is the only one that runs, and `exit`
 * also covers a normal return and an explicit `process.exit` elsewhere. Each
 * cleanup must therefore be synchronous. The handlers are prepended, so they
 * run before the vendor's own SIGINT/SIGTERM `shutdown` (which exits 0 and
 * would hide which signal ended the editor).
 *
 * A signal with a listener stops terminating by default, so a handler that did
 * not exit would make Ctrl+C do nothing; this one always exits.
 */

const SIGNAL_EXIT_CODES = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 })

const hooks = []
let installed = false

function runHooks() {
  for (const hook of hooks.splice(0)) {
    try {
      hook()
    } catch {
      // One cleanup that throws must not keep the next from running.
    }
  }
}

/**
 * Runs `fn` when this process exits, by signal or otherwise. Returns a
 * function that unregisters it, for a cleanup whose subject ended first (a dev
 * server that exited by itself).
 */
export function onExit(fn) {
  if (!installed) {
    installed = true
    process.once("exit", runHooks)
    for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
      process.prependOnceListener(signal, () => process.exit(code))
    }
  }
  hooks.push(fn)
  return () => {
    const index = hooks.indexOf(fn)
    if (index !== -1) hooks.splice(index, 1)
  }
}

/**
 * The signal an exit code stands for, when a process that used these hooks
 * exited because of one; null otherwise. The supervisor reads a child's exit
 * through this, so "stopped (SIGTERM)" is said for a child that exited 143.
 */
export function signalForExitCode(code) {
  for (const [signal, value] of Object.entries(SIGNAL_EXIT_CODES)) {
    if (value === code) return signal
  }
  return null
}
