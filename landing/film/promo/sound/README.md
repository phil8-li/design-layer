# Sound for the promo cuts

Sound designs for cut `t` (One move). Round 7 made three, each in one of the tempo bands
from the Apple breakdown the film follows: Keynote at 74 BPM (regal, cinematic), Effortless
at 100 BPM (smooth), Kinetic at 120 BPM (kinetic, sophisticated). Round 8 took Effortless
further: Cinematic keeps its groove and interface sounds under strings and horns in a
trailer's shape, with the camera's air turned down to a breeze. Trailer, the bolder
reading with a braam, taiko, and a final slam, is the one picked for the launch film
(`mix.py t trailer --take 3`). Every effect is synthesized here from noise and tones.

```sh
node landing/film/promo/sound/cues.mjs t                     # the picture's events → ~/.cache/designlayer-site/sound/t/cues.json
MUSIC_API_KEY=… python3 landing/film/promo/sound/bed.py t keynote --take 1    # a music bed (make a few takes)
python3 landing/film/promo/sound/measure.py t keynote        # rank the takes against the story
python3 landing/film/promo/sound/measure.py t cinematic 6 --bars 19 37   # a composed take, bar by bar
python3 landing/film/promo/sound/mix.py t keynote --take 2 --video /tmp/designlayer-film/promo/cut-t.mp4
python3 landing/film/promo/sound/verify.py t keynote         # effects on cues, beats, sync, loudness
python3 landing/film/promo/sound/audibility.py t keynote     # each kind of effect against the music
python3 landing/film/promo/sound/picture.py t keynote out.png  # the mix as a spectrogram, cues marked
```

Python 3 with numpy, scipy and pedalboard. `bed.py` reads `MUSIC_API_KEY` and `MUSIC_API_URL`.

- **One clock.** The cut publishes its events (`cut.cues`, read as `window.CUES`), so
  the sound is laid against the same times the picture uses. Change the timeline and
  the cue sheet follows.
- **Streamed beds follow the story.** For Keynote, Effortless and Kinetic, `bed.py` steers
  a streaming music model section by section (prompt, density, brightness, drums) a little ahead of
  each section. `mix.py` then corrects each section's level to the plan, opens a filter on
  the landing, makes the music hold its breath before the hover, and resolves it at the end.
- **Composed beds are cut to picture.** For Cinematic and Trailer, a composition model writes the
  whole piece from a brief timed to the cues: a trailer's acts on whole bars of 103 BPM.
  It keeps the shape but not the timings (its intros run 4 or 8 bars), so `mix.py` cuts
  each take on its bar lines from a cut list (`CUTS`). The list repeats or skips bars and
  crossfades over the 30 ms before each seam's beat. The groove lands on the landing, the
  lift on the hover, and the final chord on the name; a final chord that stops too soon
  rings on through a hall. Read a take's bars with `measure.py --bars` to write its list.
- **On the beat where it matters.** The bed is stretched so the landing and the hover are
  a whole number of beats apart, then slid so a beat falls on both. Beats are measured on
  the kick and claps where there are drums, because the bass line can sit between them.
- **Effects on their cues.** Each effect sits on its moment. Air on a camera move is
  loudest where the eased move is fastest. Levels are trimmed per kind from
  `audibility.py`: each effect is measured against the music in its own band. In
  Cinematic the air is a `breeze`, about 11 dB under the music with no hiss, and only on
  the big moves.
- **Cleaned.** Streamed takes can carry a narrow 12-16 kHz noise band or tone, and
  brief dropouts. `mix.py` filters the band per direction and patches each dropout with the
  same stretch one bar earlier. The composed takes came out clean.
- **Mastered** to -16 LUFS with true peaks under -2.5 dB, AAC at 256 kbps. The limiter is
  driven until the peaks sit within reach of the target, so loudnorm applies one linear
  gain (`mix.json` records `normalization`). Otherwise it falls back to riding the gain,
  which flattens the sections; round 7's mixes did. `verify.py` checks the film's audio
  against the mix to the sample.
