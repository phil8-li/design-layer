/**
 * The catalog shape every library reader produces, and the questions asked of
 * one once it exists: how much is in it, is it empty, and is it enough of a
 * design system to offer or to adopt.
 *
 * The two bars live here rather than in the store because two modules ask
 * them: the library store when it decides what discovery offers, and
 * `design-system-detect.mjs` when it decides whether an entry stylesheet is
 * the project's own design system. With the bars in the store, detection had
 * to import the store, the store imported detection back, and loading the
 * config pulled in the whole library store graph (URL fetching, component
 * scanning, sign-in) before anything had asked for a library. Here they depend
 * on nothing.
 */

/**
 * The absence rule, inherited from the manifest normalizer: a group the source
 * does not have is an empty axis, never an error. The inspector drops a row
 * whose category is empty, so a stylesheet with no motion scale simply has no
 * motion row.
 *
 * Exported for the sources that build a catalog without going through a parser
 * — a component list scanned off a story index, a source that could not be read
 * at all — so that the thirteen keys are declared in exactly one place.
 */
export function emptyCatalog(name) {
  return {
    name: name || "",
    trackingUnit: "px",
    colors: [],
    spacing: [],
    radii: [],
    textStyles: [],
    uiTextStyles: [],
    effects: [],
    icons: [],
    motion: [],
    components: [],
    iconDrawings: [],
    iconAttribute: "",
  }
}

/**
 * What a library brings, as numbers.
 *
 * `icons` and `iconDrawings` are two different axes that share a word: the
 * first is the icon SIZE scale a token picker offers, the second is the glyphs
 * the icon picker offers. Keeping both in one shape is what lets the panel say
 * "12 icon sizes" and "213 icons" about the same library without the caller
 * having to know which group is which.
 */
export function libraryCounts(catalog) {
  const group = (key) => (Array.isArray(catalog?.[key]) ? catalog[key].length : 0)
  return {
    colors: group("colors"),
    spacing: group("spacing"),
    radii: group("radii"),
    // UI text styles fold in here. They are text styles the library brings, and
    // the counts shape has no separate slot for them — reporting them nowhere
    // would make a manifest look smaller than it is.
    textStyles: group("textStyles") + group("uiTextStyles"),
    effects: group("effects"),
    icons: group("icons"),
    motion: group("motion"),
    components: group("components"),
    iconDrawings: group("iconDrawings"),
  }
}

export function totalTokens(counts) {
  return Object.values(counts ?? {}).reduce(
    (total, value) => total + (Number.isFinite(value) ? value : 0),
    0
  )
}

/** How many of the count groups a source actually put anything in. */
export function filledGroups(counts) {
  return Object.values(counts ?? {}).filter((value) => Number.isFinite(value) && value > 0).length
}

/** Whether a catalog brings nothing at all, in any group. */
export function isEmptyCatalog(catalog) {
  return totalTokens(libraryCounts(catalog)) === 0
}

/**
 * The bar a stylesheet clears to be OFFERED as a library, and the two shapes
 * that clear it.
 *
 * `detectLibraryKind` answers "can this file be read as a design system?", and
 * four custom properties is the right answer to THAT question: it is the
 * cheapest test that separates a stylesheet carrying tokens from one carrying
 * only rules. It is the wrong answer to the question discovery actually asks,
 * which is "would a designer ever mean this file?". Measured against a real
 * app, the four-property rule finds the project's design system and then a
 * dozen component stylesheets behind it, each declaring the two or three
 * one-off values that one component happened to need. Every one of them parses.
 * None of them is a library, and a chooser whose list is mostly noise is one a
 * designer stops reading — so the noise costs more than the misses do.
 *
 * DISCOVERY IS A RECOMMENDATION; `add` IS A CAPABILITY. Nothing here changes
 * what `add` accepts. A designer who types one of these paths into the manual
 * field still gets the library, because the editor can genuinely read the file
 * and refusing it would be the editor pretending it cannot. The bar governs
 * only what the editor volunteers unasked, which is why the store applies it
 * in its discovery scan and nowhere near the kind of a source.
 *
 * The bar is read off the PARSED catalog, never off the path. A path rule would
 * be one framework's convention — `*.component.css` is how Angular spells
 * "private stylesheet", and means nothing in a Vue, Svelte or plain-CSS project
 * — and what makes a file a design system is what is inside it.
 *
 * Two ways to clear it, because design systems come in both shapes:
 *
 *  - BREADTH. A system declares more than one axis and gives each one a scale.
 *    The shortest run of values anyone calls a scale is four steps (xs/sm/md/lg
 *    is the near-universal floor), so two axes at four steps each is eight
 *    tokens — the smallest count that is credibly a system rather than a
 *    handful of values one component needed. The component stylesheets this
 *    rule is aimed at carry one to three, so they are not near misses.
 *  - DEPTH. A file may be a single axis and still be a library: a palette is
 *    nothing but colours. With one group there is no second axis corroborating
 *    the claim, so the count has to carry it alone and the bar is higher.
 *    Twenty-four is a palette enumerated on purpose — eight hues in three
 *    shades, or a twelve-step ramp declared for light and again for dark —
 *    where a dozen colours is still what one busy component declares inline.
 */
