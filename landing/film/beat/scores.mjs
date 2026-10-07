/**
 * The three soundtracks, written note by note against a beat grid. Each
 * score returns its stereo mix and a cue map (bpm, kick and snare times, and
 * named marks) that the film reads, so every cut, word slam and whoosh lands
 * on the beat the music put it on.
 *
 *   A · Bounce     124 BPM, F major, house-pop: four on the floor, claps, a hook
 *   B · Cinematic   90 BPM, D minor, trailer: braams, taiko, a string ostinato
 *   C · Groove     100 BPM swung, C major, funk: snaps, Rhodes, a finger bass
 */

import * as S from "./synth.mjs"

class Score {
  constructor({ bpm, bars, tail = 3, swing = 0.5 }) {
    this.bpm = bpm
    this.spb = 60 / bpm
    this.bars = bars
    this.swing = swing
    this.end = bars * 4 * this.spb
    this.duration = this.end + tail
    this.buses = {}
    this.cues = { bpm, spb: this.spb, bars, duration: this.duration, kicks: [], snares: [], hits: [], marks: {} }
  }
  /**
   * Seconds at bar / beat / sixteenth, 0-indexed. With swing above 0.5 the
   * second sixteenth of each eighth lands late (0.6 puts it at 60% of the eighth).
   */
  t(bar, beat = 0, six = 0) {
    const pos = Math.round(((bar * 4 + beat) * 4 + six) * 1e6) / 1e6 // in sixteenths
    const pair = Math.floor(pos / 2)
    const within = pos - pair * 2
    const e = this.spb / 2
    const w = within < 1 ? within * this.swing * e : this.swing * e + (within - 1) * (1 - this.swing) * e
    return pair * e + w
  }
  bus(name) {
    return (this.buses[name] ??= new S.Bus(this.duration))
  }
  mark(name, time) {
    this.cues.marks[name] = Math.round(time * 1000) / 1000
    return time
  }
}

const round = (v) => Math.round(v * 1000) / 1000

/** Mixes the named buses into one with the given gains, after the processing done on them. */
function mixdown(score, gains) {
  const out = new S.Bus(score.duration)
  for (const [name, g] of Object.entries(gains)) if (score.buses[name]) score.buses[name].mixInto(out, S.db(g))
  return out
}

/* =====================================================================
   A · Bounce — 124 BPM house-pop in F
   ===================================================================== */

