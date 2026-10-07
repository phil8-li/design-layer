#!/usr/bin/env python3
"""How each kind of effect sits against the music where it plays: the effect's level in its
own band (2-8 kHz for the interface's small sounds, full band otherwise) over the bed's level
in that band, at the effect's loudest 10 ms (or 50 ms for long sounds). Above 0 dB an effect
reads clearly; a few dB below it is felt more than heard; far below, it is masked.

  python3 landing/film/promo/sound/audibility.py t keynote
"""
import json, sys
from pathlib import Path
import numpy as np
from scipy.io import wavfile
from pedalboard import Pedalboard, HighpassFilter, LowpassFilter
sys.path.insert(0, str(Path(__file__).parent))
from mix import events, trimmed, db, SR
from bed import HOME
import sfx

SMALL = {"click", "key", "tick", "blip", "pop", "presence"}
HIGH = {"sparkle", "sheen", "chime", "sweep"}  # light: measured where it lives, 3-10 kHz

def band(x, lo, hi):
    return Pedalboard([HighpassFilter(lo), LowpassFilter(hi)])(x.T.astype(np.float32), SR).T

def report(cut, name):
    c = json.loads((HOME / cut / "cues.json").read_text())
    _, bed = wavfile.read(HOME / cut / name / "bed.wav")  # the bed at its level in the mix, before the master
    bed = bed.astype(np.float32)
    rep = json.loads((HOME / cut / name / "mix.json").read_text())
    grid = {"phase": rep["beat_at_landing"] % (60 / rep["bpm"] / 4), "step": 60 / rep["bpm"] / 4}
    bed_hi = band(bed, 2000, 8000)
    bed_air = band(bed, 3000, 10000)
    out = {}
    for at, make, gain in trimmed(name, events(name, c, grid)):
        kind = next((n for n in make.__code__.co_names if n in dir(sfx) and callable(getattr(sfx, n))), "?")
        s = make() * db(gain)
        small = kind in SMALL
        win = int((0.01 if small else 0.05) * SR)
        src, ref = (band(s, 2000, 8000), bed_hi) if small else (band(s, 3000, 10000), bed_air) if kind in HIGH else (s, bed)
        e = np.array([np.sqrt((src[k:k + win] ** 2).mean()) for k in range(0, max(1, len(src) - win), win // 2)])
        k = int(np.argmax(e)) * (win // 2)
        i = int(at * SR) + k
        r = np.sqrt((ref[i:i + win] ** 2).mean()) + 1e-9
        out.setdefault(kind, []).append(20 * np.log10(e.max() / r))
    return out

if __name__ == "__main__":
    cut, name = sys.argv[1], sys.argv[2]
    out = report(cut, name)
    print(name + ": " + "  ".join(f"{k} {np.median(v):+.0f}" for k, v in sorted(out.items(), key=lambda kv: -np.median(kv[1]))))
