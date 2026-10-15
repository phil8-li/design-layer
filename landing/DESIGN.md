---
version: alpha
name: Design Layer landing page
description: "A pure-black marketing page where the headline and the real product shots carry the color. One indigo accent (the editor's own), Instrument Sans headlines over an Inter body, solid indigo pills that turn headline words into objects, and frosted, shadowless chrome. Every value below is copied from landing/styles.css, which stays the source of truth."
colors:
  primary: "#798cff"
  primary-text: "#90a3ff"
  primary-fill: "#4a5df9"
  primary-glow: "rgb(121 140 255 / 0.18)"
  canvas: "#000"
  line: "rgb(255 255 255 / 0.08)"
  line-strong: "rgb(255 255 255 / 0.14)"
  ink: "#fafafa"
  ink-2: "#a1a1aa"
  ink-3: "#8a8a93"
  add: "#7ee2a8"
  white: "#fff"
  on-white: "#0b0b0b"
  pill: "#1a2350"
  pill-hover: "#212c68"
  pill-active: "#26337c"
  sticker-ground-top: "#1e222d"
  sticker-ground: "#0c1014"
  sticker-glyph: "#7c8eff"
  nav-frost: "rgb(0 0 0 / 0.74)"
typography:
  display:
    fontFamily: '"Instrument Sans", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: 68px
    fontWeight: 500
    lineHeight: 1.36
    letterSpacing: -0.035em
  headline:
    fontFamily: '"Instrument Sans", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: 50px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: -0.03em
  stat:
    fontFamily: '"Instrument Sans", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: 44px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: -0.03em
  card-title:
    fontFamily: '"Instrument Sans", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: 19px
    fontWeight: 600
    letterSpacing: -0.015em
  body:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: 16px
    lineHeight: 1.625
    fontFeature: "\"cv11\", \"ss01\""
  body-sm:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: 14px
    lineHeight: 1.5
  button:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1
    letterSpacing: -0.01em
rounded:
  control: 10px
  shot: 14px
  frame: 20px
  tweak: 8px
  wheel-frame: 6px
  thumb: 4px
  sticker: 0.175em
spacing:
  wrap: 1120px
  wrap-wide: 1240px
  gutter: "clamp(20px, 4vw, 40px)"
  section: "clamp(96px, 12vw, 152px)"
  frame-inset: 6px
  tweak-inset: 4px
components:
  page:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
  page-secondary-text:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-2}"
    typography: "{typography.body-sm}"
  page-dim-text:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-3}"
  accent-word:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.primary-text}"
  success-mark:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.add}"
  hero-headline:
    textColor: "{colors.ink}"
    typography: "{typography.display}"
  section-headline:
    textColor: "{colors.ink}"
    typography: "{typography.headline}"
  fact:
    typography: "{typography.stat}"
  hero-pill:
    backgroundColor: "{colors.pill}"
    textColor: "{colors.ink}"
  hero-pill-hover:
    backgroundColor: "{colors.pill-hover}"
    textColor: "{colors.ink}"
  hero-pill-active:
    backgroundColor: "{colors.pill-active}"
    textColor: "{colors.ink}"
  hero-sticker:
    backgroundColor: "{colors.sticker-ground}"
    textColor: "{colors.sticker-glyph}"
    rounded: "{rounded.sticker}"
    size: 0.8em
  hero-sticker-top:
    backgroundColor: "{colors.sticker-ground-top}"
    textColor: "{colors.sticker-glyph}"
  nav:
    backgroundColor: "{colors.nav-frost}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-white}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    height: 44px
  button-primary-hover:
    backgroundColor: "{colors.white}"
    textColor: "{colors.on-white}"
  button-secondary:
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    height: 44px
  get-started-card:
    typography: "{typography.card-title}"
    rounded: "{rounded.frame}"
    padding: 28px
  product-shot:
    rounded: "{rounded.shot}"
  color-wheel:
    height: 40px
    rounded: "{rounded.tweak}"
  color-wheel-frame:
    backgroundColor: "{colors.primary}"
    width: 24px
    rounded: "{rounded.wheel-frame}"
  slider-track:
    height: 40px
    rounded: "{rounded.tweak}"
  slider-fill:
    backgroundColor: "{colors.primary-fill}"
  slider-thumb:
    backgroundColor: "{colors.white}"
    width: 24px
    height: 32px
    rounded: "{rounded.thumb}"
---

# Design Layer landing page

Rules for the marketing page in `landing/`. The editor's rules live in the
repository root's `DESIGN.md`; this page borrows only the editor's indigo
(`primary` #798cff, `primary-fill` #4a5df9, `primary-text` #90a3ff, the editor's
dark-theme accent) and is otherwise independent of it.

