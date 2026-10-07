/**
 * What an annotation IS, and what the editor remembers about one.
 *
 * An annotation is the opposite of every other thing this editor produces. The
 * inspector makes a change and writes it; an annotation makes no change at all
 * — it is a note pinned to a place, saying what is wrong there. That is worth
 * having precisely because the interesting problems have no element to edit:
 * a gap that is too tight, a section that is missing, a state nobody drew.
 *
 * So the model has to carry two things the change ledger never needed. A
 * `kind`, because "this button" and "this empty space" are annotated by
 * different gestures and read differently to an agent. And enough captured
 * CONTEXT to survive the page reloading — a marker that resolves to nothing
 * after a hot reload is worse than no marker, because the note is still on
 * screen and now points at the wrong thing.
 */

/**
 * How the user pointed at what they are annotating.
 *
 * `element` is the common case and the only one with a live DOM node behind
 * it. `region` is a dragged box over whatever is underneath — the one mode
 * that can annotate empty space, which is why it exists at all. `text` is a
 * selection inside an element, kept distinct because the exact words are the
 * subject and an agent should be told them rather than left to guess which run
 * of text in the element was meant.
 */
export type AnnotationKind = "element" | "region" | "text"

/** Where an annotation lives in its own lifecycle. */
/*
 * A note had a status — open or resolved — and it no longer does.
 *
 * Resolving was a tick beside the bin on every row, and the two were a coin
 * toss: both took the note off the list, 2px apart under identical buttons, and
 * the difference only mattered if you went looking for a resolved note later,
 * which this panel gave you no way to do. The tick went; for a while the field
 * stayed behind it as read-only machinery, set by nothing and read by four
 * places.
 *
 * It is gone now rather than kept as scenery. A field nothing writes is a
 * field the next reader has to work out the truth about — and four filters
 * keyed on a value that is always "open" is four chances to believe the editor
 * still has a concept it does not.
 *
 * The cost, stated because it is real: a note resolved in a session before this
 * change comes back as an ordinary note. That is one stale flag on old data,
 * against a permanent branch in live code.
 */

/**
 * The element an annotation points at, captured at creation time.
 *
 * Every field is a fact read from the live DOM at the moment the note was
 * written, and none of them is re-read afterwards. That is deliberate: the
 * page under the editor is a dev server that hot-reloads, and an annotation
 * whose description changed because the app re-rendered would be a note about
 * something nobody said. The live element is held separately and weakly (see
 * `AnnotationRecord.element`), for painting only.
 */
export interface AnnotationTarget {
  /** Lower-case tag, e.g. `button`. */
  tagName: string
  /** The framework component that authored it, where one can be named. */
  componentName: string | null
  /** The full `class` attribute as written, not the computed list. */
  className: string
  /** `id`, when the element has one — the most greppable handle there is. */
  id: string | null
  /** A CSS path good enough to find the element again by hand. */
  selector: string
  /** The element's own visible text, trimmed and capped. */
  text: string
  /** `file:line` when the host could resolve one. */
  filePath: string | null
  lineNumber: number | null
  /** The column, when the resolver gave one — printed as `file:line:column`. */
  columnNumber?: number | null
  /*
   * The facts below are the brief's, in Agentation's vocabulary (see
   * `identify.ts`). Optional because a note stored by an older build has none
   * of them, and the journal's lighter capture has only `name` and `path` —
   * `output.ts` falls back for every one of them.
   */
  /** `button "Save"`, `paragraph: "…"` — the heading of the item. */
  name?: string
  /** `.row > .btn` — the brief's `**Location:**`, four levels. */
  path?: string
  /** Every level from `<body>` down. Forensic only. */
  fullPath?: string
  /** Its own text and its siblings', for `**Context:**`. */
  nearbyText?: string
  /** What sits beside it, for `**Nearby Elements:**`. */
  nearbyElements?: string
  /** Role, ARIA attributes and focusability, for `**Accessibility:**`. */
  accessibility?: string
  /** Closest-first ancestry, for an agent that has to locate this in source. */
  ancestry: Array<{ tagName: string; className: string; componentName: string | null }>
  /** Computed styles worth reporting, already filtered to the interesting ones. */
  computed: Record<string, string>
  /**
   * The component stack above this element.
   *
   * React and Angular answer this question differently and both answers are
   * useful, so the shape is shared and the extraction is not. Empty when the
   * host is neither, or when the setting that gathers it is off.
   */
  components: string[]
}

