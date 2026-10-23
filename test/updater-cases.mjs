/**
 * The updater: how a copy of DesignLayer finds out it is behind main, and how
 * it brings itself up to date without breaking the copy that runs.
 *
 * Every case runs offline. The git cases use a real git: a bare repo in a temp
 * folder stands in for GitHub, so fetch, fast-forward and rollback are git's
 * own. The download cases stand GitHub's API and archive behind a fake
 * `fetch` and `download`, and the archive is a real tarball.
 *
 * Usage: node test/updater-cases.mjs
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PAYLOAD_DIRS, PAYLOAD_FILES, SOURCE_STAMP } from "../runtime/payload.mjs"
import {
  createUpdater,
  currentCommit,
  deskRunsFrom,
  installKind,
  repoOf,
  ROOT,
  runCommand,
  saveResume,
  takeResume,
} from "../runtime/updater.mjs"

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.stack}`)
  }
}

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "designlayer-updater-"))
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const MANIFEST = { name: "designlayer", version: "0.1.0", repository: { type: "git", url: "git+https://github.com/example/design-layer.git" } }
// Stands in for the real build: it writes the file the update checks for.
const BUILD = `import fs from "node:fs"\nif (fs.existsSync("break-build")) process.exit(3)\nfs.mkdirSync("dist", { recursive: true })\nfs.writeFileSync("dist/designlayer.js", "built " + fs.readFileSync("VERSION", "utf8"))\n`

let counter = 0
/** A "GitHub" bare repo with one commit on main, and a clone of it: the install. */
function gitInstall() {
  const dir = path.join(TMP, `git-${++counter}`)
  const upstream = path.join(dir, "upstream")
  const remote = path.join(dir, "remote.git")
  const install = path.join(dir, "install")
  fs.mkdirSync(upstream, { recursive: true })
  git(upstream, "init", "-q")
  fs.writeFileSync(path.join(upstream, "package.json"), JSON.stringify(MANIFEST))
  fs.writeFileSync(path.join(upstream, "build.mjs"), BUILD)
  fs.writeFileSync(path.join(upstream, "VERSION"), "1")
  fs.writeFileSync(path.join(upstream, ".gitignore"), "dist/\nbreak-build\n")
  git(upstream, "add", ".")
  git(upstream, "commit", "-qm", "First version")
  git(dir, "clone", "-q", "--bare", upstream, remote)
  git(upstream, "remote", "add", "origin", remote)
  git(dir, "clone", "-q", remote, install)
  return { upstream, install }
}

function publish(upstream, version, subject) {
  fs.writeFileSync(path.join(upstream, "VERSION"), version)
  git(upstream, "commit", "-qam", subject)
  git(upstream, "push", "-q", "origin", "main")
  return git(upstream, "rev-parse", "HEAD")
}

await check("the repo comes from package.json, on main", () => {
  assert.deepEqual(repoOf(path.resolve(import.meta.dirname, "..")), {
    owner: "phil8-li",
    name: "design-layer",
    branch: "main",
    web: "https://github.com/phil8-li/design-layer",
  })
})

await check("a clone that matches main is current", async () => {
  const { install } = gitInstall()
  assert.equal(installKind(install), "git")
  const updater = createUpdater({ root: install })
  assert.equal(updater.status().state, "idle")
  const status = await updater.check()
  assert.equal(status.state, "current")
  assert.equal(status.kind, "git")
  assert.equal(status.behind, 0)
  assert.equal(status.current.commit, currentCommit(install))
})

