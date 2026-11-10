/**
 * Figma's mixed editing for a multi-selection.
 *
 * Two halves. `fanOutWriter` turns a section's write for the primary into one
 * batch over everything selected, so the sections keep writing to
 * `context.selection` and still reach every layer with one undo step and one
 * outbox entry per element. `sharedValue` answers the read side: the value
 * every selected layer agrees on, or null, which a field draws as "Mixed".
 *
 * `sectionWriters` is the write side a section actually calls: `apply` and
 * `commit` go through the (fanned-out) writer, and `preview` draws on every
 * selected layer, so a scrub on a multi-selection shows what its commit will
 * write rather than moving the primary alone.
 *
 * The section suites build `SectionContext` by hand without `selections`, so
 * every helper here treats an absent list as "just the primary".
 */

import { toSourceRef } from "../../core/bridge"
import { el, round } from "../../core/dom"
import { elementKey } from "../../core/store"
import type { EditorContext } from "../../core/context"
import { styledSection } from "../../options/panel"
import type { StyleScope } from "../../options/scopes"
import type { LayerElement, Selection } from "../../core/types"
import type { ClassWrite, StyleWrite, Writer } from "../../core/writer"
import { propRow } from "./field"
import type { SectionContext } from "./index"

/** Figma's placeholder for a field whose layers disagree. */
export const MIXED = "Mixed"

/**
 * An element as the writer addresses it, for one that is not itself selected:
 * the parent an align writes to, an icon button's `<svg>`, a child whose
 * colour Selection colors rewrites. The same record `core/context.ts` builds
 * for a selection, whose own `describe` is private to it.
 */
export function selectionFor(editor: Pick<EditorContext, "bridge">, element: LayerElement): Selection {
  // Optional: the section suites hand over an editor without a bridge.
  const info = editor.bridge?.elementInfo(element) ?? null
  const componentName = info?.componentName || element.tagName.toLowerCase()
  return {
    element,
    tagName: element.tagName.toLowerCase(),
    componentName,
    source: toSourceRef(info),
    key: elementKey(element, componentName, info?.lineNumber ?? 0),
  }
}

/** Everything selected, primary first, never empty. */
export function selectedOf(context: Pick<SectionContext, "selection" | "selections">): Selection[] {
  const picked = context.selections ?? []
  return picked.length > 1 ? picked : [context.selection]
}

export function isMulti(context: Pick<SectionContext, "selection" | "selections">): boolean {
  return selectedOf(context).length > 1
}

/**
 * The computed style of one selected layer. The primary's comes from the
 * context, which a suite may have overridden, so the primary reads the same
 * values whether it is alone or one of several.
 */
export function computedOf(context: SectionContext, selection: Selection): CSSStyleDeclaration {
  return selection === context.selection ? context.computed : getComputedStyle(selection.element)
}

/**
 * The value `read` returns for every selected layer, or null when two differ.
 *
 * `Object.is` rather than `===`, so two `NaN` reads (a `normal` line height on
 * both) agree. Callers round numbers before returning them: sub-pixel noise in
 * a measured width is not a difference a designer can see.
 */
export function sharedValue<T>(
  context: SectionContext,
  read: (computed: CSSStyleDeclaration, selection: Selection) => T
): T | null {
  const [first, ...rest] = selectedOf(context)
  const value = read(computedOf(context, first), first)
  for (const entry of rest) {
    if (!Object.is(read(computedOf(context, entry), entry), value)) return null
  }
  return value
}

/**
 * One layer's four sides or corners as one number, rounded, or NaN when they
 * differ — so a layer whose own sides disagree reads "Mixed" in a uniform field
 * just as two layers that disagree do.
 */
export function uniformOf(values: number[]): number {
  return values.every((value) => value === values[0]) ? round(values[0]) : NaN
}

/** Field options for a number that may be mixed: the value, or empty with "Mixed". */
export function mixedNumber(value: number | null): { value: number | null; placeholder?: string } {
  return value === null ? { value: null, placeholder: MIXED } : { value }
}

