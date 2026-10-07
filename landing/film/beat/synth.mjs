/**
 * A small deterministic synthesizer for the launch film's soundtrack: no
 * samples, no dependencies. Every sound is computed from oscillators, noise,
 * filters and envelopes, so a score renders to the same WAV every time and
 * the film can cut to its exact beat times.
 */

export const SR = 48000

/** mulberry32: a seeded PRNG, so noise (and so every render) is repeatable. */
export function rng(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
/** "C4", "F#3", "Bb2" → MIDI number (C4 = 60). Numbers pass through. */
export function midi(n) {
  if (typeof n === "number") return n
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(n)
  if (!m) throw new Error(`bad note ${n}`)
  return NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) + 1) * 12
}
export const hz = (n) => 440 * Math.pow(2, (midi(n) - 69) / 12)
export const db = (d) => Math.pow(10, d / 20)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

/* ---------- buffers ---------- */

export const mono = (seconds) => new Float32Array(Math.max(1, Math.ceil(seconds * SR)))

/** A stereo bus the length of the piece. Sounds are added at sample-exact times. */
export class Bus {
  constructor(seconds) {
    this.n = Math.ceil(seconds * SR)
    this.L = new Float32Array(this.n)
    this.R = new Float32Array(this.n)
  }
  /** Adds a mono buffer at t seconds, equal-power panned (-1 left … 1 right). */
  add(buf, t, gain = 1, pan = 0) {
    const i0 = Math.round(t * SR)
    const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4
    const gl = Math.cos(a) * Math.SQRT2 * gain
    const gr = Math.sin(a) * Math.SQRT2 * gain
    const lo = Math.max(0, -i0), hi = Math.min(buf.length, this.n - i0)
    for (let i = lo; i < hi; i++) {
      this.L[i0 + i] += buf[i] * gl
      this.R[i0 + i] += buf[i] * gr
    }
  }
  addStereo(L, R, t, gain = 1) {
    const i0 = Math.round(t * SR)
    const lo = Math.max(0, -i0), hi = Math.min(L.length, this.n - i0)
    for (let i = lo; i < hi; i++) {
      this.L[i0 + i] += L[i] * gain
      this.R[i0 + i] += R[i] * gain
    }
  }
  mixInto(dest, gain = 1) {
    for (let i = 0; i < this.n; i++) {
      dest.L[i] += this.L[i] * gain
      dest.R[i] += this.R[i] * gain
    }
    return dest
  }
  scale(g) {
    for (let i = 0; i < this.n; i++) {
      this.L[i] *= g
      this.R[i] *= g
    }
    return this
  }
}

/* ---------- oscillators ---------- */

function blep(t, dt) {
  if (t < dt) {
    t /= dt
    return t + t - t * t - 1
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt
    return t * t + t + t + 1
  }
  return 0
}

/** Band-limited oscillator (polyBLEP saw and square). Call next(freq) per sample. */
export class Osc {
  constructor(type = "sine", phase = 0) {
    this.type = type
    this.p = phase
  }
  next(f) {
    const dt = f / SR
    const p = this.p
    let v
    switch (this.type) {
      case "saw":
        v = 2 * p - 1 - blep(p, dt)
        break
      case "square":
        v = (p < 0.5 ? 1 : -1) + blep(p, dt) - blep((p + 0.5) % 1, dt)
        break
      case "tri":
        v = 4 * Math.abs(p - 0.5) - 1
        break
      default:
        v = Math.sin(2 * Math.PI * p)
    }
    this.p += dt
    if (this.p >= 1) this.p -= Math.floor(this.p)
    return v
  }
}

/* ---------- filters ---------- */