/**
 * Where the marker sits, in PAGE coordinates.
 *
 * Page, not viewport, and not element-relative. Viewport coordinates are wrong
 * the moment the user scrolls. Element-relative is wrong the moment the
 * element is gone, which for a `region` note is immediately — there is no
 * element. Page coordinates are the one frame that survives both, and the
 * painter converts to viewport per frame.
 */
export interface AnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

/** One note, as stored. */
export interface AnnotationRecord {
  id: string
  kind: AnnotationKind
  /** What the user typed. The whole point of the record. */
  comment: string
  /** ISO 8601, for ordering and for the agent's sense of what came first. */
  createdAt: string
  /** The page it was made on, so notes from two routes never mix. */
  url: string
  /** Where to draw the marker, in page coordinates. */
  rect: AnnotationRect
  /** The captured description. `null` for a region over empty space. */
  target: AnnotationTarget | null
  /** The exact words, for a `text` annotation. */
  selectedText: string | null
  /**
   * The live node, for painting only, and never persisted.
   *
   * Held so the marker can follow an element that moves — a sticky header, an
   * accordion opening above it — without re-resolving anything. Dropped on
   * reload, when `rect` takes over as the only truth.
   */
  element?: Element | null
}

/**
 * One change the designer actually made, as the outbox remembers it.
 *
 * The other half of what an agent needs, and the half that used to have
 * nowhere to go. A session in this editor produces two kinds of intent: notes
 * about what is wrong, and edits that already fix part of it. Sending only the
 * notes asks the agent to redo work that is done; sending only the edits omits
 * every reason. They belong in one outbox.
 *
 * This is NOT the change-prompt ledger. That ledger holds the subset of edits
 * the writer could not express in source, because its job is to be the second
 * half of "Apply to code". This holds every edit, written or not, because its
 * job is to be the record of what the designer did — and "I moved this and it
 * worked" is as much a thing to tell an agent as "I moved this and it did not".
 */
export interface EditRecord {
  id: string
  /** ISO 8601, so notes and edits can be read back in the order they happened. */
  createdAt: string
  /**
   * The CSS property, or one of the ledger's own sentinels — `class`, `icon`,
   * `text`, `remove`. Deliberately the same vocabulary `change-prompt.ts`
   * already uses: two spellings of "what changed" in one codebase is how the
   * panel and the brief come to disagree about the same edit.
   */
  property: string
  from: string
  to: string
  /** Where it happened, captured at the time, same as an annotation's target. */
  target: AnnotationTarget | null
  /**
   * Whether it reached the source file.
   *
   * An agent reads these two cases completely differently: a written change is
   * already in the file it is about to open, and re-applying it would be a
   * conflict; an unwritten one is still only pixels and is the actual request.
   * Reporting them alike is how an agent ends up undoing the designer's work.
   */
  written: boolean
}

/**
 * The outbox, as the panel and the brief both read it.
 *
 * Notes and edits are kept in separate stores because they are produced by
 * completely different machinery — one by a pointer gesture, one by the writer
 * — and merged only at the point of being read. Merging earlier would put the
 * writer's hot path through the annotation store.
 */
export type OutboxItem =
  | { type: "note"; at: number; note: AnnotationRecord }
  | { type: "edit"; at: number; edit: EditRecord }

/** How much the copied brief says about each note. */
export type OutputDetail = "compact" | "standard" | "detailed" | "forensic"

/**
 * The settings, mirroring the ones Agentation exposes.
 *
 * Carried in the editor rather than in the app being edited, which is the
 * whole difference: Agentation ships a toolbar the host app imports, so its
 * settings belong to that app. Nothing here is imported by the host, so these
 * belong to the editor and follow the designer from project to project.
 */