/**
 * A writer whose writes for the primary reach every selected layer as one edit.
 *
 * A write aimed at anything else (the parent an align button moves, the icon
 * inside a button) passes through untouched, and so does `applyStylesBatch`,
 * which sections that already act on the set (Position, Selection colors)
 * call themselves; wrapping those would apply each edit once per layer.
 *
 * Class writes loop, because the writer has no class batch: each layer is its
 * own undo step until `core/writer.ts` grows one.
 */
export function fanOutWriter(writer: Writer, selections: Selection[]): Writer {
  if (selections.length < 2 || typeof writer.applyStylesBatch !== "function") return writer
  const primary = selections[0]
  const isPrimary = (selection: Selection) => selection === primary || selection.element === primary.element
  return {
    ...writer,
    applyStyles(selection: Selection, writes: StyleWrite[], summary: string) {
      if (!isPrimary(selection)) return writer.applyStyles(selection, writes, summary)
      writer.applyStylesBatch(
        selections.map((entry) => ({ selection: entry, writes })),
        summary
      )
    },
    applyClasses(selection: Selection, write: ClassWrite, summary: string) {
      if (!isPrimary(selection)) return writer.applyClasses(selection, write, summary)
      for (const entry of selections) writer.applyClasses(entry, write, summary)
    },
  }
}

/** A section's writes: what reaches the notes, and what only draws during a scrub. */
interface SectionWriters {
  /** One edit on the selection (every layer, through `fanOutWriter`). The panel repaints when `follow.ts` sees it. */
  apply(writes: StyleWrite[], summary: string): void
  /** `apply`, then repaint the panel now: for a control whose own look depends on the value. */
  commit(writes: StyleWrite[], summary: string): void
  /** Draws the writes inline on every selected layer, with no note; a scrub rewinds them. */
  preview(writes: StyleWrite[]): void
}

/**
 * The one set of write helpers every multi-capable section uses.
 *
 * Previews used to be written per section onto `selection.element`, so a
 * scrub on three layers moved one and the pointerup then wrote all three.
 * Rotation was the one section that previewed the set; now every section that
 * commits to the set previews the set.
 */
export function sectionWriters(context: SectionContext): SectionWriters {
  const { selection, writer, invalidate } = context
  const apply = (writes: StyleWrite[], summary: string): void => writer.applyStyles(selection, writes, summary)
  return {
    apply,
    commit: (writes, summary) => {
      apply(writes, summary)
      invalidate()
    },
    preview: (writes) => {
      for (const entry of selectedOf(context)) {
        for (const write of writes) entry.element.style.setProperty(write.property, write.value)
      }
    },
  }
}

/**
 * One edit whose writes differ per layer — Show stroke restoring each layer's
 * own widths — as one undo step when the writer can batch.
 */
export function writeEach(
  context: SectionContext,
  summary: string,
  writesFor: (selection: Selection) => StyleWrite[]
): void {
  const { writer } = context
  const picked = selectedOf(context)
  if (picked.length < 2) return writer.applyStyles(context.selection, writesFor(context.selection), summary)
  if (typeof writer.applyStylesBatch !== "function") {
    for (const entry of picked) writer.applyStyles(entry, writesFor(entry), summary)
    return
  }
  writer.applyStylesBatch(
    picked.map((entry) => ({ selection: entry, writes: writesFor(entry) })),
    summary
  )
}

/**
 * Figma's body for a paint section whose layers paint differently: one quiet
 * line, and the header's `+` replaces every layer's paints with one.
 */
export function mixedPaintSection(
  context: SectionContext,
  scope: StyleScope,
  title: string,
  add: HTMLElement
): HTMLElement {
  const hint = el("div", { class: "de-hint", "data-de-mixed": scope }, ["Click + to replace mixed content"])
  return styledSection(context, scope, title, el("div", { class: "de-stack" }, [propRow({ cells: [hint] })]), add)
}
