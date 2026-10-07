/**
 * Every editor running on this machine, so that any one of them can list the
 * others.
 *
 * ## Why this exists
 *
 * The app chooser was built on the start screen: a supervisor keeps one screen
 * alive, the screen scans for apps, and switching means asking it to kill this
 * editor and spawn the next. That is a real way to run the editor and it still
 * works — but it is not the way most sessions actually look.
 *
 * The common shape is several editors, each started on its own against an app
 * that was already running, each with its proxy and socket pinned so they can
 * coexist. There is no supervisor in that picture and no screen to ask, so the
 * chooser had nothing to offer and said so: "this session was started without
 * the app chooser". Which was true, and useless — the machine had five editors
 * on it at the time.
 *
 * ## Why a registry rather than a port scan
 *
 * Every editor already writes an endpoint file naming its pid, its proxy port
 * and the project it was pointed at. The problem is only that it writes it
 * INSIDE that project (`<project>/.local/designlayer/endpoint.json`), so an
 * editor can read its own and nobody else's.
 *
 * Scanning ports instead was the obvious alternative and it is wrong here.
 * Prototypes do not sit on a guessable range: the five running while this was
 * written were on 4200, 5180, 5190, 5197 and 8080, and a scan of the usual
 * suspects would have found two of them. A registry reports what is actually
 * there, costs one small file per editor, and carries the project root — which
 * a scan can only guess at by reading paths out of a served page.
 *
 * ## Liveness
 *
 * An entry is a claim, not a fact: a process that is killed hard never gets to
 * withdraw its own. So every read checks the pid is still alive and quietly
 * sweeps the ones that are not, which also keeps the directory from growing a
 * file per editor ever run. `process.kill(pid, 0)` is the check — it sends no
 * signal and only reports whether the process exists.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * One directory for the whole machine, outside any project.
 *
 * `~/.local/state` is where this package already keeps per-user launch state,
 * and the point of the registry is to be somewhere every editor can see
 * regardless of which project it was started in — so it cannot live under a
 * project root the way the endpoint file does.
 */
export function registryDir() {
  return path.join(os.homedir(), ".local", "state", "designlayer", "editors")
}

/** One file per editor, named for the port it answers on, which is unique by construction. */
function entryPath(proxyPort) {
  return path.join(registryDir(), `${proxyPort}.json`)
}

/** Whether a pid names a process that is still running. Sends no signal. */
function alive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return error.code === "EPERM"
  }
}

/**
 * Publishes this editor. Called once the proxy has a port, because the port is
 * both the entry's name and the only useful thing in it.
 *
 * Never throws. A registry that cannot be written costs the chooser some rows;
 * it must not cost the editor its launch, which is the same bargain
 * `writeEndpointFile` already makes next door.
 */
export function publishEditor(entry) {
  if (!entry?.proxyPort) return
  // Written beside the entry and renamed over it. A plain write truncates
  // first, and another editor's `listEditors` reading in that window found a
  // half-written file, swept it as unparseable, and left this editor missing
  // from every chooser until it next published. A rename is all-or-nothing;
  // the temp name does not end in `.json`, so no reader ever parses it.
  const file = entryPath(entry.proxyPort)
  const temp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(registryDir(), { recursive: true })
    fs.writeFileSync(
      temp,
      `${JSON.stringify({ ...entry, pid: process.pid, startedAt: Date.now() }, null, 2)}\n`,
      "utf8"
    )
    fs.renameSync(temp, file)
  } catch {
    // See above: a missing row is not a reason to refuse to start.
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      /* nothing else to try */
    }
  }
}

/** Withdraws this editor on the way out, for the exits we are given notice of. */
export function withdrawEditor(proxyPort) {
  if (!proxyPort) return
  try {
    fs.rmSync(entryPath(proxyPort), { force: true })
  } catch {
    // A stale entry is swept by the liveness check on the next read.
  }
}

/**
 * Every editor currently running, oldest first, with the dead ones swept.
 *
 * Sorted by start time rather than by port so the list reads as the order the
 * designer opened things in, which is the order they think of them in. Ports
 * are assigned by whatever the launcher had free and carry no meaning.
 */
export function listEditors() {
  let names
  try {
    names = fs.readdirSync(registryDir())
  } catch {
    // No directory means no editor has ever published, which is an empty list
    // rather than a failure.
    return []
  }

  const editors = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const file = path.join(registryDir(), name)
    let entry
    try {
      entry = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      // Unreadable or half-written: sweep it and move on.
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* nothing else to try */
      }
      continue
    }
    if (!alive(entry?.pid) || typeof entry.proxyPort !== "number") {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* nothing else to try */
      }
      continue
    }
    editors.push(entry)
  }

  return editors.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
}
