/**
 * Appearance — Figma's section of the same name: visibility, blend mode,
 * opacity and corner radius.
 *
 * Paint lives in its own Fill / Stroke / Effects sections below, the way Figma
 * splits them.
 *
 * Each radius field carries its own token binding, Figma's "Apply variable":
 * the uniform field binds `corner-radius`, and the four corner fields the
 * toggle opens bind one corner each. There is no separate token row.
 */

import { el, round } from "../../core/dom"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { isExpanded, miniButton, numberField, propRow, setExpanded, trailingToggle } from "./field"
import { styledSection } from "../../options/panel"
import { fieldToken } from "./token-row"
import { mixedNumber, sharedValue } from "./multi"
import type { InspectorSection } from "./index"

/*
 * Grid order: TL TR on the first follow-up row, BL BR on the second, which is
 * how Figma lays them out. `turn` rotates the top-left `CornerRadius` glyph
 * onto each corner, so one drawing serves all four.
 */
const CORNERS = [
  { key: "top-left", label: "Top left radius", turn: 0 },
  { key: "top-right", label: "Top right radius", turn: 90 },
  { key: "bottom-left", label: "Bottom left radius", turn: 270 },
  { key: "bottom-right", label: "Bottom right radius", turn: 180 },
] as const

export const RADIUS_EXPANDER = "appearance.radius"

/*
 * Figma's list without `Pass through`: that one means "let a group's children
 * blend with what is under the group", and CSS has no twin for it — the nearest
 * is `normal`, which is already the first entry.
 */
export const BLEND_MODES = [
  ["normal", "Normal"],
  ["darken", "Darken"],
  ["multiply", "Multiply"],
  ["color-burn", "Color burn"],
  ["lighten", "Lighten"],
  ["screen", "Screen"],
  ["color-dodge", "Color dodge"],
  ["overlay", "Overlay"],
  ["soft-light", "Soft light"],
  ["hard-light", "Hard light"],
  ["difference", "Difference"],
  ["exclusion", "Exclusion"],
  ["hue", "Hue"],
  ["saturation", "Saturation"],
  ["color", "Color"],
  ["luminosity", "Luminosity"],
  ["plus-darker", "Plus darker"],
  ["plus-lighter", "Plus lighter"],
] as const

function cornerGlyph(turn: number): HTMLElement {
  return el("span", { class: "de-app-corner", style: `transform:rotate(${turn}deg)` }, [
    icon("CornerRadius", tokens.icon.action),
  ])
}

