/**
 * Finds out whether this copy of DesignLayer is behind the repo's main branch,
 * and brings it up to date.
 *
 * There are two ways DesignLayer gets onto a machine, and each updates its own
 * way:
 *
 * - A git clone (the README, the landing page, `node desktop/mac/install.mjs`
 *   from a checkout). The clone is the install, so updating is a fast-forward
 *   of its main branch, then the same `npm ci` or build that `npm install` ran.
 *   A clone with local work in it, on another branch, or with commits main does
 *   not have, is someone developing DesignLayer: it is never touched, and the
 *   status says why.
 * - A copy without .git (the Mac download, desktop/mac/package.mjs). It carries
 *   the commit it was made from (SOURCE_STAMP). Updating downloads that
 *   commit's archive from GitHub, assembles the same payload beside the
 *   install, installs and builds it there, checks it, and only then swaps the
 *   folders. A failure at any step leaves the running copy as it was.
 *
 * Restarting is the caller's part (cli.mjs `supervise`): the files on disk
 * change here, and every running process keeps the code it loaded until it is
 * restarted. `restartDesk` and the resume file are the pieces it needs.
 */

import { execFile, execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

import { DESK_LABEL, deskPlistPath } from "./mac-desk.mjs"
import { SOURCE_STAMP, copyPayload } from "./payload.mjs"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Every six hours, and once a few seconds after start. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 3000
/** A resume file older than this is from some other run, not the restart that wrote it. */
const RESUME_MAX_AGE_MS = 5 * 60 * 1000
const CHANGES_SHOWN = 5

/** The repo updates come from: `repository.url` in package.json, on its main branch. */
export function repoOf(root = ROOT) {
  let url = ""
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    url = typeof manifest.repository === "string" ? manifest.repository : (manifest.repository?.url ?? "")
  } catch {
    // A copy without a readable package.json cannot name its repo.
  }
  const match = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(url)
  if (!match) return null
  const [, owner, name] = match
  return { owner, name, branch: "main", web: `https://github.com/${owner}/${name}` }
}

export function installKind(root = ROOT) {
  if (fs.existsSync(path.join(root, ".git"))) return "git"
  if (fs.existsSync(path.join(root, SOURCE_STAMP))) return "package"
  return "unknown"
}

function readStamp(root) {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(root, SOURCE_STAMP), "utf8"))
    return /^[0-9a-f]{40}$/.test(stamp.commit ?? "") ? stamp : null
  } catch {
    return null
  }
}

function packageVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? null
  } catch {
    return null
  }
}

/**
 * The commit this copy runs, without the network: what the desk compares to
 * see that its files changed under it. Null when it cannot tell.
 */
export function currentCommit(root = ROOT) {
  const kind = installKind(root)
  if (kind === "package") return readStamp(root)?.commit ?? null
  if (kind !== "git") return null
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

/** The production command runner: never prompts, always answers. */
export function runCommand(cmd, args, { cwd, timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        // A clone over https that wants a password must fail, not wait on a prompt nobody sees.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || error?.message || "") })
      }
    )
  })
}

/** npm beside the node running this, else whatever PATH finds: launchd's PATH may not have it. */
function npmPath() {
  const beside = path.join(path.dirname(process.execPath), "npm")
  return fs.existsSync(beside) ? beside : "npm"
}

const shortCommit = (commit) => (commit ? commit.slice(0, 7) : null)
const firstLine = (message) => String(message ?? "").split("\n")[0].trim()

function fail(message, output = "") {
  const tail = output.trim().split("\n").slice(-3).join(" ").slice(0, 400)
  return new Error(tail ? `${message}: ${tail}` : message)
}

/* ------------------------------------------------------------------ git -- */

