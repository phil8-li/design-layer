/**
 * Position — where the box sits, how it lines up, and its order among siblings.
 *
 * Four groups that answer one question each: align (written on the parent as
 * flex placement — `section-align.ts` holds the reasoning for why not
 * `transform`), distribute (the same write path, spreading the parent's main
 * axis), arrange (the element's order among its JSX siblings, which is what
 * "front" and "back" mean in a document flow — see `core/arrange.ts`), and the
 * measured frame.
 *
 * EVERY ONE OF THEM IS CAPTIONED NOW, and that is the change a reader of this
 * file will notice first. The section used to be four unlabelled rows, which
 * works only for as long as you can identify a group by recognising the marks
 * in it: true of the six align triangles, false of two numbers in a box, where
 * `708` beside `648` says nothing about whether it is a size, a position or a
 * padding. The section header cannot carry that — it names the whole block, and
 * the whole block is the thing with four different answers in it. `group()` is
 * Figma's own small grey label, measured at ~10px in `.harness/figma-spec.md`,
 * which labels every control group in its right panel where ours labelled none.
 *
 * The frame is a READOUT, not a set of fields. X and Y come from the viewport
 * box, which is an outcome of layout rather than an input to it: there is no
 * property to write them back to on a statically-positioned element, and
 * `core/tailwind.ts` cannot express `transform` anyway. Width and height are
 * editable and live in the Layout section, which owns the box's own sizing.
 */

import { el, round } from "../../core/dom"
import { icon, type IconName } from "../../core/icons"
import { tokens } from "../../core/tokens"
import {
  arrange,
  arrangeRef,
  canArrange,
  siblingLines,
  type ArrangeMove,
  type ArrangeRef,
} from "../../core/arrange"
import { actionGroup, group, iconButton, section } from "./field"
import {
  multiAlignment,
  parentAlignment,
  type Axis,
  type MultiAlignment,
  type ParentAlignment,
  type Place,
} from "./section-align"
import type { InspectorSection, SectionContext } from "./index"

/**
 * One size for every mark in the section, so the three strips read as one.
 *
 * `control`, not a smaller step: these sit in 24px tool buttons next to the
 * same marks the toolbar draws. The 14 this used to be was a rung the ramp
 * does not have, one off the 16 beside it — close enough that it read as a
 * softer icon rather than as a smaller one.
 */
const GLYPH = tokens.icon.action

/** Every button here is a drawn mark and nothing else, so it is worth a name. */
const mark = (glyph: IconName) => icon(glyph, GLYPH)

interface AlignButton {
  axis: Axis
  place: Place
  label: string
  glyph: IconName
}

/*
 * Read as a pair of triples, the way every editor draws it: three marks that
 * place the child along the inline axis, three along the block axis. The glyph
 * names run the other way round from the axis they serve — aligning to the LEFT
 * is a rule drawn vertically — which is why the pairing is spelled out here
 * once rather than derived at each call site.
 */
const ALIGN_BUTTONS: AlignButton[] = [
  { axis: "horizontal", place: "flex-start", label: "Align left", glyph: "AlignStartVertical" },
  { axis: "horizontal", place: "center", label: "Align horizontal centers", glyph: "AlignCenterVertical" },
  { axis: "horizontal", place: "flex-end", label: "Align right", glyph: "AlignEndVertical" },
  { axis: "vertical", place: "flex-start", label: "Align top", glyph: "AlignStartHorizontal" },
  { axis: "vertical", place: "center", label: "Align vertical centers", glyph: "AlignCenterHorizontal" },
  { axis: "vertical", place: "flex-end", label: "Align bottom", glyph: "AlignEndHorizontal" },
]

/** One joined track per axis, each named for the axis it places the child on. */
const AXIS_TRACKS: Array<{ axis: Axis; label: string }> = [
  { axis: "horizontal", label: "Align horizontally" },
  { axis: "vertical", label: "Align vertically" },
]

/*
 * Four arrange marks of this family's own, rather than Lucide's arrows.
 *
 * The arrows were shared furniture: `ArrowUp` and `ArrowDown` are also drawn in
 * the layers tree, the app chooser and the layer menu, so redrawing them to
 * match this track would have redrawn three other surfaces to suit one panel.
 * Four names of their own is what lets the track join the native family — same
 * 16-unit lattice, same filled construction, same 1-unit rule — while the
 * general-purpose arrows stay exactly as they were everywhere else.
 *
 * Still two pairs, and the pairing still carries the meaning: a bare arrow
 * steps one place, an arrow against a rule travels until it hits the end.
 */
