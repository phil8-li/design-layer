#!/usr/bin/env python3
"""Draws a mix as a spectrogram with the cut's cues marked on it, so the review page can
show where each sound sits against the picture (and so the sound can be read without
being heard).

  python3 landing/film/promo/sound/picture.py t keynote out.png
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.io import wavfile
sys.path.insert(0, str(Path(__file__).parent))
from bed import HOME

cut, name, out = sys.argv[1], sys.argv[2], sys.argv[3]
c = json.loads((HOME / cut / "cues.json").read_text())
sr, x = wavfile.read(HOME / cut / name / "mix.wav")
x = x.astype(np.float32) / (2 ** 31 if x.dtype == np.int32 else 1)
m = x.mean(1)
W, H, top = 1800, 300, 40
n, hop = 2048, int(len(m) / W)
fr = np.lib.stride_tricks.sliding_window_view(m, n)[::hop][:W] * np.hanning(n)
mag = 20 * np.log10(np.abs(np.fft.rfft(fr, axis=1)) + 1e-6)
f = np.fft.rfftfreq(n, 1 / sr)
rows = np.geomspace(40, 16000, H)[::-1]
idx = np.searchsorted(f, rows)
img = mag[:, idx].T
img = np.clip((img - (img.max() - 80)) / 80, 0, 1)
rgb = np.stack([img ** 1.6 * 255, img ** 1.1 * 200 + 20 * img, img ** 0.7 * 255 * 0.9], -1).astype(np.uint8)
canvas = Image.new("RGB", (W, H + top + 26), (8, 8, 10))
canvas.paste(Image.fromarray(rgb), (0, top))
d = ImageDraw.Draw(canvas)
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 15)
except OSError:
    font = ImageFont.load_default()
marks = [("lights", 0.65), ("through the line", c["open"]["linePass"]), ("lands", c["open"]["land"]), ("copy", c["act1"]["copyUp"][0]), ("gap", c["act1"]["scrub"][0]),
         ("orbit", c["moves"]["orbit"][0]), ("token", c["token"]["chip"][1]), ("crane", c["moves"]["crane"][0]), ("send", c["note"]["send"]), ("aside", c["agent"]["collapse"]),
         ("hover", c["agent"]["hover"]), ("every page", c["canvas"]["shrink"][0]), ("name", c["end"]["card"])]
for i, (label, t) in enumerate(marks):
    xpix = int(t / c["duration"] * W)
    d.line([(xpix, top - 6), (xpix, top + H)], fill=(255, 255, 255, 90), width=1)
    d.text((xpix + 3, 4 + (i % 2) * 17), label, fill=(230, 230, 235), font=font)
for s in range(0, int(c["duration"]) + 1, 5):
    xpix = int(s / c["duration"] * W)
    d.text((xpix + 2, H + top + 5), f"{s}s", fill=(140, 140, 150), font=font)
canvas.save(out)
print(out)
