/** Root variables, the palette, vendor-UI suppression, the app inset, and stacking order. */

import { tokens as t, themeDeclarations, themeProperties, themeRegistrations } from "../tokens"

/*
 * The vendored React Rewrite overlay stays loaded — we drive it headlessly for
 * fiber -> source resolution and source writes — but its chrome is replaced by
 * ours. Its drag preview and drop indicator stay: we call into them.
 */
const VENDOR_CHROME = [
  ".prop-sidebar",
  ".toolbar",
  ".tools-panel",
  ".selection-label",
  ".changelog-panel",
  ".changelog-badge",
  ".help-btn",
  ".shortcuts-overlay",
  /*
   * The vendor's marquee, which we have our own of (`canvas/marquee.ts`).
   *
   * It was drawing on every drag anywhere on the page, ours included: a 2px
   * accent bar from the press to the pointer, which on a horizontal drag is a
   * line across the screen. Invisible as a bug for as long as the only place
   * you could drag was the canvas, where a marquee is what you asked for and
   * two of them land on top of each other. Dragging a panel seam is a drag that
   * means something else entirely, and it made the stray one obvious.
   *
   * Suppressed rather than prevented, because the press cannot be kept from the
   * vendor: its listeners are on `document`, registered when it boots, which is
   * before our bundle is parsed — and `shell.ts` deliberately declaws
   * `stopPropagation` for chrome targets so OUR controls keep their gestures.
   * Ours is the marquee that decides what gets selected; this one only ever
   * drew.
   */
  ".marquee-box",
  /*
   * The vendor's toast, replaced by Sonner (`core/toast.ts`).
   *
   * Hidden rather than left to render, because both surfaces are live at once:
   * the vendor raises its own messages from inside its bundle, and those are
   * mirrored into ours by reading THIS node. Leaving it visible would show
   * every vendor message twice, in two different designs, in two corners.
   *
   * `display: none` is what makes the mirror work rather than what breaks it —
   * a hidden node still takes text, still takes classes, and still delivers
   * both to a `MutationObserver`.
   */
  ".toast",
  /*
   * The vendor's own highlight canvas: a fixed, full-viewport <canvas> at
   * twice the device scale, which it clears and redraws on every pointer move.
   *
   * It never shows anything here — the outlines are ours (`canvas/selection.ts`)
   * and every vendor box is turned off, so it was sampled empty through hover,
   * select, drag, marquee and Cmd-hover — but a displayed canvas is a
   * composited layer, and each redraw re-uploaded all 2880×1800 of it: about a
   * millisecond of commit on every pointer move and a 20MB texture held for the
   * life of the page, for pixels that were all transparent.
   */
  "canvas[data-react-rewrite-overlay]",
]

/**
 * The same list, unprefixed, for injection *inside* the vendor's shadow root.
 *
 * The vendor mounts its chrome into `#react-rewrite-root`'s open shadow root,
 * so the descendant selectors below can never match it — which is why its
 * `.prop-sidebar` kept painting over our inspector at z-index 2147483645
 * despite having been named in a suppression rule since day one. A shadow
 * boundary blocks selectors, not stacking.
 *
 * One piece of vendor chrome is NOT in this list and cannot be: its onboarding
 * bar carries no class, only inline styles, so nothing here can name it. It is
 * turned off before it is built instead — see `onboardingDismissal` in
 * config.mjs.
 */
export const vendorChromeCss = `${VENDOR_CHROME.join(",\n")} { display: none !important; }
/*
 * The two vendor surfaces that DO stay on screen — its drag preview and drop
 * indicator, which we call into — repainted in the chrome's accent instead of
 * the vendor's own blue. Custom properties inherit across the shadow boundary,
 * so the palette roles resolve in here exactly as they do in the document.
 */
.drag-preview { border-color: ${t.color.accent} !important; }
.drop-indicator,
.drop-indicator::before,
.drop-indicator::after { background: ${t.color.accent} !important; }
`

/*
 * Where the palette is DECLARED, and why it is not on the editor root alone.
 *
 * The obvious selector is `[data-designlayer]`, and it is wrong twice over.
 *
 * ONE: `el()` stamps that attribute on everything it builds — 1604 elements in
 * a live session — so declaring the palette on the bare attribute re-declares
 * it on every descendant, and a directly matching declaration beats an
 * inherited one at any specificity. Flipping the theme on the root would then
 * change the root and nothing inside it. That is the same bug the `color` split
 * below documents, with the whole palette instead of one property.
 *
 * TWO: the chrome is not one subtree. Four roots are mounted on `<body>` — the
 * editor root, the options window, the token popover, and the probe span in
 * `inspector/section-design-system.ts` — and `<html>` is the only ancestor all
 * four share. A palette declared on the editor root leaves a popover dark on a
 * light page, and popovers are precisely where the inline `var()` styles in
 * `inspector/color.ts` and `inspector/section-classes.ts` are read.
 *
 * So the values are declared on `:root`, where everything in the document can
 * inherit them, and the theme attribute is written to BOTH `<html>` and the
 * editor root by `applyTheme` in `shell/toolbar.ts`. Naming both selectors
 * means the scoped switch is real rather than decorative: the editor root
 * subtree resolves from its own attribute, and a surface parked outside it
 * falls back to the document's. One writer, so they cannot disagree.
 *
 * Dark is emitted first and unconditionally — the theme the editor has always
 * been, and the one it falls back to if the attribute is never written at all,
 * which is what a browser with storage blocked and a boot that threw would
 * leave behind.
 */
