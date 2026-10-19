/**
 * Position — Figma's rows, in Figma's order: Alignment, Position, Rotation,
 * then our own Arrange.
 *
 * Every row is a `propRow`, so the align triples, the X/Y readouts, the angle
 * field and the flip triple stand on the same `1fr 1fr 24px` grid as the rest
 * of the panel, and distribute lands in the action column the other sections'
 * toggles use.
 *
 * Alignment writes on the parent as flex placement (`section-align.ts` has the
 * reasoning for why not `transform`). Arrange is the element's order among its
 * JSX siblings, which is what "front" and "back" mean in a document flow — see
 * `core/arrange.ts`. It stays in the panel because the canvas context menu does
 * not offer it; the keyboard does (⌘] / ⌘[).
 *
 * X and Y are a READOUT, not fields. They come from the viewport box, which is
 * an outcome of layout rather than an input to it: there is no property to
 * write them back to on a statically positioned element. W and H moved to the
 * Layout section, which owns the box's sizing, as Figma's Dimensions row does.
 *
 * Rotation and flips write the CSS `rotate` and `scale` properties rather than
 * `transform`, so they never fight a transform the app or a drag already set.
 */

import { el, round } from "../../core/dom"
import { icon, type IconName } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { TIP_ATTR, TIP_WRAP_ATTR } from "../../core/tooltip"
import type { Selection } from "../../core/types"
import {
  arrange,
  arrangeRef,
  canArrange,
  siblingLines,
  type ArrangeMove,
  type ArrangeRef,
} from "../../core/arrange"
import { actionGroup, iconButton, numberField, propRow, section, trailingToggle } from "./field"
import {
  multiAlignment,
  parentAlignment,
  type Axis,
  type MultiAlignment,
  type ParentAlignment,
  type Place,
} from "./section-align"
import type { InspectorSection, SectionContext } from "./index"

/** One size for every mark in the section, the `action` rung the toolbar uses. */
const GLYPH = tokens.icon.action

const mark = (glyph: IconName) => icon(glyph, GLYPH)

interface AlignButton {
  axis: Axis
  place: Place
  label: string
  glyph: IconName
}

/*
 * The glyph names run the other way round from the axis they serve — aligning
 * to the LEFT is a rule drawn vertically — so the pairing is spelled out once.
 */
const ALIGN_BUTTONS: AlignButton[] = [
  { axis: "horizontal", place: "flex-start", label: "Align left", glyph: "AlignStartVertical" },
  { axis: "horizontal", place: "center", label: "Align horizontal centers", glyph: "AlignCenterVertical" },
  { axis: "horizontal", place: "flex-end", label: "Align right", glyph: "AlignEndVertical" },
  { axis: "vertical", place: "flex-start", label: "Align top", glyph: "AlignStartHorizontal" },
  { axis: "vertical", place: "center", label: "Align vertical centers", glyph: "AlignCenterHorizontal" },
  { axis: "vertical", place: "flex-end", label: "Align bottom", glyph: "AlignEndHorizontal" },
]

const AXIS_TRACKS: Array<{ axis: Axis; label: string }> = [
  { axis: "horizontal", label: "Align horizontally" },
  { axis: "vertical", label: "Align vertically" },
]

const ARRANGE_BUTTONS: Array<{ move: ArrangeMove; label: string; glyph: IconName }> = [
  { move: "front", label: "Bring to front", glyph: "ArrangeFront" },
  { move: "forward", label: "Bring forward", glyph: "ArrangeForward" },
  { move: "backward", label: "Send backward", glyph: "ArrangeBackward" },
  { move: "back", label: "Send to back", glyph: "ArrangeBack" },
]

/**
 * Puts a sentence that used to sit under a row into the control's tooltip and
 * accessible description. The tip keeps the button's name first, so hovering
 * still says what the button is before it says what it acts on.
 */
function describe(node: HTMLElement, name: string, detail: string): void {
  node.setAttribute(TIP_ATTR, `${name}. ${detail}`)
  node.setAttribute(TIP_WRAP_ATTR, "")
  node.setAttribute("aria-description", detail)
}

/**
 * The six marks as two joined triples on one row.
 *
 * The row itself is the `role="toolbar"`, so its accessible name finds all six
 * whether one element is selected ("Align") or several ("Align selection").
 * Ours keep a pressed state where Figma's have none: they write
 * `justify-content`/`align-items`, a setting that stays set.
 */
