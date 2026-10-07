#!/usr/bin/env node
/**
 * The interfaces.dev cheat-sheet pass, rendered as a page you decide from.
 *
 * Third of the before/after tools, and it exists because the other two cannot
 * answer this question. `before-after.mjs` compares the start screen at two git
 * revisions; `chrome-demo.mjs` compares the editor's panels at two git
 * revisions. Both take their "before" out of git — and this pass was made on
 * top of a working tree with a hundred uncommitted files in it, so there is no
 * revision that is the before. A `git stash` would have taken the rest of that
 * work with it.
 *
 * So the before is a COPY of `src/`, `runtime/` and `tools/` taken before the
 * first edit of this pass, sitting in `.worktrees/cheatsheet-before/`. Same
 * mechanism as the git worktree in the sibling tool — a second tree, bundled
 * separately, touching the working tree not at all — with the snapshot standing
 * in for the revision.
 *
 *   node tools/cheatsheet-demo.mjs
 *   node tools/cheatsheet-demo.mjs --open
 *   node tools/cheatsheet-demo.mjs --only=toast-close,marquee
 *
 * Output lands in `.demos/cheatsheet/`, which is gitignored.
 */

import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT = path.join(ROOT, ".demos", "cheatsheet")
const BEFORE = path.join(ROOT, ".worktrees", "cheatsheet-before")

const args = process.argv.slice(2)
const flags = new Set(args)
const only = (args.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length)
const wanted = only ? new Set(only.split(",")) : null

/* ------------------------------------------------------------------ */
/* The scenes                                                          */
/* ------------------------------------------------------------------ */

/**
 * One row of the page: what changed, which cheat-sheet rule it answers, how the
 * shot is produced, and what to measure that a screenshot cannot show.
 *
 * `drive` runs inside the rendered page against whichever bundle built it, so
 * it may only touch what both bundles have. Anything one side lacks has to
 * degrade rather than throw — a labelled empty panel is worth more than a
 * missing column.
 */
