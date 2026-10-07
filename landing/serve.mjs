#!/usr/bin/env node
/**
 * Static server for the landing page in this directory.
 *
 *   node landing/serve.mjs                 http://127.0.0.1:4321
 *   node landing/serve.mjs --port 8080 --root <dir>
 *
 *   import { startServer } from "./serve.mjs"
 *   const { url, close } = await startServer({ root, port: 0 })
 *
 * GET and HEAD only. A path that resolves outside the root, or names a dotfile,
 * is a 404. A directory serves its index.html (redirecting to the trailing
 * slash first, so relative URLs in it resolve). Single byte ranges are honored,
 * which Chromium needs to play and seek video. Nothing is cached, so an edit
 * shows on the next reload. A missing file gets the root's 404.html when there
 * is one, otherwise a built-in page.
 */

import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
}

const NOT_FOUND = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found</title>
<body style="font: 16px/1.5 system-ui, sans-serif; margin: 4rem auto; max-width: 32rem; padding: 0 1rem">
<h1>Not found</h1>
<p>Nothing lives at this address. <a href="/">Go to the home page</a>.</p>
</body>
</html>
`

/** The file a request path names, or null when it is outside the root or hidden. */
export function resolvePath(root, pathname) {
  if (pathname.includes("\0")) return null
  const file = path.join(root, pathname)
  if (file !== root && !file.startsWith(root + path.sep)) return null
  if (path.relative(root, file).split(path.sep).some((part) => part.startsWith("."))) return null
  return file
}

function stat(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

function inside(root, file) {
  try {
    const real = fs.realpathSync(file)
    return real === root || real.startsWith(root + path.sep)
  } catch {
    return false
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, headers)
  res.end(body)
}

function notFound(root, req, res) {
  const custom = path.join(root, "404.html")
  const body = stat(custom)?.isFile() ? fs.readFileSync(custom) : Buffer.from(NOT_FOUND)
  send(res, 404, { "Content-Type": MIME[".html"], "Content-Length": body.length, "Cache-Control": "no-store" }, req.method === "HEAD" ? undefined : body)
}

function handle(root, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }, "method not allowed\n")
  }
  let url
  let pathname
  try {
    url = new URL(req.url, "http://localhost")
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "bad request\n")
  }
  let file = resolvePath(root, pathname)
  let info = file && stat(file)
  if (info?.isDirectory()) {
    if (!pathname.endsWith("/")) return send(res, 301, { Location: `${url.pathname}/${url.search}` })
    file = path.join(file, "index.html")
    info = stat(file)
  }
  if (!info?.isFile() || !inside(root, file)) return notFound(root, req, res)

  const headers = {
    "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
    "Last-Modified": info.mtime.toUTCString(),
    "Accept-Ranges": "bytes",
  }
  let start = 0
  let end = info.size - 1
  let status = 200
  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match && (match[1] || match[2])) {
      if (match[1]) {
        start = Number(match[1])
        if (match[2]) end = Math.min(Number(match[2]), end)
      } else {
        start = Math.max(0, info.size - Number(match[2]))
      }
    }
    if (!match || start > end || start >= info.size) {
      return send(res, 416, { "Content-Range": `bytes */${info.size}` })
    }
    status = 206
    headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`
  }
  headers["Content-Length"] = info.size ? end - start + 1 : 0
  res.writeHead(status, headers)
  if (req.method === "HEAD" || !info.size) return res.end()
  fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res)
}

/** Serve `root` on `port` (0 picks a free one). Resolves once listening. */
export function startServer({ root = HERE, port = 4321, host = "127.0.0.1", log = null } = {}) {
  const base = fs.realpathSync(path.resolve(root))
  const server = http.createServer((req, res) => {
    if (log) res.on("finish", () => log(`${req.method} ${req.url} ${res.statusCode}`))
    handle(base, req, res)
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      const bound = server.address().port
      resolve({
        url: `http://${host}:${bound}`,
        port: bound,
        root: base,
        close: () => new Promise((done) => {
          server.closeAllConnections()
          server.close(() => done())
        }),
      })
    })
  })
}

const isMain = process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url
if (isMain) {
  const args = process.argv.slice(2)
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
  const port = Number(option("--port") ?? 4321)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("usage: node landing/serve.mjs [--port 4321] [--root <dir>]")
    process.exit(2)
  }
  try {
    const { url, root } = await startServer({ root: option("--root") ?? HERE, port, log: (line) => console.log(line) })
    console.log(`serving ${root} at ${url}/`)
  } catch (error) {
    console.error(error.code === "EADDRINUSE" ? `port ${port} is in use; pass --port <n>` : error.message)
    process.exit(1)
  }
}
