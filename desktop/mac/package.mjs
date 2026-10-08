#!/usr/bin/env node

/**
 * Builds the downloadable Mac package: Design-Layer-for-Mac.zip.
 *
 *   node desktop/mac/package.mjs [--out <dir>] [--fresh-deps] [--node-zip]
 *
 *   --out <dir>    where the zip goes (default: landing/downloads/)
 *   --fresh-deps   build dist/ against a clean `npm ci` instead of this
 *                  checkout's node_modules (used automatically when it has none)
 *   --node-zip     write the zip with the built-in writer even if `zip` exists
 *
 * The zip holds one folder, `Design Layer/`, with the install .command, a
 * README.txt and `payload/`: the files the desk server, the launcher and the
 * build read at run time, plus a prebuilt dist/. No node_modules — the
 * installer runs `npm ci --omit=dev` on the user's Mac, because the Mac app is
 * Homebrew node running this package from disk, not a compiled binary.
 *
 * A .command double-clicked from a browser download carries the quarantine
 * flag, and macOS 15+ refuses it ("Apple could not verify … is free of
 * malware") until the user finds Open Anyway in System Settings; right-click >
 * Open no longer bypasses that. Running it with `bash` skips the check, so
 * README.txt leads with that. The landing page installs from a git clone
 * instead, which sets no quarantine flag (and no `curl | bash`, which managed
 * Macs warn about).
 *
 * The uninstaller is not in the zip's top folder for the same reason: a
 * double-clicked copy from the download hits that dialog too. It ships as
 * payload/uninstall.command, and the installer writes it out with `cat` as a
 * new file, which carries no quarantine flag, to
 * ~/Library/Application Support/Design Layer/Uninstall Design Layer.command.
 *
 * dist/ is built in a temporary copy, never in this checkout's own dist/,
 * which a running editor may be serving.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import zlib from "node:zlib"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..", "..")
const PRODUCT = "Design Layer"
const ZIP_NAME = "Design-Layer-for-Mac.zip"
const SOURCE_URL = "https://github.com/phil8-li/design-layer"
const WHY_UNSIGNED_URL = `${SOURCE_URL}/blob/main/desktop/mac/README.md#why-it-is-built-this-way`

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const outIndex = argv.indexOf("--out")
if (outIndex !== -1 && !argv[outIndex + 1]) fail("--out needs a directory")
const OUT_DIR = outIndex === -1 ? path.join(REPO_ROOT, "landing", "downloads") : path.resolve(argv[outIndex + 1])

/** What the payload carries, relative to the repo root. Directories are copied whole, minus EXCLUDE. */
const PAYLOAD_FILES = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "build.mjs",
  "cli.mjs",
  "config.mjs",
  "designlayer.config.example.mjs",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  // build.mjs imports these two; nothing else under tools/ is read at run time.
  "tools/sonner-plugin.mjs",
  "tools/strip-css-comments.mjs",
]
const PAYLOAD_DIRS = ["runtime", "server", "src", "desktop/mac"]
const EXCLUDE = new Set(["node_modules", "test", ".DS_Store", ".git", ".local", ".demos", ".check", ".cache", "package.mjs"])

const TEMP = path.join(os.tmpdir(), "designlayer-mac-package")
const STAGE = path.join(TEMP, "stage")
const TOP = path.join(STAGE, PRODUCT)
const PAYLOAD = path.join(TOP, "payload")

function fail(message) {
  console.error(`\n  package.mjs: ${message}\n`)
  process.exit(1)
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options })
  if (result.error) fail(`${cmd} could not run: ${result.error.message}`)
  if (result.status !== 0) fail(`${cmd} ${args.join(" ")} exited with ${result.status}`)
}

function copyPayload() {
  for (const file of PAYLOAD_FILES) {
    const from = path.join(REPO_ROOT, file)
    if (!fs.existsSync(from)) fail(`missing ${file}`)
    fs.mkdirSync(path.dirname(path.join(PAYLOAD, file)), { recursive: true })
    fs.copyFileSync(from, path.join(PAYLOAD, file))
    fs.chmodSync(path.join(PAYLOAD, file), fs.statSync(from).mode & 0o777)
  }
  for (const dir of PAYLOAD_DIRS) {
    fs.cpSync(path.join(REPO_ROOT, dir), path.join(PAYLOAD, dir), {
      recursive: true,
      filter: (src) => !EXCLUDE.has(path.basename(src)) && !src.endsWith(".log"),
    })
  }
}

