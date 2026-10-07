/**
 * The audit in the browser: what the checkers found, which findings are
 * dismissed, which layer owns the canvas, and — the part that is not
 * bookkeeping — WHICH ELEMENT each finding is about.
 *
 * A finding, as the server reports it, is a file and a line. A marker needs an
 * element, the panel's "on this page" figure needs a count of elements, and the
 * inspector needs to answer "does the thing I have selected have a finding on
 * it?" on every render. Those are three readings of ONE question, and this
 * module exists so that they are three readings of one ANSWER: the resolution
 * runs once per audit, into an index, and the marker layer, the summary and the
 * inspector all read it. Two surfaces resolving the same selectors separately
 * is how a panel comes to claim twenty markers while the canvas paints twelve,
 * which is the specific way this feature looks broken while every part of it is
 * working.
 *
 * ## The resolution seam, and why it is a hook rather than an import
 *
 * The marker layer owns how a CSS selector becomes elements — it has to, that
 * is the thing it draws. But the count has to agree with it, so one of the two
 * has to defer. It is arranged so that either direction works and neither can
 * produce a second answer:
 *
 *   - `resolveLintSelector` here is a complete implementation of the rules the
 *     marker contract states (state pseudo-classes stripped, framework scoping
 *     attributes stripped, unparseable parts skipped rather than thrown), so a
 *     marker layer can simply paint `lintResolution()` and nothing needs
 *     registering at all.
 *   - `setLintResolver` lets the marker layer install its own instead, and then
 *     the index — and therefore the count, and therefore `findingsFor` — is
 *     built from the marker layer's answer rather than from a second opinion.
 *
 * Either way there is exactly one resolution per run. What is NOT offered is a
 * way for the marker layer to report a count back after painting: a number
 * arriving after the panel has already drawn its summary is a number that is
 * one paint stale, and the panel would flicker between two totals.
 *
 * ## Loading follows `libraries/store.ts`
 *
 * One shared in-flight promise, a warning and an empty answer when the tool
 * list cannot be loaded, and a failure that is never cached so a dev server
 * that was still starting can be asked again. Mutations are the opposite and
 * REJECT: every one of them is a button somebody just pressed and the panel has
 * to be able to say what happened. Subscribers are notified synchronously
 * inside the same task as the write, because the frame a user looks hardest at
 * is the one straight after they pressed something.
 */

import { markerLayer, setMarkerLayer } from "../annotations/store"
import { isChrome } from "../core/dom"

/* ---------- the wire shapes ---------- */

/**
 * One checker, and whether it will actually run here.
 *
 * `reason` is not decoration and is never dropped by the panel: a checker that
 * is installed but inapplicable, silently omitted from the list, turns a green
 * audit into a lie. The panel renders the sentence beside the name.
 */
export interface LintTool {
  id: string
  name: string
  available: boolean
  reason: string
  configFile: string | null
}

/** One violation, normalized across every checker by the server. */
export interface LintFinding {
  /** Stable across runs, so an ignore survives one. */
  id: string
  tool: string
  rule: string
  severity: "error" | "warning"
  message: string
  file: string
  line: number
  column: number
  endLine: number
  endColumn: number
  /** The CSS selector whose block contains the finding, or null. */
  selector: string | null
  /** The exact source text the finding covers. */
  snippet: string
  /** The CSS property the finding sits in, when it is in a declaration. */
  property: string | null
  /** Present only when a confident replacement exists. */
  fix: { replacement: string } | null
  /** The server flags a dismissed finding rather than filtering it out. */
  ignored?: boolean
}

/** What `fix({ ids })` answers: what was written, and what refused to be. */
export interface LintFixResult {
  fixed: string[]
  failed: Array<{ id: string; reason: string }>
}

/** One finding and the live elements it was resolved to. Elements may be empty. */
export interface LintPlacement {
  finding: LintFinding
  elements: Element[]
}

/** How a finding becomes elements. The marker layer may supply its own. */
export type LintResolver = (finding: LintFinding) => Element[]