export function bounce() {
  const s = new Score({ bpm: 124, bars: 16, tail: 2.6 })
  const T = (b, beat = 0, six = 0) => s.t(b, beat, six)
  const PROG = [
    { root: "F1", notes: ["A3", "C4", "F4"], pad: ["F3", "A3", "C4", "F4"] },
    { root: "C2", notes: ["G3", "C4", "E4"], pad: ["C3", "G3", "C4", "E4"] },
    { root: "D2", notes: ["A3", "D4", "F4"], pad: ["D3", "A3", "D4", "F4"] },
    { root: "Bb1", notes: ["Bb3", "D4", "F4"], pad: ["Bb2", "F3", "Bb3", "D4"] },
  ]
  const chord = (b) => PROG[b % 4]
  const drop = (b) => (b >= 4 && b <= 11) || b === 14
  const groove = (b) => b >= 2 && b <= 11 || b === 14

  // ---- drums ----
  const K = S.kick({ f0: 170, f1: 47, decay: 0.28, click: 0.4, drive: 2 })
  const Kmuff = S.kick({ f0: 120, f1: 50, decay: 0.22, click: 0, drive: 1.2 })
  const CL = S.clap({ decay: 0.17 })
  const HC = S.hat({ decay: 0.03 }), HO = S.hat({ open: true, decay: 0.24 })
  const SH = S.shaker()
  const SN = S.snare({ tone: 200, decay: 0.12 })
  for (let b = 0; b < 16; b++) {
    for (let beat = 0; beat < 4; beat++) {
      const t = T(b, beat)
      if (b <= 1) {
        // the intro's pulse: a muffled kick under each word slam
        s.bus("kick").add(Kmuff, t, 0.55)
        s.cues.kicks.push(round(t))
      } else if (groove(b) || (b === 15 && beat === 0)) {
        s.bus("kick").add(K, t, 1)
        s.cues.kicks.push(round(t))
      }
      if ((beat === 1 || beat === 3) && b <= 12 || (b === 14 && (beat === 1 || beat === 3))) {
        s.bus("clap").add(CL, t, 0.9, 0.05)
        s.cues.snares.push(round(t))
      }
      if (groove(b)) {
        // closed hats: 8ths while it builds, 16ths in the drops
        for (let k = 0; k < 4; k++) {
          if (!drop(b) && k % 2 === 1) continue
          const accent = k === 2 ? 1 : 0.55
          s.bus("hats").add(HC, T(b, beat, k), 0.32 * accent, k % 2 ? 0.25 : -0.2)
        }
        if (drop(b)) {
          s.bus("hats").add(HO, T(b, beat, 2), 0.3, 0.15)
          for (let k = 0; k < 4; k++) s.bus("hats").add(SH, T(b, beat, k), k % 2 ? 0.16 : 0.08, -0.4)
        }
      }
    }
  }
  // fills into the breakdown and the last drop
  for (const k of [12, 13, 14, 15]) s.bus("clap").add(SN, T(7, 3, k - 12), 0.45 + 0.1 * (k - 12), 0)
  // snare roll over bars 12–13: 8ths, then 16ths, then 32nds, rising
  {
    const steps = []
    for (let i = 0; i < 8; i++) steps.push(T(12, i / 2))
    for (let i = 0; i < 8; i++) steps.push(T(13, i / 4))
    for (let i = 0; i < 16; i++) steps.push(T(13, 2 + i / 8))
    steps.forEach((t, i) => s.bus("roll").add(S.snare({ tone: 200 + i * 6, decay: 0.09, seed: 13 + i }), t, 0.25 + 0.55 * (i / steps.length) ** 1.5))
  }

  // ---- bass: offbeat eighths with a sixteenth pickup, plucky ----
  for (let b = 2; b < 16; b++) {
    if (!(groove(b))) continue
    const c = chord(b)
    for (let beat = 0; beat < 4; beat++) {
      const n = S.midi(c.root) + 12
      s.bus("bass").add(S.voice(n, s.spb * 0.32, {
        oscs: [{ type: "saw", gain: 0.7 }, { type: "square", gain: 0.45, octave: -1 }, { type: "sine", gain: 0.6, octave: -1 }],
        attack: 0.004, decay: 0.12, sustain: 0.55, release: 0.05, cutoff: b < 4 ? 420 + 160 * (b - 2) : 520, cutoffEnv: 1500, cutoffDecay: 0.06, q: 1.1, drive: 1.6,
      }), T(b, beat, 2), 0.62)
      if (beat === 3 && drop(b)) {
        s.bus("bass").add(S.voice(n + 12, s.spb * 0.18, { oscs: [{ type: "saw" }], cutoff: 700, cutoffEnv: 1800, cutoffDecay: 0.05, q: 1, drive: 1.4 }), T(b, beat, 3), 0.35)
      }
    }
  }
  s.bus("bass").add(S.voice(S.midi("F1") + 12, s.spb * 3, { oscs: [{ type: "saw", gain: 0.7 }, { type: "sine", gain: 0.8, octave: -1 }], cutoff: 500, cutoffEnv: 1200, cutoffDecay: 0.2, drive: 1.5, release: 0.8 }), T(15), 0.6)

  // ---- plucked chords: a 3-3-2 rhythm, the filter opening through the intro ----
  const PLUCK = [0, 3, 6, 10, 12]
  for (let b = 0; b < 15; b++) {
    const c = chord(b)
    const open = b <= 1 ? 700 + 1300 * ((b * 4) / 8) : b === 12 || b === 13 ? 1400 : 2600
    for (const p of PLUCK) {
      const t = T(b, 0, p)
      c.notes.forEach((n, i) => {
        s.bus("chords").add(S.voice(n, s.spb * 0.2, {
          oscs: [{ type: "saw", detune: -7 }, { type: "saw", detune: 7 }, { type: "square", gain: 0.3, octave: 1 }],
          attack: 0.003, decay: 0.16, sustain: 0.15, release: 0.12, cutoff: open * 0.55, cutoffEnv: open, cutoffDecay: 0.09, q: 0.9, seed: 3 + i + p,
        }), t, 0.2, (i - 1) * 0.45)
      })
    }
  }
  // the last chord rings out
  for (const [i, n] of ["F3", "A3", "C4", "F4"].entries()) {
    s.bus("chords").add(S.voice(n, s.spb * 2.5, { oscs: [{ type: "saw", detune: -8 }, { type: "saw", detune: 8 }], attack: 0.005, decay: 0.5, sustain: 0.35, release: 1.2, cutoff: 1400, cutoffEnv: 3000, cutoffDecay: 0.2 }), T(15), 0.24, (i - 1.5) * 0.4)
  }

  // ---- supersaw pad in the drops and the breakdown ----
  for (let b = 4; b < 15; b++) {
    if (!(drop(b) || b === 12 || b === 13)) continue
    const [L, R] = S.supersaw(chord(b).pad, s.spb * 4, { attack: b === 12 ? 0.8 : 0.05, release: 0.25, cutoff: b >= 12 && b <= 13 ? 1500 + (b - 12) * 1200 : 2400, seed: 5 + b })
    s.bus("pad").addStereo(L, R, T(b), 0.22)
  }

  // ---- the hook: two two-bar phrases, F–C then Dm–Bb ----
  const HOOK = [
    [[0, "C5", 2], [2, "A4", 2], [4, "C5", 2], [6, "F5", 4], [10, "E5", 2], [12, "C5", 4], [16, "E5", 2], [18, "D5", 2], [20, "C5", 2], [22, "G4", 4], [28, "A4", 2], [30, "C5", 2]],
    [[0, "D5", 2], [2, "C5", 2], [4, "D5", 2], [6, "F5", 4], [10, "A5", 2], [12, "G5", 4], [16, "F5", 2], [18, "D5", 2], [20, "F5", 4], [24, "D5", 2], [26, "C5", 2], [28, "D5", 4]],
  ]
  const leadBars = [4, 6, 8, 10, 14]
  for (const b0 of leadBars) {
    const phrase = HOOK[((b0 - 4) / 2) % 2]
    let prev = null
    for (const [step, n, len] of phrase) {
      const bar = b0 + Math.floor(step / 16)
      if (bar > 14 || (b0 === 14 && bar > 14)) continue
      const up = b0 === 14 ? 12 : 0
      const note = S.midi(n) + up
      s.bus("lead").add(S.voice(note, (len / 4) * s.spb * 0.92, {
        oscs: [{ type: "square", gain: 0.55 }, { type: "saw", gain: 0.45, detune: 6 }],
        attack: 0.006, decay: 0.25, sustain: 0.7, release: 0.09, cutoff: 2300, cutoffEnv: 2200, cutoffDecay: 0.12, q: 0.8,
        vibrato: 18, vibratoDelay: 0.18, glideFrom: prev, glideTime: 0.035,
      }), T(bar, 0, step % 16), 0.2)
      prev = note
    }
  }

  // ---- sound design on the film's cuts ----
  const marks = {
    words: [...Array(8)].map((_, i) => T(Math.floor(i / 4), i % 4)),
    window: T(2), cmd: T(3, 3), drop: T(4), click: T(5, 1), style: T(6), alt: T(7, 0.5), measure: T(7, 1),
    tokens: T(8), tokSteps: [T(8, 1), T(8, 2), T(8, 3)], canvas: T(9), notes: T(10), pins: [T(10, 0.5), T(10, 1.5), T(10, 2.5)],
    send: T(11), press: T(11, 1.5), agent: T(12), code: T(13), build: [T(13), T(13, 1), T(13, 2), T(13, 3)], logo: T(14), tagline: T(15), end: s.end,
  }
  for (const [k, v] of Object.entries(marks)) s.cues.marks[k] = Array.isArray(v) ? v.map(round) : round(v)
  s.bus("fx").add(S.riser(s.spb * 4, { f0: 400, f1: 7000 }), T(1), 0.35)
  s.bus("fx").add(S.impact({ len: 2.2, sub: 0.8, crash: 0.25 }), T(2), 0.4)
  s.bus("fx").add(S.tick({ f: 2200 }), T(3, 3), 0.5)
  s.bus("fx").add(S.reverseCymbal(s.spb * 2), T(3, 2), 0.5)
  s.bus("fx").add(S.impact({ len: 3, sub: 1, crash: 0.7 }), T(4), 0.75)
  for (const [i, b] of [5, 6, 7, 8, 9, 10, 11, 12].entries()) {
    const [L, R] = S.whoosh(s.spb * 0.6, { from: i % 2 ? 0.7 : -0.7, to: i % 2 ? -0.7 : 0.7, f0: 500, f1: 2800, seed: 59 + i })
    s.bus("fx").addStereo(L, R, T(b) - s.spb * 0.42, 0.38)
  }
  for (const t of [marks.click, ...marks.tokSteps, marks.press]) s.bus("fx").add(S.tick({ f: 2600 }), t, 0.42)
  for (const [i, t] of marks.pins.entries()) s.bus("fx").add(S.pop({ f0: 1100 - i * 120, f1: 320 }), t, 0.35, (i - 1) * 0.4)
  s.bus("fx").add(S.riser(s.spb * 8, { f0: 250, f1: 9000 }), T(12), 0.45)
  s.bus("fx").add(S.reverseCymbal(s.spb * 2), T(13, 2), 0.55)
  s.bus("fx").add(S.impact({ len: 3, sub: 1, crash: 0.8 }), T(14), 0.85)
  s.bus("fx").add(S.impact({ len: 3, sub: 0.7, crash: 0.5 }), T(15), 0.6)
  s.cues.hits = [T(2), T(4), T(14), T(15)].map(round)

  // ---- mix ----
  const kicks = s.cues.kicks.filter((t) => t >= T(2))
  S.duck(s.bus("bass"), kicks, { depth: 0.7, release: 0.12 })
  S.duck(s.bus("chords"), kicks, { depth: 0.5, release: 0.16 })
  S.duck(s.bus("pad"), kicks, { depth: 0.65, release: 0.18 })
  S.duck(s.bus("lead"), kicks, { depth: 0.25, release: 0.14 })
  S.filterBus(s.bus("kick"), "hp", 28)
  S.filterBus(s.bus("chords"), "hp", 180)
  S.filterBus(s.bus("pad"), "hp", 160)
  S.filterBus(s.bus("hats"), "hp", 3000)
  const room = new S.Bus(s.duration), hall = new S.Bus(s.duration), echo = new S.Bus(s.duration)
  s.bus("clap").mixInto(room, 0.5)
  s.bus("roll").mixInto(room, 0.4)
  s.bus("chords").mixInto(hall, 0.35)
  s.bus("lead").mixInto(hall, 0.3)
  s.bus("lead").mixInto(echo, 0.5)
  s.bus("chords").mixInto(echo, 0.25)
  s.bus("fx").mixInto(hall, 0.4)
  s.bus("pad").mixInto(hall, 0.2)
  const out = mixdown(s, { kick: 0, bass: -2, clap: -3, roll: -4, hats: -6, chords: -3, pad: -6, lead: -2, fx: -2 })
  S.sendReverb(room, out, 0.6, { room: 0.5, damp: 0.5 })
  S.sendReverb(hall, out, 0.75, { room: 0.86, damp: 0.35 })
  S.sendDelay(echo, out, 0.45, { time: s.spb * 0.75, feedback: 0.35, lp: 3200 })
  return { bus: out, cues: s.cues }
}