function alignRow(options: {
  name: string
  detail: string
  pressed(button: AlignButton): boolean
  press(button: AlignButton): void
  trailing?: HTMLElement | null
}): HTMLElement {
  const tracks = AXIS_TRACKS.map(({ axis, label }) => {
    const track = actionGroup({
      label,
      buttons: ALIGN_BUTTONS.filter((entry) => entry.axis === axis).map((entry) => ({
        label: entry.label,
        glyph: mark(entry.glyph),
        pressed: options.pressed(entry),
        onClick: () => options.press(entry),
      })),
    })
    for (const button of track.querySelectorAll<HTMLElement>("button")) {
      describe(button, button.getAttribute("aria-label") ?? "", options.detail)
    }
    return track
  })
  const row = propRow({ caption: "Alignment", cells: tracks, trailing: options.trailing, id: "position.align" })
  row.setAttribute("role", "toolbar")
  row.setAttribute("aria-label", options.name)
  row.setAttribute("aria-description", options.detail)
  return row
}

/**
 * The Alignment row when there is no flex parent. Figma always draws the six
 * align buttons, so they stay in place, disabled, with the reason as their
 * tooltip; the way in is the action column's button.
 */
function makeFlexRow(tagName: string, onClick: () => void): HTMLElement {
  const reason = `<${tagName}> is not a flex container, so alignment has nothing to act on.`
  const tracks = AXIS_TRACKS.map(({ axis, label }) => {
    const track = actionGroup({
      label,
      buttons: ALIGN_BUTTONS.filter((entry) => entry.axis === axis).map((entry) => ({
        label: entry.label,
        glyph: mark(entry.glyph),
        disabled: true,
        onClick: () => {},
      })),
    })
    for (const button of track.querySelectorAll<HTMLElement>("button")) {
      describe(button, button.getAttribute("aria-label") ?? "", reason)
    }
    return track
  })
  const button = iconButton({ label: "Make parent auto layout", glyph: mark("AutoLayout"), onClick })
  button.classList.add("de-prow-toggle")
  describe(button, "Make parent auto layout", reason)
  return propRow({ caption: "Alignment", cells: tracks, trailing: button, id: "position.align" })
}

/**
 * Distribute, as the alignment row's trailing action for a multi-selection —
 * where Figma puts its tidy button. One control, not two: `space-between` only
 * exists on the main axis, so a row and a column differ only in the mark.
 */
function distributeToggle(alignment: ParentAlignment, invalidate: () => void): HTMLElement {
  const label = alignment.column ? "Distribute vertically" : "Distribute horizontally"
  return trailingToggle({
    label,
    glyph: mark(alignment.column ? "SpaceBetweenVertical" : "SpaceBetweenHorizontal"),
    pressed: alignment.distributed,
    onClick: () => {
      alignment.write("justify-content", "space-between", label)
      invalidate()
    },
  })
}

function singleAlignRow(alignment: ParentAlignment, invalidate: () => void): HTMLElement {
  if (!alignment.isFlex) {
    return makeFlexRow(alignment.target.tagName, () => {
      alignment.write("display", "flex", "Auto layout on parent")
      invalidate()
    })
  }
  return alignRow({
    name: "Align",
    detail: `Aligns all children of <${alignment.target.tagName}>.`,
    pressed: ({ axis, place }) => alignment.currentFor(axis) === place,
    press: ({ axis, place, label }) => {
      alignment.write(alignment.propertyFor(axis), place, label)
      invalidate()
    },
  })
}

/**
 * The multi-selection row: the same six marks, aligning the selection rather
 * than the parent's children. The cross axis writes `align-self` on every
 * selected element as one step; the main axis writes `justify-content` once on
 * the parent, because a flex run has no per-child position along its main axis.
 */
function multiAlignRow(
  multi: MultiAlignment,
  alignment: ParentAlignment | null,
  invalidate: () => void
): HTMLElement {
  if (!multi.target) {
    return propRow({
      caption: "Alignment",
      cells: [el("div", { class: "de-hint" }, ["Only elements with the same parent can be aligned together."])],
      id: "position.align",
    })
  }
  if (!multi.isFlex) {
    return makeFlexRow(multi.target.tagName, () => {
      multi.makeFlex()
      invalidate()
    })
  }
  // Which triple places elements one by one, in the terms the user sees: on a
  // row it is the vertical triple, on a column the horizontal one.
  const perElement = multi.column ? "Left, center and right" : "Top, middle and bottom"
  const wholeSet = multi.column ? "top, middle and bottom" : "left, center and right"
  return alignRow({
    name: "Align selection",
    detail: `${perElement} align each element; ${wholeSet} move the group.`,
    pressed: ({ axis, place }) => (multi.isMain(axis) ? multi.mainIs() === place : multi.crossIsAt(place)),
    press: ({ axis, place, label }) => {
      if (multi.isMain(axis)) multi.write("justify-content", place, label)
      else multi.alignSelf(place, `${label} (${multi.count} selected)`)
      invalidate()
    },
    trailing: alignment?.isFlex ? distributeToggle(alignment, invalidate) : null,
  })
}