/**
 * The numbers the panel's one-line summary is made of.
 *
 * `onPage` is the load-bearing one. Most findings live in files the current
 * route never renders, so the total and the number of markers on screen are
 * routinely different, and a panel that reports only the total is a panel a
 * user checks against the canvas once and stops trusting.
 */
export interface LintSummary {
  total: number
  errors: number
  warnings: number
  onPage: number
  fixable: number
  ignored: number
}

/** Where the last press of Audit got to. */
export type LintRunState = "idle" | "running" | "done" | "error"

/* ---------- state ---------- */

let tools: LintTool[] = []
let toolsLoaded = false
let toolsInFlight: Promise<LintTool[]> | null = null

let findings: LintFinding[] = []
let ignoredIds = new Set<string>()
let ranAt: string | null = null
let runState: LintRunState = "idle"
let runInFlight: Promise<LintFinding[]> | null = null
let lastError: string | null = null

/**
 * Whether the audit owns the canvas, and it starts OFF.
 *
 * This is the single piece of state behind the two layers' mutual exclusion —
 * audit markers and note pins both pin a badge to the top-left of an element,
 * so a page with both stacks two badges on one corner and neither is readable.
 * One boolean, read by both layers, is the only shape of that rule which cannot
 * end up with both on screen; two independent toggles is exactly how it does.
 *
 * It starts on notes rather than on the audit because the editor boots with
 * notes working and nothing audited. Defaulting the other way would hide every
 * note pin at startup on behalf of a marker layer with nothing to paint — a
 * feature nobody has opened yet taking the canvas from one already in use.
 * `runAudit` claims it when a run actually produces something to point at.
 *
 * The value itself lives in `annotations/store`, NOT here, and that is the
 * whole point of this comment. This module used to keep its own boolean beside
 * that one, which is the two-independent-toggles shape the rule above rules
 * out: each side would be right about itself and the pair could disagree, and
 * the way that shows up is both layers painting a badge on the same corner.
 * One owner, read from both ends.
 */

const listeners = new Set<() => void>()

/**
 * A counter the panel can key a repaint on, instead of re-reading the world.
 *
 * `update()` is called on every editor invalidation — which is every frame of a
 * number scrub — and the panel must not rebuild its DOM unless something it
 * shows actually moved, or a checkbox loses focus mid-click. Comparing a number
 * is what makes that test free; comparing a digest of five thousand findings
 * would put the thing it is protecting against back on the hot path.
 */
let version = 0

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** Bumped by every mutation. See `version`. */
export function lintVersion(): number {
  return version
}

export function subscribeToLint(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/* ---------- the wire ---------- */

function endpoint(apiBase: string, path = ""): string {
  return `${apiBase}/lint${path}`
}

/**
 * The server's own words for a failure, and a recovery when it had none.
 *
 * Worth reading the body for the reason the libraries store gives about its
 * own: the sentences this feature's endpoints produce are about a checker that
 * is not installed, a config that names a plugin that is not there, or a file
 * that moved under a fix — and those sentences are the entire help available at
 * the moment it goes wrong.
 *
 * When the body had nothing, the status code is NOT the fallback. This message
 * is rendered verbatim into a toast and into the section's failure line, so
 * `HTTP 500` was the panel handing a designer a number they cannot act on at the
 * moment they are least equipped to look it up. The number is real information
 * for whoever is running the server, so it goes where that person is already
 * looking, and what reaches the panel names the terminal and the retry.
 */
async function failure(response: Response): Promise<Error> {
  let stated = ""
  try {
    const payload = (await response.json()) as { message?: unknown; error?: unknown }
    const message = payload.message ?? payload.error
    if (typeof message === "string") stated = message.trim()
  } catch {
    // A body that is not JSON has nothing in it a person can act on.
  }
  if (stated) return new Error(stated)
  console.warn("[designlayer] the lint route answered", response.status, response.url)
  return new Error(
    "The DesignLayer server did not respond. Check its terminal, then try again."
  )
}

async function send<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as T
}

/* ---------- resolving a finding to elements ---------- */

