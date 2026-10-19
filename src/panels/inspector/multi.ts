/**
 * Figma's mixed editing for a multi-selection.
 *
 * Two halves. `fanOutWriter` turns a section's write for the primary into one
 * batch over everything selected, so the sections keep writing to
 * `context.selection` and still reach every layer with one undo step and one
 * outbox entry per element. `sharedValue` answers the read side: the value
 * every selected layer agrees on, or null, which a field draws as "Mixed".
 *
 * The section suites build `SectionContext` by hand without `selections`, so
 * every helper here treats an absent list as "just the primary".
 */

import { el } from "../../core/dom"
import { styledSection } from "../../options/panel"
import type { StyleScope } from "../../options/scopes"
import type { Selection } from "../../core/types"
import type { ClassWrite, StyleWrite, Writer } from "../../core/writer"
import { propRow } from "./field"
import type { SectionContext } from "./index"

/** Figma's placeholder for a field whose layers disagree. */
export const MIXED = "Mixed"

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
 * own undo step until it does.
 */
export function fanOutWriter(writer: Writer, selections: Selection[]): Writer {
  if (selections.length < 2 || typeof writer.applyStylesBatch !== "function") return writer
  const primary = selections[0]
  const isPrimary = (selection: Selection) => selection === primary || selection.element === primary.element
  const batchClasses = (writer as { applyClassesBatch?: unknown }).applyClassesBatch
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
      if (typeof batchClasses === "function") {
        batchClasses.call(
          writer,
          selections.map((entry) => ({ selection: entry, write })),
          summary
        )
        return
      }
      for (const entry of selections) writer.applyClasses(entry, write, summary)
    },
  }
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