export const MIN_SYSTEM_TOKENS = 8
export const MIN_SINGLE_AXIS_TOKENS = 24

/**
 * Whether a parsed candidate is enough of a design system to be offered
 * unasked. See `MIN_SYSTEM_TOKENS` above for the bar and the reasoning.
 *
 * Only a stylesheet is judged against the counts. A manifest, a token file and
 * an icon set are already declarations of intent — somebody wrote that file in a
 * design-system format on purpose, and a small one is a small design system
 * rather than an accident — and a component directory had to pass
 * `looksLikeComponentLibrary` to get this far. A stylesheet is the one kind with
 * no intent behind it: every app has dozens, and it is the only kind the
 * four-property rule over-collects.
 *
 * WHAT NO KIND IS EXEMPT FROM IS BEING EMPTY. The detector for `tokens` matches
 * any JSON with a nested `{ value: … }` leaf, which is also the shape of an i18n
 * catalog, a Cypress fixture and a chart's data file — and `tokens` outranks
 * `css`, so `locales/en.json` was offered at the TOP of the list, describing
 * itself as "no tokens", above the project's real `src/styles/tokens.css`. A
 * candidate that parses to nothing is not a small design system, it is a file
 * that answered the detector's question by accident. Judging it on its parsed
 * catalog rather than on a tighter detector keeps the rule where every other
 * rule in this file already is: what makes a file a design system is what is
 * inside it.
 *
 * `worthAdopting` below asks a DIFFERENT question of the same parsed shape; the
 * two sit together so the difference between them is stated once, where both
 * are read from.
 */
export function worthOffering(kind, counts) {
  const total = totalTokens(counts)
  if (total === 0) return false
  if (kind !== "css") return true
  return filledGroups(counts) > 1 ? total >= MIN_SYSTEM_TOKENS : total >= MIN_SINGLE_AXIS_TOKENS
}

/**
 * Whether a stylesheet at a project's CONVENTIONAL ENTRY POINT is that
 * project's design system.
 *
 * The bar above answers "should this file, out of the hundreds in a project, be
 * offered to somebody who did not ask for it". It is strict because it chooses
 * from a whole tree: a lone list of a dozen colours could be a palette or could
 * be one busy component, and with nothing else to go on the count has to settle
 * it.
 *
 * The detector is not choosing from a tree. It has already been told where to
 * look — `src/index.css`, `app/globals.css`, or whatever `components.json`
 * names as the Tailwind entry — and a stylesheet at that path is the one the
 * BUILD treats as the project's own. That is the corroborating signal the depth
 * bar was standing in for, and it is a better signal than any count: a
 * component's private stylesheet is never the configured entry point.
 *
 * Applying the strict bar there rejected real projects. Measured across four
 * prototypes whose tokens live in `src/index.css`, two were adopted and two were
 * refused for declaring a palette and nothing else — thirteen colours in one,
 * seven in the other, both inside an explicit theme block with the words "Design
 * tokens" written above them. The editor then offered no tokens at all for a
 * project that plainly had them, which is the exact failure this detection was
 * added to end.
 *
 * So the only bar left is emptiness. A file that parses to nothing is still
 * nothing — which is what keeps a CSS reset, or an entry that does no more than
 * `@import` a framework, from being adopted — but a conventional entry that
 * declares any token at all is declaring the project's tokens, and the editor
 * should read them.
 */
export function worthAdopting(counts) {
  return totalTokens(counts) > 0
}

/** Singular and plural written out, because "1 radiuses" reads like a bug. */
const GROUP_LABELS = [
  ["colors", "color", "colors"],
  ["spacing", "spacing step", "spacing steps"],
  ["radii", "radius", "radii"],
  ["textStyles", "text style", "text styles"],
  ["effects", "effect", "effects"],
  ["icons", "icon size", "icon sizes"],
  ["motion", "motion token", "motion tokens"],
  ["components", "component", "components"],
  ["iconDrawings", "icon", "icons"],
]

const MAX_DESCRIBED_GROUPS = 3

/**
 * One line the user reads before deciding to add this file.
 *
 * Three groups at most, because this sits in a 260px column and a row that
 * wraps to four lines is a row nobody reads. The three that survive are the
 * first three non-empty groups in the fixed order above — colours before
 * spacing before radii and so on — not the three biggest: a fixed order is one
 * a designer learns to read at a glance.
 *
 * An empty catalog reads "no tokens" whatever its kind. A component directory
 * is never described here (its row is described by the store), and an icon
 * file that yields no glyph is refused by its parser before it gets this far.
 */
export function describeCatalog(catalog) {
  const counts = libraryCounts(catalog)
  const parts = GROUP_LABELS.filter(([key]) => counts[key] > 0)
    .slice(0, MAX_DESCRIBED_GROUPS)
    .map(([key, singular, plural]) => `${counts[key]} ${counts[key] === 1 ? singular : plural}`)
  return parts.length ? parts.join(" · ") : "no tokens"
}
