# Design rules

One rule per line: the property, its value or constraint, where it applies, and
who set it. A newer statement replaces the older line. The landing page has its
own rules in `landing/DESIGN.md`.

## Icons

- Icon source: every new editor glyph comes from Phosphor (https://phosphoricons.com, regular weight; fill weight only for a toggle's on state), mapped by name in `tools/build-icons.mjs` and never hand-drawn or taken from another set. Phosphor has no picture for a subject → draw it in Phosphor's construction (16-unit line, round caps, 256 grid) as an `add` recipe. Scope: editor chrome (`src/`). Source: Phil, 2026-10-05.
- Icon style and optical size: keep the chrome's treatment, not Phosphor's defaults — one 24 viewBox (never re-windowed), sizes only from the `tokens.icon` ramp (12, 14, 16, 18, 20, 24), the rung stroke table in `STROKE_FOR_SIZE` (1px minimum line at 12px), pressed/selected half a unit heavier, and a `scale` on any glyph whose ink extent strays more than about 10% from its peers or the glyph it replaces (check with `node tools/icon-sticker-sheet.mjs`). Scope: editor chrome. Source: Phil, 2026-10-05.
- Kept drawings: the bottom toolbar marks except the pointer (MessageSquare, Grid2x2, ToolUndo, ToolRedo, Sun, Moon, ToolClose, PanelLeft, PanelRight), ExternalLink, the six object-align marks and Trash keep their pre-Phosphor artwork (`tools/icons/legacy-glyphs.json`). Do not swap them or add to that list without asking. Scope: editor chrome. Source: Phil, 2026-10-05. Checked by `test/icon-cases.mjs`.

## Keyboard

- Show/hide the editor (⌘.): works wherever focus is, in every prototype — a text field (the app's or the editor's), a same-origin frame on the page (including a hidden one that took focus by itself), the Mac app's tab strip, a collapsed editor, and after the page reloads itself inside the Mac app. Answer it only in `src/shell/way-back.ts` (the `everywhere` row in `src/core/keymap.ts`); never gate it on text entry or on the chrome being shown, and never answer it in a second listener, which toggles twice. Scope: editor chrome, the proxy's overlay injection (`runtime/board-frame.mjs`) and the Mac app shell. Source: Phil, 2026-10-06. Checked by `test/shortcut-cases.mjs`, `test/board-frame-cases.mjs`, `desktop/mac/test/desk-cases.mjs`, and against a running app by `node tools/shortcut-e2e.mjs --app <port> --root <dir>`.
