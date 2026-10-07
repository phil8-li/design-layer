#!/usr/bin/env python3
"""Mixes a sound design for a cut: a music bed (bed.py), placed on the beat, shaped to
the story, and sound effects (sfx.py) laid on the cut's cues (cues.mjs), then mastered
for the web and muxed onto the rendered film.

  python3 landing/film/promo/sound/mix.py t keynote --take 2 --video /tmp/designlayer-film/promo/cut-t.mp4
  → ~/.cache/designlayer-site/sound/t/keynote/mix.wav, sfx.wav (the effects alone) and
    /tmp/designlayer-film/promo/cut-t-keynote.mp4

How it follows the picture:
  - The bed is stretched to its exact tempo and slid by under half a beat so a beat
    lands on the editor's landing; the tempo was picked so the agent's hover lands on
    a beat too (bed.py).
  - Its level follows the story section by section (dark, flight, craft, tools,
    breath, payoff, wide, resolve), whatever the take did on its own.
  - It opens through a closed filter that opens fully on the landing, dips and closes
    just before the hover (a held breath) and comes back on it, and closes again as
    the film ends.
  - Each effect sits on its cue: clicks on the pointer's clicks, air on the camera's
    moves (loudest where the move is fastest), a settle where a layer lands, light on
    the agent's shimmer and on the name. Fewer, softer effects in Keynote; every
    interaction voiced in Effortless; punchier, with risers into the drops, in Kinetic.
  - Cinematic and Trailer are composed takes (bed.py compose), cut to picture on their bar
    lines like a music editor would (CUTS): the lift lands on the hover, the groove on the
    landing, the final chord on the name. Effortless's interface sounds stay; the camera's
    air drops to a breeze; a reversed swell and a low boom mark the lift.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from pedalboard import Pedalboard, Compressor, Gain, Limiter, LowpassFilter, HighpassFilter, HighShelfFilter, LadderFilter, PeakFilter, Reverb, time_stretch

sys.path.insert(0, str(Path(__file__).parent))
import sfx  # noqa: E402
from bed import HOME, OPTIONS, sections, FFMPEG  # noqa: E402
from measure import frames, onset_env, beat_phase, beat_envelope, tempo, KICK  # noqa: E402

SR = sfx.SR


def db(v):
    return 10 ** (v / 20)


def smooth_steps(t, points, fade=0.4):
    """A level that holds each point's value from its time, crossfading (raised cosine) over `fade` s."""
    out = np.full_like(t, points[0][1], dtype=np.float64)
    for (a, v0), (b, v1) in zip(points[:-1], points[1:]):
        u = np.clip((t - b + fade / 2) / fade, 0, 1)
        w = 0.5 - 0.5 * np.cos(np.pi * u)
        out = np.where(t >= b - fade / 2, out * (1 - w) + v1 * w, out)
    return out


def ramp(t, keys):
    """Piecewise-linear in value over [(time, value)]."""
    return np.interp(t, [k[0] for k in keys], [k[1] for k in keys])