const SCENES = [
  {
    id: "toast-close",
    rule: "CO-2 · CO-5",
    severity: "low",
    title: "The dismiss on an error toast — a finding that measured out",
    why:
      "The colour audit called this HIGH: the hovered ✕ takes Sonner's --gray2, hsl(0,0%,97.3%), " +
      "while the glyph takes --normal-text, which this chrome points at color.text. White on " +
      "near-white is 1.06:1, on the one control that can clear a card DURATION.error never " +
      "dismisses. Measured on the rendered card it is 20.97:1 in dark and 16.39:1 on paper — " +
      "the two halves cannot hold those values at once, because --normal-text is only white in " +
      "the dark theme and in the dark theme Sonner ships a second rule that re-points the plate " +
      "at --normal-bg-hover, which this file already themes. An override was written, measured, " +
      "and taken back out; the argument is now a comment in css/toast.ts so it is not re-found. " +
      "Nothing changed here. It is on the page because a disproved finding is a result.",
    scene: "toast",
    theme: "light",
    viewport: { width: 440, height: 160 },
    hoverShadow: "#close",
    probe: "toastContrast",
  },
  {
    id: "toast-focus",
    rule: "CO-5 · A11Y-2",
    severity: "high",
    title: "The same card, reached by keyboard",
    why:
      "Sonner's focus rings are rgba(0,0,0,0.2) and rgba(0,0,0,0.4) — black halos composited over " +
      "a #4a4a4a card, well under the 3:1 WCAG 1.4.11 asks of an indicator. The card's own ring " +
      "was focusHalo, which is fixed white in both themes because it belongs to the note pin: " +
      "on paper that is a white ring on a white card. All three are accent now, so focus looks " +
      "the same on the card, its action and its dismiss.",
    scene: "toast",
    theme: "dark",
    viewport: { width: 440, height: 160 },
    focusShadow: "#action",
    probe: "toastRing",
  },
  {
    id: "marquee",
    rule: "CO-1 · CO-5",
    severity: "high",
    title: "Dragging a selection box over the page",
    why:
      "accentSoft was deliberately made opaque so a selected layer row reads the same " +
      "everywhere — the right call for a row in a panel, and the exact opposite of what an " +
      "overlay drawn over the product needs. selectionSurface is documented as 'the canvas " +
      "overlay's wash' and had no canvas call site at all.",
    scene: "marquee",
    theme: "light",
    viewport: { width: 460, height: 260 },
  },
  {
    id: "lint-severity",
    rule: "A11Y-14",
    severity: "high",
    title: "Two severities, as someone with deuteranopia sees them",
    why:
      "The panel said error-or-warning with hue alone. Its own sibling, the canvas badge in " +
      "css/lint-markers.ts, states the rule it was breaking: severity is 'hue AND corner, never " +
      "hue alone'. The badge's 4px/8px corners cannot be borrowed at 8px — radius.xs IS 50% at " +
      "that size — so the pair is the two endpoints instead: a square and a disc.",
    scene: "lintRows",
    theme: "dark",
    viewport: { width: 340, height: 180 },
    filter: "deuteranopia",
  },
  {
    id: "select-focus",
    rule: "A11Y-2",
    severity: "high",
    title: "Tabbing onto a dropdown in the inspector",
    why:
      "appearance: none strips the platform's focus ring, and the only replacement was a 1px " +
      "border going from transparent to accent — thinner than the 2px the rest of the chrome " +
      "draws, and on the same channel the control already uses for hover. The start screen met " +
      "this exact bug on its own select and fixed it; the inspector never got the pass.",
    scene: "selectFocus",
    theme: "dark",
    viewport: { width: 300, height: 120 },
    tab: true,
  },
  {
    id: "button-press",
    rule: "AN-5",
    severity: "medium",
    title: "The shared text button, held down",
    why:
      ".de-tool already carries a press scale and the argument for it — 'the only feedback for " +
      "the press itself was the state arriving, which is indistinguishable from a click that " +
      "missed'. .de-button labels the actions that write files and delete rows, and answered a " +
      "press with nothing at all.",
    scene: "buttons",
    theme: "dark",
    viewport: { width: 340, height: 150 },
    hold: "#glyph-button",
  },
  {
    id: "button-padding",
    rule: "UI-3",
    severity: "medium",
    title: "Padding on the icon side of a button",
    why:
      "A 12px glyph carries its own optical clearance, so equal padding reads as more air on " +
      "the icon side than on the word side. One :has() rule, no call site touched. It is a " +
      "whole step down rather than the nudge the sheet asks for because the kit's spacing ramp " +
      "goes 2, 4, 8 — the 6px this wants does not exist, and token-cases.mjs rejects it.",
    scene: "buttons",
    theme: "dark",
    viewport: { width: 340, height: 150 },
    zoom: 3,
    probe: "buttonPadding",
  },
  {
    id: "launcher-light",
    rule: "UI-4",
    severity: "medium",
    title: "The launcher on a light page",
    why:
      "shadow.float was the only single-layer depth token, so each of its three users solved " +
      "the edge separately: two added a real border, the third had no edge at all. A real " +
      "border on a 44px circle has to be rasterised around the whole circumference and grows " +
      "the disc to 46. The second layer is popover's own ring — reuse, not invention.",
    scene: "launcher",
    theme: "light",
    page: "#ffffff",
    viewport: { width: 200, height: 200 },
    zoom: 2,
  },
  {
    id: "launcher-dark",
    rule: "UI-4",
    severity: "medium",
    title: "The same disc on a dark page",
    why:
      "The harder half: a page whose colour sits near the chrome's own ground is where a soft " +
      "cast fades to nothing and leaves the surface with no boundary. This is the case a float " +
      "surface is most exposed to, because the page under it belongs to someone else.",
    scene: "launcher",
    theme: "dark",
    page: "#242424",
    viewport: { width: 200, height: 200 },
    zoom: 2,
  },
  {
    id: "arrive-origin",
    rule: "AN-1",
    severity: "high",
    title: "A menu opening above its trigger, caught mid-entrance",
    why:
      "The shared entrance had no transform-origin — so every card grew from its own centre — " +
      "and a fixed translateY(-3px), so every card also drifted downward. Three of the four " +
      "surfaces using it flip above the trigger when dropping down would overrun the viewport, " +
      "and in that case the card entered travelling away from the control that opened it. The " +
      "tooltip had already solved this for itself and the solution was never generalised.",
    scene: "arriveAbove",
    theme: "dark",
    viewport: { width: 340, height: 250 },
    probe: "arriveOrigin",
  },
  {
    id: "swap-blur",
    rule: "AN-6",
    severity: "low",
    title: "A copy glyph turning into a tick, halfway through",
    why:
      "The crossfade had opacity and scale and no blur, so at the midpoint two drawings of the " +
      "same size sit on top of each other and read as one glyph struck twice. 4px is the " +
      "chrome's existing pop blur, not a fourth number. Shown at 6x — the whole thing is 16px. " +
      "The before column has no midpoint to show, and that is the larger half of this finding: " +
      "the stroke-weight rule in css/icons.ts is (0,2,1) against this rule's (0,1,1), and " +
      "transition is a shorthand — so it was not adding a property to the list, it was replacing " +
      "it. The crossfade was in the stylesheet and had never once run.",
    scene: "swap",
    theme: "dark",
    viewport: { width: 260, height: 160 },
    swap: true,
    probe: "swapTransition",
  },
  {
    id: "measure",
    rule: "TY-3",
    severity: "medium",
    title: "Prose in a panel dragged wide",
    why:
      "Panels resize to 38% of the viewport, so an uncapped line runs about 87 characters on a " +
      "1440px display and about 155 on a 2560 — the reader with the biggest screen gets the " +
      "least readable prose. 62ch was already in the codebase once, written by hand on the " +
      "shortcuts note; it is a token now and six prose rungs read it.",
    scene: "measure",
    theme: "dark",
    viewport: { width: 800, height: 260 },
    probe: "measureWidth",
  },
  {
    id: "handles",
    rule: "A11Y-9",
    severity: "high",
    title: "The resize handles on a sliver, with their hit boxes drawn",
    why:
      "Handles read as 7px and grab at 13, centred on the edges — so on an element narrower " +
      "than 13 the left and right corners overlap and both are live. Middle handles were " +
      "already suppressed under 24px; corners never were. This is the clause of the hit-area " +
      "rule with no user workaround: a target that is too small can be zoomed into or aimed at " +
      "twice, and two targets on one pixel can only be resolved by whichever the hit test " +
      "reaches first. The dashed boxes are the targets, not the drawing.",
    scene: "handles",
    theme: "light",
    viewport: { width: 300, height: 280 },
    zoom: 2,
    crowdRule: true,
    probe: "handleOverlap",
  },
  {
    id: "escape-stop",
    rule: "A11Y-15",
    severity: "medium",
    title: "The keyboard's first stop in the editor",
    why:
      "The brief asked for a skip link and the premise inverts here: the chrome is appended to " +
      "<body>, so it is LAST in tab order and there is nothing behind it to skip to. The real " +
      "gap is the mirror image — no way IN (⇧⌘1 now focuses the toolbar) and no way back out " +
      "short of tabbing through forty stops. This is the way out, clipped until focused. " +
      "Before: no such control, which is why that column is empty.",
    scene: "escapeStop",
    theme: "dark",
    viewport: { width: 540, height: 130 },
    probe: "escapePresence",
  },
  {
    id: "row-gap",
    rule: "LA-2",
    severity: "medium",
    title: "Two fields in a group, two groups in a stack",
    why:
      "gap: 8px set the row gap AND the column gap, and 8px is also what goes BETWEEN groups — " +
      "so the gutter between X and Y was the same distance as the gap from the whole Position " +
      "group to the whole Size group. Nothing in the rhythm said which pair belonged together. " +
      "The column gap drops to 4px, which is not a new number: it is what .de-paint-row " +
      "already puts between two adjacent wells.",
    scene: "rowGap",
    theme: "dark",
    viewport: { width: 300, height: 240 },
    probe: "gapRatio",
  },
  {
    id: "native-furniture",
    rule: "CO-7",
    severity: "medium",
    title: "The half of the chrome the palette cannot reach",
    why:
      "Forty-six custom properties say what the editor paints and nothing said what the USER " +
      "AGENT paints inside it — so scrollbars, checkboxes and select popups followed the host " +
      "page or the OS. The old workaround was an unconditional filter: invert(1) on the search " +
      "field's clear button, right in dark and a white ✕ on a white field in light. Declaring " +
      "color-scheme lets that be deleted rather than patched.",
    scene: "nativeFurniture",
    theme: "light",
    viewport: { width: 340, height: 280 },
  },
]

/** Start-screen scenes, which need no bundle — the page is a pure function. */
const START_SCENES = [
  {
    id: "start-labels",
    rule: "WR-5 · TY-7",
    severity: "medium",
    title: "The first screen of the product",
    why:
      "APP ADDRESS and CODE FOLDER, on the card a person meets before anything else — while a " +
      "field label in the inspector twenty seconds later reads 'Font weight'. Uppercase is a " +
      "rank, and it was being spent on labels that are not a tier above the fields they name. " +
      "The rank they need is already carried by weight and tint.",
    viewport: { width: 900, height: 760 },
    drive: "",
  },
  {
    id: "start-press",
    rule: "AN-5",
    severity: "medium",
    title: "Start editing, held down",
    why:
      "Pressing this posts to the loopback server, waits for a dev server to come up, then " +
      "navigates — seconds on a cold start, and for the first of them nothing on screen changed " +
      "at all. The busy state arrives later and through a different channel.",
    viewport: { width: 900, height: 760 },
    drive: "",
    hold: "#submit",
  },
  {
    id: "start-app-names",
    rule: "TY-10",
    severity: "high",
    title: "Two dev servers that share a prefix",
    why:
      "Picking the right app is the only question this screen asks, and .app-name ellipsises " +
      "with nothing behind the cut. Two servers out of one monorepo are routinely the same " +
      "eighteen visible characters, so the ellipsis falls exactly where the difference is. The " +
      "editor's own app chooser fixed this and documented it; this screen ships the same row.",
    viewport: { width: 900, height: 820 },
    apps: [
      { url: "http://127.0.0.1:3000", port: 3000, title: "Acme Design System", projectRoot: "/Users/you/Projects/acme-design-system" },
      { url: "http://127.0.0.1:3001", port: 3001, title: "Acme Design System Docs", projectRoot: "/Users/you/Projects/acme-design-system-docs" },
    ],
    drive: "",
    probe: "appTitles",
  },
]

