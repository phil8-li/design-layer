#!/usr/bin/env python3
"""Measures music beds against the story, since the sound has to be judged by numbers
as well as by ear: per section of the cut, loudness, brightness (spectral centroid),
how busy it is (onsets per second) and how much percussion it carries (energy above
5 kHz in transients); the tempo the bed actually keeps; and how well its energy follows
the plan (correlation of section loudness with the density each section asked for).

  python3 landing/film/promo/sound/measure.py t keynote        → every take of that option, best first
  python3 landing/film/promo/sound/measure.py t cinematic 6 --bars 19 37
      → a composed take's tempo, first downbeat and loudness beat by beat, one row per bar
        (the groove's body given in take seconds): what its cut list (mix.py CUTS) is read from
"""

import json
import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile

sys.path.insert(0, str(Path(__file__).parent))
from bed import HOME, OPTIONS, sections  # noqa: E402


def load(p):
    sr, x = wavfile.read(p)
    x = x.astype(np.float32) / 32768.0
    return sr, x.mean(1) if x.ndim == 2 else x


def frames(x, sr, n=2048, hop=256):
    f = np.lib.stride_tricks.sliding_window_view(x, n)[::hop] * np.hanning(n)
    mag = np.abs(np.fft.rfft(f, axis=1))
    return mag, np.fft.rfftfreq(n, 1 / sr), sr / hop


def onset_env(mag, band=None, freqs=None):
    """Spectral flux; with band=(lo, hi) Hz, only there (the kick's band finds the downbeats,
    where the full band can lock onto the hi-hats between them)."""
    if band is not None:
        mag = mag[:, (freqs >= band[0]) & (freqs < band[1])]
    flux = np.maximum(0, np.diff(np.log1p(mag * 10), axis=0)).sum(1)
    return np.concatenate([[0], flux])


KICK = (40, 100)  # the kick alone: from 100 Hz up, an off-beat bass line can pull the grid half a beat off


def grid_score(env, fps, bpm, off):
    """Mean onset strength on a beat grid (interpolated between envelope frames)."""
    t = np.arange(off, len(env) / fps - 0.01, 60 / bpm) * fps
    i = np.floor(t).astype(int); f = t - i
    return float((env[i] * (1 - f) + env[np.minimum(i + 1, len(env) - 1)] * f).mean())


def beat_envelope(mag, freqs):
    """Where a drum bed's beats are: the kick and the claps together, each normalised."""
    k, c = onset_env(mag, KICK, freqs), onset_env(mag, (1500, 4000), freqs)
    return k / (k.mean() + 1e-9) + c / (c.mean() + 1e-9)


def tempo(env, fps, bpm):
    """The tempo the bed keeps, to a twentieth of a BPM: the beat grid near the asked tempo that the
    onsets follow best; its strength is how much better than the envelope's average that grid scores."""
    best = (bpm, -1.0)
    for b in np.arange(bpm * 0.97, bpm * 1.03, 0.05):
        period = 60 / b
        s = max(grid_score(env, fps, b, off) for off in np.arange(0, period, 0.01))
        if s > best[1]:
            best = (float(b), s)
    return best[0], best[1] / (env.mean() + 1e-9) - 1


def beat_phase(env, fps, bpm):
    """Where the beats fall: the offset (s) of the strongest beat grid at the given tempo."""
    return max((grid_score(env, fps, bpm, off), off) for off in np.arange(0, 60 / bpm, 0.002))[1]


