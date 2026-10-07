/**
 * What the editor knows about a place, and the brief it hands to an agent.
 *
 * Two jobs, and they are one file because they are one contract: the capture
 * side decides which facts survive the page reloading, and the serialize side
 * is the only reader of them. Splitting the two put the cap on `text` in one
 * file and the code that printed a 4KB paragraph in another.
 *
 * CAPTURE runs inside the click that creates a note, so everything here is
 * synchronous. That rules out `resolveElementSource`, which is a sourcemap
 * fetch and sometimes a grep — holding the marker until it lands would mean a
 * pointer gesture that visibly waits. What it does instead is ask the editor
 * store whether the answer is already known (see `sourceOf`), and otherwise
 * report no file rather than a guess.
 *
 * SERIALIZE writes Agentation's `## Page Feedback` format — the same header,
 * the same `### N.` items, the same `**Location:**` / `**Source:**` /
 * `**Feedback:**` fields at the same four detail levels. Agentation runs beside
 * this editor as a companion, and a designer using both should not hand an
 * agent two different documents for the same kind of note. The one thing this
 * says that Agentation never has to is WHICH KIND of edit each item is. A brief
 * that mixes "the designer already did this" with "the designer wants this" is
 * how an agent ends up reverting work that is already in the file it just
 * opened, so every edit carries a `**Status:**` of its own.
 */

import { owningComponentName } from "../core/angular"
import {
  isProjectSourcePath,
  normalizeSourcePath,
  type RewriteElementInfo,
  type RewriteStack,
} from "../core/bridge"
import { shortenAbsolutePaths } from "../core/change-prompt"
import { config } from "../core/config"
import { nthOfType } from "../core/element-target"
import { getState } from "../core/store"
import {
  accessibilitySummary,
  classSummary,
  elementName,
  fullDomPath,
  locationPath,
  nearbyElements,
  nearbyText,
} from "./identify"
import { edits, isEditQueued, owedEditCount } from "./journal"
import { annotations, annotationSettings } from "./store"
import type {
  AnnotationRecord,
  AnnotationRect,
  AnnotationTarget,
  EditRecord,
  OutboxItem,
  OutputDetail,
} from "./types"

/** A text node longer than this is an article, not a label — `element-code.ts`'s cap. */
const MAX_TEXT = 120
/** Deep enough to name the feature, short enough that a note is not a stack trace. */
const MAX_COMPONENTS = 5
const MAX_ANCESTRY = 5
const MAX_PATH_DEPTH = 5
/**
 * A Tailwind element carries twenty utilities. A selector spelling all of them
 * is wider than the panel, and stops matching the moment one utility changes —
 * two classes is enough to pick the element out of its siblings and cheap to
 * re-read when it does not.
 */
const MAX_PATH_CLASSES = 2

/**
 * The properties a designer would name, out of the three hundred
 * `getComputedStyle` resolves.
 *
 * Chosen to answer the questions a note actually raises — what colour is it,
 * how is the type set, how big is it, how is it laid out, what is drawn on it.
 * Everything else is noise that pushes the note itself off the top of the
 * agent's context. Only the forensic brief prints these, as
 * `**Computed Styles:**`, and it skips the values that change nothing.
 */
const INTERESTING_STYLES = [
  "color",
  "background-color",
  "border-color",
  "font-size",
  "font-weight",
  "font-family",
  "line-height",
  "letter-spacing",
  "text-align",
  "width",
  "height",
  "padding",
  "margin",
  "border",
  "border-radius",
  "display",
  "position",
  "z-index",
  "flex-direction",
  "justify-content",
  "align-items",
  "gap",
  "opacity",
  "overflow",
  "box-shadow",
  "transform",
] as const

/** Computed values that mean "nothing set here", left out of `**Computed Styles:**`. */
const NO_OP_STYLES = new Set([
  "none",
  "normal",
  "auto",
  "0px",
  "rgba(0, 0, 0, 0)",
  "transparent",
  "static",
  "visible",
])

/* -------------------------------------------------------------------------
 * Capture
 * ---------------------------------------------------------------------- */

/**
 * The vendor bridge as the global holds it, NOT as `whenBridgeReady` hands it
 * over.
 *
 * `whenBridgeReady` wraps `elementInfo` so an Angular host gets an answer from
 * `owningComponentName`, and this module is one of the things that wrapper
 * exists for — but capture is synchronous and the wrapper is behind a promise.
 * So the framework branch is made here, explicitly, and the raw global is only
 * ever asked the React question.
 */