/** node_modules to build against: this checkout's, or a clean install when it has none. */
function buildDeps() {
  const local = path.join(REPO_ROOT, "node_modules")
  if (!flag("--fresh-deps") && fs.existsSync(path.join(local, "esbuild"))) return local
  const deps = path.join(TEMP, "deps")
  fs.mkdirSync(deps, { recursive: true })
  for (const file of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(REPO_ROOT, file), path.join(deps, file))
  console.log("Installing build dependencies (npm ci) in a temporary directory…")
  // --ignore-scripts: the root `prepare` script would run build.mjs, which is not in this directory.
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: deps })
  return path.join(deps, "node_modules")
}

function buildDist() {
  const link = path.join(PAYLOAD, "node_modules")
  fs.symlinkSync(buildDeps(), link, "dir")
  try {
    run(process.execPath, ["build.mjs"], { cwd: PAYLOAD })
  } finally {
    fs.unlinkSync(link)
  }
  // The stamp records mtimes of files on this machine; it can only ever read as
  // "not current" on the user's, so it is dead weight. The launcher re-proves dist/.
  fs.rmSync(path.join(PAYLOAD, "dist", ".build-stamp.json"), { force: true })
  if (!fs.existsSync(path.join(PAYLOAD, "dist", "designlayer.js"))) fail("build.mjs did not write dist/designlayer.js")
}

const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version

const INSTALL_SCRIPT = String.raw`#!/bin/bash
# Installs ${PRODUCT} for this macOS user. Double-click it in Finder, or run it
# from Terminal. Arguments go on to desktop/mac/install.mjs (for example --dry-run).
set -u
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$HERE/payload"
SUPPORT="$HOME/Library/Application Support/Design Layer"
APP="$SUPPORT/app"
STAGING="$SUPPORT/app.installing"
LOGS="$HOME/Library/Logs/DesignLayer"
LOG="$LOGS/install.log"
TOTAL=7
CURRENT="start"

# A shell started from Finder may not have Homebrew on its PATH.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

say() { printf '%s\n' "$*"; }
step() { CURRENT="$1/$TOTAL $2"; say ""; say "[$1/$TOTAL] $2"; }
fail() {
  say ""
  say "Install failed at step [$CURRENT]."
  [ $# -gt 0 ] && say "  $*"
  say "Log: $LOG"
  exit 1
}
# Runs a command with its output in the log only.
quiet() { "$@" >>"$LOG" 2>&1 || fail "This command failed: $*"; }

case "$HOME" in
  /*) ;;
  *) say "HOME is not set to an absolute path; refusing to install."; exit 1 ;;
esac
mkdir -p "$LOGS" || { say "Cannot create $LOGS"; exit 1; }
printf '\n=== %s install %s %s\n' "$(date)" "${version}" "$*" >>"$LOG"

say "${PRODUCT} ${version} installer"
say "Log: $LOG"

step 1 "Check macOS"
[ "$(uname -s)" = "Darwin" ] || fail "${PRODUCT} for Mac needs macOS."
say "  macOS $(sw_vers -productVersion 2>/dev/null)"

step 2 "Check Node.js 20.9 or newer"
NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null)"
if [ -z "$NODE_VERSION" ] || ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 9) ? 0 : 1)' 2>/dev/null; then
  say "  Node.js 20.9 or newer is required (found: ${"$"}{NODE_VERSION:-none})."
  say "  Install it with Homebrew:   brew install node"
  say "  or download it from:        https://nodejs.org"
  say "  Then run this installer again."
  fail "Node.js is missing or too old."
fi
command -v npm >/dev/null 2>&1 || fail "npm was not found next to node ($(command -v node)). Reinstall Node.js."
say "  node $NODE_VERSION at $(command -v node)"

step 3 "Check Chrome"
CHROME_APP=""
for app in /Applications/*" Chrome.app" "$HOME"/Applications/*" Chrome.app"; do
  if [ -d "$app" ]; then CHROME_APP="$app"; break; fi
done
if [ -n "$CHROME_APP" ]; then
  say "  $CHROME_APP"
else
  fail "Chrome is required (the app window is a Chrome web app)."
fi

step 4 "Copy ${PRODUCT} to $APP"
[ -f "$PAYLOAD/package.json" ] || fail "No payload next to this script ($PAYLOAD). Unzip the whole download and run the installer from it."
case "$STAGING" in */"Library/Application Support/Design Layer/app.installing") ;; *) fail "Unexpected install path $STAGING" ;; esac
quiet rm -rf "$STAGING"
quiet mkdir -p "$SUPPORT"
quiet cp -R "$PAYLOAD" "$STAGING"
say "  copied"

step 5 "Install dependencies (npm, about a minute)"
cd "$STAGING" || fail "Cannot enter $STAGING"
if [ -f package-lock.json ]; then
  quiet npm ci --omit=dev --no-audit --no-fund
else
  quiet npm install --omit=dev --no-audit --no-fund
fi
say "  done"

step 6 "Check the editor bundle"
if [ ! -f dist/designlayer.js ]; then
  say "  dist/ is missing: building it"
  quiet node build.mjs
fi
quiet node cli.mjs --verify
say "  dist/ present, vendor patch applies"

step 7 "Install the ${PRODUCT} app"
cd "$HOME" || fail "Cannot enter $HOME"
case "$APP" in */"Library/Application Support/Design Layer/app") ;; *) fail "Unexpected install path $APP" ;; esac
quiet rm -rf "$APP"
quiet mv "$STAGING" "$APP"
say "  installed files: $APP"
cd "$APP" || fail "Cannot enter $APP"
node desktop/mac/install.mjs "$@" 2>&1 | while IFS= read -r line; do
  printf '  | %s\n' "$line"
  printf '%s\n' "$line" >>"$LOG"
done
STATUS=$?
if [ $STATUS -ne 0 ]; then
  fail "desktop/mac/install.mjs exited with $STATUS."
fi

# Written with cat, not cp: a new file has no quarantine flag, so macOS opens
# it on a double-click instead of refusing it as an unverified download.
UNINSTALLER="$SUPPORT/Uninstall ${PRODUCT}.command"
rm -f "$SUPPORT/uninstall.command"
cat "$APP/uninstall.command" >"$UNINSTALLER" 2>>"$LOG" && chmod 755 "$UNINSTALLER"

say ""
case " $* " in
  *" --dry-run "*) say "Dry run finished: files copied to $APP, nothing loaded or launched. Logs: $LOGS" ;;
  *) say "Done. Logs: $LOGS" ;;
esac
say "To uninstall, double-click \"$UNINSTALLER\" or run: bash \"$UNINSTALLER\""
`

