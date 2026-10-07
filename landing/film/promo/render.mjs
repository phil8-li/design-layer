#!/usr/bin/env node
/**
 * Renders a promo cut (index.html?cut=<id>) frame by frame, silent.
 *
 *   node landing/film/promo/render.mjs g                        → /tmp/designlayer-film/promo/cut-g.mp4 (1080p30)
 *   node landing/film/promo/render.mjs g --fps 60
 *   node landing/film/promo/render.mjs g --frames DIR --at 3,7.5,12
 *   node landing/film/promo/render.mjs g --from 9 --to 15
 *   node landing/film/promo/render.mjs p --ss 2               (rendered at 2x, scaled to 1080p)
 *
 * The page asks for frames/<session>/<name>; this script answers from the
 * captured sessions in ~/.cache/designlayer-site/story/ (FRAMES_ROOT=/dir
 * overrides): midday (g h i, the explainer's session, from
 * designlayer-demos/story/capture-story.mjs), midday-cta (j k l, from
 * capture-cta.mjs), midday-tune (m n o, capture-tune.mjs) and midday-r6 (p … t,
 * capture-r6.mjs).
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startServer } from "../../serve.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SITE = path.resolve(HERE, "../..")
const WORK = "/tmp/designlayer-film/promo"
const FRAMES_ROOT = process.env.FRAMES_ROOT || path.join(os.homedir(), ".cache", "designlayer-site", "story")
const FFMPEG = process.env.FFMPEG || "ffmpeg"
const require = createRequire(process.env.PLAYWRIGHT || import.meta.url)
const { chromium } = require("playwright")

const args = process.argv.slice(2)
const id = args[0]
if (!id || id.startsWith("--")) throw new Error("usage: render.mjs <cut> [--fps 30] [--frames DIR --at t,t] [--from s --to s] [--out FILE]")
const opt = (name, dflt) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : dflt)
const fps = Number(opt("fps", 30))
const framesDir = opt("frames", null)
// --ss 2 renders at twice the pixels and scales down: edges and small type stay still while things move
const ss = Number(opt("ss", 1))
fs.mkdirSync(WORK, { recursive: true })
const TYPES = { jpg: "image/jpeg", json: "application/json", txt: "text/plain" }

const server = await startServer({ root: SITE, port: 0 })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: ss })
page.on("pageerror", (e) => console.error("page error:", e.message))
page.on("console", (m) => { if (m.type() === "error") console.error("console:", m.text()) })
await page.route(/\/film\/promo\/frames\/([^/?]+)\/([^/?]+)(\?.*)?$/, (route) => {
  const [, session, name] = /\/frames\/([^/?]+)\/([^/?]+)/.exec(route.request().url())
  const file = path.join(FRAMES_ROOT, path.basename(session), path.basename(name))
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" })
  return route.fulfill({ status: 200, contentType: TYPES[name.split(".").pop()] ?? "application/octet-stream", body: fs.readFileSync(file) })
})
await page.goto(`${server.url.replace(/\/$/, "")}/film/promo/?cut=${encodeURIComponent(id)}`, { waitUntil: "load" })
await page.waitForFunction(() => window.filmReady !== undefined)
const ok = await page.evaluate(() => window.filmReady.then(() => true, (e) => String(e && e.stack || e)))
if (ok !== true) throw new Error(`film failed to load: ${ok}`)
const duration = await page.evaluate(() => window.DURATION)
const shot = async (t, quality = 92, scale = "device") => {
  await page.evaluate((x) => window.seek(x), t)
  return page.screenshot({ type: "jpeg", quality, scale })
}

if (framesDir) {
  fs.mkdirSync(framesDir, { recursive: true })
  const at = opt("at", null)
  const times = at ? at.split(",").map(Number) : []
  if (!at) for (let f = Math.round(Number(opt("from", 0)) * fps); f < Math.round(Number(opt("to", duration)) * fps); f++) times.push(f / fps)
  for (const t of times) {
    const file = path.join(framesDir, `${id}-t${t.toFixed(2).padStart(6, "0")}.jpg`)
    fs.writeFileSync(file, await shot(t, 92, "css"))
    console.log(file)
  }
} else {
  const from = Number(opt("from", 0)), to = Number(opt("to", duration))
  const out = opt("out", path.join(WORK, `cut-${id}${args.includes("--from") ? "-range" : ""}.mp4`))
  const enc = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-vf", `scale=1920:1080:flags=lanczos:in_range=pc:out_range=tv:out_color_matrix=bt709`, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-an", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] })
  const done = new Promise((res, rej) => enc.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))))
  const started = Date.now()
  const f0 = Math.round(from * fps), f1 = Math.round(to * fps)
  for (let f = f0; f < f1; f++) {
    const buf = await shot(f / fps)
    if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once("drain", r))
    if ((f - f0) % (fps * 5) === 0) console.log(`  ${id} frame ${f - f0}/${f1 - f0}  ${(f / fps).toFixed(1)}s  ${((Date.now() - started) / 1000).toFixed(0)}s elapsed`)
  }
  enc.stdin.end()
  await done
  console.log(`rendered ${f1 - f0} frames in ${((Date.now() - started) / 1000).toFixed(0)}s → ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB)`)
}
await browser.close()
await server.close()