function reactInfo(element: Element): RewriteElementInfo | null {
  const bridge = window.__DESIGNLAYER_BRIDGE__
  if (!bridge) return null
  try {
    return bridge.elementInfo(element)
  } catch {
    // The fiber lookup throws on a node React never rendered — an SVG the host
    // injected, or anything inside a third-party widget.
    return null
  }
}

/**
 * Bundlers prefix a renamed class with `_`, so an Angular component arrives as
 * `_ShellComponent`. `bridge.ts` tidies it for the layers tree for the same
 * reason it is tidied here: the server owns the real mapping, and a brief that
 * tells an agent to open `_ShellComponent` names a symbol that is in no file.
 */
function displayName(raw: string | null | undefined): string | null {
  const name = (raw ?? "").replace(/^_+/, "").trim()
  return name || null
}

/** The component whose template authored this element, on either host. */
function componentNameOf(element: Element): string | null {
  if (config.host.framework === "angular") return displayName(owningComponentName(element))
  return displayName(reactInfo(element)?.componentName)
}

/**
 * The component stack, INNERMOST FIRST.
 *
 * One order had to be picked and this is the one both hosts produce naturally:
 * React's owner stack already reads that way, and Angular's is built by
 * climbing out of the element. It is also the useful order — the first name is
 * the component whose file the agent opens, and everything after it is
 * context for finding that file. Reversing it would put the least actionable
 * name where the eye lands first.
 */
function componentStack(element: Element): string[] {
  return config.host.framework === "angular" ? angularStack(element) : reactStack(element)
}

/**
 * Angular has no stack to read, so one is walked.
 *
 * `ng.getOwningComponent` answers for one node, and every element inside a
 * single template answers with the same component — so the walk climbs and
 * keeps only the changes. `owningComponentName` is reused rather than
 * reimplemented because it already handles the two cases that make a naive
 * call return null: a projected `<ng-content>` child, and Angular throwing on
 * a node outside any component tree.
 */
function angularStack(element: Element): string[] {
  const names: string[] = []
  for (
    let node: Element | null = element;
    node && names.length < MAX_COMPONENTS;
    node = node.parentElement
  ) {
    const name = displayName(owningComponentName(node))
    // Consecutive only: a component that renders itself recursively is a real
    // repeat in the stack and collapsing it would hide the nesting.
    if (name && name !== names[names.length - 1]) names.push(name)
  }
  return names
}

function reactStack(element: Element): string[] {
  const info = reactInfo(element)
  if (!info) return []
  const frames = Array.isArray(info.stack) ? info.stack : []
  const names: string[] = []
  for (const candidate of [info.componentName, ...frames.map((frame) => frame.componentName)]) {
    const name = displayName(candidate)
    if (name && name !== names[names.length - 1]) names.push(name)
    if (names.length === MAX_COMPONENTS) break
  }
  return names
}

/**
 * Where this element is written, as far as anything can say without waiting.
 *
 * The store is asked FIRST and it is the only route that works on an Angular
 * host: `context.ts` primes the resolver on selection and patches the answer
 * into the stored `Selection`, so by the time someone annotates the element
 * they have selected, the round trip has usually already happened. Nothing
 * else here may re-derive it — `bridge.ts` is explicit that source resolution
 * has one owner, and this is a read of that owner's result, not a second
 * attempt at it.
 *
 * The fallback walks the frames the synchronous fiber lookup offers, filtered
 * by `isProjectSourcePath` for the reason measured in `bridge.ts`: about half
 * of them symbolicate into a turbopack chunk, and a brief naming
 * `src_components_0w_i7fl._.js:953` sends an agent to open a file that is not
 * source.
 */
interface SourceFacts {
  filePath: string | null
  lineNumber: number | null
  columnNumber: number | null
}

