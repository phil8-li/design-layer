---
version: alpha
name: Design Layer editor chrome
description: "The editor overlay that floats over someone else's running app: two docked 240px/260px panels and a floating toolbar, dense like Figma (12px UI text, 24px rows), cool neutrals with one indigo accent for strokes, focus and selection. Dark is the default theme; light swaps only colors. Every value below is copied from src/core/tokens.ts, which stays the source of truth."
colors:
  # Dark theme (the default). Source: src/core/tokens.ts PALETTE.color, dark column.
  primary: "#798cff"
  primary-fill: "#4a5df9"
  primary-fill-hover: "color-mix(in srgb, #0c1014 14%, #4a5df9)"
  primary-text: "#90a3ff"
  on-primary: "#ffffff"
  primary-soft: "color-mix(in srgb, #4a5df9 28%, #171717)"
  primary-soft-muted: "color-mix(in srgb, #4a5df9 16%, #171717)"
  primary-halo: "color-mix(in srgb, #798cff 30%, transparent)"
  selection: "color-mix(in srgb, #798cff 18%, transparent)"
  surface: "#171717"
  surface-raised: "color-mix(in srgb, #ffffff 12%, #171717)"
  surface-raised-hover: "color-mix(in srgb, #ffffff 16%, #171717)"
  surface-sunken: "color-mix(in srgb, #ffffff 6%, #171717)"
  surface-hover-quiet: "color-mix(in srgb, #ffffff 10%, #171717)"
  segment-selected: "#363c44"
  tab-selected: "#25292e"
  ink: "#fafafa"
  ink-muted: "rgba(255,255,255,0.75)"
  ink-dim: "rgba(255,255,255,0.70)"
  ink-disabled: "rgba(255,255,255,0.62)"
  border: "color-mix(in srgb, #ffffff 10%, transparent)"
  border-strong: "color-mix(in srgb, #ffffff 15%, transparent)"
  border-interactive: "color-mix(in srgb, #ffffff 35%, transparent)"
  hairline: "color-mix(in srgb, #ffffff 8%, transparent)"
  success: "#72b875"
  danger: "#ff6467"
  danger-wash: "color-mix(in srgb, #ff6467 14%, transparent)"
  lint-warning: "#e1af4a"
  component: "#c09aeb"
  guide: "#f14445"
  focus-core: "#0c1014"
  focus-halo: "#ffffff"
  scrim: "rgba(12,16,20,0.7)"
  # Light theme. Source: the same PALETTE rows, light column.
  light-primary: "#3849da"
  light-primary-hover: "color-mix(in srgb, #0c1014 14%, #3849da)"
  light-primary-soft: "#ebf1ff"
  light-surface: "#ffffff"
  light-secondary: "#f0f2f5"
  light-secondary-hover: "#dce0e5"
  light-muted: "#f8f9f9"
  light-border: "#e9edf0"
  light-ink: "#0c1014"
  light-ink-dim: "#5f6670"
  light-success: "#0e6c34"
  light-danger: "#c8000a"
  light-lint-warning: "#8d5f00"
  light-component: "#6e4c96"
  light-guide: "#d73337"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "SF Pro", ui-sans-serif, system-ui, sans-serif'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.333
  value:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "SF Pro", ui-sans-serif, system-ui, sans-serif'
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.333
  section:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "SF Pro", ui-sans-serif, system-ui, sans-serif'
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.333
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "SF Pro", ui-sans-serif, system-ui, sans-serif'
    fontSize: 12px
    fontWeight: 650
    lineHeight: 1.333
    letterSpacing: -0.01em
  body-relaxed:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "SF Pro", ui-sans-serif, system-ui, sans-serif'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.625
  eyebrow:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "SF Pro", ui-sans-serif, system-ui, sans-serif'
    fontSize: 10px
    fontWeight: 600
    letterSpacing: 0.08em
  micro:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "SF Pro", ui-sans-serif, system-ui, sans-serif'
    fontSize: 10px
  code:
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'
    fontSize: 12px
    lineHeight: 1.55
rounded:
  xs: 4px
  sm: 8px
  md: 10px
  lg: 12px
  2xl: 14px
  3xl: 16px
  5xl: 18px
  6xl: 22px
  7xl: 26px