/** RBJ biquad. set() may be called per sample for sweeps (cheap enough here). */
export class Biquad {
  constructor(type, f = 1000, q = 0.707, gainDb = 0) {
    this.type = type
    this.x1 = this.x2 = this.y1 = this.y2 = 0
    this.set(f, q, gainDb)
  }
  set(f, q = this.q, gainDb = this.g) {
    this.f = f
    this.q = q
    this.g = gainDb
    const w = (2 * Math.PI * clamp(f, 10, SR * 0.45)) / SR
    const cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q)
    const A = Math.pow(10, gainDb / 40)
    let b0, b1, b2, a0, a1, a2
    switch (this.type) {
      case "hp":
        b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al
        break
      case "bp":
        b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al
        break
      case "peak":
        b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A
        break
      case "lowshelf": {
        const s = 2 * Math.sqrt(A) * al
        b0 = A * (A + 1 - (A - 1) * cs + s); b1 = 2 * A * (A - 1 - (A + 1) * cs); b2 = A * (A + 1 - (A - 1) * cs - s)
        a0 = A + 1 + (A - 1) * cs + s; a1 = -2 * (A - 1 + (A + 1) * cs); a2 = A + 1 + (A - 1) * cs - s
        break
      }
      case "highshelf": {
        const s = 2 * Math.sqrt(A) * al
        b0 = A * (A + 1 + (A - 1) * cs + s); b1 = -2 * A * (A - 1 + (A + 1) * cs); b2 = A * (A + 1 + (A - 1) * cs - s)
        a0 = A + 1 - (A - 1) * cs + s; a1 = 2 * (A - 1 - (A + 1) * cs); a2 = A + 1 - (A - 1) * cs - s
        break
      }
      default: // lp
        b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0
    return this
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
  process(buf) {
    for (let i = 0; i < buf.length; i++) buf[i] = this.run(buf[i])
    return buf
  }
}

/** Filters a whole bus in place (one filter per channel). */
export function filterBus(bus, type, f, q = 0.707, gainDb = 0) {
  const a = new Biquad(type, f, q, gainDb), b = new Biquad(type, f, q, gainDb)
  a.process(bus.L)
  b.process(bus.R)
  return bus
}

/* ---------- envelopes ---------- */

/** Attack, then exponential decay with time constant `decay` (seconds). */
export const perc = (t, attack, decay) => (t < 0 ? 0 : t < attack ? t / attack : Math.exp(-(t - attack) / decay))
/** Linear attack / sustain / linear release around a gate of `len` seconds. */
export function gate(t, len, attack = 0.005, release = 0.05) {
  if (t < 0) return 0
  if (t < attack) return t / attack
  if (t < len) return 1
  return Math.max(0, 1 - (t - len) / release)
}

/* ---------- drums ---------- */

export function kick({ f0 = 165, f1 = 46, pitchDecay = 0.034, decay = 0.3, click = 0.35, drive = 1.8, len = 0.6, seed = 7 } = {}) {
  const out = mono(len), r = rng(seed)
  const hp = new Biquad("hp", 2500, 0.8)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const f = f1 + (f0 - f1) * Math.exp(-t / pitchDecay)
    ph += f / SR
    let v = Math.sin(2 * Math.PI * ph) * perc(t, 0.0015, decay)
    v += hp.run(r() * 2 - 1) * click * Math.exp(-t / 0.004)
    out[i] = Math.tanh(v * drive) / Math.tanh(drive)
  }
  return out
}

export function clap({ decay = 0.16, f = 1500, seed = 11, len = 0.5 } = {}) {
  const out = mono(len), r = rng(seed)
  const bp = new Biquad("bp", f, 1.1), hp = new Biquad("hp", 600, 0.7)
  const bursts = [0, 0.009, 0.018, 0.029]
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    let e = 0
    for (const b of bursts) if (t >= b && t < b + 0.012) e = Math.max(e, Math.exp(-(t - b) / 0.0035))
    const last = bursts[bursts.length - 1]
    if (t >= last) e = Math.max(e, Math.exp(-(t - last) / decay))
    out[i] = hp.run(bp.run(r() * 2 - 1)) * e * 2.6
  }
  return out
}

