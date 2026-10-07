#!/usr/bin/env python3
"""Generates a music bed for a cut, steered section by section
against the cut's cues (cues.mjs), so the music's energy follows the story.

  MUSIC_API_KEY=... python3 landing/film/promo/sound/bed.py t keynote --take 1
  → ~/.cache/designlayer-site/sound/t/keynote/bed-1.wav (48 kHz stereo) and bed-1.json (what was sent, when)

Each direction sits in one of the tempo bands from the Apple breakdown: 60-80 BPM
regal and cinematic, 90-110 smooth and effortless, 115-123 kinetic and sophisticated.
The tempo is chosen so the editor's landing and the agent's hover fall a whole
number of beats apart, so both can sit on a beat. Generation is not deterministic:
make a few takes and keep the one the analysis prefers (measure.py).

Cinematic and Trailer are composed whole instead of streamed: a
trailer-shaped brief whose acts fall on whole bars, timed from the same cues
(composed_prompt). mix.py then cuts the take to picture on its bar lines.
"""

import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import wave


SR = 48000
HOME = Path.home() / ".cache/designlayer-site/sound"
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")

# Sections of the One-move cut, by cue: what each part of the story asks of the music.
def sections(c):
    a = c["agent"]
    return [
        ("dark", 0.0),                      # the hero line lights in the dark
        ("fly", c["open"]["flyStart"]),     # the camera flies through it; the layers land
        ("craft", c["open"]["land"]),       # the editor: direct manipulation, act one
        ("tools", c["moves"]["orbit"][0]),  # through the tools: token, note, send
        ("breath", c["moves"]["back"][0]),  # back to the page; the editor steps aside; the agent comes
        ("payoff", a["hover"]),             # the agent's hover: the release
        ("wide", c["canvas"]["shrink"][0]), # every page: the climb
        ("resolve", c["end"]["card"]),      # the name
    ]

