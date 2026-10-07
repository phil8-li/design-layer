/**
 * Shared contracts for the Figma-style DesignLayer overlay.
 *
 * Every lane (canvas, panels, options, ai) talks through these types so the
 * modules stay disjoint: nothing imports another lane's internals.
 */

/** Source coordinates React Rewrite resolved for a DOM node. */
export interface SourceRef {
  filePath: string
  lineNumber: number
  columnNumber: number
  componentName: string
}

/**
 * What the editor can select.
 *
 * Not plain `Element`: an `<svg>` icon is a layer the user selects and the
 * inspector writes to, so the union has to be exactly the two things
 * `toSelectable` can return — both of which carry `style` and `classList`,
 * which is what every write path needs. Widening to `Element` instead would
 * make `.style` unavailable and push a cast into each of them.
 */
export type LayerElement = HTMLElement | SVGSVGElement

/** One selectable thing on the canvas. */
export interface Selection {
  element: LayerElement
  tagName: string
  componentName: string
  source: SourceRef | null
  /** Stable-ish key used by the layers panel and the options store. */
  key: string
}

/**
 * One tool, because one is what the toolbar draws.
 *
 * "select" (Scale) only ever did what Move already does, "text" mirrored a
 * vendor mode this editor cannot commit, and "comment" was gated in three
 * canvas handlers while never appearing as a control — a mode the user could
 * not reach is a branch nobody can test. "hand" went the same way: it suppressed
 * selection so the page could be scrolled, but the wheel and the trackpad scroll
 * the live page in every mode, so the only thing it added was a state in which
 * clicking did nothing — which is what the Interactive toggle now says out loud.
 *
 * A one-member union is deliberate, not a leftover. The canvas still asks
 * `tool === "move"` before it drags, and keeping the question named means the
 * next tool arrives as a new member rather than as a new flag.
 */
export type ToolId = "move"

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/*
 * A `ClassEdit` was declared here — `{ remove: string[]; add: string[] }`, the
 * shape of one className mutation. Nothing ever imported it: the writer's own
 * `ClassWrite` (`core/writer.ts`) is what `applyClasses` takes and what every
 * caller builds, so this was a second name for one idea and the one that lost.
 */

/** Inline style mutation, applied live and mirrored into source on commit. */
export interface StyleEdit {
  [cssProperty: string]: string
}

/** One saved variation of an element's styling. */
export interface ElementOption {
  id: string
  name: string
  /** Full className string for this option. */
  className: string
  /** Inline styles captured with the option. */
  style: StyleEdit
  /** Text content, when the option also changes copy. */
  text?: string
  createdAt: number
  /**
   * Which Design-tab section owns this saved style. Unset on legacy
   * whole-element options, which every section offers through its own slice.
   */
  scope?: StyleScope
}

/**
 * Declared here rather than in `options/scopes.ts` so this file stays pure
 * types; `scopes.ts` re-exports it next to the logic that uses it.
 */
export type StyleScope = "typography" | "fill" | "stroke" | "effects" | "appearance" | "layout"

export interface ElementOptionSet {
  /** Element key (see `Selection.key`). */
  key: string
  label: string
  activeOptionId: string | null
  options: ElementOption[]
}

/** Layers-panel node projected from the React fiber tree. */
export interface LayerNode {
  id: string
  element: LayerElement
  name: string
  tagName: string
  isComponent: boolean
  depth: number
  children: LayerNode[]
}

/**
 * What the editor hands its coding agent.
 *
 * One surface builds this — the outbox tab's handover button — so `selection`
 * and `ancestry` are always empty in practice and the substance is in `brief`.
 * They stay on the type because the queue entry an agent reads still has those
 * fields, and `/agent` is a plain POST that must describe an element when a
 * caller names one.
 */
export interface AgentRequest {
  prompt: string
  selection: {
    tagName: string
    componentName: string
    className: string
    text: string
    rect: Rect
    source: SourceRef | null
  } | null
  /** Sibling/parent context so the agent can locate the node in source. */
  ancestry: Array<{ tagName: string; className: string; componentName: string }>
  url: string
  /**
   * Which surface sent this, and the only one there is.
   *
   * It says the request is a finished ledger of work rather than a question:
   * the intent is already written in `brief`, so an agent should act on it, not
   * ask the designer what they meant. There was a second value, `"ask-ai"`, for
   * a free-text box in the Design tab that sent one element — that panel is
   * gone, and a request arriving without this field is recorded as `unknown`
   * rather than being assumed to be either.
   */
  origin?: "prompts"
  /**
   * The markdown the outbox tab's Copy button writes, verbatim.
   *
   * Sent rather than rebuilt server-side so the two handoff paths cannot
   * diverge: what the designer reads in the Brief region is exactly what the
   * agent receives, and the clipboard stays a true fallback rather than a
   * second, slightly different format.
   */
  brief?: string
  /** Distinct source files the brief touches, for the agent's first read. */
  files?: string[]
}

export interface AgentResponse {
  ok: boolean
  /** Human-readable result shown in the AI panel. */
  message: string
  /** Where the request was handed off, when no API key is configured. */
  handoffPath?: string
  /** Files the agent edited, when it applied changes directly. */
  filesChanged?: string[]
  /** The queue id an attached coding agent sees, when one was created. */
  changeId?: string | null
}
