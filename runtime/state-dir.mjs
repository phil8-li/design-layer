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
 * `server/file-io.mjs` has a second atomic writer for files inside a project.
 * The two do the same thing for different callers; when one owner takes both,
 * this one is the model (unique temp name per write, temp removed on failure).
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

/**
 * Writes `text` to `file` so that a reader sees the old file or the new one,
 * never half of either: written beside it under a temp name and renamed over
 * it. The temp name is unique per write, not only per process, because one
 * process can write the same file twice before the first rename lands, and it
 * ends in `.tmp`, so a reader that lists `*.json` never parses it.
 *
 * Throws what the file system threw, after removing the temp file. Every store
 * here treats a failed write as a lost memory rather than a failed launch, so
 * each catches; the endpoint file catches to print why.
 */
export function writeFileAtomic(file, text) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, text, "utf8")
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