spacing:
  3xs: 2px
  2xs: 4px
  xs: 6px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  2xl: 24px
  3xl: 28px
  4xl: 32px
  5xl: 40px
components:
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    width: 240px
  panel-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-ink}"
  inspector:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    width: 260px
  panel-header:
    height: 44px
  tab-bar:
    height: 40px
  tab-selected:
    backgroundColor: "{colors.tab-selected}"
    textColor: "{colors.ink}"
  tab-selected-light:
    backgroundColor: "{colors.light-secondary}"
    textColor: "{colors.light-ink}"
  section-header:
    height: 32px
  section-eyebrow:
    textColor: "{colors.ink-dim}"
    typography: "{typography.eyebrow}"
  row:
    height: 24px
    typography: "{typography.body}"
  row-hover:
    backgroundColor: "{colors.surface-hover-quiet}"
    textColor: "{colors.ink}"
  row-hover-light:
    backgroundColor: "{colors.light-muted}"
    textColor: "{colors.light-ink}"
  row-selected:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.ink}"
  row-selected-muted:
    backgroundColor: "{colors.primary-soft-muted}"
    textColor: "{colors.ink}"
  row-selected-light:
    backgroundColor: "{colors.light-primary-soft}"
    textColor: "{colors.light-ink}"
  control-disabled:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-disabled}"
  field:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    height: 24px
  field-hover:
    backgroundColor: "{colors.surface-hover-quiet}"
  field-light:
    backgroundColor: "{colors.light-secondary}"
    textColor: "{colors.light-ink}"
  field-light-hover:
    backgroundColor: "{colors.light-border}"
  field-placeholder-light:
    backgroundColor: "{colors.light-border}"
    textColor: "{colors.light-ink-dim}"
  segmented-track:
    backgroundColor: "{colors.surface-sunken}"
    rounded: "{rounded.lg}"
  segmented-selected:
    backgroundColor: "{colors.segment-selected}"
    textColor: "{colors.ink}"
  segmented-selected-light:
    backgroundColor: "{colors.light-secondary-hover}"
    textColor: "{colors.light-ink}"
  button-primary:
    backgroundColor: "{colors.primary-fill}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.2xl}"
  button-primary-hover:
    backgroundColor: "{colors.primary-fill-hover}"
    textColor: "{colors.on-primary}"
  button-primary-light:
    backgroundColor: "{colors.light-primary}"
    textColor: "{colors.on-primary}"
  button-primary-light-hover:
    backgroundColor: "{colors.light-primary-hover}"
    textColor: "{colors.on-primary}"
  button-danger-ghost-hover:
    backgroundColor: "{colors.danger-wash}"
  tool-button:
    size: 28px
  toolbar:
    height: 36px
  mini-button:
    size: 18px
  popover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.3xl}"
  popover-item-hover:
    backgroundColor: "{colors.surface-raised-hover}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  modal:
    rounded: "{rounded.5xl}"
  tooltip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    typography: "{typography.body}"
  code-block:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    padding: 8px
  link-accent:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary-text}"
  status-success:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.success}"
  status-success-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-success}"
  status-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
  status-danger-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-danger}"
  status-lint-warning:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.lint-warning}"
  status-lint-warning-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-lint-warning}"
  component-name:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.component}"
  component-name-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-component}"
  canvas-guide:
    textColor: "{colors.guide}"
  canvas-guide-light:
    textColor: "{colors.light-guide}"
  icon-marker:
    size: 12px
  icon-inline:
    size: 14px
  icon-action:
    size: 16px
  icon-chrome:
    size: 18px
  icon-header:
    size: 20px
  icon-feature:
    size: 24px
---

# Design Layer editor

Rules for the editor chrome (`src/`), its keyboard behavior and its icons. The
landing page has its own file, `landing/DESIGN.md`; it reuses this file's indigo
(`primary`, `primary-fill`, `primary-text`) and nothing else.

`src/core/tokens.ts` is the source of truth. The frontmatter copies it; if the
two disagree, the code wins and this file is stale. A newer rule replaces the
older line in place, so the file never holds two answers for one property.

## Overview