const UNINSTALL_SCRIPT = String.raw`#!/bin/bash
# Uninstalls ${PRODUCT}: removes the LaunchAgent, the Chrome app and its
# profile (desktop/mac/install.mjs --uninstall), then offers to delete the
# installed files. Arguments go on to install.mjs (for example --yes, --dry-run).
set -u

SUPPORT="$HOME/Library/Application Support/Design Layer"
APP="$SUPPORT/app"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

YES=0
DRY=0
for arg in "$@"; do
  [ "$arg" = "--yes" ] && YES=1
  [ "$arg" = "--dry-run" ] && DRY=1
done

case "$HOME" in /*) ;; *) echo "HOME is not set to an absolute path; refusing to run."; exit 1 ;; esac

if [ ! -f "$APP/desktop/mac/install.mjs" ]; then
  echo "${PRODUCT} is not installed at $APP."
  exit 0
fi
command -v node >/dev/null 2>&1 || { echo "node was not found. Install it (brew install node) and run this again."; exit 1; }

echo "[1/2] Remove the ${PRODUCT} app and its LaunchAgent"
(cd "$APP" && node desktop/mac/install.mjs --uninstall "$@") || { echo "install.mjs --uninstall failed."; exit 1; }

echo ""
echo "[2/2] Delete the installed files at $APP"
if [ $DRY -eq 1 ]; then
  echo "  (dry run) would delete $APP"
  exit 0
fi
ANSWER="n"
if [ $YES -eq 1 ]; then
  ANSWER="y"
elif [ -t 0 ]; then
  read -r -p "  Delete $APP? [y/N] " ANSWER
fi
case "$ANSWER" in
  [yY]*)
    rm -rf "$APP"
    rm -f "$SUPPORT/Uninstall ${PRODUCT}.command"
    rmdir "$SUPPORT" 2>/dev/null
    echo "  deleted"
    ;;
  *) echo "  kept (delete it yourself any time)" ;;
esac
echo ""
echo "Done. Logs are kept in ~/Library/Logs/DesignLayer/."
`

