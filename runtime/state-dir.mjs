/**
 * Where this machine's DesignLayer state lives, and the one way a file there is
 * written.
 *
 * Four stores share the folder: the editor registry (`editors/`), the port pair
 * each app was given (`ports.json`), the page each app was last on (`pages/`)
 * and the editor's cross-origin storage (`storage/`). Each used to derive the
 * folder from the registry's path and to carry its own copy of the
 * temp-and-rename write, with two different rules for the temp name. One root
 * and one writer keep the four agreeing about where they are and how a reader
 * is protected from half a file.
 *
 * A leaf: it imports nothing of this package, so any store can import it
 * without pulling another store in for a path.
 *
 * The writer is the package's only temp-and-rename: the server's stores (the
 * options file, a control default's source, the lint ignore list, the library
 * list and credentials) and the desk's tab file import it from here too, so a
 * fix to how a reader is protected lands everywhere at once.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * `~/.local/state/designlayer`: one folder for the whole machine, outside any
 * project, so every editor sees every other editor's state whichever project
 * it was started in. Resolved per call, because tests point `HOME` at a temp
 * folder after this module has loaded.
 */
export function stateRoot() {
  return path.join(os.homedir(), ".local", "state", "designlayer")
}

/*
 * Beside the target, so the rename stays on one file system. Unique per write,
 * not only per process, because one process can write the same file twice
 * before the first rename lands. A dotfile ending in `.tmp`, so a reader that
 * lists `*.json` never parses it and a dev server watching a project folder
 * (a control default rewrites a component's source) does not see a new module.
 */
function temporaryFor(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`)
}

/**
 * Writes `text` to `file` so that a reader sees the old file or the new one,
 * never half of either: written beside it under a temp name and renamed over
 * it. Creates the folder first. `mode` applies to the temp file at creation,
 * before it holds any content, which is how a credential file is never
 * readable by anyone else for even a moment.
 *
 * Throws what the file system threw, after removing the temp file. Every store
 * in `runtime/` treats a failed write as a lost memory rather than a failed
 * launch, so each catches; the endpoint file catches to print why.
 */
export function writeFileAtomic(file, text, { mode } = {}) {
  const temp = temporaryFor(file)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, text, mode === undefined ? "utf8" : { encoding: "utf8", mode })
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      /* nothing else to try */
    }
    throw error
  }
}

/** `writeFileAtomic` for a caller on the server's request path, which must not block. */
export async function writeFileAtomicAsync(file, text, { mode } = {}) {
  const temp = temporaryFor(file)
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(temp, text, mode === undefined ? "utf8" : { encoding: "utf8", mode })
    await fs.promises.rename(temp, file)
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/*
 * One project has many spellings: a symlinked folder, a trailing slash, a
 * relative path. The supervisor, the start screen and each editor's config all
 * name the root their own way, so a key built from a root uses the real folder,
 * or none of them would find what another wrote. A folder that cannot be
 * resolved (gone, or one macOS will not stat) keeps its resolved spelling.
 */
export function realRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return ""
  try {
    return fs.realpathSync(projectRoot)
  } catch {
    return path.resolve(projectRoot)
  }
}
