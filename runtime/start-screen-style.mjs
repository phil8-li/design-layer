/**
 * The start screen's stylesheet, kept out of the page module so both stay
 * readable and under the file limit.
 *
 * Every colour, radius, shadow, face and curve is lifted from the vendored
 * chrome tokens into custom properties once, at the top, so the rules below are
 * plain CSS instead of a template literal with an interpolation on every line.
 * Nothing here may name a colour directly: the start screen is the same chrome
 * as the editor it launches, and it has to stay that way when the rung moves.
 *
 * `dist/` is gitignored and built by `prepare`, so the tokens module is always
 * there in an install — but a source checkout that was never built would
 * otherwise fail with a bare module-resolution error naming a path the reader
 * has no reason to recognise. This is the one place the bundle is loaded, so
 * this is the one place that has to say what to do about it.
 */

let tokens
try {
  ;({ tokens } = await import("../dist/tokens.mjs"))
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error
  throw new Error("designlayer: the token bundle is missing — run `npm run build` in the package")
}

const { color, radius, shadow, font, type, ease, easeReveal, duration, cornerShape } = tokens

export function startScreenStyle() {
  return `
:root {
  color-scheme: dark;
  --bg: ${color.bg};
  --bg-raised: ${color.bgRaised};
  --bg-sunken: ${color.bgSunken};
  --border: ${color.border};
  --border-strong: ${color.borderStrong};
  --border-interactive: ${color.borderInteractive};
  --text: ${color.text};
  --text-muted: ${color.textMuted};
  --text-dim: ${color.textDim};
  --accent: ${color.accent};
  --accent-soft: ${color.accentSoft};
  /*
   * The TEXT rung of the accent fill: the button carries a word, so it owes
   * 4.5:1 rather than the 3:1 a glyph owes. With the kit's indigo one rung
   * already clears both (white on it is 4.97:1 dark, 6.7:1 light), but the
   * page asks for the text role by name so it stays right if the rungs split.
   */
  --accent-surface: ${color.accentSurfaceText};
  --accent-surface-hover: ${color.accentSurfaceTextHover};
  --on-accent: ${color.onAccent};
  --field: ${color.field};
  --field-hover: ${color.fieldHover};
  --row-selected: ${color.rowSelected};
  --danger: ${color.danger};
  --bg-hover: ${color.bgHover};
  --segment-selected: ${color.segmentSelected};
  /*
   * The kit's radius ladder, by role. Fields and the buttons beside them
   * share ONE corner, 12 — the same proportion the editor's 8px controls keep
   * at 24px tall; the kit's 16/14 are pills at 32–40px and made the buttons
   * rounder than the fields next to them. Cards take the card rung (16) and
   * list rows the row-highlight rung (12).
   */
  --radius-field: ${radius.lg};
  --radius-button: var(--radius-field);
  --radius-row: ${radius.lg};
  --radius-card: ${radius["3xl"]};
  --corner: ${cornerShape};
  --shadow: ${shadow.float};
  --font: ${font.ui};
  --mono: ${font.mono};
  --ease: ${ease};
  --ease-reveal: ${easeReveal};
  /* The kit's hover tween, for every wash, press and colour change. Out of the
     same bundle as the chrome, so this page and the editor it is about to open
     keep one clock. */
  --hover: ${duration.hover};
  --weight-body: ${type.weightBody};
  --weight-value: ${type.weightValue};
  --weight-section: ${type.weightSection};
  --weight-title: ${type.weightTitle};
  --tracking-eyebrow: ${type.trackingEyebrow};

  /*
   * The token type scale is the editor's density — the kit's caption and badge
   * roles — because it was cut for a 240px docked panel. This card is the full
   * window and its field is the primary control of the whole product, so it
   * carries the kit's PRODUCT roles: body-sm (14) is the UI workhorse and body
   * (16) the lede and the address field, which is also the size iOS will not
   * zoom a field at. The label rung is still the token's caption size, which is
   * what keeps the two surfaces related. The tokens carry no body-sm/body
   * sizes, so the two kit values are written here.
   *
   * (It read "11/10/9" until this pass, which is what the ramp was two moves
   * ago. A comment describing a scale by its numbers is a comment that goes
   * stale every time the scale moves, so the one number this block actually
   * depends on is interpolated below rather than written out.)
   */
  --size-label: ${type.body};
  --size-body: 14px;
  --size-lede: 16px;
  --size-url: 16px;

  /*
   * ONE CONTROL HEIGHT, for every box on the card: the two fields, the script
   * select, the app rows and all three buttons. The primary used to be 40 and
   * the ghost 32, so Continue and Switch app sat side by side at two heights
   * with their text on two baselines.
   */
  --control-height: 36px;

  /*
   * The leading, from the same token block as the chrome's.
   *
   * These were literals in the rules below — a \`/1.5\` inside \`body\`'s \`font\`
   * shorthand and nothing anywhere else, so every other line of text on this
   * screen was leaded by inheritance and nobody could say from what. The chrome
   * grew named leading roles in this pass; the start screen takes them for the
   * same reason it takes the colours, which is that the two surfaces are one
   * product and only one of them should get to decide what "body leading" is.
   */
  --leading-row: ${type.leadingRow};
  --leading-body: ${type.leadingBody};
}

*, *::before, *::after { box-sizing: border-box; }
/* Every corner is the kit's squircle; a true circle opts back out (\`.pulse\`). */
@supports (corner-shape: round) {
  *, *::before, *::after { corner-shape: var(--corner); }
  .pulse { corner-shape: round; }
}
[hidden] { display: none !important; }

/*
 * THE CARD MOVED DOWN A RUNG, AND EVERY INK ON IT GOT LEGIBLE.
 *
 * It used to be \`bg-raised\` on a \`bg\` page — the lightest ground in the chrome
 * carrying inks that were every one of them tuned against the darkest. The
 * consequences all measured as failures on the same surface: the error text a
 * stuck user has to read came out at 3.83:1 against the 4.5:1 it owes, every
 * control boundary at 2.53:1 against the 3:1 1.4.11 asks of a component edge,
 * and an app row's own fill at 1.15:1 — a box you cannot see is not a box.
 *
 * Dropping the page to \`bg-sunken\` and the card to \`bg\` keeps the same step
 * between them, in the same direction, and moves every one of those pairs onto
 * the ground it was designed for: danger 6.04:1, boundaries 3.07:1, rows
 * 1.37:1. Nothing was retinted to get there. The elevation is unchanged because
 * it was never the background doing that work — \`shadow.float\` below is, which
 * is what \`better-ui\` means by shadows for elevation and borders for structure.
 */
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  background: var(--bg-sunken);
  color: var(--text);
  font: var(--weight-body) var(--size-body)/var(--leading-body) var(--font);
  /*
   * BOTH smoothing properties, and both figures — the three root-level
   * typographic decisions, matching what \`css/base.ts\` now declares on the
   * editor's own root.
   *
   * \`-moz-osx-font-smoothing\` was missing, which is the half Firefox reads. On
   * macOS that left this screen subpixel-antialiased and a visible notch
   * heavier than the editor it launches, in the one browser where the two
   * surfaces are most likely to be compared: the start screen opens in the
   * default browser and the editor opens in whatever the user was already in.
   *
   * Tabular figures for the port column in the app list. Three dev servers up
   * is three \`:3000\`-shaped numbers that should line up as a column and did
   * not, because the rows are a flex list and proportional digits gave each one
   * its own width.
   */
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-variant-numeric: tabular-nums;
  /* No long-form text here either — the longest run is the two-line folder
     hint — so the orphan-killer is worth one inherited declaration. See the
     same argument, at length, in \`css/base.ts\`. */
  text-wrap: pretty;
}
/* The UA's \`font\` shorthand resets \`font-variant\` on a form control, so the
   figures above do not reach the two text fields or the script select without
   this. Same rule, same reason, as the one in \`css/base.ts\`. */
:where(input, textarea, select, button) { font-variant-numeric: inherit; }

.card {
  width: min(100%, 496px);
  padding: 24px;
  display: flex;
  flex-direction: column;
  /*
   * The card is the container the form measures itself against, not the window.
   *
   * Its width is \`min(100%, 496px)\`, so at every viewport above ~530px the form
   * has exactly 448px to work with and the window's size tells it nothing. A
   * media query here would break the two-column field rows at a viewport width
   * that has no relationship to the width they actually stop fitting at. See
   * the \`@container\` at the foot of this sheet.
   */
  container-type: inline-size;
  /*
   * The rhythm is the hierarchy, and a uniform gap is the absence of one.
   *
   * \`form { display: contents }\` flattens the sections into this column, so
   * every one of them used to sit 20px from its neighbour: the header, the app
   * list, the two fields, the script row and the button, six things of equal
   * weight in one stack. Nothing in the spacing said which of them was the task.
   *
   * 28px is the between-GROUPS step, and there are now exactly three groups in
   * this column: the running apps, the description of an app, and the action.
   * \`.fields\` below holds the within-group one at 12px, which is past the 2x
   * ratio \`better-layout\` asks for before grouping reads as grouping rather
   * than as noise.
   */
  gap: 28px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow);
}

/*
 * THE h1 OF WHICHEVER FACE IS UP: "Choose an app to edit", or "Continue
 * editing <app>?" over an editor that is already running.
 *
 * It replaces a mono \`designlayer\` wordmark that named the product and asked
 * nothing. The lede rung at title weight, which is what the app's name wore
 * under that wordmark, and it stays the top step: \`.progress\`, the waiting
 * face's heading, shares the size and never outranks it. \`--size-url\` is the
 * only rung above and it belongs to a field — iOS Safari zooms one set below
 * 16px — so a heading does not borrow it.
 *
 * \`balance\` rather than the inherited \`pretty\`: a long package name in the
 * question wraps evenly instead of 52/12.
 */
.title {
  margin: 0;
  font-size: var(--size-lede);
  font-weight: var(--weight-title);
  text-wrap: balance;
}

form { display: contents; }
.section { display: flex; flex-direction: column; gap: 8px; }
/* The name and where it lives read as one fact, so they sit tighter than the
   section's rhythm. */
.current-app { display: flex; flex-direction: column; gap: 2px; }
/*
 * SENTENCE CASE, LIKE EVERY OTHER FIELD LABEL IN THE PRODUCT.
 *
 * This was \`text-transform: uppercase\` with tracking, which set the two labels
 * on this card as APP ADDRESS and CODE FOLDER — while a field label in the
 * inspector, twenty seconds later in the same session, reads "Font weight".
 * One product, two conventions, and the one a person meets first was not the
 * convention.
 *
 * Uppercase is a rank, and it was being spent on the wrong thing. These labels
 * are not a tier above the fields they name; they ARE the names of the fields.
 * The rank they do need is already carried by \`weight-section\` and
 * \`text-dim\` — the same pair the inspector uses — so dropping the transform
 * removes nothing but the shouting.
 *
 * The tracking goes with it rather than separately: 0.03em is there to keep
 * uppercase from setting too tight, and on lower case it only loosens words
 * that never needed it.
 *
 * \`.or\` below keeps both, and that is not an inconsistency. It is a separator
 * standing between two answers rather than a name attached to one, so it is a
 * different rank doing a different job — and at two letters the tracking is
 * what keeps it from reading as a typo.
 */
.label {
  margin: 0;
  font-size: var(--size-label);
  font-weight: var(--weight-section);
  color: var(--text-dim);
}

/*
 * THE TWO WAYS IN, AND THE RULE THAT SAYS THEY ARE ALTERNATIVES.
 *
 * Both of these are off by default and come on with \`.has-apps\`, which the
 * page sets the moment the scan returns rows. The reasoning is in the document
 * beside the form: a heading reading "Running apps" over an empty box, and an
 * "or" offering an alternative to nothing, are two pieces of furniture that
 * only make sense when there is something to choose between. On a cold boot
 * they are not muted or emptied, they are gone, and the fields are simply what
 * the card is.
 *
 * \`.or\` is a separator line, which \`better-layout\` ranks last of the three
 * grouping tools and allows "only where space alone can't carry the structure".
 * This is that case: 28px of space says the list and the fields are different
 * groups, and cannot say they are two answers to one question rather than two
 * steps of one task. The word does that; the hairline is what stops the word
 * reading as a heading.
 */
#apps-label, .or { display: none; }
.has-apps #apps-label { display: block; }
.has-apps .or { display: flex; }
.or {
  margin: 0;
  align-items: center;
  gap: 12px;
  font-size: var(--size-label);
  font-weight: var(--weight-section);
  /* The kit's eyebrow: caption strong, uppercase, 0.08em. */
  letter-spacing: var(--tracking-eyebrow);
  text-transform: uppercase;
  color: var(--text-dim);
}
.or::after { content: ""; flex: 1; height: 1px; background: var(--border); }

/*
 * THE SECOND ANSWER, AS ONE SHORT FORM RATHER THAN TWO STANZAS.
 *
 * Every field used to be a \`.section\`: a label, a box, and a paragraph of help
 * under it, stacked — so the two answers the editor needs took eight elements
 * and five lines of prose down the middle of the card. As rows of one grid they
 * take two lines and two shared edges, and the labels sit beside the boxes
 * where the eye tracking down the field column never has to cross them.
 *
 * 12px between rows against the card's 28px between groups is the 2x-plus the
 * grouping rules ask for, and 6px inside a row against that 12px is the same
 * ratio one level down.
 */
.fields { display: flex; flex-direction: column; gap: 12px; }
.field {
  display: grid;
  grid-template-columns: 8.5rem minmax(0, 1fr);
  align-items: center;
  gap: 6px 12px;
}
.field > .label { grid-column: 1; }
.field > input, .field > select { grid-column: 2; }
/*
 * The sentences under a row run the full width, not the field's column.
 *
 * Both of them are about a path, and a path is the longest string on the
 * screen: confined to the 300px the field column leaves, the Finder how-to
 * wrapped to two lines and a refusal naming an app wrapped to two more — four
 * ragged lines under one box, which is the shape this pass exists to stop. At
 * the card's width each is one line.
 *
 * It does not invent an edge to do it. The card's leading edge already carries
 * the title, the labels, the list and the button, so a caption on it is on
 * the sheet's primary alignment rather than off on its own.
 */
.field > .note, .field > .error { grid-column: 1 / -1; }
/*
 * EVERY SENTENCE ON THIS SCREEN CAN CONTAIN A PATH, AND A PATH DOES NOT WRAP.
 *
 * Found by rendering the card against worst-case content rather than by
 * reading it. \`#hint\` prints \`~/Projects/…\` and \`#folder-help\` prints
 * \`package.json\`; at 320px a deep path escaped the card AND the window, and
 * the page grew a horizontal scrollbar. A 60-character title with no spaces did
 * the same to \`#apps-note\`, which broke after the single word "Picked" and
 * left a one-word line above a 60-character run.
 *
 * \`overflow-wrap: break-word\` is the narrow tool for exactly this: it leaves
 * ordinary prose alone and breaks only a word that cannot otherwise fit. The
 * alternative, truncating, is wrong here — these sentences exist to tell a
 * stuck user what to do, and the part that would be cut is the path.
 *
 * \`text-wrap: pretty\` on top, so the sentences that DO fit do not strand a
 * single short word on their last line. Both are cheap and neither changes the
 * common case.
 */
.note, .error {
  margin: 0;
  font-size: var(--size-label);
  overflow-wrap: break-word;
  text-wrap: pretty;
}
.note { color: var(--text-muted); }
.error { color: var(--danger); }
code { font-family: var(--mono); color: var(--text); }

/*
 * ONE BOX, TWICE — and they were two different boxes before this pass.
 *
 * The address field was 12/14 padded with a 12px radius and the path field 7/10
 * with an 8px one, which nobody notices while they are a stanza apart and
 * everybody notices when they are two rows of the same grid: unequal heights
 * and unequal corners on a two-row form is the kind of stray edge that reads as
 * noise without being nameable. The type still differs, because the strings do
 * — see \`.path\` below.
 */
#url, .path {
  width: 100%;
  /* The kit's 36px field: a fixed height rather than padding around a line
     box, so the two boxes and the select are the same height whatever face
     and size each one's string is set in. */
  height: var(--control-height);
  padding: 0 12px;
  color: var(--text);
  background: var(--field);
  border: 1px solid var(--border-interactive);
  border-radius: var(--radius-field);
  transition: border-color var(--hover) var(--ease), background-color var(--hover) var(--ease);
}
#url { font: var(--weight-value) var(--size-url) var(--mono); }
#url::placeholder, .path::placeholder { color: var(--text-dim); }
@media (hover: hover) and (pointer: fine) {
  #url:hover, .path:hover { background: var(--field-hover); }
}

:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/*
 * Buttons take the kit's action focus instead: the edge in the accent and a
 * 3px halo of it at 30%. Drawn with \`outline\` for the edge, so the fill-only
 * primary has one too.
 */
button:focus-visible, a.primary:focus-visible, .app:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 0;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
}
/*
 * \`:focus-visible\`, and the ring is KEPT.
 *
 * Both fields used to say \`:focus { border-color: var(--accent); outline: none }\`
 * — more specific than the rule above it, so it won, and the entire keyboard
 * indicator on the two most important controls on the screen was a 1px hairline
 * changing hue. That is not an equivalent replacement for a 2px ring, and
 * \`#url\` carries \`autofocus\`, so the bare \`:focus\` also spent the accent on
 * every mouse user the instant the page loaded.
 *
 * The kit's field focus is the edge taking the accent; the ring stays on top
 * of it here because these are the two controls the whole screen is for.
 */
#url:focus-visible, .path:focus-visible { border-color: var(--accent); }

/*
 * No reserved height. Most machines run one dev server, and a list sized for
 * two left a hole under it that read as a rendering fault rather than as room.
 * The note below carries the empty case, so the list can simply not be there.
 */
/*
 * THE LIST SCROLLS PAST A HANDFUL, and it had no ceiling at all.
 *
 * Rendered against twenty running dev servers the card came out 1,327px tall
 * with no scroll region anywhere — so the two fields and the button, which is
 * the entire task, were pushed off the bottom of a normal window by a list that
 * is only a shortcut to filling them in.
 *
 * The ceiling is in rows rather than pixels, because a row is the unit a reader
 * counts in: about seven and a half, so the half-row showing at the fold is
 * itself the cue that there is more. That is the same trick the layout guidance
 * calls letting the next item peek past the scroll edge, and it is why this is
 * not a round number.
 *
 * \`overscroll-behavior: contain\` so a wheel that reaches the end of the list
 * does not carry on and scroll the card out from under the pointer.
 */
.apps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 306px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.apps:empty { display: none; }
.app {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--control-height);
  padding: 0 12px;
  /* The one physical property this stylesheet had. Logical, so a mirrored
     locale moves the label to the edge the reading starts at. */
  text-align: start;
  font: inherit;
  /* The row rung of the leading scale, which the chrome's own list rows take.
     A row is one line by construction — \`.app-name\` clips rather than wraps —
     so body leading only pads it. */
  line-height: var(--leading-row);
  color: var(--text);
  background: var(--field);
  /* At rest, and visible: a row with a transparent edge on a near-matching fill
     is a control that does not read as one. 3.07:1 on the card. */
  border: 1px solid var(--border-interactive);
  border-radius: var(--radius-row);
  cursor: pointer;
  transition: background-color var(--hover) var(--ease), border-color var(--hover) var(--ease);
}
@media (hover: hover) and (pointer: fine) {
  .app:hover { background: var(--field-hover); }
}
/*
 * CHOSEN, SAID THREE WAYS, BECAUSE IT USED TO BE SAID ZERO.
 *
 * The old rule was \`background: var(--row-selected); border-color:
 * var(--accent-soft)\` and it communicated nothing at all. The fill is 1.44:1
 * off an unchosen row — under the 3:1 a state indicator owes — and the two
 * tokens resolved to the same value, so the border it drew was invisible
 * against the fill it drew it on. A user with three dev servers up
 * could not see which one the big blue button was about to proxy.
 *
 * So: the accent edge off the chosen fill, the accent bar down the
 * leading edge, and \`.app-check\` below, which is a glyph rather than a colour
 * and is therefore the half that survives forced-colors and a colour-blind
 * reader. Colour is now the least of the three signals rather than the only one.
 */
.app[aria-checked="true"] {
  background: var(--row-selected);
  border-color: var(--accent);
  box-shadow: inset 2px 0 0 var(--accent);
}
/*
 * Hidden rather than absent, so choosing a row does not reflow the list under
 * the pointer that chose it — the next row would slide out from under a second
 * click aimed at it.
 */
.app-check { flex: none; width: 1em; color: var(--accent); visibility: hidden; }
.app[aria-checked="true"] .app-check { visibility: visible; }
.app-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-port { font-family: var(--mono); font-size: var(--size-label); color: var(--text-muted); }

/*
 * A field rather than a label, because typing or pasting a path is the way a
 * project folder is named — the only way, since the native folder panel that
 * used to sit beside it was dropped. It spans its column for that reason: it
 * shared a flex row with a Browse button, and with the button gone there is
 * nothing to share it with. It scrolls to the caret like any text input, so the
 * tail — the identifying part of a path — is what stays in view while it is
 * being typed.
 */
.path {
  font-family: var(--mono);
  /* The body rung, not the label rung. This field holds the longest, densest
     string on the screen — a 60-character absolute path — and it was set a
     third smaller than the address field, which holds the shortest. One rung
     below \`#url\` is deliberate and is the only thing left separating them:
     more of that string fits before it starts scrolling. */
  font-size: var(--size-body);
}
/* A field the user has been sent back to, tinted to match the sentence under
   it. The ring is still the platform's — see the \`:focus-visible\` note above. */
[aria-invalid="true"] { border-color: var(--danger); }

button { font: inherit; cursor: pointer; }
.ghost {
  /* The kit's outline button: transparent at rest, the ghost-hover wash on a
     pointer. Same height as the primary beside it. */
  display: inline-flex; align-items: center; justify-content: center;
  height: var(--control-height);
  padding: 0 16px;
  color: var(--text);
  background: transparent;
  border: 1px solid var(--border-interactive);
  border-radius: var(--radius-button);
  font-size: var(--size-body);
  font-weight: var(--weight-value);
  transition: background-color var(--hover) var(--ease), border-color var(--hover) var(--ease),
    color var(--hover) var(--ease), transform var(--hover) var(--ease);
}
@media (hover: hover) and (pointer: fine) {
  .ghost:hover { background: var(--bg-hover); }
}

/* The third row of the same grid as the two fields above it, so it takes the
   same box: it used to be a short, differently-tinted, differently-rounded
   control in a section of its own, which was defensible while it stood alone
   and reads as a mismatch the moment it lines up under two text fields. */
select {
  height: var(--control-height);
  padding: 0 12px;
  font: inherit;
  color: var(--text);
  background: var(--field);
  border: 1px solid var(--border-interactive);
  border-radius: var(--radius-field);
  transition: border-color var(--hover) var(--ease), background-color var(--hover) var(--ease);
}
@media (hover: hover) and (pointer: fine) {
  select:hover { background: var(--field-hover); }
}

.primary {
  /* The page's one loud control. Loud by fill, not by size. */
  display: inline-flex; align-items: center; justify-content: center;
  height: var(--control-height);
  padding: 0 16px;
  font-size: var(--size-body);
  font-weight: var(--weight-value);
  color: var(--on-accent);
  background: var(--accent-surface);
  border: 0;
  border-radius: var(--radius-button);
  transition: background-color var(--hover) var(--ease), transform var(--hover) var(--ease);
}
@media (hover: hover) and (pointer: fine) {
  .primary:hover:not(:disabled) { background: var(--accent-surface-hover); }
}
/*
 * THE PRESS, WHICH THE BUTTON THAT STARTS THE PRODUCT DID NOT ANSWER.
 *
 * Pressing this posts to the loopback server, waits for a dev server to come up
 * and then navigates — seconds, on a cold start — and for the first of those
 * seconds nothing on screen changed at all. The \`busy\` state below arrives
 * later and through a different channel, so the gap between "I clicked" and
 * "something is happening" was carried by nothing.
 *
 * The kit's press — 0.98 over the \`hover\` tween — which is the depth and the
 * clock the editor's own controls use — this page borrows the chrome's \`--ease\` and durations already, so the
 * press feels like the same product it is about to open. \`:not(:disabled)\`
 * because a button that will not act must not answer as though it had.
 *
 * \`.app\` is deliberately NOT given one. A row in a list is a selection, and it
 * answers with its own tick and the field it fills in; a row that also shrank
 * would be claiming to be a button that does something.
 */
.primary:active:not(:disabled), .ghost:active { transform: scale(0.98); }
/*
 * Still here, and it should be — but it is now reached by exactly one state.
 *
 * The submit button is no longer disabled for an unanswered field; pressing it
 * is how you find out which field that is. What is left is \`busy\`, the in-flight
 * moment between the press and the editor coming up, where a second press would
 * post a second start. That one is a real "you cannot do this yet", and it lasts
 * a second rather than the whole visit.
 */
.primary:disabled { background: var(--field); color: var(--text-dim); cursor: default; }

/*
 * Continue and Switch app: go to what is running, or go and pick something
 * else. The first is an anchor rather than a button because it goes to a URL,
 * and an anchor is the control a browser already knows how to open in a new tab
 * — which is exactly what someone with two apps in flight will want to do.
 */
/*
 * Wrapping, because at 320px it did not. The pair shredded into a 108px block of
 * three wrapped lines beside a 122px block of two — nothing clipped, but the
 * primary action stopped reading as a button. A one-word-per-line label is what
 * string growth does to a fixed row, and this row failed in English, before any
 * translation touched it.
 */
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
/* Equal halves: the same basis and the same grow, so the two buttons are one
   size side by side and one size stacked. */
.actions > * { flex: 1 1 10rem; white-space: nowrap; }
a.primary { text-decoration: none; }

.waiting { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.progress {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--size-lede);
  font-weight: var(--weight-value);
}
/* It takes focus when the form is swapped out for it, and a heading that has
   been focused should not then draw a ring as if it were a control. */
.progress:focus { outline: none; }
/* The wait stopped being a wait. The dot holds still rather than going on
   promising progress, and it takes the failure's colour so the heading and the
   sentence under it are saying the same thing. */
.progress--stalled { color: var(--danger); }
.progress--stalled .pulse { animation: none; background: var(--danger); opacity: 1; }
.pulse {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.4s var(--ease) infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .pulse { opacity: 1; }
}

/*
 * THE FIELD ROWS COLLAPSE WHERE THEY STOP FITTING, WHICH IS NOT A DEVICE SIZE.
 *
 * 8.5rem of label column plus a 12px gap leaves a box too narrow to read a URL
 * in somewhere around 360px of card, so that is where the break is — not 768,
 * and not a viewport width, because the card stops growing at 496px and the
 * window's width says nothing about the form's after that.
 *
 * Measured against the card's content box: 448px at any window above ~530px, so
 * the two-column form holds everywhere it fits and gives way only inside a
 * genuinely narrow window. At 320px, where this layout owes no horizontal
 * scroll at all, the card's content box is 240px and every row is one column.
 */
@container (max-width: 368px) {
  .field { grid-template-columns: minmax(0, 1fr); }
  .field > .label, .field > input, .field > select, .field > .note, .field > .error {
    grid-column: 1;
  }
}
`
}
