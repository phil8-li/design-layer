#!/usr/bin/env node
/**
 * Render the launch film (landing/film/index.html) to MP4, frame by frame.
 *
 *   node landing/film/render.mjs                      60 fps master → launch.mp4 (1080p30), launch-720.mp4 (720p60), poster
 *   node landing/film/render.mjs --fps 30             render the master at 30 fps (both files then 30 fps)
 *   node landing/film/render.mjs --from 10 --to 14    preview a range → /tmp/designlayer-film/preview.mp4
 *   node landing/film/render.mjs --frames DIR --at 1.2,9,20   dump stills at those seconds (no video)
 *   node landing/film/render.mjs --frames DIR --from 7 --to 8 --fps 10   dump every frame of a range
 *   node landing/film/render.mjs --demo midday        screenshot set under landing/assets/shots/<demo>/ (default midday)
 *   node landing/film/render.mjs --encode-only        re-encode the last master without re-rendering
 *   node landing/film/render.mjs --poster-at 9.6      which second becomes launch-poster.jpg
 *
 * The site publishes shots as webp only. The film asks for <name>.jpg, and this
 * script answers those requests with the 2x JPEG originals from ORIGINALS
 * (default ~/.cache/designlayer-site/originals/<demo>/), so the camera zooms
 * stay sharp; without an original the film falls back to <name>-2400.webp.
 *
 * FFMPEG=/path/to/ffmpeg overrides the bundled binary. PLAYWRIGHT=/path/to/playwright
 * overrides where Playwright is resolved from. ORIGINALS=/dir overrides the originals root.
 */

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startServer } from "../serve.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SITE = path.resolve(HERE, "..")
const OUT_DIR = path.join(SITE, "assets", "film")
const WORK = "/tmp/designlayer-film"
const MAX_BYTES = 4_000_000
const POSTER_MAX = 200 * 1024
const ORIGINALS = process.env.ORIGINALS || path.join(os.homedir(), ".cache", "designlayer-site", "originals")

const FFMPEG = process.env.FFMPEG || "ffmpeg"
const require = createRequire(process.env.PLAYWRIGHT || import.meta.url)
const { chromium } = require("playwright")

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const flag = (name) => args.includes(`--${name}`)
const fps = Number(opt("fps", 60))
const demo = opt("demo", "midday")
const framesDir = opt("frames", null)
const at = opt("at", null)
const posterAt = Number(opt("poster-at", 9.6))
const encodeOnly = flag("encode-only")

if (![24, 25, 30, 50, 60].includes(fps) && !framesDir) throw new Error(`--fps ${fps}: use 30 or 60`)
fs.mkdirSync(WORK, { recursive: true })
const master = path.join(WORK, `master-${demo}-${fps}.mp4`)