export const paletteCss = `/* ---------- palette ---------- */
/*
 * THE ROLES ARE REGISTERED, WHICH IS WHAT LETS THE THEME CROSSFADE.
 *
 * An unregistered custom property is untyped as far as the cascade is
 * concerned, so the browser cannot interpolate one colour into another and a
 * \`transition\` naming it does nothing. Flipping the theme repainted the whole
 * chrome between two frames not because nobody had written the transition, but
 * because there was no way to write one that worked.
 *
 * \`themeRegistrations()\` emits one \`@property\` per palette role, generated from
 * the same rows as the declarations below, so a registration cannot drift from
 * the value it types. See the note on it in \`tokens.ts\`.
 */
${themeRegistrations()}

/*
 * And the crossfade itself, on everything the chrome paints.
 *
 * One rule rather than a transition per surface: the theme changes every role
 * at once, so the thing being animated is the palette and not any particular
 * control. It has to name the ROLES — the registered properties — rather than
 * \`background\` or \`color\`, because those are already being transitioned all
 * over this chrome at their own durations for their own reasons, and re-timing
 * them here would make every hover in the editor 250ms slow for the sake of a
 * button pressed twice a session.
 *
 * On \`:root\`, where the roles are declared and from where they inherit, so a
 * popover mounted on \`<body>\` fades with everything else.
 *
 * \`reveal\` is the rung: long enough that a whole-surface colour change reads as a
 * dissolve rather than a cut, short enough that the chrome is not visibly
 * mid-flip while the reader is already looking at it.
 *
 * Reduced motion clamps it to nothing — someone who asked for less motion gets
 * the old instant repaint, and a repaint is not motion. That takes naming
 * \`:root\` in the blanket below, which it originally did not: this selector is
 * \`<html>\`, and \`<html>\` is not \`[data-designlayer]\`.
 */
:root {
  transition: ${themeProperties()
    .map((property) => `${property} ${t.duration.reveal} ${t.ease}`)
    .join(",\n    ")};
}

/*
 * The HOST'S top-level subtrees hold the palette still while \`:root\` fades.
 *
 * Interpolating a custom property on \`:root\` changes an inherited value on
 * every element in the document, so each frame of the 250ms fade restyled the
 * app's whole tree too — thousands of nodes that never read a \`--de-\` role,
 * and most of the theme toggle's main-thread time. Declaring the target values
 * outright on each non-chrome child of \`<body>\` gives those elements a value
 * that does not change mid-fade, and an element whose computed style is
 * unchanged stops the restyle from reaching anything below it.
 *
 * The values, not \`initial\`: anything the host tree does carry that reads the
 * palette — the vendor's root, whose drag preview wears the accent, or a
 * companion — still gets the right theme, just without the dissolve. Chrome
 * mounted on \`<body>\` is excluded by its attribute and fades as before.
 *
 * Named in the two palette rules rather than in a block of its own, so the
 * values cannot drift from the ones the chrome gets. First in each list, so the
 * selectors the suites find each block by (\`token-cases\`, \`tools/contrast\`)
 * still read exactly as they did.
 */
body > :not([data-designlayer]),
:root,
[data-designlayer][data-de-theme="dark"] {
${themeDeclarations("dark")}
}
:root[data-de-theme="light"] body > :not([data-designlayer]),
:root[data-de-theme="light"],
[data-designlayer][data-de-theme="light"] {
${themeDeclarations("light")}
}
`

export const baseCss = `${paletteCss}
/*
 * THE HALF OF THE CHROME THE PALETTE CANNOT REACH.
 *
 * Fifty-six custom properties say what the editor paints. They say nothing
 * about what the USER AGENT paints inside it, and the chrome has more of that
 * than it looks: every \`<select>\`'s drop-down list, every checkbox, the colour
 * input's native picker, the caret and the selection highlight in a text field,
 * the scrollbar on any panel that overflows, an autofilled field's yellow. All
 * of those follow \`color-scheme\`, and this stylesheet had never declared one —
 * so they followed the HOST PAGE's, or failing that the operating system's. The
 * editor could be in its dark theme with a stack of white native menus opening
 * out of it, and the theme switch could not do anything about it.
 *
 * It is written here rather than inside the two palette blocks because those
 * are generated from \`PALETTE\` and every row in \`PALETTE\` is registered
 * \`syntax: "<color>"\` — \`dark\` is not a colour, the registration would drop it,
 * and \`token-cases.mjs\` correctly reads any extra property in those blocks as a
 * role that got renamed in one place only.
 *
 * SCOPED TO \`[data-designlayer]\`, NEVER \`:root\`. \`:root\` here is the product's
 * own \`<html>\`: a scheme declared there would re-tint the app being edited,
 * which is the one document this editor must leave exactly as its author wrote
 * it. \`el()\` stamps the attribute on every node the chrome builds, so the
 * attribute is a complete description of "ours" and \`<html>\` is not.
 *
 * Two selectors for the light case, because only \`<html>\` and the editor root
 * carry \`data-de-theme\` (\`applyTheme\` in \`shell/toolbar.ts\` writes both). The
 * options window, the token popover and the probe span are mounted straight
 * onto \`<body>\`, so they are inside neither — the descendant selector is what
 * reaches them, keyed off the document attribute the same writer sets.
 *
 * Dark is the unconditional base for the reason every other default in this
 * file is dark: it is what the editor is when nothing has said otherwise.
 */
[data-designlayer] { color-scheme: dark; }
:root[data-de-theme="light"] [data-designlayer],
[data-designlayer][data-de-theme="light"] { color-scheme: light; }

:root {
  --de-left: 0px;
  --de-right: 0px;
  --de-top: 0px;
  /* The toolbar's own pair, which does not collapse when the chrome hides —
     see syncInsets in shell/shell.ts.

     \`--de-bar-right\` is also read from OUTSIDE this repository: a companion
     bundle docks itself into the canvas lane with it. Renaming the \`de-\`
     prefix, or this variable, has to be done there too — see COMPANION
     CONTRACT on \`.de-root\` below. */
  --de-bar-left: 0px;
  --de-bar-right: 0px;
  /*
   * ONE PERCENT OF THE CANVAS — the app's \`vw\` after \`shell/app-viewport.ts\`
   * has rewritten it.
   *
   * The inset below shrinks the app's containing block, and an app laid out in
   * percentages follows it. An app laid out in \`vw\` does not: \`100vw\` is the
   * WINDOW, which the panels do not change, so the app kept its full width and
   * ran underneath the inspector — visible only on the right, because padding
   * on the left moves the origin while padding on the right has nothing to push
   * against. \`app-viewport.ts\` rewrites those declarations to read this
   * property instead, and this is the line that makes the substitution mean
   * "the strip between the panels".
   *
   * Declared in CSS rather than written from \`syncInsets\`, because expressed
   * this way it is already correct on a window resize, on a seam drag and while
   * the chrome is hidden — the two properties it reads are the same two the
   * shell keeps up to date, and a zeroed pair leaves this exactly \`1vw\`.
   */
  --de-vw: calc((100vw - var(--de-left) - var(--de-right)) / 100);
}

${VENDOR_CHROME.map((selector) => `#react-rewrite-root ${selector}`).join(",\n")} {
  display: none !important;
}

