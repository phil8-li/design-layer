/**
 * Works out an Apply before it is clicked, so the click only has to write.
 *
 * The vendor's `commitBatch` runs its batch transform when the message lands:
 * read the file, parse it with jscodeshift, find the elements, rewrite their
 * classes, reprint the file with recast, write it. Parsing and reprinting are
 * most of that, measured at 3-4ms of a 4-5ms click-to-disk on a 19-line
 * component, and both depend only on the file's text and the operations — both
 * of which are known well before the click. The editor sends the pending
 * operations as `designlayer:applyAhead` once the edits settle, and this module
 * runs the vendor's own `executeBatch` on them with writes captured instead of
 * made, then parses a spare copy of each file it would change.
 *
 * At the click the vendor still runs its handler, unchanged: it reads, resolves
 * and applies against the spare tree, records its undo entry and answers. Two
 * steps are taken from the rehearsal instead of redone — the parse returns the
 * spare tree, and the reprint returns the text the rehearsal printed. That is
 * the same text by construction, and only offered when it is: the operations
 * must be the rehearsed ones exactly, the file must still read exactly as it
 * did (the vendor's own read is what is compared, so an edit made underneath by
 * the user or an agent is simply a miss), and the vendor must reach the parse
 * inside this message's own delivery — a commit queued behind another write
 * runs later, unaided. Anything else is the vendor's ordinary path.
 *
 * Every hook is into the vendor's own objects, so nothing here can write a file
 * the vendor would not have written: the rehearsal's writes go nowhere, and the
 * real write is still the vendor's.
 */

import fs from "node:fs"
import path from "node:path"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { pathToFileURL } from "node:url"

/** The message the editor sends with the operations an Apply would commit now. */
export const APPLY_AHEAD = "designlayer:applyAhead"

const isMessage = (text, type) => text.startsWith(`{"type":"${type}"`)

/**
 * The rehearsal and the two hooks, over the vendor's modules.
 *
 * Separate from `installApplyAhead` so the suite can drive it with the real
 * transform and a stand-in socket.
 */
