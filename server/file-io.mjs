/**
 * The two pieces of file I/O the whole-project reads (pages, component usage)
 * share.
 *
 * Both stat and read every source file under the project, and what that costs
 * on a first read is the thread pool's syscalls, not the bytes.
 */

import fs from "node:fs"

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
