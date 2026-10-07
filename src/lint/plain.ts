/**
 * A finding, said in as few words as a designer can act on.
 *
 * A checker writes for the person who will edit the file. It names the literal,
 * the rule, the near misses, the file the tokens are declared in, and the two
 * or three things you could do instead — one paragraph, and every clause of it
 * earns its place in a terminal. Stacked forty times down a 260px rail it stops
 * being a report and becomes a wall, and the reader's question is not "what did
 * the linter say", it is **which colour, and what do I press**.
 *
 * So the row is built from three short pieces instead of one long sentence, and
 * this module is where a paragraph becomes those pieces:
 *
 *   - **the literal** — `rgba(60, 64, 67, 0.16)`, with the actual colour beside
 *     it. A designer recognises a swatch before they finish reading a word, and
 *     the literal is the one part of the message that is not prose.
 *   - **the replacement** — `→ var(--ds-sys-color-primary)`, when the server
 *     was confident enough to offer a Fix. An arrow between two swatches says
 *     the whole of what that Fix will do; a sentence saying the same thing is
 *     the sentence nobody reads twice.
 *   - **the hint** — three or four words for the case where there is no Fix,
 *     because THAT is the only row where the reader has a decision to make.
 *
 * Nothing is thrown away. The checker's paragraph is still on the row, in
 * `title` and in the accessible name, which is where a sentence belongs once
 * the glanceable version exists — see `panel.ts`.
 *
 * ## Why the plain names are a table and not a transform
 *
 * `no-raw-colors` → "Hard-coded colors" cannot be derived. Dropping `no-` and
 * unhyphenating gets there for that one rule and produces "Declaration property
 * value no unknown" for the next, which is worse than the id it replaced: an id
 * is at least recognisably an id, and a mangled phrase reads like English that
 * has gone wrong. So the rules this editor's own recommended checkers emit are
 * named by hand, everything else keeps its id verbatim, and the id is in
 * `title` either way. A table that covers eight rules honestly beats a
 * transform that covers all of them badly.
 */

import type { LintFinding } from "./store"
import { plural } from "../core/format"

/**
 * Plain English for the rules the three supported checkers emit, keyed on the
 * segment after the plugin prefix.
 *
 * `stylelint-design-tokens`, `ds-lint` and `@shadcn/lint` all name their rules
 * the same way — `no-raw-colors` under `design-tokens/`, `ds-lint/` or
 * `shadcn/` — so the prefix carries no information a reader wants in a heading
 * and the suffix carries all of it. Two checkers finding raw colours in one
 * project is one heading, which is right: it is one problem.
 */
const RULE_NAMES: Record<string, string> = {
  "no-raw-colors": "Hard-coded colors",
  "no-undeclared-token": "Undefined tokens",
  "duplicate-token-values": "Duplicate tokens",
  "no-inline-styles": "Inline styles",
  "no-restyle": "Component styles overridden",
  "no-arbitrary-values": "Off-scale values",
  "require-static-classes": "Dynamic class names",
  "no-unknown-classes": "Unknown class names",
}

/**
 * The heading over a group of findings.
 *
 * Falls back to the whole rule id, prefix included, because a rule this table
 * does not know is a rule from a checker this editor did not ship the wording
 * for — and inventing a friendly name for it is how a panel comes to describe
 * somebody else's rule wrongly, in a voice that sounds authoritative.
 */
export function ruleTitle(rule: string): string {
  const suffix = rule.includes("/") ? rule.slice(rule.lastIndexOf("/") + 1) : rule
  return RULE_NAMES[suffix] ?? rule
}

/**
 * Is this text a colour the browser can paint?
 *
 * Asked of the engine rather than matched against a list of syntaxes, because
 * the list is wrong the moment a project ships `oklch()` or `color(display-p3
 * …)` and a swatch that silently stops appearing on the newest colour spaces is
 * a swatch a designer stops trusting. `CSS.supports` knows exactly what this
 * browser will paint, which is the question being asked.
 *
 * `var(` is excluded before the question is put: `var(--anything)` is valid in
 * a colour position whatever it resolves to, so the engine would say yes to a
 * token name and the swatch would be painted from `resolveToken` or not at all.
 * Guarded for JSDOM, which has no `CSS`.
 */
function paintable(text: string): boolean {
  if (!text || text.includes("var(")) return false
  const supports = typeof CSS !== "undefined" && typeof CSS.supports === "function"
  return supports ? CSS.supports("color", text) : false
}

/**
 * What `var(--x)` is actually worth on this page, or null.
 *
 * The overlay renders inside the app's own document, so the app's tokens are
 * simply there to be read — which is what makes a swatch beside a REPLACEMENT
 * possible at all: the row can show the colour the Fix would write, not only
 * its name. A token declared on a scoped element rather than on the root
 * resolves to nothing here, and that is the honest answer: no swatch, rather
 * than a swatch of the wrong colour.
 */