function sourceOf(element: Element): SourceFacts {
  const known = getState().selection.find((entry) => entry.element === element)?.source
  if (known?.filePath) {
    return {
      filePath: known.filePath,
      lineNumber: known.lineNumber || null,
      columnNumber: known.columnNumber || null,
    }
  }

  const info = reactInfo(element)
  if (!info) return { filePath: null, lineNumber: null, columnNumber: null }
  const frames: Array<RewriteElementInfo | RewriteStack> = [
    info,
    ...(Array.isArray(info.stack) ? info.stack : []),
  ]
  for (const frame of frames) {
    const filePath = normalizeSourcePath(frame.filePath)
    if (!isProjectSourcePath(filePath)) continue
    return { filePath, lineNumber: frame.lineNumber || null, columnNumber: frame.columnNumber || null }
  }
  return { filePath: null, lineNumber: null, columnNumber: null }
}

/**
 * Computed styles, or nothing at all.
 *
 * Both ways this can fail are ordinary. A node removed from the tree still
 * answers, with every property resolving to the empty string, which is why
 * empties are dropped rather than reported as facts. A node from a document
 * with no browsing context — anything a `DOMParser` built — has no
 * `defaultView` to ask, and asking anyway is a `TypeError` that would take the
 * whole capture down and lose the note with it.
 *
 * `border` is dropped by the same empty test whenever the four sides differ,
 * because that is the one shorthand `getComputedStyle` refuses to serialize.
 */
function computedStyles(element: Element): Record<string, string> {
  const styles: Record<string, string> = {}
  let declaration: CSSStyleDeclaration | null = null
  try {
    declaration = element.ownerDocument?.defaultView?.getComputedStyle(element) ?? null
  } catch {
    declaration = null
  }
  if (!declaration) return styles
  for (const property of INTERESTING_STYLES) {
    const value = declaration.getPropertyValue(property).trim()
    if (value) styles[property] = value
  }
  return styles
}

/** One of `identify.ts`'s readings, or an empty answer if the node refuses. */
function attempt(read: () => string): string {
  try {
    return read()
  } catch {
    return ""
  }
}

/**
 * `getAttribute("class")`, never `.className`: on an `<svg>` the property is an
 * `SVGAnimatedString` and stringifying it yields `[object SVGAnimatedString]`.
 * Every lucide icon in a host app is one of those, and an icon is a perfectly
 * ordinary thing to annotate.
 */
function classAttribute(element: Element): string {
  return element.getAttribute("class") ?? ""
}

function truncate(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

/**
 * The element's text, collapsed and capped.
 *
 * The cap is not cosmetic. A note pinned to a `<section>` reads `textContent`
 * for the whole feature, and without this the brief opened with two thousand
 * characters of page copy before the sentence the designer actually wrote.
 */
function visibleText(element: Element): string {
  return truncate((element.textContent ?? "").replace(/\s+/g, " ").trim())
}

function ancestryOf(element: Element): AnnotationTarget["ancestry"] {
  const ancestry: AnnotationTarget["ancestry"] = []
  for (
    let node = element.parentElement;
    node && ancestry.length < MAX_ANCESTRY;
    node = node.parentElement
  ) {
    if (node === document.body || node === document.documentElement) break
    ancestry.push({
      tagName: node.tagName.toLowerCase(),
      className: classAttribute(node),
      componentName: componentNameOf(node),
    })
  }
  return ancestry
}

/**
 * Everything worth remembering about the element a note points at.
 *
 * Read once, here, and never re-read: the page under the editor is a dev
 * server that hot-reloads, and a description that changed under the note would
 * be a note about something nobody said. Nothing in this function may throw —
 * the element can already be detached by the time a note is filed against it,
 * and losing the note to that would be strictly worse than a description with
 * empty fields in it.
 *
 * The component stack is gathered unconditionally. It used to be behind a
 * settings switch, which asked the designer to answer a question the editor
 * had already answered for itself — `componentStack` branches on the detected
 * host and comes back empty on a page neither framework rendered, which is the
 * only honest "off" there ever was. What the brief SAYS about the stack is
 * still `outputDetail`'s call, in `renderTarget`.
 */
export function describeElement(element: Element): AnnotationTarget {
  const { filePath, lineNumber, columnNumber } = sourceOf(element)
  const tagName = element.tagName.toLowerCase()
  return {
    tagName,
    componentName: componentNameOf(element),
    className: classAttribute(element),
    id: element.getAttribute("id"),
    selector: cssPath(element),
    text: visibleText(element),
    filePath,
    lineNumber,
    columnNumber,
    ancestry: ancestryOf(element),
    computed: computedStyles(element),
    components: componentStack(element),
    name: attempt(() => elementName(element)) || tagName,
    path: attempt(() => locationPath(element)),
    fullPath: attempt(() => fullDomPath(element)),
    nearbyText: attempt(() => nearbyText(element)),
    nearbyElements: attempt(() => nearbyElements(element)),
    accessibility: attempt(() => accessibilitySummary(element)),
  }
}

/* -------------------------------------------------------------------------
 * The selector
 * ---------------------------------------------------------------------- */

/**
 * `CSS.escape` is the only correct answer for a Tailwind class — `hover:bg-red-500/50`
 * has three characters that end a selector early. The fallback exists because
 * this module is also loaded in unit tests, where `CSS` is not defined.
 */
function escapeIdent(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value)
  return value.replace(/([^\w-])/g, "\\$1")
}

