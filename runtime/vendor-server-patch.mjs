/**
 * One fix to the vendor's server-side batch writer, made as its module loads.
 *
 * `coalesceOps` in `react-rewrite-cli/dist/batch-transform.js` merges class
 * updates aimed at one JSX node, and it decided "one node" by `line:col`. Under
 * React 19 the client reports 0:0 for every element, so a commit carrying edits
 * to two elements in one file folded the second element's updates into the
 * first element's operation: the first node got both, the second got nothing,
 * and both reported success. A multi-selection edit and any two pending edits
 * in one file hit it. Grouping by the node the resolver already found keeps one
 * node's updates together and different nodes apart.
 *
 * Same contract as `vendor-patch.mjs`: the package stays untouched on disk, the
 * anchor must match exactly once, and a vendor build without it fails loudly
 * instead of silently writing to the wrong element.
 */

import module from "node:module"

export const BATCH_ANCHOR = "const key = `${rop.op.line}:${rop.op.col}`;"
const BATCH_FIX = "const key = rop.node;"
const BATCH_FILE = /\/react-rewrite-cli\/dist\/batch-transform\.js$/

export function patchBatchSource(source) {
  const count = source.split(BATCH_ANCHOR).length - 1
  if (count !== 1) {
    throw new Error(`react-rewrite-cli batch-transform.js: expected the coalesce key once, found ${count}`)
  }
  return source.replace(BATCH_ANCHOR, BATCH_FIX)
}

let installed = false

/**
 * Installs the load hook. Stays installed for the life of the process: the
 * Apply rehearsal (`apply-ahead.mjs`) can load the module after the launch.
 * `module.registerHooks` is Node 22.15/23.5 and later; on an older Node the
 * vendor keeps its own grouping.
 */
export function installVendorServerPatch() {
  if (installed) return true
  if (typeof module.registerHooks !== "function") return false
  module.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      if (!BATCH_FILE.test(url)) return result
      const source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8")
      return { ...result, source: patchBatchSource(source) }
    },
  })
  installed = true
  return true
}