export function snare({ tone = 185, decay = 0.17, toneDecay = 0.07, snap = 1, seed = 13, len = 0.5 } = {}) {
  const out = mono(len), r = rng(seed)
  const hp = new Biquad("hp", 1800, 0.7), pk = new Biquad("peak", 5200, 1, 5)
  let p1 = 0, p2 = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    p1 += (tone * (1 + 0.5 * Math.exp(-t / 0.01))) / SR
    p2 += (tone * 1.78) / SR
    const body = (Math.sin(2 * Math.PI * p1) + 0.5 * Math.sin(2 * Math.PI * p2)) * perc(t, 0.001, toneDecay)
    const noise = pk.run(hp.run(r() * 2 - 1)) * perc(t, 0.001, decay) * snap
    out[i] = Math.tanh((body * 0.8 + noise * 1.1) * 1.4)
  }
  return out
}

/** Metallic hat: six detuned squares (the 808 recipe) plus noise, high-passed. */
export function hat({ decay = 0.035, open = false, seed = 17, len } = {}) {
  const d = open ? Math.max(decay, 0.22) : decay
  const out = mono(len ?? d * 6 + 0.02), r = rng(seed)
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 1.9)
  const oscs = freqs.map((_, k) => new Osc("square", k * 0.13))
  const bp = new Biquad("bp", 10000, 0.9), hp = new Biquad("hp", 7200, 0.7)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    let m = 0
    for (let k = 0; k < 6; k++) m += oscs[k].next(freqs[k])
    const v = hp.run(bp.run(m * 0.12 + (r() * 2 - 1) * 0.6))
    out[i] = v * perc(t, 0.0008, d) * 1.6
  }
  return out
}

export function shaker({ seed = 19 } = {}) {
  const out = mono(0.12), r = rng(seed)
  const bp = new Biquad("bp", 6500, 1.4)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const e = t < 0.012 ? t / 0.012 : Math.exp(-(t - 0.012) / 0.03)
    out[i] = bp.run(r() * 2 - 1) * e * 1.4
  }
  return out
}

export function snap({ seed = 23 } = {}) {
  const out = mono(0.25), r = rng(seed)
  const bp = new Biquad("bp", 2300, 2.6), hp = new Biquad("hp", 900, 0.7)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    ph += 1850 / SR
    const n = bp.run(r() * 2 - 1) * perc(t, 0.0006, 0.018) * 3.2
    out[i] = hp.run(n + Math.sin(2 * Math.PI * ph) * perc(t, 0.0005, 0.006) * 0.4)
  }
  return out
}

/** A big low drum (taiko-ish): a falling sine with a thump of filtered noise. */
export function boom({ f0 = 95, f1 = 48, decay = 0.85, seed = 29, len = 2.2, noise = 0.6 } = {}) {
  const out = mono(len), r = rng(seed)
  const lp = new Biquad("lp", 420, 0.8)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    ph += (f1 + (f0 - f1) * Math.exp(-t / 0.09)) / SR
    const v = Math.sin(2 * Math.PI * ph) * perc(t, 0.002, decay) + lp.run(r() * 2 - 1) * perc(t, 0.001, 0.12) * noise
    out[i] = Math.tanh(v * 1.5)
  }
  return out
}

export function tom({ f = 140, decay = 0.32, seed = 31 } = {}) {
  const out = mono(decay * 5), r = rng(seed)
  const lp = new Biquad("lp", 900, 0.7)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    ph += (f * (1 + 0.6 * Math.exp(-t / 0.03))) / SR
    out[i] = Math.tanh((Math.sin(2 * Math.PI * ph) * perc(t, 0.001, decay) + lp.run(r() * 2 - 1) * perc(t, 0.001, 0.05) * 0.4) * 1.3)
  }
  return out
}

/* ---------- pitched voices ---------- */

/**
 * Generic subtractive voice: oscillator mix → low-pass with an envelope.
 * oscs: [{ type, detune (cents), gain, octave }]
 */