`landing/styles.css` is the source of truth. The frontmatter copies it; if the
two disagree, the stylesheet wins and this file is stale. A newer rule replaces
the older line in place, so the file never holds two answers for one property.

## Overview

The page sells a visual editor by showing it. The canvas is pure black so the
headline and the real product shots carry the page. Each section teaches one
capability on top of the hero's promise, and the explanation lives inside the
picture. The tone is calm and technical: one accent, sans-serif headlines,
frosted chrome with no shadows, and motion that moves as one continuous camera.

## Colors

Source: `landing/styles.css:31-45` (`:root`), `:303` and `:307` (primary
button), `:354` (nav frost), `:609`, `:690`, `:695` (pill and its states),
`:659-660` (sticker).

- **Canvas (`canvas` #000):** pure black, no tint, no ambient light.
- **Indigo (`primary`, `primary-fill`, `primary-text`):** the only hue the page
  adds. Tinted light, glows and WebGL backgrounds use these. `primary-glow` is
  the no-WebGL fallback glow behind the hero (`styles.css:462-475`); with
  WebGL the blinds replace it.
- **Ink (`ink` #fafafa, `ink-2` #a1a1aa, `ink-3` #8a8a93):** text, secondary
  text, dim text.
- **Lines (`line`, `line-strong`):** white at 8% and 14% for card and control
  edges.
- **Pill (`pill` #1a2350):** the hero pill, opaque:
  `color-mix(in oklab, var(--accent-fill) 36%, #050505)`. Hover takes 46%
  (`pill-hover`), press 54% (`pill-active`).
- **Sticker:** the brand mark's ground, a gradient from `sticker-ground-top`
  #1e222d to `sticker-ground` #0c1014, with its layer indigo `sticker-glyph`
  #7c8eff.
- **`add` #7ee2a8:** success marks only (a copied command, an "ok" line).

## Typography

Source: `landing/styles.css:3-24` (faces), `:47-49` (stacks), `:86-89` (body),
`:562-568` (h1), `:1214-1219` (h2), `:1485-1490` (facts), `:1531-1535` (card
title), `:243-244` (button).

Headlines are Instrument Sans; the body is Inter with `cv11` and `ss01`. Display
sizes are fluid in the stylesheet; the tokens hold the maximum:

| Token | CSS size |
| --- | --- |
| display (h1) | `clamp(34px, 5.4vw, 68px)` |
| headline (h2) | `clamp(30px, 3.6vw, 50px)` |
| stat | `clamp(30px, 3.6vw, 44px)` |

Hedvig Letters Serif is loaded only for the direct-edit demo's live retype (the
demo app's own font), never for the page's voice.

## Layout

Source: `landing/styles.css:51-58`.

Content sits in a 1120px wrap (1240px wide), with a fluid gutter
(`clamp(20px, 4vw, 40px)`) and fluid section padding
(`clamp(96px, 12vw, 152px)`). The section order and what each section holds are
rules; see Do's and Don'ts, Story.

## Elevation & Depth

The page is flat. Depth comes from the product shots and frosted glass
(`--frost: blur(18px) saturate(1.6)`, `styles.css:62`) on the nav and the
footer's links row, never from shadows on chrome. The primary button glows on
hover outside the nav (`0 8px 28px -10px rgb(255 255 255 / 0.5)`,
`styles.css:308`); inside the nav it does not.

## Shapes

Source: `landing/styles.css:56-59`, `:611`, `:2804` and `:2863` (8px),
`:2821` and `:2898` (6px).

- `control` 10px: buttons. `shot` 14px: product shots. `frame` 20px: a framed
  shot or card, equal to `shot` plus the 6px `frame-inset`, so the two corners
  are concentric.
- `tweak` 8px, `wheel-frame` 6px, and `thumb` 4px: the footer inspector's wheel
  and sliders. The thumb is inset 4px, so its corner runs parallel to the
  track's.
- `sticker` 0.175em: the brand mark's 7/32 corner at the 0.8em sticker size.
  The pill's radius is `sticker` + ring (0.05em) + gap (0.17em).

## Components

- **Hero pill and sticker:** see Do's and Don'ts, Expression, for the geometry
  and behavior; tokens give the colors and the sticker size.
- **Buttons:** 44px tall, 18px side padding, `control` corners, 15px Inter 500.
  Primary is white on near-black ink; secondary is a `line-strong` outline on a
  3% white fill. Pressed, a button sinks to 96%.
- **Nav:** frosted `nav-frost` fill with no shadow or rule below it.
- **Footer inspector:** a 40px color wheel of 24px swatches under a fixed frame,
  and 40px sliders with a 24 × 32 thumb. The slider fill is a gradient from
  `primary-fill` to `primary` (`styles.css:2877`); the token holds its first stop.
- **Motion** (`styles.css:64-66`): `--ease-out` cubic-bezier(0.23, 1, 0.32, 1),
  `--ease-in-out` cubic-bezier(0.77, 0, 0.175, 1), `--ease-hover`
  cubic-bezier(0.4, 0, 0.2, 1). Under reduced motion, or without script or
  WebGL, every scene rests in its final frame (`landing/AGENTS.md`).

## Do's and Don'ts

Each rule: the property, its value or constraint, where it applies, who set it,
and the check that enforces it when one exists.

### Color

- Accent: indigo is Design Layer's color, `--accent` #798cff, `--accent-fill` #4a5df9 and `--accent-text` #90a3ff (landing/styles.css). Tinted light, glows and WebGL backgrounds use these, never an effect's stock palette; white light is fine. Scope: this folder. Source: Phil, 2026-10-04. Checked by `node landing/check.mjs --only static` for landing/backgrounds.js. The footer inspector may retint the page at the visitor's request, through the same tokens and the `accent` event; every load starts in indigo. Source: 2026-10-06.
- Canvas: the page is pure black (`--bg` #000) with no tinted ambient light or section glows; neutral surfaces carry no blue cast. Color comes from the product shots, the hero pills and the WebGL blinds. No light rays: the hero has the blinds alone, at strength 0.2 (`HERO_BLINDS`). Scope: landing/styles.css, landing/backgrounds.js. Source: Phil, 2026-10-06.

### Type

- Headlines are sans serif throughout, both phrases (Instrument Sans); no serif or italic voice in section headers. Scope: index.html h1, h2. Source: Phil, 2026-10-06.

### Expression

- Words can be objects: the hero's key phrases sit in pills with a die-cut sticker (the brand mark, or a sprite glyph on an accent tile) at the pill's start. Pills are solid (an opaque accent-derived fill), never translucent, with the same padding for every word and room between stacked lines (line height 1.36). Pill and sticker are concentric: the sticker (0.8em, the brand mark's 7/32 corners and colors, its dark ground #1e222d to #0c1014 with the glyph in its layer indigo #7c8eff, a 0.05em white ring, no inner highlight, no tilt) clears the pill by one gap above, below and before it, and the pill's radius is the ring's plus that gap. At most one token is interactive; it cycles real alternatives (vibe-coded, React, Angular) on its own every 2.6 s and on click, pauses on hover or focus, and stays still under reduced motion. Hard line breaks keep a new word from rewrapping earlier lines: only the line holding the token moves. Scope: index.html h1, main.js `setupToken`. Source: Phil, 2026-10-06 (learned from graphicalui.com's hero, not copied).
- The hero is the headline and the mockup alone: no buttons under the headline, no nav over it, no controls on it. The nav slides in when Design like Figma pins and holds, in order, the brand, Get started as a text link, "Film" as the secondary button (no icon; it opens the film), and GitHub as the primary button at the far right. Scope: index.html, main.js `showNav`. Source: Phil, 2026-10-06.
- The nav has no shadow: no box-shadow, drop shadow, or dark fade below the bar (its frosted fill stops at the bar's edge), and its buttons do not glow on hover. Scope: landing/styles.css `.nav`. Source: Phil, 2026-10-06.
- The page lets visitors try the product's idea on the page itself: the footer wordmark is selected like a layer and a small inspector restyles it (color, weight, spacing). The color control is graphicalui.com's wheel: touching 24px swatches dragged under a fixed frame, 40px tall with 8px corners, wrapping around. Sliders match it: a 40px track with 8px corners and a 24 by 32 thumb inset 4px (6px corners), the value under the pointer. Scope: index.html footer, main.js `setupTweak` and `slider`. Source: Phil, 2026-10-06.
- The footer is the last screen: the wordmark and its inspector centered in it as the focal point, the small print along the bottom. Where the small print's row no longer fits (1000px and under), brand, note and links stack on one left edge, the link text aligned with the note's. Scope: landing/styles.css `.footer`, `.endcard`, `.footer-inner`. Source: Phil, 2026-10-06.

### Story

- Get started: the two cards are twins. Each opens on a picture of one width (250px) and similar height (about 90px and 66px): for In your browser, a browser window kept simple (window buttons and a `localhost:3000` tab; inside, an empty page with a dashed "Your app" placeholder that turns into Design Layer's solid indigo outline as the section arrives, no other content); for As a Mac app, only the Dock: Figma, Sketch, Design Layer (third) and Terminal. Then a title, one line and the commands. Scope: index.html `#start`, styles.css `.mini-window`, `.mini-dock`. Source: Phil, 2026-10-07.
- Section order: after the hero comes Design like Figma, then the design system, then the board, then working with an agent, then the rest. Each section teaches one more capability on top of the hero's promise; there is no section between the hero and Design like Figma. Scope: index.html. Source: Phil, 2026-10-05.
- A tabbed section only holds tabs that prove its headline. A feature that serves another section's promise moves there (Design options lives in the agent section as Compare); one that serves none is cut (Shortcuts, Responsive, Light theme and Live preview left Design like Figma). Scope: index.html. Source: Phil, 2026-10-05.
- Headlines name the value plainly; no contrast phrases that need decoding ("Not ours" was cut). Scope: index.html. Source: Phil, 2026-10-05.
- Explanations live inside the visual, never as text beneath it: show the key, gesture or outcome on the shot itself (a key pill where it is pressed, a pointer and click ripple on what it clicks, a note pinned where it applies, a terminal for what the agent receives). No caption line under a frame. Scope: every feature section in index.html. Source: Phil, 2026-10-05 (said twice). Checked by `node landing/check.mjs --only static` ("no caption text under a feature visual").
- Direct edit types for real: the double-click selects a word, then each letter lands one at a time with a caret, set live in the demo app's own font so the line rewraps as the app did. No crossfade between before and after shots stands in for typing. Scope: index.html `#edit`, main.js `setupTypeEdit`. Source: Phil, 2026-10-05.
- Transitions are one continuous move: the hero's mock lands straight in Design like Figma's frame (no hold, no bigger-then-shrink step), and the design-system tabs share one camera that glides between panels instead of backing out. Scope: index.html, main.js (`handOff`, the switcher's `aim`). Source: Phil, 2026-10-05 (said three times).

### Copy

- Examples on the page are generic: no product names from other vendors (no "Storybook") and no employer- or company-internal terms; say "design system library" and use example domains such as acme.com. Scope: this folder. Source: Phil, 2026-10-05. One exception: the get-started Dock shows the Figma and Sketch app icons (no names in text) beside Design Layer and Terminal, to place it among a designer's tools. Scope: index.html `.scene-mac`, assets/dock/. Source: Phil, 2026-10-07.

## Iteration Guide

1. Load the `capture-design-rule` skill when Phil states a rule or repeats a
   correction.
2. A value change goes in `landing/styles.css` first (`:root` for shared
   values), then into the frontmatter here with the same value.
3. A constraint goes under the matching Do's and Don'ts heading as one line:
   property, value, scope, source (who, date), and its check. Edit an older line
   in place instead of adding a second one.
4. Run `npx -y @google/design.md lint landing/DESIGN.md`. Keep 0 errors and no
   broken-ref or contrast warnings.
5. Run `node landing/check.mjs --only static`. Add a static check there when a
   rule can be tested cheaply.
6. Run `node test/design-md-cases.mjs`: it fails when a frontmatter value
   differs from `styles.css` or has no row in its mapping table. A new token
   gets a row there.

## Known Gaps

- `--raised` (#111) is declared in `:root` but no rule uses it, so it is not a
  token here.
- Fluid sizes do not fit the format's Dimension type: display type tokens hold
  the clamp's maximum (the full clamp is in Typography), and `gutter` and
  `section` keep the clamp as a string.
- `rounded.frame` is the computed value of `calc(var(--radius-shot) + var(--frame-inset))`.
- `rounded.thumb` is the computed value of `calc(8px - var(--inset))`, 4px,
  which keeps the thumb's corner parallel to the 8px track. The slider rule
  below says "6px corners"; that number and the parallel corner cannot both
  hold, so the rule waits on Phil.
- The linter accepts `color-mix()` only in srgb, so `pill`, `pill-hover` and
  `pill-active` hold the sRGB result of the stylesheet's oklab mix
  (`styles.css:609`, `:690`, `:695`). Recompute them when `--accent-fill`
  changes.
- One-off colors stay in the stylesheet: the secondary button's 3% and 7%
  white fills and 24% hover border, the Code-demo syntax tints (for example
  `.t-str` #e6c07b), slider ticks, and shadows.
- `line`, `line-strong` and `primary-glow` are borders and a background
  gradient; the format's component properties have no border or gradient slot.
  Lint lists these three as orphaned tokens; that is expected.
