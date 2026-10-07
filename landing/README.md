# Design Layer landing page

The marketing site for [DesignLayer](../README.md), and every launch film cut
made for it. It is a self-contained module: nothing in the editor imports it,
and it imports nothing from the editor at runtime, so it can move to its own
repository unchanged (see [Moving it to its own repo](#moving-it-to-its-own-repo)).

A single static page: `index.html`, `styles.css`, `main.js`, and `assets/`. No
build step and no dependencies. `.github/workflows/landing.yml` publishes it to
[GitHub Pages](https://phil8-li.github.io/design-layer/) on every push to `main`.

| Path | What |
| --- | --- |
| `index.html`, `styles.css`, `main.js`, `backgrounds.js` | The page |
| `assets/` | Screenshots, fonts, brand, and the published film |
| `film/` | Film sources: `story/`, `promo/`, `beat/` and the sound tools |
| `film/iterations/` | Every rendered cut, rounds 1 to 8, with comparison pages (Git LFS) |
| `check.mjs`, `serve.mjs`, `tools/` | Checker, local server, asset tools |
| `DESIGN.md` | Design rules for the page |

```sh
node landing/serve.mjs                 # http://127.0.0.1:4321
node landing/check.mjs                 # markup, links, budget, then a browser pass
node landing/check.mjs --only static   # what CI runs; needs no browser
```

The browser pass needs Playwright. It is found on its own when installed
globally or through `npx`; otherwise point `SITE_PLAYWRIGHT_DIR` at a
`node_modules` that has it.

## Screenshots

Every product image is a real capture of Design Layer editing a real open-source
app, under `assets/shots/<demo>/`. The page shows one demo, `midday`: Midday's
open-source website (AGPL-3.0), renamed "Demo app", with its copy rewritten to
describe Design Layer. Each demo folder has a `manifest.json` naming the app, its repository and
license, and what each shot shows, plus the `diff.txt` and `agent.json` the
page renders as text.

After a recapture, write the two served widths and refresh `demos.json`:

```sh
node landing/tools/optimize-shots.mjs            # every demo folder
node landing/tools/optimize-shots.mjs --only a,b  # some, while another is still being shot
```

With more than one demo folder, `?review` adds a picker and `?demo=<slug>`
shows one directly. The scroll scenes animate over the screenshots using the
`selection`, `focus` and `pins` geometry each manifest records, so a recapture
must keep those fields. `optimize-shots.mjs` adds what it can find in the
pixels: the panel seams, the toolbar and the Send to agent button. The film's
`GEO` and the Pick note's spot (`.pick-note` in styles.css) are measured by
hand, so re-measure them when a recapture moves the page's content.

## Motion

`main.js` runs every scene from one `requestAnimationFrame` loop:

- **Hero:** three planes (the app, the editor's panels, its toolbar) start
  apart at a gentle angle and follow the pointer; scroll sets them down in turn
  until they line up into the real screenshot, then the mock flies straight
  into Design like Figma's frame, whose stage is pinned underneath.
- **Feature sections**, in story order: Design like Figma (Direct edit, Align,
  Measure, Hide Design Layer), the design system (Libraries, Tokens, Audit; one
  camera glides from panel to panel across the three), the board, then
  iterating with an agent. Each tabbed section pins; scroll walks the tabs, and
  choosing a tab scrolls to it. Nothing is explained in text under a shot: a
  pointer, click ripples and key pills drawn on the shot (`.cue-*`, one scroll
  clock `--t`) show each move. The agent section's four tabs (Point, Send,
  Compare, Pick) share one camera; its terminal carries the MCP setup command
  and the two recorded handoffs (`agent.json`, `agent-close.json`).
- **Board:** the live page pulls back into its frame on the board (⇧1), the
  pointer takes the frame's Live button, and the page flies back in.
- **Headings** brighten word by word as they rise. The nav stays out of the
  hero and slides in once Design like Figma pins.

The toolbar over the screenshots is redrawn in HTML from the editor's computed
styles, in a 1600x1000 layer scaled to the frame, so it stays sharp up close.
The hero's app plane shows `hero-bare` (the same capture with the toolbar
hidden, taken by `capture-midday.mjs`), so the only toolbar there is the one
that lands.
With `prefers-reduced-motion: reduce`, or without script, nothing is pinned and
each scene rests in its final frame.

WebGL backgrounds run outside that loop, each only while it is on screen
(`backgrounds.js`, ported from React Bits' GradientBlinds, under the license in
`backgrounds.LICENSE.txt`): gradient blinds in the site's indigo. In the hero
they sit behind the mockup at 20% strength (`HERO_BLINDS`), lit from above the
top center by LightRays' average falloff, and fade out from the top of the
viewport down, the footer's fade turned over. In the footer the blinds rise out
of the section above and run to the bottom edge, lit where the pointer is, with
the light kept above the links. Everywhere else the page is plain black.
Reduced motion gets one still frame; without WebGL the hero keeps a CSS glow
(grained at `NOISE`) and the footer goes plain.

## Launch film

`assets/film/` holds the approved launch film: the One move cut (`film/promo`,
cut `t`) with its Trailer score (`film/promo/sound`, option `trailer`), 36 s with
sound. The page's Watch the film dialog plays it. To rebuild it:

```sh
node landing/film/promo/render.mjs t --ss 2      # the picture
python3 landing/film/promo/sound/mix.py t trailer --take 3 --video /tmp/designlayer-film/promo/cut-t.mp4
node landing/film/promo/publish.mjs t trailer    # launch.mp4, launch-720.mp4 (each < 4 MB), launch-poster.jpg
```

`film/render.mjs` is the first film, 50 s and silent. It still writes to
`assets/film/` when run, so publish the approved cut again afterwards.

## Mac download

The Get the ZIP link and `install.sh` point at the absolute GitHub Pages copy,
`https://phil8-li.github.io/design-layer/downloads/Design-Layer-for-Mac.zip`,
not a relative path. The zip is built, never committed, so a copy of this
folder served from Vercel, Netlify or anywhere else has no `downloads/`; the
absolute link keeps the button working there as long as the Pages deploy in
`.github/workflows/landing.yml` keeps running. If Pages is ever turned off,
publish the zip somewhere else first and change the link.

CI builds the zip on every deploy; locally:

```sh
node desktop/mac/package.mjs
```

The zip bundles Design Layer itself; users need Node 20.9+ and Chrome,
not `npm i designlayer`. The page says so above the command.

The Mac card leads with a Terminal one-liner, not the zip:
`curl -fsSL https://phil8-li.github.io/design-layer/downloads/install.sh | bash`.
`package.mjs` writes `install.sh` next to the zip. A .command double-clicked
from a browser download is quarantined, and macOS 15+ refuses to open it
("Apple could not verify … is free of malware") until the user clicks Open
Anyway in System Settings › Privacy & Security; right-click › Open no longer
skips that. curl sets no quarantine flag, so the one-liner installs with no
prompt. The zip stays as the secondary link, with that step spelled out.

## Icons

`assets/icons.svg` is generated from the editor's own glyphs in
`src/core/icons.ts`. Add a name to the list in `tools/build-sprite.mjs` and run:

```sh
node landing/tools/build-sprite.mjs
```

The page is set in [Inter](https://rsms.me/inter/) (SIL Open Font License,
`assets/fonts/LICENSE-Inter.txt`), with headlines in Instrument Sans and the
Direct edit demo retyped in Hedvig Letters Serif (SIL Open Font License,
`assets/fonts/LICENSE-OFL.txt`), all subset to Latin.

## Film iterations

`film/iterations/` keeps every cut that was rendered while choosing the launch
film: the first three options, then rounds 2 to 8, each with an `index.html`
that plays the options side by side. Open `film/iterations/index.html` through
`node landing/serve.mjs` to browse them.

The MP4s and sound spectrograms are stored in Git LFS (`.gitattributes` in this
folder). Install it once with `brew install git-lfs && git lfs install`, or clone
with `GIT_LFS_SKIP_SMUDGE=1` to skip them. They are excluded from `check.mjs`'s
budget and from the deploy.

## Moving it to its own repo

1. Extract the history: `git subtree split --prefix=landing -b landing-only`,
   then push that branch to the new repository's `main`.
2. Copy `.github/workflows/landing.yml` into the new repo. Drop `landing/` from
   its paths, and replace the Mac download step with a checkout of
   `phil8-li/design-layer` that runs `node desktop/mac/package.mjs --out downloads`.
3. Run `git lfs push --all origin` so the iteration files follow.
4. To rebuild the icon sprite, run
   `DESIGNLAYER_REPO=<path to designlayer> node tools/build-sprite.mjs`.