const ARRANGE_BUTTONS: Array<{ move: ArrangeMove; label: string; glyph: IconName }> = [
  { move: "front", label: "Bring to front", glyph: "ArrangeFront" },
  { move: "forward", label: "Bring forward", glyph: "ArrangeForward" },
  { move: "backward", label: "Send backward", glyph: "ArrangeBackward" },
  { move: "back", label: "Send to back", glyph: "ArrangeBack" },
]

/**
 * The six marks as two joined triples, side by side on the panel's split row.
 *
 * They were six bare tool buttons in one flex line, held apart in the middle by
 * an empty div with `flex: 1` on it — so the only thing saying "these three are
 * about the horizontal axis and those three are not" was a gap whose size
 * depended on how wide the panel had been dragged. `actionGroup` says it in the
 * geometry instead: each triple shares one surface, cut into thirds by a
 * hairline of panel ground, with only the outer corners rounded. `de-row--split`
 * then puts the two of them on the panel's own two-column grid, which is the
 * 88px + 8px + 88px Figma measures its align row at.
 *
 * OURS KEEP A PRESSED STATE AND FIGMA'S HAVE NONE, which is not an oversight in
 * either direction: Figma's buttons are one-shot geometry with nothing to
 * remember, and ours write `justify-content`/`align-items` on the parent, a
 * setting that stays set. A control that silently holds a value it will not
 * show is the worse failure. `css/panels.ts` draws that state as the segmented
 * control's raised chip so it speaks the panel's one chosen-of-several voice.
 *
 * The `role="toolbar"` sits on the ROW, not on either track: `actionGroup`
 * already marks a triple as a `role="group"`, and the toolbar is what says the
 * six of them are one set of controls rather than two unrelated ones.
 */
function alignTracks(alignment: ParentAlignment, invalidate: () => void): HTMLElement {
  const cell = ({ axis, place, label, glyph }: AlignButton) => ({
    label,
    glyph: mark(glyph),
    pressed: alignment.currentFor(axis) === place,
    onClick: () => {
      alignment.write(alignment.propertyFor(axis), place, label)
      invalidate()
    },
  })

  return el(
    "div",
    { class: "de-row de-row--split", role: "toolbar", "aria-label": "Align" },
    AXIS_TRACKS.map(({ axis, label }) =>
      actionGroup({ label, buttons: ALIGN_BUTTONS.filter((entry) => entry.axis === axis).map(cell) })
    )
  )
}

/**
 * The same six marks, aligning the SELECTION to itself rather than the parent's
 * children to the parent.
 *
 * Built from the same `ALIGN_BUTTONS` and the same `actionGroup` as the strip
 * above, and that is a requirement rather than a convenience: the two never
 * appear together, so a user who selects a second element sees this one appear
 * where the other was. Any difference in size, order or spacing between them
 * would read as the panel twitching, and a second hand-built copy of the strip
 * is how that difference gets introduced later by someone touching only one.
 *
 * What differs is underneath, and it differs per axis — `section-align.ts` has
 * the argument. The cross axis writes `align-self` on every selected element
 * through one batched step; the main axis writes `justify-content` once on the
 * parent, exactly as the single-selection strip does, because a run of flex
 * children has no per-child position along the axis it is packed on.
 *
 * `aria-label` is "Align selection", not "Align". Partly because that is what
 * it does and the distinction is the feature; partly because everything that
 * looks for the one-element strip — this panel's own suite included — finds it
 * by that name, and two toolbars answering to "Align" would make the lookup
 * depend on how many elements happened to be selected.
 */
function multiAlignTracks(multi: MultiAlignment, invalidate: () => void): HTMLElement {
  const cell = ({ axis, place, label, glyph }: AlignButton) => ({
    label,
    glyph: mark(glyph),
    pressed: multi.isMain(axis) ? multi.mainIs() === place : multi.crossIsAt(place),
    onClick: () => {
      // The main axis is the parent's to answer, so the summary names what was
      // pressed; the cross axis moved N elements, and the toast and the undo
      // label are the only places that say so.
      if (multi.isMain(axis)) multi.write("justify-content", place, label)
      else multi.alignSelf(place, `${label} (${multi.count} selected)`)
      invalidate()
    },
  })

  return el(
    "div",
    { class: "de-row de-row--split", role: "toolbar", "aria-label": "Align selection" },
    AXIS_TRACKS.map(({ axis, label }) =>
      actionGroup({ label, buttons: ALIGN_BUTTONS.filter((entry) => entry.axis === axis).map(cell) })
    )
  )
}