export function voice(note, len, {
  oscs = [{ type: "saw" }], attack = 0.005, decay = 0.3, sustain = 0.6, release = 0.12,
  cutoff = 1800, cutoffEnv = 0, cutoffDecay = 0.15, q = 0.8, drive = 0, vibrato = 0, vibratoRate = 5.5,
  vibratoDelay = 0.15, glideFrom = null, glideTime = 0.06, seed = 3,
} = {}) {
  const total = len + release + 0.02
  const out = mono(total), r = rng(seed)
  const f0 = hz(note)
  const os = oscs.map((o) => ({ ...o, osc: new Osc(o.type ?? "saw", r()), mult: Math.pow(2, (o.detune ?? 0) / 1200) * Math.pow(2, o.octave ?? 0) }))
  const lp = new Biquad("lp", cutoff, q)
  const fg = glideFrom == null ? null : hz(glideFrom)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    let f = f0
    if (fg) f = fg * Math.pow(f0 / fg, Math.min(1, t / glideTime))
    if (vibrato && t > vibratoDelay) f *= Math.pow(2, (vibrato / 1200) * Math.sin(2 * Math.PI * vibratoRate * (t - vibratoDelay)) * Math.min(1, (t - vibratoDelay) / 0.2))
    let s = 0
    for (const o of os) s += o.osc.next(f * o.mult) * (o.gain ?? 1)
    if (i % 16 === 0) lp.set(cutoff + cutoffEnv * Math.exp(-t / cutoffDecay), q)
    let v = lp.run(s)
    if (drive) v = Math.tanh(v * drive) / Math.tanh(drive)
    let e
    if (t < attack) e = t / attack
    else if (t < len) e = sustain + (1 - sustain) * Math.exp(-(t - attack) / decay)
    else {
      const atRel = sustain + (1 - sustain) * Math.exp(-(len - attack) / decay)
      e = atRel * Math.max(0, 1 - (t - len) / release)
    }
    out[i] = v * e
  }
  return out
}

/** Seven detuned saws: the big bright pad of pop and trance. Returns [L, R]. */
export function supersaw(notes, len, { attack = 0.25, release = 0.6, cutoff = 2600, detune = 16, voices = 7, seed = 5 } = {}) {
  const total = len + release + 0.02
  const L = mono(total), R = mono(total), r = rng(seed)
  const lpL = new Biquad("lp", cutoff, 0.6), lpR = new Biquad("lp", cutoff, 0.6)
  const vs = []
  for (const n of notes) {
    for (let k = 0; k < voices; k++) {
      const spread = voices === 1 ? 0 : (k / (voices - 1)) * 2 - 1
      vs.push({ osc: new Osc("saw", r()), f: hz(n) * Math.pow(2, (spread * detune) / 1200), pan: spread * 0.85 })
    }
  }
  const g = 1 / Math.sqrt(vs.length)
  for (let i = 0; i < L.length; i++) {
    const t = i / SR
    const e = gate(t, len, attack, release)
    let l = 0, rr = 0
    for (const v of vs) {
      const s = v.osc.next(v.f)
      l += s * (1 - v.pan) * 0.5
      rr += s * (1 + v.pan) * 0.5
    }
    L[i] = lpL.run(l * g) * e
    R[i] = lpR.run(rr * g) * e
  }
  return [L, R]
}

/** Electric piano (FM, 1:1 with a bright tine partial), with a little tremolo. */
export function epiano(note, len, { decay = 1.4, index = 2.2, tine = 0.18, release = 0.25, seed = 37 } = {}) {
  const total = len + release + 0.05
  const out = mono(total)
  const f = hz(note)
  let pc = 0, pm = 0, pt = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const idx = index * Math.exp(-t / 0.35) + 0.25
    pm += f / SR
    const mod = Math.sin(2 * Math.PI * pm) * idx
    pc += f / SR
    pt += (f * 14) / SR
    const body = Math.sin(2 * Math.PI * pc + mod)
    const bell = Math.sin(2 * Math.PI * pt) * tine * Math.exp(-t / 0.05)
    const e = (t < 0.003 ? t / 0.003 : Math.exp(-(t - 0.003) / decay)) * (t < len ? 1 : Math.max(0, 1 - (t - len) / release))
    out[i] = (body + bell) * e
  }
  return out
}

