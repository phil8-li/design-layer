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
 * ## One resolver
 *
 * `resolveFinding` in ./resolve turns a finding's selector into elements, and
 * this module is its only caller: it runs once per audit into the index below,
 * and is re-run when the page changes under it (`refreshLintResolution`). A
 * finding with no selector (one inside a template or an HTML file) is real and
 * has no element: it is listed, counted in the total, and left out of the
 * on-page figure.
 *
 * What is NOT offered is a way for the marker layer to report a count back
 * after painting: a number arriving after the panel has already drawn its
 * summary is a number that is one paint stale, and the panel would flicker
 * between two totals.
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

import { markerLayer, onMarkerLayerChange, setMarkerLayer } from "../annotations/store"
import { sendJson } from "../core/api"
import type { LayerElement } from "../core/types"
import { resolveFinding } from "./resolve"

/* ---------- the wire shapes ---------- */

/**
 * One checker, and whether it will actually run here.
 *
 * `reason` is not decoration and is never dropped by the panel: a checker that
 * is installed but inapplicable, silently omitted from the list, turns a green
 * audit into a lie. The panel renders the sentence beside the name.
 */
interface LintTool {
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
interface LintFixResult {
  fixed: string[]
  failed: Array<{ id: string; reason: string }>
}

/** One finding and the live elements it was resolved to. Elements may be empty. */
interface LintPlacement {
  finding: LintFinding
  elements: Element[]
}

/**
 * The numbers the panel's one-line summary is made of.
 *
 * `onPage` is the load-bearing one. Most findings live in files the current
 * route never renders, so the total and the number of markers on screen are
 * routinely different, and a panel that reports only the total is a panel a
 * user checks against the canvas once and stops trusting.
 */
interface LintSummary {
  total: number
  errors: number
  warnings: number
  onPage: number
  fixable: number
  ignored: number
}

/** Where the last press of Audit got to. */
type LintRunState = "idle" | "running" | "done" | "error"

/**
 * One finding's fix, from the press to the server's answer.
 *
 *   idle    --press Fix-->          fixing{token}
 *   fixing  --listed in `fixed`-->  fixed{at}     (the row leaves the list)
 *   fixing  --listed in `failed`--> failed{at, reason}
 *   fixing  --request rejected-->   failed{at, reason}
 *   fixed | failed --next Audit lands--> idle
 *
 * `fixing` is what disables the row's Fix and takes the id out of Fix all, so
 * one finding is never in two requests. `fixed` means the server wrote it: the
 * route answers `fixed` only after the write landed. `token` drops an answer
 * that a reset overtook, and `at` is the same clock an audit run starts on,
 * which is how a run that started before a fix landed is kept from bringing
 * the fixed row back (see `runAudit`).
 */
export type LintFixState =
  | { kind: "idle" }
  | { kind: "fixing"; token: number }
  | { kind: "fixed"; at: number }
  | { kind: "failed"; at: number; reason: string }

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

/** Every finding with a fix pressed or answered. Absent means `idle`. */
const fixes = new Map<string, Exclude<LintFixState, { kind: "idle" }>>()
/**
 * One logical clock for audit runs and fix answers. A run takes a tick when it
 * starts and a fix takes one when it lands, so "landed after this run started"
 * is a comparison of two numbers. A reset takes one too, which makes every
 * answer in flight stale.
 */
let clock = 0
/** Bumped by `resetLintForTest`, so a run that a reset overtook writes nothing. */
let resets = 0

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

/*
 * The canvas belongs to ONE marker layer at a time, and that value lives in
 * `annotations/store` (see `MarkerLayer` there). The notes side moves it too —
 * entering annotation mode hands the canvas to the pins — and a panel that
 * repainted only on this store's own writes kept saying "Hide markers" over a
 * canvas with no markers on it. Listening once here means every change, from
 * either side, is a lint change to everyone who subscribes.
 */
onMarkerLayerChange(notify)

/* ---------- the row/badge hover seam ---------- */

/**
 * The seam between the Design system panel and the marker layer, and it is the
 * SAME seam the notes use. Defined here, the module both already import, so
 * the two ends cannot spell it differently.
 *
 * `annotations/canvas.ts` carries the long version of why — two surfaces that
 * are mounted independently, neither owning the other, an import either way
 * making one unusable without the other — and it applies here without a word
 * changed. What differs is only the pair of names, because a lint row and a
 * note row are different objects and one shared event would light a note pin
 * from a finding's id.
 *
 *   `designlayer:lint-hover`         panel -> canvas  `{ id: string | null }`
 *     The pointer is on that finding's row, or has left every row. The badge
 *     carrying that finding takes its active look (`MARKER_ACTIVE` in ./markers).
 *
 *   `designlayer:lint-marker-hover`  canvas -> panel  `{ id, ids }`
 *     The mirror. `id` is the finding the badge speaks for — the worst one on
 *     that element — and `ids` is every finding it covers, because one badge
 *     can stand for several rows and a panel that lit only one of them would be
 *     answering a question nobody asked. A listener written against the
 *     annotation seam's shape still works: `id` alone is the same contract.
 *
 * `null` is a value in the pair rather than a second event, for the reason the
 * annotation seam gives: a listener that only ever hears "now this one" is how
 * a highlight gets stuck on a row nobody is on.
 */
export const LINT_HOVER_EVENT = "designlayer:lint-hover"
export const LINT_MARKER_HOVER_EVENT = "designlayer:lint-marker-hover"

/** The element a row or a badge may select on the canvas, or `null` for one that is listed only. */
export function selectableElement(element: Element): LayerElement | null {
  if (element instanceof HTMLElement) return element
  if (element instanceof SVGSVGElement) return element
  return null
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

function send<T>(url: string, init: RequestInit = {}): Promise<T> {
  return sendJson<T>(url, init, failure)
}

/* ---------- the element index ---------- */

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
  for (const finding of lintFindings()) {
    let elements: Element[] = []
    try {
      elements = resolveFinding(finding)
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

/**
 * Re-reads the page for the current findings, and tells listeners only when an
 * answer moved.
 *
 * The index is built per audit, but the page keeps changing under it: a
 * client-side route change, a hot reload that replaces the elements, a list
 * that renders more rows. The marker layer calls this on each of those, and a
 * finding whose elements are now different gets its badge and its "on this
 * page" count back without another Audit. Comparing first is what keeps an app
 * that re-renders often from rebuilding the panel every time it does.
 */
export function refreshLintResolution(): void {
  if (!findings.length) return
  const previous = placements
  placements = null
  byElement = null
  byId = null
  buildResolution()
  // Nobody had read the last index since it was dropped, so nobody shows it.
  if (!previous || samePlacements(previous, placements ?? [])) return
  resolutionEpoch += 1
  notify()
}

function samePlacements(left: readonly LintPlacement[], right: readonly LintPlacement[]): boolean {
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]
    if (entry.finding !== other.finding || entry.elements.length !== other.elements.length) return false
    return entry.elements.every((element, at) => element === other.elements[at])
  })
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
 * once per audit and re-read when the findings change or the page does (see
 * `refreshLintResolution`); this function itself never touches the document.
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
  const visible = lintFindings()
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

/** Whether the audit layer is the one on screen. See `MarkerLayer` in `annotations/store`. */
export function markersShown(): boolean {
  return markerLayer() === "audit"
}

/**
 * Switches the canvas between the two marker layers.
 *
 * Called from the panel's Hide markers toggle, and callable from the annotation
 * side: turning note pins on is the same decision seen from the other end, and
 * it is spelled `setMarkersShown(false)` rather than as a second flag. The
 * layer listener above turns the change into a `notify`, so this one does not.
 */
export function setMarkersShown(next: boolean): void {
  setMarkerLayer(next ? "audit" : "notes")
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
 *
 * The run carries its start tick. A fix can land while it runs (Fix stays
 * live during an audit), and the server's checkers may have read the file
 * before that write: the run's late answer would then list the fixed row
 * again, and a second Fix on it says "no longer reported". So a finding whose
 * fix landed after this run started is left out of its answer. A reset in
 * between makes the whole answer stale.
 */
export function runAudit(apiBase: string): Promise<LintFinding[]> {
  if (runInFlight) return runInFlight
  const startedAt = ++clock
  const reset = resets
  runState = "running"
  lastError = null
  notify()
  runInFlight = send<{ findings?: LintFinding[]; ranAt?: string }>(endpoint(apiBase, "/run"), {
    method: "POST",
    body: JSON.stringify({}),
  })
    .then((payload) => {
      if (reset !== resets) return findings
      const fixedSince = (id: string): boolean => {
        const fix = fixes.get(id)
        return fix?.kind === "fixed" && fix.at > startedAt
      }
      const answered = Array.isArray(payload.findings) ? payload.findings : []
      findings = answered.filter((finding) => !fixedSince(finding.id))
      // An answer older than this run is now part of its result.
      for (const [id, fix] of fixes) if (fix.kind !== "fixing" && fix.at < startedAt) fixes.delete(id)
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
      if (reset !== resets) throw error
      runState = "error"
      lastError = error instanceof Error ? error.message : String(error)
      runInFlight = null
      notify()
      throw error
    })
  return runInFlight
}

/** Where one finding's fix is. See `LintFixState`. */
export function lintFixState(id: string): LintFixState {
  return fixes.get(id) ?? IDLE_FIX
}

const IDLE_FIX: LintFixState = { kind: "idle" }

/**
 * Applies the fixes the server said it could make, and drops them from the list.
 *
 * Removal on the server's word rather than an automatic re-run: a re-audit
 * costs the same minute the first one did, and the server has just told us
 * exactly which ids it wrote. The ones it could NOT write stay in the list,
 * which is the point of returning `failed` — a finding whose snippet had moved
 * under us is reported, never force-written, and the row has to still be there
 * to say so.
 *
 * An id already `fixing` is left out of the request, so a second press, or
 * Fix all over a row that is still being fixed, never sends one finding twice.
 * The server queues every fix as well, so two requests in one file cannot lose
 * an edit; this half keeps the screen honest about what is in flight.
 */
export function fixFindings(apiBase: string, ids: string[]): Promise<LintFixResult> {
  const sent = ids.filter((id) => fixes.get(id)?.kind !== "fixing")
  if (!sent.length) return Promise.resolve({ fixed: [], failed: [] })
  const token = ++clock
  for (const id of sent) fixes.set(id, { kind: "fixing", token })
  notify()
  /** Only the ids this request still owns: a reset or a newer press overtakes it. */
  const owned = (id: string): boolean => {
    const fix = fixes.get(id)
    return fix?.kind === "fixing" && fix.token === token
  }
  return send<LintFixResult>(endpoint(apiBase, "/fix"), {
    method: "POST",
    body: JSON.stringify({ ids: sent }),
  }).then(
    (result) => {
      const answer = { fixed: result.fixed ?? [], failed: result.failed ?? [] }
      const at = ++clock
      const written = new Set(answer.fixed.filter(owned))
      for (const id of written) fixes.set(id, { kind: "fixed", at })
      for (const { id, reason } of answer.failed) {
        if (owned(id)) fixes.set(id, { kind: "failed", at, reason })
      }
      // An id the server named in neither list was not written.
      for (const id of sent) {
        if (owned(id)) fixes.set(id, { kind: "failed", at, reason: "The server did not report this fix." })
      }
      if (written.size) {
        findings = findings.filter((finding) => !written.has(finding.id))
        invalidateResolution()
      }
      notify()
      return answer
    },
    (error: unknown) => {
      const at = ++clock
      const reason = error instanceof Error ? error.message : String(error)
      for (const id of sent) if (owned(id)) fixes.set(id, { kind: "failed", at, reason })
      notify()
      throw error
    }
  )
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
  fixes.clear()
  resets += 1
  setMarkerLayer("notes")
  invalidateResolution()
}
