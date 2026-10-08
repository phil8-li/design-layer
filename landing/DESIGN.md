# Design rules

One rule per line: the property, its value or constraint, where it applies, and
who set it. A newer statement replaces the older line.

## Color

- Accent: indigo is Design Layer's color, `--accent` #798cff, `--accent-fill` #4a5df9 and `--accent-text` #90a3ff (landing/styles.css). Tinted light, glows and WebGL backgrounds use these, never an effect's stock palette; white light is fine. Scope: this folder. Source: Phil, 2026-10-04. Checked by `node landing/check.mjs --only static` for landing/backgrounds.js. The footer inspector may retint the page at the visitor's request, through the same tokens and the `accent` event; every load starts in indigo. Source: 2026-10-06.
- Canvas: the page is pure black (`--bg` #000) with no tinted ambient light or section glows; neutral surfaces carry no blue cast. Color comes from the product shots, the hero pills and the WebGL blinds. No light rays: the hero has the blinds alone, at strength 0.2 (`HERO_BLINDS`). Scope: landing/styles.css, landing/backgrounds.js. Source: Phil, 2026-10-06.

## Type

- Headlines are sans serif throughout, both phrases (Instrument Sans); no serif or italic voice in section headers. Scope: index.html h1, h2. Source: Phil, 2026-10-06.

## Expression

- Words can be objects: the hero's key phrases sit in pills with a die-cut sticker (the brand mark, or a sprite glyph on an accent tile) at the pill's start. Pills are solid (an opaque accent-derived fill), never translucent, with the same padding for every word and room between stacked lines (line height 1.36). Pill and sticker are concentric: the sticker (0.8em, the brand mark's 7/32 corners and colors, its dark ground #1e222d to #0c1014 with the glyph in its layer indigo #7c8eff, a 0.05em white ring, no inner highlight, no tilt) clears the pill by one gap above, below and before it, and the pill's radius is the ring's plus that gap. At most one token is interactive; it cycles real alternatives (vibe-coded, React, Angular) on its own every 2.6 s and on click, pauses on hover or focus, and stays still under reduced motion. Hard line breaks keep a new word from rewrapping earlier lines: only the line holding the token moves. Scope: index.html h1, main.js `setupToken`. Source: Phil, 2026-10-06 (learned from graphicalui.com's hero, not copied).
- The hero is the headline and the mockup alone: no buttons under the headline, no nav over it, no controls on it. The nav slides in when Design like Figma pins and holds, in order, the brand, Get started as a text link, "Film" as the secondary button (no icon; it opens the film), and GitHub as the primary button at the far right. Scope: index.html, main.js `showNav`. Source: Phil, 2026-10-06.
- The nav has no shadow: no box-shadow, drop shadow, or dark fade below the bar (its frosted fill stops at the bar's edge), and its buttons do not glow on hover. Scope: landing/styles.css `.nav`. Source: Phil, 2026-10-06.
- The page lets visitors try the product's idea on the page itself: the footer wordmark is selected like a layer and a small inspector restyles it (color, weight, spacing). The color control is graphicalui.com's wheel: touching 24px swatches dragged under a fixed frame, 40px tall with 8px corners, wrapping around. Sliders match it: a 40px track with 8px corners and a 24 by 32 thumb inset 4px (6px corners), the value under the pointer. Scope: index.html footer, main.js `setupTweak` and `slider`. Source: Phil, 2026-10-06.
- The footer is the last screen: the wordmark and its inspector centered in it as the focal point, the small print along the bottom. Where the small print's row no longer fits (1000px and under), brand, note and links stack on one left edge, the link text aligned with the note's. Scope: landing/styles.css `.footer`, `.endcard`, `.footer-inner`. Source: Phil, 2026-10-06.

## Story

- Get started: the two cards are twins. Each opens on a picture of one width (250px) and similar height (about 90px and 66px): for In your browser, a browser window kept simple (window buttons, a "Your app" tab, plain side panels, the floating toolbar and one selected button on your app; no address bar, rows or text); for As a Mac app, only the Dock: Figma, Sketch, Design Layer (third) and Terminal. Then a title, one line and the commands. Scope: index.html `#start`, styles.css `.mini-window`, `.mini-dock`. Source: Phil, 2026-10-07.
- Section order: after the hero comes Design like Figma, then the design system, then the board, then working with an agent, then the rest. Each section teaches one more capability on top of the hero's promise; there is no section between the hero and Design like Figma. Scope: index.html. Source: Phil, 2026-10-05.
- A tabbed section only holds tabs that prove its headline. A feature that serves another section's promise moves there (Design options lives in the agent section as Compare); one that serves none is cut (Shortcuts, Responsive, Light theme and Live preview left Design like Figma). Scope: index.html. Source: Phil, 2026-10-05.
- Headlines name the value plainly; no contrast phrases that need decoding ("Not ours" was cut). Scope: index.html. Source: Phil, 2026-10-05.
- Explanations live inside the visual, never as text beneath it: show the key, gesture or outcome on the shot itself (a key pill where it is pressed, a pointer and click ripple on what it clicks, a note pinned where it applies, a terminal for what the agent receives). No caption line under a frame. Scope: every feature section in index.html. Source: Phil, 2026-10-05 (said twice). Checked by `node landing/check.mjs --only static` ("no caption text under a feature visual").
- Direct edit types for real: the double-click selects a word, then each letter lands one at a time with a caret, set live in the demo app's own font so the line rewraps as the app did. No crossfade between before and after shots stands in for typing. Scope: index.html `#edit`, main.js `setupTypeEdit`. Source: Phil, 2026-10-05.
- Transitions are one continuous move: the hero's mock lands straight in Design like Figma's frame (no hold, no bigger-then-shrink step), and the design-system tabs share one camera that glides between panels instead of backing out. Scope: index.html, main.js (`handOff`, the switcher's `aim`). Source: Phil, 2026-10-05 (said three times).

## Copy

- Examples on the page are generic: no product names from other vendors (no "Storybook") and no employer- or company-internal terms; say "design system library" and use example domains such as acme.com. Scope: this folder. Source: Phil, 2026-10-05. One exception: the get-started Dock shows the Figma and Sketch app icons (no names in text) beside Design Layer and Terminal, to place it among a designer's tools. Scope: index.html `.scene-mac`, assets/dock/. Source: Phil, 2026-10-07.
