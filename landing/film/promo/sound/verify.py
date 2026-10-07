#!/usr/bin/env python3
"""Checks a mix against the picture, by measurement (the sound has to be checked by ear
too; this catches what an ear can miss and what nobody can hear without listening):
  - every effect starts on its cue (onsets in sfx.wav against events.json),
  - the bed's beats fall on the landing and the hover (beat grid of bed.wav),
  - the muxed film's audio is the mix, not shifted (cross-correlation),
  - the loudness follows the story, section by section, and nothing clips.

  python3 landing/film/promo/sound/verify.py t keynote
"""
import json, subprocess, sys
from pathlib import Path
import numpy as np
from scipy.io import wavfile
sys.path.insert(0, str(Path(__file__).parent))
from bed import HOME, sections
from measure import frames, onset_env, beat_phase, beat_envelope
from mix import FFMPEG, SR

def mono(p):
    sr, x = wavfile.read(p)
    x = x.astype(np.float32) / (2 ** 31 if x.dtype == np.int32 else 32768.0 if x.dtype == np.int16 else 1.0)
    return x.mean(1) if x.ndim == 2 else x

cut, name = sys.argv[1], sys.argv[2]
folder = HOME / cut / name
c = json.loads((HOME / cut / "cues.json").read_text())
rep = json.loads((folder / "mix.json").read_text())
# 1. effects on their cues: each event's onset, found near its time in the effects stem
fx = np.abs(mono(folder / "sfx.wav"))
evs = json.loads((folder / "events.json").read_text())
SHARP = {"click", "key", "tick", "impact", "thud", "chime", "pop", "blip", "presence", "bloom"}
errs = []
for j, (at, gain, kind) in enumerate(evs):
    if at < 0.05 or kind not in SHARP:
        continue
    # a sharp sound starts where the stem first jumps above a fifth of its level just after the cue;
    # skip those another effect is already sounding into
    if any(0 < at - e[0] < 0.25 for e in evs[:j]) or any(0 < e[0] - at < 0.03 for e in evs[j + 1:]):
        continue
    w = fx[int((at - 0.02) * SR):int((at + 0.04) * SR)]
    base = np.percentile(fx[int((at - 0.04) * SR):int((at - 0.003) * SR)], 95)
    if w.max() < base * 2:  # under something louder: no clean onset to measure
        continue
    k = int(np.argmax(w > base + 0.3 * (w.max() - base)))
    errs.append((k / SR - 0.02) * 1000)
errs = np.array(errs)
# 2. the beat grid of the shaped bed
bed = mono(folder / "bed.wav")[int(4.6 * SR):int(29.0 * SR)]  # the body, where the beat plays
m2, f2, fps2 = frames(bed, SR)
e2 = beat_envelope(m2, f2) if name != "keynote" else onset_env(m2)
period = 60 / rep["bpm"]
ph = (beat_phase(e2, fps2, rep["bpm"]) + 4.6) % period
off = lambda t: ((t - ph + period / 2) % period - period / 2) * 1000
# 3. the film's audio against the mix
FILM = Path("/tmp/designlayer-film/promo") / f"cut-{cut}-{name}.mp4"
raw = subprocess.run([FFMPEG, "-loglevel", "error", "-i", str(FILM), "-vn", "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True).stdout
film2 = np.frombuffer(raw, np.float32).reshape(-1, 2)
film = film2.mean(1)
mix = mono(folder / "mix.wav")
seg = slice(int(4 * SR), int(12 * SR))
a, b = mix[seg], film[seg]
xc = np.fft.irfft(np.fft.rfft(a, 2 * len(a)) * np.conj(np.fft.rfft(b, 2 * len(b))))
lag = int(np.argmax(np.abs(xc)))
lag = lag if lag < len(a) else lag - 2 * len(a)
# 4. loudness by section
plan = sections(c) + [("end", c["duration"])]
lv = []
for (sec, s0), (_, s1) in zip(plan[:-1], plan[1:]):
    x = mix[int(s0 * SR):int(s1 * SR)]
    lv.append(f"{sec} {20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9):.0f}")
print(f"{name}: {len(errs)} sharp effects, onset vs cue: median {np.median(np.abs(errs)):.1f} ms, worst {np.abs(errs).max():.1f} ms")
print(f"   bed beats: landing {off(c['open']['land']):+.0f} ms, hover {off(c['agent']['hover']):+.0f} ms from a beat ({rep['bpm']} BPM)")
print(f"   film audio vs mix: {lag / SR * 1000:+.1f} ms; duration {len(film) / SR:.2f}s; peak {20 * np.log10(np.abs(film2).max() + 1e-9):.1f} dBFS; {rep['out_lufs']} LUFS")
print("   loudness by section (dB):", "  ".join(lv))