OPTIONS = {
    # 60-80 BPM: regal, cinematic. 74 BPM puts the landing and the hover 26 beats apart.
    "keynote": {
        "bpm": 74,
        "scale": "D_MAJOR_B_MINOR",
        "base": "cinematic ambient score, felt piano, warm analog synth pads, soft strings, elegant, spacious, premium keynote film",
        "sections": {
            "dark": ("dark ambient drone, a few sparse felt piano notes, very quiet", 0.12, 0.2, True),
            "fly": ("rising pad swell, anticipation, shimmering texture", 0.3, 0.38, True),
            "craft": ("gentle piano motif over warm pads, soft pulse, focused", 0.42, 0.48, True),
            "tools": ("building strings ostinato, soft cinematic percussion, momentum", 0.58, 0.56, False),
            "breath": ("suspended pad, held breath, quiet", 0.25, 0.4, True),
            "payoff": ("uplifting emotional release, shimmering strings, bright piano", 0.72, 0.72, False),
            "wide": ("grand and wide, soaring strings, open", 0.78, 0.78, False),
            "resolve": ("resolving warm piano chord, calm, fading", 0.2, 0.42, True),
        },
    },
    # 90-110 BPM: smooth, cool, effortless. 100 BPM: 35 beats from landing to hover.
    "effortless": {
        "bpm": 100,
        "scale": "F_MAJOR_D_MINOR",
        "base": "smooth minimal electronic, deep house groove, warm Rhodes electric piano chords, round bass, crisp soft hi-hats, clean, airy, modern",
        "sections": {
            "dark": ("filtered warm pads, no drums, quiet", 0.12, 0.25, True),
            "fly": ("rising filter sweep, anticipation, no drums", 0.25, 0.42, True),
            "craft": ("relaxed groove kicks in, effortless, Rhodes chords", 0.5, 0.55, False),
            "tools": ("groove with light percussion, playful, moving", 0.6, 0.6, False),
            "breath": ("breakdown, drums drop out, warm pads", 0.28, 0.42, True),
            "payoff": ("groove returns, bright shimmering chords, uplifting", 0.7, 0.74, False),
            "wide": ("full groove, open and wide", 0.74, 0.78, False),
            "resolve": ("outro, drums out, warm Rhodes chord ringing", 0.22, 0.45, True),
        },
    },
    # 115-123 BPM: elite, kinetic, sophisticated. 120 BPM: 42 beats from landing to hover.
    "kinetic": {
        "bpm": 120,
        "scale": "C_MAJOR_A_MINOR",
        "base": "sleek kinetic electronic, pulsing synth arpeggio, tight punchy kick, crisp claps, glossy synth stabs, sophisticated, precise, driving",
        "sections": {
            "dark": ("filtered synth arpeggio alone, no drums, quiet", 0.22, 0.28, True),
            "fly": ("rising tension, building arpeggio, riser", 0.4, 0.48, True),
            "craft": ("beat drops in, driving and precise", 0.68, 0.62, False),
            "tools": ("driving, layered arpeggios, energetic", 0.78, 0.68, False),
            "breath": ("breakdown, filtered arpeggio, tension, no drums", 0.32, 0.38, True),
            "payoff": ("drop, peak energy, bright, triumphant", 0.88, 0.84, False),
            "wide": ("wide sustained chords, soaring", 0.66, 0.78, False),
            "resolve": ("final hit and decay, ending", 0.18, 0.48, True),
        },
    },
    # Effortless with a film score's sheen: the groove stays the core, strings and horns join it,
    # and the piece takes a trailer's shape. At 103 BPM the cut's turns fall on bar lines: 2 bars
    # of dark, 9 from the landing to the hover (the last one a stop-down), 3 of climax, then the
    # name. The brief (composed_prompt) is told what not to be: an action trailer.
    "cinematic": {
        "model": "composed",
        "bpm": 103,
        "brief": {
            "lead": "Smooth Deep House groove with a cinematic film-score sheen: understated modern movie-soundtrack music for a premium product launch film, closer to an elegant keynote film than an action trailer",
            "palette": "At its core: warm Rhodes Piano chords, a round bass, a soft kick and crisp soft hi-hats. Layered over it: a lush string section (violins, Viola Ensemble, Cello), warm French horns and a felt piano. Elegant, confident, warm and emotional, and restrained: no taiko, no epic drums, no braams, never bombastic, cheesy or superhero-like",
            "intro": "dark and quiet. Sustained low strings and soft filtered pads, a few distant piano notes, a gentle ticking pulse. A soft swell rises into the downbeat at {t}",
            "part1": "the smooth groove enters (soft kick, round bass, Rhodes chords) under light pizzicato strings. Effortless and focused",
            "part2": "the strings and horns join the groove and it builds gently: a flowing string ostinato, warmer chords, a little more motion",
            "stop": "the drums and bass drop out; held strings only, a breath",
            "climax": "on the downbeat at {t} the groove returns fuller and wider: soaring strings, warm horns, the Rhodes and the bass. Uplifting and warm, not epic",
            "ending": "a soft final hit on the downbeat at {t}, then a warm sustained F major chord on strings and Rhodes ringing out to silence. No drums",
        },
        "sections": {  # only the density is read (measure.py's story fit)
            "dark": ("", 0.1, 0.25, True), "fly": ("", 0.25, 0.4, True), "craft": ("", 0.5, 0.55, False), "tools": ("", 0.6, 0.6, False),
            "breath": ("", 0.15, 0.35, True), "payoff": ("", 0.8, 0.75, False), "wide": ("", 0.8, 0.75, False), "resolve": ("", 0.3, 0.45, True),
        },
    },
    # The bolder reading: Effortless's groove under a full Hollywood trailer orchestra, braams and
    # taiko included. Kept as the reference for how far "cinematic" can go.
    "trailer": {
        "model": "composed",
        "bpm": 103,
        "brief": {
            "lead": "Orchestral Score with a smooth Deep House groove underneath: a modern Hollywood movie-trailer score for a short product launch film",
            "palette": "Lush strings (violins, Viola Ensemble, Cello), warm French horns and low brass, Rhodes Piano chords, felt piano, cinematic percussion (taiko, toms, deep hits), round sub bass, a soft kick and light hi-hats. Polished, elegant, emotional and confident; restrained, never cheesy or bombastic",
            "intro": "dark and quiet. A low sustained string drone, a few distant piano notes, a soft ticking pulse. A rising swell builds into one deep cinematic hit on the downbeat at {t}",
            "part1": "on that hit the smooth groove enters (soft kick, round bass, Rhodes chords) under a light pizzicato string ostinato. Effortless and focused",
            "part2": "building. A spiccato string ostinato, the horns join, toms and taiko pulses; momentum rising layer by layer",
            "stop": "everything drops out to near silence, a held breath; a short reverse swell rises into the drop",
            "climax": "the drop lands on the downbeat at {t} with a huge low brass hit (braam) and the full orchestra: soaring strings, French horns, big cinematic drums with the groove. Triumphant, majestic, wide",
            "ending": "one final deep boom on the downbeat at {t}, then a warm sustained F major chord on strings and piano ringing out to silence. No drums",
        },
        "sections": {
            "dark": ("", 0.1, 0.25, True), "fly": ("", 0.25, 0.4, True), "craft": ("", 0.5, 0.55, False), "tools": ("", 0.65, 0.6, False),
            "breath": ("", 0.12, 0.35, True), "payoff": ("", 0.9, 0.8, False), "wide": ("", 0.85, 0.8, False), "resolve": ("", 0.3, 0.45, True),
        },
    },
}


