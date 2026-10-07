/**
 * Keeps jscodeshift out of the launch, and loads it on its first use.
 *
 * The vendor's `transform.js` imports jscodeshift at module scope, and its
 * `server.js` imports `transform.js` the same way, so every launch built
 * jscodeshift, recast, ast-types and their parsers before the proxy could bind:
 * ~20ms of a ~100ms launch, measured, spent on an engine that is first needed
 * when a change is written to source — which the editor rehearses while the
 * edits settle (`apply-ahead.mjs`), so the click never waits for it either.
 *
 * The package stays untouched on disk. While the vendor's modules load, a
 * resolve hook answers `transform.js`'s `import jscodeshift` with a stand-in:
 * a proxy whose every use — `jscodeshift.withParser(…)` is the only one there
 * is, always inside a function — requires the real module and forwards to it.
 * `require` returns the same instance to everyone, so a patch made on the real
 * module (`apply-ahead.mjs` wraps `withParser`) is the module the vendor uses.
 *
 * `module.registerHooks` is Node 22.15/23.5 and later; on an older Node this
 * does nothing and jscodeshift loads with the vendor, as it always did.
 */

import fs from "node:fs"
import module from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

const STAND_IN = "designlayer:lazy-jscodeshift"
const HTTP_STAND_IN = "designlayer:required-http"

/*
 * `node:http` as the vendor's modules see it, required rather than imported.
 *
 * An ES module import of `node:http` copies every export into a namespace, and
 * the copy reads the lazy getters Node keeps for the fetch-era globals, which
 * loads all of undici (~8ms) before the proxy can bind — and the vendor's
 * `inject.js` does exactly that (`import * as http from "node:http"`). This
 * stand-in re-exports the same functions and classes from `require`, minus the
 * lazy getters, which nothing in the vendor reads. `runtime/start-screen.mjs`
 * makes the same trade for the same reason.
 */
function httpStandInSource() {
  const http = module.createRequire(import.meta.url)("node:http")
  const names = Object.keys(http).filter((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(http, name)
    return descriptor && !descriptor.get && /^[A-Za-z_$][\w$]*$/.test(name)
  })
  return `import { createRequire } from "node:module"
const http = createRequire(${JSON.stringify(import.meta.url)})("node:http")
export default http
${names.map((name) => `export const ${name} = http.${name}`).join("\n")}
`
}

/** Installs the hook for the vendor at `vendorEntry`; returns its removal. */
export function deferVendorTransform(vendorEntry) {
  if (typeof module.registerHooks !== "function") return () => {}
  let transformUrl
  try {
    // The loader names modules by their real path, so a symlinked install
    // compares by that too.
    transformUrl = pathToFileURL(fs.realpathSync(path.join(path.dirname(vendorEntry), "transform.js"))).href
  } catch {
    return () => {}
  }
  const source = `import { createRequire } from "node:module"
const require = createRequire(${JSON.stringify(transformUrl)})
let real = null
const load = () => (real ??= require("jscodeshift"))
export default new Proxy(() => {}, {
  apply: (_, self, args) => Reflect.apply(load(), self, args),
  get: (_, key) => Reflect.get(load(), key),
  set: (_, key, value) => Reflect.set(load(), key, value),
  has: (_, key) => Reflect.has(load(), key),
})
`
  const vendorDir = transformUrl.slice(0, transformUrl.lastIndexOf("/") + 1)
  let httpSource = null
  const hooks = module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "jscodeshift" && context.parentURL === transformUrl) {
        return { url: STAND_IN, format: "module", shortCircuit: true }
      }
      if ((specifier === "node:http" || specifier === "http") && context.parentURL?.startsWith(vendorDir)) {
        return { url: HTTP_STAND_IN, format: "module", shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === STAND_IN) return { format: "module", source, shortCircuit: true }
      if (url === HTTP_STAND_IN) return { format: "module", source: (httpSource ??= httpStandInSource()), shortCircuit: true }
      return nextLoad(url, context)
    },
  })
  return () => hooks.deregister()
}