def measure(cut, name, take):
    p = HOME / cut / name / f"bed-{take}.wav"
    sr, x = load(p)
    cues = json.loads((HOME / cut / "cues.json").read_text())
    opt = OPTIONS[name]
    mag, freqs, fps = frames(x, sr)
    env = onset_env(mag)
    hi = mag[:, freqs > 5000].sum(1)
    plan = sections(cues) + [("end", cues["duration"])]
    rows = []
    for (sec, a), (_, b) in zip(plan[:-1], plan[1:]):
        i0, i1 = int(a * fps), max(int(a * fps) + 2, int(b * fps))
        seg = x[int(a * sr):int(b * sr)]
        rms = 20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-9)
        cent = float((mag[i0:i1] * freqs).sum() / (mag[i0:i1].sum() + 1e-9))
        e = env[i0:i1]
        peaks = ((e[1:-1] > e[:-2]) & (e[1:-1] > e[2:]) & (e[1:-1] > np.median(env) * 2.5)).sum()
        rows.append({"section": sec, "from": a, "rms": round(float(rms), 1), "centroid": round(cent), "onsets_per_s": round(peaks / max(0.1, b - a), 1),
                     "perc": round(float(np.log10(hi[i0:i1].mean() + 1e-9)), 2), "asked_density": opt["sections"][sec][1]})
    asked = np.array([r["asked_density"] for r in rows])
    loud = np.array([r["rms"] for r in rows])
    fit = float(np.corrcoef(asked, loud)[0, 1])
    bpm_kept, strength = tempo(env, fps, opt["bpm"])
    # beats are found on the kick where the bed has drums, so the grid is on the beat, not between
    beat_env = beat_envelope(mag, freqs) if name != "keynote" else env
    peak = 20 * np.log10(np.abs(x).max() + 1e-9)
    quiet = min(r["rms"] for r in rows[1:-1])
    return {"take": take, "fit": round(fit, 2), "bpm_kept": round(bpm_kept, 1), "beat_strength": round(float(strength), 2), "peak": round(float(peak), 1),
            "quietest_mid_section": quiet, "phase": round(beat_phase(beat_env, fps, bpm_kept), 3), "rows": rows}


def score(m):
    """Prefer beds whose energy follows the story, that keep their tempo, and that never drop out."""
    return m["fit"] * 2 + min(1.0, m["beat_strength"]) - (2 if m["quietest_mid_section"] < -45 else 0)


def bars(cut, name, take, body):
    """A composed take laid out in bars: the beat grid the kick and claps follow over its body,
    the downbeat the kick hits hardest, and each beat's loudness, so its sections can be read."""
    sr, x = load(HOME / cut / name / f"bed-{take}.wav")
    mag, freqs, fps = frames(x, sr)
    env = beat_envelope(mag, freqs)
    bpm, strength = tempo(env, fps, OPTIONS[name]["bpm"])
    period = 60 / bpm
    lo, hi = int(body[0] * fps), int(body[1] * fps)
    phase = (beat_phase(env[lo:hi], fps, bpm) + lo / fps) % period
    kick = onset_env(mag, KICK, freqs)
    beats = np.arange(phase, len(x) / sr, period)
    hit = lambda t: kick[max(0, int(t * fps) - 2):int(t * fps) + 3].max()
    first = max(range(4), key=lambda o: np.mean([hit(t) for t in beats[o::4] if body[0] < t < body[1]]))
    beats = beats[first:]
    print(f"{name} take {take}: {bpm:.2f} BPM (strength {strength:.2f}), first downbeat {beats[0]:.3f}s, bar {4 * period:.3f}s")
    rms = lambda a, b: 20 * np.log10(np.sqrt((x[int(a * sr):int(b * sr)] ** 2).mean()) + 1e-9)
    for k in range(0, len(beats) - 1, 4):
        print(f"   bar {k // 4:2d} @ {beats[k]:6.2f}s  " + " ".join(f"{rms(beats[j], beats[j + 1]):6.1f}" for j in range(k, min(k + 4, len(beats) - 1))))


if __name__ == "__main__":
    if "--bars" in sys.argv:
        i = sys.argv.index("--bars")
        bars(sys.argv[1], sys.argv[2], sys.argv[3], (float(sys.argv[i + 1]), float(sys.argv[i + 2])))
        sys.exit()
    cut, name = sys.argv[1], sys.argv[2]
    takes = sorted(p.stem.split("-")[1] for p in (HOME / cut / name).glob("bed-*.wav"))
    results = sorted((measure(cut, name, t) for t in takes), key=score, reverse=True)
    for m in results:
        print(f"{name} take {m['take']}: story fit {m['fit']:+.2f}  tempo {m['bpm_kept']} (asked {OPTIONS[name]['bpm']}, strength {m['beat_strength']})  peak {m['peak']} dB  phase {m['phase']}s")
        for r in m["rows"]:
            print(f"   {r['section']:8} @{r['from']:5.2f}s  {r['rms']:6.1f} dB  centroid {r['centroid']:5d} Hz  {r['onsets_per_s']:4.1f} onsets/s  perc {r['perc']:5.2f}  (asked density {r['asked_density']})")
    (HOME / cut / name / "measure.json").write_text(json.dumps(results, indent=1) + "\n")
