/**
 * The desk's LaunchAgent, as the installer drives it: every launchctl write
 * goes through `restartAgent`, so none of them can stop the desk without first
 * saving the editors that stop with it.
 *
 * The start screen the desk started, and every editor that start screen
 * started, run in the desk's process group (desk-server.mjs and cli.mjs spawn
 * them without `detached`), and launchd stops the whole group with the desk.
 * So before a restart or a stop the open editors are written to
 * `~/.local/state/designlayer/resume.json`, the file an update writes before
 * its own restart (runtime/updater.mjs `saveResume`). The next start screen
 * the desk starts reopens them on their remembered ports (cli.mjs,
 * `takeResume`), as long as it starts within five minutes. A start screen the
 * desk did not start keeps running, and so do its editors: nothing is saved
 * for them.
 *
 * launchd owns the agent's state; `state()` reads it:
 *
 *   not installed (no plist)  --install-->           loaded, running
 *   loaded        --restartAgent("reload")-->        bootout, bootstrap   (the installer rewrote the plist)
 *   loaded        --restartAgent("restart")-->       kickstart -k         (--start)
 *   unloaded      --restartAgent("restart")-->       bootstrap            (--start)
 *   loaded        --restartAgent("stop")-->          bootout, until login or --start
 */

import { execFileSync } from "node:child_process"
import http from "node:http"

import { resumeFile as defaultResumeFile, saveResume } from "../../runtime/updater.mjs"

export function runCommand(cmd, argv, { allowFail = false } = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }
  } catch (error) {
    if (!allowFail) throw error
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}`, code: error.status }
  }
}

/** The desk's /api/health, or null when nothing answers at `deskApi` (".../" with the slash). */
export function deskHealth(deskApi, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${deskApi}api/health`, { timeout: timeoutMs }, (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    req.on("timeout", () => req.destroy())
    req.on("error", () => resolve(null))
  })
}

/**
 * The editors to reopen after the desk restarts, from its health: those of a
 * start screen the desk started, in the shape `saveResume` takes. Empty when
 * the desk does not answer, or its start screen is someone else's.
 */
export function resumableEditors(health) {
  const screen = health?.startScreen
  if (!screen?.owned || !Array.isArray(screen.editors)) return []
  return screen.editors
    .filter((row) => row && typeof row.appUrl === "string" && typeof row.projectRoot === "string")
    .map((row) => ({ url: row.appUrl, projectRoot: row.projectRoot, devScript: null }))
}

export function deskAgent({ domain, label, plistFile, deskApi, run = runCommand, resumeFile = defaultResumeFile(), log = () => {}, sleep = (s) => execFileSync("/bin/sleep", [String(s)]) }) {
  const target = `${domain}/${label}`

  function state() {
    const result = run("/bin/launchctl", ["print", target], { allowFail: true })
    if (!result.ok) return { loaded: false }
    return {
      loaded: true,
      state: result.out.match(/^\s*state = (.+)$/m)?.[1] ?? "unknown",
      pid: result.out.match(/^\s*pid = (\d+)$/m)?.[1] ?? null,
      lastExit: result.out.match(/last exit code = (.+)$/m)?.[1] ?? null,
    }
  }

  /** Writes the running desk's editors for the next start screen, and says how many. */
  async function saveEditors() {
    const editors = resumableEditors(await deskHealth(deskApi))
    if (!editors.length) return 0
    saveResume(editors, { file: resumeFile })
    log(`  saved ${editors.length} open editor${editors.length === 1 ? "" : "s"} to reopen after the restart`)
    return editors.length
  }

  function bootstrap() {
    // bootout is asynchronous; bootstrap fails with "Input/output error" if it races.
    for (let i = 0; i < 10; i += 1) {
      const result = run("/bin/launchctl", ["bootstrap", domain, plistFile], { allowFail: true })
      if (result.ok) return
      if (i === 9) throw new Error(`launchctl bootstrap failed: ${result.out.trim()}`)
      sleep(0.5)
    }
  }

  /**
   * The one way the installer stops or restarts the desk. `save: false` only
   * where nothing will start the editors again (uninstall).
   * Answers whether launchctl did what was asked.
   */
  async function restartAgent({ action, save = true }) {
    if (save) await saveEditors()
    if (action === "stop") return run("/bin/launchctl", ["bootout", target], { allowFail: true }).ok
    if (action === "reload") {
      run("/bin/launchctl", ["bootout", target], { allowFail: true })
      bootstrap()
      return true
    }
    if (action === "restart") {
      if (state().loaded) run("/bin/launchctl", ["kickstart", "-k", target])
      else run("/bin/launchctl", ["bootstrap", domain, plistFile])
      return true
    }
    throw new Error(`Unknown agent action: ${action}`)
  }

  return { state, restartAgent }
}
