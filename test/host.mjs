/**
 * Where this package is, and where the host app is. One owner for both.
 *
 * The editor is its own repository now, so a test has two roots to keep apart
 * and they are no longer parent and child:
 *
 *   PACKAGE_DIR — this repo. Everything the editor ships resolves from here.
 *   hostRoot()  — a real Next.js app the editor is pointed at. Optional.
 *
 * Four suites (token, responsive, picker, icon-set) deliberately pin a host's
 * own numbers; the comments at the top of each say why. That regression net
 * only exists when a host is actually on disk, so those suites ask for one here
 * rather than each recomputing a relative path — the moment two of them spell
 * the guess differently, three suites run and the fourth silently does not.
 *
 * Resolution order: DESIGNLAYER_HOST, then the sibling checkout. When neither
 * is there the suite prints why it is skipping and exits 0, so `npm test` still
 * passes in a bare clone and nobody reads a skip as a pass.
 *
 * The pinned numbers are one particular host app's, so pointing DESIGNLAYER_HOST
 * at a different app makes those four suites fail on the counts rather than on
 * the contract. That is the trade for having a real host in the net at all.
 */

import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

/**
 * A `navigator` global, on the Node versions that do not have one.
 *
 * Node made `navigator` a global in 21. The suite's floor is 20.19, and on 20
 * the bare identifier resolves to nothing — which matters because several
 * suites bundle a browser module and evaluate it here, and anything reaching
 * `core/toast.ts` pulls in sonner and therefore react-dom, which reads
 * `navigator` at module scope. jsdom gives its own window one, but react-dom
 * asks the global.
 *
 * Failing that way is expensive to read rather than merely red: the thrown
 * `ReferenceError` carries a stack whose every frame is the base64 data URL the
 * module was imported from, so one missing global prints thirteen megabytes on
 * a single line and a CI job spends nine minutes streaming it.
 *
 * Only the two properties those modules actually read, and only when the
 * runtime has not supplied the real thing. On 21 and up this is a no-op.
 */
if (typeof globalThis.navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: `Node.js/${process.versions.node}`, platform: process.platform },
    configurable: true,
    writable: true,
  })
}

export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url))

/** The default host: a `host-app` checkout beside this one. */
const SIBLING_HOST = path.join(path.dirname(PACKAGE_DIR), "host-app")

export function hostRoot() {
  const configured = process.env.DESIGNLAYER_HOST
  const candidate = configured ? path.resolve(configured) : SIBLING_HOST
  return fs.existsSync(path.join(candidate, "designlayer.config.mjs")) ? candidate : null
}

/**
 * The host config path, or a printed skip and a clean exit.
 *
 * Exits rather than returns null because these suites read the config at module
 * scope; letting them continue would run every assertion against `undefined`
 * and report a wall of failures whose real cause is one absent directory.
 */
export function requireHostConfig(suite) {
  const root = hostRoot()
  if (!root) {
    console.log(
      `\n${suite}: SKIPPED — no host app found.\n` +
        `  Looked for designlayer.config.mjs in ${SIBLING_HOST}\n` +
        "  Set DESIGNLAYER_HOST=/path/to/the/app to run it.\n" +
        "  The host-agnostic contract is proved without a host, in host-agnostic-cases.mjs."
    )
    process.exit(0)
  }
  return { root, configPath: path.join(root, "designlayer.config.mjs") }
}

/**
 * The vendored overlay bundle, wherever npm put it.
 *
 * `node_modules/…` used to be spelled relative to the host repo root, which was
 * this package's parent. It is not any more, and it depends on hoisting either
 * way, so ask the resolver instead of guessing a directory.
 */
export function vendorOverlayPath() {
  return createRequire(import.meta.url).resolve("react-rewrite-cli/dist/overlay.js")
}