async function gitCheck({ root, repo, run }) {
  const git = async (args, timeoutMs) => {
    const result = await run("git", args, { cwd: root, timeoutMs })
    if (result.code !== 0) throw fail(`git ${args[0]} failed`, result.stderr || result.stdout)
    return result.stdout.trim()
  }
  const remote = "origin"
  const tracking = `refs/remotes/${remote}/${repo.branch}`
  const head = await git(["rev-parse", "HEAD"])
  const branch = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root })).stdout.trim() || null
  await git(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${repo.branch}:${tracking}`], 60_000)
  const latest = await git(["rev-parse", tracking])
  const [behind, ahead] = (await git(["rev-list", "--left-right", "--count", `${tracking}...HEAD`])).split(/\s+/).map(Number)
  const log = behind
    ? (await git(["log", `-n${CHANGES_SHOWN}`, "--format=%H%x1f%s%x1f%cI", `HEAD..${tracking}`]))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [commit, subject, date] = line.split("\x1f")
          return { commit, subject, date }
        })
    : []
  const headDate = await git(["show", "-s", "--format=%cI", "HEAD"])
  const dirty = (await git(["status", "--porcelain", "--untracked-files=no"])) !== ""
  let blocked = null
  if (behind) {
    if (branch !== repo.branch) blocked = `This checkout is on ${branch ? `branch ${branch}` : "a detached commit"}, not ${repo.branch}. Update it with git.`
    else if (ahead) blocked = `This checkout has ${ahead} commit${ahead === 1 ? "" : "s"} that ${repo.branch} does not. Update it with git.`
    else if (dirty) blocked = "This checkout has uncommitted changes. Commit or stash them, then update."
  }
  const latestInfo = log[0] ?? { commit: latest, subject: null, date: null }
  return {
    state: behind === 0 ? "current" : blocked ? "blocked" : "available",
    current: { commit: head, short: shortCommit(head), date: headDate },
    latest: { commit: latest, short: shortCommit(latest), date: latestInfo.date, subject: latestInfo.subject },
    behind,
    changes: log.map(({ commit, subject }) => ({ commit: shortCommit(commit), subject })),
    reason: blocked,
  }
}

async function gitApply({ root, repo, run, progress }) {
  const git = async (args) => {
    const result = await run("git", args, { cwd: root })
    if (result.code !== 0) throw fail(`git ${args[0]} failed`, result.stderr || result.stdout)
    return result.stdout.trim()
  }
  const before = await git(["rev-parse", "HEAD"])
  progress("Downloading the update")
  await git(["merge", "--ff-only", "--quiet", `refs/remotes/origin/${repo.branch}`])
  const changed = (await git(["diff", "--name-only", before, "HEAD"])).split("\n")
  try {
    if (changed.includes("package.json") || changed.includes("package-lock.json")) {
      progress("Installing dependencies")
      // `npm ci` runs the prepare script, which builds dist/.
      const ci = await run(npmPath(), ["ci", "--no-audit", "--no-fund"], { cwd: root, timeoutMs: 10 * 60_000 })
      if (ci.code !== 0) throw fail("npm ci failed", ci.stderr || ci.stdout)
    } else {
      progress("Building the editor")
      const built = await run(process.execPath, ["build.mjs"], { cwd: root, timeoutMs: 5 * 60_000 })
      if (built.code !== 0) throw fail("The build failed", built.stderr || built.stdout)
    }
  } catch (error) {
    // Back to the commit that worked. --keep refuses to touch a file with
    // local changes, and the check refused a checkout with any.
    await run("git", ["reset", "--keep", before], { cwd: root })
    await run(process.execPath, ["build.mjs"], { cwd: root, timeoutMs: 5 * 60_000 })
    throw error
  }
  return git(["rev-parse", "HEAD"])
}

/* -------------------------------------------------------------- package -- */

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: "application/vnd.github+json", "user-agent": "designlayer-updater" } })
  if (!response.ok) {
    const error = new Error(`GitHub answered ${response.status} for ${url}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

async function packageCheck({ root, repo, fetchImpl }) {
  const stamp = readStamp(root)
  const api = `https://api.github.com/repos/${repo.owner}/${repo.name}`
  const current = { commit: stamp?.commit ?? null, short: shortCommit(stamp?.commit), date: stamp?.date ?? null }
  if (stamp) {
    try {
      const compare = await getJson(fetchImpl, `${api}/compare/${stamp.commit}...${repo.branch}`)
      const commits = Array.isArray(compare.commits) ? compare.commits : []
      const tip = commits.at(-1)
      const behind = Number(compare.ahead_by) || 0
      // "behind" or "identical": main has nothing this copy lacks.
      if (behind === 0) return { state: "current", current, latest: { ...current, subject: null }, behind: 0, changes: [], reason: null }
      return {
        state: "available",
        current,
        latest: { commit: tip.sha, short: shortCommit(tip.sha), date: tip.commit?.committer?.date ?? null, subject: firstLine(tip.commit?.message) },
        behind,
        changes: commits.slice(-CHANGES_SHOWN).reverse().map((c) => ({ commit: shortCommit(c.sha), subject: firstLine(c.commit?.message) })),
        reason: null,
      }
    } catch (error) {
      // A commit GitHub does not know (built from a local branch) is compared
      // by being different from main's tip, below. Anything else is an error.
      if (error.status !== 404) throw error
    }
  }
  const tip = await getJson(fetchImpl, `${api}/commits/${repo.branch}`)
  const same = tip.sha === stamp?.commit
  return {
    state: same ? "current" : "available",
    current,
    latest: { commit: tip.sha, short: shortCommit(tip.sha), date: tip.commit?.committer?.date ?? null, subject: firstLine(tip.commit?.message) },
    behind: same ? 0 : null,
    changes: same ? [] : [{ commit: shortCommit(tip.sha), subject: firstLine(tip.commit?.message) }],
    reason: null,
  }
}

/** The production `download`: a URL to a file, streamed. */
export async function downloadFile(url, file, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { "user-agent": "designlayer-updater" } })
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} for ${url}`)
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file))
}

async function packageApply({ root, repo, run, download, commit, date, progress }) {
  // Beside the install, so the final swap is two renames on one volume.
  const work = fs.mkdtempSync(path.join(path.dirname(root), ".designlayer-update-"))
  const staged = `${root}.updating`
  const previous = `${root}.previous`
  try {
    progress("Downloading the update")
    const archive = path.join(work, "source.tar.gz")
    await download(`https://codeload.github.com/${repo.owner}/${repo.name}/tar.gz/${commit}`, archive)
    const source = path.join(work, "source")
    fs.mkdirSync(source)
    const untar = await run("tar", ["-xzf", archive, "-C", source], { cwd: work })
    if (untar.code !== 0) throw fail("Could not unpack the update", untar.stderr)
    const [top] = fs.readdirSync(source)
    if (!top) throw new Error("The update archive was empty")

    fs.rmSync(staged, { recursive: true, force: true })
    copyPayload(path.join(source, top), staged)
    // The uninstaller is written by the download's own package script, which
    // the payload does not carry; the copy installed with it stays.
    for (const keep of ["uninstall.command"]) {
      if (fs.existsSync(path.join(root, keep))) fs.copyFileSync(path.join(root, keep), path.join(staged, keep))
    }
    fs.writeFileSync(path.join(staged, SOURCE_STAMP), `${JSON.stringify({ commit, date }, null, 2)}\n`)

    progress("Installing dependencies")
    // The prepare script builds dist/ as part of the install.
    const ci = await run(npmPath(), ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: staged, timeoutMs: 10 * 60_000 })
    if (ci.code !== 0) throw fail("npm ci failed", ci.stderr || ci.stdout)
    progress("Building the editor")
    if (!fs.existsSync(path.join(staged, "dist", "designlayer.js"))) {
      const built = await run(process.execPath, ["build.mjs"], { cwd: staged, timeoutMs: 5 * 60_000 })
      if (built.code !== 0) throw fail("The build failed", built.stderr || built.stdout)
    }
    const verified = await run(process.execPath, ["cli.mjs", "--verify"], { cwd: staged })
    if (verified.code !== 0) throw fail("The new version failed its own check", verified.stderr || verified.stdout)

    fs.rmSync(previous, { recursive: true, force: true })
    fs.renameSync(root, previous)
    try {
      fs.renameSync(staged, root)
    } catch (error) {
      fs.renameSync(previous, root)
      throw error
    }
    fs.rmSync(previous, { recursive: true, force: true })
    return commit
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(staged, { recursive: true, force: true })
  }
}