/**
 * The Alignment group for a multi-selection: the strip, or the reason there
 * isn't one.
 *
 * Both refusals are drawn the way the non-flex branch below already draws
 * its own — a sentence in the group, and a real way out where one exists —
 * rather than as six buttons that would write something other than what their
 * marks promise. The scattered case has no way out to offer: nothing this
 * panel can write puts two elements in different containers into one.
 */
function multiControls(multi: MultiAlignment, invalidate: () => void): HTMLElement {
  if (!multi.target) {
    return group(
      "Alignment",
      el("div", { class: "de-hint" }, [
        `Only elements with the same parent can be aligned together.`,
      ])
    )
  }

  if (!multi.isFlex) {
    return group(
      "Alignment",
      el("div", { class: "de-hint" }, [
        `<${multi.target.tagName}> is not a flex container, so alignment has nothing to act on.`,
      ]),
      el(
        "button",
        {
          class: "de-button",
          type: "button",
          onclick: () => {
            multi.makeFlex()
            invalidate()
          },
        },
        ["Make parent auto layout"]
      )
    )
  }

  // Which three of the six place the elements one by one, said in the terms
  // the user is looking at rather than in CSS: on a row it is the vertical
  // triple, on a column the horizontal one, and getting that backwards is the
  // one thing about this control that cannot be worked out by pressing it.
  const perElement = multi.column ? "Left, center and right" : "Top, middle and bottom"
  const wholeSet = multi.column ? "top, middle and bottom" : "left, center and right"
  return group(
    "Alignment",
    multiAlignTracks(multi, invalidate),
    el("div", { class: "de-hint" }, [
      `${perElement} align each element; ${wholeSet} move the group.`,
    ])
  )
}

/**
 * Distribute is one button, not two: `space-between` only exists on the main
 * axis, so a row parent and a column parent are the same control wearing a
 * different mark. It is also not a toggle — the three align marks on that same
 * axis already write the way back out of it, and a fourth state that only this
 * button can leave would be a trap.
 *
 * It stays a BARE tool rather than joining the arrange track beside it, and the
 * state is why. This button holds one; the four arrange arrows hold none. A
 * joined track is read as one object, so a cell in it that can look chosen
 * makes its neighbours look like they could too. Alone, it takes the tinted
 * plate `css/panels.ts` reserves for a standalone on/off, which is the panel's
 * other pressed voice and the right one for a control with no group to be
 * one-of.
 */
function distributeButton(alignment: ParentAlignment, invalidate: () => void): HTMLElement {
  const label = alignment.column ? "Distribute vertically" : "Distribute horizontally"
  return iconButton({
    label,
    glyph: mark(alignment.column ? "SpaceBetweenVertical" : "SpaceBetweenHorizontal"),
    pressed: alignment.distributed,
    onClick: () => {
      alignment.write("justify-content", "space-between", label)
      invalidate()
    },
  })
}

/**
 * The four moves as one joined track of pure actions.
 *
 * No `pressed` on any cell, unlike the align triples: "bring forward" is a
 * thing that happens once, not a state the element is in afterwards, and the
 * element's actual place in the list is already reported by which of the four
 * cells are live. `disabled` is `actionGroup`'s own option, so a move with
 * nowhere to go is dead rather than absent — the affordance has to be visible
 * before "not right now" means anything.
 *
 * The track takes `role="toolbar"` in place of the `role="group"` the primitive
 * gives it. Align needs both roles because it is two tracks under one toolbar;
 * here the track IS the whole control, and nesting a group of four inside a
 * toolbar of the same four would only make a screen reader say the name twice.
 */
function arrangeTrack(context: SectionContext): HTMLElement {
  const { editor, selection, invalidate } = context
  const ref: ArrangeRef | null = arrangeRef(editor.bridge, selection.element)
  // Asking costs a round trip, so it is only worth asking once we know there is
  // something to move; the answer arrives by re-render, not by mutation.
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
  return track
}

function readout(label: string, value: string): HTMLElement {
  return el("div", { class: "de-field" }, [
    // The one inline style left in the file, and it is not a layout number: the
    // shared `.de-field-label` is a scrub handle and says `cursor: ew-resize`,
    // which would promise a drag these four cannot honour.
    el("span", { class: "de-field-label", style: "cursor:default", title: label }, [label]),
    el("span", { class: "de-field-value" }, [value]),
  ])
}