await check("a clone behind main sees the new commits, then fast-forwards and builds", async () => {
  const { upstream, install } = gitInstall()
  publish(upstream, "2", "Layers scroll sideways")
  const tip = publish(upstream, "3", "Tokens show their source")
  const updater = createUpdater({ root: install })
  const seen = []
  updater.onChange((s) => seen.push(s.state === "updating" ? s.step : s.state))
  const status = await updater.check()
  assert.equal(status.state, "available")
  assert.equal(status.behind, 2)
  assert.equal(status.latest.commit, tip)
  assert.deepEqual(status.changes.map((c) => c.subject), ["Tokens show their source", "Layers scroll sideways"])

  const done = await updater.apply()
  assert.equal(done.state, "updated", done.error)
  assert.equal(done.updatedTo, tip.slice(0, 7))
  assert.equal(currentCommit(install), tip)
  assert.equal(fs.readFileSync(path.join(install, "dist", "designlayer.js"), "utf8"), "built 3")
  assert.ok(seen.includes("Building the editor"), `progress was reported: ${seen.join(", ")}`)
  // A finished update holds until the restart: a later check cannot hide it.
  assert.equal((await updater.check()).state, "updated")
})

await check("a clone with local work is never touched, and says why", async () => {
  const { upstream, install } = gitInstall()
  publish(upstream, "2", "Second")
  fs.writeFileSync(path.join(install, "VERSION"), "mine")
  const updater = createUpdater({ root: install })
  const status = await updater.check()
  assert.equal(status.state, "blocked")
  assert.match(status.reason, /uncommitted changes/)
  const before = currentCommit(install)
  const after = await updater.apply()
  assert.equal(after.state, "error")
  assert.equal(currentCommit(install), before)
  assert.equal(fs.readFileSync(path.join(install, "VERSION"), "utf8"), "mine")
})

await check("a clone on another branch, or ahead of main, is blocked", async () => {
  const { upstream, install } = gitInstall()
  publish(upstream, "2", "Second")
  git(install, "checkout", "-qb", "feature")
  assert.match((await createUpdater({ root: install }).check()).reason, /branch feature/)
  git(install, "checkout", "-q", "main")
  fs.writeFileSync(path.join(install, "local.txt"), "x")
  git(install, "add", "local.txt")
  git(install, "-c", "user.name=T", "-c", "user.email=t@e", "commit", "-qm", "Local")
  assert.match((await createUpdater({ root: install }).check()).reason, /1 commit that main does not/)
})

await check("a failed build puts the clone back on the commit that worked", async () => {
  const { upstream, install } = gitInstall()
  const before = currentCommit(install)
  publish(upstream, "2", "Second")
  fs.writeFileSync(path.join(install, "break-build"), "")
  const status = await createUpdater({ root: install }).apply()
  assert.equal(status.state, "error")
  assert.match(status.error, /build failed/)
  assert.equal(currentCommit(install), before)
})

await check("a fetch that fails is an error, not a crash", async () => {
  const { install } = gitInstall()
  git(install, "remote", "set-url", "origin", path.join(TMP, "nowhere.git"))
  const status = await createUpdater({ root: install }).check()
  assert.equal(status.state, "error")
  assert.match(status.error, /Could not check for updates/)
})

await check("a copy that is neither a clone nor the download cannot update itself", async () => {
  const dir = path.join(TMP, "bare-copy")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(MANIFEST))
  const status = await createUpdater({ root: dir }).check()
  assert.equal(status.state, "unsupported")
  assert.equal(installKind(dir), "unknown")
})

// ── The Mac download: no .git, a stamp, GitHub's API and archive ───────────

const OLD = "a".repeat(40)
const NEW = "b".repeat(40)

/** A source tree with every payload file, packed the way codeload packs one. */
function archiveOf(version) {
  const top = path.join(TMP, `archive-${++counter}`, `design-layer-${NEW}`)
  for (const file of PAYLOAD_FILES) {
    fs.mkdirSync(path.dirname(path.join(top, file)), { recursive: true })
    fs.writeFileSync(path.join(top, file), file === "package.json" ? JSON.stringify({ ...MANIFEST, version }) : version)
  }
  for (const dir of PAYLOAD_DIRS) {
    fs.mkdirSync(path.join(top, dir), { recursive: true })
    fs.writeFileSync(path.join(top, dir, "file.mjs"), version)
    fs.mkdirSync(path.join(top, dir, "test"), { recursive: true })
    fs.writeFileSync(path.join(top, dir, "test", "skip.mjs"), "")
  }
  const tarball = path.join(path.dirname(top), "source.tar.gz")
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(top), path.basename(top)])
  return tarball
}