/* ------------------------------------------------------------------ */
/* Every rule, and what happened to it                                 */
/* ------------------------------------------------------------------ */

/**
 * The whole sheet, so the page is a result and not a highlight reel.
 *
 * Seventeen scenes above are the rules that MOVED. The other forty-three
 * matter just as much to a decision: some were already met, several were met
 * with an argument in the source better than the rule, and four cannot be met
 * here for a reason worth knowing. A page that showed only the changes would
 * invite the same audit again next quarter.
 *
 * `state` is one of:
 *   changed  — a scene above shows it
 *   met      — already true, with the file that makes it so
 *   argued   — the codebase does the opposite, deliberately, and is right
 *   blocked  — the fix was attempted and something better stopped it
 *   n/a      — the product has nothing this rule applies to
 *   open     — real, unfixed, and named so it is not lost
 */
const VERDICTS = [
  ["UI-1", "Concentric radius", "met", "test/concentric-cases.mjs sweeps every rule declaring a radius and a padding together. Its three blind spots — inline style radii, the shadow-root toast sheet, the start screen — are real and unclosed."],
  ["UI-2", "Optical alignment", "changed", "The launcher's Cursor glyph was centred on its bounding box while its ink sat 6.3% up and left — measured by rasterising every glyph and taking the alpha-weighted centroid. It is five times further off than anything else in the set (Plus 0.4%, Search 0.9%, Check 0.5%), which is why it gets one rule rather than the whole set getting a centroid pipeline."],
  ["UI-3", "Icon-side padding", "changed", ""],
  ["UI-4", "Layered shadow over a border", "changed", ""],
  ["UI-5", "1px outline on images", "n/a", "The chrome renders no raster images. The report pages this tool writes now do carry it."],
  ["UI-6", "Icon stroke matches its text", "blocked", "Five field-label glyphs stroke at 1.5px beside 1.0px text. Moving them to icon.marker was tried; icon-cases.mjs rejected it, because the native family only lands on whole pixels at 16, 24 and 32 and resolves to four or six ink levels at 12. A blurrier glyph is a worse answer than a heavier one. The fix is a 12px redrawing."],
  ["AN-1", "Animate from the trigger", "changed", ""],
  ["AN-2", "Skip the open on frequent menus", "changed", "The layer menu opens AT THE POINTER, so the question an entrance answers — where did this come from — was never asked, and 180ms of spring sat in front of a list you are about to arrow through. Its entrance is deleted; the three cards that genuinely travel keep theirs, and keep the origin that now aims it. One class not added."],
  ["AN-3", "Exits subtler than entrances", "argued", "css/base.ts argues there are no exits at all, and why building them broke twelve cases across four surfaces. Where exits do exist they are already subtler."],
  ["AN-4", "Never transition: all", "met", "tools/motion-budget.mjs fails the build on a single occurrence."],
  ["AN-5", "Press scale 0.95–0.98", "changed", ""],
  ["AN-6", "Icon swap crossfades", "changed", ""],
  ["AN-7", "Transitions for interaction, keyframes for one-shots", "met", "Argued at css/tooltip.ts."],
  ["AN-8", "Kill transitions on a theme switch", "argued", "The chrome crossfades 46 @property-registered palette roles in one declaration on :root. The rule exists to prevent forty mismatched component transitions firing at once, which cannot happen when there is exactly one. The sophisticated form of the same goal."],
  ["AN-9", "will-change on shifting elements", "n/a", "The three paths that move animate left/top, width, and a transform on the host app's own element. will-change: transform is inert for the first two and harmful for the third."],
  ["AN-10", "Stagger entrances in groups", "met", "css/libraries.ts, half a snap per row, capped."],
  ["AN-11", "Nothing animates on load", "met", "travelling-surface.ts suppresses the first placement; the theme attribute is written in the mount task so the crossfade has no before value."],
  ["AN-12", "Frequent interactions stay instant", "met", "Hover and selection sit on snap (70ms). Sonner's 400ms enter is pulled back to drawer."],
  ["TY-1", "woff2 only", "n/a", "Both surfaces are system-font only. No webfont is loaded."],
  ["TY-2", "tabular-nums on changing values", "met", "Declared at the root of both surfaces with an inherit reset on form controls."],
  ["TY-3", "60–75 character measure", "changed", ""],
  ["TY-4", "balance on headings, pretty on descriptions", "met", ""],
  ["TY-5", "break-word and nowrap", "met", ""],
  ["TY-6", "Font smoothing at the root", "met", "Both surfaces, as a pair."],
  ["TY-7", "Normal capitalization", "changed", "The start screen's uppercase field labels — see the first-screen scene."],
  ["TY-8", "Smart punctuation", "met", "A character-level pass over 9,240 string literals found one offender, in a terminal log line rather than in the interface."],
  ["TY-9", "Underlines clear of descenders", "changed", "The chrome's one underline now takes from-font and skip-ink. Too small to photograph."],
  ["TY-10", "A way to the full text", "changed", "Six places cut text with nothing behind the cut; all six now have one. Two scenes above show the worst."],
  ["CO-1", "Every palette step has a purpose", "changed", "selectionSurface was documented as the canvas overlay's wash and had no canvas call site — see the marquee."],
  ["CO-2", "Semantic tokens, not primitives", "changed", "The Sonner override sheet stopped at the resting card; the focus rings still carried the vendor's own values."],
  ["CO-3", "Name tokens by purpose", "met", "tokens.ts is ~1,100 lines of exactly this argument."],
  ["CO-4", "accent means brand, not body text", "met", ""],
  ["CO-5", "Measure against the real ground", "changed", "And one claimed failure measured out — see the disproved finding."],
  ["CO-6", "A separate dark palette", "met", "Two blocks, recomputed, not inverted."],
  ["CO-7", "One theming mechanism", "changed", "One attribute, and now color-scheme under the same switch."],
  ["CO-8", "Name the gradient interpolation space", "met", "The five gradients all run colour-to-transparent, where premultiplied alpha already avoids the grey midpoint. Naming a space would change nothing."],
  ["A11Y-1", "Native elements", "changed", "The shortcuts sheet is a real <dialog> with showModal(). role, aria-modal, tabindex, the scrim element, its click handler and a 2147483400 z-index all deleted — the platform supplies the focus trap, the top layer, ::backdrop, the inertness and Escape that the hand-rolled version only claimed."],
  ["A11Y-2", "focus-visible with a replacement", "changed", "Three controls removed the outline and offered nothing: the inspector's select and the token picker's two inputs."],
  ["A11Y-3", "No positive tabindex", "met", "Zero in the codebase."],
  ["A11Y-4", "Icon-only buttons are named", "met", "tipAttrs writes the aria-label from the tooltip text, so the two cannot disagree."],
  ["A11Y-5", "Alt text", "n/a", "No authored <img>."],
  ["A11Y-6", "Visible labels, right type", "met", ""],
  ["A11Y-7", "Never block paste", "met", "No paste handler exists."],
  ["A11Y-8", "Validate on submit, describe the error", "changed", "Focus already moved to the first invalid field. The url input carried aria-invalid and no aria-describedby, so the one field with autofocus said it was wrong and nothing else."],
  ["A11Y-9", "Hit areas", "changed", "Corners on a collapsed axis are suppressed like the middles already were. A pixel shared by two live targets is the one hit-area failure a user cannot aim their way out of. Guarded now by a geometric case that fails without the fix."],
  ["A11Y-10", "pointer-events on decoration", "met", "38 declarations."],
  ["A11Y-11", "Hover inside @media (hover: hover)", "changed", "Three rules, not a blanket. The other 79 :hover rules change a tint, which sticks harmlessly after a tap; these three change an object's SIZE on a page the editor does not own, where a mark frozen at 110% reads as a fault in the app under review."],
  ["A11Y-12", "Respect reduced motion", "met", "An opt-out blanket rather than the sheet's opt-in, which is the safer inversion for chrome injected into someone else's page: a rule somebody forgets to wrap is still clamped. The JS half is handled too."],
  ["A11Y-13", "status for routine, alert for urgent", "changed", "Two armed-confirmation prompts were raised on the error rung, which never dismisses — so the card outlived the six-second window and went on instructing a second click that had stopped working."],
  ["A11Y-14", "Never colour alone", "changed", "The lint severity dot — see the deuteranopia scene."],
  ["A11Y-15", "Skip link first", "changed", "Both halves, and neither is a skip link. ⇧⌘1 focuses the toolbar (unhiding first, since a collapsed chrome cannot take focus), and a clipped-until-focused first stop collapses the editor to give the page its keyboard back."],
  ["LA-1", "scroll-margin-top on link targets", "met", "The one scrolled-to surface with a sticky header clears it."],
  ["LA-2", "Twice the space between groups", "changed", "The gap shorthand set row and column to 8px, and 8px is also what goes between groups — so two fields in one group sat as far apart as two whole groups. Column gap drops to 4px, which .de-paint-row already uses between adjacent wells."],
  ["WR-1", "Verb-first button labels", "changed", "A sentence was being used as a button label."],
  ["WR-2", "Confirmations say what will happen", "changed", "Deleting a single note was the last irreversible one-click action in the product, over the one thing on screen the user typed themselves. The row keeps its single click — a control used on most rows in a session cannot confirm every time — and the delete now names which note it took and offers it back."],
  ["WR-3", "One label per step", "met", ""],
  ["WR-4", "Describe where a link goes", "met", ""],
  ["WR-5", "Consistent capitalization", "changed", "Six British spellings, one Title-Cased heading, two uppercase field labels."],
  ["WR-6", "Toggles labelled positively", "changed", "A role=switch whose ON state produced invisible markers."],
  ["WR-7", "Empty states explain and offer an action", "met", "A prior pass closed these; re-checked against the current tree."],
  ["WR-8", "Address the reader as you", "met", ""],
]

