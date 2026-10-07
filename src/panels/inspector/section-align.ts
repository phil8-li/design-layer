/**
 * Align — flex alignment on the parent, not geometry on the child.
 *
 * The obvious implementation nudges the selected box with `transform:
 * translate()`. That is wrong twice over here: `core/tailwind.ts` has no entry
 * for `transform`, so every one of those edits is silently dropped at "Apply to
 * code"; and a `translate-*` utility on an element that also uses Motion
 * `layout`/`layoutId` fights Motion's own transform and breaks the app's
 * shared-element morphs. Writing `justify-content`/`align-items` on the parent
 * says the same thing in a way that survives the trip to source.
 *
 * What is left here is that write path and the parent it writes to. The buttons
 * moved into `section-position.ts`, where align, distribute and arrange are
 * drawn as one captioned section — two joined triples now rather than one loose
 * strip — but the reasoning above is the reason those buttons work the way they
 * do, and it is what keeps them writing on the parent however they are drawn,
 * so it stays with the code it justifies.
 *
 * ## Aligning SEVERAL selected elements to each other
 *
 * Figma's align acts on the selection: pick five boxes, press "Align top", and
 * those five line up whether or not anything else in the frame does. Ours could
 * not, because the inspector only ever read the primary selection — five picked
 * boxes wrote `align-items` on their shared parent, which moves every sibling
 * too and says nothing about the five. `multiAlignment` below is the selection
 * verb, and it splits by axis, because only one of the two axes has a per-child
 * property to write.
 *
 * On the CROSS axis — "Align top" in a row — each child may sit where it likes,
 * and `align-self` is exactly the per-child override for it. So that one is
 * written on every selected element, one declaration each, and it survives the
 * trip to source as a `self-*` utility (`core/tailwind.ts` carries the entry,
 * and its comment says it exists for this).
 *
 * On the MAIN axis — "Align left" in a row — there is no per-child equivalent:
 * children are packed along it as a run, and where the run starts is the
 * parent's `justify-content`. That is not a gap in CSS to be worked around, it
 * is what a flex row IS, so the main axis stays the single parent write it
 * already was. For a selection that covers the whole row the two answers
 * coincide, which is the case a user is in when they press it.
 *
 * ### Margin was the other candidate, and it is a trap
 *
 * `margin-left`/`margin-top` ARE expressible — `core/tailwind.ts` carries
 * `margin` and all four sides — so the idea survives the test that killed
 * `transform`, and it is the only thing that would let the main axis place a
 * child individually. It fails a later one, twice.
 *
 * A flex run has no slack in it: adding `margin-left: 40px` to the second of
 * three children does not move that child 40px, it moves that child AND
 * everything after it, so placing one element means simultaneously solving for
 * the margins of all its later siblings. That solve is against the geometry of
 * one particular render — the widths the boxes happen to have at this viewport,
 * with this content — so the moment the app re-renders with a longer label or a
 * narrower window, the numbers are wrong and the row is visibly crooked in a
 * way nobody edited it to be.
 *
 * And the number reaches source. `ml-10` in the JSX is a layout constant with
 * no reason attached, sitting in a file where the next person to widen the
 * container has no way to know it was the output of a one-off alignment solve
 * rather than a deliberate piece of spacing. `align-self` writes an intention —
 * "this one sits at the top" — which stays true at every width. The rule this
 * file has followed since the `transform` decision is that an edit must mean
 * the same thing tomorrow as it did when it was made, and a solved margin does
 * not.
 */

import { toSourceRef } from "../../core/bridge"
import { elementKey } from "../../core/store"
import type { EditorContext } from "../../core/context"
import type { Selection } from "../../core/types"
import type { SectionContext } from "./index"

export type Place = "flex-start" | "center" | "flex-end"
export type Axis = "horizontal" | "vertical"
export type AlignProperty = "justify-content" | "align-items"

/** Computed `justify-content`/`align-items` collapsed onto the three we write. */
function placeOf(value: string): Place | null {
  if (value === "center") return "center"
  if (value === "flex-end" || value === "end" || value === "right") return "flex-end"
  if (value === "flex-start" || value === "start" || value === "left" || value === "normal") return "flex-start"
  return null
}

/**
 * The parent as a writable target. `context.describe` is private to the context
 * module, so this rebuilds the same shape from the two core helpers it uses.
 */
function describeParent(editor: EditorContext, parent: HTMLElement): Selection {
  const info = editor.bridge.elementInfo(parent)
  const componentName = info?.componentName || parent.tagName.toLowerCase()
  return {
    element: parent,
    tagName: parent.tagName.toLowerCase(),
    componentName,
    source: toSourceRef(info),
    key: elementKey(parent, componentName, info?.lineNumber ?? 0),
  }
}

export interface ParentAlignment {
  /** The parent, in the shape the writer addresses a selection by. */
  target: Selection
  isFlex: boolean
  column: boolean
  /** True when the parent's main axis is already spread. */
  distributed: boolean
  /** Horizontal on a row is `justify-content`; on a column it is `align-items`. */
  propertyFor(axis: Axis): AlignProperty
  /** What the parent's computed style says that axis is set to today. */
  currentFor(axis: Axis): Place | null
  write(property: string, value: string, summary: string): void
}

