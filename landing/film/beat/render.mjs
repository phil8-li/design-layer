#!/usr/bin/env node
/**
 * Renders a beat cut (index.html?cut=<id>) frame by frame and muxes its soundtrack.
 *
 *   node landing/film/beat/render.mjs a                       → /tmp/designlayer-film/beat/cut-a.mp4 (1080p30 + AAC)
 *   node landing/film/beat/render.mjs a --fps 60              60 fps
 *   node landing/film/beat/render.mjs a --out FILE            write somewhere else
 *   node landing/film/beat/render.mjs a --frames DIR --at 1,7.8,27   stills at those seconds
 *   node landing/film/beat/render.mjs a --from 7 --to 12      a range, with its audio
 *
 * Run music.mjs first: the film reads cues/<id>.json and the mux needs
 * /tmp/designlayer-film/beat/<id>.wav. Shots resolve like ../render.mjs: the
 * 2x JPEG originals from ~/.cache/designlayer-site/originals when present.
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
const WORK = "/tmp/designlayer-film/beat"
const ORIGINALS = process.env.ORIGINALS || path.join(os.homedir(), ".cache", "designlayer-site", "originals")
const FFMPEG = process.env.FFMPEG || "ffmpeg"
const require = createRequire(process.env.PLAYWRIGHT || import.meta.url)
const { chromium } = require("playwright")

const args = process.argv.slice(2)
const id = args[0]
if (!id || id.startsWith("--")) throw new Error("usage: render.mjs <cut> [--fps 30] [--frames DIR --at t,t] [--from s --to s] [--out FILE]")
const opt = (name, dflt) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : dflt)
const fps = Number(opt("fps", 30))
const framesDir = opt("frames", null)
fs.mkdirSync(WORK, { recursive: true })

async function openFilm() {
  const server = await startServer({ root: SITE, port: 0 })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  page.on("pageerror", (e) => console.error("page error:", e.message))
  page.on("console", (m) => { if (m.type() === "error") console.error("console:", m.text()) })
  await page.route(/\/assets\/shots\/([^/?]+)\/([^/?]+\.jpg)(\?.*)?$/, (route) => {
    const [, d, f] = /\/assets\/shots\/([^/?]+)\/([^/?]+\.jpg)/.exec(route.request().url())
    const file = path.join(ORIGINALS, d, f)
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" })
    return route.fulfill({ status: 200, contentType: "image/jpeg", body: fs.readFileSync(file) })
  })
  await page.goto(`${server.url.replace(/\/$/, "")}/film/beat/?cut=${encodeURIComponent(id)}`, { waitUntil: "load" })
  await page.waitForFunction(() => window.filmReady !== undefined)
  const ok = await page.evaluate(() => window.filmReady.then(() => true, (e) => String(e && e.stack || e)))
  if (ok !== true) throw new Error(`film failed to load: ${ok}`)
  const duration = await page.evaluate(() => window.DURATION)
  const shot = async (t, quality = 92) => {
    await page.evaluate((x) => window.seek(x), t)
    return page.screenshot({ type: "jpeg", quality })
  }
  return { shot, duration, close: async () => { await browser.close(); await server.close() } }
}

const film = await openFilm()
if (framesDir) {
  fs.mkdirSync(framesDir, { recursive: true })
  const at = opt("at", null)
  const times = at ? at.split(",").map(Number) : []
  if (!at) for (let f = Math.round(Number(opt("from", 0)) * fps); f < Math.round(Number(opt("to", film.duration)) * fps); f++) times.push(f / fps)
  for (const t of times) {
    const file = path.join(framesDir, `${id}-t${t.toFixed(2).padStart(6, "0")}.jpg`)
    fs.writeFileSync(file, await film.shot(t))
    console.log(file)
  }
  await film.close()
} else {
  const from = Number(opt("from", 0)), to = Number(opt("to", film.duration))
  const out = opt("out", path.join(WORK, `cut-${id}${args.includes("--from") ? "-range" : ""}.mp4`))
  const audio = path.join(WORK, `${id}.wav`)
  const enc = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-ss", String(from), "-t", String(to - from), "-i", audio,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-vf", "scale=in_range=pc:out_range=tv:out_color_matrix=bt709", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] })
  const done = new Promise((res, rej) => enc.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))))
  const started = Date.now()
  const f0 = Math.round(from * fps), f1 = Math.round(to * fps)
  for (let f = f0; f < f1; f++) {
    const buf = await film.shot(f / fps)
    if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once("drain", r))
    if ((f - f0) % (fps * 5) === 0) console.log(`  ${id} frame ${f - f0}/${f1 - f0}  ${(f / fps).toFixed(1)}s  ${((Date.now() - started) / 1000).toFixed(0)}s elapsed`)
  }
  enc.stdin.end()
  await done
  await film.close()
  console.log(`rendered ${f1 - f0} frames in ${((Date.now() - started) / 1000).toFixed(0)}s → ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB)`)
}
