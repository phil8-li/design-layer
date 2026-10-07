/**
 * Cases for the proxy's retry of a failed upstream connection.
 *
 * A dev server serves an app as thousands of modules, and one that fails to
 * arrive leaves the page white. The vendor's proxy answers every upstream
 * socket error with a 502; these pin that a GET is tried again first, that
 * nothing unsafe to repeat is, and that a dev server that is really down still
 * gets its 502. The proxy here is wired the way the vendor wires its own
 * (`selfHandleResponse`, a 502 from the `error` event), over real sockets.
 *
 * Usage: node designlayer/test/proxy-retry-cases.mjs
 */

import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { createRequire } from "node:module"

import { PACKAGE_DIR } from "./host.mjs"

const { patchProxyRetries, sharedKeepAliveAgent, withRetries, PROXY_RETRIES } = await import(
  path.join(PACKAGE_DIR, "runtime", "proxy-retry.mjs")
)

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const vendorRequire = createRequire(createRequire(path.join(PACKAGE_DIR, "package.json")).resolve("react-rewrite-cli"))
const httpProxy = vendorRequire("http-proxy")

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
const close = (server) => new Promise((resolve) => server.close(() => resolve()))

/** An upstream that drops the first `drops` requests' connections, then answers. */
async function flakyUpstream(drops) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.method)
    if (seen.length <= drops) {
      req.socket.destroy()
      return
    }
    res.writeHead(200, { "content-type": "text/javascript" })
    res.end("export default 1")
  })
  const port = await listen(server)
  return { server, port, seen }
}

/** A proxy the way the vendor builds one, retrying or not. */
async function vendorProxy(target, { retrying }) {
  const proxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${target}`, selfHandleResponse: true })
  if (retrying) withRetries(proxy, { delayMs: 10 })
  proxy.on("proxyRes", (proxyRes, _req, res) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers)
    proxyRes.pipe(res)
  })
  proxy.on("error", (_error, _req, res) => {
    if (res && "writeHead" in res) {
      res.writeHead(502, { "Content-Type": "text/plain" })
      res.end("Dev server unavailable")
    }
  })
  const server = http.createServer((req, res) => proxy.web(req, res))
  const port = await listen(server)
  return { server, port, proxy }
}

/** One request on its own socket, so a dropped upstream cannot reuse a client connection. */
async function request(port, method = "GET") {
  const response = await fetch(`http://127.0.0.1:${port}/src/main.tsx`, {
    method,
    headers: { connection: "close" },
    body: method === "POST" ? "{}" : undefined,
  })
  return { status: response.status, body: await response.text() }
}

await check("a GET whose upstream connection dropped is tried again and arrives", async () => {
  const upstream = await flakyUpstream(PROXY_RETRIES)
  const proxy = await vendorProxy(upstream.port, { retrying: true })
  try {
    const response = await request(proxy.port)
    assert.equal(response.status, 200, `got ${response.status} ${response.body}`)
    assert.equal(response.body, "export default 1")
    assert.equal(upstream.seen.length, PROXY_RETRIES + 1)
  } finally {
    await close(proxy.server)
    await close(upstream.server)
  }
})

await check("without the retry, the same drop is the vendor's 502 — the white page", async () => {
  const upstream = await flakyUpstream(1)
  const proxy = await vendorProxy(upstream.port, { retrying: false })
  try {
    const response = await request(proxy.port)
    assert.equal(response.status, 502)
    assert.equal(upstream.seen.length, 1)
  } finally {
    await close(proxy.server)
    await close(upstream.server)
  }
})

await check("a POST is never repeated: it gets the 502 on the first failure", async () => {
  const upstream = await flakyUpstream(1)
  const proxy = await vendorProxy(upstream.port, { retrying: true })
  try {
    const response = await request(proxy.port, "POST")
    assert.equal(response.status, 502)
    assert.deepEqual(upstream.seen, ["POST"])
  } finally {
    await close(proxy.server)
    await close(upstream.server)
  }
})

await check("a dev server that is really down still gets its 502, after the retries", async () => {
  const probe = net.createServer()
  const deadPort = await listen(probe)
  await close(probe)
  const proxy = await vendorProxy(deadPort, { retrying: true })
  try {
    const response = await request(proxy.port)
    assert.equal(response.status, 502)
    assert.equal(response.body, "Dev server unavailable")
  } finally {
    await close(proxy.server)
  }
})

await check("the launcher's patch reaches every proxy the vendor's http-proxy creates, once", () => {
  const fake = {
    createProxyServer: () => ({ web() {}, emit() {} }),
    createServer: () => ({ web() {}, emit() {} }),
  }
  patchProxyRetries(fake)
  const created = fake.createProxyServer({})
  assert.equal(created.web.designlayerRetries, true)
  assert.equal(fake.createServer({}).web.designlayerRetries, true)
  const wrapped = fake.createProxyServer
  patchProxyRetries(fake)
  assert.equal(fake.createProxyServer, wrapped, "patched twice")
  assert.equal(withRetries(created), created)
  assert.equal(created.web.designlayerRetries, true)
})

await check("a proxy built without an agent reuses upstream sockets; one with an agent keeps it", async () => {
  const sockets = new Set()
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/javascript" })
    res.end("export default 1")
  })
  upstream.on("connection", (socket) => sockets.add(socket))
  const upstreamPort = await listen(upstream)

  const fake = { createProxyServer: (options) => httpProxy.createProxyServer(options) }
  patchProxyRetries(fake)
  const proxy = fake.createProxyServer({ target: `http://127.0.0.1:${upstreamPort}` })
  assert.equal(proxy.options.agent, sharedKeepAliveAgent())
  assert.equal(proxy.options.agent.keepAlive, true)
  // Under Node's default 5s server keepAliveTimeout, so the proxy lets go first.
  assert.ok(proxy.options.agent.options.timeout < 5000)
  const own = new http.Agent()
  assert.equal(fake.createProxyServer({ target: "http://127.0.0.1:1", agent: own }).options.agent, own)
  assert.equal(fake.createProxyServer({ target: "http://127.0.0.1:1", agent: false }).options.agent, false)

  const server = http.createServer((req, res) => proxy.web(req, res))
  const port = await listen(server)
  try {
    for (let i = 0; i < 5; i++) {
      // A fresh client socket each time, saying keep-alive as a browser does:
      // only the proxy's side may reuse.
      const status = await new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/m.js", agent: false, headers: { connection: "keep-alive" } }, (res) => {
            res.resume()
            res.on("end", () => resolve(res.statusCode))
          })
          .on("error", reject)
      })
      assert.equal(status, 200)
    }
    assert.equal(sockets.size, 1, `${sockets.size} upstream connections for 5 requests`)
  } finally {
    sharedKeepAliveAgent().destroy()
    await close(server)
    await close(upstream)
  }
})

await check("the vendor imports the same http-proxy the launcher patches", async () => {
  const fs = await import("node:fs")
  const inject = path.join(path.dirname(vendorRequire.resolve("./inject.js")), "inject.js")
  assert.match(fs.readFileSync(inject, "utf8"), /import httpProxy from "http-proxy"/)
  assert.equal(typeof httpProxy.createProxyServer, "function")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