/** Piano-ish: a few inharmonic partials with their own decays. */
export function piano(note, len, { decay = 2.2, seed = 41 } = {}) {
  const out = mono(len + 0.4)
  const f = hz(note)
  const parts = [[1, 1, 1], [2, 0.5, 0.7], [3, 0.28, 0.5], [4, 0.16, 0.35], [5, 0.1, 0.25], [6, 0.06, 0.2]]
  const ph = parts.map(() => 0)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    let s = 0
    parts.forEach(([k, g, d], j) => {
      ph[j] += (f * k * (1 + 0.0004 * k * k)) / SR
      s += Math.sin(2 * Math.PI * ph[j]) * g * Math.exp(-t / (decay * d))
    })
    const e = (t < 0.002 ? t / 0.002 : 1) * (t < len ? 1 : Math.max(0, 1 - (t - len) / 0.4))
    out[i] = s * e * 0.6
  }
  return out
}

/* ---------- effects and sound design ---------- */

export function riser(len, { f0 = 300, f1 = 9000, pitch = true, seed = 43 } = {}) {
  const out = mono(len), r = rng(seed)
  const bp = new Biquad("bp", f0, 2.2)
  const saw = new Osc("saw"), lp = new Biquad("lp", 800, 0.7)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR, x = t / len
    if (i % 16 === 0) {
      bp.set(f0 * Math.pow(f1 / f0, x), 2.2)
      lp.set(400 + 6000 * x * x, 0.9)
    }
    let v = bp.run(r() * 2 - 1) * 1.6
    if (pitch) v += lp.run(saw.next(110 * Math.pow(2, x * 2.5))) * 0.25
    out[i] = v * Math.pow(x, 2.2)
  }
  return out
}

export function reverseCymbal(len, { seed = 47 } = {}) {
  const out = mono(len), r = rng(seed)
  const hp = new Biquad("hp", 5000, 0.7)
  for (let i = 0; i < out.length; i++) {
    const x = i / out.length
    out[i] = hp.run(r() * 2 - 1) * Math.pow(x, 3) * 0.9
  }
  return out
}

export function impact({ len = 3, sub = 1, crash = 0.6, seed = 53 } = {}) {
  const out = mono(len), r = rng(seed)
  const lp = new Biquad("lp", 2400, 0.7), hp = new Biquad("hp", 3000, 0.7)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    ph += (30 + 32 * Math.exp(-t / 0.25)) / SR
    const s = Math.sin(2 * Math.PI * ph) * perc(t, 0.003, 1.1) * sub
    const n = lp.run(r() * 2 - 1) * perc(t, 0.001, 0.3) * 0.8 + hp.run(r() * 2 - 1) * perc(t, 0.001, 0.9) * crash * 0.35
    out[i] = Math.tanh((s + n) * 1.4)
  }
  return out
}

/** Air moving past: band-passed noise swept up and down. Returns [L, R], panned across. */
export function whoosh(len, { f0 = 400, f1 = 3200, from = -0.8, to = 0.8, seed = 59 } = {}) {
  const L = mono(len), R = mono(len), r = rng(seed)
  const bp = new Biquad("bp", f0, 1.3)
  for (let i = 0; i < L.length; i++) {
    const x = i / L.length
    if (i % 16 === 0) bp.set(f0 + (f1 - f0) * Math.sin(Math.PI * x), 1.3)
    const v = bp.run(r() * 2 - 1) * Math.pow(Math.sin(Math.PI * x), 1.6) * 1.5
    const p = ((from + (to - from) * x + 1) * Math.PI) / 4
    L[i] = v * Math.cos(p) * Math.SQRT2
    R[i] = v * Math.sin(p) * Math.SQRT2
  }
  return [L, R]
}