/* -------------------------------------------------------------- updater -- */

/**
 * One owner for this copy's update state. The start screen serves it, the
 * desk relays it, and `designlayer --update` drives it from a terminal.
 *
 * `status()` is always safe to call and never touches the network. Its
 * `state` is one of: "idle" (not checked yet), "checking", "current",
 * "available", "blocked" (behind, but this copy cannot update itself; `reason`
 * says why), "unsupported" (no way to tell, `reason` says why), "updating"
 * (`step` says which), "updated" (the files are new; a restart runs them), or
 * "error" (`error` says what failed; the last check is kept).
 */
export function createUpdater({
  root = ROOT,
  run = runCommand,
  fetch: fetchImpl = globalThis.fetch,
  download = (url, file) => downloadFile(url, file, fetchImpl),
  log = () => {},
  intervalMs = CHECK_INTERVAL_MS,
  now = Date.now,
} = {}) {
  const repo = repoOf(root)
  const kind = installKind(root)
  // The commit this process loaded, which an update on disk does not change.
  const running = currentCommit(root)
  let check = null
  let state = "idle"
  let step = null
  let error = null
  // Which of the two failed, for a page that shows a failed update but not a
  // failed check: a laptop offline is not news.
  let failed = null
  let checkedAt = null
  let checking = null
  let applying = null
  let timer = null
  let updatedTo = null

  const listeners = new Set()
  const changed = () => {
    for (const listener of listeners) listener(status())
  }

  function status() {
    return {
      state,
      kind,
      version: packageVersion(root),
      running,
      repo: repo?.web ?? null,
      current: check?.current ?? null,
      latest: check?.latest ?? null,
      behind: check?.behind ?? null,
      changes: check?.changes ?? [],
      reason: check?.reason ?? null,
      step,
      error,
      failed,
      checkedAt,
      updatedTo: shortCommit(updatedTo),
    }
  }

  async function runCheck() {
    if (!repo) return { state: "unsupported", reason: "package.json names no GitHub repo to update from." }
    if (kind === "git") return gitCheck({ root, repo, run })
    if (kind === "package") return packageCheck({ root, repo, fetchImpl })
    return { state: "unsupported", reason: "This copy is neither a git clone nor the Mac download, so it cannot update itself." }
  }

  function checkNow() {
    // An update in progress or done owns the state until the restart.
    if (state === "updating" || state === "updated") return Promise.resolve(status())
    checking ??= (async () => {
      state = "checking"
      error = null
      failed = null
      changed()
      try {
        check = await runCheck()
        state = check.state
        checkedAt = new Date(now()).toISOString()
        if (state === "available") log(`[designlayer] an update is available: ${check.behind ?? "new"} change${check.behind === 1 ? "" : "s"} on ${repo.branch}`)
      } catch (failure) {
        state = "error"
        failed = "check"
        error = `Could not check for updates. ${failure.message}`
      } finally {
        checking = null
        changed()
      }
      return status()
    })()
    return checking
  }

  function apply() {
    applying ??= (async () => {
      try {
        await checking
        await checkNow()
        if (state !== "available") {
          if (state === "current") return status()
          throw new Error(check?.reason ?? error ?? "No update is available.")
        }
        state = "updating"
        error = null
        failed = null
        const progress = (text) => {
          step = text
          log(`[designlayer] update: ${text.toLowerCase()}…`)
          changed()
        }
        progress("Starting the update")
        updatedTo =
          kind === "git"
            ? await gitApply({ root, repo, run, progress })
            : await packageApply({ root, repo, run, download, commit: check.latest.commit, date: check.latest.date, progress })
        state = "updated"
        step = null
        log(`[designlayer] updated to ${shortCommit(updatedTo)}; restart to run it`)
      } catch (failure) {
        state = "error"
        step = null
        failed = "update"
        error = `The update did not finish. ${failure.message}`
        log(`[designlayer] ${error}`)
      } finally {
        applying = null
        changed()
      }
      return status()
    })()
    return applying
  }

  return {
    status,
    check: checkNow,
    apply,
    /** Called with the status each time it changes. Returns the unsubscribe. */
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Checks a few seconds from now, then on the interval. */
    start() {
      const tick = () => {
        void checkNow()
        timer = setTimeout(tick, intervalMs)
        timer.unref?.()
      }
      timer = setTimeout(tick, FIRST_CHECK_DELAY_MS)
      timer.unref?.()
    },
    stop() {
      clearTimeout(timer)
    },
  }
}