def composed_prompt(c, opt):
    """The composition brief for the cut: a trailer's acts (sparse open, build, stop-down, drop,
    button) on whole bars of the option's tempo, anchored so the drop falls on the agent's hover."""
    bpm, b = opt["bpm"], opt["brief"]
    at = lambda k: max(0, round(c["agent"]["hover"] + k * 240 / bpm))  # bar line k from the drop, whole seconds
    ts = lambda s: f"0:{s:02d}"
    end = at(3) + 7
    return f"""{b['lead']}. Instrumental only, no vocals, no choir. {bpm} BPM, steady tempo throughout, in F major. {b['palette']}.

Follow this structure and these timings exactly:
[{ts(0)} - {ts(at(-9))}] Intro, 2 bars: {b['intro'].format(t=ts(at(-9)))}.
[{ts(at(-9))} - {ts(at(-5))}] Part one, 4 bars: {b['part1']}.
[{ts(at(-5))} - {ts(at(-1))}] Part two, 4 bars: {b['part2']}.
[{ts(at(-1))} - {ts(at(0))}] Stop-down, 1 bar: {b['stop']}.
[{ts(at(0))} - {ts(at(3))}] Climax, 3 bars: {b['climax'].format(t=ts(at(0)))}.
[{ts(at(3))} - {ts(end)}] Ending: {b['ending'].format(t=ts(at(3)))}.
Total length: {end} seconds."""


def compose(cut, name, take):
    """Writes the whole piece from the brief in one call; the take is kept whole
    (mix.py finds its drop) and resampled to the mix's 48 kHz."""
    cues = json.loads((HOME / cut / "cues.json").read_text())
    opt = OPTIONS[name]
    prompt = composed_prompt(cues, opt)
    url = os.environ.get("MUSIC_API_URL")
    if not url:
        raise SystemExit("set MUSIC_API_URL to your music generation endpoint")
    req = urllib.request.Request(url,
                                 data=json.dumps({"model": opt["model"], "input": prompt, "response_format": {"type": "audio"}}).encode(),
                                 headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=900).read())
    audio, texts = None, []
    for step in resp.get("steps", []):
        for block in step.get("content", []) if step.get("type") == "model_output" else []:
            if block.get("type") == "audio":
                audio = block
            elif block.get("type") == "text":
                texts.append(block.get("text", ""))
    if not audio:
        raise SystemExit("no audio in the response: " + json.dumps(resp)[:600])
    out = HOME / cut / name
    out.mkdir(parents=True, exist_ok=True)
    mime = audio.get("mime_type", "audio/mpeg")
    src = out / f"bed-{take}.src.{'wav' if 'wav' in mime else 'mp3'}"
    src.write_bytes(base64.b64decode(audio["data"]))
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-ar", str(SR), "-ac", "2", "-c:a", "pcm_s16le", str(out / f"bed-{take}.wav")], check=True)
    (out / f"bed-{take}.json").write_text(json.dumps({"option": name, "model": opt["model"], "bpm": opt["bpm"], "mime": mime, "prompt": prompt, "text": texts}, indent=1) + "\n")
    with wave.open(str(out / f"bed-{take}.wav")) as w:
        print(out / f"bed-{take}.wav", f"{w.getnframes() / SR:.1f}s", mime)


LEAD = 2.0  # seconds of audio the model takes to answer a change: send each section's controls this early
PREROLL = 1.5  # generated before the film's 0, then trimmed, so the bed does not start cold


def api_key():
    if os.environ.get("MUSIC_API_KEY"):
        return os.environ["MUSIC_API_KEY"]
    raise SystemExit("set MUSIC_API_KEY")


async def generate(cut, name, take):
    seed = 1000 + int(take) * 37
    cues = json.loads((HOME / cut / "cues.json").read_text())
    opt = OPTIONS[name]
    plan = sections(cues)
    url = os.environ.get("MUSIC_STREAM_URL")
    if not url:
        raise SystemExit("set MUSIC_STREAM_URL to your streaming music endpoint")
    payload = {
        "seed": seed,
        "bpm": opt["bpm"],
        "scale": opt["scale"],
        "base": opt["base"],
        "duration": cues["duration"] + PREROLL + 2.0,
        "lead": LEAD,
        "sections": [
            {"name": sec, "at": round(t, 3), "prompt": opt["sections"][sec][0],
             "density": opt["sections"][sec][1], "brightness": opt["sections"][sec][2],
             "mute_drums": opt["sections"][sec][3]}
            for sec, t in plan
        ],
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"})
    pcm = urllib.request.urlopen(req, timeout=900).read()
    log = [{"section": sec, "sent_at_film_time": round(max(0.0, t - LEAD), 3)} for sec, t in plan]

    out = HOME / cut / name
    out.mkdir(parents=True, exist_ok=True)
    start = int(PREROLL * SR) * 4
    body = bytes(pcm[start:start + int(cues["duration"] * SR + SR) * 4])
    with wave.open(str(out / f"bed-{take}.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(body)
    (out / f"bed-{take}.json").write_text(json.dumps({"option": name, "bpm": opt["bpm"], "sections": plan, "sent": log}, indent=1) + "\n")
    print(out / f"bed-{take}.wav", f"{len(body) / (SR * 4):.1f}s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cut")
    ap.add_argument("option", choices=list(OPTIONS))
    ap.add_argument("--take", default="1")
    a = ap.parse_args()
    if OPTIONS[a.option].get("model") == "composed":
        compose(a.cut, a.option, a.take)
    else:
        asyncio.run(generate(a.cut, a.option, a.take))