/** A soft UI tick for clicks and key presses. */
export function tick({ f = 2600, seed = 61 } = {}) {
  const out = mono(0.05), r = rng(seed)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    ph += f / SR
    out[i] = Math.sin(2 * Math.PI * ph) * perc(t, 0.0004, 0.006) * 0.8 + (r() * 2 - 1) * perc(t, 0.0002, 0.0015) * 0.5
  }
  return out
}

/** A bubbly pop: a quick downward chirp. */
export function pop({ f0 = 900, f1 = 260, len = 0.09 } = {}) {
  const out = mono(len)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    ph += (f1 + (f0 - f1) * Math.exp(-t / 0.018)) / SR
    out[i] = Math.sin(2 * Math.PI * ph) * perc(t, 0.001, 0.03)
  }
  return out
}

/** Freeverb (Jezar's tunings, scaled to 48 kHz). Returns a wet-only stereo pair. */
export function reverb(L, R, { room = 0.82, damp = 0.3, width = 1, predelay = 0.015 } = {}) {
  const s = SR / 44100
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((v) => Math.round(v * s))
  const apT = [556, 441, 341, 225].map((v) => Math.round(v * s))
  const spread = Math.round(23 * s)
  const mk = (n) => ({ buf: new Float32Array(n), i: 0, store: 0 })
  const cl = combT.map(mk), cr = combT.map((n) => mk(n + spread))
  const al = apT.map(mk), ar = apT.map((n) => mk(n + spread))
  const fb = room * 0.28 + 0.7, dm = damp * 0.4
  const comb = (c, x) => {
    const y = c.buf[c.i]
    c.store = y * (1 - dm) + c.store * dm
    c.buf[c.i] = x + c.store * fb
    if (++c.i >= c.buf.length) c.i = 0
    return y
  }
  const ap = (a, x) => {
    const b = a.buf[a.i]
    a.buf[a.i] = x + b * 0.5
    if (++a.i >= a.buf.length) a.i = 0
    return b - x
  }
  const pd = Math.round(predelay * SR)
  const n = L.length
  const oL = new Float32Array(n), oR = new Float32Array(n)
  const w1 = width / 2 + 0.5, w2 = (1 - width) / 2
  for (let i = 0; i < n; i++) {
    const j = i - pd
    const x = j >= 0 ? (L[j] + R[j]) * 0.015 : 0
    let l = 0, r = 0
    for (let k = 0; k < 8; k++) {
      l += comb(cl[k], x)
      r += comb(cr[k], x)
    }
    for (let k = 0; k < 4; k++) {
      l = ap(al[k], l)
      r = ap(ar[k], r)
    }
    oL[i] = l * w1 + r * w2
    oR[i] = r * w1 + l * w2
  }
  return [oL, oR]
}

/** Sidechain ducking: dips the bus at each kick and lets it swell back. */
export function duck(bus, times, { depth = 0.55, release = 0.16, attack = 0.004 } = {}) {
  const g = new Float32Array(bus.n).fill(1)
  const span = Math.round((attack + release * 5) * SR)
  for (const tk of times) {
    const i0 = Math.round(tk * SR)
    for (let i = 0; i < span; i++) {
      const j = i0 + i
      if (j < 0 || j >= bus.n) continue
      const x = i / SR
      const s = x < attack ? x / attack : Math.exp(-(x - attack) / release)
      const v = 1 - depth * s
      if (v < g[j]) g[j] = v
    }
  }
  for (let i = 0; i < bus.n; i++) {
    bus.L[i] *= g[i]
    bus.R[i] *= g[i]
  }
  return bus
}

export function saturate(bus, drive = 1.3) {
  const k = Math.tanh(drive)
  for (let i = 0; i < bus.n; i++) {
    bus.L[i] = Math.tanh(bus.L[i] * drive) / k
    bus.R[i] = Math.tanh(bus.R[i] * drive) / k
  }
  return bus
}