/* ------------------------------------------------------------------ */
/* Building the two bundles                                            */
/* ------------------------------------------------------------------ */

async function bundleScene(treeRoot) {
  // The scene is authored in the working tree, so the before tree gets a copy —
  // it resolves `../src/...` relatively, which is the whole mechanism.
  const target = path.join(treeRoot, "tools", "cheatsheet-scene.js")
  if (treeRoot !== ROOT) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(ROOT, "tools", "cheatsheet-scene.js"), target)
  }
  const result = await build({
    entryPoints: [target],
    absWorkingDir: treeRoot,
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [path.join(ROOT, "node_modules")],
  })
  return result.outputFiles[0].text
}

async function loadPlaywright() {
  const localRequire = createRequire(path.join(ROOT, "package.json"))
  try {
    return localRequire("playwright")
  } catch {
    /* not a dependency here, which is the expected case */
  }
  let globalRoot = null
  try {
    globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim()
  } catch {
    /* npm may not be on PATH in a sandbox */
  }
  for (const root of [globalRoot, "/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"]) {
    if (!root) continue
    for (const anchor of ["@playwright/mcp/cli.js", "playwright/index.js"]) {
      try {
        return createRequire(path.join(root, anchor))("playwright")
      } catch {
        /* try the next one */
      }
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Probes — the facts a screenshot cannot carry                        */
/* ------------------------------------------------------------------ */

/**
 * Each probe runs after the shot, in the page, and returns rows of
 * `[label, value]`. A ratio computed here is computed from the RESOLVED colours
 * the browser actually painted, not from the token source — which is the only
 * way to catch a value that is right in the file and wrong once a `color-mix`
 * and a shadow boundary have had it.
 */
const PROBES = {
  toastContrast: `(() => {
    const host = document.querySelector("div[style*=padding]")
    const shadow = host && host.shadowRoot
    const close = shadow && shadow.querySelector("[data-close-button]")
    if (!close) return [["close button", "not found"]]
    const s = getComputedStyle(close)
    const r = window.__cheatsheet.ratio(s.color, s.backgroundColor)
    return [
      ["glyph", s.color],
      ["plate under the pointer", s.backgroundColor],
      ["contrast", r + ":1" + (r < 3 ? "  — under 3:1" : "  — clears 3:1")],
    ]
  })()`,
  toastRing: `(() => {
    const host = document.querySelector("div[style*=padding]")
    const shadow = host && host.shadowRoot
    const action = shadow && shadow.querySelector("[data-button]")
    const card = shadow && shadow.querySelector("[data-sonner-toast]")
    if (!action) return [["action button", "not found"]]
    const ring = getComputedStyle(action).boxShadow
    const ground = getComputedStyle(card).backgroundColor
    const colour = (ring.match(/rgba?\\([^)]*\\)/) || ["—"])[0]
    const r = colour === "—" ? null : window.__cheatsheet.ratio(colour, ground)
    return [
      ["focus ring", colour],
      ["card behind it", ground],
      ["contrast", r === null ? "—" : r + ":1" + (r < 3 ? "  — under 3:1" : "  — clears 3:1")],
    ]
  })()`,
  buttonPadding: `(() => {
    const glyph = document.querySelector("#glyph-button")
    const plain = document.querySelector("#plain-button")
    const g = getComputedStyle(glyph)
    return [
      ["icon button, left pad", g.paddingLeft],
      ["icon button, right pad", g.paddingRight],
      ["word-only button, left pad", getComputedStyle(plain).paddingLeft],
    ]
  })()`,
  measureWidth: `(() => {
    const rows = []
    for (const sel of [".de-empty", ".de-opt-note"]) {
      const node = document.querySelector(sel)
      if (!node) continue
      const width = node.getBoundingClientRect().width
      // Characters per line, measured off the face actually rendering rather
      // than assumed: one '0' in the node's own computed font.
      const probe = document.createElement("span")
      probe.textContent = "0".repeat(100)
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:" + getComputedStyle(node).font
      document.body.append(probe)
      const ch = probe.getBoundingClientRect().width / 100
      probe.remove()
      rows.push([sel, Math.round(width) + "px  ≈ " + Math.round(width / ch) + " characters"])
    }
    return rows
  })()`,
  handleOverlap: `(() => {
    const boxes = [...document.querySelectorAll(".de-handle-hit")].map((n) => {
      const r = n.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    })
    let worst = 0
    for (let i = 0; i < boxes.length; i += 1)
      for (let j = i + 1; j < boxes.length; j += 1) {
        const dx = Math.min(boxes[i].right, boxes[j].right) - Math.max(boxes[i].left, boxes[j].left)
        const dy = Math.min(boxes[i].bottom, boxes[j].bottom) - Math.max(boxes[i].top, boxes[j].top)
        if (dx > 0 && dy > 0) worst = Math.max(worst, Math.round(Math.min(dx, dy)))
      }
    return [
      ["handles drawn", String(boxes.length)],
      ["worst overlap", worst ? worst + "px of shared target" : "none — every target is its own"],
    ]
  })()`,
  escapePresence: `(() => {
    const node = document.querySelector(".de-escape")
    if (!node)
      return [
        ["a way out of the chrome", "none — no such control exists"],
        ["at rest", "—"],
        ["focused", "—"],
      ]
    const s = getComputedStyle(node)
    return [
      ["a way out of the chrome", "“" + node.textContent + "”"],
      ["at rest", "clipped to 1px, still in the tab order"],
      ["focused", Math.round(node.getBoundingClientRect().width) + "px wide, " + s.position],
    ]
  })()`,
  gapRatio: `(() => {
    const row = document.querySelector(".de-row--split")
    const body = document.querySelector(".de-section-body")
    if (!row || !body) return [["rows", "not found"]]
    const within = getComputedStyle(row).columnGap
    const between = getComputedStyle(document.querySelector(".de-section")).rowGap
    const stack = getComputedStyle(body.parentElement.parentElement).rowGap || between
    const n = (v) => Number.parseFloat(v) || 0
    const groups = n(stack) || 8
    const items = n(within)
    return [
      ["between two fields", items + "px"],
      ["between two groups", groups + "px"],
      ["ratio", items ? (groups / items).toFixed(1) + "×" + (groups / items >= 2 ? "  — clears 2×" : "  — under 2×") : "—"],
    ]
  })()`,
  arriveOrigin: `(() => {
    const card = document.querySelector(".de-arrive")
    if (!card) return [["card", "not found"]]
    const s = getComputedStyle(card)
    // The matrix's f component is the translate-y the keyframe is applying at
    // this instant. Negative means the card is ABOVE where it will settle and
    // therefore travelling down; positive means it is below and rising.
    const m = new DOMMatrixReadOnly(s.transform)
    const dy = Math.round(m.f * 100) / 100
    return [
      ["transform-origin", s.transformOrigin],
      ["offset at this frame", dy + "px"],
      [
        "travelling",
        dy === 0 ? "—" : dy < 0 ? "downward, away from a trigger below it" : "upward, toward the trigger below it",
      ],
    ]
  })()`,
}

/* ------------------------------------------------------------------ */
/* Shooting                                                            */
/* ------------------------------------------------------------------ */

/** A deuteranopia matrix, as an SVG filter, so the shot shows the real problem. */
const CVD_FILTER = `
<svg width="0" height="0" style="position:absolute">
  <filter id="deuteranopia" color-interpolation-filters="linearRGB">
    <feColorMatrix type="matrix" values="
      0.625 0.375 0     0 0
      0.7   0.3   0     0 0
      0     0.3   0.7   0 0
      0     0     0     1 0"/>
  </filter>
</svg>`

async function shootChrome(browser, js, spec, label) {
  const page = await browser.newPage({
    viewport: spec.viewport ?? { width: 420, height: 240 },
    deviceScaleFactor: 2,
    /*
     * HEADLESS CHROMIUM REPORTS `prefers-reduced-motion: reduce`, and this
     * chrome takes that seriously: the blanket in `css/base.ts` clamps every
     * duration in the stylesheet to 0.01ms. So every motion scene on this page
     * was silently being shot at its end state — the transition had finished
     * before the first frame, and `getAnimations()` returned nothing to freeze.
     *
     * Stated rather than left to the environment, because the default is not a
     * neutral choice here: it is the branch that turns three of these scenes
     * into a photograph of nothing happening. The reduced-motion behaviour is
     * worth its own page; it is not what this one is comparing.
     */
    reducedMotion: "no-preference",
  })
  const problems = []
  let frozen = 0
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 220)))
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
       html,body{margin:0;min-height:100%}
       body{display:flex;align-items:center;justify-content:center}
       ${spec.filter ? `body{filter:url(#${spec.filter})}` : ""}
       ${spec.zoom ? `body>*{zoom:${spec.zoom}}` : ""}
     </style></head><body>${spec.filter ? CVD_FILTER : ""}</body></html>`,
    { waitUntil: "load" }
  )
  await page.addScriptTag({ content: js })

  /*
   * The one fact the handles scene cannot work out for itself.
   *
   * It draws the handles rather than driving `selection.ts` — see the note on
   * the scene — so it has to be told whether this build suppresses the crowded
   * corners. Reading the module would fail the before build, which has no such
   * rule to read. The flag is set per column by the driver, which knows.
   */
  if (spec.crowdRule) {
    await page.evaluate((on) => {
      window.__deCrowdRule = on
    }, label === "after")
  }

  let handles = {}
  try {
    handles = await page.evaluate(
      ([scene, theme, pageColor]) => {
        const build = window.__cheatsheet[scene]
        if (!build) return { missing: scene }
        return build(theme, pageColor) ?? {}
      },
      [spec.scene, spec.theme ?? "dark", spec.page ?? null]
    )
  } catch (error) {
    problems.push(`scene: ${String(error).slice(0, 220)}`)
  }
  if (handles && handles.missing) problems.push(`this revision has no scene "${handles.missing}"`)

  // The interactions, each producing a real pseudo-class rather than a faked one.
  try {
    if (spec.hold) {
      const box = await page.locator(spec.hold).boundingBox()
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.waitForTimeout(220)
      }
    }
    if (spec.tab) {
      await page.keyboard.press("Tab")
      await page.waitForTimeout(120)
    }
    if (spec.hoverShadow) {
      await page.evaluate((sel) => {
        const host = document.querySelector("div[style*=padding]")
        const node = host && host.shadowRoot && host.shadowRoot.querySelector(sel)
        if (node) {
          const box = node.getBoundingClientRect()
          window.__hoverAt = [box.x + box.width / 2, box.y + box.height / 2]
        }
      }, spec.hoverShadow)
      const at = await page.evaluate(() => window.__hoverAt ?? null)
      if (at) {
        await page.mouse.move(at[0], at[1])
        await page.waitForTimeout(260)
      }
    }
    if (spec.focusShadow) {
      await page.evaluate((sel) => {
        const host = document.querySelector("div[style*=padding]")
        const node = host && host.shadowRoot && host.shadowRoot.querySelector(sel)
        // `focus-visible` follows the heuristic, and a scripted focus on a
        // button does not satisfy it — so the modality is set the way a
        // keyboard user sets it, with a key, and then focus is moved.
        if (node) node.focus()
      }, spec.focusShadow)
      await page.keyboard.press("Tab")
      await page.keyboard.press("Shift+Tab")
      await page.waitForTimeout(160)
    }
    if (spec.swap) {
      /*
       * Start the crossfade, then FREEZE it at the same instant in both
       * columns.
       *
       * Waiting a fixed number of milliseconds and hoping to land mid-
       * transition is a coin toss, and the two columns would then be sampled at
       * different points — the page would be comparing the delay rather than
       * the blur. The Web Animations API exposes a running CSS transition as an
       * `Animation`, so the clock can be set to the midpoint and stopped. What
       * is painted is still the browser's own interpolation of the shipped
       * rule; only the time is ours.
       *
       * Both the glyphs and their box are swept, because the reduced-motion
       * variant and the colour change hang off different elements and a stray
       * one still running would finish under the frozen ones.
       */
      const held = await page.evaluate(async () => {
        const box = document.querySelector(".de-swap")
        if (!box) return 0
        box.classList.add("de-swap--done")
        await new Promise((r) => requestAnimationFrame(r))
        let n = 0
        for (const node of [box, ...box.querySelectorAll("*")]) {
          for (const animation of node.getAnimations()) {
            const total = animation.effect?.getTiming?.().duration
            animation.currentTime = typeof total === "number" ? total / 2 : 90
            animation.pause()
            n += 1
          }
        }
        return n
      })
      /*
        * Nothing to freeze is not a tool failure here — it is the finding. The
        * before column has no running transition because the icon stroke rule
        * had replaced the list, so its frame IS the end state. Recorded in the
        * probe table below rather than raised as a problem, where it would read
        * as the page having broken rather than the product.
        */
      frozen = held
      await page.waitForTimeout(80)
    }
  } catch (error) {
    problems.push(`drive: ${String(error).slice(0, 220)}`)
  }

  if (!spec.swap) await page.waitForTimeout(140)
  const file = `${spec.id}-${label}.png`
  await page.screenshot({ path: path.join(OUT, file) })
  let probe = spec.probe ? await page.evaluate(PROBES[spec.probe]).catch(() => null) : null
  if (spec.swap) {
    const props = await page
      .evaluate(() => {
        const svg = document.querySelector(".de-swap .de-swap-done")
        return svg ? getComputedStyle(svg).transitionProperty : "—"
      })
      .catch(() => "—")
    probe = [
      ["glyph transitions", props],
      ["frames held mid-change", String(frozen)],
      ["what the shot is", frozen ? "the real midpoint, paused" : "the end state — nothing was animating"],
    ]
  }
  if (spec.hold) await page.mouse.up().catch(() => {})
  await page.close()
  return { file, probe, problems }
}

/* ---------- the start screen, which needs no bundle ---------- */

const START_FILES = ["runtime/start-screen-page.mjs", "runtime/start-screen-style.mjs"]

/**
 * A tree's copy of the start screen, importable.
 *
 * The token bundle is symlinked from the working tree in both columns on
 * purpose: `dist/` is a build artifact, it is gitignored, and the snapshot's
 * copy would be whatever happened to be built at snapshot time. That makes the
 * comparison one of the page and its stylesheet against themselves, which is
 * what this pass changed. The same choice `before-after.mjs` documents.
 */
function startTree(treeRoot) {
  if (treeRoot === ROOT) return ROOT
  const dist = path.join(treeRoot, "dist")
  fs.mkdirSync(dist, { recursive: true })
  const link = path.join(dist, "tokens.mjs")
  if (!fs.existsSync(link)) fs.symlinkSync(path.join(ROOT, "dist", "tokens.mjs"), link)
  return treeRoot
}

async function shootStart(browser, treeRoot, spec, label) {
  const root = startTree(treeRoot)
  const problems = []
  let html
  try {
    const mod = await import(
      `${pathToFileURL(path.join(root, START_FILES[0])).href}?v=${label}-${Date.now()}`
    )
    html = mod.startScreenPage ? mod.startScreenPage() : mod.default()
  } catch (error) {
    problems.push(`import: ${String(error).slice(0, 220)}`)
    return { file: null, probe: null, problems }
  }
  const page = await browser.newPage({
    viewport: spec.viewport,
    deviceScaleFactor: 2,
    // See the note in `shootChrome`. The start screen has its own reduced-motion
    // block, and the same argument applies to it.
    reducedMotion: "no-preference",
  })
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 220)))
  /*
   * The loopback the page talks to, canned — and SERVED FROM AN ORIGIN.
   *
   * `page.setContent` leaves the document at `about:blank`, where a relative
   * `fetch("/api/apps")` has no base to resolve against and throws before any
   * route can answer it. The page handles that correctly — it shows "Lost
   * contact with designlayer" — which is why the failure looked like an empty
   * list rather than an error: the scan simply never returned, so the card
   * stayed in its cold-boot state and the shot was of the wrong scene.
   *
   * So the document is served over a fake host instead. Everything is
   * intercepted, nothing leaves the machine, and the page runs with the same
   * relative URLs it ships with.
   *
   * `/api/apps` is the one that matters — it fills the "Running apps" list,
   * where the ellipsised name lives. `/api/status` has to answer too, and has
   * to answer EMPTY: a status payload carrying an `appUrl` means an editor is
   * already up and the page redirects to it before the card is ever painted.
   */
  const ORIGIN = "http://start-screen.invalid"
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = route.request().url()
    const json = (body) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
    if (url.includes("/api/apps")) return json({ apps: spec.apps ?? [] })
    if (url.includes("/api/status")) return json({})
    /*
     * The page picks the first running app for you and immediately resolves its
     * folder, so this endpoint is on the boot path whenever `apps` is non-empty
     * — and `adoptProject` reads `project.path` and `project.devScripts` off the
     * answer without guarding either. An empty `{}` here threw before the card
     * finished painting, which is why the list looked empty rather than wrong.
     */
    if (url.includes("/api/project")) {
      const at = decodeURIComponent((url.split("path=")[1] ?? "").split("&")[0])
      return json({
        project: { path: at, name: at.split("/").pop(), devScripts: ["dev", "start"] },
      })
    }
    if (url.includes("/api/")) return json({})
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
  })
  await page.goto(`${ORIGIN}/`, { waitUntil: "load" })
  // The scan is a round trip and the list is rendered from its answer.
  await page.waitForTimeout(600)
  if (spec.drive) await page.evaluate(spec.drive).catch((e) => problems.push(`drive: ${e}`))
  if (spec.hold) {
    const box = await page.locator(spec.hold).boundingBox().catch(() => null)
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.waitForTimeout(220)
    }
  }
  const file = `${spec.id}-${label}.png`
  await page.screenshot({ path: path.join(OUT, file), fullPage: true })
  let probe = null
  if (spec.probe === "appTitles") {
    probe = await page
      .evaluate(`(() => {
        const rows = [...document.querySelectorAll(".app-name")]
        if (!rows.length) return [["running apps", "none rendered"]]
        return rows.map((n) => [
          "“" + n.textContent + "”",
          n.title ? "hover shows: " + n.title : "no way to the full name",
        ])
      })()`)
      .catch(() => null)
  }
  if (spec.hold) await page.mouse.up().catch(() => {})
  await page.close()
  return { file, probe, problems }
}

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

const escape = (v) =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const probeTable = (before, after) => {
  if (!before && !after) return ""
  const keys = []
  for (const row of [...(before ?? []), ...(after ?? [])]) {
    if (!keys.includes(row[0])) keys.push(row[0])
  }
  const get = (rows, key) => (rows ?? []).find((r) => r[0] === key)?.[1] ?? "—"
  const body = keys
    .map((key) => {
      const a = get(before, key)
      const b = get(after, key)
      return `<tr class="${String(a) !== String(b) ? "moved" : ""}"><th>${escape(key)}</th><td>${escape(a)}</td><td>${escape(b)}</td></tr>`
    })
    .join("")
  return `<table class="metrics"><thead><tr><th></th><th>Before</th><th>After</th></tr></thead><tbody>${body}</tbody></table>`
}

const shot = (result, alt, tag) =>
  result.file
    ? `<figure><figcaption><span class="tag tag-${tag}">${tag === "before" ? "Before" : "After"}</span></figcaption>
         <img src="${result.file}" alt="${escape(alt)}, ${tag}"></figure>`
    : `<figure><figcaption><span class="tag tag-${tag}">${tag === "before" ? "Before" : "After"}</span></figcaption>
         <p class="none">This revision could not render the scene.</p></figure>`

function section(spec, before, after) {
  const problems = [...before.problems, ...after.problems]
  return `
<section class="state sev-${spec.severity}" id="${spec.id}">
  <header>
    <p class="eyebrow"><span class="sev">${spec.severity}</span><span class="rule">${escape(spec.rule)}</span></p>
    <h2>${escape(spec.title)}</h2>
    <p class="why">${escape(spec.why)}</p>
  </header>
  ${probeTable(before.probe, after.probe)}
  <div class="pair">
    ${shot(before, spec.title, "before")}
    ${shot(after, spec.title, "after")}
  </div>
  <p class="verdict">Keep &nbsp;·&nbsp; Change &nbsp;·&nbsp; Revert &nbsp;— <span>${escape(spec.id)}</span></p>
  ${problems.length ? `<p class="problem">${problems.map(escape).join("<br>")}</p>` : ""}
</section>`
}

function pageHtml(sections, meta) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>designlayer — the interfaces.dev cheat-sheet pass</title>
<style>
  :root { color-scheme: dark; --dim: rgba(255,255,255,0.62); --line: rgba(255,255,255,0.14); }
  * { box-sizing: border-box; }
  body { margin:0; padding:40px 32px 120px; background:#1b1b1b; color:#f2f2f2;
         font:400 14px/1.6 ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
         -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }
  .page { max-width: 1180px; margin: 0 auto; }
  h1 { margin:0 0 6px; font-size:26px; text-wrap:balance; }
  .meta { margin:0 0 6px; max-width:78ch; color:var(--dim); font-size:13px; text-wrap:pretty; }
  .meta code { font-family: ui-monospace, monospace; color:#f2f2f2; }
  .toc { margin:28px 0 12px; padding:0; list-style:none; display:flex; flex-wrap:wrap; gap:8px; }
  .toc a { display:flex; gap:8px; align-items:center; padding:6px 10px;
           border:1px solid var(--line); border-radius:8px;
           color:#f2f2f2; text-decoration:none; font-size:13px; }
  .toc a:hover { border-color:#7cc4f8; }
  .toc .dot { width:7px; height:7px; border-radius:50%; }
  .toc .high { background:#ff8a65; border-radius:0; }
  .toc .medium { background:#ffcc66; }
  .toc .low { background:rgba(255,255,255,0.4); }
  .ledger { margin:0 0 48px; padding:16px 18px; border:1px solid var(--line); border-radius:10px; }
  .ledger summary { cursor:pointer; font-weight:600; }
  .verdicts { margin:16px 0 0; border-collapse:collapse; font-size:13px; width:100%; }
  .verdicts th, .verdicts td { padding:5px 14px 5px 0; text-align:left; vertical-align:top;
                               border-top:1px solid rgba(255,255,255,0.06); }
  .verdicts th { width:64px; font-weight:600; font-family:ui-monospace,monospace; color:#f2f2f2; }
  .verdicts td:nth-child(2) { width:250px; color:#f2f2f2; font-weight:400; }
  .verdicts td:nth-child(3) { width:88px; }
  .verdicts .state { padding:1px 7px; border-radius:4px; font-size:11px; font-weight:600;
                     letter-spacing:0.04em; text-transform:uppercase; }
  .v-changed .state { background:rgba(124,196,248,0.16); color:#7cc4f8; }
  .v-open .state { background:rgba(255,138,101,0.16); color:#ff8a65; }
  .v-blocked .state { background:rgba(255,204,102,0.16); color:#ffcc66; }
  .v-argued .state { background:rgba(167,139,250,0.18); color:#c4b5fd; }
  .v-met .state, .v-na .state { background:rgba(255,255,255,0.07); color:var(--dim); }
  .verdicts .note { color:var(--dim); text-wrap:pretty; }
  .state { margin:0 0 64px; padding-top:28px; border-top:1px solid var(--line); }
  .state h2 { margin:0 0 6px; font-size:19px; text-wrap:balance; }
  .eyebrow { margin:0 0 6px; display:flex; gap:10px; align-items:center;
             font-size:11px; letter-spacing:0.06em; text-transform:uppercase; }
  .sev { padding:2px 7px; border-radius:4px; font-weight:600; }
  .sev-high .sev { background:rgba(255,138,101,0.16); color:#ff8a65; }
  .sev-medium .sev { background:rgba(255,204,102,0.16); color:#ffcc66; }
  .sev-low .sev { background:rgba(255,255,255,0.08); color:var(--dim); }
  .rule { color:var(--dim); font-family:ui-monospace,monospace; letter-spacing:0; text-transform:none; }
  .why { margin:0 0 18px; max-width:82ch; color:var(--dim); text-wrap:pretty; }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:20px; align-items:start; }
  figure { margin:0; }
  figcaption { margin:0 0 8px; }
  .tag { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; }
  .tag-before { background:rgba(255,138,101,0.16); color:#ff8a65; }
  .tag-after { background:rgba(124,196,248,0.16); color:#7cc4f8; }
  img { width:100%; display:block; border-radius:10px; background:#111;
        outline:1px solid rgba(255,255,255,0.08); outline-offset:-1px; }
  .none { margin:0; padding:24px; border:1px dashed var(--line); border-radius:10px;
          color:#ff8a65; font-size:13px; }
  .metrics { margin:0 0 18px; border-collapse:collapse; font-size:13px;
             font-variant-numeric: tabular-nums; }
  .metrics th,.metrics td { padding:4px 20px 4px 0; text-align:left; font-weight:400;
                            color:var(--dim); font-family:ui-monospace,monospace; }
  .metrics thead th { color:#f2f2f2; font-weight:600; font-family:inherit; }
  .metrics tbody th { color:#f2f2f2; font-family:inherit; }
  .metrics tr.moved td:last-child { color:#7cc4f8; font-weight:600; }
  .verdict { margin:16px 0 0; padding:8px 12px; border:1px dashed var(--line);
             border-radius:8px; color:var(--dim); font-size:13px; }
  .verdict span { font-family:ui-monospace,monospace; color:rgba(255,255,255,0.38); }
  .problem { margin:12px 0 0; padding:8px 12px; border-radius:8px;
             background:rgba(255,138,101,0.12); color:#ff8a65; font-size:13px; }
</style></head>
<body><div class="page">
  <h1>The interfaces.dev cheat sheet, applied</h1>
  <p class="meta">All sixty-one rules on the sheet, read against this codebase. Most were already met — several with an argument in the source that is better than the rule. These are the ${sections.length} scenes where something moved, each rendered against the tree as it stood before the pass. The ledger below accounts for every rule, including the ones that did not.</p>
  <p class="meta">Before is <code>.worktrees/cheatsheet-before</code>, a copy of <code>src/</code> and <code>runtime/</code> taken before the first edit. Both columns are real bundles of the same scene file, so the markup is identical by construction and only the stylesheet differs. ${escape(meta.when)}</p>
  <ul class="toc">${sections
    .map(
      (s) =>
        `<li><a href="#${s.id}"><span class="dot ${s.severity}"></span>${escape(s.title)}</a></li>`
    )
    .join("")}</ul>

  <details class="ledger" open>
    <summary>All sixty rules, and what happened to each</summary>
    <table class="verdicts"><tbody>${VERDICTS.map(
      ([rule, name, state, note]) =>
        `<tr class="v-${state.replace("/", "")}"><th>${escape(rule)}</th><td>${escape(name)}</td>` +
        `<td><span class="state">${escape(state)}</span></td>` +
        `<td class="note">${escape(note)}</td></tr>`
    ).join("")}</tbody></table>
  </details>
  ${sections.map((s) => s.html).join("\n")}
</div></body></html>`
}