/**
 * The parent's alignment state, or null when there is no parent worth writing
 * to. `<body>` and `<html>` are the app's frame rather than a layout the user
 * authored, so laying the selection out inside one is not an offer we make.
 */
export function parentAlignment({ editor, selection, writer }: SectionContext): ParentAlignment | null {
  const parent = selection.element.parentElement
  if (!parent || parent === document.body || parent === document.documentElement) return null

  const target = describeParent(editor, parent)
  const style = getComputedStyle(parent)
  const column = style.flexDirection.startsWith("column")
  const justify = placeOf(style.justifyContent)
  const align = placeOf(style.alignItems)
  const propertyFor = (axis: Axis): AlignProperty =>
    (axis === "horizontal") === column ? "align-items" : "justify-content"

  return {
    target,
    isFlex: style.display === "flex" || style.display === "inline-flex",
    column,
    distributed: style.justifyContent === "space-between",
    propertyFor,
    currentFor: (axis) => (propertyFor(axis) === "justify-content" ? justify : align),
    write: (property, value, summary) => writer.applyStyles(target, [{ property, value }], summary),
  }
}

export interface MultiAlignment {
  /** How many elements the strip would place. Always more than one. */
  count: number
  /**
   * The parent they share, or null when they do not share one.
   *
   * Null is a refusal rather than a fallback. Flex placement is a conversation
   * between one container and its own children, so there is no write that
   * lines up a box in one card with a box in another — the honest answer is to
   * say so, which `section-position.ts` draws as a hint.
   */
  target: Selection | null
  isFlex: boolean
  column: boolean
  /** True when this axis is the parent's main axis, i.e. the packed one. */
  isMain(axis: Axis): boolean
  /** Whether every selected element already sits at `place` on the cross axis. */
  crossIsAt(place: Place): boolean
  /** What the parent's main axis is set to today — the shared half of the strip. */
  mainIs(): Place | null
  /** Cross axis: `align-self` on every selected element, as ONE history step. */
  alignSelf(place: Place, summary: string): void
  /** Main axis: the same single write on the parent the one-element strip makes. */
  write(property: string, value: string, summary: string): void
  /** Turns the shared parent into a flex container, the way in from `not flex`. */
  makeFlex(): void
}

/**
 * The selection's alignment state, or null when there is nothing to align.
 *
 * Null covers three different "no": one element selected, which is the
 * single-selection strip's job and not this one's; a selection whose shared
 * parent is `<body>` or `<html>`, refused here for the reason
 * `parentAlignment` refuses it; and a writer that cannot batch, which is how a
 * hand-built context in a section suite arrives. That last one is a real guard
 * and not defensive noise — the strip's whole contract is that pressing it
 * costs one undo, and a fallback that silently looped `applyStyles` would give
 * five, which is precisely the bug this function exists to remove.
 */
export function multiAlignment({ editor, selections, writer }: SectionContext): MultiAlignment | null {
  const picked = selections ?? []
  if (picked.length < 2) return null
  if (typeof writer.applyStylesBatch !== "function") return null

  const parents = new Set(picked.map((entry) => entry.element.parentElement))
  const parent = parents.size === 1 ? picked[0].element.parentElement : null
  if (parent === document.body || parent === document.documentElement) return null

  // Scattered across containers: everything below needs a parent to read a
  // direction off, so the object is built with just enough to explain itself.
  if (!parent) {
    return {
      count: picked.length,
      target: null,
      isFlex: false,
      column: false,
      isMain: () => false,
      crossIsAt: () => false,
      mainIs: () => null,
      alignSelf: () => {},
      write: () => {},
      makeFlex: () => {},
    }
  }

  const target = describeParent(editor, parent)
  const style = getComputedStyle(parent)
  const column = style.flexDirection.startsWith("column")
  const justify = placeOf(style.justifyContent)
  const write = (property: string, value: string, summary: string) =>
    writer.applyStyles(target, [{ property, value }], summary)

  return {
    count: picked.length,
    target,
    isFlex: style.display === "flex" || style.display === "inline-flex",
    column,
    // The main axis is the one the parent packs along: horizontal in a row,
    // vertical in a column. Same fork `propertyFor` makes, said the other way
    // round, because here the question is which WRITE to make rather than
    // which property to name.
    isMain: (axis) => (axis === "horizontal") !== column,
    /*
     * Pressed only when they ALL sit there. A strip that lit up because the
     * first of five happened to be centred would be reporting the primary
     * selection again, which is the whole failure this control exists to fix;
     * a mixed set is honestly no state at all.
     *
     * Read off the computed value, so an element that has never been touched
     * answers with whatever it inherits from the parent's `align-items` — the
     * same reason the single-selection strip shows "top" on an untouched row.
     */
    crossIsAt: (place) =>
      picked.every((entry) => placeOf(getComputedStyle(entry.element).alignSelf) === place),
    mainIs: () => justify,
    alignSelf: (place, summary) => {
      writer.applyStylesBatch(
        picked.map((entry) => ({
          selection: entry,
          writes: [{ property: "align-self", value: place }],
        })),
        summary
      )
    },
    write,
    makeFlex: () => write("display", "flex", "Auto layout on parent"),
  }
}