/**
 * A scoping attribute a framework's compiler added, e.g. `[_ngcontent-a-c3]`.
 *
 * These are emitted per build and per component, so the hash in one is
 * meaningless to a document that was served by a different build — and a
 * selector carrying one matches nothing whenever it is even slightly stale,
 * which turns every finding in a component stylesheet into "not on this page".
 * Keyed on the leading underscore rather than on any framework's spelling,
 * because an attribute nobody would write by hand is the actual signal.
 */
const SCOPE_ATTRIBUTE = /\[_[^\]]*\]/g

/**
 * A state pseudo-class or a pseudo-element — and never a functional one.
 *
 * `.btn:hover` styles `.btn`, and a marker cannot wait for a hover that may
 * never happen, so the state has to come off before the selector is a question
 * about the document. The lookahead is what keeps `:not(...)`, `:is(...)` and
 * `:nth-child(2)` intact: a pseudo followed by `(` carries an argument that
 * usually NARROWS the match, and dropping it would mark elements the rule never
 * touched. Those are left exactly as written, and if the result does not parse
 * the query below answers nothing rather than throwing.
 */
const STATE_PSEUDO = /::?[a-z-]+(?![a-z-(])/gi

/**
 * A selector list split at its top-level commas.
 *
 * `document.querySelectorAll` takes a list natively, so this exists only for
 * the failure mode: one unparseable part throws for the whole list, and a
 * stylesheet with a single selector this browser dislikes would then have every
 * finding beside it silently unresolvable. Split, and a bad part costs only
 * itself. Depth is tracked through `(` and `[` so a comma inside `:is(a, b)` or
 * `[title="a,b"]` is not a separator.
 */
function selectorParts(selector: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let at = 0; at < selector.length; at += 1) {
    const char = selector[at]
    if (char === "(" || char === "[") depth += 1
    else if (char === ")" || char === "]") depth -= 1
    else if (char === "," && depth === 0) {
      parts.push(selector.slice(start, at))
      start = at + 1
    }
  }
  parts.push(selector.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** Never throws. A selector a browser cannot parse resolves to nothing. */
function query(selector: string): Element[] {
  if (!selector) return []
  try {
    return Array.from(document.querySelectorAll(selector))
  } catch {
    return []
  }
}

/**
 * The live elements a finding's selector describes, as the marker layer and the
 * "on this page" count both need them.
 *
 * Two passes, in this order, and the order is the whole subtlety. The selector
 * is tried EXACTLY as the stylesheet wrote it first, so a structural qualifier
 * that genuinely narrows the match — `:nth-child(2)`, `:not(.open)` — is
 * honoured whenever it resolves. Only when that answers nothing is the stripped
 * form tried, which is the `:hover` case and the stale-build-hash case. Doing
 * it the other way round would mark every sibling of the one element a rule
 * actually applies to, and doing only the first would leave every state rule in
 * the project reported as "not on this page".
 *
 * Chrome is excluded: this editor's own panels are in the same document, and an
 * audit of the host's stylesheet has no business pointing at them.
 */
export function resolveLintSelector(selector: string): Element[] {
  const found: Element[] = []
  const seen = new Set<Element>()
  for (const part of selectorParts(selector)) {
    const exact = query(part)
    const nodes = exact.length
      ? exact
      : query(part.replace(SCOPE_ATTRIBUTE, "").replace(STATE_PSEUDO, "").trim())
    for (const node of nodes) {
      if (seen.has(node) || isChrome(node)) continue
      seen.add(node)
      found.push(node)
    }
  }
  return found
}

/**
 * A finding with no selector is real and has no element.
 *
 * The server reports `null` for a finding inside a template or an HTML file,
 * where there is no enclosing rule to take a selector from. There is nothing to
 * fall back to — a file and a line do not identify a node — so it is listed in
 * the panel, counted in the total, and excluded from the on-page figure. That
 * is the honest answer, and it is why the summary prints both numbers.
 */
const defaultResolver: LintResolver = (finding) =>
  finding.selector ? resolveLintSelector(finding.selector) : []

let resolver: LintResolver = defaultResolver

/**
 * Hands the marker layer's own resolution to the rest of the feature.
 *
 * Pass `null` to go back to the built-in one. Registering invalidates the
 * index, so a layer that installs itself after the first audit does not leave
 * the summary reporting the previous answer.
 */
export function setLintResolver(next: LintResolver | null): void {
  resolver = next ?? defaultResolver
  invalidateResolution()
  // A resolver only changes where findings point, so with none there is
  // nothing for a listener to repaint — and the marker layer installs its
  // resolver at boot, where that repaint was the lint panel's whole first
  // render, spent on an audit nobody has run.
  if (findings.length) notify()
}

let placements: LintPlacement[] | null = null
let byElement: Map<Element, LintFinding[]> | null = null
/** Placement by finding id, so a panel asking per row is not a scan per row. */
let byId: Map<string, LintPlacement> | null = null
let resolutionEpoch = 0

const NO_FINDINGS: LintFinding[] = []

function invalidateResolution(): void {
  placements = null
  byElement = null
  byId = null
  resolutionEpoch += 1
}

/**
 * Bumped whenever the element index is dropped, so a surface showing a count
 * derived from it can tell that its number is stale.
 */
export function lintResolutionEpoch(): number {
  return resolutionEpoch
}

function buildResolution(): void {
  const resolved: LintPlacement[] = []
  const index = new Map<Element, LintFinding[]>()
  const ids = new Map<string, LintPlacement>()
  for (const finding of visibleFindings()) {
    let elements: Element[] = []
    try {
      elements = resolver(finding)
    } catch (error: unknown) {
      // A resolver that throws is a bug in one selector, not a reason to lose
      // every other finding's marker.
      console.warn("[designlayer] could not resolve a finding to an element", error)
    }
    const placement = { finding, elements }
    resolved.push(placement)
    // First one wins, as the scan this replaced did.
    if (!ids.has(finding.id)) ids.set(finding.id, placement)
    for (const element of elements) {
      const known = index.get(element)
      if (known) known.push(finding)
      else index.set(element, [finding])
    }
  }
  placements = resolved
  byElement = index
  byId = ids
}

/** Every visible finding with the elements it resolved to. Built once per run. */
export function lintResolution(): readonly LintPlacement[] {
  if (!placements) buildResolution()
  return placements ?? []
}

/** The elements one finding is about, empty when it is not on this page. */
export function elementsForFinding(id: string): Element[] {
  if (!byId) buildResolution()
  return byId?.get(id)?.elements ?? []
}

/**
 * Whether this finding has a live element right now — the per-finding form of
 * the summary's on-page count, and the same test the marker layer applies
 * before it draws.
 *
 * `isConnected` rather than merely "it resolved once": the index is built per
 * audit and the app keeps rendering underneath it, so an element can be
 * detached between the run and the reading. The marker layer already declines
 * to draw a badge on a detached node — a violation may well have been deleted
 * along with it — so counting one here would put the panel's number back above
 * the number of badges, which is the whole disagreement this index exists to
 * prevent.
 */
export function isOnThisPage(id: string): boolean {
  return elementsForFinding(id).some((element) => element.isConnected)
}

/**
 * The findings on this element, for the inspector's design-system section.
 *
 * Called on EVERY inspector render — which means on every frame of a number
 * scrub — so it is a map lookup and never a query. The index behind it is built
 * once per audit and thrown away only when the findings change or the page
 * does; this function itself never touches the document.
 */
export function findingsFor(element: Element | null): LintFinding[] {
  if (!element) return NO_FINDINGS
  if (!byElement) buildResolution()
  return byElement?.get(element) ?? NO_FINDINGS
}

/* ---------- reading the cache ---------- */

/** Every checker the server knows about, available or not. Empty before load. */
export function lintTools(): LintTool[] {
  return tools
}

/** True once the tool list has actually been answered, so "none" can be said. */
export function lintToolsLoaded(): boolean {
  return toolsLoaded
}

function isIgnoredFinding(finding: LintFinding): boolean {
  // Both sources, unioned: the server flags a dismissed finding in the run
  // payload, and this session may have dismissed one since. Trusting only the
  // flag would resurrect a row for one beat after Ignore; trusting only the
  // local set would lose every ignore made before this page loaded.
  return finding.ignored === true || ignoredIds.has(finding.id)
}

/**
 * The findings the panel lists and the canvas marks: everything not ignored.
 *
 * The ignored ones are still here — see `ignoredFindings` — because filtering
 * them out of the payload would make an ignore impossible to undo. They are
 * simply not what "the findings" means to any surface that paints.
 */
export function lintFindings(): LintFinding[] {
  return visibleFindings()
}

function visibleFindings(): LintFinding[] {
  return findings.filter((finding) => !isIgnoredFinding(finding))
}

/** The dismissed ones, for the "Show ignored" disclosure. */
export function ignoredFindings(): LintFinding[] {
  return findings.filter(isIgnoredFinding)
}

export function lintRunState(): LintRunState {
  return runState
}

/** The ISO time of the last completed run, or null before the first one. */
export function lintRanAt(): string | null {
  return ranAt
}

/** The last failure's own sentence, for a panel that must explain itself. */
export function lintError(): string | null {
  return lastError
}

export function lintSummary(): LintSummary {
  const visible = visibleFindings()
  return {
    total: visible.length,
    errors: visible.filter((finding) => finding.severity === "error").length,
    warnings: visible.filter((finding) => finding.severity !== "error").length,
    // The same resolution the markers are drawn from, by construction: a
    // finding counts as "on this page" exactly when it resolved to at least one
    // element that is still in the document, which is exactly when it gets a
    // badge.
    onPage: lintResolution().filter((entry) => entry.elements.some((node) => node.isConnected))
      .length,
    fixable: visible.filter((finding) => finding.fix !== null).length,
    ignored: ignoredFindings().length,
  }
}

/* ---------- marker visibility ---------- */

/** Whether the audit layer is the one on screen. See `shown` above. */
export function markersShown(): boolean {
  return markerLayer() === "audit"
}

/**
 * Switches the canvas between the two marker layers.
 *
 * Called from the panel's Hide markers toggle, and callable from the annotation
 * side: turning note pins on is the same decision seen from the other end, and
 * it is spelled `setMarkersShown(false)` rather than as a second flag. The
 * early return is what makes that safe to call from a listener of this store
 * without looping.
 */
export function setMarkersShown(next: boolean): void {
  if (markersShown() === next) return
  setMarkerLayer(next ? "audit" : "notes")
  notify()
}

/* ---------- the calls ---------- */

export function loadLintTools(apiBase: string): Promise<LintTool[]> {
  if (toolsLoaded) return Promise.resolve(tools)
  toolsInFlight ??= send<{ tools?: LintTool[] }>(endpoint(apiBase, "/tools"))
    .then((payload) => {
      tools = Array.isArray(payload.tools) ? payload.tools : []
      toolsLoaded = true
      notify()
      return tools
    })
    .catch((error: unknown) => {
      console.warn("[designlayer] could not load the design-system checkers", error)
      // Not cached, and `toolsLoaded` is left alone: the next surface to ask
      // gets a real request rather than the empty list this one settled for.
      toolsInFlight = null
      return []
    })
  return toolsInFlight
}

/**
 * Runs the audit, and shares one run between every caller that asks during it.
 *
 * A run can take a minute on a large project, so the button is disabled while
 * one is in flight — but the shared promise is the thing that actually
 * guarantees it, because the panel is not the only surface that can ask.
 */
export function runAudit(apiBase: string, only?: string[]): Promise<LintFinding[]> {
  if (runInFlight) return runInFlight
  runState = "running"
  lastError = null
  notify()
  runInFlight = send<{ findings?: LintFinding[]; ranAt?: string }>(endpoint(apiBase, "/run"), {
    method: "POST",
    body: JSON.stringify(only?.length ? { tools: only } : {}),
  })
    .then((payload) => {
      findings = Array.isArray(payload.findings) ? payload.findings : []
      // The run's own flags are folded in rather than replacing the set, so an
      // ignore made in this session survives a server that has not persisted it
      // yet, and one persisted before this page loaded is learned here.
      for (const finding of findings) if (finding.ignored) ignoredIds.add(finding.id)
      ranAt = typeof payload.ranAt === "string" ? payload.ranAt : new Date().toISOString()
      runState = "done"
      runInFlight = null
      invalidateResolution()
      // The audit takes the canvas when it has something to point at, and only
      // then. A clean run leaves note pins where they were.
      if (findings.length) setMarkerLayer("audit")
      notify()
      return findings
    })
    .catch((error: unknown) => {
      runState = "error"
      lastError = error instanceof Error ? error.message : String(error)
      runInFlight = null
      notify()
      throw error
    })
  return runInFlight
}

/**
 * Applies the fixes the server said it could make, and drops them from the list.
 *
 * Optimistic removal rather than an automatic re-run: a re-audit costs the same
 * minute the first one did, and the server has just told us exactly which ids
 * it wrote. The ones it could NOT write stay in the list, which is the point of
 * returning `failed` — a finding whose snippet had moved under us is reported,
 * never force-written, and the row has to still be there to say so.
 */
export function fixFindings(apiBase: string, ids: string[]): Promise<LintFixResult> {
  return send<LintFixResult>(endpoint(apiBase, "/fix"), {
    method: "POST",
    body: JSON.stringify({ ids }),
  }).then((result) => {
    const fixed = new Set(result.fixed ?? [])
    if (fixed.size) {
      findings = findings.filter((finding) => !fixed.has(finding.id))
      invalidateResolution()
    }
    notify()
    return { fixed: result.fixed ?? [], failed: result.failed ?? [] }
  })
}

/**
 * Folds an ignore response into the local set so it is right under either
 * reading of the wire.
 *
 * `{ ignored: [...] }` could be the whole persisted set after the write or just
 * the ids this call touched, and the route contract does not say which. Union
 * for an ignore and difference for an unignore give the same answer whichever
 * it is, which is cheaper than being wrong in one direction.
 */
function foldIgnored(
  current: Set<string>,
  answered: string[],
  requested: string[],
  add: boolean
): Set<string> {
  const next = new Set(current)
  for (const id of answered) next.add(id)
  for (const id of requested) {
    if (add) next.add(id)
    else next.delete(id)
  }
  return next
}

export function ignoreFindings(apiBase: string, ids: string[]): Promise<string[]> {
  return send<{ ignored?: string[] }>(endpoint(apiBase, "/ignore"), {
    method: "POST",
    body: JSON.stringify({ ids }),
  }).then((payload) => {
    ignoredIds = foldIgnored(ignoredIds, payload.ignored ?? [], ids, true)
    invalidateResolution()
    notify()
    return [...ignoredIds]
  })
}

export function unignoreFindings(apiBase: string, ids: string[]): Promise<string[]> {
  return send<{ ignored?: string[] }>(endpoint(apiBase, "/ignore"), {
    method: "DELETE",
    body: JSON.stringify({ ids }),
  }).then((payload) => {
    ignoredIds = foldIgnored(ignoredIds, payload.ignored ?? [], ids, false)
    const restored = new Set(ids)
    // The flag the run payload carried has to go too: it is a snapshot of what
    // the server thought at run time, and it has just changed its mind.
    findings = findings.map((finding) =>
      restored.has(finding.id) && finding.ignored ? { ...finding, ignored: false } : finding
    )
    invalidateResolution()
    notify()
    return [...ignoredIds]
  })
}

/** Test seam: drop everything this module remembers. */
export function resetLintForTest(): void {
  tools = []
  toolsLoaded = false
  toolsInFlight = null
  findings = []
  ignoredIds = new Set()
  ranAt = null
  runState = "idle"
  runInFlight = null
  lastError = null
  setMarkerLayer("notes")
  resolver = defaultResolver
  invalidateResolution()
}