function resolveToken(text: string): string | null {
  const match = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(text.trim())
  const name = match ? match[1] : text.trim().startsWith("--") ? text.trim() : null
  if (!name || typeof getComputedStyle !== "function") return null
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value && paintable(value) ? value : null
}

/** The colour to paint beside a piece of text, or null if it is not a colour. */
export function swatchFor(text: string): string | null {
  if (!text) return null
  if (paintable(text)) return text
  return resolveToken(text)
}

/**
 * How many tokens a message offered without choosing between them.
 *
 * This is the difference between the two kinds of unfixable row, and it is the
 * only thing about them worth saying in the list: "the checker found nothing
 * close" is a row you will end up declaring a new token for, and "the checker
 * found three near misses" is a row you will end up picking one of. Counting
 * `--token` mentions is deliberately crude — it is a count, shown as a count,
 * and the list it counts is in the tooltip for anyone who wants it.
 */
function nearCount(message: string): number {
  const listed = message.match(/Nearest:([^.]*)\./i)
  if (!listed) return 0
  return new Set(listed[1].match(/--[A-Za-z0-9_-]+/g) ?? []).size
}

/**
 * The three or four words under a row that has no Fix button.
 *
 * Only for rows with no Fix: a row that HAS one already says what it will do,
 * with an arrow and a swatch, and a sentence repeating that in words is the
 * second copy of an answer the reader has had since the row painted.
 *
 * `null` means say nothing. A group heading that already reads "Inline styles"
 * over a row whose literal is the offending declaration has said it, and a
 * per-row echo of the heading is the padding this whole module exists to cut.
 */
export function hintFor(finding: LintFinding): string | null {
  if (finding.fix) return null
  const near = nearCount(finding.message)
  if (near) return `${plural(near, "near match", "near matches")}. Pick one in the inspector`
  const suffix = finding.rule.includes("/")
    ? finding.rule.slice(finding.rule.lastIndexOf("/") + 1)
    : finding.rule
  if (suffix === "no-raw-colors") return "No token is close. Declare one"
  if (suffix === "no-undeclared-token") return "Showing the fallback value"
  /*
   * The generic last resort, and it is not nothing.
   *
   * A rule this module has no wording for still produces a row with no Fix
   * button, and a row that is a fixable row minus a button is a row the reader
   * has to hover to understand — which is precisely the cost this whole file
   * exists to remove. Three dim words say the fact outright. They do not say
   * what to do instead, because on an unrecognised rule this editor genuinely
   * does not know, and inventing an instruction would be worse than admitting
   * the gap. The checker's own sentence is one hover away either way.
   */
  return "No automatic fix"
}

/**
 * The offending text, short enough to sit on one line of a narrow rail.
 *
 * The middle goes rather than the end, because both ends of a literal identify
 * it and the middle of one rarely does: `--ds-sys-color-state-primary…-focus`
 * is still recognisably that token, and `--ds-sys-color-state-prim…` could be
 * any of six. A whitespace run collapses first — a multi-line `rgba(\n 0,\n 0…)`
 * sliced straight out of a stylesheet is otherwise three lines of chip.
 */
export function shortLiteral(text: string, max = 34): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  const head = Math.ceil((max - 1) / 2)
  return `${flat.slice(0, head)}…${flat.slice(flat.length - (max - 1 - head))}`
}

/**
 * A value as a designer names it — a token without the `var()` wrapped round it.
 *
 * `finding.fix.replacement` is the exact text the Fix will WRITE, and for a
 * colour that has to be `var(--color-accent)`: it is CSS, and this row must
 * never be the reason somebody pastes a bare token name into a property. But
 * nobody calls that token "var open-paren dash dash color accent close-paren".
 * They call it `--color-accent`, and the five characters of syntax around it
 * are both noise and — measured on a 260px rail with a swatch either side — the
 * difference between the line fitting and wrapping. That is 17px on every
 * fixable row in the list.
 *
 * So the wrapper is dropped for DISPLAY only, and only when the whole value is
 * one `var()` call and nothing else: a shorthand like
 * `0 2px 6px var(--shadow)` keeps its syntax, because there the `var()` is part
 * of a larger expression rather than the whole of it. The exact string stays on
 * the Fix button's own tooltip, which is the control that writes it and the
 * place a reader checking what lands in the file will look.
 */
export function displayLiteral(text: string): string {
  const unwrapped = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(text.trim())
  return shortLiteral(unwrapped ? unwrapped[1] : text)
}
