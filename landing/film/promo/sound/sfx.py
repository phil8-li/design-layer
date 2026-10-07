"""The film's sound effects, built from noise and tones (nothing sampled), each a
stereo float32 array at 48 kHz peaking at 1.0; mix.py sets their levels.

Kept to the few kinds a product film needs: the interface's own small sounds
(click, key, detent tick, blip, pop), air for the camera and the layers (whoosh,
breeze, riser, swell, settle), weight for landings (impact, boom, thud), and light
for the agent's shimmer and the name (chime, sparkle, sheen, sweep). Every one is
short, soft-edged and dry enough to sit under music; the reverb is one shared, small room.
"""

import numpy as np
from pedalboard import Pedalboard, Reverb, HighpassFilter, LowpassFilter, PeakFilter, Compressor

SR = 48000


def _n(dur):
    return max(1, int(round(dur * SR)))


def _t(n):
    return np.arange(n) / SR


def stereo(mono, pan=0.0):
    """Constant-power pan; pan may be an array (moving)."""
    th = (np.asarray(pan) + 1) * np.pi / 4
    return np.stack([mono * np.cos(th), mono * np.sin(th)], axis=1).astype(np.float32)


def norm(x, peak=1.0):
    m = np.abs(x).max()
    return (x / m * peak).astype(np.float32) if m > 0 else x.astype(np.float32)


def fx(x, *plugins):
    """Runs a stereo array through pedalboard plugins (they want channels first)."""
    return Pedalboard(list(plugins))(x.T.astype(np.float32), SR).T


def room(x, size=0.18, wet=0.12, damp=0.6, width=1.0, tail=0.6):
    pad = np.zeros((_n(tail), 2), np.float32)
    return fx(np.concatenate([x, pad]), Reverb(room_size=size, damping=damp, wet_level=wet, dry_level=1 - wet * 0.5, width=width))


def shaped_noise(dur, center, width, gain, seed=0, nfft=1024, hop=256):
    """Noise whose spectrum is a band (Gaussian in octaves) that moves over time:
    center(u) Hz, width(u) octaves and gain(u), for u from 0 to 1 over the sound."""
    n = _n(dur)
    frames = 1 + n // hop
    rng = np.random.default_rng(seed)
    f = np.fft.rfftfreq(nfft, 1 / SR)
    u = np.linspace(0, 1, frames)[:, None]
    spec = rng.standard_normal((frames, len(f))) + 1j * rng.standard_normal((frames, len(f)))
    band = np.exp(-0.5 * (np.log2(np.maximum(f, 20) / center(u)) / (width(u) / 2)) ** 2)
    band *= (np.maximum(f, 20) / 1000) ** -0.5  # pink, not white: air sounds warm, not hissy
    spec *= band * gain(u)
    win = np.hanning(nfft)
    out = np.zeros(n + nfft)
    seg = np.fft.irfft(spec, nfft, axis=1) * win
    for i in range(frames):
        out[i * hop:i * hop + nfft] += seg[i]
    return out[:n]


def ease(u):
    return u * u * (3 - 2 * u)


# ---------- the interface's own small sounds ----------

def click(pitch=1.0, seed=1, soft=0.0):
    """A trackpad click: a 4 ms burst of filtered noise, a tiny tonal tick and a hint of body."""
    n = _n(0.05)
    t = _t(n)
    rng = np.random.default_rng(seed)
    burst = rng.standard_normal(n) * np.exp(-t / 0.0012)
    tick = np.sin(2 * np.pi * 2900 * pitch * t) * np.exp(-t / (0.0016 + 0.002 * soft))
    body = np.sin(2 * np.pi * 190 * pitch * t) * np.exp(-t / 0.005) * 0.35
    x = stereo(norm(burst) * 0.7 + tick * 0.55 + body)
    x = fx(x, HighpassFilter(500), LowpassFilter(9000 - 4000 * soft))
    return norm(room(x, size=0.1, wet=0.08, tail=0.15))