function packageInstall() {
  const root = path.join(TMP, `package-${++counter}`, "app")
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(MANIFEST))
  fs.writeFileSync(path.join(root, SOURCE_STAMP), JSON.stringify({ commit: OLD, date: "2026-01-01T00:00:00Z" }))
  fs.writeFileSync(path.join(root, "uninstall.command"), "#!/bin/bash\n")
  fs.writeFileSync(path.join(root, "old-only.txt"), "")
  return root
}

const github = (routes) => async (url) => {
  const body = routes[url]
  return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) }
}
const COMPARE = `https://api.github.com/repos/example/design-layer/compare/${OLD}...main`
const compareBody = {
  ahead_by: 2,
  commits: [
    { sha: "c".repeat(40), commit: { message: "Older change\n\nbody", committer: { date: "2026-02-01T00:00:00Z" } } },
    { sha: NEW, commit: { message: "Newest change", committer: { date: "2026-03-01T00:00:00Z" } } },
  ],
}
// npm and the new copy's self-check are stood in for; tar and the swap are real.
const fakeRun = (calls, { verify = 0 } = {}) => async (cmd, args, options) => {
  calls.push([path.basename(cmd), ...args].join(" "))
  if (path.basename(cmd) === "npm") {
    fs.mkdirSync(path.join(options.cwd, "dist"), { recursive: true })
    fs.writeFileSync(path.join(options.cwd, "dist", "designlayer.js"), "built")
    return { code: 0, stdout: "", stderr: "" }
  }
  if (args[0] === "cli.mjs") return { code: verify, stdout: "", stderr: verify ? "patch anchor missing" : "" }
  return runCommand(cmd, args, options)
}

await check("the download compares its stamp with main on GitHub", async () => {
  const root = packageInstall()
  assert.equal(installKind(root), "package")
  const status = await createUpdater({ root, fetch: github({ [COMPARE]: compareBody }) }).check()
  assert.equal(status.state, "available")
  assert.equal(status.behind, 2)
  assert.equal(status.latest.commit, NEW)
  assert.deepEqual(status.changes.map((c) => c.subject), ["Newest change", "Older change"])
  const same = await createUpdater({ root, fetch: github({ [COMPARE]: { ahead_by: 0, commits: [] } }) }).check()
  assert.equal(same.state, "current")
})

await check("a stamp GitHub does not know is compared with main's tip", async () => {
  const root = packageInstall()
  const tip = { sha: NEW, commit: { message: "Tip", committer: { date: "2026-03-01T00:00:00Z" } } }
  const status = await createUpdater({ root, fetch: github({ "https://api.github.com/repos/example/design-layer/commits/main": tip }) }).check()
  assert.equal(status.state, "available")
  assert.equal(status.behind, null)
})

await check("the download is replaced by the new payload only after it installs and checks", async () => {
  const root = packageInstall()
  const tarball = archiveOf("2")
  const calls = []
  let asked = null
  const updater = createUpdater({
    root,
    fetch: github({ [COMPARE]: compareBody }),
    run: fakeRun(calls),
    download: async (url, file) => {
      asked = url
      fs.copyFileSync(tarball, file)
    },
  })
  const status = await updater.apply()
  assert.equal(status.state, "updated", status.error)
  assert.equal(asked, `https://codeload.github.com/example/design-layer/tar.gz/${NEW}`)
  assert.ok(calls.some((c) => c.startsWith("npm ci --omit=dev")), calls.join("\n"))
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, SOURCE_STAMP), "utf8")).commit, NEW)
  assert.equal(fs.readFileSync(path.join(root, "runtime", "file.mjs"), "utf8"), "2")
  assert.ok(fs.existsSync(path.join(root, "uninstall.command")), "the installed uninstaller stays")
  assert.ok(!fs.existsSync(path.join(root, "old-only.txt")), "the old copy's files are gone")
  assert.ok(!fs.existsSync(path.join(root, "runtime", "test")), "the payload excludes tests")
  assert.deepEqual(fs.readdirSync(path.dirname(root)), ["app"], "no staging folder is left behind")
})