/* =====================================================================
   B · Cinematic — 90 BPM trailer in D minor
   ===================================================================== */

export function cinematic() {
  const s = new Score({ bpm: 90, bars: 15, tail: 3 })
  const T = (b, beat = 0, six = 0) => s.t(b, beat, six)
  const PROG = [
    { root: "D2", arp: ["D3", "A3", "D4", "F4"], pad: ["D3", "A3", "D4", "F4"] },
    { root: "Bb1", arp: ["Bb2", "F3", "Bb3", "D4"], pad: ["Bb2", "F3", "Bb3", "D4"] },
    { root: "F2", arp: ["F3", "A3", "C4", "F4"], pad: ["F2", "C3", "F3", "A3"] },
    { root: "C2", arp: ["C3", "G3", "C4", "E4"], pad: ["C3", "G3", "C4", "E4"] },
  ]
  const chord = (b) => PROG[b % 4]
  const main = (b) => b >= 3 && b <= 12

  // ---- the drone and the tick under the opening words ----
  {
    const [L, R] = S.supersaw(["D2", "A2", "D3"], s.spb * 8, { attack: 2.5, release: 2, cutoff: 380, detune: 10, seed: 71 })
    s.bus("drone").addStereo(L, R, 0, 0.5)
    const [L2, R2] = S.supersaw(["D2", "A2"], s.spb * 44, { attack: 1.5, release: 3, cutoff: 260, detune: 8, voices: 5, seed: 73 })
    s.bus("drone").addStereo(L2, R2, T(2), 0.35)
  }
  const TICK = S.hat({ decay: 0.018, seed: 77 })
  for (let b = 0; b < 2; b++) for (let k = 0; k < 8; k++) s.bus("perc").add(TICK, T(b, k / 2), k % 2 ? 0.12 : 0.22, k % 2 ? 0.3 : -0.3)

  // ---- braams: low brass on the big moments ----
  const braam = (t, notes, len = 3.2, gain = 0.5) => {
    for (const [i, n] of notes.entries()) {
      s.bus("braam").add(S.voice(n, len, {
        oscs: [{ type: "saw", detune: -12 }, { type: "saw", detune: 0 }, { type: "saw", detune: 12 }, { type: "square", gain: 0.4, octave: -1 }],
        attack: 0.06, decay: 1.2, sustain: 0.55, release: 1.4, cutoff: 260, cutoffEnv: 2200, cutoffDecay: 0.35, q: 0.9, drive: 2.2, seed: 81 + i,
      }), t, gain / Math.sqrt(notes.length) * 1.6, (i - (notes.length - 1) / 2) * 0.3)
    }
  }
  braam(T(2), ["D1", "D2", "A2", "D3"], 4)
  braam(T(4), ["Bb0", "Bb1", "F2", "Bb2"], 3.2, 0.42)
  braam(T(8), ["D1", "D2", "A2", "F3"], 3.2, 0.42)
  braam(T(13, 1), ["D1", "D2", "A2", "D3", "F3"], 5, 0.6)

  // ---- taiko and toms ----
  const BOOM = S.boom({ f0: 100, f1: 50, decay: 0.7 }), BOOM2 = S.boom({ f0: 82, f1: 44, decay: 1.1, seed: 31 })
  const BIGSN = S.snare({ tone: 160, decay: 0.32, toneDecay: 0.12, snap: 1.2, seed: 91 })
  for (let b = 0; b < 15; b++) {
    if (b < 2) {
      s.bus("taiko").add(BOOM2, T(b), 0.5)
      s.cues.kicks.push(round(T(b)))
      continue
    }
    if (b === 2) {
      s.bus("taiko").add(BOOM2, T(b), 1)
      s.cues.kicks.push(round(T(b)))
      continue
    }
    if (!main(b)) continue
    const pattern = b >= 11 ? [0, 1, 1.5, 2, 2.75, 3, 3.5] : [0, 1.5, 2, 3.25]
    for (const beat of pattern) {
      s.bus("taiko").add(beat === 0 || beat === 2 ? BOOM : S.tom({ f: 120 + (beat % 1 ? 30 : 0), seed: 33 + b }), T(b, beat), beat === 0 ? 1 : 0.7, ((beat * 37) % 3 - 1) * 0.3)
      if (beat === 0 || beat === 2) s.cues.kicks.push(round(T(b, beat)))
    }
    if (b >= 4) {
      s.bus("snare").add(BIGSN, T(b, 2), 0.7)
      s.cues.snares.push(round(T(b, 2)))
    }
  }
  // tom fill into the lock, and the accelerating roll into the final hit
  for (let k = 0; k < 4; k++) s.bus("taiko").add(S.tom({ f: 150 - k * 15, seed: 40 + k }), T(3, 3, k), 0.7 + k * 0.08, (k - 1.5) * 0.4)
  {
    const steps = []
    for (let i = 0; i < 8; i++) steps.push(T(12, i / 4))
    for (let i = 0; i < 16; i++) steps.push(T(12, 2 + i / 8))
    steps.forEach((t, i) => s.bus("snare").add(S.snare({ tone: 170 + i * 5, decay: 0.1, seed: 100 + i }), t, 0.2 + 0.6 * (i / steps.length) ** 1.6))
  }

  // ---- string ostinato: sixteenth arpeggios, an octave up in the build ----
  for (let b = 3; b < 13; b++) {
    const c = chord(b)
    const up = b >= 11 ? 12 : 0
    for (let k = 0; k < 16; k++) {
      const n = S.midi(c.arp[[0, 1, 2, 3, 2, 1, 2, 3][k % 8]]) + up
      s.bus("strings").add(S.voice(n, s.spb * 0.18, {
        oscs: [{ type: "saw", detune: -6 }, { type: "saw", detune: 6 }],
        attack: 0.004, decay: 0.08, sustain: 0.3, release: 0.06, cutoff: 900, cutoffEnv: 1800, cutoffDecay: 0.05, q: 0.7, seed: 200 + k,
      }), T(b, 0, k), k % 4 === 0 ? 0.26 : 0.17, ((k % 2) * 2 - 1) * 0.35)
    }
  }
  // sustained strings under the ostinato
  for (let b = 3; b < 13; b++) {
    const [L, R] = S.supersaw(chord(b).pad, s.spb * 4, { attack: 0.35, release: 0.5, cutoff: 1500, detune: 12, voices: 5, seed: 300 + b })
    s.bus("pad").addStereo(L, R, T(b), 0.2)
  }

  // ---- the outro: a piano, alone ----
  for (const [i, [n, beat]] of [["D4", 0], ["A4", 1], ["F5", 2], ["D5", 3]].entries()) s.bus("piano").add(S.piano(n, 3), T(14, beat), 0.35, (i - 1.5) * 0.2)
  {
    const [L, R] = S.supersaw(["D3", "A3", "F4"], s.spb * 6, { attack: 0.6, release: 2, cutoff: 900, seed: 333 })
    s.bus("pad").addStereo(L, R, T(13, 1), 0.22)
  }

  // ---- sound design ----
  const marks = {
    line1: T(0), line2: T(1), reveal: T(2), rotate: T(3), lock: T(4), select: T(5), measure: T(6), tokens: T(7), canvas: T(8),
    notes: T(9), send: T(10), press: T(10, 1), build: T(11), flashes: [...Array(12)].map((_, i) => (i < 4 ? T(11, i) : T(12, (i - 4) / 2))),
    breath: T(13), logo: T(13, 1), tagline: T(14), end: s.end,
  }
  for (const [k, v] of Object.entries(marks)) s.cues.marks[k] = Array.isArray(v) ? v.map(round) : round(v)
  s.bus("fx").add(S.impact({ len: 4, sub: 1, crash: 0.5 }), T(2), 0.9)
  s.bus("fx").add(S.impact({ len: 3.5, sub: 0.9, crash: 0.6 }), T(4), 0.8)
  s.bus("fx").add(S.reverseCymbal(s.spb * 2), T(3, 2), 0.5)
  for (const [i, b] of [5, 6, 7, 8, 9, 10].entries()) {
    const [L, R] = S.whoosh(s.spb * 0.9, { from: i % 2 ? 0.8 : -0.8, to: i % 2 ? -0.8 : 0.8, f0: 300, f1: 2200, seed: 400 + i })
    s.bus("fx").addStereo(L, R, T(b) - s.spb * 0.6, 0.45)
  }
  s.bus("fx").add(S.tick({ f: 2000 }), T(5, 1), 0.4)
  s.bus("fx").add(S.tick({ f: 2000 }), T(10, 1), 0.45)
  s.bus("fx").add(S.riser(s.spb * 8, { f0: 200, f1: 8000 }), T(11), 0.5)
  for (const t of marks.flashes) s.bus("fx").add(S.tick({ f: 3200, seed: 600 }), t, 0.25)
  s.bus("fx").add(S.reverseCymbal(s.spb * 1.5), T(12, 3.5), 0.6)
  s.bus("fx").add(S.impact({ len: 5, sub: 1.1, crash: 0.8 }), T(13, 1), 1)
  s.bus("fx").add(BOOM2, T(13, 1), 0.9)
  s.cues.hits = [T(2), T(4), T(8), T(13, 1)].map(round)

  // the breath: everything but the tails stops for the beat before the final hit
  for (const name of ["strings", "taiko", "snare", "pad", "drone", "perc"]) {
    const bus = s.bus(name)
    const i0 = Math.round(T(13) * S.SR), i1 = Math.round(T(13, 1) * S.SR)
    for (let i = i0; i < Math.min(bus.n, i1 + Math.round(0.02 * S.SR)); i++) {
      const g = i < i0 + 480 ? 1 - (i - i0) / 480 : 0
      bus.L[i] *= g
      bus.R[i] *= g
    }
  }

  S.filterBus(s.bus("strings"), "hp", 200)
  S.filterBus(s.bus("pad"), "hp", 120)
  const hall = new S.Bus(s.duration), room = new S.Bus(s.duration)
  s.bus("strings").mixInto(hall, 0.35)
  s.bus("pad").mixInto(hall, 0.3)
  s.bus("braam").mixInto(hall, 0.4)
  s.bus("taiko").mixInto(room, 0.35)
  s.bus("snare").mixInto(hall, 0.45)
  s.bus("piano").mixInto(hall, 0.5)
  s.bus("fx").mixInto(hall, 0.35)
  s.bus("perc").mixInto(room, 0.3)
  const out = mixdown(s, { drone: -3, perc: -6, braam: -1, taiko: 0, snare: -3, strings: -3, pad: -5, piano: -2, fx: -1 })
  S.sendReverb(hall, out, 0.9, { room: 0.93, damp: 0.25, predelay: 0.03 })
  S.sendReverb(room, out, 0.5, { room: 0.6, damp: 0.45 })
  return { bus: out, cues: s.cues }
}