/**
 * Distribute and arrange under one caption, wherever the section is drawn from.
 *
 * Extracted rather than repeated because a multi-selection needs the same row
 * and would otherwise have quietly lost the distribute button — which is the
 * ONE control here that a user is more likely to want with several elements
 * picked than with one, since spreading a row is a thing you ask for while
 * looking at the whole row. It writes `space-between` on the shared parent,
 * which is what spreading a run of flex children is; the alignment above it
 * splits per axis, this does not, because there is no per-child spelling of
 * "and the gaps between you are equal".
 *
 * `null` means "do not offer it": no parent, a parent that is not a flex
 * container, or a selection scattered across several. The caption and the
 * arrange track stay in all three, because reordering one element among its
 * JSX siblings needs none of that to be true.
 */
function arrangementGroup(context: SectionContext, alignment: ParentAlignment | null): HTMLElement {
  if (!alignment?.isFlex) return group("Arrangement", arrangeTrack(context))
  return group(
    "Arrangement",
    el("div", { class: "de-row de-row--split" }, [
      distributeButton(alignment, context.invalidate),
      arrangeTrack(context),
    ])
  )
}

/**
 * The captioned groups above the frame, in the order the questions get asked.
 * Alignment is skipped entirely at the top of the tree — a child of `<body>`
 * has no authored parent to lay it out in — while arrange and the frame always
 * draw, because neither of them depends on the parent being a flex container.
 *
 * `Arrangement` covers both halves of its row on purpose: distribute spreads
 * the parent's children along its main axis, arrange moves this child among
 * them, and side by side they are the two answers to "where in the parent does
 * this sit". Two captions over two controls that small would out-weigh the
 * controls.
 */
function controls(context: SectionContext): Array<HTMLElement | null> {
  // Asked first, and it answers null for everything except a real
  // multi-selection — so the single-element path below is reached by exactly
  // the renders that reached it before this existed. Arrangement is drawn
  // either way: bringing a layer forward is a thing you do to one element, and
  // it goes on meaning that while four others are also picked.
  const multi = multiAlignment(context)
  const alignment = parentAlignment(context)
  if (multi) {
    // The parent is the same node either way when the selection shares one, so
    // the row below is the row the single-element path draws. A scattered
    // selection passes null instead: spreading the primary's parent while the
    // other picks live somewhere else would act on elements not selected.
    return [multiControls(multi, context.invalidate), arrangementGroup(context, multi.target ? alignment : null)]
  }

  if (!alignment) return [arrangementGroup(context, null)]

  if (!alignment.isFlex) {
    // Captioned even with nothing to draw in it: the caption is what says this
    // is the alignment group in its unavailable state, rather than a stray
    // sentence and a button that happen to be here.
    return [
      group(
        "Alignment",
        el("div", { class: "de-hint" }, [
          `<${alignment.target.tagName}> is not a flex container, so alignment has nothing to act on.`,
        ]),
        el(
          "button",
          {
            class: "de-button",
            type: "button",
            onclick: () => {
              alignment.write("display", "flex", "Auto layout on parent")
              context.invalidate()
            },
          },
          ["Make parent auto layout"]
        )
      ),
      arrangementGroup(context, alignment),
    ]
  }

  return [
    // The hint belongs INSIDE the group rather than between two of them: a
    // caption binds down to what it names, and a sentence floating at an equal
    // gap from the row above and the caption below reads as belonging to
    // whichever one you looked at first.
    group(
      "Alignment",
      alignTracks(alignment, context.invalidate),
      el("div", { class: "de-hint" }, [
        `Aligns all children of <${alignment.target.tagName}>.`,
      ])
    ),
    arrangementGroup(context, alignment),
  ]
}

export const positionSection: InspectorSection = (context) => {
  const box = context.selection.element.getBoundingClientRect()

  const body = el("div", { class: "de-stack" }, [
    ...controls(context),
    // `Position` repeats the section's own name, which happens nowhere else in
    // the panel and is right here: the header names four groups at once, so the
    // pair of numbers still has to say which pair it is. Splitting the frame in
    // two is what earns both captions — X/Y is where the box was put and W/H is
    // how big it came out, and unlabelled they are four numbers in a column.
    group(
      "Position",
      el("div", { class: "de-row de-row--split" }, [
        readout("X", String(round(box.x, 0))),
        readout("Y", String(round(box.y, 0))),
      ])
    ),
    group(
      "Size",
      el("div", { class: "de-row de-row--split" }, [
        readout("W", String(round(box.width, 0))),
        readout("H", String(round(box.height, 0))),
      ])
    ),
  ])

  return section("Position", body)
}