/** Adds a reverb return of `src` into `dest` at `gain`. */
export function sendReverb(src, dest, gain, opts) {
  const [l, r] = reverb(src.L, src.R, opts)
  for (let i = 0; i < dest.n; i++) {
    dest.L[i] += l[i] * gain
    dest.R[i] += r[i] * gain
  }
}

/** Adds a ping-pong delay return of `src` into `dest`. */
export function sendDelay(src, dest, gain, { time, feedback = 0.4, lp = 3600 }) {
  const d = Math.round(time * SR)
  const n = src.n
  const yl = new Float32Array(n), yr = new Float32Array(n)
  const fl = new Biquad("lp", lp, 0.6), fr = new Biquad("lp", lp, 0.6)
  for (let i = 0; i < n; i++) {
    const back = i - d
    const inp = back >= 0 ? (src.L[back] + src.R[back]) * 0.5 : 0
    // left hears the dry input first, then each echo crosses to the other side
    yl[i] = fl.run(inp + (back >= 0 ? yr[back] * feedback : 0))
    yr[i] = fr.run(back >= 0 ? yl[back] * feedback : 0)
    dest.L[i] += yl[i] * gain
    dest.R[i] += yr[i] * gain
  }
}

/** RMS of a bus in dBFS. */
export function rmsDb(bus) {
  let s = 0
  for (let i = 0; i < bus.n; i++) s += bus.L[i] * bus.L[i] + bus.R[i] * bus.R[i]
  return 10 * Math.log10(s / (2 * bus.n) + 1e-12)
}

/**
 * Master: bring the mix to a loudness target, then a look-ahead peak limiter
 * so nothing clips, then a final safety clip at the ceiling.
 */
export function master(bus, { targetDb = -13, ceiling = db(-1), lookahead = 0.004, release = 0.09 } = {}) {
  const gain = db(targetDb - rmsDb(bus))
  bus.scale(gain)
  const n = bus.n, la = Math.round(lookahead * SR)
  const req = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(bus.L[i]), Math.abs(bus.R[i]))
    req[i] = p > ceiling ? ceiling / p : 1
  }
  // the lowest gain needed anywhere in the next `la` samples (sliding minimum)
  const win = new Float32Array(n)
  const dq = []
  for (let i = n - 1; i >= 0; i--) {
    while (dq.length && req[dq[dq.length - 1]] >= req[i]) dq.pop()
    dq.push(i)
    while (dq[0] > i + la) dq.shift()
    win[i] = req[dq[0]]
  }
  const att = 1 - Math.exp(-1 / (0.0015 * SR)), rel = 1 - Math.exp(-1 / (release * SR))
  let env = 1
  for (let i = 0; i < n; i++) {
    const tg = win[i]
    env += (tg - env) * (tg < env ? att : rel)
    const g = Math.min(env, tg)
    bus.L[i] = clamp(bus.L[i] * g, -ceiling, ceiling)
    bus.R[i] = clamp(bus.R[i] * g, -ceiling, ceiling)
  }
  return { gainDb: 20 * Math.log10(gain), rms: rmsDb(bus) }
}

/** 16-bit PCM WAV with TPDF dither. */
export function wav(bus) {
  const n = bus.n
  const buf = Buffer.alloc(44 + n * 4)
  buf.write("RIFF", 0)
  buf.writeUInt32LE(36 + n * 4, 4)
  buf.write("WAVE", 8)
  buf.write("fmt ", 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write("data", 36)
  buf.writeUInt32LE(n * 4, 40)
  const r = rng(99)
  for (let i = 0; i < n; i++) {
    const d = (r() - r()) / 32768
    buf.writeInt16LE(Math.round(clamp(bus.L[i] + d, -1, 1) * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(clamp(bus.R[i] + d, -1, 1) * 32767), 46 + i * 4)
  }
  return buf
}