/*
 * Inset the app so the chrome never covers what you are editing.
 *
 * Padding on a border-box <html> rather than margins on <body>: the app sets
 * \`html.h-full\` + \`body.min-h-full\`, so a body margin would be *added* to a
 * height that already fills the viewport and put every page into overflow.
 * Padding inside a border-box root shrinks the containing block instead.
 *
 * Not a transform — a transformed ancestor would break the app's own layoutId
 * shared-element morphs (docs/agent-rules/card-reader-morph.md). The tradeoff
 * is that the app's own \`position: fixed\` chrome is viewport-anchored and does
 * not move with the inset; that is inherent to any non-transform inset.
 */
html.designlayer-active {
  box-sizing: border-box;
  padding: var(--de-top) var(--de-right) 0 var(--de-left);
}

/*
 * A design tool hit-tests what is PAINTED. \`pointer-events\` is a statement
 * about the app's own behaviour — it is not a statement about the drawing.
 *
 * shadcn's button ships \`[&_svg]:pointer-events-none\` so that a click on a
 * glyph counts as a click on the button. 58 of the 70 icons live on this app's
 * home screen inherit it, and an element the pointer cannot see never reaches
 * \`elementsFromPoint\`, so \`toSelectable\` was never handed an \`<svg>\` and no
 * icon in the app could be selected at all — which is why the inspector's Icon
 * section never rendered. The 12 icons that happened to keep \`auto\` selected
 * correctly all along; that split is what named hit-testing, not the resolver,
 * as the defect.
 *
 * \`all\` rather than \`auto\`: \`auto\` on an \`<svg>\` answers only where the glyph
 * is actually inked, and the centre of an outline icon — the point you aim at —
 * is a hole. Scoped to inspecting mode, so interactive mode hands the app back
 * its own hit behaviour unchanged. The chrome's own glyphs are swept up too and
 * do not care: a click on one still bubbles to the button that owns it.
 */
html.designlayer-inspecting svg {
  pointer-events: all;
}

@media (prefers-reduced-motion: reduce) {
  /*
   * The ROOTS are in this list, and they were the hole in it.
   *
   * \`el()\` stamps the attribute on every node it builds, so \`[data-designlayer] *\`
   * reaches everything the chrome contains — but not the handful of elements
   * that are themselves a root. Four surfaces are mounted straight onto
   * \`<body>\`, and one of them is the token popover, which is also the surface
   * most recently given an entrance. A blanket that covers a popover's contents
   * and not the popover is a blanket with the arrival still in it.
   */
  /*
   * \`:root\` IS IN THIS LIST, AND LEAVING IT OUT WAS A REAL HOLE.
   *
   * The palette's crossfade above is declared on \`:root\` — that is \`<html>\`,
   * which carries \`data-de-theme\` but NOT \`data-designlayer\`, so neither
   * selector below reached it. Custom properties inherit, so the whole chrome
   * dissolved over 250ms for a reader who had asked for none: every
   * descendant's own transition was dutifully clamped while the VALUES they
   * read were still interpolating at the root above them.
   *
   * Worth stating plainly, because the comment on that rule claimed it was
   * covered. A blanket is only as good as the roots it names.
   */
  /*
   * The kit's backstop (\`css/base.css\`): transitions at ZERO duration and zero
   * delay, animations at 0.01ms run once. A tiny nonzero transition duration is
   * not "almost off" — it is a real transition on every property that changes,
   * which defers the used value a frame and breaks any script measuring a
   * before/after rectangle. Nothing in the chrome listens for \`transitionend\`
   * (\`core/leave.ts\` uses a timer for exactly this reason), so a zero duration
   * that never fires the event costs nothing.
   */
  :root,
  [data-designlayer],
  [data-designlayer] *, [data-designlayer] *::before, [data-designlayer] *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
  /*
   * Reduced motion is FEWER and GENTLER, not none.
   *
   * The blanket rule above is right for hover tints and field borders, where
   * the movement is the only thing being taken away. Standing the editor down
   * is a whole surface leaving, and cutting that to 0.01ms leaves three panels
   * teleporting — the jarring change the transition exists to prevent, handed
   * to the people least able to take it.
   *
   * So the surfaces keep a crossfade and give up the travel: no slide, no
   * quarter turn. \`visibility\` stays in the transition, delayed out and
   * immediate back, because without it the element would be gone on the first
   * frame and the fade would play to nobody. Written as the shorthand so it
   * replaces the blanket's duration outright rather than negotiating with it
   * property by property.
   *
   * The toolbar is in this list for the duration only — it fades and holds
   * still for everyone now, so reduced motion has nothing left to take off it.
   * Its \`translateX(-50%)\` is centring, not motion, and is restated here
   * because the panels' \`transform: none\` beside it must not reach the bar.
   */
  .de-panel, .de-toolbar, .de-launcher {
    transition: opacity ${t.duration.hover} linear, visibility 0s !important;
  }
  .de-panel, .de-launcher { transform: none !important; }
  .de-toolbar { transform: translateX(-50%) !important; }
  .de-launcher { opacity: 0; }
  html.designlayer-chrome-hidden .de-panel,
  html.designlayer-chrome-hidden .de-toolbar {
    opacity: 0;
    transition: opacity ${t.duration.hover} linear, visibility 0s linear ${t.duration.hover} !important;
  }
  html.designlayer-chrome-hidden .de-launcher { opacity: 1; }
}