def lowpass_auto(x, cutoff):
    """A low-pass whose cutoff follows cutoff[i] (Hz per sample), in short blocks."""
    lp = LowpassFilter(cutoff_frequency_hz=20000)
    out = np.zeros_like(x)
    blk = 256
    for i in range(0, len(x), blk):
        lp.cutoff_frequency_hz = float(np.clip(cutoff[min(i + blk // 2, len(x) - 1)], 60, 20000))
        out[i:i + blk] = lp(x[i:i + blk].T, SR, reset=False).T
    return out


def load_bed(cut, name, take):
    sr, x = wavfile.read(HOME / cut / name / f"bed-{take}.wav")
    x = x.astype(np.float32) / 32768.0
    return x


def body_phase(x, bpm, drums, body=(4.6, 29.0)):
    """Where the beats of x fall, measured over the film's body (where the beat plays):
    on the kick and the claps for a drum bed, on every onset otherwise."""
    m = x[int(body[0] * SR):int(body[1] * SR)].mean(1)
    mag, f, fps = frames(m, SR)
    env = beat_envelope(mag, f) if drums else onset_env(mag)
    return (beat_phase(env, fps, bpm) + body[0]) % (60 / bpm)


def place_bed(x, measured, bpm, land, hover, drums=True):
    """Stretch the bed so the landing and the hover fall a whole number of beats apart (a
    hair off the asked tempo), then slide it so a beat falls on the landing: both land on it."""
    kept = measured["bpm_kept"]
    beats = round((hover - land) * bpm / 60)
    bpm = beats * 60 / (hover - land)
    x = time_stretch(x.T.copy(), SR, stretch_factor=bpm / kept).T
    phase = body_phase(x, bpm, drums)
    period = 60 / bpm
    shift = (land - phase) % period
    if shift > period / 2:
        shift -= period
    n = int(round(abs(shift) * SR))
    x = np.concatenate([np.zeros((n, 2), np.float32), x]) if shift > 0 else x[n:]
    return x.astype(np.float32), shift, phase + shift, bpm


def repair(x, bpm, body=(4.6, 34.5), bar_beats=4):
    """Streamed takes now and then drop out for a few tens of milliseconds: patch each dropout with the
    same stretch one bar earlier, crossfaded, which in a looped groove is the same music."""
    step = int(0.05 * SR)
    lv = np.array([20 * np.log10(np.sqrt((x[i:i + step] ** 2).mean()) + 1e-9) for i in range(0, len(x) - step, step)])
    bar = int(round(bar_beats * 60 / bpm * SR))
    fade = int(0.015 * SR)
    fixed = []
    i = int(body[0] * SR) // step
    while i < min(len(lv) - 10, int(body[1] * SR) // step):
        if lv[i] < np.median(lv[i - 10:i + 10]) - 18:
            j = i
            while j + 1 < len(lv) and lv[j + 1] < np.median(lv[i - 10:i + 10]) - 12:
                j += 1
            a, b = i * step - fade * 2, (j + 1) * step + fade * 2
            if a - bar > 0:
                patch = x[a - bar:b - bar].copy()
                w = np.ones(b - a)
                w[:fade] = np.linspace(0, 1, fade)
                w[-fade:] = np.linspace(1, 0, fade)
                x[a:b] = x[a:b] * (1 - w[:, None]) + patch * w[:, None]
                fixed.append(round(a / SR, 2))
            i = j + 1
        i += 1
    return x, fixed


# ---------- a composed take, cut to picture ----------

# How each composed take (bed.py compose) is cut to the picture: a music editor's cut list of
# (first bar, bars) segments of the take, bars counted from its first downbeat, in film order. A
# segment may be part of a bar (down to a beat), may repeat, and may skip whole stretches; the last
# one (None) plays to the end. The film wants 2 bars of intro, then 9 from the landing to the hover
# (the last a stop-down), 3 of climax, and the ending on the name. `drop` is where the climax starts,
# in bars into the cut: it lands on the agent's hover. `body` is where the groove plays (take
# seconds), for finding the beat.
CUTS = {
    # take 6: 8 bars of intro, the groove from bar 8, 8 bars of it, a 4-bar breakdown whose last two
    # beats rise into the lift on bar 20, 8 bars of climax, the final chord on bar 28. Cut: the
    # intro's last 2 bars, the whole groove, the first beat and rest of the breakdown, its rising
    # last two beats, then 2 bars of climax that skip ahead to the climax's last bar, so the
    # composer's own cadence leads into the final chord on the name.
    # Its final chord dies within a beat, so it rings on through a hall (`ring`: bars into the cut).
    ("cinematic", "6"): {"segments": [(6, 2), (8, 8), (16, 0.5), (19.5, 0.5), (20, 2), (27, None)], "drop": 11, "body": (19, 37), "ring": 14},
    # take 3: 4 bars of intro, the groove on bar 4, 8 bars of body ending in a half-bar stop-down,
    # the drop on bar 12, a long climax, the final slam on bar 21. Bar 10 plays twice (its seam is
    # the most alike on both sides), and the climax cuts from its third bar to the slam.
    ("trailer", "3"): {"segments": [(2, 9), (10, 1), (11, 4), (21, None)], "drop": 11, "body": (9.5, 26.5)},
}


def downbeats(x, bpm_hint, body):
    """A take's tempo and first downbeat: the beat grid the kick and claps follow over its body,
    and of each bar's four beats, the one the kick hits hardest."""
    m = x.mean(1)
    mag, f, fps = frames(m, SR)
    env = beat_envelope(mag, f)
    bpm, _ = tempo(env, fps, bpm_hint)
    period = 60 / bpm
    lo, hi = int(body[0] * fps), int(body[1] * fps)
    phase = (beat_phase(env[lo:hi], fps, bpm) + lo / fps) % period
    kick = onset_env(mag, KICK, f)
    beats = np.arange(phase, len(m) / SR, period)
    hit = lambda t: kick[max(0, int(t * fps) - 2):int(t * fps) + 3].max()
    first = max(range(4), key=lambda o: np.mean([hit(t) for t in beats[o::4] if body[0] < t < body[1]]))
    return bpm, beats[first] % (4 * period)


def conform(x, segments, bpm, downbeat, xf=0.03):
    """Plays out a cut list: each segment copied whole and, where it does not simply continue the
    one before, crossfaded (equal power) into it over the 30 ms before its first beat, so every
    entry keeps the take's own attack. Returns the cut and where its first bar starts in it (a bar
    of the take's lead-in is kept ahead of it)."""
    bar = 240 / bpm
    at = lambda b: int(round((downbeat + b * bar) * SR))  # the take's sample at bar position b
    pre = min(at(segments[0][0]), int(round(bar * SR)))
    pos = lambda p: pre + int(round(p * bar * SR))  # the cut's sample at p bars in
    nx = int(xf * SR)
    w = np.sin(np.linspace(0, np.pi / 2, nx))[:, None]
    out = np.zeros((pos(sum(n or 0 for _, n in segments)) + len(x), 2), np.float32)
    out[:pre] = x[at(segments[0][0]) - pre:at(segments[0][0])]
    p, end, follows = 0.0, pre, segments[0][0]
    for b0, nb in segments:
        s0, o0 = at(b0), pos(p)
        span = len(x) - s0 if nb is None else pos(p + nb) - o0
        if abs(b0 - follows) > 1e-6:  # a seam
            out[o0 - nx:o0] = out[o0 - nx:o0] * w[::-1] + x[s0 - nx:s0] * w
        out[o0:o0 + span] = x[s0:s0 + span]
        end, follows, p = o0 + span, b0 + (nb or 0), p + (nb or 0)
    return out[:end], pre / SR


def place_cut(x, cut, c, bpm_hint):
    """Cuts a composed take to the picture and sets it on the film's clock: conformed at its own
    tempo, stretched so the landing and the hover fall a whole number of beats apart, and slid
    so the drop's downbeat lands on the hover. The cut list puts the groove's first downbeat
    whole bars earlier, on the landing."""
    bpm_src, downbeat = downbeats(x, bpm_hint, cut["body"])
    y, pre = conform(x, cut["segments"], bpm_src, downbeat)
    land, hover = c["open"]["land"], c["agent"]["hover"]
    beats = round((hover - land) * bpm_src / 60)
    bpm = beats * 60 / (hover - land)
    y = time_stretch(y.T.copy(), SR, stretch_factor=bpm / bpm_src).T
    drop = (pre + cut["drop"] * 240 / bpm_src) * bpm_src / bpm
    shift = hover - drop
    n = int(round(abs(shift) * SR))
    y = np.concatenate([np.zeros((n, 2), np.float32), y]) if shift > 0 else y[n:]
    if "ring" in cut:
        y = ring_out(y, hover + (cut["ring"] - cut["drop"]) * 240 / bpm)
    return y.astype(np.float32), shift, hover - beats * 60 / bpm, bpm


def ring_out(x, at, tail=3.5, gain=-3.0):
    """Lets a final chord ring: its first half second through a large hall, wet only, laid in from
    the chord on, the way a music editor extends an ending that stops too soon."""
    i = int(round(at * SR))
    src = np.concatenate([x[i:i + int(0.5 * SR)], np.zeros((int(tail * SR), 2), np.float32)])
    wet = Pedalboard([Reverb(room_size=0.95, damping=0.4, wet_level=1.0, dry_level=0.0, width=1.0)])(src.T, SR).T
    out = np.concatenate([x, np.zeros((max(0, i + len(wet) - len(x)), 2), np.float32)])
    out[i:i + len(wet)] += wet * db(gain)
    return out


# Streamed takes can leave a narrow band of noise (and in one take a 14 kHz tone) above the music; cut it
# with the music's own top end left alone. The composed take came out clean.
CLEAN = {
    "keynote": [LadderFilter(mode=LadderFilter.Mode.LPF24, cutoff_hz=10500, resonance=0.0), LadderFilter(mode=LadderFilter.Mode.LPF24, cutoff_hz=10500, resonance=0.0)],
    "effortless": [LadderFilter(mode=LadderFilter.Mode.LPF24, cutoff_hz=17000, resonance=0.0)],
    "kinetic": [PeakFilter(14076, -36, 12), PeakFilter(14076, -36, 12), PeakFilter(14076, -24, 4), PeakFilter(14800, -24, 1.6), LowpassFilter(15500), LowpassFilter(15500), LowpassFilter(15500)],
    "cinematic": [],
    "trailer": [],
}


# ---------- the effects for each direction ----------

def taps(a, b, chars, every, seed0, quant=None):
    """Key taps across a typed stretch: one per `every` characters, or on a beat grid."""
    if quant:
        start = np.ceil((a - quant["phase"]) / quant["step"]) * quant["step"] + quant["phase"]
        return list(np.arange(start, b, quant["step"]))
    n = max(1, int(chars / every))
    rng = np.random.default_rng(seed0)
    return [a + (b - a) * (i + 0.5) / n + rng.uniform(-0.012, 0.012) for i in range(n)]


def whoosh_on(move, f0, f1, pan0, pan1, gain, peak=0.5, extra=0.25):
    """Air on a camera move: loudest where the eased move is fastest (its middle)."""
    a, b = move
    dur = (b - a) + extra
    return (a - extra * peak, lambda: sfx.whoosh(dur, f0, f1, pan0, pan1, peak_at=peak), gain)


def breeze_on(move, f0, f1, pan0, pan1, gain, peak=0.5, extra=0.25):
    """The same, as a breeze: felt more than heard."""
    a, b = move
    dur = (b - a) + extra
    return (a - extra * peak, lambda: sfx.breeze(dur, f0, f1, pan0, pan1, peak_at=peak), gain)


def events(name, c, grid):
    o, a1, mv, tk, nt, ag, cv, en = c["open"], c["act1"], c["moves"], c["token"], c["note"], c["agent"], c["canvas"], c["end"]
    E = []
    add = E.append
    scrub_steps = c["act1"]["gapTo"] - c["act1"]["gapFrom"]
    tick_times = [a1["scrub"][0] + (a1["scrub"][1] - a1["scrub"][0]) * (i / scrub_steps) for i in range(1, scrub_steps + 1)]
    line_whoosh = (o["linePass"] - 0.84, lambda: sfx.whoosh(1.4, 300, 2600, -0.6, 0.6, peak_at=0.6, width=1.6), 0)
    if name == "keynote":
        # the music leads; only the moments that carry the story get a sound, softly
        add((0.0, lambda: sfx.drone(4.7, 55), -20))
        add((2.6, lambda: sfx.riser(2.0, 250, 4000), -18))
        add(line_whoosh[:2] + (-15,))
        add((o["panelsLand"] - 0.02, lambda: sfx.thud(0.3, 110, 60), -22))
        add((o["barLand"], lambda: sfx.click(0.9, soft=0.6), -26))
        add((o["land"], lambda: sfx.impact(1.25), -9))
        for t in (a1["subClick"], *a1["dbl"], a1["h1Click"]):
            add((t, lambda: sfx.click(soft=0.8), -30))
        add((a1["copyUp"][0], lambda: sfx.whoosh(1.0, 450, 1700, 0, 0.15, peak_at=0.55), -25))
        add((a1["copyDown"][0], lambda: sfx.settle(0.75), -27))
        add((a1["alt"], lambda: sfx.blip(1500), -27))
        add((a1["groupUp"][0], lambda: sfx.whoosh(1.0, 450, 1700, 0, -0.15, peak_at=0.55), -25))
        for i, t in enumerate(tick_times):
            add((t, lambda i=i: sfx.tick(i, scrub_steps), -33))
        add((a1["groupDown"][0], lambda: sfx.settle(0.75), -27))
        add(whoosh_on(mv["orbit"], 500, 2000, -0.5, 0.6, -19))
        add((tk["token"], lambda: sfx.click(soft=0.7), -29))
        add((tk["chip"][0], lambda: sfx.whoosh(0.85, 1400, 3600, 0.5, -0.3, peak_at=0.5, width=0.9), -25))
        add((tk["chip"][1] - 0.01, lambda: sfx.chime((2637.0,), dur=0.9), -21))
        add(whoosh_on(mv["crane"], 2200, 600, 0.2, -0.2, -21))
        add((nt["save"], lambda: sfx.pop(), -27))
        add(whoosh_on(mv["rise"], 600, 2400, -0.2, 0.3, -21))
        add((nt["send"], lambda: sfx.click(soft=0.5), -25))
        add((nt["send"] + 0.06, lambda: sfx.chime((1318.5, 1975.5), gap=0.11, dur=1.0), -21))
        add(whoosh_on(mv["back"], 1800, 700, 0.2, 0, -24))
        add((ag["collapse"], lambda: sfx.whoosh(0.7, 900, 2600, -0.1, -0.9, peak_at=0.45), -24))
        add((ag["collapse"], lambda: sfx.whoosh(0.7, 900, 2600, 0.1, 0.9, peak_at=0.45, seed=31), -24))
        add((ag["hover"] - 1.05, lambda: sfx.riser(1.05, 400, 5000), -19))
        add((ag["pointer"][0] + 0.05, lambda: sfx.presence(), -30))
        add((ag["hover"], lambda: sfx.impact(0.8), -15))
        add((ag["sheen"][0], lambda: sfx.sheen(0.85), -15))
        add((ag["lightStart"], lambda: sfx.sparkle(2.0, period=ag["lightTurn"]), -19))
        add((mv["home"][0] + 0.2, lambda: sfx.whoosh(1.8, 2400, 450, 0, 0, peak_at=0.55, width=1.6), -16))
        add((cv["zoom"][0], lambda: sfx.impact(0.7, 2.0), -17))
        add((en["card"], lambda: sfx.bloom(3.0), -13))
        add((en["sweep"][0], lambda: sfx.sweep(en["sweep"][1] - en["sweep"][0]), -21))
    elif name == "effortless":
        # every interaction gets its own small, dry sound; the air stays light
        add((0.0, lambda: sfx.drone(4.7, 65.4), -23))
        add((2.0, lambda: sfx.riser(2.6, 300, 3200), -19))
        add(line_whoosh[:2] + (-16,))
        add((o["panelsLand"] - 0.02, lambda: sfx.thud(0.25, 120, 70), -21))
        add((o["barLand"], lambda: sfx.click(1.0), -21))
        add((o["land"], lambda: sfx.thud(0.4, 140, 55), -13))
        add((o["land"], lambda: sfx.impact(0.8, 1.2), -17))
        add(whoosh_on(a1["pushIn"], 900, 2200, 0, 0, -30, extra=0.15))
        add((a1["subClick"], lambda: sfx.click(1.0, seed=2), -20))
        add((a1["dbl"][0], lambda: sfx.click(1.0, seed=3), -21))
        add((a1["dbl"][1], lambda: sfx.click(1.02, seed=4), -21))
        add((a1["copyUp"][0], lambda: sfx.whoosh(0.9, 500, 1900, 0, 0.15, peak_at=0.55), -22))
        add((a1["selAll"], lambda: sfx.key(7), -24))
        add((a1["selAll"] + 0.07, lambda: sfx.key(8), -24))
        for i, t in enumerate(taps(*a1["type"], a1["typeChars"], 3, 40)):
            add((t, lambda i=i: sfx.key(100 + i), -27))
        add((a1["enter"], lambda: sfx.key(9, pitch=0.85), -22))
        add((a1["copyDown"][0], lambda: sfx.settle(0.7), -24))
        add(whoosh_on(a1["pullOut"], 2000, 900, 0, 0, -30, extra=0.15))
        add((a1["h1Click"], lambda: sfx.click(1.0, seed=5), -20))
        add((a1["alt"], lambda: sfx.blip(1600), -22))
        add((a1["altUp"], lambda: sfx.blip(1200, dur=0.06, drop=1.05), -29))
        add((a1["parent"], lambda: sfx.key(11), -24))
        add(whoosh_on(a1["toGroup"], 900, 1800, 0, 0.1, -30, extra=0.15))
        add((a1["groupUp"][0], lambda: sfx.whoosh(0.9, 500, 1900, 0, -0.15, peak_at=0.55), -22))
        for i, t in enumerate(tick_times):
            add((t, lambda i=i: sfx.tick(i, scrub_steps), -23))
        add((a1["gapSet"], lambda: sfx.click(1.1, seed=6), -25))
        add((a1["groupDown"][0], lambda: sfx.settle(0.7), -24))
        add(whoosh_on(mv["orbit"], 500, 2200, -0.5, 0.6, -18))
        for t, s in ((tk["ctaClick"], 7), (tk["tokenField"], 8), (tk["token"], 9)):
            add((t, lambda s=s: sfx.click(1.0, seed=s), -20))
        add((tk["chip"][0], lambda: sfx.whoosh(0.85, 1400, 3600, 0.5, -0.3, peak_at=0.5, width=0.9), -21))
        add((tk["chip"][1] - 0.01, lambda: sfx.chime((2637.0,), dur=0.7), -19))
        add(whoosh_on(mv["crane"], 2200, 600, 0.2, -0.2, -20))
        add((nt["notesTool"], lambda: sfx.click(1.0, seed=10), -20))
        add((nt["noteAt"], lambda: sfx.click(1.0, seed=11), -20))
        add((nt["noteAt"] + 0.05, lambda: sfx.pop(), -26))
        for i, t in enumerate(taps(*nt["note"], nt["noteChars"], 2, 50)):
            add((t, lambda i=i: sfx.key(200 + i), -27))
        add((nt["save"], lambda: sfx.pop(), -20))
        add(whoosh_on(mv["rise"], 600, 2400, -0.2, 0.3, -19))
        add((nt["changes"], lambda: sfx.click(1.0, seed=12), -20))
        add((nt["send"], lambda: sfx.click(0.95, seed=13), -18))
        add((nt["send"] + 0.03, lambda: sfx.whoosh(0.6, 800, 3200, 0, 0.4, peak_at=0.4), -21))
        add((nt["send"] + 0.12, lambda: sfx.chime((1318.5, 1975.5), gap=0.1, dur=0.8), -20))
        add(whoosh_on(mv["back"], 1800, 700, 0.2, 0, -22))
        add((ag["collapse"], lambda: sfx.whoosh(0.65, 900, 2600, -0.1, -0.9, peak_at=0.45), -21))
        add((ag["collapse"], lambda: sfx.whoosh(0.65, 900, 2600, 0.1, 0.9, peak_at=0.45, seed=31), -21))
        add((ag["pointer"][0] + 0.05, lambda: sfx.presence(), -25))
        add((ag["hover"] - 0.7, lambda: sfx.riser(0.7, 600, 4500), -23))
        add((ag["sheen"][0], lambda: sfx.sheen(0.85), -14))
        add((ag["lightStart"], lambda: sfx.sparkle(2.0, period=ag["lightTurn"]), -18))
        add((mv["home"][0] + 0.2, lambda: sfx.whoosh(1.7, 2400, 450, 0, 0, peak_at=0.55, width=1.6), -17))
        add((cv["zoom"][0], lambda: sfx.impact(0.6, 1.6), -19))
        add((cv["title"][0], lambda: sfx.tick(6, 12), -29))
        add((en["card"], lambda: sfx.bloom(3.0, root=174.61), -14))
        add((en["sweep"][0], lambda: sfx.sweep(en["sweep"][1] - en["sweep"][0]), -20))
        add((en["button"], lambda: sfx.click(1.1, seed=14), -26))
    elif name in ("cinematic", "trailer"):
        # Effortless's voice for the interface; the camera's air down to a breeze, and only on the
        # big moves; a trailer's devices on the turns: a riser into the landing and a boom on it,
        # the music's stop-down left quiet but for the agent, a reversed swell and a boom on the drop
        add((2.0, lambda: sfx.riser(2.6, 300, 3200), -24))
        add((o["linePass"] - 0.84, lambda: sfx.breeze(1.4, 260, 1300, -0.6, 0.6, peak_at=0.6), -21))
        add((o["panelsLand"] - 0.02, lambda: sfx.thud(0.25, 120, 70), -21))
        add((o["barLand"], lambda: sfx.click(1.0), -21))
        add((o["land"], lambda: sfx.thud(0.4, 140, 55), -15))
        add((o["land"], lambda: sfx.boom(1.6, 54, 38), -19))
        add((a1["subClick"], lambda: sfx.click(1.0, seed=2), -20))
        add((a1["dbl"][0], lambda: sfx.click(1.0, seed=3), -21))
        add((a1["dbl"][1], lambda: sfx.click(1.02, seed=4), -21))
        add((a1["copyUp"][0], lambda: sfx.breeze(0.9, 300, 900, 0, 0.15), -31))
        add((a1["selAll"], lambda: sfx.key(7), -24))
        add((a1["selAll"] + 0.07, lambda: sfx.key(8), -24))
        for i, t in enumerate(taps(*a1["type"], a1["typeChars"], 3, 40)):
            add((t, lambda i=i: sfx.key(100 + i), -27))
        add((a1["enter"], lambda: sfx.key(9, pitch=0.85), -22))
        add((a1["copyDown"][0], lambda: sfx.settle(0.7), -29))
        add((a1["h1Click"], lambda: sfx.click(1.0, seed=5), -20))
        add((a1["alt"], lambda: sfx.blip(1600), -22))
        add((a1["altUp"], lambda: sfx.blip(1200, dur=0.06, drop=1.05), -29))
        add((a1["parent"], lambda: sfx.key(11), -24))
        add((a1["groupUp"][0], lambda: sfx.breeze(0.9, 300, 900, 0, -0.15), -31))
        for i, t in enumerate(tick_times):
            add((t, lambda i=i: sfx.tick(i, scrub_steps), -23))
        add((a1["gapSet"], lambda: sfx.click(1.1, seed=6), -25))
        add((a1["groupDown"][0], lambda: sfx.settle(0.7), -29))
        add(breeze_on(mv["orbit"], 300, 1200, -0.5, 0.6, -22))
        for t, s in ((tk["ctaClick"], 7), (tk["tokenField"], 8), (tk["token"], 9)):
            add((t, lambda s=s: sfx.click(1.0, seed=s), -20))
        add((tk["chip"][0], lambda: sfx.breeze(0.85, 700, 1800, 0.5, -0.3, peak_at=0.5), -27))
        add((tk["chip"][1] - 0.01, lambda: sfx.chime((2637.0,), dur=0.7), -19))
        add(breeze_on(mv["crane"], 1300, 400, 0.2, -0.2, -24))
        add((nt["notesTool"], lambda: sfx.click(1.0, seed=10), -20))
        add((nt["noteAt"], lambda: sfx.click(1.0, seed=11), -20))
        add((nt["noteAt"] + 0.05, lambda: sfx.pop(), -26))
        for i, t in enumerate(taps(*nt["note"], nt["noteChars"], 2, 50)):
            add((t, lambda i=i: sfx.key(200 + i), -27))
        add((nt["save"], lambda: sfx.pop(), -20))
        add(breeze_on(mv["rise"], 400, 1400, -0.2, 0.3, -23))
        add((nt["changes"], lambda: sfx.click(1.0, seed=12), -20))
        add((nt["send"], lambda: sfx.click(0.95, seed=13), -18))
        add((nt["send"] + 0.12, lambda: sfx.chime((1318.5, 1975.5), gap=0.1, dur=0.8), -20))
        add(breeze_on(mv["back"], 1100, 450, 0.2, 0, -26))
        add((ag["pointer"][0] + 0.05, lambda: sfx.presence(), -25))
        add((ag["hover"] - 1.1, lambda: sfx.swell(1.1), -24))
        add((ag["hover"], lambda: sfx.boom(2.2), -18))
        add((ag["sheen"][0], lambda: sfx.sheen(0.85), -14))
        add((ag["lightStart"], lambda: sfx.sparkle(2.0, period=ag["lightTurn"]), -18))
        add((mv["home"][0] + 0.2, lambda: sfx.breeze(1.7, 1400, 350, 0, 0, peak_at=0.55), -24))
        add((cv["zoom"][0], lambda: sfx.impact(0.6, 1.6), -22))
        add((cv["title"][0], lambda: sfx.tick(6, 12), -29))
        add((en["card"], lambda: sfx.bloom(3.0, root=174.61), -17))
        add((en["sweep"][0], lambda: sfx.sweep(en["sweep"][1] - en["sweep"][0]), -20))
        add((en["button"], lambda: sfx.click(1.1, seed=14), -26))
    else:
        # kinetic: punchier, rising into the drops, the typing on the beat
        add((0.0, lambda: sfx.drone(4.7, 55), -24))
        add((1.6, lambda: sfx.riser(3.0, 250, 7000), -13))
        add(line_whoosh[:2] + (-13,))
        add((o["panelsLand"] - 0.02, lambda: sfx.impact(0.55, 0.8), -17))
        add((o["barLand"], lambda: sfx.click(1.0), -19))
        add((o["land"], lambda: sfx.impact(1.4), -7))
        for t, s in ((a1["subClick"], 2), (a1["dbl"][0], 3), (a1["dbl"][1], 4), (a1["h1Click"], 5)):
            add((t, lambda s=s: sfx.click(1.05, seed=s), -20))
        add((a1["copyUp"][0], lambda: sfx.whoosh(0.7, 600, 2400, 0, 0.2, peak_at=0.5), -20))
        for i, t in enumerate(taps(*a1["type"], a1["typeChars"], 3, 40, quant=grid)):
            add((t, lambda i=i: sfx.key(100 + i, pitch=1.1), -24))
        add((a1["copyDown"][0], lambda: sfx.settle(0.6), -22))
        add((a1["alt"], lambda: sfx.blip(1700), -20))
        add((a1["groupUp"][0], lambda: sfx.whoosh(0.7, 600, 2400, 0, -0.2, peak_at=0.5), -20))
        for i, t in enumerate(tick_times):
            add((t, lambda i=i: sfx.tick(i, scrub_steps), -21))
        add((a1["groupDown"][0], lambda: sfx.settle(0.6), -22))
        add(whoosh_on(mv["orbit"], 500, 2600, -0.6, 0.7, -16))
        for t, s in ((tk["ctaClick"], 7), (tk["tokenField"], 8), (tk["token"], 9)):
            add((t, lambda s=s: sfx.click(1.05, seed=s), -20))
        add((tk["chip"][0], lambda: sfx.whoosh(0.85, 1400, 4200, 0.6, -0.4, peak_at=0.5, width=0.9), -18))
        add((tk["chip"][1] - 0.01, lambda: sfx.chime((2637.0,), dur=0.6), -16))
        add((tk["chip"][1] + 0.07, lambda: sfx.tick(9, 12), -22))
        add((tk["chip"][1] + 0.14, lambda: sfx.tick(11, 12), -24))
        add(whoosh_on(mv["crane"], 2600, 600, 0.2, -0.2, -18))
        add((nt["noteAt"], lambda: sfx.click(1.05, seed=11), -20))
        for i, t in enumerate(taps(*nt["note"], nt["noteChars"], 2, 50, quant=grid)):
            add((t, lambda i=i: sfx.key(200 + i, pitch=1.1), -24))
        add((nt["save"], lambda: sfx.pop(), -19))
        add(whoosh_on(mv["rise"], 600, 2800, -0.2, 0.3, -17))
        add((nt["send"], lambda: sfx.click(1.0, seed=13), -17))
        add((nt["send"] + 0.05, lambda: sfx.whoosh(0.7, 900, 4000, 0, 0.5, peak_at=0.35), -18))
        add(whoosh_on(mv["back"], 2000, 600, 0.2, 0, -19))
        add((ag["collapse"], lambda: sfx.whoosh(0.6, 900, 3000, -0.1, -0.95, peak_at=0.4), -19))
        add((ag["collapse"], lambda: sfx.whoosh(0.6, 900, 3000, 0.1, 0.95, peak_at=0.4, seed=31), -19))
        add((ag["hover"] - 1.5, lambda: sfx.riser(1.5, 300, 8000), -14))
        add((ag["pointer"][0] + 0.05, lambda: sfx.presence(), -24))
        add((ag["hover"], lambda: sfx.impact(1.2), -8))
        add((ag["sheen"][0], lambda: sfx.sheen(0.85), -13))
        add((ag["lightStart"], lambda: sfx.sparkle(2.0, period=ag["lightTurn"], rate=18), -17))
        add((mv["home"][0] + 0.2, lambda: sfx.whoosh(1.6, 2800, 450, 0, 0, peak_at=0.55, width=1.6), -15))
        add((cv["zoom"][0], lambda: sfx.impact(0.9, 1.6), -12))
        add((en["card"], lambda: sfx.impact(0.7, 1.4), -15))
        add((en["card"], lambda: sfx.bloom(3.0, root=130.81), -14))
        add((en["sweep"][0], lambda: sfx.sweep(en["sweep"][1] - en["sweep"][0]), -18))
    return E


def kind_of(make):
    """Which sfx function an event plays (its lambda names it)."""
    return next((n for n in make.__code__.co_names if n in dir(sfx) and callable(getattr(sfx, n))), "?")


# Level trims by kind, from measuring each effect against the bed where it plays (audibility.py):
# the camera's air and the layers' settle were masked; the light (shimmer, sheen, chimes, the
# name's sweep) stood far out in its band, where the music is quiet; so did the measuring blip
# and Kinetic's hits.
TRIM = {
    "keynote": {"whoosh": 8, "settle": 9, "sparkle": -4, "sheen": -6, "sweep": -4, "blip": -6, "bloom": -3, "tick": 4},
    "effortless": {"whoosh": 6, "settle": 5, "sparkle": -1, "sheen": -3, "chime": -9, "sweep": -8, "blip": -8},
    "kinetic": {"whoosh": 3, "settle": 4, "sparkle": -7, "sheen": -4, "chime": -14, "sweep": -15, "blip": -12, "impact": -4, "bloom": -6, "presence": -4},
    # set so each kind sits where it did in Effortless against the fuller score, except the air:
    # the breeze and the settle stay about 10 dB under the music, felt more than heard
    "trailer": {"sparkle": 4, "chime": 2, "sweep": -1, "blip": -3, "click": 6, "pop": 5, "thud": -2, "key": 6, "presence": -6,
                "bloom": 5, "impact": 3, "tick": 1, "breeze": 4, "settle": 4},
}
# the same aim on Cinematic's take 6, measured with its final chord rung out (CUTS)
TRIM["cinematic"] = {"sheen": 3, "sparkle": 3, "chime": 2, "sweep": -5, "blip": -1, "click": 4, "pop": 3, "key": 8, "presence": -6,
                     "bloom": 5, "impact": 5, "tick": 2, "riser": 4, "breeze": 1, "settle": 2}


def trimmed(name, evs):
    return [(at, make, gain + TRIM[name].get(kind_of(make), 0)) for at, make, gain in evs]


# ---------- the music's shape over the film ----------

TARGETS = {  # each section's level, dB below the payoff; None leaves the section as the music has it
    "keynote": {"dark": -10, "fly": -6, "craft": -4, "tools": -3, "breath": -8, "payoff": 0, "wide": -1, "resolve": -5},
    "effortless": {"dark": -10, "fly": -6, "craft": -3, "tools": -2.5, "breath": -8, "payoff": 0, "wide": -0.5, "resolve": -5},
    "kinetic": {"dark": -11, "fly": -6, "craft": -2, "tools": -1.5, "breath": -9, "payoff": 0, "wide": -2, "resolve": -6},
    # a trailer's dynamics: the build under the drop, the climax held; the stop-down and the final
    # hit are the composer's
    "cinematic": {"dark": -10, "fly": -8, "craft": -5, "tools": -3, "breath": None, "payoff": 0, "wide": -1, "resolve": None},
    "trailer": {"dark": -10, "fly": -8, "craft": -5, "tools": -3, "breath": None, "payoff": 0, "wide": -1, "resolve": None},
}

# A composed take brings its own held breath before the drop, and the cut enters its intro already
# under way: the mix adds no dip before the hover, fades in faster, opens the filter from higher
# up, and may lift a quiet section further.
SHAPE = {k: {"breath": False, "closed": 1800, "lift": 10, "open": [(0, -24), (0.4, -8), (1.2, -2)]} for k in ("cinematic", "trailer")}


def shape_bed(x, c, name):
    n = len(x)
    t = np.arange(n) / SR
    plan = sections(c) + [("end", c["duration"])]
    # measured section levels, so the shaping corrects what the take did rather than adding to it
    lv = {}
    for (sec, a), (_, b) in zip(plan[:-1], plan[1:]):
        seg = x[int(a * SR):int(b * SR)]
        lv[sec] = 20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-9)
    ref = lv["payoff"]
    tg = TARGETS[name]
    sh = SHAPE.get(name, {})
    gains = []
    for sec, a in plan[:-1]:
        gains.append((a, gains[-1][1] if tg[sec] is None else float(np.clip(tg[sec] - (lv[sec] - ref), -9, sh.get("lift", 5)))))
    g = smooth_steps(t, gains, fade=0.5)
    ag, en = c["agent"], c["end"]
    # the held breath before the hover, and the way out
    if sh.get("breath", True):
        g += ramp(t, [(0, 0), (ag["hover"] - 0.75, 0), (ag["hover"] - 0.25, -7), (ag["hover"] - 0.01, -7), (ag["hover"], 0), (99, 0)])
    g += ramp(t, [(0, 0), (en["fadeOut"][0] - 0.6, 0), (c["duration"], -40), (99, -40)])
    g += ramp(t, sh.get("open", [(0, -30), (0.5, -12), (c["open"]["flyStart"], -4)]) + [(c["open"]["land"], 0), (99, 0)])
    x = x * db(g)[:, None]
    # the filter: closed in the dark, open on the landing; closed for the breath; closing at the end
    land, closed = c["open"]["land"], sh.get("closed", 300)
    keys = [(0, closed), (c["open"]["flyStart"], max(900, closed * 1.6)), (land - 0.6, 4500), (land - 0.02, 9000), (land, 20000)]
    if sh.get("breath", True):
        keys += [(ag["hover"] - 0.8, 20000), (ag["hover"] - 0.2, 800), (ag["hover"] - 0.01, 800), (ag["hover"], 20000)]
    keys += [(en["fadeOut"][0] - 0.4, 20000), (c["duration"], 2500), (99, 2500)]
    return lowpass_auto(x.astype(np.float32), ramp(t, keys))


PAYOFF_LEVEL = -19.0  # dBFS RMS of the bed's payoff before the effects: where Effortless's sits at a -6 dBFS peak


def duck(x, times, depth=-3.0, width=0.35):
    """Lowers the bed a little under the biggest effects so they read without being loud."""
    t = np.arange(len(x)) / SR
    g = np.zeros(len(x))
    for a in times:
        g = np.minimum(g, np.where((t >= a - 0.05) & (t < a + width), depth * np.sin(np.pi * np.clip((t - a + 0.05) / (width + 0.05), 0, 1)), 0))
    return (x * db(g)[:, None]).astype(np.float32)


def render_sfx(evs, n):
    out = np.zeros((n, 2), np.float32)
    for at, make, gain in evs:
        s = make() * db(gain)
        i = int(round(at * SR))
        if i < 0:
            s, i = s[-i:], 0
        j = min(n, i + len(s))
        if j > i:
            out[i:j] += s[:j - i]
    return out


def loudness(src, target=-16.0, tp=-2.5):
    """ffmpeg's loudnorm measurement pass: integrated loudness, true peak and the rest."""
    first = subprocess.run([FFMPEG, "-hide_banner", "-i", str(src), "-af", f"loudnorm=I={target}:TP={tp}:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
    return json.loads(first[first.rindex("{"):first.rindex("}") + 1])


def loudnorm(src, dst, target=-16.0, tp=-2.5):
    """Two-pass EBU R128 normalisation with ffmpeg, as one linear gain (master() leaves the
    headroom for it; otherwise loudnorm falls back to riding the gain, which flattens the story)."""
    m = loudness(src, target, tp)
    af = (f"loudnorm=I={target}:TP={tp}:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:"
          f"measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true:print_format=json")
    second = subprocess.run([FFMPEG, "-hide_banner", "-y", "-i", str(src), "-af", af, "-ar", str(SR), "-c:a", "pcm_s24le", str(dst)], capture_output=True, text=True).stderr
    out = json.loads(second[second.rindex("{"):second.rindex("}") + 1])
    return {"in_lufs": m["input_i"], "out_lufs": out["output_i"], "out_tp": out["output_tp"], "normalization": out["normalization_type"]}


def master(mix, pre, target=-16.0, tp=-2.5):
    """Bus compression and a limiter, driven until the peaks sit within reach of the loudness
    target (true peak minus loudness under 13 dB), so loudnorm can stay a single linear gain."""
    drive = 0.0
    for _ in range(5):
        out = Pedalboard([Compressor(threshold_db=-20, ratio=2.0, attack_ms=12, release_ms=160), Gain(drive), Limiter(threshold_db=-2.0, release_ms=120)])(mix.T, SR).T
        wavfile.write(pre, SR, out.astype(np.float32))
        m = loudness(pre, target, tp)
        excess = float(m["input_tp"]) - float(m["input_i"]) - (tp - target - 0.5)
        if excess <= 0:
            break
        drive += excess + 0.2
    return drive


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cut")
    ap.add_argument("option", choices=list(OPTIONS))
    ap.add_argument("--take", required=True)
    ap.add_argument("--video")
    a = ap.parse_args()
    c = json.loads((HOME / a.cut / "cues.json").read_text())
    folder = HOME / a.cut / a.option
    bpm = OPTIONS[a.option]["bpm"]
    n = int(c["duration"] * SR)
    composed = OPTIONS[a.option].get("model") == "composed"
    if composed:
        bed, shift, phase, bpm = place_cut(load_bed(a.cut, a.option, a.take), CUTS[(a.option, a.take)], c, bpm)
    else:
        measured = {m["take"]: m for m in json.loads((folder / "measure.json").read_text())}[a.take]
        bed, shift, phase, bpm = place_bed(load_bed(a.cut, a.option, a.take), measured, bpm, c["open"]["land"], c["agent"]["hover"], drums=a.option != "keynote")
    bed = np.concatenate([bed, np.zeros((max(0, n - len(bed)), 2), np.float32)])[:n]
    # a composed take's stop-down is meant; only a streamed take's dropouts get patched
    bed, repaired = (bed, []) if composed else repair(bed, bpm)
    bed = Pedalboard([HighpassFilter(32), *CLEAN[a.option], HighShelfFilter(5000, 1.0, 0.7)])(bed.T, SR).T.astype(np.float32)
    bed = shape_bed(bed, c, a.option)
    grid = {"phase": phase % (60 / bpm / 4), "step": 60 / bpm / 4}
    evs = sorted(trimmed(a.option, events(a.option, c, grid)), key=lambda e: e[0])
    fx = render_sfx(evs, n)
    big = [e[0] for e in evs if e[2] >= -16]
    bed = duck(bed, big)
    if composed:
        # a composed take's hits peak far above its body, so it is set by loudness instead: its
        # payoff where the streamed beds' payoffs sit, the level the effects were balanced against
        h = c["agent"]["hover"]
        bed *= db(PAYOFF_LEVEL - 20 * np.log10(np.sqrt((bed[int(h * SR):int(c["canvas"]["shrink"][0] * SR)] ** 2).mean()) + 1e-9))
    else:
        bed *= db(-6) / max(np.abs(bed).max(), 1e-9)  # the bed peaks at -6 dBFS before the effects and the master
    pre = folder / "premaster.wav"
    drive = master(bed + fx, pre)
    wavfile.write(folder / "sfx.wav", SR, (fx / max(1e-9, np.abs(fx).max()) * 0.9).astype(np.float32))
    wavfile.write(folder / "bed.wav", SR, bed.astype(np.float32))
    (folder / "events.json").write_text(json.dumps([[round(e[0], 4), e[2], kind_of(e[1])] for e in evs]) + "\n")
    stats = loudnorm(pre, folder / "mix.wav")
    beat_hover = (c["agent"]["hover"] - phase) / (60 / bpm)
    report = {"option": a.option, "take": a.take, "bpm": round(bpm, 3), "bed_shift_s": round(shift, 3), "beat_at_landing": round(phase, 3),
              "hover_in_beats_from_grid": round(beat_hover - round(beat_hover), 3), "repaired_dropouts_at": repaired, "effects": len(evs), "limiter_drive_db": round(drive, 1), **stats}
    (folder / "mix.json").write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report))
    if a.video:
        out = Path(a.video).with_name(Path(a.video).stem + f"-{a.option}.mp4")
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", a.video, "-i", str(folder / "mix.wav"), "-map", "0:v", "-map", "1:a",
                        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", str(SR), "-shortest", "-movflags", "+faststart", str(out)], check=True)
        print(out)


if __name__ == "__main__":
    main()
