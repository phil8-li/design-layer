# Launch film

A 50 s silent motion piece built from the real screenshots in `landing/assets/shots/<demo>/`.

- `index.html`, `film.css`, `film.js`: the composition, 1920×1080. Every frame is a pure function of time. `window.seek(t)` sets every layer from easing curves. Nothing uses CSS transitions, animations or timers.
- `render.mjs` loads the composition in Playwright Chromium, seeks and screenshots each frame, and pipes the frames into ffmpeg.

## Render

```sh
node landing/film/render.mjs                    # ~2.5 min: 60 fps master → launch.mp4, launch-720.mp4, launch-poster.jpg
node landing/film/render.mjs --demo midday      # pick the screenshot set (default midday)
node landing/film/render.mjs --from 26 --to 32  # preview a range → /tmp/designlayer-film/preview.mp4
node landing/film/render.mjs --frames /tmp/stills --at 9.6,12.6,28.5   # stills at given seconds
node landing/film/render.mjs --encode-only      # re-encode the last master
node landing/film/render.mjs --fps 30           # 30 fps master instead of 60
```

To scrub by hand, run `node landing/serve.mjs` and open `/film/?demo=midday`. Then call `seek(12.5)` in the console.

Overrides: `FFMPEG=/path/to/ffmpeg`, `PLAYWRIGHT=/path/to/node_modules/` and `ORIGINALS=/dir`. The defaults are `ffmpeg` on PATH, Playwright resolved from this folder, and `~/.cache/designlayer-site/originals`.

## Outputs (`landing/assets/film/`)

The landing page now plays the approved cut instead: One move (`promo/`, cut `t`) with the Trailer score, published by `node landing/film/promo/publish.mjs t trailer`. Running `render.mjs` overwrites it with this film, so publish again after any render here.

| File | Format |
|---|---|
| `launch.mp4` | 1920×1080, 30 fps, H.264 High, yuv420p BT.709, faststart, AAC 128 kb/s, < 4 MB (2-pass) |
| `launch-720.mp4` | 1280×720, 30 fps, same settings, < 4 MB |
| `launch-poster.jpg` | 1920×1080 frame at 10 s (the editor, the headline selected) |

This film's own renders were silent, 1080p30 and 720p60. At ~600 kb/s, 1080p60 smears small text during camera moves; 1080p30 at the same size stays crisp, so the 1080p file is 30 fps.

## Shots and geometry

The film reads `app-only, hero, measure, tokens, canvas, notes, changes` plus `agent.json` and `diff.txt`. Any file the demo lacks comes from `midday`.

The site publishes shots only as `<name>-1280.webp` and `<name>-2400.webp`. The film requests `<name>.jpg`, and `render.mjs` answers those requests with the 3200×2000 originals in `~/.cache/designlayer-site/originals/<demo>/` (written by `landing/tools/optimize-shots.mjs`), so zoomed beats stay sharp. When an original is missing, as when you scrub through `serve.mjs`, the film falls back to `-2400.webp`.

- **Handoff (beats 10–11):** the Changes tab, `agent.json` and `diff.txt` come from one demo. That demo needs a `diff.txt` and an `agent.json` that is not a `wait_for_change` timeout, so the three tell one story.
- **Detected from pixels:** the hero selection outline (its size becomes the label), the note pins (they also set the notes framing), and the "Send to agent" button (it sets the Changes crop).
- **Hand-measured per demo:** in `GEO` at the top of `film.js`, in the shots' 1600×1000 CSS pixels. This covers the panel split, the inspector, measure and token framings, the token rows, and the canvas "Current" frame. A new demo needs its own `GEO` block if its layout differs from Midday's. `GEO.<demo>.select` overrides the selection framing, and a `GEO.<demo>.notes` camera overrides the one derived from the pins. Midday's framings keep every frame edge in whitespace, in a gap between inspector rows, or on the hero image, so no text is cut. Keep zooms at or below 3.6 CSS px per shot px, which is 1.8× the 2× original.

## Cuts with music (`beat/`)

Three edits of the film, each with an original soundtrack and its cuts timed to the beat. Nothing here is sampled or licensed: `synth.mjs` builds every sound from oscillators, noise and filters, so a score always renders the same WAV.

| Cut | Music | Edit |
|---|---|---|
| `a` Bounce | 124 BPM house-pop in F | A word slams in on every beat, then one cut per bar |
| `b` Cinematic | 90 BPM trailer in D minor | Letterbox, 3D planes that lock, one beat of silence before the logo |
| `c` Groove | 100 BPM swung funk in C | Bouncy type, springy UI, a stop before the logo |