export function createApplyAhead({ jscodeshift, loadJscodeshift = () => jscodeshift, executeBatch, getParser, projectRoot }) {
  /** The last rehearsal: `{ key, bySource: Map<parser\0source, { after, spare }> }`. */
  let rehearsed = null
  /** The rehearsal a commit being delivered right now may draw on. */
  let armed = null
  let pending = null
  /** jscodeshift's own `withParser`, once the hook below is on it. */
  let realWithParser = null

  /**
   * Runs the vendor's batch with every write captured, and keeps what it would
   * write.
   *
   * Class updates only, which is what an Apply from the editor sends. Their
   * outcome is a function of the operations and the file's text and nothing
   * else, which is what makes a rehearsed reprint the same text as a real one.
   * An operation carrying the vendor's staleness stamp (`fileMtime`) is
   * answered from the file's clock, a reorder or a text edit changes which
   * elements exist mid-batch — so a batch holding any of those is not
   * rehearsed and commits the ordinary way.
   */
  const rehearse = (key, operations) => {
    rehearsed = null
    const plain = operations.every((op) => op?.op === "updateClass" && op.fileMtime == null)
    if (!plain || !hookParse()) return
    const writeFileSync = fs.writeFileSync
    let outcome = null
    // The vendor reaches `fs` through an ESM namespace, which follows the CJS
    // object only when told to. Restored, and re-synced, before anything else
    // can run: the whole rehearsal is one synchronous call.
    fs.writeFileSync = () => {}
    syncBuiltinESMExports()
    try {
      outcome = executeBatch(structuredClone(operations), projectRoot())
    } catch {
      outcome = null
    } finally {
      fs.writeFileSync = writeFileSync
      syncBuiltinESMExports()
    }
    if (!outcome || outcome.undoEntries.length === 0) return
    if (!outcome.results.every((result) => result?.success)) return
    const bySource = new Map()
    for (const entry of outcome.undoEntries) {
      const parser = getParser(entry.filePath)
      const id = `${parser}\0${entry.content}`
      // Two files with the same text would be told apart only by path, which
      // the parse never sees.
      if (bySource.has(id)) return
      const j = realWithParser(parser)
      const spare = j(entry.content)
      /*
       * The element search, done now as well. Each operation is resolved by
       * walking every JSX element in the file, and a class update adds or
       * removes none, so the walk's answer holds for the whole commit — which
       * is the half of the vendor's remaining work this can take off the click.
       */
      const elements = spare.find(j.JSXElement)
      const find = spare.find
      spare.find = function findRehearsed(type, filter) {
        return type === j.JSXElement && filter === undefined ? elements : find.call(this, type, filter)
      }
      bySource.set(id, { after: entry.afterContent, spare })
    }
    rehearsed = { key, bySource }
  }

  /*
   * The parse hook, put on jscodeshift by the first rehearsal rather than at
   * launch, which jscodeshift is kept out of (`vendor-lazy.mjs`). Nothing is
   * lost by waiting: a commit only ever draws on a rehearsal, and every
   * rehearsal has put the hook on first. False when this jscodeshift has no
   * `withParser` to hook, and nothing is rehearsed.
   */
  const hookParse = () => {
    if (realWithParser) return true
    const j = loadJscodeshift()
    if (typeof j?.withParser !== "function") return false
    realWithParser = j.withParser
    j.withParser = function withRehearsedParse(parser) {
      const parse = realWithParser.call(this, parser)
      const batch = armed
      if (!batch) return parse
      return new Proxy(parse, {
        apply(target, self, args) {
          const id = typeof args[0] === "string" ? `${parser}\0${args[0]}` : null
          const file = id === null ? undefined : batch.bySource.get(id)
          if (!file) return Reflect.apply(target, self, args)
          batch.bySource.delete(id)
          const root = file.spare
          root.toSource = () => file.after
          return root
        },
      })
    }
    return true
  }

  /** Wraps a vendor `message` listener; `data` is what the launcher already normalized. */
  const wrapListener = (listener) =>
    function rehearsedMessage(data, ...args) {
      const text = String(data)
      if (isMessage(text, APPLY_AHEAD)) {
        let operations = null
        try {
          operations = JSON.parse(text).operations
        } catch {
          return
        }
        if (!Array.isArray(operations) || operations.length === 0) return
        const key = JSON.stringify(operations)
        if (rehearsed?.key === key) return
        // The latest edits only, and after this turn: the socket may already
        // hold the next edit's message, and the click may be right behind it.
        if (!pending) setImmediate(() => {
          // A commit that arrived first has already spent it.
          if (!pending) return
          const { key: latest, operations: latestOps } = pending
          pending = null
          rehearse(latest, latestOps)
        })
        pending = { key, operations }
        return
      }
      if (!isMessage(text, "commitBatch")) return listener.call(this, data, ...args)
      const batch = rehearsed
      // Spent either way: the commit changes the files it was rehearsed on.
      rehearsed = null
      pending = null
      try {
        if (batch && JSON.stringify(JSON.parse(text).operations) === batch.key) armed = batch
      } catch {
        armed = null
      }
      try {
        return listener.call(this, data, ...args)
      } finally {
        armed = null
      }
    }

  return { wrapListener }
}

/**
 * Installs the rehearsal over the vendor's socket. Called once, after the
 * launcher's own `WebSocket.prototype.on` patch and before the vendor starts.
 */
export async function installApplyAhead({ WebSocket, vendorEntry }) {
  const dist = path.dirname(vendorEntry)
  let modules
  try {
    modules = await Promise.all([
      import(pathToFileURL(path.join(dist, "batch-transform.js")).href),
      import(pathToFileURL(path.join(dist, "transform.js")).href),
    ])
  } catch {
    // A vendor laid out differently has nothing to rehearse with; its own
    // commit path is untouched.
    return
  }
  const [{ executeBatch }, { getParser }] = modules
  if (typeof executeBatch !== "function" || typeof getParser !== "function") return
  // The vendor's own root: `path.resolve(process.cwd())`, read when its server
  // starts, which is after the launcher has moved into the project.
  const { wrapListener } = createApplyAhead({
    // Resolved the way the vendor resolves it, so the module hooked is the one
    // it writes with; loaded by the first rehearsal (see `hookParse`).
    loadJscodeshift: () => createRequire(vendorEntry)("jscodeshift"),
    executeBatch,
    getParser,
    projectRoot: () => path.resolve(process.cwd()),
  })
  const on = WebSocket.prototype.on
  WebSocket.prototype.on = function onRehearsedMessage(event, listener) {
    return on.call(this, event, event === "message" ? wrapListener(listener) : listener)
  }
}