export interface AnnotationSettings {
  /** How verbose the brief is. */
  outputDetail: OutputDetail
  /*
   * THERE IS NO COMPONENT-STACK SETTING HERE, and the absence is the feature.
   *
   * It was a switch, labelled "React components" or "Angular components"
   * depending on the host — and that label was the tell. The editor already
   * knows which framework it is attached to, and it already knows how to read
   * the stack on both: a fiber walk on React, `ng.getOwningComponent` on
   * Angular. Asking a designer to confirm something the tool has already
   * detected is a question with one right answer, where the wrong one silently
   * buys a thinner brief. So the stack is always gathered, and `outputDetail`
   * — which a designer does have an opinion about — decides whether the brief
   * prints it.
   */
  /**
   * Suppress every marker until the page is reloaded.
   *
   * Per TAB and never persisted, which is the point: it is "get out of my way
   * while I look at this", not a preference. A persisted version of this
   * setting is indistinguishable from the feature being broken.
   */
  hideUntilRestart: boolean
  /** Empty the list once its contents have been copied or sent. */
  clearOnCopy: boolean
  /**
   * Swallow clicks on the page while annotating.
   *
   * On by default, and the default that matters most: annotating a menu item
   * is impossible if the click that annotates it also closes the menu. Off is
   * for the case where you have to drive the app INTO the state worth
   * annotating first.
   */
  blockPageInteractions: boolean
  /**
   * WHAT a click annotates: the app under the editor, or the editor itself.
   *
   * `"app"` is every note this lane was built for, and the default.
   *
   * `"editor"` turns the lane around to face its own chrome — the panels, the
   * toolbar, the inspector rows — which is the one surface the editor cannot
   * otherwise be pointed at, because `isChrome` is what stops a pin becoming
   * the target of a pin. It is the only way to file "the layers filter is too
   * low-contrast" against the thing that draws it.
   *
   * The scope is exclusive rather than additive. Both at once would make every
   * note ambiguous about which product it is feedback ON, and a note filed
   * against the wrong one is worse than a note nobody could file.
   *
   * NOTHING IN THE UI SETS THIS ANY MORE. The switch that did lived in the
   * annotations settings fold, and it was the one control in the panel that
   * took away the gesture you would undo it with: editor scope swallows clicks
   * on the chrome in order to annotate it, the switch is chrome, so turning it
   * off meant knowing a keyboard shortcut the switch itself had to teach you.
   * `V` (inspect) and `H` (interactive) are still the way out for anyone who
   * sets this from the console, because this lane swallows pointer events and
   * never keys — but a designer annotating an app can no longer walk into the
   * mode by accident. `annotations/store.ts` forces the value back to `"app"`
   * on load for the other half of that: with no control left, a persisted
   * `"editor"` would be permanent.
   */
  scope: AnnotationScope
}

/** Which product a note is about. See `AnnotationSettings.scope`. */
export type AnnotationScope = "app" | "editor"

export const DEFAULT_SETTINGS: AnnotationSettings = {
  outputDetail: "standard",
  // The app, always, and now the only value any session starts on: no control
  // in the panel sets this, and `store.ts` forces it back on load for the same
  // reason `hideUntilRestart` is forced — a session that silently began pointed
  // at the editor's own panels would look like the annotation tool had stopped
  // seeing the page.
  scope: "app",
  hideUntilRestart: false,
  clearOnCopy: false,
  blockPageInteractions: true,
}

/** The four detail levels, in the order the setting offers them. */
export const OUTPUT_DETAILS: ReadonlyArray<{ id: OutputDetail; label: string; hint: string }> = [
  { id: "compact", label: "Compact", hint: "One line per note: what it points at and what you said" },
  { id: "standard", label: "Standard", hint: "Adds the location, source and components" },
  { id: "detailed", label: "Detailed", hint: "Adds classes, position and nearby text" },
  { id: "forensic", label: "Forensic", hint: "Adds the environment, DOM path, styles and accessibility" },
]