function ff(argv, label) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...argv], { stdio: "inherit", cwd: WORK })
  if (r.status !== 0) throw new Error(`ffmpeg failed (${label})`)
}
const size = (f) => fs.statSync(f).size
const kb = (n) => `${(n / 1024).toFixed(0)} KB`
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`

async function openFilm() {
  const server = await startServer({ root: SITE, port: 0 })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  page.on("pageerror", (e) => console.error("page error:", e.message))
  await page.route(/\/assets\/shots\/([^/?]+)\/([^/?]+\.jpg)(\?.*)?$/, (route) => {
    const [, d, f] = /\/assets\/shots\/([^/?]+)\/([^/?]+\.jpg)/.exec(route.request().url())
    const file = path.join(ORIGINALS, d, f)
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" })
    return route.fulfill({ status: 200, contentType: "image/jpeg", body: fs.readFileSync(file) })
  })
  await page.goto(`${server.url.replace(/\/$/, "")}/film/?demo=${encodeURIComponent(demo)}`, { waitUntil: "load" })
  await page.waitForFunction(() => window.filmReady !== undefined)
  const ok = await page.evaluate(() => window.filmReady.then(() => true, (e) => String(e)))
  if (ok !== true) throw new Error(`film failed to load: ${ok}`)
  const info = await page.evaluate(() => ({ duration: window.DURATION, selection: window.__selection, sources: window.__sources }))
  console.log(`selection bbox: ${JSON.stringify(info.selection)}`)
  for (const [k, v] of Object.entries(info.sources.shots)) console.log(`  ${k.padEnd(9)} ${v ? v.url : "MISSING"}`)
  console.log(`  agent     ${info.sources.agent?.url ?? "MISSING"}`)
  console.log(`  diff      ${typeof info.sources.diff === "string" ? info.sources.diff : info.sources.diff.url}`)
  const shot = async (t, quality = 92) => {
    await page.evaluate((x) => window.seek(x), t)
    return page.screenshot({ type: "jpeg", quality })
  }
  const close = async () => { await browser.close(); await server.close() }
  return { page, shot, close, duration: info.duration }
}

async function dumpFrames() {
  const film = await openFilm()
  fs.mkdirSync(framesDir, { recursive: true })
  const times = at
    ? at.split(",").map(Number)
    : (() => {
      const from = Number(opt("from", 0)), to = Number(opt("to", film.duration))
      const out = []
      for (let f = Math.round(from * fps); f < Math.round(to * fps); f++) out.push(f / fps)
      return out
    })()
  for (const t of times) {
    const file = path.join(framesDir, `t${t.toFixed(2).padStart(6, "0")}.jpg`)
    fs.writeFileSync(file, await film.shot(t))
    console.log(file)
  }
  await film.close()
}

async function renderVideo(out, from, to, crf) {
  const film = await openFilm()
  const f0 = Math.round(from * fps), f1 = Math.round(to * fps)
  const enc = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-an", out], { stdio: ["pipe", "inherit", "inherit"] })
  const done = new Promise((res, rej) => enc.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))))
  const started = Date.now()
  for (let f = f0; f < f1; f++) {
    const buf = await film.shot(f / fps)
    if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once("drain", r))
    if ((f - f0) % (fps * 5) === 0) {
      const el = (Date.now() - started) / 1000
      console.log(`  frame ${f - f0}/${f1 - f0}  ${(f / fps).toFixed(1)}s  ${el.toFixed(0)}s elapsed`)
    }
  }
  enc.stdin.end()
  await done
  console.log(`rendered ${f1 - f0} frames in ${((Date.now() - started) / 1000).toFixed(0)}s → ${out}`)
  return film
}

/**
 * H.264 High, yuv420p (TV range), faststart, no audio, two-pass to land just
 * under MAX_BYTES. Screen content at ~600 kb/s: at 1080p, 30 fps keeps text
 * crisp during camera moves where 60 fps visibly smears, so the 1080p file is
 * 30 fps and the 720p file keeps 60.
 */
function encodeFinal(src, out, { width, height, fps: outFps }, duration) {
  const vf = ["-vf", `fps=${outFps},scale=${width}:${height}:flags=lanczos:in_range=pc:out_range=tv:out_color_matrix=bt709`,
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
  const x264 = ["-x264-params", "aq-mode=3:aq-strength=0.9:deblock=1,1:psy-rd=0.7,0:ref=6:bframes=8:rc-lookahead=60:colorprim=bt709:transfer=bt709:colormatrix=bt709"]
  const common = ["-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "veryslow", "-tune", "animation",
    ...x264, "-an", "-movflags", "+faststart"]
  const kbps = Math.floor((MAX_BYTES * 0.95 * 8) / 1000 / duration)
  const pass = path.join(WORK, `x264-${width}`)
  ff(["-i", src, ...vf, ...common, "-b:v", `${kbps}k`, "-pass", "1", "-passlogfile", pass, "-f", "mp4", "/dev/null"], "pass 1")
  ff(["-i", src, ...vf, ...common, "-b:v", `${kbps}k`, "-maxrate", `${kbps * 4}k`, "-bufsize", `${kbps * 8}k`, "-pass", "2", "-passlogfile", pass, out], "pass 2")
  console.log(`  ${path.basename(out)} ${width}x${height}@${outFps} 2-pass ${kbps} kb/s: ${mb(size(out))}`)
  return { mode: `${width}x${height} ${outFps} fps, 2-pass ${kbps} kb/s`, bytes: size(out) }
}

async function poster(film) {
  const file = path.join(OUT_DIR, "launch-poster.jpg")
  for (const q of [88, 82, 76, 70, 64, 58, 50]) {
    fs.writeFileSync(file, await film.shot(posterAt, q))
    if (size(file) <= POSTER_MAX) {
      console.log(`poster t=${posterAt}s q${q}: ${kb(size(file))}`)
      return
    }
  }
  console.log(`poster over budget: ${kb(size(file))}`)
}

if (framesDir) {
  await dumpFrames()
} else if (args.includes("--from") || args.includes("--to")) {
  const from = Number(opt("from", 0)), to = Number(opt("to", 50))
  const out = path.join(WORK, "preview.mp4")
  const film = await renderVideo(out, from, to, 20)
  await film.close()
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  let duration = 50
  if (!encodeOnly) {
    const film = await renderVideo(master, 0, 50, 12)
    duration = film.duration
    await poster(film)
    await film.close()
  } else if (!fs.existsSync(master)) throw new Error(`no master at ${master}; render first`)
  const full = encodeFinal(master, path.join(OUT_DIR, "launch.mp4"), { width: 1920, height: 1080, fps: Math.min(fps, 30) }, duration)
  const small = encodeFinal(master, path.join(OUT_DIR, "launch-720.mp4"), { width: 1280, height: 720, fps }, duration)
  console.log(`launch.mp4      ${mb(full.bytes)} (${full.mode})`)
  console.log(`launch-720.mp4  ${mb(small.bytes)} (${small.mode})`)
}
