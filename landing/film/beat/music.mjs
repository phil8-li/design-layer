#!/usr/bin/env node
/**
 * Renders the soundtracks in scores.mjs.
 *
 *   node landing/film/beat/music.mjs            all three cuts
 *   node landing/film/beat/music.mjs a c        some
 *
 * Writes /tmp/designlayer-film/beat/<cut>.wav and .m4a (for listening and for
 * muxing), and landing/film/beat/cues/<cut>.json, which the film reads so its
 * cuts land on the music's beats.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as S from "./synth.mjs"
import { SCORES } from "./scores.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORK = "/tmp/designlayer-film/beat"
const CUES = path.join(HERE, "cues")
const FFMPEG = process.env.FFMPEG ||
  "ffmpeg"

fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(CUES, { recursive: true })
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCORES)

for (const id of ids) {
  const started = Date.now()
  const { bus, cues } = SCORES[id]()
  let peak = 0
  for (let i = 0; i < bus.n; i++) peak = Math.max(peak, Math.abs(bus.L[i]), Math.abs(bus.R[i]))
  const pre = S.rmsDb(bus)
  const m = S.master(bus, { targetDb: -13.5 })
  const wavFile = path.join(WORK, `${id}.wav`)
  fs.writeFileSync(wavFile, S.wav(bus))
  const m4a = path.join(WORK, `${id}.m4a`)
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", wavFile, "-c:a", "aac", "-b:a", "192k", m4a], { stdio: "inherit" })
  if (r.status !== 0) throw new Error("ffmpeg failed")
  fs.writeFileSync(path.join(CUES, `${id}.json`), JSON.stringify(cues, null, 1) + "\n")
  console.log(`${id}: ${cues.bpm} BPM, ${cues.duration.toFixed(2)} s, pre-master peak ${(20 * Math.log10(peak)).toFixed(1)} dB / rms ${pre.toFixed(1)} dB, gain ${m.gainDb.toFixed(1)} dB → rms ${m.rms.toFixed(1)} dB, ${((Date.now() - started) / 1000).toFixed(1)} s`)
}