await check("a download that fails its check leaves the running copy as it was", async () => {
  const root = packageInstall()
  const tarball = archiveOf("2")
  const status = await createUpdater({
    root,
    fetch: github({ [COMPARE]: compareBody }),
    run: fakeRun([], { verify: 1 }),
    download: async (_url, file) => fs.copyFileSync(tarball, file),
  }).apply()
  assert.equal(status.state, "error")
  assert.match(status.error, /failed its own check: patch anchor missing/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, SOURCE_STAMP), "utf8")).commit, OLD)
  assert.ok(fs.existsSync(path.join(root, "old-only.txt")))
  assert.deepEqual(fs.readdirSync(path.dirname(root)), ["app"])
})

// ── Restart pieces ─────────────────────────────────────────────────────────

await check("the resume list survives one restart, once, and only while fresh", () => {
  const file = path.join(TMP, "resume", "resume.json")
  const editors = [{ url: "http://127.0.0.1:3000/cart", projectRoot: "/p/shop", devScript: "dev" }, { nope: true }]
  saveResume(editors, { file, now: () => 1000 })
  assert.deepEqual(takeResume({ file, now: () => 2000 }), [editors[0]])
  assert.deepEqual(takeResume({ file, now: () => 2000 }), [], "taken once")
  saveResume(editors, { file, now: () => 1000 })
  assert.deepEqual(takeResume({ file, now: () => 1000 + 10 * 60 * 1000 }), [], "stale")
})

await check("the desk counts as this copy only when its LaunchAgent runs from this folder", () => {
  const home = path.join(TMP, "home")
  const agents = path.join(home, "Library", "LaunchAgents")
  fs.mkdirSync(agents, { recursive: true })
  const here = path.join(TMP, "here")
  fs.mkdirSync(here)
  const plist = (dir) => `<plist><dict><key>WorkingDirectory</key>\n  <string>${dir}</string></dict></plist>`
  assert.equal(deskRunsFrom(here, { platform: "darwin", home }), false, "no app installed")
  fs.writeFileSync(path.join(agents, "dev.designlayer.desk.plist"), plist(here))
  assert.equal(deskRunsFrom(here, { platform: "darwin", home }), true)
  assert.equal(deskRunsFrom(here, { platform: "linux", home }), false)
  fs.writeFileSync(path.join(agents, "dev.designlayer.desk.plist"), plist(path.join(TMP, "elsewhere")))
  assert.equal(deskRunsFrom(here, { platform: "darwin", home }), false)
})

// The README and the landing page install by cloning main, and the updater
// fast-forwards that clone. git hands every filter=lfs path to git-lfs, and on a
// Mac whose ~/.gitconfig requires LFS (GitHub Desktop and Sourcetree set that
// up) but whose Terminal has no git-lfs, the clone stops at the first one and
// leaves a design-layer folder with no package.json. The launch films live in
// phil8-li/design-layer-landing-page for that reason.
if (installKind(ROOT) === "git") {
  await check("main holds no Git LFS files, so cloning or updating it never needs git-lfs", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    const fields = execFileSync("git", ["check-attr", "--stdin", "-z", "filter"], { cwd: ROOT, input: tracked, encoding: "utf8" }).split("\0")
    const filtered = []
    for (let i = 0; i + 2 < fields.length; i += 3) if (fields[i + 2] === "lfs") filtered.push(fields[i])
    assert.deepEqual(filtered, [], "paths marked filter=lfs")
    const pointers = tracked.split("\0").filter((file) => {
      const full = path.join(ROOT, file)
      if (!file || !fs.existsSync(full) || fs.statSync(full).size > 200) return false
      return fs.readFileSync(full, "utf8").startsWith("version https://git-lfs.github.com/spec/")
    })
    assert.deepEqual(pointers, [], "Git LFS pointer files")
  })
} else console.log("  skip main holds no Git LFS files: this copy is not a git clone")

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