/* ---------- position ---------- */

function readout(label: string, value: string): HTMLElement {
  return el("div", { class: "de-field" }, [
    // The shared label is a scrub handle (`cursor: ew-resize`), which would
    // promise a drag a readout cannot honor.
    el("span", { class: "de-field-label", style: "cursor:default", title: label }, [label]),
    el("span", { class: "de-field-value" }, [value]),
  ])
}

/** One number for the whole selection, or "Mixed" when they differ. */
function shared(values: number[]): string {
  const rounded = values.map((value) => round(value, 0))
  return rounded.every((value) => value === rounded[0]) ? String(rounded[0]) : "Mixed"
}

function positionRow(picked: Selection[]): HTMLElement {
  const boxes = picked.map((entry) => entry.element.getBoundingClientRect())
  return propRow({
    caption: "Position",
    cells: [readout("X", shared(boxes.map((box) => box.x))), readout("Y", shared(boxes.map((box) => box.y)))],
    id: "position.xy",
  })
}

/* ---------- rotation ---------- */

const UNIT_TO_DEG: Record<string, number> = { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 }

/** An angle token (`45deg`, `0.25turn`) in degrees, or 0 when it is not one. */
function degrees(token: string): number {
  const match = /^(-?[\d.]+(?:e-?\d+)?)(deg|turn|rad|grad)?$/.exec(token)
  if (!match) return 0
  return Number.parseFloat(match[1]) * (UNIT_TO_DEG[match[2] ?? "deg"] ?? 1)
}

/** Keeps an angle in (-180, 180], the range Figma's field shows. */
function normalize(angle: number): number {
  const turned = ((angle % 360) + 360) % 360
  return round(turned > 180 ? turned - 360 : turned, 2)
}

const read = (style: CSSStyleDeclaration, property: string): string =>
  (style.getPropertyValue?.(property) ?? "").trim()

/**
 * The element's rotation, split into what `rotate` says and what a computed
 * `transform` matrix adds. The field shows the sum, and a commit writes only
 * the `rotate` share, so typing 0 levels an element a transform had tilted.
 */
function rotationOf(style: CSSStyleDeclaration): { own: number; fromTransform: number } {
  const rotate = read(style, "rotate")
  // `rotate` may carry an axis first (`z 45deg`, `0 0 1 45deg`); the angle is last.
  const own = !rotate || rotate === "none" ? 0 : degrees(rotate.split(/\s+/).pop() ?? "")
  const matrix = /^matrix\(([^)]+)\)$/.exec(read(style, "transform"))
  let fromTransform = 0
  if (matrix) {
    const [a, b] = matrix[1].split(",").map((part) => Number.parseFloat(part))
    fromTransform = (Math.atan2(b, a) * 180) / Math.PI
  }
  return { own, fromTransform }
}

/** The two `scale` factors; one value means both axes, `none` means 1 1. */
function scaleOf(style: CSSStyleDeclaration): [number, number] {
  const scale = read(style, "scale")
  if (!scale || scale === "none") return [1, 1]
  const [x, y = x] = scale.split(/\s+/).map((part) => Number.parseFloat(part))
  return [Number.isFinite(x) ? x : 1, Number.isFinite(y) ? y : 1]
}

const serializeScale = ([x, y]: [number, number]): string => (x === 1 && y === 1 ? "none" : `${x} ${y}`)