/*
 * THE TYPOGRAPHIC DECISIONS THAT BELONG TO THE WHOLE CHROME, NOT TO A
 * COMPONENT.
 *
 * Face and size are obvious. The rest are here because each of them is a
 * property that is wrong the moment a second rule declares it.
 *
 * SMOOTHING is the pair \`better-typography\` names: "apply
 * \`-webkit-font-smoothing: antialiased\` and \`-moz-osx-font-smoothing:
 * grayscale\` once on the root layout, never per component". Only the first half
 * was here, which is the half Chromium and WebKit read — so on macOS Firefox
 * the entire chrome kept subpixel antialiasing and rendered a visible notch
 * heavier than the same build in Safari. One declaration, one browser, and the
 * whole frame around the product a different weight in it.
 *
 * TABULAR FIGURES, and this is the one that is a judgement rather than a
 * transcription, so it is argued rather than asserted.
 *
 * The rule is "tabular-nums on any value that changes". Taken literally that is
 * a per-component decision, and it had been taken that way: nine rules across
 * eight files each declared it for one span, and the list of what they covered
 * — the canvas badge, a numeric input, the tab count, the note index, the saved
 * tally, a library count, a token detail, the selection count — is a list of
 * the numbers somebody happened to be looking at when they noticed. The ones
 * left out are the same kind of thing: the lint group's count, the summary
 * line's issue total, an options folder's "12 controls · 3 choices", every
 * button whose label counts what it is about to act on.
 *
 * That split is not a hierarchy, it is coverage, and coverage is what a root
 * declaration is for. This chrome is an instrument panel: essentially every
 * numeral it prints is a measurement, a coordinate, a count or a port, and
 * essentially every one of them is rewritten in place while the reader watches.
 * The cost on the other side is real and small — proportional digits inside a
 * sentence of prose set marginally better — and a 240px panel of 12px type is
 * not where that difference is spent.
 *
 * So it is declared once and the nine per-component copies are gone. What is
 * NOT redundant is the rule below: a form control gets the UA's \`font\`
 * shorthand, which resets \`font-variant\` to normal, so an \`<input>\` does not
 * inherit this no matter where it sits.
 *
 * LEADING is \`type.leadingRow\` and is unitless for the reason argued on the
 * token: a flat \`16px\` here inherited onto the \`micro\` rung as 1.6 and onto
 * \`body\` as 1.33, which is under the 1.4 floor for anything that wraps — and
 * eleven rules in \`css/\` had already opted out of it to say so.
 *
 * WRAPPING, last, and root-level for a reason specific to this surface.
 *
 * \`text-wrap: pretty\` keeps a single short word off the final line. The usual
 * caution is to put it on descriptions and keep it out of long-form text,
 * because browsers spend real layout work on a long paragraph and evening one
 * out is not worth it. There is no long-form text in this chrome. The longest
 * run anywhere in it is a three-line hint in a 240px panel, and there are
 * perhaps thirty such runs — every one of them a description in the sense the
 * rule means, and every one of them at a width where a one-word last line is a
 * third of the box wasted.
 *
 * So the alternative to one inherited declaration is thirty, added one at a
 * time by whoever next notices an orphan. It costs nothing where it does not
 * apply: a single-line label has no final line to fix, and a rule that sets
 * \`white-space: nowrap\` or \`pre\` keeps its mode (see the note on the rule).
 * Headings that want \`balance\` instead say so locally — \`.de-empty\` below is
 * the one place in the chrome that does.
 */
