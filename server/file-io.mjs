/**
 * The file I/O the server modules share.
 *
 * The whole-project reads (pages, component usage) stat and read every source
 * file under the project, and what that costs on a first read is the thread
 * pool's syscalls, not the bytes: hence the limiter, the known-size read and
 * the per-file cache. The small stores (options, control defaults, the MCP
 * setting) write whole files, and a write cut short must never leave half of
 * one: hence the atomic writers.
 */

import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/** Beside the target, so the rename stays on one file system; unique per write. */
function temporaryFor(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
}

/**
 * Writes `text` to `file` so a reader sees the old file or the new one, never
 * a part. Creates the folder first.
 */
export async function writeAtomic(file, text) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const temporary = temporaryFor(file)
  try {
    await fs.promises.writeFile(temporary, text, "utf8")
    await fs.promises.rename(temporary, file)
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** `writeAtomic` for a caller that cannot wait, such as a setting saved mid-move. */
export function writeAtomicSync(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = temporaryFor(file)
  try {
    fs.writeFileSync(temporary, text, "utf8")
    fs.renameSync(temporary, file)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * What one file contributed, kept while its `mtimeMs:size` holds.
 *
 * The rule the server's readers share: a stat that still matches answers from
 * memory, a stat that does not is a changed file and is read again, and a file
 * a complete walk no longer reached is forgotten (`keepOnly`), so the cache
 * stays the size of the project. A truncated walk forgets nothing, since it
 * did not look everywhere.
 */
export function createFileCache() {
  const entries = new Map()
  return {
    /** The value stored for `file` under this stat, or undefined. */
    get(file, stats) {
      const entry = entries.get(file)
      return entry && entry.mtimeMs === stats.mtimeMs && entry.size === stats.size ? entry.value : undefined
    },
    set(file, stats, value) {
      entries.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, value })
      return value
    },
    /** Forgets every file not in `seen` for which `owns(file)` holds (default: all). */
    keepOnly(seen, owns = () => true) {
      for (const file of entries.keys()) if (!seen.has(file) && owns(file)) entries.delete(file)
    },
    get size() {
      return entries.size
    },
  }
}

/**
 * A gate that runs at most `limit` tasks at once, in the order they arrive.
 *
 * One at a time, each file paid a full open/read/close round trip in series.
 * Fixed batches did better but waited on each batch's slowest file; a gate
 * keeps the disk busy without holding a descriptor per file in the project,
 * and lets a walk hand files over as it finds them, so the reading starts
 * before the walk ends.
 */
export function createLimiter(limit = 32) {
  const queue = []
  let next = 0
  let active = 0
  const pump = () => {
    while (active < limit && next < queue.length) {
      const { task, resolve, reject } = queue[next]
      queue[next++] = null
      active += 1
      task()
        .then(resolve, reject)
        .finally(() => {
          active -= 1
          pump()
        })
    }
  }
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject })
      pump()
    })
}

/**
 * A file's text, read with the size a stat of it already gave.
 *
 * `readFile` opens, stats, reads and closes, through a promise-wrapped file
 * handle; with the size in hand this opens, reads and closes, a quarter fewer
 * trips through the pool per file. One byte more than the stat said is asked
 * for, so a file that grew since is noticed and read whole rather than cut
 * short.
 */
export function readKnownSize(file, size) {
  return new Promise((resolve, reject) => {
    fs.open(file, "r", (openError, fd) => {
      if (openError) return reject(openError)
      const buffer = Buffer.allocUnsafe(size + 1)
      fs.read(fd, buffer, 0, size + 1, 0, (readError, bytesRead) => {
        fs.close(fd, () => {})
        if (readError) return reject(readError)
        if (bytesRead > size) return resolve(fs.promises.readFile(file, "utf8"))
        resolve(buffer.toString("utf8", 0, bytesRead))
      })
    })
  })
}