/* ------------------------------------------------------------------ */

async function main() {
  if (!fs.existsSync(BEFORE)) {
    console.error(
      `No baseline at ${path.relative(ROOT, BEFORE)}.\n` +
        "It is a plain copy taken before the pass, not a git worktree:\n" +
        "  mkdir -p .worktrees/cheatsheet-before && cp -R src runtime tools .worktrees/cheatsheet-before/"
    )
    process.exitCode = 1
    return
  }
  fs.mkdirSync(OUT, { recursive: true })

  const playwright = await loadPlaywright()
  if (!playwright) {
    console.error("Playwright not found. `npm i -D playwright` or install it globally.")
    process.exitCode = 1
    return
  }

  const chrome = SCENES.filter((s) => !wanted || wanted.has(s.id))
  const start = START_SCENES.filter((s) => !wanted || wanted.has(s.id))

  console.log(`Bundling the scene against both trees…`)
  const [beforeJs, afterJs] = await Promise.all([bundleScene(BEFORE), bundleScene(ROOT)])

  const browser = await playwright.chromium.launch()
  const sections = []

  for (const spec of chrome) {
    process.stdout.write(`  ${spec.id} … `)
    const before = await shootChrome(browser, beforeJs, spec, "before")
    const after = await shootChrome(browser, afterJs, spec, "after")
    sections.push({ ...spec, html: section(spec, before, after) })
    console.log("ok")
  }
  for (const spec of start) {
    process.stdout.write(`  ${spec.id} … `)
    const before = await shootStart(browser, BEFORE, spec, "before")
    const after = await shootStart(browser, ROOT, spec, "after")
    sections.push({ ...spec, html: section(spec, before, after) })
    console.log("ok")
  }

  await browser.close()

  const order = { high: 0, medium: 1, low: 2 }
  sections.sort((a, b) => order[a.severity] - order[b.severity])
  const page = pageHtml(sections, { when: new Date().toISOString() })
  const file = path.join(OUT, "index.html")
  fs.writeFileSync(file, page)

  /*
   * A second copy with the images inside it, for anywhere the folder cannot go.
   *
   * The page above references its PNGs by name and is the one to open locally.
   * A review tool, a bug comment or an artifact viewer gets one file or nothing,
   * and a page whose every image is a broken icon is worse than no page — so
   * the same HTML is emitted again with each shot as a data URI. Same argument,
   * same shape, as `tools/before-after.mjs`.
   */
  const inlined = page.replace(/src="([^"]+\.png)"/g, (whole, name) => {
    const bytes = fs.readFileSync(path.join(OUT, name))
    return `src="data:image/png;base64,${bytes.toString("base64")}"`
  })
  const standalone = path.join(OUT, "standalone.html")
  fs.writeFileSync(standalone, inlined)

  console.log(`\n${path.relative(ROOT, file)}`)
  console.log(
    `${path.relative(ROOT, standalone)} (${Math.round(inlined.length / 1024)}kb, images inlined)`
  )
  if (flags.has("--open")) execFileSync("open", [file])
}

await main()