export const appearanceSection: InspectorSection = (context) => {
  // The token helpers take the whole context; a partial rebuilt from these
  // four fields would go stale the day one of them reads another.
  const { selection, computed, writer, invalidate } = context

  const apply = (property: string, value: string) => {
    writer.applyStyles(selection, [{ property, value }], `Set ${property}`)
  }
  const preview = (property: string, value: string) => {
    selection.element.style.setProperty(property, value)
  }

  /*
   * `visibility: hidden`, not `display: none`. A hidden element keeps its box,
   * so its siblings do not reflow, the selection outline stays where the
   * element is, and the layers panel can still select it to show it again.
   * `display: none` would take the box away: nothing left to outline, measure
   * or pick on the canvas, and the layout around it jumps.
   */
  const hidden = computed.visibility === "hidden"
  const visibility = miniButton({
    label: hidden ? "Show" : "Hide",
    glyph: icon(hidden ? "EyeOff" : "Eye", tokens.icon.action),
    onClick: () => {
      apply("visibility", hidden ? "visible" : "hidden")
      invalidate()
    },
  })

  // A native select laid over the glyph: the platform draws the menu under its
  // trigger and supplies keyboard and screen-reader behavior.
  const blend = computed.mixBlendMode || "normal"
  const blendName = BLEND_MODES.find(([value]) => value === blend)?.[1] ?? blend
  const blendSelect = el(
    "select",
    { class: "de-app-blend-select", "aria-label": "Blend mode", "data-de-field": "appearance.blend" },
    BLEND_MODES.map(([value, label]) => {
      const option = el("option", { value }, [label]) as HTMLOptionElement
      if (value === blend) option.selected = true
      return option
    })
  ) as HTMLSelectElement
  blendSelect.addEventListener("change", () => {
    apply("mix-blend-mode", blendSelect.value)
    invalidate()
  })
  const blendMenu = el(
    "span",
    {
      class: blend === "normal" ? "de-mini de-app-blend" : "de-mini de-app-blend de-app-blend--set",
      title: `Blend mode: ${blendName}`,
    },
    [icon("BlendMode", tokens.icon.action), blendSelect]
  )

  const radiiOf = (style: CSSStyleDeclaration) =>
    CORNERS.map((corner) => Number.parseFloat(style.getPropertyValue(`border-${corner.key}-radius`)) || 0)
  // A layer's own corners can disagree, and so can the selected layers; either
  // way the uniform field has no one number to show.
  const uniformOf = (values: number[]) => (values.every((value) => value === values[0]) ? round(values[0]) : NaN)
  const shared = sharedValue(context, (style) => uniformOf(radiiOf(style)))
  const uniformRadius = shared === null || Number.isNaN(shared) ? null : shared
  const cornerValues = CORNERS.map((_, index) => sharedValue(context, (style) => round(radiiOf(style)[index])))
  const opacity = sharedValue(context, (style) => round((Number.parseFloat(style.opacity) || 0) * 100))
  const perCorner = isExpanded(RADIUS_EXPANDER)

  const opacityField = numberField({
    id: "appearance.opacity",
    label: icon("Opacity", tokens.icon.action),
    title: "Opacity",
    ...mixedNumber(opacity),
    min: 0,
    max: 100,
    suffix: "%",
    onPreview: (value) => preview("opacity", String(round(value / 100, 3))),
    onCommit: (value) => apply("opacity", String(round(value / 100, 3))),
  })

  const radiusField = numberField({
    id: "appearance.radius",
    label: icon("CornerRadius", tokens.icon.action),
    title: "Corner radius",
    value: uniformRadius,
    placeholder: uniformRadius === null ? "Mixed" : undefined,
    min: 0,
    token: fieldToken(context, ["corner-radius"], "Corner radius"),
    onPreview: (value) => preview("border-radius", `${round(value)}px`),
    onCommit: (value) => apply("border-radius", `${round(value)}px`),
  })

  const cornersToggle = trailingToggle({
    label: "Individual corners",
    glyph: icon("IndividualCorners", tokens.icon.action),
    pressed: perCorner,
    onClick: () => {
      setExpanded(RADIUS_EXPANDER, !perCorner)
      invalidate()
    },
  })

  const cornerField = (index: number) => {
    const corner = CORNERS[index]
    const property = `border-${corner.key}-radius`
    return numberField({
      id: `appearance.radius.${corner.key}`,
      label: cornerGlyph(corner.turn),
      title: corner.label,
      ...mixedNumber(cornerValues[index]),
      min: 0,
      token: fieldToken(context, [`corner-radius-${corner.key}`], corner.label),
      onPreview: (value) => preview(property, `${round(value)}px`),
      onCommit: (value) => apply(property, `${round(value)}px`),
    })
  }

  const body = el("div", { class: "de-stack" }, [
    propRow({
      id: "appearance.main",
      caption: ["Opacity", "Corner radius"],
      cells: [opacityField, radiusField],
      trailing: cornersToggle,
    }),
    perCorner ? propRow({ id: "appearance.corners-top", cells: [cornerField(0), cornerField(1)] }) : null,
    perCorner ? propRow({ id: "appearance.corners-bottom", cells: [cornerField(2), cornerField(3)] }) : null,
  ])

  return styledSection(
    context,
    "appearance",
    "Appearance",
    body,
    el("span", { class: "de-app-actions" }, [visibility, blendMenu])
  )
}