[data-designlayer] {
  box-sizing: border-box;
  font-family: ${t.font.ui};
  font-size: ${t.type.body};
  line-height: ${t.type.leadingRow};
  font-variant-numeric: tabular-nums;
  /* The STYLE longhand, never the \`text-wrap\` shorthand. \`el()\` stamps this
     attribute on every node, so the shorthand's \`text-wrap-mode: wrap\` was
     DECLARED on each of them — beating the \`nowrap\` their parents set, since a
     declaration beats an inherited value. Layer names and button labels wrapped
     onto two lines. \`text-wrap-style\` leaves the mode alone. */
  text-wrap-style: pretty;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
/*
 * The figures again, for the elements that do not inherit them.
 *
 * Every UA ships \`font: <something>\` on form controls, and the \`font\`
 * shorthand resets \`font-variant\` — so a control inside the chrome computes
 * \`font-variant-numeric: normal\` however the root is set. The stylesheet
 * already works around the size and face half of this by writing
 * \`font-family: inherit; font-size: …\` on every field, button and select it
 * draws; this is the third property in that set and was the one nobody knew to
 * restate, which is how the inspector's numeric input came to be the only
 * control in the panel that had it.
 *
 * \`:where()\` so it is beaten by anything, and the four elements by name rather
 * than \`*\`, because only these carry the UA's shorthand.
 */
[data-designlayer] :where(input, textarea, select, button) {
  font-variant-numeric: inherit;
}
/*
 * Ink is declared at the ROOTS of the chrome, not on every node of it.
 *
 * \`el()\` stamps CHROME_ATTR on everything it builds — 1604 elements in a live
 * session against 4 actual roots — so declaring \`color\` on the bare attribute
 * re-asserted white on every descendant. A directly matching declaration beats
 * an inherited value at any specificity, so this silently switched inheritance
 * off for the whole editor: a surface could flip its ink and none of its
 * children would follow. That is how the selected token row came to draw dark
 * text and a WHITE check mark on the same light-indigo fill, at 1.9:1.
 *
 * \`accentFill\` cannot own its way out of this — it emits fill and ink together
 * on the surface, and the bug was that no child could hear it. \`:where()\` keeps
 * the specificity at (0,1,0), unchanged from the rule this splits.
 */
[data-designlayer]:where(:not([data-designlayer] *)) {
  color: ${t.color.text};
}
[data-designlayer] *, [data-designlayer] *::before, [data-designlayer] *::after {
  box-sizing: border-box;
}
/*
 * Every corner in the chrome is a squircle, set in one place.
 *
 * \`corner-shape\` is not inherited, so this has to name every node rather than
 * be declared once at the root — and naming them here is the point. The
 * alternative is a \`corner-shape\` beside each of the ~70 \`border-radius\`
 * declarations in this stylesheet, which is 70 chances to forget one, and a
 * single square corner in a surface of smooth ones is exactly the kind of
 * wrongness that gets noticed without being identified.
 *
 * Harmless where there is no radius: \`corner-shape\` draws nothing on a
 * \`border-radius: 0\` box, so the universal selector costs those elements only
 * the declaration. \`box-shadow\` follows the corner shape too, so the panels'
 * casts stay on the outline rather than tracing an arc the surface no longer has.
 *
 * \`:where()\` keeps it at zero specificity — a rule that reaches every element
 * in the chrome must be the thing everything else beats, or opting one control
 * out becomes an \`!important\`.
 */
:where([data-designlayer], [data-designlayer] *),
:where([data-designlayer] *::before, [data-designlayer] *::after) {
  corner-shape: ${t.cornerShape};
}
/*
 * A circle has no corners, so it does not get the corner treatment.
 *
 * These nine are the chrome's round things — the launcher disc, the numbered
 * note pins, the swatches, the two switch knobs. At \`border-radius: 50%\` the
 * corner box is the whole side, so a superellipse does not smooth these, it
 * reshapes them: the disc becomes a rounded square. That is a different object.
 * The launcher is a disc on purpose — see \`css/launcher.ts\`, where the reason
 * is that it must read as a way back into the editor and not as a badge the
 * app has grown — and a squircled pin reads as a chip rather than a map marker.
 *
 * One rule rather than a \`corner-shape: round\` on each: the principle is
 * single ("circles opt out"), so the place that states it should be single too.
 *
 * A PILL OPTS OUT FOR THE SAME REASON, and that is the case this list missed.
 *
 * It was written for the discs, and the two switch KNOBS were added to it while
 * their TRACKS were left behind. A track is 28x16 under a 16px radius, which
 * CSS clamps to 8 — the corner box is the whole side, precisely the condition
 * the paragraph above describes. So the superellipse did not smooth the cap, it
 * squared it: a circular knob sat in a rounded RECTANGLE, tangent to the
 * straight top and bottom with a crescent of track showing past its end. Two
 * different curves 1px apart on a control 16px tall.
 *
 * It is the one shape \`nest()\` cannot catch. That guard refuses a pill outright
 * — "a radius at or past half the height is the ABSENCE of a step on the ramp"
 * — which is right, because there is no offset arithmetic to do, and it means
 * nothing was ever going to check that these two curves agreed.
 */
.de-launcher,
.de-ann-marker, .de-ann-marker::before,
.de-ann-index,
.de-ann-toggle, .de-ann-toggle::after,
.de-lib-switch, .de-lib-switch::after,
.de-instance-switch, .de-instance-switch::after,
/*
 * Five more, found by sweeping the sheet for \`50%\` and for a radius past half
 * the height rather than by remembering.
 *
 * That is the point worth recording: this list has now been wrong three times,
 * and each time for the same reason — it is maintained by hand against a rule
 * that a machine could check. The severity dot and the lint disc are plain
 * \`50%\` circles that were rendering as rounded squares; \`.de-opt-chip\` is a
 * pill at \`radius["3xl"]\` on a 20px box, which is the clamp case the paragraph
 * above describes.
 *
 * That sweep now exists — \`test/concentric-cases.mjs\`, "every circle in the
 * chrome has opted out of the squircle". It flags any rule declaring \`50%\`, or
 * a radius at or past half its own declared height, that is not named here. It
 * immediately found four more than the eye had: the align pad's dot, the
 * annotation hint pill, the layers drop line and the library's busy bar. The
 * list below is still where the decision is recorded; it can no longer be
 * silently incomplete.
 */
.de-lint-dot,
.de-opt-chip,
.de-pad-cell::before,
.de-layer-drop,
.de-mcp-state,
/* The insert line: a 2px rule under a 4px radius is a pill. Its outline
   variant is a box around an empty container, and keeps the squircle. */
.de-insert-indicator:not(.de-insert-indicator--outline) {
  corner-shape: round;
}
/*
 * \`.de-lib-status[data-de-busy]::after\` STOOD HERE and no longer needs to.
 *
 * It is the travelling sweep under the project scan's status line, and it was
 * listed because a \`radius.xs\` on a two-pixel-high bar is a circle by this
 * audit's arithmetic. That radius has gone — see \`css/libraries.ts\`, where the
 * reasoning lives: the caps it drew sat where the gradient had already faded to
 * transparent, so it rounded nothing visible. With no radius the rule is not a
 * round shape and has nothing to opt out of.
 *
 * Worth keeping the note, because the sweep now carries a second selector for
 * the sign-in dialog's waiting sentence, and a grouped rule can never satisfy
 * this list: the check compares each comma-separated entry against a rule's
 * WHOLE selector. Anybody who puts a radius back on that bar will find this
 * test failing with no way to silence it, and the answer is not to split the
 * rule — that spends a second infinite animation against a budget of five.
 */
/*
 * The UA's own button padding, gone — once, here, rather than in each rule that
 * remembers.
 *
 * Chrome ships \`padding: 1px 6px\` on every \`<button>\`. Every icon button in
 * this chrome then pins an explicit square — 18, 24, 32 — and with
 * \`border-box\` those twelve horizontal pixels come out of the CONTENT box, so
 * a 32px tool is really 20px wide inside and an 18px mini is really 6px. The
 * note-row actions are what this cost: a 16px glyph in a 6px box, drawn 4x16.
 *
 * Fixing that per rule is the arrangement that produced it. Three of the ten
 * icon-button classes had remembered \`padding: 0\` and the rest had not, and
 * nothing distinguishes the two groups except which one somebody had already
 * been bitten by. Resetting here means an icon button is square by default and
 * a control that genuinely wants padding says so — which every text button in
 * the chrome already does, because the UA's 6px was never enough for one.
 *
 * Wrapped in \`:where()\` so it weighs nothing. \`[data-designlayer] button\` is
 * (0,1,1) — heavier than the (0,1,0) of every \`.de-\` class in this stylesheet
 * — so as a plain selector this would not remove the UA's padding, it would
 * overrule the deliberate padding on every text button in the chrome. A reset
 * has to be the thing everything else beats.
 */
:where([data-designlayer] button) { padding: 0; }
/* Glyphs are decorative and live inside buttons. Leaving them hit-testable
   makes \`event.target\` an <svg> on half the clicks in the chrome, and every
   handler that reads a dataset off the target then reads undefined. */
/*
 * \`flex: none\` is the guard that makes a squashed glyph impossible.
 *
 * Every icon button in this chrome is a flex container, so its \`<svg>\` is a
 * flex item, and a flex item's default \`min-width: auto\` does not protect a
 * replaced element the way it protects text — the browser will happily shrink a
 * 16px glyph to 4px to fit a content box that some other rule made too narrow.
 * That is exactly what a forgotten UA \`padding: 1px 6px\` did to the note-row
 * actions: 4x16, drawn as a smear, and nothing anywhere reported an error.
 *
 * With this, the same mistake overflows instead. An icon spilling past its
 * button is seen by the first person who looks at the screen; an icon quietly
 * rendered at a quarter width is not, because it still looks like an icon.
 */
[data-designlayer] svg { pointer-events: none; display: block; flex: none; }

/*
 * POINTER FOCUS PAINTS NOTHING (MICRO-INTERACTIONS § 3).
 *
 * Every ring in the chrome is keyed on \`:focus-visible\`, and \`core/focus.ts\`
 * hands each script focus the modality it came from. This is the backstop for
 * what neither of those reaches: the UA's own \`:focus\` outline on a control
 * that never declared a ring, which a click would otherwise leave drawn beside
 * that control's hover and selected paint. Keyboard focus is untouched.
 */
:where([data-designlayer]):focus:not(:focus-visible) { outline: none; }

/*
 * AUTO-HIDING SCROLLBARS (MICRO-INTERACTIONS § 13), as the chrome-wide default.
 *
 * The track is always reserved, so a thumb appearing reflows nothing. The thumb
 * is a 12px track with a 3px transparent border — a slim floating pill — clear
 * at rest, inked while its scroller is scrolling (\`data-scrolling\`, written by
 * \`shell/shell.ts\`), and — darker — while the pointer is on the bar itself.
 * Pointing at the panel does not ink it: a bar that lights whenever the cursor
 * is anywhere in a panel is furniture again. A pill, so it opts out of the
 * squircle.
 *
 * \`:where()\` so a surface that draws its own scrollbar (the panel body, the tab
 * pane) still wins with a plain class. \`-webkit-\` only, deliberately: in
 * Chromium, setting the standard \`scrollbar-width\` / \`scrollbar-color\` on an
 * element switches its \`::-webkit-scrollbar\` rules off, so declaring them here
 * at zero specificity would silently erase every per-surface scrollbar in the
 * chrome. Firefox keeps its native overlay bar, which already auto-hides.
 */
:where([data-designlayer], [data-designlayer] *)::-webkit-scrollbar { width: 12px; height: 12px; }
:where([data-designlayer], [data-designlayer] *)::-webkit-scrollbar-track,
:where([data-designlayer], [data-designlayer] *)::-webkit-scrollbar-corner { background: transparent; }
:where([data-designlayer], [data-designlayer] *)::-webkit-scrollbar-thumb {
  background-color: transparent;
  border: 3px solid transparent;
  background-clip: padding-box;
  /* \`radius.sm\` on the 12px box leaves 5px inside the 3px border, past half the
     6px thumb, so the ends are fully round without leaving the ramp. */
  border-radius: ${t.radius.sm};
  corner-shape: round;
}
:where([data-designlayer][data-scrolling], [data-designlayer] [data-scrolling])::-webkit-scrollbar-thumb {
  background-color: ${t.color.scrollbarThumb};
}
:where([data-designlayer], [data-designlayer] *)::-webkit-scrollbar-thumb:hover {
  background-color: ${t.color.scrollbarThumbHover};
}

/*
 * A ROW LEAVING A LIST, stated once for every list in the chrome.
 *
 * Resolving a note, deleting one, removing a library: three surfaces, one
 * moment, and until now three instances of the row simply ceasing to exist
 * while the list snapped shut around the hole. These are terminal acts, and
 * "the thing you were looking at is gone" is the same appearance as a list that
 * failed to draw.
 *
 * Here rather than in each sheet because it is one idea. The alternative is
 * what the chrome already had too much of — the same pattern solved separately
 * in \`annotations.ts\` and \`libraries.ts\`, free to drift apart by a rung.
 *
 * \`height\` is animated from a value \`core/leave.ts\` measures and pins one frame
 * earlier: a row's height is its content's, so there is nothing for CSS alone
 * to animate from. Everything that contributes vertical space goes to zero with
 * it — padding, borders and the flex gap the list sets — or the row leaves
 * behind a few pixels of nothing. \`overflow: hidden\` keeps the contents from
 * spilling as the box closes, and \`pointer-events: none\` means a row on its way
 * out cannot take a second click.
 *
 * The blanket above clamps all of this to 0.01ms under reduced motion, which is
 * the right answer here: the row goes at once, and \`leaveRow\`'s timer settles
 * on the next frame rather than waiting out a duration nothing is using.
 */
/*
 * A DIALOG ARRIVING (MICRO-INTERACTIONS § 8), stated once for the chrome.
 *
 * The kit's modal entrance: scale 0.96 -> 1 over \`reveal\` on \`easeReveal\`,
 * in place. It never slides — a slide claims a place the card came from — so
 * the old \`translateY(--de-arrive-rise)\` is gone and the variable is ignored,
 * and it never springs: \`easeSpring\` is kept for drops, reorders and the
 * launcher landing. Opacity rides the same keyframe rather than the kit's
 * separate 180ms linear fade: \`easeReveal\` has most of the opacity up inside
 * the first 100ms anyway, and one keyframe keeps the motion budget flat.
 *
 * \`--de-arrive-origin\` still aims the scale when a placer writes it
 * (\`arriveFrom\` in \`core/motion.ts\`); a modal leaves it at the centre.
 *
 * WHO SHOULD WEAR IT. Dialogs: the shortcuts sheet and the sign-in dialog. The
 * kit opens MENUS AND POPOVERS INSTANTLY, in final geometry, so the layer
 * menu, the app chooser's menu and the token popover do not wear it.
 */
@keyframes de-arrive {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
}
.de-arrive {
  animation: de-arrive ${t.duration.reveal} ${t.easeReveal};
  transform-origin: var(--de-arrive-origin, center);
}
/*
 * THE MATCHING EXIT IS NOT A CLASS. An exit needs the node to outlive the
 * dismissal that removed it, and every dismissible surface in this chrome has a
 * contract that says the opposite: the shortcuts sheet and the layer menu are
 * on the Escape stack, where a surface still present absorbs the next
 * dismissal; a modal's backdrop keeps taking clicks; the annotation composer is
 * asserted gone the moment a note is saved. Deferring the removal once broke
 * twelve cases across four surfaces.
 *
 * So the node is removed at once and the exit plays on a ghost: \`playExit\` in
 * \`core/motion.ts\` clones the surface into an inert, aria-hidden, pointer-dead
 * copy pinned over its old box and fades it with the kit's dismissal — to 0.99
 * for a menu or popover, to 0.98 on \`easeExit\` for a dialog, 150ms either
 * way. "Closed" and "still painted" stop being the same question.
 */

/*
 * The other direction: a group opening to its own height.
 *
 * Paired with \`.de-leaving\` below and on the same rung, because they are one
 * vocabulary — a list closing over a row and a disclosure opening under a
 * toggle are the same statement about a panel changing size. The height is
 * measured and written by \`core/leave.ts\`; this is only the curve.
 */
.de-entering {
  transition: height ${t.duration.reveal} ${t.ease}, opacity ${t.duration.hover} ${t.ease};
}

.de-leaving {
  overflow: hidden;
  opacity: 0;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  border-top-width: 0 !important;
  border-bottom-width: 0 !important;
  /*
   * The GAP goes too, and it cannot be zeroed — it belongs to the list, not to
   * the row. Every list this runs in is a flex column with a \`gap\`, and a row
   * that collapses to nothing still reserves one, so the list would close onto
   * a few pixels of hole and then snap them shut on the rebuild.
   *
   * \`core/leave.ts\` reads the container's own \`row-gap\` and writes it here, so
   * the margin cancels exactly one gap — the one that genuinely disappears with
   * this row — and writes zero when the row is the list's only child, where
   * there is no gap to cancel.
   */
  margin-block: 0 calc(-1 * var(--de-leave-gap, 0px)) !important;
  pointer-events: none;
  transition:
    height ${t.duration.reveal} ${t.ease},
    opacity ${t.duration.hover} ${t.ease},
    padding ${t.duration.reveal} ${t.ease},
    border-width ${t.duration.reveal} ${t.ease},
    margin ${t.duration.reveal} ${t.ease};
}

/*
 * COMPANION CONTRACT — two values here are depended on from outside this
 * repository, where no repo-wide sweep will ever find them.
 *
 * A companion bundle under \`~/.local/share/designlayer/companions/<name>/\` is
 * concatenated after \`dist/designlayer.js\` (see readCompanionBundles in
 * runtime/launcher.mjs) and is built from its own source. The Agentation
 * companion's \`src/entry.jsx\` hardcodes 2147483050 — one above the z-index
 * below — to lift its pins over the panels, and reads \`--de-bar-right\` to dock
 * its bar into the canvas lane.
 *
 * So renaming the \`de-\` prefix, or moving this z-index, breaks a companion
 * silently as far as this repository is concerned: the toolbar parks under the
 * inspector and its pins paint behind the panels. Change those two values in
 * the companion's source and rebuild it (\`node build.mjs\` in that folder) in
 * the same change.
 */
.de-root {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
}
.de-root > * { pointer-events: auto; }

/*
 * THE ESCAPE STOP: clipped until it is focused, then a real control.
 *
 * The keyboard's way back OUT of the chrome — \`shell/shell.ts\` argues why it is
 * this and not a skip link. What it needs from a stylesheet is the oldest trick
 * in the accessibility book, and the two halves both matter.
 *
 * CLIPPED, NOT HIDDEN. \`display: none\`, \`visibility: hidden\` and
 * \`width/height: 0\` all remove the button from the tab order, which is the one
 * thing it exists to be in. A 1px box with \`clip-path: inset(50%)\` is out of
 * the reader's way and still focusable. \`white-space: nowrap\` stops the label
 * wrapping into a tall sliver of a box that is about to be one pixel wide, and
 * \`overflow: hidden\` keeps the text from painting outside the clip in engines
 * that lay it out first.
 *
 * FOCUSED, IT BECOMES ORDINARY. The clip is released and it lands top-centre,
 * over the app, styled like the rest of the chrome — it is the first thing a
 * keyboard user sees of this editor, so it has to look like it belongs to it.
 * Top-centre because that is where the toolbar is, so the thing appearing is
 * where the thing it talks about already lives.
 *
 * \`:focus\`, not \`:focus-visible\`. This control is unreachable by pointer — it
 * has no hit area to click — so every focus it can receive is a keyboard focus,
 * and \`:focus-visible\` would add a heuristic with nothing to decide.
 */
.de-escape {
  position: fixed;
  top: 0; left: 50%;
  width: 1px; height: 1px;
  margin: 0; padding: 0;
  border: 0;
  clip-path: inset(50%);
  overflow: hidden;
  white-space: nowrap;
  background: ${t.color.bgRaised};
  color: ${t.color.text};
  font-family: inherit; font-size: ${t.type.body};
  cursor: pointer;
}
.de-escape:focus {
  width: auto; height: auto;
  padding: ${t.space.sm}px ${t.space.md}px;
  transform: translate(-50%, ${t.space.sm}px);
  /* The kit's skip link: a \`radius.md\` card, ringed 2px out in the accent. */
  border-radius: ${t.radius.md};
  box-shadow: ${t.shadow.float};
  clip-path: none;
  outline: 2px solid ${t.color.accent};
  outline-offset: 2px;
}

/*
 * Inside .de-root's stacking context, canvas chrome sits below the panels.
 * Without an explicit order the positive-z overlay layer would paint over the
 * toolbar, and its handles would swallow toolbar clicks.
 *
 * The panels are named here by the rail that holds them rather than by
 * themselves: they are flex children of \`.de-rail\` now, so the rail is the
 * child of \`.de-root\` this ordering is about. Giving \`.de-panel\` a z-index of
 * its own as well would be worse than redundant — inside the rail it would
 * raise each panel over the zero-width seam sitting on its edge, and the half
 * of the seam's grab strip that overlaps the panel would stop being grabbable.
 */
/*
 * THE EDITOR'S OWN ARRIVAL, borrowed from its exit.
 *
 * \`shell/shell.ts\` mounts the root wearing this class and takes it off two
 * frames later, so the chrome plays its stand-down backwards on the way in:
 * panels slide off their edges, the bar is transparent, and both settle. The
 * alternative was a second set of rules describing the same movement in the
 * opposite direction, free to drift from the first.
 *
 * It reuses the hidden-state selectors deliberately rather than restating their
 * transforms — those live in \`css/panels.ts\` and \`css/toolbar.ts\` beside the
 * reasoning for the distances, and a copy here would be a second place to
 * change them. Reduced motion needs nothing either: the blanket above already
 * governs the rules this leans on.
 *
 * The launcher is excluded. It is the thing you press to bring the editor BACK,
 * so it belongs to the hidden state and has no business appearing during an
 * arrival that ends with it hidden.
 */
.de-root--arriving .de-panel--left { transform: translateX(-100%); }
.de-root--arriving .de-panel--right { transform: translateX(100%); }
.de-root--arriving .de-toolbar { opacity: 0; }

.de-overlay-layer { z-index: 1; }
.de-toolbar, .de-rail { z-index: 2; }
/*
 * Above both, and it has to be: the launcher is the only way back once the
 * editor is hidden, and while it is animating out the panels it sits over are
 * still on screen.
 */
.de-launcher { z-index: 3; }


/*
 * The live region, present in the layout and invisible in it.
 *
 * Not \`display: none\` and not \`visibility: hidden\`: neither is announced,
 * which would make the region decorative. The 1px clip is the long-standing
 * visually-hidden recipe, and it is 1px rather than 0 because some engines skip
 * a zero-area node entirely.
 *
 * No \`margin: -1px\`. The classic recipe carries one to keep the node from
 * affecting layout, which matters for a statically-positioned element and not
 * for this one — it is absolute, so it is already out of flow, and the negative
 * margin is a value off the spacing scale bought for nothing. The token suite
 * flags exactly that, and it was right to.
 */
.de-announcer {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
`
