#!/usr/bin/env node
/**
 * Publishes a scored cut to the landing page's film dialog. It writes three files to
 * landing/assets/film/: launch.mp4 at 1080p and launch-720.mp4 for narrow screens, each a
 * two-pass H.264 encode with AAC sound under the site's 4 MB video budget (check.mjs),
 * and launch-poster.jpg, one frame of the cut.
 *
 *   node landing/film/promo/publish.mjs t trailer               # the approved cut: One move, Trailer score
 *   node landing/film/promo/publish.mjs t trailer --poster 10   # the poster frame, in seconds
 *
 * The picture comes from render.mjs (/tmp/designlayer-film/promo/cut-<cut>.mp4) and the sound
 * from sound/mix.py (~/.cache/designlayer-site/sound/<cut>/<option>/mix.wav), so the published
 * film is encoded once from its masters rather than from the review copy.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, "../../assets/film")
const FFMPEG = process.env.FFMPEG ||
  "ffmpeg"
const BUDGET = 4 * 1024 * 1024 // bytes per video file, as landing/check.mjs enforces
const AUDIO_KBPS = 128

const args = process.argv.slice(2)
const [cut, option] = args
if (!cut || !option) throw new Error("usage: publish.mjs <cut> <sound option> [--poster seconds]")
const posterAt = Number(args.includes("--poster") ? args[args.indexOf("--poster") + 1] : 10)
const picture = `/tmp/designlayer-film/promo/cut-${cut}.mp4`
const sound = path.join(os.homedir(), `.cache/designlayer-site/sound/${cut}/${option}/mix.wav`)
for (const file of [picture, sound]) if (!fs.existsSync(file)) throw new Error(`missing ${file}`)

const ffmpeg = (...a) => {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...a], { stdio: ["ignore", "inherit", "inherit"] })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${a.join(" ")}`)
}
const duration = Number(spawnSync(FFMPEG, ["-hide_banner", "-i", picture], { encoding: "utf8" }).stderr.match(/Duration: (\d+):(\d+):([\d.]+)/).slice(1).reduce((s, v) => s * 60 + Number(v), 0))

// Two passes at an average bitrate, so the file lands just under the budget whatever the cut's length.
function encode(file, scale, videoKbps) {
  const log = path.join(os.tmpdir(), `designlayer-publish-${path.basename(file, ".mp4")}`)
  const video = ["-c:v", "libx264", "-preset", "veryslow", "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps * 2}k`, "-bufsize", `${videoKbps * 4}k`,
    "-g", "60", "-pix_fmt", "yuv420p", "-profile:v", "high", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
    ...(scale ? ["-vf", `scale=${scale}:flags=lanczos`] : [])]
  ffmpeg("-i", picture, "-an", ...video, "-pass", "1", "-passlogfile", log, "-f", "mp4", "/dev/null")
  ffmpeg("-i", picture, "-i", sound, "-map", "0:v", "-map", "1:a", ...video, "-pass", "2", "-passlogfile", log,
    "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", file)
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(path.basename(log))) fs.rmSync(path.join(os.tmpdir(), f))
  return fs.statSync(file).size
}

function publish(name, scale, ceilingKbps) {
  const file = path.join(OUT, name)
  let kbps = Math.min(ceilingKbps, Math.floor((BUDGET * 0.95 * 8) / duration / 1000) - AUDIO_KBPS)
  for (;;) {
    const bytes = encode(file, scale, kbps)
    if (bytes < BUDGET) return console.log(`${name}: ${(bytes / 1024 / 1024).toFixed(2)} MB, video ${kbps} kb/s, audio ${AUDIO_KBPS} kb/s, ${duration} s`)
    kbps = Math.floor(kbps * 0.92) // a little over: step down and encode again
  }
}

fs.mkdirSync(OUT, { recursive: true })
publish("launch.mp4", null, 2000)
publish("launch-720.mp4", "1280:720", 650)
ffmpeg("-ss", String(posterAt), "-i", picture, "-frames:v", "1", "-q:v", "3", path.join(OUT, "launch-poster.jpg"))
console.log(`launch-poster.jpg: ${(fs.statSync(path.join(OUT, "launch-poster.jpg")).size / 1024).toFixed(0)} KB, frame at ${posterAt} s`)