def key(seed=0, pitch=1.0):
    """A soft keyboard tap: a plastic tick over a short low body; each one a little different."""
    rng = np.random.default_rng(seed)
    p = pitch * (1 + rng.uniform(-0.08, 0.08))
    n = _n(0.06)
    t = _t(n)
    burst = rng.standard_normal(n) * np.exp(-t / 0.0018)
    res = np.sin(2 * np.pi * 1350 * p * t) * np.exp(-t / 0.003) * 0.6
    body = np.sin(2 * np.pi * 260 * p * t) * np.exp(-t / 0.007) * 0.5
    x = stereo(norm(burst) * 0.6 + res + body, pan=rng.uniform(-0.15, 0.15))
    x = fx(x, HighpassFilter(300), LowpassFilter(7000))
    return norm(room(x, size=0.1, wet=0.06, tail=0.12)) * rng.uniform(0.75, 1.0)


def tick(step=0, steps=12):
    """A detent, like a rotary encoder: tiny, high, and rising a little with the value."""
    n = _n(0.03)
    t = _t(n)
    f = 3200 * 2 ** (step / steps * 0.5)
    x = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.0015) + np.random.default_rng(step).standard_normal(n) * np.exp(-t / 0.0006) * 0.4
    return norm(fx(stereo(x), HighpassFilter(1500)))


def blip(f=1600, dur=0.09, drop=1.18):
    """A measuring blip: a pure tone that settles onto its pitch."""
    n = _n(dur)
    t = _t(n)
    fr = f * (1 + (drop - 1) * np.exp(-t / 0.012))
    ph = 2 * np.pi * np.cumsum(fr) / SR
    x = np.sin(ph) * np.minimum(1, t / 0.002) * np.exp(-t / (dur * 0.35))
    return norm(room(stereo(x), size=0.2, wet=0.15, tail=0.3))


def pop(dur=0.12):
    """A note saved: a small rounded rise."""
    n = _n(dur)
    t = _t(n)
    fr = 480 + 420 * (1 - np.exp(-t / 0.02))
    x = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.minimum(1, t / 0.003) * np.exp(-t / 0.035)
    return norm(room(stereo(x), size=0.15, wet=0.1, tail=0.25))


def presence(dur=0.18):
    """The agent arriving: a soft FM blip, a little digital, never cute."""
    n = _n(dur)
    t = _t(n)
    mod = np.sin(2 * np.pi * 330 * t) * 2.2 * np.exp(-t / 0.04)
    x = np.sin(2 * np.pi * 990 * t + mod) * np.minimum(1, t / 0.004) * np.exp(-t / 0.05)
    return norm(room(stereo(x), size=0.25, wet=0.18, tail=0.4))


# ---------- air: the camera and the layers ----------

def whoosh(dur=0.9, f0=500, f1=2400, pan0=0.0, pan1=0.0, peak_at=0.6, width=1.3, air=0.12, seed=3):
    """Air moving past: a band of noise sliding from f0 to f1 Hz, swelling to its peak at
    peak_at of the way through, moving across the stereo field from pan0 to pan1."""
    def g(u):
        a = np.where(u < peak_at, ease(u / peak_at), ease((1 - u) / (1 - peak_at)))
        return a ** 1.4
    center = lambda u: f0 * (f1 / f0) ** u
    left = shaped_noise(dur, center, lambda u: width + 0 * u, g, seed)
    right = shaped_noise(dur, center, lambda u: width + 0 * u, g, seed + 101)
    hi = shaped_noise(dur, lambda u: 7000 + 3000 * u, lambda u: 1.5 + 0 * u, g, seed + 7) * air
    n = len(left)
    pan = np.linspace(pan0, pan1, n)
    th = (pan + 1) * np.pi / 4
    x = np.stack([(left + hi) * np.cos(th) * 1.15, (right + hi) * np.sin(th) * 1.15], axis=1)
    return norm(room(x.astype(np.float32), size=0.35, wet=0.14, tail=0.5))


def breeze(dur=1.0, f0=350, f1=1100, pan0=0.0, pan1=0.0, peak_at=0.55, seed=37):
    """A camera move felt more than heard: a low, narrow band of air with no hiss on top,
    for a cut where the music already carries the motion."""
    w = whoosh(dur, f0, f1, pan0, pan1, peak_at=peak_at, width=1.0, air=0.0, seed=seed)
    return norm(fx(w, LowpassFilter(3200)))


def swell(dur=1.2, seed=43):
    """A reversed cymbal: air that blooms into a cue and stops on it, the way a trailer leads
    into a hit. Place it so it ends on the cue."""
    n = _n(dur)
    t = _t(n)
    rng = np.random.default_rng(seed)
    hit = fx(stereo(rng.standard_normal(n) * np.exp(-t / 0.35)), HighpassFilter(2000), LowpassFilter(8000))
    x = room(hit, size=0.8, wet=0.5, damp=0.4, tail=0.0)[:n][::-1].copy()
    x *= np.minimum(1, t / (dur * 0.3))[:, None]
    x[-_n(0.006):] *= np.linspace(1, 0, _n(0.006))[:, None]
    return norm(x)