/**
 * `#id` only when it resolves to THIS element.
 *
 * `getElementById` returns the first node with the id, which is exactly what
 * devtools does with `#id` — so agreeing with it is the test. An id that is
 * duplicated later in the document still anchors the path for the first one
 * and correctly refuses to for the rest.
 */
function uniqueIdSelector(element: Element): string | null {
  const id = element.getAttribute("id")
  if (!id) return null
  return element.ownerDocument?.getElementById(id) === element ? `#${escapeIdent(id)}` : null
}

/**
 * Whether a sibling answers to the same segment.
 *
 * Asked of the finished segment rather than of the tag, which is the whole
 * point. Two Tailwind buttons that share `px-4` and differ in everything else
 * both match `button.px-4`, so a segment that stopped at the class list
 * silently selected the first of them — and a note pinned to Cancel read in
 * devtools as a note about Save. Classes only disambiguate when they actually
 * do, and this is the test.
 */
function ambiguousAmongSiblings(element: Element, selector: string): boolean {
  const parent = element.parentElement
  if (!parent) return false
  for (const child of Array.from(parent.children)) {
    if (child === element) continue
    try {
      if (child.matches(selector)) return true
    } catch {
      // A class `escapeIdent` could not turn into a legal selector. Unprovable
      // is treated as ambiguous: a position suffix on a selector that did not
      // need one still finds the element, and omitting one that was needed
      // does not.
      return true
    }
  }
  return false
}

/**
 * Classes that will still be there next time.
 *
 * Angular adds and removes `ng-star-inserted` and `ng-tns-c*` as the view
 * changes, so a selector built on one matches now and matches nothing after
 * the next change detection — which reads to whoever pasted it as the element
 * having been deleted.
 */
function isStableClass(name: string): boolean {
  return Boolean(name) && !name.startsWith("ng-")
}

function segmentFor(element: Element): string {
  const tag = element.tagName.toLowerCase()
  const classes = Array.from(element.classList)
    .filter(isStableClass)
    .slice(0, MAX_PATH_CLASSES)
    .map((name) => `.${escapeIdent(name)}`)
    .join("")
  const candidate = `${tag}${classes}`
  if (!ambiguousAmongSiblings(element, candidate)) return candidate
  // Position is the tie-breaker of last resort. `nthOfType` is reused from
  // `element-target` so the index in a pasted selector and the index the
  // source-side writer matches on can never drift apart; CSS counts from one
  // and that function counts from zero.
  return `${candidate}:nth-of-type(${nthOfType(element) + 1})`
}

/**
 * A selector a human can paste into devtools.
 *
 * Capped at five segments, and anchored early on any ancestor with a unique
 * id. A full path from `html` on a modern app is forty segments of `div`, which
 * nobody reads and which breaks on the first layout change; five is short
 * enough to scan and specific enough to land. The cost of the cap is honest —
 * an uncapped path is rooted and a capped one is not, so a five-segment path
 * can match more than one element. It is a way to FIND the thing, not an
 * identity for it, which is what `ancestry` and the component stack are for.
 */
export function cssPath(element: Element): string {
  const segments: string[] = []
  for (
    let node: Element | null = element;
    node && segments.length < MAX_PATH_DEPTH;
    node = node.parentElement
  ) {
    const anchor = uniqueIdSelector(node)
    if (anchor) {
      segments.unshift(anchor)
      break
    }
    if (node === document.body || node === document.documentElement) {
      segments.unshift(node.tagName.toLowerCase())
      break
    }
    segments.unshift(segmentFor(node))
  }
  return segments.join(" > ")
}