/* -------------------------------------------------------------- restart -- */

/**
 * Whether the Mac app's desk runs from this copy. Its LaunchAgent names the
 * folder it runs in (desktop/mac/launch-agent.mjs), and an update to that
 * folder is an update to the app.
 */
export function deskRunsFrom(root = ROOT, { platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== "darwin") return false
  let plist
  try {
    plist = fs.readFileSync(deskPlistPath(home), "utf8")
  } catch {
    return false
  }
  const dir = /<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  if (!dir) return false
  const unescape = (value) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  try {
    return fs.realpathSync(unescape(dir)) === fs.realpathSync(root)
  } catch {
    return false
  }
}

/**
 * Restarts the desk through launchd, which stops it (and the start screen it
 * runs) and starts it again from the files now on disk. launchctl runs in a
 * process group of its own: launchd stops the desk's whole group, and the
 * start screen asking for this is in it.
 */
export function restartDesk({ spawnImpl = spawn } = {}) {
  const child = spawnImpl("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${DESK_LABEL}`], {
    detached: true,
    stdio: "ignore",
  })
  child.unref?.()
}

export function resumeFile(home = os.homedir()) {
  return path.join(home, ".local", "state", "designlayer", "resume.json")
}

/** The editors to start again once the restart is up: `[{ url, projectRoot, devScript }]`. */
export function saveResume(editors, { file = resumeFile(), now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ savedAt: now(), editors }))
}

/** Reads and removes the resume list. Empty when there is none, or it is stale. */
export function takeResume({ file = resumeFile(), now = Date.now, maxAgeMs = RESUME_MAX_AGE_MS } = {}) {
  let saved
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return []
  }
  fs.rmSync(file, { force: true })
  if (!saved || now() - Number(saved.savedAt) > maxAgeMs || !Array.isArray(saved.editors)) return []
  return saved.editors.filter((entry) => entry && typeof entry.url === "string" && typeof entry.projectRoot === "string")
}
