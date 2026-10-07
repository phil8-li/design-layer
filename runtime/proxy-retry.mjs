/**
 * Retries a proxied GET or HEAD whose upstream connection failed, before the
 * vendor's proxy answers it with a 502.
 *
 * A dev server serves an app as a couple of thousand ES modules, and one module
 * that fails to arrive fails the whole graph: the app never mounts and the page
 * stays white. The vendor's proxy turns every upstream socket error into a 502,
 * and under load a loopback socket does fail now and then — a keep-alive socket
 * the dev server closed as it was reused, a connect that timed out behind a
 * full accept queue. Measured through `http-proxy` against a real Vite app: one
 * request in six thousand. One live page rarely meets it. A canvas board loads
 * a dozen copies of the app one after another, and on a large prototype it
 * showed a blank frame on most openings — one caught in the act as a 502 for a
 * single module in a frame whose app never mounted.
 *
 * Only idempotent requests are retried, only for connection-level errors, and
 * only while nothing has been sent to the browser. A dev server that is really
 * down still gets its 502 — after the retries, a few hundred milliseconds late.
 */

import { createRequire } from "node:module"

// Required, not imported: an ES import of `node:http` reads its lazy getters
// and loads undici (~8ms) on the launch path. See runtime/start-screen.mjs.
const http = createRequire(import.meta.url)("node:http")

const RETRYABLE = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "EADDRNOTAVAIL"])
export const PROXY_RETRIES = 2
const DELAY_MS = 100

/** Wraps one `http-proxy` server's `web` so a failed connection is tried again. */
export function withRetries(proxy, { retries = PROXY_RETRIES, delayMs = DELAY_MS } = {}) {
  if (!proxy || typeof proxy.web !== "function" || proxy.web.designlayerRetries) return proxy
  const web = proxy.web
  const retrying = function webWithRetries(req, res, ...rest) {
    // `web(req, res, [options], [callback])`: a callback takes the error from
    // `http-proxy` instead of its `error` event, which is what lets a retry
    // happen before the vendor's handler writes the 502.
    const callback = typeof rest.at(-1) === "function" ? rest.pop() : null
    const options = rest[0] ?? {}
    const idempotent = req?.method === "GET" || req?.method === "HEAD"
    let attempt = 0
    const once = () =>
      web.call(proxy, req, res, options, (error, ...args) => {
        const retry =
          idempotent &&
          attempt < retries &&
          RETRYABLE.has(error?.code) &&
          !res?.headersSent &&
          !res?.writableEnded &&
          !req?.socket?.destroyed
        if (retry) {
          attempt += 1
          setTimeout(once, delayMs * attempt)
          return
        }
        if (callback) callback(error, ...args)
        else proxy.emit("error", error, req, res, ...args)
      })
    once()
  }
  retrying.designlayerRetries = true
  proxy.web = retrying
  return proxy
}

let keepAliveAgent = null

/**
 * One keep-alive agent for every proxy in the process.
 *
 * `http-proxy` falls back to `agent: false` when it is handed none, which is a
 * fresh TCP connection, closed after one response, for every module a dev page
 * loads — measured through the vendored proxy against a local upstream, 3,000
 * module GETs took 445-463ms that way and 183-193ms over reused sockets. The
 * idle timeout sits under Node's default 5s server `keepAliveTimeout`, so a
 * socket is dropped here before the dev server can close it mid-reuse; a GET
 * that still meets a closed socket is what the retry above is for. An HMR
 * upgrade takes one socket from the agent, which leaves the pool on upgrade,
 * and `http-proxy` clears that socket's timeout as it pipes it, so a quiet HMR
 * connection is not cut at 4s.
 */
export function sharedKeepAliveAgent() {
  keepAliveAgent ??= new http.Agent({ keepAlive: true, maxSockets: 64, timeout: 4000 })
  return keepAliveAgent
}

/** The caller's options with the shared agent filled in, unless it chose one. */
function withKeepAlive(options) {
  if (options && typeof options === "object" && "agent" in options) return options
  return { ...options, agent: sharedKeepAliveAgent() }
}

/**
 * Makes every proxy `http-proxy` creates from here on retry, and reuse its
 * upstream connections, whichever of its factory names the caller uses.
 * Reached through the vendor's own resolution, so the module patched is the
 * module the vendor imports.
 */
export function patchProxyRetries(httpProxy, options) {
  if (!httpProxy || httpProxy.designlayerRetries) return
  for (const name of ["createProxyServer", "createServer", "createProxy"]) {
    const create = httpProxy[name]
    if (typeof create !== "function") continue
    httpProxy[name] = function createRetryingProxy(proxyOptions, ...rest) {
      return withRetries(create.call(this, withKeepAlive(proxyOptions), ...rest), options)
    }
  }
  httpProxy.designlayerRetries = true
}