```sh
node landing/film/beat/music.mjs          # all three → /tmp/designlayer-film/beat/<cut>.wav and landing/film/beat/cues/<cut>.json
node landing/film/beat/render.mjs a       # frames + soundtrack → /tmp/designlayer-film/beat/cut-a.mp4 (~2.5 min)
node landing/film/beat/render.mjs a --frames /tmp/stills --at 7.8,27.1
```

`scores.mjs` writes each score against a beat grid and exports a cue map: the BPM, the kick and snare times, and named marks such as `drop` and `logo`. `cuts.js` places every scene, word and whoosh on those marks, so changing a score's arrangement moves the edit with it. To preview a cut by hand, run `node landing/serve.mjs`, open `/film/beat/?cut=a`, and call `seek(t)` in the console.

## Story cuts (`story/`)

Three silent edits of one real editing session: select the headline, set its color to `#4A5DF9`, leave a note on Get started, send both to the agent, and show the brief and the diff. Every frame of the app is a capture of that session. The film only moves the camera, the pointer, and the light. It types into fields by revealing the captured text a character at a time, and it crossfades between captured states at the moment an action causes them.

| Cut | Idea |
|---|---|
| `d` One take | One unbroken camera that moves only to read what changes next |
| `e` Spotlight | A locked-off camera; light and numbered labels lead the eye |
| `f` Close-ups | One sentence and one magnified detail per step; the detail is the live editor, cropped, and it morphs from step to step |

```sh
node ../designlayer-demos/story/capture-story.mjs   # the session → ~/.cache/designlayer-site/story/midday (needs the demo app and its editor running)
node landing/film/story/render.mjs d                   # → /tmp/designlayer-film/story/cut-d.mp4 (~45 s)
node landing/film/story/render.mjs d --frames /tmp/stills --at 11,14.6
```

The capture also records where things are (`rects.json`: the selection, the Color field, the picker, the composer, the Send button), so a recapture moves the pointer and the framings with it.

`d` One take is the explainer style.

## Promo cuts (`promo/`)

Silent marketing edits of real captured sessions. The app is still only real frames. Around it, kinetic type and motion graphics use Design Layer's own vocabulary: selection boxes with handles, corner-radius dots and a size label, the indigo, the note pin, and the code.

Cuts `g h i` (`cuts.js`) play the explainer's session (`midday`: the headline set to `#4A5DF9`). Cuts `j k l` (`cuts-cta.js`) play the Get started restyle (`midday-cta`): the button scrubbed into a pill and given the brand indigo, plus a note asking the agent to make every primary button match. Cuts `m n o` (`cuts-tune.js`) play the fine-tuning session (`midday-tune`): the subtitle rewritten in place, the headline Alt-measured and the hero's auto-layout gap scrubbed from 24 to 36, the design system's radius token on Get started, a note asking for a border shimmer on hover, the agent's shimmer (captured frame by frame), and the canvas.

| Cut | Idea |
|---|---|
| `g` Designed live | The type gets edited with the product's tools: a selection on "it." grows into the app window, words are selected, tinted, and pinned in sync with the session, and the color floods the frame |
| `h` Color | A grey app floating in 3D; the color edit washes color back out from the headline |
| `i` Layers | The app and the editor's panels as planes in 3D that land and stack; each tool lifts off the page while it is used |
| `j` Color | `h` played for fun: deadpan type, "Rounder." in a selection that rounds with the scrub, the color bursting out of the button, "Now that's a button." |
| `k` One shape | One Figma selection carries the film: the camera goes through it into the app, then it selects, rounds and fills beside the real edit and flies down to become the button |
| `l` Layers | `i` with a four-second opening; the button lifts off the page and rounds up there; the note stays on the page |
| `m` Layers | `l` on the fine-tuning session: each piece lifts from exactly where it sits, on the page's own curve, then the page shrinks into its frame on the canvas |
| `n` Multiplayer | Tool keys (after Cua's keycaps) frame a flat window; they re-form as pointers for you and your agent, whose cursor hovers the shimmer it added |
| `o` Canvas | Opens and closes on the board; between, big words carry their tools: Edit., Measure., Space., Tokens., Ask. |

Cuts `p q r s t` (round 6) play `midday-r6`: the fine-tuning session again, with a new agent change (on hover Get started lifts, a sheen crosses it once, and a white light runs round the inside of its border), captured as patches round the button, 30 a second. Each cut is its own file, `cuts-r6-<id>.js`, loaded on its own, on the shared `cuts-r6.js`: the session, M's first act (`layerAct`: the subtitle and the hero group lift off the page while they are tuned), the editor as three planes (`planes`, as the landing page's hero), the landing page's two-tone headings (`showHeadline`), depth of field (`showFocus`), the hover as a plate (`hoverNode`), the board (`canvasStates`: round 5's zoom, with the editor's side panels masked off so it reads as every page), and the landing page's end card. When the editor steps aside for the agent (`session()`), the page blurs first, swaps to the app under the still-covering panels, then the panels slide out: no two layouts and no doubled panels on screen at once. Every cut keeps M's first act; after it there are no lifted layers, only close-ups and a different camera move per step.