/* -------------------------------------------------------------------------
 * The outbox
 * ---------------------------------------------------------------------- */

/**
 * An unparseable timestamp sorts to the front rather than to `NaN`, which
 * `Array.sort` would scatter the whole list around. `sort` is stable, so
 * anything that ties keeps the order the two stores were read in.
 */
function timeOf(iso: string): number {
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : 0
}

/**
 * Notes and edits as one list, oldest first.
 *
 * The merge happens here and nowhere earlier. The two stores are filled by
 * unrelated machinery — one by a pointer gesture, one by every write the editor
 * makes — and joining them at the source would put the writer's hot path
 * through the annotation store for the sake of a list only the panel and the
 * brief ever read.
 *
 * Chronological because that is the only order in which the two kinds make
 * sense together: "I moved this" followed by "and it still looks wrong" is a
 * different report from the same two items the other way round.
 */
export function outboxItems(): OutboxItem[] {
  const items: OutboxItem[] = [
    ...annotations().map(
      (note): OutboxItem => ({ type: "note", at: timeOf(note.createdAt), note })
    ),
    ...edits().map(
      (edit: EditRecord): OutboxItem => ({ type: "edit", at: timeOf(edit.createdAt), edit })
    ),
  ]
  return items.sort((a, b) => a.at - b.at)
}

/** The id a row, a pin and a hover event all name an item by. */
export function outboxId(item: OutboxItem): string {
  return item.type === "note" ? item.note.id : item.edit.id
}

/**
 * ONE NUMBER PER ITEM, the same on the row, the pin and in the brief.
 *
 * The position in `outboxItems()`, counted from one. Notes and edits share the
 * run: the fourth thing that happened in the session is 4 wherever it is shown,
 * so "fix 4" means the same item to the designer reading the panel, the pin on
 * the canvas, and the agent reading the brief.
 */
export function outboxNumbers(items: OutboxItem[] = outboxItems()): Map<string, number> {
  return new Map(items.map((item, index) => [outboxId(item), index + 1]))
}

/**
 * How many rows still want something from the designer.
 *
 * Every row the Changes tab does NOT badge "In your files": the notes, the
 * edits no commit can write, and — the one that is easy to miss — the edits
 * that are merely queued. It lives here, beside `outboxItems`, because two
 * surfaces ask the question and they must not answer it differently: the count
 * on the inspector's tab and the count on the toolbar's pending indicator are
 * the same promise about the same list, and a bar reading "3" over a list
 * showing four things is worse than a bar with no number at all.
 *
 * `written` cannot answer it alone. The writer sets that flag the moment it
 * knows it CAN spell a change, long before any commit runs, so counting
 * `!written` silently omits every Ready row. `queued` is the other half.
 */
export function owedCount(): number {
  // Every note, plus the edits `owedEditCount` counts. No sort: only the
  // number is wanted, and the tab badge asks on every journal announce.
  return annotations().length + owedEditCount()
}

/* -------------------------------------------------------------------------
 * The brief
 * ---------------------------------------------------------------------- */

/**
 * Whose components these are, as the field is named.
 *
 * Agentation calls the line `**React:**` because React is all it reads. This
 * editor also reads Angular, and the label is the part of the line an agent
 * acts on: told to look for a React component in an Angular project it will
 * search for a file that was never going to exist, and conclude the brief is
 * describing a different application. So the field keeps Agentation's shape
 * and takes the host's name.
 */
function componentsLabel(): string {
  return config.host.framework === "angular" ? "Angular" : "React"
}

/**
 * `<Routes> <Shell> <Home> <Card>` — OUTERMOST first, the order Agentation
 * prints. The stack is captured innermost first (see `componentStack`), so it
 * is reversed here, at the one place that prints it.
 *
 * With no stack, the owning component alone is a stack of one. The journal
 * captures only that, and so does a note whose file never resolved — where the
 * component name is the one thing the agent has left to search for.
 */
function componentsLine(target: AnnotationTarget | null): string | null {
  const stack = Array.isArray(target?.components) ? target.components : []
  const names = stack.length ? stack : target?.componentName ? [target.componentName] : []
  if (!names.length) return null
  return `**${componentsLabel()}:** ${[...names].reverse().map((name) => `<${name}>`).join(" ")}`
}