const README = `${PRODUCT} for Mac ${version}

${PRODUCT} is a visual editor that attaches to your running React or
Angular app and writes each change back to the component source. This package
installs it as a Mac app: a small background service plus a Chrome
app window you can keep in the Dock.

Requirements: macOS, Node.js 20.9 or newer (brew install node, or
https://nodejs.org), and Chrome.

Install, with no security prompt: open Terminal, type "bash " (with the
space), drag "Install ${PRODUCT}.command" into the window, and press Return.

Double-clicking "Install ${PRODUCT}.command" also works, but nothing here is
signed, by design (why: ${WHY_UNSIGNED_URL}),
so macOS first says "Apple could not verify" it "is free of malware". To
allow it: click Done, open System Settings > Privacy & Security, scroll to
Security, click Open Anyway, then Open.

The files go to ~/Library/Application Support/Design Layer/app.

Uninstall: in Terminal, run
  bash ~/Library/Application\\ Support/Design\\ Layer/Uninstall\\ Design\\ Layer.command

Logs: ~/Library/Logs/DesignLayer/ (install.log, desk.log, start-screen.log)

Source: ${SOURCE_URL}
`

function writeScripts() {
  const write = (name, body, mode) => {
    fs.writeFileSync(path.join(TOP, name), body)
    fs.chmodSync(path.join(TOP, name), mode)
  }
  write(`Install ${PRODUCT}.command`, INSTALL_SCRIPT, 0o755)
  fs.writeFileSync(path.join(PAYLOAD, "uninstall.command"), UNINSTALL_SCRIPT, { mode: 0o755 })
  write("README.txt", README, 0o644)
}

/* ---------- zip ---------- */

function hasZip() {
  return !spawnSync("zip", ["-v"], { stdio: "ignore" }).error
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980)
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** A plain zip (no zip64) with Unix modes in the external attributes, so the .command files stay executable. */
function writeZipWithNode(zipFile, baseDir, topName) {
  const entries = []
  const walk = (rel) => {
    const stat = fs.statSync(path.join(baseDir, rel))
    entries.push({ rel, stat })
    if (stat.isDirectory()) for (const name of fs.readdirSync(path.join(baseDir, rel)).sort()) walk(path.posix.join(rel, name))
  }
  walk(topName)

  const chunks = []
  const central = []
  let offset = 0
  for (const { rel, stat } of entries) {
    const dir = stat.isDirectory()
    const name = Buffer.from(dir ? `${rel}/` : rel, "utf8")
    const data = dir ? Buffer.alloc(0) : fs.readFileSync(path.join(baseDir, rel))
    const deflated = dir ? data : zlib.deflateRawSync(data, { level: 9 })
    const method = deflated.length < data.length ? 8 : 0
    const body = method === 8 ? deflated : data
    const crc = crc32(data)
    const { time, date } = dosDateTime(stat.mtime)
    const mode = dir ? 0o40755 : 0o100000 | (stat.mode & 0o777)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, name, body)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE((3 << 8) | 20, 4) // made by Unix
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt16LE(time, 12)
    record.writeUInt16LE(date, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(body.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(((mode << 16) | (dir ? 0x10 : 0)) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += local.length + name.length + body.length
  }
  const centralSize = central.reduce((sum, b) => sum + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  fs.writeFileSync(zipFile, Buffer.concat([...chunks, ...central, end]))
  return entries.length
}

function writeZip(zipFile) {
  fs.rmSync(zipFile, { force: true })
  if (!flag("--node-zip") && hasZip()) {
    run("zip", ["-r", "-X", "-q", "-9", zipFile, PRODUCT], { cwd: STAGE })
    return "zip"
  }
  if (!flag("--node-zip")) console.log("`zip` not found: writing the archive with the built-in writer.")
  writeZipWithNode(zipFile, STAGE, PRODUCT)
  return "built-in writer"
}

/* ---------- main ---------- */

const countFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0)

try {
  fs.rmSync(TEMP, { recursive: true, force: true })
  fs.mkdirSync(PAYLOAD, { recursive: true })
  console.log(`Assembling ${PRODUCT} ${version} in ${TOP}`)
  copyPayload()
  buildDist()
  writeScripts()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const zipFile = path.join(OUT_DIR, ZIP_NAME)
  const how = writeZip(zipFile)
  const size = fs.statSync(zipFile).size
  const shown = path.relative(process.cwd(), zipFile).startsWith("..") ? zipFile : path.relative(process.cwd(), zipFile)
  console.log(`\nWrote ${shown} (${(size / 1024 / 1024).toFixed(2)} MB, ${size} bytes, ${how})`)
  console.log(`  ${PRODUCT}/Install ${PRODUCT}.command`)
  console.log(`  ${PRODUCT}/README.txt`)
  console.log(`  ${PRODUCT}/payload/ (${countFiles(PAYLOAD)} files, dist/ prebuilt)`)
} finally {
  fs.rmSync(TEMP, { recursive: true, force: true })
}