| Cut | Idea |
|---|---|
| `p` Landing | The landing page in motion: the hero line over the three planes, which land into the editor; the page's section headings beside the window; orbit, crane, whip, macro push |
| `q` Keynote | A black stage, one idea per shot, objects carrying every scene: the line's selection becomes the window, the button goes alone onto black for the hover |
| `r` Steps | A prompt grows into the vibe-coded app; after M's act, O's step words with a camera move each |
| `s` Macro | Product macros: a thin plane of focus, rack focus, light falling off to black, small supers |
| `t` One move | One unbroken camera move: an exploded editor far out, then the window never stops; words stand in the space |

```sh
node ../designlayer-demos/story/capture-cta.mjs      # the j k l session → ~/.cache/designlayer-site/story/midday-cta
node ../designlayer-demos/story/capture-tune.mjs     # the m n o session → ~/.cache/designlayer-site/story/midday-tune
node ../designlayer-demos/story/capture-r6.mjs       # the p … t session → ~/.cache/designlayer-site/story/midday-r6
node ../designlayer-demos/story/capture-r6-hover4.mjs  # then the hover patches again, at 4x, for close-ups
node landing/film/promo/render.mjs g                    # → /tmp/designlayer-film/promo/cut-g.mp4 (~40 s)
node landing/film/promo/render.mjs p --ss 2             # rendered at 2x and scaled to 1080p: still edges while moving
node landing/film/promo/render.mjs k --frames /tmp/stills --at 2.9,15
```

Cut `t` has five sound designs, laid against the cut's own cue sheet (`cut.cues`): Keynote, Effortless, and Kinetic (round 7), then Effortless rescored as Cinematic and Trailer (round 8). Trailer is the pick, and the landing page plays it: `node landing/film/promo/publish.mjs t trailer` encodes it into `landing/assets/film/`. See `promo/sound/README.md`.

A plate's picture is scaled to five decimals (`f5` in `promo.js`): at two, a lifted card's picture landed up to 5 px off its card, differently each frame, which read as shake. A cut can name patch frames (`cut.patch`: frames that cover part of the page, at a rect in rects.json, feathered onto the frame under them) and the frames the editor's side strips can show (`cut.stripFrames`).

Each cut names its session and frames (`cut.session`, `cut.frames`); the page asks for `frames/<session>/<name>` and `render.mjs` answers from `~/.cache/designlayer-site/story/<session>/` (`FRAMES_ROOT` overrides). The `midday-cta` capture drags the Corner radius label for real, one frame per two pixels, so the film plays the scrub as a flipbook.

`promo.js` is the story engine plus depth (the window and nodes take `rx`, `ry`, `rz`, `z`), a light behind the window (`S.glow`), a color wipe (`S.flood`), a grey layer that a circle clears (`S.mono`), a name tag on the pointer (`S.cursor.label`), and nodes: cuts declare them once in `cut.nodes` and set each one's state every frame in `S.nodes`. Text nodes split into words or letters, and `rectOf` measures them, so a selection box can wrap a word; a selection also takes `radius`, a left-to-right `fill`, and radius `dots`. Any node takes `css`, `html`, and `sub` (styles or text for parts of it, by selector), which the brief and code cards use. `onWindow` places a node on the tilted window, lifted off the page along its normal. Plates (crops of captured frames) stack one image per frame in `frames`, so they can crossfade or flipbook, and they can type, like the page does. A cut can also name its typed fields (`cut.fields`: the field's rect and the frame with the words in it). Captions take `**bold**` and `*italic serif*` runs and an `icon` that leads them. The cuts get `agent` and `diffText` too, so the brief and the code line are set from the capture, and each class in the code line is labeled with the inspector property and value it came from.