/**
 * The path as it is safe to show, with the line and column.
 *
 * `shortenAbsolutePaths` cuts an absolute path to its `src/` tail, but only when
 * there IS an `src/` in it — a monorepo package laid out as `packages/ui/lib`
 * comes through absolute. The last two segments are what the Design tab shows
 * for the same case, and they carry no home directory.
 */
function sourceLabel(
  filePath: string,
  lineNumber: number | null,
  columnNumber: number | null
): string {
  const shortened = shortenAbsolutePaths(filePath)
  const path = shortened.startsWith("/") ? shortened.split("/").slice(-2).join("/") : shortened
  if (!lineNumber) return path
  return columnNumber ? `${path}:${lineNumber}:${columnNumber}` : `${path}:${lineNumber}`
}

function sourceOfTarget(target: AnnotationTarget | null): string | null {
  if (!target?.filePath) return null
  return sourceLabel(target.filePath, target.lineNumber, target.columnNumber ?? null)
}

function stringFact(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * The heading for a target captured before names were.
 *
 * A note stored by an older build has its tag and text and nothing else this
 * needs, and the brief still has to call it something.
 */
function targetName(target: AnnotationTarget): string {
  const name = stringFact(target.name)
  if (name) return name
  const text = stringFact(target.text)
  return text ? `${target.tagName} "${text.slice(0, 40)}"` : target.tagName
}

/**
 * The page the notes are on: path, query and hash, like Agentation's header.
 * Never the origin — the agent already knows which dev server it is in.
 */
function pageLabel(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

/**
 * Which app, in the words the Agentation companion uses for the same page.
 *
 * Both tools read `config.app.name` and fall back to the port, so a note from
 * either one names the app identically. Escaped because it is a package name
 * printed inside markdown, and `my_app` is otherwise an italic.
 */
function appLabel(): string {
  const name = (config.app.name ?? "").replace(/[\r\n\t]+/g, " ").trim()
  const label = name || `app on ${window.location.host}`
  return label.replace(/[\\`*_[\]<>]/g, "\\$&")
}

function viewportLabel(): string {
  return `${window.innerWidth}×${window.innerHeight}`
}

/**
 * The block that answers "it looks fine on my machine". Forensic only, and once
 * per brief rather than once per note, because every note in a brief was made
 * in the same tab at the same size.
 */
function environmentBlock(): string[] {
  return [
    "",
    "**Environment:**",
    `- Viewport: ${viewportLabel()}`,
    `- URL: ${window.location.href}`,
    `- User Agent: ${navigator.userAgent}`,
    `- Timestamp: ${new Date().toISOString()}`,
    `- Device Pixel Ratio: ${window.devicePixelRatio}`,
    "",
    "---",
  ]
}

/**
 * The vocabulary is `change-prompt.ts`'s, deliberately.
 *
 * `class`, `icon`, `text` and `remove` are sentinels rather than CSS
 * properties, and an agent handed "set `remove` to ``" has no idea what was
 * wanted. Two spellings of "what changed" in one codebase is how the Prompts
 * tab and this brief come to describe the same edit differently.
 */
function editPhrase(edit: EditRecord): string {
  if (edit.property === "remove") {
    return "delete this element, and any import or handler left unused by its removal"
  }
  if (edit.property === "icon") {
    return `swap the icon to \`${edit.to}\` (was \`${edit.from || "unknown"}\`)`
  }
  if (edit.property === "class") {
    return `the class attribute becomes \`${edit.to}\` (was \`${edit.from || "none"}\`)`
  }
  if (edit.property === "text") {
    return `the text becomes “${truncate(edit.to)}” (was “${truncate(edit.from)}”)`
  }
  return `set \`${edit.property}\` to \`${edit.to}\`${edit.from ? ` (was \`${edit.from}\`)` : ""}`
}

/**
 * One numbered item, note or edit, before it is printed.
 *
 * `target` answers `**Source:**` and the component line; `facts` answers
 * everything that describes the element itself. They differ only for a region:
 * the element under the middle of the box is a fair guess at which file the
 * box is in, and no description at all of the box.
 */
interface BriefItem {
  name: string
  location: string
  target: AnnotationTarget | null
  facts: AnnotationTarget | null
  rect: AnnotationRect | null
  selectedText: string
  /** `Feedback` for a note, `Change` for an edit — the item's last line. */
  field: "Feedback" | "Change"
  body: string
  /** An edit's `EditStatus`; a note has none. */
  status: EditStatus | null
}

/**
 * Where an edit stands, as the agent must read it.
 *
 * Three states, because `written` alone is two of them: the writer sets it the
 * moment it can spell a change, so a queued edit is `written` and still in no
 * file. Calling that "already written" tells the agent to skip the one change
 * the editor has not made yet; calling it "needs writing" gets it written
 * twice, once by hand and once by the editor's own Apply.
 */
interface EditStatus {
  /** The `**Status:**` line. */
  full: string
  /** The tail of a compact line. */
  short: string
}

const WRITTEN: EditStatus = {
  full: "Already written to source — do not apply again",
  short: "already written, do not apply again",
}
const QUEUED: EditStatus = {
  full: "Queued in DesignLayer — it will write this itself; do not apply by hand",
  short: "queued in DesignLayer, do not apply by hand",
}
const PREVIEW: EditStatus = {
  full: "Showing in the browser only — still needs writing",
  short: "browser only, still needs writing",
}

function editStatus(edit: EditRecord): EditStatus {
  if (!edit.written) return PREVIEW
  return isEditQueued(edit.id) ? QUEUED : WRITTEN
}

function noteItem(note: AnnotationRecord): BriefItem {
  const { target } = note
  const region = note.kind === "region"
  return {
    name: region ? "Area selection" : target ? targetName(target) : "text selection",
    location: region
      ? `region at (${Math.round(note.rect.x)}, ${Math.round(note.rect.y)})`
      : target
        ? stringFact(target.path) || target.selector
        : "unknown",
    target,
    facts: region ? null : target,
    rect: note.rect,
    selectedText: (note.selectedText ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    field: "Feedback",
    body: note.comment.trim() || "(no comment)",
    status: null,
  }
}

function editItem(edit: EditRecord): BriefItem {
  const { target } = edit
  return {
    // Not "the page". An edit with no target is an edit whose element the
    // journal could not describe, and saying "the page" would send an agent
    // looking for a layout-level change that nobody made.
    name: target ? targetName(target) : "an element the editor could not describe",
    location: target ? stringFact(target.path) || target.selector : "unknown",
    target,
    facts: target,
    rect: null,
    selectedText: "",
    field: "Change",
    body: editPhrase(edit),
    status: editStatus(edit),
  }
}

/** `color: rgb(…); font-size: 14px` — the styles that set something. */
function computedLine(target: AnnotationTarget | null): string {
  const computed = target?.computed && typeof target.computed === "object" ? target.computed : {}
  return Object.entries(computed)
    .filter(([, value]) => typeof value === "string" && value && !NO_OP_STYLES.has(value))
    .map(([property, value]) => `${property}: ${value}`)
    .join("; ")
}

/**
 * One item, at one detail level, in Agentation's field order.
 *
 * Compact is one line and stops. Standard says where the thing is; detailed
 * adds its classes, its box and the words around it; forensic swaps the short
 * location for the full DOM path and adds styles, accessibility and
 * neighbours. Every field is skipped rather than printed empty.
 */
function renderItem(index: number, item: BriefItem, detail: OutputDetail): string[] {
  const { facts, rect, selectedText } = item
  const source = sourceOfTarget(item.target)

  if (detail === "compact") {
    const quote = selectedText
      ? ` (re: "${selectedText.slice(0, 30)}${selectedText.length > 30 ? "..." : ""}")`
      : ""
    const status = item.status ? ` — ${item.status.short}` : ""
    return [`${index}. **${item.name}**${source ? ` (${source})` : ""}: ${item.body}${quote}${status}`]
  }

  const lines = [`### ${index}. ${item.name}`]
  const components = componentsLine(item.target)
  const classes = facts?.className ? classSummary(stringFact(facts.className)) : ""
  const context = !selectedText ? stringFact(facts?.nearbyText).slice(0, 100) : ""
  const selected = selectedText ? `**Selected text:** "${selectedText}"` : null

  if (detail === "forensic") {
    // A target stored before the full path was captured still says where it
    // is — under the label that is true of what it has.
    const fullPath = stringFact(facts?.fullPath)
    if (fullPath) lines.push(`**Full DOM Path:** ${fullPath}`)
    else if (facts) lines.push(`**Location:** ${item.location}`)
    if (classes) lines.push(`**CSS Classes:** ${classes}`)
    if (rect) {
      lines.push(
        `**Position:** x:${Math.round(rect.x)}, y:${Math.round(rect.y)} (${Math.round(rect.width)}×${Math.round(rect.height)}px)`,
        `**Annotation at:** ${((rect.x / Math.max(window.innerWidth, 1)) * 100).toFixed(1)}% from left, ${Math.round(rect.y)}px from top`
      )
    }
    if (selected) lines.push(selected)
    if (context) lines.push(`**Context:** ${context}`)
    const styles = computedLine(facts)
    if (styles) lines.push(`**Computed Styles:** ${styles}`)
    const accessibility = stringFact(facts?.accessibility)
    if (accessibility) lines.push(`**Accessibility:** ${accessibility}`)
    const neighbours = stringFact(facts?.nearbyElements)
    if (neighbours) lines.push(`**Nearby Elements:** ${neighbours}`)
    if (source) lines.push(`**Source:** ${source}`)
    if (components) lines.push(components)
  } else {
    lines.push(`**Location:** ${item.location}`)
    if (source) lines.push(`**Source:** ${source}`)
    if (components) lines.push(components)
    if (detail === "detailed") {
      if (classes) lines.push(`**Classes:** ${classes}`)
      if (rect) {
        lines.push(
          `**Position:** ${Math.round(rect.x)}px, ${Math.round(rect.y)}px (${Math.round(rect.width)}×${Math.round(rect.height)}px)`
        )
      }
    }
    if (selected) lines.push(selected)
    if (detail === "detailed" && context) lines.push(`**Context:** ${context}`)
  }

  if (item.status) lines.push(`**Status:** ${item.status.full}`)
  lines.push(`**${item.field}:** ${item.body}`, "")
  return lines
}

/**
 * The whole session as markdown an agent can act on, in Agentation's format.
 *
 * ONE list, in the order of `items` — chronological, notes and edits
 * interleaved — and each item numbered by its position, so the numbers are
 * `outboxNumbers`'s and "fix 4" means the same thing in the brief as on the
 * row and the pin. A note prints exactly what Agentation would copy for it.
 *
 * Each edit states its status on its own line, just before its change. That
 * exists to prevent a specific failure — an agent that opens the file, sees
 * the padding change already applied, and applies it a second time because
 * nothing told it the designer had got there first. The same warning also
 * sits once under the header, where an agent that skims still reads it.
 */
export function buildAnnotationBrief(items: OutboxItem[] = outboxItems()): string {
  const detail = annotationSettings().outputDetail

  // Every note goes. There is no resolved state to filter out any more — the
  // only way to take a note off this list is to delete it, which removes it
  // from the store, so anything still here is by definition still wanted.
  if (!items.length) {
    return "Nothing to hand over yet. Pin a note on the page, or make a change, and it lands here."
  }

  const briefItems = items.map((item) =>
    item.type === "note" ? noteItem(item.note) : editItem(item.edit)
  )

  const lines: string[] = [`## Page Feedback: ${pageLabel()}`, `**App:** ${appLabel()}`]
  if (detail === "forensic") lines.push(...environmentBlock())
  else if (detail !== "compact") lines.push(`**Viewport:** ${viewportLabel()}`)
  lines.push("")
  if (briefItems.some((item) => item.status === WRITTEN)) {
    lines.push(
      "Items marked already written are in the source files. Do not apply them again — a second application is a conflict, not a fix.",
      ""
    )
  }

  briefItems.forEach((item, index) => lines.push(...renderItem(index + 1, item, detail)))

  // Collapse the blank lines left where blocks join, and end where the last
  // item ends, as Agentation's copy does.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * What is safe to put on someone's clipboard.
 *
 * Only the path rule of `sanitizeChangePrompt`: an absolute path is cut to its
 * `src/` tail so a screen-shared brief does not carry the user's home directory
 * and their name. The other rule — dropping `**Source:**` lines — is NOT
 * applied, because in this brief `**Source:**` is Agentation's field name and
 * every path on it already passed `isProjectSourcePath`. The helper is imported
 * rather than copied so the next fix to the regex lands in one place.
 */
export function sanitizeBrief(text: string): string {
  return shortenAbsolutePaths(text)
}