function rotationRow(context: SectionContext, picked: Selection[]): HTMLElement {
  const { computed, writer, invalidate } = context
  const styleOf = (entry: Selection) =>
    entry === context.selection ? computed : getComputedStyle(entry.element)
  const states = picked.map((entry) => {
    const style = styleOf(entry)
    return { entry, rotation: rotationOf(style), scale: scaleOf(style) }
  })
  const angles = states.map(({ rotation }) => normalize(rotation.own + rotation.fromTransform))
  const mixed = angles.some((angle) => angle !== angles[0])

  // One step for the whole selection when the writer can batch, the same
  // contract the multi-selection align row keeps; one element is one write.
  const apply = (writes: Array<{ entry: Selection; property: string; value: string }>, summary: string) => {
    if (writes.length === 1 || typeof writer.applyStylesBatch !== "function") {
      for (const write of writes) {
        writer.applyStyles(write.entry, [{ property: write.property, value: write.value }], summary)
      }
    } else {
      writer.applyStylesBatch(
        writes.map((write) => ({ selection: write.entry, writes: [{ property: write.property, value: write.value }] })),
        summary
      )
    }
    invalidate()
  }
  const rotateTo = (angleFor: (index: number) => number, summary: string) =>
    apply(
      states.map((state, index) => ({
        entry: state.entry,
        property: "rotate",
        value: `${normalize(angleFor(index) - state.rotation.fromTransform)}deg`,
      })),
      summary
    )

  const field = numberField({
    id: "position.rotation",
    label: icon("Rotation", GLYPH),
    title: "Rotation",
    value: mixed ? null : angles[0],
    placeholder: "Mixed",
    suffix: "°",
    onPreview: (value) => {
      for (const state of states) {
        state.entry.element.style.setProperty("rotate", `${normalize(value - state.rotation.fromTransform)}deg`)
      }
    },
    onCommit: (value) => rotateTo(() => value, "Rotate"),
  })
  field.classList.add("de-pos-angle")
  // The degree sign fills the well past the digits, so a click there edits.
  field.querySelector(".de-field-suffix")?.addEventListener("pointerdown", (event) => {
    event.preventDefault()
    field.querySelector("input")?.focus()
  })

  // A flip holds a state, like the align marks: pressed while every selected
  // element is mirrored on that axis, and pressing it again mirrors it back.
  const flip = (axis: 0 | 1, label: string) => {
    const flipped = states.every(({ scale }) => scale[axis] < 0)
    return {
      label,
      glyph: mark(axis === 0 ? "FlipHorizontal" : "FlipVertical"),
      pressed: flipped,
      onClick: () =>
        apply(
          states.map(({ entry, scale }) => {
            const next: [number, number] = [scale[0], scale[1]]
            next[axis] = flipped ? Math.abs(scale[axis]) : -Math.abs(scale[axis])
            return { entry, property: "scale", value: serializeScale(next) }
          }),
          label
        ),
    }
  }

  const transforms = actionGroup({
    label: "Rotate and flip",
    buttons: [
      {
        label: "Rotate 90° right",
        glyph: mark("Rotate90"),
        onClick: () => rotateTo((index) => angles[index] + 90, "Rotate 90° right"),
      },
      flip(0, "Flip horizontal"),
      flip(1, "Flip vertical"),
    ],
  })

  return propRow({ caption: "Rotation", cells: [field, transforms], id: "position.rotation" })
}

/* ---------- arrange ---------- */

/**
 * The four moves as one joined track of pure actions: no `pressed`, because
 * "bring forward" happens once rather than being a state. A move with nowhere
 * to go is disabled rather than absent.
 */
function arrangeRow(context: SectionContext): HTMLElement {
  const { editor, selection, invalidate } = context
  const ref: ArrangeRef | null = arrangeRef(editor.bridge, selection.element)
  // Asking costs a round trip, so only once there is something to move; the
  // answer arrives by re-render.
  const lines = ref ? siblingLines(editor.bridge, ref, invalidate) : null

  const track = actionGroup({
    label: "Arrange",
    buttons: ARRANGE_BUTTONS.map(({ move, label, glyph }) => ({
      label,
      glyph: mark(glyph),
      disabled: !canArrange(lines, ref, move),
      onClick: () => {
        if (ref) arrange(editor.bridge, ref, lines, move)
      },
    })),
  })
  track.setAttribute("role", "toolbar")
  return propRow({ caption: "Arrange", cells: [track], id: "position.arrange" })
}

/**
 * The Alignment row, or null at the top of the tree: a child of `<body>` has
 * no authored parent to lay it out in.
 */
function alignmentRow(context: SectionContext): HTMLElement | null {
  // Asked first; it answers null for everything but a real multi-selection.
  const multi = multiAlignment(context)
  const alignment = parentAlignment(context)
  // A scattered selection gets no distribute: spreading the primary's parent
  // would act on elements that are not selected.
  if (multi) return multiAlignRow(multi, multi.target ? alignment : null, context.invalidate)
  return alignment ? singleAlignRow(alignment, context.invalidate) : null
}

export const positionSection: InspectorSection = (context) => {
  const picked = context.selections?.length ? context.selections : [context.selection]
  const body = el("div", { class: "de-stack" }, [
    alignmentRow(context),
    positionRow(picked),
    rotationRow(context, picked),
    arrangeRow(context),
  ])
  return section("Position", body)
}
