/**
 * The LEFT panel's tab host — and almost nothing else, on purpose.
 *
 * The left panel used to be one list: a header, a filter, and the layer tree,
 * appended straight into `.de-panel-body` and scrolled as a whole. It is two
 * views now — Layers and Controls — and the thread running through both is
 * that this column is where you BROWSE. The tree says what is on the page, and
 * Controls lists every tunable the running app exposes. `panels/left.ts` argues the
 * placements; this file only has to make the body hold panes instead of a list.
 *
 * ## Why this file is two rules long
 *
 * The strip itself reuses `.de-tabs` / `.de-tab` / `.de-tabpanel` from
 * `css/inspector.ts` rather than restating them under a `de-left-` prefix. Two
 * tab strips in one piece of chrome are one control the user learns once, and a
 * second copy of that stylesheet is a promise to keep two sets of measurements
 * in step forever — which is a promise nothing enforces. Sharing it is also
 * what keeps the two strips reading as one control through a restyle: when the
 * right panel traded its underlined icon+label tabs for neutral pills,
 * the left strip became pills in the same commit, because there was only ever
 * one rule to change.
 *
 * The inherited scroller is insurance: "Layers · Controls" fits a 240px panel
 * with room to spare, and the rule that answers overflow at `panelMinWidth`
 * was already written for the inspector, which has three labels.
 *
 * What is genuinely LEFT-specific is the pair of rules below, and both are
 * about the panel body rather than about the strip. Nothing in here reaches
 * into any pane's own content: the tree and the controls list each bring their
 * own header, inset and rhythm, and a rule out here imposing padding or a flex
 * basis on `.de-tabpanel > *` would be this file overruling surfaces it does
 * not own.
 *
 * ## Ordering
 *
 * Registered after `panels.ts`, and for the same reason `inspector.ts` is: it
 * re-lays out `.de-panel-body`, which `panels.ts` has already declared, and it
 * has to win on equal specificity. It sits directly after `inspector.ts` only
 * so the two panel-body overrides read as a pair; they select different panels
 * and could not collide.
 */

export const leftTabsCss = `/* ---------- left panel tabs ---------- */
/*
 * The mirror of the right panel's body: a fixed strip over one scrolling pane,
 * instead of one scroll containing everything.
 *
 * Stated as its own rule rather than folded into a
 * \`.de-panel--left, .de-panel--right\` list, because the two are not the same
 * claim and will not stay the same shape — they are owned by different lanes
 * and the right panel's version carries its own reasoning beside it. The
 * selector is deliberately no stronger than the one it overrides.
 *
 * Nothing here names a width. The panels are resizable: \`.de-panel--left\` is a
 * flex child of \`.de-rail\` whose width is a MotionValue the resize lane writes
 * inline, and the live number is published as \`--de-left\` on the document
 * element. \`tokens.size.panelWidth\` is only the width the chrome MOUNTS with,
 * so anything needing to know how wide the panel is right now reads the custom
 * property and never the token.
 */
.de-panel--left .de-panel-body {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/*
 * The pane clips sideways instead of growing a scrollbar.
 *
 * \`.de-tabpanel\` asks for \`overflow-y: auto\` and says nothing about the other
 * axis — and a box with one axis \`visible\` and the other not computes the
 * visible one to \`auto\`, so the pane would scroll horizontally too. On the
 * right that is harmless, because every control in the inspector is built to
 * the panel's width. On the left it is not: a layer row is \`white-space: nowrap\`
 * by design, so one deeply indented node with a long component name would hang
 * a horizontal scrollbar under the whole tree — furniture across the bottom of
 * the panel, reporting an overflow the clipped name already reports.
 *
 * The Controls pane arrived under this rule and needed checking against it,
 * because its content is the worst case the rule has ever faced: a control's
 * dot path can run sixty monospace characters inside a folder body already
 * indented 16px. It survives because \`.de-opt-path\` carries
 * \`word-break: break-all\`, so the path WRAPS rather than reaching for an axis
 * that is not there — at 240px and at the 180px floor alike. Anything mounted
 * here in future has the same obligation: clip is the policy, so a pane that
 * plans to scroll sideways will silently lose its tail instead.
 *
 * This is what the panel did before the tabs existed, since \`.de-panel\` is
 * \`overflow: hidden\` and the body only ever scrolled vertically. It restores
 * the behaviour rather than choosing a new one.
 */
.de-panel--left .de-tabpanel {
  overflow-x: hidden;
}
`