/* =====================================================================
   C · Groove — 100 BPM swung funk in C
   ===================================================================== */

export function groove() {
  const s = new Score({ bpm: 100, bars: 14, tail: 2.6, swing: 0.6 })
  const T = (b, beat = 0, six = 0) => s.t(b, beat, six)
  const PROG = [
    { root: "D2", ep: ["F3", "A3", "C4", "E4"] }, // Dm9
    { root: "G1", ep: ["F3", "A3", "B3", "E4"] }, // G13
    { root: "C2", ep: ["E3", "G3", "B3", "D4"] }, // Cmaj9
    { root: "A1", ep: ["G3", "B3", "C4", "E4"] }, // Am9
  ]
  const chord = (b) => PROG[b % 4]
  const drums = (b) => (b >= 2 && b <= 10) || b === 12 || b === 13

  // ---- drums: boom-bap with swung sixteenth hats ----
  const K = S.kick({ f0: 130, f1: 50, decay: 0.26, click: 0.25, drive: 2.2, pitchDecay: 0.04 })
  const SN = S.snare({ tone: 210, decay: 0.15, toneDecay: 0.06, snap: 1.25 })
  const GH = S.snare({ tone: 230, decay: 0.05, snap: 0.6, seed: 14 })
  const HC = S.hat({ decay: 0.028, seed: 18 }), HO = S.hat({ open: true, decay: 0.2, seed: 19 })
  const SNP = S.snap()
  const KICKS = [0, 7, 10], SNARES = [4, 12]
  for (let b = 0; b < 14; b++) {
    if (b <= 1 || b === 11) {
      // snaps carry the intro and the stop
      for (const beat of [1, 3]) {
        if (b === 11 && beat === 1) continue
        s.bus("snap").add(SNP, T(b, beat), 0.8, 0.15)
        s.cues.snares.push(round(T(b, beat)))
      }
      if (b === 11) {
        s.bus("kick").add(K, T(b), 1)
        s.bus("snare").add(SN, T(b), 0.6)
        s.cues.kicks.push(round(T(b)))
      }
      continue
    }
    if (!drums(b)) continue
    for (let k = 0; k < 16; k++) {
      const t = T(b, 0, k)
      if (KICKS.includes(k) || (b % 2 === 1 && k === 14)) {
        s.bus("kick").add(K, t, k === 0 ? 1 : 0.85)
        s.cues.kicks.push(round(t))
      }
      if (SNARES.includes(k)) {
        s.bus("snare").add(SN, t, 0.9, 0.05)
        s.cues.snares.push(round(t))
      }
      if ((k === 15 || k === 9) && b % 2 === 0) s.bus("snare").add(GH, t, 0.22, 0.1)
      s.bus("hats").add(k === 6 && b % 4 === 3 ? HO : HC, t, (k % 4 === 0 ? 0.35 : k % 2 ? 0.16 : 0.26), 0.3)
    }
  }

  // ---- finger bass: syncopated, with a chromatic walk into each bar ----
  const BASS = [[0, 0, 3], [6, 0, 1], [7, 12, 2], [10, 7, 2], [14, 0, 1]]
  for (let b = 2; b < 14; b++) {
    if (!(drums(b) || b === 11)) continue
    const root = S.midi(chord(b).root)
    const next = S.midi(chord(b + 1).root)
    const pattern = b === 11 ? [[0, 0, 4]] : BASS
    for (const [step, iv, len] of pattern) {
      s.bus("bass").add(S.voice(root + iv, (len / 4) * s.spb * 0.9, {
        oscs: [{ type: "tri", gain: 0.9 }, { type: "sine", gain: 0.7 }, { type: "saw", gain: 0.12 }],
        attack: 0.008, decay: 0.2, sustain: 0.6, release: 0.06, cutoff: 700, cutoffEnv: 900, cutoffDecay: 0.05, q: 0.8, drive: 1.8, seed: 500 + step,
      }), T(b, 0, step), 0.8)
    }
    if (b !== 11) {
      // a half step under the next root, kept within a fifth of this one
      let approach = next - 1
      while (approach - root > 7) approach -= 12
      while (root - approach > 7) approach += 12
      s.bus("bass").add(S.voice(approach, s.spb * 0.2, { oscs: [{ type: "tri" }, { type: "sine", gain: 0.6 }], cutoff: 800, drive: 1.6, glideFrom: approach - 2, glideTime: 0.04 }), T(b, 3, 3), 0.55)
    }
  }
  // the slide out of the stop
  s.bus("bass").add(S.voice("C2", s.spb * 1.4, { oscs: [{ type: "tri" }, { type: "sine", gain: 0.7 }], cutoff: 900, drive: 1.6, glideFrom: "C3", glideTime: s.spb * 1.2 }), T(11, 2), 0.6)

  // ---- Rhodes: comping on the "and"s, with a little push ----
  for (let b = 0; b < 14; b++) {
    if (b === 11) continue
    const c = chord(b)
    const hits = b <= 1 ? [[0, 6], [10, 4]] : [[0, 3], [6, 2], [10, 3], [14, 2]]
    for (const [step, len] of hits) {
      c.ep.forEach((n, i) => s.bus("ep").add(S.epiano(n, (len / 4) * s.spb, { decay: 1.1, index: 1.8, seed: 600 + i }), T(b, 0, step) + i * 0.004, 0.2, (i - 1.5) * 0.35))
    }
  }
  // stop-time chord and the final chord
  ;["F3", "A3", "C4", "E4"].forEach((n, i) => s.bus("ep").add(S.epiano(n, s.spb * 2, { decay: 1.6 }), T(11), 0.24, (i - 1.5) * 0.35))
  ;["E3", "G3", "B3", "D4", "G4"].forEach((n, i) => s.bus("ep").add(S.epiano(n, s.spb * 4, { decay: 2.2 }), T(14), 0.24, (i - 2) * 0.3))

  // ---- brass stabs on the accents ----
  const stab = (t, notes, gain = 0.22) => notes.forEach((n, i) => s.bus("brass").add(S.voice(n, s.spb * 0.22, {
    oscs: [{ type: "saw", detune: -9 }, { type: "saw", detune: 9 }, { type: "saw", octave: -1, gain: 0.5 }],
    attack: 0.012, decay: 0.12, sustain: 0.4, release: 0.08, cutoff: 600, cutoffEnv: 3200, cutoffDecay: 0.06, q: 0.7, drive: 1.3, seed: 700 + i,
  }), t, gain, (i - 1) * 0.4))
  for (const b of [3, 5, 7, 9]) stab(T(b, 2, 2), chord(b).ep.slice(1).map((n) => S.midi(n) + 12))
  stab(T(12), ["C5", "E5", "G5", "B5"], 0.3)
  stab(T(13, 3, 2), ["D5", "F5", "A5", "C6"], 0.25)
  stab(T(14), ["C5", "E5", "G5", "D6"], 0.32)

  // ---- a whistled hook ----
  const WHISTLE = [[4, 0, "E5", 2], [4, 2, "G5", 2], [4, 4, "A5", 3], [4, 8, "G5", 2], [4, 10, "E5", 2], [4, 12, "D5", 4],
    [5, 0, "C5", 2], [5, 2, "D5", 2], [5, 4, "E5", 6], [5, 12, "G4", 2], [5, 14, "A4", 2],
    [12, 0, "E5", 2], [12, 2, "G5", 2], [12, 4, "C6", 4], [12, 10, "B5", 2], [12, 12, "G5", 4], [13, 0, "A5", 3], [13, 4, "G5", 2], [13, 6, "E5", 6]]
  let prevW = null
  for (const [b, step, n, len] of WHISTLE) {
    s.bus("whistle").add(S.voice(n, (len / 4) * s.spb * 0.95, {
      oscs: [{ type: "sine" }, { type: "tri", gain: 0.12, octave: 1 }], attack: 0.025, decay: 0.4, sustain: 0.8, release: 0.08,
      cutoff: 6000, vibrato: 22, vibratoRate: 5.8, vibratoDelay: 0.09, glideFrom: prevW, glideTime: 0.05,
    }), T(b, 0, step), 0.17, 0.1)
    prevW = n
  }

  // ---- sound design ----
  const marks = {
    words1: [T(0), T(0, 1), T(0, 2)], words2: [T(1), T(1, 1), T(1, 2), T(1, 3)], window: T(2), cmd: T(2, 3), open: T(3),
    click: T(3, 1), align: T(4), measure: T(5), tokens: T(6), tokSteps: [T(6, 1), T(6, 2), T(6, 3)], canvas: T(7), notes: T(8),
    pins: [T(8, 1), T(8, 2), T(8, 3)], send: T(9), press: T(9, 1), code: T(10), stop: T(11), logo: T(12), tagline: T(13), end: s.end,
  }
  for (const [k, v] of Object.entries(marks)) s.cues.marks[k] = Array.isArray(v) ? v.map(round) : round(v)
  for (const t of [T(2), T(3), T(12)]) s.bus("fx").add(S.pop({ f0: 700, f1: 180, len: 0.14 }), t, 0.45)
  for (const t of [marks.cmd, marks.click, ...marks.tokSteps, marks.press]) s.bus("fx").add(S.tick({ f: 2400 }), t, 0.4)
  for (const [i, t] of marks.pins.entries()) s.bus("fx").add(S.pop({ f0: 1200 - 150 * i, f1: 380 }), t, 0.4, (i - 1) * 0.5)
  for (const [i, b] of [4, 5, 6, 7, 8, 9, 10].entries()) {
    const [L, R] = S.whoosh(s.spb * 0.45, { from: i % 2 ? 0.6 : -0.6, to: i % 2 ? -0.6 : 0.6, f0: 700, f1: 3500, seed: 800 + i })
    s.bus("fx").addStereo(L, R, T(b) - s.spb * 0.3, 0.3)
  }
  s.cues.hits = [T(2), T(3), T(12), T(14)].map(round)

  // ---- mix ----
  S.filterBus(s.bus("hats"), "hp", 3500)
  S.filterBus(s.bus("ep"), "hp", 150)
  S.duck(s.bus("bass"), s.cues.kicks, { depth: 0.25, release: 0.1 })
  // tremolo on the Rhodes: a slow stereo sway
  {
    const ep = s.bus("ep")
    for (let i = 0; i < ep.n; i++) {
      const w = Math.sin((2 * Math.PI * 4.5 * i) / S.SR) * 0.22
      ep.L[i] *= 1 - w
      ep.R[i] *= 1 + w
    }
  }
  const room = new S.Bus(s.duration), hall = new S.Bus(s.duration)
  s.bus("snare").mixInto(room, 0.35)
  s.bus("snap").mixInto(room, 0.6)
  s.bus("ep").mixInto(room, 0.3)
  s.bus("brass").mixInto(room, 0.35)
  s.bus("whistle").mixInto(hall, 0.4)
  s.bus("fx").mixInto(room, 0.3)
  const out = mixdown(s, { kick: 0, snare: -2, snap: -3, hats: -7, bass: -1, ep: -3, brass: -4, whistle: -3, fx: -2 })
  S.sendReverb(room, out, 0.55, { room: 0.62, damp: 0.45 })
  S.sendReverb(hall, out, 0.6, { room: 0.84, damp: 0.35 })
  S.sendDelay(s.bus("whistle"), out, 0.25, { time: s.spb * 0.75, feedback: 0.3, lp: 3000 })
  return { bus: out, cues: s.cues }
}

export const SCORES = { a: bounce, b: cinematic, c: groove }