def riser(dur=2.0, f0=300, f1=6000, seed=5):
    """Tension that resolves on a cue: rising air and a rising tone, ending at its loudest."""
    n = _n(dur)
    t = _t(n)
    u = t / dur
    air = shaped_noise(dur, lambda v: f0 * (f1 / f0) ** (v ** 1.5), lambda v: 1.2 + 0 * v, lambda v: (v ** 2.2), seed)
    fr = 110 * 2 ** (u * 2)
    tone = (np.sin(2 * np.pi * np.cumsum(fr) / SR) * 0.5 + np.sin(2 * np.pi * np.cumsum(fr * 2.005) / SR) * 0.3) * u ** 2.5 * 0.25
    x = stereo(norm(air) + tone)
    x[-_n(0.01):] *= np.linspace(1, 0, _n(0.01))[:, None]
    return norm(room(x, size=0.3, wet=0.1, tail=0.2))


def settle(dur=0.7, seed=9):
    """A layer landing back on the page: air falling, and a soft touch at the end."""
    w = whoosh(dur, f0=2200, f1=420, peak_at=0.55, width=1.1, air=0.15, seed=seed)
    th = thud(0.18, f0=110, f1=70) * 0.5
    out = np.zeros((len(w) + len(th), 2), np.float32)
    out[:len(w)] += w * 0.7
    i = _n(dur * 0.92)
    out[i:i + len(th)] += th
    return norm(out)


# ---------- weight ----------

def impact(depth=1.0, dur=1.4, seed=11):
    """A landing with weight: a low tone falling in pitch, a muffled transient, a long soft tail."""
    n = _n(dur)
    t = _t(n)
    fr = 62 * depth ** -0.3 * (1 + 0.6 * np.exp(-t / 0.05))
    sub = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t / (0.38 * depth))
    rng = np.random.default_rng(seed)
    hit = rng.standard_normal(n) * np.exp(-t / 0.012)
    x = stereo(sub + norm(fx(stereo(hit), LowpassFilter(1800))[:, 0]) * 0.35)
    x = fx(x, Compressor(threshold_db=-12, ratio=3, attack_ms=1, release_ms=120))
    return norm(room(x, size=0.6, wet=0.22, damp=0.4, tail=1.2))


def boom(dur=2.2, f0=58, f1=36, seed=41):
    """A trailer's low boom: a sub falling in pitch under a soft, muffled strike, in a large hall."""
    n = _n(dur)
    t = _t(n)
    fr = f1 + (f0 - f1) * np.exp(-t / 0.18)
    sub = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.minimum(1, t / 0.004) * np.exp(-t / 0.7)
    strike = fx(stereo(np.random.default_rng(seed).standard_normal(n) * np.exp(-t / 0.02)), LowpassFilter(900))[:, 0]
    x = stereo(sub + norm(strike) * 0.3)
    return norm(room(x, size=0.85, wet=0.25, damp=0.5, tail=1.5))


def thud(dur=0.25, f0=120, f1=60):
    n = _n(dur)
    t = _t(n)
    fr = f1 + (f0 - f1) * np.exp(-t / 0.03)
    x = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.minimum(1, t / 0.001) * np.exp(-t / (dur * 0.3))
    return norm(stereo(x))


# ---------- light ----------

def chime(notes=(2093.0,), gap=0.09, dur=1.2, bright=1.0):
    """Glass: a few inharmonic partials per note, struck and left to ring."""
    n = _n(dur + gap * len(notes))
    out = np.zeros(n)
    for k, f in enumerate(notes):
        i = _n(gap * k)
        t = _t(n - i)
        tone = sum(a * np.sin(2 * np.pi * f * r * t) * np.exp(-t / (dur * d)) for r, a, d in ((1, 1, 0.45), (2.76, 0.35 * bright, 0.2), (5.4, 0.18 * bright, 0.1)))
        out[i:] += tone * np.minimum(1, t / 0.002)
    return norm(room(stereo(out), size=0.45, wet=0.25, tail=1.0))