The editor floats in front of someone else's product. Every panel is a
card-family surface beside the app, never a page of its own. The density is a
Figma-style editor's: 12px UI text, 24px rows, two resizable columns (240px
layers, 260px inspector). Values are adopted from the design foundations kit
(cool neutrals, near-white ladder, chrome washes, indigo focus and selection,
radius ladder, elevation and motion vocabulary) at that density.

Two themes, switched by `data-de-theme`. Only colors change between them;
icon, size, type, radius, space, duration and ease are theme-invariant. Dark is
the default and the fallback for every `var(--de-color-*)` reference.

## Colors

Source: `src/core/tokens.ts:41-98` (theme literals) and `:111-302` (the
`PALETTE.color` role table). Tokens without a prefix are the dark theme; the
`light-` tokens are the light column of the same role.

- **Indigo (`primary` #798cff, light `light-primary` #3849da):** strokes,
  handles, focus rings, the active tool. The one accent.
- **Indigo fill (`primary-fill` #4a5df9):** a filled accent surface. Always
  paired with `on-primary` white (4.97:1 dark, 6.7:1 light); `accentFill` and
  `accentFillText` in `tokens.ts` emit both properties so the pair cannot split.
- **Indigo word (`primary-text` #90a3ff):** the accent as text on a panel.
- **Selected container (`primary-soft`, light `light-primary-soft` #ebf1ff):**
  a selected row or chosen icon plate. Selection is a hue, never another grey.
- **Ground (`surface` #171717, light #ffffff):** every panel. Raised, sunken and
  hover steps are paper washes over it (`color-mix` with white at 6-16%).
- **Ink ladder:** `ink` #fafafa, `ink-muted` 75%, `ink-dim` 70%,
  `ink-disabled` 62%. Disabled ink still clears 4.5:1 on the worst ground.
- **Lines:** `border` (dividers), `border-strong` (panel edge), `border-interactive`
  (a control's boundary, 3:1 per WCAG 1.4.11), `hairline` (card outline).
- **Status:** `success`, `danger`, `lint-warning` (a design-system violation,
  deliberately not `danger`), `component` (component names), `guide` (canvas
  guides and measurements).
- **Canvas focus ring:** `focus-core` inside `focus-halo`, fixed in both themes
  because the ring sits over product pixels.

## Typography

Source: `src/core/tokens.ts:534-538` (`font`) and `:549-584` (`type`).

The UI face is the system stack (SF Pro on a Mac); code is the system mono.
The workhorse is 12px with 16px leading (`lineHeight: 1.333`); the floor is
10px for marks only (counts, type tags, eyebrows), never prose. There is no
11px step. To make text stand out, change its color or weight, not its size by
a pixel. Weights: 400 body, 500 values, 600 section headers, 650 titles.
Sentences cap at a `62ch` measure. A single line centered in its own box uses
`lineHeight: 1` (`leadingFlush`).

## Layout

Source: `src/core/tokens.ts:593-613` (`space`) and `:633-700` (`size`).

Layout moves in whole 4px steps; the 2px step (`3xs`) is for micro gaps only.
There is no 10px, 14px or 18px step. The left panel starts at 240px, the
inspector at 260px; both drag between a minimum (180px, 200px) and a share of
the window (0.34, 0.38), and the canvas keeps at least 320px. A double-click on
the seam resets the default width. Panels are inset 12px; the seam's grab strip
is 8px; handles, guides and the marquee share one 1px hairline.

## Elevation & Depth

Source: `src/core/tokens.ts:507-533` (`shadow` geometry) and `:321-328`
(`PALETTE.shadow` tints, dark / light).

Docked panels have no shadow: a hairline is their whole boundary. Only surfaces
that float get a cast. Geometry is fixed; only the tint follows the theme.

| Tier | Recipe | Use |
| --- | --- | --- |
| popover | `0 14px 44px cast, 0 0 0 1px ring, inset 0 1px 0 rim` | menus, popovers, floating cards |
| float | `0 18px 56px castSoft, 0 0 0 1px ring, inset 0 1px 0 rim` | toolbar pill, launcher, drag ghost |
| tooltip | `0 10px 30px castTooltip` | the inverse tooltip chip |
| marker | `0 2px 6px rgba(0, 0, 0, 0.2), inset 0 0 0 1px rgba(0, 0, 0, 0.04)` | note pins over the app (not themed) |

Tints: `cast` rgba(0,0,0,0.36) / rgba(0,0,0,0.12); `castSoft` 0.42 / 0.13;
`castTooltip` 0.36 / 0.16; `ring` = `hairline`; `rim` paper 10% in dark, none
in light. A modal sits on `scrim`, a static 70% veil, never blurred.

## Shapes

Source: `src/core/tokens.ts:471-492` (`radius`, `cornerShape`).

| Token | Value | Use |
| --- | --- | --- |
| xs | 4px | swatches, tiny chips, arrow tips |
| sm | 8px | small controls, glyph plates, mini buttons |
| md | 10px | menu items (concentric in a 16px menu with 6px padding) |
| lg | 12px | the default: segmented tracks, row highlights, tooltips |
| 2xl | 14px | action buttons; every text button is one family |
| 3xl | 16px | cards, menus, popovers, floating panels |
| 5xl | 18px | modals, dialogs, overlay windows |
| 6xl, 7xl | 22px, 26px | large cards, the composer |

Every corner is a squircle (`corner-shape: superellipse(2)`). A circle or pill
is written `50%` / `999px` at the call site and opts out with
`corner-shape: round`. Nested corners are concentric: inner = outer − inset,
where the inset counts the border; `nest()` in `tokens.ts` throws when the inner
corner is not a rung (`test/concentric-cases.mjs` checks the emitted CSS).

## Components

Source: `src/core/tokens.ts:633-700` (`size`), `:619-632` (`icon`), and the
role comments in `PALETTE.color`. The frontmatter lists each component in dark,
with a `-light` variant where the light theme changes its colors.

- **Panels and rows:** 24px rows and fields, 32px section headers, 40px tab
  strips, a 44px app-chooser header. A hovered row takes `surface-hover-quiet`;
  a selected row takes `primary-soft`, half strength when focus is elsewhere.
- **Fields:** filled, no resting border (`surface-sunken`), one rung darker on
  hover.
- **Segmented control:** the selected segment is a darker fill with no shadow
  and no hairline, because it is not nearer the light than its track.
- **Toolbar:** 36px tall, 28px pointer-first tool targets. Mini buttons
  (trailing row actions) are 18px.
- **Tooltip:** inverse (`ink` fill, `surface` text), 12px text, 6px × 12px
  padding on a `lg` corner, 6px off its control. Opens instantly; exits in
  150ms.
- **Icons:** six sizes only, from `tokens.icon`: marker 12, inline 14, action
  16 (the default), chrome 18, header 20, feature 24. `IconSize` in
  `src/core/icons.ts` makes any other size a type error. Stroke per rung comes
  from `STROKE_FOR_SIZE` (`src/core/icons.ts:78-85`): 12 → 0.5, 14 → 0.3,
  16 → 0.15, 18/20/24 → 0, added to the 24-viewBox base line.
- **Motion** (`src/core/tokens.ts:702-727`): durations hover 150ms, exit 150ms,
  reveal 250ms, resize 320ms; easings `ease` cubic-bezier(0.32, 0.72, 0, 1),
  `easeReveal` cubic-bezier(0.22, 1, 0.36, 1), `easeExit`
  cubic-bezier(0.4, 0, 1, 1), and `easeSpring` cubic-bezier(0.34, 1.2, 0.64, 1)
  for a direct-manipulation payoff only. Menus and tooltips open instantly.

## Do's and Don'ts

Each rule: the property, its value or constraint, where it applies, who set it,
and the check that enforces it when one exists.

### Icons

- Icon source: every new editor glyph comes from Phosphor (https://phosphoricons.com, regular weight; fill weight only for a toggle's on state), mapped by name in `tools/build-icons.mjs` and never hand-drawn or taken from another set. Phosphor has no picture for a subject → draw it in Phosphor's construction (16-unit line, round caps, 256 grid) as an `add` recipe. Scope: editor chrome (`src/`). Source: Phil, 2026-10-05.
- Icon style and optical size: keep the chrome's treatment, not Phosphor's defaults — one 24 viewBox (never re-windowed), sizes only from the `tokens.icon` ramp (12, 14, 16, 18, 20, 24), the rung stroke table in `STROKE_FOR_SIZE` (1px minimum line at 12px), pressed/selected half a unit heavier, and a `scale` on any glyph whose ink extent strays more than about 10% from its peers or the glyph it replaces (check with `node tools/icon-sticker-sheet.mjs`). Scope: editor chrome. Source: Phil, 2026-10-05.
- Kept drawings: the bottom toolbar marks except the pointer (MessageSquare, Grid2x2, ToolUndo, ToolRedo, Sun, Moon, ToolClose, PanelLeft, PanelRight), ExternalLink, the six object-align marks and Trash keep their pre-Phosphor artwork (`tools/icons/legacy-glyphs.json`). Do not swap them or add to that list without asking. Scope: editor chrome. Source: Phil, 2026-10-05. Checked by `test/icon-cases.mjs`.

### Keyboard

- Show/hide the editor (⌘.): works wherever focus is, in every prototype — a text field (the app's or the editor's), a same-origin frame on the page (including a hidden one that took focus by itself), the Mac app's tab strip, a collapsed editor, and after the page reloads itself inside the Mac app. Answer it only in `src/shell/way-back.ts` (the `everywhere` row in `src/core/keymap.ts`); never gate it on text entry or on the chrome being shown, and never answer it in a second listener, which toggles twice. Scope: editor chrome, the proxy's overlay injection (`runtime/board-frame.mjs`) and the Mac app shell. Source: Phil, 2026-10-06. Checked by `test/shortcut-cases.mjs`, `test/board-frame-cases.mjs`, `desktop/mac/test/desk-cases.mjs`, and against a running app by `node tools/shortcut-e2e.mjs --app <port> --root <dir>`.

## Iteration Guide

1. Load the `capture-design-rule` skill when Phil states a rule or repeats a
   correction.
2. A value change (color, radius, size, type) goes in `src/core/tokens.ts`
   first, then into the frontmatter here with the same value.
3. A constraint ("never", "only") goes under Do's and Don'ts as one line:
   property, value, scope, source (who, date), and its check. Edit an older line
   in place instead of adding a second one.
4. Run `npx -y @google/design.md lint DESIGN.md`. Keep 0 errors and no
   broken-ref or contrast warnings.
5. Run `node test/design-md-cases.mjs`: it fails when a frontmatter value
   differs from `tokens.ts` or has no row in its mapping table. A new token
   gets a row there. Then run `npm run build && npm test`.

## Known Gaps

- The format holds one theme per token. The dark theme is unprefixed; the
  light theme uses `light-` tokens and `-light` component variants. Light
  roles that equal a dark-theme literal (white `on-primary`, `focus-core`) are
  not repeated.
- Light roles built from ink washes (`textMuted` 80%, `textDisabled` 64%,
  `borderStrong` 26%, `borderInteractive` 48%, `hairline` 7%) and the light
  `rowSelectedMuted` mix stay in `tokens.ts` only.
- Code-tab syntax tints (`PALETTE.code`, `src/core/tokens.ts:308-314`) and
  scrollbar thumbs (`:218-219`) stay in source only; each serves one surface.
- Components list only properties the source states. Text weight for
  buttons, fields and headers, and the modal's fill, are set per stylesheet in
  `src/core/css/` and are not tokens here.
- Font stacks are copied with their quotes; YAML single quotes wrap them.
- Shadows, motion and icon strokes have no token group in the format; they live
  in prose above with their source lines.
- Lint reports ten orphaned-token warnings, all expected: `primary-halo`,
  `selection`, `border`, `border-strong`, `border-interactive`, `hairline`,
  `focus-core`, `focus-halo` and `scrim` are rings, outlines, washes and veils,
  and the format's component properties have no border, outline or overlay
  slot to reference them from. `ink-muted` (secondary ink) has no single
  component in the source to pin it to.
- `button-danger-ghost-hover` sets only its wash: the wash is translucent and
  the linter does not composite it over the ground, so pairing it with
  `danger` ink reads as 1:1. On screen the ink sits on `surface` under a 14%
  wash (see `status-danger` for the ink's contrast).