def sparkle(dur=2.0, rate=14.0, period=2.0, seed=13, f_lo=4200, f_hi=9000):
    """A white light running round: tiny glassy grains, thickest once per turn of the light,
    each panned to where the light is on its way round."""
    rng = np.random.default_rng(seed)
    n = _n(dur)
    out = np.zeros((n + _n(0.2), 2))
    count = int(rate * dur)
    for _ in range(count):
        at = rng.uniform(0, dur)
        phase = (at % period) / period
        if rng.uniform() > 0.45 + 0.55 * np.cos(np.pi * phase) ** 2:
            continue
        f = rng.uniform(f_lo, f_hi)
        g = _t(_n(0.12))
        grain = np.sin(2 * np.pi * f * g) * np.exp(-g / rng.uniform(0.015, 0.05)) * rng.uniform(0.4, 1.0)
        pan = np.sin(2 * np.pi * phase) * 0.7
        i = _n(at)
        out[i:i + len(grain)] += stereo(grain, pan)
    pad_t = _t(n)
    pad = sum(np.sin(2 * np.pi * f * pad_t + p) for f, p in ((5274, 0), (6272, 1.3), (7040, 2.1))) * 0.06
    pad *= (0.5 + 0.5 * np.sin(2 * np.pi * pad_t / period)) * np.minimum(1, pad_t / 0.3) * np.minimum(1, (dur - pad_t) / 0.4)
    out[:n] += stereo(pad)
    x = fx(out.astype(np.float32), HighpassFilter(3000))
    return norm(room(x, size=0.5, wet=0.3, tail=0.8))


def sheen(dur=0.85, seed=17):
    """The sheen crossing the button: a bright, glassy band sweeping up, with a few grains."""
    band = shaped_noise(dur, lambda u: 1500 * 6 ** ease(u), lambda u: 0.5 + 0 * u, lambda u: np.sin(np.pi * u) ** 1.5, seed)
    band2 = shaped_noise(dur, lambda u: 1500 * 6 ** ease(u), lambda u: 0.5 + 0 * u, lambda u: np.sin(np.pi * u) ** 1.5, seed + 5)
    x = np.stack([band, band2], axis=1).astype(np.float32)
    x = norm(fx(x, PeakFilter(4000, 4, 1.2)))
    g = sparkle(dur, rate=30, period=dur * 2, seed=seed + 2)[:len(x)] * 0.5
    x[:len(g)] += g
    return norm(room(x, size=0.4, wet=0.2, tail=0.7))


def sweep(dur=2.2, pan0=-0.7, pan1=0.7, seed=19):
    """A light crossing a word, left to right: a soft high band travelling with it."""
    w = whoosh(dur, f0=2000, f1=5500, pan0=pan0, pan1=pan1, peak_at=0.5, width=0.8, air=0.2, seed=seed)
    return norm(w)


def drone(dur=4.0, f=55.0, seed=23):
    """The dark before the line: a low, slowly opening hum with a little air in it."""
    n = _n(dur)
    t = _t(n)
    tone = np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 1.5 * t + 0.7) + 0.25 * np.sin(2 * np.pi * f * 2.01 * t)
    air = shaped_noise(dur, lambda u: 300 + 600 * u, lambda u: 2.0 + 0 * u, lambda u: 0.3 + 0.7 * u, seed)
    x = tone * 0.6 + norm(air) * 0.25
    x *= np.minimum(1, t / (dur * 0.6)) * np.minimum(1, (dur - t) / 0.3)
    return norm(stereo(x))


def bloom(dur=2.5, root=146.83, seed=29):
    """The name arriving: a soft major chord that swells and fades, under a chime."""
    n = _n(dur)
    t = _t(n)
    chord = sum(a * np.sin(2 * np.pi * root * r * t + k) for k, (r, a) in enumerate(((1, 1), (1.25, 0.6), (1.5, 0.7), (2, 0.5), (3, 0.2))))
    chord *= np.minimum(1, t / 0.6) ** 2 * np.exp(-np.maximum(0, t - 0.6) / 0.9)
    x = fx(stereo(chord), LowpassFilter(3500))
    c = chime((root * 8, root * 12), gap=0.12, dur=1.4, bright=0.7)
    out = np.zeros((max(len(x), len(c)) + _n(0.1), 2), np.float32)
    out[:len(x)] += norm(x) * 0.8
    out[:len(c)] += c * 0.45
    return norm(room(out, size=0.6, wet=0.25, tail=1.2))
